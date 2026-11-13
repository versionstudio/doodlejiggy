/**
 * @module actors
 * Actor schema/domain layer.
 *
 * Owns the actor registry plus its schema interpretation, sprite-sheet grid
 * math, and semantic validation. Loading belongs to registries.js, which
 * populates `actorRegistry` once at boot. Runtime actor behavior (movement,
 * animation state, dialogue state, facing) lives in scene.js, tied to live
 * scene state.
 *
 * Carries no runtime state, so it is safe to import from both the engine and
 * the authoring tools.
 */

export const actorRegistry = {};

/**
 * Sprite-sheet column count: the widest animation frame the actor can draw
 * across walk/idle/talk and any named animations. A one-frame animation block
 * contributes 1 column; no animation blocks yield 0.
 */
export function actorColumns(def) {
  let max = 0;
  function trackColumns(anim) {
    if (!anim) return;
    max = Math.max(max, (anim.startFrame || 0) + (anim.frames || 1));
  }
  trackColumns(def.walk);
  trackColumns(def.idle);
  trackColumns(def.talk);
  if (def.animations) Object.values(def.animations).forEach(trackColumns);
  return max;
}

/**
 * Sprite-sheet row count: the highest lane index any animation block references,
 * across walk/idle/talk and any named animations, whether the block is
 * directional (`rows`) or non-directional (`row`). Single-row actors yield 1.
 */
export function actorRows(def) {
  let max = 0;
  function trackRows(anim) {
    if (!anim) return;
    if (anim.rows) Object.values(anim.rows).forEach(function (r) { max = Math.max(max, r); });
    else if (anim.row !== undefined) max = Math.max(max, anim.row);
  }
  trackRows(def.walk);
  trackRows(def.idle);
  trackRows(def.talk);
  if (def.animations) Object.values(def.animations).forEach(trackRows);
  return max + 1;
}

/**
 * Resolves the animation block to draw for the current animation state.
 * An override uses its named clip from `animations`. Otherwise the requested
 * block falls back to `idle`. If no block resolves, the renderer holds frame 0.
 */
export function resolveAnimBlock(actor, state) {
  if (state === 'override') return actor.animations && actor.animations[actor.animOverride];
  return actor[state] ?? actor.idle;
}

/**
 * Validates the actor semantics the JSON Schema can't express: `initialState`
 * must name a declared state, and every state resolving a `sprite` after
 * state-over-actor inheritance must derive a sprite grid (spriteless states
 * need no animation data). Structure is the schema's job, at the load site
 * (`registries.js`).
 *
 * Theme references like `speechColor` are deliberately unchecked — they resolve
 * at draw time against a guaranteed vocabulary, so a typo is not a breakage.
 */
export function validateActorDefs() {
  const keys = Object.keys(actorRegistry);
  for (let i = 0; i < keys.length; i++) {
    const name = keys[i];
    const def = actorRegistry[name];

    if (!def.states) continue;

    // Schema owns the presence of `initialState`; here we check only that the
    // named key exists.
    if (def.initialState && !def.states[def.initialState]) {
      console.warn(`[actors.json] ${name}.initialState: "${def.initialState}" is not a key in the \`states\` map.`);
    }

    // Every declared state must resolve a derivable grid: a resolved `sprite`
    // with no animation block leaves `actorColumns` at 0, so frame dimensions
    // can't be derived and the actor won't render. Checked on the state
    // resolved over the def baseline, matching runtime inheritance.
    const stateKeys = Object.keys(def.states);
    for (let s = 0; s < stateKeys.length; s++) {
      const stateName = stateKeys[s];
      const resolved = { ...def, ...def.states[stateName] };
      // Explicit null removes the inherited value, so the resolved config below
      // reads as one where the field was never authored.
      for (const k of Object.keys(resolved)) {
        if (resolved[k] === null) delete resolved[k];
      }
      if (!resolved.sprite) continue;
      if (actorColumns(resolved) < 1) {
        console.warn(`[actors.json] ${name}.states.${stateName}: resolves a \`sprite\` but no animation block (\`idle\`/\`walk\`/\`talk\`/\`animations\`), so the sprite grid can't be derived. The actor will not render.`);
      }
    }
  }
}
