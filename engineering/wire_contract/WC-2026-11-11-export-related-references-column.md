# WC-2026-11-11-export-related-references-column — per-ddo `value_with_references` → sibling `#references` column of a related's calculated relations

- **Date:** 2026-11-11 (RC-closure item T0-9, phase 3b).
- **Decision:** owner decision T0-9 D4 (re-opened and decided 2026-11-11); DEC-12 (gates in the
  same change). Sibling of WC-049 (the `#parents` column).

## Shape before (PHP)

The export calls `get_data()` on a `component_relation_related` (`class.component_relation_common.php:787`):
the STORED locators only. The calculated relations — the references a bidirectional (`dd467`) or
multidirectional (`dd621`) related derives from the records pointing at it — come only from
`get_data_with_references()` (`class.component_relation_related.php:114`), which the export never
calls. No export option reaches them.

## Shape before (TS)

As PHP for the main cell after `WC-2026-11-11-export-value-single-walker` (stored only). No way to
export the calculated relations.

## Shape after (TS)

The main cell stays STORED only (PHP). A NEW opt-in, per column:

- **Flag:** `ar_ddo_to_export[].value_with_references` (per-ddo only, like `value_with_parents`;
  no request-global key). `compile_columns.ts` → `exportColumn.valueWithReferences`. The client
  shows a per-column **references** checkbox only for `component_relation_related` columns
  (`render_tool_export.js REFERENCES_MODELS`), disabled in `dedalo_raw` with the
  `references_not_in_raw` note; presets carry the flag on the ddo.
- **Content: calculated only** — `locator_source.ts calculatedLocators` =
  `get_data_with_references()` MINUS the stored locators by the locator equality law
  (`compareLocators`): `dd467` one inverse hop, `dd621` the recursive closure. Never a repeat of
  the main cell. A `dd620` (unidirectional) related, a declared dataframe step, or a non-related
  leaf grows no column (`fieldHasValueReferences`, pure ontology: the same column set for every
  record of a run).
- **Emission:** the declared leaf's calculated locators fan out through THE SAME
  `fanOutRelation` (config children, separators, frontier crossing of every target) under the
  declared chain + a `{sub_id:'references', item_index:null}` segment on the leaf carrying the
  leaf's separators. The declared leaf only: no parents and no nested references below it.
- **grid_value:** the segment identity mints the column `<top>#references`, label leaf
  `references`.
- **value:** ONE sibling column `<top>#references` (header `<column> | references`, `cell_type`
  `text`, model `null`), sorted after the term column and its `#parents` column (sortKey
  `[ddo, 1]`), its cell the `joinExportAtoms` fold of those atoms (the segment stripped). Present on
  every record when the flag is set on an eligible leaf; the cell is absent when the record has no
  calculated relation. A record that stores nothing still exports its `#references` cell. Media a
  references walk reads is credited to the `#references` column, never to the main cell.
- **dedalo_raw:** ignores the flag (stored data only) — byte-identical to the flag off.
- **Frontier law:** every calculated target is a crossing (T0-1); a hidden calculated target
  throws `perm.export_column_out_of_scope` naming the column.
- **Labels:** `value_with_references` and `references_not_in_raw` added to
  `tools/tool_export/register.json` (en / es / ca / fr …, 10 languages each) — an additive growth of
  the tool's `get_element_context` labels.

## Reason

Owner decision D4: the default export is the real relation (stored, as PHP); the calculated
relations are useful but must never be confused with it, so they travel only on request and only in
a column of their own.

## Gate reconciliation

- `test/unit/tool_export_value_relation_native.test.ts`, block *D4 — calculated relations: the
  opt-in `#references` column*: the core seam (calculated = the `dd467` closure minus the stored);
  value flag ON (main = stored, `#references` = calculated) / OFF (no column, main unchanged);
  grid_value flag ON / OFF; a record that stores nothing; `dedalo_raw` byte-identical; media
  credited per column (capture), an empty main cell does not swallow the references media; `dd620`
  grows no column in either format. G6 block: a hidden calculated target under `#references`
  throws by the column.
- `test/parity/tool_element_context_differential.test.ts`: the two labels join the `ADDED` set
  (the frozen `get_element_context` of `tool_export` lacks them; the WC-2026-08-23 additive pattern)
  — no fixture edit, no re-harvest. No `get_export_grid` fixture carries the flag: with it off the
  output is unchanged.
- Client: `client/dedalo/test/client/js/test_tool_export.js` *TOOL_EXPORT REFERENCES CHECKBOX* (gated by model, disabled with a note in `dedalo_raw`, preset round-trip).

## Addendum 2026-11-11 — eligibility is the server's, a forged flag is refused (review round B)

- **Shape before (TS, this entry as first written):** the checkbox was gated by MODEL only
  (`REFERENCES_MODELS`), so a `dd620` related offered it, and a `value_with_references: true` on any
  ineligible leaf (a `dd620` related, a portal, a hand-edited preset) was silently ignored — the
  export narrowed what was asked without saying so.
- **Shape after (TS):** ONE predicate, `locator_source.ts componentHasCalculatedLocators` (a
  `component_relation_related` with `dd467` / `dd621`), answers both sides:
  - new READ-gated, ontology-only action `tool_export.components_with_references`
    (`{components:[{tipo, section_tipo}]}` → `{ [tipo]: boolean }`, `request.invalid_options` on an
    empty list) — the client renders the references checkbox only on `true`
    (`component_has_calculated_relations`, cached per tipo; `REFERENCES_MODELS` stays as the
    request-saving pre-filter, like `PARENTS_MODELS`);
  - `compileExportPlan` REFUSES the flag on any other leaf with `request.invalid_options`
    (`publicMessage` names `ar_ddo_to_export[n].value_with_references` and the tipo) — in every
    format, `dedalo_raw` included (the flag is invalid there too; an ELIGIBLE leaf's flag is still
    ignored in raw).
- The checkbox's pointer containment moved from the `<label>` to its native `<input>` (parents
  check too), so the keyboard path is the input's own (`client_keyboard_activation_tripwire`; the
  `render_tool_export.js` a11y backlog fell 5 → 3).
- **Gates:** `tool_export_value_relation_native` D4 block — the forged flag on a `dd620` related
  and on a portal is refused in value / grid_value / dedalo_raw (and the same columns export without
  it; an eligible `dd467` column with it is accepted); `compileExportPlan` refuses before any walk;
  the `components_with_references` truth table (`dd467` / `dd621` true, `dd620` / portal false,
  empty list refused) — replaces the old "`dd620` grows no column" leg. `tool_export_sqo_gate`
  surface pin lists the new action. Client: *TOOL_EXPORT REFERENCES CHECKBOX* uses `test56`
  (`dd621`) for the checkbox and asserts NO checkbox on `test54` (`dd620`) and on a portal.
