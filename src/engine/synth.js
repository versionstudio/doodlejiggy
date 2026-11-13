/**
 * @module synth
 * Embedded WebAudio synth (TinySynth) — the sole owner of the synth instance,
 * its AudioContext, and every TinySynth API call.
 *
 * Consumers (audio.js for game music, tooling for live MIDI) drive the synth
 * through the neutral verbs exported here and never touch TinySynth directly,
 * so its idiosyncrasies stay contained in this one module.
 *
 * The synth is built lazily — nothing (no AudioContext, no sequencer timer)
 * exists until the first call. Construction creates a *suspended* AudioContext;
 * unlock() resumes it from a user gesture.
 */

import WebAudioTinySynth from 'webaudio-tinysynth';
import CONFIG from './config.js';

let synth = null;
let fadeStopTimer = 0; // deferred stopMIDI after a fade-out; cancelled if playback restarts

function instance() {
  if (!synth) {
    synth = new WebAudioTinySynth();
    synth.setMasterVol(CONFIG.audio.musicVolume);
  }
  return synth;
}

/** Resumes the AudioContext (building the synth on first call). Idempotent; call from a user gesture. */
export function unlock() {
  const s = instance();
  if (s.actx.state !== 'running') s.actx.resume();
}

/**
 * @returns {Promise} Resolves once the AudioContext is running, so callers can defer
 * audible work until the gesture-driven unlock has actually taken effect.
 *
 * Pure observer: it never triggers the unlock and never rejects. Until a gesture calls
 * unlock() the context stays suspended and this stays pending indefinitely — representing
 * "audio not yet available," not an error; a wait started beforehand resolves when the
 * unlock lands.
 */
export function whenRunning() {
  const s = instance();
  if (s.actx.state === 'running') return Promise.resolve();
  return new Promise(function (resolve) {
    s.actx.addEventListener('statechange', function onChange() {
      if (s.actx.state !== 'running') return;
      s.actx.removeEventListener('statechange', onChange);
      resolve();
    });
  });
}

/** @returns {boolean} Whether a track is currently sounding. */
export function isPlaying() {
  return !!synth && synth.getPlayStatus().play === 1;
}

/**
 * Loads and plays a MIDI file from raw bytes, replacing whatever was playing.
 *
 * @param {ArrayBuffer} buf
 * @param {object} [opts]
 * @param {boolean} [opts.loop=true] Loop indefinitely; false plays once then stops.
 * @param {number} [opts.fadeInMs] Fade-in ramp in milliseconds; omit for an instant start.
 */
export function playBuffer(buf, opts) {
  opts = opts || {};
  const s = instance();
  cancelFadeStop();
  s.stopMIDI(); // silence hanging notes from the outgoing track before the swap
  s.loadMIDI(buf);
  s.setLoop(opts.loop === false ? 0 : 1);
  applyFadeIn(opts.fadeInMs);
  s.playMIDI();
}

/**
 * Stops the current track. No-op when nothing is playing.
 *
 * @param {object} [opts]
 * @param {number} [opts.fadeOutMs] Fade-out ramp in milliseconds; omit for an instant stop.
 */
export function stop(opts) {
  opts = opts || {};
  if (!synth || !isPlaying()) return;
  const ms = opts.fadeOutMs;
  if (ms > 0) {
    const g = synth.out.gain, t = synth.actx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0, t + ms / 1000);
    cancelFadeStop();
    // The sequencer keeps running through the ramp; silence it once faded.
    fadeStopTimer = setTimeout(function () { synth.stopMIDI(); fadeStopTimer = 0; }, ms);
  } else {
    synth.stopMIDI();
  }
}

/** Forwards a raw MIDI message (status + data bytes) straight to the synth. */
export function sendMidi(bytes) {
  instance().send(bytes);
}

/** Sends a GM Program Change on `channel` (1-based, 1–16). */
export function sendProgramChange(channel, program) {
  instance().send([0xC0 | ((channel - 1) & 0x0f), program & 0x7f]);
}

/** Immediately silences every channel (panic). */
export function panic() {
  const s = instance();
  for (let ch = 0; ch < 16; ch++) s.send([0xB0 | ch, 123, 0]); // CC 123 = all notes off
}

// Ramps the master gain up to full over `ms`, or snaps to it when no fade is
// asked for. Set before playMIDI so the first scheduled notes carry the right
// level.
function applyFadeIn(ms) {
  const g = synth.out.gain, t = synth.actx.currentTime;
  g.cancelScheduledValues(t);
  if (ms > 0) {
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(CONFIG.audio.musicVolume, t + ms / 1000);
  } else {
    g.setValueAtTime(CONFIG.audio.musicVolume, t);
  }
}

function cancelFadeStop() {
  if (fadeStopTimer) { clearTimeout(fadeStopTimer); fadeStopTimer = 0; }
}

/** @returns {Array<{program: number, name: string}>} All GM melodic programs in order. */
export function listPrograms() {
  const programCount = 128; // GM melodic programs (0–127); drums live on channel 10, not here
  const s = instance();
  const out = [];
  for (let p = 0; p < programCount; p++) out.push({ program: p, name: s.getTimbreName(0, p) });
  return out;
}
