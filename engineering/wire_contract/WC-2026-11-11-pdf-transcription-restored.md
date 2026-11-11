# WC-2026-11-11-pdf-transcription-restored — a PDF upload fills its transcription again; OCR is honoured; the deltas from PHP

- **Date:** 2026-11-11 (RC-closure item T0-11, audit ids OX3 / OX7; owner
  decisions D1–D4 of the same day).
- **Decision:** owner D1 = (c), D2 = (b), D3 = ship Tesseract packs, D4 = backfill
  is an operator decision. DEC-12 (gates in the same change).

Most of this change is RESTORATION and needs no entry: PHP
`component_pdf::regenerate_component` (frozen v7 `:1222-1340`, v6 `:1159-1265`)
extracted the PDF text into the related `component_text_area` on every upload,
and ran OCR when `process_options.ocr` was set. The TS port built the derivatives
only, and `tool_upload` dropped `process_options` although the client sent it.
This entry ledgers the places where the restoration deliberately differs.

## Shape before (PHP)

1. OCR ran `ocrmypdf … <original> <original>`: the ARCHIVAL ORIGINAL rewritten in
   place (`process_ocr_file :1003-1006`).
2. `get_text_from_pdf` wrapped raw `pdftotext` output in `<p>` unescaped:
   `CAES<A>R` became markup.
3. Page tags `[page-n-N]`, N always from 1 (`first_page` passed as an option name
   `get_text_from_pdf` never read).
4. Every regenerate (upload, `tool_update_cache`, `tool_media_versions`)
   overwrote the transcription unconditionally, silently (the "only if empty"
   guard commented out in v6 and v7).
5. `system_info.pdf_ocr_engine` = the configured engine path (truthy whenever
   configured, binary or not).

## Shape after (TS)

a. OCR is a media JOB writing the text layer into the DEFAULT tier only; the
   archival original is read, never written (`src/core/media/pdf_ocr.ts`). The
   transcription is written when the job ends, not in the upload response.
b. Text is HTML-escaped per page before wrapping (`pdf_transcription.ts`
   `buildTranscriptionHtml`).
c. Page tags use the one shared builder with tool_pdf_extractor
   (`src/core/media/pdf_page_tag.ts`): `[page-n-N-K-data:[N]:data]`, K from the
   stored `lib_data.offset`.
d. Upload of a master OVERWRITES and, when the lang slice was non-empty, returns a
   notice: `tool_upload` response gains `ingest_notices: string[]` (rendered as
   plain text, apart from errors). (D1 c)
e. Regenerate FILLS ONLY AN EMPTY slice: `tool_update_cache` result gains
   `transcriptions_filled`, `transcriptions_kept`, `transcriptions_no_text`,
   `transcription_errors`; `tool_media_versions` sync payload gains
   `transcription: 'no_target'|'not_pdf'|'written'|'kept'|'no_text'|'failed'|null`. Fills carry the
   bulk-run id (undo log). (D2 b)
f. `process_options` is validated: keys `ocr` (boolean) and `ocr_lang` (`lg-xxx`
   with a Tesseract model, `src/core/media/engine/ocr_langs.ts`); `ocr_lang` is
   ignored unless `ocr === true`; anything else → `request.invalid_options`.
g. `get_system_info`: `pdf_ocr_engine: boolean` = ocrmypdf present AND executable;
   new `pdf_ocr_langs: string[]` = application langs whose Tesseract model is
   installed, in application order (`[]` when OCR is unavailable). The upload
   panel offers only those. (D3)

## Reason

(a) The archival original is the archive's statement of what was received; no
TS door mutates it. (b) A transcription must hold the characters the PDF holds —
the save path sanitizes rich text and would delete `<A>`
(`pdf_extract_symmetry_tripwire`, P1-20). (c) One tag grammar, and the offset the
viewer already stores. (d)(e) Owner decisions: a new document restates its text,
visibly; a repair never replaces curated text. (f) A ticked box that does nothing
was a silent narrowing. (g) An OCR checkbox on a host that cannot OCR, or offering
a language with no model, promises work that fails later.

## Gate reconciliation

No frozen parity fixture covers `tool_upload` process_uploaded_file,
`tool_update_cache`, `tool_media_versions` sync or `get_system_info`'s OCR keys
as a diffed shape — no re-harvest, no fixture edit. Gates:
`test/unit/pdf_transcription_native.test.ts`, `test/unit/ocr_langs.test.ts`,
`test/unit/system_info.test.ts`, `test/unit/install_host_ocr_langpacks_native.test.ts`,
client `test_tool_upload.js` (SERVICE_UPLOAD OCR OPTIONS).
