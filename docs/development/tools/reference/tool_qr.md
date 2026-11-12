# tool_qr

A base/build sample tool that renders the current section selection as a printable A4 sheet of QR codes — one per record, each linking back to its Dédalo page. Not for production use; ships as a reference implementation.

!!! warning "Sample, not a production tool"
    `tool_qr` is a worked example of a **UI-only** tool with a `ddo_map`-driven render, not a supported feature. It ships no `server/` package. `tool_dev_template` is the production-shaped scaffold to copy when building a real tool (see [Creating new tools](../creating_tools.md)).

## What it does / why & when to use it

`tool_qr` takes the records currently selected in a section list and draws each one on an A4 print canvas as a QR code plus a small info card (an identifying image, the `section_id`, and a label). The QR encodes the record's own Dédalo page URL (`…/page/?tipo=<section_tipo>&section_id=<section_id>`), so scanning it reopens that exact record. The canvas can be flipped between portrait and landscape and is styled for printing (the tool header, info bar and footer are hidden under `@media print`, each card avoids page breaks).

Concrete heritage scenario: a museum stores numismatic objects in trays in a warehouse. A cataloguer filters the *Inventory* section down to a tray's worth of coins, opens the QR tool from a configured button, prints the A4 sheet, and cuts out the labels. Each physical coin slot now carries a QR sticker showing a thumbnail and inventory number; scanning it on a phone jumps straight to that coin's record for easy location and verification. This is exactly the use the tool's own registration description records: *"Creates QR codes for records. Used to print labels with item information for easy location in the warehouse."*

Use it as: a starting skeleton when you need a tool that reads a section's selection and renders something custom client-side, or as a demonstration of the `ddo_map` button-trigger surfacing pattern. Do not depend on it as shipped functionality.

## How it works (server + client)

**Server.** `tools/tool_qr/` ships **no `server/` package** — confirmed: there is no `tools/tool_qr/server/` directory. All behavior is client-side; the tool never calls `tool_request`.

**Client** (`tools/tool_qr/js/`):

- `index.js` re-exports the tool; `tool_qr.js` is the instance, wired to the standard `tool_common` lifecycle (`init` / `build` / `render`, `edit` from `render_tool_qr`).
- `init()` calls `tool_common.prototype.init` and then dynamically imports the QR library from the client-lib registry, `/dedalo/lib/qrcode/dist/easy.qrcode.min.js` — the pinned `easyqrcodejs` package ([EasyQRCodeJS](https://github.com/ushelp/EasyQRCodeJS)), registered in `src/core/client_libs/registry.ts`.
- `build()` calls `tool_common.prototype.build` (which loads the `ddo_map`) and then `load_section()`: it resolves the caller's element context via `data_manager.get_element_context`, takes the `dedalo`-engine `request_config`, **overwrites its `show.ddo_map`** with the tool's `ddo_map`, and **forces `sqo.limit = 0` / `sqo.offset = 0`** so the whole selection is loaded (no pagination). It then builds a `section` instance in `list` mode and records `section.total`. The `ddo_map` source is `'button_triger'` by default — i.e. the map comes from the **button's** `tool_config` rather than the section-list properties, so per-section user access can be controlled by the button.
- `render_tool_qr.js` builds the DOM: an `info_container` (section label, total records, a portrait/landscape `<select>`) and a `qr_canvas` of `qr_wrapper` cards. For each record it composes the page URL, draws the QR with `generate_qr()` (an EasyQRCodeJS `QRCode` rendered through `dd_request_idle_callback`), and fills the info card from the `ddo_map`: entries with `role:'image'` render the image component, entries with `role:'label'` render the label component (both pulled from `section.datum.data` by `tipo` + `row_section_id`). Optional `config.options.host` overrides the URL host and `config.options.entity_logo` adds a logo image.
- `worker_qr.js` is a commented-out Web Worker variant of the QR generation (kept as a reference; not used by the active code path, which renders on the main thread).
- `css/tool_qr.less` styles the A4 canvas (21cm × 29.7cm, landscape 29.7cm wide) and the print media query.

## Actions & options

`tool_qr` has **no API actions** — it is UI-only.

| Action | Permission gate | Background | Reads from `options` |
| --- | --- | --- | --- |
| *(none)* | — | — | — |

*(no server module)*. Any attempt to call an action on this tool through `dd_tools_api` is refused at dispatch gate 5 (`tool has no server module`) — there is nothing to dispatch to.

What the **client** reads instead of action options:

| Source | Field | Meaning |
| --- | --- | --- |
| caller | `caller.tipo`, `caller.section_tipo`, `caller.model`, `caller.lang` | the element the tool was opened from; used to load the section selection |
| `tool_config` (from the button / section properties) | `ddo_map` | the columns to render. Entries flagged `role:'image'` become the card image; `role:'label'` become the card label |
| tool `config` | `options.host` | overrides the host in the generated page URL (default: `window.location.origin`) |
| tool `config` | `options.entity_logo` | optional logo image URL drawn on each card |
| `properties` | `open_as`, `windowFeatures` | UI hint: opens in its own window |

## How it is registered & surfaced

`tools/tool_qr/register.json` is a **column-keyed dump** (`string`/`relation`/`misc`/… keyed by component tipo — a seeded matrix-row snapshot, not a hand-authored file); `importTools()` passes it through as-is (see [register.json reference](../register_json.md)). The essentials it carries:

- `dd1326` name = `tool_qr`; `dd1327` version (`1.0.1`); `dd1328` minimum Dédalo version (`6.2.8`); `dd1644` developer = *Dédalo team*; `dd799` label = `QR`.
- `dd1335` properties = `{ "open_as": "window", "windowFeatures": null }` → opens in its own window.
- `dd612` description and `dd1362` implementation notes (the implementation field documents the `tool_config` / `ddo_map` button-trigger pattern in detail).

Surfacing. `tool_qr` is **not** attached by `affected_models` / `affected_tipos`. It surfaces through the **`properties->tool_config` path** in the section/component tool filter: an element (typically a section, via a **button trigger** under `tch350`-style config) names the tool in its `properties.tool_config.tool_qr` and supplies the `ddo_map` there. Because the trigger lives on a button, access can be scoped per section; placing the button on a parent virtual section (e.g. as a child of `tch7`) makes it operative for all that section's virtual children (`tch100`, `tch200`, `tch300`, …). The tool is therefore opened from a **section list**, not from the inspector or inline on a component.

## Examples

There is no `tool_request` to show (no server actions). The tool is enabled by declaring it in an element's `properties.tool_config`, e.g. on a button trigger for section `tch1`:

```json
{
  "tool_config": {
    "tool_qr": {
      "ddo_map": [
        {
          "mode": "list",
          "tipo": "tch66",
          "typo": "ddo",
          "view": "mosaic",
          "label": "Identifying images",
          "model": "component_portal",
          "parent": "tch1",
          "section_tipo": "tch1"
        },
        {
          "mode": "list",
          "role": "image",
          "tipo": "rsc29",
          "typo": "ddo",
          "view": "list",
          "label": "Image",
          "model": "component_image",
          "parent": "tch66",
          "section_tipo": "rsc170"
        },
        {
          "mode": "list",
          "role": "label",
          "tipo": "tch63",
          "typo": "ddo",
          "view": "list",
          "label": "Title",
          "model": "component_input_text",
          "parent": "tch1",
          "section_tipo": "tch1"
        }
      ]
    }
  }
}
```

`role:'image'` flags the ddo the card renders as its thumbnail; `role:'label'` flags the ddo rendered as the card title. For a button shared across virtual sections, use `"parent": "self"` and `"section_tipo": "self"` on the section-owned entries so the same config works for `tch1`, `tch100`, `tch200`, `tch300`, … (children of `tch7`).

Optional per-tool config (dd996 / register `default_config`) to override the QR URL host and add a logo:

```json
{
  "options": {
    "host": "https://my.museum.org/",
    "entity_logo": "https://my.museum.org/logo.svg"
  }
}
```

## Related

- [Creating new tools](../creating_tools.md) — `tool_qr` is a hand-on skeleton for this tutorial; the production-shaped scaffold is `tool_dev_template`.
- [Server contract](../server_contract.md) · [Security](../security.md) — why a UI-only tool is refused cleanly at dispatch even with no `server/` package at all.
- [JS lifecycle](../js_lifecycle.md) — the `init` / `build` / `render` / `edit` flow `tool_qr` follows and the `ddo_map` it consumes.
- [tool_export](tool_export.md) — the other section-selection tool; if you actually need to get section data *out* (CSV/TSV/XLSX/round-trip), use export, not QR. See [Exporting data](../../../using/exporting_data.md).
- [Tools catalog](index.md) — full list of shipped tools.
- Source: `tools/tool_qr/register.json` (no `server/` package), `tools/tool_qr/js/{index,tool_qr,render_tool_qr,worker_qr}.js`, `tools/tool_qr/css/tool_qr.less`; the QR library is the pinned `easyqrcodejs` package (client-lib id `qrcode`).

