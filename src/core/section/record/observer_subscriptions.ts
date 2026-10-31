/**
 * OBSERVER SUBSCRIPTION REGISTRY (Act 2, 2026-08-02; allowlist removed same
 * day) — ontology-derived edge discovery, replacing forward-only discovery.
 *
 * THE DEFECT THIS CLOSES: discovery used to read ONLY the saved component's
 * `properties.observers` (PHP-identical), so an observer edge had to be
 * declared TWICE — forward on the observed node (`observers`) and reverse on
 * the observer node (`observe`) — and a missing half was DEAD CONFIG that
 * failed silently (the rsc19 -> oh28 report; 9 reverse-only edges measured
 * inert on the live ontology). The registry is built over the WHOLE ontology
 * (`getNodesWithProperty('observers') ∪ getNodesWithProperty('observe')`), so
 * ONE declaration is enough.
 *
 * THE DISPATCH RULE (owner ruling 2026-08-02, replacing the transitional
 * hand-written activation table): an edge dispatches iff the OBSERVER declares
 * it in `properties.observe` with a `server` block — plus wildcard edges
 * compiled from forward specs (below). No code table gates it. Standard
 * observer semantics: THE SUBSCRIBER REGISTERS ITSELF; the observed node does
 * not maintain a list of who watches it. "The good configuration is set into
 * the observe property on the observer — the observed does not need to say
 * 'X is calling me'." Requiring the forward mirror was the inversion that
 * produced every dead edge in this subsystem; a hardcoded activation list
 * would have converted an ontology decision into a code decision — same
 * inversion, different file. The per-edge kill switch is therefore an
 * ONTOLOGY EDIT (blank the observe entry's `server` key), never a code table.
 *
 * HOST-SECTION RESOLUTION ("which section's records do I recompute?" — the
 * one thing a reverse declaration may not carry implicitly), in order:
 *   1. the `observe` entry's OWN `section_tipo` — ontology, on the observer:
 *      the authoring home for new edges (nothing uses it yet);
 *   2. the forward spec's `section_tipo` (when a forward spec exists and
 *      names a real scope — not the literal 'self'). NOT redundant with the
 *      observer's own section: a component declared ONCE can be REUSED across
 *      sections — measured: rsc387 declares observer hierarchy93 three times
 *      with section_tipo on1/ts1/dc1 while hierarchy93's own ontology
 *      position is section hierarchy20 (9 of 64 mirrored edges are like
 *      this). Those edges must NEVER be silently retargeted to the observer's
 *      own section;
 *   3. the observer's OWN SECTION (its dd_ontology ancestor chain —
 *      getAncestorSectionTipo), refined by the SQO filter path when the entry
 *      carries one: virtual and real sections are EQUIVALENT (a virtual
 *      section's relations[0].tipo names its real section — resolver.ts /
 *      getSectionRealTipo), so a filter path naming numisdata5 under an
 *      observer whose own section is numisdata276 is NOT ambiguous — they are
 *      the same section, and the path's face (the virtual tipo) is the one
 *      the stored records carry, so it wins. A path naming a NON-equivalent
 *      section resolves to nothing (never a silent retarget);
 *   4. unresolved → the consumer REFUSES LOUDLY, naming the edge and telling
 *      the author to add a section scope to the observe entry (validator RED
 *      too — `hostUnresolved`). Nothing hits this on the current ontology.
 *
 * THE 'all' WILDCARD IS COMPILED, NEVER INTERPRETED AS "EVERY SAVE" — and it
 * is the SOLE residual dependency on the forward `observers` array (beyond
 * rule-2 host targeting): an `observe` entry with `component_tipo:'all'` is a
 * MATCHING rule with NO intrinsic scope, so the forward specs naming the
 * observer are the only thing bounding it. The builder compiles it into
 * exactly that edge set (3 edges on the live ontology:
 * numisdata282->numisdata250, numisdata1451->numisdata257, tch555->tch557) in
 * pass 1 ONLY — pass 2 `continue`s on 'all', so a wildcard NEVER mints an
 * edge without a forward spec. A wildcard with zero forward-declarers (or
 * every declarer shadowed by an earlier exact entry in the first-match law)
 * admits ZERO edges and is a RED diagnostic. Inventing a scope semantic here
 * would silently widen these observers to every save in the system.
 *
 * WHERE VIOLATIONS SURFACE (the honest coverage map): the DEC-12 gates
 * (test/unit/observer_subscriptions_native.test.ts) turn violations RED on
 * whatever ontology the suite runs against — the dedicated suite DB, a strict
 * subset of a production install's ontology. An edge authored ONLY in a
 * production ontology surfaces OPERATIONALLY: the boot probe (server.ts warms
 * this registry at startup, logging every violation against the real ontology
 * on every deploy/restart), the `observers_registry` ops gauge + the
 * `observers_registry_contract_violations` counter on GET /api/v1/counters.
 *
 * LIFECYCLE: built lazily on first use, cached process-wide through
 * createOntologyCache — the invalidation hub clears it after EVERY dd_ontology
 * write (deferred to COMMIT inside a transaction), so REGISTRATION is by
 * construction and this is a legal module-level cache. Two windows are closed
 * explicitly on top of that: (1) the SEED RACE — a concurrent dd_ontology
 * COMMIT can fire the clearers between this builder's reads and its cache
 * write, so a build token planted before the reads (cleared by the same hub
 * fire) guards the seed: if the token did not survive, the index is served to
 * the caller but never cached; (2) the IN-TRANSACTION rebuild loop — S1-14
 * forbids seeding the shared cache from an ambient transaction (the build may
 * observe uncommitted rows), and a cold-cache import (one tx per row, the
 * dispatch running inside it) would otherwise rebuild per component save, so
 * in-tx builds memoize on the TRANSACTION-scoped memo (postgres.ts
 * getTransactionMemo) — one build per tx span, dying with the transaction.
 * The built index is deep-frozen AND its Maps runtime-hardened (Object.freeze
 * alone does not seal Map internals — the mutators are shadowed to throw);
 * a stale index is rebuilt on the next miss, never patched.
 *
 * LAW-DERIVED EDGES (pass 3, owner ruling 2026-10-30, Q1): an external-value
 * law that READS a component D without SUBSCRIBING to D is stale by
 * construction — the copy law (`source.source_overwrite`) copies
 * `data_from_field` D off the record its pointer names, so a save of D on
 * that source record must recompute every holder of the pointer. The law's
 * own `dependencies()` (external_laws/) is the ONE statement of what it reads;
 * pass 3 turns each dependency into a subscription with the inverse resolver
 * (`use_inverse_relations` through the law's pointer — the exact lookup).
 * Only `source_overwrite` declares dependencies (`inverse_search` and
 * `observed_data` return `[]`: the first is law (c), whose edges are the
 * declared ones, and the second's self edge is declared) — so pass 3 never
 * mints an edge per `data_from_field` node. Bounds, each deliberate:
 *   - only a COVERED external observer derives (a stored law AND a declared
 *     set_dato_external server entry — isCoveredExternalObserverNode): a law
 *     the author never wired to the kernel is not activated by a derivation;
 *   - a DECLARED edge wins: any forward spec or observe entry (server or
 *     client-only) on the same `observed->observer` key shadows the derived
 *     one — so the per-edge kill switch stays an ontology edit (declare a
 *     client-only observe entry for D on the observer);
 *   - derived edges carry no authored observe entry (no `client` block, no
 *     host scope), so the observe-entry contract checks do not apply to
 *     them; they are LISTED in `diagnostics.lawDerived` / `lawShadowed`
 *     instead, and they take part in the cycle scan (a derived cycle is a
 *     real runtime cycle).
 * Read-only over existing properties: no ontology node is created.
 *
 * CONSUMERS: ./observers.ts (dispatch + the cascade leaf pre-gate) and
 * ./observer_reconcile.ts (tuple discovery — previously its own third copy of
 * forward-only discovery). The contract validator below is shared between the
 * runtime build (loud log + counter, never a throw — saves must not die on a
 * malformed user ontology) and the DEC-12 gates (where violations are RED).
 */

import { config } from '../../../config/config.ts';
import { incrementCounter } from '../../api/counters.ts';
import { getTransactionMemo, isInTransaction, registerCommitAction } from '../../db/postgres.ts';
import { DedaloError } from '../../errors/dedalo_error.ts';
import { createOntologyCache } from '../../ontology/cache_factory.ts';
import { registerOntologyCacheClearer } from '../../ontology/cache_invalidation.ts';
import {
	getAncestorSectionTipo,
	getNodesWithProperty,
	type NodeWithProperties,
} from '../../ontology/resolver.ts';
import { isSuiteDatabaseName } from '../../test_data/test_database_marker_constants.ts';
import { resolveExternalLaw } from './external_laws/classify.ts';
import {
	externalLawDependencies,
	isCoveredExternalObserverNode,
} from './external_laws/resolvers.ts';
import type { LawDependency } from './external_laws/types.ts';

/** One `observe` entry as declared on an observer node (shared with observers.ts). */
export interface ObserveEntry {
	component_tipo?: string;
	/** Explicit host-section scope (resolution step 1 — the authoring home for
	 * new edges; no shipped entry carries it yet). */
	section_tipo?: string;
	server?: {
		filter?: unknown;
		config?: {
			use_observable_dato?: boolean;
			use_self_section?: boolean;
			/** Targets = the records whose relations point at the saved record
			 * (PHP `use_inverse_relations`; the declared ordered-coins shape, and
			 * every law-derived edge — see the header). */
			use_inverse_relations?: boolean;
		};
		perform?: { function?: string; params?: Record<string, unknown> };
	};
}

/** One declared observer edge, host-resolved. Dispatchability IS a
 * well-formed `entry.server` object — `entryServerBlock(entry) !== undefined`
 * — no separate flag, no code table (a present-but-non-object server value is
 * MALFORMED authoring: flagged RED, never dispatched). */
export interface ObserverSubscription {
	observedTipo: string;
	observerTipo: string;
	/**
	 * 'mirrored'     — forward spec + matching observe entry;
	 * 'forward-only' — forward spec, no observe entry at all (dead config, RED);
	 * 'reverse-only' — observe entry with server, no forward spec (the
	 *                  single-declaration model — dispatches like any other);
	 * 'law-derived'  — synthesized from the observer's external-value law
	 *                  (pass 3 — header LAW-DERIVED EDGES); `origin:'law'`.
	 */
	declaration: 'mirrored' | 'forward-only' | 'reverse-only' | 'law-derived';
	/** 'declared' = authored in the ontology (passes 1-2); 'law' = derived from
	 * the observer's law (pass 3). Absent reads as 'declared' (hand-built
	 * fixtures predate the field); the builder always sets it. */
	origin?: 'declared' | 'law';
	/** Law-derived edges only: the pointer component the inverse lookup goes
	 * through (the law dependency's `via`). */
	via?: string;
	/** Matched through the observer's 'all' wildcard entry (compiled at build). */
	viaWildcard: boolean;
	/** The matching observe entry (first exact-or-'all' in array order — the
	 * dispatch law); undefined for forward-only declarations. */
	entry: ObserveEntry | undefined;
	/**
	 * The section the observer's recompute targets (SQO-filter search scope /
	 * reconciler host), resolved by the 4-step rule in the header. Undefined =
	 * unresolved: consumers that NEED it (the SQO-filter recompute) refuse
	 * loudly (step 4); consumers that don't (filter:false same-record, relay,
	 * set_dato_external — targets come from the observable data) ignore it.
	 */
	hostSection: string | undefined;
}

/** Build-time findings the gates assert on (all as `observed->observer` keys,
 * scratch-namespace edges excluded — see the carve-out below). */
export interface SubscriptionDiagnostics {
	/** Mirrored edges with a server block. */
	mirroredServer: readonly string[];
	/** Reverse-only server declarations (deduped) — these DISPATCH. */
	reverseOnly: readonly string[];
	/** Forward specs with no observe entry at all — dead config, RED. */
	forwardOnly: readonly string[];
	/** 'all'-wildcard observers (with server) that NO forward spec names — dead config. */
	deadWildcards: readonly string[];
	/** observer tipo → the edge keys its 'all' wildcard compiled to. */
	wildcardCompiled: ReadonlyMap<string, readonly string[]>;
	/** SQO-filter server edges whose host section resolved to NOTHING (step 4)
	 * — RED; the dispatch refuses the recompute loudly. */
	hostUnresolved: readonly string[];
	/** Cycles found in the declared server-edge graph (each as a key path). */
	cycles: readonly (readonly string[])[];
	/** observers[] specs without a string component_tipo (undispatachable). */
	malformedSpecs: readonly { observedTipo: string; spec: unknown }[];
	/** observe entries whose `server` value is PRESENT but not an object
	 * (server:null etc) — malformed authoring: excluded from dispatch, RED.
	 * Zero instances on either live ontology (shape scan 2026-08-02). */
	malformedServerEntries: readonly { observerTipo: string; componentTipo: string }[];
	/** Law-derived edges (pass 3) — listed, not validated as observe entries.
	 * The builder always sets it (and lawShadowed); optional only so the
	 * hand-built diagnostics fixtures that predate pass 3 stay valid. */
	lawDerived?: readonly string[];
	/** Law dependencies a DECLARED edge already covers (declared wins). */
	lawShadowed?: readonly string[];
}

export interface SubscriptionIndex {
	/** observedTipo → subscriptions in dispatch order: forward specs in array
	 * order first (the historical iteration order), then reverse-only. */
	byObserved: ReadonlyMap<string, readonly ObserverSubscription[]>;
	/** Every subscription (the flat edge list, same objects as byObserved). */
	edges: readonly ObserverSubscription[];
	diagnostics: SubscriptionDiagnostics;
}

/**
 * Pre-resolved section facts the PURE builder consumes for host-resolution
 * step 3 (own section + virtual↔real equivalence) — the registry computes
 * them from the live ontology (getAncestorSectionTipo / getSectionRealTipo);
 * the gates pass fixture maps.
 */
export interface HostSectionContext {
	/** observer tipo → its own ontology ancestor section. */
	ownSectionByTipo: ReadonlyMap<string, string>;
	/** section tipo → its REAL section (virtual resolved through
	 * relations[0].tipo; identity for real sections). Missing = identity. */
	realSectionByTipo: ReadonlyMap<string, string>;
}

const EMPTY_HOST_CONTEXT: HostSectionContext = {
	ownSectionByTipo: new Map(),
	realSectionByTipo: new Map(),
};

/** Canonical `observed->observer` key used across the registry and the gates. */
export function observerEdgeKey(edge: { observed: string; observer: string }): string {
	return `${edge.observed}->${edge.observer}`;
}

/**
 * TEST-SCRATCH DIAGNOSTICS CARVE-OUT (named exemption, reason next to the
 * code per the never-narrow law): the observer behavioural gates
 * (observer_cascade/failsafe/seed_native.test.ts) seed throwaway dd_ontology
 * nodes in the `test999…` namespace (tld 'test' scratch, swept per run) and
 * drive dispatch through them — including DELIBERATE cycles that exercise the
 * D2 guard. Those edges dispatch by the same ontology rule as any other (no
 * special activation exists to grant), but they are EXCLUDED from the
 * contract DIAGNOSTICS so a crashed run's residue cannot flip an unrelated
 * gate red — residue cleanup belongs to those suites.
 *
 * SUITE-DB-ONLY: `test` is a REAL tld in production ontologies (currently at
 * test217 in the app DB), so "production never carries test999… tipos" is a
 * hope, not a mechanism. The carve-out therefore applies ONLY when the
 * connected database is the dedicated suite database or one of its shard
 * clones (`isSuiteDatabaseName` — the `_test`-suffix convention
 * test/helpers/test_database.ts pins as the ONE derivation rule). Against any other database a test999… declaration surfaces through
 * the ordinary contract checks. `config.db.database` is frozen at boot, so
 * the predicate is stable for the process lifetime.
 */
export const SCRATCH_OBSERVER_NAMESPACE_PREFIX = 'test999';

/** Does either endpoint sit in the scratch namespace (diagnostics-exclusion
 * form)? False outside the suite DB. */
export function touchesScratchObserverNamespace(observed: string, observer: string): boolean {
	return (
		isSuiteDatabaseName(config.db.database) &&
		(observed.startsWith(SCRATCH_OBSERVER_NAMESPACE_PREFIX) ||
			observer.startsWith(SCRATCH_OBSERVER_NAMESPACE_PREFIX))
	);
}

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const key of Object.keys(value as Record<string, unknown>)) {
			deepFreeze((value as Record<string, unknown>)[key]);
		}
	}
	return value;
}

/**
 * Make a Map RUNTIME-immutable. Object.freeze does not seal Map internals —
 * `.set/.delete/.clear` still mutate a frozen Map — so the mutators are
 * shadowed with throwing own-properties and THEN the freeze locks the shadow
 * in place (nothing can restore the prototype methods). Reads (get/has/
 * iteration) keep their prototype behaviour. Without this, "deep-frozen"
 * would be a type-level claim only (ReadonlyMap), and a consumer casting past
 * it could patch the process-shared index in place — the exact defect class
 * the freeze exists to make loud.
 */
function hardenMap<K, V>(map: Map<K, V>): Map<K, V> {
	const refuse = (): never => {
		throw new DedaloError('internal.invariant', {
			message:
				'observer subscription index is immutable — rebuild on invalidation, never patch (clearObserverSubscriptionRegistry + next read)',
		});
	};
	Object.defineProperties(map, {
		set: { value: refuse },
		delete: { value: refuse },
		clear: { value: refuse },
	});
	return Object.freeze(map);
}

/**
 * THE ONE DISPATCHABILITY PREDICATE: the entry's server block when it is a
 * well-formed object; undefined for an ABSENT server (client-only observer)
 * AND for a malformed non-object value (server:null / a scalar — flagged as a
 * malformedServerEntries RED at build). Every consumer (dispatch, cascade,
 * reconciler, this builder) reads server through this, so a malformed
 * declaration can never reach `server.perform` and throw per save.
 */
export function entryServerBlock(
	entry: ObserveEntry | undefined,
): NonNullable<ObserveEntry['server']> | undefined {
	const server = entry?.server;
	if (server === null || typeof server !== 'object' || Array.isArray(server)) return undefined;
	return server;
}

/** Is this value an SQO object filter (the one server.filter shape that NEEDS
 * a host section — the recompute searches it)? `false` is the written-out
 * terminal no-op, absence is the relay/set_dato_external territory. */
export function isSqoFilter(filter: unknown): filter is Record<string, unknown> {
	return typeof filter === 'object' && filter !== null;
}

/** The section named by an SQO-filter entry's first clause's first path step
 * (`filter.$and[0].path[0].section_tipo` shape, first key generically) — the
 * ontology's own statement of where the referencing records live. */
function sqoFilterPathSection(entry: ObserveEntry | undefined): string | undefined {
	const filter = entryServerBlock(entry)?.filter;
	if (!isSqoFilter(filter)) return undefined;
	const firstKey = Object.keys(filter)[0];
	if (firstKey === undefined) return undefined;
	const clauses = (filter as Record<string, unknown>)[firstKey];
	if (!Array.isArray(clauses)) return undefined;
	const path = (clauses[0] as { path?: unknown } | undefined)?.path;
	if (!Array.isArray(path)) return undefined;
	const section = (path[0] as { section_tipo?: unknown } | undefined)?.section_tipo;
	return typeof section === 'string' && section !== '' ? section : undefined;
}

/** Does this entry's well-formed server block carry an SQO-object filter? */
export function entryHasSqoFilter(entry: ObserveEntry | undefined): boolean {
	return isSqoFilter(entryServerBlock(entry)?.filter);
}

/**
 * THE 4-STEP HOST RESOLUTION (header): entry scope → forward spec → own
 * section (virtual↔real-aware, path-refined) → undefined (refuse downstream).
 */
function resolveHostSection(
	observerTipo: string,
	entry: ObserveEntry | undefined,
	specSection: string | undefined,
	ctx: HostSectionContext,
): string | undefined {
	// 1 — the observe entry's own scope (ontology, on the observer).
	if (typeof entry?.section_tipo === 'string' && entry.section_tipo !== '') {
		return entry.section_tipo;
	}
	// 2 — the forward spec's targeting (the reused-component family). The
	// literal 'self' names no foreign scope — it falls through to step 3 (the
	// observer's own section), which is what 'self' means.
	if (typeof specSection === 'string' && specSection !== '' && specSection !== 'self') {
		return specSection;
	}
	// 3 — the observer's own ontology section, refined by the SQO filter path.
	const own = ctx.ownSectionByTipo.get(observerTipo);
	const pathSection = sqoFilterPathSection(entry);
	if (pathSection !== undefined) {
		if (own === undefined) return pathSection; // nothing to cross-check against
		const realOwn = ctx.realSectionByTipo.get(own) ?? own;
		const realPath = ctx.realSectionByTipo.get(pathSection) ?? pathSection;
		// Virtual↔real equivalence: numisdata5 (virtual) ≡ numisdata276 (real).
		// The PATH's face wins — the referencing records are stored under the
		// section_tipo the filter path names (measured: every numisdata322
		// relation-index row carries numisdata5, none numisdata276).
		if (realOwn === realPath) return pathSection;
		return undefined; // non-equivalent — never silently retarget (step 4)
	}
	return own; // may be undefined → step 4
}

/**
 * PASS 3 of buildSubscriptionIndex (header LAW-DERIVED EDGES): one inverse
 * edge per law dependency of each covered observer node, unless an author
 * declared that key (`declaredKeys`, complete when this runs — a declared edge
 * wins and the key is listed as shadowed). Grows `declaredKeys` (dedup: one
 * derived edge per key) and the two diagnostics lists in place; scratch
 * namespaces stay out of the diagnostics.
 */
function addLawDerivedEdges(
	nodes: readonly NodeWithProperties[],
	declaredKeys: Set<string>,
	/** Pass 1's forward-spec keys: declared too (folded into `declaredKeys` first). */
	forwardKeys: ReadonlySet<string>,
	hostContext: HostSectionContext,
	push: (sub: ObserverSubscription) => void,
	diagnostics: { lawDerived: string[]; lawShadowed: string[] },
): void {
	for (const key of forwardKeys) declaredKeys.add(key);
	for (const node of nodes) {
		if (!isCoveredExternalObserverNode(node)) continue;
		for (const dependency of externalLawDependencies(resolveExternalLaw(node))) {
			addLawDerivedEdge(node, dependency, declaredKeys, hostContext, push, diagnostics);
		}
	}
}

/** One law dependency of one covered observer node (see addLawDerivedEdges). */
function addLawDerivedEdge(
	node: NodeWithProperties,
	dependency: LawDependency,
	declaredKeys: Set<string>,
	hostContext: HostSectionContext,
	push: (sub: ObserverSubscription) => void,
	diagnostics: { lawDerived: string[]; lawShadowed: string[] },
): void {
	const key = observerEdgeKey({ observed: dependency.observed, observer: node.tipo });
	const scratch = touchesScratchObserverNamespace(dependency.observed, node.tipo);
	if (declaredKeys.has(key)) {
		if (!scratch && !diagnostics.lawShadowed.includes(key)) diagnostics.lawShadowed.push(key);
		return;
	}
	declaredKeys.add(key); // one derived edge per key (dedup)
	const entry: ObserveEntry = {
		component_tipo: dependency.observed,
		server: {
			config: { use_inverse_relations: true },
			perform: { function: 'set_dato_external' },
		},
	};
	push({
		observedTipo: dependency.observed,
		observerTipo: node.tipo,
		declaration: 'law-derived',
		origin: 'law',
		via: dependency.via,
		viaWildcard: false,
		entry,
		// The inverse resolver needs no host (its targets come from the
		// relation index through `via`, host-checked per row by the
		// kernel); the own section is kept for the reconciler, like any edge.
		hostSection: resolveHostSection(node.tipo, entry, undefined, hostContext),
	});
	if (!scratch) diagnostics.lawDerived.push(key);
}

/**
 * Build the subscription index from ontology nodes — PURE (nodes + section
 * facts in, frozen index out) so every law is hermetically gateable.
 */
export function buildSubscriptionIndex(
	nodes: readonly NodeWithProperties[],
	hostContext: HostSectionContext = EMPTY_HOST_CONTEXT,
): SubscriptionIndex {
	const byTipo = new Map<string, NodeWithProperties>();
	for (const node of nodes) byTipo.set(node.tipo, node);

	const byObserved = new Map<string, ObserverSubscription[]>();
	const edges: ObserverSubscription[] = [];
	const mirroredServer: string[] = [];
	const reverseOnly: string[] = [];
	const forwardOnly: string[] = [];
	const deadWildcards: string[] = [];
	const wildcardCompiled = new Map<string, string[]>();
	const hostUnresolved: string[] = [];
	const malformedSpecs: { observedTipo: string; spec: unknown }[] = [];
	const malformedServerEntries: { observerTipo: string; componentTipo: string }[] = [];
	const lawDerived: string[] = [];
	const lawShadowed: string[] = [];
	// Every key an author DECLARED (forward spec or observe entry, server or
	// client-only) — the set a law-derived edge may never override (pass 3).
	const declaredKeys = new Set<string>();

	const push = (sub: ObserverSubscription): void => {
		const list = byObserved.get(sub.observedTipo);
		if (list === undefined) byObserved.set(sub.observedTipo, [sub]);
		else list.push(sub);
		edges.push(sub);
	};

	const noteHostUnresolved = (sub: ObserverSubscription): void => {
		// Only the SQO-filter shape NEEDS a host at DISPATCH (the recompute
		// searches it); other shapes target the saved record / the observable
		// data. The reconciler's covered set_dato_external shape also wants a
		// host — its unresolved case is loud+counted at the reconciler skip
		// (observer_reconcile.ts discoverTuples), not RED here.
		if (!entryHasSqoFilter(sub.entry)) return;
		if (sub.hostSection !== undefined) return;
		if (touchesScratchObserverNamespace(sub.observedTipo, sub.observerTipo)) return;
		const key = observerEdgeKey({ observed: sub.observedTipo, observer: sub.observerTipo });
		if (!hostUnresolved.includes(key)) hostUnresolved.push(key);
	};

	// PASS 1 — forward specs. Per observed node, subscriptions keep the specs'
	// ARRAY ORDER (the historical dispatch iteration order).
	const forwardKeys = new Set<string>();
	for (const node of nodes) {
		const specs = (node.properties as { observers?: unknown[] } | null)?.observers;
		if (!Array.isArray(specs)) continue;
		for (const spec of specs) {
			const observerTipo = (spec as { component_tipo?: unknown } | null)?.component_tipo;
			if (typeof observerTipo !== 'string') {
				// Undispatachable spec — surfaced as a diagnostic, never a subscription.
				malformedSpecs.push({ observedTipo: node.tipo, spec });
				continue;
			}
			const key = `${node.tipo}->${observerTipo}`;
			forwardKeys.add(key);
			const specSectionRaw = (spec as { section_tipo?: unknown }).section_tipo;
			const specSection = typeof specSectionRaw === 'string' ? specSectionRaw : undefined;
			const observeEntries = (
				byTipo.get(observerTipo)?.properties as { observe?: ObserveEntry[] } | null | undefined
			)?.observe;
			// THE MATCH LAW (byte-identical to PHP dispatch): first entry in
			// ARRAY ORDER whose component_tipo is the observed tipo or 'all'.
			const entry = Array.isArray(observeEntries)
				? observeEntries.find(
						(candidate) =>
							candidate?.component_tipo === node.tipo || candidate?.component_tipo === 'all',
					)
				: undefined;
			const viaWildcard = entry?.component_tipo === 'all';
			const declaration = entry === undefined ? 'forward-only' : 'mirrored';
			const sub: ObserverSubscription = {
				observedTipo: node.tipo,
				observerTipo,
				declaration,
				origin: 'declared',
				viaWildcard,
				entry,
				hostSection: resolveHostSection(observerTipo, entry, specSection, hostContext),
			};
			push(sub);
			if (touchesScratchObserverNamespace(node.tipo, observerTipo)) continue; // carve-out: excluded from diagnostics
			if (declaration === 'forward-only') {
				if (!forwardOnly.includes(key)) forwardOnly.push(key);
			} else if (entryServerBlock(entry) !== undefined) {
				if (!mirroredServer.includes(key)) mirroredServer.push(key);
				noteHostUnresolved(sub);
			}
			if (viaWildcard) {
				const compiled = wildcardCompiled.get(observerTipo);
				if (compiled === undefined) wildcardCompiled.set(observerTipo, [key]);
				else if (!compiled.includes(key)) compiled.push(key);
			}
		}
	}

	// PASS 2 — reverse-only server declarations (the single-declaration model:
	// these DISPATCH — the defect the whole rebuild closes). The 'all' wildcard
	// NEVER produces edges here: it compiles only through pass-1 forward specs
	// (see the header — the sole residual dependency on the forward array).
	for (const node of nodes) {
		const observeEntries = (node.properties as { observe?: ObserveEntry[] } | null)?.observe;
		if (!Array.isArray(observeEntries)) continue;
		const seen = new Set<string>();
		for (const entry of observeEntries) {
			const observedTipo = entry?.component_tipo;
			if (typeof observedTipo !== 'string') continue;
			const serverBlock = entryServerBlock(entry);
			// MALFORMED SERVER (review 2026-08-02): a `server` value that is
			// present but not an object (server:null / a scalar) can never
			// dispatch — surfaced RED, never silently treated as client-only.
			if (
				entry?.server !== undefined &&
				serverBlock === undefined &&
				!touchesScratchObserverNamespace(observedTipo, node.tipo) &&
				!malformedServerEntries.some(
					(m) => m.observerTipo === node.tipo && m.componentTipo === observedTipo,
				)
			) {
				malformedServerEntries.push({ observerTipo: node.tipo, componentTipo: observedTipo });
			}
			if (observedTipo === 'all') {
				// Dead-wildcard diagnostic: judged by the wildcard's OWN pass-1
				// compiled edge set — an 'all'+server entry that compiled to ZERO
				// edges is dead config even when an earlier exact sibling entry
				// mirrors every forward declarer (first-match law shadows the
				// wildcard) or a reverse-only sibling exists. Only compiled
				// coverage proves the wildcard alive.
				const compiled = wildcardCompiled.get(node.tipo);
				if (
					serverBlock !== undefined &&
					(compiled === undefined || compiled.length === 0) &&
					!touchesScratchObserverNamespace(node.tipo, node.tipo) &&
					!deadWildcards.includes(node.tipo)
				) {
					deadWildcards.push(node.tipo);
				}
				continue;
			}
			const key = `${observedTipo}->${node.tipo}`;
			declaredKeys.add(key);
			// FIRST-MATCH LAW (same law as pass 1 — review 2026-08-02): the FIRST
			// entry in array order owns the observed tipo; a later duplicate never
			// mints, whatever its server presence. Without this, [client-only A,
			// server A] would dispatch reverse-only yet stop dispatching the day a
			// forward spec on A appears (pass-1 first-match picks the client-only
			// entry) — the same declaration pair behaving differently depending on
			// the legacy forward array. Zero duplicate-mixed instances on either
			// live ontology; the rsc36->rsc860 shape (two server duplicates)
			// dispatches from its first entry, as before.
			if (seen.has(key)) continue;
			seen.add(key);
			if (serverBlock === undefined) continue; // client-only observe (or malformed,
			// flagged above): the client subscribes locally; no server edge to register.
			if (forwardKeys.has(key)) continue; // mirrored — already emitted in pass 1
			const sub: ObserverSubscription = {
				observedTipo,
				observerTipo: node.tipo,
				declaration: 'reverse-only',
				origin: 'declared',
				viaWildcard: false,
				entry,
				hostSection: resolveHostSection(node.tipo, entry, undefined, hostContext),
			};
			push(sub);
			if (touchesScratchObserverNamespace(observedTipo, node.tipo)) continue;
			if (!reverseOnly.includes(key)) reverseOnly.push(key);
			noteHostUnresolved(sub);
		}
	}

	// PASS 3 — law-derived edges (header LAW-DERIVED EDGES). Runs after the
	// declared passes so `declaredKeys` is complete: a declared edge wins.
	addLawDerivedEdges(nodes, declaredKeys, forwardKeys, hostContext, push, {
		lawDerived,
		lawShadowed,
	});

	// Cycle scan over the DECLARED (and law-derived) server-edge graph (scratch excluded — those
	// suites plant cycles ON PURPOSE to exercise the D2 guard). The runtime is
	// bounded either way (CascadeGuard); a real-ontology cycle is an authoring
	// error the gate turns red.
	const serverAdjacency = new Map<string, string[]>();
	for (const sub of edges) {
		if (entryServerBlock(sub.entry) === undefined) continue;
		if (touchesScratchObserverNamespace(sub.observedTipo, sub.observerTipo)) continue;
		const list = serverAdjacency.get(sub.observedTipo);
		if (list === undefined) serverAdjacency.set(sub.observedTipo, [sub.observerTipo]);
		else if (!list.includes(sub.observerTipo)) list.push(sub.observerTipo);
	}
	const cycles: string[][] = [];
	const visitState = new Map<string, 'open' | 'done'>();
	const walk = (tipo: string, path: string[]): void => {
		const state = visitState.get(tipo);
		if (state === 'done') return;
		if (state === 'open') {
			const start = path.indexOf(tipo);
			cycles.push([...path.slice(start), tipo]);
			return;
		}
		visitState.set(tipo, 'open');
		for (const next of serverAdjacency.get(tipo) ?? []) walk(next, [...path, tipo]);
		visitState.set(tipo, 'done');
	};
	for (const tipo of serverAdjacency.keys()) walk(tipo, []);

	const index: SubscriptionIndex = {
		byObserved,
		edges,
		diagnostics: {
			mirroredServer,
			reverseOnly,
			forwardOnly,
			deadWildcards,
			wildcardCompiled,
			hostUnresolved,
			cycles,
			malformedSpecs,
			malformedServerEntries,
			lawDerived,
			lawShadowed,
		},
	};
	// Deep-freeze everything reachable AND runtime-harden the two Maps (see
	// hardenMap — Object.freeze alone leaves .set/.delete/.clear working); the
	// subscription objects, entries and diagnostic arrays are frozen
	// recursively. Rebuild on invalidation, never patch.
	hardenMap(byObserved);
	hardenMap(wildcardCompiled);
	for (const list of byObserved.values()) deepFreeze(list);
	deepFreeze(edges);
	deepFreeze(index.diagnostics.mirroredServer);
	deepFreeze(index.diagnostics.reverseOnly);
	deepFreeze(index.diagnostics.forwardOnly);
	deepFreeze(index.diagnostics.deadWildcards);
	for (const compiled of wildcardCompiled.values()) deepFreeze(compiled);
	deepFreeze(index.diagnostics.hostUnresolved);
	deepFreeze(index.diagnostics.cycles);
	deepFreeze(index.diagnostics.malformedSpecs);
	deepFreeze(index.diagnostics.malformedServerEntries);
	deepFreeze(index.diagnostics.lawDerived);
	deepFreeze(index.diagnostics.lawShadowed);
	Object.freeze(index.diagnostics);
	Object.freeze(index);
	return index;
}

/**
 * THE CONTRACT VALIDATOR — every ontology-VALIDITY violation as a message
 * (dead config and authoring errors; there is no activation bookkeeping to
 * check — dispatch is the ontology's decision). Shared verbatim between the
 * runtime build (loud log + counter, never a throw) and the DEC-12 gates.
 * Scratch-namespace edges are excluded by construction (the diagnostics
 * already exclude them).
 */
export function validateSubscriptionContract(index: SubscriptionIndex): string[] {
	const errors: string[] = [];
	const d = index.diagnostics;

	// A forward spec whose named observer has NO matching observe entry is
	// dead config: nothing runs on either side. Fix the ontology (add the
	// observe half, or delete the stale spec) — there is no code pin to hide it.
	for (const key of d.forwardOnly) {
		errors.push(
			`dead config: '${key}' is a forward observers spec with NO matching observe entry on the observer — nothing dispatches; add the observe half or delete the spec`,
		);
	}
	// A server wildcard nobody forward-declares admits zero edges — dead config.
	for (const observer of d.deadWildcards) {
		errors.push(
			`dead 'all' wildcard: observer '${observer}' declares observe component_tipo:'all' with a server block but NO forward spec names it — it admits zero edges`,
		);
	}
	// An SQO-filter edge whose host section resolved to nothing cannot run its
	// search — the dispatch refuses it loudly (step 4); the author must add a
	// section scope (`section_tipo`) to the observe entry.
	for (const key of d.hostUnresolved) {
		errors.push(
			`unresolved host section: SQO-filter edge '${key}' resolves no section to search (no observe-entry section_tipo, no forward-spec section, and the observer's own section does not match the filter path) — add a section scope to the observe entry`,
		);
	}
	// A declared server value that is not an object cannot dispatch —
	// malformed authoring (server:null / a scalar), never silently read as
	// client-only. Zero instances on either live ontology.
	for (const malformed of d.malformedServerEntries) {
		errors.push(
			`malformed declaration: observer '${malformed.observerTipo}' observe entry for '${malformed.componentTipo}' carries a non-object \`server\` value — not dispatchable; make it an object server block, or remove the key for a client-only observer`,
		);
	}
	// ACYCLICITY (measured today: depth 2, zero cycles — a cycle is an
	// authoring error; the runtime D2 guard bounds it, the gate reds it).
	for (const cycle of d.cycles) {
		errors.push(`declared observer graph has a CYCLE: ${cycle.join(' -> ')}`);
	}

	return errors;
}

/** Registry cache — ontology-derived; the invalidation hub clears it after
 * every dd_ontology write (createOntologyCache = registered by construction). */
const registryCache = createOntologyCache<string, SubscriptionIndex>();
const REGISTRY_KEY = 'index';

/** Seed-race build tokens (see getSubscriptionRegistry): planted before the
 * ontology reads, wiped by the same hub fire that clears registryCache — a
 * token that did not survive the build proves a dd_ontology COMMIT superseded
 * what the build read. */
const buildTokenCache = createOntologyCache<string, object>();
const BUILD_TOKEN_KEY = 'building';

/**
 * Named clearer — the module's public invalidation API (the hub-registration
 * convention the completion gate introspects; the factory registration
 * underneath is the structural guarantee, and double-clearing is free).
 * Out-of-band scripts may call it directly after manual dd_ontology surgery.
 */
export function clearObserverSubscriptionRegistry(): void {
	registryCache.clear();
	buildTokenCache.clear();
}
registerOntologyCacheClearer(clearObserverSubscriptionRegistry);

/** Transaction-memo key (postgres.ts getTransactionMemo): one registry build
 * per transaction span instead of one per in-tx call (S1-14-safe — the memo
 * dies with the transaction). */
const TX_MEMO_KEY = Symbol('observer_subscription_registry');

/**
 * The section facts host-resolution step 3 needs, computed from the live
 * ontology for exactly the tipos the build will consult: every observer
 * carrying a server observe entry gets its own ancestor section; every
 * section seen (own sections + SQO filter path sections) gets its virtual→
 * real resolution. Both underlying accessors are cached + hub-cleared.
 */
async function computeHostSectionContext(
	nodes: readonly NodeWithProperties[],
): Promise<HostSectionContext> {
	const observerTipos = new Set<string>();
	const sectionTipos = new Set<string>();
	for (const node of nodes) {
		const observeEntries = (node.properties as { observe?: ObserveEntry[] } | null)?.observe;
		if (!Array.isArray(observeEntries)) continue;
		for (const entry of observeEntries) {
			if (entryServerBlock(entry) === undefined) continue;
			observerTipos.add(node.tipo);
			const pathSection = sqoFilterPathSection(entry);
			if (pathSection !== undefined) sectionTipos.add(pathSection);
		}
	}
	const ownSectionByTipo = new Map<string, string>();
	for (const tipo of observerTipos) {
		const own = await getAncestorSectionTipo(tipo);
		if (own !== null) {
			ownSectionByTipo.set(tipo, own);
			sectionTipos.add(own);
		}
	}
	// getSectionRealTipo is the shared virtual→real helper (PHP
	// get_section_real_tipo_static). Dynamic imports: keep this record-domain
	// module out of the resolve-layer's static graph (the subsystem's
	// established pattern for cross-subsystem lookups). The component registry
	// must be loaded first — getSectionRealTipo resolves models through
	// getModelByTipo, whose alias lookup the registry registers
	// (server/test-preload entrypoints do it; standalone scripts — the
	// reconciler CLI — reach here without it and would throw).
	await import('../../components/registry.ts');
	const { getSectionRealTipo } = await import('../../resolve/security_access_datalist.ts');
	const realSectionByTipo = new Map<string, string>();
	for (const section of sectionTipos) {
		realSectionByTipo.set(section, await getSectionRealTipo(section));
	}
	return { ownSectionByTipo, realSectionByTipo };
}

/**
 * The process-wide subscription registry: cached build over the live ontology.
 * Contract violations are LOUD (log + counter) but never throw — dispatch runs
 * post-commit on user ontologies; the gates are where violations are RED.
 * Logging/counting happens on the OUT-OF-TRANSACTION build only (the
 * build-of-record, the one that may seed the shared cache): in-tx builds are
 * transient per-transaction snapshots — logging them would spam once per
 * imported row on a cold cache, and the same violations reappear on the next
 * out-of-tx build (at latest the boot probe after a restart).
 */
export async function getSubscriptionRegistry(): Promise<SubscriptionIndex> {
	const cached = registryCache.get(REGISTRY_KEY);
	if (cached !== undefined) return cached;
	const inTx = isInTransaction();
	// In-tx: serve this transaction's own memoized build when one exists.
	const txMemo = inTx ? getTransactionMemo() : undefined;
	const memoized = txMemo?.get(TX_MEMO_KEY) as SubscriptionIndex | undefined;
	if (memoized !== undefined) return memoized;
	// Seed-race guard: a concurrent dd_ontology COMMIT between our reads and
	// our cache write fires the hub clearers FIRST — seeding after that would
	// pin a pre-write index until the NEXT ontology write. The token is
	// planted before the reads and wiped by that same hub fire; if it did not
	// survive the build, serve the index to this caller but leave the cache
	// empty so the next read rebuilds fresh.
	const buildToken = {};
	if (!inTx) buildTokenCache.set(BUILD_TOKEN_KEY, buildToken);
	const observedNodes = await getNodesWithProperty('observers');
	const observerNodes = await getNodesWithProperty('observe');
	const byTipo = new Map<string, NodeWithProperties>();
	for (const node of [...observedNodes, ...observerNodes]) byTipo.set(node.tipo, node);
	const nodes = [...byTipo.values()];
	const hostContext = await computeHostSectionContext(nodes);
	const index = buildSubscriptionIndex(nodes, hostContext);
	if (inTx) {
		// S1-14: never seed the shared cache from inside an ambient transaction
		// (the build could have read uncommitted dd_ontology rows). Memoize on
		// the tx-scoped memo instead — one build per transaction, not one per
		// component save inside it.
		txMemo?.set(TX_MEMO_KEY, index);
		// WARM AFTER COMMIT. Every chokepoint write asks "is this key observed?"
		// INSIDE its transaction (the obligation ledger), so a cold cache — cold
		// after EVERY dd_ontology write, the hub clears it — would otherwise stay
		// cold for as long as only in-transaction lookups ask: each curator save
		// paying a full registry build (two dd_ontology scans + host resolution)
		// until some out-of-transaction lookup happened to seed it. The commit lane
		// runs OUTSIDE the transaction, on committed state, so this is the
		// build-of-record, seeded under the same token guard (S1-14-safe). Once
		// per transaction (the memo above short-circuits every later in-tx call);
		// a rolled-back transaction warms nothing, and a failed warm is only a
		// missed optimisation.
		registerCommitAction(async () => {
			try {
				await getSubscriptionRegistry();
			} catch (error) {
				console.error('observer subscription registry: post-commit warm failed:', error);
			}
		});
		return index;
	}
	const errors = validateSubscriptionContract(index);
	if (errors.length > 0) {
		for (const error of errors) {
			console.error(`observer subscription contract violation: ${error}`);
		}
		incrementCounter('observers_registry_contract_violations', errors.length);
	}
	if (buildTokenCache.get(BUILD_TOKEN_KEY) === buildToken) {
		registryCache.set(REGISTRY_KEY, index);
		buildTokenCache.delete(BUILD_TOKEN_KEY);
	}
	return index;
}

/** Dispatch lookup: every declared subscription for one observed tipo (the
 * caller applies the server-presence filter — observers.ts). */
export async function getObserverSubscriptions(
	observedTipo: string,
): Promise<readonly ObserverSubscription[]> {
	const registry = await getSubscriptionRegistry();
	return registry.byObserved.get(observedTipo) ?? [];
}
