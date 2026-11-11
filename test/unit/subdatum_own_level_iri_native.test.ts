/**
 * THE IRI LABEL FRAME (dd560) AT ITS MAIN'S LEVEL — T0-4 part A, owner
 * decision 1 (2026-11-10): main read (1) → frame read (1), main write (2) →
 * frame write (2), main 0 → 0; read AND write, every door.
 *
 * WHAT WAS WRONG (U08): dd560 is a `dd` node, never a child of a user section,
 * so no profile carries a dd774 row for it — the matrix answered 0. The save
 * door's pair half refused every non-superuser's IRI label (`perm.denied`), the
 * section read floored the frame to 1 (read-only), and the get_data door alone
 * RAISED it to max(main, 2) — writable even under a read-only IRI (F2).
 *
 * THE RULE NOW: the frame's own level is 2 (`getRecordComponentPermission`),
 * so the caller chain's cap makes it exactly its main's level on both reads;
 * the write door judges a fixed-frame save AGAINST ITS MAIN (`frameOf`), which
 * must be named (`caller_dataframe.main_component_tipo`), be a component of the
 * record's section and declare the slot — else `request.invalid_source`, never
 * a silent 2.
 *
 * Personas (test/helpers/authz_door_fixture.ts): IRI_EDITOR (test140 = 2) and
 * IRI_READER (test140 = 1), both with READ on the label target dd1706 so the
 * relation-insert read-grant gate (finding F6) is not what decides; neither
 * holds a dd560 row. Situation: a test3 record carrying one test140 IRI item
 * (engine-built, swept), and a dd1706 label record (engine-built, swept).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import { deleteMatrixRecord } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import {
	getMatrixTableFromTipo,
	getModelByTipo,
	tipoBelongsToSection,
} from '../../src/core/ontology/resolver.ts';
import { routeSectionRead } from '../../src/core/section/read_facade.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import {
	getRecordComponentPermission,
	type Principal,
	resolvePrincipal,
} from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import {
	authorizeRecordAccess,
	authorizeSectionTarget,
	sourceComponentLevel,
} from '../../src/core/security/write_door.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { planCsvImport } from '../../src/core/tools/import_csv.ts';
import { executeCsvImport } from '../../src/core/tools/import_csv_execute.ts';
import { importMappedRecords } from '../../src/core/tools/import_execute.ts';
import { sweepActivityRows } from '../helpers/activity_rows.ts';
import {
	AUTHZ_IRI,
	AUTHZ_IRI_LABEL_FIELD,
	AUTHZ_IRI_LABEL_SECTION,
	AUTHZ_IRI_SPLIT_A,
	AUTHZ_IRI_SPLIT_B,
	AUTHZ_IRI_SPLIT_SECTION,
	AUTHZ_PROJECT_P,
	AUTHZ_SECTION,
	AUTHZ_TEXT,
	type AuthzIdentities,
	assertAuthzDoorContrast,
	clearAuthzDoorCaches,
	createDoorRecord,
	installAuthzDoorFixture,
	removeAuthzDoorFixture,
	resolveAuthzIdentities,
} from '../helpers/authz_door_fixture.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

registerSessionCleanup();

const FRAME = 'dd560';
const LANG = 'lg-eng';
/** A component_iri of ANOTHER section (test65) — declares dd560, but is no component of test3. */
const FOREIGN_IRI = 'test117';

let ids: AuthzIdentities;
let root: Principal;
let record = 0;
let labelRecord = 0;
let labelTable = '';

function contextFor(principal: Principal) {
	const token = createSession(
		principal.userId,
		`zziri_${principal.userId}`,
		principal.userId === -1,
	);
	const session = getSession(token);
	return {
		requestId: 'subdatum-own-level-iri',
		clientIp: '127.0.0.1',
		session,
		csrfCandidate: session?.csrfToken ?? null,
		principal,
	};
}

interface ContextEntry {
	tipo?: unknown;
	section_tipo?: unknown;
	permissions?: unknown;
}
interface Answer {
	ok: boolean;
	context: ContextEntry[];
	errorCode: string | null;
	body: unknown;
}

async function send(rqo: Record<string, unknown>, principal: Principal): Promise<Answer> {
	clearAuthzDoorCaches();
	const body = (await dispatchRqo(structuredClone(rqo) as never, contextFor(principal) as never))
		.body as { ok?: boolean; data?: { context?: ContextEntry[] }; error?: { code?: string } };
	return {
		ok: body.ok !== false,
		context: body.data?.context ?? [],
		errorCode: body.error?.code ?? null,
		body,
	};
}

/** The dd560 frame's context entry (the label frame of test140). */
const frameEntry = (answer: Answer): ContextEntry | undefined =>
	answer.context.find((entry) => entry.tipo === FRAME);

/** A section read of the scratch record (edit) showing the IRI column. */
function sectionRead(principal: Principal) {
	return send(
		{
			action: 'read',
			dd_api: 'dd_core_api',
			prevent_lock: true,
			options: {},
			source: {
				typo: 'source',
				model: 'section',
				tipo: AUTHZ_SECTION,
				section_tipo: AUTHZ_SECTION,
				action: 'search',
				mode: 'edit',
				lang: LANG,
				session_save: false,
			},
			sqo: {
				section_tipo: [AUTHZ_SECTION],
				limit: 1,
				offset: 0,
				filter_by_locators: [{ section_tipo: AUTHZ_SECTION, section_id: String(record) }],
			},
			show: { ddo_map: [{ tipo: AUTHZ_IRI, parent: 'self', section_tipo: 'self' }] },
		},
		principal,
	);
}

/** The IRI's own get_data (edit) — the door that used to stamp max(main, 2). */
function iriGetData(principal: Principal) {
	return send(
		{
			action: 'read',
			dd_api: 'dd_core_api',
			prevent_lock: true,
			source: {
				typo: 'source',
				type: 'component',
				action: 'get_data',
				model: 'component_iri',
				tipo: AUTHZ_IRI,
				section_tipo: AUTHZ_SECTION,
				section_id: record,
				mode: 'edit',
				lang: LANG,
			},
		},
		principal,
	);
}

/** The client's dd560 frame save (common.js: caller_dataframe from the IRI caller). */
function frameSave(principal: Principal, callerDataframe: Record<string, unknown> | null) {
	const source: Record<string, unknown> = {
		typo: 'source',
		type: 'component',
		model: 'component_dataframe',
		tipo: FRAME,
		section_tipo: AUTHZ_SECTION,
		section_id: String(record),
		mode: 'edit',
		lang: 'lg-nolan',
		action: null,
	};
	if (callerDataframe !== null) source.caller_dataframe = callerDataframe;
	return send(
		{
			action: 'save',
			dd_api: 'dd_core_api',
			prevent_lock: true,
			source,
			data: {
				section_id: String(record),
				section_tipo: AUTHZ_SECTION,
				tipo: FRAME,
				lang: 'lg-nolan',
				from_component_tipo: FRAME,
				changed_data: [
					{
						action: 'insert',
						id: null,
						value: { section_id: labelRecord, section_tipo: AUTHZ_IRI_LABEL_SECTION },
					},
				],
			},
		},
		principal,
	);
}

const validCaller = (mainTipo: string = AUTHZ_IRI) => ({
	main_component_tipo: mainTipo,
	section_tipo: AUTHZ_SECTION,
	section_id: String(record),
	id_key: 1,
});

/** The stored frame column of the scratch record. */
async function storedFrames(): Promise<unknown[]> {
	const rows = (await sql.unsafe(
		'SELECT relation->$1 AS frames FROM matrix_test WHERE section_tipo = $2 AND section_id = $3',
		[FRAME, AUTHZ_SECTION, record],
	)) as { frames: unknown[] | null }[];
	return rows[0]?.frames ?? [];
}

/** Empty the frame column through the engine (root), between cases. */
async function clearFrames(): Promise<void> {
	const saved = await saveComponentData({
		componentTipo: FRAME,
		sectionTipo: AUTHZ_SECTION,
		sectionId: record,
		lang: 'lg-nolan',
		changedData: [{ action: 'set_data', key: null, value: [] } as never],
		userId: -1,
		callerDataframe: { main_component_tipo: AUTHZ_IRI, id_key: 1 },
	});
	if (!saved.ok) throw new Error(`clearFrames failed: ${JSON.stringify(saved)}`);
}

beforeAll(async () => {
	await installAuthzDoorFixture();
	ids = await resolveAuthzIdentities();
	root = await resolvePrincipal(-1);
	record = await createDoorRecord(AUTHZ_SECTION, AUTHZ_PROJECT_P, [
		{
			tipo: AUTHZ_IRI,
			lang: 'lg-nolan',
			value: [{ id: 1, iri: 'https://example.org/zziri', lang: 'lg-nolan' }],
		},
	]);
	// The label frame's TARGET: a dd1706 record built through the engine.
	await assertTestDatabase('subdatum_own_level_iri label record');
	labelTable = (await getMatrixTableFromTipo(AUTHZ_IRI_LABEL_SECTION)) ?? '';
	if (labelTable === '') throw new Error(`no matrix table for ${AUTHZ_IRI_LABEL_SECTION}`);
	labelRecord = await createSectionRecord(AUTHZ_IRI_LABEL_SECTION, -1, new Date());
	const saved = await saveComponentData({
		componentTipo: AUTHZ_IRI_LABEL_FIELD,
		sectionTipo: AUTHZ_IRI_LABEL_SECTION,
		sectionId: labelRecord,
		lang: 'lg-nolan',
		changedData: [
			{
				action: 'set_data',
				key: null,
				value: [{ id: 1, lang: 'lg-nolan', value: 'zziri label' }],
			} as never,
		],
		userId: -1,
	});
	if (!saved.ok) throw new Error(`label record save failed: ${JSON.stringify(saved)}`);
}, 60000);

afterAll(async () => {
	await assertTestDatabase('subdatum_own_level_iri sweep');
	if (labelRecord !== 0) {
		await deleteMatrixRecord(labelTable, AUTHZ_IRI_LABEL_SECTION, labelRecord);
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[AUTHZ_IRI_LABEL_SECTION, labelRecord],
		);
		await sweepActivityRows(AUTHZ_IRI_LABEL_SECTION, [labelRecord]);
	}
	if (record !== 0) await sweepActivityRows(AUTHZ_SECTION, [record]);
	await removeAuthzDoorFixture();
});

describe('the situation is non-degenerate', () => {
	test('the personas confer what they claim; test140 is a test3 component_iri declaring dd560', async () => {
		await assertAuthzDoorContrast(ids);
		expect(await getModelByTipo(AUTHZ_IRI)).toBe('component_iri');
		expect(await tipoBelongsToSection(AUTHZ_IRI, AUTHZ_SECTION)).toBe(true);
		expect(await getModelByTipo(FRAME)).toBe('component_dataframe');
		// The foreign-main probe: a test3 component that declares NO dd560 slot.
		expect(await getModelByTipo(AUTHZ_TEXT)).toBe('component_input_text');
		expect(record).toBeGreaterThan(0);
		expect(labelRecord).toBeGreaterThan(0);
	});
});

describe('the frame own level (getRecordComponentPermission)', () => {
	test('dd560 is 2 for any non-superuser, whatever the matrix says (the main decides)', async () => {
		clearAuthzDoorCaches();
		expect(await getRecordComponentPermission(ids.iriEditor, AUTHZ_SECTION, FRAME, record)).toBe(2);
		expect(await getRecordComponentPermission(ids.iriReader, AUTHZ_SECTION, FRAME, record)).toBe(2);
	});
});

describe('case 1 — IRI_EDITOR saves a dd560 frame through the save door', () => {
	test('commits: the frame is stored, paired to the IRI item', async () => {
		await clearFrames();
		const answer = await frameSave(ids.iriEditor, validCaller());
		expect(answer.errorCode).toBeNull();
		expect(answer.ok).toBe(true);
		const frames = (await storedFrames()) as Record<string, unknown>[];
		expect(frames.length).toBe(1);
		expect(frames[0]).toMatchObject({
			type: 'dd490',
			id_key: 1,
			section_tipo: AUTHZ_IRI_LABEL_SECTION,
			section_id: labelRecord,
			from_component_tipo: FRAME,
			main_component_tipo: AUTHZ_IRI,
		});
	});
});

describe('case 2 — IRI_EDITOR reads the frame at its main level (2)', () => {
	test('section read: frame 2', async () => {
		const answer = await sectionRead(ids.iriEditor);
		expect(answer.errorCode).toBeNull();
		expect(frameEntry(answer)?.permissions).toBe(2);
	});
	test('get_data: frame 2', async () => {
		const answer = await iriGetData(ids.iriEditor);
		expect(answer.errorCode).toBeNull();
		expect(frameEntry(answer)?.permissions).toBe(2);
	});
});

describe('case 3 — IRI_READER: the frame follows the read-only IRI', () => {
	test('section read: frame 1', async () => {
		const answer = await sectionRead(ids.iriReader);
		expect(answer.errorCode).toBeNull();
		expect(frameEntry(answer)?.permissions).toBe(1);
	});
	test('get_data: frame 1 (was max(main, 2) = 2)', async () => {
		const answer = await iriGetData(ids.iriReader);
		expect(answer.errorCode).toBeNull();
		expect(frameEntry(answer)?.permissions).toBe(1);
	});
	test('save: perm.denied, frame column unchanged', async () => {
		const before = await storedFrames();
		const answer = await frameSave(ids.iriReader, validCaller());
		expect(answer.errorCode).toBe('perm.denied');
		expect(await storedFrames()).toEqual(before);
	});
});

describe('case 4 — a fixed-frame save without a valid main is refused loudly', () => {
	const invalidMains: [string, Record<string, unknown> | null][] = [
		['no caller_dataframe at all', null],
		['caller_dataframe without main_component_tipo', { section_tipo: 'self', id_key: 1 }],
		[
			'a test3 component that declares no dd560 slot (test52)',
			{ main_component_tipo: AUTHZ_TEXT, id_key: 1 },
		],
		[
			'a component_iri of ANOTHER section (test117, test65)',
			{ main_component_tipo: FOREIGN_IRI, id_key: 1 },
		],
		['not a tipo', { main_component_tipo: 'not a tipo', id_key: 1 }],
	];
	for (const [label, caller] of invalidMains) {
		for (const persona of ['iriEditor', 'root'] as const) {
			test(`${persona}: ${label} → request.invalid_source, frame column unchanged`, async () => {
				const principal = persona === 'root' ? root : ids.iriEditor;
				const before = await storedFrames();
				const answer = await frameSave(principal, caller);
				expect(answer.errorCode).toBe('request.invalid_source');
				expect(await storedFrames()).toEqual(before);
			});
		}
	}
	test('test117 really is a component_iri outside test3 (the probe is honest)', async () => {
		expect(await getModelByTipo(FOREIGN_IRI)).toBe('component_iri');
		expect(await tipoBelongsToSection(FOREIGN_IRI, AUTHZ_SECTION)).toBe(false);
	});
});

describe('the write door itself — every record-addressed door shares the bound', () => {
	const target = () => ({ section_tipo: AUTHZ_SECTION, component_tipo: FRAME, section_id: record });
	const write = { mode: 'write', level: 2, sectionFloor: 1, door: 'zziri.probe' } as const;
	const codeOf = async (run: () => Promise<unknown>): Promise<string | null> => {
		try {
			await run();
			return null;
		} catch (error) {
			return (error as { code?: string }).code ?? String(error);
		}
	};

	test('no frameOf on a fixed slot (the MCP / tool / import doors) → request.invalid_source, root included', async () => {
		clearAuthzDoorCaches();
		for (const principal of [ids.iriEditor, root]) {
			expect(await codeOf(() => authorizeRecordAccess(principal, target(), write))).toBe(
				'request.invalid_source',
			);
		}
	});

	test('{ mainTipo }: the editor passes, the reader is refused on the pair', async () => {
		clearAuthzDoorCaches();
		const options = { ...write, frameOf: { mainTipo: AUTHZ_IRI } };
		expect(await codeOf(() => authorizeRecordAccess(ids.iriEditor, target(), options))).toBeNull();
		expect(await codeOf(() => authorizeRecordAccess(ids.iriReader, target(), options))).toBe(
			'perm.denied',
		);
	});

	test('{ everyMain } (a whole-record restore): bound by every main of the section declaring the slot', async () => {
		clearAuthzDoorCaches();
		const options = { ...write, frameOf: { everyMain: true } } as const;
		// test140 is test3's only component_iri: the editor (2) passes, the reader (1) does not.
		expect(await codeOf(() => authorizeRecordAccess(ids.iriEditor, target(), options))).toBeNull();
		expect(await codeOf(() => authorizeRecordAccess(ids.iriReader, target(), options))).toBe(
			'perm.denied',
		);
		expect(await codeOf(() => authorizeRecordAccess(root, target(), options))).toBeNull();
	});

	test('frameOf is ignored on a non-slot component (callers may pass it on every write)', async () => {
		clearAuthzDoorCaches();
		const options = { ...write, frameOf: { mainTipo: 'not a tipo' } };
		const iri = { section_tipo: AUTHZ_SECTION, component_tipo: AUTHZ_IRI, section_id: record };
		expect(await codeOf(() => authorizeRecordAccess(ids.iriEditor, iri, options))).toBeNull();
	});

	test('a section-target door on a fixed slot → request.invalid_source (no main to name)', async () => {
		clearAuthzDoorCaches();
		for (const principal of [ids.iriEditor, root]) {
			expect(
				await codeOf(() =>
					authorizeSectionTarget(
						principal,
						{ section_tipo: AUTHZ_SECTION, tipo: FRAME },
						{ level: 2, door: 'zziri.probe' },
					),
				),
			).toBe('request.invalid_source');
		}
	});
});

describe('case 4b — a DIRECT read of the slot (source.tipo = dd560) is bound by its main (A residual)', () => {
	/** A get_data whose SOURCE is the frame slot itself (common.js create_source on a dataframe). */
	const frameRead = (callerDataframe: Record<string, unknown> | null) => {
		const source: Record<string, unknown> = {
			typo: 'source',
			type: 'component',
			action: 'get_data',
			model: 'component_dataframe',
			tipo: FRAME,
			section_tipo: AUTHZ_SECTION,
			section_id: record,
			mode: 'edit',
			lang: 'lg-nolan',
		};
		if (callerDataframe !== null) source.caller_dataframe = callerDataframe;
		return { action: 'read', dd_api: 'dd_core_api', prevent_lock: true, source };
	};
	const withMain = { main_component_tipo: AUTHZ_IRI, section_tipo: AUTHZ_SECTION, id_key: 1 };
	const noMain = { main_component_tipo: null, section_tipo: AUTHZ_SECTION, id_key: 1 };

	test('the CONTROL (test3 = 2, the IRI at 0): Gate A refuses — with the main named, with a null main, with none', async () => {
		clearAuthzDoorCaches();
		expect(await getRecordComponentPermission(ids.control, AUTHZ_SECTION, AUTHZ_IRI, record)).toBe(
			0,
		);
		for (const caller of [withMain, noMain, null]) {
			const answer = await send(frameRead(caller), ids.control);
			expect({ caller, code: answer.errorCode }).toEqual({ caller, code: 'perm.denied' });
		}
	});

	test('the CONTROL past Gate A (the facade self-gate): the empty shell, never the frame', async () => {
		clearAuthzDoorCaches();
		for (const caller of [withMain, noMain, null]) {
			const result = await routeSectionRead(frameRead(caller) as never, ids.control);
			const body = result.body as { data?: { context?: unknown[]; data?: unknown[] } };
			expect({ caller, context: body.data?.context, data: body.data?.data }).toEqual({
				caller,
				context: [],
				data: [],
			});
		}
	});

	test('IRI_READER: admitted, the frame stamped at its main (1); IRI_EDITOR at 2', async () => {
		for (const [principal, level] of [
			[ids.iriReader, 1],
			[ids.iriEditor, 2],
		] as const) {
			for (const caller of [withMain, noMain]) {
				const answer = await send(frameRead(caller), principal);
				expect({ caller, code: answer.errorCode }).toEqual({ caller, code: null });
				expect({ caller, level: frameEntry(answer)?.permissions }).toEqual({ caller, level });
			}
		}
	});

	test('a main that is not a main of the slot on this section → request.invalid_source', async () => {
		for (const main of [AUTHZ_TEXT, FOREIGN_IRI, 'not a tipo']) {
			const answer = await send(
				frameRead({ main_component_tipo: main, section_tipo: AUTHZ_SECTION, id_key: 1 }),
				ids.iriEditor,
			);
			expect({ main, code: answer.errorCode }).toEqual({ main, code: 'request.invalid_source' });
		}
	});
});

// ── FIX 2 — an import naming an IRI's label frames judges them by their main ──
//
// The CSV importer asks the write door for every slot a legacy {data, dataframe}
// envelope's frames name — and for a FIXED slot (dd560) the door requires the
// main. Asked without it, the door's request.invalid_source escaped the
// IGNORED mapping and rolled the whole row back, for writer and reader alike.

describe('fix 2 — CSV import of an IRI column carrying dd560 label frames', () => {
	const bulkIds: number[] = [];
	afterAll(async () => {
		await assertTestDatabase('subdatum_own_level_iri: dd800 sweep');
		const table = await getMatrixTableFromTipo('dd800');
		if (table === null) throw new Error('no matrix table for dd800');
		for (const id of bulkIds) {
			if ((await deleteMatrixRecord(table, 'dd800', id)) === 0) {
				throw new Error(`dd800/${id} sweep removed 0 rows`);
			}
			await sql.unsafe(
				'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
				['dd800', id],
			);
		}
		await sweepActivityRows('dd800', bulkIds);
	});

	/** One CSV row: section_id + the IRI cell as a LEGACY {data, dataframe} envelope (dedalo_data-wrapped). */
	async function importIri(principal: Principal, iri: string) {
		const cell = JSON.stringify({
			dedalo_data: {
				data: [{ id: 1, iri, lang: 'lg-nolan' }],
				dataframe: [
					{
						from_component_tipo: FRAME,
						id_key: 1,
						section_tipo: AUTHZ_IRI_LABEL_SECTION,
						section_id: labelRecord,
					},
				],
			},
		});
		const plan = await planCsvImport(
			[[String(record), cell]],
			[
				{
					tipo: 'section_id',
					model: 'component_section_id',
					columnName: 'section_id',
					lang: 'lg-nolan',
				},
				{ tipo: AUTHZ_IRI, model: 'component_iri', columnName: AUTHZ_IRI, lang: 'lg-nolan' },
			],
			AUTHZ_SECTION,
		);
		const bulkProcessId = await createSectionRecord('dd800', -1);
		bulkIds.push(bulkProcessId);
		clearAuthzDoorCaches();
		return executeCsvImport({
			plan,
			sectionTipo: AUTHZ_SECTION,
			principal,
			bulkProcessId,
			errors: [],
			notices: [],
			progress: {
				file: 'zziri.csv',
				fileIndex: 1,
				filesTotal: 1,
				labels: new Map(),
				publish: () => {},
			},
		});
	}

	async function storedIri(): Promise<string> {
		const rows = (await sql.unsafe(
			'SELECT iri->$1 AS value FROM matrix_test WHERE section_tipo = $2 AND section_id = $3',
			[AUTHZ_IRI, AUTHZ_SECTION, record],
		)) as { value: unknown }[];
		return JSON.stringify(rows[0]?.value ?? null);
	}

	test('IRI_EDITOR: the row commits — the IRI and its label frame written', async () => {
		await clearFrames();
		const report = await importIri(ids.iriEditor, 'https://example.org/zziri-import-editor');
		expect(report.failed).toEqual([]);
		expect(report.updated).toEqual([record]);
		expect(await storedIri()).toContain('zziri-import-editor');
		const frames = (await storedFrames()) as Record<string, unknown>[];
		expect(frames.length).toBe(1);
		expect(frames[0]).toMatchObject({
			section_tipo: AUTHZ_IRI_LABEL_SECTION,
			section_id: labelRecord,
			main_component_tipo: AUTHZ_IRI,
		});
	});

	test('IRI_READER: the column IGNORED by the door (perm.denied), the row NOT rolled back, nothing written', async () => {
		await clearFrames();
		const before = await storedIri();
		const report = await importIri(ids.iriReader, 'https://example.org/zziri-import-reader');
		expect(report.failed.length).toBeGreaterThan(0);
		for (const failure of report.failed) {
			expect(String(failure.msg)).toContain('not writable by the importer (perm.denied)');
			expect(String(failure.msg)).not.toContain('rolled back');
		}
		expect(await storedIri()).toBe(before);
		expect(await storedFrames()).toEqual([]);
	});

	test('the mapped-record importer (MARC21/Zotero/RDF): a field naming the fixed slot is IGNORED, the record not rolled back', async () => {
		clearAuthzDoorCaches();
		const report = await importMappedRecords(
			[{ sectionId: record, fields: [{ component_tipo: FRAME, values: ['x'] }] }],
			AUTHZ_SECTION,
			ids.iriEditor,
		);
		if (typeof report.bulkProcessId === 'number') bulkIds.push(report.bulkProcessId);
		// The FIELD is refused (its own report line, component_tipo = the slot) —
		// never the RECORD rolled back ("the record was not written").
		expect(report.updated).toBe(1);
		expect(report.failed.length).toBe(1);
		expect(report.failed[0]?.component_tipo).toBe(FRAME);
		expect(String(report.failed[0]?.msg)).toContain('IGNORED');
		expect(String(report.failed[0]?.msg)).not.toContain('the record was not written');
		expect(await storedFrames()).toEqual([]);
	});
});

// ── FIX 3 — a direct dd560 read naming a main WITHOUT a complete pairing ──────
//
// Without an id_key the read is not paired (callerDataframePairing): the read
// serves the WHOLE slot — every main's frames — so it must be bound by every
// main of the section (everyMain), not by the one main the caller named.

describe('fix 3 — a dd560 read naming one main without an id_key is bound by EVERY main', () => {
	const splitRead = (callerDataframe: Record<string, unknown>) => ({
		action: 'read',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		source: {
			typo: 'source',
			type: 'component',
			action: 'get_data',
			model: 'component_dataframe',
			tipo: FRAME,
			section_tipo: AUTHZ_IRI_SPLIT_SECTION,
			section_id: 1,
			mode: 'edit',
			lang: 'lg-nolan',
			caller_dataframe: callerDataframe,
		},
	});

	test('the situation: two IRIs of one section, the editor at A=1, B=0', async () => {
		clearAuthzDoorCaches();
		for (const tipo of [AUTHZ_IRI_SPLIT_A, AUTHZ_IRI_SPLIT_B]) {
			expect(await getModelByTipo(tipo)).toBe('component_iri');
			expect(await tipoBelongsToSection(tipo, AUTHZ_IRI_SPLIT_SECTION)).toBe(true);
		}
		const level = (tipo: string) =>
			getRecordComponentPermission(ids.iriEditor, AUTHZ_IRI_SPLIT_SECTION, tipo, 1);
		expect(await level(AUTHZ_IRI_SPLIT_A)).toBe(1);
		expect(await level(AUTHZ_IRI_SPLIT_B)).toBe(0);
	});

	test('A named WITH an id_key (a paired read: A’s frames only) → A’s level, 1', async () => {
		clearAuthzDoorCaches();
		const source = splitRead({ main_component_tipo: AUTHZ_IRI_SPLIT_A, id_key: 1 }).source;
		expect(await sourceComponentLevel(ids.iriEditor, source, 'test')).toBe(1);
	});

	test('A named WITHOUT an id_key (the whole slot) → min over every main, 0; Gate A refuses', async () => {
		for (const caller of [
			{ main_component_tipo: AUTHZ_IRI_SPLIT_A },
			{ main_component_tipo: AUTHZ_IRI_SPLIT_A, id_key: 0 },
			{ main_component_tipo: AUTHZ_IRI_SPLIT_A, id_key: null },
		]) {
			clearAuthzDoorCaches();
			const source = splitRead(caller).source;
			expect({ caller, level: await sourceComponentLevel(ids.iriEditor, source, 'test') }).toEqual({
				caller,
				level: 0,
			});
			const answer = await send(splitRead(caller), ids.iriEditor);
			expect({ caller, code: answer.errorCode }).toEqual({ caller, code: 'perm.denied' });
		}
	});
});
