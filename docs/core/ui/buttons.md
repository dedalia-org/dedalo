# buttons

> The ontology-driven **UI action** family — `button_*` nodes that a section (or
> area) declares as children and that the server resolves into a `buttons`
> context array the client turns into clickable action buttons (New, Delete,
> import/tool triggers, …).

> See also: [common contract](../system/common.md) · [Sections](../sections/index.md) ·
> [section class reference](../sections/section.md) · [dd_object (ddo)](../../api/dd_object.md) ·
> [Tools](../../development/tools/creating_tools.md) · [Ontology](../ontology/index.md)

## Role

Buttons are **not data**. A button is an ontology node whose `model` starts with
`button_` (e.g. `button_new`, `button_delete`, `button_import`,
`button_trigger`) declared as a child of a *section*. Unlike a component, a
button stores nothing in the matrix and renders no value: it is a declaration
that *"this section offers this action"*. At build time the section collects
its `button_*` children, filters them by permission, and emits one
`dd_object` of `type:'button'` per surviving button into the `buttons` array
of the context envelope. The client (`section` list/edit views) reads that
array and builds the actual DOM `<button>` elements, wiring each `model` to a
concrete handler.

So the subsystem spans three layers:

| layer | what it is |
| --- | --- |
| **Ontology** | `button_*` nodes declared as children of a section, carrying a `label` (term) and `properties` (e.g. `disable`, `css.style`, `tool_config`). |
| **Server** | `buildSectionButtons()` (`src/core/section/buttons.ts`) resolves a section's `button_*` children into `ButtonContext` objects; called from `stampSectionContext()` (`src/core/section/context.ts`), which stamps `entry.buttons` only when the element's `model === 'section'`. |
| **Client** | the section views' `get_buttons()` build the `buttons_container` DOM and attach the per-`model` click behaviour. |

!!! warning "Gap: area buttons are not resolved server-side"
    `stampSectionContext()` is only invoked for `model === 'section'`
    (`buildStructureContext()`, `src/core/resolve/structure_context.ts`) — an
    `area_*` context currently gets no `buttons` array. Do not rely on
    area-level buttons.

## Responsibilities

- **Declare actions** on a section through ontology `button_*` child nodes.
- **Resolve** those nodes into the `buttons` context array
  (`buildSectionButtons()`, `src/core/section/buttons.ts`), filtered by
  permission and by the node's `disable` property.
- **Carry per-button configuration** in the node `properties`: a `disable` flag,
  an optional `css.style` class hint, and (for tool-dispatching buttons) a
  `tool_config` map keyed by tool name — see the gap below for what is
  currently surfaced of this.
- **Bridge to tools** *(not yet implemented)*: `button_import` /
  `button_trigger` are meant to resolve the user's tools and attach a `tools`
  array of tool contexts to the button ddo so the client can open the
  matching tool — see the wire-shape gap below.

## Key concepts

### What is a button node

A button is an ordinary ontology node. The load-bearing fields are the same as
any node:

- `model` — a `button_*` model (this is what makes it a button).
- the `lg-*` term keys — the button's **label**, resolved to the application
  language.
- `properties` — the per-button descriptor (see below).
- `parent` — the section (or area) it is attached to.

### Button `properties`

| property | declared meaning | `buildSectionButtons()` support today |
| --- | --- | --- |
| `disable: true` | the button is skipped entirely (not emitted into the context). | supported — read via `getNode(tipo)`, skipped before emit. |
| `css.style` | a CSS class name the client adds to the rendered `<button>` (e.g. `"css": { "style": "import_files" }`). | **not surfaced** — `ButtonContext` carries no `properties` field at all, so a `css.style` hint never reaches the client via this path. |
| `tool_config` | (only for `button_import` / `button_trigger`) an object keyed by tool name; each value is a tool config (notably a `ddo_map`) used to build the tool context attached to the button. | **not read** — see the tool-bridge gap below. |

### The button ddo (wire shape)

Each surviving button becomes a `dd_object` with `type:'button'`.
`buildSectionButtons()`'s `ButtonContext` (`src/core/section/buttons.ts`)
emits exactly:

```json
{
    "typo"  : "ddo",
    "type"  : "button",
    "tipo"  : "<button node tipo>",
    "model" : "button_new",
    "label" : "New"
}
```

The whole array lands under `context.buttons` of the section envelope.

!!! warning "No `properties`, no `tools` on the wire yet"
    The button ddo carries no `properties` or `tools` key at all today, and
    `button_import` is excluded outright (`BUTTON_EXCLUDE_MODELS`) rather
    than resolved with a tool context. `button_trigger` is not special-cased
    either, so it is emitted as a bare button with no `tools` array for the
    client's `current_button.tools[0]` lookup to read. **A section header
    that relies on `button_import`/`button_trigger` to open a tool will not
    work yet.**

### Concrete button models

| model | meaning | client behaviour |
| --- | --- | --- |
| `button_new` | create a new record in the section | publishes `new_section_<id>` (the section creates a record). |
| `button_delete` | delete record(s) of the section | opens the delete dialog (`render_delete_record_dialog`) over the current SQO; in the list view it is gated to global admins for multiple delete, and a per-row trash-can `button_delete` is also rendered from the same context entry. |
| `button_import` / `button_trigger` | dispatch a **tool** from the section header (v5-compat) | opens the tool via `open_tool(...)` using `current_button.tools[0]`. The two are treated identically in code; they are intended to merge into a future `button_tool` model. `button_import` never reaches the client (excluded server-side); `button_trigger` reaches it without a `tools` array — see the gap above. |
| *(other `button_*`)* | any other button model | falls through to the default: publishes `click_<model>` on the event manager so a subscriber can handle it. |

## Files & structure

```text
src/core/section/
├── buttons.ts                     # buildSectionButtons() + sectionRelationListTipo()
└── context.ts                     # stampSectionContext() — calls buttons.ts, model==='section' only

src/core/resolve/structure_context.ts   # buildStructureContext() — invokes stampSectionContext()
```

The client section views:

- `get_buttons()` in `client/dedalo/core/section/js/view_default_list_section.js`,
  `view_base_list_section.js`, `view_graph_list_section.js`,
  `view_default_edit_section.js`, and the per-row delete in
  `client/dedalo/core/section/js/render_list_section.js`.

## How a section resolves its buttons (server)

`buildSectionButtons()` (`src/core/section/buttons.ts`) is the resolver,
called from `stampSectionContext()`:

1. **Model gate** — `stampSectionContext()` is only invoked for
   `model === 'section'` in `buildStructureContext()`; `area*` callers get no
   `buttons` array yet (the gap noted above).
2. **Collect tipos** — `sectionButtonRows()` (`src/core/section/buttons.ts`)
   is virtual-section-aware: for a plain section it queries the section's own
   `button_%` model children, `ORDER BY order_number NULLS LAST, tipo`. For a
   **virtual** section (its node's `relations[0].tipo` resolves to a real
   `section`) it takes the real section's own button rows plus the virtual
   section's own additions, minus any tipos named by the virtual section's
   first `exclude_elements` child.
3. **Per button**, in order:
   - **Model exclude** — skip if the model is in `BUTTON_EXCLUDE_MODELS`
     (currently just `button_import`).
   - **Permission** — with a `principal`, the real per-button ACL
     `getPermissions(principal, sectionTipo, buttonTipo) < 2` → skip; without
     one, the caller-level permission was already checked `>= 2` before the
     loop (an admin-path proxy).
   - **Properties** — `getNode(tipo)`; skip if `properties.disable === true`.
   - **Label** — `labelByTipo(tipo)` (application language).
   - **Tools** — **not implemented**: `button_import`/`button_trigger` never
     get a resolved `tools` array (see the wire-shape gap above).
   - **Build ddo** — a `ButtonContext` with `typo/type/tipo/model/label` only
     (no `properties`, no `tools`).
4. The permission-filtered button array is rebuilt fresh on every call; only
   the underlying ontology row fetch (`sectionButtonRows()`) is cached
   (`buttonRowsCache`, cleared by `clearSectionButtonsCache()`).

`buildStructureContext()` calls `stampSectionContext()` and writes the result
under `buttons` in the context; the **simple** context path
(`section_elements_context.ts`'s `toSimple()`) deliberately **strips** `tools`
and `buttons` from a full context.

## How the client renders buttons

The section list views read `self.context.buttons` and build a
`buttons_container`. Beyond the per-model buttons it also synthesises the
non-ontology **Search** / **Show all** controls and a collapse toggle. The
per-model wiring (from `view_default_list_section.js`):

```js
switch (current_button.model) {
    case 'button_new':
        event_manager.publish('new_section_' + self.id)
        break
    case 'button_delete':
        self.render_delete_record_dialog({ section:self, section_id:null,
            section_tipo:self.section_tipo, sqo:delete_sqo })
        break
    case 'button_import':
    case 'button_trigger':
        open_tool({ tool_context:current_button.tools[0], caller:self,
            caller_options:{ section_tipo:self.section_tipo, button_tipo:current_button.tipo } })
        break
    default:
        event_manager.publish('click_' + current_button.model)
}
```

- The DOM class is `'warning ' + model.replace('button_','')`, plus
  `properties.css.style` when present.
- `button_delete` (multiple-record) is hidden unless
  `page_globals.is_global_admin===true`; the per-row trash-can in
  `render_list_section.js` reuses the same `button_delete` context entry but
  publishes a per-record `delete_section_<id>` event.

## Public API / key methods

### The active resolver (`src/core/section/buttons.ts` + `context.ts`)

| function | module | purpose |
| --- | --- | --- |
| `buildSectionButtons(sectionTipo, callerPermissions, principal?)` | `section/buttons.ts` | Resolve the section's `button_%` children into an array of `ButtonContext` (`typo:'ddo', type:'button'`); the single source of the `buttons` context array. The permission-filtered result is rebuilt on every call. |
| `sectionRelationListTipo(sectionTipo)` | `section/buttons.ts` | The section's `relation_list` child tipo (virtual-section-aware); feeds `context.config.relation_list_tipo`, not the buttons array itself, but lives in the same module. |
| `stampSectionContext(entry, params)` | `section/context.ts` | Calls `buildSectionButtons()` and writes the result onto `entry.buttons`; only invoked for `model === 'section'`. |

The behaviour of a button is the pair *(ontology declaration → client
handler)* — there is no button class hierarchy or per-button "execute"
method; the resolver above is two plain functions.

## Examples

### Declaring a button (ontology node)

A `button_import` attached to a section, configured to dispatch a tool and to
get a custom CSS class on the client:

```json
{
    "tipo"   : "rsc500",
    "parent" : "rsc197",
    "model"  : "button_import",
    "lg-eng" : "Import",
    "properties" : {
        "css"         : { "style": "import_files" },
        "tool_config" : {
            "tool_import" : {
                "ddo_map": [ { "tipo": "rsc85", "section_tipo": "rsc197" } ]
            }
        }
    }
}
```

### The intended full shape (not yet emitted)

The `tool_config` above is meant to resolve into a `properties` object and a
`tools` array carried on the button ddo:

```json
{
    "context": {
        "tipo"    : "rsc197",
        "model"   : "section",
        "buttons" : [
            { "type":"button", "tipo":"rsc500", "model":"button_import",
              "label":"Import", "properties":{ "css":{"style":"import_files"} },
              "tools":[ { "type":"tool", "model":"tool_import", "name":"tool_import" } ] },
            { "type":"button", "tipo":"...", "model":"button_new",
              "label":"New", "properties":{}, "tools":null }
        ]
    },
    "data": [ ]
}
```

### The resulting context (server → client) today

The same section, resolved by `buildSectionButtons()`: `button_import` is
dropped entirely (excluded model), and the surviving buttons carry no
`properties`/`tools` keys at all —

```json
{
    "context": {
        "tipo"    : "rsc197",
        "model"   : "section",
        "buttons" : [
            { "typo":"ddo", "type":"button", "tipo":"...", "model":"button_new",
              "label":"New" }
        ]
    },
    "data": [ ]
}
```

### Adding a brand-new button behaviour

There are two pieces, and **no server-side class is required** for a plain UI
button:

1. Create a `button_<x>` node in the ontology under the target section, with a
   label and (optionally) a `disable` / `css.style` property.
2. Handle it on the client: the default branch of the list-view switch publishes
   `click_button_<x>`, so a subscriber to that event (or a new `case` in
   `get_buttons()`) implements the action.

No server-side class is required for a plain UI button — the context flow
never needs one.

## How it fits with the rest of Dédalo

- **[Sections](../sections/index.md) / [section class](../sections/section.md)** —
  the principal owner: `buildSectionButtons()` (called from
  `stampSectionContext()`) decides which buttons a section exposes; the
  section's list/edit views render them unchanged.
- **[Tools](../../development/tools/creating_tools.md)** — `button_import` /
  `button_trigger` are meant to bridge from a section header into the tools
  subsystem, carrying built tool contexts. **Not yet implemented** — see the
  gap noted above.
- **[dd_object (ddo)](../../api/dd_object.md)** — each button is emitted as a
  `dd_object`-shaped object of `type:'button'`.
- **[Ontology](../ontology/index.md)** — buttons are plain ontology nodes; their
  `model` (`button_*`) and `properties` are the whole declaration.
- **[request_config](../request_config.md)** — the context stamp that includes
  `buttons` is the same one that carries permissions, tools and request_config.

## Related

- [Sections concept](../sections/index.md) · [section class reference](../sections/section.md)
- [Components](../components/index.md) — the data-bearing siblings of buttons under a section.
- [dd_object (ddo)](../../api/dd_object.md) — the wire object every button becomes.
- [Architecture overview](../architecture_overview.md) — where the context/data
  envelope and the ontology-as-schema model come from.
