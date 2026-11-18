/**
 * Shared import executor — turn mapped records (from any format: MARC21,
 * Zotero CSL-JSON, RDF) into section records. For each mapped record: create a new record
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
 *   6. A RECORD IS ADDRESSED BY ID FOR ONE NAMED DOOR ONLY (`MappedRecord.address`,
 *      owner ruling 2026-11-17 — the Zotero call-number). Every other door's
 *      identifier is a CODE looked up by import_code_lookup.ts (audit DATA-08);
 *      an address from a door whose tool does not DECLARE it
 *      (`ToolServerModule.operatorAddressActions`) refuses the run before the
 *      dd800 mint (assertAddressDoor; gate marc_identity_native).
 *      ADDRESSED RECORDS ARE WRITTEN FIRST, highest id first (`writeOrder`), so
 *      the run's own counter allocations can never take an id the file names;
 *      the report keeps the input order. A record ALREADY LIVING at an address is asked of the
 *      record door before anything of it is read (`livingRecordRefusal`).
 */

import { getImportAppendPolicy, isDerivedModel } from '../components/registry.ts';
import { BULK_PROCESS_TIPOS } from '../concepts/section.ts';
import { readExistingSectionIds } from '../db/matrix.ts';
import { withTransaction } from '../db/postgres.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { isDedaloError } from '../errors/index.ts';
import type { ErrorCode } from '../errors/registry.ts';
import { resolveDataTipo } from '../ontology/alias.ts';
import {
	getMatrixTableFromTipo,
	getModelByTipo,
	getTranslatableByTipo,
} from '../ontology/resolver.ts';
import { currentDataLang } from '../resolve/request_lang.ts';
import { bornInCurrentTransaction, createSectionRecord } from '../section/record/create_record.ts';
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
import { lockLinkNames, resolveLinkFields } from './import_link.ts';

export interface MappedField {
	component_tipo: string;
	/** One or more flat values (multi-occurrence) to conform into this component. */
	values: string[];
	/**
	 * The values are TEXT taken from a source format that has no cell grammar
	 * (MARC21): conform reads them as text, never as a JSON/CSV cell — a MARC
	 * '[1987]' is a bracketed inferred date, not the number 1987. Absent = a cell.
	 */
	literal?: boolean;
	/**
	 * The mapper already refused the value (a MARC transform that produced
	 * nothing storable): reported as IGNORED, never written. Absent = none.
	 */
	refusal?: string;
}

/**
 * A LINK: the record of `target.sectionTipo` whose name component
 * (`target.componentTipo`) holds exactly `text` — found, else CREATED with that
 * name — stored as a locator in `component_tipo` (Zotero container-title →
 * Series). Resolved INSIDE the record's transaction (import_link.ts): a created
 * name record carries the run's birth marker and rolls back with its record.
 */
export interface LinkField {
	component_tipo: string;
	target: { sectionTipo: string; componentTipo: string };
	text: string;
}

/**
 * AN OPERATOR-CHOSEN RECORD ADDRESS (owner ruling 2026-11-17): the section_id
 * the source file itself names for the record. THE NAMED EXCEPTION to the law
 * that an imported identifier is a code, never an address (audit DATA-08,
 * import_code_lookup.ts) — for the doors whose tool declares it
 * (`ToolServerModule.operatorAddressActions`, module.ts) only: Zotero has no
 * editable id, so the cataloguer writes it in `call-number`.
 */
export interface RecordAddress {
	/** The section_id: a canonical positive int4 (the door validated the text). */
	sectionId: number;
	/**
	 * Asked INSIDE the record's transaction when a record ALREADY LIVES at the
	 * address (this write did not bear it), before any field is written — and
	 * only of a record the importer MAY WRITE (the record door is asked first,
	 * so this guard never reads a record outside the importer's scope): the
	 * refusal sentence, or null to write into it. A refusal rolls the record
	 * back and is reported as `RecordResult.refusal` (`resource.conflict`) — not
	 * a `failed` line.
	 */
	refusalFor?: (existing: {
		table: string;
		sectionTipo: string;
		sectionId: number;
	}) => Promise<string | null>;
}

/**
 * Why the record living at an `address` was not written into: the record door's
 * own refusal (`perm.*` — a record outside the importer's scope) or the door's
 * guard (`resource.conflict`, {@link RecordAddress.refusalFor}).
 */
export interface RecordRefusal {
	code: ErrorCode;
	message: string;
}

/** The largest section_id a matrix row can hold (Postgres int4). */
const MAX_SECTION_ID = 2147483647;

export interface MappedRecord {
	/** Existing section_id to update, or null to create a new record. */
	sectionId: number | null;
	/**
	 * Write AT this id instead: the record living there is updated, an absent
	 * one is CREATED at it (the counter raised with GREATEST). Requires
	 * `sectionId: null` and a run that names its `addressDoor`.
	 */
	address?: RecordAddress;
	fields: MappedField[];
	/** Links resolved in the record's transaction (absent = none). */
	links?: LinkField[];
}

/** What happened to one input record, in input order. */
export interface RecordResult {
	/** The record's index in the `records` the run was given. */
	index: number;
	/** The committed record id, or null when its transaction rolled back. */
	sectionId: number | null;
	/** True when the committed record was BORN by this run (false: updated, or rolled back). */
	created: boolean;
	/**
	 * Why the record living at its `address` was not written into — the record
	 * door's refusal or `RecordAddress.refusalFor`'s; the record rolled back.
	 * Absent for every other outcome.
	 */
	refusal?: RecordRefusal;
}

export interface ImportReport {
	created: number;
	updated: number;
	failed: ConformFailure[];
	/** The section_ids of records CREATED by this run (for cleanup / reporting). */
	createdIds: number[];
	/**
	 * Every input record's outcome, in input order — what a door that acts on a
	 * record AFTER it committed (Zotero's PDF attachments) needs to address it.
	 */
	records: RecordResult[];
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

/** Where one mapped record is written. */
interface RecordTarget {
	sectionId: number;
	/** The record this write found (null = a record this write CREATED). */
	matchedId: number | null;
}

/** One record's issues, kept OUTSIDE its transaction (a rolled-back record still reports them). */
interface RecordIssues {
	failed: ConformFailure[];
	/** Set when the record living at its address refused the write (`livingRecordRefusal`). */
	refusal: RecordRefusal | null;
}

/** THE WRITE DOOR for a create: the section level, consultation-capped. A refusal throws. */
async function authorizeCreate(principal: Principal, sectionTipo: string): Promise<void> {
	await authorizeSectionTarget(
		principal,
		{ section_tipo: sectionTipo },
		{ level: 2, door: 'import_execute.create' },
	);
}

/**
 * The record a mapped record writes into: the one at its ADDRESS, its matched
 * id, or a NEW record — asked of the write door first (a refusal throws and the
 * record's transaction rolls back), then born with the run's birth marker
 * (tm_role 3) so a revert knows the run made it (D2).
 */
async function recordTargetFor(
	record: MappedRecord,
	sectionTipo: string,
	principal: Principal,
	bulkProcessId: number,
	issues: RecordIssues,
): Promise<RecordTarget> {
	if (record.address !== undefined) {
		return addressedTarget(record.address, sectionTipo, principal, bulkProcessId, issues);
	}
	if (record.sectionId !== null) {
		return { sectionId: record.sectionId, matchedId: record.sectionId };
	}
	await authorizeCreate(principal, sectionTipo);
	const sectionId = await createSectionRecord(
		sectionTipo,
		principal.userId,
		new Date(),
		undefined,
		{
			bulkProcessId,
		},
	);
	return { sectionId, matchedId: null };
}

/**
 * The record at an operator-chosen ADDRESS (`RecordAddress`). Decided INSIDE
 * the record's transaction, on what is true when it is written:
 *
 *  - NO record there (never one, or DELETED — a re-import after an error is a
 *    legitimate use) → CREATED at the id through the engine's explicit-id
 *    insert, after the create door. The counter rises with GREATEST; an address
 *    carrying a dead record's history opens a new generation epoch
 *    (createSectionRecord).
 *  - A record there — including one a concurrent writer bore since the door
 *    looked (the conflict-tolerant insert is then a no-op,
 *    `bornInCurrentTransaction` says so; never an earlier record of THIS run:
 *    `writeOrder`) → {@link livingRecordRefusal}: the record door, then
 *    `refusalFor`. Admitted, it is written as a MATCHED record: every field
 *    passes the record door (scope, the dd128-aware pair), never the create grant.
 */
async function addressedTarget(
	address: RecordAddress,
	sectionTipo: string,
	principal: Principal,
	bulkProcessId: number,
	issues: RecordIssues,
): Promise<RecordTarget> {
	const sectionId = address.sectionId;
	const table = await matrixTableOf(sectionTipo);
	const existed = (await readExistingSectionIds(table, sectionTipo, [sectionId])).has(sectionId);
	if (
		!existed &&
		(await createAtAddress(table, sectionTipo, sectionId, principal, bulkProcessId))
	) {
		return { sectionId, matchedId: null };
	}
	const refusal = await livingRecordRefusal(address, { table, sectionTipo, sectionId }, principal);
	if (refusal !== null) {
		issues.refusal = refusal;
		// Thrown to roll the record's transaction back; reported from `issues`.
		throw new DedaloError(refusal.code, {
			message: refusal.message,
			publicMessage: refusal.message,
			coordinates: { section_tipo: sectionTipo, section_id: sectionId },
		});
	}
	return { sectionId, matchedId: sectionId };
}

/**
 * Why the record ALREADY LIVING at an address is not written into, or null.
 *
 * THE RECORD DOOR FIRST: an address reaches ANY id of the section — unlike the
 * code lookup, which only ever finds records in the importer's scope — so the
 * record is asked as a write target (section floor, the dd128-aware section
 * pair, the write scope) before the door's guard reads anything of it. A record
 * the importer may not write is REFUSED as an item — never "updated" with every
 * field ignored — and the guard's sentence (which tells whether the record
 * holds a key) is never built for it. Then the door's own guard (`refusalFor`).
 */
async function livingRecordRefusal(
	address: RecordAddress,
	existing: { table: string; sectionTipo: string; sectionId: number },
	principal: Principal,
): Promise<RecordRefusal | null> {
	const denied = await recordDoorRefusal(principal, existing.sectionTipo, existing.sectionId);
	if (denied !== null) return denied;
	const conflict = (await address.refusalFor?.(existing)) ?? null;
	return conflict === null ? null : { code: 'resource.conflict', message: conflict };
}

/**
 * THE WRITE DOOR for the record at an address, as a whole: the level every
 * field write presupposes (section floor 1 — each field then needs its own
 * pair at 2) and the write scope. Answers the door's `perm.*` refusal, or null;
 * anything else propagates (the record rolls back, the run reports it).
 */
async function recordDoorRefusal(
	principal: Principal,
	sectionTipo: string,
	sectionId: number,
): Promise<RecordRefusal | null> {
	try {
		await authorizeRecordAccess(
			principal,
			{ section_tipo: sectionTipo, section_id: sectionId },
			{ mode: 'write', level: 1, sectionFloor: 1, door: 'import_execute.address' },
		);
		return null;
	} catch (error) {
		if (!isDedaloError(error) || !error.code.startsWith('perm.')) throw error;
		return {
			code: error.code,
			message: `record ${sectionId} exists and is not writable by the importer (${error.code}) — nothing was written into it`,
		};
	}
}

/** Create the record AT `sectionId`; true when THIS transaction bore it (false: someone else's). */
async function createAtAddress(
	table: string,
	sectionTipo: string,
	sectionId: number,
	principal: Principal,
	bulkProcessId: number,
): Promise<boolean> {
	await authorizeCreate(principal, sectionTipo);
	// conflictTolerant: the id may have been taken since the existence read; the
	// insert is then a no-op and writes no birth marker (the CSV door's posture).
	await createSectionRecord(sectionTipo, principal.userId, new Date(), sectionId, {
		conflictTolerant: true,
		bulkProcessId,
	});
	return bornInCurrentTransaction(table, sectionTipo, sectionId);
}

/** The section's matrix table, or the refusal of a section that has none. */
async function matrixTableOf(sectionTipo: string): Promise<string> {
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === null) {
		throw new DedaloError('request.invalid_tipo', {
			message: `no matrix table for section '${sectionTipo}'`,
			coordinates: { section_tipo: sectionTipo },
		});
	}
	return table;
}

/** True (and the refusal reported) when the MAPPER refused this field's value. */
function mapperRefused(field: MappedField, sectionId: number, failed: ConformFailure[]): boolean {
	if (field.refusal === undefined) return false;
	failed.push({
		section_id: sectionId,
		data: field.values,
		component_tipo: field.component_tipo,
		msg: `IGNORED: ${field.refusal} — the field was NOT written`,
	});
	return true;
}

/**
 * True (and the refusal reported) when this field is not written: the MAPPER
 * already refused its value, or the write door refuses the field.
 */
async function refusedField(
	principal: Principal,
	sectionTipo: string,
	field: MappedField,
	matchedId: number | null,
	sectionId: number,
	failed: ConformFailure[],
): Promise<boolean> {
	if (mapperRefused(field, sectionId, failed)) return true;
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
	issues: RecordIssues,
): Promise<RecordOutcome> {
	const failed = issues.failed;
	// FIRST, before the create and every field write: the record's iri label
	// locks, once each, in sorted fold order (T0-12 — no crossed-order deadlock),
	// THEN its link-name locks, sorted too. One global order (labels, then
	// links, then records) leaves no cycle between two records of two runs.
	const locks = await lockRecordLabels(record, sectionTipo, dataLang);
	await lockRecordLinks(record);
	const written = await recordTargetFor(record, sectionTipo, principal, bulkProcessId, issues);
	const { sectionId, matchedId } = written;
	const wasCreated = matchedId === null;
	const userId = principal.userId;
	const linkFields = await recordLinkFields(record, {
		principal,
		sectionTipo,
		sectionId,
		matchedId,
		bulkProcessId,
		dataLang,
		failed,
	});

	for (const field of [...record.fields, ...linkFields]) {
		if (await refusedField(principal, sectionTipo, field, matchedId, sectionId, failed)) {
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
				literal: field.literal,
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
				matchedId,
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

/** The record's link-name locks (import_link.ts), after its label locks. */
async function lockRecordLinks(record: MappedRecord): Promise<void> {
	await lockLinkNames(record.links ?? []);
}

/**
 * The record's LINKS as mapped fields (import_link.ts): each link's component
 * asked of the write door first, then its record found or created inside this
 * transaction. A refused link is reported on the record and writes nothing.
 */
async function recordLinkFields(
	record: MappedRecord,
	target: {
		principal: Principal;
		sectionTipo: string;
		sectionId: number;
		/** The record this write found (null = one it created). */
		matchedId: number | null;
		bulkProcessId: number;
		dataLang: string;
		failed: ConformFailure[];
	},
): Promise<MappedField[]> {
	const { principal, sectionTipo, sectionId } = target;
	const scope = {
		principal,
		bulkProcessId: target.bulkProcessId,
		dataLang: target.dataLang,
		fieldRefusal: (componentTipo: string) =>
			fieldRefusal(principal, sectionTipo, componentTipo, target.matchedId),
	};
	return resolveLinkFields(record.links ?? [], scope, (line) =>
		target.failed.push({ ...line, section_id: sectionId }),
	);
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
				sectionId: addressOf(record) ?? 0,
				componentTipo: field.component_tipo,
				lang: dataLang,
				literal: field.literal,
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

/** The id a mapped record names before it is written: its address, else its matched id. */
function addressOf(record: MappedRecord): number | null {
	return record.address?.sectionId ?? record.sectionId;
}

/** True when `sectionId` can be a matrix row's id: a positive int4. */
function isRecordNumber(sectionId: number): boolean {
	return Number.isInteger(sectionId) && sectionId >= 1 && sectionId <= MAX_SECTION_ID;
}

/**
 * Why `addressDoor` ('<tool>.<action>') may address a record by id: the reason
 * its OWN tool declares (`ToolServerModule.operatorAddressActions`), or null.
 * Core names no tool here (core_tool_edge_tripwire): the exception is declared
 * by the door that has it, validated at load, and the declaring set is pinned
 * by marc_identity_native. The loader is a DYNAMIC edge (it imports every tool,
 * and the import tools import this module — import_scc_tripwire).
 */
async function addressDoorReason(addressDoor: string | undefined): Promise<string | null> {
	const [toolName, action] = (addressDoor ?? '').split('.');
	if (toolName === undefined || action === undefined) return null;
	const { getLoadedTool } = await import('./loader.ts');
	const loaded = await getLoadedTool(toolName);
	return loaded?.module.operatorAddressActions?.[action] ?? null;
}

/**
 * 6. AN ADDRESS IS ONE NAMED DOOR'S (header). Any record carrying
 * `MappedRecord.address` refuses the RUN — `internal.invariant`, before the
 * dd800 mint and any write — unless the run names a door whose tool declares
 * the capability ({@link addressDoorReason}), the address is a positive int4
 * (the backstop of the door's own text check) and the record names no OTHER
 * id. A door that maps an external identifier (MARC21's control number) can
 * therefore never reach a record by id: it would have to build an address,
 * name itself here AND declare the capability in its own module.
 */
async function assertAddressDoor(
	records: readonly MappedRecord[],
	addressDoor: string | undefined,
): Promise<void> {
	const addressed = records.filter((record) => record.address !== undefined);
	if (addressed.length === 0) return;
	if ((await addressDoorReason(addressDoor)) === null) {
		throw new DedaloError('internal.invariant', {
			message: `mapped import refused: ${addressed.length} record(s) carry an operator-chosen address, but '${addressDoor ?? '(no door named)'}' is not a door that may address a record by id (its tool declares no operatorAddressActions entry for it) — an imported identifier is a code, never an address`,
		});
	}
	const malformed = addressed.find(
		(record) => record.sectionId !== null || !isRecordNumber(record.address?.sectionId ?? 0),
	);
	if (malformed !== undefined) {
		throw new DedaloError('internal.invariant', {
			message: `mapped import refused: an address must be a positive int4 on a record that names no other id (got address ${malformed.address?.sectionId}, sectionId ${malformed.sectionId})`,
		});
	}
}

/**
 * Report a record whose transaction rolled back. The row is rolled back, so the
 * run continues and REPORTS it — an engine fault used to escape here and discard
 * the whole report, `createdIds` included, leaving the operator with records
 * they could not find.
 */
function reportRolledBackRecord(
	failed: ConformFailure[],
	record: MappedRecord,
	sectionTipo: string,
	error: unknown,
	recordFailed: readonly ConformFailure[],
): void {
	const sectionId = addressOf(record) ?? 0;
	failed.push({
		section_id: sectionId,
		data: '',
		component_tipo: sectionTipo,
		msg: `IGNORED: the record was not written — ${error instanceof Error ? error.message : String(error)}`,
	});
	// …and the record's OTHER issues (a conform refusal of another field …),
	// addressed like the rollback line: a created id was rolled back with it.
	for (const issue of recordFailed) {
		failed.push({ ...issue, section_id: sectionId });
	}
}

/**
 * A record that was NOT written: refused by its address (the reason goes on its
 * `RecordResult` — the door reports it, typed, once) or rolled back by anything
 * else (a `failed` line, with the record's other issues).
 */
function reportUnwrittenRecord(
	result: RecordResult,
	failed: ConformFailure[],
	unwritten: { record: MappedRecord; sectionTipo: string; error: unknown; issues: RecordIssues },
): void {
	const { record, sectionTipo, error, issues } = unwritten;
	if (issues.refusal !== null) {
		result.refusal = issues.refusal;
		return;
	}
	reportRolledBackRecord(failed, record, sectionTipo, error, issues.failed);
}

/** What every record of one run is written with. */
interface RunScope {
	sectionTipo: string;
	principal: Principal;
	bulkProcessId: number;
	dataLang: string;
}

/** One input record as the run left it: its outcome and its report lines. */
interface WrittenRecord {
	result: RecordResult;
	failed: ConformFailure[];
}

/**
 * THE ORDER THE RECORDS ARE WRITTEN IN (input indexes): every ADDRESSED record
 * first, HIGHEST address first, then the rest in input order.
 *
 * Whatever the run allocates takes the section counter's next id: an
 * unaddressed record, and a record a LINK creates when its target is the
 * section imported into. Written in input order, such a record could be born
 * at the very id a LATER record of the same file names — an id that was free
 * when the run began. The later record then found "a record there": refused
 * when that record held a key (rule 3 says it is created there), and ADOPTED
 * when it held none — two references merged into one record, reported as an
 * update. The explicit-id insert raises the counter (GREATEST) to its id, so
 * once the HIGHEST address is written every allocation of the run lands beyond
 * every id the file names. A door without addresses (MARC21, RDF) keeps the
 * input order exactly.
 *
 * An addressed record that ROLLS BACK leaves its id free, and a later
 * allocation may take it: the item is then reported as not written, and no
 * reference is merged into another.
 */
function writeOrder(records: readonly MappedRecord[]): number[] {
	const addressed: { index: number; sectionId: number }[] = [];
	const rest: number[] = [];
	for (const [index, record] of records.entries()) {
		if (record.address === undefined) rest.push(index);
		else addressed.push({ index, sectionId: record.address.sectionId });
	}
	addressed.sort((a, b) => b.sectionId - a.sectionId);
	return [...addressed.map((entry) => entry.index), ...rest];
}

/**
 * ONE TRANSACTION PER RECORD (the CSV door's posture): a failure part-way
 * through a record leaves NO half-written record behind, and the run goes on.
 */
async function writeInOwnTransaction(
	record: MappedRecord,
	index: number,
	run: RunScope,
): Promise<WrittenRecord> {
	// The record's issues, kept OUTSIDE its transaction: a rolled-back record
	// still reports them next to the rollback line.
	const issues: RecordIssues = { failed: [], refusal: null };
	const result: RecordResult = { index, sectionId: null, created: false };
	const failed: ConformFailure[] = [];
	const { sectionTipo, principal, bulkProcessId, dataLang } = run;
	try {
		const outcome = await withTransaction(() =>
			writeMappedRecord(record, sectionTipo, principal, bulkProcessId, dataLang, issues),
		);
		result.sectionId = outcome.sectionId;
		result.created = outcome.wasCreated;
		failed.push(...outcome.failed);
	} catch (error) {
		reportUnwrittenRecord(result, failed, { record, sectionTipo, error, issues });
	}
	return { result, failed };
}

/**
 * Execute an import of mapped records into `sectionTipo`. Creates a record per
 * mapped record when sectionId is null. Each field's flat values are conformed
 * (wrapping into {value} items for value-property models) and merged into a single
 * set_data. Per-field failures are collected, never aborting the run.
 *
 * `options` is how a door names its run in the dd800 Processes list; it is
 * optional so the existing MARC21/Zotero/RDF call sites keep working, and the
 * bulk process is created either way. `addressDoor` is the door's NAME
 * ('<tool>.<action>') when its records carry an operator-chosen `address`
 * (assertAddressDoor).
 */
export async function importMappedRecords(
	records: readonly MappedRecord[],
	sectionTipo: string,
	principal: Principal,
	options: { bulkLabel?: string; sourceFile?: string; addressDoor?: string } = {},
): Promise<ImportReport> {
	const userId = principal.userId;

	// NOTHING TO WRITE, NOTHING TO ATTRIBUTE (P0-7 review). Every caller can reach
	// here with an empty mapped set — a MARC21 batch whose every staged file
	// failed to parse, a Zotero/RDF export with no subjects, a map that matched no
	// column — and each of them already reports its own parse errors. Minting a
	// dd800 for that files an event that never happened in the operator's
	// Processes list, and it is the one dd800 no revert can ever be about.
	if (records.length === 0) {
		return {
			created: 0,
			updated: 0,
			failed: [],
			createdIds: [],
			records: [],
			bulkProcessId: null,
		};
	}

	// AN ADDRESS NEEDS ITS NAMED DOOR (6) — before the dd800 mint and any write.
	await assertAddressDoor(records, options.addressDoor);

	// DERIVED FIELDS ARE REFUSED, THE RUN BEFORE ANY WRITE (the CSV door's
	// posture). Ahead of the dd800 mint, so a refused run files no event.
	await assertNoDerivedField(records, sectionTipo);

	// REFUSE rather than proceed: a throw here reaches the caller before a single
	// data row is touched, which is the whole point of creating it first.
	const bulkProcessId = await createBulkProcessRecord(sectionTipo, userId, options);

	// Resolved ONCE for the run, outside the per-record transactions: every row of
	// one import belongs to one operator's working language, and a mid-run change
	// would split the file across two language slices.
	const run: RunScope = { sectionTipo, principal, bulkProcessId, dataLang: currentDataLang() };

	// The run is held in the active-run registry while it writes: a revert of it
	// is refused until it ends (decision D5).
	const written = new Map<number, WrittenRecord>();
	await withLiveBulkRun(bulkProcessId, async () => {
		for (const index of writeOrder(records)) {
			written.set(index, await writeInOwnTransaction(records[index] as MappedRecord, index, run));
		}
	});
	// THE REPORT IS IN INPUT ORDER, whatever order the records were written in.
	const inInputOrder = records.map((_, index) => written.get(index) as WrittenRecord);
	const results = inInputOrder.map((record) => record.result);
	const failed = inInputOrder.flatMap((record) => record.failed);
	const createdIds = results
		.filter((result) => result.created)
		.map((result) => result.sectionId as number);
	const updated = results.filter((result) => result.sectionId !== null && !result.created).length;
	const created = createdIds.length;
	return { created, updated, failed, createdIds, records: results, bulkProcessId };
}
