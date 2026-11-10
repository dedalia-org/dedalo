/**
 * CLOSURE STEP 3, integrator request 7 — the agent's CHANGE-PLAN VALIDATOR asks
 * THE WRITE DOOR (security/write_door.ts), the same door every op's tool asks at
 * apply. A plan the human confirms is never one its own apply would refuse, and
 * never one a weaker preview let through.
 *
 * WHAT WAS WRONG (d724c8851d, src/ai/agent/change_plan.ts validateChangePlan):
 * the validator kept a private, weaker copy of the door —
 *   - a `section_id` that was not a NUMBER (the string "941101") skipped the
 *     scope check entirely, and a fractional one was FLOORED;
 *   - an op with no `field` (save_component names its component `tipo`; delete,
 *     duplicate, create) was judged on the RAW section level: the component pair
 *     never asked, the consultation cap never applied (the superuser validated a
 *     create in Activity, dd542);
 *   - scope was asked as a READ (`principalCanAccessRecord`), not the write door's.
 *
 * THE IDENTITIES are authz_door_fixture's, asserted through the real resolver
 * (`assertAuthzDoorContrast`) before any leg: CONTROL (every test3 grant, project
 * P), OUT_OF_SCOPE (the same grants, project Q), SECTION_ONLY (test3 at 2, test52
 * at an explicit 0), USER_MANAGER (dd128, dd1725 at 2 — the own-record downgrade),
 * DD128_ADMIN (a global admin). Each refusal has a served twin (CONTROL on the
 * same record), so a validator that refused everything is red.
 *
 * RED AT d724c8851d: the string-id smuggle, the save_component `tipo` pair, the
 * consultation-capped create and the fractional id all VALIDATED there.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { validateChangePlan } from '../../src/ai/agent/change_plan.ts';
import { TOOL_REGISTRY } from '../../src/ai/mcp/registry.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import { type Principal, resolvePrincipal } from '../../src/core/security/permissions.ts';
import {
	AUTHZ_PROJECT_P,
	AUTHZ_SECTION,
	AUTHZ_TEXT,
	AUTHZ_USER_MANAGER_USER_ID,
	type AuthzIdentities,
	assertAuthzDoorContrast,
	createDoorRecord,
	installAuthzDoorFixture,
	removeAuthzDoorFixture,
	resolveAuthzIdentities,
} from '../helpers/authz_door_fixture.ts';
import { DB_READY } from '../helpers/db_ready.ts';

/** Activity — consultation-only: no create, whoever asks (the superuser included). */
const CONSULTATION_ONLY = 'dd542';
const WRITE = { allowWrite: true } as const;

let ids: AuthzIdentities;
let superuser: Principal;
let recordId = 0;

function plan(tool: string, args: Record<string, unknown>) {
	return {
		plan_version: 1 as const,
		summary: 'zzplan',
		ops: [{ op_id: 'op1', tool, args, summary: 'zzplan op' }],
	};
}

/** 'validated', or the refusal's code (with the op it names). */
async function verdict(
	principal: Principal,
	tool: string,
	args: Record<string, unknown>,
): Promise<string> {
	try {
		await validateChangePlan(principal, plan(tool, args), WRITE);
		return 'validated';
	} catch (error) {
		if (!(error instanceof DedaloError)) throw error;
		const op = (error.extend as { op_id?: unknown } | undefined)?.op_id;
		return op === 'op1' ? error.code : `${error.code} (no op_id)`;
	}
}

const setText = (sectionId: unknown) => ({
	section_tipo: AUTHZ_SECTION,
	section_id: sectionId,
	field: AUTHZ_TEXT,
	value: 'zzplan',
	lang: 'lg-eng',
});

describe.if(DB_READY)('req 7 — the change-plan validator asks the write door', () => {
	beforeAll(async () => {
		await installAuthzDoorFixture();
		ids = await resolveAuthzIdentities();
		superuser = await resolvePrincipal(-1);
		recordId = await createDoorRecord(AUTHZ_SECTION, AUTHZ_PROJECT_P);
	});
	afterAll(removeAuthzDoorFixture);

	test('the identities are what they claim (the contrast is live)', async () => {
		await assertAuthzDoorContrast(ids);
		expect(recordId).toBeGreaterThan(0);
	});

	test('the served twin: CONTROL validates a set_field on its in-scope record (anti-vacuity)', async () => {
		expect(await verdict(ids.control, 'dedalo_set_field', setText(recordId))).toBe('validated');
	});

	test('a STRING id is a record address, scoped like any other: OUT_OF_SCOPE is refused', async () => {
		expect(await verdict(ids.control, 'dedalo_set_field', setText(String(recordId)))).toBe(
			'validated',
		);
		expect(await verdict(ids.outOfScope, 'dedalo_set_field', setText(String(recordId)))).toBe(
			'perm.out_of_scope',
		);
	});

	test('a FRACTIONAL id is not a record id (never floored): request.invalid', async () => {
		expect(await verdict(ids.control, 'dedalo_set_field', setText(recordId + 0.5))).toBe(
			'request.invalid',
		);
	});

	test("save_component's `tipo` is the PAIR it writes: SECTION_ONLY (test52 at 0) is refused", async () => {
		const args = {
			section_tipo: AUTHZ_SECTION,
			tipo: AUTHZ_TEXT,
			section_id: recordId,
			lang: 'lg-eng',
			action: 'update',
			value: { id: 1, lang: 'lg-eng', value: 'zzplan' },
		};
		expect(await verdict(ids.control, 'dedalo_save_component', args)).toBe('validated');
		expect(await verdict(ids.sectionOnly, 'dedalo_save_component', args)).toBe('perm.denied');
	});

	test('a create is consultation-capped: the SUPERUSER cannot plan a record in Activity', async () => {
		expect(await verdict(superuser, 'dedalo_create_record', { section_tipo: AUTHZ_SECTION })).toBe(
			'validated',
		);
		expect(
			await verdict(superuser, 'dedalo_create_record', { section_tipo: CONSULTATION_ONLY }),
		).toBe('perm.denied');
	});

	// T0-2 / D4 (review finding F3): a create / duplicate op is dry-run on the SAME
	// New-button predicate its MCP executor asks (authorizeRecordCreate), so a plan the
	// human confirms never half-applies on it. FEATURE_EDITOR holds test3 at 2 and its
	// button_new test126 at an explicit 0; CONTROL holds both at 2.
	test('a create / duplicate op asks the NEW-BUTTON predicate: FEATURE_EDITOR (test126 at 0) is refused, nothing written', async () => {
		const rowsBefore =
			await sql`SELECT count(*)::int AS n FROM matrix_test WHERE section_tipo = ${AUTHZ_SECTION}`;
		const create = { section_tipo: AUTHZ_SECTION };
		const duplicate = { section_tipo: AUTHZ_SECTION, section_id: recordId };
		expect(await verdict(ids.control, 'dedalo_create_record', create)).toBe('validated');
		expect(await verdict(ids.featureEditor, 'dedalo_create_record', create)).toBe('perm.denied');
		expect(await verdict(ids.control, 'dedalo_duplicate_record', duplicate)).toBe('validated');
		expect(await verdict(ids.featureEditor, 'dedalo_duplicate_record', duplicate)).toBe(
			'perm.denied',
		);
		const findArgs = {
			section_tipo: AUTHZ_SECTION,
			match: [{ field: AUTHZ_TEXT, value: 'zzplan', lang: 'lg-eng' }],
		};
		expect(await verdict(ids.featureEditor, 'dedalo_find_or_create', findArgs)).toBe('perm.denied');
		// Validation writes nothing — the refused plans left test3's row set as it was.
		const rowsAfter =
			await sql`SELECT count(*)::int AS n FROM matrix_test WHERE section_tipo = ${AUTHZ_SECTION}`;
		expect(rowsAfter[0]?.n).toBe(rowsBefore[0]?.n);
	});

	test('a find_or_create asks every match field’s pair: SECTION_ONLY on test52 is refused', async () => {
		const args = {
			section_tipo: AUTHZ_SECTION,
			match: [{ field: AUTHZ_TEXT, value: 'zzplan', lang: 'lg-eng' }],
		};
		expect(await verdict(ids.control, 'dedalo_find_or_create', args)).toBe('validated');
		expect(await verdict(ids.sectionOnly, 'dedalo_find_or_create', args)).toBe('perm.denied');
	});

	test('the dd128 own-record downgrade: a user-manager cannot plan its OWN dd1725', async () => {
		const args = {
			section_tipo: 'dd128',
			section_id: AUTHZ_USER_MANAGER_USER_ID,
			field: 'dd1725',
			value: { section_tipo: 'dd234', section_id: 1 },
		};
		expect(await verdict(ids.userManager, 'dedalo_set_field', args)).toBe('perm.denied');
	});

	test('a non-positive id is refused AHEAD of the admin bypass (the global admin on test3/-1)', async () => {
		expect(ids.dd128Admin.isGlobalAdmin).toBe(true);
		expect(await verdict(ids.dd128Admin, 'dedalo_set_field', setText(-1))).toBe(
			'perm.out_of_scope',
		);
		expect(
			await verdict(ids.dd128Admin, 'dedalo_delete_record', {
				section_tipo: AUTHZ_SECTION,
				section_id: 0,
			}),
		).toBe('perm.out_of_scope');
	});

	test('every registry WRITE tool has a plan target rule (fail closed for a new one)', async () => {
		const writeTools = TOOL_REGISTRY.filter((spec) => spec.write === true).map((spec) => spec.name);
		expect(writeTools.length).toBeGreaterThan(5); // anti-vacuity
		const unruled: string[] = [];
		for (const tool of writeTools) {
			try {
				await validateChangePlan(
					superuser,
					plan(tool, { section_tipo: AUTHZ_SECTION, section_id: recordId }),
					WRITE,
				);
			} catch (error) {
				const message = error instanceof DedaloError ? (error.publicMessage ?? '') : '';
				if (message.includes('has no plan target rule')) unruled.push(tool);
			}
		}
		expect(unruled).toEqual([]);
	});
});
