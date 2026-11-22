/**
 * tool_propagate_component_data server module (PHP tool_propagate_component_data).
 *
 * propagate_component_data (backgroundRunnable): apply one component value across
 * every record matched by the client SQO — replace / delete / add. The target set
 * is a SEARCH (not a locator list); the source value is the client-supplied
 * `propagate_data_value`. Every write shares a bulk_process_id so tool_time_machine
 * can revert the whole batch (see bulk_revert_process).
 *
 * PERMISSION — THE WRITE DOOR, like every save (T2-S06, owner FYI-1 2026-11-18:
 * "every save the same way, NO exceptions"). The batch names no single record,
 * so `permission: null` and the door is asked in the handler, twice:
 *   - UP FRONT, the client-declared target as a SECTION target
 *     (authorizeSectionTarget: the section floor 1, then the pair at 2) — PHP
 *     asked only the pair, so a profile holding the component at 2 and the
 *     section at 0 could rewrite every record of a section it may not enter;
 *   - PER MATCHED ROW, authorizeRecordAccess (write, level 2, section floor 1,
 *     the dd128-aware pair, the write scope) on the row's OWN coordinates — the
 *     SQO may reach another section than the declared one (TOOLS-01) — and the
 *     row's GRANT addresses the write. A refused row is reported, never written.
 * The hand-rolled per-row pair + scope check it replaces is gone.
 *
 * BACKGROUND: the handler publishes a throttled progress frame per record (the
 * `msg | section_label | counter of total | id:` line the client's SSE reader
 * renders) and honors `ctx.signal` at the loop boundary, so the panel's Stop
 * button really stops the batch — a partial run keeps its bulk_process_id and
 * stays revertible.
 *
 * THE WRITE goes through the ENGINE (the undo log, WC bulk-revert-undo-log).
 * Per record, ONE transaction:
 *   1. `readMatrixKeyForUpdate` locks the row; the stored key is read behind
 *      the lock through `readComponentItems` (the reader's `[raw]` coercion);
 *   2. `applyPropagation` (the tested pure core, `propagate.ts`) decides over
 *      the SAVE PATH's language region — `regionOf` with `isLangSlicedModel`,
 *      never the ontology `translatable` flag. A translatable RELATION is
 *      unsliced on the save path, so its region is the whole key: deciding over
 *      one language's items and set_data-ing them would replace the whole key
 *      with that language alone (M2);
 *   3. `saveComponentData` `set_data` joins the transaction. It records the
 *      run's BEFORE/AFTER pair under the bulk id (one language per row), stamps
 *      the modified metadata and runs the first-level observer recompute
 *      INSIDE the per-record transaction (a failure rolls the record back,
 *      B6); cascade hops are deferred to commit.
 * It used to read unlocked, write with no transaction, and stamp every
 * language into one TM row under the request lang.
 *
 * FAIL-CLOSED MINT: the dd800 row + its label are ONE transaction before any
 * record is touched, and a failure refuses the run — an unattributable
 * propagation is one no revert can name (bulk_process_id_tripwire). The run is
 * held in the active-run registry while it writes, so a revert of it is refused
 * until it ends (decision D5).
 */

import { isDerivedModel, isMonovalueModel } from '../../../src/core/components/registry.ts';
import { regionOf } from '../../../src/core/concepts/lang_region.ts';
import { BULK_PROCESS_TIPOS } from '../../../src/core/concepts/section.ts';
import { sanitizeClientSqo } from '../../../src/core/concepts/sqo.ts';
import { type MatrixJsonbColumn, readMatrixRecord } from '../../../src/core/db/matrix.ts';
import { readMatrixKeyForUpdate } from '../../../src/core/db/matrix_write.ts';
import { withTransaction } from '../../../src/core/db/postgres.ts';
import { DedaloError, isDedaloError, ok } from '../../../src/core/errors/index.ts';
import { resolveDataTipo } from '../../../src/core/ontology/alias.ts';
import { termByTipo } from '../../../src/core/ontology/labels.ts';
import {
	effectiveSaveLang,
	getColumnNameByModel,
	getMatrixTableFromTipo,
	getModelByTipo,
} from '../../../src/core/ontology/resolver.ts';
import { readComponentItems } from '../../../src/core/resolve/component_data.ts';
import { currentApplicationLang } from '../../../src/core/resolve/request_lang.ts';
import { runSearch } from '../../../src/core/search/search_statement.ts';
import { buildSearchSql } from '../../../src/core/search/sql_assembler.ts';
import { createSectionRecord } from '../../../src/core/section/record/create_record.ts';
import {
	isLangSlicedModel,
	saveComponentData,
} from '../../../src/core/section/record/save_component.ts';
import { canonicalStoredItems } from '../../../src/core/section/record/value_shape.ts';
import { isFixedDataframeSlot, type Principal } from '../../../src/core/security/permissions.ts';
import {
	authorizeRecordAccess,
	authorizeSectionTarget,
	type RecordGrant,
} from '../../../src/core/security/write_door.ts';
import { withLiveBulkRun } from '../../../src/core/tools/bulk_run_registry.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	type ToolServerModule,
	toolRequestId,
} from '../../../src/core/tools/module.ts';
import { applyPropagation, COMPONENTS_WITH_RELATIONS, type PropagateAction } from './propagate.ts';

const VALID_ACTIONS: ReadonlySet<string> = new Set(['replace', 'delete', 'add']);

/**
 * A caller-fault refusal. `message` AND `publicMessage`: the action is
 * backgroundRunnable, and the executor records the converter's wire sentence on
 * the job record (background.ts `wireMessage`: this `publicMessage`, the code's
 * disclosure being public — the one place a curator reads why a detached batch
 * stopped); `message` is the log line only.
 */
function invalidRequest(message: string): DedaloError {
	return new DedaloError('request.invalid_options', { message, publicMessage: message });
}

/**
 * The dd800 run record + its label, ONE transaction, FAIL-CLOSED (the twin of
 * import_execute's `createBulkProcessRecord`). A throw here reaches the caller
 * before a single record is touched. The label rides the engine's save door and
 * carries no bulk id: the dd800 row is the run's anchor, never part of what the
 * run changed.
 */
async function createBulkProcess(label: string, userId: number): Promise<number> {
	return await withTransaction(async () => {
		const bulkId = await createSectionRecord(BULK_PROCESS_TIPOS.section, userId);
		const outcome = await saveComponentData({
			componentTipo: BULK_PROCESS_TIPOS.label,
			sectionTipo: BULK_PROCESS_TIPOS.section,
			sectionId: bulkId,
			lang: 'lg-nolan',
			changedData: [{ action: 'set_data', id: null, value: [{ value: label }] }],
			userId,
		});
		if (outcome.ok === false) {
			throw new DedaloError('record.save_failed', {
				message: `propagate: the dd800 run label was refused: ${outcome.message}`,
				coordinates: { section_tipo: BULK_PROCESS_TIPOS.section, tipo: BULK_PROCESS_TIPOS.label },
			});
		}
		return bulkId;
	});
}

/** What every record's write shares (resolved once per run). */
interface PropagateTarget {
	/** The tipo the save door is addressed at (an alias is resolved by the door). */
	componentTipo: string;
	/** The DATA tipo: the stored key (stored data never holds an alias tipo). */
	dataTipo: string;
	column: MatrixJsonbColumn;
	/** The component model (readComponentItems' column + coercion). */
	model: string;
	/** The request lang, handed to the save door verbatim. */
	lang: string;
	/** The lang the save path slices by (save_component.ts effectiveLang rule). */
	regionLang: string;
	/** isLangSlicedModel(model) — the SAVE PATH's answer, not the ontology flag. */
	sliced: boolean;
	action: PropagateAction;
	value: unknown;
	withRelations: boolean;
	userId: number;
	bulkProcessId: number;
	principal: Principal;
}

/**
 * ONE record's propagation, in ONE transaction (see the header). Returns
 * whether a write happened: `false` for a no-op (nothing written, no TM row)
 * and for a record deleted since the search (nothing to write onto — it is
 * never recreated). A refused save THROWS, so the record rolls back and the
 * loop reports it.
 */
async function propagateOneRecord(grant: RecordGrant, target: PropagateTarget): Promise<boolean> {
	const table = (await getMatrixTableFromTipo(grant.sectionTipo)) ?? 'matrix';
	return await withTransaction(async () => {
		const locked = await readMatrixKeyForUpdate(
			table,
			grant.sectionTipo,
			grant.sectionId,
			target.column,
			target.dataTipo,
		);
		if (locked === null) return false;
		// The stored key read the way every reader and the save path read it
		// (readComponentItems: a non-array value is the ONE item it is, null/''
		// holes dropped) — never `readMatrixKeyForUpdate`'s items, which answer
		// `[]` for a non-array value: 'add' then REPLACED a PHP-era single-object
		// value and 'delete'/'replace' decided over nothing.
		const record = await readMatrixRecord(table, grant.sectionTipo, grant.sectionId);
		// …and in the shape the save door accepts (value_shape.ts
		// canonicalStoredItems): a PHP-era numeric-string number is cast as PHP's
		// set_data did, so the untouched items re-sent with `final` are never
		// refused as malformed, and 'delete'/'add' compare like with like.
		const stored = canonicalStoredItems(
			target.column,
			record === null ? [] : (readComponentItems(record, target.dataTipo, target.model) ?? []),
		);
		const region = (regionOf(stored, target.regionLang, target.sliced) ?? []) as unknown[];
		const { final, changed } = applyPropagation(
			region,
			target.action,
			target.value,
			target.withRelations,
		);
		if (!changed) return false;
		const outcome = await saveComponentData({
			componentTipo: grant.componentTipo,
			sectionTipo: grant.sectionTipo,
			sectionId: grant.sectionId,
			lang: target.lang,
			changedData: [{ action: 'set_data', id: null, value: final }],
			userId: grant.userId,
			bulkProcessId: target.bulkProcessId,
			principal: target.principal,
		});
		if (outcome.ok === false) {
			throw new DedaloError('record.save_failed', {
				message: outcome.message,
				coordinates: {
					section_tipo: grant.sectionTipo,
					section_id: grant.sectionId,
					tipo: grant.componentTipo,
				},
			});
		}
		return true;
	});
}

/** The write door's name for this tool's grants and log lines. */
const PROPAGATE_DOOR = 'tool_propagate_component_data.propagate';

/**
 * The write door for ONE matched row (T2-S06): its grant, or the sentence the
 * run reports when the door REFUSES it (perm.* / a target that is not a record
 * address). Any other failure is no verdict on the row and propagates.
 */
async function authorizeRow(
	principal: Principal,
	row: { section_tipo: string; section_id: number },
	componentTipo: string,
): Promise<RecordGrant | string> {
	try {
		return await authorizeRecordAccess(
			principal,
			{ section_tipo: row.section_tipo, component_tipo: componentTipo, section_id: row.section_id },
			{ mode: 'write', level: 2, sectionFloor: 1, door: PROPAGATE_DOOR },
		);
	} catch (error) {
		if (!isDedaloError(error)) throw error;
		if (error.code === 'perm.out_of_scope') return 'out of the user scope';
		// the row's address failed the door's id grammar — not a scope verdict
		if (error.code.startsWith('request.invalid')) return `invalid record address (${error.code})`;
		if (error.code.startsWith('perm.')) {
			return `no write permission on ${row.section_tipo}/${componentTipo}`;
		}
		throw error;
	}
}

async function propagateComponentData(ctx: ToolActionContext): Promise<ToolResponse> {
	const { options, userId, principal } = ctx;
	const sectionTipo = String(options.section_tipo ?? '');
	const componentTipo = String(options.component_tipo ?? '');
	const action = String(options.action ?? '') as PropagateAction;
	const lang = String(options.lang ?? 'lg-nolan');
	const total = Number(options.total ?? -1);
	const sqoRaw = options.sqo;
	const propagateValue = options.propagate_data_value ?? null;

	if (sectionTipo === '' || componentTipo === '' || !VALID_ACTIONS.has(action) || sqoRaw == null) {
		throw invalidRequest(
			'Missing/invalid parameters: section_tipo, component_tipo, action(replace|delete|add), sqo',
		);
	}

	// A FIXED dataframe slot (dd560, the IRI label frame) is written only through
	// its MAIN, paired per record (id_key): a batch names no main, so its level
	// would be the slot's bare own 2 — refused loudly, nothing searched or
	// written (T0-4, write_door frameOf). Propagate the IRI itself instead.
	if (isFixedDataframeSlot(componentTipo)) {
		throw new DedaloError('request.invalid_source', {
			coordinates: { section_tipo: sectionTipo, tipo: componentTipo },
			message: `'${componentTipo}' is a fixed dataframe slot — written only through its main, never propagated`,
		});
	}

	// THE DECLARED TARGET, as a SECTION target of the write door (T2-S06): the
	// section floor 1, then the (section, component) pair at 2 — before the
	// search and the dd800 mint. PHP asked the pair alone.
	await authorizeSectionTarget(
		principal,
		{ section_tipo: sectionTipo, tipo: componentTipo },
		{ level: 2, door: PROPAGATE_DOOR },
	);

	const model = await getModelByTipo(componentTipo);
	if (model === null) {
		throw new DedaloError('request.invalid_tipo', {
			coordinates: { tipo: componentTipo },
			message: `unknown component tipo: ${componentTipo}`,
		});
	}
	// A DERIVED component (registry isDerivedModel) owns no stored value: the
	// region read below would be the leftover bytes under its tipo, never the
	// computed list, and for component_relation_children the set_data of
	// `region ± value` re-parents every real child missing from it. Refused
	// before the search and the dd800 mint — nothing is written (the CSV
	// import's twin rule, WC-2026-10-02-relation-children-write-through).
	if (isDerivedModel(model)) {
		throw invalidRequest(
			`'${model}' is derived (computed, nothing stored) — it cannot be propagated`,
		);
	}
	// The value law is the `monovalue` descriptor facet (registry isMonovalueModel)
	// — this tool used to carry its own copy of the PHP list (DATA-14).
	if (action === 'add' && isMonovalueModel(model)) {
		throw invalidRequest(`'add' is not allowed on mono-value model '${model}'`);
	}
	// The lang the save path slices by (resolver.ts effectiveSaveLang — ONE rule).
	const regionLang = await effectiveSaveLang(componentTipo, model, lang);
	const column = getColumnNameByModel(model);
	if (column === null) {
		throw new DedaloError('request.invalid_model', {
			coordinates: { model, tipo: componentTipo },
			message: `no matrix column for model '${model}'`,
		});
	}

	// Target set: the SQO search with NO limit (PHP forces limit/offset 0 = all).
	const sqo = sanitizeClientSqo(structuredClone(sqoRaw) as Record<string, unknown>);
	(sqo as { limit?: unknown; offset?: unknown }).limit = null;
	(sqo as { limit?: unknown; offset?: unknown }).offset = 0;
	const built = await buildSearchSql(sqo, { principal });
	const rows = (await runSearch(built)) as {
		section_tipo: string;
		section_id: number;
	}[];

	// Count-drift ceiling: a live result larger than the client total means the
	// SQO widened — abort rather than touch unexpected records (PHP :row_count>total).
	if (total >= 0 && rows.length > total) {
		// The selection GREW under the caller: a conflict, not a bad request — the
		// client re-counts and asks again.
		throw new DedaloError('resource.conflict', {
			coordinates: { section_tipo: sectionTipo, live: rows.length, expected: total },
			message: `count drift: ${rows.length} live > ${total} expected; aborting`,
		});
	}

	// The label the operator reads: the REQUEST's application lang (T2-OX7-1a) —
	// never the install DEDALO_APPLICATION_LANG (a job runs in its request's langs).
	const sectionLabel = await termByTipo(sectionTipo, currentApplicationLang());
	const bulkLabel = String(options.bulk_process_label ?? `Propagate ${action} to ${componentTipo}`);
	const bulkProcessId = await createBulkProcess(bulkLabel, userId);
	const target: PropagateTarget = {
		componentTipo,
		dataTipo: await resolveDataTipo(componentTipo),
		column: column as MatrixJsonbColumn,
		model,
		lang,
		regionLang,
		sliced: isLangSlicedModel(model),
		action,
		value: propagateValue,
		withRelations: COMPONENTS_WITH_RELATIONS.has(model),
		userId,
		bulkProcessId,
		principal,
	};

	// Live progress + cooperative cancellation. The copied client renders
	// data.msg | data.section_label | data.counter of data.total | id:
	// data.current.section_id (render_tool_propagate_component_data.js
	// compound_msg) and its Stop button posts dd_utils_api::stop_process, which
	// aborts the executor's per-job AbortSignal. Neither was wired: a batch over
	// tens of thousands of records showed no progress and could not be stopped.
	// Throttled — every publish rewrites the pfile mirror (PHP print_cli parity).
	const publish = ctx.publishProgress ?? ((): void => {});
	const PROGRESS_MS = 250;
	let lastPublish = 0;
	let stopped = false;
	publish({
		msg: `Processing ${action}: ${componentTipo}`,
		is_running: true,
		counter: 0,
		total: rows.length,
		section_label: sectionLabel,
	});

	const errors: string[] = [];
	let counter = 0;
	await withLiveBulkRun(bulkProcessId, async () => {
		for (const row of rows) {
			// Finish the current record, never abort mid-write (tool_update_cache
			// precedent). The partial run keeps its bulk_process_id, so whatever it
			// did write stays revertible through tool_time_machine.
			if (ctx.signal?.aborted === true) {
				stopped = true;
				break;
			}
			try {
				// THE WRITE DOOR PER ROW (TOOLS-01, T2-S06): the ROW's ACTUAL (section,
				// component, record) — NOT the client-declared pair checked once above.
				// The SQO rows can address a different section than section_tipo, incl.
				// a non-projects-gated one (dd128 users) that buildSearchSql does not
				// narrow: grammar (section_id < 1 — the root user — refused before the
				// admin bypass), section floor 1, the dd128-aware pair (a principal
				// holding level 2 on (dd128, dd1725) is refused on their OWN record, as
				// by the human save door — SEC-03), the write scope. The GRANT addresses
				// the write below.
				const grant = await authorizeRow(principal, row, componentTipo);
				if (typeof grant === 'string') {
					errors.push(`section_id ${row.section_id}: ${grant}`);
					continue;
				}
				counter += 1;
				const now = Date.now();
				if (counter === rows.length || now - lastPublish >= PROGRESS_MS) {
					lastPublish = now;
					publish({
						msg: `Processing ${action}: ${componentTipo}`,
						is_running: true,
						counter,
						total: rows.length,
						section_label: sectionLabel,
						current: { section_tipo: row.section_tipo, section_id: row.section_id },
					});
				}
				await propagateOneRecord(grant, target);
			} catch (error) {
				errors.push(`section_id ${row.section_id}: ${(error as Error).message}`);
			}
		}
	});

	// The batch NEVER fails as a whole: per-record failures are payload
	// (`errors`), and the human summary the client renders travels with them.
	return ok(
		{
			summary: `${stopped ? 'STOPPED.' : 'OK.'} ${action} data of '${componentTipo}' in section '${sectionLabel}' ${errors.length === 0 ? 'successfully' : 'done with warnings'}. ${counter} of ${rows.length} record(s) processed.`,
			errors,
			action,
			section_label: sectionLabel,
			total,
			counter,
			records: rows.length,
			stopped,
			bulk_process_id: bulkProcessId,
		},
		{ requestId: toolRequestId(ctx) },
	);
}

export const tool: ToolServerModule = {
	name: 'tool_propagate_component_data',
	apiActions: {
		propagate_component_data: {
			permission: null,
			gatedInHandler:
				'the write door, twice (T2-S06): authorizeSectionTarget(principal, {section_tipo, tipo: component_tipo}, level 2) refuses up front on the CLIENT-DECLARED target — the section floor 1, then the pair (the batch has no single record, so no declarative kind fits) — and the per-row loop asks authorizeRecordAccess (write, level 2, section floor 1, the dd128-aware pair, the write scope) on every row it actually reaches, whose grant addresses the write through saveComponentData (TOOLS-01, SEC-03; measured by the authorization matrix, test/unit/authz_door_matrix_native.test.ts).',
			handler: propagateComponentData,
		},
	},
	backgroundRunnable: ['propagate_component_data'],
	// A bulk write sweep — operator work (PERF-11 lane declaration).
	backgroundLanes: { propagate_component_data: 'maintenance' },
};
