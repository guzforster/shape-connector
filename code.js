"use strict";
/// <reference types="@figma/plugin-typings" />
const LINE_STYLES = ["orthogonal", "curved", "straight"];
const END_STYLES = ["none", "arrow", "circle", "square", "circle-hollow", "square-hollow"];
function isLineStyle(v) {
    return typeof v === "string" && LINE_STYLES.includes(v);
}
function isEndStyle(v) {
    return typeof v === "string" && END_STYLES.includes(v);
}
const PLUGIN_DATA_KEY = "shape-connector-meta";
const ROOT_CONNECTIONS_KEY = "shape-connector-connections";
const ROOT_DEFAULTS_KEY = "shape-connector-defaults";
const DEFAULT_COLOR = { r: 0.4, g: 0.4, b: 0.4 };
const DEFAULT_WIDTH = 1.5;
const DEFAULT_END_SIZE = 10;
// --- Storage ----------------------------------------------------------------
const SCHEMA_VERSION = 2;
function loadConnections() {
    const raw = figma.root.getPluginData(ROOT_CONNECTIONS_KEY);
    if (!raw)
        return [];
    try {
        const parsed = JSON.parse(raw);
        // v1 stored a bare array. v2+ stores { version, connections }. We discard
        // v1 records because their on-canvas representation is a bare VectorNode,
        // not the group structure the new renderer expects — the user can delete
        // the orphan vectors and reconnect with the richer styling.
        if (Array.isArray(parsed))
            return [];
        const file = parsed;
        if (file.version !== SCHEMA_VERSION)
            return [];
        // Backfill fields added since v2 was introduced.
        return (file.connections || []).map((c) => (Object.assign(Object.assign({}, c), { endSize: typeof c.endSize === "number" ? c.endSize : DEFAULT_END_SIZE })));
    }
    catch (_a) {
        return [];
    }
}
function saveConnections(list) {
    const file = { version: SCHEMA_VERSION, connections: list };
    figma.root.setPluginData(ROOT_CONNECTIONS_KEY, JSON.stringify(file));
}
function defaultDefaults() {
    return {
        style: "orthogonal",
        startEnd: "none",
        endEnd: "arrow",
        color: DEFAULT_COLOR,
        width: DEFAULT_WIDTH,
        endSize: DEFAULT_END_SIZE
    };
}
function loadDefaults() {
    const raw = figma.root.getPluginData(ROOT_DEFAULTS_KEY);
    if (!raw)
        return defaultDefaults();
    try {
        const parsed = JSON.parse(raw);
        // Merge over defaults so old stored versions (missing fields) still work.
        return Object.assign(Object.assign({}, defaultDefaults()), parsed);
    }
    catch (_a) {
        return defaultDefaults();
    }
}
function saveDefaults(d) {
    figma.root.setPluginData(ROOT_DEFAULTS_KEY, JSON.stringify(d));
}
function rectFor(node) {
    // absoluteBoundingBox includes rotation/strokes; this is what we want for routing.
    const b = node.absoluteBoundingBox;
    if (!b) {
        return { x: node.x, y: node.y, w: node.width, h: node.height, cx: node.x + node.width / 2, cy: node.y + node.height / 2 };
    }
    return { x: b.x, y: b.y, w: b.width, h: b.height, cx: b.x + b.width / 2, cy: b.y + b.height / 2 };
}
function chooseSides(a, b) {
    const dx = b.cx - a.cx;
    const dy = b.cy - a.cy;
    if (Math.abs(dx) >= Math.abs(dy)) {
        return dx >= 0 ? { aSide: "right", bSide: "left" } : { aSide: "left", bSide: "right" };
    }
    return dy >= 0 ? { aSide: "bottom", bSide: "top" } : { aSide: "top", bSide: "bottom" };
}
function anchorOn(r, side) {
    switch (side) {
        case "left": return { x: r.x, y: r.cy };
        case "right": return { x: r.x + r.w, y: r.cy };
        case "top": return { x: r.cx, y: r.y };
        case "bottom": return { x: r.cx, y: r.y + r.h };
    }
}
function applyTransform(p, m) {
    // Transform is [[a, b, tx], [c, d, ty]]; result = [a*x + b*y + tx, c*x + d*y + ty].
    return {
        x: m[0][0] * p.x + m[0][1] * p.y + m[0][2],
        y: m[1][0] * p.x + m[1][1] * p.y + m[1][2]
    };
}
/** Parse an SVG path string into a flat list of line/cubic segments in the
 *  same coord space as the path string. Handles M, L, H, V, C, Z. */
function parsePathSegments(data) {
    const tokens = data.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
    const segments = [];
    let i = 0;
    const num = () => parseFloat(tokens[i++]);
    let cur = { x: 0, y: 0 };
    let start = { x: 0, y: 0 };
    while (i < tokens.length) {
        const tok = tokens[i++];
        switch (tok) {
            case "M": {
                cur = { x: num(), y: num() };
                start = cur;
                // Subsequent pairs after M are implicit L.
                while (i < tokens.length && /^-?\d/.test(tokens[i])) {
                    const next = { x: num(), y: num() };
                    segments.push({ kind: "line", a: cur, b: next });
                    cur = next;
                }
                break;
            }
            case "L": {
                while (i < tokens.length && /^-?\d/.test(tokens[i])) {
                    const next = { x: num(), y: num() };
                    segments.push({ kind: "line", a: cur, b: next });
                    cur = next;
                }
                break;
            }
            case "H": {
                while (i < tokens.length && /^-?\d/.test(tokens[i])) {
                    const next = { x: num(), y: cur.y };
                    segments.push({ kind: "line", a: cur, b: next });
                    cur = next;
                }
                break;
            }
            case "V": {
                while (i < tokens.length && /^-?\d/.test(tokens[i])) {
                    const next = { x: cur.x, y: num() };
                    segments.push({ kind: "line", a: cur, b: next });
                    cur = next;
                }
                break;
            }
            case "C": {
                while (i < tokens.length && /^-?\d/.test(tokens[i])) {
                    const c1 = { x: num(), y: num() };
                    const c2 = { x: num(), y: num() };
                    const b = { x: num(), y: num() };
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
function nodeOutlineSegments(node) {
    // fillGeometry exists on most shape nodes (RECTANGLE, ELLIPSE, POLYGON,
    // STAR, VECTOR, TEXT, BOOLEAN_OPERATION). For others (group, frame), we
    // return no segments so the caller falls back to bbox.
    if (!("fillGeometry" in node))
        return [];
    const paths = node.fillGeometry;
    if (!paths || paths.length === 0)
        return [];
    const transform = node.absoluteTransform;
    const all = [];
    for (const p of paths) {
        const local = parsePathSegments(p.data);
        for (const seg of local) {
            if (seg.kind === "line") {
                all.push({ kind: "line", a: applyTransform(seg.a, transform), b: applyTransform(seg.b, transform) });
            }
            else {
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
function closestOnLine(a, b, p) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = 0.5;
    if (len2 > 1e-9) {
        t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
        if (t < 0)
            t = 0;
        if (t > 1)
            t = 1;
    }
    const point = { x: a.x + t * dx, y: a.y + t * dy };
    const dxp = p.x - point.x, dyp = p.y - point.y;
    return { point, tangent: normalize({ x: dx, y: dy }), dist2: dxp * dxp + dyp * dyp };
}
function cubicAt(a, c1, c2, b, t) {
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
function cubicDerivAt(a, c1, c2, b, t) {
    const u = 1 - t;
    return {
        x: 3 * u * u * (c1.x - a.x) + 6 * u * t * (c2.x - c1.x) + 3 * t * t * (b.x - c2.x),
        y: 3 * u * u * (c1.y - a.y) + 6 * u * t * (c2.y - c1.y) + 3 * t * t * (b.y - c2.y)
    };
}
/** Closest point on a cubic bezier to reference p, via sampling. ~32 samples
 *  is more than enough for the resolution of a connector attachment. */
function closestOnCubic(a, c1, c2, b, p) {
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
function closestOutlinePoint(node, ref) {
    const segments = nodeOutlineSegments(node);
    if (segments.length === 0)
        return null;
    // Rectangles snap to edge midpoints only — connecting to a corner of a
    // box has no clear use case in flowchart-style diagrams. Other polygons
    // (triangle, star, etc.) keep both corners and midpoints as candidates
    // because their vertices are often meaningful attach points.
    const skipCorners = node.type === "RECTANGLE";
    function dist2(p) {
        const dx = p.x - ref.x;
        const dy = p.y - ref.y;
        return dx * dx + dy * dy;
    }
    let bestPoint = null;
    let bestD2 = Infinity;
    function consider(p) {
        const d = dist2(p);
        if (d < bestD2) {
            bestD2 = d;
            bestPoint = p;
        }
    }
    for (const seg of segments) {
        if (seg.kind === "line") {
            if (!skipCorners) {
                consider(seg.a);
                consider(seg.b);
            }
            consider({ x: (seg.a.x + seg.b.x) / 2, y: (seg.a.y + seg.b.y) / 2 });
        }
        else {
            // Cubics aren't polygonal — keep continuous attachment.
            const r = closestOnCubic(seg.a, seg.c1, seg.c2, seg.b, ref);
            consider(r.point);
        }
    }
    if (!bestPoint)
        return null;
    const box = rectFor(node);
    const attachPt = bestPoint;
    const dx = attachPt.x - box.cx;
    const dy = attachPt.y - box.cy;
    if (dx * dx + dy * dy < 1e-6) {
        const toRef = normalize({ x: ref.x - attachPt.x, y: ref.y - attachPt.y });
        return { point: attachPt, outwardTangent: toRef };
    }
    return { point: attachPt, outwardTangent: normalize({ x: dx, y: dy }) };
}
function edgePointTowards(r, target) {
    // Intersect the line from rect center to target with the rect boundary.
    const dx = target.x - r.cx;
    const dy = target.y - r.cy;
    if (dx === 0 && dy === 0)
        return { x: r.cx, y: r.cy };
    const halfW = r.w / 2;
    const halfH = r.h / 2;
    const scale = Math.min(halfW / Math.max(Math.abs(dx), 0.0001), halfH / Math.max(Math.abs(dy), 0.0001));
    return { x: r.cx + dx * scale, y: r.cy + dy * scale };
}
function normalize(v) {
    const len = Math.hypot(v.x, v.y);
    if (len < 1e-9)
        return { x: 1, y: 0 };
    return { x: v.x / len, y: v.y / len };
}
function finalize(spec) {
    let minX = Infinity, minY = Infinity;
    for (const p of spec.bboxPoints) {
        if (p.x < minX)
            minX = p.x;
        if (p.y < minY)
            minY = p.y;
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
function fmt(p, o) {
    return `${p.x - o.x} ${p.y - o.y}`;
}
function shiftAlong(p, t, dist) {
    // Move point p by `dist` along unit tangent t. Used to inset endpoints so
    // the line stops at an arrow's base instead of overlapping the triangle.
    return { x: p.x + t.x * dist, y: p.y + t.y * dist };
}
/** Attach point + INWARD tangent (pointing into the shape — direction an
 *  arrow at this attach point would point). Uses the outline if available,
 *  otherwise falls back to the bbox edge intersection. */
function attachPoint(node, towards) {
    const outline = closestOutlinePoint(node, towards);
    if (outline) {
        return { point: outline.point, inward: { x: -outline.outwardTangent.x, y: -outline.outwardTangent.y } };
    }
    // Fallback: ray from shape center to `towards`, intersect bbox edge.
    const box = rectFor(node);
    const point = edgePointTowards(box, towards);
    const inward = normalize({ x: box.cx - point.x, y: box.cy - point.y });
    return { point, inward };
}
function buildStraightPath(srcNode, tgtNode, startInset, endInset) {
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
        endTangent
    });
}
function sideInwardTangent(side) {
    // Unit vector pointing INTO the shape from its edge. For a connector
    // attaching at side "left", the line is arriving from the left side moving
    // rightward into the shape — so the inward tangent is (+1, 0).
    // This is the direction an arrow at that endpoint should point.
    switch (side) {
        case "left": return { x: 1, y: 0 };
        case "right": return { x: -1, y: 0 };
        case "top": return { x: 0, y: 1 };
        case "bottom": return { x: 0, y: -1 };
    }
}
function buildOrthogonalPath(srcNode, tgtNode, startInset, endInset) {
    // Orthogonal routing keeps the bbox-based attachment: connectors enter the
    // shape's side (left/right/top/bottom), which only makes sense for an
    // axis-aligned bbox. Outline-snap is reserved for straight/curved styles.
    const a = rectFor(srcNode);
    const b = rectFor(tgtNode);
    const { aSide, bSide } = chooseSides(a, b);
    const paFull = anchorOn(a, aSide);
    const pbFull = anchorOn(b, bSide);
    const startTangent = sideInwardTangent(aSide);
    const endTangent = sideInwardTangent(bSide);
    // Inset line endpoints away from each shape's edge by the requested amount.
    const paLine = shiftAlong(paFull, startTangent, -startInset);
    const pbLine = shiftAlong(pbFull, endTangent, -endInset);
    const horizontal = aSide === "left" || aSide === "right";
    let v2, v3;
    if (horizontal) {
        const midX = (paLine.x + pbLine.x) / 2;
        v2 = { x: midX, y: paLine.y };
        v3 = { x: midX, y: pbLine.y };
    }
    else {
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
        endTangent
    });
}
/** Sample the t-values where a cubic bezier reaches an extremum in either x
 *  or y. Returns t ∈ (0, 1) for each axis; endpoints (t=0, t=1) are already
 *  in bboxPoints as paLine/pbLine. */
function cubicExtremaT(p0, p1, p2, p3) {
    // For each axis, derivative = 3(1-t)²(p1-p0) + 6(1-t)t(p2-p1) + 3t²(p3-p2).
    // Solving = 0 gives a quadratic in t: at² + bt + c = 0 where
    //   a = -p0 + 3p1 - 3p2 + p3
    //   b = 2(p0 - 2p1 + p2)
    //   c = p1 - p0
    // (per-axis).
    const ts = [];
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
                if (t > 0 && t < 1)
                    ts.push(t);
            }
        }
        else {
            const disc = b * b - 4 * a * c;
            if (disc >= 0) {
                const s = Math.sqrt(disc);
                for (const t of [(-b + s) / (2 * a), (-b - s) / (2 * a)]) {
                    if (t > 0 && t < 1)
                        ts.push(t);
                }
            }
        }
    }
    return ts;
}
function buildCurvedPath(srcNode, tgtNode, startInset, endInset) {
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
        endTangent
    });
}
function insetFor(style, endSize) {
    // Only arrows need inset — their triangle occupies endSize pixels of length
    // and the line would otherwise overlap the body. Circles/squares are
    // centered on the endpoint, so the line meeting the endpoint sits behind
    // them naturally.
    return style === "arrow" ? endSize : 0;
}
function buildPath(style, srcNode, tgtNode, startInset, endInset) {
    switch (style) {
        case "straight": return buildStraightPath(srcNode, tgtNode, startInset, endInset);
        case "curved": return buildCurvedPath(srcNode, tgtNode, startInset, endInset);
        case "orthogonal":
        default: return buildOrthogonalPath(srcNode, tgtNode, startInset, endInset);
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
function isArrowStyle(s) {
    return s === "arrow";
}
function makeCapNode(style, color, width, size) {
    if (style === "none")
        return null;
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
    const node = isCircle
        ? figma.createEllipse()
        : figma.createRectangle();
    node.resize(size, size);
    if (hollow) {
        node.fills = [];
        node.strokes = [{ type: "SOLID", color }];
        node.strokeWeight = Math.max(1, width);
    }
    else {
        node.fills = [{ type: "SOLID", color }];
        node.strokes = [];
    }
    return node;
}
function positionCap(cap, center) {
    // Centered placement for symmetric shapes (circle, square).
    cap.x = center.x - cap.width / 2;
    cap.y = center.y - cap.height / 2;
}
function positionArrowCap(cap, tip, tangent, size) {
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
        [sin, cos, tip.y - rty]
    ];
}
function isVectorCap(style) {
    return style === "arrow";
}
async function paintLine(line, built, color, width) {
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
async function createConnector(source, target, defaults) {
    const built = buildPath(defaults.style, source, target, insetFor(defaults.startEnd, defaults.endSize), insetFor(defaults.endEnd, defaults.endSize));
    const line = figma.createVector();
    line.name = "line";
    await paintLine(line, built, defaults.color, defaults.width);
    const startCap = makeCapNode(defaults.startEnd, defaults.color, defaults.width, defaults.endSize);
    const endCap = makeCapNode(defaults.endEnd, defaults.color, defaults.width, defaults.endSize);
    if (startCap) {
        startCap.name = "start-cap";
        if (isVectorCap(defaults.startEnd)) {
            positionArrowCap(startCap, built.startPoint, built.startTangent, defaults.endSize);
        }
        else {
            positionCap(startCap, built.startPoint);
        }
    }
    if (endCap) {
        endCap.name = "end-cap";
        if (isVectorCap(defaults.endEnd)) {
            positionArrowCap(endCap, built.endPoint, built.endTangent, defaults.endSize);
        }
        else {
            positionCap(endCap, built.endPoint);
        }
    }
    // Group: line first so it renders under the caps.
    const children = [line];
    if (startCap)
        children.push(startCap);
    if (endCap)
        children.push(endCap);
    for (const child of children)
        figma.currentPage.appendChild(child);
    const group = figma.group(children, figma.currentPage);
    group.name = `Connector: ${source.name} → ${target.name}`;
    group.setPluginData(PLUGIN_DATA_KEY, "1");
    // Tag children too, so we can identify them on selection.
    line.setPluginData(PLUGIN_DATA_KEY, "child");
    if (startCap)
        startCap.setPluginData(PLUGIN_DATA_KEY, "child");
    if (endCap)
        endCap.setPluginData(PLUGIN_DATA_KEY, "child");
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
async function rerouteConnection(conn) {
    const group = await figma.getNodeByIdAsync(conn.id);
    const line = await figma.getNodeByIdAsync(conn.lineId);
    const source = await figma.getNodeByIdAsync(conn.source);
    const target = await figma.getNodeByIdAsync(conn.target);
    if (!group || group.type !== "GROUP")
        return false;
    if (!line || line.type !== "VECTOR")
        return false;
    if (!source || !target)
        return false;
    if (!("absoluteBoundingBox" in source) || !("absoluteBoundingBox" in target))
        return false;
    const built = buildPath(conn.style, source, target, insetFor(conn.startEnd, conn.endSize), insetFor(conn.endEnd, conn.endSize));
    await paintLine(line, built, conn.color, conn.width);
    if (conn.startCapId) {
        const cap = await figma.getNodeByIdAsync(conn.startCapId);
        if (cap && "x" in cap) {
            if (isVectorCap(conn.startEnd)) {
                positionArrowCap(cap, built.startPoint, built.startTangent, conn.endSize);
            }
            else {
                positionCap(cap, built.startPoint);
            }
        }
    }
    if (conn.endCapId) {
        const cap = await figma.getNodeByIdAsync(conn.endCapId);
        if (cap && "x" in cap) {
            if (isVectorCap(conn.endEnd)) {
                positionArrowCap(cap, built.endPoint, built.endTangent, conn.endSize);
            }
            else {
                positionCap(cap, built.endPoint);
            }
        }
    }
    return true;
}
async function restyleConnection(conn, patch) {
    // Apply patch and rebuild caps if their style changed.
    const next = Object.assign(Object.assign({}, conn), patch);
    const group = await figma.getNodeByIdAsync(next.id);
    if (!group || group.type !== "GROUP")
        return null;
    // For circles/squares, restyle in place when the primitive hasn't changed
    // (e.g. circle -> circle-hollow). For arrows or primitive changes, drop and
    // recreate the cap. Arrow vectors are easier to regenerate than to mutate
    // in place because their geometry depends on endSize.
    async function reconcileCap(side, oldStyle, newStyle, oldId) {
        const sameRoundOrSquare = oldStyle !== "none" && oldStyle !== "arrow" &&
            newStyle !== "none" && newStyle !== "arrow" &&
            capPrimitive(oldStyle) === capPrimitive(newStyle);
        if (sameRoundOrSquare && oldId) {
            const node = await figma.getNodeByIdAsync(oldId);
            if (node && "fills" in node) {
                applyCapStyle(node, newStyle, next.color, next.width, next.endSize);
            }
            return oldId;
        }
        if (oldId) {
            const node = await figma.getNodeByIdAsync(oldId);
            if (node)
                node.remove();
        }
        const fresh = makeCapNode(newStyle, next.color, next.width, next.endSize);
        if (!fresh)
            return null;
        fresh.name = side === "start" ? "start-cap" : "end-cap";
        fresh.setPluginData(PLUGIN_DATA_KEY, "child");
        group.appendChild(fresh);
        return fresh.id;
    }
    next.startCapId = await reconcileCap("start", conn.startEnd, next.startEnd, conn.startCapId);
    next.endCapId = await reconcileCap("end", conn.endEnd, next.endEnd, conn.endCapId);
    await rerouteConnection(next);
    return next;
}
function capPrimitive(style) {
    if (style === "circle" || style === "circle-hollow")
        return "circle";
    if (style === "square" || style === "square-hollow")
        return "square";
    return "none";
}
function applyCapStyle(node, style, color, width, size) {
    const hollow = style === "circle-hollow" || style === "square-hollow";
    node.resize(size, size);
    if (hollow) {
        node.fills = [];
        node.strokes = [{ type: "SOLID", color }];
        node.strokeWeight = Math.max(1, width);
    }
    else {
        node.fills = [{ type: "SOLID", color }];
        node.strokes = [];
    }
}
async function rerouteAll() {
    const list = loadConnections();
    const survivors = [];
    for (const conn of list) {
        const ok = await rerouteConnection(conn);
        if (ok)
            survivors.push(conn);
    }
    if (survivors.length !== list.length)
        saveConnections(survivors);
    return survivors.length;
}
// --- Live position polling --------------------------------------------------
//
// Figma doesn't fire a "node moved" event. To make connectors follow shapes
// during/right after a drag, we poll every 50ms: snapshot the absolute bounding
// box of every endpoint node, and reroute only the connectors whose source or
// target moved since the last tick.
const POLL_INTERVAL_MS = 50;
const lastBox = new Map(); // nodeId -> serialized bbox
let tickInProgress = false;
function bboxKey(node) {
    if (!node || !("absoluteBoundingBox" in node))
        return null;
    const b = node.absoluteBoundingBox;
    if (!b)
        return null;
    return `${b.x},${b.y},${b.width},${b.height}`;
}
async function pollTick() {
    if (tickInProgress)
        return;
    tickInProgress = true;
    try {
        const list = loadConnections();
        if (list.length === 0) {
            if (lastBox.size > 0)
                lastBox.clear();
            return;
        }
        // Collect every endpoint node id involved in any connection.
        const endpointIds = new Set();
        for (const conn of list) {
            endpointIds.add(conn.source);
            endpointIds.add(conn.target);
        }
        // Snapshot current bboxes and detect which ones changed.
        const moved = new Set();
        const aliveIds = new Set();
        for (const id of endpointIds) {
            const node = await figma.getNodeByIdAsync(id);
            const key = bboxKey(node);
            if (key === null)
                continue; // node deleted; rerouteConnection will prune
            aliveIds.add(id);
            const prev = lastBox.get(id);
            if (prev !== key) {
                moved.add(id);
                lastBox.set(id, key);
            }
        }
        // Drop stale entries (nodes that no longer exist).
        for (const id of Array.from(lastBox.keys())) {
            if (!aliveIds.has(id))
                lastBox.delete(id);
        }
        if (moved.size === 0)
            return;
        // Reroute only the connectors whose source or target moved.
        const survivors = [];
        let pruned = false;
        for (const conn of list) {
            if (moved.has(conn.source) || moved.has(conn.target)) {
                const ok = await rerouteConnection(conn);
                if (ok)
                    survivors.push(conn);
                else
                    pruned = true;
            }
            else {
                survivors.push(conn);
            }
        }
        if (pruned)
            saveConnections(survivors);
    }
    catch (err) {
        console.error("poll tick failed", err);
    }
    finally {
        tickInProgress = false;
    }
}
// --- Message handlers -------------------------------------------------------
function isOurNode(n) {
    const tag = n.getPluginData(PLUGIN_DATA_KEY);
    return tag === "1" || tag === "child";
}
/** Resolve the current selection to the set of connection IDs the user has
 *  picked. We accept a top-level group ("1") OR any tagged child ("child"),
 *  walking up to the group. */
function selectedConnectionIds() {
    const ids = new Set();
    for (const n of figma.currentPage.selection) {
        const tag = n.getPluginData(PLUGIN_DATA_KEY);
        if (tag === "1") {
            ids.add(n.id);
        }
        else if (tag === "child") {
            let cur = n.parent;
            while (cur) {
                if ("getPluginData" in cur && cur.getPluginData(PLUGIN_DATA_KEY) === "1") {
                    ids.add(cur.id);
                    break;
                }
                cur = cur.parent;
            }
        }
    }
    return ids;
}
async function handleConnect(defaults) {
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
async function handleDisconnect() {
    const list = loadConnections();
    const targetIds = selectedConnectionIds();
    const remaining = [];
    let removed = 0;
    for (const conn of list) {
        if (targetIds.has(conn.id)) {
            const node = await figma.getNodeByIdAsync(conn.id);
            if (node)
                node.remove();
            removed++;
        }
        else {
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
async function handleRefresh() {
    const n = await rerouteAll();
    figma.ui.postMessage({ type: "status", text: `Refreshed ${n} connector${n === 1 ? "" : "s"}.` });
}
/** Apply a style patch to currently-selected connectors. Returns the number
 *  of connectors mutated. */
async function applyStyleToSelection(patch) {
    const targetIds = selectedConnectionIds();
    if (targetIds.size === 0)
        return 0;
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
    if (changed > 0)
        saveConnections(list);
    return changed;
}
/** Build a snapshot of the current selection's connection styles for the UI.
 *  If a field varies across selected connectors, it's reported as `null`
 *  (the UI shows a "Mixed" placeholder). */
function selectionState() {
    const ids = selectedConnectionIds();
    if (ids.size === 0) {
        return { selectedCount: 0, style: null, startEnd: null, endEnd: null, color: null, width: null, endSize: null };
    }
    const list = loadConnections().filter((c) => ids.has(c.id));
    if (list.length === 0) {
        return { selectedCount: 0, style: null, startEnd: null, endEnd: null, color: null, width: null, endSize: null };
    }
    const first = list[0];
    let style = first.style;
    let startEnd = first.startEnd;
    let endEnd = first.endEnd;
    let color = first.color;
    let width = first.width;
    let endSize = first.endSize;
    for (const c of list) {
        if (c.style !== style)
            style = null;
        if (c.startEnd !== startEnd)
            startEnd = null;
        if (c.endEnd !== endEnd)
            endEnd = null;
        if (!color || c.color.r !== color.r || c.color.g !== color.g || c.color.b !== color.b)
            color = null;
        if (c.width !== width)
            width = null;
        if (c.endSize !== endSize)
            endSize = null;
    }
    return { selectedCount: list.length, style, startEnd, endEnd, color, width, endSize };
}
function postSelectionState() {
    const state = selectionState();
    figma.ui.postMessage(Object.assign({ type: "selection" }, state));
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
function dockBottomRight(w, h) {
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
function minimizeUI() {
    figma.ui.resize(MINI_W, MINI_H);
    dockBottomRight(MINI_W, MINI_H);
}
function expandUI() {
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
function normalizeDefaultsPatch(p) {
    const out = {};
    if (isLineStyle(p.style))
        out.style = p.style;
    if (isEndStyle(p.startEnd))
        out.startEnd = p.startEnd;
    if (isEndStyle(p.endEnd))
        out.endEnd = p.endEnd;
    if (p.color && typeof p.color.r === "number" && typeof p.color.g === "number" && typeof p.color.b === "number") {
        out.color = { r: p.color.r, g: p.color.g, b: p.color.b };
    }
    if (typeof p.width === "number" && p.width > 0)
        out.width = p.width;
    if (typeof p.endSize === "number" && p.endSize > 0)
        out.endSize = p.endSize;
    return out;
}
figma.ui.onmessage = async (msg) => {
    try {
        if (msg.type === "connect") {
            const cur = loadDefaults();
            await handleConnect(cur);
        }
        else if (msg.type === "refresh") {
            await handleRefresh();
        }
        else if (msg.type === "disconnect") {
            await handleDisconnect();
        }
        else if (msg.type === "setStyle") {
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
            }
            else {
                const cur = loadDefaults();
                saveDefaults(Object.assign(Object.assign({}, cur), patch));
            }
        }
        else if (msg.type === "minimize") {
            minimizeUI();
        }
        else if (msg.type === "expand") {
            expandUI();
        }
    }
    catch (err) {
        console.error(err);
        figma.ui.postMessage({ type: "status", text: `Error: ${err.message}` });
    }
};
