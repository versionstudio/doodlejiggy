/**
 * @module schemas
 * Runtime data-shape validation. Compiles the JSON Schema documents under
 * ./schemas/ with ajv and exposes `validateSchema`, which warns each violation
 * as a tagged, pathed, human-readable message.
 *
 * Owns ALL ajv-error formatting — raw ajv messages never reach engine modules.
 * Structure only: required/allowed fields, types, enums, text shape, typos.
 * Game semantics (cross-references, graph rules, auto-corrections) stay in the
 * owning modules.
 */
import Ajv from 'ajv';
import objects from './schemas/objects.schema.json' with { type: 'json' };
import actors from './schemas/actors.schema.json' with { type: 'json' };
import dialogues from './schemas/dialogues.schema.json' with { type: 'json' };
import game from './schemas/game.schema.json' with { type: 'json' };
import scene from './schemas/scene.schema.json' with { type: 'json' };

const ajv = new Ajv({ allErrors: true, verbose: true, allowUnionTypes: true });

const validators = {
  objects:   ajv.compile(objects),
  actors:    ajv.compile(actors),
  dialogues: ajv.compile(dialogues),
  game:      ajv.compile(game),
  scene:     ajv.compile(scene),
  // Reuses the scene file's own `scriptDef` definition (and its full ref
  // closure) by embedding `scene.definitions` verbatim — one source of truth
  // for script shape, shared with authored content; cannot drift.
  scriptDef: ajv.compile({ $ref: '#/definitions/scriptDef', definitions: scene.definitions }),
};

/**
 * Validates `data` against the named schema, emitting one `console.warn` per
 * violation. No-op when the schema name is unknown or the data is valid. `tag`
 * prefixes every message (e.g. `[objects.json]`).
 */
export function validateSchema(name, data, tag) {
  const validate = validators[name];
  if (!validate || validate(data)) return;
  for (let i = 0; i < validate.errors.length; i++) {
    const msg = formatSchemaError(tag, validate.errors[i]);
    if (msg) console.warn(msg);
  }
}

/**
 * Validates a normalized scriptDef (the `{ steps, cutscene }` shape) against the
 * same `scriptDef` definition authored content uses. Returns formatted error
 * lines — empty when valid. Unlike `validateSchema` it returns rather than warns,
 * so the debug runner can surface errors in its panel. Combinator-only errors
 * (`if`/`allOf`) format to null and are dropped, leaving the actionable lines.
 */
export function validateScriptDef(data) {
  const validate = validators.scriptDef;
  if (validate(data)) return [];
  const lines = [];
  for (let i = 0; i < validate.errors.length; i++) {
    const msg = formatSchemaError('[run]', validate.errors[i]);
    if (msg) lines.push(msg);
  }
  return lines;
}

// Turns one ajv error into a human-readable line. The offending key/value lives
// in `e.params`/`e.data` (verbose mode), not `e.message`. JSON Pointer paths
// (`/lamp/states/on`) become dotted (`lamp.states.on`).
function formatSchemaError(tag, e) {
  const path = e.instancePath.replace(/^\//, '').replace(/\//g, '.');
  const where = tag + (path ? ' ' + path : '');
  switch (e.keyword) {
    case 'if': case 'oneOf': case 'anyOf': case 'allOf': case 'not':
      return null; // structural combinator: the actionable detail is in a sibling sub-error
    case 'additionalProperties':
      return where + ': unknown property "' + e.params.additionalProperty + '"';
    case 'required':
      return where + ': missing required property "' + e.params.missingProperty + '"';
    case 'enum':
      return where + ': "' + e.data + '" is not allowed (' + e.params.allowedValues.join(', ') + ')';
    case 'type': {
      const t = Array.isArray(e.params.type) ? e.params.type.join(' or ') : e.params.type;
      return where + ': expected ' + t;
    }
    default:
      return where + ': ' + e.message;
  }
}
