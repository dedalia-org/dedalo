/**
 * THE SUBDATUM READ FLOOR OF A SEARCH (closure Step 3, SEC-1;
 * WC-2026-09-30-search-root-step-acl).
 *
 * WHAT IT IS. PHP `common::get_subdatum` floors every component reached THROUGH
 * a component the caller is authorized on to read (1), even when the profile
 * holds 0 on it (`inheritSubdatumPermission`): a portal / autocomplete must
 * show its resolved values and let the user pick, whatever the grant on the
 * target section's own components. The search path's ROOT key
 * (search/conform.ts) would otherwise refuse exactly those searches — an
 * autocomplete that looks a term up by a component its user holds 0 on would
 * answer nothing. The floor is the set of `${section}_${component}` pairs such a
 * search may FILTER and SORT on:
 *
 *   - every ddo of the source component's request_config maps (show / search /
 *     choose / hide), at every section it resolves to;
 *   - every path step its `fixed_filter` names (the pre-applied SQO clauses);
 *   - every `filter_by_list` field (the autocomplete's pre-filter checkboxes).
 *
 * VERIFIED, NEVER TRUSTED. The source arrives in the client's `rqo.source` —
 * TWO independent client strings — and `count` has no Gate A at all, so this
 * module re-asks everything itself. A floor is minted ONLY when all three hold:
 *
 *   1. MEMBERSHIP — `tipo` is a component OF `section_tipo` in the ontology
 *      (`tipoBelongsToSection`, virtual-aware). Without it a caller pairs a
 *      section she can read with ANY component tipo whose request_config names
 *      the field she wants, and the matrix — data, not ontology — may even
 *      hold that stray pair.
 *   2. THE READ DOOR'S PAIR — the section read grant AND the component's own
 *      (`authorizeComponentRead`'s predicate, security/read_door.ts), not the
 *      component level alone.
 *   3. A PROFILE BASIS on both halves (`getPermissionGrant`, GrantBasis) —
 *      never a RULE grant. getPermissions answers dd655 = 2 and dd1324 = 1 for
 *      ANY tipo and any principal; those rules are bounded where they were
 *      written (dd655 by the assembler's owner predicate), and the floor
 *      would carry the grant past that bound into an UNBOUNDED search of the
 *      target section — the SEC-02 prefix oracle again (refuter-surviving S1,
 *      2026-10-01). The superuser basis passes (level 3 everywhere already).
 *
 * The pairs are read off the source's own request_config, never off the client
 * payload. A section source (tipo === section_tipo, a plain list) has no
 * subdatum and no floor. A refused source is not a refusal of the search — it
 * is the ordinary keyed search — so nothing is noted. Gate:
 * test/unit/search_path_acl_native.test.ts ("FORGED SOURCE").
 *
 * THE FLOOR IS THE CALLER'S OWN SUBDATUM MAP — built for THE VERIFIED
 * PRINCIPAL, per call, never cached across principals (refuter-surviving S1,
 * 2026-10-01). PHP get_subdatum floors the ddos of the caller's OWN
 * request_config, and that config is not a pure ontology fact: an IMPLICIT one
 * (no source.request_config — every config-less portal / select /
 * component_filter) keeps only the ddos the principal holds >= 1 on
 * (relations/request_config/implicit.ts filterAuthorizedRelated, which reads
 * the request ALS). A floor cached under a principal-free key therefore served
 * whoever populated it first: the superuser first handed a 0-grant user the
 * search of components her own portal does not show her (the prefix oracle the
 * floor bounds), she first narrowed every later caller's floor. A
 * principal-free build is no fix either: it would PERMANENTLY floor what the
 * implicit builder authorizes away. So the build runs with the request
 * context's principal set to the one this module verified (`asCaller` — in
 * production dispatchRqo seeded that same principal, so it is the identity;
 * a caller outside any scope gets one), and nothing is kept between calls.
 * Gate: search_path_acl_native ("IMPLICIT SOURCE", both population orders).
 *
 * THE CALLER CHAIN (owner decision (f), W4 2026-11-03): a source nested in a
 * cell (tch197 → rsc1400) is floored by its EFFECTIVE config — its own config
 * plus the children its caller injects — when it names its caller instances
 * (`source.callers`) and the chain verifies (relations/caller_chain.ts, the
 * outermost element held by a PROFILE grant). See chainFloorPairsOf. Gate:
 * test/unit/subdatum_permission_native.test.ts (E10). The client names the
 * chain on the autocomplete search of every nested cell (common.js
 * create_callers via build_rqo_search; client gate test_caller_chain.js); a
 * search without one is floored by the element's own map.
 */

import { getModelByTipo, tipoBelongsToSection } from '../ontology/resolver.ts';
import type { ScopedReadFloor } from './frontier_scope.ts';
import { getPermissionGrant, type Principal } from './permissions.ts';
import {
	currentRequestContext,
	type RequestContext,
	runWithRequestContext,
} from './request_context.ts';

/** The client-declared read source, as far as the floor cares. */
export interface ReadFloorSource {
	readonly section_tipo?: unknown;
	readonly tipo?: unknown;
	/** The source element's caller chain (relations/caller_chain.ts) — untrusted. */
	readonly callers?: unknown;
}

/**
 * The floor for one search read, or undefined when there is none: no principal
 * (internal read — nothing is keyed), no component source, or a source the
 * caller holds no read grant on.
 */
export async function subdatumReadFloor(
	principal: Principal | undefined,
	source: ReadFloorSource | undefined,
): Promise<ReadonlySet<string> | undefined> {
	if (principal === undefined) return undefined;
	const coordinates = componentSource(source);
	if (coordinates === null) return undefined;
	if (!(await isComponentTipo(coordinates.tipo))) return undefined;
	if (!(await tipoBelongsToSection(coordinates.tipo, coordinates.sectionTipo))) return undefined;
	// Condition 2 (module header) holds for the CHAINED floor too: a source the
	// profile does not read by its own pair gets NO floor of any kind. The read
	// door refuses such a source at Gate A (dd_core_api.ts gateReadSource — a
	// RAISED nested element, own 0, under a verified chain included), but the
	// generic `count` has no Gate A; minting the chained floor here would let a
	// count answer real totals (a prefix oracle) for a source the read refuses —
	// count and read must decide alike (W4 review, 2026-11-03). DECIDED (owner
	// decision (h), 2026-11-03): a verified chain does NOT raise Gate A — a
	// read-only / raised caller unlocks nothing. What a chain opens is the
	// TARGET search of a component the user can WRITE through it
	// (writer_chain_scope.ts; withScopedPairs below), on both doors alike.
	if (!(await profileReadPair(principal, coordinates.sectionTipo, coordinates.tipo))) {
		return undefined;
	}
	return asCaller(principal, async () => {
		const chained = await chainFloorPairsOf(principal, coordinates, source?.callers);
		const own = await floorPairsOf(coordinates.sectionTipo, coordinates.tipo);
		return chained === null ? own : new Set([...own, ...chained]);
	});
}

/**
 * The floor a SCOPED TARGET SEARCH runs with (owner decision (h),
 * security/writer_chain_scope.ts). On the sections the scope OPENED (the
 * ungranted ones) the filter / order paths are EXACTLY the writer component's
 * `filterPairs` (show + search + choose, plus its declared fixed_filter /
 * filter_by_list paths): every pair the ordinary floor keys on those sections
 * is dropped first — the ordinary floor is built from all four slots, so its
 * HIDE / CHOOSE-only pairs there would otherwise be a predicate oracle over a
 * section the user holds nothing on. Every other section keeps the ordinary
 * floor, unchanged. No scope = the ordinary floor, unchanged.
 *
 * EXCLUSIVE ON THE OPENED SECTIONS: the result is a ScopedReadFloor naming
 * `scope.sections`, so the search's SEC-1 key (search/conform.ts
 * componentReadable, frontier_scope.ts exclusiveFloorVerdict) answers ONLY
 * these pairs there — a metadata tipo, a thesaurus-template component or a
 * component the profile happens to hold a per-tipo grant on is NOT a filter /
 * order path on a section the scope opened (the column side's own rule,
 * section/read.ts scopedColumnLevel). Without that the pair replacement above
 * would bound only the floor, not the key.
 */
export function withScopedPairs(
	floor: ReadonlySet<string> | undefined,
	scope:
		| { readonly sections: ReadonlySet<string>; readonly filterPairs: ReadonlySet<string> }
		| null
		| undefined,
): ReadonlySet<string> | undefined {
	if (scope === null || scope === undefined) return floor;
	const kept = [...(floor ?? [])].filter((pair) => !pairOnSections(pair, scope.sections));
	const scoped: ScopedReadFloor = Object.assign(new Set([...kept, ...scope.filterPairs]), {
		exclusiveSections: new Set(scope.sections),
	});
	return scoped;
}

/** Whether a `${section}_${component}` pair is keyed on one of `sections`. */
function pairOnSections(pair: string, sections: ReadonlySet<string>): boolean {
	for (const section of sections) if (pair.startsWith(`${section}_`)) return true;
	return false;
}

/**
 * THE CHAINED FLOOR (owner decision (f), nested-ddo_map plan E10, W4
 * 2026-11-03): when the source names its caller instances (`callers`) and the
 * chain VERIFIES (relations/caller_chain.ts — the outermost element read by a
 * PROFILE grant, never a rule, every further link a declared data child of the
 * one above), the floor is the source element's EFFECTIVE config as the cell
 * resolved it: its own config with the children its caller injects. So a
 * search by a field only the caller's map names (rsc1400 under tch197 showing
 * X, X not in rsc1400's own map) is floored like the cell shows it — every
 * child of a COMPONENT caller is raised to read (PHP get_subdatum
 * :2564-2571, decision (d)). A child a SECTION caller dropped (STEP 11 — the
 * chain's section root is gated like the section read) is in no effective
 * config, so it is never floored: the floor applies the same (d) rule the
 * cell does. A refused chain floors nothing of its own (null) — never more
 * than no chain.
 *
 * Only a source the profile reads by its OWN pair reaches this (subdatumReadFloor
 * condition 2 — count has no Gate A, so a raised source must not be floored
 * here either); its own floor is always added to the chained one.
 *
 * A SECTION root raises nothing: under a section caller PHP judges a column by
 * its OWN grant (STEP 11; is_component_caller is false, class.common.php
 * :2356/:2564), and the chain's section-root gate (ddoIsAuthorized) accepts a
 * RULE basis. So for a chain rooted at a section, the OUTERMOST COMPONENT —
 * the link right below the section, or the target itself when it is a direct
 * column — must pass the floor's own predicate (a PROFILE read pair, module
 * header step 3), exactly as an unchained source does; else nothing is
 * floored (null).
 */
async function chainFloorPairsOf(
	principal: Principal,
	coordinates: { sectionTipo: string; tipo: string },
	callers: unknown,
): Promise<ReadonlySet<string> | null> {
	if (callers === undefined || callers === null) return null;
	const { currentDataLang } = await import('../resolve/request_lang.ts');
	const lang = currentDataLang();
	const { resolveCallerChain } = await import('../relations/caller_chain.ts');
	const chain = await resolveCallerChain({
		callers,
		targetTipo: coordinates.tipo,
		targetSectionTipo: coordinates.sectionTipo,
		lang,
		principal,
		authorizeRoot: (sectionTipo, tipo) => profileReadPair(principal, sectionTipo, tipo),
	});
	if (chain === null) return null;
	if (!(await sectionRootedChainHeld(principal, callers, coordinates))) return null;
	const node = await chainedSourceNode(chain, coordinates.sectionTipo, lang);
	const pairs = new Set<string>();
	for (const item of node.effectiveConfig) addItemDdoPairs(pairs, item as unknown as ConfigItem);
	const { getEffectivePropertiesByTipo } = await import('../ontology/alias.ts');
	addDeclaredFilterPairs(pairs, await getEffectivePropertiesByTipo(coordinates.tipo));
	return pairs;
}

/**
 * For a VERIFIED chain rooted at a SECTION (`{tipo: S, section_tipo: S}`): the
 * outermost component (the second link, else the target) holds a PROFILE read
 * pair (chainFloorPairsOf). A component-rooted chain already passed it as its
 * root (authorizeRoot) — true.
 */
async function sectionRootedChainHeld(
	principal: Principal,
	callers: unknown,
	target: { sectionTipo: string; tipo: string },
): Promise<boolean> {
	// The chain verified, so its shape is the parsed one (caller_chain.ts step 1).
	const links = callers as readonly { tipo: string; section_tipo: string }[];
	const root = links[0];
	if (root === undefined || root.tipo !== root.section_tipo) return true;
	const outermost = links[1];
	return outermost === undefined
		? profileReadPair(principal, target.sectionTipo, target.tipo)
		: profileReadPair(principal, outermost.section_tipo, outermost.tipo);
}

/**
 * Run `fn` with the request context's principal = the VERIFIED principal, so
 * every ALS reader in the request_config build (the implicit per-user drop)
 * answers for the caller whose floor this is. The ambient context already
 * carrying that principal (dispatchRqo seeds it) is used as is; otherwise a
 * derived one keeps the request's id / session / ip and forwards the ONE
 * mutable field (frontierRefusals) to the ambient context, so a refusal noted
 * inside still reaches the request's notices.
 */
function asCaller<T>(principal: Principal, fn: () => Promise<T>): Promise<T> {
	const ambient = currentRequestContext();
	if (ambient?.principal === principal) return fn();
	const derived: RequestContext = {
		principal,
		session: ambient?.session ?? null,
		requestId: ambient?.requestId ?? '',
		clientIp: ambient?.clientIp ?? '',
		get frontierRefusals() {
			return ambient?.frontierRefusals;
		},
		set frontierRefusals(refusals) {
			if (ambient !== undefined) ambient.frontierRefusals = refusals;
		},
	};
	return runWithRequestContext(derived, fn);
}

/**
 * The read door's pair (section read grant, then the component's own), each
 * answered by the caller's PROFILE (or the superuser), never by a rule — see
 * the module header, step 3.
 */
async function profileReadPair(
	principal: Principal,
	sectionTipo: string,
	tipo: string,
): Promise<boolean> {
	for (const pairTipo of [sectionTipo, tipo]) {
		const grant = await getPermissionGrant(principal, sectionTipo, pairTipo);
		if (grant.level < 1 || grant.basis === 'rule') return false;
	}
	return true;
}

/** (section, component) of a component source, or null for anything else. */
function componentSource(
	source: ReadFloorSource | undefined,
): { sectionTipo: string; tipo: string } | null {
	const sectionTipo = source?.section_tipo;
	const tipo = source?.tipo;
	if (typeof sectionTipo !== 'string' || sectionTipo === '') return null;
	if (typeof tipo !== 'string' || tipo === '' || tipo === sectionTipo) return null;
	return { sectionTipo, tipo };
}

async function isComponentTipo(tipo: string): Promise<boolean> {
	const model = await getModelByTipo(tipo);
	return typeof model === 'string' && model.startsWith('component_');
}

/**
 * The pair set of one component source's request_config, as built for the
 * principal in scope (see `asCaller`). Never cached: the value is
 * principal-dependent (module header).
 */
async function floorPairsOf(sectionTipo: string, tipo: string): Promise<ReadonlySet<string>> {
	const pairs = new Set<string>();
	const { getEffectivePropertiesByTipo } = await import('../ontology/alias.ts');
	const properties = await getEffectivePropertiesByTipo(tipo);
	const { buildRequestConfigForElement } = await import('../relations/request_config/build.ts');
	const items = await buildRequestConfigForElement(properties ?? null, {
		ownerTipo: tipo,
		ownerSectionTipo: sectionTipo,
		mode: 'edit',
		ownerIsSection: false,
	});
	for (const item of items) addItemDdoPairs(pairs, item);
	addDeclaredFilterPairs(pairs, properties);
	return pairs;
}

/**
 * The source element's node UNDER its verified caller — the cell's node: the
 * caller's line governs it (its mode: a nested line declares one, else 'list',
 * the mode PHP forces under a non-section caller).
 */
async function chainedSourceNode(
	chain: import('../relations/caller_chain.ts').VerifiedCallerChain,
	sectionTipo: string,
	lang: string,
): Promise<import('../relations/element_registry.ts').ElementNode> {
	const { resolveElement } = await import('../relations/element_node.ts');
	const { ElementNodeRegistry } = await import('../relations/element_registry.ts');
	const declaredMode = chain.line.mode;
	return resolveElement({
		ddo: chain.line as unknown as import('../concepts/ddo.ts').Ddo,
		parentNode: chain.parentNode,
		ownerSectionTipo: sectionTipo,
		mode: typeof declaredMode === 'string' && declaredMode !== '' ? declaredMode : 'list',
		lang,
		registry: new ElementNodeRegistry(),
	});
}

type ConfigItem = Awaited<
	ReturnType<typeof import('../relations/request_config/build.ts').buildRequestConfigForElement>
>[number];

const DDO_MAPS = ['show', 'search', 'choose', 'hide'] as const;

/** One request_config slot a pair set may be read off. */
export type ConfigSlotName = (typeof DDO_MAPS)[number];

/**
 * The `${section}_${component}` pairs of the named slots of a config (every
 * ddo, at every section it resolves to — a declared section, else the item's
 * sqo targets). Shared with security/writer_chain_scope.ts, whose scoped
 * searches are limited to the SHOW + SEARCH slots of a writer component's
 * effective config (owner decision (h)).
 */
export function slotPairsOf(
	config: readonly unknown[],
	slots: readonly ConfigSlotName[],
): Set<string> {
	const pairs = new Set<string>();
	for (const item of config) addItemDdoPairs(pairs, item as ConfigItem, slots);
	return pairs;
}

/**
 * The declared `fixed_filter` path steps and `filter_by_list` fields of a
 * component's properties (see addDeclaredFilterPairs) as a fresh set.
 */
export function declaredFilterPairsOf(properties: unknown): Set<string> {
	const pairs = new Set<string>();
	addDeclaredFilterPairs(pairs, properties);
	return pairs;
}

/** Every ddo of one config item's maps (all four, or `slots`), at every section it resolves to. */
function addItemDdoPairs(
	pairs: Set<string>,
	item: ConfigItem,
	slots: readonly ConfigSlotName[] = DDO_MAPS,
): void {
	const targets = itemTargets(item);
	for (const mapName of slots) {
		const ddos = item[mapName]?.ddo_map;
		if (!Array.isArray(ddos)) continue;
		for (const ddo of ddos) addDdoPairs(pairs, ddo, targets);
	}
}

/** The item's resolved sqo target sections (flat tipos). */
function itemTargets(item: ConfigItem): string[] {
	// `sqo?.`: a caller-only effective config (relations/element_node.ts NO OWN
	// CONFIG AT ALL) carries no sqo, so it names no target section.
	return ((item.sqo as ConfigItem['sqo'] | undefined)?.section_tipo ?? [])
		.map((entry) => (typeof entry === 'string' ? entry : entry?.tipo))
		.filter((tipo): tipo is string => typeof tipo === 'string' && tipo !== '');
}

function addDdoPairs(
	pairs: Set<string>,
	ddo: { tipo?: unknown; section_tipo?: unknown },
	targets: readonly string[],
): void {
	if (typeof ddo.tipo !== 'string' || ddo.tipo === '') return;
	for (const sectionTipo of ddoSections(ddo.section_tipo, targets)) {
		pairs.add(`${sectionTipo}_${ddo.tipo}`);
	}
}

/** A ddo's sections: its declared string / list; absent or 'self' = the item's targets. */
function ddoSections(declared: unknown, targets: readonly string[]): readonly string[] {
	if (typeof declared === 'string') return declared === 'self' ? targets : [declared];
	if (Array.isArray(declared)) {
		return declared.filter((tipo): tipo is string => typeof tipo === 'string' && tipo !== '');
	}
	return targets;
}

/**
 * The `fixed_filter` path steps and `filter_by_list` fields, read off the RAW
 * declaration: the expanded forms depend on record data (a component_data
 * fixed_filter resolves nothing without its caller record), the declared paths
 * do not.
 */
function addDeclaredFilterPairs(pairs: Set<string>, properties: unknown): void {
	for (const sqo of declaredSqos(properties)) {
		collectPathPairs(pairs, (sqo as { fixed_filter?: unknown }).fixed_filter);
		collectFieldPairs(pairs, (sqo as { filter_by_list?: unknown }).filter_by_list);
	}
}

/** The raw `source.request_config[].sqo` objects of a node's properties. */
function declaredSqos(properties: unknown): object[] {
	const config = (properties as { source?: { request_config?: unknown } } | null)?.source
		?.request_config;
	if (!Array.isArray(config)) return [];
	return config
		.map((item) => (item as { sqo?: unknown } | null)?.sqo)
		.filter((sqo): sqo is object => sqo !== null && typeof sqo === 'object');
}

/** Every `{section_tipo, component_tipo}` step of every `path` array under `value`. */
function collectPathPairs(pairs: Set<string>, value: unknown): void {
	if (value === null || typeof value !== 'object') return;
	const entries = Array.isArray(value)
		? value.map((entry) => ['', entry] as const)
		: Object.entries(value);
	for (const [key, entry] of entries) collectEntryPairs(pairs, key, entry);
}

/** One key/value of a declaration: a `path` list is harvested, anything else walked. */
function collectEntryPairs(pairs: Set<string>, key: string, entry: unknown): void {
	if (key === 'path' && Array.isArray(entry)) collectFieldPairs(pairs, entry);
	else collectPathPairs(pairs, entry);
}

/** `{section_tipo, component_tipo}` entries of a list. */
function collectFieldPairs(pairs: Set<string>, list: unknown): void {
	if (!Array.isArray(list)) return;
	for (const step of list) {
		const { section_tipo: sectionTipo, component_tipo: componentTipo } = (step ?? {}) as {
			section_tipo?: unknown;
			component_tipo?: unknown;
		};
		if (typeof sectionTipo === 'string' && typeof componentTipo === 'string') {
			pairs.add(`${sectionTipo}_${componentTipo}`);
		}
	}
}
