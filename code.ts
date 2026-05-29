/// <reference types="@figma/plugin-typings" />

// --- Types ------------------------------------------------------------------

type LineStyle = "orthogonal" | "curved" | "straight";
type EndStyle =
  | "none"
  | "arrow"
  | "circle"
  | "square"
  | "circle-hollow"
  | "square-hollow";

const LINE_STYLES: LineStyle[] = ["orthogonal", "curved", "straight"];
const END_STYLES: EndStyle[] = ["none", "arrow", "circle", "square", "circle-hollow", "square-hollow"];

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
      endSize: typeof c.endSize === "number" ? c.endSize : DEFAULT_END_SIZE
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
}

interface BuiltPath {
  origin: Point;
  data: string;
  startPoint: Point;
  endPoint: Point;
  startTangent: Point;
  endTangent: Point;
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
    endTangent: spec.endTangent
  };
}

function fmt(p: Point, o: Point): string {
  return `${p.x - o.x} ${p.y - o.y}`;
}

function buildStraightPath(a: Box, b: Box): BuiltPath {
  const pa = edgePointTowards(a, { x: b.cx, y: b.cy });
  const pb = edgePointTowards(b, { x: a.cx, y: a.cy });
  // Tangent at start points back toward A (away from line); at end, back toward B.
  const dir = normalize({ x: pb.x - pa.x, y: pb.y - pa.y });
  return finalize({
    bboxPoints: [pa, pb],
    emit: (o) => `M ${fmt(pa, o)} L ${fmt(pb, o)}`,
    startPoint: pa,
    endPoint: pb,
    startTangent: { x: -dir.x, y: -dir.y },
    endTangent: dir
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

function buildOrthogonalPath(a: Box, b: Box): BuiltPath {
  const { aSide, bSide } = chooseSides(a, b);
  const pa = anchorOn(a, aSide);
  const pb = anchorOn(b, bSide);
  const horizontal = aSide === "left" || aSide === "right";
  let v2: Point, v3: Point;
  if (horizontal) {
    const midX = (pa.x + pb.x) / 2;
    v2 = { x: midX, y: pa.y };
    v3 = { x: midX, y: pb.y };
  } else {
    const midY = (pa.y + pb.y) / 2;
    v2 = { x: pa.x, y: midY };
    v3 = { x: pb.x, y: midY };
  }
  return finalize({
    bboxPoints: [pa, v2, v3, pb],
    emit: (o) => `M ${fmt(pa, o)} L ${fmt(v2, o)} L ${fmt(v3, o)} L ${fmt(pb, o)}`,
    startPoint: pa,
    endPoint: pb,
    // Tangent at the endpoint points OUTWARD from the connected shape, which
    // for orthogonal routing is the direction the line exits the shape's side.
    startTangent: sideInwardTangent(aSide),
    endTangent: sideInwardTangent(bSide)
  });
}

function buildCurvedPath(a: Box, b: Box): BuiltPath {
  const { aSide, bSide } = chooseSides(a, b);
  const pa = anchorOn(a, aSide);
  const pb = anchorOn(b, bSide);
  const horizontal = aSide === "left" || aSide === "right";
  const dx = pb.x - pa.x;
  const dy = pb.y - pa.y;
  const off = Math.max(40, (horizontal ? Math.abs(dx) : Math.abs(dy)) / 2);
  let c1: Point, c2: Point;
  if (horizontal) {
    const sign = aSide === "right" ? 1 : -1;
    const sign2 = bSide === "right" ? 1 : -1;
    c1 = { x: pa.x + sign * off, y: pa.y };
    c2 = { x: pb.x + sign2 * off, y: pb.y };
  } else {
    const sign = aSide === "bottom" ? 1 : -1;
    const sign2 = bSide === "bottom" ? 1 : -1;
    c1 = { x: pa.x, y: pa.y + sign * off };
    c2 = { x: pb.x, y: pb.y + sign2 * off };
  }
  return finalize({
    bboxPoints: [pa, pb, c1, c2],
    emit: (o) => `M ${fmt(pa, o)} C ${fmt(c1, o)} ${fmt(c2, o)} ${fmt(pb, o)}`,
    startPoint: pa,
    endPoint: pb,
    startTangent: sideInwardTangent(aSide),
    endTangent: sideInwardTangent(bSide)
  });
}

function buildPath(style: LineStyle, a: Box, b: Box): BuiltPath {
  switch (style) {
    case "straight":   return buildStraightPath(a, b);
    case "curved":     return buildCurvedPath(a, b);
    case "orthogonal":
    default:           return buildOrthogonalPath(a, b);
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

function isVectorCap(style: EndStyle): boolean {
  return style === "arrow";
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
  line.strokeCap = "NONE";
}

// --- Connection lifecycle ---------------------------------------------------

async function createConnector(
  source: SceneNode,
  target: SceneNode,
  defaults: Defaults
): Promise<Connection> {
  const a = rectFor(source);
  const b = rectFor(target);
  const built = buildPath(defaults.style, a, b);

  const line = figma.createVector();
  line.name = "line";
  await paintLine(line, built, defaults.color, defaults.width);

  const startCap = makeCapNode(defaults.startEnd, defaults.color, defaults.width, defaults.endSize);
  const endCap = makeCapNode(defaults.endEnd, defaults.color, defaults.width, defaults.endSize);
  if (startCap) {
    startCap.name = "start-cap";
    if (isVectorCap(defaults.startEnd)) {
      positionArrowCap(startCap, built.startPoint, built.startTangent, defaults.endSize);
    } else {
      positionCap(startCap, built.startPoint);
    }
  }
  if (endCap) {
    endCap.name = "end-cap";
    if (isVectorCap(defaults.endEnd)) {
      positionArrowCap(endCap, built.endPoint, built.endTangent, defaults.endSize);
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

  const a = rectFor(source as SceneNode);
  const b = rectFor(target as SceneNode);
  const built = buildPath(conn.style, a, b);
  await paintLine(line as VectorNode, built, conn.color, conn.width);

  if (conn.startCapId) {
    const cap = await figma.getNodeByIdAsync(conn.startCapId);
    if (cap && "x" in cap) {
      if (isVectorCap(conn.startEnd)) {
        positionArrowCap(cap as SceneNode, built.startPoint, built.startTangent, conn.endSize);
      } else {
        positionCap(cap as SceneNode, built.startPoint);
      }
    }
  }
  if (conn.endCapId) {
    const cap = await figma.getNodeByIdAsync(conn.endCapId);
    if (cap && "x" in cap) {
      if (isVectorCap(conn.endEnd)) {
        positionArrowCap(cap as SceneNode, built.endPoint, built.endTangent, conn.endSize);
      } else {
        positionCap(cap as SceneNode, built.endPoint);
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
    const sameRoundOrSquare =
      oldStyle !== "none" && oldStyle !== "arrow" &&
      newStyle !== "none" && newStyle !== "arrow" &&
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
  for (const n of figma.currentPage.selection) {
    const tag = n.getPluginData(PLUGIN_DATA_KEY);
    if (tag === "1") {
      ids.add(n.id);
    } else if (tag === "child") {
      let cur: BaseNode | null = n.parent;
      while (cur) {
        if ("getPluginData" in cur && (cur as SceneNode).getPluginData(PLUGIN_DATA_KEY) === "1") {
          ids.add(cur.id);
          break;
        }
        cur = cur.parent;
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

async function handleRefresh(): Promise<void> {
  const n = await rerouteAll();
  figma.ui.postMessage({ type: "status", text: `Refreshed ${n} connector${n === 1 ? "" : "s"}.` });
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
} {
  const ids = selectedConnectionIds();
  if (ids.size === 0) {
    return { selectedCount: 0, style: null, startEnd: null, endEnd: null, color: null, width: null, endSize: null };
  }
  const list = loadConnections().filter((c) => ids.has(c.id));
  if (list.length === 0) {
    return { selectedCount: 0, style: null, startEnd: null, endEnd: null, color: null, width: null, endSize: null };
  }
  const first = list[0];
  let style: LineStyle | null = first.style;
  let startEnd: EndStyle | null = first.startEnd;
  let endEnd: EndStyle | null = first.endEnd;
  let color: RGB | null = first.color;
  let width: number | null = first.width;
  let endSize: number | null = first.endSize;
  for (const c of list) {
    if (c.style !== style) style = null;
    if (c.startEnd !== startEnd) startEnd = null;
    if (c.endEnd !== endEnd) endEnd = null;
    if (!color || c.color.r !== color.r || c.color.g !== color.g || c.color.b !== color.b) color = null;
    if (c.width !== width) width = null;
    if (c.endSize !== endSize) endSize = null;
  }
  return { selectedCount: list.length, style, startEnd, endEnd, color, width, endSize };
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
const FULL_H = 380;
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
  rerouteAll().catch((err) => console.error("reroute failed", err));
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
    } else if (msg.type === "refresh") {
      await handleRefresh();
    } else if (msg.type === "disconnect") {
      await handleDisconnect();
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
