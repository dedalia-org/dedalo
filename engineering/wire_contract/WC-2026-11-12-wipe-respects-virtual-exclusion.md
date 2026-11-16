# WC-2026-11-12-wipe-respects-virtual-exclusion — delete_data on a virtual section leaves what the section hides

- **Date:** 2026-11-12 (RC-closure item T1-23, audit OX3).
- **Decision:** PHP parity restored for the exclusion; stricter than PHP for an
  excluded main's frames (below). The shared section census is NOT narrowed (the
  observer host predicate, the covered-slot recompute, `source_overwrite`, the
  declared-order and observer reconciles read it unchanged) — that wider question
  is an open owner decision (T1-23 D1), not decided here. DEC-12 (gate in the
  same change).
- **Envelope / fields:** none. Stored-data behaviour of the wipe only.

## What was wrong

`deleteSectionData` (`src/core/section/record/delete_record.ts` — the `delete`
door's `delete_data` mode, the default; and the dataframe `delete_target` soft
policy) emptied every component of the section census
(`declaredSectionComponents`, `src/core/section/record/declared_components.ts`):
the own ∪ REAL subtree, with NO `exclude_elements` read. On a virtual section
(`rsc170` → `rsc2`, every thesaurus instance of `hierarchy20`, …) it emptied
fields the curator never sees in the edit form, wrote Time Machine pairs for
them, moved excluded media components' files into `deleted/`, and stripped an
excluded main's frames.

## Shape before

- **PHP:** `section_record::delete_data` (`class.section_record.php:1050-1066`)
  walks `get_ar_children_tipo_by_model_name_in_section($tipo, ['component_'],
  true, true /*resolve virtual*/, …)`: the REAL section's components minus the
  virtual's FIRST `exclude_elements` child's relations, expanding only excluded
  `section_group`/`section_tab`/`tab` to their recursive children
  (`class.section.php:900-986`; v6 the same, `class.section.php:1489-1495,
  1714-1757`). An excluded COMPONENT kept its value but its `component_dataframe`
  children stayed in the walk, so its frames were emptied (a torn main).
- **TS (to c6a6a79e4a):** the full census — every excluded value emptied.

## Shape after (TS)

The wipe walks the WIPE SCOPE, `wipeScopeComponents`
(`declared_components.ts`): the census walk with every root passed through
`pruneExcludedSubtrees` (`src/core/ontology/virtual_scope.ts`, the one home of
the exclude law, beside `resolveVirtualEditScope` and `editScopeComponents`).
An excluded tipo is dropped WITH its whole subtree — a grouper's components, a
main's own dataframe slots — the rule every other TS exclude consumer already
applied (edit config, elements context, birth defaults, posterframe).

- An excluded main keeps its value AND its frames, wherever they are stored: a
  slot in scope that also holds frames whose `main_component_tipo` is excluded
  is not emptied wholesale; only each wiped main's own frames leave it
  (`wipeDeclaredSlotsOfMains`), and the slot's history rides those mains' rows.
- A real section (and a `<tld>0` root) excludes nothing: its scope is its census.
- Only the FIRST `exclude_elements` child counts (PHP `[0]`).
- The modified stamps refresh on every wipe, even when nothing was emptied.
- `wipe ⊆ census` holds by construction (same walk, filtered), so every slot
  the wipe empties is one the covered-slot restore recomputes.

## Consequences

- A value left on a hidden field may still be PUBLISHED if a diffusion map names
  the excluded tipo — PHP parity.
- Records already wiped on an installation since the 2026-07-11 cutover keep
  their emptied hidden fields; every wipe wrote a per-component Time Machine
  backfill row with the old value, recoverable per component. Whether a
  reconcile repair is offered is open owner decision T1-23 D2.

## Gate reconciliation

No parity gate or frozen fixture covers a virtual-section wipe (no re-harvest
question). Native gate: `test/unit/delete_data_virtual_exclude_native.test.ts`
(scratch `zzvex` situation) — directly excluded component, a component inside an
excluded grouper, an excluded main with its frames, a shared slot, a record
holding only excluded data, the second `exclude_elements` ignored, the real
section wiped whole, and the wipe-scope ⊆ census / = edit-scope alignment.
Related: WC-2026-11-10-wipe-filter-user-default (the same wipe's filter reset),
WC-2026-11-12-posterframe-identifying-image-scope (the same edit scope).
