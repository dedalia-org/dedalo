/**
 * tool_time_machine.apply_value — restore one historical snapshot (a
 * matrix_time_machine row, identified by its own PK `matrix_id`) back into
 * the live record (PHP tools/tool_time_machine::apply_value).
 *
 * COMPONENT branch (the client's "Apply and save" button): the TM row's data
 * overwrites the component's live value, after stripping dataframe frame
 * entries from the main data — a TM snapshot of a dataframe-paired component
 * carries BOTH the main items and dd490 frame objects, and restoring a frame
 * into the main column corrupts it (this strip applies to literal mains too,
 * not only relation models — the historical relation-only filter leaked
 * locators into literal columns). Every model, component_iri included, splits
 * by the one frame predicate (splitComposed) — an iri-key filter dropped v6
 * title-only iri items along with the frames. The stripped-out frames are NOT
 * discarded: they are replayed into their `component_dataframe` slots FIRST
 * (dataframe_restore.ts — PHP's set_time_machine_data sequence), because a
 * main restored without its frames leaves orphan pairings behind. The restore
 * then writes a fresh TM audit row carrying main + frames, so the restore
 * itself is revertible (PHP: "the new save immediately creates a fresh TM
 * entry"; component restores do NOT delete the consumed TM row). The observer
 * cascade every PHP `element->save()` fired is the write chokepoint's own
 * obligation (section_record/record_write.ts §3e — the ledger drains it after
 * COMMIT, from the before-image read under the row lock), for this branch and
 * the section branch alike.
 *
 * SECTION branch (recover a whole deleted/edited record): the TM snapshot's
 * data is a full matrix-columns object; it overwrites the live record via the
 * write chokepoint (PHP element->set_data + save()). Every component the
 * restore CHANGES on a live record asks the same write door as the component
 * branch (the dd128-aware pair — cross-write:r3); an undelete (no live row) is
 * a record lifecycle effect, authorized at the section. LEDGERED vs PHP (no
 * fixture / no TS twin): deleted-media relink, the session-SQO reset (TS has no
 * PHP session), and the TM-row consumption (PHP deletes the restored snapshot;
 * TS keeps it — the recover writes its own whole-record audit row, which
 * supersedes it in the list and closes its bound).
 *
 * UNCOVERED SCOPE (denied loudly, never guessed): restoring a TM row whose own
 * tipo IS a `component_dataframe` slot — with or without `caller_dataframe`. No
 * supported history has one (PHP never wrote a slot row; a slot's frames ride in
 * its main's composed row), and for such a row the snapshot's dd490 entries ARE
 * the value, so the shared `splitComposed().main` would reduce it to nothing and
 * the restore would silently WIPE the slot. The door refuses instead.
 *
 * TWO LANES (WC-2026-09-27-bulk-revert-undo-log addendum): a row of a main is
 * ONE lane. The restore puts the row's OWN lane back (a language row's value
 * merged over the live other languages; an lg-nolan row's lg-nolan items) and
 * the frames AS OF the row (tm_record/lane_state.ts — the row itself when it is
 * a frame state, else the newest frame-state row below it (lg-nolan, or a v6 row
 * carrying frames); none = no frames then:
 * the main's own frames are EMPTIED; other mains' frames of a shared slot stay
 * — decision D-A). A frame of an item that existed at the row and exists no
 * more is never written back. No refusal.
 *
 * A FRAMES-ONLY row (relations/dataframe_slots.ts isFramesOnlyImage — a v6
 * slot save of a translatable main, tagged lg-nolan) restores the frames only:
 * the main stays live, and the restore's history is its one lg-nolan row.
 *
 * A frame naming a tipo that is NOT a live dataframe slot is NOT refused: PHP's
 * per-slot filter matches it nowhere either, so it restores nothing and is
 * stripped out of the main data (see dataframe_restore.ts's header).
 */

import { dbTimestamp } from '../../../src/core/db/db_timestamp.ts';
import type { MatrixJsonbColumn } from '../../../src/core/db/matrix.ts';
import { MATRIX_JSONB_COLUMNS, readMatrixRecord } from '../../../src/core/db/matrix.ts';
import {
	absorbComponentItemIds,
	readMatrixKeyForUpdate,
} from '../../../src/core/db/matrix_write.ts';
import { withTransaction } from '../../../src/core/db/postgres.ts';
import { recordEpoch } from '../../../src/core/db/record_generation.ts';
import {
	readOtherLangItemIds,
	readTimeMachineRow,
	recordTimeMachine,
	type TmCoords,
} from '../../../src/core/db/time_machine.ts';
import { DedaloError, ok } from '../../../src/core/errors/index.ts';
import { restoreDeletedSectionMediaFiles } from '../../../src/core/media/file_ops.ts';
import {
	effectiveSaveLang,
	getColumnNameByModel,
	getMatrixTableFromTipo,
	getModelByTipo,
} from '../../../src/core/ontology/resolver.ts';
import {
	heldItemIds,
	mainIdentity,
	readMainState,
	recordMainHistory,
	rowSlotTipos,
} from '../../../src/core/relations/dataframe_slots.ts';
import { NOLAN } from '../../../src/core/relations/main_lanes.ts';
import {
	type ChangedKeysDoor,
	persistRecordBirth,
	persistRecordColumns,
	persistRestoredKeys,
} from '../../../src/core/section_record/index.ts';
import { principalCanAccessRecord } from '../../../src/core/security/record_scope.ts';
import { authorizeRecordAccess } from '../../../src/core/security/write_door.ts';
import { readRowLaneState, restoredLaneValue } from '../../../src/core/tm_record/lane_state.ts';
import { restorableRelationValue } from '../../../src/core/tm_record/relation_snapshot_shape.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	toolRequestId,
} from '../../../src/core/tools/module.ts';
import { normalizeRestoredSectionIds } from '../../../src/core/update/transform/section_id_restore.ts';
import {
	applyDataframeRestore,
	DataframeRestoreError,
	type DataframeSlotRestore,
	type FrameSlice,
	planDataframeRestore,
} from './dataframe_restore.ts';

/**
 * SECTION restore (PHP apply_value model==='section'): the snapshot is a full
 * matrix-columns object; overwrite the live record's columns through the write
 * chokepoint (PHP element->set_data + save(), which stamps the modified audit).
 * Structural 'id' is not a column; every jsonb column present in the snapshot
 * is written (including 'data' section metadata — PHP set_data replaces all).
 *
 * THE UNDELETE DOOR: also the bulk revert's (bulk_revert_records.ts) for a
 * record a revert's D2 deleted, when that revert is reverted — one restore of a whole record,
 * files included, not two. `tmId` is the snapshot row's id, for the refusal.
 *
 * `door`: the caller's write door for every component the restore CHANGES on a
 * live record (persistRecordColumns — asked behind the row lock; a throw rolls
 * the restore back). apply_value passes the dd128-aware one; an engine caller
 * that already authorized the whole record passes none.
 */
export async function restoreSection(
	snapshot: unknown,
	tmId: number,
	sectionTipo: string,
	sectionId: number,
	userId: number,
	door?: ChangedKeysDoor,
): Promise<void> {
	const columns = await withTransaction(async () => {
		const written = await restoreSectionRow(snapshot, tmId, sectionTipo, sectionId, userId, door);
		await recordRecoverRow(sectionTipo, sectionId, userId);
		return written;
	});
	await restoreSectionMedia(sectionTipo, sectionId, columns);
	// LEDGERED (no TS twin / no fixture): session-SQO reset, and consuming
	// (deleting) the restored TM row.
}

/**
 * THE RECOVER'S OWN AUDIT ROW: one whole-record TM row (tipo = section_tipo,
 * lg-nolan, data = the record AS WRITTEN — the archive restore's shape), in
 * the restore's transaction. It makes the recover revertible and listed, and
 * it is what classifies the snapshot it restored: a whole-record row followed
 * by another whole-record row is a DELETE (frame_as_of.ts wholeRowIsDelete),
 * so the deleted record's snapshot keeps previewing its frame children as of
 * the delete, never the delete_target-wiped live state.
 */
async function recordRecoverRow(
	sectionTipo: string,
	sectionId: number,
	userId: number,
): Promise<void> {
	const table = (await getMatrixTableFromTipo(sectionTipo)) ?? 'matrix';
	const record = await readMatrixRecord(table, sectionTipo, sectionId);
	if (record === null) return;
	await recordTimeMachine(
		{
			sectionTipo,
			sectionId,
			componentTipo: sectionTipo,
			lang: 'lg-nolan',
			userId,
			data: { ...record.columns },
		},
		dbTimestamp(new Date()),
	);
}

/**
 * The ROW half of {@link restoreSection}: write the snapshot's jsonb columns
 * back (section ids converged, see below) and answer the snapshot's columns.
 * Through the whole-record chokepoint (section_record/record_write.ts
 * persistRecordColumns), which owns every derived write (§3e): the
 * `relation_search` index re-derived for the `_hi` keys the restore touches
 * (the snapshot's is the chain of its day), the covered observer slots kept
 * LIVE and recomputed (a snapshot's mirror is whoever referenced the record
 * THEN), and the observer cascade of every key it replaces — its before-image
 * read under the row lock. An absent row makes it an undelete (a birth at the
 * address). CORE-1 was this door writing the row and remembering none of it.
 * Joins an ambient transaction — the bulk revert undeletes a cascade target
 * (a record a revert's D2 deleted) inside the transaction of the unit that re-links it, so a refused unit rolls
 * the undelete back with it. The FILE half ({@link restoreSectionMedia}) must
 * then run after that transaction commits.
 */
export async function restoreSectionRow(
	snapshot: unknown,
	tmId: number,
	sectionTipo: string,
	sectionId: number,
	userId: number,
	door?: ChangedKeysDoor,
): Promise<Partial<Record<MatrixJsonbColumn, unknown>>> {
	const { table, columns } = await snapshotColumns(snapshot, tmId, sectionTipo, sectionId);
	await persistRecordColumns(
		{ table, sectionTipo, sectionId },
		columns,
		{ userId },
		{ actor: userId },
		door,
	);
	return columns;
}

/**
 * The INSERT-ONLY twin of {@link restoreSectionRow}: put the snapshot back
 * ONLY where the address is empty, and answer `null` — nothing written — when
 * something stands there (a record created at that explicit id since the
 * delete). The upsert of restoreSectionRow would overwrite it. The existence
 * test IS the insert (ON CONFLICT DO NOTHING under the explicit-id advisory
 * lock), so there is no window between a check and the write. The bulk
 * revert's cascade undelete.
 *
 * `stamp: false` writes the snapshot VERBATIM — no dd197/dd201 stamp. The bulk
 * revert's undeletes pass it: the snapshot carries its own stamps, and a run
 * may own them (a CSV import carrying dd197/dd201 columns has undo pairs on
 * those keys). Stamping "now" there made every stamp unit of the undeleted
 * record refuse `changed_since_run`, so reverting a revert was not exact.
 * `actor` is who the undelete's observer recomputes are attributed to — a
 * verbatim row still has an actor.
 *
 * ONE insert through the chokepoint's birth entry (persistRecordBirth): the
 * covered observer slots left out and recomputed from truth, the `_hi` index
 * re-derived from today's thesaurus (the snapshot's is the delete-time chain),
 * the record's edges declared to the observer ledger — every target's mirror
 * lists the record again (CORE-1). Answers the columns AS WRITTEN.
 */
export async function restoreAbsentSectionRow(
	snapshot: unknown,
	tmId: number,
	sectionTipo: string,
	sectionId: number,
	stamp: { userId: number } | false,
	actor: number,
): Promise<Partial<Record<MatrixJsonbColumn, unknown>> | null> {
	const { table, columns } = await snapshotColumns(snapshot, tmId, sectionTipo, sectionId);
	return (await persistRecordBirth({ table, sectionTipo, sectionId }, columns, stamp, {
		actor,
	})) as Partial<Record<MatrixJsonbColumn, unknown>> | null;
}

/** A TM section snapshot's jsonb columns (section ids converged), and its table. */
async function snapshotColumns(
	snapshot: unknown,
	tmId: number,
	sectionTipo: string,
	sectionId: number,
): Promise<{ table: string; columns: Partial<Record<MatrixJsonbColumn, unknown>> }> {
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === null) {
		throw new DedaloError('request.invalid_model', {
			coordinates: { section_tipo: sectionTipo },
			message: `No matrix table for '${sectionTipo}'`,
		});
	}
	if (snapshot === null || typeof snapshot !== 'object') {
		throw new DedaloError('tool.target_not_found', {
			coordinates: { section_tipo: sectionTipo, section_id: sectionId, tm_id: tmId },
			message: 'The TM section snapshot is empty',
		});
	}
	const columns: Partial<Record<MatrixJsonbColumn, unknown>> = {};
	for (const [column, value] of Object.entries(snapshot as Record<string, unknown>)) {
		if (MATRIX_JSONB_COLUMNS.includes(column as MatrixJsonbColumn)) {
			columns[column as MatrixJsonbColumn] = value;
		}
	}
	// section_id int-canonical convergence (WC-2026-08-10-section-id-int-canonical, D6.2): TM snapshots — and any pre-migration backup restored
	// into a post-migration install — carry string-form locator addresses; a
	// verbatim write would re-inject them forever. The kernel converts what the
	// sweep would convert (external remote ids and junk pass verbatim), so
	// restores CONVERGE on the canonical form instead of undoing the sweep.
	await normalizeRestoredSectionIds(columns);
	if (columns.relation !== undefined) {
		columns.relation = restorableRelationColumn(columns.relation, tmId, sectionTipo, sectionId);
	}
	return { table, columns };
}

/**
 * A whole-record snapshot's `relation` column through the relation shape gate
 * (tm_record/relation_snapshot_shape.ts), key by key: one non-locator value
 * refuses the WHOLE restore (`tool.snapshot_unrestorable`) before anything is
 * written — never a live relation key holding a non-locator. A single locator
 * object is written as `[locator]`. Absent / non-object column → verbatim.
 */
function restorableRelationColumn(
	relation: unknown,
	tmId: number,
	sectionTipo: string,
	sectionId: number,
): unknown {
	if (relation === null || typeof relation !== 'object' || Array.isArray(relation)) {
		return relation;
	}
	const restored: Record<string, unknown> = {};
	for (const [tipo, value] of Object.entries(relation as Record<string, unknown>)) {
		restored[tipo] = restorableRelationValue(value, {
			tm_id: tmId,
			section_tipo: sectionTipo,
			section_id: sectionId,
			tipo,
		});
	}
	return restored;
}

/**
 * The FILE half of {@link restoreSection} (P1-11 / LIFE-08). The delete moved
 * every managed file of every media component into its quality dir's
 * `deleted/` sub-folder — a move, never a hard delete, precisely so this step
 * can undo it. Without it the restored record's media column points at live
 * paths holding NO FILES and the restore still answers ok:true: the row is
 * back, the objects are not, and only opening the record shows it.
 *
 * POST-PERSIST (after COMMIT when the row half ran in a transaction) and
 * unwrapped, matching the delete's own post-commit half: the row must be back
 * before the files are, and a media failure must not undo a restore that
 * landed. `restoreDeletedSectionMediaFiles` never overwrites a live file — an
 * operator may have re-uploaded since, and silently replacing the newer file
 * with the pre-delete one is the one outcome nothing can undo.
 */
export async function restoreSectionMedia(
	sectionTipo: string,
	sectionId: number,
	columns: Partial<Record<MatrixJsonbColumn, unknown>>,
): Promise<void> {
	try {
		const mediaColumn = columns.media as Record<string, unknown[]> | null | undefined;
		const outcome = await restoreDeletedSectionMediaFiles(sectionTipo, sectionId, mediaColumn);
		if (outcome.errors.length > 0) {
			console.error(
				`[tool_time_machine] media restore for ${sectionTipo}/${sectionId} reported: ${outcome.errors.join('; ')}`,
			);
		}
	} catch (error) {
		// Never fail a landed restore on the file half — say it loudly instead.
		console.error(
			`[tool_time_machine] media restore for ${sectionTipo}/${sectionId} FAILED: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * The frame plan of a restored row. The row is the FULL state of the main and
 * all its dataframes: every slot it is silent about was empty then, and is
 * emptied — the live record's slots of the main included (rowSlotTipos). Read
 * behind the caller's row lock. An unplaceable frame refuses the restore; the
 * refusal sentence names slot tipos — LOG-only (the code's disclosure is
 * 'operator'), never echoed on the wire.
 */
async function planRowFrames(
	tipo: string,
	snapshot: unknown,
	target: { table: string; sectionTipo: string; sectionId: number },
): Promise<DataframeSlotRestore[]> {
	try {
		return await planDataframeRestore(tipo, snapshot, await rowSlotTipos(tipo, [snapshot], target));
	} catch (error) {
		if (!(error instanceof DataframeRestoreError)) throw error;
		throw new DedaloError('engine.uncovered_scope', {
			cause: error,
			coordinates: { tipo, section_tipo: target.sectionTipo },
			message: error.message,
		});
	}
}

/**
 * Append the RECOVER SECTION / RECOVER COMPONENT activity row (dd42 codes
 * 13/14, PHP tool_time_machine :99 / :213 / :419).
 *
 * (!) The WHERE tipo is the SECTION tipo for BOTH — including a component
 * restore, whose own tipo goes unused. That is PHP's behaviour at all three
 * call sites, not an oversight here.
 */
async function logRecoverActivity(
	context: ToolActionContext,
	what: 'RECOVER SECTION' | 'RECOVER COMPONENT',
	payload: Record<string, unknown>,
	sectionTipo: string,
): Promise<void> {
	const { logActivity, hostFromClientIp } = await import(
		'../../../src/core/api/handlers/activity_log.ts'
	);
	await logActivity({
		what,
		tipo: sectionTipo,
		userId: context.userId,
		host: hostFromClientIp(context.clientIp),
		data: payload,
	});
}

/** A snapshot with its section ids int-canonical (WC-2026-08-10 D6.2). */
async function canonicalImage(data: unknown): Promise<unknown> {
	const container = { value: data };
	await normalizeRestoredSectionIds(container);
	return container.value;
}

/**
 * The frame scope of a row restore (dataframe_restore.ts FrameSlice): no live
 * frame is kept (the frame state as of the row replaces this main's frames),
 * and a recorded frame is STALE — never written back — when its item existed
 * in any language at the row OR at the frame-state row the frames came from
 * (time_machine.ts readOtherLangItemIds, every lane, the frame-first proof at
 * each row) and the restored value no longer holds it. The second row matters
 * for a frameless PHP language row that dropped the only framed item: its
 * frames come from an older row that still held the item — judged at the
 * restored row alone, the item is "proven absent" and its frame would come
 * back as an orphan. A frame saved before its item comes back.
 */
async function rowFrameSlice(
	coords: TmCoords,
	rows: { rowId: number; frameRowId: number | null },
	restoredValue: unknown,
	sliced: boolean,
): Promise<FrameSlice> {
	const known = await readOtherLangItemIds(coords, [], rows.rowId, !sliced);
	if (rows.frameRowId !== null && rows.frameRowId !== rows.rowId) {
		for (const id of await readOtherLangItemIds(coords, [], rows.frameRowId, !sliced))
			known.add(id);
	}
	return { survivorIds: new Set(), otherLangIds: known, heldIds: heldItemIds(restoredValue) };
}

/**
 * apply_value's write door for ONE component of the target record (the main,
 * or a dataframe slot its restore writes): write, level 2, section floor 1,
 * the dd128-aware pair, the write scope. THROWS the door's perm.* refusal —
 * inside the restore's transaction, which rolls back with it.
 */
async function authorizeComponentWrite(
	context: ToolActionContext,
	sectionTipo: string,
	sectionId: number,
	componentTipo: string,
): Promise<void> {
	await authorizeRecordAccess(
		context.principal,
		{ section_tipo: sectionTipo, component_tipo: componentTipo, section_id: sectionId },
		{ mode: 'write', level: 2, sectionFloor: 1, door: 'tool_time_machine.apply_value' },
	);
}

export async function toolTimeMachineApplyValue(context: ToolActionContext): Promise<ToolResponse> {
	const { options, userId } = context;
	const sectionTipo = String(options.section_tipo ?? '');
	const sectionId = Number(options.section_id ?? 0);
	const tipo = String(options.tipo ?? '');
	const lang = String(options.lang ?? 'lg-nolan');
	const matrixId = options.matrix_id;

	if (sectionTipo === '' || tipo === '' || matrixId === null || matrixId === undefined) {
		throw new DedaloError('request.invalid_options', {
			publicMessage: 'section_tipo, tipo and matrix_id are required',
		});
	}

	const model = await getModelByTipo(tipo);
	if (model === null) {
		throw new DedaloError('request.invalid_tipo', { coordinates: { tipo } });
	}
	if (model !== 'section' && !model.startsWith('component_')) {
		throw new DedaloError('request.invalid_model', {
			coordinates: { tipo, model },
			message: `apply_value for model '${model}' is not restorable`,
		});
	}
	// SEC-024 §9.4 — PER-RECORD scope. The declarative module gate ('tipo',
	// level 2) authorizes the (section_tipo, tipo) SCHEMA pair; it says nothing
	// about the caller-supplied section_id, and the TM row lookup applies no
	// projects filter of its own. Without this a level-2 user restores a
	// historical snapshot into a record outside their filter_by_projects scope
	// (PHP asserts security::assert_record_in_user_scope here — it was the ONLY
	// gate of the two that this port dropped). PHP skips it for an empty
	// section_id; so do we — the TM target match below refuses those anyway.
	if (
		sectionId > 0 &&
		!(await principalCanAccessRecord(sectionTipo, sectionId, context.principal))
	) {
		throw new DedaloError('perm.out_of_scope', {
			coordinates: { section_tipo: sectionTipo, section_id: sectionId },
		});
	}
	if (options.caller_dataframe !== null && options.caller_dataframe !== undefined) {
		// Dataframe SLOT restore is uncovered scope (no fixture to gate it).
		throw new DedaloError('engine.uncovered_scope', {
			coordinates: { tipo, section_tipo: sectionTipo },
			message: 'apply_value with caller_dataframe is uncovered scope on this server (ledgered)',
		});
	}

	// TM row lookup — matrix_id is the PK of matrix_time_machine (shared reader).
	const tmRow = await readTimeMachineRow(Number(matrixId));
	if (tmRow === null) {
		throw new DedaloError('tool.target_not_found', {
			coordinates: { tm_id: String(matrixId) },
			message: `TM row not found: ${String(matrixId)}`,
		});
	}
	// The snapshot must belong to the requested target — a mismatched matrix_id
	// would restore another record's history into this one.
	//
	// (!) The address is NOT enough (P0-14). Where a section_id was re-minted, a
	// DEAD record's snapshots carry the living record's exact coordinates, so
	// this check passed and the restore wrote the dead record's values in with
	// ok:true. The record's generation epoch is the second half of its identity:
	// rows below it belong to whoever held the address before.
	const epoch = await recordEpoch(sectionTipo, sectionId);
	if (
		tmRow.section_tipo !== sectionTipo ||
		tmRow.section_id !== sectionId ||
		tmRow.tipo !== tipo ||
		tmRow.id < epoch
	) {
		throw new DedaloError('request.invalid_options', {
			publicMessage: 'matrix_id does not belong to the requested target',
			coordinates: { tm_id: String(matrixId), section_tipo: sectionTipo, tipo },
		});
	}

	// SECTION restore: overwrite the whole record from the snapshot columns.
	if (model === 'section') {
		// THE WRITE DOOR of every component the restore CHANGES (cross-write:r3):
		// the declarative 'tipo' gate read the (section, section) pair, which names
		// no component — so on dd128 the own-record downgrade never applied, and a
		// user-manager wrote their own old profile / admin flag back through a
		// whole-record row. Asked behind the row lock, before anything is written;
		// a refusal rolls the restore back. An unchanged key is never asked.
		const door: ChangedKeysDoor = async (componentTipos) => {
			for (const componentTipo of componentTipos) {
				await authorizeComponentWrite(context, sectionTipo, sectionId, componentTipo);
			}
		};
		// Throws on refusal (the dispatch catch converts), so the activity row is
		// appended only for a restore that actually landed.
		await restoreSection(tmRow.data, tmRow.id, sectionTipo, sectionId, userId, door);
		await logRecoverActivity(
			context,
			'RECOVER SECTION',
			{
				msg: 'Recovered section record from time machine',
				section_id: sectionId,
				section_tipo: sectionTipo,
				top_id: sectionId,
				top_tipo: sectionTipo,
				table: (await getMatrixTableFromTipo(sectionTipo)) ?? 'matrix',
				tm_id: matrixId,
			},
			sectionTipo,
		);
		return ok(true, { requestId: toolRequestId(context) });
	}

	// COMPONENT restore.
	if (model === 'component_dataframe') {
		// See the header: the shared preview/restore strip empties a slot's own
		// snapshot, so restoring it would silently delete the slot.
		throw new DedaloError('engine.uncovered_scope', {
			coordinates: { tipo, model },
			message:
				`apply_value on a component_dataframe slot ('${tipo}') is uncovered scope on this ` +
				'server: the shared time-machine strip would write an empty slot (ledgered)',
		});
	}

	// THE WRITE DOOR of the MAIN (cross-write:r2): the declarative 'tipo' gate
	// reads the raw (section, tipo) pair; the door adds the dd128 own-record
	// rule and the write scope (the non-positive-id refusal ahead of the admin
	// bypass). Each slot the restore writes asks the same door, below.
	await authorizeComponentWrite(context, sectionTipo, sectionId, tipo);

	// int-canonical convergence on the WHOLE snapshot (D6.2 — see restoreSection),
	// BEFORE the strip and the frame plan below: the frames replayed into the
	// slots are stored addresses too, so normalizing only the main would write
	// the main int-form and its frames string-form — half a convergence, and the
	// legacy form re-injected on exactly the rows the sweep just fixed.
	const canonicalRow = { ...tmRow, data: await canonicalImage(tmRow.data) };
	// THE RELATION SHAPE GATE (WC-2026-10-24-tm-malformed-relation-cell): a
	// relation snapshot that is not a locator array (a pre-v6 bare id, label
	// strings…) is REFUSED before anything is locked or written — restored, it
	// would put a non-locator into the live relation column. No conversion.
	if (getColumnNameByModel(model) === 'relation') {
		canonicalRow.data = restorableRelationValue(canonicalRow.data, {
			tm_id: tmRow.id,
			section_tipo: sectionTipo,
			section_id: sectionId,
			tipo,
		});
	}

	// Overwrite the live component value.
	const column = getColumnNameByModel(model);
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (column === null || table === null) {
		throw new DedaloError('request.invalid_model', {
			coordinates: { model, section_tipo: sectionTipo },
			message: `No matrix column/table for '${model}' / '${sectionTipo}'`,
		});
	}
	const writeTarget = { table, sectionTipo, sectionId };
	// THE LANE LAW of this main (relations/main_lanes.ts): the write engine's
	// own `isLangSlicedModel` (save_component.ts, PHP supports_translation &&
	// !is_relation) — never the ontology `translatable` flag alone, which
	// mis-slices an ontology-non-translatable input_text (it slices on the
	// `lg-nolan` the engine normalizes it to) — and, for a SLICED model only, the
	// translatable flag, which decides whether the lg-nolan lane holds a value.
	// An unsliced main (every relation) has one lane, lg-nolan (main_lanes.ts
	// laneLaw, decision 2026-09-29).
	const identity = await mainIdentity(tipo, lang);
	// The request's effective lang — the save path's rule (resolver.ts
	// effectiveSaveLang). Only the FALLBACK for a pre-migration row with no
	// `lang`: the lane a restore speaks for is the ROW's own (DATA-03 — a caller
	// may hand a Spanish row with `lang: lg-eng`; tagging the restore with the
	// request lang filed it in a timeline the restore did not touch).
	const fallbackLang = await effectiveSaveLang(tipo, model, lang);

	// What the restore WRITES, computed under the row lock below.
	let restoredValue: unknown = null;

	await withTransaction(async () => {
		// THE ROW LOCK, FIRST AND UNCONDITIONALLY (P1-9 / DATA-30): everything the
		// plan depends on is read INSIDE the transaction and BEHIND the lock.
		await readMatrixKeyForUpdate(table, sectionTipo, sectionId, column as MatrixJsonbColumn, tipo);
		const before = await readMainState(writeTarget, identity);
		// THE STATE AT THE ROW (two lanes — tm_record/lane_state.ts, the reader
		// the preview shares): the row's own lane value, and the frame state AS OF
		// the row (the row itself when it is one — an lg-nolan row, a PHP row
		// carrying frames — else the newest frame-state row below it: lg-nolan,
		// or a v6 row carrying frames).
		const state = await readRowLaneState({
			coords: { sectionTipo, sectionId, componentTipo: tipo },
			row: canonicalRow,
			law: identity,
			fallbackLang,
		});
		// The FRAME half (PHP apply_value :277-333), planned behind the lock and
		// before anything is written, so an unplaceable frame refuses the whole
		// restore instead of leaving the record half-restored.
		const frameImage = await canonicalImage(state.frameImage);
		const framePlan = await planRowFrames(tipo, frameImage, writeTarget);
		restoredValue = restoredLaneValue(before.value, state, identity);
		// Frames FIRST (PHP restores the slots before saving the main) — THIS
		// main's frames only (a shared slot's other mains stay live, as the
		// preview shows them): the frame state as of the row, minus the frame of
		// an item that existed then and no longer exists in any language
		// (dataframe_slots.ts isStaleItemFrame) — never an orphan.
		await applyDataframeRestore(
			writeTarget,
			tipo,
			framePlan,
			await rowFrameSlice(
				{ sectionTipo, sectionId, componentTipo: tipo },
				{ rowId: tmRow.id, frameRowId: state.frameRowId },
				restoredValue,
				identity.sliced,
			),
			userId,
			// THE WRITE DOOR of each slot the restore writes (cross-write:r2): the
			// module gate authorized the MAIN pair only — a slot is its own
			// component, never written on the main's grant.
			(slotTipo) => authorizeComponentWrite(context, sectionTipo, sectionId, slotTipo),
		);
		// Chokepoint write, the COMPONENT-RESTORE entry: restored value + the
		// record's modified stamps + the save law's relation_search in one update
		// (PHP: apply_value restores via element->save(), which stamps, indexes
		// and — post-commit, through the ledger — propagates to the observers,
		// diffed against what is WRITTEN: fed the slice, it would report every
		// surviving sibling language as a removed target). A COVERED OBSERVER
		// MIRROR's history row is a past DERIVATION: its value (and the frames
		// paired to its items) stands for this transaction, is never propagated,
		// and the slot converges on truth after COMMIT — a referencer that left
		// since is never written back as a phantom (record_write §3e).
		await persistRestoredKeys(
			writeTarget,
			[{ column: column as MatrixJsonbColumn, key: tipo, value: restoredValue }],
			{ userId },
			{ actor: userId },
		);
		// Restored items carry explicit ids; raise the counter so a later insert
		// cannot mint a duplicate (PHP raises on every set_data). For a
		// dataframe-paired main this is load-bearing: a duplicated main item id
		// would make two items answer to the same frame `id_key`.
		await absorbComponentItemIds(
			table,
			sectionTipo,
			sectionId,
			tipo,
			Array.isArray(restoredValue) ? restoredValue : [],
		);
		// Fresh TM audit for the restore itself (PHP: the component save creates a
		// new TM entry; the consumed row is kept), through the capture's own writer
		// (relations/dataframe_slots.ts recordMainHistory — two lanes): the
		// restored lane's row (its value only — one row is one language), and the
		// lg-nolan row (lg-nolan value + every slot's frames after the restore)
		// when the restore changed it — so reverting the restore brings the frames
		// back with it. A frames-only restore's door lane is the frame lane.
		const after = await readMainState(
			writeTarget,
			identity,
			framePlan.map((restore) => restore.slotTipo),
		);
		await recordMainHistory(
			writeTarget,
			{ ...identity, lang: state.own.recorded ? state.rowLane : NOLAN },
			{ before, after },
			{ userId, timestamp: dbTimestamp(), bulkId: null },
		);
	});
	await logRecoverActivity(
		context,
		'RECOVER COMPONENT',
		{
			msg: 'Recovered component data from time machine',
			model,
			section_id: sectionId,
			section_tipo: sectionTipo,
			table,
			tm_id: matrixId,
		},
		sectionTipo,
	);

	return ok(true, { requestId: toolRequestId(context) });
}
