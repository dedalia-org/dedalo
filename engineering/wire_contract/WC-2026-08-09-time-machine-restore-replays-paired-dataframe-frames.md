# WC-2026-08-09-time-machine-restore-replays-paired-dataframe-frames — a TM restore replays the dataframe half, and both TM write doors join the observer cascade

- **Date:** 2026-08-09 (audit `audits/2026-08_oh1_beta` §5.6 + its P2 list).
- **Scope:** `tools/tool_time_machine/server/` — `apply_value` (component
  branch) and `bulk_revert_process`.

## What was wrong

A main component that declares a `component_dataframe` slot does not store its
frames in its own column: they live in `relation[<slot tipo>]`, paired to
individual main items by `id_key → id`. Both time-machine write doors rewrote
only the main column, so a restore left the record in a state it had never
been in — on `oh1`, `oh24` (Informants) reverted while `oh115` (Role) stayed at
today's values, and every frame whose `id_key` no longer matched a live main
item became a permanent orphan the UI can neither render nor delete.

PHP restored or wiped the frames FIRST
(`tool_time_machine::apply_value` :277-333 → `component_dataframe::
set_time_machine_data` :382, which empties the slot then replays the snapshot's
frames with `tm_record::$save_tm = false`). That half was unported.

## Restored oracle behaviour (no divergence)

- **`apply_value` replays the frame half.** For each dataframe slot of the main
  component, the slot is emptied and the snapshot's frames for it are written,
  BEFORE the main column write, all inside one transaction. A slot with no
  frames in the snapshot is emptied (key removed) — PHP's contract.
- **The fresh TM audit row carries main + frames** (PHP
  `component_common::get_time_machine_data_to_save` :1580 appends every slot's
  full data to the main's snapshot), so reverting a restore brings the frames
  back with it.
- **No TM row is written for a slot** — PHP suppresses it; the main's row
  carries the frames.
- **Both doors fire the observer cascade, post-commit.** PHP restored through
  `component_common::save()`, whose last act is `propagate_to_observers()`
  (class.component_common.php:2147). The TS port writes through
  `persistRecordKeys` directly and had skipped it, so a TM restore of an
  observed component left every mirror at the pre-restore value and wrote no
  observer TM audit row. This is oracle parity, not a broadening: WC-050's
  "doors still outside the cascade" list never named these two, and its opening
  sentence ("PHP fired `propagate_to_observers` only from the interactive
  component-save controller") is inaccurate — every `element->save()` fired it.
- **Restored items are absorbed into the item-id counter**
  (`absorbComponentItemIds`, PHP raises on every `set_data`). Load-bearing for
  the pairing itself: a re-minted duplicate main-item id would make two items
  answer to the same frame `id_key`.

## Deliberate divergences

1. **Slot discovery is a UNION, not the config map alone.** PHP's
   `get_dataframe_ddo` reads only the main's `request_config` show map, which
   misses a LITERAL main whose frames activate on `has_dataframe` + ontology
   parentage (the config and data halves can legitimately disagree). TS unions
   the ontology children of model `component_dataframe`, the own-config ddos
   (show AND hide), and the slots the snapshot's own frames name. A slot missed
   at discovery is a slot never emptied — exactly the orphan this change exists
   to end. Strictly additive: a slot PHP found is still found.
2. **An unattributable LEGACY frame refuses the whole restore.** A pre-migration
   frame with no `from_component_tipo` while the main has more than one slot in
   play aborts with `uncovered_scope` and writes nothing; PHP duplicated it into
   EVERY slot, which is the corruption, not a fix. Unreachable on real data
   (a scan of every TM snapshot in the live archive found zero frames lacking
   `from_component_tipo`).

   NOT a divergence, and explicitly reverted on 2026-08-09: a frame whose
   `from_component_tipo` does not resolve to a `component_dataframe`, and a
   legacy frame when the main has NO slot at all. PHP never inspects a frame's
   `from_component_tipo` on its own — it loops the slots it discovered and
   filters the snapshot per slot — so such a frame matches no iteration, is
   written nowhere, and is stripped out of the main data. It is inert, not lost:
   the TM row carrying it is kept forever (component restores never consume it).
   A first revision of this entry refused those restores; that broke the Phase-6
   contract gate `test/unit/tool_request.test.ts` "apply_value strips dataframe
   frames from the restored main data", which is a real, correct contract — a
   snapshot carrying a stale or foreign frame must still restore. Law 3's second
   half applies: do not throw where the oracle handled a case generically.
3. **`bulk_revert_process` takes the same frame path.** PHP's bulk revert fed
   the raw snapshot to `set_data` — writing frame locators into the main
   component's own key and leaving the slots at today's values. That is the very
   corruption `apply_value`'s strip exists to prevent, so the two doors now
   share one primitive instead of one of them keeping the defect.
4. **Restoring a TM row whose own tipo IS a `component_dataframe` slot is
   refused** (previously refused only when `caller_dataframe` was present). For
   such a row the snapshot's dd490 entries ARE the component's value, and the
   ONE shared `stripDataframeFramesFromTmMain` — which the TM PREVIEW read
   applies too — reduces it to an empty array, so the restore silently WIPED the
   slot. Un-stripping only the restore would make the tool write something the
   user never previewed, so the door refuses until the shared strip and
   `section/read.ts` are fixed together.

5. **A FRAMELESS snapshot over LIVE frames is refused, not replayed** (added
   2026-08-09; `refuseFramelessWipe`). PHP's contract is that a slot absent from
   the snapshot is emptied, and this port originally replayed that faithfully.
   It cannot, safely, while the CAPTURE half is unported (below): every TM row
   the TS engine has written for a dataframe-paired main is frameless, and it is
   indistinguishable from a PHP-era row whose slots were genuinely empty. The
   frames exist in NO other row — PHP writes no TM row for a slot (`oh115` has 0
   against `oh24`'s 172 in the live archive) and divergence 4 refuses a slot-row
   restore — so replaying the wipe is an UNRECOVERABLE deletion, where the
   pre-fix defect merely left the frames stale. Both write doors therefore
   refuse: `apply_value` with `uncovered_scope` and nothing written,
   `bulk_revert_process` by skipping that component with a surfaced error.

   The condition is the narrowest one that closes the hole: refuse only when the
   snapshot carries NO frame for ANY planned slot AND a planned slot currently
   holds frames. A snapshot that carries frames is demonstrably a frame-aware
   capture, so its silence about another slot is informative and that slot is
   emptied (PHP's contract, unchanged); an already-empty slot has nothing to
   lose and restores normally. **This divergence is retired — with its two
   tests, not by loosening them — the day the capture half lands.**

## Known-open dependency (the capture half — BLOCKING pair)

`section/record/save_component.ts` records the main component's TM snapshot as
its own column value alone (`tmSnapshot`, :1091-1113); PHP's
`component_common::get_time_machine_data_to_save` :1580 APPENDED every slot's
full frame set. Until that is paired, TS-written TM rows for a dataframe-paired
main carry no frames and divergence 5 refuses to restore them onto populated
slots. PHP-era rows already carry the frames and restore fully. The fix is to
append the values of `(await getDataframeChildTipos(mainTipo)) ∪ own-config
dataframe ddos` (`resolveDataframeSlotTipos` in
`tools/tool_time_machine/server/dataframe_restore.ts` is exactly that discovery,
ready to be shared) to `tmSnapshot` for non-dataframe mains — the same shape
`composeTimeMachineSnapshot` already writes on the restore side. That file is
owned elsewhere; land it with this entry.

### Gate

`test/unit/tm_dataframe_restore_native.test.ts` — scratch `oh1` twins over the
real `oh24`/`oh115` pair: the frame set equals the snapshot's, no orphan
`id_key` survives, a frameless snapshot over live frames REFUSES and writes
nothing (and the same snapshot over an EMPTY slot still restores, so the guard
is not a blanket), a frame naming a tipo that is not a live slot restores
normally and lands nowhere, `planDataframeRestore` attributes/refuses legacy
frames by slot count, the fresh TM row carries main + frames, the slot gets no
TM row of its own, `bulk_revert_process` restores both halves and skips a
frameless pre-batch state, and an observed component's restore recomputes the
target mirror and writes its observer TM audit row.
Plus `test/unit/tool_request.test.ts` (Phase 6) for the non-refusal in
divergence 2.

## Addendum 2026-09-27 — the capture half landed: composed rows

The known-open dependency above is closed by WC-2026-09-27-bulk-revert-undo-log §8. Every
history row of a main with at least one dataframe slot is now COMPOSED — the main's data
followed by the full frames of every slot (the discovery union of divergence 1, now in core:
`resolveDataframeSlotTipos` in `src/core/relations/dataframe_slots.ts`, re-exported by the
tool). A slot save writes the main's composed row, never a row of its own, and a bulk run records no
slot pair either: `bulk_revert_process` reverts the main and its frames as one unit from the
main's composed undo pairs (WC-2026-09-27-bulk-revert-undo-log §4 step 3).

- **Divergence 5 is RETIRED** (WC-2026-09-27-bulk-revert-undo-log, addendum 2026-09-28):
  TS-era rows are unsupported beta history, so no frameless row is refused. Every row —
  Dédalo v6 or engine-written — is the full state of the main and all its dataframes: a slot
  it is silent about was empty then and is emptied (`rowSlotTipos`), in `apply_value`, the
  preview and both bulk-revert paths (WC-2026-09-27-bulk-revert-undo-log, addendum 2026-09-28
  — full-state contract; the composition epoch is removed). `refuseFramelessWipe`, its tests and the `frameless_wipe` skip reason are gone
  (retired "with its tests, not by loosening them", as this entry required).
- **Two lanes (2026-09-28, WC-2026-09-27-bulk-revert-undo-log, addendum "two lanes") narrows
  the two bullets above.** Only a FRAME-STATE row — an lg-nolan row, or a Dédalo v6 row carrying
  frames — is the full frame state of the main, and only there is a slot it is silent about
  emptied. A LANGUAGE-lane row is value-only for every main: its frames are those of the newest
  frame-state row at or below it (`src/core/tm_record/lane_state.ts` `readRowLaneState`), in
  `apply_value`, the preview and both bulk-revert paths. The language row itself names no
  slot; the frame-state row it resolves to decides what is emptied (none at or below it: every
  slot of the main loses its frames of the main — the state at the row held none). "Every row is
  COMPOSED / the full state" above reads as "every frame-state row".
- **Divergence 4 stays**: no supported history has a slot row (PHP never wrote one), and
  `apply_value` on one is still refused.
- **Divergences 1–3 unchanged.**

## Addendum 2026-11-21 — the READ and the raw export answer the same slot set (T2-SL-6)

The discovery union of divergence 1 (`resolveDataframeSlotTipos`: dataframe children ∪ the
main's own-config ddos, show and hide ∪ the model's fixed frames) was the set of the save
cascade, the Time Machine and the record delete. Two doors answered a narrower one — ontology
children only — and now answer the same:

- **Component read of a LITERAL main** (`src/core/section/read.ts` `literalDeclaredFrames` /
  `literalFrameSlots`). A literal with `properties.has_dataframe: true` emits one frame item per
  stored item id for every slot of the set, plus every `component_dataframe` its CALLER names as
  its child (the request's ddo_map — PHP resolved a literal's frames through the request_config
  ddo_map it was handed). Before: a slot the literal declares in its own `request_config`
  without being its ontology child was stripped by a remove and restored by the Time Machine,
  yet never emitted. `has_dataframe` stays the switch: without it only the model's fixed frames
  pair (component_iri → dd560); a child node, a config ddo or a caller line activates nothing.
  A `component_iri` that ALSO carries `has_dataframe` now emits its other declared slots beside
  dd560 (it emitted dd560 alone).
- **Raw export** (`src/diffusion/export/grid.ts`, WC-2026-08-09-export-raw-dataframe-own-column):
  the `dedalo_raw` frame columns of a top-level component — and their per-run authorization —
  are the same set. New columns appear for a slot declared by config only and for
  component_iri's dd560.
- Gate: `test/unit/has_dataframe_literal_native.test.ts` → "T2-SL-6" (sibling-declared and
  caller-injected frames emitted; the flag law's control; and the CROSS-DOOR case — the read,
  the save cascade, a Time Machine restore and the raw export of one main answer one set, so a
  door narrowing or widening it alone goes red).
- **Gate reconciliation:** TS-native only. `has_dataframe_literal` golden (child slot, oracle
  captured) is unchanged; no frozen fixture holds a config-only literal slot. No re-harvest.

## Addendum 2026-11-21 — caller-injected slots join the set of every door (B3 review M3)

Owner ruling 2026-11-21 (B3 Q2): a slot only a CALLER names (a `component_dataframe` injected as
a literal's child in the request's ddo_map — the read's `literalFrameSlots`) is the main's, no
orphans. Each door now finds it by the frames it holds, the discovery the Time Machine already
used (`readMainSlots` — declared ∪ every key of the record holding one of the main's frames):

- **Remove / clear cascade** (`src/core/relations/save.ts` `removeDataframeDataById`): the slot
  set is `readMainSlots` of the record (was the declared set only) — removing or clearing an
  item strips its frames from an injected slot too. Read under the caller's row lock.
- **Raw export**: the section-wide form, `resolveSectionSlotTipos` (see
  WC-2026-08-09-export-raw-dataframe-own-column, addendum 2026-11-21 M3).
- **Time Machine**: unchanged (`readMainSlots` / `rowSlotTipos` already composed and restored it).
  OPEN (B3-fix review LOW 3): the history LIST's as-of frame view still keys on the DECLARED
  set — `src/core/resolve/read_tm.ts` `snapshotDeclaredSlots` / `snapshotCellEmission` — so a
  main whose only slot is caller-injected keeps the shared emission in its list cell (no as-of
  frame view); `dataframe_slots.ts` `declaringParent` is declared-only too. Stored data is not
  affected: frames carry `from_component_tipo` and are attributed, and bulk revert merges the
  named slots.
- **Read**: unchanged — an injected slot is emitted when the caller names it.
- **Record wipe** (`delete_data`, `src/core/section/record/delete_record.ts`
  `wipeDeclaredSlotsOfMains`): each walked main's slot set is `slotsFromBag` of the locked
  snapshot (the same discovery, in memory) — an injected slot OUTSIDE the section subtree (which
  the walk never empties) loses the wiped main's frames too; one inside the subtree is emptied
  wholesale as before.
- Gate: `test/unit/has_dataframe_literal_native.test.ts` → "CROSS-DOOR, INJECTED" (read with the
  caller's map, raw export column + frame, remove cascade, TM baseline row + restore, declaration
  gate; red before: export column missing, cascade left the injected frame) + "CROSS-DOOR,
  INJECTED — the RECORD WIPE" (a frame of the main in a slot under another section; red before:
  the wipe left it).
