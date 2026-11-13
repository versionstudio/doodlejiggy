/**
 * @module config
 * Frozen engine configuration, consumed engine-wide.
 */
const CONFIG = {
  targetFps: 60, // cap the game loop; lower to debug or save battery

  world: { // the playable coordinate space; width is per-scene, so only height lives here
    height: 320, // native world height in pixels — all coordinates are relative to this
  },

  scene: { // scene transition
    fadeMs: 600, // scene fade duration on changeScene (ms); 0 = hard cut
  },

  camera: { // camera follow + scroll tuning
    lerp:                     8,   // exponential approach rate (1/s); ~63% closed in 1/lerp sec. 1=cinematic, 8=snappy, 20+=snap.
    snapThreshold:            0.5, // snap to target instead of lerp when within this many px
    scrollMargin:             0.3, // fraction of viewport width; player walks freely in centre (1−2×margin) before camera scrolls. Widened on portrait by portraitMarginMultiplier for the narrower play area.
    portraitMarginMultiplier: 1.6, // scrollMargin is multiplied by this on portrait viewports (applied in camera.js)
  },

  speech: { // spoken-line pacing (ms)
    minMs:        2000, // minimum time a spoken line stays on screen
    msPerWord:    400,  // additional display time per word
    speakerGapMs: 250,  // silent breather when the speaker changes between dialogue beats; 0 = off. Scripts are unaffected (use a `wait` step).
  },

  audio: { // synth output levels (0–1)
    musicVolume: 0.8, // master gain ceiling for the music synth (applied in synth.js)
  },

  save: { // save game support
    enabled: false, // enables save games in production. Always enabled during local development.
  },

  // Input bindings — `e.key` values, matched exactly by input.js (`debug` by
  // debug.js). A binding left empty or null disables that affordance on every
  // device, including its touch gesture: no scan means no long-press either,
  // and no skip means a tap can't hurry a line.
  controls: {
    scan:  'Shift', // hold to reveal interactable objects in current scene
    skip:  ' ',     // skip / advance dialogue (space bar)
    debug: '§',     // toggle debug toolbar (dev only)
  },

  paths: { // resource directory prefixes (relative) — single source of truth for asset locations. Fonts omitted: their dir is owned by base.css @font-face.
    backdrops: 'backdrops/',
    data:      'data/',
    icons:     'icons/',
    inserts:   'inserts/',
    interface: 'interface/',
    music:     'music/',
    sprites:   'sprites/',
  },
};

for (const v of Object.values(CONFIG)) {
  if (v && typeof v === 'object') Object.freeze(v);
}
Object.freeze(CONFIG);

export default CONFIG;
