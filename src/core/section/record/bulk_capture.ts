/**
 * THE HISTORY OF ONE COMPONENT SAVE — two lanes (2026-09-28, WC
 * WC-2026-09-27-bulk-revert-undo-log, addendum "two lanes"; the lane law lives
 * in relations/main_lanes.ts, the one writer in relations/dataframe_slots.ts
 * `recordMainHistory`, the pair law in db/time_machine.ts `recordBulkPair`).
 *
 * Every row of a main and of its dataframes is stored under the MAIN's tipo,
 * in one of two kinds of lane: a LANGUAGE lane (lg-spa, lg-ell…) holding only
 * that language's value, and the lg-nolan lane holding the main's lg-nolan
 * value (an unsliced main's WHOLE value — every relation, whatever its
 * ontology flag —, a non-translatable main's value, a transliterable main's
 * base; empty for a translatable sliced main) plus ALL frames of ALL its
 * slots. Two save kinds:
 *   - a MAIN save in lane X writes ONE row in lane X (its value) and an
 *     lg-nolan row ONLY when the save changed the frames (removing an item
 *     strips its frames) or the lg-nolan value; a save of the lg-nolan value
 *     writes the one lg-nolan row;
 *   - a SLOT save (model component_dataframe, with or without a caller pairing)
 *     writes no row under the slot tipo: it writes ONE lg-nolan row of every
 *     main the change belongs to (dataframe_slots.ts `attributeSlotMains`) —
 *     the current lg-nolan value + all frames — whatever the number of
 *     languages. No duplication across languages.
 *
 * TWO LAWS for what gets written:
 *   - under a bulk id (a CSV import, import_execute, propagate, update_cache, a
 *     bulk revert): the undo-log PAIRS, one per lane the save touched — a hidden
 *     BEFORE (tm_role 1) and the ordinary VISIBLE after-row — whatever the
 *     caller's `saveTm` says (decision D1: the opt-out is retired for bulk
 *     runs). A save that changed nothing writes nothing.
 *   - otherwise: the ordinary visible rows, unless the caller opted out
 *     (`saveTm: false` — PHP tm_record::$save_tm).
 *
 * WHAT IS CAPTURED, AND WHEN
 *   - BEFORE is taken under the save's `FOR UPDATE` row lock, and CLONED right
 *     there: the change loop mutates stored items in place (date `time`
 *     recomputation, id stamping), so a reference would record the after-state
 *     as the before-state. A main save reads its slots there too (the cascade
 *     rewrites them later in the save) — every main, an unsliced one included:
 *     its save-before backfill records the frame lane as it stood (T1-21); a
 *     slot save needs only the slot's own image — the rest of the record is
 *     unchanged by it, under the same lock.
 *   - AFTER is RE-READ from the row inside the save's transaction, after every
 *     write of the save — the persisted bytes, whatever branch wrote them.
 *
 * Every write here runs inside the save's transaction (the reads route onto it
 * through the ambient-sql proxy; recordBulkPair joins it), so a rolled-back save
 * leaves no history row at all.
 */

import type { MatrixJsonbColumn } from '../../db/matrix.ts';
import { DedaloError } from '../../errors/dedalo_error.ts';
import {
	historyMainsOf,
	historyStamp,
	type MainIdentity,
	type MainState,
	readKeyImage,
	readMainSlots,
	readMainState,
	recordMainHistory,
	type SlotTarget,
	withSlotImage,
} from '../../relations/dataframe_slots.ts';
import { laneLaw, NOLAN } from '../../relations/main_lanes.ts';

const DATAFRAME_MODEL = 'component_dataframe';

/**
 * A bulk id, or null outside a bulk run. A value that is present but is not a
 * record address (0, a negative, a fraction) is REFUSED, never read as "no
 * run": a dd800 run id is a positive integer, and a caller passing anything
 * else would silently lose the run's undo log.
 */
export function bulkIdOf(value: number | null | undefined): number | null {
	if (value === null || value === undefined) return null;
	if (Number.isInteger(value) && value > 0) return value;
	throw new DedaloError('internal.invariant', {
		message: `bulk capture: bulkProcessId ${String(value)} is not a positive integer run id`,
		coordinates: { bulk_process_id: String(value) },
	});
}

export interface SaveHistoryInput {
	bulkProcessId: number | null | undefined;
	target: SlotTarget;
	column: MatrixJsonbColumn;
	componentTipo: string;
	model: string;
	/** `isLangSlicedModel(model)` — the SAME answer the save sliced with. */
	sliced: boolean;
	/** The ontology `translatable` flag of the saved key (kept for a sliced model only — main_lanes.ts laneLaw). */
	translatable: boolean;
	/** The lang a sliced save cut its slice with (its effective lang). */
	lang: string;
	/** The request lang. */
	requestLang: string;
	userId: number;
	/** The key as read under the lock: `undefined` when absent, else the raw stored value. */
	lockedImage: unknown;
	/** A slot save's caller pairing main (`callerDataframe.main_component_tipo`), else null. */
	callerMain: string | null;
}

/** The history of a MAIN save: its identity (door lane) and its state under the lock. */
interface MainSaveHistory {
	kind: 'main';
	bulkId: number | null;
	target: SlotTarget;
	identity: MainIdentity;
	userId: number;
	before: MainState;
}

/** The history of a SLOT save: the slot's own BEFORE (the rest of the record is untouched by it). */
interface SlotSaveHistory {
	kind: 'slot';
	bulkId: number | null;
	target: SlotTarget;
	slotTipo: string;
	column: MatrixJsonbColumn;
	slotBefore: unknown;
	callerMain: string | null;
	requestLang: string;
	userId: number;
}

export type SaveHistory = MainSaveHistory | SlotSaveHistory;

/**
 * What the save leaves for its history: saveTm, and the ONE instant its rows
 * are stamped from (the change's stamp and its save-before backfill's —
 * dataframe_slots.ts historyStamp).
 */
export interface SaveHistoryDone {
	saveTm: boolean;
	now: Date;
}

/**
 * THE DOOR LANE of a main save (relations/main_lanes.ts): a sliced model's
 * effective lang; lg-nolan for every unsliced one — a relation is never
 * translatable, whatever its ontology flag or the request language (decision
 * 2026-09-29).
 */
function saveDoorLane(input: SaveHistoryInput): string {
	return input.sliced ? input.lang : NOLAN;
}

/**
 * Open the history of a save under its lock (see the header). Clones the locked
 * image before anything can mutate it.
 */
export async function beginSaveHistory(input: SaveHistoryInput): Promise<SaveHistory> {
	const bulkId = bulkIdOf(input.bulkProcessId);
	if (input.model === DATAFRAME_MODEL) {
		return {
			kind: 'slot',
			bulkId,
			target: input.target,
			slotTipo: input.componentTipo,
			column: input.column,
			slotBefore: structuredClone(input.lockedImage),
			callerMain: input.callerMain,
			requestLang: input.requestLang,
			userId: input.userId,
		};
	}
	const identity: MainIdentity = {
		tipo: input.componentTipo,
		model: input.model,
		column: input.column,
		...laneLaw(input.sliced, input.translatable),
		lang: saveDoorLane(input),
	};
	// The BEFORE slots are read for every main, under the lock: a sliced main's
	// language rows need the real BEFORE frames (recordFrameLaneBaseline), and
	// every main's save-before backfill records its frame lane AS IT STOOD —
	// an unsliced main's lg-nolan value composed with its frames
	// (recordMainHistory → recordChangeBackfill).
	const before: MainState = {
		value: structuredClone(input.lockedImage),
		slots: await readMainSlots(input.target, identity.tipo),
	};
	return { kind: 'main', bulkId, target: input.target, identity, userId: input.userId, before };
}

/** Close the history of a save: its pairs, or its visible rows. */
export async function finishSaveHistory(
	history: SaveHistory,
	done: SaveHistoryDone,
): Promise<void> {
	if (history.bulkId === null && !done.saveTm) return;
	if (history.kind === 'main') await finishMainSave(history, done);
	else await finishSlotSave(history, done);
}

async function finishMainSave(history: MainSaveHistory, done: SaveHistoryDone): Promise<void> {
	const { target, identity } = history;
	const after = await readMainState(target, identity, history.before.slots.slots);
	await recordMainHistory(
		target,
		identity,
		{ before: history.before, after },
		historyStamp(history.userId, history.bulkId, done.now),
	);
}

async function finishSlotSave(history: SlotSaveHistory, done: SaveHistoryDone): Promise<void> {
	const slotAfter = await readKeyImage(history.target, history.column, history.slotTipo);
	const mains = await historyMainsOf(history.slotTipo, {
		before: history.slotBefore,
		after: slotAfter,
		callerMain: history.callerMain,
		requestLang: history.requestLang,
	});
	for (const identity of mains) await recordSlotMain(history, identity, done.now);
}

/**
 * One main of a slot save: its (unchanged) value, its slots before/after this
 * slot's write — ONE lg-nolan row (or pair) of the main, the frame lane being
 * the door lane of every slot save (historyMainsOf).
 */
async function recordSlotMain(
	history: SlotSaveHistory,
	identity: MainIdentity,
	now: Date,
): Promise<void> {
	const { target } = history;
	const after = await readMainState(target, identity, [history.slotTipo]);
	const before = {
		value: after.value,
		slots: withSlotImage(after.slots, history.slotTipo, history.slotBefore),
	};
	await recordMainHistory(
		target,
		identity,
		{ before, after },
		historyStamp(history.userId, history.bulkId, now),
	);
}
