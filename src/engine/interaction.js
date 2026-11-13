/**
 * @module interaction
 * Semantic interaction dispatch.
 *
 * Coordinates high-level interaction semantics between runtime systems:
 * walk-then-interact sequencing, semantic fallback handling, and dispatch
 * into scene-authored orchestration hooks.
 *
 * This module owns no persistent state. Its only runtime state is transient
 * walk-then-interact bookkeeping (pending pickup / use-on). Runtime scene
 * state, scene orchestration, scripting, dialogue, and persistence remain
 * owned by their respective subsystems.
 *
 * Not: event bus, pub/sub, ECS interaction system, gameplay scripting
 * framework. Four canonical verbs, dispatched.
 *
 * Anti-drift rules (read before touching this module):
 *
 *   1. No flag reads. Conditional gameplay logic belongs in authored
 *      triggers (`if`/`ifNot`), not in dispatch code.
 *   2. No per-entity name special-cases. Per-object behavior belongs in
 *      scene scripts.
 *   3. No new private state beyond transient walk-then-interact bookkeeping.
 *   4. No DOM, no canvas, no CSS, no UI strings beyond fallback lookups.
 *      Input routing belongs in game.js.
 *   5. No new verbs without distinct engine semantics. Contextual flavor
 *      flows through `use` + scene triggers.
 *   6. No imports from render.js.
 *   7. No dialogue trees or choice menus. The dialogue runtime (narrative.js)
 *      owns those; this module invokes it via an injected `talk` handler and
 *      resolves talk vs talkText, nothing more.
 *
 * This module shrinks under pressure, it does not grow. If a new feature
 * seems to demand more code here, the feature is probably misplaced.
 */

import { objects, actors, player, SCENE_TRIGGERS, runSceneTrigger, entityInteractPoint, faceActor, walkActorTo, walkActorOff, giveObject, resolveObjectField, changeScene, portalExitInteractPoint } from './scene.js';
import { startScript, runUntilBlocked, SCRIPT_ACTIONS } from './script.js';
import { getDescIndex, bumpDescIndex, conditionsMet } from './state.js';
import { OBJECT_TRANSITIONS } from './objects.js';

const INTERACTIONS = Object.freeze({
  look:   'look',
  pickup: 'pickup',
  use:    'use',
  talk:   'talk',
});

// Engine-default fallback lines: one plain variant per category, so every
// engine path speaks even with no authored `messages` block. Deliberately
// minimal — flavor variants are what authoring is for. A game's array
// replaces its default whole (per-key merge in initInteractions), never
// concatenates.
const ENGINE_FALLBACKS = Object.freeze({
  pickup:        ["I can't pick that up."],
  use:           ["That doesn't seem useful here."],
  useOnObject:   ["That doesn't seem to work."],
  useOnActor:    ["I don't think that's a good idea."],
  portalBlocked: ["I can't go that way right now."],
});

let fallbacks = Object.assign({}, ENGINE_FALLBACKS);
let talkHandler = null; // injected dialogue-mode entry point (startActorDialogue); see initInteractions

// ══ Wiring ═══════════════════════════════

/**
 * Merges the game's fallback messages over the engine defaults and injects
 * the dialogue-mode talk handler. `talk` is invoked with an actor name when a
 * talkable actor with a `dialogue` is clicked — kept as an injected handler
 * so this module never imports the dialogue runtime (downward-only import
 * rule).
 */
export function initInteractions(opts) {
  fallbacks = Object.assign({}, ENGINE_FALLBACKS, opts && opts.messages && opts.messages.fallbacks);
  talkHandler = (opts && opts.talk) || null;
}

// ══ Entry points ═════════════════════════
//
// Each entry captures input, walks the player to the target's interact
// point, and dispatches on arrival. Object and actor clicks re-resolve the
// verb from the live entity at dispatch time so mid-walk state changes are
// honored. Per-function JSDoc only documents what's unique.

let pendingInteract = null; // { entity, completion } — direct scene interaction; verb re-resolved on arrival
let pendingUseOn = null; // { sourceName, target: { name, kind }, completion } — inventory drop-on-target
let pendingExit = null; // { exit, completion } — walk-to-exit then changeScene (or blocked-message)
let pendingWalkOff = null; // { destination, completion } — walk-off in progress; changeScene fires on completion

/**
 * Direct click on a scene object or actor. One path for both kinds: the walk
 * target comes from `entityInteractPoint` and the verb is re-resolved from the
 * live entity on arrival, so nothing here depends on which kind was clicked.
 */
export function interactWithEntity(entity) {
  if (!player) return;
  cancelPendingInteractions();

  const interactPoint = entityInteractPoint(entity);
  const completion = walkActorTo(player.name, interactPoint.x, interactPoint.y);

  if (!completion) { resolveAndDispatch(entity); return; }
  pendingInteract = { entity: entity, completion: completion };
}

/**
 * Direct click on a portal exit. Either runs the blocked-message say or
 * transitions to the destination scene, depending on the exit's `blocked`
 * clause.
 *
 * Crossing scene boundaries is distinct engine semantics from the verb-
 * driven interactions handled above; this is a sibling dispatch path,
 * not a verb.
 */
export function interactWithExit(exit) {
  if (!player) return;
  cancelPendingInteractions();

  const interactPoint = portalExitInteractPoint(exit.def);
  const completion = walkActorTo(player.name, interactPoint.x, interactPoint.y);

  if (!completion) { dispatchExit(exit); return; }
  pendingExit = { exit: exit, completion: completion };
}

/**
 * Inventory item dropped on a scene target. Fires the matching scene
 * trigger; falls back to the `fallbacks.useOn{Object,Actor}` pool when no
 * trigger handled.
 */
export function useObjectOnTarget(sourceName, target) {
  if (!player) return;
  cancelPendingInteractions();

  const live = target.kind === 'actor' ? actors[target.name] : objects[target.name];
  if (!live) return;

  const interactPoint = entityInteractPoint(live);
  const completion = walkActorTo(player.name, interactPoint.x, interactPoint.y);

  if (!completion) { fireUseOn(sourceName, target); return; }
  pendingUseOn = { sourceName: sourceName, target: target, completion: completion };
}

/**
 * Inventory icon click — always look, regardless of the item's `interaction`
 * field. No walk, no scene-positional context. Still fires `objectLook` after
 * the engine semantic so authors can react uniformly to look events.
 */
export function lookAtInventory(name) {
  if (!player) return;
  cancelPendingInteractions();
  dispatchInventoryLook(name);
}

/**
 * Tick hook — polls pending walks and dispatches on arrival.
 */
export function tickInteractions(_dt) {
  if (pendingInteract && pendingInteract.completion()) {
    const pending = pendingInteract; pendingInteract = null;
    resolveAndDispatch(pending.entity);
  }

  if (pendingUseOn && pendingUseOn.completion()) {
    const pending = pendingUseOn; pendingUseOn = null;
    fireUseOn(pending.sourceName, pending.target);
  }

  if (pendingExit && pendingExit.completion()) {
    const pending = pendingExit; pendingExit = null;
    dispatchExit(pending.exit);
  }

  if (pendingWalkOff && pendingWalkOff.completion()) {
    const pending = pendingWalkOff; pendingWalkOff = null;
    changeScene(pending.destination.scene, pending.destination.entry);
  }
}

/**
 * Clears all transient pending state.
 *
 * Called from game.js on scene visibility off so a mid-walk scene transition
 * cannot leak completion functions whose closures point at the previous
 * scene's entities.
 */
export function cancelPendingInteractions() {
  pendingInteract = null;
  pendingUseOn = null;
  pendingExit = null;
  pendingWalkOff = null;
}

// ══ Engage ═══════════════════════════════
//
// The first public stage of the interaction lifecycle: the player has reached
// an interaction target (object, actor, or portal exit), after approach and
// before any resolution. A matching `engage` trigger replaces the interaction
// — the engine performs no resolution (verb dispatch, use-on dispatch, or
// exit resolution, including the `blocked` check). Every walk-then-interact
// pipeline fires this on arrival, and a new pipeline must too; inventory icon
// look has no approach phase, so it never engages. See ARCHITECTURE.md
// § Interaction lifecycle.

// Entity targets pass the entity name as `eventObject` (matched by the
// `object`/`actor` filters); portal exits pass the exit name as `eventTarget`
// (matched by the `exit` filter, same vocabulary as the traversal events).
function fireEngage(eventObject, eventTarget) {
  return runSceneTrigger(SCENE_TRIGGERS.engage, eventObject, eventTarget) > 0;
}

// ══ Dispatch resolution ══════════════════

// Mid-walk state changes can change `interaction` between click and arrival
// (objects mirror their state-resolved interaction onto the live instance via
// refreshObjectFields). Re-read at dispatch time, not at click time, so the
// engine reacts to current state.
function resolveAndDispatch(entity) {
  if (!entityStillLive(entity)) return; // entity despawned mid-walk
  if (entity.facing) faceActor(player.name, entity.facing); // authored interaction pose, if any
  if (fireEngage(entity.name)) return;
  const verb = entity.interaction || INTERACTIONS.look;

  if (verb === INTERACTIONS.pickup) { dispatchPickup(entity); return; }
  if (verb === INTERACTIONS.use) { dispatchUse(entity); return; }
  if (verb === INTERACTIONS.talk) { dispatchTalk(entity); return; }
  dispatchLook(entity);
}

function entityStillLive(entity) {
  if (entity.kind === 'actor') return actors[entity.name] === entity;
  return objects[entity.name] === entity;
}

// ══ Look ═════════════════════════════════

const SCENE_LOOK_SCRIPT_NAME = '__sceneLook'; // walk-then-say (+ optional setObjectState) — scene look
const INVENTORY_LOOK_SCRIPT_NAME = '__inventoryLook'; // say (+ optional setObjectState), no walk — inventory icon look

function dispatchLook(entity) {
  const text = pickDescription(entity.kind, entity.name, entity);

  // State mutation before blocking step — atomic with the triggering look.
  // setObjectState (transitions.look) runs synchronously in the same JS turn
  // as the look event; the description `say` is the atomic-group boundary.
  const steps = [];
  if (entity.kind === 'object' && entity.transitions && entity.transitions[OBJECT_TRANSITIONS.look]) {
    steps.push({ action: SCRIPT_ACTIONS.setObjectState, object: entity.name, state: entity.transitions[OBJECT_TRANSITIONS.look] });
  }
  if (text) steps.push({ action: SCRIPT_ACTIONS.say, actor: player.name, text: text });

  // Trigger fires AFTER engine semantic (description + state transition). The
  // trigger then sees the post-transition state via `waitForState` etc.
  const triggerName = entity.kind === 'actor' ? SCENE_TRIGGERS.actorLook : SCENE_TRIGGERS.objectLook;

  if (steps.length > 0) {
    runUntilBlocked(startScript(SCENE_LOOK_SCRIPT_NAME, steps, false));
  }

  runSceneTrigger(triggerName, entity.name);
}

function dispatchInventoryLook(name) {
  const text = pickDescription('object', name);
  const transitions = resolveObjectField(name, 'transitions');

  // State mutation before blocking step — atomic with the triggering look.
  const steps = [];
  if (transitions && transitions[OBJECT_TRANSITIONS.look]) {
    steps.push({ action: SCRIPT_ACTIONS.setObjectState, object: name, state: transitions[OBJECT_TRANSITIONS.look] });
  }
  if (text) steps.push({ action: SCRIPT_ACTIONS.say, actor: player.name, text: text });

  // Trigger fires unconditionally, matching scene look — the description and
  // the `objectLook` trigger are independent consequences of looking.
  if (steps.length > 0) runUntilBlocked(startScript(INVENTORY_LOOK_SCRIPT_NAME, steps, false));
  runSceneTrigger(SCENE_TRIGGERS.objectLook, name);
}

// ══ Pickup ═══════════════════════════════

const SCENE_PICKUP_SCRIPT_NAME = '__scenePickup'; // optional say + optional setObjectState — scene pickup

function dispatchPickup(entity) {
  if (entity.kind !== 'object') {
    // Pickup on an actor is engine-rejected. Fallback line, no trigger.
    sayFallback('pickup');
    return;
  }

  // Capture pickupText off the live entity before giveObject clears the
  // scene-side instance — mirrors how dispatchLook reads off the live entity.
  const pickupText = entity.pickupText;
  const transitions = entity.transitions;
  giveObject(entity.name); // ownership transfer, onObjectChange

  // State mutation before blocking step — atomic with the triggering pickup.
  // The synthetic script's leading non-blocking steps run synchronously in
  // the same JS turn as giveObject, so the pickup transition persists with
  // the ownership change. The pickupText `say` is the atomic-group boundary.
  const steps = [];
  if (transitions && transitions[OBJECT_TRANSITIONS.pickup]) {
    steps.push({ action: SCRIPT_ACTIONS.setObjectState, object: entity.name, state: transitions[OBJECT_TRANSITIONS.pickup] });
  }
  // pickupText is string-or-array; an array desugars into consecutive player
  // `say` steps (the `say` action itself stays string-only). Objects without
  // pickupText normalize to zero lines, so no `say` is queued.
  normalizeMessage(pickupText).forEach(function (line) {
    steps.push({ action: SCRIPT_ACTIONS.say, actor: player.name, text: line });
  });

  if (steps.length > 0) runUntilBlocked(startScript(SCENE_PICKUP_SCRIPT_NAME, steps, false));
  runSceneTrigger(SCENE_TRIGGERS.objectPickup, entity.name);
}

// ══ Use ══════════════════════════════════

function dispatchUse(entity) {
  const triggerName = entity.kind === 'actor' ? SCENE_TRIGGERS.actorUse : SCENE_TRIGGERS.objectUse;
  const fired = runSceneTrigger(triggerName, entity.name);
  if (fired === 0) sayFallback('use');
}

// ══ Talk ═════════════════════════════════
//
// Resolution lives here, not in the dialogue runtime: a `dialogue` actor is
// delegated to the injected handler (dialogue mode); a `talkText` actor speaks
// its line(s) right here, exactly as `look` speaks descriptions; an actor with
// neither is an authoring error (the boot validator is the loud signal). There
// is no engine talk fallback.

const TALK_TEXT_SCRIPT_NAME = '__talkText'; // N say steps — lightweight actor `talkText` (string or array)

function dispatchTalk(entity) {
  if (entity.dialogue && talkHandler) { talkHandler(entity.name); return; }
  if (entity.talkText) { speakTalkText(entity); return; }
}

// talkText desugars into N single-utterance `say` steps (the `say` action stays
// string-only); each line is spoken by the actor, not the player.
function speakTalkText(entity) {
  const lines = normalizeMessage(entity.talkText);
  if (lines.length === 0) return;

  const steps = lines.map(function (line) {
    return { action: SCRIPT_ACTIONS.say, actor: entity.name, text: line };
  });

  runUntilBlocked(startScript(TALK_TEXT_SCRIPT_NAME, steps, false));
}

// ══ Portal exit ══════════════════════════

// The `blocked` clause itself is the gate: when its conditions match, traversal
// is blocked and the player speaks the message via the fallback sayRandom
// plumbing. Blocking requires at least one condition — an unconditional
// `blocked` object never activates, since `conditionsMet({})` is vacuously true.
function exitIsBlocked(blocked) {
  if (!blocked) return false;
  return conditionsMet(blocked) && !!(blocked.if || blocked.ifNot);
}

function dispatchExit(exit) {
  if (fireEngage(undefined, exit.name)) return;
  const def = exit.def;

  if (exitIsBlocked(def.blocked)) {
    // Per-exit message overrides; absence falls through to the
    // `fallbacks.portalBlocked` pool (same pattern as the use-on fails).
    // Without the fallback, an authored `blocked` flag with no copy would
    // silently fail to traverse — looks like a bug to the player.
    const authored = normalizeMessage(def.blocked.message);
    const lines = authored.length > 0 ? authored : normalizeMessage(fallbacks.portalBlocked);
    playerSaysRandom(lines);
    return;
  }

  if (!def.destination || typeof def.destination.scene !== 'string' || typeof def.destination.entry !== 'string') return;

  // Optional cinematic walk-off: actor continues offscreen in the given
  // cardinal direction before the scene change. Camera freezes during the
  // walk-off so the player sees the actor leave the frame. Mirror of the
  // entry's `walk` field. Falls through to an immediate transition if the
  // walk-off can't be initiated (e.g. invalid direction — validator warns).
  if (def.walk && player) {
    const completion = walkActorOff(player.name, def.walk);
    if (completion) {
      pendingWalkOff = { destination: def.destination, completion: completion };
      return;
    }
  }

  changeScene(def.destination.scene, def.destination.entry);
}

// ══ Use-on (inventory drop) ══════════════

function fireUseOn(sourceName, target) {
  const live = target.kind === 'actor' ? actors[target.name] : objects[target.name];
  if (!live) return; // target despawned mid-walk

  if (live.facing) faceActor(player.name, live.facing); // authored interaction pose, if any
  if (fireEngage(target.name)) return;
  const triggerName = target.kind === 'actor' ? SCENE_TRIGGERS.useObjectOnActor : SCENE_TRIGGERS.useObjectOnObject;
  const fired = runSceneTrigger(triggerName, sourceName, target.name);
  if (fired > 0) return;

  sayFallback(target.kind === 'actor' ? 'useOnActor' : 'useOnObject');
}

// ══ Fallback selection ═══════════════════

const PLAYER_SAY_SCRIPT_NAME = '__playerSay'; // single sayRandom, no walk, no transition — engine fallback lines

// Speaks the engine fallback pool named by `key` (a `fallbacks` entry, not a verb:
// the use-on paths key by target kind).
function sayFallback(key) {
  playerSaysRandom(normalizeMessage(fallbacks[key]));
}

// Runs a one-step `sayRandom` script so the script runner owns line selection
// and blocking timing — same speech lock as authored speech.
function playerSaysRandom(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return;
  runUntilBlocked(startScript(PLAYER_SAY_SCRIPT_NAME, [{ action: SCRIPT_ACTIONS.sayRandom, actor: player.name, lines: lines }], false));
}

// Authored spoken-content fields (`blocked.message`, `messages.*` fallbacks,
// `pickupText`, `talkText`) accept a single string or an array of strings.
// Normalize to an array so callers can iterate (sequential `say`) or random-
// pick uniformly.
//
// Empty content — `''`, `null`, `undefined` — normalizes to zero lines, the
// engine's sole representation of "nothing to say": every consumer gates on
// array length, never on line content, so a present-but-empty line would be
// spoken as a blank, screen-holding bubble. Callers iterate the result without
// re-checking for emptiness.
function normalizeMessage(content) {
  if (Array.isArray(content)) return content;
  if (typeof content === 'string' && content) return [content];
  return [];
}

// ══ Helpers ══════════════════════════════

// descIndex-aware description selection. Clamps idx defensively in case the
// authored array was shortened after a save. `liveEntity` is the resolved
// instance (with mirrored description); used as the source of truth for
// scene look paths. For inventory look, liveEntity is undefined and we go
// through resolveObjectField so the current state's description is honored.
function pickDescription(kind, name, liveEntity) {
  const raw = liveEntity ? liveEntity.description : resolveObjectField(name, 'description');
  if (!raw) return '';
  if (!Array.isArray(raw)) return raw;
  if (raw.length === 0) return '';

  const idx = Math.min(getDescIndex(kind, name), raw.length - 1);
  bumpDescIndex(kind, name, raw.length);
  return raw[idx];
}

