/**
 * Shared import executor — turn mapped records (from any format: CSV, MARC21,
 * RDF/Zotero) into section records. For each mapped record: create a new record
 * (or reuse a matched section_id), conform each field's value(s) through the
 * import engine, and save via the standard component save path (TM-audited).
 *
 * Reused by tool_import_marc21 / tool_import_zotero / tool_import_rdf so the
 * write path is identical to the CSV import (which is scratch-twin verified).
 *
 * THREE PROPERTIES THIS EXECUTOR OWES ITS CALLERS (P0-7, audit DATA-01/DATA-20),
 * all of which the CSV door already had and this one did not:
 *
 *   1. THE RUN IS ONE dd800 BULK PROCESS. Every TM row it writes carries that
 *      run's id, which is the ONLY thing that makes a wrong import revertable as
 *      one operation instead of row by row. The dd800 record is created BEFORE
 *      any data row is touched, ATOMICALLY (the row and its label are one
 *      transaction, so a failed label leaves no orphan), and a failure to create
 *      it REFUSES the run — an unattributable import is worse than no import. A
 *      run with NO mapped records mints nothing: there is no event to file.
 *   2. ONE TRANSACTION PER RECORD. A mid-record failure used to leave a
 *      half-written record committed; now the record's create and every one of
 *      its component saves commit or roll back together, and a failed record is
 *      reported instead of aborting (and discarding) the whole run.
 *      A CONSEQUENCE, deliberate and ledgered in the WC entry: an observer
 *      propagation failure now rolls the record back instead of being swallowed
 *      per record. Inside an ambient transaction a failed statement has already
 *      ABORTED it (observers.ts B6), so the swallow could only hide the cause
 *      and hand the record's remaining saves a poisoned transaction.
 *   4. EVERY WRITE IS ASKED OF THE WRITE DOOR (closure Step 3 req 10), as the
 *      importing principal: a matched record's field through
 *      `authorizeRecordAccess` (section floor, the dd128-aware pair — an import
 *      into dd128 must not set a user-manager's own dd1725 — and the write
 *      scope); a new record's section and every field's pair through
 *      `authorizeSectionTarget` before the create. The door the run's doors
 *      asked (the section, once) never named a record. A refused field is NOT
 *      written and is reported, like a refused value.
 *   3. THE WRITE LANGUAGE IS THE REQUEST'S. It comes from the request-language
 *      ALS (`currentDataLang()`), never from the static DEDALO_DATA_LANG: the
 *      write is lang-sliced, so the install default REPLACED the operator's
 *      actual working language and an empty cell CLEARED it. A backgrounded run
 *      keeps the session's lang because the job manager PINS the submit-time
 *      langs around the worker (media/jobs.ts JobRunScope) — a pin, not an
 *      accident of ALS inheritance.
 *   5. A DERIVED FIELD REFUSES THE RUN, before the dd800 mint and any write
 *      (assertNoDerivedField — the CSV door's posture).
 */

import { getImportAppendPolicy, isDerivedModel } from '../components/registry.ts';
import { BULK_PROCESS_TIPOS } from '../concepts/section.ts';
import { withTransaction } from '../db/postgres.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { resolveDataTipo } from '../ontology/alias.ts';
import {
	getMatrixTableFromTipo,
	getModelByTipo,
	getTranslatableByTipo,
} from '../ontology/resolver.ts';
import { currentDataLang } from '../resolve/request_lang.ts';
import { createSectionRecord } from '../section/record/create_record.ts';
import { saveComponentData } from '../section/record/save_component.ts';
import type { Principal } from '../security/permissions.ts';
import {
	authorizeRecordAccess,
	authorizeSectionTarget,
	type FrameOf,
} from '../security/write_door.ts';
import { withLiveBulkRun } from './bulk_run_registry.ts';
import { type ConformFailure, conformImportData, groupItemsByLang } from './import_data.ts';
import { isFieldWriteRefusal } from './import_field_refusal.ts';
import {
	IRI_LABEL_MODEL,
	IRI_LABEL_SLOT,
	type LabelLocks,
	type LabelledIriItem,
	labelFrame,
	labelledItemsOf,
	lockLabelTexts,
	preallocateLabelledIds,
	resolveIriLabels,
} from './import_iri_label.ts';

export interface MappedField {
	component_tipo: string;
	/** One or more flat values (multi-occurrence) to conform into this component. */
	values: string[];
}

export interface MappedRecord {
	/** Existing section_id to update, or null to create a new record. */
	sectionId: number | null;
	fields: MappedField[];
}

export interface ImportReport {
	created: number;
	updated: number;
	failed: ConformFailure[];
	/** The section_ids of records CREATED by this run (for cleanup / reporting). */
	createdIds: number[];
	/**
	 * The dd800 bulk-process record this run is attributed to. Every TM row the
	 * run wrote carries it, so `bulk_revert_process` can undo the whole import as
	 * ONE operation (audit DATA-20). Present whenever the run had anything to
	 * write — a run that refuses to mint one writes nothing at all.
	 *
	 * NULL means the run was EMPTY: no mapped records, so no data row was touched
	 * and there is nothing to attribute or revert. A dd800 minted for that would
	 * file an event that never happened in the operator's Processes list.
	 */
	bulkProcessId: number | null;
}

/**
 * The dd800 record that owns this import run — the twin of the CSV door's own
 * `createBulkProcessRecord`. Created BEFORE any data row is touched: a failure
 * here fails the RUN rather than importing unattributably. Exported for the one
 * other mapped door that writes through its own executor, tool_import_rdf's
 * ontology-driven import (tools/tool_import_rdf/server/rdf_import_execute.ts):
 * one mint, one label shape, never a second copy.
 */
export async function createBulkProcessRecord(
	sectionTipo: string,
	userId: number,
	options: { bulkLabel?: string; sourceFile?: string },
): Promise<number> {
	// ATOMIC (P0-7 review): the row and its label/file are ONE mint. Without the
	// wrap a failing label save correctly refused the run but left an ORPHAN
	// dd800 behind — an unlabelled row in the operator's Processes list,
	// attributed to nothing, that no revert will ever name.
	return await withTransaction(async () => {
		const bulkProcessId = await createSectionRecord(BULK_PROCESS_TIPOS.section, userId);
		const entries: [string, string][] = [
			[BULK_PROCESS_TIPOS.label, options.bulkLabel ?? `Mapped import into ${sectionTipo}`],
		];
		// The file name is the caller's to know (MARC21/Zotero/RDF each name their
		// own source): omitted rather than invented when the caller did not say.
		if (options.sourceFile !== undefined && options.sourceFile !== '') {
			entries.push([BULK_PROCESS_TIPOS.file, options.sourceFile]);
		}
		for (const [tipo, value] of entries) {
			await saveComponentData({
				componentTipo: tipo,
				sectionTipo: BULK_PROCESS_TIPOS.section,
				sectionId: bulkProcessId,
				lang: 'lg-nolan',
				changedData: [{ action: 'set_data', id: null, value: [{ value }] }],
				userId,
			});
		}
		return bulkProcessId;
	});
}

/** One mapped record's write, as it happened. Counters move only on a COMMIT. */
interface RecordOutcome {
	sectionId: number;
	wasCreated: boolean;
	failed: ConformFailure[];
}

/**
 * THE WRITE DOOR for one field (closure Step 3 req 10): a MATCHED record's
 * field through authorizeRecordAccess (grammar, section floor 1, the dd128-aware
 * pair, the write scope); a NEW record's field through authorizeSectionTarget
 * (the pair level — nothing references a record born in this transaction).
 * Answers the refusal sentence (IGNORED, never written) or null. Anything that
 * is not the door's refusal propagates (the record rolls back, the run reports).
 */
async function fieldRefusal(
	principal: Principal,
	sectionTipo: string,
	componentTipo: string,
	matchedId: number | null,
	frameOf?: FrameOf,
): Promise<string | null> {
	try {
		await authorizeImportField(principal, sectionTipo, componentTipo, matchedId, frameOf);
		return null;
	} catch (error) {
		if (isFieldWriteRefusal(error)) {
			return `IGNORED: not writable by the importer (${error.code}) — the field was NOT written`;
		}
		throw error;
	}
}

/** Ask the write door for one field: the section pair for a NEW record, the record door for a matched one. */
async function authorizeImportField(
	principal: Principal,
	sectionTipo: string,
	componentTipo: string,
	matchedId: number | null,
	frameOf?: FrameOf,
): Promise<void> {
	if (matchedId === null) {
		await authorizeSectionTarget(
			principal,
			{ section_tipo: sectionTipo, tipo: componentTipo },
			{ level: 2, door: 'import_execute.field', frameOf },
		);
		return;
	}
	await authorizeRecordAccess(
		principal,
		{ section_tipo: sectionTipo, component_tipo: componentTipo, section_id: matchedId },
		{ mode: 'write', level: 2, sectionFloor: 1, door: 'import_execute.field', frameOf },
	);
}

/**
 * The record a mapped record writes into: its matched id, or a NEW record —
 * asked of the write door first (the section level, consultation-capped; a
 * refusal throws and the record's transaction rolls back), then born with the
 * run's birth marker (tm_role 3) so a revert knows the run made it (D2).
 */
async function recordIdFor(
	record: MappedRecord,
	sectionTipo: string,
	principal: Principal,
	bulkProcessId: number,
): Promise<number> {
	if (record.sectionId !== null) return record.sectionId;
	await authorizeSectionTarget(
		principal,
		{ section_tipo: sectionTipo },
		{ level: 2, door: 'import_execute.create' },
	);
	return createSectionRecord(sectionTipo, principal.userId, new Date(), undefined, {
		bulkProcessId,
	});
}

/** True (and the refusal reported) when the write door refuses this field. */
async function refusedField(
	principal: Principal,
	sectionTipo: string,
	field: MappedField,
	matchedId: number | null,
	sectionId: number,
	failed: ConformFailure[],
): Promise<boolean> {
	const refusal = await fieldRefusal(principal, sectionTipo, field.component_tipo, matchedId);
	if (refusal === null) return false;
	failed.push({
		section_id: sectionId,
		data: field.values,
		component_tipo: field.component_tipo,
		msg: refusal,
	});
	return true;
}

/**
 * Write ONE mapped record. Runs inside the caller's per-record transaction, so
 * everything it does — the record create and every component save — commits or
 * rolls back together.
 */
async function writeMappedRecord(
	record: MappedRecord,
	sectionTipo: string,
	principal: Principal,
	bulkProcessId: number,
	dataLang: string,
	failed: ConformFailure[],
): Promise<RecordOutcome> {
	const wasCreated = record.sectionId === null;
	// FIRST, before the create and every field write: the record's iri label
	// locks, once each, in sorted fold order (T0-12 — no crossed-order deadlock).
	const locks = await lockRecordLabels(record, sectionTipo, dataLang);
	const sectionId = await recordIdFor(record, sectionTipo, principal, bulkProcessId);
	const userId = principal.userId;

	for (const field of record.fields) {
		if (await refusedField(principal, sectionTipo, field, record.sectionId, sectionId, failed)) {
			continue;
		}
		const model = await getModelByTipo(field.component_tipo);
		if (model === null) {
			failed.push({
				section_id: sectionId,
				data: '',
				component_tipo: field.component_tipo,
				msg: 'IGNORED: unknown component tipo',
			});
			continue;
		}
		const translatable = await getTranslatableByTipo(field.component_tipo);
		// THE REQUEST's data language, not the install default (audit DATA-01).
		const componentLang = translatable ? dataLang : 'lg-nolan';
		// Group by lang across ALL of the field's values: a lang-keyed conform
		// result (a translatable export) or v7 raw items carrying their own lang
		// must be saved ONE LANG AT A TIME — set_data is lang-sliced (PHP
		// set_data_lang), and a flat merged save would lose translations (the
		// old code even pushed a lang-keyed OBJECT as a single item).
		const groups = new Map<string, unknown[]>();
		// A REFUSED cell and an EXPLICIT EMPTY are opposite intents and must not
		// share a write. `set_data []` below is the import's CLEAR — the source
		// said "no value". A conform error says the cell was never readable, and
		// the refusal message promises the stored value was left untouched; so a
		// field with ANY refused value is not written at all. Same per-column
		// all-or-nothing the CSV executor applies (import_csv_execute.ts: an
		// errored column is skipped before any saveComponentData).
		let refused = false;
		// T0-12: the iri label intents of every value, as item references.
		const labelled: LabelledIriItem[] = [];
		for (const value of field.values) {
			const conform = await conformImportData({
				model,
				importValue: value,
				columnName: field.component_tipo,
				sectionTipo,
				sectionId,
				componentTipo: field.component_tipo,
				lang: componentLang,
			});
			if (conform.errors.length > 0) {
				failed.push(...conform.errors);
				refused = true;
				continue;
			}
			labelled.push(...labelledItemsOf(conform.result, conform.derivedFrames));
			for (const [lang, items] of groupItemsByLang(conform.result, componentLang)) {
				const group = groups.get(lang);
				if (group === undefined) groups.set(lang, [...items]);
				else group.push(...items);
			}
		}
		if (refused) {
			// The dropped-siblings line: a multi-occurrence field whose other
			// values DID conform is still not written, so say so — silence here
			// would read as "only the bad one was skipped".
			if (groups.size > 0) {
				failed.push({
					section_id: sectionId,
					data: field.values,
					component_tipo: field.component_tipo,
					msg: 'IGNORED: the field was NOT written — one of its values was refused, so the record keeps its stored value',
				});
			}
			continue;
		}
		if (groups.size === 0) groups.set(componentLang, []);
		const labels = await prepareFieldLabels(
			{
				principal,
				sectionTipo,
				sectionId,
				matchedId: record.sectionId,
				bulkProcessId,
				field,
				locks,
			},
			groups,
			labelled,
		);
		if (labels.refusal !== null) {
			failed.push({
				section_id: sectionId,
				data: field.values,
				component_tipo: field.component_tipo,
				msg: labels.refusal,
			});
			continue;
		}
		const mainRefusals = await saveFieldGroups(labels.groups, {
			field,
			sectionTipo,
			sectionId,
			userId,
			bulkProcessId,
			failed,
		});
		// A refused main save of a LABELLED field throws inside: the record rolls back.
		await writeFieldLabelFrames(labels, mainRefusals, {
			sectionTipo,
			sectionId,
			bulkProcessId,
			principal,
		});
	}
	return { sectionId, wasCreated, failed };
}

/**
 * Save one field's lang groups, one set_data per lang. A REFUSED save is a
 * per-field failure, never a silent no-op: the write engine answers
 * `{ok:false, message}` for a refusal it wants the caller to show (ONT-TLD,
 * consultation-only, dataframe pairing …); discarding it reported "N updated,
 * 0 failed" for a run that wrote nothing, which is the one outcome an importer
 * must never produce. Answers the refusal messages ([] = EVERY lang saved).
 */
async function saveFieldGroups(
	groups: ReadonlyMap<string, unknown[]>,
	target: {
		field: MappedField;
		sectionTipo: string;
		sectionId: number;
		userId: number;
		bulkProcessId: number;
		failed: ConformFailure[];
	},
): Promise<string[]> {
	const refusals: string[] = [];
	for (const [lang, items] of groups) {
		const outcome = await saveComponentData({
			componentTipo: target.field.component_tipo,
			sectionTipo: target.sectionTipo,
			sectionId: target.sectionId,
			lang,
			changedData: [{ action: 'set_data', id: null, value: items }],
			userId: target.userId,
			// The run's attribution: without it the TM rows land with a NULL
			// bulk_process_id and the import cannot be reverted as one operation.
			bulkProcessId: target.bulkProcessId,
		});
		if (outcome.ok === false) {
			target.failed.push({
				section_id: target.sectionId,
				data: items,
				component_tipo: target.field.component_tipo,
				msg: `IGNORED: ${outcome.message}`,
			});
			refusals.push(`${lang}: ${outcome.message}`);
		}
	}
	return refusals;
}

// ---------------------------------------------------------------------------
// component_iri LABELS (T0-12) — the mapped door's half of the CSV executor's
// rule (import_csv_execute.ts writeLabelledIriColumn): the labels are resolved
// inside the record's transaction (import_iri_label.ts), the labelled items'
// ids pre-allocated, and one dd560 frame written per labelled item.
// ---------------------------------------------------------------------------

/**
 * The record's iri label locks, BEFORE its first write (import_iri_label.ts
 * `lockLabelTexts`): every value of every `component_iri` field conformed once
 * more (conform is pure — the main pass reports its errors, this one only reads
 * the label intents), the texts locked once each in sorted fold order. A field
 * later refused only locks a label it does not use.
 */
async function lockRecordLabels(
	record: MappedRecord,
	sectionTipo: string,
	dataLang: string,
): Promise<LabelLocks> {
	const labelled: LabelledIriItem[] = [];
	for (const field of record.fields) {
		const model = await getModelByTipo(field.component_tipo);
		if (model !== IRI_LABEL_MODEL) continue;
		for (const importValue of field.values) {
			const conform = await conformImportData({
				model,
				importValue,
				columnName: field.component_tipo,
				sectionTipo,
				sectionId: record.sectionId ?? 0,
				componentTipo: field.component_tipo,
				lang: dataLang,
			});
			if (conform.errors.length > 0) continue; // the main pass refuses the field
			labelled.push(...labelledItemsOf(conform.result, conform.derivedFrames));
		}
	}
	return lockLabelTexts(labelled);
}

/** What a field's label step needs of the record being written. */
interface FieldLabelScope {
	principal: Principal;
	sectionTipo: string;
	sectionId: number;
	/** The matched record id (null = a record this run created). */
	matchedId: number | null;
	bulkProcessId: number;
	field: MappedField;
	/** The record's iri label locks, taken before its first write (`lockRecordLabels`). */
	locks: LabelLocks;
}

/** A field's groups to save, and the frames to write after them — or why the field is refused. */
interface FieldLabels {
	groups: Map<string, unknown[]>;
	/** The main data tipo the frames pair with (an alias's target). */
	mainTipo: string;
	pairings: { idKey: number; labelId: number }[];
	refusal: string | null;
}

/**
 * The label step of one field: nothing to do without labels. Otherwise the
 * label slot is asked of the write door (paired with its main, T0-4), the
 * labels resolved (a refusal — unknown label id, a label the importer may not
 * create — refuses the FIELD: nothing written, never an iri label-less) and
 * every labelled item's FINAL id pre-allocated in the transaction.
 */
async function prepareFieldLabels(
	scope: FieldLabelScope,
	groups: Map<string, unknown[]>,
	labelled: readonly LabelledIriItem[],
): Promise<FieldLabels> {
	const componentTipo = scope.field.component_tipo;
	const mainTipo = await resolveDataTipo(componentTipo);
	const unchanged: FieldLabels = { groups, mainTipo, pairings: [], refusal: null };
	if (labelled.length === 0) return unchanged;
	const doorRefusal = await fieldRefusal(
		scope.principal,
		scope.sectionTipo,
		IRI_LABEL_SLOT,
		scope.matchedId,
		{ mainTipo },
	);
	if (doorRefusal !== null) return { ...unchanged, refusal: doorRefusal };
	const resolution = await resolveIriLabels(labelled, {
		principal: scope.principal,
		userId: scope.principal.userId,
		bulkProcessId: scope.bulkProcessId,
		componentTipo,
		locks: scope.locks,
	});
	if (!resolution.ok) return { ...unchanged, refusal: resolution.refusal };
	const table = await getMatrixTableFromTipo(scope.sectionTipo);
	if (table === null) {
		throw new DedaloError('request.invalid_tipo', {
			message: `no matrix table for section '${scope.sectionTipo}'`,
			coordinates: { section_tipo: scope.sectionTipo },
		});
	}
	const prepared = await preallocateLabelledIds(groups, labelled, {
		table,
		sectionTipo: scope.sectionTipo,
		sectionId: scope.sectionId,
		dataTipo: mainTipo,
	});
	const pairings = labelled.map(({ item }) => ({
		idKey: prepared.idOf.get(item) as number,
		labelId: resolution.labelOf.get(item) as number,
	}));
	return { groups: prepared.groups, mainTipo, pairings, refusal: null };
}

/**
 * One dd560 save per labelled item, with the caller pairing: the paired merge
 * replaces THAT item's frames only. A refused frame save THROWS — the record's
 * transaction rolls back rather than keep an iri whose label was dropped.
 *
 * A LABELLED field whose main save was refused (any lang) THROWS too, before a
 * frame is written: the labels it may have CREATED and the lang slices that
 * DID save would otherwise commit without their frames (an orphan label, a
 * frameless iri). The record's transaction rolls it all back and the run
 * reports the record as not written, naming the refusal. An unlabelled field
 * keeps the per-field failure line (`mainRefusals` already pushed it).
 */
async function writeFieldLabelFrames(
	labels: FieldLabels,
	mainRefusals: readonly string[],
	record: { sectionTipo: string; sectionId: number; bulkProcessId: number; principal: Principal },
): Promise<void> {
	if (labels.pairings.length === 0) return;
	if (mainRefusals.length > 0) {
		throw new DedaloError('record.save_failed', {
			message: `the labelled iri field '${labels.mainTipo}' was refused (${mainRefusals.join('; ')}) — the record is rolled back with its labels and frames`,
			coordinates: { section_tipo: record.sectionTipo, tipo: labels.mainTipo },
		});
	}
	for (const { idKey, labelId } of labels.pairings) {
		const outcome = await saveComponentData({
			componentTipo: IRI_LABEL_SLOT,
			sectionTipo: record.sectionTipo,
			sectionId: record.sectionId,
			lang: 'lg-nolan',
			changedData: [{ action: 'set_data', id: null, value: [labelFrame(labelId)] }],
			callerDataframe: { main_component_tipo: labels.mainTipo, id_key: idKey },
			userId: record.principal.userId,
			bulkProcessId: record.bulkProcessId,
		});
		if (outcome.ok === false) {
			throw new DedaloError('record.save_failed', {
				message: `iri label frame refused for '${labels.mainTipo}' item ${idKey}: ${outcome.message}`,
				coordinates: { tipo: IRI_LABEL_SLOT },
			});
		}
	}
}

/**
 * 5. A DERIVED COMPONENT IS NEVER AN IMPORT TARGET (descriptor `derived`,
 * registry isDerivedModel — the twin of tool_import_dedalo_csv's column
 * refusal and import_csv_execute's backstop). A derived model owns no stored
 * value: a set_data on it would write bytes no read serves (component_inverse,
 * component_relation_index, component_external) or, for
 * component_relation_children, RE-PARENT records through the write-through from
 * a mapped cell. The whole run is refused — typed (`request.invalid_data`),
 * naming the field, its model and what to import instead — before the dd800
 * mint and before any record is touched. Checked on the field tipo AND its
 * data tipo (a component_alias onto a derived target is the same write).
 */
async function assertNoDerivedField(
	records: readonly MappedRecord[],
	sectionTipo: string,
): Promise<void> {
	const tipos = new Set(records.flatMap((record) => record.fields.map((f) => f.component_tipo)));
	for (const tipo of tipos) {
		const dataTipo = await resolveDataTipo(tipo);
		for (const candidate of new Set([tipo, dataTipo])) {
			const model = await getModelByTipo(candidate);
			if (model === null || !isDerivedModel(model)) continue;
			const policy = getImportAppendPolicy(model);
			const instead = typeof policy === 'object' ? ` — ${policy.refuse}` : '';
			throw new DedaloError('request.invalid_data', {
				message: `mapped import refused: field '${tipo}' (${model}) is derived — computed, nothing stored to import${instead}`,
				publicMessage: `Import refused: field '${tipo}' (${model}) is derived — computed, nothing stored to import${instead}`,
				coordinates: { section_tipo: sectionTipo, tipo },
			});
		}
	}
}

/**
 * Execute an import of mapped records into `sectionTipo`. Creates a record per
 * mapped record when sectionId is null. Each field's flat values are conformed
 * (wrapping into {value} items for value-property models) and merged into a single
 * set_data. Per-field failures are collected, never aborting the run.
 *
 * `options` is how a door names its run in the dd800 Processes list; it is
 * optional so the existing MARC21/Zotero/RDF call sites keep working, and the
 * bulk process is created either way.
 */
export async function importMappedRecords(
	records: readonly MappedRecord[],
	sectionTipo: string,
	principal: Principal,
	options: { bulkLabel?: string; sourceFile?: string } = {},
): Promise<ImportReport> {
	const userId = principal.userId;
	let created = 0;
	let updated = 0;
	const failed: ConformFailure[] = [];
	const createdIds: number[] = [];

	// NOTHING TO WRITE, NOTHING TO ATTRIBUTE (P0-7 review). Every caller can reach
	// here with an empty mapped set — a MARC21 batch whose every staged file
	// failed to parse, a Zotero/RDF export with no subjects, a map that matched no
	// column — and each of them already reports its own parse errors. Minting a
	// dd800 for that files an event that never happened in the operator's
	// Processes list, and it is the one dd800 no revert can ever be about.
	if (records.length === 0) {
		return { created, updated, failed, createdIds, bulkProcessId: null };
	}

	// DERIVED FIELDS ARE REFUSED, THE RUN BEFORE ANY WRITE (the CSV door's
	// posture). Ahead of the dd800 mint, so a refused run files no event.
	await assertNoDerivedField(records, sectionTipo);

	// REFUSE rather than proceed: a throw here reaches the caller before a single
	// data row is touched, which is the whole point of creating it first.
	const bulkProcessId = await createBulkProcessRecord(sectionTipo, userId, options);

	// Resolved ONCE for the run, outside the per-record transactions: every row of
	// one import belongs to one operator's working language, and a mid-run change
	// would split the file across two language slices.
	const dataLang = currentDataLang();

	// The run is held in the active-run registry while it writes: a revert of it
	// is refused until it ends (decision D5).
	await withLiveBulkRun(bulkProcessId, async () => {
		for (const record of records) {
			// The record's issues, kept OUTSIDE its transaction: a rolled-back record
			// still reports them next to the rollback line.
			const recordFailed: ConformFailure[] = [];
			try {
				// ONE TRANSACTION PER RECORD (the CSV door's posture): a failure part-way
				// through a record leaves NO half-written record behind.
				const outcome = await withTransaction(() =>
					writeMappedRecord(record, sectionTipo, principal, bulkProcessId, dataLang, recordFailed),
				);
				if (outcome.wasCreated) {
					created += 1;
					createdIds.push(outcome.sectionId);
				} else {
					updated += 1;
				}
				failed.push(...outcome.failed);
			} catch (error) {
				// The row is rolled back, so the run continues and REPORTS it — an engine
				// fault used to escape here and discard the whole report, `createdIds`
				// included, leaving the operator with records they could not find.
				failed.push({
					section_id: record.sectionId ?? 0,
					data: '',
					component_tipo: sectionTipo,
					msg: `IGNORED: the record was not written — ${error instanceof Error ? error.message : String(error)}`,
				});
				// …and the record's OTHER issues (a conform refusal of another field …),
				// addressed like the rollback line: a created id was rolled back with it.
				for (const issue of recordFailed) {
					failed.push({ ...issue, section_id: record.sectionId ?? 0 });
				}
			}
		}
	});
	return { created, updated, failed, createdIds, bulkProcessId };
}
