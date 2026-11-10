/**
 * T0-2 — THE CREATE GATE (O03 / O05). `add_new_element` creates a record in a
 * CALLER-NAMED target section; until this gate the save door authorized only
 * the HOST (the portal component ≥2 + the host record scope) and never asked
 * whether the caller may CREATE in the target. PHP refused it
 * (component_common::update_data_value 'add_new_element' →
 * security::get_section_new_permissions(target) < 2: the first button_new of
 * the target, virtual/exclude-aware; NO button_new → null < 2 → refused,
 * superuser included).
 *
 * THE PREDICATE under test — "may create in S" (owner decisions D1/D4,
 * 2026-11-10):
 *   - the section level getSectionPermissions(S) ≥ 2 (consultation-capped), AND
 *   - the FIRST button_new of S (section/buttons.ts sectionButtonRows) ≥ 2;
 *   - no button_new → refused, the superuser included.
 *   Refusal: `perm.denied` 403.
 * D2: an add_new_element target outside the portal's target_sections
 * (request_config/build.ts getElementTargetSectionTipos) → `request.invalid_source`
 * 400 — on a target the caller MAY create in (test65): a target the caller may
 * NOT create in answers the permission refusal (the cases below pin that order).
 * D4: the same predicate gates `duplicate` (core + MCP), the tree's `add_child`,
 * the MCP create / find_or_create, and the hierarchy root term minted in an
 * operator-DECLARED (steerable) section — review finding F2.
 *
 * D4 / D3 REVISED (owner, 2026-11-10): core `create` and a TOOL-driven
 * add_new_element ask the SECTION level only (write_door.ts
 * authorizeSectionCreate — PHP dd_core_api::create parity). Their outcome is the
 * MIRROR contrast: refused below section 2, CREATED with the New button withheld
 * (SECTION_CREATE_DOOR_PROBES). The REGRESSION PINS drive core create into the
 * feature-owned sections that ship no button_new (rsc326 notes, rsc832 TM notes,
 * rsc377 index notes, rsc425 references, rsc1379 dataframe frames — through the
 * test6453 slot's request_config, as component_dataframe create_new_section does)
 * as the superuser and as a section-only persona — RED under the first cut
 * (core create on the New-button predicate), green after the revision.
 *
 * EVERY REFUSAL asserts: the code and the HTTP status, the target section's
 * row set unchanged, no NEW activity row naming the target, and (for the
 * relation doors) the host record's relation column byte-identical. Every
 * door has a GRANTED CONTROL (the anti-vacuity column: a door that refuses
 * everything is red there).
 *
 * The children door's dd128 case is a REGRESSION PIN, not a create-gate case:
 * its structural check (assertChildSection — dd128 carries no
 * component_relation_parent) already refuses it with request.invalid_data.
 *
 * SITUATION: the shared authz door fixture's PORTAL_EDITOR / CHILD_EDITOR /
 * TREE_EDITOR (test/helpers/authz_door_fixture.ts — grants asserted through the real
 * resolver first) on the generic `test` TLD playground; hosts are
 * engine-built test3 / test65 records in project P (swept by the fixture); every row a
 * door creates (the HEAD-red cases create) is swept with its TM and activity
 * rows, and zero residue is asserted at the end. No ontology node is written.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { duplicateRecord, findOrCreate } from '../../src/ai/mcp/tools/fields_write.ts';
import { createRecord } from '../../src/ai/mcp/tools/records_write.ts';
import type { ApiRequestContext } from '../../src/core/api/dispatch.ts';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { deleteMatrixRecord } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { isDedaloError } from '../../src/core/errors/dedalo_error.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import { ensureHierarchy } from '../../src/core/ontology/hierarchy_state.ts';
import { deleteOntologyByTld } from '../../src/core/ontology/ontology_delete.ts';
import { getMatrixTableFromTipo, getSectionRealTipo } from '../../src/core/ontology/resolver.ts';
import { getParentTipo } from '../../src/core/relations/children.ts';
import { getElementTargetSectionTipos } from '../../src/core/relations/request_config/build.ts';
import {
	type ToolAddNewElementAccess,
	toolAddNewElementAccess,
} from '../../src/core/relations/save.ts';
import { sectionButtonRows } from '../../src/core/section/buttons.ts';
import { deleteSectionRecord } from '../../src/core/section/record/delete_record.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import { type Principal, resolvePrincipal } from '../../src/core/security/permissions.ts';
import { createSession, getSession, type Session } from '../../src/core/security/session_store.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import {
	AUTHZ_CHILDREN,
	AUTHZ_FEATURE_SECTIONS,
	AUTHZ_NO_BUTTON_SECTION,
	AUTHZ_OFF_TARGET_CHILDREN,
	AUTHZ_OFF_TARGET_FILTER,
	AUTHZ_OFF_TARGET_PARENT,
	AUTHZ_OFF_TARGET_SECTION,
	AUTHZ_PARENT,
	AUTHZ_PORTAL,
	AUTHZ_PROJECT_P,
	AUTHZ_READ_BUTTON_FILTER,
	AUTHZ_READ_BUTTON_SECTION,
	AUTHZ_READ_BUTTON_TEXT,
	AUTHZ_SECTION,
	type AuthzIdentities,
	assertAuthzDoorContrast,
	createDoorRecord,
	installAuthzDoorFixture,
	removeAuthzDoorFixture,
	resolveAuthzIdentities,
} from '../helpers/authz_door_fixture.ts';
import {
	createDoorDriveReport,
	expectedCreateDoorDrive,
	expectedSectionCreateDoorDrive,
	markCreateDoorDriven,
	markSectionCreateDoorDriven,
	sectionCreateDoorDriveReport,
} from '../helpers/create_door_probes.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

registerSessionCleanup();

const USERS = 'dd128';
const PROFILES = 'dd234';
/** test6100's component_dataframe slot whose request_config targets the Annotation frames. */
const DATAFRAME_SLOT = 'test6453';
/** The superuser's id (root). */
const ROOT = -1;

let ids: AuthzIdentities;
let superuser: Principal;
/** The activity watermark at the start of the run (the sweep never reaches below it). */
let activityStart = 0;
const sessions = new Map<number, Session>();

// --- plumbing --------------------------------------------------------------------

function contextFor(principal: Principal): ApiRequestContext {
	let session = sessions.get(principal.userId);
	if (session === undefined) {
		const token = createSession(
			principal.userId,
			`zzauthz_create_gate_${principal.userId}`,
			principal.isGlobalAdmin,
		);
		session = getSession(token) as Session;
		sessions.set(principal.userId, session);
	}
	return {
		requestId: crypto.randomUUID(),
		clientIp: '127.0.0.1',
		session,
		csrfCandidate: session.csrfToken,
		principal,
	} as ApiRequestContext;
}

/** What a door answered: the refusal's code + status, or served (code null). */
interface Answer {
	code: string | null;
	status: number;
	value?: unknown;
}

async function answerOf(run: () => Promise<unknown>): Promise<Answer> {
	try {
		const value = await run();
		if (value !== null && typeof value === 'object' && 'status' in value && 'body' in value) {
			const { status, body } = value as { status: number; body?: { error?: { code?: string } } };
			return { code: body?.error?.code ?? null, status, value };
		}
		return { code: null, status: 200, value };
	} catch (error) {
		if (isDedaloError(error)) return { code: error.code, status: error.spec.status };
		// Never rethrown here: the caller sweeps what the door created first, and
		// the assertion on the code then reds with the message.
		return { code: `untyped: ${(error as Error).message}`, status: 500 };
	}
}

async function tableOf(sectionTipo: string): Promise<string> {
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === null) throw new Error(`no matrix table for ${sectionTipo}`);
	return table;
}

/** Every section_id of the section (a set diff, never a max: fixture rows sit above the counter). */
async function rowIds(sectionTipo: string): Promise<Set<number>> {
	const rows = (await sql.unsafe(
		`SELECT section_id FROM "${await tableOf(sectionTipo)}" WHERE section_tipo = $1`,
		[sectionTipo],
	)) as { section_id: number | string }[];
	return new Set(rows.map((row) => Number(row.section_id)));
}

async function maxActivityId(): Promise<number> {
	const rows = (await sql`
		SELECT COALESCE(MAX(section_id), 0)::int AS max FROM matrix_activity
	`) as { max: number }[];
	return rows[0]?.max ?? 0;
}

/** Activity rows appended after `since` that name `sectionTipo` as their WHERE. */
async function activityRowsSince(since: number, sectionTipo: string): Promise<number[]> {
	const rows = (await sql.unsafe(
		`SELECT section_id FROM matrix_activity
		  WHERE section_id > $1 AND string->'dd546'->0->>'value' = $2`,
		[since, sectionTipo],
	)) as { section_id: number | string }[];
	return rows.map((row) => Number(row.section_id));
}

/** A host's relation column as text (the byte-identity probe). */
async function hostRelation(
	sectionId: number,
	hostSection: string = AUTHZ_SECTION,
): Promise<string | null> {
	const rows = (await sql.unsafe(
		`SELECT relation::text AS relation FROM "${await tableOf(hostSection)}"
		  WHERE section_tipo = $1 AND section_id = $2`,
		[hostSection, sectionId],
	)) as { relation: string | null }[];
	if (rows.length !== 1) throw new Error(`host ${hostSection}/${sectionId} is gone`);
	return rows[0]?.relation ?? null;
}

/** Remove rows a door created (+ their TM and activity rows) — on the suite DB only. */
async function sweepCreated(
	sectionTipo: string,
	sectionIds: readonly number[],
	activityIds: readonly number[],
) {
	await assertTestDatabase('add_new_element_create_gate_native: sweep');
	const table = await tableOf(sectionTipo);
	for (const sectionId of sectionIds) {
		await deleteMatrixRecord(table, sectionTipo, sectionId);
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[sectionTipo, sectionId],
		);
	}
	if (activityIds.length > 0) {
		await sql.unsafe(
			`DELETE FROM matrix_activity WHERE section_tipo = 'dd542'
			   AND section_id = ANY(string_to_array($1, ',')::int[])`,
			[activityIds.join(',')],
		);
	}
}

/** Every record any case created — re-checked for residue in afterAll. */
const sweptLedger: { sectionTipo: string; sectionId: number }[] = [];

interface Observed {
	answer: Answer;
	/** Ids the door added to the target section (swept already). */
	created: number[];
	/** NEW activity rows naming the target (swept already). */
	activity: number;
	hostBefore: string | null;
	hostAfter: string | null;
	/** Snapshot of the created record's relation column, read before the sweep. */
	createdRelation: Record<string, unknown[]> | null;
}

/**
 * Run one door against `target`: snapshot the target's row set, the activity
 * watermark and the host; run; diff; SWEEP what was created (before any
 * assertion, so a red case leaves nothing behind); return the observations.
 */
async function observe(
	target: string,
	run: () => Promise<unknown>,
	host?: number,
	hostSection: string = AUTHZ_SECTION,
): Promise<Observed> {
	const before = await rowIds(target);
	const activitySince = await maxActivityId();
	const hostBefore = host === undefined ? null : await hostRelation(host, hostSection);
	const answer = await answerOf(run);
	const after = await rowIds(target);
	const created = [...after].filter((id) => !before.has(id)).sort((a, b) => a - b);
	let createdRelation: Record<string, unknown[]> | null = null;
	if (created.length === 1) {
		const rows = (await sql.unsafe(
			`SELECT relation::text AS relation FROM "${await tableOf(target)}"
			  WHERE section_tipo = $1 AND section_id = $2`,
			[target, created[0]],
		)) as { relation: string | null }[];
		createdRelation = rows[0]?.relation ? JSON.parse(rows[0].relation) : {};
	}
	const activity = await activityRowsSince(activitySince, target);
	const hostAfter = host === undefined ? null : await hostRelation(host, hostSection);
	for (const sectionId of created) sweptLedger.push({ sectionTipo: target, sectionId });
	await sweepCreated(target, created, activity);
	return { answer, created, activity: activity.length, hostBefore, hostAfter, createdRelation };
}

/** The refusal contract: code + status, nothing created, no activity, host intact. */
function expectRefused(observed: Observed, code: string, status: number): void {
	// ONE comparison, so a red case names every broken half at once (the code,
	// what it created, the activity it logged, whether the host moved).
	expect({
		code: observed.answer.code,
		status: observed.answer.status,
		created: observed.created.length,
		newActivityRows: observed.activity,
		hostChanged: observed.hostAfter !== observed.hostBefore,
	}).toEqual({ code, status, created: 0, newActivityRows: 0, hostChanged: false });
}

/** The served contract: no refusal, exactly one record created. */
function expectCreatedOne(observed: Observed): number {
	expect(observed.answer.code).toBeNull();
	expect(observed.answer.status).toBe(200);
	expect(observed.created.length).toBe(1);
	return observed.created[0] as number;
}

// --- the doors -------------------------------------------------------------------

/** A fresh engine-built test3 host in project P (swept by the fixture). */
const newHost = () => doorRecord(AUTHZ_SECTION);

/** Every engine-built record this gate made (hosts, sources) — their activity rows are swept after. */
const builtRecords: { sectionTipo: string; sectionId: number }[] = [];

/** createDoorRecord, remembered for the activity sweep (the fixture sweeps the rows themselves). */
async function doorRecord(sectionTipo: string, filterComponent?: string): Promise<number> {
	const sectionId = await createDoorRecord(sectionTipo, AUTHZ_PROJECT_P, [], filterComponent);
	builtRecords.push({ sectionTipo, sectionId });
	return sectionId;
}

/** The two children hosts: test3 (born WITHOUT a project — record_defaults FILTER_EXCLUDED_SECTIONS) and test65 (project-filtered). */
const CHILDREN_HOSTS: Readonly<
	Record<string, { children: string; parent: string; filter: string }>
> = {
	[AUTHZ_SECTION]: { children: AUTHZ_CHILDREN, parent: AUTHZ_PARENT, filter: 'test101' },
	[AUTHZ_OFF_TARGET_SECTION]: {
		children: AUTHZ_OFF_TARGET_CHILDREN,
		parent: AUTHZ_OFF_TARGET_PARENT,
		filter: AUTHZ_OFF_TARGET_FILTER,
	},
};

function relationSaveRqo(
	componentTipo: string,
	model: string,
	hostId: number,
	target: string,
	temporal = false,
	hostSection: string = AUTHZ_SECTION,
): Rqo {
	return {
		action: 'save',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		source: {
			typo: 'source',
			type: 'component',
			model,
			tipo: componentTipo,
			section_tipo: hostSection,
			section_id: hostId,
			mode: 'edit',
			lang: 'lg-nolan',
			action: null,
			...(temporal ? { is_temporal: true } : {}),
		},
		data: {
			section_id: hostId,
			section_tipo: hostSection,
			tipo: componentTipo,
			lang: 'lg-nolan',
			...(temporal ? { entries: [] } : {}),
			changed_data: [{ action: 'add_new_element', id: null, value: target }],
		},
	} as unknown as Rqo;
}

async function portalSave(principal: Principal, target: string, temporal = false) {
	const host = await newHost();
	const observed = await observe(
		target,
		() =>
			dispatchRqo(
				relationSaveRqo(AUTHZ_PORTAL, 'component_portal', host, target, temporal),
				contextFor(principal),
			),
		host,
	);
	return { host, observed };
}

/** A children save on a fresh host of `hostSection` (test3/test201 or test65/test156). */
async function childrenSave(principal: Principal, hostSection: string, target: string) {
	const tree = CHILDREN_HOSTS[hostSection];
	if (tree === undefined) throw new Error(`no children host spec for ${hostSection}`);
	const host = await doorRecord(hostSection, tree.filter);
	const observed = await observe(
		target,
		() =>
			dispatchRqo(
				relationSaveRqo(
					tree.children,
					'component_relation_children',
					host,
					target,
					false,
					hostSection,
				),
				contextFor(principal),
			),
		host,
		hostSection,
	);
	return { host, observed };
}

function coreCreate(principal: Principal, target: string) {
	return observe(target, () =>
		dispatchRqo(
			{
				action: 'create',
				dd_api: 'dd_core_api',
				source: { section_tipo: target, model: 'section' },
			} as unknown as Rqo,
			contextFor(principal),
		),
	);
}

function coreDuplicate(principal: Principal, target: string, sourceId: number) {
	return observe(target, () =>
		dispatchRqo(
			{
				action: 'duplicate',
				dd_api: 'dd_core_api',
				source: { section_tipo: target, section_id: sourceId, model: 'section' },
			} as unknown as Rqo,
			contextFor(principal),
		),
	);
}

async function treeAddChild(principal: Principal) {
	const parent = await newHost();
	const observed = await observe(
		AUTHZ_SECTION,
		() =>
			dispatchRqo(
				{
					action: 'add_child',
					dd_api: 'dd_ts_api',
					source: { section_tipo: AUTHZ_SECTION, section_id: parent },
				} as unknown as Rqo,
				contextFor(principal),
			),
		parent,
	);
	return { parent, observed };
}

// --- situation -------------------------------------------------------------------

beforeAll(async () => {
	await assertTestDatabase('add_new_element_create_gate_native');
	await installAuthzDoorFixture();
	ids = await resolveAuthzIdentities();
	await assertAuthzDoorContrast(ids);
	superuser = await resolvePrincipal(ROOT);
	activityStart = await maxActivityId();
}, 60_000);

afterAll(async () => {
	// The activity this run left above its watermark: every row naming a record
	// it built (the hosts' NEW rows, the doors' SAVE rows on them) and every row
	// its own personas acted (the fixture sweeps users/records, not activity).
	await assertTestDatabase('add_new_element_create_gate_native: activity sweep');
	const ACTIVITY_OF_RUN = `section_tipo = 'dd542' AND section_id > $1 AND (
		   relation->'dd543'->0->>'section_id' = ANY(string_to_array($2, ','))
		OR (misc->'dd551'->0->'value'->>'section_tipo') || '/' ||
		   (misc->'dd551'->0->'value'->>'section_id') = ANY(string_to_array($3, ',')))`;
	const activityParams = [
		activityStart,
		[
			ids.portalEditor.userId,
			ids.childEditor.userId,
			ids.featureEditor.userId,
			ids.level1.userId,
		].join(','),
		builtRecords.map((record) => `${record.sectionTipo}/${record.sectionId}`).join(','),
	];
	await sql.unsafe(`DELETE FROM matrix_activity WHERE ${ACTIVITY_OF_RUN}`, activityParams);
	await removeAuthzDoorFixture();
	const left = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM matrix_activity WHERE ${ACTIVITY_OF_RUN}`,
		activityParams,
	)) as { n: number }[];
	expect(left[0]?.n).toBe(0);
	// Zero residue: nothing any case created is still there.
	const residue: string[] = [];
	for (const { sectionTipo, sectionId } of sweptLedger) {
		if ((await rowIds(sectionTipo)).has(sectionId)) residue.push(`${sectionTipo}/${sectionId}`);
	}
	expect(residue).toEqual([]);
}, 60_000);

describe('premises — the situation is what the cases claim (green on HEAD)', () => {
	test('test80 targets test3 only; the button_new rows are where the cases assume', async () => {
		expect(await getElementTargetSectionTipos(AUTHZ_PORTAL, AUTHZ_SECTION)).toEqual([
			AUTHZ_SECTION,
		]);
		const firstButtonNew = async (sectionTipo: string) =>
			(await sectionButtonRows(sectionTipo)).find((row) => row.model === 'button_new')?.tipo ??
			null;
		expect(await firstButtonNew(AUTHZ_SECTION)).toBe('test126');
		expect(await firstButtonNew(AUTHZ_READ_BUTTON_SECTION)).toBe('test6274');
		expect(await firstButtonNew(AUTHZ_NO_BUTTON_SECTION)).toBeNull();
		expect(await firstButtonNew(AUTHZ_OFF_TARGET_SECTION)).toBe('test13');
		expect(await firstButtonNew(USERS)).toBe('dd179');
		expect(await firstButtonNew(PROFILES)).toBe('dd235');
		// The children hosts: each section's paired parent component.
		expect(await getParentTipo(AUTHZ_SECTION)).toBe(AUTHZ_PARENT);
		expect(await getParentTipo(AUTHZ_OFF_TARGET_SECTION)).toBe(AUTHZ_OFF_TARGET_PARENT);
		expect(await getParentTipo(USERS)).toBeNull();
		// Every target writes somewhere real (a refusal is never a missing table).
		for (const sectionTipo of [
			AUTHZ_SECTION,
			AUTHZ_READ_BUTTON_SECTION,
			AUTHZ_NO_BUTTON_SECTION,
			AUTHZ_OFF_TARGET_SECTION,
			USERS,
			PROFILES,
		]) {
			expect(await getMatrixTableFromTipo(sectionTipo)).not.toBeNull();
		}
	});
});

// --- the relation doors ----------------------------------------------------------

/** The four create-refused targets: [target, why]. */
const PERM_REFUSED: readonly [string, string][] = [
	[USERS, 'dd128 users: no grant at all'],
	[PROFILES, 'dd234 profiles: no grant at all'],
	[AUTHZ_READ_BUTTON_SECTION, 'test6100: section 2, button_new test6274 at READ (1)'],
	[AUTHZ_NO_BUTTON_SECTION, 'test38: section 2, NO button_new'],
];

for (const temporal of [false, true]) {
	const door = temporal ? 'temporal door (is_temporal save)' : 'portal save door';
	const probe = temporal ? 'temporal:add_new_element' : 'save:add_new_element';
	describe(`${door} — portal test80 (on test3, targets test3)`, () => {
		for (const [target, why] of PERM_REFUSED) {
			test(`PORTAL_EDITOR → ${why} → perm.denied 403, nothing created`, async () => {
				const { observed } = await portalSave(ids.portalEditor, target, temporal);
				expectRefused(observed, 'perm.denied', 403);
				markCreateDoorDriven(probe, 'refused');
			}, 60_000);
		}

		test('PORTAL_EDITOR → test65 (create-granted, OUTSIDE target_sections) → request.invalid_source 400', async () => {
			const { observed } = await portalSave(ids.portalEditor, AUTHZ_OFF_TARGET_SECTION, temporal);
			expectRefused(observed, 'request.invalid_source', 400);
		}, 60_000);

		test('SUPERUSER → test38 (no button_new: PHP null < 2) → perm.denied 403', async () => {
			const { observed } = await portalSave(superuser, AUTHZ_NO_BUTTON_SECTION, temporal);
			expectRefused(observed, 'perm.denied', 403);
		}, 60_000);

		test('CONTROL: PORTAL_EDITOR → test3 (section 2 + button_new test126 at 2) → created', async () => {
			const { observed } = await portalSave(ids.portalEditor, AUTHZ_SECTION, temporal);
			// The host is the target's section here: the created id is the one new row.
			const created = expectCreatedOne(observed);
			markCreateDoorDriven(probe, 'created');
			const body = (observed.answer.value as { body: { data?: { created_section_id?: unknown } } })
				.body;
			expect(Number(body.data?.created_section_id)).toBe(created);
			if (temporal) {
				// The temporal door never writes its host.
				expect(observed.hostAfter).toBe(observed.hostBefore);
			} else {
				// Linked: the host's test80 now carries the created record.
				const links = (JSON.parse(observed.hostAfter ?? '{}')[AUTHZ_PORTAL] ?? []) as {
					section_id?: unknown;
					section_tipo?: unknown;
				}[];
				expect(
					links.some(
						(link) => link.section_tipo === AUTHZ_SECTION && Number(link.section_id) === created,
					),
				).toBe(true);
			}
		}, 60_000);
	});
}

describe('children door (component_relation_children write-through)', () => {
	test('CHILD_EDITOR (test65 tree at 2, button_new test13 at an explicit 0) → test65 → perm.denied 403', async () => {
		const { observed } = await childrenSave(
			ids.childEditor,
			AUTHZ_OFF_TARGET_SECTION,
			AUTHZ_OFF_TARGET_SECTION,
		);
		expectRefused(observed, 'perm.denied', 403);
		markCreateDoorDriven('children:add_new_element', 'refused');
	}, 60_000);

	// test3 is born WITHOUT a project (record_defaults FILTER_EXCLUDED_SECTIONS),
	// so on HEAD the created child fails the per-child scope check and the
	// write-through rolls back (perm.out_of_scope, nothing kept): the gate must
	// answer perm.denied BEFORE the create instead.
	test('TREE_EDITOR (test3 tree at 2, test126 withheld) → test3 → perm.denied 403', async () => {
		const { observed } = await childrenSave(ids.treeEditor, AUTHZ_SECTION, AUTHZ_SECTION);
		expectRefused(observed, 'perm.denied', 403);
	}, 60_000);

	test('CONTROL: PORTAL_EDITOR (same test65 tree + test13 at 2) → test65 → created as a child', async () => {
		const { host, observed } = await childrenSave(
			ids.portalEditor,
			AUTHZ_OFF_TARGET_SECTION,
			AUTHZ_OFF_TARGET_SECTION,
		);
		expectCreatedOne(observed);
		markCreateDoorDriven('children:add_new_element', 'created');
		const links = (observed.createdRelation?.[AUTHZ_OFF_TARGET_PARENT] ?? []) as {
			section_id?: unknown;
		}[];
		expect(links.map((link) => Number(link.section_id))).toEqual([host]);
	}, 60_000);

	test('REGRESSION PIN (green on HEAD): SUPERUSER → dd128 stays request.invalid_data 400 (structural)', async () => {
		const { observed } = await childrenSave(superuser, AUTHZ_SECTION, USERS);
		expectRefused(observed, 'request.invalid_data', 400);
	}, 60_000);
});

// --- D3 REVISED: a TOOL-driven add_new_element asks the SECTION level ---------------

describe('D3 REVISED — a TOOL-driven add_new_element is SECTION level + target_sections', () => {
	/** The engine path the three tools take: saveComponentData on test3's portal test80. */
	/** `access` null = NO tool access (the user rule) — a default parameter would swallow `undefined`. */
	async function toolSave(
		principal: Principal,
		target: string,
		access: ToolAddNewElementAccess | null = toolAddNewElementAccess(
			principal,
			'tool_import_files',
		),
	) {
		const host = await newHost();
		return observe(
			target,
			() =>
				saveComponentData({
					componentTipo: AUTHZ_PORTAL,
					sectionTipo: AUTHZ_SECTION,
					sectionId: host,
					lang: 'lg-nolan',
					changedData: [{ action: 'add_new_element', id: null, value: target } as never],
					userId: principal.userId,
					principal,
					...(access === null ? {} : { toolCreateAccess: access }),
				}),
			host,
		);
	}

	test('CONTROL: FEATURE_EDITOR (test3 at 2, its button_new test126 at 0) → test3 through the tool → created + linked', async () => {
		const observed = await toolSave(ids.featureEditor, AUTHZ_SECTION);
		const created = expectCreatedOne(observed);
		markSectionCreateDoorDriven('tool:add_new_element', 'created');
		const links = (JSON.parse(observed.hostAfter ?? '{}')[AUTHZ_PORTAL] ?? []) as {
			section_id?: unknown;
		}[];
		expect(links.some((link) => Number(link.section_id) === created)).toBe(true);
	}, 60_000);

	test('the SAME save WITHOUT the tool access (the user rule) → perm.denied 403 (button withheld)', async () => {
		expectRefused(await toolSave(ids.featureEditor, AUTHZ_SECTION, null), 'perm.denied', 403);
	}, 60_000);

	test('LEVEL_1 (test3 at READ) through the tool → perm.denied 403, nothing created', async () => {
		expectRefused(await toolSave(ids.level1, AUTHZ_SECTION), 'perm.denied', 403);
		markSectionCreateDoorDriven('tool:add_new_element', 'refused');
	}, 60_000);

	test('FEATURE_EDITOR through the tool → test6100 (section 2, OUTSIDE test80’s targets) → request.invalid_source 400', async () => {
		expectRefused(
			await toolSave(ids.featureEditor, AUTHZ_READ_BUTTON_SECTION),
			'request.invalid_source',
			400,
		);
	}, 60_000);

	test('an UNMINTED tool access (no symbol brand — what a JSON payload could at most carry) → internal.invariant, nothing created', async () => {
		const forged = JSON.parse(
			JSON.stringify(toolAddNewElementAccess(ids.featureEditor, 'tool_import_files')),
		) as ToolAddNewElementAccess;
		expect(forged.mode).toBe('tool');
		expectRefused(
			await toolSave(ids.featureEditor, AUTHZ_SECTION, forged),
			'internal.invariant',
			500,
		);
	}, 60_000);

	test('THE WIRE CANNOT SELECT IT: a save rqo smuggling the tool access at every level still asks the New button → perm.denied 403', async () => {
		const host = await newHost();
		const smuggled = {
			mode: 'tool',
			tool: 'tool_import_files',
			membership: 'target_sections',
			principal: { userId: ids.featureEditor.userId },
		};
		const rqo = relationSaveRqo(
			AUTHZ_PORTAL,
			'component_portal',
			host,
			AUTHZ_SECTION,
		) as unknown as {
			source: Record<string, unknown>;
			data: Record<string, unknown>;
			options?: Record<string, unknown>;
		} & Record<string, unknown>;
		for (const bag of [rqo, rqo.source, rqo.data]) {
			bag.toolCreateAccess = smuggled;
			bag.tool_create_access = smuggled;
			bag.access = smuggled;
		}
		rqo.options = { toolCreateAccess: smuggled, tool_create_access: smuggled };
		const observed = await observe(
			AUTHZ_SECTION,
			() => dispatchRqo(rqo as unknown as Rqo, contextFor(ids.featureEditor)),
			host,
		);
		expectRefused(observed, 'perm.denied', 403);
	}, 60_000);
});

// --- D4: the other create doors on the same predicate ------------------------------

describe('D4 REVISED — core create (dd_core_api create) is SECTION level', () => {
	// Owner decision 2026-11-10: core `create` asks the consultation-capped
	// SECTION level ≥ 2 only (PHP dd_core_api::create parity) — the feature-owned
	// sections (notes, references, dataframe frames, presets) ship no button_new.
	test('PORTAL_EDITOR → dd128 (section 0) → perm.denied 403', async () => {
		expectRefused(await coreCreate(ids.portalEditor, USERS), 'perm.denied', 403);
		markSectionCreateDoorDriven('dd_core_api:create', 'refused');
	}, 60_000);
	test('CONTROL: PORTAL_EDITOR → test6100 (section 2, its button_new at READ) → created', async () => {
		expectCreatedOne(await coreCreate(ids.portalEditor, AUTHZ_READ_BUTTON_SECTION));
		markSectionCreateDoorDriven('dd_core_api:create', 'created');
	}, 60_000);
	test('SUPERUSER → test38 (no button_new at all) → created', async () => {
		expectCreatedOne(await coreCreate(superuser, AUTHZ_NO_BUTTON_SECTION));
	}, 60_000);
});

// --- REGRESSION PINS: the feature flows the New-button rule broke on core create ----

describe('REGRESSION PINS — feature-owned sections (no button_new) create through core create', () => {
	test('premise: every feature section has a matrix table and NO button_new', async () => {
		for (const sectionTipo of AUTHZ_FEATURE_SECTIONS) {
			expect(await getMatrixTableFromTipo(sectionTipo), sectionTipo).not.toBeNull();
			expect(
				(await sectionButtonRows(sectionTipo)).some((row) => row.model === 'button_new'),
				`${sectionTipo} ships a button_new`,
			).toBe(false);
		}
	});
	for (const sectionTipo of AUTHZ_FEATURE_SECTIONS) {
		test(`SUPERUSER → ${sectionTipo} → created`, async () => {
			expectCreatedOne(await coreCreate(superuser, sectionTipo));
		}, 60_000);
		test(`FEATURE_EDITOR (section 2, no button grant) → ${sectionTipo} → created`, async () => {
			expectCreatedOne(await coreCreate(ids.featureEditor, sectionTipo));
		}, 60_000);
	}
	// The client's component_dataframe create_new_section: `create` on its
	// request_config sqo.section_tipo[0] — here test6100's slot test6453.
	describe('component_dataframe create_new_section (test6100 slot test6453)', () => {
		const frameTarget = async (): Promise<string> => {
			const targets = await getElementTargetSectionTipos(
				DATAFRAME_SLOT,
				AUTHZ_READ_BUTTON_SECTION,
				'edit',
			);
			expect(targets[0]).toBe(AUTHZ_FEATURE_SECTIONS[4]);
			return targets[0] as string;
		};
		test('SUPERUSER → the slot’s frame target → created', async () => {
			expectCreatedOne(await coreCreate(superuser, await frameTarget()));
		}, 60_000);
		test('FEATURE_EDITOR → the slot’s frame target → created', async () => {
			expectCreatedOne(await coreCreate(ids.featureEditor, await frameTarget()));
		}, 60_000);
	});
});

describe('D4 — core duplicate (dd_core_api duplicate)', () => {
	test('PORTAL_EDITOR duplicates an in-scope test6100 record (button_new at 1) → perm.denied 403', async () => {
		const sourceId = await doorRecord(AUTHZ_READ_BUTTON_SECTION, AUTHZ_READ_BUTTON_FILTER);
		expectRefused(
			await coreDuplicate(ids.portalEditor, AUTHZ_READ_BUTTON_SECTION, sourceId),
			'perm.denied',
			403,
		);
		markCreateDoorDriven('dd_core_api:duplicate', 'refused');
	}, 60_000);
	test('CONTROL: PORTAL_EDITOR duplicates an in-scope test3 record → created', async () => {
		const sourceId = await newHost();
		expectCreatedOne(await coreDuplicate(ids.portalEditor, AUTHZ_SECTION, sourceId));
		markCreateDoorDriven('dd_core_api:duplicate', 'created');
	}, 60_000);
});

describe('D4 — tree add_child (dd_ts_api add_child)', () => {
	test('TREE_EDITOR (test3 at 2, test126 withheld) → perm.denied 403', async () => {
		const { observed } = await treeAddChild(ids.treeEditor);
		expectRefused(observed, 'perm.denied', 403);
		markCreateDoorDriven('dd_ts_api:add_child', 'refused');
	}, 60_000);
	test('CONTROL: PORTAL_EDITOR (test126 at 2) → created', async () => {
		const { observed } = await treeAddChild(ids.portalEditor);
		expectCreatedOne(observed);
		markCreateDoorDriven('dd_ts_api:add_child', 'created');
	}, 60_000);
});

describe('D4 — MCP create_record', () => {
	test('PORTAL_EDITOR → test6100 (button_new at 1) → perm.denied 403', async () => {
		expectRefused(
			await observe(AUTHZ_READ_BUTTON_SECTION, () =>
				createRecord(ids.portalEditor, { section_tipo: AUTHZ_READ_BUTTON_SECTION }),
			),
			'perm.denied',
			403,
		);
		markCreateDoorDriven('mcp:create_record', 'refused');
	}, 60_000);
	test('CONTROL: PORTAL_EDITOR → test3 → created', async () => {
		expectCreatedOne(
			await observe(AUTHZ_SECTION, () =>
				createRecord(ids.portalEditor, { section_tipo: AUTHZ_SECTION }),
			),
		);
		markCreateDoorDriven('mcp:create_record', 'created');
	}, 60_000);
});

describe('D4 — MCP find_or_create (the create branch)', () => {
	const unmatched = () => `zzauthz create gate ${crypto.randomUUID()}`;
	test('PORTAL_EDITOR → test6100 (match field at 2, button_new at 1) → perm.denied 403', async () => {
		expectRefused(
			await observe(AUTHZ_READ_BUTTON_SECTION, () =>
				findOrCreate(ids.portalEditor, {
					section_tipo: AUTHZ_READ_BUTTON_SECTION,
					match: [{ field: AUTHZ_READ_BUTTON_TEXT, value: unmatched(), lang: 'lg-eng' }],
				}),
			),
			'perm.denied',
			403,
		);
		markCreateDoorDriven('mcp:find_or_create', 'refused');
	}, 60_000);
	// The CONTROL is the superuser (as in authz_door_matrix_native): a test3 record
	// is born with no project (record_defaults FILTER_EXCLUDED_SECTIONS), so the
	// fill step after a non-admin's create is out of that user's scope.
	test('CONTROL: SUPERUSER → test3 → created', async () => {
		const observed = await observe(AUTHZ_SECTION, () =>
			findOrCreate(superuser, {
				section_tipo: AUTHZ_SECTION,
				match: [{ field: 'test52', value: unmatched(), lang: 'lg-eng' }],
			}),
		);
		expectCreatedOne(observed);
		expect((observed.answer.value as { created?: boolean }).created).toBe(true);
		markCreateDoorDriven('mcp:find_or_create', 'created');
	}, 60_000);
});

describe('D4 — MCP duplicate_record', () => {
	test('PORTAL_EDITOR duplicates an in-scope test6100 record (button_new at 1) → perm.denied 403', async () => {
		const sourceId = await doorRecord(AUTHZ_READ_BUTTON_SECTION, AUTHZ_READ_BUTTON_FILTER);
		expectRefused(
			await observe(AUTHZ_READ_BUTTON_SECTION, () =>
				duplicateRecord(ids.portalEditor, {
					section_tipo: AUTHZ_READ_BUTTON_SECTION,
					section_id: sourceId,
				}),
			),
			'perm.denied',
			403,
		);
		markCreateDoorDriven('mcp:duplicate_record', 'refused');
	}, 60_000);
	test('CONTROL: PORTAL_EDITOR duplicates an in-scope test3 record → created', async () => {
		const sourceId = await newHost();
		expectCreatedOne(
			await observe(AUTHZ_SECTION, () =>
				duplicateRecord(ids.portalEditor, { section_tipo: AUTHZ_SECTION, section_id: sourceId }),
			),
		);
		markCreateDoorDriven('mcp:duplicate_record', 'created');
	}, 60_000);
});

// --- F2: the hierarchy root term — own provisioned section vs a STEERED target ------

describe('F2 — the hierarchy invariant’s root term: system only in its OWN provisioned section', () => {
	/** A scratch hierarchy registry row (tld zzcgh), swept with its ontology after each case. */
	const HIER_TLD = 'zzcgh';
	const HIER_ID = 944060;
	const HIER_TABLE = 'matrix_hierarchy_main';
	/** An EMPTY test-TLD thesaurus section (a virtual of hierarchy20, button_new hierarchy38). */
	const FOREIGN_THESAURUS = 'test1020';
	/** A REAL section named `<tld>2` of the `test` TLD (S1 scenario B). */
	const REAL_TLD_SECTION = 'test2';

	/** S1 scenario A: a second, LEGIT hierarchy whose TLD the scratch row hijacks. */
	const VICTIM_TLD = 'zzcgv';
	const VICTIM_ID = 944061;

	async function sweepHierarchy(): Promise<void> {
		await sweepTld(HIER_TLD, HIER_ID);
		await sweepTld(VICTIM_TLD, VICTIM_ID);
	}

	async function sweepTld(HIER_TLD: string, HIER_ID: number): Promise<void> {
		await assertTestDatabase('add_new_element_create_gate_native: hierarchy sweep');
		await deleteOntologyByTld(HIER_TLD, (st, sid) => deleteSectionRecord(st, sid, ROOT));
		await sql.unsafe('DELETE FROM dd_ontology WHERE tld = $1', [HIER_TLD]);
		await sql.unsafe(
			`DELETE FROM "${HIER_TABLE}" WHERE section_tipo = 'hierarchy1' AND section_id = $1`,
			[HIER_ID],
		);
		await sql.unsafe('DELETE FROM matrix_hierarchy WHERE section_tipo IN ($1, $2)', [
			`${HIER_TLD}1`,
			`${HIER_TLD}2`,
		]);
		await sql.unsafe(
			`DELETE FROM matrix_time_machine WHERE section_tipo IN ($1, $2, $3)
			   OR (section_tipo = 'hierarchy1' AND section_id = $4)`,
			[`${HIER_TLD}0`, `${HIER_TLD}1`, `${HIER_TLD}2`, HIER_ID],
		);
		await sql.unsafe(
			`DELETE FROM matrix_activity WHERE section_tipo = 'dd542' AND section_id > $1
			   AND string->'dd546'->0->>'value' = ANY(string_to_array($2, ','))`,
			[activityStart, [`${HIER_TLD}0`, `${HIER_TLD}1`, `${HIER_TLD}2`, 'hierarchy1'].join(',')],
		);
		await clearOntologyDerivedCaches();
	}

	/**
	 * A registry row, its TERMS target (hierarchy53) DECLARED — steered — at
	 * `termsTarget`. `extra` overrides the TLD / adds hierarchy58 / hierarchy109
	 * (the S1 hijack shapes).
	 */
	async function seedHierarchy(
		termsTarget: string,
		extra: { id?: number; tld?: string; model?: string; source?: string } = {},
	): Promise<void> {
		await assertTestDatabase('add_new_element_create_gate_native: hierarchy seed');
		const literals: Record<string, unknown> = {
			hierarchy5: [{ id: 1, lang: 'lg-eng', value: 'ZZ create gate' }],
			hierarchy6: [{ id: 1, lang: 'lg-nolan', value: (extra.tld ?? HIER_TLD).toUpperCase() }],
			hierarchy53: [{ id: 1, lang: 'lg-nolan', value: termsTarget }],
		};
		if (extra.model !== undefined) {
			literals.hierarchy58 = [{ id: 1, lang: 'lg-nolan', value: extra.model }];
		}
		if (extra.source !== undefined) {
			literals.hierarchy109 = [{ id: 1, lang: 'lg-nolan', value: extra.source }];
		}
		await sql.unsafe(
			`INSERT INTO "${HIER_TABLE}" (section_id, section_tipo, string, relation)
			 VALUES ($1, 'hierarchy1', $2::text::jsonb, $3::text::jsonb)`,
			[
				extra.id ?? HIER_ID,
				encodeForJsonb(literals),
				encodeForJsonb({
					hierarchy9: [
						{
							id: 1,
							type: 'dd151',
							section_id: 2,
							section_tipo: 'hierarchy13',
							from_component_tipo: 'hierarchy9',
						},
					],
				}),
			],
		);
		await clearOntologyDerivedCaches();
	}

	async function rootOf(componentTipo: string): Promise<Record<string, unknown> | null> {
		const rows = (await sql.unsafe(
			`SELECT relation->$2->0 AS loc FROM "${HIER_TABLE}" WHERE section_tipo = 'hierarchy1' AND section_id = $1`,
			[HIER_ID, componentTipo],
		)) as { loc: Record<string, unknown> | null }[];
		return rows[0]?.loc ?? null;
	}

	async function ensureAs(userId: number, termsTarget: string) {
		await sweepHierarchy();
		await seedHierarchy(termsTarget);
		const observed = await observe(termsTarget, () => ensureHierarchy(HIER_ID, userId));
		const outcome = observed.answer.value as { ok: boolean; errors: string[] } | undefined;
		// HIER-REBUILD D7 (owner, 2026-11-10): a row whose hierarchy53 is steered at a
		// section OUTSIDE its own `<tld>1`/`<tld>2` is ROOT-ONLY (case 2) — ensure never
		// provisions `<tld>0/1/2` for it. Measured as the tld's dd_ontology node count
		// (there is no `<tld>2` table to read when nothing was provisioned).
		const ownNodes = (
			(await sql.unsafe('SELECT count(*)::int AS n FROM dd_ontology WHERE tld = $1', [
				HIER_TLD,
			])) as { n: number }[]
		)[0]?.n;
		const termRoot = await rootOf('hierarchy45');
		const modelRoot = await rootOf('hierarchy59');
		await sweepHierarchy();
		return { observed, outcome, ownNodes, termRoot, modelRoot };
	}

	afterAll(sweepHierarchy);

	test('STEERED to test38 (empty, no button_new) as the SUPERUSER → refused, nothing created; root-only (HIER-REBUILD D7): no own <tld>0/1/2 provisioned', async () => {
		const run = await ensureAs(ROOT, AUTHZ_NO_BUTTON_SECTION);
		expect(run.observed.answer.code).toBeNull();
		expect(run.outcome?.ok).toBe(false);
		expect(run.outcome?.errors.join(' ')).toContain(
			`may not create a root in ${AUTHZ_NO_BUTTON_SECTION}`,
		);
		expect({ created: run.observed.created.length, activity: run.observed.activity }).toEqual({
			created: 0,
			activity: 0,
		});
		expect(run.termRoot?.section_tipo).not.toBe(AUTHZ_NO_BUTTON_SECTION);
		markCreateDoorDriven('hierarchy:declared_root_term', 'refused');
		// D7: steered elsewhere = root-only — no own `<tld>0/1/2`, so no system mint either.
		expect(run.ownNodes).toBe(0);
		expect(run.modelRoot).toBeNull();
	}, 120_000);

	test('STEERED to test1020 (a foreign thesaurus) as PORTAL_EDITOR (no hierarchy38 grant) → refused, nothing created', async () => {
		const run = await ensureAs(ids.portalEditor.userId, FOREIGN_THESAURUS);
		expect(run.outcome?.ok).toBe(false);
		expect(run.outcome?.errors.join(' ')).toContain(
			`may not create a root in ${FOREIGN_THESAURUS}`,
		);
		expect(run.observed.created.length).toBe(0);
		expect(run.ownNodes).toBe(0);
	}, 120_000);

	test('CONTROL: DECLARED test1020 as the SUPERUSER (hierarchy38 at 3) → its root is created there', async () => {
		const run = await ensureAs(ROOT, FOREIGN_THESAURUS);
		// HIER-REBUILD C1: a root-only row with hierarchy58 UNSET has NO model root —
		// not an error; the term root alone makes it usable.
		expect(run.outcome?.errors ?? []).toEqual([]);
		expect(run.outcome?.ok).toBe(true);
		expect(run.modelRoot).toBeNull();
		expect(run.observed.created.length).toBe(1);
		expect(run.termRoot?.section_tipo).toBe(FOREIGN_THESAURUS);
		markCreateDoorDriven('hierarchy:declared_root_term', 'created');
		expect(run.ownNodes).toBe(0);
	}, 120_000);

	// S1 — the two registry literals isOwnProvisionedSection used to trust.

	test('S1-A HIJACKED TLD: hierarchy6 = another installed hierarchy’s TLD + hierarchy53 = its EMPTY <tld>1, as PORTAL_EDITOR → refused, nothing created', async () => {
		await sweepHierarchy();
		// The victim: a real, fully provisioned hierarchy (as the superuser) …
		await seedHierarchy(`${VICTIM_TLD}1`, { id: VICTIM_ID, tld: VICTIM_TLD });
		const victim = await ensureHierarchy(VICTIM_ID, ROOT);
		expect(victim.ok).toBe(true);
		// … whose terms section is then EMPTY (its root swept): the mint precondition.
		await sql.unsafe('DELETE FROM matrix_hierarchy WHERE section_tipo = $1', [`${VICTIM_TLD}1`]);
		await clearOntologyDerivedCaches();
		expect((await rowIds(`${VICTIM_TLD}1`)).size).toBe(0);
		// The hijack: the scratch row DECLARES the victim's TLD and steers its terms there.
		await seedHierarchy(`${VICTIM_TLD}1`, { tld: VICTIM_TLD });
		const observed = await observe(`${VICTIM_TLD}1`, () =>
			ensureHierarchy(HIER_ID, ids.portalEditor.userId),
		);
		const outcome = observed.answer.value as { ok: boolean; errors: string[] } | undefined;
		const termRoot = await rootOf('hierarchy45');
		await sweepHierarchy();
		expect(observed.answer.code).toBeNull();
		expect({ created: observed.created.length, activity: observed.activity }).toEqual({
			created: 0,
			activity: 0,
		});
		expect(outcome?.ok).toBe(false);
		expect(outcome?.errors.join(' ')).toContain(`may not create a root in ${VICTIM_TLD}1`);
		expect(termRoot?.section_tipo).not.toBe(`${VICTIM_TLD}1`);
	}, 180_000);

	test('S1-B REAL section named <tld>2 (test2) with hierarchy109 = itself, as PORTAL_EDITOR → refused, nothing created', async () => {
		// test2: a REAL section (only a matrix_table relation) of the `test` TLD, empty;
		// `test0` carries its two node records, so the ontology reads as present.
		expect(await getSectionRealTipo(REAL_TLD_SECTION)).toBe(REAL_TLD_SECTION);
		expect((await rowIds(REAL_TLD_SECTION)).size).toBe(0);
		await sweepHierarchy();
		await seedHierarchy(REAL_TLD_SECTION, {
			tld: 'test',
			model: REAL_TLD_SECTION,
			source: REAL_TLD_SECTION,
		});
		const observed = await observe(REAL_TLD_SECTION, () =>
			ensureHierarchy(HIER_ID, ids.portalEditor.userId),
		);
		const outcome = observed.answer.value as { ok: boolean; errors: string[] } | undefined;
		const termRoot = await rootOf('hierarchy45');
		await sweepHierarchy();
		expect(observed.answer.code).toBeNull();
		expect({ created: observed.created.length, activity: observed.activity }).toEqual({
			created: 0,
			activity: 0,
		});
		expect(outcome?.ok).toBe(false);
		expect(outcome?.errors.join(' ')).toContain(`may not create a root in ${REAL_TLD_SECTION}`);
		expect(termRoot?.section_tipo).not.toBe(REAL_TLD_SECTION);
	}, 120_000);
});

// --- the probe set (create_door_census_tripwire reads CREATE_DOOR_PROBES) ---------

describe('CREATE_DOOR_PROBES is driven in full', () => {
	// The census credits a caller `authorizes-create` only through a probe id; this is
	// where an id is proven: every one refused (perm.denied, nothing created) AND
	// served (one created) by a case above in THIS run — a marker counts only after its
	// case's own assertion passed. Registered last, so it runs after every case.
	test('every probe door was refused AND served in this run', () => {
		expect(createDoorDriveReport()).toEqual(expectedCreateDoorDrive());
	});
	// The section-level doors: every one refused below section 2 AND served WITH the
	// New button withheld — the half that proves it does not ask the button.
	test('every SECTION-level probe door was refused AND served (button withheld) in this run', () => {
		expect(sectionCreateDoorDriveReport()).toEqual(expectedSectionCreateDoorDrive());
	});
});
