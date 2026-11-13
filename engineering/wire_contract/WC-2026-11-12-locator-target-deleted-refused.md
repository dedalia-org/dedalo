# WC-2026-11-12-locator-target-deleted-refused — a link to a deleted record is refused, never left dangling

- **Date:** 2026-11-12 (T1-19 / audit D01; owner ruling 2026-11-11: REFUSE, never drop).
  Sites: `src/core/section_record/locator_targets.ts` (the law), `record_write.ts` §3h (the
  chokepoint), `save_component.ts` `applySaveComponentData` (the door's pre-lock),
  `db/matrix_write.ts` `lockMatrixRowsForKeyShare` (the SQL) and every writer row lock (the
  lock-mode law below).
- **Decision:** DEC-12 (the invariant ships with its gate). GOES BEYOND PHP: v6 and frozen v7
  `section_record::delete` → `remove_all_inverse_references` ran with no transaction and no
  lock at all, and a save never looked at its targets.

## Shape before

A save that adds a locator to record `T` while `T` is being deleted:

```
{action:'save', source:{tipo:P, section_tipo:S, section_id:O, …},
 data:{changed_data:[{action:'insert', value:{section_tipo:S2, section_id:T}}]}}
```

answered `ok:true` in BOTH interleavings, and the locator outlived `T` forever:

- the delete ran first → the save, which locked only its OWNER row, never met it;
- the save ran first but committed after the delete's ONE inverse search → the search did
  not see the new owner, so nothing stripped it.

No error, no counter, no detection (`search_related.ts` said so: "NO LOCK CLOSES IT").

## Shape after (TS)

Every write that ADDS a locator takes `FOR KEY SHARE` on the target row, held to COMMIT;
the record delete's `FOR UPDATE` on its target conflicts with it, so one of them goes first:

- **save first** → the delete WAITS for the save's COMMIT; its inverse search (a later
  statement) then sees the new locator and strips it. The save answers `ok:true`; the link
  is removed by the delete exactly like every older link.
- **delete first** (including any time after it) → the save is REFUSED inside its
  transaction, nothing written (no value, no TM row, no stamps):

```
{ok:false, error:{code:'relation.target_deleted', status:409,
  message:'The linked record S2/T was deleted — remove the link (or restore the record from Time Machine) and save again',
  details:{section_tipo:'S2'}}}
```

"Deleted" = no live row AND Time Machine history at the address (the delete writes its TM
row in the same transaction as the row DELETE, so a waiting save sees both at once).

**NOT judged** (unchanged): a KEPT locator (already in the key before this write — a record
carrying pre-protocol residue stays editable); a non-address id (an external remote id such
as `'001338683'`, stored verbatim); an id < 1; a section with no matrix table; an absent
address with NO history (a forward reference, a never-existed id — owner decision A of the
T1-19 plan, strict referential integrity, is open).

**Entries** (`KeyWriteMode.targets`, census-pinned): `verify` — `persistRecordKeys`
(every save door: the client save, MCP, change-plan, imports, tools, children write-through,
the tree, the dataframe restore's slot write), `persistObserverResaveKeys`,
`persistAppendedKeyItems`; `exempt` with reason — `persistRelationRemovalKeys` (removes
only), `persistObserverMirrorKeys` (derived; the delete's death recompute heals it),
`persistRestoredKeys` (a TM restore writes history verbatim). NOT covered by this entry:
births (`prepareBirthColumns` — create-with-values, duplicate: owner decision B) and the raw
migration writers outside the chokepoint (`update/transform/portalize.ts`,
`media/tools/files_info_persist.ts`, the dataframe orphan fix) — residue there belongs to
the D01 repair step.

## The lock-mode law (no wire change, load-bearing)

Every matrix row lock of a door that does NOT delete the row is `FOR NO KEY UPDATE`
(`readMatrixKeyForUpdate`, `lockMatrixRowsForUpdate`, the save's component lock, the wipe,
the portal unlink, the dataframe orphan fix, the observer laws, the hierarchy registry and
provisioning, the AI spend day row). Same mutual exclusion among writers; it never conflicts
with `FOR KEY SHARE`, so two saves linking two records to each other, or a link to a record
someone is editing, never wait. `FOR UPDATE` remains only where the row is deleted (the
record delete's target, the hierarchy teardown) and on the diffusion job queue — census:
`delete_inverse_lost_update_native` G5.

**What is locked.** Only ADDED targets (absent from the key as stored). A KEPT target is
never locked: a full-array write that keeps a locator (a portal remove / reorder / update,
a dataframe merge, an observer re-save) cannot strand it — a concurrent delete of that
record waits on the owner row and strips it after this write commits — and a KEY SHARE on
it taken after the owner's row lock is the inverted order that deadlocks against that delete
(T1-19 review, 2026-11-12: the first cut locked every target of the after-value).

**Lock order.** The save door takes the changed values' KEY SHARE BEFORE its owner row; the
chokepoint takes the ADDED targets' (against an unlocked read of the stored key) before it
locks the owner, then re-judges under the owner's lock. The ONE residual inversion: a door
that already holds the owner in an AMBIENT transaction (CSV row transaction, children
write-through, tree doors) and ADDS a locator to a record the owner ALREADY references in
ANOTHER key: against a concurrent delete of that record the two can deadlock — Postgres
aborts one with `40P01` (loud, never a silent dangle; the tree doors already retry it). The
save door is not in that set (its pre-lock covers what it adds; it locks no kept target).

## Cost (measured, suite DB, 2026-11-12)

Portal insert p50 1.65–1.85 → 1.91–1.94 ms; `set_data` of 50 locators p50 2.53–2.54 →
2.93–2.97 ms (one KEY SHARE statement per target section + the before-image read; the TM
probe runs only for an absent target).

## Gates

`test/unit/delete_inverse_lost_update_native.test.ts` — R1 delete first (the save waits on
the deleter, then `relation.target_deleted`), R2 save first (the delete waits, then strips
the link), R3 lock order (the waiting save does not hold its owner; no 40P01), R5 a portal remove that
KEEPS a locator to the record being deleted never waits on it (save door), R6 the same under
an owner-held ambient transaction (the observer re-save shape), R4 the
chokepoint key write + atomic append, G1 mutual links never wait, G3 kept residue editable,
G4 forward/remote ids accepted, K7 the KEY SHARE door refuses outside a transaction, G5 the
lock-mode census, the per-entry `targets` declaration, and every gate the lock-law headers
name exists.

## Addendum 2026-11-13 — births judged under the same law (T1-19 owner decision B ruled a, C28)

Owner ruling 2026-11-13 (T1 owner decisions, C28 ruled a): the two INSERT doors
that bypass the chokepoint — `create_record.ts` (create-with-values: the projects filter, a
`dato_default` locator, the creator link) and `duplicate_record.ts` (every relation key the
clone copies) — now run `record_write.ts assertBirthLocatorTargetsLive` INSIDE the insert's
transaction, right after the row INSERT: every locator of the born row is an ADDED link (nothing
was stored before), so each target is locked `FOR KEY SHARE` to COMMIT, a running delete of a
target makes the birth WAIT, and a DELETED target (absent with Time Machine history) REFUSES the
birth with the same `relation.target_deleted` (409) — the row AND the counter roll back, nothing
addressed by the id exists (media and history follow the commit). The "NOT covered: births"
sentence of the shape-after section is withdrawn.

Consequences a reader sees:

- a duplicate of a record carrying a LEGACY locator to a deleted record is refused until the
  source is repaired (remove the link, or restore the record from Time Machine) — ruling (a),
  not (b): the clone is judged on what it will store, not on what the door read;
- a create whose section declares a `dato_default` pointing at a deleted record refuses every
  birth in that section until the default (or the record) is fixed — an ontology error made
  loud instead of a dangling locator on every new record;
- every birth takes a KEY SHARE on the creator's user record; two KEY SHAREs never conflict, and
  a user edit (`FOR NO KEY UPDATE`) does not conflict with one — only a delete of that user does.

Still exempt: the chokepoint's own birth entry `persistRecordBirth` (an undelete writes history
verbatim, as `persistRestoredKeys` does) and the raw migration writers named above.

Gate: `delete_inverse_lost_update_native` B1 (duplicate, legacy locator → refused, no row),
B2 (duplicate vs a concurrent delete: waits on the deleter's pid, then refused, no row, the
delete never the 40P01 victim), B3 (create-with-values: born linked before, refused after the
default's target is deleted, no row). No frozen fixture is affected; no re-harvest.
