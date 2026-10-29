/**
 * THE TYPOLOGY FILTER ON THE TREE-AREA BOOT PAYLOAD — `properties.hierarchy_types`
 * declared on the area's ddo (the cataloguing tool's `area_thesaurus` entry).
 *
 * WHAT THIS GATE IS FOR. A tool declares the typologies its thesaurus panel
 * should show: `tool_config.ddo_map` entry `{role:'area_thesaurus', properties:
 * {hierarchy_types:[8]}}`. The client forwards that instance `properties` in
 * `rqo.source.properties` (common.js create_source). The server must then load
 * ONLY the hierarchies whose typology is declared — the other typologies are
 * never read and never reach the payload (not hidden in the client). Each case
 * pins one of those facts:
 *   - no declaration        → every active hierarchy is projected (unchanged);
 *   - [typologyB]           → only hierarchy B (typology B) survives;
 *   - [typologyA]           → only hierarchy A (typology A) survives;
 *   - [an unused typology]  → nothing survives (a declaration that matches nothing
 *                             admits nothing, it does NOT fall back to "everything");
 *   - []                    → unfiltered, the PHP `!empty($hierarchy_types_filter)`
 *                             rule (an empty list declares no narrowing).
 *
 * The rule compares each registry row's OWN typology (hierarchy9), the PHP
 * class.area_thesaurus.php get_hierarchy_sections check — not the hierarchy's
 * target section.
 *
 * WHY IT BUILDS ITS OWN THESAURI. Two scratch hierarchies on the generic `zz`
 * scratch TLDs, each provisioned through `ensureHierarchy` (THE single writer of
 * the hierarchy registry), differing ONLY in their typology. Operator-mutable
 * install hierarchies can never turn this file red, and the shape (one typology
 * each) is constructed, not discovered. Everything written is swept in afterAll;
 * the pre-flight purge runs first so a crashed earlier run cannot skew a pin.
 *
 * THE IDENTITY. The creator is a throwaway profile + user (never the superuser):
 * provisioning grants the creating user's profile level 2 over the new
 * sections, and the superuser's real profile must not be written by a test.
 * The READ itself runs as the superuser so that only the typology filter, not
 * an ACL split, decides what appears.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { deleteTldNodes } from '../../src/core/db/dd_ontology.ts';
import { updateMatrixKeyData } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import { ensureHierarchy } from '../../src/core/ontology/hierarchy_state.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import {
	type Principal,
	resolvePrincipal,
	SUPERUSER_ID,
} from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

registerSessionCleanup();

/** The thesaurus area the read serves (the same tipo the cataloguing tool declares). */
const AREA_TIPO = 'dd100';

/**
 * Two typologies, one hierarchy each. The typology ids are the hierarchy13
 * records the registry points at: TYPOLOGY_A is the one the cataloguing tool
 * declares in production (8), TYPOLOGY_B a different one (2, Toponymy — the
 * typology the General Term roots are gated on, see hierarchy_entry_fixture).
 */
const TYPOLOGY_A = 8;
const TYPOLOGY_B = 2;
/** A typology no scratch hierarchy carries: declaring it must admit nothing. */
const TYPOLOGY_UNUSED = 9999;

/** Scratch TLDs (generic `zz` namespace; the RESERVED_TLD shape). */
const TLD_A = 'zzhta';
const TLD_B = 'zzhtb';

/** The scratch identity that creates the records (never the superuser). */
let creatorUserId: number;
let creatorProfileId: number;
let superuser: Principal;
/** Registry (hierarchy1) record ids — the boot payload carries them as `section_id`. */
let hierarchyAId: number;
let hierarchyBId: number;

/** The scratch sections/tables a provisioned thesaurus owns, swept in afterAll. */
const SCRATCH_SECTIONS = [TLD_A, TLD_B].flatMap((tld) => [`${tld}0`, `${tld}1`, `${tld}2`]);

async function purgeScratch(): Promise<void> {
	for (const tld of [TLD_A, TLD_B]) {
		await deleteTldNodes(tld);
		await sql.unsafe('DELETE FROM dd_ontology WHERE tld = $1', [tld]);
		await sql.unsafe(
			`DELETE FROM matrix_ontology_main WHERE section_tipo = 'ontology35' AND string @> $1::text::jsonb`,
			[JSON.stringify({ hierarchy6: [{ value: tld }] })],
		);
	}
	for (const sectionTipo of SCRATCH_SECTIONS) {
		await sql.unsafe('DELETE FROM matrix_ontology WHERE section_tipo = $1', [sectionTipo]);
		await sql.unsafe('DELETE FROM matrix_hierarchy WHERE section_tipo = $1', [sectionTipo]);
		await sql.unsafe('DELETE FROM matrix_time_machine WHERE section_tipo = $1', [sectionTipo]);
		await sql.unsafe('DELETE FROM matrix_counter WHERE tipo = $1', [sectionTipo]);
	}
	// The registry rows of THESE two TLDs only (matched by their own TLD value).
	const registry = (await sql.unsafe(
		`SELECT section_id FROM matrix_hierarchy_main WHERE section_tipo = 'hierarchy1' AND string @> $1::text::jsonb`,
		[JSON.stringify({ hierarchy6: [{ value: TLD_A }] })],
	)) as { section_id: number }[];
	const registryB = (await sql.unsafe(
		`SELECT section_id FROM matrix_hierarchy_main WHERE section_tipo = 'hierarchy1' AND string @> $1::text::jsonb`,
		[JSON.stringify({ hierarchy6: [{ value: TLD_B }] })],
	)) as { section_id: number }[];
	const ids = new Set([...registry, ...registryB].map((row) => Number(row.section_id)));
	if (hierarchyAId !== undefined) ids.add(hierarchyAId);
	if (hierarchyBId !== undefined) ids.add(hierarchyBId);
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
}

/**
 * A throwaway profile + user, created through the write door (never the
 * superuser's own profile — see the file header). The profile holds no grant;
 * it exists only so provisioning has a creator whose grants are not real.
 */
async function buildCreator(): Promise<{ userId: number; profileId: number }> {
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
	return { userId, profileId };
}

/**
 * One scratch thesaurus: a registry row carrying its TLD, its name, and its
 * typology (hierarchy9 → hierarchy13/<typologyId>), then ensureHierarchy
 * provisions the nodes, flags it active and creates its root term. A failure
 * here is a blocker — every case below would be vacuous without it.
 */
async function provisionScratchHierarchy(tld: string, typologyId: number): Promise<number> {
	const hierarchyId = await createSectionRecord('hierarchy1', creatorUserId);
	const registry = (column: 'string' | 'relation', tipo: string, value: unknown) =>
		updateMatrixKeyData('matrix_hierarchy_main', 'hierarchy1', hierarchyId, column, tipo, value);
	await registry('string', 'hierarchy6', [{ id: 1, lang: 'lg-nolan', value: tld }]);
	await registry('string', 'hierarchy5', [
		{ id: 1, lang: 'lg-spa', value: `ZZ typology ${typologyId}` },
	]);
	await registry('relation', 'hierarchy9', [
		{
			type: 'dd151',
			section_tipo: 'hierarchy13',
			section_id: typologyId,
			from_component_tipo: 'hierarchy9',
		},
	]);
	const provisioned = await ensureHierarchy(hierarchyId, creatorUserId);
	if (!provisioned.ok) {
		throw new Error(
			`typology filter gate: the scratch thesaurus ${tld} did not provision (${provisioned.msg}; ${provisioned.errors.join('; ')}) — every case below would be vacuous.`,
		);
	}
	return hierarchyId;
}

beforeAll(async () => {
	// Pre-flight: a crashed earlier run must not skew a pin.
	await purgeScratch();
	const creator = await buildCreator();
	creatorUserId = creator.userId;
	creatorProfileId = creator.profileId;
	superuser = await resolvePrincipal(SUPERUSER_ID);
	hierarchyAId = await provisionScratchHierarchy(TLD_A, TYPOLOGY_A);
	hierarchyBId = await provisionScratchHierarchy(TLD_B, TYPOLOGY_B);
	await clearOntologyDerivedCaches();
}, 180000);

afterAll(async () => {
	await purgeScratch();
	await sql.unsafe('DELETE FROM matrix_profiles WHERE section_tipo = $1 AND section_id = $2', [
		'dd234',
		creatorProfileId,
	]);
	await sql.unsafe('DELETE FROM matrix_users WHERE section_tipo = $1 AND section_id = $2', [
		'dd128',
		creatorUserId,
	]);
	await clearOntologyDerivedCaches();
}, 180000);

/**
 * Read the tree-area boot payload as the superuser, with an optional
 * `properties` on the source — exactly the field the cataloguing tool's area
 * instance sends (create_source → source.properties).
 */
async function readTree(
	properties: Record<string, unknown> | undefined,
): Promise<{ hierarchies: { section_id: unknown }[]; typologies: { section_id: unknown }[] }> {
	const token = createSession(
		superuser.userId,
		`user_${superuser.userId}`,
		superuser.isGlobalAdmin,
	);
	const session = getSession(token);
	const source: Record<string, unknown> = {
		typo: 'source',
		model: 'area_thesaurus',
		tipo: AREA_TIPO,
		section_tipo: AREA_TIPO,
		action: 'get_data',
		mode: 'list',
		lang: 'lg-spa',
	};
	if (properties !== undefined) source.properties = properties;
	const rqo = {
		id: 'typology_filter_gate',
		action: 'read',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		options: {},
		source,
	} as unknown as Rqo;
	const dispatched = await dispatchRqo(rqo, {
		requestId: 'typology_filter_gate',
		clientIp: '127.0.0.1',
		session,
		csrfCandidate: session?.csrfToken ?? null,
		principal: superuser,
	} as never);
	const data = (
		dispatched.body as { data?: { data?: { value?: unknown[]; typologies?: unknown[] }[] } }
	).data?.data?.[0];
	return {
		hierarchies: (data?.value ?? []) as { section_id: unknown }[],
		typologies: (data?.typologies ?? []) as { section_id: unknown }[],
	};
}

/** The registry ids the payload carries — the scratch pair is matched by their own id. */
function ownedIds(hierarchies: { section_id: unknown }[]): number[] {
	return hierarchies
		.map((hierarchy) => Number(hierarchy.section_id))
		.filter((id) => id === hierarchyAId || id === hierarchyBId);
}

describe('tree-area typology filter (ddo properties.hierarchy_types)', () => {
	test('fixture floor: both scratch hierarchies are served by an unfiltered read', async () => {
		// Verified through the real read, not by trusting the writes: a scratch
		// hierarchy that is not servable would make the filter cases vacuous.
		const { hierarchies } = await readTree(undefined);
		expect(ownedIds(hierarchies).sort()).toEqual([hierarchyAId, hierarchyBId].sort());
	});

	test('declared typology A: only the typology-A hierarchy is projected; B is never loaded', async () => {
		const { hierarchies, typologies } = await readTree({ hierarchy_types: [TYPOLOGY_A] });
		expect(ownedIds(hierarchies)).toEqual([hierarchyAId]);
		// The typology list is rebuilt from the surviving hierarchies only.
		const typologyIds = typologies.map((typology) => Number(typology.section_id));
		expect(typologyIds).toContain(TYPOLOGY_A);
		expect(typologyIds).not.toContain(TYPOLOGY_B);
	});

	test('declared typology B: only the typology-B hierarchy is projected; A is never loaded', async () => {
		const { hierarchies } = await readTree({ hierarchy_types: [TYPOLOGY_B] });
		expect(ownedIds(hierarchies)).toEqual([hierarchyBId]);
	});

	test('a single declared id (not a list) is read the same way', async () => {
		const { hierarchies } = await readTree({ hierarchy_types: TYPOLOGY_A });
		expect(ownedIds(hierarchies)).toEqual([hierarchyAId]);
	});

	test('a typology no hierarchy carries admits NOTHING (no fall-back to everything)', async () => {
		// Positive control in the same test: the scratch pair IS servable, so the
		// empty answer below is the filter's verdict, not a read that saw nothing.
		expect(ownedIds((await readTree(undefined)).hierarchies)).toHaveLength(2);
		const { hierarchies } = await readTree({ hierarchy_types: [TYPOLOGY_UNUSED] });
		expect(ownedIds(hierarchies)).toEqual([]);
	});

	test('a declared typology id in string form matches the same typology', async () => {
		const { hierarchies } = await readTree({ hierarchy_types: [String(TYPOLOGY_A)] });
		expect(ownedIds(hierarchies)).toEqual([hierarchyAId]);
	});

	test('a non-empty declaration of no valid id admits NOTHING (not everything)', async () => {
		// Positive control (see the unused-typology case above).
		expect(ownedIds((await readTree(undefined)).hierarchies)).toHaveLength(2);
		const { hierarchies } = await readTree({ hierarchy_types: ['not-a-typology'] });
		expect(ownedIds(hierarchies)).toEqual([]);
	});

	test('an EMPTY declared list is no narrowing (PHP !empty() rule): every active hierarchy', async () => {
		const { hierarchies } = await readTree({ hierarchy_types: [] });
		expect(ownedIds(hierarchies).sort()).toEqual([hierarchyAId, hierarchyBId].sort());
	});

	test('a read with no hierarchy_types declared keeps every active hierarchy (unchanged browse)', async () => {
		const { hierarchies } = await readTree({ some_other_property: true });
		expect(ownedIds(hierarchies).sort()).toEqual([hierarchyAId, hierarchyBId].sort());
	});
});
