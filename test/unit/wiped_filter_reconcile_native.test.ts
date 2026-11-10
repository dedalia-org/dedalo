/**
 * RECONCILE `wiped_filter_projects` — the repair of records a pre-fix
 * `delete_data` moved OUT of their project (T0-5, audit OX3; owner decision
 * D1 = report + operator apply through the reconcile panel).
 *
 * THE DAMAGE. Until T0-5 the data wipe (delete_record.ts deleteSectionData)
 * reset every component_filter to ONE id-less `dd151` locator on
 * DEDALO_DEFAULT_PROJECT, whoever wiped: a project-scoped curator's record left
 * their scope. The signature is exact — no other door writes an id-less filter
 * item — and the record's pre-wipe projects are in its Time Machine history.
 *
 * THE OUTCOME PINNED (a `zzwfr` scratch TLD on `test1` → matrix_test, one
 * filtered section, every record and TM row built here and swept):
 *   - DRY (the default) reports each legacy-wiped key with its pre-wipe filter
 *     and status, and writes NOTHING (live keys and TM row counts unchanged);
 *   - a key whose TM history has no pre-wipe value is `unrecoverable`;
 *     a pre-wipe project that no longer exists is `project_missing` (still
 *     restored: it IS the record's history); a filter edited after the wipe is
 *     not a match at all;
 *   - APPLY restores the restorable keys through the component-restore entry,
 *     each with a fresh TM row carrying the restored value, and the project
 *     member can reach the record again; `unrecoverable` stays untouched;
 *   - a second apply finds only what cannot be restored (idempotent);
 *   - the registry publishes it as operator-run, never auto-applied, applicable
 *     by any global admin (D1.1).
 * assertTestDatabase before the first write.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { recordTimeMachine } from '../../src/core/db/time_machine.ts';
import { registerAllReconciles } from '../../src/core/reconcile/catalog.ts';
import { applyPolicyOf, getReconcile, runReconcile } from '../../src/core/reconcile/registry.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { principalCanAccessRecord } from '../../src/core/security/record_scope.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import {
	ACL_NON_ADMIN_USER_ID,
	ACL_PROJECT_ID,
	clearAclIdentityCaches,
	installAclIdentityFixture,
	removeAclIdentityFixture,
} from '../helpers/acl_identity_fixture.ts';

const NAME = 'wiped_filter_projects';
const TLD = 'zzwfr';
const FSECTION = `${TLD}1`;
const FILTER = `${TLD}2`;
const FTEXT = `${TLD}3`;
const TABLE = 'matrix_test';
const USER_ID = -1;
/** A dd153 address with no record (project_missing). */
const MISSING_PROJECT_ID = 930098;

const SITUATION = situation({
	tld: TLD,
	name: 'wiped_filter_reconcile',
	nodes: [
		{ tipo: FSECTION, parent: 'test1', model: 'section', term: { 'lg-eng': 'Filtered' } },
		{ tipo: FILTER, parent: FSECTION, model: 'component_filter', term: { 'lg-eng': 'Projects' } },
		{
			tipo: FTEXT,
			parent: FSECTION,
			model: 'component_input_text',
			term: { 'lg-eng': 'Text' },
			is_translatable: false,
		},
	],
});

/** The exact value the pre-fix wipe wrote (delete_record.ts before T0-5). */
const legacyWiped = () => [
	{
		type: 'dd151',
		section_id: config.features.defaultProject,
		section_tipo: config.features.filterSectionTipo,
		from_component_tipo: FILTER,
	},
];

const projectFilter = (projectId: number) => [
	{
		id: 1,
		type: 'dd675',
		section_id: projectId,
		section_tipo: config.features.filterSectionTipo,
		from_component_tipo: FILTER,
	},
];

/** Live filter key (`undefined` absent). */
async function liveFilter(id: number): Promise<unknown> {
	const rows = (await sql.unsafe(
		`SELECT (relation ? $3) AS present, relation->$3 AS v FROM "${TABLE}"
		 WHERE section_tipo = $1 AND section_id = $2`,
		[FSECTION, id, FILTER],
	)) as { present: boolean | null; v: unknown }[];
	return rows[0]?.present === true ? rows[0]?.v : undefined;
}

async function tmRows(id: number): Promise<{ data: unknown }[]> {
	return (await sql.unsafe(
		`SELECT data FROM matrix_time_machine
		 WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3 ORDER BY id`,
		[FSECTION, id, FILTER],
	)) as { data: unknown }[];
}

async function setLiveFilter(id: number, value: unknown): Promise<void> {
	await sql.unsafe(
		`UPDATE "${TABLE}" SET relation = COALESCE(relation, '{}'::jsonb) || jsonb_build_object($3::text, $4::text::jsonb)
		 WHERE section_tipo = $1 AND section_id = $2`,
		[FSECTION, id, FILTER, JSON.stringify(value)],
	);
}

/**
 * A record as a pre-fix wipe left it: TM history `history` (oldest first, one
 * minute apart, ending at the wipe row), the live key the wipe value.
 */
async function legacyWipedRecord(history: readonly unknown[]): Promise<number> {
	const id = await createSectionRecord(FSECTION, USER_ID);
	// Born rows of this door are not under test: their history goes first.
	await sql.unsafe(
		`DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3`,
		[FSECTION, id, FILTER],
	);
	const base = Date.now() - 10 * 60_000;
	for (const [index, data] of [...history, legacyWiped()].entries()) {
		const at = new Date(base + index * 60_000);
		const stamp = at.toISOString().replace('T', ' ').slice(0, 19);
		await recordTimeMachine(
			{
				sectionTipo: FSECTION,
				sectionId: id,
				componentTipo: FILTER,
				lang: 'lg-nolan',
				userId: USER_ID,
				data,
			},
			stamp,
		);
	}
	await setLiveFilter(id, legacyWiped());
	return id;
}

interface MatchRow {
	section_tipo: string;
	section_id: number;
	filter_tipo: string;
	pre_wipe_filter: unknown;
	status: string;
	restored: boolean;
}

function matchesOf(detail: Record<string, unknown>): MatchRow[] {
	return [...((detail.matches as MatchRow[] | undefined) ?? [])].sort(
		(a, b) => a.section_id - b.section_id,
	);
}

let restorable = 0;
let missing = 0;
let unrecoverable = 0;
let edited = 0;

beforeAll(async () => {
	await assertTestDatabase('wiped_filter_reconcile_native');
	await ensureSituation(SITUATION);
	await installAclIdentityFixture();
	clearAclIdentityCaches();
	restorable = await legacyWipedRecord([projectFilter(ACL_PROJECT_ID)]);
	missing = await legacyWipedRecord([projectFilter(MISSING_PROJECT_ID)]);
	unrecoverable = await legacyWipedRecord([]);
	edited = await legacyWipedRecord([projectFilter(ACL_PROJECT_ID)]);
	// A curator re-filed it after the wipe: no longer the wipe's value.
	await setLiveFilter(edited, projectFilter(ACL_PROJECT_ID));
	await registerAllReconciles();
}, 60_000);

afterAll(async () => {
	await removeAclIdentityFixture();
	await dropSituation(SITUATION);
}, 60_000);

describe('wiped_filter_projects reconcile (T0-5 D1)', () => {
	test('registered: operator-run, never auto-applied, applicable by a global admin', () => {
		const definition = getReconcile(NAME);
		expect(definition, `${NAME} is not registered`).not.toBeNull();
		expect(definition?.schedule).toBe('operator');
		expect(definition?.autoApply).toBeUndefined();
		expect(applyPolicyOf(definition as never)).toBe('admin');
		expect(definition?.scopeLabel).toBe('section tipo');
	});

	test('DRY reports each legacy-wiped key with its pre-wipe filter and writes nothing', async () => {
		const before = await Promise.all(
			[restorable, missing, unrecoverable, edited].map(async (id) => ({
				live: await liveFilter(id),
				tm: (await tmRows(id)).length,
			})),
		);
		// FLOOR: the non-admin member cannot reach the wiped record.
		const member = await resolvePrincipal(ACL_NON_ADMIN_USER_ID);
		expect(await principalCanAccessRecord(FSECTION, restorable, member)).toBe(false);

		const { report } = await runReconcile(NAME, { apply: false, scope: [FSECTION] });
		expect(report.drift).toBe(3);
		expect(report.applied).toBe(0);
		expect(matchesOf(report.detail)).toEqual([
			{
				section_tipo: FSECTION,
				section_id: restorable,
				filter_tipo: FILTER,
				pre_wipe_filter: projectFilter(ACL_PROJECT_ID),
				status: 'restorable',
				restored: false,
			},
			{
				section_tipo: FSECTION,
				section_id: missing,
				filter_tipo: FILTER,
				pre_wipe_filter: projectFilter(MISSING_PROJECT_ID),
				status: 'project_missing',
				restored: false,
			},
			{
				section_tipo: FSECTION,
				section_id: unrecoverable,
				filter_tipo: FILTER,
				pre_wipe_filter: null,
				status: 'unrecoverable',
				restored: false,
			},
		]);
		const after = await Promise.all(
			[restorable, missing, unrecoverable, edited].map(async (id) => ({
				live: await liveFilter(id),
				tm: (await tmRows(id)).length,
			})),
		);
		expect(after).toEqual(before);
	});

	test('APPLY restores restorable + project_missing with a TM row; unrecoverable untouched', async () => {
		const tmBefore = (await tmRows(restorable)).length;
		const { report } = await runReconcile(NAME, { apply: true, scope: [FSECTION] });
		expect(report.drift).toBe(3);
		expect(report.applied).toBe(2);
		const rows = matchesOf(report.detail);
		expect(rows.map((row) => [row.section_id, row.status, row.restored])).toEqual([
			[restorable, 'restorable', true],
			[missing, 'project_missing', true],
			[unrecoverable, 'unrecoverable', false],
		]);

		expect(await liveFilter(restorable)).toEqual(projectFilter(ACL_PROJECT_ID));
		expect(await liveFilter(missing)).toEqual(projectFilter(MISSING_PROJECT_ID));
		expect(await liveFilter(unrecoverable)).toEqual(legacyWiped());
		expect(await liveFilter(edited)).toEqual(projectFilter(ACL_PROJECT_ID));

		// The restore is audited: one new visible row holding the restored value.
		const history = await tmRows(restorable);
		expect(history.length).toBe(tmBefore + 1);
		expect(history[history.length - 1]?.data).toEqual(projectFilter(ACL_PROJECT_ID));

		clearAclIdentityCaches();
		const member = await resolvePrincipal(ACL_NON_ADMIN_USER_ID);
		expect(await principalCanAccessRecord(FSECTION, restorable, member)).toBe(true);
	});

	test('a second APPLY is idempotent: only the unrecoverable key remains', async () => {
		const { report } = await runReconcile(NAME, { apply: true, scope: [FSECTION] });
		expect(report.drift).toBe(1);
		expect(report.applied).toBe(0);
		expect(matchesOf(report.detail).map((row) => [row.section_id, row.status])).toEqual([
			[unrecoverable, 'unrecoverable'],
		]);
	});
});

/** A record whose filter history is exactly `rows` (insertion order = id order), live key `live`. */
async function recordWithHistory(
	rows: readonly { data: unknown; stamp: string }[],
	live: unknown,
): Promise<number> {
	const id = await createSectionRecord(FSECTION, USER_ID);
	await sql.unsafe(
		`DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3`,
		[FSECTION, id, FILTER],
	);
	for (const row of rows) {
		await recordTimeMachine(
			{
				sectionTipo: FSECTION,
				sectionId: id,
				componentTipo: FILTER,
				lang: 'lg-nolan',
				userId: USER_ID,
				data: row.data,
			},
			row.stamp,
		);
	}
	await setLiveFilter(id, live);
	return id;
}

const stampAt = (offsetMs: number): string =>
	new Date(Date.now() - 10 * 60_000 + offsetMs).toISOString().replace('T', ' ').slice(0, 19);

function matchFor(detail: Record<string, unknown>, id: number): MatchRow | undefined {
	return matchesOf(detail).find((row) => row.section_id === id);
}

describe('wiped_filter_projects reconcile — history-walk regressions (review 2026-11-10)', () => {
	test('a curator write and the wipe in the SAME second: the wipe (higher id) is newer, the pre-wipe is the curator value', async () => {
		// A (older) → B (curator) and W (wipe) share one second, W inserted after
		// B. Newest-first must be W, B, A; a timestamp-only order may return B
		// first, skip it as "before the wipe" and answer the stale A.
		const tie = stampAt(60_000);
		const id = await recordWithHistory(
			[
				{ data: projectFilter(MISSING_PROJECT_ID), stamp: stampAt(0) },
				{ data: projectFilter(ACL_PROJECT_ID), stamp: tie },
				{ data: legacyWiped(), stamp: tie },
			],
			legacyWiped(),
		);
		const { report } = await runReconcile(NAME, { apply: false, scope: [FSECTION] });
		const row = matchFor(report.detail, id);
		expect(row, 'tied-timestamp record not matched').toBeDefined();
		expect(row?.pre_wipe_filter).toEqual(projectFilter(ACL_PROJECT_ID));
		expect(row?.status).toBe('restorable');
	});

	test('two legacy wipes straddling the int-canonical sweep (string + int section_id) are both skipped', async () => {
		const stringFormWipe = legacyWiped().map((item) => ({
			...item,
			section_id: String(config.features.defaultProject),
		}));
		const id = await recordWithHistory(
			[
				{ data: projectFilter(ACL_PROJECT_ID), stamp: stampAt(0) },
				{ data: stringFormWipe, stamp: stampAt(60_000) },
				{ data: legacyWiped(), stamp: stampAt(120_000) },
			],
			legacyWiped(),
		);
		const dry = await runReconcile(NAME, { apply: false, scope: [FSECTION] });
		expect(matchFor(dry.report.detail, id)?.pre_wipe_filter).toEqual(projectFilter(ACL_PROJECT_ID));

		const applied = await runReconcile(NAME, { apply: true, scope: [FSECTION] });
		expect(matchFor(applied.report.detail, id)?.restored).toBe(true);
		expect(await liveFilter(id)).toEqual(projectFilter(ACL_PROJECT_ID));

		// It left the signature: a later run no longer sees it.
		const again = await runReconcile(NAME, { apply: false, scope: [FSECTION] });
		expect(matchFor(again.report.detail, id)).toBeUndefined();
	});
});
