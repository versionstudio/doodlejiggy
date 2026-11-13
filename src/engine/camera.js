/**
 * @module camera
 * How the world is viewed: the horizontal scroll offset, its bounds, and the
 * two targeting modes that drive it.
 *
 * All camera state lives here, and nothing else holds a copy. It reads scene
 * entities to resolve a target; its reactions to scene lifecycle arrive
 * through the callbacks game.js wires.
 *
 * Horizontal only, because the world is exactly one viewport tall.
 */

import CONFIG from './config.js';
import { clamp } from './geometry.js';
import { actorRegistry } from './actors.js';
import { actors, objects, player } from './scene.js';
import { worldClientWidth, worldClientHeight, setWorldOffset } from './world.js';

// ══ Targeting ════════════════════════════
//
// What the camera aims at, in two mutually exclusive modes. In follow mode it
// tracks a named actor (default: the player), resolving the name through
// `actors` every frame, so targeting an actor before it spawns is valid: the
// camera follows the player until it appears. In fixed-point mode it centers a
// world point instead. Setting either mode cancels the other.

let cameraTarget = null; // follow-mode actor name, or null → player
let cameraFixedX = null; // fixed-point-mode world x, or null → follow mode
let cameraLerp = null; // per-call lerp override; null falls back to CONFIG.camera.lerp

/**
 * Retargets the camera to a named actor. The name must exist in
 * `actorRegistry` (i.e. be declared in `actors.json`) — typos warn. The
 * actor does not need to be currently spawned; the camera resolves the
 * target each frame and falls back to the player while the named actor
 * is missing from the scene.
 *
 * Optional `lerp` overrides `CONFIG.camera.lerp` for the ongoing follow.
 * Resets to the config default whenever the next `cameraFollow` omits it —
 * each call says exactly what it wants; no hidden lerp state persists.
 */
export function setCameraTarget(name, lerp) {
  if (typeof name !== 'string' || !name) {
    console.warn('[cameraFollow] missing or non-string `actor` name.');
    return;
  }
  if (!actorRegistry[name]) {
    console.warn(`[cameraFollow] unknown actor "${name}" (not declared in actors.json).`);
    return;
  }
  cameraTarget = name;
  cameraFixedX = null; // re-enter follow mode, cancelling any fixed-point move
  cameraLerp = (typeof lerp === 'number' && lerp > 0) ? lerp : null;
}

/**
 * Drops a despawned actor as the follow target. The camera does not need this
 * to keep working while the actor is gone — `desiredOffset` already falls back
 * to the player for a target missing from the scene. It exists so the follow
 * does not silently resume if that actor spawns again later: without it, the
 * stale name would match the new instance and recapture the camera.
 */
export function releaseCameraTarget(name) {
  if (cameraTarget === name) cameraTarget = null;
}

/**
 * Backs the `moveCamera` action: switches the camera to fixed-point mode and
 * centers world `x` (bounds-clamped, so it never scrolls past the world edges),
 * cancelling any active follow. The camera lerps to the point via `tickCamera`.
 *
 * The destination is exactly one of a numeric `x`, an `actorName`, or an
 * `objectName`. An entity is resolved once to its current camera anchor
 * (center x) and thereafter behaves identically to a numeric x — a one-shot
 * move, never a continuous follow. A missing or unspawned entity warns and
 * no-ops. Horizontal only (no y): the camera is horizontal-only.
 *
 * Optional `lerp` overrides `CONFIG.camera.lerp` for the move, mirroring
 * `cameraFollow`: a slow value gives a cinematic pan to the point. Resets to
 * the config default whenever the next `moveCamera` omits it.
 */
export function moveCamera(x, actorName, objectName, lerp) {
  let targetX;
  if (typeof x === 'number') {
    targetX = x;
  } else if (actorName !== undefined) {
    const a = actors[actorName];
    if (!a) { console.warn(`[moveCamera] actor "${actorName}" not in scene; ignoring.`); return; }
    targetX = cameraAnchorX(a);
  } else if (objectName !== undefined) {
    const o = objects[objectName];
    if (!o) { console.warn(`[moveCamera] object "${objectName}" not in scene; ignoring.`); return; }
    targetX = cameraAnchorX(o);
  } else {
    console.warn('[moveCamera] requires one of `x`, `actor`, or `object`.');
    return;
  }

  cameraFixedX = targetX;
  cameraLerp = (typeof lerp === 'number' && lerp > 0) ? lerp : null;
}

// World-space x the camera centers on for an entity — an actor's geometric
// center, an object's bottom-center anchor. One definition shared by follow
// mode and `moveCamera`'s actor/object destinations.
function cameraAnchorX(entity) {
  return entity.kind === 'object' ? entity.anchorX : entity.x + entity.w / 2;
}

// ══ Viewport ═════════════════════════════
//
// The window onto the world and where it sits. `offsetX` is a signed horizontal
// scroll of the world layer, bounded by `maxOffset` so neither edge reveals
// off-scene void. One pipeline runs through this section: measure the frame,
// resolve the offset the active mode wants, move toward it, commit it. Every
// change exits through `applyOffset`, which clamps it and writes the layer.

// The scene layer (`#app`), whose box is the visible viewport the world scrolls
// within. The world layer is wider; the difference is the scroll range.
let gameElement = null;

let offsetX = 0;
let maxOffset = 0;
let lastAppliedOffset = null;

export function initCamera(gameEl) {
  gameElement = gameEl;
  updateMaxOffset();
}

/**
 * Re-measures the scroll bound after a viewport size change and reclamps the
 * offset against it. A scene's own extent change is handled by `enterSceneCamera`.
 */
export function refreshCamera() {
  updateMaxOffset();
  applyOffset();
}

function updateMaxOffset() {
  maxOffset = Math.max(0, (worldClientWidth() - gameElement.clientWidth) / 2);
}

// The bounds-clamped offset that puts world `x` mid-viewport. Both the
// fixed-point mode and the scene-enter framing center through here, so there is
// no second, un-clamped centering path.
function centeredOffset(x) {
  const scale = worldClientHeight() / CONFIG.world.height;
  return clamp(worldClientWidth() / 2 - x * scale, -maxOffset, maxOffset);
}

// The offset the active targeting mode wants. Fixed-point mode is evaluated
// first and is player-independent (its target is a world coordinate); follow
// mode needs a subject to track, and with none it holds the current offset.
function desiredOffset() {
  if (cameraFixedX !== null) return centeredOffset(cameraFixedX);

  if (!player) return offsetX;
  // A followed NPC that despawns falls back to the player by design — the lerp
  // toward the player reads as a "pan back" when an NPC walks out an exit.
  const target = (cameraTarget && actors[cameraTarget]) || player;

  const scale = worldClientHeight() / CONFIG.world.height;
  const viewW = gameElement.clientWidth;
  const viewH = gameElement.clientHeight;

  // Where the target sits: first in the world layer's own pixels, then projected
  // onto the screen through the scroll currently applied.
  const targetLayerX = cameraAnchorX(target) * scale;
  const targetScreenX = targetLayerX - maxOffset + offsetX;

  // Portrait gets a wider effective scroll margin — the same ratio on a narrow
  // viewport leaves the player visually close to the edge before camera scroll.
  // Landscape + desktop use the raw config value (multiplier = 1).
  const marginBoost = viewW < viewH ? CONFIG.camera.portraitMarginMultiplier : 1;
  // Effective margin is clamped to half the viewport. Beyond that the left
  // and right trigger zones would overlap and the camera would oscillate
  // between their two targets every frame. The clamp degrades gracefully
  // into a no-dead-zone follow-camera that always tries to centre the target.
  const margin = Math.min(viewW / 2, viewW * CONFIG.camera.scrollMargin * marginBoost);

  // The projection above, solved for the offset: the scroll that would park the
  // target on the near or far margin of the dead zone.
  const leftMarginOffset = clamp(margin - targetLayerX + maxOffset, -maxOffset, maxOffset);
  const rightMarginOffset = clamp(viewW - margin - targetLayerX + maxOffset, -maxOffset, maxOffset);

  // Past either margin, scroll just enough to pin the target to the one it
  // crossed. Inside the dead zone between them, hold still.
  if (targetScreenX < margin) {
    return leftMarginOffset;
  }
  if (targetScreenX > viewW - margin) {
    return rightMarginOffset;
  }
  return offsetX;
}

/**
 * Tick hook — eases the offset toward what the active mode wants, frozen during
 * the player's portal walk-in so the entry stays centered. Runs without a
 * player: fixed-point mode is player-independent, and follow mode with no
 * subject holds the current offset.
 */
export function tickCamera(dt) {
  // Freeze pairs with the scene-enter framing on the player's entry — the
  // camera is already where we want it, and holding it still while the player
  // walks in from offscreen prevents a chase shot. NPC walk-ins under
  // `cameraFollow` don't get this freeze (no matching framing), and naturally
  // pan as the target scrolls into view via the clamp. Null-safe: a
  // player-less cutscene skips the freeze and drives fixed-point mode normally.
  if (player && player.portalWalk && player.path.length > 0) return;
  const target = desiredOffset();
  const diff = target - offsetX;
  if (Math.abs(diff) < CONFIG.camera.snapThreshold) {
    offsetX = target;
  } else {
    offsetX += diff * Math.min(1, (cameraLerp || CONFIG.camera.lerp) * dt);
  }
  applyOffset();
}

// Jumps the view to center world `x`, the instant counterpart to the easing in
// `tickCamera`. Used for the scene-enter framing, where there is no prior
// position worth travelling from.
function centerCameraOn(x) {
  offsetX = centeredOffset(x);
  applyOffset();
}

function applyOffset() {
  offsetX = clamp(offsetX, -maxOffset, maxOffset);
  // Snap the world layer to whole CSS px. Canvas sprites round their screen
  // position (render.js), so a sub-pixel world offset drifts against them
  // while panning and opens 1px seams where a sprite covers baked scenery (e.g.
  // an open-door sprite over a closed door painted into the backdrop). Snapping
  // keeps both layers on one pixel grid; offsetX stays fractional so the follow
  // easing stays smooth.
  const applied = Math.round(offsetX);
  if (applied === lastAppliedOffset) return;
  setWorldOffset(applied);
  lastAppliedOffset = applied;
}

/**
 * Scene-enter reset: every scene starts in follow mode on the player at the
 * config lerp, framed on `framedOnX` (null when no player spawned, leaving the
 * offset where it is). Cutscenes retarget mid-scene from there.
 */
export function enterSceneCamera(framedOnX) {
  cameraTarget = null;
  cameraFixedX = null;
  cameraLerp = null;

  // Scroll bound is per-world, so refresh it before framing.
  updateMaxOffset();
  if (framedOnX !== null) centerCameraOn(framedOnX);
}
