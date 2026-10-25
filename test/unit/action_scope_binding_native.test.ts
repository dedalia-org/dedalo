/**
 * GATE (behavioural, suite DB) — the three CARRY-08 doors REFUSE a principal
 * holding the DECLARED-BUT-WRONG grant and nothing on the real target
 * (audit 2026-08-26 P1-24 / TOOLS-04), and the refusal precedes the fork.
 *
 * The audit proved each door open by execution with exactly this principal
 * shape: write on `options.section_tipo`, 0 on what the action writes. The
 * source-level binding (action_scope_binding_tripwire) says each gate is
 * DECLARED over the write target; this file says the declaration DENIES —
 * through the real gate function the dispatcher runs, and once through the
 * dispatcher itself with `background_running:true` to pin the ORDER invariant
 * (a denial after the fork lands on a job frame nobody reads).
 *
 * The situation is BUILT (test/helpers/scope_binding_fixture.ts): user A holds
 * test3 = 2 and test3.test52 = 2 and NOTHING on test65 / hierarchy1; user B
 * holds hierarchy1 = 2 and READ ONLY on test65; A and B each own a project, so
 * a test3 record one creates is outside the other's scope. Every probe carries
 * its positive control — the same request with the target moved onto the
 * granted section / the record moved into scope passes — so a gate that
 * refused everything would be as red as one that refused nothing.
 *
 * THREE HALVES of one authorization are probed: the PAIR (section × component,
 * at the gate), the LEVEL (a read grant must not satisfy a write action) and
 * the RECORD — at the gate for the ids a request spells, and IN-HANDLER for
 * the ids import_files binds at run time (a filename prefix, a matcher hit),
 * which the audit's reproduction proved the gate alone could not see.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { readMatrixRecord } from '../../src/core/db/matrix.ts';
import { sql, withTransaction } from '../../src/core/db/postgres.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { deleteSectionRecord } from '../../src/core/section/record/delete_record.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import {
	getPermissions,
	type Principal,
	resolvePrincipal,
	TEMP_PRESET_SECTION,
} from '../../src/core/security/permissions.ts';
import { isRecordInScope } from '../../src/core/security/record_scope.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import type { ToolActionContext } from '../../src/core/tools/module.ts';
import { assertActionPermission } from '../../src/core/tools/security.ts';
import { mustGet } from '../helpers/assert.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import { refusalOf } from '../helpers/refusal.ts';
import {
	installScopeBindingFixture,
	removeScopeBindingFixture,
	SB_DENIED_SECTION,
	SB_GRANTED_COMPONENT,
	SB_GRANTED_SECTION,
	SB_HIERARCHY_SECTION,
	SB_INPUT_COMPONENT,
	SB_MEDIA_COMPONENT,
	type ScopeBindingFixture,
} from '../helpers/scope_binding_fixture.ts';

/** THIS file's instance of the scope-binding fixture (ids allocated at install). */
let sb: ScopeBindingFixture;

/** A component of test3 NEITHER profile grants (test3's component_select). */
const SB_UNGRANTED_COMPONENT = 'test91';
/** dd624 — the preset's name component (the caller pair on a dd655 request). */
const PRESET_NAME_COMPONENT = 'dd624';

/** The filename the match_freename probe stores on B's record and then uploads. */
const MATCH_FILENAME = 'zzsb-match.jpg';

let A: Principal;
let B: Principal;
/** A test3 record CREATED BY B — inside B's scope, outside A's (disjoint projects). */
let recordOfB = 0;

const contextOf = (options: Record<string, unknown>, principal: Principal): ToolActionContext =>
	({ principal, userId: principal.userId, options, background: false }) as ToolActionContext;

/** Run import_files as `principal`; returns the per-file error lines + the count. */
async function runImport(
	options: Record<string, unknown>,
	principal: Principal,
): Promise<{ errors: string[]; imported: number }> {
	const importFiles = await spec('tool_import_files', 'import_files');
	const response = await importFiles.handler(contextOf(options, principal));
	return response.data as { errors: string[]; imported: number };
}

/** The stored `media` column of B's record — null until an ingest lands on it. */
async function mediaOfRecordOfB(): Promise<unknown> {
	const record = await readMatrixRecord('matrix_test', SB_GRANTED_SECTION, recordOfB);
	return record?.columns.media ?? null;
}

/** Stamp a test3 record's project (dd675 on test101 — the stored shape; test3 has no birth project). */
async function stampProject(sectionId: number, projectId: number): Promise<void> {
	await sql.unsafe(
		`UPDATE matrix_test SET relation = coalesce(relation, '{}'::jsonb) || $3::text::jsonb
		 WHERE section_tipo = $1 AND section_id = $2`,
		[
			SB_GRANTED_SECTION,
			sectionId,
			encodeForJsonb({
				test101: [
					{
						id: 1,
						type: 'dd675',
						section_id: projectId,
						section_tipo: config.features.filterSectionTipo,
						from_component_tipo: 'test101',
					},
				],
			}),
		],
	);
}

/** A test3 id no row holds now (MAX+1 — swept by the probe that takes it). */
async function freeTest3Id(): Promise<number> {
	const rows = (await sql.unsafe(
		'SELECT COALESCE(MAX(section_id), 0)::int + 1 AS id FROM matrix_test WHERE section_tipo = $1',
		[SB_GRANTED_SECTION],
	)) as { id: number }[];
	const id = rows[0]?.id ?? 1;
	expect(await readMatrixRecord('matrix_test', SB_GRANTED_SECTION, id)).toBeNull();
	return id;
}

/**
 * Poll until some backend waits on a lock HELD BY `pid` — identity, not a sleep
 * (import_create_door_native's idiom): `pg_blocking_pids` names the blocker.
 */
async function waitUntilBlockedBy(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const rows = (await sql.unsafe(
			`SELECT count(*)::int AS n FROM pg_stat_activity
			 WHERE wait_event_type = 'Lock' AND $1::int = ANY(pg_blocking_pids(pid))`,
			[String(pid)],
		)) as { n: number }[];
		if ((rows[0]?.n ?? 0) > 0) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return false;
}

/** The enumerate request whose filename prefix names `sectionId`. */
const enumerateRequest = (sectionId: number, keyDir: string) => ({
	section_tipo: SB_GRANTED_SECTION,
	tipo: SB_MEDIA_COMPONENT,
	key_dir: keyDir,
	tool_config: {
		import_mode: 'section_resource',
		import_file_name_mode: 'enumerate',
		ddo_map: [
			{ role: 'target_component', tipo: SB_MEDIA_COMPONENT, section_tipo: SB_GRANTED_SECTION },
		],
	},
	files_data: [{ name: `${sectionId}-photo.jpg` }],
});

/**
 * THE RACE (refuter-surviving, closure Step 3): B's ordinary create of
 * `sectionId`, stamped into `projectId`, is written but NOT committed when A's
 * enumerate import resolves the filename prefix — so A's existence read finds
 * no row — and commits only once A's conflict-tolerant insert is provably
 * waiting on it. A's insert is then a no-op: the record is B's.
 */
async function enumerateImportRacingCreate(sectionId: number, projectId: number) {
	let releaseCreator: () => void = () => {};
	const creatorHold = new Promise<void>((resolve) => {
		releaseCreator = resolve;
	});
	let creatorWrote: () => void = () => {};
	const written = new Promise<void>((resolve) => {
		creatorWrote = resolve;
	});
	let creatorPid = 0;
	const creator = withTransaction(async () => {
		const pidRows = (await sql.unsafe('SELECT pg_backend_pid() AS pid')) as { pid: number }[];
		creatorPid = Number(pidRows[0]?.pid ?? 0);
		await createSectionRecord(SB_GRANTED_SECTION, sb.userB, new Date(), sectionId);
		await stampProject(sectionId, projectId);
		creatorWrote();
		await creatorHold; // written; NOT committed
	});
	await written;
	expect(creatorPid).toBeGreaterThan(0);
	const run = runImport(enumerateRequest(sectionId, 'zzsb_enumerate_race'), A);
	const blocked = await waitUntilBlockedBy(creatorPid, 15_000);
	releaseCreator();
	await creator;
	return { blocked, result: await run };
}

async function spec(tool: string, action: string) {
	const loaded = await getLoadedTool(tool);
	return mustGet(loaded?.module.apiActions[action], `${tool}.${action}`);
}

describe.if(DB_READY)(
	'action_scope_binding — the gate refuses the declared-but-wrong grant',
	() => {
		beforeAll(async () => {
			sb = await installScopeBindingFixture();
			A = await resolvePrincipal(sb.userA);
			B = await resolvePrincipal(sb.userB);
			// The record axis needs a REAL record only one of them can reach. test3
			// is the birth-defaults SENTINEL (record_defaults.ts
			// FILTER_EXCLUDED_SECTIONS: a create stamps no project there, PHP
			// parity), so the project B's scope runs on is stamped here, by the
			// probe that owns the row — dd675 on test101, the stored shape.
			recordOfB = await createSectionRecord(SB_GRANTED_SECTION, sb.userB);
			await sql.unsafe(
				`UPDATE matrix_test SET relation = coalesce(relation, '{}'::jsonb) || $3::text::jsonb
				 WHERE section_tipo = $1 AND section_id = $2`,
				[
					SB_GRANTED_SECTION,
					recordOfB,
					encodeForJsonb({
						test101: [
							{
								id: 1,
								type: 'dd675',
								section_id: config.features.defaultProject,
								section_tipo: config.features.filterSectionTipo,
								from_component_tipo: 'test101',
							},
						],
					}),
				],
			);
		});
		afterAll(async () => {
			if (recordOfB > 0) await deleteSectionRecord(SB_GRANTED_SECTION, recordOfB, -1);
			await removeScopeBindingFixture(sb);
		});

		test('the fixture is non-degenerate: A holds the DECLARED grant and 0 on the real targets', async () => {
			expect(A.isGlobalAdmin).toBe(false);
			// The grant every door used to be satisfied by…
			expect(await getPermissions(A, SB_GRANTED_SECTION, SB_GRANTED_SECTION)).toBe(2);
			expect(await getPermissions(A, SB_GRANTED_SECTION, SB_GRANTED_COMPONENT)).toBe(2);
			// …and nothing on what each door actually writes.
			expect(await getPermissions(A, SB_DENIED_SECTION, SB_GRANTED_COMPONENT)).toBe(0);
			expect(await getPermissions(A, SB_HIERARCHY_SECTION, SB_HIERARCHY_SECTION)).toBe(0);
			expect(await getPermissions(B, SB_HIERARCHY_SECTION, SB_HIERARCHY_SECTION)).toBe(2);
			// The LEVEL axis: B READS test65 (1 on the section and on the pair) —
			// never 0 (a refusal would then be the pair's, not the level's).
			expect(await getPermissions(B, SB_DENIED_SECTION, SB_DENIED_SECTION)).toBe(1);
			expect(await getPermissions(B, SB_DENIED_SECTION, SB_GRANTED_COMPONENT)).toBe(1);
			// The RECORD axis: both hold write on the media pair; the record B
			// created is reachable by B and NOT by A — the gate's own predicate.
			expect(await getPermissions(A, SB_GRANTED_SECTION, SB_MEDIA_COMPONENT)).toBe(2);
			expect(await getPermissions(B, SB_GRANTED_SECTION, SB_MEDIA_COMPONENT)).toBe(2);
			expect(recordOfB).toBeGreaterThan(0);
			expect(await isRecordInScope(SB_GRANTED_SECTION, recordOfB, B)).toBe(true);
			expect(await isRecordInScope(SB_GRANTED_SECTION, recordOfB, A)).toBe(false);
		});

		test('the LEVEL half: a READ grant (1) satisfies a read action and NOT a write action on the same pair', async () => {
			// B holds exactly 1 on test65 × test52. update_cache and import_files
			// declare minLevel 2; the free-name matcher declares 1. A gate that
			// compared against any constant below 2 — or against nothing — would
			// pass all three; a gate that demanded 2 everywhere would refuse the
			// matcher too. Only `level < minLevel` gives this exact split.
			const updateCache = await spec('tool_update_cache', 'update_cache');
			expect(
				await assertActionPermission(
					updateCache,
					{
						section_tipo: SB_DENIED_SECTION,
						sqo: { section_tipo: [SB_DENIED_SECTION] },
						components_selection: [{ tipo: SB_GRANTED_COMPONENT }],
					},
					B,
				),
			).toEqual({ ok: false, msg: 'insufficient permissions on target', errors: ['unauthorized'] });
			const importFiles = await spec('tool_import_files', 'import_files');
			expect(
				await assertActionPermission(
					importFiles,
					{
						section_tipo: SB_DENIED_SECTION,
						tipo: SB_GRANTED_COMPONENT,
						files_data: [{ name: 'x.jpg' }],
					},
					B,
				),
			).toEqual({ ok: false, msg: 'insufficient permissions on target', errors: ['unauthorized'] });
			const matcher = await spec('tool_import_files', 'get_media_section_match');
			const matcherRequest = {
				full_name: 'x.jpg',
				target_filename: { section_tipo: SB_DENIED_SECTION, tipo: SB_GRANTED_COMPONENT },
			};
			expect(await assertActionPermission(matcher, matcherRequest, B)).toEqual({ ok: true });
			// …and the same read action is refused for A, who holds 0 there: the
			// matcher's pass above is the LEVEL admitting it, not the kind.
			expect((await assertActionPermission(matcher, matcherRequest, A)).ok).toBe(false);
		});

		test('update_cache: declared test3, SQO naming test65 → REFUSED; SQO naming test3 → passes', async () => {
			const updateCache = await spec('tool_update_cache', 'update_cache');
			const request = (sqoSection: string) => ({
				section_tipo: SB_GRANTED_SECTION,
				sqo: { section_tipo: [sqoSection] },
				components_selection: [{ tipo: SB_GRANTED_COMPONENT }],
			});
			const refused = await assertActionPermission(updateCache, request(SB_DENIED_SECTION), A);
			expect(refused).toEqual({
				ok: false,
				msg: 'insufficient permissions on target',
				errors: ['unauthorized'],
			});
			expect(await assertActionPermission(updateCache, request(SB_GRANTED_SECTION), A)).toEqual({
				ok: true,
			});
			// The PAIR half: a component of the granted section that the profile does
			// NOT grant (test91) is refused even though the section level is 2 — a
			// section-only check would have passed it.
			expect(await getPermissions(A, SB_GRANTED_SECTION, SB_UNGRANTED_COMPONENT)).toBe(0);
			expect(
				(
					await assertActionPermission(
						updateCache,
						{
							...request(SB_GRANTED_SECTION),
							components_selection: [{ tipo: SB_UNGRANTED_COMPONENT }],
						},
						A,
					)
				).ok,
			).toBe(false);
			// An SQO naming NO section cannot be authorized at all.
			expect(
				(
					await assertActionPermission(
						updateCache,
						{
							section_tipo: SB_GRANTED_SECTION,
							components_selection: [{ tipo: SB_GRANTED_COMPONENT }],
						},
						A,
					)
				).ok,
			).toBe(false);
		});

		test('generate_virtual_section: A (test3 write, 0 on hierarchy1) → REFUSED; B (hierarchy1 write) → passes', async () => {
			const generate = await spec('tool_hierarchy', 'generate_virtual_section');
			// The audit shape: the client names the section it holds write on; the
			// writer ignores it and rewrites hierarchy1/<id>.
			const options = { section_tipo: SB_GRANTED_SECTION, section_id: sb.hierarchyId };
			expect(await assertActionPermission(generate, options, A)).toEqual({
				ok: false,
				msg: 'insufficient permissions on target',
				errors: ['unauthorized'],
			});
			expect(await assertActionPermission(generate, options, B)).toEqual({ ok: true });
			// And a non-positive / missing record id is a denial for everyone.
			expect(
				(await assertActionPermission(generate, { section_tipo: SB_HIERARCHY_SECTION }, B)).ok,
			).toBe(false);
			// inspect_hierarchy (read, level 1) is bound the same way.
			const inspect = await spec('tool_hierarchy', 'inspect_hierarchy');
			expect((await assertActionPermission(inspect, options, A)).ok).toBe(false);
			expect((await assertActionPermission(inspect, options, B)).ok).toBe(true);
		});

		test('import_files: a ddo_map entry on test65 → REFUSED; on test3 → passes', async () => {
			const importFiles = await spec('tool_import_files', 'import_files');
			const request = (mapSection: string) => ({
				section_tipo: SB_GRANTED_SECTION,
				tipo: SB_GRANTED_COMPONENT,
				files_data: [{ name: 'x.jpg' }],
				tool_config: {
					import_mode: 'section_resource',
					ddo_map: [
						{
							role: 'target_component',
							tipo: SB_GRANTED_COMPONENT,
							section_tipo: SB_GRANTED_SECTION,
						},
						{ role: 'target_filename', tipo: SB_GRANTED_COMPONENT, section_tipo: mapSection },
					],
				},
			});
			expect(await assertActionPermission(importFiles, request(SB_DENIED_SECTION), A)).toEqual({
				ok: false,
				msg: 'insufficient permissions on target',
				errors: ['unauthorized'],
			});
			expect(await assertActionPermission(importFiles, request(SB_GRANTED_SECTION), A)).toEqual({
				ok: true,
			});
			// The ONE target the extractor cannot see — a portal whose target section
			// resolves from the ontology at run time — is re-authorized in-handler.
			const { assertPortalTargetWritable } = await import(
				'../../tools/tool_import_files/server/index.ts'
			);
			const refusal = await refusalOf(
				assertPortalTargetWritable(A, SB_DENIED_SECTION, SB_GRANTED_COMPONENT),
			);
			expect(refusal.code).toBe('perm.denied');
			await assertPortalTargetWritable(A, SB_GRANTED_SECTION, SB_GRANTED_COMPONENT);
		});

		test('the RECORD half: a named section_id the caller holds the level on but cannot reach → REFUSED', async () => {
			// dd655 is the one section every principal holds level 2 on by rule, and
			// the assembler's owner predicate is what puts another user's row out of
			// scope — so a pre-matched file naming B's row is refused on SCOPE alone
			// (the level check passed), and A's own row passes.
			const importFiles = await spec('tool_import_files', 'import_files');
			const request = (matchedId: number) => ({
				section_tipo: TEMP_PRESET_SECTION,
				tipo: PRESET_NAME_COMPONENT,
				files_data: [{ name: 'x.jpg', section_id: matchedId }],
			});
			expect(await assertActionPermission(importFiles, request(sb.presetOfB), A)).toEqual({
				ok: false,
				msg: 'record is out of the user scope',
				errors: ['unauthorized'],
			});
			expect(await assertActionPermission(importFiles, request(sb.presetOfA), A)).toEqual({
				ok: true,
			});
		});

		test('the RECORD half IN-HANDLER (enumerate): a filename-prefixed record outside the scope is refused before any write; in scope it proceeds', async () => {
			// The audit's reproduction: the same record, refused when spelled as
			// files_data[].section_id, WRITTEN when spelled as a filename prefix —
			// the gate never saw the id the handler resolved. Now the handler
			// proves every record it binds through the save door's rule.
			const request = {
				section_tipo: SB_GRANTED_SECTION,
				tipo: SB_MEDIA_COMPONENT,
				key_dir: 'zzsb_enumerate',
				tool_config: {
					import_mode: 'section_resource',
					import_file_name_mode: 'enumerate',
					ddo_map: [
						{
							role: 'target_component',
							tipo: SB_MEDIA_COMPONENT,
							section_tipo: SB_GRANTED_SECTION,
						},
					],
				},
				files_data: [{ name: `${recordOfB}-photo.jpg` }],
			};
			// The declarative gate PASSES this for A (the pair is granted, no id is
			// spelled): the refusal below is the handler's, and only the handler's.
			const importFiles = await spec('tool_import_files', 'import_files');
			expect(await assertActionPermission(importFiles, request, A)).toEqual({ ok: true });

			const asA = await runImport(request, A);
			expect(asA.imported).toBe(0);
			expect(asA.errors).toHaveLength(1);
			expect(asA.errors[0]).toContain(
				`${SB_GRANTED_SECTION}/${recordOfB} is outside the caller's scope`,
			);
			expect(await mediaOfRecordOfB()).toBeNull();

			// Positive control: B reaches the record, so the SAME request passes the
			// scope and fails LATER, at the staging lookup (nothing was staged) —
			// which is the proof the refusal above was the scope, not the request.
			const asB = await runImport(request, B);
			expect(asB.imported).toBe(0);
			expect(asB.errors).toHaveLength(1);
			expect(asB.errors[0]).toContain('Staged upload not found');
			expect(asB.errors[0]).not.toContain('outside the caller');
			expect(await mediaOfRecordOfB()).toBeNull();
		});

		test('the RECORD half IN-HANDLER (enumerate RACE): a prefix id a concurrent create takes OUT of scope is NOT born in this run — refused by the scope probe', async () => {
			// Existence read → null, then the conflict-tolerant create: between the
			// two a concurrent writer took the id, the insert was a no-op, and the
			// record is B's. "Born in this run" must be the create's OWN answer (the
			// row's xmin — bornInCurrentTransaction), never the stale existence read:
			// otherwise the scope probe is skipped and the component door asks only
			// the section-target (create) rule, for a record A cannot reach.
			const sectionId = await freeTest3Id();
			try {
				const { blocked, result } = await enumerateImportRacingCreate(
					sectionId,
					config.features.defaultProject,
				);
				expect(blocked).toBe(true); // anti-vacuity: A really waited on B's create
				expect(await isRecordInScope(SB_GRANTED_SECTION, sectionId, A)).toBe(false);
				expect(result.imported).toBe(0);
				expect(result.errors).toHaveLength(1);
				expect(result.errors[0]).toContain(
					`${SB_GRANTED_SECTION}/${sectionId} is outside the caller's scope`,
				);
				// B's record stands, and B's (no import ran into it)
				const stored = await readMatrixRecord('matrix_test', SB_GRANTED_SECTION, sectionId);
				expect(stored).not.toBeNull();
				expect(stored?.columns.media ?? null).toBeNull();
			} finally {
				await deleteSectionRecord(SB_GRANTED_SECTION, sectionId, -1).catch(() => undefined);
			}
		}, 30000);

		test('the RECORD half IN-HANDLER (enumerate RACE, served twins): a raced id IN scope passes the probe; a free id A really creates is born in this run', async () => {
			// In-scope twin: the same interleave, B's record stamped into A's project
			// — the probe runs and PASSES; the run fails later, at the staging lookup.
			const racedId = await freeTest3Id();
			try {
				const { blocked, result } = await enumerateImportRacingCreate(racedId, sb.projectOfA);
				expect(blocked).toBe(true);
				expect(await isRecordInScope(SB_GRANTED_SECTION, racedId, A)).toBe(true);
				expect(result.errors).toHaveLength(1);
				expect(result.errors[0]).toContain('Staged upload not found');
				expect(result.errors[0]).not.toContain('outside the caller');
			} finally {
				await deleteSectionRecord(SB_GRANTED_SECTION, racedId, -1).catch(() => undefined);
			}
			// Born twin: no race — A's insert creates the row, so it is admitted
			// without the probe (the create rule), although test3 stamps no birth
			// project and the new row is outside A's projects scope.
			const bornId = await freeTest3Id();
			try {
				const result = await runImport(enumerateRequest(bornId, 'zzsb_enumerate_born'), A);
				const stored = await readMatrixRecord('matrix_test', SB_GRANTED_SECTION, bornId);
				expect(stored).not.toBeNull(); // A's create landed
				expect(await isRecordInScope(SB_GRANTED_SECTION, bornId, A)).toBe(false);
				expect(result.errors).toHaveLength(1);
				expect(result.errors[0]).toContain('Staged upload not found');
				expect(result.errors[0]).not.toContain('outside the caller');
			} finally {
				await deleteSectionRecord(SB_GRANTED_SECTION, bornId, -1).catch(() => undefined);
			}
		}, 30000);

		test('the RECORD half IN-HANDLER (match_freename): a matcher hit outside the scope is refused; the matcher itself still finds it', async () => {
			// The free-name matcher searches ACROSS projects (PHP skip_projects_filter
			// parity), so it HANDS the handler a record the caller cannot reach; the
			// handler must refuse the hit, not trust the matcher.
			const stored = await saveComponentData({
				componentTipo: SB_GRANTED_COMPONENT,
				sectionTipo: SB_GRANTED_SECTION,
				sectionId: recordOfB,
				lang: 'lg-eng',
				changedData: [
					{ action: 'set_data', id: null, value: [{ value: MATCH_FILENAME, lang: 'lg-eng' }] },
				],
				userId: sb.userB,
			});
			expect(stored.ok).toBe(true);
			const matcher = await spec('tool_import_files', 'get_media_section_match');
			const hits = await matcher.handler(
				contextOf(
					{
						full_name: MATCH_FILENAME,
						target_filename: { section_tipo: SB_GRANTED_SECTION, tipo: SB_GRANTED_COMPONENT },
					},
					A,
				),
			);
			expect(hits.data).toEqual([recordOfB]); // exposed to A by the matcher…

			const request = {
				section_tipo: SB_GRANTED_SECTION,
				tipo: SB_MEDIA_COMPONENT,
				key_dir: 'zzsb_match',
				tool_config: {
					import_mode: 'section_resource',
					import_file_name_mode: 'match_freename',
					ddo_map: [
						{
							role: 'target_component',
							tipo: SB_MEDIA_COMPONENT,
							section_tipo: SB_GRANTED_SECTION,
						},
						{
							role: 'target_filename',
							tipo: SB_GRANTED_COMPONENT,
							section_tipo: SB_GRANTED_SECTION,
						},
					],
				},
				files_data: [{ name: MATCH_FILENAME }],
			};
			const asA = await runImport(request, A); // …and refused by the handler.
			expect(asA.imported).toBe(0);
			expect(asA.errors).toHaveLength(1);
			expect(asA.errors[0]).toContain(
				`${SB_GRANTED_SECTION}/${recordOfB} is outside the caller's scope`,
			);
			expect(await mediaOfRecordOfB()).toBeNull();
			const asB = await runImport(request, B);
			expect(asB.errors).toHaveLength(1);
			expect(asB.errors[0]).toContain('Staged upload not found');
			expect(asB.errors[0]).not.toContain('outside the caller');
		});

		test('the RECORD half IN-HANDLER (portal chain, import_mode section): the resolved caller record is proven BEFORE the portal link is written', async () => {
			// In 'section' mode the handler writes the portal FIRST (add_new_element
			// on the resolved record creates the media record and links it), then
			// the role writes, then the media. The resolved record must be proven
			// before that first write — the role-write and ingest checks come too
			// late for it.
			const { SB_HOP_COMPONENT } = await import('../helpers/scope_binding_fixture.ts');
			const request = {
				section_tipo: SB_GRANTED_SECTION,
				tipo: SB_MEDIA_COMPONENT,
				key_dir: 'zzsb_portal',
				tool_config: {
					import_mode: 'section',
					import_file_name_mode: 'enumerate',
					ddo_map: [
						{
							role: 'target_component',
							tipo: SB_MEDIA_COMPONENT,
							section_tipo: SB_GRANTED_SECTION,
						},
						{
							role: 'component_option',
							tipo: SB_HOP_COMPONENT,
							section_tipo: 'self',
							target_section_tipo: SB_GRANTED_SECTION,
						},
					],
				},
				files_data: [{ name: `${recordOfB}-photo.jpg`, component_option: SB_HOP_COMPONENT }],
			};
			const importFiles = await spec('tool_import_files', 'import_files');
			expect(await assertActionPermission(importFiles, request, A)).toEqual({ ok: true });
			const linked = async (): Promise<unknown[]> => {
				const record = await readMatrixRecord('matrix_test', SB_GRANTED_SECTION, recordOfB);
				const relation = (record?.columns.relation ?? {}) as Record<string, unknown[]>;
				return relation[SB_HOP_COMPONENT] ?? [];
			};
			expect(await linked()).toEqual([]);
			const asA = await runImport(request, A);
			expect(asA.imported).toBe(0);
			expect(asA.errors[0]).toContain(
				`${SB_GRANTED_SECTION}/${recordOfB} is outside the caller's scope`,
			);
			expect(await linked()).toEqual([]); // no portal write, no media record created
			// Positive control: B passes the scope, the portal link is WRITTEN (a
			// media record is created and linked into B's record), and the run
			// fails only at the staging lookup. The created record is swept.
			const asB = await runImport(request, B);
			expect(asB.errors[0]).toContain('Staged upload not found');
			const links = (await linked()) as { section_tipo: string; section_id: number }[];
			expect(links).toHaveLength(1);
			const created = mustGet(links[0], 'portal-created record');
			expect(created.section_tipo).toBe(SB_GRANTED_SECTION);
			await deleteSectionRecord(SB_GRANTED_SECTION, Number(created.section_id), -1);
		});

		test('the RECORD half IN-HANDLER (role writes): setComponentsData refuses a third-section ddo and an out-of-scope destination; the owner writes', async () => {
			const { setComponentsData } = await import('../../tools/tool_import_files/server/index.ts');
			const roleWrite = (principal: Principal, ddoSection: string): Promise<void> =>
				setComponentsData({
					ddoMap: [{ role: 'input_component', tipo: SB_INPUT_COMPONENT, section_tipo: ddoSection }],
					sectionTipo: 'test2', // the caller section differs → destination = the target record
					sectionId: 0,
					targetSectionTipo: SB_GRANTED_SECTION,
					targetSectionId: recordOfB,
					currentFileName: 'x.jpg',
					mediaFilePath: null,
					targetComponentModel: '',
					componentsTempData: [
						{
							tipo: SB_INPUT_COMPONENT,
							section_tipo: ddoSection,
							value: [{ value: `written by ${principal.userId}` }],
						},
					],
					userId: principal.userId,
					principal,
					dataLang: 'lg-eng',
				});
			const before = await readMatrixRecord('matrix_test', SB_GRANTED_SECTION, recordOfB);
			// A ddo in a THIRD section (neither caller nor target): its destination
			// id would address a record of test65 that merely shares B's number.
			const thirdSection = await refusalOf(roleWrite(B, SB_DENIED_SECTION));
			expect(thirdSection.code).toBe('request.invalid_options');
			expect(thirdSection.message).toContain('neither the caller section');
			// A ddo in the target section, destination = B's record, actor A.
			const outOfScope = await refusalOf(roleWrite(A, SB_GRANTED_SECTION));
			expect(outOfScope.code).toBe('perm.out_of_scope');
			const after = await readMatrixRecord('matrix_test', SB_GRANTED_SECTION, recordOfB);
			expect(after?.columns.string).toEqual(before?.columns.string);
			// The owner of the scope writes.
			await roleWrite(B, SB_GRANTED_SECTION);
			const written = await readMatrixRecord('matrix_test', SB_GRANTED_SECTION, recordOfB);
			const items = (written?.columns.string as Record<string, { value?: string }[]>)[
				SB_INPUT_COMPONENT
			];
			expect(items?.map((item) => item.value)).toEqual([`written by ${sb.userB}`]);
		});

		test('through the dispatcher with background_running:true, the refusal PRECEDES the fork', async () => {
			const { dispatchToolRequest } = await import('../../src/core/tools/dispatch.ts');
			const { listBackgroundJobs } = await import('../../src/core/tools/background.ts');
			const error = await refusalOf(
				dispatchToolRequest(
					A,
					sb.userA,
					{ model: 'tool_update_cache', action: 'update_cache' },
					{
						background_running: true,
						section_tipo: SB_GRANTED_SECTION,
						sqo: { section_tipo: [SB_DENIED_SECTION] },
						components_selection: [{ tipo: SB_GRANTED_COMPONENT }],
					},
				),
			);
			expect(error.publicMessage).toContain('insufficient permissions on target');
			// THE assertion: it THREW — no job handle, nothing forked, no row re-saved.
			expect(error.extend).toBeUndefined();
			expect(listBackgroundJobs('tool_update_cache', sb.userA, true)).toHaveLength(0);
		}, 20000);
	},
);
