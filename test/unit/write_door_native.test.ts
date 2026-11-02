/**
 * THE WRITE DOOR — behavioural gate (closure Step 3; SEC-05 one layer down,
 * the dd128 rule on tools, the id grammar, the pair + section + scope halves).
 *
 * WHAT WAS WRONG (measured at 45b8c45162, src/core/tools/security.ts):
 *   - `record` / `record_tipo` read the RAW `getPermissions`, so the dd128
 *     own-record rule (a user may not raise their own profile) never applied at
 *     a tool door — a `(dd128, dd1725)` user-manager edited their OWN profile
 *     through any tool action that declared the kind;
 *   - the admin bypass sits ABOVE the non-positive-id refusal, and `tipo` /
 *     `section` pass ANY `section_id < 1` through `scopeIfRecordTargeted` —
 *     so a global admin holding `(dd128, dd133)` reached root's password
 *     (dd128/-1) through the tool door (SEC-05's shape);
 *   - `record` / `record_tipo` accept `1.5` (`Number.isFinite`), and `tipo` /
 *     `section` treat a garbage id (`'abc'`) as "no record named";
 *   - `record_tipo` checks the PAIR only: a principal holding 0 on the SECTION
 *     but 2 on one component wrote through it;
 *   - the self-service carve-out (a user editing their own name/email/password/
 *     image with no dd128 grant) is unreachable at a tool door;
 *   - the `section` kind ignores the consultation-only cap.
 *
 * THE LEGS (a–h) run through the REAL `assertActionPermission` — no
 * `mock.module` anywhere — on identities minted by `authz_door_fixture`, whose
 * contrast is asserted through the real resolver first. EVERY refusal has a
 * served twin on the same door (anti-vacuity): a door that refuses everything
 * reddens on the twin.
 *
 * THE PRIMITIVE block imports `src/core/security/write_door.ts` dynamically and
 * probes `parseRecordId` + `authorizeRecordAccess` directly. Pre-fix it is red
 * because the module does not exist yet (no producer — the door legs above
 * are the red-first proof of the findings themselves).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ok } from '../../src/core/errors/convert.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import { type Principal, resolvePrincipal } from '../../src/core/security/permissions.ts';
import type { ToolActionSpec } from '../../src/core/tools/module.ts';
import { assertActionPermission, type PermissionCheck } from '../../src/core/tools/security.ts';
import {
	AUTHZ_AV,
	AUTHZ_CONTROL_USER_ID,
	AUTHZ_PROJECT_P,
	AUTHZ_SECTION,
	AUTHZ_SECTION_ONLY_USER_ID,
	AUTHZ_USER_MANAGER_USER_ID,
	type AuthzIdentities,
	assertAuthzDoorContrast,
	createDoorRecord,
	installAuthzDoorFixture,
	removeAuthzDoorFixture,
	resolveAuthzIdentities,
} from '../helpers/authz_door_fixture.ts';
import { DB_READY } from '../helpers/db_ready.ts';

const USERS = 'dd128';
const ROOT_ID = -1;
/** Activity — a consultation-only section (isConsultationOnlySection). */
const CONSULTATION_ONLY = 'dd542';

type Kind = 'record' | 'record_tipo' | 'tipo' | 'section' | 'targets';

function spec(kind: Kind, minLevel = 2): ToolActionSpec {
	return {
		permission: kind,
		minLevel,
		...(kind === 'targets'
			? { targets: (options: Record<string, unknown>) => options.targets as never }
			: {}),
		handler: async () => ok(true, { requestId: 'write-door-native' }),
	} as ToolActionSpec;
}

const check = (kind: Kind, options: Record<string, unknown>, principal: Principal, level = 2) =>
	assertActionPermission(spec(kind, level), options, principal);

function expectRefused(result: PermissionCheck, msg?: string): void {
	expect(result.ok, `expected a refusal, got ${JSON.stringify(result)}`).toBe(false);
	if (msg !== undefined && !result.ok) expect(result.msg).toBe(msg);
}
function expectServed(result: PermissionCheck): void {
	expect(result, 'expected the door to serve').toEqual({ ok: true });
}

let ids: AuthzIdentities;
let superuser: Principal;
/** An engine-built test3 record in PROJECT_P (every in-scope identity's project). */
let recordP: number;

describe.if(DB_READY)('write door — every tool permission kind, real resolver, no mocks', () => {
	beforeAll(async () => {
		await installAuthzDoorFixture();
		recordP = await createDoorRecord(AUTHZ_SECTION, AUTHZ_PROJECT_P);
		ids = await resolveAuthzIdentities();
		superuser = await resolvePrincipal(-1);
	});
	afterAll(removeAuthzDoorFixture);

	test('the contrast is live through the real resolver (guards every leg)', async () => {
		await assertAuthzDoorContrast(ids);
		expect(recordP).toBeGreaterThan(0);
	});

	// ── a. the dd128 own-record DOWNGRADE at a tool door ─────────────────────
	test('a. a (dd128, dd1725) manager is refused on their OWN record — record_tipo and tipo', async () => {
		const own = { section_tipo: USERS, tipo: 'dd1725', section_id: AUTHZ_USER_MANAGER_USER_ID };
		expectRefused(
			await check('record_tipo', own, ids.userManager),
			'insufficient permissions on target',
		);
		expectRefused(await check('tipo', own, ids.userManager), 'insufficient permissions on target');
		// TWIN: the same grant on ANOTHER user's record is a real level 2 (the
		// downgrade binds the actor's own record only) and is served.
		const other = { section_tipo: USERS, tipo: 'dd1725', section_id: AUTHZ_CONTROL_USER_ID };
		expectServed(await check('record_tipo', other, ids.userManager));
	});

	// ── b. the non-positive id is refused BEFORE the admin bypass ────────────
	for (const sectionId of [ROOT_ID, 0]) {
		test(`b. a global admin holding (dd128, dd133) is refused on dd128/${sectionId} through every record-addressed kind`, async () => {
			const admin = ids.dd128Admin;
			expectRefused(await check('record', { section_tipo: USERS, section_id: sectionId }, admin));
			expectRefused(
				await check(
					'record_tipo',
					{ section_tipo: USERS, tipo: 'dd133', section_id: sectionId },
					admin,
				),
			);
			expectRefused(
				await check('tipo', { section_tipo: USERS, tipo: 'dd133', section_id: sectionId }, admin),
			);
			expectRefused(await check('section', { section_tipo: USERS, section_id: sectionId }, admin));
			// The id is GRAMMATICAL (an integer): what refuses it is the SCOPE step,
			// ahead of the admin bypass — not the old `id < 1` grammar sentence.
			expectRefused(
				await check(
					'targets',
					{ targets: [{ section_tipo: USERS, tipo: 'dd133', section_id: sectionId }] },
					admin,
				),
				'record is out of the user scope',
			);
		});
	}
	test('b-twin. the same admin is served on a positive in-scope record', async () => {
		const target = { section_tipo: AUTHZ_SECTION, tipo: AUTHZ_AV, section_id: recordP };
		expectServed(await check('record_tipo', target, ids.dd128Admin));
		expectServed(
			await check('record', { section_tipo: AUTHZ_SECTION, section_id: recordP }, ids.dd128Admin),
		);
	});

	// ── c. the SECTION half of record_tipo ───────────────────────────────────
	test('c. COMPONENT_ONLY (section 0, pair 2) is refused through record_tipo; the control is served', async () => {
		const target = { section_tipo: AUTHZ_SECTION, tipo: AUTHZ_AV, section_id: recordP };
		expectRefused(
			await check('record_tipo', target, ids.componentOnly),
			'insufficient permissions on target',
		);
		expectServed(await check('record_tipo', target, ids.control));
	});

	// ── d. the id grammar on record / record_tipo ────────────────────────────
	for (const garbage of [1.5, 'abc'] as const) {
		test(`d. section_id ${JSON.stringify(garbage)} is refused as an invalid target (record, record_tipo)`, async () => {
			expectRefused(
				await check('record', { section_tipo: AUTHZ_SECTION, section_id: garbage }, ids.dd128Admin),
				'invalid record target',
			);
			expectRefused(
				await check(
					'record_tipo',
					{ section_tipo: AUTHZ_SECTION, tipo: AUTHZ_AV, section_id: garbage },
					ids.dd128Admin,
				),
				'invalid permission target',
			);
		});
	}

	// ── d'. record / record_tipo with NO id: a record kind names a record ────
	// The `record` kind's refusal of a record-less target is the DOOR's own
	// (authorizeSectionRecord, review r8): through authorizeSectionTarget the
	// options would read as a CREATE and pass on the section level alone (HEAD
	// refused this case: NaN). An absent, null or empty id is therefore refused
	// as an invalid target, for the admin AND the control — and the twin (an
	// in-scope id) is served.
	for (const [label, absent] of [
		['absent', {}],
		['null', { section_id: null }],
		["''", { section_id: '' }],
	] as const) {
		test(`d'. section_id ${label} is refused as an invalid target (record, record_tipo) — admin and control`, async () => {
			for (const principal of [ids.dd128Admin, ids.control]) {
				expectRefused(
					await check('record', { section_tipo: AUTHZ_SECTION, ...absent }, principal),
					'invalid record target',
				);
				expectRefused(
					await check(
						'record_tipo',
						{ section_tipo: AUTHZ_SECTION, tipo: AUTHZ_AV, ...absent },
						principal,
					),
					'invalid permission target',
				);
			}
		});
	}
	test("d'-twin. the same identities are served with an in-scope id (record, record_tipo)", async () => {
		for (const principal of [ids.dd128Admin, ids.control]) {
			expectServed(
				await check('record', { section_tipo: AUTHZ_SECTION, section_id: recordP }, principal),
			);
			expectServed(
				await check(
					'record_tipo',
					{ section_tipo: AUTHZ_SECTION, tipo: AUTHZ_AV, section_id: recordP },
					principal,
				),
			);
		}
	});

	// ── e. tipo / section: a named id must be an id; absent is a create ──────
	for (const garbage of ['abc', 0] as const) {
		test(`e. tipo / section with section_id ${JSON.stringify(garbage)} are refused`, async () => {
			expectRefused(
				await check(
					'tipo',
					{ section_tipo: AUTHZ_SECTION, tipo: AUTHZ_AV, section_id: garbage },
					ids.control,
				),
			);
			expectRefused(
				await check('section', { section_tipo: AUTHZ_SECTION, section_id: garbage }, ids.control),
			);
		});
	}
	test('e-twin. tipo / section with the id ABSENT pass (a create) — and with a real in-scope id', async () => {
		expectServed(await check('tipo', { section_tipo: AUTHZ_SECTION, tipo: AUTHZ_AV }, ids.control));
		expectServed(await check('section', { section_tipo: AUTHZ_SECTION }, ids.control));
		expectServed(
			await check(
				'tipo',
				{ section_tipo: AUTHZ_SECTION, tipo: AUTHZ_AV, section_id: recordP },
				ids.control,
			),
		);
	});

	// ── f. the scope half ────────────────────────────────────────────────────
	test('f. in scope is served; the same grants in another project are refused as out of scope', async () => {
		const target = { section_tipo: AUTHZ_SECTION, tipo: AUTHZ_AV, section_id: recordP };
		expectServed(await check('record_tipo', target, ids.control));
		expectRefused(
			await check('record_tipo', target, ids.outOfScope),
			'record is out of the user scope',
		);
		expectRefused(await check('tipo', target, ids.outOfScope), 'record is out of the user scope');
	});

	// ── g. the self-service carve-out reaches the tool door ──────────────────
	test('g. a self-service write to (dd128, dd522, OWN id) passes with no dd128 grant; another id does not', async () => {
		const own = { section_tipo: USERS, tipo: 'dd522', section_id: AUTHZ_SECTION_ONLY_USER_ID };
		expectServed(await check('record_tipo', own, ids.sectionOnly));
		const other = { section_tipo: USERS, tipo: 'dd522', section_id: AUTHZ_CONTROL_USER_ID };
		expectRefused(await check('record_tipo', other, ids.sectionOnly));
	});

	// g'. ROOT's own image through record_tipo — the self-service carve-out
	// reaches the superuser's -1 too (the kind tool_upload's process_uploaded_file
	// takes once integrator request 13 lands: the `record` kind names no
	// component, so it can never see a self-service write and refuses -1 for
	// everyone — the twin below).
	test("g'. root writes its OWN image (dd128, dd522, -1) through record_tipo; the record kind (no component) refuses -1", async () => {
		const ownImage = { section_tipo: USERS, tipo: 'dd522', section_id: ROOT_ID };
		expectServed(await check('record_tipo', ownImage, superuser));
		expectRefused(
			await check('record', { section_tipo: USERS, section_id: ROOT_ID }, superuser),
			'record is out of the user scope',
		);
	});

	// ── h. the consultation-only cap on the section kind ─────────────────────
	test('h. a consultation-only section at level 2 is refused through the section kind (read passes)', async () => {
		expectRefused(await check('section', { section_tipo: CONSULTATION_ONLY }, superuser, 2));
		expectServed(await check('section', { section_tipo: CONSULTATION_ONLY }, superuser, 1));
	});

	// ── i. the `targets` kind is the write door too ──────────────────────────
	// Every entry of a targets list goes through the SAME door as the record
	// kinds (a named component of a named record = authorizeRecordAccess; else a
	// consultation-capped section target). Each refusal names its exact sentence
	// and has a served twin on the same door.
	const targets = (...entries: Record<string, unknown>[]) => ({ targets: entries });
	test('i. targets: the dd128 own-record rule — the manager is refused on their OWN dd1725, served on another user', async () => {
		expectRefused(
			await check(
				'targets',
				targets({ section_tipo: USERS, tipo: 'dd1725', section_id: AUTHZ_USER_MANAGER_USER_ID }),
				ids.userManager,
			),
			'insufficient permissions on target',
		);
		expectServed(
			await check(
				'targets',
				targets({ section_tipo: USERS, tipo: 'dd1725', section_id: AUTHZ_CONTROL_USER_ID }),
				ids.userManager,
			),
		);
	});
	test('i. targets: COMPONENT_ONLY (section 0, pair 2) is refused by the section floor; OUT_OF_SCOPE by the scope; the control is served', async () => {
		const entry = targets({ section_tipo: AUTHZ_SECTION, tipo: AUTHZ_AV, section_id: recordP });
		expectRefused(
			await check('targets', entry, ids.componentOnly),
			'insufficient permissions on target',
		);
		expectRefused(await check('targets', entry, ids.outOfScope), 'record is out of the user scope');
		expectServed(await check('targets', entry, ids.control));
	});
	test('i. targets: a section-level entry on a consultation-only section is capped (write refused, read served)', async () => {
		expectRefused(
			await check('targets', targets({ section_tipo: CONSULTATION_ONLY }), superuser, 2),
			'insufficient permissions on target',
		);
		expectServed(
			await check('targets', targets({ section_tipo: CONSULTATION_ONLY }), superuser, 1),
		);
		// The `tipo` kind naming the section itself is a section-level target too.
		expectRefused(
			await check(
				'tipo',
				{ section_tipo: CONSULTATION_ONLY, tipo: CONSULTATION_ONLY },
				superuser,
				2,
			),
			'insufficient permissions on target',
		);
	});

	// ── the primitive ────────────────────────────────────────────────────────
	describe('src/core/security/write_door.ts — the primitive', () => {
		test('parseRecordId: absent / id / invalid', async () => {
			const { parseRecordId } = await import('../../src/core/security/write_door.ts');
			for (const absent of [undefined, null, ''])
				expect(parseRecordId(absent)).toEqual({ kind: 'absent' });
			for (const [raw, id] of [
				[7, 7],
				['7', 7],
				[0, 0],
				[-1, -1],
			] as const) {
				expect(parseRecordId(raw)).toEqual({ kind: 'id', id });
			}
			for (const invalid of [1.5, Number.NaN, 'abc', true, {}]) {
				expect(parseRecordId(invalid)).toEqual({ kind: 'invalid' });
			}
			// The matrix section_id columns are int4: an id past that range (or past a
			// safe integer, where Number() silently rounds) is no record address — refused
			// as invalid BY THE GRAMMAR, never handed to SQL to abort the statement.
			for (const outOfRange of [
				'99999999999999999999',
				1e20,
				2147483648,
				'2147483648',
				-2147483649,
				'-2147483649',
				Number.MAX_SAFE_INTEGER + 1,
			]) {
				expect(parseRecordId(outOfRange), String(outOfRange)).toEqual({ kind: 'invalid' });
			}
			// …and the int4 edges themselves are ids.
			for (const [raw, id] of [
				[2147483647, 2147483647],
				['2147483647', 2147483647],
				[-2147483648, -2147483648],
				['-2147483648', -2147483648],
			] as const) {
				expect(parseRecordId(raw)).toEqual({ kind: 'id', id });
			}
		});

		test('authorizeSectionRecord: an ABSENT id is refused BY THE DOOR (never a create); a named id is level + scope; the grant carries it', async () => {
			const { authorizeSectionRecord, authorizeSectionTarget } = await import(
				'../../src/core/security/write_door.ts'
			);
			const options = { level: 2, door: 'write_door_native' };
			const codeOf = async (run: Promise<unknown>) =>
				run.then(
					() => 'served',
					(error: unknown) => (error instanceof DedaloError ? error.code : String(error)),
				);
			for (const principal of [ids.dd128Admin, ids.control]) {
				for (const absent of [undefined, null, '']) {
					expect(
						await codeOf(
							authorizeSectionRecord(
								principal,
								{ section_tipo: AUTHZ_SECTION, section_id: absent },
								options,
							),
						),
					).toBe('request.invalid');
					// CONTRAST: the create door reads the same absent id as a create.
					expect(
						await codeOf(
							authorizeSectionTarget(
								principal,
								{ section_tipo: AUTHZ_SECTION, section_id: absent },
								options,
							),
						),
					).toBe('served');
				}
			}
			expect(
				await codeOf(
					authorizeSectionRecord(
						ids.outOfScope,
						{ section_tipo: AUTHZ_SECTION, section_id: recordP },
						options,
					),
				),
			).toBe('perm.out_of_scope');
			expect(
				await codeOf(
					authorizeSectionRecord(
						ids.dd128Admin,
						{ section_tipo: AUTHZ_SECTION, section_id: ROOT_ID },
						options,
					),
				),
			).toBe('perm.out_of_scope');
			const grant = await authorizeSectionRecord(
				ids.control,
				{ section_tipo: AUTHZ_SECTION, section_id: String(recordP) },
				options,
			);
			expect(grant).toMatchObject({ sectionTipo: AUTHZ_SECTION, sectionId: recordP });
			expect(Object.isFrozen(grant)).toBe(true);
		});

		test('authorizeRecordAccess: the pair, the section floor, the id order, the grant it returns', async () => {
			const { authorizeRecordAccess } = await import('../../src/core/security/write_door.ts');
			const write = (sectionFloor: 0 | 1 | 2) => ({
				mode: 'write' as const,
				level: 2 as const,
				door: 'write_door_native',
				sectionFloor,
			});
			const target = { section_tipo: AUTHZ_SECTION, component_tipo: AUTHZ_AV, section_id: recordP };
			const codeOf = async (run: Promise<unknown>) =>
				run.then(
					() => 'served',
					(error: unknown) => (error instanceof DedaloError ? error.code : String(error)),
				);
			expect(await codeOf(authorizeRecordAccess(ids.sectionOnly, target, write(1)))).toBe(
				'perm.denied',
			);
			expect(await codeOf(authorizeRecordAccess(ids.componentOnly, target, write(1)))).toBe(
				'perm.denied',
			);
			// sectionFloor 0 is a CLOSED list of named doors: on a listed door the
			// section half is not asked; on any other door floor 0 is refused before
			// anything is read (internal.invariant) — even for a principal it would serve.
			const { SECTION_FLOOR_ZERO_DOORS } = await import('../../src/core/security/write_door.ts');
			expect([...SECTION_FLOOR_ZERO_DOORS].sort()).toEqual(
				['dd_component_text_area_api.delete_tag', 'save'].sort(),
			);
			for (const door of SECTION_FLOOR_ZERO_DOORS) {
				expect(
					await codeOf(authorizeRecordAccess(ids.componentOnly, target, { ...write(0), door })),
				).toBe('served');
			}
			expect(await codeOf(authorizeRecordAccess(ids.componentOnly, target, write(0)))).toBe(
				'internal.invariant',
			);
			expect(await codeOf(authorizeRecordAccess(ids.control, target, write(0)))).toBe(
				'internal.invariant',
			);
			expect(await codeOf(authorizeRecordAccess(ids.outOfScope, target, write(1)))).toBe(
				'perm.out_of_scope',
			);
			expect(
				await codeOf(
					authorizeRecordAccess(
						ids.dd128Admin,
						{ section_tipo: USERS, component_tipo: 'dd133', section_id: ROOT_ID },
						write(1),
					),
				),
			).toBe('perm.out_of_scope');
			expect(
				await codeOf(authorizeRecordAccess(ids.control, { ...target, section_id: 1.5 }, write(1))),
			).toBe('request.invalid');
			const grant = await authorizeRecordAccess(ids.control, target, write(1));
			expect(grant).toMatchObject({
				sectionTipo: AUTHZ_SECTION,
				componentTipo: AUTHZ_AV,
				sectionId: recordP,
				mode: 'write',
				level: 2,
			});
			expect(Object.isFrozen(grant)).toBe(true);
		});

		// The grant NAMES THE ACTOR it authorized: an effect typed on the grant
		// (relations/save.ts removePortalLocatorUnderGrant) audits as
		// `grant.userId`, never from a principal or request it no longer holds.
		test('authorizeRecordAccess: the grant carries the authorized principal userId (write and read)', async () => {
			const { authorizeRecordAccess } = await import('../../src/core/security/write_door.ts');
			const target = { section_tipo: AUTHZ_SECTION, component_tipo: AUTHZ_AV, section_id: recordP };
			expect(ids.control.userId).not.toBe(ROOT_ID);
			const writeGrant = await authorizeRecordAccess(ids.control, target, {
				mode: 'write',
				level: 2,
				door: 'write_door_native',
				sectionFloor: 2,
			});
			const readGrant = await authorizeRecordAccess(ids.control, target, {
				mode: 'read',
				level: 1,
				door: 'write_door_native',
				sectionFloor: 1,
			});
			expect((writeGrant as unknown as { userId?: unknown }).userId).toBe(ids.control.userId);
			expect((readGrant as unknown as { userId?: unknown }).userId).toBe(ids.control.userId);
		});

		// THE EXTERNAL-MIRROR REFRESH DOOR (2026-10-30, owner ruling: READ level
		// 1). A portal's `get_data_external` read may recompute its derived
		// mirror; the door asks the READ half — the result is a pure function of
		// committed data, independent of the requester — so a level-1 reader is
		// SERVED, the same principal is refused at a write door (contrast), and
		// a principal outside the record's scope is refused. The grant names the
		// requester: it is the Time Machine actor of the refresh write.
		test('the external refresh door: a level-1 READER is served at floor 1, refused at a write door; out-of-scope refused', async () => {
			const { authorizeRecordAccess } = await import('../../src/core/security/write_door.ts');
			const { EXTERNAL_REFRESH_DOOR } = await import(
				'../../src/core/section/record/external_refresh.ts'
			);
			expect(EXTERNAL_REFRESH_DOOR).toBe('dd_core_api.read.refresh_external');
			// The refresh door is NOT a floor-0 door (the closed list above).
			const { SECTION_FLOOR_ZERO_DOORS } = await import('../../src/core/security/write_door.ts');
			expect([...SECTION_FLOOR_ZERO_DOORS]).not.toContain(EXTERNAL_REFRESH_DOOR);
			// The options the door module passes, verbatim (pinned against its source
			// below, so this leg exercises what production asks).
			const refresh = {
				mode: 'read' as const,
				level: 1 as const,
				sectionFloor: 1 as const,
				door: EXTERNAL_REFRESH_DOOR,
			};
			const doorSource = await Bun.file(
				new URL('../../src/core/section/record/external_refresh.ts', import.meta.url),
			).text();
			expect(doorSource).toContain(
				"{ mode: 'read', level: 1, sectionFloor: 1, door: EXTERNAL_REFRESH_DOOR }",
			);
			const target = { section_tipo: AUTHZ_SECTION, component_tipo: AUTHZ_AV, section_id: recordP };
			const codeOf = async (run: Promise<unknown>) =>
				run.then(
					() => 'served',
					(error: unknown) => (error instanceof DedaloError ? error.code : String(error)),
				);
			const grant = await authorizeRecordAccess(ids.level1, target, refresh);
			expect(grant).toMatchObject({
				sectionTipo: AUTHZ_SECTION,
				sectionId: recordP,
				mode: 'read',
				level: 1,
			});
			expect((grant as unknown as { userId?: unknown }).userId).toBe(ids.level1.userId);
			expect(
				await codeOf(
					authorizeRecordAccess(ids.level1, target, {
						mode: 'write',
						level: 2,
						door: 'write_door_native',
						sectionFloor: 2,
					}),
				),
			).toBe('perm.denied');
			expect(await codeOf(authorizeRecordAccess(ids.outOfScope, target, refresh))).toBe(
				'perm.out_of_scope',
			);
		});
	});
});
