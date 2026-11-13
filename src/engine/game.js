/**
 * @module game
 * Runtime entry and system wiring.
 *
 * Coordinates engine bootstrapping, the frame loop, input routing, and
 * communication between rendering, scene management, scripting, and
 * persistence systems.
 *
 * The runtime composition root, not a home for reusable engine subsystems.
 * The policy it does own is the policy no single subsystem can: the input
 * lock, hover classification, verb-line phrasing, and the inventory item
 * list it pushes into ui.js.
 */

import CONFIG from './config.js';
import { actors, objects, player,
         initScene, setCurrentScene, loadScene, enterScene, spawnActor, changeScene, showSpeech,
         startSceneScript, tickActors, tickObjects, tickSpeech,
         clearSpeech, clearSpeechIfOwnedBy, isSpeechShown, getActiveSpeech, onSceneHide, snapSceneVisible,
         isRevealPending, markSceneRevealed, revealSceneFadeIn,
         walkActorTo, setFollow, clearFollow, setAnimOverride, faceActor,
         interactableAtNativePoint, entitiesInDrawOrder, portalExitAtNativePoint,
         applyObjectState, applyActorState, animationWaitCondition, resolveObjectField, resolveObjectIconFrame, currentObjectState, currentActorState, onObjectChange, onSceneLoad, onSceneEnter, onActorDespawn,
         spawnObjectAt, giveObject, removeObject, teleportEntity,
         removeActor, isPlayerInPortalWalk, isSceneTransitioning, getPortalExits, exitExists } from './scene.js';
import { initWorld, worldRect, occluderPolygons, entityScale, currentWorldColor } from './world.js';
import { initCamera, tickCamera, refreshCamera,
         setCameraTarget, moveCamera, enterSceneCamera, releaseCameraTarget } from './camera.js';
import { actorRegistry } from './actors.js';
import { objectRegistry } from './objects.js';
import { initCanvas, resizeCanvas,
         renderActor, renderObject, renderSpeech,
         isEntityAnchorVisible, renderScanMarker,
         applyTheme as applyRenderTheme, setScanMarker, setWorldColor,
         renderOverlay, clearFrame, withWorldClip, spriteIcon } from './render.js';
import { getSprite, ASSET_TYPES } from './sprites.js';
import { setOverlay, dismissOverlay, clearOverlay, tickNarrative,
         applyAmbientBarks, isOverlayActive, getActiveOverlay,
         startActorDialogue, stopDialogue, isDialogueModeActive,
         getVisibleTopics, selectDialogueTopic, skipDialogueLine } from './narrative.js';
import { screenToNative } from './geometry.js';
import { initScript, tickScript, stopScript, isCutsceneRunning, isCutscenePending,
         skipCurrentSpeech, isAwaitingInput } from './script.js';
import { unlockAudio, playMusic, stopMusic } from './audio.js';
import { loadProgress, clearProgress, getInventory, setPlayerActor } from './state.js';
import { loadRegistries, loadGameDefinition } from './registries.js';
import { initInteractions,
         interactWithEntity, interactWithExit,
         useObjectOnTarget, lookAtInventory,
         tickInteractions, cancelPendingInteractions } from './interaction.js';
import { initUI, setInventoryItems, setInventoryVisible, setInventoryActive,
         setTopics, setVerbLine, applyTheme as applyUiTheme,
         setCursor, setCursorScale, setHoverCursor,
         cancelInventoryDrag, refreshInventoryHover } from './ui.js';
import { initInput, isScanning } from './input.js';

// The scene layer. It holds the world layer and the world canvas, and fades the
// two as one group on scene transitions.
const gameElement = document.getElementById('app');

// Scene transitions fade `#app` as a group (backdrop + world canvas
// composite), so the scene starts hidden here rather than via a CSS rule —
// keeps the design tool, which shares `#app` but not this boot path, unaffected.
gameElement.style.opacity = '0';

let gameConfig = null;
let themeFontsPromise = null; // theme-font load; set in startGame, awaited in init's barrier

// ══ Debug seam ═══════════════════════════

// Where the debug tooling hangs its per-frame draw, without an engine → tools
// dependency. Named for its one consumer rather than dressed up as a general
// render event: the tools own their layer (render.js) and read engine state
// directly, so all this seam carries is the frame clock. The one `on*` seam
// the tools register rather than game.js — the dependency runs tools → engine.
let debugDrawHandler = null;

export function onDebugDraw(fn) {
  debugDrawHandler = fn;
}

// ══ Loop ═════════════════════════════════

const FRAME_INTERVAL = 1000 / CONFIG.targetFps;

// Accept a frame a hair before the interval fully elapses: when targetFps matches
// the refresh rate, rAF jitter dipping one interval below F would otherwise drop an
// on-time frame and double the next, beating the rate down. Absorbing that jitter is
// the tolerance's only job — dt is the measured elapsed regardless, so it never
// affects speed, only which frames tick. Jitter is an absolute-time quantity, so the
// tolerance is a fixed span, not a fraction of F: large enough to absorb scheduler
// jitter, small enough not to accept a frame a refresh early.
const FRAME_TOLERANCE = 2;
let lastTimestamp = 0;

function loop(timestamp) {
  const elapsed = timestamp - lastTimestamp;
  if (elapsed >= FRAME_INTERVAL - FRAME_TOLERANCE) {
    const dt = Math.min(elapsed, FRAME_INTERVAL * 3) / 1000;
    lastTimestamp = timestamp;

    tickActors(dt);
    tickObjects(dt);
    tickScript(dt);
    tickSpeech(dt);
    tickInteractions(dt);
    tickNarrative(dt);
    tickCamera(dt);

    // enterScene defers the scene reveal so the first post-enter frame can pick
    // the right path: snap under the veil when an overlay-first sceneEnter
    // registered a veiled overlay this frame (no flash before the cinematic),
    // else CSS fade-in. An unveiled overlay doesn't mask, so it fades in.
    if (isRevealPending()) {
      const overlay = getActiveOverlay();
      if (!overlay || !overlay.background) {
        revealSceneFadeIn();
      } else if (overlay.veilAlpha >= 1) {
        snapSceneVisible();
        markSceneRevealed();
      }
    }

    // Sync UI — DOM that mirrors game state; resolution-independent, so it stays
    // in the loop rather than the resize-shared render path.
    updateInventoryActive();
    setTopics(isDialogueModeActive() ? getVisibleTopics() : []);

    renderWorld();
    // Debug overlays paint after the pure render, kept out of renderWorld() because
    // this is the one place that knows the frame delta. The resize path repaints them
    // too, passing 0, so they don't flicker while the stats they feed advance only here.
    debugDrawHandler?.(dt);
  }
  requestAnimationFrame(loop);
}

/**
 * Renders the current world to the canvas: entities in draw order, scan markers,
 * active speech, and the overlay.
 *
 * Pure render — reads state and paints only; it must never mutate engine state
 * or advance time. That contract is what lets `loop()` and `onResize()` both
 * call it and get identical pixels, so the resize path is just another render of
 * unchanged state. Anything with side effects — state ticks, UI sync, the debug
 * seam — stays in `loop()`. Keep it that way.
 */
function renderWorld() {
  clearFrame();

  // Entities and scan markers live in world space, so they clip like the
  // backdrop. Speech is chrome above it and clamps itself instead.
  withWorldClip(function () {
    // Shared back-to-front order (scene.js): drawing in list order paints the
    // topmost entity last. The same list backs interaction picking, so what
    // draws on top is what a click or hover resolves to.
    const drawList = entitiesInDrawOrder();
    for (let i = 0; i < drawList.length; i++) {
      const item = drawList[i];
      if (item.visible === false) continue;
      // Single scale authority: objects and `scaling:'fixed'` actors resolve to 1,
      // scene-scaled actors to the depth factor at their y.
      const scale = entityScale(item);
      if (item.kind === 'object') renderObject(item, occluderPolygons, scale);
      else renderActor(item, occluderPolygons, scale);
    }

    renderScanMarkers();
  });

  const speech = getActiveSpeech();
  if (speech) {
    // Bubble anchors to the sprite as drawn, so it uses the speaker's resolved
    // scale (see the draw loop). Scripted/dialogue-mode speech clamps to stay
    // readable; engine-initiated barks (no owner) anchor in the world.
    const scale = entityScale(speech.speaker);
    renderSpeech(speech, scale, speech.ownerScript !== null);
  }

  // The overlay is its own canvas layered above the world (z-index), so it
  // covers world, speech, and debug overlays regardless of draw order.
  renderOverlay(getActiveOverlay());
}

function renderScanMarkers() {
  if (!isScanning() || isInteractionLocked() || isCutscenePending()) return;

  const objList = Object.values(objects);
  for (let i = 0; i < objList.length; i++) {
    const obj = objList[i];
    if (obj.visible === false || obj.interaction === 'none') continue;
    if (!isEntityAnchorVisible(obj)) continue;
    renderScanMarker(obj, entityScale(obj));
  }

  // Actors (excluding the player) — same scan affordance as objects so the
  // player can spot NPCs. Player is the input subject, not a target; exclude.
  const actorList = Object.values(actors);
  for (let i = 0; i < actorList.length; i++) {
    const actor = actorList[i];
    if (actor === player || actor.visible === false || actor.interaction === 'none') continue;
    if (!isEntityAnchorVisible(actor)) continue;
    renderScanMarker(actor, entityScale(actor));
  }

  // Portal exits — marker drawn at the polygon's bounding-box centre via
  // renderScanMarker's hotspot branch. Surfaces invisible navigation
  // primitives so the player isn't hunting for them.
  const exits = getPortalExits();
  const exitNames = Object.keys(exits);
  for (let i = 0; i < exitNames.length; i++) {
    const exit = exits[exitNames[i]];
    if (!exitExists(exit)) continue;
    const marker = { hotspot: exit.hotspot, x: 0, y: 0, w: 0, h: 0 };
    if (!isEntityAnchorVisible(marker)) continue;
    renderScanMarker(marker, 1);
  }
}

// ══ Interaction & hover ══════════════════

// True while the engine is mid-beat and incoming user input should be
// deferred: a script-owned line is on screen, dialogue mode is open, a
// cutscene is running, the player is in a portal walk-in / walk-off, or a
// scene transition is in flight (keeps the inventory veiled across the
// fade-out + load gap, where no player actor exists to hold a walk lock).
// Single extension point for input locking; also consulted by the script
// tick to decide when a pending cutscene may transition to running.
//
// Presentation additionally treats pending cutscenes as non-interactive.
// Once a cutscene is pending it is already committed and will promote on
// the next script tick, so interaction affordances suppress immediately
// rather than flashing for one frame. The scheduler deliberately ignores
// pending cutscenes here — folding them into the lock would deadlock the
// promotion gate.
function isInteractionLocked() {
  return isSpeechShown() || isDialogueModeActive() || isCutsceneRunning() || isPlayerInPortalWalk() || isSceneTransitioning();
}

// The waitForInput gate. A deliberate input (key press, click, tap — the same
// class that fires the first-gesture audio unlock) satisfies every script
// blocked on `waitForInput` at once, and is consumed by the gate: it never also
// walks the player or triggers an interaction. input.js runs the gate check
// before emitting the specific intent, so it precedes the cutscene click-block —
// the engine-defined exception that keeps a "Press anything." ending from
// soft-locking on touch.
let inputGateGeneration = 0;

// `waitForInput` effect handler — the returned predicate resolves on the next
// deliberate input after arming.
function armInputGate() {
  const gen = inputGateGeneration;
  return function () { return inputGateGeneration > gen; };
}

// input.js `onDeliberateInput` intent — returns whether the gate consumed it.
function satisfyInputGate() {
  if (!isAwaitingInput()) return false;
  inputGateGeneration++;
  return true;
}

function handleClick(sx, sy) {
  if (!player || !player.visible) return;
  // Dialogue mode owns clicks: skip the current line during playback; ignore
  // canvas clicks while the topic list is up (the DOM rows handle selection).
  // An empty `controls.skip` disables this tap route along with the key, so a
  // click during speech is swallowed here rather than walking the player.
  const canSkip = !!CONFIG.controls.skip;
  if (isDialogueModeActive()) {
    if (canSkip) skipDialogueLine();
    return;
  }
  if (isSpeechShown()) {
    if (canSkip && skipCurrentSpeech()) clearSpeech();
    return;
  }
  if (isCutsceneRunning()) return;
  // Block input during portal walks. The engine has committed to a scripted
  // traversal; letting the player click mid-transition would cancel the
  // camera-freeze and either leave the walk-off pending (no transition
  // fires) or interrupt the walk-in.
  if (isPlayerInPortalWalk()) return;

  // Any new click cancels in-flight walk-then-interact.
  cancelPendingInteractions();

  const rect = worldRect();
  const native = screenToNative(sx, sy, rect, CONFIG.world.height);

  // Portal exits hit-test first: they render on top of everything in tooling
  // overlays and are the highest-priority interaction in-world (a doorway
  // beats a sprite that happens to overlap it).
  const exit = portalExitAtNativePoint(native.x, native.y);
  if (exit) { interactWithExit(exit); return; }
  const hit = interactableAtNativePoint(native.x, native.y);
  if (hit) { interactWithEntity(hit); return; }
  walkActorTo(player.name, native.x, native.y);
}

// What the pointer is over, and where it is. `hoveredEntity` is the entity under
// the desktop cursor — object, actor, or portal exit — or null. `lastMouseScreen`
// is that cursor's screen position, or null when off-canvas; it is tracked so
// hover can be re-evaluated on demand (e.g. when the engine finishes responding
// and the cursor sat still through the response).
let hoveredEntity = null;
let lastMouseScreen = null;

function updateHoverFromScreen(sx, sy) {
  lastMouseScreen = { x: sx, y: sy };
  if (!player || !player.visible) {
    setHovered(null);
    return;
  }

  const rect = worldRect();
  const native = screenToNative(sx, sy, rect, CONFIG.world.height);

  // Hover priority matches click priority: portal exits beat the topmost
  // interactable under the point. Exits return a synthetic { title } shape so
  // the existing verb-line read in setHovered works unchanged.
  const hover = portalExitAtNativePoint(native.x, native.y)
             || interactableAtNativePoint(native.x, native.y);
  setHovered(hover);
}

function setHovered(entity) {
  if (hoveredEntity === entity) return;
  // While the engine is responding, suppress hover updates. The verb line is a
  // prospective affordance — it should not flicker on top of a say or compete
  // with engaged interaction. A *pending* cutscene counts as responding here,
  // per the presentation rule on isInteractionLocked.
  if (isInteractionLocked() || isCutscenePending()) return;
  hoveredEntity = entity;
  // Every hoverable target — object, actor, or exit — reads the same: the
  // interact cursor signals "you can act here" and the verb line carries the
  // specifics (e.g. "Walk to Hallway" vs "Open door"). ui.js owns the glyph.
  setHoverCursor(entity !== null);
  setVerbLine(textForHover(entity));
}

// Hit-test the scene for whatever's under the pointer during a drag.
// Returns { name, title, kind } or null. `kind` is 'object' or 'actor';
// fed straight into useObjectOnTarget for trigger + fallback routing.
//
// Portal exits and entries are excluded, so a drop on one resolves as
// "drop on nothing" (silent cancel).
function findDropTarget(sx, sy) {
  const rect = worldRect();
  if (sx < rect.left || sx > rect.right || sy < rect.top || sy > rect.bottom) return null;

  const native = screenToNative(sx, sy, rect, CONFIG.world.height);
  const hit = interactableAtNativePoint(native.x, native.y);
  if (hit) return { name: hit.name, title: hit.title || hit.name, kind: hit.kind };

  return null;
}

// ══ Verb line ════════════════════════════
//
// game.js owns the player-facing interaction text; ui.js only displays it. Both
// generators feed setVerbLine — textForHover via scene hover, textForUse via the
// dragVerbLineFor callback. Phrasing comes from `messages.templates` in
// data/game.json merged per key over the engine defaults below, so every
// engine path is covered even with no authored `messages` block.

// Engine-default verb-line templates: one plain variant per category.
// Deliberately minimal — flavor is what authoring is for.
const ENGINE_TEMPLATES = Object.freeze({
  look:               '{target}',
  pickup:             'Pick up {target}',
  use:                'Use {target}',
  talk:               'Talk to {target}',
  useObjectOn:        'Use {object} on {target}',
  useObjectOnPending: 'Use {object} on ...',
  portalExit:         'Walk to {target}',
});

// Resolves the hover text for the scene entity under the cursor. Each affordance
// reads as an action via a `templates` format string keyed by verb: portal exits
// use `templates.portalExit`, objects and actors use the template named by their
// current interaction verb (look / pickup / use / talk). The verb is read from
// the live instance's resolved `interaction`, so a state change that swaps it
// updates the line. The `{target}` placeholder is the entity's title. Missing
// template → bare title; `look` is conventionally `"{target}"`, so the default
// verb reads as the bare title.
function textForHover(entity) {
  if (!entity || !entity.title) return null;
  const key = entity.kind === 'portalExit' ? 'portalExit' : (entity.interaction || 'look');
  return gameConfig.templates[key].replace(/\{target\}/g, entity.title);
}

// Resolves the text for using/dragging an inventory item: `templates.useObjectOn`
// when a target is under the pointer, `templates.useObjectOnPending` when it isn't.
function textForUse(objectTitle, targetTitle) {
  const template = gameConfig.templates[targetTitle ? 'useObjectOn' : 'useObjectOnPending'];
  return template
    .replace(/\{object\}/g, objectTitle || '')
    .replace(/\{target\}/g, targetTitle || '');
}

// ══ Inventory orchestration ══════════════
//
// game.js builds the item list (state ownership + scene field/icon resolution)
// and the visibility gate, then pushes both into ui.js. An overlay and dialogue
// mode fully hide the strip; an active/blocked beat dims it.

function buildInventoryItems() {
  const names = getInventory();
  const items = [];
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (!objectRegistry[name]) continue;
    // Resolve the item's current icon frame to a display canvas. spriteIcon
    // returns null on an undecoded sheet, but refreshInventory runs from the
    // onSceneLoad hook after the scene preload decodes every inventory sprite,
    // so that null is a guard rather than an expected state.
    const frame = resolveObjectIconFrame(name);
    const iconEl = frame ? spriteIcon(getSprite(frame.type, frame.name), frame.cols, frame.rows, frame.row, frame.startFrame) : null;
    items.push({ name: name, title: resolveObjectField(name, 'title') || name, iconEl: iconEl });
  }
  return items;
}

// Refresh strip contents AND visibility together — both derive from the same
// item list, so coupling them rules out a "visible but empty" strip.
function refreshInventory() {
  const items = buildInventoryItems();
  setInventoryItems(items);
  setInventoryVisible(items.length > 0 && !isOverlayActive() && !isDialogueModeActive());
}

// Previous values of the three states below, so each transition is acted on once.
let wasInactive = false;
let wasOverlayActive = false;
let wasDialogueMode = false;

// Push strip visibility/active state, and bridge the lock transition for hover:
// on lock, drop the hovered object + cursor; on unlock, re-evaluate what's under
// the cursor *now* (mousemove doesn't re-fire while the cursor sits still through
// the engine response) — inventory item first (coordinate-resolved, since
// `:hover` is stale at reactivation), else scene hover. ui.js owns the
// inventory-side cleanup on lock (cancelling the drag, clearing the line).
function updateInventoryActive() {
  const overlayActive = isOverlayActive();
  if (overlayActive !== wasOverlayActive) {
    refreshInventory();
    wasOverlayActive = overlayActive;
  }

  const inDialogue = isDialogueModeActive();
  if (inDialogue !== wasDialogueMode) {
    refreshInventory();
    wasDialogueMode = inDialogue;
  }

  const inactive = isInteractionLocked() || isCutscenePending();
  setInventoryActive(!inactive);
  if (inactive) {
    if (!wasInactive) {
      hoveredEntity = null;
      setHoverCursor(false);
    }
  } else if (wasInactive && lastMouseScreen) {
    if (!refreshInventoryHover(lastMouseScreen.x, lastMouseScreen.y)) {
      updateHoverFromScreen(lastMouseScreen.x, lastMouseScreen.y);
    }
  }
  wasInactive = inactive;
}

// ══ Window events ════════════════════════

// Inventory drag is a UI gesture owned by ui.js; cancel it when the window
// loses focus or is hidden so a drag can't be left dangling. (Scan-key release
// on blur is owned by input.js.)
window.addEventListener('blur', cancelInventoryDrag);
document.addEventListener('visibilitychange', function () {
  if (document.hidden) cancelInventoryDrag();
});

// World scale factor: displayed world height over native world height. The
// cursor artwork is authored in world pixels, so it tracks the same factor the
// renderer applies to the room.
function refreshCursorScale() {
  setCursorScale(worldRect().height / CONFIG.world.height);
}

function onResize() {
  document.documentElement.style.setProperty('--vh', window.innerHeight * 0.01 + 'px');
  resizeCanvas();
  refreshCamera();
  refreshCursorScale();
  // resizeCanvas() clears the canvas; repaint in the same event so a drag-resize
  // never composites a blank frame between the clear and the loop's next tick.
  renderWorld();
  // Repaint debug overlays too, else they blink out on every resize frame and
  // reappear on the next tick. A resize is not a frame: no simulation time passed
  // between this repaint and the last one, hence dt 0 — the diagnostics redraw at
  // the new size while the stats they feed (FPS, actor speeds) hold their values.
  debugDrawHandler?.(0);
}

window.addEventListener('resize', onResize);

window.addEventListener('orientationchange', function () {
  const settleMs = 500; // delay before re-measuring layout (iOS needs settling time after orientationchange)
  setTimeout(onResize, settleMs);
});

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', onResize);
  window.visualViewport.addEventListener('scroll', resizeCanvas);
}

// ══ Boot ═════════════════════════════════

/**
 * The single engine restart path: stops every running script (so no script
 * side effect can re-dirty the save between the wipe and the reload), wipes
 * saved progression, and reboots the page — which resets all in-memory state
 * and re-enters `game.json.start` fresh (loadProgress finds no save). Two
 * entry points, one path: the `restartGame` script action and the debug
 * toolbar's "Start over".
 */
export function restart() {
  stopScript();
  clearProgress();
  location.reload();
}

function init() {
  document.documentElement.style.setProperty('--vh', window.innerHeight * 0.01 + 'px');
  document.documentElement.style.setProperty('--dj-scene-fade', CONFIG.scene.fadeMs + 'ms');

  initWorld(gameElement);
  initCanvas(gameElement);
  initCamera(gameElement);
  refreshCursorScale();

  // Clear per-scene hover state when the scene hides so a stale hovered object
  // (from the previous scene's `objects` map) doesn't draw. Pending walk-then-
  // interact state is cleared here too so a mid-walk scene transition cannot
  // leak completion functions whose closures point at the previous scene.
  onSceneHide(function () {
    setHovered(null);
    cancelPendingInteractions();
    // Active dialogue is scene-local transient; force-close on transition.
    stopDialogue();
    // The overlay is chrome over a world that is going away; it never
    // survives a scene transition, whoever owns it.
    clearOverlay();
  });

  // Camera reactions to scene lifecycle: a scene enter reframes and refollows
  // the player, and a despawned actor stops being a follow subject.
  onSceneEnter(enterSceneCamera);
  onActorDespawn(releaseCameraTarget);

  initInteractions({ messages: gameConfig.messages, talk: startActorDialogue });

  // ui.js is display + gesture only: it emits intents and asks for verb text,
  // game.js owns the interaction semantics behind each.
  initUI({
    onInventoryTap:  lookAtInventory,
    onInventoryDrop: function (name, sx, sy) {
      const target = findDropTarget(sx, sy);
      if (target) useObjectOnTarget(name, target); // a drop on nothing is a silent no-op
    },
    dragVerbLineFor: function (objectTitle, sx, sy) {
      const target = findDropTarget(sx, sy);
      return textForUse(objectTitle, target ? target.title : null);
    },
    onSelectTopic:   selectDialogueTopic,
  }, gameElement);

  // input.js emits device-neutral intents; game.js owns what each one means.
  // It stays ignorant of dialogue state, locks, hover, and coordinates.
  initInput(gameElement, {
    onFirstGesture: unlockAudio,
    onDeliberateInput: satisfyInputGate,
    onPoint:   updateHoverFromScreen,
    onConfirm: function (sx, sy) {
      // A pointer-less activation (touch tap) has no preceding hover, so resolve
      // the target at the activation point first — unless mid-beat, matching the
      // hover suppression in setHovered. Desktop clicks reach here with hover
      // already current, making the resolve idempotent.
      if (!isInteractionLocked()) updateHoverFromScreen(sx, sy);
      handleClick(sx, sy);
    },
    onPointerLeave: function () {
      lastMouseScreen = null;
      setHovered(null);
    },
    onSkip: function () {
      if (isDialogueModeActive()) { skipDialogueLine(); return; }
      if (isSpeechShown() && skipCurrentSpeech()) clearSpeech();
    },
    onSelectSlot: function (n) {
      if (!isDialogueModeActive()) return;
      const topics = getVisibleTopics();
      if (n - 1 < topics.length) selectDialogueTopic(topics[n - 1].id);
    },
  });

  initScript({
    say:                  showSpeech,
    spawnActor:           function (name, entryName, x, y, facing, state) {
      // Wraps the scene-layer spawn so the script can block on a portal walk-
      // in. Mirrors the `removeActor exit:` shape — portal-traversing actions
      // block, coord/no-walk spawns advance immediately. Walk-in arrival is
      // signalled by `arriveEntry` clearing in moveActor when the path empties.
      const actor = spawnActor(name, entryName, x, y, facing, state);
      if (!actor || !actor.arriveEntry) return null;
      return function () {
        const a = actors[name];
        if (!a) return true;
        return !a.arriveEntry;
      };
    },
    removeActor,
    changeScene,
    onScriptStop:         function (name) {
      // Single hook fans out to every visual subsystem that tracks script
      // ownership — keeps script.js unaware of which visuals exist.
      clearSpeechIfOwnedBy(name);
      clearOverlay(name);
    },
    isInteractionLocked:  isInteractionLocked,
    onCutsceneStart:      function () {
      // Pending → running transition for a cutscene. Cancels the player's
      // queued intent so the cutscene owns the actor cleanly. Portal walks
      // are sacrosanct — the defer-until-idle check waits them out before we
      // ever reach this hook, but the guard stays as a defensive belt-and-
      // braces.
      if (!player || isPlayerInPortalWalk()) return;
      player.path = [];
      player.followTarget = null;
      setAnimOverride(player.name, null);
      cancelPendingInteractions();
    },
    startScript:          startSceneScript,
    walkTo:               walkActorTo,
    follow:               setFollow,
    unfollow:             clearFollow,
    playAnimation:        setAnimOverride,
    stopAnimation:        function (name) { setAnimOverride(name, null); },
    cameraFollow:         setCameraTarget,
    moveCamera:           moveCamera,
    face:                 faceActor,
    playMusic:            playMusic,
    stopMusic:            stopMusic,
    setObjectState:       applyObjectState,
    setActorState:        applyActorState,
    waitForAnimation:     animationWaitCondition,
    spawnObject:          spawnObjectAt,
    removeObject:         removeObject,
    giveObject:           giveObject,
    teleport:             teleportEntity,
    getObjectState:       currentObjectState,
    getActorState:        currentActorState,
    talkTo:               function (actorName) {
      // Open the actor's resolved dialogue and hand the script a completion
      // predicate that resolves when the player exits — so a scripted `talkTo`
      // blocks until the conversation closes (script.js uses an Infinity
      // timeout). If the actor has no resolvable dialogue, dialogue mode never
      // opens and the predicate resolves immediately, so the script continues.
      startActorDialogue(actorName);
      return function () { return !isDialogueModeActive(); };
    },
    showOverlay:          setOverlay,
    dismiss:              dismissOverlay,
    waitForInput:         armInputGate,
    restartGame:          restart,
  });

  // Re-render the inventory strip on any object change. Catches owner moves
  // (give/take) that add/remove items, and state transitions that change
  // a visible item's icon. Also keeps the hovered scene object's verb-line
  // honest under a motionless cursor: clears it when that object is removed
  // (pickup, consumed), or when a state change swaps its title/verb. Clearing
  // rather than re-deriving avoids a one-frame flash of the new title: a `look`
  // transition applies synchronously before its description locks interaction,
  // so re-deriving here would paint the post-look title for a frame before the
  // lock hides the line. The unlock path (updateHoverFromScreen) re-derives the
  // correct line once the cursor is re-evaluated. Scoped to the changed object
  // via `name` — a different object's change can't affect this one's line.
  onObjectChange(function (name) {
    refreshInventory();
    if (!hoveredEntity || hoveredEntity.kind !== 'object' || name !== hoveredEntity.name) return;
    if (objects[name] !== hoveredEntity) {
      hoveredEntity = null;
      setHoverCursor(false);
    }
    setVerbLine(null);
  });

  // Rebuild the strip once a scene's sprites are decoded — the only point where
  // every inventory icon can slice a complete sheet. The authoritative first
  // render of the strip, so no premature build runs before the scene preload.
  //
  // Two authored values land here too, each installed in the module that
  // interprets it, and both before the reveal: the world's clear color, pulled
  // from world.js (which owns the authored name) and pushed into render.js
  // (which owns the palette); and the scene's ambient barks, which arrive as the
  // seam's payload because no module holds them between load and schedule.
  onSceneLoad(function (ambientBarks) {
    refreshInventory();
    setWorldColor(currentWorldColor());
    applyAmbientBarks(ambientBarks);
  });

  // registries.js loads + validates the authored data; it resolves when the
  // actor and object registries are ready. Theme fonts load in parallel and
  // join the same init barrier, so the first scene — and any overlay it shows —
  // never enters before every font family has settled. Launching the world
  // (preloading the start scene, entering it, plus UI) is startGame's job.
  Promise.all([loadRegistries(), themeFontsPromise]).then(function () {
    setPlayerActor(gameConfig.playerActor);
    if (!actorRegistry[gameConfig.playerActor]) {
      console.warn(`[game.json] player: unknown actor "${gameConfig.playerActor}" — not defined in actors.json, so the player cannot spawn.`);
    }
    loadScene(function () {
      enterScene(gameConfig.startEntry);
    });
  });
}

// The palette entries and font roles both presentation modules resolve names
// through. They are an engine-wide contract rather than either module's default:
// render.js and ui.js each rely on them, so neither can own them. `dialog` and
// `solid` are the roles the engine itself renders through.
const ENGINE_COLORS = Object.freeze({ white: '#ffffff', black: '#000000' });
const ENGINE_FONTS  = Object.freeze({ dialog: 'ScummDialog', solid: 'ScummSolid' });

// Builds the runtime theme: the authored block with its palette and font roles
// merged over the guaranteed entries, and every other section passed through for
// its owning module to merge. Frozen because re-theming goes back through
// applyTheme rather than mutating installed state — an in-place edit would reach
// the canvas on the next frame (names resolve at draw time) while leaving the
// interface's custom properties stale.
function buildTheme(authored) {
  return Object.freeze(Object.assign({}, authored, {
    colors: Object.freeze(Object.assign({}, ENGINE_COLORS, authored.colors)),
    fonts:  Object.freeze(Object.assign({}, ENGINE_FONTS, authored.fonts)),
  }));
}

// Loads the theme's font families and reports the ones the platform can't honor.
// Awaited in init's barrier so the first scene — and any overlay it shows —
// never enters before every family has settled. A family with no `base.css`
// @font-face registration is warned about: it's a misconfiguration with no
// graceful fallback (text renders monospace everywhere), unlike a font-role
// typo, which resolves to `dialog` at draw time and so is left unvalidated like
// every other theme reference. A missing face still settles rather than
// rejecting, so the barrier never hangs on it.
function loadThemeFonts(fonts) {
  return Promise.all(Object.keys(fonts).map(function (role) {
    const family = fonts[role];
    return document.fonts.load('16px ' + family).then(function () {
      if (!document.fonts.check('16px ' + family)) {
        console.warn(`[game.json] theme.fonts.${role}: family "${family}" has no @font-face registration (base.css) — text falls back to monospace.`);
      }
    });
  }));
}

// Installs the theme into the modules that present it. Each presentation module
// receives the whole runtime theme and takes the sections it draws, so the
// composition root hands over a theme rather than a list of surfaces.
// `interface` is the asset-valued section: resolved to Images here, so neither
// the renderer nor the UI looks an asset up itself.
function installTheme(theme) {
  const iface = theme.interface || {};

  applyRenderTheme(theme);
  applyUiTheme(theme);
  setScanMarker(iface.scanMarker ? getSprite(ASSET_TYPES.interface, iface.scanMarker) : null);

  // Each cursor state is what ui.js consumes: the asset's Image plus its hotspot
  // in authored cursor pixels, defaulting to the artwork's top-left corner. ui.js
  // rescales from those pixels, so the states install once decoded; until then
  // the scene keeps the browser's cursor.
  const cursor = iface.cursor
    ? { img: getSprite(ASSET_TYPES.interface, iface.cursor), hotspot: iface.cursorHotspot || [0, 0] }
    : null;
  const cursorHover = iface.cursorHover
    ? { img: getSprite(ASSET_TYPES.interface, iface.cursorHover), hotspot: iface.cursorHoverHotspot || [0, 0] }
    : null;

  const cursorSpecs = [cursor, cursorHover].filter(Boolean);
  Promise.all(cursorSpecs.map(function (spec) { return spec.img.ready; }))
    .then(function () { setCursor(cursor, cursorHover); });
}

// Top-level entry: turns parsed game.json into a running game — builds config,
// initializes systems (`init`), starts the loop, and kicks off the registry
// load graph (`loadRegistries`). The async load sequencing lives in registries.js.
function startGame(data) {
  const saved = loadProgress();
  const start = data.start || {};
  const theme = buildTheme(data.theme || {});
  const messages = data.messages || {};

  gameConfig = {
    startScene:  saved.scene  || start.scene,
    startEntry:  saved.entry  || start.entry,
    playerActor: data.player || 'player',
    templates:   Object.assign({}, ENGINE_TEMPLATES, messages.templates),
    messages:    messages,
  };

  if (data.start && data.scenes && !data.scenes.includes(data.start.scene)) {
    console.warn(`[game.json] start.scene "${data.start.scene}" is not listed in scenes — the start scene must be a member.`);
  }

  installTheme(theme);
  themeFontsPromise = loadThemeFonts(theme.fonts);

  initScene(gameElement);
  setCurrentScene(gameConfig.startScene);

  requestAnimationFrame(loop);
  init();
}

// An unreadable game.json still boots on empty config: the loader has already
// reported the failure.
loadGameDefinition().then(function (data) { startGame(data || {}); });
