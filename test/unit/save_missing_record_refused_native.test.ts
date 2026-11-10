/**
 * A SAVE NEVER CREATES A RECORD (owner decision, 2026-11-10).
 *
 * `saveComponentData` (src/core/section/record/save_component.ts,
 * applySaveComponentData — the `locked === null` branch) used to MATERIALIZE a
 * record when the (section_tipo, section_id) matrix row did not exist: an
 * explicit-id createSectionRecord (conflict-tolerant) that also raised the
 * section counter. A save is an edit; birth belongs to the create doors. The
 * branch now throws `resource.not_found` (404) from inside the save
 * transaction and writes NOTHING. Two vetted sentences (publicMessage),
 * chosen by whether matrix_time_machine holds history for the address:
 *   - never existed → "… does not exist …"
 *   - deleted       → "… was deleted … Time Machine …"
 *
 * EVERY REFUSAL asserts the whole address untouched: zero matrix rows, zero
 * TM rows added, the section counter unchanged, no dedalo_ts_record_generation
 * row opened, no activity row added for the address.
 *
 * Cases: engine (never existed), engine (deleted), engine race (two concurrent
 * saves), HTTP save door as the superuser (global admin), HTTP save door as a
 * project-scoped non-admin editor (control: perm.out_of_scope — the scope
 * refusal precedes the existence question), MCP set_field as the superuser,
 * and a positive control onto an existing record.
 *
 * SITUATION: `zzsnoup` (one section on matrix_test via test24 + one
 * translatable component_input_text), owned outright and dropped after; the
 * scoped editor is the scope-binding fixture's user A with zzsnoup grants
 * added. No ontology node outside the zz* scratch TLD is written.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setField } from '../../src/ai/mcp/tools/fields_write.ts';
import type { ApiRequestContext } from '../../src/core/api/dispatch.ts';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { counterTableFor } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { ensureRecordGenerationTable } from '../../src/core/db/record_generation.ts';
import { isDedaloError } from '../../src/core/errors/dedalo_error.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { deleteSectionRecord } from '../../src/core/section/record/delete_record.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import { type Principal, resolvePrincipal } from '../../src/core/security/permissions.ts';
import { createSession, getSession, type Session } from '../../src/core/security/session_store.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { scopeBindingSlot } from '../helpers/scope_binding_fixture.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

registerSessionCleanup();

const TABLE = 'matrix_test';
const SECTION = 'zzsnoup1';
/** component_input_text, translatable → 'string' column. */
const COMPONENT = 'zzsnoup2';
const ROOT = -1;
/** The anchor record dropSituation needs to scope its sweep to the section. */
const ANCHOR_ID = 1;
/** Addresses that NEVER exist — one per case, so no case observes another's write. */
const ABSENT_ENGINE = 7100;
const ABSENT_RACE = 7200;
const ABSENT_HTTP_ADMIN = 7300;
const ABSENT_HTTP_SCOPED = 7400;
const ABSENT_MCP = 7500;

const SITUATION = situation({
	tld: 'zzsnoup',
	name: 'save_missing_record_refused',
	nodes: [
		{
			tipo: SECTION,
			parent: 'test1',
			model: 'section',
			term: { 'lg-spa': 'Guardar sin registro', 'lg-eng': 'Save without record' },
			relations: [{ tipo: 'test24' }],
		},
		{
			tipo: COMPONENT,
			parent: SECTION,
			model: 'component_input_text',
			is_translatable: true,
			term: { 'lg-spa': 'Texto', 'lg-eng': 'Text' },
		},
	],
	records: [{ section_tipo: SECTION, section_id: ANCHOR_ID }],
});

const scoped = scopeBindingSlot();
let superuser: Principal;
let deletedId = 0;
let existingId = 0;
const sessions = new Map<number, Session>();

// --- probes ------------------------------------------------------------------------

async function rowCount(sectionId: number): Promise<number> {
	const rows = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM ${TABLE} WHERE section_tipo = $1 AND section_id = $2`,
		[SECTION, sectionId],
	)) as { n: number }[];
	return rows[0]?.n ?? 0;
}

async function tmCount(sectionId: number): Promise<number> {
	const rows = (await sql.unsafe(
		'SELECT count(*)::int AS n FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
		[SECTION, sectionId],
	)) as { n: number }[];
	return rows[0]?.n ?? 0;
}

/** The section counter's value (null = no counter row). */
async function counterValue(): Promise<number | null> {
	const rows = (await sql.unsafe(`SELECT value FROM ${counterTableFor(TABLE)} WHERE tipo = $1`, [
		SECTION,
	])) as { value: number | string | null }[];
	return rows.length === 0 || rows[0]?.value == null ? null : Number(rows[0].value);
}

/** The address's epoch row as text (null = none). */
async function generationRow(sectionId: number): Promise<string | null> {
	await ensureRecordGenerationTable();
	const rows = (await sql.unsafe(
		`SELECT epoch_tm_id::text AS epoch FROM dedalo_ts_record_generation
		  WHERE section_tipo = $1 AND section_id = $2`,
		[SECTION, sectionId],
	)) as { epoch: string }[];
	return rows[0]?.epoch ?? null;
}

const ACTIVITY_OF_ADDRESS = `section_tipo = 'dd542'
	AND misc->'dd551'->0->'value'->>'section_tipo' = $1
	AND misc->'dd551'->0->'value'->>'section_id' = $2`;

async function activityCount(sectionId: number): Promise<number> {
	const rows = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM matrix_activity WHERE ${ACTIVITY_OF_ADDRESS}`,
		[SECTION, String(sectionId)],
	)) as { n: number }[];
	return rows[0]?.n ?? 0;
}

interface AddressState {
	rows: number;
	tm: number;
	counter: number | null;
	generation: string | null;
	activity: number;
}

async function addressState(sectionId: number): Promise<AddressState> {
	return {
		rows: await rowCount(sectionId),
		tm: await tmCount(sectionId),
		counter: await counterValue(),
		generation: await generationRow(sectionId),
		activity: await activityCount(sectionId),
	};
}

/** The refused save left the address exactly as it found it. */
function expectUntouched(before: AddressState, after: AddressState): void {
	expect(after.rows).toBe(0);
	expect(after).toEqual(before);
}

/** What a door answered: a refusal (code + message) or a success. */
interface Answer {
	code: string | null;
	status: number;
	message: string;
}

async function answerOf(run: () => Promise<unknown>): Promise<Answer> {
	try {
		const value = await run();
		if (value !== null && typeof value === 'object' && 'status' in value && 'body' in value) {
			const { status, body } = value as {
				status: number;
				body?: { ok?: boolean; error?: { code?: string; message?: string } };
			};
			return {
				code: body?.error?.code ?? null,
				status,
				message: body?.error?.message ?? `ok:${String(body?.ok)}`,
			};
		}
		if (value !== null && typeof value === 'object' && 'ok' in value) {
			const outcome = value as { ok: boolean; message?: string };
			return {
				code: outcome.ok ? null : 'outcome.not_ok',
				status: outcome.ok ? 200 : 500,
				message: outcome.message ?? `ok:${String(outcome.ok)}`,
			};
		}
		return { code: null, status: 200, message: 'served' };
	} catch (error) {
		if (isDedaloError(error)) {
			return {
				code: error.code,
				status: error.spec.status,
				message: `${error.publicMessage ?? ''} | ${error.message}`,
			};
		}
		return { code: `untyped: ${(error as Error).message}`, status: 500, message: String(error) };
	}
}

function engineSave(sectionId: number, value: string): Promise<unknown> {
	return saveComponentData({
		componentTipo: COMPONENT,
		sectionTipo: SECTION,
		sectionId,
		lang: 'lg-spa',
		changedData: [{ action: 'insert', id: null, value: { lang: 'lg-spa', value } }],
		userId: ROOT,
	});
}

function contextFor(principal: Principal): ApiRequestContext {
	let session = sessions.get(principal.userId);
	if (session === undefined) {
		const token = createSession(
			principal.userId,
			`zzsnoup_${principal.userId}`,
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

function saveRqo(sectionId: number, value: string): Rqo {
	return {
		action: 'save',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		source: {
			typo: 'source',
			type: 'component',
			model: 'component_input_text',
			tipo: COMPONENT,
			section_tipo: SECTION,
			section_id: sectionId,
			mode: 'edit',
			lang: 'lg-spa',
		},
		data: {
			section_id: sectionId,
			section_tipo: SECTION,
			tipo: COMPONENT,
			lang: 'lg-spa',
			changed_data: [{ action: 'update', id: null, value: { lang: 'lg-spa', value } }],
		},
	} as unknown as Rqo;
}

async function storedValues(sectionId: number): Promise<string[]> {
	const rows = (await sql.unsafe(
		`SELECT string->$1 AS items FROM ${TABLE} WHERE section_tipo = $2 AND section_id = $3`,
		[COMPONENT, SECTION, sectionId],
	)) as { items: { value: string }[] | null }[];
	return (rows[0]?.items ?? []).map((item) => item.value);
}

// --- situation ---------------------------------------------------------------------

/** Sweep what dropSituation does not: the section's epoch rows and activity rows. */
async function sweepSideTables(): Promise<void> {
	await assertTestDatabase('save_missing_record_refused_native: side-table sweep');
	await ensureRecordGenerationTable();
	await sql.unsafe('DELETE FROM dedalo_ts_record_generation WHERE section_tipo = $1', [SECTION]);
	await sql.unsafe(
		`DELETE FROM matrix_activity WHERE section_tipo = 'dd542'
		   AND misc->'dd551'->0->'value'->>'section_tipo' = $1`,
		[SECTION],
	);
}

async function sideTableResidue(): Promise<number> {
	const generation = (await sql.unsafe(
		'SELECT count(*)::int AS n FROM dedalo_ts_record_generation WHERE section_tipo = $1',
		[SECTION],
	)) as { n: number }[];
	const activity = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM matrix_activity WHERE section_tipo = 'dd542'
		   AND misc->'dd551'->0->'value'->>'section_tipo' = $1`,
		[SECTION],
	)) as { n: number }[];
	return (generation[0]?.n ?? 0) + (activity[0]?.n ?? 0);
}

beforeAll(async () => {
	await assertTestDatabase('save_missing_record_refused_native');
	// A previous run killed mid-way: start from nothing.
	await sweepSideTables();
	expect(await dropSituation(SITUATION)).toBe(0);
	await ensureSituation(SITUATION);
	expect(await getMatrixTableFromTipo(SECTION)).toBe(TABLE);
	superuser = await resolvePrincipal(ROOT);
	expect(superuser.isGlobalAdmin).toBe(true);
	await scoped.install([
		[SECTION, SECTION],
		[SECTION, COMPONENT],
	]);

	// A record born and deleted through the real engines: TM history, no row.
	deletedId = await createSectionRecord(SECTION, ROOT);
	await deleteSectionRecord(SECTION, deletedId, ROOT);
	// A live record for the positive control.
	existingId = await createSectionRecord(SECTION, ROOT);

	for (const id of [
		ABSENT_ENGINE,
		ABSENT_RACE,
		ABSENT_HTTP_ADMIN,
		ABSENT_HTTP_SCOPED,
		ABSENT_MCP,
	]) {
		expect(await rowCount(id)).toBe(0);
		expect(await tmCount(id)).toBe(0);
	}
	expect(new Set([deletedId, existingId, ANCHOR_ID]).size).toBe(3);
}, 60_000);

afterAll(async () => {
	await scoped.release();
	await sweepSideTables();
	expect(await dropSituation(SITUATION)).toBe(0);
	expect(await sideTableResidue()).toBe(0);
}, 60_000);

// --- cases -------------------------------------------------------------------------

describe('a save onto a missing record is refused (resource.not_found), never a create', () => {
	test('engine: a never-existing address → resource.not_found "does not exist", nothing written', async () => {
		const before = await addressState(ABSENT_ENGINE);
		const answer = await answerOf(() => engineSave(ABSENT_ENGINE, 'never-born'));
		const after = await addressState(ABSENT_ENGINE);
		expectUntouched(before, after);
		expect(answer.code).toBe('resource.not_found');
		expect(answer.status).toBe(404);
		expect(answer.message).toContain('does not exist');
	}, 30_000);

	test('engine: a DELETED address → resource.not_found "was deleted … Time Machine", no epoch reopened', async () => {
		const before = await addressState(deletedId);
		// The precondition the message distinction rests on: history, no row.
		expect(before.rows).toBe(0);
		expect(before.tm).toBeGreaterThan(0);
		const answer = await answerOf(() => engineSave(deletedId, 'reborn-by-save'));
		const after = await addressState(deletedId);
		expectUntouched(before, after);
		expect(answer.code).toBe('resource.not_found');
		expect(answer.message).toContain('was deleted');
		expect(answer.message).toContain('Time Machine');
	}, 30_000);

	test('engine: two CONCURRENT saves onto one missing address → both refused, zero rows', async () => {
		const before = await addressState(ABSENT_RACE);
		const [first, second] = await Promise.allSettled([
			answerOf(() => engineSave(ABSENT_RACE, 'race-first')),
			answerOf(() => engineSave(ABSENT_RACE, 'race-second')),
		]);
		const after = await addressState(ABSENT_RACE);
		expect(first.status).toBe('fulfilled');
		expect(second.status).toBe('fulfilled');
		const codes = [first, second].map((settled) =>
			settled.status === 'fulfilled' ? settled.value.code : `rejected: ${String(settled.reason)}`,
		);
		expectUntouched(before, after);
		expect(codes).toEqual(['resource.not_found', 'resource.not_found']);
	}, 30_000);

	test('HTTP save door as the superuser (global admin) → 404 resource.not_found envelope, no row', async () => {
		const before = await addressState(ABSENT_HTTP_ADMIN);
		const answer = await answerOf(() =>
			dispatchRqo(saveRqo(ABSENT_HTTP_ADMIN, 'http-admin'), contextFor(superuser)),
		);
		const after = await addressState(ABSENT_HTTP_ADMIN);
		expectUntouched(before, after);
		expect(answer.code).toBe('resource.not_found');
		expect(answer.status).toBe(404);
		expect(answer.message).toContain('does not exist');
	}, 30_000);

	test('HTTP save door as a project-scoped editor (level 2 on the component) → perm.out_of_scope (control)', async () => {
		const editor = await resolvePrincipal(scoped.userA);
		expect(editor.isGlobalAdmin).toBe(false);
		const before = await addressState(ABSENT_HTTP_SCOPED);
		const answer = await answerOf(() =>
			dispatchRqo(saveRqo(ABSENT_HTTP_SCOPED, 'http-scoped'), contextFor(editor)),
		);
		const after = await addressState(ABSENT_HTTP_SCOPED);
		expectUntouched(before, after);
		expect(answer.code).toBe('perm.out_of_scope');
		expect(answer.status).toBe(403);
	}, 30_000);

	test('MCP set_field as the superuser → resource.not_found, no row', async () => {
		const before = await addressState(ABSENT_MCP);
		const answer = await answerOf(() =>
			setField(superuser, {
				section_tipo: SECTION,
				section_id: ABSENT_MCP,
				field: COMPONENT,
				value: 'mcp-never-born',
				lang: 'lg-spa',
			}),
		);
		const after = await addressState(ABSENT_MCP);
		expectUntouched(before, after);
		expect(answer.code).toBe('resource.not_found');
		expect(answer.message).toContain('does not exist');
	}, 30_000);

	test('positive control: the same save onto an EXISTING record persists the value', async () => {
		const counterBefore = await counterValue();
		expect(await rowCount(existingId)).toBe(1);
		const answer = await answerOf(() => engineSave(existingId, 'lands-on-existing'));
		expect(answer.code).toBeNull();
		expect(await rowCount(existingId)).toBe(1);
		expect(await storedValues(existingId)).toContain('lands-on-existing');
		expect(await counterValue()).toBe(counterBefore);
	}, 30_000);
});
