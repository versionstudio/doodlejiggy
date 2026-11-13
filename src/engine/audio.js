/**
 * @module audio
 * Game music policy over synth.js: named-track playback, asset resolution,
 * caching, idempotency, and audio-unlock queueing.
 *
 * Holds no TinySynth knowledge — all synth contact goes through synth.js. The
 * engine drives music only through this module; scripts reach it through the
 * playMusic/stopMusic effect handlers wired in game.js.
 *
 * Authored .mid files are addressed by bare name (an engine identity, like a
 * scene): this module appends ".mid" and resolves it under config.paths.music.
 */

import CONFIG from './config.js';
import { unlock, whenRunning, playBuffer, stop, isPlaying } from './synth.js';

let unlocked = false;
let current = null; // bare name of the intended track, or null when stopped
let pending = null; // { name, opts } requested before unlock; started on unlock
let playToken = 0; // bumps per request so a stale fetch can't start over a newer one

/**
 * Resumes audio from within a genuine user gesture (pointerdown / touchstart /
 * click), satisfying browser autoplay policy. Idempotent.
 *
 * Starts any track that was requested while audio was still locked. Mouse
 * movement is not a qualifying gesture — call only from a real tap/click/key.
 */
export function unlockAudio() {
  unlock();
  unlocked = true;
  if (pending) {
    const p = pending;
    pending = null;
    startTrack(p.name, p.opts);
  }
}

/**
 * Plays the MIDI track named `name` (no extension), lazy-loading and caching
 * it on first use. Idempotent: re-requesting the track already playing is a
 * no-op, so repeated scene/script triggers never restart it. One track plays
 * at a time — any other track is replaced immediately, with no crossfade.
 *
 * While audio is locked the request is remembered and started by unlockAudio.
 * A missing file warns and no-ops.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.loop=true] Loop indefinitely; false plays once then stops.
 * @param {number} [opts.fadeInMs] Fade-in ramp in milliseconds; omit for an instant start.
 */
export function playMusic(name, opts) {
  opts = opts || {};
  if (name === current && isPlaying()) return;
  if (!unlocked) { current = name; pending = { name, opts }; return; }
  startTrack(name, opts);
}

/**
 * Stops the current track. No-op when nothing is playing.
 *
 * @param {object} [opts]
 * @param {number} [opts.fadeOutMs] Fade-out ramp in milliseconds; omit for an instant stop.
 */
export function stopMusic(opts) {
  current = null;
  pending = null; // cancel a track queued before unlock, so it can't start on the first gesture
  stop(opts);
}

function startTrack(name, opts) {
  current = name;
  const token = ++playToken;
  // Wait for the context to actually be running so the synth never sends notes on a
  // suspended context (outside the gesture) — fetch the file in parallel meanwhile.
  Promise.all([whenRunning(), fetchMidi(name)]).then(function (results) {
    const buf = results[1];
    if (token !== playToken || !buf) return; // superseded by a newer request, or file missing
    playBuffer(buf, opts);
  });
}

const cache = new Map(); // name → fetched .mid ArrayBuffer (re-parsed by the synth on each switch)

async function fetchMidi(name) {
  if (cache.has(name)) return cache.get(name);
  try {
    const res = await fetch(CONFIG.paths.music + name + '.mid');
    if (!res.ok) { console.warn(`[audio] missing MIDI file: ${name}`); return null; }
    const buf = await res.arrayBuffer();
    cache.set(name, buf);
    return buf;
  } catch (e) {
    console.warn(`[audio] failed to load MIDI file: ${name}`, e);
    return null;
  }
}
