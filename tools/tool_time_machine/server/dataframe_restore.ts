/**
 * DATAFRAME-PAIRED TIME-MACHINE RESTORE — the frame half of a component
 * restore (PHP tools/tool_time_machine::apply_value :277-333 →
 * component_dataframe::set_time_machine_data :382).
 *
 * A main component that declares a `component_dataframe` slot does NOT store
 * its frames in its own column: they live in `relation[<slot tipo>]`, paired
 * to INDIVIDUAL main items by `id_key → id` (RELATIONS_SPEC §6.2). A restore
 * that rewrites only the main column therefore leaves the record in a state it
 * was never in — the audit's §5.6 finding on `oh1`: `oh24` (Informants)
 * reverted while `oh115` (Role) kept TODAY's frames, and every frame whose
 * `id_key` no longer matched a live main item became a permanent orphan the
 * UI can neither show nor delete.
 *
 * PHP's sequence, ported here verbatim:
 *   1. for each dataframe slot of the main component, EMPTY the slot
 *      (`empty_full_data_associated_to_main_component` removes every locator
 *      whose `from_component_tipo` is the slot — all main items, all pairings);
 *   2. replay the slot's frames as carried by the TM snapshot;
 *   3. write NO time-machine row for the slot — the main component's fresh row
 *      carries the frames (PHP `tm_record::$save_tm = false` around the slot
 *      save, and `component_common::get_time_machine_data_to_save` :1580
 *      appends every slot's FULL data to the main's snapshot; the TS capture
 *      composes the same way since 2026-09-27 — relations/dataframe_slots.ts).
 * A frame is recognised by the ONE predicate (dataframe_slots.ts
 * `isFrameEntry`, PHP `is_dataframe_entry`), the same one the TM strip
 * (tm_record.ts) partitions with: an entry restores as main data or as a frame,
 * never both and never neither.
 * Steps 1+2 collapse into ONE key write per slot here, SCOPED TO THE MAIN
 * (decision D-A, the rule the preview and the bulk revert already follow): the
 * main's own frames are replaced by the snapshot's, every other main's frames
 * in a SHARED slot stay exactly as they are live, and the key is removed only
 * when nothing is left. A composed row stores the FULL slot (PHP's shape), so
 * replacing the whole key rewound the other main's frames to that moment with
 * no history row of its own — and the preview (read.ts applyTmGraft) showed
 * them live, so Apply wrote something the operator never saw.
 *
 * THE FRAMES OF A ROW RESTORE (two lanes, apply_value): the frame state AS OF
 * the restored row replaces the main's own frames — every frame it recorded
 * comes back, a frame that pairs no item yet included (saved before its item:
 * the save order is the curator's) — except the frame of an item that existed
 * at the row and no longer exists in any language: written back, it would pair
 * nothing (isStaleItemFrame, the law the bulk revert applies too). The legacy
 * bulk path still narrows a lang-sliced key's frames with a FrameSlice (the
 * live frames of SURVIVING sibling-language items stay as they are).
 *
 * WHERE THE FRAMES COME FROM. The TM snapshot of a main component is a FLAT
 * array holding both the main items and the dd490 frame objects. Each frame
 * names its slot in `from_component_tipo`; pre-migration frames may lack it
 * and are claimed by `main_component_tipo` (PHP's dual read).
 *
 * WHY THE SLOT SET IS A UNION (deliberate divergence,
 * WC-2026-08-09-time-machine-restore-replays-paired-dataframe-frames):
 * PHP discovers slots from the main's `request_config` show map alone, which
 * misses a LITERAL main whose frames activate on `has_dataframe` + ontology
 * parentage (the two halves can legitimately disagree — see the
 * `dedalo-relations-ts` dataframe contract). A slot missed at discovery time is
 * never emptied, which is exactly the orphan this module exists to prevent, so
 * discovery unions the ontology children, the own-config ddos (show AND hide)
 * and the slots the snapshot's own frames name (model-checked before they are
 * believed).
 *
 * WHAT IS *NOT* REFUSED (PHP fidelity — the oracle handles it generically).
 * PHP never inspects a frame's `from_component_tipo` on its own: it loops the
 * slots it discovered and, for each, FILTERS the snapshot for frames naming
 * that slot. A frame naming a tipo that is not a live dataframe slot of this
 * main therefore matches no iteration, is written nowhere, and is stripped out
 * of the main data — inert, not lost (the TM row it came from is kept forever;
 * component restores never consume it). An earlier revision of this module
 * aborted such a restore, which broke the Phase-6 contract gate
 * `tool_request.test.ts` "apply_value strips dataframe frames from the restored
 * main data" — a snapshot carrying a stale/foreign frame must still restore.
 * Refusal is reserved for the one case where proceeding CORRUPTS: an
 * unattributable legacy frame with several slots in play.
 *
 * A SNAPSHOT WITH NO FRAME is not refused (decision 2026-09-28): every
 * supported row of a main is composed (PHP-era rows always carried the main +
 * all its frames; TS-era beta rows are unsupported), so its silence MEANS "no
 * frames at that time" and the plan empties the main's own frames.
 */

import { canonicalJson } from '../../../src/core/concepts/canonical_json.ts';
import type { MatrixJsonbColumn } from '../../../src/core/db/matrix.ts';
import { absorbComponentItemIds } from '../../../src/core/db/matrix_write.ts';
import { readOtherLangItemIds, type TmCoords } from '../../../src/core/db/time_machine.ts';
import { getColumnNameByModel, getModelByTipo } from '../../../src/core/ontology/resolver.ts';
import {
	heldItemIds,
	isOwnFrame,
	isStaleItemFrame,
	resolveDataframeSlotTipos,
	restoreSlot,
	splitComposed,
} from '../../../src/core/relations/dataframe_slots.ts';
import {
	persistRecordKeys,
	type RecordWriteTarget,
} from '../../../src/core/section_record/index.ts';
import { readComponentItems } from './restore_common.ts';

/** One slot's restored content: `frames` empty ⇒ the key is removed (the wipe). */
export interface DataframeSlotRestore {
	slotTipo: string;
	frames: Record<string, unknown>[];
}

/**
 * A lang-sliced restore's item scope (see the header): the ids of the live
 * items that SURVIVE the merge beside the restored ones (another language's) —
 * their frames stay live — and the pairing law's inputs (isStaleItemFrame):
 * the other languages' items the history knew, and every item the merged value
 * holds. `null` everywhere = the whole main is restored.
 */
export interface FrameSlice {
	survivorIds: ReadonlySet<string>;
	otherLangIds: ReadonlySet<string>;
	heldIds: ReadonlySet<string>;
}

/**
 * The FrameSlice of a lang merge: `restored` came from the snapshot, `merged` is
 * what is written, `otherLangIds` the other languages' items the history knew
 * (time_machine.ts readOtherLangItemIds — the whole history, minus the items it
 * proves absent at the restored row: frame-first).
 */
export function frameSliceOf(
	restored: readonly unknown[],
	merged: unknown,
	otherLangIds: ReadonlySet<string> = new Set(),
): FrameSlice {
	const heldIds = heldItemIds(merged);
	const survivorIds = new Set(heldIds);
	for (const id of heldItemIds(restored)) survivorIds.delete(id);
	return { survivorIds, otherLangIds, heldIds };
}

/**
 * The FrameSlice of a frames-only restore (isFramesOnlyImage): no survivor
 * (every own frame comes from the row), and a frame whose item the history knew
 * at `rowId` but the LIVE main no longer holds is never written back — that
 * item was deleted since (isStaleItemFrame); a frame-first frame comes back.
 */
export async function framesOnlySlice(
	coords: TmCoords,
	rowId: number,
	live: unknown,
): Promise<FrameSlice> {
	return {
		survivorIds: new Set(),
		otherLangIds: await readOtherLangItemIds(coords, [], rowId),
		heldIds: heldItemIds(live),
	};
}

/** A frame's `id_key` as the pairing string (null when it names none). */
function idKeyOf(frame: Record<string, unknown>): string | null {
	const key = frame.id_key;
	return typeof key === 'number' || (typeof key === 'string' && key !== '') ? String(key) : null;
}

/** Thrown when a snapshot frame cannot be attributed to a dataframe slot. */
export class DataframeRestoreError extends Error {}

/**
 * The dataframe slot tipos of a main component — ONE definition, in core
 * (relations/dataframe_slots.ts: ontology children ∪ own-config show/hide ddos,
 * model-checked), shared with the composed time-machine capture so the slot set
 * a row was composed over and the one a restore empties cannot drift apart.
 */
export { resolveDataframeSlotTipos };

/**
 * Partition a main component's TM snapshot into the frame set of each slot.
 *
 * - SCOPED TO THE MAIN: a frame naming ANOTHER `main_component_tipo` is that
 *   main's history (a composed row carries the full shared slot) and is left
 *   out — it is kept live by the apply (restoreSlot), never rewound;
 * - a frame naming `from_component_tipo` is claimed by that slot; the slot is
 *   ADDED to the plan when discovery missed it (the snapshot is authoritative
 *   about which slots carried frames) but only after the model check. A tipo
 *   that is NOT a `component_dataframe` names no slot of this main, so the
 *   frame is inert — PHP's per-slot filter never matches it either (see the
 *   header: refusing here broke a real contract gate);
 * - a legacy frame with no `from_component_tipo` is claimed when it is the
 *   main's own (isOwnFrame: names this main, or no main — the same predicate
 *   restoreSlot and the preview use) — PHP hands it to the slot it is
 *   currently looping over. With exactly one slot the behaviour is identical;
 *   with NONE, PHP's loop never runs and the frame is inert (matched here);
 *   with SEVERAL, PHP duplicates it into every slot, so the entry is
 *   unattributable and this refuses instead of guessing (duplicating a frame
 *   across slots is the corruption, not a fix). Legacy frames are attributed
 *   only after the whole snapshot is scanned, so a slot that only a
 *   `from_component_tipo` frame revealed still counts as "in play";
 * - discovered slots absent from the snapshot get an EMPTY frame list, which
 *   is what empties them (the snapshot recorded "no frames" there).
 */
export async function planDataframeRestore(
	mainTipo: string,
	snapshot: unknown,
	discoveredSlots: readonly string[],
): Promise<DataframeSlotRestore[]> {
	const plan = new Map<string, Record<string, unknown>[]>();
	for (const slotTipo of discoveredSlots) plan.set(slotTipo, []);
	const legacyFrames: Record<string, unknown>[] = [];
	// splitComposed: the ONE partition (a v6 literal's wrapped frame included).
	for (const entry of splitComposed(snapshot).frames) {
		if (!isOwnFrame(entry, mainTipo)) continue;
		const from = entry.from_component_tipo;
		if (typeof from === 'string' && from !== '') {
			if (!plan.has(from)) {
				// Not a dataframe slot ⇒ names nothing this main can restore into.
				if ((await getModelByTipo(from)) !== 'component_dataframe') continue;
				plan.set(from, []);
			}
			plan.get(from)?.push(entry);
			continue;
		}
		// Legacy frame (pre-migration): already claimed by isOwnFrame above —
		// main === mainTipo OR unstamped, the predicate restoreSlot removes the
		// live copy by and the preview shows it by. A stricter test here dropped
		// an unstamped frame the row recorded while restoreSlot deleted it live.
		legacyFrames.push(entry);
	}

	if (legacyFrames.length > 0) {
		const slots = [...plan.keys()];
		if (slots.length > 1) {
			throw new DataframeRestoreError(
				`time-machine snapshot of '${mainTipo}' carries a legacy frame with no from_component_tipo while ${slots.length} dataframe slots are in play (${slots.join(', ')}); it cannot be attributed to one slot`,
			);
		}
		// slots.length === 0 ⇒ PHP's per-slot loop never runs: the frame is inert.
		if (slots.length === 1) {
			for (const entry of legacyFrames) plan.get(slots[0] as string)?.push(entry);
		}
	}
	return [...plan].map(([slotTipo, frames]) => ({ slotTipo, frames }));
}

/** One slot write the plan resolves to: `next` null removes the key. */
interface SlotWrite {
	slotTipo: string;
	next: unknown[] | null;
	written: readonly unknown[];
}

/**
 * The slot writes a plan resolves to over the LIVE slots (read in the ambient
 * transaction — under the caller's row lock, the locked state): each slot's
 * content with the main's frames replaced (restoreSlot; `slice` keeps the
 * surviving sibling-language items' frames live, see FrameSlice). Only slots whose content
 * CHANGES are returned, an empty result removing the key — so an empty list
 * means the plan is already applied.
 */
async function plannedSlotWrites(
	target: RecordWriteTarget,
	mainTipo: string,
	plan: readonly DataframeSlotRestore[],
	slice: FrameSlice | null,
): Promise<SlotWrite[]> {
	const column = getColumnNameByModel('component_dataframe');
	if (column === null) {
		throw new DataframeRestoreError('no matrix column for model component_dataframe');
	}
	// A frame of an other-language item deleted since is never written back
	// (the pairing law, shared with the bulk revert).
	const stale = (frame: Record<string, unknown>) =>
		slice !== null && isStaleItemFrame(frame, slice.otherLangIds, slice.heldIds);
	const writes: SlotWrite[] = [];
	for (const { slotTipo, frames } of plan) {
		const live = await readComponentItems(
			target.table,
			target.sectionTipo,
			target.sectionId,
			column,
			slotTipo,
		);
		const keep = (frame: Record<string, unknown>) => keepsLiveFrame(frame, slice);
		const recorded = frames.filter((frame) => !keep(frame) && !stale(frame));
		const next = restoreSlot(live, mainTipo, recorded, keep);
		if (canonicalJson(next) === canonicalJson(live)) continue; // [] ≡ absent: nothing changes
		// Same entries, reordered only (restoreSlot moves `recorded` to the first own frame): frame
		// order is not state (frameStateKey), so live positions stay and the restore is a no-op.
		if (Array.isArray(live) && sameEntries(next, live)) continue;
		writes.push({ slotTipo, next: next.length > 0 ? next : null, written: recorded });
	}
	return writes;
}

/** Order-free equality of two slot contents. */
function sameEntries(left: readonly unknown[], right: readonly unknown[]): boolean {
	const key = (entries: readonly unknown[]) => canonicalJson(entries.map(canonicalJson).sort());
	return left.length === right.length && key(left) === key(right);
}

/**
 * Whether a restore under `slice` KEEPS this frame live (it pairs with a
 * surviving item — FrameSlice.survivorIds): the one scope rule shared by the
 * write (plannedSlotWrites) and the bulk revert's conflict check, so what is
 * exempt from the check is exactly what the write leaves untouched.
 */
export function keepsLiveFrame(frame: Record<string, unknown>, slice: FrameSlice | null): boolean {
	return slice !== null && pairsWith(frame, slice.survivorIds);
}

/** Whether a frame's `id_key` names one of `ids`. */
function pairsWith(frame: Record<string, unknown>, ids: ReadonlySet<string>): boolean {
	const key = idKeyOf(frame);
	return key !== null && ids.has(key);
}

/**
 * Whether applying the plan would change NOTHING (every slot already holds
 * what the restore writes). A plan is never "empty" for a main that declares a
 * slot — the plan names every slot, frames or not — so a caller asking "is
 * this key already restored?" must ask this, not the plan's length.
 */
export async function framePlanIsNoop(
	target: RecordWriteTarget,
	mainTipo: string,
	plan: readonly DataframeSlotRestore[],
	slice: FrameSlice | null = null,
): Promise<boolean> {
	if (plan.length === 0) return true;
	return (await plannedSlotWrites(target, mainTipo, plan, slice)).length === 0;
}

/**
 * Write the planned frame sets. MUST run inside the caller's transaction,
 * behind its row lock, and BEFORE the main component write (PHP restores the
 * frames first). Scoped to `mainTipo` (see the header): other mains' frames of
 * a shared slot stay in place; `slice` narrows a lang-sliced restore to the
 * restored items' frames.
 *
 * `audit` is false on purpose: the main write that follows carries the record's
 * dd197/dd201 modified stamps for the whole restore, exactly as PHP's main
 * `save()` does after the slot saves. No TM row is written for a slot (PHP
 * `$save_tm = false`) — the main's fresh row carries the frames. `actor` is the
 * restoring principal: a slot write is a key write like any other, so an
 * observer of the slot recomputes (the chokepoint's ledger) as that actor.
 *
 * `authorizeSlot` is THE WRITE DOOR of each slot (cross-write:r2): REQUIRED,
 * asked for every slot this call actually WRITES (a slot the plan leaves as it
 * is is never asked — a read-only slot the restore does not touch refuses
 * nothing), before ANY slot is written, so a refusal leaves every slot as it
 * was and rolls back with the caller's transaction. A slot is a component with
 * its own (section, tipo) grant: the main's grant never stands for it.
 */
export async function applyDataframeRestore(
	target: RecordWriteTarget,
	mainTipo: string,
	plan: readonly DataframeSlotRestore[],
	slice: FrameSlice | null,
	actor: number,
	authorizeSlot: (slotTipo: string) => Promise<void>,
): Promise<void> {
	if (plan.length === 0) return;
	const column = getColumnNameByModel('component_dataframe') as MatrixJsonbColumn;
	const writes = await plannedSlotWrites(target, mainTipo, plan, slice);
	for (const { slotTipo } of writes) await authorizeSlot(slotTipo);
	for (const { slotTipo, next, written } of writes) {
		// null REMOVES the key (PHP's emptied slot), never '[]'.
		await persistRecordKeys(target, [{ column, key: slotTipo, value: next }], false, { actor });
		// The restored frames carry explicit ids; raise the slot's counter so a
		// later insert cannot mint a duplicate (PHP raises on every set_data).
		// A duplicate id here would break the id_key pairing itself.
		await absorbComponentItemIds(
			target.table,
			target.sectionTipo,
			target.sectionId,
			slotTipo,
			written,
		);
	}
}
