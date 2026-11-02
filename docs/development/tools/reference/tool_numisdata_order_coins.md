# tool_numisdata_order_coins

A two-panel, drag-and-drop tool for numismatics: sort a lot's coins by weight or diameter, drop them into an authoritative order, and mark originals versus copies. UI-only, no server module.

## What it does / why & when to use it

`tool_numisdata_order_coins` curates a **lot** of coins. The left panel is a mosaic of every coin in the lot; the right panel is the ordered sequence. You re-sort the mosaic by measurement, drag coins into the right panel to fix their catalogue order, and use the header action to designate which coins are originals and which are copies (recording the copy → original equivalences). All of this is written straight into the coins' own components — there is no bespoke storage.

Concrete heritage scenario: a numismatist catalogues a hoard as a single lot. They open the tool, sort the mosaic by weight to spot die matches, drag the coins into publication order in the right panel, then select the genuine strikes as *originals* and the duplicates as *copies* so the record set carries the equivalence relations. Because every write goes through the normal component save path, each change is itself audited and reversible from the [time machine](tool_time_machine.md).

Use it when: you are ordering and grouping numismatic objects and marking original/copy relationships. It is domain-specific to the numismatics data model (the `numisdata*` tipos below) and does not apply to other sections.

## How it works (server + client)

**Server.** `tools/tool_numisdata_order_coins/` ships **no `server/` package** — there is no `server/` directory. All behaviour is client-side; every write reuses the standard component `change_value` path (which dispatches its own `dd_area_*` save actions), so the tool defines no `apiActions` of its own.

**Client** (`tools/tool_numisdata_order_coins/js/`):

- `tool_numisdata_order_coins.js` is the instance (standard `tool_common` lifecycle). On `build()` it resolves two named roles from `self.tool_config.ddo_map`:
  - `coins` — the source portal, rendered as a mosaic (`view_coins_mosaic_portal.js`, view `coins_mosaic`) of every coin in the lot.
  - `ordered_coins` — the destination relation portal that holds the ordered sequence.
  A missing role is skipped with a console warning rather than throwing.
- `render_tool_numisdata_order_coins.js` builds the two-panel layout, the header buttons (**Order by: Weight / Diameter**, **Set Original / Copy**), and an activity strip that shows save notifications. `get_ordered_coins()` (re)builds the right panel and calls `bind_ordered_coins_drop()`, which puts ONE delegated listener set on the panel's wrapper: the `.column_numisdata9` cells of its rows (`ORDERED_COINS_SLOT`) are the drop targets, resolved per event (`drop_target_of`: the row by `row_of`, its record by the row window's `record_at`).
- **Sorting** reads `self.coins.datum.data`, filters items by the chosen measurement tipo (`numisdata133` weight, `numisdata135` diameter), sorts them numerically ascending with null values pushed to the end, maps the order back onto the coin locators, and rebuilds the mosaic in place. Toggling a sort button off restores database (`section_id`) order.
- **Drag-and-drop.** The mosaic is a tool row source: its rows are placed by the record window (see [The row box](../../../core/sections/section_list.md#the-row-box)), the window stamps every built tile `draggable`, and `bind_tool_row_drag` (`drag_and_drop.js`) puts ONE delegated `dragstart` (plus the touch tap-to-pick) on the mosaic's `content_data`. The payload is the row's entry, as JSON in `text/plain` only — never the portal row type, so every portal treats it as foreign. Dropping (or tap-placing) onto an `ordered_coins` cell calls `assign_element`, which issues an `insert` `change_value` on that cell's component instance; the right panel is then rebuilt and the dragged tile is marked `used`. A tile's hover detail panel is built on demand by `delegate_row_hover`, one at a time.
- **Original / Copy** (`set_original_copy`) reads the checked radio inputs (`input.input_original` / `input.input_copy`) from the mosaic and, per selected coin, writes:
  - `numisdata157` (discard/status component) — an `update` to `{ section_id: 1, section_tipo: 'numisdata341' }` for an original, or `{ section_id: 2, section_tipo: 'numisdata341' }` for a copy (section_id `1`/`2` of `numisdata341` are the original/copy code values).
  - `numisdata55` (equivalents, `component_relation_related`) — a `set_data` on each **original** with the locators of every selected copy.

!!! note "Developer caveats in the current client"
    Two known issues are flagged in the source and left as-is: a persistent `window_bur_` vs `window_blur_` event-name typo means one portal-refresh subscription never fires, and the equivalents write passes `lang: 'lg_nolan'` (underscore) rather than the canonical `lg-nolan`. Neither breaks the primary drop/order/original-copy flow.

## Actions & options

`tool_numisdata_order_coins` has **no API actions** — it is UI-only.

| Action | Permission gate | Background | Reads from `options` |
| --- | --- | --- | --- |
| *(none)* | — | — | — |

*(no server module)*. The tool's writes are the component save calls it triggers (`change_value`), each gated by the component's own save path, not by a tool action. What the client reads instead of action options:

| Source | Field | Meaning |
| --- | --- | --- |
| `tool_config` | `ddo_map` (roles `coins`, `ordered_coins`) | the two portals the tool drives |
| `caller` | `caller.lang` | seeds `source_lang` |
| `properties` | `open_as`, `windowFeatures` | UI hint: opens in its own window |

Components the client operates on: `numisdata133` (weight), `numisdata135` (diameter), `numisdata9` (the ordered-item drop column), `numisdata157` (discard/status), `numisdata55` (equivalents), with the code section `numisdata341` supplying the original/copy code values.

## How it is registered & surfaced

`tools/tool_numisdata_order_coins/register.json` is a **column-keyed dump** (`string`/`relation`/`misc`/… keyed by component tipo — a seeded matrix-row snapshot, not a hand-authored file); `importTools()` passes it through as-is (see [register.json reference](../register_json.md)). The essentials it carries:

- `dd1326` name = `tool_numisdata_order_coins`; `dd1327` version (`2.0.2`); `dd1328` minimum Dédalo version (`6.0.0`); `dd1644` developer (`Dédalo team`).
- `dd799` label = "Sorting numismatic objects" (localised); `dd612` description = "Grouping and sorting of numismatic objects".
- `dd1335` properties = `{ "open_as": "window", "windowFeatures": null }` → the tool opens in its own window.
- `dd1331` show_in_inspector and `dd1332` show_in_component both resolve to **no** (dd64 section_id `2`); `dd1354` active = **yes**. The register carries no `dd1330` affected_models relation, so the tool is not attached by model. It surfaces through the **`properties->tool_config` path**: a section names the tool and supplies the `ddo_map` (the `coins` and `ordered_coins` roles), and the tool opens in its own window from there.
- `dd1372` labels supply the localised UI strings: `order_by`, `weight`, `diameter`, `original`, `copy`, `original_copy`, `snap`, `types`.

## Examples

There is no `tool_request` to show (no server actions). The tool is enabled by declaring it in a section's `properties.tool_config` with the two roles:

```json
{
  "tool_config": {
    "tool_numisdata_order_coins": {
      "ddo_map": [
        { "role": "coins",         "tipo": "numisdata77", "section_tipo": "numisdata3", "section_id": "self", "mode": "edit" },
        { "role": "ordered_coins", "tipo": "numisdata11", "section_tipo": "numisdata3", "section_id": "self", "mode": "edit" }
      ]
    }
  }
}
```

This is the declaration of the `section_tool` node `numisdata670` (*Order*) on the numismatic install the page was checked against, trimmed of each entry's `properties` block: `numisdata77` (*Coins*) and `numisdata11` (*Ordered coins*) are both `component_portal` fields of the *Type* section `numisdata3`; the coins themselves are `numisdata4` records.

The drop payload a mosaic tile transfers, consumed by `assign_element`:

```js
// dataTransfer 'text/plain' payload set by bind_tool_row_drag (get_row_transfer_data)
{
  "locator"       : { "section_tipo": "numisdata4", "section_id": 1, "paginated_key": 0, … },
  "paginated_key" : 0,
  "source_tipo"   : "numisdata77",
  "source_id"     : "<the coins portal instance id>",
  "draggable_to"  : []
}
```

## Related

- `tool_numisdata_epigraphy` — the sibling numismatics tool for transcribing coin legends and epigraphic elements.
- [tool_time_machine](tool_time_machine.md) — where the individual component writes this tool makes (original/copy status, equivalences, ordering) can be reviewed and reverted.
- [Creating new tools](../creating_tools.md) · [JS lifecycle](../js_lifecycle.md) — the `init` / `build` / `render` / `edit` flow and the `ddo_map` this tool consumes.
- User guide: [Order coins](../../../tools/using_numisdata_order_coins.md).
- Source: `tools/tool_numisdata_order_coins/register.json` (no `server/` package), `tools/tool_numisdata_order_coins/js/{tool_numisdata_order_coins,render_tool_numisdata_order_coins,view_coins_mosaic_portal}.js`, `tools/tool_numisdata_order_coins/css/tool_numisdata_order_coins.less`.
