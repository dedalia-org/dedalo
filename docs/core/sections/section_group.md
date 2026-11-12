# section_group

> The `section_group` model — a pure **layout grouper**: a non-data child node
> of a section under which sibling components are visually grouped (the
> collapsible "field group" box in edit/list).

> See also: [Sections concept](index.md) · [section](section.md) · [Components](../components/index.md) · [Architecture overview](../architecture_overview.md)

This page is the reference for `section_group`. It is one of the ontology
*grouper* models — container nodes that carry **no data of their own** and
exist only to arrange a section's components for layout. For the conceptual
model of a section and its component children, read [Sections](index.md)
first.

There is **no `section_group` module**, and none is needed. Being a grouper is a
**model-level fact**, not an object: `GROUPER_MODELS` / `isGrouperModel()`
(`src/core/concepts/section.ts`) name the four grouper models, and the generic
structure-context build (`src/core/resolve/structure_context.ts`) stamps any node
whose model is a grouper with context `type: 'grouper'`. Because the section-only
context stamp (`stampSectionContext`, `src/core/section/context.ts`) only runs
for `model === 'section'`, a grouper never gets buttons or tools attached in the
first place — the empty `tools` / `buttons` arrays fall out of the engine by
construction.

## Role

In the ontology, a section's components are not children of the section
directly; they hang under one or more `section_group` nodes via
`parent_grouper`, which is what lets the editor render named, collapsible
groups of fields (see the
[Architecture overview tree](../architecture_overview.md#the-areas-sections-components-data-hierarchy),
where the People section holds a `section_group` that in turn holds the Name
and Surname components).

A `section_group` node owns **no value**, is never read from or written to the
matrix table, and produces a context with an empty `data` array. Its only job
is to exist as a node in the ontology so the structure-context walk emits a
grouper context the client can turn into a wrapper element.

It sits among the grouper family, all recognised by the same registry
(`GROUPER_MODELS`, `src/core/concepts/section.ts`):

| model | role |
| --- | --- |
| **`section_group`** *(this page)* | A named, collapsible group of components inside a section. The default field-grouping container. |
| **`section_group_div`** | A *legacy model* remapped to `section_group` at model-resolution time (`STRUCTURAL_MODEL_REPLACEMENT_MAP`, `src/core/ontology/resolver.ts`); intended to render as an unlabelled `<div>` group. See the note below. |
| **`section_tab`** / **`tab`** | Tabbed groupers — the same "no data, layout only" contract, rendered as tab strips rather than collapsible boxes. See [section_tab](section_tab.md). |

All four are recognised by `GROUPER_MODELS` and skipped by the children walk's
traversal law (`traversalRecurses()`, same module) when collecting
data-bearing components.

## Responsibilities

- **Be a layout container.** Mark a node in the section tree as a grouper so
  the structure walk descends into it and the client renders a wrapper for its
  children. It groups; it does not store.
- **Carry a label and CSS, nothing else.** The group's title (`label`) and any
  layout CSS come from the ontology node's term and `properties`, lifted into
  the context by the same `buildCore()` step every model goes through
  (`src/core/resolve/structure_context.ts`).
- **Carry no tools.** Because `stampSectionContext()` only fires for
  `model === 'section'`, a grouper's context keeps the core's `tools: []` /
  `buttons: []`.
- **Stay out of the data path.** A grouper's emitted `data` is always `[]`; it
  never touches a `MatrixRecord` or the matrix table.

## Key concepts / data model

`section_group` has **no data model** — there is no read or save path to look
for. Its context is built by the same generic path every ontology node goes
through:

- In the **ontology**, a component declares the group as its `parent_grouper`
  (the *layout* parent; the component's `parent` may still be the section
  itself, per the containment rule the structure walk enforces).
- On the **server**, `isGrouperModel(model)` is what the structure-context
  build (and the children-traversal law) checks to recognise a grouper node;
  the same `buildCore()` / entry-stamping path that resolves a component
  resolves a grouper, just without the section-only stamp.
- On the **client**, `render_section_group` (`client/dedalo/core/section_group/js/`)
  builds a `wrapper_section_group` element whose `wrapper.content_data` pointer
  is the placement target for child components, keyed by `parent_grouper`. The
  group label is a collapsible toggle whose open/closed state persists in the
  local DB under `section_group_<section_tipo>_<tipo>`.

```text
section (rsc197)
└── section_group  (layout, no data)   ← this model
        ├── component_input_text  Name     (parent_grouper = section_group)
        └── component_input_text  Surname   (parent_grouper = section_group)
```

## The emitted context

There is no server-side constructor to call directly; a grouper's context is
whatever the generic structure-context build produces for a node whose model
resolves to `'section_group'` (or the legacy `section_group_div`, remapped by
`STRUCTURAL_MODEL_REPLACEMENT_MAP`):

```json
{
    "context": [
        {
            "typo": "ddo",
            "type": "grouper",
            "tipo": "rsc76",
            "section_tipo": "rsc197",
            "model": "section_group",
            "label": "Identity",
            "permissions": 2,
            "tools": [],
            "buttons": [],
            "css": { ".wrapper_section_group": { "grid-column": "span 12" } }
        }
    ],
    "data": []
}
```

The `type: 'grouper'` marker (`elementTypeOf()`,
`src/core/resolve/structure_context.ts`) is what the client keys its wrapper
CSS and edit-mode nesting on — the edit view nests components into a grouper
only when `parent_instance.type === 'grouper'`.

### `section_group_div` — the unlabelled variant

A node whose ontology model is `section_group_div` is served as a
`section_group` (`model: 'section_group'`, `legacy_model: 'section_group_div'`).
The server stamps `add_label` on every `section_group` context
(`buildCore`, `src/core/resolve/structure_context.ts`): `true` for a plain
group, `false` for a `section_group_div`. The client (`render_section_group.js`)
keys on `add_label === false` and renders a plain `<div>` with no header, no
collapse toggle and no top margin (`no_margin`); its content is always shown,
whatever collapse state the browser remembers for that panel. It is still a
grouper: its children nest under it exactly as under a labelled group.

No other model carries `add_label`, and the search panel's element list omits it
(that list never emits a `section_group_div` at all — it walks through it to its
children).

## How it fits with the rest of Dédalo

- It is one of the **grouper models** (`GROUPER_MODELS`,
  `src/core/concepts/section.ts`) that the children-traversal walk skips when
  collecting *data-bearing* children, and descends into when building layout —
  a node the walk passes *through*.
- It produces a context with an empty `data` array — the clean illustration of
  the context/data duality where context (description) is everything and data
  (values) is nothing.
- It is the sibling of [`section_tab`](section_tab.md) / `tab` (tabbed
  groupers) and the canonical target of the legacy `section_group_div` model
  remap.
- Its children are ordinary [components](../components/index.md) that point at
  it through `parent_grouper`; the section's structure-context build assembles
  their contexts and the client drops them into the grouper's `content_data`.

## Related

- [Sections concept](index.md) — what a section is and how its components hang
  under grouper nodes.
- [section](section.md) — the section concept whose context-building treats
  groupers as containers (`GROUPER_MODELS` / `traversalRecurses()`).
- [section_tab](section_tab.md) — the tabbed grouper sibling (same no-data
  contract).
- [Components](../components/index.md) — the data-bearing children placed
  inside a grouper via `parent_grouper`.
- [Architecture overview](../architecture_overview.md#the-areas-sections-components-data-hierarchy)
  — where groupers sit in the area → section → component → data tree.
