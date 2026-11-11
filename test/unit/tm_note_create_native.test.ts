/**
 * T0-4 part B — `dd_component_text_area_api::create_tm_note`, THE ONE DOOR that
 * creates a Time Machine note (the engine's TM-notes section), bound to its TM row at birth (owner
 * Q-a + Q-b, 2026-11-10; rewrite plan §3.4, cases 12 + 16).
 *
 * THE RULE. A TM note is valid ONLY when created from the Time Machine and bound
 * to its matrix_time_machine row at creation. Users never write nor choose the
 * Code (= the TM row id): the SERVER writes it, in the same transaction
 * that creates the record. The creator must be the AUTHOR of the TM change and
 * must have TM ACCESS to it (`canAccessTimeMachineList` on the annotated
 * section — a global admin passes that half, never the authorship half). The
 * action is the whole admission: the caller holds NO notes-section grant.
 *
 * Before this door the client did it in two requests — a generic `create` on
 * the notes section (section-level create) then a client `save` of the Code — so a note was
 * born unbound, its Code was a user-written value, and the "only the author"
 * rule lived in the client alone.
 *
 * Cases:
 *   - author with TM access → ONE notes record, Code = matrix_id, dd200 =
 *     caller, its Code write TM-audited; a second call → the same id, no row;
 *   - a note already binding the row (a legacy, root-made one) → its id;
 *   - non-author (TM access) / author without TM access / root non-author / a
 *     well-formed id naming NO row → the SAME perm.denied (no existence oracle:
 *     a caller cannot tell an unknown row from one that is not theirs);
 *     malformed / absent matrix_id → request.invalid_data — each leaves the
 *     notes row set UNCHANGED;
 *   - a failed Code write rolls the whole creation back (no notes record, no NEW
 *     activity row); two concurrent creates for one row make ONE note;
 *   - F5 (read): the TM note cell serves `tm_user_id` = the TM row author and
 *     `created_by_user_id` = the NOTE record's dd200 creator (null: no note).
 *
 * SITUATION: test/helpers/tm_note_fixture.ts (identities + engine-built TM rows on
 * test6100, swept loudly); every note the action creates is found by its Code and
 * swept; activity rows of the run are swept and asserted gone.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { ApiRequestContext } from '../../src/core/api/dispatch.ts';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { readTimeMachineData } from '../../src/core/resolve/read_tm.ts';
import { runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';
import {
	canAccessTimeMachineList,
	getTimeMachineListTipo,
} from '../../src/core/section/list_definitions/time_machine_list.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import * as saveModule from '../../src/core/section/record/save_component.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import {
	getPermissions,
	type Principal,
	resolvePrincipal,
} from '../../src/core/security/permissions.ts';
import { createSession, getSession, type Session } from '../../src/core/security/session_store.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import {
	TM_NOTES_CODE_TIPO,
	TM_NOTES_SECTION_TIPO,
	TM_NOTES_TEXT,
} from '../../src/core/tm_record/tm_record.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';
import {
	installTmNoteFixture,
	mintTmRow,
	removeTmNoteFixture,
	resolveTmNoteIdentities,
	TM_NOTE_SECTION,
	TM_NOTE_TM_LIST,
	type TmNoteIdentities,
	trackTmNoteRecord,
} from '../helpers/tm_note_fixture.ts';

registerSessionCleanup();

const ROOT = -1;
const LANG = 'lg-spa';

let ids: TmNoteIdentities;
let root: Principal;
let notesTable = '';
let activityStart = 0;
const sessions = new Map<number, Session>();

/** The rows the gate minted. */
let authorRow = { tmRowId: 0, sectionId: 0 };
let legacyRow = { tmRowId: 0, sectionId: 0 };
let unnotedRow = { tmRowId: 0, sectionId: 0 };
let noTmRow = { tmRowId: 0, sectionId: 0 };
let legacyNoteId = 0;

function contextFor(principal: Principal): ApiRequestContext {
	let session = sessions.get(principal.userId);
	if (session === undefined) {
		const token = createSession(
			principal.userId,
			`zztmnote_${principal.userId}`,
			principal.isGlobalAdmin,
		);
		session = getSession(token) as Session;
		sessions.set(principal.userId, session);
	}
	return {
		requestId: crypto.randomUUID(),
		clientIp: '127.0.0.1',
		session,
		csrfCandidate: session.csrfToken,
		principal,
	} as ApiRequestContext;
}

interface Answer {
	code: string | null;
	status: number;
	data?: unknown;
	/** The wire error object (the refusal's whole shape — the oracle probe compares it). */
	error?: unknown;
	/** The owned extension key: whether THIS call created the note. */
	created?: unknown;
}

async function createTmNote(principal: Principal, matrixId: unknown): Promise<Answer> {
	const result = await dispatchRqo(
		{
			action: 'create_tm_note',
			dd_api: 'dd_component_text_area_api',
			options: { matrix_id: matrixId },
		} as unknown as Rqo,
		contextFor(principal),
	);
	const body = result.body as
		| { ok?: boolean; data?: unknown; error?: { code?: string }; created?: unknown }
		| undefined;
	return {
		code: body?.error?.code ?? null,
		status: result.status,
		data: body?.data,
		error: body?.error,
		created: body?.created,
	};
}

/** Every notes-section section_id (a set, never a max: the counter sits far above fixtures). */
async function noteIds(): Promise<number[]> {
	const rows = (await sql.unsafe(
		`SELECT section_id FROM "${notesTable}" WHERE section_tipo = $1 ORDER BY section_id`,
		[TM_NOTES_SECTION_TIPO],
	)) as { section_id: number | string }[];
	return rows.map((row) => Number(row.section_id));
}

/** The notes records whose Code binds `tmRowId` (tm_record.ts tmNoteValue's predicate). */
async function notesBinding(tmRowId: number): Promise<number[]> {
	const rows = (await sql.unsafe(
		`SELECT section_id FROM "${notesTable}"
		  WHERE section_tipo = $1
		    AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(number->$2, '[]'::jsonb)) AS code
		                WHERE code->>'value' = $3)
		  ORDER BY section_id`,
		[TM_NOTES_SECTION_TIPO, TM_NOTES_CODE_TIPO, String(tmRowId)],
	)) as { section_id: number | string }[];
	const found = rows.map((row) => Number(row.section_id));
	for (const id of found) trackTmNoteRecord(TM_NOTES_SECTION_TIPO, id);
	return found;
}

async function noteRow(sectionId: number) {
	const rows = (await sql.unsafe(
		`SELECT number->$3 AS code, relation->'dd200' AS creator
		   FROM "${notesTable}" WHERE section_tipo = $1 AND section_id = $2`,
		[TM_NOTES_SECTION_TIPO, sectionId, TM_NOTES_CODE_TIPO],
	)) as { code: { value?: unknown }[] | null; creator: { section_id?: unknown }[] | null }[];
	return rows[0];
}

/** The dd15 note cell of one TM row (read through the real TM reader). */
async function noteCell(sectionId: number, tmRowId: number): Promise<Record<string, unknown>> {
	const { data } = await runWithRequestLangs({ applicationLang: LANG, dataLang: LANG }, () =>
		readTimeMachineData({
			source: { lang: LANG },
			sqo: {
				section_tipo: ['dd15'],
				limit: 20,
				offset: 0,
				filter_by_locators: [{ section_tipo: TM_NOTE_SECTION, section_id: sectionId }],
			},
			show: { ddo_map: [{ tipo: TM_NOTES_TEXT }] },
		} as never),
	);
	const items = (data.slice(1) as Record<string, unknown>[]).filter(
		(item) => item.row_section_id === tmRowId && item.tipo === TM_NOTES_TEXT,
	);
	expect(items.length, `one note cell for TM row ${tmRowId}`).toBe(1);
	return items[0] as Record<string, unknown>;
}

beforeAll(async () => {
	await assertTestDatabase('tm_note_create_native');
	const table = await getMatrixTableFromTipo(TM_NOTES_SECTION_TIPO);
	if (table === null) throw new Error('the TM-notes section has no matrix table');
	notesTable = table;
	const activity = (await sql`
		SELECT COALESCE(MAX(section_id), 0)::int AS max FROM matrix_activity
	`) as { max: number }[];
	activityStart = activity[0]?.max ?? 0;
	await installTmNoteFixture();
	ids = await resolveTmNoteIdentities();
	root = await resolvePrincipal(ROOT);

	authorRow = await mintTmRow(ids.author.userId, 'authored change');
	legacyRow = await mintTmRow(ids.author.userId, 'legacy-noted change');
	unnotedRow = await mintTmRow(ids.author.userId, 'never noted');
	noTmRow = await mintTmRow(ids.noTm.userId, 'authored without TM access');

	// A LEGACY note (the pre-door two-request flow, made by root): bound to an
	// AUTHOR row, created by someone else — the F5 contrast (TM author ≠ note
	// creator) and the "already bound → its id" case.
	legacyNoteId = await createSectionRecord(TM_NOTES_SECTION_TIPO, ROOT);
	trackTmNoteRecord(TM_NOTES_SECTION_TIPO, legacyNoteId);
	const saved = await saveComponentData({
		componentTipo: TM_NOTES_CODE_TIPO,
		sectionTipo: TM_NOTES_SECTION_TIPO,
		sectionId: legacyNoteId,
		lang: 'lg-nolan',
		changedData: [
			{ action: 'set_data', key: null, value: [{ value: legacyRow.tmRowId }] } as never,
		],
		userId: ROOT,
	});
	if (!saved.ok) throw new Error(`legacy note code save failed: ${JSON.stringify(saved)}`);
}, 60_000);

afterAll(async () => {
	await assertTestDatabase('tm_note_create_native: sweep');
	const ACTIVITY_OF_RUN = `section_tipo = 'dd542' AND section_id > $1 AND (
		   relation->'dd543'->0->>'section_id' = ANY(string_to_array($2, ','))
		OR (misc->'dd551'->0->'value'->>'section_tipo') = ANY(string_to_array($3, ',')))`;
	const params = [
		activityStart,
		[ids.author.userId, ids.other.userId, ids.noTm.userId].join(','),
		[TM_NOTE_SECTION, TM_NOTES_SECTION_TIPO].join(','),
	];
	// Root's activity on the two sections this run built in (root is no fixture
	// identity, so it is addressed by the WHERE, above the watermark only).
	await sql.unsafe(`DELETE FROM matrix_activity WHERE ${ACTIVITY_OF_RUN}`, params);
	for (const tmRowId of [
		authorRow.tmRowId,
		legacyRow.tmRowId,
		unnotedRow.tmRowId,
		noTmRow.tmRowId,
	]) {
		if (tmRowId > 0) await notesBinding(tmRowId);
	}
	await removeTmNoteFixture();
	const left = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM matrix_activity WHERE ${ACTIVITY_OF_RUN}`,
		params,
	)) as { n: number }[];
	expect(left[0]?.n).toBe(0);
});

describe('the situation (asserted, never trusted)', () => {
	test('TM access is the §7.4 grant; nobody may create in the notes section', async () => {
		expect(await getTimeMachineListTipo(TM_NOTE_SECTION)).toBe(TM_NOTE_TM_LIST);
		expect(await canAccessTimeMachineList(ids.author, TM_NOTE_SECTION)).toBe(true);
		expect(await canAccessTimeMachineList(ids.other, TM_NOTE_SECTION)).toBe(true);
		expect(await canAccessTimeMachineList(ids.noTm, TM_NOTE_SECTION)).toBe(false);
		for (const principal of [ids.author, ids.other, ids.noTm]) {
			expect(principal.isGlobalAdmin).toBe(false);
			// The admission is the ACTION: a section-level create (≥ 2) refuses them.
			expect(
				await getPermissions(principal, TM_NOTES_SECTION_TIPO, TM_NOTES_SECTION_TIPO),
			).toBeLessThan(2);
		}
		expect(root.isGlobalAdmin).toBe(true);
		expect(await notesBinding(authorRow.tmRowId)).toEqual([]);
		expect(await notesBinding(legacyRow.tmRowId)).toEqual([legacyNoteId]);
	});
});

describe('refusals leave the notes row set unchanged', () => {
	const refusals: [string, () => Principal, () => unknown, string, number][] = [
		['a non-author (with TM access)', () => ids.other, () => authorRow.tmRowId, 'perm.denied', 403],
		['the author WITHOUT TM access', () => ids.noTm, () => noTmRow.tmRowId, 'perm.denied', 403],
		['root, not the author', () => root, () => authorRow.tmRowId, 'perm.denied', 403],
		// Well-formed, names no row: the SAME refusal as a row that is not yours (fix 5).
		['an unknown matrix_id', () => ids.author, () => 2_000_000_000, 'perm.denied', 403],
		['a malformed matrix_id', () => ids.author, () => 'abc', 'request.invalid_data', 400],
		['an absent matrix_id', () => ids.author, () => undefined, 'request.invalid_data', 400],
	];
	for (const [label, principal, matrixId, code, status] of refusals) {
		test(`${label} → ${code}`, async () => {
			const before = await noteIds();
			const answer = await createTmNote(principal(), matrixId());
			expect({ code: answer.code, status: answer.status }).toEqual({ code, status });
			expect(await noteIds()).toEqual(before);
		});
	}
});

describe('the author with TM access creates ONE bound note', () => {
	let created = 0;

	test('one notes record: Code = matrix_id, dd200 = caller, Code TM-audited', async () => {
		const before = await noteIds();
		const answer = await createTmNote(ids.author, authorRow.tmRowId);
		expect(answer.code).toBeNull();
		expect(answer.status).toBe(200);
		created = Number((answer.data as { section_id?: unknown } | undefined)?.section_id);
		expect(Number.isInteger(created) && created > 0).toBe(true);
		trackTmNoteRecord(TM_NOTES_SECTION_TIPO, created);
		const after = await noteIds();
		expect(after.filter((id) => !before.includes(id))).toEqual([created]);
		expect(await notesBinding(authorRow.tmRowId)).toEqual([created]);
		const row = await noteRow(created);
		expect(row?.code?.map((item) => Number(item.value))).toEqual([authorRow.tmRowId]);
		expect(row?.creator?.map((item) => Number(item.section_id))).toEqual([ids.author.userId]);
		// The Code write went through the save chokepoint: audited in the notes section's own TM.
		const audit = (await sql.unsafe(
			`SELECT user_id FROM matrix_time_machine
			  WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3`,
			[TM_NOTES_SECTION_TIPO, created, TM_NOTES_CODE_TIPO],
		)) as { user_id: number }[];
		expect(audit.map((r) => Number(r.user_id))).toEqual([ids.author.userId]);
	});

	test('a second call answers the SAME id and creates nothing', async () => {
		expect(created).toBeGreaterThan(0);
		const before = await noteIds();
		const answer = await createTmNote(ids.author, authorRow.tmRowId);
		expect(answer.code).toBeNull();
		expect(Number((answer.data as { section_id?: unknown }).section_id)).toBe(created);
		expect(await noteIds()).toEqual(before);
	});

	test('a row already bound (a legacy note) answers that note, creates nothing', async () => {
		const before = await noteIds();
		const answer = await createTmNote(ids.author, legacyRow.tmRowId);
		expect(answer.code).toBeNull();
		expect(Number((answer.data as { section_id?: unknown }).section_id)).toBe(legacyNoteId);
		expect(await noteIds()).toEqual(before);
	});
});

describe('F5 — the TM note cell names both users, each under its own key', () => {
	test('a door-made note: tm_user_id = the row author, created_by_user_id = the note creator', async () => {
		const cell = await noteCell(authorRow.sectionId, authorRow.tmRowId);
		expect(cell.tm_user_id).toBe(ids.author.userId);
		expect(cell.created_by_user_id).toBe(ids.author.userId);
	});

	test('a legacy note made by root on the author’s row: the two keys DIFFER', async () => {
		const cell = await noteCell(legacyRow.sectionId, legacyRow.tmRowId);
		expect(cell.parent_section_id).toBe(legacyNoteId);
		expect(cell.tm_user_id).toBe(ids.author.userId);
		expect(cell.created_by_user_id).toBe(ROOT);
	});

	test('no note: created_by_user_id is null, tm_user_id still the author', async () => {
		const cell = await noteCell(unnotedRow.sectionId, unnotedRow.tmRowId);
		expect(cell.parent_section_id).toBeNull();
		expect(cell.tm_user_id).toBe(ids.author.userId);
		expect(cell.created_by_user_id).toBeNull();
	});
});

describe('fix 5 — no existence oracle: an unknown row and a row not yours answer ALIKE', () => {
	test('the whole wire error is the same shape (only the id differs)', async () => {
		const unknownId = 2_000_000_001;
		const unknown = await createTmNote(ids.other, unknownId);
		const notYours = await createTmNote(ids.other, authorRow.tmRowId);
		const noAccess = await createTmNote(ids.noTm, noTmRow.tmRowId);
		// Normalized: the row id and the caller's own user id (known to the caller).
		const shape = (answer: Answer, id: number, principal: Principal) =>
			JSON.stringify({ status: answer.status, error: answer.error })
				.replaceAll(String(id), '<id>')
				.replaceAll(String(principal.userId), '<user>')
				.replace(/"request_id":"[^"]*"/g, '');
		expect(unknown.code).toBe('perm.denied');
		expect(shape(unknown, unknownId, ids.other)).toBe(
			shape(notYours, authorRow.tmRowId, ids.other),
		);
		expect(shape(noAccess, noTmRow.tmRowId, ids.noTm)).toBe(
			shape(notYours, authorRow.tmRowId, ids.other),
		);
	});
});

describe('fix 6 — atomicity: a failed binding rolls the creation back; a race makes ONE note', () => {
	/** NEW activity rows about the notes section above the run's watermark. */
	async function notesActivity(): Promise<number> {
		const rows = (await sql.unsafe(
			`SELECT count(*)::int AS n FROM matrix_activity
			  WHERE section_tipo = 'dd542' AND section_id > $1
			    AND misc->'dd551'->0->'value'->>'section_tipo' = $2`,
			[activityStart, TM_NOTES_SECTION_TIPO],
		)) as { n: number }[];
		return rows[0]?.n ?? -1;
	}

	for (const failure of ['answers ok:false', 'throws'] as const) {
		test(`the Code save ${failure} → refused, NO notes record and NO new activity row remain`, async () => {
			const row = await mintTmRow(ids.author.userId, `rollback probe (${failure})`);
			const original = saveModule.saveComponentData;
			let codeSaves = 0;
			const spy = spyOn(saveModule, 'saveComponentData').mockImplementation(async (input) => {
				if (input.componentTipo !== TM_NOTES_CODE_TIPO) return original(input);
				codeSaves++;
				if (failure === 'throws') throw new Error('zz forced Code save failure');
				return { ok: false, message: 'zz forced Code save failure' } as never;
			});
			const beforeNotes = await noteIds();
			const beforeActivity = await notesActivity();
			let answer: Answer;
			try {
				answer = await createTmNote(ids.author, row.tmRowId);
			} finally {
				spy.mockRestore();
			}
			// Non-vacuous: the forced failure is what the call met.
			expect(codeSaves).toBe(1);
			expect(answer.code).not.toBeNull();
			const after = await noteIds();
			for (const id of after.filter((n) => !beforeNotes.includes(n))) {
				trackTmNoteRecord(TM_NOTES_SECTION_TIPO, id);
			}
			expect(after).toEqual(beforeNotes);
			expect(await notesBinding(row.tmRowId)).toEqual([]);
			expect(await notesActivity()).toBe(beforeActivity);
		});
	}

	test('two concurrent creates for ONE row → one note, both answer its id (one created, one found)', async () => {
		const row = await mintTmRow(ids.author.userId, 'race probe');
		const before = await noteIds();
		const [first, second] = await Promise.all([
			createTmNote(ids.author, row.tmRowId),
			createTmNote(ids.author, row.tmRowId),
		]);
		const made = (await noteIds()).filter((id) => !before.includes(id));
		for (const id of made) trackTmNoteRecord(TM_NOTES_SECTION_TIPO, id);
		expect([first.code, second.code]).toEqual([null, null]);
		expect(made.length).toBe(1);
		const idOf = (answer: Answer) => Number((answer.data as { section_id?: unknown }).section_id);
		expect([idOf(first), idOf(second)]).toEqual([made[0] ?? -1, made[0] ?? -1]);
		expect([first.created, second.created].sort()).toEqual([false, true]);
		expect(await notesBinding(row.tmRowId)).toEqual(made);
	});
});
