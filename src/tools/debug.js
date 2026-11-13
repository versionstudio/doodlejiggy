/**
 * @module tools/debug
 * Runtime inspection tooling.
 *
 * Overlays per-layer geometry, live state panels, and an ad-hoc script runner
 * on the running game, reading live engine state directly from the runtime
 * modules.
 *
 * Hosted tool: it overlays a toolbar on the running game and composes the
 * descriptor-layer modules (toolbar/picker/shortcuts) directly rather than
 * instantiating a Studio.
 *
 * Included only in development builds.
 */

import './tools.css';
import CONFIG from '../engine/config.js';
import { getFlags, setFlag, clearFlag, getObjectOwner,
         getDialogueRecords, dialogueProgress } from '../engine/state.js';
import { getPortalEntries, getPortalExits, currentSceneName, actors,
         objects, objectPlacements, resolveObjectField, getSceneScriptNames, startSceneScript, changeScene } from '../engine/scene.js';
import { walkablePolygons, occluderPolygons, getScalingData, currentWorldWidth,
         worldRect, entityScale } from '../engine/world.js';
import { getRunningScripts, startScript, stopScript } from '../engine/script.js';
import { validateScriptDef } from '../engine/schemas.js';
import { nativeToScreen, screenToNative, worldSpriteSize, spriteBounds } from '../engine/geometry.js';
import { objectRegistry, objectColumns, objectRows } from '../engine/objects.js';
import { getSprite, ASSET_TYPES } from '../engine/sprites.js';
import { loadGameDefinition, loadSceneDefinition } from '../engine/registries.js';
import { onDebugDraw, restart } from '../engine/game.js';
import { viewportSize, debugCtx } from '../engine/render.js';
import { confirmModal } from './modal.js';
import { saveToolState, loadToolState } from './persist.js';
import { DRAW_COLORS, labelFontSize, drawReadoutPanel,
         drawObjectOverlay, drawEntryLabel, drawEntryMarker, drawScalingLineLabel,
         ENTRY_TRIANGLE_H, drawPolygon } from './drawing.js';
import { buildToolbar } from './toolbar.js';
import { pickerGroup } from './picker.js';
import { registerShortcuts } from './shortcuts.js';

// ══ State ════════════════════════════════

const saved = loadToolState('dj_debug');
let visible = !!saved.visible;
let traceOn = !!saved.trace;
let hudOn = !!saved.hud;
const show = {
  walkable: saved.showWalkable !== false,
  occluder: saved.showOccluder !== false,
  objects:  saved.showObjects  !== false,
  portals:  saved.showPortals  !== false,
  scaling:  saved.showScaling  !== false,
};

function saveToggles() {
  saveToolState('dj_debug', {
    visible: visible, trace: traceOn, hud: hudOn,
    showWalkable: show.walkable, showOccluder: show.occluder,
    showObjects: show.objects, showPortals: show.portals,
    showScaling: show.scaling,
  });
}

let mouseScreen = null;
document.addEventListener('mousemove', function (e) { mouseScreen = { x: e.clientX, y: e.clientY }; });
document.addEventListener('mouseleave', function () { mouseScreen = null; });

// Toolbar buttons that badge a live count. Each row owns everything that makes it
// one: the control id, the badge label, where the count comes from, and the count it
// last rendered. `last` is the change latch — updateCountedPanels runs every frame, so
// an open panel re-renders only when its count actually moves — seeded below any real
// count so the first comparison always fires.
const COUNTED_PANELS = [
  { id: 'flags',     label: 'FLAGS',     count: function () { return getFlags().length; },           last: -1 },
  { id: 'dialogues', label: 'DIALOGUES', count: function () { return getDialogueRecords().length; }, last: -1 },
];

// ══ Actions ══════════════════════════════

const actions = {
  // The debug toggle key shows/hides the whole overlay. On hide, close any open
  // dropdown and refresh the badge counts so a later reopen reflects current state.
  // Nothing is open by then, so that call only repaints badges.
  toggle: function () {
    visible = !visible;
    ui.el.style.display = visible ? 'flex' : 'none';
    if (!visible) {
      panels.close();
      updateCountedPanels();
    }
    saveToggles();
  },
  toggleTrace: function () {
    traceOn = !traceOn;
    ui.get('trace').setText(traceOn ? 'TRACE: ON' : 'TRACE: OFF');
    saveToggles();
  },
  toggleHud: function () {
    hudOn = !hudOn;
    ui.get('hud').setText(hudOn ? 'HUD: ON' : 'HUD: OFF');
    saveToggles();
  },
  newGame: function () {
    confirmModal({
      title: 'START OVER',
      body: 'Rewind all progress to the beginning?',
      confirm: 'REWIND',
      onConfirm: restart, // the engine's single restart path
    });
  },
};

// ══ Toolbar ══════════════════════════════

const SHOW_LAYERS = [
  { key: 'walkable', color: DRAW_COLORS.walkable },
  { key: 'occluder', color: DRAW_COLORS.occluder },
  { key: 'objects',  color: DRAW_COLORS.objects  },
  { key: 'portals',  color: DRAW_COLORS.portals  },
  { key: 'scaling',  color: DRAW_COLORS.scaling  },
];

const TOOLBAR = [
  { controls: [{ badge: 'debug mode' }, { readout: 'scene', opens: 'warp' }] },
  { controls: [{ button: 'flags',     text: 'FLAGS (0)',     opens: 'flags'     }] },
  { controls: [{ button: 'dialogues', text: 'DIALOGUES (0)', opens: 'dialogues' }] },
  { controls: [{ button: 'scripts',   text: 'SCRIPTS',       opens: 'scripts'   }] },
  { controls: [{ button: 'run',       text: 'RUN',           opens: 'run'       }] },
  { controls: [{ button: 'hud', text: hudOn ? 'HUD: ON' : 'HUD: OFF', action: 'toggleHud' }] },
  { controls: [{ button: 'trace', text: traceOn ? 'TRACE: ON' : 'TRACE: OFF', action: 'toggleTrace' }] },
  { spacer: true, controls: [{ readout: 'scripts' }] },
  { label: 'show', controls: SHOW_LAYERS.map(function (l) {
      return { toggle: l.key, text: l.key, color: l.color,
               get: function () { return show[l.key]; },
               set: function (v) { show[l.key] = v; saveToggles(); } };
  }) },
  { controls: [{ readout: 'coords', text: 'x:---  y:---', fixed: true }] },
  { controls: [{ button: 'newGame', text: '⏮', icon: true, title: 'New game', action: 'newGame' }] },
];

// ══ Pickers ══════════════════════════════
//
// Flags and Dialogues list one progression record per row with a `x` action
// that clears it (and refreshes the list in place). Scripts lists authored
// scene scripts; clicking a row runs it directly via startSceneScript, bypassing
// trigger gates — intentional for dev iteration. Run is a custom-content form
// (see below). All share one mutual-exclusion group.

const PICKERS = {
  flags: {
    group: 'debug',
    heading: 'Flags',
    empty: '(no flags set)',
    rows: function () {
      return getFlags().slice().sort().map(function (f) {
        return { label: f, action: { glyph: 'x', onClick: function () { clearFlag(f); panels.refresh('flags'); } } };
      });
    },
    footer: buildFlagInput,
  },
  dialogues: {
    group: 'debug',
    heading: 'Dialogues',
    empty: '(no dialogues visited)',
    rows: function () {
      return getDialogueRecords().slice().sort(function (a, b) {
        return (a.actor + a.dialogue).localeCompare(b.actor + b.dialogue);
      }).map(function (r) {
        return { label: r.actor + ' (' + r.dialogue + ')',
                 action: { glyph: 'x', onClick: function () { dialogueProgress(r.actor, r.dialogue).clear(); panels.refresh('dialogues'); } } };
      });
    },
  },
  scripts: {
    group: 'debug',
    heading: 'Run Script',
    empty: '(no scripts in scene)',
    rows: function () {
      return getSceneScriptNames().slice().sort().map(function (n) {
        return { label: n, state: 'clickable', onSelect: function () { startSceneScript(n); } };
      });
    },
  },
  run: {
    group: 'debug',
    heading: 'Run',
    wide: true,
    content: buildRunForm,
  },
  warp: {
    group: 'debug',
    heading: 'Warp To',
    search: 'filter scenes…',
    empty: '(loading scenes…)',
    rows: function () {
      const here = currentSceneName();
      return warpTargets.map(function (t) {
        return { label: t.scene + ' / ' + t.entry,
                 tag: t.scene === here ? 'current' : undefined,
                 state: 'clickable',
                 onSelect: function () { changeScene(t.scene, t.entry); } };
      });
    },
  },
};

// Footer for the Flags panel: a free-text field that sets a flag on Enter. The
// debug toggle key is allowed to bubble to its shortcut (closing the console);
// every other key is swallowed so typing never reaches game controls beneath.
function buildFlagInput(panel) {
  const divider = document.createElement('div');
  divider.className = 'tools-dropdown-divider';
  panel.appendChild(divider);

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'set flag…';
  input.addEventListener('keydown', function (e) {
    if (e.key === CONFIG.controls.debug) { e.preventDefault(); return; }
    e.stopPropagation();
    if (e.key === 'Enter' && input.value.trim()) {
      setFlag(input.value.trim());
      panels.refresh('flags');
    }
  });
  panel.appendChild(input);
  input.focus();
}

// ══ Shortcuts ════════════════════════════

const SHORTCUTS = [
  { key: CONFIG.controls.debug, action: 'toggle', whenTyping: true },
];

// ══ Composition ══════════════════════════

const panels = pickerGroup(PICKERS);
const ui = buildToolbar({ toolbar: TOOLBAR }, { actions: actions, pickers: panels });
document.body.appendChild(ui.el);
ui.el.style.display = visible ? 'flex' : 'none';
registerShortcuts(SHORTCUTS, { actions: actions });

// Draw the overlays off the engine's per-frame seam.
onDebugDraw(debugDraw);

// ══ Toolbar updates ══════════════════════

// Repaints every counted panel's badge, and re-renders the rows of one that is open
// when its count has moved since the last repaint. The only place `LABEL (n)` is spelled.
function updateCountedPanels() {
  for (let i = 0; i < COUNTED_PANELS.length; i++) {
    const p = COUNTED_PANELS[i];
    const n = p.count();
    ui.get(p.id).setText(p.label + ' (' + n + ')');
    if (panels.isOpen(p.id) && n !== p.last) {
      p.last = n;
      panels.refresh(p.id);
    }
  }
}

// Per-frame refresh of the toolbar's live readouts (flag/dialogue counts, scene,
// running scripts, mouse coords). Called from debugDraw each frame.
function updateToolbar(rect) {
  updateCountedPanels();

  ui.get('scene').set('scene:' + currentSceneName());

  // Running scripts as a comma-separated list. When multiple are active, prefix
  // with the count so it remains visible while long names ellipsize.
  const names = getRunningScripts().map(function (r) { return r.cutscene ? r.name + ' (cs)' : r.name; });
  let scriptsText = names.join(', ');
  if (names.length > 1) scriptsText = '(' + names.length + ') ' + scriptsText;
  ui.get('scripts').set(scriptsText);

  if (mouseScreen && rect) {
    const n = screenToNative(mouseScreen.x, mouseScreen.y, rect, CONFIG.world.height);
    ui.get('coords').set('x:' + Math.round(n.x) + '  y:' + Math.round(n.y));
  } else {
    ui.get('coords').set('x:---  y:---');
  }
}

// ══ Run ══════════════════════════════════
//
// Ad-hoc script runner. Paste JSON — a single action, an array of steps, or a
// full { steps, cutscene } def — validate it against the same scriptDef schema
// authored content uses, and execute it through the normal runner under the
// fixed name `__run__`: START replaces any previous ad-hoc run, STOP affects
// only it (never authored scripts). Successful snippets are remembered (raw
// text, last 10) for one-click reload.

const RUN_SCRIPT = '__run__'; // fixed name: START replaces it, STOP targets only it
const RUN_HISTORY_KEY = 'dj_run_history';

// Single parse path shared by START and the history labels — keeping them in
// lockstep so anything that runs also derives a label. Tolerates step rows
// pasted bracket-less from a source `steps: [...]` array (wrap in [] + drop a
// trailing comma). Throws the original error when the text is genuinely not JSON.
function parseRunInput(text) {
  try { return JSON.parse(text); }
  catch (e) {
    try { return JSON.parse('[' + text.trim().replace(/,\s*$/, '') + ']'); }
    catch (e2) { throw e; }
  }
}

// Canonical scriptDef the rest of the runner sees: a single action wraps to a
// one-step list, a bare array becomes the steps, a full def passes through.
// Returns null when the parsed JSON is none of those shapes.
function normalizeRun(parsed) {
  if (Array.isArray(parsed)) return { steps: parsed, cutscene: false };
  if (parsed && parsed.action) return { steps: [parsed], cutscene: false };
  if (parsed && Array.isArray(parsed.steps)) return { steps: parsed.steps, cutscene: !!parsed.cutscene };
  return null;
}

function loadRunHistory() {
  return loadToolState(RUN_HISTORY_KEY).items || [];
}

// Newest first, exact duplicate moved to top, capped at 10. Stores the raw text
// verbatim so reload reproduces exactly what was entered.
function pushRunHistory(text) {
  const items = loadRunHistory().filter(function (t) { return t !== text; });
  items.unshift(text);
  saveToolState(RUN_HISTORY_KEY, { items: items.slice(0, 10) });
}

// Derives a one-line label from the raw snippet at render time — nothing extra
// is stored. First step's action + its primary string arg in quotes, plus `+N`
// for additional steps. Falls back to a truncated first line if the text no
// longer parses (e.g. an action vocabulary that has since changed).
function runHistoryLabel(text) {
  let def = null;
  try { def = normalizeRun(parseRunInput(text)); } catch (e) { def = null; }
  const steps = def && def.steps;
  if (!steps || !steps.length || !steps[0]) return text.split('\n')[0].slice(0, 60);
  const s = steps[0];
  const arg = s.actor || s.object || s.flag || s.name || s.scene;
  const head = s.action + (arg ? '("' + arg + '")' : '');
  const extra = steps.length - 1;
  return extra > 0 ? head + ' +' + extra : head;
}

function renderRunHistory(listEl, ta) {
  listEl.innerHTML = '';
  const items = loadRunHistory();
  if (items.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'tools-label';
    empty.textContent = '(no history)';
    listEl.appendChild(empty);
    return;
  }
  items.forEach(function (text) {
    const row = document.createElement('div');
    row.className = 'tools-dropdown-row clickable';
    row.textContent = runHistoryLabel(text);
    // Load the full raw text back into the editor — never auto-run.
    row.addEventListener('click', function () { ta.value = text; });
    listEl.appendChild(row);
  });
}

// Renders into the Run panel body (the picker supplies the heading). START runs
// without closing the panel — the script plays on the canvas while the panel
// stays put for the next edit — and refreshes the `recent` list in place so the
// just-run snippet appears at top without clearing the editor. STOP is a
// harmless no-op when nothing is running. Both buttons stay enabled, so there is
// no per-frame state tracking.
function buildRunForm(panel) {
  const ta = document.createElement('textarea');
  ta.className = 'tools-textarea';
  ta.spellcheck = false;
  ta.placeholder = 'A script action, an array of steps, or a { steps } definition…';
  // Typing JSON must not reach game controls — but the debug toggle key still
  // closes the console rather than being typed into the editor.
  ta.addEventListener('keydown', function (e) {
    if (e.key === CONFIG.controls.debug) { e.preventDefault(); return; }
    e.stopPropagation();
  });
  panel.appendChild(ta);

  const errEl = document.createElement('div');
  errEl.className = 'tools-error';
  panel.appendChild(errEl);

  function btn(text, onClick) {
    const b = document.createElement('button');
    b.className = 'tools-btn';
    b.tabIndex = -1;
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  }

  const btnRow = document.createElement('div');
  btnRow.className = 'tools-actions';
  btnRow.appendChild(btn('STOP', function () {
    errEl.textContent = '';
    stopScript(RUN_SCRIPT);
  }));
  btnRow.appendChild(btn('START', function () {
    const text = ta.value;
    if (!text.trim()) { errEl.textContent = 'Please enter a script.'; return; }
    let parsed;
    try { parsed = parseRunInput(text); }
    catch (e) { errEl.textContent = 'Invalid JSON: ' + e.message; return; }
    const def = normalizeRun(parsed);
    if (!def) { errEl.textContent = 'Expected an action, an array of steps, or a { steps } object.'; return; }
    const errors = validateScriptDef(def);
    if (errors.length) { errEl.textContent = errors.join('\n'); return; }
    errEl.textContent = '';
    startScript(RUN_SCRIPT, def.steps, def.cutscene);
    pushRunHistory(text);
    renderRunHistory(listEl, ta); // surface the just-run snippet at top without clearing the editor
  }));
  panel.appendChild(btnRow);

  const recent = document.createElement('div');
  recent.className = 'tools-dropdown-heading';
  recent.textContent = 'Recent';
  panel.appendChild(recent);

  const listEl = document.createElement('div');
  listEl.className = 'tools-scroll';
  panel.appendChild(listEl);
  renderRunHistory(listEl, ta);

  ta.focus();
}

// ══ Warp targets ═════════════════════════
//
// The Warp picker's scene/entry catalog. game.json owns scene membership; each
// scene definition's portal entries supply the entry names. Loaded once at boot
// (dev-only tool), so the picker is populated by the time it's first opened.

let warpTargets = []; // [{ scene, entry }], flat over every scene's entries

loadGameDefinition()
  .then(function (game) {
    const names = (game && game.scenes) || [];
    return Promise.all(names.map(function (name) {
      return loadSceneDefinition(name).then(function (data) { return { name: name, data: data }; });
    }));
  })
  .then(function (scenes) {
    scenes.forEach(function (s) {
      const entries = s.data && s.data.portals && s.data.portals.entries;
      Object.keys(entries || {}).forEach(function (entry) {
        warpTargets.push({ scene: s.name, entry: entry });
      });
    });
    panels.refresh('warp');
  })
  .catch(function (err) { console.error('[debug] failed to load warp targets:', err); });

// ══ Layers ═══════════════════════════════

// Dimensions for an unspawned object's overlay. Resolved through the current
// definition/state each frame so state-driven sprite or height changes are
// reflected immediately. Returns null until the sprite has decoded.
function spriteDimsFor(name) {
  const src = resolveObjectField(name, 'sprite');
  if (!src) return null;
  const img = getSprite(ASSET_TYPES.sprite, src);
  if (!img.complete || !img.naturalWidth) return null;
  const def = objectRegistry[name];
  const cols = def ? objectColumns(def) : 1;
  const rows = def ? objectRows(def) : 1;
  return worldSpriteSize(img.naturalWidth, img.naturalHeight, cols, rows, resolveObjectField(name, 'height'));
}

// Walkable + occluder geometry fills and outlines. First in drawLayers so the
// support geometry sits under the other overlays but still above the world.
function drawLayerGeometry(ctx, rect) {
  if (show.walkable) {
    walkablePolygons.forEach(function (poly) {
      drawPolygon(ctx, rect, poly.points, CONFIG.world.height, { color: DRAW_COLORS.walkable });
    });
  }
  if (show.occluder) {
    occluderPolygons.forEach(function (poly) {
      drawPolygon(ctx, rect, poly.points, CONFIG.world.height, { color: DRAW_COLORS.occluder });
    });
  }
}

// The debug overlay is a single diagnostic layer above the world: one fixed
// paint order (geometry → scaling → objects → portals), never occluded by scene
// content, so every layer's geometry stays inspectable. Portals last keeps them
// visible above object overlays.
//
// Every section checks its own `show` toggle, making this the one authority on layer
// visibility — callers draw unconditionally.
function drawLayers(ctx, rect, fontSize) {
  const scaling = getScalingData();
  const worldWidth = currentWorldWidth();

  // Pass-wide, covering both the polygon strokes and the entry-marker triangles.
  ctx.lineJoin = 'round';

  drawLayerGeometry(ctx, rect);

  if (show.scaling && scaling) {
    drawScalingLineLabel(ctx, scaling.near, 'near', rect, CONFIG.world.height, worldWidth, fontSize, DRAW_COLORS.scaling);
    drawScalingLineLabel(ctx, scaling.far, 'far', rect, CONFIG.world.height, worldWidth, fontSize, DRAW_COLORS.scaling);
  }

  // Objects — yellow polygon or bbox + label. Visualizes the union of live
  // objects and declared placements that did not spawn (owner moved,
  // if/ifNot failing), so conditional skips still draw dashed. Runtime
  // spawns exist only in `objects`; `objectPlacements` is a load-time map.
  if (show.objects) {
    const names = Object.keys(objectPlacements);
    Object.keys(objects).forEach(function (name) {
      if (!(name in objectPlacements)) names.push(name);
    });
    for (let i = 0; i < names.length; i++) {
      drawObjectPlacement(names[i], ctx, rect, fontSize);
    }
  }

  // Portals — entries (hollow triangles) and exits (polygon overlays). Drawn
  // last so they sit above object overlays.
  if (show.portals) {
    const entries = getPortalEntries();
    const exits = getPortalExits();
    Object.keys(exits).forEach(function (name) {
      const exit = exits[name];
      if (!Array.isArray(exit.hotspot) || exit.hotspot.length < 3) return;
      drawObjectOverlay(ctx, rect, { hotspot: exit.hotspot }, false, '[' + name + ']', CONFIG.world.height, fontSize, DRAW_COLORS.portals);
    });
    Object.keys(entries).forEach(function (name) {
      const e = entries[name];
      const sp = nativeToScreen(e.x, e.y, rect, CONFIG.world.height);
      drawEntryMarker(ctx, sp, DRAW_COLORS.portals);
      drawEntryLabel(ctx, '[' + name + ']', sp.x, sp.y - ENTRY_TRIANGLE_H, fontSize);
    });
  }

  ctx.textAlign = 'left';
}

function drawObjectPlacement(name, ctx, rect, fontSize) {
  const obj = objects[name];
  const skipped = !obj;

  if (!skipped && obj.visible === false) return;

  // A live object carries its own geometry, so a missing placement is only a
  // no-op when there is nothing live to annotate either.
  const placement = objectPlacements[name];
  if (!placement && skipped) return;

  // Annotate either the live object or its authored placement. Sprite bounds are
  // resolved through `spriteBounds` so overlays use the same geometry as the engine.
  let region;
  if (!skipped && obj.hotspot) {
    region = { hotspot: obj.hotspot };
  } else if (!skipped) {
    const anchorX = obj.anchorX !== undefined ? obj.anchorX : obj.x + obj.w / 2;
    region = { bounds: spriteBounds(anchorX, obj.y, obj.w, obj.h, obj.offsetX, obj.offsetY, 1) };
  } else if (placement.hotspot && placement.hotspot.length >= 3) {
    const absHotspot = placement.hotspot.map(function (p) { return [placement.x + p[0], placement.y + p[1]]; });
    region = { hotspot: absHotspot };
  } else {
    const placeholderSize = 32; // extent fallback when no sprite / hotspot is known
    const dims = spriteDimsFor(name);
    const w = dims ? dims.w : placeholderSize;
    const h = dims ? dims.h : placeholderSize;
    const ox = resolveObjectField(name, 'offsetX') || 0;
    const oy = resolveObjectField(name, 'offsetY') || 0;
    region = { bounds: spriteBounds(placement.x, placement.y, w, h, ox, oy, 1) };
  }

  const conditional = placement && (placement.if || placement.ifNot);
  let labelText = '[' + name + (conditional ? '*' : '') + ']';

  if (skipped) {
    const owner = getObjectOwner(name);
    if (owner !== undefined) labelText += ' > ' + (owner === null ? 'null' : owner);
  }

  drawObjectOverlay(ctx, rect, region, skipped, labelText, CONFIG.world.height, fontSize);
}

// ══ Canvas overlay ═══════════════════════

// What TRACE remembers about each actor between frames, keyed by actor name: the foot
// position it was last seen at and the speed derived from it. Speed is only ever
// measured against that same position, so the two are one record — and one prune drops
// an actor's whole entry when it leaves the scene.
const traced = {};
let fpsEma = 0; // smoothed frames-per-second for the HUD
const TRACE_COLOR = '#55ff55'; // green path/trace overlay (matches the toolbar green)

/**
 * Drawn after world + dialogue: the full diagnostic overlay (geometry fills,
 * scaling lines, object/portal markers, TRACE boxes + paths, HUD) and the
 * per-frame toolbar refresh. Draws on the debug layer, just above the world and
 * fading with it, so a veil covers the diagnostics as it covers the scene.
 * render.js clears that layer each frame, so returning early here is what makes
 * the overlay disappear.
 *
 * `dt` is the engine's own frame delta in seconds — the one thing here the loop
 * knows and this module can't read for itself. It drives TRACE's speed stat and the
 * HUD's FPS, so both report what the simulation actually ran on. Zero means no time
 * passed (a resize repaint), which leaves those stats where they were.
 */
function debugDraw(dt) {
  if (!visible) return;
  const ctx = debugCtx;
  const rect = worldRect();
  updateToolbar(rect);

  const fontSize = labelFontSize(viewportSize().h);
  drawLayers(ctx, rect, fontSize);

  if (traceOn) {
    ctx.save();
    const names = Object.keys(actors);
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const actor = actors[name];
      const cx = actor.x + actor.w / 2;

      // The first frame has no previous position to measure against, so it reports 0.
      // A dt of 0 (a resize repaint) leaves the record — and so the last reading — alone.
      const prev = traced[name];
      if (dt > 0) {
        const dvx = prev ? (cx - prev.cx) / dt : 0;
        const dvy = prev ? (actor.y - prev.y) / dt : 0;
        traced[name] = { cx: cx, y: actor.y, speed: Math.round(Math.sqrt(dvx * dvx + dvy * dvy)) };
      }

      // Pathfinding route: a line through the waypoints with a node dot on each,
      // so the whole path reads as a route rather than scattered points.
      if (actor.path.length > 0) {
        ctx.strokeStyle = TRACE_COLOR;
        ctx.fillStyle = TRACE_COLOR;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let j = 0; j < actor.path.length; j++) {
          const pt = nativeToScreen(actor.path[j].x, actor.path[j].y, rect, CONFIG.world.height);
          if (j === 0) ctx.moveTo(pt.x, pt.y); else ctx.lineTo(pt.x, pt.y);
        }
        ctx.stroke();
        for (let j = 0; j < actor.path.length; j++) {
          const pt = nativeToScreen(actor.path[j].x, actor.path[j].y, rect, CONFIG.world.height);
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Stats box, bottom-anchored to the actor's foot and offset to its right.
      const scale = entityScale(actor);
      const spRight = nativeToScreen(cx + (actor.w * scale) / 2, actor.y, rect, CONFIG.world.height);
      drawReadoutPanel(ctx, spRight.x + 8, spRight.y, [
        'x:' + Math.round(cx),
        'y:' + Math.round(actor.y),
        'spd:' + (traced[name] ? traced[name].speed : 0),
        'sc:' + scale.toFixed(2),
      ], fontSize, true);
    }
    ctx.restore();

    // Prune stale entries from actors that no longer exist (e.g. after a scene change).
    for (const name in traced) if (!actors[name]) delete traced[name];
  }

  if (hudOn) {
    if (dt > 0) {
      // Smoothed, because the raw per-frame rate is far too jittery to read.
      const instantFps = 1 / dt;
      fpsEma = fpsEma ? fpsEma + (instantFps - fpsEma) * 0.1 : instantFps;
    }
    const vp = viewportSize();
    const dpr = window.devicePixelRatio || 1;
    const frameTimeMs = fpsEma ? 1000 / fpsEma : 0;
    // Grouped perf (FPS + heap), then display (res/world/scale).
    const lines = ['FPS ' + Math.round(fpsEma) + ' (' + frameTimeMs.toFixed(1) + 'ms)'];
    // Chrome-only heap size; absent on other engines (e.g. iOS Safari), so shown only when present.
    if (performance.memory) lines.push('mem ' + Math.round(performance.memory.usedJSHeapSize / (1024 * 1024)) + 'MB');
    lines.push(
      'res ' + vp.w + 'x' + vp.h + ' DPR ' + dpr,
      'world ' + currentWorldWidth() + 'x' + CONFIG.world.height,
      'scale x' + (rect.height / CONFIG.world.height).toFixed(2)
    );
    const top = ui.el.getBoundingClientRect().bottom + 8;
    drawReadoutPanel(ctx, 8, top, lines, fontSize);
  }
}
