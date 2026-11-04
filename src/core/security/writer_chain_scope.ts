/**
 * THE WRITER-COMPONENT SCOPE — owner decisions (h) and (i) of the nested-ddo_map
 * plan (round 4, 2026-11-03), both DIVERGENCES FROM PHP (WC-2026-11-04-writer-chain-scoped-search,
 * WC-2026-11-04-tree-picker-read-gate-retired).
 *
 * THE PROBLEM. PHP get_subdatum raises every child of a component caller to
 * read (class.common.php:2556-2571) so that a user "will be able to search with
 * autocomplete, to assign data" — yet the read door refuses any sqo section the
 * user holds < 1 on (class.dd_core_api.php:2131-2153, Gate B), and the TS tree
 * picker additionally pruned / refused the thesaurus the user holds no grant on.
 * End to end, a cataloguer who may WRITE `rsc91` (a toponym autocomplete) READ
 * the term it holds but could not SEARCH the toponymy to pick one, nor browse
 * the tree picker of a `view:'tree'` thesaurus component.
 *
 * THE DECISION. A read of a target section the user holds NO grant on is
 * allowed for EXACTLY ONE use: picking a value into a component the user can
 * WRITE. It is scoped, never a grant:
 *
 *   - (h) a search of the target section (the autocomplete) is admitted ONLY
 *     when the request names the component's caller chain (`source.callers`,
 *     relations/caller_chain.ts) and the chain VERIFIES, the component at its
 *     end holds WRITE (>= 2) through that chain, and its EFFECTIVE config (own
 *     config + whatever its caller injects — the cell's node) targets every
 *     ungranted section of the sqo — EXACTLY (scopeTargetsSection: never the
 *     virtual ↔ real equivalence the LINK law uses). The search's COLUMNS are
 *     limited to what that config SHOWS, SEARCHES and offers to CHOOSE
 *     (`columnPairs` — the autocomplete renders choose → search → show), and
 *     its FILTER / ORDER paths on the opened sections to those same pairs plus
 *     the config's declared fixed_filter / filter_by_list paths (`filterPairs`
 *     — security/read_floor.ts withScopedPairs REPLACES the ordinary floor's
 *     pairs on those sections, so a HIDE-slot pair is never a filter path
 *     there). The rows carry those columns only, stamped read (1): every
 *     relation element of the read expands ONE level (its children from the
 *     column map, never its own config — resolve/component_data.ts
 *     EmissionContext.callerChildrenOnly) and the subdatum raise reaches the
 *     config's pairs only (section/node_permissions.ts NodeLevelPolicy.raises).
 *   - (i) the tree picker of a `view:'tree'` component browses its target
 *     thesaurus read-only under the same conditions (area/read.ts + the tree
 *     node doors, ts_object/ts_api.ts), and the save door no longer re-judges
 *     the target section (relations/save.ts — the write twin was retired).
 *     EVERY node a tree door builds is gated by its own section (a client
 *     children list included), the area search's sections likewise
 *     (area/read.ts confineTreeSearch), and a NESTED picker's `view` is read
 *     from its verified chain line (verifiedChainLineView).
 *
 * A READ-ONLY caller does not unlock anything: the level is computed along the
 * chain exactly as PHP stamps it (inheritSubdatumPermission — a level-0
 * component raised to 1 is read-only, a component under a read-only caller is
 * capped at 1), and every component's own level is asked with its AUTHORITY:
 * a RULE basis is not a write grant here (the dd655 / dd1324 rules answer for
 * any tipo; they are bounded where they were written — the read floor's and
 * the picker grant's law, security/read_floor.ts, area/read.ts), and a
 * component of a CONSULTATION-ONLY section (dd15 / dd542) is capped at read
 * exactly as the read and save doors cap it (concepts/section.ts).
 *
 * NO CHAIN, NO SCOPE: a request without `source.callers`, or whose chain is
 * refused, gets exactly the pre-(h) answer (Gate B's perm.denied). The client
 * names the chain on every autocomplete search and every picker read
 * (common.js create_search_callers; component_portal picker_caller).
 *
 * v5-FALLBACK COMPONENTS (decision (j), exact PHP): a config-less component
 * (its own IMPLICIT config — request_config/implicit.ts, whose STEP 5 drops the
 * related tipos the user holds 0 on but KEEPS the sqo target) opens NO scope:
 * PHP's Gate B refuses its target search and nothing here widens it (no
 * search, no count, no tree). Likewise a config naming NO column pair on a
 * target section opens nothing for that section: a scope never admits rows
 * it could not show a single column of.
 *
 * Gate: test/unit/subdatum_permission_native.test.ts ((h) and (i) describes).
 */

import type { Ddo } from '../concepts/ddo.ts';
import { isConsultationOnlySection } from '../concepts/section.ts';
import type { ElementNode } from '../relations/element_registry.ts';
import { getPermissionGrant, inheritSubdatumPermission, type Principal } from './permissions.ts';

/** What a verified writer-component scope opens (one read, one principal). */
export interface WriterChainScope {
	/** The component's node under its verified chain (its EFFECTIVE config). */
	readonly node: ElementNode;
	/**
	 * The sections the component's effective config targets (its sqo, dedalo
	 * items) AND shows at least one column pair on — a target it shows nothing
	 * of is never opened (module header, decision (j)).
	 */
	readonly targets: readonly string[];
	/**
	 * `${section}_${component}` pairs the component's effective config SHOWS,
	 * SEARCHES or offers to CHOOSE (show + search + choose slots — never hide):
	 * the COLUMNS a scoped read may serve.
	 */
	readonly columnPairs: ReadonlySet<string>;
	/**
	 * columnPairs plus the config's declared fixed_filter / filter_by_list
	 * paths: the FILTER / ORDER paths a scoped read may use on the sections it
	 * opened (security/read_floor.ts withScopedPairs). A declared filter path is
	 * never a column.
	 */
	readonly filterPairs: ReadonlySet<string>;
}

/** The component a scope is asked for, and the chain the client says it sits in. */
export interface WriterChainRequest {
	readonly tipo: string;
	readonly sectionTipo: string;
	/** `rqo.source.callers` (or the picker caller's `callers`) — untrusted. */
	readonly callers: unknown;
	readonly lang: string;
}

/** The write level the scope demands (PHP: an edit affordance is level 2). */
const WRITE_LEVEL = 2;

/** The slots whose pairs are a scoped read's COLUMNS (module header — never hide). */
const COLUMN_SLOTS = ['show', 'search', 'choose'] as const;

/**
 * The component's level THROUGH its verified chain (module header): the
 * outermost component's own level, then each further component — the target
 * last — inherited from the one above it (PHP :2564-2571). A rule-basis grant
 * counts as read (1 — never a write grant, and a read-only caller caps what
 * it reaches); a component of a consultation-only section
 * is capped at read (the read / save doors' cap — module header). A section
 * root contributes nothing (under a section caller a column is judged by its
 * own grant, STEP 11).
 */
async function chainedLevel(
	principal: Principal,
	links: readonly { tipo: string; section_tipo: string }[],
): Promise<number> {
	let level: number | null = null;
	for (const link of links) {
		const own = await ownWriteLevel(principal, link);
		level = level === null ? own : inheritSubdatumPermission(own, level);
	}
	return level ?? 0;
}

/**
 * One link's OWN level as a write authority: rule basis → at most 1 (READ — a
 * rule is never a write grant, W4b review), consultation-only → at most 1.
 * NOT 0: a rule-READ chain ROOT (a public-list section, dd1324, the dd15 TM
 * floor) IS read at 1, and PHP caps every child under a level-1 caller at 1
 * (class.common.php:2569-2571 — inheritSubdatumPermission's cap fires only on
 * a caller at exactly 1). Seeding such a root at 0 skipped that cap and let a
 * profile-2 component nested under it count as a writer. Exported for its gate
 * (subdatum_permission_native: the two caps against the raw grant).
 */
export async function ownWriteLevel(
	principal: Principal,
	link: { tipo: string; section_tipo: string },
): Promise<number> {
	const grant = await getPermissionGrant(principal, link.section_tipo, link.tipo);
	if (grant.basis === 'rule' || isConsultationOnlySection(link.section_tipo)) {
		return Math.min(grant.level, 1);
	}
	return grant.level;
}

/**
 * The COMPONENT links of a verified chain, the target appended (a section
 * root — `{tipo: S, section_tipo: S}` — is skipped). The chain verified, so its
 * shape is the parsed one (caller_chain.ts step 1).
 */
function componentLinksOf(
	callers: unknown,
	target: { tipo: string; sectionTipo: string },
): { tipo: string; section_tipo: string }[] {
	const links = (callers as readonly { tipo: string; section_tipo: string }[]).filter(
		(link, index) => !(index === 0 && link.tipo === link.section_tipo),
	);
	return [
		...links.map((link) => ({ tipo: link.tipo, section_tipo: link.section_tipo })),
		{ tipo: target.tipo, section_tipo: target.sectionTipo },
	];
}

/** The node of the component under its verified caller (the cell's node — read_floor chainedSourceNode's rule). */
async function chainedComponentNode(
	chain: import('../relations/caller_chain.ts').VerifiedCallerChain,
	request: WriterChainRequest,
): Promise<ElementNode> {
	const { resolveElement } = await import('../relations/element_node.ts');
	const { ElementNodeRegistry } = await import('../relations/element_registry.ts');
	const declaredMode = chain.line.mode;
	return resolveElement({
		ddo: chain.line as unknown as Ddo,
		parentNode: chain.parentNode,
		ownerSectionTipo: request.sectionTipo,
		mode: typeof declaredMode === 'string' && declaredMode !== '' ? declaredMode : 'list',
		lang: request.lang,
		registry: new ElementNodeRegistry(),
	});
}

/** The dedalo target sections of an effective config. */
async function dedaloTargetsOf(node: ElementNode): Promise<string[]> {
	const { extractSqoSectionTipos } = await import('../relations/request_config/explicit.ts');
	const { engineOf } = await import('../relations/request_config/engine_select.ts');
	return [
		...new Set(
			node.effectiveConfig
				.filter((item) => engineOf(item as never) === 'dedalo')
				.flatMap((item) =>
					extractSqoSectionTipos(item as unknown as Parameters<typeof extractSqoSectionTipos>[0]),
				),
		),
	];
}

/** The scope's two pair sets (WriterChainScope.columnPairs / filterPairs). */
async function scopePairsOf(
	node: ElementNode,
	properties: unknown,
): Promise<{ columnPairs: Set<string>; filterPairs: Set<string> }> {
	const { slotPairsOf, declaredFilterPairsOf } = await import('./read_floor.ts');
	const columnPairs = slotPairsOf(node.effectiveConfig, COLUMN_SLOTS);
	const filterPairs = new Set([...columnPairs, ...declaredFilterPairsOf(properties)]);
	return { columnPairs, filterPairs };
}

/**
 * Decision (j): the node's config is the v5 IMPLICIT fallback — its OWN config
 * (nothing injected by the caller), built from properties that declare no
 * source.request_config (concepts/request_config.ts selectRequestConfigStrategy,
 * the builder's own selection rule).
 */
async function isImplicitFallback(node: ElementNode, properties: unknown): Promise<boolean> {
	if (node.configSource !== 'own' || node.injected) return false;
	const { selectRequestConfigStrategy } = await import('../concepts/request_config.ts');
	return selectRequestConfigStrategy(properties) === 'implicit';
}

/** Whether `pairs` holds a pair on `sectionTipo` (a `${section}_${component}` key). */
function pairsShowSection(pairs: ReadonlySet<string>, sectionTipo: string): boolean {
	const prefix = `${sectionTipo}_`;
	for (const pair of pairs) if (pair.startsWith(prefix)) return true;
	return false;
}

/**
 * The writer-component scope (module header), or null: no chain, a refused
 * chain, a component the principal cannot WRITE through it, a v5 implicit
 * config (decision (j)), or a config that shows nothing of any target. Every
 * fact is re-derived on the server; nothing is cached (the answer is
 * principal-dependent).
 */
export async function resolveWriterChainScope(
	principal: Principal,
	request: WriterChainRequest,
): Promise<WriterChainScope | null> {
	const chain = await verifiedChainOf(principal, request);
	if (chain === null) return null;
	const level = await chainedLevel(principal, componentLinksOf(request.callers, request));
	if (level < WRITE_LEVEL) return null;
	const node = await chainedComponentNode(chain, request);
	const { getEffectivePropertiesByTipo } = await import('../ontology/alias.ts');
	const properties = await getEffectivePropertiesByTipo(request.tipo);
	if (await isImplicitFallback(node, properties)) return null;
	const { columnPairs, filterPairs } = await scopePairsOf(node, properties);
	const targets = (await dedaloTargetsOf(node)).filter((target) =>
		pairsShowSection(columnPairs, target),
	);
	if (targets.length === 0) return null;
	return { node, targets, columnPairs, filterPairs };
}

/** The request names a component of its section (the ontology's membership law). */
async function isSectionComponent(request: WriterChainRequest): Promise<boolean> {
	const { getModelByTipo, tipoBelongsToSection } = await import('../ontology/resolver.ts');
	const model = await getModelByTipo(request.tipo);
	if (model === null || !model.startsWith('component_')) return false;
	return tipoBelongsToSection(request.tipo, request.sectionTipo);
}

/** The request's caller chain, VERIFIED (relations/caller_chain.ts), or null: none named, not a component, refused. */
async function verifiedChainOf(
	principal: Principal,
	request: WriterChainRequest,
): Promise<import('../relations/caller_chain.ts').VerifiedCallerChain | null> {
	if (request.callers === undefined || request.callers === null) return null;
	if (!(await isSectionComponent(request))) return null;
	const { resolveCallerChain } = await import('../relations/caller_chain.ts');
	return resolveCallerChain({
		callers: request.callers,
		targetTipo: request.tipo,
		targetSectionTipo: request.sectionTipo,
		lang: request.lang,
		principal,
	});
}

/**
 * The `view` the VERIFIED caller chain's governing line gives the component
 * (`chain.line.view`), or null: no chain, a refused chain, or a line that
 * declares no view. A component NESTED in another component's cell gets its
 * `view:'tree'` from its caller's ddo line, never from its own section's map
 * (area/read.ts resolvePickerCaller asks this first, then the section map).
 * Read from the server-verified line only — never from the request.
 */
export async function verifiedChainLineView(
	principal: Principal,
	request: WriterChainRequest,
): Promise<string | null> {
	const chain = await verifiedChainOf(principal, request);
	const view = chain?.line.view;
	return typeof view === 'string' && view !== '' ? view : null;
}

/**
 * Whether `sectionTipo` is one of the scope's targets — an EXACT match. The
 * scope decides an UNGRANTED READ, so it never borrows the virtual ↔ real
 * equivalence of the LINK law (relations/picker_constraint.ts isTargetAllowed):
 * a config targeting a virtual section does not open its real section, and a
 * config targeting a real section does not open the virtuals over it (their
 * column pairs are keyed on the configured section only).
 */
export function scopeTargetsSection(
	scope: Pick<WriterChainScope, 'targets'>,
	sectionTipo: string,
): boolean {
	return scope.targets.includes(sectionTipo);
}

/**
 * (h) A SCOPED TARGET SEARCH: the sqo sections the principal holds no read
 * grant on, opened ONLY through the source component's writer scope. Built at
 * the read / count door (api/handlers/dd_core_api.ts gateReadTargets) and
 * threaded to the section read (section/read.ts) — never ambient state.
 */
export interface TargetSearchScope {
	/** The sqo sections opened by this scope alone (the ungranted ones). */
	readonly sections: ReadonlySet<string>;
	/** The pairs the scoped COLUMNS are limited to (WriterChainScope.columnPairs). */
	readonly columnPairs: ReadonlySet<string>;
	/** The pairs the scoped FILTER / ORDER paths are limited to (WriterChainScope.filterPairs). */
	readonly filterPairs: ReadonlySet<string>;
}

/** The rqo pieces a scoped search is judged from. */
export interface TargetSearchRequest {
	readonly source: {
		readonly tipo?: unknown;
		readonly section_tipo?: unknown;
		readonly action?: unknown;
		readonly lang?: unknown;
		readonly callers?: unknown;
	};
	readonly sqoMode: unknown;
	/** The ungranted sqo sections Gate B would refuse. */
	readonly ungranted: readonly string[];
	readonly lang: string;
}

/**
 * The scope that admits `request.ungranted` (module header, (h)), or null —
 * Gate B then refuses as before. Only a COMPONENT-sourced SEARCH (the
 * autocomplete: `source.action === 'search'`) on a plain matrix read qualifies:
 * a get_data page, a section read, a Time Machine or related read never does.
 */
export async function resolveTargetSearchScope(
	principal: Principal,
	request: TargetSearchRequest,
): Promise<TargetSearchScope | null> {
	const source = scopedSearchSourceOf(request);
	if (source === null) return null;
	const scope = await resolveWriterChainScope(principal, {
		tipo: source.tipo,
		sectionTipo: source.sectionTipo,
		callers: request.source.callers,
		lang: request.lang,
	});
	if (scope === null) return null;
	if (!request.ungranted.every((section) => scopeTargetsSection(scope, section))) return null;
	return {
		sections: new Set(request.ungranted),
		columnPairs: scope.columnPairs,
		filterPairs: scope.filterPairs,
	};
}

/**
 * The component a scoped search is sourced from, or null when the request is
 * not one: not a SEARCH action, a Time Machine / related read, or a source
 * that is not a component (a section source names itself).
 */
function scopedSearchSourceOf(
	request: TargetSearchRequest,
): { tipo: string; sectionTipo: string } | null {
	if (!isPlainSearch(request)) return null;
	const { tipo, section_tipo: sectionTipo } = request.source;
	if (typeof tipo !== 'string' || typeof sectionTipo !== 'string') return null;
	return tipo === sectionTipo ? null : { tipo, sectionTipo };
}

/** A SEARCH action (the autocomplete) on a plain matrix read — never a Time Machine or related read. */
function isPlainSearch(request: TargetSearchRequest): boolean {
	return (
		request.source.action === 'search' && request.sqoMode !== 'tm' && request.sqoMode !== 'related'
	);
}
