/**
 * tool_update_cache server module (PHP tool_update_cache).
 *
 * get_component_list: enumerate a section's components (the "simple" element
 *   context, reusing get_section_elements_context) so the client can offer them
 *   for cache regeneration. Each is annotated with its regenerate_options.
 * update_cache (backgroundRunnable): regenerate the STORED per-record data of the
 *   selected components across every matched record.
 *
 * SCOPE: PHP `regenerate_component()` is a per-model dispatch. Here:
 * - MEDIA components REPAIR the media (PHP parity) via the shared kernel
 *   core/media/repair.ts, in its two halves: regenerateMediaDerivatives rebuilds
 *   the derivative files from the original where it is present on this box
 *   (processing.ts regenerate twins — the same seams upload ingest uses),
 *   OUTSIDE any lock; then the LOCKED TRANSFORM (files_info_persist.ts
 *   transformStoredMediaItems) re-scans the items read under the row lock and
 *   writes the fresh files_info — so an upload a curator committed while the
 *   files were being rebuilt is refreshed, never reverted to this run's
 *   snapshot (TOOLS-5, WC-2026-09-30-media-key-locked-transform). A record
 *   whose stored files_info is stale (e.g. written while MEDIA_PATH pointed at
 *   the wrong tree) is repaired by exactly this. AV derivatives are an ASYNC
 *   transcode (jobs.ts) — update_cache refreshes the av files_info from disk
 *   but does not enqueue transcodes (that is tool_media_versions' job).
 * - Every other model regenerates via re-save (set_data of the current value),
 *   re-running the save path's derivation.
 */

import { isDerivedModel } from '../../../src/core/components/registry.ts';
import { isMediaModel, mediaTypeOf } from '../../../src/core/concepts/media.ts';
import { DedaloError, isDedaloError, ok } from '../../../src/core/errors/index.ts';
import type { StoredMediaItem } from '../../../src/core/media/tools/files_info_persist.ts';
import { getModelByTipo } from '../../../src/core/ontology/resolver.ts';
import { currentDataLang } from '../../../src/core/resolve/request_lang.ts';
import { buildSectionElementsContext } from '../../../src/core/resolve/section_elements_context.ts';
import type { Principal } from '../../../src/core/security/permissions.ts';
import { authorizeRecordAccess, type RecordGrant } from '../../../src/core/security/write_door.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	type ToolServerModule,
	toolRequestId,
	type WriteTarget,
} from '../../../src/core/tools/module.ts';

/**
 * Regenerate options a model exposes (v6 component_media_common::
 * get_regenerate_options :3300). The copied client ITERATES this as a
 * descriptor array and switches on `type` (render_regenerate_options) —
 * returning any other shape renders a silently empty options panel.
 */
function regenerateOptionsFor(model: string): Record<string, unknown>[] | null {
	if (isMediaModel(model)) {
		return [{ name: 'delete_normalized_files', type: 'boolean', default: false }];
	}
	return null;
}

/** get_component_list: the section's components + their regenerate_options. */
/**
 * A caller fault. `message` AND `publicMessage`: update_cache is
 * backgroundRunnable, and the executor records the converter's wire sentence
 * on the job (background.ts `wireMessage`: this `publicMessage`, the code's
 * disclosure being public) — `message` is the log line only.
 */
function invalidRequest(message: string): DedaloError {
	return new DedaloError('request.invalid_options', { message, publicMessage: message });
}

async function getComponentList(ctx: ToolActionContext): Promise<ToolResponse> {
	const elements = await buildSectionElementsContext(ctx.principal, {
		ar_section_tipo: ctx.options.ar_section_tipo as string | string[] | undefined,
		context_type: 'simple',
		use_real_sections: Boolean(ctx.options.use_real_sections),
		ar_components_exclude: ctx.options.ar_components_exclude as string[] | undefined,
	});
	// Keep the section + grouper (section_group/section_tab) rows PHP emits, in
	// ontology order: the client's render_components_list switches on model to
	// build the named .ul_regular group headers. Dropping them (component-only)
	// left every row ungrouped. regenerate_options is a COMPONENT concern, so it
	// is stamped only on components (PHP omits the key on groupers/section).
	const rows = elements.map((entry) =>
		entry.type === 'component'
			? { ...entry, regenerate_options: regenerateOptionsFor(String(entry.model)) }
			: entry,
	);
	return ok(rows, { requestId: toolRequestId(ctx) });
}

/**
 * update_cache: regenerate the STORED data of the selected components across every
 * matched record. The generic regenerate is a re-save (set_data of the current
 * value) — this re-runs the save path's derivation (e.g. the relation_search
 * ancestor index for autocomplete_hi, counter reconciliation). MEDIA components
 * additionally need a file-derivative rebuild; that runs only where the media
 * files are present (ledgered on file-less boxes), so it is reported, not faked.
 */
async function updateCache(ctx: ToolActionContext): Promise<ToolResponse> {
	const sectionTipo = String(ctx.options.section_tipo ?? '');
	const selection = (ctx.options.components_selection ?? []) as {
		tipo?: string;
		regenerate_options?: unknown;
	}[];
	if (sectionTipo === '' || !Array.isArray(selection) || selection.length === 0) {
		throw invalidRequest('section_tipo and a non-empty components_selection are required');
	}
	const { sanitizeClientSqo } = await import('../../../src/core/concepts/sqo.ts');
	const { buildSearchSql } = await import('../../../src/core/search/sql_assembler.ts');
	const { runSearch } = await import('../../../src/core/search/search_statement.ts');
	const { withTransaction } = await import('../../../src/core/db/postgres.ts');
	const { readMatrixRecord } = await import('../../../src/core/db/matrix.ts');
	const { readComponentItems } = await import('../../../src/core/resolve/component_data.ts');
	const { getMatrixTableFromTipo } = await import('../../../src/core/ontology/resolver.ts');
	const { saveComponentData } = await import('../../../src/core/section/record/save_component.ts');
	const { regenerateMediaDerivatives, rescanMediaItems } = await import(
		'../../../src/core/media/repair.ts'
	);
	const { transformStoredMediaItems } = await import(
		'../../../src/core/media/tools/files_info_persist.ts'
	);
	const { resolveMediaPathOptions } = await import('../../../src/core/media/ontology_path.ts');

	// Matched records: the client SQO, REQUIRED (no limit; pagination stripped so
	// the whole matched set — not just the visible page — is processed). There is
	// deliberately NO whole-section fallback: an absent sqo once silently swept an
	// entire 438k-record section that the client displayed as "Records: 1"
	// (2026-07-19 incident, WC-043). The client always sends its live list sqo —
	// an unfiltered list matches the whole section EXPLICITLY; scripted callers
	// pass { section_tipo: ['…'] } themselves.
	const sqoRaw = ctx.options.sqo as Record<string, unknown> | undefined;
	if (sqoRaw === null || typeof sqoRaw !== 'object' || Array.isArray(sqoRaw)) {
		throw invalidRequest(
			'sqo is required (the scope to act on — no whole-section default; WC-043)',
		);
	}
	// DERIVED components are skipped HERE, server-side, whatever the client's
	// `ar_components_exclude` offered (registry.ts isDerivedModel): they own no
	// stored value, so a "regenerate" re-save would replay leftover bytes under
	// their tipo as if they were the value — for component_relation_children,
	// whose save writes THROUGH to each child's parent link, that re-parents a
	// thesaurus from stale leftovers. Nothing is stored, nothing to regenerate.
	const derivedSkipped: string[] = [];
	const regenerable: typeof selection = [];
	for (const sel of selection) {
		const tipo = String(sel.tipo ?? '');
		const model = tipo !== '' ? await getModelByTipo(tipo) : null;
		if (model !== null && isDerivedModel(model)) derivedSkipped.push(tipo);
		else regenerable.push(sel);
	}
	const derivedNote =
		derivedSkipped.length > 0
			? ` ${derivedSkipped.length} derived component(s) skipped (${derivedSkipped.join(', ')}): computed, nothing stored to regenerate.`
			: '';
	if (regenerable.length === 0) {
		return ok(
			{
				summary: `OK. Nothing to regenerate.${derivedNote}`,
				errors: [],
				regenerated: 0,
				refused: 0,
				derived_skipped: derivedSkipped,
				records: 0,
				processed: 0,
				stopped: false,
				bulk_process_id: null,
				media_errors: 0,
				media_held: 0,
				vanished: 0,
				locked: 0,
			},
			{ requestId: toolRequestId(ctx) },
		);
	}
	const sqo = sanitizeClientSqo(structuredClone(sqoRaw));
	(sqo as { limit?: unknown; offset?: unknown }).limit = null;
	(sqo as { limit?: unknown; offset?: unknown }).offset = 0;
	const built = await buildSearchSql(sqo, { principal: ctx.principal });
	const rows = (await runSearch(built)) as {
		section_tipo: string;
		section_id: number;
	}[];

	// Bulk-process record (v6 :64-92): one dd800 record per run, labeled
	// 'Update cache | <section> | <components>'. Its id tags any files the
	// delete_normalized_files option moves to deleted/<id>/ — created BEFORE any
	// record is touched.
	const { createSectionRecord } = await import('../../../src/core/section/record/create_record.ts');
	const { BULK_PROCESS_TIPOS } = await import('../../../src/core/concepts/section.ts');
	const { getTermByTipo } = await import('../../../src/core/ontology/resolver.ts');
	const labelLang = typeof ctx.options.lang === 'string' ? ctx.options.lang : 'lg-eng';
	const componentNames = await Promise.all(
		regenerable.map(async (sel) => {
			const tipo = String(sel.tipo ?? '');
			return `${(await getTermByTipo(tipo, labelLang)) ?? tipo}[${tipo}]`;
		}),
	);
	const sectionName = (await getTermByTipo(sectionTipo, labelLang)) ?? sectionTipo;
	// ATOMIC + FAIL-CLOSED: the row and its label are ONE mint (a failing label
	// leaves no orphan dd800), and a failure throws before any record is touched.
	const bulkLabel = `Update cache | ${sectionName}[${sectionTipo}] | ${componentNames.join(', ')}`;
	const bulkProcessId = await withTransaction(async () => {
		const id = await createSectionRecord(BULK_PROCESS_TIPOS.section, ctx.userId);
		const outcome = await saveComponentData({
			componentTipo: BULK_PROCESS_TIPOS.label,
			sectionTipo: BULK_PROCESS_TIPOS.section,
			sectionId: id,
			lang: 'lg-nolan',
			changedData: [{ action: 'set_data', id: null, value: [{ value: bulkLabel }] }],
			userId: ctx.userId,
		});
		if (outcome.ok === false) {
			throw new DedaloError('record.save_failed', {
				message: `update_cache: the dd800 run label was refused: ${outcome.message}`,
				coordinates: { section_tipo: BULK_PROCESS_TIPOS.section, tipo: BULK_PROCESS_TIPOS.label },
			});
		}
		return id;
	});
	const { withLiveBulkRun } = await import('../../../src/core/tools/bulk_run_registry.ts');

	// Progress: the pfile frame the client's stream renderer already formats
	// (data.counter / data.total / data.current.section_id / data.n_components —
	// render_tool_update_cache.js compound_msg). Throttled: every publish is a
	// pfile write, so tick at most every PROGRESS_MS (the final row always ticks).
	const publish = ctx.publishProgress ?? (() => {});
	const PROGRESS_MS = 250;
	let lastPublish = 0;
	let counter = 0;

	let regenerated = 0;
	let mediaHeld = 0;
	/** Media components whose record was DELETED during the run (nothing written). */
	let vanished = 0;
	/** Media components whose row stayed locked past the lock timeout (nothing written). */
	let lockedOut = 0;
	let stopped = false;
	const mediaErrors: string[] = [];
	/** Media components that wrote nothing because the record vanished / stayed locked. */
	let mediaNotWritten = 0;
	/** Non-media re-saves that wrote nothing (vanished, locked, refused by the save door). */
	const resaveErrors: string[] = [];
	/** Of those, the ones the SAVE DOOR refused (ok:false — rolled back whole). */
	let refusedResaves = 0;
	/** Row × component targets the WRITE DOOR refused (nothing written to them). */
	const refusedTargets: string[] = [];
	// The run is held in the active-run registry while it writes: a revert of
	// it is refused until it ends (decision D5).
	await withLiveBulkRun(bulkProcessId, async () => {
		for (const row of rows) {
			// Cooperative cancellation (dd_utils_api::stop_process → mediaJobs.stop →
			// the executor's AbortSignal): finish the current record, never mid-write.
			if (ctx.signal?.aborted === true) {
				stopped = true;
				break;
			}
			counter++;
			const now = Date.now();
			if (counter === rows.length || now - lastPublish >= PROGRESS_MS) {
				lastPublish = now;
				publish({
					msg: 'Running tool_update_cache::update_cache',
					is_running: true,
					counter,
					total: rows.length,
					current: { section_id: row.section_id },
					n_components: regenerable.length,
				});
			}
			const table = (await getMatrixTableFromTipo(row.section_tipo)) ?? 'matrix';
			const record = await readMatrixRecord(table, row.section_tipo, row.section_id);
			if (record === null) continue;
			for (const sel of regenerable) {
				const tipo = String(sel.tipo ?? '');
				const model = tipo !== '' ? await getModelByTipo(tipo) : null;
				if (model === null) continue;
				// THE WRITE DOOR, PER ROW (closure Step 3 req 10). The declarative
				// `targets` gate authorized each (sqo section, component) PAIR with no
				// record named — so the dd128 own-record downgrade (a user-manager's
				// own dd1725 is read-only) never applied to the ROWS the sqo matched,
				// and a section grant re-saved a component the per-component rule
				// never saw. Every row × component is now asked of the door — grammar,
				// section floor, the dd128-aware pair, the write scope — and its GRANT
				// addresses the write. A refused target is skipped and reported, never
				// written (tool_propagate_component_data's per-row precedent).
				const grant = await authorizeRowComponent(ctx.principal, row, tipo);
				if (grant === null) {
					refusedTargets.push(`${tipo}#${row.section_id}: not writable by the caller`);
					continue;
				}
				const spec = isMediaModel(model) ? mediaTypeOf(model) : null;
				if (spec !== null) {
					// MEDIA repair, in the kernel's two halves (core/media/repair.ts): the
					// FILE work first, from this run's snapshot and OUTSIDE any lock — it
					// builds only the MISSING derivatives (v6 regenerate_component parity:
					// an existing file is never re-encoded; image thumb always; envelope
					// create-or-fix); then the LOCKED TRANSFORM re-scans the items as they
					// stand under the row lock and writes them (files_info_persist.ts — the
					// one media-key writer; per-key jsonb, NO Time Machine entry — files_info
					// is a filesystem cache).
					//
					// NAMED EXEMPTION from the undo log (decision D4, WC
					// bulk-revert-undo-log, addendum WC-2026-09-30-media-key-locked-transform):
					// this write records no BEFORE/AFTER pair, so a bulk revert of this run
					// leaves it in place. files_info is DERIVED from the files on disk, and
					// the files this pass moves to deleted/<bulk id>/ or rebuilds are not
					// database state a revert could put back — restoring the old files_info
					// would describe files that are no longer where it says. The next
					// update_cache re-derives it from whatever the disk then holds.
					const storedItems = (readComponentItems(record, tipo, model) ?? []) as unknown[];
					if (storedItems.length === 0) continue;
					const regenerateOptions = (sel.regenerate_options ?? null) as {
						delete_normalized_files?: unknown;
					} | null;
					const pathOpts = await resolveMediaPathOptions(tipo, row.section_tipo, row.section_id);
					const errors = await regenerateMediaDerivatives({
						componentTipo: tipo,
						sectionTipo: row.section_tipo,
						sectionId: row.section_id,
						model,
						items: storedItems,
						// v6 delete_normalized_files (the client's per-component regenerate
						// checkbox): move the normalized default-quality files to
						// deleted/<bulk id>/ before the rebuild.
						deleteNormalized: regenerateOptions?.delete_normalized_files === true,
						bulkProcessId,
						pathOpts,
					});
					mediaErrors.push(...errors.map((message) => `${tipo}#${row.section_id}: ${message}`));
					// v6 media_common regenerate (:2670-2705): a missing original_file_name
					// is recovered from the section's target_filename component — resolved
					// HERE (it reads the ontology and the record), applied under the lock.
					const nameRepair = await resolveOriginalNameRepair(
						tipo,
						record,
						row.section_tipo,
						row.section_id,
					);
					let heldShrinks = 0;
					const outcome = await transformStoredMediaItems(
						{
							sectionTipo: grant.sectionTipo,
							sectionId: grant.sectionId,
							componentTipo: grant.componentTipo,
						},
						(locked) => {
							// Removed since the snapshot: nothing left to refresh.
							if (locked.length === 0) return { skip: 'noop' };
							const rescan = rescanMediaItems(locked, {
								spec,
								identityBase: {
									componentTipo: tipo,
									sectionTipo: row.section_tipo,
									sectionId: row.section_id,
								},
								pathOpts,
								// NEVER shrink from a tool sweep: on a partial-media box the rescan
								// would wipe the valid index of every record whose files are not
								// local (the 2026-07-19 incident). Judged on the LOCKED items: a
								// shrink only the committed value shows is held too.
								holdShrink: true,
							});
							heldShrinks = rescan.heldShrinks;
							return {
								write: applyOriginalNameRepair(rescan.items, nameRepair) as StoredMediaItem[],
							};
						},
						// A run over many records: one held row is THAT record's `locked`,
						// never a wait that stalls (or, under a statement ceiling, aborts)
						// the run — the request pool bounds no lock wait on its own.
						{ lockWait: 'per-record' },
					);
					if (outcome.action === 'missing') {
						vanished += 1;
						mediaNotWritten += 1;
						mediaErrors.push(
							`${tipo}#${row.section_id}: record deleted during the run — nothing written`,
						);
						continue;
					}
					if (outcome.action === 'locked') {
						lockedOut += 1;
						mediaNotWritten += 1;
						mediaErrors.push(
							`${tipo}#${row.section_id}: the record stayed locked past the lock timeout — nothing written`,
						);
						continue;
					}
					mediaHeld += heldShrinks;
					regenerated += 1;
					continue;
				}
				// THE RE-SAVE IS A LOCKED READ-MODIFY-WRITE
				// (WC-2026-10-21-update-cache-locked-resave). The value re-saved is the
				// one stored UNDER the row lock, in the transaction that writes it —
				// never this run's per-row
				// snapshot, read unlocked above and possibly minutes old (a media
				// rebuild of the same row runs first): re-saving the snapshot replaced
				// a cataloguer's committed edit with the pre-edit bytes, and recreated a
				// record deleted meanwhile. One transaction per row × component (every
				// lang group atomically), its lock wait bounded per record like the
				// media branch's, so one held row is THAT record's `locked`.
				const resave = await resaveUnderRowLock(grant, model, tipo, bulkProcessId);
				if (resave === 'missing') {
					vanished += 1;
					resaveErrors.push(
						`${tipo}#${row.section_id}: record deleted during the run — nothing written`,
					);
					continue;
				}
				if (resave === 'locked') {
					lockedOut += 1;
					resaveErrors.push(
						`${tipo}#${row.section_id}: the record stayed locked past the lock timeout — nothing written`,
					);
					continue;
				}
				if (resave === 'empty') continue;
				if (resave !== 'written') {
					refusedResaves += 1;
					resaveErrors.push(
						`${tipo}#${row.section_id}: the re-save was refused — nothing written (${resave.refused})`,
					);
					continue;
				}
				regenerated += 1;
			}
		}
	});
	// The abort check runs BEFORE the counter increment, so `counter` always equals
	// the number of FULLY processed records — stopped or not.
	const processed = counter;
	const summaryMsg = stopped
		? `Stopped. update_cache regenerated ${regenerated} component(s) across ${processed} of ${rows.length} matched record(s) before the stop.`
		: `OK. update_cache regenerated ${regenerated} component(s) across ${rows.length} record(s).`;
	const rebuildFailures = mediaErrors.length - mediaNotWritten;
	const refusedNote =
		refusedTargets.length > 0
			? ` ${refusedTargets.length} target(s) the caller may not write were skipped (nothing written to them).`
			: '';
	const msg = `${summaryMsg}${refusedNote}${derivedNote}${refusedResaves > 0 ? ` ${refusedResaves} re-save(s) refused by the save door (nothing written to them).` : ''}${rebuildFailures > 0 ? ` ${rebuildFailures} media derivative rebuild(s) failed (files_info still refreshed).` : ''}${mediaHeld > 0 ? ` ${mediaHeld} stored media index(es) kept (files not on this server — shrink held).` : ''}${vanished > 0 ? ` ${vanished} record(s) deleted during the run (nothing written).` : ''}${lockedOut > 0 ? ` ${lockedOut} record(s) stayed locked (nothing written).` : ''}`;
	// Final frame: the client renders the summary from the last pfile data.
	publish({
		msg,
		is_running: false,
		counter: processed,
		total: rows.length,
		n_components: regenerable.length,
	});
	// A media derivative that could not be rebuilt does NOT fail the run (the
	// cache really was regenerated): it is payload, beside the summary the client
	// renders from the final frame.
	return ok(
		{
			summary: msg,
			errors: [...mediaErrors, ...resaveErrors, ...refusedTargets],
			regenerated,
			refused: refusedTargets.length,
			derived_skipped: derivedSkipped,
			records: rows.length,
			processed,
			stopped,
			bulk_process_id: bulkProcessId,
			media_errors: mediaErrors.length,
			media_held: mediaHeld,
			vanished,
			locked: lockedOut,
		},
		{ requestId: toolRequestId(ctx) },
	);
}

/** What one locked non-media re-save did (resaveUnderRowLock). */
type ResaveOutcome = 'written' | 'empty' | 'missing' | 'locked' | { refused: string };

/** A save-door refusal carried out of the re-save's transaction (so it rolls back whole). */
class ResaveRefused extends Error {
	constructor(readonly reason: string) {
		super(reason);
		this.name = 'ResaveRefused';
	}
}

/**
 * The save door's REFUSAL of one re-save, or null when `error` is not one. The
 * door says no two ways: an `ok:false` answer, or a THROWN typed error whose
 * registry category is the request's own (`caller` — a malformed stored item
 * the value-shape law refuses, a write lang this install does not declare) or
 * the target's (`permission`). Both are THIS record's verdict: reported per
 * record, never the end of the sweep (value_shape.ts: "the door then refuses
 * it: loud, per record"). Anything else — a database failure, an internal
 * error — is no verdict on the record and propagates.
 */
function saveDoorRefusal(error: unknown): string | null {
	if (!isDedaloError(error)) return null;
	const category = error.spec.category;
	return category === 'caller' || category === 'permission' ? error.message : null;
}

/**
 * ONE row × component regenerate of a NON-media component, as a locked
 * read-modify-write in ONE transaction (WC-2026-10-21-update-cache-locked-resave;
 * dedalo-ts-write-path §3 — the read sits under FOR UPDATE in the transaction
 * that writes): take the row lock (its wait bounded per record, the media
 * branch's bound: a sweep never stalls on one held row), read the record AS IT
 * STANDS UNDER THE LOCK, re-save every lang group of the component's stored
 * value. A refused group rolls the whole component back. `missing` = the record
 * is gone (never recreated), `locked` = the lock was not had in time, `empty` =
 * nothing stored (see below) — nothing written in any of those.
 */
async function resaveUnderRowLock(
	grant: RecordGrant,
	model: string,
	dataTipo: string,
	bulkProcessId: number,
): Promise<ResaveOutcome> {
	const { sql, sqlStateOf, withTransaction } = await import('../../../src/core/db/postgres.ts');
	const { MATRIX_JSONB_COLUMNS, readMatrixRecord } = await import('../../../src/core/db/matrix.ts');
	const { readMatrixKeyForUpdate } = await import('../../../src/core/db/matrix_write.ts');
	const { perRecordLockWaitMs } = await import(
		'../../../src/core/media/tools/files_info_persist.ts'
	);
	const { readComponentItems } = await import('../../../src/core/resolve/component_data.ts');
	const { getColumnNameByModel, getMatrixTableFromTipo, getTranslatableByTipo } = await import(
		'../../../src/core/ontology/resolver.ts'
	);
	const { saveComponentData } = await import('../../../src/core/section/record/save_component.ts');
	const { canonicalStoredItems } = await import('../../../src/core/section/record/value_shape.ts');
	const { groupItemsByLang } = await import('../../../src/core/tools/import_data.ts');

	const table = await getMatrixTableFromTipo(grant.sectionTipo);
	if (table === null) return 'missing';
	// A model with no matrix column stores nothing to regenerate.
	const column = MATRIX_JSONB_COLUMNS.find((name) => name === getColumnNameByModel(model));
	if (column === undefined) return 'empty';
	// Resolved BEFORE the lock (ontology reads, no row involved).
	const translatable = await getTranslatableByTipo(dataTipo);
	// currentDataLang(), NOT config.menu.dataLang (P0-7/DATA-01): the regenerate
	// bucket RE-SAVES curated values, so it must write in the language the
	// operator is working in. Reading the install default made every user whose
	// data lang differs re-stamp the wrong slice. Outside a request it falls back
	// to DEDALO_DATA_LANG_DEFAULT, the read fallback chain's first candidate — a
	// job's write stays reachable.
	const componentLang = translatable ? currentDataLang() : 'lg-nolan';
	try {
		return await withTransaction(async (): Promise<ResaveOutcome> => {
			await sql.unsafe(`SET LOCAL lock_timeout = '${perRecordLockWaitMs()}ms'`, []);
			// The row lock (FOR UPDATE on the record), taken through the component's key;
			// null = the record is gone. The items are then read the way every reader
			// and the save path read them (readComponentItems on the locked record) —
			// never the key read's own items, which answer `[]` for a PHP-era
			// non-array value (tool_propagate_component_data's propagateOneRecord).
			const lockedKey = await readMatrixKeyForUpdate(
				table,
				grant.sectionTipo,
				grant.sectionId,
				column,
				dataTipo,
			);
			if (lockedKey === null) return 'missing';
			const record = await readMatrixRecord(table, grant.sectionTipo, grant.sectionId);
			if (record === null) return 'missing';
			// The STORED items in the shape the save door accepts (value_shape.ts
			// canonicalStoredItems): a PHP-era numeric-string number is cast as PHP's
			// set_data did, so re-saving what the record holds is never refused as
			// malformed (WC-2026-10-03-save-refuses-malformed-value-shape).
			const items = canonicalStoredItems(column, readComponentItems(record, dataTipo, model) ?? []);
			// NOTHING STORED, NOTHING TO REGENERATE. An absent (or empty) key has no
			// value a derivation could refresh — and re-saving it would store `[]`
			// over ABSENCE, which the undo log (canonicalJson keeps the two apart)
			// records as a real change: a hidden BEFORE row plus a VISIBLE "[] saved
			// by the sweep" history row for every record of a sparse component. WC
			// …-bulk-revert-undo-log §2: a re-save that changes nothing leaves
			// history untouched.
			if (items.length === 0) return 'empty';
			// The stored array carries EVERY language; set_data is lang-sliced (PHP
			// set_data_lang), so a translatable literal is re-saved one lang group at
			// a time — a single flat save would re-stamp every translation onto
			// componentLang.
			for (const [lang, group] of groupItemsByLang(items, componentLang)) {
				const outcome = await saveComponentData({
					componentTipo: grant.componentTipo,
					sectionTipo: grant.sectionTipo,
					sectionId: grant.sectionId,
					lang,
					changedData: [{ action: 'set_data', id: null, value: group }],
					userId: grant.userId,
					// THE UNDO LOG (decision D1, WC bulk-revert-undo-log): a save under a
					// bulk id records its BEFORE/AFTER pair whatever saveTm says, and the
					// after-row is ordinary visible history — so the v6 "TM disabled for
					// the whole run" (:45-47) is retired here. A regenerate that re-saves
					// the SAME value writes nothing (the pair law skips a canonical
					// no-op), so the sweep adds history only where the derivation
					// actually CHANGED a value.
					bulkProcessId,
				}).catch((error: unknown) => {
					const refusal = saveDoorRefusal(error);
					if (refusal === null) throw error;
					throw new ResaveRefused(refusal);
				});
				// In this (ambient) transaction a refusal leaves the refused part's
				// writes to US: throw, so no lang group of a refused component stays —
				// whichever way the door said no (an answer, or a typed throw above).
				if (outcome.ok === false) throw new ResaveRefused(outcome.message);
			}
			return 'written';
		});
	} catch (error) {
		if (error instanceof ResaveRefused) return { refused: error.reason };
		if (sqlStateOf(error) === '55P03') return 'locked';
		if (isDedaloError(error) && error.code === 'db.lock_timeout') return 'locked';
		throw error;
	}
}

/**
 * The write door for ONE matched row's component (req 10): the grant, or null
 * when the door REFUSES it (perm.* / a target that is not a record address).
 * Any other failure is not a refusal and propagates — a broken database must
 * never read as "skipped".
 */
async function authorizeRowComponent(
	principal: Principal,
	row: { section_tipo: string; section_id: number },
	componentTipo: string,
): Promise<RecordGrant | null> {
	try {
		return await authorizeRecordAccess(
			principal,
			{ section_tipo: row.section_tipo, component_tipo: componentTipo, section_id: row.section_id },
			{ mode: 'write', level: 2, sectionFloor: 1, door: 'tool_update_cache.update_cache' },
		);
	} catch (error) {
		if (
			isDedaloError(error) &&
			(error.code.startsWith('perm.') || error.code === 'request.invalid')
		) {
			return null;
		}
		throw error;
	}
}

/** A recovered original name (see resolveOriginalNameRepair). */
interface OriginalNameRepair {
	fileName: string;
	/** `<identifier>.<ext of the recovered name>`, when the name has an extension. */
	normalizedName: string | null;
}

/**
 * v6 component_media_common::regenerate_component (:2670-2705): a media item
 * that lost its `original_file_name` recovers it from the section's
 * target-filename component (the component tipo named by the media component's
 * `properties.target_filename`, e.g. rsc398 'Original file name'), and derives
 * `original_normalized_name` (`<identifier>.<ext of the recovered name>`) when
 * that is missing too. The RESOLUTION half — async (the ontology, the record's
 * sibling value), run BEFORE the lock; `null` = nothing to recover.
 */
async function resolveOriginalNameRepair(
	componentTipo: string,
	record: { columns: Record<string, unknown> },
	sectionTipo: string,
	sectionId: number,
): Promise<OriginalNameRepair | null> {
	const { getPropertiesByTipo, getModelByTipo: modelByTipo } = await import(
		'../../../src/core/ontology/resolver.ts'
	);
	const { readComponentItems: readItems } = await import(
		'../../../src/core/resolve/component_data.ts'
	);
	const properties = (await getPropertiesByTipo(componentTipo)) as {
		target_filename?: unknown;
	} | null;
	const targetTipo =
		typeof properties?.target_filename === 'string' ? properties.target_filename : null;
	if (targetTipo === null) return null;
	const targetModel = await modelByTipo(targetTipo);
	if (targetModel === null) return null;
	const targetItems = (readItems(record as never, targetTipo, targetModel) ?? []) as {
		value?: unknown;
	}[];
	const fileName = targetItems.find((item) => typeof item?.value === 'string' && item.value !== '')
		?.value as string | undefined;
	if (fileName === undefined) return null;
	const extension = fileName.includes('.') ? (fileName.split('.').pop() ?? '') : '';
	return {
		fileName,
		normalizedName:
			extension !== '' ? `${componentTipo}_${sectionTipo}_${sectionId}.${extension}` : null,
	};
}

/**
 * The APPLICATION half — pure, run on the items read under the row lock: the
 * FIRST item gets the recovered name only when it has none (a curator's upload
 * committed since the snapshot wins). Never mutates the items it is handed.
 */
function applyOriginalNameRepair(
	items: readonly unknown[],
	repair: OriginalNameRepair | null,
): unknown[] {
	const result = [...items];
	const first = result[0] as Record<string, unknown> | undefined;
	if (repair === null || first === undefined || first === null || typeof first !== 'object') {
		return result;
	}
	if (typeof first.original_file_name === 'string' && first.original_file_name !== '')
		return result;
	const named: Record<string, unknown> = { ...first, original_file_name: repair.fileName };
	if (
		(typeof first.original_normalized_name !== 'string' || first.original_normalized_name === '') &&
		repair.normalizedName !== null
	) {
		named.original_normalized_name = repair.normalizedName;
	}
	result[0] = named;
	return result;
}

/** The section targets of a component-list request — the 'section_list' gate reads
 * these. The CLIENT sends the target section(s) as `ar_section_tipo` (string or
 * array), NEVER `section_tipo` — a plain 'section' gate here fails closed on every
 * request and the tool renders a silently empty component list. */
function componentListSectionTipos(options: Record<string, unknown>): unknown[] {
	const raw = options.ar_section_tipo;
	if (Array.isArray(raw)) return raw;
	return raw != null && raw !== '' ? [raw] : [];
}

/**
 * The WRITE TARGETS of an update_cache request — what the 'targets' gate
 * authorizes (audit CARRY-08 / TOOLS-04). The handler above re-saves
 * `components_selection[].tipo` on EVERY row `options.sqo` matches, so the
 * grant that matters is level 2 on each (sqo section, selected component) PAIR
 * — never on `options.section_tipo`, which only labels the dd800 bulk record.
 * A gate declared on that sibling field was satisfied by any section the caller
 * held write on (dd655 — which everyone holds) while the SQO named `es1` and
 * 69,148 rows were re-saved. Read off the SAME keys the handler reads; an SQO
 * naming no section, or an empty selection, yields [] and the gate refuses.
 */
export function updateCacheTargets(options: Record<string, unknown>): WriteTarget[] {
	const sqo = options.sqo as { section_tipo?: unknown } | null | undefined;
	const raw = sqo !== null && typeof sqo === 'object' ? sqo.section_tipo : undefined;
	const sectionTipos = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
	const selection = Array.isArray(options.components_selection) ? options.components_selection : [];
	const targets: WriteTarget[] = [];
	for (const sectionTipo of sectionTipos) {
		for (const selected of selection) {
			targets.push({
				section_tipo: sectionTipo,
				tipo: (selected as { tipo?: unknown } | null)?.tipo,
			});
		}
	}
	return targets;
}

export const tool: ToolServerModule = {
	name: 'tool_update_cache',
	apiActions: {
		get_component_list: {
			permission: 'section_list',
			minLevel: 1,
			sectionTipos: componentListSectionTipos,
			handler: getComponentList,
		},
		update_cache: {
			permission: 'targets',
			minLevel: 2,
			targets: updateCacheTargets,
			handler: updateCache,
		},
	},
	backgroundRunnable: ['update_cache'],
	// A stored-data rebuild — operator work (PERF-11 lane declaration).
	backgroundLanes: { update_cache: 'maintenance' },
};
