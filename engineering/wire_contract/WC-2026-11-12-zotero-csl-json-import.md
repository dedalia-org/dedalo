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
  string, never an address). Docs: `docs/using/tools/using_import_zotero.md`,
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
  the key's. Docs: `docs/using/tools/using_import_zotero.md`, the reference. Fragment amended.


## Addendum 2026-11-18 — D1 RE-RULED (owner, 2026-11-17): the call-number IS the record's ADDRESS

The 2026-11-13 addendum (C18: `field_to_section_id` is a second IDENTIFIER, looked up in a
bound component) and the 2026-11-14 one (the shipped default names none) are SUPERSEDED.
Zotero has no editable id, so the cataloguer writes the record's `section_id` in the
call-number: it is an operator-chosen address, not an external identifier. This is the ONE
named exception to the DATA-08 code-lookup law (`src/core/tools/import_code_lookup.ts`
header) — for the Zotero door only. The Zotero KEY keeps that law, and MARC21 can never
address by id.

- **Config** (`readZoteroConfig`): `main.field_to_section_id` names a Zotero FIELD; no `map`
  entry is needed and none is bound (`ZoteroConfig.identifierTarget` is gone). `id` as its
  value refuses the run (`request.invalid_options`); blank / absent = the key alone
  identifies. The shipped default (dd1633 ≡ `sample_config.json`) names `call-number`
  again; the `dd176` label binding 2026-11-14 removed stays removed. Register version
  2.0.3 → 2.0.4; dd612 (six languages) and dd1362 say a whole-number call-number is the
  record's `section_id`.
- **Map** (`mapCslItem`): the variable's value is carried as `ZoteroMappedRecord.address` —
  a scalar trimmed, a non-scalar as its JSON, null / blank = none — and is neither written
  nor listed as unmapped. `recordNumberOf` is the one reading: `/^[1-9]\d*$/` and
  ≤ 2147483647. No cast.
- **Door** (`resolveItems`, `tools/tool_import_zotero/server/call_number_address.ts`), before
  any write: (1) a call-number that is not a record number refuses THAT item, naming the
  value (`request.invalid_data`); so does one an earlier item of the run carries — the
  second item, the call-number's existing per-item posture (a duplicated KEY still refuses
  the run, item 6); (2) the key resolves for the whole batch, unchanged; (3) a key held by
  another record than the call-number names refuses the item (`resource.conflict`).
- **Execute** (`import_execute.ts`): `MappedRecord.address {sectionId, refusalFor?}`, settled
  INSIDE the record's transaction (`addressedTarget`). No record at the id — never one, or
  DELETED — → the create door, then `createSectionRecord` at the explicit id
  (`insertMatrixRecordWithExplicitId`; counter GREATEST; a reborn address opens a generation
  epoch). A record there, including one a concurrent writer bore since the door looked → asked
  of the record door AS A RECORD first (`livingRecordRefusal`, door `import_execute.address`:
  section floor 1 and the write scope — review 2026-11-18, below), then its stored key is read
  under the row lock (`readStoredCodesForUpdate`): none → adopted; the item's own key or full
  URI → updated; any other, or a key against an item that carries none → refused
  (`resource.conflict`, the record rolled back, reported once as `RecordResult.refusal`, never
  a `failed` line). Its fields pass the RECORD door, as for any matched record. `importMappedRecords` takes
  `options.addressDoor` (`<tool>.<action>`): a record carrying an address refuses the RUN
  (`internal.invariant`, before the dd800 mint) unless that tool DECLARES the action in
  `ToolServerModule.operatorAddressActions` (new, loader-validated: a key that is no action
  of the tool, or an empty reason, refuses the tool — `tool_import_zotero` → `import_files`
  only; core names no tool), the address is a positive int4 and the record names no other
  id. `RecordResult` gains `created` and `refusal?: {code, message}`;
  `CodedRecord.resolvedSectionId` is removed.
- **Response `data`:** new `created_at_id: number[]`, `updated_at_id: number[]`,
  `refused: {item, code, message}[]` (`code` ∈ `request.invalid_data`, `resource.conflict`,
  or the record door's `perm.*` code — `perm.out_of_scope`, `perm.denied` — for a record the
  importer may not write).
  `errors` is the per-FILE list again (the C18 item lines no longer land there). `summary`:
  `Zotero import done. Created N, updated N[, R refused][, F failed].` The client renders the
  three lists as text (`render_import_report`).
- **Not decided here (owner):** an item with a call-number and NO Zotero key against a
  record that holds a key is refused (nothing says it is that reference) — the conservative
  reading of rule 2. A record holding no key (created by hand) is adopted, as ruled.
- Gates: `tool_import_zotero_native.test.ts` ("call-number: the operator-chosen record
  ADDRESS" — rules 1–7, the deleted id, the batch duplicate, the run's own allocations, an
  id taken by a concurrent writer, the report order; "the
  SHIPPED default" — rule 6), `csl_json.test.ts` (`recordNumberOf`, the address text, the
  config), `marc_identity_native.test.ts` ("an ADDRESS is the Zotero door's alone" — the
  executor's refusal for every other door, the declaring set derived from the loaded tools,
  the positive control), `tools_loader.test.ts` (the declaration's validation),
  `import_create_door_native.test.ts` (1c: create permission, the record door on an
  addressed record before its guard, the write order), client `test_tool_import_zotero.js`. Mutation-proved: the create door,
  the matched/created split, the allow-list assertion, a `parseInt` reader, the key guard,
  rule 5, the batch duplicate, the absent-id create — each red. Docs:
  `docs/using/tools/using_import_zotero.md`, `docs/development/tools/reference/tool_import_zotero.md`.
  Fragment `zotero-call-number-is-the-record-number`.

### Review 2026-11-18 (same day, before release) — two defects of the addendum above, fixed

- **The run's own allocations took addresses.** Records were written in file order, so an
  item WITHOUT a call-number — or a record a LINK creates, when a configuration links into
  the section imported into — could be born at the counter's next id: the very id a LATER
  item of the same export named, free when the run began. That item then found "a record
  there": refused when the record held a key (against rule 3), and ADOPTED when it held none
  (an item with no `id`, or one whose key field was refused) — two references merged into one
  record, reported as one created and one updated. Now `importMappedRecords` writes every
  ADDRESSED record first, HIGHEST address first (`writeOrder`; the rest in input order): the
  explicit-id insert raises the counter to its id, so once the highest address is written
  every allocation of the run lands beyond every id the file names. `ImportReport.records`, `createdIds` and `failed` stay in INPUT order. A door
  without addresses keeps its order exactly. Residual, by construction: an addressed record
  that ROLLS BACK (a create refusal, an engine fault) leaves its id free and a later
  allocation may take it — the item is reported not written, nothing is merged.
- **A record outside the importer's scope was reported updated.** The key lookup is
  principal-scoped; an address is not — it reaches any id of the section. Such a record was
  handed to the key guard (whose sentence told whether it holds a Zotero key) and then
  "updated" with every field refused by the record door: `updated: 1`, listed in
  `updated_at_id`, nothing written. Now the record is asked of the record door as a whole
  BEFORE the guard (`authorizeRecordAccess` write, section floor 1, level 1 on the section
  pair, the write scope): a `perm.*` refusal refuses the ITEM — `RecordResult.refusal
  {code, message}`, in `refused` with that code and a sentence that names the call-number and
  nothing the record holds; counted neither created nor updated, no `failed` line, the guard
  never asked. A record in scope whose individual FIELDS the importer may not write is
  unchanged: updated, each such field an IGNORED line (every mapped door's posture).
- **Not decided here (owner)** — (a) and (b) RULED the same day, see the next addendum; (c)
  pending: (a) a call-number is taken as written up to 2147483647 and
  the counter follows it (rule 3) — one mistyped or hostile call-number near the top of int4
  leaves the section no id to allocate; whether an address far above the counter needs a
  bound or a confirmation is not ruled. (b) The Zotero KEY is looked up in the importer's
  scope only, so rule 5 cannot see a key held by a record outside it: such an item is
  written at its call-number and the key then lives on two records. (c) Across runs a
  key-less record is adopted whoever made it (rule 2) — including a record an earlier import
  left key-less because its key field was refused.
- Gates (red before; mutation-proved — order → identity, highest-first → lowest-first, report
  in write order, the record door dropped, the guard asked first):
  `tool_import_zotero_native.test.ts` ("the run's OWN allocations never take an address…" ×3, "the report keeps the FILE order…", "an id TAKEN by
  another writer…" — a real interleave, `pg_blocking_pids`; "rule 7: a record … the importer
  may NOT write"), `import_create_door_native.test.ts` (1c).

### Rulings 2026-11-18 (owner, same day, before release) — the limit and the whole section

Questions (a) and (b) of the review above, ruled. (c) — a key-less record adopted across
runs — and the key-less item against a keyed record stay open (the owner asked for an
explanation first).

- **(a) The section_id limit IS the import limit.** No bound below int4 is drawn and no
  confirmation asked: a call-number is taken as written up to 2147483647 (rule 3 unchanged,
  the counter follows it). A whole number ABOVE it — the address spelling, any length of
  digits (`recordNumberAboveLimit`, `src/core/tools/zotero_map.ts`) — was one more "is not a
  record number" line under `request.invalid_data`. Now the item is refused under its own
  code, `tool.zotero_call_number_above_limit` (`refused[].code`; the sentence names the
  value and the limit), and the run WARNS the user (below).
- **(b) The Zotero key is looked up in the WHOLE section.** `resolveItems` asks
  `resolveMappedCodesInWholeSection` (`src/core/tools/import_code_lookup.ts`): the same
  search, exact match, batch law and refusals as `resolveMappedCodes`, run with NO principal
  — no projects filter, no dd478 allow-list. A key held by a record outside the importer's
  projects is therefore seen: rule 5 refuses an item whose call-number names another record
  (`resource.conflict`, both named by `section_id`) where it used to adopt the key at the
  call-number — one key on two records; and a key held by two records refuses the run
  whoever may see them. What the lookup answers is a `section_id`, never a stored value, and
  every match is marked `MappedRecord.unscopedMatch` (new): the executor asks the record
  door for that record AS A WHOLE inside its transaction, before any field (`matchedTarget`,
  door `import_execute.match`: section floor 1, level 1, the write scope). Refused → the
  ITEM is refused with the door's `perm.*` code (`RecordResult.refusal`, in `refused`, no
  `failed` line, counted neither created nor updated), where the scoped lookup used to find
  nothing and CREATE a second record with the same key. `RecordRefusal` gains `sectionId`
  (the record that refused). MARC21 keeps the scoped lookup and never sets the flag. The
  unscoped lookup is a named exemption: `iri_label_unscoped_lookup_tripwire` allow-lists its
  one caller with a `'ruling 2026-11-18: …'` reason literal, and an empty reason is refused
  at runtime.
- **A record the importer may not change is NAMED.** Both ways an item reaches one — its
  call-number (already a `perm.*` refused entry), its key (new) — say so in the `refused`
  sentence: `… names record N, which you may not change (perm.…)` /
  `this item's Zotero key is held by record N, which you may not change (perm.…)`. The
  `section_id` only; nothing the record holds, not even whether it holds a key (the
  call-number case).
- **Response — envelope `notices` (new on this action).** Besides `data`, the success
  envelope carries at most one notice of each code, built by `refusalNotices`
  (`call_number_address.ts`) — registered codes, never thrown, whose labels
  (`src/core/labels/master.json`, with `lg-spa` / `lg-cat`) are the user-facing text:
  - `tool.zotero_call_number_above_limit` (`caller`) — `details {count, limit: 2147483647,
    values, variable}`: `values` lists the first twenty, each cut at 80 characters, then `…`;
    `variable` is the configured `field_to_section_id`.
  - `tool.zotero_record_not_writable` (`permission`, public by the ruling) — `details {count,
    section_ids}`: the references, and the records' ids distinct and ascending (first twenty).
  A run with nothing to warn of carries no `notices` key. `data.notices` (the report's text
  lines) is unchanged and unrelated. Client: the request asks for the notices itself
  (`notices: 'caller'`) and `render_import_warnings` lists them above the report, each as its
  label filled with its details, as text.
- **`data.refused[].code`** ∈ `request.invalid_data`, `tool.zotero_call_number_above_limit`,
  `resource.conflict`, or the record door's `perm.*`.
- Gates (red before; mutation-proved — the limit reading off by one / never above, the
  warning dropped, the notices not sent, the matched record's door dropped, the
  `unscopedMatch` mark dropped, the whole-section search made empty, the alert dropped, the
  notice list uncapped, the reason literal removed — each red):
  `tool_import_zotero_native.test.ts` ("the section_id limit IS the import limit…", "a run
  with nothing to warn about…", "the limit is int4, exactly…", "rule 7: a record the importer
  may NOT change…", and the describe "the Zotero key is checked in the WHOLE section…" — real
  non-admin identities of `authz_door_fixture`: rule 5 across scopes, the key's record out of
  scope, a call-number on a record out of scope, the served twins incl. a global admin),
  `import_create_door_native.test.ts` (1d: the unscoped match — out of scope refused, in
  scope written, the unflagged contrast), `csl_json.test.ts` (`recordNumberAboveLimit`),
  `iri_label_unscoped_lookup_tripwire.test.ts` (the third guarded name, one way in, the
  mark), client `test_tool_import_zotero.js` (`render_import_warnings`). Docs:
  `docs/using/tools/using_import_zotero.md`,
  `docs/development/tools/reference/tool_import_zotero.md`. Fragment
  `zotero-import-limit-and-whole-section-key`.

### Rulings 2026-11-18, second set (owner, same day, before release) — taken over, the key-less item, the scope

(c) and the key-less item, left open above, ruled; plus the scope of every rule of this door.

- **(c) A key-less record is still adopted — and REPORTED APART.** Rule 2 is unchanged: a
  record living at the call-number with no Zotero key is written and holds the item's key
  from then on. What changes is the report: such a record was TAKEN OVER, not merely
  updated. Rule 2's guard notes what it found under the row lock (`AddressedItem.found =
  'keyless_record'`, only when the item carries a key to leave there) and `addressOutcome`
  settles it once the record's own result is known (a rolled-back record is listed nowhere).
  - **Response `data`:** new `taken_over_at_id: number[]` and `taken_over: number`. A
    taken-over record is NOT in `updated_at_id` and NOT counted in `updated` (before: both)
    — `created`, `updated`, `taken_over` are disjoint. `summary` gains `, N taken over`
    (after `updated`, before `refused`; absent when 0).
  - A key-less ITEM on a key-less record takes nothing over (no key is left there): it stays
    an `updated_at_id` entry.
  - Client: `render_import_report` lists `taken_over_at_id` under its own heading
    (`ul.import_taken_over_at_id`), the label `zotero_taken_over_at_id`
    (`src/core/labels/master.json` + every catalog; literal fallback).
- **(d) A key-less item against a keyed record is still refused — WITH THE EXPLANATION.**
  The item carries no Zotero key and its call-number names a record that holds one: nothing
  says it is that reference. Before: `refused[].code = resource.conflict` and the re-key
  sentence ("already holds a Zotero key that is not this item's"). Now its own code,
  `tool.zotero_item_without_key` (`conflict`, 409, public, never thrown), a sentence that
  says why (the record already belongs to a Zotero reference; without a key the import
  cannot tell whether it is the same one) and what to do (export again from Zotero so the
  item carries its key, or remove the call-number to create a new record), and one envelope
  notice per run of that code — `details {count, section_ids, variable}` (distinct,
  ascending, the first twenty), label `error_tool_zotero_item_without_key` (`lg-spa` /
  `lg-cat` too). The record's number only: never the key it holds, nor anything else of it —
  and only a record the importer may write is ever named (the record door is asked before
  the key is read). An item WITH a key against another key keeps `resource.conflict` and
  raises no notice. The executor is untouched: `RecordRefusal.code` stays
  `resource.conflict`; the door recodes its own guard's finding (`noteWriteRefusal`).
- **`data.refused[].code`** ∈ `request.invalid_data`, `tool.zotero_call_number_above_limit`,
  `resource.conflict`, `tool.zotero_item_without_key`, or the record door's `perm.*`.
- **SCOPE: every limit, refusal and warning of the call-number is the Zotero door's ONLY —
  never the CSV import's.** Nothing here moved into a piece the two imports share
  (`parseRecordIdCell`, `readExistingSectionIds`, `createSectionRecord`). The CSV
  `section_id` column behaves as at 123d88b48d, pinned by measurement: a cell above
  2147483647 fails the FILE on the id as written (`value "2147483648" is out of range for
  type integer`, nothing written — no per-row refusal, no Zotero code or wording); a digit
  run too long for an exact integer is the DATA-22 row skip; a free id is created at it; a
  record holding a code and one holding none are both updated in place — no key guard, no
  take-over bucket, no notice.
- Gates (red before = the mutation that restores the previous behaviour; all red):
  `tool_import_zotero_native.test.ts` — "rule 2 + ruling (c)…", "ruling (c): a key-less item
  on a key-less record…", "ruling (c): a taken-over record whose write ROLLS BACK…", "ruling
  (d): an item with NO Zotero key…", "ruling (d) is the key-less item's only…", "rule 7: one
  run reports created-at-id, updated, taken over and refused SEPARATELY" (10 mutations: taken
  over listed as updated, count not disjoint, key-less item takes over, rolled-back listed,
  own code dropped, notice dropped, explanation replaced by the re-key sentence, a keyed item
  treated as key-less, summary without the count, the list not sent);
  `import_csv_execute.test.ts` — "the Zotero import's record-number rules are ZOTERO's…" (2
  mutations: the int4 bound moved into `parseRecordIdCell`; into `readExistingSectionIds`);
  client `test_tool_import_zotero.js` (the taken-over list and heading, the third warning).
  Docs: `docs/using/tools/using_import_zotero.md`,
  `docs/development/tools/reference/tool_import_zotero.md`. Fragment
  `zotero-taken-over-and-keyless-reference`.
