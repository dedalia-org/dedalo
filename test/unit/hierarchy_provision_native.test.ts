/**
 * DEC-14b — TS-NATIVE write-path coverage for the two ONTOLOGY-provisioning
 * differentials that are fixture-exempt (write-path gates SKIP without the live
 * PHP oracle): test/parity/generate_virtual_section_differential.test.ts and
 * test/parity/ontology_delete_differential.test.ts. Those gates stay the
 * PHP-comparison bar; THIS file pins the same shapes as literals so the
 * write-path contract still reddens on a credless machine.
 *
 * Expectations are derived from the PHP oracle source, not from what TS emits:
 *  - provisioning: PHP hierarchy::generate_virtual_section (class.hierarchy.php
 *    :228) / provision_virtual_sections (:459) — node structure, the <tld>0/1
 *    descriptor + <tld>0/2 model component-key sets, the byte pins the TS module
 *    header records as PHP-verified (descriptor ontology7 lang lg-spa vs the
 *    registration's lg-nolan; the BARE ontology15 parent locator; the
 *    hierarchy53/58 write-back items).
 *  - delete cascade: PHP ontology::delete_main (class.ontology.php:2803) →
 *    delete_ontology (:2994) steps 1 (dd_ontology nodes purged) + 3 (every
 *    matrix_ontology '<tld>0' record deleted), PLUS the registry record itself
 *    — which PHP strands (live defect, pinned in the differential); the
 *    TS-correct completion is asserted here, same as the differential's TS leg.
 *
 * ONE synthetic scratch TLD ('zznt' — no real install uses it; distinct from
 * the differentials' zzt/zzta/zztb/zzva/zzvb) is provisioned from a
 * hierarchy1-style registry record, asserted, uninstalled through the same
 * dd_core_api dispatch chokepoint the differential uses, and asserted again.
 * afterAll teardown is UNCONDITIONAL (runs the full purge even on partial
 * failure) and also runs defensively in beforeAll against a crashed prior run.
 *
 * THE REGISTRY-ROW LAW at this door (WC-2026-10-10-ontology-dependencies-hierarchy60):
 * provisionVirtualSections CREATES the ontology35 row when the TLD has none,
 * and never writes an EXISTING one. A second scratch TLD ('zznu') gets its row
 * minted first (createMainSection) with the operator's own name, typology,
 * switched-off hierarchy4 and filter; provisioning it from a hierarchy carrying
 * a DIFFERENT name and typology must leave the row byte-equal and build `zznu0`
 * from what the row holds.
 *
 * Shared-surface note (same blast radius as the differential): provisioning
 * re-derives the ontologytype/hierarchytype/hierarchymtype grouper registrations
 * idempotently — those are canonical rows both engines rebuild the same way.
 *
 * @twin-of      test/parity/generate_virtual_section_differential.test.ts
 * @twin-status  retired
 */
// Migrated to the generic `test` TLD 2026-08-20 (AGENTS.md hard rule). The tipos are
// identifiers threaded through the unit under test — a generic `test` section carries
// the same meaning here as the install one did.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import { deleteTldNodes } from '../../src/core/db/dd_ontology.ts';
import { updateMatrixKeyData } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import {
	type GenerateVirtualSectionResponse,
	generateVirtualSection,
} from '../../src/core/ontology/hierarchy_provision.ts';
import { createMainSection } from '../../src/core/ontology/ontology_write.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';

const TLD = 'zznt'; // synthetic scratch TLD — swept by the zz% hygiene query
/** The TLD whose ontology35 row EXISTS before provisioning (the no-rewrite leg). */
const TLD_PRE = 'zznu';
const REAL_SECTION = 'test3'; // model 'section' (same source the differential uses)
const NAME = `${TLD} native`;

let hierarchyId: number | undefined;
let provisioned: GenerateVirtualSectionResponse | undefined;
/** Throwaway grantee (see buildGranteeFixture) — never a real user/profile. */
let granteeUserId: number | undefined;
let granteeProfileId: number | undefined;

interface NodeShape {
	suffix: string; // tipo with the tld prefix stripped ('0' | '1' | '2')
	parent: string | null; // exact parent term-id (typology 1 groupers)
	model: string | null;
	model_tipo: string | null;
	is_model: boolean;
	is_translatable: boolean;
	is_main: boolean;
	term: Record<string, string> | null;
}

/**
 * SCRATCH GRANTEE — provisioning now grants the creating user's PROFILE level 2
 * over the two new virtual sections (PHP set_section_permissions). The grant is
 * written to a REAL profile record, so this file must NOT provision as a real
 * user: user -1 resolves to profile dd234/2, a live production record with
 * thousands of grants. Instead we create a throwaway profile + a throwaway user
 * pointing at it (dd1725), provision as that user, assert the grant landed on
 * the throwaway, and delete both in the purge.
 */
async function buildGranteeFixture(): Promise<{ userId: number; profileId: number }> {
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

/** The scratch profile's dd774 grant entries, as stored. */
async function granteeGrants(): Promise<{ tipo: string; section_tipo: string; value: number }[]> {
	if (granteeProfileId === undefined) return [];
	const rows = (await sql.unsafe(
		"SELECT misc->'dd774' AS grants FROM matrix_profiles WHERE section_tipo = 'dd234' AND section_id = $1",
		[granteeProfileId],
	)) as { grants: { tipo: string; section_tipo: string; value: number }[] | null }[];
	return rows[0]?.grants ?? [];
}

/** Same hierarchy1 registry fixture the differential seeds (typology 1). */
async function buildHierarchyFixture(tld: string = TLD, name: string = NAME): Promise<number> {
	const hid = await createSectionRecord('hierarchy1', -1);
	const w = (col: 'relation' | 'string', tipo: string, v: unknown): Promise<void> =>
		updateMatrixKeyData('matrix_hierarchy_main', 'hierarchy1', hid, col, tipo, v);
	await w('relation', 'hierarchy4', [
		{
			id: 1,
			type: 'dd151',
			section_tipo: 'dd64',
			section_id: '1',
			from_component_tipo: 'hierarchy4',
		},
	]);
	await w('string', 'hierarchy6', [{ id: 1, lang: 'lg-nolan', value: tld }]);
	await w('string', 'hierarchy109', [{ id: 1, lang: 'lg-nolan', value: REAL_SECTION }]);
	await w('relation', 'hierarchy9', [
		{
			type: 'dd151',
			section_tipo: 'hierarchy13',
			section_id: '1',
			from_component_tipo: 'hierarchy9',
		},
	]);
	await w('string', 'hierarchy5', [{ id: 1, lang: 'lg-spa', value: name }]);
	return hid;
}

async function nodeShapes(): Promise<NodeShape[]> {
	const rows = (await sql.unsafe(
		'SELECT tipo, parent, model, model_tipo, is_model, is_translatable, is_main, term FROM dd_ontology WHERE tld = $1 ORDER BY tipo',
		[TLD],
	)) as {
		tipo: string;
		parent: string | null;
		model: string | null;
		model_tipo: string | null;
		is_model: boolean;
		is_translatable: boolean;
		is_main: boolean;
		term: Record<string, string> | null;
	}[];
	return rows.map((row) => ({
		suffix: row.tipo.slice(TLD.length),
		parent: row.parent,
		model: row.model,
		model_tipo: row.model_tipo,
		is_model: row.is_model,
		is_translatable: row.is_translatable,
		is_main: row.is_main,
		term: row.term,
	}));
}

async function nodeRecordCols(sectionId: number): Promise<{
	relation: Record<string, unknown> | null;
	string: Record<string, unknown> | null;
}> {
	const rows = (await sql.unsafe(
		'SELECT relation, string FROM matrix_ontology WHERE section_tipo = $1 AND section_id = $2',
		[`${TLD}0`, sectionId],
	)) as { relation: Record<string, unknown> | null; string: Record<string, unknown> | null }[];
	return rows[0] ?? { relation: null, string: null };
}

/** Only the ONTOLOGY component keys — the audit keys (dd199/dd200/…) are create-path metadata. */
function ontologyKeys(obj: Record<string, unknown> | null): string[] {
	return Object.keys(obj ?? {})
		.filter((key) => key.startsWith('ontology'))
		.sort();
}

/** The scratch hierarchy1 record ids this run created (both TLDs). */
const hierarchyIds = new Set<number>();
/**
 * The scratch ontology35 registry row ids this run saw — recorded while the rows
 * exist, because the delete leg removes zznt's row through the dispatch before
 * the purge can find it by TLD.
 */
const ontologyMainIds = new Set<number>();

async function recordOntologyMainIds(tld: string): Promise<void> {
	const rows = (await sql.unsafe(
		`SELECT section_id FROM matrix_ontology_main WHERE section_tipo = 'ontology35' AND string @> $1::text::jsonb`,
		[JSON.stringify({ hierarchy6: [{ value: tld }] })],
	)) as { section_id: number }[];
	for (const row of rows) ontologyMainIds.add(Number(row.section_id));
}

/** Delete one record's TM rows and its activity rows (addressed in misc->'dd551'). */
async function purgeRecordTrail(sectionTipo: string, sectionId: number): Promise<void> {
	await sql.unsafe('DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2', [
		sectionTipo,
		sectionId,
	]);
	await sql.unsafe(
		`DELETE FROM matrix_activity WHERE section_tipo = 'dd542'
		    AND misc->'dd551'->0->'value'->>'section_tipo' = $1
		    AND misc->'dd551'->0->'value'->>'section_id' = $2`,
		[sectionTipo, String(sectionId)],
	);
}

/** Purge one scratch TLD: nodes, node records, ontology35 + hierarchy1 rows and their trails. */
async function purgeTld(tld: string): Promise<void> {
	const tldFilter = JSON.stringify({ hierarchy6: [{ value: tld }] });
	await deleteTldNodes(tld);
	await sql.unsafe('DELETE FROM matrix_ontology WHERE section_tipo = $1', [`${tld}0`]);
	await recordOntologyMainIds(tld);
	await sql.unsafe(
		`DELETE FROM matrix_ontology_main WHERE section_tipo = 'ontology35' AND string @> $1::text::jsonb`,
		[tldFilter],
	);
	// Registry rows of the scratch TLD (also catches strays from a crashed run).
	const registry = (await sql.unsafe(
		`SELECT section_id FROM matrix_hierarchy_main WHERE section_tipo = 'hierarchy1' AND string @> $1::text::jsonb`,
		[tldFilter],
	)) as { section_id: number }[];
	for (const row of registry) hierarchyIds.add(Number(row.section_id));
	// TM snapshots + activity rows of the scratch node records.
	await sql.unsafe('DELETE FROM matrix_time_machine WHERE section_tipo = $1', [`${tld}0`]);
	await sql.unsafe(
		`DELETE FROM matrix_activity WHERE section_tipo = 'dd542'
		    AND misc->'dd551'->0->'value'->>'section_tipo' = $1`,
		[`${tld}0`],
	);
	// The scratch section's counter row (PHP resets it in delete_ontology step 4).
	await sql.unsafe('DELETE FROM matrix_counter WHERE tipo = $1', [`${tld}0`]);
}

/** Unconditional purge of every surface this file can touch (also run pre-flight). */
async function purgeScratch(): Promise<void> {
	await purgeTld(TLD);
	await purgeTld(TLD_PRE);
	for (const id of ontologyMainIds) await purgeRecordTrail('ontology35', id);
	if (hierarchyId !== undefined) hierarchyIds.add(hierarchyId);
	for (const rid of hierarchyIds) {
		await sql.unsafe(
			`DELETE FROM matrix_hierarchy_main WHERE section_tipo = 'hierarchy1' AND section_id = $1`,
			[rid],
		);
		await purgeRecordTrail('hierarchy1', rid);
	}

	// The throwaway grantee: profile (+ its dd774 grants), user, and the TM rows
	// the grant's save chokepoint wrote. Real users/profiles are never touched —
	// only the ids this run created.
	if (granteeProfileId !== undefined) {
		await sql.unsafe(
			"DELETE FROM matrix_profiles WHERE section_tipo = 'dd234' AND section_id = $1",
			[granteeProfileId],
		);
		await sql.unsafe(
			"DELETE FROM matrix_time_machine WHERE section_tipo = 'dd234' AND section_id = $1",
			[granteeProfileId],
		);
	}
	if (granteeUserId !== undefined) {
		await sql.unsafe("DELETE FROM matrix_users WHERE section_tipo = 'dd128' AND section_id = $1", [
			granteeUserId,
		]);
		await sql.unsafe(
			"DELETE FROM matrix_time_machine WHERE section_tipo = 'dd128' AND section_id = $1",
			[granteeUserId],
		);
	}
	await clearOntologyDerivedCaches();
}

beforeAll(async () => {
	await purgeScratch(); // defensive: a crashed earlier run must not skew the pins
	const grantee = await buildGranteeFixture();
	granteeUserId = grantee.userId;
	granteeProfileId = grantee.profileId;
	hierarchyId = await buildHierarchyFixture();
	provisioned = await generateVirtualSection({
		section_id: hierarchyId,
		section_tipo: 'hierarchy1',
		userId: granteeUserId,
	});
	await recordOntologyMainIds(TLD);
}, 120000);

afterAll(async () => {
	await purgeScratch();
	// Residue: no node, node record, registry row, or activity trail survives.
	const ids = JSON.stringify([...ontologyMainIds].map(String));
	const tlds = JSON.stringify([TLD, TLD_PRE]);
	const residue = (await sql.unsafe(
		`SELECT (SELECT count(*)::int FROM dd_ontology WHERE tld IN (SELECT jsonb_array_elements_text($1::text::jsonb)))
		      + (SELECT count(*)::int FROM matrix_ontology
		           WHERE section_tipo IN (SELECT jsonb_array_elements_text($1::text::jsonb) || '0'))
		      + (SELECT count(*)::int FROM matrix_activity WHERE section_tipo = 'dd542'
		           AND (misc->'dd551'->0->'value'->>'section_tipo' IN (SELECT jsonb_array_elements_text($1::text::jsonb) || '0')
		             OR (misc->'dd551'->0->'value'->>'section_tipo' = 'ontology35'
		                 AND misc->'dd551'->0->'value'->>'section_id' IN (SELECT jsonb_array_elements_text($2::text::jsonb)))))
		        AS n`,
		[tlds, ids],
	)) as { n: number }[];
	expect(ontologyMainIds.size).toBe(2); // zznt's (provisioned) + zznu's (minted first)
	expect(Number(residue[0]?.n ?? -1)).toBe(0);
});

describe('generate_virtual_section — TS-native provisioning of a scratch TLD', () => {
	test('provisioning succeeds with NO errors (the permission grant is ported)', () => {
		expect(provisioned?.ok).toBe(true);
		expect(provisioned?.errors).toEqual([]);
	});

	// PHP hierarchy::generate_virtual_section :745-761 → component_security_access
	// ::set_section_permissions(ar_section_tipo:[<tld>1,<tld>2], permissions:2):
	// the creating user's PROFILE is granted level 2 over both new virtual
	// sections AND every element inside them, or the hierarchy they just built is
	// invisible to them.
	test('the creating user’s profile is granted level 2 over <tld>1 and <tld>2', async () => {
		const grants = await granteeGrants();
		const find = (tipo: string, sectionTipo: string) =>
			grants.find((entry) => entry.tipo === tipo && entry.section_tipo === sectionTipo);

		expect(find(`${TLD}1`, `${TLD}1`)?.value).toBe(2);
		expect(find(`${TLD}2`, `${TLD}2`)?.value).toBe(2);
	});

	test('the grant expands to the sections’ elements, keyed by the virtual section', async () => {
		const grants = await granteeGrants();

		// Elements are read from the REAL source section (test3) but keyed by the
		// section AS ADDRESSED (zznt1/zznt2) — that pairing is the whole point:
		// permissions.ts looks grants up as `${section_tipo}_${tipo}`.
		for (const virtualSection of [`${TLD}1`, `${TLD}2`]) {
			const elements = grants.filter(
				(entry) => entry.section_tipo === virtualSection && entry.tipo !== virtualSection,
			);
			expect(elements.length).toBeGreaterThan(0);
			expect(elements.every((entry) => entry.value === 2)).toBe(true);
			// The elements are the source section's components, never the source
			// section tipo itself (which would grant test3 wholesale).
			expect(elements.some((entry) => entry.tipo === REAL_SECTION)).toBe(false);
		}
	});

	// Every persisted item carries an id (PHP set_data → set_data_item_counter);
	// the save chokepoint stamps it. A pair is stored exactly once — rerunning a
	// grant updates in place instead of appending a duplicate.
	test('grant entries carry an item id and no (tipo, section_tipo) pair repeats', async () => {
		const grants = await granteeGrants();
		expect(grants.length).toBeGreaterThan(0);
		expect(grants.every((entry) => Number.isFinite((entry as { id?: number }).id as number))).toBe(
			true,
		);

		const keys = grants.map((entry) => `${entry.section_tipo}_${entry.tipo}`);
		expect(new Set(keys).size).toBe(keys.length);
	});

	test('dd_ontology node structure (root + descriptor + model twin, typology-1 groupers)', async () => {
		// PHP provision_virtual_sections: <tld>0 root (model 'section'/dd6, is_main,
		// parent = ontologytype grouper), <tld>1 descriptor (parent hierarchytype
		// grouper, is_model false), <tld>2 model twin (parent hierarchymtype
		// grouper, is_model true). model = dd6.term['lg-spa'] = 'section'.
		expect(await nodeShapes()).toEqual([
			{
				suffix: '0',
				parent: 'ontologytype1',
				model: 'section',
				model_tipo: 'dd6',
				is_model: false,
				is_translatable: false,
				is_main: true,
				term: { 'lg-spa': NAME },
			},
			{
				suffix: '1',
				parent: 'hierarchytype1',
				model: 'section',
				model_tipo: 'dd6',
				is_model: false,
				is_translatable: false, // ontology8 written as si/no NO
				is_main: false,
				term: { 'lg-spa': NAME },
			},
			{
				suffix: '2',
				parent: 'hierarchymtype1',
				model: 'section',
				model_tipo: 'dd6',
				is_model: true, // ontology30 → dd64/1 flipped on the model twin only
				is_translatable: false,
				is_main: false,
				term: { 'lg-spa': NAME },
			},
		]);
	});

	test('root node carries the PHP-pinned relations + properties', async () => {
		// PHP create_dd_ontology_ontology_section_node (:1042).
		const rows = (await sql.unsafe(
			'SELECT relations, properties FROM dd_ontology WHERE tipo = $1',
			[`${TLD}0`],
		)) as { relations: unknown; properties: unknown }[];
		expect(rows[0]?.relations).toEqual([{ tipo: 'ontology1' }, { tipo: 'dd1201' }]);
		expect(rows[0]?.properties).toEqual({ main_tld: TLD, color: '#2d8894' });
	});

	// The two key-set pins below carry the section's BIRTH DEFAULTS as well as
	// what the provisioner writes explicitly (WC-2026-08-09-record-birth-defaults):
	// ontology0 declares a component_filter (ontology26, the project) and a
	// `dato_default` on ontology30 ("Is model" → dd64/2 = no). Both are what a
	// real ontology node record carries — all 41 ontology0 records in the dev
	// install AND all 41 in the production one have ontology26 and ontology30 —
	// so the previous expectation pinned a TS-only impoverished row, not PHP's.
	// A per-caller `seedDefaults:false` would have kept the old bytes by making
	// provisioned records structurally different from curator-made ones; a
	// record's ontology-declared birth state does not depend on which door made
	// it.
	test('descriptor <tld>0/1 component-key sets (the shapes the differential derives live)', async () => {
		const rec1 = await nodeRecordCols(1);
		expect(ontologyKeys(rec1.relation)).toEqual([
			'ontology10', // connected-to → the real source section
			'ontology15', // parent (hierarchytype grouper)
			'ontology26', // project filter (birth default)
			'ontology3', // publication yes
			'ontology30', // "Is model" = dd64/2 "no" (ontology30 dato_default)
			'ontology4', // is_descriptor yes
			'ontology6', // model → dd0/6
			'ontology8', // translatable no
		]);
		expect(ontologyKeys(rec1.string)).toEqual(['ontology5', 'ontology7']);
	});

	test('model <tld>0/2 component-key sets = the descriptor set, ontology30 FLIPPED', async () => {
		const rec2 = await nodeRecordCols(2);
		expect(ontologyKeys(rec2.relation)).toEqual([
			'ontology10',
			'ontology15',
			'ontology26',
			'ontology3',
			'ontology30', // the provisioner OVERWRITES the dd64/2 default with dd64/1
			'ontology4',
			'ontology6',
			'ontology8',
		]);
		expect(ontologyKeys(rec2.string)).toEqual(['ontology5', 'ontology7']);
	});

	test('ontology30 is the "no" DEFAULT on the descriptor and the explicit "yes" on the model', async () => {
		// The birth default must not survive where the provisioner means the
		// opposite: a model twin born with dd64/2 and never overwritten would
		// parse as `is_model:false` and the whole section would stop being a model.
		const rec1 = await nodeRecordCols(1);
		const rec2 = await nodeRecordCols(2);
		expect(
			(rec1.relation?.ontology30 as { section_id?: unknown }[] | undefined)?.map(
				(item) => item.section_id,
			),
		).toEqual([2]); // dd64/2 = "no" (int-canonical stored address)
		expect(
			(rec2.relation?.ontology30 as { section_id?: unknown }[] | undefined)?.map(
				(item) => item.section_id,
			),
		).toEqual([1]); // dd64/1 = "yes"
	});

	test('byte pins: descriptor tld item is lg-spa; ontology15 parent locators are BARE', async () => {
		const rec1 = await nodeRecordCols(1);
		const rec2 = await nodeRecordCols(2);
		// ontology7 lang lg-spa (DEDALO_DATA_LANG) — DIFFERS from the registration's lg-nolan.
		expect(rec1.string?.ontology7).toEqual([{ id: 1, lang: 'lg-spa', value: TLD }]);
		// BARE {section_tipo, section_id} — no type / from_component_tipo (PHP-pinned
		// shape; the id is int-canonical, WC-2026-08-10-section-id-int-canonical).
		expect(rec1.relation?.ontology15).toEqual([{ section_tipo: 'hierarchytype0', section_id: 1 }]);
		expect(rec2.relation?.ontology15).toEqual([{ section_tipo: 'hierarchymtype0', section_id: 1 }]);
		// The is_model flip is a full link locator to dd64/1.
		expect(rec2.relation?.ontology30).toEqual([
			{
				id: 1,
				type: 'dd151',
				// int-canonical (WC-2026-08-10-section-id-int-canonical)
				section_id: 1,
				section_tipo: 'dd64',
				from_component_tipo: 'ontology30',
			},
		]);
	});

	test('hierarchy53/58 target-section pointers written back on the registry record', async () => {
		const rows = (await sql.unsafe(
			`SELECT string->'hierarchy53' AS h53, string->'hierarchy58' AS h58
			 FROM matrix_hierarchy_main WHERE section_tipo = 'hierarchy1' AND section_id = $1`,
			[hierarchyId ?? -1],
		)) as { h53: unknown; h58: unknown }[];
		expect(rows[0]?.h53).toEqual([{ id: 1, lang: 'lg-nolan', value: `${TLD}1` }]);
		expect(rows[0]?.h58).toEqual([{ id: 1, lang: 'lg-nolan', value: `${TLD}2` }]);
	});

	test('ontology35 registration row exists and its tld item is lg-nolan', async () => {
		// createMainSection (PHP add_main_section :809) — hierarchy6 uses lg-nolan,
		// the counterpart of the descriptor's lg-spa pin above.
		const rows = (await sql.unsafe(
			`SELECT string->'hierarchy6' AS h6 FROM matrix_ontology_main
			 WHERE section_tipo = 'ontology35' AND string @> $1::text::jsonb`,
			[JSON.stringify({ hierarchy6: [{ value: TLD }] })],
		)) as { h6: unknown }[];
		expect(rows.length).toBe(1);
		expect(rows[0]?.h6).toEqual([{ id: 1, lang: 'lg-nolan', value: TLD }]);
	});
});

describe('ontology_delete — TS-native cascade through the dispatch chokepoint', () => {
	test('deleting the registry record uninstalls the TLD (nodes + node records + registry row)', async () => {
		expect(hierarchyId).toBeDefined();

		// Same dispatch-chokepoint path the differential drives.
		const token = createSession(-1, 'root', true);
		const session = getSession(token);
		const principal = await resolvePrincipal(-1);
		const result = await dispatchRqo(
			{
				action: 'delete',
				dd_api: 'dd_core_api',
				prevent_lock: true,
				source: {
					typo: 'source',
					model: 'section',
					tipo: 'hierarchy1',
					section_tipo: 'hierarchy1',
					section_id: String(hierarchyId),
					action: 'delete',
					delete_mode: 'delete_record',
				},
			} as never,
			{
				requestId: 't',
				clientIp: '127.0.0.1',
				session,
				csrfCandidate: session?.csrfToken ?? null,
				principal,
			} as never,
		);
		expect(result.status).toBe(200);

		// Step 1 — every dd_ontology row of the tld is gone.
		const nodes = (await sql.unsafe('SELECT COUNT(*) AS n FROM dd_ontology WHERE tld = $1', [
			TLD,
		])) as { n: string }[];
		expect(Number(nodes[0]?.n)).toBe(0);

		// The registry matrix row is gone (PHP strands it — live defect pinned in
		// the differential; this is the TS-correct completed uninstall).
		const main = (await sql.unsafe(
			`SELECT 1 FROM matrix_hierarchy_main WHERE section_tipo = 'hierarchy1' AND section_id = $1`,
			[hierarchyId ?? -1],
		)) as unknown[];
		expect(main.length).toBe(0);

		// Step 3 — every matrix_ontology record of the '<tld>0' section is gone
		// (PHP delete_ontology :2994 deletes all node records via the sections
		// delete pipeline).
		const records = (await sql.unsafe(
			'SELECT COUNT(*) AS n FROM matrix_ontology WHERE section_tipo = $1',
			[`${TLD}0`],
		)) as { n: string }[];
		expect(Number(records[0]?.n)).toBe(0);
	}, 60000);
});

describe('generate_virtual_section — an EXISTING ontology35 row is never rewritten', () => {
	const OFF = [
		{
			id: 1,
			type: 'dd151',
			section_id: 2,
			section_tipo: 'dd64',
			from_component_tipo: 'hierarchy4',
		},
	];
	const CUSTOM_FILTER = [
		{
			id: 1,
			type: 'dd675',
			section_id: 7,
			section_tipo: 'dd153',
			from_component_tipo: 'hierarchy54',
		},
	];

	test('the row stays byte-equal; <tld>0 is built from the row, not from the hierarchy', async () => {
		// The installation's row: its own name + typology, switched off, custom filter.
		const rowId = await createMainSection(
			{
				tld: TLD_PRE,
				typology_id: 14,
				name_data: [{ lang: 'lg-eng', value: 'zznu operator name' }],
			},
			-1,
		);
		ontologyMainIds.add(rowId);
		await sql.unsafe(
			`UPDATE matrix_ontology_main SET relation = relation || $2::text::jsonb
			  WHERE section_tipo = 'ontology35' AND section_id = $1`,
			[rowId, JSON.stringify({ hierarchy4: OFF, hierarchy54: CUSTOM_FILTER })],
		);
		const readRow = async () =>
			(await sql.unsafe(
				`SELECT data, relation, string, misc FROM matrix_ontology_main
				  WHERE section_tipo = 'ontology35' AND section_id = $1`,
				[rowId],
			)) as unknown[];
		const before = await readRow();
		expect(before).toHaveLength(1);

		// A hierarchy for the same TLD with a DIFFERENT typology (1) and name.
		const preHierarchyId = await buildHierarchyFixture(TLD_PRE, 'zznu hierarchy name');
		hierarchyIds.add(preHierarchyId);
		const response = await generateVirtualSection({
			section_id: preHierarchyId,
			section_tipo: 'hierarchy1',
			userId: granteeUserId ?? -1,
		});
		expect(response.errors).toEqual([]);
		expect(response.ok).toBe(true);

		expect(await readRow()).toEqual(before);
		const roots = (await sql.unsafe('SELECT parent, term FROM dd_ontology WHERE tipo = $1', [
			`${TLD_PRE}0`,
		])) as { parent: string; term: Record<string, string> }[];
		expect(roots).toHaveLength(1);
		expect(roots[0]?.parent).toBe('ontologytype14');
		expect(roots[0]?.term['lg-eng']).toBe('zznu operator name');
	}, 120000);
});
