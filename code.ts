/// <reference types="@figma/plugin-typings" />

// --- Types ------------------------------------------------------------------

type LineStyle = "orthogonal" | "curved" | "straight";
type EndStyle =
  | "none"
  | "arrow"
  | "circle"
  | "square"
  | "circle-hollow"
  | "square-hollow"
  | "semi-circle"
  | "semi-circle-hollow";

const LINE_STYLES: LineStyle[] = ["orthogonal", "curved", "straight"];
const END_STYLES: EndStyle[] = [
  "none", "arrow", "circle", "square", "circle-hollow", "square-hollow",
  "semi-circle", "semi-circle-hollow"
];

function isLineStyle(v: unknown): v is LineStyle {
  return typeof v === "string" && (LINE_STYLES as string[]).includes(v);
}
function isEndStyle(v: unknown): v is EndStyle {
  return typeof v === "string" && (END_STYLES as string[]).includes(v);
}


interface Connection {
  id: string;          // top-level group/frame id (the user-selectable node)
  lineId: string;      // VectorNode child id (the actual line)
  startCapId: string | null; // child node id for start cap, if any
  endCapId: string | null;   // child node id for end cap, if any
  labelId: string | null;    // child TextNode id, if a label has been added
  labelBgId: string | null;  // RectangleNode behind the label (the pill)
  source: string;      // source shape id
  target: string;      // target shape id
  style: LineStyle;
  startEnd: EndStyle;
  endEnd: EndStyle;
  color: RGB;
  width: number;       // stroke weight in px
  endSize: number;     // diameter of cap shapes in px
}

interface Defaults {
  style: LineStyle;
  startEnd: EndStyle;
  endEnd: EndStyle;
  color: RGB;
  width: number;
  endSize: number;
}

const PLUGIN_DATA_KEY = "shape-connector-meta";
const ROOT_CONNECTIONS_KEY = "shape-connector-connections";
const ROOT_DEFAULTS_KEY = "shape-connector-defaults";

const DEFAULT_COLOR: RGB = { r: 0.4, g: 0.4, b: 0.4 };
const DEFAULT_WIDTH = 1.5;
const DEFAULT_END_SIZE = 10;

// --- Storage ----------------------------------------------------------------

const SCHEMA_VERSION = 2;

interface StoredFile {
  version: number;
  connections: Connection[];
}

function loadConnections(): Connection[] {
  const raw = figma.root.getPluginData(ROOT_CONNECTIONS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    // v1 stored a bare array. v2+ stores { version, connections }. We discard
    // v1 records because their on-canvas representation is a bare VectorNode,
    // not the group structure the new renderer expects — the user can delete
    // the orphan vectors and reconnect with the richer styling.
    if (Array.isArray(parsed)) return [];
    const file = parsed as StoredFile;
    if (file.version !== SCHEMA_VERSION) return [];
    // Backfill fields added since v2 was introduced.
    return (file.connections || []).map((c) => ({
      ...c,
      endSize: typeof c.endSize === "number" ? c.endSize : DEFAULT_END_SIZE,
      labelId: typeof c.labelId === "string" ? c.labelId : null,
      labelBgId: typeof c.labelBgId === "string" ? c.labelBgId : null
    }));
  } catch {
    return [];
  }
}

function saveConnections(list: Connection[]): void {
  const file: StoredFile = { version: SCHEMA_VERSION, connections: list };
  figma.root.setPluginData(ROOT_CONNECTIONS_KEY, JSON.stringify(file));
}

function defaultDefaults(): Defaults {
  return {
    style: "orthogonal",
    startEnd: "none",
    endEnd: "arrow",
    color: DEFAULT_COLOR,
    width: DEFAULT_WIDTH,
    endSize: DEFAULT_END_SIZE
  };
}

function loadDefaults(): Defaults {
  const raw = figma.root.getPluginData(ROOT_DEFAULTS_KEY);
  if (!raw) return defaultDefaults();
  try {
    const parsed = JSON.parse(raw);
    // Merge over defaults so old stored versions (missing fields) still work.
    return { ...defaultDefaults(), ...parsed };
  } catch {
    return defaultDefaults();
  }
}

function saveDefaults(d: Defaults): void {
  figma.root.setPluginData(ROOT_DEFAULTS_KEY, JSON.stringify(d));
}

// --- Geometry ---------------------------------------------------------------

interface Point { x: number; y: number; }
interface Box { x: number; y: number; w: number; h: number; cx: number; cy: number; }

function rectFor(node: SceneNode): Box {
  // absoluteBoundingBox includes rotation/strokes; this is what we want for routing.
  const b = node.absoluteBoundingBox;
  if (!b) {
    return { x: node.x, y: node.y, w: node.width, h: node.height, cx: node.x + node.width / 2, cy: node.y + node.height / 2 };
  }
  return { x: b.x, y: b.y, w: b.width, h: b.height, cx: b.x + b.width / 2, cy: b.y + b.height / 2 };
}

type Side = "left" | "right" | "top" | "bottom";

function chooseSides(a: Box, b: Box): { aSide: Side; bSide: Side } {
  const dx = b.cx - a.cx;
  const dy = b.cy - a.cy;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { aSide: "right", bSide: "left" } : { aSide: "left", bSide: "right" };
  }
  return dy >= 0 ? { aSide: "bottom", bSide: "top" } : { aSide: "top", bSide: "bottom" };
}

function anchorOn(r: Box, side: Side): Point {
  switch (side) {
    case "left":   return { x: r.x,         y: r.cy };
    case "right":  return { x: r.x + r.w,   y: r.cy };
    case "top":    return { x: r.cx,        y: r.y };
    case "bottom": return { x: r.cx,        y: r.y + r.h };
  }
}

// --- Outline geometry -------------------------------------------------------
//
// For non-rectangular shapes (stars, polygons, custom vectors), we want the
// connector to attach at the actual outline rather than the axis-aligned
// bounding box. We read `node.fillGeometry` (Figma's resolved vector path
// in node-local coords), transform to absolute coords, then find the closest
// point on the resulting line+bezier segments to a reference point (the
// other shape's center).

type Segment =
  | { kind: "line"; a: Point; b: Point }
  | { kind: "cubic"; a: Point; c1: Point; c2: Point; b: Point };

function applyTransform(p: Point, m: Transform): Point {
  // Transform is [[a, b, tx], [c, d, ty]]; result = [a*x + b*y + tx, c*x + d*y + ty].
  return {
    x: m[0][0] * p.x + m[0][1] * p.y + m[0][2],
    y: m[1][0] * p.x + m[1][1] * p.y + m[1][2]
  };
}

/** Parse an SVG path string into a flat list of line/cubic segments in the
 *  same coord space as the path string. Handles M, L, H, V, C, Z. */
function parsePathSegments(data: string): Segment[] {
  const tokens = data.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
  const segments: Segment[] = [];
  let i = 0;
  const num = () => parseFloat(tokens[i++]);
  let cur: Point = { x: 0, y: 0 };
  let start: Point = { x: 0, y: 0 };
  while (i < tokens.length) {
    const tok = tokens[i++];
    switch (tok) {
      case "M": {
        cur = { x: num(), y: num() };
        start = cur;
        // Subsequent pairs after M are implicit L.
        while (i < tokens.length && /^-?\d/.test(tokens[i])) {
          const next: Point = { x: num(), y: num() };
          segments.push({ kind: "line", a: cur, b: next });
          cur = next;
        }
        break;
      }
      case "L": {
        while (i < tokens.length && /^-?\d/.test(tokens[i])) {
          const next: Point = { x: num(), y: num() };
          segments.push({ kind: "line", a: cur, b: next });
          cur = next;
        }
        break;
      }
      case "H": {
        while (i < tokens.length && /^-?\d/.test(tokens[i])) {
          const next: Point = { x: num(), y: cur.y };
          segments.push({ kind: "line", a: cur, b: next });
          cur = next;
        }
        break;
      }
      case "V": {
        while (i < tokens.length && /^-?\d/.test(tokens[i])) {
          const next: Point = { x: cur.x, y: num() };
          segments.push({ kind: "line", a: cur, b: next });
          cur = next;
        }
        break;
      }
      case "C": {
        while (i < tokens.length && /^-?\d/.test(tokens[i])) {
          const c1: Point = { x: num(), y: num() };
          const c2: Point = { x: num(), y: num() };
          const b: Point = { x: num(), y: num() };
          segments.push({ kind: "cubic", a: cur, c1, c2, b });
          cur = b;
        }
        break;
      }
      case "Z":
      case "z": {
        if (cur.x !== start.x || cur.y !== start.y) {
          segments.push({ kind: "line", a: cur, b: start });
        }
        cur = start;
        break;
      }
      // Q (quadratic), A (arc), S/T (smooth) are not emitted by Figma's
      // fillGeometry for the built-in primitives we care about. If they
      // appear, we skip safely.
      default:
        break;
    }
  }
  return segments;
}

function nodeOutlineSegments(node: SceneNode): Segment[] {
  // fillGeometry exists on most shape nodes (RECTANGLE, ELLIPSE, POLYGON,
  // STAR, VECTOR, TEXT, BOOLEAN_OPERATION). For others (group, frame), we
  // return no segments so the caller falls back to bbox.
  if (!("fillGeometry" in node)) return [];
  const paths = (node as GeometryMixin).fillGeometry;
  if (!paths || paths.length === 0) return [];
  const transform = (node as LayoutMixin).absoluteTransform;
  const all: Segment[] = [];
  for (const p of paths) {
    const local = parsePathSegments(p.data);
    for (const seg of local) {
      if (seg.kind === "line") {
        all.push({ kind: "line", a: applyTransform(seg.a, transform), b: applyTransform(seg.b, transform) });
      } else {
        all.push({
          kind: "cubic",
          a: applyTransform(seg.a, transform),
          c1: applyTransform(seg.c1, transform),
          c2: applyTransform(seg.c2, transform),
          b: applyTransform(seg.b, transform)
        });
      }
    }
  }
  return all;
}

/** Closest point on a line segment to reference p, returned as the point and
 *  the unit tangent at that point (along the segment direction). */
function closestOnLine(a: Point, b: Point, p: Point): { point: Point; tangent: Point; dist2: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = 0.5;
  if (len2 > 1e-9) {
    t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    if (t < 0) t = 0;
    if (t > 1) t = 1;
  }
  const point = { x: a.x + t * dx, y: a.y + t * dy };
  const dxp = p.x - point.x, dyp = p.y - point.y;
  return { point, tangent: normalize({ x: dx, y: dy }), dist2: dxp * dxp + dyp * dyp };
}

function cubicAt(a: Point, c1: Point, c2: Point, b: Point, t: number): Point {
  const u = 1 - t;
  const k0 = u * u * u;
  const k1 = 3 * u * u * t;
  const k2 = 3 * u * t * t;
  const k3 = t * t * t;
  return {
    x: k0 * a.x + k1 * c1.x + k2 * c2.x + k3 * b.x,
    y: k0 * a.y + k1 * c1.y + k2 * c2.y + k3 * b.y
  };
}

function cubicDerivAt(a: Point, c1: Point, c2: Point, b: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: 3 * u * u * (c1.x - a.x) + 6 * u * t * (c2.x - c1.x) + 3 * t * t * (b.x - c2.x),
    y: 3 * u * u * (c1.y - a.y) + 6 * u * t * (c2.y - c1.y) + 3 * t * t * (b.y - c2.y)
  };
}

/** Closest point on a cubic bezier to reference p, via sampling. ~32 samples
 *  is more than enough for the resolution of a connector attachment. */
function closestOnCubic(a: Point, c1: Point, c2: Point, b: Point, p: Point): { point: Point; tangent: Point; dist2: number } {
  const SAMPLES = 32;
  let best = { point: a, tangent: { x: 1, y: 0 }, dist2: Infinity };
  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    const pt = cubicAt(a, c1, c2, b, t);
    const dx = p.x - pt.x, dy = p.y - pt.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < best.dist2) {
      best = { point: pt, tangent: normalize(cubicDerivAt(a, c1, c2, b, t)), dist2: d2 };
    }
  }
  return best;
}

/** Find the closest connection point on a shape's outline to a reference
 *  point. Returns null if the shape has no extractable geometry.
 *
 *  Candidate points considered:
 *   - For each LINE segment in the outline: both endpoints (corners) and the
 *     segment midpoint.
 *   - For each CUBIC segment: the closest point along the curve (sampled).
 *  The closest candidate to `ref` wins.
 *
 *  This gives snappy, predictable behavior on polygonal shapes (square →
 *  4 corners + 4 side midpoints = 8 attach points; star → 10 corners + 10
 *  edge midpoints = 20), while keeping smooth attachment on rounded shapes.
 *
 *  Outward direction is computed from the shape's centroid (bbox center)
 *  to the attach point — robust at vertices where a tangent-based normal
 *  would flip 180° between adjacent segments. */
function closestOutlinePoint(node: SceneNode, ref: Point): { point: Point; outwardTangent: Point } | null {
  const segments = nodeOutlineSegments(node);
  if (segments.length === 0) return null;

  // Rectangles snap to edge midpoints only — connecting to a corner of a
  // box has no clear use case in flowchart-style diagrams. Other polygons
  // (triangle, star, etc.) keep both corners and midpoints as candidates
  // because their vertices are often meaningful attach points.
  const skipCorners = node.type === "RECTANGLE";

  function dist2(p: Point): number {
    const dx = p.x - ref.x;
    const dy = p.y - ref.y;
    return dx * dx + dy * dy;
  }

  let bestPoint: Point | null = null;
  let bestD2 = Infinity;
  function consider(p: Point): void {
    const d = dist2(p);
    if (d < bestD2) { bestD2 = d; bestPoint = p; }
  }

  for (const seg of segments) {
    if (seg.kind === "line") {
      if (!skipCorners) {
        consider(seg.a);
        consider(seg.b);
      }
      consider({ x: (seg.a.x + seg.b.x) / 2, y: (seg.a.y + seg.b.y) / 2 });
    } else {
      // Cubics aren't polygonal — keep continuous attachment.
      const r = closestOnCubic(seg.a, seg.c1, seg.c2, seg.b, ref);
      consider(r.point);
    }
  }

  if (!bestPoint) return null;

  const box = rectFor(node);
  const attachPt: Point = bestPoint;
  const dx = attachPt.x - box.cx;
  const dy = attachPt.y - box.cy;
  if (dx * dx + dy * dy < 1e-6) {
    const toRef = normalize({ x: ref.x - attachPt.x, y: ref.y - attachPt.y });
    return { point: attachPt, outwardTangent: toRef };
  }
  return { point: attachPt, outwardTangent: normalize({ x: dx, y: dy }) };
}

function edgePointTowards(r: Box, target: Point): Point {
  // Intersect the line from rect center to target with the rect boundary.
  const dx = target.x - r.cx;
  const dy = target.y - r.cy;
  if (dx === 0 && dy === 0) return { x: r.cx, y: r.cy };
  const halfW = r.w / 2;
  const halfH = r.h / 2;
  const scale = Math.min(
    halfW / Math.max(Math.abs(dx), 0.0001),
    halfH / Math.max(Math.abs(dy), 0.0001)
  );
  return { x: r.cx + dx * scale, y: r.cy + dy * scale };
}

// --- Path building ----------------------------------------------------------
//
// VectorNode.vectorPaths uses NODE-LOCAL coordinates and Figma auto-positions
// the node so that the path's bounding-box minimum lands at node.x/y. To stay
// in sync with that, we:
//   1. Compute all key points in page-absolute coords.
//   2. Find the bbox-min across those points — this is the path's "origin".
//   3. Emit path data with everything translated by -origin (so all local
//      coords are >= 0, matching Figma's auto-shift behavior).
//   4. The caller sets node.x = origin.x, node.y = origin.y so the rendered
//      result lands at the original absolute coordinates.
//
// Note: for curved paths, bezier control points can extend beyond the
// endpoints. We include them in the bbox so the origin lines up correctly.

interface PathSpec {
  /** All anchor + control points contributing to the bbox, in absolute coords. */
  bboxPoints: Point[];
  /** Function that emits path data given a translation origin. */
  emit: (origin: Point) => string;
  /** Start endpoint in absolute coords. */
  startPoint: Point;
  /** End endpoint in absolute coords. */
  endPoint: Point;
  /** Unit vector pointing OUTWARD from the start endpoint (away from line). */
  startTangent: Point;
  /** Unit vector pointing OUTWARD from the end endpoint (away from line). */
  endTangent: Point;
  /** Visual midpoint of the rendered line — where a label is centered. */
  midPoint: Point;
}

interface BuiltPath {
  origin: Point;
  data: string;
  startPoint: Point;
  endPoint: Point;
  startTangent: Point;
  endTangent: Point;
  midPoint: Point;
}

function normalize(v: Point): Point {
  const len = Math.hypot(v.x, v.y);
  if (len < 1e-9) return { x: 1, y: 0 };
  return { x: v.x / len, y: v.y / len };
}

function finalize(spec: PathSpec): BuiltPath {
  let minX = Infinity, minY = Infinity;
  for (const p of spec.bboxPoints) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
  }
  const origin = { x: minX, y: minY };
  return {
    origin,
    data: spec.emit(origin),
    startPoint: spec.startPoint,
    endPoint: spec.endPoint,
    startTangent: spec.startTangent,
    endTangent: spec.endTangent,
    midPoint: spec.midPoint
  };
}

function fmt(p: Point, o: Point): string {
  return `${p.x - o.x} ${p.y - o.y}`;
}

function shiftAlong(p: Point, t: Point, dist: number): Point {
  // Move point p by `dist` along unit tangent t. Used to inset endpoints so
  // the line stops at an arrow's base instead of overlapping the triangle.
  return { x: p.x + t.x * dist, y: p.y + t.y * dist };
}

/** Attach point + INWARD tangent (pointing into the shape — direction an
 *  arrow at this attach point would point). Uses the outline if available,
 *  otherwise falls back to the bbox edge intersection. */
function attachPoint(node: SceneNode, towards: Point): { point: Point; inward: Point } {
  const outline = closestOutlinePoint(node, towards);
  if (outline) {
    return { point: outline.point, inward: { x: -outline.outwardTangent.x, y: -outline.outwardTangent.y } };
  }
  // Fallback for shapes without extractable geometry (groups, frames without
  // a fill, etc.). Pick the bbox side facing the target — by whichever axis
  // dominates the centroid-to-target vector — and use that side's midpoint
  // with an axis-aligned inward tangent. This matches how rectangles attach,
  // so the curved path doesn't degenerate to a straight line for groups
  // (which would happen if inward followed the center-to-center diagonal).
  const box = rectFor(node);
  const dx = towards.x - box.cx;
  const dy = towards.y - box.cy;
  const side: Side =
    Math.abs(dx) >= Math.abs(dy)
      ? (dx >= 0 ? "right" : "left")
      : (dy >= 0 ? "bottom" : "top");
  return { point: anchorOn(box, side), inward: sideInwardTangent(side) };
}

function buildStraightPath(srcNode: SceneNode, tgtNode: SceneNode, startInset: number, endInset: number): BuiltPath {
  const aBox = rectFor(srcNode);
  const bBox = rectFor(tgtNode);
  const aAttach = attachPoint(srcNode, { x: bBox.cx, y: bBox.cy });
  const bAttach = attachPoint(tgtNode, { x: aBox.cx, y: aBox.cy });
  const paFull = aAttach.point;
  const pbFull = bAttach.point;
  const startTangent = aAttach.inward;
  const endTangent = bAttach.inward;
  // Inset line endpoints away from each shape's edge by the requested amount.
  // To pull the line back from the shape, we move AGAINST the inward tangent.
  const paLine = shiftAlong(paFull, startTangent, -startInset);
  const pbLine = shiftAlong(pbFull, endTangent, -endInset);
  // bboxPoints should only include points that are actually in the path
  // data — otherwise Figma's auto-bbox-shift on vectorPaths assignment
  // disagrees with our computed origin and the line renders offset by the
  // gap between the path bbox and the bbox including paFull/pbFull.
  return finalize({
    bboxPoints: [paLine, pbLine],
    emit: (o) => `M ${fmt(paLine, o)} L ${fmt(pbLine, o)}`,
    startPoint: paFull,
    endPoint: pbFull,
    startTangent,
    endTangent,
    midPoint: { x: (paLine.x + pbLine.x) / 2, y: (paLine.y + pbLine.y) / 2 }
  });
}

function sideInwardTangent(side: Side): Point {
  // Unit vector pointing INTO the shape from its edge. For a connector
  // attaching at side "left", the line is arriving from the left side moving
  // rightward into the shape — so the inward tangent is (+1, 0).
  // This is the direction an arrow at that endpoint should point.
  switch (side) {
    case "left":   return { x: 1, y: 0 };
    case "right":  return { x: -1, y: 0 };
    case "top":    return { x: 0, y: 1 };
    case "bottom": return { x: 0, y: -1 };
  }
}

/** Coordinates where the outline crosses an axis-aligned center line.
 *  For horizontal=true we scan the line y=axisValue and return the x of every
 *  crossing; for horizontal=false we scan x=axisValue and return crossing y's.
 *  Cubic segments are flattened into short line chords before testing. */
function axisCrossings(segments: Segment[], horizontal: boolean, axisValue: number): number[] {
  const out: number[] = [];
  function lineCross(a: Point, b: Point): void {
    const av = horizontal ? a.y : a.x;
    const bv = horizontal ? b.y : b.x;
    const denom = bv - av;
    if (Math.abs(denom) < 1e-9) return; // parallel to the scan line; skip
    const t = (axisValue - av) / denom;
    if (t < 0 || t > 1) return;
    out.push(horizontal ? a.x + t * (b.x - a.x) : a.y + t * (b.y - a.y));
  }
  for (const seg of segments) {
    if (seg.kind === "line") {
      lineCross(seg.a, seg.b);
    } else {
      let prev = seg.a;
      const N = 24;
      for (let i = 1; i <= N; i++) {
        const pt = cubicAt(seg.a, seg.c1, seg.c2, seg.b, i / N);
        lineCross(prev, pt);
        prev = pt;
      }
    }
  }
  return out;
}

/** Orthogonal attach point on a shape's real outline for the given side.
 *  Casts a ray from the bbox center along the side's outward normal and
 *  returns the farthest outline crossing — the outer boundary on that side —
 *  keeping the same x (top/bottom) or y (left/right) as the bbox center so the
 *  connector still exits orthogonally. Returns null when the shape exposes no
 *  geometry (groups, frames) so the caller falls back to the bbox anchor. */
function orthogonalSidePoint(node: SceneNode, box: Box, side: Side): Point | null {
  const segments = nodeOutlineSegments(node);
  if (segments.length === 0) return null;
  const horizontal = side === "left" || side === "right";
  const axisValue = horizontal ? box.cy : box.cx; // scan line through the center
  const base = horizontal ? box.cx : box.cy;       // center coord along the ray
  const dir = side === "left" || side === "top" ? -1 : 1;
  let best: number | null = null;
  for (const c of axisCrossings(segments, horizontal, axisValue)) {
    const signed = (c - base) * dir; // distance from center toward the side
    if (signed <= 0.01) continue;    // crossing is on the wrong side
    if (best === null || signed > best) best = signed;
  }
  if (best === null) return null;
  const coord = base + dir * best;
  return horizontal ? { x: coord, y: box.cy } : { x: box.cx, y: coord };
}

function buildOrthogonalPath(srcNode: SceneNode, tgtNode: SceneNode, startInset: number, endInset: number): BuiltPath {
  // Orthogonal routing enters the shape's side (left/right/top/bottom) along a
  // horizontal or vertical ray through the bbox center. For non-rectangular
  // shapes (stars, polygons), snap that ray to the real outline so the line
  // lands on the shape surface instead of floating at the bounding-box edge;
  // fall back to the bbox anchor when geometry isn't available.
  const a = rectFor(srcNode);
  const b = rectFor(tgtNode);
  const { aSide, bSide } = chooseSides(a, b);
  const aOutline = orthogonalSidePoint(srcNode, a, aSide);
  const bOutline = orthogonalSidePoint(tgtNode, b, bSide);
  const paFull = aOutline ? aOutline : anchorOn(a, aSide);
  const pbFull = bOutline ? bOutline : anchorOn(b, bSide);
  const startTangent = sideInwardTangent(aSide);
  const endTangent = sideInwardTangent(bSide);
  // Inset line endpoints away from each shape's edge by the requested amount.
  const paLine = shiftAlong(paFull, startTangent, -startInset);
  const pbLine = shiftAlong(pbFull, endTangent, -endInset);

  const horizontal = aSide === "left" || aSide === "right";
  let v2: Point, v3: Point;
  if (horizontal) {
    const midX = (paLine.x + pbLine.x) / 2;
    v2 = { x: midX, y: paLine.y };
    v3 = { x: midX, y: pbLine.y };
  } else {
    const midY = (paLine.y + pbLine.y) / 2;
    v2 = { x: paLine.x, y: midY };
    v3 = { x: pbLine.x, y: midY };
  }
  return finalize({
    bboxPoints: [paLine, v2, v3, pbLine],
    emit: (o) => `M ${fmt(paLine, o)} L ${fmt(v2, o)} L ${fmt(v3, o)} L ${fmt(pbLine, o)}`,
    startPoint: paFull,
    endPoint: pbFull,
    startTangent,
    endTangent,
    // The orthogonal route has a horizontal-vertical-horizontal (or v-h-v)
    // shape; its visual midpoint is the middle of the elbow segment v2→v3.
    midPoint: { x: (v2.x + v3.x) / 2, y: (v2.y + v3.y) / 2 }
  });
}

/** Sample the t-values where a cubic bezier reaches an extremum in either x
 *  or y. Returns t ∈ (0, 1) for each axis; endpoints (t=0, t=1) are already
 *  in bboxPoints as paLine/pbLine. */
function cubicExtremaT(p0: Point, p1: Point, p2: Point, p3: Point): number[] {
  // For each axis, derivative = 3(1-t)²(p1-p0) + 6(1-t)t(p2-p1) + 3t²(p3-p2).
  // Solving = 0 gives a quadratic in t: at² + bt + c = 0 where
  //   a = -p0 + 3p1 - 3p2 + p3
  //   b = 2(p0 - 2p1 + p2)
  //   c = p1 - p0
  // (per-axis).
  const ts: number[] = [];
  for (const ax of [0, 1]) {
    const v0 = ax === 0 ? p0.x : p0.y;
    const v1 = ax === 0 ? p1.x : p1.y;
    const v2 = ax === 0 ? p2.x : p2.y;
    const v3 = ax === 0 ? p3.x : p3.y;
    const a = -v0 + 3 * v1 - 3 * v2 + v3;
    const b = 2 * (v0 - 2 * v1 + v2);
    const c = v1 - v0;
    if (Math.abs(a) < 1e-9) {
      if (Math.abs(b) > 1e-9) {
        const t = -c / b;
        if (t > 0 && t < 1) ts.push(t);
      }
    } else {
      const disc = b * b - 4 * a * c;
      if (disc >= 0) {
        const s = Math.sqrt(disc);
        for (const t of [(-b + s) / (2 * a), (-b - s) / (2 * a)]) {
          if (t > 0 && t < 1) ts.push(t);
        }
      }
    }
  }
  return ts;
}

function buildCurvedPath(srcNode: SceneNode, tgtNode: SceneNode, startInset: number, endInset: number): BuiltPath {
  const aBox = rectFor(srcNode);
  const bBox = rectFor(tgtNode);
  const aAttach = attachPoint(srcNode, { x: bBox.cx, y: bBox.cy });
  const bAttach = attachPoint(tgtNode, { x: aBox.cx, y: aBox.cy });
  const paFull = aAttach.point;
  const pbFull = bAttach.point;
  const startTangent = aAttach.inward;
  const endTangent = bAttach.inward;
  const paLine = shiftAlong(paFull, startTangent, -startInset);
  const pbLine = shiftAlong(pbFull, endTangent, -endInset);

  // Control points lie OUTSIDE each line endpoint along the outward tangent
  // (-inward). The offset scales with the gap between shapes so the curve
  // stays smooth at any distance.
  const dx = pbLine.x - paLine.x;
  const dy = pbLine.y - paLine.y;
  const gap = Math.hypot(dx, dy);
  const off = Math.max(40, gap / 2);
  const c1 = { x: paLine.x - startTangent.x * off, y: paLine.y - startTangent.y * off };
  const c2 = { x: pbLine.x - endTangent.x * off, y: pbLine.y - endTangent.y * off };

  // bboxPoints must equal the curve's actual tight bbox. Control points lie
  // OUTSIDE the curve and would inflate the bbox — that mismatches Figma's
  // auto-computed value when vectorPaths is assigned, and the node.x/y
  // override puts the line at the wrong absolute position. So we include only
  // points actually on the curve: the two endpoints + any extrema in (0, 1).
  const extremaTs = cubicExtremaT(paLine, c1, c2, pbLine);
  const extremaPts = extremaTs.map((t) => cubicAt(paLine, c1, c2, pbLine, t));

  return finalize({
    bboxPoints: [paLine, pbLine, ...extremaPts],
    emit: (o) => `M ${fmt(paLine, o)} C ${fmt(c1, o)} ${fmt(c2, o)} ${fmt(pbLine, o)}`,
    startPoint: paFull,
    endPoint: pbFull,
    startTangent,
    endTangent,
    midPoint: cubicAt(paLine, c1, c2, pbLine, 0.5)
  });
}

function insetFor(style: EndStyle, endSize: number): number {
  // Arrows occupy endSize along their axis (tip at the shape edge, base
  // endSize back along the line). Semi-circles sit flush at the shape edge
  // and bulge outward by endSize/2 (the radius), so the line should stop at
  // the dome's apex. Circles and squares are centered on the endpoint and
  // visually cover the meeting point, so no inset is needed.
  if (style === "arrow") return endSize;
  if (style === "semi-circle" || style === "semi-circle-hollow") return endSize / 2;
  return 0;
}

function buildPath(
  style: LineStyle,
  srcNode: SceneNode,
  tgtNode: SceneNode,
  startInset: number,
  endInset: number
): BuiltPath {
  switch (style) {
    case "straight":   return buildStraightPath(srcNode, tgtNode, startInset, endInset);
    case "curved":     return buildCurvedPath(srcNode, tgtNode, startInset, endInset);
    case "orthogonal":
    default:           return buildOrthogonalPath(srcNode, tgtNode, startInset, endInset);
  }
}

// --- Connector rendering ----------------------------------------------------
//
// Each connection is a GroupNode parented to the current page, containing:
//   - 1 VectorNode (the line)
//   - 0 or 1 cap node at the start endpoint
//   - 0 or 1 cap node at the end endpoint
//
// All caps (circle, square, arrow) are rendered as separate sibling nodes
// inside the connection's group, sized explicitly by endSize. We no longer
// use Figma's native strokeCap = ARROW_EQUILATERAL because its size is tied
// to the line's stroke weight and can't be controlled independently.

function isArrowStyle(s: EndStyle): boolean {
  return s === "arrow";
}

function makeCapNode(style: EndStyle, color: RGB, width: number, size: number): SceneNode | null {
  if (style === "none") return null;
  if (style === "arrow") {
    // Triangle: tip at local (0, 0), base behind tip pointing in +x. Caller
    // rotates and positions it. Height = size, base width = size.
    const tri = figma.createVector();
    tri.vectorPaths = [{
      windingRule: "NONZERO",
      // Tip at right (positive x), base on the left.
      data: `M ${size} ${size / 2} L 0 0 L 0 ${size} Z`
    }];
    tri.fills = [{ type: "SOLID", color }];
    tri.strokes = [];
    return tri;
  }
  if (style === "semi-circle" || style === "semi-circle-hollow") {
    // Half-disk geometry. Flat (diameter) edge runs along LOCAL x=0 from
    // (0, 0) to (0, size); apex sits at (size/2, size/2); two cubic quarters
    // approximate the arc. The bbox is (0, 0) to (size/2, size) so Figma's
    // vectorPaths normalization (which snaps bbox-min to local origin)
    // doesn't shift anything — positionSemicircleCap can rely on the listed
    // coordinates directly.
    const r = size / 2;
    const k = 0.5522847498 * r;
    const semi = figma.createVector();
    semi.vectorPaths = [{
      windingRule: "NONZERO",
      data:
        `M 0 0 ` +
        `C ${k} 0 ${size / 2} ${size / 2 - k} ${size / 2} ${size / 2} ` +
        `C ${size / 2} ${size / 2 + k} ${k} ${size} 0 ${size} Z`
    }];
    if (style === "semi-circle-hollow") {
      semi.fills = [];
      semi.strokes = [{ type: "SOLID", color }];
      semi.strokeWeight = Math.max(1, width);
    } else {
      semi.fills = [{ type: "SOLID", color }];
      semi.strokes = [];
    }
    return semi;
  }
  const isCircle = style === "circle" || style === "circle-hollow";
  const hollow = style === "circle-hollow" || style === "square-hollow";
  const node: EllipseNode | RectangleNode = isCircle
    ? figma.createEllipse()
    : figma.createRectangle();
  node.resize(size, size);
  if (hollow) {
    node.fills = [];
    node.strokes = [{ type: "SOLID", color }];
    node.strokeWeight = Math.max(1, width);
  } else {
    node.fills = [{ type: "SOLID", color }];
    node.strokes = [];
  }
  return node;
}

function positionCap(cap: SceneNode, center: Point): void {
  // Centered placement for symmetric shapes (circle, square).
  cap.x = center.x - cap.width / 2;
  cap.y = center.y - cap.height / 2;
}

function positionArrowCap(cap: SceneNode, tip: Point, tangent: Point, size: number): void {
  // The arrow vector was built with its tip at local (size, size/2) pointing
  // in the +x direction. To orient it along `tangent` (a unit vector that
  // points outward from the line into the connected shape), we use a 2D
  // rotation matrix as the node's relativeTransform.
  //
  // relativeTransform is [[a, b, tx], [c, d, ty]] applied to local coords.
  // For rotation by angle θ:  a = cosθ, b = -sinθ, c = sinθ, d = cosθ.
  // Then we translate so the tip lands at `tip`.
  const cos = tangent.x;
  const sin = tangent.y;
  // Local tip in unrotated coordinates: (size, size/2).
  // After rotation: rotatedTip = (cos*size - sin*(size/2), sin*size + cos*(size/2)).
  // We want rotatedTip + translation = tip ⇒ translation = tip - rotatedTip.
  const rtx = cos * size - sin * (size / 2);
  const rty = sin * size + cos * (size / 2);
  cap.relativeTransform = [
    [cos, -sin, tip.x - rtx],
    [sin,  cos, tip.y - rty]
  ];
}

function positionSemicircleCap(cap: SceneNode, anchor: Point, inward: Point, size: number): void {
  // Semi-circle local geometry: flat-edge center at (0, size/2), apex at
  // (size/2, size/2), so local +x is the direction from flat edge to apex.
  // We want the flat edge flush against the shape (anchor = paFull/pbFull)
  // and the dome bulging OUTWARD over the line — opposite of inward.
  //
  // Rotation R sends local +x → outward = -inward, so cos = -inward.x,
  // sin = -inward.y. Translate so the flat-edge center (local (0, size/2))
  // lands at `anchor`:
  //   R · (0, size/2) = (-sin · size/2, cos · size/2)
  //   T = anchor − R · (0, size/2)
  const cos = -inward.x;
  const sin = -inward.y;
  cap.relativeTransform = [
    [cos, -sin, anchor.x + sin * size / 2],
    [sin,  cos, anchor.y - cos * size / 2]
  ];
}

function isVectorCap(style: EndStyle): boolean {
  return style === "arrow" || style === "semi-circle" || style === "semi-circle-hollow";
}

function positionVectorCap(cap: SceneNode, style: EndStyle, anchor: Point, inward: Point, size: number): void {
  if (style === "semi-circle" || style === "semi-circle-hollow") {
    positionSemicircleCap(cap, anchor, inward, size);
  } else {
    positionArrowCap(cap, anchor, inward, size);
  }
}

// --- Labels -----------------------------------------------------------------

const LABEL_FONT: FontName = { family: "Inter", style: "Regular" };
const LABEL_INITIAL = "Label";
const LABEL_DEFAULT_SIZE = 12;
// Pill padding around the text bbox + corner radius.
const LABEL_PILL_PAD_X = 6;
const LABEL_PILL_PAD_Y = 3;
const LABEL_PILL_RADIUS = 4;

let labelFontPromise: Promise<void> | null = null;
function ensureLabelFont(): Promise<void> {
  if (!labelFontPromise) labelFontPromise = figma.loadFontAsync(LABEL_FONT);
  return labelFontPromise;
}

/** Place the text so its bbox center sits at `mid`. */
function positionLabel(label: TextNode, mid: Point): void {
  label.x = mid.x - label.width / 2;
  label.y = mid.y - label.height / 2;
}

/** Resize the pill rect to wrap the current text bbox + padding, centered on
 *  the same midpoint as the text. */
function positionLabelPill(pill: RectangleNode, label: TextNode, mid: Point): void {
  const w = label.width + LABEL_PILL_PAD_X * 2;
  const h = label.height + LABEL_PILL_PAD_Y * 2;
  pill.resize(Math.max(w, 1), Math.max(h, 1));
  pill.x = mid.x - w / 2;
  pill.y = mid.y - h / 2;
}

async function createLabelForConnection(conn: Connection): Promise<{ labelId: string; bgId: string } | null> {
  const group = await figma.getNodeByIdAsync(conn.id);
  if (!group || group.type !== "GROUP") return null;
  await ensureLabelFont();

  // Pill (background) is a sibling of the text inside the group. We add the
  // pill FIRST so it sits below the text in z-order — clicking the label on
  // canvas selects the text, and the line behind the pill is hidden by the
  // white fill.
  const pill = figma.createRectangle();
  pill.name = "label-bg";
  pill.cornerRadius = LABEL_PILL_RADIUS;
  pill.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
  pill.strokes = [];
  pill.setPluginData(PLUGIN_DATA_KEY, "child");
  (group as GroupNode).appendChild(pill);

  const label = figma.createText();
  label.name = "label";
  label.fontName = LABEL_FONT;
  label.fontSize = LABEL_DEFAULT_SIZE;
  label.characters = LABEL_INITIAL;
  // Black on canvas — readable on most backgrounds; user can recolor via
  // Figma's native text panel after selecting.
  label.fills = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }];
  label.setPluginData(PLUGIN_DATA_KEY, "child");
  (group as GroupNode).appendChild(label);

  return { labelId: label.id, bgId: pill.id };
}

async function paintLine(
  line: VectorNode,
  built: BuiltPath,
  color: RGB,
  width: number
): Promise<void> {
  line.vectorPaths = [{ windingRule: "NONE", data: built.data }];
  line.x = built.origin.x;
  line.y = built.origin.y;
  line.strokes = [{ type: "SOLID", color }];
  line.strokeWeight = width;
  line.fills = [];
  // ROUND cap so the line's end visually meets the arrow base from any
  // approach angle (NONE leaves a flat edge that's perpendicular to the
  // line's tangent — on curved paths that doesn't match the triangle's
  // axis-aligned back edge and leaves a visible gap).
  line.strokeCap = "ROUND";
}

// --- Connection lifecycle ---------------------------------------------------

async function createConnector(
  source: SceneNode,
  target: SceneNode,
  defaults: Defaults
): Promise<Connection> {
  const built = buildPath(
    defaults.style,
    source,
    target,
    insetFor(defaults.startEnd, defaults.endSize),
    insetFor(defaults.endEnd, defaults.endSize)
  );

  const line = figma.createVector();
  line.name = "line";
  await paintLine(line, built, defaults.color, defaults.width);

  const startCap = makeCapNode(defaults.startEnd, defaults.color, defaults.width, defaults.endSize);
  const endCap = makeCapNode(defaults.endEnd, defaults.color, defaults.width, defaults.endSize);
  if (startCap) {
    startCap.name = "start-cap";
    if (isVectorCap(defaults.startEnd)) {
      positionVectorCap(startCap, defaults.startEnd, built.startPoint, built.startTangent, defaults.endSize);
    } else {
      positionCap(startCap, built.startPoint);
    }
  }
  if (endCap) {
    endCap.name = "end-cap";
    if (isVectorCap(defaults.endEnd)) {
      positionVectorCap(endCap, defaults.endEnd, built.endPoint, built.endTangent, defaults.endSize);
    } else {
      positionCap(endCap, built.endPoint);
    }
  }

  // Group: line first so it renders under the caps.
  const children: SceneNode[] = [line];
  if (startCap) children.push(startCap);
  if (endCap) children.push(endCap);
  for (const child of children) figma.currentPage.appendChild(child);

  const group = figma.group(children, figma.currentPage);
  group.name = `Connector: ${source.name} → ${target.name}`;
  group.setPluginData(PLUGIN_DATA_KEY, "1");
  // Tag children too, so we can identify them on selection.
  line.setPluginData(PLUGIN_DATA_KEY, "child");
  if (startCap) startCap.setPluginData(PLUGIN_DATA_KEY, "child");
  if (endCap) endCap.setPluginData(PLUGIN_DATA_KEY, "child");

  return {
    id: group.id,
    lineId: line.id,
    startCapId: startCap ? startCap.id : null,
    endCapId: endCap ? endCap.id : null,
    labelId: null,
    labelBgId: null,
    source: source.id,
    target: target.id,
    style: defaults.style,
    startEnd: defaults.startEnd,
    endEnd: defaults.endEnd,
    color: defaults.color,
    width: defaults.width,
    endSize: defaults.endSize
  };
}

async function rerouteConnection(conn: Connection): Promise<boolean> {
  const group = await figma.getNodeByIdAsync(conn.id);
  const line = await figma.getNodeByIdAsync(conn.lineId);
  const source = await figma.getNodeByIdAsync(conn.source);
  const target = await figma.getNodeByIdAsync(conn.target);
  if (!group || group.type !== "GROUP") return false;
  if (!line || line.type !== "VECTOR") return false;
  if (!source || !target) return false;
  if (!("absoluteBoundingBox" in source) || !("absoluteBoundingBox" in target)) return false;

  const built = buildPath(
    conn.style,
    source as SceneNode,
    target as SceneNode,
    insetFor(conn.startEnd, conn.endSize),
    insetFor(conn.endEnd, conn.endSize)
  );
  await paintLine(line as VectorNode, built, conn.color, conn.width);

  if (conn.startCapId) {
    const cap = await figma.getNodeByIdAsync(conn.startCapId);
    if (cap && "x" in cap) {
      if (isVectorCap(conn.startEnd)) {
        positionVectorCap(cap as SceneNode, conn.startEnd, built.startPoint, built.startTangent, conn.endSize);
      } else {
        positionCap(cap as SceneNode, built.startPoint);
      }
    }
  }
  if (conn.endCapId) {
    const cap = await figma.getNodeByIdAsync(conn.endCapId);
    if (cap && "x" in cap) {
      if (isVectorCap(conn.endEnd)) {
        positionVectorCap(cap as SceneNode, conn.endEnd, built.endPoint, built.endTangent, conn.endSize);
      } else {
        positionCap(cap as SceneNode, built.endPoint);
      }
    }
  }
  if (conn.labelId) {
    const label = await figma.getNodeByIdAsync(conn.labelId);
    if (label && label.type === "TEXT") {
      positionLabel(label as TextNode, built.midPoint);
      if (conn.labelBgId) {
        const pill = await figma.getNodeByIdAsync(conn.labelBgId);
        if (pill && pill.type === "RECTANGLE") {
          positionLabelPill(pill as RectangleNode, label as TextNode, built.midPoint);
        }
      }
    }
  }
  return true;
}

async function restyleConnection(
  conn: Connection,
  patch: Partial<Pick<Connection, "style" | "startEnd" | "endEnd" | "color" | "width" | "endSize">>
): Promise<Connection | null> {
  // Apply patch and rebuild caps if their style changed.
  const next: Connection = { ...conn, ...patch };

  const group = await figma.getNodeByIdAsync(next.id);
  if (!group || group.type !== "GROUP") return null;

  // For circles/squares, restyle in place when the primitive hasn't changed
  // (e.g. circle -> circle-hollow). For arrows or primitive changes, drop and
  // recreate the cap. Arrow vectors are easier to regenerate than to mutate
  // in place because their geometry depends on endSize.
  async function reconcileCap(
    side: "start" | "end",
    oldStyle: EndStyle,
    newStyle: EndStyle,
    oldId: string | null
  ): Promise<string | null> {
    // In-place restyle only applies to the ellipse/rectangle caps. Semi-circle
    // caps are vectors (capPrimitive "none"), so they fall through to recreate.
    const sameRoundOrSquare =
      capPrimitive(oldStyle) !== "none" &&
      capPrimitive(oldStyle) === capPrimitive(newStyle);

    if (sameRoundOrSquare && oldId) {
      const node = await figma.getNodeByIdAsync(oldId);
      if (node && "fills" in node) {
        applyCapStyle(node as EllipseNode | RectangleNode, newStyle, next.color, next.width, next.endSize);
      }
      return oldId;
    }

    if (oldId) {
      const node = await figma.getNodeByIdAsync(oldId);
      if (node) node.remove();
    }
    const fresh = makeCapNode(newStyle, next.color, next.width, next.endSize);
    if (!fresh) return null;
    fresh.name = side === "start" ? "start-cap" : "end-cap";
    fresh.setPluginData(PLUGIN_DATA_KEY, "child");
    (group as GroupNode).appendChild(fresh);
    return fresh.id;
  }

  next.startCapId = await reconcileCap("start", conn.startEnd, next.startEnd, conn.startCapId);
  next.endCapId = await reconcileCap("end", conn.endEnd, next.endEnd, conn.endCapId);

  await rerouteConnection(next);
  return next;
}

function capPrimitive(style: EndStyle): "circle" | "square" | "none" {
  if (style === "circle" || style === "circle-hollow") return "circle";
  if (style === "square" || style === "square-hollow") return "square";
  return "none";
}

function applyCapStyle(
  node: EllipseNode | RectangleNode,
  style: EndStyle,
  color: RGB,
  width: number,
  size: number
): void {
  const hollow = style === "circle-hollow" || style === "square-hollow";
  node.resize(size, size);
  if (hollow) {
    node.fills = [];
    node.strokes = [{ type: "SOLID", color }];
    node.strokeWeight = Math.max(1, width);
  } else {
    node.fills = [{ type: "SOLID", color }];
    node.strokes = [];
  }
}

async function rerouteAll(): Promise<number> {
  const list = loadConnections();
  const survivors: Connection[] = [];
  for (const conn of list) {
    const ok = await rerouteConnection(conn);
    if (ok) survivors.push(conn);
  }
  if (survivors.length !== list.length) saveConnections(survivors);
  return survivors.length;
}

// --- Live position polling --------------------------------------------------
//
// Figma doesn't fire a "node moved" event. To make connectors follow shapes
// during/right after a drag, we poll every 50ms: snapshot the absolute bounding
// box of every endpoint node, and reroute only the connectors whose source or
// target moved since the last tick.

const POLL_INTERVAL_MS = 50;
const lastBox: Map<string, string> = new Map(); // nodeId -> serialized bbox
let tickInProgress = false;

function bboxKey(node: BaseNode | null): string | null {
  if (!node || !("absoluteBoundingBox" in node)) return null;
  const b = (node as SceneNode).absoluteBoundingBox;
  if (!b) return null;
  return `${b.x},${b.y},${b.width},${b.height}`;
}

async function pollTick(): Promise<void> {
  if (tickInProgress) return;
  tickInProgress = true;
  try {
    const list = loadConnections();
    if (list.length === 0) {
      if (lastBox.size > 0) lastBox.clear();
      return;
    }

    // Collect every endpoint node id involved in any connection.
    const endpointIds = new Set<string>();
    for (const conn of list) {
      endpointIds.add(conn.source);
      endpointIds.add(conn.target);
    }

    // Snapshot current bboxes and detect which ones changed.
    const moved = new Set<string>();
    const aliveIds = new Set<string>();
    for (const id of endpointIds) {
      const node = await figma.getNodeByIdAsync(id);
      const key = bboxKey(node);
      if (key === null) continue; // node deleted; rerouteConnection will prune
      aliveIds.add(id);
      const prev = lastBox.get(id);
      if (prev !== key) {
        moved.add(id);
        lastBox.set(id, key);
      }
    }

    // Drop stale entries (nodes that no longer exist).
    for (const id of Array.from(lastBox.keys())) {
      if (!aliveIds.has(id)) lastBox.delete(id);
    }

    if (moved.size === 0) return;

    // Reroute only the connectors whose source or target moved.
    const survivors: Connection[] = [];
    let pruned = false;
    for (const conn of list) {
      if (moved.has(conn.source) || moved.has(conn.target)) {
        const ok = await rerouteConnection(conn);
        if (ok) survivors.push(conn);
        else pruned = true;
      } else {
        survivors.push(conn);
      }
    }
    if (pruned) saveConnections(survivors);
  } catch (err) {
    console.error("poll tick failed", err);
  } finally {
    tickInProgress = false;
  }
}

// --- Message handlers -------------------------------------------------------

function isOurNode(n: SceneNode): boolean {
  const tag = n.getPluginData(PLUGIN_DATA_KEY);
  return tag === "1" || tag === "child";
}

/** Resolve the current selection to the set of connection IDs the user has
 *  picked. We accept a top-level group ("1") OR any tagged child ("child"),
 *  walking up to the group. */
function selectedConnectionIds(): Set<string> {
  const ids = new Set<string>();
  const shapeIds = new Set<string>();
  for (const n of figma.currentPage.selection) {
    const tag = n.getPluginData(PLUGIN_DATA_KEY);
    if (tag === "1") {
      // Connector group selected directly.
      ids.add(n.id);
    } else if (tag === "child") {
      // A child of a connector group (line or cap) — walk up to its group.
      let cur: BaseNode | null = n.parent;
      while (cur) {
        if ("getPluginData" in cur && (cur as SceneNode).getPluginData(PLUGIN_DATA_KEY) === "1") {
          ids.add(cur.id);
          break;
        }
        cur = cur.parent;
      }
    } else {
      // Regular shape — bring any connectors attached to it into scope so
      // editing the controls updates the lines wired to this shape.
      shapeIds.add(n.id);
    }
  }
  if (shapeIds.size > 0) {
    for (const conn of loadConnections()) {
      if (shapeIds.has(conn.source) || shapeIds.has(conn.target)) {
        ids.add(conn.id);
      }
    }
  }
  return ids;
}

async function handleConnect(defaults: Defaults): Promise<void> {
  const sel = figma.currentPage.selection.filter((n) => !isOurNode(n));
  if (sel.length < 2) {
    figma.ui.postMessage({ type: "status", text: "Select 2+ shapes to connect." });
    return;
  }
  const list = loadConnections();
  for (let i = 0; i < sel.length - 1; i++) {
    const conn = await createConnector(sel[i], sel[i + 1], defaults);
    list.push(conn);
  }
  saveConnections(list);
  figma.ui.postMessage({
    type: "status",
    text: `Created ${sel.length - 1} connector${sel.length - 1 === 1 ? "" : "s"}.`
  });
}

async function handleDisconnect(): Promise<void> {
  const list = loadConnections();
  const targetIds = selectedConnectionIds();
  const remaining: Connection[] = [];
  let removed = 0;
  for (const conn of list) {
    if (targetIds.has(conn.id)) {
      const node = await figma.getNodeByIdAsync(conn.id);
      if (node) node.remove();
      removed++;
    } else {
      remaining.push(conn);
    }
  }
  saveConnections(remaining);
  figma.ui.postMessage({
    type: "status",
    text: removed > 0
      ? `Removed ${removed} connector${removed === 1 ? "" : "s"}.`
      : "Select connector lines to delete them."
  });
}

async function handleAddLabel(): Promise<void> {
  const targetIds = selectedConnectionIds();
  if (targetIds.size === 0) {
    figma.ui.postMessage({ type: "status", text: "Select a connector to label." });
    return;
  }
  const list = loadConnections();
  let added = 0;
  let alreadyLabeled = 0;
  for (let i = 0; i < list.length; i++) {
    if (!targetIds.has(list[i].id)) continue;
    if (list[i].labelId) {
      const existing = await figma.getNodeByIdAsync(list[i].labelId as string);
      if (existing && existing.type === "TEXT") {
        alreadyLabeled++;
        continue;
      }
    }
    const created = await createLabelForConnection(list[i]);
    if (!created) continue;
    list[i] = { ...list[i], labelId: created.labelId, labelBgId: created.bgId };
    // rerouteConnection recomputes the midpoint and places both text and pill.
    await rerouteConnection(list[i]);
    added++;
  }
  if (added > 0) saveConnections(list);
  figma.ui.postMessage({
    type: "status",
    text:
      added > 0
        ? `Added label to ${added} connector${added === 1 ? "" : "s"}.`
        : alreadyLabeled > 0
          ? "Already labeled — edit the text on canvas."
          : "No labels added."
  });
  // The button's add/remove state depends on whether all selected connectors
  // have a label — re-push selection state so the UI flips without waiting
  // for the next selectionchange.
  postSelectionState();
}

async function handleRemoveLabel(): Promise<void> {
  const targetIds = selectedConnectionIds();
  if (targetIds.size === 0) {
    figma.ui.postMessage({ type: "status", text: "Select a connector first." });
    return;
  }
  const list = loadConnections();
  let removed = 0;
  for (let i = 0; i < list.length; i++) {
    if (!targetIds.has(list[i].id)) continue;
    const labelId = list[i].labelId;
    const bgId = list[i].labelBgId;
    if (!labelId && !bgId) continue;
    if (labelId) {
      const node = await figma.getNodeByIdAsync(labelId);
      if (node) node.remove();
    }
    if (bgId) {
      const pill = await figma.getNodeByIdAsync(bgId);
      if (pill) pill.remove();
    }
    list[i] = { ...list[i], labelId: null, labelBgId: null };
    removed++;
  }
  if (removed > 0) saveConnections(list);
  figma.ui.postMessage({
    type: "status",
    text: removed > 0 ? `Removed label from ${removed} connector${removed === 1 ? "" : "s"}.` : "No labels to remove."
  });
  postSelectionState();
}

/** Remove labels whose text is empty. Returns the number of connections
 *  mutated so the caller knows whether to persist. */
async function cleanupEmptyLabels(): Promise<number> {
  const list = loadConnections();
  let mutated = 0;
  for (let i = 0; i < list.length; i++) {
    const labelId = list[i].labelId;
    const bgId = list[i].labelBgId;
    if (!labelId && !bgId) continue;
    const labelNode = labelId ? await figma.getNodeByIdAsync(labelId) : null;
    const isTextLive = labelNode && labelNode.type === "TEXT";
    const isEmpty = isTextLive && (labelNode as TextNode).characters.length === 0;
    if (!labelNode || !isTextLive || isEmpty) {
      // Remove pill alongside the text whenever the label is dead or empty.
      if (isTextLive && isEmpty) labelNode.remove();
      if (bgId) {
        const pill = await figma.getNodeByIdAsync(bgId);
        if (pill) pill.remove();
      }
      list[i] = { ...list[i], labelId: null, labelBgId: null };
      mutated++;
    }
  }
  if (mutated > 0) saveConnections(list);
  return mutated;
}

/** Apply a style patch to currently-selected connectors. Returns the number
 *  of connectors mutated. */
async function applyStyleToSelection(
  patch: Partial<Pick<Connection, "style" | "startEnd" | "endEnd" | "color" | "width" | "endSize">>
): Promise<number> {
  const targetIds = selectedConnectionIds();
  if (targetIds.size === 0) return 0;
  const list = loadConnections();
  let changed = 0;
  for (let i = 0; i < list.length; i++) {
    if (targetIds.has(list[i].id)) {
      const next = await restyleConnection(list[i], patch);
      if (next) {
        list[i] = next;
        changed++;
      }
    }
  }
  if (changed > 0) saveConnections(list);
  return changed;
}

/** Build a snapshot of the current selection's connection styles for the UI.
 *  If a field varies across selected connectors, it's reported as `null`
 *  (the UI shows a "Mixed" placeholder). */
function selectionState(): {
  selectedCount: number;
  style: LineStyle | null;
  startEnd: EndStyle | null;
  endEnd: EndStyle | null;
  color: RGB | null;
  width: number | null;
  endSize: number | null;
  allLabeled: boolean;
} {
  const ids = selectedConnectionIds();
  if (ids.size === 0) {
    return { selectedCount: 0, style: null, startEnd: null, endEnd: null, color: null, width: null, endSize: null, allLabeled: false };
  }
  const list = loadConnections().filter((c) => ids.has(c.id));
  if (list.length === 0) {
    return { selectedCount: 0, style: null, startEnd: null, endEnd: null, color: null, width: null, endSize: null, allLabeled: false };
  }
  const first = list[0];
  let style: LineStyle | null = first.style;
  let startEnd: EndStyle | null = first.startEnd;
  let endEnd: EndStyle | null = first.endEnd;
  let color: RGB | null = first.color;
  let width: number | null = first.width;
  let endSize: number | null = first.endSize;
  let allLabeled = true;
  for (const c of list) {
    if (c.style !== style) style = null;
    if (c.startEnd !== startEnd) startEnd = null;
    if (c.endEnd !== endEnd) endEnd = null;
    if (!color || c.color.r !== color.r || c.color.g !== color.g || c.color.b !== color.b) color = null;
    if (c.width !== width) width = null;
    if (c.endSize !== endSize) endSize = null;
    if (!c.labelId) allLabeled = false;
  }
  return { selectedCount: list.length, style, startEnd, endEnd, color, width, endSize, allLabeled };
}

function postSelectionState(): void {
  const state = selectionState();
  figma.ui.postMessage({ type: "selection", ...state });
  // When nothing is selected, also push the current defaults so the controls
  // reflect what the *next* Connect click will produce.
  if (state.selectedCount === 0) {
    figma.ui.postMessage({ type: "defaults", defaults: loadDefaults() });
  }
}

// --- Window sizing & docking -----------------------------------------------

const FULL_W = 260;
const FULL_H = 480;
const MINI_W = 180;
const MINI_H = 36;
// Margin in canvas-space pixels between the UI and the viewport edge.
const DOCK_MARGIN = 12;

// Figma renders a title bar (~40px) above the iframe content area, which is
// NOT included in the height you pass to showUI/resize. Without compensating,
// the bottom of the window lands ~40px below the viewport's bottom edge.
const TITLEBAR_PX = 40;

function dockBottomRight(w: number, h: number): void {
  // figma.ui.reposition takes canvas-space coordinates for the window's
  // top-left corner. figma.viewport.bounds is also in canvas space. The
  // window's on-screen size in screen pixels (w wide, h + TITLEBAR_PX tall)
  // maps to canvas units by dividing by zoom.
  const v = figma.viewport.bounds;
  const zoom = figma.viewport.zoom;
  const wCanvas = w / zoom;
  const hCanvas = (h + TITLEBAR_PX) / zoom;
  const marginCanvas = DOCK_MARGIN / zoom;
  const x = v.x + v.width - wCanvas - marginCanvas;
  const y = v.y + v.height - hCanvas - marginCanvas;
  figma.ui.reposition(x, y);
}

function minimizeUI(): void {
  figma.ui.resize(MINI_W, MINI_H);
  dockBottomRight(MINI_W, MINI_H);
}

function expandUI(): void {
  figma.ui.resize(FULL_W, FULL_H);
  // We don't reposition on expand — the window stays where the user docked it,
  // just grows upward/leftward from there. Re-dock so it grows into the
  // viewport rather than off-screen.
  dockBottomRight(FULL_W, FULL_H);
}

// --- Bootstrap --------------------------------------------------------------

figma.showUI(__html__, { width: FULL_W, height: FULL_H, themeColors: true });

const initialDefaults = loadDefaults();
figma.ui.postMessage({ type: "defaults", defaults: initialDefaults });
postSelectionState();

// Selectionchange triggers two things: a safety-net reroute (cheap) and a UI
// state push so the controls reflect the selected connector(s).
figma.on("selectionchange", () => {
  // selectionchange is a natural moment to garbage-collect labels the user
  // emptied (we can't catch the edit-finish event directly). Cleanup first,
  // then a global reroute as a safety net for stuff the poll loop missed.
  (async () => {
    await cleanupEmptyLabels();
    await rerouteAll();
  })().catch((err) => console.error("selectionchange tasks failed", err));
  postSelectionState();
});

const pollHandle = setInterval(() => {
  pollTick().catch((err) => console.error("poll failed", err));
}, POLL_INTERVAL_MS);

figma.on("close", () => {
  clearInterval(pollHandle);
});

function normalizeDefaultsPatch(p: Partial<Defaults>): Partial<Defaults> {
  const out: Partial<Defaults> = {};
  if (isLineStyle(p.style)) out.style = p.style;
  if (isEndStyle(p.startEnd)) out.startEnd = p.startEnd;
  if (isEndStyle(p.endEnd)) out.endEnd = p.endEnd;
  if (p.color && typeof p.color.r === "number" && typeof p.color.g === "number" && typeof p.color.b === "number") {
    out.color = { r: p.color.r, g: p.color.g, b: p.color.b };
  }
  if (typeof p.width === "number" && p.width > 0) out.width = p.width;
  if (typeof p.endSize === "number" && p.endSize > 0) out.endSize = p.endSize;
  return out;
}

figma.ui.onmessage = async (msg) => {
  try {
    if (msg.type === "connect") {
      const cur = loadDefaults();
      await handleConnect(cur);
    } else if (msg.type === "disconnect") {
      await handleDisconnect();
    } else if (msg.type === "addLabel") {
      await handleAddLabel();
    } else if (msg.type === "removeLabel") {
      await handleRemoveLabel();
    } else if (msg.type === "setStyle") {
      // The UI sends `patch` (style fields the user changed). If any
      // connectors are selected, we apply the patch to them. Otherwise we
      // store the patch as the new defaults for the next Connect click.
      const patch = normalizeDefaultsPatch(msg.patch || {});
      const ids = selectedConnectionIds();
      if (ids.size > 0) {
        const n = await applyStyleToSelection(patch);
        if (n > 0) {
          figma.ui.postMessage({
            type: "status",
            text: `Updated ${n} connector${n === 1 ? "" : "s"}.`
          });
          postSelectionState();
        }
      } else {
        const cur = loadDefaults();
        saveDefaults({ ...cur, ...patch });
      }
    } else if (msg.type === "minimize") {
      minimizeUI();
    } else if (msg.type === "expand") {
      expandUI();
    }
  } catch (err) {
    console.error(err);
    figma.ui.postMessage({ type: "status", text: `Error: ${(err as Error).message}` });
  }
};
