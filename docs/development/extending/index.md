# Extending Dédalo

> How to add new capabilities to Dédalo v7 — and how to recognise that most
> "new" work is **ontology authoring**, not code.

> See also: [Ontology authoring](../../core/ontology/authoring.md) ·
> [Component base classes](../../core/components/base_classes.md) ·
> [Sections](../../core/sections/index.md) ·
> [Areas](../../core/areas/index.md) · [Creating new tools](../tools/creating_tools.md)

This is the **overview** for extending Dédalo. It explains the one principle
that governs every extension — *ontology-first* — gives you a decision guide for
when you need code at all, and links to the per-typology cookbooks. Each
cookbook is a focused step-by-step procedure; this page tells you *which* one you
need and *why*.

## The ontology-first principle

In Dédalo **there is no schema file and no model registry to edit.** The
[ontology](../../core/ontology/authoring.md) *is* the schema, and the schema is
data you author in the back office. A new record type, a new field on an
existing section, a new menu area that reuses existing field models, a portal
wired to a target section — all of these are created by adding or editing
**ontology nodes**, never by writing code or SQL.

This works because the framework is **model-driven**. Component behavior lives in
**horizontal engines** (`src/core/resolve/`, `src/core/relations/`,
`src/core/section/read.ts`) that dispatch on the `model` string — not in a
class-per-model tree. Extension is therefore *dispatch over a descriptor registry*:

- **Server resolution is the descriptor registry.** A component `model` maps to
  a small declarative `descriptor.ts` collected in
  `src/core/components/registry.ts` (`getComponentModel(model)`). The engines
  read the descriptor (which column it stores in, whether it is
  class-translatable, which relation resolver emits its rows) and do the work.
  Adding a model = add `component_<model>/descriptor.ts` + one line in the
  registry; the load-time integrity check in `registry.ts` fails at boot on a
  malformed or dangling entry.
- **The node carries the `model`.** Each ontology node stores a `model` value
  (`section`, `component_input_text`, `area_admin`, `tool_export`, …). The
  runtime reads it via `getModelByTipo(tipo)`
  (`src/core/ontology/resolver.ts`) and surfaces it to the client as
  `options.model` / `self.model` in the emitted context.
- **Client resolution is by prefix.** `client/dedalo/core/common/js/instances.js`
  dynamically imports the ES module for a model by prefix: `service_*` →
  `core/services/<model>/js/<model>.js`, `tool_*` → the tools root, default →
  `core/<model>/js/<model>.js`. The named export inside must equal the model
  exactly (`export const component_email = function(){…}`).

So the default for *most* extension tasks is: **author a node, regenerate, done.**
Code only enters the picture when you need a *new kind of behaviour* that no
existing model provides.

## When do you need this? (ontology-only vs code)

Decide with one question: **does an existing model already do what I need?**

| You want to… | Existing model exists? | What you do |
| --- | --- | --- |
| Add a record type (a "table") | Yes — `section` | **Ontology only.** Author a `section` node + child component nodes. |
| Add a field to a section (text, number, date, picker, image, …) | Yes — `component_*` | **Ontology only.** Author a `component_<type>` node under the section. |
| Group/lay out fields (tabs, groups) | Yes — `section_tab`, `section_group`, … | **Ontology only.** Author grouper nodes (they store no data). |
| Add a back-office area that reuses existing fields | Yes — the generic `area` model plus menu nodes | **Ontology only**, unless the area needs its own client JS/CSS. |
| Add a *new field type* with its own value shape, render and validation | **No** | **Code:** new `component_<X>` (a `descriptor.ts` + registry entry + engine wiring + client JS/CSS) **and** an ontology node. |
| Add a reusable client interaction (uploader, picker UI) hosted by a component | **No** | **Code:** new `service_<X>` (client-only JS), consumed by a host component. |
| Add a computed read-only display embedded in a host | **No** | **Code:** new widget — a client module under `client/dedalo/core/widgets/<X>/` plus its server-side compute descriptor under `src/core/components/component_info/widgets/<tld>/`, hosted by a `component_info`. |
| Add an isolated block of UI/logic attached to a section/component/area | **No** | A **tool** — see its own guide: [Creating new tools](../tools/creating_tools.md). |

The rule of thumb: **new sections, fields, groupers and most areas are
ontology-only.** You write code only for a genuinely new **component model**,
**service**, or **widget** — and tools have their own dedicated path.

!!! tip "Reuse before you build"
    Before authoring a new component model, check the
    [components index](../../core/components/index.md): Dédalo ships text,
    number, date, email, IRI, JSON, geolocation, the media family (image, av,
    3d, pdf, svg), and the relation family (select, check_box, radio_button,
    portal, dataframe, parent/children, …). A new model is rarely the answer.

## File-layout conventions

The two sides of the seam have **different** shapes:

- **Server (Bun/TS).** A new **component** model is a per-model *home* under
  `src/core/components/component_<model>/` — a declarative `descriptor.ts` (and,
  for most, a `samples/` reference set) registered in
  `src/core/components/registry.ts`. Its behavior is not in that folder; it is
  in the horizontal engines (`resolve/`, `relations/`, `section/read.ts`). New
  **areas** and **sections** need no server module at all — they are served by
  the generic engines (`src/core/area/`, `src/core/section/read.ts`). A new
  **tool** is a package under `tools/<tool>/` with a `register.json` and a
  `server/index.ts` exporting a `ToolServerModule`.
- **Client (vanilla JS).** Every model with a UI keeps its directory in the
  client tree, resolved by directory name / prefix by `instances.js`:

```text
client/dedalo/core/<model>/              # or core/services/<model>/, core/widgets/<model>/, tools/<tool>/
├── js/
│   ├── <model>.js                       # client class; named export === <model>
│   ├── render_edit_<model>.js           # per-mode render dispatchers
│   └── view_*.js                        # the actual DOM builders
├── css/<model>.less                     # bundled into page.css
└── img/icon.svg                         # where an icon is needed
```

The **one** server-side registry a new component must touch is its
`descriptor.ts` (`column: 'string'|'relation'|'media'|'number'|'date'|'geo'|'iri'|'section_id'|'misc'`)
and its one line in `registry.ts`. That `column` is what
`getColumnNameByModel()` (`src/core/ontology/resolver.ts`) returns; omit it and
the engines have no matrix column to read/write. The model→column map is
**decentralised** — one `column` per descriptor, no central table to keep in sync.

A real **scaffolder + template** exists **only for tools**
(`tools/tool_dev_template/` + `scripts/create_tool.ts`). For components,
sections, areas, services and widgets there is no generator: you **copy an
existing sibling** — a component descriptor, or a client model directory — and
add the ontology node (plus the descriptor + registry entry for a component).
The ontology JSON templates at `core/ontology/templates/`
(`main_section_data.json`, `area_grouper_data.json`, `virtual_section_data.json`)
are node-shape references, not generators.

## Step-by-step (the universal checklist)

Whatever you extend, the procedure is the same skeleton — the cookbooks fill in
the specifics:

1. **Confirm you need code.** Run the table above. If an existing model fits,
   stop here and author the ontology node (steps 5–6 only).
2. **Decide what the value IS** (code paths only). For a component this is the
   most important decision — which matrix column it stores in and which engine
   path emits it (literal / relation / info-widget). See
   [base classes](../../core/components/base_classes.md) and its decision guide.
   Areas and sections need no per-model class; a tool exports a
   `ToolServerModule`.
3. **Create the home by copying a sibling.** For a component: copy an existing
   `component_<model>/descriptor.ts` and its `samples/`. For a tool: run
   `bun run scripts/create_tool.ts`. For a client-facing model, copy the
   sibling directory in the client tree and rename the directory, the JS
   named export, and `register.json` (tools). The engines find a component by
   its registry entry — no include edit.
4. **Implement the halves.** Server side: the `descriptor.ts` + registry line
   (component), or the tool's `server/index.ts` `apiActions`; areas/sections
   fall through to the generic engines. Then the client `js/` + `css/`. The
   horizontal engines emit the component's `{context, data}` — you never write a
   per-model server module for it.
5. **Author the ontology node** with the right `model` value, `parent`,
   `term`/`lg-*` label, `order_number`, and any `properties` /`relations`. See
   [Ontology authoring](../../core/ontology/authoring.md).
6. **Wire it into the tree.** Sections need a `matrix_table` term (or fall back
   to the shared `matrix`); areas need a `menu` entry; components are children
   of their section; services/widgets are hosted (rendered inline) by a
   component rather than placed as a data node.
7. **Regenerate so the edit goes live.** An ontology edit is not live until you
   regenerate the compiled `dd_ontology` (`tools/tool_ontology_parser`). See
   [How changes apply live](../../core/ontology/authoring.md#how-changes-apply-live).
8. **Add samples and a test** (optional but recommended): a `samples/` set
   beside the descriptor and a `bun:test` under `test/` (the descriptor
   equivalence is pinned by `test/unit/component_registry.test.ts`).

## Worked example — add a field, two ways

**You want a "Wikidata QID" field on the Objects section.** Two scenarios show
the ontology-only / code split.

### Scenario A — reuse an existing model (ontology only, no code)

A QID is just a short string. Reuse [`component_input_text`](../../core/components/component_input_text.md):

1. In the [Ontology area](../../core/ontology/authoring.md), open the Objects
   section node (e.g. `tch1`) and create a child record.
2. Set `model = component_input_text`, `parent = tch1`, the term
   `{ "lg-eng": "Wikidata QID" }`, an `order_number`, and `translatable = no`.
3. Regenerate the TLD and clear caches.

The field now reads, writes, searches and exports — **zero lines of code**,
because `component_input_text` already provides all of it and its descriptor
already maps its column (`src/core/components/component_input_text/descriptor.ts`:
`column: 'string'`).

### Scenario B — a genuinely new model (code)

Suppose instead you need a **validated** QID field (must match `^Q[0-9]+$`, links
out to wikidata.org). No existing model validates that, so you create
`component_qid`, mirroring [`component_email`](../../core/components/component_email.md)
(a literal-direct string stored in the `string` column):

1. `src/core/components/component_qid/descriptor.ts` — export one
   `ComponentModel`: `{ model: 'component_qid', column: 'string' }` (add
   `classSupportsTranslation: true` only if its items are lang-filtered; a QID
   is language-neutral, so omit it). It stores its own literal string, so the
   `string` column is right; see the
   [decision guide](../../core/components/base_classes.md#decision-guide-which-base-should-a-new-component-extend).
2. Register it: add the import + array entry in
   `src/core/components/registry.ts`. The boot-time integrity check validates
   it.
3. **Engine wiring for the bespoke behavior.** A plain literal needs nothing
   more — the generic literal branch of `emitDdoData`
   (`src/core/section/read.ts`) reads the `string` column by descriptor. The
   *validation* (`^Q[0-9]+$`) lives on the write path
   (`src/core/section/record/save_component.ts`); add the check there if the
   value must be rejected server-side.
4. Client: copy `client/dedalo/core/component_email/` to
   `client/dedalo/core/component_qid/`, rename the directory, the JS named export
   (`component_qid`), the render/view files and the `.less` basename.
5. Author the ontology node with `model = component_qid` under the Objects
   section, then regenerate.

Then *every* future "QID field" anywhere is Scenario A again — author a node, no
code.

## Common pitfalls

- **Forgetting the descriptor `column` / registry line.** A new component with
  no `column` (or not added to `src/core/components/registry.ts`) has no matrix
  column: `getColumnNameByModel()` returns `null` and the engines silently fail
  to read/write. This is the single non-convention edit — do not skip it.
- **Mismatched client export name.** `instances.js` imports
  `core/<model>/js/<model>.js` and expects `export const <model> = …`. If the
  export name ≠ the model, the client import fails.
- **Hunting for a per-model server class.** There is none. A component's
  `{context, data}` is emitted by the horizontal engines; a component is
  *declared* by its `descriptor.ts`, not implemented as a class.
- **Skipping regenerate.** Editing the ontology record updates the *editable*
  layer only; the runtime reads the compiled `dd_ontology` table. Regenerate the
  TLD to make the edit live — see
  [How changes apply live](../../core/ontology/authoring.md#how-changes-apply-live).
- **Picking the wrong storage column.** Re-implementing datum load/save,
  permissions or search means you mismodelled the value. Walk the
  [decision guide](../../core/components/base_classes.md#decision-guide-which-base-should-a-new-component-extend)
  top-down and stop at the first match; a relation stores in `relation` and is
  emitted by a resolver, media in `media`, a literal in its typed column.
- **Hard-coding one institution's tipos in the generic engine.** Code that
  genuinely serves ONE ontology (a formula that names that ontology's section)
  is not engine code: it lives in that ontology's **TLD package**,
  `src/tld/<tld>/` — see [TLD packages](#tld-packages) below. A tipo literal
  elsewhere in `src/` is refused by `engine_install_tld_tripwire`.
- **Treating a widget like a top-level model.** A `core/widgets/` widget has no
  ontology node of its own and no top-level model; its client module is hosted
  by a `component_info` field and its server-side compute lives in
  the `component_info` widget framework (`src/core/components/component_info/widgets/`, `computeInfoWidgets`), not a class of its
  own.

## TLD packages

Almost everything in the engine is generic: it reads the ontology and never
names an installation's tipo. The exception is code that exists FOR one
ontology — today the mdcat grant chain, whose `final_total` applies the
major-grant branch to one mdcat section. Such code lives in a **TLD package**,
`src/tld/<tld>/` (a peer of `src/core/`, depending on core and never the other
way round), and is reached by the engine only through the one registry
`src/tld/registry.ts`:

```text
src/tld/
├── registry.ts          TLD_PACKAGES (one import line per package) + resolveCalculationFn
├── types.ts             TldPackage — what a package exports
└── <tld>/
    ├── index.ts         export const <tld>: TldPackage
    ├── README.md        the institution / process the code serves, every literal and why
    └── calculation.ts   the formulas the ontology names under /<tld>/calculation/<module>.ts
```

The ontology selects a package by name, never by path: a `calculation`
block's `process: { "fn", "file": "/<tld>/calculation/<module>.ts", "engine": "ts" }`
is matched against the registered tables (`/calculation/formulas.ts` is the
generic table), and anything the tables do not hold is refused with
`ontology.invalid_node`. The laws — a package names only its own TLD's tipos,
the generic engine names none, only the registry imports a package, no package
formula reuses a generic name, every package directory is registered, and a
`tools/tool_<tld>_*` tool names only its own TLD — are gated by
`test/unit/engine_install_tld_tripwire.test.ts`. Adding a package is one
directory plus one import line; the ontology that names its formulas is the
owner's (master ontology) — never create nodes for it.

## Related

- Per-typology cookbooks (the step-by-step procedures):
    - [Add a component](add_a_component.md) — a new field model (descriptor + registry + client JS/CSS)
    - [Add a section](add_a_section.md) — a new record type (mostly ontology)
    - [Add an area](add_an_area.md) — a new back-office area (ontology node + menu)
    - [Add a service](add_a_service.md) — a reusable client interaction hosted by a component
    - [Add a widget](add_a_widget.md) — a computed display embedded in a host
- [Creating new tools](../tools/creating_tools.md) — tools have their own
  scaffolder and registration flow.
- Reference docs:
    - [Component base classes](../../core/components/base_classes.md) — the
      inheritance chain and the base-class decision guide.
    - [Sections](../../core/sections/index.md) — what a section is and how it is
      defined.
    - [Areas](../../core/areas/index.md) — the area inheritance model and every
      `area_*` class.
    - [Ontology authoring](../../core/ontology/authoring.md) — the node shape,
      `properties` grammar, and the regenerate/cache-clear lifecycle.
