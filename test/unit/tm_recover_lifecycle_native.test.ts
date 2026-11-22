/**
 * THE RECOVER OF A DELETED RECORD, AS THE OPERATOR SEES IT AFTERWARDS (T2
 * O16-02 / O16-03; WC-2026-11-22-tm-recover-consumes-deleted-listing).
 *
 * A record is deleted (its whole-record snapshot is the delete's Time Machine
 * row), listed in the section's deleted-records list (tool_time_machine on a
 * section caller: `filter tipo = <section>`), then recovered through
 * `tool_time_machine.apply_value`. Afterwards:
 *
 *  - O16-02: the recovered record is NO LONGER offered in the deleted list. The
 *    snapshot row is KEPT as history (nothing is deleted — FYI-4, owner
 *    2026-11-19): the list offers a whole-record row only while it is the
 *    record's LATEST visible whole-record row and the record is not live. A
 *    second delete lists only the second snapshot.
 *  - the record's history is still readable (the snapshot row by id, the
 *    component history through filter_by_locators).
 *  - O16-03: the section's stored navigation SQO (the session's `sqo_session`
 *    entry for that section — filter, offset) is DROPPED after the restore
 *    commits, so the next list read starts clean; the other sections' entries
 *    stay.
 *
 * BUILT: a `zztmr` scratch section on test1 (→ matrix_test) with one
 * non-translatable input_text; its record created, saved, deleted and
 * recovered by the real doors; a real persisted session (the test session
 * store). Swept by dropSituation (rows + TM rows) and the session cleanup.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readMatrixRecord } from '../../src/core/db/matrix.ts';
import { readTimeMachineRow } from '../../src/core/db/time_machine.ts';
import { countTimeMachineData, readTimeMachineData } from '../../src/core/resolve/read_tm.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { deleteSectionRecord } from '../../src/core/section/record/delete_record.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { runWithRequestContext } from '../../src/core/security/request_context.ts';
import {
	createSession,
	getSession,
	type Session,
	setSessionSqo,
} from '../../src/core/security/session_store.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { toolTimeMachineApplyValue } from '../../tools/tool_time_machine/server/tool_time_machine.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

registerSessionCleanup();

const SECTION = 'zztmr1';
const TEXT = 'zztmr2';
const TABLE = 'matrix_test';
const USER_ID = -1;
/** Another section's stored SQO — must survive the drop. */
const OTHER_SECTION = 'test3';

const SITUATION = situation({
	tld: 'zztmr',
	name: 'tm_recover_lifecycle',
	nodes: [
		{ tipo: SECTION, parent: 'test1', model: 'section', term: { 'lg-eng': 'TM recover' } },
		{
			tipo: TEXT,
			parent: SECTION,
			model: 'component_input_text',
			term: { 'lg-eng': 'Text' },
			is_translatable: false,
		},
	],
});

const STALE_SQO = {
	section_tipo: [SECTION],
	limit: 10,
	offset: 40,
	filter: { $and: [{ q: 'stale', path: [{ section_tipo: SECTION, component_tipo: TEXT }] }] },
};

/** The deleted-records list of the section: its matrix ids (newest first) + the count twin. */
async function deletedList(): Promise<{ ids: number[]; count: number }> {
	const sqo = { filter: { $and: [{ q: SECTION, column_name: 'tipo' }] } };
	const { data } = await readTimeMachineData({
		sqo: { limit: 50, offset: 0, ...sqo },
		source: { lang: 'lg-nolan' },
	} as never);
	const ids = ((data[0] as { entries?: { matrix_id: number }[] }).entries ?? []).map((entry) =>
		Number(entry.matrix_id),
	);
	return { ids, count: await countTimeMachineData({ sqo } as never) };
}

/** The newest whole-record TM row of the record (the delete snapshot just written). */
async function newestWholeRow(): Promise<number> {
	const { sql } = await import('../../src/core/db/postgres.ts');
	const rows = (await sql.unsafe(
		`SELECT max(id)::int AS id FROM matrix_time_machine
		 WHERE section_tipo = $1 AND section_id = $2 AND tipo = $1`,
		[SECTION, recordId],
	)) as { id: number | null }[];
	return Number(rows[0]?.id ?? 0);
}

let recordId = 0;
let firstDelete = 0;
let sessionToken = '';
let session: Session;

beforeAll(async () => {
	await assertTestDatabase('tm_recover_lifecycle_native');
	await ensureSituation(SITUATION);
	recordId = await createSectionRecord(SECTION, USER_ID);
	await saveComponentData({
		componentTipo: TEXT,
		sectionTipo: SECTION,
		sectionId: recordId,
		lang: 'lg-nolan',
		changedData: [{ action: 'set_data', value: [{ id: 1, lang: 'lg-nolan', value: 'kept' }] }],
		userId: USER_ID,
	} as never);
	await deleteSectionRecord(SECTION, recordId, USER_ID);
	firstDelete = await newestWholeRow();

	sessionToken = createSession(USER_ID, 'root', true);
	session = getSession(sessionToken) as Session;
	setSessionSqo(session, SECTION, structuredClone(STALE_SQO));
	setSessionSqo(session, OTHER_SECTION, { section_tipo: [OTHER_SECTION], offset: 20 });
}, 60_000);

afterAll(async () => {
	expect(await dropSituation(SITUATION)).toBe(0);
});

describe('recover a deleted record through apply_value', () => {
	test('precondition: the deleted record is listed, once', async () => {
		expect(firstDelete).toBeGreaterThan(0);
		expect(await readMatrixRecord(TABLE, SECTION, recordId)).toBeNull();
		expect(await deletedList()).toEqual({ ids: [firstDelete], count: 1 });
		expect(getSession(sessionToken)?.sqoSession?.[SECTION]).toEqual(STALE_SQO);
	});

	test('the recover lands: the record lives again', async () => {
		const response = await runWithRequestContext(
			{ session, requestId: 'tm-recover-lifecycle', clientIp: '127.0.0.1' },
			async () =>
				toolTimeMachineApplyValue({
					principal: await resolvePrincipal(USER_ID),
					userId: USER_ID,
					options: {
						section_tipo: SECTION,
						section_id: recordId,
						tipo: SECTION,
						lang: 'lg-nolan',
						matrix_id: firstDelete,
					},
					background: false,
				}),
		);
		expect(response.ok).toBe(true);
		const record = await readMatrixRecord(TABLE, SECTION, recordId);
		expect((record?.columns.string as Record<string, unknown> | null)?.[TEXT]).toEqual([
			{ id: 1, lang: 'lg-nolan', value: 'kept' },
		]);
	});

	test('O16-02: the recovered record is no longer offered in the deleted list', async () => {
		expect(await deletedList()).toEqual({ ids: [], count: 0 });
	});

	test('the history stays readable: the snapshot row and the component history', async () => {
		expect(await readTimeMachineRow(firstDelete)).not.toBeNull();
		const { data } = await readTimeMachineData({
			sqo: {
				limit: 50,
				offset: 0,
				filter_by_locators: [{ section_tipo: SECTION, section_id: recordId, tipo: TEXT }],
			},
			source: { lang: 'lg-nolan' },
		} as never);
		const entries = (data[0] as { entries?: unknown[] }).entries ?? [];
		expect(entries.length).toBeGreaterThanOrEqual(1);
	});

	test("O16-03: the section's stored SQO is dropped (stored and in memory); others stay", () => {
		const stored = getSession(sessionToken)?.sqoSession ?? {};
		expect(stored[SECTION]).toBeUndefined();
		expect(stored[OTHER_SECTION]).toEqual({ section_tipo: [OTHER_SECTION], offset: 20 });
		expect(session.sqoSession?.[SECTION]).toBeUndefined();
		expect(session.sqoSession?.[OTHER_SECTION]).toEqual({
			section_tipo: [OTHER_SECTION],
			offset: 20,
		});
	});

	test('deleted again: only the NEW delete snapshot is listed', async () => {
		await deleteSectionRecord(SECTION, recordId, USER_ID);
		const secondDelete = await newestWholeRow();
		expect(secondDelete).toBeGreaterThan(firstDelete);
		expect(await deletedList()).toEqual({ ids: [secondDelete], count: 1 });
	});
});
