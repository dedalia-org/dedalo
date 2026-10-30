/**
 * THE EXTERNAL-MIRROR REFRESH DOOR — the portal's "update external data"
 * button (`source.build_options.get_data_external === true` on a component
 * get_data), end to end through routeSectionRead on the suite DB (2026-10-30).
 *
 * src/core/section/record/external_refresh.ts maybeRefreshExternal recomputes
 * the requested external mirror BEFORE the read serves it (PHP
 * component_portal_json.php :97). The mirror under test is
 * testcoincatalog1019, a source_overwrite copy of the type's test6105 named
 * by the term's pointer testcoincatalog1004. Every case makes it STALE first
 * by writing the source bag RAW (no propagation), so only the door can fix it.
 *
 * WHAT IS PINNED (synthesis §4 as overridden by owner ruling Q2 + critique 7):
 *   1. the flag on a stale mirror: the read WRITES (one TM row) and the SAME
 *      response serves the fresh data (read after write), no notice;
 *   2. a second identical call: zero writes;
 *   3. READ level 1 suffices (owner ruling): a non-admin reader holding the
 *      portal at 1 refreshes, and the TM actor is that reader (audit honesty);
 *      a user identical but for the portal at 0 gets the read refused AND
 *      the door refused (observers.refresh_refused), nothing written;
 *   4. no-ops (nothing written, no notice): the flag absent; the v6 spelling
 *      `get_dato_external` (ignored AND counted); a non-external component; a
 *      section read; `dd_core_api:start`; a Time Machine read (sqo.mode 'tm'
 *      and the open TM read scope — counted);
 *   5. withheld with a notice: a section that does not host the observer
 *      (target_not_host); a consultation-only section is refused;
 *   6. THE LOCK-WAIT BOUND (review 2026-10-30): the target row held FOR
 *      UPDATE by another transaction → the refresh gives up within
 *      EXTERNAL_REFRESH_LOCK_TIMEOUT, writes nothing, and says `busy`
 *      (retryable: true, counted); once released the same refresh runs;
 *   7. A WRITE IS DONE (review 2026-10-30): a degraded seed that withheld the
 *      drop but persisted an addition is counted done with no notice — only a
 *      degraded seed that wrote nothing is withheld `degraded_seed`.
 *
 * SITUATION: repo-owned `test`/`testcoincatalog` nodes (the suite ontology)
 * plus the explicit-id identity fixture below (two scratch users);
 * every record created at runtime and swept in afterAll (records + TM rows).
 * Case 7 builds its own `zzxrd` scratch situation (a law (c) external portal
 * whose data_from_field peer has no node), dropped whole with its residue
 * asserted.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { getCounters } from '../../src/core/api/counters.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { deleteMatrixRecord } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { withTimeMachineReadScope } from '../../src/core/section/list_definitions/time_machine_list.ts';
import { routeSectionRead } from '../../src/core/section/read_facade.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import {
	EXTERNAL_REFRESH_LOCK_TIMEOUT,
	externalRefreshTarget,
	maybeRefreshExternal,
	withheldReasonOf,
} from '../../src/core/section/record/external_refresh.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import {
	clearPermissionsCache,
	clearPrincipalCache,
	clearUserProjectsCache,
	type Principal,
	resolvePrincipal,
} from '../../src/core/security/permissions.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { cleanScratchRecord } from '../helpers/test_data.ts';

// ── the reader fixture ─────────────────────────────────────────────────

/**
 * THE READER FIXTURE (inline: a test/helpers writer would be one more door
 * test_db_marker_tripwire must probe) — two NON-ADMIN users whose profiles
 * differ on exactly ONE grant: the external portal the refresh door recomputes
 * (external_refresh_native).
 *
 * WHY. The refresh door (src/core/section/record/external_refresh.ts) is gated
 * by READ level 1 (owner ruling 2026-10-30, PHP parity). A gate that only ever
 * drives it as root cannot tell "read level 1 suffices" from "any principal is
 * waved through", nor from "only an admin may write". So this helper mints a
 * READER (level 1 on the portal) and a DENIED user identical in every way
 * (non-admin, same project, same section grant) EXCEPT the portal at 0.
 *
 * WHAT IT MINTS (explicit ids it owns and sweeps; string prefix `zzxref`; no
 * ontology node is written — users/profiles/projects are ordinary
 * dd128/dd234/dd153 records):
 *
 *   953021 matrix_projects  the one project both users are scoped to
 *   953011 matrix_profiles  READER  — dd774: testcoincatalog1 = 1,
 *                                     testcoincatalog1.testcoincatalog1019 = 1,
 *                                     testcoincatalog1.testcoincatalog1020 = 1 (projects filter)
 *   953012 matrix_profiles  DENIED  — the same, testcoincatalog1019 = 0
 *   953001 matrix_users     READER  — dd244 No, dd515 No, dd1725 → 953011, dd170 → 953021
 *   953002 matrix_users     DENIED  — as READER, dd1725 → 953012
 *
 * A scratch term is IN their scope when its projects filter
 * (testcoincatalog1020) names the project — `externalRefreshProjectLocator()`.
 *
 * SWEEP. `removeExternalRefreshReaderFixture()` deletes the five records and
 * their TM rows and THROWS when a matrix delete removes 0 rows.
 */
const XREF_READER_USER_ID = 953001;
const XREF_DENIED_USER_ID = 953002;
const XREF_READER_PROFILE_ID = 953011;
const XREF_DENIED_PROFILE_ID = 953012;
const XREF_PROJECT_ID = 953021;

const XREF_SECTION = 'testcoincatalog1';
/** The external portal under test (source_overwrite ← test6105). */
const XREF_PORTAL = 'testcoincatalog1019';
/** testcoincatalog1's projects filter (component_filter). */
const XREF_FILTER = 'testcoincatalog1020';

const USERS_SECTION = 'dd128';
const PROFILES_SECTION = 'dd234';
const PROJECTS_SECTION = 'dd153';
const YES_NO_SECTION = 'dd64';
const YES = 1;
const NO = 2;

const OWNED: { table: string; sectionTipo: string; sectionId: number }[] = [
	{ table: 'matrix_users', sectionTipo: USERS_SECTION, sectionId: XREF_READER_USER_ID },
	{ table: 'matrix_users', sectionTipo: USERS_SECTION, sectionId: XREF_DENIED_USER_ID },
	{ table: 'matrix_profiles', sectionTipo: PROFILES_SECTION, sectionId: XREF_READER_PROFILE_ID },
	{ table: 'matrix_profiles', sectionTipo: PROFILES_SECTION, sectionId: XREF_DENIED_PROFILE_ID },
	{ table: 'matrix_projects', sectionTipo: PROJECTS_SECTION, sectionId: XREF_PROJECT_ID },
];

/** Refuse an id that could address an installed identity record (the sweep deletes by id). */
const SCRATCH_ID_FLOOR = 900000;

function assertScratchIds(): void {
	for (const record of OWNED) {
		if (!Number.isInteger(record.sectionId) || record.sectionId < SCRATCH_ID_FLOOR) {
			throw new Error(
				`external_refresh_reader_fixture: ${record.table}/${record.sectionTipo} id ${record.sectionId} is below the scratch floor ${SCRATCH_ID_FLOOR}`,
			);
		}
	}
}

function identityLocator(componentTipo: string, sectionTipo: string, sectionId: number) {
	return {
		id: 1,
		type: 'dd151',
		section_id: sectionId,
		section_tipo: sectionTipo,
		from_component_tipo: componentTipo,
	};
}

/** One dd774 row — `${section}_${tipo}` → value is how getPermissionsTable reads it. */
function grant(id: number, tipo: string, value: number) {
	return { id, tipo, section_tipo: XREF_SECTION, value };
}

async function insertScratchRecord(
	table: string,
	sectionTipo: string,
	sectionId: number,
	columns: Record<string, unknown>,
): Promise<void> {
	const names = ['"section_tipo"', '"section_id"'];
	const placeholders = ['$1', '$2'];
	const params: (string | number)[] = [sectionTipo, sectionId];
	let index = 3;
	for (const [column, value] of Object.entries(columns)) {
		names.push(`"${column}"`);
		placeholders.push(`$${index}::text::jsonb`);
		params.push(encodeForJsonb(value));
		index++;
	}
	await sql.unsafe(
		`INSERT INTO "${table}" (${names.join(', ')}) VALUES (${placeholders.join(', ')})`,
		params,
	);
}

function clearExternalRefreshReaderCaches(): void {
	clearPrincipalCache();
	clearUserProjectsCache();
	clearPermissionsCache();
}

/** Mint the fixture. Idempotent: a crashed run's rows are swept first. */
async function installExternalRefreshReaderFixture(): Promise<void> {
	await assertTestDatabase('installExternalRefreshReaderFixture');
	assertScratchIds();
	await purge({ strict: false });

	await insertScratchRecord('matrix_projects', PROJECTS_SECTION, XREF_PROJECT_ID, {
		string: { dd156: [{ id: 1, lang: 'lg-eng', value: 'zzxref scratch project' }] },
	});
	for (const [profileId, portalLevel, name] of [
		[XREF_READER_PROFILE_ID, 1, 'zzxref reader profile'],
		[XREF_DENIED_PROFILE_ID, 0, 'zzxref denied profile'],
	] as const) {
		await insertScratchRecord('matrix_profiles', PROFILES_SECTION, profileId, {
			string: { dd237: [{ id: 1, lang: 'lg-eng', value: name }] },
			misc: {
				dd774: [
					grant(1, XREF_SECTION, 1),
					grant(2, XREF_FILTER, 1),
					// a PRESENT row on both (0 on the denied one), so the pair
					// differs by value, never by absence
					grant(3, XREF_PORTAL, portalLevel),
				],
			},
		});
	}
	for (const [userId, profileId, name] of [
		[XREF_READER_USER_ID, XREF_READER_PROFILE_ID, 'zzxref_reader'],
		[XREF_DENIED_USER_ID, XREF_DENIED_PROFILE_ID, 'zzxref_denied'],
	] as const) {
		await insertScratchRecord('matrix_users', USERS_SECTION, userId, {
			string: { dd132: [{ id: 1, lang: 'lg-nolan', value: name }] },
			relation: {
				dd131: [identityLocator('dd131', YES_NO_SECTION, YES)],
				dd244: [identityLocator('dd244', YES_NO_SECTION, NO)],
				dd515: [identityLocator('dd515', YES_NO_SECTION, NO)],
				dd1725: [identityLocator('dd1725', PROFILES_SECTION, profileId)],
				dd170: [identityLocator('dd170', PROJECTS_SECTION, XREF_PROJECT_ID)],
			},
		});
	}
	clearExternalRefreshReaderCaches();
}

async function removeExternalRefreshReaderFixture(): Promise<void> {
	await assertTestDatabase('removeExternalRefreshReaderFixture');
	await purge({ strict: true });
	clearExternalRefreshReaderCaches();
}

async function purge(options: { strict: boolean }): Promise<void> {
	assertScratchIds();
	const missing: string[] = [];
	for (const record of OWNED) {
		const removed = await deleteMatrixRecord(record.table, record.sectionTipo, record.sectionId);
		if (removed === 0) missing.push(`${record.table}/${record.sectionTipo}/${record.sectionId}`);
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[record.sectionTipo, record.sectionId],
		);
	}
	if (options.strict && missing.length > 0) {
		throw new Error(
			`external_refresh_reader_fixture sweep removed 0 rows for: ${missing.join(', ')} — the scratch filter is wrong or another run deleted them`,
		);
	}
}

/** The projects-filter locator that puts a scratch term IN both users' scope. */
function externalRefreshProjectLocator() {
	return identityLocator(XREF_FILTER, PROJECTS_SECTION, XREF_PROJECT_ID);
}

// ── the gate ──────────────────────────────────────────────────────────────

const USER_ID = -1;
const SUPERUSER: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };

const TERM_SECTION = XREF_SECTION;
const POINTER = 'testcoincatalog1004';
const MIRROR = XREF_PORTAL;
const TYPE_SECTION = 'test6099';
const TYPE_ORDERED = 'test6105';
const ORDERED_SECTION = 'test6310';
/** The Time Machine section — consultation-only for every caller. */
const TM_SECTION = 'dd15';

const created: { sectionTipo: string; sectionId: number }[] = [];
const tables = new Map<string, string>();

async function tableOf(sectionTipo: string): Promise<string> {
	const known = tables.get(sectionTipo);
	if (known !== undefined) return known;
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === null) throw new Error(`no matrix table for ${sectionTipo}`);
	tables.set(sectionTipo, table);
	return table;
}

async function born(sectionTipo: string): Promise<number> {
	const sectionId = await createSectionRecord(sectionTipo, USER_ID);
	created.push({ sectionTipo, sectionId });
	return sectionId;
}

const locator = (from: string, sectionTipo: string, sectionId: number) => ({
	type: 'dd151',
	section_tipo: sectionTipo,
	section_id: String(sectionId),
	from_component_tipo: from,
});

type Item = Record<string, unknown>;

async function relationKey(sectionTipo: string, sectionId: number, key: string): Promise<Item[]> {
	const rows = (await sql.unsafe(
		`SELECT relation->$3 AS value FROM "${await tableOf(sectionTipo)}" WHERE section_tipo = $1 AND section_id = $2`,
		[sectionTipo, sectionId, key],
	)) as { value: unknown }[];
	const value = rows[0]?.value;
	return Array.isArray(value) ? (value as Item[]) : [];
}

/** Store one relation key RAW — no door, no propagation (makes a mirror stale). */
async function storeRelationKey(
	sectionTipo: string,
	sectionId: number,
	key: string,
	value: unknown[],
): Promise<void> {
	await assertTestDatabase('external_refresh_native.storeRelationKey');
	await sql.unsafe(
		`UPDATE "${await tableOf(sectionTipo)}" SET relation = jsonb_set(COALESCE(relation, '{}'::jsonb), ARRAY[$3::text], $4::text::jsonb)
		 WHERE section_tipo = $1 AND section_id = $2`,
		[sectionTipo, sectionId, key, JSON.stringify(value)],
	);
}

/** The mirror's TM rows (every row: a write of any kind is one). */
async function tmRows(sectionId: number): Promise<{ user_id: string; data: unknown }[]> {
	return (await sql.unsafe(
		'SELECT user_id, data FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3 ORDER BY id',
		[TERM_SECTION, sectionId, MIRROR],
	)) as { user_id: string; data: unknown }[];
}

const ids = (items: Item[]): number[] => items.map((item) => Number(item.section_id));

let typeA = 0;
const ordered: number[] = [];
let term = 0;

/** The type's ordered coins, stored RAW: the term's mirror goes stale. */
async function setSourceRaw(count: number): Promise<number[]> {
	const chosen = ordered.slice(0, count);
	await storeRelationKey(
		TYPE_SECTION,
		typeA,
		TYPE_ORDERED,
		chosen.map((id, at) => ({
			id: at + 1,
			...locator(TYPE_ORDERED, ORDERED_SECTION, id),
			section_id: id,
		})),
	);
	return chosen;
}

function getDataRqo(
	buildOptions: Record<string, unknown> | undefined,
	overrides: { tipo?: string; section_tipo?: string; section_id?: number; action?: string } = {},
	sqo?: Record<string, unknown>,
): Rqo {
	return {
		dd_api: 'dd_core_api',
		action: overrides.action ?? 'read',
		source: {
			action: 'get_data',
			model: 'component_portal',
			tipo: overrides.tipo ?? MIRROR,
			section_tipo: overrides.section_tipo ?? TERM_SECTION,
			section_id: overrides.section_id ?? term,
			mode: 'edit',
			lang: 'lg-nolan',
			...(buildOptions === undefined ? {} : { build_options: buildOptions }),
		},
		...(sqo === undefined ? {} : { sqo }),
	} as unknown as Rqo;
}

interface ReadBody {
	ok?: boolean;
	data?: { data?: Item[] };
	notices?: { code: string; details?: Record<string, unknown> }[];
}

async function read(rqo: Rqo, principal: Principal): Promise<ReadBody> {
	const result = await routeSectionRead(rqo, principal);
	return result.body as ReadBody;
}

/** The mirror's locators as the read served them (the component's own data item). */
function servedIds(body: ReadBody): number[] {
	const own = (body.data?.data ?? []).find(
		(item) => item.tipo === MIRROR && Number(item.section_id) === term,
	);
	return ((own?.entries ?? own?.value ?? []) as Item[]).map((entry) => Number(entry.section_id));
}

const counter = (name: string): number => getCounters()[name] ?? 0;

beforeAll(async () => {
	await installExternalRefreshReaderFixture();
	typeA = await born(TYPE_SECTION);
	for (let n = 0; n < 4; n++) ordered.push(await born(ORDERED_SECTION));
	await setSourceRaw(1);
	term = await born(TERM_SECTION);
	await storeRelationKey(TERM_SECTION, term, XREF_FILTER, [externalRefreshProjectLocator()]);
	const saved = await saveComponentData({
		componentTipo: POINTER,
		sectionTipo: TERM_SECTION,
		sectionId: term,
		lang: 'lg-nolan',
		changedData: [
			{ action: 'set_data', id: null, value: [locator(POINTER, TYPE_SECTION, typeA)] },
		] as never,
		userId: USER_ID,
	});
	expect(saved.ok, saved.message).toBe(true);
}, 120_000);

afterAll(async () => {
	for (const { sectionTipo, sectionId } of created.reverse()) {
		await cleanScratchRecord(sectionTipo, sectionId, await tableOf(sectionTipo));
	}
	await removeExternalRefreshReaderFixture();
}, 120_000);

describe('FLOOR', () => {
	test('the pointer save computed the mirror; a raw source write leaves it stale', async () => {
		expect(ids(await relationKey(TERM_SECTION, term, MIRROR))).toEqual([ordered[0] as number]);
		await setSourceRaw(2);
		expect(ids(await relationKey(TERM_SECTION, term, MIRROR)), 'the raw write propagated').toEqual([
			ordered[0] as number,
		]);
	});
});

describe('1-2. the flag refreshes BEFORE the read, and converges', () => {
	test('1. a stale mirror is recomputed, written once, and the SAME response serves it', async () => {
		const want = await setSourceRaw(3);
		const before = (await tmRows(term)).length;
		const body = await read(getDataRqo({ get_data_external: true }), SUPERUSER);
		expect(body.ok).toBe(true);
		expect(body.notices, 'a permitted refresh carries no notice').toBeUndefined();
		expect(ids(await relationKey(TERM_SECTION, term, MIRROR))).toEqual(want);
		expect((await tmRows(term)).length, 'one TM row for the refresh write').toBe(before + 1);
		expect(
			servedIds(body),
			'the read served the stored (stale) data — not read after write',
		).toEqual(want);
	}, 120_000);

	test('2. a second identical call writes nothing', async () => {
		const before = await tmRows(term);
		const stored = await relationKey(TERM_SECTION, term, MIRROR);
		const body = await read(getDataRqo({ get_data_external: true }), SUPERUSER);
		expect(body.notices).toBeUndefined();
		expect(await tmRows(term)).toEqual(before);
		expect(await relationKey(TERM_SECTION, term, MIRROR)).toEqual(stored);
	}, 120_000);
});

describe('3. READ level 1 is the permission (owner ruling)', () => {
	test('a non-admin reader holding the portal at 1 refreshes; the TM actor is the reader', async () => {
		const reader = await resolvePrincipal(XREF_READER_USER_ID);
		expect(reader.isGlobalAdmin, 'FLOOR: the reader is not an admin').toBe(false);
		const want = await setSourceRaw(4);
		const body = await read(getDataRqo({ get_data_external: true }), reader);
		expect(body.notices, JSON.stringify(body.notices)).toBeUndefined();
		expect(ids(await relationKey(TERM_SECTION, term, MIRROR))).toEqual(want);
		const last = (await tmRows(term)).at(-1);
		expect(last?.user_id, 'the refresh write is not audited to the requester').toBe(
			String(XREF_READER_USER_ID),
		);
	}, 120_000);

	test('the portal at 0: the read is withheld and the door refuses — nothing written', async () => {
		const denied = await resolvePrincipal(XREF_DENIED_USER_ID);
		await setSourceRaw(1);
		const stored = await relationKey(TERM_SECTION, term, MIRROR);
		const before = (await tmRows(term)).length;
		await read(getDataRqo({ get_data_external: true }), denied);
		expect(await relationKey(TERM_SECTION, term, MIRROR)).toEqual(stored);
		// the door ITSELF refuses too (a second wall behind the read's own gate)
		const notices = await maybeRefreshExternal(getDataRqo({ get_data_external: true }), denied);
		expect(notices.map((notice) => notice.code)).toEqual(['observers.refresh_refused']);
		expect(await relationKey(TERM_SECTION, term, MIRROR)).toEqual(stored);
		expect((await tmRows(term)).length).toBe(before);
	}, 120_000);
});

describe('4. no-ops: nothing written, no notice', () => {
	/** Every no-op case starts from a STALE mirror, so a write would show. */
	async function expectNoWrite(run: () => Promise<readonly unknown[] | undefined>): Promise<void> {
		await setSourceRaw(2);
		const stored = await relationKey(TERM_SECTION, term, MIRROR);
		const stale = ids(await relationKey(TYPE_SECTION, typeA, TYPE_ORDERED));
		expect(stale.length, 'FLOOR: the source is non-empty').toBeGreaterThan(0);
		expect(ids(stored), 'FLOOR: the mirror is stale, so a refresh would show').not.toEqual(stale);
		const before = (await tmRows(term)).length;
		const notices = await run();
		expect(notices ?? [], 'a no-op carries no notice').toEqual([]);
		expect(await relationKey(TERM_SECTION, term, MIRROR), 'the mirror was refreshed').toEqual(
			stored,
		);
		expect((await tmRows(term)).length).toBe(before);
	}

	test('the flag absent (a plain read)', async () => {
		await expectNoWrite(async () => (await read(getDataRqo(undefined), SUPERUSER)).notices);
	}, 120_000);

	test('the v6 spelling get_dato_external — ignored, and counted', async () => {
		const counted = counter('rqo_deprecated_get_dato_external');
		await expectNoWrite(
			async () => (await read(getDataRqo({ get_dato_external: true }), SUPERUSER)).notices,
		);
		expect(counter('rqo_deprecated_get_dato_external')).toBe(counted + 1);
	}, 120_000);

	test('a non-boolean flag (strict === true)', async () => {
		await expectNoWrite(() =>
			maybeRefreshExternal(getDataRqo({ get_data_external: 'true' }), SUPERUSER),
		);
	}, 120_000);

	test('a NON-external component (the pointer itself)', async () => {
		expect(
			await externalRefreshTarget(getDataRqo({ get_data_external: true }, { tipo: POINTER })),
		).toBeNull();
		await expectNoWrite(() =>
			maybeRefreshExternal(getDataRqo({ get_data_external: true }, { tipo: POINTER }), SUPERUSER),
		);
	}, 120_000);

	test('a SECTION read (tipo = section_tipo)', async () => {
		expect(
			await externalRefreshTarget(getDataRqo({ get_data_external: true }, { tipo: TERM_SECTION })),
		).toBeNull();
	}, 60_000);

	test('dd_core_api:start can never reach the door', async () => {
		const rqo = getDataRqo({ get_data_external: true }, { action: 'start' });
		expect(await externalRefreshTarget(rqo)).toBeNull();
		await expectNoWrite(() => maybeRefreshExternal(rqo, SUPERUSER));
	}, 120_000);

	test('a Time Machine read — sqo.mode tm, and inside the TM read scope — counted', async () => {
		const skipped = counter('observers_external_refresh_skipped_tm');
		const tmSqo = { mode: 'tm', section_tipo: [TERM_SECTION] };
		await expectNoWrite(() =>
			maybeRefreshExternal(getDataRqo({ get_data_external: true }, {}, tmSqo), SUPERUSER),
		);
		await expectNoWrite(() =>
			withTimeMachineReadScope(tmSqo, () =>
				maybeRefreshExternal(getDataRqo({ get_data_external: true }), SUPERUSER),
			),
		);
		expect(counter('observers_external_refresh_skipped_tm')).toBe(skipped + 2);
	}, 120_000);
});

describe('5. past the preconditions, a refresh that cannot run says so', () => {
	test('a section that does not host the observer → withheld target_not_host, no slot born', async () => {
		const notices = await maybeRefreshExternal(
			getDataRqo({ get_data_external: true }, { section_tipo: TYPE_SECTION, section_id: typeA }),
			SUPERUSER,
		);
		expect(notices.map((notice) => [notice.code, notice.details?.reason])).toEqual([
			['observers.refresh_withheld', 'target_not_host'],
		]);
		const rows = (await sql.unsafe(
			`SELECT relation ? $3 AS has FROM "${await tableOf(TYPE_SECTION)}" WHERE section_tipo = $1 AND section_id = $2`,
			[TYPE_SECTION, typeA, MIRROR],
		)) as { has: boolean }[];
		expect(rows[0]?.has).toBe(false);
	}, 120_000);

	test('a consultation-only section is refused', async () => {
		const notices = await maybeRefreshExternal(
			getDataRqo({ get_data_external: true }, { section_tipo: TM_SECTION, section_id: 1 }),
			SUPERUSER,
		);
		expect(notices.map((notice) => notice.code)).toEqual(['observers.refresh_refused']);
	}, 60_000);
});

describe('6. THE LOCK-WAIT BOUND: a row another transaction holds → busy, bounded, nothing written', () => {
	/** The bound in ms (the constant's `<n>s` / `<n>ms` grammar). */
	const boundMs = EXTERNAL_REFRESH_LOCK_TIMEOUT.endsWith('ms')
		? Number.parseInt(EXTERNAL_REFRESH_LOCK_TIMEOUT, 10)
		: Number.parseInt(EXTERNAL_REFRESH_LOCK_TIMEOUT, 10) * 1000;
	/** Long past the bound: an UNBOUNDED wait only ends when the holder lets go. */
	const HOLD_MS = boundMs + 8_000;

	/** Hold the term row FOR UPDATE on a reserved connection; rolls back after HOLD_MS. */
	async function holdTermRow(): Promise<{ released: Promise<void> }> {
		await assertTestDatabase('external_refresh_native.holdTermRow');
		const connection = await sql.reserve();
		await connection.unsafe('BEGIN', []);
		const held = (await connection.unsafe(
			`SELECT section_id FROM "${await tableOf(TERM_SECTION)}" WHERE section_tipo = $1 AND section_id = $2 FOR UPDATE`,
			[TERM_SECTION, term],
		)) as unknown[];
		expect(held.length, 'FLOOR: the holder locked the term row').toBe(1);
		const released = Bun.sleep(HOLD_MS).then(async () => {
			try {
				await connection.unsafe('ROLLBACK', []);
			} finally {
				connection.release();
			}
		});
		return { released };
	}

	test('the refresh answers withheld busy (retryable) within the bound; the stale mirror stays', async () => {
		const want = await setSourceRaw(3);
		const stored = await relationKey(TERM_SECTION, term, MIRROR);
		expect(ids(stored), 'FLOOR: the mirror is stale, so a refresh would show').not.toEqual(want);
		const before = (await tmRows(term)).length;
		const busy = counter('observers_external_refresh_busy');
		const withheld = counter('observers_external_refresh_withheld');

		const { released } = await holdTermRow();
		const started = performance.now();
		const notices = await maybeRefreshExternal(getDataRqo({ get_data_external: true }), SUPERUSER);
		const elapsed = performance.now() - started;
		try {
			expect(
				notices.map((notice) => [notice.code, notice.details?.reason, notice.retryable]),
			).toEqual([['observers.refresh_withheld', 'busy', true]]);
			// it WAITED (the bound fired, not an instant refusal) and gave up long
			// before the holder let go (an unbounded wait ends only at HOLD_MS)
			expect(elapsed).toBeGreaterThanOrEqual(boundMs - 250);
			expect(elapsed).toBeLessThan(boundMs + 4_000);
			expect(await relationKey(TERM_SECTION, term, MIRROR)).toEqual(stored);
			expect((await tmRows(term)).length, 'a busy refresh wrote a TM row').toBe(before);
			expect(counter('observers_external_refresh_busy')).toBe(busy + 1);
			expect(counter('observers_external_refresh_withheld')).toBe(withheld + 1);
		} finally {
			await released;
		}

		// released: the SAME refresh now runs — busy was the lock, nothing else
		const after = await maybeRefreshExternal(getDataRqo({ get_data_external: true }), SUPERUSER);
		expect(after).toEqual([]);
		expect(ids(await relationKey(TERM_SECTION, term, MIRROR))).toEqual(want);
	}, 60_000);
});

// ── 7. a degraded seed that WROTE is done ───────────────────────────────────

/** Scratch situation: a law (c) external portal whose data_from_field peer has NO node. */
const XRD_TERM_SECTION = 'zzxrd1';
const XRD_MIRROR = 'zzxrd2';
const XRD_REF_SECTION = 'zzxrd3';
const XRD_INDEXER = 'zzxrd4';
/** Never created — the degraded-seed defect (`peer_node_missing:zzxrd99`). */
const XRD_MISSING_PEER = 'zzxrd99';
const XRD_TERM_ID = 1;
const XRD_REFERENCER_ID = 1;
/** A mirror entry nothing references: the law wants it DROPPED (the seed withholds that). */
const XRD_STALE = {
	id: 1,
	type: 'dd151',
	section_id: 77,
	section_tipo: XRD_REF_SECTION,
	from_component_tipo: XRD_MIRROR,
};

const XRD_SITUATION = situation({
	tld: 'zzxrd',
	name: 'external refresh degraded seed',
	nodes: [
		{ tipo: XRD_TERM_SECTION, model: 'section', parent: 'dd14' },
		{
			tipo: XRD_MIRROR,
			model: 'component_autocomplete',
			parent: XRD_TERM_SECTION,
			properties: {
				source: {
					mode: 'external',
					data_from_field: [XRD_MISSING_PEER],
					section_to_search: [XRD_REF_SECTION],
					component_to_search: [XRD_INDEXER],
				},
				observe: [
					{
						component_tipo: XRD_INDEXER,
						server: {
							config: { use_self_section: false, use_observable_dato: true },
							perform: { function: 'set_dato_external', params: { references_limit: 0 } },
						},
					},
				],
			},
		},
		{ tipo: XRD_REF_SECTION, model: 'section', parent: 'dd14' },
		{
			tipo: XRD_INDEXER,
			model: 'component_autocomplete_hi',
			parent: XRD_REF_SECTION,
			properties: {
				config_relation: { relation_type: 'dd96' },
				observers: [{ section_tipo: XRD_TERM_SECTION, component_tipo: XRD_MIRROR }],
			},
		},
	],
	records: [
		{
			section_tipo: XRD_TERM_SECTION,
			section_id: XRD_TERM_ID,
			columns: { relation: { [XRD_MIRROR]: [XRD_STALE] } },
		},
		{
			section_tipo: XRD_REF_SECTION,
			section_id: XRD_REFERENCER_ID,
			columns: {
				relation: {
					[XRD_INDEXER]: [
						{
							id: 1,
							type: 'dd96',
							section_id: XRD_TERM_ID,
							section_tipo: XRD_TERM_SECTION,
							from_component_tipo: XRD_INDEXER,
						},
					],
				},
			},
		},
	],
});

describe('7. a degraded seed that persisted an addition is a DONE refresh', () => {
	beforeAll(async () => {
		await ensureSituation(XRD_SITUATION);
	}, 60_000);
	afterAll(async () => {
		expect(await dropSituation(XRD_SITUATION), 'zzxrd residue').toBe(0);
	}, 60_000);

	test('the outcome law: `wrote` before any flag (pure)', () => {
		expect(withheldReasonOf({ wrote: true, skippedShrink: true })).toBeNull();
		expect(withheldReasonOf({ changed: true, skippedShrink: true })).toBe('degraded_seed');
		expect(withheldReasonOf({ wrote: true, refusedLaw: { reason: 'x' } })).toBe('law_refused');
	});

	test('drop withheld, addition written → counted done, no notice', async () => {
		const rqo = getDataRqo(
			{ get_data_external: true },
			{ tipo: XRD_MIRROR, section_tipo: XRD_TERM_SECTION, section_id: XRD_TERM_ID },
		);
		const degraded = counter('observers_shrink_refused_degraded_seed');
		const done = counter('observers_external_refresh_done');
		const withheld = counter('observers_external_refresh_withheld');

		const notices = await maybeRefreshExternal(rqo, SUPERUSER);

		// FLOOR: the seed WAS degraded and the drop WAS withheld (else this case
		// would prove nothing about the degraded branch)
		expect(counter('observers_shrink_refused_degraded_seed')).toBe(degraded + 1);
		const bag = await relationKey(XRD_TERM_SECTION, XRD_TERM_ID, XRD_MIRROR);
		expect(
			bag.map((item) => [item.section_tipo, Number(item.section_id)]),
			'the stale entry kept + the referencer appended',
		).toEqual([
			[XRD_REF_SECTION, XRD_STALE.section_id],
			[XRD_REF_SECTION, XRD_REFERENCER_ID],
		]);
		// THE LAW: it wrote, so it is done — no "could not be refreshed" notice
		expect(notices).toEqual([]);
		expect(counter('observers_external_refresh_done')).toBe(done + 1);
		expect(counter('observers_external_refresh_withheld')).toBe(withheld);

		// and a second call — the drop still withheld, nothing left to add —
		// wrote NOTHING, so it IS withheld degraded_seed
		const again = await maybeRefreshExternal(rqo, SUPERUSER);
		expect(again.map((notice) => [notice.code, notice.details?.reason])).toEqual([
			['observers.refresh_withheld', 'degraded_seed'],
		]);
	}, 60_000);
});
