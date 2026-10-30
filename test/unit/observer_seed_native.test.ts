/**
 * D3 — THE VALUE LAW of set_dato_external: gates for the SEED of the
 * external-value search (observers.ts buildExternalSeed/collectExternalSeed +
 * relations/related.ts getStoredWithReferences), the references_limit
 * refusal, and the PHP >2000-reference freeze.
 *
 * THE LAW (PHP v6 class.component_relation_common.php:1996-2022): the
 * inverse-reference search is seeded with the TARGET record PLUS every
 * locator reachable through properties.source.data_from_field — each peer's
 * bag "with references" (stored dato ∪ the typeRel-gated closure, PHP
 * get_dato_with_references) — every entry re-stamped with
 * from_component_tipo = component_to_search. MEASURED over 19,908 numisdata3
 * records holding numisdata77 (against the v6-migrated bags = v6's correct
 * answer): self-only loses 318,122 locators, self+stored-bag (ONE hop) still
 * loses 247,933; only the dd621 symmetric transitive closure converges
 * (19,885 exact / 13 lost). The flip test below makes dropping the recursive
 * half RED.
 *
 * Tiers here:
 *   1. ontology cross-check — the pinned declared-users table matches the
 *      REAL dd_ontology rows (the suite DB carries the numisdata/test nodes;
 *      tch33 is absent from it, tolerated per-row but never wholesale);
 *   2. hermetic seed law — injected in-memory graph, exact seed asserted
 *      (incl. re-stamp, dedup, malformed-drop) per declared user, and the
 *      dd621→dd467→dd620 flip monotonically SHRINKS the seed;
 *   3. static pins — the kernel searches with the D3 seed, limit:false and
 *      the pure-SQL PHP order (no silent revert to the single-locator seed);
 *   4. behavioral (suite DB, scratch) — end-to-end recompute through a real
 *      dd621 equivalence chain (term 58 ≡ 59 ≡ 60), and the >2000 freeze
 *      refusing the persist.
 *
 * Scratch hygiene: ontology nodes in the test999xx band (scratch by
 * construction, swept before seeding); matrix rows in dedicated id bands,
 * swept in afterAll. Everything is presence-guarded on the seeded term chain
 * (a live-snapshot DB skips loudly, exactly like observer_reconcile_native).
 */
// BINDS INSTALL TLDs: numisdata, on, rsc, tch — install-specific fixtures, grandfathered in
// engineering/generic_tld_baseline.json (generic_tld_tripwire, shrink-only). This test
// is meaningful only on a database holding those installs' records. Migrate it to a
// built situation (src/core/test_data/situations) or the generic `test` TLD, then
// regenerate the baseline (`bun run scripts/generic_tld_baseline.ts`).

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCounters } from '../../src/core/api/counters.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { getMatrixTableFromTipo, getNode } from '../../src/core/ontology/resolver.ts';
import type { RelatedGraphIO, RelatedReference } from '../../src/core/relations/related.ts';
import {
	buildExternalSeed,
	collectExternalSeed,
	nextObserverItemId,
	recomputeExternalRelation,
} from '../../src/core/section/record/observers.ts';
import cloneMapJson from '../../src/core/test_data/test_tld_tipo_map.json';
import {
	dropObserverTerm,
	ensureObserverTerm,
	INDEXER,
	MIRROR,
	REF_SECTION,
	SEED_TERM,
	TERM_SECTION,
} from '../helpers/observer_term_seed.ts';
import installDataFromFieldJson from './fixtures/observer_seed/install_data_from_field.json';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const kernelSource = readFileSync(join(REPO_ROOT, 'src/core/section/record/observers.ts'), 'utf-8');
// Law (c)'s compute moved out of the kernel into its law module (2026-10-30
// external-value law registry); the kernel keeps the refusals around it.
const lawCSource = readFileSync(
	join(REPO_ROOT, 'src/core/section/record/external_laws/inverse_search.ts'),
	'utf-8',
);

// ---------------------------------------------------------------------------
// The REAL declared data_from_field users (app ontology census 2026-08-02:
// `properties->'source' ? 'data_from_field'` — exactly these four; every
// declared peer is component_relation_related with relation_type_rel dd621).
// ---------------------------------------------------------------------------
/** The phase-2 source→target clone map (append-only; see the census below). */
const CLONE_MAP = cloneMapJson as { map: Record<string, { target: string }> };

/**
 * The generic half — repo-owned `test` ontology, present wherever the suite
 * runs, so this is the half that MUST be there.
 */
const DECLARED_USERS_GENERIC = [
	{ tipo: 'test199', cts: 'test188', dff: ['test200'], sts: ['test65'] },
] as const;

/**
 * The install half, READ FROM DATA
 * (fixtures/observer_seed/install_data_from_field.json). It used to be typed
 * here, which bound this gate to one installation two ways: the census counted
 * the tipos, and the floor below demanded that ontology be PRESENT — `present
 * >= 3` could only ever hold on a database carrying `numisdata`. Now the pins
 * are still enforced where the ontology exists, and its absence is what it
 * actually is: a different installation.
 */
const DECLARED_USERS_INSTALL = (
	installDataFromFieldJson as {
		users: { tipo: string; cts: string; dff: string[]; sts: string[] }[];
	}
).users;

const DECLARED_USERS = [...DECLARED_USERS_GENERIC, ...DECLARED_USERS_INSTALL];

describe('D3 declared data_from_field users (ontology cross-check)', () => {
	test('the pinned table matches the real dd_ontology declarations', async () => {
		let present = 0;
		for (const user of DECLARED_USERS) {
			const node = await getNode(user.tipo);
			if (node === null) continue; // suite DB carries no tchi ontology
			present++;
			const source = (
				node.properties as {
					source?: {
						component_to_search?: string[];
						data_from_field?: string[];
						section_to_search?: string[];
					};
				}
			)?.source;
			expect(source?.component_to_search).toEqual([user.cts]);
			expect(source?.data_from_field).toEqual([...user.dff]);
			expect(source?.section_to_search).toEqual([...user.sts]);
			// every declared peer is law (c) — a sub-law key would make it a copy
			// law (or a refused one), and this table pins law (c)'s seed
			expect(source !== undefined && 'source_overwrite' in source).toBe(false);
			expect(source !== undefined && 'set_observed_data' in source).toBe(false);
		}
		// The GENERIC users must all be present — that is the anti-vacuity floor,
		// and it holds on every database the suite can run against. (It used to be
		// `>= 3`, which silently required the numisdata ontology.)
		for (const user of DECLARED_USERS_GENERIC) {
			expect(await getNode(user.tipo), `${user.tipo} must be declared`).not.toBeNull();
		}
		expect(present).toBeGreaterThanOrEqual(DECLARED_USERS_GENERIC.length);
	});

	test('reverse census: every data_from_field carrier in the DB is pinned (no 5th user ships silently)', async () => {
		// The forward table above checks the pinned users EXIST as declared —
		// this is the other direction (review 2026-08-02): enumerate ALL
		// carriers so a NEW data_from_field user cannot ship silently under the
		// TS-only law. Exclusions: the test999* band (this file's own scratch
		// observer test99910 declares data_from_field and is seeded by
		// beforeAll), and the snapshot-only carriers listed in the install data —
		// rows a suite-DB snapshot holds that the app
		// ontology no longer carries (verified absent from dedalo_mib_v7
		// 2026-08-02; same shape: peer numisdata36, cts numisdata161).
		// PLUS the phase-2 CLONES of those same carriers: the generic-`test`-TLD
		// migration copies an install subtree verbatim into a `test*` TLD, so
		// `numisdata77`'s twin carries `data_from_field` exactly as its source
		// does. The allowance is DERIVED from the committed clone map
		// (src/core/test_data/test_tld_tipo_map.json), never hand-typed: a
		// carrier is tolerated only when its SOURCE is already pinned above, so
		// a genuinely new 5th user — clone or not — still fails here.
		const allowed = new Set([
			...DECLARED_USERS.map((user) => user.tipo),
			...((installDataFromFieldJson as { snapshot_only_carriers?: string[] })
				.snapshot_only_carriers ?? []),
		]);
		for (const source of [...allowed]) {
			const clone = CLONE_MAP.map[source]?.target;
			if (clone !== undefined) allowed.add(clone);
		}
		const rows = (await sql.unsafe(
			`SELECT tipo, properties->'source'->'data_from_field' AS dff FROM dd_ontology
			 WHERE properties->'source' ? 'data_from_field' AND tipo NOT LIKE 'test999%'`,
			[],
		)) as { tipo: string; dff: unknown }[];
		expect(rows.length).toBeGreaterThanOrEqual(3); // drifted-empty census = vacuous
		expect(rows.filter((row) => !allowed.has(row.tipo)).map((row) => row.tipo)).toEqual([]);
		// Every declared peer must be component_relation_related: the model
		// gate (getStoredWithReferences MODEL DISPATCH) gives any other model
		// NO closure, so a non-related peer here means the seed law needs
		// re-verification before that ontology ships.
		for (const row of rows) {
			for (const peerTipo of Array.isArray(row.dff) ? row.dff : []) {
				const peer = await getNode(String(peerTipo));
				if (peer === null) continue; // tch40 absent from the suite DB
				expect(peer.model).toBe('component_relation_related');
			}
		}
	});

	test('every declared peer is dd621 MULTIDIRECTIONAL in the real ontology', async () => {
		const peers = [...new Set(DECLARED_USERS.flatMap((user) => [...user.dff]))];
		let present = 0;
		for (const peerTipo of peers) {
			const node = await getNode(peerTipo);
			if (node === null) continue; // tch40 absent from the suite DB
			present++;
			const typeRel = (node.properties as { config_relation?: { relation_type_rel?: string } })
				?.config_relation?.relation_type_rel;
			expect(typeRel).toBe('dd621');
		}
		// The GENERIC peers must all be present — that is the anti-vacuity floor,
		// and unlike the old `>= 2` it does not require an installation's ontology
		// to be in this database. (The `>= 2` reached its count only because the
		// suite DB happened to carry a vendored install ontology; the moment that
		// fixture went, so did the assertion — measured 2026-08-21.)
		const genericPeers = [...new Set(DECLARED_USERS_GENERIC.flatMap((user) => [...user.dff]))];
		for (const peerTipo of genericPeers) {
			expect(await getNode(peerTipo), `${peerTipo} must be declared`).not.toBeNull();
		}
		expect(present).toBeGreaterThanOrEqual(genericPeers.length);
	});
});

// ---------------------------------------------------------------------------
// Hermetic seed law — in-memory graph, no DB.
//
// Graph (per target section S): 900 = target; stored: 900→[901], 901→[903],
// 902→[900], 904→[902]; inverse is the exact mirror: 900←[902], 901←[900],
// 902←[904], 903←[901]. So 901 = a DIRECT equivalent (stored), 902 = an
// INVERSE equivalent (points at the target), 903 = a TRANSITIVE equivalent
// through STORED links (901→903, stored-recursion only), and 904 = a
// TRANSITIVE equivalent through INVERSE links (904→902→900: only the c=a
// "references to references" loop reaches it — review 2026-08-02: without
// 904 the walk minus its c=a loop produced the SAME seed, leaving PHP's
// second recursion unguarded; a real stored-forward chain C→B→A walked from
// A needs exactly that loop).
// ---------------------------------------------------------------------------
function fakeGraph(sectionTipo: string, peerTipo: string): RelatedGraphIO {
	const stored: Record<number, number[]> = {
		900: [901],
		901: [903],
		902: [900],
		903: [],
		904: [902],
	};
	const inverse: Record<number, number[]> = {
		900: [902],
		901: [900],
		902: [904],
		903: [901],
		904: [],
	};
	const asRef = (id: number): RelatedReference => ({
		section_tipo: sectionTipo,
		section_id: String(id),
		from_component_tipo: peerTipo,
	});
	return {
		getInverse: (_tipo, _sectionTipo, sectionId) =>
			Promise.resolve((inverse[Number(sectionId)] ?? []).map(asRef)),
		readStored: (_tipo, _sectionTipo, sectionId) =>
			Promise.resolve((stored[Number(sectionId)] ?? []).map(asRef)),
	};
}

function seedIO(
	sectionTipo: string,
	peerTipo: string,
	typeRel: string,
	// PHP dispatch is polymorphic: the closure exists ONLY on the
	// component_relation_related override — the model gate test flips this.
	model = 'component_relation_related',
): Parameters<typeof collectExternalSeed>[4] {
	return {
		getNodeProperties: () => Promise.resolve({ config_relation: { relation_type_rel: typeRel } }),
		getNodeModel: () => Promise.resolve(model),
		graph: fakeGraph(sectionTipo, peerTipo),
	};
}

describe('D3 seed law (hermetic, table-driven over the declared users)', () => {
	for (const user of DECLARED_USERS) {
		test(`${user.tipo}: exact seed = target ∪ dd621 closure of ${user.dff[0]}, ALL re-stamped ${user.cts}`, async () => {
			const targetSection = 'secX';
			const seed = await collectExternalSeed(
				{ data_from_field: [...user.dff] },
				user.cts,
				targetSection,
				900,
				seedIO(targetSection, user.dff[0], 'dd621'),
			);
			// EXACT: target first, then the peer bag in walk order (stored 901,
			// inverse 902, stored-transitive 903, then inverse-transitive 904
			// found by the c=a loop expanding 902) — every entry carrying the
			// component_to_search re-stamp (PHP set_from_component_tipo), never
			// the peer's own from_component_tipo.
			expect(seed).toEqual([
				{ section_tipo: targetSection, section_id: 900, from_component_tipo: user.cts },
				{ section_tipo: targetSection, section_id: 901, from_component_tipo: user.cts },
				{ section_tipo: targetSection, section_id: 902, from_component_tipo: user.cts },
				{ section_tipo: targetSection, section_id: 903, from_component_tipo: user.cts },
				{ section_tipo: targetSection, section_id: 904, from_component_tipo: user.cts },
			]);
		});
	}

	test('flipping the peer dd621 → dd467 → dd620 SHRINKS the seed (the recursive half is load-bearing)', async () => {
		const source = { data_from_field: ['peerX'] };
		const byTypeRel = async (typeRel: string): Promise<number[]> =>
			(
				await collectExternalSeed(source, 'ctsX', 'secX', 900, seedIO('secX', 'peerX', typeRel))
			).map((entry) => entry.section_id);
		// dd621 MULTIDIRECTIONAL: full closure — the transitive 903 is reachable
		// ONLY through the stored recursion and 904 ONLY through the c=a
		// inverse recursion. Dropping either recursion (one-hop implementation,
		// the 247,933-locator mistake) makes THIS line red.
		expect(await byTypeRel('dd621')).toEqual([900, 901, 902, 903, 904]);
		// dd467 BIDIRECTIONAL: stored bag + ONE inverse hop — no transitive
		// 903/904.
		expect(await byTypeRel('dd467')).toEqual([900, 901, 902]);
		// dd620 UNIDIRECTIONAL: stored bag only (PHP get_calculated_references
		// contributes NOTHING).
		expect(await byTypeRel('dd620')).toEqual([900, 901]);
	});

	test('a NON-related peer model gets NO closure even with dd621 config (PHP base-class dispatch)', async () => {
		// PHP get_dato_with_references is polymorphic: only
		// component_relation_related overrides it; every other model inherits
		// the base = get_dato() alone, relation_type_rel ignored (v6
		// class.component_relation_common.php:696-702).
		const seed = await collectExternalSeed(
			{ data_from_field: ['peerX'] },
			'ctsX',
			'secX',
			900,
			seedIO('secX', 'peerX', 'dd621', 'component_autocomplete'),
		);
		expect(seed.map((entry) => entry.section_id)).toEqual([900, 901]);
	});

	test('dd490 dataframe entries in a peer bag NEVER reach the seed (frames are pairing records)', async () => {
		// v7 storage keeps dd490 frames INSIDE the main component's bag; PHP
		// get_dato never returned them. An unfiltered frame target would be
		// seeded as an "equivalent" and its referencers APPENDED to the mirror
		// (additions always persist — review 2026-08-02).
		const base = fakeGraph('secX', 'peerX');
		const withFrame: RelatedGraphIO = {
			getInverse: base.getInverse,
			readStored: async (tipo, sectionTipo, sectionId) => {
				const stored = await base.readStored(tipo, sectionTipo, sectionId);
				// Frame at the ROOT bag exercises getStoredWithReferences' stored
				// half; frame at 901 (a RECURSIVE frame, whose stored elements ARE
				// pushed) exercises the traversal's stored-walk filter — without it
				// frameSec/77 leaks into the references half.
				return Number(sectionId) === 900 || Number(sectionId) === 901
					? [...stored, { type: 'dd490', section_tipo: 'frameSec', section_id: '77' }]
					: stored;
			},
		};
		const seed = await collectExternalSeed({ data_from_field: ['peerX'] }, 'ctsX', 'secX', 900, {
			getNodeProperties: () => Promise.resolve({ config_relation: { relation_type_rel: 'dd621' } }),
			getNodeModel: () => Promise.resolve('component_relation_related'),
			graph: withFrame,
		});
		expect(seed.some((entry) => entry.section_tipo === 'frameSec')).toBe(false);
		expect(seed.map((entry) => entry.section_id)).toEqual([900, 901, 902, 903, 904]);
	});

	test('a data_from_field peer with NO ontology node degrades to the stored bag LOUDLY (counter)', async () => {
		const before = getCounters().observers_seed_peer_node_missing ?? 0;
		const seed = await collectExternalSeed({ data_from_field: ['peerX'] }, 'ctsX', 'secX', 900, {
			// missing node = null properties AND null model
			getNodeProperties: () => Promise.resolve(null),
			getNodeModel: () => Promise.resolve(null),
			graph: fakeGraph('secX', 'peerX'),
		});
		// stored bag still contributes (best computable law) — but counted.
		expect(seed.map((entry) => entry.section_id)).toEqual([900, 901]);
		expect((getCounters().observers_seed_peer_node_missing ?? 0) - before).toBe(1);
	});

	test('the traversal is LINEAR in queries on chain graphs (expansion memo — no quadratic re-walk)', async () => {
		// Chain 0→1→…→n (stored), inverse mirrored. PHP's unmemoized walk fires
		// ~O(n²) queries (measured: n=50 → 2,548; n=100 → 10,098) INSIDE the
		// kernel's FOR UPDATE lock; the expansion memo makes it ~2/node. The
		// bound asserts linearity with slack — a quadratic regression blows
		// past it by an order of magnitude.
		const n = 60;
		let calls = 0;
		const chain: RelatedGraphIO = {
			getInverse: (_tipo, sectionTipo, sectionId) => {
				calls++;
				const id = Number(sectionId);
				return Promise.resolve(
					id > 0
						? [
								{
									section_tipo: sectionTipo,
									section_id: String(id - 1),
									from_component_tipo: 'peerX',
								},
							]
						: [],
				);
			},
			readStored: (_tipo, sectionTipo, sectionId) => {
				calls++;
				const id = Number(sectionId);
				return Promise.resolve(
					id < n
						? [
								{
									section_tipo: sectionTipo,
									section_id: String(id + 1),
									from_component_tipo: 'peerX',
								},
							]
						: [],
				);
			},
		};
		const { getStoredWithReferences } = await import('../../src/core/relations/related.ts');
		const bag = await getStoredWithReferences(
			'peerX',
			'secX',
			0,
			{ config_relation: { relation_type_rel: 'dd621' } },
			'component_relation_related',
			'lg-nolan',
			chain,
		);
		// the whole chain is reachable (0's stored 1, then 2..n transitively)
		expect(new Set(bag.map((entry) => entry.section_id)).size).toBe(n);
		expect(calls).toBeLessThanOrEqual(3 * (n + 1)); // linear; quadratic ≈ 3,700
	});

	test('no data_from_field → the seed is exactly the single target locator (pre-D3 shape)', async () => {
		const seed = await collectExternalSeed({}, INDEXER, TERM_SECTION, 58);
		expect(seed).toEqual([
			{ section_tipo: TERM_SECTION, section_id: 58, from_component_tipo: INDEXER },
		]);
	});

	test('buildExternalSeed: malformed peers dropped+counted, duplicates collapsed, target always first', () => {
		const before = getCounters().observers_seed_malformed_peer_locator ?? 0;
		const seed = buildExternalSeed({ section_tipo: 'secX', section_id: 1 }, 'ctsX', [
			{ section_tipo: 'secX', section_id: '2' }, // ok (string id, PHP shape)
			{ section_tipo: 'secX', section_id: 1 }, // duplicate of the target
			{ section_id: 3 }, // malformed: no section_tipo
			{ section_tipo: 'secX', section_id: 'NaN?' }, // malformed: unusable id
			{ section_tipo: 'secX', section_id: '2' }, // duplicate peer
			{ section_tipo: 'secY', section_id: 2, from_component_tipo: 'peer-own-stamp' }, // re-stamped
		]);
		expect(seed).toEqual([
			{ section_tipo: 'secX', section_id: 1, from_component_tipo: 'ctsX' },
			{ section_tipo: 'secX', section_id: 2, from_component_tipo: 'ctsX' },
			{ section_tipo: 'secY', section_id: 2, from_component_tipo: 'ctsX' },
		]);
		expect((getCounters().observers_seed_malformed_peer_locator ?? 0) - before).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// Static pins — the kernel cannot silently revert the D3 search shape.
// ---------------------------------------------------------------------------
describe('D3 kernel wiring (static pins)', () => {
	test('the recompute searches the collectExternalSeed result, never a hand-built single locator', () => {
		// The call is multiline since the defect sink landed (2026-08-06), so pin
		// the arguments individually rather than one brittle source substring.
		// Since the law registry (2026-10-30) the source is the classified law's
		// data_from_field, never the raw node (a refused law never reaches here).
		const call = lawCSource.slice(lawCSource.indexOf('const seed = await collectExternalSeed('));
		expect(call.startsWith('const seed = await collectExternalSeed(')).toBe(true);
		for (const argument of [
			'{ data_from_field: law.dataFromField },',
			'law.componentToSearch,',
			'targetSection,',
			'targetId,',
		]) {
			expect(call.slice(0, 260)).toContain(argument);
		}
		// The per-call defect sink MUST be threaded through: without it the
		// degraded-seed shrink refusal can never fire and a partially-installed
		// ontology turns every save into a mass delete.
		expect(call.slice(0, 260)).toContain('defects,');
		expect(lawCSource).toContain('findInverseReferences(seed');
	});

	test('the write-path search is uncapped (limit: false) with the pure-SQL PHP order', () => {
		const search = lawCSource.slice(lawCSource.indexOf('findInverseReferences(seed'));
		expect(search.slice(0, 200)).toContain('limit: false,');
		expect(search.slice(0, 200)).toContain("order: 'section_tipo_section_id',");
		expect(kernelSource).toContain("incrementCounter('observers_references_limit_refused')");
		expect(kernelSource).toContain("incrementCounter('observers_big_result_refused')");
	});
});

// ---------------------------------------------------------------------------
// references_limit refusal — pure options guard, fires before any DB access.
// ---------------------------------------------------------------------------
describe('references_limit is never honoured (WC-2026-08-02-observer-references-limit-not-honoured)', () => {
	test('a finite referencesLimit is refused outright as possiblyTruncated + counter', async () => {
		const before = getCounters().observers_references_limit_refused ?? 0;
		const outcome = await recomputeExternalRelation(
			'zzz-never-resolved',
			'zzz-none',
			1,
			-1,
			new Date(),
			{ referencesLimit: 200 },
		);
		expect(outcome).toEqual({ changed: false, before: 0, after: 0, possiblyTruncated: true });
		expect((getCounters().observers_references_limit_refused ?? 0) - before).toBe(1);
	});

	test('referencesLimit: 0 is the PHP UNCAPPED sentinel — passes the guard, never refused', async () => {
		// PHP `$sqo->set_limit(0)` = ALL (v6 :2040); most shipped observe
		// configs declare 0. A faithful params port passing 0 must fall
		// through, not dead-stop every recompute (review 2026-08-02). The
		// unresolved observer then hits the counted component_to_search skip —
		// proving the guard was crossed without any truncation refusal.
		const before = getCounters().observers_references_limit_refused ?? 0;
		const outcome = await recomputeExternalRelation(
			'zzz-never-resolved',
			'zzz-none',
			1,
			-1,
			new Date(),
			{ write: false, referencesLimit: 0 },
		);
		expect(outcome).toEqual({ changed: false, before: 0, after: 0 });
		expect((getCounters().observers_references_limit_refused ?? 0) - before).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Append-id law — one malformed legacy id must not NaN-poison the appends.
// ---------------------------------------------------------------------------
describe('nextObserverItemId (pure)', () => {
	test('non-finite ids are ignored for the max; appends stay finite and monotonic', () => {
		expect(nextObserverItemId([])).toBe(1);
		expect(nextObserverItemId([{ id: 4 }, { id: 2 }])).toBe(5);
		// the poison case: Number('x') = NaN — the old reduce made EVERY
		// appended id NaN → serialized null → duplicate item ids in one bag
		expect(nextObserverItemId([{ id: 'x' }, { id: 2 }])).toBe(3);
		expect(nextObserverItemId([{ id: 'x' }])).toBe(1);
		expect(nextObserverItemId([{}, { id: '7' }])).toBe(8);
	});
});

// ---------------------------------------------------------------------------
// Behavioral (suite DB, scratch): end-to-end dd621 chain + the >2000 freeze.
// ---------------------------------------------------------------------------
const OBSERVER_TIPO = 'test99910'; // scratch D3 observer (test999xx band)
const PEER_TIPO = 'test99911'; // scratch dd621 relation_related peer
const EQUIV_IDS = [59, 60]; // extra term records: 58 ≡ 59 ≡ 60 (chain via stored links)
const REF_DIRECT = 91080; // referencer → term 58 (direct)
const REF_EQUIV = 91081; // referencer → term 59 (one stored hop)
const REF_TRANSITIVE = 91082; // referencer → term 60 (two hops — recursion only)
const FREEZE_BAND_START = 8400001; // 2001 referencers for the freeze test
const FREEZE_BAND_END = 8402001;

/** Resolved once the fixture exists — the scratch sections own their tables. */
let TERM_TABLE = 'matrix_test';
let REF_TABLE = 'matrix_test';

async function clearResolverCaches(): Promise<void> {
	const { clearOntologyDerivedCaches } = await import(
		'../../src/core/ontology/cache_invalidation.ts'
	);
	await clearOntologyDerivedCaches();
}

async function sweepScratch(): Promise<void> {
	await sql.unsafe(`DELETE FROM dd_ontology WHERE tipo IN ($1, $2) AND tld = 'test'`, [
		OBSERVER_TIPO,
		PEER_TIPO,
	]);
	await sql.unsafe(
		`DELETE FROM "${REF_TABLE}" WHERE section_tipo = $6
		 AND (section_id IN ($1, $2, $3) OR (section_id >= $4 AND section_id <= $5))`,
		[REF_DIRECT, REF_EQUIV, REF_TRANSITIVE, FREEZE_BAND_START, FREEZE_BAND_END, REF_SECTION],
	);
	await sql.unsafe(
		`DELETE FROM "${TERM_TABLE}" WHERE section_tipo = $1 AND section_id IN ($2, $3)`,
		[SEED_TERM.section_tipo, EQUIV_IDS[0], EQUIV_IDS[1]],
	);
	await sql.unsafe('DELETE FROM matrix_time_machine WHERE tipo IN ($1, $2)', [
		OBSERVER_TIPO,
		PEER_TIPO,
	]);
}

/** A referencer row: one INDEXER locator pointing at a term. */
function indexerReferencer(targetId: number): string {
	return JSON.stringify({
		[INDEXER]: [
			{
				id: 1,
				type: 'dd96',
				section_id: String(targetId),
				section_tipo: SEED_TERM.section_tipo,
				from_component_tipo: INDEXER,
			},
		],
	});
}

/**
 * The exact D3 mirror entry shape the law appends.
 * WC-2026-08-10-section-id-int-canonical: int referencer address.
 */
function mirrorEntry(itemId: number, referencerId: number): Record<string, unknown> {
	return {
		id: itemId,
		type: 'dd151',
		section_id: referencerId,
		section_tipo: REF_SECTION,
		from_component_tipo: OBSERVER_TIPO,
	};
}

beforeAll(async () => {
	// The anchor is BUILT (test/helpers/observer_term_seed.ts), so the old
	// "pre-exists ⇒ skip the behavioural tier" guard is gone with the install
	// binding it protected: there is no real record here to touch.
	await ensureObserverTerm();
	TERM_TABLE = (await getMatrixTableFromTipo(TERM_SECTION)) ?? 'matrix_test';
	REF_TABLE = (await getMatrixTableFromTipo(REF_SECTION)) ?? 'matrix_test';
	await sweepScratch();
	// Scratch ontology: the D3 observer (component_to_search rsc387 within
	// rsc205, equivalents through PEER_TIPO) + the dd621 peer node. Both are
	// declared BY THE TERM SECTION whose records store them: the mirror's HOST
	// PRECONDITION (observer ∈ declaredSectionComponents of the target section
	// — external_laws/resolvers.ts isObserverHostSection) refuses a mirror born
	// on a section that does not declare its observer. Swept by tipo before
	// dropObserverTerm counts the situation's residue.
	await sql.unsafe(
		`INSERT INTO dd_ontology (id, tipo, parent, model, tld, properties)
		 VALUES ((SELECT COALESCE(MAX(id), 0) + 1300 FROM dd_ontology), $1, $3, 'component_portal', 'test', $2::text::jsonb)`,
		[
			OBSERVER_TIPO,
			JSON.stringify({
				source: {
					mode: 'external',
					section_to_search: [REF_SECTION],
					component_to_search: [INDEXER],
					data_from_field: [PEER_TIPO],
				},
			}),
			TERM_SECTION,
		],
	);
	await sql.unsafe(
		`INSERT INTO dd_ontology (id, tipo, parent, model, tld, properties)
		 VALUES ((SELECT COALESCE(MAX(id), 0) + 1300 FROM dd_ontology), $1, $3, 'component_relation_related', 'test', $2::text::jsonb)`,
		[PEER_TIPO, JSON.stringify({ config_relation: { relation_type_rel: 'dd621' } }), TERM_SECTION],
	);
	await clearResolverCaches();
	// The dd621 equivalence chain: 58 —stored→ 59 —stored→ 60 (each hop only
	// discoverable from the previous node: 60 requires the RECURSIVE walk).
	await sql.unsafe(
		`UPDATE "${TERM_TABLE}" SET relation = relation || $3::text::jsonb
		 WHERE section_tipo = $1 AND section_id = $2`,
		[
			SEED_TERM.section_tipo,
			SEED_TERM.section_id,
			JSON.stringify({
				[PEER_TIPO]: [
					{
						type: 'dd151',
						section_id: String(EQUIV_IDS[0]),
						section_tipo: SEED_TERM.section_tipo,
						from_component_tipo: PEER_TIPO,
					},
				],
			}),
		],
	);
	for (const [index, id] of EQUIV_IDS.entries()) {
		const next = EQUIV_IDS[index + 1];
		const relation =
			next === undefined
				? {}
				: {
						[PEER_TIPO]: [
							{
								type: 'dd151',
								section_id: String(next),
								section_tipo: SEED_TERM.section_tipo,
								from_component_tipo: PEER_TIPO,
							},
						],
					};
		await sql.unsafe(
			`INSERT INTO "${TERM_TABLE}" (section_id, section_tipo, relation) VALUES ($1, $2, $3::text::jsonb)`,
			[id, SEED_TERM.section_tipo, JSON.stringify(relation)],
		);
	}
	// Referencers: one per chain node (bypass inserts — index-trigger truth).
	for (const [refId, targetId] of [
		[REF_DIRECT, SEED_TERM.section_id],
		[REF_EQUIV, EQUIV_IDS[0]],
		[REF_TRANSITIVE, EQUIV_IDS[1]],
	] as const) {
		await sql.unsafe(
			`INSERT INTO "${REF_TABLE}" (section_id, section_tipo, relation) VALUES ($1, $3, $2::text::jsonb)`,
			[refId, indexerReferencer(targetId as number), REF_SECTION],
		);
	}
});

afterAll(async () => {
	await sweepScratch();
	// Residue asserted, not trusted.
	expect(await dropObserverTerm()).toBe(0);
	await clearResolverCaches();
});

describe('D3 end-to-end (suite DB scratch): equivalents contribute their referencers', () => {
	test('recompute @ the anchor mirrors referencers of 58 AND of its dd621 equivalents 59/60', async () => {
		// Dry run first: the full law sees all three referencers.
		const diff = await recomputeExternalRelation(
			OBSERVER_TIPO,
			SEED_TERM.section_tipo,
			SEED_TERM.section_id,
			-1,
			new Date(),
			{ write: false },
		);
		expect(diff.changed).toBe(true);
		expect(diff.before).toBe(0);
		expect(diff.after).toBe(3); // NOT 1 — the pre-D3 self-only seed found only REF_DIRECT
		// Apply: grow-only path (no shrink involved), exact byte shape + order
		// (PHP related-search order: section_tipo, section_id ASC → ids
		// ascending within rsc205).
		const outcome = await recomputeExternalRelation(
			OBSERVER_TIPO,
			SEED_TERM.section_tipo,
			SEED_TERM.section_id,
			-1,
			new Date(),
			{},
		);
		expect(outcome.changed).toBe(true);
		expect(outcome.after).toBe(3);
		const rows = (await sql.unsafe(
			`SELECT relation->($3::text) AS bag FROM "${TERM_TABLE}" WHERE section_tipo = $1 AND section_id = $2`,
			[SEED_TERM.section_tipo, SEED_TERM.section_id, OBSERVER_TIPO],
		)) as { bag: unknown[] | null }[];
		expect(rows[0]?.bag).toEqual([
			mirrorEntry(1, REF_DIRECT),
			mirrorEntry(2, REF_EQUIV),
			mirrorEntry(3, REF_TRANSITIVE),
		]);
	}, 30000);
});

describe('the >2000-reference freeze refuses the persist (PHP :2087 parity)', () => {
	test('2001 referencers: computed, counted, NOT written — dry run flags it too', async () => {
		// 2001 bypass referencers of the term's PARENT (clear of the D3 chain
		// assertions above; MIRROR has no data_from_field so the seed is the
		// single target).
		const targetId = 8;
		await sql.unsafe(
			`INSERT INTO "${REF_TABLE}" (section_id, section_tipo, relation)
			 SELECT gs, $4, $1::text::jsonb FROM generate_series($2::int, $3::int) gs`,
			[indexerReferencer(targetId), FREEZE_BAND_START, FREEZE_BAND_END, REF_SECTION],
		);
		const counterBefore = getCounters().observers_big_result_refused ?? 0;
		const outcome = await recomputeExternalRelation(
			MIRROR,
			SEED_TERM.section_tipo,
			targetId,
			-1,
			new Date(),
			{},
		);
		expect(outcome.changed).toBe(true);
		expect(outcome.refusedBigResult).toBe(true);
		expect(outcome.before).toBe(0);
		expect(outcome.after).toBe(2001);
		expect((getCounters().observers_big_result_refused ?? 0) - counterBefore).toBe(1);
		// NOTHING persisted: no mirror bag, no TM audit rows.
		const bag = (await sql.unsafe(
			`SELECT (relation ? $3) AS has_mirror FROM "${TERM_TABLE}"
			 WHERE section_tipo = $1 AND section_id = $2`,
			[SEED_TERM.section_tipo, targetId, MIRROR],
		)) as { has_mirror: boolean }[];
		expect(bag[0]?.has_mirror).toBe(false);
		const tm = (await sql.unsafe(
			`SELECT 1 FROM matrix_time_machine
			 WHERE section_tipo = $1 AND section_id = $2 AND tipo = ($3::text) LIMIT 1`,
			[SEED_TERM.section_tipo, targetId, MIRROR],
		)) as unknown[];
		expect(tm.length).toBe(0);
		// Dry run reports the same refusal (an apply would refuse).
		const dry = await recomputeExternalRelation(
			MIRROR,
			SEED_TERM.section_tipo,
			targetId,
			-1,
			new Date(),
			{ write: false },
		);
		expect(dry.refusedBigResult).toBe(true);
	}, 60000);
});
