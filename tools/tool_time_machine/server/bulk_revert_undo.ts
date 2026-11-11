/**
 * BULK REVERT — one UNIT, inside one transaction (2026-09-27,
 * WC-…-bulk-revert-undo-log §2.5 step 6).
 *
 * A COMPOSED unit (a dataframe main and its frames, every lane) is
 * bulk_revert_composed.ts's. Every other unit is ONE key:
 *   1. LOCK the record row (`readMatrixKeyForUpdate`) and read the key's raw
 *      live value behind the lock. No row → the record was deleted after the
 *      run: `changed_since_run`. The revert never recreates a record (the
 *      undelete stays in dd15, where the delete's snapshot lives). EXCEPT a
 *      record the run itself created: gone is its pre-run state (a first
 *      revert deleted it, D2) — `unchanged`, so a double revert stays full.
 *   2. PLAN it — the EXACT path when the key has a BEFORE row (below), else the
 *      legacy inference (bulk_revert_legacy.ts).
 *   3. WRITE it (unless it is already at its pre-run value), then write the
 *      revert's OWN undo pair under the revert's bulk id, so reverting the
 *      revert is exact in turn.
 * Any refusal throws `RevertRefusal`, which rolls the WHOLE unit back.
 *
 * THE REVERT'S OWN HISTORY follows the two lanes like any save's (relations/
 * dataframe_slots.ts recordMainHistory): one pair per language lane it
 * changed (its value only), and one lg-nolan pair when it changed a frame or
 * the lg-nolan value — a legacy frame plan's slot writes included.
 *
 * THE EXACT PATH. The key's rows alternate BEFORE, AFTER, BEFORE, AFTER…
 * (recordBulkPair writes them in that order, one pair per write). Then:
 *   - the live region already equals the earliest BEFORE → nothing to write
 *     (`unchanged`) — decided first, see planExactKey;
 *   - CHAIN: each BEFORE equals the previous AFTER. A break means something
 *     wrote the key between two of the run's own writes and left no pair — a
 *     save with the time machine off, another run, a direct key write — so the
 *     earliest BEFORE is no longer the state the key would return to by
 *     undoing only this run: `interleaved_write`.
 *   - CONFLICT: the live region equals the LAST after-image. Otherwise the key
 *     was changed after the run, and restoring would destroy that change:
 *     `changed_since_run`.
 *   - else write `restoreLane(live, lang, earliest BEFORE)`: the live key's
 *     other-language items plus the recorded region; an ABSENT recorded key
 *     is removed, not emptied. Every region is cut with the capture's lane
 *     law (main_lanes.ts laneRegion), never a looser one.
 */

import { canonicalJson } from '../../../src/core/concepts/canonical_json.ts';
import { dbTimestamp } from '../../../src/core/db/db_timestamp.ts';
import { type MatrixJsonbColumn, readMatrixRecord } from '../../../src/core/db/matrix.ts';
import {
	absorbComponentItemIds,
	readMatrixKeyForUpdate,
} from '../../../src/core/db/matrix_write.ts';
import { withTransaction } from '../../../src/core/db/postgres.ts';
import { decodeTmImage, TM_ROLE } from '../../../src/core/db/time_machine.ts';
import { isDedaloError } from '../../../src/core/errors/dedalo_error.ts';
import {
	getColumnNameByModel,
	getMatrixTableFromTipo,
	getTranslatableByTipo,
} from '../../../src/core/ontology/resolver.ts';
import {
	type MainState,
	readMainSlots,
	readMainState,
	recordMainHistory,
	type SlotImages,
	type SlotTarget,
} from '../../../src/core/relations/dataframe_slots.ts';
import {
	type LaneLaw,
	laneLaw,
	laneRegion,
	NOLAN,
	restoreLane,
} from '../../../src/core/relations/main_lanes.ts';
import {
	isMetadataTwinned,
	metadataPatchFromAuditValue,
	setRecordMetadata,
} from '../../../src/core/section/record/record_metadata.ts';
import {
	persistRestoredKeys,
	type RecordWriteTarget,
} from '../../../src/core/section_record/index.ts';
import type { Principal } from '../../../src/core/security/permissions.ts';
import { authorizeRecordAccess } from '../../../src/core/security/write_door.ts';
import type { BulkRevertInexactBasis } from './bulk_revert.ts';
import { planLegacyKey } from './bulk_revert_legacy.ts';
import {
	describeKey,
	type KeyPlan,
	type KeyTarget,
	MODIFIED_STAMPS,
	type RevertKey,
	RevertRefusal,
	type RevertUnit,
	type RunRow,
	recordAddress,
	runOwnsRecordStamps,
} from './bulk_revert_plan.ts';
import { applyDataframeRestore } from './dataframe_restore.ts';

/** The context a unit's revert runs in. */
export interface UnitContext {
	/** The caller — a legacy frame half's slot beyond the pre-gated set is judged on its grant. */
	principal: Principal;
	userId: number;
	/** The revert's own dd800 id — its pairs are stamped with it. */
	newBulkId: number;
	/** The run's dd800 `created_date` — the legacy born-in-run rule. null = unknown. */
	runCreatedDate: string | null;
	/** The run being reverted. */
	bulkId: number;
	/** `keyAddress` of every component key the run wrote (RunPlan.keyAddresses). */
	keyAddresses: ReadonlySet<string>;
	/**
	 * `recordAddress` of every record the run CREATED whose row was GONE when
	 * the revert started (bulk_revert_records.ts goneBornAddresses): such a
	 * record is at its pre-run state — non-existence — whatever removed it (a
	 * previous revert's D2 delete, the run's own cascade, a curator). Its keys
	 * are unchanged; a row there NOW is a record someone created since.
	 */
	goneBorn: ReadonlySet<string>;
}

/**
 * One key this unit WROTE — the post-commit activity row and the report need it.
 * (The observer cascade no longer does: the write chokepoint declared each key's
 * before/after to the obligation ledger, which drains after the unit's COMMIT.)
 */
export interface WrittenKey {
	key: RevertKey;
	table: string;
	inexact: BulkRevertInexactBasis | null;
}

export interface UnitResult {
	written: WrittenKey[];
	unchanged: number;
}

/** The image a row stores (`undefined` = the key was absent). */
export function image(row: RunRow): unknown {
	return decodeTmImage(row.data, row.data_absent);
}

/** One B/A pair of rows. */
export interface RowPair {
	before: RunRow;
	after: RunRow;
}

/**
 * Rows (id ASC) as B/A pairs, refused unless they strictly alternate — a
 * BEFORE row immediately followed by its visible after-row of the same
 * language (recordBulkPair writes them so, in one transaction).
 */
export function rowPairsOf(key: RevertKey, rows: readonly RunRow[]): RowPair[] {
	const pairs: RowPair[] = [];
	for (let index = 0; index < rows.length; index += 2) {
		const before = rows[index];
		const after = rows[index + 1];
		if (
			before?.tm_role !== TM_ROLE.before ||
			after === undefined ||
			after.tm_role !== null ||
			after.lang !== before.lang
		) {
			throw new RevertRefusal('failed', key, `undo log of ${describeKey(key)} is not B/A pairs`);
		}
		pairs.push({ before, after });
	}
	return pairs;
}

/** The key's rows as B/A image pairs (rowPairsOf). */
function pairsOf(key: RevertKey): { before: unknown; after: unknown }[] {
	return rowPairsOf(key, key.rows).map((pair) => ({
		before: image(pair.before),
		after: image(pair.after),
	}));
}

/** Refuse a chain in which a pair does not start where the previous one ended. */
function assertChained(
	key: RevertKey,
	pairs: readonly { before: unknown; after: unknown }[],
): void {
	for (let index = 1; index < pairs.length; index += 1) {
		if (canonicalJson(pairs[index]?.before) !== canonicalJson(pairs[index - 1]?.after)) {
			throw new RevertRefusal(
				'interleaved_write',
				key,
				`${describeKey(key)}: pair ${index} does not start where pair ${index - 1} ended`,
			);
		}
	}
}

/**
 * The EXACT plan of a key over its live value (see the header). Pure: throws
 * RevertRefusal on a malformed log, a broken chain or a post-run change.
 *
 * `unchanged` is decided FIRST: a key already at its pre-run value (a second
 * revert of the same run, or a curator who put it back by hand) needs nothing
 * written whatever else happened to it, and reporting that as a conflict would
 * tell the operator their data is at risk when it is not.
 *
 * The key is cut with the CAPTURE's lane law (main_lanes.ts laneRegion /
 * restoreLane — recordMainPairs' own cut): the lg-nolan lane of a translatable
 * sliced main is strictly its lg-nolan-tagged items, never a lang-less orphan.
 */
export function planExactKey(key: RevertKey, live: unknown, law: LaneLaw): KeyPlan {
	const pairs = pairsOf(key);
	const lane = key.lang === '' ? NOLAN : key.lang;
	const liveRegion = canonicalJson(laneRegion(live, lane, law));
	const earliest = pairs[0]?.before;
	if (liveRegion === canonicalJson(earliest)) return { kind: 'unchanged' };
	assertChained(key, pairs);
	if (liveRegion !== canonicalJson(pairs.at(-1)?.after)) {
		throw new RevertRefusal('changed_since_run', key, `${describeKey(key)} changed after the run`);
	}
	return {
		kind: 'write',
		value: restoreLane(live, lane, earliest, law),
		framePlan: [],
		inexact: null,
	};
}

/** One key of a record image a unit PRODUCES (unitProduces). */
export interface ProducedKey {
	column: MatrixJsonbColumn;
	tipo: string;
	value: unknown;
	/**
	 * THE UNIT'S OWN equality for this key — the one its plan decides
	 * `unchanged` with (an exact key: strict canonical, planExactKey; a composed
	 * main: sameMain; a slot: slotWrite's "empty stays empty"). A judgement that
	 * called a value "already there" by a looser law would skip a put-back the
	 * unit then refuses (a pre-run `[]` against an absent key).
	 */
	same: (live: unknown, produced: unknown) => boolean;
}

/** Strict stored-value equality — planExactKey's. */
function sameCanonical(left: unknown, right: unknown): boolean {
	return canonicalJson(left) === canonicalJson(right);
}

/**
 * What a NON-COMPOSED EXACT unit LEAVES on a record, placed over `start` —
 * planExactKey's own write (restoreLane: the key's lane back at its earliest
 * BEFORE, every other lane as `start` holds it). A key whose live value equals
 * this is, by construction, one planExactKey finds `unchanged` (its lane is at
 * the earliest BEFORE), so no second law is needed. null for a unit this does
 * not cover (a legacy key: its plan reads the record's history, not an image;
 * a malformed log) — the caller treats its keys as undecided.
 *
 * Used by the cascade-record judgement (bulk_revert_records.ts
 * producedStateOf): a record the revert undeletes or un-wipes is at "the
 * state the revert produces" when its keys equal the snapshot WITH every
 * unit's restore applied.
 */
export async function exactUnitProduces(
	unit: RevertUnit,
	start: (column: MatrixJsonbColumn, tipo: string) => unknown,
): Promise<ProducedKey[] | null> {
	if (unit.composed !== null || unit.keys.some((key) => !key.exact)) return null;
	const produced: ProducedKey[] = [];
	for (const key of unit.keys) {
		const column = getColumnNameByModel(key.model);
		if (column === null) return null;
		const law = await keyLaneLaw(key);
		const lane = key.lang === '' ? NOLAN : key.lang;
		let earliest: unknown;
		try {
			earliest = pairsOf(key)[0]?.before;
		} catch (error) {
			if (error instanceof RevertRefusal) return null; // a malformed log: undecided
			throw error;
		}
		produced.push({
			column: column as MatrixJsonbColumn,
			tipo: key.tipo,
			value: restoreLane(start(column as MatrixJsonbColumn, key.tipo), lane, earliest, law),
			same: sameCanonical,
		});
	}
	return produced;
}

/** Resolve where a key is stored, or refuse it (`no_column`). */
export async function resolveKeyTarget(key: RevertKey): Promise<KeyTarget> {
	const column = getColumnNameByModel(key.model);
	const table = await getMatrixTableFromTipo(key.sectionTipo);
	if (column === null || table === null) {
		throw new RevertRefusal(
			'no_column',
			key,
			`no column/table for ${key.model}/${key.sectionTipo}`,
		);
	}
	return { table, column: column as MatrixJsonbColumn };
}

/** The raw stored value of one key of a record (`undefined` = absent). */
export function rawKeyValue(
	record: Awaited<ReturnType<typeof readMatrixRecord>>,
	target: KeyTarget,
	tipo: string,
): unknown {
	const bag = record?.columns[target.column];
	if (bag === null || bag === undefined || typeof bag !== 'object') return undefined;
	return (bag as Record<string, unknown>)[tipo];
}

/** The key's value as an item list. */
export function asItems(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

/**
 * Whether the revert must NOT stamp the record's modified metadata: the key IS
 * a stamp, or the run wrote a stamp of this record itself
 * (bulk_revert_plan.ts runOwnsRecordStamps) — stamping would overwrite the
 * value the revert restores (the dd201 unit), or move a stamp the run's own
 * pair still expects at its after-image, refusing it `changed_since_run` — or,
 * in the other order, clobber a restored stamp while the report says exact.
 */
export function runOwnsModifiedStamps(key: RevertKey, context: UnitContext): boolean {
	return (
		MODIFIED_STAMPS.includes(key.tipo) ||
		runOwnsRecordStamps(context.keyAddresses, key.sectionTipo, key.sectionId)
	);
}

/** One written key's history, held back until its whole unit is written (a legacy framed unit). */
interface DeferredHistory {
	key: RevertKey;
	target: SlotTarget;
	before: MainState;
	column: MatrixJsonbColumn;
}

/**
 * WRITE one planned key: frames first (a legacy snapshot's frame plan — PHP
 * restores the slots before the main), then the key, then the revert's own
 * undo pairs (recordRevertHistory) — so the revert is exactly revertible, slot
 * frames included. Runs inside the unit's transaction, behind its lock. The
 * pairs' after-images are RE-READ from the row (the persisted bytes, the
 * capture's own law), never taken from the plan. `deferred`: the history is
 * not written here but collected, for the unit to record ONCE (revertUnit).
 */
async function writeRevertedKey(
	key: RevertKey,
	target: KeyTarget,
	live: unknown,
	plan: Extract<KeyPlan, { kind: 'write' }>,
	context: UnitContext,
	deferred: DeferredHistory[] | null,
): Promise<void> {
	const writeTarget: RecordWriteTarget = {
		table: target.table,
		sectionTipo: key.sectionTipo,
		sectionId: key.sectionId,
	};
	// The main's slots as they stand BEFORE any write (its pairs' BEFORE side).
	const slotsBefore = await readMainSlots(
		writeTarget,
		key.tipo,
		plan.framePlan.map((restore) => restore.slotTipo),
	);
	await applyDataframeRestore(
		writeTarget,
		key.tipo,
		plan.framePlan,
		plan.frameSlice ?? null,
		context.userId,
		// Every plan slot already passed authorizeKeyWrite (writePlannedKey,
		// before any write); asked again here by the door that writes it.
		(slotTipo) => authorizeKeyWrite(key, key.sectionTipo, key.sectionId, slotTipo, context),
	);
	// The chokepoint owns the key's derived writes (the COMPONENT-RESTORE
	// entry): the save law's relation_search (the ancestor index moves with the
	// restored locators) in the same UPDATE, and the observer cascade — declared
	// with the key's before-image, drained after the unit's COMMIT. A reverted
	// COVERED OBSERVER MIRROR is never propagated: it converges on truth after
	// the unit's COMMIT, never on the run's image of it (record_write §3e) —
	// with the key write's stamp posture.
	const stamp = runOwnsModifiedStamps(key, context) ? false : { userId: context.userId };
	await persistRestoredKeys(
		writeTarget,
		// null REMOVES the key (updateMatrixKeysData), which is what an absent image restores.
		[{ column: target.column, key: key.tipo, value: plan.value === undefined ? null : plan.value }],
		stamp,
		{ actor: context.userId },
	);
	// Restored items carry explicit ids; raise the counter so a later insert
	// cannot mint a duplicate (a duplicated main id breaks the id_key pairing).
	await absorbComponentItemIds(
		target.table,
		key.sectionTipo,
		key.sectionId,
		key.tipo,
		asItems(plan.value),
	);
	const history = { key, target: writeTarget, before: { value: live, slots: slotsBefore } };
	if (deferred !== null) deferred.push({ ...history, column: target.column });
	else await recordRevertHistory(key, writeTarget, { ...history, column: target.column }, context);
}

/**
 * THE ONE HISTORY OF A LEGACY FRAMED UNIT, after every key and the carrier's
 * frame half are written (as writeComposedUnit): the main's state before the
 * unit's FIRST write — its value then; its slots as the LAST written key read
 * them, which only the carrier (the last key) writes, so they are the pre-unit
 * slots over the widest slot set — against the state now, under the newest
 * written lane. Per-key history would put each language's after-row below the
 * carrier's lg-nolan row, pairing the restored value with the run's frames.
 */
async function recordDeferredHistory(
	deferred: readonly DeferredHistory[],
	context: UnitContext,
): Promise<void> {
	const first = deferred[0];
	const last = deferred.at(-1);
	if (first === undefined || last === undefined) return;
	await recordRevertHistory(
		first.key,
		first.target,
		{ before: { value: first.before.value, slots: last.before.slots }, column: first.column },
		context,
	);
}

/**
 * The revert's own history of one written key — its two-lane undo pairs under
 * the revert's bulk id (relations/dataframe_slots.ts recordMainHistory), the
 * AFTER side re-read from the row.
 */
async function recordRevertHistory(
	key: RevertKey,
	target: SlotTarget,
	images: { before: MainState; column: MatrixJsonbColumn },
	context: UnitContext,
): Promise<void> {
	const after = await readMainState(
		target,
		{ tipo: key.tipo, column: images.column },
		images.before.slots.slots,
	);
	await recordMainHistory(
		target,
		await laneIdentityOf(key),
		{ before: images.before, after },
		{ userId: context.userId, timestamp: dbTimestamp(), bulkId: context.newBulkId },
	);
}

/** A key's lane law (main_lanes.ts laneLaw: the ontology flag counts for a sliced model only). */
export async function keyLaneLaw(key: RevertKey): Promise<LaneLaw> {
	return laneLaw(key.sliced, key.sliced && (await getTranslatableByTipo(key.tipo)));
}

/** A key's lane identity: its lane law, its lang as the door lane (lg-nolan for an unsliced key). */
export async function laneIdentityOf(key: RevertKey): Promise<{
	tipo: string;
	sliced: boolean;
	translatable: boolean;
	lang: string;
}> {
	return {
		tipo: key.tipo,
		...(await keyLaneLaw(key)),
		lang: key.lang === '' || !key.sliced ? NOLAN : key.lang,
	};
}

/** One key a composed unit writes. */
export interface ComposedKeyWrite {
	tipo: string;
	column: MatrixJsonbColumn;
	before: unknown;
	/** `undefined` removes the key. */
	after: unknown;
}

/** Where a composed unit's main is stored. */
export interface ComposedWriteScope {
	key: RevertKey;
	target: SlotTarget;
	column: MatrixJsonbColumn;
}

/** What a composed unit's own history is built from: the main's state before any write. */
export interface ComposedHistory {
	live: unknown;
	liveSlots: SlotImages;
	/** The door lane of the revert's own pairs (the unit's newest lane). */
	lang: string;
}

/**
 * WRITE a COMPOSED unit (bulk_revert_composed.ts plans it): every changed key —
 * the main and its slots — in ONE chokepoint call, the COMPONENT-RESTORE entry
 * (which owns each key's derived writes: relation_search, the observer ledger —
 * and a covered observer mirror main is recomputed after COMMIT, never
 * propagated as the run saw it), the item-id counter
 * per key, then the revert's own
 * two-lane history (recordMainHistory → recordMainPairs: the lg-nolan pair —
 * lg-nolan value + every slot's frames — FIRST, then one pair per language
 * lane, each cut from the state the previous step left). Inside the unit's
 * transaction.
 */
export async function writeComposedUnit(
	writes: readonly ComposedKeyWrite[],
	history: ComposedHistory,
	scope: ComposedWriteScope,
	context: UnitContext,
): Promise<void> {
	const { target } = scope;
	// THE WRITE DOOR for every key this composed unit writes — the main and each
	// of its slots (req 10); refused → the unit rolls back, reported out_of_scope.
	for (const write of writes) {
		await authorizeKeyWrite(scope.key, target.sectionTipo, target.sectionId, write.tipo, context);
	}
	if (writes.length > 0) {
		await persistRestoredKeys(
			target,
			// null REMOVES the key (updateMatrixKeysData), which is what an absent image restores.
			writes.map((write) => ({
				column: write.column,
				key: write.tipo,
				value: write.after ?? null,
			})),
			runOwnsRecordStamps(context.keyAddresses, target.sectionTipo, target.sectionId)
				? false
				: { userId: context.userId },
			{ actor: context.userId },
		);
	}
	for (const write of writes) {
		// Restored items carry explicit ids: raise each key's counter so a later
		// insert cannot mint a duplicate (a duplicated main id breaks the id_key pairing).
		await absorbComponentItemIds(
			target.table,
			target.sectionTipo,
			target.sectionId,
			write.tipo,
			asItems(write.after),
		);
	}
	const key = { ...scope.key, lang: history.lang };
	await recordRevertHistory(
		key,
		target,
		{ before: { value: history.live, slots: history.liveSlots }, column: scope.column },
		context,
	);
}

/** A record as read behind the unit's lock. */
export type LockedRecord = NonNullable<Awaited<ReturnType<typeof readMatrixRecord>>>;

/**
 * LOCK the record (`readMatrixKeyForUpdate` on the key) and read it behind the
 * lock. `null` = a record BORN in the run and gone: at its pre-run state
 * (non-existence), nothing to write. A record otherwise missing, or a born one
 * back, refuses `changed_since_run` (`reportKey` locates the refusal).
 */
export async function lockUnitRecord(
	key: RevertKey,
	target: KeyTarget,
	context: UnitContext,
	reportKey: RevertKey = key,
): Promise<LockedRecord | null> {
	const locked = await readMatrixKeyForUpdate(
		target.table,
		key.sectionTipo,
		key.sectionId,
		target.column,
		key.tipo,
	);
	const gone = context.goneBorn.has(recordAddress(key.sectionTipo, key.sectionId));
	if (locked === null) {
		if (gone) return null;
		throw new RevertRefusal(
			'changed_since_run',
			reportKey,
			`${describeKey(key)}: the record no longer exists`,
		);
	}
	if (gone) {
		// It was gone when the revert started (its scope gate was skipped on
		// that answer) and is back: a record someone created since, never ours.
		throw new RevertRefusal(
			'changed_since_run',
			reportKey,
			`${describeKey(key)}: the record reappeared`,
		);
	}
	const record = await readMatrixRecord(target.table, key.sectionTipo, key.sectionId);
	if (record === null) {
		throw new RevertRefusal(
			'changed_since_run',
			reportKey,
			`${describeKey(key)}: the record vanished`,
		);
	}
	return record;
}

/**
 * THE WRITE DOOR, per written component (closure Step 3 req 10). The
 * orchestrator's unitInScope pre-judged the unit on the caller's levels; the
 * WRITE itself — behind the unit's lock, after any undelete restored the row —
 * asks the door for the triple: grammar, section floor 1, the dd128-aware pair
 * (a user-manager reverting a run that touched their OWN dd128 record must not
 * restore their own dd1725 / dd132 through it), the write scope with the
 * non-positive-id refusal ahead of the admin bypass. A refusal is the unit's
 * `out_of_scope` (one code for both halves, as the pre-gate) — rolled back,
 * reported, never written. Anything else propagates as the failure it is.
 */
async function authorizeKeyWrite(
	reportKey: RevertKey,
	sectionTipo: string,
	sectionId: number,
	componentTipo: string,
	context: UnitContext,
): Promise<void> {
	try {
		await authorizeRecordAccess(
			context.principal,
			{ section_tipo: sectionTipo, component_tipo: componentTipo, section_id: sectionId },
			{
				mode: 'write',
				level: 2,
				sectionFloor: 1,
				door: 'tool_time_machine.bulk_revert_process',
				// A FIXED dataframe slot (dd560) is judged against its main (T0-4): the
				// key's main for a slot of it; a key that IS the slot (a slot-keyed
				// history row) rewrites the whole slot — bound by every main.
				frameOf:
					componentTipo === reportKey.tipo ? { everyMain: true } : { mainTipo: reportKey.tipo },
			},
		);
	} catch (error) {
		if (
			isDedaloError(error) &&
			(error.code.startsWith('perm.') || error.code === 'request.invalid')
		) {
			throw new RevertRefusal(
				'out_of_scope',
				reportKey,
				`${describeKey(reportKey)}: the write door refused ${sectionTipo}/${componentTipo}#${sectionId} (${error.code})`,
			);
		}
		throw error;
	}
}

/**
 * Lock the record, read the key behind the lock, plan it, and write it.
 * `frameUnit`: the unit when this key carries the main's frame half
 * (a legacy key: bulk_revert_legacy.ts), null when it restores its region only.
 */
async function revertKey(
	key: RevertKey,
	context: UnitContext,
	frameUnit: RevertUnit | null,
	deferred: DeferredHistory[] | null = null,
): Promise<WrittenKey | null> {
	const target = await resolveKeyTarget(key);
	const record = await lockUnitRecord(key, target, context);
	if (record === null) return null;
	const live = rawKeyValue(record, target, key.tipo);
	const plan = key.exact
		? planExactKey(key, live, await keyLaneLaw(key))
		: await planLegacyKey(key, live, {
				target,
				recordCreatedDate: createdDateOf(record),
				runCreatedDate: context.runCreatedDate,
				bulkId: context.bulkId,
				frameUnit,
				principal: context.principal,
			});
	if (plan.kind === 'unchanged') return null;
	// THE WRITE DOOR for the key and every slot its frame plan restores (req 10).
	for (const tipo of new Set([key.tipo, ...plan.framePlan.map((restore) => restore.slotTipo)])) {
		await authorizeKeyWrite(key, key.sectionTipo, key.sectionId, tipo, context);
	}
	await writeRevertedKey(key, target, live, plan, context, deferred);
	const twinInexact = await rederiveMetadataTwin(key, record, plan.value);
	return {
		key,
		table: target.table,
		inexact: plan.inexact ?? (twinInexact ? 'metadata_twin' : null),
	};
}

/**
 * THE `data`-COLUMN TWIN of dd199 / dd200 (record_metadata.ts) — a NAMED
 * EXEMPTION from the undo log (WC …-bulk-revert-undo-log §2.3): the CSV
 * importer rewrites `data.created_date` / `created_by_user_id` beside the
 * audit component, outside the save path, with no pair. Restoring the
 * component alone would leave the two stores disagreeing (the edit view says
 * one date, every list another). So after restoring either key the revert
 * RE-DERIVES the twin from the restored value (the importer's own derivation,
 * metadataPatchFromAuditValue) — agreement, not the twin's recorded bytes —
 * and reports the key `inexact: metadata_twin` whenever it had to rewrite the
 * twin, or could not derive one from the restored value. Returns that flag.
 */
async function rederiveMetadataTwin(
	key: RevertKey,
	record: Awaited<ReturnType<typeof readMatrixRecord>>,
	restored: unknown,
): Promise<boolean> {
	if (!isMetadataTwinned(key.tipo)) return false;
	const patch = metadataPatchFromAuditValue(key.tipo, restored);
	const twin = (record?.columns.data ?? {}) as {
		created_date?: unknown;
		created_by_user_id?: unknown;
	};
	const derived = patch.createdDate ?? patch.createdByUserId;
	if (derived === undefined) return true;
	const current = patch.createdDate !== undefined ? twin.created_date : twin.created_by_user_id;
	if (canonicalJson(current) === canonicalJson(derived)) return false;
	await setRecordMetadata(key.sectionTipo, key.sectionId, patch);
	return true;
}

/** A record's birth date (`data.created_date`, create_record.ts), or null. */
function createdDateOf(record: Awaited<ReturnType<typeof readMatrixRecord>>): string | null {
	const created = (record?.columns.data as { created_date?: unknown } | null | undefined)
		?.created_date;
	return typeof created === 'string' && created !== '' ? created : null;
}

/** The reverter of a COMPOSED unit (bulk_revert_composed.ts revertComposedUnit). */
export type ComposedReverter = (unit: RevertUnit, context: UnitContext) => Promise<UnitResult>;

/**
 * Revert one unit, all-or-nothing, in ONE transaction. Throws RevertRefusal
 * (after the rollback) when any key refuses; anything else is a failure.
 * `prelude` runs first INSIDE the transaction — the undelete of the records
 * this unit re-links (bulk_revert_records.ts), rolled back with the unit. A
 * composed unit is handed to `composed` (injected by the orchestrator, so the
 * composed module can build on this one without an import cycle).
 */
export async function revertUnit<P>(
	unit: RevertUnit,
	context: UnitContext,
	prelude: () => Promise<P>,
	composed: ComposedReverter,
): Promise<UnitResult & { prelude: P }> {
	return withTransaction(async () => {
		const preludeResult = await prelude();
		if (unit.composed !== null) {
			return { ...(await composed(unit, context)), prelude: preludeResult };
		}
		const result: UnitResult & { prelude: P } = {
			written: [],
			unchanged: 0,
			prelude: preludeResult,
		};
		// A non-composed unit is one key, or a legacy main's keys newest first
		// (bulk_revert_plan.ts groupUnits): the LAST carries the frame half, and
		// the unit's history is recorded ONCE, after it (recordDeferredHistory).
		const deferred: DeferredHistory[] | null = unit.keys[0]?.framed === true ? [] : null;
		for (const [index, key] of unit.keys.entries()) {
			const carrier = index === unit.keys.length - 1;
			const written = await revertKey(key, context, carrier ? unit : null, deferred);
			if (written === null) result.unchanged += 1;
			else result.written.push(written);
		}
		if (deferred !== null) await recordDeferredHistory(deferred, context);
		return result;
	});
}
