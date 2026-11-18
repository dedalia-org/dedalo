/**
 * THE IMPORTERS' CREATE DOOR AND LEGACY FRAME SLOTS (closure Step 3 req 10 —
 * refuter-surviving S2, 2026-10-01).
 *
 * WHAT WAS UNGATED. req 10 put every importer write through the write door, and
 * authz_door_matrix_native probes the MATCHED-record half (an EXISTING record,
 * one plain column → `authorizeRecordAccess`). Three other halves shipped with
 * no behavioural gate — every caller that reached them ran as a global admin,
 * which the door admits whatever the code does:
 *
 *   1. the mapped-record importer's CREATE (core/tools/import_execute.ts
 *      `recordIdFor`, door 'import_execute.create' — MARC21 / Zotero / RDF): a
 *      record with no matched id is born only after the section is asked at 2;
 *   2. the CSV importer's CREATE (core/tools/import_csv_execute.ts, door
 *      'import_csv.create') and its per-column gate on a row it CREATES
 *      (`componentRefusal`'s `isNew` branch — the pair at 2, no record yet);
 *   3. the CSV legacy `{data, dataframe}` envelope: each frame names its own
 *      slot (`from_component_tipo`), and that slot is a component write of its
 *      own (`legacyFrameSlots`) — refused, the WHOLE column is skipped.
 *   4. the CSV row whose id was FREE when the file's existence set was read but
 *      is TAKEN by a concurrent ordinary create before the row's insert (the
 *      conflict-tolerant insert is then a no-op — refuter-surviving S2,
 *      2026-10-01). The row did not create its record, so it is NOT a create:
 *      every column is asked as a write to THAT record (scope + the dd128-aware
 *      pair), and it is reported updated, never created. Reproduced as a REAL
 *      interleave (the concurrent create holds its insert open until the
 *      importer is provably waiting on it — pg_blocking_pids, never a sleep).
 *
 *   5. the mapped importer's ADDRESSED record (`MappedRecord.address`, the
 *      Zotero call-number — owner ruling 2026-11-17, rule 7): an absent id is a
 *      CREATE, asked of the same 'import_execute.create' door before the
 *      explicit-id insert; a record already living at the id is a MATCHED
 *      record, every field asked of the record door — never the create grant.
 *
 * THE IDENTITIES are authz_door_fixture's, asserted through the real resolver
 * first: LEVEL_1 (test3 at 1 — read, never write), READ_COMPONENT (test3 at 2,
 * test52 at 0), CONTROL (test3 + test52 at 2, test60 — the dataframe slot — at
 * 0). Every refusal has a SERVED twin, so an importer that refused everything
 * is red too. Residue is asserted on the rows, never on the report alone.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { deleteMatrixRecord } from '../../src/core/db/matrix_write.ts';
import { sql, withTransaction } from '../../src/core/db/postgres.ts';
import {
	bornInCurrentTransaction,
	createSectionRecord,
} from '../../src/core/section/record/create_record.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import { getPermissions, type Principal } from '../../src/core/security/permissions.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { planCsvImport } from '../../src/core/tools/import_csv.ts';
import { executeCsvImport } from '../../src/core/tools/import_csv_execute.ts';
import { importMappedRecords } from '../../src/core/tools/import_execute.ts';
import {
	AUTHZ_FILTER,
	AUTHZ_PROJECT_P,
	AUTHZ_PROJECT_Q,
	AUTHZ_SECTION,
	AUTHZ_TEXT,
	AUTHZ_TEXT_AREA,
	type AuthzIdentities,
	assertAuthzDoorContrast,
	authzProjectLocator,
	createDoorRecord,
	installAuthzDoorFixture,
	removeAuthzDoorFixture,
	resolveAuthzIdentities,
} from '../helpers/authz_door_fixture.ts';
import { DB_READY } from '../helpers/db_ready.ts';

const TABLE = 'matrix_test';
/** test60 — a component_dataframe of the test3 family: the legacy frames' slot. */
const FRAME_SLOT = 'test60';

let ids: AuthzIdentities;
/** test3 records the IMPORTERS created (swept with their TM rows). */
const importedIds = new Set<number>();
/** dd800 run records the importers / this file minted. */
const runIds = new Set<number>();
/** Names the LINK gates gave the records the importer may create (swept by name). */
const linkNames = new Set<string>();

async function rowCount(): Promise<number> {
	const rows = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM ${TABLE} WHERE section_tipo = $1`,
		[AUTHZ_SECTION],
	)) as { n: number }[];
	return rows[0]?.n ?? 0;
}

async function recordColumns(
	sectionId: number,
): Promise<{ text: unknown; frames: unknown } | null> {
	const rows = (await sql.unsafe(
		`SELECT string -> '${AUTHZ_TEXT}' AS text, relation -> '${FRAME_SLOT}' AS frames
		   FROM ${TABLE} WHERE section_tipo = $1 AND section_id = $2`,
		[AUTHZ_SECTION, sectionId],
	)) as { text: unknown; frames: unknown }[];
	return rows[0] ?? null;
}

/** An id no test3 record holds yet (the CSV importer creates AT the row's id). */
async function freshId(): Promise<number> {
	const rows = (await sql.unsafe(
		`SELECT COALESCE(MAX(section_id), 0)::int + 1 AS id FROM ${TABLE} WHERE section_tipo = $1`,
		[AUTHZ_SECTION],
	)) as { id: number }[];
	const id = rows[0]?.id ?? 1;
	expect(await recordColumns(id)).toBeNull();
	return id;
}

/** The MARC21 / Zotero / RDF engine on ONE record with no matched id. */
async function importNew(principal: Principal) {
	const report = await importMappedRecords(
		[{ sectionId: null, fields: [{ component_tipo: AUTHZ_TEXT, values: ['zzimport create'] }] }],
		AUTHZ_SECTION,
		principal,
		{ bulkLabel: 'import create door gate' },
	);
	if (report.bulkProcessId !== null) runIds.add(report.bulkProcessId);
	for (const id of report.createdIds) importedIds.add(id);
	return report;
}

/** The mapped engine on ONE record ADDRESSED by id (the Zotero door's named exception). */
async function importAddressed(principal: Principal, sectionId: number, value: string) {
	const report = await importMappedRecords(
		[
			{
				sectionId: null,
				address: { sectionId },
				fields: [{ component_tipo: AUTHZ_TEXT, values: [value] }],
			},
		],
		AUTHZ_SECTION,
		principal,
		{ bulkLabel: 'import address door gate', addressDoor: 'tool_import_zotero.import_files' },
	);
	if (report.bulkProcessId !== null) runIds.add(report.bulkProcessId);
	return report;
}

/**
 * The mapped engine on ONE new record carrying a LINK (in test17) to a test3
 * record NAMED (test52) `name` — absent, so the link must create it. The named
 * record it creates is swept by name (it is not one of the run's createdIds).
 */
async function importLinked(principal: Principal, name: string) {
	linkNames.add(name);
	const report = await importMappedRecords(
		[
			{
				sectionId: null,
				fields: [],
				links: [
					{
						component_tipo: AUTHZ_TEXT_AREA,
						target: { sectionTipo: AUTHZ_SECTION, componentTipo: AUTHZ_TEXT },
						text: name,
					},
				],
			},
		],
		AUTHZ_SECTION,
		principal,
		{ bulkLabel: 'import link create door gate' },
	);
	if (report.bulkProcessId !== null) runIds.add(report.bulkProcessId);
	for (const id of report.createdIds) importedIds.add(id);
	return report;
}

/** test3 records whose test52 holds `name` (the link-created records). */
async function recordsNamed(name: string): Promise<number[]> {
	const rows = (await sql.unsafe(
		`SELECT section_id FROM ${TABLE} WHERE section_tipo = $1 AND string::text LIKE $2`,
		[AUTHZ_SECTION, `%${name}%`],
	)) as { section_id: number }[];
	return rows.map((row) => Number(row.section_id)).filter((id) => !importedIds.has(id));
}

/** The CSV engine on ONE row (section_id + one test52 cell), as `principal`. */
async function importCsvRow(principal: Principal, sectionId: number, cell: string) {
	const plan = await planCsvImport(
		[[String(sectionId), cell]],
		[
			{
				tipo: 'section_id',
				model: 'component_section_id',
				columnName: 'section_id',
				lang: 'lg-nolan',
			},
			{ tipo: AUTHZ_TEXT, model: 'component_input_text', columnName: AUTHZ_TEXT, lang: 'lg-nolan' },
		],
		AUTHZ_SECTION,
	);
	const bulkProcessId = await createSectionRecord('dd800', -1);
	runIds.add(bulkProcessId);
	const report = await executeCsvImport({
		plan,
		sectionTipo: AUTHZ_SECTION,
		principal,
		bulkProcessId,
		errors: [],
		notices: [],
		progress: {
			file: 'zzimport_create.csv',
			fileIndex: 1,
			filesTotal: 1,
			labels: new Map(),
			publish: () => {},
		},
	});
	for (const id of report.created) importedIds.add(id);
	return report;
}

/**
 * Poll until some backend waits on a lock HELD BY `pid` — identity, not a sleep
 * (bulk_operation_atomicity_native's idiom): `pg_blocking_pids` names the blocker.
 */
async function waitUntilBlockedBy(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const rows = (await sql.unsafe(
			`SELECT count(*)::int AS n FROM pg_stat_activity
			 WHERE wait_event_type = 'Lock' AND $1::int = ANY(pg_blocking_pids(pid))`,
			[String(pid)],
		)) as { n: number }[];
		if ((rows[0]?.n ?? 0) > 0) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return false;
}

/**
 * THE RACE: another user's ordinary create of `sectionId` (a member of
 * `projectId`) is written but NOT committed when the CSV import starts — so the
 * file's existence set misses it — and commits only once the importer's row is
 * provably waiting on it. The importer's conflict-tolerant insert is then a no-op.
 */
async function importCsvRowRacingCreate(
	principal: Principal,
	sectionId: number,
	projectId: number,
	cell: string,
) {
	importedIds.add(sectionId); // swept whatever the importer reports
	let releaseCreator: () => void = () => {};
	const creatorHold = new Promise<void>((resolve) => {
		releaseCreator = resolve;
	});
	let creatorWrote: () => void = () => {};
	const written = new Promise<void>((resolve) => {
		creatorWrote = resolve;
	});
	let creatorPid = 0;
	const creator = withTransaction(async () => {
		const pidRows = (await sql.unsafe('SELECT pg_backend_pid() AS pid')) as { pid: number }[];
		creatorPid = Number(pidRows[0]?.pid ?? 0);
		await createSectionRecord(AUTHZ_SECTION, -1, new Date(), sectionId);
		// test3 is excluded from the filter birth default: membership is SAVED.
		const saved = await saveComponentData({
			componentTipo: AUTHZ_FILTER,
			sectionTipo: AUTHZ_SECTION,
			sectionId,
			lang: 'lg-nolan',
			changedData: [
				{ action: 'set_data', key: null, value: [authzProjectLocator(projectId)] } as never,
			],
			userId: -1,
		});
		expect(saved.ok).toBe(true);
		creatorWrote();
		await creatorHold; // written; NOT committed
	});
	await written;
	expect(creatorPid).toBeGreaterThan(0);
	const run = importCsvRow(principal, sectionId, cell);
	const blocked = await waitUntilBlockedBy(creatorPid, 15_000);
	releaseCreator();
	await creator;
	return { blocked, report: await run };
}

const REFUSED = /not writable by the importer \(perm\.[a-z_]+\)/;

describe.if(DB_READY)(
	'req 10 — the importers ask the write door to CREATE, and per frame slot',
	() => {
		beforeAll(async () => {
			await installAuthzDoorFixture();
			ids = await resolveAuthzIdentities();
		});
		afterAll(async () => {
			await assertTestDatabase('import_create_door_native');
			for (const name of linkNames) {
				for (const id of await recordsNamed(name)) importedIds.add(id);
			}
			for (const id of importedIds) {
				await deleteMatrixRecord(TABLE, AUTHZ_SECTION, id);
				await sql.unsafe(
					'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
					[AUTHZ_SECTION, id],
				);
			}
			for (const id of runIds) {
				await deleteMatrixRecord('matrix_notes', 'dd800', id);
				await sql.unsafe(
					`DELETE FROM matrix_time_machine WHERE section_tipo = 'dd800' AND section_id = $1`,
					[id],
				);
			}
			await removeAuthzDoorFixture();
		});

		test('the identities are what they claim (the contrast is live)', async () => {
			await assertAuthzDoorContrast(ids);
			expect(await getPermissions(ids.level1, AUTHZ_SECTION, AUTHZ_SECTION)).toBe(1);
			expect(await getPermissions(ids.readComponent, AUTHZ_SECTION, AUTHZ_SECTION)).toBe(2);
			expect(await getPermissions(ids.readComponent, AUTHZ_SECTION, AUTHZ_TEXT)).toBe(0);
			expect(await getPermissions(ids.control, AUTHZ_SECTION, AUTHZ_TEXT)).toBe(2);
			expect(await getPermissions(ids.control, AUTHZ_SECTION, FRAME_SLOT)).toBe(0);
		});

		// --- 1. the mapped-record importer (MARC21 / Zotero / RDF) ----------------

		test('MAPPED, NEW record, section READ-only (LEVEL_1): refused — nothing created, no row left', async () => {
			const before = await rowCount();
			const report = await importNew(ids.level1);
			expect({ created: report.created, createdIds: report.createdIds }).toEqual({
				created: 0,
				createdIds: [],
			});
			expect(report.failed.map((failure) => String(failure.msg))).toEqual([
				expect.stringContaining('the record was not written'),
			]);
			expect(await rowCount()).toBe(before);
		});

		test('MAPPED, NEW record, the served twin (CONTROL): created, its field written', async () => {
			const before = await rowCount();
			const report = await importNew(ids.control);
			expect(report.created).toBe(1);
			// The floor under the empty-failure verdict below: the import really ran and
			// really created a row (an importer that did nothing would also fail nothing).
			expect(report.createdIds).toHaveLength(1);
			expect(await rowCount()).toBeGreaterThan(before);
			expect(report.failed).toEqual([]);
			const created = report.createdIds[0] as number;
			expect(JSON.stringify((await recordColumns(created))?.text)).toContain('zzimport create');
		});

		// --- 1b. a LINK field's create (import_link.ts createNamedRecord) ---------
		// The link field (test17) is writable for both identities; the NAME
		// component of the record the link would create (test52) is 0 for
		// TEXT_ONLY and 2 for CONTROL — so only the link-create door separates them.

		test('MAPPED, LINK to an absent name, name component at 0 (TEXT_ONLY): link IGNORED, no named record created, the record written', async () => {
			expect(await getPermissions(ids.textOnly, AUTHZ_SECTION, AUTHZ_TEXT)).toBe(0);
			expect(await getPermissions(ids.textOnly, AUTHZ_SECTION, AUTHZ_TEXT_AREA)).toBe(2);
			const name = `zzlink refused ${process.pid}`;
			const report = await importLinked(ids.textOnly, name);
			expect(report.createdIds).toHaveLength(1);
			expect(report.failed.map((failure) => String(failure.msg))).toEqual([
				expect.stringContaining('the importer may not create one there'),
			]);
			expect(await recordsNamed(name)).toEqual([]);
		});

		test('MAPPED, LINK to an absent name, the served twin (CONTROL): the named record created and linked', async () => {
			expect(await getPermissions(ids.control, AUTHZ_SECTION, AUTHZ_TEXT)).toBe(2);
			const name = `zzlink served ${process.pid}`;
			const report = await importLinked(ids.control, name);
			expect(report.failed).toEqual([]);
			const named = await recordsNamed(name);
			expect(named).toHaveLength(1);
			const created = report.createdIds[0] as number;
			const linked = (await sql.unsafe(
				`SELECT relation -> '${AUTHZ_TEXT_AREA}' AS l, string -> '${AUTHZ_TEXT_AREA}' AS s FROM ${TABLE} WHERE section_tipo = $1 AND section_id = $2`,
				[AUTHZ_SECTION, created],
			)) as { l: unknown; s: unknown }[];
			expect(JSON.stringify(linked[0])).toContain(String(named[0]));
		});

		// --- 1c. an ADDRESSED record (MappedRecord.address — the Zotero call-number) --

		test('MAPPED, ADDRESS at a free id, section READ-only (LEVEL_1): refused — no record at the id', async () => {
			const sectionId = await freshId();
			importedIds.add(sectionId); // swept whatever the importer reports
			const report = await importAddressed(ids.level1, sectionId, 'zzaddress create refused');
			expect({ created: report.created, createdIds: report.createdIds }).toEqual({
				created: 0,
				createdIds: [],
			});
			expect(report.failed.map((failure) => String(failure.msg))).toEqual([
				expect.stringContaining('the record was not written'),
			]);
			expect(await recordColumns(sectionId)).toBeNull();
		});

		test('MAPPED, ADDRESS at a free id, the served twin (CONTROL): created AT the id, its field written', async () => {
			const sectionId = await freshId();
			importedIds.add(sectionId);
			const report = await importAddressed(ids.control, sectionId, 'zzaddress create served');
			expect(report.failed).toEqual([]);
			expect(report.createdIds).toEqual([sectionId]);
			expect(report.records).toEqual([{ index: 0, sectionId, created: true }]);
			expect(JSON.stringify((await recordColumns(sectionId))?.text)).toContain(
				'zzaddress create served',
			);
		});

		test('MAPPED, ADDRESS at an EXISTING record OUT of her scope: a matched record — the field refused by the record door, the record untouched, nothing created', async () => {
			const sectionId = await createDoorRecord(AUTHZ_SECTION, AUTHZ_PROJECT_Q);
			const before = await rowCount();
			const report = await importAddressed(ids.control, sectionId, 'zzaddress foreign');
			// Not a create: the create grant CONTROL holds never reaches a living record.
			expect({ created: report.created, updated: report.updated }).toEqual({
				created: 0,
				updated: 1,
			});
			expect(report.failed).toEqual([
				expect.objectContaining({
					component_tipo: AUTHZ_TEXT,
					msg: expect.stringMatching(REFUSED),
				}),
			]);
			expect(await rowCount()).toBe(before);
			expect((await recordColumns(sectionId))?.text ?? null).toBeNull();
		});

		test('MAPPED, ADDRESS at an EXISTING record IN her scope (the served twin): updated, the field written', async () => {
			const sectionId = await createDoorRecord(AUTHZ_SECTION, AUTHZ_PROJECT_P);
			const report = await importAddressed(ids.control, sectionId, 'zzaddress in scope');
			expect(report.failed).toEqual([]);
			expect(report.records).toEqual([{ index: 0, sectionId, created: false }]);
			expect(JSON.stringify((await recordColumns(sectionId))?.text)).toContain(
				'zzaddress in scope',
			);
		});

		// --- 2. the CSV importer: the create, and a column of a CREATED row ---------

		test('CSV, NEW row, section READ-only (LEVEL_1): refused — the row rolled back, no record at its id', async () => {
			const sectionId = await freshId();
			const report = await importCsvRow(ids.level1, sectionId, 'zzcsv create refused');
			expect(report.created).toEqual([]);
			expect(report.failed.map((failure) => String(failure.msg))).toEqual([
				expect.stringContaining('the row was rolled back'),
			]);
			expect(await recordColumns(sectionId)).toBeNull();
		});

		test('CSV, NEW row, section writable but the column at 0 (READ_COMPONENT): created, the column IGNORED and unwritten', async () => {
			const sectionId = await freshId();
			const report = await importCsvRow(ids.readComponent, sectionId, 'zzcsv column refused');
			expect(report.created).toEqual([sectionId]);
			expect(report.failed).toEqual([
				expect.objectContaining({
					component_tipo: AUTHZ_TEXT,
					msg: expect.stringMatching(REFUSED),
				}),
			]);
			expect((await recordColumns(sectionId))?.text ?? null).toBeNull();
		});

		test('CSV, NEW row, the served twin (CONTROL): created, the column written', async () => {
			const sectionId = await freshId();
			const report = await importCsvRow(ids.control, sectionId, 'zzcsv create served');
			expect(report.created).toEqual([sectionId]);
			expect(report.failed).toEqual([]);
			expect(JSON.stringify((await recordColumns(sectionId))?.text)).toContain(
				'zzcsv create served',
			);
		});

		// --- 4. the CSV row whose id a concurrent create took after the snapshot ---

		test('CSV, row id taken by a concurrent create OUT of her scope: NOT a create — the column refused by the record door, the foreign record untouched', async () => {
			const sectionId = await freshId();
			const { blocked, report } = await importCsvRowRacingCreate(
				ids.control,
				sectionId,
				AUTHZ_PROJECT_Q,
				'zzcsv race foreign',
			);
			// anti-vacuity: the importer really raced the create (it waited on it)
			expect(blocked).toBe(true);
			expect({ created: report.created, updated: report.updated }).toEqual({
				created: [],
				updated: [sectionId],
			});
			expect(report.failed).toEqual([
				expect.objectContaining({
					component_tipo: AUTHZ_TEXT,
					msg: expect.stringMatching(REFUSED),
				}),
			]);
			const stored = await recordColumns(sectionId);
			expect(stored).not.toBeNull(); // the creator's record stands
			expect(stored?.text ?? null).toBeNull();
		});

		test('the birth predicate REFUSES outside a transaction (no xid to compare — never a silent false)', async () => {
			let thrown: unknown = null;
			try {
				await bornInCurrentTransaction(TABLE, AUTHZ_SECTION, 1);
			} catch (error) {
				thrown = error;
			}
			expect((thrown as { code?: string } | null)?.code).toBe('internal.invariant');
			// the served twin: inside a transaction it answers (a row it did not write)
			const answered = await withTransaction(() =>
				bornInCurrentTransaction(TABLE, AUTHZ_SECTION, 1),
			);
			expect(answered).toBe(false);
		});

		test('CSV, row id taken by a concurrent create IN her scope (the served twin): written as an UPDATE, never reported created', async () => {
			const sectionId = await freshId();
			const { blocked, report } = await importCsvRowRacingCreate(
				ids.control,
				sectionId,
				AUTHZ_PROJECT_P,
				'zzcsv race in scope',
			);
			expect(blocked).toBe(true);
			expect({ created: report.created, updated: report.updated }).toEqual({
				created: [],
				updated: [sectionId],
			});
			expect(report.failed).toEqual([]);
			expect(JSON.stringify((await recordColumns(sectionId))?.text)).toContain(
				'zzcsv race in scope',
			);
		});

		// --- 3. the CSV legacy {data, dataframe} envelope's frame slots ------------

		const envelope = (withFrame: boolean, sectionId: number): string =>
			JSON.stringify({
				dedalo_data: {
					data: [{ id: 1, value: withFrame ? 'zzframe refused' : 'zzframe served' }],
					dataframe: withFrame
						? [
								{
									section_tipo: AUTHZ_SECTION,
									section_id: sectionId,
									from_component_tipo: FRAME_SLOT,
									id_key: 1,
									type: 'dd490',
								},
							]
						: [],
				},
			});

		test('CSV legacy envelope whose frame names a slot she holds 0 on: the slot IGNORED, the frame AND the main column unwritten', async () => {
			const sectionId = await createDoorRecord(AUTHZ_SECTION, AUTHZ_PROJECT_P);
			const report = await importCsvRow(ids.control, sectionId, envelope(true, sectionId));
			expect(report.updated).toEqual([sectionId]);
			expect(report.failed).toEqual([
				expect.objectContaining({
					component_tipo: FRAME_SLOT,
					msg: expect.stringMatching(REFUSED),
				}),
			]);
			const stored = await recordColumns(sectionId);
			expect({ text: stored?.text ?? null, frames: stored?.frames ?? null }).toEqual({
				text: null,
				frames: null,
			});
		});

		test('CSV legacy envelope, the served twin (no frame): the main column written', async () => {
			const sectionId = await createDoorRecord(AUTHZ_SECTION, AUTHZ_PROJECT_P);
			const report = await importCsvRow(ids.control, sectionId, envelope(false, sectionId));
			expect(report.failed).toEqual([]);
			expect(JSON.stringify((await recordColumns(sectionId))?.text)).toContain('zzframe served');
		});
	},
);
