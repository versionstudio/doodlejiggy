/**
 * @module narrative
 * Runtime presentation of authored narrative content.
 *
 * Owns runtime presentation state for authored narrative content: the
 * overlay, ambient barks, and topic-based dialogue mode. Pure state and
 * timing — rendering lives in render.js (speech bubbles, the overlay) and
 * game.js (the topic-list DOM overlay), parameterized over the state this
 * module exposes.
 *
 * Boundary: transient runtime only. Persistent dialogue progression (current
 * actor dialogue, unlocked/removed topics, greeting-played) lives in state.js;
 * dialogue definitions live in dialogues.js. This module reads both and drives
 * playback, but persists nothing itself.
 */

import CONFIG from './config.js';
import { actors, currentSceneName,
         showSpeech, clearSpeech, isSpeechShown, getActiveSpeech } from './scene.js';
import { isCutsceneRunning, isCutscenePending } from './script.js';
import { conditionsMet, setFlag, dialogueProgress } from './state.js';
import { actorRegistry } from './actors.js';
import { dialogueRegistry } from './dialogues.js';
import { getSprite, ASSET_TYPES } from './sprites.js';
import { randomFloat, pickNonRepeatingIdx } from './random.js';

// ══ Overlay ══════════════════════════════
//
// The active overlay: one vertical stack of items (styled text and inserts),
// positioned by the overlay's alignment and optionally backed by a
// fullscreen veil, drawn over the world. State, not an
// animation — `setOverlay` sets it, it holds indefinitely, and it ends only by
// replacement, dismissal, or teardown. At most one exists, and the most recent
// overlay command is always authoritative: no queueing, no completing previous
// timelines. Style names and palette keys are stored unresolved; render.js
// resolves them at draw time, keeping this module theme-unaware. This module
// owns all timing: the tick precomputes the render-facing alphas so the
// renderer stays a pure state-to-pixels function.

// The active overlay, or null. `dismissal` is null until `dismissOverlay`
// arms the exit timeline.
let overlay = null;

// Recomputes the render-facing fields — `transitionProgress` (drives the
// renderer's crossfade dissolve), `veilAlpha`, `contentAlpha` — from the
// overlay's timeline state. During dismissal the veil fades from t=0 while the
// content's fade starts at holdMs, both over transitionMs and both scaled by
// the opacity captured when the dismissal armed (an interrupted transition
// continues from where it was, never snapping brighter).
function refreshOverlayAlphas(overlay) {
  overlay.transitionProgress = overlay.transitionMs > 0 ? Math.min(1, overlay.elapsed / overlay.transitionMs) : 1;

  const dismissal = overlay.dismissal;
  if (!dismissal) {
    // Fade ramps in with the transition; crossfade renders at full strength
    // from the start (the outgoing frame dissolves above it in the renderer).
    const alpha = overlay.transition === 'crossfade' ? 1 : overlay.transitionProgress;
    overlay.veilAlpha = alpha;
    overlay.contentAlpha = alpha;
    return;
  }
  const veilProgress = dismissal.transitionMs > 0 ? Math.min(1, dismissal.elapsed / dismissal.transitionMs) : 1;
  const contentProgress = dismissal.elapsed < dismissal.holdMs ? 0
    : (dismissal.transitionMs > 0 ? Math.min(1, (dismissal.elapsed - dismissal.holdMs) / dismissal.transitionMs) : 1);
  overlay.veilAlpha = dismissal.fromVeil * (1 - veilProgress);
  overlay.contentAlpha = dismissal.fromContent * (1 - contentProgress);
}

/**
 * Sets the active overlay from a `showOverlay` step, replacing any current
 * one immediately — at any lifecycle point, including mid-transition.
 * `crossfade` needs a previous overlay to dissolve from, so the first overlay
 * degrades to `fade` per the authoring contract.
 *
 * `scriptName` is the owner used by `clearOverlay(scriptName)`; an overlay
 * whose owner completes naturally persists (deliberate — a title card can hold
 * while its script ends).
 *
 * Insert items are bound to their cached Image here (via sprites.js) and ride
 * on the item as `img` for render.js to draw; text and styling pass through
 * untouched. Items are copied so the authored step stays pristine.
 */
export function setOverlay(step, scriptName) {
  const items = (Array.isArray(step.items) ? step.items : []).map(function (it) {
    if (it.insert === undefined) return it;
    return Object.assign({}, it, { img: getSprite(ASSET_TYPES.insert, it.insert) });
  });
  overlay = {
    items:        items,
    background:   step.background || null,
    align:        step.align || 'center',
    margin:       step.margin || 0,
    offsetX:      step.offsetX || 0,
    offsetY:      step.offsetY || 0,
    transition:   step.transition === 'crossfade' && overlay ? 'crossfade' : 'fade',
    transitionMs: step.transitionMs || 0,
    owner:        scriptName || null,
    elapsed:      0,
    dismissal:    null,
  };
  refreshOverlayAlphas(overlay);
}

/**
 * Arms the dismissal timeline on the active overlay: the veil fades over
 * `transitionMs` from now; the content fades over `transitionMs` starting at
 * `holdMs`; the overlay clears at `holdMs + transitionMs`. Both tracks start
 * from their current opacity, so a dismiss mid-transition never snaps
 * brighter. Returns whether an overlay was active — a dismiss with none is a
 * no-op, exactly like `stopMusic` with nothing playing.
 */
export function dismissOverlay(step) {
  if (!overlay) return false;
  overlay.dismissal = {
    transitionMs: step.transitionMs || 0,
    holdMs:       step.holdMs || 0,
    fromVeil:     overlay.veilAlpha,
    fromContent:  overlay.contentAlpha,
    elapsed:      0,
  };
  refreshOverlayAlphas(overlay);
  return true;
}

/**
 * Clears the active overlay instantly, with no timeline. With no `scriptName`,
 * clears unconditionally — the teardown path (scene transitions, restart)
 * where the overlay must not outlive the world it was drawn over. With a
 * `scriptName`, clears only when that script owns it, so a stale clear from a
 * different script can't yank a newer overlay. (Same `undefined`-means-all
 * shape as `stopScript`.)
 */
export function clearOverlay(scriptName) {
  if (scriptName === undefined || (overlay && overlay.owner === scriptName)) overlay = null;
}

/**
 * True while an overlay is on screen (entering, holding, or dismissing).
 * Observers use this to hide UI chrome and mute ambient barks under the
 * overlay.
 */
export function isOverlayActive() {
  return overlay !== null;
}

/**
 * Render-pass query — game.js passes the result to `renderOverlay()` each
 * frame.
 *
 * @returns {Overlay | null} The active overlay — its items, veil key, layout
 * (align, margin, offsets), transition timeline, owner, and the tick-computed
 * render alphas — or null when none is active.
 */
export function getActiveOverlay() {
  return overlay;
}

// Advances the overlay timeline: enter elapsed always; the dismissal track
// when armed, clearing the overlay once it completes.
function tickOverlay(dt) {
  if (!overlay) return;
  overlay.elapsed += dt * 1000;
  const dismissal = overlay.dismissal;
  if (dismissal) {
    dismissal.elapsed += dt * 1000;
    if (dismissal.elapsed >= dismissal.holdMs + dismissal.transitionMs) { overlay = null; return; }
  }
  refreshOverlayAlphas(overlay);
}

// ══ Ambient barks ════════════════════════
//
// Per-actor random idle lines authored in the scene's `ambientBarks` block.
// Fire via the standard speech bubble with no script owner — ambient
// world flavor, not scripted speech. Mute matrix:
//   - Overlay or cutscene     → cancel any visible bark, pause timers
//   - Script-owned line shown → skip this tick (timers don't advance, so
//                                the bark fires once the script line clears)
//   - Otherwise               → fire on the actor's random interval
//
// Each actor has one bark stream. A bark is authored as a single definition
// or an ordered list of variants; the stream selects the first variant whose
// if/ifNot flags pass (array order is priority). No match → the actor is
// silent. Entering a state — including the switch into or out of silence —
// starts a fresh cadence: the timer re-rolls and the no-repeat history clears.
// Elapsed time never carries across a switch.
//
// Schedules are rebuilt by `applyAmbientBarks`, which game.js calls at the
// `onSceneLoad` seam, once the scene's authored block has landed. Schedules for
// actors who have not spawned yet sit dormant, so they survive the gap between
// that seam and the scene enter that spawns them.

let barkSchedules = {}; // actor name → { variants, activeIdx, timer, lastIdx }

// First bark variant whose if/ifNot flags pass; null when none match (actor silent).
function selectBarkVariant(variants) {
  for (let i = 0; i < variants.length; i++) {
    if (!conditionsMet(variants[i])) continue;
    return i;
  }
  return null;
}

/**
 * Installs the scene's authored `ambientBarks` block, replacing every schedule:
 * the previous scene's streams stop and the incoming ones start on a fresh
 * cadence. A malformed variant warns and is dropped, never rejecting the block.
 */
export function applyAmbientBarks(barks) {
  barkSchedules = {};
  if (!barks) return;
  const tag = '[scenes/' + currentSceneName() + '.json] ambientBarks';
  Object.keys(barks).forEach(function (actorName) {
    const raw = barks[actorName];
    if (!raw) return;
    // A single bark definition and a variant list are the same stream; the
    // scalar form normalizes to a one-variant list.
    const list = Array.isArray(raw) ? raw : [raw];
    const variants = [];
    list.forEach(function (cfg, i) {
      const label = tag + '.' + actorName + (Array.isArray(raw) ? '[' + i + ']' : '');
      if (!cfg || !Array.isArray(cfg.lines) || cfg.lines.length === 0) {
        console.warn(`${label}.lines: must be a non-empty array; variant disabled.`);
        return;
      }
      if (!Array.isArray(cfg.interval) || cfg.interval.length !== 2 ||
          typeof cfg.interval[0] !== 'number' || typeof cfg.interval[1] !== 'number' ||
          cfg.interval[0] < 0 || cfg.interval[1] < cfg.interval[0]) {
        console.warn(`${label}.interval: must be \`[min, max]\` seconds with min ≤ max; variant disabled.`);
        return;
      }
      variants.push({
        interval: cfg.interval,
        lines:    cfg.lines,
        effect:   cfg.effect || null,
        if:       cfg.if    || null,
        ifNot:    cfg.ifNot || null,
      });
    });
    if (variants.length === 0) return;
    barkSchedules[actorName] = { variants: variants, activeIdx: null, timer: 0, lastIdx: null };
  });
}

function tickBarks(dt) {
  // Dialogue mode owns the bubble end to end: suppress barks across the whole
  // mode (lines and topic-selection gaps alike). Between beats the bubble has
  // no owner, so the owner check below wouldn't catch it.
  if (dialogue) return;

  // A higher-priority owner holds the screen: an active overlay, or a
  // cutscene the director is running (a pending cutscene already counts — it
  // has committed to owning the screen). Cancel any visible ambient bark and
  // freeze timers; a script-owned line is left for the isSpeechShown gate below.
  if (overlay || isCutsceneRunning() || isCutscenePending()) {
    const active = getActiveSpeech();
    if (active && !active.ownerScript) clearSpeech();
    return;
  }

  // Script-owned line yields the bubble: skip this tick, do not advance.
  if (isSpeechShown()) return;

  const names = Object.keys(barkSchedules);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const schedule = barkSchedules[name];
    if (!actors[name]) continue; // actor not in scene; bark dormant until they spawn

    const idx = selectBarkVariant(schedule.variants);
    if (idx === null) { schedule.activeIdx = null; schedule.lastIdx = null; continue; } // no match → silent

    // State change (including silence→active) starts a fresh cadence: re-roll
    // the timer and clear the no-repeat history, which indexes the active
    // variant's lines. Elapsed time never carries across a switch.
    if (idx !== schedule.activeIdx) {
      schedule.activeIdx = idx;
      schedule.lastIdx = null;
      schedule.timer = randomFloat(schedule.variants[idx].interval[0], schedule.variants[idx].interval[1]);
      continue;
    }

    const variant = schedule.variants[idx];
    schedule.timer -= dt;
    if (schedule.timer > 0) continue;

    const lineIdx = pickNonRepeatingIdx(variant.lines, schedule.lastIdx);
    schedule.lastIdx = lineIdx;
    showSpeech(name, variant.lines[lineIdx], null, undefined, variant.effect);
    schedule.timer = randomFloat(variant.interval[0], variant.interval[1]);
  }
}

// ══ Dialogue mode ════════════════════════
//
// Topic-based conversations. Transient runtime only; progression persists in
// state.js.
//
// Beats reuse the shared speech pipeline (showSpeech) under a synthetic owner
// sentinel so dialogue lines count as owned speech — they trip isSpeechShown()
// and suppress barks via the same path as scripted lines — without being a real
// script. Line *clearing* is driven by this runtime (beat advancement / topic
// exit) plus changeScene's clearSpeech, never by stopScript. The sentinel is
// private to this module; scene.js only ever checks owner-vs-null.
const DIALOGUE_OWNER = '__dialogue';

// Active dialogue, or null. `phase` is 'playing' (a beat queue is showing) or
// 'topics' (awaiting selection). `currentTopicId` is null while the greeting
// plays. `queue` is a flat list of { speaker, text, effect } beats — line `text`
// arrays are expanded into consecutive same-speaker beats here. `gapMs` is the
// remaining silent speaker-change breather between beats (0 when none pending).
let dialogue = null;

export function isDialogueModeActive() {
  return dialogue !== null;
}

// Resolves an actor's current dialogue: the live instance's `dialogue`
// (state-resolved, so a stateful actor's per-state dialogue is honored), else
// the def's top-level `dialogue` for an unspawned actor. Returns undefined if
// the actor has none.
function getActorDialogue(actorName) {
  const actor = actors[actorName];
  if (actor && actor.dialogue) return actor.dialogue;
  const def = actorRegistry[actorName];
  return def ? def.dialogue : undefined;
}

/**
 * The sole entry point for opening dialogue mode — both click-to-talk and the
 * scripted `talkTo` action. Resolves the actor's current dialogue, then opens it.
 */
export function startActorDialogue(actorName) {
  const dialogueName = getActorDialogue(actorName);
  if (!dialogueName) {
    console.warn(`[startActorDialogue] ${actorName} has no resolvable dialogue.`);
    return;
  }
  openDialogue(actorName, dialogueName);
}

// Opens a resolved actor+dialogue in dialogue mode. Singleton — warns and
// ignores if one is already active.
function openDialogue(actorName, dialogueName) {
  if (dialogue) {
    console.warn(`[openDialogue] a dialogue is already active; ignoring "${dialogueName}".`);
    return;
  }
  const def = dialogueRegistry[dialogueName];
  if (!def) {
    console.warn(`[openDialogue] unknown dialogue "${dialogueName}".`);
    return;
  }

  dialogue = {
    actorName:      actorName,
    dialogueName:   dialogueName,
    def:            def,
    progress:       dialogueProgress(actorName, dialogueName),
    targeted:       collectReferencedTopicIds(def.topics || {}),
    phase:          'playing',
    queue:          [],
    beatIdx:        0,
    currentTopicId: null,
    gapMs:          0,
  };

  if (def.greeting && !dialogue.progress.hasGreeted()) {
    dialogue.progress.markGreeted();
    dialogue.queue = flattenLines(def.greeting, actorName);
  }

  if (dialogue.queue.length > 0) showCurrentBeat();
  else enterTopicPhase();
}

export function stopDialogue() {
  if (!dialogue) return;
  dialogue = null;
  clearSpeech();
}

/**
 * Visible topics for the current selection prompt, in authored order. Returns
 * [] unless awaiting selection (during playback the topic list is hidden).
 *
 * @returns {DialogueTopicOption[]} Each selectable topic as its id and its
 * authored prompt label.
 */
export function getVisibleTopics() {
  if (!dialogue || dialogue.phase !== 'topics') return [];
  return computeVisibleTopics();
}

/** Player picked a topic (click or number key). No-op unless awaiting selection. */
export function selectDialogueTopic(topicId) {
  if (!dialogue || dialogue.phase !== 'topics') return;
  const topic = dialogue.def.topics[topicId];
  if (!topic) return;
  if (!computeVisibleTopics().some(function (t) { return t.id === topicId; })) return; // not currently selectable

  dialogue.currentTopicId = topicId;
  dialogue.queue = topic.conversation ? flattenLines(topic.conversation, dialogue.actorName) : [];
  dialogue.beatIdx = 0;
  dialogue.phase = 'playing';

  if (dialogue.queue.length > 0) showCurrentBeat();
  else finishTopic();
}

/** Skip/advance the current beat (skip key / click during playback). Returns true if it acted. */
export function skipDialogueLine() {
  if (!dialogue || dialogue.phase !== 'playing') return false;
  dialogue.gapMs = 0; // discard any pending speaker-change breather — skip yields to player intent
  advanceBeat();
  return true;
}

function showCurrentBeat() {
  const beat = dialogue.queue[dialogue.beatIdx];
  showSpeech(beat.speaker, beat.text, DIALOGUE_OWNER, undefined, beat.effect);
}

function advanceBeat() {
  dialogue.beatIdx++;
  if (dialogue.beatIdx < dialogue.queue.length) { showCurrentBeat(); return; }
  if (dialogue.currentTopicId === null) enterTopicPhase(); // greeting finished
  else finishTopic();
}

function finishTopic() {
  const id = dialogue.currentTopicId;
  const topic = dialogue.def.topics[id];
  applyConsequences(id, topic);
  // A consequence's `flagSet` cascade can tear the dialogue down (e.g. a
  // triggered script changes scene); recovery is then pure world-state, so
  // there is nothing left to continue here.
  if (!dialogue) return;

  dialogue.currentTopicId = null;
  if (topic.endDialogue) { stopDialogue(); return; }
  enterTopicPhase();
}

// Consequences apply after the conversation completes (never mid-line).
// replaceWith is modelled as remove(source) + unlock(target): the source hides,
// the target becomes visible by the normal unlocked rule.
function applyConsequences(id, topic) {
  const progress = dialogue.progress;
  if (Array.isArray(topic.unlockTopics)) {
    topic.unlockTopics.forEach(function (t) { progress.unlock(t); });
  }
  if (topic.replaceWith !== undefined) {
    progress.remove(id);
    progress.unlock(topic.replaceWith);
  }
  if (topic.removeAfter) progress.remove(id);

  // setFlag last: it synchronously emits `flagSet`, whose trigger cascade must
  // observe the fully committed post-topic state (the topic-graph mutations
  // above already applied), never a partial one. The topic's declarative
  // consequences commit as one unit before any observer runs.
  if (topic.setFlag) setFlag(topic.setFlag);
}

function enterTopicPhase() {
  clearSpeech(); // drop the last beat's bubble; the topic list takes over
  if (computeVisibleTopics().length === 0) { stopDialogue(); return; } // exhausted → exit
  dialogue.phase = 'topics';
}

// A topic is visible if it isn't removed, its conditions pass, and it is either
// a root (not targeted by any unlockTopics/replaceWith) or has been unlocked.
function computeVisibleTopics() {
  const progress = dialogue.progress;
  const topics = dialogue.def.topics || {};
  const out = [];
  Object.keys(topics).forEach(function (id) {
    const topic = topics[id];
    if (progress.isRemoved(id)) return;
    if (!conditionsMet(topic)) return;
    const isRoot = !dialogue.targeted[id];
    if (isRoot || progress.isUnlocked(id)) out.push({ id: id, option: topic.option });
  });
  return out;
}

function collectReferencedTopicIds(topics) {
  const targeted = {};
  Object.keys(topics).forEach(function (id) {
    const topic = topics[id];
    if (Array.isArray(topic.unlockTopics)) topic.unlockTopics.forEach(function (topicId) { targeted[topicId] = true; });
    if (topic.replaceWith !== undefined) targeted[topic.replaceWith] = true;
  });
  return targeted;
}

// Expands authored lines into single-utterance beats. A line's `text` may be a
// string or an array (consecutive utterances by the same speaker); `actor` may
// be omitted, in which case the dialogue owner speaks. A line's optional
// `effect` carries onto every beat expanded from it.
function flattenLines(lines, ownerActorName) {
  const out = [];
  if (!Array.isArray(lines)) return out;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || typeof line !== 'object') continue;
    const speaker = line.actor || ownerActorName;
    const texts = Array.isArray(line.text) ? line.text : [line.text];
    for (let j = 0; j < texts.length; j++) {
      if (typeof texts[j] === 'string') out.push({ speaker: speaker, text: texts[j], effect: line.effect || null });
    }
  }
  return out;
}

// Drives beat playback: advance when the current beat's display timer drains.
// A speaker-change breather (CONFIG.speech.speakerGapMs) is inserted as a
// silent window *after* a beat ends naturally — never on skip (skipDialogueLine
// zeroes it) and never when the next beat keeps the same speaker. Modelling the
// gap before the advance keeps beatIdx incremented exactly once.
function tickDialogue(dt) {
  if (!dialogue || dialogue.phase !== 'playing') return;
  if (dialogue.gapMs > 0) {
    dialogue.gapMs -= dt * 1000;
    if (dialogue.gapMs <= 0) { dialogue.gapMs = 0; advanceBeat(); }
    return;
  }
  if (getActiveSpeech()) return; // current beat still showing
  const gap = speakerChangeGap();
  if (gap > 0) { clearSpeech(); dialogue.gapMs = gap; return; } // drop the bubble; hold silence
  advanceBeat();
}

// Breather before the next beat: CONFIG.speech.speakerGapMs when the next
// queued beat switches speaker, else 0 (same speaker, or no next beat — the
// queue-end handoff to the topic list owns its own pacing).
function speakerChangeGap() {
  const cur = dialogue.queue[dialogue.beatIdx];
  const next = dialogue.queue[dialogue.beatIdx + 1];
  if (!cur || !next || next.speaker === cur.speaker) return 0;
  return CONFIG.speech.speakerGapMs || 0;
}

// ══ Tick ═════════════════════════════════

/**
 * Tick hook — advances the overlay timeline, dialogue beat playback, and
 * ambient bark timers.
 */
export function tickNarrative(dt) {
  tickOverlay(dt);
  tickDialogue(dt);
  tickBarks(dt);
}
