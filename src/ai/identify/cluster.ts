/**
 * CLUSTERING — "these thirty are all the same thing", answered once.
 *
 * `findMatches` answers "what else is like THIS record?", one seed at a time. A
 * curator who has just imported two hundred photographs has the other problem:
 * opening two hundred records to confirm the same twelve types is the work the
 * system is supposed to remove. So this module takes a SET of records and
 * returns the groups inside it, each group carrying its members, the member most
 * central to it, what the members agree on, and how much the grouping is worth.
 *
 * ── WHY IT LIVES IN src/ai/identify/ ─────────────────────────────────────────
 *
 * Because it reads the IMAGE INDEX (`ai/rag/object_retrieval.ts`), and the
 * engine's dependency direction is one-way: `src/core/` does not statically
 * import `src/ai/`. `ai/identify/propose.ts` is here for exactly the same reason
 * and combines exactly the same two legs. What is NOT here is anything core owns:
 * the pool query (`core/identify/record_pool.ts`), the criteria matcher
 * (`core/identify/match.ts`), the value reader (`core/identify/path_read.ts`) and
 * the per-component gate (`core/identify/component_access.ts`) are imported, not
 * re-implemented. This module is the composition, nothing else — which is also
 * why it stays inside the directory's static no-write scan
 * (`identify_propose.test.ts`): clustering PROPOSES groups, and a curator's
 * acceptance is an ordinary component save it has no path to.
 *
 * ── THE METHOD, AND WHY A CURATOR CAN ARGUE WITH IT ──────────────────────────
 *
 * Threshold-based connected components over a pairwise similarity graph. In
 * full:
 *
 *   1. Each record in the (capped) pool asks for its nearest neighbours, twice:
 *      VISUALLY from the image index, and STRUCTURALLY from the criteria matcher.
 *   2. A neighbour above the relevant threshold becomes an EDGE, tagged with the
 *      signal that produced it and the sentence that explains it.
 *   3. Records joined by edges — directly or through other records — are one
 *      cluster.
 *
 * No library, no centroids, no k to guess, no random seed, no distance metric
 * the answer depends on but nobody can inspect. Every group is a subgraph the
 * result SHIPS: `links` is the literal list of "A and B, 0.94, because their
 * photographs are near-identical", so "why are these together?" is answered by
 * reading the edges, and every member's admission can be traced to a specific
 * pair.
 *
 * THE HONEST COST OF SINGLE LINKAGE is chaining: A~B and B~C put A and C in one
 * cluster even when A and C are not similar at all. That is not hidden, it is
 * MEASURED and reported per cluster — `directEdgeRatio` (what share of the
 * possible pairs are actually linked) and `maxChainHops` (the longest chain
 * inside the group). A cluster with ratio 1.0 and 1 hop is everyone-agrees; a
 * cluster with ratio 0.2 and 5 hops is a chain and reads as one. That is the
 * information a curator needs to decide whether to accept thirty records at
 * once, and a "confidence" number that quietly folded it in would have removed
 * exactly the thing they should be looking at.
 *
 * ── THRESHOLDS: BOTH ALREADY EXIST ───────────────────────────────────────────
 *
 * Neither threshold is invented here.
 *  - VISUAL edges use `DEDALO_RAG_NEAR_DUPLICATE_SIMILARITY` (default 0.93), the
 *    floor the RAG layer already means by "these two pictures are the same
 *    thing" — reused through `multimodalConfigFromEnv()` so an institution that
 *    tuned it gets the tuning here too.
 *  - CRITERIA edges use the profile's OWN `thresholds.sameType`, which is the
 *    curator's authored statement of "this score means same type". Inventing a
 *    second number for the same judgement would be a way for the tool to
 *    disagree with the profile it is running.
 * Both are overridable per call, and both are echoed in the report, because a
 * grouping is meaningless without the threshold that produced it. A run spanning
 * SEVERAL sections applies each section's own authored floor, so the criteria
 * side is echoed per section (`thresholds.criteriaBySection`) and the scalar
 * `thresholds.criteria` collapses only when there is genuinely one number.
 *
 * ── ACCESS CONTROL ───────────────────────────────────────────────────────────
 *
 * The principal is REQUIRED, for the reason `match.ts` states at length. A
 * record the caller may not read must not APPEAR in a cluster and must not
 * INFLUENCE one — the second half matters as much as the first, because a hidden
 * record that bridges two groups would silently merge them and change the answer
 * a curator acts on. So the gate runs before any edge exists: the pool is
 * scoped, and `buildClusterGroups` then discards any edge whose endpoints are
 * not both in the scoped node set (mechanically, not by trusting the callers).
 * Values are additionally re-gated per (section, component) before they are
 * quoted in a consensus line.
 *
 * ── BOUNDED, AND HONEST ABOUT IT ─────────────────────────────────────────────
 *
 * The pool is capped (`core/identify/record_pool.ts`) and the report says when
 * the cap truncated the run. Cancellation is cooperative: the caller's
 * `AbortSignal` is checked at every record boundary, and an aborted run returns
 * the clusters it had found with `stopped: true` rather than nothing at all.
 */

import { buildLocatorLookupKey, type Locator } from '../../core/concepts/locator.ts';
import { type ComponentGrant, criterionReadableOn } from '../../core/identify/component_access.ts';
import {
	type AccessFilter,
	type CandidateRecord,
	compareValues,
	findMatches,
	type MatchReport,
	normalizeText,
} from '../../core/identify/match.ts';
import {
	createPathReadScope,
	IDENTITY_LOCATOR_PROPERTIES,
	readPathValues,
} from '../../core/identify/path_read.ts';
import { ProfileError } from '../../core/identify/profile.ts';
import { loadProfileForSection } from '../../core/identify/profile_source.ts';
import {
	capExplicitPool,
	DEFAULT_CLUSTER_POOL_CAP,
	listRecordPool,
} from '../../core/identify/record_pool.ts';
import type {
	Criterion,
	CriterionPathStep,
	CriterionValue,
	IdentificationProfile,
	MatchResult,
	ValueLocator,
} from '../../core/identify/types.ts';
import type { Principal } from '../../core/security/permissions.ts';
import { scopeRecordHits } from '../../core/security/record_scope.ts';
import { defaultOntologyPort, RagConfig } from '../rag/config.ts';
import {
	buildMultimodalProvider,
	isMediaEnabled,
	multimodalConfigFromEnv,
} from '../rag/multimodal_config.ts';
import { ObjectRetrieval } from '../rag/object_retrieval.ts';
import { isRagEnabled } from '../rag/rag_enabled.ts';

/* ─────────────────────────────── the vocabulary ─────────────────────────── */

/** Which signal produced an edge. Always reported — the two mean different things. */
export type ClusterSignal = 'image' | 'criteria';

/** One pairwise link: the unit of "why are these together?". */
export interface ClusterLink {
	a: CandidateRecord;
	b: CandidateRecord;
	/** In [0,1]: cosine similarity (image) or share of agreed weight (criteria). */
	similarity: number;
	signal: ClusterSignal;
	/** The sentence a curator reads instead of the number. */
	detail: string;
}

/**
 * How one criterion fared ACROSS a cluster's members — the group-level answer to
 * the question `CriterionOutcome` answers for a pair.
 */
export interface ClusterConsensus {
	criterionId: string;
	label: string;
	/**
	 * `agreed`     every member that could be read states a value, and they match;
	 * `partial`    only some members state it, and those that do match;
	 * `differs`    at least two members state values that do not match;
	 * `unrecorded` nobody states it — absence, which is not agreement.
	 */
	state: 'agreed' | 'partial' | 'differs' | 'unrecorded';
	/** How the shared value reads. Empty unless the state is agreed/partial. */
	value: string;
	/** Members whose value this principal was allowed to read at all. */
	compared: number;
	/** Of those, how many actually state a value. */
	stated: number;
	members: number;
}

/** One group of records the engine believes are the same thing. */
export interface RecordCluster {
	/** Stable within one report: the representative's locator. */
	id: string;
	members: CandidateRecord[];
	/**
	 * The most central member — the one with the highest total link strength to
	 * the rest. It is the record whose photograph and values best stand for the
	 * group, and the natural one to open when checking the group by hand.
	 */
	representative: CandidateRecord;
	representativeReason: string;
	/** The distinct signals among this cluster's links. */
	signals: ClusterSignal[];
	/** Every link that holds the group together, in descending strength. */
	links: ClusterLink[];
	/** Per-criterion consensus across the members (profile order). */
	consensus: ClusterConsensus[];
	/** Labels of the criteria every readable member agrees on — the short answer. */
	agreedOn: string[];
	/** Mean link similarity. Stated plainly; never a blend of other numbers. */
	confidence: number;
	/** The weakest link holding the group together. */
	weakestLink: number;
	/** Linked pairs / possible pairs. 1 = everyone is directly similar to everyone. */
	directEdgeRatio: number;
	/** Longest chain between two members. 1 = no chaining at all. */
	maxChainHops: number;
}

/** What one clustering run found, and under what bounds it found it. */
export interface ClusterReport {
	sectionTipos: string[];
	/** Records that survived the cap AND the ACL — the nodes of the graph. */
	recordsConsidered: number;
	/** The cap stopped us: more records matched than were considered. A FLAG. */
	truncated: boolean;
	cap: number;
	/**
	 * The thresholds actually used, echoed so a grouping can be read (§8.2).
	 *
	 * `criteria` is the ONE criteria floor this run applied — a number when every
	 * section that ran a criteria leg used the same one (the single-section case,
	 * and any run with an explicit override), and `null` when no section ran a
	 * criteria leg at all. A multi-section run whose profiles authored DIFFERENT
	 * `thresholds.sameType` values has no single true number, so `criteria` is null
	 * there too and a note names each — reporting one section's threshold as if it
	 * had produced every edge is the failure this field exists to prevent.
	 *
	 * `criteriaBySection` is the unabridged answer: the floor each section's own
	 * edges were held to. Empty when no criteria leg ran.
	 */
	thresholds: {
		image: number;
		criteria: number | null;
		criteriaBySection: Record<string, number>;
	};
	/** Groups of `minClusterSize`+ members, largest first. */
	clusters: RecordCluster[];
	/**
	 * Records that formed no reportable cluster — nothing linked to them, or the
	 * group they were in was smaller than `minClusterSize`. Reported, never
	 * dropped: "this one is on its own" is an answer, and a curator triaging an
	 * import needs to see what the run could NOT group.
	 */
	singletons: CandidateRecord[];
	/** Which legs actually contributed an edge anywhere in this run. */
	signalsUsed: ClusterSignal[];
	/** Sections whose profile is absent or unreadable: no criteria leg for them. */
	notes: string[];
	/** The run was cancelled at a record boundary; the clusters are partial. */
	stopped: boolean;
}

/** Progress ticks, shaped for a background job's publish wire. */
export interface ClusterProgress {
	phase: 'pool' | 'neighbours' | 'consensus';
	counter: number;
	total: number;
	msg: string;
}

/* ──────────────────────────────── the ports ─────────────────────────────── */

/** One record's neighbour, as either leg reports it. */
export interface NeighbourHit {
	record: CandidateRecord;
	/** In [0,1]. */
	similarity: number;
	detail: string;
}

/** The retrieval legs, injected so the graph rules are testable without a corpus. */
export interface ClusterPorts {
	/** Does this section declare an image index at all? */
	hasImageIndex(sectionTipo: string): Promise<boolean>;
	/** Visually near-identical records, already floored at `minSimilarity`. */
	imageNeighbours(input: {
		seed: CandidateRecord;
		principal: Principal;
		topK: number;
		minSimilarity: number;
	}): Promise<NeighbourHit[]>;
	/** Records agreeing on the profile's criteria, scored by the ordinary matcher. */
	criteriaNeighbours(input: {
		profile: IdentificationProfile;
		seed: CandidateRecord;
		principal: Principal;
		topK: number;
		/** The run's data language (ClusterInput.lang), threaded to the matcher. */
		lang?: string;
	}): Promise<NeighbourHit[]>;
}

/** Enumerates the pool. Production is `core/identify/record_pool.ts`. */
export type RecordLister = (input: {
	sectionTipos: string[];
	principal: Principal;
	cap: number;
	sqo?: Record<string, unknown> | null;
}) => Promise<{ records: CandidateRecord[]; truncated: boolean }>;

/** Reads one record's value at one criterion path. */
export type ClusterValueReader = (
	record: CandidateRecord,
	path: CriterionPathStep[],
) => Promise<CriterionValue | null>;

export interface ClusterInput {
	/** The sections to cluster within. Also the compare scope for the image leg. */
	sectionTipos: string[];
	/**
	 * WHOSE READ THIS IS. Required, never optional — a cluster quotes its members'
	 * values back and an absent principal means "unscoped" everywhere downstream.
	 */
	principal: Principal;
	/**
	 * Cluster exactly these records ("the thirty I just imported"). When omitted
	 * the pool is the sections' records, narrowed by `sqo`. Capped either way.
	 */
	records?: CandidateRecord[];
	/** The caller's live filter, used to select the pool when `records` is absent. */
	sqo?: Record<string, unknown> | null;
	/** Max records considered. Default DEFAULT_CLUSTER_POOL_CAP. */
	cap?: number;
	/** Visual edge floor. Default: DEDALO_RAG_NEAR_DUPLICATE_SIMILARITY. */
	imageThreshold?: number;
	/** Criteria edge floor. Default: the section profile's own thresholds.sameType. */
	criteriaThreshold?: number;
	/** Neighbours requested per record per leg. Default 20. */
	neighbourTopK?: number;
	/** Smallest group worth reporting as a cluster. Default 2. */
	minClusterSize?: number;
	/** Data language for value resolution. Explicit, never an ALS read. */
	lang?: string;
	/** Cooperative cancellation; checked at every record boundary. */
	signal?: AbortSignal;
	/** Progress sink (a background job's publishProgress). */
	onProgress?: (progress: ClusterProgress) => void;
	/**
	 * Injectable seams. Production omits all of them; they exist so the GRAPH
	 * rules, the CAP and the ACL can be tested as pure logic over a fixed
	 * similarity matrix. A clusterer only reachable through a live corpus ends up
	 * verified for the two cases someone had fixtures for.
	 */
	ports?: Partial<ClusterPorts>;
	listRecords?: RecordLister;
	filterAccessible?: AccessFilter;
	readValues?: ClusterValueReader;
	componentGrant?: ComponentGrant;
	loadProfile?: (sectionTipo: string) => Promise<IdentificationProfile | null>;
}

/** Default neighbours requested per record per leg. */
export const DEFAULT_NEIGHBOUR_TOP_K = 20;

/* ────────────────────── the pure part: graph → clusters ─────────────────── */

/**
 * Connected components over the edges that survive the node set.
 *
 * PURE, and deliberately the only place the grouping rule lives: given nodes and
 * a similarity graph, the groups are fully determined — no thresholds (already
 * applied), no retrieval, no clock, no database. Every property a curator reads
 * off a cluster is computed here from the edges the answer also ships.
 *
 * EDGES ARE FILTERED AGAINST `nodes` HERE, not upstream. That is the mechanical
 * expression of "a record the caller cannot read must not influence a cluster":
 * the ACL removes the record from the node set, and a bridging edge through it
 * then cannot merge two groups regardless of which retrieval leg produced it.
 */
export function buildClusterGroups(
	nodes: readonly CandidateRecord[],
	edges: readonly ClusterLink[],
	options: { minClusterSize?: number } = {},
): { clusters: Omit<RecordCluster, 'consensus' | 'agreedOn'>[]; singletons: CandidateRecord[] } {
	const minClusterSize = Math.max(2, options.minClusterSize ?? 2);

	const nodeByKey = new Map<string, CandidateRecord>();
	for (const node of nodes) nodeByKey.set(recordKey(node), node);

	// Composite Map keys are joined with a PRINTABLE separator. This used to be a
	// literal NUL, which made `file` report this source as binary data and made
	// grep/rg skip the whole file in silence — a source file no search tool will
	// read is a place bugs hide. '|' cannot occur in a recordKey (section_tipo +
	// '_' + numeric section_id) nor in a ClusterSignal.
	const KEY_SEP = '|';

	// Keep only edges BETWEEN admitted nodes, and only one per (pair, signal):
	// two legs may both link the same pair, and both explanations are worth
	// keeping, but a repeated hit from one leg is not extra evidence.
	const bestEdge = new Map<string, ClusterLink>();
	for (const edge of edges) {
		const keyA = recordKey(edge.a);
		const keyB = recordKey(edge.b);
		if (keyA === keyB) continue;
		if (!nodeByKey.has(keyA) || !nodeByKey.has(keyB)) continue;
		const pair = keyA < keyB ? `${keyA}${KEY_SEP}${keyB}` : `${keyB}${KEY_SEP}${keyA}`;
		const slot = `${pair}${KEY_SEP}${edge.signal}`;
		const existing = bestEdge.get(slot);
		if (existing === undefined || edge.similarity > existing.similarity) bestEdge.set(slot, edge);
	}
	const admitted = [...bestEdge.values()];

	// Union-find over the admitted edges: the components ARE the clusters.
	const parent = new Map<string, string>();
	for (const key of nodeByKey.keys()) parent.set(key, key);
	const find = (key: string): string => {
		let root = key;
		while (parent.get(root) !== root) root = parent.get(root) as string;
		let walk = key;
		while (parent.get(walk) !== root) {
			const next = parent.get(walk) as string;
			parent.set(walk, root);
			walk = next;
		}
		return root;
	};
	for (const edge of admitted) {
		const rootA = find(recordKey(edge.a));
		const rootB = find(recordKey(edge.b));
		if (rootA !== rootB) parent.set(rootA, rootB);
	}

	const membersByRoot = new Map<string, string[]>();
	for (const key of nodeByKey.keys()) {
		const root = find(key);
		const bucket = membersByRoot.get(root);
		if (bucket === undefined) membersByRoot.set(root, [key]);
		else bucket.push(key);
	}
	const edgesByRoot = new Map<string, ClusterLink[]>();
	for (const edge of admitted) {
		const root = find(recordKey(edge.a));
		const bucket = edgesByRoot.get(root);
		if (bucket === undefined) edgesByRoot.set(root, [edge]);
		else bucket.push(edge);
	}

	const clusters: Omit<RecordCluster, 'consensus' | 'agreedOn'>[] = [];
	const singletons: CandidateRecord[] = [];
	for (const [root, memberKeys] of membersByRoot) {
		const members = memberKeys.map((key) => nodeByKey.get(key) as CandidateRecord);
		const links = (edgesByRoot.get(root) ?? []).sort((a, b) => b.similarity - a.similarity);
		if (members.length < minClusterSize || links.length === 0) {
			singletons.push(...members);
			continue;
		}
		clusters.push(describeCluster(members, links));
	}

	// Largest first, then strongest: the group a curator can dispatch in one
	// action is the one they want at the top.
	clusters.sort((a, b) => b.members.length - a.members.length || b.confidence - a.confidence);
	singletons.sort(compareRecords);
	return { clusters, singletons };
}

/** Everything a curator reads off one component, computed from its own edges. */
function describeCluster(
	members: CandidateRecord[],
	links: ClusterLink[],
): Omit<RecordCluster, 'consensus' | 'agreedOn'> {
	const ordered = [...members].sort(compareRecords);

	// Adjacency over the DISTINCT pairs (a pair linked by both legs is one pair).
	const adjacency = new Map<string, Set<string>>();
	for (const member of ordered) adjacency.set(recordKey(member), new Set());
	const strength = new Map<string, number>();
	for (const link of links) {
		const keyA = recordKey(link.a);
		const keyB = recordKey(link.b);
		adjacency.get(keyA)?.add(keyB);
		adjacency.get(keyB)?.add(keyA);
		strength.set(keyA, (strength.get(keyA) ?? 0) + link.similarity);
		strength.set(keyB, (strength.get(keyB) ?? 0) + link.similarity);
	}
	let distinctPairs = 0;
	for (const neighbours of adjacency.values()) distinctPairs += neighbours.size;
	distinctPairs /= 2;

	// The representative is the most CENTRAL member: highest total link strength.
	// Ties break on the record order so one report is one answer.
	let representative = ordered[0] as CandidateRecord;
	let bestStrength = Number.NEGATIVE_INFINITY;
	for (const member of ordered) {
		const total = strength.get(recordKey(member)) ?? 0;
		if (total > bestStrength) {
			bestStrength = total;
			representative = member;
		}
	}
	const degree = adjacency.get(recordKey(representative))?.size ?? 0;

	const similarities = links.map((link) => link.similarity);
	const confidence = similarities.reduce((sum, value) => sum + value, 0) / similarities.length;
	const possiblePairs = (ordered.length * (ordered.length - 1)) / 2;

	return {
		id: recordKey(representative),
		members: ordered,
		representative,
		representativeReason: `most central member: linked to ${degree} of the other ${ordered.length - 1}, total link strength ${round(bestStrength)}`,
		signals: [...new Set(links.map((link) => link.signal))].sort(),
		links,
		confidence: round(confidence),
		weakestLink: round(Math.min(...similarities)),
		directEdgeRatio: possiblePairs === 0 ? 1 : round(distinctPairs / possiblePairs),
		maxChainHops: graphDiameter(adjacency),
	};
}

/**
 * The longest shortest-path inside the group — how far single linkage had to
 * chain to hold it together. 1 means every member is directly linked to every
 * other; 4 means somebody is four hops from somebody else and the two have
 * nothing directly in common.
 */
function graphDiameter(adjacency: ReadonlyMap<string, Set<string>>): number {
	let diameter = 0;
	for (const start of adjacency.keys()) {
		const distance = new Map<string, number>([[start, 0]]);
		const queue = [start];
		for (let head = 0; head < queue.length; head++) {
			const current = queue[head] as string;
			const step = (distance.get(current) as number) + 1;
			for (const next of adjacency.get(current) ?? []) {
				if (distance.has(next)) continue;
				distance.set(next, step);
				queue.push(next);
				if (step > diameter) diameter = step;
			}
		}
	}
	return diameter;
}

/* ─────────────────────────────── the entry point ────────────────────────── */

/**
 * Group a set of records into the things they are.
 *
 * Never throws on a per-section problem: a section whose identification profile
 * is malformed loses its CRITERIA leg and gains a note, because a batch run over
 * several sections must not be destroyed by one bad descriptor — and the note
 * carries the parser's own message, so the failure still travels loudly.
 */
export async function clusterRecords(input: ClusterInput): Promise<ClusterReport> {
	const { principal } = input;
	const sectionTipos = [...new Set(input.sectionTipos)].filter((tipo) => tipo !== '');
	const cap = Math.max(1, Math.trunc(input.cap ?? DEFAULT_CLUSTER_POOL_CAP));
	const topK = Math.max(1, Math.trunc(input.neighbourTopK ?? DEFAULT_NEIGHBOUR_TOP_K));
	const minClusterSize = Math.max(2, Math.trunc(input.minClusterSize ?? 2));
	const imageThreshold = input.imageThreshold ?? multimodalConfigFromEnv().nearDuplicateSimilarity;
	const ports = { ...defaultClusterPorts(), ...(input.ports ?? {}) };
	const listRecords = input.listRecords ?? defaultRecordLister;
	const filterAccessible = input.filterAccessible ?? defaultAccessFilter;
	const componentGrant = input.componentGrant;
	// ONE path-reader scope per run: every landed record is authorized on its
	// own section inside the reader (path_read.ts ACCESS, P1-3 / SEC-12).
	const pathScope = createPathReadScope({
		principal,
		door: 'identify.cluster',
		...(componentGrant === undefined ? {} : { componentGrant }),
	});
	const readValues: ClusterValueReader =
		input.readValues ??
		((record, path) => readPathValues(record, path, { lang: input.lang, scope: pathScope }));
	const loadProfile = input.loadProfile ?? ((tipo: string) => loadProfileForSection(tipo));
	const publish = input.onProgress ?? (() => {});
	const notes: string[] = [];

	// 1. THE POOL, capped either way (an explicit list is not a licence to run
	//    unbounded), then ACL-scoped. Everything after this point sees only
	//    records this principal may read.
	publish({ phase: 'pool', counter: 0, total: 0, msg: 'Selecting records to compare' });
	const pool =
		input.records !== undefined
			? capExplicitPool(input.records, cap)
			: await listRecords({ sectionTipos, principal, cap, sqo: input.sqo ?? null });
	const nodes = await filterAccessible(principal, pool.records);

	// 2. Per-section profiles. Absent is normal (image-only clustering); malformed
	//    is a note carrying the parser's message, never a thrown batch.
	const profiles = new Map<string, IdentificationProfile | null>();
	for (const tipo of new Set(nodes.map((node) => node.sectionTipo))) {
		try {
			const profile = await loadProfile(tipo);
			profiles.set(tipo, profile);
			if (profile === null) {
				notes.push(`section '${tipo}' declares no identification profile: no criteria leg for it`);
			}
		} catch (error) {
			profiles.set(tipo, null);
			const message = error instanceof ProfileError ? error.message : String(error);
			notes.push(
				`section '${tipo}' has an unusable identification profile (${message}): no criteria leg for it`,
			);
		}
	}
	const criteriaThresholdOverride = input.criteriaThreshold;
	// The floor each section's criteria edges were actually held to. A run may span
	// sections whose profiles authored different sameType values, and the report
	// must not present one of them as the threshold that made every group.
	const criteriaThresholdBySection = new Map<string, number>();

	// 3. EDGES. Each record asks both legs for its neighbours; a neighbour above
	//    the relevant threshold and inside the node set becomes a link.
	const admitted = new Set(nodes.map((node) => recordKey(node)));
	const links: ClusterLink[] = [];
	const imageIndexed = new Map<string, boolean>();
	let stopped = false;
	let counter = 0;
	for (const node of nodes) {
		// Cooperative cancellation at a record boundary: an aborted run reports the
		// clusters it did find, marked partial. Nothing here writes, so stopping
		// mid-run cannot leave anything half-done.
		if (input.signal?.aborted === true) {
			stopped = true;
			break;
		}
		counter++;
		publish({
			phase: 'neighbours',
			counter,
			total: nodes.length,
			msg: `Comparing record ${counter} of ${nodes.length}`,
		});

		// IMAGE leg. A record with no indexed photograph simply produces nothing
		// here and clusters on criteria alone — which is why the two legs are
		// additive rather than a fallback chain.
		let hasIndex = imageIndexed.get(node.sectionTipo);
		if (hasIndex === undefined) {
			hasIndex = await ports.hasImageIndex(node.sectionTipo);
			imageIndexed.set(node.sectionTipo, hasIndex);
		}
		if (hasIndex) {
			const hits = await ports.imageNeighbours({
				seed: node,
				principal,
				topK,
				minSimilarity: imageThreshold,
			});
			for (const hit of hits) {
				if (hit.similarity < imageThreshold) continue;
				if (!admitted.has(recordKey(hit.record))) continue;
				links.push({
					a: node,
					b: hit.record,
					similarity: round(hit.similarity),
					signal: 'image',
					detail: hit.detail,
				});
			}
		}

		// CRITERIA leg, at the profile's OWN sameType threshold unless overridden.
		const profile = profiles.get(node.sectionTipo) ?? null;
		if (profile !== null) {
			const threshold = criteriaThresholdOverride ?? profile.thresholds.sameType;
			criteriaThresholdBySection.set(node.sectionTipo, threshold);
			const hits = await ports.criteriaNeighbours({
				profile,
				seed: node,
				principal,
				topK,
				lang: input.lang,
			});
			for (const hit of hits) {
				if (hit.similarity < threshold) continue;
				if (!admitted.has(recordKey(hit.record))) continue;
				links.push({
					a: node,
					b: hit.record,
					similarity: round(hit.similarity),
					signal: 'criteria',
					detail: hit.detail,
				});
			}
		}
	}

	// 4. THE GROUPS (pure), then what each group agrees on.
	const grouped = buildClusterGroups(nodes, links, { minClusterSize });
	const clusters: RecordCluster[] = [];
	let consensusCounter = 0;
	for (const cluster of grouped.clusters) {
		consensusCounter++;
		publish({
			phase: 'consensus',
			counter: consensusCounter,
			total: grouped.clusters.length,
			msg: `Reading what cluster ${consensusCounter} of ${grouped.clusters.length} agrees on`,
		});
		const profile = profiles.get(cluster.representative.sectionTipo) ?? null;
		const consensus =
			profile === null
				? []
				: await readConsensus({
						profile,
						members: cluster.members,
						principal,
						readValues,
						componentGrant,
					});
		clusters.push({
			...cluster,
			consensus,
			agreedOn: consensus.filter((entry) => entry.state === 'agreed').map((entry) => entry.label),
		});
	}

	// The criteria floor(s) this run applied. One distinct value collapses to the
	// scalar every reader already expects; several do NOT collapse — they become a
	// null scalar plus a note that names each, because "the threshold that made
	// this grouping" is not a single number in that run and pretending it is would
	// make the report unreadable in exactly the way §8.2 forbids.
	const criteriaBySection = Object.fromEntries(criteriaThresholdBySection);
	const distinctCriteria = [...new Set(criteriaThresholdBySection.values())];
	if (distinctCriteria.length > 1) {
		notes.push(
			`the sections in this run authored different criteria thresholds (${[
				...criteriaThresholdBySection,
			]
				.map(([tipo, value]) => `'${tipo}': ${value}`)
				.sort()
				.join(', ')}), so no single criteria threshold describes the grouping`,
		);
	}

	return {
		sectionTipos,
		recordsConsidered: nodes.length,
		truncated: pool.truncated,
		cap,
		thresholds: {
			image: imageThreshold,
			criteria: distinctCriteria.length === 1 ? (distinctCriteria[0] as number) : null,
			criteriaBySection,
		},
		clusters,
		singletons: grouped.singletons,
		signalsUsed: [...new Set(links.map((link) => link.signal))].sort(),
		notes,
		stopped,
	};
}

/* ────────────────────────────── group consensus ─────────────────────────── */

/**
 * What a cluster's members agree on, criterion by criterion.
 *
 * Every value is compared with the FIRST stated one through the matcher's own
 * `compareValues`, so "agree" means here exactly what it means in a match
 * breakdown — tolerances, normalization and locator identity included. Two
 * comparison rules would be two different claims wearing one word.
 *
 * ABSENCE IS NOT DISAGREEMENT (the rule the whole subsystem is built on): a
 * criterion only some members record is `partial`, not `differs`, and one nobody
 * records is `unrecorded` rather than a spurious consensus.
 *
 * Values are re-gated per (section, component) before they are read, because a
 * consensus line QUOTES them.
 */
async function readConsensus(input: {
	profile: IdentificationProfile;
	members: readonly CandidateRecord[];
	principal: Principal;
	readValues: ClusterValueReader;
	componentGrant?: ComponentGrant;
}): Promise<ClusterConsensus[]> {
	const { profile, members, principal, readValues, componentGrant } = input;
	const out: ClusterConsensus[] = [];

	for (const criterion of profile.criteria) {
		if (criterion.role === 'ignored') continue;
		let compared = 0;
		const stated: CriterionValue[] = [];
		for (const member of members) {
			if (!(await criterionReadableOn(criterion, member, principal, componentGrant))) continue;
			compared++;
			const value = await readValues(member, criterion.path);
			if (value !== null) stated.push(value);
		}

		const base: Omit<ClusterConsensus, 'state' | 'value'> = {
			criterionId: criterion.id,
			label: criterion.label,
			compared,
			stated: stated.length,
			members: members.length,
		};
		const first = stated[0];
		if (first === undefined) {
			out.push({ ...base, state: 'unrecorded', value: '' });
			continue;
		}
		let allAgree = true;
		for (let index = 1; index < stated.length; index++) {
			const { agreed } = compareValues(criterion, first, stated[index] as CriterionValue);
			if (agreed === false) {
				allAgree = false;
				break;
			}
		}
		if (!allAgree) {
			out.push({ ...base, state: 'differs', value: '' });
			continue;
		}
		out.push({
			...base,
			state: stated.length === compared && compared > 1 ? 'agreed' : 'partial',
			value: displayValue(first),
		});
	}
	return out;
}

/* ────────────────────────────── production ports ────────────────────────── */

/**
 * The production legs.
 *
 * Built exactly as `ai/identify/propose.ts` builds its own (kill-switch, media
 * switch, env-configured provider, the section's declared compare scope), so
 * "similar objects", "proposals" and "clusters" never disagree about what a
 * neighbour is.
 */
export function defaultClusterPorts(): ClusterPorts {
	return {
		async hasImageIndex(sectionTipo: string): Promise<boolean> {
			if (!isRagEnabled() || !isMediaEnabled()) return false;
			return await new RagConfig(defaultOntologyPort()).sectionHasImageContext(sectionTipo);
		},
		async imageNeighbours({ seed, principal, topK, minSimilarity }): Promise<NeighbourHit[]> {
			const cfg = multimodalConfigFromEnv();
			const retrieval = new ObjectRetrieval(buildMultimodalProvider(cfg));
			const scope = await new RagConfig(defaultOntologyPort()).getCompareScope(seed.sectionTipo);
			const hits = await retrieval.findSimilarObjects(principal, seed, {
				sectionTipos: scope,
				mode: cfg.imageHybrid ? 'hybrid' : 'visual',
				topK,
				// The near-duplicate floor is applied INSIDE retrieval, on the same
				// `1 - distance` this reads back — one definition of "visually the same
				// thing", not a second filter that could drift from it.
				minSimilarity,
			});
			return hits.map((hit) => {
				const similarity = 1 - (hit.distance ?? 1);
				return {
					record: { sectionTipo: hit.sectionTipo, sectionId: hit.sectionId },
					similarity,
					detail: `photographs are ${(similarity * 100).toFixed(1)}% similar in the image index`,
				};
			});
		},
		async criteriaNeighbours({ profile, seed, principal, topK, lang }): Promise<NeighbourHit[]> {
			const report: MatchReport = await findMatches({
				profile,
				seed,
				principal,
				limit: topK,
				lang,
			});
			return report.results.map((result) => ({
				record: { sectionTipo: result.sectionTipo, sectionId: result.sectionId },
				similarity: result.score,
				detail: matchDetail(result),
			}));
		},
	};
}

/** The production pool: `core/identify/record_pool.ts`, capped and scoped. */
const defaultRecordLister: RecordLister = (input) => listRecordPool(input);

/**
 * The per-record half of the ACL, through the engine's shared scope gate — the
 * same call `match.ts` and `propose.ts` make, for the same reason (a hit from a
 * broad index is never an authorization oracle). Denied records are dropped
 * SILENTLY: a "3 hidden" line is an existence oracle.
 */
const defaultAccessFilter: AccessFilter = async (principal, records) => {
	const scoped = await scopeRecordHits(
		records.map((record) => ({
			section_tipo: record.sectionTipo,
			section_id: record.sectionId,
		})),
		principal,
	);
	return scoped.map((hit) => ({ sectionTipo: hit.section_tipo, sectionId: hit.section_id }));
};

/* ─────────────────────────────── small helpers ──────────────────────────── */

/** A match result as one sentence: the score plus what actually agreed. */
function matchDetail(result: MatchResult): string {
	const agreed = result.outcomes
		.filter((outcome) => outcome.agreed === true && outcome.weight > 0)
		.map((outcome) => outcome.label);
	const share = `${(result.score * 100).toFixed(0)}% of the achievable identifying weight`;
	return agreed.length === 0
		? `criteria agreement ${share}`
		: `criteria agreement ${share} — agrees on ${agreed.join(', ')}`;
}

/** How a criterion value reads in a consensus line. */
function displayValue(value: CriterionValue): string {
	switch (value.kind) {
		case 'locators':
			return value.locators
				.map((locator) => `${locator.section_tipo}/${locator.section_id}`)
				.join(', ');
		case 'text':
			return value.values.filter((text) => normalizeText(text) !== '').join(', ');
		case 'number':
			return value.values.map((number) => String(number)).join(', ');
		case 'date':
			return value.ranges.map((range) => `${range.from}…${range.to}`).join(', ');
	}
}

/** Locator identity, on the subsystem's ONE property set (path_read/match agree). */
function recordKey(record: CandidateRecord | ValueLocator): string {
	const locator =
		'sectionTipo' in record
			? { section_tipo: record.sectionTipo, section_id: record.sectionId }
			: record;
	return buildLocatorLookupKey(locator as Locator, IDENTITY_LOCATOR_PROPERTIES);
}

/** Deterministic record order, so one run is one answer. */
function compareRecords(a: CandidateRecord, b: CandidateRecord): number {
	return a.sectionTipo.localeCompare(b.sectionTipo) || a.sectionId - b.sectionId;
}

/** Three decimals: a similarity is a judgement, not a measurement to 15 digits. */
function round(value: number): number {
	return Math.round(value * 1000) / 1000;
}

/** Re-exported so a consumer types a criterion without reaching into core. */
export type { CandidateRecord, Criterion };
