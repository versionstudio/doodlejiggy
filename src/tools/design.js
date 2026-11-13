/**
 * @module tools/design
 * Standalone scene authoring tool.
 *
 * Provides authoring workflows for scene geometry, object placement, scaling
 * lines, portals (entries + exits), hotspots, and exported scene data.
 *
 * Unlike debug.js, design.js operates independently from the live game
 * runtime: it consumes authored definitions and shared schema/domain helpers
 * without a scene running.
 */

import './tools.css';
import CONFIG from '../engine/config.js';
import { screenToNative as geomScreenToNative, nativeToScreen as geomNativeToScreen, pointInPolygon, addPolygonSubpath, polygonsAtSegment, polygonBounds, spriteBounds, worldSpriteSize, clamp, depthScaleAtY, closestPointOnSegment } from '../engine/geometry.js';
import { objectRegistry, objectColumns, objectRows } from '../engine/objects.js';
import { getSprite, ASSET_TYPES } from '../engine/sprites.js';
import { loadRegistries, loadGameDefinition, loadSceneDefinition } from '../engine/registries.js';
import { createStudio } from './studio.js';
import { showModal as openToolModal } from './modal.js';
import { saveToolState, loadToolState } from './persist.js';
import { DRAW_COLORS, labelFontSize, ENTRY_TRIANGLE_H, LABEL_OFFSET_ABOVE,
         drawObjectOverlay, drawToolLabel, drawEntryLabel, drawEntryMarker,
         drawScalingLineLabel, drawInProgressPolygon, drawPolygon } from './drawing.js';
import { buildReferenceIndex } from '../engine/crossref.js';
import ghostUrl from './assets/ghost.png';

const POINT_RADIUS = 6; // vertex marker radius in screen pixels; hover, placement and rendering all measure against it

// ══ Scene model ══════════════════════════

const saved = loadToolState('dj_design');

const layers = {
  walkable: { visible: saved.showWalkable !== false, polygons: [] },
  occluder: { visible: saved.showOccluder !== false, polygons: [] },
  objects:  { visible: saved.showObjects  !== false, items: [] },
  // portals.polygons holds portal-EXIT polygons (round-tripped with extra
  // author fields like title/destination/blocked). Portal ENTRIES live in
  // the separate `portalEntries` array below — they're not polygons.
  // Both share a single `visible` toggle in the design UI.
  portals:  { visible: saved.showPortals  !== false, polygons: [] },
  scaling:  { visible: saved.showScaling  !== false },
};

let portalEntries = [];

let sceneName = '';
let unsaved = false;
let sceneExtras = {}; // fields the design tool doesn't manage (triggers, scripts, etc.) — round-tripped on download

// Authored scenes: game.json lists membership; crossref answers the cross-
// reference questions (which scenes place / scripts reference an object).
// Both populate asynchronously at boot — start empty so early renders are safe.
let sceneNames = [];
let crossIndex = buildReferenceIndex({});

// Depth-scale poles. A scene that authors none still gets draggable reference
// lines, so `scalingAuthored` records whether they came from the scene (or the
// author has since moved one) — save omits the block otherwise rather than
// inventing a `scaling` the author never wrote.
const SCALING_DEFAULTS = {
  near: { y: 260, scale: 1.0 },
  far:  { y: 160, scale: 1.0 }
};
const scalingLines = {
  near: Object.assign({}, SCALING_DEFAULTS.near),
  far:  Object.assign({}, SCALING_DEFAULTS.far)
};
let scalingAuthored = false;

let activeLayer = null; // placement mode; behavior lives in Placement
let snapGrid = !!saved.snapGrid; // snap-to-grid; behavior lives in Editing
let ghostVisible = !!saved.ghostVisible; // ghost toggle; behavior lives in Ghost

// Flags the scene dirty after an edit — drives the unsaved `*` marker, the
// load-picker warning, and the beforeunload guard. Cleared on load and save.
function markUnsaved() {
  unsaved = true;
  updateToolbar();
}

function updateToolbar() {
  studio.get('scene').set(sceneName ? 'scene:' + sceneName + (unsaved ? ' *' : '') : '');
  // With no scene loaded, only LOAD (and info) are usable — the rest is disabled
  // via the toolbar's no-scene state rather than per-handler guards.
  studio.setEnabled(!!sceneName);
}

function saveToolPrefs() {
  saveToolState('dj_design', {
    lastScene: sceneName,
    snapGrid, ghostVisible,
    showWalkable: layers.walkable.visible, showOccluder: layers.occluder.visible,
    showObjects: layers.objects.visible, showPortals: layers.portals.visible,
    showScaling: layers.scaling.visible,
  });
}

// A polygon reference is `{layer, polyIdx}` — the address every editing operation
// works through, carried by hoveredPoint / hoveredEdge / selectedPolygon /
// selectedPoints. The virtual layer name 'obj:<i>' addresses an object's hotspot,
// so the editor names layer polygons and object hotspots the same way and needs no
// separate code path per operation.
//
// The two differ in exactly one fact: the origin their points are measured from.
// Object hotspots store coords relative to the placement origin; every other
// polygon stores absolute scene coords. resolvePoly is the only place that rule
// lives — add the origin to read a point, subtract it to write one.

function isObjLayer(n) {
  return n.startsWith('obj:');
}

function objLayerIdx(n) {
  return parseInt(n.slice(4), 10);
}

// Resolves a reference to the live points array it addresses plus that array's
// origin. The result borrows live state, so it is valid only until the next edit —
// resolve again rather than holding one across a mutation.
function resolvePoly(ref) {
  if (isObjLayer(ref.layer)) {
    const placement = layers.objects.items[objLayerIdx(ref.layer)];
    return { points: placement.hotspot, originX: placement.x, originY: placement.y };
  }
  return { points: layers[ref.layer].polygons[ref.polyIdx].points, originX: 0, originY: 0 };
}

// Reads / writes one vertex of a reference in absolute scene coords — the space
// the pointer works in.
function readPolyPoint(ref) {
  const poly = resolvePoly(ref);
  const p = poly.points[ref.pointIdx];
  return [poly.originX + p[0], poly.originY + p[1]];
}

function writePolyPoint(ref, pt) {
  const poly = resolvePoly(ref);
  poly.points[ref.pointIdx] = [pt[0] - poly.originX, pt[1] - poly.originY];
}

// An object's whole hotspot in absolute scene coords — the same origin rule, applied
// from the object-entity side, where callers hold the item rather than a reference.
function absoluteHotspot(placement) {
  return placement.hotspot.map(function (p) { return [placement.x + p[0], placement.y + p[1]]; });
}

// Every polygon whose vertices the author can currently grab: the visible layers'
// polygons, then the visible objects' hotspots. Each comes back as a polygon
// reference plus its points in absolute scene coords, so the vertex-level operations
// — hover a point, hover an edge, draw the handles — work one list and never revisit
// where a polygon is stored. Body and label drawing stays per-family: those differ
// per family (labels, draw order), and only the vertex layer is uniform.
function editablePolygons() {
  const out = [];
  const layerNames = Object.keys(layers);
  for (let li = 0; li < layerNames.length; li++) {
    const lname = layerNames[li];
    const layer = layers[lname];
    if (!layer.visible || !layer.polygons) continue;
    for (let pi = 0; pi < layer.polygons.length; pi++) {
      const poly = layer.polygons[pi];
      out.push({ layer: lname, polyIdx: pi, points: poly.points, closed: poly.closed });
    }
  }

  if (layers.objects.visible) {
    for (let i = 0; i < layers.objects.items.length; i++) {
      const placement = layers.objects.items[i];
      if (!placement.hotspot) continue;
      out.push({ layer: 'obj:' + i, polyIdx: 0, points: absoluteHotspot(placement), closed: true });
    }
  }
  return out;
}

// Removes the polygon or object entity that owns the given polygon reference.
function removePolyEntity(ref) {
  if (isObjLayer(ref.layer)) {
    const objIdx = objLayerIdx(ref.layer);
    layers.objects.items.splice(objIdx, 1);
    if (selectedObjectIdx === objIdx) selectedObjectIdx = -1;
    else if (selectedObjectIdx > objIdx) selectedObjectIdx--;
  } else {
    layers[ref.layer].polygons.splice(ref.polyIdx, 1);
  }
}

// ══ Actions ══════════════════════════════

const actions = {
  save: downloadFile,
  cancel: handleEscape,
  deleteSel: handleDelete,
  info: showHelpModal,
};

// ══ Toolbar ══════════════════════════════

const SHOW_LAYERS = [
  { key: 'walkable', showId: 'showWalkable', color: DRAW_COLORS.walkable },
  { key: 'occluder', showId: 'showOccluder', color: DRAW_COLORS.occluder },
  { key: 'objects',  showId: 'showObjects',  color: DRAW_COLORS.objects  },
  { key: 'portals',  showId: 'showPortals',  color: DRAW_COLORS.portals  },
  { key: 'scaling',  showId: 'showScaling',  color: DRAW_COLORS.scaling  },
];

const TOOLBAR = [
  { controls: [{ badge: 'design studio' }, { readout: 'scene' }] },
  { label: 'draw', controls: [
      { toggle: 'drawWalkable', text: 'walkable', color: DRAW_COLORS.walkable,
        get: function () { return activeLayer === 'walkable'; },
        set: function (v) { setActiveLayer(v ? 'walkable' : null); } },
      { toggle: 'drawOccluder', text: 'occluder', color: DRAW_COLORS.occluder,
        get: function () { return activeLayer === 'occluder'; },
        set: function (v) { setActiveLayer(v ? 'occluder' : null); } } ] },
  { label: 'place', controls: [
      { toggle: 'drawObjects', text: 'objects', color: DRAW_COLORS.objects,
        get: function () { return activeLayer === 'objects'; },
        set: function (v) { setActiveLayer(v ? 'objects' : null); } },
      { toggle: 'drawPortals', text: 'portals', color: DRAW_COLORS.portals,
        get: function () { return isPortalLayer(activeLayer); },
        set: function (v) { setActiveLayer(v ? 'portals' : null); } } ] },
  { controls: [
      { button: 'snap',  text: snapGrid ? 'SNAP: ON' : 'SNAP: OFF',       onClick: toggleSnap },
      { button: 'ghost', text: ghostVisible ? 'GHOST: ON' : 'GHOST: OFF', onClick: toggleGhost } ] },
  { controls: [
      { button: 'load', text: 'LOAD', opens: 'scenes', alwaysEnabled: true },
      { button: 'save', text: 'SAVE', action: 'save' } ] },
  { spacer: true },
  { label: 'show', controls: SHOW_LAYERS.map(function (l) {
      return { toggle: l.showId, text: l.key, color: l.color,
               get: function () { return layers[l.key].visible; },
               set: function (v) { layers[l.key].visible = v; saveToolPrefs(); render(); } };
  }) },
  { controls: [{ readout: 'coords', text: 'x:---  y:---', fixed: true }] },
  { controls: [{ button: 'info', text: 'ⓘ', icon: true, alwaysEnabled: true, action: 'info' }] },
];

// ══ Pickers ══════════════════════════════

const PICKERS = {
  scenes: {
    heading: 'Load Scene',
    empty: 'no scenes found',
    rows: function () {
      return sceneNames.map(function (name) {
        const isCurrent = name === sceneName;
        return { label: name,
                 tag: isCurrent ? 'current' : undefined,
                 state: isCurrent ? 'current' : 'clickable',
                 onSelect: function () { loadScene(name); } };
      });
    },
    footer: function (panel) {
      if (unsaved) {
        const divider = document.createElement('div');
        divider.className = 'tools-dropdown-divider';
        panel.appendChild(divider);
        const warn = document.createElement('div');
        warn.className = 'tools-dropdown-warn';
        warn.textContent = '* unsaved changes will be lost on switch';
        panel.appendChild(warn);
      }
    },
  },
  objects: {
    group: 'draw',
    heading: 'Place Object',
    search: 'filter objects…',
    relaxed: true,
    rows: objectPickerRows,
    footer: function (panel) {
      if (pendingPlacementObject) {
        const def = objectRegistry[pendingPlacementObject];
        const needsHotspot = !def || !def.sprite;
        const hint = document.createElement('div');
        hint.className = 'tools-dropdown-hint';
        hint.textContent = needsHotspot
          ? 'placing: ' + pendingPlacementObject + '  — click to draw hotspot polygon'
          : 'placing: ' + pendingPlacementObject + '  — click to set origin';
        panel.appendChild(hint);
      }
    },
    onClose: function () { setActiveLayer(null); },
  },
  portals: {
    group: 'draw',
    heading: 'Place Portal',
    rows: function () {
      return [
        { label: 'Entry', tag: 'point', state: activeLayer === 'portalEntry' ? 'selected' : 'clickable', onSelect: function () { setActiveLayer('portalEntry'); } },
        { label: 'Exit',  tag: 'poly',  state: activeLayer === 'portalExit'  ? 'selected' : 'clickable', onSelect: function () { setActiveLayer('portalExit');  } },
      ];
    },
    onClose: function () { setActiveLayer(null); },
  },
};

// ══ Shortcuts ════════════════════════════

const SHORTCUTS = [
  { key: 'Delete', action: 'deleteSel' },
  { key: 'Backspace', action: 'deleteSel' },
  { key: 'Escape', action: 'cancel' },
];

// ══ Composition ══════════════════════════

const studio = createStudio({
  title: 'Doodlejiggy - Design Studio',
  actions: actions,
  toolbar: TOOLBAR,
  pickers: PICKERS,
  shortcuts: SHORTCUTS,
});

// Same layout as the engine (game.js). Hidden until a scene resolves its
// extent, so the no-scene state shows nothing.
const worldElement = document.createElement('div');
worldElement.id = 'world';
worldElement.style.opacity = '0';
const backdropElement = document.createElement('img');
backdropElement.id = 'backdrop';
backdropElement.alt = '';
worldElement.appendChild(backdropElement);
studio.content.appendChild(worldElement);

const cv = studio.createCanvas({ loop: loop, onResize: onResize });
const canvas = cv.canvas;
const ctx = cv.ctx;

// Canvas-label font size for the current viewport; studio owns the viewport size.
function labelSize() {
  return labelFontSize(cv.viewportSize().h);
}

function getRect() {
  return worldElement.getBoundingClientRect();
}

function screenToNative(sx, sy, rect) {
  return geomScreenToNative(sx, sy, rect || getRect(), CONFIG.world.height);
}

function nativeToScreen(nx, ny, rect) {
  return geomNativeToScreen(nx, ny, rect || getRect(), CONFIG.world.height);
}

function getScale() {
  return getRect().height / CONFIG.world.height;
}

// ══ Scene I/O ════════════════════════════

function normalizePoly(poly) {
  return { points: poly.points || [], closed: poly.closed !== undefined ? poly.closed : true };
}

function applySceneData(data) {
  layers.walkable.polygons = (data.walkableAreas || []).map(normalizePoly);
  layers.occluder.polygons = (data.occluders || []).map(normalizePoly);

  portalEntries = [];
  layers.portals.polygons = [];
  if (data.portals) {
    if (data.portals.entries) {
      // Preserve every authored field (facing, walk, …) so a load + save
      // round-trip doesn't clobber JSON-only fields the design UI doesn't expose.
      portalEntries = Object.keys(data.portals.entries).map(function (name) {
        return Object.assign({ name: name }, data.portals.entries[name]);
      });
    }
    if (data.portals.exits) {
      // Hotspot points are stored as ABSOLUTE scene coords (unlike object
      // hotspots which are origin-relative) — portals have no separate origin.
      // Other authored fields (title, destination, blocked) ride along.
      layers.portals.polygons = Object.keys(data.portals.exits).map(function (name) {
        const ex = data.portals.exits[name];
        const out = Object.assign({}, ex, {
          name:   name,
          points: (ex.hotspot || []).map(function (pt) { return [pt[0], pt[1]]; }),
          closed: true,
        });
        delete out.hotspot;
        return out;
      });
    }
  }

  scalingAuthored = !!data.scaling;
  const poles = data.scaling || SCALING_DEFAULTS;
  scalingLines.near.y = poles.near.y;
  scalingLines.near.scale = poles.near.scale;
  scalingLines.far.y = poles.far.y;
  scalingLines.far.scale = poles.far.scale;

  layers.objects.items = [];
  if (data.objects) {
    // Preserve every authored field (if/ifNot, …) so a load + save round-trip
    // doesn't clobber JSON-only fields the design UI doesn't expose. Same
    // pattern as portal entries above.
    Object.keys(data.objects).forEach(function (name) {
      const authored = data.objects[name];
      const placement = Object.assign({}, authored, {
        name:    name,
        hotspot: authored.hotspot ? authored.hotspot.map(function (pt) { return [pt[0], pt[1]]; }) : null,
      });
      layers.objects.items.push(placement);
    });
  }

  // Preserve fields the tool doesn't manage so they survive a download round-trip.
  sceneExtras = {};
  const managed = { scaling: 1, portals: 1, objects: 1, walkableAreas: 1, occluders: 1 };
  Object.keys(data).forEach(function (k) { if (!managed[k]) sceneExtras[k] = data[k]; });
}

// Loads a scene into the editor: its definition, then the world that definition
// authors. A missing or unreadable definition raises the error modal; the loader
// has already reported the cause.
function loadScene(name) {
  setActiveLayer(null);
  offsetX = 0; // open every scene centered; pan is per-scene, not carried across

  return loadSceneDefinition(name).then(function (data) {
    if (!data) { showLoadErrorModal(); return; }
    sceneName = name;
    applySceneData(data);
    applyWorld(sceneExtras.world); // `world` is unmanaged by the editor, so it rides sceneExtras
    unsaved = false;
    saveToolPrefs(); // persist as the scene to restore on next launch
    updateToolbar();
    render();
  });
}

// The scene's world, same model as the engine (world.js § Extent) — so the tool
// measures against the extent the game will use.
const FALLBACK_WORLD_WIDTH = CONFIG.world.height * 2;

let worldWidth = FALLBACK_WORLD_WIDTH;
let authoredWidth = null;

function applyWorld(world) {
  const spec = world || {};
  authoredWidth = typeof spec.width === 'number' ? spec.width : null;
  backdropElement.hidden = !spec.backdrop;
  if (spec.backdrop) backdropElement.setAttribute('src', CONFIG.paths.backdrops + spec.backdrop);
  // Only an unauthored width waits for the image (it comes from naturalWidth);
  // the `load` handler covers that case.
  if (authoredWidth || !spec.backdrop || backdropElement.complete) applyWorldExtent();
}

// Sizes the world layer; also the backdrop `load` handler. Pan range and
// overlays derive from the extent, so both refresh here.
function applyWorldExtent() {
  worldWidth = authoredWidth || backdropElement.naturalWidth || FALLBACK_WORLD_WIDTH;
  worldElement.style.aspectRatio = worldWidth + ' / ' + CONFIG.world.height;
  worldElement.style.opacity = '1';
  updateMaxOffset();
  applyOffset();
  render();
}

// Collapse sentinel — a Private Use Area char JSON.stringify passes through
// verbatim (unlike control chars, which it escapes). Wraps a pre-serialized
// one-line object so it survives `JSON.stringify` as an ordinary string, then
// is unwrapped by a final pass. This avoids regexing object bodies, which would
// break on `[` / `{` / `"` inside string values (e.g. dialogue `text`).
const COLLAPSE_MARK = String.fromCharCode(0xE000);
const COLLAPSE_RE = new RegExp('"' + COLLAPSE_MARK + '(?:\\\\.|[^"\\\\])*"', 'g');

// A "logic leaf" is a script step or trigger (`action` / `on` key) whose values
// are all primitives or flat arrays of primitives — the hand-authored rows we
// want on one line (e.g. a `flagSet` trigger's `flag` string array). A `lines`
// array (`sayRandom`) is excepted: it is multi-line utterance content, not a
// scannable row, so it stays exploded to match the `ambientBarks` block. A
// nested array/object also fails the test; geometry has no `action`/`on` key
// and is untouched.
function isLogicLeaf(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  if (!('action' in v) && !('on' in v)) return false;
  if ('lines' in v) return false;
  return Object.keys(v).every(function (k) {
    const val = v[k];
    if (val === null || typeof val !== 'object') return true;
    return Array.isArray(val) && val.every(function (e) { return e === null || typeof e !== 'object'; });
  });
}

function collapseReplacer(key, value) {
  if (!isLogicLeaf(value)) return value;
  const body = Object.keys(value).map(function (k) {
    return JSON.stringify(k) + ': ' + JSON.stringify(value[k]);
  }).join(', ');
  return COLLAPSE_MARK + '{ ' + body + ' }' + COLLAPSE_MARK;
}

// Hug the opening brace of every array-element object onto its first property
// (`{ "action": …`); a brace-hug thus always signals "list item", while
// property-value and container objects keep the brace on its own line. Scans
// string-aware so `{`/`[`/`"` inside string values (dialogue text) are ignored,
// and skips already-collapsed leaves, which are sentinel-wrapped strings at this
// point. An object is an array element when its enclosing container is an array.
function hugArrayElementBraces(json) {
  const offsets = [];
  const stack = [];
  let inStr = false, esc = false;
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') { if (stack[stack.length - 1] === '[') offsets.push(i); stack.push('{'); }
    else if (c === '[') stack.push('[');
    else if (c === '}' || c === ']') stack.pop();
  }

  // Apply back-to-front so earlier offsets stay valid. Only a multi-line brace
  // has a `{\n` to hug; one-line elements are already hugged and left alone.
  for (let m = offsets.length - 1; m >= 0; m--) {
    const i = offsets[m];
    const head = /^\{\n[ \t]*/.exec(json.slice(i));
    if (head) json = json.slice(0, i) + '{ ' + json.slice(i + head[0].length);
  }
  return json;
}

// Layout passes over the serialized document. Each keys off `JSON.stringify`'s
// own two-space indentation, so the depth in each pattern names the level it
// applies to: indent 2 is a top-level block, indent 4 is one level in.
function formatSceneJson(data) {
  let json = JSON.stringify(data, collapseReplacer, 2);
  json = json.replace(/\[\s*\n\s*([-\d.]+),\s*\n\s*([-\d.]+)\s*\n\s*\]/g, '[$1, $2]'); // every [x, y] pair onto one line
  json = json.replace(/^(  [}\]],)\n(  ")/gm, '$1\n\n$2'); // blank line between top-level blocks
  json = json.replace(/^(    \},)\n(    \{)/gm, '$1\n\n$2'); // blank line between adjacent array elements (polygons)
  json = json.replace(/^(    \},)\n(    ")/gm, '$1\n\n$2'); // blank line between adjacent named members (scripts, placements)
  json = hugArrayElementBraces(json);
  // Unwrap collapsed leaves: each is a JSON string literal beginning with the
  // sentinel. Parse it back to the raw string and drop the two sentinels, leaving
  // the one-line object inline. Done last so the blank-line passes above (which
  // key off exploded `},` boundaries) never see — or separate — these rows.
  json = json.replace(COLLAPSE_RE, function (tok) { return JSON.parse(tok).slice(1, -1); });
  return json;
}

// Assembles the scene document to be written: the geometry the editor owns is
// re-emitted from live state, and every authored field it doesn't manage rides
// through `sceneExtras` untouched.
function buildSceneDocument() {
  const entriesObj = {};
  for (let i = 0; i < portalEntries.length; i++) {
    const ep = portalEntries[i];
    // Preserve any authored fields (facing, walk) that ride on the entry
    // alongside the design-managed x/y.
    const out = Object.assign({}, ep, { x: Math.round(ep.x), y: Math.round(ep.y) });
    delete out.name;
    entriesObj[ep.name] = out;
  }

  const exitsObj = {};
  for (let i = 0; i < layers.portals.polygons.length; i++) {
    const ex = layers.portals.polygons[i];
    if (!ex.name) continue; // unnamed in-progress polygons shouldn't appear here, but defensively skip
    // Round-trip authored fields (title, destination, blocked, …) and emit
    // points as `hotspot` for the JSON schema.
    const out = Object.assign({}, ex, { hotspot: ex.points.map(function (pt) { return [Math.round(pt[0]), Math.round(pt[1])]; }) });
    delete out.points;
    delete out.closed;
    delete out.name;
    exitsObj[ex.name] = out;
  }
  // A scene with no portals at all emits no `portals` block, rather than an empty
  // one the author never wrote.
  const portalsObj = (Object.keys(entriesObj).length || Object.keys(exitsObj).length)
    ? { entries: entriesObj, exits: exitsObj }
    : undefined;

  const objectsObj = {};
  for (let i = 0; i < layers.objects.items.length; i++) {
    const placement = layers.objects.items[i];
    // Start from every preserved authored field; override only the geometry
    // (x/y/hotspot) the design tool actually edits. The `name` is the map key,
    // not a placement field — strip it before emitting.
    const out = Object.assign({}, placement);
    delete out.name;
    out.x = Math.round(placement.x);
    out.y = Math.round(placement.y);
    if (placement.hotspot) out.hotspot = placement.hotspot.map(function (p) { return [p[0], p[1]]; });
    else delete out.hotspot;
    objectsObj[placement.name] = out;
  }

  // Canonical save order: world first, editable metadata next, generated geometry
  // last. Empty blocks are omitted rather than emitted. `world` rides
  // `sceneExtras`; naming it here only pins its position, since key order follows
  // first insertion.
  return Object.assign({
    world: sceneExtras.world,
    scaling: scalingAuthored ? {
      near: { y: Math.round(scalingLines.near.y), scale: scalingLines.near.scale },
      far:  { y: Math.round(scalingLines.far.y),  scale: scalingLines.far.scale  }
    } : undefined,
    portals: portalsObj,
    objects: Object.keys(objectsObj).length ? objectsObj : undefined
  }, sceneExtras, {
    walkableAreas: layers.walkable.polygons.map(function (poly) {
      return { points: poly.points.map(function (pt) { return [pt[0], pt[1]]; }), closed: poly.closed };
    }),
    occluders: layers.occluder.polygons.map(function (poly) {
      return { points: poly.points.map(function (pt) { return [pt[0], pt[1]]; }), closed: poly.closed };
    })
  });
}

function downloadFile() {
  const json = formatSceneJson(buildSceneDocument());
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = sceneName + '.json';
  link.click();
  URL.revokeObjectURL(url);

  unsaved = false;
  updateToolbar();
}

window.addEventListener('beforeunload', function (e) {
  if (unsaved) { e.preventDefault(); e.returnValue = ''; }
});

// ══ Selection & hover ════════════════════

// Two parallel families, one member per editable thing: what the pointer is over
// (`hovered*`, recomputed on every mousemove) and what the author has committed
// to (`selected*`, surviving until clearSelections or a competing pick). "Nothing"
// is spelled differently across them because the identities differ: a reference
// object is `null`, an index into an array is `-1`, and a multi-selection is `[]`.
let hoveredPoint = null;
let hoveredEdge = null;
let hoveredEntry = null;
let hoveredObjectIdx = -1;
let hoveredPolygonRef = null; // {layer, polyIdx} for free polygons (e.g. portal exits); object hotspots use hoveredObjectIdx
let selectedPolygon = null;
let selectedPoints = [];
let selectedEntry = null;
let selectedObjectIdx = -1; // index into layers.objects.items, or -1

function distSq(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

function clearSelections() {
  selectedPolygon = null;
  selectedPoints = [];
  selectedEntry = null;
  selectedObjectIdx = -1;
}

const HOVER_POINT_DISTANCE_SQ = POINT_RADIUS * POINT_RADIUS * 2.25; // cursor-over-vertex hover
const HOVER_EDGE_DISTANCE_SQ = 10 * 10; // cursor-over-edge hover

function findHoveredPoint(sx, sy) {
  const rect = getRect();
  const polys = editablePolygons();
  let best = null;
  let bestDist = HOVER_POINT_DISTANCE_SQ;
  for (let i = 0; i < polys.length; i++) {
    const poly = polys[i];
    for (let vi = 0; vi < poly.points.length; vi++) {
      const sp = nativeToScreen(poly.points[vi][0], poly.points[vi][1], rect);
      const d = distSq(sx, sy, sp.x, sp.y);
      if (d < bestDist) { bestDist = d; best = { layer: poly.layer, polyIdx: poly.polyIdx, pointIdx: vi }; }
    }
  }
  return best;
}

function findHoveredEdge(sx, sy) {
  const rect = getRect();
  const polys = editablePolygons();
  let best = null;
  let bestDist = HOVER_EDGE_DISTANCE_SQ;
  for (let i = 0; i < polys.length; i++) {
    const poly = polys[i];
    const pts = poly.points;
    const numEdges = poly.closed ? pts.length : pts.length - 1;
    for (let ei = 0; ei < numEdges; ei++) {
      const next = (ei + 1) % pts.length;
      const a = nativeToScreen(pts[ei][0], pts[ei][1], rect);
      const b = nativeToScreen(pts[next][0], pts[next][1], rect);
      const d = closestPointOnSegment(sx, sy, a.x, a.y, b.x, b.y).distSq;
      if (d < bestDist) {
        bestDist = d;
        const gx = (pts[ei][0] + pts[next][0]) / 2;
        const gy = (pts[ei][1] + pts[next][1]) / 2;
        best = { layer: poly.layer, polyIdx: poly.polyIdx, edgeIdx: ei, ghostPt: { x: gx, y: gy } };
      }
    }
  }
  return best;
}

// Whole-polygon hover — drives polygon-level selection + drag + delete. Walkable
// and occluder polygons are level geometry, edited via vertex ops only, so they
// are excluded here: otherwise a click inside a walkable polygon would trap
// placement attempts for entries/exits/etc. against an unintended polygon-drag.
// Object hotspots aren't returned either — they're entities with origin + sprite,
// handled by the object-entity system (hoveredObjectIdx + findObjectAt).
function findHoveredPolygon(sx, sy) {
  const native = screenToNative(sx, sy);
  let result = null;
  const layerNames = Object.keys(layers);
  for (let li = 0; li < layerNames.length; li++) {
    const lname = layerNames[li];
    if (lname === 'walkable' || lname === 'occluder') continue;
    const layer = layers[lname];
    if (!layer.visible || !layer.polygons) continue;
    for (let pi = 0; pi < layer.polygons.length; pi++) {
      const poly = layer.polygons[pi];
      if (!poly.closed) continue;
      if (pointInPolygon(native.x, native.y, poly.points)) {
        result = { layer: lname, polyIdx: pi };
      }
    }
  }
  return result;
}

function findHoveredEntry(sx, sy) {
  const rect = getRect();
  let bestDist = HOVER_POINT_DISTANCE_SQ;
  let best = null;
  for (let i = 0; i < portalEntries.length; i++) {
    const sp = nativeToScreen(portalEntries[i].x, portalEntries[i].y, rect);
    const d = distSq(sx, sy, sp.x, sp.y);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

function findObjectAt(sx, sy) {
  const objectHitDistanceSq = 20 * 20; // sprite-less object pick radius
  const rect = getRect();
  for (let i = layers.objects.items.length - 1; i >= 0; i--) {
    const placement = layers.objects.items[i];
    const def = objectRegistry[placement.name];
    if (placement.hotspot) {
      const absHotspot = absoluteHotspot(placement);
      const n = screenToNative(sx, sy, rect);
      if (pointInPolygon(n.x, n.y, absHotspot)) return i;
    } else if (def && def.sprite) {
      const img = getSprite(ASSET_TYPES.sprite, def.sprite);
      if (img.complete && img.naturalWidth) {
        const cols = objectColumns(def);
        const rows = objectRows(def);
        const { w, h } = worldSpriteSize(img.naturalWidth, img.naturalHeight, cols, rows, def.height);
        // Same rule as the runtime hit test (scene.js hitTestObject); scale 1
        // because objects never depth-scale.
        const b = spriteBounds(placement.x, placement.y, w, h, def.offsetX || 0, def.offsetY || 0, 1);
        const tl = nativeToScreen(b.minX, b.minY, rect);
        const br = nativeToScreen(b.maxX, b.maxY, rect);
        if (sx >= tl.x && sx <= br.x && sy >= tl.y && sy <= br.y) return i;
      } else {
        const sp = nativeToScreen(placement.x, placement.y, rect);
        if (distSq(sx, sy, sp.x, sp.y) < objectHitDistanceSq) return i;
      }
    } else {
      const sp = nativeToScreen(placement.x, placement.y, rect);
      if (distSq(sx, sy, sp.x, sp.y) < objectHitDistanceSq) return i;
    }
  }
  return -1;
}

// ══ Editing ══════════════════════════════

// The drag in progress, or null. Only one drag can exist at a time, and this single
// record is how that is stated: mousedown builds one, mouseup is the only thing that
// clears it. Every kind records where the pointer went down (`startScreen`) plus the
// values it started from, so each move applies "original + delta" rather than
// accumulating steps — a pointer that outruns a frame therefore can't drift the
// thing it is moving. The kinds, and what each carries beyond `kind`/`startScreen`:
//
//   point       originals — the selected vertices, each with its starting position
//   polygon     layer, polyIdx, originals — a whole shape's starting points
//   entry       index, orig — a portal entry marker
//   object      index, orig — a placed object
//   ghost       orig — the reference figure (tool-only; never dirties the scene)
//   scaleY      line, origY — a depth-scale pole's position
//   scaleValue  line, origScale — a depth-scale pole's scale factor
let drag = null;

const GRID_SIZE = 4; // snap-to-grid resolution in native units
const EDGE_SNAP_THRESHOLD = 10; // snap to world edge within this many native units
const SCALE_HANDLE_OFFSET_X = 56;
const SCALE_HANDLE_W = 120;
const SCALE_HANDLE_TOLERANCE_Y = 10;
const SCALE_LINE_TOLERANCE_Y = 6;
const SCALE_DRAG_PIXELS_PER_UNIT = 200; // mouse px per 1.0 scale unit during handle drag

function applySnap(native) {
  if (!snapGrid) return { x: native.x, y: native.y };
  const g = GRID_SIZE;
  const worldH = CONFIG.world.height;
  const threshNative = EDGE_SNAP_THRESHOLD / getScale();
  let x = Math.round(native.x / g) * g;
  let y = Math.round(native.y / g) * g;
  if (Math.abs(native.x) < threshNative) x = 0;
  if (Math.abs(native.x - worldWidth) < threshNative) x = worldWidth;
  if (Math.abs(native.y) < threshNative) y = 0;
  if (Math.abs(native.y - worldH) < threshNative) y = worldH;
  return { x: x, y: y };
}

// The two drags that capture a starting shape rather than a single starting point.
// Vertices are captured in absolute scene coords (the space the pointer moves in);
// a whole polygon is captured in its own stored coords, since the move writes the
// same array back and the origin doesn't shift under it.
function startPointDrag(startScreen) {
  drag = {
    kind: 'point',
    startScreen: startScreen,
    originals: selectedPoints.map(function (sp) {
      const pt = readPolyPoint(sp);
      return { layer: sp.layer, polyIdx: sp.polyIdx, pointIdx: sp.pointIdx, ox: pt[0], oy: pt[1] };
    })
  };
}

function startPolygonDrag(startScreen, ref) {
  drag = {
    kind: 'polygon',
    startScreen: startScreen,
    layer: ref.layer,
    polyIdx: ref.polyIdx,
    originals: resolvePoly(ref).points.map(function (p) { return [p[0], p[1]]; })
  };
}

// Applies the drag in progress at the current pointer position. `scale` is screen px
// per native unit, so `dx`/`dy` are the pointer delta in native units — the one
// conversion every kind shares.
function dragTo(e, scale) {
  const dx = (e.clientX - drag.startScreen.x) / scale;
  const dy = (e.clientY - drag.startScreen.y) / scale;

  if (drag.kind === 'point') {
    for (let i = 0; i < drag.originals.length; i++) {
      const orig = drag.originals[i];
      const snapped = applySnap({ x: orig.ox + dx, y: orig.oy + dy });
      writePolyPoint(orig, [snapped.x, snapped.y]);
    }
  } else if (drag.kind === 'polygon') {
    const pts = resolvePoly(drag).points;
    for (let pi = 0; pi < drag.originals.length; pi++) {
      const snapped = applySnap({ x: drag.originals[pi][0] + dx, y: drag.originals[pi][1] + dy });
      pts[pi] = [snapped.x, snapped.y];
    }
  } else if (drag.kind === 'entry') {
    const snapped = applySnap({ x: drag.orig.x + dx, y: drag.orig.y + dy });
    portalEntries[drag.index].x = snapped.x;
    portalEntries[drag.index].y = snapped.y;
  } else if (drag.kind === 'object') {
    const snapped = applySnap({ x: drag.orig.x + dx, y: drag.orig.y + dy });
    layers.objects.items[drag.index].x = snapped.x;
    layers.objects.items[drag.index].y = snapped.y;
  } else if (drag.kind === 'ghost') {
    // The ghost is a reference figure, not authored geometry — it doesn't snap.
    ghostPos.x = drag.orig.x + dx;
    ghostPos.y = drag.orig.y + dy;
  } else if (drag.kind === 'scaleY') {
    scalingLines[drag.line].y = drag.origY + dy;
  } else if (drag.kind === 'scaleValue') {
    // A scale factor isn't a distance, so the handle reads raw screen px at a fixed
    // sensitivity rather than the native-unit delta above.
    const next = drag.origScale + (e.clientX - drag.startScreen.x) / SCALE_DRAG_PIXELS_PER_UNIT;
    scalingLines[drag.line].scale = clamp(Math.round(next * 100) / 100, 0.1, 2.0);
  }
}

function insertEdgePoint(edge) {
  const snapped = applySnap(edge.ghostPt);
  const poly = resolvePoly(edge);
  poly.points.splice(edge.edgeIdx + 1, 0, [snapped.x - poly.originX, snapped.y - poly.originY]);
  markUnsaved();
  hoveredEdge = null;
  render();
}

function isOverScaleHandle(sx, sy) {
  if (!layers.scaling.visible) return null;
  const rect = getRect();
  const names = ['near', 'far'];
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const sp = nativeToScreen(0, scalingLines[name].y, rect);
    const hx = sp.x + SCALE_HANDLE_OFFSET_X;
    if (sx >= hx && sx <= hx + SCALE_HANDLE_W && Math.abs(sy - sp.y) <= SCALE_HANDLE_TOLERANCE_Y) return name;
  }
  return null;
}

function isOverScaleLine(sx, sy) {
  if (!layers.scaling.visible) return null;
  const rect = getRect();
  const names = ['near', 'far'];
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const sp = nativeToScreen(0, scalingLines[name].y, rect);
    if (Math.abs(sy - sp.y) <= SCALE_LINE_TOLERANCE_Y) return name;
  }
  return null;
}

function deleteSelectedPoints() {
  const groups = {};
  for (let i = 0; i < selectedPoints.length; i++) {
    const sp = selectedPoints[i];
    const key = sp.layer + ':' + sp.polyIdx;
    if (!groups[key]) groups[key] = { layer: sp.layer, polyIdx: sp.polyIdx, indices: [] };
    groups[key].indices.push(sp.pointIdx);
  }

  const keys = Object.keys(groups);
  for (let ki = 0; ki < keys.length; ki++) {
    const g = groups[keys[ki]];
    const pts = resolvePoly(g).points;
    g.indices.sort(function (a, b) { return b - a; });
    for (let ii = 0; ii < g.indices.length; ii++) pts.splice(g.indices[ii], 1);
    if (pts.length < 3) removePolyEntity(g);
  }

  selectedPoints = [];
  markUnsaved();
  render();
}

function deleteSelectedPolygon() {
  removePolyEntity(selectedPolygon);
  selectedPolygon = null;
  markUnsaved();
  render();
}

function deleteSelectedPortalEntry() {
  portalEntries.splice(selectedEntry, 1);
  selectedEntry = null;
  markUnsaved();
  render();
}

function deleteSelectedObject() {
  if (selectedObjectIdx < 0) return;
  layers.objects.items.splice(selectedObjectIdx, 1);
  selectedObjectIdx = -1;
  markUnsaved();
  studio.refresh('objects');
  render();
}

// Delete targets the most specific thing under the cursor/selection, in priority
// order. The typing-focus guard lives in the shortcut layer.
function handleDelete() {
  if (selectedEntry !== null) { deleteSelectedPortalEntry(); return; }
  if (selectedPoints.length > 0) { deleteSelectedPoints(); return; }
  if (selectedPolygon) { deleteSelectedPolygon(); return; }
  if (hoveredPoint) { selectedPoints = [hoveredPoint]; deleteSelectedPoints(); return; }
  if (hoveredEntry !== null) { selectedEntry = hoveredEntry; deleteSelectedPortalEntry(); return; }
  if (layers.objects.visible) {
    const hi = mouseScreen ? findObjectAt(mouseScreen.x, mouseScreen.y) : -1;
    const objToDelete = hi >= 0 ? hi : selectedObjectIdx;
    if (objToDelete >= 0) { selectedObjectIdx = objToDelete; deleteSelectedObject(); return; }
  }
  if (hoveredPolygonRef) {
    selectedPolygon = hoveredPolygonRef;
    hoveredPolygonRef = null;
    deleteSelectedPolygon();
  }
}

function toggleSnap() {
  snapGrid = !snapGrid;
  studio.get('snap').setText(snapGrid ? 'SNAP: ON' : 'SNAP: OFF');
  saveToolPrefs();
}

// ══ Placement ════════════════════════════

let drawing = false;
let currentPoints = [];
let pendingPlacementObject = null; // name of object being placed, or null
let placingHotspot = false; // true while drawing hotspot for pending object
let currentHotspotPoints = []; // in-progress hotspot points (native coords)

function isPortalLayer(n) {
  return n === 'portals' || n === 'portalEntry' || n === 'portalExit';
}

// Maps an active-layer mode → the show toggle id + visibility key, so entering a
// placement mode can auto-reveal the relevant layer. portalEntry/portalExit both
// reveal the shared portals toggle.
const SHOW_TARGET_BY_LAYER = {
  walkable:    { key: 'walkable', showId: 'showWalkable' },
  occluder:    { key: 'occluder', showId: 'showOccluder' },
  objects:     { key: 'objects',  showId: 'showObjects'  },
  portals:     { key: 'portals',  showId: 'showPortals'  },
  portalEntry: { key: 'portals',  showId: 'showPortals'  },
  portalExit:  { key: 'portals',  showId: 'showPortals'  },
};

// The draw/place buttons are a radio family keyed by activeLayer; repaint all of
// them whenever it changes.
function updateDrawButtons() {
  studio.get('drawWalkable').setActive(activeLayer === 'walkable');
  studio.get('drawOccluder').setActive(activeLayer === 'occluder');
  studio.get('drawObjects').setActive(activeLayer === 'objects');
  studio.get('drawPortals').setActive(isPortalLayer(activeLayer));
}

function setActiveLayer(name) {
  // Cancel any in-progress drawing or placement
  if (drawing) { drawing = false; currentPoints = []; }
  if (pendingPlacementObject && name !== 'objects') { pendingPlacementObject = null; placingHotspot = false; currentHotspotPoints = []; }

  activeLayer = name;
  updateDrawButtons();

  // Auto-enable visibility for the activated draw layer
  const target = name && SHOW_TARGET_BY_LAYER[name];
  if (target && !layers[target.key].visible) {
    layers[target.key].visible = true;
    studio.get(target.showId).setActive(true);
    saveToolPrefs();
  }

  // Objects / portals modes open their picker, anchored to the toolbar button.
  if (name === 'objects') studio.open('objects', studio.get('drawObjects').el);
  else studio.close('objects');
  if (isPortalLayer(name)) studio.open('portals', studio.get('drawPortals').el);
  else studio.close('portals');

  canvas.style.cursor = 'default';
  render();
}

const CLOSE_DISTANCE_SQ = POINT_RADIUS * POINT_RADIUS * 4; // click-near-start to close polygon

function handleDrawClick(e) {
  const rect = getRect();
  const native = applySnap(screenToNative(e.clientX, e.clientY, rect));
  if (currentPoints.length >= 3) {
    const sp0 = nativeToScreen(currentPoints[0].x, currentPoints[0].y, rect);
    const d = distSq(e.clientX, e.clientY, sp0.x, sp0.y);
    if (d < CLOSE_DISTANCE_SQ) { closePolygon(); return; }
  }
  currentPoints.push(native);
  render();
}

function closePolygon() {
  const poly = {
    points: currentPoints.map(function (p) { return [p.x, p.y]; }),
    closed: true
  };
  if (activeLayer === 'portalExit') {
    poly.name = nextPortalExitName();
    layers.portals.polygons.push(poly);
    setActiveLayer(null);
  } else {
    layers[activeLayer].polygons.push(poly);
  }

  drawing = false;
  currentPoints = [];
  markUnsaved();
  render();
}

// Only reached with a placement in progress (the mousedown dispatch gates on
// `pendingPlacementObject || placingHotspot`, and placing a hotspot implies a
// pending object), so `pendingPlacementObject` is always set here.
function handleObjectLayerClick(e) {
  const native = applySnap(screenToNative(e.clientX, e.clientY));
  const def = objectRegistry[pendingPlacementObject];
  const hasSprite = !!(def && def.sprite);

  if (!hasSprite) {
    // Hotspot-only: draw polygon first, then commit on close
    if (placingHotspot) {
      handleHotspotDrawClick(e, native);
    } else {
      placingHotspot = true;
      currentHotspotPoints = [native];
      render();
    }
  } else {
    // Sprite object: single click to place at origin
    commitObjectPlacement(native.x, native.y, null);
  }
}

function handleHotspotDrawClick(e, native) {
  const rect = getRect();
  if (currentHotspotPoints.length >= 3) {
    const sp0 = nativeToScreen(currentHotspotPoints[0].x, currentHotspotPoints[0].y, rect);
    const d = distSq(e.clientX, e.clientY, sp0.x, sp0.y);
    if (d < CLOSE_DISTANCE_SQ) {
      commitHotspotPolygon();
      return;
    }
  }
  currentHotspotPoints.push(native);
  render();
}

function commitHotspotPolygon() {
  if (currentHotspotPoints.length < 3) return;
  const pts = currentHotspotPoints;
  const b = polygonBounds(pts.map(function (p) { return [p.x, p.y]; }));
  const ox = (b.minX + b.maxX) / 2;
  const oy = b.maxY;
  const rel = pts.map(function (p) { return [p.x - ox, p.y - oy]; });
  commitObjectPlacement(ox, oy, rel);
}

function commitObjectPlacement(ox, oy, hotspot) {
  // Remove existing placement for this name if it's already in this scene
  layers.objects.items = layers.objects.items.filter(function (placement) { return placement.name !== pendingPlacementObject; });
  layers.objects.items.push({ name: pendingPlacementObject, x: ox, y: oy, hotspot: hotspot });
  selectedObjectIdx = layers.objects.items.length - 1;
  pendingPlacementObject = null;
  placingHotspot = false;
  currentHotspotPoints = [];
  markUnsaved();
  studio.refresh('objects');
  setActiveLayer(null);
}

function addPortalEntry(native) {
  portalEntries.push({ name: nextPortalEntryName(), x: native.x, y: native.y });
  // Deactivate placement mode after one placement — matches object placement
  // and exit-polygon completion. Authors who want to place multiple in a row
  // re-open the picker; same cost the object workflow has.
  setActiveLayer(null);
  markUnsaved();
  render();
}

// Picks `entry_N` skipping any existing names — a count-based name could
// collide with a survivor after a deletion, and entries save into a keyed
// map, so a collision silently overwrites the older entry.
function nextPortalEntryName() {
  const taken = {};
  for (let i = 0; i < portalEntries.length; i++) taken[portalEntries[i].name] = 1;
  let i = 0;
  while (taken['entry_' + i]) i++;
  return 'entry_' + i;
}

// Picks `exit_N` skipping any existing names — same pattern as
// `nextPortalEntryName`, for the same overwrite-on-save reason.
function nextPortalExitName() {
  const taken = {};
  for (let i = 0; i < layers.portals.polygons.length; i++) {
    if (layers.portals.polygons[i].name) taken[layers.portals.polygons[i].name] = 1;
  }
  let i = 0;
  while (taken['exit_' + i]) i++;
  return 'exit_' + i;
}

// The scene that already owns an object — this scene, or another scene whose
// objects map lists it — or null if it is unplaced anywhere.
function ownerOf(name) {
  for (let i = 0; i < layers.objects.items.length; i++) {
    if (layers.objects.items[i].name === name) return sceneName || '(this scene)';
  }

  const placing = crossIndex.scenesPlacing(name);
  for (let si = 0; si < placing.length; si++) {
    if (placing[si] !== sceneName) return placing[si];
  }
  return null;
}

// Already-owned objects are disabled (can't be re-placed); the pending one is
// selected. The meta field reports authoring presence from the cross-reference
// index: where it's placed (scene name or "N scenes") and how many scripts
// reference it — each part omitted when absent, so a script-only object reads
// just "N scripts" and an unreferenced one has no meta. No runtime inference —
// ignores flag gates, script reachability, and save state.
function objectPickerRows() {
  return Object.keys(objectRegistry).map(function (name) {
    const owner = ownerOf(name);
    const isPending = pendingPlacementObject === name;
    const def = objectRegistry[name];

    const scenes = crossIndex.scenesPlacing(name);
    const scripts = crossIndex.scriptsReferencing(name);
    const parts = [];
    if (scenes.length) parts.push(scenes.length === 1 ? scenes[0] : scenes.length + ' scenes');
    if (scripts.length) parts.push(scripts.length + (scripts.length === 1 ? ' script' : ' scripts'));

    return {
      label: name,
      tag: def && def.sprite ? 'spr' : 'poly',
      meta: parts.join(' • ') || undefined,
      state: owner ? 'disabled' : (isPending ? 'selected' : 'clickable'),
      onSelect: function () { beginPlacement(name); },
    };
  });
}

function beginPlacement(name) {
  pendingPlacementObject = name;
  placingHotspot = false;
  currentHotspotPoints = [];
  canvas.style.cursor = 'crosshair';
}

// Escape cancels the active in-progress action. Modal and open-picker dismissal
// are handled by their own modules (which consume Escape), so this runs only
// when neither is open.
function handleEscape() {
  if (placingHotspot) { placingHotspot = false; currentHotspotPoints = []; render(); return; }
  if (pendingPlacementObject) { pendingPlacementObject = null; setActiveLayer(null); return; }
  if (drawing) { drawing = false; currentPoints = []; render(); return; }
  if (isPortalLayer(activeLayer)) setActiveLayer(null);
}

// The object registry backs the placement picker; the engine loads and validates it.
loadRegistries().then(function () { studio.refresh('objects'); });

// game.json owns scene membership; load it, then every scene definition, then
// build the cross-reference index the object/scene pickers query. Refresh as each
// piece lands so the UI fills in without blocking startup.
loadGameDefinition()
  .then(function (game) {
    sceneNames = (game && game.scenes) || [];
    studio.refresh('scenes');
    restoreLastScene();
    return loadScenesByName(sceneNames);
  })
  .then(function (scenesByName) {
    crossIndex = buildReferenceIndex(scenesByName);
    studio.refresh('objects'); // object-picker meta (placement/scripts) now resolves
  })
  .catch(function (err) { console.error('[design] failed to build the scene index:', err); });

// Loads every listed scene into a { name: sceneData } map — the input
// buildReferenceIndex expects. A listed scene that fails to load is warned and
// skipped, never fatal.
function loadScenesByName(names) {
  return Promise.all(names.map(function (name) {
    return loadSceneDefinition(name).then(function (data) { return { name: name, data: data }; });
  })).then(function (entries) {
    const scenesByName = {};
    entries.forEach(function (e) {
      if (e.data) scenesByName[e.name] = e.data;
      else console.warn(`[game.json] scene "${e.name}" is listed in scenes but failed to load.`);
    });
    return scenesByName;
  });
}

// Restore the last edited scene if it's still an authored member. An absent or
// removed scene leaves the tool with nothing loaded — only LOAD is usable.
function restoreLastScene() {
  const last = saved.lastScene;
  if (last && sceneNames.includes(last)) loadScene(last);
}

// ══ Ghost ════════════════════════════════

// The ghost's reference character height, in native units. It is a tool-only figure
// for judging perspective and character scale, never a runtime actor, and its image
// supplies only look and aspect. This is the knob to match the ghost to your game's
// character scale.
const GHOST_HEIGHT = 180;

let ghostW = 0; // ghost draw width: GHOST_HEIGHT × image aspect, set once the image loads
let ghostNeedsReset = ghostVisible; // true on restore; reset in render() once layout is ready
const ghostPos = { x: 0, y: 0 }; // dragging it is one of the `drag` kinds under Editing

// The ghost is bundled tool chrome (a Vite import), not a game sprite asset, so
// it never goes through the engine's sprite cache — the tool owns its Image.
const ghostImg = new Image();
ghostImg.src = ghostUrl;
ghostImg.addEventListener('load', function () {
  if (ghostImg.naturalHeight) ghostW = Math.round(GHOST_HEIGHT * ghostImg.naturalWidth / ghostImg.naturalHeight);
  if (ghostVisible && ghostNeedsReset) render(); // retry the deferred restore reset now that ghostW is known (no-op until the world is sized too)
}, { once: true });

function getGhostScale(y) {
  return depthScaleAtY(y, scalingLines.near, scalingLines.far);
}

function isOverGhost(sx, sy) {
  if (!ghostVisible) return false;
  const rect = getRect();
  const scale = getGhostScale(ghostPos.y);
  const b = spriteBounds(ghostPos.x + ghostW / 2, ghostPos.y, ghostW, GHOST_HEIGHT, 0, 0, scale);
  const tl = nativeToScreen(b.minX, b.minY, rect);
  const br = nativeToScreen(b.maxX, b.maxY, rect);
  return sx >= tl.x && sx <= br.x && sy >= tl.y && sy <= br.y;
}

// Matches render.js: unscaled native-coord feet box. Occlusion happens in native space
// regardless of perspective scale, so the ghost occludes exactly as the game would
// render it.
function getGhostOccluders() {
  return polygonsAtSegment(ghostPos.x, ghostPos.x + ghostW, ghostPos.y, layers.occluder.polygons);
}

function drawGhost(rect) {
  const scale = getGhostScale(ghostPos.y);
  // Depth-scaled bounds by the engine's rule; the ghost authors no sprite offsets.
  const b = spriteBounds(ghostPos.x + ghostW / 2, ghostPos.y, ghostW, GHOST_HEIGHT, 0, 0, scale);
  const tl = nativeToScreen(b.minX, b.minY, rect);
  const br = nativeToScreen(b.maxX, b.maxY, rect);
  const w = br.x - tl.x;
  const h = br.y - tl.y;

  ctx.save();
  ctx.globalAlpha = 0.72;
  if (ghostImg.complete && ghostImg.naturalWidth) {
    // Clip to occluders in native space — exactly as the game would hide an actor.
    const activeOccluders = getGhostOccluders();
    if (activeOccluders.length > 0) {
      ctx.beginPath();
      const view = cv.viewportSize();
      ctx.rect(0, 0, view.w, view.h); // logical CSS-px extent; ctx is dpr-scaled
      activeOccluders.forEach(function (poly) {
        addPolygonSubpath(ctx, poly.points, rect, CONFIG.world.height);
      });
      ctx.clip('evenodd');
    }
    ctx.imageSmoothingEnabled = false; // restored by ctx.restore() below
    ctx.drawImage(ghostImg, tl.x, tl.y, w, h);
  } else {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.strokeRect(tl.x, tl.y, w, h);
  }
  ctx.restore();

  ctx.font = labelSize() + 'px ScummSolid, monospace';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.fillText(Math.round(scale * 100) + '%', (tl.x + br.x) / 2, tl.y - 4);
  ctx.textAlign = 'left';
}

// Centers the ghost in the viewport (honoring the current pan), in native coords.
// Derived from pan state rather than the on-screen rect, so it lands identically
// whether triggered by toggle or by restore — where getBoundingClientRect isn't
// yet settled. The world fills the viewport height, so vertical center is the
// scene midline; horizontal center backs out the pan offset (screen px → native).
function resetGhostToCenter() {
  const scale = window.innerHeight / CONFIG.world.height; // screen px per native unit
  const cy = CONFIG.world.height / 2;
  ghostPos.x = (worldWidth / 2 - offsetX / scale) - ghostW / 2;
  ghostPos.y = cy + (GHOST_HEIGHT * getGhostScale(cy)) / 2;
}

function toggleGhost() {
  ghostVisible = !ghostVisible;
  studio.get('ghost').setText(ghostVisible ? 'GHOST: ON' : 'GHOST: OFF');
  if (ghostVisible) ghostNeedsReset = true;
  saveToolPrefs();
  render();
}

// ══ Viewport ═════════════════════════════

let offsetX = 0;
let maxOffset = 0;
let lastAppliedOffset = null;

function updateMaxOffset() {
  const worldScreenW = worldElement.clientWidth;
  const viewW = window.innerWidth;
  maxOffset = Math.max(0, (worldScreenW - viewW) / 2);
  if (offsetX > maxOffset) offsetX = maxOffset;
  if (offsetX < -maxOffset) offsetX = -maxOffset;
}

function applyOffset() {
  if (offsetX === lastAppliedOffset) return;
  worldElement.style.transform = 'translateX(' + offsetX + 'px)';
  lastAppliedOffset = offsetX;
}

const EDGE_ZONE = 160; // px from left/right edge that triggers edge scrolling
const MAX_SPEED  = 8; // px per frame at the deepest edge position

function getEdgeSpeed(x) {
  const viewW = window.innerWidth;
  if (x < EDGE_ZONE) return (1 - x / EDGE_ZONE) * MAX_SPEED;
  if (x > viewW - EDGE_ZONE) return -(1 - (viewW - x) / EDGE_ZONE) * MAX_SPEED;
  return 0;
}

// Studio owns --vh and canvas sizing on resize; design only re-derives the pan
// range and repaints.
function onResize() {
  updateMaxOffset();
  applyOffset();
  render();
}

// Design tool is event-driven — handlers call render() directly when state
// changes. This per-frame hook (driven by studio.createCanvas) only does work to
// edge-scroll when the mouse hovers near a viewport edge.
function loop() {
  if (!mouseScreen) return;
  const speed = getEdgeSpeed(mouseScreen.x);
  if (speed === 0) return;
  offsetX += speed;
  if (offsetX > maxOffset) offsetX = maxOffset;
  if (offsetX < -maxOffset) offsetX = -maxOffset;
  applyOffset();
  render();
}

// ══ Rendering ════════════════════════════

function drawPolygonBody(poly, color, layerName, polyIdx, rect, isHovered) {
  if (poly.points.length < 2) return;
  const isSelected = selectedPolygon &&
    selectedPolygon.layer === layerName &&
    selectedPolygon.polyIdx === polyIdx;
  drawPolygon(ctx, rect, poly.points, CONFIG.world.height,
    { color: color, closed: poly.closed, highlight: isSelected || isHovered });
}

// Grab handles for one polygon's vertices, with per-vertex selection/hover
// chrome. Drawn separately from the body, in the interaction pass. The layer name
// already says which colors apply, so callers don't pass them.
function drawPolygonHandles(points, layerName, polyIdx, rect) {
  const isObj = isObjLayer(layerName);
  const color = isObj ? DRAW_COLORS.objects : DRAW_COLORS[layerName];
  for (let vi = 0; vi < points.length; vi++) {
    const vsp = nativeToScreen(points[vi][0], points[vi][1], rect);
    const isPtHovered = hoveredPoint &&
      hoveredPoint.layer === layerName &&
      hoveredPoint.polyIdx === polyIdx &&
      hoveredPoint.pointIdx === vi;

    let isSelectedPt = false;
    for (let si = 0; si < selectedPoints.length; si++) {
      if (selectedPoints[si].layer === layerName &&
          selectedPoints[si].polyIdx === polyIdx &&
          selectedPoints[si].pointIdx === vi) {
        isSelectedPt = true;
        break;
      }
    }

    const ptHoverColor = isObj ? '#ffffff' : '#ffff55';
    const ptColor = isSelectedPt ? '#ffffff' : (isPtHovered ? ptHoverColor : color);

    ctx.beginPath();
    ctx.arc(vsp.x, vsp.y, POINT_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = ptColor;
    ctx.fill();
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.stroke();
  }
}

function drawPortalEntryMarkers(rect) {
  for (let i = 0; i < portalEntries.length; i++) {
    const ep = portalEntries[i];
    const sp = nativeToScreen(ep.x, ep.y, rect);
    const isSelected = selectedEntry === i;
    const isHovered = hoveredEntry === i;
    const color = (isSelected || isHovered) ? '#ffffff' : DRAW_COLORS.portals;

    drawEntryMarker(ctx, sp, color);
    drawEntryLabel(ctx, '[' + ep.name + ']', sp.x, sp.y - ENTRY_TRIANGLE_H, labelSize());
  }
}

function drawPortalExits(rect) {
  for (let i = 0; i < layers.portals.polygons.length; i++) {
    const ex = layers.portals.polygons[i];
    const isHovered = hoveredPolygonRef !== null &&
                      hoveredPolygonRef.layer === 'portals' &&
                      hoveredPolygonRef.polyIdx === i;
    drawPolygonBody(ex, DRAW_COLORS.portals, 'portals', i, rect, isHovered);
    if (ex.points && ex.points.length >= 3) {
      const b = polygonBounds(ex.points);
      const tp = nativeToScreen((b.minX + b.maxX) / 2, b.minY, rect);
      const label = '[' + (ex.name || '?') + ']';
      drawToolLabel(ctx, label, tp.x, tp.y - LABEL_OFFSET_ABOVE, labelSize(), DRAW_COLORS.portals);
    }
  }
}

const spriteRepaintHooks = new Set(); // sprites whose load already repaints the scene

// The editor renders on demand, so a sprite that decodes after its first draw
// needs one repaint. Hooking per draw would recurse: once `ready` is resolved,
// every draw queues another render. A re-exported PNG needs a page reload — the
// engine caches by URL for the session.
function getObjectSpriteImg(spriteSrc) {
  const img = getSprite(ASSET_TYPES.sprite, spriteSrc);
  if (!spriteRepaintHooks.has(spriteSrc)) {
    spriteRepaintHooks.add(spriteSrc);
    img.ready.then(render);
  }
  return img;
}

function drawObjectImages(rect) {
  const items = layers.objects.items;
  for (let i = 0; i < items.length; i++) {
    const placement = items[i];
    const def = objectRegistry[placement.name];
    if (placement.hotspot || !(def && def.sprite)) continue;
    const img = getObjectSpriteImg(def.sprite);
    if (!img.complete || !img.naturalWidth) continue;
    const cols = objectColumns(def);
    const rows = objectRows(def);
    const { w, h, frameW, frameH } = worldSpriteSize(img.naturalWidth, img.naturalHeight, cols, rows, def.height);
    // The bounds the runtime resolves for this sprite; scale 1 because objects
    // render at their authored size.
    const b = spriteBounds(placement.x, placement.y, w, h, def.offsetX || 0, def.offsetY || 0, 1);
    const tl = nativeToScreen(b.minX, b.minY, rect);
    const br = nativeToScreen(b.maxX, b.maxY, rect);
    const dx = Math.round(tl.x), dy = Math.round(tl.y);
    const dw = Math.round(br.x) - dx, dh = Math.round(br.y) - dy;
    if (dw <= 0 || dh <= 0) continue;
    const srcX = (def.startFrame || 0) * frameW;
    const srcY = (def.row || 0) * frameH;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, srcX, srcY, frameW, frameH, dx, dy, dw, dh);
    ctx.imageSmoothingEnabled = true;
  }
}

function drawObjectPolygonGeometry(rect) {
  const items = layers.objects.items;
  for (let i = 0; i < items.length; i++) {
    const placement = items[i];
    if (!placement.hotspot) continue;
    const absHotspot = absoluteHotspot(placement);
    drawPolygonBody({ points: absHotspot, closed: true }, DRAW_COLORS.objects, 'obj:' + i, 0, rect, hoveredObjectIdx === i);
  }
}

function drawObjectMarkers(rect) {
  const MARKER_FALLBACK_SIZE = 32; // marker extent for an object with no sprite, or one still loading
  const items = layers.objects.items;
  for (let i = 0; i < items.length; i++) {
    const placement = items[i];
    const isSelected = selectedObjectIdx === i;
    const isHovered = hoveredObjectIdx === i;
    const def = objectRegistry[placement.name];
    const label = '[' + placement.name + (placement.if || placement.ifNot ? '*' : '') + ']';
    const hoverColor = isHovered ? '#ffffff' : undefined;

    if (placement.hotspot) {
      const absHotspot = absoluteHotspot(placement);
      const b = polygonBounds(absHotspot);
      const tp = nativeToScreen((b.minX + b.maxX) / 2, b.minY, rect);
      drawToolLabel(ctx, label, tp.x, tp.y - LABEL_OFFSET_ABOVE, labelSize());
    } else if (def && def.sprite) {
      // Corner markers track the sprite-derived interaction bounds, which follow
      // offsetX/Y; the origin crosshair below stays at the authored anchor.
      const img = getObjectSpriteImg(def.sprite);
      const dims = (img.complete && img.naturalWidth)
        ? worldSpriteSize(img.naturalWidth, img.naturalHeight, objectColumns(def), objectRows(def), def.height)
        : { w: MARKER_FALLBACK_SIZE, h: MARKER_FALLBACK_SIZE };
      const bounds = spriteBounds(placement.x, placement.y, dims.w, dims.h, def.offsetX || 0, def.offsetY || 0, 1);
      drawObjectOverlay(ctx, rect, { bounds: bounds }, false, label, CONFIG.world.height, labelSize(), hoverColor);
    } else {
      const bounds = spriteBounds(placement.x, placement.y, MARKER_FALLBACK_SIZE, MARKER_FALLBACK_SIZE, 0, 0, 1);
      drawObjectOverlay(ctx, rect, { bounds: bounds }, false, label, CONFIG.world.height, labelSize(), hoverColor);
    }

    // Origin crosshair
    const sp = nativeToScreen(placement.x, placement.y, rect);
    ctx.save();
    ctx.strokeStyle = (isSelected || isHovered) ? '#ffffff' : DRAW_COLORS.objects;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(sp.x - 5, sp.y); ctx.lineTo(sp.x + 5, sp.y);
    ctx.moveTo(sp.x, sp.y - 5); ctx.lineTo(sp.x, sp.y + 5);
    ctx.stroke();
    ctx.restore();
  }
}

function drawVertexHandles(rect) {
  const polys = editablePolygons();
  for (let i = 0; i < polys.length; i++) {
    drawPolygonHandles(polys[i].points, polys[i].layer, polys[i].polyIdx, rect);
  }
}

// Passive overlay geometry in fixed order: level geometry, scaling reference,
// object annotations, portal annotations.
function drawOverlayGeometry(rect) {
  const geomLayers = ['walkable', 'occluder'];
  for (let li = 0; li < geomLayers.length; li++) {
    const lname = geomLayers[li];
    const layer = layers[lname];
    if (!layer.visible) continue;
    for (let pi = 0; pi < layer.polygons.length; pi++) {
      drawPolygonBody(layer.polygons[pi], DRAW_COLORS[lname], lname, pi, rect);
    }
  }

  if (layers.scaling.visible) {
    const nearColor = drag && drag.line === 'near' ? '#ffffff' : DRAW_COLORS.scaling;
    const farColor  = drag && drag.line === 'far'  ? '#ffffff' : DRAW_COLORS.scaling;
    drawScalingLineLabel(ctx, scalingLines.near, 'near', rect, CONFIG.world.height, worldWidth, labelSize(), nearColor, '  ‹ drag ›');
    drawScalingLineLabel(ctx, scalingLines.far,  'far',  rect, CONFIG.world.height, worldWidth, labelSize(), farColor,  ' ‹ drag ›');
  }

  if (layers.objects.visible) {
    drawObjectPolygonGeometry(rect);
    drawObjectMarkers(rect);
  }

  // Exits (polygons + title labels) before entries, so an entry triangle sitting
  // inside an exit polygon keeps its marker and name on top.
  if (layers.portals.visible) {
    drawPortalExits(rect);
    drawPortalEntryMarkers(rect);
  }
}

// Editing chrome: grab handles for every editable vertex, then the active-action
// feedback (in-progress polygon and hotspot, edge-insertion ghost, pending-
// placement label).
function drawOverlayInteraction(rect) {
  drawVertexHandles(rect);

  if (drawing && currentPoints.length > 0) {
    const drawColor = activeLayer === 'portalExit' ? DRAW_COLORS.portals : (DRAW_COLORS[activeLayer] || DRAW_COLORS.walkable);
    drawInProgressPolygon(ctx, currentPoints, mouseScreen, drawColor, rect, CONFIG.world.height, POINT_RADIUS);
  }
  if (placingHotspot && currentHotspotPoints.length > 0) {
    drawInProgressPolygon(ctx, currentHotspotPoints, mouseScreen, DRAW_COLORS.objects, rect, CONFIG.world.height, POINT_RADIUS);
  }
  // Suppressed while dragging the very geometry it would annotate; other drag kinds
  // leave it alone.
  const geometryDrag = drag && (drag.kind === 'point' || drag.kind === 'polygon');
  if (hoveredEdge && !drawing && !geometryDrag) {
    const ghostRadius = 5; // edge-insertion ghost marker radius
    const gsp = nativeToScreen(hoveredEdge.ghostPt.x, hoveredEdge.ghostPt.y, rect);
    ctx.beginPath();
    ctx.arc(gsp.x, gsp.y, ghostRadius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.stroke();
  }
  if (pendingPlacementObject && mouseScreen) {
    const label = pendingPlacementObject;
    const fontSize = labelSize();
    ctx.font = fontSize + 'px ScummSolid, monospace';
    const boxW = Math.ceil(ctx.measureText(label).width + 28);
    ctx.globalAlpha = 0.5;
    drawToolLabel(ctx, label, mouseScreen.x + boxW / 2, mouseScreen.y);
    ctx.globalAlpha = 1;
  }
}

// Paint order, bottom to top: the world as the game renders it (object sprites,
// then the occluder-clipped, depth-scaled ghost) over the backdrop,
// which is a DOM image behind the canvas; then the overlay's passive geometry,
// which provides authored context; then interaction chrome last, so the thing
// being edited is never obscured.
function render() {
  const rect = getRect();
  // Wait for ghostW — the world always has an extent, so the ghost image is
  // what gates this.
  if (ghostVisible && ghostNeedsReset && ghostW > 0) { resetGhostToCenter(); ghostNeedsReset = false; }
  const view = cv.viewportSize();
  ctx.clearRect(0, 0, view.w, view.h); // logical CSS-px extent; ctx is dpr-scaled

  if (layers.objects.visible) drawObjectImages(rect);
  if (ghostVisible) drawGhost(rect);

  drawOverlayGeometry(rect);
  drawOverlayInteraction(rect);
}

// ══ Input ════════════════════════════════

let mouseScreen = null;

canvas.addEventListener('mousemove', function (e) {
  const rect = getRect();
  mouseScreen = { x: e.clientX, y: e.clientY };
  const native = screenToNative(e.clientX, e.clientY, rect);
  studio.get('coords').set('x:' + Math.round(native.x) + '  y:' + Math.round(native.y));

  if (drag) {
    dragTo(e, rect.height / CONFIG.world.height); // screen px per native unit, from the rect already in hand
    render();
    return;
  }

  if (!drawing) {
    const newHoveredPoint = findHoveredPoint(e.clientX, e.clientY);
    const newHoveredEdge = newHoveredPoint ? null : findHoveredEdge(e.clientX, e.clientY);
    const newHoveredEntry = findHoveredEntry(e.clientX, e.clientY);

    const overGhost = isOverGhost(e.clientX, e.clientY);
    const newHoveredObj = (!overGhost && !pendingPlacementObject && layers.objects.visible)
      ? findObjectAt(e.clientX, e.clientY) : -1;
    // Free-polygon body hover (portal exits) — suppressed in any placement/drawing
    // mode so the visual hover doesn't lie about whether a click would drag vs place.
    // Vertex/edge hover within the same polygon is *not* suppressed (matches the
    // object-hotspot polygon behavior: body stays highlighted while over its own nodes).
    const drawMode = activeLayer === 'walkable' || activeLayer === 'occluder' || activeLayer === 'portalEntry' || activeLayer === 'portalExit' || !!pendingPlacementObject;
    const newHoveredPoly = (!drawMode && !overGhost && newHoveredEntry === null && newHoveredObj < 0)
      ? findHoveredPolygon(e.clientX, e.clientY) : null;

    let changed = false;

    const prevPStr = hoveredPoint ? (hoveredPoint.layer + ':' + hoveredPoint.polyIdx + ':' + hoveredPoint.pointIdx) : '';
    const newPStr = newHoveredPoint ? (newHoveredPoint.layer + ':' + newHoveredPoint.polyIdx + ':' + newHoveredPoint.pointIdx) : '';
    if (prevPStr !== newPStr) changed = true;

    const prevEStr = hoveredEdge ? (hoveredEdge.layer + ':' + hoveredEdge.polyIdx + ':' + hoveredEdge.edgeIdx) : '';
    const newEStr = newHoveredEdge ? (newHoveredEdge.layer + ':' + newHoveredEdge.polyIdx + ':' + newHoveredEdge.edgeIdx) : '';
    if (prevEStr !== newEStr) changed = true;

    const prevPolyStr = hoveredPolygonRef ? (hoveredPolygonRef.layer + ':' + hoveredPolygonRef.polyIdx) : '';
    const newPolyStr = newHoveredPoly ? (newHoveredPoly.layer + ':' + newHoveredPoly.polyIdx) : '';
    if (prevPolyStr !== newPolyStr) changed = true;

    if (hoveredEntry !== newHoveredEntry) changed = true;
    if (hoveredObjectIdx !== newHoveredObj) changed = true;

    hoveredPoint = newHoveredPoint;
    hoveredEdge = newHoveredEdge;
    hoveredEntry = newHoveredEntry;
    hoveredObjectIdx = newHoveredObj;
    hoveredPolygonRef = newHoveredPoly;

    const overSH = !overGhost && isOverScaleHandle(e.clientX, e.clientY);
    const overSL = !overGhost && !overSH && isOverScaleLine(e.clientX, e.clientY);
    canvas.style.cursor = (hoveredPoint || hoveredEntry !== null || overGhost || newHoveredObj >= 0) ? 'grab'
      : hoveredEdge ? 'pointer'
      : hoveredPolygonRef ? 'grab'
      : overSH ? 'ew-resize' : overSL ? 'ns-resize'
      : drawMode ? 'crosshair' : 'default';

    if (changed || placingHotspot || pendingPlacementObject) render();
  } else {
    canvas.style.cursor = 'crosshair';
    render();
  }
});

canvas.addEventListener('mousedown', function (e) {
  e.stopPropagation();
  if (e.button !== 0) return;

  const startScreen = { x: e.clientX, y: e.clientY }; // where this gesture began, if it turns out to be a drag

  if (drawing) {
    handleDrawClick(e);
    return;
  }

  if (pendingPlacementObject || placingHotspot) {
    if (!e.shiftKey) { handleObjectLayerClick(e); }
    return;
  }

  if (isOverGhost(e.clientX, e.clientY)) {
    drag = { kind: 'ghost', startScreen: startScreen, orig: { x: ghostPos.x, y: ghostPos.y } };
    canvas.style.cursor = 'grabbing';
    clearSelections();
    return;
  }

  const overHandle = isOverScaleHandle(e.clientX, e.clientY);
  if (overHandle) {
    drag = { kind: 'scaleValue', startScreen: startScreen, line: overHandle, origScale: scalingLines[overHandle].scale };
    clearSelections();
    return;
  }
  const overLine = isOverScaleLine(e.clientX, e.clientY);
  if (overLine) {
    drag = { kind: 'scaleY', startScreen: startScreen, line: overLine, origY: scalingLines[overLine].y };
    clearSelections();
    return;
  }

  const hp = findHoveredPoint(e.clientX, e.clientY);
  if (hp) {
    if (e.shiftKey) {
      let idx = -1;
      for (let i = 0; i < selectedPoints.length; i++) {
        if (selectedPoints[i].layer === hp.layer &&
            selectedPoints[i].polyIdx === hp.polyIdx &&
            selectedPoints[i].pointIdx === hp.pointIdx) { idx = i; break; }
      }
      if (idx >= 0) selectedPoints.splice(idx, 1);
      else selectedPoints.push(hp);
      selectedPolygon = null;
      selectedEntry = null;
      render();
      return;
    } else {
      selectedPolygon = null;
      selectedEntry = null;
      selectedObjectIdx = -1;
      if (selectedPoints.length <= 1) selectedPoints = [hp];
      startPointDrag(startScreen);
      return;
    }
  }

  const hEdge = findHoveredEdge(e.clientX, e.clientY);
  if (hEdge) {
    insertEdgePoint(hEdge);
    return;
  }

  const he = findHoveredEntry(e.clientX, e.clientY);
  if (he !== null) {
    clearSelections();
    selectedEntry = he;
    drag = { kind: 'entry', startScreen: startScreen, index: he, orig: { x: portalEntries[he].x, y: portalEntries[he].y } };
    return;
  }

  if (!e.shiftKey && !pendingPlacementObject && layers.objects.visible) {
    const idx = findObjectAt(e.clientX, e.clientY);
    if (idx >= 0) {
      clearSelections();
      selectedObjectIdx = idx;
      drag = { kind: 'object', startScreen: startScreen, index: idx, orig: { x: layers.objects.items[idx].x, y: layers.objects.items[idx].y } };
      canvas.style.cursor = 'grabbing';
      render();
      return;
    }
  }

  // Placement modes override whole-polygon selection — a click inside an
  // existing portal exit (or any other draggable polygon) while you're trying
  // to drop an entry/exit/walkable/occluder node should place the node, not
  // grab the underlying polygon.
  const inPlacementMode = activeLayer === 'walkable' || activeLayer === 'occluder'
                       || activeLayer === 'portalEntry' || activeLayer === 'portalExit';
  const hpoly = inPlacementMode ? null : findHoveredPolygon(e.clientX, e.clientY);
  if (hpoly) {
    if (!e.shiftKey) {
      selectedPoints = [];
      selectedEntry = null;
      selectedObjectIdx = -1;
      selectedPolygon = hpoly;
      startPolygonDrag(startScreen, hpoly);
      render();
      return;
    }
  }

  if (!e.shiftKey) {
    clearSelections();
    if (activeLayer === 'portalEntry') {
      const native = applySnap(screenToNative(e.clientX, e.clientY));
      addPortalEntry(native);
    } else if (activeLayer === 'walkable' || activeLayer === 'occluder' || activeLayer === 'portalExit') {
      drawing = true;
      currentPoints = [];
      handleDrawClick(e);
    }
  }
});

canvas.addEventListener('dblclick', function (e) {
  if (placingHotspot && currentHotspotPoints.length >= 3) {
    currentHotspotPoints.pop();
    if (currentHotspotPoints.length >= 3) commitHotspotPolygon();
    return;
  }
  if (drawing && currentPoints.length >= 3) {
    currentPoints.pop();
    if (currentPoints.length >= 3) closePolygon();
  }
});

// Releasing the pointer ends the drag. What the release means differs per kind, and
// each difference is one line here rather than a teardown block of its own.
window.addEventListener('mouseup', function () {
  if (drag) {
    if (drag.kind !== 'ghost') markUnsaved(); // the ghost is tool-only chrome; every other drag moved authored geometry
    if (drag.kind === 'scaleY' || drag.kind === 'scaleValue') scalingAuthored = true; // the author has now positioned the poles, so they save
    if (drag.kind === 'entry') { hoveredEntry = null; selectedEntry = null; }
    if (drag.kind === 'object') hoveredObjectIdx = -1;
    // Entry and scale drags never took the cursor — the hover pass owns it there —
    // so only the kinds that did give it back. Releasing it for them too would leave
    // `default` showing while the pointer is still parked on a handle.
    if (drag.kind !== 'entry' && drag.kind !== 'scaleY' && drag.kind !== 'scaleValue') canvas.style.cursor = 'default';
    drag = null;
  }
  render();
});

canvas.addEventListener('contextmenu', function (e) {
  e.preventDefault();
  if (placingHotspot) { placingHotspot = false; currentHotspotPoints = []; render(); return; }
  if (drawing) { drawing = false; currentPoints = []; render(); }
});

canvas.addEventListener('mouseleave', function () { mouseScreen = null; studio.get('coords').set('x:---  y:---'); });

// ══ Modal ════════════════════════════════

// Operational help, reached from the ⓘ toolbar button. The in-app box is the
// canonical place for drawing/placement/editing instructions (README § Design
// Studio defers to it), so it stays exhaustive.
function showHelpModal() {
  openToolModal(
    '<h2>DESIGN STUDIO — HELP</h2>' +
    '<p>Desktop only. Use a mouse for best results.</p>' +
    '<h3>Drawing</h3><ul>' +
    '<li>Select WALKABLE or OCCLUDER layer, then click to begin a polygon.</li>' +
    '<li>Each click adds a vertex. Click near the first point (or double-click) to close.</li>' +
    '<li>Right-click or <kbd>Esc</kbd> to cancel.</li>' +
    '</ul><h3>Portals</h3><ul>' +
    '<li>Select PORTALS to open the Entry / Exit picker.</li>' +
    '<li><strong>Entry:</strong> click once to place a named entry point (origin — bottom-center). Drag to reposition.</li>' +
    '<li><strong>Exit:</strong> click to draw polygon vertices; click near the first point (or double-click) to close. No sprite — invisible in-game.</li>' +
    '<li>Auto-named <em>entry_0</em>, <em>exit_0</em>, etc. Rename and add <em>title</em> / <em>destination</em> / <em>blocked</em> by editing the JSON.</li>' +
    '<li>No <em>portals.json</em> — portals are scene-local geometry, defined directly in each scene. (Objects, by contrast, are reusable cross-scene entities and live in <em>objects.json</em>.)</li>' +
    '<li><kbd>Delete</kbd> removes the hovered or selected entry, exit polygon, or vertex.</li>' +
    '</ul><h3>Objects</h3><ul>' +
    '<li>Define objects in <em>objects.json</em> first (name, sprite, description, states).</li>' +
    '<li>Select OBJECTS layer to open the picker. Objects already placed in any scene appear with strikethrough and can\'t be selected.</li>' +
    '<li>For sprite objects: click once on the canvas to place the origin (bottom-center).</li>' +
    '<li>For polygon-only objects: click to add hotspot points; click near the first point (or double-click) to close.</li>' +
    '<li>Drag a placed object to reposition. <kbd>Delete</kbd> removes the hovered or selected object.</li>' +
    '</ul><h3>Editing</h3><ul>' +
    '<li>Click a vertex to select and drag to move.</li>' +
    '<li><kbd>Shift</kbd>+Click vertices for multi-selection.</li>' +
    '<li>Hover an edge midpoint and click to insert a vertex.</li>' +
    '<li><kbd>Delete</kbd> / <kbd>Backspace</kbd> removes hovered or selected items. Dropping below 3 vertices removes the whole polygon.</li>' +
    '<li><strong>Drag the whole shape:</strong> portal exits and object hotspots only. Click inside to grab.</li>' +
    '<li><strong>Walkable / occluder polygons:</strong> level geometry — edited via vertices only, not draggable or selectable as a whole. Click inside them in any placement mode (walkable / occluder / portals) to drop a node.</li>' +
    '</ul><h3>Depth Scaling</h3><ul>' +
    '<li>NEAR and FAR lines define perspective scale. Drag the line to reposition.</li>' +
    '<li>Drag the <em>‹ drag ›</em> handle next to the scale label to change the scale value.</li>' +
    '<li>Use GHOST: ON to preview the character at any depth position.</li>' +
    '</ul><h3>Keyboard</h3><ul>' +
    '<li><kbd>Delete</kbd> / <kbd>Backspace</kbd> — Delete hovered or selected</li>' +
    '<li><kbd>Esc</kbd> — Cancel drawing / Close modal</li>' +
    '</ul><h3>File</h3><ul>' +
    '<li>LOAD opens a different scene\'s JSON file.</li>' +
    '<li>SAVE downloads the scene JSON (portals, polygons, scaling, object placements).</li>' +
    '<li>Triggers and scripts are authored manually in the JSON file — design studio does not edit them.</li>' +
    '</ul>'
  );
}

function showLoadErrorModal() {
  openToolModal(
    '<h2>SCENE LOAD FAILED</h2>' +
    '<p>The scene file could not be loaded. Check the browser console for details.</p>'
  );
}

// ══ Init ═════════════════════════════════

function init() {
  updateMaxOffset();

  // A backdrop-derived width can only be read once the image loads.
  backdropElement.addEventListener('load', applyWorldExtent);

  // Paint the toolbar for the opening state: no active draw layer, no scene. The
  // last edited scene is restored once game.json's scene list loads (see
  // restoreLastScene), since validity depends on authored membership.
  updateDrawButtons();
  updateToolbar();
}

init();
