# WC-2026-11-10-wipe-filter-user-default — a data wipe resets component_filter to the WIPER's default projects, with a counter id

- **Date:** 2026-11-10 (RC-closure item T0-5, audit OX3).
- **Decision:** owner decisions T0-5 D2 (item id from the component counter) and
  D3 (the birth cascade as-is); DEC-12 (gate in the same change).

## What was wrong

`deleteSectionData` (the `delete_data` mode of the record delete, and the
dataframe `delete_target` soft policy) empties every component of a record except
`component_filter`, which it resets instead of emptying. Since the 2026-07-11
cutover the TS engine reset it to a CONSTANT:

```json
[{ "type": "dd151", "section_id": <DEDALO_DEFAULT_PROJECT>, "section_tipo": "dd153",
   "from_component_tipo": "<filter tipo>" }]
```

— the configured default project whoever wiped, the LINK relation type instead of
the filter type `dd675`, and no item `id`. A project-scoped non-admin who wiped a
record of their own project moved it out of their own scope: they could no longer
see it, edit it, or revert the wipe.

## Shape before (PHP)

`section_record::delete_data` (`class.section_record.php:1111-1115`) calls
`component_filter::get_default_data_for_user($user_id)` with the WIPER's id
(`class.component_filter.php:302-470`), then `set_data()`, which gives every
id-less element the component's next counter id (`set_data_item_counter`;
delete_data keeps the meta counters, so it is the previous count + 1):

```json
[{ "id": <count+1>, "type": "dd675", "section_id": <first project | default>,
   "section_tipo": "dd153", "from_component_tipo": "<filter tipo>" }]
```

## Shape after (TS)

The PHP shape. `wipedComponentValue` (`src/core/section/record/delete_record.ts`)
resolves the same cascade a record is born with — `resolveDefaultFilterData`
(`record_defaults.ts`, see WC-2026-08-09-record-birth-defaults): a non-global-admin
with projects → their FIRST project; a global admin, or a non-admin with none → the
configured default project — and allocates each item's id with
`allocateComponentItemId`, inside the wipe's transaction and row lock. The Time
Machine row the wipe writes for the key carries the same value.

## Consequence for the bulk revert

The wiped filter is now a function of WHO wiped and WHEN (their projects then, the
counter then), so the bulk revert of a soft cascade
(`tools/tool_time_machine/server/bulk_revert_records.ts` `isWipedState`) no longer
recomputes "the wiped value": it compares the live key with the value the wipe
itself wrote, read back from the wipe's own history row (the key's first visible
row after the run's role-4 twin, skipping a backfill row). This also recognises a
wipe made before this change (its row holds the old constant). A wipe whose row
cannot be found is never guessed: the key reads as written since and the record is
kept.

## Records already wiped on an installation

Every TS-era wipe up to this change left the constant above (string `section_id`
before WC-2026-08-10-section-id-int-canonical). The id-less `dd151` locator is a
TS-wipe-only signature — PHP `set_data` and the birth door always stamp an `id`.
They are found and repaired from their Time Machine pre-wipe value by the
operator-run `wiped_filter_projects` reconcile (Maintenance → reconcile panel).

## Gate reconciliation

No parity gate or frozen fixture covers a wiped filter (no re-harvest question).
Native gate: `test/unit/delete_data_filter_native.test.ts` — non-admin, global
admin, no-project fallback, the `delete_target` policy, and the bulk revert
(wiper ≠ reverter, a pre-fix wipe, a write after the wipe kept, a missing history
row kept).
