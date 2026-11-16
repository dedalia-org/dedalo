# WC-2026-11-12-duplicate-image-svg-envelope — a duplicated record's image gets its own SVG envelope, layers kept

- **Date:** 2026-11-12 (T1-22, audit OX3).
- **Decision:** a duplicate REBUILDS each `component_image` envelope for the clone — the
  source's envelope file, else its `svg_file_data`, else the default template — with every
  drawing layer kept and the raster href repointed at the clone; the clone's `svg_file_data`
  is that rebuilt envelope, never the source's string, and its `lib_data` raster layer
  (layer 0's `<image>`, the href the vector editor loads its raster from) names the clone's
  raster too (amended same day, T1-22 review).
- **Reason:** the edit view loads an image through its envelope (`base_svg_url`); without
  one it shows the placeholder. And a row naming another record's raster is the defect class
  WC-2026-09-30 closed for `files_info`: every later media save of the clone re-wrote the
  envelope from that string (`persistSvgEnvelopesForKeys`), so the clone displayed the
  SOURCE's picture.

## Shape before (PHP, frozen v7 and v6)

`section_record::duplicate` (v6 `section::duplicate_current_section`) copied the quality
files, then `regenerate_component` on the target: no envelope ⇒ the DEFAULT template
(raster only). The clone's data was rebuilt from its files — no `lib_data`, no
`svg_file_data`. Annotation layers were lost on the clone.

## Shape before (TS, to 2026-11-12)

No envelope at all (it is no `managedFileSlots` slot, the rescan never builds one) ⇒
`base_svg_url: null`, placeholder. The source item's `svg_file_data` was inserted and
historied verbatim: its `<image xlink:href>` names `…/<tipo>_<section>_<sourceId>.jpg`. So
did the copied `lib_data` layer 0 `<image>` (`href`/`xlink:href`), and the clone's vector
editor loaded the SOURCE's raster until someone saved from the editor.

## Shape after (TS)

`media/svg_overlay.ts duplicateSvgEnvelope`, called per drawable item lang from
`duplicate_record.ts` step 4b (before the locked media-key transform):

1. clone holds no media file ⇒ nothing (policy 2026-10-23, no wrapper for an empty record);
2. the source envelope ON DISK (what is displayed; repair repoints the file only), else the
   source item's `svg_file_data` ⇒ first `<image>` href repointed to the clone's
   default-quality raster URL (href only — the raster is a byte copy, size unchanged), written
   through `writeSvgEnvelope` (atomic, confined, 8 MB cap, `ENVELOPE_REFUSALS`);
3. neither ⇒ `createDefaultSvgFile` (PHP regenerate parity, sized from the raster).

The clone row is INSERTED without `svg_file_data` (`stripSourceIndex`, same law as
`files_info: []`, so even a crash after the insert names nothing of the source); the
transform then sets `svg_file_data` = the content written in 2, for items whose source
carried it. History rows record the written items. External items untouched.

`lib_data` (component_image, T1-22 review): the same two steps for the vector editor's
raster layer — `stripSourceIndex` inserts each layer-0 `<image>`'s `href`/`xlink:href`
(whichever keys it carries) EMPTIED, and the transform sets them to the clone's
default-quality raster URL for the item's lang (the URL the editor's save handler writes).
Drawing layers and every other attr verbatim; a non-array `lib_data` (component_pdf
`{offset}`) untouched. A clone left without the transform (no media root, a `missing` /
`locked` stage) keeps the emptied href — it names no record; the editor's save restores
it.

A refused or failed envelope is a VERDICT, never a throw: `MediaCopyVerdict.stage =
'envelope'` (precedence copy > rescan|missing|locked > envelope > count), logged
`media.operation_failed`, counted `duplicate_media_incomplete`; the clone keeps `lib_data`
(the layer source of truth) and no `svg_file_data` for that lang. Known refusal: a PHP-era
envelope starting with an `<?xml` prolog fails the `^\s*<svg` check — the clone gets the
`envelope` verdict, and Update cache (regenerate) gives it the default envelope.

Wire: `dd_core_api.duplicate` response unchanged; a clone's read now carries a non-null
`base_svg_url`. No fixture edit.

Gates: `test/unit/duplicate_record_media_verdict_native.test.ts` I–M (annotated file copied +
repointed; row/history never name the source raster, with and without a media root;
`svg_file_data` fallback; default envelope, ImageMagick; hostile payload ⇒ `envelope`
verdict) and N (`lib_data` raster href repointed, `href` and `xlink:href`, drawing kept,
row + history + rootless), `test/unit/media_lifecycle_native.test.ts` (`repointEnvelopeHref`).
