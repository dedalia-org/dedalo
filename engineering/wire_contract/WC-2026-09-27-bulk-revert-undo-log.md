# WC-2026-09-27-bulk-revert-undo-log — every bulk save records its undo pair; `bulk_revert_process` replays the log exactly and reports what it could not

- **Date:** 2026-09-27, adopted with the undo-log change (migration
  `install/db/migrations/0010_tm_role.sql`, writers in
  `src/core/db/time_machine.ts`, capture in `src/core/section/record/bulk_capture.ts`,
  the rewritten `tools/tool_time_machine/server/bulk_revert.ts`). Ships in the same
  release as the back-out of the bulk-revert heuristics (`f0ec7351e6`, decision D6):
  no release carries one without the other. The COMPOSED-row amendment of the same day
  (§8: a dataframe main and its frames are one history row, composition in
  `src/core/relations/dataframe_slots.ts`) replaced the per-slot pairs of the first
  design before anything shipped; the 2026-09-28 addendum (below) removed its
  row marker and every TS-era-row guard before anything shipped either.
- **Decision:** DEC-12 (the invariants land with their gates, below) and DEC-15 (the
  client is the spec at this seam: it now READS the revert payload and shows it).
  User decisions D1–D6 of 2026-09-27, recorded here as the rule they became.

## Shape before (PHP, and TS until 2026-09-26)

- `matrix_time_machine` had no role column. A bulk save wrote ONE row — the value
  AFTER the save — stamped with the run's `bulk_process_id`, or no row at all when
  the caller passed `saveTm:false` (the CSV tool's *Save time machine history on
  import* checkbox, the update_cache re-saves, a legacy envelope's frames).
- `bulk_revert_process` INFERRED each component's pre-run value: the history row
  immediately older than the run's row (`preBulkState`), or an empty value when the
  run's row was the component's only history. The walk ignored the language, took
  an interleaved row as the pre-run state, and blanked every component whose
  pre-run value was never recorded (stored before Time Machine, written with it
  off, or appended to).
- Payload: `data: {counter, bulk_process_id, skipped}`,
  `skipped[]` typed per WC-2026-09-03-bulk-revert-skipped-typed-entries. The client
  read only the truthiness of `data` and closed the window.

## Shape now (TS)

### 1. The `tm_role` column (migration 0010)

`matrix_time_machine.tm_role smallint NULL`, CHECK
`tm_role IS NULL OR tm_role IN (1,3,4)` (added `NOT VALID`; the migration sets its
own `lock_timeout` and the runner retries a lock timeout). When the boot run still
gives up, the column is added with the migration's own two statements
(`record_generation.ts` `ensureTmRoleColumn`, bounded lock wait) OUTSIDE a
transaction: first by the BOOT itself, right after the run and before the first
request (`install/db/migrate.ts` `runBootSchema`, whatever the run did — so the doors
that name the column INSIDE their own transaction, a referenced record's delete, a
data wipe, an observer mirror write, meet it only if that heal failed too), then by
the first caller of `ensureTmHistoryReady` outside a transaction — every
time-machine READER, and every BULK RUN at its start (`withLiveBulkRun`, before it
registers and before its first write). The undo-log writers themselves never heal:
each runs inside a transaction (a save's pair, a create's birth marker, a delete's
cascade twin), where the heal refuses. A caller inside a transaction, or a heal that
cannot get its lock, fails closed with `internal.invariant` naming the migration
(gate: `tm_role_self_heal_native`); the memo is set only once the ALTER has committed,
so a caller after a failed heal retries it. The statistics half (ANALYZE) runs after,
in its own transaction under the same lock bound, best-effort: its failure is logged
("statistics not collected"), never reported as a missing column. The heal is NOT the
epoch store's bootstrap: an ordinary record creation never names the column, so a
missing column never blocks one; a BULK create does (its birth marker), and is covered
by its run's start. The installer applies 0010 right after restoring the seed (which
predates it; install mode skips the boot runner).

| `tm_role` | Row | Visible |
|---|---|---|
| NULL | every row written before the change, every non-bulk write, the AFTER row of every bulk save | yes |
| 1 | BEFORE image: the exact region a bulk save replaced (`data` NULL = the key was absent) | no |
| 3 | BIRTH marker: a record a run created (`tipo` = section tipo, `lg-nolan`, `data` = its BIRTH IMAGE: the jsonb columns the INSERT carried from the ontology — projects filter, `dato_default` — or, for a revert's undelete, the restored snapshot) | no |
| 4 | the whole-record snapshot of a record the run's dataframe cascade deleted, with the bulk id | no (the ordinary delete snapshot stays visible) |

Role 2 (a hidden after-row) was designed and is NOT used (D1). Rejected markers, and
why: a negative bulk id (dd1371 is a numeric, range-searchable column and the client
offers a revert for any truthy id), `bulk_process_temp` (holds v6 ids on upgraded
installs), `state` (dropped by the v6→v7 upgrade; reusing the name collides with v6
history).

### 2. The pair law (D1)

- A save carrying a bulk id writes, for every key it CHANGES (the modified stamps
  excepted — named exemption below), a role-1 BEFORE row
  and then its ordinary VISIBLE after-row, both with the bulk id, one shared
  timestamp, in the save's transaction (`recordBulkPair`) — **whatever `saveTm`
  says**. The time-machine opt-out is retired for bulk runs; `saveTm:false` keeps its
  meaning only outside them.
- A save whose region is byte-equal before and after (canonical JSON) writes
  NOTHING — no pair, no visible row. A literal `set_data` item that names no id
  (a CSV cell) KEEPS the id of the stored item it equals at the same position
  (`src/core/concepts/item_value.ts`, the rule propagate shares), so the persisted
  region is byte-equal. So a re-import of an unchanged file, and an
  update_cache re-save that changes nothing, leave history untouched; one that DOES
  change something now writes visible history. update_cache skips a key that holds
  nothing (absent or empty): re-saving an ABSENT key as `[]` is a change the pair
  law records.
- REGION: for a lang-sliced model, the items that are not another language's
  (lang-less items included); for any other model, the whole key (`src/core/concepts/lang_region.ts`). **One absence law, both sides**: a
  region that holds nothing is ABSENT (`undefined`, SQL NULL `data`) — an absent key,
  a stored JSON `null` (the write chokepoint restores `null` as a key removal, so a
  `null` image could never come back byte-exact and its restore read as a post-run
  change on the next revert; `recordBulkPair` maps a `null` image to absence too),
  and, for a lang-sliced model, a key holding no item of the region (the same
  pre-run state was recorded `[]` when another language had written first and absent
  when not, so a second revert read a key already back as changed). An UNSLICED `[]`
  stays a present, empty key. A pre-run stored JSON `null`, or a sliced `[]`, comes
  back ABSENT — the same empty key to every reader. BEFORE is cloned from the value read
  under the save's row lock; AFTER is re-read from the row inside the transaction.
- **A dataframe main's pair is COMPOSED (§8).** Its images are the main region
  followed by the full frames of every slot of the main, and the pair sits under the MAIN's tipo. A slot save (a frame added, edited or
  removed) writes the pair of the main(s) it belongs to, never one under the slot
  tipo — no slot key has a pair of its own.
- A record a run creates gets a birth marker only when a row was really inserted.
  The dd800 run record itself is never marked: its label and file saves carry no
  bulk id.
- A dataframe target the run's cascade deletes gets a role-4 twin of its delete
  snapshot. The locators OTHER records held to it, which the delete strips
  (`removeAllInverseReferences`, and the owner's slot frames it empties), are
  ordinary pairs under the same bulk id: before = the owner's key as locked,
  after = as persisted. A slot of the owner is folded into its main's composed pair
  (one per main whose frames the delete stripped), never a slot pair.
- **Named exemption — the `data`-column twin of dd199/dd200.** The CSV importer
  rewrites `data.created_date` / `created_by_user_id` beside the audit components
  (`record_metadata.ts`), outside the save path, with no pair. After restoring dd199
  or dd200 the revert RE-DERIVES the twin from the restored value with the importer's
  own derivation (`metadataPatchFromAuditValue`), so the two stores agree again, and
  reports the key `inexact: metadata_twin` whenever it rewrote the twin or could not
  derive one — the twin's pre-run bytes are not replayed.
- **Named exemption — the record's modified stamps (dd197 / dd201).** Every save
  restamps them in the same UPDATE as its value (`save_component.ts` `auditStamp` →
  `persistRecordKeys` / `persistModifiedStamp`) — every bulk door's save included,
  the revert's own writes included, a no-op re-save too. They are record METADATA
  ("who touched this record last, when"), not a value a run changed, so the
  chokepoint's restamp writes NO pair: after a revert they show the REVERT as the
  record's latest modification, never the pre-run stamps. The one case they come
  back is a run that wrote them ITSELF as columns (a CSV carrying dd197/dd201):
  those are ordinary component saves with their own pairs, their units restore
  them, and the revert then leaves them unstamped (§4 step 3). Same family as the
  dd199/dd200 twin above: bookkeeping about the record, outside the undo scope.
- **Named exemption (D4):** update_cache's media repair (`files_info` refresh via
  `updateMatrixKeyData`, files moved to `deleted/<bulk id>/`) stays outside the log:
  `files_info` is derived from the filesystem, and a revert cannot move files back.
  Observer mirror writes and `deletePortalLocator` side writes stay outside too;
  after a revert the observers recompute them (`propagateRestoreToObservers`).
- Doors under the law: the CSV import (every column, envelope frames included),
  `import_execute` (MARC21, Zotero), `tool_propagate_component_data` (now one
  transaction per record through the engine's save door, fail-closed dd800 mint,
  one language per row, observers fired), `tool_update_cache` re-saves, and
  `bulk_revert_process` itself (so a revert of a revert is exact).

### 3. The visibility law

Roles 1, 3 and 4 never reach the dd15 list, its count, a component's history, the
dd1371 equality/range filters, a preview, `apply_value`, or the backfill probes of
delete (record and data) / observers: every such read narrows with `withTmHistory` /
`tmVisiblePredicate` (`src/core/db/record_generation.ts`). A hidden row id addressed
directly by `apply_value` answers `tool.target_not_found`; the dd15 preview
(`data_source: 'tm'`) answers an EMPTY value for it, as it does for an absent id. `bulk_revert_process` reads every role.
The dd15 deep-page LATE ROW LOOKUP (`read_tm.ts tmLatePageSql`) walks its page of
ids with the `tm_role IS NULL` narrowing too; it stays index-only on the partial
`matrix_time_machine_history_visible_idx` (`(section_tipo, section_id DESC, id DESC)
WHERE tm_role IS NULL`, migration `0012_tm_history_visible_index.sql`), whose predicate
it implies — measured 8.9-10.0 s (seq scan + external sort) without it vs 4.1 s, OFFSET
5M on 29.06M rows (0011 did NOT close this: it covered the count only). With 0011's
hidden partial it partitions the table by visibility; the full record-history index
stays for the readers of every role. Migrations run with `statement_timeout = 0`
(`migrate.ts applyMigration`): a full-heap build must not die on the pool's request
ceiling (57014 is not retried, and would block every later file).
The dd15 COUNT is TOTAL − HIDDEN in one statement (`read_tm.ts tmHistoryCountSql`),
not a `tm_role IS NULL` count: `tm_role` is in no full index, and that count read the
heap (15.0 s vs 3.1 s index-only, 29.45M rows). The hidden half is served by the
partial `matrix_time_machine_tm_role_hidden_idx` (`WHERE tm_role IS NOT NULL`), and
the column gets statistics (without them the planner estimated `tm_role IS NULL` at
61,356 rows where 29.27M matched) — both by migration `0011_tm_role_hidden_index.sql`,
in its own transaction (never under 0010's ACCESS EXCLUSIVE lock); the self-heal
analyzes the column after it adds it.

### 4. The revert

1. **A live run is refused** (D5): an in-process registry holds every run while it
   writes (`src/core/tools/bulk_run_registry.ts`; jobs are in-process and die with
   it), and a second concurrent revert of the same run is refused too.
2. Rows of the run are grouped into UNITS: a dataframe main with slots (its rows
   are composed, §8) is ONE unit per record, all its languages together; any other
   lang-sliced key is one unit per `(section_tipo, section_id, tipo, lang)`; any other
   key one unit per `(…, tipo)`. Each unit is reverted once.
3. A unit with BEFORE rows takes the EXACT path, all-or-nothing, in one transaction;
   a lang-sliced key without slots is one unit per language region, so an edit after
   the run to one language never blocks another's revert. **Order: undo in reverse**
   — units newest first (by their newest row id), cascade markers newest first: a
   lang-less orphan belongs to every language's region, so a run that wrote spa then
   eng recorded eng's BEFORE over spa's AFTER, and only eng-then-spa undoes it.
   Inside a unit, per key: lock — no row is `changed_since_run` (the revert never
   recreates a record), EXCEPT a record the run itself CREATED whose row is GONE when
   the revert starts (`goneBornAddresses`): gone is its pre-run state whatever removed
   it — a first revert's D2 delete, the run's OWN cascade (a record it created and then
   cascade-deleted), a curator — so its keys are `unchanged`, its role-4 cascade
   markers are dropped (never undeleted only for D2 to delete it again: no file move,
   no unpublish, no RECOVER or TM rows), its record-scope search is skipped (the search
   sees only existing rows, so a non-admin read every such unit `out_of_scope`), its D2
   step is a silent no-op, and a repeat revert stays `full`. A row that REAPPEARS
   during the revert is someone's new record: `changed_since_run`; then `unchanged` is decided FIRST (live region == the
   earliest BEFORE: nothing written, whatever else happened — a second revert, a
   value put back by hand); then the chain check (`before[i+1] == after[i]`, else `interleaved_write`);
   conflict check (live region == the run's last after-image, else
   `changed_since_run`); otherwise the earliest BEFORE is restored into the live key
   (`restoreRegion`: other languages kept in place, the region back where the live
   region stands — a lang-less orphan shared by two regions never reorders the
   other's — and an absent BEFORE removes the key). **A composed unit** (a
   dataframe main M, §8) splits every row into its main part and its frames
   (`splitComposed` — an exact partition for every model: the main part is every
   entry that is not a frame; the per-model strip it replaced kept only
   `component_iri` entries with an `iri` key and dropped a title-only item from the
   revert, review 2026-09-27 — since 2026-09-28 it is the ONE split of every reader) and reads the frames MAIN-SCOPED: only frames whose
   `main_component_tipo` is M, plus unstamped legacy frames, so a slot shared by
   two mains never couples them. The main part is checked per language as above;
   the frames chain runs over ALL the unit's rows in id order, language-blind (a
   run that wrote spa F0→F1 then eng F1→F2 is one chain, never a false
   `changed_since_run` for spa). Only rows that CHANGE the main part form a
   language chain: a slot save's row keeps the main region on both sides (tagged
   with a language the main holds, see §8), so it rides the frames chain only and
   is never counted as an `unchanged` language. When the
  frames change, every tag whose rows changed ONLY frames is checked too: the live
  region under that tag must equal the newest such row's AFTER main, else
  `changed_since_run` (a frame is never put back over a main item a curator
  replaced or removed after the run — `assertFramesOnlyMains`).
   `unchanged` = every language region at its earliest BEFORE and the frames at
   the first row's BEFORE frames (a frames-only unit counts as one key); conflict = any language
   region or the frames off the unit's last after-image, and the WHOLE unit is
   `changed_since_run`. The write is one `persistRecordKeys` call: the main key and
   every slot key, each slot getting the other mains' live frames plus M's recorded
   ones (a slot left empty is removed), then the item ids of the main and each slot
   are absorbed and the main's relation search reindexed. A frame can therefore
   never be stranded on a main item that no longer exists: the main and all its
   frames come back together. A role-1 row under a `component_dataframe` tipo
   (possible only from development runs of the superseded per-slot design) is
   refused as `failed`. The revert does not stamp a record's
   modified metadata (dd197/dd201) when the run wrote either stamp itself (a CSV
   import carrying them): those keys are restored by their own units. The revert's
   own pair records the persisted bytes (re-read) — for a composed unit, composed
   pairs as sequential steps (the first carries the frame change, later ones equal
   frames), so the revert of the revert chains. Any refusal rolls the whole unit back.
   The scope gate of a composed unit requires write access on the main AND on every
   slot the unit writes.
4. **Created records (D2)** are deleted through the delete door only when every unit
   reverted cleanly, EVERY key — the run's own included, which a clean revert put
   back at their pre-run (= birth) value — still holds its BIRTH value (the marker's
   image — the defaults every record of a filtered section is born with are not
   someone else's write; a later translation of a run-written sliced key is),
   nothing references it, and the caller may
   delete; otherwise skipped as `created_record_kept`. Both checks run INSIDE the
   delete's transaction, behind its row lock (`deleteSectionRecord`'s
   `precondition`): a save or a link committing while D2 runs is never deleted with
   the record. A delete that THROWS for one record is that record's `failed` entry
   (located); every other born record is still decided and reported. The delete runs UNDER THE
   REVERT'S BULK ID: the door writes the role-4 twin in its own transaction from its
   locked snapshot, and every nested cascade carries the id — the revert of the
   revert undeletes all of it. **The undo log belongs to the record's generation**: a
   bulk create at an EXPLICIT id whose address already carries history (a record born
   where a dead one lived — a CSV re-imported with its `section_id` column after the
   record was deleted) opens the address's epoch in its insert's transaction, before
   its birth marker (`create_record.ts` `recordBirthMarker` → `openEpochIfReborn`).
   The dead record's rows — an earlier run's birth marker and pairs, byte-identical
   when the same CSV is imported again — then fall below the epoch, and reverting that
   earlier run never restores its BEFORE over the new record nor deletes it. The run
   loader reads the living generation only, EXCEPT role 4: a cascade snapshot is a
   deleted record's by definition, and a unit re-linking its address must still meet
   it (the birth-identity test below then refuses a record born there since).
5. **Cascade-deleted targets (D3)** are undeleted and reported in `inexact[]`
   (`cascade_undelete`: media and diffusion side effects are not replayed as they
   were). Both undelete shapes move the files the delete put in `deleted/` back to
   their live paths after COMMIT through the one file door (`restoreSectionMedia`): a
   missing row for its whole media column, a SOFT wipe for the media keys it writes
   back (a live file already there wins; the newest deleted version is taken). The
   undelete is COUPLED to the unit that re-links the target (the unit whose BEFORE
   image references it — the main whose composed image carries the frame that
   addressed it, a portal whose locator the
   delete stripped): it runs INSIDE that unit's transaction, first, so a refused unit
   leaves the target deleted (reported `cascade_delete_not_reverted`, unlocated) and a
   target that cannot come back refuses the unit (`cascade_delete_not_reverted`,
   located at the unit — never a frame restored onto a missing or foreign record).
   A target that refused one unit is NOT done for the others: every other unit that
   re-links it tries its undelete again and is refused the same way (only a target
   that really came back is skipped by a later unit; the report is de-duplicated
   separately).
   A unit whose OWN record is the deleted one (a revert's D2 delete, reverted in turn)
   takes that marker too. A NESTED cascade target (T2, deleted by T's own frame policy
   under the same id, referenced only by T's role-4 snapshot) travels WITH T: undeleted
   right after it, in the same transaction, and a T2 that cannot come back refuses T
   (never T's restored frames onto a missing or foreign record); T2 never comes back
   without T (never an orphan). A target no unit takes is undeleted with its nested
   children as ONE group — all of it, or none. The record-scope search cannot see a row that is not there:
   a REFERENCING unit's scope gate stands for the target's; otherwise (the unit's own
   record, a target no unit takes) the scope is judged on the RESTORED row inside the
   undelete's transaction, and an out-of-scope record is rolled back (`out_of_scope`).
   Section-level write on the target is always required. A missing row's undelete is
   ONE transaction — an insert-only row restore (an address taken since is never
   overwritten: `cascade_delete_not_reverted`) and its birth marker under the revert's
   id, never one without the other. The row is the snapshot VERBATIM — no dd197/dd201
   stamp: the snapshot carries its own, and a run owning them (a CSV import carrying
   dd201) would otherwise refuse every stamp unit of the undeleted record. A soft-cascade
   restore follows the stamp rule of step 3. The files come back after the commit. A SOFT
   cascade (`delete_target`) kept the row and wiped its data: the wiped keys are
   written back into it, with their own pairs — per language, CHAINED as sequential
   saves would record them (each language's pair cut from the state the previous one
   left), so the revert of this revert undoes them in reverse; a wiped slot is written
   back inside its main's composed step, never as a pair of its own — while every
   differing key is still in its wiped state (empty, or the default-project filter). A row that
   is THERE is judged by its GENERATION first (`dedalo_ts_record_generation`: an
   epoch above the delete snapshot's TM id means a record was born at the address
   since — every create door that really inserts at an explicit id where history
   lives opens one, bulk run or not; the revert's own undelete opens none. Never
   `data.created_date` + `created_by_user_id`: both are rewritable — a CSV
   dd199/dd200 column, the revert's metadata twin — and second-grained, so they
   forged "same" and faked "foreign", review 2026-09-27): another record (the address taken again) is
   `cascade_delete_not_reverted` and refuses the re-linking unit; the SAME record with
   a key written after the wipe (or after an earlier revert undeleted it) is
   `cascade_delete_not_reverted` located at the RECORD, nothing written, and the
   re-linking unit still runs (the record is neither missing nor foreign); the same
   record already holding its snapshot (a repeat revert, a revert of the revert's
   revert) is a no-op — neither `inexact` nor a RECOVER SECTION row, so the repeat
   stays `unchanged` / `full`. A main-item removal's cascade
   (`removeDataframeDataById`) carries the run's id too.
6. **Runs made before the change** (no BEFORE rows) take the LEGACY path — the old
   inference with four fixes: the history walk is filtered by language for a
   lang-sliced model (closes WC-2026-08-27-tm-lang-slice-restore-merge's Residual);
   the pre-run row is the one older than the run's EARLIEST row; the conflict check
   compares regions; a one-row history blanks only a record born in the run, else
   skips `no_pre_batch_state`. A legacy run is a PHP-era run (addendum 2026-09-28):
   its main rows are composed, so a frameless row means "no frames" and the path
   empties the main's frames (a born-in-run blank too); the conflict check compares
   the main's live frames with the run's last row. A run row under a slot tipo is
   `failed`. Every legacy write is listed in `inexact[]`.

### 5. The payload (amends WC-2026-09-03-bulk-revert-skipped-typed-entries)

```
data: {
  counter,            // UNITS written (a unit with at least one key written)
  unchanged,          // KEYS already at their pre-run value (nothing written) — a
                      // unit with some keys written and some unchanged adds to both
  bulk_process_id,    // the revert's OWN new bulk id — its undo handle
  exact,              // 'full' | 'partial' | 'none'
  skipped: [{reason, section_tipo?, tipo?, section_id?, lang?}],
  inexact: [{basis: 'legacy_inference' | 'legacy_born_in_run' | 'cascade_undelete'
                    | 'metadata_twin', …coords}]
}
```

- New `reason` codes: `changed_since_run`, `interleaved_write`,
  `created_record_kept`, `cascade_delete_not_reverted` (an undelete the door refused).
  The WC-2026-09-03 codes stay. The disclosure law is unchanged: coordinates only
  after the scope gate; an out-of-scope key skips its whole unit with no coordinates.
- **Client summary:** after an ok revert, `render_tool_time_machine.js` shows
  `bulk_revert_summary_message(data)` BEFORE `window.close()`: the counts and the new
  bulk id, a not-exact line when `exact !== 'full'`, and per-code counts of
  `skipped[]` and `inexact[]`. Four new tool labels, every shipped language:
  `bulk_revert_summary` (`{0}` reverted, `{1}` unchanged, `{2}` new bulk id),
  `bulk_revert_not_exact`, `bulk_revert_skipped_heading` (`{0}` count),
  `bulk_revert_inexact_heading` (`{0}` count).

### 6. The CSV tool (D1)

The *Save time machine history on import* checkbox and the append-with-TM-off
warning are removed from the client, with the `append_no_tm_warning` label
(amends WC-2026-09-27-csv-import-append-mode §7). `import_files` no longer reads
`time_machine_save`; a legacy caller still sending it is not refused — the flag could
only ask for less history, and none is withheld.

### 7. `apply_value` over a bulk after-row (amends WC-2026-08-27-tm-lang-slice-restore-merge)

A bulk run's visible after-row is the key's REGION (lang-less orphans included), not
a strict one-language slice. `mergeRestoredLangSlice` keeps live lang-less items only
when the restored snapshot carries none; a snapshot that carries lang-less items owns
them, and the live ones are dropped instead of duplicated.

### 8. COMPOSED ROWS — a dataframe main and its frames are one history row

A frame pairs with one ITEM of its main (`id_key → id`, `main_component_tipo`), so
neither half means anything without the other; but the frames are stored apart, in
`relation[<slot tipo>]`. Until this amendment the TS engine recorded them apart too
(a main row without frames, and for a bulk run a pair per slot key), which is what
left WC-2026-08-09's capture half open and forced its frameless-wipe refusal.

- **Row shape (PHP convergence).** Every history row of a main M that has at least
  one dataframe slot — a visible row and both rows of an undo pair — is COMPOSED:
  `data` = M's region, followed by the FULL content of every slot of M, in slot order
  (declared slots, then the caller's, then slots found through M's frames, sorted).
  A shared slot is stored whole, every main's frames, as PHP stored it
  (`component_common::get_time_machine_data_to_save` :1580). Visible row: the main
  region is M's language slice for a lang-sliced model (orphans dropped), the whole
  array otherwise. Undo pair: `regionOf` (orphans kept — the absence law of §2). No
  frame: `data` is the main region unchanged, so an absent main stays absent.
- **The slot set of M** is a union (WC-2026-08-09 divergence 1): ontology children of
  model `component_dataframe`, the `component_dataframe` ddos of M's own
  request_config (show and hide), the model's FIXED frames (descriptor
  `fixedDataframeTipos` — `component_iri` → `dd560`, so a label-less iri writes a
  composed row too; review 2026-09-27), every key of the record holding a frame whose
  `main_component_tipo` is M, and the slot a save wrote
  (`resolveDataframeSlotTipos`, `readMainSlots` in `src/core/relations/dataframe_slots.ts`).
- **No discriminator column** (addendum 2026-09-28). Every supported row of a main is
  composed, so no column marks one; a composed row whose slots were empty is the main
  region alone, and MEANS "no frames at that time".
- **A slot save writes no row under the slot tipo.** It writes the composed row (or,
  in a bulk run, the composed pair) of the main(s) the change belongs to, in this
  order (`attributeSlotMains`): the caller's pairing main (`caller_dataframe`), else
  every main whose frames the save added or removed, else the slot's ontology parent
  when that parent is a component declaring it. A changed slot no main can own is
  refused `engine.uncovered_scope` on the slot SAVE (interactive or import); the strip,
  wipe and delete doors remove such an orphan frame and write no history for it
  (addendum "review 3"); a slot save that adds or removes no entry writes
  nothing. ONE language rule for both lanes (`recordAttributedChange`,
  `slotRowIdentities`): a lang-sliced main's change is written once per language the
  main holds, each that language's region + the full slots — a slot save speaks no
  language of the main (`lg-nolan`), and a row under that tag sliced the main to
  nothing, a false "main emptied" entry whose apply restored no frame. Outside a run
  every such row is visible; under a run the undo PAIR goes under the FIRST held
  language (its after-row is that language's visible row) and every other held
  language gets its visible row (review 2026-09-27). A main holding no language item
  keeps the door's tag. The revert's own frames-only history, a legacy slot key's
  revert, a wiped record's slot-only restore and an inverse-reference strip under a
  run follow the same rule. A CSV slot column, a legacy `{data, dataframe}` envelope, an append-mode
  frame, a main-item removal's cascade (`removeDataframeDataById`), a portal locator
  removal (`deletePortalLocator`), a referenced record's delete stripping frames and
  a data wipe (`deleteSectionData`) all land under the main this way.
- **Other writers of a main's history row compose too.** tool_lang / tool_lang_multi
  (`translateAndWrite`): the TARGET language's region + the slots (it wrote the whole
  merged value under the target tag, frameless). A duplicate (`duplicateSectionRecord`
  step 5): both rows of every copied main composed over the copy's re-minted frames,
  and NO row under a copied `component_dataframe` key.
- **dd15 list.** The `dd1574` value cell renders a composed row's raw `data`, frame
  entries included, as PHP's list did. A component's history in dd15 therefore
  carries its frames; a dataframe slot has no history list of its own.
- **Restore (`apply_value`).** A composed row restores both halves: the main part
  split off its frames (`splitComposed().main`), and BEFORE the main write
  M's OWN frames in every slot replaced by the row's frames of M — a composed row with
  no frame of M empties them, PHP's contract. SCOPED TO M (the preview's and the bulk
  revert's rule, D-A): the frames of ANOTHER main in a shared slot stay exactly as they
  are live (the row stores them, PHP's shape, but they are that main's history), and a
  slot key is removed only when nothing is left (`restoreSlot`). For a lang-sliced M
  the live frames of a surviving sibling-language item are kept as they are live
  (`FrameSlice`) and every other frame of M the row recorded is written — a frame
  saved before its item included (addendum 2026-09-28: the save order is the
  curator's) — never a live item of another language stripped of its frame. The legacy bulk path
  restores through the same rule, and a key whose frames and value are already back
  is `unchanged` (`framePlanIsNoop`), never `changed_since_run`. The restore's own audit row is composed.
  No row is refused for carrying no frame (addendum 2026-09-28).
- **Every row is the full state** (addendum 2026-09-28 — full-state contract): a slot a
  row is silent about was EMPTY then, for a v6 row and an engine row alike
  (`rowSlotTipos`).
- **Out of scope, named:** the whole-record delete snapshot and its role-4 twin keep
  the record's columns verbatim (frames included by construction), and the
  component_info recompute row (`observers.ts`, the computed widget shape, lg-nolan) is
  not composed: it records no main that can hang a dataframe. The set_dato_external
  observer's backfill and save rows ARE composed (addendum 2026-09-28 review).

## Reason

A revert that infers the past from a history it did not write is wrong exactly where
it matters: the history is missing (data stored before Time Machine, written with it
off), stale (a later write with it off) or interleaved (another user, another
language). Each failure blanked or rolled back curated heritage data with `ok:true`.
Recording what each bulk save replaced — the only fact a revert needs — makes the
revert exact by construction, and whatever it still cannot do is refused or reported
by code, never done silently. The opt-out went because an unrecorded bulk write is
precisely the write its revert cannot undo.

## Gate reconciliation

- **No re-harvest; one fixture exemption.** No frozen fixture covers
  `bulk_revert_process` or `import_files`. `test/parity/tool_element_context_differential.test.ts`
  exempts, by EXACT name set, the four labels of §5 plus `apply_value_confirm_msg`
  (WC-2026-08-29-tm-apply-value-confirm-label, which had been red since 2026-09-27's
  back-out): the tool_time_machine case leaves `engineering/parity_baseline.json`'s red
  set at the next baseline bank. A suite DB registered before this change is red there
  until `bun run test:db:setup` registers the tools again.
- TS-native gates: `test/unit/tm_undo_log_writers_native.test.ts` (the writers),
  `tm_role_self_heal_native` (the column heals or fails closed),
  `bulk_undo_capture_native` (one case per door), `bulk_revert_undo_native` (the
  scenario catalogue, legacy path included), `tm_history_visibility_native` (roles
  never reach a visible read) and `tm_history_visibility_tripwire` (census of every
  reader of the table, shrink-only), plus `ops_migrations` and
  `migration_shared_row_tripwire` for 0010, and `tm_count_index_only_plan_native`
  (0011's statistics and partial index; the count exact and never filtering
  `tm_role` on fetched rows; 0012's visible partial serving the late row lookup's id
  walk, its page exact).
- Composed rows (§8): `bulk_undo_capture_native` (a slot save is a composed pair
  under the main and no slot row, a main-item removal and envelope frames composed),
  `bulk_revert_undo_native` (the main+frames unit, main-scoped frames of a shared
  slot, a two-language frames chain, the slot scope gate), `tm_dataframe_restore_native`
  (a composed row with no frame empties the slot; a PHP-shaped frameless row too),
  `dataframe_cascade_removal` (the main row is composed),
  `bulk_operation_atomicity_native` (a restore serialized after a curator's frame
  save; a legacy run's conflict check sees the frame),
  `tm_composed_rows_native` (normal and slot-save rows composed, undo pairs under the
  main, two mains sharing one slot as two units, frames-only and two-language+frames
  `unchanged` counts, unusable rows `failed`, CSV replace+append with dataframe
  columns; apply_value over a shared slot keeping the other main's live frames, an
  eng restore keeping a later spa item's frame live and writing every other frame the
  row recorded, a frames-only run refused after the main changed, a legacy run over a slotted
  main reverted twice, a lang-less slot save writing one row per language, a tool_lang
  translation composed and restorable — each mutation-checked),
  `duplicate_record_dataframe_native` (the copy's history composed, no slot row), and
  `tm_save_order_native` (addendum 2026-09-28).
- Client: `client/dedalo/test/client/js/test_tool_time_machine.js`
  (`bulk_revert_summary_message`) and `test_tool_import_dedalo_csv.js` (the switch and
  warning stay removed).

## Addendum 2026-09-27 — the READERS split a composed row; 0011/0012 are ONLINE

**Shape before (TS, §8 as first landed):** the dd15 list injected a composed row whole
under the main's tipo (a relation main's cell held the frame locators among its items,
a literal main's cell held frame objects as values) and no slot cell carried the row's
frames. The TM preview (`data_source: 'tm'`) of a main stripped the frames and left its
slots LIVE; the preview of a `component_dataframe` by the main row's id stripped every
entry and answered EMPTY. (PHP: `component_common::get_data` 'tm' branch — the main
keeps its own items; a `component_dataframe` reads the MAIN's row and keeps its slot's
frames, pairing-filtered.)

**Shape now (TS):**

- **dd15 list** (`tm_record.ts buildTmSectionRecord` → `injectComponentSnapshot`):
  `dd1574` keeps the RAW row (unchanged, PHP); the main's tipo carries its items only
  (`splitComposed().main` — every non-frame entry, for every model: the old
  per-model strip dropped a v6 title-only `component_iri` item from the list, the
  preview and the restore, review 2026-09-28); each slot's tipo carries the frames the row
  recorded for that main (`snapshotSlotFrames`). A row under a slot's own tipo is not
  supported history (addendum 2026-09-28): only its raw `dd1574` copy shows.
- **Preview** (`section/read.ts resolveTmPreview`): the main previews its items; its
  slots preview the row's frames of that main, the frames of OTHER mains in a shared
  slot kept live (§8, main-scoped); a `component_dataframe` requested with the main row's
  id serves its slot's recorded frames (then the usual `caller_dataframe` pairing). A
  row with an empty slot previews it EMPTY (addendum 2026-09-28: every row of a main
  is composed); a row under a slot's own tipo previews empty, like an absent row.
- **Attribution** (`snapshotSlotFrames`, one definition for both readers): a frame
  naming `from_component_tipo` belongs to that slot when it IS a `component_dataframe`
  (else inert); a frame of another `main_component_tipo` is not this main's; an
  unstamped legacy frame goes to the only slot in play, and with several is not shown.

**Migrations 0011/0012 are ONLINE** (`install/db/online_migration.ts`): built
`CONCURRENTLY` after the listener binds, never in a transaction — §3's "in its own
transaction" is superseded. `bun run test:db:setup` runs the online pass too, so the
suite database holds the indexes a booted install builds.

**Measured 2026-09-27 on `dedalo_mib_v7` (29.27M rows, read-only EXPLAIN ANALYZE, 0012
present):** bare late walk OFFSET 5M 3,383 ms vs 3,444 ms for the same walk without the
`tm_role` narrowing (the pre-0010 shape) — parity; section-scoped (`numisdata4`, OFFSET
200k) and record-list (`tipo = rsc170`, OFFSET 5k) walks and the range-filter barrier
(545,894 matches) show no regression; the bare visible count is index-only either way
(1,975 ms TOTAL − HIDDEN, 1,814 ms `tm_role IS NULL` on the visible partial, 1,763 ms
unnarrowed).

**Gate reconciliation:** no fixture holds a composed row; no re-harvest.
`test/unit/tm_composed_read_split_native.test.ts` (preview main/slot, a frameless row
empty, the dd15 record, the attribution rules; mutation-checked);
`tm_count_index_only_plan_native` applies 0011/0012 as the online runner does and plans
the late walk in the deep regime (an offset no LIMIT cuts short — a shallow page on a
small table legitimately walks the PK).

## Addendum 2026-09-28 — TS-era history unsupported; every row of a main is composed; any save order, any main model

**User decision.** v7 TS is BETA with no production install: history the TS engine
wrote before §8 is not supported. The only historical rows to support are PHP-era
(Dédalo v6), where a main's row ALWAYS carries the main + all its frames. So a row
without frames means "no frames at that time".

**Shape before (TS, §8 as landed 2026-09-27):** a column `matrix_time_machine.tm_composed`
(migration `0013_tm_composed.sql`, healed by `ensureTmRoleColumn`) told a composed row
from a TS-era frameless one; `apply_value` and the legacy bulk path REFUSED a
frameless unflagged row over live frames (`refuseFramelessWipe`, skip reason
`frameless_wipe`); the preview left the slots live for such a row; a TS-era row under a
slot tipo previewed, listed and reverted as a unit of its own. A lang-sliced restore
wrote a row frame only when it paired a restored item.

**Shape now (TS):**

- **No marker.** Migration 0013 is deleted (uncommitted, never shipped), with its
  self-heal half and its gate lines; the writers write no flag. The bulk plan decides
  a composed unit from the ontology and the rows: an EXACT main key whose main declares
  a slot, or whose rows carry a frame.
- **A frameless row restores as "no frames".** `apply_value`: main restored, the
  main's own frames emptied, another main's frames of a shared slot untouched (D-A).
  Legacy bulk path: the same, and its conflict check compares the main's live frames
  with the run's last row (no frame recorded = none expected). A born-in-run blank
  empties the main's frames too. `refuseFramelessWipe` and the `frameless_wipe` skip
  reason are removed (amends WC-2026-09-03 and WC-2026-08-09 divergence 5).
- **Slot rows are unsupported history.** A run row under a slot tipo is `failed`; the
  preview of a slot's own row answers empty; the dd15 list shows only its raw copy.
  `apply_value` on one stays refused (`engine.uncovered_scope`).
- **Save order is the curator's.** Every save — main or frame, in any order, a frame
  saved before its item or while the main key is still absent — writes the main's
  composed row(s) holding the full state after that save, so every row is a
  restorable state. A lang-sliced restore keeps the live frames of the surviving
  sibling-language items and writes EVERY other frame of the main the row recorded
  (it no longer drops a frame that pairs no restored item — that dropped a frame saved
  before its item). With no sibling-language item (component_iri's lg-nolan items)
  the frames are the row's exactly.
- **Any main model, one behaviour.** Relation mains (activated by the ddo in the
  request_config) and literal mains (`has_dataframe: true`; component_iri's fixed
  dd560), translatable or not: the same composition, restore, bulk revert and D-A
  scope. A literal main's frames stay in `relation`, never in its own column.

**Kept as built:** D-A (the full slot stored; revert/restore scoped to
`main_component_tipo === M` plus unstamped frames), D-C (slot attribution:
caller main, else the changed frames' mains, else the declaring parent), migrations
0010-0012.

**Gate reconciliation:** no fixture holds a composed row; no re-harvest.
`test/unit/tm_save_order_native.test.ts` runs, over four main kinds (portal; number
with has_dataframe; translatable input_text in two languages; component_iri + dd560):
a PHP-shaped frameless row restored over live frames (main back, own frames emptied,
the foreign main's frame untouched, the other language kept); a PHP-shaped composed
row (main + frames back); save orders (a) main first, (b) frame first with the main
absent, (c) interleaved, (d) a frame before its item with other items present —
after every step each row written equals the live state, then apply_value of every
row newest first returns exactly its state; and one bulk run mixing the orders on
four records reverted exactly, its revert exact too. Mutation-checked (the
frame-before-item scope rule; the frame half of apply_value). Updated:
`tm_dataframe_restore_native`, `bulk_operation_atomicity_native`,
`tm_composed_rows_native`, `tm_composed_read_split_native`, `bulk_revert_undo_native`
(the TS-era slot-column legacy case deleted), `tm_role_self_heal_native`.


## Addendum 2026-09-28 (review) — v6 rows compose what v6 composed; one pairing law; every main door

**Shape before (TS, the 2026-09-28 addendum as landed):** a frameless row's silence emptied
EVERY slot of the union (ontology children ∪ show AND hide ddos ∪ fixed frames) for every
row. `removeDataframeDataById` found slots through the built request_config SHOW map only,
so removing an item of a literal main (`has_dataframe`) or of a component_iri (fixed dd560)
left its frames. The set_dato_external observer wrote frameless rows and dropped locators
without the frame cascade. A legacy key tagged `lg-nolan` under a translatable main sliced
to nothing and reported `unchanged`. The composed bulk revert refused any recorded frame
pairing no item of the restored main (a frame-first pre-run state could not be reverted);
`apply_value` of one language's row wrote back the frame of another language's item
deleted since.

**Shape now (TS):**

- **v6 rows (below the COMPOSITION EPOCH)** — SUPERSEDED the same day, see the addendum
  2026-09-28 — full-state contract; the epoch, `provenSlotsOfRow`, `legacySlotFallback` and
  `stripDroppedItemFrames` are removed. As landed: PHP composed a main save over the request_config
  SHOW map (`get_dataframe_ddo`, component_common.php :1580/:3143) and a slot save as the
  main + THAT slot (component_dataframe.php :568). Migration `0013_tm_composition_epoch.sql`
  stores one integer in `dedalo_ts_tm_composition`: the first TM id of the engine's full
  composition. Where the migration never ran (a failed boot run) it is still opened BEFORE the
  engine's first composed row: by `runBootSchema` whatever the run did, and by
  `ensureCompositionEpoch` ahead of every composed write (the backstop) — a lazy mint on the
  first restore would fall above every composed row written since boot and misread them all as
  v6. A legacy bulk key whose run changed a slot the pre-run row does not prove takes that
  slot from the newest earlier row that proves it (`legacySlotFallback`), else it is refused
  `no_pre_batch_state` — never reported unchanged. A row below it empties only
  the slots it provably composed (`provenSlotsOfRow`): the slots its frames name, plus the
  shown slots (children ∪ own SHOW ddos ∪ fixed) when there is ONE of them or the row names
  TWO or more. Every other slot stays live — in `apply_value`, the preview graft and the
  legacy bulk path (plan AND conflict check). A row at or above the epoch empties the whole
  union, as before. This is not the removed `tm_composed` flag: no writer marks anything,
  and it separates v6 rows from the engine's, not TS-era rows from composed ones.
  (!) Named assumption: v6 literal mains composed their child slot (their JSON controller
  builds the request_config with the dataframe ddo); a child-only slot therefore counts as
  shown.
- **A v6 slot save under a translatable main** (tagged `lg-nolan`) is a FRAMES-ONLY image
  (`isFramesOnlyImage`, relations/dataframe_slots.ts — ONE predicate for `apply_value`, the TM
  preview and the legacy bulk path). It holds the main in ONE language — the curator's
  `DEDALO_DATA_LANG` at save time (v6 `component_dataframe::get_main_component_data` reads a
  translatable literal main with `get_dato()`) — whose items the v6→v7 reformat tagged
  `lg-nolan` (`migrate_component_data` stamps the row's lang); a relation main holds its full
  value and is not lang-sliced, so it is restored whole like any unsliced main. (Corrected
  2026-09-28: this entry said "the main in every language".) A row whose items speak
  languages, none its tag, is one too. Restoring it NEVER merges `lg-nolan` items into the
  translatable value: the main is left live and only the frames come back (stale-item frames
  excepted — `framesOnlySlice`); the preview shows the main live. Legacy path: pre-run row =
  the main's newest earlier row in any language, frames restored whole, main left live (its
  languages are the run's language keys, which check it). `apply_value` records such a
  restore as a slot-attributed change (`recordAttributedChange`): one composed row per
  language the main holds (that language's region + the slots after), never one `lg-nolan`
  row — sliced by that tag its region was empty, the change sat in no timeline, and restoring
  that row put no frame back (review 2026-09-28).
- **A v6 LITERAL main's frames WRAPPED by the reformat.** Before its 2026-09-28 fix, v6
  `v6_to_v7::migrate_component_data` value-wrapped every object of a
  `components_using_value_property` model's TM row — each composed frame became
  `{value:{legacy frame}, id, lang}`, and `dataframe_v7_migration::transform_entries` (top-level
  only) never migrated it. The package now passes dataframe locators through unwrapped.
  Already-migrated rows are read tolerantly: `splitComposed` (the one partition of every TM
  reader) unwraps such an entry to its inner frame, migrated as `transform_entries` does for a
  literal main (`id_key` = `section_id_key`, `type` dd490, legacy keys dropped);
  `readOtherLangItemIds` never counts a wrapped frame as an item. No row is rewritten.
- **ONE pairing law** (`isStaleItemFrame`): a recorded frame is never written back when its
  `id_key` named an item of ANOTHER language the visible history knew
  (`readOtherLangItemIds`) that the restored value no longer holds. Every door reads the
  WHOLE history (an item imported with the TM off and first named ABOVE the restored row,
  then deleted, is still known — review 2026-09-28); `apply_value` and the LEGACY bulk path
  (one row restored: the row / the pre-run row) leave out an item the history PROVES absent
  at that row — the newest row at or below it speaking for the item's language (tagged with
  it, or carrying items of it) does not hold it: its frame was saved first and comes back.
  The composed bulk revert refuses such a frame `changed_since_run`; the other two drop it —
  a sliced key with the other languages' items, an all-language image with every item the
  live main no longer holds. A frame whose key named no known item is frame-first and is
  restored by every door.
- **The LEGACY conflict check covers every slot the frame plan writes** (review 2026-09-28;
  reference narrowed to the run's LAST row by the full-state addendum):
  per slot, the live own frames must equal the newest RUN row proving that slot
  (`provenSlotsOfRow`); a slot no run row proves must already hold what the revert writes.
  A v6 multi-slot main whose post-run edit sits in a slot the run's last row does not prove
  (a fallback slot, a born-in-run blank) is refused `changed_since_run`, never overwritten.
- **A slot-attributed row is tagged with the MAIN's lang, never the door's**
  (`slotRowIdentities` over `mainRowLang`): a lang-SLICED main gets ONE ROW PER LANGUAGE IT
  HOLDS (that language's items + the full slots); only a sliced main holding no language
  item (frame-first) falls back to `mainRowLang`. `mainRowLang`: a non-translatable main
  `lg-nolan` (a non-translatable iri: its request lang), a translatable main the request's
  lang — the request's DATA lang (`currentDataLang`) when the door speaks none (`lg-nolan`:
  slot saves, frame strips, CSV frame writes, reverts). So an unsliced translatable relation
  main gets its frame row in the working data lang, a sliced literal in each language it
  holds — the curator's working language lists the change only if the main holds it. The
  soft-cascade undelete tags its restore the same way: an unsliced (or lang-less) wiped key
  under the main's own row lang, the lang its wipe row carries (review 2026-09-28). A legacy
  revert's frames-only key (the all-language `lg-nolan` image) records
  its own history as a slot-attributed change: the pair under a language the main holds.
- **Every main door composes and cascades.** `removeDataframeDataById` finds slots with
  `resolveDataframeSlotTipos` (relation and literal mains, fixed dd560); the observer's
  backfill and save rows are composed (slots read before / after the write), and each
  dropped locator's frames are stripped in the same transaction.

**Gate reconciliation:** no fixture holds a dataframe TM row; no re-harvest.
`tm_save_order_native` adds, per main kind: a main-item removal under a run (frames
stripped, the composed row is the stripped state, the revert exact); a run over a
frame-first pre-run state (exact, nothing skipped); translatable kind: a row restored
after the other language's item was removed (no orphan). Plus: a two-show-slot + hide-only
main restored from v6 slot-save / main-save / frameless rows and an engine row; a legacy
v6 slot-save run on it; a legacy `lg-nolan` run on the translatable literal; the observer
door (composed rows, restore keeps frames, a dropped locator's frame stripped); a
translatable RELATION main's frame rows and a frame-first save on a translatable literal
holding no language, both listed by the tool's lang query and restorable; a legacy sliced
run and a legacy all-language run after a sibling-language item's deletion (no orphan
frame), the latter's own revert row tagged with a held language and restoring. v6 rows are
built below the epoch by `test/helpers/legacy_bulk_run.ts insertPhpEraRow` (negative ids,
the address's generation epoch pinned at the band floor). Plus (review 2026-09-28): a v6 `lg-nolan` slot-save row of the translatable literal in both shapes (one language tagged `lg-nolan`; every language) restored by `apply_value` — main live, frames back, its own rows per language and restoring the frames — and previewed with the main live; the legacy run on the one-language shape; a WRAPPED v6 frame of a number and an input_text main, restored and previewed; a wrapped frame's wrapper id never making a frame-first frame stale. Each fix mutation-checked.
`tm_epoch_tripwire` / `tm_history_visibility_tripwire`: `time_machine.ts` pins 4 reads.


## Addendum 2026-09-28 — full-state contract; the composition epoch removed

**User decision (final).** A time-machine row of a main is ALWAYS the full state of the main
and ALL its dataframes (one or more), whatever was saved (the main, or any single dataframe),
whatever the main's model (relation, literal, translatable or not, iri + dd560) and whatever the
save order. Every row is read the same way — PHP-era or engine-written: a slot absent from the
row was EMPTY at that time. PHP's partial dataframe-save rows (the main + the saved slot only)
are ACCEPTED under this rule: multi-slot mains are rare or absent in real data, so they are out
of scope and never reported. v7 TS rows are beta history and unsupported.

**Shape before (TS, the review addendum as landed, uncommitted, never shipped):** migration
`0013_tm_composition_epoch.sql` stored one integer in `dedalo_ts_tm_composition` (minted at
boot by `runBootSchema`, by the installer as a seed-predated migration, and by
`ensureCompositionEpoch` before every composed write). A row below it emptied only the slots it
"provably" composed (`provenSlotsOfRow`: the slots its frames name, plus the show-map slots
when one or when the row named two or more); every other slot stayed live — in `apply_value`,
the preview and the legacy bulk path. `stripDroppedItemFrames` removed the frames of a dropped
item from the slots a row did not prove; the legacy path walked older rows for a slot the
pre-run row did not prove (`legacySlotFallback`) or refused `no_pre_batch_state`, and its
conflict check compared each slot with the newest run row proving it.

**Shape now (TS):**

- **One reading rule, no provenance.** The slots a row speaks for are the main's declared slots
  plus every dataframe slot the row's frames name (`rowSlotTipos`,
  `src/core/relations/dataframe_slots.ts`); every one of them is written by a restore, emptied
  when the row holds no frame of the main there. Same rule in `apply_value`, the TM preview
  graft, the legacy bulk path (plan AND conflict check) and a born-in-run blank.
- **Legacy bulk path.** The frame plan covers the declared slots plus every slot the pre-run row
  or the run's rows name — a slot the run filled that the pre-run row is silent about is
  emptied, never refused and never `unchanged`. The conflict check compares every planned slot
  with the run's LAST row (silent = empty expected). For a lang-SLICED key the MAIN half comes
  from the language's own pre-run row, the FRAME half from the newest visible row of the main
  in ANY language older than the run's earliest row of the main (any language): a v6 slot
  save tagged `lg-nolan` is never a language's own row, yet it is the newest full state of the
  frames — read from the language row, a pre-run frame edit was silently undone (review
  2026-09-28; gate `tm_save_order_native`, 'a LEGACY language-sliced run keeps a frame edit…').
- **Removed:** migration 0013 (file, installer `SEED_PREDATED_MIGRATION_PATHS` entry,
  `runBootSchema` mint), `tmCompositionEpoch` / `ensureCompositionEpoch` /
  `resetCompositionEpochMemoForTests` and the `compositionEpochReady` module state,
  `provenSlotsOfRow` (+ its show-only candidate set), `legacySlotFallback`,
  `stripDroppedItemFrames` (with every declared slot planned it had nothing left to do), the
  test helper `insertPhpEraRow` (negative-id band + pinned generation epoch — a PHP-shaped row
  is inserted with an ordinary id by `insertLegacyBulkRow`). The suite database drops the table
  on its next `bun run test:db:setup` (the database is rebuilt; no migration creates it).
- **Kept — shape parsing, not provenance:** a v6 literal main's frames wrapped
  `{value:{frame}}` are unwrapped (`splitComposed`); a v6 dataframe save of a translatable main
  tagged `lg-nolan` is a frames-only image (`isFramesOnlyImage`); the pairing law
  (`isStaleItemFrame`); every capture door writing the main's full-state row.

**Gate reconciliation:** no fixture holds a dataframe TM row; no re-harvest.
`test/unit/tm_save_order_native.test.ts` (70 tests): the multi-slot describe now pins the one
rule on a main with two show slots and a hide-only slot — a row naming one slot, two slots or
none empties every other; an engine row reads the same; the preview shows the row's state
(silent slots empty); legacy runs revert every slot to the pre-run full state, empty a slot the
run filled, and refuse a post-run edit in any planned slot (including one the last row is
silent about); the born-in-run case. The "item a restore drops" describe restores full-state
rows. The epoch describe (boot mint, write backstop) is deleted. Mutation-checked: reading only
the named slots reddens 10. `tm_epoch_tripwire` / `tm_history_visibility_tripwire`:
`time_machine.ts` pins 3 reads (was 4); `module_state_tripwire` loses `compositionEpochReady`;
`tool_lossless_writeback_tripwire` loses `stripDroppedItemFrames`.

## Addendum 2026-09-28 (review 2) — one legacy frame half per main; wipe rows in the request lang

- **Legacy bulk path: the frame half is ONE per main** (supersedes the per-key frame half of
  the "full-state contract" addendum's *Legacy bulk path* bullet). Every legacy key of a main
  with slots — one per language tag, a v6 slot save's `lg-nolan` included — is ONE unit
  (`bulk_revert_plan.ts`, unit id `address|legacy`, keys newest first). Each key restores its
  own MAIN region from its language's pre-run row and checks it against its own last run row;
  the unit's LAST key carries the FRAME half: restored once from the newest visible row of the
  main in ANY tag older than the run's earliest row of the main, conflict-checked once against
  the main's LAST run row in any tag. Scope: the whole main for an unsliced main or a unit
  holding a frames-only key (`framesOnlySlice`); else the frames of live items of languages the
  run did not touch stay live and outside the check. Before: per-tag units, one tag's unit
  rewound frames a sibling unit (the `lg-nolan` slot save) then read as a post-run edit —
  refused `changed_since_run` with the run's frame edit left live. The any-language pre-run
  bound is now computed from the unit's own rows; the un-narrowed `min(run.id)` subquery is
  gone (`bulk_revert_legacy.ts` back to 3 reads / 3 narrowings in `tm_epoch_tripwire` and
  `tm_history_visibility_tripwire`).
- **Delete data tags a translatable main's wipe rows with the REQUEST data lang**
  (`currentDataLang()`, DATA-01), not the install's `config.menu.dataLang`: the backfill, the
  wipe row and a bulk revert's soft-cascade undelete of it sit in ONE timeline — the curator's.
  The *soft-cascade undelete* sentence of the "(review)" addendum is now true as written.

**Gate reconciliation:** no fixture holds these rows; no re-harvest. `tm_save_order_native`
('a LEGACY run: the frame half is ONE per main…' — red on the per-tag code: `changed_since_run`);
`delete_data_native` (wipe rows in the request lang) and `bulk_revert_undo_native` ('SOFT,
curator in lg-eng…', wipe + undelete pair share the lang) — both red with
`config.menu.dataLang`. `tm_count_index_only_plan_native`: the deep-page walk is planned on a
scratch table carrying migration 0012's index alone (the pick on the real suite table is a cost
choice; red with the partial's predicate or index removed).

## Addendum 2026-09-28 (review 3) — orphan frames never block a strip door; Delete data takes an empty main's frames; live undeclared slots are read

- **An orphan slot change is refused only on the slot SAVE.** A frame naming a main the
  ontology no longer stores (or no main at all), in a slot with no declaring parent (named only
  by a request_config, or a model's fixed slot such as `dd560`), has no main to be recorded
  under. `attributeSlotMains` step 4 now takes `orphan: 'refuse' | 'skip'`: the interactive and
  import slot save keep `refuse` (`engine.uncovered_scope` — the caller can act on it); the
  record delete's inverse-reference strip, Delete data's wipe and `delete_locator`
  (`recordKeyChangeRows`) pass `skip`: the frame is removed and no history row is written for it
  — an orphan no restore can use. Before: each of those doors threw inside its transaction and
  rolled back (deleting a record such a frame targets, wiping the host, removing the locator).
- **Delete data takes the frames of an EMPTY main too.** `wipeDeclaredSlotsOfMains` visits
  every non-slot component of the walked subtree, not only the keys the wipe emptied: a main
  holding no value (a frame saved before its item, or left by `clear`) loses its own frames in
  every declared slot outside the subtree (`dd560`, a config-only slot). The rewritten slot
  carries the mains that stripped it (`owners`), and each gets its composed wipe row (backfill
  + wipe) — an unstamped frame included, which attribution alone could not place.
- **The one reading rule reads the LIVE record's slots too.** `rowSlotTipos(main, rows, live)`
  = the main's slots as the live record holds them (`readMainSlots`: declared ∪ every key
  holding a frame naming the main — the set the capture composes and the composed revert reads)
  ∪ the slots the rows' frames name. So `apply_value`, the TM preview and the legacy bulk path
  (plan AND conflict check) empty — or, for the legacy path, check — an undeclared live slot
  of the main the row is silent about, as the composed revert already did. `apply_value` now
  plans its frame half inside the transaction, behind the row lock.

**Gate reconciliation:** no fixture holds these rows; no re-harvest.
`dataframe_stale_main_native` (orphan: record delete, Delete data, `delete_locator` — red with
the orphan always refused); `tm_save_order_native` (an EMPTY main's frames per kind + an
unstamped `dd560` frame — red with only emptied keys visited / without `owners`; an UNDECLARED
live slot: `apply_value`, preview, legacy conflict — red without the live slots).
`tm_dataframe_restore_native` 'apply_value ignores a client-supplied ddo_map': the smuggled
slot's live frame is now UNSTAMPED (a live frame NAMING the main makes its slot one of the
main's, and it is emptied by design).

## Addendum 2026-09-28 — two lanes

Supersedes, UNCONDITIONALLY (whatever the number of languages a main holds), §8's "a main's
row carries every slot's frames" and its "no discriminator column" bullet: both now apply only
to FRAME-STATE rows (lg-nolan, or a v6 row carrying frames) — a frame-state row whose slots
were empty means "no frames at that time". Every LANGUAGE-lane row is value-only for every
main — a translatable main holding a single language and a transliterable main's lg-ell rows
included — and carries no frame information: its frames are the newest frame-state row at or
below it. Also supersedes the per-language frame copies of the previous addenda
(`slotRowIdentities` / `recordAttributedChange`, deleted). User decision, final.

- **Storage.** Every row of a main and of its dataframes is stored under the MAIN's tipo,
  never under a slot tipo, in one of two kinds of LANE (`src/core/relations/main_lanes.ts`):
  - a **language lane** (lg-spa, lg-ell…): ONLY that language's value — no frame;
  - the **lg-nolan lane**: the main's lg-nolan VALUE (the items tagged lg-nolan; may be empty)
    + ALL frames of ALL its slots — the shared frame lane.
  One rule for every main: a non-translatable main (relation or literal) keeps its value in
  lg-nolan — one lg-nolan row per save, value + frames (unchanged); a translatable main's
  lg-nolan value is empty, so its lg-nolan row is the frame lane; a TRANSLITERABLE main
  (`with_lang_versions`, e.g. rsc85 in rsc197) keeps its base in lg-nolan and each
  transliteration in its language lane (Augustus lg-nolan, Αύγουστος lg-ell). No flag is read:
  the items' own `lang` places them. An UNSLICED translatable main (a translatable portal) keeps
  its whole value in the request language's lane, its frames in lg-nolan.
- **Writes** (`recordMainHistory`, the one writer): a save of the main in language X writes ONE
  row in lane X (value only) + an lg-nolan row ONLY when the save changed the frames (removing
  an item strips its frames) or the lg-nolan value; a save of the lg-nolan value writes the one
  lg-nolan row; ANY dataframe save writes ONE lg-nolan row (current lg-nolan value + all
  frames), whatever the number of languages. Language rows first, the lg-nolan row last (the
  newest row of a save is its full state). Lang-less PHP orphans ride the visible row of the
  door's lane (the undo region keeps them in every sliced lane, as before). Every door writes
  through it: the component save and slot save, `apply_value`, the bulk revert (composed,
  legacy, soft-cascade restore), the delete strip and wipe, `delete_locator`, the observer
  recompute, tool_lang (`translateAndWrite`: its target lane only), the duplicate (per-lane
  backfill, then the data-lang lane's save row).
- **State at row R** (`src/core/tm_record/lane_state.ts`; exact because saves to one record are
  serialised by its FOR UPDATE lock — ids, never timestamps): lane X = the newest lane-X row
  with id ≤ R (none: empty then); the frames (+ the lg-nolan value) = the newest FRAME-STATE
  row with id ≤ R (`readFrameStateRowAt`: tagged lg-nolan, or carrying a frame).
- **History list** (`read_tm.ts`): the timeline of language X of a main that declares a slot is
  `lang IN (X, 'lg-nolan')`. Every row's PREVIEW is the reconstructed state at it: the row's
  lane, the other lane as of it (the view language for an lg-nolan row, the lg-nolan value for
  a language row), the frames as of it — a middle state is visible as it stood.
- **Restore** (`apply_value`): a lane-X row puts X's value back from the row
  (`mergeRestoredLangSlice`, the other languages untouched) and the frames AS OF the row; an
  lg-nolan row puts the lg-nolan value (none for a translatable main) and the frames back from
  the row. A frame whose item existed at the row in any language and no longer exists is never
  written back (`isStaleItemFrame` over `readOtherLangItemIds(coords, [], R)`, every lane —
  unsliced items by their row's lane). The restore writes its own rows under the same rule.
- **Undo log.** Pairs follow the lanes: one pair per language lane touched (its region only,
  cut SEQUENTIALLY so an orphan claimed by several sliced lanes is undone LIFO) + one lg-nolan
  pair (lg-nolan region + frames). The composed revert chains, conflict-checks and restores PER
  LANE (newest lane first); inside the lg-nolan lane the value and the frames are two disjoint
  parts, each checked on its own (a curator who put one back by hand never refuses the other).
  The pairing law reads the items of the lanes the unit does not restore from their history.
- **PHP-era rows.** A PHP main save (one language's value + frames) gives its lane's value
  and is its own frame state; a PHP dataframe save (lg-nolan, the main in every language +
  frames) reads as the lg-nolan lane — its lg-nolan items and its frames, the other languages'
  items ignored (a translatable main's lg-nolan row restores its frames only —
  `rowRestoresValue`); a slot absent from a frame-state row is empty; multi-slot partial rows
  accepted. **The one structural limit:** a PHP language row carrying NO frame cannot be told
  from an engine language row, so it carries no frame information — its frames are the newest
  frame state below it; a frame of an item it had already dropped pairs no restored item and the
  pairing law never writes it back. TS-era beta rows are unsupported. D-A, D-C and 0010-0012
  stand.
- **Known limit, stated:** an item removed after a run with the time machine OFF, in a lane the
  run never touched, is invisible to the pairing law (no history row names it); a restore of
  the run's frames can then write a frame pairing nothing. The TM-on removal is refused
  `changed_since_run`.

**Gate reconciliation:** no fixture holds these rows; no re-harvest. `tm_save_order_native`
rewritten to the lanes (95 tests): a fifth kind, TRANSLITERABLE (input_text + `with_lang_versions`,
lg-ell written through tool_lang's door); after every step one row per lane, a language row
frameless and equal to its live lane, the lg-nolan row equal to the live frames, the newest row
reconstructing to the full live state; every MIDDLE row previewed (frames as of it) and applied
(its lane + the frames as of it); a frame save of a two-language main writes ONE lg-nolan row.
Mutation-checked: frames read from the row itself instead of as-of → 6 red; a translatable
main's lg-nolan holding a value → 1 red. Updated to the contract: `tm_composed_rows_native`
(language row frameless; slot change and CSV frames-only = one lg-nolan row/pair; a language
restore takes the frames as of it), `bulk_undo_capture_native` (envelope frames: one lg-nolan
pair), `bulk_revert_undo_native` (the pairing law over a TM-on sibling removal),
`tm_lang_slice_restore_native` (door census: `recordMainHistory`, `restoredLaneValue`),
`delete_data_native` (the wipe rows of an lg-nolan item are lg-nolan; DATA-01 pinned with an
lg-eng item), `duplicate_record_native` (backfill per language lane), `tm_epoch_tripwire` /
`tm_history_visibility_tripwire` (time_machine.ts 4 narrowed reads: `newestRowAt`),
`write_obligations_tripwire`, `module_state_tripwire` (spellings of the new writers).

## Addendum 2026-09-28 (review 4) — transliterable saves keep their lane; the frame lane is complete; the preview is the restore

- **Transliterable saves** (a deliberate return to PHP, component_common :666-678). Every door
  that saves, echoes or cuts the slice it saves back reads ONE rule, `effectiveSaveLang`
  (`src/core/ontology/resolver.ts`): the request lang for a translatable component, a
  `with_lang_versions` one and component_iri; lg-nolan otherwise. Before, the save door, the
  temporal door, the save echo, propagate's region, the CSV append grouping, tool_tc and
  apply_value's untagged-row fallback each carried `translatable || iri`: a save of rsc85 in
  lg-ell REPLACED the lg-nolan base with the transliteration (restamped lg-nolan), so the
  transliterable lane of this contract could not be produced by a save; update_cache's
  per-language regroup wrote two nolan pairs for a no-op and minted a base that never existed;
  a CSV cell `{lg-nolan, lg-ell}` lost its base. The component READ (resolve/component_data.ts)
  keeps PHP get_element_lang's nolan-forcing — no read-path wire change.
- **The frame lane is complete** (`recordFrameLaneBaseline`, dataframe_slots.ts). A language row
  carries no frame, so before one is written (a visible row, or a run's language pair) the
  newest frame-state row must hold this main's own frames and lg-nolan value as they stand;
  when it does not (frames written by a door that records no history), ONE visible lg-nolan row
  of the BEFORE state is written first. No frame state and nothing in the frame lane reads as
  equal (no row for a main that never held a frame). Rejected: reading "no frame-state row at or
  below R" as UNKNOWN (leave the live frames) — it contradicts this contract's state-at-R law
  (frames empty then) for complete history, which the worked example pins.
- **The preview is the restore** (`previewLaneValue`, lane_state.ts). The row's own lane is
  previewed through apply_value's own `restoredLaneValue` (the merge moved from the tool into
  core); the other lane as of the row is put back STRICTLY (only items tagged that lane), and a
  translatable main's lg-nolan lane is never read as of the row (`readLaneValueAt` follows
  `rowRestoresValue`). A PHP orphan and an lg-nolan item on a translatable main are no longer
  dropped from the preview. The one deliberate difference: the preview shows the other lane as
  of the row; a restore leaves it live.

**Gate reconciliation:** no fixture edit. `tm_save_order_native` +2 (the save door writes an
lg-ell row beside the base; a bulk regroup of unchanged groups writes nothing);
`bulk_undo_capture_native` +4 (CSV replace / append of a `{lg-nolan, lg-ell}` cell, propagate
add in lg-ell, update_cache of an unchanged transliterable record with and without a base);
`tm_two_lanes_native` +4 ((8) the frame-lane baseline ×3, (9) preview = apply_value) and (7)'s
"PHP main save row IS a frame state" rebuilt so the live frames ARE the PHP row's;
`tm_composed_rows_native` (a language save / a translation over frames seeded without history
records ONE lg-nolan baseline first; restoring the translation keeps the frames);
`tm_lang_slice_restore_native` / `save_echo_lang_slice_native` (their plain non-translatable
component no longer carries `with_lang_versions`; census: apply_value calls `restoredLaneValue`,
lane_state.ts calls `mergeRestoredLangSlice`); `tm_dataframe_docs_claim` (bans "holds the main in
ONE language"; a v6 dataframe save holds every language + the frames). Mutation-checked: the old
save-door rule → 2 + 3 red; the old CSV grouping → 1; the old propagate region → 1; no baseline
→ 2; `readLaneValueAt` reading a translatable lg-nolan lane → 1; the preview's own lane via
`restoreRegion` → 1.

## Addendum 2026-09-28 (review 5) — the frame lane first; one orphan law; every timeline two-lane; transliterations listed

- **The frame lane FIRST** (supersedes "Language rows first, the lg-nolan row last" of the
  two-lanes addendum). A save that writes an lg-nolan row writes it BEFORE its language rows, in
  the visible rows (`recordMainRows`) and in the undo pairs (`recordMainPairs`: the lg-nolan
  pair first, then each language pair cut from the state it left). A language row's frames are
  the newest frame state at or below it, so with the old order the state at the language row of
  an item REMOVAL paired the new value with the old frames: its preview showed, and its restore
  wrote back, the removed item's frame — an orphan. The baseline-first rule stands.
- **The lg-nolan door of a SLICED main reads its slots** (`beginSaveHistory`). A transliterable
  base save's `remove` / `clear` reaches every language, so it writes language rows; with unread
  slots its baseline claimed "no frames" and wrote a frameless pre-save copy. Only an UNSLICED
  non-translatable main (one lane) skips the read.
- **One orphan law for the frame lane.** A TRANSLATABLE sliced main's lg-nolan lane is its frame
  lane: its value is the items tagged exactly lg-nolan, never a lang-less orphan — in the
  visible row (`visibleOf`), in the undo region and its restore (`laneRegion` / `restoreLane`,
  `isStrictFrameLane`: the frame lane is cut first, so a region that kept orphans filed a
  translatable main's orphan under lg-nolan). The frame-state comparison (`frameStateKey`)
  reads only lg-nolan-TAGGED items on both sides: an orphan riding a non-translatable door's
  lg-nolan row no longer makes every later language save write a spurious baseline.
- **Every timeline is two-lane** (`read_tm.ts` `laneClause`): a locator carrying lang X reads
  `lang IN (X, 'lg-nolan')` for every main — the writer files frame rows for undeclared live
  slots too, which a declared-slot lookup missed; a main with no frame lane has no lg-nolan row
  to add. A NON-translatable main that keeps language versions (`with_lang_versions`, and a
  non-translatable component_iri — `savesInRequestLang`) asked in lg-nolan (the tool's context
  lang) is read in the request's DATA language (`timelineScope`, a copy of the SQO): the base,
  the frames and the version of the language the curator works in. ~~**Stated limit:** the
  preview of such a version row shows the base as of it and the frames, not the version — the
  live read emits no `transliterate_value`
  (WC-2026-08-31-client-reads-three-fields-the-engine-never-emits); `apply_value` restores it.~~
  **Closed 2026-10-31:** a read with an EXPLICIT lang serves a transliterable's version
  (resolver.ts `elementLang`), so the preview of a version row viewed in that language shows
  the version as of it + the frames, and every item carries its other-lang counterpart as
  `transliterate_value` (WC-2026-10-31-transliterate-value-emitted).
- **Preview of an unsliced main's frame row** (`previewLaneValue`): a translatable portal's
  lg-nolan row records no value, so its preview shows the value AS OF the row, never the live
  one.
- **Composed revert orphan guard** (`assertNoOrphanedFrames`, bulk_revert_composed.ts): when a
  unit leaves the frames alone and its lane restore removes an item from every language, a live
  frame of the main pairing that item that was not in the frame state before the run (added
  after it) refuses the unit `changed_since_run`; a frame-first frame that stood before the run
  is the pre-run state and stays.

**Gate reconciliation:** no fixture edit. `tm_two_lanes_native` +10 ((10): transliterable
lg-nolan `remove` → [lg-nolan, lg-ell], orphan ×2, removal row restore, bulk removal row
restore, frame-first restore, revert refused / frame-first kept, translatable-portal preview,
undeclared-slot list + count; (4) the tool's lg-nolan list read in lg-ell / lg-spa) and (6)'s
pair order `[lg-nolan, lg-spa, …]`. Mutation-checked, each red: slot read skipped → 1;
`visibleOf` orphans in a translatable frame lane → 1; `frameStateKey` keeping orphans → 1; rows
language-first → 2; pairs language-first → 2; no orphan guard → 1; unsliced preview live → 1;
`lang = X` → 3; no data-lang timeline → 1; orphan-keeping translatable frame-lane region → 3
(`bulk_undo_capture_native` 1, `bulk_revert_undo_native` 2).

## Addendum 2026-09-28 (review 6) — backfill baseline, one unsliced chain, one legacy history, the lane law in the exact plan, frame-row list cells

- **Backfill frame baseline** (`backfillFrameLane`, dataframe_slots.ts): with no lg-nolan row
  and nothing to keep in the frame lane, a backfill that writes language rows still records the
  baseline (`recordFrameLaneBaseline`) — a PHP language row carrying a frame IS a frame state,
  so without it a backfilled row read that stale PHP frame state.
- **One value chain for an UNSLICED main** (`laneGroups`, bulk_revert_composed.ts): a
  translatable portal's value pairs, filed under whichever request language saved them, form
  ONE chain in id order; only the lg-nolan (frame) pairs stay apart. A run saving it in two
  languages no longer refuses `interleaved_write`.
- **A legacy framed unit records its history ONCE** (`recordDeferredHistory`,
  bulk_revert_undo.ts), after every key and the carrier's frame half: the revert's language
  rows read the restored frames, never the run's.
- **The exact plan cuts with the capture's lane law** (`planExactKey`: `laneRegion` /
  `restoreLane`): a translatable sliced main's lg-nolan key is strictly its lg-nolan-tagged
  items — a lang-less orphan neither refuses it `changed_since_run` nor is deleted by it.
- **History LIST cell of a frame row** (`graftFrameRowValue`, read_tm.ts): a per-component
  lg-nolan row of a TRANSLATABLE main records no value; its value cell is the view language AS
  OF the row (`readLaneValueAt`), the state its preview shows — no longer an empty cell.

**Gate reconciliation:** no fixture edit. `tm_two_lanes_native` +5 (one per item above);
`tm_dataframe_docs_claim` +2 removed rules (the pre-lane backfill order and "calls
`recordTimeMachine()` twice"); `tm_lang_slice_restore_native` door census: bulk_revert_undo.ts
merges through `restoreLane` / `laneRegion`. Mutation-checked, each red: baseline skipped
without lg-nolan history → 1; chain per tag → 1; per-key legacy history → 1; `regionOf` live
cut → 1; `restoreRegion` restore → 1; list graft off → 1; old doc sentence → 1.

## Addendum 2026-09-28 (review 7) — one unit per slotted main, the lane law in the list cell

- **Slottedness is decided per MAIN address** (`slottedAddresses`, bulk_revert_plan.ts): a
  language key's rows carry no frame, so a main whose only slot is undeclared was slotted only
  through its lg-nolan key; its language keys were planned as units of their own (no LIFO lanes,
  no orphan guard) and committed while the frame unit refused — an item removed, its frame
  edited after the run left pairing nothing. Every key of a slotted main's address is now
  `composed` (exact) or `framed` (legacy): the main reverts all-or-nothing.
- **History LIST cell of a frame row follows the lane law, not the translatable flag**
  (`frameRowModel`, read_tm.ts): the graft applies to every main whose value lives in language
  lanes (`savesInRequestLang` — translatable, transliterable, component_iri) when the row holds
  no lg-nolan item (a transliterable base row shows its own base), under the main's real law
  (`translatable` read, not assumed). A non-translatable component_iri's cells are pinned to the
  audit lang (`laneCellLang`): emitDdoData nolan-forced them, so every iri row — value or frame —
  listed the empty lg-nolan slice.

**Gate reconciliation:** no fixture edit. `bulk_revert_undo_native` +1 (undeclared-slot main:
frame edited after the run → whole unit `changed_since_run`, nothing written);
`tm_two_lanes_native` +2 (iri list cells of value and frame rows; transliterable lg-nolan cells
in lg-ell = the row's base). Mutation-checked, each red: per-key slottedness → 1; graft gated on
`getTranslatableByTipo` → 1; no iri cell lang → 1; no lg-nolan-item guard → 1.

## Addendum 2026-09-29 — the lane follows the data shape; relations are never translatable

User decision (2026-09-29): a relation component (portal, select, check_box, radio_button,
filter, relation_*…) holds LOCATORS and is NEVER translatable — "a translatable portal"
makes no sense. SUPERSEDES every clause above that files an UNSLICED translatable main in a
language lane (the "two lanes" addendum's "An UNSLICED translatable main (a translatable
portal) keeps its whole value in the request language's lane"; review 5's "Preview of an
unsliced main's frame row"; review 6's "One value chain for an UNSLICED main"; the review
addendum's "an unsliced translatable relation main gets its frame row in the working data
lang", and the wipe/undelete "request lang" tag of such a main).

- **The rule.** The TM lane of a main depends ONLY on its model's data shape
  (`isLangSlicedModel`), never on the ontology `translatable` flag. An UNSLICED model (every
  relation, number, date…) has ONE lane, `lg-nolan`: every change writes one `lg-nolan` row =
  the whole value + every frame of its slots, whatever the flag and whatever the request
  language. Language lanes exist only for lang-sliced models (input_text, text_area, iri…,
  transliterable `with_lang_versions` included).
- **One constructor** (`laneLaw`, relations/main_lanes.ts): `translatable = sliced && flag`;
  `laneHoldsValue` = `sliced || lane == lg-nolan`. Every door and reader builds its law through
  it (capture `bulk_capture.ts` `saveDoorLane` → lg-nolan for unsliced; `mainIdentity` /
  `mainRowLang`; `recordMainHistory` / `recordMainBackfill` normalize any unsliced door identity
  to lg-nolan; the preview `section/read.ts`; the list graft `read_tm.ts` — sliced models only;
  apply_value / preview read an unsliced row as lg-nolan whatever its tag
  (`readRowLaneState`); the exact and composed revert (`keyLaneLaw`, `laneGroups` one lg-nolan
  chain); the plan keys an unsliced key `lg-nolan`; Delete data and duplicate tag by the law).
- **Removed:** `readValueRowAt` (time_machine.ts), `valueDoorIdentity`, the unsliced-translatable
  branches of `readLaneValueAt` / `previewLaneValue` / `laneGroups` / `planLane`.
- **Unchanged:** the save path's DATA (a translatable relation's locators still carry the
  request `lang` stamp — relations/save.ts). TS-era rows tagged with a language for an
  unsliced main are unsupported (v7 TS beta); readers treat them as lg-nolan.
- **The list and the backfill probe ignore the tag of an unsliced main** (review 2026-09-29).
  Dédalo v6 tagged each save of a relation flagged translatable with the data lang, the row
  holding the WHOLE value — the one lane. `read_tm.ts` `timelineScope` drops the locator's
  lang for an unsliced main (no lang clause: every row listed in every language); the delete
  doors' and observer's backfill probe (`LaneHistoryProbe`, `anyTag` = `!sliced`) matches any
  tag, so a main whose history is only v6 language-tagged rows gets no redundant `lg-nolan`
  backfill row. `laneClause` (`lang IN (X, 'lg-nolan')`) stays for lang-sliced mains only.
- **Wire addition — dd15 context `tm_main`** (review 2026-09-29). On a ONE-COMPONENT history
  read the dd15 section context entry carries `tm_main: {tipo, lang_sliced}` (`read_tm.ts`
  `tmMainLaneLaw`; absent on every other read). The tool client never re-derives the law:
  `history_lang()` answers `lg-nolan` for `lang_sliced: false`, which hides the language
  selector and makes the apply confirm name `lg-nolan`. `apply_value_confirm_msg` reworded in
  every lang block (name and tokens unchanged): a component with per-language text keeps its
  other languages; any other (lg-nolan, relations included) is replaced in full with its
  dataframes. No fixture edit (no frozen gate replays a dd15 one-component context).

**Gate reconciliation:** no fixture edit. New `tm_relation_lane_native` (5): a portal and a
select whose ontology node says translatable, saved under lg-spa and lg-eng requests → lg-nolan
composed rows only (value + frames), listed and counted in lg-spa / lg-eng / lg-nolan, preview
in any language, apply_value exact (restore row lg-nolan), bulk pairs lg-nolan only, revert and
revert-of-revert exact; a portal whose ontology node says translatable, frame-first: restoring
the empty-portal frame row keeps its frame although the item later saved is stamped lg-spa; a
run that adds the stamped item and moves its frame reverts exact (`full`, nothing skipped).
Rewritten to the new rule (they pinned the removed behaviour):
`tm_save_order_native` 3, `tm_two_lanes_native` 2 (+2 retitled), `bulk_revert_undo_native` 2
(+2 lane assertions). Mutation-checked: the old lane law restored in `laneLaw` /
`laneHoldsValue` → `tm_relation_lane_native` 2 red; the locator `lang` stamp read as the item's
lane (`unsliced` → false) in `rowFrameSlice` → the frame-first restore test red, in
`otherLaneItemIds` (composed bulk) → the frame-first run test red.
Review 2026-09-29 gates: `tm_relation_lane_native` +2 (v6 lg-spa/lg-eng-tagged select rows
listed 2 in lg-spa/lg-eng/lg-nolan and a Delete data writes ONE row, no backfill; the dd15
`tm_main` law for portal/select/input_text); client `test_tool_time_machine` +3
(`history_lang`). Mutation-checked: `timelineScope` keeping the lang → list 1≠2; probe
`anyTag` forced false → 2 rows written; `lang_sliced` forced true → red.
Further review 2026-09-29 gates, `tm_relation_lane_native` +4: a PHP-era frame-first row
tagged lg-spa (empty value + frame) restores with its frame; a select row tagged lg-spa
restores (asked in lg-eng) and previews (in every language) its whole value; a portal row
tagged lg-spa made with no frame is its own frame state (restores with no frame, not an older
lg-nolan row's); a legacy run whose rows PHP tagged lg-eng / lg-spa is ONE lg-nolan key, the
revert exact. Mutation-checked (each alone): `readOtherLangItemIds` `row_lang` keeping the
row's tag for an unsliced main → the frame-first lg-spa test red; `restoredLaneValue` merging
an unsliced main by lane → the whole-value test red (+ the portal/select/no-frame tests);
`readRowLaneState` reading an unsliced row in its tag's lane → the no-frame portal test red;
the bulk plan keying an unsliced legacy key per row tag → the legacy-run test red.
Per-file floor (`engineering/unit_baseline.json`): `tm_relation_lane_native` 11 tests / 115
assertions, measured green on the suite DB (`--record-new` refuses a recorded file, so a stale
floor leaves added gates unguarded).
Review 2026-09-29 (round 3) fixes: (1) a LEGACY framed unit (PHP-era run over a main with
slots) is scope-gated on its slots too — `RevertUnit.slotTipos` (declared ∪ slots a run row's
frames name) is set for composed AND legacy framed units and checked by `unitInScope`; a
legacy frame half that would change any other slot (named only by the pre-run row, or live)
needs the caller's level 2 on it, else the unit is `out_of_scope` (`assertSlotGrants`). Gates
`bulk_revert_undo_native` +2; mutation-checked: `unitInScope` gating slots of composed units
only → red; `assertSlotGrants` skipped → red. (2) Duplicate records a copied key whose tipo
no longer resolves to a storable model (no model / no matrix column) as one unsliced lg-nolan
lane (the wipe/revert doors' rule) instead of throwing `engine.uncovered_scope` after the
insert. Gate `duplicate_record_native` +1 (stray `zz*` key: lg-nolan backfill + save row);
mutation-checked: the stray branch removed → `engine.uncovered_scope`, red.
Per-file floors re-frozen (round 3, `engineering/unit_baseline.json`, measured green on the
suite DB through the census runner over every test file this change touches):
`bulk_revert_undo_native` 107 tests / 721 assertions, `tm_two_lanes_native` 51 / 445,
`tm_composed_rows_native` 31 / 222, `tm_save_order_native` 100 / 1777, `duplicate_record_native`
6 / 32 (others of the change raised to their measured counts). Two floors LOWERED on purpose:
`tm_bulk_revert` 13 → 7 tests (the deleted row-per-row `preBulkState` and its 6 cases) and
`action_scope_binding_tripwire` 95 → 92 assertions (the retired `tool_time_machine.apply_value`
exemption).

## Addendum 2026-09-29 — a run's dataframe cascade no longer deletes rows

Under `WC-2026-09-29-dataframe-hard-delete-retired` no dataframe policy removes
a frame target row. A run's cascade writes role-4 twins of soft wipes only (row
kept). A missing-row role-4 twin comes only from a revert's D2 delete of a born
record, so the missing-row undelete, the unit coupling and the epoch refusal
are reached by revert-of-revert. The role-4 description "a record the run's
dataframe cascade deleted" now reads "wiped (a run's cascade) or deleted (a
revert's D2)".

## Addendum 2026-09-29 — a repeat revert judges a cascade record against the state it PRODUCES

A role-4 snapshot is where a revert STARTS for the record, not where it ends:
- a revert's D2 snapshots a born record AFTER clearing the run's keys;
- a run's cascade wipe snapshots the run's value.

On a repeat revert, every key the record's own units had put back therefore
differed from the snapshot, and `restoreWipedRecord` reported the record `kept`
/ `cascade_delete_not_reverted`. That broke "a double revert says unchanged".

`wipedKeysOf` now judges each key against the state the revert PRODUCES
(`producedStateOf`): the snapshot with every unit of the revert on that record
applied, newest first, by the units' own writers. Those are `restoreLane` for
an exact unit (`exactUnitProduces`), and `restoreMain` + `restoreSlot` for a
composed one (`composedUnitProduces`). The produced state is per language lane.

A key covered by a unit whose live value equals the produced value is settled,
and this is checked BEFORE the wiped-state test. "Equals" is the unit's OWN
equality (`ProducedKey.same`):
- an exact key compares strictly, as `planExactKey` does, so a pre-run unsliced
  `[]` is never "already there" as an absent key;
- a composed main uses `sameMain`;
- a slot uses slotWrite's rule that an empty slot stays as it is.

By construction every covering unit then finds that key `unchanged`.
Everything else is judged as before:
- a key no unit covers (never written by the run, or its rows unplanned) is
  compared against the snapshot;
- a legacy or unplannable unit leaves its keys undecided (never settled).

**No report change for real edits.** A curator's later edit is still reported
at the record (`cascade_delete_not_reverted`). When it touches the very lane the
run wrote, it is also reported by that key's unit (`changed_since_run`). A write
in a language the run did not touch is reported at the record only, because the
run's lane unit finds its own lane unchanged. Only the false alarm is gone.

Gates (`bulk_revert_undo_native`):
- keyed revert-of-revert repeat → unchanged/full;
- soft wipe of a run key → repeat unchanged/full (pre-run value empty or not);
- a target's own framed main → repeat unchanged/full;
- an unsliced run key with a pre-run `[]` → restored to `[]`, repeat unchanged;
- curator edit of a run key, or of another language of it → still reported.

- a composed main stored `[]` before the run and left absent (its slot
  stored `[]` by another writer) → already at the produced state: no put-back,
  no `cascade_undelete`.

Mutation-proved against the 116-test gate:
- settled check removed → 7 red;
- produced-value comparison removed → 5 red;
- coverage condition removed (uncovered keys settled) → 11 red;
- composed producer removed → 3 red;
- an exact key's strict equality replaced by the lenient one → 1 red (the
  unsliced pre-run `[]` test);
- the composed main's `sameMain`, or the slot's empty rule, made strict → 1 red
  each (the composed `[]` test).

Honest limit: the `undecided` guard (a legacy unit sharing a key with an exact
one) is a fail-safe with no gate. Producing it needs forged legacy log rows.

## Addendum 2026-09-30 — one door-lane law: speaking doors vs doorless doors

Audit 2026-09-26 F3. Three doors each carried their own answer to "which lane
does this history row go in", and two of them disagreed with the save.

**The law** (`mainRowLang` / `slicedRowLang`, `src/core/relations/dataframe_slots.ts`
— one owner; `mainIdentity` is its only caller). It updates the `mainRowLang`
sentence of the review addendum above ("a non-translatable main `lg-nolan` (a
non-translatable iri: its request lang)"):

- An UNSLICED main (every relation) files in `lg-nolan`, whatever its flag
  (unchanged, 2026-09-29).
- A SPEAKING door — one that carries a request lang: the save, the duplicate's
  re-save row, translation — files a sliced main in
  `effectiveSaveLang(tipo, model, pageLang)` (`resolver.ts`), the lang its own
  save writes: the page lang for a translatable, a `with_lang_versions`
  (transliterable) or an iri main; `lg-nolan` for any other. Before, a
  transliterable main answered `lg-nolan` here while its save wrote the page
  lang (review 4), so the save row and the history identity named two lanes.
- A DOORLESS door — `lg-nolan` / '': the wipe, the undelete, the observer, the
  slot/frame lane — files in `lg-nolan`, except a TRANSLATABLE sliced main,
  which files in the request's data lang (`currentDataLang`).

**The wipe and its undelete are a doorless PAIR.** `recordWipeHistory`
(`delete_record.ts`) now asks `mainIdentity(tipo, 'lg-nolan')` — the identity
the soft-cascade undelete uses (`bulk_revert_records.ts` `wipedMainIdentity`) —
instead of re-deriving it from the captured data lang. Byte-identical today;
what it removes is a second derivation that could drift. Rejected: filing the
wipe in `mainIdentity(tipo, dataLang)` — for a transliterable or iri key that
files the lang-less orphan in the page lang while the undelete stays in
`lg-nolan`, breaking the pairing the review addendum states ("under the main's
own row lang, the lang its wipe row carries"). A lang-less item rides the door
lane, and for a transliterable the lang-less lane is its base.

**Duplicate, item (b)** of `recordDuplicateHistory`: the save row's lane is
`effectiveSaveLang(currentDataLang())` — `copiedKeyIdentity` returns
`mainIdentity(tipo, currentDataLang())` with no local override. A transliterable
or iri copy now files its save row (and any lang-less items) in the working
data lang, as its save does; the forced, empty `lg-nolan` row is gone.

**Open (owner decision), named not fixed:** a translatable save from a
lang-less request is filed in `lg-nolan` by the save door (`effectiveSaveLang`
keeps the request lang) and in `currentDataLang` by this rule.
Translation still overrides its identity's lang with the target lang
(`translation.ts`); for a translatable main that equals the law, for a
non-translatable one the translation writes a slice the save door never would —
closed with translation's reroute (CLOSURE_PLAN Step 2).

**Gate:** `test/unit/history_door_lane_agreement_native.test.ts` (zz scratch
TLD, five components — translatable, plain, transliterable, iri, portal):
(1) the save row's lang equals `mainIdentity(K, L).lang`; (2) a duplicate's save
rows sit in the lanes its source's save used; (3) the wipe's lanes for a
lang-less orphan are undelete lanes, and the data-lang timeline lists both.
Mutation-proved: `slicedRowLang` back to iri-only → 3 red (K3); its
non-translatable branch returning the request lang → 3 red (K2); the
`copiedKeyIdentity` override restored → 2 red (K3, K4); the wipe in
`mainIdentity(tipo, dataLang)` → 2 red (cell 3). No other expectation moved
(tm_*, bulk_*, delete_*, duplicate_*, observer_*, translation_pipeline_native
green on the lane DB). No fixture edit, no re-harvest.

## Addendum 2026-09-30 — D4's media write is a locked transform; restores and undeletes propagate through the chokepoint

CLOSURE_PLAN Step 2 (TOOLS-5, CORE-1).

- **D4 stands, its write changed.** `update_cache`'s media repair still records no
  BEFORE/AFTER pair (files_info is derived from the disk; a revert could not put the
  moved/rebuilt files back). It is no longer a raw write of this run's snapshot: the
  derivatives are rebuilt outside the lock, then the items read UNDER the row lock are
  re-scanned and written through `files_info_persist.ts transformStoredMediaItems`, so a
  curator's upload committed during the run survives. See
  WC-2026-09-30-media-key-locked-transform.
- **The revert's observer leg moved into the chokepoint.** The key units, the composed
  units, the cascade undelete (`restoreDeletedRecord`, still VERBATIM — no stamp) and the
  soft-cascade restore no longer call the observer cascade themselves: every write
  declares its before/after to the obligation ledger, which drains after the unit's
  COMMIT (the undelete as a BIRTH: its covered observer slots recomputed, never restored
  from the snapshot). The mirror recomputes write their own Time Machine rows with
  `bulk_id` null — derived state, never a pair of this run, so the revert-of-the-revert
  judges no mirror key. See WC-2026-09-30-record-write-obligation-ledger.
- **A covered observer slot is DERIVED to every judge of the revert** (review round
  2026-09-30). Once the undelete propagated, a mirror stopped being inert state the
  judges could compare:
  - D2's foreign-value check (`holdsForeignValue`) skips covered observer keys — a born
    term whose recomputed mirror lists its (also born) referencer is not "written by
    someone else" (it was refused `created_record_kept`, FINAL);
  - D2's reference check (`isReferenced`) counts LINKS only: a locator held in a covered
    observer slot is the mirror of the record's own edge. Counted, a born term and its
    born referencer each "referenced" the other and neither could be deleted;
  - the soft-cascade restore (`wipedKeysOf`) never puts a covered slot back and never
    judges one a write since the wipe (a mirror recomputed by a referencer's save after
    the wipe made the record `kept`, wiped); every covered slot the section DECLARES is
    recomputed after the unit's COMMIT (`record_write.ts requestCoveredSlotRecompute`).
- **VERBATIM stays verbatim.** A missing-row undelete (`restoreDeletedRecord`, no stamp)
  marks its record on the transaction's cascade guard: every covered-slot recompute of
  THAT record in the same transaction's drain writes the mirror without dd197/dd201, so
  the run's stamp units still compare against the snapshot's stamps. A soft-cascade
  restore whose run owns the record's stamps recomputes the same way. LIMIT, stated: a
  recompute of that record driven by a LATER transaction (a referencer undeleted in a
  unit of its own) stamps it like any live record's.
- Gates: `obligation_ledger_native` cases 10, 10b and 11.

## Addendum 2026-10-21 — the live-run refusal's code; a cascade target refused before its scope is judged is unlocated

W4 cross-write (audit 2026-09-26, S3-1 / S3-2).

- **§4.1 names its code.** A revert of a run still writing, and the second of two
  concurrent reverts of one run, fail with `tool.bulk_run_live`: HTTP 409, category
  `conflict`, `retryable: true`, disclosure `public`, severity `info`
  (`src/core/errors/registry.ts`); the client applies the `tool.*` default policy. The
  refusal lifts when the run or the other revert ends. Gates:
  `bulk_revert_undo_native` "a LIVE run is refused (D5), and revertable once it ends",
  "two CONCURRENT reverts of one run: exactly one runs, the other is refused
  tool.bulk_run_live".
- **§4.5 / §5 — the disclosure law, stated for the missing-row undelete (SEC-16).** A
  cascade target refused BEFORE its record scope was judged — a MISSING row whose role-4
  snapshot is unusable, or whose address was taken during the undelete — is reported as
  a coordinate-free `{reason: 'cascade_delete_not_reverted'}` entry: the section-level
  pass of `mayUndelete` never discloses a record. A refusal whose record WAS judged (a
  wiped row present at the address, a D2 refusal `created_record_kept`) stays located,
  as before. Gate: `bulk_revert_undo_native` "a MISSING cascade target refused before
  any record-scope check is never LOCATED (SEC-16)".
