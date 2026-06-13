"use strict";
/// <reference types="@figma/plugin-typings" />
const LINE_STYLES = ["orthogonal", "curved", "straight"];
const END_STYLES = [
    "none", "arrow", "circle", "square", "circle-hollow", "square-hollow",
    "semi-circle", "semi-circle-hollow"
];
function isLineStyle(v) {
    return typeof v === "string" && LINE_STYLES.includes(v);
}
function isEndStyle(v) {
    return typeof v === "string" && END_STYLES.includes(v);
}
const PLUGIN_DATA_KEY = "shape-connector-meta";
const ROOT_CONNECTIONS_KEY = "shape-connector-connections";
const ROOT_DEFAULTS_KEY = "shape-connector-defaults";
const ROOT_STYLES_KEY = "shape-connector-styles";
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
        return (file.connections || []).map((c) => (Object.assign(Object.assign({}, c), { endSize: typeof c.endSize === "number" ? c.endSize : DEFAULT_END_SIZE, labelId: typeof c.labelId === "string" ? c.labelId : null, labelBgId: typeof c.labelBgId === "string" ? c.labelBgId : null })));
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
function loadSavedStyles() {
    const raw = figma.root.getPluginData(ROOT_STYLES_KEY);
    if (!raw)
        return [];
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || !Array.isArray(parsed.styles))
            return [];
        return parsed.styles;
    }
    catch (_a) {
        return [];
    }
}
function saveSavedStyles(list) {
    const file = { version: 1, styles: list };
    figma.root.setPluginData(ROOT_STYLES_KEY, JSON.stringify(file));
}
/** Short pseudo-random id for saved styles. The space is small but unique
 *  enough — collisions would only matter if a user manually edits storage. */
function newStyleId() {
    return "s_" + Math.random().toString(36).slice(2, 10);
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
        endTangent: spec.endTangent,
        midPoint: spec.midPoint
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
    // Fallback for shapes without extractable geometry (groups, frames without
    // a fill, etc.). Pick the bbox side facing the target — by whichever axis
    // dominates the centroid-to-target vector — and use that side's midpoint
    // with an axis-aligned inward tangent. This matches how rectangles attach,
    // so the curved path doesn't degenerate to a straight line for groups
    // (which would happen if inward followed the center-to-center diagonal).
    const box = rectFor(node);
    const dx = towards.x - box.cx;
    const dy = towards.y - box.cy;
    const side = Math.abs(dx) >= Math.abs(dy)
        ? (dx >= 0 ? "right" : "left")
        : (dy >= 0 ? "bottom" : "top");
    return { point: anchorOn(box, side), inward: sideInwardTangent(side) };
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
        endTangent,
        midPoint: { x: (paLine.x + pbLine.x) / 2, y: (paLine.y + pbLine.y) / 2 }
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
/** Coordinates where the outline crosses an axis-aligned center line.
 *  For horizontal=true we scan the line y=axisValue and return the x of every
 *  crossing; for horizontal=false we scan x=axisValue and return crossing y's.
 *  Cubic segments are flattened into short line chords before testing. */
function axisCrossings(segments, horizontal, axisValue) {
    const out = [];
    function lineCross(a, b) {
        const av = horizontal ? a.y : a.x;
        const bv = horizontal ? b.y : b.x;
        const denom = bv - av;
        if (Math.abs(denom) < 1e-9)
            return; // parallel to the scan line; skip
        const t = (axisValue - av) / denom;
        if (t < 0 || t > 1)
            return;
        out.push(horizontal ? a.x + t * (b.x - a.x) : a.y + t * (b.y - a.y));
    }
    for (const seg of segments) {
        if (seg.kind === "line") {
            lineCross(seg.a, seg.b);
        }
        else {
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
function orthogonalSidePoint(node, box, side) {
    const segments = nodeOutlineSegments(node);
    if (segments.length === 0)
        return null;
    const horizontal = side === "left" || side === "right";
    const axisValue = horizontal ? box.cy : box.cx; // scan line through the center
    const base = horizontal ? box.cx : box.cy; // center coord along the ray
    const dir = side === "left" || side === "top" ? -1 : 1;
    let best = null;
    for (const c of axisCrossings(segments, horizontal, axisValue)) {
        const signed = (c - base) * dir; // distance from center toward the side
        if (signed <= 0.01)
            continue; // crossing is on the wrong side
        if (best === null || signed > best)
            best = signed;
    }
    if (best === null)
        return null;
    const coord = base + dir * best;
    return horizontal ? { x: coord, y: box.cy } : { x: box.cx, y: coord };
}
function buildOrthogonalPath(srcNode, tgtNode, startInset, endInset) {
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
        endTangent,
        // The orthogonal route has a horizontal-vertical-horizontal (or v-h-v)
        // shape; its visual midpoint is the middle of the elbow segment v2→v3.
        midPoint: { x: (v2.x + v3.x) / 2, y: (v2.y + v3.y) / 2 }
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
        endTangent,
        midPoint: cubicAt(paLine, c1, c2, pbLine, 0.5)
    });
}
function insetFor(style, endSize) {
    // Arrows occupy endSize along their axis (tip at the shape edge, base
    // endSize back along the line). Semi-circles sit flush at the shape edge
    // and bulge outward by endSize/2 (the radius), so the line should stop at
    // the dome's apex. Circles and squares are centered on the endpoint and
    // visually cover the meeting point, so no inset is needed.
    if (style === "arrow")
        return endSize;
    if (style === "semi-circle" || style === "semi-circle-hollow")
        return endSize / 2;
    return 0;
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
                data: `M 0 0 ` +
                    `C ${k} 0 ${size / 2} ${size / 2 - k} ${size / 2} ${size / 2} ` +
                    `C ${size / 2} ${size / 2 + k} ${k} ${size} 0 ${size} Z`
            }];
        if (style === "semi-circle-hollow") {
            semi.fills = [];
            semi.strokes = [{ type: "SOLID", color }];
            semi.strokeWeight = Math.max(1, width);
        }
        else {
            semi.fills = [{ type: "SOLID", color }];
            semi.strokes = [];
        }
        return semi;
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
function positionSemicircleCap(cap, anchor, inward, size) {
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
        [sin, cos, anchor.y - cos * size / 2]
    ];
}
function isVectorCap(style) {
    return style === "arrow" || style === "semi-circle" || style === "semi-circle-hollow";
}
function positionVectorCap(cap, style, anchor, inward, size) {
    if (style === "semi-circle" || style === "semi-circle-hollow") {
        positionSemicircleCap(cap, anchor, inward, size);
    }
    else {
        positionArrowCap(cap, anchor, inward, size);
    }
}
// --- Labels -----------------------------------------------------------------
const LABEL_FONT = { family: "Inter", style: "Regular" };
const LABEL_INITIAL = "Label";
const LABEL_DEFAULT_SIZE = 12;
// Pill padding around the text bbox + corner radius.
const LABEL_PILL_PAD_X = 6;
const LABEL_PILL_PAD_Y = 3;
const LABEL_PILL_RADIUS = 4;
let labelFontPromise = null;
function ensureLabelFont() {
    if (!labelFontPromise)
        labelFontPromise = figma.loadFontAsync(LABEL_FONT);
    return labelFontPromise;
}
/** Place the text so its bbox center sits at `mid`. */
function positionLabel(label, mid) {
    label.x = mid.x - label.width / 2;
    label.y = mid.y - label.height / 2;
}
/** Resize the pill rect to wrap the current text bbox + padding, centered on
 *  the same midpoint as the text. */
function positionLabelPill(pill, label, mid) {
    const w = label.width + LABEL_PILL_PAD_X * 2;
    const h = label.height + LABEL_PILL_PAD_Y * 2;
    pill.resize(Math.max(w, 1), Math.max(h, 1));
    pill.x = mid.x - w / 2;
    pill.y = mid.y - h / 2;
}
async function createLabelForConnection(conn) {
    const group = await figma.getNodeByIdAsync(conn.id);
    if (!group || group.type !== "GROUP")
        return null;
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
    group.appendChild(pill);
    const label = figma.createText();
    label.name = "label";
    label.fontName = LABEL_FONT;
    label.fontSize = LABEL_DEFAULT_SIZE;
    label.characters = LABEL_INITIAL;
    // Black on canvas — readable on most backgrounds; user can recolor via
    // Figma's native text panel after selecting.
    label.fills = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }];
    label.setPluginData(PLUGIN_DATA_KEY, "child");
    group.appendChild(label);
    return { labelId: label.id, bgId: pill.id };
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
            positionVectorCap(startCap, defaults.startEnd, built.startPoint, built.startTangent, defaults.endSize);
        }
        else {
            positionCap(startCap, built.startPoint);
        }
    }
    if (endCap) {
        endCap.name = "end-cap";
        if (isVectorCap(defaults.endEnd)) {
            positionVectorCap(endCap, defaults.endEnd, built.endPoint, built.endTangent, defaults.endSize);
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
                positionVectorCap(cap, conn.startEnd, built.startPoint, built.startTangent, conn.endSize);
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
                positionVectorCap(cap, conn.endEnd, built.endPoint, built.endTangent, conn.endSize);
            }
            else {
                positionCap(cap, built.endPoint);
            }
        }
    }
    if (conn.labelId) {
        const label = await figma.getNodeByIdAsync(conn.labelId);
        if (label && label.type === "TEXT") {
            positionLabel(label, built.midPoint);
            if (conn.labelBgId) {
                const pill = await figma.getNodeByIdAsync(conn.labelBgId);
                if (pill && pill.type === "RECTANGLE") {
                    positionLabelPill(pill, label, built.midPoint);
                }
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
        // In-place restyle only applies to the ellipse/rectangle caps. Semi-circle
        // caps are vectors (capPrimitive "none"), so they fall through to recreate.
        const sameRoundOrSquare = capPrimitive(oldStyle) !== "none" &&
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
    const shapeIds = new Set();
    for (const n of figma.currentPage.selection) {
        const tag = n.getPluginData(PLUGIN_DATA_KEY);
        if (tag === "1") {
            // Connector group selected directly.
            ids.add(n.id);
        }
        else if (tag === "child") {
            // A child of a connector group (line or cap) — walk up to its group.
            let cur = n.parent;
            while (cur) {
                if ("getPluginData" in cur && cur.getPluginData(PLUGIN_DATA_KEY) === "1") {
                    ids.add(cur.id);
                    break;
                }
                cur = cur.parent;
            }
        }
        else {
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
// --- Saved styles -----------------------------------------------------------
/** Subset of the selection containing only DIRECTLY selected connectors —
 *  the Save Style button considers attached shapes as ignorable noise per the
 *  feature spec. */
function directlySelectedConnectionIds() {
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
/** True iff Save Style should be available right now. */
function canSaveStyleNow() {
    const sel = figma.currentPage.selection;
    if (sel.length === 0)
        return true;
    // Anything directly selected that's a connector enables saving its style;
    // a selection of ONLY non-connectors disables the button.
    return directlySelectedConnectionIds().size > 0;
}
async function extractTextProps(textId) {
    if (!textId)
        return null;
    const node = await figma.getNodeByIdAsync(textId);
    if (!node || node.type !== "TEXT")
        return null;
    const t = node;
    // Mixed values (font, size, color across different runs) are skipped — we
    // store style as a single applied set.
    if (typeof t.fontSize !== "number")
        return null;
    if (typeof t.fontName !== "object" || !("family" in t.fontName))
        return null;
    const fills = t.fills;
    let color = null;
    if (Array.isArray(fills)) {
        for (const f of fills) {
            if (f.type === "SOLID") {
                color = { r: f.color.r, g: f.color.g, b: f.color.b };
                break;
            }
        }
    }
    if (!color)
        return null;
    return {
        fontFamily: t.fontName.family,
        fontStyle: t.fontName.style,
        fontSize: t.fontSize,
        color
    };
}
function savedStyleFromConnection(conn, text) {
    return {
        id: newStyleId(),
        style: conn.style,
        startEnd: conn.startEnd,
        endEnd: conn.endEnd,
        color: conn.color,
        width: conn.width,
        endSize: conn.endSize,
        text
    };
}
function savedStyleFromDefaults(d) {
    return {
        id: newStyleId(),
        style: d.style,
        startEnd: d.startEnd,
        endEnd: d.endEnd,
        color: d.color,
        width: d.width,
        endSize: d.endSize,
        text: null
    };
}
async function handleSaveStyle() {
    const directIds = directlySelectedConnectionIds();
    const saved = loadSavedStyles();
    let addedCount = 0;
    if (directIds.size > 0) {
        const conns = loadConnections().filter((c) => directIds.has(c.id));
        for (const conn of conns) {
            const text = await extractTextProps(conn.labelId);
            saved.push(savedStyleFromConnection(conn, text));
            addedCount++;
        }
    }
    else if (figma.currentPage.selection.length === 0) {
        saved.push(savedStyleFromDefaults(loadDefaults()));
        addedCount = 1;
    }
    else {
        // Only non-connector items selected — button should have been disabled.
        figma.ui.postMessage({ type: "status", text: "Select a connector or nothing to save a style." });
        return;
    }
    saveSavedStyles(saved);
    postStyles();
    figma.ui.postMessage({
        type: "status",
        text: `Saved ${addedCount} style${addedCount === 1 ? "" : "s"}.`
    });
}
async function handleDeleteStyle(id) {
    const saved = loadSavedStyles().filter((s) => s.id !== id);
    saveSavedStyles(saved);
    postStyles();
}
/** Apply a saved style. If connectors are in scope (including shape-attached),
 *  mutate those; otherwise update defaults. Text properties only apply to
 *  connectors that have an existing label. */
async function handleApplyStyle(id) {
    const saved = loadSavedStyles().find((s) => s.id === id);
    if (!saved)
        return;
    const patch = {
        style: saved.style,
        startEnd: saved.startEnd,
        endEnd: saved.endEnd,
        color: saved.color,
        width: saved.width,
        endSize: saved.endSize
    };
    const targetIds = selectedConnectionIds();
    if (targetIds.size > 0) {
        await applyStyleToSelection(patch);
        if (saved.text) {
            await applySavedTextToSelection(saved.text, targetIds);
        }
    }
    else {
        const cur = loadDefaults();
        saveDefaults(Object.assign(Object.assign({}, cur), patch));
    }
    postSelectionState();
}
async function applySavedTextToSelection(text, ids) {
    const list = loadConnections();
    await figma.loadFontAsync({ family: text.fontFamily, style: text.fontStyle });
    for (const conn of list) {
        if (!ids.has(conn.id) || !conn.labelId)
            continue;
        const node = await figma.getNodeByIdAsync(conn.labelId);
        if (!node || node.type !== "TEXT")
            continue;
        const t = node;
        t.fontName = { family: text.fontFamily, style: text.fontStyle };
        t.fontSize = text.fontSize;
        t.fills = [{ type: "SOLID", color: text.color }];
    }
}
function postStyles() {
    figma.ui.postMessage({ type: "styles", styles: loadSavedStyles() });
}
async function handleAddLabel() {
    const targetIds = selectedConnectionIds();
    if (targetIds.size === 0) {
        figma.ui.postMessage({ type: "status", text: "Select a connector to label." });
        return;
    }
    const list = loadConnections();
    let added = 0;
    let alreadyLabeled = 0;
    for (let i = 0; i < list.length; i++) {
        if (!targetIds.has(list[i].id))
            continue;
        if (list[i].labelId) {
            const existing = await figma.getNodeByIdAsync(list[i].labelId);
            if (existing && existing.type === "TEXT") {
                alreadyLabeled++;
                continue;
            }
        }
        const created = await createLabelForConnection(list[i]);
        if (!created)
            continue;
        list[i] = Object.assign(Object.assign({}, list[i]), { labelId: created.labelId, labelBgId: created.bgId });
        // rerouteConnection recomputes the midpoint and places both text and pill.
        await rerouteConnection(list[i]);
        added++;
    }
    if (added > 0)
        saveConnections(list);
    figma.ui.postMessage({
        type: "status",
        text: added > 0
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
async function handleRemoveLabel() {
    const targetIds = selectedConnectionIds();
    if (targetIds.size === 0) {
        figma.ui.postMessage({ type: "status", text: "Select a connector first." });
        return;
    }
    const list = loadConnections();
    let removed = 0;
    for (let i = 0; i < list.length; i++) {
        if (!targetIds.has(list[i].id))
            continue;
        const labelId = list[i].labelId;
        const bgId = list[i].labelBgId;
        if (!labelId && !bgId)
            continue;
        if (labelId) {
            const node = await figma.getNodeByIdAsync(labelId);
            if (node)
                node.remove();
        }
        if (bgId) {
            const pill = await figma.getNodeByIdAsync(bgId);
            if (pill)
                pill.remove();
        }
        list[i] = Object.assign(Object.assign({}, list[i]), { labelId: null, labelBgId: null });
        removed++;
    }
    if (removed > 0)
        saveConnections(list);
    figma.ui.postMessage({
        type: "status",
        text: removed > 0 ? `Removed label from ${removed} connector${removed === 1 ? "" : "s"}.` : "No labels to remove."
    });
    postSelectionState();
}
/** Remove labels whose text is empty. Returns the number of connections
 *  mutated so the caller knows whether to persist. */
async function cleanupEmptyLabels() {
    const list = loadConnections();
    let mutated = 0;
    for (let i = 0; i < list.length; i++) {
        const labelId = list[i].labelId;
        const bgId = list[i].labelBgId;
        if (!labelId && !bgId)
            continue;
        const labelNode = labelId ? await figma.getNodeByIdAsync(labelId) : null;
        const isTextLive = labelNode && labelNode.type === "TEXT";
        const isEmpty = isTextLive && labelNode.characters.length === 0;
        if (!labelNode || !isTextLive || isEmpty) {
            // Remove pill alongside the text whenever the label is dead or empty.
            if (isTextLive && isEmpty)
                labelNode.remove();
            if (bgId) {
                const pill = await figma.getNodeByIdAsync(bgId);
                if (pill)
                    pill.remove();
            }
            list[i] = Object.assign(Object.assign({}, list[i]), { labelId: null, labelBgId: null });
            mutated++;
        }
    }
    if (mutated > 0)
        saveConnections(list);
    return mutated;
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
    const canSaveStyle = canSaveStyleNow();
    if (ids.size === 0) {
        return { selectedCount: 0, style: null, startEnd: null, endEnd: null, color: null, width: null, endSize: null, allLabeled: false, canSaveStyle };
    }
    const list = loadConnections().filter((c) => ids.has(c.id));
    if (list.length === 0) {
        return { selectedCount: 0, style: null, startEnd: null, endEnd: null, color: null, width: null, endSize: null, allLabeled: false, canSaveStyle };
    }
    const first = list[0];
    let style = first.style;
    let startEnd = first.startEnd;
    let endEnd = first.endEnd;
    let color = first.color;
    let width = first.width;
    let endSize = first.endSize;
    let allLabeled = true;
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
        if (!c.labelId)
            allLabeled = false;
    }
    return { selectedCount: list.length, style, startEnd, endEnd, color, width, endSize, allLabeled, canSaveStyle };
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
const FULL_H = 560;
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
postStyles();
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
        else if (msg.type === "disconnect") {
            await handleDisconnect();
        }
        else if (msg.type === "addLabel") {
            await handleAddLabel();
        }
        else if (msg.type === "removeLabel") {
            await handleRemoveLabel();
        }
        else if (msg.type === "saveStyle") {
            await handleSaveStyle();
        }
        else if (msg.type === "applyStyle") {
            if (typeof msg.id === "string")
                await handleApplyStyle(msg.id);
        }
        else if (msg.type === "deleteStyle") {
            if (typeof msg.id === "string")
                await handleDeleteStyle(msg.id);
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
