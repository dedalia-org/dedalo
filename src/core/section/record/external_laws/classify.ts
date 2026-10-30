/**
 * THE EXTERNAL-LAW CLASSIFIER — the ONE place that decides which value law an
 * observer node's stored bag obeys (see ./types.ts for the three laws).
 *
 * CLOSED AND REFUSING. Every node maps to exactly one stored law or to a
 * refusal; there is no "try the next law". The order of the checks follows
 * PHP set_data_external (frozen class.component_relation_common.php:1793
 * set_observed_data, :1849 source_overwrite, then the default), with the
 * shapes PHP resolved silently turned into named refusals — each one is a
 * WC-ledgered divergence (`WC-2026-10-30-observer-external-value-laws`):
 *   - BOTH sub-laws: PHP takes set_observed_data and never reads the other;
 *     a node declaring both is ambiguous authoring, refused;
 *   - a sub-law next to a top-level `data_from_field` (law (c)'s seed key):
 *     the same ambiguity, refused;
 *   - `source_overwrite` without `component_to_search`: PHP's :1849 needs both
 *     keys and falls through to law (c) otherwise — the provably wrong law for
 *     that node (the numisdata679/965 wipe), refused;
 *   - a `perform.function` outside the closed set: PHP calls whatever method
 *     the ontology names (`call_user_func_array`), refused;
 *   - a malformed scalar `source` (oh55 stores a string, oh90 a number):
 *     refused under the historical `component_to_search_missing` counter.
 *
 * PURE: `resolveExternalLaw` reads only the node it is given, so the gates
 * (test/unit/external_law_classify.test.ts) and the registry tripwire run it
 * over fixture ontologies without a database. `getExternalLaw` is the cached
 * live accessor: one classification per tipo per ontology version
 * (createOntologyCache — the hub clears it after every dd_ontology write), and
 * never seeded from inside a transaction (S1-14: the node read there may be
 * uncommitted). Results are deep-frozen: the cache is process-shared, so a
 * consumer that mutated one would rewrite the law for every request.
 *
 * Counting is the CONSUMER's job (`reportRefusedLaw`): a cached
 * classification is computed once, but each refused recompute is one event.
 */

import { incrementCounter } from '../../../api/counters.ts';
import { LOCATOR_TAG_TYPES } from '../../../components/component_text_area/tag_grammar.ts';
import { isInTransaction } from '../../../db/postgres.ts';
import { createOntologyCache } from '../../../ontology/cache_factory.ts';
import { getNode } from '../../../ontology/resolver.ts';
import type {
	ExternalLaw,
	ExternalLawRefusalReason,
	ObservedDataFunction,
	RefusedLaw,
	StoredExternalLaw,
} from './types.ts';

/**
 * The closed `set_observed_data` function set. `get_locators_of_tags` is the
 * only function any shipped or fixture node names (the S7 legends); anything
 * else is refused, never dispatched by name.
 */
export const OBSERVED_DATA_FUNCTIONS: readonly ObservedDataFunction[] = Object.freeze([
	'get_locators_of_tags',
]);

/** The refused counter + its historical alias (the Phase-0 disarm's name). */
const LAW_REFUSED_COUNTERS = Object.freeze([
	'observers_law_refused',
	'observers_unported_sublaw_refused',
]);
/** law (c) with no pointer keeps the historical counter alone. */
const COMPONENT_TO_SEARCH_MISSING_COUNTERS = Object.freeze([
	'observers_component_to_search_missing',
]);

/** The node shape the classifier reads (an ontology row or a fixture node). */
export interface ClassifiableNode {
	tipo: string;
	properties: unknown;
}

function refused(
	observerTipo: string,
	reason: ExternalLawRefusalReason,
	detail: string,
	counters: readonly string[] = LAW_REFUSED_COUNTERS,
): RefusedLaw {
	return { kind: 'refused', observerTipo, reason, detail, counters };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `component_to_search` as PHP reads it: the first entry of an array, or the scalar. */
function firstComponentToSearch(raw: unknown): string | undefined {
	const first = Array.isArray(raw) ? raw[0] : raw;
	return typeof first === 'string' && first !== '' ? first : undefined;
}

/**
 * The options object PHP hands `get_locators_of_tags`: `perform.params` is
 * spread as the call's argument list when it is an array (`params[0]` is then
 * the options), else wrapped as the one argument.
 */
function performOptions(params: unknown): Record<string, unknown> {
	const options = Array.isArray(params) ? params[0] : params;
	return isPlainObject(options) ? options : {};
}

/**
 * The tag types a `get_locators_of_tags` call reads: `ar_mark_tag` (PHP's
 * own key, class.component_text_area.php:298) ?? `ar_tags` (the key every
 * live and fixture node actually declares — PHP IGNORED it; TS honours it,
 * WC-ledgered) ?? `['svg']` (PHP's default). Undefined = malformed.
 */
function tagsOf(options: Record<string, unknown>): string[] | undefined {
	const raw = options.ar_mark_tag ?? options.ar_tags ?? ['svg'];
	if (!Array.isArray(raw) || raw.length === 0) return undefined;
	if (!raw.every(isLocatorTagType)) return undefined;
	// Deduped, first occurrence wins (Set keeps insertion order).
	return [...new Set<string>(raw)];
}

/** A tag type `get_locators_of_tags` can read a locator payload from. */
function isLocatorTagType(tag: unknown): tag is string {
	return typeof tag === 'string' && LOCATOR_TAG_TYPES.includes(tag);
}

/** The FIRST `set_observed_data` ddo (PHP's loop `return`s after it), when it names a tipo. */
function firstObservedDdo(raw: unknown): Record<string, unknown> | undefined {
	const first = Array.isArray(raw) ? raw[0] : undefined;
	return isPlainObject(first) && typeof first.tipo === 'string' && first.tipo !== ''
		? first
		: undefined;
}

/** Is `fn` a member of the closed `set_observed_data` function set? */
function isObservedDataFunction(fn: unknown): fn is ObservedDataFunction {
	return typeof fn === 'string' && OBSERVED_DATA_FUNCTIONS.includes(fn as ObservedDataFunction);
}

/** Sub-law (a): the FIRST ddo only (PHP's loop `return`s after it). */
function classifyObservedData(observerTipo: string, raw: unknown): ExternalLaw {
	const first = firstObservedDdo(raw);
	if (first === undefined) {
		return refused(
			observerTipo,
			'observed_data_malformed',
			'source.set_observed_data must be a non-empty array whose first ddo names a string tipo',
		);
	}
	const ddoTipo = first.tipo as string;
	const law = (fn: ObservedDataFunction, tags: readonly string[]): StoredExternalLaw => ({
		kind: 'observed_data',
		observerTipo,
		ddoTipo,
		fn,
		tags,
	});
	const perform = first.perform;
	// PHP's no-`perform` branch: the ddo's own get_data(), copied verbatim.
	if (perform === undefined) return law('copy', []);
	const fn = isPlainObject(perform) ? perform.function : undefined;
	if (!isObservedDataFunction(fn)) {
		return refused(
			observerTipo,
			'observed_data_function_unknown',
			`set_observed_data perform.function '${String(fn)}' is outside the closed set [${OBSERVED_DATA_FUNCTIONS.join(', ')}]`,
		);
	}
	const tags = tagsOf(performOptions((perform as { params?: unknown }).params));
	if (tags === undefined) {
		return refused(
			observerTipo,
			'observed_data_tags_invalid',
			`set_observed_data tags must be a non-empty list drawn from [${LOCATOR_TAG_TYPES.join(', ')}]`,
		);
	}
	return law('get_locators_of_tags', tags);
}

/** Sub-law (b): a copy of `data_from_field` on the record the pointer names. */
function classifySourceOverwrite(
	observerTipo: string,
	source: Record<string, unknown>,
): ExternalLaw {
	const overwrite = source.source_overwrite;
	const dataFromField = isPlainObject(overwrite) ? overwrite.data_from_field : undefined;
	if (typeof dataFromField !== 'string' || dataFromField === '') {
		return refused(
			observerTipo,
			'source_overwrite_malformed',
			'source.source_overwrite.data_from_field must be a non-empty string tipo',
		);
	}
	const pointerTipo = firstComponentToSearch(source.component_to_search);
	if (pointerTipo === undefined) {
		return refused(
			observerTipo,
			'source_overwrite_without_component_to_search',
			'source.source_overwrite has no component_to_search pointer (PHP fell through to law (c), the wrong law for this node)',
		);
	}
	return { kind: 'source_overwrite', observerTipo, pointerTipo, dataFromField };
}

/** Law (c), the default: the records whose `component_to_search` references this one. */
function classifyInverseSearch(observerTipo: string, source: Record<string, unknown>): ExternalLaw {
	const componentToSearch = firstComponentToSearch(source.component_to_search);
	if (componentToSearch === undefined) {
		return refused(
			observerTipo,
			'component_to_search_missing',
			'properties.source.component_to_search missing/non-string — law (c) is undefined without it',
			COMPONENT_TO_SEARCH_MISSING_COUNTERS,
		);
	}
	return {
		kind: 'inverse_search',
		observerTipo,
		componentToSearch,
		// Verbatim, like the kernel always passed it (the search validates).
		sectionToSearch: (source.section_to_search ?? 'all') as readonly string[] | 'all',
		dataFromField: source.data_from_field,
	};
}

/** The one sub-law key a source declares: `null` for none, `'both'` when ambiguous. */
function declaredSublaw(
	source: Record<string, unknown>,
): 'set_observed_data' | 'source_overwrite' | 'both' | null {
	const hasObservedData = 'set_observed_data' in source;
	const hasSourceOverwrite = 'source_overwrite' in source;
	if (hasObservedData && hasSourceOverwrite) return 'both';
	if (hasObservedData) return 'set_observed_data';
	return hasSourceOverwrite ? 'source_overwrite' : null;
}

/** A source object, in the closed order: the ambiguities, then (a), (b), (c). */
function classifySource(observerTipo: string, source: Record<string, unknown>): ExternalLaw {
	const sublaw = declaredSublaw(source);
	if (sublaw === 'both') {
		return refused(
			observerTipo,
			'both_sublaws',
			'properties.source declares BOTH set_observed_data and source_overwrite — ambiguous (PHP silently took set_observed_data)',
		);
	}
	if (sublaw !== null && 'data_from_field' in source) {
		return refused(
			observerTipo,
			'sublaw_with_data_from_field',
			`properties.source declares ${sublaw} next to a top-level data_from_field (law (c)'s seed key) — ambiguous`,
		);
	}
	if (sublaw === 'set_observed_data')
		return classifyObservedData(observerTipo, source.set_observed_data);
	if (sublaw === 'source_overwrite') return classifySourceOverwrite(observerTipo, source);
	return classifyInverseSearch(observerTipo, source);
}

/** How a non-object `properties.source` reads in a refusal detail. */
function describeSource(source: unknown): string {
	if (source === undefined) return 'absent';
	return `a ${Array.isArray(source) ? 'array' : typeof source}`;
}

/**
 * Classify ONE node (pure). `node === null` = the tipo has no ontology node.
 * See the header for the closed order and the named refusals.
 */
export function resolveExternalLaw(node: ClassifiableNode | null, tipo?: string): ExternalLaw {
	const observerTipo = node?.tipo ?? tipo ?? '';
	if (node === null) {
		// The historical counter: before the classifier a missing node read as an
		// absent source and was counted as a missing component_to_search.
		return refused(
			observerTipo,
			'node_missing',
			'the observer has no ontology node',
			COMPONENT_TO_SEARCH_MISSING_COUNTERS,
		);
	}
	const source = (node.properties as { source?: unknown } | null)?.source;
	if (!isPlainObject(source)) {
		return refused(
			observerTipo,
			'source_not_object',
			`properties.source is ${describeSource(source)} — no law is defined`,
			COMPONENT_TO_SEARCH_MISSING_COUNTERS,
		);
	}
	return classifySource(observerTipo, source);
}

/** Is this law one that stores a value (not a refusal)? */
export function isStoredExternalLaw(law: ExternalLaw): law is StoredExternalLaw {
	return law.kind !== 'refused';
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

/** Per-ontology-version classification cache (hub-cleared; see the header). */
const externalLawCache = createOntologyCache<string, ExternalLaw>();

/**
 * The live, cached classification of one observer tipo. A `dataFromField`
 * value that is an object is a structuredClone of the node's — the frozen
 * result never aliases the resolver's node cache.
 */
export async function getExternalLaw(tipo: string): Promise<ExternalLaw> {
	const cached = externalLawCache.get(tipo);
	if (cached !== undefined) return cached;
	const node = await getNode(tipo);
	const law = deepFreeze(
		structuredClone(
			resolveExternalLaw(node === null ? null : { tipo, properties: node.properties }, tipo),
		),
	);
	// S1-14: an in-transaction node read may be uncommitted — never seed from it.
	if (!isInTransaction()) externalLawCache.set(tipo, law);
	return law;
}

/**
 * Report one refused recompute: loud log + every counter the refusal names.
 * `where` is the target (`section_tipo/section_id`) or the consumer's label.
 */
export function reportRefusedLaw(law: RefusedLaw, where: string): void {
	console.error(
		`observer '${law.observerTipo}' @ ${where}: external value law REFUSED (${law.reason}) — ${law.detail}; recompute skipped, no law falls back to another`,
	);
	for (const counter of law.counters) incrementCounter(counter);
}
