/**
 * THE ONTOLOGY CHECK FOR LEVEL >= 2 'self' — owner decision (c) of the
 * nested-ddo_map plan (2026-11-03), its definition-side half.
 *
 * A read REFUSES a ddo that declares `section_tipo: 'self'` below the first
 * level of its config owner (self_depth.ts): the ddo is skipped and a typed
 * notice (`ontology.ddo_self_refused`) names it — but only on the page that
 * happens to render it. This check walks the INSTALLED ontology and lists
 * every such definition up front, so the people who own the master ontology
 * can correct each one to an explicit `section_tipo` (`"rsc197"`) or a source
 * array (`[{value:[1], source:"hierarchy_types"}]`) before a reader meets the
 * notice.
 *
 * ONE RULE, TWO CONSUMERS. The walk is self_depth.ts findDeepSelfDdos — the
 * same depth computation and the same four-spelling 'self' sentinel the
 * request_config parser applies (explicit.ts skipDeepSelfDdos) — so the check
 * lists exactly what a read would skip, never a spelling of its own.
 *
 *   tch197 show.ddo_map [rsc1400<self (self), rsc85<rsc1400 (self)]
 *     → {tipo: tch197, slot: 'show', ddo: rsc85, parent: rsc1400, depth: 2}
 *
 * THE CONFIG OWNER. A ddo's depth is measured from the element whose config
 * holds the map: the node itself, except a `section_list` /
 * `section_list_thesaurus` node, whose map is its PARENT element's list
 * config (build.ts swaps the list node's properties in while the read's
 * `ownerTipo` stays the parent). The parents are taken VERBATIM, exactly as
 * the read takes them (explicit.ts maps only the literal 'self' to the owner):
 * a ddo naming the list node itself as parent never reaches the owner, so the
 * read keeps that chain as an orphan with no notice — and this check lists
 * nothing for it either.
 *
 * A list node the read NEVER swaps in is not scanned: a list node that is not
 * the FIRST of its model under its parent by `order_number` (build.ts
 * findSectionListChild, `LIMIT 1`), and a SECTION with a direct
 * `source.request_config` — ANY non-null value, the read's isset test
 * (build.ts `sectionKeepsOwn`, PHP :274), not only the array shape this scan
 * walks — keeps its own config in list mode, so its section_list ddo_map is
 * never read as a request_config by ITS list read (configReaders).
 *
 * VIRTUAL FALLBACK. A virtual section with no config and no list node of its
 * own reads its REAL section's list node (build.ts) — even when the real
 * section keeps its own config, because the keep-own test is the virtual
 * section's. Such a list node IS scanned, and its depth is measured from EVERY
 * section that actually reads it — exactly the `ownerTipo` each read parses it
 * under: the real section (the list node's parent) only when its own list read
 * swaps the node in, and each falling-back virtual section V with owner V
 * (build.ts keeps the VIRTUAL tipo as ownerTipo while it borrows the real
 * node). A chain rooted on the literal real tipo is therefore an orphan for V
 * (not listed for V), one rooted on the literal V tipo is counted for V (listed,
 * owner V); a 'self'-rooted chain gives every reader the same answer, and the
 * identical findings fold into ONE (owner = the first reader, `readers` = all).
 *
 * WHERE IT RUNS. The reconcile registry (src/core/reconcile/registry.ts) is
 * the maintenance surface every cross-store check already uses: the
 * `reconcile_status` widget, `scripts/reconcile.ts`, the post-restore plan. The
 * two "stores" are the installed request_config definitions and the depth rule
 * — the `ontology_identifiers` precedent (rows vs a grammar). An APPLY is
 * REFUSED: the correction is a definition edit on the MASTER ontology that
 * reaches an installation through an ontology update (AGENTS.md — ontology
 * definitions belong to the master ontology), never an engine rewrite of
 * dd_ontology.
 *
 * Gates: test/unit/nested_ddo_map_injection_native.test.ts (finds an offending
 * scratch node, not a compliant one) and the registry's own pair proof
 * (test/unit/reconcile_registry_native.test.ts PLANTERS.ddo_self_depth).
 */

import {
	type DdOntologyRequestConfigRow,
	type DdOntologySectionListFacts,
	readDdOntologyFirstListNodeTipos,
	readDdOntologyRequestConfigRows,
	readDdOntologySectionListFacts,
} from '../../db/dd_ontology.ts';
import { getModelByTipo, sectionRealTipoFromRelations } from '../../ontology/resolver.ts';
import type { ReconcileDefinition, ReconcileReport } from '../../reconcile/registry.ts';
import { CONFIG_SLOTS, type ConfigSlot } from './caller_injection.ts';
import { type DepthDdo, findDeepSelfDdos } from './self_depth.ts';

/** The reconcile name (registry REGISTERED_NAMES). */
export const DDO_SELF_DEPTH = 'ddo_self_depth';

/** Models whose request_config is their PARENT component's list config. */
const LIST_CONFIG_MODELS: ReadonlySet<string> = new Set(['section_list', 'section_list_thesaurus']);

/**
 * Most findings ONE report lists. A real ontology holds a handful; the cap
 * only keeps a pathological one from producing an unbounded payload — the
 * remainder is COUNTED (`detail.more`) and `drift` is always the full count,
 * so nothing is hidden silently.
 */
const MAX_REPORTED_FINDINGS = 500;

/** One offending ddo, located in the definition that declares it. */
export interface DeepSelfDefinitionFinding {
	/** The dd_ontology node whose properties hold the map. */
	readonly tipo: string;
	readonly tld: string | null;
	readonly model: string | null;
	/** The config owner the depth is measured from (tipo, a list node's parent, or a virtual reader). */
	readonly owner: string;
	/**
	 * EVERY config owner whose read refuses this ddo — more than `owner` only for
	 * a list node several sections read (module header, VIRTUAL FALLBACK).
	 */
	readonly readers: readonly string[];
	/** Index of the request_config item. */
	readonly item: number;
	readonly api_engine: string;
	readonly slot: ConfigSlot;
	readonly ddo: string;
	readonly parent: string;
	readonly depth: number;
}

/** The config owner of one node's map (module header, THE CONFIG OWNER). */
function configOwnerOf(row: DdOntologyRequestConfigRow): string {
	if (row.model !== null && LIST_CONFIG_MODELS.has(row.model) && row.parent !== null) {
		return row.parent;
	}
	return row.tipo;
}

/** A slot's raw ddo_map entries that take part in the depth walk (tipo-bearing objects). */
function walkableDdos(block: unknown): DepthDdo[] {
	const ddoMap = (block as { ddo_map?: unknown } | null)?.ddo_map;
	if (!Array.isArray(ddoMap)) return [];
	return ddoMap.filter(
		(ddo): ddo is DepthDdo =>
			ddo !== null && typeof ddo === 'object' && typeof (ddo as DepthDdo).tipo === 'string',
	);
}

/** A finding being folded across readers: `readers` grows as more owners refuse it. */
type FoldedFinding = DeepSelfDefinitionFinding & { readers: string[] };

/** The offending ddos of ONE config item measured from ONE owner (every slot). */
function itemFindingsFrom(
	row: DdOntologyRequestConfigRow,
	owner: string,
	configItem: Record<string, unknown>,
	item: number,
): FoldedFinding[] {
	const apiEngine = typeof configItem.api_engine === 'string' ? configItem.api_engine : 'dedalo';
	return CONFIG_SLOTS.flatMap((slot) =>
		findDeepSelfDdos(owner, walkableDdos(configItem[slot])).map((finding) => ({
			tipo: row.tipo,
			tld: row.tld,
			model: row.model,
			owner,
			readers: [owner],
			item,
			api_engine: apiEngine,
			slot,
			...finding,
		})),
	);
}

/**
 * Every offending ddo of ONE node's request_config, every item and slot,
 * measured from each config owner that reads it (`owners`, default: the node's
 * own config owner). A ddo every reader refuses identically is ONE finding
 * (owner = the first reader, `readers` = all of them).
 */
export function deepSelfFindingsOf(
	row: DdOntologyRequestConfigRow,
	owners: readonly string[] = [configOwnerOf(row)],
): DeepSelfDefinitionFinding[] {
	const byIdentity = new Map<string, FoldedFinding>();
	for (const owner of owners) {
		row.request_config.forEach((rawItem, item) => {
			if (rawItem === null || typeof rawItem !== 'object') return;
			for (const finding of itemFindingsFrom(
				row,
				owner,
				rawItem as Record<string, unknown>,
				item,
			)) {
				const identity = [item, finding.slot, finding.ddo, finding.parent, finding.depth].join('|');
				const known = byIdentity.get(identity);
				if (known === undefined) byIdentity.set(identity, finding);
				else known.readers.push(owner);
			}
		});
	}
	return [...byIdentity.values()];
}

/**
 * The config owners that read each row as a request_config — empty for a list
 * node NO read swaps in (module header). A non-list node is read by itself; a
 * list node under a non-section element (a component's list device) by that
 * element. A list node of model `m` under a SECTION `P` is read by
 *
 *  - P itself, when P does not keep its own config — the read's ISSET test,
 *    any non-null `source.request_config` (build.ts `sectionKeepsOwn`, PHP
 *    :274), never the array shape the scanned rows are filtered on; and
 *  - every VIRTUAL section V of P (getSectionRealTipo's walk, stated once in
 *    sectionRealTipoFromRelations) that keeps no own config either and has no
 *    child of model `m` of its own: V's list read falls back to P's list node
 *    (build.ts VIRTUAL SECTION fallback) — whether P keeps its own or not,
 *    since the keep-own test is V's — with V as its owner.
 *
 * Only the FIRST list node of each model under a parent (by `order_number`,
 * build.ts findSectionListChild) has readers at all — the same rule for a
 * component parent, a section parent and the virtual fallback's real section;
 * any later sibling of the same model is read by nobody.
 *
 * The section facts are the WHOLE ontology's, whatever `tlds` scopes the scan
 * to: a list node's reader may live in another TLD.
 */
async function configReaders(): Promise<(row: DdOntologyRequestConfigRow) => string[]> {
	const sections = await readDdOntologySectionListFacts();
	const keepsOwn = new Map(sections.map((section) => [section.tipo, section.keeps_own]));
	const virtualFallbacks = await virtualFallbackReaders(sections);
	const firstListNodes = await readDdOntologyFirstListNodeTipos();
	return (row) => {
		if (row.model === null || !LIST_CONFIG_MODELS.has(row.model) || row.parent === null) {
			return [configOwnerOf(row)];
		}
		// a second, third… list node of the same model under one parent: no read
		// ever swaps it in (findSectionListChild takes the first by order_number)
		if (!firstListNodes.has(row.tipo)) return [];
		return listNodeReaders(row.parent, row.model, keepsOwn, virtualFallbacks);
	};
}

/**
 * The readers of a parent's FIRST list node of `model` (configReaders): the
 * parent itself unless it is a section that keeps its own config, plus every
 * config-less virtual section that falls back to it.
 */
function listNodeReaders(
	parent: string,
	model: string,
	keepsOwn: ReadonlyMap<string, boolean>,
	virtualFallbacks: ReadonlyMap<string, ReadonlyMap<string, string[]>>,
): string[] {
	// not a section parent, or a section whose own list read swaps it in
	const readers = keepsOwn.get(parent) !== true ? [parent] : [];
	readers.push(...(virtualFallbacks.get(parent)?.get(model) ?? []));
	return readers;
}

/**
 * The list models a section's own list read takes from its REAL section: none
 * when it keeps its own config, else every list model it has no child of.
 */
function listModelsReadThroughFallback(section: DdOntologySectionListFacts): string[] {
	if (section.keeps_own) return [];
	return [...LIST_CONFIG_MODELS].filter((model) => !section.list_models.includes(model));
}

/**
 * real section tipo → list model → the config-less VIRTUAL sections of it that
 * lack a child of that model (each one reads the real section's list node of
 * that model, as its own owner — build.ts VIRTUAL SECTION fallback), in the
 * ontology's section order.
 */
async function virtualFallbackReaders(
	sections: readonly DdOntologySectionListFacts[],
): Promise<Map<string, Map<string, string[]>>> {
	const fallbacks = new Map<string, Map<string, string[]>>();
	for (const section of sections) {
		const missing = listModelsReadThroughFallback(section);
		if (missing.length === 0) continue;
		const realTipo = await sectionRealTipoFromRelations(
			section.tipo,
			section.relations,
			getModelByTipo,
		);
		if (realTipo === section.tipo) continue;
		addFallbackReader(fallbacks, realTipo, missing, section.tipo);
	}
	return fallbacks;
}

/** Record `reader` as a fallback reader of `realTipo`'s list node of each of `models`. */
function addFallbackReader(
	fallbacks: Map<string, Map<string, string[]>>,
	realTipo: string,
	models: readonly string[],
	reader: string,
): void {
	const byModel = fallbacks.get(realTipo) ?? new Map<string, string[]>();
	for (const model of models) byModel.set(model, [...(byModel.get(model) ?? []), reader]);
	fallbacks.set(realTipo, byModel);
}

/**
 * Scan the installed ontology (or the `tlds` given) for level >= 2 'self'
 * declarations. Read-only.
 */
export async function scanDeepSelfDefinitions(tlds: readonly string[] | null): Promise<{
	scanned: number;
	findings: DeepSelfDefinitionFinding[];
}> {
	const rows = await readDdOntologyRequestConfigRows(tlds);
	const readersOf = await configReaders();
	return {
		scanned: rows.length,
		findings: rows.flatMap((row) => {
			const readers = readersOf(row);
			return readers.length === 0 ? [] : deepSelfFindingsOf(row, readers);
		}),
	};
}

/** The registry run: a dry report; an apply never reaches here (applyRefused). */
async function runDeepSelfCheck({
	scope,
}: {
	scope?: readonly string[];
}): Promise<ReconcileReport> {
	const tlds = scope === undefined ? null : [...scope];
	const { scanned, findings } = await scanDeepSelfDefinitions(tlds);
	const listed = findings.slice(0, MAX_REPORTED_FINDINGS);
	return {
		drift: findings.length,
		applied: 0,
		detail: {
			tlds: tlds ?? 'all',
			scanned,
			findings: listed,
			more: findings.length - listed.length,
		},
	};
}

/**
 * The registry shape (core/reconcile/registry.ts): installed request_config
 * definitions vs the decision-(c) depth rule. Operator-run, dry only.
 */
export const DDO_SELF_DEPTH_RECONCILE: ReconcileDefinition = {
	name: DDO_SELF_DEPTH,
	stores: [
		'installed request_config ddo_maps (dd_ontology properties.source.request_config)',
		"the ddo section_tipo depth rule ('self' only at the first level — self_depth.ts)",
	],
	description:
		"List every ontology definition whose request_config declares section_tipo 'self' on a ddo below the first level of its owner (a read skips each one with an ontology.ddo_self_refused notice); the correction is an explicit section_tipo or a source array on the master ontology.",
	scopeLabel: 'tld',
	// A whole-ontology walk an operator asks for (and the post-restore dry
	// list); cheap, but it repairs nothing, so nothing schedules it.
	schedule: 'operator',
	applyRefused: {
		reason:
			'the correction is a DEFINITION edit on the master ontology, delivered to an installation by an ontology update (AGENTS.md: ontology definitions belong to the master ontology) — the engine never rewrites a dd_ontology request_config itself; the dry list names each definition to correct',
	},
	sources: ['src/core/relations/request_config/self_depth_check.ts'],
	run: runDeepSelfCheck,
};
