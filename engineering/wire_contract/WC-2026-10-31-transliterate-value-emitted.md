# WC-2026-10-31-transliterate-value-emitted — transliterable components carry `transliterate_value` again, and offer tool_lang

- **Date:** 2026-10-31 (feature: ontology `properties.with_lang_versions` on a
  non-translatable component — a TRANSLITERABLE component).
- **Decision:** DEC-12 (gated: `test/unit/lang_versions_emit_native.test.ts`;
  closure pinned by `test/unit/wire_field_agreement_tripwire.test.ts` `CLOSED`;
  the version read by `test/unit/tm_two_lanes_native.test.ts` case 4). Closes
  the `transliterate_value` row of
  WC-2026-08-31-client-reads-three-fields-the-engine-never-emits.
- **Reference:** v6 semantics (`component_input_text_json.php:195`,
  `component_iri_json.php:178`, `class.common.php:4929`). The frozen v7 PHP
  never read `properties.with_lang_versions` (typed
  `bool $with_lang_versions = false` + `isset` is always true), so only
  component_iri ever carried the key there — the frozen fixtures show rsc85
  list items WITHOUT it. That is the frozen tree's defect, not the contract.

## What a transliterable component is

A non-translatable component whose value lives in an `lg-nolan` BASE but may
also hold per-language VERSIONS beside it (Augustus `lg-nolan`, Αύγουστος
`lg-ell`), edited through tool_lang. The ONE predicate is
`src/core/ontology/resolver.ts` `hasLangVersions(tipo, model)`: every
component_iri (PHP `class.component_iri.php:64` hard-sets it), or any component
whose ontology node says `properties.with_lang_versions: true` — read on the
DATA node (an alias answers for its target), from the ontology only (an rqo
properties override never makes a component transliterable).

## Shape before (TS)

- No data item ever carried `transliterate_value` (the 2026-08-31 narrowing).
- requirement_translatable tools (tool_lang, tool_lang_multi) were offered only
  on ontology-translatable components (`tools/registry.ts`, with_lang_versions
  "deferred").

## Shape after (TS)

1. **`item.transliterate_value`** — on every LITERAL data item of a
   transliterable component (every component_iri; a component_input_text only
   under `with_lang_versions` — a plain one carries NO key), in every mode:
   - the stored items of the OTHER lang of the pair: an instance whose `lang`
     is `lg-nolan` gets the REQUEST DATA LANG's version (PHP
     `DEDALO_DATA_LANG` — the session data lang, `currentDataLang()`); an
     instance running in a version (an EXPLICIT lang — the tool_lang target)
     gets the `lg-nolan` base;
   - keyed on the item's own `lang` (the instance lang `elementLang` settled),
     never on the ambient request lang;
   - `null` when the component holds no stored data; `[]` when it does but the
     other lang is empty (PHP `get_data_lang`, exact — WC-001's `[]` law is for
     `entries` only);
   - full raw stored items, stored order: `{id, lang, value}` /
     `{id, lang, iri, title}` (the input_text edit view pairs by index, list/mini
     read `[0].value`; the IRI edit view adopts `[i].id` for an empty row so the
     dd560 label frame pairs across languages).
   Implementation: ONE emit hook, `src/core/components/lang_versions_emit.ts`
   (`emitHook: 'lang_versions'` on both descriptors, `decorateItem`). Doors
   reached: every `emitDdoData` literal emission (section edit/list reads,
   portal/relation child cells, the component read / get_data — the tool_lang
   target, TM preview, TM list cells) and the scalar save echo
   (`dd_core_api.ts` dispatches `decorateItem`; the echo is stamped with the
   effective slice lang). **Not reached, by design:** the temporal (search-form
   scratch) echo — it has no stored record to pair against, and no search view
   reads the key; search empty shells likewise.
   PHP's side effect of switching the IRI instance lang
   (`$this->set_lang($tranliterable_lang)`, `component_iri_json.php:194`) is
   NOT ported.
2. **requirement_translatable tools** — a component is effectively translatable
   when it is ontology-translatable OR transliterable (`hasLangVersions`), PHP
   `class.common.php:4128-4135`. tool_lang and tool_lang_multi now appear on
   with_lang_versions components and on every component_iri; tool_subtitles is
   limited by its affected model and unaffected.

## Reason

`transliterate_value` is a translation aid in a multilingual heritage system
(the sibling-language hint beside a base name; the base beside a version inside
tool_lang) and the cross-language IRI id share the client keeps an
empty-but-existing IRI entry out of the clear-all path with (P0-8 / DATA-06).
Dropping it was a silent narrowing; this restores the v6 contract.

## Client fix shipped with it

`client/dedalo/core/component_iri/js/render_edit_component_iri.js`
`render_transliterate_value` read `self.context.render_class` in a module-level
function with no `self` in scope — a TS-era regression that threw a TypeError
the first time an IRI counterpart with an `iri` rendered. The component's
context is now a parameter (its server-stamped `render_class`, as
`render_escape_tripwire` requires). The stale "coerced to a string" comment in
`view_mini_input_text.js` was corrected (the code already read `[0].value`).

## Gate reconciliation

- `wire_field_agreement_tripwire`: `transliterate_value` left `NOT_EMITTED`
  and entered `CLOSED` (still read, still ASSIGNED in `src/`, ledgered here).
- `tm_two_lanes_native` case 4: the explicit lg-ell live read now also asserts
  `transliterate_value` = the final lg-nolan base.
- Parity: no fixture edit. The comparators project fixed fields and
  `read_differential.test.ts` already allowlists the key; the frozen IRI
  shapes (`lg-nolan` with data → `[]`, no data → `null`, lg-spa instance with
  empty entries → the lg-nolan items) are the shapes this entry emits.

## Addendum 2026-10-31 — publication (diffusion) follows the same base/version rule

Not an API-wire change; recorded here because it is the same feature's
contract on the publication side. v6 publishes a transliterable PER OUTPUT ROW
as the version in the row's lang when one exists, else the lg-nolan base
(v6 `class.diffusion_sql.php:1727`, `component_iri::get_diffusion_value`,
`component_common::get_value_with_fallback_from_dato_full`). When BOTH are
empty the v6 caller does not stop there: the `build_data_field` default branch
(v6 `class.diffusion_sql.php:1803-1825`) falls back to the record's main lang,
then to the first non-empty of every lang + lg-nolan. The full v6 chain is
therefore row lang → lg-nolan → main lang → any — exactly the projection
ladder's rungs (`src/diffusion/project/lang_ladder.ts` `resolveColumnForLang`).
A version-only record (no base) thus publishes that version in every row, in
v6 and here; this is the contract, not a divergence.

- **component_input_text** (`with_lang_versions`): already correct — one atom
  per stored item keyed by lang, projection ladder exact → nolan → main → any.
  Pinned only.
- **component_iri** (`src/diffusion/resolve/default_value.ts`): was ONE
  lang-neutral atom merging every slice (the frozen v7 PHP `get_data()` over all
  langs), so every row published base + versions together. Now one atom PER
  STORED LANG; `parser_iri::flat` (`src/diffusion/parsers/parser_misc.ts`)
  formats each lang group on its own. A base-only record (the common case)
  publishes identical bytes.
- **thesaurus term path** (`src/diffusion/resolve/rewriters.ts`
  `nodeTermForLang`): the ladder gains the v6 lg-nolan rung after main lang
  (exact → main → nolan → project langs → any). Before, a row with no version
  got the first VERSION in project order. Byte-neutral for translatable and
  nolan-only terms.
- **ddo lang pin** (`src/diffusion/resolve/resolver.ts`): for a transliterable
  only, a pinned lang that has a version keeps the version alone (the base no
  longer passes beside it); no version → the base, as before. Other models
  unchanged.
- CSV import (`tool_import_dedalo_csv`): no change — lang-keyed cells are kept
  per lang and saved through `effectiveSaveLang` (gated by
  `bulk_undo_capture_native` REPLACE/APPEND cases on a `with_lang_versions`
  column).

Gates: `test/unit/diffusion_lang_versions.test.ts` (atoms, parsers, ladder,
term path — pure); the ddo lang pin (`resolver.ts` `applyDdoLangPin`, which
reads the ontology flag) in `test/unit/with_lang_versions_native.test.ts`
section 6 (version alone / no version → base / plain model unchanged / iri).

## Addendum 2026-10-31 — what the instance-lang rule must NOT change

The rule (`resolver.ts` `elementLang`) makes every non-translatable,
non-transliterable component's instance lang `lg-nolan`, even when the caller
asks for another. Three doors had leaned on the old, ambient-echoing instance
lang and are now explicit:

- **Select-family option labels** (`component_select`, `_radio_button`,
  `_check_box`, `_publication`, `_relation_model`): the edit `datalist`, the
  list value and BOTH save echoes' `datalist` label in the request DATA lang
  (`src/core/relations/datalist.ts` `datalistLabelLang`), never the instance
  lang — PHP `component_relation_common::get_list_of_values(DEDALO_DATA_LANG)`
  (`class.component_relation_common.php:3504`, `component_select_json.php:175`,
  `component_radio_button_json.php:154,170`). Wire change vs HEAD: a get_data /
  save echo whose `source.lang` differed from the session data lang used to
  label in `source.lang` (an omitted lang in the data lang, the usual section
  read in the lg-nolan fallback chain); all now label in the data lang.
  `getEchoDatalist` lost its `lang` parameter. Gate: `with_lang_versions_native`
  "select-family option labels stay in the request DATA lang".
- **Time Machine history list cells** (`src/core/resolve/read_tm.ts`
  `laneCellLang`): a transliterable's cell (not only component_iri's) is pinned
  to the lane the row holds — an lg-ell row reads its version as its entries
  (was: the empty base slice, the version as `fallback_value`), an lg-nolan row
  holding the base reads lg-nolan (an iri lg-nolan row holding its base used to
  read the request lang's slice). Gate: `tm_two_lanes_native` case 4 (lg-ell
  row cells; base preview as of every row).
- **Agent `dedalo_set_field` REPLACE** (`src/ai/mcp/tools/fields_write.ts`): on
  a lang-sliced field (`savesInRequestLang`) the item replaced is the one IN the
  requested lang — the base is never matched for a version (it appended a second
  version). Gate: `with_lang_versions_native` "setField REPLACE on a
  transliterable".
