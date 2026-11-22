/**
 * Activity log (matrix_activity, dd542) row anatomy — TS-NATIVE half, the
 * DEC-14b survival twin of test/parity/activity_log_differential.test.ts
 * (that gate's PHP-vs-TS comparison dies with the oracle; the row anatomy it
 * pinned equal to live PHP survives HERE, asserted against the TS engine
 * alone).
 *
 * Every state-changing dispatch action appends one dd542 audit row:
 *   relation.dd543 = the acting user's locator (dd128 link, no item id)
 *   relation.dd545 = the WHAT code locator (dd42: DELETE=4, SAVE=5)
 *   string.dd544   = the client host ('localhost' for loopback)
 *   string.dd546   = the WHERE tipo (component tipo for saves, section tipo
 *                    for deletes)
 *   date.dd547     = the virtual-calendar instant (start only — no id/lang)
 *   misc.dd551     = [{lang:'lg-nolan', value:<action payload>}] — the SAVE
 *                    payload names the component/table; the DELETE payload
 *                    mirrors the PHP QUIRK of hardcoding delete_mode
 *                    'delete_record'.
 * The relation/host/where/payload assertions below are exactly the fields the
 * differential deep-compared against live PHP (payload section_id
 * normalized — its TYPE differs per action, so only its VALUE is pinned).
 * date.dd547 was NOT differential-compared (instants normalized); its shape
 * is the handler's observed-live contract (api/handlers/activity_log.ts).
 *
 * Driven through dispatchRqo — logActivity lives at the dd_core_api handler
 * chokepoint (the save/delete ENGINES write no activity rows themselves).
 *
 * Scratch hygiene: one fresh test3 record (matrix_test) via
 * createSectionRecord; the record + its TM rows + the activity rows THIS test
 * appended are deleted in afterAll (matrix_activity is consultation-only for
 * the engine doors; direct SQL cleanup of our own rows mirrors the
 * differential's cleanup).
 *
 * @twin-of      test/parity/activity_log_differential.test.ts
 * @twin-status  retired
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as babelParse } from '@babel/parser';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import { activitySectionOf, logActivity } from '../../src/core/api/handlers/activity_log.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { sql } from '../../src/core/db/postgres.ts';
import {
	createSectionRecord,
	virtualDateNow,
} from '../../src/core/section/record/create_record.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';
import { cleanScratchRecord } from '../helpers/test_data.ts';
import {
	REPO_ROOT,
	WRITE_PATH_CORPUS_FLOOR,
	writePathSourceFiles,
} from '../helpers/write_path_corpus.ts';

registerSessionCleanup();

const SECTION = 'test3';
const TABLE = 'matrix_test';
const COMPONENT = 'test52'; // component_input_text of test3 (the differential's twin)
const USER_ID = -1; // root

/** Virtual-calendar seconds tolerance (dd547 instant vs the test wall clock). */
const TOLERANCE_VIRTUAL_SECONDS = 120;

interface ActivityRow {
	section_id: number;
	section_tipo: string;
	relation: Record<string, unknown[]>;
	string: Record<string, { lang?: string; value?: unknown }[]>;
	date: { dd547?: Record<string, number>[] };
	misc: { dd551?: { lang?: string; value?: Record<string, unknown> }[] };
}

let recordId = 0;
const activityIds: number[] = [];
let saveRow: ActivityRow | undefined;
let deleteRow: ActivityRow | undefined;
let baselineBeforeSave = 0;
let baselineBeforeDelete = 0;
/** WC-040: the record created through the `create` DOOR (the NEW emitter). */
let createdRecordId = 0;
let newRow: ActivityRow | undefined;
let loginDenyRow: ActivityRow | undefined;
/** Unique per run so the throttle store and the row lookup cannot collide. */
const ABSENT_USERNAME = `__activity_native_absent_${process.pid}__`;

async function maxActivityId(): Promise<number> {
	const rows = (await sql`
		SELECT COALESCE(MAX(section_id), 0)::int AS max FROM matrix_activity
	`) as { max: number }[];
	return rows[0]?.max ?? 0;
}

/** The row THIS test appended: where-tipo + WHAT code + our record id. */
async function ourActivityRow(whereTipo: string, code: string): Promise<ActivityRow | undefined> {
	const rows = (await sql.unsafe(
		`SELECT section_id, section_tipo, relation, string, date, misc FROM matrix_activity
		 WHERE string->'dd546'->0->>'value' = $1
		   AND relation->'dd545'->0->>'section_id' = $2
		   AND misc->'dd551'->0->'value'->>'section_id' = $3
		 ORDER BY section_id DESC LIMIT 1`,
		[whereTipo, code, String(recordId)],
	)) as ActivityRow[];
	if (rows[0] !== undefined) activityIds.push(Number(rows[0].section_id));
	return rows[0];
}

/** Like ourActivityRow, but keyed on an explicit payload section_id (NEW). */
async function activityRowBySectionId(
	whereTipo: string,
	code: string,
	payloadSectionId: number,
): Promise<ActivityRow | undefined> {
	const rows = (await sql.unsafe(
		`SELECT section_id, section_tipo, relation, string, date, misc FROM matrix_activity
		 WHERE string->'dd546'->0->>'value' = $1
		   AND relation->'dd545'->0->>'section_id' = $2
		   AND misc->'dd551'->0->'value'->>'section_id' = $3
		 ORDER BY section_id DESC LIMIT 1`,
		[whereTipo, code, String(payloadSectionId)],
	)) as ActivityRow[];
	if (rows[0] !== undefined) activityIds.push(Number(rows[0].section_id));
	return rows[0];
}

/** The LOG IN row for one attempted username (payload key, not section_id). */
async function loginActivityRow(username: string): Promise<ActivityRow | undefined> {
	const rows = (await sql.unsafe(
		`SELECT section_id, section_tipo, relation, string, date, misc FROM matrix_activity
		 WHERE relation->'dd545'->0->>'section_id' = '1'
		   AND misc->'dd551'->0->'value'->>'username' = $1
		 ORDER BY section_id DESC LIMIT 1`,
		[username],
	)) as ActivityRow[];
	if (rows[0] !== undefined) activityIds.push(Number(rows[0].section_id));
	return rows[0];
}

async function rootContext(): Promise<Record<string, unknown>> {
	const token = createSession(USER_ID, 'root', true);
	const session = getSession(token);
	const principal = await resolvePrincipal(USER_ID);
	return {
		requestId: 'activity_native_test',
		clientIp: '127.0.0.1',
		session,
		csrfCandidate: session?.csrfToken ?? null,
		principal,
	};
}

beforeAll(async () => {
	recordId = await createSectionRecord(SECTION, USER_ID);
	const context = await rootContext();

	// SAVE (the differential's exact RQO shape — PHP-verified wire).
	const saveItem = { id: 1, lang: 'lg-nolan', value: 'ACTIVITY_NATIVE' };
	baselineBeforeSave = await maxActivityId();
	await dispatchRqo(
		{
			action: 'save',
			dd_api: 'dd_core_api',
			prevent_lock: true,
			source: {
				typo: 'source',
				type: 'component',
				model: 'component_input_text',
				tipo: COMPONENT,
				section_tipo: SECTION,
				section_id: String(recordId),
				mode: 'edit',
				lang: 'lg-nolan',
				action: null,
			},
			data: {
				section_id: String(recordId),
				section_tipo: SECTION,
				tipo: COMPONENT,
				lang: 'lg-nolan',
				from_component_tipo: COMPONENT,
				value: [saveItem],
				changed_data: [{ action: 'set_data', key: null, value: [saveItem] }],
			},
		} as unknown as Rqo,
		context as never,
	);
	saveRow = await ourActivityRow(COMPONENT, '5');

	// DELETE (delete_record).
	baselineBeforeDelete = await maxActivityId();
	await dispatchRqo(
		{
			action: 'delete',
			dd_api: 'dd_core_api',
			prevent_lock: true,
			source: {
				typo: 'source',
				model: 'section',
				tipo: SECTION,
				section_tipo: SECTION,
				section_id: String(recordId),
				action: 'delete',
				delete_mode: 'delete_record',
			},
		} as unknown as Rqo,
		context as never,
	);
	deleteRow = await ourActivityRow(SECTION, '4');

	// NEW (WC-040) — through the `create` DOOR, which is where the emitter
	// lives; the createSectionRecord call above is the ENGINE and writes no row.
	const createResult = await dispatchRqo(
		{
			action: 'create',
			dd_api: 'dd_core_api',
			prevent_lock: true,
			source: {
				typo: 'source',
				model: 'section',
				tipo: SECTION,
				section_tipo: SECTION,
				action: 'create',
			},
		} as unknown as Rqo,
		context as never,
	);
	createdRecordId = Number((createResult.body as { data?: unknown }).data ?? 0);
	newRow = await activityRowBySectionId(SECTION, '3', createdRecordId);

	// LOG IN, denied (WC-040). An unknown username needs no fixture user and
	// exercises the branch that matters most: a failed attempt IS recorded.
	const { login } = await import('../../src/core/security/auth.ts');
	await login(ABSENT_USERNAME, 'wrong-password', '127.0.0.1');
	loginDenyRow = await loginActivityRow(ABSENT_USERNAME);
}, 60000);

afterAll(async () => {
	if (recordId > 0) await cleanScratchRecord(SECTION, recordId, TABLE);
	if (createdRecordId > 0) await cleanScratchRecord(SECTION, createdRecordId, TABLE);
	for (const id of activityIds) {
		await sql.unsafe(
			`DELETE FROM matrix_activity WHERE section_tipo = 'dd542' AND section_id = $1`,
			[id],
		);
	}
});

/** The PHP dd_date virtual-date field set (fixed 372-day years / 31-day months). */
interface VirtualStart {
	day: number;
	hour: number;
	time: number;
	year: number;
	month: number;
	minute: number;
	second: number;
}

/** dd547: {start} only, virtual-time fields self-consistent + wall-clock near NOW. */
function assertInstant(row: ActivityRow): void {
	const items = row.date.dd547 ?? [];
	expect(items.length).toBe(1);
	const item = items[0] as unknown as { start: VirtualStart };
	expect(Object.keys(item).sort()).toEqual(['start']); // no id/lang (observed live)
	const start = item.start;
	expect(Object.keys(start).sort()).toEqual([
		'day',
		'hour',
		'minute',
		'month',
		'second',
		'time',
		'year',
	]);
	// The dd_date virtual-calendar encoding recomputes from its own fields…
	const recomputed =
		start.year * 372 * 86400 +
		(start.month - 1) * 31 * 86400 +
		(start.day - 1) * 86400 +
		start.hour * 3600 +
		start.minute * 60 +
		start.second;
	expect(start.time).toBe(recomputed);
	// …and sits at the wall clock (a UTC-stamped row misses by the zone offset).
	const skew = Math.abs(start.time - virtualDateNow(new Date()).time);
	expect(skew).toBeLessThan(TOLERANCE_VIRTUAL_SECONDS);
}

describe('activity log rows, TS-native (dd542 anatomy)', () => {
	test('SAVE appends a NEW row: code 5, user locator, component where, payload fields', () => {
		expect(saveRow).toBeDefined();
		const row = saveRow as ActivityRow;
		expect(row.section_tipo).toBe('dd542');
		expect(Number(row.section_id)).toBeGreaterThan(baselineBeforeSave);

		// relation: acting user (dd543) + WHAT code SAVE=5 (dd545) — differential-pinned.
		expect(row.relation).toEqual({
			dd543: [
				{
					type: 'dd151',
					// WC-2026-08-10-section-id-int-canonical: activity_log dd543 mints
					// the actor address as an INT now (was String(userId)).
					section_id: USER_ID,
					section_tipo: 'dd128',
					from_component_tipo: 'dd543',
				},
			],
			dd545: [
				// WC-2026-08-10-section-id-int-canonical: WHAT-code address is int.
				{ type: 'dd151', section_id: 5, section_tipo: 'dd42', from_component_tipo: 'dd545' },
			],
		});

		// host + WHERE tipo — differential-pinned values.
		expect(row.string.dd544?.[0]?.value).toBe('localhost');
		expect(row.string.dd546?.[0]?.value).toBe(COMPONENT);

		// dd551 payload (differential-pinned, section_id VALUE checked loosely —
		// the differential normalized it away, so its type is not pinned).
		expect(row.misc.dd551?.length).toBe(1);
		expect(row.misc.dd551?.[0]?.lang).toBe('lg-nolan');
		const payload = { ...(row.misc.dd551?.[0]?.value ?? {}) };
		expect(String(payload.section_id)).toBe(String(recordId));
		payload.section_id = '<id>';
		expect(payload).toEqual({
			msg: 'Saved component data',
			lang: 'lg-nolan',
			tipo: COMPONENT,
			table: TABLE,
			section_id: '<id>',
			section_tipo: SECTION,
			component_name: 'component_input_text',
		});

		assertInstant(row);
	});

	test('DELETE appends a NEW row: code 4, section where, delete_record payload quirk', () => {
		expect(deleteRow).toBeDefined();
		const row = deleteRow as ActivityRow;
		expect(row.section_tipo).toBe('dd542');
		expect(Number(row.section_id)).toBeGreaterThan(baselineBeforeDelete);

		expect(row.relation).toEqual({
			dd543: [
				{
					type: 'dd151',
					// WC-2026-08-10-section-id-int-canonical: activity_log dd543 mints
					// the actor address as an INT now (was String(userId)).
					section_id: USER_ID,
					section_tipo: 'dd128',
					from_component_tipo: 'dd543',
				},
			],
			dd545: [
				// WC-2026-08-10-section-id-int-canonical: WHAT-code address is int.
				{ type: 'dd151', section_id: 4, section_tipo: 'dd42', from_component_tipo: 'dd545' },
			],
		});

		expect(row.string.dd544?.[0]?.value).toBe('localhost');
		expect(row.string.dd546?.[0]?.value).toBe(SECTION); // deletes log the SECTION tipo

		expect(row.misc.dd551?.length).toBe(1);
		expect(row.misc.dd551?.[0]?.lang).toBe('lg-nolan');
		const payload = { ...(row.misc.dd551?.[0]?.value ?? {}) };
		expect(String(payload.section_id)).toBe(String(recordId));
		payload.section_id = '<id>';
		expect(payload).toEqual({
			msg: 'DEBUG INFO section_record::delete Deleted section record and its own references. Full deleted record',
			tipo: SECTION,
			table: TABLE,
			section_id: '<id>',
			delete_mode: 'delete_record', // PHP QUIRK pinned by the differential
			section_tipo: SECTION,
		});

		assertInstant(row);
	});

	test('NEW appends a row: code 3, section where, create payload (WC-040)', () => {
		expect(createdRecordId).toBeGreaterThan(0);
		expect(newRow).toBeDefined();
		const row = newRow as ActivityRow;
		expect(row.section_tipo).toBe('dd542');

		expect(row.relation).toEqual({
			dd543: [
				{
					type: 'dd151',
					// WC-2026-08-10-section-id-int-canonical: activity_log dd543 mints
					// the actor address as an INT now (was String(userId)).
					section_id: USER_ID,
					section_tipo: 'dd128',
					from_component_tipo: 'dd543',
				},
			],
			dd545: [
				// WC-2026-08-10-section-id-int-canonical: WHAT-code address is int.
				{ type: 'dd151', section_id: 3, section_tipo: 'dd42', from_component_tipo: 'dd545' },
			],
		});

		// WHERE is the SECTION tipo (a create has no component).
		expect(row.string.dd544?.[0]?.value).toBe('localhost');
		expect(row.string.dd546?.[0]?.value).toBe(SECTION);

		expect(row.misc.dd551?.[0]?.value).toEqual({
			msg: 'Created section record',
			// WC-2026-08-10-section-id-int-canonical: the dd551 payload carries the
			// created record's address, minted int by create_record.
			section_id: createdRecordId,
			section_tipo: SECTION,
			tipo: SECTION,
			table: TABLE,
		});

		assertInstant(row);
	});

	test('a DENIED login appends a row: code 1, dd229 where, -666 actor (WC-040)', () => {
		expect(loginDenyRow).toBeDefined();
		const row = loginDenyRow as ActivityRow;
		expect(row.section_tipo).toBe('dd542');

		// The actor is PHP's anonymous sentinel — nobody is authenticated on a
		// denied attempt, so the username lives in the payload instead.
		expect(row.relation).toEqual({
			dd543: [
				{
					type: 'dd151',
					// WC-2026-08-10-section-id-int-canonical: the anonymous sentinel is
					// an int address too (the invariant is INTEGER, not positive).
					section_id: -666,
					section_tipo: 'dd128',
					from_component_tipo: 'dd543',
				},
			],
			dd545: [
				// WC-2026-08-10-section-id-int-canonical: WHAT-code address is int.
				{ type: 'dd151', section_id: 1, section_tipo: 'dd42', from_component_tipo: 'dd545' },
			],
		});

		// WHERE is the fixed login tipo (PHP login::get_login_tipo).
		expect(row.string.dd546?.[0]?.value).toBe('dd229');

		expect(row.misc.dd551?.[0]?.value).toEqual({
			// The untrusted string is stored ONCE, in `username`
			// (WC-2026-09-05-preauth-intake-bounds / SEC-21): it used to
			// appear here too, so every denial wrote the caller's bytes twice.
			msg: 'Denied login. User does not exist',
			result: 'deny',
			cause: 'User does not exist',
			username: ABSENT_USERNAME,
		});
	});

	test('the delete actually removed the audited record (the row the payload names)', async () => {
		const rows = (await sql.unsafe(
			`SELECT 1 FROM ${TABLE} WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, recordId],
		)) as unknown[];
		expect(rows.length).toBe(0);
	});
});

/**
 * T2 O16-01 — THE EXCLUDED SECTIONS LEAVE NO ACTIVITY ROW EITHER. dd655 (the
 * editing search preset, rewritten on every filter edit), dd15 (the Time Machine)
 * and dd1521 (the rebuildable daily aggregate) carry no history
 * (TM_EXCLUDED_SECTIONS); PHP's log_message_defer skipped the same three for the
 * activity log. The skip sits at the logActivity chokepoint, keyed on the
 * action's SECTION — `data.section_tipo`, else the WHERE tipo
 * (activitySectionOf) — so a SAVE, whose WHERE is the COMPONENT, is judged by
 * the section it saved into.
 */
describe('activity log skips the TM-excluded sections (O16-01)', () => {
	const MARK = `__o16_01_${process.pid}_${Date.now()}__`;

	async function rowsMarked(suffix: string): Promise<number[]> {
		const rows = (await sql.unsafe(
			`SELECT section_id FROM matrix_activity
			 WHERE section_tipo = 'dd542' AND misc->'dd551'->0->'value'->>'msg' = $1`,
			[`${MARK}${suffix}`],
		)) as { section_id: number }[];
		const ids = rows.map((row) => Number(row.section_id));
		activityIds.push(...ids);
		return ids;
	}

	const entry = (what: string, tipo: string, suffix: string, data: Record<string, unknown>) => ({
		what,
		tipo,
		userId: USER_ID,
		host: 'localhost',
		data: { msg: `${MARK}${suffix}`, ...data },
	});

	test('a SAVE into a dd655 record (WHERE = a component tipo) appends NO row', async () => {
		await logActivity(entry('SAVE', 'dd656', 'save655', { section_tipo: 'dd655', section_id: 1 }));
		expect(await rowsMarked('save655')).toEqual([]);
	});

	test('NEW / DELETE on dd15 and dd1521 (WHERE = the section) append NO row', async () => {
		await logActivity(entry('NEW', 'dd15', 'new15', { section_id: 1 }));
		await logActivity(entry('DELETE', 'dd1521', 'del1521', { section_id: 1 }));
		await logActivity(entry('DELETE', 'dd15', 'del15', { section_tipo: 'dd15', section_id: 1 }));
		expect(await rowsMarked('new15')).toEqual([]);
		expect(await rowsMarked('del1521')).toEqual([]);
		expect(await rowsMarked('del15')).toEqual([]);
	});

	test('the same actions on an ordinary section still log (positive control)', async () => {
		await logActivity(entry('SAVE', COMPONENT, 'save3', { section_tipo: SECTION, section_id: 1 }));
		await logActivity(entry('NEW', SECTION, 'new3', { section_id: 1 }));
		expect(await rowsMarked('save3')).toHaveLength(1);
		expect(await rowsMarked('new3')).toHaveLength(1);
	});

	test('activitySectionOf: data.section_tipo first, else the WHERE tipo', () => {
		expect(activitySectionOf(entry('SAVE', 'dd656', '', { section_tipo: 'dd655' }))).toBe('dd655');
		expect(activitySectionOf(entry('NEW', 'dd15', '', {}))).toBe('dd15');
		expect(activitySectionOf(entry('NEW', 'dd15', '', { section_tipo: '' }))).toBe('dd15');
	});
});

/**
 * The source half of O16-01: the skip keys on `data.section_tipo` because a
 * SAVE's WHERE is a component tipo — so EVERY SAVE emitter must pass it, or a
 * save into dd655 slips past the skip. Derived over the whole write-path
 * corpus (babel-parsed): every `logActivity(...)` call whose `what` is the
 * literal 'SAVE' must carry `section_tipo` in its `data` object. A call whose
 * `what` is not a literal is OPAQUE and must be a named entry below (what it can
 * be, and why no section_tipo is owed); a stale entry is red.
 */
const OPAQUE_ACTIVITY_EMITTERS: Record<string, { count: number; reason: string }> = {
	'src/core/api/handlers/dd_core_api.ts': {
		count: 1,
		reason: 'LOAD EDIT / LOAD LIST (a template literal): the WHERE IS the section tipo',
	},
	'src/core/security/legacy_password_migration.ts': {
		count: 1,
		reason: 'SAVE of a password-conversion run on the maintenance AREA (dd88): no section',
	},
	'src/core/area_maintenance/widgets/publication_host_setup.ts': {
		count: 1,
		reason: 'SAVE / DELETE (AuditVerb) of a publication-host change on the AREA dd88: no section',
	},
	'tools/tool_media_versions/server/media_versions.ts': {
		count: 1,
		reason: 'DELETE FILE / NEW VERSION (typed): never SAVE',
	},
	'tools/tool_time_machine/server/tool_time_machine.ts': {
		count: 1,
		reason: 'RECOVER SECTION / RECOVER COMPONENT (typed): the WHERE IS the section tipo',
	},
};

interface ActivityCall {
	file: string;
	line: number;
	what: string | null;
	dataHasSectionTipo: boolean;
}

type AstNode = { type: string; loc?: { start: { line: number } } } & Record<string, unknown>;

function propertyNamed(object: AstNode, name: string): AstNode | undefined {
	for (const property of (object.properties as AstNode[]) ?? []) {
		if (property.type !== 'ObjectProperty') continue;
		const key = property.key as AstNode;
		const keyName =
			key.type === 'Identifier' ? key.name : key.type === 'StringLiteral' ? key.value : null;
		if (keyName === name) return property;
	}
	return undefined;
}

/** Every logActivity call of one module (plain or `x.logActivity`). */
function activityCalls(file: string, source: string): ActivityCall[] {
	const ast = babelParse(source, {
		sourceType: 'module',
		errorRecovery: true,
		plugins: ['typescript', 'decorators-legacy'],
	}) as unknown as { program: AstNode };
	const calls: ActivityCall[] = [];
	const visit = (node: unknown): void => {
		if (node === null || typeof node !== 'object') return;
		if (Array.isArray(node)) {
			for (const child of node) visit(child);
			return;
		}
		const ast = node as AstNode;
		if (ast.type === 'CallExpression') {
			const callee = ast.callee as AstNode;
			const name =
				callee.type === 'Identifier'
					? callee.name
					: callee.type === 'MemberExpression'
						? (callee.property as AstNode).name
						: null;
			if (name === 'logActivity') {
				const arg = (ast.arguments as AstNode[])[0];
				let what: string | null = null;
				let dataHasSectionTipo = false;
				if (arg?.type === 'ObjectExpression') {
					const whatValue = propertyNamed(arg, 'what')?.value as AstNode | undefined;
					if (whatValue?.type === 'StringLiteral') what = String(whatValue.value);
					const data = propertyNamed(arg, 'data')?.value as AstNode | undefined;
					dataHasSectionTipo =
						data?.type === 'ObjectExpression' && propertyNamed(data, 'section_tipo') !== undefined;
				}
				calls.push({ file, line: ast.loc?.start.line ?? 0, what, dataHasSectionTipo });
			}
		}
		for (const [key, value] of Object.entries(ast)) {
			if (key === 'loc' || key === 'start' || key === 'end') continue;
			visit(value);
		}
	};
	visit(ast.program);
	return calls;
}

/** The verdict over a set of calls: offenders + opaque sites per file. */
function judgeActivityCalls(calls: readonly ActivityCall[]): {
	saveWithoutSection: string[];
	opaque: Map<string, number>;
	literalSaves: number;
} {
	const saveWithoutSection: string[] = [];
	const opaque = new Map<string, number>();
	let literalSaves = 0;
	for (const call of calls) {
		if (call.what === null) {
			opaque.set(call.file, (opaque.get(call.file) ?? 0) + 1);
		} else if (call.what === 'SAVE') {
			literalSaves += 1;
			if (!call.dataHasSectionTipo) saveWithoutSection.push(`${call.file}:${call.line}`);
		}
	}
	return { saveWithoutSection, opaque, literalSaves };
}

describe('every SAVE emitter names its section (O16-01 source scan)', () => {
	const files = writePathSourceFiles();
	const calls = files.flatMap((file) =>
		activityCalls(file, readFileSync(join(REPO_ROOT, file), 'utf8')),
	);
	const verdict = judgeActivityCalls(calls);

	test('floors: the corpus, the call sites and the literal SAVE emitters were all SEEN', () => {
		expect(files.length).toBeGreaterThanOrEqual(WRITE_PATH_CORPUS_FLOOR);
		expect(calls.length).toBeGreaterThanOrEqual(15);
		expect(verdict.literalSaves).toBeGreaterThanOrEqual(1);
	});

	test('every literal SAVE emitter passes data.section_tipo', () => {
		expect(verdict.saveWithoutSection).toEqual([]);
	});

	test('every opaque emitter is a named entry, and no entry is stale', () => {
		expect(Object.fromEntries(verdict.opaque)).toEqual(
			Object.fromEntries(
				Object.entries(OPAQUE_ACTIVITY_EMITTERS).map(([file, entry]) => [file, entry.count]),
			),
		);
	});

	test('the scan is honest: a planted SAVE without section_tipo is reported, its twin is not', () => {
		const planted = activityCalls(
			'planted.ts',
			`await logActivity({ what: 'SAVE', tipo: t, userId: 1, host: h, data: { msg: 'x', tipo: t } });
			 await activity.logActivity({ what: 'SAVE', tipo: t, userId: 1, host: h, data: { section_tipo: s } });
			 await logActivity({ what: v, tipo: t, userId: 1, host: h, data: {} });`,
		);
		const judged = judgeActivityCalls(planted);
		expect(judged.saveWithoutSection).toEqual(['planted.ts:1']);
		expect(judged.literalSaves).toBe(2);
		expect(Object.fromEntries(judged.opaque)).toEqual({ 'planted.ts': 1 });
	});
});
