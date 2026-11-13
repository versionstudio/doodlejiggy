/**
 * @module dialogues
 * Dialogue schema/domain layer.
 *
 * Owns the dialogue registry plus its semantic validation. Loading belongs to
 * registries.js, which populates `dialogueRegistry` once at boot; the registry
 * is never cleared. The dialogue *runtime* (active dialogue, topic visibility,
 * playback) lives in narrative.js, and persistent progression in state.js.
 *
 * Carries no runtime state, so it is safe to import from both the engine and
 * the authoring tools.
 */

export const dialogueRegistry = {};

// ══ Validation ═══════════════════════════
//
// Soft schema, loud author signal — never rejects definitions, warns at boot.
// Validation is best-effort: reachability checks treat conditioned topics
// (`if`/`ifNot`) as potentially satisfiable, so they may produce false
// positives rather than chase exhaustive predicate semantics.

/**
 * Validates the semantics of every loaded dialogue definition: topic-graph
 * concerns the schema can't express — cross-references (`unlockTopics` /
 * `replaceWith` targets exist), contradictory consequences, cycles, reachability,
 * and trap risk. Structure (line/topic shape, required `option`, typos) is
 * validated separately against the `dialogues` JSON Schema at the load site
 * (see `registries.js`). Intra-dialogue only — actor `dialogue`-field cross-references
 * are checked separately once the actor registry is populated (see
 * `validateDialogueRefs`).
 */
export function validateDialogueDefs() {
  const keys = Object.keys(dialogueRegistry);
  for (let i = 0; i < keys.length; i++) validateOneDialogue(keys[i], dialogueRegistry[keys[i]]);
}

function validateOneDialogue(dialogueName, def) {
  const tag = '[dialogues.json] ' + dialogueName;
  const topics = def.topics || {};
  const topicIds = Object.keys(topics);
  if (topicIds.length === 0) {
    console.warn(`${tag}: no \`topics\` — the dialogue has nothing to select.`);
    return;
  }

  for (let i = 0; i < topicIds.length; i++) {
    const id = topicIds[i];
    const topic = topics[id];
    const ttag = tag + '.topics.' + id;

    if (topic.removeAfter && topic.replaceWith !== undefined) {
      console.warn(`${ttag}: has both \`removeAfter\` and \`replaceWith\` — contradictory consequences.`);
    }
    if (Array.isArray(topic.unlockTopics)) {
      topic.unlockTopics.forEach(function (target) {
        if (!topics[target]) console.warn(`${ttag}.unlockTopics: unknown topic "${target}".`);
      });
    }
    if (topic.replaceWith !== undefined && !topics[topic.replaceWith]) {
      console.warn(`${ttag}.replaceWith: unknown topic "${topic.replaceWith}".`);
    }
  }

  detectUnlockCycles(tag, topics, topicIds);
  detectReplaceCycles(tag, topics, topicIds);
  warnNoRootTopics(tag, topics, topicIds);
  reportTrapRisk(tag, topics, topicIds);
}

// A topic is a root if no other topic targets it via `unlockTopics` or
// `replaceWith`. Roots appear at dialogue start; everything else must be
// reachable through an unlock/replace edge.

function buildTargetSet(topics, topicIds) {
  const targeted = {};
  for (let i = 0; i < topicIds.length; i++) {
    const t = topics[topicIds[i]];
    if (Array.isArray(t.unlockTopics)) t.unlockTopics.forEach(function (x) { targeted[x] = true; });
    if (t.replaceWith !== undefined) targeted[t.replaceWith] = true;
  }
  return targeted;
}

function detectUnlockCycles(tag, topics, topicIds) {
  const state = {}; // id → 0 unvisited, 1 in-stack, 2 done
  function visit(id) {
    if (!topics[id]) return false;
    if (state[id] === 1) return true;
    if (state[id] === 2) return false;
    state[id] = 1;
    const targets = topics[id].unlockTopics || [];
    for (let i = 0; i < targets.length; i++) if (visit(targets[i])) return true;
    state[id] = 2;
    return false;
  }
  for (let i = 0; i < topicIds.length; i++) {
    if (visit(topicIds[i])) { console.warn(`${tag}: unlockTopics cycle detected (involving "${topicIds[i]}").`); return; }
  }
}

function detectReplaceCycles(tag, topics, topicIds) {
  for (let i = 0; i < topicIds.length; i++) {
    const seen = {};
    let cur = topicIds[i];
    while (cur !== undefined && topics[cur] && topics[cur].replaceWith !== undefined) {
      if (seen[cur]) { console.warn(`${tag}: replaceWith cycle detected (involving "${topicIds[i]}").`); break; }
      seen[cur] = true;
      cur = topics[cur].replaceWith;
    }
  }
}

function warnNoRootTopics(tag, topics, topicIds) {
  const targeted = buildTargetSet(topics, topicIds);
  let hasRoot = false;
  for (let i = 0; i < topicIds.length; i++) if (!targeted[topicIds[i]]) hasRoot = true;
  if (!hasRoot) {
    console.warn(`${tag}: no root topics — every topic is unlocked/replaced by another, so the dialogue opens with nothing visible.`);
  }
}

// Best-effort: warn when a dialogue could rest in a stable state with visible
// topics but no reachable `endDialogue`, leaving the player no authored way out.
function reportTrapRisk(tag, topics, topicIds) {
  let hasEndDialogue = false;
  for (let i = 0; i < topicIds.length; i++) if (topics[topicIds[i]].endDialogue) hasEndDialogue = true;
  if (hasEndDialogue) return;

  // No endDialogue anywhere: the dialogue only exits when no visible topics
  // remain. If any topic can persist (no removeAfter and not replaced away),
  // the player may get stuck.
  const targeted = buildTargetSet(topics, topicIds);
  for (let i = 0; i < topicIds.length; i++) {
    const t = topics[topicIds[i]];
    const persists = !t.removeAfter && t.replaceWith === undefined && !targeted[topicIds[i]];
    if (persists) {
      console.warn(`${tag}: has persistent visible topics but no reachable \`endDialogue\` — player may be unable to leave (best-effort warning).`);
      return;
    }
  }
}

/**
 * Warns on actor dialogue problems — missing dialogue references, the
 * dialogue/talkText mutual exclusion, and `interaction: "talk"` with nothing
 * to say. State-aware: an actor's dialogue/talkText/interaction may live in a
 * state, so each is checked at the def baseline and per state (a stateful actor
 * is always in some state at runtime, so the bare def isn't an effective config
 * for the semantic checks). Run at boot after both the actor and dialogue
 * registries are populated. Takes the actor registry as a parameter so this
 * module stays a pure peer (no import of `actors.js`).
 */
export function validateDialogueRefs(actorRegistry) {
  const names = Object.keys(actorRegistry);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const def = actorRegistry[name];
    const stateNames = def.states ? Object.keys(def.states) : [];

    // Every declared `dialogue` — top level and each state — must name a real
    // dialogue (`null`, the removal opt-out, names nothing and is skipped). A
    // state-level dialogue resolves at runtime, so a typo there would
    // otherwise only surface as a runtime "no resolvable dialogue".
    if (def.dialogue != null && !dialogueRegistry[def.dialogue]) {
      console.warn(`[actors.json] ${name}.dialogue: "${def.dialogue}" is not a defined dialogue.`);
    }
    for (let k = 0; k < stateNames.length; k++) {
      const sd = def.states[stateNames[k]].dialogue;
      if (sd != null && !dialogueRegistry[sd]) {
        console.warn(`[actors.json] ${name}.states.${stateNames[k]}.dialogue: "${sd}" is not a defined dialogue.`);
      }
    }

    // Mutual exclusion + talk-needs-content, on each effective configuration:
    // a stateless actor is its def; a stateful actor is checked per state
    // resolved over the def baseline (never the bare def — it's never the live
    // config), so dialogue declared only in a state doesn't read as "missing".
    const configs = stateNames.length
      ? stateNames.map(function (sn) { return { label: '.states.' + sn, state: def.states[sn] }; })
      : [{ label: '', state: null }];
    for (let j = 0; j < configs.length; j++) {
      const label = configs[j].label;
      const resolved = { ...def, ...configs[j].state };
      // Explicit null removes the inherited value, so the resolved config below
      // reads as one where the field was never authored.
      for (const k of Object.keys(resolved)) {
        if (resolved[k] === null) delete resolved[k];
      }
      if (resolved.dialogue !== undefined && resolved.talkText !== undefined) {
        console.warn(`[actors.json] ${name}${label}: has both \`dialogue\` and \`talkText\` (mutually exclusive); \`dialogue\` takes precedence.`);
      }
      if (resolved.interaction === 'talk' && resolved.dialogue === undefined && resolved.talkText === undefined) {
        console.warn(`[actors.json] ${name}${label}: \`interaction: "talk"\` but neither \`dialogue\` nor \`talkText\` — nothing to say.`);
      }
    }
  }
}
