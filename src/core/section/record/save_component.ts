/**
 * Component SAVE — the TS re-expression of dd_core_api::save (type
 * 'component') + component_common::update_data_value/save (write path,
 * spec §6 lifecycle).
 *
 * PHP references: class.dd_core_api.php save (:1304), component_common
 * update_data_value (:4088), save (:1990), tm_record::create (:264).
 *
 * Flow (mirrors PHP):
 *   1. permission gate: component permissions >= 2 (read/write) — enforced by
 *      the CALLER (dispatch) with the request principal;
 *   2. read the component's current item array from the matrix row;
 *   3. apply each changed_data item — actions handled here: update, insert,
 *      remove (which MUST name an item id — see unnamedRemoveRefusal), clear,
 *      set_data, sort_data, sort_by_column, add_new_element
 *      (id-matched replace with numeric-string id normalization, PHP COMP-02;
 *      translatable lang-slice + get_id_from_key id-sync, S1-01);
 *   4. write the FULL updated array back to the component's column (the PHP
 *      save writes whole-column state, not deltas);
 *   5. append the Time Machine audit row with the NEW data snapshot.
 *
 * The RELATION-specific write hooks (sort_data, sort_by_column,
 * add_new_element, relation_search index maintenance, delete_locator) live in
 * src/core/relations/save.ts — this module keeps the generic pipeline
 * (update/insert/remove/clear/set_data, TM audit) and calls into them.
 *
 * DATAFRAME saves (relations rebuild Phase C): when the component is a
 * component_dataframe slot and the request carries source.caller_dataframe,
 * changes apply to the CALLER's frame subset and the write is the
 * sibling-preserving merge (relations/dataframe.ts), with id_key stamping
 * and legacy-key stripping. Item-id counters absorb explicit ids on every
 * save (PHP set_data :1009-1019).
 *
 * POST-SAVE CASCADE (re-dated 2026-09-30, CLOSURE_PLAN Step 2): the observer
 * propagation (PHP propagate_to_observers) is an obligation of the WRITE
 * CHOKEPOINT (section_record/record_write.ts → obligation_ledger.ts), drained
 * after this save's COMMIT; the activity log runs at the DISPATCH door after
 * this save returns (api/dispatch.ts save handler). This module keeps the data
 * write + TM audit. The dataframe removal cascade (PHP
 * remove_dataframe_data_by_id on item remove) is covered here (S1-05,
 * relations/save.ts removeDataframeDataById). Coverage-state lists live in
 * rewrite/STATUS.md, never in this header.
 */

import { INSTALLED_DATA_LANGS } from '../../../config/config.ts';
import {
	getComponentModel,
	getImportAppendPolicy,
	getRenderClass,
	isLangSlicedModel,
	isMonovalueModel,
} from '../../components/registry.ts';
import { adoptStoredItemIds } from '../../concepts/item_value.ts';
import { isOtherLangItem } from '../../concepts/lang_region.ts';
import { dataframePairingOf } from '../../concepts/rqo.ts';
import { isConsultationOnlySection } from '../../concepts/section.ts';
import type { DataframePairing } from '../../concepts/subdatum.ts';
import { dbTimestamp } from '../../db/db_timestamp.ts';
import { MATRIX_JSONB_COLUMNS, type MatrixJsonbColumn } from '../../db/matrix.ts';
import { absorbComponentItemIds, allocateComponentItemId } from '../../db/matrix_write.ts';
import { deferPostTransaction, sql, withTransaction } from '../../db/postgres.ts';
import { DedaloError } from '../../errors/dedalo_error.ts';
import { ONTOLOGY_TLD } from '../../ontology/ontology_tipos.ts';
import {
	effectiveSaveLang,
	getColumnNameByModel,
	getMatrixTableFromTipo,
	getModelByTipo,
	getNode,
	getTranslatableByTipo,
} from '../../ontology/resolver.ts';
import { requiredOntologyTld } from '../../ontology/tld.ts';
import {
	applyDataframeDeletePolicy,
	dataframeDeletePolicyOf,
	dataframeTargetsOf,
} from '../../relations/dataframe.ts';
import {
	adoptStoredLocatorIds,
	applyAddNewElement,
	applySortByColumn,
	applySortData,
	type RelationInsertContext,
	removeDataframeDataById,
	type SortByColumnChange,
	type SortDataChange,
	validateRelationInsert,
} from '../../relations/save.ts';
import {
	persistAppendedKeyItems,
	persistRecordKeys,
	removedLocators,
	type WriteReceipt,
} from '../../section_record/index.ts';
import type { Principal } from '../../security/permissions.ts';
import type { AppendMergeResult, RelationAppendValidator } from './append_merge.ts';
import { beginSaveHistory, finishSaveHistory } from './bulk_capture.ts';
import { valueShapeRefusal } from './value_shape.ts';

/** One change from the client (PHP changed_data item). */
export interface ChangedDataItem {
	action: string;
	/**
	 * Target item id ('update', 'remove'); may arrive as a numeric string.
	 *
	 * A 'remove' MUST carry one (`unnamedRemoveRefusal` below): absent, it used
	 * to mean "empty the component in every language", which is now the separate
	 * `clear` action.
	 */
	id?: number | string | null;
	/** The new item value: {id, value, lang} for literals, a locator for relations. */
	value: unknown;
	/**
	 * The item's POSITION in the rendered array — a client render index, not an
	 * address the write engine resolves. Read by the lang-sliced 'insert' path
	 * only (getIdFromKey, the shared-id lookup across sibling languages); every
	 * other branch ignores it, which is why a 'remove' carrying a key and no id
	 * is refused rather than silently interpreted.
	 */
	key?: number | null;
}

export interface SaveRequest {
	componentTipo: string;
	sectionTipo: string;
	sectionId: number;
	lang: string;
	changedData: ChangedDataItem[];
	userId: number;
	/**
	 * Dataframe pairing context (PHP rqo source.caller_dataframe): required
	 * when componentTipo is a component_dataframe slot — the save then applies
	 * changes to the CALLER's frame subset only and merges siblings back
	 * (relations/dataframe.ts mergeCallerEntries).
	 */
	callerDataframe?: { main_component_tipo?: string; id_key?: number | string } | null;
	/**
	 * BULK import/propagation context (PHP component_common::set_bulk_process_id +
	 * tm_record::$save_tm — both are globals there, request state here).
	 *
	 * `bulkProcessId` makes this save part of the dd800 run's UNDO LOG
	 * (bulk_capture.ts, WC …-bulk-revert-undo-log): a hidden BEFORE image of the
	 * region it replaces plus its ordinary VISIBLE after-row, both carrying the
	 * run id, for every key it changes (nothing for a save that changes
	 * nothing); a record the save materializes gets the run's BIRTH marker, and
	 * a target its dataframe cascade wipes gets a role-4 snapshot. That is what
	 * makes a bulk run revertable EXACTLY, as one operation.
	 * `saveTm: false` suppresses the TM row entirely — OUTSIDE a bulk run only.
	 * Under a bulk id it is IGNORED (decision D1): an unrecorded bulk write is
	 * the one write its revert could not undo.
	 * Absent → normal interactive behavior: audited, unattributed.
	 */
	bulkProcessId?: number | null;
	saveTm?: boolean;
	/**
	 * Suppress this record's dd197/dd201 modified-audit stamp for THIS save (PHP
	 * section::$save_modified = false).
	 *
	 * The importer sets it when the CSV itself carries modified_by_user (dd197) /
	 * modified_date (dd201): stamping "now, by the importing user" would overwrite
	 * the very values being imported, one column later in the same row. Any caller
	 * that OWNS the modified metadata it is writing may use it; nobody else should
	 * — an unstamped interactive save is an unauditable one.
	 */
	skipModifiedStamp?: boolean;
	/**
	 * DECLARED ESCAPE for a LANGUAGE MIGRATION IN PROGRESS (DATA-01/DATA-25).
	 *
	 * A non-empty sentence here lets ONE save write a language this installation
	 * does not declare, and is logged with the lang and the component. It exists
	 * because the membership gate below is otherwise unconditional, and a
	 * migration that MOVES data between language codes (a rename, a retired
	 * language being emptied out) must be able to write the code it is moving
	 * off — the very code the install has already stopped declaring.
	 *
	 * NOT A WIRE FIELD: no rqo, no MCP schema and no tool option carries it, so
	 * no remote caller and no agent can reach it. Only an in-repo, server-side
	 * caller that OWNS the migration may set it, and it must say why — the
	 * `reason`-field form of a named exemption (AGENTS.md "never silently narrow
	 * scope"). The other, non-urgent escape is configuration: a language an
	 * install is ADDING belongs in DEDALO_PROJECTS_DEFAULT_LANGS, which is what
	 * the gate reads.
	 */
	langMigrationReason?: string;
	/**
	 * The REQUEST PRINCIPAL, threaded explicitly for the relation-insert
	 * read-grant gate (`relations/save.ts` gate 2). Dispatch and the MCP write
	 * tools hold one and pass it; the door falls back to the request-context ALS
	 * ONLY as the documented backstop for the leaf callers that reach here
	 * without a principal in hand — import_execute / import_csv_execute (dd800
	 * runs under mediaJobs, ALS present), transcription_asr, password_reset,
	 * section_permissions, area_maintenance export_hierarchy, ontology data_io,
	 * component_text_area tag_delete, media companion_writes. Inside gate 2's
	 * scope (a tree-picker caller) an absent actor REFUSES; a write-validation
	 * path never answers "allowed" because it could not see who was asking.
	 */
	principal?: Principal;
	/**
	 * CSV-import APPEND (plan §4): the one `set_data` change is MERGED onto the
	 * stored items instead of replacing them — per the model's `importAppend`
	 * descriptor policy (components/types.ts), in `append_merge.ts`, under this
	 * save's `FOR UPDATE` lock and after the value gates. Stored items are kept
	 * byte-for-byte (never replayed through the set_data re-validation);
	 * relations run the insert law with `existingItems = stored + accepted`.
	 * A `refuse` policy, or any change list other than exactly one `set_data`,
	 * throws `request.invalid_data` before the transaction opens.
	 *
	 * NOT A WIRE FIELD: no rqo, no MCP schema and no tool option carries it —
	 * every door builds its SaveRequest field by field (dd_core_api save never
	 * spreads the wire payload), so no remote caller can reach it. Only the
	 * CSV import executor and tool_import_rdf's executor set it — the census is
	 * a scan in test/unit/save_append_import_native.test.ts (the gate).
	 */
	appendImport?: true | AppendImportOptions;
}

/** The object form of `SaveRequest.appendImport`. */
export interface AppendImportOptions {
	/**
	 * Item ids the executor PRE-ALLOCATED, by incoming position, so the
	 * translations of one row share one item id across lang saves. Every other
	 * incoming id is stripped (a file id is never a stored id).
	 */
	preallocatedIds?: readonly (number | undefined)[];
}

export interface SaveResult {
	ok: boolean;
	message: string;
	/** The component's full item array after the save. */
	data?: unknown[];
	/**
	 * Recomputed observer data items whose target IS the saved record (PHP
	 * observers_data) — filled post-commit by the chokepoint's observer ledger
	 * (the receipt); EMPTY when a caller's transaction defers the drain past
	 * this save's return. The dispatch save handler merges them into the
	 * response so the client refreshes info widgets in place.
	 */
	observersData?: unknown[];
	/**
	 * INTERNAL, never on the wire: the relation locators present BEFORE this
	 * save and absent after it (the ONE rule, obligation_ledger.ts
	 * removedLocators). The observer cascade computes its own from the
	 * chokepoint's before-image; this is for the callers that report it. Absent
	 * when the save removed nothing, and for every literal (non-relation) component.
	 */
	removedItems?: unknown[];
	/**
	 * The section_id `add_new_element` created in the TARGET section (WC-081).
	 * Absent on every other action — a save that creates nothing says nothing.
	 * The API door forwards it so the client can open the record it just made
	 * by ADDRESS instead of guessing it from the echoed page.
	 */
	created_section_id?: number;
	/**
	 * INTERNAL, never on the wire (appendImport saves only): incoming FILE item
	 * id (String()-keyed) → the final stored id — the new item's allocated id,
	 * or the existing item's id for a skipped duplicate. The CSV executor
	 * re-pairs dataframe frames (`id_key`) through it.
	 */
	appendedIdMap?: Map<string, unknown>;
	/** INTERNAL, never on the wire: incoming entries skipped as already present. */
	appendSkipped?: number;
}

/**
 * A write was addressed to a component whose value is DERIVED from a
 * third-party service (WC-2026-08-06-external-write-refusal).
 *
 * SEPARATE CLASS, and a THROW rather than an `ok:false`: the consultation-only
 * guard above answers "this record is read-only for everyone", which the client
 * shows as a message; this answers "there is no place on disk where these bytes
 * could go", which is a contract violation by the caller and must reach the
 * operator's log with the tipo that caused it.
 */
export class ExternalWriteRefused extends DedaloError {
	readonly componentTipo: string;
	readonly sectionTipo: string;
	readonly model: string;

	constructor(fields: { componentTipo: string; sectionTipo: string; model: string; door: string }) {
		// Thin DedaloError family (ERRORS_SPEC §2.1): the fixed code
		// `record.external_write_refused` (caller, 400) is the wire identity; the
		// sentence below stays the LOG message; the tipos ride as coordinates.
		super('record.external_write_refused', {
			message: `${fields.door}: write refused to '${fields.componentTipo}' (${fields.model}) in section '${fields.sectionTipo}' — its value is DERIVED from a third-party service at read time, so the local record has no slot for it and the remote service is never written to`,
			coordinates: {
				tipo: fields.componentTipo,
				section_tipo: fields.sectionTipo,
				model: fields.model,
				door: fields.door,
			},
		});
		this.name = 'ExternalWriteRefused';
		this.componentTipo = fields.componentTipo;
		this.sectionTipo = fields.sectionTipo;
		this.model = fields.model;
	}
}

/**
 * THE WRITE REFUSAL for derived-from-remote components (2026-08-06).
 *
 * The predicate is the descriptor facet `emitHook: 'external'`, not a model
 * name list: a model whose emission is fully owned by the external hook derives
 * its value from a service at read time, and that IS the property that makes it
 * unwritable. A future second derived model is covered the day it declares the
 * hook, with no edit here.
 *
 * DELIBERATE DIVERGENCE FROM v6, ledgered in the WC entry: PHP's
 * `component_external` carried an explicit `# Tool Time machine case` branch
 * that called `parent::set_dato()`, so a TM restore DID write a snapshot of the
 * remote answer into the matrix column. The census that licenses removing it:
 * `matrix_time_machine` holds ZERO rows for any `component_external` tipo, and
 * the one external section (`zenon1`) has zero matrix rows in any table — there
 * is nothing to restore, and restoring would fossilize a stale remote answer
 * into a column the read path never consults.
 */
async function assertNotExternalWrite(componentTipo: string, sectionTipo: string): Promise<void> {
	const model = await getModelByTipo(componentTipo);
	if (model === null) return; // the unknown-tipo answer belongs to the save body
	if (getComponentModel(model)?.emitHook !== 'external') return;
	throw new ExternalWriteRefused({
		componentTipo,
		sectionTipo,
		model,
		door: 'saveComponentData',
	});
}

/**
 * THE LANGUAGES THIS INSTALLATION DECLARES FOR RECORD DATA (DATA-25).
 *
 * THE SET ITSELF LIVES IN `src/config/data_langs.ts` and is built in
 * `src/config/config.ts` (`INSTALLED_DATA_LANGS`), next to the keys it derives
 * from. What matters here is the property the chokepoint below leans on: it is
 * the READ-REACHABLE set — exactly the codes the read fallback chain
 * (`resolve/component_data.ts`) can resolve, namely
 * `DEDALO_PROJECTS_DEFAULT_LANGS` ∪ {`DEDALO_DATA_LANG_DEFAULT`} ∪ {`lg-nolan`}
 * ∪ the equivalence closure of those. A slice written under any other code is a
 * slice no read ever reaches through a language the install offers — ok:true,
 * and the bytes are gone.
 *
 * `DEDALO_DATA_LANG` IS NOT A MEMBER, and that is deliberate (2026-08-27): it is
 * the menu's current data language, not a read-chain candidate. Seeding it here
 * to keep the engine's own default write working bought a write language no read
 * reaches — the same silent loss through the other door. The outage it was
 * seeded against is closed where it belongs instead: `config.menu.dataLang` is
 * resolved AGAINST this set at boot (`resolveCurrentDataLang`), and
 * `currentDataLang()` falls back to `DEDALO_DATA_LANG_DEFAULT` outside any
 * request scope. So every language the engine can choose on its own behalf is
 * already a member, and no write of its own is ever refused.
 *
 * The set is a constant of the PROCESS (`config` is boot-frozen), never request
 * state. It is NOT the per-request write language — that is `currentDataLang()`,
 * threaded by each door; this only answers "does the install know this code at
 * all". The two accessors below are that question and its answer, kept here
 * because the refusal message is the one place an operator is shown the set.
 */

/** Does this installation declare `lang` as a data language? (see INSTALLED_DATA_LANGS) */
export function isInstalledDataLang(lang: string): boolean {
	return INSTALLED_DATA_LANGS.has(lang);
}

/** The declared data languages, for a caller that must SHOW the operator the set. */
export function installedDataLangs(): readonly string[] {
	return [...INSTALLED_DATA_LANGS];
}

/**
 * Does the STORED component ALREADY carry an item in `request.lang`?
 *
 * THE DISTINCTION THE LAW TURNS ON (P0-7 review). The membership rule governs an
 * OPERATOR-CHOSEN write language — the language a save DECLARES its bytes to be
 * in. Several doors choose nothing: they forward the lang of a slice they just
 * READ, in order to write it back. `tool_update_cache`'s regenerate re-saves
 * each stored lang group; `component_text_area`'s tag_delete removes a tag from
 * the exact stored slice it was found in; `tool_tc` rewrites the time codes of
 * the component being edited. For those, a membership refusal refuses a re-save
 * of bytes ALREADY IN THE CORPUS — ordinary maintenance of a record whose
 * language the install has since stopped declaring, broken by the guard.
 *
 * So the ROUND TRIP is let through, and it is VERIFIED rather than declared: the
 * engine reads the slice its own write is about to land on and admits the
 * language only because the stored bytes already carry it. No caller can claim
 * it.
 *
 * WHAT THE ALLOWANCE ACTUALLY IS, stated plainly because an earlier version of
 * this comment overstated it: it is PER LANG SLICE, not per bytes. The question
 * asked is "does this component of this record already hold an item in this
 * language" — nothing compares the incoming values with the stored ones. Once a
 * slice exists in an undeclared language, ARBITRARY NEW CONTENT may be written
 * into THAT slice of THAT component: a `set_data` replacing it wholesale is
 * admitted, and so is content the record never held. What the allowance can
 * never do is CREATE a slice in a language the component does not already carry
 * — no new unreachable language appears, on this component or any other (the
 * question is asked per component tipo, not per record), which is the property
 * the law protects.
 *
 * Runs on the undeclared path ONLY: one unlocked read, asking a question about
 * stored state rather than writing. Under an ambient caller transaction it runs
 * on that connection and therefore sees the caller's uncommitted rows — correct
 * for the question, since those bytes are the ones the write will land on.
 */
async function storedSliceCarriesLang(request: SaveRequest): Promise<boolean> {
	// The search_* preset door addresses no row (section_id → NaN there).
	if (!Number.isFinite(Number(request.sectionId))) return false;
	const model = await getModelByTipo(request.componentTipo);
	if (model === null) return false;
	const column = getColumnNameByModel(model);
	if (column === null || !MATRIX_JSONB_COLUMNS.includes(column as MatrixJsonbColumn)) return false;
	const table = await getMatrixTableFromTipo(request.sectionTipo);
	if (table === null) return false;
	// The writer's own idiom (the FOR UPDATE read in applySaveComponentData),
	// minus the lock. The tipo rides as a BOUND parameter — cast to text so the
	// `->` operator resolves (jsonb->text vs jsonb->int is otherwise ambiguous).
	const rows = (await sql.unsafe(
		`SELECT "${column}"->($3::text) AS items FROM "${table}"
		 WHERE section_tipo = $1 AND section_id = $2`,
		[request.sectionTipo, request.sectionId, request.componentTipo],
	)) as { items: unknown }[];
	const items = rows[0]?.items;
	if (!Array.isArray(items)) return false;
	return items.some(
		(item) =>
			item !== null &&
			typeof item === 'object' &&
			(item as { lang?: unknown }).lang === request.lang,
	);
}

/**
 * THE LAW OF THIS DOOR: a write through `saveComponentData` may only name a
 * language this installation declares, or one the stored slice it is re-saving
 * already carries (DATA-01/DATA-23/DATA-24/DATA-25 — P0-7).
 *
 * ITS REAL SCOPE, because "THE ONE LAW" (an earlier version of this line) was
 * not true: it governs this chokepoint, which is every SAVE door — the client
 * API, the MCP tools, the agent change-plan, every import — and nothing else.
 * The two Time Machine write doors (`tool_time_machine` `apply_value` and
 * `bulk_revert_process`) deliberately bypass this function and write matrix data
 * directly (`restore_common.ts`: only the direct path can thread a bulk id and
 * replay a snapshot without the save pipeline's defaults firing), so a restore
 * can still land ANY language the audit row holds — including one this install
 * has stopped declaring. That is coherent with the round-trip allowance below
 * (a restore re-writes bytes the corpus already held) and it is NOT gated here;
 * naming it is the difference between a scope and a claim.
 *
 * A THROW, not an `ok:false` (contrast `ontologyTldRefusal`): every bulk door
 * folds an `ok:false` into a per-field "IGNORED" line and keeps going, which
 * would turn a whole run in a phantom language into a report nobody reads. The
 * caller's lang is stamped verbatim onto every stored item, so a wrong one is a
 * contract violation that must stop the write and reach the operator's log with
 * the code that caused it. Note what this costs the caller: it is the ONE save
 * refusal that throws where the others return `ok:false`.
 *
 * THREE WAYS THROUGH, in cost order: the declared set (one Set lookup on
 * boot-frozen config — the path every ordinary write takes), the verified round
 * trip (one unlocked read, see above), and the caller's declared migration
 * escape.
 *
 * WHERE THEY RUN, exactly: before THIS function opens its transaction. On the
 * interactive path that means no transaction exists at all — nothing to roll
 * back, no row to lock, and the refusal is observable while another connection
 * still holds the record's lock, which is how the gate tells a pre-flight
 * refusal from a rollback. A caller that ALREADY holds a transaction (the
 * per-record wrap in `import_execute`, the per-row wrap in
 * `import_csv_execute`) is a different story: `withTransaction` joins an ambient
 * transaction, so the checks run inside the caller's, and a refusal rolls back
 * whatever that record's transaction had written so far. That is the intended
 * behavior for a row-scoped import transaction — but it is not "before the
 * transaction opens", and the pre-flight gate measures the interactive path.
 */
async function assertInstalledWriteLang(request: SaveRequest): Promise<void> {
	if (INSTALLED_DATA_LANGS.has(request.lang)) return;
	// Bytes already in the corpus, being written back — not an operator's choice.
	if (await storedSliceCarriesLang(request)) return;
	const reason = (request.langMigrationReason ?? '').trim();
	if (reason !== '') {
		// The escape is LOUD by design: an undeclared language reaching storage is
		// an event, even when it was asked for.
		console.warn(
			`[save_component] language migration escape: writing undeclared lang '${request.lang}' ` +
				`to ${request.sectionTipo}/${request.sectionId} ${request.componentTipo} — ${reason}`,
		);
		return;
	}
	throw new DedaloError('record.lang_not_installed', {
		message:
			`save refused: lang '${request.lang}' is not one this installation declares ` +
			`(${installedDataLangs().join(', ')})`,
		details: { lang: request.lang },
		coordinates: {
			section_tipo: request.sectionTipo,
			section_id: request.sectionId,
			tipo: request.componentTipo,
			lang: request.lang,
		},
	});
}

/**
 * THE ONT-TLD WRITE REFUSAL (`ontology7`).
 *
 * A record of an ontology node section `<tld>0` parses into node tipo
 * `<tld><section_id>`, so its `ontology7` can only ever be `<tld>`. The value is
 * DERIVED from the section, never typed. Two ways a write can break that, both
 * of which lose the record:
 *   - a DIFFERENT tld — the record parses into another namespace entirely
 *     (ontology_state's `foreign` drift);
 *   - an EMPTY value — parseSectionRecordToOntologyNode returns null, no
 *     dd_ontology row is written, and the record vanishes from the ontology
 *     tree with no error anywhere.
 *
 * `ok:false`, not a throw (contrast ExternalWriteRefused above): a caller that
 * sends the wrong tld — an import file, an API client, a bulk edit — has made a
 * fixable data mistake and deserves an actionable 400 naming the right value,
 * not a 500. The edit form additionally renders the component read-only
 * (permissions.ts forces level 1), so the interactive door can barely reach
 * here; this is the belt for every other door.
 *
 * ALLOWLIST, NOT A BLOCKLIST — and the reason is a bug this guard shipped with.
 * The first version inspected the incoming value and refused what LOOKED wrong,
 * wrapping a non-array `set_data` value into `[value]` before checking it. The
 * executor does the opposite: `set_data` coerces a non-array to `[]`
 * (applySaveComponentData below). So `{action:'set_data', value:{…value:'actv'}}`
 * — a bare object carrying the CORRECT tld — passed the guard and then CLEARED
 * the component, losing the record in exactly the way ONT-TLD exists to prevent.
 * A guard that models the write differently from the writer is not a guard.
 *
 * So: permit ONE shape, the only one whose result is verifiable without
 * re-implementing the executor — a `set_data` carrying a non-empty ARRAY whose
 * every item's value is the required tld. Refuse everything else by shape,
 * naming the shape rather than a value that may never be stored. Fail-closed
 * costs nothing here: the field is derived, so no door has a legitimate reason
 * to send anything else, and every import door already sends exactly this shape
 * (import_execute.ts, import_csv_execute.ts).
 *
 * Returns the refusal message, or null when the write is allowed. Pure — the
 * answer depends only on the section tipo and the incoming values, which is why
 * the caller runs it BEFORE opening the transaction.
 */
export function ontologyTldRefusal(request: SaveRequest): string | null {
	if (request.componentTipo !== ONTOLOGY_TLD) return null;
	const required = requiredOntologyTld(request.sectionTipo);
	if (required === null) return null; // not a governed section (localontology0, ontology35, …)

	const refuse = (received: string): string =>
		`${ONTOLOGY_TLD} must be "${required}" in section '${request.sectionTipo}' — it is derived from the section, not typed (ONT-TLD); received ${received}`;

	for (const change of request.changedData) {
		// Only a whole-value replace can be checked against a derived value: an
		// update/insert/remove is a delta against stored items this function
		// deliberately does not read (it runs before the row is locked).
		if (change.action !== 'set_data') {
			return refuse(`action '${String(change.action)}' (only a full set_data replace is allowed)`);
		}
		// THE SHAPE, before the value: a non-array reaches the executor as `[]`.
		if (!Array.isArray(change.value)) {
			return refuse(
				change.value === null || change.value === undefined
					? 'an empty value'
					: 'a non-array set_data value (the write engine stores that as an empty component)',
			);
		}
		const items = change.value as unknown[];
		// A bulk replace with nothing in it clears the component just as surely.
		if (items.length === 0) return refuse('an empty value');
		for (const item of items) {
			// A stored literal item is an OBJECT carrying `value`. A bare scalar is
			// not the stored shape, so it is refused as a shape too.
			if (item === null || typeof item !== 'object') {
				return refuse('a non-object item (a stored literal is {id, lang, value})');
			}
			const raw = (item as { value?: unknown }).value;
			const value = raw === null || raw === undefined ? '' : String(raw);
			if (value !== required) {
				return refuse(value === '' ? 'an empty value' : `"${value}"`);
			}
		}
	}
	return null;
}

/**
 * THE REMOVE SENTINEL (DATA-06, 2026-08-30 — closes the P0-8 audit row).
 *
 * A `remove` that names no item id used to CLEAR THE COMPONENT IN EVERY
 * LANGUAGE and answer ok:true. One branch below it, a remove naming an id that
 * is not stored fails the whole save. That asymmetry was the defect: naming the
 * wrong item was refused, naming NO item destroyed everything and reported
 * success. The null id is not a caller saying "all" — it is every caller's
 * UNKNOWN-ID SENTINEL. What it cost, in the tree AS FOUND on 2026-08-30 (the
 * client sites are being ported to `clear` in the same audit batch):
 *   - `component_number` render_edit remove_handler passes `current_value?.id`,
 *     and its own renderer writes `id: item.id || null`, so an unsaved slot
 *     (and a stored id of 0) sent id:null — one row's delete button, and every
 *     number in the component was gone;
 *   - `component_input_text` / `component_email` `_do_remove` sent
 *     `{id, key}` with a null id for an unsaved row — a KEY, which addresses a
 *     position and which no branch of this engine resolves;
 *   - `component_filter_records` build_changed_data_item left `entry_id`
 *     null whenever the tipo was not in the entries it was handed — clearing one
 *     section's record filter dropped the user's filters for ALL sections,
 *     which WIDENS what that account can read;
 *   - the MCP door (`dedalo_save_component`) took an OPTIONAL `item_id` that
 *     mapped straight onto id:null, so an agent asked to "remove the English
 *     title" wiped every other language and was told it succeeded.
 *
 * So: a remove NAMES the item it removes, and emptying the component is the
 * separate, explicit `clear` action (applySaveComponentData below). Refused
 * before the transaction opens — the answer depends only on the incoming
 * changes, so there is nothing to roll back and no row to lock.
 *
 * Divergence from the PHP oracle, deliberately:
 * `engineering/wire_contract/WC-2026-08-30-remove-requires-item-id.md`.
 *
 * Returns the refusal message, or null when every remove names an id. Pure —
 * shared with the TEMPORAL door (./temporal.ts), which must refuse the same
 * shape or an in-memory instance would answer where the persisted one refuses.
 */
/**
 * THE THREE SPELLINGS OF "NO ID": null, undefined, and the empty string.
 * `JSON.stringify` DROPS an undefined id, and the client's `item.id || null` idiom
 * turns '' into null too — they all arrive here meaning "no id", and each one meant
 * one row somebody tried to delete.
 *
 * A VALUE test, never a falsiness test: `0` and `'0'` are real, deletable ids, and
 * eating them would turn this refusal into its own kind of data loss. The client
 * mirrors this exact set in `is_unresolved_id` (component_common.js); the two are
 * bonded by test/unit/remove_sentinel_native.test.ts.
 */
function namesNoItem(id: number | string | null | undefined): boolean {
	return id === null || id === undefined || id === '';
}

/**
 * A `key` names a POSITION in the rendered array, not an item — so a remove that
 * named one is the near-miss worth calling out, rather than letting the caller go
 * on believing a key is an address.
 */
function positionalNote(key: number | string | null | undefined): string {
	if (key === null || key === undefined) return '';
	return ` (this change named key ${key}, which addresses a POSITION in the rendered array, not an item)`;
}

export function unnamedRemoveRefusal(changedData: readonly ChangedDataItem[]): string | null {
	const unnamed = changedData.find(
		(change) => change.action === 'remove' && namesNoItem(change.id),
	);
	if (unnamed === undefined) return null;
	return (
		"a 'remove' must name the item id it removes" +
		`${positionalNote(unnamed.key)}; to empty the component in every language send {action:'clear'} instead`
	);
}

/**
 * The lang-slice gate lives with the component-model facets
 * (components/registry.ts `isLangSlicedModel`); re-exported here for the
 * temporal door and the tools that import it from the save path.
 */
export { isLangSlicedModel };

/*
 * MONOVALUE models — data is an array but only element 0 is ever read (PHP
 * component_common::$components_monovalue). THE law is the `monovalue`
 * descriptor facet, read through registry.ts isMonovalueModel (imported
 * above); this file used to carry a verbatim copy of the PHP list, and the
 * propagate tool a second one (DATA-14). PHP consults the registry on the
 * INSERT branch ("For monovalue components, replace the existing value instead
 * of appending", :4128-4131) — mirrored in the insert branch below; the
 * UPDATE branch (applyUpdate `monovalue`) is the deliberate TS extension
 * (WC-2026-08-08) that closes PHP's append-and-warn fallback (:4209-4213).
 */

/** COMP-02: numeric-string ids normalize to int, else strict matching
 * appends duplicates instead of updating. */
export function normalizeItemId(id: unknown): unknown {
	return typeof id === 'string' && /^\d+$/.test(id) ? Number.parseInt(id, 10) : id;
}

/**
 * PHP component_common::get_id_from_key (:1432-1486) — resolve the SHARED item
 * id for an array position from the sibling languages. Groups the full stored
 * array by lang (skipping `skipLangs`, i.e. the language being written), takes
 * the entry at position `key` in each group, and returns the first valid
 * positive numeric id found. Null when nothing resolves (a fresh id is minted).
 */
export function getIdFromKey(
	items: unknown[],
	key: number,
	skipLangs: readonly string[],
): number | null {
	const grouped = new Map<string, { id?: unknown }[]>();
	for (const item of items) {
		if (item === null || typeof item !== 'object') continue;
		const itemLang = (item as { lang?: string }).lang ?? null;
		if (itemLang === null || skipLangs.includes(itemLang)) continue;
		const group = grouped.get(itemLang);
		if (group === undefined) {
			grouped.set(itemLang, [item as { id?: unknown }]);
		} else {
			group.push(item as { id?: unknown });
		}
	}
	for (const entries of grouped.values()) {
		const candidate = entries[key];
		if (candidate === undefined) continue;
		const id = candidate.id ?? null;
		const numeric = typeof id === 'number' ? id : typeof id === 'string' ? Number(id) : Number.NaN;
		if (Number.isFinite(numeric) && Math.trunc(numeric) > 0) {
			return Math.trunc(numeric);
		}
	}
	return null;
}

/**
 * Apply one 'update' change to the item array (PHP update_data_value 'update',
 * class.component_common.php:4152-4223): replace the FIRST item whose id
 * matches (PHP breaks after the first hit — translated items share ids by
 * design, so replacing every match destroys the sibling languages);
 * id-less/no-match appends (PHP fallback) — EXCEPT for a populated monovalue
 * model, which replaces (the `monovalue` descriptor facet, isMonovalueModel).
 *
 * `sliceLang` non-null = the PHP lang-slice semantics for translation-
 * supporting literal components (supports_translation && !is_relation):
 * the change applies to the CURRENT-LANG slice only, an id-less change with a
 * `key` resolves the shared id from the sibling languages (get_id_from_key),
 * and the write merges [other-lang items..., new slice...] — set_data_lang's
 * persisted shape (:1052-1128), with the slice lang re-stamped on a CLONE of
 * every slice item, so the same object reference is never stored at two array
 * positions.
 */
/**
 * THE REMOVE TARGET, normalized — or a refusal.
 *
 * Extracted from `applySaveComponentData` (2026-08-30) both to keep that function
 * under the complexity ratchet and because the id grammar deserves ONE home: a
 * numeric string is the same id as its number (`'3'` and `3` name one item), and
 * the three no-id spellings are refused together.
 *
 * The throw is UNREACHABLE through `saveComponentData`, which refuses the shape in
 * `unnamedRemoveRefusal` before the transaction opens. It is kept as the applier's
 * own last line of defence: the one thing that must never happen again is an
 * id-less remove EMPTYING the component and answering ok (DATA-06). A deliberate
 * wipe is `action: 'clear'`.
 */
function resolveRemoveTargetId(
	change: { id?: number | string | null },
	coordinates: { tipo: string; section_tipo: string; section_id: number },
): number | string {
	const raw = change.id ?? null;
	const targetId = typeof raw === 'string' && /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : raw;
	if (targetId === null || targetId === '') {
		throw new DedaloError('record.remove_without_id', {
			message: "saveComponentData: a 'remove' must name the item id it removes",
			publicMessage: "a 'remove' must name the item id it removes",
			coordinates,
		});
	}
	return targetId;
}

/**
 * Every item EXCEPT the one the id names. Translated items share ids, so this is
 * the PHP cross-language removal for translatable literals: one id, every language.
 * Numeric-string ids are compared as numbers, matching `resolveRemoveTargetId`.
 */
/** One `remove` the change loop applied — its dataframe consequence runs AFTER the batch. */
interface AppliedRemove {
	targetId: number | string;
	/** The entries the remove dropped (a slot's frame entries; ignored for a main). */
	removedEntries: unknown[];
}

/**
 * THE DATAFRAME CONSEQUENCE OF THE BATCH'S REMOVES — run ONLY after every
 * change of the batch applied and the component was written. Until 2026-09-21
 * each remove cascaded inside the change loop, and a LATER change of the same
 * batch answering `ok:false` (an unknown id, a malformed sort, a set_data that
 * rebinds the items) left that cascade committed — the DEC-01 posture commits
 * a non-throwing result — so a save the curator saw REFUSED had stripped a
 * slot and queued a frame target's deletion. Deferred here, a refused batch
 * has run no cascade at all.
 *
 * - Any MAIN: the cascade (PHP update_data_value 'remove' :4325-4352, S1-05):
 *   the removed item's paired frame entries are stripped from every dataframe
 *   slot the main declares (remove_dataframe_data_by_id), each slot applying
 *   its own delete policy. For translatable-literal mains PHP guards on the
 *   removed id no longer existing in any OTHER language (frames are
 *   lang-agnostic); the TS remove strips ALL languages at once, so the
 *   unconditional cascade is exactly that occurrences<=1 case.
 * - A `component_dataframe` SLOT — DIRECT FRAME REMOVAL (the dataframe modal's
 *   Delete button → unlink_record → `remove` on the slot itself): the cascade
 *   is not this door (a slot declares no slots); the slot's own policy is
 *   resolved first and, unless it is `unlink`, applied to the targets the
 *   dropped entries addressed (WC-2026-09-06-dataframe-delete-policy-on-slot).
 *   The applier queues the deletes on the COMMIT lane of this save's
 *   transaction: they run only after the unlink is committed (never before —
 *   a target is not deleted while a locator still points at it), each in its
 *   own transaction; a refused delete is logged and leaves a survivable
 *   orphan, never a dangling locator.
 */
async function cascadeAppliedRemoves(input: {
	model: string;
	table: string;
	sectionTipo: string;
	sectionId: number;
	componentTipo: string;
	userId: number;
	removes: readonly AppliedRemove[];
	/** The save's bulk id — null outside a bulk run (the cascade's deletes carry it). */
	bulkId: number | null;
}): Promise<void> {
	if (input.removes.length === 0) return;
	if (input.model === 'component_dataframe') {
		const policy = dataframeDeletePolicyOf((await getNode(input.componentTipo))?.properties);
		if (policy === 'unlink') return;
		const entries = input.removes.flatMap((remove) => remove.removedEntries);
		// Under a bulk id the cascade's wipes carry the run's id: each emptied
		// target gets its role-4 snapshot, so the run's revert can restore it.
		await applyDataframeDeletePolicy(
			policy,
			dataframeTargetsOf(entries),
			input.userId,
			input.bulkId,
		);
		return;
	}
	// The slots the per-item strip rewrites write no history of their own: the
	// main's COMPOSED row / pair (bulk_capture.ts) records them, read after this.
	for (const remove of input.removes) {
		await removeDataframeDataById(
			input.table,
			input.sectionTipo,
			input.sectionId,
			input.componentTipo,
			Number(remove.targetId),
			input.userId,
			input.bulkId,
		);
	}
}

/**
 * The pre-save snapshot the removed-set diff (result.removedItems) compares against: the
 * full slot for a relation column (a shallow copy suffices — every mutation
 * path REBINDS `items`), nothing for a literal (no locators to remove).
 */
function observerDiffSnapshot(column: string, items: unknown[]): unknown[] {
	return column === 'relation' ? [...items] : [];
}

function withoutItemId(items: unknown[], targetId: number | string): unknown[] {
	return items.filter((item) => {
		const itemId = (item as { id?: number | string } | null)?.id;
		const normalized =
			typeof itemId === 'string' && /^\d+$/.test(itemId) ? Number.parseInt(itemId, 10) : itemId;
		return normalized !== targetId;
	});
}

export function applyUpdate(
	items: unknown[],
	change: ChangedDataItem,
	sliceLang: string | null,
	monovalue = false,
): unknown[] {
	let targetId: unknown = normalizeItemId(change.id ?? null);

	// PHP :4190-4193 (see also :4176-4178): the replacement value inherits the
	// matched/resolved id when it arrives without one. The client toggle sends
	// the bare datalist value (no id); dropping the id here would leave an
	// id-less item, so the NEXT update sends id:null and appends instead of
	// replacing — the array grows on every save (the component_publication
	// value-doubling bug).
	const inheritId = (id: unknown): void => {
		const value = change.value;
		if (
			value !== null &&
			typeof value === 'object' &&
			((value as { id?: unknown }).id === undefined ||
				(value as { id?: unknown }).id === null ||
				(value as { id?: unknown }).id === '')
		) {
			(value as { id?: unknown }).id = id;
		}
	};

	if (sliceLang === null) {
		// Non-sliced (relations & non-translatable classes): positional replace
		// on the full array, first-match stop.
		if (targetId === null) {
			// MONOVALUE law (DELIBERATE PHP DIVERGENCE, WC-2026-08-08; the law is
			// the `monovalue` descriptor facet, isMonovalueModel):
			// only element 0 is ever read, so an id-less update of an
			// already-populated single-value component REPLACES it. PHP appends
			// and warns instead, which grows the array on every save: the map
			// reloads at the stale first position and the record publishes two
			// points. Narrow by construction — exactly one stored object item, so
			// it cannot touch a multi-value model, an empty array (the first save
			// must still create the item), or dirty legacy data.
			if (monovalue && items.length === 1 && items[0] !== null && typeof items[0] === 'object') {
				inheritId((items[0] as { id?: unknown }).id ?? null);
				return [change.value];
			}
			return [...items, change.value];
		}
		const updated = [...items];
		for (let index = 0; index < updated.length; index++) {
			const itemId = (updated[index] as { id?: number | string } | null)?.id;
			if (normalizeItemId(itemId) === targetId) {
				inheritId(itemId);
				updated[index] = change.value;
				return updated;
			}
		}
		return [...items, change.value];
	}

	// Lang-sliced path. get_data_lang (:1297-1332): the current-lang slice —
	// only objects carrying the slice lang. set_data_lang (:1093-1118) DROPS
	// non-objects and lang-orphan items from the merged result (PHP logs and
	// skips them), so they are not kept aside either.
	const slice: Record<string, unknown>[] = [];
	const otherLangs: unknown[] = [];
	for (const item of items) {
		if (item === null || typeof item !== 'object') continue;
		const itemLang = (item as { lang?: string }).lang;
		if (itemLang === sliceLang) {
			slice.push(item as Record<string, unknown>);
		} else if (isOtherLangItem(item, sliceLang)) {
			otherLangs.push(item);
		}
	}

	// PHP :4169-4180: id-less update with a key position resolves the shared id
	// from the sibling languages, so a first translation reuses the existing id
	// instead of minting a fresh one.
	if (targetId === null && change.key !== undefined && change.key !== null) {
		const resolved = getIdFromKey(items, Number(change.key), [sliceLang]);
		if (resolved !== null) {
			targetId = resolved;
			inheritId(resolved);
		}
	}

	let newSlice: unknown[];
	if (targetId === null) {
		newSlice = [...slice, change.value];
	} else {
		let matched = false;
		newSlice = slice.map((item) => {
			if (!matched && normalizeItemId(item.id) === targetId) {
				matched = true;
				inheritId(item.id);
				return change.value;
			}
			return item;
		});
		if (!matched) {
			newSlice.push(change.value);
		}
	}

	// set_data_lang: every slice item is persisted as a CLONE stamped with the
	// slice lang (PHP clones to avoid side effects and force-corrects a
	// mismatched/missing lang), appended after the untouched other-lang items.
	const stamped = newSlice.map((item) =>
		item !== null && typeof item === 'object'
			? { ...(item as Record<string, unknown>), lang: sliceLang }
			: item,
	);
	return [...otherLangs, ...stamped];
}

/**
 * Save component data changes. AUTHORIZATION is the caller's responsibility —
 * dispatch enforces both the permission level (>= 2 on the component) AND the
 * per-record projects scope (isRecordInScope) with the request principal before
 * calling here. This function performs no authorization of its own.
 *
 * TRANSACTIONAL (S1-02 / DEC-01): the whole change application runs in ONE
 * transaction, so the FOR UPDATE row lock holds to COMMIT and the data write +
 * TM audit row are atomic — a deliberate break with the PHP oracle's
 * last-writer-wins window (DECISIONS.md DEC-01: recommendation (b)). A REFUSED
 * save (ok:false) leaves NO TRACE: everything it wrote before refusing — the
 * create-on-first-save record and its counter move, the NEW activity row, TM
 * rows, item-id absorption — is rolled back when this door owns the
 * transaction (runSaveAtomically; under a caller's transaction the caller
 * owns that choice). A THROWN error rolls back as always. The wire answer is
 * unchanged.
 */
export async function saveComponentData(request: SaveRequest): Promise<SaveResult> {
	// Consultation-only sections (Activity dd542, Time Machine dd15, …) are
	// read-only for EVERY save door — the client API save handler already denies
	// with a 403 (PHP dd_core_api:1330 "Illegal save to activity"); this is the
	// belt for the MCP tools, the agent change-plan, and any future caller that
	// reaches the write engine directly. Guarded on a real (finite) record id so
	// the search_* preset path (section_id → NaN here) is left to its own flow.
	if (isConsultationOnlySection(request.sectionTipo) && Number.isFinite(request.sectionId)) {
		return {
			ok: false,
			message: `Illegal save to read-only section '${request.sectionTipo}'`,
			data: [],
		};
	}
	// component_alias (WC-020): a save addressed to an ALIAS writes the
	// TARGET's data — the column key, item-id counters, TM audit,
	// relation_search index and the row serialization all derive from the data
	// tipo, so alias-door and direct-door edits share ONE identity (stored
	// data never contains the alias tipo; item ids stay unique across doors
	// and engines). The wire keeps the alias (the dispatch handler logs and
	// echoes the rqo's tipo).
	const { resolveDataTipo } = await import('../../ontology/alias.ts');
	const dataTipo = await resolveDataTipo(request.componentTipo);
	const effectiveRequest =
		dataTipo === request.componentTipo ? request : { ...request, componentTipo: dataTipo };
	// THE WRITE LANGUAGE (P0-7): the caller's lang is stamped verbatim onto every
	// stored item, so it is checked against the install's declared data languages
	// before anything is written. AFTER the alias hop and on the effective
	// request, so the round-trip read below inspects the slice the write will
	// actually land on (stored data never carries the alias tipo); still BEFORE
	// the transaction — nothing to roll back, no row to lock. The ordinary write
	// pays one Set lookup on boot-frozen config, which is what lets this sit on
	// the hottest write path in the engine.
	await assertInstalledWriteLang(effectiveRequest);
	// Derived-from-remote components are refused BEFORE the transaction opens:
	// the answer is a property of the ontology, identical for every request, so
	// there is nothing to roll back and no row to lock (see assertNotExternalWrite).
	// After the alias hop, so an alias door onto an external tipo is refused too.
	await assertNotExternalWrite(effectiveRequest.componentTipo, effectiveRequest.sectionTipo);
	// ONT-TLD, same pre-transaction reasoning: the required value is a property of
	// the section, so nothing to roll back and no row to lock.
	const tldRefusal = ontologyTldRefusal(effectiveRequest);
	if (tldRefusal !== null) {
		return { ok: false, message: tldRefusal, data: [] };
	}
	// component_relation_children OWNS NO DATA (descriptor `derived`, RELATIONS_SPEC
	// §6.3): a save on it is a set of saves of each CHILD's component_relation_parent
	// (relations/children_write.ts — its own transaction, node lock, per-child
	// authorization; WC-2026-10-02-relation-children-write-through). It used to fall
	// through to the generic engine below, which stored the locators under the
	// children tipo — bytes no read consults — and answered ok while no child
	// changed. BEFORE the remove sentinel: a child is removed BY LOCATOR (computed
	// children carry no item id). The append backstop still runs first — the
	// model's policy refuses an append import.
	// Dynamic import: CYCLE-BREAKING at this chokepoint (CONVENTIONS §2 rationale 1)
	// — the write-through's nested child saves call back into saveComponentData.
	const dataModel = await getModelByTipo(effectiveRequest.componentTipo);
	if (dataModel === 'component_relation_children') {
		await assertAppendImportRequest(effectiveRequest);
		const { saveRelationChildren } = await import('../../relations/children_write.ts');
		return saveRelationChildren(effectiveRequest);
	}

	// THE REMOVE SENTINEL (see unnamedRemoveRefusal above). Same pre-transaction
	// reasoning: the answer is a property of the incoming changes alone.
	// A THROW, not `ok:false`: the dispatch save handler wraps an ok:false in
	// `record.save_failed` (internal/500, disclosure `operator`), so the reason
	// would never reach the curator whose delete button did nothing — and this
	// refusal is only useful if the actor is told what to send instead.
	const removeRefusal = unnamedRemoveRefusal(effectiveRequest.changedData);
	if (removeRefusal !== null) {
		throw new DedaloError('record.remove_without_id', {
			message: `saveComponentData: ${removeRefusal}`,
			publicMessage: removeRefusal,
			coordinates: {
				section_tipo: effectiveRequest.sectionTipo,
				section_id: effectiveRequest.sectionId,
				tipo: effectiveRequest.componentTipo,
			},
		});
	}

	// THE VALUE-SHAPE LAW (value_shape.ts;
	// WC-2026-10-03-save-refuses-malformed-value-shape): a value the model's
	// column does not store — a bare scalar, a null item, a non-array set_data,
	// a string number — is refused here, not stored. Same pre-transaction reasoning: the answer is a property of the
	// model and the incoming changes alone. BEFORE the value gates
	// (applyWriteValueGates), which assume the item shape.
	const shapeRefusal = valueShapeRefusal(
		dataModel === null ? null : getColumnNameByModel(dataModel),
		effectiveRequest.changedData,
	);
	if (shapeRefusal !== null) {
		throw new DedaloError('request.invalid_data', {
			message: `saveComponentData: malformed value for ${dataModel ?? 'unknown model'} '${effectiveRequest.componentTipo}' — ${shapeRefusal}`,
			coordinates: {
				tipo: effectiveRequest.componentTipo,
				model: dataModel ?? 'unknown',
				section_tipo: effectiveRequest.sectionTipo,
				section_id: effectiveRequest.sectionId,
			},
		});
	}

	// APPEND BACKSTOP (plan §4), same pre-transaction reasoning: the policy is a
	// property of the model, the shape a property of the request. The tool
	// refuses per column first; this holds for any other caller.
	await assertAppendImportRequest(effectiveRequest);

	// THE RECEIPT (CLOSURE_PLAN Step 2): the write chokepoint's observer ledger
	// drains after the save's COMMIT — before runSaveAtomically returns, since
	// withTransaction awaits its commit-only lane — and hands back the recomputed
	// observer items whose target IS this record (PHP observers_data). Under a
	// caller's transaction the drain waits for THAT commit, so it stays empty.
	const receipt: WriteReceipt = { observersData: [] };
	const result = await runSaveAtomically(effectiveRequest, receipt);

	// Post-commit side effect — deliberately OUTSIDE the transaction (S1-14
	// posture: clearing a shared cache mid-tx invites repopulation with
	// uncommitted or about-to-be-stale state). Security-cache invalidation
	// (SEC): if this write touched a profile's grants or a user's
	// profile/projects assignment, drop the affected per-user caches so the
	// change takes effect on the next request rather than after a restart.
	// No-op for ordinary content writes.
	if (result.ok) {
		// `clearSecurityCachesForWrite`, NOT `invalidatePermissionsForWrite` (2026-08-28,
		// P1-4): the queue below REPLAYS ON ROLLBACK, and the full reaction also ends
		// the account's sessions. A rolled-back password edit that logged the target out
		// anyway is the fail-OPEN shape this batch exists to remove; the REVOCATION is
		// scheduled by the write chokepoint itself (section_record/record_write.ts) on
		// the COMMIT-ONLY lane.
		const { clearSecurityCachesForWrite } = await import('../../security/permissions.ts');
		// The DATA tipo (alias hop applied) — grant/profile caches key on the
		// real component the write landed on.
		const invalidate = (): void =>
			clearSecurityCachesForWrite(
				effectiveRequest.sectionTipo,
				effectiveRequest.componentTipo,
				Number(effectiveRequest.sectionId),
			);
		// "Post-commit" is only true when this door OWNS the transaction. Under an
		// ambient caller transaction (the import doors' per-record/per-row wrap)
		// the line above returns with the transaction still OPEN, and clearing a
		// shared cache there re-opens the S1-14 window: a concurrent request
		// repopulates it from the state committed so far — which does NOT include
		// this write — and the entry is stale from the moment the caller commits.
		// `deferPostTransaction` is the house lane for exactly this (idempotent
		// cache clears, replayed after the transaction settles, on rollback too);
		// it returns false when there is no ambient transaction, which is the
		// interactive path, and then the clear runs inline exactly as before.
		if (!deferPostTransaction(invalidate)) invalidate();
		// Server-side observers (PHP propagate_to_observers) are NOT fired here any
		// more: the write chokepoint declares every key change to the obligation
		// ledger (section_record/obligation_ledger.ts), which drains post-commit
		// for EVERY writer — this door, the restores, the undeletes, the bulk
		// revert (CLOSURE_PLAN Step 2, CORE-1). What the interactive door still
		// owes its caller is the same-record observer data, collected on the
		// receipt. A copy: the receipt belongs to the ledger.
		result.observersData = [...receipt.observersData];
	}
	// A credential (descriptor `secretValue`) never leaves the write engine: the
	// returned items are what every door echoes (the dispatch save response, the
	// MCP tools, the change-plan) — masked like every read
	// (WC-2026-09-30-password-hash-never-served). After the observer cascade
	// above, which is internal and reads the real items.
	if (Array.isArray(result.data) && result.data.length > 0) {
		const { getModelByTipo } = await import('../../ontology/resolver.ts');
		const model = await getModelByTipo(effectiveRequest.componentTipo);
		if (model !== null && getComponentModel(model)?.secretValue === true) {
			const { maskSecretItems } = await import('../../resolve/component_data.ts');
			return { ...result, data: maskSecretItems(result.data) ?? [] };
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// A REFUSED SAVE LEAVES NO TRACE (2026-09-29).
//
// applySaveComponentData answers a refusal with `{ok:false}` — some of them
// AFTER it already wrote: the create-on-first-save branch materializes a
// missing record (row + matrix_counter raise + NEW activity row) before the
// change loop runs, and a `remove` of an absent id then refuses. Committing
// that left an empty record and a jumped counter for a save that reported
// failure. The refusal is therefore carried OUT of the transaction as a
// throw (so it rolls back) and converted back to the unchanged ok:false
// result at this boundary — the throw never escapes saveComponentData.
//
// AMBIENT TRANSACTION (the import doors' per-record wrap): `withTransaction`
// joins, the throw is caught here, and the refused part's writes stay in the
// CALLER's transaction — its owner decides (the CSV door throws on ok:false and
// rolls the row back). Deliberately NOT a SAVEPOINT here: whether the refused
// part stays is the caller's decision, and a caller that wants it undone opens
// its own (tool_import_rdf: one per op). Either way a create-on-save keeps its
// NEW activity row and bulk-run BIRTH marker — create_record.ts decides the
// birth by the insert statement, never by xmin, which under
// a savepoint is the SUBtransaction's id (measured 2026-09-29; fixed 2026-10-01).
// ---------------------------------------------------------------------------

/** The refusal in flight — thrown inside the transaction, caught right here. */
class SaveRefusedRollback extends DedaloError {
	readonly result: SaveResult;

	constructor(result: SaveResult) {
		super('record.save_failed', { message: `saveComponentData refused: ${result.message}` });
		this.name = 'SaveRefusedRollback';
		this.result = result;
	}
}

/** Apply the save; a refusal becomes a throw so the enclosing transaction rolls it back. */
async function applyOrThrowRefusal(
	request: SaveRequest,
	receipt: WriteReceipt,
): Promise<SaveResult> {
	const result = await applySaveComponentData(request, receipt);
	if (!result.ok) throw new SaveRefusedRollback(result);
	return result;
}

/** One save, atomically: committed whole on success, no trace on a refusal. */
async function runSaveAtomically(request: SaveRequest, receipt: WriteReceipt): Promise<SaveResult> {
	try {
		return await withTransaction(() => applyOrThrowRefusal(request, receipt));
	} catch (error) {
		if (error instanceof SaveRefusedRollback) return error.result;
		throw error;
	}
}

// ---------------------------------------------------------------------------
// CSV-import APPEND (SaveRequest.appendImport) — the engine half of plan §4.
// The merge itself is the pure module append_merge.ts (dynamic import,
// engineering/CONVENTIONS.md §2); these helpers only bind it to the save.
// ---------------------------------------------------------------------------

/** Whether this save is an append-import save (either form of the flag). */
function isAppendImport(request: SaveRequest): boolean {
	const flag: unknown = request.appendImport;
	return flag === true || (typeof flag === 'object' && flag !== null);
}

function appendRefusal(request: SaveRequest, why: string): DedaloError {
	return new DedaloError('request.invalid_data', {
		message: `saveComponentData: append refused for '${request.componentTipo}' — ${why}`,
		coordinates: {
			tipo: request.componentTipo,
			section_tipo: request.sectionTipo,
			section_id: request.sectionId,
		},
	});
}

/**
 * A literal `set_data` replace: the items the component holds after it.
 *   - LANG-SLICED (PHP set_data_lang :1052-1128): replace ONLY the
 *     effective-lang slice. Other-lang stored items are kept untouched; stored
 *     items WITHOUT a lang are dropped (PHP logs and skips lang orphans); every
 *     new item is persisted as a CLONE stamped with the slice lang (non-objects
 *     are skipped — PHP set_data_lang accepts only objects).
 *   - otherwise the whole key is the incoming array.
 * An id-less incoming item equal (id aside) to the stored item at the same
 * position KEEPS that item's id (concepts/item_value.ts adoptStoredItemIds):
 * a CSV cell names no id, and re-minting one made every re-import of an
 * unchanged file a change — an undo pair plus a visible row per cell — and
 * unpaired any dataframe frame keyed to the old id (review 2026-09-27).
 */
function replaceLiteralItems(
	stored: unknown[],
	rawItems: unknown[],
	langSliced: boolean,
	effectiveLang: string,
): unknown[] {
	if (!langSliced) return adoptStoredItemIds(rawItems, stored);
	const otherLangs = stored.filter((item) => isOtherLangItem(item, effectiveLang));
	// The slice's OWN items only: a lang-less orphan is dropped by the replace,
	// never a position an incoming item could take the id of.
	const ownLang = stored.filter(
		(item) =>
			item !== null &&
			typeof item === 'object' &&
			(item as { lang?: unknown }).lang === effectiveLang,
	);
	const stamped = rawItems
		.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
		.map((item) => ({ ...item, lang: effectiveLang }));
	return [...otherLangs, ...adoptStoredItemIds(stamped, ownLang)];
}

/**
 * A relation `set_data` replace: the locators the component holds after it.
 * Every element goes through the insert door (`validateRelationInsert` —
 * normalized, deduped against the NEW array, stored links exempt from the
 * constraint gates via the `stored` baseline); then each id-less locator that
 * IS a stored link keeps that link's id (relations/save.ts
 * adoptStoredLocatorIds) — else the id safety net re-minted it, an unchanged
 * CSV/propagate replace wrote an undo pair, and the frames keyed to the old id
 * were unpaired (review 2026-09-28).
 */
async function replaceRelationItems(
	rawItems: readonly unknown[],
	stored: unknown[],
	context: Omit<RelationInsertContext, 'existingItems' | 'storedItems'>,
): Promise<unknown[]> {
	const validatedItems: Record<string, unknown>[] = [];
	for (const element of rawItems) {
		if (element === null || typeof element !== 'object') {
			continue; // PHP wraps a scalar into {value}, which then fails the locator law
		}
		const safeElement = await validateRelationInsert(element as Record<string, unknown>, {
			...context,
			existingItems: validatedItems,
			storedItems: stored,
		});
		if (safeElement !== null) validatedItems.push(safeElement);
	}
	return adoptStoredLocatorIds(validatedItems, stored, {
		translatable: context.translatable === true,
		pairing: context.pairing != null,
	});
}

/**
 * The BACKSTOP: an append save carries exactly one `set_data` change, on a
 * model whose descriptor policy is not `refuse`. Throws; no-op otherwise.
 */
async function assertAppendImportRequest(request: SaveRequest): Promise<void> {
	if (!isAppendImport(request)) return;
	const changes = request.changedData;
	if (changes.length !== 1 || changes[0]?.action !== 'set_data') {
		throw appendRefusal(request, 'an append save carries exactly one set_data change');
	}
	const refusal = appendPolicyRefusal(await getModelByTipo(request.componentTipo));
	if (refusal !== null) throw appendRefusal(request, refusal);
}

/** Why the model refuses append (its policy's reason), or null when it appends. */
function appendPolicyRefusal(model: string | null): string | null {
	if (model === null || getComponentModel(model) === undefined) {
		return `no component descriptor for model '${String(model)}'`;
	}
	const policy = getImportAppendPolicy(model);
	return typeof policy === 'object' ? policy.refuse : null;
}

/** What the append merge needs from the save it runs inside. */
interface AppendSaveContext {
	request: SaveRequest;
	model: string;
	column: MatrixJsonbColumn;
	/** The effective data lang of the save. */
	lang: string;
	langSliced: boolean;
	translatable: boolean;
	dataframePairing: DataframePairing | null;
}

/** The merge, bound to this save: policy, equality family, insert law. */
async function mergeAppendForSave(
	context: AppendSaveContext,
	stored: unknown[],
	incoming: unknown[],
): Promise<AppendMergeResult> {
	const { mergeAppend, literalEqualityFamilyOf } = await import('./append_merge.ts');
	const options = context.request.appendImport;
	return mergeAppend({
		policy: getImportAppendPolicy(context.model),
		family: context.column === 'relation' ? 'relation' : literalEqualityFamilyOf(context.model),
		stored,
		incoming,
		lang: context.lang,
		langSliced: context.langSliced,
		preallocatedIds: typeof options === 'object' ? options.preallocatedIds : undefined,
		// The first-translation rule (getIdFromKey, as the lang-sliced insert
		// path): a new translation takes the id its sibling languages already
		// give that slice position, read from the LOCKED stored array.
		siblingIdAt: context.langSliced
			? (position) => getIdFromKey(stored, position, [context.lang])
			: undefined,
		validateRelation: await relationAppendValidator(context),
		componentTipo: context.request.componentTipo,
	});
}

/**
 * The relation insert law bound to the save — the length-1 VERDICT door
 * (`validateRelationInsertVerdict`: constraint refusals throw exactly as
 * `validateRelationInsert`, a PHP-era drop answers its code + the matched
 * item). The merge supplies `existingItems = stored + accepted` per call and
 * that alone drives the dedup and the cap — the INSERT door's context.
 *
 * (!) NO `storedItems`. That is the re-persist baseline of a REPLACE, whose
 * whole array is replayed through the door; append hands the law only
 * INCOMING items, every one of them a candidate for growth. The baseline's
 * gate-0 short-circuit compares ADDRESS ONLY (no id_key when pairing is null,
 * no tag_id, no type), so passing it let a net-new locator that merely shared
 * a stored target record — a new tag_id on an already-indexed record, a new
 * frame for another main item — skip every constraint gate, the data_limit
 * cap included.
 */
async function relationAppendValidator(
	context: AppendSaveContext,
): Promise<RelationAppendValidator> {
	const { validateRelationInsertVerdict } = await import('../../relations/save.ts');
	const { request } = context;
	return (raw, existingItems) =>
		validateRelationInsertVerdict(raw, {
			componentTipo: request.componentTipo,
			model: context.model,
			hostSectionTipo: request.sectionTipo,
			hostSectionId: request.sectionId,
			translatable: context.translatable,
			lang: context.lang,
			existingItems: [...existingItems],
			pairing: context.dataframePairing,
			principal: request.principal,
			// gate 2b's identity of last resort (relations/save.ts attributedUserId)
			attributedUserId: request.userId,
		});
}

/**
 * Whether an append merge changed anything: the result is not the stored
 * array item-for-item BY REFERENCE (every policy keeps unchanged stored items
 * by reference and replaces a changed one with a new object), or the id map
 * needs an id allocated on a matched id-less item.
 */
function appendMergeChanged(stored: readonly unknown[], outcome: AppendMergeResult): boolean {
	if (outcome.items.length !== stored.length) return true;
	if (outcome.items.some((item, index) => item !== stored[index])) return true;
	return outcome.idMapPlan.some((entry) => entry.target.kind === 'new');
}

/**
 * One append `set_data` change: the merge, and — for a NO-OP append (every
 * incoming item a duplicate / empty / dropped) — the finished result, so the
 * save writes NOTHING: no key rewrite, no dd197/dd201 bump, no RAG event, no
 * Time Machine row. Re-importing the same file changes nothing (plan §0/§7),
 * and the dd800 bulk-revert set is not polluted with identity rows. The one
 * exception is a matched id-less stored item (PHP-era data): its id must be
 * allocated for the id map, which is a real change and takes the normal write.
 * `storedValue` is the echo of an unchanged save (the full dataframe slot).
 */
async function appendChangeStep(
	context: AppendSaveContext,
	stored: unknown[],
	incoming: unknown[],
	storedValue: unknown[],
): Promise<{ outcome: AppendMergeResult; noop: SaveResult | null }> {
	const outcome = await mergeAppendForSave(context, stored, incoming);
	if (appendMergeChanged(stored, outcome)) return { outcome, noop: null };
	const noop: SaveResult = { ok: true, message: 'ok', data: storedValue };
	await attachAppendOutcome(noop, outcome);
	return { outcome, noop };
}

/**
 * The append save's internal outputs — never on the wire. Called AFTER the id
 * allocation loop, so every new item's final id is readable.
 */
async function attachAppendOutcome(
	result: SaveResult,
	outcome: AppendMergeResult | null,
): Promise<void> {
	if (outcome === null) return;
	const { resolveAppendedIdMap } = await import('./append_merge.ts');
	result.appendedIdMap = resolveAppendedIdMap(outcome.idMapPlan);
	result.appendSkipped = outcome.skipped.filter((skip) => skip.reason === 'duplicate').length;
}

/** The transactional body of saveComponentData (see the wrapper above). */
/**
 * The write engine's two VALUE gates, each keyed on what the model itself
 * declares — extracted from `applySaveComponentData` so the save path does not
 * carry their branches (the complexity ratchet is the reason, and the shape is
 * better: both read the changed data and nothing else of the request).
 *
 * SEC — component_password is an ordinary string component to the write engine,
 * so an unhashed value would be stored VERBATIM: the client's plaintext password
 * straight into matrix_users.string.dd133 (and it would then fail every login,
 * since auth.ts accepts only Argon2id). PHP hashed on the way in
 * (component_password::Save → hash_password); this is that gate.
 *
 * XSS-01 (2026-07-28 audit) / P2-6 (2026-08-26) — a value whose descriptor
 * declares the `html` render class is the ONE class the client passes through
 * unescaped, so it is the ONE class sanitized here (strip script/style/on*=/js:
 * URLs, keep formatting). Keyed on the descriptor facet, never on the model
 * string: a model that declares 'html' opts into this sanitizer in that line.
 * A model WITHOUT a descriptor (component_ip, component_layout, …) is not asked
 * for a class — it has no matrix column either, so the graceful `no matrix
 * column` refusal downstream stays the answer, as it was before.
 *
 * Both sit at the write engine precisely so EVERY door funnels through them —
 * the client API, the MCP tools, the agent change-plan and import alike.
 */
async function applyWriteValueGates(
	model: string,
	changedData: SaveRequest['changedData'],
): Promise<SaveRequest['changedData']> {
	if (model === 'component_password') {
		return await (await import('../../security/password_hash.ts')).hashPasswordChanges(changedData);
	}
	if (getComponentModel(model) !== undefined && getRenderClass(model) === 'html') {
		const { mapRichTextChanges, sanitizeRichText } = await import('../../security/html_sanitize.ts');
		// TODO-067: a media src on an absolute webBase is persisted relative (WC-042).
		const { relativizeMediaSrc } = await import('../../media/web_base_src.ts');
		return mapRichTextChanges(changedData, (value) => relativizeMediaSrc(sanitizeRichText(value)));
	}
	return changedData;
}

/** One component key read under the save's row lock (see applySaveComponentData). */
interface LockedComponentKey {
	/** The stored value as the change loop consumes it: always an array. */
	items: unknown[];
	/** The stored value verbatim — `undefined` when the key (or its column) is absent. */
	image: unknown;
}

/**
 * `SELECT … FOR UPDATE` of one component key — null when the ROW does not
 * exist. The `?` probe tells an absent key from a stored JSON null (Bun maps
 * both to JS null): the undo log records absence as absence.
 */
async function lockComponentKey(
	table: string,
	column: MatrixJsonbColumn,
	componentTipo: string,
	sectionTipo: string,
	sectionId: number,
): Promise<LockedComponentKey | null> {
	const rows = (await sql.unsafe(
		`SELECT ("${column}" ? $3) AS present, "${column}"->$3 AS items FROM "${table}"
		 WHERE section_tipo = $1 AND section_id = $2 FOR UPDATE`,
		[sectionTipo, sectionId, componentTipo],
	)) as { present: boolean | null; items: unknown }[];
	const row = rows[0];
	if (row === undefined) return null;
	const raw = row.items;
	return {
		items: Array.isArray(raw) ? raw : raw == null ? [] : [raw],
		image: row.present === true ? raw : undefined,
	};
}

async function applySaveComponentData(
	request: SaveRequest,
	receipt: WriteReceipt,
): Promise<SaveResult> {
	const { componentTipo, sectionTipo, sectionId, lang, userId } = request;
	const callerDataframe = request.callerDataframe ?? null;

	const model = await getModelByTipo(componentTipo);
	if (model === null) {
		return { ok: false, message: `unknown component tipo '${componentTipo}'` };
	}

	// SEC — component_password is an ordinary string component to the write engine,
	// so an unhashed value would be stored VERBATIM: the client's plaintext password
	// straight into matrix_users.string.dd133 (and it would then fail every login,
	// since auth.ts accepts only Argon2id). PHP hashed on the way in
	// (component_password::Save → hash_password); this is that gate. It sits here, at
	// the write engine, precisely so EVERY door funnels through it — the client API,
	// the MCP tools, the agent change-plan and import alike.
	// XSS-01 (2026-07-28 audit): component_text_area is CKEditor rich text stored
	// verbatim — sanitize it on the way in (strip script/style/on*=/js: URLs,
	// keep formatting) so a stored payload never rides the wire. Defense in depth
	// behind the enforcing CSP; sits here at the write engine so EVERY door
	// (client API, MCP, change-plan, import) funnels through it, exactly like the
	// password hash gate below.
	const changedData = await applyWriteValueGates(model, request.changedData);
	const mappedColumn = getColumnNameByModel(model);
	if (mappedColumn === null || !MATRIX_JSONB_COLUMNS.includes(mappedColumn as MatrixJsonbColumn)) {
		return { ok: false, message: `no matrix column for model '${model}'` };
	}
	const column = mappedColumn as MatrixJsonbColumn;
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === null) {
		return { ok: false, message: `no matrix table for section '${sectionTipo}'` };
	}

	const translatable = await getTranslatableByTipo(componentTipo);

	// PHP lang-slice gate (isLangSlicedModel above — shared with the temporal door).
	const langSliced = isLangSlicedModel(model);
	// PHP's effective lang (resolver.ts effectiveSaveLang): a transliterable
	// (with_lang_versions) component keeps the request lang like a translatable one.
	const effectiveLang = await effectiveSaveLang(componentTipo, model, lang);

	// SERIALIZED read-modify-write (S1-02, DEC-01: deliberately STRONGER than
	// the PHP oracle, whose save flow has no lock/tx and loses one of two
	// concurrent edits): the whole change application below runs inside ONE
	// transaction (the ALS proxy in db/postgres.ts routes every inner helper
	// onto the tx connection), so this row lock HOLDS until COMMIT — concurrent
	// saves on the same record queue instead of clobbering each other's items,
	// and the data write + Time Machine audit row land atomically. No wire
	// change; nothing in the response shape depends on this.
	let locked = await lockComponentKey(table, column, componentTipo, sectionTipo, sectionId);
	if (locked === null) {
		// PHP set_dato upserts: saving component data to a section_id whose matrix
		// row does not exist yet CREATES the record (class.section_record::save_key_data
		// → matrix INSERT), rather than erroring. Mirror that so an edit-mode save on a
		// not-yet-materialized record works (e.g. the portal suite's test3/2 fixture,
		// which the test clears then links into). The section + write permission (level
		// >= 2) were already validated by the dispatch save handler, so the create is
		// authorized. The create is CONFLICT-TOLERANT and the row is RE-LOCKED after it
		// (S1-02 Wave-2 correction: the upsert branch would otherwise lock nothing when
		// a concurrent save materializes the row first). Under a bulk id the create
		// writes the run's BIRTH marker — only when it really inserted the row.
		const { createSectionRecord } = await import('./create_record.ts');
		await createSectionRecord(sectionTipo, userId, new Date(), Number(sectionId), {
			conflictTolerant: true,
			bulkProcessId: request.bulkProcessId,
		});
		locked = await lockComponentKey(table, column, componentTipo, sectionTipo, sectionId);
	}
	let items: unknown[] = locked?.items ?? [];
	// THE SAVE'S HISTORY (bulk_capture.ts): its BEFORE is cut and CLONED here,
	// under the lock and before any branch below mutates a stored item in place.
	const history = await beginSaveHistory({
		bulkProcessId: request.bulkProcessId,
		target: { table, sectionTipo, sectionId },
		column,
		componentTipo,
		model,
		sliced: langSliced,
		translatable,
		lang: effectiveLang,
		requestLang: lang,
		userId,
		lockedImage: locked?.image,
		callerMain: callerDataframe?.main_component_tipo ?? null,
	});

	// PRE-SAVE SNAPSHOT for result.removedItems (2026-08-06). Taken here, on
	// the FULL slot under the lock and before any narrowing, so it matches what
	// `result.data` reports on both the dataframe and non-dataframe paths. A
	// shallow copy suffices: every mutation path REBINDS `items` (applyUpdate
	// returns a new array, remove filters, set_data reassigns), and the in-place
	// writes touch `id` and dates — never locator identity.
	// Relation slots only: a literal save has no locators to remove, so it pays
	// nothing.
	const preSaveItems = observerDiffSnapshot(column, items);
	// The removes the loop applied — their dataframe consequence runs after the
	// whole batch applied and the component was written (cascadeAppliedRemoves).
	const appliedRemoves: AppliedRemove[] = [];

	// DATAFRAME saves (PHP component_dataframe get_data/set_data): the change
	// loop operates on the CALLER's frame subset; the full slot is kept for
	// the sibling-preserving merge at write time.
	const isDataframeSave = model === 'component_dataframe' && callerDataframe !== null;
	const fullSlotItems = items;
	if (isDataframeSave) {
		const { filterCallerEntries } = await import('../../relations/dataframe.ts');
		items = filterCallerEntries(items as Record<string, unknown>[], callerDataframe, componentTipo);
	}
	// The pairing handed to validateRelationInsert on every value-carrying
	// branch below (insert / update / set_data). Built ONCE from the caller
	// context so the three branches cannot drift apart — which is precisely how
	// the dataframe write path lost its normalization: each branch grew its own
	// `!isDataframeSave` opt-out.
	// The pairing handed to validateRelationInsert on every value-carrying
	// branch below, derived through the ONE shared validity rule.
	const validPairing = dataframePairingOf(callerDataframe);
	const dataframePairing: DataframePairing | null =
		isDataframeSave && validPairing !== null
			? {
					frameTipo: componentTipo,
					mainComponentTipo: validPairing.main_component_tipo,
					idKey: validPairing.id_key,
				}
			: null;
	// REFUSE LOUDLY rather than write an unreadable frame. A dataframe write
	// whose caller context is incomplete (no main component, id_key 0/absent —
	// the client sends `self.caller?.tipo || null` when the caller instance is
	// not threaded) CANNOT produce an entry the read predicate will ever match:
	// it would be stored, invisible, and undeletable through the UI. That is
	// the exact failure this change set exists to end, so it fails the save
	// instead of silently persisting garbage (the project's "uncovered paths
	// throw loudly" rule). Frames written with NO caller context at all —
	// maintenance, import — keep their own doors and never reach here.
	if (isDataframeSave && validPairing === null) {
		return {
			ok: false,
			message:
				'dataframe save refused: source.caller_dataframe needs main_component_tipo + an integer id_key >= 1',
		};
	}

	// Absorb explicit item ids into the meta counter BEFORE any allocation
	// (PHP set_data :1009-1019 runs the raise on every write, so a counter can
	// never lag behind seeded/imported ids and hand out a duplicate).
	// The whole stored value as the caller sees it echoed: the full slot for a
	// dataframe save, the stored array otherwise (read before the change loop).
	const storedValue = isDataframeSave ? fullSlotItems : items;
	await absorbComponentItemIds(table, sectionTipo, sectionId, componentTipo, storedValue);

	// Split changes: updates mutate the read array; inserts are applied as
	// ATOMIC single-statement appends (no read-modify-write), so concurrent
	// inserts can never drop each other's items.
	const atomicInserts: unknown[] = [];
	let hasRemovals = false;
	let hasReorders = false;
	let hasReplacingInserts = false;
	const monovalue = isMonovalueModel(model);
	let createdSectionId: number | null = null;
	let appendOutcome: AppendMergeResult | null = null;
	for (const change of changedData) {
		if (
			change.action !== 'update' &&
			change.action !== 'insert' &&
			change.action !== 'remove' &&
			change.action !== 'clear' &&
			change.action !== 'set_data' &&
			change.action !== 'sort_data' &&
			change.action !== 'sort_by_column' &&
			change.action !== 'add_new_element'
		) {
			throw new DedaloError('request.invalid_data', {
				message: `saveComponentData: action '${change.action}' not implemented yet (Phase 5 uncovered scope)`,
				coordinates: {
					tipo: componentTipo,
					section_tipo: sectionTipo,
					section_id: sectionId,
					action: change.action,
				},
			});
		}

		if (change.action === 'sort_data') {
			// PHP update_data_value 'sort_data': move one locator from its
			// absolute position (source_key = paginated_key) to target_key.
			const sorted = applySortData(items, change as unknown as SortDataChange);
			if (sorted === null) {
				return { ok: false, message: 'sort_data failed (key/locator mismatch)' };
			}
			items = sorted;
			hasReorders = true;
			continue;
		}
		if (change.action === 'sort_by_column') {
			const sorted = await applySortByColumn(
				items,
				change as unknown as SortByColumnChange,
				componentTipo,
				sectionTipo,
			);
			if (sorted === null) {
				return { ok: false, message: 'sort_by_column failed (gate/column/direction)' };
			}
			items = sorted;
			hasReorders = true;
			continue;
		}
		if (change.action === 'add_new_element') {
			// PHP component_relation_common::add_new_element: create a target
			// record (inheriting the host's project filter) and link it.
			const outcome = await applyAddNewElement(
				items,
				String(change.value ?? ''),
				componentTipo,
				sectionTipo,
				sectionId,
			);
			if (outcome === null) {
				return { ok: false, message: 'add_new_element failed' };
			}
			items = outcome.items;
			createdSectionId = outcome.sectionId;
			hasReorders = true; // full-array persist
			continue;
		}

		if (change.action === 'set_data') {
			// PHP: bulk-replace the data array, no key checks — but NOT across
			// languages: update_data_value 'set_data' (:4380) routes through
			// set_data_lang, so for the translation-supporting literal classes the
			// replace is LANG-SLICED (see below). A raw full replace here was the
			// import multi-language bug: the CSV executor saves one language at a
			// time, and each save wiped the previous language's items.
			const rawItems = Array.isArray(change.value) ? (change.value as unknown[]) : [];
			// CSV-import APPEND: merge onto the stored items (read under the lock
			// above, value gates already applied) instead of the replace below —
			// stored items are never replayed through its re-validation.
			if (isAppendImport(request)) {
				const step = await appendChangeStep(
					{
						request,
						model,
						column,
						lang: effectiveLang,
						langSliced,
						translatable,
						dataframePairing,
					},
					items,
					rawItems,
					storedValue,
				);
				appendOutcome = step.outcome;
				if (step.noop !== null) return step.noop;
				items = step.outcome.items;
				hasRemovals = true; // full-array write + id allocation for the new items
				continue;
			}
			// RELATION elements are NORMALIZED here, not stored raw. PHP's bulk-replace
			// is not a raw assignment either: component_common::set_data (:997) runs
			// validate_data_element over EVERY element, which is the same normalizer the
			// insert path uses — `type` filled, `from_component_tipo` FORCED, section_id
			// stringified, paginated_key stripped, duplicates dropped.
			// Storing the client's raw locator instead persisted a BARE
			// {id, section_tipo, section_id} with no from_component_tipo, and every jsonb
			// @> containment that names it then missed the record — e.g. the hierarchy4
			// "active" filter behind a portal's target_sections (a saved-active hierarchy
			// resolved to zero targets: "Invalid target section tipo (empty)").
			// Dedup scope is the NEW array only: PHP resets its locator lookup map on the
			// first element of the call (:1150-53), so an element is compared against the
			// ones already accepted in THIS set_data, never against the stored data.
			// (!) THE RE-PERSIST BASELINE. `items` here is what the component holds
			// BEFORE this replace, and it is handed to every element as
			// `storedItems`. A set_data replays the WHOLE array through the insert
			// door — the CSV import and the raw-export round trip both do — so
			// without this baseline the constraint gates would re-judge locators
			// that were legitimately linked long ago and DROP the ones whose world
			// has since moved (target hierarchy deactivated, saving principal
			// lacking read on a colleague's section, `is_indexable` cleared). The
			// element vanishes and the save still reports success. Captured before
			// the loop because `validatedItems` is the growing NEW array, which is
			// a different question (the dedup scope, see above).
			const storedItemsBaseline = items.slice();
			if (column === 'relation') {
				items = await replaceRelationItems(rawItems, storedItemsBaseline, {
					componentTipo,
					model,
					hostSectionTipo: sectionTipo,
					hostSectionId: sectionId,
					translatable,
					lang: effectiveLang,
					pairing: dataframePairing,
					principal: request.principal,
					// gate 2b's identity of last resort (relations/save.ts attributedUserId)
					attributedUserId: request.userId,
				});
			} else {
				items = replaceLiteralItems(items, rawItems, langSliced, effectiveLang);
			}
			hasRemovals = true; // force the full-array write path
			continue;
		}

		if (change.action === 'clear') {
			// THE EXPLICIT WIPE (2026-08-30, DATA-06 — the WC entry is
			// WC-2026-08-30-remove-requires-item-id). This is the behaviour the
			// id-less `remove` used to have, moved behind a word that says it:
			// EVERY item of the component in EVERY language, whatever the request
			// lang. A caller that means one language sends the remaining items as
			// `set_data` (lang-sliced) or removes by id.
			//
			// No dataframe cascade, exactly as the branch it replaces (PHP
			// update_data_value :4235-4243 does not cascade on the clear-all path
			// either): the paired frames of the cleared items are left in their
			// slots. That is INHERITED, not endorsed — it is the same orphan the
			// old path made, and it stays a known gap rather than an unreviewed
			// extra deletion smuggled into a data-loss fix.
			hasRemovals = true;
			items = [];
			continue;
		}

		if (change.action === 'remove') {
			hasRemovals = true;
			const targetId = resolveRemoveTargetId(change, {
				tipo: componentTipo,
				section_tipo: sectionTipo,
				section_id: sectionId,
			});
			// Remove EVERY item with the id — translated items share ids, so this
			// is the PHP cross-language removal for translatable literals.
			const before = items.length;
			const itemsBeforeRemove = items;
			items = withoutItemId(items, targetId);
			if (items.length === before) {
				// PHP fails the save when the id does not exist.
				return { ok: false, message: `remove: no item with id ${targetId}` };
			}
			// The dataframe consequence is DEFERRED to cascadeAppliedRemoves, after
			// the whole batch applied — a later refused change runs no cascade.
			appliedRemoves.push({
				targetId,
				removedEntries: itemsBeforeRemove.filter((item) => !items.includes(item)),
			});
			continue;
		}
		// Lang stamp. Sliced components force the EFFECTIVE lang onto the changed
		// value (PHP set_data_lang clone-stamps every slice item, :1088-1090,
		// correcting a mismatched/missing lang); other translatable components
		// only fill a missing lang (PHP set_data lang-orphan guard :983-988).
		if (change.value !== null && typeof change.value === 'object') {
			if (langSliced) {
				(change.value as { lang?: string }).lang = effectiveLang;
			} else if (translatable && (change.value as { lang?: string }).lang === undefined) {
				(change.value as { lang?: string }).lang = lang;
			}
		}

		if (change.action === 'insert') {
			let value = change.value;
			if (value === null || typeof value !== 'object') {
				throw new DedaloError('request.invalid_data', {
					message: 'saveComponentData: insert value must be an object item',
					coordinates: { tipo: componentTipo, section_tipo: sectionTipo, section_id: sectionId },
				});
			}
			// Relation-family insert validation (PHP validate_data_element,
			// component_relation_common.php:1058 — the service_autocomplete
			// link_record flow): type fill, forced from_component_tipo,
			// autoreference guard, paginated_key strip, string section_id, and
			// duplicate rejection (a dup is DROPPED so pagination.total stays
			// unchanged — the client's server-authoritative duplicate check).
			// Dataframe saves run through it too, with the pairing: the caller's
			// frame subset is the dedup scope, and the normalizer stamps dd490 +
			// the server-side pairing fields over whatever the picker sent.
			if (column === 'relation') {
				const { validateRelationInsert } = await import('../../relations/save.ts');
				const validated = await validateRelationInsert(value as Record<string, unknown>, {
					componentTipo,
					model,
					hostSectionTipo: sectionTipo,
					hostSectionId: sectionId,
					translatable,
					lang: effectiveLang,
					existingItems: items,
					pairing: dataframePairing,
					principal: request.principal,
					// gate 2b's identity of last resort (relations/save.ts attributedUserId)
					attributedUserId: request.userId,
				});
				if (validated === null) continue; // ignored insert (PHP returns false)
				value = validated;
			}
			// PHP :4110-4126: translatable-literal insert with a key position
			// resolves the SHARED item id from the sibling languages at the same
			// position, so a first translation reuses the existing id instead of
			// minting a fresh one (which would orphan it from its siblings).
			if (langSliced && change.key !== undefined && change.key !== null) {
				const resolved = getIdFromKey(items, Number(change.key), [effectiveLang]);
				if (resolved !== null) {
					(value as { id?: unknown }).id = resolved;
				}
			}
			// (component_relation_children never reaches this engine: saveComponentData
			// hands it to the write-through, relations/children_write.ts.)
			if ((value as { id?: unknown }).id === undefined || (value as { id?: unknown }).id === null) {
				(value as { id: number }).id = await allocateComponentItemId(
					table,
					sectionTipo,
					sectionId,
					componentTipo,
				);
			}
			if (monovalue) {
				// MONOVALUE INSERT REPLACES (PHP update_data_value 'insert' :4128-4131:
				// `$data_lang = [$changed_data->value]` — the current-lang slice for
				// the translation-supporting literal classes, the whole array
				// otherwise; DATA-14, WC-2026-09-03-monovalue-insert-replaces). Only
				// element 0 is ever read, so an append here would store a value no
				// reader serves while the record keeps the stale one. The replaced
				// slot is a read-modify-write under the row lock, so it takes the
				// full-array persist below, never the atomic concatenation.
				items = langSliced
					? [...items.filter((item) => isOtherLangItem(item, effectiveLang)), value]
					: [value];
				hasReplacingInserts = true;
				continue;
			}
			atomicInserts.push(value);
			items = [...items, value]; // reflected in the returned data + TM snapshot
			continue;
		}

		// UPDATE of a relation element — normalized exactly like an insert.
		// In PHP there is no such thing as an unnormalized write: every action ends in
		// component_common::set_data, which runs validate_data_element over the array
		// (:997). TS splits the actions into branches, so each branch that carries a
		// VALUE must normalize it itself, or the client's raw locator is persisted.
		// This is the branch a component_radio_button uses (build_changed_data_item
		// emits action:'update'), and it is how a bare, from_component_tipo-less
		// hierarchy4 "active" locator reached the DB — invisible to the jsonb @>
		// containment behind a portal's target_sections.
		// The dup guard compares against the OTHER items only: an update re-writing an
		// item must not be rejected as a duplicate of ITSELF (PHP rebuilds its lookup
		// map per set_data call, so the element under validation is never in it yet).
		let effectiveChange = change;
		if (column === 'relation' && change.value !== null && typeof change.value === 'object') {
			const { validateRelationInsert } = await import('../../relations/save.ts');
			const targetId = (change.value as { id?: unknown }).id ?? change.id ?? null;
			const otherItems = (items as unknown[]).filter((item) => {
				const itemId = (item as { id?: unknown } | null)?.id;
				return targetId === null || itemId === undefined || String(itemId) !== String(targetId);
			});
			const validated = await validateRelationInsert(change.value as Record<string, unknown>, {
				componentTipo,
				model,
				hostSectionTipo: sectionTipo,
				hostSectionId: sectionId,
				translatable,
				lang: effectiveLang,
				existingItems: otherItems,
				pairing: dataframePairing,
				principal: request.principal,
				// gate 2b's identity of last resort (relations/save.ts attributedUserId)
				attributedUserId: request.userId,
			});
			// PHP drops the element when validate_data_element returns false; we leave
			// the stored item untouched rather than persist a bad-formed locator.
			if (validated === null) continue;
			effectiveChange = { ...change, value: validated };
		}
		items = applyUpdate(items, effectiveChange, langSliced ? effectiveLang : null, monovalue);
	}

	// component_date SAVE override (PHP component_date::save → add_time): the
	// generic write path has no per-model date hook, so (re)compute the
	// absolute-seconds `time` on every stored item here — else v7-entered dates
	// lack the sort/range-search key and cannot be ordered. In place, so the
	// atomic-insert path (which shares these item refs) is covered too.
	if (model === 'component_date') {
		const { addTimeToDateItem } = await import('../../media/file_date.ts');
		for (const item of items) addTimeToDateItem(item);
	}

	const hasUpdates =
		changedData.some((change) => change.action === 'update') ||
		hasRemovals ||
		hasReorders ||
		hasReplacingInserts;
	// The write chokepoint (section_record/record_write.ts) merges the record's
	// modified-audit stamps (dd197/dd201) into the SAME update as the value —
	// the PHP save_component_data contract — and prunes empty columns.
	const writeTarget = { table, sectionTipo, sectionId };
	// The modified stamp rides in the SAME update as the value (the PHP
	// save_component_data contract) — unless the caller owns that metadata itself
	// (the CSV import writing dd197/dd201 from the file); see skipModifiedStamp.
	const auditStamp: { userId: number } | false =
		request.skipModifiedStamp === true ? false : { userId };

	// PHP set_data invariant (class.component_common.php:988-990): EVERY persisted
	// data item carries an id — any id-less object is stamped with a fresh
	// per-component counter id (set_data_item_counter → allocate_component_ids)
	// before the write. This is the general safety net behind the doubling fix:
	// a genuinely new append (id:null 'update', or the first toggle on an empty
	// record) gets a stable id here, so subsequent updates target it in place.
	// The atomic-insert path already allocated its ids.
	// Dataframes are NOT exempt: `id` (the entry's own counter id) and `id_key`
	// (the main item it pairs with) are different fields, and the merge stamps
	// only the latter — so an id-less frame arriving through set_data used to
	// persist without one, which the remove-by-id cascade then cannot target.
	if (hasUpdates || atomicInserts.length > 0) {
		for (const item of items) {
			if (
				item !== null &&
				typeof item === 'object' &&
				((item as { id?: unknown }).id === undefined ||
					(item as { id?: unknown }).id === null ||
					(item as { id?: unknown }).id === '')
			) {
				(item as { id: number }).id = await allocateComponentItemId(
					table,
					sectionTipo,
					sectionId,
					componentTipo,
				);
			}
		}
	}

	if (isDataframeSave) {
		// DATAFRAME write (PHP component_dataframe::set_data :187): merge the
		// caller's changed subset back over the untouched sibling frames —
		// additions get the caller's id_key stamped (INT) and legacy pairing
		// keys stripped; an empty merge normalises to null (key delete). The
		// atomic-insert fast path is bypassed: the merge IS the write.
		const { mergeCallerEntries } = await import('../../relations/dataframe.ts');
		const merged = mergeCallerEntries(
			fullSlotItems as Record<string, unknown>[],
			items as Record<string, unknown>[],
			callerDataframe,
			componentTipo,
		);
		await persistRecordKeys(
			writeTarget,
			[{ column, key: componentTipo, value: merged }],
			auditStamp,
			{ actor: userId, receipt },
		);
		items = merged ?? [];
	} else if (hasUpdates) {
		// Per-KEY write (PHP update_by_key / jsonb_set): only this component's
		// tipo key changes — sibling components untouched.
		await persistRecordKeys(
			writeTarget,
			[{ column, key: componentTipo, value: items }],
			auditStamp,
			{ actor: userId, receipt },
		);
	} else if (atomicInserts.length > 0) {
		// Pure inserts: atomic concatenation — concurrent inserts both survive.
		// (Deliberate divergence from the read-modify-write chokepoint shape.) The
		// chokepoint's APPEND entry carries every obligation of the branch: the
		// modified stamps and the derived relation_search in one UPDATE after the
		// append, then the post-write hook (the cache fan-out, the revocation seam
		// — the branch a FIRST dd244 grant takes, an `insert` onto a record that
		// carried no flag yet, i.e. exactly a promotion — the RAG index event and
		// the observer ledger). The statements live in matrix_write.ts (T2): this
		// file issues no DML.
		await persistAppendedKeyItems(writeTarget, column, componentTipo, atomicInserts, auditStamp, {
			actor: userId,
			receipt,
		});
	}

	// Post-write absorb (PHP raises the counter at EVERY set_data): explicit
	// ids in the just-written array are locked out of future allocations.
	await absorbComponentItemIds(table, sectionTipo, sectionId, componentTipo, items);

	// The batch's removes cascade now — after every change applied and the
	// component was written (see cascadeAppliedRemoves).
	await cascadeAppliedRemoves({
		model,
		table,
		sectionTipo,
		sectionId,
		componentTipo,
		userId,
		removes: appliedRemoves,
		bulkId: history.bulkId,
	});

	// relation_search ancestor index (PHP save_component_dato: for LEGACY
	// component_autocomplete_hi, the save ALSO writes relation_search[tipo] =
	// the recursive PARENT locators of every stored target). It is DERIVED by the
	// write chokepoint in the SAME UPDATE as the value (record_write.ts §3e), for
	// every branch above and for every other writer of a relation key.

	// THE SAVE'S HISTORY — TWO LANES, one of two laws (bulk_capture.ts, WC
	// …-bulk-revert-undo-log "two lanes"): under a bulk id the undo-log pairs
	// under the MAIN's tipo, one per lane touched, whatever `saveTm` says
	// (decision D1); otherwise the ordinary visible rows — the saved language's
	// value, plus the lg-nolan row (lg-nolan value + every slot's frames) when
	// the save changed it — unless the caller opted out (`saveTm: false` — PHP
	// tm_record::$save_tm). A SLOT save writes no row under the slot: it writes
	// the lg-nolan row of the main(s) it changed. Read after the cascade and the
	// relation_search write, so the images are the save's final state.
	await finishSaveHistory(history, {
		saveTm: request.saveTm !== false,
		timestamp: dbTimestamp(),
	});

	// RAG re-index event (S2-13): PHP save() enqueues the record for re-indexing
	// on every component save (class.section_record.php:988). Since P1-8
	// (2026-09-03) it is an obligation of the write chokepoint itself — every
	// branch above (persistRecordKeys, persistAppendedKeyItems) fires it from
	// afterRecordWrite — so no branch of this
	// save, and no other caller of the chokepoint, can forget it. The enqueue
	// joins this transaction (the queue writes through the ambient sql handle),
	// so a rolled-back save never leaves a marker; with RAG disabled the hook is
	// null — zero cost.

	const result: SaveResult = { ok: true, message: 'ok', data: items };
	// After the id allocation above: every new appended item now has its id.
	await attachAppendOutcome(result, appendOutcome);
	if (createdSectionId !== null) {
		result.created_section_id = createdSectionId;
	}
	// The locators this save DROPPED, for the callers that report them (the
	// observer cascade itself no longer reads this: the chokepoint's ledger
	// computes the removed set from the before-image it read under the row lock).
	// THE ONE RULE (section_record/obligation_ledger.ts removedLocators): keyed on
	// the target, dd490 frames excluded. BOTH SIDES ARE THE FULL SLOT:
	// `preSaveItems` is snapshotted before the dataframe narrowing, and on the
	// dataframe path `items` is REBOUND to `merged` before we get here.
	const removed = removedLocators(preSaveItems, items);
	if (removed.length > 0) result.removedItems = removed;
	return result;
}
