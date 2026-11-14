# WC-2026-11-12-zotero-csl-json-import — tool_import_zotero reads CSL JSON on the server's map and reports every line

- **Date:** 2026-11-12.
- **Decision:** RC-closure T1-7 / audits OX2, U09 (owner ruled 2026-11-11: PORT for
  RC). DEC-12 gates: `test/unit/csl_json.test.ts` (pure reader),
  `test/unit/tool_import_zotero_native.test.ts` (end-to-end on test3, scratch
  dd996 config), `test/unit/tool_import_zotero.test.ts` (refusals, traversal),
  `test/unit/marc_identity_native.test.ts` (no address from `call-number`),
  client `test_tool_import_zotero.js` (`render_import_report`).
- Code: `tools/tool_import_zotero/server/index.ts`, `src/core/tools/csl_json.ts`,
  `src/core/tools/zotero_map.ts`, `src/core/tools/import_link.ts`,
  `src/core/tools/import_execute.ts` (`MappedRecord.links`, `ImportReport.records`),
  `src/core/tools/import_code_lookup.ts` (`resolveMappedCodes`, shared with MARC21),
  `tools/tool_import_zotero/js/render_tool_import_zotero.js`.

## Shape before (TS)

- The handler parsed the upload as RDF/XML (`rdf_xml.ts`) and read `map` from
  the CLIENT `tool_config`, which holds only `ddo_map`: every real import
  answered `Missing Zotero field-map`. Zotero's documented export for this tool
  (PHP, v6) is CSL JSON; no PDF, cover, Series link, typology or standard
  number was ever written.
- The response carried `summary/created/updated/failed/errors`; the client
  showed only the outcome label.

## Shape after (TS) = PHP tool_import_zotero, with the divergences below

- **Request:** `tool_config` is read for `ddo_map` only (the Values form). The
  map is `getToolConfig('tool_import_zotero')` — dd996 per key over dd1633;
  `readZoteroConfig` refuses a missing/malformed map or one without `id`;
  `assertConfigSection` refuses a map/`main.section` of another section.
- **Read:** each staged `.json` through `readIngestTextFile` + `parseCslJson`;
  a non-array / non-object item / invalid JSON is one `errors` line per file.
- **Map:** CSL name variables → one item per name; date variables →
  component_date items; `type` → `typology` locators; `ISBN`/`ISSN` → number +
  `standard_type` locators (both accumulate); `DOI` → `https://www.doi.org/…`;
  a link entry (`container-title` → Series `rsc212`/`rsc214`) → find-or-create.
- **Identity:** the Zotero key (last `id` segment) is matched EXACTLY in the
  code component, principal-scoped, with the full URI as the other spelling.
  The importer STORES the bare key (PHP), so the key leg is library-blind: a
  same-key item of another library (`users/1/items/K` vs `groups/9/items/K`)
  updates the record. Only a code still stored as a full URI is
  library-scoped (exact-URI leg). Library-scoped identity is an open owner
  decision (T1-7 review, 2026-11-12); the gate pins today's behaviour.
- **Execute:** one dd800 run (`bulkLabel 'Zotero import'`); Series records it
  creates carry the run's birth marker, so reverting the run removes them.
- **Attachments:** `archive` → PDF ingest into `main.pdf`, the ingest's own
  rendered cover into `main.identifying_image`, per committed record — only a
  cover THIS ingest wrote (its on-disk stamp changed); a render failure or a
  non-PDF original (no rebuild) leaves the previous cover on disk and yields a
  `no cover image` line, never the old picture. The ingest's notices (non-PDF
  original, replaced transcription) are lines. A cover failure is a
  `<archive> cover: not imported` line (the PDF is already stored); an engine
  fault is logged typed (`internal.unexpected`) and its line names the
  request.
- **Response `data`:** `summary, created, updated, failed, errors, notices,
  attachments, bulk_process_id` (new: the last three). The client renders every
  list as text (`render_import_report`).

## Divergences from PHP (deliberate)

1. A value the record cannot take is REFUSED per field (a `failed` line) and
   the stored value stays: a text date (`raw`/`literal`, no `date-parts`), an
   unknown `type`, a name with no parts. PHP stored `{start:{}}` / the raw
   object, CLEARING the field on a re-import.
2. Every CSL name/date variable is dispatched by its CSL kind (PHP converted
   `author`, `issued`, `accessed` only).
3. A date range end is kept only for a `date_mode: range` target (a notice
   otherwise); `season` is a time only when it is `H:MM(:SS)` (PHP read a
   season "1" as hour 1).
4. ISBN and ISSN both present → both kept (PHP: the last one won).
5. Series by EXACT name, principal-scoped, advisory-locked per name for the
   record's transaction; two records holding the name → the link is refused
   (PHP: first fuzzy match, unlocked — concurrent imports duplicated Series).
6. A key carried twice in one batch, or held by two records, REFUSES the whole
   run before any write (the MARC21 posture, `resolveMappedCodes`).
7. Unmapped variables are listed once as a notice (PHP: silent).
8. **D1 pending (owner):** `main.field_to_section_id` (`call-number`) is not
   applied — neither as a value nor as a record address; each item carrying it
   gets a notice and resolves by its key. PHP created/overwrote the record at
   that `section_id`. Options laid out in the T1-7 plan.
9. **D2 default (owner may revise):** the PDF ingest stores `lib_data.offset`
   1, PHP's effective behaviour; CSL `page` start is not read as an offset.
10. The cover is the PDF ingest's own rendered cover (PHP ran a second
    rasterization).
11. The staging form is applied to every record, then consumed only when the run
    wrote something (WC-079).

## Reason

The tool imported nothing on a real install; PHP's own semantics silently
cleared stored dates and duplicated Series under concurrency.

## Gate reconciliation

No parity gate replays this tool (write path). The DEC-14b twins are the
native gates named above. No fixture changes.

## Addendum 2026-11-13 — D1 RULED (owner C18): `field_to_section_id` is an IDENTIFIER

Item 8 above is closed. The `main.field_to_section_id` variable (default
`call-number`) follows the DATA-08 law the MARC21 `id` entry follows
(`import_code_lookup.ts`): an external string never chooses a `section_id`.

- **Config** (`readZoteroConfig`): the variable MUST have a `map` entry — the
  component the identifier is looked up in (`ZoteroConfig.identifierTarget`) —
  and that entry may not be a link; otherwise the run is refused
  (`request.invalid_options`, naming the variable). The shipped dd1633 binds
  `call-number` → `dd176`, so an install without an override is unaffected.
  `id` itself as the variable is inert (the key's own law).
- **Map** (`mapCslItem`): the value is written, TRIMMED ONLY (as the MARC `id`),
  into that component, and carried as `ZoteroMappedRecord.identifier`. The
  pending notice is gone. A non-text value is a refused field.
- **Door** (`resolveIdentifiers`, before `resolveMappedCodes`): per item,
  `findSectionIdByCode` on the identifier in the imported section, scoped to
  the importer. Found → `CodedRecord.resolvedSectionId` (the key, written in
  the same record, is checked to name no OTHER record); absent → `null` (the key
  decides, else the record is created holding both). **The ITEM is refused** —
  an `errors` line `<key>: <sentence>` naming the variable, the value and the
  records, the item dropped from the batch before any write — when the
  identifier is held by two records (`resource.conflict` from the lookup),
  carried by an earlier item of the same export, or names a record other than
  the one the key is held by. The rest of the export proceeds. (The KEY keeps
  the batch posture of item 6: a key twice, or held by two records, still
  refuses the run.)
- `resolveMappedCodes` honours `resolvedSectionId` and asserts the key agrees
  with it (a batch refusal, unreachable from this door, kept as the invariant).
- Gates: `tool_import_zotero_native.test.ts` ("the call-number is a VALUE of
  its component", "C18 found/two/disagreement/batch"),
  `marc_identity_native.test.ts` (the mapper carries the identifier as a
  string, never an address). Docs: `docs/tools/using_import_zotero.md`,
  `docs/development/tools/reference/tool_import_zotero.md`. Fragment
  `zotero-call-number-identifier-and-size-limit`.


## Addendum 2026-11-14 — the SHIPPED default names no second identifier (C18 review gap)

The addendum above said the shipped dd1633 "binds `call-number` → `dd176`, so an install
without an override is unaffected". `dd176` is a LABEL node (`model: label`, "File name"),
not a component: under C18 every item carrying a `call-number` was refused as not lookupable
(`identifierLookupable`), and the Publications section (`rsc205`, real `rsc3`) ships no
call-number component to bind it to. Corrected (owner question open — a `component_input_text`
"Call number" on Publications would let the default bind one):

- The register default (dd1633) and `sample_config.json` drop the `call-number` map entry and
  the `main.field_to_section_id` entry: the shipped identity is the Zotero key alone; a
  `call-number` in an export is an unmapped variable (one notice). The tool's descriptions
  (dd612 ×6 langs, dd1362) say so. A Tools configuration override may still name a second
  identifier bound to a code component.
- Gate: `tool_import_zotero_native` "the SHIPPED default" — register ≡ sample; every tipo the
  shipped map writes is a `component_*` node of the suite ontology (RED before: `dd176` =
  `label`); an identifier, when named, binds to a string-column or IRI component other than
  the key's. Docs: `docs/tools/using_import_zotero.md`, the reference. Fragment amended.
