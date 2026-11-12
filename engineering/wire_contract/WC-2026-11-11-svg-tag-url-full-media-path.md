# WC-2026-11-11-svg-tag-url-full-media-path — an `[svg-…]` tag's glyph URL is the locator's full media path, in every audience

- **Date:** 2026-11-11 (T0-10, audit D03; owner decisions 2026-11-11).
- **Decision:** one producer of the media path grammar (`media/path.ts buildMediaLocation`,
  the `media_thumb_census_tripwire` precedent); WC-042's audience split unchanged.
- **Reason:** the glyph `<img src>` is fetched by a browser — the engine's own client for a list
  cell, a public visitor for a published page. A URL that is not the file's real address is a
  broken image with nothing in any log. The client cannot repair it (it renders the html it is
  given), and the path depends on ontology properties and a record value only the server reads;
  so the server must emit the exact file address, from the same producer that writes the file.

## What was wrong

A text tag `[svg-n-1-…-data:{'section_tipo':…,'section_id':…,'component_tipo':…}:data]`
renders to `<img class="svg" src="…">` in three places. Two of them — the LIST read
(`component_text_area/emit.ts`) and the PUBLISHED cell (diffusion `parse_tag_to_html`) — built
the src from a pure grammar twin, `folder/quality/<component>_<section>_<id>.svg`: no section
`initial_media_path`, no `max_items_folder` bucket, no record `additional_path` folder, and the
model hard-coded to `component_svg`. The tag endpoint (edit view, 302) did use
`buildMediaLocation`, but section-scoped, so `additional_path` was never honoured there either.
Any glyph whose component stores in a bucket (master `rsc855`, `max_items_folder: 1000` +
`additional_path`) 404'd in list cells and in published HTML. Latent on installs whose tags all
point at `hierarchy95` (no bucket properties) — the URL was right by coincidence.

## Shape before (PHP)

`component_svg::get_url_from_locator` (:426-462) instantiates the locator's OWN model,
record-scoped, and calls `get_url()` = `MEDIA_URL + folder + initial_media_path + '/' + quality +
additional_path + '/' + file` (`TR.php:367`). A non-media model → `null` (src="").

## Shape after (TS)

ONE resolver, `src/core/media/tag_locator.ts resolveTagLocatorMediaPath`: shape gate (§7.6) →
the locator's model → `mediaTypeOf` (non-media → null) → RECORD-scoped
`resolveMediaPathOptions(component, section, id)` → `buildMediaLocation(...).relativePath`.
The three consumers differ only in the base (WC-042):

- endpoint 302 and list cells: `config.media.webBase + path`;
- published cells: `/dedalo/<mediaDir> + path`.

So a list/published src now carries `/<initial_media_path>`, the bucket (`/0`, `/1000`, …) or
the record's named folder — the PHP bytes. A non-media locator, or a mark whose path cannot be
built (no media root, an `additional_path` value refused by `normalizeAdditionalPath`), renders
`src=""` and is logged with its coordinates (`logError`; `media.not_configured` once per read /
run); the read / the publication never fails for one glyph. One text resolves at most 64 distinct
NEW locators (`SVG_TAG_RESOLUTIONS_PER_TEXT` — the 16 KB source cap bounds bytes, not record
reads); marks past it render `src=""` with ONE warning per text naming the counts.
`normalizeAdditionalPath` now also refuses `"`, `<`, `>`: the folder lands in an `src`
attribute, and the published render entity-decodes its output, so a quote would close it. Endpoint: unchanged except `additional_path` is now honoured. `additional_path` is read
unscoped by principal (PHP parity — the folder is a path segment; the file stays
web-server-guarded).

Rows already PUBLISHED by the old engine with a bucketed target hold the old URL until the
section is re-published (changelog; no census — owner decision 1).

## Gate reconciliation

`test/unit/text_area_svg_tag_path_native.test.ts` (suite DB, `test177`/`test3` + scratch TLD
`zzsvgpath`): list read, `parseTagValueToHtml` and the endpoint against hand-written tails, the
`max_items_folder`, `initial_media_path`, `additional_path` (value and empty) axes, a non-media
model, refused folders (`..`, a `"` breakout), the per-text bound (G4); the URL each audience
RETURNED for G1 is resolved against the suite media root and must hit a planted file. Red on
the pre-fix code. `text_area_svg_split_origin.test.ts` renders the published side through
`ddo_fns.ts parseTagValueToHtml`, so a wrong audience there is red.
`test/unit/diffusion_ddo_fns.test.ts` keeps the `hierarchy95` bucketless bytes (= the PHP
harvest). **Re-harvest: NO** — the frozen store holds only `hierarchy95` tags, whose bytes do not
move.
