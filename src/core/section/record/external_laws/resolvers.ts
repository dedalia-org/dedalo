/**
 * WHICH RECORDS RECOMPUTE, AND WHERE A MIRROR MAY LIVE — the target-resolver
 * table, the host predicate and the law registry of the external-value
 * subsystem (./types.ts).
 *
 * THE RESOLVER TABLE is PHP update_observer_data's config switch (frozen
 * class.component_common.php:2426-2459), CLOSED — the cases are tested in
 * PHP's order and the first match wins:
 *
 *   server.config                                   resolver             targets
 *   use_observable_dato && use_self_section===true  self_and_observable  the saved record + the observable
 *                                                                        saved locators + the removed ones
 *   use_observable_dato && use_self_section===false observable           the observable saved + removed —
 *                                                                        REPLACES a filter result (PHP case b:
 *                                                                        test199 ← test188)
 *   use_inverse_relations===true                    inverse              every record referencing the saved
 *                                                                        one (through the law's pointer when
 *                                                                        it has one), in a section that hosts
 *                                                                        the observer; one per record
 *   anything else, no config included               self                 the saved record (PHP's fallthrough —
 *                                                                        the S7 legends; also
 *                                                                        use_observable_dato WITHOUT
 *                                                                        use_self_section, which no live or
 *                                                                        fixture edge declares)
 *
 * Dispatch requires `perform.function === 'set_dato_external'`. The one other
 * server perform in any ontology, `refresh_data` (rsc1214), is a NAMED
 * exemption (SERVER_SHAPE_EXEMPTIONS) — refused and counted, never guessed. An
 * SQO `filter` next to a resolver that would ADD to its result (self,
 * self_and_observable) is refused too: TS does not run those filters, and a
 * silent drop of the filter's half would narrow the targets. No live edge has
 * that shape (census 2026-10-30).
 *
 * THE HOST PREDICATE: a mirror lives only on records of a section that
 * DECLARES the observer — `observer ∈ declaredSectionComponents(section)`,
 * the one section census the record wipe and the covered-slot birth already
 * share (own ∪ real subtree, nested sections crossed; a term stored under a
 * VIRTUAL catalog section is hosted through its real section). A second
 * census here would drift exactly the way the two it replaced did
 * (critique 1). It keys the inverse resolver per row, the copy laws'
 * candidate sets and the kernel's target precondition.
 */

import { incrementCounter } from '../../../api/counters.ts';
import { isInTransaction } from '../../../db/postgres.ts';
import { createOntologyCache } from '../../../ontology/cache_factory.ts';
import { getNode } from '../../../ontology/resolver.ts';
import { declaredSectionComponents } from '../declared_components.ts';
import { type ClassifiableNode, isStoredExternalLaw, resolveExternalLaw } from './classify.ts';
import {
	expandEquivalenceTargets,
	inverseSearchLaw,
	type ObservableTarget,
} from './inverse_search.ts';
import { observedDataLaw } from './observed_data.ts';
import { sourceOverwriteLaw } from './source_overwrite.ts';
import type {
	ExternalLaw,
	ExternalValueLaw,
	LawDependency,
	RecordAddress,
	StoredExternalLaw,
} from './types.ts';

// ---------------------------------------------------------------------------
// The law registry
// ---------------------------------------------------------------------------

/** The implementation of one classified, stored law (closed switch). */
export function externalValueLawOf(law: StoredExternalLaw): ExternalValueLaw {
	switch (law.kind) {
		case 'inverse_search':
			return inverseSearchLaw as ExternalValueLaw;
		case 'source_overwrite':
			return sourceOverwriteLaw as ExternalValueLaw;
		case 'observed_data':
			return observedDataLaw as ExternalValueLaw;
	}
}

/** A law's derived dependency edges (`[]` for a refusal and for laws (a)/(c)). */
export function externalLawDependencies(law: ExternalLaw): readonly LawDependency[] {
	return isStoredExternalLaw(law) ? externalValueLawOf(law).dependencies(law) : [];
}

/** The pointer an inverse target lookup filters by (undefined = unfiltered). */
export function externalLawPointer(law: StoredExternalLaw): string | undefined {
	return externalValueLawOf(law).pointer(law);
}

// ---------------------------------------------------------------------------
// The resolver table (pure)
// ---------------------------------------------------------------------------

/** An observe entry's `server` block as the table reads it (tolerant: ontology input). */
export interface ObserveServerBlock {
	filter?: unknown;
	config?: {
		use_observable_dato?: unknown;
		use_self_section?: unknown;
		use_inverse_relations?: unknown;
	} | null;
	perform?: { function?: unknown; params?: unknown } | null;
}

export type ObserverTargetResolver = 'self_and_observable' | 'observable' | 'inverse' | 'self';

/** A server shape the table refuses (counted as observers_server_shape_not_covered). */
export interface ServerShapeRefusal {
	readonly refused: true;
	readonly reason: 'perform_not_covered' | 'named_exemption' | 'filter_not_covered';
	readonly detail: string;
	/** The exemption key, for `named_exemption`. */
	readonly exemption?: string;
}

export type ServerShapeClass = { readonly resolver: ObserverTargetResolver } | ServerShapeRefusal;

/**
 * NAMED EXEMPTIONS — server performs that are not external-value laws and
 * stay out of scope, each with its reason (never a bare skip).
 */
export const SERVER_SHAPE_EXEMPTIONS: Readonly<Record<string, string>> = Object.freeze({
	refresh_data:
		'rsc1214 (component_relation_index externals): a refresh of data computed at read time, not a stored mirror — tracked separately (owner ruling 2026-10-30)',
});

function isSqoObjectFilter(filter: unknown): boolean {
	return typeof filter === 'object' && filter !== null;
}

/** The refusal of a perform that is not set_dato_external (named exemption first). */
function refusedPerform(fn: unknown): ServerShapeRefusal {
	if (typeof fn === 'string' && Object.hasOwn(SERVER_SHAPE_EXEMPTIONS, fn)) {
		return {
			refused: true,
			reason: 'named_exemption',
			detail: SERVER_SHAPE_EXEMPTIONS[fn] ?? '',
			exemption: fn,
		};
	}
	return {
		refused: true,
		reason: 'perform_not_covered',
		detail: `server perform '${String(fn)}' is not set_dato_external`,
	};
}

/** PHP's closed config switch, in its case order. */
function resolverOfConfig(
	configBlock: ObserveServerBlock['config'] | undefined,
): ObserverTargetResolver {
	const useObservable = configBlock?.use_observable_dato === true;
	if (useObservable && configBlock?.use_self_section === true) return 'self_and_observable';
	if (useObservable && configBlock?.use_self_section === false) return 'observable';
	if (configBlock?.use_inverse_relations === true) return 'inverse';
	return 'self';
}

/** observable / inverse REPLACE the target list (PHP), so a filter is moot there. */
function filterRefusal(
	resolver: ObserverTargetResolver,
	filter: unknown,
): ServerShapeRefusal | null {
	if ((resolver === 'self' || resolver === 'self_and_observable') && isSqoObjectFilter(filter)) {
		return {
			refused: true,
			reason: 'filter_not_covered',
			detail: `an SQO filter next to the '${resolver}' resolver would ADD its search result to the targets; TS does not run it`,
		};
	}
	return null;
}

/** Classify one server block against the table (pure; see the header). */
export function classifyObserverServerShape(server: ObserveServerBlock): ServerShapeClass {
	const fn = server.perform?.function;
	if (fn !== 'set_dato_external') return refusedPerform(fn);
	const resolver = resolverOfConfig(server.config ?? undefined);
	return filterRefusal(resolver, server.filter) ?? { resolver };
}

/** Log + count one refused server shape (the dispatch's former bare console.error). */
export function reportServerShapeRefusal(
	refusal: ServerShapeRefusal,
	observerTipo: string,
	observedTipo: string,
): void {
	const message = `observer '${observerTipo}' ← '${observedTipo}': server shape not covered (${refusal.reason}) — ${refusal.detail}`;
	if (refusal.reason === 'named_exemption') console.warn(message);
	else console.error(message);
	incrementCounter('observers_server_shape_not_covered');
}

// ---------------------------------------------------------------------------
// The host predicate
// ---------------------------------------------------------------------------

/** section tipo → its declared component tipos (a null-prototype membership record). */
const declaredComponentCache = createOntologyCache<string, Readonly<Record<string, true>>>();

/**
 * Does a record of `sectionTipo` store `componentTipo` by declaration (the
 * one census — see the header)? Cached per ontology version; never seeded
 * from inside a transaction (S1-14).
 */
export async function sectionDeclaresComponent(
	sectionTipo: string,
	componentTipo: string,
): Promise<boolean> {
	let members = declaredComponentCache.get(sectionTipo);
	if (members === undefined) {
		// getSectionRealTipo resolves models through getModelByTipo, whose alias
		// lookup the component registry registers (standalone scripts — the
		// reconciler — reach here without the server's preload).
		await import('../../../components/registry.ts');
		const record: Record<string, true> = Object.create(null);
		for (const component of await declaredSectionComponents(sectionTipo)) {
			record[component.tipo] = true;
		}
		members = Object.freeze(record);
		if (!isInTransaction()) declaredComponentCache.set(sectionTipo, members);
	}
	return members[componentTipo] === true;
}

/** May a mirror of `observerTipo` live on a record of `sectionTipo`? */
export function isObserverHostSection(observerTipo: string, sectionTipo: string): Promise<boolean> {
	return sectionDeclaresComponent(sectionTipo, observerTipo);
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

export interface ResolveObserverTargetsInput {
	observerTipo: string;
	observedTipo: string;
	/** The edge's server block (entryServerBlock — a well-formed object). */
	server: ObserveServerBlock;
	/** The observer's classified, stored law. */
	law: StoredExternalLaw;
	/** The record whose component saved. */
	saved: RecordAddress;
	/** The saved value's target locators (the observable data). */
	observableSaved: readonly ObservableTarget[];
	/** The locators the save removed. */
	observableRemoved: readonly ObservableTarget[];
}

export type ResolveObserverTargetsOutcome =
	| { readonly resolver: ObserverTargetResolver; readonly targets: ObservableTarget[] }
	| ServerShapeRefusal;

/**
 * DETERMINISTIC ACQUISITION ORDER within one propagation (moved from
 * observers.ts). Each recompute takes the target row's FOR UPDATE lock; with
 * the class expansion a single save can touch every class member, and
 * unsorted, two concurrent operations walking the same class from different
 * roots take the same locks in different orders. Total comparator: a
 * non-numeric section_id falls back to a string compare, never NaN.
 */
function sortTargets(targets: ObservableTarget[]): ObservableTarget[] {
	return targets.sort((a, b) => {
		const bySection = String(a.section_tipo).localeCompare(String(b.section_tipo));
		if (bySection !== 0) return bySection;
		const left = Number(a.section_id);
		const right = Number(b.section_id);
		if (Number.isFinite(left) && Number.isFinite(right)) return left - right;
		return String(a.section_id).localeCompare(String(b.section_id));
	});
}

/**
 * THE INVERSE HOST LOOKUP — the one body behind both inverse consumers: the
 * set_dato_external `inverse` resolver below (pointer = the law's) and the
 * observer DEFAULT branch's `use_inverse_relations` relay (observers.ts —
 * pointer = the edge's `via`; the order-derived edges of the portal order
 * model, WC-2026-10-31-portal-order-model). Every record referencing `saved` —
 * through `pointer` when given (exact: only a record whose `pointer` names the
 * saved one can be its host), else through any component (PHP
 * get_inverse_references) — kept only where its section hosts the observer.
 * Uncapped (a capped target list silently skips hosts). One target per record
 * (PHP visited once per referencing LOCATOR). Order = the search's
 * (section_tipo, section_id) — already the deterministic lock order.
 */
export async function inverseHostTargets(
	observerTipo: string,
	saved: RecordAddress,
	pointer: string | undefined,
): Promise<ObservableTarget[]> {
	const { findInverseReferences } = await import('../../../search/search_related.ts');
	const hits = await findInverseReferences(
		[
			{
				section_tipo: saved.section_tipo,
				section_id: saved.section_id,
				...(pointer !== undefined ? { from_component_tipo: pointer } : {}),
			},
		],
		{ limit: false, order: 'section_tipo_section_id' },
	);
	const hostBySection = new Map<string, boolean>();
	const targets: ObservableTarget[] = [];
	const seen = new Set<string>();
	for (const hit of hits) {
		let hosted = hostBySection.get(hit.section_tipo);
		if (hosted === undefined) {
			hosted = await isObserverHostSection(observerTipo, hit.section_tipo);
			hostBySection.set(hit.section_tipo, hosted);
		}
		if (!hosted) continue;
		const key = `${hit.section_tipo}|${hit.section_id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		targets.push({ section_tipo: hit.section_tipo, section_id: hit.section_id });
	}
	return targets;
}

/**
 * The inverse resolver: {@link inverseHostTargets} through the law's pointer
 * (exact: only a record whose pointer names X can have X as its source), else
 * unfiltered.
 */
async function inverseTargets(input: ResolveObserverTargetsInput): Promise<ObservableTarget[]> {
	return inverseHostTargets(input.observerTipo, input.saved, externalLawPointer(input.law));
}

/**
 * The records one save recomputes for one edge (see the header's table). The
 * observable resolvers keep the dispatch's historical behaviour exactly: the
 * removed targets are visited too (only visiting a removed target can drop
 * its dead entry), law (c)'s equivalence-class expansion applies, the list is
 * NOT deduplicated (the guard's recompute set dedups), and the order is the
 * deterministic lock order. A refusal is returned, never thrown — the caller
 * reports it (reportServerShapeRefusal).
 */
export async function resolveObserverTargets(
	input: ResolveObserverTargetsInput,
): Promise<ResolveObserverTargetsOutcome> {
	const shape = classifyObserverServerShape(input.server);
	if ('refused' in shape) return shape;
	const self: ObservableTarget = {
		section_tipo: input.saved.section_tipo,
		section_id: input.saved.section_id,
	};
	switch (shape.resolver) {
		case 'self':
			return { resolver: 'self', targets: [self] };
		case 'inverse':
			return { resolver: 'inverse', targets: sortTargets(await inverseTargets(input)) };
		case 'self_and_observable':
		case 'observable':
			return observableOutcome(input, { resolver: shape.resolver }, self);
	}
}

/** The observable resolvers: saved + removed (+ self), law (c)'s class expansion, the lock order. */
async function observableOutcome(
	input: ResolveObserverTargetsInput,
	shape: { readonly resolver: 'self_and_observable' | 'observable' },
	self: ObservableTarget,
): Promise<ResolveObserverTargetsOutcome> {
	const targets: ObservableTarget[] = [...input.observableSaved, ...input.observableRemoved];
	if (shape.resolver === 'self_and_observable') targets.push(self);
	if (input.law.kind === 'inverse_search') {
		await expandEquivalenceTargets(
			input.law,
			input.observedTipo,
			targets,
			`${input.saved.section_tipo}/${input.saved.section_id}`,
		);
	}
	return { resolver: shape.resolver, targets: sortTargets(targets) };
}

// ---------------------------------------------------------------------------
// Covered (derived-state) observers
// ---------------------------------------------------------------------------

/**
 * Is this node's stored bag DERIVED state (pure)? Its law classifies as a
 * stored law AND some `observe` entry dispatches set_dato_external through a
 * resolvable server shape — the one predicate the dispatch, the reconciler,
 * the duplicate strip and the refresh door share.
 */
export function isCoveredExternalObserverNode(node: ClassifiableNode | null): boolean {
	if (node === null || !isStoredExternalLaw(resolveExternalLaw(node))) return false;
	const observe = (node.properties as { observe?: unknown } | null)?.observe;
	if (!Array.isArray(observe)) return false;
	return observe.some((entry) => {
		const server = (entry as { server?: unknown } | null)?.server;
		if (server === null || typeof server !== 'object' || Array.isArray(server)) return false;
		const block = server as ObserveServerBlock;
		return (
			block.perform?.function === 'set_dato_external' &&
			!('refused' in classifyObserverServerShape(block))
		);
	});
}

/** The live form of isCoveredExternalObserverNode (cached node read). */
export async function isCoveredExternalObserverTipo(tipo: string): Promise<boolean> {
	const node = await getNode(tipo);
	return isCoveredExternalObserverNode(
		node === null ? null : { tipo, properties: node.properties },
	);
}
