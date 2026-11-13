# Architecture

Design rationale, module ownership, dependency rules, and engine invariants. Engine behavior and authoring contracts live in `README.md`; contributor conventions in `CONTRIBUTING.md`.

## Design philosophy

The goal is an engine where each module can be read and understood on its own. Code should be clear enough that the next person (or your future self) can follow it without needing to reconstruct the reasoning. Modules have clear ownership: each one knows what it is responsible for and doesn't reach beyond that. Dependencies between modules are kept minimal and intentional.

When adding code, the useful questions are: does this belong where I'm putting it, or does it belong somewhere else? Does this new dependency make sense, or is it a sign the code is in the wrong place? Is this readable to someone who didn't write it?

**Module roles** and **Module dependencies** below document the current module structure and dependency graph. Treat them as a description of the current state, not a permanent constraint. If the engine needs to grow in a different direction, the structure should follow.

## Where values live: `config.js` vs `game.json` vs CSS

Three locations for non-code values. The right home is determined by *who edits it*, and each answers one question:

| Location | Audience | Examples |
|---|---|---|
| `config.js` | Engine author | *How does the engine behave?* Engine math and feel constants only: `world.height`, `targetFps`, camera tuning, speech timing math, scene fade duration, music volume, resource directory paths (`paths`), controls. No identity values and no visual defaults. Editing requires a code change and redeploy. |
| `data/game.json` | Game author | *What is this game?* Game-content values that vary per game without touching code: `scenes`, `start`, `player`, `messages` (voice), and `theme` (appearance) — the complete description of the game's visual identity (`colors`, `fonts`, `interface`, `speech`, `topics`, `verb`, `styles`), flat, in one block. |
| CSS variables (`ui.css` `:root`) | Themer / designer | Material presentation of the DOM interface that the theme does not name: inventory icon size, panel treatment, the text bump applied on touch. Author-editable tokens live in one `:root` block at the top of `ui.css` so the surface is discoverable in one place. |

The presentation modules complete the lens: they own *how Doodlejiggy draws* — the algorithms, the correctness guards (safe margins, outline minimums, clamp thresholds, legibility floors), and the engine **default** for each theme surface they draw. A default belongs to the module that draws its surface: canvas surfaces to the renderer, interface surfaces to the UI. Installing a theme merges game values over those defaults **at the vocabulary level** (named entries are atomic; no deep merge, no central `DEFAULT_GAME`, no schema default-injection), so every resolved store is complete by construction and authored data stays pristine — the tools read `game.json` directly and never see engine defaults fossilized into it. Every theme surface is open — games invent palette, font-role, and style names — with a minimal guaranteed vocabulary (`white`/`black`, the `dialog`/`solid` roles, the `default` style) that always resolves, because the engine itself renders through the guaranteed names. A renderer value promotes to `theme` when a real game wants it different, never speculatively; correctness guards never promote.

**When a value next wants to vary, apply the test before deciding:**
- *Engine math/feel?* → `config.js`.
- *Game visual identity?* → `game.json.theme` (subject to the promotion bar above).
- *Other game-author editable content?* → `game.json`.
- *Interface material the theme doesn't name (geometry, panel treatment, transitions)?* → CSS variable in `ui.css`.

The last test is about vocabulary rather than about canvas versus DOM. A value that names a font role or a palette key belongs to `theme` wherever it is painted, which is why the verb line and the topic list are theme surfaces even though the browser draws them; a gradient, a radius, or a breakpoint belongs to the stylesheet even though it is unmistakably visual.

Avoid adding new configurability without a concrete second use case. Single-value enums are documentation pretending to be config; multi-mode enums where only one mode is implemented are aspirational scope. The bar is **one field, two real modes, one branch**.

(The author-editable surfaces themselves are summarized in README § Authoring reference.)

## Core vocabulary

Four concepts carry most of the engine's naming. They nest, and each owns a distinct question. Before naming anything new, decide which one owns it.

| Concept | Owns | Contains |
|---|---|---|
| **Scene** | *What is authored here?* One authored document (`data/scenes/<name>.json`), rebuilt per load. | A world, portals, walkable areas, occluders, scaling poles, triggers, scripts, object placements, ambient barks |
| **World** | *Where can things be?* The playable coordinate space inside a scene. Every authored coordinate is a world coordinate. | `width` (per-scene, authored), `height` (uniform, `config.js`), `backdrop`, clear color |
| **Camera** | *What is on screen?* The horizontal-only transform from world coordinates to screen coordinates. | Scroll offset, follow target or fixed point, scroll bounds derived from the world's extent |
| **UI** | *What sits above the world?* Screen-space interface elements that do not scroll with the camera. | Inventory strip, verb line, dialogue topics, overlays |

The split that matters most is **scene vs. world**: a scene is content, a world is space. A backdrop is one possible visualization of a world, never its definition — which is why a world needs no artwork to be well-defined, and why width is authored rather than measured off an image.

Height sits in `config.js` and width in the scene file because they answer different questions: height is uniform engine geometry, width is per-scene content (see **Where values live** above). So "the world block" means the `CONFIG.world` block in code and the authored `world` block in a scene file; they are two halves of one concept.

## Data model

Companion to *Where values live*: that decides where a non-code value belongs; this decides what category a piece of data or state belongs to. Classify before adding: forcing everything into one shape is artificial symmetry, not consistency.

- **Definitions**: authored source, loaded once into the definition registries, read-only and shared by reference. Deep-frozen in dev builds so any accidental mutation throws at the source.
- **Entities**: live world instances (`actors[name]`, `objects[name]`; one per name). An instance is the **current live view**. Gameplay, rendering, interaction, UI, inventory and dialogue display consume **instance** values. Each instance carries a read-only `def` reference to its definition (`actor.def`, `obj.def`); read `.def` only for authored-source access (tooling, validation, reset-to-default, authoring inspection), never as the live gameplay value. An instance value can differ from its definition when the entity's current state overrides it: both objects and actors carry a state machine (see **Object resolution** below and README § Actor lifecycle / § Object lifecycle).

  Instance fields are of two kinds. Consumers needn't distinguish them; read both from the instance:
  - **Runtime simulation state**: `x`, `y`, `path`, `frame`, `state`.
  - **Engine-computed from authored data**: resolved fields, caches, precomputed geometry, loaded images. **Engine-owned**: gameplay treats them as read-only (a direct write is clobbered on the next resolve).
- **Progression state** is persistent runtime memory: gates spawning, drives triggers, drives dialogue progression, tracks ownership, stores object state overrides (which drive object field resolution).
- **Scene context** (rebuilt per scene load) is authored context: geometry, portals, triggers, ambient barks, script definitions.
- **Runtime sessions** execute/play authored content: active dialogue (singleton) and running scripts (concurrent pool).
- **Transient engine state** sits outside the content model: camera, hover, input, render bookkeeping, animation timers, reveal coordination.
- **Projections** are transient on-demand views, not stored entities: portal-exit probes, inventory item views.

Categories **compose**: an object's live value joins its definition with its progression-stored state override; a dialogue spans a transient session plus persistent greeted/unlock memory.

**Identity vs. instance: the player.** Progression is keyed by identity; simulation operates on instances. Like all runtime entities, the player has a live instance, but unlike other actors it also has a globally configured identity: `state.js` owns that identity ("which authored actor is the player", set once at boot from `game.json`), and `scene.js` owns the live runtime player instance, maintained by `spawnActor()`/`despawnActor()` and legitimately `null` when no player actor is currently spawned. Inventory, object ownership, and save progression survive despawn and respawn because they are keyed by the identity, never by the instance.

**Handles vs. verbs.** State APIs take one of two shapes. A **handle** is something a caller naturally keeps and uses repeatedly, such as a live entity instance or a running script. A **verb** is a one-shot operation: it may update several fields, but the caller holds nothing afterward (`giveObject`, `spawnObjectAt`). Design signal: if callers repeatedly pass the same thing into related functions, ask whether that thing deserves a handle. Never introduce a handle for symmetry alone. A group of related functions is not an identity.

**Resolution invariant (load-bearing).** Entity *state* is the only input to field resolution; the instance is a cache refreshed on state change. Objects resolve against the saved state; actors resolve against the live instance state, which may be a transient override. Expanding the resolver's input set (a field conditioned on a flag, inventory, or time) is a major architectural decision, not a small feature: resolver inputs and the re-resolution trigger are a coupled pair and must move together. Expanding inputs without expanding the trigger is the silent-stale-value bug.

### Entity model — why two types

README § Core concepts → Entities documents the capability table actors and objects expose. Why not one type: roughly half those capabilities are mutually exclusive (a fireplace never pathfinds; a key is never talked to), so merging would force every instance to carry inapplicable fields plus guards: *more* complexity, not less. The state machine is a shared sub-feature; the archetypes stay distinct.

## Module roles

Engine modules first, then dev-only tooling; alphabetical within each group.

| Module | Owns | Lifetime |
|--------|------|----------|
| `actors.js` | `actorRegistry`: the library of actor definitions, plus the actor semantic validation no schema can express (`initialState` naming a declared state, spriteful states deriving a sprite grid; structure lives in `schemas/`) | Loaded once at boot, never cleared |
| `audio.js` | Game music policy over `synth.js`: named-track playback, idempotency, the transient model, and audio-unlock queueing. Holds no TinySynth knowledge | Persistent |
| `camera.js` | How the world is viewed: the scroll offset and its bounds, the follow and fixed-point targeting modes, and the world layer's scroll transform | Persistent (reset to follow the player on every scene enter) |
| `crossref.js` | The authored dependency graph: pure name-level queries over scenes and scripts, answering what content references which definitions (consumed by scene preloading and the authoring tools) | Stateless |
| `dialogues.js` | Pure schema/domain layer: dialogue-definition registry, plus dialogue *semantic* validation (topic graph; structure lives in `schemas/`) | Loaded once at boot, never cleared |
| `game.js` | Runtime entry: game loop, interaction/hover semantics, engine system wiring | Persistent |
| `geometry.js` | Pure spatial math: coordinate conversion, polygon math, sprite dimensions, scalar/scale helpers | Stateless |
| `input.js` | Device input layer: translates raw pointer / touch / keyboard input into semantic intents; owns scan mode (no engine knowledge) | Persistent |
| `interaction.js` | Semantic interaction dispatch and walk-then-interact sequencing | Persistent (transient pending state cleared on scene change) |
| `narrative.js` | Transient runtime presentation state: the overlay (singleton, with its transition timeline), ambient barks, and topic-based dialogue mode | Persistent (bark schedules rebuild per scene; active dialogue and the overlay are transient) |
| `objects.js` | Pure schema/domain layer: object registry, sprite-sheet grid math, semantic validation (structure lives in `schemas/`) | Loaded once at boot, never cleared |
| `pathfinding.js` | Walkable-area navigation and reachability math | Stateless |
| `random.js` | Shared randomness primitives; code needing generic random operations calls it rather than `Math.random()` directly | Stateless |
| `registries.js` | Authored content loading: sole owner of the data files under `CONFIG.paths.data`. Provides the game and scene definitions callers ask for by name, plus the actor/object/dialogue registries coordinated to readiness. Never interprets what the data means | Registries load once at startup; definitions load on demand |
| `render.js` | Canvas presentation: canvas elements, drawing utilities, and renderer-owned theme defaults | Persistent |
| `scene.js` | All scene-local state: actors, objects, the live player instance, portals, speech, scripts, and the scene-trigger vocabulary | Cleared and repopulated on every scene load |
| `schemas.js` | JSON Schema documents compiled by ajv: runtime structural validation of every data file, reused to validate the debug runner's ad-hoc scripts | Compiled once, on first use |
| `script.js` | Authored sequence execution and script lifecycle | Per-running-script |
| `sprites.js` | Shared Image cache and preload coordination | Persistent across the session; never cleared |
| `state.js` | Global flags, inventory ownership, dialogue progression, save persistence, and the configured player identity (boot-set, not persisted) | Persistent across sessions via localStorage (dev builds only, gated on `import.meta.env.DEV`) |
| `synth.js` | Sole owner of the embedded WebAudio synth (TinySynth) and its AudioContext; consumers drive it through neutral verbs and never touch TinySynth | Persistent (lazy per-page instance, built on first use) |
| `ui.js` | Screen-space DOM presentation: inventory strip, verb line, dialogue topic menu, drag ghost, and UI-owned theme defaults; display + gesture layer (state pushed in, intents emitted out) | Persistent |
| `world.js` | The playable coordinate space: the `#world`/`#backdrop` layer, the authored extent and clear color, walkable areas, occluders, and depth-scale resolution | Cleared and repopulated on every scene load |
| `debug.js` | Debug toolbar overlaid on the running game: per-layer geometry overlays, live state panels, and an ad-hoc script runner (README § Debug Mode) | Dev only (composed onto the engine by `index.html` under `import.meta.env.DEV`) |
| `design.js` | Standalone scene editor: walkable/occluder polygons, portals (entries + exits), scaling lines, object placement (sprite + hotspot), download | Loaded via `design.html` only; no game runs alongside it |
| `midi.js` | Standalone MIDI Studio: Web MIDI input + toolbar UI; forwards raw MIDI to `synth.js` so a keyboard or Pro Tools (via IAC) plays through the game's exact synth for auditioning | Loaded via `midi.html` only; no game runs alongside it |
| `tools/` framework (`studio`, `toolbar`, `picker`, `shortcuts`, `drawing`, `modal`, `persist`) | Dev-tool UI framework: Studio host + declarative toolbar/picker/shortcut builders, canvas overlays, modal dialogs, localStorage wrappers | Tool-only; never imported by engine modules |

## Module dependencies

Imports flow in one direction; the layering is the architecture, not the specific edges (which the source owns and the **Module roles** table already attributes). Three layers:

- **Shared leaf modules** provide reusable functionality with no engine or tooling knowledge.
- **Engine modules** build the runtime and may depend on shared modules, but never on tooling.
- **Tooling modules** build on the engine to provide development and authoring functionality.

Two rules hold this together:

- **The engine never imports tooling.** Dependencies point downward only (shared, then engine, then tooling), so every module below the engine is understandable in isolation and the dependency graph stays acyclic. The debug overlay observes engine state through live ES module bindings and an exposed render seam (see **Platform / runtime notes**); the engine never references it back.
- **HTML entry points are the composition roots.** `index.html` boots the engine and, in dev only, attaches the debug overlay; `design.html` and `midi.html` each load a single standalone tool. The wiring that connects modules lives at these roots, not inside the modules. Only `index.html` is built for production (README § Deployment).

Data validation is split by kind. **Structure** (required/allowed fields, types, enums, text shape, typos) is declared in JSON Schema documents and checked by `registries.js` as each data file loads: at boot for the registries and game config, on every scene load for scenes. **Semantics** that no schema can express (cross-registry references, graph cycles, no-op conditions) stay in the owning module. Authored data is loaded and validated before the world starts. The same schemas drive author-time validation in VS Code via `.vscode/settings.json`.

Game state is independent of rendering: `scene.js` doesn't know how the scene is drawn. Side effects that need other modules (e.g. cleanup when the scene hides) are exposed as seams and wired by `game.js`, the single orchestrator, at composition time; scripting side effects follow the same pattern. (Scene visibility itself is deliberately not a seam: the scene owns its own layer and fades it directly; see **Rendering internals**.)

**Authored names stay symbolic until they bind.** Palette keys, font roles, style names, and asset references remain symbolic until the module that owns them resolves them. Ownership determines binding time: presentation chosen at install binds then, while presentation chosen as part of rendering binds at draw time.

`geometry.js` is the single source of spatial math shared by the renderer and the tools: polygon drawing and outlines, actor-versus-occluder tests, the near/far depth-scale lerp, and sprite-bounds resolution. Single-sourcing it is what keeps game and tools from drifting, so the box the design tool draws, the depth scale it previews, and the hit area the runtime tests are all computed by the same code. The offset- and scale-adjusted sprite bounds are the shared rule for where a sprite is drawn (README § `data/actors.json`, `offsetX`/`offsetY`). The same single-sourcing covers sprite-sheet grid math: runtime rendering, debug overlays, and the design tool all compute sprite dimensions from one shared layer.

`interaction.js` is the dispatcher between input and authored content. It owns the four canonical verbs (`look`, `pickup`, `use`, `talk`), the walk-then-interact polling, and the semantic fallback selection. For `talk` it resolves the actor's response: a `dialogue` is delegated to the dialogue runtime via an injected handler (so this module never imports `narrative.js`), while a `talkText` line is spoken directly. It does not own scene state, scripts, persistence, dialogue mode, or UI; it composes them. The module header carries an explicit anti-drift rule list to keep it from absorbing gameplay logic over time. See `interaction.js` for the boundary statement.

The runtime splits the scene along ownership lines, so each module answers one question. `world.js` owns *where things exist*: the coordinate space, its extent and geometry, and the depth scale resolved against it. It knows nothing of what lives in that space. `scene.js` owns *what happens in it*: entities, portals, triggers, and the scene lifecycle. `camera.js` owns *how it is viewed*. The camera depends on the scene because a viewer depends on what it views; the scene has no dependency on the camera at all, and the camera's reactions to scene lifecycle are wired at composition time like any other seam. Keeping that direction one-way is what puts camera state in exactly one module. `scene.js` remains the only module with broad knowledge of the active scene; everything below it is reusable in isolation.

## Rendering internals

Actors and objects render through one shared draw path and one combined y-sort pass, so depth ordering between them is automatic. That order comes from a single shared list (`entitiesInDrawOrder`), the same list the interaction picker walks — which is what implements the guarantee README § Interaction model documents: what draws on top is exactly what a hover or click resolves to. Hover and scan overlays render after the y-sort pass and before speech. Both draw on the **world canvas**, which lives inside `#app` alongside the `#world` layer.

**The world is the geometry authority.** `#world` is a DOM layer whose on-screen rect defines that coordinate space: every screen↔native conversion, the camera's scroll bound, and the depth scale all read it. `world.js` owns the layer and is the single place that measures it. That measurement already accounts for the camera's scroll, so no consumer composes world position and camera offset by hand. Its extent is authored (README § Scenes and coordinates), not inherited from an asset, so a scene needs no artwork to have a well-defined world. The `#backdrop` image sits inside it and is clipped by it; the world canvas spans the viewport and clips to the same rect when drawing, so DOM and canvas layers agree on where the world ends.

**Scene fade.** Transitions fade `#app` as a group: the `#world` layer and the world canvas composite opaquely against each other first, then the flattened picture's opacity fades (CSS `transition` on `#app`, duration from `--dj-scene-fade`). Fading the two layers independently would let the backdrop show through actors mid-fade (a translucent "glow"), so neither layer fades on its own: the old scene fades out as one picture, then the new one fades in as one. The UI (on `document.body`) is outside `#app` and does not fade; it stays *veiled* (dimmed via the interaction lock) across the whole transition instead.

**Overlay.** The overlay (`showOverlay`/`dismiss`) renders on its own canvas on `document.body`, above the `#app` group. Keeping it out of the faded group lets a veil transition in while the scene underneath is still hidden: the overlay-first masking on scene enter, where the scene snaps visible under the full-alpha veil rather than racing a fade-in. The overlay canvas sits above world, speech, and debug overlays (the world and debug canvases, both inside `#app`). Its invariants:

1. **An overlay is a presentation layer over the world, never a world state.** Setting one changes nothing in the simulation; clearing one restores nothing.
2. **Overlays do not pause simulation.** Actors walk, animations play, objects spawn, concurrent scripts execute — under veiled and unveiled overlays alike.
3. **Overlays do not own concurrency.** Every overlay action blocks its own script only; parallelism is expressed with concurrent scripts.
4. **An overlay is not a cutscene.** Overlays never block player input by themselves; input control belongs exclusively to `cutscene: true`.
5. **At most one overlay exists, and the most recent overlay command is always authoritative**: replacement and dismissal take effect immediately at any lifecycle point, with no queueing and no completing of previous timelines. Within one script, blocking makes overlay commands strictly sequential; interruption comes only from outside the timeline's script. Interrupted transitions continue from the overlay's current appearance, never snapping brighter.
6. **Crossfade never exposes the world between two veiled overlays**: the outgoing appearance dissolves over the fully-rendered incoming overlay. Fade deliberately enters from the world. Veil continuity is authored (use `crossfade`), not automatic.

The overlay system deliberately does not become a layout engine (one implicit vertical stack aligned on a 3×3 grid, uniform accumulating margins, and overlay offsets — no coordinates, padding, anchors, collapsing rules, or multiple positioned groups), a styling language (the seven-field typography contract is closed: choose a font, don't transform a font), a timeline/keyframe system (one overlay, one transition at a time), a menu (interactive selection is the dialogue-topic overlay's territory), or world-attached rendering (speech bubbles and scan markers track entities; overlays never do).

**Size resolution.** `worldSpriteSize` (geometry.js) is the canonical size resolver, used identically by runtime rendering, debug overlays, and design-mode previews, so the box drawn in the design tool matches what the game renders. `entityScale(entity)` (`world.js`) resolves the final depth scale for any entity and is the single authority every scale-dependent subsystem reads: render size, hit region, speech and scan-marker anchors, and walk pace. README § Scene scaling and entity size documents the sizing rules both implement.

**Presentation ownership.** Presentation is split by *where it is presented*, not by whether it feels like UI. `render.js` owns **world-space presentation**: everything drawn into the world canvas, in world coordinates, positioned against entities and the room. Sprites, speech, and scan markers all live there. `ui.js` owns **screen-space interface presentation**: the interface elements the player sees at screen scale, expressed as DOM and CSS. The inventory strip, verb line, dialogue topics, drag ghost, and the mouse cursor all live there.

The scan marker and the cursor make the line concrete. Both are themed interface artwork and both mark "something is actionable", yet they have different owners: a scan marker is painted at an entity's centre in the world and moves with the camera, while the cursor sits at the pointer and has no world position at all. Asking "is this UI?" would group them together and be wrong. Asking "is this drawn into the world?" separates them correctly.

**CSS ownership.** CSS is split by owner: **`base.css`** (linked from every HTML entry: font declarations, global reset, `html`/`body` sizing, `#app`/`#world`/`#backdrop` layout); **`ui.css`** (imported by `ui.js` only: inventory strip, verb line, dialogue topics, drag ghost, the cursor); **`tools.css`** (imported by `debug.js` / `design.js` / `midi.js` only, never in production). `ui.css` receives resolved theme values and owns the material around them: layout, responsive bounds, panel treatment, and transitions. For viewport / iOS handling (`--vh`, `visualViewport`, pinch-zoom), see **Platform / runtime notes**.

## Runtime internals

**Sprite preloading.** The preload contract (every entity born sprite-complete, no decode gap on state swaps) lives in README § Object lifecycle. Scope discipline: only content the scene brings IN is preloaded (`provides` references, in crossref's vocabulary); `requires` references (`setObjectState` / `removeObject` targets) name content assumed already present and are not preloaded, and control flow and cross-scene refs are never chased.

**Object resolution.** Field resolution works with or without a live instance: inventory items (which have no instance) resolve straight from the definition plus saved state, while a live instance mirrors the resolved values onto itself as a cache for the render and input loops. Both views refresh through the same state-change path (README § Object state machine), so they cannot diverge.

**Interaction lifecycle.** A player interaction runs through fixed stages: approach → engage → resolve → execute. `engage` is the first and only public pre-resolution stage: a scene trigger that fires the moment the player has reached an interaction target (object, actor, or portal exit), however the interaction was initiated — direct click or inventory use-on. A matching trigger replaces the entire resolution phase; `resolve` and `execute` stay engine-internal. Two rules keep the stage honest:

- **Every approach-then-interact pipeline fires `engage` immediately after arrival and before resolution.** This is convention-enforced across the dispatch paths in `interaction.js`; a new pipeline must fire it too. Inventory icon look has no approach phase, so it never engages.
- **An exit's `blocked` clause is part of resolution.** It is declarative convenience for the common refuse-with-message case; `engage` is the general interception mechanism and runs first. `blocked` stays message-only — behavior belongs in `engage` triggers, so the two mechanisms never grow into competitors.

The engine exposes no other pre-resolution stages, and shouldn't without a compelling architectural reason: `engage`'s value is being the single named seam in an otherwise internal pipeline.

**Dialogue ownership (three tiers).**
- `dialogues.js`: pure registry of dialogue definitions (`data/dialogues.json`) + boot validation. Peer of `actors.js`/`objects.js`.
- `narrative.js`: the transient runtime (active dialogue, dialogue mode, topic-visibility computation, beat playback). Reuses the shared speech pipeline.
- `state.js`: persistent progression (per-actor-dialogue `unlocked`/`removed`/`greeted`).

**Dialogue speech is owned speech.** Topic lines count as owned speech — they suppress ambient barks and gate input the same way scripted lines do — without being a real script: their clearing is driven by the dialogue runtime, never by `stopScript`. `isDialogueModeActive()` is a distinct signal (it spans the topic-selection gaps between lines) and feeds the interaction lock; both are needed.

**Script engine composition.** `script.js` knows nothing about actors, rendering, or scenes. Side-effecting actions (`say`, `spawnActor`, `changeScene`, etc.) are delegated outward — their world effects are supplied at composition time — while the scripting engine owns step sequencing and the timing of blocking actions (`wait`, `say`, `walkTo`).

## Persistence atomicity model

README § Save system documents the author-facing atomicity rule; this is the underlying model.

**The model.** Engine events (object pickups, looks, scene/actor lifecycle events, use-on) execute their trigger cascades synchronously until the first blocking action. Everything within an execution unit is persisted as one write at the unit's end.

**Atomic groups, not scripts.** A single script can belong to multiple atomic groups over its lifetime. Each blocking action is a boundary; the steps before the next blocking action form the next atomic group:

```
setFlag A         ╮
                  ├─ atomic group 1 (with triggering event)
                  ╯
say               ─── boundary
setFlag B         ╮
                  ├─ atomic group 2 (resumes after the say)
                  ╯
wait              ─── boundary
setFlag C         ─── atomic group 3
```

**Cascades.** Triggers firing triggers are part of the same execution unit, recursively. A `spawnActor` step that fires an `actorEnter` trigger whose script does `setFlag` lands all of those mutations in the same atomic group, up to the first blocking action *anywhere* in the chain.

**Implementation.** The model has two halves. `script.js` owns execution: it runs each queued script's steps until one yields at a blocking action. `state.js` owns persistence: every mutation marks the save dirty, and a single flush is coalesced per JS turn, so one execution unit becomes one write. The blocking taxonomy lives in `ACTION_DEFS` (`script.js`), each entry carrying its `blocking` field inline (validated at boot).

**Non-guarantees.** Mid-turn browser crashes can lose the current execution unit's writes (but never split a unit). Previous units are durable. There is no `beforeunload` flush; the guarantee stands purely on execution-unit boundaries.

**Rules for adding new script actions.**

- **Every script action must be classified as blocking or non-blocking.** Blocking refers to whether script execution waits, not whether side effects continue over time. `playAnimation` is non-blocking (the animation plays on its own clock; the script continues). `walkTo` is blocking (the script waits for arrival). A new `cameraPan` could be either: the author of the action must decide and set the `blocking` field when adding the entry to `ACTION_DEFS`. The field is validated at boot; a missing classification is a `console.error`.
- **The schema and `ACTION_DEFS` must stay in sync: two edits per new action.** `ACTION_DEFS` (in `script.js`) governs runtime execution (blocking classification); the action enum in `scene.schema.json` governs author-time/load-time structure validation. They are independent lists with no cross-check, so a new action needs both: (1) add the name to the `step.action` enum, and (2) add an `if`/`then` block to the step's `allOf` declaring that action's required keys (e.g. `setObjectState` requires `object` + `state`). Group an action into an existing `if` only when its required-set is identical. Without the enum entry, valid scripts using the action warn as "not in enum"; without the required-keys block, a misrouted key (`actor` where `object` was meant) passes silently instead of surfacing as a missing-required warning. Actions whose required keys can't be expressed as a fixed set (e.g. `waitForAnimation`, which accepts `actor` *or* `object`) are intentionally omitted from `allOf`.
- **Handlers must be fully synchronous.** Async side effects (Promises, `setTimeout` mutations) break the execution-unit model: the side effect lands in a later turn, separated from the trigger by a yield. If you need async-feeling behavior, model it as blocking and return a completion-check function from the handler (the pattern used by `walkTo`, `spawnActor` walk-ins, `waitForInput`).

## Tooling framework

`src/tools/` is a small, dev-only UI framework for the authoring tools; it never enters the production bundle. Three layers, imports flowing strictly downward:

- **Leaves**: `persist.js` (localStorage), `drawing.js` (canvas overlays + the layer palette), `modal.js` (native `<dialog>` wrapper).
- **Descriptor layer** (`toolbar.js`, `picker.js`, `shortcuts.js`): each builds its UI from a declarative spec and returns a handle for live updates. No layer module imports another; the consumer composes them.
- **Host** (`studio.js`): `createStudio` builds a standalone tool page from one descriptor (`actions` plus `toolbar` / `pickers` / `shortcuts`), owns the content region, and offers an opt-in canvas.

**Studios vs Debug Mode.** Design and MIDI are **Studios**: standalone pages (`design.html`, `midi.html`) built with `createStudio`. Debug is a **hosted mode** overlaid on the running game; it composes the same descriptor-layer modules directly instead of a Studio. Either way a tool file reads the same: `State → Actions → Toolbar → Pickers → Shortcuts → Composition → tool logic`.

**Contracts.** A concept lives in the framework only if it is independent of any single tool; tool-specific logic stays in its tool (Design's editor, MIDI's status panel). Tools declare structure as data and keep behavior in their own handlers. The framework favors simple composition over framework-managed state.

**Tools consume engine concepts, not engine storage.** Both tools read authored content through `registries.js`, so neither names a data file, constructs a path, parses JSON, or runs a schema itself. They do understand the authoring language they present (a scene's geometry, placements, and portals): that is the vocabulary they exist to edit. Where it is stored and how it arrives is not theirs to know.

**Design Studio's import boundary.** Design Studio imports only from shared/pure modules (`config`, `geometry`, `objects`, `sprites`, `registries`, `crossref`, the tooling framework, `tools.css`), and builds its ownership/usage view through `crossref.js`'s cross-reference index. It never imports from `game.js`, `scene.js`, `render.js`, or any other engine module. No game runs alongside it.

## Platform / runtime notes

These are non-obvious but load-bearing: they exist because a specific bug forced them and removing them silently regresses.

**`index.html` is the composition root; the engine has no tooling knowledge.** The page boots the engine and, in dev only, composes the debug overlay onto it; production builds exclude the tooling entirely. The engine's only concession is a generic render hook the overlay attaches to — attaching late is safe (early frames simply omit the overlay), and nothing in the engine references tools. There is no global debug surface: the overlay observes engine state directly as live ES module bindings.

**The tool pages are dev-server only.** `design.html` and `midi.html` each load a single standalone tool: no `game.js`, no game loop. They're intentionally excluded from production builds: the development server serves them, but production bundles only the engine entry point, so nothing in `src/tools/` reaches `dist/`. `base.css` is linked from each HTML entry (parallel critical-path load) rather than imported via JS.

**`--vh` is a JS-managed CSS variable.** `height: 100dvh` doesn't update correctly on iOS 15 after orientation changes. The game uses `calc(var(--vh, 1vh) * 100)` instead and updates `--vh` from JavaScript on every resize and after a short orientation-change settle delay (iOS needs settling time before layout is trustworthy). Every page that links `base.css` depends on `--vh` and must manage it the same way; the tool pages do.

**The canvas is positioned and sized via `visualViewport`.** On iOS, pinch-zoom shifts the visual viewport relative to the layout viewport, breaking coordinate conversion. Sizing the canvas to `visualViewport` keeps screen↔native coordinate math correct even when the user has zoomed in.

**`segmentsIntersect` intentionally uses a small non-zero epsilon.** It avoids floating-point precision issues around shared polygon vertices. The current value has been tuned for the engine's coordinate system; changing it can cause occluder overlap checks (`polygonsAtSegment`) to misclassify polygons.
