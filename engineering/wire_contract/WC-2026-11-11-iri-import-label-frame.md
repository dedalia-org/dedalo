# WC-2026-11-11-iri-import-label-frame — `component_iri` import writes the label as the dd560 frame (normalised find-or-create in the row tx); the save door refuses `label_id`

- **Date:** 2026-11-11 (T0-12 / OX2).
- **Decision:** owner decisions 2026-11-11 — D1 (a) refuse `label_id` at the save door; D2 (b)
  duplicate labels → lowest `section_id` + warning; D3 (a) append identity = `iri` only; D4 (b)
  trimmed case/accent-insensitive whole-value label match; D5 keep the deprecated `title` (stored,
  community discussing removal); D6 (b) unscoped dd1706 lookup as a named exemption. DEC-12 (gates
  in the same change).

## Shape before (PHP)

`core/component_iri/class.component_iri.php` (frozen):

- `conform_string_import_data` (:1089) parsed `'<label>, <iri>'`. A text label went to
  `save_label_dataframe_from_string` (:1202) → `get_label_record` (:1144): a search of dd1706 /
  dd1715 with `q: [label]`, `q_operator: null` (the default CONTAINS leaf, not exact) and
  `limit: 1` (planner-order first hit); none → a new dd1706 record + dd1715 `[{value, lang
  lg-nolan}]`. This ran INSIDE conform — outside any transaction, at preview time too, with no
  permission check of the dd1706 create. The item came back as `{iri, label_id}`.
- A numeric `label_id` was never checked for existence.
- `import_save` (:191-260) built the dd560 frame `{type dd490, section_tipo dd1706, section_id
  label_id, id_key item id, main_component_tipo}`, STRIPPED `label_id` from the item, called
  `empty_full_data_associated_to_main_component()` (:245 — wipes EVERY dd560 frame of the main, all
  language slices) and saved the frame then the main.
- A label-only record (`'5'`, no iri) conformed to an item with no iri; a JSON `label_id` that was
  not an id passed through.

## Shape before (TS)

Conform passed `label_id` through on the item (numeric `'<id>, <iri>'` form and both JSON
branches); the text-label form was REFUSED ("not ported"). Nothing converted `label_id` into a
frame, and `saveComponentData` kept unknown keys: the literal stored `{id, lang, iri, label_id}`,
no dd560 frame — the label silently invisible (readers pair dd560 by `id_key`). Append equality
read `iri` + `label_id`.

## Shape after (TS)

- **Stored shape = the editor's:** literal item `{id, lang, iri}` (+ `title` when the file carried
  it — D5, kept and stored) and ONE dd560 frame per labelled item `{type:'dd490',
  section_tipo:'dd1706', section_id:<int>, from_component_tipo:'dd560', main_component_tipo:<iri
  tipo>, id_key:<item id>, id}`. `label_id` never reaches the matrix.
- **Conform is pure:** it returns the clean item plus a label INTENT beside it
  (`ConformResult.derivedFrames`: slot dd560, lang, item index, target `{section_id}` or
  `{label}`). Both executors (CSV `import_csv_execute.ts`, mapped `import_execute.ts`) resolve the
  intents in the ROW transaction (`src/core/tools/import_iri_label.ts`) — DIVERGENCE: PHP created
  labels at conform; a preview or a rolled-back row now leaves no orphan dd1706 record.
- **Text label match (D4b, D2b) — DIVERGENCE from PHP's CONTAINS + `limit 1`:** ONE fold, computed
  by Postgres: `lower(f_unaccent(regexp_replace(…, <match trim>, '', 'g')))` (so ø/æ/ß/ł/đ/þ fold
  like their unaccented forms). The match trim is `String.prototype.trim`'s set — every Unicode
  white space and line terminator, NBSP/tab/newline included (`src/core/concepts/match_text.ts`);
  conform trims with the same rule. The
  lookup is one exact predicate on both sides — whole value, never a substring, no candidate cap
  (`readSectionIdsByFoldedValue`, `src/core/db/matrix.ts`, `ORDER BY section_id`). Several matches →
  the LOWEST `section_id`, with a warning naming the others. The same SQL fold keys the row's
  dedup and a transaction-scoped advisory lock per label (`label:<fold>`). The locks of the WHOLE
  row (CSV) or record (mapped) are taken ONCE, in sorted fold order, before any other lock or write
  of it (`lockLabelTexts`); a text not pre-locked is an `internal.invariant` — per-column locking
  deadlocked across crossed column order.
- **Created label:** none found → `createSectionRecord('dd1706')` (the importer's birth default
  project) + dd1715 `[{value, lang:'lg-nolan'}]`, under the run's bulk process — after ONE write-door
  question as the importer (`authorizeSectionTarget` dd1706/dd1715, level 2). DIVERGENCE: PHP
  created without a permission check; a refusal now refuses the field (never a label-less import).
- **Unscoped lookup (D6b) — named exemption:** `findSectionIdsByFoldedText`
  (`import_code_lookup.ts`) is a direct record-store read (no principal, no projects filter) and
  requires a non-empty `'D6b: …'` reason at the call site; its callers are allow-listed by
  `iri_label_unscoped_lookup_tripwire` (one call site per allowed caller; the definer holds only
  the definition). dd1706 is the shared label vocabulary; an
  importer-scoped lookup would fork it per project. Ids only come back; the import links to the
  label and never writes into it.
- **Numeric label:** must name an existing dd1706 record (one existence query) — DIVERGENCE: PHP
  never checked; an unknown id refuses the field, nothing written for it.
- **Refused at conform (DIVERGENCE: PHP accepted):** a label with no iri (plain `'5'`, or a JSON
  item with `label_id` and neither `iri` nor `title`); a JSON `label_id` that is not an integer
  >= 1.
- **Frame pairing:** REPLACE pre-allocates each labelled item's final id in the row tx — its file id
  (must be an integer >= 1, else refused), else the id of a stored item of the same lang slice with
  the same iri (a re-import replaces item AND frame in place), else a counter id. APPEND pairs
  through the save's `appendedIdMap` (a skipped duplicate maps to the existing item; a different
  stored label on it → `data_limit` refusal of the row).
- **Per-item frame replace — DIVERGENCE from PHP's wipe-all:** REPLACE replaces the dd560 frames of
  the items the write carries (by `id_key`); other items' frames — another language slice's labels
  — survive.
- **Append identity (D3):** `LITERAL_EQUALITY.iri` = `iri`; when BOTH iris are blank it compares
  `title` (two title-only items with different titles are two items). `isEmptyLiteralItem('iri')`
  = blank `iri` AND blank `title` (PHP `is_empty` parity). A same-iri item with a different `title`
  is a duplicate (skipped, title not merged).
- **Mapped door rollback:** in `import_execute.ts` a labelled iri field whose main save is refused
  in ANY language throws `record.save_failed`; the whole record rolls back (no label created, no
  slice, no frame) and is reported "the record was not written", beside the record's other
  per-field issues (`section_id` = the matched id, else 0). Previously a per-field failure
  kept the other slices. (The CSV door already rolled the row back.)
- **Save door (D1) — a previously accepted write is now refused:** `saveComponentData` throws
  `request.invalid` (public message, component + item named) for any `insert` / `update` /
  `set_data` item of an `iri`-column model carrying a `label_id` key, whatever its value (null
  included), before the transaction opens (`src/core/section/record/iri_label_guard.ts`). Covers
  every door — client API, MCP, agent change-plan, importers. The deprecated `title` is not judged.

## Reason

The text-label form was refused and the numeric/JSON forms silently lost the label (a stray key no
reader consults). The label is a frame by the component's own contract; PHP's way of reaching it
(side effects at conform, non-exact first hit, wipe-all) mints records on a preview, links the
wrong label, and drops other language slices' labels.

## Gate reconciliation

- `test/unit/import_iri_label_native.test.ts` (CSV replace/append, mapped executor, match rule,
  duplicates, rollback, permission refusal, D6b reuse across projects),
  `test/unit/iri_label_id_guard_native.test.ts` (save-door refusal, `title` stored),
  `test/unit/import_conform_iri_native.test.ts` (clean item + intent, refusals),
  `test/unit/append_merge.test.ts` (iri identity, title-only fallback),
  `test/unit/iri_label_unscoped_lookup_tripwire.test.ts` (D6b caller allow-list).
- Fixtures: import is a write path; no frozen parity fixture carries an iri import or `label_id` —
  no fixture edit, no re-harvest.

## Addendum 2026-11-22 — T2-IMP-2: one whitelist conformer for a json iri item

- **Before (TS):** a json object item kept every key but `label_id` verbatim on the stored item
  (`import_conform.ts` "every other key kept"); a FLAT item's `iri` was checked untrimmed and
  stored with its padding (the lang-keyed one was trimmed); `{}` / `[{}]` stored an empty item; a
  lang-keyed item demanded an `iri` while a flat one did not.
- **After:** ONE conformer (`conformIriObject`) for both json branches. Keys: `iri`, `id`, `title`,
  `lang` (the stored item shape — a raw export re-imports) + `label_id` (split off as the dd560
  intent, unchanged). Any other key REFUSES the cell (`IGNORED: unknown key "<key>" in an iri
  item …`). `iri`, when present: a string with an http(s) protocol, TRIMMED. `id`: a positive
  integer. `title` / `lang`: strings (null = absent). An item with neither an `iri` nor a `title`
  is refused (`IGNORED: an iri item needs an iri or a title …`; with a `label_id`, the T0-12 "a
  label needs an iri" sentence). A lang-keyed title-only item is now accepted like a flat one (PHP
  parity: neither branch required an iri).
- **PHP:** copied a whitelist (`iri`, `id`, `label_id`, `title`, flat `lang`) and DROPPED every other
  key silently; `id` was not type-checked. TS refuses instead of dropping: a dropped key is data the
  operator believes imported.
- **Gate:** `test/unit/import_conform_iri_native.test.ts` "the json iri ITEM whitelist (T2-IMP-2)"
  (unknown key both branches, flat trim, `{}` ×3 shapes, round-trip of the stored shape, wrong
  types). Write path; no fixture.
