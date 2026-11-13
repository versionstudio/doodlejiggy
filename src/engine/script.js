/**
 * @module script
 * Authored sequence execution.
 *
 * Executes authored scene scripts: waits, speech, movement sequencing,
 * trigger flow, and blocking/non-blocking actions.
 *
 * Gameplay effects are delegated outward through injected handlers, so this
 * module executes steps without importing the runtime that carries them out.
 * Handlers must be synchronous; see `initScript` for why.
 */

import { setFlag, clearFlag, hasFlag, conditionsMet } from './state.js';
import { pickNonRepeatingIdx } from './random.js';

// Blocking classification lives here and nowhere else: every entry carries its
// status inline, so a new action cannot be added unclassified. (The schema
// lists the action names separately — see ARCHITECTURE.md.)
//
//   non-blocking → handler completes synchronously, script advances same turn
//   blocking     → script yields, resuming when a condition is met
//
// The question is whether the SCRIPT waits, not whether the side effect keeps
// running: `playAnimation` is non-blocking (it plays on its own clock) while
// `walkTo` blocks until arrival.
const ACTION_DEFS = Object.freeze({
  wait:                 { blocking: true  },
  say:                  { blocking: true  },
  sayRandom:            { blocking: true  },
  walkTo:               { blocking: true  },
  spawnActor:           { blocking: true  },
  removeActor:          { blocking: true  },
  waitForState:         { blocking: true  },
  waitForAnimation:     { blocking: true  },
  waitForInput:         { blocking: true  },
  talkTo:               { blocking: true  },
  changeScene:          { blocking: true  },
  showOverlay:          { blocking: true  },
  dismiss:              { blocking: true  },
  restartGame:          { blocking: true  },
  setFlag:              { blocking: false },
  clearFlag:            { blocking: false },
  setObjectState:       { blocking: false },
  setActorState:        { blocking: false },
  spawnObject:          { blocking: false },
  removeObject:         { blocking: false },
  giveObject:           { blocking: false },
  teleport:             { blocking: false },
  startScript:          { blocking: false },
  stopScript:           { blocking: false },
  follow:               { blocking: false },
  unfollow:             { blocking: false },
  playAnimation:        { blocking: false },
  stopAnimation:        { blocking: false },
  cameraFollow:         { blocking: false },
  moveCamera:           { blocking: false },
  face:                 { blocking: false },
  playMusic:            { blocking: false },
  stopMusic:            { blocking: false },
});

/**
 * What each referencing action names, and the nature of that reference:
 * `provides` brings content into the scene (its assets must be preloaded);
 * `requires` operates on content assumed already present. Consumed by
 * `crossref.js` to build the authored cross-reference graph; keeps file-path
 * knowledge out of `script.js`. `refs` returns names, never URLs.
 */
export const ACTION_REFS = Object.freeze({
  spawnObject:        { nature: 'provides', refs: function (step) { return { objects: [step.object] }; } },
  spawnActor:         { nature: 'provides', refs: function (step) { return { actors:  [step.actor]  }; } },
  giveObject:         { nature: 'provides', refs: function (step) { return { objects: [step.object] }; } },
  removeObject:       { nature: 'requires', refs: function (step) { return { objects: [step.object] }; } },
  setObjectState:     { nature: 'requires', refs: function (step) { return { objects: [step.object] }; } },
  waitForState:       { nature: 'requires', refs: function (step) { return { objects: [step.object], actors: [step.actor] }; } },
  teleport:           { nature: 'requires', refs: function (step) { return { objects: [step.object], actors: [step.actor] }; } },
  showOverlay:        { nature: 'provides', refs: function (step) { return collectOverlayInsertRefs(step); } },
});

// Collects an overlay's insert references: its insert items bring standalone
// full-frame images into the scene (preload edges). Text items reference only
// theme styles, which always resolve (engine `default` fallback) and so are
// not scene dependencies.
function collectOverlayInsertRefs(step) {
  const inserts = [];
  (step.items || []).forEach(function (item) {
    if (item.insert) inserts.push(item.insert);
  });
  return { inserts: inserts };
}

// Derived: action-name lookup (identity map). Exists for ergonomics: IDE
// autocomplete and grep-friendly call sites (`SCRIPT_ACTIONS.face` beats
// `'face'` for findability).
export const SCRIPT_ACTIONS = Object.freeze(
  Object.fromEntries(Object.keys(ACTION_DEFS).map(function (n) { return [n, n]; }))
);

// Empty until initScript injects the real map, so every dispatch site can
// optional-chain its handler rather than guarding the map itself.
let effectHandlers = {};
let runningScripts = []; // { name, steps, stepIdx, cutscene, pending, blocking, elapsed, blockDuration, blockCondition, blockTimeout }

// ══ Wiring ═══════════════════════════════

/**
 * Injects the gameplay-effect handlers map (`face`, `say`, `walkTo`, etc.)
 * that script dispatch calls into.
 *
 * Handlers must be fully synchronous. Async side effects (Promises, setTimeout
 * mutations) break the execution-unit atomicity model — see `ARCHITECTURE.md`
 * § Persistence atomicity model. If you need async-feeling behavior,
 * model the action as blocking and return a completion-check function from
 * the handler (the pattern used by `walkTo`, `spawnActor`, `waitForInput`).
 *
 * Also validates that every `ACTION_DEFS` entry has a boolean `blocking`
 * field. A missing or non-boolean value means inline trigger execution has
 * no rule for it — silent atomicity hole. console.error on miss.
 */
export function initScript(handlers) {
  effectHandlers = handlers;
  const names = Object.keys(ACTION_DEFS);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (typeof ACTION_DEFS[name].blocking !== 'boolean') {
      console.error(`[script] action "${name}" missing boolean \`blocking\` field in ACTION_DEFS.`);
    }
  }
}

// ══ Lifecycle ════════════════════════════

/**
 * Snapshot of the currently running scripts, so callers (the debug overlay)
 * can surface cutscene status without reaching into internal state.
 *
 * @returns {RunningScriptInfo[]} Each running script as its name with its
 * cutscene and pending flags.
 */
export function getRunningScripts() {
  return runningScripts.map(function (s) { return { name: s.name, cutscene: !!s.cutscene, pending: !!s.pending }; });
}

/**
 * True while any cutscene script is actively running. Pending cutscenes
 * (waiting for the world to go idle before starting) do not count — they
 * have not yet claimed control, so other pending cutscenes' idle checks
 * should not see them as a blocker.
 */
export function isCutsceneRunning() {
  for (let i = 0; i < runningScripts.length; i++) {
    if (runningScripts[i].cutscene && !runningScripts[i].pending) return true;
  }
  return false;
}

/**
 * True while a cutscene is queued but has not yet transitioned to running
 * (waiting for the world to go idle before promotion). It exists so the
 * presentation layer can treat an about-to-run cutscene as already owning the
 * screen. The scheduler still gates on `isCutsceneRunning`/lock semantics; a
 * pending cutscene will promote on the next tick, so affordances can suppress
 * now rather than flash for the one frame between the covering lock releasing
 * and promotion.
 */
export function isCutscenePending() {
  for (let i = 0; i < runningScripts.length; i++) {
    if (runningScripts[i].cutscene && runningScripts[i].pending) return true;
  }
  return false;
}

/**
 * True while any running script is blocked on a `waitForInput` step. game.js
 * consults it to route a deliberate input into the gate (satisfying every
 * waiting script at once) instead of into interaction handling.
 */
export function isAwaitingInput() {
  for (let i = 0; i < runningScripts.length; i++) {
    const s = runningScripts[i];
    if (s.blockCondition && s.steps[s.stepIdx] && s.steps[s.stepIdx].action === SCRIPT_ACTIONS.waitForInput) return true;
  }
  return false;
}

/**
 * Starts a script. If a script with the same name is already running, it is
 * stopped first — the new run replaces the old.
 *
 * Cutscene scripts start in a pending state: they do not advance steps until
 * `isInteractionLocked()` reports the world is idle (no speech showing, no
 * other cutscene running, no player portal walk). On transition from pending
 * to running the player's queued intent is cancelled. Two cutscenes pending
 * in the same tick serialise via registration order — once the first
 * transitions to running, the second's idle check fails and it stays pending.
 */
export function startScript(name, steps, cutscene) {
  stopScript(name);
  const s = {
    name, steps, stepIdx: 0,
    cutscene: !!cutscene, pending: !!cutscene,
    blocking: false, elapsed: 0,
    blockDuration: 0, blockCondition: null, blockTimeout: 0,
  };
  runningScripts.push(s);
  return s;
}

/**
 * Stops the named script. When `name` is undefined, stops all running
 * scripts.
 *
 * Notifies the scene layer via `onScriptStop` so any speech owned by the
 * stopped script(s) clears in lockstep — a stopped script's still-visible
 * line would feel like a leak otherwise.
 */
export function stopScript(name) {
  const onStop = effectHandlers.onScriptStop;
  if (name === undefined) {
    if (onStop) {
      for (let i = 0; i < runningScripts.length; i++) onStop(runningScripts[i].name);
    }
    runningScripts = [];
  } else {
    const next = [];
    for (let i = 0; i < runningScripts.length; i++) {
      if (runningScripts[i].name === name) {
        if (onStop) onStop(name);
      } else {
        next.push(runningScripts[i]);
      }
    }
    runningScripts = next;
  }
}

/**
 * Advances the first script currently blocking on a speech step, ending its
 * spoken line early. Returns true iff a step was actually skipped.
 */
export function skipCurrentSpeech() {
  for (let i = 0; i < runningScripts.length; i++) {
    const s = runningScripts[i];
    if (s.blocking && s.steps[s.stepIdx] && isSpeechAction(s.steps[s.stepIdx].action)) {
      s.blocking = false;
      s.stepIdx++;
      return true;
    }
  }
  return false;
}

// ══ Execution ════════════════════════════

const DEFAULT_WALK_TIMEOUT_S = 15; // fallback timeout for a `walkTo` step if the script didn't specify one
const DEFAULT_WAIT_FOR_STATE_TIMEOUT_S = 10; // fallback timeout for a `waitForState` step

// Tracks the last picked index per `sayRandom` step's `lines` array so
// consecutive runs of the same step avoid repeating the previous line.
// WeakMap keyed on the array (not the step) — survives across script re-runs
// while letting GC reclaim entries when scenes unload their authored data.
const lastSayRandomIdx = new WeakMap();

function isSpeechAction(action) {
  return action === SCRIPT_ACTIONS.say || action === SCRIPT_ACTIONS.sayRandom;
}

function isAnotherScriptSpeaking(self) {
  for (let i = 0; i < runningScripts.length; i++) {
    const o = runningScripts[i];
    if (o === self) continue;
    if (o.blocking && o.steps[o.stepIdx] && isSpeechAction(o.steps[o.stepIdx].action)) return true;
  }
  return false;
}

// Shared speech-step execution for `say` and `sayRandom`. Caller resolves the
// final `text` (literal for `say`, random pick for `sayRandom`) so the authored
// step never gets mutated — same script can re-run and re-pick.
function executeSay(s, step, text) {
  // Optional `facing` modifier: an actor turns to the given direction at the
  // moment speech actually fires — staged with the line, not on script start,
  // so it pairs naturally with the spoken line. Object speakers don't face.
  if (step.facing) effectHandlers.face?.(step.actor, step.facing);

  // Optional `duration` (seconds) overrides the speech layer's automatic
  // per-line timing. The `say` handler returns the duration it resolved, and
  // the script blocks on exactly that — the block wait and the bubble timer
  // cannot diverge. A dropped line (unknown speaker) resolves to 0, so the
  // script advances instead of waiting on speech that never showed.
  // Optional `effect` passes through unresolved; the speech layer (showSpeech)
  // falls back to the speaker's `speechEffect` default when it's absent.
  const overrideMs = step.duration != null ? step.duration * 1000 : undefined;

  const durationMs = effectHandlers.say?.(step.actor || step.object, text, s.name, overrideMs, step.effect);

  s.elapsed = 0;
  s.blockDuration = durationMs ?? 0;
  s.blocking = true;
}

function tickSingleScript(s, dtMs) {
  // A pending cutscene advances no steps until the world goes idle, then
  // promotes and cancels the player's queued intent via `onCutsceneStart`.
  // Only this dt path checks `pending`: the inline trigger path runs leading
  // non-blocking steps regardless, as pre-cutscene staging.
  if (s.pending) {
    if (effectHandlers.isInteractionLocked?.()) return false;
    s.pending = false;
    effectHandlers.onCutsceneStart?.();
  }

  if (s.blocking) {
    s.elapsed += dtMs;
    if (s.elapsed < s.blockDuration) return false;
    s.blocking = false;
    s.stepIdx++;
  }

  if (s.blockCondition) {
    s.elapsed += dtMs;
    if (!s.blockCondition() && s.elapsed < s.blockTimeout) return false;
    s.blockCondition = null;
    s.blockTimeout = 0;
    s.elapsed = 0;
    s.stepIdx++;
  }

  return executeSteps(s);
}

/**
 * Yields the script on a completion predicate: the one blocking shape every
 * predicate-returning handler shares. A `timeoutS` of Infinity is a
 * player-paced gate that never times out.
 *
 * @returns {boolean} True when the script yielded. A non-function `cond` means
 * there is nothing to wait on, so it returns false and the caller advances.
 */
function blockOn(s, cond, timeoutS) {
  if (typeof cond !== 'function') return false;
  s.blockCondition = cond;
  s.blockTimeout = timeoutS * 1000;
  s.elapsed = 0;
  return true;
}

/**
 * Advances a script until it yields (a blocking step or a block condition),
 * runs out of steps, or is removed mid-flight by a cascading `changeScene`.
 * The one per-step dispatch, driving both the dt tick and inline triggers.
 *
 * @returns {boolean} True when the caller should remove the script. Inline
 * execution ignores it — there, "yielded" and "finished" both mean stop.
 */
function executeSteps(s) {
  while (s.stepIdx < s.steps.length) {
    // Script was cleared mid-iteration — e.g. a nested cascade ran
    // `changeScene` which stopped all scripts including this one. Without
    // this guard, subsequent steps would mutate state on the now-loaded
    // scene. The same-script changeScene case is handled below by the
    // explicit `return true` in its branch.
    if (runningScripts.indexOf(s) === -1) return false;
    const step = s.steps[s.stepIdx];

    // Pending cutscenes execute only their leading non-blocking prefix inline
    // (pre-cutscene staging atomic with the trigger). A blocking step run here
    // would fire its side effects (e.g. `say` → showSpeech) while the script's
    // own timer stays frozen by the pending gate, double-waiting once pending
    // clears. Bail out and let the tick path run it after the gate releases.
    if (s.pending && ACTION_DEFS[step.action] && ACTION_DEFS[step.action].blocking) return false;

    if (step.action === SCRIPT_ACTIONS.wait) {
      s.elapsed = 0; s.blockDuration = step.seconds * 1000; s.blocking = true;
      return false;
    }

    if (step.action === SCRIPT_ACTIONS.say) {
      // Global speech lock: only one script can be speaking at a time. If
      // another script is already in a blocking `say`, this script's step
      // waits — next tick it tries again. Keeps concurrent triggers (e.g.
      // item-specific pickup line + catch-all first-pickup intro) speaking
      // in trigger-array order instead of overwriting each other.
      if (isAnotherScriptSpeaking(s)) return false;
      executeSay(s, step, step.text);
      return false;
    }

    if (step.action === SCRIPT_ACTIONS.sayRandom) {
      // Same global speech lock and blocking semantics as `say` — only the
      // line source differs. Empty/missing `lines` array is a silent no-op
      // (matches engine fallback shape: nothing to pick = nothing to say).
      if (!Array.isArray(step.lines)) {
        console.warn('[script] sayRandom step missing `lines` array; skipping.');
        s.stepIdx++; continue;
      }
      if (step.lines.length === 0) { s.stepIdx++; continue; }
      if (isAnotherScriptSpeaking(s)) return false;
      const idx = pickNonRepeatingIdx(step.lines, lastSayRandomIdx.get(step.lines));
      lastSayRandomIdx.set(step.lines, idx);
      executeSay(s, step, step.lines[idx]);
      return false;
    }

    if (step.action === SCRIPT_ACTIONS.walkTo) {
      const cond = effectHandlers.walkTo?.(step.actor, step.x, step.y);
      if (blockOn(s, cond, step.timeout || DEFAULT_WALK_TIMEOUT_S)) return false;
      s.stepIdx++; continue;
    }

    if (step.action === SCRIPT_ACTIONS.setFlag) { setFlag(step.flag); s.stepIdx++; continue; }
    if (step.action === SCRIPT_ACTIONS.clearFlag) { clearFlag(step.flag); s.stepIdx++; continue; }
    if (step.action === SCRIPT_ACTIONS.setObjectState) { effectHandlers.setObjectState?.(step.object, step.state); s.stepIdx++; continue; }
    if (step.action === SCRIPT_ACTIONS.setActorState) { effectHandlers.setActorState?.(step.actor, step.state, step.persist); s.stepIdx++; continue; }
    if (step.action === SCRIPT_ACTIONS.spawnObject) { effectHandlers.spawnObject?.(step.object, step.x, step.y, step.persist, step.state); s.stepIdx++; continue; }
    if (step.action === SCRIPT_ACTIONS.removeObject) { effectHandlers.removeObject?.(step.object); s.stepIdx++; continue; }
    if (step.action === SCRIPT_ACTIONS.giveObject) { effectHandlers.giveObject?.(step.object, step.target); s.stepIdx++; continue; }
    if (step.action === SCRIPT_ACTIONS.teleport) { effectHandlers.teleport?.(step.actor || step.object, step.x, step.y); s.stepIdx++; continue; }
    if (step.action === SCRIPT_ACTIONS.spawnActor) {
      // Only a walk-in entry (one with a `walk` direction) blocks; coord spawns
      // and no-walk entries advance immediately.
      const cond = effectHandlers.spawnActor?.(step.actor, step.entry, step.x, step.y, step.facing, step.state);
      if (blockOn(s, cond, step.timeout || DEFAULT_WALK_TIMEOUT_S)) return false;
      s.stepIdx++; continue;
    }

    if (step.action === SCRIPT_ACTIONS.removeActor) {
      // Only `exit` blocks — it makes the despawn multi-stage (walk-to-exit →
      // walk-off → despawn). Without it the despawn is immediate.
      const cond = effectHandlers.removeActor?.(step.actor, step.exit);
      if (blockOn(s, cond, step.timeout || DEFAULT_WALK_TIMEOUT_S)) return false;
      s.stepIdx++; continue;
    }

    if (step.action === SCRIPT_ACTIONS.waitForState) {
      // Mirror of `waitForAnimation`: `actor` or `object` selects which live
      // state to observe; the condition polls the resolved current state.
      const target = step.state;
      const name = step.actor || step.object;
      const getState = step.actor ? 'getActorState' : 'getObjectState';
      s.blockCondition = function () {
        return effectHandlers[getState]?.(name) === target;
      };
      s.blockTimeout = (step.timeout || DEFAULT_WAIT_FOR_STATE_TIMEOUT_S) * 1000;
      s.elapsed = 0;
      return false;
    }

    if (step.action === SCRIPT_ACTIONS.waitForAnimation) {
      // Blocks only on a one-shot in progress; nothing playing (or a loop, which
      // would never end) advances immediately.
      const cond = effectHandlers.waitForAnimation?.(step.actor || step.object);
      if (blockOn(s, cond, step.timeout || DEFAULT_WAIT_FOR_STATE_TIMEOUT_S)) return false;
      s.stepIdx++; continue;
    }

    if (step.action === SCRIPT_ACTIONS.startScript) { effectHandlers.startScript?.(step.script); s.stepIdx++; continue; }
    if (step.action === SCRIPT_ACTIONS.stopScript) { stopScript(step.name); s.stepIdx++; continue; }
    if (step.action === SCRIPT_ACTIONS.follow) { effectHandlers.follow?.(step.actor, step.target, step.distance); s.stepIdx++; continue; }
    if (step.action === SCRIPT_ACTIONS.unfollow) { effectHandlers.unfollow?.(step.actor); s.stepIdx++; continue; }
    if (step.action === SCRIPT_ACTIONS.playAnimation) { effectHandlers.playAnimation?.(step.actor, step.animation); s.stepIdx++; continue; }
    if (step.action === SCRIPT_ACTIONS.stopAnimation) { effectHandlers.stopAnimation?.(step.actor); s.stepIdx++; continue; }
    if (step.action === SCRIPT_ACTIONS.cameraFollow) { effectHandlers.cameraFollow?.(step.actor, step.lerp); s.stepIdx++; continue; }
    if (step.action === SCRIPT_ACTIONS.moveCamera) { effectHandlers.moveCamera?.(step.x, step.actor, step.object, step.lerp); s.stepIdx++; continue; }
    if (step.action === SCRIPT_ACTIONS.face) { effectHandlers.face?.(step.actor, step.facing); s.stepIdx++; continue; }
    if (step.action === SCRIPT_ACTIONS.playMusic) { effectHandlers.playMusic?.(step.music, { loop: step.loop, fadeInMs: step.fadeInMs }); s.stepIdx++; continue; }
    if (step.action === SCRIPT_ACTIONS.stopMusic) { effectHandlers.stopMusic?.({ fadeOutMs: step.fadeOutMs }); s.stepIdx++; continue; }
    if (step.action === SCRIPT_ACTIONS.changeScene) {
      // Validate at the dispatch site so a missing `scene`/`entry` advances
      // the step instead of falling through to the handler — which would
      // early-return without `stopScript`, leaving this script alive and the
      // tick loop hammering the same broken step every frame.
      if (typeof step.scene !== 'string' || !step.scene || typeof step.entry !== 'string' || !step.entry) {
        console.warn('[script] changeScene step missing `scene` or `entry` — both are required. Skipping.');
        s.stepIdx++;
        continue;
      }
      effectHandlers.changeScene?.(step.scene, step.entry);
      return true;
    }

    if (step.action === SCRIPT_ACTIONS.showOverlay) {
      // Handler installs the overlay; the script blocks for exactly the
      // authored transition — pure duration, like `wait`. Missing
      // `transitionMs` means an instant transition (0 ms), so a bare
      // showOverlay yields for a single tick and moves on.
      effectHandlers.showOverlay?.(step, s.name);
      s.elapsed = 0; s.blockDuration = step.transitionMs || 0; s.blocking = true;
      return false;
    }

    if (step.action === SCRIPT_ACTIONS.dismiss) {
      // Blocks through the dismissal timeline (holdMs + transitionMs). The
      // handler reports whether an overlay was actually dismissed; a dismiss
      // with none active is a no-op and doesn't wait out the authored timings.
      const dismissed = effectHandlers.dismiss?.(step);
      s.elapsed = 0;
      s.blockDuration = dismissed ? (step.holdMs || 0) + (step.transitionMs || 0) : 0;
      s.blocking = true;
      return false;
    }

    if (step.action === SCRIPT_ACTIONS.waitForInput) {
      // Player-paced gate: the predicate resolves on the next deliberate input,
      // and waits forever by design (no timeout).
      if (blockOn(s, effectHandlers.waitForInput?.(), Infinity)) return false;
      s.stepIdx++; continue;
    }

    if (step.action === SCRIPT_ACTIONS.restartGame) {
      // Terminal, like changeScene: the handler tears the world down and
      // reboots, so steps after it never run.
      effectHandlers.restartGame?.();
      return true;
    }

    if (step.action === SCRIPT_ACTIONS.talkTo) {
      // Player-paced like `waitForInput`: opens dialogue mode and clears only
      // when the player exits the conversation.
      if (blockOn(s, effectHandlers.talkTo?.(step.target), Infinity)) return false;
      s.stepIdx++; continue;
    }

    s.stepIdx++;
  }

  return true;
}

/**
 * Tick hook — advances all running scripts by `dt` seconds.
 */
export function tickScript(dt) {
  if (runningScripts.length === 0) return;
  const dtMs = dt * 1000;
  const removed = [];
  for (let i = 0; i < runningScripts.length; i++) {
    if (tickSingleScript(runningScripts[i], dtMs)) removed.push(i);
  }

  for (let i = removed.length - 1; i >= 0; i--) {
    runningScripts.splice(removed[i], 1);
  }
}

// ══ Trigger cascade ══════════════════════
//
// Engine-event triggers (pickup, look, sceneEnter, actorEnter, etc.) call
// `runUntilBlocked` on each script they queue, so the script's leading
// non-blocking steps execute in the same JS turn as the triggering event.
//
// Recursive: an inline step calling `spawnActor` can fire `actorEnter`,
// which calls `runSceneTrigger` → `runTriggers` → `runUntilBlocked`. Depth
// is bounded by MAX_TRIGGER_CASCADE_DEPTH to surface authoring cycles.

const MAX_TRIGGER_CASCADE_DEPTH = 32;
let cascadeDepth = 0;

/**
 * Synchronously advances a freshly-queued script until it hits a blocking
 * step, runs out of steps, is removed (e.g. via cascading changeScene), or
 * the trigger-cascade depth cap is reached.
 *
 * Bypasses the `pending` cutscene check: leading non-blocking steps are
 * pre-cutscene staging (state setup atomic with the triggering event), not
 * the cutscene's visible presentation — those defer to the tick path's
 * pending-handling as before.
 */
export function runUntilBlocked(s) {
  if (cascadeDepth >= MAX_TRIGGER_CASCADE_DEPTH) {
    console.error(`[script] trigger cascade exceeded MAX_TRIGGER_CASCADE_DEPTH (${MAX_TRIGGER_CASCADE_DEPTH}) — bailing. Check authored triggers for cycles.`);
    return;
  }
  cascadeDepth++;
  try { executeSteps(s); }
  finally { cascadeDepth--; }
}

/**
 * Fires every trigger in `triggerList` matching `event`, returning the
 * number that fired. Callers use the count for semantic fallback (e.g.
 * play a default line when no authored trigger ran).
 *
 * `eventObject` and `eventTarget` are optional subjects of an event:
 *   - single-subject events (`objectPickup`, `objectLook`, `actorLook`,
 *     `objectUse`, `actorUse`) → eventObject = entity name.
 *   - two-subject events (`useObjectOnObject`, `useObjectOnActor`) →
 *     eventObject = source inventory item, eventTarget = target entity name.
 *   - portal-traversal events (`actorEnter`, `actorArrive`, `actorExit`) →
 *     eventObject = actor name, eventTarget = portal entry/exit name.
 *   - the pre-resolution event (`engage`) → eventObject = engaged entity
 *     name for objects/actors; eventTarget = exit name for portal exits.
 *   - the flag-transition event (`flagSet`) → eventObject = the flag that just
 *     went false → true.
 *
 * Triggers filter on these via `object`/`target` (interaction vocabulary) or
 * the synonyms `actor`/`entry`/`exit` (portal vocabulary). All synonyms are
 * semantically identical — they just read more naturally for the relevant
 * event.
 *
 * The `flag` filter is special: it names the flag(s) the trigger cares about,
 * and an array means *all* must now be set. Because the trigger is only tested
 * when a listed flag transitions, it wakes on the last flag of the set.
 *
 * Matching is atomic: the full set of matching triggers is decided against the
 * state at event-raise time, before any of their scripts run.
 */
export function runTriggers(event, triggerList, scriptMap, eventObject, eventTarget) {
  if (!triggerList) return 0;

  // All triggers for one event match against the state when it was raised —
  // one atomic pass, which must stay separate from the dispatch loop below:
  // matched scripts run their leading steps inline, so a merged pass would let
  // an earlier trigger's `setFlag` decide whether a later sibling fires.
  const matched = [];
  for (let i = 0; i < triggerList.length; i++) {
    const t = triggerList[i];
    if (t.on !== event) continue;
    if (t.object && t.object !== eventObject) continue;
    if (t.actor && t.actor !== eventObject) continue;
    if (t.flag) {
      const req = Array.isArray(t.flag) ? t.flag : [t.flag];
      if (!req.includes(eventObject)) continue; // this change doesn't concern us
      if (!req.every(hasFlag)) continue; // combination not yet complete
    }
    if (t.target && t.target !== eventTarget) continue;
    if (t.entry && t.entry !== eventTarget) continue;
    if (t.exit && t.exit !== eventTarget) continue;
    if (!conditionsMet(t)) continue;
    matched.push(t);
  }

  let fired = 0;
  for (let i = 0; i < matched.length; i++) {
    const t = matched[i];
    if (scriptMap && scriptMap[t.run]) {
      const def = scriptMap[t.run];
      // Capture the script reference at queue time — a nested cascade can
      // push more scripts onto runningScripts before we run inline, so we can't
      // infer "the script we just queued" from array position.
      const queued = startScript(t.run, Array.isArray(def) ? def : def.steps, !Array.isArray(def) && def.cutscene);
      runUntilBlocked(queued);
      fired++;
    } else if (t.run) {
      console.warn(`[trigger] on=${event} references unknown script "${t.run}" — skipping.`);
    }
  }
  return fired;
}
