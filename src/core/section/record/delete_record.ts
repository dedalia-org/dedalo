/**
 * Section record deletion (PHP dd_core_api::delete → sections::delete →
 * section_record::delete, delete_mode 'delete_record').
 *
 * delete_record removes the whole record, and BEFORE removing it writes a
 * Time Machine snapshot of the record's full data (every matrix jsonb column)
 * under the section tipo — the audit point that lets the record be recovered.
 *
 * Covered: the TM snapshot + row removal, inverse-reference cleanup
 * (remove_all_inverse_references — locators in OTHER records that point at
 * this one, WITH the per-removed-locator dataframe cascade, S1-05),
 * media-file moves, diffusion unpublish, and the 'delete_data' mode (empty
 * every component, keep the row — deleteSectionData).
 *
 * ATOMICITY (S2-02): the DB steps (snapshot, TM row, inverse-ref rewrites,
 * row delete, RAG delete marker, the diffusion UNPUBLISH INTENT rows) run in
 * ONE transaction; media moves and the diffusion unpublish itself are
 * post-commit side effects. DURABLE INTENT (LIFE-07, 2026-09-03): the dd1758
 * unpublish_pending rows are written INSIDE the transaction
 * (diffusion_bridge/diffusion_delete.ts ledgerUnpublishIntent — one per
 * publication element, or ONE record-level row when target resolution
 * throws) and settled after the commit (settleUnpublishIntent: flipped to
 * unpublished when the target confirms, stamped otherwise). A committed delete
 * therefore always leaves its public-tier debt on the ledger, whatever fails
 * after the commit — a crash, the MariaDB link, the executor; the retry queue
 * and the public_tier reconcile read exactly those rows.
 * OUT OF THIS MODULE (header re-dated 2026-07-10, S2-45): the ontology-main
 * cascade (deleting a hierarchy/ontology registry record uninstalls its TLD —
 * ontology/ontology_delete.ts deleteOntologyMain) runs at the DISPATCH
 * chokepoint BEFORE this function, global-admin gated; the CHILDREN-EXIST
 * refusal (PHP sections::delete :535-593 — a delete_record on a tree parent
 * with children is skipped unless options.delete_with_children) ALSO lives at
 * the dispatch chokepoint, deliberately NOT here: the ontology cascade calls
 * this function to tear down whole trees. INTENTIONAL DIVERGENCE: PHP
 * `remove_parent_references` (relation_common :1505-76) is NOT ported — it
 * calls `remove_me_as_your_child`, a method defined NOWHERE in the PHP tree
 * (latent fatal), and the computed-inverse children model makes it redundant
 * (a deleted child's parent locators die with its row; foreign locators are
 * stripped by removeAllInverseReferences below). No wire-shape change.
 */

import { compareLocators } from '../../concepts/locator.ts';
import { isConsultationOnlySection } from '../../concepts/section.ts';
import { dbTimestamp } from '../../db/db_timestamp.ts';
import { MATRIX_JSONB_COLUMNS, type MatrixJsonbColumn } from '../../db/matrix.ts';
import { allocateComponentItemId, deleteMatrixRecord } from '../../db/matrix_write.ts';
import { sql, withTransaction } from '../../db/postgres.ts';
import {
	ensureTmHistoryReady,
	tmEpochPredicate,
	tmVisiblePredicate,
} from '../../db/record_generation.ts';
import { recordBulkCascadeDelete, recordTimeMachine } from '../../db/time_machine.ts';
import type { UnpublishIntent } from '../../diffusion_bridge/diffusion_delete.ts';
import { DedaloError } from '../../errors/dedalo_error.ts';
import { getMatrixTableFromTipo } from '../../ontology/resolver.ts';
import { applyOwnFramePolicies } from '../../relations/dataframe.ts';
import {
	attributeSlotMains,
	historyMainsOf,
	type MainIdentity,
	type MainState,
	mainIdentity,
	readKeyImage,
	recordMainBackfill,
	recordMainHistory,
	resolveDataframeSlotTipos,
	restoreSlot,
	type SlotImages,
	type SlotTarget,
	slotsFromBag,
} from '../../relations/dataframe_slots.ts';
import { NOLAN } from '../../relations/main_lanes.ts';
import { enqueueObservedChange } from '../../section_record/obligation_ledger.ts';
import { projectOntologyRecordLifecycle } from '../../section_record/ontology_projection.ts';
import { fireRagRecordEvent, fireSaveEvent } from '../../section_record/save_event.ts';
import { bulkIdOf } from './bulk_capture.ts';

/** The bulk-run context a cascade hands the delete doors (relations/dataframe.ts). */
export interface DeleteBulkOptions {
	/**
	 * The dd800 run this delete belongs to — a run's dataframe cascade (a soft
	 * wipe) or a revert's D2 delete of a born record — null / absent for every
	 * ordinary delete. With it, the door writes a role-4 twin of
	 * its whole-record snapshot carrying the run id (recordCascadeDeleteTwin).
	 */
	bulkProcessId?: number | null;
}

/** deleteSectionRecord's options: the bulk context plus an optional locked precondition. */
export interface DeleteRecordOptions extends DeleteBulkOptions {
	/**
	 * Evaluated INSIDE the delete's transaction, right after its `FOR UPDATE`
	 * read of the record, over the locked whole-record snapshot (every jsonb
	 * column). A non-null answer ABORTS the delete with nothing written and
	 * comes back as `DeleteRecordResult.refused` — a check that must hold AT
	 * the delete (the bulk revert's D2 "only the run's values, unreferenced")
	 * cannot be raced by a save committing between check and delete.
	 */
	precondition?: (snapshot: Record<string, unknown>) => Promise<string | null>;
}

/**
 * THE ROLE-4 TWIN (WC …-bulk-revert-undo-log, M1 / decision D3). A record a
 * bulk run's dataframe cascade wipes (deleteSectionData — no policy removes a
 * frame target row, WC-2026-09-29-dataframe-hard-delete-retired) or a revert's
 * D2 deletes (deleteSectionRecord) carries no bulk id through the ordinary history — the
 * delete snapshot row (record delete) and the per-component rows (wipe) are
 * the door's own, visible and unattributed, exactly as for an interactive
 * delete. The twin is the run's handle on it: the same whole-record image
 * (every jsonb column as it stood BEFORE the door changed anything), hidden
 * (tm_role 4) and stamped with the run id, in the door's transaction and with
 * the door's stamp. Without a run id: nothing.
 */
async function recordCascadeDeleteTwin(
	options: DeleteBulkOptions,
	entry: {
		sectionTipo: string;
		sectionId: number;
		userId: number;
		snapshot: Record<string, unknown>;
		timestamp: string;
	},
): Promise<void> {
	const bulkId = bulkIdOf(options.bulkProcessId);
	if (bulkId === null) return;
	await recordBulkCascadeDelete({ ...entry, bulkId });
}

/** The record a wipe is emptying, and who empties it (wipedComponentValue). */
interface WipeTarget {
	/** The WIPER — whose birth default a wiped component_filter takes. */
	userId: number;
	table: string;
	sectionTipo: string;
	sectionId: number;
}

/**
 * What a data WIPE (deleteSectionData) leaves in one component key: nothing
 * (null removes the key), except component_filter, which takes the WIPER's
 * default projects instead of emptying (WC-2026-11-10-wipe-filter-user-default).
 *
 * PHP section_record::delete_data → component_filter::get_default_data_for_user
 * ($user_id), then set_data: the SAME cascade a record is born with
 * (resolveDefaultFilterData — a non-admin's first project, else the configured
 * default), and each item takes the component's NEXT counter id (set_data's
 * set_data_item_counter; the wipe keeps the meta counters, so it is the count
 * + 1, never a reused id). Until 2026-11-10 this wrote a CONSTANT — the default
 * project, type dd151, no id — which moved a non-admin's wiped record out of
 * their own project scope (audit OX3).
 *
 * Runs inside the wipe's transaction, the row already locked FOR UPDATE: the
 * counter allocation is a same-row UPDATE on the same connection. Its value is
 * a function of WHO wiped and WHEN, so nothing may recompute it afterwards — a
 * bulk revert reads what the wipe wrote from its own history row
 * (bulk_revert_records isWipedState).
 */
async function wipedComponentValue(
	model: string,
	componentTipo: string,
	target: WipeTarget,
): Promise<unknown[] | null> {
	if (model !== 'component_filter') return null;
	const { resolveDefaultFilterData } = await import('./record_defaults.ts');
	const defaults = await resolveDefaultFilterData(target.userId, componentTipo);
	const items: unknown[] = [];
	for (const locator of defaults) {
		const id = await allocateComponentItemId(
			target.table,
			target.sectionTipo,
			target.sectionId,
			componentTipo,
		);
		items.push({ ...locator, id });
	}
	return items;
}

export interface DeleteRecordResult {
	/**
	 * Deleted section_ids. INT since
	 * WC-2026-08-10-section-id-int-canonical — the PHP-era result shape stringified
	 * them, and the client compares this list against record addresses it holds as
	 * ints, so the string form forced a cast at every consumer.
	 */
	deleted: number[];
	/** True when a matrix row was actually removed. */
	removed: boolean;
	/** The `precondition`'s refusal, when it aborted the delete (nothing written). */
	refused?: string;
}

/**
 * `SELECT … FOR UPDATE` of every jsonb column of one record — the delete's
 * whole-record snapshot (SQL NULL columns as `null`) — or null when the row
 * does not exist.
 */
async function lockRecordSnapshot(
	table: string,
	sectionTipo: string,
	sectionId: number,
): Promise<Record<string, unknown> | null> {
	const columnList = MATRIX_JSONB_COLUMNS.map((column) => `"${column}"`).join(', ');
	const rows = (await sql.unsafe(
		`SELECT ${columnList} FROM "${table}" WHERE section_tipo = $1 AND section_id = $2 FOR UPDATE`,
		[sectionTipo, sectionId],
	)) as Record<MatrixJsonbColumn, unknown>[];
	const record = rows[0];
	if (record === undefined) return null;
	const snapshot: Record<string, unknown> = {};
	for (const column of MATRIX_JSONB_COLUMNS) {
		snapshot[column] = record[column] ?? null;
	}
	return snapshot;
}

/**
 * Delete one section record (delete_record mode): snapshot to Time Machine,
 * then remove the row. Returns the PHP-shaped result. `now` is injectable for
 * deterministic tests.
 */
export async function deleteSectionRecord(
	sectionTipo: string,
	sectionId: number,
	userId: number,
	now: Date = new Date(),
	options: DeleteRecordOptions = {},
): Promise<DeleteRecordResult> {
	if (isConsultationOnlySection(sectionTipo)) {
		throw new DedaloError('perm.denied', {
			message: `deleteSectionRecord: section '${sectionTipo}' is consultation-only (read-only)`,
			coordinates: { section_tipo: sectionTipo, section_id: sectionId, operation: 'delete' },
		});
	}
	if (sectionId < 1) {
		throw new DedaloError('section_id.not_an_address', {
			message: `deleteSectionRecord: refusing to delete non-positive section_id ${sectionId}`,
			coordinates: { section_tipo: sectionTipo, section_id: sectionId, operation: 'delete' },
		});
	}
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === null) {
		throw new DedaloError('section.no_matrix_table', {
			message: `deleteSectionRecord: no matrix table for section '${sectionTipo}'`,
			coordinates: { section_tipo: sectionTipo },
		});
	}

	// ATOMIC DB PHASE (S2-02): snapshot + TM audit + inverse-reference rewrites
	// + row delete run in ONE transaction — a crash or thrown error mid-sequence
	// can no longer leave holders stripped of their locators while the target
	// still exists, or a 'deleted' TM snapshot for a record never removed.
	// Media moves and diffusion unpublish are NON-transactional side effects and
	// run AFTER commit (idempotent/soft — a crash between commit and them leaves
	// recoverable residue, never broken relations). NOTE: when called inside an
	// ambient outer transaction the "post-commit" steps run while that outer tx
	// is still open — composed callers own that trade-off.
	const txOutcome = await withTransaction(
		async (): Promise<
			| {
					snapshot: Record<string, unknown>;
					removedCount: number;
					unpublishIntent: UnpublishIntent;
			  }
			| { refused: string }
			| null
		> => {
			// 1. Read the full record (every jsonb column) for the TM snapshot — this is
			//    PHP section_record::get_data(), the object stored in matrix_time_machine.
			const snapshot = await lockRecordSnapshot(table, sectionTipo, sectionId);
			if (snapshot === null) return null; // nothing to delete
			// 1a. The caller's precondition, behind the lock (DeleteRecordOptions).
			const refused = (await options.precondition?.(snapshot)) ?? null;
			if (refused !== null) return { refused };

			// 2. Time Machine audit (state 'deleted'): tipo = section_tipo, nolan lang,
			//    data = the full record snapshot (PHP tm_record::create in delete()).
			const snapshotStamp = dbTimestamp(now);
			await recordTimeMachine(
				{
					sectionTipo,
					sectionId,
					componentTipo: sectionTipo,
					lang: 'lg-nolan',
					userId,
					data: snapshot,
				},
				snapshotStamp,
			);
			// 2a. Under a bulk id (a revert's D2): the snapshot's role-4 twin (see
			//     recordCascadeDeleteTwin).
			await recordCascadeDeleteTwin(options, {
				sectionTipo,
				sectionId,
				userId,
				snapshot,
				timestamp: snapshotStamp,
			});

			// 2b. THE RECORD'S OWN FRAMES (WC-2026-09-06-dataframe-delete-policy-on-slot):
			//     every dataframe slot in the snapshot applies its delete policy to
			//     the frame targets its entries addressed. Queued on the commit lane
			//     by the applier — they run after this row is gone.
			await applyOwnFramePolicies(snapshot.relation, userId, options.bulkProcessId);

			// 3. Referential integrity: remove every locator in OTHER records that
			//    points at this one (PHP remove_all_inverse_references, delete step 3).
			//    Each owner it rewrites is LOCKED for the rest of this transaction
			//    (DATA-02, see the read there): the rewrite is a read-modify-write of
			//    a record this transaction does not otherwise hold. Each rewrite goes
			//    through the chokepoint's removal-law entry, which declares the
			//    owner's change to the observer ledger (step 9 (a)).
			await removeAllInverseReferences(
				sectionTipo,
				sectionId,
				userId,
				now,
				options.bulkProcessId ?? null,
			);

			// 4. Remove the row.
			const removedCount = await deleteMatrixRecord(table, sectionTipo, sectionId);

			// 4a. THE ONTOLOGY NODE moves with its record (ONT-3; PHP delete removed
			//     it): a `<tld>0` record's node `<tld><id>` goes, an override
			//     (localontology0) re-projects the node it overrode — inside this
			//     transaction, so a rolled-back delete keeps its node. Covers every
			//     delete door; the tld-teardown cascade (ontology_delete.ts) then
			//     finds nothing left to retract for these records. Any other
			//     section answers 'none' without touching the database.
			if (removedCount > 0) {
				await projectOntologyRecordLifecycle(sectionTipo, sectionId, 'death', snapshot.relation);
			}

			// 4b. THE RECORD'S OWN EDGES, to the observer ledger (step 9 (b)): the
			//     record is GONE, so everything it pointed at is a removal — every
			//     target's mirror must drop it. Declared HERE, inside the delete's
			//     transaction, so it drains after the COMMIT and a rolled-back delete
			//     propagates nothing.
			await enqueueObservedChange(
				{ table, sectionTipo, sectionId },
				{ kind: 'death', columns: snapshot, actor: userId, now },
			);

			// 5. RAG delete event (S2-13): PHP delete() enqueues a 'delete' job
			//    (class.section_record.php:988) so the vector store stops serving the
			//    record's chunks. In-transaction on purpose: the enqueue writes through
			//    the ambient sql handle, so a rolled-back delete leaves no marker.
			await fireRagRecordEvent({ kind: 'delete', sectionTipo, sectionId });

			// 5b. Diffusion UNPUBLISH INTENT (LIFE-07): the dd1758 pending rows the
			//     public tier is owed, written INSIDE the transaction so the commit
			//     can never outrun its debt (see the header). Settled in step 7.
			const { ledgerUnpublishIntent } = await import('../../diffusion_bridge/diffusion_delete.ts');
			const unpublishIntent = await ledgerUnpublishIntent(sectionTipo, sectionId, userId);

			return { snapshot, removedCount, unpublishIntent };
		},
	);
	if (txOutcome === null || 'refused' in txOutcome) {
		return { deleted: [], removed: false, ...(txOutcome ?? {}) };
	}

	// 6. Media files (POST-COMMIT): move every file of every media component into
	//    its quality dir's 'deleted/' sub-folder — recoverable, never a hard
	//    delete (PHP remove_section_media_files, class.section_record.php:1872,
	//    which likewise runs in step 3, after the row is already gone).
	//
	//    ONE implementation, in media/file_ops.ts, written against the RESTORE it
	//    is the inverse of — `restoreDeletedSectionMediaFiles`, which the
	//    tool_time_machine section undelete calls after it puts the row back
	//    (P1-11; that call did NOT exist until 2026-08-31, and this comment
	//    asserted it did, so a maintainer reading the delete path believed the
	//    round trip was complete when the files never came back). This
	//    door used to carry a private copy that walked files_info and resolved the
	//    media root from a bare `MEDIA_PATH` env read — a key that is normally
	//    UNSET, because the root is a DERIVED default — so on an ordinary install
	//    it moved NOTHING, and it never touched the AV posterframe (not a quality:
	//    no files_info walk can reach it). Deleting an interview left its audio and
	//    its still frame live in the tree under a deleted record's name.
	//
	//    The snapshot goes with it: `properties.additional_path` names a NAMED
	//    bucket folder taken from a SIBLING COMPONENT'S VALUE in this record, and
	//    the row no longer exists to read it from — without the snapshot the sweep
	//    would look in the numeric bucket the ingest never wrote to.
	{
		const { removeSectionMediaFiles } = await import('../../media/file_ops.ts');
		const outcome = await removeSectionMediaFiles(
			sectionTipo,
			sectionId,
			txOutcome.snapshot.media as Record<string, unknown[]> | null,
			{ now, snapshot: txOutcome.snapshot },
		);
		// PHP logs an ERROR per failing component and continues (the record IS
		// deleted; a file left live is an operator's problem, not a reason to fail
		// a committed delete). Reported, never swallowed.
		for (const failure of outcome.errors) {
			console.error(`[delete_record] media sweep of ${sectionTipo}/${sectionId}: ${failure}`);
		}
	}

	// 7. Diffusion unpublish (POST-COMMIT — PHP diffusion_delete::delete_record):
	//    settle the intent rows step 5b wrote — sql targets via the native
	//    executor, file targets by unlink; a row that does not settle stays
	//    pending (stamped) for the retry queue, a terminal one is reported.
	{
		const { settleUnpublishIntent } = await import('../../diffusion_bridge/diffusion_delete.ts');
		await settleUnpublishIntent(txOutcome.unpublishIntent);
	}

	// 8. Cache invalidation (S1-11): a delete stales the same caches a write
	//    does — the tipo-switch twins AND the section-data listeners (datalist
	//    option lists etc.). PHP's delete runs its save_event fan-out too.
	await fireSaveEvent(sectionTipo);

	// 9. Observer cascade (POST-COMMIT, 2026-08-06). A delete is the widest
	//    removal door there is, and it fired NOTHING before 2026-08-06: deleting a
	//    record left it listed in every observer mirror that referenced it, and
	//    left the mirrors of the records IT referenced unrecomputed. Two
	//    directions, both needed, both now obligations the OBLIGATION LEDGER
	//    carries (CLOSURE_PLAN Step 2) — nothing to call here:
	//    (a) every OTHER record whose bag step 3 rewrote — it saved through the
	//        chokepoint's removal-law entry, which declared `{saved: remaining,
	//        removed}` from the before-image read under the owner's lock;
	//    (b) the deleted record's OWN relation bags — declared in step 4b as the
	//        record's death.
	//    Both drained after the COMMIT above (a cascade hop refuses to run inside
	//    a transaction, and the recompute must read the committed delete), with
	//    ONE shared guard for the whole transaction: deleting numisdata3/17463
	//    rewrites 1,189 owners, and a guard per owner would recompute the same
	//    equivalence classes once per owner, synchronously inside the request.

	return { deleted: [sectionId], removed: txOutcome.removedCount > 0 };
}

/** An owner record's whole `relation` bag (tipo → value), `{}` when null. */
async function readRelationBag(owner: {
	table: string;
	ownerSection: string;
	ownerId: number;
}): Promise<Record<string, unknown>> {
	const rows = (await sql.unsafe(
		`SELECT relation FROM "${owner.table}" WHERE section_tipo = $1 AND section_id = $2`,
		[owner.ownerSection, owner.ownerId],
	)) as { relation: unknown }[];
	const bag = rows[0]?.relation;
	return bag !== null && typeof bag === 'object'
		? structuredClone(bag as Record<string, unknown>)
		: {};
}

/** A delete door's history stamps: the actor, the run (null outside one), the backfill + now stamps. */
interface DoorAudit {
	userId: number;
	bulkId: number | null;
	backfillStamp: string;
	nowStamp: string;
}

/**
 * Whether this record already has a VISIBLE history row for (tipo, lang) — the
 * backfill probe of the delete doors: without one, the door first records the
 * value as it stood (stamped 60 s earlier), so the change has a "before" in dd15.
 * P0-14: epoch-narrowed — a DEAD generation's rows at the same address must not
 * answer for the reborn record (its own history would never be written).
 * Visibility: a hidden undo-log row (tm_role) is not history either.
 */
async function hasVisibleHistory(
	target: SlotTarget,
	tipo: string,
	lang: string,
	anyTag: boolean,
): Promise<boolean> {
	await ensureTmHistoryReady();
	// `anyTag`: an unsliced main's one lane is every row whatever its tag (LaneHistoryProbe).
	const params: unknown[] = [target.sectionTipo, target.sectionId, tipo];
	if (!anyTag) params.push(lang);
	const history = (await sql.unsafe(
		`SELECT 1 FROM matrix_time_machine
		 WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3${anyTag ? '' : ' AND lang = $4'}
		   AND ${tmEpochPredicate()} AND ${tmVisiblePredicate()} LIMIT 1`,
		params,
	)) as unknown[];
	return history.length > 0;
}

/** A main's raw value on both sides of an owner rewrite, and its slots on both sides. */
interface OwnerImages {
	rawBefore: unknown;
	rawAfter: unknown;
	slotsBefore: SlotImages;
	slotsAfter: SlotImages;
}

/**
 * The images of one history main of an owner rewrite. A relation main is read
 * from the two bags; any other main (a literal whose frame was stripped) was
 * not written by the rewrite, so its stored value is both sides.
 */
async function ownerImages(
	target: SlotTarget,
	identity: MainIdentity,
	changedTipo: string,
	bags: { before: Record<string, unknown>; after: Record<string, unknown> },
): Promise<OwnerImages> {
	const extra = identity.tipo === changedTipo ? [] : [changedTipo];
	const slotsBefore = await slotsFromBag(identity.tipo, bags.before, extra);
	const slotsAfter = await slotsFromBag(identity.tipo, bags.after, slotsBefore.slots);
	if (identity.column === 'relation') {
		const rawBefore = bags.before[identity.tipo];
		return { rawBefore, rawAfter: bags.after[identity.tipo], slotsBefore, slotsAfter };
	}
	const raw = await readKeyImage(target, identity.column, identity.tipo);
	return { rawBefore: raw, rawAfter: raw, slotsBefore, slotsAfter };
}

/**
 * The history of one main of an owner rewrite, in its two lanes
 * (relations/dataframe_slots.ts): the BACKFILL of every lane that has no
 * visible row yet (the state as it stood), then the change itself — outside a
 * run its visible rows (a changed value lane, the lg-nolan row when a frame was
 * stripped), under a run's cascade its undo pairs (whose after-rows are the
 * visible ones).
 */
async function recordOwnerMain(
	target: SlotTarget,
	identity: MainIdentity,
	images: OwnerImages,
	audit: DoorAudit,
): Promise<void> {
	const before: MainState = { value: images.rawBefore, slots: images.slotsBefore };
	const after: MainState = { value: images.rawAfter, slots: images.slotsAfter };
	await recordMainBackfill(
		target,
		identity,
		before,
		{ userId: audit.userId, timestamp: audit.backfillStamp },
		(lane, anyTag) => hasVisibleHistory(target, identity.tipo, lane, anyTag),
	);
	await recordMainHistory(
		target,
		identity,
		{ before, after },
		{ userId: audit.userId, timestamp: audit.nowStamp, bulkId: audit.bulkId },
		{ forceDoorLane: false },
	);
}

/**
 * THE HISTORY OF AN INVERSE-REFERENCE STRIP on one owner component — COMPOSED
 * (relations/dataframe_slots.ts): the rewritten component when it is a main
 * (its slots' frames, as the dataframe strip left them, ride in its row), or
 * the main(s) of the stripped frames when the component is a dataframe slot (a
 * frame that targeted the deleted record). No slot ever gets a row or a pair
 * of its own. Written after the key is persisted, inside the delete's
 * transaction; `bagBefore` is the owner's relation bag read under its lock.
 */
async function recordOwnerRewriteHistory(
	owner: { table: string; ownerSection: string; ownerId: number; component: string },
	bagBefore: Record<string, unknown>,
	audit: DoorAudit,
): Promise<void> {
	const target = { table: owner.table, sectionTipo: owner.ownerSection, sectionId: owner.ownerId };
	const bagAfter = await readRelationBag(owner);
	const mains = await historyMainsOf(owner.component, {
		before: bagBefore[owner.component],
		after: bagAfter[owner.component],
		callerMain: null,
		requestLang: 'lg-nolan',
		// A strip door: a stripped frame no main owns leaves without history.
		orphan: 'skip',
	});
	for (const identity of mains) {
		const bags = { before: bagBefore, after: bagAfter };
		const images = await ownerImages(target, identity, owner.component, bags);
		await recordOwnerMain(target, identity, images, audit);
	}
}

/**
 * Remove every stored locator pointing at (sectionTipo, sectionId) from the
 * records that hold them (PHP section_record::remove_all_inverse_references):
 * breakdown-search the exact inverse entries, then per owning component strip
 * the matching items (target section/id + the entry's own type +
 * from_component_tipo), write the key (empty → key removed) and audit a TM
 * pair like any component save. Only relation-column components participate
 * (PHP supports relation_common descendants + component_dataframe — both
 * store in the relation column). The owner's modified stamps refresh.
 *
 * Every owner key goes through the chokepoint's REMOVAL-LAW entry
 * (persistRelationRemovalKeys): the owner's `relation_search` moves with its
 * locators in the same UPDATE, and the owner's change — `{saved: remaining,
 * removed}` from the before-image read under the owner's lock — is declared to
 * the observer ledger, which drains it after the delete's COMMIT. Returns the
 * number of owner components rewritten.
 */
async function removeAllInverseReferences(
	sectionTipo: string,
	sectionId: number,
	userId: number,
	now: Date,
	bulkProcessId: number | null = null,
): Promise<number> {
	const { findInverseReferenceLocators } = await import('../../search/search_related.ts');
	const { readMatrixKeyForUpdate } = await import('../../db/matrix_write.ts');
	const { persistRelationRemovalKeys, persistModifiedStamp } = await import(
		'../../section_record/index.ts'
	);
	const { getModelByTipo, getColumnNameByModel } = await import('../../ontology/resolver.ts');
	const { dbTimestamp: stamp } = await import('./create_record.ts');

	const hits = await findInverseReferenceLocators(
		[{ section_tipo: sectionTipo, section_id: sectionId }],
		{ order: 'section_id' },
	);
	if (hits.length === 0) return 0;

	// Group by owning record + component so each component saves ONCE.
	const byOwner = new Map<
		string,
		{ table: string; ownerSection: string; ownerId: number; component: string; types: Set<string> }
	>();
	for (const hit of hits) {
		const raw = hit.locator_data as { from_component_tipo?: string; type?: string };
		const component = raw.from_component_tipo;
		if (typeof component !== 'string') continue;
		const key = `${hit.table}|${hit.section_tipo}|${hit.section_id}|${component}`;
		let group = byOwner.get(key);
		if (group === undefined) {
			group = {
				table: hit.table,
				ownerSection: hit.section_tipo,
				ownerId: hit.section_id,
				component,
				types: new Set(),
			};
			byOwner.set(key, group);
		}
		if (typeof raw.type === 'string') group.types.add(raw.type);
	}

	const bulkId = bulkIdOf(bulkProcessId);
	const backfillStamp = stamp(new Date(now.getTime() - 60_000));
	const nowStamp = stamp(now);
	const touchedOwners = new Set<string>();
	let rewrites = 0;

	for (const group of byOwner.values()) {
		const model = await getModelByTipo(group.component);
		if (model === null || getColumnNameByModel(model) !== 'relation') continue; // PHP skips non-relation holders
		// LOCKED READ (DATA-02). This loop is a read-modify-write of ANOTHER
		// record's component key: it reads the owner's bag, filters the target
		// out in JS, and re-persists the WHOLE key below. The delete's
		// transaction locks only the record being DELETED — so with a plain
		// SELECT here, every locator a curator committed on this key between
		// the read and the write was silently destroyed: the save answered
		// ok:true, nothing counted it, and the TM row written below canonized
		// the stale bag as if it were the truth. `readMatrixKeyForUpdate` holds
		// the owner's row lock to COMMIT, which is the SAME lock every
		// component save takes before it writes (save_component.ts), so the two
		// doors now queue instead of clobbering: whichever runs second reads
		// what the first committed. It also refuses outside a transaction — the
		// guarantee is the lock's LIFETIME, not the keyword.
		//
		// A per-key jsonb array-remove was considered as the alternative and
		// REJECTED: the locator law below is LOOSE on section_id (a stored '05'
		// matches 5), which SQL element-equality does not honour and a
		// ::numeric cast cannot express safely over unswept jsonb; and the
		// removed entries are needed as VALUES anyway (the dataframe cascade,
		// the TM pair, the observer input), so the read never disappears — only
		// the lock does. Cost, stated: the owner's lock is now held from here to
		// COMMIT instead of from the UPDATE, so a wide delete serializes saves
		// on its owners for longer. That is the price of not losing them.
		const locked = await readMatrixKeyForUpdate(
			group.table,
			group.ownerSection,
			group.ownerId,
			'relation',
			group.component,
		);
		if (locked === null) continue; // owner row gone (deleted under us) — nothing to rewrite
		// KEPT UNION (WC-2026-08-10-section-id-int-canonical): the bag is the
		// OWNER's stored relation payload read verbatim from unswept jsonb, and
		// the SURVIVORS are re-persisted byte-for-byte below — canonicalizing
		// them here would rewrite locators this delete never targeted (that is
		// the data sweep's job) and would corrupt external remote ids.
		const bag = locked as {
			section_tipo?: string;
			section_id?: number | string;
			type?: string;
		}[];
		const remaining: typeof bag = [];
		const removedEntries: typeof bag = [];
		for (const entry of bag) {
			// Locator law (S2-04/DEC-21): target match via compareLocators —
			// section_tipo strict + present-on-both, section_id LOOSE numeric
			// (PHP locator::compare_locators; stored '05' matches 5 where the old
			// String() comparison missed it). The type gate is the inverse-search
			// hit's own relation type, unchanged.
			const matches =
				entry !== null &&
				typeof entry === 'object' &&
				compareLocators(
					entry as Parameters<typeof compareLocators>[0],
					{ section_tipo: sectionTipo, section_id: sectionId },
					['section_tipo', 'section_id'],
				) &&
				(entry.type === undefined || group.types.has(String(entry.type)));
			(matches ? removedEntries : remaining).push(entry);
		}
		if (removedEntries.length === 0) continue; // nothing matched

		// THE OWNER'S HISTORY IS COMPOSED (recordOwnerRewriteHistory): its whole
		// relation bag is captured here, behind the owner lock taken above, so
		// the rewritten main's row (or pair, under a run's cascade — the revert
		// that undeletes the target puts the stripped locators back) carries its
		// slots' frames on both sides of the dataframe strip below.
		const bagBefore = await readRelationBag(group);

		// DATAFRAME cascade (PHP remove_locator_from_data :1362 via
		// remove_all_inverse_references, S1-05): each removed locator strips the
		// owner's frame entries paired with its item id, so no orphaned frames
		// survive to re-attach to a future item reusing the id. Locators
		// without an id (pre-migration) have no id_key to pair on — PHP skips.
		{
			const { removeDataframeDataById } = await import('../../relations/save.ts');
			for (const entry of removedEntries) {
				const itemId = (entry as { id?: number | string }).id;
				if (itemId === undefined || itemId === null) continue;
				await removeDataframeDataById(
					group.table,
					group.ownerSection,
					group.ownerId,
					group.component,
					Math.trunc(Number(itemId)),
					userId,
					bulkProcessId,
				);
			}
		}

		const newData = remaining.length > 0 ? remaining : null;
		// Chokepoint write — the REMOVAL-LAW entry — no audit here: the owner's
		// stamps refresh ONCE below (an owner may hold several affected
		// components). THE ANCESTOR INDEX MOVES WITH THE LOCATORS (P1-7 /
		// DATA-12): since 2026-08-09 `relation_search` is READ — conform.ts emits
		// `direct OR ancestor` for positive operators and `NOT direct AND NOT
		// ancestor` for the negating set — so a rewrite of `relation` that left
		// `relation_search` standing made the two stores disagree PERMANENTLY. PHP
		// called $component->Save() here, which maintained it; the entry derives
		// it in the same UPDATE, and declares the owner's change to the observer
		// ledger (step 9 (a) of the record delete).
		await persistRelationRemovalKeys(
			{ table: group.table, sectionTipo: group.ownerSection, sectionId: group.ownerId },
			[{ column: 'relation', key: group.component, value: newData }],
			false,
			{ actor: userId, now },
		);
		// Component save audit (relation data is nolan): backfill row + after-row
		// (or the run's pair), composed, like any TS-side component write.
		await recordOwnerRewriteHistory(group, bagBefore, { userId, bulkId, backfillStamp, nowStamp });
		touchedOwners.add(`${group.table}|${group.ownerSection}|${group.ownerId}`);
		rewrites += 1;
	}

	// Owners' modified stamps (component Save refreshes dd197/dd201).
	for (const ownerKey of touchedOwners) {
		const [ownerTable, ownerSection, ownerId] = ownerKey.split('|');
		if (ownerTable === undefined || ownerSection === undefined || ownerId === undefined) continue;
		await persistModifiedStamp(
			{ table: ownerTable, sectionTipo: ownerSection, sectionId: Number(ownerId) },
			{ userId, now },
		);
	}
	return rewrites;
}

/**
 * Component models delete_data never empties (PHP $excluded_model_to_empty).
 *
 * `component_external` is here for the same reason it is refused at the save
 * door: its value is DERIVED from a third-party service, so "emptying" it would
 * write a TM backfill row and a column key for data this record never held.
 * EXPORTED so `external_write_refusal_tripwire` asserts the membership rather
 * than trusting this comment (WC-2026-08-06-external-write-refusal).
 */
export const EXCLUDED_EMPTY_MODELS: ReadonlySet<string> = new Set([
	'component_section_id',
	'component_external',
	'component_inverse',
]);

/** One key a data wipe emptied (deleteSectionData). */
interface WipedKey {
	tipo: string;
	model: string;
	column: string;
	stored: unknown;
	newData: unknown;
	/** A slot a main's frame strip rewrote (wipeDeclaredSlotsOfMains): the mains that stripped it. */
	owners?: string[];
}

/** One main a wipe records: its value on both sides, and the extra slots that name it. */
interface WipeMain {
	tipo: string;
	stored: unknown;
	newData: unknown;
	extraSlots: string[];
}

/** The wipe's record: the locked pre-wipe row. */
interface WipeContext {
	target: SlotTarget;
	record: Record<MatrixJsonbColumn, unknown>;
}

/** A jsonb column value as a key bag (`{}` when null or not an object). */
function asBag(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** The record's relation bag AFTER the wipe (in memory: null removes the key). */
function wipedRelationBag(
	before: Record<string, unknown>,
	wiped: readonly WipedKey[],
): Record<string, unknown> {
	const after = { ...before };
	for (const key of wiped) {
		if (key.column !== 'relation') continue;
		if (key.newData === null) delete after[key.tipo];
		else after[key.tipo] = key.newData;
	}
	return after;
}

/** A main a wiped slot's frames belong to but the wipe did not empty: its value is both sides. */
async function unwipedSlotMain(
	ctx: WipeContext,
	tipo: string,
	slotTipo: string,
): Promise<WipeMain> {
	const { getModelByTipo, getColumnNameByModel } = await import('../../ontology/resolver.ts');
	const model = await getModelByTipo(tipo);
	const column = model === null ? null : getColumnNameByModel(model);
	const stored = column === null ? undefined : asBag(ctx.record[column as MatrixJsonbColumn])[tipo];
	const value = stored ?? null;
	return { tipo, stored: value, newData: value, extraSlots: [slotTipo] };
}

/**
 * A WIPED RECORD'S FRAMES LEAVE WITH IT — whatever the main's kind, and
 * whether or not the main held a value. The subtree walk empties a slot only
 * when the slot is a component of the section; a main's DECLARED slot that is
 * not (component_iri's fixed dd560, a slot named only by the main's
 * request_config ddo) would keep the main's frames as orphans pairing no item.
 * For EVERY non-slot component of the walked subtree — a wiped main, and an
 * EMPTY one too (a frame saved before its item, or left behind by a `clear`) —
 * each declared slot the walk did not empty loses that main's OWN frames
 * (restoreSlot with none recorded — other mains' frames stay; an empty result
 * removes the key). The removed frames join `emptiedFrames` (the slot's delete
 * policy), and the slot joins `wiped` carrying the mains that stripped it
 * (`owners`: the composed wipe row of each, wipeMains). Returns the rewritten
 * slots, each with its FINAL value — IN MEMORY only: the caller persists them
 * (deleteSectionData, through the chokepoint's removal-law entry, with the rest
 * of the wipe), so every key the wipe rewrites is written by the one door.
 */
async function wipeDeclaredSlotsOfMains(
	record: Record<MatrixJsonbColumn, unknown>,
	wiped: WipedKey[],
	emptiedFrames: Record<string, unknown[]>,
	components: readonly { tipo: string; model: string }[],
): Promise<WipedKey[]> {
	const bag = { ...asBag(record.relation) };
	const done = new Set(wiped.map((key) => key.tipo));
	const written = new Map<string, WipedKey>();
	const mains = new Set(
		[...wiped, ...components]
			.filter((key) => key.model !== 'component_dataframe')
			.map((key) => key.tipo),
	);
	for (const main of mains) {
		const slots = (await resolveDataframeSlotTipos(main)).filter((slot) => !done.has(slot));
		for (const slot of slots) {
			stripWipedMainFrames({ bag, written, emptiedFrames }, slot, main);
		}
	}
	wiped.push(...written.values());
	return [...written.values()];
}

/** The running state of wipeDeclaredSlotsOfMains: the in-memory relation bag and what it wrote. */
interface SlotStrip {
	bag: Record<string, unknown>;
	written: Map<string, WipedKey>;
	emptiedFrames: Record<string, unknown[]>;
}

/**
 * Remove `mainTipo`'s own frames from one slot (restoreSlot with none recorded),
 * when it holds any — in the in-memory bag; the caller persists the result.
 */
function stripWipedMainFrames(state: SlotStrip, slot: string, mainTipo: string): void {
	const live = Array.isArray(state.bag[slot]) ? (state.bag[slot] as unknown[]) : [];
	const kept = restoreSlot(live, mainTipo, []);
	if (kept.length === live.length) return;
	const newData = kept.length === 0 ? null : kept;
	const removed = live.filter((entry) => !kept.includes(entry));
	state.emptiedFrames[slot] = [...(state.emptiedFrames[slot] ?? []), ...removed];
	noteStrippedSlot(state.written, { slot, mainTipo, live, newData });
	state.bag[slot] = kept;
}

/** Record one strip of `slot` by `mainTipo`: its first pre-strip image, its latest value, its owners. */
function noteStrippedSlot(
	written: Map<string, WipedKey>,
	strip: { slot: string; mainTipo: string; live: unknown[]; newData: unknown },
): void {
	const prior = written.get(strip.slot) ?? { stored: strip.live, owners: [] };
	written.set(strip.slot, {
		tipo: strip.slot,
		model: 'component_dataframe',
		column: 'relation',
		stored: prior.stored,
		newData: strip.newData,
		owners: [...(prior.owners ?? []), strip.mainTipo],
	});
}

/**
 * The mains whose history a wipe writes: every emptied non-slot key, plus the
 * main(s) of each emptied slot's frames — the mains that stripped it
 * (wipeDeclaredSlotsOfMains `owners`), else attributeSlotMains; a frame no main
 * owns leaves without history (orphan 'skip'). A slot writes no row of its own.
 */
async function wipeMains(ctx: WipeContext, wiped: readonly WipedKey[]): Promise<WipeMain[]> {
	const mains: WipeMain[] = wiped
		.filter((key) => key.model !== 'component_dataframe')
		.map((key) => ({ ...key, extraSlots: [] }));
	for (const slot of wiped.filter((key) => key.model === 'component_dataframe')) {
		const owners =
			slot.owners ??
			(await attributeSlotMains(slot.tipo, slot.stored, slot.newData ?? undefined, null, 'skip'));
		for (const tipo of owners) {
			const known = mains.find((main) => main.tipo === tipo);
			if (known !== undefined) known.extraSlots.push(slot.tipo);
			else mains.push(await unwipedSlotMain(ctx, tipo, slot.tipo));
		}
	}
	return mains;
}

/**
 * THE HISTORY OF A DATA WIPE — two lanes (relations/dataframe_slots.ts): per
 * main, the backfill of every lane that has no visible row yet (its old value
 * per language + the lg-nolan value and its slots' frames as they stood), then
 * the wipe itself — one emptied row per language lane that held a value, and
 * the lg-nolan row when its value or a frame went. Written inside the wipe's
 * transaction, after every key was emptied; the slots are read from the locked
 * row and its in-memory wiped twin.
 */
async function recordWipeHistory(
	ctx: WipeContext,
	wiped: readonly WipedKey[],
	audit: DoorAudit,
): Promise<void> {
	const relationBefore = asBag(ctx.record.relation);
	const relationAfter = wipedRelationBag(relationBefore, wiped);
	for (const main of await wipeMains(ctx, wiped)) {
		const slotsBefore = await slotsFromBag(main.tipo, relationBefore, main.extraSlots);
		const slotsAfter = await slotsFromBag(main.tipo, relationAfter, slotsBefore.slots);
		// The wipe is DOORLESS (it removes every lane): the same identity its
		// undelete uses (bulk_revert_records wipedMainIdentity) — lg-nolan, or
		// the request's data lang for a translatable SLICED main (mainRowLang).
		// currentDataLang(), NOT config.menu.dataLang (P0-7/DATA-01): the wipe,
		// its backfill and a bulk revert's undelete sit in ONE timeline — the curator's.
		const identity = await mainIdentity(main.tipo, NOLAN);
		const before = { value: main.stored ?? undefined, slots: slotsBefore };
		const after = { value: main.newData ?? undefined, slots: slotsAfter };
		await recordMainBackfill(
			ctx.target,
			identity,
			before,
			{ userId: audit.userId, timestamp: audit.backfillStamp },
			(lane, anyTag) => hasVisibleHistory(ctx.target, main.tipo, lane, anyTag),
		);
		await recordMainHistory(
			ctx.target,
			identity,
			{ before, after },
			{ userId: audit.userId, timestamp: audit.nowStamp, bulkId: null },
			{ forceDoorLane: false },
		);
	}
}

/**
 * delete_data mode (PHP section_record::delete_data): keep the row, EMPTY
 * every component child of the section that has stored data —
 *   - per component: a Time Machine pair (backfill row with the OLD full
 *     value at NOW-60s when the tipo+lang has no TM history yet, then the
 *     save row with the new value), and the column KEY REMOVED
 *     (jsonb_set_lax 'delete_key'; component_filter gets the WIPER's default
 *     projects instead of null — wipedComponentValue);
 *   - then the modified stamps refresh (dd197 user locator + dd201 date,
 *     whole-key replace);
 *   - and every EMPTIED MEDIA component's files move into their `deleted/`
 *     folders, exactly as the record delete moves them (PHP delete_data
 *     :1123-1126 calls remove_component_media_files per media component it just
 *     emptied). Emptying the column key while leaving the files live is how a
 *     record ends up with an image nothing references and nothing will ever
 *     clean up.
 * Meta counters are KEPT (PHP leaves them). LEDGERED: component_info observer
 * rows (computed data, no stored key on TS-written records), the activity log
 * row.
 */
export async function deleteSectionData(
	sectionTipo: string,
	sectionId: number,
	userId: number,
	now: Date = new Date(),
	options: DeleteRecordOptions = {},
): Promise<DeleteRecordResult> {
	if (isConsultationOnlySection(sectionTipo)) {
		throw new DedaloError('perm.denied', {
			message: `deleteSectionData: section '${sectionTipo}' is consultation-only (read-only)`,
			coordinates: { section_tipo: sectionTipo, section_id: sectionId, operation: 'delete_data' },
		});
	}
	if (sectionId < 1) {
		throw new DedaloError('section_id.not_an_address', {
			message: `deleteSectionData: refusing non-positive section_id ${sectionId}`,
			coordinates: { section_tipo: sectionTipo, section_id: sectionId, operation: 'delete_data' },
		});
	}
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === null) {
		throw new DedaloError('section.no_matrix_table', {
			message: `deleteSectionData: no matrix table for section '${sectionTipo}'`,
			coordinates: { section_tipo: sectionTipo },
		});
	}
	const { getModelByTipo, getColumnNameByModel } = await import('../../ontology/resolver.ts');
	const { declaredSectionComponents } = await import('./declared_components.ts');
	const { persistRelationRemovalKeys, persistModifiedStamp } = await import(
		'../../section_record/index.ts'
	);
	const { dbTimestamp: stamp } = await import('./create_record.ts');

	// The components the wipe may empty: THE ONE section census
	// (declared_components.ts — own ∪ real subtree, crossing nested sections),
	// shared with the covered-slot restore so a slot the wipe empties is one the
	// restore recomputes. A virtual section that declares a component of its own
	// still stores its real section's.
	/**
	 * THE WIPE'S ONE WRITE DOOR — the chokepoint's REMOVAL-LAW entry, for every
	 * key the wipe rewrites (an emptied component, a stripped dataframe slot).
	 * THE ANCESTOR INDEX MOVES WITH THE LOCATORS (P1-7 / DATA-12): emptying a
	 * relation component removes every locator it held, so `relation_search`
	 * loses their ancestors in the SAME UPDATE (`conform.ts` reads `direct OR
	 * ancestor`, and the negating operators read it too). And the observer
	 * obligation rides the same write: the ledger records each key's before-image
	 * under this transaction's row lock and drains `{saved: newData, removed}`
	 * after the COMMIT — this door used to collect them and propagate itself.
	 * Stamps: none per key; they refresh ONCE at the end (persistModifiedStamp).
	 */
	const writeWipedKey = async (column: string, componentTipo: string, value: unknown) =>
		persistRelationRemovalKeys(
			{ table, sectionTipo, sectionId },
			[{ column: column as MatrixJsonbColumn, key: componentTipo, value }],
			false,
			{ actor: userId, now },
		);

	const components = await declaredSectionComponents(sectionTipo);

	const backfillStamp = stamp(new Date(now.getTime() - 60_000));
	const nowStamp = stamp(now);

	// ATOMIC DB PHASE (2026-09-21, the same shape as the record delete): the
	// row is read FOR UPDATE and every component's TM pair + key removal +
	// index rewrite + the modified stamps run in ONE transaction. Until then
	// each statement autocommitted, so a failure after the second component
	// left the record HALF-EMPTIED — TM rows and emptied keys for some
	// components, live data on the rest, no stamp — which is exactly what the
	// dataframe delete policy's "orphan, never torn" posture relies on not
	// happening once its deletes moved onto the commit lane (their own
	// transaction, this one). Media moves, the observer cascade and the cache
	// event are NON-transactional side effects and run AFTER commit. NOTE when
	// called inside an ambient outer transaction the "post-commit" steps run
	// while that outer tx is still open — composed callers own that trade-off.
	const txOutcome = await withTransaction(
		async (): Promise<{
			record: Record<MatrixJsonbColumn, unknown>;
			emptiedMedia: Record<string, unknown[]>;
		} | null> => {
			const columnList = MATRIX_JSONB_COLUMNS.map((column) => `"${column}"`).join(', ');
			const rows = (await sql.unsafe(
				`SELECT ${columnList} FROM "${table}" WHERE section_tipo = $1 AND section_id = $2 FOR UPDATE`,
				[sectionTipo, sectionId],
			)) as Record<MatrixJsonbColumn, unknown>[];
			const record = rows[0];
			if (record === undefined) return null;
			// Under a bulk run's cascade: the PRE-WIPE record's role-4 twin (see
			// recordCascadeDeleteTwin) — the row survives a wipe, its data does not.
			await recordCascadeDeleteTwin(options, {
				sectionTipo,
				sectionId,
				userId,
				snapshot: { ...record },
				timestamp: nowStamp,
			});

			/**
			 * MEDIA slots this wipe emptied, in the shape the sweep walks (tipo → the
			 * items as they stood BEFORE the wipe). Collected rather than read back
			 * afterwards for the same reason the delete door passes its snapshot: by the
			 * time the loop ends the keys are gone, and so is the sibling value that
			 * `properties.additional_path` names.
			 */
			const emptiedMedia: Record<string, unknown[]> = {};
			/** Dataframe slots this wipe emptied (tipo → pre-wipe entries) — the ONLY bag the policies may reach. */
			const emptiedFrames: Record<string, unknown[]> = {};
			/** Every key this wipe emptied — its history, composed, after the loop. */
			const wiped: WipedKey[] = [];

			for (const component of components) {
				if (EXCLUDED_EMPTY_MODELS.has(component.model)) continue;
				// component_info data is observer-COMPUTED (PHP empties it and logs a TM
				// row even without a stored key) — ledgered, no stored-key contract here.
				if (component.model === 'component_info') continue;
				const model = (await getModelByTipo(component.tipo)) ?? component.model;
				const column = getColumnNameByModel(model);
				if (column === null) continue;
				const stored = (record[column as MatrixJsonbColumn] as Record<string, unknown> | null)?.[
					component.tipo
				];
				if (
					stored === undefined ||
					stored === null ||
					(Array.isArray(stored) && stored.length === 0)
				) {
					continue;
				}

				// component_filter takes the WIPER's default projects (PHP
				// get_default_data_for_user, a fresh counter id) instead of emptying.
				const newData = await wipedComponentValue(model, component.tipo, {
					userId,
					table,
					sectionTipo,
					sectionId,
				});

				// The history rows are written after the loop (recordWipeHistory),
				// COMPOSED: a main's rows carry its slots' frames, a slot gets none.
				wiped.push({ tipo: component.tipo, model, column, stored, newData });
				// Chokepoint write (PHP key-removal semantics: last key leaves '{}') —
				// the removal-law entry (writeWipedKey above): the index and the
				// observer obligation ride it. The stamps refresh ONCE at the end.
				await writeWipedKey(column, component.tipo, newData);
				if (column === 'media') {
					emptiedMedia[component.tipo] = Array.isArray(stored) ? stored : [];
				}
				if (column === 'relation' && model === 'component_dataframe' && Array.isArray(stored)) {
					emptiedFrames[component.tipo] = stored;
				}
			}

			const target = { table, sectionTipo, sectionId };
			// The declared slots a main's frames were stripped from — rewritten in
			// memory, persisted here through the same door (one write per slot, its
			// final value).
			const stripped = await wipeDeclaredSlotsOfMains(record, wiped, emptiedFrames, components);
			for (const slot of stripped) {
				await writeWipedKey(slot.column, slot.tipo, slot.newData);
			}
			await recordWipeHistory({ target, record }, wiped, {
				userId,
				bulkId: null,
				backfillStamp,
				nowStamp,
			});

			// THE RECORD'S OWN FRAMES (WC-2026-09-06-dataframe-delete-policy-on-slot):
			// the wipe above emptied every dataframe slot, so each slot's delete
			// policy applies to the frame targets its pre-wipe entries addressed —
			// the same answer the record delete gives (step 2b there); which delete
			// mode the curator picked must not decide whether a `delete_target`
			// frame's data survives. ONLY the frames the wipe REMOVED: the slots it
			// emptied, and a main's own frames (wiped or empty) out of a declared
			// slot outside the subtree (wipeDeclaredSlotsOfMains); any other dd490
			// bag keeps its key, and a target deleted under a surviving locator is
			// the state this contract forbids. Queued on the commit lane by the applier; the
			// grant on the target section is asked here, inside the transaction,
			// so a refusal rolls the wipe back.
			await applyOwnFramePolicies(emptiedFrames, userId, options.bulkProcessId);
			// Modified stamps (PHP update_modified_section_data 'update_record').
			await persistModifiedStamp({ table, sectionTipo, sectionId }, { userId, now });
			// THE ONTOLOGY NODE (ONT-3, PHP parity): an emptied `<tld>0` record
			// projects nothing, so its node goes; an emptied override re-projects
			// the node it overrode (the locked pre-wipe relation names it). LEDGERED:
			// a later Time Machine data-restore of this record takes the persist
			// 'updated' branch and does NOT re-project — saves stay explicit-project
			// (tool_ontology); only a BIRTH (writeBirth) re-projects. Any other
			// section answers 'none' without touching the database.
			await projectOntologyRecordLifecycle(sectionTipo, sectionId, 'death', record.relation);
			return { record, emptiedMedia };
		},
	);
	if (txOutcome === null) {
		return { deleted: [], removed: false };
	}
	const { record, emptiedMedia } = txOutcome;

	// Media files of the emptied media components (PHP delete_data :1123-1126:
	// `remove_component_media_files()` per emptied media component) — the SAME
	// implementation the record delete uses, so "this record's files" can never
	// mean two different sets. The pre-wipe row is handed over as the snapshot:
	// the `additional_path` sibling this loop may itself have just emptied is
	// still in it. POST-COMMIT: a moved file cannot be rolled back.
	if (Object.keys(emptiedMedia).length > 0) {
		const { removeSectionMediaFiles } = await import('../../media/file_ops.ts');
		const outcome = await removeSectionMediaFiles(sectionTipo, sectionId, emptiedMedia, {
			now,
			snapshot: record as unknown as Record<string, unknown>,
		});
		for (const failure of outcome.errors) {
			console.error(`[delete_data] media sweep of ${sectionTipo}/${sectionId}: ${failure}`);
		}
	}

	// The observer cascade of the wiped keys is NOT fired here: every key went
	// through the chokepoint's removal-law entry, which declared it to the
	// obligation ledger — drained after the COMMIT above, with ONE guard shared
	// by the whole transaction (the delete door's fan-out reason, step 9 there).

	// (No explicit save event here: every chokepoint write of the wipe fires
	// it through the write chokepoint's afterRecordWrite, on the post-tx lane.)
	return { deleted: [sectionId], removed: false };
}
