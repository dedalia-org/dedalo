/**
 * Section record duplication (PHP dd_core_api::duplicate →
 * section_record::duplicate).
 *
 * A duplicate is a NEW record (fresh counter-allocated section_id, fresh audit
 * metadata) carrying a copy of the source's component data. Empirically
 * verified against live PHP (test2 fixtures):
 * - `data` column: fresh metadata, NOT copied (build_metadata);
 * - copied columns: every jsonb column except data/meta/relation_search, with
 *   the audit component tipos (dd197/dd199/dd200/dd201) dropped — they get
 *   fresh stamps instead — and covered-observer mirror slots dropped too
 *   (derived state: an inverse mirror is empty by construction on a fresh
 *   record, a copy-law slot is recomputed from the copied data after the
 *   insert — see copyColumnKeys and isCoveredObserverTipo);
 * - audit stamps: created dd200/dd199 AND modified dd197/dd201 all point at the
 *   duplicating user "now" (the per-component re-save loop stamps modification
 *   data on top of the creation stamps);
 * - `meta`: [{count: maxItemId}] per COPIED component tipo (the re-save loop's
 *   counter shape — array-wrapped, PHP canonical);
 * - Time Machine: one audit row per copied component tipo with the DATA-LANG
 *   slice of the copied value (nolan slice for non-translatable components);
 * - post-write obligations: declared ONCE, LAST, through the write chokepoint's
 *   own hook (afterRecordWrite — save event, security reaction, RAG index
 *   event; this writer bypasses record_write.ts, so it declares the same
 *   obligations for itself rather than remembering them one by one — a
 *   duplicated dd1324 row clones a tool's name + active flag into the registry,
 *   and a duplicate is born carrying the FULL content of its source, so it must
 *   reach the vector store like any other record, P1-8 / DATA-18) — and the
 *   observer cascade: the hook declares the clone's BIRTH to the obligation
 *   ledger (section_record/obligation_ledger.ts), so every target the copied
 *   relation locators point at recomputes its mirror (the clone is a new
 *   referencer of each); then ONE
 *   'NEW' activity row (P1-8 / DATA-19 — the closed WHAT vocabulary has no
 *   DUPLICATE code; PHP logged per-component SAVE rows from the re-save loop,
 *   this engine logs the record's birth with `source_section_id` —
 *   engineering/wire_contract/WC-2026-09-03-duplicate-record-new-activity-row.md
 *   records the divergence from the oracle's per-component shape). Gated by
 *   test/unit/tools_cache_invalidation.test.ts +
 *   test/unit/write_obligations_{tripwire,native}.test.ts.
 *
 * Media-file duplication (engineering/MEDIA_SPEC.md Phase B; CLOSURE_PLAN Step 2
 * CORE-5, WC-2026-09-30-media-key-locked-transform): the clone NEVER stores the
 * source's index. Its media items are inserted with `files_info: []` (an
 * external item keeps its URL entries), so neither the committed row nor its
 * history can name the SOURCE record's files, even if the process dies right
 * after the insert. The files are then copied through the record-scoped walk
 * (media/file_ops.ts duplicateSectionMediaFiles — the `additional_path` bucket
 * of THIS record honoured), and the clone's index is re-scanned AT THE CLONE'S
 * IDENTITY through the one locked media-key writer (files_info_persist.ts
 * transformStoredMediaItems), always, even after a failed copy; the written
 * items feed the history rows. A copy that is not complete — a refused bucket,
 * a failed copy, fewer files copied than the source's index claimed — is a
 * VERDICT, never a throw (the row is already committed): logged as
 * `media.operation_failed`, counted (`duplicate_media_incomplete`), and returned
 * by duplicateSectionRecordWithVerdict. LEDGERED: media derivative
 * REGENERATION (we copy existing derivatives, not rebuild them).
 *
 * Dataframe frame targets are RE-MINTED, never shared
 * (WC-2026-08-27-duplicate-reminted-dataframe-targets, closing DATA-05): a
 * dd490 pairing locator OWNS the record it addresses — the frame's fields
 * live there — so copying it verbatim (what PHP does, and what this file did)
 * left ONE frame target pointed at by two main items on two records, and a
 * curator correcting the copy's frame silently rewrote the original's. See
 * remintDataframeTargets: every frame target is deep-copied through this same
 * writer and the copied locator re-pointed, or the duplicate is REFUSED. There
 * is no third option: a duplicate that shares some frames is corruption that
 * nothing detects. NARROWED to frames that name a Dedalo record address: an
 * external remote id or an absent one owns nothing, so it is copied verbatim
 * exactly as before (frameTargetAddress).
 *
 * Re-minting MINTS RECORDS IN A SECTION THE CALLER NEVER NAMED, so this writer
 * re-asks the write grant (level 2) on every frame target's section for the
 * duplicating user — the doors above gate the HOST section alone, and nothing
 * in a duplicate request mentions the target section at all. See
 * assertFrameTargetDuplicable.
 *
 * NOT ATOMIC, AND SAID OUT LOUD (2026-08-28, CLI-01 / P0-10). This writer opens
 * NO transaction around the whole. The clone COMMITS at step 4 (the insert and
 * the clone's parent-link cycle check, ONT-5, in one short transaction of their
 * own — nothing else is in it), and steps 3b, 4b, 5 and 6 — frame-target
 * re-minting, media file copies (never a throw: a verdict), the two Time Machine
 * rows per component, and afterRecordWrite with the observer cascade it carries —
 * run outside any transaction, before and after that commit. Consequences a
 * caller must know:
 *
 *   - A THROW HERE DOES NOT MEAN NOTHING HAPPENED. A failure at step 5 leaves a
 *     committed duplicate with no history; a failure at step 6 leaves one whose
 *     targets' observer mirrors do not know about it. This is precisely why the
 *     idempotency gate (api/dispatch.ts, Gate 4) refuses to re-execute after a
 *     thrown handler and answers `idempotency.outcome_unknown` instead: freeing
 *     the key would let the transport's automatic resend mint a SECOND clone of
 *     a heritage record.
 *
 * WHY IT IS NOT SIMPLY WRAPPED IN withTransaction, verified rather than assumed
 * — a naive wrap would introduce a WORSE defect than the one it closes:
 *
 *   1. THE COUNTER ROLLS BACK, THE FILES DO NOT. The id comes from a ROW in
 *      `matrix_counter` (matrix_write.ts: `ON CONFLICT (tipo) DO UPDATE SET
 *      value = value + 1`), not from a sequence — so a ROLLBACK returns the
 *      counter to its previous value and the NEXT duplicate is handed the SAME
 *      section_id. Media file names embed that id
 *      (media/path.ts: `{component_tipo}_{section_tipo}_{section_id}`), and a
 *      filesystem copy is not transactional, so the rolled-back attempt's files
 *      would be ADOPTED by the next record to receive that id: a photograph
 *      silently attached to the wrong object, which nothing detects.
 *   2. THE MEDIA WRITE-BACK IS A LOCKED TRANSFORM of its own (one short
 *      transaction per component — files_info_persist.ts refuses to run inside a
 *      caller's), and the observer cascade drains after COMMIT through the
 *      obligation ledger either way — neither can simply ride one outer
 *      transaction.
 *
 * The structurally correct form is therefore not "add withTransaction" but a
 * SPLIT: a transaction covering step 3b's re-mints + the insert + the Time
 * Machine rows, with the media copies and afterRecordWrite moved strictly AFTER
 * the commit (so a rollback can never leave a file addressed by a reusable id). That is a restructure of the engine's most
 * delicate write path and belongs with its own gate, in its own change — it must
 * not ride along inside an idempotency fix, and it does not remove the need for
 * the ambiguous-outcome rule, which stands as long as ANY committed work can be
 * followed by a throw.
 */

import { config } from '../../../config/config.ts';
import { incrementCounter } from '../../api/counters.ts';
import { isMediaModel, mediaTypeOf } from '../../concepts/media.ts';
import { isConsultationOnlySection } from '../../concepts/section.ts';
import { isConvertibleSectionIdString, isSectionId } from '../../concepts/section_id.ts';
import { isDataframeEntry } from '../../concepts/subdatum.ts';
import { MATRIX_JSONB_COLUMNS, type MatrixJsonbColumn, readMatrixRecord } from '../../db/matrix.ts';
import { insertMatrixRecordWithCounter, type MatrixWriteValues } from '../../db/matrix_write.ts';
import { withTransaction } from '../../db/postgres.ts';
import { DedaloError } from '../../errors/dedalo_error.ts';
import { logError } from '../../errors/log.ts';
import { type ComponentMediaCopy, duplicateSectionMediaFiles } from '../../media/file_ops.ts';
import { resolveMediaPathOptions } from '../../media/ontology_path.ts';
import type { StoredMediaItem } from '../../media/tools/files_info_persist.ts';
import { getMatrixTableFromTipo, getModelByTipo } from '../../ontology/resolver.ts';
import {
	type LaneIdentity,
	mainIdentity,
	mainStorage,
	recordMainBackfill,
	recordMainHistory,
	slotsFromBag,
} from '../../relations/dataframe_slots.ts';
import { NOLAN } from '../../relations/main_lanes.ts';
import { assertParentLinkKeysAcyclic, type ParentKeyWrite } from '../../relations/parent.ts';
import { currentDataLang } from '../../resolve/request_lang.ts';
import {
	afterRecordWrite,
	dropCoveredObserverUnits,
	ownDataCoveredSlots,
	prepareBirthColumns,
} from '../../section_record/record_write.ts';
import type { Principal } from '../../security/permissions.ts';
import { currentRequestContext } from '../../security/request_context.ts';
import {
	auditDateItem,
	auditUserLocator,
	buildRecordMetadata,
	CREATED_BY_USER,
	CREATED_DATE,
	dbTimestamp,
	MODIFIED_BY_USER,
	MODIFIED_DATE,
} from './create_record.ts';

/** Audit tipos never copied from the source (they get fresh stamps). */
const AUDIT_TIPOS: ReadonlySet<string> = new Set([
	CREATED_BY_USER,
	CREATED_DATE,
	MODIFIED_BY_USER,
	MODIFIED_DATE,
]);

/** The clone's relation bag as one key write per key (the cycle check reads the parent keys). */
function relationKeyWrites(relation: unknown): ParentKeyWrite[] {
	if (relation === null || typeof relation !== 'object' || Array.isArray(relation)) return [];
	return Object.entries(relation as Record<string, unknown>).map(([key, value]) => ({
		column: 'relation',
		key,
		value,
	}));
}

/** Columns whose content is NOT copied wholesale (rebuilt or system-managed). */
const SKIP_COPY_COLUMNS: ReadonlySet<string> = new Set(['data', 'meta', 'relation_search']);

/** One copied component slice: its column, tipo, and item array. */
interface CopiedComponent {
	column: MatrixJsonbColumn;
	tipo: string;
	items: { id?: number; lang?: string }[];
}

/**
 * ONE media component's duplicate VERDICT (CORE-5): what the source's index
 * claimed, what was copied, and — when the clone's media is not a complete
 * copy — where it stopped. Never a throw: the clone is already committed.
 */
export interface MediaCopyVerdict {
	/**
	 * The CLONE record holding the component. A duplicate re-mints its dataframe
	 * frame targets through this same door, and their verdicts ride the one list
	 * the caller reads — a tipo alone cannot say which record it belongs to.
	 */
	sectionTipo: string;
	sectionId: number;
	tipo: string;
	/** Existing (non-external) files the SOURCE's stored index claimed. */
	sourceFiles: number;
	/** Files copied to the clone. */
	copiedFiles: number;
	/** The clone's media is not a complete copy (see `stage`). */
	incomplete: boolean;
	/**
	 * Where it stopped: `no_media_root` (no media root to copy under), `copy`
	 * (the walk or a file copy failed), `rescan` (the clone's index could not be
	 * re-scanned), `missing` / `locked` (the clone's row, at the write-back),
	 * `count` (fewer files copied than the source claimed or held).
	 */
	stage?: 'no_media_root' | 'copy' | 'rescan' | 'missing' | 'locked' | 'count';
}

/** Why a component stopped — for the LOG line only, never a verdict field (SEC-18). */
interface IncompleteDetail {
	/** The copy walk's per-component report (media/file_ops.ts). */
	copyReport?: string;
	/** The failure the rescan threw. */
	cause?: unknown;
}

/** Options of the verdict-bearing door (duplicateSectionRecordWithVerdict). */
export interface DuplicateMediaOptions {
	/**
	 * The media root to copy under: a path (a marked scratch root) instead of the
	 * configured one; `null` = NO media root (nothing can be copied — every
	 * component whose source claimed files is a `no_media_root` verdict); absent
	 * = the configured root (config.media.rootPath, itself null when unset).
	 */
	mediaRoot?: string | null;
	/** Out-parameter: every media component's verdict is appended here. */
	verdicts?: MediaCopyVerdict[];
}

/**
 * Duplicate one section record. Returns the new section_id. `now` is
 * injectable for deterministic tests.
 *
 * `remintChain` is INTERNAL: the ancestry of records this duplication is
 * already copying, so the frame-target re-mint (which re-enters this same
 * function) refuses a cycle instead of recursing forever. NO caller outside
 * this file passes it (census 2026-08-27: dd_core_api, the MCP field writer
 * and every gate hand over three arguments). Deleting the guard is not a
 * refactor but an unbounded recursion — gated by the CYCLE test in
 * test/unit/duplicate_record_dataframe_native.test.ts, which does not
 * terminate without it.
 */
export async function duplicateSectionRecord(
	sectionTipo: string,
	sourceSectionId: number,
	userId: number,
	now: Date = new Date(),
	remintChain: ReadonlySet<string> = new Set(),
	mediaOptions: DuplicateMediaOptions = {},
): Promise<number> {
	const { table, source } = await readDuplicableSource(sectionTipo, sourceSectionId);

	// 1. Copy component columns (audit tipos dropped — fresh stamps below;
	//    covered-observer mirror slots dropped too — see copyComponentColumns;
	//    media items copied WITHOUT their index — see the header). 1b: the FRAMES
	//    of every covered mirror left out go with it (followRelationDrop).
	const { values, copied, claimed, coveredMains } = await copyComponentColumns(source);
	if (coveredMains.length > 0) {
		await dropCoveredObserverUnits(values as MatrixWriteValues, coveredMains);
		followRelationDrop(copied, (values.relation ?? {}) as Record<string, unknown>);
	}

	// 2. Fresh audit metadata: created AND modified stamps (stampDuplicateAudit).
	await stampDuplicateAudit(values, sectionTipo, userId, now);
	// 3. meta counters + the source's relation_search as the BASE (copyMetaAndIndexBase).
	copyMetaAndIndexBase(values, source, copied);

	// 3b. Dataframe frame targets: RE-MINT or REFUSE, before the duplicate
	//     exists. Runs AFTER relation_search is attached so the census covers
	//     every copied column, and BEFORE the insert so no row can ever be
	//     stored sharing a frame target — not even for the width of a
	//     transaction we do not hold (see remintDataframeTargets).
	await remintDataframeTargets(
		values,
		sectionTipo,
		sourceSectionId,
		userId,
		now,
		remintChain,
		mediaOptions,
	);

	// 4. Insert the new record (counter-allocated id), its columns first put
	//    through the chokepoint's BIRTH step (record_write.ts prepareBirthColumns
	//    — the one law every record birth stores by): no covered observer slot,
	//    the `_hi` index derived from the relation as copied and re-minted.
	//    The insert and the clone's PARENT-LINK CYCLE CHECK share ONE short
	//    transaction (ONT-5, WC-2026-10-11-parent-link-cycle-every-door): the
	//    clone copies the source's component_relation_parent key, and a STALE
	//    link naming the id the counter mints here closes a loop through the
	//    clone — knowable only once the id exists. A refusal (`tree.cycle`)
	//    rolls back the row AND the counter; nothing addressed by that id
	//    exists yet (media and history follow the commit), so a reused id
	//    adopts nothing. Step 3b's re-minted frame targets are already
	//    committed and stay, unreferenced — as after any failure at this step.
	//    The clone's COPY-LAW slots (stripped in step 1) are recomputed from its
	//    copied data after the insert — by declaration, not only the slots the
	//    source stored (a source whose mirror was never computed stores none):
	//    the birth's selfRecompute, never declared as edges.
	const pinned = [
		...new Set([
			...(await prepareBirthColumns(values)),
			...(await ownDataCoveredSlots(sectionTipo)),
		]),
	];
	const newSectionId = await withTransaction(async () => {
		const id = await insertMatrixRecordWithCounter(table, sectionTipo, values);
		await assertParentLinkKeysAcyclic(
			{ table, sectionTipo, sectionId: id },
			relationKeyWrites(values.relation),
			'birth',
		);
		return id;
	});

	// 4b. Media files: copy every quality/ext file to the new id (PHP
	//     duplicate_component_media_files), then re-index the clone AT ITS OWN
	//     IDENTITY through the locked media-key writer — the written items replace
	//     the copied ones in `values`/`copied`, so the history rows below record the
	//     CLONE's paths. Every incompleteness is a verdict (see the header).
	const verdicts = await duplicateRecordMedia({
		sectionTipo,
		sourceSectionId,
		newSectionId,
		sourceColumns: source.columns as Record<string, unknown>,
		values,
		copied,
		claimed,
		mediaRoot: mediaOptions.mediaRoot,
	});
	mediaOptions.verdicts?.push(...verdicts);

	// 5. Time Machine: TWO rows per copied MAIN component (recordDuplicateHistory).
	await recordDuplicateHistory(
		{ table, sectionTipo, sectionId: newSectionId },
		copied,
		values.relation,
		{ userId, now },
	);

	// 6. The post-write obligations: this writer inserts through matrix_write
	//    DIRECTLY, so it never passes the record_write.ts chokepoint that fires
	//    for every other write — it declares the chokepoint's obligations for
	//    itself through the chokepoint's OWN hook (PHP duplicate() closes with
	//    $new_section_record->save(), which calls save_event AND enqueues the
	//    record for indexing). ONE fire, LAST: the caches must be dropped after
	//    the copy and the media refresh have landed, or a concurrent read
	//    repopulates them with a half-built duplicate. The hook also declares the
	//    clone's BIRTH to the observer ledger (the 2026-07-24 cascade, since
	//    Step 2 the chokepoint's): the clone is a NEW referencer of every target
	//    its copied relation locators point at, so those targets' mirrors (the
	//    hierarchy93 family) recompute — inline here (no transaction), or after
	//    a wrapping caller's COMMIT. The copy's OWN mirror slots were never
	//    copied (step 1): an inverse mirror is empty by construction, a
	//    copy-law slot recomputes from the copied data as the birth's
	//    selfRecompute (`pinned`, step 4).
	//    Load-bearing for dd1324/dd996/dd234, where the duplicate clones a
	//    tool's name AND active flag into the registry: without this the tool
	//    is wrong in every user's menu until restart (no TTL since the
	//    cutover). The touched keys are every copied component tipo — a
	//    duplicated dd128 record carries its source's dd131/dd133, and the
	//    security reaction judges them exactly as it would a save. Not
	//    tx-wrapped here, and every obligation self-defers if a caller wraps us
	//    in one.
	await afterRecordWrite(
		{ table, sectionTipo, sectionId: newSectionId },
		{
			door: 'duplicateSectionRecord',
			touchedKeys: copied.map((component) => component.tipo),
			rag: 'index',
			observed: { kind: 'birth', columns: values, selfRecompute: pinned, actor: userId, now },
		},
	);

	// 7. Activity audit — ONE 'NEW' row for the record's birth (see header).
	//    Host from the request scope when there is one, PHP's 'unknown' for
	//    CLI/scripts; never fails the duplicate (logActivity swallows).
	{
		const { logActivity, hostFromClientIp } = await import('../../api/handlers/activity_log.ts');
		await logActivity(
			{
				what: 'NEW',
				tipo: sectionTipo,
				userId,
				host: hostFromClientIp(currentRequestContext()?.clientIp),
				data: {
					msg: 'Duplicated section record',
					section_id: newSectionId,
					source_section_id: sourceSectionId,
					section_tipo: sectionTipo,
					tipo: sectionTipo,
					table,
				},
			},
			now,
		);
	}

	return newSectionId;
}

/** The matrix record a duplication reads (never null past {@link readDuplicableSource}). */
type DuplicateSource = NonNullable<Awaited<ReturnType<typeof readMatrixRecord>>>;

/**
 * The engine backstops a duplication passes BEFORE anything is copied, then the
 * source row. Consultation-only sections are read-only for every caller (the
 * API handler denies earlier with a clean 403 — see concepts/section.ts); a
 * non-positive record is refused even for root (PHP API duplicate →
 * assert_record_in_user_scope → user_can_access_record false for
 * section_id<1), mirroring the delete_record.ts guards.
 */
async function readDuplicableSource(
	sectionTipo: string,
	sourceSectionId: number,
): Promise<{ table: string; source: DuplicateSource }> {
	if (isConsultationOnlySection(sectionTipo)) {
		throw new DedaloError('perm.denied', {
			message: `duplicateSectionRecord: section '${sectionTipo}' is consultation-only (read-only)`,
			coordinates: {
				section_tipo: sectionTipo,
				section_id: sourceSectionId,
				operation: 'duplicate',
			},
		});
	}
	if (sourceSectionId < 1) {
		throw new DedaloError('section_id.not_an_address', {
			message: `duplicateSectionRecord: refusing to duplicate non-positive section_id ${sourceSectionId}`,
			coordinates: {
				section_tipo: sectionTipo,
				section_id: sourceSectionId,
				operation: 'duplicate',
			},
		});
	}
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === null) {
		throw new DedaloError('section.no_matrix_table', {
			message: `duplicateSectionRecord: no matrix table for section '${sectionTipo}'`,
			coordinates: { section_tipo: sectionTipo },
		});
	}
	const source = await readMatrixRecord(table, sectionTipo, sourceSectionId);
	if (source === null) {
		throw new DedaloError('resource.not_found', {
			message: `duplicateSectionRecord: source record ${sectionTipo}/${sourceSectionId} not found`,
			coordinates: { section_tipo: sectionTipo, section_id: sourceSectionId },
		});
	}
	return { table, source };
}

/** Step 1's product: the clone's columns and what it copied. */
interface ComponentCopy {
	values: Partial<Record<MatrixJsonbColumn, unknown>>;
	copied: CopiedComponent[];
	/** Existing files each media component's SOURCE index claims (the verdict's floor). */
	claimed: Map<string, number>;
	/** The covered mirror mains step 1 left out (their frames go too — step 1b). */
	coveredMains: string[];
}

/** Step 1: copy every copyable column of the source (see {@link copyColumnKeys}). */
async function copyComponentColumns(source: DuplicateSource): Promise<ComponentCopy> {
	const copy: ComponentCopy = { values: {}, copied: [], claimed: new Map(), coveredMains: [] };
	const { isCoveredObserverTipo } = await import('./observers.ts');
	for (const column of MATRIX_JSONB_COLUMNS) {
		if (SKIP_COPY_COLUMNS.has(column)) continue;
		const columnData = source.columns[column] as Record<string, unknown> | null | undefined;
		if (columnData == null || typeof columnData !== 'object') continue;
		const columnCopy = await copyColumnKeys(column, columnData, copy, isCoveredObserverTipo);
		if (Object.keys(columnCopy).length > 0) copy.values[column] = columnCopy;
	}
	return copy;
}

/** Copy ONE column's keys (audit tipos and covered mirror slots left out). */
async function copyColumnKeys(
	column: MatrixJsonbColumn,
	columnData: Record<string, unknown>,
	copy: ComponentCopy,
	isCoveredObserverTipo: (tipo: string) => Promise<boolean>,
): Promise<Record<string, unknown>> {
	const columnCopy: Record<string, unknown> = {};
	for (const [tipo, items] of Object.entries(columnData)) {
		if (AUDIT_TIPOS.has(tipo)) continue;
		// COVERED observer slots are NEVER copied: a stored mirror is DERIVED
		// state, and the source's is the SOURCE's truth, never the clone's.
		//   - an `inverse_search` mirror lists the SOURCE's referencers, and
		//     nothing can reference a record that does not exist yet — the
		//     clone's bag is EMPTY BY CONSTRUCTION (absent slot);
		//   - a copy law (`source_overwrite`, `observed_data` — external_laws/)
		//     reads the record's OWN data, which IS copied (the pointer, the
		//     text): its slot is recomputed from that copy after the insert
		//     (step 4, record_write.ts ownDataCoveredSlots → selfRecompute),
		//     never inherited — the source's stored copy may be stale.
		// Stripping also keeps the matrix_relation_index sync trigger from
		// indexing the source's locators on the clone.
		if (column === 'relation' && (await isCoveredObserverTipo(tipo))) {
			copy.coveredMains.push(tipo);
			continue;
		}
		const stored = await copiedKeyValue(column, tipo, items, copy.claimed);
		columnCopy[tipo] = stored;
		if (Array.isArray(stored)) {
			copy.copied.push({ column, tipo, items: stored as CopiedComponent['items'] });
		}
	}
	return columnCopy;
}

/**
 * The value a copied key is stored with. A MEDIA component's index is the
 * SOURCE's files (source-id paths): the clone is inserted with none (external
 * URL entries kept) and re-indexed at its own identity after the copy (step
 * 4b). What the source claimed is remembered — a copy that lands fewer files is
 * a verdict. Every other key is copied as is.
 */
async function copiedKeyValue(
	column: MatrixJsonbColumn,
	tipo: string,
	items: unknown,
	claimed: Map<string, number>,
): Promise<unknown> {
	return column === 'media' && Array.isArray(items) && (await isMediaComponent(tipo))
		? stripSourceIndex(items, tipo, claimed)
		: items;
}

/**
 * Step 1b. The FRAMES of every covered mirror left out go with it (the covered
 * UNIT, record_write.ts dropCoveredObserverUnits): they pair with the SOURCE's
 * referencer ids, and the clone's first recompute mints 1..N — a source
 * referencer's frame would land on the clone's. Dropped before the frame-target
 * re-mint (3b), which would otherwise deep-copy targets for frames the clone
 * never stores; `copied` follows the drop: its relation components are re-read
 * from the post-drop relation (gone ⇒ removed), in place.
 */
function followRelationDrop(copied: CopiedComponent[], relation: Record<string, unknown>): void {
	for (let index = copied.length - 1; index >= 0; index--) {
		const component = copied[index];
		if (component === undefined || component.column !== 'relation') continue;
		const stored = relation[component.tipo];
		if (Array.isArray(stored)) component.items = stored as CopiedComponent['items'];
		else copied.splice(index, 1);
	}
}

/**
 * Step 2. Fresh audit metadata: created AND modified stamps (the PHP re-save
 * loop layers 'update_record' modification data over the creation stamps).
 */
async function stampDuplicateAudit(
	values: Partial<Record<MatrixJsonbColumn, unknown>>,
	sectionTipo: string,
	userId: number,
	now: Date,
): Promise<void> {
	values.data = await buildRecordMetadata(sectionTipo, userId, now);
	values.relation = {
		...((values.relation as Record<string, unknown>) ?? {}),
		[MODIFIED_BY_USER]: [auditUserLocator(userId, MODIFIED_BY_USER)],
		[CREATED_BY_USER]: [auditUserLocator(userId, CREATED_BY_USER)],
	};
	values.date = {
		...((values.date as Record<string, unknown>) ?? {}),
		[CREATED_DATE]: [auditDateItem(now)],
		[MODIFIED_DATE]: [auditDateItem(now)],
	};
}

/**
 * Step 3. meta: the re-save loop's per-component counter for every copied tipo
 * ([{count: maxItemId}], PHP canonical array shape). relation_search: the
 * source's index is the BASE only — every `_hi` key is re-derived from the
 * relation the clone will actually carry, by the chokepoint's birth step right
 * before the insert (step 4). Copied verbatim it kept the index of the covered
 * mirror slot step 1 dropped: an index for a value the clone does not hold,
 * matched by every broader-term search.
 */
function copyMetaAndIndexBase(
	values: Partial<Record<MatrixJsonbColumn, unknown>>,
	source: DuplicateSource,
	copied: readonly CopiedComponent[],
): void {
	const meta: Record<string, unknown> = {
		...((source.columns.meta as Record<string, unknown>) ?? {}),
	};
	for (const component of copied) {
		const maxId = component.items.reduce(
			(max, item) => (typeof item.id === 'number' && item.id > max ? item.id : max),
			0,
		);
		if (maxId > 0) meta[component.tipo] = [{ count: maxId }];
	}
	if (Object.keys(meta).length > 0) values.meta = meta;
	if (source.columns.relation_search != null)
		values.relation_search = source.columns.relation_search;
}

/**
 * THE VERDICT-BEARING DOOR: duplicate a record and answer, beside the new id,
 * one media VERDICT per copied media component (CORE-5 — see the header and
 * MediaCopyVerdict). `mediaRoot` copies under a marked scratch root instead of
 * the configured one. duplicateSectionRecord is this door without the verdicts
 * — the id, for the callers that need nothing else (every incomplete copy is
 * logged and counted either way).
 */
export async function duplicateSectionRecordWithVerdict(
	sectionTipo: string,
	sourceSectionId: number,
	userId: number,
	now: Date = new Date(),
	remintChain: ReadonlySet<string> = new Set(),
	options: { mediaRoot?: string | null } = {},
): Promise<{ sectionId: number; media: MediaCopyVerdict[] }> {
	const media: MediaCopyVerdict[] = [];
	const sectionId = await duplicateSectionRecord(
		sectionTipo,
		sourceSectionId,
		userId,
		now,
		remintChain,
		{
			mediaRoot: options.mediaRoot,
			verdicts: media,
		},
	);
	return { sectionId, media };
}

/** Whether a copied media-column key is a MEDIA component (its model's type spec). */
async function isMediaComponent(tipo: string): Promise<boolean> {
	const model = await getModelByTipo(tipo);
	return model !== null && isMediaModel(model) && mediaTypeOf(model) !== null;
}

/** An item that points at an EXTERNAL source (its files_info names URLs, never files). */
function isExternalItem(item: unknown): boolean {
	const source = (item as { external_source?: unknown } | null)?.external_source;
	return typeof source === 'string' && source !== '';
}

/**
 * The copied media items WITHOUT the source's index: each non-external item's
 * `files_info` emptied (an external item keeps its URL entries — they name no
 * file of either record). What the source index claimed — its existing,
 * non-external entries — is recorded in `claimed`.
 */
function stripSourceIndex(
	items: readonly unknown[],
	tipo: string,
	claimed: Map<string, number>,
): unknown[] {
	let count = 0;
	const stripped = items.map((item) => {
		if (item === null || typeof item !== 'object' || isExternalItem(item)) return item;
		count += claimedFileCount((item as { files_info?: unknown }).files_info);
		return { ...(item as Record<string, unknown>), files_info: [] };
	});
	claimed.set(tipo, count);
	return stripped;
}

/** The existing, non-external entries of one item's `files_info` (what its index claims). */
function claimedFileCount(filesInfo: unknown): number {
	let count = 0;
	for (const entry of Array.isArray(filesInfo) ? filesInfo : []) {
		const e = entry as { file_exist?: unknown; external?: unknown } | null;
		if (e?.file_exist === true && e.external !== true) count++;
	}
	return count;
}

/**
 * ONE dd490 pairing locator inside the copied bag, addressed by the array it
 * lives in plus its index — the pair the re-mint needs to REPLACE the entry in
 * place. That array is the SAME object the stored column and the
 * CopiedComponent slice hold, so one in-place replacement keeps the row and
 * its Time Machine rows saying the same thing.
 */
interface FrameEntryRef {
	items: Record<string, unknown>[];
	index: number;
}

/** A frame target record, validated as an address a copy can be minted from. */
interface FrameTarget {
	/** `<section_tipo>/<section_id>` — the dedup key AND the cycle key. */
	key: string;
	sectionTipo: string;
	sectionId: number;
	/** The dataframe slot the pairing is stored under (named in every refusal). */
	frameTipo: string;
}

/** The chain/cycle key of one record. */
function recordKey(sectionTipo: string, sectionId: number): string {
	return `${sectionTipo}/${sectionId}`;
}

/**
 * THE REFUSAL (DATA-05). The two alternative shapes — sharing the target, or
 * dropping the frame from the copy — are silent corruption and silent loss, and
 * this system ranks either far above the inconvenience of a refused duplicate.
 * The dataframe slot is NAMED so the curator knows WHERE to repair. Not WITH
 * WHAT: `dataframe_control` scans these same dd490 locators but asks a
 * different question — "does this frame's MAIN ITEM still exist in the row?" —
 * so a frame whose TARGET record was deleted is invisible to it and its `fix`
 * would not strip one. Sending the curator there for an orphan target is
 * advice that does nothing, which is why the sentences below name the repair
 * instead of a tool.
 *
 * `record.dataframe_unduplicable` is a CONFLICT (409), public disclosure: the
 * curator asked for something the current state of their own record cannot
 * give, and every branch below is repairable BY THEM — re-point the pairing,
 * delete the stale frame, break the cycle. The first cut of this fix reused
 * `engine.uncovered_scope` (503, operator disclosure), which told the client
 * "the server is unavailable, retry" about a refusal no retry can change and
 * hid the slot name the repair needs behind the disclosure ladder.
 */
function refuseFrameCopy(
	reason: string,
	frameTipo: string,
	sectionTipo: string,
	sectionId: number,
): DedaloError {
	const sentence =
		`refusing to duplicate ${sectionTipo}/${sectionId} — its component_dataframe slot ` +
		`'${frameTipo}' ${reason}. A frame target record is OWNED by the item that frames it; ` +
		"the copy may never share the original's.";
	return new DedaloError('record.dataframe_unduplicable', {
		message: `duplicateSectionRecord: ${sentence}`,
		// PUBLIC on purpose: the actor holds write on the host record, so the
		// slot and the address it frames are already theirs to read.
		publicMessage: sentence,
		details: { component_tipo: frameTipo, reason },
		coordinates: {
			section_tipo: sectionTipo,
			section_id: sectionId,
			component_tipo: frameTipo,
			operation: 'duplicate',
		},
	});
}

/**
 * Census over EVERY copied column, never the `relation` column alone. Frames
 * live there today, but `relation_search` is copied verbatim too and a pairing
 * locator owns a record wherever it is stored — a column-scoped census would
 * report green over precisely what it cannot see.
 */
function collectDataframeEntries(
	values: Partial<Record<MatrixJsonbColumn, unknown>>,
): FrameEntryRef[] {
	const found: FrameEntryRef[] = [];
	for (const columnData of Object.values(values)) {
		if (columnData === null || typeof columnData !== 'object') continue;
		for (const items of Object.values(columnData as Record<string, unknown>)) {
			if (!Array.isArray(items)) continue;
			const bag = items as Record<string, unknown>[];
			bag.forEach((entry, index) => {
				if (isDataframeEntry(entry)) found.push({ items: bag, index });
			});
		}
	}
	return found;
}

/**
 * True when a stored `section_id` NAMES A DEDALO RECORD ADDRESS — a safe
 * integer, or the legacy string form of one ('509'), which
 * WC-2026-08-10-section-id-int-canonical converts.
 *
 * Everything else is a DIFFERENT CONCEPT wearing the field name
 * (concepts/section_id.ts): an external remote id ('001338683', 'Q42'), a
 * synthetic wire token, or no address at all (null / undefined / ''). The
 * dataframe write path already treats those as a real shape —
 * `normalizeDataframeEntry` passes a non-address section_id through verbatim,
 * and `area_maintenance/widgets/dataframe_control.ts` renders `section_id ??
 * unknown` — so a target-less frame is a shape this engine STORES, not
 * corruption to refuse over.
 */
function namesRecordAddress(value: unknown): boolean {
	return isSectionId(value) || (typeof value === 'string' && isConvertibleSectionIdString(value));
}

/**
 * The frame's target address WHEN THE FRAME NAMES ONE — `null` when it does
 * not, which is a COPY-VERBATIM answer and never a refusal.
 *
 * THE NARROWING (adversarial round 3, 2026-08-27). Refusing every frame whose
 * `section_id` is not a positive safe integer made a record carrying a
 * target-less or external-remote-id frame PERMANENTLY UNDUPLICABLE — and for
 * no integrity gain: such a frame OWNS no record, so the verbatim copy shares
 * nothing. That is the pre-existing behaviour and it is harmless; only an
 * ownership edge has to be re-minted. (Census of this machine's suite
 * database: 162 dd490 entries, 0 of them target-less — the shape is plausible
 * for installs carrying PHP-era or external-target frames, not present here.)
 *
 * What REMAINS a refusal: an address-shaped id the copy cannot be minted from
 * — a non-positive one (`-1` is the root record, `-666` the activity
 * sentinel), or one whose `section_tipo` is missing or empty, which names a
 * record without saying where. Those DO own something, and sharing it is the
 * corruption this whole file exists to prevent.
 */
function frameTargetAddress(
	frame: FrameEntryRef,
	sectionTipo: string,
	sectionId: number,
): FrameTarget | null {
	const entry = frame.items[frame.index] as Record<string, unknown>;
	const frameTipo =
		typeof entry.from_component_tipo === 'string' ? entry.from_component_tipo : 'unknown';
	// Not a record address → nothing is owned, nothing is shared: copy verbatim.
	if (!namesRecordAddress(entry.section_id)) return null;
	const targetTipo = entry.section_tipo;
	const targetId = Number(entry.section_id);
	if (typeof targetTipo !== 'string' || targetTipo === '' || targetId < 1) {
		throw refuseFrameCopy(
			'points at an address no record copy can be minted from',
			frameTipo,
			sectionTipo,
			sectionId,
		);
	}
	return {
		key: recordKey(targetTipo, targetId),
		sectionTipo: targetTipo,
		sectionId: targetId,
		frameTipo,
	};
}

/**
 * Everything that has to hold before a frame target can be deep-copied. Each
 * failure is a REFUSAL, never a fallback to sharing: an orphan pairing (the
 * target was deleted under it) blocks the duplicate loudly instead of copying a
 * dangling pointer, and a cycle — a frame whose target frames its way back into
 * a record already being copied — stops the recursion here rather than in a
 * stack overflow halfway through writing rows.
 *
 * AND the actor's WRITE GRANT on the target section, which is an authorization
 * gate this function is the ONLY holder of: see the block comment on it below.
 */
async function assertFrameTargetDuplicable(
	target: FrameTarget,
	sectionTipo: string,
	sectionId: number,
	chain: ReadonlySet<string>,
	actor: Principal,
): Promise<void> {
	// THE CYCLE GUARD. Gated by the CYCLE test in
	// duplicate_record_dataframe_native.test.ts (a mutual dd490 pair): without
	// this line the duplicate never returns.
	if (chain.has(target.key)) {
		throw refuseFrameCopy(
			`frames ${target.key}, a record this duplication is already copying (cycle)`,
			target.frameTipo,
			sectionTipo,
			sectionId,
		);
	}
	// BEFORE the grant, because it is the more actionable sentence and it is not
	// an authorization answer at all: consultation-only is a static property of
	// the ontology, identical for every principal, and getSectionPermissions
	// caps such a section at read (1) for everyone — asking the grant first would
	// answer "you lack permission" to a curator who lacks nothing.
	if (isConsultationOnlySection(target.sectionTipo)) {
		throw refuseFrameCopy(
			`frames ${target.key}, whose section is consultation-only (read-only)`,
			target.frameTipo,
			sectionTipo,
			sectionId,
		);
	}
	// THE WRITE GRANT ON THE TARGET SECTION. The duplicate doors ask
	// `getSectionPermissions(principal, sectionTipo) >= 2` on the HOST section
	// and nothing else (api/handlers/dd_core_api.ts, ai/mcp/tools/fields_write.ts)
	// — no request naming a duplicate ever mentions the frame target's section,
	// so the re-mint would otherwise MINT ROWS THERE for a curator holding level
	// 1 (read-only) on it, or 0. Same shape the relation write path uses before
	// linking into another section (relations/save.ts): ask the level on the
	// target, refuse rather than downgrade or skip. Least privilege: a refused
	// duplicate is recoverable, rows minted in a section the curator cannot
	// write are not — and they would carry that curator's audit stamps.
	//
	// Asked BEFORE the record is read, so a principal with no write grant does
	// not learn from the refusal whether the target still exists. THE ORDER OF
	// THESE TWO BLOCKS IS THE INVARIANT, and it is gated: the DISCLOSURE ORDER
	// test in duplicate_record_dataframe_native.test.ts duplicates a host whose
	// frame target was DELETED as a principal without the grant, and requires
	// perm.denied — swapping them turns this 403 into an existence oracle.
	const { getSectionPermissions } = await import('../../security/permissions.ts');
	if ((await getSectionPermissions(actor, target.sectionTipo)) < 2) {
		throw new DedaloError('perm.denied', {
			message:
				`duplicateSectionRecord: refusing to duplicate ${sectionTipo}/${sectionId} — its ` +
				`component_dataframe slot '${target.frameTipo}' frames ${target.key}, and user ` +
				`${actor.userId} holds no write grant (level 2) on section '${target.sectionTipo}'`,
			coordinates: {
				section_tipo: sectionTipo,
				section_id: sectionId,
				component_tipo: target.frameTipo,
				target_section_tipo: target.sectionTipo,
				required: 2,
				operation: 'duplicate',
			},
		});
	}
	const table = await getMatrixTableFromTipo(target.sectionTipo);
	if (table === null) {
		throw refuseFrameCopy(
			`frames ${target.key}, whose section resolves to no matrix table`,
			target.frameTipo,
			sectionTipo,
			sectionId,
		);
	}
	if ((await readMatrixRecord(table, target.sectionTipo, target.sectionId)) === null) {
		throw refuseFrameCopy(
			`frames ${target.key}, which does not exist — a stale pairing left behind when that ` +
				'record was deleted (remove the frame from this record, then duplicate again)',
			target.frameTipo,
			sectionTipo,
			sectionId,
		);
	}
}

/**
 * RE-MINT every dataframe frame target of the copy, or refuse the duplicate
 * (DATA-05 / WC-2026-08-27-duplicate-reminted-dataframe-targets).
 *
 * A dd490 pairing locator is an OWNERSHIP edge, not a reference: the frame's
 * fields live in the record it addresses, and the contract is one target per
 * data item. Portal/thesaurus locators in the same bag are references and stay
 * shared — copying them is correct; copying a pairing is not.
 *
 * Each distinct target is deep-copied through this very writer (recursively, so
 * a frame target carrying frames of its own is re-minted the same way, and its
 * own reference locators stay shared), then the copied locator is re-pointed.
 * `id`, `id_key` and `main_component_tipo` are untouched: the duplicate copies
 * the main component's items verbatim, ids included, so the pairing that made
 * the frame findable is exactly as valid on the copy.
 *
 * NOT transactional, deliberately: this writer is not tx-wrapped (the observer
 * cascade refuses to run inside a transaction), so a failure between two mints
 * can leave a stray unreferenced target copy. That is a leak, and a leak is
 * recoverable; a shared frame target is not.
 */
async function remintDataframeTargets(
	values: Partial<Record<MatrixJsonbColumn, unknown>>,
	sectionTipo: string,
	sourceSectionId: number,
	userId: number,
	now: Date,
	remintChain: ReadonlySet<string>,
	mediaOptions: DuplicateMediaOptions,
): Promise<void> {
	const frames = collectDataframeEntries(values);
	if (frames.length === 0) return;
	// `null` = a frame that names no record address (external remote id, absent):
	// it owns nothing, so it is copied verbatim. A frame that DOES name one and
	// cannot be minted from throws out of here, before anything is copied.
	const addresses = frames.map((frame) => frameTargetAddress(frame, sectionTipo, sourceSectionId));
	// Keyed by TARGET: two main items framing the same record share one frame
	// record in the source and must share exactly one copy in the duplicate —
	// minting per locator would silently split that topology in two.
	const distinct = new Map<string, FrameTarget>();
	for (const target of addresses) if (target !== null) distinct.set(target.key, target);
	if (distinct.size === 0) return;
	const chain = new Set([...remintChain, recordKey(sectionTipo, sourceSectionId)]);
	// THE ACTOR, resolved once for the whole re-mint (cached per user_id). The
	// `userId` parameter IS the identity this duplication is performed as — every
	// audit stamp above is written with it — so it is the identity whose grants
	// decide where rows may be minted.
	const { resolvePrincipal } = await import('../../security/permissions.ts');
	const actor = await resolvePrincipal(userId);
	// Pre-flight EVERY target of THIS record before minting any: a refusal must
	// not leave half of this record's frames copied and the other half about to
	// be shared. It is one level deep — a nested target carrying frames of its
	// own is pre-flighted when the recursion reaches it, so a refusal raised
	// there fires after this level's earlier targets were minted (a stray
	// unreferenced copy: the leak the entry's residual section states).
	for (const target of distinct.values()) {
		await assertFrameTargetDuplicable(target, sectionTipo, sourceSectionId, chain, actor);
	}
	const minted = new Map<string, number>();
	for (const [key, target] of distinct) {
		minted.set(
			key,
			await duplicateSectionRecord(
				target.sectionTipo,
				target.sectionId,
				userId,
				now,
				chain,
				mediaOptions,
			),
		);
	}
	for (const [index, frame] of frames.entries()) {
		const target = addresses[index] ?? null;
		if (target === null) continue; // copied verbatim: it addresses no record
		const entry = frame.items[frame.index] as Record<string, unknown>;
		frame.items[frame.index] = { ...entry, section_id: minted.get(target.key) as number };
	}
}

/** The inputs of step 4b (duplicateRecordMedia). */
interface RecordMediaCopy {
	sectionTipo: string;
	sourceSectionId: number;
	newSectionId: number;
	/** The SOURCE record's columns — the walk resolves its buckets from them. */
	sourceColumns: Record<string, unknown>;
	/** The clone's inserted values: `media[tipo]` is replaced by what the write-back wrote. */
	values: Partial<Record<MatrixJsonbColumn, unknown>>;
	/** The copied slices: a media component's `items` is replaced likewise (the history reads them). */
	copied: CopiedComponent[];
	/** Existing files each media component's source index claimed (stripSourceIndex). */
	claimed: ReadonlyMap<string, number>;
	/** See DuplicateMediaOptions.mediaRoot (null = none, undefined = the configured one). */
	mediaRoot: string | null | undefined;
}

/**
 * STEP 4b — the clone's media (CORE-5): copy the files, then re-index the clone
 * at its own identity, and answer one VERDICT per media component.
 *
 * The write-back ALWAYS runs, a failed copy included — the clone is committed
 * with an empty index (step 1), and whatever DID land is indexed truthfully at
 * the clone's own identity; it can never name the source's files. Every way the
 * clone's media ends up short of the source's is logged (`media.operation_failed`,
 * with the coordinates and the stage) and counted (`duplicate_media_incomplete`)
 * — and returned. Never thrown: the row is already committed, and a duplicate
 * whose media is incomplete is still a duplicate the curator can repair (the
 * files_info sweep rewrites any index; the copy can be re-run by hand).
 */
async function duplicateRecordMedia(input: RecordMediaCopy): Promise<MediaCopyVerdict[]> {
	const components = input.copied.filter(
		(component) => component.column === 'media' && input.claimed.has(component.tipo),
	);
	if (components.length === 0) return [];
	const verdicts: MediaCopyVerdict[] = [];
	const clone = { sectionTipo: input.sectionTipo, sectionId: input.newSectionId };
	const mediaRoot = input.mediaRoot === undefined ? config.media.rootPath : input.mediaRoot;
	if (mediaRoot === null) {
		// No media root: nothing can be copied. The clone's index is already empty
		// (step 1); a component whose source claimed files is short of them.
		for (const component of components) {
			const sourceFiles = input.claimed.get(component.tipo) ?? 0;
			if (sourceFiles === 0) continue;
			verdicts.push(
				reportIncomplete(input, {
					...clone,
					tipo: component.tipo,
					sourceFiles,
					copiedFiles: 0,
					incomplete: true,
					stage: 'no_media_root',
				}),
			);
		}
		return verdicts;
	}
	const { perComponent } = await duplicateSectionMediaFiles(
		input.sectionTipo,
		input.sourceSectionId,
		input.newSectionId,
		input.sourceColumns,
		// undefined = the configured root, resolved by the walk's own chokepoint
		{ mediaRoot: input.mediaRoot ?? undefined },
	);
	const copies = new Map<string, ComponentMediaCopy>(perComponent.map((copy) => [copy.tipo, copy]));
	for (const component of components) {
		const copy = copies.get(component.tipo);
		const verdict: MediaCopyVerdict = {
			...clone,
			tipo: component.tipo,
			sourceFiles: input.claimed.get(component.tipo) ?? 0,
			copiedFiles: copy?.copiedFiles ?? 0,
			incomplete: false,
		};
		const detail: IncompleteDetail = {};
		if (copy?.error !== undefined) {
			verdict.stage = 'copy';
			detail.copyReport = copy.error;
		}
		const indexed = await reindexCloneMedia(input, component);
		if (indexed.stage !== undefined && verdict.stage === undefined) {
			verdict.stage = indexed.stage;
			detail.cause = indexed.cause;
		}
		if (
			verdict.stage === undefined &&
			(verdict.copiedFiles < verdict.sourceFiles || verdict.copiedFiles < (copy?.sourceFiles ?? 0))
		) {
			verdict.stage = 'count';
		}
		verdict.incomplete = verdict.stage !== undefined;
		verdicts.push(verdict.incomplete ? reportIncomplete(input, verdict, detail) : verdict);
	}
	return verdicts;
}

/**
 * The clone's index, AT THE CLONE'S IDENTITY, through the one locked media-key
 * writer: the items read under the row lock are re-scanned (record-scoped path
 * options, so a named bucket is the clone's own; no shrink hold — this is a
 * fresh copy, not a partial-media box's valid index), and the written items
 * replace the copied ones in `values` and `copied` (the history reads them).
 */
async function reindexCloneMedia(
	input: RecordMediaCopy,
	component: CopiedComponent,
): Promise<{ stage?: MediaCopyVerdict['stage']; cause?: unknown }> {
	try {
		const model = await getModelByTipo(component.tipo);
		const spec = model === null ? null : mediaTypeOf(model);
		if (spec === null) return { stage: 'rescan' };
		const identityBase = {
			componentTipo: component.tipo,
			sectionTipo: input.sectionTipo,
			sectionId: input.newSectionId,
		};
		const resolved = await resolveMediaPathOptions(
			component.tipo,
			input.sectionTipo,
			input.newSectionId,
		);
		const pathOpts = { ...resolved, mediaRoot: input.mediaRoot ?? undefined };
		const { rescanMediaItems } = await import('../../media/repair.ts');
		const { transformStoredMediaItems } = await import('../../media/tools/files_info_persist.ts');
		const outcome = await transformStoredMediaItems(
			identityBase,
			(locked) => ({
				write: rescanMediaItems(locked, { spec, identityBase, pathOpts, holdShrink: false })
					.items as StoredMediaItem[],
			}),
			// The duplicate's own clone, which the interactive caller waits for.
			{ lockWait: 'request' },
		);
		if (outcome.action === 'missing' || outcome.action === 'locked') {
			return { stage: outcome.action };
		}
		if (outcome.action === 'written' && outcome.items !== undefined) {
			const media = (input.values.media ?? {}) as Record<string, unknown>;
			media[component.tipo] = outcome.items;
			input.values.media = media;
			component.items = outcome.items as CopiedComponent['items'];
		}
		return {};
	} catch (error) {
		return { stage: 'rescan', cause: error };
	}
}

/**
 * Log + count one incomplete component, and answer its verdict. The failure's
 * text rides the LOG line (and the error's `cause`), never the verdict.
 */
function reportIncomplete(
	input: RecordMediaCopy,
	verdict: MediaCopyVerdict,
	detail: IncompleteDetail = {},
): MediaCopyVerdict {
	const report = detail.copyReport === undefined ? '' : ` — copy report: ${detail.copyReport}`;
	logError(
		new DedaloError('media.operation_failed', {
			message: `duplicateSectionRecord: the media of ${input.sectionTipo}/${input.newSectionId} (a duplicate of ${input.sourceSectionId}) is not a complete copy — component '${verdict.tipo}' stopped at '${verdict.stage}'${report}`,
			cause: detail.cause,
			coordinates: {
				section_tipo: input.sectionTipo,
				source_id: input.sourceSectionId,
				target_id: input.newSectionId,
				component_tipo: verdict.tipo,
				stage: verdict.stage ?? 'unknown',
				source_files: verdict.sourceFiles,
				copied_files: verdict.copiedFiles,
			},
		}),
		{ subsystem: 'duplicate_record' },
	);
	incrementCounter('duplicate_media_incomplete');
	return verdict;
}

/**
 * The history identity of a copied key. A key whose tipo the ontology no longer
 * stores (no model — a node removed from the ontology — or a model with no
 * matrix column) is recorded the way the wipe and revert doors record it: one
 * unsliced, non-translatable lane, lg-nolan (bulk_revert_records.ts
 * wipedMainIdentity). Otherwise the door lane of the working data lang —
 * currentDataLang(), NOT config.menu.dataLang (P0-7/DATA-01): the lane this
 * picks is the one the duplicate's save row is stamped with, so the install
 * default silently audited the copy under a language the operator was not
 * working in.
 */
async function copiedKeyIdentity(tipo: string, storable: boolean): Promise<LaneIdentity> {
	if (!storable) return { tipo, sliced: false, translatable: false, lang: NOLAN };
	// A SPEAKING door (WC-2026-09-27 addendum 2026-09-30): the lane its save
	// writes — effectiveSaveLang(currentDataLang()) via mainIdentity — never a
	// local override (a transliterable/iri copy files where its save does).
	return mainIdentity(tipo, currentDataLang());
}

/**
 * Step 5 of a duplicate — the Time Machine, per copied MAIN component, in its
 * two lanes (relations/dataframe_slots.ts, WC-2026-09-27-bulk-revert-undo-log
 * "two lanes"):
 *   (a) the BACKFILL (PHP tm_record::create previous_data path: history is
 *       empty on a fresh record, so the FULL copied value is stored first,
 *       stamped one minute EARLIER to order before the save) — one row per
 *       language lane holding a value, and the lg-nolan row (the lg-nolan value
 *       + the copy's re-minted frames) when it holds anything;
 *   (b) the SAVE row of the re-save loop's instance lang
 *       (= effectiveSaveLang(currentDataLang()): the data lang for a
 *       translatable, transliterable or iri component, lg-nolan otherwise):
 *       that lane's value — for lg-nolan, the value + the frames.
 * A dataframe SLOT gets no row of its own (its frames ride in the main's
 * lg-nolan lane, and apply_value refuses a slot row).
 */
async function recordDuplicateHistory(
	target: { table: string; sectionTipo: string; sectionId: number },
	copied: readonly CopiedComponent[],
	relationBag: unknown,
	audit: { userId: number; now: Date },
): Promise<void> {
	const saveStamp = { userId: audit.userId, timestamp: dbTimestamp(audit.now), bulkId: null };
	const backfillStamp = {
		userId: audit.userId,
		timestamp: dbTimestamp(new Date(audit.now.getTime() - 60_000)),
	};
	for (const component of copied) {
		const storage = await mainStorage(component.tipo);
		if (storage?.model === 'component_dataframe') continue;
		const identity = await copiedKeyIdentity(component.tipo, storage !== null);
		const state = {
			value: component.items,
			slots: await slotsFromBag(component.tipo, relationBag),
		};
		await recordMainBackfill(target, identity, state, backfillStamp);
		await recordMainHistory(target, identity, { before: state, after: state }, saveStamp);
	}
}
