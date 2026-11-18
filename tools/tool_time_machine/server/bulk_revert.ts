/**
 * tool_time_machine.bulk_revert_process (PHP tools/tool_time_machine::
 * bulk_revert_process) — undo a whole bulk run: every component write, record
 * creation and cascade delete that carries one dd800 `bulk_process_id` (a CSV
 * import, import_execute, a propagation, an update_cache sweep, a revert).
 * The revert runs under a NEW dd800 id and writes its own undo log, so it is
 * itself exactly revertible.
 *
 * THE UNDO LOG (2026-09-27, WC-…-bulk-revert-undo-log). A run records, for
 * every key it changes, the exact region it replaced (a hidden BEFORE row,
 * tm_role 1) and the region it left (its visible after-row) — whatever the
 * caller's saveTm says (decision D1). So this door does not INFER a pre-run
 * value from history any more: it reads it. The steps:
 *   1. REFUSE A LIVE RUN (D5): a run still executing in this process, or one
 *      another revert is undoing, is refused `tool.bulk_run_live`
 *      (src/core/tools/bulk_run_registry.ts). The chain and conflict checks
 *      below are the backstop.
 *   2. LOAD every row of the run, every role, id ASC — epoch-narrowed (P0-14:
 *      a row written before an address was reborn belongs to the dead record).
 *   3. PLAN (bulk_revert_plan.ts): one KEY per component region, counted once;
 *      a dataframe main (every language) is ONE UNIT with its frames — its
 *      rows follow the TWO LANES (a language's value; the lg-nolan value +
 *      every slot's full frames), and bulk_revert_composed.ts restores them
 *      lane by lane, in one transaction.
 *   4. UNDELETE what the run's cascade deleted that no unit re-links (D3,
 *      bulk_revert_records.ts), on the record's own gate.
 *   5. REVERT each unit all-or-nothing in one transaction, NEWEST FIRST
 *      (bulk_revert_undo.ts): exact when the key has BEFORE rows, inferred
 *      (bulk_revert_legacy.ts) for a run made before the undo log. The cascade
 *      targets a unit re-links are undeleted INSIDE its transaction, first —
 *      they land or roll back with it.
 *   6. DELETE the records the run created, where that is safe (D2).
 * Observers and one activity row per written key follow each unit's COMMIT.
 *
 * PERMISSION: the module gate is section/level 2 on the request seed; a run
 * spans sections and components, so EACH unit is re-gated on every key's
 * (section_tipo, tipo) SCHEMA pair — a composed unit ALSO on every dataframe
 * slot its restore may write, which has no key of its own to be gated by —
 * AND on the record's project scope (SEC-024
 * §9.4 — the TM search applies no projects filter), skip-on-fail, never abort.
 * A unit whose OWN record the run deleted (a revert's D2 delete, reverted in
 * turn) is gated on the record's scope AFTER undeleting it, on the restored
 * row, inside its transaction — the search cannot find a row that is not there.
 * Every cascade target a unit RE-LINKS is gated the same way, on ITS OWN
 * restored row: the referrer's gate never stands for the target's scope (a
 * locator in A says nothing about B's projects — cross-write:r2); out of
 * scope refuses the unit, rolling the undelete back with it.
 * Record-level markers are gated on the section level and the record's scope,
 * the delete door's own rule.
 *
 * THE SKIP CHANNEL (SEC-16, WC-2026-09-03-bulk-revert-skipped-typed-entries,
 * amended by WC-…-bulk-revert-undo-log): `data.skipped[]` holds TYPED entries
 * `{reason, section_tipo?, tipo?, section_id?, lang?}`, never sentences. The
 * bulk id is a small enumerable integer and the run's rows are found with no
 * projects filter, so a unit's coordinates ride an entry ONLY once it has
 * passed the scope gate (`inScope`); a denial is an `out_of_scope` entry with
 * no coordinates (counted, never located); refusal TEXT (slot names, the
 * exception message) goes to the server log with the request id.
 *
 * THE REPORT: `data = {counter, unchanged, bulk_process_id, exact, skipped,
 * inexact}` — `counter` the units written, `unchanged` the KEYS already at
 * their pre-run value, `bulk_process_id` the REVERT's own id, `exact` 'full'
 * (every unit exact, nothing skipped), 'none' (nothing reverted exactly) or
 * 'partial', and `inexact[]` the writes that are not an exact inverse:
 * `legacy_inference` / `legacy_born_in_run` (a legacy key) and
 * `cascade_undelete` (the media and diffusion halves of a delete are not
 * replayed as they were), `metadata_twin` (dd199/dd200 restored and their
 * `data`-column twin RE-DERIVED from the restored value — the twin is a named
 * exemption from the undo log, bulk_revert_undo.ts rederiveMetadataTwin).
 */

import type { logActivity as logActivityType } from '../../../src/core/api/handlers/activity_log.ts';
import type { MatrixJsonbColumn } from '../../../src/core/db/matrix.ts';
import { readMatrixRecord } from '../../../src/core/db/matrix.ts';
import { sql, withTransaction } from '../../../src/core/db/postgres.ts';
import { ensureTmHistoryReady, tmEpochPredicate } from '../../../src/core/db/record_generation.ts';
import { TM_IMAGE_ABSENT_COLUMN, TM_ROLE } from '../../../src/core/db/time_machine.ts';
import { DedaloError, ok, toDedaloError } from '../../../src/core/errors/index.ts';
import {
	getColumnNameByModel,
	getMatrixTableFromTipo,
	getModelByTipo,
} from '../../../src/core/ontology/resolver.ts';
import { createSectionRecord } from '../../../src/core/section/record/create_record.ts';
import { persistRecordKeys } from '../../../src/core/section_record/index.ts';
import { getPermissions, type Principal } from '../../../src/core/security/permissions.ts';
import { principalCanAccessRecord } from '../../../src/core/security/record_scope.ts';
import {
	claimBulkRevert,
	isBulkRunLive,
	releaseBulkRevert,
	withLiveBulkRun,
} from '../../../src/core/tools/bulk_run_registry.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	toolRequestId,
} from '../../../src/core/tools/module.ts';
import { revertComposedUnit } from './bulk_revert_composed.ts';
import {
	planRun,
	type RecordMarker,
	type RevertKey,
	RevertRefusal,
	type RevertUnit,
	type RunPlan,
	type RunRow,
	recordAddress,
	unitReportKey,
} from './bulk_revert_plan.ts';
import {
	assignCascadeMarkers,
	type BornOutcome,
	cascadeGroup,
	deleteBornRecords,
	goneBornAddresses,
	isOwnRecord,
	type RecordContext,
	type RecordOutcome,
	undeleteCascadeRecord,
	undeleteStandaloneRecord,
} from './bulk_revert_records.ts';
import { revertUnit, type UnitResult } from './bulk_revert_undo.ts';

const BULK_PROCESS_SECTION_TIPO = 'dd800';
const BULK_PROCESS_LABEL_TIPO = 'dd796';

/**
 * Why a unit or record was NOT reverted — a closed vocabulary. The wire carries
 * the code; the WHY in words is the log's.
 */
export type BulkRevertSkipReason =
	/** the caller lacks level 2 on a (section_tipo, tipo) pair of the unit, or
	 *  the record is outside their project scope — one code for both halves,
	 *  because telling them apart already says whether the record exists */
	| 'out_of_scope'
	/** legacy key: no pre-run row, and the record was not born in the run */
	| 'no_pre_batch_state'
	/** the model resolves to no matrix column, or the section to no table */
	| 'no_column'
	/** legacy key: a lang-sliced value nothing can name a language for */
	| 'no_lang'
	/** the key changed after the run (or its record was deleted): restoring
	 *  would destroy that change, so the whole unit is left as it is */
	| 'changed_since_run'
	/** something wrote the key BETWEEN two of the run's own writes without a
	 *  pair (time machine off, another run, a direct write): the earliest
	 *  BEFORE is no longer what undoing this run alone returns to */
	| 'interleaved_write'
	/** a record the run created was kept (see bulk_revert_records.ts) */
	| 'created_record_kept'
	/** a record the run's cascade deleted could not be undeleted (its
	 *  address is occupied again) */
	| 'cascade_delete_not_reverted'
	/** the unit's revert threw; the exception text is in the server log */
	| 'failed';

/**
 * One `skipped[]` entry. Coordinates are present ONLY for a unit the caller
 * was entitled to see (it passed the scope gate); an `out_of_scope` entry, or
 * a `failed` one from before the gate, carries the reason alone. `lang` names
 * the language region of a lang-sliced key. `code` rides a LOCATED `failed`
 * entry only: the converter's wire code of the error that failed the unit
 * (`tree.cycle` for a revert that would close a loop in a hierarchy;
 * `internal.unexpected` for an untyped throw) — a code, never the words
 * (WC-2026-10-11-parent-link-cycle-every-door).
 */
export interface BulkRevertSkipped {
	reason: BulkRevertSkipReason;
	section_tipo?: string;
	tipo?: string;
	section_id?: number;
	lang?: string;
	code?: string;
}

/** The wire code of the error that failed a unit (the ONE converter classifies it). */
export function failureCodeOf(error: unknown): string {
	return toDedaloError(error).code;
}

/** Why a written key or record is not an exact inverse of the run. */
export type BulkRevertInexactBasis =
	| 'legacy_inference'
	| 'legacy_born_in_run'
	| 'cascade_undelete'
	/** dd199/dd200 restored; their `data`-column twin re-derived, not replayed (a named exemption) */
	| 'metadata_twin';

/** One `inexact[]` entry — only ever for a unit or record that passed the scope gate. */
export interface BulkRevertInexact {
	basis: BulkRevertInexactBasis;
	section_tipo: string;
	section_id: number;
	tipo?: string;
	lang?: string;
}

/** The coordinates a report entry may carry (a key, or a record). */
interface Located {
	section_tipo: string;
	section_id: number;
	tipo: string;
	lang?: string;
}

/** Locate a key: `lang` only for a lang-sliced key, whose region it names. */
function locateKey(key: RevertKey): Located {
	return {
		section_tipo: key.sectionTipo,
		section_id: key.sectionId,
		tipo: key.tipo,
		lang: key.sliced ? key.lang : undefined,
	};
}

/** Locate a record marker (tipo = section_tipo, the TM's record-row convention). */
function locateRecord(marker: RecordMarker): Located {
	return {
		section_tipo: marker.sectionTipo,
		section_id: marker.sectionId,
		tipo: marker.sectionTipo,
	};
}

/** dd800 bulk-process record + label so this revert is itself revertible. */
async function createRevertBulkProcess(label: string, userId: number): Promise<number> {
	try {
		const bulkId = await createSectionRecord(BULK_PROCESS_SECTION_TIPO, userId);
		try {
			const labelModel = await getModelByTipo(BULK_PROCESS_LABEL_TIPO);
			const labelColumn = labelModel !== null ? getColumnNameByModel(labelModel) : null;
			const labelTable = await getMatrixTableFromTipo(BULK_PROCESS_SECTION_TIPO);
			if (labelColumn !== null && labelTable !== null) {
				await persistRecordKeys(
					{ table: labelTable, sectionTipo: BULK_PROCESS_SECTION_TIPO, sectionId: bulkId },
					[
						{
							column: labelColumn as MatrixJsonbColumn,
							key: BULK_PROCESS_LABEL_TIPO,
							value: [{ lang: 'lg-nolan', value: label }],
						},
					],
					{ userId },
					{ actor: userId },
				);
			}
		} catch (error) {
			// The label is cosmetic — best effort, but never SILENT: this write goes
			// through the record chokepoint, so a failure here also means its
			// post-write obligations did not run.
			console.error(
				`[tool_time_machine/bulk_revert] dd800 label of revert run ${String(bulkId)} not written — its post-write obligations did not run:`,
				error,
			);
		}
		return bulkId;
	} catch (error) {
		// (!) NOT `return null` (P1-9 / DATA-31). The dd800 row IS the revert's
		// identity: every TM row this run writes is stamped with it, and that stamp
		// is the ONLY thing that later distinguishes those rows from ordinary saves
		// — i.e. the only thing that makes the revert itself revertible, which is
		// the operation's stated contract.
		//
		// Returning null let the run proceed and stamp every row with
		// `bulkProcessId: null`. The revert then could not be undone, and the sole
		// signal was a null field in the response body that nothing reads.
		//
		// A bulk operation that cannot be undone must not START.
		throw new DedaloError('tool.action_failed', {
			publicMessage:
				'Could not create the bulk-process record this revert would be undone by, so the revert was NOT started. Nothing was changed.',
			message: `bulk_revert: createRevertBulkProcess failed: ${error instanceof Error ? error.message : String(error)}`,
			coordinates: { section_tipo: BULK_PROCESS_SECTION_TIPO },
		});
	}
}

export async function toolTimeMachineBulkRevert(ctx: ToolActionContext): Promise<ToolResponse> {
	const bulkProcessId = Number(ctx.options.bulk_process_id);
	if (!Number.isInteger(bulkProcessId) || bulkProcessId <= 0) {
		throw new DedaloError('request.invalid_options', {
			publicMessage: 'bulk_process_id must be a positive integer',
		});
	}
	// D5: a run still writing its undo log is not revertable yet, and two
	// reverts of one run would both read the log before either wrote.
	if (isBulkRunLive(bulkProcessId) || !claimBulkRevert(bulkProcessId)) {
		throw new DedaloError('tool.bulk_run_live', {
			coordinates: { bulk_process_id: bulkProcessId },
		});
	}
	try {
		return await revertRun(ctx, bulkProcessId);
	} finally {
		releaseBulkRevert(bulkProcessId);
	}
}

/**
 * Every row of the run, every role, id ASC — the living generation's only
 * (P0-14: a row written before an address was reborn belongs to the dead
 * record; a bulk create at an explicit id opens that epoch too, create_record.ts
 * recordBirthMarker) — EXCEPT a cascade-delete snapshot (role 4). That row
 * describes a record the run DELETED, so it is a dead generation's by
 * definition; a unit restoring a locator to its address must still meet it, and
 * the undelete's identity test then refuses the record born there since
 * (bulk_revert_records.ts) — dropping it would restore the locator onto that
 * foreign record.
 */
async function loadRunRows(bulkProcessId: number): Promise<RunRow[]> {
	await ensureTmHistoryReady();
	const rows = (await sql.unsafe(
		`SELECT id, section_id, section_tipo, tipo, lang, data, ${TM_IMAGE_ABSENT_COLUMN}, tm_role
		 FROM matrix_time_machine
		 WHERE bulk_process_id = $1
		   AND (tm_role = $2 OR ${tmEpochPredicate()})
		 ORDER BY id ASC`,
		[bulkProcessId, TM_ROLE.cascadeDelete],
	)) as RunRow[];
	return rows.map((row) => ({
		...row,
		id: Number(row.id),
		section_id: Number(row.section_id),
		tm_role: row.tm_role === null ? null : Number(row.tm_role),
	}));
}

/** The run's dd800 `created_date` (the legacy born-in-run rule), or null. */
async function runCreatedDate(bulkProcessId: number): Promise<string | null> {
	const table = await getMatrixTableFromTipo(BULK_PROCESS_SECTION_TIPO);
	if (table === null) return null;
	const record = await readMatrixRecord(table, BULK_PROCESS_SECTION_TIPO, bulkProcessId);
	const created = (record?.columns.data as { created_date?: unknown } | null | undefined)
		?.created_date;
	return typeof created === 'string' && created !== '' ? created : null;
}

async function revertRun(ctx: ToolActionContext, bulkProcessId: number): Promise<ToolResponse> {
	const rows = await loadRunRows(bulkProcessId);
	if (rows.length === 0) {
		throw new DedaloError('tool.target_not_found', {
			coordinates: { bulk_process_id: bulkProcessId },
			message: `No changes found for bulk_process_id ${bulkProcessId}`,
		});
	}
	const plan = await planRun(rows);
	const createdDate = await runCreatedDate(bulkProcessId);
	const label = String(
		ctx.options.bulk_revert_process_label ?? `Revert bulk process ${bulkProcessId}`,
	);
	const newBulkId = await createRevertBulkProcess(label, ctx.userId);
	// The revert is a bulk run too: while it writes, its own log is half-written.
	return withLiveBulkRun(newBulkId, () =>
		executeRevert(ctx, { bulkProcessId, newBulkId, plan, createdDate }),
	);
}

interface RevertRun {
	bulkProcessId: number;
	newBulkId: number;
	plan: RunPlan;
	createdDate: string | null;
}

/** The report under construction, and the one door every skip goes through. */
function createReporter(requestId: string, bulkProcessId: number) {
	const skipped: BulkRevertSkipped[] = [];
	const inexact: BulkRevertInexact[] = [];
	const tally = { counter: 0, unchanged: 0, exactDone: 0 };
	/**
	 * Refuse a unit or record: the code goes on the wire, the coordinates (and
	 * a `failed` unit's error code) only when it has passed the scope gate, and
	 * the words (if any) to the log.
	 */
	const skip = (
		row: Located,
		reason: BulkRevertSkipReason,
		inScope: boolean,
		detail: string | null,
		level: 'warn' | 'error' = 'warn',
		code?: string,
	): void => {
		skipped.push(
			inScope
				? {
						reason,
						section_tipo: row.section_tipo,
						tipo: row.tipo,
						section_id: row.section_id,
						lang: row.lang,
						...(code === undefined ? {} : { code }),
					}
				: { reason },
		);
		const line = `[tool_time_machine/bulk_revert] request ${requestId}: bulk ${bulkProcessId} ${row.section_tipo}/${row.tipo}#${row.section_id} skipped (${reason})${detail === null ? '' : `: ${detail}`}`;
		if (level === 'error') console.error(line);
		else console.warn(line);
	};
	const markInexact = (row: Located, basis: BulkRevertInexactBasis): void => {
		inexact.push({ basis, ...row });
	};
	return { skipped, inexact, tally, skip, markInexact };
}

type Reporter = ReturnType<typeof createReporter>;

/**
 * Level 2 on EVERY key's (section_tipo, tipo) pair — and, for a unit of a main
 * with slots (composed or legacy), on every slot tipo it may write (the slots have no key of their own in the
 * unit, so without this a frame could be written on the main's grant alone) —
 * and the record in scope —
 * unless `recordScopeDeferred`: the unit's own record is a deleted one it
 * undeletes first, whose scope the undelete judges on the restored row
 * (bulk_revert_records.ts restoreDeletedRecord); the search cannot find a row
 * that is not there — or its record was BORN in the run and is gone
 * (goneBornAddresses: nothing to write, and nothing the search could find).
 */
async function unitInScope(
	unit: RevertUnit,
	principal: Principal,
	recordScopeDeferred: boolean,
): Promise<boolean> {
	const tipos = [...unit.keys.map((key) => key.tipo), ...unit.slotTipos];
	for (const tipo of new Set(tipos)) {
		if ((await getPermissions(principal, unit.sectionTipo, tipo)) < 2) return false;
	}
	return (
		recordScopeDeferred || principalCanAccessRecord(unit.sectionTipo, unit.sectionId, principal)
	);
}

async function executeRevert(ctx: ToolActionContext, run: RevertRun): Promise<ToolResponse> {
	const { userId, principal } = ctx;
	const requestId = toolRequestId(ctx);
	const report = createReporter(requestId, run.bulkProcessId);
	const { skip } = report;
	const { logActivity, hostFromClientIp } = await import(
		'../../../src/core/api/handlers/activity_log.ts'
	);
	const activity = { logActivity, host: hostFromClientIp(ctx.clientIp), userId };
	// The revert's units per record (newest first, the order it applies them):
	// what a cascade record is judged against (bulk_revert_records.ts producedStateOf).
	const unitsByRecord = new Map<string, RevertUnit[]>();
	for (const unit of run.plan.units) {
		const address = recordAddress(unit.sectionTipo, unit.sectionId);
		unitsByRecord.set(address, [...(unitsByRecord.get(address) ?? []), unit]);
	}
	const recordContext = {
		principal,
		userId,
		newBulkId: run.newBulkId,
		keyAddresses: run.plan.keyAddresses,
		unitsByRecord,
	};
	// Records the run created that are GONE are at their pre-run state: never
	// undeleted, never scope-searched (goneBornAddresses).
	const goneBorn = await goneBornAddresses(run.plan.births);
	const { byUnit, standalone, children } = assignCascadeMarkers(
		run.plan.units,
		run.plan.cascadeDeletes.filter(
			(marker) => !goneBorn.has(recordAddress(marker.sectionTipo, marker.sectionId)),
		),
	);

	// 4. UNDELETE the cascade targets NO unit re-links, on their own gate (D3),
	//    newest first — each WITH its nested children, as one group. A target a
	//    unit re-links is undeleted inside that unit (step 5), so the two land or
	//    roll back together.
	for (const marker of standalone) {
		await undeleteStandaloneGroup(cascadeGroup(marker, children), recordContext, report, activity);
	}

	// 5. THE UNITS, newest first — the records with a unit not reverted cleanly
	//    are BLOCKED from step 6: a skipped key may still hold the run's data. A
	//    key the plan could not place is such a unit: `failed`, located nowhere.
	const blocked = new Set<string>();
	for (const failure of run.plan.unplanned) {
		const row = { section_tipo: failure.sectionTipo, section_id: failure.sectionId, tipo: '' };
		skip(row, 'failed', false, failure.detail, 'error');
		blocked.add(recordAddress(failure.sectionTipo, failure.sectionId));
	}
	const unitContext = {
		principal,
		userId,
		newBulkId: run.newBulkId,
		runCreatedDate: run.createdDate,
		bulkId: run.bulkProcessId,
		keyAddresses: run.plan.keyAddresses,
		unitsByRecord,
		goneBorn,
	};
	// TWO sets, never one (a refused marker must not read as handled): `landed`
	// = cascade targets a committed unit really brought back (or found already
	// back) — a later unit linking them skips them; `reported` = targets whose
	// refusal is already on the report — de-duplication of the REPORT only. A
	// target that refused one unit stays pending for every other unit linking
	// it, and refuses that unit the same way: never a locator restored onto a
	// missing or foreign record because an earlier unit's refusal marked it done.
	const landed = new Set<RecordMarker>();
	const reported = new Set<RecordMarker>();
	for (const unit of run.plan.units) {
		const row = locateKey(unitReportKey(unit));
		// Set ONLY after the scope gate passes; the catch below reads it, so a
		// throw from inside the gate itself locates nothing.
		let inScope = false;
		try {
			const pending = (byUnit.get(unit) ?? []).filter((marker) => !landed.has(marker));
			// The unit's OWN record deleted (and not yet undeleted by another
			// unit): its scope is judged on the restored row, in the prelude.
			// A record born in the run and gone has no row to search: its keys are
			// unchanged (revertKey), and a row that reappears refuses the unit.
			const deferred =
				pending.some((marker) => isOwnRecord(unit, marker)) ||
				goneBorn.has(recordAddress(unit.sectionTipo, unit.sectionId));
			if (!(await unitInScope(unit, principal, deferred))) {
				skip(row, 'out_of_scope', false, null);
				blocked.add(recordAddress(unit.sectionTipo, unit.sectionId));
				continue;
			}
			inScope = !deferred;
			const result = await revertUnit(
				unit,
				unitContext,
				async () => {
					const prelude = await undeleteRelinked(unit, pending, children, landed, recordContext);
					inScope = true;
					return prelude;
				},
				revertComposedUnit,
			);
			for (const member of result.prelude) {
				landed.add(member.marker);
				await reportLanded(member, report, activity);
			}
			await afterUnitCommit(result, report, activity, run.newBulkId);
		} catch (error) {
			blocked.add(recordAddress(unit.sectionTipo, unit.sectionId));
			if (error instanceof RevertRefusal) {
				// A target that refused its unit is reported BY that refusal (located
				// at the unit, which passed its gate — never at the target, which did
				// not), not a second time below.
				if (error.marker !== undefined) reported.add(error.marker);
				const located = error.reason !== 'out_of_scope' && inScope;
				skip(locateKey(error.key), error.reason, located, error.message);
			} else {
				skip(
					row,
					'failed',
					inScope,
					error instanceof Error ? error.message : String(error),
					'error',
					failureCodeOf(error),
				);
			}
		}
	}
	// A cascade target whose every re-linking unit was refused STAYS deleted:
	// bringing it back without the link would leave a record no frame or
	// locator references — a state it was never in. Counted, never located (no
	// gate has passed for the target itself).
	// Its nested children stay deleted with it.
	reportUnlinkedTargets(byUnit, children, landed, reported, report);

	// 6. THE RECORDS BORN IN THE RUN (D2). Every marker gets its own outcome —
	//    a throw for one is that marker's `failed` (deleteBornRecords).
	const outcomes = await deleteBornRecords(run.plan.births, recordContext, blocked);
	for (const [marker, outcome] of outcomes) reportRecord(report, marker, outcome, null);

	const { skipped, inexact, tally } = report;
	const exact =
		skipped.length === 0 && inexact.length === 0
			? 'full'
			: tally.exactDone === 0
				? 'none'
				: 'partial';
	// `skipped` / `inexact` are NON-FATAL parts of the payload (the run never
	// aborts on one unit), so they ride inside `data`.
	return ok(
		{
			counter: tally.counter,
			unchanged: tally.unchanged,
			bulk_process_id: run.newBulkId,
			exact,
			skipped,
			inexact,
		},
		{ requestId },
	);
}

/**
 * One cascade target a unit's transaction handled: undeleted (`done`), found
 * already back as the snapshot says (`present`), or found back with a later
 * write it must not overwrite (`kept`).
 */
interface Relinked {
	marker: RecordMarker;
	kind: 'done' | 'present' | 'kept';
	afterCommit?: () => Promise<void>;
}

/** Report one handled cascade target, after its transaction committed. */
async function reportLanded(
	member: Relinked,
	report: Reporter,
	activity: ActivitySink,
): Promise<void> {
	await member.afterCommit?.();
	if (member.kind === 'kept') {
		// Its row exists, so its own scope gate passed (mayUndelete): located.
		report.skip(locateRecord(member.marker), 'cascade_delete_not_reverted', true, 'written since');
	} else if (member.kind === 'done') {
		report.markInexact(locateRecord(member.marker), 'cascade_undelete');
		await logRecover(activity, member.marker);
	}
}

/** Report every re-linked target (and its nested children) that never came back. */
function reportUnlinkedTargets(
	byUnit: ReadonlyMap<RevertUnit, readonly RecordMarker[]>,
	children: ReadonlyMap<RecordMarker, readonly RecordMarker[]>,
	landed: ReadonlySet<RecordMarker>,
	reported: Set<RecordMarker>,
	report: Reporter,
): void {
	for (const markers of byUnit.values()) {
		for (const marker of markers.flatMap((root) => cascadeGroup(root, children))) {
			if (landed.has(marker) || reported.has(marker)) continue;
			reported.add(marker);
			report.skip(
				locateRecord(marker),
				'cascade_delete_not_reverted',
				false,
				'its re-linking unit was not reverted',
			);
		}
	}
}

/** Thrown inside a standalone group's transaction: one member did not come back. */
class GroupRefused extends Error {
	constructor(
		readonly marker: RecordMarker,
		readonly outcome: BornOutcome,
	) {
		super(`cascade group member ${describeRecord(marker)} did not come back`);
	}
}

/**
 * Undelete a STANDALONE cascade group — a target no unit re-links, and its
 * nested children (assignCascadeMarkers) — parent first, in ONE transaction:
 * the whole group lands, or none of it does (a child that cannot come back
 * would leave the parent's restored frames pointing at a missing record; a
 * child back without its parent is an orphan). The refusing member is
 * reported by its own outcome — or, for a throw that is no typed refusal, as
 * the member that was being undeleted (`at`), never the group's first by
 * default — the rest `cascade_delete_not_reverted`; the file halves of the
 * landed members run after COMMIT.
 */
async function undeleteStandaloneGroup(
	group: readonly RecordMarker[],
	context: RecordContext,
	report: Reporter,
	activity: ActivitySink,
): Promise<void> {
	let landed: Relinked[];
	// The member being undeleted: who an untyped throw is reported against.
	let at = group[0] as RecordMarker;
	try {
		landed = await withTransaction(async () => {
			const members: Relinked[] = [];
			for (const marker of group) {
				at = marker;
				const outcome = await undeleteStandaloneRecord(marker, context);
				if (!isHandled(outcome)) throw new GroupRefused(marker, outcome);
				members.push(relinkedOf(marker, outcome));
			}
			return members;
		});
	} catch (error) {
		reportGroupFailure(group, error, at, report);
		return;
	}
	for (const member of landed) await reportLanded(member, report, activity);
}

/** An undelete outcome that leaves the record there as the run's referrers expect. */
function isHandled(
	outcome: BornOutcome,
): outcome is Extract<RecordOutcome, { kind: 'done' | 'present' | 'kept' }> {
	return outcome.kind === 'done' || outcome.kind === 'present' || outcome.kind === 'kept';
}

/** The Relinked of a handled outcome. */
function relinkedOf(
	marker: RecordMarker,
	outcome: Extract<RecordOutcome, { kind: 'done' | 'present' | 'kept' }>,
): Relinked {
	return {
		marker,
		kind: outcome.kind,
		afterCommit: outcome.kind === 'done' ? outcome.afterCommit : undefined,
	};
}

/**
 * Report a standalone group that rolled back: the cause, then every other
 * member. `at` is the member that was being undeleted when it threw.
 */
function reportGroupFailure(
	group: readonly RecordMarker[],
	error: unknown,
	at: RecordMarker,
	report: Reporter,
): void {
	const refused = error instanceof GroupRefused ? error.marker : at;
	if (error instanceof GroupRefused) {
		reportRecord(report, error.marker, error.outcome, 'cascade_undelete');
	} else {
		const detail = error instanceof Error ? error.message : String(error);
		report.skip(locateRecord(refused), 'failed', false, detail, 'error');
	}
	for (const marker of group) {
		if (marker === refused) continue;
		report.skip(
			locateRecord(marker),
			'cascade_delete_not_reverted',
			false,
			`its cascade group did not come back (${describeRecord(refused)})`,
		);
	}
}

/**
 * The prelude of a unit's transaction: undelete the cascade targets it
 * re-links (newest first), each followed by its nested children (parent
 * first). A target — or a child of one — that cannot come back (its address
 * taken again by another record, its section not writable, out of scope)
 * REFUSES the whole unit, so no frame or locator is restored onto a missing or
 * foreign record and no child comes back without its parent. A target whose
 * row is still there AS THE SAME RECORD (birth identity) never refuses: its
 * keys are put back, or left as a later write left them (`kept`, reported at
 * the record), or it is already back (`present`, a repeat revert).
 */
async function undeleteRelinked(
	unit: RevertUnit,
	markers: readonly RecordMarker[],
	children: ReadonlyMap<RecordMarker, readonly RecordMarker[]>,
	landed: ReadonlySet<RecordMarker>,
	context: RecordContext,
): Promise<Relinked[]> {
	const prelude: Relinked[] = [];
	const key = unitReportKey(unit);
	for (const root of markers) {
		for (const marker of cascadeGroup(root, children)) {
			if (landed.has(marker)) continue;
			prelude.push(await undeleteForUnit(key, marker, context));
		}
	}
	return prelude;
}

/**
 * One member of a unit's prelude. EVERY member — a target the unit links
 * directly, the unit's own record, a nested child — is judged on its OWN
 * record scope (the restored row's, inside the unit's transaction): the
 * unit's gate judged the unit's record, never the target's (cross-write:r2).
 */
async function undeleteForUnit(
	key: RevertKey,
	marker: RecordMarker,
	context: RecordContext,
): Promise<Relinked> {
	const outcome = await undeleteCascadeRecord(marker, context);
	if (outcome.kind === 'out_of_scope') {
		throw new RevertRefusal(
			'out_of_scope',
			key,
			`cascade target ${describeRecord(marker)} out of scope`,
			marker,
		);
	}
	if (outcome.kind === 'refused') {
		throw new RevertRefusal(
			outcome.reason,
			key,
			`cascade target ${describeRecord(marker)} could not be undeleted`,
			marker,
		);
	}
	return relinkedOf(marker, outcome);
}

/** A record marker's coordinates for the LOG. */
function describeRecord(marker: RecordMarker): string {
	return `${marker.sectionTipo}#${marker.sectionId}`;
}

/** Map one record marker's outcome onto the report. */
function reportRecord(
	report: Reporter,
	marker: RecordMarker,
	outcome: BornOutcome,
	doneBasis: BulkRevertInexactBasis | null,
): void {
	const row = locateRecord(marker);
	if (outcome.kind === 'out_of_scope') report.skip(row, outcome.kind, false, null);
	// Located only when its scope gate (bornGate) passed before the throw.
	else if (outcome.kind === 'failed')
		report.skip(row, 'failed', outcome.located, outcome.detail, 'error', outcome.code);
	// Located only when the record's scope was judged before the refusal (SEC-16).
	else if (outcome.kind === 'refused') report.skip(row, outcome.reason, outcome.located, null);
	else if (outcome.kind === 'kept') report.skip(row, 'cascade_delete_not_reverted', true, null);
	else if (outcome.kind === 'present') return;
	else if (doneBasis !== null) report.markInexact(row, doneBasis);
	else report.tally.exactDone += 1;
}

interface ActivitySink {
	logActivity: typeof logActivityType;
	host: string;
	userId: number;
}

/**
 * POST-COMMIT for one unit: ONE activity row PER WRITTEN KEY — PHP logs inside
 * its loop too (tool_time_machine :419). The observer cascade of the unit's
 * keys is not fired here: every key went through the write chokepoint, whose
 * obligation ledger drained it after the unit's COMMIT (CLOSURE_PLAN Step 2).
 */
async function afterUnitCommit(
	result: UnitResult,
	report: Reporter,
	activity: ActivitySink,
	newBulkId: number,
): Promise<void> {
	// `counter` counts UNITS written; `unchanged` counts KEYS already at their
	// pre-run value (WC …-bulk-revert-undo-log §5) — a unit with some keys
	// written and some unchanged adds to both.
	if (result.written.length > 0) report.tally.counter += 1;
	report.tally.unchanged += result.unchanged;
	report.tally.exactDone += result.unchanged;
	for (const written of result.written) {
		const { key } = written;
		if (written.inexact === null) report.tally.exactDone += 1;
		else report.markInexact(locateKey(key), written.inexact);
		await activity.logActivity({
			what: 'RECOVER COMPONENT',
			tipo: key.sectionTipo, // WHERE = the SECTION tipo (PHP), not the component
			userId: activity.userId,
			host: activity.host,
			data: {
				msg: 'Recovered component data from time machine',
				model: key.model,
				section_id: key.sectionId,
				section_tipo: key.sectionTipo,
				table: written.table,
				tm_id: newBulkId,
			},
		});
	}
}

/** The RECOVER SECTION activity row of an undeleted record. */
async function logRecover(activity: ActivitySink, marker: RecordMarker): Promise<void> {
	await activity.logActivity({
		what: 'RECOVER SECTION',
		tipo: marker.sectionTipo,
		userId: activity.userId,
		host: activity.host,
		data: {
			msg: 'Recovered section record from time machine',
			section_id: marker.sectionId,
			section_tipo: marker.sectionTipo,
			tm_id: marker.row.id,
		},
	});
}
