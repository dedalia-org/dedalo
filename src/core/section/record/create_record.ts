/**
 * Section record creation (PHP section::create_record → section_record::create).
 *
 * Creating a record writes ONE new matrix row with the audit metadata a fresh
 * record carries:
 * - the `data` column: {label, created_date, section_id, section_tipo,
 *   diffusion_info, created_by_user_id} (PHP section_record::build_metadata);
 * - the `relation` column: the created-by-user locator under dd200 (a link to
 *   the user record in dd128);
 * - the `date` column: the creation date under dd199 as a Dédalo virtual-date
 *   object (PHP build_modification_data mode 'new_record').
 * The section_id is allocated atomically through the matrix counter (see
 * insertMatrixRecordWithCounter).
 *
 * created_date / the dd199 date are wall-clock values — the only non-reproducible
 * fields; a differential must normalize them.
 *
 * This writer inserts through db/matrix_write.ts DIRECTLY — it does NOT pass the
 * record_write.ts chokepoint — so it declares the chokepoint's post-write
 * obligations for itself through the chokepoint's OWN hook (afterRecordWrite:
 * save event, security reaction, RAG index event) and appends the 'NEW'
 * activity row here, at the engine (PHP section::create_record :1159 logged at
 * the engine too, so every door — client, MCP, import, portal "+" — gets a
 * row). Gated by test/unit/tools_cache_invalidation.test.ts +
 * test/unit/write_obligations_{tripwire,native}.test.ts.
 */

import { config } from '../../../config/config.ts';
import { isConsultationOnlySection } from '../../concepts/section.ts';
import { dbTimestamp } from '../../db/db_timestamp.ts';
import {
	insertMatrixRecordIfAbsent,
	insertMatrixRecordWithCounter,
	insertMatrixRecordWithExplicitId,
	type MatrixWriteValues,
} from '../../db/matrix_write.ts';
import { isInTransaction, sql, withTransaction } from '../../db/postgres.ts';
import { openEpochIfReborn } from '../../db/record_generation.ts';
import { recordBulkBirth } from '../../db/time_machine.ts';
import { DedaloError } from '../../errors/dedalo_error.ts';
import { refuseLabelNode } from '../../ontology/label_node_guard.ts';
import { resolveLabel } from '../../ontology/labels.ts';
import { getMatrixTableFromTipo } from '../../ontology/resolver.ts';
import { currentRequestContext } from '../../security/request_context.ts';
import { bulkIdOf } from './bulk_capture.ts';

/** Audit component tipos (PHP section::get_metadata_definition + relation types). */
export const CREATED_BY_USER = 'dd200';
export const CREATED_DATE = 'dd199';
export const MODIFIED_BY_USER = 'dd197';
export const MODIFIED_DATE = 'dd201';
const USERS_SECTION = 'dd128'; // DEDALO_SECTION_USERS_TIPO
const RELATION_TYPE_LINK = 'dd151'; // DEDALO_RELATION_TYPE_LINK

/** A Dédalo virtual-date `start` object (matches the stored component_date shape). */
interface VirtualDateStart {
	day: number;
	hour: number;
	time: number;
	year: number;
	month: number;
	minute: number;
	second: number;
}

/**
 * The current instant as a Dédalo virtual date. `time` is the virtual-calendar
 * encoding (fixed 372-day years / 31-day months — PHP dd_date), NOT a Unix
 * timestamp: year*372*86400 + (month-1)*31*86400 + (day-1)*86400 + h*3600 +
 * m*60 + s.
 */
export function virtualDateNow(now: Date): VirtualDateStart {
	const year = now.getFullYear();
	const month = now.getMonth() + 1;
	const day = now.getDate();
	const hour = now.getHours();
	const minute = now.getMinutes();
	const second = now.getSeconds();
	const time =
		year * 372 * 86400 +
		(month - 1) * 31 * 86400 +
		(day - 1) * 86400 +
		hour * 3600 +
		minute * 60 +
		second;
	return { day, hour, time, year, month, minute, second };
}

// The shared DEDALO_TIMEZONE-aware stamp helper (S1-03): re-exported so the
// delete/duplicate/observers paths that import it from here keep one source.
export { dbTimestamp } from '../../db/db_timestamp.ts';

/**
 * Resolve a section's display label from its ontology `term` map (PHP
 * build_metadata → get_term_by_tipo): the ONE label chain (labels.ts
 * resolveLabel) in the install's application lang. Empty string when the chain
 * finds nothing (PHP casts null→''), and for a model='label' node
 * (refuseLabelNode — dev/test throw, production logs once): a by-tipo term read
 * is a guarded home (test/unit/term_by_tipo_label_guard.test.ts census).
 */
async function resolveSectionLabel(sectionTipo: string): Promise<string> {
	const rows =
		(await sql`SELECT term, model, machine_name FROM dd_ontology WHERE tipo = ${sectionTipo} LIMIT 1`) as {
			term: Record<string, string> | null;
			model: string | null;
			machine_name: string | null;
		}[];
	if (refuseLabelNode(sectionTipo, rows[0]?.model)) return '';
	const row = rows[0];
	if (row === undefined) return '';
	return resolveLabel(row.term, config.menu.applicationLang, row.machine_name) ?? '';
}

/** The options of createSectionRecord (see its header). */
export interface CreateRecordOptions {
	conflictTolerant?: boolean;
	filterData?: readonly Record<string, unknown>[];
	/**
	 * The dd800 run creating this record (WC …-bulk-revert-undo-log). When the
	 * call really inserts the row, the run's BIRTH marker is written with it
	 * (time_machine.ts recordBulkBirth) — the undo log's proof that the run's
	 * revert may remove the record. Never for the conflict-tolerant no-op.
	 */
	bulkProcessId?: number | null;
}

/**
 * Was the row at the address WRITTEN by the ambient transaction? An xmin test,
 * for a caller that runs the conflict-tolerant create inside its OWN transaction and must know whether the
 * record is the one it created or one a concurrent writer committed first (the
 * CSV importer: a row whose id was taken after its existence snapshot is NOT a
 * create, and is authorized as a write to that record). Asked right after the
 * create, before the caller writes the row: a later write by the same
 * transaction would also stamp its xmin. Outside a transaction there is no
 * "this transaction" to compare with — refused loudly, never a silent false.
 * LIMIT: under a SAVEPOINT the row's xmin is the subtransaction's id, and this
 * answers false for a row the caller did insert — createSectionRecord itself
 * therefore decides its birth by the insert statement, never by this.
 */
export async function bornInCurrentTransaction(
	table: string,
	sectionTipo: string,
	sectionId: number,
): Promise<boolean> {
	if (!isInTransaction()) {
		throw new DedaloError('internal.invariant', {
			message: 'bornInCurrentTransaction: called outside a transaction (no xid to compare)',
			coordinates: { table, section_tipo: sectionTipo, section_id: sectionId },
		});
	}
	const rows = (await sql.unsafe(
		`SELECT xmin = pg_current_xact_id_if_assigned()::xid AS mine
		 FROM "${table}" WHERE section_tipo = $1 AND section_id = $2`,
		[sectionTipo, sectionId],
	)) as { mine: boolean | null }[];
	return rows[0]?.mine === true;
}

/**
 * The run's BIRTH marker for a row this call really inserted — nothing otherwise.
 * It carries the record's BIRTH IMAGE: the ontology-declared defaults the INSERT
 * wrote (projects filter, dato_default — record_defaults.ts), which no save
 * wrote and so no undo pair records. The revert needs them to tell the record's
 * birth state from a later write by someone else (bulk_revert_records.ts).
 *
 * THE GENERATION FENCE (`explicitId`). A counter allocation opens its epoch in
 * the INSERT itself (matrix_write.ts); the matrix-level explicit-id insert opens
 * none. But THIS door only ever creates a NEW record (an undelete re-inserts
 * through tool_time_machine's insertMatrixRecordIfAbsent, never here), so an
 * explicit-id insert that really inserted at an address carrying history is a
 * REBIRTH, bulk run or not, and opens the epoch. The generation epoch is what
 * the bulk revert trusts to tell a cascade-deleted record from one born at its
 * address since (bulk_revert_records.ts isRebornSince) — a door that re-used an
 * address without opening one would let the revert pour the dead record's
 * snapshot into the new one (2026-09-27 review). For a BULK create the stake is
 * also the undo log: a record is being born where a dead one lived (a CSV
 * re-imported with its section_id column after the record was deleted), and
 * the dead record's undo log — an
 * earlier run's birth marker and B/A pairs, byte-identical when the same CSV is
 * imported again — must not read as the new record's: reverting that earlier
 * run would restore its BEFORE (absent) over every key of this run and delete
 * the record (the chain and conflict checks cannot tell two records with the
 * same content apart). So the epoch is opened here, in the insert's
 * transaction, BEFORE the marker — the marker sits at or above it
 * (recordBulkBirth's contract). A no-op on a fresh address.
 */
async function recordBirthMarker(
	inserted: boolean,
	bulkProcessId: number | null | undefined,
	record: {
		sectionTipo: string;
		sectionId: number;
		userId: number;
		now: Date;
		birthImage: Record<string, unknown>;
		explicitId: boolean;
	},
): Promise<void> {
	if (!inserted) return;
	if (record.explicitId) await openEpochIfReborn(record.sectionTipo, record.sectionId);
	const bulkId = bulkIdOf(bulkProcessId);
	if (bulkId === null) return;
	await recordBulkBirth({
		sectionTipo: record.sectionTipo,
		sectionId: record.sectionId,
		userId: record.userId,
		bulkId,
		timestamp: dbTimestamp(record.now),
		image: record.birthImage,
	});
}

/**
 * The `data`-column metadata a fresh record carries (PHP build_metadata).
 * section_id is left null — PHP writes it null too (the row's real section_id
 * lives in the structural column).
 */
export async function buildRecordMetadata(
	sectionTipo: string,
	userId: number,
	now: Date,
): Promise<Record<string, unknown>> {
	return {
		label: await resolveSectionLabel(sectionTipo),
		created_date: dbTimestamp(now),
		section_id: null,
		section_tipo: sectionTipo,
		diffusion_info: null,
		created_by_user_id: userId,
	};
}

/** An audit user locator (created-by dd200 / modified-by dd197 stamp). */
export function auditUserLocator(userId: number, componentTipo: string): Record<string, unknown> {
	return {
		id: 1,
		type: RELATION_TYPE_LINK,
		// WC-2026-08-10-section-id-int-canonical: the user's record address is an
		// int, and userId already IS that int.
		section_id: userId,
		section_tipo: USERS_SECTION,
		from_component_tipo: componentTipo,
	};
}

/** An audit date item (created dd199 / modified dd201 stamp, nolan lang). */
export function auditDateItem(now: Date): Record<string, unknown> {
	return { id: 1, start: virtualDateNow(now), lang: 'lg-nolan' };
}

/**
 * Create a new record in `sectionTipo` owned by `userId`. Returns the allocated
 * section_id. `now` is injectable for deterministic tests.
 *
 * `sectionId` forces a specific id instead of counter-allocating one — the
 * ontology provisioning path needs deterministic node ids (`<tld>0` descriptor
 * = 1, model = 2, typology groupers). With it set the counter is raised so a
 * later auto-allocation never collides; a duplicate id throws — unless
 * `options.conflictTolerant` is set, in which case an already-existing row is
 * ACCEPTED without error (the save path's materialize-on-save race, S1-02:
 * two concurrent saves both find no row and both try to create it; the loser
 * re-reads under its lock) and the requested sectionId is returned.
 *
 * BIRTH DEFAULTS (audit B1, WC-2026-08-09-record-birth-defaults). The insert also carries the record's
 * ontology-declared initial state — the projects filter locator and every
 * `properties.dato_default` — built by record_defaults.ts. THIS is the
 * chokepoint for it: PHP wrote those on the first edit-form BUILD, which
 * misses every non-rendering door (import, ts_api, MCP, the portal "+") and
 * left a non-admin's new record outside the projects ACL — invisible in list
 * and search, 403 on every save. One INSERT carries them, so the record is
 * never momentarily unreachable and no Time Machine row records a "change"
 * that is really the record's birth state.
 *
 * `options.filterData` supplies the project locators explicitly (PHP
 * set_projects_to_new_section_record's `$component_filter_data` branch — the
 * portal "+" inherits the HOST record's projects instead of the computed
 * default).
 *
 * THERE IS NO PER-DOOR OPT-OUT, deliberately. A record's ontology-declared
 * birth state does not depend on which door made it, and an opt-out is exactly
 * the silent narrowing this module exists to end: the ontology/hierarchy
 * provisioners would mint node records structurally different from the ones a
 * curator makes, and the difference would surface as "this node has no project"
 * months later. Where a provisioner means the opposite of a declared default it
 * OVERWRITES it explicitly (hierarchy_provision's `ontology30` on the model
 * twin), which is legible in the code that means it.
 */
export async function createSectionRecord(
	sectionTipo: string,
	userId: number,
	now: Date = new Date(),
	sectionId?: number,
	options: CreateRecordOptions = {},
): Promise<number> {
	// Consultation-only sections are read-only for every caller (Activity dd542,
	// Time Machine dd15, …). PHP refuses this at section::create_record:452; the
	// engine backstop covers the client API, MCP tools, the agent and any future
	// door in one place. The API handlers deny earlier with a clean 403.
	if (isConsultationOnlySection(sectionTipo)) {
		throw new DedaloError('perm.denied', {
			message: `createSectionRecord: section '${sectionTipo}' is consultation-only (read-only)`,
			coordinates: { section_tipo: sectionTipo, operation: 'create' },
		});
	}
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === null) {
		throw new DedaloError('section.no_matrix_table', {
			message: `createSectionRecord: no matrix table for section '${sectionTipo}'`,
			coordinates: { section_tipo: sectionTipo },
		});
	}
	// Ontology-declared birth state (project filter + properties.dato_default).
	// Merged UNDER the audit metadata: no default may ever displace the
	// created-by/created-date stamps.
	const { buildRecordDefaultColumns } = await import('./record_defaults.ts');
	const defaults = await buildRecordDefaultColumns(sectionTipo, userId, {
		filterData: options.filterData,
	});
	const jsonbColumns = {
		...defaults,
		data: await buildRecordMetadata(sectionTipo, userId, now),
		// created-by-user link + creation date (PHP build_modification_data 'new_record').
		relation: {
			...defaults.relation,
			[CREATED_BY_USER]: [auditUserLocator(userId, CREATED_BY_USER)],
		},
		date: { ...defaults.date, [CREATED_DATE]: [auditDateItem(now)] },
	};
	// THE INSERT, and whether it BORE the row. The race loser of a tolerated
	// conflict — the one caller that did NOT create anything — is told apart BY
	// THE INSERT STATEMENT ITSELF (ON CONFLICT DO NOTHING … RETURNING answers a
	// row only when it inserted one): exact, with no window
	// between a pre-check and the insert, and exact under a savepoint, where a
	// row's xmin is a subtransaction's. Two consumers need that answer to be exact: the
	// 'NEW' activity row below, and a bulk run's BIRTH marker (a surplus one
	// would let the run's revert delete a record it never created). The marker
	// joins the insert's transaction, after any epoch the insert opened.
	// THE BIRTH COLUMNS (record_write.ts prepareBirthColumns — the one law every
	// record birth stores by): a relation default on an `_hi` component gets its
	// ancestor index in the insert, and a default on a covered observer slot is
	// left out (a mirror is derived — recomputed after the birth). The section's
	// COPY-LAW slots (ownDataCoveredSlots: source_overwrite / observed_data) are
	// recomputed BY DECLARATION too, as in duplicate_record.ts: a `dato_default`
	// may fill a copy law's input (a pointer, a tagged text), and a text default
	// is no relation edge — no birth hop would ever reach its slot. On an empty
	// input the recompute is a no-drift no-op. Dynamic import: record_write.ts
	// statically imports this module (import_scc_tripwire).
	const { prepareBirthColumns, ownDataCoveredSlots } = await import(
		'../../section_record/record_write.ts'
	);
	const pinned = [
		...new Set([
			...(await prepareBirthColumns(jsonbColumns as MatrixWriteValues)),
			...(await ownDataCoveredSlots(sectionTipo)),
		]),
	];
	const { newSectionId, inserted } = await withTransaction(async () => {
		// The birth is the STATEMENT's answer: a counter allocation and an
		// explicit-id insert that throws on conflict inserted or threw; the
		// conflict-tolerant one is ON CONFLICT DO NOTHING … RETURNING
		// (insertMatrixRecordIfAbsent), which returns a row only when IT inserted
		// one. Never the row's xmin: under a SAVEPOINT that is the SUBtransaction's
		// id, and a row this call did insert would read "not mine" — no birth
		// marker, no NEW activity row, no epoch (tool_import_rdf runs every op under
		// a savepoint — 2026-10-01 review; gate: rdf_import_execute_native).
		let id = sectionId ?? 0;
		let born = true;
		if (sectionId === undefined) {
			id = await insertMatrixRecordWithCounter(table, sectionTipo, jsonbColumns);
		} else if (options.conflictTolerant === true) {
			born = await insertMatrixRecordIfAbsent(table, sectionTipo, sectionId, jsonbColumns);
		} else {
			await insertMatrixRecordWithExplicitId(table, sectionTipo, sectionId, jsonbColumns, {
				onConflict: 'throw',
			});
		}
		await recordBirthMarker(born, options.bulkProcessId, {
			sectionTipo,
			sectionId: id,
			userId,
			now,
			birthImage: defaults,
			explicitId: sectionId !== undefined,
		});
		return { newSectionId: id, inserted: born };
	});

	// THE POST-WRITE OBLIGATIONS. This writer inserts through matrix_write
	// DIRECTLY, so it never passes the record_write.ts chokepoint that fires for
	// every other write — it declares the same obligations through the
	// chokepoint's own hook (P1-8, 2026-09-03), not through calls it remembers:
	//  - the save event: PHP fires here too (section_record::create() :2074 →
	//    save_event()), and a create is a real cache input: the record now
	//    EXISTS, which is what the data-derived caches (datalist option lists,
	//    authorized projects, hierarchy targets …) enumerate. For the three tool
	//    sections a bare create used to be inert because every tools reader
	//    skips a nameless row AND fetchActiveToolRows filters on the dd1354
	//    active relation — but that second half is GONE since the birth
	//    defaults landed: dd1324/dd996 declare `dato_default` on dd1354, so a
	//    fresh tool-register row is now born ACTIVE (still nameless, so still
	//    skipped). "Inert because of what the readers happen to select" was
	//    never an invariant anyone maintained; "every dd1324/dd996/dd234 write
	//    reaches invalidateAllToolCaches" is. Over-invalidation is cheap and
	//    harmless; a missed hop is permanent staleness.
	//  - the security reaction: the birth keys (dd200/dd199 + defaults) can
	//    never be an account transition; the reaction no-ops on every section
	//    but dd128/dd234 and clears caches there.
	//  - the RAG index event (DATA-18): a born-empty record enqueues cheaply
	//    (ON CONFLICT dedupes in the queue) and uniformly — the alternative was
	//    one lifecycle door exempt "because it is nearly harmless".
	//  - the observer ledger (CLOSURE_PLAN Step 2): the record's BIRTH — its
	//    relation defaults (a projects filter, a `dato_default` locator) are new
	//    edges, and every target an observer mirrors must list the record; a
	//    race loser created nothing, and declares nothing.
	// Fired unconditionally, including the conflictTolerant no-op (the S1-02
	// materialize-on-save race loser) — that path is inside a transaction and
	// every obligation self-defers or joins it. Dynamic import: record_write.ts
	// statically imports the audit builders from THIS module (a static edge back
	// would close an import cycle — import_scc_tripwire).
	const { afterRecordWrite } = await import('../../section_record/record_write.ts');
	await afterRecordWrite(
		{ table, sectionTipo, sectionId: newSectionId },
		{
			door: 'createSectionRecord',
			touchedKeys: Object.values(jsonbColumns).flatMap((bag) =>
				bag !== null && typeof bag === 'object' ? Object.keys(bag) : [],
			),
			rag: 'index',
			observed: inserted
				? { kind: 'birth', columns: jsonbColumns, selfRecompute: pinned, actor: userId, now }
				: { kind: 'none', reason: 'the materialize-on-save race loser created nothing' },
		},
	);

	// Activity audit (PHP logger 'NEW' code 3, section::create_record :1159 —
	// logged at the ENGINE, so imports, MCP, the portal "+" and the client door
	// all get a row; P1-8 / DATA-19 moved it here from the client door). The
	// host is the request's client IP when there is a request scope (ALS), and
	// PHP's 'unknown' for CLI/scripts/provisioning. Never fails the create:
	// logActivity swallows its own errors. Skipped for the race loser (above):
	// nothing was created, so a NEW row would describe an event that did not
	// happen.
	if (inserted) {
		const { logActivity, hostFromClientIp } = await import('../../api/handlers/activity_log.ts');
		await logActivity(
			{
				what: 'NEW',
				tipo: sectionTipo,
				userId,
				host: hostFromClientIp(currentRequestContext()?.clientIp),
				data: {
					msg: 'Created section record',
					// int, repealing the String() minting: a record address is emitted
					// in canonical form (WC-2026-08-10-section-id-int-canonical).
					section_id: newSectionId,
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
