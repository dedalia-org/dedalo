/**
 * THE PICKER READ — `rqo.source.caller` in, server-DERIVED mode + narrowing +
 * per-term affordance out (engineering/AREA_SPEC.md §5, picker plan step 1).
 *
 * WHAT THIS GATE IS FOR. Every conclusion the old PHP handshake let the CLIENT
 * declare — `thesaurus_mode`, `hierarchy_sections`, `hierarchy_types` — is now
 * derived by the server from ONE declared address. So the whole contract is a
 * set of derivations, and a derivation with no gate is a rule that will rot back
 * into "whatever the request said". Each case below pins exactly one of them.
 *
 * WHY IT BUILDS ITS OWN THESAURUS. The live picker declarations (oh115, oh126,
 * rsc1057…) sit on OPERATOR-MUTABLE records and hierarchies: an operator who
 * renames a term, flips an `is_indexable` flag or deactivates a country would
 * turn this file red for a reason that is not a regression. So the fixture is
 * self-provisioned: a scratch hierarchy through `ontology/hierarchy_state.ts
 * ensureHierarchy` — THE single writer (it defaults the source section to
 * hierarchy20, provisions the `<tld>0/1/2` nodes, flags active +
 * active_in_thesaurus, and creates the root term) — plus scratch caller nodes
 * and one scratch host record. All of it is deleted in afterAll, and the
 * pre-flight purge runs first so a crashed earlier run cannot skew a pin.
 *
 * THE FOUR ROOT TERMS ARE THE SELECTABILITY MATRIX. `isIndexable` answers per
 * NODE, from the node's own record, so one tree carries all four answers:
 *   <tld>1/1        — flag YES  → selectable
 *   <tld>1/2        — flag NO   → not selectable (its sibling, same section)
 *   hierarchy20/1   — a `hierarchy*` tipo → STRUCTURAL, never selectable
 *   test65/1        — a section whose section_map declares NO is_indexable
 *                     component at all → browse-only, and NOT an error
 * Every one of them still RENDERS: a refused term is visible and navigable, it
 * simply carries no link affordance.
 *
 * SCRATCH IDENTITIES. Provisioning grants the creating user's PROFILE level 2
 * over the new sections, so this file provisions as a THROWAWAY user (never the
 * superuser, whose profile dd234/2 is a real record holding thousands of live
 * grants) and deletes the profile afterwards. The `reader` identity exists
 * because the mode grant's permission condition cannot be proven with the
 * superuser alone — it holds level 2 on one picker caller and level 1 on
 * another, so 'relation' vs 'default' is attributable to the GRANT and to
 * nothing else.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import {
	PICKER_CALLER_MALFORMED_MESSAGE,
	PICKER_CALLER_SECTIONLESS_MESSAGE,
	PICKER_CALLER_UNKNOWN_MESSAGE,
	PICKER_NO_HIERARCHY_MESSAGE,
} from '../../src/core/concepts/area.ts';
import { deleteTldNodes } from '../../src/core/db/dd_ontology.ts';
import { updateMatrixKeyData } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import { ensureHierarchy } from '../../src/core/ontology/hierarchy_state.ts';
import { getNode } from '../../src/core/ontology/resolver.ts';
import { getSectionMapValue } from '../../src/core/ontology/section_map.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import {
	getPermissionGrant,
	type Principal,
	resolvePrincipal,
	TEMP_PRESET_SECTION,
} from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

registerSessionCleanup();

const AREA = 'dd100';
/** The scratch thesaurus (synthetic tld — no real install uses it). */
const TLD = 'zzpm';
/** Its descriptor section: a VIRTUAL section over hierarchy20, exactly like an activated thesaurus instance (testgeoa1). */
const TERMS = `${TLD}1`;
/** The scratch caller components live in their own synthetic tld. */
const CALLER_TLD = 'zzpc';
/** Declares view:'tree' + the scratch thesaurus as its only target. */
const PICKER_CALLER = 'zzpc1';
/** Same target, NO view — the mode grant must refuse it. */
const PLAIN_CALLER = 'zzpc2';
/** Declares view:'tree'; the reader identity holds only READ on it. */
const READONLY_CALLER = 'zzpc3';
/**
 * Declares view:'tree' and lives under the dd655 EDITING-PRESET section, where
 * `getPermissions` answers 2 for every principal BY RULE (TEMP_PRESET_SECTION:
 * the blanket preset grant, bounded only by the preset assembler's owner
 * predicate). No profile grants it — the reader's level on it is the rule's.
 */
const PRESET_CALLER = 'zzpc4';
/**
 * view:'tree' callers whose config SHOWS the thesaurus term (hierarchy25 on the
 * scratch descriptor section) — a writer scope opens only a target its config
 * shows a column of (security/writer_chain_scope.ts). The scoped writer holds
 * EDIT on the first, READ on the second.
 */
const SCOPED_CALLER = 'zzpc5';
const SCOPED_CALLER_R = 'zzpc6';
/**
 * A tipo that exists NOWHERE else, planted in the caller's `show.ddo_map`. The
 * ddo_map governs how a LINKED value is displayed back in the caller — it is
 * not the tree's renderer, and its presence anywhere in the tree payload would
 * mean the caller's display config had leaked into the thesaurus.
 */
const DDO_MARKER = 'zzpc900';
/** The record the caller component sits on (capacity is a fact of the record). */
const HOST = 'test3';
const HOST_ID = 926101;
/** A section whose section_map declares `is_indexable: false` (no contract). */
const NO_CONTRACT_SECTION = 'test65';

/** The si/no YES and NO locators the thesaurus flags are written with. */
const siNo = (tipo: string, yes: boolean) => [
	{
		id: 1,
		type: 'dd151',
		section_tipo: 'dd64',
		section_id: yes ? 1 : 2,
		from_component_tipo: tipo,
	},
];
const rootTerm = (sectionTipo: string, sectionId: number, id: number) => ({
	id,
	type: 'dd48',
	section_id: sectionId,
	section_tipo: sectionTipo,
	from_component_tipo: 'hierarchy45',
});

interface Identity {
	userId: number;
	profileId: number;
	principal: Principal;
}

let hierarchyId = 0;
/**
 * A scratch record in hierarchy20 — the NON-TARGET section the scoped area
 * search must drop — carrying a matching hierarchy25 value, so a leak would
 * return a hit (purged by its marker value in purgeScratch).
 */
let offTargetId = 0;
const OFF_TARGET_TERM = `ZZ beside off-target ${TLD}`;
/** The provisioning identity — its profile receives the provisioning grants. */
let provisioner: Identity | undefined;
/** dd100 + the scratch thesaurus + EDIT on one caller, READ on another. */
let reader: Identity | undefined;
/** dd100 only: every hierarchy is refused, nothing is unconfigured. */
let outsider: Identity | undefined;
/**
 * dd100 + READ on the HOST section + EDIT on the picker caller, NOTHING on the
 * scratch thesaurus: the owner-decision (i) writer, who browses the target tree
 * ONLY through the caller's verified chain (security/writer_chain_scope.ts).
 */
let scopedWriter: Identity | undefined;
let superuser: Principal;
/** The second, deliberately NON-selectable root term. */
let unselectableTermId = 0;

/** A throwaway user + profile pair carrying exactly the given grants. */
async function buildIdentity(
	grants: { tipo: string; section_tipo: string; value: number }[],
): Promise<Identity> {
	const profileId = await createSectionRecord('dd234', -1);
	const userId = await createSectionRecord('dd128', -1);
	// dd1725 = the user's profile-select locator (security::get_user_profile).
	await updateMatrixKeyData('matrix_users', 'dd128', userId, 'relation', 'dd1725', [
		{
			id: 1,
			type: 'dd151',
			section_tipo: 'dd234',
			section_id: String(profileId),
			from_component_tipo: 'dd1725',
		},
	]);
	// dd774 = the profile's grant matrix, keyed `${section_tipo}_${tipo}`.
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

/** One scratch caller component node (parented under `parent`, the HOST section by default). */
async function buildCallerNode(
	tipo: string,
	properties: Record<string, unknown>,
	parent: string = HOST,
): Promise<void> {
	await sql.unsafe(
		`INSERT INTO dd_ontology (tipo, parent, model, tld, term, is_model, is_translatable, is_main, properties)
		 VALUES ($1, $2, 'component_portal', $3, $4::text::jsonb, false, false, false, $5::text::jsonb)`,
		[
			tipo,
			// PARENTED UNDER THE HOST SECTION, not orphaned. The caller declaration
			// names {section_tipo: HOST, tipo}, and the engine now verifies that the
			// pair is REAL (a component the ontology actually places under that
			// section) before granting anything — two independent client strings must
			// not be able to claim each other. An orphan parent made the fixture
			// declare a pair the engine correctly refuses, i.e. it asserted a shape
			// production can never have. Purged by tld in afterAll.
			parent,
			CALLER_TLD,
			JSON.stringify({ 'lg-spa': `scratch picker caller ${tipo}` }),
			JSON.stringify(properties),
		],
	);
}

/** The caller's request_config: ONE sqo naming ONE target section. */
const targetConfig = (target: string) => ({
	request_config: [{ sqo: { section_tipo: [{ value: [target], source: 'section' }] } }],
});

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
	const offTarget = (await sql.unsafe(
		`SELECT section_id FROM matrix_hierarchy WHERE section_tipo = 'hierarchy20' AND string @> $1::text::jsonb`,
		[JSON.stringify({ hierarchy25: [{ value: OFF_TARGET_TERM }] })],
	)) as { section_id: number }[];
	const offTargetIds = new Set(offTarget.map((row) => Number(row.section_id)));
	if (offTargetId !== 0) offTargetIds.add(offTargetId);
	for (const id of offTargetIds) {
		for (const table of ['matrix_hierarchy', 'matrix_time_machine']) {
			await sql.unsafe(
				`DELETE FROM "${table}" WHERE section_tipo = 'hierarchy20' AND section_id = $1`,
				[id],
			);
		}
	}
	await sql.unsafe('DELETE FROM matrix_test WHERE section_tipo = $1 AND section_id = $2', [
		HOST,
		HOST_ID,
	]);
	await sql.unsafe('DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2', [
		HOST,
		HOST_ID,
	]);
	for (const identity of [provisioner, reader, outsider, scopedWriter]) {
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

interface AreaReadBody {
	ok?: boolean;
	error?: { code: string; message: string };
	data?: {
		context?: {
			thesaurus_mode?: string;
			picker?: { selection_limit: number | null; remaining: number | null; targets: string[] };
		}[];
		data?: {
			value?: {
				target_section_tipo?: string;
				root_terms?: { section_tipo?: unknown; section_id?: unknown }[];
				root_terms_selectable?: {
					section_tipo: string;
					section_id: unknown;
					selectable: boolean;
				}[];
			}[];
			ts_search?: { found?: { section_tipo: string; section_id: number }[] };
		}[];
	};
}

/** The tree-area read, with or without a declared caller (and, for a SEARCH, the client sqo). */
async function readTree(
	principal: Principal,
	caller?: unknown,
	sqo?: Record<string, unknown>,
): Promise<{ status: number; body: AreaReadBody }> {
	const token = createSession(principal.userId, `u${principal.userId}`, principal.isGlobalAdmin);
	const session = getSession(token);
	const rqo = {
		id: 'area_picker_mode_gate',
		action: 'read',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		options: {},
		source: {
			typo: 'source',
			model: 'area_thesaurus',
			tipo: AREA,
			section_tipo: AREA,
			action: 'get_data',
			mode: 'list',
			lang: 'lg-spa',
			...(caller !== undefined ? { caller } : {}),
			...(sqo !== undefined ? { search_action: 'search' } : {}),
		},
		...(sqo !== undefined ? { sqo } : {}),
	};
	const dispatched = await dispatchRqo(
		rqo as never,
		{
			requestId: 'area_picker_mode_gate',
			clientIp: '127.0.0.1',
			session,
			csrfCandidate: session?.csrfToken ?? null,
			principal,
		} as never,
	);
	return { status: dispatched.status, body: dispatched.body as AreaReadBody };
}

const hierarchies = (body: AreaReadBody) => body.data?.data?.[0]?.value ?? [];
const scratchHierarchy = (body: AreaReadBody) =>
	hierarchies(body).find((entry) => entry.target_section_tipo === TERMS);
const callerAddress = { section_tipo: HOST, section_id: String(HOST_ID), tipo: PICKER_CALLER };

beforeAll(async () => {
	if (!DB_READY) return;
	await purgeScratch(); // a crashed earlier run must not skew the pins

	// Never write over anything this gate did not create.
	const occupied = (await sql.unsafe(
		'SELECT section_id FROM matrix_test WHERE section_tipo = $1 AND section_id = $2',
		[HOST, HOST_ID],
	)) as unknown[];
	if (occupied.length > 0) {
		throw new Error(
			`area picker gate: ${HOST}/${HOST_ID} is occupied after the sweep — refusing to write over a record this gate did not create.`,
		);
	}

	provisioner = await buildIdentity([]);
	// The scratch thesaurus. ensureHierarchy is the SINGLE writer: it defaults
	// the source section to hierarchy20, provisions the ontology, flags active +
	// active_in_thesaurus, writes the hierarchy53/58 pointers and creates the
	// root terms. A failure here is a blocker, never something to skip past.
	hierarchyId = await createSectionRecord('hierarchy1', provisioner.userId);
	const registry = (column: 'string' | 'relation', tipo: string, value: unknown) =>
		updateMatrixKeyData('matrix_hierarchy_main', 'hierarchy1', hierarchyId, column, tipo, value);
	await registry('string', 'hierarchy6', [{ id: 1, lang: 'lg-nolan', value: TLD }]);
	await registry('string', 'hierarchy5', [{ id: 1, lang: 'lg-spa', value: 'ZZ picker scratch' }]);
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
			`area picker gate: the scratch thesaurus did not provision (${provisioned.msg}; ${provisioned.errors.join('; ')}) — every case below would be vacuous.`,
		);
	}

	// The NON-selectable sibling: same section, same tree, flag NO.
	unselectableTermId = await createSectionRecord(TERMS, provisioner.userId);
	await updateMatrixKeyData(
		'matrix_hierarchy',
		TERMS,
		unselectableTermId,
		'relation',
		'hierarchy24',
		siNo('hierarchy24', false),
	);
	await updateMatrixKeyData(
		'matrix_hierarchy',
		TERMS,
		unselectableTermId,
		'string',
		'hierarchy25',
		[{ id: 1, lang: 'lg-spa', value: 'ZZ not selectable' }],
	);
	// A literal NO caller config names (hierarchy41, an input_text of the
	// hierarchy20 template): the scoped area search must not filter by it.
	await updateMatrixKeyData(
		'matrix_hierarchy',
		TERMS,
		unselectableTermId,
		'string',
		'hierarchy41',
		[{ id: 1, lang: 'lg-nolan', value: 'ZZ hidden alias' }],
	);
	// The off-target record (offTargetId): a hierarchy20 term matching 'ZZ*'.
	offTargetId = await createSectionRecord('hierarchy20', provisioner.userId);
	await updateMatrixKeyData(
		'matrix_hierarchy',
		'hierarchy20',
		offTargetId,
		'string',
		'hierarchy25',
		[{ id: 1, lang: 'lg-spa', value: OFF_TARGET_TERM }],
	);
	// The four root terms — the selectability matrix (see the file header).
	await registry('relation', 'hierarchy45', [
		rootTerm(TERMS, 1, 1),
		rootTerm(TERMS, unselectableTermId, 2),
		rootTerm('hierarchy20', 1, 3),
		rootTerm(NO_CONTRACT_SECTION, 1, 4),
	]);

	// The callers. The picker caller carries EVERYTHING the picker must ignore:
	// a `choose.sqo_config.limit` (the autocomplete dropdown's size — a thesaurus
	// is browsed, not paged) and a `show.ddo_map` (how a linked value is shown
	// BACK in the caller). It also declares the only count that does bind:
	// properties.data_limit.
	await buildCallerNode(PICKER_CALLER, {
		view: 'tree',
		data_limit: 3,
		source: {
			request_config: [
				{
					sqo: { section_tipo: [{ value: [TERMS], source: 'section' }] },
					choose: { sqo_config: { limit: 1 } },
					show: { ddo_map: [{ tipo: DDO_MARKER, parent: 'self', section_tipo: 'self' }] },
				},
			],
		},
	});
	await buildCallerNode(PLAIN_CALLER, { source: targetConfig(TERMS) });
	await buildCallerNode(READONLY_CALLER, { view: 'tree', source: targetConfig(TERMS) });
	await buildCallerNode(
		PRESET_CALLER,
		{ view: 'tree', source: targetConfig(TERMS) },
		TEMP_PRESET_SECTION,
	);
	for (const tipo of [SCOPED_CALLER, SCOPED_CALLER_R]) {
		await buildCallerNode(tipo, {
			view: 'tree',
			source: {
				request_config: [
					{
						sqo: { section_tipo: [{ value: [TERMS], source: 'section' }] },
						show: { ddo_map: [{ tipo: 'hierarchy25', parent: 'self', section_tipo: TERMS }] },
					},
				],
			},
		});
	}
	await sql.unsafe('INSERT INTO matrix_test (section_id, section_tipo) VALUES ($1, $2)', [
		HOST_ID,
		HOST,
	]);
	await clearOntologyDerivedCaches();

	// The two non-admin identities. Their grants are written BEFORE the first
	// permission read of the run, so no cached grant table can hide them.
	reader = await buildIdentity([
		{ tipo: AREA, section_tipo: AREA, value: 2 },
		{ tipo: TERMS, section_tipo: TERMS, value: 2 },
		{ tipo: PICKER_CALLER, section_tipo: HOST, value: 2 },
		{ tipo: READONLY_CALLER, section_tipo: HOST, value: 1 },
	]);
	outsider = await buildIdentity([{ tipo: AREA, section_tipo: AREA, value: 2 }]);
	scopedWriter = await buildIdentity([
		{ tipo: AREA, section_tipo: AREA, value: 2 },
		{ tipo: HOST, section_tipo: HOST, value: 1 },
		{ tipo: SCOPED_CALLER, section_tipo: HOST, value: 2 },
		{ tipo: SCOPED_CALLER_R, section_tipo: HOST, value: 1 },
	]);
	superuser = await resolvePrincipal(-1);
}, 180000);

afterAll(async () => {
	if (!DB_READY) return;
	await purgeScratch();
});

describe.if(DB_READY)('the picker read — mode and constraint are DERIVED from the caller', () => {
	test('the fixture floor: the picker caller DECLARES everything the cases below read', async () => {
		// Without this, "the ddo_map does not reach the payload" and "the tree is
		// not truncated by sqo_config.limit" would both be green against a caller
		// that declared neither — the vacuous-pass shape this suite forbids.
		const declared = (await getNode(PICKER_CALLER))?.properties as {
			view?: unknown;
			data_limit?: unknown;
			source?: {
				request_config?: {
					choose?: { sqo_config?: { limit?: unknown } };
					show?: { ddo_map?: { tipo?: unknown }[] };
				}[];
			};
		} | null;
		expect(declared?.view).toBe('tree');
		expect(declared?.data_limit).toBe(3);
		const config = declared?.source?.request_config?.[0];
		expect(config?.choose?.sqo_config?.limit).toBe(1);
		expect(config?.show?.ddo_map?.[0]?.tipo).toBe(DDO_MARKER);
	});

	test('the fixture floor: a caller-LESS browse read serves many hierarchies in default mode', async () => {
		// The control every narrowing assertion below is a reduction FROM. It is
		// also the byte-shape the frozen parity fixtures pin: an ordinary browse
		// read gains no picker key of any kind.
		const { status, body } = await readTree(superuser);
		expect(status).toBe(200);
		const served = hierarchies(body);
		expect(served.length).toBeGreaterThan(1);
		expect(served.some((entry) => entry.target_section_tipo === TERMS)).toBe(true);
		expect(body.data?.context?.[0]?.thesaurus_mode).toBe('default');
		expect(body.data?.context?.[0]?.picker).toBeUndefined();
		expect(served.every((entry) => entry.root_terms_selectable === undefined)).toBe(true);
	});

	test("a caller declaring view:'tree' with EDIT grants relation mode", async () => {
		const { status, body } = await readTree(superuser, callerAddress);
		expect(status).toBe(200);
		expect(body.data?.context?.[0]?.thesaurus_mode).toBe('relation');
	});

	test('a FORGED caller pair is refused: tipo must really live under section_tipo', async () => {
		// `tipo` and `section_tipo` are two independent client strings. Without a
		// belonging check a request can name any component under any section it can
		// read — and `getPermissions` short-circuits for some sections (the dd655
		// preset surface answers 2 for any tipo beneath it), so a forged pair could
		// obtain relation mode plus the caller's resolved targets and cap for a
		// component that never declared a picker. The grant is only as honest as the
		// pair it is derived from.
		const { status, body } = await readTree(superuser, {
			section_tipo: HOST,
			section_id: String(HOST_ID),
			// a real component, but one that does NOT live under HOST
			tipo: 'dd197',
		});
		expect(status).toBe(400);
		expect(body.error?.code).toBe('area.picker_caller_invalid');
		expect(String(body.error?.message ?? '')).toContain(PICKER_CALLER_UNKNOWN_MESSAGE);
	});

	test("the caller's view is read from its SECTION's ddo_map, not only its own node", async () => {
		// structure_context resolves `options.view ?? properties.view ?? default`,
		// and `options.view` is the ddo_map channel. Deriving the caller's view from
		// the node ALONE left a component that declares the tree view in its
		// section's ddo_map rendering the tree client-side while the server refused
		// the grant — an edit affordance that browses and navigates away on click.
		//
		// Pinned on the derivation itself rather than through a full read, because
		// the alternative fixture is mutating a shared playground section's
		// request_config mid-run, which would race any suite reading it.
		const injectedSection = `${CALLER_TLD}9`;
		const injectedCaller = `${CALLER_TLD}91`;
		await sql.unsafe(
			`INSERT INTO dd_ontology (tipo, parent, model, tld, term, is_model, is_translatable, is_main, properties)
			 VALUES ($1, $2, 'section', $3, $4::text::jsonb, false, false, false, $5::text::jsonb)`,
			[
				injectedSection,
				HOST,
				CALLER_TLD,
				JSON.stringify({ 'lg-spa': 'scratch ddo-injecting section' }),
				// (!) the request_config lives under `source`, which is what
				// selectRequestConfigStrategy reads to choose the explicit builder.
				JSON.stringify({
					source: {
						request_config: [
							{
								type: 'main',
								api_engine: 'dedalo',
								sqo: { section_tipo: [{ value: [injectedSection], source: 'section' }] },
								show: {
									ddo_map: [
										{
											tipo: injectedCaller,
											view: 'tree',
											parent: 'self',
											section_tipo: 'self',
										},
									],
								},
							},
						],
					},
				}),
			],
		);
		// The caller declares NO view of its own — the map is the only source. It is
		// parented under the INJECTING section, because the ddo processing drops an
		// entry whose tipo it cannot resolve as that section's component.
		await sql.unsafe(
			`INSERT INTO dd_ontology (tipo, parent, model, tld, term, is_model, is_translatable, is_main, properties)
			 VALUES ($1, $2, 'component_portal', $3, $4::text::jsonb, false, false, false, $5::text::jsonb)`,
			[
				injectedCaller,
				injectedSection,
				CALLER_TLD,
				JSON.stringify({ 'lg-spa': 'scratch ddo-injected caller' }),
				JSON.stringify(targetConfig(TERMS)),
			],
		);
		clearOntologyDerivedCaches();

		const { ddoMapViewFor } = await import('../../src/core/area/read.ts');
		expect(await ddoMapViewFor(injectedCaller, injectedSection)).toBe('tree');
		// a component the map does not name falls through to its own properties
		expect(await ddoMapViewFor(PLAIN_CALLER, injectedSection)).toBe(null);
	});

	test('the resolved constraint rides the context: selection_limit, remaining, targets', async () => {
		// selection_limit IS properties.data_limit (3) and nothing else; remaining
		// is that minus what the host record already holds (0), which is what a
		// picker session may add. The write chokepoint re-resolves both from the
		// same module, so the affordance and the persistence are one value.
		const { body } = await readTree(superuser, callerAddress);
		const picker = body.data?.context?.[0]?.picker;
		expect(picker?.selection_limit).toBe(3);
		expect(picker?.remaining).toBe(3);
		expect(picker?.targets.length).toBeGreaterThan(0);
	});

	test('a caller that declares no picker view stays in DEFAULT mode', async () => {
		const { status, body } = await readTree(superuser, {
			section_tipo: HOST,
			section_id: String(HOST_ID),
			tipo: PLAIN_CALLER,
		});
		expect(status).toBe(200);
		expect(body.data?.context?.[0]?.thesaurus_mode).toBe('default');
		expect(body.data?.context?.[0]?.picker).toBeUndefined();
	});

	test('READ-only on the caller is not enough — the same identity gets both answers', async () => {
		// The mode grant's permission condition, isolated: ONE principal, two
		// callers that both declare view:'tree', differing only in the grant
		// level. Nothing about admin-ness is involved.
		expect(reader).toBeDefined();
		const edit = await readTree(reader?.principal as Principal, callerAddress);
		const readOnly = await readTree(reader?.principal as Principal, {
			section_tipo: HOST,
			section_id: String(HOST_ID),
			tipo: READONLY_CALLER,
		});
		expect(edit.status).toBe(200);
		expect(readOnly.status).toBe(200);
		expect(edit.body.data?.context?.[0]?.thesaurus_mode).toBe('relation');
		expect(readOnly.body.data?.context?.[0]?.thesaurus_mode).toBe('default');
	});

	test('a RULE-granted EDIT is not a picker grant: a dd655 member gets relation mode only from a profile (or the superuser)', async () => {
		// The mode grant EXTENDS the caller's edit level into a picker capability
		// (relation mode + the caller's resolved targets, cap and held count). The
		// dd655 editing-preset rule answers 2 for ANY tipo under dd655 and ANY
		// principal — its bound is the preset assembler's owner predicate, which
		// does not travel into a thesaurus read. So a level the profile never gave
		// must not grant the picker (the read floor's law: an extension refuses a
		// 'rule' basis — security/read_floor.ts).
		expect(reader).toBeDefined();
		const principal = reader?.principal as Principal;
		const presetCaller = {
			section_tipo: TEMP_PRESET_SECTION,
			section_id: String(HOST_ID),
			tipo: PRESET_CALLER,
		};
		// Fixture floor: the reader's 2 on this pair is the RULE's, not its profile's
		// (its profile names no dd655 pair) — so the refusal below is attributable
		// to the basis and to nothing else.
		expect(await getPermissionGrant(principal, TEMP_PRESET_SECTION, PRESET_CALLER)).toEqual({
			level: 2,
			basis: 'rule',
		});
		// Positive control: the caller IS a working picker caller (the superuser,
		// basis 'superuser', is granted relation mode on the very same address).
		const asSuperuser = await readTree(superuser, presetCaller);
		expect(asSuperuser.status).toBe(200);
		expect(asSuperuser.body.data?.context?.[0]?.thesaurus_mode).toBe('relation');

		const asReader = await readTree(principal, presetCaller);
		expect(asReader.status).toBe(200);
		expect(asReader.body.data?.context?.[0]?.thesaurus_mode).toBe('default');
		expect(asReader.body.data?.context?.[0]?.picker).toBeUndefined();
	});

	test.each([
		['a caller that is not an address', { tipo: PICKER_CALLER }, PICKER_CALLER_MALFORMED_MESSAGE],
		[
			'a caller naming no record',
			{ section_tipo: HOST, section_id: null, tipo: PICKER_CALLER },
			PICKER_CALLER_MALFORMED_MESSAGE,
		],
		[
			'a caller the ontology does not define',
			{ section_tipo: HOST, section_id: String(HOST_ID), tipo: 'zzpc404' },
			PICKER_CALLER_UNKNOWN_MESSAGE,
		],
		[
			'a caller in a section that holds no records',
			{ section_tipo: AREA, section_id: '1', tipo: PICKER_CALLER },
			PICKER_CALLER_SECTIONLESS_MESSAGE,
		],
	])('%s is refused 400, named', async (_label, caller, message) => {
		const { status, body } = await readTree(superuser, caller);
		expect(status).toBe(400);
		expect(body.error?.code).toBe('area.picker_caller_invalid');
		expect(body.error?.message).toBe(message);
	});
});

describe.if(DB_READY)('the picker read — narrowing to the caller’s own targets', () => {
	test('the tree carries ONLY the sections the caller declares', async () => {
		// The whole point of the caller declaration: a picker opens ITS thesaurus.
		// The caller's sqo names exactly one target (the scratch thesaurus), so
		// exactly one hierarchy may survive.
		//
		// MEASURED TODAY: every hierarchy survives. `relations/picker_constraint.ts`
		// resolves the DECLARED targets through getSectionRealTipo before storing
		// them and `isTargetAllowed` resolves the incoming side too — and EVERY
		// thesaurus is a virtual section over hierarchy20, so real-vs-real makes
		// all of them one section and the narrowing never narrows.
		const { status, body } = await readTree(superuser, callerAddress);
		expect(status).toBe(200);
		expect(hierarchies(body).map((entry) => entry.target_section_tipo)).toEqual([TERMS]);
	});

	test('a caller whose target declares no ACTIVE hierarchy is refused 409, named', async () => {
		// "Unconfigured" is not "forbidden". The superuser refuses nothing, so an
		// empty result here can only be the data — and the client renders "this
		// picker has no thesaurus" rather than a permission error.
		//
		// This case reaches the 409 only THROUGH the narrowing above: with every
		// thesaurus in the tree, deactivating one leaves 149 others standing.
		await updateMatrixKeyData(
			'matrix_hierarchy_main',
			'hierarchy1',
			hierarchyId,
			'relation',
			'hierarchy125',
			siNo('hierarchy125', false),
		);
		try {
			const { status, body } = await readTree(superuser, callerAddress);
			expect(status).toBe(409);
			expect(body.error?.code).toBe('resource.conflict');
			expect(body.error?.message).toBe(PICKER_NO_HIERARCHY_MESSAGE);
		} finally {
			await updateMatrixKeyData(
				'matrix_hierarchy_main',
				'hierarchy1',
				hierarchyId,
				'relation',
				'hierarchy125',
				siNo('hierarchy125', true),
			);
		}
	});

	test('every candidate hierarchy REFUSED answers 403 generically, naming no section', async () => {
		// The other empty case. `notAuthorized()` (never denied(403, …)) carries
		// the machine token the client dispatches its no-permission page on, and
		// the message must not name the sections the caller may not reach —
		// naming them tells the caller they exist.
		expect(outsider).toBeDefined();
		const { status, body } = await readTree(outsider?.principal as Principal, callerAddress);
		expect(status).toBe(403);
		// Envelope v2 (P1 sweep): the machine channel is the CODE the client
		// dispatches its no-permission page on — `perm.denied`, whose message is
		// operator-disclosure so it can name no section.
		expect(body.ok).toBe(false);
		expect(body.error?.code).toBe('perm.denied');
		expect('result' in body).toBe(false);
		const serialized = JSON.stringify(body);
		expect(serialized).not.toContain(TERMS);
		expect(serialized).not.toContain(TLD);
	});

	test('the tree is NOT truncated by the caller’s sqo_config.limit', async () => {
		// `choose.sqo_config.limit` is the AUTOCOMPLETE dropdown's size. The
		// caller declares 1; a thesaurus is browsed, not paged, so neither the
		// hierarchy list nor the root terms may be cut to it.
		const { body } = await readTree(superuser, callerAddress);
		const entry = scratchHierarchy(body);
		expect(entry).toBeDefined();
		expect((entry?.root_terms ?? []).length).toBe(4);
	});

	test('the caller’s ddo_map does NOT reach the tree payload', async () => {
		// The ddo_map says how a LINKED value is displayed back in the caller. The
		// tree is the thesaurus's own rendering, so the marker must appear
		// NOWHERE — including in the context the client reads.
		const { body } = await readTree(superuser, callerAddress);
		expect(JSON.stringify(body)).not.toContain(DDO_MARKER);
	});
});

describe.if(DB_READY)('the picker read — per-term selectability is the TERM’s own answer', () => {
	test('relation mode emits root_terms_selectable; default mode emits none', async () => {
		const picker = await readTree(superuser, callerAddress);
		const browse = await readTree(superuser, {
			section_tipo: HOST,
			section_id: String(HOST_ID),
			tipo: PLAIN_CALLER,
		});
		expect(scratchHierarchy(picker.body)?.root_terms_selectable).toBeDefined();
		expect(scratchHierarchy(browse.body)?.root_terms_selectable).toBeUndefined();
	});

	test('a flagged term is selectable and its SIBLING in the same tree is not', async () => {
		// The rule is per NODE, read from the node's own record — not per
		// component and not per section. Both terms live in the same section of
		// the same tree and differ only in their hierarchy24 flag.
		const { body } = await readTree(superuser, callerAddress);
		const selectability = scratchHierarchy(body)?.root_terms_selectable ?? [];
		const answer = (sectionTipo: string, sectionId: number) =>
			selectability.find(
				(entry) => entry.section_tipo === sectionTipo && Number(entry.section_id) === sectionId,
			)?.selectable;
		expect(answer(TERMS, 1)).toBe(true);
		expect(answer(TERMS, unselectableTermId)).toBe(false);
	});

	test('a `hierarchy*` root is STRUCTURAL and never selectable', async () => {
		const { body } = await readTree(superuser, callerAddress);
		const structural = (scratchHierarchy(body)?.root_terms_selectable ?? []).find(
			(entry) => entry.section_tipo === 'hierarchy20',
		);
		expect(structural).toBeDefined();
		expect(structural?.selectable).toBe(false);
	});

	test('a section declaring no is_indexable component is browse-only, NOT an error', async () => {
		// The distinction this pins: `test65` declares `is_indexable: false` — no
		// component carries the flag at all — while the scratch thesaurus names a
		// real one. Both answer `false` for their terms, but only a missing
		// CONTRACT could tempt the read into treating it as a failure. It answers
		// 200 and the term renders, unpickable.
		expect(await getSectionMapValue(NO_CONTRACT_SECTION, 'thesaurus', 'is_indexable')).toBe(false);
		expect(typeof (await getSectionMapValue(TERMS, 'thesaurus', 'is_indexable'))).toBe('string');

		const { status, body } = await readTree(superuser, callerAddress);
		expect(status).toBe(200);
		const noContract = (scratchHierarchy(body)?.root_terms_selectable ?? []).find(
			(entry) => entry.section_tipo === NO_CONTRACT_SECTION,
		);
		expect(noContract).toBeDefined();
		expect(noContract?.selectable).toBe(false);
		// …and it is still IN the tree: a refused term stays visible and navigable.
		expect(
			(scratchHierarchy(body)?.root_terms ?? []).some(
				(term) => term.section_tipo === NO_CONTRACT_SECTION,
			),
		).toBe(true);
	});
});

describe.if(DB_READY)(
	'owner decision (i): the AREA door reads an ungranted thesaurus ONLY through the verified writer chain',
	() => {
		// The tree picker's boot read (readTreeArea → resolveDeclaredPickerCaller →
		// treeScope → filterHierarchiesByGrant). The scoped writer holds NOTHING on
		// the scratch thesaurus, EDIT on the view:'tree' picker caller: the hierarchy
		// is kept only when the picker caller names its `callers` chain and it
		// verifies (subdatum_permission_native pins the node doors and the scope).
		const hostRoot = [{ tipo: HOST, section_tipo: HOST, mode: 'edit' }];
		const writer = () => scopedWriter?.principal as Principal;
		const scopedAddress = { ...callerAddress, tipo: SCOPED_CALLER };

		test('the fixture floor: the scoped writer holds no grant on the thesaurus', async () => {
			expect(scopedWriter).toBeDefined();
			expect((await getPermissionGrant(writer(), TERMS, TERMS)).level).toBe(0);
			expect((await getPermissionGrant(writer(), HOST, SCOPED_CALLER)).level).toBe(2);
			expect((await getPermissionGrant(writer(), HOST, SCOPED_CALLER_R)).level).toBe(1);
		});

		test('WITH the verified chain: the thesaurus is kept (relation mode), its own root terms only', async () => {
			const { status, body } = await readTree(writer(), { ...scopedAddress, callers: hostRoot });
			expect(status).toBe(200);
			expect(body.data?.context?.[0]?.thesaurus_mode).toBe('relation');
			const entry = scratchHierarchy(body);
			expect(entry).toBeDefined();
			// The scope opens the caller's TARGET only: hierarchy20 / test65 roots stay pruned.
			expect((entry?.root_terms ?? []).every((term) => term.section_tipo === TERMS)).toBe(true);
			expect((entry?.root_terms ?? []).length).toBeGreaterThan(0);
		});

		// THE AREA SEARCH DOOR (owner decision (i), W4b review): the client's
		// sqo.section_tipo is judged like the hierarchy prune — read grant, or the
		// verified tree scope's targets — and the scope's filter pairs are
		// EXCLUSIVE on the sections it opened (hierarchy25 is the only pair).
		const termSearch = (q: string, sections: string[] = [TERMS], component = 'hierarchy25') => ({
			section_tipo: sections,
			limit: 10,
			offset: 0,
			filter: { $and: [{ q, path: [{ section_tipo: sections[0], component_tipo: component }] }] },
		});
		const foundOf = (body: AreaReadBody) =>
			(body.data?.data?.[0]?.ts_search?.found ?? []).map(
				(hit) => `${hit.section_tipo}_${hit.section_id}`,
			);
		const notSelectable = () => `${TERMS}_${unselectableTermId}`;

		test('search WITH the verified chain finds in the target (hit vs miss)', async () => {
			const caller = { ...scopedAddress, callers: hostRoot };
			const hit = await readTree(writer(), caller, termSearch('ZZ not*'));
			expect(hit.status).toBe(200);
			expect(foundOf(hit.body)).toContain(notSelectable());
			const miss = await readTree(writer(), caller, termSearch('ZZ nomatch*'));
			expect(miss.status).toBe(200);
			expect(foundOf(miss.body)).toEqual([]);
		});

		test('a plain (caller-less) area search of the ungranted thesaurus → perm.denied', async () => {
			const { status, body } = await readTree(writer(), undefined, termSearch('ZZ not*'));
			expect(status).toBe(403);
			expect(body.error?.code).toBe('perm.denied');
		});

		test('under the chain, a NON-TARGET ungranted section is not searched: dropped beside the target, refused alone', async () => {
			const caller = { ...scopedAddress, callers: hostRoot };
			const offTarget = `hierarchy20_${offTargetId}`;
			// Control (non-vacuity): the off-target record IS reachable by the same
			// search — the superuser (no scope) finds it beside the target term.
			const admin = await readTree(
				superuser as Principal,
				undefined,
				termSearch('ZZ*', [TERMS, 'hierarchy20']),
			);
			expect(admin.status).toBe(200);
			expect(foundOf(admin.body)).toContain(offTarget);
			expect(foundOf(admin.body)).toContain(notSelectable());
			const beside = await readTree(writer(), caller, termSearch('ZZ*', [TERMS, 'hierarchy20']));
			expect(beside.status).toBe(200);
			expect(foundOf(beside.body)).toContain(notSelectable());
			expect(foundOf(beside.body)).not.toContain(offTarget);
			expect(foundOf(beside.body).every((hit) => hit.startsWith(`${TERMS}_`))).toBe(true);
			const alone = await readTree(writer(), caller, termSearch('ZZ*', ['hierarchy20']));
			expect(alone.status).toBe(403);
			expect(alone.body.error?.code).toBe('perm.denied');
		});

		test('under the chain, a FILTER on a target component outside the config stays KEYED (hit = miss)', async () => {
			// hierarchy41 is no pair of the scoped caller's config: matrix_hierarchy
			// is globally visible, so before the exclusive floor the frontier
			// admitted it and the hit found the term.
			const caller = { ...scopedAddress, callers: hostRoot };
			const byAlias = (q: string) => termSearch(q, [TERMS], 'hierarchy41');
			const hit = await readTree(writer(), caller, byAlias('ZZ hidden*'));
			const miss = await readTree(writer(), caller, byAlias('ZZ nomatch*'));
			expect(hit.status).toBe(200);
			expect(foundOf(hit.body)).not.toContain(notSelectable());
			expect(foundOf(hit.body)).toEqual(foundOf(miss.body));
			// Control: the superuser (no scope, ordinary keys) finds it by the same path.
			const admin = await readTree(superuser as Principal, undefined, byAlias('ZZ hidden*'));
			expect(admin.status).toBe(200);
			expect(foundOf(admin.body)).toContain(notSelectable());
		});

		for (const [label, caller] of [
			['WITHOUT a chain', scopedAddress],
			[
				'a FORGED chain (a root that does not declare the caller)',
				{
					...scopedAddress,
					callers: [{ tipo: SCOPED_CALLER_R, section_tipo: HOST, mode: 'edit' }],
				},
			],
			[
				'the READ-ONLY tree caller under the same chain',
				{ ...scopedAddress, tipo: SCOPED_CALLER_R, callers: hostRoot },
			],
		] as const) {
			test(`${label}: the thesaurus is pruned → perm.denied`, async () => {
				const { status, body } = await readTree(writer(), caller);
				expect(status).toBe(403);
				expect(body.error?.code).toBe('perm.denied');
			});
		}
	},
);
