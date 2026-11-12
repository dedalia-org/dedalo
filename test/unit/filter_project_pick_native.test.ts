/**
 * THE PROJECT PICK IS A MEMBERSHIP QUESTION — owner decision 2026-10-21 (D2),
 * `relations/save.ts` refuseByPickerConstraint gate 2b.
 *
 * WHAT IS GATED. A `component_filter` / `component_filter_master` locator is a
 * PROJECT ASSIGNMENT (dd153): it decides who sees a record, or which records a
 * user sees. The option set the client renders is the actor's OWN projects
 * (filter_projects.ts getFilterDatalist — every project for a global admin, the
 * dd170 membership for anyone else), but before D2 the save door asked nothing
 * about it: a forged or stale request could assign a record to a project the
 * actor is not a member of — handing the record to that project's members, or
 * (on dd170) granting a user a project the editor cannot see.
 *
 * WHAT IS NOT GATED. A locator the component ALREADY holds is a re-persist,
 * never re-judged (gate 0): a colleague's project on a shared record survives
 * every save this actor makes. Global admins are exempt — their option set is
 * the whole catalog.
 *
 * Every case asserts an OUTCOME — the wire status/code AND the stored bytes AND
 * the Time Machine row count — and each refusal sits beside its control (same
 * door, same component, one fact different), so nothing here is green on a
 * degenerate answer.
 *
 * SITUATION (built here, torn down in afterAll; the generic `test` TLD only):
 * three scratch dd153 projects, one scratch test3 host record, two throwaway
 * identities (a project-scoped filter editor and a non-superuser global admin),
 * all created through the engine's own create door and deleted by id.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import { updateMatrixKeyData } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import {
	type RelationInsertBatchResult,
	type RelationInsertContext,
	validateRelationInserts,
} from '../../src/core/relations/save.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import {
	clearPermissionsCache,
	clearPrincipalCache,
	clearUserProjectsCache,
	type Principal,
	resolvePrincipal,
} from '../../src/core/security/permissions.ts';
import { runWithRequestContext } from '../../src/core/security/request_context.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

registerSessionCleanup();

const HOST = 'test3';
/** test3's own component_filter (the playground's projects field). */
const HOST_FILTER = 'test101';
const PROJECTS = 'dd153';
const USERS = 'dd128';
/** dd128's component_filter_master — a USER's project membership. */
const USER_PROJECTS = 'dd170';

interface Identity {
	userId: number;
	profileId: number;
	principal: Principal;
}

let hostId = 0;
/** The editor is a member of these two… */
let memberProject = 0;
let memberProject2 = 0;
/** …and not of this one. */
let foreignProject = 0;
let editor: Identity | undefined;
let globalAdmin: Identity | undefined;

const flag = (tipo: string, yes: boolean) => [
	{
		id: 1,
		type: 'dd151',
		section_tipo: 'dd64',
		section_id: yes ? 1 : 2,
		from_component_tipo: tipo,
	},
];

const filterLocator = (projectId: number, id: number, from = HOST_FILTER) => ({
	id,
	type: 'dd675',
	section_tipo: PROJECTS,
	section_id: projectId,
	from_component_tipo: from,
});

async function buildIdentity(options: {
	projects: number[];
	globalAdmin: boolean;
}): Promise<Identity> {
	const profileId = await createSectionRecord('dd234', -1);
	const userId = await createSectionRecord(USERS, -1);
	await updateMatrixKeyData('matrix_users', USERS, userId, 'relation', 'dd1725', [
		{
			id: 1,
			type: 'dd151',
			section_tipo: 'dd234',
			section_id: profileId,
			from_component_tipo: 'dd1725',
		},
	]);
	await updateMatrixKeyData(
		'matrix_users',
		USERS,
		userId,
		'relation',
		'dd244',
		flag('dd244', options.globalAdmin),
	);
	await updateMatrixKeyData(
		'matrix_users',
		USERS,
		userId,
		'relation',
		'dd515',
		flag('dd515', false),
	);
	await updateMatrixKeyData(
		'matrix_users',
		USERS,
		userId,
		'relation',
		USER_PROJECTS,
		options.projects.map((projectId, index) => ({
			id: index + 1,
			type: 'dd151',
			section_tipo: PROJECTS,
			section_id: projectId,
			from_component_tipo: USER_PROJECTS,
		})),
	);
	// Level 2 on the filter component only — never on dd153: the ordinary
	// non-admin shape (the datalist is built from their OWN projects).
	await updateMatrixKeyData('matrix_profiles', 'dd234', profileId, 'misc', 'dd774', [
		{ id: 1, tipo: HOST_FILTER, section_tipo: HOST, value: 2 },
	]);
	clearPrincipalCache(userId);
	clearUserProjectsCache(userId);
	clearPermissionsCache(userId);
	return { userId, profileId, principal: await resolvePrincipal(userId) };
}

async function deleteRecord(table: string, sectionTipo: string, sectionId: number): Promise<void> {
	if (sectionId === 0) return;
	await sql.unsafe(`DELETE FROM "${table}" WHERE section_tipo = $1 AND section_id = $2`, [
		sectionTipo,
		sectionId,
	]);
	await sql.unsafe('DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2', [
		sectionTipo,
		sectionId,
	]);
	await sql.unsafe(
		`DELETE FROM matrix_activity
		 WHERE section_tipo = 'dd542'
		   AND misc->'dd551'->0->'value'->>'section_id' = $1
		   AND misc->'dd551'->0->'value'->>'section_tipo' = $2`,
		[String(sectionId), sectionTipo],
	);
}

/** Set the host's filter verbatim (a colleague's earlier assignments). */
async function seedHostFilter(projectIds: number[]): Promise<void> {
	await updateMatrixKeyData(
		'matrix_test',
		HOST,
		hostId,
		'relation',
		HOST_FILTER,
		projectIds.map((projectId, index) => filterLocator(projectId, index + 1)),
	);
}

/** What the host record holds for the filter, straight from jsonb. */
async function storedProjects(): Promise<number[]> {
	const rows = (await sql.unsafe(
		'SELECT relation->$1 AS items FROM matrix_test WHERE section_tipo = $2 AND section_id = $3',
		[HOST_FILTER, HOST, hostId],
	)) as { items: { section_id: unknown }[] | null }[];
	return (rows[0]?.items ?? []).map((item) => Number(item.section_id));
}

/** Time Machine rows written for the host's filter component. */
async function tmRows(): Promise<number> {
	const rows = (await sql.unsafe(
		'SELECT count(*)::int AS n FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3',
		[HOST, hostId, HOST_FILTER],
	)) as { n: number }[];
	return Number(rows[0]?.n ?? 0);
}

/** One save through the REAL dispatch door, as `as`. */
async function save(
	as: Identity,
	changedData: { action: string; id: null; value: unknown }[],
): Promise<{ status: number; code: string | null; constraint: unknown }> {
	const token = createSession(as.userId, `project_pick_${as.userId}`, false);
	const session = getSession(token);
	const dispatched = await dispatchRqo(
		{
			action: 'save',
			dd_api: 'dd_core_api',
			prevent_lock: true,
			source: {
				typo: 'source',
				type: 'component',
				model: 'component_filter',
				tipo: HOST_FILTER,
				section_tipo: HOST,
				section_id: String(hostId),
				mode: 'edit',
				lang: 'lg-nolan',
				action: null,
			},
			data: {
				section_id: String(hostId),
				section_tipo: HOST,
				tipo: HOST_FILTER,
				lang: 'lg-nolan',
				from_component_tipo: HOST_FILTER,
				changed_data: changedData,
			},
		} as never,
		{
			requestId: 'filter_project_pick_gate',
			clientIp: '127.0.0.1',
			session,
			csrfCandidate: session?.csrfToken ?? null,
			principal: as.principal,
		} as never,
	);
	const body = dispatched.body as { error?: { code?: string; details?: { constraint?: unknown } } };
	return {
		status: dispatched.status,
		code: body.error?.code ?? null,
		constraint: body.error?.details?.constraint ?? null,
	};
}

const pick = (projectId: number) => ({
	action: 'insert',
	id: null,
	value: { section_tipo: PROJECTS, section_id: projectId },
});

const codes = (result: RelationInsertBatchResult) =>
	result.outcomes.map((outcome) => [outcome.status, outcome.code ?? null]);

const doorContext = (
	model: 'component_filter' | 'component_filter_master',
	principal?: Principal,
): RelationInsertContext => ({
	componentTipo: model === 'component_filter' ? HOST_FILTER : USER_PROJECTS,
	model,
	hostSectionTipo: model === 'component_filter' ? HOST : USERS,
	hostSectionId: model === 'component_filter' ? hostId : (editor?.userId ?? 0),
	translatable: false,
	lang: 'lg-nolan',
	existingItems: [],
	...(principal !== undefined ? { principal } : {}),
});

async function sweep(): Promise<void> {
	await deleteRecord('matrix_test', HOST, hostId);
	for (const identity of [editor, globalAdmin]) {
		if (identity === undefined) continue;
		await deleteRecord('matrix_users', USERS, identity.userId);
		await deleteRecord('matrix_profiles', 'dd234', identity.profileId);
		clearPrincipalCache(identity.userId);
		clearUserProjectsCache(identity.userId);
		clearPermissionsCache(identity.userId);
	}
	for (const projectId of [memberProject, memberProject2, foreignProject]) {
		await deleteRecord('matrix_projects', PROJECTS, projectId);
	}
	await clearOntologyDerivedCaches();
}

beforeAll(async () => {
	if (!DB_READY) return;
	await assertTestDatabase('filter_project_pick_native');
	memberProject = await createSectionRecord(PROJECTS, -1);
	memberProject2 = await createSectionRecord(PROJECTS, -1);
	foreignProject = await createSectionRecord(PROJECTS, -1);
	hostId = await createSectionRecord(HOST, -1);
	editor = await buildIdentity({ projects: [memberProject, memberProject2], globalAdmin: false });
	globalAdmin = await buildIdentity({ projects: [], globalAdmin: true });
	// The situation's own preconditions — a vacuous identity makes every case
	// below meaningless, so they are asserted before any case runs.
	if (editor.principal.isGlobalAdmin || !globalAdmin.principal.isGlobalAdmin) {
		throw new Error('filter_project_pick: the identities did not resolve to the intended roles');
	}
	if (editor.userId === -1 || globalAdmin.userId === -1) {
		throw new Error('filter_project_pick: a scratch identity resolved to the superuser');
	}
}, 120000);

afterAll(async () => {
	if (!DB_READY) return;
	await sweep();
});

describe.if(DB_READY)('dd153 project pick — the save door (as a project-scoped editor)', () => {
	test('a NEW project the editor is not a member of is REFUSED: nothing persisted, no TM row', async () => {
		await seedHostFilter([memberProject]);
		const tmBefore = await tmRows();
		const answer = await save(editor as Identity, [pick(foreignProject)]);
		expect(answer.status).toBe(400);
		expect(answer.code).toBe('relation.insert_refused');
		expect(answer.constraint).toBe('project_not_member');
		expect(await storedProjects()).toEqual([memberProject]);
		expect(await tmRows()).toBe(tmBefore);
	});

	test('CONTROL: a NEW project the editor IS a member of persists, with its TM row', async () => {
		await seedHostFilter([memberProject]);
		const tmBefore = await tmRows();
		const answer = await save(editor as Identity, [pick(memberProject2)]);
		expect(answer).toEqual({ status: 200, code: null, constraint: null });
		expect(await storedProjects()).toEqual([memberProject, memberProject2]);
		// + its save-before row: the filter is seeded RAW, with no history
		// (re-pinned 2026-11-12, T1-21).
		expect(await tmRows()).toBe(tmBefore + 2);
	});

	test('a colleague’s pre-existing foreign project SURVIVES the editor’s add (insert door)', async () => {
		await seedHostFilter([memberProject, foreignProject]);
		const answer = await save(editor as Identity, [pick(memberProject2)]);
		expect(answer.status).toBe(200);
		expect(await storedProjects()).toEqual([memberProject, foreignProject, memberProject2]);
	});

	test('a set_data REPLAY keeps the stored foreign project (re-persist, never re-judged)', async () => {
		await seedHostFilter([memberProject, foreignProject]);
		const answer = await save(editor as Identity, [
			{
				action: 'set_data',
				id: null,
				value: [
					{ section_tipo: PROJECTS, section_id: memberProject },
					{ section_tipo: PROJECTS, section_id: foreignProject },
					{ section_tipo: PROJECTS, section_id: memberProject2 },
				],
			},
		]);
		expect(answer.status).toBe(200);
		expect(await storedProjects()).toEqual([memberProject, foreignProject, memberProject2]);
	});

	test('…but a set_data that INTRODUCES a foreign project is refused whole, stored bytes untouched', async () => {
		await seedHostFilter([memberProject]);
		const tmBefore = await tmRows();
		const answer = await save(editor as Identity, [
			{
				action: 'set_data',
				id: null,
				value: [
					{ section_tipo: PROJECTS, section_id: memberProject },
					{ section_tipo: PROJECTS, section_id: foreignProject },
				],
			},
		]);
		expect(answer.status).toBe(400);
		expect(answer.constraint).toBe('project_not_member');
		expect(await storedProjects()).toEqual([memberProject]);
		expect(await tmRows()).toBe(tmBefore);
	});
});

describe.if(DB_READY)('dd153 project pick — the global-admin exemption', () => {
	test('a global admin (not the superuser) assigns ANY project', async () => {
		await seedHostFilter([memberProject]);
		const answer = await save(globalAdmin as Identity, [pick(foreignProject)]);
		expect(answer).toEqual({ status: 200, code: null, constraint: null });
		expect(await storedProjects()).toEqual([memberProject, foreignProject]);
	});
});

describe.if(DB_READY)(
	'dd153 project pick — a credless in-repo save is judged as its ATTRIBUTED user',
	() => {
		/**
		 * The four doors save_component sends a relation value through — insert,
		 * set_data (replace), update, append import — each called with NO
		 * principal and NO request scope, attributed to `userId`. Each adds
		 * `projectId` to a host holding [memberProject]; `expected` is the stored
		 * list on success.
		 */
		const doors = [
			{
				door: 'insert',
				request: (projectId: number) => ({ changedData: [pick(projectId)] }),
				expected: (projectId: number) => [memberProject, projectId],
			},
			{
				door: 'set_data',
				request: (projectId: number) => ({
					changedData: [
						{
							action: 'set_data',
							id: null,
							value: [
								{ section_tipo: PROJECTS, section_id: memberProject },
								{ section_tipo: PROJECTS, section_id: projectId },
							],
						},
					],
				}),
				expected: (projectId: number) => [memberProject, projectId],
			},
			{
				door: 'update',
				// Rewrites the stored item (id 1) to name another project.
				request: (projectId: number) => ({
					changedData: [
						{
							action: 'update',
							id: 1,
							value: { id: 1, section_tipo: PROJECTS, section_id: projectId },
						},
					],
				}),
				expected: (projectId: number) => [projectId],
			},
			{
				door: 'append import',
				request: (projectId: number) => ({
					changedData: [
						{
							action: 'set_data',
							id: null,
							value: [{ section_tipo: PROJECTS, section_id: projectId }],
						},
					],
					appendImport: true as const,
				}),
				expected: (projectId: number) => [memberProject, projectId],
			},
		];

		const credlessSave = async (
			userId: number,
			request: { changedData: unknown[]; appendImport?: true },
		): Promise<string | null> => {
			try {
				const saved = await saveComponentData({
					componentTipo: HOST_FILTER,
					sectionTipo: HOST,
					sectionId: hostId,
					lang: 'lg-nolan',
					changedData: request.changedData as never,
					userId,
					...(request.appendImport === true ? { appendImport: true as const } : {}),
				});
				return saved.ok ? null : `not ok: ${String(saved.message)}`;
			} catch (error) {
				return String((error as { code?: unknown }).code ?? error);
			}
		};

		for (const { door, request, expected } of doors) {
			test(`${door}: attributed to the non-admin editor, a foreign project is refused — nothing stored, no TM row`, async () => {
				await seedHostFilter([memberProject]);
				const tmBefore = await tmRows();
				expect(await credlessSave((editor as Identity).userId, request(foreignProject))).toBe(
					'relation.insert_refused',
				);
				expect(await storedProjects()).toEqual([memberProject]);
				expect(await tmRows()).toBe(tmBefore);
			});

			test(`${door}: CONTROL — attributed to the editor, their own project persists`, async () => {
				await seedHostFilter([memberProject]);
				expect(await credlessSave((editor as Identity).userId, request(memberProject2))).toBeNull();
				expect(await storedProjects()).toEqual(expected(memberProject2));
			});

			test(`${door}: attributed to the superuser (the system doors), any project persists`, async () => {
				await seedHostFilter([memberProject]);
				expect(await credlessSave(-1, request(foreignProject))).toBeNull();
				expect(await storedProjects()).toEqual(expected(foreignProject));
			});
		}
	},
);

describe.if(DB_READY)('dd153 project pick — the insert door itself', () => {
	test('component_filter_master (a USER’s projects) is gated by the same membership', async () => {
		const actor = (editor as Identity).principal;
		const refused = await validateRelationInserts(
			[{ section_tipo: PROJECTS, section_id: foreignProject }],
			doorContext('component_filter_master', actor),
		);
		expect(codes(refused)).toEqual([['refused', 'project_not_member']]);
		const accepted = await validateRelationInserts(
			[{ section_tipo: PROJECTS, section_id: memberProject }],
			doorContext('component_filter_master', actor),
		);
		expect(codes(accepted)).toEqual([['accepted', null]]);
	});

	test('FAIL-CLOSED: no identity at all (nothing threaded, no scope, no attributed user) is a refusal', async () => {
		const noActor = await validateRelationInserts(
			[{ section_tipo: PROJECTS, section_id: memberProject }],
			doorContext('component_filter'),
		);
		expect(codes(noActor)).toEqual([['refused', 'project_not_member']]);
		expect(noActor.outcomes[0]?.reason).toContain('fail-closed');
		// The ALS backstop identifies the actor when nothing is threaded.
		const ambient = await runWithRequestContext(
			{
				principal: (globalAdmin as Identity).principal,
				session: null,
				requestId: 'filter_project_pick_gate',
				clientIp: '127.0.0.1',
			},
			() =>
				validateRelationInserts(
					[{ section_tipo: PROJECTS, section_id: foreignProject }],
					doorContext('component_filter'),
				),
		);
		expect(codes(ambient)).toEqual([['accepted', null]]);
	});

	test('IDENTITY PRECEDENCE: threaded principal > ambient > attributed user (each pair judged both ways)', async () => {
		const editorIdentity = editor as Identity;
		const adminIdentity = globalAdmin as Identity;
		const foreignPick = [{ section_tipo: PROJECTS, section_id: foreignProject }];
		const attributedTo = (userId: number, principal?: Principal): RelationInsertContext => ({
			...doorContext('component_filter', principal),
			attributedUserId: userId,
		});
		const asAmbient = <T>(principal: Principal, run: () => Promise<T>): Promise<T> =>
			runWithRequestContext(
				{ principal, session: null, requestId: 'filter_project_pick_gate', clientIp: '127.0.0.1' },
				run,
			);
		// Threaded vs attributed: the threaded principal decides, never the attribution.
		expect(
			codes(
				await validateRelationInserts(
					foreignPick,
					attributedTo(adminIdentity.userId, editorIdentity.principal),
				),
			),
		).toEqual([['refused', 'project_not_member']]);
		expect(
			codes(
				await validateRelationInserts(
					foreignPick,
					attributedTo(editorIdentity.userId, adminIdentity.principal),
				),
			),
		).toEqual([['accepted', null]]);
		// Ambient vs attributed: the request scope decides, never the attribution.
		expect(
			codes(
				await asAmbient(editorIdentity.principal, () =>
					validateRelationInserts(foreignPick, attributedTo(adminIdentity.userId)),
				),
			),
		).toEqual([['refused', 'project_not_member']]);
		expect(
			codes(
				await asAmbient(adminIdentity.principal, () =>
					validateRelationInserts(foreignPick, attributedTo(editorIdentity.userId)),
				),
			),
		).toEqual([['accepted', null]]);
	});

	test('a membership read live: a project granted after the first pick is accepted on the next', async () => {
		const actor = (editor as Identity).principal;
		const before = await validateRelationInserts(
			[{ section_tipo: PROJECTS, section_id: foreignProject }],
			doorContext('component_filter', actor),
		);
		expect(codes(before)).toEqual([['refused', 'project_not_member']]);
		const editorId = (editor as Identity).userId;
		await updateMatrixKeyData('matrix_users', USERS, editorId, 'relation', USER_PROJECTS, [
			filterLocator(memberProject, 1, USER_PROJECTS),
			filterLocator(memberProject2, 2, USER_PROJECTS),
			filterLocator(foreignProject, 3, USER_PROJECTS),
		]);
		clearUserProjectsCache(editorId);
		try {
			const after = await validateRelationInserts(
				[{ section_tipo: PROJECTS, section_id: foreignProject }],
				doorContext('component_filter', actor),
			);
			expect(codes(after)).toEqual([['accepted', null]]);
		} finally {
			await updateMatrixKeyData('matrix_users', USERS, editorId, 'relation', USER_PROJECTS, [
				filterLocator(memberProject, 1, USER_PROJECTS),
				filterLocator(memberProject2, 2, USER_PROJECTS),
			]);
			clearUserProjectsCache(editorId);
		}
	});
});
