# WC-2026-08-30-section-id-counter-is-a-high-water-mark — a section_id counter records ids MINTED, not records ALIVE; no writer may lower it

- **Date:** 2026-08-30, adopted with the change that closes audit row P0-14
  (findings DATA-07 + LIFE-01).
- **Decision:** DEC-12 (the invariant lands with its gates:
  `test/unit/matrix_counter_monotonic_tripwire.test.ts` — a TOTAL census of
  counter DML shapes — and `test/unit/matrix_counter_monotonic_native.test.ts`,
  which drives the audit's own repro). The divergence is DELIBERATE: it removes
  a PHP behaviour that re-issued the permanent addresses of deleted heritage
  records, and no transformation of the response recovers from it, so it is
  recorded here rather than absorbed.

## The premise the PHP shape got wrong

`matrix_counter.value` is the highest `section_id` EVER MINTED for a section. It
is not a count of that section's live records, and it is not expected to equal
`MAX(section_id)`. **`counter > MAX(section_id)` is the NORMAL state of any
section that has ever had a record deleted from its tail** — which, on a
long-lived heritage install, is most of them.

PHP's `counter::check_counters` reported any inequality as drift, and the
maintenance panel offered two buttons to "repair" it. Both repairs were
destructive, because both were derived from the live rows:

- `consolidate_counter` (`counter_action:'fix'`) ran
  `UPDATE matrix_counter SET value = MAX(section_id)` — the single place in the
  tree that could move a section-id counter DOWN.
- `delete_counter` (`counter_action:'reset'`) DELETEd the row, after which the
  allocator's missing-counter bootstrap re-derived a restart point from
  `COALESCE(MAX(section_id),0)+1` over the rows still alive.

## Why re-minting an id is not a cosmetic defect

A `section_id` is the permanent address of a record's Time Machine history, its
media files, its diffusion rows and its activity trail — and **none of those
stores carries a generation of its own**:

- `tool_time_machine` matches history purely by `(section_tipo, section_id,
  tipo)`, so a record born at a re-minted id inherits the dead record's entire
  TM history, its panel lists the dead record's snapshots as its own, and a
  restore writes the dead record's values into it with `ok:true`.
- Media identity is exactly `{component_tipo}_{section_tipo}_{section_id}`, so a
  reused id keys straight into the dead record's files. `component_av` re-derives
  `files_info` from disk on every read and plays the dead object's derivatives;
  `tool_update_cache` / `media_repair_files_info --apply` then PERSIST the wrong
  attachment.

The audit's repro, now a gate: create 1..100, delete 71..100, press "Fix counter"
(single confirm) → counter 70 → the next create is born at 71.

## Shape now (TS)

1. **`counter_action:'fix'` is RAISE-ONLY.** It is the `GREATEST(...)` upsert
   every other counter writer in the tree already uses
   (`src/core/update/transform/locators.ts`), so it repairs the one genuine
   defect — a counter that LAGS its data after an import that bypassed the
   allocator — and can never move a counter down.
2. **`counter_action:'fix'` now CREATES a missing counter row.** PHP's create
   branch was inert (its value pre-incremented to 1, so the branch never fired).
   Materializing the high-water mark is the whole purpose of the action.
3. **`counter_action:'reset'` IS REFUSED** — `maintenance.action_refused`
   (caller/4xx, disclosure `public`), nothing written. The refusal names the
   reason, because this removes a button administrators have used for years.
   There is no repair `reset` performed that a raise does not.
4. **BOTH allocator doors seed a missing counter from the floor.** The
   counter-driven `insertMatrixRecordWithCounter` AND the explicit-id
   `insertMatrixRecordWithExplicitId` — the latter seeded a row it created at
   the explicit id alone, after which the next counter-driven create took the
   EXISTS branch, never consulted the floor, and was born at a dead record's
   address with no collision to fire the self-heal.
   **The floor no longer derives from live rows alone.** `counterFloorExpression` (`src/core/db/matrix_write.ts`)
   is the ONE definition of that floor —
   `GREATEST(MAX(live section_id), MAX(matrix_time_machine.section_id))` for the
   tipo — and every door that bootstraps or repairs a counter uses it: the
   allocator's bootstrap, its S2-01 collision self-heal, and the maintenance
   widget's `fix`. A door with a NARROWER floor than the allocator would be a
   repair that re-mints dead ids, i.e. worse than doing nothing.
   The floor applies to BOTH counter tables. An earlier draft of this change
   excluded `matrix_counter_dd` "because TM does not track the ontology tables";
   nothing enforces that — `recordTimeMachine` skips only TM_EXCLUDED_SECTIONS
   (dd15) and non-positive ids — so the narrow floor rested on an unverified
   premise, which is the shape of the defect this entry closes. Where TM holds
   no rows the subquery yields 0 and the GREATEST changes nothing.
   The same floor now also seeds the two post-COPY import doors
   (`install/hierarchy_import.ts`, `ontology/data_io_import.ts`), whose
   `GREATEST` already stopped them lowering a counter but whose newly CREATED
   rows were still derived from live rows alone.
5. **A tipo rename CARRIES its counter** (`src/core/update/transform/tipos.ts`).
   PHP `changes_in_tipos:997` dropped the old row and left the new tipo with
   none, trusting the bootstrap to "rebuild" it — but the rename moves the
   records and their TM rows without changing a single `section_id`, so the
   high-water mark has to move with them. BOTH counter tables are carried (the
   ontology node that would say which one governs the section may already be
   renamed or gone at transform time, and carrying from a table that holds no
   row is a no-op). An IDENTITY entry (`{old: X, new: X}`, routine in a
   hand-maintained move_tld map) is a no-op: without that guard the carry
   upserts the row onto itself and the drop then destroys it.

   The panel's AUDIT reads both counter tables too, so it can observe the
   repairs it offers.
6. **`resetTestSection` raises instead of exact-setting** its counter
   (`src/core/test_data/seed.ts`). It runs on REAL databases — the installer and
   the `unit_test` maintenance widget — and its TRUNCATE does not remove TM rows,
   which is the reason the sibling `restoreCanonicalTest3` was already raise-only.

7. **The audit measures drift against the HIGH-WATER MARK, not `MAX(live
   section_id)`, and says so on the wire.** The `counters_status` datalist gains
   a `floor_value` key beside `last_section_id` — an ADDITION to the
   differential-pinned key set, gated in `widget_request_native.test.ts`.

   The audit is NOT sourced from the counter tables alone. The install this
   panel most needs to show is the one where the removed `reset` DELETED a
   counter row: that section then has records, a time-machine history and NO
   counter, so an audit built from counter rows would not list it at all — it
   would be flagged by nothing, repaired by nothing, and `repair_all_counters`
   would answer that everything was fine. Every ontology section is a candidate
   (through the cached `listSectionNodes` accessor, never a raw `dd_ontology`
   read); those with neither a counter nor any history are dropped.

   **A floor far above the live data is flagged but excluded from the BULK
   repair.** Raising a counter is irreversible — no writer may lower one and
   `reset` is gone — and the time machine can witness ids no record holds:
   measured on a real install, `dd128` (23 live records, counter 39) carries a
   TM row at section_id 999000777 left by fixtures from an era when tests shared
   a database. The floor is RIGHT (that id was minted, and the allocator's own
   floor deliberately has no ceiling — over-allocating is safe, re-minting is
   not), but moving a live section's counter by 10^9 is a decision a person
   makes per row with the number in front of them, not a side effect of one bulk
   click. `bulk_repair_excluded` marks such rows; they stay flagged and stay
   repairable one at a time. `BULK_REPAIR_MAX_GAP` is a guard on
   IRREVERSIBILITY, explicitly NOT an id band and NOT a correctness rule — a
   heritage section may legitimately reach any id, so no band is excluded from
   the floor.

   A section whose high-water mark CANNOT be measured (its ontology names a
   table the write layer does not recognize, or the query fails) is reported
   UNVERIFIED in `errors[]`, never as a `floor_value` of 0 — a swallowed failure
   that renders as 0 is indistinguishable from a healthy section on the one
   panel that has to be trusted.

   The audit reports the counter row in the table that GOVERNS each section
   (`counterTableFor`, exported from `matrix_write.ts` so the widget and the
   allocator cannot disagree), treating a missing governing row as 0 — itself a
   lagging state, and repairable. A counter sitting in the OTHER table is
   surfaced as an `errors[]` line naming it, never folded into the compared
   value: an earlier draft collapsed both tables with `MAX(value)`, which would
   report a stale high row in the non-governing table as healthy while the
   governing counter went on lagging and re-minting dead ids.

   This is the half that repairs the past rather than fencing the future. An
   install where the old consolidate-down button ever ran sits at
   `counter == MAX(live section_id)` EXACTLY, so drift measured against live MAX
   is zero: the panel reports it healthy, offers no repair, and the allocator —
   whose counter row EXISTS, so the bootstrap floor is never consulted, and
   whose next id was DELETED, so no collision fires the self-heal — quietly
   re-mints the dead ids. Measured on a scratch section before this half landed:
   audit row `counter_value 3 / last_section_id 3` (no drift shown) and the next
   mint born at `4`, inheriting that dead record's time-machine row.

8. **A new maintenance action, `counters_status.repair_all_counters`, raises
   every counter already standing below its high-water mark** — the bulk form of
   `fix`, admin-gated, raise-only, idempotent, and reporting which tipos it
   moved.

   It is an ACTION, not a boot migration, deliberately. A bulk correction of
   SHARED rows may not ride the `install/db/migrations/` lane: that lane admits
   shared DML only as a TAGGED, `@>`-pinned SINGLE-ROW seed correction
   (`test/unit/migration_shared_row_tripwire.test.ts`), and a counter value is an
   integer no jsonb containment can pin. A first draft of this change shipped
   exactly that migration and the tripwire refused it — correctly. The repair
   therefore lives where every other shared-row write lives: in the engine,
   behind the maintenance gate, run deliberately.

   **The consequence is stated plainly rather than papered over:** the repair of
   an already-damaged install is OPERATOR-DRIVEN. Nothing raises those counters
   at boot. What the engine does on its own is make the damage VISIBLE — the
   panel now flags `counter_value < floor_value` and offers the repair, where
   before it showed the same install as healthy.

   It repairs what the time machine witnesses. A record created and never edited
   appended no TM row, so an id lost that way stays unwitnessed; and it cannot
   detect re-mints that already happened — nothing recorded, at mint time, that
   an address was being issued twice.

## Client half

`client/dedalo/core/area_maintenance/widgets/counters_status/`:

- the **"Reset counter" button is gone** from every data row;
- ONE drift predicate, `counter_lags(item)`, serves BOTH the per-row decoration
  and the bulk "Repair all counters" count. They diverged once — the per-row
  test carried an extra `last_section_id !== 'empty'` conjunct, so a section
  whose records were ALL deleted (live MAX 0 rendered as "empty", floor above 0:
  the most damaged row an install can carry) was never flagged while the bulk
  button counted it, and the page offered to repair a row it was not marking.
- the `out_of_sync` decoration is now `counter_lagging`, and fires ONLY on
  `counter_value < floor_value` — the high-water mark, not `last_section_id`. A
  counter ahead of its data is healthy and is left undecorated, with no button
  offered; a counter below the mark is flagged even when it equals live MAX.

Both halves are needed. The client half is what stops the curator being TOLD
their install is broken and invited to press the thing that breaks it; the server
half is what protects the record from every other door.

## Honest limit — what this does NOT do

The TM-derived floor WIDENS the bootstrap's floor; it does not guarantee it. TM
is conditionally written (a create appends no TM row, `saveTm:false` suppresses
them for bulk imports, `TM_EXCLUDED_SECTIONS` skips dd15) and is append-only by
convention, not by constraint. It is damage limitation for counters already
destroyed by an old reset, a rename or a restore. **The guarantee is that no
writer lowers the counter**, which is what the census tripwire enforces.

Nothing can retroactively detect re-mints that already happened: no store
recorded, at mint time, that an address was being issued a second time. Existing
records are grandfathered; this fences the future.

The remaining half of P0-14 — a discriminator so a re-minted id cannot inherit a
dead record's TM history even where a counter was lost before this change — is
tracked separately and is NOT closed by this entry.

## Gate reconciliation

New gates:

- `test/unit/matrix_counter_monotonic_tripwire.test.ts` (hermetic tier;
  registered in `engineering/TRIPWIRES.md`, `scripts/verify.ts` and
  `scripts/ci/hermetic.sh`) — the TOTAL shape census. It classifies BOTH halves
  of a statement: the ON CONFLICT clause must guard the counter's OWN value
  (`GREATEST(EXCLUDED.value, 0)` is a plain overwrite), and the SEED must not be
  derived from live rows alone. Earlier drafts of this gate were separately
  green against: a lowercase `delete from matrix_counter`; a statement that was
  raise-shaped on conflict while seeding from `MAX(section_id)`; a
  `GREATEST(EXCLUDED.value, 0)`; a `TRUNCATE`; a counter table reached through
  `${counterTable}`; and a psql copy reverted with only its COMMENT left intact.
  Each is now a proved-red case. Plus the client pins: the `reset` handler is
  gone, `out_of_sync` is gone, one shared drift predicate serves the per-row
  flag and the bulk count, and the LESS grid declares exactly as many tracks as
  the renderer emits cells.
- `test/unit/matrix_counter_monotonic_native.test.ts` — the audit's repro, the
  destroyed-counter case, `fix` raising to the HISTORICAL floor (not live MAX),
  `fix` materializing a missing row, `fix` refusing to lower, the `reset`
  refusal, the tipo-rename carry, and the identity-rename no-op.

Existing gates rewritten in the same change, because they asserted the RETIRED
contract and would otherwise have gone red on a behaviour this entry
deliberately removes:

- `test/unit/widget_request_native.test.ts` — `fix consolidates the counter to
  the section MAX(section_id)` injected UPWARD drift and asserted the counter
  came back down; it now injects DOWNWARD drift and asserts the raise, then
  proves upward drift is left untouched. `reset deletes the counter row` now
  asserts the refusal and that the row SURVIVES. The file's header contract
  prose is updated with it.
- `test/unit/ontology_ingest.test.ts` — `consolidateSectionCounter sets
  matrix_counter to MAX(section_id)` pinned the superseded seed; it now also
  asserts the seed lands on a time-machine-witnessed id ABOVE live MAX.
- `test/unit/transform_engine.test.ts` — asserted only that the SOURCE counter
  was gone, which a bare drop satisfies as well as a carry; it now asserts the
  destination carries the source's value, and sweeps both counter rows.
- `test/unit/test3_canonical_fixture.test.ts` — asserted the reset set the
  counter EXACTLY to the canonical max; it now seeds the counter below (asserting
  the exact landing value) and then above (asserting it is not lowered).

Every gate above was verified by reverting the corresponding fix and observing
it go red — the audit's repro returns `3` where it must return `6`; the widget
with a live-rows-only floor lands on `2` where it must land on `4`; the identity
rename leaves `null` where the counter must stand.

No parity fixture is affected and **no re-harvest is needed**: the frozen oracle
store holds READ responses, and no harvested gate drives `modify_counter`.

## Addendum 2026-11-12 — TM_EXCLUDED_SECTIONS is now {dd15, dd655, dd1521} (T1-20 / O16)

- **What changed:** the premise text above ("`recordTimeMachine` skips only
  TM_EXCLUDED_SECTIONS (dd15)", "`TM_EXCLUDED_SECTIONS` skips dd15") now reads
  (dd15, dd655, dd1521): the TS port restored the PHP v7 list
  (`class.tm_record.php` `$excluded_section_tipos`). The set lives in
  `src/core/concepts/section.ts`; every TM writer funnels through
  `time_machine.ts` `isAuditedAddress`.
- **Floor reasoning unchanged:** excluded sections are exactly where TM
  witnesses nothing new, which is the case the honest limit already covers —
  GREATEST can only widen, and the counter is never lowered. dd655 / dd1521 rows
  written before the change still witness their ids.
- **Wire:** no envelope changes; a save/delete on these sections succeeds as
  before and simply leaves no history (PHP parity, not a new divergence).
- **Gate:** `test/unit/tm_excluded_sections_native.test.ts`.
