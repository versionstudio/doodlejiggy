/**
 * @module world
 * The playable coordinate space: the world layer, its authored extent and clear
 * color, its static geometry, and depth-scale resolution.
 *
 * Owns what the world *is*, never what lives in it. Actors, objects, portals,
 * triggers, and scene lifecycle belong to scene.js.
 */

import CONFIG from './config.js';
import { depthScaleAtY } from './geometry.js';
import { getSprite, ASSET_TYPES } from './sprites.js';

// #app > #world > #backdrop. The backdrop image sits inside the world layer and
// is clipped by it. Both elements stay private to this module; everything else
// reaches the layer through the measurement and write accessors below.
const worldElement = document.createElement('div');
worldElement.id = 'world';
const backdropElement = document.createElement('img');
backdropElement.id = 'backdrop';
backdropElement.alt = '';
worldElement.appendChild(backdropElement);

// ══ World layer ══════════════════════════
//
// The world layer's on-screen rect is the coordinate reference: every
// screen↔native conversion, the camera's scroll bound, and the depth scale
// read it. It carries the camera's translate, so a rect read already reflects
// where the world currently sits on screen.

/** Mounts the world layer inside the scene layer (`#app`). */
export function initWorld(gameEl) {
  gameEl.appendChild(worldElement);
}

/** @returns {DOMRect} The world layer's on-screen rect, camera translate included. */
export function worldRect() {
  return worldElement.getBoundingClientRect();
}

// Layout size, integer-rounded and translate-free. The camera's offset math is
// defined against it, so this is deliberately not the same measurement as
// `worldRect`: swapping one for the other shifts the scroll bound by a
// sub-pixel and drifts the world layer against the sprites drawn over it.
export function worldClientWidth() {
  return worldElement.clientWidth;
}

export function worldClientHeight() {
  return worldElement.clientHeight;
}

/** Scrolls the world layer to `px`. The camera owns the value; the world owns the layer. */
export function setWorldOffset(px) {
  worldElement.style.transform = 'translateX(' + px + 'px)';
}

/** Paints the world's clear color. Takes a resolved CSS color: render.js owns the palette. */
export function setWorldBackground(cssColor) {
  worldElement.style.backgroundColor = cssColor;
}

// ══ Extent ═══════════════════════════════
//
// `CONFIG.world.height` tall, `worldWidth` wide. The extent is authored, never
// inherited from the backdrop — so a narrow world clips its artwork and a wide
// one shows clear color past it.

// For a scene that declares no `width` and has no loadable backdrop. Keeps the
// camera and walk-offs with something finite to clamp against.
const FALLBACK_WORLD_WIDTH = CONFIG.world.height * 2;

let worldWidth = FALLBACK_WORLD_WIDTH;
let worldColor = null;

/** The authored world width, never inferred from the backdrop. */
export function currentWorldWidth() {
  return worldWidth;
}

/** The world's clear color as a palette name, not a resolved value. */
export function currentWorldColor() {
  return worldColor;
}

// ══ Geometry ═════════════════════════════
//
// The world's static geometry, authored per scene: where an actor may stand,
// what they pass behind, and how large they appear with depth. All three hold
// still for the scene's lifetime; nothing here tracks a moving entity.

export let walkablePolygons = [];
export let occluderPolygons = [];
let scalingData = null;

// Depth-scale factor at a y coordinate, lerped between the scene's `near` and
// `far` scaling poles. A scene with no authored poles scales nothing.
function getScaleAtY(y) {
  if (!scalingData) return 1;
  return depthScaleAtY(y, scalingData.near, scalingData.far);
}

/**
 * The scene-scaling factor an entity resolves to. Objects always resolve to 1
 * (they render at their authored size); actors resolve to the depth factor at
 * their y unless `scaling: 'fixed'`, which also resolves to 1. The single
 * authority for an entity's resolved scene scale: render size, hit region,
 * speech/marker anchors, and walk pace all resolve through it.
 */
export function entityScale(entity) {
  return (entity.kind === 'object' || entity.scaling === 'fixed') ? 1 : getScaleAtY(entity.y);
}

export function getScalingData() {
  return scalingData;
}

// ══ Scene load ═══════════════════════════
//
// Two lifecycle points, both driven by `loadScene`. `resetWorld` runs when a
// load begins, so a scene in flight never leaves the previous world's geometry
// live. `applyWorld` runs at the preload barrier, once the backdrop has
// decoded, so the world is settled before anything spawns into it or measures it.

export function resetWorld() {
  worldWidth = FALLBACK_WORLD_WIDTH;
  worldColor = null;
  walkablePolygons = [];
  occluderPolygons = [];
  scalingData = null;
}

/**
 * Applies the world the scene document authors: extent, clear color, backdrop,
 * walkable areas, occluders, and the depth-scale poles. `tag` prefixes the
 * authoring warnings with the source file.
 */
export function applyWorld(sceneData, tag) {
  // Every key this module reads from the scene document.
  const world = sceneData.world || {};
  const { walkableAreas = [], occluders = [], scaling = null } = sceneData;

  // `backdropImage` is the cached asset; `backdropElement` is the layer showing it.
  const backdropImage = world.backdrop ? getSprite(ASSET_TYPES.backdrop, world.backdrop) : null;
  const naturalW = backdropImage ? backdropImage.naturalWidth : 0;
  const naturalH = backdropImage ? backdropImage.naturalHeight : 0;

  worldColor = world.color || null;
  if (typeof world.width === 'number') {
    worldWidth = world.width;
  } else if (naturalW) {
    worldWidth = naturalW;
  } else {
    console.warn(`${tag} world: no \`width\` and no usable backdrop — falling back to ${FALLBACK_WORLD_WIDTH}px.`);
    worldWidth = FALLBACK_WORLD_WIDTH;
  }

  // A hidden backdrop keeps its last `src` — nothing renders, and sprites.js owns the image.
  worldElement.style.aspectRatio = worldWidth + ' / ' + CONFIG.world.height;
  backdropElement.hidden = !backdropImage;
  if (backdropImage) backdropElement.setAttribute('src', backdropImage.src);

  // One image pixel per world pixel, so height isn't a free dimension.
  if (naturalH && naturalH !== CONFIG.world.height) {
    console.warn(`${tag} world.backdrop: "${world.backdrop}" is ${naturalH}px tall but the world is ${CONFIG.world.height}px — scaled to fit.`);
  }

  // Unclosed polygons are authoring work-in-progress: the design tool saves them,
  // the runtime ignores them.
  walkablePolygons = walkableAreas.filter(function (p) { return p.closed !== false; });
  occluderPolygons = occluders.filter(function (p) { return p.closed !== false; });
  scalingData = scaling;
}
