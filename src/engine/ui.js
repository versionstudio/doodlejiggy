/**
 * @module ui
 * Screen-space DOM UI: inventory strip, verb line, dialogue topic list, drag
 * ghost, and the cursor — viewport-fixed chrome, as against the world-space
 * canvas (render.js).
 *
 * A display + gesture layer. State is pushed in through the `set*` functions,
 * user actions emitted back through `initUI`'s callbacks, and coordinates cross
 * as raw screen pixels — it imports no engine state and does no world math.
 *
 * It owns one piece of policy, because the widget is its own: verb-line
 * precedence, inventory drag > inventory hover > scene hover. game.js pushes
 * scene-hover text unconditionally and the inventory channels outrank it.
 */

import './ui.css';

// ══ DOM ══════════════════════════════════
//
// The inventory is a slim always-on strip along the bottom of the screen: a row
// of clickable icons, no toggle. The topic list is a sibling overlay listing the
// active dialogue's visible topics. Both are body-level fixed chrome; the drag
// ghost is created lazily on first drag.

const invStrip = document.createElement('div');
invStrip.className = 'inv-strip';
document.body.appendChild(invStrip);

const invVerbLine = document.createElement('div');
invVerbLine.className = 'inv-verb-line';
document.body.appendChild(invVerbLine);

const dlgTopics = document.createElement('div');
dlgTopics.className = 'dlg-topics';
document.body.appendChild(dlgTopics);

// ══ Wiring ═══════════════════════════════

// Callbacks installed by initUI. ui.js owns the DOM and gestures; game.js owns
// the game logic, so user intent crosses the boundary through these hooks.
let onInventoryTap = null;
let onInventoryDrop = null;
let dragVerbLineFor = null;
let onSelectTopic = null;

// Scene viewport whose cursor reflects hover; installed by initUI.
let gameElement = null;

/**
 * Wire the intent callbacks and the scene viewport. Each handler receives the
 * data ui.js holds and returns nothing, except `dragVerbLineFor` which returns
 * the verb-line string to show:
 *
 * - `onInventoryTap(name)` — a non-drag release on an item.
 * - `onInventoryDrop(name, sx, sy)` — a drag release; game.js resolves the
 *   target at the screen point and dispatches (a drop on nothing is a no-op).
 * - `dragVerbLineFor(objectTitle, sx, sy) → string` — live verb text during a drag.
 * - `onSelectTopic(id)` — a topic row was chosen.
 */
export function initUI(handlers, gameEl) {
  onInventoryTap = handlers.onInventoryTap;
  onInventoryDrop = handlers.onInventoryDrop;
  dragVerbLineFor = handlers.dragVerbLineFor;
  onSelectTopic = handlers.onSelectTopic;
  gameElement = gameEl;
}

// ══ Theme ════════════════════════════════
//
// The verb line and the topic list are the DOM text surfaces, and their engine
// defaults live here as palette keys and font roles like any authored block.
// Names resolve at install rather than at use, because these two surfaces are
// all there is to resolve: unlike the canvas — where the speaking actor, the
// style a script picks, and an overlay item's color override only become known
// at draw time — nothing here is chosen later. ui.css reads plain values.
//
// The split with ui.css is vocabulary against material: font, size, color,
// line height, width, and outline arrive from the theme, while bounds
// (legibility floors, portrait caps), panel treatment, letter spacing, and
// transitions stay in the stylesheet.

const ENGINE_VERB = Object.freeze({
  font:         'solid',
  size:         0.030, // fraction of viewport height
  color:        'white',
  lineHeight:   1.00, // multiple of font size
  width:        1.00, // max text width as fraction of viewport width
  outlineColor: 'black',
  outlineWidth: 0, // CSS px; the panel behind the text carries legibility instead
});
const ENGINE_TOPICS = Object.freeze({
  font:         'solid',
  size:         0.030,
  color:        'white',
  activeColor:  'white',
  lineHeight:   1.15, // room for the fallback family's taller glyphs, so a row with one keeps the list's rhythm
  width:        1.00,
  outlineColor: 'black',
  outlineWidth: 0,
});

/**
 * Installs the interface theme. The palette and font roles are taken as
 * constructed; `verb` and `topics` are flat knob maps merged over the engine
 * defaults above, then resolved into custom properties. Every property is
 * written on every call, so ui.css never needs a property fallback and
 * re-applying is what re-themes a running game.
 *
 * Interface artwork is not part of this: the cursor installs through
 * `setCursor` once its image has decoded.
 */
export function applyTheme(theme) {
  const colors = theme.colors;
  const verb = Object.assign({}, ENGINE_VERB, theme.verb);
  const topics = Object.assign({}, ENGINE_TOPICS, theme.topics);

  applyTextSurface('verb', verb, colors, theme.fonts);
  applyTextSurface('topics', topics, colors, theme.fonts);
  document.documentElement.style.setProperty('--dj-topics-active-color', colors[topics.activeColor] || colors.white);
}

// Writes one surface's resolved knobs as `--dj-<surface>-*`. Ratios stay
// unitless for ui.css to scale against the viewport; the outline is the one
// length. An unknown font role falls back to `dialog`, matching the renderer.
function applyTextSurface(surface, knobs, colors, fonts) {
  const style = document.documentElement.style;
  style.setProperty(`--dj-${surface}-font`, fonts[knobs.font] || fonts.dialog);
  style.setProperty(`--dj-${surface}-size`, knobs.size);
  style.setProperty(`--dj-${surface}-color`, colors[knobs.color] || colors.white);
  style.setProperty(`--dj-${surface}-line-height`, knobs.lineHeight);
  style.setProperty(`--dj-${surface}-width`, knobs.width);
  style.setProperty(`--dj-${surface}-outline-color`, colors[knobs.outlineColor] || colors.black);
  style.setProperty(`--dj-${surface}-outline-width`, knobs.outlineWidth + 'px');
}

// ══ Cursor ═══════════════════════════════
//
// The cursor has two states: resting, and interact while hovering an actionable
// entity. Both arrive from the theme as decoded Images and are turned into CSS
// cursor images here, so the browser draws the cursor itself and it can never
// lag a frame behind the pointer. Like every other interface asset they are
// authored in world pixels, so each is rescaled to the current world scale with
// nearest-neighbour sampling, matching how the renderer scales the room.

const CURSOR_MAX_PX = 32; // above this browsers blank a custom cursor near the content edges, as anti-spoofing
const CURSOR_SETTLE_MS = 120; // resize quiet period before rescaling, so a drag-resize rebuilds once

// A slot pairs one cursor state with the size last generated from it, the gate
// that keeps a resize from rebuilding a pixel-identical image.
const restingCursor = { prop: '--dj-cursor', spec: null, generatedWidth: 0, generatedHeight: 0 };
const hoverCursor = { prop: '--dj-cursor-hover', spec: null, generatedWidth: 0, generatedHeight: 0 };

let cursorScale = 1;
let cursorSettleTimer = null;

/**
 * Installs the theme's cursor as its two states, each `{ img, hotspot }`
 * (hotspot in authored cursor pixels) or null. A hover state without a resting
 * one is ignored: the two are one cursor, and half of it would read as the
 * browser's own cursor inexplicably changing shape.
 */
export function setCursor(cursor, hover) {
  assignCursor(restingCursor, cursor || null);
  assignCursor(hoverCursor, cursor ? hover || null : null);
  buildCursors();
}

/**
 * Tracks the world scale so the cursor holds the room's pixel density. Rebuilds
 * wait for the resize to settle and are skipped when the generated size is
 * unchanged, so a drag-resize costs one image per whole pixel of growth rather
 * than one per frame.
 */
export function setCursorScale(scale) {
  cursorScale = scale;
  clearTimeout(cursorSettleTimer);
  cursorSettleTimer = setTimeout(buildCursors, CURSOR_SETTLE_MS);
}

/**
 * Marks the scene as hovering an actionable entity, switching to the theme's
 * interact cursor. Objects, actors, and exits read the same — the verb line
 * carries the specifics; the cursor only signals "you can act here".
 */
export function setHoverCursor(active) {
  gameElement.classList.toggle('hovering-interactable', active);
}

// The generated size gates rescaling, so a slot taking a new image clears it:
// a replacement that happens to scale to the same size must still be drawn.
function assignCursor(slot, spec) {
  slot.spec = spec;
  slot.generatedWidth = 0;
  slot.generatedHeight = 0;
}

function buildCursors() {
  buildCursor(restingCursor);
  buildCursor(hoverCursor);
}

// Regenerates one slot's CSS cursor at the current scale. An absent or failed
// image clears the property, dropping that state to the browser's own cursor.
function buildCursor(slot) {
  const spec = slot.spec;
  if (!spec || !spec.img.complete || !spec.img.naturalWidth) {
    document.documentElement.style.removeProperty(slot.prop);
    slot.generatedWidth = 0;
    slot.generatedHeight = 0;
    return;
  }

  // Clamp on the longer side: past the ceiling a browser swaps the cursor back
  // to the system one wherever the artwork would reach beyond the page, which
  // costs a band along the bottom and right edges. Better a cursor that holds
  // its size than one that vanishes. The hotspot follows the scale actually
  // used, so it stays where the art put it. Sizes are CSS pixels, which is what
  // the browser rule measures, so the ceiling holds at any device pixel ratio.
  const img = spec.img;
  const scale = Math.min(cursorScale, CURSOR_MAX_PX / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  if (w === slot.generatedWidth && h === slot.generatedHeight) return;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const cursorCtx = canvas.getContext('2d');
  cursorCtx.imageSmoothingEnabled = false;
  cursorCtx.drawImage(img, 0, 0, w, h);

  // The trailing keyword is a required part of the value: without a fallback
  // the whole declaration is invalid and the cursor never changes.
  const hx = Math.round(spec.hotspot[0] * scale);
  const hy = Math.round(spec.hotspot[1] * scale);
  document.documentElement.style.setProperty(slot.prop, `url(${canvas.toDataURL()}) ${hx} ${hy}, auto`);
  slot.generatedWidth = w;
  slot.generatedHeight = h;
}

// ══ Verb line ════════════════════════════
//
// One widget fed by three channels; precedence is drag > inventory hover >
// scene hover. The inventory channels are owned here and applied directly via
// applyVerbLine; the public setVerbLine carries scene-hover text and defers
// while an inventory press/drag or item hover owns the line. Hover is read
// live from the DOM (`:hover`) rather than tracked, so it can't go stale when
// pointerleave is suppressed (items get `pointer-events: none` while inactive).
// The reverse gap — `:hover` not re-firing when the strip reactivates under a
// stationary cursor — is bridged by refreshInventoryHover (coordinate lookup).

function applyVerbLine(text) {
  if (text) {
    invVerbLine.textContent = text;
    invVerbLine.classList.add('visible');
  } else {
    invVerbLine.classList.remove('visible');
  }
}

function hoveredItem() {
  return invStrip.querySelector('.inv-strip-item:hover');
}

/** Scene-hover verb text. Deferred while an inventory press/drag or item hover owns the line. */
export function setVerbLine(text) {
  if (invPressed || hoveredItem()) return;
  applyVerbLine(text);
}

/**
 * Claims the verb line for the inventory item under (x, y), returning whether
 * one was found so the caller can skip a competing scene-hover update.
 *
 * Resolves by coordinate rather than `:hover` for the inactive→active edge: a
 * stationary cursor leaves `:hover` stale until the next real pointer move.
 * setInventoryActive re-enables `pointer-events` before this runs, so
 * elementFromPoint can see the item again.
 */
export function refreshInventoryHover(x, y) {
  if (hoveredItem()) return true; // a surviving `:hover` (parked cursor) already owns the line
  const el = document.elementFromPoint(x, y);
  const item = el && el.closest('.inv-strip-item');
  if (item) applyVerbLine(item.getAttribute('aria-label'));
  return !!item;
}

// ══ Inventory strip ══════════════════════
//
// One gesture at a time: a press on an item is a tap until the pointer travels
// past a small threshold, at which point it becomes a drag carrying a ghost
// icon. `invPressed` is the single record of that live gesture, and
// cancelInventoryDrag is the only path that abandons one.

const DRAG_THRESHOLD_PX = 5; // finger/mouse travel before a press becomes a drag

let invPressed = null; // { name, title, iconEl, startX, startY, itemEl } while a press/drag is live
let invDragging = false;
let invDragGhost = null;
let invActive = true; // the strip's active state; setInventoryActive compares against it to catch the edges

/** Rebuild the strip from `[{ name, title, iconEl }]`, where `iconEl` is a ready-to-display element. */
export function setInventoryItems(items) {
  invStrip.innerHTML = '';
  for (let i = 0; i < items.length; i++) {
    invStrip.appendChild(createInventoryItem(items[i]));
  }
}

export function setInventoryVisible(visible) {
  invStrip.classList.toggle('visible', visible);
}

// Dim/disable the strip when the engine is mid-beat. On the active→inactive edge,
// cancel any in-flight drag and clear the verb line; on inactive→active, restore
// the verb line if the mouse is still resting over an item (its pointerenter
// won't re-fire while the cursor sits still through the engine response).
export function setInventoryActive(active) {
  invStrip.classList.toggle('inactive', !active);
  if (!active) {
    cancelInventoryDrag();
    if (invActive) applyVerbLine(null);
  } else if (!invActive && !invPressed) {
    const hovered = hoveredItem();
    if (hovered) applyVerbLine(hovered.getAttribute('aria-label'));
  }
  invActive = active;
}

// Single authoritative path for aborting a drag without completing it.
// Safe to call any time — no-ops if no press is in progress.
export function cancelInventoryDrag() {
  if (!invPressed) return;
  invPressed.itemEl.classList.remove('dragging');
  hideDragGhost();
  applyVerbLine(null);
  invPressed = null;
  invDragging = false;
}

function createInventoryItem(item) {
  const name = item.name;
  const title = item.title;
  const iconEl = item.iconEl;

  const itemEl = document.createElement('button');
  itemEl.className = 'inv-strip-item';
  itemEl.tabIndex = -1;
  itemEl.setAttribute('aria-label', title);

  // The icon is a pre-rendered element handed in by game.js (a canvas of the
  // item's current sprite frame); append it as-is — this layer never inspects
  // how it was produced.
  if (iconEl) itemEl.appendChild(iconEl);

  // — Hover —

  // Mouse only: touch has no hover, so pointerdown below carries the title instead.
  itemEl.addEventListener('pointerenter', function (e) {
    if (e.pointerType === 'mouse' && !invPressed) applyVerbLine(title);
  });
  itemEl.addEventListener('pointerleave', function (e) {
    if (e.pointerType === 'mouse' && !invPressed) applyVerbLine(null);
  });

  // — Press and drag —

  itemEl.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    invPressed = { name: name, title: title, iconEl: iconEl, startX: e.clientX, startY: e.clientY, itemEl: itemEl };
    invDragging = false;
    applyVerbLine(title);
    itemEl.setPointerCapture(e.pointerId);
  });

  itemEl.addEventListener('lostpointercapture', function () {
    if (invPressed && invPressed.itemEl === itemEl) cancelInventoryDrag();
  });

  itemEl.addEventListener('pointermove', function (e) {
    if (!invPressed || invPressed.itemEl !== itemEl) return;
    if (!invDragging) {
      const dx = e.clientX - invPressed.startX;
      const dy = e.clientY - invPressed.startY;
      if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
      invDragging = true;
      itemEl.classList.add('dragging');
    }
    showDragGhost(invPressed.iconEl, e.clientX, e.clientY);
    applyVerbLine(dragVerbLineFor ? dragVerbLineFor(invPressed.title, e.clientX, e.clientY) : null);
  });

  // — Release —

  function endPress(e) {
    if (!invPressed || invPressed.itemEl !== itemEl) return;

    itemEl.classList.remove('dragging');
    hideDragGhost();
    applyVerbLine(null);

    const pressed = invPressed;
    const dragged = invDragging;
    invPressed = null;
    invDragging = false;

    if (dragged) {
      if (onInventoryDrop) onInventoryDrop(pressed.name, e.clientX, e.clientY);
    } else if (onInventoryTap) {
      onInventoryTap(pressed.name);
    }
  }

  itemEl.addEventListener('pointerup', endPress);
  itemEl.addEventListener('pointercancel', endPress);

  return itemEl;
}

// Translucent copy of the dragged icon that follows the pointer. Copies pixels
// from the strip's icon canvas into a separate ghost canvas, so the original
// stays in the strip showing its `dragging` state.
function showDragGhost(iconEl, x, y) {
  if (!invDragGhost) {
    invDragGhost = document.createElement('canvas');
    invDragGhost.className = 'inv-drag-ghost';
    if (iconEl) {
      invDragGhost.width = iconEl.width;
      invDragGhost.height = iconEl.height;
      invDragGhost.getContext('2d').drawImage(iconEl, 0, 0);
    }
    document.body.appendChild(invDragGhost);
  }

  invDragGhost.style.left = x + 'px';
  invDragGhost.style.top = y + 'px';
}

function hideDragGhost() {
  if (invDragGhost) invDragGhost.remove();
  invDragGhost = null;
}

// ══ Dialogue topic list ══════════════════
//
// Spoken lines render as the canvas speech bubble; this is only the selector.
// Rebuilt only when the visible set changes so click targets stay stable frame
// to frame.

let topicSig = null;

/** Set the visible topics from `[{ id, option }]` (empty array hides the menu). */
export function setTopics(topics) {
  const sig = topics.map(function (t) { return t.id; }).join('|');
  if (sig !== topicSig) {
    topicSig = sig;
    renderTopicRows(topics);
  }
  dlgTopics.classList.toggle('visible', topics.length > 0);
}

function renderTopicRows(topics) {
  dlgTopics.innerHTML = '';
  for (let i = 0; i < topics.length; i++) {
    const topic = topics[i];
    const row = document.createElement('button');
    row.className = 'dlg-topic';
    row.tabIndex = -1;
    const num = document.createElement('span');
    num.className = 'dlg-num';
    num.textContent = (i + 1) + '.';
    row.appendChild(num);
    row.appendChild(document.createTextNode(topic.option));
    row.addEventListener('click', function () { if (onSelectTopic) onSelectTopic(topic.id); });
    dlgTopics.appendChild(row);
  }
}
