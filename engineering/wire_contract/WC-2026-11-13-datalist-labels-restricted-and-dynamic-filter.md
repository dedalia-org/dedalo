# WC-2026-11-13-datalist-labels-restricted-and-dynamic-filter — option labels without the frame separator, a restricted marker for a stored pick the list lacks, `filtered_by_search_dynamic` refused

- **Date:** 2026-11-13.
- **Decision:** owner rulings C2, C5, C6 (`T1_owner_decisions.md`, 2026-11-13;
  items T1-8 D1, T1-09 OD-1, T1-09 OD-2). DEC-12 gates:
  `test/unit/select_dataframe_subdatum_native.test.ts` (C2),
  `test/unit/datalist_record_filter_native.test.ts` (C5; C6 on the
  record-resolved filter), `test/unit/datalist_projects_scope_native.test.ts`
  (C6 on the caller's scope + the deleted-target control).
- Code: `src/core/relations/datalist.ts` — `isOptionValueDdo`
  (`resolveDatalistSources`), `refuseUnsupersededDynamicFilter` +
  `hasSupersedingFilter` + `declaresFixedFilter`, `getEditDatalist` →
  `appendRestrictedEntries` / `restrictedStoredLocators`,
  `getRelationListValue`, `DatalistItem.restricted`; the UI label key
  `restricted` (`src/core/labels/master.json` + every `catalog/lg-*.json`).
- Addenda the same day to `WC-2026-11-12-select-dataframe-subdatum` (C2) and
  `WC-2026-11-12-datalist-principal-record-scope` (C5 closes its "Not covered",
  C6 reverses its divergence #3).

## 1. C2 — a dataframe slot ddo is not an option label part

**Before (PHP = TS until today).** `get_list_of_values` imploded the value of
EVERY component-model show ddo with `' | '`. A `component_dataframe` ddo in a
select's `show.ddo_map` (the vendored carrier `numisdata291` → `numisdata872`)
names the HOST record's frames, not a value of the option record, so it
resolved to `''` on every option and each label ended in `' | '`
(`"Metal detector | "`), in the edit datalist and in the list value alike.

**After (TS).** `resolveDatalistSources` drops `model === 'component_dataframe'`
from BOTH the label ddos and the hide ddos. Labels are the non-frame show
ddos joined by `' | '`; a select with one label ddo and a slot labels
`"Metal detector"`. The slot keeps its own emission (the frame items of
`WC-2026-11-12-select-dataframe-subdatum`) — this is the label set only.

Divergence from PHP, stated: a separator glitch is not a contract (owner C2).

## 2. C5 — `properties.filtered_by_search_dynamic` is NOT ported

**Before (PHP).** `parse_search_dynamic` (`class.component_common.php
:2632-2708`), the v5 record-dependent option filter grammar, read in the
`?? filtered_by_search_dynamic ?? filtered_by_search` chain of
`get_list_of_values`.

**After (TS).** Not read, ever. Superseded by `fixed_filter
source:'component_data'` on the sqo of the component's request_config (the v7
translation every shipped node that carried it already has; no vendored v7
node declares `_dynamic` live — the legacy copies sit in ontology19 `propiedades`,
which this engine never reads). The datalist door reads the LIVE node
properties (`getNode(tipo).properties`) and:

- `_dynamic` present with NEITHER a `fixed_filter` (declared on the node's
  `source.request_config[*].sqo`, or present in the built sqo) NOR a
  `filtered_by_search` → the build is REFUSED: `DedaloError('ontology.invalid_node')`,
  status 503, operator disclosure, message
  `component '<tipo>' declares properties.filtered_by_search_dynamic, the v5
  record-dependent option filter, which this engine does not read (superseded).
  Declare its translation instead: a `fixed_filter source:'component_data'`
  entry on the sqo of its request_config (or properties.filtered_by_search),
  then remove the key.`, `coordinates.tipo` = the component. Every door on the
  list refuses (edit read, save echoes, list value, size probe, filter_by_list);
  nothing is served — never the full list under a filter the ontology meant to
  apply.
- `_dynamic` present NEXT TO either translation → ignored (the translation
  filters; `scripts/ontology_property_report.ts` still reports the key).

The DECLARATION supersedes, not the per-record expansion: a `component_data`
fixed_filter expands to no group on a record without a reference value, and
that record is not an invalid node (pinned: `DYNAMIC_SUPERSEDED` on `OC`).

## 3. C6 — a stored pick the built list lacks is MARKED, not hidden

**Before (PHP; TS since WC-2026-11-12-datalist-principal-record-scope).** The
list value (`get_list_value`) emitted only the labels of stored locators the
built list carried, and the edit datalist was the built list verbatim: a stored
pick outside the caller's scope (another project, a dd478 allow-list) or
outside the record-resolved `fixed_filter` had no label in list mode and NO
option in the edit widget — a `<select>` with no matching option renders its
empty option, and the next save of the field removes the pick unnoticed.

**After (TS).** Both doors look each stored locator the list lacks up by its
address (`memoizedReadMatrixRecord`):

- target row EXISTS → the EDIT datalist (`getEditDatalist`: the edit read and
  both save echoes) gains, after the built options and in stored order, one
  opaque entry `{ value: {section_tipo, section_id: INT}, label: <restricted>,
  section_id: INT, hide: [], restricted: true }`; the LIST value emits the
  `<restricted>` string in its place (after the matched labels). `<restricted>`
  is the `restricted` key of the UI label catalog in the request APPLICATION
  lang (`(restricted)` in the master source, translated per catalog) — a
  program string, not data. The option's real label is never disclosed.
- target row GONE (deleted) → nothing, as in PHP (the pick is a dangling
  locator; the Time Machine holds its history).

The marker rides only the doors that know the stored value: `getDatalist`'s
shared list (filters, the state widget, identify, the size probe) is
unchanged. A model-declared option source (`component_select_lang`) completes
through its own `editGuard` as before; the marker is the GENERIC source's
completion. Clients: `component_select` / `component_radio_button` /
`component_check_box` index the datalist by `value` and render `label` — the
extra key is tolerated with no client change; the opaque option is selected /
checked like any other and round-trips its `value` on save.

Why (owner C6): a silent disappearance invites an accidental removal on save.

## Gate reconciliation

- Frozen store: no fixture edited. `component_datalist_lifecycle_differential`
  and `grouper_context_differential` are corpus-bound (banked reds unchanged).
- `select_dataframe_subdatum_native` — new case "the option labels carry NO
  trailing separator" (RED before: `'option 1 | '`).
- `datalist_record_filter_native` — new nodes `zzdlr16` (`_dynamic` alone →
  refused, message names tipo + the fix) and `zzdlr17` (`_dynamic` +
  fixed_filter → built, on a record with and without a reference value);
  "the list value…" flips to `['Entry one', <restricted>]`; the edit/echo
  agreement case asserts the opaque entry for the stored out-of-list pick and
  equality with an echo of the same stored value. RED before: 3.
- `datalist_projects_scope_native` — the edit-door case asserts the opaque
  entry for `OUT_ID` and none for a never-existing `GONE_ID`; the list-value
  case flips to `['In project', <restricted>]`; new CONTROL "a stored locator
  to a deleted target is still blank". RED before: 2.
- `labels_tripwire`: the `restricted` key defined in the master and all 17
  catalogs.
