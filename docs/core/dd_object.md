# dd_object

> See also: [RQO](rqo.md) · [SQO](sqo.md) · [request_config](request_config.md) · [Locator](locator.md) · [Glossary](glossary.md)

The dd_object (ddo) is the normalized object Dédalo uses to call and modify ontology nodes — defining the order, view, mode, permissions, properties and CSS that change a section's or component's behavior on the fly. This page documents its purpose and its full property set.

## Introduction

The Dédalo ontology defines sections, areas and components with a default behavior and configuration. To call and modify these ontology nodes, Dédalo uses dd_objects.

For example, a section has its components, but in list mode the section shows only some specific components, not all of them. A pointer is therefore needed to define which components are shown and in what order. The dd_object is the structure that points at ontology nodes to create specific configurations for different situations.

A dd_object is the way to call and modify ontology nodes.

## dd_object definition

`src/core/concepts/ddo.ts` defines the dd_object as the `ddoSchema`/`Ddo` type: a plain, zod-validated object rather than a class instance.

**dd_object** `object`

A dd_object, or ddo, is a common definition of properties for ontology nodes. It is a flexible, extensible object used to group, order, assign and change the properties of ontology nodes. dd_objects are not the nodes of the ontology themselves; they are the callers and modifiers of the default definitions. Every ddo is a configuration specific to the ontology node it represents.

A ddo is used in many ways. For example, ddos define the order of the columns in lists: the section list uses them to define its columns with specific components in a specific order and with specific characteristics, and the component_portal uses them to define which components of the pointed section to show as columns.

A ddo is also used to request information from the work API. By changing ddo properties you can change the behavior of areas, components and sections on the fly.

## Properties

| Property | Type | Description | Value Type | Options | Default | Example |
| --- | --- | --- | --- | --- | --- |  --- |
| typo | private  | `type of object`. Fixed property used to identify the dd_object on the client. | string | ddo |   ddo  |   |
| type | public | Defines the general model. Used to apply common behaviors to components, buttons, etc. | string | section \| component \| grouper \| button \| area \| tm \| widget \| install \| login \| menu \| tool \| detail \| dd_grid | component |  |
| tipo | public |  Defines the ontology 'tipo'. | string |  |  |  oh14 |
| section_tipo | public |  Defines the ontology 'tipo' of the section. When the ddo is a section it is the same as `tipo`; when the ddo is a component it is the section that contains it. | string |  |  |  oh1 |
| parent | public | Defines the ontology 'tipo' of the parent caller: for components it is the section_tipo; for components called by portals it is the component_portal. | string |   |   |  oh2 |
| parent_grouper | public | Defines the ontology 'tipo' of the parent grouper or direct parent in the hierarchy: for components it is a section_group; for sections it is the area. | string |  |  |  oh7 |
| lang | public | Defines the lang of the ddo. | string |  |  |  lg-eng |
| mode | public | Defines whether the ddo is configured as edit, list, search, etc. | string |  |  |  list |
| model | public | Defines the specific model. This property differs from `type`: `type` defines whether the ddo is a component or a section, while `model` defines whether the ddo is a component_input_text, a button_new, etc. | string |  |  |  component_input_text |
| legacy_model | public | Used to know the legacy model defined in ontology. In v6 some models was unified as component_autocomplete, component_autocomplete_hi, component_autocomplete_ts were convert to component_portal, legacy model store his old model for compatibility with v5 in some situation as publishing. | string |  |  |  component_autocomplete_hi |
| properties | public | Defines the ontology properties of the ddo | object |  |  | {"source":"..."} |
| permissions | public | Defines the user permissions. It is equal to or lower than the user's permissions. It defaults to the user's permissions, but the value can be reduced to deny access or create a read-only version of the ontology node. It cannot be set higher than the current user's permissions. | int | 0 \| 1 \| 2 |  |  1 |
| label | public | Defines the name of the ontology node with the lang  | string |  |  |  Title |
| labels | public | Defines the names of variables, used by tools  | array \[string]  |  |  |  \['Title'] |
| translatable | public | Defines if the ontology node is translatable | bool  | true \| false | true | true |
| tools | public | Defines if the ontology node has tools associated | array \[string]  |  |  | \['tool_time_machine'] |
| buttons | public | Defines if the ontology node has buttons associated | array \[string]  |  |  | \['button_add'] |
| css | public | The CSS of the ontology node for this mode, sent by the server (from the node's `properties.css`, after the mode rules). An object: each key is a selector fragment, each value an object of CSS declarations. The client scopes it to the element and inserts it — see [Ontology CSS](ontology/ontology_css.md). `null` when nothing applies (e.g. a component in list mode) | object \| null |  |  | {".wrapper_component": {"grid-column": "span 2"}} |
| target_sections | public | Defines the sections pointed by the ontology node. A component_portal call to at least one section, in some cases it could point to multiple section. If the ontology node use a common section, as toponymy (es1, fr1, etc) this property will set all possible sections for the ontology node | array\[object] |  |  |  \[{'tipo': 'dd125','label': 'Projects'}] |
| request_config | public | Defines the configuration of the ontology node. Used by component_portal to config his show, search and choose options — see [request_config](request_config.md). (!) For a component **nested inside a ddo_map** the server rebuilds this from the ontology (`build_request_config`); a client cannot inject an alternative one — its columns come from sibling ddos instead. See [How a ddo_map resolves](#how-a-ddo_map-resolves-the-chain). | array |  |  |  \[{"show": {"ddo_map": [...]}}] |
| columns_map | public | Defines the columns for list in sections and components. Columns map is used to know the order and the format of every columns in a list, the map will used to arrange the components with the same column_id in ddo_map. By default the columns_map will be the all ddo inside the ddo_map, 1 ddo = 1 column. | array\[object] |  |  |  \[{"id": "a", "label": "rsc368", "width": "65%"}] |
| view | public | Defines the render view that will use. Views are the final html and css of the components, sections, areas, tools, etc. If view is not set, the rendered will use "default" view. | string | string \| null | default |  table |
| children_view | public | Defines the render view that will use at every child of the ontology node. Used by sections and portals to spread specific view to his children. Views are the final html and css of the components, sections, areas, tools, etc. If view is not set, the rendered will use the parent node view. | string | string \| null |  |  text |
| name | public | Defines the tool name. Used only by tools to identify his class name | string |  |  |  tool_lang |
| description | public | Defines the tool description. Used only by tools to add some information about the tool | string |  |  |  Tool lang is used to translate... |
| icon | public | Defines the tool icon. Used only by tools to show his icon. It will be the path to the icon file in the directory tree. | string |  |  |  /tools/tool_lang/img/icon.svg |
| developer | public | Defines the tool developer info. Used by tools. | string |  |  |  Dédalo team |
| show_in_inspector | public | Defines if the tool will be see in inspector. Used only by tools to show his icon inside inspector. | bool |  |  |  true |
| show_in_component | public | Defines if the tool will be see at the top of the component in edit mode. Used only by tools to show his icon inside toolbar of the component. | bool |  |  |  true |
| config | public | Defines the section tool configuration. Used only by tools, it set the target section that will used by the tool. | object |  |  |  {"source_model": "section_tool", "source_section_tipo": "oh81", "target_section_tipo": "rsc167"} |
| tool_config | public | Defines the tool configuration. Used only by tools to retrieve or modify tool settings. | object |  |  |  {"tool_transcription": {"ddo_map": \[{"mode": "edit", "role": "media_component", "tipo": "rsc35", "section_id": "self", "section_tipo": "rsc167"}]}} |
| sortable | public | Used by components to define whether the component could rearrange its data. | bool |  true \| false  | |  false |
| fields_separator | public | Used by component_portal to define the separator character/s between fields when the data of the component will be join as text. Ex: Doe, John (surname - field separator - name) | string |  | ", " |  ", " |
| records_separator | public | Used by component_portal to define the separator character/s between records(rows) when the data of the component will be join as text. Ex: Doe, John \| Onielfa, Paco (surname - field separator - name - records_separator - surname - field separator - name ) | string |  | " \| " |  " \| " |
| limit | public | Output pagination slice for this ddo's component. A relation/portal always loads **all** its references (for correct sorting) and then slices the returned rows to this number; `limit` sets `pagination.limit` server-side. `0` = all rows (the read-equivalent of the portal "show all"). See [How a ddo_map resolves](#how-a-ddo_map-resolves-the-chain). | int |  | portal mode default (list 1 / edit 10) | 0 |
| offset | public | Output pagination offset for this ddo's component, paired with `limit`. | int |  | 0 | 0 |
| column_id | public | The grid column this ddo fills (ties a ddo to its `columns_map` entry). A portal's columns are declared as **sibling ddos** that share the portal's `parent` and each carry a `column_id` (`a`, `b`, `c`…). | string |  |  | a |
| with_value | public | Per-ddo mode/view override applied only when the component has data (e.g. render a relation as a compact line when populated). | object |  |  | {"mode":"list","view":"line"} |
| fixed_mode | public | When true, the ddo/ontology `mode` wins over the active section_record mode — the column renders in its declared mode regardless of the surrounding context. | bool | true \| false | false | true |
| autoload | public | Used by tools | boolean |  |  | false |
| role | public | Used by tools | string |  |  | 'main_component' |
| section_map | public | Used to point specific components into common definitions | object |  |  | {"thesaurus": {"term": "hierarchy25", "model": "hierarchy27", "order": "hierarchy48", "parent": "hierarchy36", "is_indexable": "hierarchy24", "is_descriptor": "hierarchy23"}} |
| color | public | Used by sections | string |  |  |  #dddddd |
| matrix_table | public | Used by components to modify show_interface values | string |  |  | matrix_list |
| relation_list | public | Used to know the legacy model defined in ontology. In v6 some models was unified as component_autocomplete, component_autocomplete_hi, component_autocomplete_ts were convert to component_portal, legacy model store his old model for compatibility with v5 in some situation as publishing. | string |  |  |  component_autocomplete_hi |

### Additional properties

The following properties are attached dynamically, not declared in the whitelist above, when a build path needs them. The outgoing **context** object built by `src/core/resolve/structure_context.ts` (and related resolve modules such as `section_elements_context.ts`, `menu.ts`, `area/read.ts`) is a plain, looser object that carries these fields ad hoc — only the narrower, client-INPUT `ddoSchema` (`src/core/concepts/ddo.ts`, covering the properties table above) is a strict zod whitelist; the richer outgoing context shape is not (yet) similarly typed:

| Property | Type | Description | Example |
| --- | --- | --- | --- |
| features | object | Container for custom properties, e.g. `notes_publication_tipo` in a text area. | `{"notes_publication_tipo": "..."}` |
| toolbar_buttons | array | Toolbar buttons attached to the node. | `["button_save"]` |
| value_with_parents | bool | Whether the value is rendered together with its ancestor chain. | `true` |
| search_operators_info | array | Search operator metadata for the element (set during the request_config build). | |
| search_options_title | string | Title for the search options, derived from `search_operators_info`. | |
| target_section_tipo | string | Resolved target section tipo for the ddo. | `rsc197` |
| debug | object | Debug payload, attached under debug conditions. | |

## How a ddo_map resolves (the chain)

`src/core/section/read.ts` (`emitDdoData()`) resolves direct children; related-component expansion happens in `src/core/relations/relation_core.ts` (`expandPortal`), dispatched through `src/core/relations/registry.ts`.

A `show.ddo_map` is **not** a flat list of independent columns — it is a set of resolution *chains* linked by `parent`. When the server hydrates a record's data, `emitDdoData()` walks the map like this:

1. **Top-level ddos** (whose `parent` is the section itself) resolve directly to that section's components. For a literal component, its value is read and returned in the response `data`.
2. **A relation/portal ddo** resolves specially:
   - The portal **regenerates its own `request_config`** server-side (`buildRequestConfigForElement()` in `src/core/relations/request_config/build.ts`). A `request_config` / `sqo` / `show` you attach **to the portal ddo itself is not read** — the portal owns that config (it comes from the ontology / its own resolution).
   - Its **columns are the *sibling* ddos** whose `parent` equals the portal's `tipo` (`getDirectChildren()`/`getDescendants()` in `src/core/concepts/ddo.ts`) and grafted into the rebuilt config's `show.ddo_map`. So a portal's columns are declared as **flat siblings carrying `parent: <portal_tipo>` + `column_id`**, *not* nested inside the portal ddo.
3. From each ddo the resolver reads a **fixed, small set of fields**: `tipo`, `section_tipo`, `parent`, `model`, `mode`, `view`, `lang`, and **`limit`** (the only one that maps to `pagination.limit`). Other keys placed on a ddo — a nested `request_config`, `sqo`, `sqo_config`, `pagination` — are **not consulted** at this stage.

**Pagination here is an output *slice*, not a fetch limit.** A relation/portal always loads **all** of its references (so they can be sorted) — `src/core/relations/relation_core.ts` loads the full locator array and only then slices the returned rows to `pagination.limit`. The per-ddo `limit` sets that slice; the portal mode default is **1 (list) / 10 (edit)**, and **`limit: 0` returns every row** — the read equivalent of the portal's "show all" button. Because the rows are already loaded, a `limit: 0` on a nested portal ddo simply returns all of them in the **same single read** (used by `tool_print` to render a record's full portal grids without per-portal calls).

> **Practical consequence:** to control a nested portal in one read you can change its `mode`, its columns (sibling ddos), and its `limit` — but you cannot inject a whole alternative `request_config`/`sqo` for it; that is server-derived.

## Client-sent ddos: the security whitelist

The whitelist IS the zod schema, `ddoSchema`/`ddoMapSchema` in `src/core/concepts/ddo.ts` — `z.object()` strips any key not declared, so the schema doubles as the sanitizer (`sanitizeClientDdoMap()` is also exported for direct reuse). It is embedded in the RQO shape itself (`rqoDdoBlockSchema` in `src/core/concepts/rqo.ts`), so the whitelist is enforced **at the wire boundary**, before an RQO is even accepted, rather than in a separate downstream scrub step.

ddos that originate in the **ontology** (server-side, trusted) may use the full property set above. ddos sent **by the client** — in `rqo->show.ddo_map` / `rqo->search.ddo_map` (time machine, graph view, search presets, `tool_print`, …) — are **untrusted** and reduced to a whitelist *before* they reach the request_config build. Any field not on the list is stripped:

`typo`, `tipo`, `section_tipo`, `section_id`, `parent`, `mode`, `lang`, `view`, `label`, `fields_separator`, `records_separator`, `value_with_parents`, `column_id`, `width`, `in_mosaic`, `hover`, **`limit`**, **`offset`**.

`limit` / `offset` are accepted **only as non-negative integers** (any other shape is dropped). They control only the *output slice* of an already permission-resolved, fully-loaded component — they are **not** a permission boundary — so a client may legitimately request all rows of a portal it can already read (`limit: 0`), exactly as the UI "show all" does. `model`, `permissions` and other server-authoritative fields are deliberately **absent** from the whitelist — they are recomputed and enforced server-side. `show.ddo_map`, `search.ddo_map` **and** `choose.ddo_map` all wrap the same `rqoDdoBlockSchema`, so the whitelist applies uniformly to all three blocks.

### `properties.show_interface` on a client-sent ddo

`properties` is not on the whitelist, so the server never receives a client ddo's `properties`. A page that builds its own form can still choose which buttons its fields draw: it declares `properties.show_interface` on the ddos of the `request_config` it hands to a section, and the **client** applies it (`apply_caller_show_interface` in `client/dedalo/core/section_record/js/section_record.js`) when the section creates each field. The server contract above is unchanged. `show_interface` only decides what the browser draws; permissions are separate and enforced by the server.

The rules:

- only fields of a **section** (portals and services are not affected), declared in the main Dédalo item's `show.ddo_map`;
- the ddo must match the field by `tipo`, `section_tipo` (`'self'` or absent = the row's section; an array = any of them) and `parent` (`'self'` or absent = the row's section);
- only the `show_interface` key is taken, and only when it is an object; any other `properties` key is ignored;
- **the field's own configuration wins**: every key it already defines (its `request_config` `show.interface`, overlaid by its `properties.show_interface`) is kept, and the declaration only fills the keys left unset.

The export and search preset editors and `tool_user_admin` use it to hide the tool buttons (`{"tools": false}`) on their fields:

```json
{
  "tipo": "dd624",
  "section_tipo": "dd1781",
  "parent": "dd1781",
  "properties": { "show_interface": { "tools": false } }
}
```
