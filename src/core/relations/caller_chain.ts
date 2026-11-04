/**
 * THE SERVER-VERIFIED CALLER CHAIN of a targeted element (nested-ddo_map plan
 * W4 — owner decisions (a), (d), (f), 2026-11-03).
 *
 * WHY. A nested element's effective config is its own config WITH its
 * caller's children injected (relations/element_node.ts resolveElement), and
 * every child of a COMPONENT caller is raised to read (PHP get_subdatum
 * class.common.php:2564-2571, owner decision (d)). A get_data or search
 * request that targets the nested element directly — page 2 of tch197 →
 * rsc1400, the autocomplete search inside that cell — arrives as a TOP-LEVEL
 * read: it carries no caller, so the server could only resolve the element's
 * OWN config. Then
 *   - stage 1 (request_config/from_rqo.ts READ GRANT) judged every child the
 *     caller injected as a foreign client ddo, and a restricted profile lost on
 *     page 2 the read-only column it saw on page 1 — a TS gate stricter than
 *     PHP on injected children (the from_rqo "KNOWN GAP");
 *   - the search read floor (security/read_floor.ts) was the element's own map,
 *     so a search by a field only the caller injects was refused (plan E10).
 *
 * WHAT THE CLIENT SENDS: `rqo.source.callers`, the element's caller instances
 * from the OUTERMOST down to its direct parent, each `{tipo, section_tipo}`
 * plus `mode` on the first one:
 *
 *   tch197's rsc1400 cell on tch1/1 (edit), paging:
 *     source: {tipo: 'rsc1400', section_tipo: 'rsc1389', …,
 *              callers: [{tipo: 'tch197', section_tipo: 'tch1', mode: 'edit'}]}
 *
 * The first link may also be the SECTION itself (`{tipo: S, section_tipo: S,
 * mode}`) when the outermost component is a column of a section map — its
 * children then come from the section's own column map.
 *
 * THE PRODUCER is the client's `create_callers` (client/dedalo/core/common/js/
 * common.js), attached by `build_rqo_show` (a nested portal's paging get_data)
 * and `build_rqo_search` (the autocomplete inside a nested cell): it walks the
 * instance's `.caller` chain by model (rows and groupers passed through, a
 * section, tool, service or area ends it) and sends the component ancestors —
 * with the SECTION as root when the outermost is a LIST column, else the
 * outermost component with its own mode. A top-level component sends nothing
 * (it has no caller to resolve under). Client gate:
 * client/dedalo/test/client/js/test_caller_chain.js.
 *
 * A COMPONENT ROOT IS RESOLVED UNDER ITS SECTION'S MAP (W4b, 2026-11-03): in
 * EDIT mode the producer may root the chain at the outermost COMPONENT; the
 * server resolves it under its section's map in the root's mode (the read's
 * ROOT node, STEP 11 applied — componentRootNode), so the children a section's
 * EDIT request_config injects (DECL → DREL → REL4) verify exactly as they were
 * resolved on page 1. A component the map does not name falls back to its own
 * config. REMAINING LIMITATION (WC-2026-11-04-rqo-source-callers): a LIST read whose columns came
 * from a preset or a client show rather than the ontology map is not
 * reproduced (sectionMapNode derives the ontology map only) — fail-closed: the
 * read falls back to the target's own config, never more than no chain.
 *
 * VERIFIED, NEVER TRUSTED. The chain is a claim of WHERE the element sits; the
 * server re-derives every link from the ontology and refuses the whole chain
 * (null — the read proceeds exactly as without one) unless:
 *   1. SHAPE — at most MAX_DDO_DEPTH links, each an object with non-empty
 *      string `tipo` / `section_tipo`; the first link's `mode` is 'edit' or
 *      'list'.
 *   2. THE ROOT IS READABLE BY GRANT — the first link is a component OF its
 *      section (tipoBelongsToSection, virtual-aware) the actor holds the read
 *      pair on (`authorizeRoot`: the section read grant AND the component's
 *      own — the read door's predicate; the search floor additionally demands
 *      a PROFILE basis), or the section itself (section read grant). This is
 *      PHP's top: the outermost element is a section's child, judged by its own
 *      grant (STEP 11).
 *   3. EVERY FURTHER LINK, AND THE TARGET, IS A DIRECT DATA CHILD of the link
 *      above it: a show/hide line of that element's EFFECTIVE config (own
 *      config + whatever ITS caller injected — the same node the cell was
 *      resolved from) naming the tipo with `parent` = that element, at a section
 *      the line names (declared section_tipo; 'self' / undeclared = the
 *      element's target sections — a section root's own section).
 *      A section root's map is gated first like the section read's data map
 *      (STEP 11 — every ddo the actor holds 0 on is dropped, nested lines
 *      included), so a chain can never step through a line the section caller
 *      dropped (owner decision (d): only a SECTION caller's ddos drop).
 * Past the root, no further grant is asked: every link is the child of a
 * COMPONENT caller, raised to read by PHP whatever the target grant — which is
 * exactly what the chain must reproduce.
 *
 * The chain's nodes are resolved in a SEPARATE registry (verification
 * scaffolding, never part of the response): the targeted element's node, built
 * in the emission's registry under the returned parent node, carries the
 * caller children, and its `parentKey` names a node the emission does not hold
 * — so the context door's node chain (section/node_permissions.ts) treats it as
 * the read's top, and the response's traversal order is untouched.
 *
 * Gate: test/unit/subdatum_permission_native.test.ts (forged chains refused —
 * an unreadable root, a child the parent does not declare, a section the line
 * does not name; a SECTION-rooted list chain verifies with STEP 11 applied; the
 * page-2 stage-1 inheritance; the read floor and the count door).
 */

import type { Ddo } from '../concepts/ddo.ts';
import type { Principal } from '../security/permissions.ts';
import { MAX_DDO_DEPTH, resolveElement, rootNodeFor } from './element_node.ts';
import { type ElementNode, ElementNodeRegistry } from './element_registry.ts';

/** One verified-or-not link of a client-declared chain. */
interface CallerLink {
	readonly tipo: string;
	readonly section_tipo: string;
	readonly mode?: string;
}

/** The modes a chain ROOT may declare (an element renders as a cell only in these). */
const ROOT_MODES: ReadonlySet<string> = new Set(['edit', 'list']);

/** The longest accepted tipo string (a tipo is a short TLD + number; anything longer is not one). */
const MAX_TIPO_LENGTH = 64;

/** What the chain is verified for. */
export interface CallerChainInput {
	/** The client-declared chain (`rqo.source.callers`) — untrusted. */
	readonly callers: unknown;
	/** The targeted element (the rqo source). */
	readonly targetTipo: string;
	readonly targetSectionTipo: string;
	/** The read's data lang (the chain's own configs are built in it). */
	readonly lang: string;
	/** The actor; undefined = an internal resolution (no grant is asked). */
	readonly principal: Principal | undefined;
	/**
	 * The root grant (module header, step 2), asked with `tipo === sectionTipo`
	 * for a SECTION root. Defaults to the read door's pair: the section read
	 * grant AND (for a component root) the component's own level.
	 */
	readonly authorizeRoot?: (sectionTipo: string, tipo: string) => Promise<boolean>;
}

/** A verified chain: the target's caller node and the caller's line for it. */
export interface VerifiedCallerChain {
	/** The node of the target's DIRECT caller (its effective config injects the target's children). */
	readonly parentNode: ElementNode;
	/** The caller's line for the target (its governing ddo). */
	readonly line: Readonly<Record<string, unknown>>;
}

/** A non-empty, bounded string, else null. */
function tipoString(value: unknown): string | null {
	return typeof value === 'string' && value !== '' && value.length <= MAX_TIPO_LENGTH
		? value
		: null;
}

/** A plain (non-array) object, else null. */
function plainObject(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** A ROOT link's declared mode when it is one a cell renders in, else null. */
function rootMode(value: unknown): string | null {
	return typeof value === 'string' && ROOT_MODES.has(value) ? value : null;
}

/** ONE link, or null when its shape is refused (the root must declare its mode). */
function parseLink(raw: unknown, isRoot: boolean): CallerLink | null {
	const record = plainObject(raw);
	if (record === null) return null;
	const tipo = tipoString(record.tipo);
	const sectionTipo = tipoString(record.section_tipo);
	if (tipo === null || sectionTipo === null) return null;
	if (!isRoot) return { tipo, section_tipo: sectionTipo };
	const mode = rootMode(record.mode);
	return mode === null ? null : { tipo, section_tipo: sectionTipo, mode };
}

/** The client chain as links, or null when its SHAPE is refused (module header, step 1). */
function parseLinks(callers: unknown): CallerLink[] | null {
	if (!Array.isArray(callers) || callers.length === 0 || callers.length > MAX_DDO_DEPTH) {
		return null;
	}
	const links: CallerLink[] = [];
	for (const [index, raw] of callers.entries()) {
		const link = parseLink(raw, index === 0);
		if (link === null) return null;
		links.push(link);
	}
	return links;
}

/**
 * The read door's pair: the section read grant AND, for a component root, the
 * component's own level.
 */
async function readDoorPair(
	principal: Principal,
	sectionTipo: string,
	tipo: string,
): Promise<boolean> {
	const { ddoIsAuthorized, getSectionPermissions } = await import('../security/permissions.ts');
	if ((await getSectionPermissions(principal, sectionTipo)) < 1) return false;
	return tipo === sectionTipo || ddoIsAuthorized(principal, sectionTipo, tipo);
}

/** Whether the actor may stand at the chain's root (CallerChainInput.authorizeRoot, else the read door's pair). */
function rootAuthorized(
	input: CallerChainInput,
	sectionTipo: string,
	tipo: string,
): Promise<boolean> {
	const { principal } = input;
	if (principal === undefined) return Promise.resolve(true);
	return input.authorizeRoot !== undefined
		? input.authorizeRoot(sectionTipo, tipo)
		: readDoorPair(principal, sectionTipo, tipo);
}

/**
 * The section a root-map ddo is judged at (the section read's data gate:
 * its declared section, the first of a list, 'self' / undeclared = the
 * section itself).
 */
function rootGateSection(ddo: Ddo, sectionTipo: string): string {
	const declared = ddo.section_tipo as unknown;
	const entries = Array.isArray(declared) ? declared : [declared];
	const first = entries.find(
		(entry): entry is string => typeof entry === 'string' && entry !== 'self',
	);
	return first ?? sectionTipo;
}

/**
 * A section's own column map in `mode` as the ROOT node of a read, gated like
 * the section read's data map (STEP 11 — every ddo the actor holds 0 on is
 * dropped, nested lines included). No grant on the section itself is asked
 * here: the caller decides who may stand at it.
 */
async function sectionMapNode(
	sectionTipo: string,
	mode: string,
	input: CallerChainInput,
	registry: ElementNodeRegistry,
): Promise<ElementNode> {
	const { principal } = input;
	const { deriveSectionDdoMap } = await import('../section/read.ts');
	const derived = await deriveSectionDdoMap(sectionTipo, sectionTipo, mode);
	let map: Ddo[] = derived;
	if (principal !== undefined) {
		const { ddoIsAuthorized } = await import('../security/permissions.ts');
		map = [];
		for (const ddo of derived) {
			if (await ddoIsAuthorized(principal, rootGateSection(ddo, sectionTipo), ddo.tipo)) {
				map.push(ddo);
			}
		}
	}
	return rootNodeFor(registry, sectionTipo, sectionTipo, mode, map);
}

/** A SECTION root: its own column map, gated like the section read's data map (STEP 11). */
async function sectionRootNode(
	link: CallerLink,
	input: CallerChainInput,
	registry: ElementNodeRegistry,
): Promise<ElementNode | null> {
	if (link.tipo !== link.section_tipo) return null;
	if (!(await rootAuthorized(input, link.section_tipo, link.tipo))) return null;
	return sectionMapNode(link.section_tipo, link.mode as string, input, registry);
}

/**
 * A COMPONENT root: a component of its section the actor reads by grant,
 * resolved where the page-1 read resolved it — UNDER ITS SECTION's map in the
 * root's mode (W4b, task 5): a section EDIT request_config may declare the
 * component's children (DECL → DREL → REL4), and the cell was resolved with
 * them injected. The section's map is the read's ROOT node (sectionMapNode,
 * STEP 11 applied); when it names the component, the component's node is
 * resolved under it with the map's line as its governing ddo. Only an EDIT
 * root is: a link's mode is the cell's render mode, so a non-edit component
 * root cannot tell which map its read used (see the body). A component the
 * map does not name (a virtual section whose map cannot be derived to it, a
 * client-shaped page) falls back to its OWN config — never more than that.
 */
async function componentRootNode(
	link: CallerLink,
	model: string,
	input: CallerChainInput,
	registry: ElementNodeRegistry,
): Promise<ElementNode | null> {
	if (!model.startsWith('component_')) return null;
	const { tipoBelongsToSection } = await import('../ontology/resolver.ts');
	if (!(await tipoBelongsToSection(link.tipo, link.section_tipo))) return null;
	if (!(await rootAuthorized(input, link.section_tipo, link.tipo))) return null;
	const mode = link.mode as string;
	// ONLY an EDIT-mode component root is re-rooted under its section's map
	// (W4b review): the link's mode is the CELL's render mode, not the mode of
	// the read that resolved it. The client sends a section root for every LIST
	// read (common.js create_callers), so a component root names an EDIT read
	// (or no section read at all) — and a cell rendering mode:'list' inside it
	// (an edit map line declaring mode 'list') would derive the section's LIST
	// map here and inject children page 1 never resolved (decision (a)). Any
	// other mode resolves from the component's own config — fail closed.
	const underSection =
		mode === 'edit' ? await componentUnderSectionMap(link, model, mode, input, registry) : null;
	if (underSection !== null) return underSection;
	return resolveElement({
		ddo: { tipo: link.tipo, section_tipo: link.section_tipo, parent: 'self', mode } as Ddo,
		parentNode: null,
		ownerSectionTipo: link.section_tipo,
		mode,
		lang: input.lang,
		registry,
		model,
	});
}

/**
 * The component root's node under its section's map (componentRootNode), or
 * null when the map has no line for it at that section. A map that cannot be
 * derived (a broken section definition) is reported and answers null — the
 * own-config fallback, never a refused chain for a definition defect.
 */
async function componentUnderSectionMap(
	link: CallerLink,
	model: string,
	mode: string,
	input: CallerChainInput,
	registry: ElementNodeRegistry,
): Promise<ElementNode | null> {
	let sectionNode: ElementNode;
	try {
		sectionNode = await sectionMapNode(link.section_tipo, mode, input, registry);
	} catch (error) {
		console.warn(
			`[relations/caller_chain] the ${mode} map of ${JSON.stringify(link.section_tipo).slice(0, 80)} could not be derived — ${JSON.stringify(link.tipo).slice(0, 80)} resolves from its own config:`,
			error,
		);
		return null;
	}
	const line = await childLineOf(sectionNode, link.tipo, link.section_tipo);
	if (line === null) return null;
	return resolveElement({
		ddo: { ...(line as unknown as Ddo), mode },
		parentNode: sectionNode,
		ownerSectionTipo: link.section_tipo,
		mode,
		lang: input.lang,
		registry,
		model,
	});
}

/** The chain's ROOT node (module header, step 2), or null when refused. */
async function rootNodeOf(
	link: CallerLink,
	input: CallerChainInput,
	registry: ElementNodeRegistry,
): Promise<ElementNode | null> {
	const { getModelByTipo } = await import('../ontology/resolver.ts');
	const model = await getModelByTipo(link.tipo);
	if (model === null) return null;
	return model === 'section'
		? sectionRootNode(link, input, registry)
		: componentRootNode(link, model, input, registry);
}

/** The target sections of an element node (a section root: its own section). */
async function targetSectionsOf(node: ElementNode): Promise<readonly string[]> {
	if (node.configSource === 'root') return [node.section_tipo];
	const { extractSqoSectionTipos } = await import('./request_config/explicit.ts');
	return node.effectiveConfig.flatMap((item) =>
		extractSqoSectionTipos(item as unknown as Parameters<typeof extractSqoSectionTipos>[0]),
	);
}

/** Whether a line's declared section_tipo names `sectionTipo` ('self' / undeclared = the element's targets). */
async function lineNamesSection(
	line: Readonly<Record<string, unknown>>,
	sectionTipo: string,
	parent: ElementNode,
): Promise<boolean> {
	const declared = line.section_tipo;
	const entries: unknown[] = Array.isArray(declared) ? declared : [declared];
	if (entries.includes(sectionTipo)) return true;
	const namesTargets = entries.some(
		(entry) => entry === undefined || entry === null || entry === 'self',
	);
	return namesTargets && (await targetSectionsOf(parent)).includes(sectionTipo);
}

/** The parent's direct data-child line for `tipo` at `sectionTipo` (step 3), or null. */
async function childLineOf(
	parent: ElementNode,
	tipo: string,
	sectionTipo: string,
): Promise<Readonly<Record<string, unknown>> | null> {
	for (const line of parent.children) {
		if (line.tipo !== tipo) continue;
		if (await lineNamesSection(line, sectionTipo, parent)) return line;
	}
	return null;
}

/** A nested link's node under its verified parent (step 3), or null. */
async function nestedLinkNode(
	link: CallerLink,
	parent: ElementNode,
	input: CallerChainInput,
	registry: ElementNodeRegistry,
): Promise<ElementNode | null> {
	const line = await childLineOf(parent, link.tipo, link.section_tipo);
	if (line === null) return null;
	const { getModelByTipo } = await import('../ontology/resolver.ts');
	const model = await getModelByTipo(link.tipo);
	if (model === null || !model.startsWith('component_')) return null;
	const mode = typeof line.mode === 'string' && line.mode !== '' ? line.mode : 'list';
	return resolveElement({
		ddo: line as unknown as Ddo,
		parentNode: parent,
		ownerSectionTipo: link.section_tipo,
		mode,
		lang: input.lang,
		registry,
		model,
	});
}

/** One bounded operator line per refused chain (the chain is client input). */
function warnRefused(input: CallerChainInput, at: string): void {
	console.warn(
		`[relations/caller_chain] refused source.callers for ${JSON.stringify(input.targetTipo).slice(0, 80)} @ ${JSON.stringify(input.targetSectionTipo).slice(0, 80)} (${at}) — resolved as a top-level read`,
	);
}

/**
 * Walk the parsed links root-first to the target's immediate caller node, or
 * null (with the refusing link warned) when any link is refused.
 */
async function walkLinks(
	links: readonly CallerLink[],
	input: CallerChainInput,
): Promise<ElementNode | null> {
	const registry = new ElementNodeRegistry();
	let parent = await rootNodeOf(links[0] as CallerLink, input, registry);
	if (parent === null) {
		warnRefused(input, 'root');
		return null;
	}
	for (const link of links.slice(1)) {
		parent = await nestedLinkNode(link, parent, input, registry);
		if (parent === null) {
			warnRefused(input, `link ${link.tipo}`);
			return null;
		}
	}
	return parent;
}

/**
 * Verify `input.callers` (module header) and return the target's caller node
 * plus the caller's line for it — or null when the request carries no chain or
 * any link is refused (the read then resolves the target as a top-level
 * element, exactly as before the chain existed).
 */
export async function resolveCallerChain(
	input: CallerChainInput,
): Promise<VerifiedCallerChain | null> {
	if (input.callers === undefined || input.callers === null) return null;
	const links = parseLinks(input.callers);
	if (links === null) {
		warnRefused(input, 'shape');
		return null;
	}
	const parent = await walkLinks(links, input);
	if (parent === null) return null;
	const line = await childLineOf(parent, input.targetTipo, input.targetSectionTipo);
	if (line === null) {
		warnRefused(input, 'target');
		return null;
	}
	return { parentNode: parent, line };
}
