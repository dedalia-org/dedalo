/**
 * CLUSTERING (`src/ai/identify/cluster.ts`) — "these thirty are all the same
 * thing", asserted as pure logic over an injected similarity matrix.
 *
 * A curator accepting a cluster commits thirty records in one action, so the
 * rules that decide WHO IS IN IT are the load-bearing part, and every one of
 * them is checkable without a corpus:
 *
 *  1. THE GROUPING. Threshold-based connected components: transitivity at the
 *     threshold boundary (the case single linkage is famous for), the chaining
 *     it produces reported rather than hidden, and singletons that stay
 *     singletons.
 *  2. THE BOUND. The cap truncates and SAYS SO — a clustering answer computed
 *     over the first N of a much larger set is a different claim about the
 *     collection, and the difference must not be invisible.
 *  3. THE GATE, from both directions. A record the caller cannot read must
 *     neither APPEAR in a cluster nor INFLUENCE one — the second half matters as
 *     much as the first, because a hidden record bridging two groups would
 *     silently merge them.
 *  4. WHICH SIGNAL RAN. A record with no indexed image still clusters, on
 *     criteria alone, and the group says so.
 *
 * Plus the background wiring: the action is on the second allowlist and reaches
 * the executor. Nothing here touches the database or writes anything anywhere.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	buildClusterGroups,
	type CandidateRecord,
	type ClusterLink,
	type ClusterPorts,
	type ClusterSignal,
	clusterRecords,
	type NeighbourHit,
} from '../../src/ai/identify/cluster.ts';
import type { AccessFilter } from '../../src/core/identify/match.ts';
import { parseProfile } from '../../src/core/identify/profile.ts';
import type { CriterionValue, IdentificationProfile } from '../../src/core/identify/types.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import { markProcessesDir } from '../helpers/test_media_root.ts';

const ADMIN: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: false };

const rec = (sectionId: number): CandidateRecord => ({ sectionTipo: 'test3', sectionId });
const ids = (records: readonly CandidateRecord[]): number[] =>
	records.map((record) => record.sectionId).sort((a, b) => a - b);

/** A fixed similarity matrix, keyed "a-b" with a < b. */
type Matrix = Record<string, number>;

function neighboursFrom(matrix: Matrix, seed: CandidateRecord): NeighbourHit[] {
	const hits: NeighbourHit[] = [];
	for (const [pair, similarity] of Object.entries(matrix)) {
		const [left, right] = pair.split('-').map(Number) as [number, number];
		const other = left === seed.sectionId ? right : right === seed.sectionId ? left : null;
		if (other === null) continue;
		hits.push({ record: rec(other), similarity, detail: `fixture similarity ${similarity}` });
	}
	return hits;
}

/** Ports serving one matrix through one leg; the other leg reports nothing. */
function portsFor(matrix: Matrix, signal: ClusterSignal = 'image'): Partial<ClusterPorts> {
	return {
		hasImageIndex: async () => signal === 'image',
		imageNeighbours: async ({ seed, minSimilarity }) =>
			signal === 'image'
				? neighboursFrom(matrix, seed).filter((hit) => hit.similarity >= minSimilarity)
				: [],
		criteriaNeighbours: async ({ seed }) =>
			signal === 'criteria' ? neighboursFrom(matrix, seed) : [],
	};
}

const allowAll: AccessFilter = async (_principal, records) => [...records];
const denyNone = allowAll;

function link(
	a: number,
	b: number,
	similarity: number,
	signal: ClusterSignal = 'image',
): ClusterLink {
	return { a: rec(a), b: rec(b), similarity, signal, detail: 'fixture' };
}

/** A minimal, DB-free profile: one identifying criterion, sameType at 0.85. */
function profileWith(overrides: Record<string, unknown> = {}): IdentificationProfile {
	return parseProfile({
		id: 'p',
		label: 'P',
		sectionTipos: ['test3'],
		thresholds: { sameType: 0.85, candidate: 0.5 },
		criteria: [
			{
				id: 'deity',
				label: 'Deity',
				path: [{ section_tipo: 'test3', component_tipo: 'deity' }],
				role: 'identifying',
				weight: 1,
				mode: 'same_locator',
			},
		],
		...overrides,
	});
}

const noProfile = async () => null;

/* ───────────────────────── 1. the grouping, pure ─────────────────────────── */

describe('buildClusterGroups — connected components over a fixed matrix', () => {
	test('groups records joined directly, and leaves the rest alone', () => {
		const { clusters, singletons } = buildClusterGroups(
			[rec(1), rec(2), rec(3), rec(4)],
			[link(1, 2, 0.96), link(3, 4, 0.94)],
		);
		expect(clusters.length).toBe(2);
		expect(clusters.map((cluster) => ids(cluster.members))).toEqual([
			[1, 2],
			[3, 4],
		]);
		expect(singletons).toEqual([]);
	});

	test('TRANSITIVITY: A~B and B~C put A and C in one cluster, and the chain is reported', () => {
		const { clusters } = buildClusterGroups(
			[rec(1), rec(2), rec(3)],
			// 1 and 3 are NOT linked; only the chain through 2 holds the group.
			[link(1, 2, 0.95), link(2, 3, 0.93)],
		);
		expect(clusters.length).toBe(1);
		const cluster = clusters[0];
		expect(ids(cluster?.members ?? [])).toEqual([1, 2, 3]);
		// The honest cost of single linkage, measured rather than hidden:
		expect(cluster?.maxChainHops).toBe(2); // 1 → 2 → 3
		expect(cluster?.directEdgeRatio).toBe(0.667); // 2 of the 3 possible pairs
		// …and the representative is the member that actually holds it together.
		expect(cluster?.representative.sectionId).toBe(2);
		expect(cluster?.representativeReason).toContain('linked to 2 of the other 2');
	});

	test('a fully-linked group reports no chaining at all', () => {
		const { clusters } = buildClusterGroups(
			[rec(1), rec(2), rec(3)],
			[link(1, 2, 0.95), link(2, 3, 0.95), link(1, 3, 0.95)],
		);
		expect(clusters[0]?.maxChainHops).toBe(1);
		expect(clusters[0]?.directEdgeRatio).toBe(1);
	});

	test('SINGLETONS: a record nothing links to is reported, never dropped', () => {
		const { clusters, singletons } = buildClusterGroups(
			[rec(1), rec(2), rec(9)],
			[link(1, 2, 0.99)],
		);
		expect(clusters.length).toBe(1);
		expect(ids(singletons)).toEqual([9]);
	});

	test('a group below minClusterSize becomes singletons, not a hidden cluster', () => {
		const { clusters, singletons } = buildClusterGroups(
			[rec(1), rec(2), rec(3), rec(4)],
			[link(1, 2, 0.99), link(2, 3, 0.99), link(4, 4, 1)],
			{ minClusterSize: 3 },
		);
		expect(clusters.length).toBe(1);
		expect(ids(clusters[0]?.members ?? [])).toEqual([1, 2, 3]);
		expect(ids(singletons)).toEqual([4]);
	});

	test('confidence and weakestLink are the plain statements they claim to be', () => {
		const { clusters } = buildClusterGroups(
			[rec(1), rec(2), rec(3)],
			[link(1, 2, 1), link(2, 3, 0.5)],
		);
		expect(clusters[0]?.confidence).toBe(0.75); // mean of the links
		expect(clusters[0]?.weakestLink).toBe(0.5); // the weakest one holding it
	});

	test('both legs linking one pair keep both explanations but count as ONE pair', () => {
		const { clusters } = buildClusterGroups(
			[rec(1), rec(2)],
			[link(1, 2, 0.95, 'image'), link(2, 1, 0.9, 'criteria')],
		);
		expect(clusters[0]?.links.length).toBe(2);
		expect(clusters[0]?.signals).toEqual(['criteria', 'image']);
		expect(clusters[0]?.directEdgeRatio).toBe(1); // one pair, not two
	});

	test('an edge to a record OUTSIDE the node set is discarded, not silently joined', () => {
		const { clusters, singletons } = buildClusterGroups(
			[rec(1), rec(3)],
			// 2 is not a node (the ACL removed it); it must not bridge 1 and 3.
			[link(1, 2, 0.99), link(2, 3, 0.99)],
		);
		expect(clusters).toEqual([]);
		expect(ids(singletons)).toEqual([1, 3]);
	});
});

/* ───────────────────── 2. thresholds, through clusterRecords ─────────────── */

describe('clusterRecords — the threshold is the boundary, and it is echoed', () => {
	const matrix: Matrix = { '1-2': 0.94, '2-3': 0.93, '1-3': 0.5 };

	test('at the threshold, transitivity produces ONE cluster of three', async () => {
		const report = await clusterRecords({
			sectionTipos: ['test3'],
			principal: ADMIN,
			records: [rec(1), rec(2), rec(3)],
			imageThreshold: 0.93,
			ports: portsFor(matrix),
			filterAccessible: allowAll,
			loadProfile: noProfile,
		});
		expect(report.clusters.length).toBe(1);
		expect(ids(report.clusters[0]?.members ?? [])).toEqual([1, 2, 3]);
		expect(report.thresholds.image).toBe(0.93);
		expect(report.signalsUsed).toEqual(['image']);
	});

	test('one notch above it, the weakest link drops out and 3 stands alone', async () => {
		const report = await clusterRecords({
			sectionTipos: ['test3'],
			principal: ADMIN,
			records: [rec(1), rec(2), rec(3)],
			imageThreshold: 0.94,
			ports: portsFor(matrix),
			filterAccessible: allowAll,
			loadProfile: noProfile,
		});
		expect(report.clusters.length).toBe(1);
		expect(ids(report.clusters[0]?.members ?? [])).toEqual([1, 2]);
		expect(ids(report.singletons)).toEqual([3]);
	});

	test('the run’s data lang reaches the criteria leg (review M2: the matcher read the install default)', async () => {
		const seen: (string | undefined)[] = [];
		await clusterRecords({
			sectionTipos: ['test3'],
			principal: ADMIN,
			records: [rec(1), rec(2)],
			lang: 'lg-cat',
			ports: {
				...portsFor({}, 'criteria'),
				criteriaNeighbours: async ({ lang }) => {
					seen.push(lang);
					return [];
				},
			},
			filterAccessible: allowAll,
			loadProfile: async () => profileWith(),
			readValues: async () => null,
			componentGrant: async () => 1,
		});
		// FLOOR: the leg ran once per record, each time in the run's lang.
		expect(seen).toEqual(['lg-cat', 'lg-cat']);
	});

	test('the criteria leg uses the PROFILE’s own sameType threshold', async () => {
		const report = await clusterRecords({
			sectionTipos: ['test3'],
			principal: ADMIN,
			records: [rec(1), rec(2), rec(3)],
			// 1-2 clears sameType (0.85); 2-3 does not.
			ports: portsFor({ '1-2': 0.9, '2-3': 0.6 }, 'criteria'),
			filterAccessible: allowAll,
			loadProfile: async () => profileWith(),
			readValues: async () => null,
			componentGrant: async () => 1,
		});
		expect(report.thresholds.criteria).toBe(0.85);
		// One section, one floor: the scalar and the per-section map say the same
		// thing, and the map is never empty when a criteria leg actually ran.
		expect(report.thresholds.criteriaBySection).toEqual({ test3: 0.85 });
		expect(ids(report.clusters[0]?.members ?? [])).toEqual([1, 2]);
		expect(report.clusters[0]?.signals).toEqual(['criteria']);
	});

	test('sections with DIFFERENT sameType are each held to their OWN floor, and each is echoed', async () => {
		// The discriminating fixture: BOTH pairs come back at exactly 0.90. test3
		// authors sameType 0.85 (so its pair links) and test4 authors 0.95 (so its
		// pair does not). One reported number cannot describe both outcomes — and a
		// report that echoed only the first section's 0.85 would state that the
		// test4 pair was compared against a floor it never saw.
		const other = (sectionId: number): CandidateRecord => ({ sectionTipo: 'test4', sectionId });
		const twinOf = (seed: CandidateRecord): CandidateRecord =>
			seed.sectionTipo === 'test3'
				? rec(seed.sectionId === 1 ? 2 : 1)
				: other(seed.sectionId === 3 ? 4 : 3);

		const report = await clusterRecords({
			sectionTipos: ['test3', 'test4'],
			principal: ADMIN,
			records: [rec(1), rec(2), other(3), other(4)],
			ports: {
				hasImageIndex: async () => false,
				imageNeighbours: async () => [],
				criteriaNeighbours: async ({ seed }) => [
					{ record: twinOf(seed), similarity: 0.9, detail: 'fixture similarity 0.9' },
				],
			},
			filterAccessible: allowAll,
			loadProfile: async (sectionTipo: string) =>
				profileWith(
					sectionTipo === 'test3'
						? { sectionTipos: ['test3'] }
						: { sectionTipos: ['test4'], thresholds: { sameType: 0.95, candidate: 0.5 } },
				),
			readValues: async () => null,
			componentGrant: async () => 1,
		});

		// Each section's own floor decided its own edges.
		expect(report.clusters.length).toBe(1);
		expect(report.clusters[0]?.members.map((member) => member.sectionTipo)).toEqual([
			'test3',
			'test3',
		]);
		expect(report.singletons.map((record) => record.sectionTipo)).toEqual(['test4', 'test4']);

		// …and BOTH floors are readable off the report.
		expect(report.thresholds.criteriaBySection).toEqual({ test3: 0.85, test4: 0.95 });
		// No single number is true here, so none is stated — and the run says why.
		expect(report.thresholds.criteria).toBeNull();
		expect(report.notes.join(' ')).toContain('different criteria thresholds');
		expect(report.notes.join(' ')).toContain("'test4': 0.95");
	});

	test('an explicit override replaces every section’s floor, so the scalar is honest again', async () => {
		const other = (sectionId: number): CandidateRecord => ({ sectionTipo: 'test4', sectionId });
		const report = await clusterRecords({
			sectionTipos: ['test3', 'test4'],
			principal: ADMIN,
			records: [rec(1), other(3)],
			criteriaThreshold: 0.7,
			ports: {
				hasImageIndex: async () => false,
				imageNeighbours: async () => [],
				criteriaNeighbours: async () => [],
			},
			filterAccessible: allowAll,
			loadProfile: async (sectionTipo: string) =>
				profileWith(
					sectionTipo === 'test3'
						? { sectionTipos: ['test3'] }
						: { sectionTipos: ['test4'], thresholds: { sameType: 0.95, candidate: 0.5 } },
				),
			readValues: async () => null,
			componentGrant: async () => 1,
		});
		expect(report.thresholds.criteria).toBe(0.7);
		expect(report.thresholds.criteriaBySection).toEqual({ test3: 0.7, test4: 0.7 });
		expect(report.notes.join(' ')).not.toContain('different criteria thresholds');
	});

	test('a record with no indexed image still clusters, on criteria alone', async () => {
		const report = await clusterRecords({
			sectionTipos: ['test3'],
			principal: ADMIN,
			records: [rec(1), rec(2)],
			ports: {
				// The section declares no image index at all: the image leg never runs.
				hasImageIndex: async () => false,
				imageNeighbours: async () => {
					throw new Error('the image leg must not run for an unindexed section');
				},
				criteriaNeighbours: async ({ seed }) => neighboursFrom({ '1-2': 0.99 }, seed),
			},
			filterAccessible: allowAll,
			loadProfile: async () => profileWith(),
			readValues: async () => null,
			componentGrant: async () => 1,
		});
		expect(report.signalsUsed).toEqual(['criteria']);
		expect(ids(report.clusters[0]?.members ?? [])).toEqual([1, 2]);
	});

	test('a section with no profile loses the criteria leg and SAYS so', async () => {
		const report = await clusterRecords({
			sectionTipos: ['test3'],
			principal: ADMIN,
			records: [rec(1), rec(2)],
			imageThreshold: 0.9,
			ports: portsFor({ '1-2': 0.95 }),
			filterAccessible: allowAll,
			loadProfile: noProfile,
		});
		expect(report.notes.join(' ')).toContain('declares no identification profile');
		expect(report.thresholds.criteria).toBeNull();
		expect(report.clusters.length).toBe(1);
	});

	test('a MALFORMED profile is a note carrying its message, not a destroyed run', async () => {
		const report = await clusterRecords({
			sectionTipos: ['test3'],
			principal: ADMIN,
			records: [rec(1), rec(2)],
			imageThreshold: 0.9,
			ports: portsFor({ '1-2': 0.95 }),
			filterAccessible: allowAll,
			loadProfile: async () => {
				throw new Error('identification profile: unknown key ‘weigth’');
			},
		});
		expect(report.notes.join(' ')).toContain('weigth');
		expect(report.clusters.length).toBe(1); // the image leg still answered
	});
});

/* ──────────────────────────── 3. the bound ──────────────────────────────── */

describe('clusterRecords — bounded, and honest about it', () => {
	test('an explicit record list is capped and the truncation is REPORTED', async () => {
		const report = await clusterRecords({
			sectionTipos: ['test3'],
			principal: ADMIN,
			records: [rec(1), rec(2), rec(3), rec(4), rec(5)],
			cap: 3,
			imageThreshold: 0.9,
			ports: portsFor({ '1-2': 0.95, '4-5': 0.99 }),
			filterAccessible: allowAll,
			loadProfile: noProfile,
		});
		expect(report.truncated).toBe(true);
		expect(report.cap).toBe(3);
		expect(report.recordsConsidered).toBe(3);
		// 4 and 5 were never considered, so their (strong) link is not in the answer.
		expect(report.clusters.flatMap((cluster) => ids(cluster.members))).toEqual([1, 2]);
		expect(ids(report.singletons)).toEqual([3]);
	});

	test('a pool that fits reports truncated:false', async () => {
		const report = await clusterRecords({
			sectionTipos: ['test3'],
			principal: ADMIN,
			records: [rec(1), rec(2)],
			cap: 10,
			imageThreshold: 0.9,
			ports: portsFor({ '1-2': 0.95 }),
			filterAccessible: allowAll,
			loadProfile: noProfile,
		});
		expect(report.truncated).toBe(false);
		expect(report.recordsConsidered).toBe(2);
	});

	test('the pool lister’s own truncation flag travels through', async () => {
		const report = await clusterRecords({
			sectionTipos: ['test3'],
			principal: ADMIN,
			cap: 2,
			imageThreshold: 0.9,
			listRecords: async ({ cap }) => {
				expect(cap).toBe(2);
				return { records: [rec(1), rec(2)], truncated: true };
			},
			ports: portsFor({ '1-2': 0.95 }),
			filterAccessible: allowAll,
			loadProfile: noProfile,
		});
		expect(report.truncated).toBe(true);
	});

	test('cancellation at a record boundary returns the PARTIAL answer, marked', async () => {
		const controller = new AbortController();
		let seen = 0;
		const report = await clusterRecords({
			sectionTipos: ['test3'],
			principal: ADMIN,
			records: [rec(1), rec(2), rec(3), rec(4)],
			imageThreshold: 0.9,
			ports: {
				hasImageIndex: async () => true,
				imageNeighbours: async ({ seed }) => {
					seen++;
					if (seen === 2) controller.abort();
					return neighboursFrom({ '1-2': 0.95, '3-4': 0.95 }, seed);
				},
				criteriaNeighbours: async () => [],
			},
			signal: controller.signal,
			filterAccessible: allowAll,
			loadProfile: noProfile,
		});
		expect(report.stopped).toBe(true);
		expect(seen).toBe(2); // stopped at the boundary, never mid-record
		expect(ids(report.clusters[0]?.members ?? [])).toEqual([1, 2]);
	});

	test('progress is published per record, with a total to divide by', async () => {
		const ticks: Array<{ phase: string; counter: number; total: number }> = [];
		await clusterRecords({
			sectionTipos: ['test3'],
			principal: ADMIN,
			records: [rec(1), rec(2)],
			imageThreshold: 0.9,
			ports: portsFor({ '1-2': 0.95 }),
			filterAccessible: allowAll,
			loadProfile: noProfile,
			onProgress: (progress) =>
				ticks.push({ phase: progress.phase, counter: progress.counter, total: progress.total }),
		});
		expect(ticks.some((tick) => tick.phase === 'neighbours' && tick.counter === 2)).toBe(true);
		expect(ticks.every((tick) => tick.total >= tick.counter)).toBe(true);
	});
});

/* ────────────────────────────── 4. the gate ─────────────────────────────── */

describe('clusterRecords — a denied record neither appears nor influences', () => {
	/** Record 2 is the only thing linking 1 and 3. */
	const bridge: Matrix = { '1-2': 0.99, '2-3': 0.99, '1-3': 0.1 };
	const denies = (hidden: number): AccessFilter => {
		return async (_principal, records) => records.filter((r) => r.sectionId !== hidden);
	};

	test('a hidden BRIDGE does not merge the two groups it touches', async () => {
		const report = await clusterRecords({
			sectionTipos: ['test3'],
			principal: ADMIN,
			records: [rec(1), rec(2), rec(3)],
			imageThreshold: 0.9,
			ports: portsFor(bridge),
			filterAccessible: denies(2),
			loadProfile: noProfile,
		});
		expect(report.clusters).toEqual([]);
		expect(ids(report.singletons)).toEqual([1, 3]);
		expect(report.recordsConsidered).toBe(2);
	});

	test('a hidden record appears in no member list, no link and no singleton list', async () => {
		const report = await clusterRecords({
			sectionTipos: ['test3'],
			principal: ADMIN,
			records: [rec(1), rec(2), rec(3)],
			imageThreshold: 0.9,
			// Everything is similar to everything, so only the gate can exclude 2.
			ports: portsFor({ '1-2': 0.99, '2-3': 0.99, '1-3': 0.99 }),
			filterAccessible: denies(2),
			loadProfile: noProfile,
		});
		const serialized = JSON.stringify(report);
		expect(ids(report.clusters[0]?.members ?? [])).toEqual([1, 3]);
		expect(report.singletons).toEqual([]);
		expect(serialized).not.toContain('"sectionId":2');
	});

	test('its VALUES are never read, so they can never be quoted', async () => {
		const read: number[] = [];
		await clusterRecords({
			sectionTipos: ['test3'],
			principal: ADMIN,
			records: [rec(1), rec(2), rec(3)],
			ports: portsFor({ '1-2': 0.99, '2-3': 0.99, '1-3': 0.99 }, 'criteria'),
			filterAccessible: denies(2),
			loadProfile: async () => profileWith(),
			componentGrant: async () => 1,
			readValues: async (record) => {
				read.push(record.sectionId);
				return { kind: 'text', values: ['Athena'] } satisfies CriterionValue;
			},
		});
		expect(read.length).toBeGreaterThan(0);
		expect(read).not.toContain(2);
	});
});

/* ─────────────────────── 5. what the members agree on ───────────────────── */

describe('clusterRecords — the consensus a curator reads', () => {
	const corpus =
		(values: Record<number, CriterionValue | null>) =>
		async (record: CandidateRecord): Promise<CriterionValue | null> =>
			values[record.sectionId] ?? null;

	const clusterOf = async (
		values: Record<number, CriterionValue | null>,
		grant: () => Promise<number> = async () => 1,
	) =>
		await clusterRecords({
			sectionTipos: ['test3'],
			principal: ADMIN,
			records: [rec(1), rec(2), rec(3)],
			imageThreshold: 0.9,
			ports: portsFor({ '1-2': 0.99, '2-3': 0.99, '1-3': 0.99 }),
			filterAccessible: denyNone,
			loadProfile: async () => profileWith(),
			componentGrant: grant,
			readValues: corpus(values),
		});

	const athena: CriterionValue = { kind: 'text', values: ['Athena'] };

	test('all members stating the same value reads as agreed, and names it', async () => {
		const report = await clusterOf({ 1: athena, 2: athena, 3: athena });
		const consensus = report.clusters[0]?.consensus[0];
		expect(consensus?.state).toBe('agreed');
		expect(consensus?.value).toBe('Athena');
		expect(consensus?.stated).toBe(3);
		expect(report.clusters[0]?.agreedOn).toEqual(['Deity']);
	});

	test('ABSENCE is not disagreement: a value only some members state is partial', async () => {
		const report = await clusterOf({ 1: athena, 2: null, 3: athena });
		const consensus = report.clusters[0]?.consensus[0];
		expect(consensus?.state).toBe('partial');
		expect(consensus?.stated).toBe(2);
		expect(report.clusters[0]?.agreedOn).toEqual([]);
	});

	test('a member stating something else reads as differs, and quotes nothing', async () => {
		const report = await clusterOf({
			1: athena,
			2: { kind: 'text', values: ['Hermes'] },
			3: athena,
		});
		const consensus = report.clusters[0]?.consensus[0];
		expect(consensus?.state).toBe('differs');
		expect(consensus?.value).toBe('');
	});

	test('nobody stating it reads as unrecorded, never as a spurious consensus', async () => {
		const report = await clusterOf({});
		expect(report.clusters[0]?.consensus[0]?.state).toBe('unrecorded');
		expect(report.clusters[0]?.agreedOn).toEqual([]);
	});

	test('a component the caller may not read is not compared and not quoted', async () => {
		const report = await clusterOf({ 1: athena, 2: athena, 3: athena }, async () => 0);
		const consensus = report.clusters[0]?.consensus[0];
		expect(consensus?.compared).toBe(0);
		expect(consensus?.state).toBe('unrecorded');
		expect(consensus?.value).toBe('');
	});
});

/* ───────────────────────── 6. the background wiring ─────────────────────── */

const scratchDir = mkdtempSync(join(tmpdir(), 'dedalo_cluster_jobs_'));
const previousProcessesDir = process.env.DEDALO_MEDIA_PROCESSES_DIR;
process.env.DEDALO_MEDIA_PROCESSES_DIR = markProcessesDir(scratchDir);

const { getBackgroundJob, scheduleBackground } = await import('../../src/core/tools/background.ts');
const { tool } = await import('../../tools/tool_identify/server/index.ts');

afterAll(() => {
	if (previousProcessesDir === undefined) {
		Reflect.deleteProperty(process.env, 'DEDALO_MEDIA_PROCESSES_DIR');
	} else {
		process.env.DEDALO_MEDIA_PROCESSES_DIR = previousProcessesDir;
	}
	rmSync(scratchDir, { recursive: true, force: true });
});

describe('tool_identify::cluster — the background tier', () => {
	test('the module declares exactly the one action that needs the runner', () => {
		expect(tool.name).toBe('tool_identify');
		expect(Object.keys(tool.apiActions)).toEqual(['cluster']);
		expect(tool.backgroundRunnable).toEqual(['cluster']);
	});

	test('the action is gated declaratively, at READ level, on its section targets', () => {
		const spec = tool.apiActions.cluster;
		expect(spec?.permission).toBe('section_list');
		expect(spec?.minLevel).toBe(1);
		// The gate must be able to find the targets inside the payload, or it
		// fails closed on every request and the tool answers nothing forever.
		expect(spec?.sectionTipos?.({ section_tipo: 'test3' })).toEqual(['test3']);
		expect(spec?.sectionTipos?.({ section_tipo: ['a', 'b'] })).toEqual(['a', 'b']);
		expect(spec?.sectionTipos?.({})).toEqual([]);
	});

	test('it reaches the executor and its result lands on the job record', async () => {
		const spec = tool.apiActions.cluster;
		if (spec === undefined) throw new Error('cluster action missing');
		const loaded = { module: tool, dir: '/x', rootIndex: 0 };
		// No section_tipo: the handler declines BEFORE any retrieval, so this
		// exercises the whole background path (allowlist → job → terminal state)
		// without a corpus or a database.
		const response = scheduleBackground(loaded, 'cluster', spec, {}, ADMIN, -1);
		expect(response.data).toBe(true);
		const jobId = response.background_job_id as string;
		await new Promise((resolve) => setTimeout(resolve, 30));
		const job = getBackgroundJob(jobId);
		// The handler REFUSES BY THROWING now (ERRORS_SPEC §4), so the terminal
		// state is 'error' with the refusal's sentence on the job record — which is
		// what get_background_job_status serves to the poller.
		expect(job?.status).toBe('error');
		expect(job?.error).toContain('section_tipo is required');
	});

	test('an action outside the allowlist is refused a fork', () => {
		const spec = tool.apiActions.cluster;
		if (spec === undefined) throw new Error('cluster action missing');
		const loaded = { module: { ...tool, backgroundRunnable: [] }, dir: '/x', rootIndex: 0 };
		// ERRORS_SPEC §4: the refusal is a THROW carrying the registry code — there
		// is no `{result:false, errors:[…]}` body to read any more.
		let thrown: unknown;
		try {
			scheduleBackground(loaded, 'cluster', spec, {}, ADMIN, -1);
		} catch (error) {
			thrown = error;
		}
		expect((thrown as { code?: string } | undefined)?.code).toBe('tool.background_not_allowed');
	});
});
