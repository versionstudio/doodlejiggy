# Contributing to Doodlejiggy

Conventions for writing code and documentation in this repository. Engine behavior and authoring contracts live in `README.md`; design rationale and invariants in `ARCHITECTURE.md`. `README.md` § Development covers setup and the dev server.

## Read first

Read these in order — each topic has exactly one authoritative section:

- `ARCHITECTURE.md` § Design philosophy — module-placement judgment
- `ARCHITECTURE.md` § Module dependencies — imports flow strictly downward
- § Code conventions (below) — dividers, declaration placement, function organization, naming, rationale-vs-statement comments, alignment, comment placement and content
- § Logging (below) — `console.error` / `console.warn` only, never `console.log`, never inside loops
- § Documentation (below) — document why and non-obvious things only

## Code conventions

These apply throughout `src/`.

### Section dividers

JS modules are split into sections by a heavy divider aligned to a uniform right edge (column 44):
```js
// ══ Section name ══════════════════════════
```
The uniform right edge is what makes sections scannable as navigation landmarks. CSS uses the same divider inside a block comment: `/* ══ Section name ══ */` (see § CSS files).

A divider marks a **destination you'd scan or jump to** — a real subsystem — not every block:

- **No header on the preamble.** Imports, module constants, and module state sit at the top unheadered; the `@module` block frames them. The first divider is the first real behavioral section.
- **Fewer, stronger landmarks.** Merge a sequential pipeline into one section (crop → draw → wrappers = one `World sprites`). Keep parallel siblings with distinct semantics separate even when short (the four interaction verbs). A run of single-function sections is a smell.
- **`══` is module-scope only.** Subgroups inside a function use the light `// — Label —` form.

One blank line after a divider before the section's first line; one blank line between top-level functions and between sections.

### Declaration placement — ownership, not mutability

**Declarations belong with their owner, not their readers.** A `const`/`let` lives with the section that owns its lifecycle — creates, mutates, clears, defines its invariants. Reads from other sections do *not* affect placement. The criterion is ownership, never mutability — `const` and `let` alike.

- **Cross-cutting** declarations (owned/used across multiple sections, or genuine module-wide config/state) live in the preamble, no header.
- **Section-owned** declarations live at the start of their owning section — e.g. a renderer's tuning constants beside it, a subsystem's private state above its functions.
- A **developer-facing vocabulary/catalog** (`SCENE_TRIGGERS`, `ACTION_DEFS`, `INTERACTIONS`) stays in the preamble even if only one section reads it — it's reference data you look up, not incidental state.
- A **pure-data state block stays preamble, no `State` header**, regardless of size. It earns a section only if it also contains a function (e.g. a persistence helper beside the data it saves).

The goal: sections are self-contained units — remove one and most of its declarations go with it, and the preamble never becomes a junk drawer of unrelated state.

**Constants live at the narrowest scope that matches what they represent.** Scope follows what the value *is*, not how many times it happens to be referenced — never move a constant simply because it is used once; move it when a narrower scope better reflects its ownership.

- **Function implementation details** stay local — a lone dimension/threshold/fallback that one function computes against becomes a `const` inside that function. Don't hoist it to module scope, and don't manufacture a one-constant "config block" to keep it at the top.
- **Tuning/configuration blocks** stay at module scope beside the subsystem they tune — `DIALOGUE_*` / `NARRATION_*` (`render.js`), scan-marker radii, `GRID_*` and the scale-handle group (`design.js`). The grouping is itself the value; it stays whole even when a single function reads it.
- **Module identities** — sentinels, storage keys, internal protocol strings (`DIALOGUE_OWNER`, `SAVE_KEY`, synthetic script names) — stay at module scope. They are module-level contracts, not one-off knobs.
- **Lookup tables and declarative mappings** stay at module scope — they are reference data (and module scope also avoids rebuilding them per call).

### Function organization

Organize functions into meaningful **paragraphs**. Not every function is a workflow with phases, but almost every well-written one is a sequence of coherent paragraphs — each representing one thought, responsibility, or stage. Use blank lines to separate genuine changes in thought, intent, responsibility, or phase (`resolve → build → execute → notify`, `gather → validate → apply → publish`, `capture state → invalidate cache → arm timer`). The test: **someone skimming only the paragraph boundaries should still grasp the function's flow.**

The bar is high — a paragraph break marks a real shift in what the code is doing, not just the next statement:

- A guard followed by a single cohesive body is usually **one** paragraph — keep them together unless the guard is distinct work in its own right (e.g. validation before a multi-stage workflow).
- A loop followed immediately by `return items` is one thought, not two.
- Don't manufacture paragraphs because a function has several statements; don't ring every comment with blank lines.
- When in doubt, don't add a blank line. Mechanical whitespace hides structure as surely as no whitespace does.

**Every function takes block form**, including simple getters, setters, and direct delegates:

```js
export function currentSceneName() {
  return currentScene;
}
```

One visual rhythm across the codebase matters more than compactness, and the extra lines keep later edits clean. A short body is not a reason to collapse a function.

### Naming

Export names are the API. Four principles govern them; the families below are the vocabulary that has emerged across the engine so far.

**An export name must read correctly at the call site without its module name.** Callers write `initScene(gameElement)`, so a bare `init` would leave the reader guessing which subsystem is being wired. When an import needs an alias to be readable, the export name is the thing to fix, not the import.

**A name is never narrower than its contract.** When something operates uniformly across a broader domain, it takes that domain's vocabulary. A function that treats actors, objects, and portal exits alike is `entity`-named (`entityScale`, `isEntityAnchorVisible`), while `renderObject` and `resolveObjectField` stay object-specific because their behavior genuinely is. A name drawn from one kind of caller, or from one historical use, sends every later reader into the body to find out what it actually accepts.

**Share concepts, not implementations.** Similar-looking code is not, by itself, a reason to introduce a shared helper. Extract code when it represents a genuine engine concept or clearly improves readability. Prefer a small amount of duplication over an abstraction that obscures ownership or exists only to remove repeated lines.

**Authored vocabulary is frozen.** Script action names, trigger names, and data-file keys are the authoring contract, so they never track an internal rename. `setObjectState` stays the action name even though the persistence function behind it is `setSavedObjectState`.

**Verb families.** These prefixes carry consistent meaning today. Match one when it fits, and reach for a new word when none of them says what you mean. The table describes the engine's current vocabulary rather than fixing it: when a better convention emerges, update the table and bring the code with it. A name that has to be contorted to fit a row here is evidence the row is wrong, not the name.

| Family | What it promises |
|---|---|
| `init*` | One-time wiring at composition time, named for the module (`initWorld`, `initScript`). |
| `tick*(dt)` | Per-frame advance, driven by the game loop. |
| `on*` | Registers a composition-time seam. `game.js` wires them; the owning module fires them. |
| `is*` / `has*` | Predicate, no side effects. |
| `get*` / `set*` | Accesses the module's public state. A getter returns either a stored field or a derived projection of it (`getInventory`, `getVisibleTopics`). A qualifier narrows *what* is accessed without starting a new family: `getSavedObjectState`. |
| `current*` | The resolved effective value of whatever is active. |
| `apply*` | Commits a value together with its consequences: re-resolve, notify, install. |
| `resolve*` | Computes an effective value from a definition plus state. |
| `validate*` | Semantic check at load. Warns and continues. |
| `load*` | Fetches authored data. |
| `clear*` | Returns something to empty or none. |
| `start*` / `stop*` | Session lifecycle: scripts, dialogue, music. |
| `spawn*` / `remove*` | Entity lifecycle within the scene. |
| `render*` / `draw*` | Canvas emission. `render*` belongs to the engine and `draw*` to the tools, so the prefix tells you which layer a drawing call came from. |

The `getSaved`/`current`/`apply` trio is the one worth internalising, because all three address the same field and answer different questions about it. `getSavedObjectState` is the raw persisted value, `currentObjectState` resolves the live instance then the save then `initialState`, and `applyObjectState` writes the value and refreshes everything downstream of it.

**Queries read as noun phrases** instead of taking a verb: `entitiesInDrawOrder()`, `portalExitInteractPoint(exit)`, `interactableAtNativePoint(x, y)`. A name that already describes what comes back needs no `get`.

### Section rationale vs. statement comments

A section may carry a rationale describing the **whole section's** shared concept, hugged to the divider with a `//` breather line:
```js
// ══ Ambient barks ════════════════════════
//
// Per-actor random idle lines … (the shared model the section's functions assume)
```
A comment describing the **next declaration specifically** is a statement comment — a real blank line after the divider, then the comment hugging the code. The test: does the prose describe a concept spanning multiple functions, or just the next declaration? Always name the subject. A section with no genuine shared concept simply has no rationale block — don't invent one.

### Alignment

Alignment is for code read **vertically as a table** — never for executable logic. The discriminator is intent, not syntax: *am I reading this as rows to compare?*, not *is this an object literal?*. When unsure, ask the first question; if the answer is no, don't align.

- **Keep aligned** — object literals, registries, lookup tables, declarative mappings, and tuning/config constant blocks. These are read as data, so aligned columns let the eye compare rows. A block of named tuning constants (`DIALOGUE_*`, `NARRATION_*` in `render.js`) is a configuration table and **stays aligned** even though it's syntactically a run of `const`s — alignment survives where it helps humans compare rows, and tuning constants are one of the few places it genuinely does.
- **Never align** — assignments, mutations, function calls, control flow, and local `const`/`let` or module-state declarations. A declaration block is not a table just because several sit together; aligning it adds churn on every rename and implies structure that isn't there.

### Comments

**Placement.**

- **Never column-align trailing comments.** An aligned comment column is a fake table that re-flows on every rename — one space before `//`. This holds even inside an aligned tuning block: the constants stay column-aligned, their comments do not.
- **Short factual note / description** → inline: `let barkSchedules = {}; // actor → schedule`.
- **Longer explanation or rationale** → above the code it explains:
  ```js
  // Force reflow so the no-transition assignment commits before restoring.
  void canvas.offsetHeight;
  ```

**Content — current state, not history.** A comment earns its place by saying what the code can't say itself: *what* a thing is, *why* it exists, or an invariant / assumption / coupling a future change must respect. Keep comments that document intent, invariants, non-obvious behavior, architectural constraints, and cross-system coupling.

- **Document the present, not the past.** Avoid changelog/evolutionary framing — "used to", "historic", "no longer", "preserved unchanged", "previously" — and the stories behind it: why a former implementation was replaced, why an old bug existed, why a superseded approach no longer applies, refactoring history. The test: *would a newcomer be helped more by the current purpose than by the history?* If yes, state the purpose and drop the history.
- **Keep history only when a current constraint depends on it** — when today's code can't be understood without the reason it got that way.
- **Keep comments accurate.** A comment that no longer matches the code is worse than none; update it in the same change. Speculative "future X goes here" notes don't belong beside the code or in the docs; track ideas in issues or design discussions instead.
- **Architecture lives in ARCHITECTURE.md; comments explain local behavior and constraints.** A comment that's really describing system structure belongs in ARCHITECTURE.md instead.

## Logging

Two console methods, used sparingly:

- **`console.error`** — runtime failures that should not happen. File-load errors, missing scenes, references to undefined actors/scripts. Means "the system is in a state worth investigating."
- **`console.warn`** — author/config errors caught at load time. Malformed data files, contradictory declarations (e.g. a dialogue topic with both `removeAfter` and `replaceWith`). Names the file, the specific path inside it, and what the engine did about it.

Not used: `console.log`, and no logging inside the game loop or render loop. Logs at 60 fps become noise nobody cleans up. For runtime inspection, use the debug toolbar or browser breakpoints.

Use template literals for interpolated messages. Prefer

```js
console.warn(`[objects.json] ${name}.initialState: unknown state "${state}"`);
```

over

```js
console.warn('[objects.json] ' + name + '.initialState: unknown state "' + state + '"');
```

This applies to log, warning, error, and diagnostic messages, as well as longer user-facing text that contains interpolation. Simple string assembly remains acceptable when constructing identifiers, paths, tags, keys, or similarly mechanical values — e.g. `CONFIG.paths.music + name + '.mid'`, `tag + '.' + actorName`. The goal is readability of messages, not elimination of all string concatenation.

## Documentation

Document why and non-obvious things only.

### Principles

- Each concept has one canonical section that owns it; other sections cross-reference rather than re-explain.
- **Document boundaries.** `README.md` owns engine behavior and authoring contracts. `ARCHITECTURE.md` owns design rationale, invariants, ownership, and architectural decisions — not implementation details. `CONTRIBUTING.md` owns code and documentation conventions. Route new documentation by audience, and cross-reference across a boundary instead of duplicating.
- **Keep source comments implementation-focused.** Source comments explain the implementation being read, not the engine as a whole. Behavioral contracts belong in `README.md`; architectural rationale belongs in `ARCHITECTURE.md`. If a source comment starts restating those documents instead of explaining the implementation, it is probably too long.
- **Keep ARCHITECTURE.md refactor-stable.** A refactor that preserves the architecture should rarely require editing it. If a code change forces an ARCHITECTURE.md edit but no design decision changed, that text was implementation notes — move it or delete it rather than updating it.
- Don't document the documentation. A document opens with at most one line of orientation plus cross-references to the other docs, never "This document explains…" — the heading and structure carry the purpose. Documents describe the engine as it exists today; future direction lives in issues and design work, not in a Future section.
- Document hidden side effects.
- Document invariants.
- Document ownership, contracts, and important rationale.
- **Document decisions, not discoveries.** If a reader can discover it by reading the code (imports, helper names, call order), it usually doesn't belong in the documentation. Explain the design decisions the code alone cannot.
- Don't document obvious mechanics.
- Document the current state only — never historical/changelog framing ("now cleaned up the old X", "previously", "used to", "moved from"). When a change lands, rewrite the affected docs to present tense; don't narrate the change. (Present-tense runtime/game state like "the object no longer exists" is fine — that's behavior, not engine history.)
- **Document stable concepts (ownership, boundaries, invariants, rationale), not implementation details (imports, helper-function names, call chains).** The test: if a doc paragraph would need editing after a pure refactor that preserved the architecture, it is too implementation-specific — shorten or remove it. Don't enumerate imports or narrate call chains. State what a module owns, the guarantees it provides, and the dependency rules it follows.

### Prose style

These apply to prose documentation (README, long comments), not code.

Prefer complete sentences over em dashes. Em dashes (`—`) are valid punctuation, but they should be the exception, not the default.

- When the second clause simply explains the first, prefer a new sentence or a colon: "`scene.js` owns runtime scene state. It never imports rendering." not "`scene.js` owns runtime scene state — it never imports rendering."
- Introduce an explanation or a list with a colon: "Project structure:" not "Project structure —".
- Use parentheses for short, inline clarifications.
- Reach for an em dash only when it genuinely improves readability (a sharp aside or interruption no colon or parenthesis reads as well). When in doubt, don't.

### Module headers

Every module opens with a `/** @module */` JSDoc block. Keep it short: one line of purpose, then ownership scope if non-obvious.

```js
/**
 * @module world
 * The playable coordinate space: the world layer, its authored extent and clear
 * color, its static geometry, and depth-scale resolution.
 *
 * Owns what the world *is*, never what lives in it. Actors, objects, portals,
 * triggers, and scene lifecycle belong to scene.js.
 */
```

State the scope positively. "Owns X, never Y" reads better than a list of things the module does not do.

### Section headers

Module sections use a heavy divider aligned to column 44 (see § Code conventions for the full divider, declaration-placement, and rationale rules). A section may carry a shared-concept explanation hugged to the divider with a `//` breather — describing the conceptual model the section's functions assume, not what individual functions do. Use it only for concepts that would otherwise repeat across multiple JSDoc blocks:

```js
// ══ Description index ════════════════════
//
// Actors and objects maintain separate progression buckets.
```

### Export JSDoc

**The test:** a JSDoc block should teach something you would not learn immediately from the function name and signature.

**Add JSDoc when:**

- A function has a behavioral contract not obvious from its name: caching, persistence side effects, ownership rules, separate buckets, clamping, lifecycle requirements, ordering guarantees
- A parameter has a non-obvious type: unions, callbacks, structured objects, complex arrays
- A return value has a non-obvious shape or semantic contract

**Do not add JSDoc when:**

- The function name already explains the behavior
- The only information is obvious primitive types (`@param {string} name`, `@returns {boolean}`) unless the type itself conveys important meaning
- The comment would repeat something already stated in the section header
- The comment exists for completeness or to mark something as public — `export` already does that
- Internal helpers (whether `_prefixed` or just non-exported) follow the same test — usually no JSDoc

### Practical rules

- **Descriptions** — describe the contract, not the implementation. Prefer what callers can rely on over how the result is produced. "Returns the same instance on repeated calls" over "creates and caches if needed." Include rationale when it explains why the contract exists.
- **`@param`** — use when the type or shape teaches something (unions, callbacks, complex shapes); otherwise prefer behavioral documentation.
- **Return values** — four principles; everything that follows is how to apply them, not extra rules:
  - Use `@returns` whenever the return isn't obvious from the signature. Skip it for primitives and obvious single values (`boolean`, a DOM node from a `*Element` name).
  - Prefer a named domain concept over an anonymous structural type — but only when a genuine shared concept exists. `@returns {ReferenceEdge[]}` teaches vocabulary; `@returns {Array<{ name, entity, … }>}` only teaches a shape. The name is documentation, not a checked type — no JSDoc `@typedef`.
  - Define a shared concept once, in a prose comment where it's introduced (`ReferenceEdge`, `Bounds`, `SourceRect`); never duplicate it. A type that describes only one function's return (`NarrationCard`, `PortalExitHit`) gets no standalone comment — its `@returns` is the definition. The test: has this become part of the engine's shared vocabulary — a concept that exists independently of one function and that we'd naturally refer to elsewhere?
  - Every `@returns` describes what *this* function returns, never a bare type — for a shared concept, what these particular ones are (the standalone comment defines the type); for a local one, the description *is* the definition.
  ```js
  // Shared concept — the standalone `Bounds` comment defines the type.
  /** @returns {Bounds} Axis-aligned bounds enclosing the sprite as drawn. */

  // Local concept — no standalone comment; the description defines it.
  /**
   * @returns {NarrationCard | null} The active narration card — its text,
   * colors, timing, owner, and runtime progress — or null when none is active.
   */
  ```
- **Inline form** — single-line `/** @returns {Type} Description. */` is acceptable when there's only one tag and no main description; use the multi-line form otherwise.

### Bad examples

**Restates the obvious:**
```js
/** @param {string} name */
export function setFlag(name)

/** Clears a flag. */
export function clearFlag(name)
```

**Redundant parameter description:**
```js
/** @param {string} name The name of the flag */
export function setFlag(name)
```

### CSS files

Same thinking as the JS conventions above, ported to CSS (only `/* */` exists, but `/**` and `══` are valid inside it).

- **File header** — open with a `/** */` block: one line of purpose, then ownership scope (which tools import it, production exclusion) and any non-obvious convention. Mirrors `@module`.
- **Section dividers** — `/* ══ Section ══ */` aligned to column 44, matching the JS `// ══` dividers. A section may carry a shared-concept breather hugged under the divider (a `/* */` line describing the model the rules assume).
- **Class naming** — name by role, not feature, so any panel can reuse a rule (`.tools-actions`, not `.tools-run-actions`).
- **Comments** — same discipline: rationale above / description inline, never column-align, document why and non-obvious only, present-state only (no history). The "teach something" test becomes: comment a rule only when the selector + properties don't already explain it (`.tools-dropdown.wide { width: 380px }` needs none; a non-obvious `min-height` that holds layout steady does).
- **Alignment** — data-as-table only (e.g. a column of compact single-line rules), never to pad unrelated declarations.

## JSON Schemas

`src/engine/schemas/*.schema.json` validate the authored data files and define each file's authoring language (shapes, types, enums, required/allowed keys). `README.md` is the canonical documentation of what each construct *means*; the schemas do not duplicate it. `scene.schema.json` is the reference implementation; new schemas follow it. The architecture is settled: change it only for a genuine design problem discovered while building a schema, never for refinement.

### Philosophy

- **Conventions exist to improve readability.** If following a convention would make a schema harder to understand, prefer the clearer structure and update the style guide if a new pattern emerges. The conventions serve readability, never the other way around.
- **Structure and vocabulary, not prose.** A contract is read as a table of keys, types, and enums: an author scanning it sees the entire authoring *surface* of a construct in one place, and looks to `README.md` for what each key means. Optimize the layout for the human reading the schema; the validator is satisfied either way.
- **Explicit contracts over clever abstraction.** Every object is closed (`additionalProperties: false`), so a valid key on the wrong construct is an error, not silence. Prefer a few duplicated lines over any indirection that makes a contract harder to read in place.
- **Draft-07, declarative only.** No ajv extensions, no schema generation from JS, no draft upgrades. Accepted consequence: `additionalProperties: false` cannot see through `$ref`/`allOf`, so contracts cannot compose shared field groups — each contract lists every key it allows. Duplication is the price of self-containment; pay it.
- **Structure only.** Schemas own shapes, types, enums, and required/allowed keys. Game semantics (cross-references, graph rules, auto-corrections) stay in the owning JS modules.
- **Formatting is free.** JSON imports minify in the build, and ajv compiles once at boot. Never trade readability for source bytes.
- **The schemas define a language.** Changes that cause previously-valid authoring data to become invalid are breaking changes to the Doodlejiggy authoring language and should be treated with appropriate care.

### Shared definitions

- A definition earns its place by naming a genuine engine concept — vocabulary enums (`direction`, `speechEffect`, `interaction`, `plane`), value shapes (`text`, `point`, `flagCondition`), reusable structures (`animBlock`). Never extract merely to deduplicate lines.
- A vocabulary definition is justified even when referenced once: the primitives block doubles as the file's glossary.
- Each schema file is self-contained — no cross-file `$ref`s; engine vocabulary is re-declared per file. Files are read and editor-mapped standalone.
- Nullable override variants (the `state` blocks in actors/objects) inline their null unions (`"enum": [..., null]`); they are a different type from the base concept and don't ref it.

### Structure and ordering

- Root schema first; everything else lives in `definitions`.
- Definitions order: **primitives first, alphabetized** (they have no inherent order, so the alphabet wins), then composite definitions grouped by concept in the order the data appears in the document. Everything after the primitives orders by meaning, never alphabetically: enum values in domain order, catalogs in enum order, properties in the semantic field order.
- **Discriminated unions** (script steps by `action`, triggers by `on`) use the dispatch + catalog pattern:
  - The outer definition validates only the discriminator: `required` plus a closed `enum`.
  - Dispatch is an `allOf` of one-line `if const → then $ref` rows in enum order, aligned on the `then` column, wrapped in `"if": { "required": ["<discriminator>"] }` so a missing discriminator yields one error instead of every branch's.
  - `if/then` dispatch, never `oneOf`: ajv emits errors only from the matched branch, which is what keeps the `schemas.js` formatter's output clean. `oneOf` floods allErrors output with const mismatches from every branch.
  - The catalog holds one contract per variant, in enum order, each self-contained: `additionalProperties: false`, its own `required` including the discriminator, and the discriminator re-declared as a `const` (a dispatch `then` cannot see outer properties; the const also names the contract's owner).

### Contract layout

- Frame line merged: `"type": "object", "additionalProperties": false, "required": [...],` on one line. An exactly-one-subject `oneOf` gets its own line after it.
- One property per line, names aligned as a table per contract (data read as rows — see § Code conventions on alignment).
- Field order is semantic and uniform across a catalog: discriminator → subject (actor/object/target) → payload → modifiers → timeout-style last-resort fields last. (Steps: `action → entity → payload → modifiers → timeout`; triggers: `on → run → filters → if/ifNot`.)
- Uniform block layout throughout: trivial contracts do not collapse to one line even when they would fit.

### Descriptions and comments

- No author-facing `description`. `README.md` is the single source of truth for authoring documentation (field semantics, defaults, units, blocking behavior, override and lifetime rules). Schemas exist for validation and editor completion, not for documenting engine behavior; a schema `description` would only duplicate the README and drift from it.
- `$comment` is contributor-facing and reserved for schema-maintainer rationale: why a construct is modeled a particular way (the dispatch shape, why `action`/`on` is re-declared as a `const`). It never restates engine behavior or authoring semantics. A `$comment` with no schema-modeling justification is removed, not rewritten. Authors never see it.

## Repository notes

- The project has no test suite.
- `originals/` holds source masters: icons, scenes, sprites, audio projects. Nothing in it ships or is read at runtime.
- `dist/` is build output. `node_modules/` and `package-lock.json` are not edited by hand.
