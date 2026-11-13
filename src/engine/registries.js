/**
 * @module registries
 * Authored content loading: the sole owner of the data files under
 * `CONFIG.paths.data`. No other module names a data file, fetches it, parses it,
 * or checks its structure.
 *
 * Provides two things: the actor, object, and dialogue registries (runtime
 * lookup tables) coordinated to readiness, and the game and scene definitions
 * callers ask for by name. What a definition *means* stays with the modules that
 * own it: semantic validation in the leaf modules (`validateActorDefs`, etc.),
 * which this module invokes at the right point, and interpretation in `game.js` /
 * `scene.js`. Runtime operations (entering/transitioning scenes) are NOT here;
 * the caller launches the world once `loadRegistries` resolves.
 */

import CONFIG from './config.js';
import { actorRegistry, validateActorDefs } from './actors.js';
import { objectRegistry, validateObjectDefs } from './objects.js';
import { dialogueRegistry, validateDialogueDefs, validateDialogueRefs } from './dialogues.js';
import { validateSchema } from './schemas.js';

// ══ Data loading ═════════════════════════
//
// One path for every authored data file: fetch the JSON under
// `CONFIG.paths.data`, then structure-check it against its schema. Resolve-always:
// a non-OK response or fetch error logs and yields null so every caller can
// proceed unconditionally. The `[file.json]` tag each warning carries is derived
// here, so a message always names the file the author has to open.

function loadDataFile(file, schema) {
  const tag = '[' + file + ']';
  return fetch(CONFIG.paths.data + file)
    .then(function (r) {
      if (!r.ok) {
        console.error(`${tag} failed to load (HTTP ${r.status}).`);
        return null;
      }
      return r.json();
    })
    .then(function (data) {
      if (data) validateSchema(schema, data, tag); // structure: required/allowed fields, types, enums, typos
      return data;
    })
    .catch(function (err) {
      console.error(`${tag} failed to load:`, err);
      return null;
    });
}

/**
 * The parsed, structurally validated `game.json`. `game.js` decides what its
 * contents mean.
 *
 * @returns {Promise<object|null>} the game definition, or null when the file is
 * missing or unreadable.
 */
export function loadGameDefinition() {
  return loadDataFile('game.json', 'game');
}

/**
 * The parsed, structurally validated definition of one scene. Scene semantics
 * and lifecycle stay with `scene.js`.
 *
 * @returns {Promise<object|null>} the scene definition, or null when the file is
 * missing or unreadable.
 */
export function loadSceneDefinition(name) {
  return loadDataFile('scenes/' + name + '.json', 'scene');
}

// ══ Registries ═══════════════════════════
//
// One lifecycle for all three registries: load the authored data and merge it
// into the live registry object. A failed load leaves the registry as-is so boot
// can proceed unconditionally.

// Recursively freezes a def and everything under it, enforcing the read-only
// contract (see `ARCHITECTURE.md` § Data model). DEV-only: a tripwire that
// turns any accidental def mutation into a loud throw during development without
// risking a player-facing crash in production. Skips already-frozen nodes so the
// walk is idempotent.
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i++) deepFreeze(value[keys[i]]);
  return value;
}

function loadRegistry(file, schema, target) {
  return loadDataFile(file, schema).then(function (data) {
    if (!data) return;
    Object.assign(target, data);
    if (import.meta.env.DEV) Object.values(target).forEach(deepFreeze);
  });
}

/**
 * Loads and validates the authored-data registries, resolving when the data
 * needed to enter a scene — the actor and object registries — is loaded and
 * valid.
 *
 * Does NOT mean "all validation finished": dialogues load in parallel without
 * gating (no scene depends on them), and `validateDialogueRefs` is a
 * warning-only cross-reference side effect (actor `dialogue` fields → real
 * dialogues) that runs when its registries are ready and deliberately does not
 * gate readiness.
 *
 * @returns {Promise<void>} resolves when the authored data is loaded and validated.
 */
export function loadRegistries() {
  const actors = loadRegistry('actors.json', 'actors', actorRegistry)
    .then(validateActorDefs); // semantics: initialState + sprite-grid derivability
  const objects = loadRegistry('objects.json', 'objects', objectRegistry)
    .then(validateObjectDefs); // semantics: cross-state refs, pickup icon
  const dialogues = loadRegistry('dialogues.json', 'dialogues', dialogueRegistry)
    .then(validateDialogueDefs); // semantics: cross-refs, cycles, reachability

  // Warning-only cross-reference check: runs when both registries it spans are
  // ready. Intentionally NOT awaited by the returned promise — it doesn't gate
  // launching the world (see contract above).
  Promise.all([actors, dialogues]).then(function () { validateDialogueRefs(actorRegistry); });

  return Promise.all([actors, objects]);
}
