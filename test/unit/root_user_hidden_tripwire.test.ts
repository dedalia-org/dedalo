/**
 * TRIPWIRE — the root user record (Users dd128, section_id -1) is hidden from
 * every list/search door, while the direct-fetch label paths keep resolving it.
 *
 * PHP hides root from lists for safety but still resolves its name from stored
 * locators (activity "who", created_by/modified_by, time machine). Two
 * mechanical layers enforce the TS mirror, keyed on config.usersSectionTipo:
 *
 *   1. buildSearchSql ANDs `section_id > 0` into the main WHERE whenever the
 *      MAIN section is Users (PHP search::build_main_where,
 *      core/search/trait.where.php:100-103) — closing list rows, full_count,
 *      autocomplete typeahead, client filter_by_locators pins and
 *      isRecordInScope in one clause, for EVERY caller incl. admins.
 *   2. principalCanAccessRecord refuses any non-positive section_id BEFORE the
 *      global-admin bypass, for ALL sections (PHP security::
 *      user_can_access_record, class.security.php:1007-1009) — closing
 *      get_data, the MCP write tools and the AI change-plan.
 *   3. THE THREE WRITE DOORS (added 2026-08-28, SEC-05). Layers 1 and 2 are
 *      properties of two FUNCTIONS, and this file used to assert only those — while
 *      `dd_core_api`'s save, duplicate and delete doors each wrote the check as
 *      `if (!principal.isGlobalAdmin) { isRecordInScope(...) }`, which inlines the
 *      admin bypass ABOVE the non-positive-id refusal. For an admin-flagged
 *      principal the refusal therefore never executed, and root's password was
 *      rewritable by any global admin holding a level-2 grant on (dd128, dd133) —
 *      a precondition met at BOTH real installations measured for that finding.
 *      The doors now call `assertRecordWriteTarget`, so the order cannot be
 *      re-inlined, and this file asserts the DOORS, which is what its own header
 *      always claimed.
 *   4. THE ONE EXCEPTION (2026-08-28). Layer 3's first shape had none, and the side
 *      effect nobody chose was that ROOT could no longer change its OWN password or
 *      its OWN email either — while `password_reset.ts` excludes root from the emailed
 *      recovery flow by the same `id > 0` rule. An installation with no in-engine way
 *      to rotate its most privileged credential is not a hardening. So an account may
 *      write its OWN four SELF_EDITABLE components (dd452 name, dd134 email, dd133
 *      password, dd522 image) on its OWN record, root included
 *      (`permissions.isSelfServiceAccountWrite` → `assertRecordWriteTarget`'s
 *      `selfServiceAccountWrite`). Nothing else moves: the LEVEL rule is unchanged
 *      (dd244 stays 1 for everyone, root included), duplicate and delete of root are
 *      still refused for every caller, and no OTHER principal gains anything on -1.
 *      Recorded as engineering/wire_contract/WC-2026-08-28-root-self-service-write.md.
 *
 * The EXEMPTIONS are as load-bearing as the filters: readMatrixRecord,
 * resolveLocatorLabels, getDatalist (PHP edit-mode include_negative datalists)
 * and the resolve_data injected-chip path must still reach -1, or the client
 * silently loses the "who = root" labels. Both directions are pinned here.
 */
// Migrated to the generic `test` TLD 2026-08-20 (AGENTS.md hard rule). Install tipos
// were replaced by their twins from src/core/test_data/test_tld_tipo_map.json; the
// seed-shipped ones (rsc/dd/hierarchy/ontology/lg) have no twin and stay, because they
// ship with every installation.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import '../../src/core/components/registry.ts';
import { config } from '../../src/config/config.ts';
import { coreApiActions } from '../../src/core/api/handlers/dd_core_api.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { sanitizeClientSqo } from '../../src/core/concepts/sqo.ts';
import { readMatrixRecord } from '../../src/core/db/matrix.ts';
import {
	deleteMatrixRecord,
	insertMatrixRecordWithCounter,
} from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { getDatalist, resolveLocatorLabels } from '../../src/core/relations/datalist.ts';
import { buildSearchSql } from '../../src/core/search/sql_assembler.ts';
import { resolveSearchData } from '../../src/core/section/read.ts';
import { hashPasswordForStorage } from '../../src/core/security/password_hash.ts';
import {
	clearPermissionsCache,
	clearPrincipalCache,
	clearUserProjectsCache,
	getPermissions,
	isSelfServiceAccountWrite,
	type Principal,
	resolvePrincipal,
} from '../../src/core/security/permissions.ts';
import {
	assertRecordWriteTarget,
	isRecordInScope,
	principalCanAccessRecord,
} from '../../src/core/security/record_scope.ts';

const USERS = 'dd128';
/**
 * The root locator as it arrives from the WIRE and as it sits in LEGACY stored
 * bags — string form on purpose (WC-2026-08-10-section-id-int-canonical: int is
 * canonical, but the boundary doors still coerce the string form and stored
 * pre-sweep locators are string). The EMITTED forms below are int.
 */
const ROOT_LOCATOR = { section_tipo: USERS, section_id: '-1' };

const SUPERUSER: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };
/** Synthetic non-admin with NO projects — the strictest scoped caller. */
const NO_PROJECTS: Principal = { userId: 987654321, isGlobalAdmin: false, isDeveloper: false };

/** Explicit-config properties targeting Users, dd132 (Username) as label ddo. */
const USERS_LABEL_PROPERTIES = {
	source: {
		request_config: [
			{
				api_engine: 'dedalo',
				sqo: { section_tipo: [USERS] },
				show: {
					ddo_map: [
						{
							tipo: 'dd132',
							model: 'component_input_text',
							section_tipo: USERS,
							parent: USERS,
						},
					],
				},
			},
		],
	},
};

/** Same target, NO label ddos — enumeration-only datalist (fast). */
const USERS_ENUM_PROPERTIES = {
	source: {
		request_config: [
			{
				api_engine: 'dedalo',
				sqo: { section_tipo: [USERS] },
				show: { ddo_map: [] },
			},
		],
	},
};

describe('root user record is hidden from every search door', () => {
	test('the filter keys on config.usersSectionTipo = dd128', () => {
		expect(config.usersSectionTipo).toBe(USERS);
	});

	test('buildSearchSql ANDs section_id > 0 into a Users list query', async () => {
		const { sql } = await buildSearchSql({ section_tipo: [USERS], limit: 10 });
		expect(sql).toContain('section_id > 0');
	});

	// The unfiltered browse total is served from the browse-count cache as a
	// literal (PERF-10), so the exclusion is no longer VISIBLE in the returned
	// SQL — it is in the query that produced the number. Asserted on the NUMBER
	// instead, which is the thing that must never include root: the counted
	// total equals the count of users ABOVE zero, and is strictly below the
	// count that includes the root row.
	test('the full_count NUMBER excludes root (root never counted)', async () => {
		const { sql: builtSql, params } = await buildSearchSql({
			section_tipo: [USERS],
			full_count: true,
		});
		const rows = (await sql.unsafe(builtSql, params as (string | number | null)[])) as {
			full_count: number | string;
		}[];
		const counted = rows.reduce((sum, row) => sum + Number(row.full_count), 0);
		const truth = (await sql.unsafe(
			`SELECT count(*) FILTER (WHERE section_id > 0)::int AS visible, count(*)::int AS all_rows
			 FROM matrix_users WHERE section_tipo = $1`,
			[USERS],
		)) as { visible: number; all_rows: number }[];
		expect(counted).toBe(Number(truth[0]?.visible));
		// and the root row really is there, so this is a discrimination
		expect(Number(truth[0]?.all_rows)).toBeGreaterThan(Number(truth[0]?.visible));
	});

	test('a sanitized client SQO pinning (dd128,-1) via filter_by_locators is ANDed empty', async () => {
		const sqo = sanitizeClientSqo({
			section_tipo: [USERS],
			filter_by_locators: [ROOT_LOCATOR],
			limit: 1,
		});
		const built = await buildSearchSql(sqo);
		// The pin survives sanitize (it is a legitimate client key) but the
		// mandatory clause ANDs with it: section_id = -1 AND section_id > 0.
		expect(built.params).toContain(-1);
		expect(built.sql).toContain('section_id > 0');
	});

	test('control: a non-Users section gets NO section_id > 0 clause', async () => {
		const { sql } = await buildSearchSql({ section_tipo: ['test2'], limit: 10 });
		expect(sql).not.toContain('section_id > 0');
	});

	test('principalCanAccessRecord refuses non-positive ids BEFORE the admin bypass, all sections', async () => {
		expect(await principalCanAccessRecord(USERS, -1, SUPERUSER)).toBe(false);
		expect(await principalCanAccessRecord(USERS, 0, SUPERUSER)).toBe(false);
		expect(await principalCanAccessRecord('test2', -1, SUPERUSER)).toBe(false);
		// The bypass itself stays intact for positive ids.
		expect(await principalCanAccessRecord(USERS, 5, SUPERUSER)).toBe(true);
	});

	test('isRecordInScope(dd128,-1) is false even though the row physically exists', async () => {
		// The contrast is the proof: the direct fetch below sees the record, so
		// the scoped-search false comes from the assembler filter, not absence.
		expect(await isRecordInScope(USERS, -1, NO_PROJECTS)).toBe(false);
	});
});

describe('root user record stays resolvable by the direct-fetch paths (requires shared DB)', () => {
	test('readMatrixRecord reaches (dd128,-1) — the exemption every label path builds on', async () => {
		const record = await readMatrixRecord('matrix_users', USERS, -1);
		expect(record).not.toBeNull();
	});

	test('resolveLocatorLabels resolves the -1 locator to the seeded username', async () => {
		const labels = await resolveLocatorLabels(
			'zzroottrip1',
			USERS_LABEL_PROPERTIES,
			USERS,
			'lg-nolan',
			[ROOT_LOCATOR],
		);
		expect(labels).toContain('root');
	});

	test('getDatalist still enumerates -1 (PHP edit-mode include_negative parity)', async () => {
		const items = await getDatalist('zzroottrip2', USERS_ENUM_PROPERTIES, USERS, 'lg-nolan');
		// WC-2026-08-10-section-id-int-canonical: datalist options carry the
		// option record's address as an INT (this emission is the byte funnel
		// the select family posts back and saves).
		expect(items.some((item) => item.section_id === -1)).toBe(true);
	});

	test('resolve_data keeps the root chip for a NON-admin while still dropping out-of-scope records', async () => {
		// Without the read.ts exemption, the AUTHZ-02 loop would now drop the
		// root chip (isRecordInScope is false post-filter) and "who = root"
		// would silently vanish for non-admins. The gated test6310 record
		// doubles as the control: AUTHZ-02 still drops what it always dropped.
		const rqo = {
			source: {
				action: 'resolve_data',
				tipo: 'dd578', // 'Who' — component_autocomplete → dd128
				section_tipo: 'dd15',
				lang: 'lg-nolan',
				value: [ROOT_LOCATOR, { section_tipo: 'test6310', section_id: '1' }],
			},
		} as unknown as Rqo;
		const data = await resolveSearchData(rqo, NO_PROJECTS);
		const emitted = JSON.stringify(data);
		// WC-2026-08-10-section-id-int-canonical: the echo canonicalizes the
		// record address to int, so the chip is "section_id":-1 (was '"-1"').
		expect(emitted).toContain('"section_id":-1');
		expect(emitted).not.toContain('test6310');
	});
});

// ---------------------------------------------------------------------------
// LAYER 3 — THE THREE WRITE DOORS (SEC-05)
// ---------------------------------------------------------------------------

/**
 * The audit's precondition, built rather than assumed: a REAL global admin (dd244 →
 * dd64/1, resolved through resolvePrincipal like any other) whose profile grants level 2
 * on the exact pairs the finding names — (dd128, dd133) for the password rewrite and
 * (dd128, dd128) for the section-level duplicate/delete gates. That grant shape is not
 * hypothetical: it is what BOTH real installations measured for this finding actually
 * ship on their operator-built "Administrador" profile.
 *
 * The superuser (-1) is asserted alongside, because it is the strictly stronger caller:
 * `getPermissions` short-circuits it to level 3 on everything, so if the doors refuse
 * IT they refuse every caller.
 */
const ROOT_RUN_TAG = `roottrip_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
const PROFILES_TABLE = 'matrix_profiles';
const PROFILES_SECTION = 'dd234';
const USERS_TABLE = 'matrix_users';

let grantedAdminId = 0;
let grantedProfileId = 0;
let grantedAdmin: Principal;
let realSuperuser: Principal;

/** dd64 yes/no radio locator (entry 1 = Yes). */
function yesLocator(componentTipo: string) {
	return {
		id: 1,
		type: 'dd151',
		section_id: '1',
		section_tipo: 'dd64',
		from_component_tipo: componentTipo,
	};
}

/** Call one dd_core_api action as `principal` and return whatever it did. */
async function callDoor(
	action: 'save' | 'duplicate' | 'delete',
	source: Record<string, unknown>,
	principal: Principal,
	data?: Record<string, unknown>,
): Promise<{ threw: true; message: string } | { threw: false; status: number }> {
	const handler = coreApiActions[action];
	if (!handler) throw new Error(`dd_core_api has no '${action}' action registered`);
	try {
		const response = await handler(
			{ source, data } as unknown as Parameters<typeof handler>[0],
			{
				principal,
				session: { userId: principal.userId },
				clientIp: '127.0.0.1',
				requestId: ROOT_RUN_TAG,
			} as unknown as Parameters<typeof handler>[1],
		);
		return { threw: false, status: response.status };
	} catch (error) {
		return { threw: true, message: String((error as Error).message ?? error) };
	}
}

/** root's stored password hash — read, never rotated, by this gate. */
async function rootPasswordHash(): Promise<string> {
	const rows = (await sql.unsafe(
		`SELECT string->'dd133'->0->>'value' AS hash FROM matrix_users
		 WHERE section_tipo = $1 AND section_id = -1`,
		[USERS],
	)) as { hash: string | null }[];
	return rows[0]?.hash ?? '';
}

/**
 * The highest matrix_time_machine id before this file ran. The root self-service save
 * below is a REAL write through the real door, so it appends a TM row on dd128/-1 —
 * and root's genuine history may not be swept along with it. The watermark bounds the
 * afterAll delete to rows THIS run created.
 */
let tmWatermark = 0;

/**
 * ROOT'S CREDENTIAL IS BUILT, NOT BORROWED.
 *
 * Two gates below read root's stored hash — one to prove the refusals wrote
 * nothing, one to drive the self-service rotation door end to end. Both used to
 * assert `$argon2…` against WHATEVER THE DATABASE HAPPENED TO HOLD, and the
 * install seed ships root PASSWORDLESS (`string->'dd133'` is `[]` on a freshly
 * built suite database). They passed only on a developer box where
 * `bun run test:client` had already set the suite credential
 * (src/core/test_data/suite_login.ts) — so on the hosted DB tier, which builds
 * its database from the vendored seed on every run, they were red from the
 * tier's first execution. A gate that reads ambient state is not a gate.
 *
 * So the situation is MADE here when it is absent, through the engine's own
 * hasher rather than a pasted literal, and the original value is put back in
 * afterAll: a gate may not leave the suite database's root credential changed.
 *
 * The flag is separate from the value ON PURPOSE. A restore keyed on
 * `value !== null` would silently skip the case where dd133 was ABSENT rather
 * than empty — the one shape whose original value IS null — and leave the
 * planted credential behind on exactly the database that never had one.
 */
let plantedRootPassword = false;
let originalRootPassword: unknown = null;

beforeAll(async () => {
	{
		const rows = (await sql.unsafe(
			'SELECT COALESCE(max(id), 0) AS max_id FROM matrix_time_machine',
		)) as { max_id: number }[];
		tmWatermark = Number(rows[0]?.max_id ?? 0);
	}
	if (!(await rootPasswordHash()).startsWith('$argon2')) {
		const rows = (await sql.unsafe(
			`SELECT string->'dd133' AS dd133 FROM matrix_users
			 WHERE section_tipo = $1 AND section_id = -1`,
			[USERS],
		)) as { dd133: unknown }[];
		originalRootPassword = rows[0]?.dd133 ?? null;
		plantedRootPassword = true;
		const hash = await hashPasswordForStorage(`root-${ROOT_RUN_TAG}`);
		await sql.unsafe(
			`UPDATE matrix_users
			    SET string = jsonb_set(COALESCE(string, '{}'::jsonb), '{dd133}', $2::text::jsonb, true)
			  WHERE section_tipo = $1 AND section_id = -1`,
			[USERS, JSON.stringify([{ id: 1, lang: 'lg-nolan', value: hash }])],
		);
	}
	grantedProfileId = await insertMatrixRecordWithCounter(PROFILES_TABLE, PROFILES_SECTION, {
		misc: {
			dd774: [
				{ id: 1, tipo: 'dd133', section_tipo: USERS, value: 2 },
				{ id: 2, tipo: USERS, section_tipo: USERS, value: 2 },
			],
		},
		relation: { dd1067: [] },
		data: { label: ROOT_RUN_TAG, section_tipo: PROFILES_SECTION },
	});
	grantedAdminId = await insertMatrixRecordWithCounter(USERS_TABLE, USERS, {
		relation: {
			dd244: [yesLocator('dd244')],
			dd131: [yesLocator('dd131')],
			dd1725: [
				{
					id: 1,
					type: 'dd151',
					section_id: String(grantedProfileId),
					section_tipo: PROFILES_SECTION,
					from_component_tipo: 'dd1725',
				},
			],
		},
		string: { dd132: [{ id: 1, lang: 'lg-nolan', value: ROOT_RUN_TAG }] },
		data: { label: ROOT_RUN_TAG, section_tipo: USERS, created_by_user_id: -1 },
	});
	clearPermissionsCache();
	clearPrincipalCache();
	clearUserProjectsCache();
	grantedAdmin = await resolvePrincipal(grantedAdminId);
	realSuperuser = await resolvePrincipal(-1);
}, 60000);

afterAll(async () => {
	for (const [table, section, id] of [
		[USERS_TABLE, USERS, grantedAdminId],
		[PROFILES_TABLE, PROFILES_SECTION, grantedProfileId],
	] as const) {
		if (id > 0) {
			await deleteMatrixRecord(table, section, id);
			await sql.unsafe(
				'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
				[section, id],
			);
		}
	}
	// Put root's credential back exactly as it was found (see plantedRootPassword).
	if (plantedRootPassword) {
		if (originalRootPassword === null) {
			// dd133 was not there at all: remove the key rather than write a null.
			await sql.unsafe(
				`UPDATE matrix_users SET string = string - 'dd133'
				  WHERE section_tipo = $1 AND section_id = -1`,
				[USERS],
			);
		} else {
			await sql.unsafe(
				`UPDATE matrix_users
				    SET string = jsonb_set(COALESCE(string, '{}'::jsonb), '{dd133}', $2::text::jsonb, true)
				  WHERE section_tipo = $1 AND section_id = -1`,
				[USERS, JSON.stringify(originalRootPassword)],
			);
		}
		plantedRootPassword = false;
	}
	// The root self-service save appends a TM row on dd128/-1; sweep only the rows
	// this run created (see tmWatermark), never root's real history.
	await sql.unsafe(
		'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = -1 AND id > $2',
		[USERS, tmWatermark],
	);
	clearPermissionsCache();
	clearPrincipalCache();
	clearUserProjectsCache();
});

describe('the write DOORS refuse section_id < 1 for EVERY caller, admins included', () => {
	test('the fixture really is the audit precondition (a global admin with the grant)', async () => {
		// Without this the three refusals below could be passing for the wrong reason —
		// a caller who was never authorized in the first place.
		expect(grantedAdmin.isGlobalAdmin).toBe(true);
		expect(grantedAdmin.userId).not.toBe(-1);
		expect(await getPermissions(grantedAdmin, USERS, 'dd133')).toBe(2);
		expect(await getPermissions(grantedAdmin, USERS, USERS)).toBe(2);
	});

	test("SAVE of root's password is refused for a global admin holding (dd128,dd133) = 2", async () => {
		// The finding itself. This caller is NOT root, so the self-service exception
		// (layer 4) cannot apply to them however the request is shaped.
		const outcome = await callDoor(
			'save',
			{ tipo: 'dd133', section_tipo: USERS, section_id: -1, lang: 'lg-nolan' },
			grantedAdmin,
			{ changed_data: [{ action: 'set_data', value: [{ id: 1, value: 'root_takeover_42' }] }] },
		);
		expect(outcome.threw).toBe(true);
		// The refusal must be the WRITE-TARGET one, not an accidental level denial.
		if (outcome.threw) expect(outcome.message).toContain('-1');
	});

	test("SAVE of root's SECURITY-ADMIN flag is refused even for root itself", async () => {
		// The exception is bound to the four SELF_EDITABLE components. dd244 is not one
		// of them, and the LEVEL rule forces it to 1 for every caller including root
		// (PHP: unconditional) — so this must refuse whichever gate fires first.
		const outcome = await callDoor(
			'save',
			{ tipo: 'dd244', section_tipo: USERS, section_id: -1, lang: 'lg-nolan' },
			realSuperuser,
			{ changed_data: [{ action: 'set_data', value: [] }] },
		);
		expect(outcome.threw).toBe(true);
	});

	test("SAVE of root's USERNAME is refused even for root itself", async () => {
		// dd132 is SELF_ELEVATION_GUARDED, not SELF_EDITABLE: renaming the recovery
		// identity is not a self-service edit.
		const outcome = await callDoor(
			'save',
			{ tipo: 'dd132', section_tipo: USERS, section_id: -1, lang: 'lg-nolan' },
			realSuperuser,
			{ changed_data: [{ action: 'set_data', value: [{ id: 1, value: 'not_root' }] }] },
		);
		expect(outcome.threw).toBe(true);
	});

	for (const [label, who] of [
		['a global admin holding (dd128,dd133) = 2', (): Principal => grantedAdmin],
		['the superuser (-1), the strictly stronger caller', (): Principal => realSuperuser],
	] as const) {
		test(`DUPLICATE of the root record is refused for ${label}`, async () => {
			// The second consequence of SEC-05: duplicating dd128/-1 copies the whole
			// `string` column, minting a positive-id user record carrying ROOT's Argon2
			// hash and root's username — and duplicate bypasses saveComponentData, so
			// dd132's `unique` server check never runs.
			const outcome = await callDoor('duplicate', { section_tipo: USERS, section_id: -1 }, who());
			expect(outcome.threw).toBe(true);
		});

		test(`DELETE of the root record is refused for ${label}`, async () => {
			const outcome = await callDoor(
				'delete',
				{ section_tipo: USERS, section_id: -1, delete_mode: 'delete_record' },
				who(),
			);
			expect(outcome.threw).toBe(true);
		});
	}

	test('root is still on disk after all of that (nothing was written or removed)', async () => {
		// The refusals must be refusals, not silent successes with a 200 body.
		const record = await readMatrixRecord('matrix_users', USERS, -1);
		expect(record).not.toBeNull();
		const rows = (await sql.unsafe(
			`SELECT string->'dd133'->0->>'value' AS hash FROM matrix_users
			 WHERE section_tipo = $1 AND section_id = -1`,
			[USERS],
		)) as { hash: string | null }[];
		expect(rows[0]?.hash ?? '').toStartWith('$argon2');
	});

	test('id 0 and any other non-positive address are refused too, not just -1', async () => {
		for (const id of [0, -1, -7]) {
			await expect(assertRecordWriteTarget(USERS, id, realSuperuser, 'gate')).rejects.toThrow();
		}
	});

	test('the self-service exception is bound to the ACTOR, not to the flag', async () => {
		// A caller that passes selfServiceAccountWrite for a record that is NOT its own
		// gets the ordinary refusal — the flag is re-checked against principal.userId
		// inside the gate, so a mis-wired door cannot open root's record to anyone.
		await expect(
			assertRecordWriteTarget(USERS, -1, grantedAdmin, 'gate', { selfServiceAccountWrite: true }),
		).rejects.toThrow();
		// …and root's OWN record, with the flag, is admitted.
		await expect(
			assertRecordWriteTarget(USERS, -1, realSuperuser, 'gate', { selfServiceAccountWrite: true }),
		).resolves.toBeUndefined();
	});

	test('isSelfServiceAccountWrite is true for exactly the four self-editable components', () => {
		for (const tipo of ['dd452', 'dd134', 'dd133', 'dd522']) {
			expect(isSelfServiceAccountWrite(realSuperuser, USERS, tipo, -1), tipo).toBe(true);
		}
		for (const tipo of ['dd244', 'dd132', 'dd1725', 'dd515', 'dd330', 'dd131']) {
			expect(isSelfServiceAccountWrite(realSuperuser, USERS, tipo, -1), tipo).toBe(false);
		}
		// Someone else's record, another section, and the "not logged in" sentinel.
		expect(isSelfServiceAccountWrite(realSuperuser, USERS, 'dd133', grantedAdminId)).toBe(false);
		expect(isSelfServiceAccountWrite(grantedAdmin, USERS, 'dd133', -1)).toBe(false);
		expect(isSelfServiceAccountWrite(realSuperuser, 'dd234', 'dd133', -1)).toBe(false);
		expect(
			isSelfServiceAccountWrite(
				{ userId: 0, isGlobalAdmin: false, isDeveloper: false },
				USERS,
				'dd133',
				0,
			),
		).toBe(false);
	});

	test('ROOT CAN ROTATE ITS OWN PASSWORD through the real save door', async () => {
		// The whole point of layer 4, driven end to end. The value written is root's
		// CURRENT stored hash: `hashPasswordForStorage` passes an existing `$argon2…`
		// string through verbatim (the export/import round-trip rule), so this proves
		// the DOOR admits the write while leaving the credential byte-identical — a
		// gate may not rotate the suite database's root password as a side effect.
		const before = await rootPasswordHash();
		expect(before).toStartWith('$argon2');

		const outcome = await callDoor(
			'save',
			{ tipo: 'dd133', section_tipo: USERS, section_id: -1, lang: 'lg-nolan' },
			realSuperuser,
			{ changed_data: [{ action: 'set_data', value: [{ id: 1, value: before }] }] },
		);

		expect(outcome).toEqual({ threw: false, status: 200 });
		expect(await rootPasswordHash()).toBe(before);
	});

	test('ROOT READS ITS OWN ACCOUNT through get_data (tool_user_admin); a non-root admin still gets nothing', async () => {
		// WC-2026-10-28-own-account-read: the write exception above is useless without the
		// read — tool_user_admin is the UI for it and builds each component by get_data.
		const read = async (principal: Principal, tipo: string) => {
			const handler = coreApiActions.read;
			if (!handler) throw new Error("dd_core_api has no 'read' action registered");
			const response = await handler(
				{
					action: 'read',
					source: {
						action: 'get_data',
						model: 'component_input_text',
						tipo,
						section_tipo: USERS,
						section_id: -1,
						mode: 'edit',
						lang: 'lg-nolan',
					},
				} as unknown as Parameters<typeof handler>[0],
				{
					principal,
					session: { userId: principal.userId },
					clientIp: '127.0.0.1',
					requestId: ROOT_RUN_TAG,
				} as unknown as Parameters<typeof handler>[1],
			);
			return response.body as { data?: { context?: unknown[]; data?: unknown[] } };
		};
		const own = await read(realSuperuser, 'dd132');
		expect(own.data?.context?.length).toBeGreaterThan(0);
		expect(JSON.stringify(own.data?.data)).toContain('"value"');
		// dd133: the one dd128 component this admin holds at 2, so the RECORD gate is what refuses
		const other = await read(grantedAdmin, 'dd133');
		expect(other.data?.context ?? []).toHaveLength(0);
		expect(other.data?.data ?? []).toHaveLength(0);
	});

	test('CONTROL: the same doors still admit a positive, in-scope record', async () => {
		// The anti-over-tightening half. Without it this whole describe could be green
		// because the doors refuse everything.
		const outcome = await callDoor(
			'save',
			{ tipo: 'dd132', section_tipo: USERS, section_id: grantedAdminId, lang: 'lg-nolan' },
			realSuperuser,
			{
				changed_data: [
					{ action: 'set_data', value: [{ id: 1, lang: 'lg-nolan', value: ROOT_RUN_TAG }] },
				],
			},
		);
		expect(outcome).toEqual({ threw: false, status: 200 });
	});
});
