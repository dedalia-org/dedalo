/**
 * BULK REVERT — a COMPOSED unit: one dataframe main (every lane of it) and its
 * frames, restored together (2026-09-28, WC-…-bulk-revert-undo-log, addendum
 * "two lanes").
 *
 * The capture records a main in TWO kinds of lane (relations/main_lanes.ts):
 * a LANGUAGE lane's pair holds that language's region only; the lg-nolan
 * lane's pair holds the lg-nolan region (an unsliced or non-translatable
 * main's value, a transliterable main's base, nothing for a translatable
 * sliced main) followed by the
 * FULL frames of every slot. This module undoes a unit in ONE transaction,
 * under the record's row lock, PER LANE:
 *
 *   1. SPLIT every pair (splitComposed) into its MAIN part and its FRAMES — the
 *      frames SCOPED TO THIS MAIN (decision D-A): only the frames whose
 *      `main_component_tipo` is the main, plus unstamped legacy frames. A slot
 *      SHARED with another main stores both mains' frames, but the other
 *      main's frames are that main's history: never checked nor restored here.
 *   2. ONE CHAIN PER LANE (the pairs of one lang tag, id order — an UNSLICED
 *      main has ONE lane, lg-nolan, whatever a pair's tag: main_lanes.ts
 *      laneLaw, decision 2026-09-29), undone newest
 *      lane first — a lang-less orphan belongs to every sliced lane's region,
 *      and the capture cut the lanes sequentially, so they are undone in
 *      reverse (LIFO). A language lane's state is its region; the lg-nolan
 *      lane's state is its region AND this main's frames.
 *   3. UNCHANGED: a lane whose live state already equals its earliest BEFORE
 *      needs nothing (counted `unchanged`).
 *   4. CHAIN / CONFLICT: each BEFORE equals the previous AFTER (else
 *      `interleaved_write`); the live state equals the LAST after (else
 *      `changed_since_run`). Either refuses the WHOLE unit.
 *   5. THE PAIRING LAW (dataframe_slots.ts isStaleItemFrame): a frame the
 *      revert puts back must not pair an item of a lane the unit does not
 *      restore that the history knew and the value left behind no longer holds
 *      — it would be an orphan: refused `changed_since_run`. The same the
 *      other way (assertNoOrphanedFrames): when the unit leaves the frames
 *      alone, a live frame added after the run must not be left pairing an
 *      item the revert removes.
 *   6. WRITE (bulk_revert_undo.ts writeComposedUnit — the revert's one write
 *      door), one `persistRestoredKeys`: the main key, and every slot whose
 *      content changes — the other mains' frames kept in place, this main's
 *      recorded frames put back (restoreSlot); a slot left empty is REMOVED.
 *      Then relation_search and the item-id counters of every written key,
 *      then the revert's OWN pairs under its bulk id, per lane — so reverting
 *      the revert chains exactly.
 *
 * THE VALUE GATES (C58, owner ruling 2026-11-18 — bulk_revert_undo.ts header):
 * the write door gates every lane of the main this unit restores, and every
 * slot. The plan follows it: a lane whose live value already equals its
 * earliest BEFORE as recorded OR as the write stores it (judgeReplayedValue)
 * is unchanged — a lane an earlier revert put back cleaned is not a post-run
 * change. The frames are judged as recorded (no gate keys on a dataframe).
 *
 * ABSENCE OF THE MAIN beside frames. A frame-lane image with frames cannot
 * tell an absent lg-nolan value from an empty `[]` one (both compose to the
 * frames alone); the main part of such an image is read as ABSENT, and an
 * empty main (absent or `[]`) compares equal to an empty main — a restore of
 * an "empty" main over an empty live key leaves the live key as it is.
 */

import { canonicalJson } from '../../../src/core/concepts/canonical_json.ts';
import type { MatrixJsonbColumn } from '../../../src/core/db/matrix.ts';
import { readFrameStateRowAt, readOtherLangItemIds } from '../../../src/core/db/time_machine.ts';
import { getColumnNameByModel } from '../../../src/core/ontology/resolver.ts';
import {
	heldItemIds,
	isFrameEntry,
	isOwnFrame,
	isStaleItemFrame,
	readMainSlots,
	restoreSlot,
	type SlotImages,
	type SlotTarget,
	splitComposed,
} from '../../../src/core/relations/dataframe_slots.ts';
import {
	type LaneLaw,
	laneRegion,
	NOLAN,
	restoreLane,
} from '../../../src/core/relations/main_lanes.ts';
import { judgeReplayedValue } from '../../../src/core/section/record/write_value_gates.ts';
import {
	describeKey,
	type RevertKey,
	RevertRefusal,
	type RevertUnit,
	unitReportKey,
} from './bulk_revert_plan.ts';
import {
	asItems,
	type ComposedKeyWrite,
	image,
	keyLaneLaw,
	lockUnitRecord,
	type ProducedKey,
	type ProducedStart,
	rawKeyValue,
	resolveKeyTarget,
	rowPairsOf,
	type UnitContext,
	type UnitResult,
	type WrittenKey,
	writeComposedUnit,
} from './bulk_revert_undo.ts';

const DATAFRAME_MODEL = 'component_dataframe';

/** This main's frames of one image, per slot tipo (only non-empty slots). */
type FrameMap = Record<string, Record<string, unknown>[]>;

/** One side of a pair, split. */
interface Split {
	main: unknown;
	frames: FrameMap;
}

/** One pair of the unit, split, with its language and its after-row id. */
interface SplitPair {
	lang: string;
	id: number;
	before: Split;
	after: Split;
}

/** One lane's chain of pairs. */
interface LaneGroup {
	lang: string;
	pairs: SplitPair[];
}

/** What the unit is reverted against: the main, its lane law, and the slots it may write. */
interface ComposedScope {
	key: RevertKey;
	report: RevertKey;
	mainTipo: string;
	law: LaneLaw;
	slotTipos: readonly string[];
	target: SlotTarget;
	column: MatrixJsonbColumn;
}

/** The slot a recorded frame restores into: its `from_component_tipo`, else the unit's only slot. */
function slotOfFrame(frame: Record<string, unknown>, scope: ComposedScope): string {
	const from = frame.from_component_tipo;
	if (typeof from === 'string' && from !== '') return from;
	if (scope.slotTipos.length === 1) return scope.slotTipos[0] as string;
	throw new RevertRefusal(
		'failed',
		scope.report,
		`${describeKey(scope.key)}: a recorded frame names no slot while ${scope.slotTipos.length} slots are in play`,
	);
}

/** Group this main's recorded frames by slot. */
function recordedFrameMap(
	frames: readonly Record<string, unknown>[],
	scope: ComposedScope,
): FrameMap {
	const map: FrameMap = {};
	for (const frame of frames) {
		if (!isOwnFrame(frame, scope.mainTipo)) continue;
		const slot = slotOfFrame(frame, scope);
		map[slot] = [...(map[slot] ?? []), frame];
	}
	return map;
}

/** This main's LIVE frames, per slot (by the key they are stored under). */
function liveFrameMap(slots: SlotImages, mainTipo: string): FrameMap {
	const map: FrameMap = {};
	for (const slot of slots.slots) {
		const own = asItems(slots.images[slot]).filter(
			(entry): entry is Record<string, unknown> =>
				isFrameEntry(entry) && isOwnFrame(entry, mainTipo),
		);
		if (own.length > 0) map[slot] = own;
	}
	return map;
}

/** Split one stored composed image (see the header on the main's absence). */
function splitImage(stored: unknown, scope: ComposedScope): Split {
	const { main, frames } = splitComposed(stored);
	const withFrames = frames.length > 0;
	const emptyMain = Array.isArray(main) && main.length === 0;
	return {
		main: withFrames && emptyMain ? undefined : main,
		frames: recordedFrameMap(frames, scope),
	};
}

/** An empty main (absent, JSON null, `[]`). */
function isEmptyMain(value: unknown): boolean {
	return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
}

/** Main-part equality, an empty main equal to an empty main (see the header). */
function sameMain(left: unknown, right: unknown): boolean {
	if (isEmptyMain(left) && isEmptyMain(right)) return true;
	return canonicalJson(left) === canonicalJson(right);
}

/** Slot equality as slotWrite decides it: an empty slot stays as it is (absent or `[]`). */
function sameSlot(live: unknown, produced: unknown): boolean {
	if (asItems(live).length === 0 && asItems(produced).length === 0) return true;
	return canonicalJson(live) === canonicalJson(produced);
}

/** Frame-map equality. */
function sameFrames(left: FrameMap, right: FrameMap): boolean {
	return canonicalJson(left) === canonicalJson(right);
}

/** Every pair of the unit, split, id order (all its lanes together). */
function splitPairs(unit: RevertUnit, scope: ComposedScope): SplitPair[] {
	const rows = unit.keys.flatMap((key) => key.rows).sort((a, b) => a.id - b.id);
	return rowPairsOf(scope.report, rows).map((pair) => ({
		lang: pair.before.lang ?? '',
		id: pair.after.id,
		before: splitImage(image(pair.before), scope),
		after: splitImage(image(pair.after), scope),
	}));
}

/**
 * The unit's lane chains, newest first (LIFO — see the header). An untagged
 * pair is lg-nolan's; so is every pair of an UNSLICED main (its one lane).
 */
function laneGroups(pairs: readonly SplitPair[], law: LaneLaw): LaneGroup[] {
	const groups = new Map<string, LaneGroup>();
	for (const pair of pairs) {
		const lang = pair.lang === '' || !law.sliced ? NOLAN : pair.lang;
		const group = groups.get(lang) ?? { lang, pairs: [] };
		group.pairs.push(pair);
		groups.set(lang, group);
	}
	const newest = (group: LaneGroup): number => group.pairs.at(-1)?.id ?? 0;
	return [...groups.values()].sort((a, b) => newest(b) - newest(a));
}

/** Refuse a chain whose pair does not start where the previous one ended. */
function assertChain(
	pairs: readonly SplitPair[],
	same: (after: Split, before: Split) => boolean,
	scope: ComposedScope,
	what: string,
): void {
	for (let index = 1; index < pairs.length; index += 1) {
		const previous = pairs[index - 1] as SplitPair;
		const current = pairs[index] as SplitPair;
		if (!same(previous.after, current.before)) {
			throw new RevertRefusal(
				'interleaved_write',
				scope.report,
				`${describeKey(scope.key)}: ${what} of pair ${index} does not start where pair ${index - 1} ended`,
			);
		}
	}
}

/** One PART of a lane's chain: its value region, or — the lg-nolan lane — this main's frames. */
interface LanePart {
	what: string;
	live: unknown;
	side: (split: Split) => unknown;
	same: (left: unknown, right: unknown) => boolean;
	/**
	 * The part's earliest BEFORE as the WRITE stores it (the value gates), when
	 * that can differ from the recorded image: live equal to it is unchanged too.
	 */
	asWritten?: unknown;
}

/**
 * Plan one part of a lane (see the header, steps 3-4): `false` when the live
 * part already equals its earliest BEFORE (nothing to write), `true` when it
 * must be restored; refuses a broken chain or a post-run change. The value and
 * the frames of the lg-nolan lane are planned apart — two disjoint regions, so
 * a curator who put one of them back by hand does not refuse the other.
 */
function planPart(part: LanePart, pairs: readonly SplitPair[], scope: ComposedScope): boolean {
	const first = pairs[0] as SplitPair;
	if (part.same(part.live, part.side(first.before))) return false;
	if ('asWritten' in part && part.same(part.live, part.asWritten)) return false;
	assertChain(
		pairs,
		(after, before) => part.same(part.side(after), part.side(before)),
		scope,
		part.what,
	);
	if (!part.same(part.live, part.side((pairs.at(-1) as SplitPair).after))) {
		throw new RevertRefusal(
			'changed_since_run',
			scope.report,
			`${describeKey(scope.key)}: ${part.what} changed after the run`,
		);
	}
	return true;
}

/** The plan of the whole unit: the value it leaves, the frames it restores (null = untouched). */
interface UnitPlan {
	value: unknown;
	frames: FrameMap | null;
	/** The lanes the unit restores a value of. */
	valueLanes: string[];
	unchanged: number;
	/** The revert's own door lane: the newest lane it writes, a value lane when it restores a value. */
	lang: string;
}

/**
 * Plan ONE lane over the value the previous (newer) lane left: its value part
 * and — the lg-nolan lane — its frames part, each unchanged, refused, or
 * restored to its earliest BEFORE (see the header). A lane with nothing to
 * write counts `unchanged`.
 */
async function planLane(
	plan: UnitPlan,
	group: LaneGroup,
	liveFrames: FrameMap,
	scope: ComposedScope,
): Promise<void> {
	const { lang, pairs } = group;
	const first = pairs[0] as SplitPair;
	const valueLive = laneRegion(plan.value, lang, scope.law);
	const value = planPart(
		{
			what: `lane ${lang}`,
			live: valueLive,
			side: (split) => split.main,
			same: sameMain,
			asWritten: await asWrittenMain(first.before.main, scope),
		},
		pairs,
		scope,
	);
	const frames =
		lang === NOLAN &&
		planPart(
			{
				what: 'the frames',
				live: liveFrames,
				side: (split) => split.frames,
				same: (left, right) => sameFrames(left as FrameMap, right as FrameMap),
			},
			pairs,
			scope,
		);
	if (!value && !frames) {
		plan.unchanged += 1;
		return;
	}
	if (frames) plan.frames = first.before.frames;
	if (value) {
		plan.value = restoreMain(plan.value, lang, first.before.main, scope.law);
		plan.valueLanes.push(lang);
	}
	// The door lane is a VALUE lane whenever the unit restores a value (the
	// frame lane may be the newest): the revert's own pairs lead with it.
	if (plan.lang === '' || (value && plan.lang === NOLAN)) plan.lang = lang;
}

/** Plan every lane, newest first. */
async function planUnit(
	live: unknown,
	liveFrames: FrameMap,
	groups: readonly LaneGroup[],
	scope: ComposedScope,
): Promise<UnitPlan> {
	const plan: UnitPlan = { value: live, frames: null, valueLanes: [], unchanged: 0, lang: '' };
	for (const group of groups) await planLane(plan, group, liveFrames, scope);
	return plan;
}

/** A recorded main part as the write stores it (the value gates; a refused value judged as recorded). */
function asWrittenMain(recorded: unknown, scope: ComposedScope): Promise<unknown> {
	return judgeReplayedValue(scope.key.model, scope.mainTipo, recorded);
}

/** Put a recorded lane region back over the current value (see the header on empty mains). */
function restoreMain(current: unknown, lane: string, recorded: unknown, law: LaneLaw): unknown {
	if (law.sliced)
		return restoreLane(current, lane, isEmptyMain(recorded) ? undefined : recorded, law);
	if (isEmptyMain(recorded) && isEmptyMain(current)) return current;
	return restoreLane(current, lane, recorded, law);
}

/**
 * The items the history knew in the lanes the unit does NOT restore (the
 * pairing law's input, dataframe_slots.ts isStaleItemFrame), read from the
 * WHOLE visible history (time_machine.ts readOtherLangItemIds, unbounded: an
 * item deleted at any point since is a change a refusal reports, never loses).
 * An unsliced main has ONE lane (lg-nolan, every item, whatever its `lang`
 * stamp): the set is empty.
 */
function otherLaneItemIds(plan: UnitPlan, scope: ComposedScope): Promise<Set<string>> {
	return readOtherLangItemIds(
		{
			sectionTipo: scope.key.sectionTipo,
			sectionId: scope.key.sectionId,
			componentTipo: scope.mainTipo,
		},
		[...plan.valueLanes, NOLAN],
		null,
		!scope.law.sliced,
	);
}

/**
 * THE PAIRING LAW OF THE WRITE (see the header, step 5): a recorded frame the
 * revert puts back that is not already live must not name an item of another
 * lane the history knew and the value the unit leaves no longer holds.
 * Refused as `changed_since_run`. A frame whose key named no known item was
 * saved before its item (frame-first — a restorable pre-run state) and is put
 * back as recorded.
 */
function assertFramesPair(
	recorded: FrameMap,
	live: FrameMap,
	mainValue: unknown,
	otherLangIds: ReadonlySet<string>,
	scope: ComposedScope,
): void {
	const held = heldItemIds(mainValue);
	const liveFrames = new Set(Object.values(live).flat().map(canonicalJson));
	for (const frame of Object.values(recorded).flat()) {
		if (liveFrames.has(canonicalJson(frame))) continue;
		if (!isStaleItemFrame(frame, otherLangIds, held)) continue;
		throw new RevertRefusal(
			'changed_since_run',
			scope.report,
			`${describeKey(scope.key)}: a recorded frame pairs with main item ${String(frame.id_key)}, which the main no longer holds (its frames cannot be put back)`,
		);
	}
}

/**
 * THE ORPHAN GUARD of a unit that leaves the frames alone (no lg-nolan pair in
 * the run, or the frame lane already back): a lane restore that REMOVES an
 * item from every language must not leave a live frame of this main pairing
 * it — the save path strips such a frame, and a revert must not leave a state
 * no save can produce. A frame that already stood in the frame state before
 * the run (saved before its item — frame-first) IS the pre-run state and stays;
 * any other (added after the run) is a post-run change: `changed_since_run`.
 */
async function assertNoOrphanedFrames(
	plan: UnitPlan,
	live: unknown,
	liveFrames: FrameMap,
	unit: RevertUnit,
	scope: ComposedScope,
): Promise<void> {
	if (plan.frames !== null) return;
	const kept = heldItemIds(plan.value);
	const removed = [...heldItemIds(live)].filter((id) => !kept.has(id));
	const orphaned = Object.values(liveFrames)
		.flat()
		.filter((frame) => removed.includes(String(frame.id_key)));
	if (orphaned.length === 0) return;
	const firstRowId = Math.min(...unit.keys.flatMap((key) => key.rows.map((row) => row.id)));
	const coords = {
		sectionTipo: scope.key.sectionTipo,
		sectionId: scope.key.sectionId,
		componentTipo: scope.mainTipo,
	};
	const preRun = await readFrameStateRowAt(coords, firstRowId - 1);
	const preRunFrames = new Set(splitComposed(preRun?.data ?? []).frames.map(canonicalJson));
	const added = orphaned.find((frame) => !preRunFrames.has(canonicalJson(frame)));
	if (added === undefined) return;
	throw new RevertRefusal(
		'changed_since_run',
		scope.report,
		`${describeKey(scope.key)}: a frame added after the run pairs main item ${String(added.id_key)}, which the revert removes`,
	);
}

/** The slot writes of the recorded frames (only slots whose content changes). */
function slotWrites(
	liveSlots: SlotImages,
	recorded: FrameMap,
	scope: ComposedScope,
	slotColumn: MatrixJsonbColumn,
): ComposedKeyWrite[] {
	const tipos = [
		...liveSlots.slots,
		...Object.keys(recorded).filter((t) => !liveSlots.slots.includes(t)),
	];
	const writes: ComposedKeyWrite[] = [];
	for (const tipo of tipos) {
		const write = slotWrite(liveSlots.images[tipo], tipo, recorded, scope, slotColumn);
		if (write !== null) writes.push(write);
	}
	return writes;
}

/** One slot's write (null when its content does not change), refused outside the gated slot set. */
function slotWrite(
	live: unknown,
	tipo: string,
	recorded: FrameMap,
	scope: ComposedScope,
	slotColumn: MatrixJsonbColumn,
): ComposedKeyWrite | null {
	const next = restoreSlot(live, scope.mainTipo, recorded[tipo] ?? []);
	if (next.length === 0 && asItems(live).length === 0) return null; // empty stays as it is
	if (canonicalJson(next) === canonicalJson(live)) return null;
	if (!scope.slotTipos.includes(tipo)) {
		throw new RevertRefusal(
			'failed',
			scope.report,
			`${describeKey(scope.key)}: slot ${tipo} is outside the unit's gated slot set`,
		);
	}
	return { tipo, column: slotColumn, before: live, after: next.length > 0 ? next : undefined };
}

/** The dataframe column, refused loudly when unmapped. */
function dataframeColumn(scope: ComposedScope): MatrixJsonbColumn {
	const column = getColumnNameByModel(DATAFRAME_MODEL);
	if (column === null) {
		throw new RevertRefusal('no_column', scope.report, 'no matrix column for component_dataframe');
	}
	return column as MatrixJsonbColumn;
}

/** The unit's scope: its main key, lane law, report key, gated slots and where it is stored. */
async function composedScope(unit: RevertUnit): Promise<ComposedScope> {
	const key = unit.keys[0] as RevertKey;
	const target = await resolveKeyTarget(key);
	return {
		key,
		report: unitReportKey(unit),
		mainTipo: key.tipo,
		law: await keyLaneLaw(key),
		slotTipos: unit.slotTipos,
		target: { table: target.table, sectionTipo: key.sectionTipo, sectionId: key.sectionId },
		column: target.column,
	};
}

/** A written key as the post-commit activity row and the report see it. */
function writtenOf(write: ComposedKeyWrite, scope: ComposedScope): WrittenKey {
	const isMain = write.tipo === scope.mainTipo;
	const key: RevertKey = isMain
		? scope.report
		: { ...scope.report, tipo: write.tipo, model: DATAFRAME_MODEL, rows: [] };
	return {
		key,
		table: scope.target.table,
		inexact: null,
	};
}

/**
 * What a COMPOSED unit LEAVES on a record, placed over `start`
 * (bulk_revert_undo.ts exactUnitProduces is the non-composed twin;
 * bulk_revert_records.ts producedStateOf the consumer) — the same internals as
 * revertComposedUnit: each lane's earliest BEFORE, newest lane first
 * (restoreMain), and — the lg-nolan lane — this main's recorded frames in
 * every slot (restoreSlot, an emptied slot absent), exactly as slotWrites
 * does. Live values equal to this are, by construction, what planUnit finds
 * unchanged. null when the unit cannot be planned at all (no column, a
 * malformed log): undecided for the caller. `asWritten`: each restored main
 * part as the write stores it (the value gates), `false` = as recorded — the
 * judgement asks both.
 */
export async function composedUnitProduces(
	unit: RevertUnit,
	start: ProducedStart,
	asWritten: boolean,
): Promise<ProducedKey[] | null> {
	let scope: ComposedScope;
	let groups: LaneGroup[];
	let slotColumn: MatrixJsonbColumn;
	try {
		scope = await composedScope(unit);
		groups = laneGroups(splitPairs(unit, scope), scope.law);
		slotColumn = dataframeColumn(scope);
	} catch (error) {
		if (error instanceof RevertRefusal) return null;
		throw error;
	}
	let main = await start(scope.column, scope.mainTipo);
	let frames: FrameMap | null = null;
	for (const group of groups) {
		const first = group.pairs[0] as SplitPair;
		const recorded = asWritten ? await asWrittenMain(first.before.main, scope) : first.before.main;
		main = restoreMain(main, group.lang, recorded, scope.law);
		if (group.lang === NOLAN) frames = first.before.frames;
	}
	const produced: ProducedKey[] = [
		{ column: scope.column, tipo: scope.mainTipo, value: main, same: sameMain },
	];
	if (frames !== null) {
		const recorded = frames;
		const tipos = [
			...scope.slotTipos,
			...Object.keys(recorded).filter((tipo) => !scope.slotTipos.includes(tipo)),
		];
		for (const tipo of tipos) {
			const next = restoreSlot(await start(slotColumn, tipo), scope.mainTipo, recorded[tipo] ?? []);
			produced.push({
				column: slotColumn,
				tipo,
				value: next.length > 0 ? next : undefined,
				same: sameSlot,
			});
		}
	}
	return produced;
}

/**
 * Revert one COMPOSED unit (see the header), inside the caller's transaction.
 * Throws RevertRefusal on any refusal (the caller rolls the unit back).
 */
export async function revertComposedUnit(
	unit: RevertUnit,
	context: UnitContext,
): Promise<UnitResult> {
	const scope = await composedScope(unit);
	const keyTarget = { table: scope.target.table, column: scope.column };
	const record = await lockUnitRecord(scope.key, keyTarget, context, scope.report);
	const groups = laneGroups(splitPairs(unit, scope), scope.law);
	// Nothing to compare against: every lane counts.
	if (record === null) return { written: [], unchanged: Math.max(groups.length, 1) };
	const live = rawKeyValue(record, keyTarget, scope.mainTipo);
	const liveSlots = await readMainSlots(scope.target, scope.mainTipo, scope.slotTipos);
	const liveFrames = liveFrameMap(liveSlots, scope.mainTipo);
	const plan = await planUnit(live, liveFrames, groups, scope);
	await assertNoOrphanedFrames(plan, live, liveFrames, unit, scope);
	if (plan.frames !== null) {
		assertFramesPair(
			plan.frames,
			liveFrames,
			plan.value,
			await otherLaneItemIds(plan, scope),
			scope,
		);
	}
	const writes =
		plan.frames === null ? [] : slotWrites(liveSlots, plan.frames, scope, dataframeColumn(scope));
	if (canonicalJson(plan.value) !== canonicalJson(live)) {
		writes.unshift({ tipo: scope.mainTipo, column: scope.column, before: live, after: plan.value });
	}
	// Nothing to write: every lane already back.
	if (writes.length === 0) return { written: [], unchanged: Math.max(plan.unchanged, 1) };
	await writeComposedUnit(
		writes,
		{ live, liveSlots, lang: plan.lang || NOLAN, valueLanes: plan.valueLanes },
		scope,
		context,
	);
	return {
		written: writes.map((write) => writtenOf(write, scope)),
		unchanged: plan.unchanged,
	};
}
