/**
 * @module crossref
 * Owns the authored dependency graph. Provides pure, name-level queries over
 * authored scenes and scripts, answering what content references which
 * definitions. Consumers such as scene preloading and authoring tools
 * decide how to interpret those relationships.
 *
 * Knows nothing about runtime state, asset paths, loading strategy, or UI.
 */

import { ACTION_REFS } from './script.js';

// A ReferenceEdge is one authored reference from a scene to a definition:
//   name    — referenced object/actor/insert/backdrop
//   entity  — what kind of definition: 'object' | 'actor' (registries),
//             'insert' (standalone full-frame image asset),
//             'backdrop' (the scene's world image)
//   via     — origin of the reference ('world' | 'placement' | 'script')
//   nature  — 'provides' (brings it into the scene) | 'requires' (assumes present)
//   script  — owning script name, set only when via === 'script'

// ══ Per-scene references ═════════════════

/**
 * Every authored reference one scene makes, as ReferenceEdge[] — the forward
 * direction (scene → definitions). The world backdrop and placements are
 * `provides` edges; each script step contributes edges per `ACTION_REFS`,
 * carrying that action's nature. Consumers filter by `nature`/`entity`/`via`
 * as they need.
 */
export function sceneReferences(sceneData) {
  const edges = [];
  if (!sceneData) return edges;

  const backdrop = sceneData.world && sceneData.world.backdrop;
  if (backdrop) edges.push({ name: backdrop, entity: 'backdrop', via: 'world', nature: 'provides' });

  const placements = sceneData.objects || {};
  for (const name of Object.keys(placements)) {
    edges.push({ name: name, entity: 'object', via: 'placement', nature: 'provides' });
  }

  const sceneScripts = sceneData.scripts || {};
  for (const scriptName of Object.keys(sceneScripts)) {
    const def = sceneScripts[scriptName];
    const steps = Array.isArray(def) ? def : def && def.steps;
    if (!Array.isArray(steps)) continue;
    for (const step of steps) {
      const entry = step && ACTION_REFS[step.action];
      if (!entry) continue;
      const refs = entry.refs(step);
      addScriptEdges(edges, refs.objects, 'object', entry.nature, scriptName);
      addScriptEdges(edges, refs.actors,  'actor',  entry.nature, scriptName);
      addScriptEdges(edges, refs.inserts, 'insert', entry.nature, scriptName);
    }
  }
  return edges;
}

function addScriptEdges(edges, names, entity, nature, scriptName) {
  if (!names) return;
  for (const name of names) {
    if (name) edges.push({ name: name, entity: entity, via: 'script', nature: nature, script: scriptName });
  }
}

// ══ Cross-reference index ════════════════
//
// Inverse lookups over every scene: built once from a { sceneName: sceneData }
// map, then queried for which scenes place / which scripts reference an object.

/**
 * Builds an immutable index by mapping `sceneReferences` across every scene and
 * inverting the result.
 *
 * @returns {ReferenceIndex} A frozen object of inverse-lookup queries:
 *   `scenesPlacing(objectName)` → scene names whose placement map lists it;
 *   `scriptsReferencing(objectName)` → script names that reference it (any nature).
 */
export function buildReferenceIndex(scenesByName) {
  const placedBy = {};     // objectName → Set(sceneName)
  const referencedBy = {}; // objectName → Set(scriptName)

  for (const sceneName of Object.keys(scenesByName || {})) {
    for (const edge of sceneReferences(scenesByName[sceneName])) {
      if (edge.entity !== 'object') continue;
      if (edge.via === 'placement') addTo(placedBy, edge.name, sceneName);
      else if (edge.via === 'script') addTo(referencedBy, edge.name, edge.script);
    }
  }

  return Object.freeze({
    scenesPlacing:      function (objectName) { return sortedList(placedBy[objectName]); },
    scriptsReferencing: function (objectName) { return sortedList(referencedBy[objectName]); },
  });
}

function addTo(map, key, value) {
  (map[key] || (map[key] = new Set())).add(value);
}

function sortedList(set) {
  return set ? Array.from(set).sort() : [];
}
