/**
 * EXCLUDED DIFFUSION ELEMENTS — the diffusion elements an installation hides
 * from tool_diffusion and refuses to publish to (owner ruling 2026-11-22, R3:
 * the v6 EXCLUDE_DIFFUSION_ELEMENTS, ported as option (a)).
 *
 * v6 (tools/tool_diffusion/class.tool_diffusion.php `get_diffusion_info`) read
 * `EXCLUDE_DIFFUSION_ELEMENTS` from the tool's Tools-configuration record (dd996,
 * `tool_common::get_config`), falling back to the define of the same name, and
 * dropped every diffusion-map item whose element tipo it listed — a UI filter
 * only: the publish door never checked it.
 *
 * In v7 the list lives in ONE place, the tool configuration — install record
 * (dd996/dd999) over register default (dd1324/dd1633), resolved by
 * `getToolConfigValue` (core/tools/config.ts) — under v6's OWN key spelling, so
 * a v6 install that set it there keeps it with no data change. The define is
 * gone: the v6→v7 config migration MOVES its value into that key
 * (src/config/migration_map.ts `TOOL_CONFIG`, core/tools/tool_config_move.ts).
 *
 * ONE LIST, every door that starts a run:
 *   - `get_diffusion_info` (info.ts) drops the panels of an excluded element;
 *   - `diffuse` (actions.ts) REFUSES an excluded element before anything is
 *     queued (`diffusion.element_excluded`) — the server door, not the UI: a
 *     hidden panel is no refusal to a caller who posts the tipo by hand;
 *   - the admin requeue (jobs/queue.ts `requeueTerminalJob`) refuses the same
 *     way before writing, and the stale-job sweeper (`sweepStaleJobs`) FAILS a
 *     lost run of an excluded element instead of re-queueing it (review MED-1:
 *     both start a NEW run). NOT re-checked: a job already QUEUED before the
 *     element was excluded is run by the runner as queued (owner question);
 *   - the dev/ops full-element harness (scripts/diffusion_harness_publish.ts)
 *     refuses before compiling its plan (re-review INFO-6) — no back door.
 *
 * MATCHING. An element is excluded when its own tipo OR, for a
 * `diffusion_element_alias`, the real element it resolves to is listed. v6's map
 * items carried the REAL element tipo (aliases were resolved before the
 * filter), so a listed real element hides its aliases too — kept; listing an
 * alias tipo is v7's addition (v6 could never match one).
 *
 * A MALFORMED value is REFUSED, never read as "nothing excluded" (v6 silently
 * ignored a non-array): a list an operator wrote to stop a publication must
 * not turn into publishing everywhere because of a typo. The refusal names
 * where the value lives (the zotero_map precedent).
 */

import {
	EXCLUDED_ELEMENTS_LOCATION,
	parseElementTipoList,
} from '../../config/element_tipo_list.ts';
import { DedaloError } from '../../core/errors/index.ts';
import { getToolConfigValue } from '../../core/tools/config.ts';
import {
	buildVirtualDiffusionTree,
	findElementNodes,
	type VirtualDiffusionTree,
} from '../plan/virtual_tree.ts';

/** The tool whose configuration carries the list (v6: tool_diffusion) — config/element_tipo_list.ts. */
export const EXCLUSION_TOOL: string = EXCLUDED_ELEMENTS_LOCATION.tool;

/** The config key — v6's spelling, verbatim (class.tool_diffusion.php:51). */
export const EXCLUSION_KEY: string = EXCLUDED_ELEMENTS_LOCATION.key;

/**
 * Parse a configured exclusion list: absent/null → none excluded; an array of
 * non-empty strings → that set; anything else REFUSES (tool.config_invalid).
 */
export function parseExcludedElements(raw: unknown): ReadonlySet<string> {
	// THE shape rule, shared with the v6→v7 migration's move (review MED-2).
	const tipos = parseElementTipoList(raw);
	if (tipos === null) {
		// A CONFIG fault (the operator's), never the caller's request (review LOW-7).
		throw new DedaloError('tool.config_invalid', {
			message: `${EXCLUSION_TOOL} config ${EXCLUSION_KEY} is not a list of element tipos: ${JSON.stringify(raw)}`,
			publicMessage: `The ${EXCLUSION_TOOL} configuration '${EXCLUSION_KEY}' (Tools configuration, dd996) must be a list of diffusion element tipos, e.g. ["oh63"]. Fix it there.`,
		});
	}
	return new Set(tipos);
}

/** The installation's excluded element tipos (tool configuration, per request — config-cached). */
export async function excludedDiffusionElements(): Promise<ReadonlySet<string>> {
	return parseExcludedElements(
		await getToolConfigValue<unknown>(EXCLUSION_TOOL, EXCLUSION_KEY, null),
	);
}

/** Is this element (its tipo, or the real element an alias resolves to) excluded? */
export function isExcludedElement(
	element: { tipo: string; realTipo?: string | null },
	excluded: ReadonlySet<string>,
): boolean {
	if (excluded.has(element.tipo)) return true;
	return typeof element.realTipo === 'string' && excluded.has(element.realTipo);
}

/** Refuse a publication to an excluded element (the `diffuse` door). */
export function assertElementNotExcluded(
	element: { tipo: string; realTipo?: string | null },
	excluded: ReadonlySet<string>,
): void {
	if (!isExcludedElement(element, excluded)) return;
	throw new DedaloError('diffusion.element_excluded', {
		coordinates: { diffusion_element_tipo: element.tipo },
	});
}

/**
 * The real element an element ALIAS resolves to, read off the virtual tree's
 * element nodes (null for a real element, an unresolvable alias, an unknown
 * tipo or no tree). Pure — exported for its gate.
 */
export function elementRealTipo(
	tree: Pick<VirtualDiffusionTree, 'nodes'> | null,
	elementTipo: string,
): string | null {
	if (tree === null) return null;
	return (
		findElementNodes(tree as VirtualDiffusionTree).find((node) => node.tipo === elementTipo)
			?.realTipo ?? null
	);
}

/**
 * The `diffuse` door's check: refuse `elementTipo` when it, or the real element
 * it aliases, is excluded. The alias is resolved through the same virtual tree
 * the panels come from — and only when there is a list to match and the tipo
 * is not listed itself, so an install without exclusions pays nothing.
 * `domainName` is the tree's seam (a gate names its own scratch domain);
 * production omits it and gets DEDALO_DIFFUSION_DOMAIN.
 */
export async function assertPublishableElement(
	elementTipo: string,
	domainName?: string,
): Promise<void> {
	const excluded = await excludedDiffusionElements();
	if (excluded.size === 0) return;
	assertElementNotExcluded({ tipo: elementTipo }, excluded);
	const realTipo = elementRealTipo(await buildVirtualDiffusionTree(domainName), elementTipo);
	assertElementNotExcluded({ tipo: elementTipo, realTipo }, excluded);
}

/**
 * The SET form of `assertPublishableElement`, for the queue's set-based
 * statements (the stale-job sweeper, review MED-1): the listed tipos plus every
 * element ALIAS of the domain whose real element is listed. Empty when nothing
 * is excluded (no tree is built); a malformed list throws `tool.config_invalid`.
 */
export async function excludedElementTipos(domainName?: string): Promise<string[]> {
	const excluded = await excludedDiffusionElements();
	if (excluded.size === 0) return [];
	const tipos = new Set(excluded);
	const tree = await buildVirtualDiffusionTree(domainName);
	if (tree !== null) {
		for (const node of findElementNodes(tree)) {
			if (isExcludedElement(node, excluded)) tipos.add(node.tipo);
		}
	}
	return [...tipos];
}
