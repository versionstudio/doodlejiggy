/**
 * @module objects
 * Object schema/domain layer.
 *
 * Owns the object registry plus its schema interpretation, sprite-sheet grid
 * math, and semantic validation. Loading belongs to registries.js, which
 * populates `objectRegistry` once at boot.
 *
 * Carries no runtime state, so it is safe to import from both the engine and
 * the authoring tools.
 */

export const OBJECT_TRANSITIONS = Object.freeze({
  look:   'look',
  pickup: 'pickup',
});

export const objectRegistry = {};

// ══ Sprite-sheet grid ════════════════════

/**
 * Sprite-sheet column count covering every frame the object can draw, across
 * both the top-level animation and per-state animations. Stateless single-frame
 * objects yield 1.
 */
export function objectColumns(def) {
  let max = (def.startFrame || 0) + (def.frames || 1);
  if (def.states) {
    Object.values(def.states).forEach(function (s) {
      max = Math.max(max, (s.startFrame || 0) + (s.frames || 1));
    });
  }
  return max;
}

/**
 * Sprite-sheet row count covering every declared `row` across the top-level
 * animation and per-state animations. Stateless or single-row objects yield 1.
 */
export function objectRows(def) {
  let max = def.row || 0;
  if (def.states) {
    Object.values(def.states).forEach(function (s) {
      max = Math.max(max, s.row || 0);
    });
  }
  return max + 1;
}

// ══ Validation ═══════════════════════════

/**
 * Validates the semantics of every loaded object definition — cross-state
 * references and the pickup icon requirement. Structure (allowed/required
 * fields, types, enums, text shape, typos) is validated separately against the
 * `objects` JSON Schema at the load site (see `registries.js`).
 */
export function validateObjectDefs() {
  const keys = Object.keys(objectRegistry);
  for (let i = 0; i < keys.length; i++) validateObjectSemantics(keys[i], objectRegistry[keys[i]]);
}

function validateObjectSemantics(name, def) {
  if (def.states) {
    // Presence of `initialState` is a structural requirement the schema owns
    // (`dependencies`); only the dynamic key reference is checked here.
    if (def.initialState && !def.states[def.initialState]) {
      console.warn(`[objects.json] ${name}.initialState: "${def.initialState}" is not a key in the \`states\` map.`);
    }

    const stateKeys = Object.keys(def.states);
    for (let i = 0; i < stateKeys.length; i++) {
      const sn = stateKeys[i];
      validateTransitionTargets(name, sn, def.states[sn], def.states);
    }
  }

  // Pickup needs a resolvable inventory icon, checked on the initial-state
  // config resolved over the top level (mirroring runtime field resolution).
  const initialState = def.initialState && def.states ? def.states[def.initialState] : null;
  const resolved = { ...def, ...initialState };
  // Explicit null removes the inherited value, so the resolved config below
  // reads as one where the field was never authored.
  for (const k of Object.keys(resolved)) {
    if (resolved[k] === null) delete resolved[k];
  }
  if (resolved.interaction === 'pickup' && !resolved.icon && !resolved.sprite) {
    console.warn(`[objects.json] ${name}: \`interaction: "pickup"\` but no \`icon\` or \`sprite\` resolvable from the top level or \`initialState\` — the inventory icon will be blank.`);
  }
}

function validateTransitionTargets(name, stateName, state, allStates) {
  if (!state.transitions) return;
  const triggers = Object.keys(state.transitions);
  for (let i = 0; i < triggers.length; i++) {
    const trigger = triggers[i];
    const targetState = state.transitions[trigger];
    if (targetState && !allStates[targetState]) {
      console.warn(`[objects.json] ${name}.states.${stateName}.transitions.${trigger}: target state "${targetState}" is not declared in the \`states\` map.`);
    }
  }
}
