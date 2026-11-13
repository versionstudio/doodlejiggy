/**
 * @module input
 * Device input layer: translates raw DOM pointer / touch / keyboard events into
 * semantic input intents, and owns scan-mode state.
 *
 * Knows about devices and the browser, never about the game — it emits intents
 * and exposes `isScanning()`, but reads no engine state. Its only engine-facing
 * import is `CONFIG.controls` (the keymap); `game.js` owns what each intent means.
 */

import CONFIG from './config.js';

const TOUCH_CLICK_DEBOUNCE_MS = 500; // ignore mouse events for this long after a touchend (avoids iOS ghost-click)
const TOUCH_MOVE_THRESHOLD_PX = 4; // finger jiggle tolerance before a touch counts as a drag instead of a tap
const LONG_PRESS_MS           = 400; // hold duration on the scene that activates scan (mirror of the Shift key)

// Intent handlers injected by game.js. input.js owns devices and browser
// events; game.js owns what each input intent means.
let onPoint = null;
let onConfirm = null;
let onPointerLeave = null;
let onSkip = null;
let onSelectSlot = null;
let onFirstGesture = null;
let onDeliberateInput = null;

// The deliberate-input class: clicks, taps, and key presses, but never passive
// pointer movement, hover, or held mode keys.
//
// onFirstGesture fires exactly once to satisfy the browser's audio-unlock
// policy. onDeliberateInput fires for every deliberate input and may consume
// the event (returning true), preventing its normal meaning (confirm, skip,
// etc.) from being emitted and routing it into a waiting input gate instead.
let firstGestureFired = false;
function notifyFirstGesture() {
  if (firstGestureFired) return;
  firstGestureFired = true;
  if (onFirstGesture) onFirstGesture();
}

// Keystrokes the browser or OS owns rather than the game: bare modifiers
// (mode holds like scan), modifier chords (Cmd/Ctrl+R reload, devtools, tab
// switching), and function keys (F5 refresh, F12 devtools). They never count
// as deliberate input — a reload chord at a `waitForInput` gate must reload
// the page, not satisfy the gate.
const MODIFIER_KEYS = { Shift: 1, Control: 1, Alt: 1, Meta: 1 };

function isBrowserKeystroke(e) {
  return MODIFIER_KEYS[e.key] === 1 || e.metaKey || e.ctrlKey || e.altKey || /^F\d+$/.test(e.key);
}

function notifyDeliberateInput() {
  return onDeliberateInput ? onDeliberateInput() : false;
}

// The live touch gesture. `lastTouchTime` is what the mouse handlers debounce
// against: a touch is followed by a synthetic mouse event pair, which without the
// window would replay the tap as a click. The start point and travel flag decide
// tap versus drag when the finger lifts.
let lastTouchTime = 0;
let touchStartX = 0, touchStartY = 0, didTouchMove = false;

// Scan mode: held while the scan key is down or a mobile long-press is active.
// Consumed by the render loop as a polled mode (`isScanning`), not as edge
// events. A single finger held on the scene for LONG_PRESS_MS flips it on;
// releasing turns it off and suppresses the tap that would otherwise fire on
// touchend. An empty `controls.scan` disables both bindings: the key
// comparisons stop matching on their own, the long-press is never armed.
let scanActive = false;
let longPressTimer = null;
let scanFromLongPress = false;

function clearLongPressTimer() {
  if (longPressTimer !== null) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
}

function endLongPressScan() {
  clearLongPressTimer();
  if (scanFromLongPress) {
    scanActive = false;
    scanFromLongPress = false;
  }
}

/** @returns {boolean} Whether scan mode is currently held (scan key or long-press). */
export function isScanning() {
  return scanActive;
}

// Captures the intent handlers and attaches every device listener. `gameEl` is
// the scene surface pointer events bind to; key/focus/wheel bind to
// document/window. Mirrors initUI (handler injection) + initCanvas (element
// capture). Recognized control keys are preventDefaulted unconditionally — the
// engine owns them and there are no focusable text fields to compete with.
export function initInput(gameEl, handlers) {
  onPoint = handlers.onPoint;
  onConfirm = handlers.onConfirm;
  onPointerLeave = handlers.onPointerLeave;
  onSkip = handlers.onSkip;
  onSelectSlot = handlers.onSelectSlot;
  onFirstGesture = handlers.onFirstGesture;
  onDeliberateInput = handlers.onDeliberateInput;

  // — Keyboard —

  document.addEventListener('keydown', function (e) {
    notifyFirstGesture();
    if (e.ctrlKey && (e.key === '+' || e.key === '-' || e.key === '=' || e.key === '_' || e.key === '0')) {
      e.preventDefault(); // swallow browser zoom shortcuts (web-only)
      return;
    }
    if (!isBrowserKeystroke(e) && notifyDeliberateInput()) { e.preventDefault(); return; }
    if (e.key >= '1' && e.key <= '9') { e.preventDefault(); onSelectSlot(parseInt(e.key, 10)); return; }
    if (e.key === CONFIG.controls.skip) { e.preventDefault(); onSkip(); return; }
    if (e.key === CONFIG.controls.scan) scanActive = true;
  });

  document.addEventListener('keyup', function (e) {
    if (e.key === CONFIG.controls.scan) scanActive = false;
  });

  // Focus loss releases held keys silently; scan mode must not stick on.
  window.addEventListener('blur', function () {
    scanActive = false;
    endLongPressScan();
  });

  window.addEventListener('wheel', function (e) {
    if (e.ctrlKey) e.preventDefault(); // block ctrl-wheel page zoom over the game
  }, { passive: false });

  // — Mouse / touch —

  gameEl.addEventListener('mousemove', function (e) {
    if (Date.now() - lastTouchTime < TOUCH_CLICK_DEBOUNCE_MS) return;
    onPoint(e.clientX, e.clientY);
  });

  gameEl.addEventListener('mouseleave', function () {
    onPointerLeave();
  });

  gameEl.addEventListener('click', function (e) {
    notifyFirstGesture();
    if (Date.now() - lastTouchTime < TOUCH_CLICK_DEBOUNCE_MS) return;
    if (notifyDeliberateInput()) return;
    onConfirm(e.clientX, e.clientY);
  });

  gameEl.addEventListener('touchstart', function (e) {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    didTouchMove = false;

    // A touch has no persistent pointer: invalidate any cached pointer position
    // so a post-unlock re-hover can't fire at a stale spot the finger has left.
    onPointerLeave();

    clearLongPressTimer(); // defensive: drop any stale timer from an interrupted prior touch
    if (CONFIG.controls.scan) {
      longPressTimer = setTimeout(function () {
        longPressTimer = null;
        scanActive = true;
        scanFromLongPress = true;
      }, LONG_PRESS_MS);
    }
  }, { passive: true });

  gameEl.addEventListener('touchmove', function (e) {
    if (e.touches.length > 1) { e.preventDefault(); return; }
    const dx = Math.abs(e.touches[0].clientX - touchStartX);
    const dy = Math.abs(e.touches[0].clientY - touchStartY);
    if (dx > TOUCH_MOVE_THRESHOLD_PX || dy > TOUCH_MOVE_THRESHOLD_PX) {
      didTouchMove = true;
      // Movement before long-press fires cancels it (player is panning/walking).
      // Once scan is on, finger movement is allowed and doesn't abort it.
      if (!scanFromLongPress) clearLongPressTimer();
    }
  }, { passive: false });

  gameEl.addEventListener('touchend', function (e) {
    // Mobile browsers grant transient user activation on touchend, not touchstart
    // (nor pointerdown), so the audio unlock must happen here — resuming the
    // AudioContext from touchstart is rejected and the synth warns on every primed note.
    notifyFirstGesture();
    lastTouchTime = Date.now();
    const wasScanGesture = scanFromLongPress;
    endLongPressScan();

    if (wasScanGesture) return; // long-press scan was the whole interaction — no tap follow-through
    if (!didTouchMove && e.changedTouches.length > 0) {
      if (notifyDeliberateInput()) return;
      onConfirm(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
    }
  }, { passive: true });

  gameEl.addEventListener('touchcancel', function () {
    endLongPressScan();
  }, { passive: true });
}
