# WC-2026-11-11-relation-index-related-list-context — a config-less component_relation_index carries its pointing sections' related_list columns

- **Date:** 2026-11-11 (RC-closure item T0-8, audit O12).
- **Decision:** owner decisions T0-8 D1–D4 (2026-11-10, all option a); DEC-12 (gates in the same change).

## What was wrong

A `component_relation_index` with no `request_config` of its own (`hierarchy40` on every
thesaurus term, `rsc1051`, `tch475`, `tch5`, `tchi41`; suite twins `test25`, `test149`)
shipped `request_config: []`. The client builds the field's columns from
`request_config[*].show.ddo_map` items whose `parent` is the field's tipo
(`common.js get_columns_map`), so the field rendered rows with no columns. Its related_list
cell contexts were self-parented (`get_data`) or absent (section read), and its data items
carried no `parent`.

## Shape before (PHP)

`component_relation_index_json` + `get_section_datum_from_locator`: for each pointing
section, the section is built in mode `related_list` and its config (the section's
`relation_list` child — direct, then the real section's for a virtual one — authorized-filtered)
is APPENDED to the field's own dedalo config; every returned context gets
`parent = <index tipo>`. Frozen store, `get_data hierarchy40 @ cult1/1`, list:

```json
{"tipo":"hierarchy40","request_config":[{"api_engine":"dedalo","type":"main",
  "sqo":{"section_tipo":[{"typo":"ddo","tipo":"cult1",…},{"typo":"ddo","tipo":"rsc205","model":"section",…}]},
  "show":{"ddo_map":[
    {"typo":"ddo","tipo":"rsc349","section_tipo":"rsc205","parent":"hierarchy40","mode":"related_list",…},
    {"typo":"ddo","tipo":"rsc140","section_tipo":"rsc205","parent":"hierarchy40","mode":"related_list",…}],
   "sqo_config":{"limit":2,"offset":0,…}}}]}
```

plus the pointing section's own context (`model: section`, `mode: related_list`,
`parent: hierarchy40`) and its components' contexts, all parented to the index.

## Shape after (TS)

The PHP merge, built from ONE section-mode source (`sectionRelatedListConfig`) that also
feeds the field's data, so a column and its cells cannot disagree, with four deliberate
divergences from the frozen store:

- **D1 — every mode.** The merge applies in `edit` too. Frozen PHP v7 shipped
  `request_config: []` in edit (`relation_inverse_differential.json`, `hierarchy40 @ dz1/1024`),
  so the term edit form had no columns; v6's controller is mode-agnostic.
- **D2 — pointing sections only in `sqo.section_tipo`.** PHP prepended the field's own
  section (a v5 fallback artefact, e.g. `cult1` above); TS lists every section that points at
  the record. A section the viewer cannot read (level < 1) ships EXISTENCE ONLY —
  `{typo, tipo, model, permissions: 0, label, existence_only: true}`, no buttons/color/matrix_table — and contributes
  no ddo, no cell context and no data item. The client's next page carries this sqo; the read
  gate admits it through the host-component admission (`security/host_component_read.ts`),
  which accepts a config-less index's OWN pointing sections as its targets (any other section
  stays refused) — the inverse read never consults `sqo.section_tipo`.
  **The inverse SET is never filtered** (owner decision 2026-11-11): the field's `entries`
  and `pagination.total` carry every pointing locator, readable or not — a user decides
  whether a record may be deleted on "nobody points at it", so a hidden pointer would make
  that decision wrong. Only an unreadable section's CONTENT (its column values) is withheld:
  its row shows, at minimum, the caller's `section_id` and its section's NAME, with blank
  columns. The client renders that existence cell (`.target_existence`, label + `.section_id`)
  ONLY for a target the server marks `existence_only: true`; an ordinary portal whose target
  grant is 0 (WC-2026-11-09-component-get-data-host-gate) renders as before.
- **D3 — no pointing-section contexts.** The `model: section` / `mode: related_list` contexts
  are not emitted; no portal-path client file reads them. The components' cell contexts are
  emitted, parented to the index tipo, deduplicated by context key (PHP repeated them once
  per locator pass).
- **D4 — the full pointing set on every page.** PHP merged only the current page's sections
  when `offset > 0`; TS carries every pointing section's columns on every page, so columns stay
  stable while paging.

Data items gain `parent = <index tipo>` (PHP `sub_value->parent`); `from_component_tipo`
stays the item's own tipo.

A config-less index with NO pointer still ships one base item instead of `[]`:
`{api_engine:'dedalo', type:'main', sqo:{section_tipo:[]}, show:{ddo_map:[], sqo_config:{…}}}`
(the TS-measured pin in `test/parity/relation_corpus_config.test.ts`, `testcult1020`, moves
from `[]` to that item — PHP's frozen body there is an error, so no fixture changes).
`context.target_sections` follows the merged sqo (the pointing sections). In list `get_data`,
`sqo.limit` carries the page; `show.sqo_config.limit` keeps the base list value.

## Gates

`test/unit/relation_index_context_native.test.ts` (builds its own dd96 pointers on the suite
DB); context comparable in `test/parity/relation_index_get_data_differential.test.ts`
(projection applies D2/D3); client: `component_relation_index` columns test on a pre-run
pointer fixture (`client_situations_native.test.ts`).

## Addendum 2026-11-11 — one readability predicate, every index, every reader (T0-9 D6/D9)

- **D6 — the set is never filtered, anywhere.** Every reader of a `component_relation_index` gets
  every pointing locator: the edit form (as above), the export walk, the diffusion hops and the
  interactive flat reader (relation_list panel, Referencias) read it from ONE source,
  `src/core/relations/locator_source.ts` (the computed inverse set, unpaginated for the
  readers that need it whole). What is withheld is the CONTENT of a pointer in a section the
  requester cannot read, decided per pointing SECTION by ONE shared predicate,
  `pointingSectionReadable` (`getPermissions(section) >= 1`) — asked by the edit form
  (`models/relation_index.ts readableRelatedList`, `existenceOnlySections`) and by the children
  seam (`config_children.ts pointerIsExistenceOnly` → the address only), so the two cannot drift.
- **D9 — configured indexes too.** The rule above (D2's existence-only section, blank columns) now
  covers a `component_relation_index` WITH its own `request_config`, not only a config-less one: a
  pointer in an unreadable section expands no child cell, and that section's `sqo.section_tipo`
  entry ships `existence_only: true` (`emitOwnConfigIndexData` → `markExistenceOnlyInNode`). Edit
  form wire change for configured index fields: their columns are blank for such pointers, and the
  client renders the existence cell (section label + `section_id`).
- **The interactive reader** (`resolve/relation_list.ts`) renders such a pointer as
  `<section name> <id>`; the export does the same (D8, addendum to
  `WC-2026-11-09-export-frontier-fanout`).
- **Lang:** translatable related_list columns were read at `lg-nolan` and came back empty; they
  are now read in the request's data lang (`currentDataLang()`, PHP `DEDALO_DATA_LANG` parity).

Gates: `test/unit/tool_export_value_relation_native.test.ts` *D6* block (the full set for admin,
system and a scoped persona; the interactive reader's name + id; the edit form agrees — same
pointers, same columns withheld); `test/unit/relation_index_context_native.test.ts` *translatable
related_list columns resolve in the DATA lang (never the nolan slice)*.
