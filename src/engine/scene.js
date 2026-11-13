/**
 * @module scene
 * Live scene orchestration.
 *
 * Owns the active runtime scene state: actors, objects, movement, following,
 * placements, portals, the active speech line, hit-testing, the scene-trigger
 * vocabulary and its authored scripts, and the load/enter/transition lifecycle.
 *
 * Bridges authored definitions (actors.js / objects.js) into mutable runtime
 * entities for the active scene. The coordinate space those entities live in
 * belongs to world.js; viewing it belongs to camera.js.
 */

import CONFIG from './config.js';
import { actorRegistry, actorColumns, actorRows, resolveAnimBlock } from './actors.js';
import { objectRegistry, objectColumns, objectRows } from './objects.js';
import { runTriggers, startScript, stopScript } from './script.js';
import { sceneReferences } from './crossref.js';
import { loadSceneDefinition } from './registries.js';
import { saveProgress, conditionsMet, onFlagSet,
         getObjectOwner, setObjectOwner, getPlayerActor,
         getSavedObjectState, setSavedObjectState,
         getSavedActorState, setSavedActorState,
         setObjectPosition, clearObjectPosition, getDynamicObjectPlacements,
         getInventory } from './state.js';
import { findPath, isWalkable, nearestWalkablePoint } from './pathfinding.js';
import { pointInPolygon, polygonBounds, spriteBounds, worldSpriteSize } from './geometry.js';
import { resetWorld, applyWorld, currentWorldWidth, entityScale,
         walkablePolygons, worldRect } from './world.js';
import { getSprite, preloadSprite, ASSET_TYPES } from './sprites.js';
import { randomFloat } from './random.js';

export const SCENE_TRIGGERS = Object.freeze({
  sceneEnter:        'sceneEnter',
  flagSet:           'flagSet',
  actorEnter:        'actorEnter',
  actorArrive:       'actorArrive',
  actorExit:         'actorExit',
  engage:            'engage',
  objectPickup:      'objectPickup',
  objectLook:        'objectLook',
  actorLook:         'actorLook',
  objectUse:         'objectUse',
  actorUse:          'actorUse',
  useObjectOnObject: 'useObjectOnObject',
  useObjectOnActor:  'useObjectOnActor',
});

// Default interaction verb when a def doesn't declare one. Mirrored onto live
// instances by refreshObjectFields / spawnActor so consumers read a resolved
// value with no per-call fallback logic.
const DEFAULT_INTERACTION = 'look';

const VALID_DIRECTIONS = { east: 1, west: 1, north: 1, south: 1 };

// ══ Setup & reveal ═══════════════════════

let gameElement = null;
let currentScene = null;
// enterScene defers the scene reveal so the loop can choose CSS fade-in (no
// veiled overlay) or snap-under-veil (overlay-first sceneEnter), avoiding a
// pre-overlay scene flash on cached return visits.
let revealPending = false;

// True from the start of changeScene until the next enterScene finishes. Keeps
// interaction (and the inventory veil) locked across the fade-out + load gap,
// where the player actor is null so no portal-walk lock is in effect; the
// walk-in's `portalWalk` lock takes over seamlessly once enterScene spawns it.
let sceneTransitioning = false;
export function isSceneTransitioning() {
  return sceneTransitioning;
}

/**
 * Records the scene layer (`#app`) this module fades and measures the visible
 * viewport against. The world layer inside it belongs to world.js.
 */
export function initScene(gameEl) {
  gameElement = gameEl;
}

export function setCurrentScene(name) {
  currentScene = name;
}

/**
 * Forces the scene layer (`#app`) to fully visible with no fade.
 *
 * Called by the loop's deferred-reveal coordination when a veiled overlay is
 * masking the transition — the veil (its own canvas above `#app`) sits at
 * full alpha, so the scene snap underneath is invisible until the veil
 * clears, at which point the scene reveals through it.
 */
export function snapSceneVisible() {
  if (!gameElement) return;
  const prev = gameElement.style.transition;
  gameElement.style.transition = 'none';
  gameElement.style.opacity = '1';
  // Force reflow so the no-transition assignment commits before restoring.
  void gameElement.offsetHeight;
  gameElement.style.transition = prev;
}

// Reveal-coordination API. enterScene sets `revealPending` instead of
// touching the scene layer directly; the loop drains the pending state on the
// first frame post-enter, picking CSS fade-in or snap-under-veil based on
// whether a veiled overlay registered in this frame's tickScript pass.

/** True iff the scene is loaded but reveal hasn't yet fired. */
export function isRevealPending() {
  return revealPending;
}

/** Clears the reveal-pending flag after the loop handles the snap-under-veil path. */
export function markSceneRevealed() {
  revealPending = false;
}

/**
 * Default reveal: triggers the CSS fade-in on the scene layer (`#app`), which
 * fades backdrop + world canvas together as one composite. Used when no veiled
 * overlay is masking the scene enter.
 */
export function revealSceneFadeIn() {
  if (!gameElement) return;
  gameElement.style.opacity = '1';
  revealPending = false;
}

export function currentSceneName() {
  return currentScene;
}

// ══ Hooks ════════════════════════════════
//
// Where other systems attach to scene lifecycle. game.js registers all of them
// at composition time; scene.js fires them and knows nothing about what listens.

let sceneLoadHandler = null;
/**
 * Fires once per scene load, after the scene's sprites are preloaded and its
 * objects have spawned — the point at which every inventory item's sprite is
 * guaranteed decoded. game.js rebuilds the inventory strip here so icons slice
 * a decoded sheet rather than a blank one.
 *
 * Carries the scene's authored `ambientBarks` block (`undefined` when it
 * authors none), the one key of the scene document whose runtime ownership
 * belongs to another module: narrative.js schedules it, so this module passes
 * it through rather than holding it. Not a general scene-document channel —
 * every other key is interpreted here or by `applyWorld`.
 */
export function onSceneLoad(fn) {
  sceneLoadHandler = fn;
}

let sceneEnterHandler = null;
/**
 * Fires from `enterScene` once the player is spawned. Passes the world x the
 * arrival should be framed on, or null when no player spawned. The camera
 * consumes it to reset and frame the incoming scene.
 */
export function onSceneEnter(fn) {
  sceneEnterHandler = fn;
}

let sceneHideHandler = null;
/**
 * Fires when the scene hides at the start of a transition, for non-visual
 * cleanup: clearing hover, cancelling pending interactions, closing dialogue.
 */
export function onSceneHide(fn) {
  sceneHideHandler = fn;
}

let actorDespawnHandler = null;
/**
 * Fires when an actor leaves the scene, by name. Lets systems that reference
 * actors by name (the camera's follow target) release a subject that no longer
 * exists.
 */
export function onActorDespawn(fn) {
  actorDespawnHandler = fn;
}

let objectChangeHandler = null;
/**
 * Fires on state transitions, ownership moves, dynamic spawns, and removals.
 * Used by game.js to re-render the inventory panel and refresh the inventory
 * button when contents or labels change.
 */
export function onObjectChange(fn) {
  objectChangeHandler = fn;
}

// ══ Portals ══════════════════════════════

let portals = { entries: {}, exits: {} };

/**
 * Walk destination for clicking on a portal exit — bottom-center of polygon
 * bounds, mirroring `objectInteractPoint` for hotspot objects.
 *
 * Click position is never used as the walk target; every click on the
 * polygon resolves to the same canonical point so large exits don't produce
 * drift-prone walks.
 */
export function portalExitInteractPoint(exit) {
  const b = polygonBounds(exit.hotspot);
  return { x: (b.minX + b.maxX) / 2, y: b.maxY };
}

/**
 * Exit existence gate — the single predicate for "does this exit currently
 * exist in the scene?". Every consumer (hit-test, scan markers, future hover
 * or path-preview systems) must route through this so the rule lives in one
 * place.
 *
 * Distinct from `blocked` (see `exitIsBlocked` in interaction.js):
 * - if / ifNot => the exit is absent from the scene (no hover, no marker, no click)
 * - blocked    => the exit is present and visible, but traversal is refused with a message
 */
export function exitExists(exit) {
  return conditionsMet(exit);
}

/**
 * Hit-test portal exits at a native-space point. Skips exits gated out by
 * `exitExists`, so hover and click (both routed through here) honor existence
 * conditions for free.
 *
 * Portals are pure navigation affordances — no z-sort, no visibility check,
 * no priority ordering between exits (overlap is an authoring mistake; first
 * match wins).
 *
 * @returns {PortalExitHit | null} The matched exit as `kind: 'portalExit'`
 * with its name, display title, and authored definition; null on a miss.
 */
export function portalExitAtNativePoint(nx, ny) {
  const names = Object.keys(portals.exits);
  for (let i = 0; i < names.length; i++) {
    const exit = portals.exits[names[i]];
    if (!exitExists(exit)) continue;
    if (exit.hotspot && pointInPolygon(nx, ny, exit.hotspot)) {
      return { kind: 'portalExit', name: names[i], title: exit.title || '', def: exit };
    }
  }
  return null;
}

export function getPortalEntries() {
  return portals.entries;
}

export function getPortalExits() {
  return portals.exits;
}

// ══ Speech ═══════════════════════════════
//
// The active spoken line, presented as a bubble over its speaker. One line at a
// time, fed by three producers: the say/sayRandom actions, ambient barks, and
// dialogue-mode beats. Speaking is a capability of any world entity — the
// speaker resolves to an actor or an object — while conversations (dialogue
// mode) remain actor-only.

// An utterance equal to this displays as a normal bubble but does not drive the
// speaker's talk animation.
const NONVERBAL_UTTERANCE = '...';

// The active spoken line, or null. `speaker` is the resolved entity; `ownerScript`
// is the script that opened the line, or null for engine-initiated speech (e.g. barks).
let speech = null;

// Automatic display duration (ms) for a spoken line: per-word pacing with a floor.
function speechDurationMs(text) {
  return Math.max(CONFIG.speech.minMs, text.split(/\s+/).length * CONFIG.speech.msPerWord);
}

/**
 * Shows a spoken line for the named entity (actor or object). `ownerScript`
 * ties it to a script's lifetime; omit for engine-initiated speech like barks.
 * `durationMs` and `effect` each override the default for this line only —
 * every producer resolves effects here, so nearest override wins.
 *
 * @returns {number} The bubble's timer in ms, so a script can block for
 * exactly as long as the line shows. A dropped line (unknown speaker) is 0.
 */
export function showSpeech(speakerName, text, ownerScript, durationMs, effect) {
  const speaker = actors[speakerName] || objects[speakerName];
  if (!speaker) {
    console.error(`[showSpeech] unknown speaker "${speakerName}" — no actor or object by that name in the scene; line dropped.`);
    return 0;
  }
  const resolvedDurationMs = durationMs ?? speechDurationMs(text);
  speech = {
    speaker:     speaker,
    text:        text,
    timer:       resolvedDurationMs,
    ownerScript: ownerScript || null,
    nonverbal:   text === NONVERBAL_UTTERANCE,
    effect:      effect ?? speaker.speechEffect ?? null,
  };
  return resolvedDurationMs;
}

export function clearSpeech() {
  speech = null;
}

/**
 * Called when a script stops. If that script opened the active line, clear
 * it so the visible speech tracks script lifetime rather than outliving it.
 */
export function clearSpeechIfOwnedBy(scriptName) {
  if (speech && speech.ownerScript === scriptName) clearSpeech();
}

/**
 * True when a non-bark spoken line is currently on screen.
 *
 * Barks (engine-initiated, `ownerScript === null`) render the bubble but don't
 * trip this — they're ambient and never gate input.
 */
export function isSpeechShown() {
  return speech !== null && speech.ownerScript !== null;
}

/**
 * Render-pass query — game.js reads this each frame.
 *
 * @returns {Speech | null} The active spoken line: its resolved `speaker`
 * entity, `text`, remaining `timer`, `ownerScript` (null for barks),
 * `nonverbal` (line presented, but drives no talk animation), and `effect`
 * (resolved presentation effect name, or null), or null when none is active.
 * Read-only view; mutate only through
 * `showSpeech` / `clearSpeech` / `tickSpeech`.
 */
export function getActiveSpeech() {
  return speech;
}

/**
 * Tick hook — drains the speech timer and clears the active line at zero.
 */
export function tickSpeech(dt) {
  if (!speech) return;
  speech.timer = Math.max(0, speech.timer - dt * 1000);
  if (speech.timer === 0) clearSpeech();
}

// ══ Actors ═══════════════════════════════

export let actors = {};

// Live runtime instance of the configured player actor, or null when no such
// instance exists. Maintained by spawnActor/despawnActor and scene teardown.
export let player = null;

const FOLLOW_REPATH_MS = 500; // ms between path recalculations for a following actor

function currentAnimState(actor) {
  if (actor.animOverride && actor.animations && actor.animations[actor.animOverride]) return 'override';
  if (actor.path.length > 0) return 'walk';
  if (speech && actor === speech.speaker && speech.timer > 0 && !speech.nonverbal && actor.talk) return 'talk';
  if (actor.idle) return 'idle';
  return null;
}

// Per-frame advance shared by actor and object animation ticking: `baseMs`,
// jittered ±`jitterMs` when authored, floored at 1ms.
function frameAdvanceMs(baseMs, jitterMs) {
  return jitterMs > 0
    ? Math.max(1, Math.round(randomFloat(baseMs - jitterMs, baseMs + jitterMs)))
    : baseMs;
}

function tickActorAnimation(actor, dtMs) {
  const state = currentAnimState(actor);
  const animDef = resolveAnimBlock(actor, state);
  const firstFrame = animDef && animDef.reverse ? (animDef.frames || 1) - 1 : 0;

  if (actor.animState !== state) {
    actor.animState = state;
    actor.frame = firstFrame;
    actor.frameTimer = 0;
    actor.idlePhase = 'playing';
  }

  if (!state) return;

  if (state === 'idle' && actor.idlePhase === 'pausing') {
    actor.idlePauseTimer -= dtMs;
    if (actor.idlePauseTimer <= 0) {
      actor.idlePhase = 'playing';
      actor.frame = firstFrame;
      actor.frameTimer = 0;
    }
    return;
  }

  if (!animDef || animDef.frames <= 1) return;

  actor.frameTimer += dtMs;
  if (actor.frameTimer >= animDef.frameMs) {
    const advance = frameAdvanceMs(animDef.frameMs, animDef.jitterMs);
    actor.frameTimer -= advance;
    const step = animDef.reverse ? -1 : 1;
    actor.frame = (actor.frame + step + animDef.frames) % animDef.frames;
    if (actor.frame === 0) {
      if (state === 'idle' && animDef.pauseMs) {
        actor.idlePhase = 'pausing';
        actor.idlePauseTimer = animDef.pauseMs;
      }
      if (state === 'override' && animDef.loop === false) {
        // One-shot finished: clear the override and resolve the next state in
        // this same tick. Leaving animState as 'override' with no live override
        // would resolve to no block, flashing frame 0 of the sheet for one frame.
        actor.animOverride = null;
        actor.animState = currentAnimState(actor);
        actor.frame = 0;
        actor.frameTimer = 0;
        actor.idlePhase = 'playing';
      }
    }
  }
}

// End of a walk: the actor has just consumed its last waypoint. Applies the
// entry's post-arrival pose, releases the portal-walk lock, and fires
// `actorArrive` for a walk-in entry. The pose is single-shot — cleared once
// applied, so a later ordinary walk won't snap back to a stale facing.
function finishWalk(actor) {
  if (actor.portalWalk && actor.postArrivalFacing) {
    actor.direction = actor.postArrivalFacing;
  }
  actor.postArrivalFacing = null;
  actor.portalWalk = false;

  if (actor.arriveEntry) {
    const entryName = actor.arriveEntry;
    actor.arriveEntry = null;
    runSceneTrigger(SCENE_TRIGGERS.actorArrive, actor.name, entryName);
  }
}

function moveActor(actor, dt) {
  if (actor.path.length > 0) {
    const target = actor.path[0];
    const feetX = actor.x + actor.w / 2;
    const feetY = actor.y;
    const dx = target.x - feetX;
    const dy = target.y - feetY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const step = actor.speed * entityScale(actor) * dt;

    if (Math.abs(dx) >= Math.abs(dy)) {
      actor.direction = dx > 0 ? 'east' : 'west';
    } else {
      actor.direction = dy > 0 ? 'south' : 'north';
    }

    if (dist <= step) {
      actor.x = target.x - actor.w / 2;
      actor.y = target.y;
      actor.path.shift();
      if (actor.path.length === 0) finishWalk(actor);
    } else {
      const ratio = step / dist;
      actor.x = (feetX + dx * ratio) - actor.w / 2;
      actor.y = feetY + dy * ratio;
    }
  }

  tickActorAnimation(actor, dt * 1000);
}

function tickFollow(actor, dt) {
  if (!actor.followTarget) return;
  const target = actors[actor.followTarget];
  if (!target) return;

  actor.followTimer += dt * 1000;
  if (actor.followTimer < FOLLOW_REPATH_MS) return;
  actor.followTimer = 0;

  const dx = (target.x + target.w / 2) - (actor.x + actor.w / 2);
  const dy = target.y - actor.y;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (dist <= actor.followDistance) {
    actor.path = [];
    return;
  }

  actor.path = findPath(actor.x + actor.w / 2, actor.y, target.x + target.w / 2, target.y, walkablePolygons);
}

/**
 * Tick hook — runs follow re-pathing and per-actor movement.
 */
export function tickActors(dt) {
  const actorList = Object.values(actors);
  for (let i = 0; i < actorList.length; i++) {
    tickFollow(actorList[i], dt);
    moveActor(actorList[i], dt);
  }
}

/**
 * Spawns an actor by name, placed by `entryName` (a portal entry) or explicit
 * `x`/`y` — one is required, or nothing spawns. `facing` beats the entry's own.
 * `state` overrides the resolved initial state, transiently (never persisted).
 */
export function spawnActor(name, entryName, x, y, facing, state) {
  const def = actorRegistry[name];
  if (!def) return null;

  const entry = entryName ? portals.entries[entryName] : null;
  const hasCoords = typeof x === 'number' && typeof y === 'number';
  if (!entry && !hasCoords) {
    console.warn(`[spawnActor] ${name}: no entry or coords provided${entryName ? ` (entry "${entryName}" not found in this scene)` : ''}.`);
    return null;
  }

  // Resolve the initial state for this spawned instance: use the persisted
  // state when present, otherwise `initialState`. An explicit, valid `state`
  // overrides that resolution. Actor state is presentation, so the override is
  // transient (never persisted), matching `setActorState`'s default behavior.
  // Unknown override → warn and keep the normal resolution (fail-soft).
  let initialState = getSavedActorState(name) || def.initialState || null;
  if (state != null) {
    if (def.states && def.states[state]) initialState = state;
    else console.warn(`[spawnActor] ${name}: unknown spawn state "${state}" — using "${initialState}" instead.`);
  }

  const actor = {
    def:          def, // authored definition — reference, read-only; never mutate
    kind:         'actor',
    name:          name,
    state:         initialState,
    spriteImg:     null,
    spriteSrc:     null,
    columns:       0,
    totalRows:     0,
    animState:     null,
    // Author fields below are resolved per active state by refreshActorFields.
    walk:          null,
    idle:          null,
    talk:          null,
    animations:    null,
    speed:         undefined,
    title:         '',
    description:   '',
    interaction:   DEFAULT_INTERACTION,
    dialogue:      null,
    talkText:      null,
    speechColor:   null,
    speechEffect:  null,
    speechOffsetX: 0,
    speechOffsetY: 0,
    plane:         'normal',
    scaling:       'scene',
    offsetX:       0,
    offsetY:       0,
    approachX:     0,
    approachY:     0,
    x:             hasCoords ? x : 0,
    y:             hasCoords ? y : 0,
    w:             0,
    h:             0,
    direction:     facing || 'south',
    frame:         0,
    frameTimer:    0,
    animOverride:   null,
    idlePhase:      'playing',
    idlePauseTimer: 0,
    path:           [],
    visible:        true,
    followTarget:   null,
    followDistance: 0,
    followTimer:    0,
    // Portal traversal — set by walk-in spawns and walk-offs; cleared when the
    // walk completes or a user/script walk overrides it.
    portalWalk:        false,
    arriveEntry:       null,
    postArrivalFacing: null,
  };

  // Entry's `walk` is the cardinal direction the actor moves during the
  // portal walk-in (e.g. `walk: "north"` → comes from the south, walks
  // upward to the entry). Absent = spawn directly at the entry point.
  const walkInDir = (entry && VALID_DIRECTIONS[entry.walk]) ? entry.walk : null;

  if (entry) {
    // Post-arrival facing: explicit `facing` wins; otherwise inherit the
    // walk direction so the actor naturally faces the way they came in.
    actor.direction = facing || entry.facing || walkInDir || 'south';
    // For direct-spawn entries set y immediately. Walk-in defers final
    // positioning to resolveDimensions because the offscreen spawn point
    // depends on actor.w/h.
    if (!walkInDir) actor.y = entry.y;
    // During the walk-in, moveActor sets `actor.direction` from the motion
    // vector each tick. If the author wants a different pose on arrival,
    // stash it here for the path-empty handler in moveActor to apply.
    if (walkInDir && entry.facing && VALID_DIRECTIONS[entry.facing] && entry.facing !== walkInDir) {
      actor.postArrivalFacing = entry.facing;
    }
    // Walk-in: defer `actorArrive` until the path completes (fired in moveActor).
    // Direct-spawn: `actorArrive` fires immediately below, after registration.
    if (walkInDir) actor.arriveEntry = entryName;
  }

  // Placement needs the resolved w/h, so it runs once refreshActorFields has
  // sized the sprite (synchronously if cached, else on its load callback).
  function place() {
    if (entry) {
      if (walkInDir) {
        // Place the actor offscreen on the side opposite the walk direction
        // and queue a single straight-line waypoint to the entry. moveActor
        // tweens directly between waypoints, so no pathfinding runs.
        const worldH = CONFIG.world.height;
        const margin = Math.max(actor.w, actor.h);
        let feetX = entry.x;
        let feetY = entry.y;
        if (walkInDir === 'north') feetY = worldH + margin;
        else if (walkInDir === 'south') feetY = -margin;
        else if (walkInDir === 'east') feetX = -margin;
        else if (walkInDir === 'west') feetX = currentWorldWidth() + margin;
        actor.x = feetX - actor.w / 2;
        actor.y = feetY;
        actor.path = [{ x: entry.x, y: entry.y }];
        actor.portalWalk = true;
      } else {
        actor.x = entry.x - actor.w / 2;
      }
    } else if (hasCoords) actor.x = x - actor.w / 2;
  }

  refreshActorFields(actor, place);

  actors[name] = actor;
  // Handle update precedes the triggers below so their scripts see the new instance.
  if (name === getPlayerActor()) player = actor;
  if (entry) {
    runSceneTrigger(SCENE_TRIGGERS.actorEnter, name, entryName);
    if (!walkInDir) runSceneTrigger(SCENE_TRIGGERS.actorArrive, name, entryName);
  }
  return actor;
}

// Mirrors the active state's authored fields onto the live instance, and swaps
// the sprite sheet + grid to match — the actor mirror of `refreshObjectFields`.
// Runtime state (`x`/`y`, `direction`, path, follow, portal-walk) is never
// touched: the feet-center `x` recompute holds position, it doesn't reset it.
// Resizing preserves that feet-center so a differently-sized sheet grows in
// place, and playback restarts with any override cleared, since a stale clip
// index means nothing against a new sheet. `onSized` fires once w/h are known —
// spawnActor uses it to place the actor.
function refreshActorFields(actor, onSized) {
  const def = actor.def;
  const state = actor.state;

  actor.walk = resolveField(def, state, 'walk') || null;
  actor.idle = resolveField(def, state, 'idle') || null;
  actor.talk = resolveField(def, state, 'talk') || null;
  actor.animations = resolveField(def, state, 'animations') || null;
  actor.title = resolveField(def, state, 'title') || '';
  actor.description = resolveField(def, state, 'description') || '';
  actor.interaction = resolveField(def, state, 'interaction') || DEFAULT_INTERACTION;
  actor.dialogue = resolveField(def, state, 'dialogue') || null;
  actor.talkText = resolveField(def, state, 'talkText') || null;
  // Unset stays unset: render.js owns the color chain (entity → theme → white),
  // so defaulting here would pre-empt `theme.speech.color`. Same for objects.
  actor.speechColor = resolveField(def, state, 'speechColor') || null;
  actor.speechEffect = resolveField(def, state, 'speechEffect') || null;
  actor.speechOffsetX = resolveField(def, state, 'speechOffsetX') ?? 0;
  actor.speechOffsetY = resolveField(def, state, 'speechOffsetY') ?? 0;
  actor.plane = resolveField(def, state, 'plane') || 'normal';
  actor.scaling = resolveField(def, state, 'scaling') || 'scene';
  actor.offsetX = resolveField(def, state, 'offsetX') ?? 0;
  actor.offsetY = resolveField(def, state, 'offsetY') ?? 0;
  actor.approachX = resolveField(def, state, 'approachX') ?? 0;
  actor.approachY = resolveField(def, state, 'approachY') ?? 0;
  actor.facing = resolveField(def, state, 'facing') || null;
  actor.speed = resolveField(def, state, 'speed');

  // Grid is bound to the active sheet, so derive it from the resolved set.
  actor.columns   = actorColumns(actor);
  actor.totalRows = actorRows(actor);

  actor.animOverride = null;
  actor.animState    = null;
  actor.frame        = 0;
  actor.frameTimer   = 0;
  actor.idlePhase    = 'playing';

  const newSrc = resolveField(def, state, 'sprite');

  // Spawn defers placement to `onSized`; a transition keeps the actor put, so its
  // feet-center (bottom-center anchor) must survive the w change. Capture it before
  // dimensions change: this holds across spriteful and spriteless transitions alike,
  // where w goes to or from 0 and x collapses onto the feet-center itself.
  const preserveFeet = !onSized;
  const feetX = actor.x + actor.w / 2;

  // A spriteless actor has zero visual dimensions. Invalid spriteful data with no
  // derivable grid degrades the same way so fail-soft validation cannot produce
  // invalid geometry.
  if (!newSrc || actor.columns < 1) {
    actor.spriteImg = null;
    actor.spriteSrc = null;
    actor.w = 0;
    actor.h = 0;
    if (preserveFeet) actor.x = feetX;
    if (onSized) onSized();
    return;
  }

  const img = getSprite(ASSET_TYPES.sprite, newSrc);
  actor.spriteImg = img;
  actor.spriteSrc = newSrc;

  function applySpriteSize() {
    if (!img.complete || !img.naturalWidth) return;
    if (actor.spriteImg !== img) return; // swapped again before this load resolved
    const dims = worldSpriteSize(img.naturalWidth, img.naturalHeight, actor.columns, actor.totalRows, resolveField(def, state, 'height'));
    actor.w = dims.w;
    actor.h = dims.h;
    if (preserveFeet) actor.x = feetX - actor.w / 2; // preserve feet-center across a size change
    if (onSized) onSized();
  }
  applySpriteSize();
  // Await the cached `ready` promise rather than adding a `load` listener: this
  // runs on every state change, and repeated refreshes before the sheet decodes
  // would each leave a listener behind on the shared Image.
  if (!img.complete || !img.naturalWidth) img.ready.then(applySpriteSize);
}

/**
 * State funnel for actors — the mirror of `applyObjectState`. Updates the live
 * instance and re-resolves its fields. `persist` writes the state to the save
 * so it survives reconstruction (progression); the default is a transient
 * presentation state — live only, reverting to the saved baseline on the next
 * rebuild (scene re-entry, reload).
 */
export function applyActorState(name, state, persist) {
  if (persist) setSavedActorState(name, state);
  const actor = actors[name];
  if (actor) {
    actor.state = state;
    refreshActorFields(actor);
  }
}

/**
 * Resolved current state: the live instance's state if present, else the
 * diverged save value, else the def's `initialState`. The actor mirror of
 * `currentObjectState`; used by `waitForState` so it observes a transient
 * (unpersisted) instance state.
 */
export function currentActorState(name) {
  if (actors[name]) return actors[name].state;
  const stored = getSavedActorState(name);
  if (stored) return stored;
  const def = actorRegistry[name];
  return def ? def.initialState : undefined;
}

/**
 * Despawns an actor — immediately without `exitName`, else walking it to the
 * exit, then off through the exit's `walk` direction, then dropping it. The
 * exit's `blocked` clause is deliberately ignored: it is player-facing UX, not
 * a gate the engine enforces on scripted actor movement.
 *
 * @returns {(() => boolean) | null} Completion predicate for the multi-stage
 * portal case, or null when there is nothing to wait on.
 */
export function removeActor(name, exitName) {
  if (!actors[name]) return null;

  if (!exitName) {
    despawnActor(name);
    return null;
  }

  const exit = portals.exits[exitName];
  if (!exit) {
    console.warn(`[removeActor] ${name}: exit "${exitName}" not found in this scene — falling back to instant despawn.`);
    despawnActor(name);
    return null;
  }

  const interactPoint = portalExitInteractPoint(exit);
  let walkToCheck = walkActorTo(name, interactPoint.x, interactPoint.y);
  let walkOffCheck = null;
  let done = false;

  return function () {
    if (done) return true;
    if (!actors[name]) { done = true; return true; } // actor vanished mid-flight

    if (walkToCheck) {
      if (!walkToCheck()) return false;
      walkToCheck = null;
      if (exit.walk) {
        walkOffCheck = walkActorOff(name, exit.walk);
        if (walkOffCheck) return false;
      }
      despawnActor(name, exitName);
      done = true;
      return true;
    }

    if (walkOffCheck) {
      if (!walkOffCheck()) return false;
      walkOffCheck = null;
      despawnActor(name, exitName);
      done = true;
      return true;
    }

    return true;
  };
}

function despawnActor(name, exitName) {
  if (exitName) runSceneTrigger(SCENE_TRIGGERS.actorExit, name, exitName);
  // Drop any speech bubble pointing at this actor (e.g. an in-flight ambient
  // bark) — `speech.speaker` holds the entity by reference, so without this it
  // would linger over the now-empty spot until its timer drains.
  if (speech && speech.speaker === actors[name]) clearSpeech();
  if (actors[name] === player) player = null;
  delete actors[name];
  const others = Object.keys(actors);
  for (let i = 0; i < others.length; i++) {
    const other = actors[others[i]];
    if (other.followTarget === name) {
      other.followTarget = null;
      other.path = [];
    }
  }
  if (actorDespawnHandler) actorDespawnHandler(name);
}

// True when the actor's bounding box has fully cleared the *visible viewport*
// in the given cardinal direction. Used to terminate walk-offs at the moment
// the player can no longer see the actor, rather than waiting for them to
// reach the scene-edge waypoint (which can mean a long extra walk on small
// scenes). Camera is frozen during walk-offs, so the viewport bounds in
// native coords are stable for the duration of the walk.
//
// The world rect already carries the camera's translate, so the visible span is
// the scene layer's rect expressed in world coordinates.
function actorIsOffViewport(actor, direction) {
  if (!gameElement) return false;
  const world = worldRect();
  if (!world.height) return false;
  const view = gameElement.getBoundingClientRect();
  const scale = world.height / CONFIG.world.height;
  const viewLeftNative = (view.left - world.left) / scale;
  const viewRightNative = (view.right - world.left) / scale;
  const left = actor.x;
  const right = actor.x + actor.w;
  const top = actor.y - actor.h;
  const bottom = actor.y;

  if (direction === 'west') return right <= viewLeftNative;
  if (direction === 'east') return left >= viewRightNative;
  if (direction === 'north') return bottom <= 0;
  if (direction === 'south') return top >= CONFIG.world.height;
  return false;
}

/**
 * Walks an actor off the scene on one straight-line waypoint, bypassing
 * pathfinding and freezing the camera (the same `portalWalk` flag walk-ins use)
 * so the viewport holds while the actor exits frame. Completion fires as the
 * bbox clears the viewport edge; the scene-edge waypoint is only a safety cap.
 * Null if the actor or direction is invalid.
 */
export function walkActorOff(name, direction) {
  const actor = actors[name];
  if (!actor || !VALID_DIRECTIONS[direction]) return null;
  const worldH = CONFIG.world.height;
  const margin = Math.max(actor.w, actor.h);
  let feetX = actor.x + actor.w / 2;
  let feetY = actor.y;
  if (direction === 'north') feetY = -margin;
  else if (direction === 'south') feetY = worldH + margin;
  else if (direction === 'east') feetX = currentWorldWidth() + margin;
  else if (direction === 'west') feetX = -margin;

  actor.direction = direction;
  actor.path = [{ x: feetX, y: feetY }];
  actor.portalWalk = true;
  return function () {
    const a = actors[name];
    if (!a) return true;
    if (actorIsOffViewport(a, direction)) return true;
    return a.path.length === 0; // safety cap: reached the waypoint
  };
}

/**
 * Walks an actor to a native (x, y). Returns a completion-check function
 * used by blocking script actions, or null if the actor can't be reached.
 */
export function walkActorTo(name, x, y) {
  const actor = actors[name];
  if (!actor) return null;

  // Any user/script-initiated walk overrides an in-flight portal walk — the
  // camera should resume normal follow once the player takes control. Also
  // drop the post-arrival facing stash so an interrupted walk-in doesn't
  // re-pose the actor when this new walk completes.
  actor.portalWalk = false;
  actor.postArrivalFacing = null;

  const target = isWalkable(x, y, walkablePolygons) ? { x, y } : nearestWalkablePoint(x, y, walkablePolygons);
  if (!target) return null;

  const feetX = actor.x + actor.w / 2;
  const feetY = actor.y;
  const dx = target.x - feetX, dy = target.y - feetY;
  // Already at the resolved target — skip pathfinding. Avoids a spurious detour
  // when the interact point lies on the walkable-polygon boundary (isWalkable
  // is exclusive of edges, so a zero-length boundary segment fails isSegmentWalkable
  // and A* routes through other vertices).
  actor.path = (dx * dx + dy * dy < 1e-6) ? [] : findPath(feetX, feetY, target.x, target.y, walkablePolygons);
  return function () { return !actors[name] || actors[name].path.length === 0; };
}

/**
 * True while the player is mid-walk through a portal — entering the scene
 * via an entry with a `walk` direction, or exiting through an exit with a
 * `walk` direction. A `walkTo` step never sets the underlying flag.
 */
export function isPlayerInPortalWalk() {
  // `player` is null between scenes; coerce so consumers always get a boolean.
  return !!(player && player.portalWalk);
}

/**
 * Sets `name` to follow `target`, staying at least `distance` native units
 * away. Re-paths every `FOLLOW_REPATH_MS` while the gap exceeds the distance.
 */
export function setFollow(name, target, distance) {
  const actor = actors[name];
  if (!actor) return;
  actor.followTarget = target || null;
  actor.followDistance = distance || 0;
  actor.followTimer = FOLLOW_REPATH_MS; // trigger first recalculation immediately
}

export function clearFollow(name) {
  const actor = actors[name];
  if (!actor) return;
  actor.followTarget = null;
  actor.path = [];
}

/**
 * Plays a named animation from the actor's `animations` map, overriding the
 * default walk/idle/talk state until the override clears or completes.
 */
export function setAnimOverride(name, anim) {
  if (actors[name]) actors[name].animOverride = anim || null;
}

/**
 * Snaps the actor's facing direction. No-op for invalid actors or
 * non-cardinal directions.
 */
export function faceActor(name, direction) {
  const actor = actors[name];
  if (!actor) return;
  if (!VALID_DIRECTIONS[direction]) return;
  actor.direction = direction;
}

// Hit rect matches the sprite as drawn: it uses the actor's resolved scene scale (1 when fixed).
function hitTestActor(a, nx, ny) {
  const b = spriteBounds(a.x + a.w / 2, a.y, a.w, a.h, a.offsetX, a.offsetY, entityScale(a));
  return nx >= b.minX && nx <= b.maxX && ny >= b.minY && ny <= b.maxY;
}

// ══ Objects ══════════════════════════════

export let objects = {};
export let objectPlacements = {}; // name → { x, y, if?, ifNot? } — merged static (scene JSON) + dynamic (save state). Includes entries that are *not* currently spawned (failing owner / condition checks), for debug overlay.

/**
 * Resolves a field for an object honoring the state machine: the value comes
 * from the current state's def (if present and the field is set), otherwise
 * from the top-level def.
 *
 * Used by both live scene instances and inventory items (which have no live
 * instance).
 */
export function resolveObjectField(name, field) {
  const def = objectRegistry[name];
  if (!def) return undefined;
  return resolveField(def, resolveObjectState(name), field);
}

// Resolves an object's active state name (the key field-resolution is keyed on),
// the mirror of resolveObjectField at the state level. A live instance's `state`
// is its current state; the save registry is a serialization baseline consulted
// only when no instance exists (inventory items, and the baseline read at
// spawn). This lets a spawned object carry a transient state that never touched
// the registry.
function resolveObjectState(name) {
  const live = objects[name];
  if (live) return live.state;
  const def = objectRegistry[name];
  return getSavedObjectState(name) || (def && def.initialState) || null;
}

// Shared state-resolution for both entity types: the active state's value if
// it sets the field, else the def-level baseline. An explicit `null` counts as
// set — the authored removal opt-out — and every caller coalesces it to the
// field's default. Both entity kinds pass their live instance state, which may
// be a transient override diverged from the save (refreshActorFields, and
// resolveObjectField via resolveObjectState).
function resolveField(def, stateName, field) {
  if (stateName && def.states && def.states[stateName] && def.states[stateName][field] !== undefined) {
    return def.states[stateName][field];
  }
  return def[field];
}

/**
 * Inventory icon descriptor for an object, resolving state.icon → def.icon →
 * state.sprite → def.sprite (README § Icon fallthrough). A dedicated `icon` is
 * a whole single-frame image; a sprite fallthrough carries the grid plus the
 * current `row`/`startFrame` so the caller slices just this state's frame.
 *
 * @returns {{ type: string, name: string, cols: number, rows: number, row: number, startFrame: number } | null}
 * Null when no image resolves. `type`/`name` identify the asset for `getSprite`.
 */
export function resolveObjectIconFrame(name) {
  const icon = resolveObjectField(name, 'icon');
  if (icon) return { type: ASSET_TYPES.icon, name: icon, cols: 1, rows: 1, row: 0, startFrame: 0 };

  const sprite = resolveObjectField(name, 'sprite');
  if (!sprite) return null;

  const def = objectRegistry[name];
  return {
    type:       ASSET_TYPES.sprite,
    name:       sprite,
    cols:       objectColumns(def),
    rows:       objectRows(def),
    row:        resolveObjectField(name, 'row') ?? 0,
    startFrame: resolveObjectField(name, 'startFrame') ?? 0,
  };
}

/**
 * Spawns an object from a placement record. Returns null when the placement's
 * `if`/`ifNot` conditions fail, or when saved ownership excludes the object
 * and `checkSavedOwner` is true.
 */
function spawnObject(name, placement, checkSavedOwner = true, state, persistState = false) {
  const def = objectRegistry[name];
  if (!def) return null;

  // Undefined owner means "still at default" — spawn normally.
  if (checkSavedOwner) {
    const owner = getObjectOwner(name);
    if (owner !== undefined && owner !== currentScene) return null;
  }

  if (!conditionsMet(placement)) return null;

  // Hotspot: relative offsets from origin → absolute scene coords.
  // def.hotspot (objects.json) is fallback for programmatic spawning;
  // placement.hotspot (scene JSON) overrides when present.
  const relHotspot = placement.hotspot || def.hotspot || null;
  let absHotspot = null;
  let anchorX, anchorY;

  if (relHotspot) {
    const ox = placement.x;
    const oy = placement.y;
    absHotspot = relHotspot.map(function (p) { return [ox + p[0], oy + p[1]]; });
    anchorX = ox;
    anchorY = oy;
  } else {
    anchorX = placement.x;
    anchorY = placement.y;
  }

  // Resolve the initial state for this spawned instance: use the persisted
  // state when present, otherwise `initialState`. An explicit, valid `state`
  // overrides that resolution. The override's lifetime follows the instance, so
  // `persist` governs whether it is also written to save state.
  // Unknown override → warn and keep the normal resolution (fail-soft).
  let initialState = getSavedObjectState(name) || def.initialState || null;
  if (state != null) {
    if (def.states && def.states[state]) {
      initialState = state;
      if (persistState) setSavedObjectState(name, state);
    } else {
      console.warn(`[spawnObject] ${name}: unknown spawn state "${state}" — using "${initialState}" instead.`);
    }
  }

  const obj = {
    def:        def, // authored definition — reference, read-only; never mutate
    kind:       'object',
    name:        name,
    state:       initialState,
    spriteImg:   null,
    spriteSrc:  null,
    columns:     objectColumns(def),
    totalRows:   objectRows(def),
    frame:       0,
    frameTimer:  0,
    x:           anchorX,
    y:           anchorY,
    w:           0,
    h:           0,
    visible:     true,
    hotspot:     absHotspot,
    anchorX:    anchorX, // bottom-center anchor in scene coords; preserved across w/h changes when sprite loads
  };

  // Register before the first refresh so field resolution reads this instance's
  // `state` (resolveObjectState) rather than the save baseline.
  objects[name] = obj;
  refreshObjectFields(obj);
  return obj;
}

// Pull current-state field values onto the instance for fast read access by
// render and input code. Also lazy-loads the sprite if the resolved filename
// changed (state-driven sprite swap). Resets the animation frame on every
// state change so the new state plays from its first frame.
function refreshObjectFields(obj) {
  // `obj.state` is authoritative — set by the caller (spawnObject / applyObjectState).
  // This mirrors refreshActorFields: the instance owns its state, not the registry.
  obj.title = resolveObjectField(obj.name, 'title') || '';
  obj.description = resolveObjectField(obj.name, 'description') || '';
  obj.pickupText = resolveObjectField(obj.name, 'pickupText') || '';
  obj.interaction = resolveObjectField(obj.name, 'interaction') || DEFAULT_INTERACTION;
  obj.transitions = resolveObjectField(obj.name, 'transitions') || null;
  obj.animRow = resolveObjectField(obj.name, 'row') ?? 0;
  obj.animFrames = resolveObjectField(obj.name, 'frames') ?? 1;
  obj.animStartFrame = resolveObjectField(obj.name, 'startFrame') ?? 0;
  obj.animFrameMs = resolveObjectField(obj.name, 'frameMs') ?? 0;
  obj.animJitterMs = resolveObjectField(obj.name, 'jitterMs') ?? 0;
  obj.animLoop = resolveObjectField(obj.name, 'loop') !== false;
  obj.animReverse = resolveObjectField(obj.name, 'reverse') === true;
  obj.plane = resolveObjectField(obj.name, 'plane') || 'normal';
  obj.offsetX = resolveObjectField(obj.name, 'offsetX') ?? 0;
  obj.offsetY = resolveObjectField(obj.name, 'offsetY') ?? 0;
  obj.speechColor = resolveObjectField(obj.name, 'speechColor') || null; // see refreshActorFields
  obj.speechEffect = resolveObjectField(obj.name, 'speechEffect') || null;
  obj.speechOffsetX = resolveObjectField(obj.name, 'speechOffsetX') ?? 0;
  obj.speechOffsetY = resolveObjectField(obj.name, 'speechOffsetY') ?? 0;
  obj.facing = resolveObjectField(obj.name, 'facing') || null;

  // A spriteless state has zero visual dimensions. Clear any previous sprite and
  // recompute `x` from the persistent anchor, matching the sizing path below.
  const newSrc = resolveObjectField(obj.name, 'sprite');
  if (!newSrc) {
    obj.spriteSrc = null;
    obj.spriteImg = null;
    obj.w = 0;
    obj.h = 0;
    obj.x = obj.anchorX - obj.w / 2;
  } else if (newSrc !== obj.spriteSrc) {
    obj.spriteSrc = newSrc;
    const img = getSprite(ASSET_TYPES.sprite, newSrc);
    obj.spriteImg = img;
    function applySpriteSize() {
      if (!img.complete || !img.naturalWidth) return;
      if (obj.spriteImg !== img) return; // swapped again before this load resolved
      const dims = worldSpriteSize(img.naturalWidth, img.naturalHeight, obj.columns, obj.totalRows, resolveObjectField(obj.name, 'height'));
      obj.w = dims.w;
      obj.h = dims.h;
      obj.x = obj.anchorX - obj.w / 2;
    }
    applySpriteSize();
    // Await the cached `ready` promise rather than adding a `load` listener: this
    // runs on every state change, and repeated refreshes before the sheet decodes
    // would each leave a listener behind on the shared Image.
    if (!img.complete || !img.naturalWidth) img.ready.then(applySpriteSize);
  }

  obj.frame = obj.animReverse ? obj.animFrames - 1 : 0;
  obj.frameTimer = 0;
}

/**
 * Single funnel for state transitions, whether triggered by a script action
 * or by an animation completing. Updates save state, refreshes the live
 * instance (if present), and notifies the observer.
 */
export function applyObjectState(name, newState) {
  setSavedObjectState(name, newState);
  const obj = objects[name];
  if (obj) {
    obj.state = newState;
    refreshObjectFields(obj);
  }
  if (objectChangeHandler) objectChangeHandler(name);
}

/**
 * Resolved current state: the live instance's state if present, else the
 * diverged save value, else the def's `initialState`. Used by
 * `waitForState` and the script `getObjectState` query, so both observe a
 * transient (unpersisted) instance state.
 */
export function currentObjectState(name) {
  if (objects[name]) return objects[name].state;
  const stored = getSavedObjectState(name);
  if (stored) return stored;
  const def = objectRegistry[name];
  return def ? def.initialState : undefined;
}

/**
 * Creates a runtime placement at (x, y) — for objects whose scene or coords
 * aren't knowable at authoring time, like an NPC dropping something. `persist`
 * (default true) writes owner + position so it survives a reload; `false`
 * leaves a live-only instance. `state` overrides the resolved initial state,
 * persisted on the same terms.
 */
export function spawnObjectAt(name, x, y, persist = true, state) {
  if (!currentScene) return null;
  if (persist) {
    setObjectOwner(name, currentScene);
    setObjectPosition(name, x, y);
  }
  // x, y is the origin point (bottom-center). def.hotspot in objects.json
  // stores relative offsets from the origin for programmatic spawning.
  const obj = spawnObject(name, { x: x, y: y }, /* checkSavedOwner */ false, state, persist);
  if (objectChangeHandler) objectChangeHandler(name);
  return obj;
}

/**
 * Transfers an object's ownership (no walk, no scene reaction). `owner` defaults
 * to the player; pass an actor name to hand it off instead — actor-owned objects
 * render nowhere, so this doubles as "consumed by NPC".
 */
export function giveObject(name, owner) {
  setObjectOwner(name, owner || getPlayerActor());
  clearObjectPosition(name);
  delete objects[name];
  if (objectChangeHandler) objectChangeHandler(name);
}

/**
 * Destroys an object — owner becomes null, all stored position is cleared,
 * the live instance (if any) is removed. The object no longer renders or
 * appears in inventory anywhere. Used for "consumed" / "taken from
 * inventory".
 */
export function removeObject(name) {
  setObjectOwner(name, null);
  clearObjectPosition(name);
  delete objects[name];
  if (objectChangeHandler) objectChangeHandler(name);
}

/**
 * Tick hook — advances object frame counters, handling looping vs
 * hold-on-last-frame. One-shot animations hold on the final frame; scripts
 * observe completion via the `waitForAnimation` action.
 */
export function tickObjects(dt) {
  const list = Object.values(objects);
  const dtMs = dt * 1000;
  for (let i = 0; i < list.length; i++) tickObjectAnimation(list[i], dtMs);
}

function tickObjectAnimation(obj, dtMs) {
  if (obj.animFrames <= 1 || obj.animFrameMs <= 0) return;

  // A one-shot holds on the frame it ends on: the last frame forward, the
  // first frame reversed. Once held there's nothing left to advance.
  const endFrame = obj.animReverse ? 0 : obj.animFrames - 1;
  if (!obj.animLoop && obj.frame === endFrame) return;

  obj.frameTimer += dtMs;
  const step = obj.animReverse ? -1 : 1;
  while (obj.frameTimer >= obj.animFrameMs) {
    const advance = frameAdvanceMs(obj.animFrameMs, obj.animJitterMs);
    obj.frameTimer -= advance;
    if (obj.animLoop) {
      obj.frame = (obj.frame + step + obj.animFrames) % obj.animFrames;
    } else {
      obj.frame += step;
      if (obj.frame === endFrame) {
        obj.frameTimer = 0;
        return;
      }
    }
  }
}

// Hotspot objects hit-test against their polygon; sprite-only objects against
// authored bounds. Objects don't depth-scale (scale 1); only actors traverse depth.
function hitTestObject(obj, nx, ny) {
  if (obj.hotspot) return pointInPolygon(nx, ny, obj.hotspot);
  const b = spriteBounds(obj.anchorX, obj.y, obj.w, obj.h, obj.offsetX, obj.offsetY, 1);
  return nx >= b.minX && nx <= b.maxX && ny >= b.minY && ny <= b.maxY;
}

/**
 * Returns the origin point (bottom-center) used for walk destinations and
 * proximity checks. Hotspot objects use the bottom-center of their polygon
 * bounds; sprite objects use their anchor point.
 */
function objectInteractPoint(obj) {
  if (obj.hotspot) {
    const b = polygonBounds(obj.hotspot);
    return { x: (b.minX + b.maxX) / 2, y: b.maxY };
  }
  return { x: obj.anchorX, y: obj.y };
}

/**
 * Kind-agnostic interact point — the single "where interactions happen"
 * abstraction. Objects resolve to their hotspot/anchor; actors resolve to
 * their feet plus the authored `approachX`/`approachY` offset, so the
 * approaching actor comes to rest at the authored spot. Stays a pure function
 * of the entity. interaction.js uses this for walk destinations.
 */
export function entityInteractPoint(entity) {
  if (entity.kind === 'object') return objectInteractPoint(entity);
  return { x: entity.x + entity.w / 2 + entity.approachX, y: entity.y + entity.approachY };
}

/**
 * Instantly repositions a live actor or object to the bottom-center anchor
 * (x, y), matching `walkTo()` and `spawnObject()`. Position only — facing,
 * state, animation, speech, following and triggers are untouched — but an actor
 * abandons its walk path, whose destination no longer applies.
 */
export function teleportEntity(name, x, y) {
  const actor = actors[name];
  if (actor) {
    actor.x = x - actor.w / 2;
    actor.y = y;
    actor.path = [];
    return;
  }

  const obj = objects[name];
  if (!obj) {
    console.error(`[teleport] no live actor or object named "${name}" in the current scene.`);
    return;
  }

  if (getObjectOwner(name) !== currentScene) setObjectOwner(name, currentScene);
  setObjectPosition(name, x, y);

  // Translate the live instance by the anchor delta so the hotspot polygon
  // (absolute scene coords) moves with the origin it was offset from. The
  // vertical anchor is `obj.y`; only `obj.x` diverges from its anchor (by half
  // the sprite width), so it is recomputed rather than translated.
  const dx = x - obj.anchorX;
  const dy = y - obj.y;
  obj.anchorX = x;
  obj.y = y;
  obj.x = obj.anchorX - obj.w / 2;
  if (obj.hotspot) obj.hotspot = obj.hotspot.map(function (p) { return [p[0] + dx, p[1] + dy]; });
}

// ══ Interaction picking ══════════════════
//
// Rendering and hit-testing share one ordered list (entitiesInDrawOrder):
// whatever the player perceives as on top is what receives hover, click, and
// drag-drop. Portals are picked separately (see Portals) as the highest category.

// Front-to-back comparator: `flat` entities sort first (drawn beneath), the
// rest by ascending y. Entities with equal plane and y compare equal.
function compareDrawOrder(a, b) {
  const af = a.plane === 'flat';
  const bf = b.plane === 'flat';
  if (af !== bf) return af ? -1 : 1;
  return a.y - b.y;
}

/**
 * All world entities in shared draw order: back-to-front, so the last element
 * is topmost. Rendering and interaction picking both consume this single list,
 * so they always resolve depth identically, ties included. The guarantee is
 * that there is one ordering, not two orderings kept in sync.
 */
export function entitiesInDrawOrder() {
  const entities = [...Object.values(objects), ...Object.values(actors)];
  entities.sort(compareDrawOrder);
  return entities;
}

/**
 * The interactable the player would perceive as topmost at a native-space
 * point, or null. Walks entities front-to-back and returns the frontmost hit,
 * deferring to each kind's own hit-test. The player, hidden entities, and
 * `interaction: 'none'` entities are inert and skipped.
 */
export function interactableAtNativePoint(nx, ny) {
  const list = entitiesInDrawOrder();
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (e === player || e.visible === false || e.interaction === 'none') continue;
    const hit = e.kind === 'object' ? hitTestObject(e, nx, ny) : hitTestActor(e, nx, ny);
    if (hit) return e;
  }
  return null;
}

// ══ Scripts ══════════════════════════════

let triggers = [];
let scripts = {};

/**
 * Fires a scene trigger event against the current scene's trigger list.
 * Returns the number of triggers that fired (handled = `fired > 0`) so
 * callers can apply semantic fallback when nothing matched.
 */
export function runSceneTrigger(event, eventObject, eventTarget) {
  return runTriggers(event, triggers, scripts, eventObject, eventTarget);
}

// Bridge flag transitions into the current scene's trigger list. Registered
// once at module load, not in initScene(), which owns DOM references only.
onFlagSet(function (flag) { runSceneTrigger(SCENE_TRIGGERS.flagSet, flag); });

/** @returns {string[]} Authored script names declared by the current scene, in declaration order. */
export function getSceneScriptNames() {
  return Object.keys(scripts);
}

/**
 * Starts a named script declared in the current scene's `scripts` block.
 * Warns and no-ops when the name isn't declared.
 */
export function startSceneScript(scriptName) {
  const def = scripts[scriptName];
  if (!def) {
    console.warn(`[startScript] unknown script "${scriptName}" — no-op.`);
    return;
  }
  startScript(scriptName, Array.isArray(def) ? def : def.steps, !Array.isArray(def) && def.cutscene);
}

/**
 * Backs the `waitForAnimation` script action for both actors and objects (so it
 * lives here with the script runtime rather than in either entity section).
 * Returns a completion-check function that resolves true once the entity's
 * currently-playing **non-looping** animation finishes, or **null** when
 * there's nothing to wait on — no one-shot in progress, or the active
 * animation loops (warns, since a loop never ends and blocking would hang).
 * A null return tells the script to advance immediately.
 *
 * @returns {(() => boolean) | null} Completion predicate, or null when there's nothing to wait on.
 */
export function animationWaitCondition(name) {
  const actor = actors[name];
  if (actor) {
    // Actors: one-shots are overrides (gait animations always loop). The
    // override auto-clears when a loop:false clip ends, which is our signal.
    if (!actor.animOverride) return null;
    const clip = actor.animations && actor.animations[actor.animOverride];
    if (!clip) return null;
    if (clip.loop !== false) {
      console.warn(`[waitForAnimation] actor "${name}": animation "${actor.animOverride}" loops — nothing to wait for.`);
      return null;
    }
    const startOverride = actor.animOverride;
    return function () {
      const a = actors[name];
      return !a || a.animOverride !== startOverride;
    };
  }

  const obj = objects[name];
  if (obj) {
    if (obj.animFrames <= 1 || obj.animFrameMs <= 0) return null;
    if (obj.animLoop) {
      console.warn(`[waitForAnimation] object "${name}": animation loops — nothing to wait for.`);
      return null;
    }
    // loop:false object animations hold on the frame they end on when
    // finished: the last frame forward, the first frame reversed.
    return function () {
      const o = objects[name];
      if (!o) return true;
      return o.animReverse ? o.frame <= 0 : o.frame >= o.animFrames - 1;
    };
  }

  return null;
}

// ══ Scene transitions ════════════════════

/**
 * Enters the current scene at the named entry. Spawns the player actor at
 * the entry point (with a portal walk-in when the entry has a `walk`
 * direction), saves progress, announces the arrival framing, runs the
 * `sceneEnter` trigger, and marks the reveal as pending.
 */
export function enterScene(entryName) {
  if (typeof entryName !== 'string' || !entryName) {
    console.warn(`[enterScene] missing \`entryName\` for scene "${currentSceneName()}" — entry is required. Aborting entry.`);
    return;
  }
  if (!portals.entries[entryName]) {
    console.warn(`[enterScene] entry "${entryName}" not declared in scene "${currentSceneName()}". Aborting entry.`);
    return;
  }

  spawnActor(getPlayerActor(), entryName);
  saveProgress(currentSceneName(), entryName);

  // A walk-in entrance is framed on the entry rather than on the offscreen
  // spawn point, so the arrival plays in view.
  const entry = portals.entries[entryName];
  let framedOnX = null; // no player spawned: nothing to frame the arrival on
  if (player) framedOnX = VALID_DIRECTIONS[entry.walk] ? entry.x : player.x + player.w / 2;
  if (sceneEnterHandler) sceneEnterHandler(framedOnX);

  runTriggers(SCENE_TRIGGERS.sceneEnter, triggers, scripts);
  revealPending = true;
  // spawnActor has already set `portalWalk` for walk-in entries, so the
  // portal-walk lock now covers the walk-in; release the transition lock.
  sceneTransitioning = false;
}

/**
 * Transitions to another scene. Fades the current scene out, waits for the
 * fade, then loads + enters the destination.
 *
 * Same-scene transitions re-initialize from scratch, so stale state like an
 * NPC frozen mid-dialogue from the prior visit doesn't carry over.
 */
export function changeScene(sceneName, entryName) {
  if (typeof sceneName !== 'string' || !sceneName) {
    console.warn('[changeScene] missing `scene` — both `scene` and `entry` are required. Aborting.');
    return;
  }
  if (typeof entryName !== 'string' || !entryName) {
    console.warn(`[changeScene] missing \`entry\` for scene "${sceneName}" — entry is required. Aborting.`);
    return;
  }

  sceneTransitioning = true;
  player = null;
  clearSpeech();
  stopScript();

  gameElement.style.opacity = '0';
  if (sceneHideHandler) sceneHideHandler();

  // Swap only after the fade-out has played, or we'd fade out the *new* scene.
  // `#app` fades as a group and the next scene's entities don't spawn until
  // loadScene resolves, so one whole picture fades out and the next fades in.
  const swap = function () {
    setCurrentScene(sceneName);
    loadScene(function () { enterScene(entryName); });
  };

  if (CONFIG.scene.fadeMs > 0) setTimeout(swap, CONFIG.scene.fadeMs);
  else swap();
}

// ══ Scene load ═══════════════════════════
//
// Gather sprite-asset refs for everything that appears as the scene reveals:
// the world backdrop, placements (static + save-state), the `provides`
// references crossref reports (script spawns/gives, overlay inserts), owned
// inventory icons, and the player actor. A ref is a `{ type, name }` pair
// sprites.js resolves and caches.
//
// Scope rule: preload only content the scene brings IN — `provides` references.
// `requires` references (setObjectState/removeObject targets) name content
// assumed already present, so their assets are not preloaded here.

function objectSpriteRefs(def) {
  if (!def) return [];
  const out = [];
  if (def.sprite) out.push({ type: ASSET_TYPES.sprite, name: def.sprite });
  if (def.icon) out.push({ type: ASSET_TYPES.icon, name: def.icon });
  if (def.states) {
    const keys = Object.keys(def.states);
    for (let i = 0; i < keys.length; i++) {
      const state = def.states[keys[i]];
      if (state.sprite) out.push({ type: ASSET_TYPES.sprite, name: state.sprite });
      if (state.icon) out.push({ type: ASSET_TYPES.icon, name: state.icon });
    }
  }
  return out;
}

function actorSpriteRefs(def) {
  if (!def) return [];
  const out = [];
  if (def.sprite) out.push({ type: ASSET_TYPES.sprite, name: def.sprite });
  if (def.states) {
    const keys = Object.keys(def.states);
    for (let i = 0; i < keys.length; i++) {
      const state = def.states[keys[i]];
      if (state.sprite) out.push({ type: ASSET_TYPES.sprite, name: state.sprite });
    }
  }
  return out;
}

function gatherSpriteRefs(sceneData, placements, ownedItems, playerActor) {
  const objectNames = new Set(Object.keys(placements || {})); // static + save-state placements
  const actorNames = new Set();
  const refs = new Map(); // "type:name" → { type, name }, deduped
  if (playerActor) actorNames.add(playerActor);

  function add(ref) {
    refs.set(ref.type + ':' + ref.name, ref);
  }

  // What the scene brings in: the backdrop, plus script spawns/gives and overlay
  // inserts. Placements are already covered above. Backdrops and inserts have no
  // registry entry, so they contribute a ref directly.
  for (const edge of sceneReferences(sceneData)) {
    if (edge.nature !== 'provides') continue;
    if (edge.entity === 'backdrop') { add({ type: ASSET_TYPES.backdrop, name: edge.name }); continue; }
    if (edge.via !== 'script') continue;
    if (edge.entity === 'object') objectNames.add(edge.name);
    else if (edge.entity === 'actor') actorNames.add(edge.name);
    else if (edge.entity === 'insert') add({ type: ASSET_TYPES.insert, name: edge.name });
  }

  // Owned inventory items render icons at scene reveal — add them so their
  // sprite/icon refs (including state variants) join the preload set.
  if (ownedItems) for (let i = 0; i < ownedItems.length; i++) objectNames.add(ownedItems[i]);

  objectNames.forEach(function (n) { objectSpriteRefs(objectRegistry[n]).forEach(add); });
  actorNames.forEach(function (n) { actorSpriteRefs(actorRegistry[n]).forEach(add); });
  return Array.from(refs.values());
}

// Scene-level semantic checks the `scene` JSON Schema can't express: cross-
// registry references (a placement names a real object), cross-field shape (a
// hotspot needs an origin to offset from), and no-op conditions (a blocked exit
// with no condition, a trigger whose `run` names no script). Structure — types,
// enums, required fields, geometry point counts, action/event vocab — is
// validated against the schema at the load site (see `loadScene`). The engine
// still loads regardless; these surface authoring mistakes that would otherwise
// fail silently.
function validateSceneSemantics(data) {
  const tag = '[scenes/' + currentSceneName() + '.json]';

  // A `blocked` exit with no condition can never fire.
  const exits = (data.portals && data.portals.exits) || {};
  Object.keys(exits).forEach(function (name) {
    const b = exits[name].blocked;
    if (b && !b.if && !b.ifNot) {
      console.warn(`${tag} portals.exits.${name}.blocked: neither \`if\` nor \`ifNot\` set — blocking condition will never fire.`);
    }
  });

  // Placements: the object must be declared, and a hotspot is meaningless
  // without an origin to offset from. Sprite and hotspot are both optional;
  // an object with neither is a valid invisible, non-interactive instance, so
  // that combination is intentional and not flagged.
  const placements = data.objects || {};
  Object.keys(placements).forEach(function (key) {
    const place = placements[key];
    const def = objectRegistry[key];
    if (!def) {
      console.warn(`${tag} objects.${key}: object key is not declared in objects.json — placement will be ignored.`);
      return;
    }
    const hasHotspot = (Array.isArray(place.hotspot) && place.hotspot.length > 0) ||
                       (Array.isArray(def.hotspot) && def.hotspot.length > 0);
    const hasOrigin = typeof place.x === 'number' && typeof place.y === 'number';
    if (hasHotspot && !hasOrigin) {
      console.warn(`${tag} objects.${key}: hotspot is given without \`x\`/\`y\` — hotspot points are offsets from the placement origin, so both are required.`);
    }
  });

  // A trigger whose `run` names no script fires but does nothing.
  const triggerList = data.triggers || [];
  const scriptMap = data.scripts || {};
  for (let i = 0; i < triggerList.length; i++) {
    const t = triggerList[i];
    if (t.run && !scriptMap[t.run]) {
      console.warn(`${tag} triggers[${i}].run: references unknown script "${t.run}" — trigger will fire but do nothing.`);
    }
  }
}

// Drops stale callbacks when a newer `loadScene` starts before the previous
// one's preload resolves — otherwise the older callback spawns into reset
// state or fires `onLoad` for a scene the user has already left.
let loadToken = 0;

/**
 * Loads the current scene's data, checks its semantics, preloads sprites, then
 * spawns placements and fires `onLoad`.
 *
 * Stale-token guarded: a newer `loadScene` started while this one is in
 * flight cancels this one's spawn + onLoad — otherwise the older callback
 * would spawn into reset state or fire `onLoad` for a scene the user has
 * already left.
 */
export function loadScene(onLoad) {
  const token = ++loadToken;

  resetWorld();
  portals = { entries: {}, exits: {} };
  triggers = [];
  scripts = {};
  actors = {};
  player = null;
  objects = {};
  objectPlacements = {};

  loadSceneDefinition(currentSceneName())
    .then(function (data) {
      if (token !== loadToken) return; // stale: a newer loadScene has begun
      if (!data) { if (onLoad) onLoad(); return; }
      validateSceneSemantics(data); // cross-registry refs, no-op conditions
      if (data.portals) {
        portals.entries = data.portals.entries || {};
        portals.exits = data.portals.exits || {};
      }
      if (data.triggers) triggers = data.triggers;
      if (data.scripts) scripts = data.scripts;
      // Merge static placements (scene JSON) with dynamic placements (save
      // state) — dynamic supersedes static entirely when both exist for the
      // same object, so an item the player has dropped at a different spot
      // doesn't snap back to its original placement. Store the merged map on
      // `objectPlacements` so debug tools can see entries that get skipped at
      // spawn time (owner moved, condition flag, etc.).
      objectPlacements = {};
      if (data.objects) Object.keys(data.objects).forEach(function (key) { objectPlacements[key] = data.objects[key]; });
      const dynamic = getDynamicObjectPlacements(currentScene);
      for (let i = 0; i < dynamic.length; i++) {
        const placement = dynamic[i];
        objectPlacements[placement.name] = { x: placement.x, y: placement.y };
      }

      // Spawn after preload so entities are born sprite-complete — no flicker
      // frame between spawn and first paint. The backdrop rides the same
      // barrier, which is why the world settles here: its extent depends on the
      // decoded image, and everything that spawns next measures against it.
      const refs = gatherSpriteRefs(data, objectPlacements, getInventory(), getPlayerActor());
      Promise.all(refs.map(function (r) { return preloadSprite(r.type, r.name); })).then(function () {
        if (token !== loadToken) return; // stale: drop spawn + onLoad
        applyWorld(data, '[scenes/' + currentSceneName() + '.json]');
        Object.keys(objectPlacements).forEach(function (key) { spawnObject(key, objectPlacements[key]); });
        if (sceneLoadHandler) sceneLoadHandler(data.ambientBarks); // inventory icons now slice decoded sheets
        if (onLoad) onLoad();
      });
    });
}
