/**
 * THE TARGET FACTS THE PICKER STANDS ON (picker plan step 3) — pinned against a
 * SELF-PROVISIONED scratch thesaurus, with no source change of any kind.
 *
 * WHAT IS BEING PINNED, and why each of these is a fact somebody could break
 * without noticing:
 *  1. `properties.view: 'tree'` reaches the client as `context.view === 'tree'`.
 *     That single value is the whole picker intent — the read path grants
 *     relation mode on it and the write path scopes its selectability gate on
 *     it. A model default or a ddo_map precedence change would silently mute
 *     the feature everywhere at once.
 *  2. `context.request_config[0].sqo.section_tipo` is the RESOLVED ddo array,
 *     never the unresolved `{value:[…], source:'hierarchy_types'}` DESCRIPTOR.
 *     The descriptor is a QUESTION ("every active hierarchy of typology N");
 *     shipping it to the client would hand a picker a question instead of an
 *     answer, and the caller's targets are exactly what narrows the tree.
 *  3. Every resolved entry carries `matrix_table`, and a thesaurus target
 *     carries `matrix_hierarchy`. That field is how any consumer knows a target
 *     IS a thesaurus without a second derivation.
 *  4. `context.target_sections` agrees with that sqo array — the two are one
 *     projection of one answer (WC-2026-08-14-relation-model-target-in-sqo:
 *     N re-derivations disagree, so there is one).
 *  5. A `view:'tree'` node pointed at a NON-hierarchy section — the dd560 shape,
 *     an ontology mistake that shipped — is answered by the picker read with the
 *     NAMED 409, not with an empty tree. Loud is what makes such a declaration
 *     findable instead of a picker that opens on nothing.
 *
 * WHY IT PROVISIONS ITS OWN THESAURUS. The typology-expansion facts differ per
 * install (`resolveHierarchySectionsFromTypes` filters on ACTIVE hierarchies),
 * and the live declarations sit on operator-mutable records — `oh115` can be
 * renamed, retargeted or deactivated by any curator. So the fixture is built
 * here through `ontology/hierarchy_state.ts ensureHierarchy`, THE single writer
 * (which defaults the source section to hierarchy20 and drives
 * `ontology/hierarchy_provision.ts generateVirtualSection`), asserted, and
 * deleted. If provisioning fails, that is a blocker — never a reason to skip.
 *
 * Provisioning grants the creating user's PROFILE level 2 over the new
 * sections, so it runs as a THROWAWAY user; the superuser's profile (dd234/2)
 * is a real record holding thousands of live grants and is never written to.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import { PICKER_NO_HIERARCHY_MESSAGE } from '../../src/core/concepts/area.ts';
import { deleteTldNodes } from '../../src/core/db/dd_ontology.ts';
import { updateMatrixKeyData } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import { ensureHierarchy } from '../../src/core/ontology/hierarchy_state.ts';
import { getNode } from '../../src/core/ontology/resolver.ts';
import { buildStructureContext } from '../../src/core/resolve/structure_context.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { type Principal, resolvePrincipal } from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

registerSessionCleanup();

/** The scratch thesaurus (synthetic tld — no real install uses it). */
const TLD = 'zzpt';
/** Its descriptor section: a VIRTUAL section over hierarchy20, exactly like an activated thesaurus instance (testgeoa1). */
const TERMS = `${TLD}1`;
/**
 * The typology the scratch hierarchy is registered under. The sqo below asks
 * for it BY TYPOLOGY, which is the shape the live picker declarations use
 * (`{"value":[4],"source":"hierarchy_types"}` on oh115) and the one that must
 * arrive at the client already expanded.
 */
const TYPOLOGY_ID = 1;

const CALLER_TLD = 'zzpn';
/** view:'tree' + a hierarchy_types sqo — the picker declaration under test. */
const TYPES_CALLER = 'zzpn1';
/** view:'tree' pointed at a section that is no thesaurus — the dd560 shape. */
const MISDECLARED_CALLER = 'zzpn2';

const AREA = 'dd100';
const HOST = 'test3';
const HOST_ID = 926301;

interface ResolvedTargetDdo {
	tipo?: string;
	matrix_table?: string;
	/** Present only on an UNRESOLVED descriptor — its absence is the assertion. */
	source?: unknown;
	value?: unknown;
}

interface CallerContext {
	view?: string | null;
	target_sections?: { tipo?: string }[];
	request_config?: { sqo?: { section_tipo?: ResolvedTargetDdo[] } }[];
}

let hierarchyId = 0;
let provisionerUserId = 0;
let provisionerProfileId = 0;
let superuser: Principal;

async function buildCallerNode(tipo: string, properties: Record<string, unknown>): Promise<void> {
	await sql.unsafe(
		`INSERT INTO dd_ontology (tipo, parent, model, tld, term, is_model, is_translatable, is_main, properties)
		 VALUES ($1, $2, 'component_portal', $3, $4::text::jsonb, false, false, false, $5::text::jsonb)`,
		[
			tipo,
			// PARENTED UNDER THE HOST SECTION. The caller declaration names
			// {section_tipo: HOST, tipo}, and the engine verifies that pair is REAL
			// before granting anything — two independent client strings must not be
			// able to claim each other. An orphan parent made this fixture declare a
			// pair production can never have. Purged by tld in afterAll.
			HOST,
			CALLER_TLD,
			JSON.stringify({ 'lg-spa': `scratch tree target caller ${tipo}` }),
			JSON.stringify(properties),
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
	for (const [table, sectionTipo, sectionId] of [
		['matrix_profiles', 'dd234', provisionerProfileId],
		['matrix_users', 'dd128', provisionerUserId],
	] as [string, string, number][]) {
		if (sectionId === 0) continue;
		await sql.unsafe(`DELETE FROM "${table}" WHERE section_tipo = $1 AND section_id = $2`, [
			sectionTipo,
			sectionId,
		]);
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[sectionTipo, sectionId],
		);
	}
	await clearOntologyDerivedCaches();
}

/** The caller component's own emitted context — what the client renders from. */
async function callerContext(tipo: string): Promise<CallerContext> {
	const entry = await buildStructureContext({
		configFrom: { source: 'own', reason: 'unit-test' },
		tipo,
		sectionTipo: HOST,
		mode: 'edit',
		lang: 'lg-spa',
		permissions: 3,
	});
	if (entry === null) {
		throw new Error(`relation tree target gate: '${tipo}' resolved no structure context`);
	}
	return entry as unknown as CallerContext;
}

const sqoTargets = (context: CallerContext): ResolvedTargetDdo[] =>
	context.request_config?.[0]?.sqo?.section_tipo ?? [];

/** The picker read for a declared caller. */
async function readTreeFor(
	tipo: string,
): Promise<{ status: number; body: { error?: { code?: string; message?: string } } }> {
	const token = createSession(-1, 'root', true);
	const session = getSession(token);
	const dispatched = await dispatchRqo(
		{
			id: 'relation_tree_target_gate',
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
				caller: { section_tipo: HOST, section_id: String(HOST_ID), tipo },
			},
		} as never,
		{
			requestId: 'relation_tree_target_gate',
			clientIp: '127.0.0.1',
			session,
			csrfCandidate: session?.csrfToken ?? null,
			principal: superuser,
		} as never,
	);
	return {
		status: dispatched.status,
		body: dispatched.body as { error?: { code?: string; message?: string } },
	};
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
			`relation tree target gate: ${HOST}/${HOST_ID} is occupied after the sweep — refusing to write over a record this gate did not create.`,
		);
	}

	// The throwaway provisioning identity (see the file header).
	provisionerProfileId = await createSectionRecord('dd234', -1);
	provisionerUserId = await createSectionRecord('dd128', -1);
	await updateMatrixKeyData('matrix_users', 'dd128', provisionerUserId, 'relation', 'dd1725', [
		{
			id: 1,
			type: 'dd151',
			section_tipo: 'dd234',
			section_id: String(provisionerProfileId),
			from_component_tipo: 'dd1725',
		},
	]);

	hierarchyId = await createSectionRecord('hierarchy1', provisionerUserId);
	const registry = (column: 'string' | 'relation', tipo: string, value: unknown) =>
		updateMatrixKeyData('matrix_hierarchy_main', 'hierarchy1', hierarchyId, column, tipo, value);
	await registry('string', 'hierarchy6', [{ id: 1, lang: 'lg-nolan', value: TLD }]);
	await registry('string', 'hierarchy5', [
		{ id: 1, lang: 'lg-spa', value: 'ZZ tree target scratch' },
	]);
	await registry('relation', 'hierarchy9', [
		{
			type: 'dd151',
			section_tipo: 'hierarchy13',
			section_id: String(TYPOLOGY_ID),
			from_component_tipo: 'hierarchy9',
		},
	]);
	const provisioned = await ensureHierarchy(hierarchyId, provisionerUserId);
	if (!provisioned.ok) {
		throw new Error(
			`relation tree target gate: the scratch thesaurus did not provision (${provisioned.msg}; ${provisioned.errors.join('; ')}) — every pin below would be vacuous.`,
		);
	}

	// The declaration under test: the target is asked for BY TYPOLOGY.
	await buildCallerNode(TYPES_CALLER, {
		view: 'tree',
		source: {
			request_config: [
				{ sqo: { section_tipo: [{ value: [TYPOLOGY_ID], source: 'hierarchy_types' }] } },
			],
		},
	});
	// The dd560 shape: a picker view over a section that is no thesaurus.
	await buildCallerNode(MISDECLARED_CALLER, {
		view: 'tree',
		source: { request_config: [{ sqo: { section_tipo: [{ value: [HOST], source: 'section' }] } }] },
	});
	await sql.unsafe('INSERT INTO matrix_test (section_id, section_tipo) VALUES ($1, $2)', [
		HOST_ID,
		HOST,
	]);
	await clearOntologyDerivedCaches();
	superuser = await resolvePrincipal(-1);
}, 180000);

afterAll(async () => {
	if (!DB_READY) return;
	await purgeScratch();
});

describe.if(DB_READY)('a view:"tree" caller with a hierarchy_types sqo', () => {
	test('the fixture floor: the node DECLARES the unresolved descriptor', async () => {
		// Without this, every "it is resolved" assertion below could be green
		// against a node that never asked a question in the first place.
		const declared = (await getNode(TYPES_CALLER))?.properties as {
			source?: { request_config?: { sqo?: { section_tipo?: unknown[] } }[] };
		} | null;
		expect(declared?.source?.request_config?.[0]?.sqo?.section_tipo).toEqual([
			{ value: [TYPOLOGY_ID], source: 'hierarchy_types' },
		]);
	});

	test('the picker intent survives to the client as context.view === "tree"', async () => {
		expect((await callerContext(TYPES_CALLER)).view).toBe('tree');
	});

	test('sqo.section_tipo is the RESOLVED tipo array, never the descriptor', async () => {
		const targets = sqoTargets(await callerContext(TYPES_CALLER));
		expect(targets.length).toBeGreaterThan(0);
		// The typology question expanded into this hierarchy's own terms section…
		expect(targets.map((target) => target.tipo)).toContain(TERMS);
		// …and NO entry still carries the descriptor's keys.
		for (const target of targets) {
			expect(typeof target.tipo).toBe('string');
			expect(target.source).toBeUndefined();
			expect(target.value).toBeUndefined();
		}
	});

	test('every resolved entry carries matrix_table; a thesaurus target carries matrix_hierarchy', async () => {
		const targets = sqoTargets(await callerContext(TYPES_CALLER));
		for (const target of targets) {
			expect(typeof target.matrix_table).toBe('string');
		}
		expect(targets.find((target) => target.tipo === TERMS)?.matrix_table).toBe('matrix_hierarchy');
	});

	test('context.target_sections agrees with the sqo array — one answer, two projections', async () => {
		const context = await callerContext(TYPES_CALLER);
		expect((context.target_sections ?? []).map((section) => section.tipo)).toEqual(
			sqoTargets(context).map((target) => target.tipo),
		);
	});
});

describe.if(DB_READY)(
	'a view:"tree" caller pointed at a NON-hierarchy section (the dd560 shape)',
	() => {
		test('its target resolves — and carries that section’s own matrix_table', async () => {
			// The declaration is not malformed; it is simply wrong about what its
			// target IS. The context resolves exactly as any other portal's would.
			const context = await callerContext(MISDECLARED_CALLER);
			expect(context.view).toBe('tree');
			const targets = sqoTargets(context);
			expect(targets.map((target) => target.tipo)).toEqual([HOST]);
			expect(targets[0]?.matrix_table).toBe('matrix_test');
		});

		test('the picker read answers the NAMED 409, not an empty tree', async () => {
			// PHP returned an empty tree for both "you may not see it" and "there is
			// nothing configured". A picker that opens on nothing is a broken
			// affordance, and this is the answer that makes such a declaration
			// findable instead of silent.
			const { status, body } = await readTreeFor(MISDECLARED_CALLER);
			expect(status).toBe(409);
			// Envelope v2: the named refusal is `resource.conflict`, and the code is
			// public-disclosure so the curator-facing sentence survives to the wire.
			expect(body.error?.code).toBe('resource.conflict');
			expect(body.error?.message).toBe(PICKER_NO_HIERARCHY_MESSAGE);
		});

		test('the CONTROL: the correctly-declared caller is not refused', async () => {
			// Same read, same principal, same host record — only the target differs.
			// Without this the 409 above could be any refusal at all.
			const { status } = await readTreeFor(TYPES_CALLER);
			expect(status).toBe(200);
		});
	},
);
