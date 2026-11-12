# WC-2026-11-11-export-inverse-callers — `component_inverse` exports its callers (one column per caller pair, item_index stamped); `dedalo_raw` exports derived models' computed value

- **Date:** 2026-11-11 (RC-closure, tool_export model coverage).
- **Decision:** owner decision 2026-11-11 (breakdown spreads callers like any relation); DEC-12
  (gates in the same change). Sibling of `WC-2026-11-11-export-related-references-column`.

## Shape before (PHP)

`component_inverse::get_export_value` (`core/component_inverse/class.component_inverse.php:288`)
emitted one atom per inverse locator, value = `from_section_id` (int), path = host segment + a
caller-pair sub-segment `{section_tipo: from_section_tipo, component_tipo: from_component_tipo}`
WITHOUT `item_index`, plus a per-pair `value_index` in the atom meta. The tabulator
(`tools/tool_export/class.export_tabulator.php place_atom` :437-470) never reads `value_index`, so
in EVERY breakdown mode all callers of a pair landed in ONE joined cell — despite the docblock
promising row expansion. `dedalo_raw` (`build_raw_export_data`) wrapped `get_data()`, which for the
derived models (`component_inverse`, `component_relation_children`, `component_relation_index`) is
the computed value.

## Shape before (TS)

`component_inverse` (e.g. `dd1596`, the *Section info* Relations field) exported EMPTY in every
format: no `flatValue` family → `resolveCellValue` ledgered it unresolved; `dedalo_raw` read the
empty stored `misc` slot → `null`. The export's D4 display carve-out treated a derived model's empty
stored slot as "holds no data".

## Shape after (TS)

- **flatValue family `inverse`** (`component_inverse` descriptor). Callers = the component's
  computed backlinks, sorted per pair by caller `section_id` ASC.
- **Atoms:** one per caller, value = caller `section_id`; path = host segment + caller-pair
  sub-segment `{section_tipo: from_section_tipo, component_tipo: from_component_tipo, model: null,
  item_index, section_id: null}`. `item_index` = the caller's position among that pair's callers
  in the grid_value walk ONLY (WalkMode `callerIndex`); `null` in the value fold, where an index
  would zip UNRELATED callers of different pairs into one record by position.
- **value:** ONE column for the declared field (header = the declared path, e.g. *Relations* — a
  `misc` leaf takes no walked label), cell = every caller id: a pair's ids joined `', '` (the
  pair sub-segment declares no separator), in `section_id` order; the pairs joined by the inverse
  leaf segment's `fields_separator` (caller ddo → properties → `', '` — `11, 12 | 21` when one
  is declared). PHP's join of the same index-less atoms.
- **grid_value:** one column per caller pair (key = host + sub-segment identity; `label`
  `<inverse component> | <caller component>`, the caller section in `ar_labels`);
  `default` / `rows` → row n holds the n-th caller of EVERY pair (independent columns: the record
  takes as many rows as its largest pair); `columns` → `|n` columns. DELIBERATE
  DIVERGENCE: PHP put every caller of a pair in one cell in all modes (unread `value_index`); TS
  stamps `item_index` so callers spread like any relation's items.
- **dedalo_raw:** the derived models export their COMPUTED value as `{"dedalo_data": [...]}` (PHP
  parity) instead of `null`. Re-import skips derived models (nothing stored to write).
- **Authz:** callers the requester cannot read (section grant + projects boundary) are omitted —
  the same list the component's edit view serves; global admins see all. The scope is passed
  explicitly (the run's frontier principal) and FAILS CLOSED to the ALS principal when absent.
- **Re-check on every later read:** each distinct caller section that reached an atom or a raw
  cell is recorded in the run's `frontier_grants` as `(section, section)` (atoms.ts
  `recordInverseCallerGrants`, scoped runs only) — the exact question the build asked (leg 1 of
  `scopeInverseReferenceHits`); leg 2 (projects) is re-asked by the record-scope fingerprint. A user
  who loses read on a caller section can no longer open an artifact that names its callers. The
  caller COMPONENT is deliberately NOT recorded: the build never asks it (the edit view's rule is
  the section grant), so recording it would refuse an export the build lawfully produced.
  relation_children / relation_index raw cells record nothing — parity with their fan-out, which
  records only the component grants it reads at those records.
- **D4 carve-out:** a derived model's empty stored slot no longer counts as "holds no data".

## Reason

The backlinks column was silently empty — an export narrower than the screen with no notice. A
breakdown that keeps every caller in one cell defeats the breakdown; the owner chose the
relation-consistent layout over the PHP fossil.

## Gate reconciliation

- `test/unit/tool_export_inverse_native.test.ts`: value columns per pair (header, `', '` join,
  `section_id` order), grid_value in `default` / `rows` / `columns`, atom path `item_index`,
  `dedalo_raw` computed value for the derived models, unreadable callers omitted (global admin sees
  all), D4 carve-out.
- Fixtures: no `tool_export_differential` / `tool_export_breakdown_differential` fixture carries a
  derived-model column (`component_inverse`, `component_relation_children`,
  `component_relation_index`; `dd1596` appears only in the env `DD_TIPOS` dump) — no fixture edit,
  no re-harvest.

## Addendum — `component_3d` declares `flatValue: 'media'` (same day)

Found by the widened T0-9 census (every canonical model reachable as an export leaf declares a
family). `component_3d` declared none, so its export / panel cell was a ledgered `null` in every
format — while `component_av`, whose PHP export override is the same, declared `'media'`. Now:
`exportBase` + the `DEDALO_3D_QUALITY_DEFAULT` (`web`) `files_info.file_path`, ledgered when the
export base is unset, exactly as every media model. `relation_list_cell_families_native` had pinned
the old `null` under a false premise ("the media contract declares no default quality for 3d"); it
now pins the composed URL.
