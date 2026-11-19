---
name: dedalo-ts-extension
description: >-
  How to EXTEND the Dédalo v7 TypeScript/Bun engine the descriptor-shaped way — add a component model, a tool, or an area without scattering edits. Use when adding or editing a component model (src/core/components/component_<model>/descriptor.ts + registry.ts), when descriptor_completeness_tripwire.test.ts or import_scc_tripwire.test.ts FAILS, when asking "why do I have to edit N files to add a model", when wiring emitHook / searchBuilder / resolveData / flatValue / importConform / importValueProperty / targetSource / monovalue / render / sortable facets, when adding a new cross-subsystem lookup and hitting a static-import cycle (SCC of size >1), or when adding a tool (src/core/tools/) or an area / maintenance widget. Names: ComponentModel, getComponentModel, registerComponentModelFieldsLookup, RESOLVER_IMPLEMENTATIONS, EMIT_HOOKS, IMPORT_CONFORM, getFlatValueFamily. Checklist lives in src/core/components/README.md.
---

# Dédalo v7 — extending the engine (TypeScript)

The engine is **ontology-driven**: the component `model` (`component_input_text`,
`component_portal`, …) is the atom. Resolution is horizontal — it lives in the
engines (`resolve/`, `search/`, `relations/`, `section/`) that dispatch on the
`model` string. To keep that dispatch from being a scatter of private lookup
tables, every model has a **named home**: `src/core/components/component_<model>/`
holding a `descriptor.ts` (and usually a `samples/` reference set). This skill is
orientation for extending the engine; the mechanical steps are the checklist that
already lives in the code — do not duplicate it, follow it.

## The load-bearing rule

**Adding a component model is a DESCRIPTOR + REGISTRY change, declared — not a
scatter of engine edits. But that is a GOAL the code only partly reaches, and
lying about the gap is the failure mode.** Descriptors route: column/alias
resolution, translation gating, relation read + relation-search dispatch,
default relation type, the non-relation SQO builder family, CSV import
(parser + value-property wrapping), the flat display-value family, emit-time
particularities, default target source, list sortability, the monovalue value
law, and the client render class. The 2026-07 audit (**S2-26**) found the
"nothing else in the engines changes" claim **overstated**, converted the
routable branches into descriptor facets, and installed a tripwire so the claim
can no longer rot. The few branches that are STILL engine-side are named in the
checklist's "Engine side" steps.

**The authoritative checklist is `src/core/components/README.md` ("Adding a
component model — the HONEST checklist").** Read it and the interface in
`src/core/components/types.ts` before writing a descriptor. Read a real one first:
`component_input_text/descriptor.ts` (scalar) and `component_portal/descriptor.ts`
(relation) are the two canonical shapes. Manual page:
`docs/development/extending/add_a_component.md`.

## The descriptor facets (what you DECLARE)

A `ComponentModel` (`src/core/components/types.ts`) is **declarative** — small data
+ IDs naming behavior, never inline logic (or it rots into a god-registry). The
facets, each read by an engine accessor in `registry.ts`:

- `column` / `alias` — storage + column resolution (`getColumnNameByModel`,
  `getModelByTipo`). Every descriptor MUST name one — the tripwire checks it.
- `classSupportsTranslation` — read-time lang filtering gate.
- `resolveData` (relation models) — a `RelationResolverId` **string**
  (`'portal' | 'filter' | 'select_family' | 'relation_children' | 'relation_index'
  | 'relation_related'`), resolved by `relations/registry.ts`
  `RESOLVER_IMPLEMENTATIONS`. It is DATA, not a function ref — that is what keeps
  `components/` from importing `relations/` (see the SCC rule below).
- `search` — `{status:'ported'}` or `{status:'unported', reason}`; unported makes
  `search/conform.ts` throw loudly instead of silently mis-searching.
- `defaultRelationType` — the class-level relation type fallback.
- `searchBuilder` (non-relation searchable) — a `SearchBuilderFamily`
  (`'string'|'number'|'date'|'iri'|'section_id'|'json'`); without it SQO searches
  on the model throw in `conform.ts`.
- `importConform` — an `ImportConformId` naming the model's CSV cell parser in
  `src/core/tools/import_conform.ts` `IMPORT_CONFORM`. It OWNS the cell first
  (`import_data.ts`); omitted = a flat cell is refused (JSON cells still
  round-trip). Every relation-column model must declare it.
- `importValueProperty: true` — when no `importConform` owns the cell, bare cells
  import as `{value:…}` items, not raw strings. `import_data.ts` derives
  `VALUE_PROPERTY_MODELS` from the facet directly.
- `flatValue` — a `FlatValueFamily` (`'string'|'datalist'|'section_id'|'date'|'iri'|'media'|'external'`),
  the flat display-value family read by `getFlatValueFamily` (grid cells in
  `resolve/relation_list.ts`, export atoms). Omitted = the consumers ledger the
  cell unresolved, never a guessed string.
- `emitHook` (an `EmitHookId`) — an emit-time particularity; implementation goes
  in `components/emit_hooks.ts` `EMIT_HOOKS`. This **replaced the old
  out-param + WeakSet emit protocol** (WS-C / **S2-24**); `section/read.ts`
  `emitDdoData` keeps exactly ONE inline per-TIPO transform (dd546), because a
  per-tipo rule has no per-MODEL home. `emitHook: 'external'` defines the
  derived (no stored value) family — see the README step 8 consequences.
- `targetSource` (a `TargetSourceId`) — the default options source when a node's
  own sqo resolves no target; bound in `relations/request_config/target_sources.ts`.
- `fixedDataframeTipos` — frames a model always pairs with (e.g.
  `component_iri`'s dd560).
- `sortable` — `false` only on canonical non-sortable models (omitted = true);
  pinned by `test/parity/list_column_sortable_differential.test.ts`.
- `monovalue: true` — only element 0 is ever read; THE value law every writer
  consults via `isMonovalueModel`; pinned by `value_law_agreement_tripwire`.
- `render` — `'text'|'html'|'url'|'number'`, REQUIRED on every column-bearing
  descriptor: what the client may do with the value at the DOM boundary
  (`'html'` also arms the save-time sanitizer). Stamped on the wire as
  `render_class`.

Then register it: add the import + array entry in `src/core/components/registry.ts`.
A malformed descriptor or dangling alias fails the **load-time coverage check** at
boot; `test/unit/component_registry.test.ts` pins registry/table equivalence.

## Why the tripwire exists (the audit's central lesson)

The audit's finding: **every invariant enforced only by prose was violated in
practice; every tripwired boundary held.** Rule: *tripwire or delete.* Two guard
extension:

- **`test/unit/descriptor_completeness_tripwire.test.ts` (S2-26/DEC-12)** — FAILS
  if a registered model omits a required facet: no storage route; a relation model
  missing its relation face (or its `importConform`); a facet on the wrong column;
  an unbound `targetSource`; a column-bearing model with no `render`; a
  non-relation model that made no explicit search decision (declare
  `searchBuilder` or appear in the ledgered unsearchable set); or a descriptor
  edit that silently changes the derived CSV-import / propagate engine sets (the
  diff shows here). **What breaks without it:** a new model that silently resolves
  as `null`, mis-searches, or imports as raw strings — the exact scatter this
  design exists to kill. Its allowlists may only SHRINK, cleared by the commit
  that ports the missing behavior.

- **`test/unit/import_scc_tripwire.test.ts` (S2-20)** — FAILS on any static
  value-import strongly-connected component of size >1 (allowlist currently EMPTY).
  The audit found a **33-file cycle** fusing six subsystems; a single review-invisible
  module-level constant computed from a cyclic binding **can throw at ESM boot for
  some import orders only**. It was dissolved by breaking its two closing edges — and
  those two inversions are the PATTERN you must follow for any new cross-subsystem
  lookup:
  1. `ontology/resolver.ts → components/registry.ts` inverted to a **boot-time
     registration**: `registerComponentModelFieldsLookup` (resolver does NOT import
     the registry statically; the registry registers a callback into it at boot).
  2. `descriptors → relations/models/*` replaced by the **DATA binding**
     (`resolveData` is a string ID, resolved in `relations/registry.ts`).

  **If you trip it:** do not allowlist first. Break the cycle — a registration seam,
  a data binding (string ID + a resolve table), or a `import type` (type-only edges
  are excluded). Allowlist only a genuinely irreducible knot, as a named+sorted
  member list with a written justification.

## Adding a new cross-subsystem lookup — follow the inversion

Need engine A to consult a table owned by engine B, and a static import would close
a cycle? **Register a callback at boot, don't add the static import.** Copy
`registerComponentModelFieldsLookup` (the `cache_invalidation.ts` registration
pattern): B exposes a `registerXLookup(fn)`; whoever owns the data calls it once at
module init; A calls the registered fn at runtime. This keeps the static import
graph acyclic and the SCC tripwire green.

## Adding a tool

**Creating or adapting a tool is its own skill: `dedalo-tools-ts`** (registration,
permission kinds, client traps, phone contract, done-checklist). The framework
map, for orientation:

The tool framework is native TS under `src/core/tools/` — dispatch + gates in
`dispatch.ts` (Gate 6 = the per-module `apiActions` allowlist, the API_ACTIONS
successor), the module shape in `module.ts`, schema in `register_schema.ts`,
ontology constants in `ontology_map.ts`, discovery in `loader.ts`. Tool code lives
under `tools/tool_<name>/server/`. Manual (tool_paths, `register.json` format,
security/`apiActions`, the server contract):
`docs/development/tools/creating_tools.md`, `docs/development/tools/register_json.md`,
`docs/development/tools/security.md`, `docs/development/tools/server_contract.md`.

## Adding an area or a maintenance widget

An "area" is an ontology model with NO matrix row (`src/core/area/`); manual:
`docs/development/extending/add_an_area.md`. Only `area_maintenance` has a widget
framework: ONE module per widget under `src/core/area_maintenance/widgets/`
(exporting a `WidgetModule`) + ONE import line in `widgets/registry.ts`, which
builds the dashboard catalog and the `widget_request` / `get_widget_value`
dispatch (each module's explicit `apiActions` registry). The client↔server
`get_value` pairing is gated by `test/unit/maintenance_widget_get_value_tripwire.test.ts`.
Manual: `docs/development/extending/add_a_widget.md`.

Core code reaches the diffusion subsystem only through its facade,
`src/diffusion/api/` — grandfathered internal imports may only shrink
(`test/unit/boundary_seam_tripwire.test.ts`); dependency direction is
`test/unit/diffusion_boundaries.test.ts`.

## Verifying an extension

TS is the single engine; there is no live oracle to diff against. An extension is
done when:
- the structural gates are green — `descriptor_completeness_tripwire`,
  `import_scc_tripwire`, `component_registry.test.ts`, and the facet-specific
  tripwires named above;
- its behaviour has a **TS-native gate** (`test/unit/*_native.test.ts`) that
  BUILDS its situation on the generic `test` TLD in the suite DB (never an
  install's TLD) — see the **`dedalo-ts-testing`** skill;
- a deliberate wire change carries its `engineering/wire_contract/` entry the
  same day;
- the client renders it. `client/` is the TS-owned primary client source — edit
  it directly; the gates are `test/unit/client_serving.test.ts` (serving
  self-consistency) and `bun run test:client`. When a widget renders blank, fix
  the server payload first. Browser debugging: **`dedalo-parity-debugging`**
  (Chrome-DevTools-MCP against our own server); relational models:
  **`dedalo-relations-ts`**.

## What STILL needs care

Not every branch is descriptor-routed. The README's "Engine side (STILL
SCATTERED)" steps are the honest list — at HEAD: `resolve/section_elements_context.ts`
`DEFAULT_EXCLUDE` (media/system models excluded from the simple-context panel);
any model whose search is a dedicated pipeline (children/index/external/_tm twins)
needs its builder ported under `search/` or `relations/` (`search:
{status:'unported', reason}` keeps the throw honest meanwhile); and the one
per-tipo emit quirk (dd546) in `section/read.ts`. Grid cells in
`resolve/relation_list.ts` dispatch on `getFlatValueFamily` (nothing to edit
there — get `flatValue` right). RAG embedding is authored per section (the
section_map `rag.embed` groups; config in `src/config/catalog/ai.ts`) — nothing
per model. Measured open gaps live in the local-only ledger rewrite/LEDGER.md.

## Discipline

- The descriptor DECLARES, it never grows inline behavior — point to the heavy
  module in a comment (as `component_relation_parent/descriptor.ts` points to
  `relations/parent.ts`).
- No silent narrowing: an unported facet THROWS with a ledgered reason; it does not
  quietly fall through.
- Error handling → `engineering/CONVENTIONS.md` §1; dynamic imports → §2. Config reads go
  through `readEnv` (`src/config/env.ts`) only — no `process.env` outside
  `src/config/` (`test/unit/config_env_tripwire.test.ts`). No request/principal/lang
  state in a module-level `Map`/`Set`/`let` (`test/unit/module_state_tripwire.test.ts`).
