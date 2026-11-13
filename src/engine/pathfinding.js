/**
 * @module pathfinding
 * Navigation and walkability math.
 *
 * Computes walkability, nearest valid points, and traversal paths across
 * authored walkable geometry.
 *
 * Operates only on the polygon data it is handed, so it owns no actor or
 * rendering state.
 */

import { pointInPolygon, clamp, closestPointOnSegment } from './geometry.js';

// ══ Point walkability ════════════════════

/**
 * Returns true if `(x, y)` falls inside any walkable polygon.
 *
 * When `walkablePolygons` is empty, returns true unconditionally — no
 * authored walkable geometry means everywhere is walkable.
 */
export function isWalkable(x, y, walkablePolygons) {
  if (walkablePolygons.length === 0) return true;
  for (let i = 0; i < walkablePolygons.length; i++) {
    if (pointInPolygon(x, y, walkablePolygons[i].points)) return true;
  }
  return false;
}

/**
 * Returns the closest point on any walkable polygon edge to `(x, y)`.
 * Returns `null` when `walkablePolygons` is empty.
 */
export function nearestWalkablePoint(x, y, walkablePolygons) {
  let bestDist = Infinity;
  let bestPt = null;
  walkablePolygons.forEach(function (poly) {
    const pts = poly.points;
    const n = pts.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const c = closestPointOnSegment(x, y, pts[j][0], pts[j][1], pts[i][0], pts[i][1]);
      if (c.distSq < bestDist) { bestDist = c.distSq; bestPt = { x: c.x, y: c.y }; }
    }
  });
  return bestPt;
}

// ══ Segment walkability ══════════════════
//
// A segment is walkable when every stretch between its boundary crossings
// lies inside the walkable area: the segment is split at each crossing and
// the midpoint of every resulting stretch is tested. Points on a polygon
// edge count as walkable here — snapped clicks and polygon-vertex waypoints
// sit exactly on edges, and a strict test would reject every path through
// them. The exported `isWalkable` stays strict; callers use it to decide
// whether a point needs snapping at all.

// Distance within which a point counts as on a polygon edge, in scene
// pixels. Paths may cut corners by up to about twice this value.
const EDGE_EPS = 0.75;

// `isWalkable` with the boundary included: also true within EDGE_EPS of any
// polygon edge.
function isWalkableInclusive(x, y, walkablePolygons) {
  if (isWalkable(x, y, walkablePolygons)) return true;
  for (let p = 0; p < walkablePolygons.length; p++) {
    const pts = walkablePolygons[p].points;
    const n = pts.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const c = closestPointOnSegment(x, y, pts[j][0], pts[j][1], pts[i][0], pts[i][1]);
      if (c.distSq <= EDGE_EPS * EDGE_EPS) return true;
    }
  }
  return false;
}

// Parametric intersection of segment a→b with segment c→d: t on a→b with
// endpoints included, or null when the segments are parallel or miss.
// Collinear overlap intentionally yields null: a shared collinear seam has
// its corners at polygon vertices (already graph nodes), and stretches along
// it classify through the boundary-inclusive midpoint tests.
function segmentParam(ax, ay, bx, by, cx, cy, dx, dy) {
  const rX = bx - ax, rY = by - ay;
  const sX = dx - cx, sY = dy - cy;
  const denom = rX * sY - rY * sX;
  if (Math.abs(denom) < 1e-6) return null;
  const t = ((cx - ax) * sY - (cy - ay) * sX) / denom;
  const u = ((cx - ax) * rY - (cy - ay) * rX) / denom;
  if (t < -1e-6 || t > 1 + 1e-6 || u < -1e-6 || u > 1 + 1e-6) return null;
  return clamp(t, 0, 1);
}

function isSegmentWalkable(x1, y1, x2, y2, walkablePolygons) {
  // A segment threading just past a corner can enter and leave a pocket
  // between two crossings that intersection tests miss numerically, so the
  // closest approach to every nearby vertex becomes a split point too. The
  // 3px radius deliberately sits well above EDGE_EPS so a graze dipping
  // deeper than the boundary tolerance still gets a test point in the pocket.
  const NEAR_VERTEX_SQ = 9;
  const dx = x2 - x1, dy = y2 - y1;
  const splits = [0, 1];
  for (let p = 0; p < walkablePolygons.length; p++) {
    const pts = walkablePolygons[p].points;
    const n = pts.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const t = segmentParam(x1, y1, x2, y2, pts[j][0], pts[j][1], pts[i][0], pts[i][1]);
      if (t !== null) splits.push(t);
    }
    for (let i = 0; i < n; i++) {
      const c = closestPointOnSegment(pts[i][0], pts[i][1], x1, y1, x2, y2);
      if (c.distSq < NEAR_VERTEX_SQ) splits.push(c.t);
    }
  }

  splits.sort((a, b) => a - b);
  for (let i = 1; i < splits.length; i++) {
    if (splits[i] - splits[i - 1] < 1e-6) continue;
    const tm = (splits[i] + splits[i - 1]) / 2;
    if (!isWalkableInclusive(x1 + dx * tm, y1 + dy * tm, walkablePolygons)) return false;
  }
  return true;
}

// ══ Path search ══════════════════════════
//
// Paths are found on a visibility graph: candidate bend points, connected
// wherever the straight segment between two of them is walkable. A* returns
// the shortest node chain; simplification then drops every node the path
// can skip in a straight line, leaving only the necessary turns.

// Visibility-graph candidates: every polygon vertex, plus the crossing
// points between edges of different polygons. Overlapping polygons join
// into one walkable region, and edge crossings provide additional places
// where a shortest route may bend.
function graphNodes(walkablePolygons) {
  const nodes = [];
  walkablePolygons.forEach(function (poly) {
    poly.points.forEach(function (pt) { nodes.push({ x: pt[0], y: pt[1] }); });
  });
  for (let a = 0; a < walkablePolygons.length; a++) {
    for (let b = a + 1; b < walkablePolygons.length; b++) {
      const pa = walkablePolygons[a].points, pb = walkablePolygons[b].points;
      for (let i = 0, j = pa.length - 1; i < pa.length; j = i++) {
        for (let k = 0, l = pb.length - 1; k < pb.length; l = k++) {
          const t = segmentParam(pa[j][0], pa[j][1], pa[i][0], pa[i][1], pb[l][0], pb[l][1], pb[k][0], pb[k][1]);
          if (t !== null) {
            nodes.push({ x: pa[j][0] + t * (pa[i][0] - pa[j][0]), y: pa[j][1] + t * (pa[i][1] - pa[j][1]) });
          }
        }
      }
    }
  }
  return nodes;
}

// Straightens a node chain by jumping from each waypoint to the farthest
// later waypoint reachable in a straight line.
function simplifyPath(path, walkablePolygons) {
  if (path.length <= 2) return path;
  const result = [path[0]];
  let i = 0;
  while (i < path.length - 1) {
    let j = path.length - 1;
    while (j > i + 1 && !isSegmentWalkable(path[i].x, path[i].y, path[j].x, path[j].y, walkablePolygons)) j--;
    result.push(path[j]);
    i = j;
  }
  return result;
}

/**
 * Returns the waypoints to walk from `(sx, sy)` to `(ex, ey)` across the
 * walkable polygons, excluding the start point — callers move the actor to
 * each returned waypoint in order.
 *
 * Returns `[]` both when the start is already at the end and when no path
 * exists; callers cannot distinguish "already there" from "unreachable" by
 * return value alone — both mean "don't move".
 *
 * Short-circuits to `[{x: ex, y: ey}]` when the direct line from start to
 * end is walkable.
 */
export function findPath(sx, sy, ex, ey, walkablePolygons) {
  const ddx = ex - sx, ddy = ey - sy;
  if (ddx * ddx + ddy * ddy < 1e-6) return [];
  if (walkablePolygons.length === 0) return [{ x: ex, y: ey }];
  if (isSegmentWalkable(sx, sy, ex, ey, walkablePolygons)) return [{ x: ex, y: ey }];

  const nodes = graphNodes(walkablePolygons);
  const startIdx = nodes.length; nodes.push({ x: sx, y: sy });
  const endIdx = nodes.length; nodes.push({ x: ex, y: ey });
  const n = nodes.length;

  const edges = [];
  for (let i = 0; i < n; i++) edges.push([]);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (isSegmentWalkable(nodes[i].x, nodes[i].y, nodes[j].x, nodes[j].y, walkablePolygons)) {
        const dx = nodes[j].x - nodes[i].x;
        const dy = nodes[j].y - nodes[i].y;
        const d = Math.sqrt(dx * dx + dy * dy);
        edges[i].push({ to: j, d });
        edges[j].push({ to: i, d });
      }
    }
  }

  function h(idx) {
    const dx = nodes[idx].x - nodes[endIdx].x;
    const dy = nodes[idx].y - nodes[endIdx].y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  const open = [startIdx];
  const g = new Array(n).fill(Infinity);
  const f = new Array(n).fill(Infinity);
  const prev = new Array(n).fill(-1);
  const closed = new Array(n).fill(false);
  g[startIdx] = 0;
  f[startIdx] = h(startIdx);

  while (open.length > 0) {
    let ci = 0;
    for (let i = 1; i < open.length; i++) {
      if (f[open[i]] < f[open[ci]]) ci = i;
    }
    const cur = open[ci];
    open.splice(ci, 1);

    if (cur === endIdx) {
      const path = [];
      let c = endIdx;
      while (c !== -1) { path.unshift(nodes[c]); c = prev[c]; }
      return simplifyPath(path, walkablePolygons).slice(1);
    }

    closed[cur] = true;
    edges[cur].forEach(function (e) {
      if (closed[e.to]) return;
      const tg = g[cur] + e.d;
      if (tg < g[e.to]) {
        prev[e.to] = cur;
        g[e.to] = tg;
        f[e.to] = tg + h(e.to);
        if (open.indexOf(e.to) === -1) open.push(e.to);
      }
    });
  }

  return [];
}
