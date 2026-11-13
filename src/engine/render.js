/**
 * @module render
 * Runtime canvas rendering and the engine's visual language.
 *
 * Handles runtime drawing of world sprites, speech, scan markers, and
 * occlusion-aware sprite compositing onto the world canvas, plus the overlay
 * (veil + block stack) on its own canvas above it. Every canvas surface is
 * created and sized here, including the one the debug tooling draws into.
 *
 * Also owns canvas presentation state: each canvas surface's engine default
 * lives here beside its setter, and authored palette keys, font roles, and
 * style names resolve at draw time. Rendering is immediate-mode: callers
 * provide the current scene state each frame rather than maintaining a
 * retained scene graph.
 */

import CONFIG from './config.js';
import { resolveAnimBlock } from './actors.js';
import { nativeToScreen, addPolygonSubpath, polygonsAtSegment, polygonBounds, spriteBounds } from './geometry.js';
import { worldRect, setWorldBackground } from './world.js';

// ══ Theme ════════════════════════════════
//
// The canvas half of the game's visual identity. `speech` and `styles` are
// this module's surfaces: their engine defaults live here and a game entry
// replaces the engine entry whole, so an omitted entry keeps the default. The
// palette and font roles arrive constructed by game.js, guaranteed names
// included, before the first frame.
//
// Names resolve at draw time, never at install: entities, blocks, and scripts
// hold palette keys, style names, and font roles that only become concrete
// when something is drawn. The world's clear color is the exception. It's DOM
// rather than canvas, so `setWorldColor` resolves it once per scene load.

const ENGINE_SPEECH = Object.freeze({
  font:         'dialog',
  size:         0.030, // fraction of canvas height
  color:        'white',
  lineHeight:   1.35, // multiple of font size
  width:        0.7, // max bubble width as fraction of canvas width
  outlineColor: 'black',
  outlineWidth: 9, // canvas px on desktop and portrait mobile; short-canvas guard below
});
const ENGINE_STYLES = Object.freeze({ default: Object.freeze({ font: 'dialog', size: 0.045, color: 'white' }) });

let colors = {}; // the draw-time color fallbacks rely on its guaranteed names
let fonts = {};
let speech = Object.assign({}, ENGINE_SPEECH);
let styles = Object.assign({}, ENGINE_STYLES);

/**
 * Installs the canvas theme. The palette and font roles are taken as
 * constructed; `speech` is a flat knob map merged field by field over the
 * engine default, while a `styles` entry is atomic and replaces the engine
 * entry whole. Re-applying is safe and takes effect on the next frame, since
 * nothing here holds a resolved value.
 */
export function applyTheme(theme) {
  colors = theme.colors;
  fonts = theme.fonts;
  speech = Object.assign({}, ENGINE_SPEECH, theme.speech);
  styles = Object.assign({}, ENGINE_STYLES, theme.styles);
}

// ══ Canvas ═══════════════════════════════

// World canvas (actors, objects, speech). Lives inside `#app`, which fades
// as a group on scene transitions — so this stays fully opaque and never
// fades on its own (per-layer fades would let the backdrop show through actors).
const canvas = document.createElement('canvas');
canvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;image-rendering:pixelated;';
const ctx = canvas.getContext('2d');

// The overlay renders on its own canvas above the `#app` group so its
// transition stays visible while the scene underneath is still hidden — the
// veil-first masking on scene enter. Kept out of the faded group on purpose.
const overlayCanvas = document.createElement('canvas');
overlayCanvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:20;pointer-events:none;';
const overlayCtx = overlayCanvas.getContext('2d');

// The tools' layer (10 world, 15 debug, 20 overlay). It lives in the `#app`
// group so diagnostics fade with the scene, and sits under the overlay's z-index
// because `#app` only forms a stacking context mid-fade: at full opacity these
// z-indices compete directly. Being its own canvas keeps its pixels off the one
// the overlay crossfade snapshots. Dev-only, like the tools themselves
// (index.html). The one surface render.js hands out — the world and overlay
// canvases stay private.
const debugCanvas = import.meta.env.DEV ? document.createElement('canvas') : null;
if (debugCanvas) debugCanvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:15;pointer-events:none;';
export const debugCtx = debugCanvas ? debugCanvas.getContext('2d') : null;

// Every canvas layer — the list resizeCanvas sizes.
const layers = [{ el: canvas, c: ctx }, { el: overlayCanvas, c: overlayCtx }];
if (debugCanvas) layers.push({ el: debugCanvas, c: debugCtx });

// Logical viewport size in CSS px, shared by every layer. Their backing stores
// are device px (CSS px × dpr) so the compositor never has to upscale (and thus
// smooth) a low-resolution canvas layer. iOS Safari smooths that upscale, which
// shimmers pixel art on scroll and animation. All layout math (speech metrics,
// overlay layout, cull tests) reads these; all drawing stays in CSS px via each
// context's dpr transform, so draw code is unaffected.
let viewW = 0, viewH = 0;

/**
 * Mounts the world and debug canvases inside `gameEl` (the faded scene group),
 * and the overlay canvas on `document.body` above it.
 */
export function initCanvas(gameEl) {
  gameEl.appendChild(canvas);
  if (debugCanvas) gameEl.appendChild(debugCanvas);
  document.body.appendChild(overlayCanvas);
  resizeCanvas();
}

export function resizeCanvas() {
  const vv = window.visualViewport;
  const left = vv ? vv.offsetLeft + 'px' : '0';
  const top = vv ? vv.offsetTop + 'px' : '0';
  const w = vv ? Math.round(vv.width) : document.documentElement.clientWidth;
  const h = vv ? Math.round(vv.height) : document.documentElement.clientHeight;
  const dpr = window.devicePixelRatio || 1;

  // Every layer: CSS size w×h, backing store at device resolution, and a dpr
  // transform so draw code keeps operating in CSS px. setTransform must follow the
  // width/height assignment, which resets the context state.
  viewW = w;
  viewH = h;
  layers.forEach(function (o) {
    o.el.style.left = left;
    o.el.style.top = top;
    o.el.style.width = w + 'px';
    o.el.style.height = h + 'px';
    o.el.width = Math.round(w * dpr);
    o.el.height = Math.round(h * dpr);
    o.c.setTransform(dpr, 0, 0, dpr, 0, 0);
  });
}

/** @returns {{ w: number, h: number }} Logical viewport size in CSS px. */
export function viewportSize() {
  return { w: viewW, h: viewH };
}

// Wipes a layer whole. Resets to identity first: the context carries a dpr
// transform under which CSS-px extents fall short of the device-px backing
// store's edges, leaving a strip uncleared.
function clearLayer(el, c) {
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, el.width, el.height);
  c.restore();
}

// Clears the layers a frame paints directly for a fresh one. The overlay isn't
// among them: renderOverlay clears its own canvas, and holds the last frame for
// the crossfade snapshot.
export function clearFrame() {
  clearLayer(canvas, ctx);
  if (debugCanvas) clearLayer(debugCanvas, debugCtx);
}

/**
 * Clips `draw` to the world's rect. CSS `overflow` clips only the backdrop, so
 * without this, entities past the world edge would paint over the letterbox.
 */
export function withWorldClip(draw) {
  const rect = worldRect();
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.left, rect.top, rect.width, rect.height);
  ctx.clip();
  try {
    draw();
  } finally {
    ctx.restore();
  }
}

/** Paints the world's clear color; unknown palette names fall back to `black`. */
export function setWorldColor(name) {
  setWorldBackground(colors[name] || colors.black);
}

// ══ Sprites ══════════════════════════════

// A SourceRect is a sprite-sheet sub-rect in source pixels, `{ sx, sy, sw, sh }`.

/**
 * Source sub-rect for one frame of a sprite sheet, or null if the image isn't
 * decoded yet. `row`/`frames`/`startFrame` come from the caller's resolved
 * animation: actors resolve direction → row; objects read their state-driven
 * anim fields; the inventory passes a single still frame.
 *
 * @returns {SourceRect | null} The requested frame's sub-rect, or null until
 * the image is decoded.
 */
function spriteSrcRect(img, columns, totalRows, frame, frames, startFrame, row) {
  if (!img || !img.complete || !img.naturalWidth) return null;
  const frameW = img.naturalWidth / (columns || 1);
  const frameH = img.naturalHeight / (totalRows || 1);
  const frameInBlock = Math.min(frame, (frames || 1) - 1);
  const col = frameInBlock + (startFrame || 0);
  return {
    sx: Math.round(col * frameW),
    sy: Math.round(row * frameH),
    sw: Math.round(frameW),
    sh: Math.round(frameH),
  };
}

/**
 * Extracts one sprite-sheet cell into a standalone canvas sized to that cell,
 * for DOM display off the world canvas (inventory strip, drag ghost). Slices
 * via `spriteSrcRect`, so the icon shows exactly the cell the world would draw.
 *
 * @returns {HTMLCanvasElement | null} A canvas of the cell, or null until the
 * sheet is decoded.
 */
export function spriteIcon(img, cols, rows, row, startFrame) {
  const rect = spriteSrcRect(img, cols, rows, 0, 1, startFrame, row);
  if (!rect) return null;

  const c = document.createElement('canvas');
  c.width = rect.sw;
  c.height = rect.sh;
  c.getContext('2d').drawImage(img, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, rect.sw, rect.sh);
  return c;
}

// ══ World sprites ════════════════════════

// Draws an image positioned by bottom-center anchor (anchorX, anchorY) at the
// given world size (w, h), multiplied by the caller-supplied `scale`, clipped against any
// occluders active at the sprite's foot segment. `srcRect` selects a sub-rect
// of the source image (for sprite sheets) or null to draw the whole image.
function drawWorldSprite(img, anchorX, anchorY, w, h, scale, srcRect, flipX, occluderPolygons) {
  const rect = worldRect();
  const scaledW = w * scale;
  const scaledH = h * scale;

  // Unscaled `w`: scaling is centred here, so a sprite grows in place rather
  // than drifting off its anchor.
  const centerX = anchorX + w / 2;
  const topLeft = nativeToScreen(centerX - scaledW / 2, anchorY - scaledH, rect, CONFIG.world.height);
  const bottomRight = nativeToScreen(centerX + scaledW / 2, anchorY, rect, CONFIG.world.height);

  // Rounding the corners rather than the width keeps neighbouring sprites
  // agreeing on a shared edge.
  const tlx = Math.round(topLeft.x);
  const tly = Math.round(topLeft.y);
  const dw = Math.round(bottomRight.x) - tlx;
  const dh = Math.round(bottomRight.y) - tly;

  function paint() {
    // No fallback by design: scene-load preload guarantees a complete Image.
    // A miss here is a preload gap to surface, not mask with a placeholder.
    if (!img || !img.complete || !img.naturalWidth) return;
    ctx.imageSmoothingEnabled = false;
    if (flipX) {
      ctx.save();
      ctx.translate(tlx + dw, tly);
      ctx.scale(-1, 1);
      if (srcRect) ctx.drawImage(img, srcRect.sx, srcRect.sy, srcRect.sw, srcRect.sh, 0, 0, dw, dh);
      else ctx.drawImage(img, 0, 0, dw, dh);
      ctx.restore();
    } else if (srcRect) {
      ctx.drawImage(img, srcRect.sx, srcRect.sy, srcRect.sw, srcRect.sh, tlx, tly, dw, dh);
    } else {
      ctx.drawImage(img, tlx, tly, dw, dh);
    }
  }

  const activeOccluders = polygonsAtSegment(anchorX, anchorX + w, anchorY, occluderPolygons);
  if (activeOccluders.length === 0) {
    paint();
    return;
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, viewW, viewH); // logical CSS-px extent; ctx is dpr-scaled
  activeOccluders.forEach(function (poly) {
    addPolygonSubpath(ctx, poly.points, rect, CONFIG.world.height);
  });
  ctx.clip('evenodd');
  paint();
  ctx.restore();
}

/**
 * Renders an actor at its current position with its current animation frame,
 * clipped against any active occluders at the actor's foot segment.
 */
export function renderActor(actor, occluderPolygons, scale = 1) {
  const img = actor.spriteImg;
  if (!img) return; // spriteless actor: nothing to draw (it still moves, speaks, interacts)
  const dir = actor.direction || 'south';
  const animDef = resolveAnimBlock(actor, actor.animState);

  // Animation blocks use either directional `rows` or one non-directional `row`;
  // the schema guarantees exactly one. Directional blocks define every cardinal,
  // with `west` drawn flipped when it shares a row with `east`. If no block
  // resolves, hold frame 0 of the current sprite sheet.
  let row = 0, flipX = false;
  if (animDef) {
    if (animDef.rows) {
      row = animDef.rows[dir];
      flipX = dir === 'west' && animDef.rows.west === animDef.rows.east;
    } else {
      row = animDef.row;
    }
  }

  const srcRect = spriteSrcRect(img, actor.columns, actor.totalRows, actor.frame,
                                animDef ? animDef.frames : 1, animDef ? animDef.startFrame : 0, row);

  // `surface`-plane sprites rest on raised scenery (tables, shelves) and so
  // skip walk-behind clipping; `normal`/`flat` respect occluders. offsetX/Y
  // nudge the drawn pixels only (render-only); they scale with depth so the
  // art stays aligned at any distance.
  const occ = actor.plane === 'surface' ? [] : occluderPolygons;
  drawWorldSprite(img, actor.x + actor.offsetX * scale, actor.y + actor.offsetY * scale,
                  actor.w, actor.h, scale, srcRect, flipX, occ);
}

/**
 * Renders an object at its current position with its current animation frame,
 * clipped against any active occluders at the object's foot segment.
 */
export function renderObject(obj, occluderPolygons, scale = 1) {
  const img = obj.spriteImg;
  if (!img || !img.complete || !img.naturalWidth) return;
  const srcRect = spriteSrcRect(img, obj.columns, obj.totalRows, obj.frame,
                                obj.animFrames, obj.animStartFrame, obj.animRow || 0);
  const occ = obj.plane === 'surface' ? [] : occluderPolygons; // see renderActor: `surface` skips walk-behind clipping
  drawWorldSprite(img, obj.x + obj.offsetX * scale, obj.y + obj.offsetY * scale,
                  obj.w, obj.h, scale, srcRect, false, occ);
}

// ══ Scan markers ═════════════════════════

const SCAN_MARKER_RADIUS = 5; // dot radius in screen px
const SCAN_MARKER_STROKE = 2; // dot outline width in screen px

let scanMarkerImg = null; // theme's marker image; null draws the built-in dot

/**
 * Installs the theme's scan-marker image, drawn in place of the built-in dot.
 * A missing or failed-to-load image leaves markers on the dot.
 *
 * @param {HTMLImageElement | null} img
 */
export function setScanMarker(img) {
  scanMarkerImg = img || null;
}

// Computes the on-screen rect (top-left + dimensions) of an entity's
// depth-scaled sprite. Bounds track `offsetX/Y` so the rect (and the scan
// marker centred on it) follows where the sprite is actually drawn.
function entityScreenRect(entity, scale) {
  const rect = worldRect();
  const b = spriteBounds(entity.x + entity.w / 2, entity.y, entity.w, entity.h, entity.offsetX, entity.offsetY, scale);
  const topLeft = nativeToScreen(b.minX, b.minY, rect, CONFIG.world.height);
  const bottomRight = nativeToScreen(b.maxX, b.maxY, rect, CONFIG.world.height);
  const tlx = Math.round(topLeft.x);
  const tly = Math.round(topLeft.y);
  return { x: tlx, y: tly, w: Math.round(bottomRight.x) - tlx, h: Math.round(bottomRight.y) - tly };
}

/**
 * Returns true if the entity's anchor point falls within the canvas bounds.
 * Sprite anchor = bottom-centre; hotspot anchor = polygon bounding-box centre.
 *
 * Takes any world entity, and equally a hotspot-only marker (a portal exit,
 * passed as its polygon plus zeroed position). Used to gate scan markers so
 * only meaningfully visible interactables show them.
 */
export function isEntityAnchorVisible(entity) {
  const rect = worldRect();
  let pt;
  if (entity.hotspot && entity.hotspot.length >= 3) {
    const b = polygonBounds(entity.hotspot);
    pt = nativeToScreen((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, rect, CONFIG.world.height);
  } else {
    pt = nativeToScreen(entity.x + entity.w / 2, entity.y, rect, CONFIG.world.height);
  }
  return pt.x >= 0 && pt.x <= viewW && pt.y >= 0 && pt.y <= viewH;
}

/**
 * Marker placed at the visual centre of an interactable: the theme's image
 * when one is installed, otherwise the built-in white dot. Takes the same
 * subjects as `isEntityAnchorVisible` — any entity, or a hotspot-only marker.
 * Implementation-agnostic: objects, actors, and portal exits all read the same.
 */
export function renderScanMarker(entity, scale) {
  const rect = worldRect();
  let cx, cy;
  if (entity.hotspot && entity.hotspot.length >= 3) {
    const b = polygonBounds(entity.hotspot);
    const pt = nativeToScreen((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, rect, CONFIG.world.height);
    cx = pt.x; cy = pt.y;
  } else {
    const r = entityScreenRect(entity, scale);
    cx = r.x + r.w / 2;
    cy = r.y + r.h / 2;
  }

  // The image is authored in world pixels, so it takes the world scale factor
  // and never the entity's depth scale: markers read the same size everywhere.
  if (scanMarkerImg && scanMarkerImg.complete && scanMarkerImg.naturalWidth) {
    const worldScale = rect.height / CONFIG.world.height;
    const w = Math.round(scanMarkerImg.naturalWidth * worldScale);
    const h = Math.round(scanMarkerImg.naturalHeight * worldScale);
    ctx.drawImage(scanMarkerImg, Math.round(cx - w / 2), Math.round(cy - h / 2), w, h);
    return;
  }

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, SCAN_MARKER_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = SCAN_MARKER_STROKE;
  ctx.stroke();
  ctx.restore();
}

// ══ Speech ═══════════════════════════════
//
// Speech typography values come from the speech theme (`theme.speech` over
// the engine defaults); the constants below are correctness guards, which
// never promote to the theme — a theme can want thin outlines, not invisible
// ones.

// Text stroke width as fraction of font size — applied only on short-canvas
// viewports (landscape phone) so the stroke doesn't look proportionally massive
// over the smaller font there.
const SPEECH_OUTLINE_RATIO = 0.35;
const SPEECH_OUTLINE_MIN   = 2; // floor so the stroke doesn't disappear at tiny fonts

// Character-count wrap target, passed to wrapText as its `maxChars` cap: it
// keeps speech break points identical across resolutions, independent of font
// scaling.
const SPEECH_LINE_CHARS    = 30;

// Canvas-height threshold (px) below which outline width scales with the font
// instead of staying fixed (keeps the stroke proportional on landscape phone).
const SPEECH_SHORT_CANVAS  = 500;
const SPEECH_HEAD_OFFSET   = 10; // px gap between the speaker's anchor and first text line
const SPEECH_SAFE_TOP      = 24; // minimum px clearance from canvas top edge (mobile safe-area guard)
const SPEECH_SAFE_SIDE     = 16; // minimum px clearance from canvas left/right edges

// Speech-effect registry, keyed by resolved effect name (`Speech.effect`).
// Presentation only; each entry's `kind` selects how renderSpeech applies it:
//   'offset' — a whole-bubble translation, re-rolled every `intervalMs`, its
//              peak `amp` a fraction of the font size (resolution-independent).
//   'warp'   — a horizontal distortion: the bubble is rendered to an offscreen
//              buffer and blitted back in horizontal strips, each nudged by a
//              sub-pixel sine, under a faint brightness flicker (see
//              drawSpeechWarp). Its tuning fields ride on the entry.
// All motion derives from `Speech.timer` (drained by tickSpeech), so renderWorld
// stays pure: same state → identical pixels.
const SPEECH_EFFECTS = {
  jitter: { kind: 'offset', amp: 0.08, intervalMs: 90 }, // unstable speech (machines, glitches)
  shake:  { kind: 'offset', amp: 0.15, intervalMs: 125 }, // physical impact (clunks, bangs)
  crt:    { kind: 'warp', waveAmp: 0.015, waveLength: 1.4, scanHz: 0.5, flickerHz: 7, flickerDepth: 0.08 }, // near-still digital pulse (terminals, monitors)
  wobble: { kind: 'warp', waveAmp: 0.045, waveLength: 1.1, scanHz: 0.5, flickerHz: 8, flickerDepth: 0.05 }, // visible scan warp
};

// Wrap text into lines. `maxWidth` is always honored (screen-fit safety);
// `maxChars` (optional) wraps earlier when set, used by speech to keep
// break points consistent across resolutions independent of font scaling.
// Whichever cap is hit first wins.
// `measureCtx` must have the target font already set — measurement is
// font-relative, and speech and the overlay draw on different canvases.
function wrapText(measureCtx, text, maxWidth, maxChars) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? line + ' ' + word : word;
    const tooWide = measureCtx.measureText(test).width > maxWidth;
    const tooMany = maxChars !== undefined && test.length > maxChars;
    if ((tooWide || tooMany) && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// Speech-text metrics and styling: font, line height, and stroke outline all
// scale off canvas height, so a spoken line looks the same regardless of the
// speaker's depth.

function speechTextMetrics() {
  const fontSize = Math.round(viewH * speech.size);
  const outlineWidth = viewH < SPEECH_SHORT_CANVAS
    ? Math.max(SPEECH_OUTLINE_MIN, fontSize * SPEECH_OUTLINE_RATIO)
    : speech.outlineWidth;
  return {
    fontSize:     fontSize,
    lineHeight:   Math.round(fontSize * speech.lineHeight),
    outlineWidth: outlineWidth,
    maxWidth:     viewW * speech.width,
  };
}

function setSpeechTextStyle(c, fontSize, outlineWidth, fillStyle) {
  c.font = fontSize + 'px ' + (fonts[speech.font] || fonts.dialog) + ', monospace';
  c.textAlign = 'center';
  c.lineJoin = 'round';
  c.lineWidth = outlineWidth;
  c.strokeStyle = colors[speech.outlineColor] || colors.black;
  c.fillStyle = fillStyle;
}

// The scene-space point a speaker's line originates from: the top-center of the
// sprite as drawn (spriteBounds folds in `offsetX/Y` and the given `scale`), nudged
// by the entity's `speechOffsetX/Y`. The single definition of where speech sits;
// actor and object speakers both resolve through it. `renderSpeech` supplies the
// scale and projects the result to screen.
function getSpeechAnchor(entity, scale) {
  const b = spriteBounds(entity.x + entity.w / 2, entity.y, entity.w, entity.h, entity.offsetX, entity.offsetY, scale);
  return {
    x: (b.minX + b.maxX) / 2 + entity.speechOffsetX * scale,
    y: b.minY + entity.speechOffsetY * scale,
  };
}

/**
 * Renders one utterance (a `Speech`, scene.js) as a stroke-outlined text bubble
 * above its speaker, color-resolved through the palette. The speaker is any
 * world entity (actor or object) carrying an optional `speechColor` plus the
 * position and offset fields the anchor is derived from.
 *
 * `screenClamp` selects the positioning mode: true keeps the bubble inside the
 * safe margins (scripted/dialogue-mode speech stays readable near edges/top);
 * false anchors it in the world with no clamp, so ambient barks track the
 * speaker and fall off-screen with them.
 */
export function renderSpeech(utterance, scale, screenClamp) {
  const entity = utterance.speaker;
  const rect = worldRect();
  const anchor = getSpeechAnchor(entity, scale);
  const head = nativeToScreen(anchor.x, anchor.y, rect, CONFIG.world.height);
  const { fontSize, lineHeight, outlineWidth, maxWidth } = speechTextMetrics();
  // Entity `speechColor` (unset when the entity doesn't override) → the speech
  // theme's color → `white`. The guaranteed palette names terminate the chain.
  const fillStyle = colors[entity.speechColor] || colors[speech.color] || colors.white;
  setSpeechTextStyle(ctx, fontSize, outlineWidth, fillStyle);

  const lines = wrapText(ctx, utterance.text, maxWidth, SPEECH_LINE_CHARS);
  // The block grows upward from the speaker's head, so the first baseline sits a
  // full block above the last.
  const blockHeight = (lines.length - 1) * lineHeight;
  const naturalStartY = head.y - SPEECH_HEAD_OFFSET - blockHeight;
  // Highest the first baseline may sit: its ascent, the stroke's bleed, and the
  // safe-area inset all have to fit above it.
  const minStartY = fontSize + Math.ceil(outlineWidth / 2) + SPEECH_SAFE_TOP;
  const startY = screenClamp ? Math.max(minStartY, naturalStartY) : naturalStartY;

  // Screen-clamped speech keeps the centered bubble inside the side margins when
  // the speaker stands near an edge — horizontal counterpart to the SAFE_TOP
  // guard. Clamp the center so the widest line (plus outline) clears both
  // margins; fall back to dead center when the text is too wide to fit at all.
  // World-anchored barks skip this entirely, staying centered on the speaker.
  // Clamp to the visible world (viewport ∩ world rect) so a bubble never drifts
  // into the letterbox on a world narrower than the screen.
  let textX = head.x;
  if (screenClamp) {
    const strokeBleed = outlineWidth / 2;
    let halfContentWidth = 0;
    for (const line of lines) halfContentWidth = Math.max(halfContentWidth, ctx.measureText(line).width / 2);
    const halfWidth = halfContentWidth + strokeBleed;
    const visibleLeft = Math.max(0, rect.left);
    const visibleRight = Math.min(viewW, rect.right);
    const minX = visibleLeft + SPEECH_SAFE_SIDE + halfWidth;
    const maxX = visibleRight - SPEECH_SAFE_SIDE - halfWidth;
    textX = minX <= maxX ? Math.min(maxX, Math.max(minX, head.x)) : (visibleLeft + visibleRight) / 2;
  }

  // Effect dispatch, after the top/side clamps: a 'warp' effect distorts the
  // glyphs via an offscreen strip blit; an 'offset' effect (or none) translates
  // the whole bubble, keeping its motion at the cost of breaching the safe
  // margins by at most the amplitude.
  const fx = SPEECH_EFFECTS[utterance.effect];
  if (fx && fx.kind === 'warp') {
    drawSpeechWarp(fx, utterance.timer, lines, textX, startY, fontSize, lineHeight, outlineWidth, fillStyle);
  } else {
    drawSpeechOffset(fx, utterance.timer, lines, textX, startY, fontSize, lineHeight);
  }

  ctx.textAlign = 'left';
}

// Draws the lines translated as one block. The offset is the timer quantized
// into `intervalMs` steps, each step index hashed into a signed unit offset per
// axis; a null `fx` (no effect) draws them still. Sibling of drawSpeechWarp —
// the two are the offset- and warp-kind halves of the effect dispatch.
function drawSpeechOffset(fx, timerMs, lines, textX, startY, fontSize, lineHeight) {
  // Deterministic integer → [-1, 1) hash (sine-fract fold).
  function hashSigned(n) {
    const s = Math.sin(n * 127.1) * 43758.5453;
    return (s - Math.floor(s)) * 2 - 1;
  }

  let jitterX = 0, jitterY = 0;
  if (fx) {
    const step = Math.floor(timerMs / fx.intervalMs);
    const amplitude = fx.amp * fontSize;
    jitterX = hashSigned(step) * amplitude;
    jitterY = hashSigned(step + 7919) * amplitude; // prime offset decorrelates the axes
  }
  lines.forEach(function (line, i) {
    const y = startY + jitterY + i * lineHeight;
    ctx.strokeText(line, textX + jitterX, y);
    ctx.fillText(line, textX + jitterX, y);
  });
}

// Offscreen buffer for the warp blit, grown on demand and reused across frames.
let speechFxCanvas = null;
let speechFxCtx = null;

// A horizontal warp: the bubble is rendered once to an offscreen buffer, then
// blitted back in thin horizontal strips, each shifted horizontally by a slow
// vertical sine of its row and the timer. The glyphs distort in place rather
// than the whole bubble relocating (which is what reads as jitter), and a faint
// timer-driven brightness flicker suggests phosphor refresh. `crt` and `wobble`
// are the same path at different amplitudes. Deterministic from `timerMs`, so
// renderWorld stays pure.
function drawSpeechWarp(fx, timerMs, lines, textX, startY, fontSize, lineHeight, outlineWidth, fillStyle) {
  const TAU = Math.PI * 2;
  const dpr = window.devicePixelRatio || 1;

  if (!speechFxCtx) {
    speechFxCanvas = document.createElement('canvas');
    speechFxCtx = speechFxCanvas.getContext('2d');
  }
  const bufferCtx = speechFxCtx;

  // Measured on the main ctx, whose speech font is already set; the buffer's is not.
  let contentWidth = 0;
  for (const line of lines) contentWidth = Math.max(contentWidth, ctx.measureText(line).width);
  const contentHeight = (lines.length - 1) * lineHeight;

  // Padding holds what spills past the glyph box. `fontSize` covers the ascent
  // and descent reaching beyond the first and last baseline, and the 2px is
  // rounding headroom so a fractional edge can't clip.
  const strokeBleed = outlineWidth / 2;
  const waveAmplitude = fx.waveAmp * fontSize;
  const padX = Math.ceil(strokeBleed + waveAmplitude + 2);
  const padY = Math.ceil(fontSize + strokeBleed + 2);

  const bufferWidth = Math.ceil((Math.ceil(contentWidth) + padX * 2) * dpr);
  const bufferHeight = Math.ceil((contentHeight + padY * 2) * dpr);
  if (speechFxCanvas.width < bufferWidth) speechFxCanvas.width = bufferWidth;
  if (speechFxCanvas.height < bufferHeight) speechFxCanvas.height = bufferHeight;

  // Draw text at device resolution (dpr transform) so glyphs stay crisp; the
  // strip blit maps device px back 1:1. setTransform also resets the state a
  // resize cleared, so style after it.
  const bufferWidthCss = bufferWidth / dpr;
  bufferCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  setSpeechTextStyle(bufferCtx, fontSize, outlineWidth, fillStyle);
  bufferCtx.clearRect(0, 0, bufferWidthCss, bufferHeight / dpr);
  const centerX = bufferWidthCss / 2;
  lines.forEach(function (line, i) {
    bufferCtx.strokeText(line, centerX, padY + i * lineHeight);
    bufferCtx.fillText(line, centerX, padY + i * lineHeight);
  });

  // Blit rows back. Snap the block origin to the device grid so only the per-row
  // horizontal wobble stays fractional: vertical is pixel-exact (no blur), while
  // the fractional horizontal shift interpolates into a sub-pixel shimmer.
  const destLeft = Math.round((textX - centerX) * dpr) / dpr;
  const destTop = Math.round((startY - padY) * dpr) / dpr;
  const stripPx = Math.max(1, Math.round(2 * dpr)); // ~2 CSS px per strip

  // Phases are counted in whole cycles and converted to radians once, at the sin.
  const elapsedSeconds = timerMs / 1000;
  const wavelengthPx = fx.waveLength * fontSize;
  const temporalPhase = elapsedSeconds * fx.scanHz;

  const flickerRamp = 0.5 + 0.5 * Math.sin(elapsedSeconds * fx.flickerHz * TAU);
  const flicker = 1 - fx.flickerDepth * flickerRamp;

  ctx.save();
  ctx.imageSmoothingEnabled = true; // let the fractional horizontal shift interpolate
  ctx.globalAlpha = flicker;
  for (let sy = 0; sy < bufferHeight; sy += stripPx) {
    const stripHeight = Math.min(stripPx, bufferHeight - sy);
    const rowY = sy / dpr;
    const spatialPhase = rowY / wavelengthPx;
    const wave = waveAmplitude * Math.sin((spatialPhase - temporalPhase) * TAU);
    ctx.drawImage(speechFxCanvas, 0, sy, bufferWidth, stripHeight,
                  destLeft + wave, destTop + rowY, bufferWidthCss, stripHeight / dpr);
  }
  ctx.restore();
}

// ══ Overlay ══════════════════════════════
//
// The active overlay: an optional fullscreen veil under one aligned vertical
// stack of items (styled text and inserts), drawn on the overlay canvas.
// Pure rendering — state and lifecycle live in narrative.js, which
// precomputes the transition alphas each tick; this path reads them and
// paints, so the same state always yields identical pixels.

const OVERLAY_LINE_HEIGHT = 1.35; // default line height when a style omits `lineHeight`
const OVERLAY_WIDTH_RATIO = 0.7; // default wrap width when a style omits `width`, fraction of canvas width

// The 3x3 alignment grid: row/column indices per authored `align` name.
// Bare-axis names are the centered shorthand (`top` = top-center, `left` =
// center-left, `center` = center-center). The overlay consumes both axes;
// items share the vocabulary but consume only the column (horizontal
// component).
const OVERLAY_ALIGN = {
  'top-left':     { row: 0, col: 0 },
  'top':          { row: 0, col: 1 },
  'top-right':    { row: 0, col: 2 },
  'left':         { row: 1, col: 0 },
  'center':       { row: 1, col: 1 },
  'right':        { row: 1, col: 2 },
  'bottom-left':  { row: 2, col: 0 },
  'bottom':       { row: 2, col: 1 },
  'bottom-right': { row: 2, col: 2 },
};

// Snapshot of the outgoing overlay's last rendered frame (device px), held
// while a crossfade dissolves it over the incoming overlay.
let overlayFxCanvas = null;
let overlayFxCtx = null;
let lastOverlay = null; // overlay drawn last frame — identity change detects replacement

// Captures the overlay canvas into the snapshot buffer. Matching the backing
// store exactly (the assignment also clears); the blit back maps the
// device-px snapshot onto the CSS-px viewport 1:1.
function captureOverlayFrame() {
  if (!overlayFxCtx) {
    overlayFxCanvas = document.createElement('canvas');
    overlayFxCtx = overlayFxCanvas.getContext('2d');
  }
  overlayFxCanvas.width = overlayCanvas.width;
  overlayFxCanvas.height = overlayCanvas.height;
  overlayFxCtx.drawImage(overlayCanvas, 0, 0);
}

// Width a line set occupies at the overlay context's current font: its widest
// line, since lines are drawn from a shared edge.
function measureLineSetWidth(lines) {
  let w = 0;
  for (let i = 0; i < lines.length; i++) w = Math.max(w, overlayCtx.measureText(lines[i]).width);
  return w;
}

// Measures the overlay's items into laid-out entries (text: laid-out lines +
// resolved typography; insert: fitted dimensions), within `room` CSS px of
// horizontal space. `marginsCancel` says an item's own margin buys it no room
// and costs it none, so only the text itself has to fit (see drawOverlayStack).
// An undecoded insert is skipped: it's a preload gap to surface rather than
// mask (see drawWorldSprite). Text needs no such gate — theme fonts load during
// engine init and are awaited before the first scene, so a family is always
// ready by the time any overlay can exist.
function layoutOverlayItems(items, scale, room, marginsCancel) {
  const entries = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    // Only the horizontal component of the shared `align` vocabulary applies
    // to an item (`top-left`/`left`/`bottom-left` → left, and so on).
    const col = (OVERLAY_ALIGN[it.align] || OVERLAY_ALIGN.center).col;
    const align = col === 0 ? 'left' : col === 2 ? 'right' : 'center';
    const margin = (it.margin || 0) * scale;

    if (it.insert !== undefined) {
      const img = it.img; // bound in narrative.setOverlay, like an entity's spriteImg
      if (!img || !img.complete || !img.naturalWidth) continue;
      // One factor on both axes, capped at 1: an insert shrinks to fit the
      // viewport with its aspect intact, and never enlarges past world scale.
      const worldW = img.naturalWidth * scale;
      const worldH = img.naturalHeight * scale;
      const fitFactor = Math.min(1, viewW / worldW, viewH / worldH);
      entries.push({ img: img, w: Math.round(worldW * fitFactor), h: Math.round(worldH * fitFactor),
                     align: align, margin: margin });
      continue;
    }

    // Unknown style names warn at scene load; the draw-time fallback to
    // `default` is silent (no logging in the render loop).
    const style = styles[it.style || 'default'] || styles.default;
    const family = fonts[style.font] || fonts.dialog;
    let fontSize = Math.round(viewH * style.size);
    overlayCtx.font = fontSize + 'px ' + family + ', monospace';

    // `text` is the shared string-or-array shape, and the shape selects the
    // layout: a string is flowed text the engine wraps at the style width, an
    // array is a fixed line set the engine never re-breaks.
    const lines = Array.isArray(it.text)
      ? it.text
      : wrapText(overlayCtx, it.text, viewW * (style.width !== undefined ? style.width : OVERLAY_WIDTH_RATIO));
    let w = measureLineSetWidth(lines);

    // Font size scales off canvas height while the room scales off canvas
    // width, so a portrait viewport can overflow a line set that fits a wide
    // one. Shrink the item to fit instead of re-breaking it: the authored
    // lines then render as authored on every viewport.
    // Loops rather than scaling once: glyph advances don't scale perfectly
    // linearly with font size, so the projected size can still measure a hair
    // over. Terminating — flooring a ratio below 1 drops at least a whole
    // pixel each pass, and the 1 px floor is the last stop when nothing fits.
    const avail = marginsCancel ? room : room - margin;
    while (w > avail && avail > 0 && fontSize > 1) {
      fontSize = Math.max(1, Math.floor(fontSize * avail / w));
      overlayCtx.font = fontSize + 'px ' + family + ', monospace';
      w = measureLineSetWidth(lines);
    }
    const lineHeight = Math.round(fontSize * (style.lineHeight !== undefined ? style.lineHeight : OVERLAY_LINE_HEIGHT));

    entries.push({
      lines:        lines,
      fontSize:     fontSize,
      lineHeight:   lineHeight,
      family:       family,
      color:        colors[it.color] || colors[style.color] || colors.white, // item override → style color
      outlineWidth: style.outlineWidth || 0,
      outlineColor: colors[style.outlineColor] || colors.black,
      w:            w,
      h:            lines.length * lineHeight,
      align:        align,
      margin:       margin,
    });
  }
  return entries;
}

// Lays out and draws the overlay's single item stack. An item's margin pads
// its box on all four sides and adjacent margins simply accumulate — no
// collapsing; the stack's width is its widest item box, and each item aligns
// horizontally within that width (text lines align to the item's own edge, so
// a left-aligned multi-line item reads as a left-set paragraph). The
// overlay's `align` places the stack on the 3x3 grid, its `margin` insets it
// from the screen edges, and `offsetX`/`offsetY` nudge the drawn stack after
// alignment (render-only, like sprite offsets).
function drawOverlayStack(o, scale) {
  const grid = OVERLAY_ALIGN[o.align] || OVERLAY_ALIGN.center;
  const margin = o.margin * scale;

  // Horizontal room for the widest item. A centered stack straddles the
  // viewport centre, so both the overlay margin and the item's own margin fall
  // away symmetrically in the placement below and the text alone has to fit.
  // An edge-aligned stack instead keeps the insets it is aligned against: the
  // overlay margin from the screen edge, the item margin from the stack edge.
  const centered = grid.col === 1;
  const items = layoutOverlayItems(o.items, scale, centered ? viewW : viewW - margin, centered);
  if (items.length === 0) return;

  let stackW = 0, stackH = 0;
  for (let i = 0; i < items.length; i++) {
    stackW = Math.max(stackW, items[i].w + items[i].margin * 2);
    stackH += items[i].h + items[i].margin * 2;
  }

  const boxW = stackW + margin * 2;
  const boxH = stackH + margin * 2;

  const boxLeft = grid.col === 0 ? 0 : grid.col === 1 ? (viewW - boxW) / 2 : viewW - boxW;
  const boxTop = grid.row === 0 ? 0 : grid.row === 1 ? (viewH - boxH) / 2 : viewH - boxH;
  const x = boxLeft + margin + o.offsetX * scale;
  let y = boxTop + margin + o.offsetY * scale;

  overlayCtx.save();
  overlayCtx.globalAlpha = o.contentAlpha;
  overlayCtx.textBaseline = 'middle';
  overlayCtx.lineJoin = 'round';
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const top = y + item.margin;

    if (item.img) {
      const ix = item.align === 'left' ? x + item.margin
        : item.align === 'right' ? x + stackW - item.margin - item.w
        : x + (stackW - item.w) / 2;
      overlayCtx.imageSmoothingEnabled = false;
      overlayCtx.drawImage(item.img, Math.round(ix), Math.round(top), item.w, item.h);
    } else {
      overlayCtx.font = item.fontSize + 'px ' + item.family + ', monospace';
      overlayCtx.fillStyle = item.color;
      overlayCtx.textAlign = item.align;
      const tx = item.align === 'left' ? x + item.margin
        : item.align === 'right' ? x + stackW - item.margin
        : x + stackW / 2;
      if (item.outlineWidth > 0) {
        overlayCtx.lineWidth = item.outlineWidth;
        overlayCtx.strokeStyle = item.outlineColor;
      }
      for (let j = 0; j < item.lines.length; j++) {
        const rowTop = top + j * item.lineHeight;
        const lineY = rowTop + item.lineHeight / 2; // textBaseline is 'middle'
        if (item.outlineWidth > 0) overlayCtx.strokeText(item.lines[j], tx, lineY);
        overlayCtx.fillText(item.lines[j], tx, lineY);
      }
    }

    y += item.h + item.margin * 2;
  }
  overlayCtx.restore();
  overlayCtx.textAlign = 'left';
  overlayCtx.textBaseline = 'alphabetic';
}

/**
 * Renders the active overlay — optional veil, aligned item stack, and the
 * crossfade dissolve of the outgoing overlay's captured frame. No-op when `o`
 * is null.
 */
export function renderOverlay(o) {
  // Replacement bookkeeping BEFORE the clear: a crossfade dissolves the
  // outgoing overlay's last rendered frame, captured off this canvas while
  // last frame's pixels are still on it.
  if (o !== lastOverlay) {
    if (o && o.transition === 'crossfade') captureOverlayFrame();
    lastOverlay = o;
  }

  // Self-clearing: the overlay is its own canvas, so wipe last frame even
  // when there's no active overlay this frame.
  overlayCtx.clearRect(0, 0, viewW, viewH);
  if (!o) return;

  // World scale factor: displayed world height over native world height.
  // Inserts and the world-pixel layout values (`margin`, `offsetX`/`offsetY`)
  // multiply by it, keeping overlay art and spacing at the same pixel density
  // as the world.
  const scale = worldRect().height / CONFIG.world.height;

  if (o.background && o.veilAlpha > 0) {
    overlayCtx.save();
    overlayCtx.globalAlpha = o.veilAlpha;
    overlayCtx.fillStyle = colors[o.background] || colors.black;
    overlayCtx.fillRect(0, 0, viewW, viewH);
    overlayCtx.restore();
  }

  if (o.contentAlpha > 0) drawOverlayStack(o, scale);

  // Crossfade: the outgoing frame dissolves over the fully-rendered incoming
  // overlay, so between two veiled overlays the world is never exposed.
  if (o.transition === 'crossfade' && o.transitionProgress < 1 && overlayFxCanvas) {
    overlayCtx.save();
    overlayCtx.globalAlpha = 1 - o.transitionProgress;
    overlayCtx.drawImage(overlayFxCanvas, 0, 0, viewW, viewH);
    overlayCtx.restore();
  }
}
