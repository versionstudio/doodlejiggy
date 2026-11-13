/**
 * @module tools/drawing
 * Shared canvas-overlay rendering for tools — the tool color palette plus
 * markers, labels, and polygon/object annotation overlays. Imperative ctx
 * helpers consumed by debug.js and design.js; depends only on geometry.js.
 */

import { addPolygonSubpath, nativeToScreen, polygonBounds } from '../engine/geometry.js';

const LABEL_FONT_RATIO = 0.02; // canvas-label font size as fraction of canvas height (via labelFontSize)
export const ENTRY_TRIANGLE_H = 8; // entry-point marker height (used by callers to position the label above it)
export const LABEL_OFFSET_ABOVE = 8; // gap between marker top and label bottom (shared by labels + object overlay)

// Canvas-overlay colors for tool-drawn layers. CSS-level tool styling lives in tools.css.
export const DRAW_COLORS = {
  walkable: '#55ffff',
  occluder: '#ff55ff',
  portals:  '#ff9933',
  objects:  '#ffff55',
  scaling:  '#ffffff',
};

// Shared label-sizing policy. Callers resolve the size because some tools both use the
// shared label helpers and perform direct text measurement or rendering with the same
// typography. Keeping the policy here ensures all canvas labels follow one rule.
/** @returns {number} Canvas-label font size in px for a viewport `viewH` CSS px tall. */
export function labelFontSize(viewH) {
  return Math.round(viewH * LABEL_FONT_RATIO);
}

// ══ Color math ═══════════════════════════

function hexToRgba(hex, a) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
}

// ══ Canvas labels ════════════════════════

const LABEL_PAD_X = 6; // tight horizontal padding — annotation tag, not UI widget
const LABEL_PAD_Y = 3; // tight vertical padding

function drawLabel(ctx, text, centerX, bottomY, color, fontSize) {
  ctx.save();
  ctx.font = fontSize + 'px ScummSolid, monospace';
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'center';
  const tw = ctx.measureText(text).width;
  const boxW = Math.ceil(tw + LABEL_PAD_X * 2);
  const boxH = Math.round(fontSize + LABEL_PAD_Y * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(Math.round(centerX - boxW / 2), Math.round(bottomY - boxH), boxW, boxH);
  ctx.fillStyle = color;
  ctx.fillText(text, centerX, bottomY - LABEL_PAD_Y);
  ctx.textBaseline = 'alphabetic';
  ctx.restore();
}

export function drawEntryLabel(ctx, text, centerX, markerTopY, fontSize) {
  drawLabel(ctx, text, centerX, markerTopY - LABEL_OFFSET_ABOVE, DRAW_COLORS.portals, fontSize);
}

export function drawToolLabel(ctx, text, centerX, bottomY, fontSize, color) {
  drawLabel(ctx, text, centerX, bottomY, color || DRAW_COLORS.objects, fontSize);
}

const PANEL_PAD_X = 16, PANEL_PAD_Y = 6, PANEL_LINE_GAP = 4;

/**
 * Translucent-black panel of left-aligned white text lines at `fontSize`. Shared
 * by the HUD and the per-actor TRACE boxes. `anchorBottom` treats `y` as the box's
 * bottom edge (a TRACE box sits on the actor's foot); otherwise `y` is the top.
 * @param {string[]} lines
 */
export function drawReadoutPanel(ctx, x, y, lines, fontSize, anchorBottom) {
  ctx.save();
  ctx.font = fontSize + 'px ScummSolid, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const lineH = fontSize + PANEL_LINE_GAP;
  let maxW = 0;
  for (let i = 0; i < lines.length; i++) maxW = Math.max(maxW, ctx.measureText(lines[i]).width);
  const boxW = Math.ceil(maxW + PANEL_PAD_X * 2);
  const boxH = Math.round(lines.length * lineH - PANEL_LINE_GAP + PANEL_PAD_Y * 2);
  const left = Math.round(x);
  const top = Math.round(anchorBottom ? y - boxH : y);
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  ctx.fillRect(left, top, boxW, boxH);
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], left + PANEL_PAD_X, top + PANEL_PAD_Y + i * lineH);
  ctx.restore();
}

// ══ Canvas overlays ══════════════════════

/**
 * Hollow downward-pointing entry-point triangle. `sp` is screen-space tip
 * position.
 */
export function drawEntryMarker(ctx, sp, color) {
  const halfW = 7; // half-width of the triangle (pairs with the exported ENTRY_TRIANGLE_H)
  ctx.beginPath();
  ctx.moveTo(sp.x - halfW, sp.y - ENTRY_TRIANGLE_H);
  ctx.lineTo(sp.x + halfW, sp.y - ENTRY_TRIANGLE_H);
  ctx.lineTo(sp.x, sp.y);
  ctx.closePath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.stroke();
}

/**
 * Dashed NEAR / FAR scale line with label clamped to viewport-left to
 * survive horizontal scroll clipping. `hint` is appended after the scale
 * value (e.g. ' ‹ drag ›' in design).
 */
export function drawScalingLineLabel(ctx, line, name, rect, worldHeight, bgNativeWidth, fontSize, color, hint) {
  const left = nativeToScreen(0, line.y, rect, worldHeight);
  const right = nativeToScreen(bgNativeWidth, line.y, rect, worldHeight);
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = color;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(left.x, left.y);
  ctx.lineTo(right.x, left.y);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.font = fontSize + 'px ScummSolid, monospace';
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.fillText(name.toUpperCase() + ' scale: ' + line.scale.toFixed(2) + (hint || ''),
               Math.max(left.x, 0) + 6, left.y - 4);
  ctx.restore();
}

/**
 * In-progress polygon during drawing — dashed line through committed points
 * and on to the current cursor, plus a node circle on each committed point.
 */
export function drawInProgressPolygon(ctx, points, mouseScreen, color, rect, worldHeight, pointRadius) {
  if (points.length === 0) return;
  ctx.save();
  ctx.beginPath();
  const fp = nativeToScreen(points[0].x, points[0].y, rect, worldHeight);
  ctx.moveTo(fp.x, fp.y);
  for (let i = 1; i < points.length; i++) {
    const cp = nativeToScreen(points[i].x, points[i].y, rect, worldHeight);
    ctx.lineTo(cp.x, cp.y);
  }
  if (mouseScreen) ctx.lineTo(mouseScreen.x, mouseScreen.y);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 4]);
  ctx.stroke();
  ctx.setLineDash([]);

  for (let i = 0; i < points.length; i++) {
    const sp = nativeToScreen(points[i].x, points[i].y, rect, worldHeight);
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, pointRadius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.restore();
}

const FILL_ALPHA = 0.15; // overlay polygon fill opacity

/**
 * Polygon body — fill (when closed, at FILL_ALPHA) plus a 1px outline. Vertex
 * nodes and selection chrome are the caller's concern (design draws editable
 * nodes on top). `opts`: { color, closed (default true), highlight (white
 * stroke for a selected/hovered polygon) }.
 */
export function drawPolygon(ctx, rect, points, worldHeight, opts) {
  if (!points || points.length < 2) return;
  const closed = opts.closed !== false;
  ctx.beginPath();
  addPolygonSubpath(ctx, points, rect, worldHeight, closed);
  if (closed) {
    ctx.fillStyle = hexToRgba(opts.color, FILL_ALPHA);
    ctx.fill();
  }
  ctx.strokeStyle = opts.highlight ? '#ffffff' : opts.color;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.stroke();
}

/**
 * Annotation overlay for a placed object, from one of two `region` shapes:
 *
 * `{ hotspot }` — authored interaction geometry (absolute points), drawn as a
 * filled shape + full outline, at full weight.
 *
 * `{ bounds }` — a sprite extent, which callers resolve through `spriteBounds` so
 * the annotation lands where the engine draws and hit-tests. Drawn as corner
 * brackets: a lightweight extent hint, not a dominant collision rectangle.
 *
 * Skipped (not spawned) objects use dashed strokes and a lighter fill.
 * Caller passes `worldHeight` (engine-side CONFIG) to keep this module pure.
 */
export function drawObjectOverlay(ctx, rect, region, skipped, title, worldHeight, fontSize, overrideColor) {
  const color = overrideColor || DRAW_COLORS.objects;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.setLineDash(skipped ? [4, 3] : []);

  if (region.hotspot && region.hotspot.length >= 2) {
    ctx.beginPath();
    addPolygonSubpath(ctx, region.hotspot, rect, worldHeight);
    ctx.fillStyle = hexToRgba(color, skipped ? 0.08 : 0.15);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();

    if (title) {
      const b = polygonBounds(region.hotspot);
      const tp = nativeToScreen((b.minX + b.maxX) / 2, b.minY, rect, worldHeight);
      ctx.setLineDash([]);
      drawToolLabel(ctx, title, tp.x, tp.y - LABEL_OFFSET_ABOVE, fontSize, color);
    }
  } else if (region.bounds) {
    const tl = nativeToScreen(region.bounds.minX, region.bounds.minY, rect, worldHeight);
    const br = nativeToScreen(region.bounds.maxX, region.bounds.maxY, rect, worldHeight);
    const sx = Math.round(tl.x), sy = Math.round(tl.y);
    const sw = Math.round(br.x) - sx, sh = Math.round(br.y) - sy;

    // Corner brackets — fallback geometry visualized as extent hint, not a collision rect
    const cornerArmMax = 14; // max bracket arm length in screen px for sprite bbox
    const arm = Math.max(Math.min(sw * 0.22, cornerArmMax), 8);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(sx, sy + arm); ctx.lineTo(sx, sy); ctx.lineTo(sx + arm, sy);
    ctx.moveTo(sx+sw-arm, sy); ctx.lineTo(sx+sw, sy); ctx.lineTo(sx+sw, sy + arm);
    ctx.moveTo(sx, sy+sh-arm); ctx.lineTo(sx, sy+sh); ctx.lineTo(sx + arm, sy+sh);
    ctx.moveTo(sx+sw-arm, sy+sh); ctx.lineTo(sx+sw, sy+sh); ctx.lineTo(sx+sw, sy+sh-arm);
    ctx.stroke();

    if (title) {
      ctx.setLineDash([]);
      drawToolLabel(ctx, title, sx + sw / 2, sy - LABEL_OFFSET_ABOVE, fontSize, color);
    }
  }

  ctx.setLineDash([]);
  ctx.restore();
}
