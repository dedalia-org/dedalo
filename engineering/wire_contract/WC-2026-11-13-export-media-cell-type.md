# WC-2026-11-13-export-media-cell-type — export `cell_type` of media leaves: `img` only for images, `av` for av / 3d, `text` for pdf / svg (PHP: `img` for every media model)

- **Date:** 2026-11-13.
- **Decision:** owner ruling C45 (`T1_owner_decisions.md`, 2026-11-13; item
  T1-39 D3): "keep TS + write the WC". No behaviour change — this entry records
  a divergence that shipped undocumented (the code comment called the TS
  mapping "PHP defaults", which was false; corrected). Gates (unchanged):
  `test/unit/tool_export_cells_native.test.ts` (the client oracle renders `img`
  / `av` cells as media, everything else as text), the writers' gates.
- Code: `src/diffusion/export/atoms.ts` `cellTypeOfModel`.

## Shape before (PHP)

Every media model's export atom carried `cell_type: 'img'`:
`component_media_common::get_export_value` `:369`, `component_av` `:279`,
`component_3d` `:226` (pdf / svg through the media_common base). The legacy
client's flat table drew an `<img>` for each — a `<img src="…mp4">` for a
video, `…pdf` for a document, a model file for 3D: broken images in the HTML
download, a URL in the delimited files either way.

## Shape after (TS)

`cellTypeOfModel(model)`:

| leaf model | cell_type | the writers / client |
|---|---|---|
| `component_image` | `img` | media cell: URL → `<img>` in the HTML download, URL text in CSV/TSV/XLSX/ODS |
| `component_av`, `component_3d` | `av` | media cell too (cells.ts `isMediaCell`: `img` or `av`): URL cell, no `<img>` |
| `component_pdf`, `component_svg` | `text` | plain URL text (a reader opens it) |
| `component_iri` | `iri` | link cell (http(s) → `<a>`, else text) |
| `component_section_id` | `section_id` | the typed int |
| everything else | `text` | |

The URL itself (`config.media.exportBase` + the default-quality `file_path`) is
the same in both engines; only the `cell_type` the client / writers switch on
differs.

## Reason

`cell_type` is a rendering hint for the flat table and the HTML writer: `img`
means "draw me", and only an image can be drawn. PHP's uniform `img` produced
broken `<img>` elements for every non-image medium.

## Gate reconciliation

No frozen fixture carries an export `cell_type` (the harvest never exported a
media column). `tool_export_cells_native` pins the client ⇄ server rendering of
every `cell_type` value; nothing flips.
