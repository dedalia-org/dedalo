/**
 * Ontology cache-invalidation hub.
 *
 * The runtime ontology (dd_ontology) is read through many module-level caches,
 * all keyed by CONTENT identity (tipo/lang/scope) — safe in a persistent
 * process until the ontology itself is MUTATED. After any dd_ontology write
 * every one of them can hold a stale row, so all must be dropped.
 *
 * This module is the single chokepoint that does that: each cache-owning
 * module registers its clear function here at load time via
 * `registerOntologyCacheClearer`, and the dd_ontology write layer calls
 * `clearOntologyDerivedCaches` after every write. A module whose cache is
 * empty (never imported) simply never registers — harmless, because an
 * unloaded cache has nothing to invalidate.
 *
 * FACTORY (WS-B): new caches are CREATED via ./cache_factory.ts
 * createOntologyCache, which performs this registration by construction (the
 * audit proved "modules remember to register" nonviable — S1-09). The named
 * clearers below remain each module's public invalidation API and the anchor
 * the completion gate introspects; the factory registration is the structural
 * guarantee underneath. module_state_tripwire fails CI on module-level Map/Set
 * caches declared outside the factory.
 *
 * Registrants (the true list — keep in sync when adding a cache):
 *   ontology/resolver.ts        node / matrix-table / component-filter caches
 *   ontology/labels.ts          per-lang label cache
 *   ontology/section_map.ts     section_map properties cache
 *   ontology/section_id_component.ts  component_section_id lookup cache
 *   db/dd_ontology.ts           active-TLD set
 *   ts_object/term_resolver.ts  term + main-lang caches
 *   resolve/structure_context.ts    structure-context cores
 *   resolve/environment.ts      per-lang UI label dictionaries
 *   resolve/dd_info.ts          thesaurus section_map (parent/term) cache
 *   resolve/relation_index.ts   related_list child-tipos cache
 *   resolve/relation_list.ts    fields_separator cache
 *   resolve/security_access_datalist.ts  children/relations/properties/real-tipo maps
 *   relations/children.ts       section-component-by-model cache
 *   relations/datalist.ts       datalist option lists (also data-derived, S1-11)
 *   relations/filter_projects.ts     authorized-projects cache (also data-derived)
 *   relations/request_config/explicit.ts   hierarchy-sections cache (also data-derived)
 *   section/list_definitions/section_list.ts  cell-map / dataframe-children / own-map
 *   section/record/observer_subscriptions.ts  subscription registry index + seed-race build tokens
 *   area/tree.ts                children-tipo cache
 *   search/search_related.ts    relation-capable table list
 *   diffusion/plan/cache.ts     plan revision bump
 *   diffusion_bridge/diffusion_map.ts    diffusion map + targets caches (S1-10)
 *
 * Import discipline: to stay free of import cycles this module imports ONLY
 * the db transaction primitive (db/postgres.ts, itself a leaf over config/) —
 * never a cache-owning module; registration always points INTO the hub.
 *
 * TRANSACTIONS (S1-14 hardening): a clear fired inside an open transaction is
 * DEFERRED to the transaction's settle point (withTransaction's finally) —
 * clearing mid-tx would let concurrent requests repopulate entries that the
 * pending COMMIT is about to invalidate, and would invite in-tx reads to seed
 * shared caches with uncommitted rows. The only in-tx caller (hierarchy
 * provisioning) needs no mid-tx clears by design: its sole cached in-tx read
 * is the `<tld>0` matrix-table short-circuit in resolver.ts
 * getMatrixTableFromTipo, which is tipo-derived and cache-independent.
 *
 * PHP counterpart: the scatter of `*::clear()` calls plus
 * `diffusion_utils::delete_section_map_cache_file()` and the session
 * `active_elements` reset that every ontology write triggers. (The session
 * active_elements has no TS twin — the tree-area boot payload is uncached — so
 * it is intentionally not represented here.)
 */

import { deferPostTransaction } from '../db/postgres.ts';

type CacheClearer = () => void;

const registeredClearers = new Set<CacheClearer>();

/**
 * Register a cache's clear function with the hub. Idempotent (Set-backed); call
 * once at module load. The clearer must be synchronous and cheap.
 */
export function registerOntologyCacheClearer(clearer: CacheClearer): void {
	registeredClearers.add(clearer);
}

/** Remove a registered clearer (test probes only — production never unregisters). */
export function unregisterOntologyCacheClearer(clearer: CacheClearer): void {
	registeredClearers.delete(clearer);
}

/**
 * Introspection for the registration gates: is this EXACT clear function
 * registered? Modules must therefore register their exported named clearer
 * (not an inline lambda) so the gate can hold them to it.
 */
export function isOntologyCacheClearerRegistered(clearer: CacheClearer): boolean {
	return registeredClearers.has(clearer);
}

/**
 * Bumped by EVERY fire of the clearers. A cache filled after an await (SELECT,
 * then set) may capture it before the await and skip the set when it moved: a
 * build that read the pre-write row must not re-seed a just-cleared cache with
 * it (stale-after-edit until the next ontology write). Same shape as
 * model_section.ts pairingEpoch; single-threaded, compared for equality only.
 * OPT-IN, adopted today by resolver getNode and structure_context buildCore
 * only (TODO-080, gate: test/unit/ontology_generation_guard_native.test.ts);
 * other build-then-set caches still have the race.
 */
let ontologyGeneration = 0;

/** The current invalidation generation (see ontologyGeneration). */
export function currentOntologyGeneration(): number {
	return ontologyGeneration;
}

function fireRegisteredClearers(): void {
	ontologyGeneration++;
	for (const clearer of registeredClearers) {
		try {
			clearer();
		} catch (error) {
			// A broken clearer must neither starve the remaining clearers nor
			// fail the triggering ontology write — log loudly and continue.
			console.error('cache_invalidation: registered clearer failed:', error);
		}
	}
}

/**
 * Drop every ontology-derived cache. Call after ANY dd_ontology mutation
 * (upsert/update/delete/tld-purge/restore) so no reader observes a stale node.
 * Over-invalidation is harmless — caches simply repopulate lazily on next read.
 * Inside a transaction the drop is deferred to COMMIT/ROLLBACK (see header).
 */
export async function clearOntologyDerivedCaches(): Promise<void> {
	if (deferPostTransaction(fireRegisteredClearers)) return;
	fireRegisteredClearers();
}
