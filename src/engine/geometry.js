/**
 * @module geometry
 * Pure spatial math.
 *
 * Shared mathematical foundation for coordinate conversion, polygon math,
 * visibility/occlusion tests, and world-sprite dimension calculations.
 *
 * Deterministic spatial transformations only, never authored schema
 * interpretation or runtime state.
 *
 * Safe to import broadly across runtime, rendering, debug tooling,
 * and design tooling.
 */

export function clamp(val, min, max) {
  return Math.min(Math.max(val, min), max);
}

/**
 * Interpolates the depth-scale factor at `y` between two reference points
 * (`near`/`far`, each `{ y, scale }`), clamped to the span between them.
 *
 * Single-sources the near/far scaling formula shared by the runtime renderer
 * and the design-tool preview so the two cannot drift. Returns `near.scale`
 * when the poles coincide, avoiding a divide-by-zero.
 */
export function depthScaleAtY(y, near, far) {
  if (near.y === far.y) return near.scale;
  const t = clamp((y - far.y) / (near.y - far.y), 0, 1);
  return far.scale + (near.scale - far.scale) * t;
}

/**
 * Rendered sprite dimensions at scale 1.0, from raw image dimensions and the
 * sheet grid. `authoredHeight` sets the render height directly, with width
 * preserving the frame's aspect; absent, the frame's natural height is used.
 *
 * @returns {{ w: number, h: number, frameW: number, frameH: number }} The
 * destination size (`w`/`h`) and the source crop (`frameW`/`frameH`), so one
 * call sizes both.
 */
export function worldSpriteSize(imgW, imgH, columns, rows, authoredHeight) {
  const cols = columns || 1;
  const rws = rows || 1;
  const frameW = imgW / cols;
  const frameH = imgH / rws;
  const h = (authoredHeight !== undefined && authoredHeight > 0) ? authoredHeight : Math.round(frameH);
  const w = frameH > 0 ? Math.round(h * frameW / frameH) : Math.round(frameW);
  return { w, h, frameW: Math.round(frameW), frameH: Math.round(frameH) };
}

// A Bounds is an axis-aligned box given as min/max coordinates —
// `{ minX, maxX, minY, maxY }`, not the `{ x, y, w, h }` form.

/**
 * Axis-aligned bounds of a sprite drawn at a bottom-center anchor, with
 * `offset` and `scale` folded in so the bounds track where the sprite is
 * actually drawn. Returned in the same shape as `polygonBounds` so
 * sprite-derived consumers — hit-testing (`scene.js`) and scan-marker
 * placement (`render.js`) — reuse one rule across sprite and hotspot
 * entities. Authored hotspots stay independent of the sprite.
 *
 * @returns {Bounds} Axis-aligned bounds enclosing the sprite as drawn.
 */
export function spriteBounds(anchorX, anchorY, w, h, offsetX, offsetY, scale) {
  const halfW = (w * scale) / 2;
  const cx = anchorX + offsetX * scale;
  const bottom = anchorY + offsetY * scale;
  return { minX: cx - halfW, maxX: cx + halfW, minY: bottom - h * scale, maxY: bottom };
}

/** @returns {Bounds} Axis-aligned bounds enclosing the list of `[x, y]` points. */
export function polygonBounds(points) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < points.length; i++) {
    if (points[i][0] < minX) minX = points[i][0];
    if (points[i][0] > maxX) maxX = points[i][0];
    if (points[i][1] < minY) minY = points[i][1];
    if (points[i][1] > maxY) maxY = points[i][1];
  }
  return { minX, maxX, minY, maxY };
}

/**
 * Projects `(px, py)` onto segment a→b, clamped to the segment. A zero-length
 * segment projects onto its own endpoint.
 *
 * @returns {{ x: number, y: number, t: number, distSq: number }} The closest
 * point on the segment, its position along a→b as `t` in 0..1, and its squared
 * distance from `(px, py)`.
 */
export function closestPointOnSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq > 0 ? clamp(((px - ax) * dx + (py - ay) * dy) / lenSq, 0, 1) : 0;
  const x = ax + t * dx, y = ay + t * dy;
  return { x, y, t, distSq: (px - x) * (px - x) + (py - y) * (py - y) };
}

export function screenToNative(sx, sy, rect, worldHeight) {
  const scale = rect.height / worldHeight;
  return { x: (sx - rect.left) / scale, y: (sy - rect.top) / scale };
}

export function nativeToScreen(nx, ny, rect, worldHeight) {
  const scale = rect.height / worldHeight;
  return { x: nx * scale + rect.left, y: ny * scale + rect.top };
}

/**
 * Adds a polygon as a subpath to the current canvas path. Caller owns
 * `beginPath`, `fill`, `stroke`, `clip`.
 *
 * `close=false` is used for polygons-in-progress that the caller has not
 * yet closed.
 */
export function addPolygonSubpath(ctx, points, rect, worldHeight, close = true) {
  if (points.length < 1) return;
  const first = nativeToScreen(points[0][0], points[0][1], rect, worldHeight);
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < points.length; i++) {
    const p = nativeToScreen(points[i][0], points[i][1], rect, worldHeight);
    ctx.lineTo(p.x, p.y);
  }
  if (close) ctx.closePath();
}

export function pointInPolygon(x, y, points) {
  let inside = false;
  const n = points.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = points[i][0], yi = points[i][1];
    const xj = points[j][0], yj = points[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Returns true if segment AB strictly intersects segment CD (not at endpoints).
 *
 * Epsilon of 1e-6 sits well above floating-point noise (~1e-10) for coordinates
 * in the 0–800 range, avoiding false positives at shared polygon vertices.
 */
function segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const d1x = bx - ax, d1y = by - ay;
  const d2x = dx - cx, d2y = dy - cy;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-10) return false; // parallel / collinear
  const t = ((cx - ax) * d2y - (cy - ay) * d2x) / denom;
  const u = ((cx - ax) * d1y - (cy - ay) * d1x) / denom;
  return t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6;
}

/**
 * Returns the closed polygons that a horizontal segment (x1..x2 at height y)
 * overlaps. Unclosed polygons are excluded.
 *
 * Used for actor-vs-occluder checks: both the game's renderer and the design
 * tool's preview character share this so occlusion is identical in both.
 */
export function polygonsAtSegment(x1, x2, y, polygons) {
  return polygons.filter(function (poly) {
    if (poly.closed === false) return false;
    const pts = poly.points;
    const n = pts.length;
    if (pointInPolygon(x1, y, pts) ||
        pointInPolygon(x2, y, pts) ||
        pointInPolygon((x1 + x2) / 2, y, pts)) return true;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      if (segmentsIntersect(x1, y, x2, y, pts[j][0], pts[j][1], pts[i][0], pts[i][1])) return true;
    }
    return false;
  });
}
