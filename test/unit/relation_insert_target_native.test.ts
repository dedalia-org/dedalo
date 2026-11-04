/**
 * THE RELATION INSERT CHOKEPOINT — `validateRelationInserts`
 * (src/core/relations/save.ts), the ONE door every stored locator passes
 * through, and the four constraints it now enforces (picker plan step 2 + the
 * batch wire of step 10).
 *
 * WHY THIS FILE EXISTS. Until this landing the door normalized shape and
 * deduped, and checked NOTHING about the target section, the principal's grant
 * on it, the term's own selectability or `properties.data_limit` — which had
 * ZERO occurrences in src/ and lived only in `component_portal.js`. A rule that
 * lives in the renderer is an invariant with no gate, and here it guards stored
 * data: a forged, stale or simply bypassed client could persist a locator into
 * a section the operator cannot see, or blow through a declared cap. So every
 * refusal below is asserted at the door, not at the UI.
 *
 * THE ASSERTIONS ARE ON OUTCOMES, NOT ON A BOOLEAN. The batch form answers one
 * `{locator, status, code, reason}` per submitted entry, in submission order —
 * a partially refused batch must COMMIT the accepted rows and NAME the refused
 * ones, because dropping an entry with no outcome row is exactly the silent
 * scope narrowing this codebase forbids. Cases that would pass on a
 * degenerate/empty answer are paired with their control (the same locator,
 * accepted, one field different), so nothing here can be vacuously green.
 *
 * SCRATCH SURFACES, all deleted in afterAll (and pre-swept in beforeAll):
 *  - a self-provisioned scratch thesaurus (`ontology/hierarchy_state.ts
 *    ensureHierarchy`, THE single writer) carrying one SELECTABLE term and one
 *    that is not — selectability is a per-node fact of a term's own record, so
 *    it cannot be asserted against a live thesaurus whose flags an operator may
 *    flip;
 *  - scratch caller nodes (synthetic tld) declaring one target each;
 *  - one test3 host record + three throwaway identities (the provisioner, an
 *    UNGRANTED one, and a project-scoped FILTER EDITOR: level 2 on test3's
 *    component_filter, 0 on the projects section dd153, member of the two projects it picks between — the
 *    ordinary non-admin shape every install has).
 * Provisioning grants the creating user's PROFILE level 2 over the new
 * sections, so it runs as a THROWAWAY user — never the superuser, whose profile
 * dd234/2 is a real record holding thousands of live grants.
 *
 * WHAT THE LENGTH-1 DOOR NOW ANSWERS. A constraint refusal reaching a save is
 * THROWN (`relation.insert_refused` 400 / `perm.denied` 403), never a silent
 * null-and-ok — the save-path cases below assert the wire status AND the
 * stored bytes, because "refused" and "deduped" used to be indistinguishable
 * on the wire and that is what the operator saw as a vanished chip.
 */
// Migrated to the generic `test` TLD 2026-08-20 (AGENTS.md hard rules). The file
// already BUILT almost everything it asserts on (the zzpq thesaurus, the zzwt
// caller nodes, the test3 host); only the two ONTOLOGY-SHAPE fixtures named an
// install: the virtual/real pair rsc170→rsc2 is now test7007→testheritagecatalog1,
// and the "different thesaurus" probe (the Spain hierarchy) is now test2827 — the same shapes
// (a section whose relations name another section; a terms section virtual over
// hierarchy20), taken from the `test` clone set instead of an install.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import { deleteTldNodes } from '../../src/core/db/dd_ontology.ts';
import { updateMatrixKeyData } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import { ensureHierarchy } from '../../src/core/ontology/hierarchy_state.ts';
import {
	type RelationInsertBatchResult,
	type RelationInsertContext,
	validateRelationInserts,
} from '../../src/core/relations/save.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { type Principal, resolvePrincipal } from '../../src/core/security/permissions.ts';
import { runWithRequestContext } from '../../src/core/security/request_context.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

registerSessionCleanup();

/** The scratch thesaurus (synthetic tld — no real install uses it). */
const TLD = 'zzpq';
/** Its descriptor section: a VIRTUAL section over hierarchy20, exactly like an activated thesaurus instance (testgeoa1). */
const TERMS = `${TLD}1`;
const CALLER_TLD = 'zzwt';
/** Targets test3; declares no view and no cap. */
const PLAIN = 'zzwt1';
/** Targets the REAL section testheritagecatalog1 — the virtual-resolution case. */
const VIRTUAL = 'zzwt2';
/** Targets the scratch thesaurus and declares view:'tree' — the picker caller. */
const TREE = 'zzwt3';
/** Targets test3 with `properties.data_limit: 2`. */
const CAPPED = 'zzwt4';
/** Targets test3 with a literal `properties.data_limit: 0`. */
const FORBIDDEN = 'zzwt5';
/** Targets the scratch thesaurus, no view — isolates the TARGET gate. */
const THESAURUS_PLAIN = 'zzwt6';
/** A FRAME slot: targets test3 with `data_limit: 1` — the per-main-item cap. */
const FRAMED = 'zzwt7';
/** Targets test3 AND holds the wired linker role in TOOL_CARRIER's ddo_map. */
const TOOL_LINKED = 'zzwt8';
/** Wired too (TOOL_CARRIER_FREE), but declares NO target — the exemption's control. */
const TOOL_LINKED_FREE = 'zzwt9';
/** Carries `properties.tool_config`: the wired pair + an unwired portal. */
const TOOL_CARRIER = 'zzwt10';
/** Holds the WIRED linker role, but is a component_select — not the portal family. */
const TOOL_SIBLING_SELECT = 'zzwt11';
/** The exemption's carrier: wires TOOL_LINKED_FREE, which declares no target. */
const TOOL_CARRIER_FREE = 'zzwt12';
/** A PORTAL in a role the tool never publishes into (the live rsc1368 shape). */
const TOOL_UNWIRED_PORTAL = 'zzwt13';
/** Carrier wiring TOOL_SIBLING_SELECT into the linker role. */
const TOOL_CARRIER_SELECT = 'zzwt14';
/** The main component the FRAMED slot's frames extend (a name; never resolved). */
const FRAMED_MAIN = 'zzwt15';

const HOST = 'test3';
const HOST_ID = 926201;
/** test3's own component_filter (parent test45, the section_group under test3). */
const HOST_FILTER = 'test101';
/** DEDALO_SECTION_PROJECTS_TIPO — the section every component_filter targets. */
const PROJECTS = 'dd153';
/** Two live projects of the canonical playground. */
const PROJECT_HELD = 1;
const PROJECT_PICKED = 2;
/** Records that exist in the canonical test3 playground. */
const IN_TARGET = [1, 2, 27];
/** A section no caller here declares. */
const OFF_TARGET_SECTION = 'test65';

const siNo = (tipo: string, yes: boolean) => [
	{
		id: 1,
		type: 'dd151',
		section_tipo: 'dd64',
		section_id: yes ? 1 : 2,
		from_component_tipo: tipo,
	},
];

interface Identity {
	userId: number;
	profileId: number;
	principal: Principal;
}

let hierarchyId = 0;
let provisioner: Identity | undefined;
/** Holds NO grant on test3 / the scratch thesaurus (the retired read-grant gate's subject). */
let ungranted: Identity | undefined;
/** Level 2 on test3's component_filter, 0 on dd153, member of PROJECT_HELD + PROJECT_PICKED. */
let filterEditor: Identity | undefined;
/** Level 2 on the TREE picker caller, 0 on the scratch thesaurus, member of PROJECT_HELD. */
let treeEditor: Identity | undefined;
let superuser: Principal;
let unselectableTermId = 0;

async function buildIdentity(
	grants: { tipo: string; section_tipo: string; value: number }[],
	projects: number[] = [],
): Promise<Identity> {
	const profileId = await createSectionRecord('dd234', -1);
	const userId = await createSectionRecord('dd128', -1);
	await updateMatrixKeyData('matrix_users', 'dd128', userId, 'relation', 'dd1725', [
		{
			id: 1,
			type: 'dd151',
			section_tipo: 'dd234',
			section_id: String(profileId),
			from_component_tipo: 'dd1725',
		},
	]);
	if (projects.length > 0) {
		// The user's own projects filter (dd170) — what the per-record scope gate
		// and filter_projects' authorized datalist both read.
		await updateMatrixKeyData(
			'matrix_users',
			'dd128',
			userId,
			'relation',
			'dd170',
			projects.map((projectId, index) => ({
				id: index + 1,
				type: 'dd151',
				section_tipo: PROJECTS,
				section_id: projectId,
				from_component_tipo: 'dd170',
			})),
		);
	}
	await updateMatrixKeyData(
		'matrix_profiles',
		'dd234',
		profileId,
		'misc',
		'dd774',
		grants.map((grant, index) => ({ id: index + 1, ...grant })),
	);
	return { userId, profileId, principal: await resolvePrincipal(userId) };
}

const targetConfig = (target: string) => ({
	request_config: [{ sqo: { section_tipo: [{ value: [target], source: 'section' }] } }],
});

async function buildCallerNode(
	tipo: string,
	properties: Record<string, unknown>,
	model = 'component_portal',
): Promise<void> {
	await sql.unsafe(
		`INSERT INTO dd_ontology (tipo, parent, model, tld, term, is_model, is_translatable, is_main, properties)
		 VALUES ($1, $2, $6, $3, $4::text::jsonb, false, false, false, $5::text::jsonb)`,
		[
			tipo,
			// Orphan parent: no section walk can reach these nodes.
			`${CALLER_TLD}999999`, // a valid tipo no node carries (SURF-1 grammar)
			CALLER_TLD,
			JSON.stringify({ 'lg-spa': `scratch insert caller ${tipo}` }),
			JSON.stringify(properties),
			model,
		],
	);
}

async function purgeScratch(): Promise<void> {
	await deleteTldNodes(TLD);
	await sql.unsafe('DELETE FROM dd_ontology WHERE tld = $1', [CALLER_TLD]);
	await sql.unsafe('DELETE FROM matrix_ontology WHERE section_tipo = $1', [`${TLD}0`]);
	await sql.unsafe('DELETE FROM matrix_hierarchy WHERE section_tipo IN ($1, $2)', [
		TERMS,
		`${TLD}2`,
	]);
	for (const sectionTipo of [`${TLD}0`, TERMS, `${TLD}2`]) {
		await sql.unsafe('DELETE FROM matrix_time_machine WHERE section_tipo = $1', [sectionTipo]);
		await sql.unsafe('DELETE FROM matrix_counter WHERE tipo = $1', [sectionTipo]);
	}
	await sql.unsafe(
		`DELETE FROM matrix_ontology_main WHERE section_tipo = 'ontology35' AND string @> $1::text::jsonb`,
		[JSON.stringify({ hierarchy6: [{ value: TLD }] })],
	);
	const registry = (await sql.unsafe(
		`SELECT section_id FROM matrix_hierarchy_main WHERE section_tipo = 'hierarchy1' AND string @> $1::text::jsonb`,
		[JSON.stringify({ hierarchy6: [{ value: TLD }] })],
	)) as { section_id: number }[];
	const ids = new Set(registry.map((row) => Number(row.section_id)));
	if (hierarchyId !== 0) ids.add(hierarchyId);
	for (const id of ids) {
		await sql.unsafe(
			`DELETE FROM matrix_hierarchy_main WHERE section_tipo = 'hierarchy1' AND section_id = $1`,
			[id],
		);
		await sql.unsafe(
			`DELETE FROM matrix_time_machine WHERE section_tipo = 'hierarchy1' AND section_id = $1`,
			[id],
		);
	}
	await sql.unsafe('DELETE FROM matrix_test WHERE section_tipo = $1 AND section_id = $2', [
		HOST,
		HOST_ID,
	]);
	await sql.unsafe('DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2', [
		HOST,
		HOST_ID,
	]);
	// The dd542 activity rows the save chokepoint writes for the scratch host.
	await sql.unsafe(
		`DELETE FROM matrix_activity
		 WHERE section_tipo = 'dd542'
		   AND misc->'dd551'->0->'value'->>'section_id' = $1
		   AND misc->'dd551'->0->'value'->>'section_tipo' = $2`,
		[String(HOST_ID), HOST],
	);
	for (const identity of [provisioner, ungranted, filterEditor, treeEditor]) {
		if (identity === undefined) continue;
		for (const [table, sectionTipo, sectionId] of [
			['matrix_profiles', 'dd234', identity.profileId],
			['matrix_users', 'dd128', identity.userId],
		] as [string, string, number][]) {
			await sql.unsafe(`DELETE FROM "${table}" WHERE section_tipo = $1 AND section_id = $2`, [
				sectionTipo,
				sectionId,
			]);
			await sql.unsafe(
				'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
				[sectionTipo, sectionId],
			);
		}
	}
	await clearOntologyDerivedCaches();
}

/** The caller context both insert doors share, for a scratch portal caller. */
const context = (componentTipo: string, existingItems: unknown[] = []): RelationInsertContext => ({
	componentTipo,
	model: 'component_portal',
	hostSectionTipo: HOST,
	hostSectionId: HOST_ID,
	translatable: false,
	lang: 'lg-nolan',
	existingItems,
});

/**
 * Run the door inside a request scope. Identity is ALS-scoped and read PER
 * CALL by the door itself, so the principal must ride the scope — never a
 * parameter and never module state.
 */
function asPrincipal<T>(principal: Principal | undefined, fn: () => Promise<T>): Promise<T> {
	return runWithRequestContext(
		{ principal, session: null, requestId: 'relation_insert_target_gate', clientIp: '127.0.0.1' },
		fn,
	);
}

/** `[status, code]` per outcome — the compact shape most cases assert on. */
const codes = (result: RelationInsertBatchResult) =>
	result.outcomes.map((outcome) => [outcome.status, outcome.code ?? null]);

/**
 * Send changed_data through the REAL save path (not the door in isolation), as
 * the superuser unless an identity is given. Answers the wire status and the
 * envelope's error code (null on success) — a refusal is asserted on BOTH.
 */
async function saveChanges(
	componentTipo: string,
	changedData: { action: string; id: null; value: unknown }[],
	as: { principal: Principal; userId: number } = { principal: superuser, userId: -1 },
): Promise<{ status: number; code: string | null }> {
	const token = createSession(as.userId, `insert_gate_${as.userId}`, as.userId === -1);
	const session = getSession(token);
	const dispatched = await dispatchRqo(
		{
			action: 'save',
			dd_api: 'dd_core_api',
			prevent_lock: true,
			source: {
				typo: 'source',
				type: 'component',
				model: 'component_portal',
				tipo: componentTipo,
				section_tipo: HOST,
				section_id: String(HOST_ID),
				mode: 'edit',
				lang: 'lg-nolan',
				action: null,
			},
			data: {
				section_id: String(HOST_ID),
				section_tipo: HOST,
				tipo: componentTipo,
				lang: 'lg-nolan',
				from_component_tipo: componentTipo,
				changed_data: changedData,
			},
		} as never,
		{
			requestId: 'relation_insert_target_gate',
			clientIp: '127.0.0.1',
			session,
			csrfCandidate: session?.csrfToken ?? null,
			principal: as.principal,
		} as never,
	);
	const body = dispatched.body as { error?: { code?: string } };
	return { status: dispatched.status, code: body.error?.code ?? null };
}

/** Insert locators through the save path; answers the wire status. */
async function saveInserts(
	componentTipo: string,
	values: Record<string, unknown>[],
	as?: { principal: Principal; userId: number },
): Promise<number> {
	const answer = await saveChanges(
		componentTipo,
		values.map((value) => ({ action: 'insert', id: null, value })),
		as,
	);
	return answer.status;
}

/** What the host record actually holds for a component, straight from jsonb. */
async function storedLocators(componentTipo: string): Promise<Record<string, unknown>[]> {
	const rows = (await sql.unsafe(
		'SELECT relation->$1 AS items FROM matrix_test WHERE section_tipo = $2 AND section_id = $3',
		[componentTipo, HOST, HOST_ID],
	)) as { items: Record<string, unknown>[] | null }[];
	return rows[0]?.items ?? [];
}

beforeAll(async () => {
	if (!DB_READY) return;
	await purgeScratch();

	const occupied = (await sql.unsafe(
		'SELECT section_id FROM matrix_test WHERE section_tipo = $1 AND section_id = $2',
		[HOST, HOST_ID],
	)) as unknown[];
	if (occupied.length > 0) {
		throw new Error(
			`relation insert gate: ${HOST}/${HOST_ID} is occupied after the sweep — refusing to write over a record this gate did not create.`,
		);
	}

	provisioner = await buildIdentity([]);
	ungranted = await buildIdentity([]);
	// Member of BOTH projects: the pick below must be one of the editor's OWN
	// projects — a non-member pick is refused by gate 2b (D2; its own gate is
	// filter_project_pick_native.test.ts).
	filterEditor = await buildIdentity(
		[{ tipo: HOST_FILTER, section_tipo: HOST, value: 2 }],
		[PROJECT_HELD, PROJECT_PICKED],
	);
	treeEditor = await buildIdentity([{ tipo: TREE, section_tipo: HOST, value: 2 }], [PROJECT_HELD]);
	superuser = await resolvePrincipal(-1);

	hierarchyId = await createSectionRecord('hierarchy1', provisioner.userId);
	const registry = (column: 'string' | 'relation', tipo: string, value: unknown) =>
		updateMatrixKeyData('matrix_hierarchy_main', 'hierarchy1', hierarchyId, column, tipo, value);
	await registry('string', 'hierarchy6', [{ id: 1, lang: 'lg-nolan', value: TLD }]);
	await registry('string', 'hierarchy5', [{ id: 1, lang: 'lg-spa', value: 'ZZ insert scratch' }]);
	await registry('relation', 'hierarchy9', [
		{
			type: 'dd151',
			section_tipo: 'hierarchy13',
			section_id: '1',
			from_component_tipo: 'hierarchy9',
		},
	]);
	const provisioned = await ensureHierarchy(hierarchyId, provisioner.userId);
	if (!provisioned.ok) {
		throw new Error(
			`relation insert gate: the scratch thesaurus did not provision (${provisioned.msg}; ${provisioned.errors.join('; ')}) — the selectability cases below would be vacuous.`,
		);
	}
	// The NON-selectable sibling of the provisioned root term (flag NO).
	unselectableTermId = await createSectionRecord(TERMS, provisioner.userId);
	await updateMatrixKeyData(
		'matrix_hierarchy',
		TERMS,
		unselectableTermId,
		'relation',
		'hierarchy24',
		siNo('hierarchy24', false),
	);

	await buildCallerNode(PLAIN, { source: targetConfig(HOST) });
	await buildCallerNode(VIRTUAL, { source: targetConfig('testheritagecatalog1') });
	await buildCallerNode(TREE, { view: 'tree', source: targetConfig(TERMS) });
	await buildCallerNode(CAPPED, { data_limit: 2, source: targetConfig(HOST) });
	await buildCallerNode(FORBIDDEN, { data_limit: 0, source: targetConfig(HOST) });
	await buildCallerNode(THESAURUS_PLAIN, { source: targetConfig(TERMS) });
	await buildCallerNode(FRAMED, { data_limit: 1, source: targetConfig(HOST) });
	// The TOOL-DECLARED source shape (tool_indexation's live one): a ddo_map
	// pairing a SECTION the operator picks from with the component the tool
	// publishes those picks into. The stored map carries no `model` key — the
	// index resolves each tipo's model from the ontology exactly as
	// enrichToolConfig does for the wire — and the pair is matched by ROLE,
	// from `src/core/tools/picker_wiring.ts`.
	await buildCallerNode(TOOL_LINKED, { source: targetConfig(HOST) });
	await buildCallerNode(TOOL_UNWIRED_PORTAL, { source: targetConfig(HOST) });
	await buildCallerNode(TOOL_LINKED_FREE, {});
	await buildCallerNode(TOOL_SIBLING_SELECT, { source: targetConfig(HOST) }, 'component_select');
	/** The people_section entry every carrier below pairs against. */
	const peopleSource = {
		role: 'people_section',
		tipo: OFF_TARGET_SECTION,
		section_tipo: OFF_TARGET_SECTION,
		mode: 'list_thesaurus',
		view: 'thesaurus_list',
	};
	const carrier = (ddoMap: Record<string, unknown>[]) => ({
		tool_config: { tool_indexation: { ddo_map: ddoMap } },
	});
	await buildCallerNode(
		TOOL_CARRIER,
		carrier([
			{ role: 'transcription_component', tipo: 'self', section_tipo: 'self' },
			{ role: 'indexing_component', tipo: TOOL_LINKED, section_tipo: 'self' },
			// A PORTAL in a role the tool never publishes into (the live rsc1368
			// shape) — present precisely so the pairing cannot be a cross-product.
			{ role: 'references_component', tipo: TOOL_UNWIRED_PORTAL, section_tipo: 'self' },
			peopleSource,
		]),
	);
	// The exemption's carrier: a wired linker that declares no target of its own.
	await buildCallerNode(
		TOOL_CARRIER_FREE,
		carrier([
			{ role: 'indexing_component', tipo: TOOL_LINKED_FREE, section_tipo: 'self' },
			peopleSource,
		]),
	);
	// The family's carrier: the WIRED role, held by a component whose value comes
	// from its own option list rather than from a browsed record.
	await buildCallerNode(
		TOOL_CARRIER_SELECT,
		carrier([
			{ role: 'indexing_component', tipo: TOOL_SIBLING_SELECT, section_tipo: 'self' },
			peopleSource,
		]),
	);
	await sql.unsafe('INSERT INTO matrix_test (section_id, section_tipo) VALUES ($1, $2)', [
		HOST_ID,
		HOST,
	]);
	// The host sits in PROJECT_HELD, so the two project-scoped identities pass
	// dispatch's per-record scope gate (isRecordInScope) on their way to the door.
	await updateMatrixKeyData('matrix_test', HOST, HOST_ID, 'relation', HOST_FILTER, [
		{
			id: 1,
			type: 'dd151',
			section_tipo: PROJECTS,
			section_id: PROJECT_HELD,
			from_component_tipo: HOST_FILTER,
		},
	]);
	await clearOntologyDerivedCaches();
}, 180000);

afterAll(async () => {
	if (!DB_READY) return;
	await purgeScratch();
});

describe.if(DB_READY)('the insert door — the TARGET constraint', () => {
	test('a locator inside the caller’s declared target is ACCEPTED', async () => {
		const result = await asPrincipal(superuser, () =>
			validateRelationInserts([{ section_tipo: HOST, section_id: IN_TARGET[0] }], context(PLAIN)),
		);
		expect(codes(result)).toEqual([['accepted', null]]);
		expect(result.total).toBe(1);
		// The accepted VALUE is the normalized locator the caller will persist.
		expect(result.outcomes[0]?.value?.from_component_tipo).toBe(PLAIN);
	});

	test('a locator OUTSIDE it is refused, naming the code and the declaration', async () => {
		const result = await asPrincipal(superuser, () =>
			validateRelationInserts(
				[{ section_tipo: OFF_TARGET_SECTION, section_id: 1 }],
				context(PLAIN),
			),
		);
		expect(codes(result)).toEqual([['refused', 'off_target']]);
		expect(result.total).toBe(0);
		expect(result.outcomes[0]?.reason).toContain(OFF_TARGET_SECTION);
		expect(result.outcomes[0]?.reason).toContain(HOST);
	});

	test('a VIRTUAL section is accepted against its real target (test7007 → testheritagecatalog1)', async () => {
		// The comparison law resolves BOTH sides, so a caller declaring the real
		// section and a locator naming the virtual one are the same thing.
		const result = await asPrincipal(superuser, () =>
			validateRelationInserts([{ section_tipo: 'test7007', section_id: 1 }], context(VIRTUAL)),
		);
		expect(codes(result)).toEqual([['accepted', null]]);
	});

	test('a DIFFERENT thesaurus is NOT a target just because it shares a real section', async () => {
		// Every thesaurus is a virtual section over hierarchy20 (test2827 and the
		// scratch one alike). A caller that declares ONE thesaurus must not accept
		// a term from another: the whole point of the declaration is which
		// vocabulary this component links into.
		//
		// THE LAW: `off_target`. `relations/picker_constraint.ts` keeps the
		// declared targets AS DECLARED and `isTargetAllowed` resolves only ONE
		// side per comparison (never real-vs-real), so test2827 against a caller
		// declaring the scratch thesaurus is refused although both are virtual
		// over hierarchy20. (History: before the asymmetric comparison landed —
		// commit 625f17e7b3 — both sides real-resolved to 'hierarchy20' and this
		// was ACCEPTED, the write-path face of the picker read's collapse. That
		// is the bug, not the expectation.)
		const result = await asPrincipal(superuser, () =>
			validateRelationInserts(
				[{ section_tipo: 'test2827', section_id: 1 }],
				context(THESAURUS_PLAIN),
			),
		);
		expect(codes(result)).toEqual([['refused', 'off_target']]);
		// …and its OWN thesaurus still passes, so this is a narrowing, not a wall.
		const own = await asPrincipal(superuser, () =>
			validateRelationInserts([{ section_tipo: TERMS, section_id: 1 }], context(THESAURUS_PLAIN)),
		);
		expect(codes(own)).toEqual([['accepted', null]]);
	});

	test('a TOOL-declared picker source is a target of the role the tool publishes into', async () => {
		// THE SECOND DECLARATION CHANNEL. tool_indexation pairs its
		// `indexing_component` (rsc860 live) with a `people_section` the operator
		// picks from (rsc197) and assigns people_section.linker =
		// indexing_component in JS. The component's OWN request_config names
		// hierarchies only, so gate 1 refused (`off_target`) a link the tool
		// exists to make while the client offered the affordance from the same
		// tool_config it had been served. The write door reads that declaration
		// too, from the same ontology bytes — paired by ROLE, through
		// `src/core/tools/picker_wiring.ts`.
		const result = await asPrincipal(superuser, () =>
			validateRelationInserts(
				[{ section_tipo: OFF_TARGET_SECTION, section_id: 1 }],
				context(TOOL_LINKED),
			),
		);
		expect(codes(result)).toEqual([['accepted', null]]);
		// …and its OWN declared target still passes: the tool source is a UNION,
		// never a replacement.
		const declared = await asPrincipal(superuser, () =>
			validateRelationInserts(
				[{ section_tipo: HOST, section_id: IN_TARGET[0] }],
				context(TOOL_LINKED),
			),
		);
		expect(codes(declared)).toEqual([['accepted', null]]);
	});

	test('a component in NO tool ddo_map is still refused that section', async () => {
		// The control that keeps the case above from being vacuous: PLAIN declares
		// the same target as TOOL_LINKED and differs ONLY in the tool wiring, so
		// the acceptance is the tool declaration and nothing else. (Asserted as
		// its own case in the off-target test above; repeated here as the pair.)
		const result = await asPrincipal(superuser, () =>
			validateRelationInserts(
				[{ section_tipo: OFF_TARGET_SECTION, section_id: 1 }],
				context(PLAIN),
			),
		);
		expect(codes(result)).toEqual([['refused', 'off_target']]);
	});

	test('a PORTAL in an unwired role of the same map gains NOTHING (no cross-product)', async () => {
		// The live shape this closes: tool_indexation's map also holds
		// `references_component` (rsc1368), a portal that DISPLAYS inverse
		// references and that the tool never publishes a pick into. Pairing every
		// section in a map with every relation component in it would have handed
		// it the people section as a write target — a widening nobody declared.
		const result = await asPrincipal(superuser, () =>
			validateRelationInserts(
				[{ section_tipo: OFF_TARGET_SECTION, section_id: 1 }],
				context(TOOL_UNWIRED_PORTAL),
			),
		);
		expect(codes(result)).toEqual([['refused', 'off_target']]);
	});

	test('the WIRED role held by a NON-picker model gains nothing either', async () => {
		// TOOL_SIBLING_SELECT holds the wired `indexing_component` role, and a
		// select stores in the relation column too — but its value comes from its
		// OWN option list, never from a browsed record. Granting it the source
		// would let a forged save park a person locator in a status field, the
		// exact class gate 1 exists to refuse.
		const result = await asPrincipal(superuser, () =>
			validateRelationInserts([{ section_tipo: OFF_TARGET_SECTION, section_id: 1 }], {
				...context(TOOL_SIBLING_SELECT),
				model: 'component_select',
			}),
		);
		expect(codes(result)).toEqual([['refused', 'off_target']]);
	});

	test('a caller that declares NO target keeps the exemption — the tool source does not constrain it', async () => {
		// An empty target set is "no target constraint exists", and unioning a
		// tool source into it would INVENT one: every section but that source
		// would start refusing. TOOL_LINKED_FREE holds the WIRED role in its own
		// carrier — so the index really would have widened it — and declares no
		// request_config, so a locator into a THIRD section must still be accepted.
		const result = await asPrincipal(superuser, () =>
			validateRelationInserts(
				[{ section_tipo: HOST, section_id: IN_TARGET[0] }],
				context(TOOL_LINKED_FREE),
			),
		);
		expect(codes(result)).toEqual([['accepted', null]]);
	});
});

describe.if(DB_READY)(
	'the insert door — NO read grant on the linked section (owner decision (i))',
	() => {
		// WC-2026-08-14-relation-insert-target-validation addendum item 1 is
		// SUPERSEDED (owner decision (i), 2026-11-03 —
		// WC-2026-11-04-tree-picker-read-gate-retired): the tree
		// picker's read-grant gate (target_not_readable) and the area tree prune
		// flipped together. A user who can WRITE a view:'tree' component browses its
		// target read-only through the component's verified caller chain and saves
		// the locator like any portal / autocomplete pick — authorization IS the
		// caller grant, exactly as PHP (no save-time target read grant).
		test('a TREE-PICKER caller: a principal with no read on the thesaurus PERSISTS a term', async () => {
			// `ungranted` holds 0 on the scratch thesaurus, and term 1 is the
			// SELECTABLE root — the gates that remain (target, selectability, cap)
			// all pass, and no read-grant gate refuses any more.
			expect(ungranted).toBeDefined();
			const accepted = await asPrincipal(ungranted?.principal, () =>
				validateRelationInserts([{ section_tipo: TERMS, section_id: 1 }], context(TREE)),
			);
			expect(codes(accepted)).toEqual([['accepted', null]]);

			// The CONTROL: the identical locator for a principal that may read the
			// section — the same verdict, so the grant is no longer an input.
			const control = await asPrincipal(superuser, () =>
				validateRelationInserts([{ section_tipo: TERMS, section_id: 1 }], context(TREE)),
			);
			expect(codes(control)).toEqual([['accepted', null]]);
		});

		test('a NON-picker caller is authorized by the CALLER grant — the target is not re-judged', async () => {
			// The read model for a portal/autocomplete/filter: a value reached
			// THROUGH an authorized caller is floored to read
			// (inheritSubdatumPermission); the actor may hold 0 on the target
			// section and still see and pick its records. Dispatch enforced >= 2 on
			// the caller before this door; judging the target here refused every
			// non-admin's own project pick (component_filter → dd153).
			const result = await asPrincipal(ungranted?.principal, () =>
				validateRelationInserts([{ section_tipo: HOST, section_id: IN_TARGET[0] }], context(PLAIN)),
			);
			expect(codes(result)).toEqual([['accepted', null]]);
		});

		test('a credless picker insert (no actor) is no longer refused by a read gate; the TARGET gate still judges it', async () => {
			// No threaded principal and no request scope: the retired gate refused
			// this fail-closed. Now the remaining gates decide — the declared target
			// is honoured (an in-target term is accepted) …
			const noActor = await validateRelationInserts(
				[{ section_tipo: TERMS, section_id: 1 }],
				context(TREE),
			);
			expect(codes(noActor)).toEqual([['accepted', null]]);
			// … and an off-target section is still refused by name (gate 1).
			const offTarget = await validateRelationInserts(
				[{ section_tipo: HOST, section_id: IN_TARGET[0] }],
				context(TREE),
			);
			expect(codes(offTarget)).toEqual([['refused', 'off_target']]);
		});

		test('a non-admin with level 2 on a component_filter and 0 on dd153 PERSISTS a project pick', async () => {
			// The shape every install has: the profile grants the filter component,
			// never the projects section; the datalist is built from the user's OWN
			// authorized projects (filter_projects.ts). Through the REAL save door,
			// as that user (dispatch enforces >= 2 on the filter and the per-record
			// projects scope, which the seeded PROJECT_HELD locator satisfies).
			expect(filterEditor).toBeDefined();
			const editor = filterEditor as Identity;
			const { getPermissions } = await import('../../src/core/security/permissions.ts');
			expect(await getPermissions(editor.principal, HOST, HOST_FILTER)).toBe(2);
			expect(await getPermissions(editor.principal, PROJECTS, PROJECTS)).toBe(0);
			expect((await storedLocators(HOST_FILTER)).map((l) => l.section_id)).toEqual([PROJECT_HELD]);

			const status = await saveInserts(
				HOST_FILTER,
				[{ section_tipo: PROJECTS, section_id: PROJECT_PICKED }],
				{ principal: editor.principal, userId: editor.userId },
			);
			expect(status).toBe(200);
			const stored = await storedLocators(HOST_FILTER);
			expect(stored.map((locator) => locator.section_id)).toEqual([PROJECT_HELD, PROJECT_PICKED]);
			expect(stored[1]?.from_component_tipo).toBe(HOST_FILTER);
		});
	},
);

describe.if(DB_READY)('the insert door — SELECTABILITY is re-asked at the write', () => {
	test('a non-selectable term is refused even though the client sent it', async () => {
		// A rendered affordance is not an authorization: the tree may be stale,
		// forged or simply bypassed, so the term's own flag is read again here.
		const refused = await asPrincipal(superuser, () =>
			validateRelationInserts(
				[{ section_tipo: TERMS, section_id: unselectableTermId }],
				context(TREE),
			),
		);
		expect(codes(refused)).toEqual([['refused', 'term_not_selectable']]);
		expect(refused.outcomes[0]?.reason).toContain(TERMS);

		// The CONTROL: the SELECTABLE sibling, same caller, same section, accepted.
		const accepted = await asPrincipal(superuser, () =>
			validateRelationInserts([{ section_tipo: TERMS, section_id: 1 }], context(TREE)),
		);
		expect(codes(accepted)).toEqual([['accepted', null]]);
	});
});

describe.if(DB_READY)('the insert door — the SELECTION CAP (properties.data_limit)', () => {
	test('data_limit ABSENT means uncapped — absence is not zero', async () => {
		const result = await asPrincipal(superuser, () =>
			validateRelationInserts(
				[1, 2, 27, 3, 4].map((id) => ({ section_tipo: HOST, section_id: id })),
				context(PLAIN),
			),
		);
		expect(codes(result).every(([status]) => status === 'accepted')).toBe(true);
		expect(result.total).toBe(5);
	});

	test('a literal data_limit 0 means NONE may be linked', async () => {
		// The client's `if (data_limit && …)` guard reads 0 as "no limit" (JS
		// truthiness). The server does not: 0 is an answer.
		const result = await asPrincipal(superuser, () =>
			validateRelationInserts(
				[{ section_tipo: HOST, section_id: IN_TARGET[0] }],
				context(FORBIDDEN),
			),
		);
		expect(codes(result)).toEqual([['refused', 'selection_limit']]);
		expect(result.total).toBe(0);
	});

	test('an insert past the cap is refused, naming the limit', async () => {
		const result = await asPrincipal(superuser, () =>
			validateRelationInserts([{ section_tipo: HOST, section_id: 27 }], {
				...context(CAPPED),
				// The component already holds its two.
				existingItems: [
					{ section_id: 1, section_tipo: HOST, type: 'dd151', from_component_tipo: CAPPED },
					{ section_id: 2, section_tipo: HOST, type: 'dd151', from_component_tipo: CAPPED },
				],
			}),
		);
		expect(codes(result)).toEqual([['refused', 'selection_limit']]);
		expect(result.outcomes[0]?.reason).toContain('2');
	});
});

describe.if(DB_READY)('the insert door — a BATCH is validated as a SET', () => {
	test('one off-target entry in a batch of three commits the other two and names it', async () => {
		const result = await asPrincipal(superuser, () =>
			validateRelationInserts(
				[
					{ section_tipo: HOST, section_id: IN_TARGET[0] },
					{ section_tipo: OFF_TARGET_SECTION, section_id: 9 },
					{ section_tipo: HOST, section_id: IN_TARGET[1] },
				],
				context(PLAIN),
			),
		);
		// Outcomes are per entry, in SUBMISSION order — never a compacted list.
		expect(codes(result)).toEqual([
			['accepted', null],
			['refused', 'off_target'],
			['accepted', null],
		]);
		expect(result.total).toBe(2);
		expect(result.outcomes[1]?.locator.section_tipo).toBe(OFF_TARGET_SECTION);
	});

	test('a batch that collectively exceeds data_limit refuses ONLY the overflow', async () => {
		// The reason the cap lives on the batch and not on the request: three
		// picks each individually under a limit of 2 collectively break it.
		const result = await asPrincipal(superuser, () =>
			validateRelationInserts(
				IN_TARGET.map((id) => ({ section_tipo: HOST, section_id: id })),
				context(CAPPED),
			),
		);
		expect(codes(result)).toEqual([
			['accepted', null],
			['accepted', null],
			['refused', 'selection_limit'],
		]);
		expect(result.total).toBe(2);
	});

	test('a duplicate of an already stored row DEDUPS — refused, named, and not an error', async () => {
		const stored = {
			section_id: IN_TARGET[0],
			section_tipo: HOST,
			type: 'dd151',
			from_component_tipo: PLAIN,
		};
		const result = await asPrincipal(superuser, () =>
			validateRelationInserts(
				[
					{ section_tipo: HOST, section_id: IN_TARGET[0] },
					{ section_tipo: HOST, section_id: IN_TARGET[1] },
				],
				context(PLAIN, [stored]),
			),
		);
		expect(codes(result)).toEqual([
			['refused', 'duplicate'],
			['accepted', null],
		]);
		// The row set grew by exactly the one new entry — the duplicate neither
		// threw nor counted.
		expect(result.total).toBe(2);
	});

	test('two identical picks WITHIN one batch collapse, exactly as two saves would', async () => {
		const result = await asPrincipal(superuser, () =>
			validateRelationInserts(
				[
					{ section_tipo: HOST, section_id: IN_TARGET[0] },
					{ section_tipo: HOST, section_id: IN_TARGET[0] },
				],
				context(PLAIN),
			),
		);
		expect(codes(result)).toEqual([
			['accepted', null],
			['refused', 'duplicate'],
		]);
		expect(result.total).toBe(1);
	});
});

describe.if(DB_READY)(
	'the insert door — the RE-PERSIST baseline (storedItems) is a data-integrity control',
	() => {
		// A `set_data` replays the WHOLE stored array through the door (CSV import,
		// raw-export round trip). The gates police GROWTH: a locator the component
		// already holds must survive every gate even when the world has moved under
		// it — else an unrelated save silently deletes heritage data and reports
		// success. Each case pairs the stored form (accepted) with its control
		// (`storedItems: []`, refused), so a broken baseline reddens here.
		const offTarget = { section_tipo: OFF_TARGET_SECTION, section_id: 1 };

		test('an OFF-TARGET locator is accepted when already stored, refused when net-new', async () => {
			const stored = await asPrincipal(superuser, () =>
				validateRelationInserts([offTarget], {
					...context(PLAIN),
					storedItems: [{ ...offTarget, type: 'dd151', from_component_tipo: PLAIN }],
				}),
			);
			expect(codes(stored)).toEqual([['accepted', null]]);
			const netNew = await asPrincipal(superuser, () =>
				validateRelationInserts([offTarget], { ...context(PLAIN), storedItems: [] }),
			);
			expect(codes(netNew)).toEqual([['refused', 'off_target']]);
		});

		test('a NON-SELECTABLE term is accepted when already stored, refused when net-new', async () => {
			const term = { section_tipo: TERMS, section_id: unselectableTermId };
			const stored = await asPrincipal(superuser, () =>
				validateRelationInserts([term], {
					...context(TREE),
					storedItems: [{ ...term, type: 'dd151', from_component_tipo: TREE }],
				}),
			);
			expect(codes(stored)).toEqual([['accepted', null]]);
			const netNew = await asPrincipal(superuser, () =>
				validateRelationInserts([term], { ...context(TREE), storedItems: [] }),
			);
			expect(codes(netNew)).toEqual([['refused', 'term_not_selectable']]);
		});

		test('an OVER-CAP locator is accepted when already stored, refused when net-new', async () => {
			// FORBIDDEN declares data_limit 0: nothing may be ADDED, but a locator
			// stored before the cap tightened is written back untouched.
			const held = { section_tipo: HOST, section_id: IN_TARGET[0] };
			const stored = await asPrincipal(superuser, () =>
				validateRelationInserts([held], {
					...context(FORBIDDEN),
					storedItems: [{ ...held, type: 'dd151', from_component_tipo: FORBIDDEN }],
				}),
			);
			expect(codes(stored)).toEqual([['accepted', null]]);
			const netNew = await asPrincipal(superuser, () =>
				validateRelationInserts([held], { ...context(FORBIDDEN), storedItems: [] }),
			);
			expect(codes(netNew)).toEqual([['refused', 'selection_limit']]);
		});

		test('the baseline match is the LOCATOR LAW: section_id loose-numeric ("05" IS 5), tipo strict', async () => {
			// isAlreadyStored compares through compareLocators, NOT the key-string
			// membership test (which stringifies: '05' ≠ '5'). A pre-sweep string
			// id, or an int-vs-string difference between the stored bytes and the
			// canonicalized incoming value, must still read as "already stored" —
			// otherwise a stored link is re-judged and can be dropped.
			const stored = await asPrincipal(superuser, () =>
				validateRelationInserts([{ section_tipo: OFF_TARGET_SECTION, section_id: 5 }], {
					...context(PLAIN),
					storedItems: [{ section_tipo: OFF_TARGET_SECTION, section_id: '05', type: 'dd151' }],
				}),
			);
			expect(codes(stored)).toEqual([['accepted', null]]);
			// The tipo is NOT loose: a different section with the same id is net-new.
			const otherSection = await asPrincipal(superuser, () =>
				validateRelationInserts([{ section_tipo: OFF_TARGET_SECTION, section_id: 5 }], {
					...context(PLAIN),
					storedItems: [{ section_tipo: `${OFF_TARGET_SECTION}x`, section_id: 5, type: 'dd151' }],
				}),
			);
			expect(codes(otherSection)).toEqual([['refused', 'off_target']]);
		});

		test('SAVE PATH: a set_data replay keeps a stored over-cap locator and adds none', async () => {
			// Seed FORBIDDEN (data_limit 0) with one locator directly — the state a
			// tightened cap leaves behind — then replay it through the real save.
			const held = {
				id: 1,
				type: 'dd151',
				section_tipo: HOST,
				section_id: IN_TARGET[0],
				from_component_tipo: FORBIDDEN,
			};
			await updateMatrixKeyData('matrix_test', HOST, HOST_ID, 'relation', FORBIDDEN, [held]);
			const replay = await saveChanges(FORBIDDEN, [
				{ action: 'set_data', id: null, value: [held] },
			]);
			expect(replay.status).toBe(200);
			expect((await storedLocators(FORBIDDEN)).map((l) => l.section_id)).toEqual([IN_TARGET[0]]);

			// The same replay carrying ONE net-new locator is refused as a whole
			// (the door throws, the transaction rolls back): the stored one stays,
			// nothing is added — growth is what the cap forbids.
			const grown = await saveChanges(FORBIDDEN, [
				{
					action: 'set_data',
					id: null,
					value: [held, { section_tipo: HOST, section_id: IN_TARGET[1] }],
				},
			]);
			expect(grown.status).toBe(400);
			expect(grown.code).toBe('relation.insert_refused');
			expect((await storedLocators(FORBIDDEN)).map((l) => l.section_id)).toEqual([IN_TARGET[0]]);
		});
	},
);

describe.if(DB_READY)(
	'the insert door — a DATAFRAME cap counts per MAIN ITEM on BOTH sides',
	() => {
		const frame = (idKey: number, sectionId: number) => ({
			id: idKey,
			type: 'dd490',
			section_tipo: HOST,
			section_id: sectionId,
			from_component_tipo: FRAMED,
			main_component_tipo: FRAMED_MAIN,
			id_key: idKey,
		});
		const pairingFor = (idKey: number) => ({
			frameTipo: FRAMED,
			mainComponentTipo: FRAMED_MAIN,
			idKey,
		});

		test('a second frame on item A is refused at data_limit 1 even though the slot holds other items’ frames', async () => {
			// The slot holds one frame for item 1 and one for item 2. `held` used to
			// be the SLOT count (2), so item 1 growing to two frames (resulting 2)
			// failed the growth clause (2 > 2 is false) and was ACCEPTED. Both sides
			// now count in the pairing scope: held 1, resulting 2 → refused.
			const [targetA, targetB] = IN_TARGET as [number, number, number];
			await updateMatrixKeyData('matrix_test', HOST, HOST_ID, 'relation', FRAMED, [
				frame(1, targetA),
				frame(2, targetB),
			]);
			const refused = await asPrincipal(superuser, () =>
				validateRelationInserts([{ section_tipo: HOST, section_id: 27 }], {
					...context(FRAMED),
					model: 'component_dataframe',
					// The caller's frame subset (what save_component hands in).
					existingItems: [frame(1, targetA)],
					pairing: pairingFor(1),
				}),
			);
			expect(codes(refused)).toEqual([['refused', 'selection_limit']]);

			// The CONTROL: item 3 holds no frame yet — its first frame is accepted,
			// the slot-wide count of 2 notwithstanding (one frame PER ITEM).
			const accepted = await asPrincipal(superuser, () =>
				validateRelationInserts([{ section_tipo: HOST, section_id: 27 }], {
					...context(FRAMED),
					model: 'component_dataframe',
					existingItems: [],
					pairing: pairingFor(3),
				}),
			);
			expect(codes(accepted)).toEqual([['accepted', null]]);
			expect(accepted.outcomes[0]?.value?.id_key).toBe(3);
		});
	},
);

describe.if(DB_READY)('the insert door — wired into the SAVE path, under concurrency', () => {
	test('an off-target locator sent through the save API stores NOTHING and is REFUSED on the wire', async () => {
		// The door in isolation is not the contract; the contract is that no save
		// route reaches the matrix around it — and that the refusal is NAMED to
		// the caller. A 200-with-nothing-stored was the silent success the
		// operator saw as a vanished chip.
		const answer = await saveChanges(PLAIN, [
			{ action: 'insert', id: null, value: { section_tipo: OFF_TARGET_SECTION, section_id: 1 } },
		]);
		expect(answer.status).toBe(400);
		expect(answer.code).toBe('relation.insert_refused');
		expect(await storedLocators(PLAIN)).toEqual([]);

		// The tree picker's read-grant refusal is RETIRED (owner decision (i),
		// 2026-11-03): `treeEditor` passes dispatch's own gate (level 2 on the
		// picker caller, host in scope) and, holding 0 on the thesaurus, now
		// PERSISTS the selectable term through the same route — the caller grant
		// is the authorization.
		const editor = treeEditor as Identity;
		expect(await storedLocators(TREE)).toEqual([]);
		const picked = await saveChanges(
			TREE,
			[{ action: 'insert', id: null, value: { section_tipo: TERMS, section_id: 1 } }],
			{ principal: editor.principal, userId: editor.userId },
		);
		expect(picked.status).toBe(200);
		expect(picked.code).toBeNull();
		expect((await storedLocators(TREE)).map((locator) => locator.section_tipo)).toEqual([TERMS]);

		// The CONTROL: an in-target locator through the same route DOES store.
		await saveInserts(PLAIN, [{ section_tipo: HOST, section_id: IN_TARGET[0] }]);
		const stored = await storedLocators(PLAIN);
		expect(stored.length).toBe(1);
		expect(stored[0]?.section_tipo).toBe(HOST);
	});

	test('two batches racing the same component do not JOINTLY exceed data_limit', async () => {
		// Each batch is legal on its own (2 ≤ 2). Only the row lock the save
		// chokepoint takes — plus the cap being re-resolved INSIDE that
		// transaction — stops them from landing four rows between them.
		expect((await storedLocators(CAPPED)).length).toBe(0);
		await Promise.all([
			saveInserts(CAPPED, [
				{ section_tipo: HOST, section_id: 1 },
				{ section_tipo: HOST, section_id: 2 },
			]),
			saveInserts(CAPPED, [
				{ section_tipo: HOST, section_id: 27 },
				{ section_tipo: HOST, section_id: 3 },
			]),
		]);
		expect((await storedLocators(CAPPED)).length).toBe(2);
	}, 60000);
});
