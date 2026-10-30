/**
 * PERMISSIONS parity gates — the five beta-audit findings in §5.4 / §7 of
 * `audits/2026-08_oh1_beta/REPORT.md`. Each rule is asserted from BOTH sides:
 * the AUTHORISED principal gets through AND the unauthorised one does not, so a
 * regression in either direction (a re-opened hole OR a re-introduced
 * over-tightening) turns this file red.
 *
 * The findings covered here:
 *
 *  2. `is_global_admin` was stamped at login as `user_id === -1`, so a REAL
 *     global admin (dd244 → dd64/1) got a session flagged non-admin and was
 *     refused by every admin-only endpoint that reads the SESSION flag
 *     (api/counters.ts). PHP sets the session flag from
 *     `security::is_global_admin()` at login (class.security.php:636-690).
 *
 *  3. The Users section (dd128) had NO visibility rule at EITHER door. The
 *     leak the audit names is ENUMERATION: dd128 has no `component_filter`
 *     child, so the assembler's projects filter resolved to '' and any
 *     non-admin with a dd128 read grant listed/searched every user record.
 *     PHP gives dd128 its own switch arm — `section_id > 0 AND (created_by = me
 *     OR shares one of my projects)` (search/trait.where.php:775-836) — plus
 *     the own-record allowance of security::user_can_access_record
 *     (class.security.php:1035-1042). The rule now lives ONCE, in the
 *     assembler (buildUsersProjectsFilter), and record_scope.ts inherits it by
 *     running the real assembler; the divergences from PHP are declared in
 *     WC-2026-08-09-users-section-record-scope. Both doors are asserted here,
 *     plus their EQUIVALENCE — that pair is the anti-drift gate.
 *
 *  4. menu.ts resolved section_tool entries against the SUPERUSER tool list
 *     instead of the caller's (PHP menu.php:231 `tool_common::get_user_tools(
 *     logged_user_id())`, whose unfiltered branch is DEDALO_SUPERUSER only —
 *     tool_common.php:1403).
 *
 *  5. component_security_access's ACL datalist was served unfiltered to
 *     non-global-admins. PHP narrows the area list to the tipos present in the
 *     caller's own dd774 data (component_security_access.php:214-236).
 *
 * FIXTURES. Everything is SCRATCH: one profile record (dd234) with a tiny,
 * known dd774 grant list and NO tool grants, plus five user records (dd128)
 * with known created_by / project locators and a real global admin. All are
 * deleted in afterAll together with their time-machine rows. Nothing
 * pre-existing is mutated.
 */
// Migrated to the generic `test` TLD 2026-08-20 (and renamed off `oh1`, which
// was never the subject): the two ontology tipos the fixtures grant are the
// `test`-TLD clones of the audited install's section (`test6813`) and its
// section_tool area (`test6877`, tool_transcription) — the mechanism under test
// is the permission rule, not either install.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import { getMenuTreeDatalist } from '../../src/core/api/handlers/menu.ts';
import { sanitizeClientSqo } from '../../src/core/concepts/sqo.ts';
import {
	deleteMatrixRecord,
	insertMatrixRecordWithCounter,
} from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { getSecurityAccessDatalist } from '../../src/core/resolve/security_access_datalist.ts';
import { login } from '../../src/core/security/auth.ts';
import {
	clearPermissionsCache,
	clearPrincipalCache,
	clearUserProjectsCache,
	getGrantedTipos,
	PROFILES_SECTION,
	type Principal,
	resolvePrincipal,
} from '../../src/core/security/permissions.ts';
import {
	filterLocatorsInScope,
	isRecordInScope,
	principalCanAccessRecord,
} from '../../src/core/security/record_scope.ts';
import { getSession, resetSessionStoreForTests } from '../../src/core/security/session_store.ts';
import { buildSearchSql } from '../helpers/search_sql.ts';

const USERS_TABLE = 'matrix_users';
const USERS_SECTION_TIPO = 'dd128';
const PROFILES_TABLE = 'matrix_profiles';
const PROFILES_SECTION_TIPO = 'dd234';
const PROJECTS_SECTION_TIPO = config.features.filterSectionTipo;
/** The section_tool area whose tool (tool_transcription) is NOT always_active. */
const SECTION_TOOL_AREA = 'test6877';
const SECTION_TOOL_NAME = 'tool_transcription';
/** An ordinary section the scratch profile grants — any real section will do. */
const GRANTED_SECTION = 'test6813';

/** Unique per run so a crashed previous run can never collide. */
const RUN_TAG = `permaudit_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
const ADMIN_PASSWORD = 'scratch_admin_password_42';

/**
 * A dd170 (component_filter_master) project locator. `type` is a REAL-DATA
 * variable: the live oral-history archive stores both `dd675` (52 locators) and
 * `dd151` (2) for the same component, which is why the project match is
 * type-less (WC-2026-08-09-users-section-record-scope).
 */
function projectLocator(id: number, index: number, type = 'dd151') {
	return {
		id: index,
		type,
		section_id: String(id),
		section_tipo: PROJECTS_SECTION_TIPO,
		from_component_tipo: 'dd170',
	};
}

/** A dd1725 profile-select locator. */
function profileLocator(profileId: number) {
	return {
		id: 1,
		type: 'dd151',
		section_id: String(profileId),
		section_tipo: PROFILES_SECTION_TIPO,
		from_component_tipo: 'dd1725',
	};
}

/** The dd244 security-administrator radio locator (dd64/1 = yes, dd64/2 = no). */
function globalAdminLocator(yes: boolean) {
	return {
		id: 1,
		type: 'dd151',
		section_id: yes ? '1' : '2',
		section_tipo: 'dd64',
		from_component_tipo: 'dd244',
	};
}

interface ScratchUserSpec {
	username?: string;
	passwordHash?: string;
	profileId?: number;
	projectIds?: number[];
	/** `type` written on every dd170 locator (real installs carry both). */
	projectLocatorType?: string;
	createdBy?: number;
	globalAdmin?: boolean;
	/**
	 * dd131 'Active account'. It used to be stamped Yes UNCONDITIONALLY here, under a
	 * comment claiming the login path required it — prose asserting a rule the code did
	 * not have (SEC-07), plus a fixture that made its absence unobservable: no scratch
	 * user could ever be inactive, so nothing here could ever notice that login ignored
	 * the flag. It is now an explicit input with three states, and the fixture's own
	 * assertions below pin all three.
	 *
	 *   'yes'     — dd131 → dd64/1 (active).
	 *   'no'      — dd131 → dd64/2 (deactivated; login must refuse).
	 *   'absent'  — no dd131 datum at all, which is how EVERY user this engine creates
	 *               is born (the shipped node has no dato_default). Login ALLOWS it, on
	 *               purpose and by measurement — see auth.ts isRefusedForInactivity.
	 */
	activeAccount?: 'yes' | 'no' | 'absent';
}

async function insertScratchUser(spec: ScratchUserSpec): Promise<number> {
	const relation: Record<string, unknown[]> = {};
	if (spec.profileId !== undefined) relation.dd1725 = [profileLocator(spec.profileId)];
	if (spec.projectIds !== undefined) {
		relation.dd170 = spec.projectIds.map((id, index) =>
			projectLocator(id, index + 1, spec.projectLocatorType),
		);
	}
	if (spec.globalAdmin !== undefined) relation.dd244 = [globalAdminLocator(spec.globalAdmin)];
	const string: Record<string, unknown[]> = {};
	if (spec.username !== undefined) {
		string.dd132 = [{ id: 1, lang: 'lg-nolan', value: spec.username }];
	}
	if (spec.passwordHash !== undefined) {
		string.dd133 = [{ id: 1, lang: 'lg-nolan', value: spec.passwordHash }];
	}
	// dd131 'Active account' — CONSULTED by the login path since 2026-08-28 (SEC-07).
	// Default 'yes' so the existing fixtures keep their meaning; 'absent' writes no
	// datum at all, which is the shape a TS-created user really has.
	const activeAccount = spec.activeAccount ?? 'yes';
	if (activeAccount !== 'absent') {
		relation.dd131 = [
			{
				id: 1,
				type: 'dd151',
				section_id: activeAccount === 'yes' ? '1' : '2',
				section_tipo: 'dd64',
				from_component_tipo: 'dd131',
			},
		];
	}
	return insertMatrixRecordWithCounter(USERS_TABLE, USERS_SECTION_TIPO, {
		relation,
		string,
		data: {
			label: RUN_TAG,
			section_tipo: USERS_SECTION_TIPO,
			created_by_user_id: spec.createdBy ?? -1,
		},
	});
}

async function cleanupRecord(table: string, sectionTipo: string, sectionId: number): Promise<void> {
	if (sectionId <= 0) return;
	await deleteMatrixRecord(table, sectionTipo, sectionId);
	await sql.unsafe('DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2', [
		sectionTipo,
		sectionId,
	]);
}

/**
 * Run a LIST/SEARCH of one section as `principal` through the real assembler
 * and return the section_ids it yields — the ENUMERATION door the audit's
 * finding 3 is actually about (a per-record helper cannot close it).
 */
async function listSectionIds(sectionTipo: string, principal: Principal): Promise<number[]> {
	const sqo = sanitizeClientSqo({ section_tipo: [sectionTipo], limit: 500 });
	const query = await buildSearchSql(sqo, { principal });
	const rows = (await sql.unsafe(query.sql, query.params as (string | number | null)[])) as {
		section_id: number;
	}[];
	return rows.map((row) => Number(row.section_id));
}

/** Drop every per-user security cache (raw SQL inserts fire no save events). */
function clearSecurityCaches(): void {
	clearPermissionsCache();
	clearPrincipalCache();
	clearUserProjectsCache();
}

// The scratch surface.
let profileId = 0;
/** Non-admin, profile-assigned, projects [P1]; the "caller" of most assertions. */
let userA = 0;
/** Shares project P1 with A, created by the superuser. */
let userB = 0;
/** Project P2 only, created by the superuser — A must NOT see it. */
let userC = 0;
/** No projects at all, but CREATED BY A — A must see it. */
let userD = 0;
/** Shares project P1 with A but through a DIFFERENT locator `type` (dd675). */
let userE = 0;
/** A real global admin (dd244 → yes) with a password, for the login stamp. */
let adminUserId = 0;
/** dd131 = No — the deactivation an operator actually performs (SEC-07). */
let inactiveUserId = 0;
/** NO dd131 datum at all — the shape every TS-created user is born with. */
let noFlagUserId = 0;

let principalA: Principal;
/** userD's principal — a REAL user with NO projects (the lockout canary). */
let principalD: Principal;
let adminPrincipal: Principal;
let superuser: Principal;

const PROJECT_ONE = 990001;
const PROJECT_TWO = 990002;

beforeAll(async () => {
	// A profile whose dd774 grants ONLY the GRANTED_SECTION and the section_tool
	// area (self-keyed), and whose dd1067 grants NO tools.
	profileId = await insertMatrixRecordWithCounter(PROFILES_TABLE, PROFILES_SECTION_TIPO, {
		misc: {
			dd774: [
				{ id: 1, tipo: GRANTED_SECTION, section_tipo: GRANTED_SECTION, value: 2 },
				{ id: 2, tipo: SECTION_TOOL_AREA, section_tipo: SECTION_TOOL_AREA, value: 2 },
			],
		},
		relation: { dd1067: [] },
		data: { label: RUN_TAG, section_tipo: PROFILES_SECTION_TIPO },
	});

	userA = await insertScratchUser({ profileId, projectIds: [PROJECT_ONE], createdBy: -1 });
	userB = await insertScratchUser({ projectIds: [PROJECT_ONE], createdBy: -1 });
	userC = await insertScratchUser({ projectIds: [PROJECT_TWO], createdBy: -1 });
	userD = await insertScratchUser({ profileId, projectIds: [], createdBy: 0 });
	// userD is created BY userA — patch after A's id is known.
	await sql.unsafe(
		`UPDATE ${USERS_TABLE} SET data = jsonb_set(data, '{created_by_user_id}', to_jsonb($1::int))
		 WHERE section_tipo = $2 AND section_id = $3`,
		[userA, USERS_SECTION_TIPO, userD],
	);
	userE = await insertScratchUser({
		projectIds: [PROJECT_ONE],
		projectLocatorType: 'dd675',
		createdBy: -1,
	});

	adminUserId = await insertScratchUser({
		username: RUN_TAG,
		passwordHash: await Bun.password.hash(ADMIN_PASSWORD, { algorithm: 'argon2id' }),
		profileId,
		globalAdmin: true,
		createdBy: -1,
	});
	// The two dd131 states the old fixture could not express (SEC-07). Same password,
	// so the ONLY variable between them and adminUserId is the flag.
	inactiveUserId = await insertScratchUser({
		username: `${RUN_TAG}_inactive`,
		passwordHash: await Bun.password.hash(ADMIN_PASSWORD, { algorithm: 'argon2id' }),
		profileId,
		createdBy: -1,
		activeAccount: 'no',
	});
	noFlagUserId = await insertScratchUser({
		username: `${RUN_TAG}_noflag`,
		passwordHash: await Bun.password.hash(ADMIN_PASSWORD, { algorithm: 'argon2id' }),
		profileId,
		createdBy: -1,
		activeAccount: 'absent',
	});

	clearSecurityCaches();
	principalA = await resolvePrincipal(userA);
	principalD = await resolvePrincipal(userD);
	adminPrincipal = await resolvePrincipal(adminUserId);
	superuser = await resolvePrincipal(-1);
}, 60000);

afterAll(async () => {
	for (const id of [userA, userB, userC, userD, userE, adminUserId, inactiveUserId, noFlagUserId]) {
		await cleanupRecord(USERS_TABLE, USERS_SECTION_TIPO, id);
	}
	await cleanupRecord(PROFILES_TABLE, PROFILES_SECTION_TIPO, profileId);
	clearSecurityCaches();
});

// ---------------------------------------------------------------------------
// Finding 2 — the login global-admin stamp
// ---------------------------------------------------------------------------

describe('login stamps the REAL global-admin grant (audit §5.4)', () => {
	test('a non-superuser global admin gets a session flagged is_global_admin', async () => {
		resetSessionStoreForTests();
		// Precondition: the fixture really is a global admin by the dd244 grant.
		clearPrincipalCache(adminUserId);
		expect((await resolvePrincipal(adminUserId)).isGlobalAdmin).toBe(true);

		const result = await login(RUN_TAG, ADMIN_PASSWORD, '203.0.113.77');
		expect(result.ok).toBe(true);
		expect(result.userId).toBe(adminUserId);
		const session = getSession(result.sessionToken ?? '');
		expect(session).not.toBeNull();
		// THE GATE: the session flag must equal the resolved grant, not `id === -1`.
		expect(session?.isGlobalAdmin).toBe(true);
	}, 30000);

	test('an ordinary user still gets a session flagged NOT admin (no over-grant)', async () => {
		resetSessionStoreForTests();
		// userA carries no dd244 grant at all.
		expect((await resolvePrincipal(userA)).isGlobalAdmin).toBe(false);
		// Give the same account a password so the login path is comparable.
		const hash = await Bun.password.hash(ADMIN_PASSWORD, { algorithm: 'argon2id' });
		await sql.unsafe(
			`UPDATE ${USERS_TABLE} SET string = $1::text::jsonb WHERE section_tipo = $2 AND section_id = $3`,
			[
				JSON.stringify({
					dd132: [{ id: 1, lang: 'lg-nolan', value: `${RUN_TAG}_plain` }],
					dd133: [{ id: 1, lang: 'lg-nolan', value: hash }],
				}),
				USERS_SECTION_TIPO,
				userA,
			],
		);
		const result = await login(`${RUN_TAG}_plain`, ADMIN_PASSWORD, '203.0.113.78');
		expect(result.ok).toBe(true);
		const session = getSession(result.sessionToken ?? '');
		expect(session?.isGlobalAdmin).toBe(false);
	}, 30000);
});

// ---------------------------------------------------------------------------
// The dd131 fixture states — the vacuity this file used to carry (SEC-07)
// ---------------------------------------------------------------------------

describe("dd131 'Active account' is a real variable of this fixture, not a constant", () => {
	test('the fixture can actually express all three states', async () => {
		// This is the assertion whose ABSENCE was the defect: every scratch user was
		// stamped Active unconditionally, under a comment claiming login required it,
		// so login's total indifference to the flag was unobservable from here.
		const rows = (await sql.unsafe(
			`SELECT section_id, relation ? 'dd131' AS present, relation->'dd131'->0->>'section_id' AS target
			 FROM ${USERS_TABLE}
			 WHERE section_tipo = $1 AND section_id IN ($2, $3, $4)
			 ORDER BY section_id`,
			[USERS_SECTION_TIPO, adminUserId, inactiveUserId, noFlagUserId],
		)) as { section_id: number; present: boolean; target: string | null }[];
		const byId = new Map(rows.map((row) => [Number(row.section_id), row]));
		expect(byId.get(adminUserId)).toMatchObject({ present: true, target: '1' });
		expect(byId.get(inactiveUserId)).toMatchObject({ present: true, target: '2' });
		expect(byId.get(noFlagUserId)?.present).toBe(false);
	}, 30000);

	test('login REFUSES the deactivated account and ADMITS the active twin', async () => {
		resetSessionStoreForTests();
		expect((await login(RUN_TAG, ADMIN_PASSWORD, '203.0.113.79')).ok).toBe(true);
		const refused = await login(`${RUN_TAG}_inactive`, ADMIN_PASSWORD, '203.0.113.79');
		expect(refused.ok).toBe(false);
		expect(refused.sessionToken).toBeUndefined();
	}, 30000);

	test('login ADMITS the account with NO dd131 datum — measured, not inherited from PHP', async () => {
		// The frozen PHP treated a missing datum as inactive. Copying that would lock
		// out every user this engine creates (the shipped dd131 node has no
		// dato_default, and nothing in src/ writes dd131). Measured across two real
		// installs: 0 absent in 99 records — so the corpus cost is zero and the
		// create-path cost would be total. See auth.ts isRefusedForInactivity.
		resetSessionStoreForTests();
		expect((await login(`${RUN_TAG}_noflag`, ADMIN_PASSWORD, '203.0.113.80')).ok).toBe(true);
	}, 30000);
});

// ---------------------------------------------------------------------------
// Finding 3 — the dd128 per-record visibility rule
// ---------------------------------------------------------------------------

describe('Users section (dd128) LIST/SEARCH enumeration (audit §5.4 finding 3)', () => {
	test('a non-admin LIST of dd128 returns only reachable users', async () => {
		clearSecurityCaches();
		const visible = await listSectionIds(USERS_SECTION_TIPO, principalA);
		// AUTHORISED side: my own row (shares P1 with itself), the project-sharing
		// user, the user I created, and the one sharing P1 under another locator
		// `type`.
		expect(visible).toContain(userA);
		expect(visible).toContain(userB);
		expect(visible).toContain(userD);
		expect(visible).toContain(userE);
		// REFUSED side: another project's user, and the root record.
		expect(visible).not.toContain(userC);
		expect(visible).not.toContain(-1);
	}, 30000);

	test('the assembler filter cannot be bypassed by pinning the locator', async () => {
		// filter_by_locators is the client-supplied pin the list widget uses; it
		// must AND with the projects filter, never replace it.
		const sqo = sanitizeClientSqo({
			section_tipo: [USERS_SECTION_TIPO],
			filter_by_locators: [
				{ section_tipo: USERS_SECTION_TIPO, section_id: String(userC) },
				{ section_tipo: USERS_SECTION_TIPO, section_id: String(userB) },
			],
			limit: 10,
		});
		const query = await buildSearchSql(sqo, { principal: principalA });
		const rows = (await sql.unsafe(query.sql, query.params as (string | number | null)[])) as {
			section_id: number;
		}[];
		expect(rows.map((row) => Number(row.section_id))).toEqual([userB]);
	}, 30000);

	test('a global admin still enumerates every user (no over-tightening)', async () => {
		const adminVisible = await listSectionIds(USERS_SECTION_TIPO, adminPrincipal);
		expect(adminVisible).toContain(userC);
		expect(adminVisible).toContain(userB);
		// …but never the root record: that guard is admin-inclusive.
		expect(adminVisible).not.toContain(-1);
	}, 30000);

	test('a projects-less user sees ONLY themselves — no exception, no lockout', async () => {
		// PHP throws here ("Invalid filter master data", trait.where.php:812); the
		// port degrades to the own-record/created_by clauses. userD created nobody
		// and holds no project, so their own row is the whole answer.
		const visible = await listSectionIds(USERS_SECTION_TIPO, principalD);
		expect(visible).toEqual([userD]);
		// The own-record arm is in the FILTER, not only in the per-record helper:
		// every read door runs a principal-scoped search, so a projects-less user
		// whose account someone else created would otherwise be locked out of the
		// self-service profile editor.
		expect(await isRecordInScope(USERS_SECTION_TIPO, userD, principalD)).toBe(true);
		expect(await principalCanAccessRecord(USERS_SECTION_TIPO, userD, principalD)).toBe(true);
	}, 30000);

	test('the PROFILES and PROJECTS sections stay UNGATED for a non-admin', async () => {
		// PHP build_sql_projects_filter's first two switch arms: no filter at all.
		for (const sectionTipo of [PROFILES_SECTION, PROJECTS_SECTION_TIPO]) {
			const sqo = sanitizeClientSqo({ section_tipo: [sectionTipo], limit: 1 });
			const query = await buildSearchSql(sqo, { principal: principalA });
			expect(query.sql).not.toContain('IMPOSSIBLE VALUE');
			expect(query.sql).not.toContain('dd170');
		}
		// The scratch profile record is reachable by the non-admin who uses it.
		expect(await listSectionIds(PROFILES_SECTION, principalA)).toContain(profileId);
	}, 30000);
});

describe('Users section (dd128) per-record visibility (audit §5.4)', () => {
	test('AUTHORISED: own record, a project-sharing user, and a user I created', async () => {
		expect(await isRecordInScope(USERS_SECTION_TIPO, userA, principalA)).toBe(true);
		expect(await isRecordInScope(USERS_SECTION_TIPO, userB, principalA)).toBe(true);
		expect(await isRecordInScope(USERS_SECTION_TIPO, userD, principalA)).toBe(true);
		// The project match ignores the locator `type` (declared divergence).
		expect(await isRecordInScope(USERS_SECTION_TIPO, userE, principalA)).toBe(true);
	}, 30000);

	test('REFUSED: a user in neither my projects nor created by me', async () => {
		expect(await isRecordInScope(USERS_SECTION_TIPO, userC, principalA)).toBe(false);
	}, 30000);

	test('the per-record answer EQUALS the list answer, record by record', async () => {
		// The anti-drift gate: one rule, two doors. A future edit that changes
		// either side alone turns this red.
		const listed = new Set(await listSectionIds(USERS_SECTION_TIPO, principalA));
		for (const candidate of [userB, userC, userD, userE]) {
			expect(await isRecordInScope(USERS_SECTION_TIPO, candidate, principalA)).toBe(
				listed.has(candidate),
			);
		}
	}, 30000);

	test('principalCanAccessRecord inherits the rule — and admins stay unscoped', async () => {
		expect(await principalCanAccessRecord(USERS_SECTION_TIPO, userC, principalA)).toBe(false);
		expect(await principalCanAccessRecord(USERS_SECTION_TIPO, userB, principalA)).toBe(true);
		// The superuser is unscoped (PHP DEDALO_SUPERUSER bypass).
		expect(await principalCanAccessRecord(USERS_SECTION_TIPO, userC, superuser)).toBe(true);
		// The root user record stays unreachable for everyone (section_id < 1).
		expect(await principalCanAccessRecord(USERS_SECTION_TIPO, -1, principalA)).toBe(false);
	}, 30000);

	test('filterLocatorsInScope inherits the rule, keeping the root-label carve-out', async () => {
		const locators = [
			{ section_tipo: USERS_SECTION_TIPO, section_id: String(userB) },
			{ section_tipo: USERS_SECTION_TIPO, section_id: String(userC) },
			{ section_tipo: USERS_SECTION_TIPO, section_id: '-1' },
		];
		const kept = await filterLocatorsInScope(locators, principalA, USERS_SECTION_TIPO);
		expect(kept.map((locator) => locator.section_id)).toEqual([String(userB), '-1']);
		// A global admin keeps everything.
		expect(await filterLocatorsInScope(locators, superuser, USERS_SECTION_TIPO)).toHaveLength(3);
	}, 30000);
});

// ---------------------------------------------------------------------------
// Finding 4 — the menu section_tool list is the CALLER's
// ---------------------------------------------------------------------------

describe('menu section_tool entries resolve against the CALLER tools (audit §5.4)', () => {
	test('the section_tool area is dropped for a viewer whose profile grants no tools', async () => {
		clearSecurityCaches();
		const viewer = await getMenuTreeDatalist({
			userId: userA,
			isGlobalAdmin: false,
			isDeveloper: false,
		});
		// The area IS authorized for this viewer (dd774 self-key), so the ONLY
		// reason it may be absent is the per-caller tool filter.
		expect(await getGrantedTipos(userA)).toContain(SECTION_TOOL_AREA);
		expect(viewer.skipped.some((entry) => entry.tipo === SECTION_TOOL_AREA)).toBe(true);
	}, 30000);

	test('a NON-SUPERUSER global admin is filtered like anyone else', async () => {
		// PHP tool_common::get_user_tools' unfiltered branch is
		// `$user_id == DEDALO_SUPERUSER` ALONE (tool_common.php:1403) — a
		// global-admin FLAG grants no tool. This pins the menu door against
		// re-introducing the flag bypass (registry.ts getUserTools still has it:
		// see the handoff), so the two can never disagree silently.
		clearSecurityCaches();
		expect(adminPrincipal.isGlobalAdmin).toBe(true);
		const viewer = await getMenuTreeDatalist({
			userId: adminUserId,
			isGlobalAdmin: true,
			isDeveloper: false,
		});
		// The area is authorized for this viewer (dd774 self-key) …
		expect(await getGrantedTipos(adminUserId)).toContain(SECTION_TOOL_AREA);
		// … so the ONLY reason it can be missing is the per-caller tool filter.
		expect(viewer.skipped.some((entry) => entry.tipo === SECTION_TOOL_AREA)).toBe(true);
	}, 30000);

	test('the same area SURVIVES for the superuser (no over-tightening)', async () => {
		const root = await getMenuTreeDatalist({ userId: -1, isGlobalAdmin: true, isDeveloper: true });
		expect(root.skipped.some((entry) => entry.tipo === SECTION_TOOL_AREA)).toBe(false);
		// And the tool it names is really the non-always-active one.
		const { getSuperuserUserTools } = await import('../../src/core/tools/registry.ts');
		expect((await getSuperuserUserTools()).some((tool) => tool.name === SECTION_TOOL_NAME)).toBe(
			true,
		);
	}, 30000);
});

// ---------------------------------------------------------------------------
// Finding 5 — the ACL datalist is filtered for non-global-admins
// ---------------------------------------------------------------------------

describe('component_security_access datalist filtering (audit §7)', () => {
	test('a non-global-admin receives ONLY areas present in their own dd774 data', async () => {
		clearSecurityCaches();
		const granted = await getGrantedTipos(userA);
		const filtered = await getSecurityAccessDatalist(principalA);
		expect(filtered.length).toBeGreaterThan(0);
		// Every AREA-level row (an item that is its own section_tipo) must be granted.
		for (const item of filtered) {
			if (item.tipo === item.section_tipo) {
				expect(granted.has(item.tipo)).toBe(true);
			}
		}
	}, 60000);

	test('a global admin still receives the unfiltered tree (no over-tightening)', async () => {
		const unfiltered = await getSecurityAccessDatalist(superuser);
		const filtered = await getSecurityAccessDatalist(principalA);
		expect(unfiltered.length).toBeGreaterThan(filtered.length);
		// A section the scratch profile does NOT grant is present for the admin and
		// absent for the non-admin.
		const adminTipos = new Set(unfiltered.map((item) => item.tipo));
		const filteredTipos = new Set(filtered.map((item) => item.tipo));
		const ungranted = [...adminTipos].find(
			(tipo) => !filteredTipos.has(tipo) && tipo !== SECTION_TOOL_AREA,
		);
		expect(ungranted).toBeDefined();
	}, 60000);
});
