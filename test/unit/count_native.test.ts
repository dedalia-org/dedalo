/**
 * `dd_core_api.count` — the paginator TOTAL (plan item 4.2.6, comp 16, CRAP 263).
 *
 * WHY THIS FILE EXISTS. `count` answers with a NUMBER, and a number is the
 * cheapest disclosure channel in the engine: it is emitted for searches whose
 * ROWS the caller may never see. The function's dangerous branch is AUTHZ-05 —
 * the inverse-reference ('related') paginator. Since D1 (2026-10-21) it is ONE
 * scoped COUNT for every principal: the related search's own owner question,
 * narrowed in SQL by the caller's record scope (`rowScopeFor`; a global admin is
 * unscoped inside it). Dropping the scope is the obvious "simplification", it
 * changes no row the client renders, and it turns the total into a
 * RECORD-COUNT ORACLE over hidden data. (count == paged walk == probe, and the
 * count's bounded cost: related_scope_equivalence_native.)
 *
 * The gate therefore asserts the two totals DIFFER, on records this file mints
 * itself: one referrer inside the non-admin's project, one outside it.
 *
 * ANTI-VACUITY. Every permission arm is a PAIR — the privileged identity gets
 * the thing, the unprivileged does not — driven by `test/helpers/
 * acl_identity_fixture.ts`, because the suite DB's ambient identities are
 * denied-everywhere and make each of these assertions satisfiable at zero
 * versus zero. `acl_identity_fixture_native.test.ts` is the gate that keeps the
 * contrast non-degenerate; this file re-asserts it locally (`the contrast is
 * live`) so a degraded fixture cannot silently make the AUTHZ-05 case green.
 *
 * NEVER a table-global count: `test3` is a shared playground section and other
 * gates mint into it concurrently. Every total asserted here is scoped by
 * `filter_by_locators` to a record this file created.
 *
 * Scratch band 937000-937999 in section `test3` (table matrix_test), plus the
 * matrix_time_machine rows minted for the host record. Swept in afterAll, which
 * THROWS on a 0-row delete.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { deleteMatrixRecord } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { getPermissions, resolvePrincipal } from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import {
	ACL_ADMIN_USER_ID,
	ACL_NON_ADMIN_USER_ID,
	ACL_PROJECT_ID,
	installAclIdentityFixture,
	removeAclIdentityFixture,
} from '../helpers/acl_identity_fixture.ts';
import { DB_READY } from '../helpers/db_ready.ts';

/** The playground section the ACL fixture grants (matrix_test, project-gated by test101). */
const SECTION = 'test3';
const TABLE = 'matrix_test';
/** The maintenance area: granted at 2 to the fixture admin, refused to the non-admin. */
const UNREADABLE_FOR_NON_ADMIN = 'dd88';
/** dd15 — the Time Machine virtual section (admin-only, served by tmReadSource). */
const TIME_MACHINE = 'dd15';

/** The record every referrer points AT — the relation-list host. */
const HOST_ID = 937001;
/** Referrer INSIDE the non-admin's project (visible to both identities). */
const REFERRER_IN_SCOPE = 937002;
/** Referrer in a project the non-admin does not hold (admin-only). */
const REFERRER_OUT_OF_SCOPE = 937003;
/** A project id nobody in this suite is assigned to — the "hidden" side. */
const FOREIGN_PROJECT_ID = 937500;
/** How many matrix_time_machine rows this file mints for the host record. */
const HOST_TM_ROWS = 2;

const OWNED_IDS = [HOST_ID, REFERRER_IN_SCOPE, REFERRER_OUT_OF_SCOPE];

/** test3's portal component — carries the locator that points at the host. */
const RELATION_COMPONENT = 'test201';
/** test3's component_filter_master — the per-record projects gate. */
const PROJECTS_COMPONENT = 'test101';

function contextFor(userId: number, isGlobalAdmin: boolean, principal: unknown) {
	const token = createSession(userId, `zzcnt_${userId}`, isGlobalAdmin);
	const session = getSession(token);
	return {
		requestId: 'zzcnt',
		clientIp: '127.0.0.1',
		session,
		csrfCandidate: session?.csrfToken ?? null,
		principal,
	};
}

/** Insert one scratch record at an EXPLICIT id — no counter, no residue. */
async function insertScratchRecord(sectionId: number, columns: Record<string, unknown>) {
	const names = ['"section_tipo"', '"section_id"'];
	const placeholders = ['$1', '$2'];
	const params: (string | number)[] = [SECTION, sectionId];
	let index = 3;
	for (const [column, value] of Object.entries(columns)) {
		names.push(`"${column}"`);
		placeholders.push(`$${index}::text::jsonb`);
		params.push(encodeForJsonb(value));
		index++;
	}
	await sql.unsafe(
		`INSERT INTO "${TABLE}" (${names.join(', ')}) VALUES (${placeholders.join(', ')})`,
		params,
	);
}

/**
 * A referrer's relation column: one locator pointing at the host (this is what
 * the matrix_relation_index trigger indexes and findInverseReferences finds)
 * plus one component_filter locator naming the project that owns the record.
 */
function referrerRelation(projectId: number) {
	return {
		[RELATION_COMPONENT]: [
			{
				id: 1,
				type: 'dd571',
				section_id: HOST_ID,
				section_tipo: SECTION,
				from_component_tipo: RELATION_COMPONENT,
			},
		],
		[PROJECTS_COMPONENT]: [
			{
				id: 1,
				type: 'dd675',
				section_id: projectId,
				section_tipo: 'dd153',
				from_component_tipo: PROJECTS_COMPONENT,
			},
		],
	};
}

/** Delete every record this file owns. `strict` throws when a delete removes 0 rows. */
async function purge(options: { strict: boolean }) {
	const missing: number[] = [];
	for (const sectionId of OWNED_IDS) {
		const removed = await deleteMatrixRecord(TABLE, SECTION, sectionId);
		if (removed === 0) missing.push(sectionId);
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[SECTION, sectionId],
		);
	}
	if (options.strict && missing.length > 0) {
		throw new Error(
			`count_native sweep removed 0 rows for ${SECTION}/${missing.join(', ')} — the scratch filter is wrong or another run deleted them`,
		);
	}
}

/** A `count` rqo over the inverse references of the host record. */
function relatedCountRqo(extra: Record<string, unknown> = {}) {
	return {
		action: 'count',
		dd_api: 'dd_core_api',
		sqo: {
			mode: 'related',
			section_tipo: [SECTION],
			filter_by_locators: [{ section_tipo: SECTION, section_id: HOST_ID }],
			...extra,
		},
	};
}

/**
 * ENVELOPE v2 READERS (ported 2026-08-19). This file used to read the PHP-era
 * `body.result` / `body.msg`, which are GONE (ERRORS_SPEC §envelope v2:
 * `{ok, request_id, data}` on success, `{ok:false, error:{code,…}}` on
 * failure). Every one of those reads yielded `undefined`, and nobody noticed
 * because the whole describe was blocked by a throwing `installAclIdentityFixture`
 * — the file never ran a single assertion. Refusals are now pinned by CODE, not
 * by the human message: the message is the disclosure-ladder's public string,
 * the code is the contract.
 */
function dataOf(body: Record<string, unknown>): { total: number; totals_group?: unknown } {
	return body.data as { total: number; totals_group?: unknown };
}
function totalOf(body: Record<string, unknown>): number {
	return dataOf(body).total;
}
function errorCodeOf(body: Record<string, unknown>): string | undefined {
	return (body.error as { code?: string } | undefined)?.code;
}

describe.if(DB_READY)('dd_core_api.count', () => {
	let adminContext: unknown;
	let nonAdminContext: unknown;

	beforeAll(async () => {
		await installAclIdentityFixture();
		await purge({ strict: false });
		// The host is IN the non-admin's project: its referrers are what gets scoped
		// (a host outside their projects is refused outright — the host-record test below).
		await insertScratchRecord(HOST_ID, {
			string: { test4: [{ id: 1, lang: 'lg-eng', value: 'zzcnt host record' }] },
			relation: {
				[PROJECTS_COMPONENT]: [
					{
						id: 1,
						type: 'dd675',
						section_id: ACL_PROJECT_ID,
						section_tipo: 'dd153',
						from_component_tipo: PROJECTS_COMPONENT,
					},
				],
			},
		});
		await insertScratchRecord(REFERRER_IN_SCOPE, {
			relation: referrerRelation(ACL_PROJECT_ID),
		});
		await insertScratchRecord(REFERRER_OUT_OF_SCOPE, {
			relation: referrerRelation(FOREIGN_PROJECT_ID),
		});
		// TM rows for the host — the dd15 read source counts THESE, the matrix
		// source counts the record. Two different numbers for one filter.
		await sql.unsafe(
			`INSERT INTO matrix_time_machine (section_id, section_tipo, tipo, lang, timestamp, user_id, data)
			 VALUES ($1,$2,$3,$4, now(), $5, $6::text::jsonb), ($1,$2,$3,$4, now(), $5, $6::text::jsonb)`,
			[HOST_ID, SECTION, SECTION, 'lg-eng', '1', encodeForJsonb({})],
		);
		const admin = await resolvePrincipal(ACL_ADMIN_USER_ID);
		const nonAdmin = await resolvePrincipal(ACL_NON_ADMIN_USER_ID);
		adminContext = contextFor(ACL_ADMIN_USER_ID, true, admin);
		nonAdminContext = contextFor(ACL_NON_ADMIN_USER_ID, false, nonAdmin);
	});

	afterAll(async () => {
		await purge({ strict: true });
		await removeAclIdentityFixture();
	});

	test('the contrast is live (guards every assertion below)', async () => {
		const admin = await resolvePrincipal(ACL_ADMIN_USER_ID);
		const nonAdmin = await resolvePrincipal(ACL_NON_ADMIN_USER_ID);
		expect(admin.isGlobalAdmin).toBe(true);
		expect(nonAdmin.isGlobalAdmin).toBe(false);
		// The non-admin must READ test3 (else its 200s below prove nothing) and
		// must NOT read dd88 (else the 403 arm proves nothing).
		expect(await getPermissions(nonAdmin, SECTION, SECTION)).toBeGreaterThanOrEqual(1);
		expect(await getPermissions(nonAdmin, UNREADABLE_FOR_NON_ADMIN, UNREADABLE_FOR_NON_ADMIN)).toBe(
			0,
		);
		expect(
			await getPermissions(admin, UNREADABLE_FOR_NON_ADMIN, UNREADABLE_FOR_NON_ADMIN),
		).toBeGreaterThanOrEqual(1);
	});

	test('a missing rqo.sqo is refused with 400, not a 500', async () => {
		const result = await dispatchRqo(
			{ action: 'count', dd_api: 'dd_core_api' } as never,
			adminContext as never,
		);
		expect(result.status).toBe(400);
		expect(result.body.ok).toBe(false);
		expect(errorCodeOf(result.body)).toBe('request.invalid_source');
	});

	test('related mode: a host locator in a section the caller cannot read is 403 — and the caller who CAN read it gets 200', async () => {
		const rqo = {
			action: 'count',
			dd_api: 'dd_core_api',
			sqo: {
				mode: 'related',
				section_tipo: [UNREADABLE_FOR_NON_ADMIN],
				filter_by_locators: [{ section_tipo: UNREADABLE_FOR_NON_ADMIN, section_id: 1 }],
			},
		};
		const refused = await dispatchRqo(rqo as never, nonAdminContext as never);
		expect(refused.status).toBe(403);
		expect(errorCodeOf(refused.body)).toBe('perm.denied');

		// THE POSITIVE CONTROL. Without it a handler that 403s everything (or
		// error-envelopes every call) passes the assertion above.
		const allowed = await dispatchRqo(rqo as never, adminContext as never);
		expect(allowed.status).toBe(200);
		expect(typeof totalOf(allowed.body)).toBe('number');
	});

	test('related mode: a host RECORD outside the caller\u2019s projects is 403, as for a missing one', async () => {
		const asHost = (sectionId: number) => ({
			action: 'count',
			dd_api: 'dd_core_api',
			sqo: {
				mode: 'related',
				section_tipo: [SECTION],
				filter_by_locators: [{ section_tipo: SECTION, section_id: sectionId }],
			},
		});
		const outOfScope = await dispatchRqo(
			asHost(REFERRER_OUT_OF_SCOPE) as never,
			nonAdminContext as never,
		);
		const missing = await dispatchRqo(asHost(937999) as never, nonAdminContext as never);
		const admin = await dispatchRqo(asHost(REFERRER_OUT_OF_SCOPE) as never, adminContext as never);
		expect([outOfScope.status, errorCodeOf(outOfScope.body)]).toEqual([403, 'perm.denied']);
		expect([missing.status, errorCodeOf(missing.body)]).toEqual([403, 'perm.denied']);
		expect(admin.status).toBe(200);
	});

	test('AUTHZ-05: the non-admin total counts ONLY references inside their projects', async () => {
		const adminResult = await dispatchRqo(relatedCountRqo() as never, adminContext as never);
		const nonAdminResult = await dispatchRqo(relatedCountRqo() as never, nonAdminContext as never);
		expect(adminResult.status).toBe(200);
		expect(nonAdminResult.status).toBe(200);

		const adminTotal = totalOf(adminResult.body);
		const nonAdminTotal = totalOf(nonAdminResult.body);

		// Both referrers exist and both point at the host: the admin sees two.
		expect(adminTotal).toBe(OWNED_IDS.length - 1);
		// The non-admin holds exactly one of the two projects: one reference.
		expect(nonAdminTotal).toBe(1);
		// THE ORACLE ASSERTION. Counting the unscoped owner question (dropping the
		// record scope) makes these EQUAL — the paginator then reports how many
		// records the projects ACL is hiding.
		expect(nonAdminTotal).not.toBe(adminTotal);
		expect(nonAdminTotal).toBeLessThan(adminTotal);
	});

	test("group_by ['section_tipo'] folds the scoped hits per section", async () => {
		const grouped = await dispatchRqo(
			relatedCountRqo({ group_by: ['section_tipo'] }) as never,
			nonAdminContext as never,
		);
		expect(grouped.status).toBe(200);
		const result = dataOf(grouped.body) as {
			total: number;
			totals_group?: { key: string[]; value: number }[];
		};
		expect(result.total).toBe(1);
		// The fold is the relation_list paginator's per-section count: exact shape,
		// exact value, and it must be SCOPED like the total it accompanies.
		expect(result.totals_group).toEqual([{ key: [SECTION], value: 1 }]);

		// The admin's fold over the same host counts both referrers — so a
		// hard-coded or unscoped fold cannot satisfy both cases.
		const adminGrouped = await dispatchRqo(
			relatedCountRqo({ group_by: ['section_tipo'] }) as never,
			adminContext as never,
		);
		expect(dataOf(adminGrouped.body).totals_group).toEqual([{ key: [SECTION], value: 2 }]);
	});

	test('the read SOURCE owns the count: dd15 counts TM rows, the default counts records', async () => {
		const locators = [{ section_tipo: SECTION, section_id: HOST_ID }];
		const matrixResult = await dispatchRqo(
			{
				action: 'count',
				dd_api: 'dd_core_api',
				sqo: { section_tipo: [SECTION], filter_by_locators: locators },
			} as never,
			adminContext as never,
		);
		const tmResult = await dispatchRqo(
			{
				action: 'count',
				dd_api: 'dd_core_api',
				sqo: { mode: 'tm', section_tipo: [TIME_MACHINE], filter_by_locators: locators },
			} as never,
			adminContext as never,
		);
		expect(matrixResult.status).toBe(200);
		expect(tmResult.status).toBe(200);
		// ONE record…
		expect(totalOf(matrixResult.body)).toBe(1);
		// …and the TM rows this file minted for it. Dropping pickReadSource counts
		// dd15 against matrix and the TM list's pagination disagrees with its rows.
		expect(totalOf(tmResult.body)).toBe(HOST_TM_ROWS);
		expect(totalOf(tmResult.body)).not.toBe(totalOf(matrixResult.body));
	});

	/**
	 * The DEFAULT arm has its own permission loop (getSectionTipos), separate
	 * from the related-mode host-locator loop above. Ungated, a caller obtains a
	 * RECORD-COUNT ORACLE over a section they cannot read — how many records
	 * match any filter they care to write, which is a disclosure channel even
	 * though no row content is returned.
	 */
	test('the DEFAULT arm gates on section permission too: unreadable section is 403, readable is 200', async () => {
		const countIn = (sectionTipo: string) =>
			dispatchRqo(
				{
					action: 'count',
					dd_api: 'dd_core_api',
					sqo: { section_tipo: [sectionTipo] },
				} as never,
				nonAdminContext as never,
			);
		const refused = await countIn(UNREADABLE_FOR_NON_ADMIN);
		expect(refused.status).toBe(403);
		expect(errorCodeOf(refused.body)).toBe('perm.denied');
		// POSITIVE CONTROL: the same identity, a section it CAN read → 200.
		const allowed = await countIn(SECTION);
		expect(allowed.status).toBe(200);
	});
});
