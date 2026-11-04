# WC-2026-08-14-relation-insert-accepts-batch — the relation insert is validated SET-SCOPED; the per-locator outcome wire is NOT shipped

- **Date:** 2026-08-14 (the relation `view: "tree"` → thesaurus picker landing; shipped with
  `src/core/relations/save.ts` `validateRelationInserts`).
- **Decision:** the insert chokepoint evaluates the whole resulting row set inside one
  transaction. The request and response wire are **UNCHANGED**. (Canon:
  `engineering/AREA_SPEC.md` §5.7 for the picker surface, `engineering/RELATIONS_SPEC.md`
  for the save path. Sibling entry: `WC-2026-08-14-relation-insert-target-validation`,
  which records the refusals this set-scoping makes enforceable.)

## The seam

`data_limit` and dedup are properties of the resulting SET, not of a single request. A door
that judges one locator against a stale count cannot see that N picks each individually
under the cap collectively break it, and judging them across N requests is a race rather
than a check. So the validation had to become set-scoped even though nothing on the wire
moved.

## Shape before (PHP)

One locator per request, one aggregate result. The client learned what happened by reading
the server-authoritative pagination `total` back and diffing it against its own idea of the
entries.

## Shape after (TS)

**Identical on the wire.** `validateRelationInsert(rawValue, context)` keeps its signature
and its "null means dropped" contract; `total` stays server-authoritative and is still what
the client reads. Every existing caller is byte-unaffected.

What changed is INTERNAL: `validateRelationInserts(rawValues[], context)` is the real
chokepoint and `validateRelationInsert` is its length-1 delegation. Inside it:

- the cap is compared against the count the **cap scope** would reach if the locator lands —
  the slot for an ordinary relation component, the MAIN ITEM for a dataframe frame, since
  `data_limit` on a frame slot is declared per main item;
- locators accepted earlier in a call join the dedup scope;
- a locator that is **already stored** (`context.storedItems`) skips every constraint gate.
  A `set_data` replays the whole array through this door — the CSV import and the
  raw-export round trip both do — and the gates test facts that legitimately change under a
  record over time (a hierarchy deactivated, a principal's read grant, an `is_indexable`
  flag cleared). Re-judging a stored link would delete heritage data on an unrelated save
  and still report success. The gates police GROWTH.

## What is deliberately NOT shipped

`validateRelationInserts` returns `{outcomes: [{locator, status, code?, reason?}], total}`,
but **no API emits that shape and no client reads it.** Every production caller goes through
the length-1 door, which has no channel for a reason and therefore `console.error`s the four
constraint refusals (`off_target`, `target_not_readable`, `term_not_selectable`,
`selection_limit`) instead of returning them.

This is recorded rather than quietly left as an intention: an earlier draft of this entry
described the outcome array as the shipped wire and instructed consumers to read it. That
was false on landing day. **A caller must NOT read `outcomes` from any endpoint today** —
the type exists, the wire does not. Wiring it through the save response is the work that
would let the picker title a refused term with its own catalog label instead of leaving the
operator with an unexplained no-op; until then that gap is real and named here.

## Reason

Recorded even though the wire did not move, because the ledger is where a reader checks
whether a shape changed, and "the internal chokepoint became set-scoped, the wire did not"
is precisely the question a future reader of the `outcomes` type will ask. The entry exists
to stop that type being mistaken for a contract.

## Gate reconciliation

- `test/unit/relation_insert_target_native.test.ts` — the set-scoped cases: two saves racing
  the same component do not jointly exceed `data_limit`; a duplicate of an existing row
  dedups without erroring; a re-persisted stored locator survives every gate; a dataframe
  slot at `data_limit:1` accepts one frame **per main item** rather than one per record.
- `test/unit/dataframe_write_contract_native.test.ts`, `test/unit/ws_a_tripwires.test.ts` —
  the write-path contracts this runs inside.

**Re-harvest: NOT APPLICABLE.** The request and response bytes are unchanged, so the frozen
store is untouched (measured: the parity failing set is identical at HEAD and on this
change). Per `engineering/ORACLE_HARVEST.md` a re-harvest is impossible by definition in any
case — the native gates above are this behaviour's only baseline.

## Addendum 2026-08-16 — the length-1 door now THROWS a constraint refusal

"What is deliberately NOT shipped" above described the length-1 door as
`console.error`-ing the four constraint refusals and returning null. That is no longer
the case: it THROWS (`relation.insert_refused` 400 / `perm.denied` 403 — see the sibling
entry's addendum), so the save answers a named refusal instead of a silent success. The
per-locator `outcomes` wire is STILL not shipped: a batch through the length-1 door
(every production caller) is refused as a whole on its first refused net-new locator, and
the accepted siblings roll back with it. Wiring `outcomes` onto the save response as
per-locator notices remains the open work; ledgered in `rewrite/LEDGER.md` known-open.

## Addendum 2026-11-04 — `target_not_readable` retired; three constraint refusals remain

"What is deliberately NOT shipped" above and the 2026-08-16 addendum count FOUR constraint
refusals. One is gone: `target_not_readable` (the tree-picker READ GRANT gate,
`refuseUnreadableTreePickerTarget` in `src/core/relations/save.ts`) is retired by owner
decision (i) — the tree picker follows the writer-chain scope instead
(`WC-2026-11-04-tree-picker-read-gate-retired`). The length-1 door now throws on THREE
constraint refusals of this entry's set: `off_target`, `term_not_selectable`,
`selection_limit` (plus `project_not_member`, added later for the projects filter —
`WC-2026-10-22-filter-project-pick-membership`). Nothing else in this entry changes: the
per-locator `outcomes` wire is still not shipped.
