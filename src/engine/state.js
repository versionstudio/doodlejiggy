/**
 * @module state
 * Persistent progression state: flags, inventory ownership, entity state
 * overrides, persisted placements, description and dialogue progression, and
 * save persistence. Also holds the configured player-actor identity (boot-set,
 * not persisted).
 *
 * Owns cross-scene progression, never transient runtime simulation.
 */
import CONFIG from './config.js';

const save = {
  flags:     {},
  scene:     null,
  entry:     null,
  objects:   {}, // name → { owner, state, x, y, descIndex } — only present when diverged from default
  actors:    {}, // name → { state, descIndex } — sparse; `state` present only when a persistent transition diverged it from the def's initialState
  dialogues: {}, // actor → dialogue name → { unlocked, removed, greeted } — topic progression, sparse
};

// ══ Save persistence ═════════════════════

const SAVE_KEY = 'dj';
const canPersist = import.meta.env.DEV || CONFIG.save.enabled;

let dirty = false;
let writeScheduled = false;

/**
 * Marks the save as dirty and schedules a single end-of-turn flush.
 * Coalesces every mutation in the current JS turn into one localStorage
 * write — the persistence half of the execution-unit atomicity model.
 * See `ARCHITECTURE.md` § Persistence atomicity model.
 */
function markDirty() {
  dirty = true;
  if (writeScheduled) return;
  writeScheduled = true;
  queueMicrotask(flush);
}

function flush() {
  writeScheduled = false;
  if (!dirty) return;
  dirty = false;
  if (!canPersist) return;
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      scene:     save.scene,
      entry:     save.entry,
      flags:     Object.keys(save.flags),
      objects:   save.objects,
      actors:    save.actors,
      dialogues: save.dialogues,
    }));
  } catch (e) {}
}

export function saveProgress(scene, entry) {
  save.scene = scene;
  save.entry = entry;
  markDirty();
}

/** @returns {{ scene: string|null, entry: string|null }} */
export function loadProgress() {
  if (!canPersist) return { scene: null, entry: null };
  try {
    const data = JSON.parse(localStorage.getItem(SAVE_KEY) || '{}');
    if (data.flags) data.flags.forEach(function (f) { save.flags[f] = true; });
    if (data.objects) save.objects = data.objects;
    if (data.actors) save.actors = data.actors;
    if (data.dialogues) save.dialogues = data.dialogues;
    return { scene: data.scene || null, entry: data.entry || null };
  } catch (e) { return { scene: null, entry: null }; }
}

export function clearProgress() {
  save.flags = {};
  save.scene = null;
  save.entry = null;
  save.objects = {};
  save.actors = {};
  save.dialogues = {};
  // Cancel any pending flush so it doesn't re-write an empty save after the
  // key is removed below. Not strictly required for correctness (the empty
  // save and a missing key are equivalent on load), but cleaner on disk.
  dirty = false;
  if (!canPersist) return;
  try { localStorage.removeItem(SAVE_KEY); } catch (e) {}
}

// ══ Flags ════════════════════════════════

let flagSetHandler = null;
/**
 * Fires when a flag first transitions false → true. scene.js bridges it into
 * the current scene's `flagSet` triggers.
 */
export function onFlagSet(fn) {
  flagSetHandler = fn;
}

// Emit `flagSet` only on a real false → true transition: a redundant set is a
// silent no-op, so a trigger waiting on a combination's completing flag fires
// exactly once. Store before dispatch so a handler reading `hasFlag` sees it set.
export function setFlag(name) {
  if (save.flags[name] === true) return;
  save.flags[name] = true;
  markDirty();
  if (flagSetHandler) flagSetHandler(name);
}

export function clearFlag(name) {
  delete save.flags[name];
  markDirty();
}

export function hasFlag(name) {
  return save.flags[name] === true;
}

export function getFlags() {
  return Object.keys(save.flags);
}

/**
 * The engine-wide `if`/`ifNot` condition predicate. Every gated node (scene
 * triggers, dialogue topics, portal exits and their `blocked` clause, object
 * placements, ambient bark variants) passes its own node here.
 *
 * Each condition is a single flag name or an array of names. `if` passes when
 * every listed flag is set; `ifNot` passes when none are. Both requirements
 * must hold. A node with neither condition passes unconditionally.
 */
export function conditionsMet(node) {
  const asArray = f => Array.isArray(f) ? f : [f];
  if (node.if && !asArray(node.if).every(hasFlag)) return false;
  if (node.ifNot && asArray(node.ifNot).some(hasFlag)) return false;
  return true;
}

// ══ Player actor ═════════════════════════

// Name of the authored actor the engine treats as the player character. Set
// once at boot from game.json, before the first scene load; not persisted.
// The single source of truth for "which actor is the player" — inventory
// ownership and scene.js both resolve the player through it.
let playerActor = null;

export function setPlayerActor(name) {
  playerActor = name;
}

export function getPlayerActor() {
  return playerActor;
}

// ══ Objects ══════════════════════════════

export function getObjectOwner(name) {
  return save.objects[name] ? save.objects[name].owner : undefined;
}

export function setObjectOwner(name, owner) {
  if (!save.objects[name]) save.objects[name] = {};
  save.objects[name].owner = owner;
  markDirty();
}

export function getSavedObjectState(name) {
  return save.objects[name] ? save.objects[name].state : undefined;
}

/**
 * Changing state clears any stored description index.
 */
export function setSavedObjectState(name, newState) {
  if (!save.objects[name]) save.objects[name] = {};
  save.objects[name].state = newState;
  delete save.objects[name].descIndex;
  markDirty();
}

export function setObjectPosition(name, x, y) {
  if (!save.objects[name]) save.objects[name] = {};
  save.objects[name].x = x;
  save.objects[name].y = y;
  markDirty();
}

export function clearObjectPosition(name) {
  if (!save.objects[name]) return;
  delete save.objects[name].x;
  delete save.objects[name].y;
  markDirty();
}

/**
 * Returns dynamically spawned objects that belong to the given scene.
 * Static authored placements (declared in scene JSON) are excluded.
 *
 * @returns {{ name: string, x: number, y: number }[]}
 */
export function getDynamicObjectPlacements(sceneName) {
  const out = [];
  const keys = Object.keys(save.objects);
  for (let i = 0; i < keys.length; i++) {
    const name = keys[i];
    const e = save.objects[name];
    if (e.owner !== sceneName) continue;
    if (e.x === undefined || e.y === undefined) continue;
    out.push({ name: name, x: e.x, y: e.y });
  }
  return out;
}

/** @returns {string[]} Names of objects owned by the player. */
export function getInventory() {
  return Object.keys(save.objects).filter(function (n) {
    return save.objects[n].owner === playerActor;
  });
}

// ══ Actors ═══════════════════════════════
//
// Only the *persisted* state lives here. Transient (presentation) states are
// set on the live instance and never reach the save — so a save mid-cutscene
// reloads at the persisted baseline, not the transient state. See README
// § Actor lifecycle.

export function getSavedActorState(name) {
  return save.actors[name] ? save.actors[name].state : undefined;
}

export function setSavedActorState(name, state) {
  if (!save.actors[name]) save.actors[name] = {};
  save.actors[name].state = state;
  markDirty();
}

// ══ Description progression ══════════════
//
// Actors and objects maintain separate progression buckets.

function descBucket(kind) {
  return kind === 'actor' ? save.actors : save.objects;
}

/**
 * @param {'actor'|'object'} kind
 */
export function getDescIndex(kind, name) {
  const b = descBucket(kind);
  return b[name] ? (b[name].descIndex || 0) : 0;
}

/**
 * Bumps the description index, clamped to `length - 1` so the index never
 * exceeds the array.
 *
 * @param {'actor'|'object'} kind
 */
export function bumpDescIndex(kind, name, length) {
  const b = descBucket(kind);
  if (!b[name]) b[name] = {};
  b[name].descIndex = Math.min((b[name].descIndex || 0) + 1, length - 1);
  markDirty();
}

// ══ Dialogue progression ═════════════════
//
// The persistent conversation memory for one (actor, dialogue) pair, exposed
// as a handle: callers acquire it once and perform all progression operations
// through it. World progression, not transient UI state. Records are keyed by
// actor + dialogue so the same dialogue definition reused by two actors
// progresses independently for each. Sparse — a per-actor-dialogue record is
// created only on first write. Unknown persisted topic IDs (a dialogue edited
// between sessions) are simply never matched, so they're ignored on load.

/**
 * Returns the progression handle for one actor+dialogue pair: the persistent
 * memory of what the player has covered in that conversation. The handle binds
 * only the keys — the underlying record is created lazily on first write, so
 * acquiring a handle never allocates persisted state, and a held handle stays
 * valid across `clear()`.
 */
export function dialogueProgress(actor, dialogue) {
  return {
    hasGreeted() {
      const r = dialogueRecord(actor, dialogue, false);
      return !!(r && r.greeted);
    },
    markGreeted() {
      dialogueRecord(actor, dialogue, true).greeted = true;
      markDirty();
    },
    isUnlocked(topicId) {
      const r = dialogueRecord(actor, dialogue, false);
      return !!(r && r.unlocked[topicId]);
    },
    unlock(topicId) {
      dialogueRecord(actor, dialogue, true).unlocked[topicId] = true;
      markDirty();
    },
    isRemoved(topicId) {
      const r = dialogueRecord(actor, dialogue, false);
      return !!(r && r.removed[topicId]);
    },
    remove(topicId) {
      dialogueRecord(actor, dialogue, true).removed[topicId] = true;
      markDirty();
    },
    // Clears the record (greeting + unlocked/removed topics) so the next talk
    // replays from first-encounter state. Does NOT revert flags the dialogue
    // set — those are wider world state, not this dialogue's own progression.
    clear() {
      const byDialogue = save.dialogues[actor];
      if (!byDialogue || !byDialogue[dialogue]) return;
      delete byDialogue[dialogue];
      if (Object.keys(byDialogue).length === 0) delete save.dialogues[actor];
      markDirty();
    },
  };
}

/** @returns {{ actor: string, dialogue: string }[]} Every persisted progression record (debug inspection / reset). */
export function getDialogueRecords() {
  const out = [];
  Object.keys(save.dialogues).forEach(function (actor) {
    Object.keys(save.dialogues[actor]).forEach(function (dialogue) {
      out.push({ actor: actor, dialogue: dialogue });
    });
  });
  return out;
}

function dialogueRecord(actor, dialogue, create) {
  const a = save.dialogues[actor];
  if (!a) { if (!create) return null; save.dialogues[actor] = {}; }
  const byDialogue = save.dialogues[actor];
  if (!byDialogue[dialogue]) { if (!create) return null; byDialogue[dialogue] = { unlocked: {}, removed: {}, greeted: false }; }
  return byDialogue[dialogue];
}
