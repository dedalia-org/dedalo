# tool_cataloging

Two-pane drag-and-drop workspace for grouping and hierarchizing records: drag records from a source section (left) onto a thesaurus/ontology tree (right) to build a catalog hierarchy. UI-only.

## What it does / why & when to use it

`tool_cataloging` puts a **source section** (rendered as a mosaic, on the left) next to a **thesaurus area** (a hierarchical tree, on the right) so a cataloguer can organize loose records into a controlled hierarchy by dragging. When a record is dropped onto a tree node, the thesaurus creates a **new term** (a new section record) and the tool injects the dragged record's **locator into a portal component** of that new term. The result is a navigable catalog: real records become the leaves of a thesaurus tree.

The tool is **UI-only**: it declares **no** remotely callable methods. Every write it triggers goes through already-gated pipelines — the thesaurus tree mutation API (`dd_ts_api`) creates the term, and the term's `component_portal` saves the locator through its own `change_value()` (which calls the standard, write-gated component save path).

Concrete heritage scenario: a numismatic collection has hundreds of coin **types** stored as flat records, and a thesaurus of **mints** organized as a tree. A cataloguer opens this tool on the mints thesaurus, sees the unfiled types as a mosaic of cards on the left and the mint hierarchy on the right, then drags each type onto the mint that struck it. Each drop creates a thesaurus term under that mint and links the type record into it via a portal — building the "types inside mints" catalog. Cards already linked to a loaded hierarchy show a highlighted (`used`) drag handle, so the cataloguer can see at a glance what is still unfiled. A hover overlay on each card exposes edit/remove/info actions and an alternate (richer) record view.

Use it when: someone needs to assemble records from one or more source sections into a thesaurus/ontology hierarchy by hand, visually. Do not expect server actions on this class — it is a front-end orchestrator over a `section` (mosaic view), the `area_thesaurus`, the tree API and `component_portal`.

## How it works (server + client)

**Server.** `tools/tool_cataloging/` ships **no `server/` package** — the tool is client-only: there is no `server/index.ts` to load, so `dd_tools_api.tool_request` refuses any action named against this tool at dispatch gate 5, `tool has no server module`. There is no `isAvailable`/`onRegister`/`onRemove` override either. All persistence happens through other, already-gated endpoints (see *Actions & options*).

**Client** (`tools/tool_cataloging/js/`). Module entry `index.js` re-exports `tool_cataloging.js` (the instance), which uses `render_tool_cataloging.js` (window layout) and `view_tool_cataloging_mosaic.js` (a custom section view injected into the source section). The whole tool is driven by the element's `tool_config` — specifically `tool_config.ddo_map`, a list of role-tagged ddos resolved at `build()`:

| `ddo_map` `role` | Resolved into | Purpose |
| --- | --- | --- |
| `section_to_cataloging` | `section` (forced into the `tool_cataloging_mosaic` view) | The source records, shown as a draggable mosaic in the **left** pane. Loaded directly (not via the generic `tool_common` path, because it may be the caller, which `tool_common` skips). Its `context.css` is taken from the ddo's `properties.css`. |
| `area_thesaurus` | thesaurus area instance (matched by `tipo`) | The target tree in the **right** pane. The tool sets `area_thesaurus.caller = self` and `area_thesaurus.linker = self.indexing_component`. |

A third config key, `tool_config.set_new_thesaurus_value` (`{tipo, section_tipo}`), names the **portal component** of the newly created term into which the dragged locator is written — it is **required** for drops to persist; if missing, the tool logs an error and aborts the drop.

Layout (`render_tool_cataloging.js::edit`): a window built by `ui.tool.build_wrapper_edit`, with a CSS grid `content_data` split `left_container` (40%) / `right_container` (60%). The left container renders the section in the injected `tool_cataloging_mosaic` view; the right container renders the thesaurus tree. A `save`-event subscription feeds an activity-info panel that shows save notifications.

Mosaic view (`view_tool_cataloging_mosaic.js`): builds the section as a one-column list of draggable `section_record` cards. Columns are chosen from the section's `columns_map` by flags — `in_mosaic === true` for the card body, `hover === true` for the richer hover overlay; a synthetic `drag` column renders the drag handle. The cards are rows of the record window (see [The row box](../../../core/sections/section_list.md#the-row-box)): at most 200 are built at once, and the window stamps every built card `draggable`. `bind_tool_row_drag` (`drag_and_drop.js`) puts ONE delegated `dragstart` (plus the touch tap-to-pick) on the mosaic's `content_data`; it puts `{locator, paginated_key, source_tipo, source_id, draggable_to, caller:'tool_cataloging'}` into `dataTransfer` as JSON `text/plain` only, so every portal treats it as foreign and only the thesaurus term reads it. The hover overlay (`hover` columns) is built on demand, one card at a time, by `delegate_row_hover` (`section_record/js/row_hover.js`), and flushed before it leaves, so an edit in it is never dropped. The drag handle gets a `used` class when the record is already related to one of the loaded hierarchies (computed from the section's inverse-relations datum against the thesaurus's `hierarchy` nodes).

Drop flow (the heart of the tool): the **thesaurus** owns the drop target. When a record is dropped on a tree node, the thesaurus creates the new term (its own tree API call) and then publishes the `ts_add_child_tool_cataloging` event with `{new_ts_section, locator, callback}`. `tool_cataloging.js` subscribes on `init` and handles it:

1. read `set_new_thesaurus_value` from `tool_config`; abort with a console error if absent;
2. `get_instance` a `component_portal` for that `tipo` on the new term's `{section_tipo, section_id}` (lang `nolan`), then `build(true)`;
3. `component.change_value({changed_data:[{action:'insert', id:null, value:{section_id, section_tipo}}], refresh:false})` to insert the dragged record's locator (this saves);
4. on success, invoke the thesaurus `callback(response)` so the tree updates its node.

After the insert, and on every other signal that can change it (a term deleted or a link emptied in the tree), the tool re-reads the affected cards' incoming relations (`dd1596`, `used_state.js` `refresh_used_state`) and sets or clears `used` from the server's answer. The page's used records are one Set (`used_keys`); the row window marks every card it builds from it (its `decorate`), so a card built later by scrolling is marked too.

## Actions & options

This tool declares **no** API actions of its own:

| `apiActions` | Value |
| --- | --- |
| `tool_cataloging` | *(no server module)* — UI-only, nothing dispatchable on this tool |

The server-side work the client triggers goes through these **other** endpoints (each enforces its own gate). They are listed for completeness — they are *not* methods of `tool_cataloging`:

| Endpoint · action | Triggered by | Effect |
| --- | --- | --- |
| `dd_ts_api` (tree add-child) | A drop on a thesaurus tree node | Creates the new term (new section record) under the dropped-on node and publishes `ts_add_child_tool_cataloging`. Runs the tree's own transaction / node-lock / cycle-guard machinery. |
| `component_portal::change_value` → standard component save (`dd_section_api` / data_manager save path) | The `ts_add_child_tool_cataloging` handler in `tool_cataloging.js` | Inserts `{section_id, section_tipo}` of the dragged record into the new term's portal (the `set_new_thesaurus_value` component) and saves. Subject to the section write gate (level 2). |

Client-side `tool_config` keys this tool reads (all resolved from the element's `properties->tool_config`, not from a request envelope):

| Config key | Shape | Read in | Purpose |
| --- | --- | --- | --- |
| `ddo_map[]` with `role: 'section_to_cataloging'` | ddo (`mode`, `tipo`, `section_tipo`, `lang`, `section_lang`, `properties`) | `tool_cataloging.js::build` → `load_section` | Source section shown as the left mosaic. |
| `ddo_map[]` with `role: 'area_thesaurus'` | ddo (`mode:'relation'`, `tipo`, `section_tipo`, `properties.hierarchy_types`) | `tool_cataloging.js::build` | Target thesaurus tree (right pane), optionally filtered by hierarchy types. |
| `set_new_thesaurus_value` | `{ tipo, section_tipo }` | `ts_add_child_tool_cataloging` handler | The portal component of each new term that receives the dragged locator. **Required** for drops to persist. |

## How it is registered & surfaced

`tools/tool_cataloging/register.json` is a **column-keyed dump** (`string`/`relation`/`misc`/… keyed by component tipo — a seeded matrix-row snapshot, not a hand-authored file); `importTools()` passes it through as-is (see [register.json reference](../register_json.md)). Essentials it carries:

- `dd1326` name = `tool_cataloging`; `dd1327` version `2.0.2`; `dd1328` minimum Dédalo version `6.0.0`; `dd1644` developer = "Dédalo team".
- `dd799` label = *Cataloging of cultural properties* (localized across project languages); `dd612` description = "Grouping and hierarchization of cultural assets".
- `dd1335` **properties** = `{ "view": "tool_cataloging_mosaic", "open_as": "window", "windowFeatures": null }` → the tool opens in its own **window** and defaults the source-section view to the mosaic.
- The affected_models / affected_tipos / show_in_inspector / show_in_component / require_translatable / active flags (`dd1330` / `dd1350` / `dd1331` / `dd1332` / `dd1333` / `dd1354`) are present as **relations** to their ontology records in this v6 dump rather than as inline values, and there are **no** `affected_tipos` literals baked into the file.
- The `dd1362` "Implementation" note documents the configuration recipe verbatim: define a `ddo_map` whose right-pane ddo has `role: "section_to_cataloging"` and whose left/tree ddo has `role: "area_thesaurus"` (with `properties.hierarchy_types`), plus `set_new_thesaurus_value` naming the term's portal component.

Surfacing (in the section/component tool filter, `getElementTools` in `src/core/tools/registry.ts`): this tool is **not** restricted to a specific component tipo; in practice it is wired onto an element through that element's `properties->tool_config` (which supplies the `ddo_map` and `set_new_thesaurus_value` it cannot function without). It then opens as a standalone **window** (per `open_as: "window"`), not as an inspector panel or an inline component widget. Because all its behavior is client-side, it needs the source `section`, the `area_thesaurus`, the tree API and a target `component_portal` to be reachable in the project — there is nothing for it to dispatch on the server side.

## Examples

The tool is configured, not called: the element's `properties->tool_config` supplies the two roles and the portal target. A minimal config (paraphrasing the `dd1362` recipe in `register.json`):

```json
{
  "tool_config": {
    "ddo_map": [
      {
        "mode": "list",
        "role": "section_to_cataloging",
        "tipo": "numisdata27",
        "section_tipo": "numisdata27",
        "properties": { "css": { } }
      },
      {
        "mode": "relation",
        "role": "area_thesaurus",
        "tipo": "dd100",
        "section_tipo": "dd100",
        "properties": { "hierarchy_types": [8] },
        "section_id": null
      }
    ],
    "set_new_thesaurus_value": {
      "tipo": "numisdata656",
      "section_tipo": "numisdata665"
    }
  }
}
```

The only "action" at runtime is a drop, handled entirely client-side. Sketch of what the `ts_add_child_tool_cataloging` handler does after the thesaurus has created the new term (from `tool_cataloging.js`):

```js
// new_ts_section + dragged locator arrive via the event payload
const component = await get_instance({
    model        : 'component_portal',
    mode         : 'edit',
    tipo         : self.tool_config.set_new_thesaurus_value.tipo,
    section_tipo : new_ts_section.section_tipo,
    section_id   : new_ts_section.section_id,
    lang         : page_globals.dedalo_data_nolan,
    type         : 'component'
})
await component.build(true)

await component.change_value({
    changed_data : [Object.freeze({
        action : 'insert',
        id     : null,
        value  : { section_id: locator.section_id, section_tipo: locator.section_tipo }
    })],
    refresh : false
})
// → standard component save (write-gated); then thesaurus callback updates the node
```

## Related

- [Creating new tools](../creating_tools.md) · [Server contract](../server_contract.md) — the tool model, `apiActions` (including the no-server-module UI-only case), gates and lifecycle this page builds on.
- [tool_hierarchy](tool_hierarchy.md) — complementary thesaurus/ontology tool: it *generates* the virtual sections and hierarchy/general-term scaffolding that `tool_cataloging` then fills with real records by drag-and-drop.
- [tool_indexation](tool_indexation.md) — another UI-only, thesaurus-driven workspace (links text fragments to terms); same `ddo_map` + `area_thesaurus` + linker pattern.
- `tool_numisdata_order_coins`, `tool_numisdata_epigraphy` — sibling UI-only numismatic cataloguing tools (reference pages pending).
- [tool_export](tool_export.md) — contrast: a section tool with a real dispatchable action; see [Exporting data](../../../core/exporting_data.md).
- Subsystems the client drives: the thesaurus/ontology tree (`src/core/ts_object/`, `dd_ts_api` registered in `src/core/api/dispatch.ts`, the `ts_add_child_tool_cataloging` event), `component_portal` (locator storage; `src/core/relations/models/portal.ts`), and the `section` mosaic view.
- Source: `tools/tool_cataloging/register.json` (no `server/` package), `tools/tool_cataloging/js/{index,tool_cataloging,render_tool_cataloging,view_tool_cataloging_mosaic}.js`, `tools/tool_cataloging/css/tool_cataloging.less`.
