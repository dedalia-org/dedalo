/**
 * Ontology LABEL resolution — the dd_ontology.term → display-label lookup,
 * shared by structure-context, the section module, and the request_config ddo
 * enrichment. Extracted from resolve/structure_context.ts so the section
 * context/buttons split can resolve labels without importing back into the
 * structure-context builder (cycle-free).
 *
 * PHP reference: RecordObj_dd term resolution + common label fallback
 * (application lang first, then the first non-empty translation). Since
 * 2026-11-04 this module is the ONE home of the label chain (resolveLabel —
 * the duplicate chains in term_label.ts, resolver.ts getTermByTipo and
 * create_record.ts were folded into it) and of nameOrLabelOf, the reader of a
 * node's identifying string (WC-2026-11-04-ontology-machine-names).
 *
 * LABEL NODES: labelByTipo and termByTipo are guarded term resolvers — a
 * model='label' node is refused (dev/test throw, production log-once +
 * unresolved value, never cached). Guard + rationale: ./label_node_guard.ts.
 * The ONLY list of guarded homes is TERM_READ_LEDGER in
 * test/unit/term_by_tipo_label_guard.test.ts.
 */

import { config } from '../../config/config.ts';
import { incrementCounter } from '../api/counters.ts';
import { sql } from '../db/postgres.ts';
import { translationLangOf } from '../resolve/lang_alias.ts';
import { currentApplicationLang } from '../resolve/request_lang.ts';
import { createOntologyCache } from './cache_factory.ts';
import { registerOntologyCacheClearer } from './cache_invalidation.ts';
import { refuseLabelNode } from './label_node_guard.ts';
import { LEGACY_NAME_LANG } from './machine_name.ts';

/**
 * The ontology LABEL-FALLBACK language (config DEDALO_STRUCTURE_LANG): the
 * language a label falls back to when the requested one (and its declared
 * equivalent) is missing — Dédalo's shipped ontology labels are guaranteed in
 * Spanish. It is ONLY a label fallback: it never names a node (a model, table,
 * column or rdf name is dd_ontology.machine_name — machine_name.ts), never
 * files a registry row (ontology_tipos.ts REGISTRY_LANG) and is not a data or
 * interface default (those are request-scoped: currentDataLang() /
 * currentApplicationLang()). WC-2026-11-04-ontology-machine-names.
 */
export const ONTOLOGY_LABEL_FALLBACK_LANG = config.lang.structureLang;

/** A non-empty string value of a term map, else null (`''` is absent). */
function termValue(termMap: Record<string, unknown>, lang: string | null): string | null {
	if (lang === null) return null;
	const value = termMap[lang];
	return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * THE ontology label chain — the ONLY one (the menu, the section tool context,
 * the record metadata, the RAG title, the tree and the list cells all read it):
 *
 *   requested lang → its declared equivalent → ONTOLOGY_LABEL_FALLBACK_LANG
 *   → the first non-empty translation → the node's machine name → null
 *
 * The equivalent (PHP lang::get_label_lang via RecordObj_dd): ontology labels
 * are authored in the canonical member — Català — and the other members read
 * it; without that step a Valencian interface fell to an ARBITRARY language.
 * The machine name closes the chain: a name node (a table, a model) with no
 * labels shows its language-free name in every UI language. `''` counts as
 * absent at every step. `lang` defaults to the request-scoped application
 * language, so a user's interface-language choice re-labels every
 * ontology-derived title.
 */
export function resolveLabel(
	term: unknown,
	lang: string = currentApplicationLang(),
	machineName: string | null = null,
): string | null {
	const fromTerm =
		term !== null && typeof term === 'object'
			? labelFromTerm(term as Record<string, unknown>, lang)
			: null;
	if (fromTerm !== null) return fromTerm;
	return machineName === null || machineName === '' ? null : machineName;
}

/** The term steps of the chain (everything but the machine-name close). */
function labelFromTerm(termMap: Record<string, unknown>, lang: string): string | null {
	const direct =
		termValue(termMap, lang) ??
		termValue(termMap, translationLangOf(lang)) ??
		termValue(termMap, ONTOLOGY_LABEL_FALLBACK_LANG);
	return direct ?? firstNonEmptyValue(termMap);
}

/** The first non-empty string value of a term map (jsonb key order), or null. */
function firstNonEmptyValue(termMap: Record<string, unknown>): string | null {
	for (const value of Object.values(termMap)) {
		if (typeof value === 'string' && value !== '') return value;
	}
	return null;
}

/** What nameOrLabelOf reads off a node (a dd_ontology row or any projection of one). */
export interface NamedOntologyNode {
	term?: Record<string, string> | null;
	machine_name?: string | null;
	use_machine_name?: boolean | null;
}

/**
 * The identifying string of a node where a MIXED-class consumer meets it — the
 * diffusion walk (database / table / column / domain names next to element
 * labels), the published rdf file name, the rdf importer's class / predicate
 * names:
 *
 *  - use_machine_name true  → its machine_name, STRICT (null when the parser
 *    reported the name `missing` or a `collision` — a multi-valued guess
 *    refuses, it never picks a stray translation);
 *  - use_machine_name false → its label in ONTOLOGY_LABEL_FALLBACK_LANG (the
 *    label chain; a diffusion element is named by its label);
 *  - use_machine_name NULL / absent → a row no parser has derived yet (before
 *    migration 0015's boot derive finished, a tld whose derive failed, an
 *    in-memory node that does not state the pair): EXACTLY the pre-machine-name
 *    reading the deleted readers applied — the LEGACY_NAME_LANG (lg-spa) term,
 *    else the first non-empty value. Never the configurable label-fallback lang:
 *    that lang names nothing (with DEDALO_STRUCTURE_LANG=lg-eng an un-derived
 *    matrix_table row would otherwise resolve to its English stray). Counted
 *    (`ontology_machine_name_rung_underived_row`, G6).
 *
 * This replaced the three diffusion first-non-empty readers (virtual_tree
 * termLabelOf, diffusion_graph termOf, published_files publishedTermLabel),
 * so the publish and delete sides cannot name a node differently.
 */
export function nameOrLabelOf(node: NamedOntologyNode | null | undefined): string | null {
	if (node === null || node === undefined) return null;
	if (node.use_machine_name === true) return storedMachineName(node.machine_name);
	const term = node.term ?? null;
	if (node.use_machine_name === false) return resolveLabel(term, ONTOLOGY_LABEL_FALLBACK_LANG);
	incrementCounter('ontology_machine_name_rung_underived_row');
	return legacyNameReading(term);
}

/** A stored machine_name, `''` read as absent. */
function storedMachineName(name: string | null | undefined): string | null {
	return name === undefined || name === null || name === '' ? null : name;
}

/** The pre-machine-name reading of an un-derived row: lg-spa, else the first non-empty value. */
function legacyNameReading(term: Record<string, string> | null): string | null {
	const termMap = term ?? {};
	return termValue(termMap, LEGACY_NAME_LANG) ?? firstNonEmptyValue(termMap);
}

/**
 * Cached (lang, tipo) → label (dd_ontology.term). Keyed by language too: the
 * same tipo resolves to different labels per interface language, so a shared
 * per-tipo cache would bleed one user's language into another's (spec §4).
 */
const labelCache = createOntologyCache<string, string | null>();

/** Label lookup for one tipo (dd_ontology.term), cached per-process per-lang. */
export async function labelByTipo(
	tipo: string,
	lang: string = currentApplicationLang(),
): Promise<string | null> {
	const cacheKey = `${lang} ${tipo}`;
	const cached = labelCache.get(cacheKey);
	if (cached !== undefined) return cached;
	const rows = (await sql`
		SELECT term, model, machine_name FROM dd_ontology WHERE tipo = ${tipo} LIMIT 1
	`) as { term: unknown; model: string | null; machine_name: string | null }[];
	// Not cached when refused: a dev/test throw must recur on every call.
	if (refuseLabelNode(tipo, rows[0]?.model)) return null;
	const label = resolveLabel(rows[0]?.term ?? null, lang, rows[0]?.machine_name ?? null);
	labelCache.set(cacheKey, label);
	return label;
}

/** Clear the label cache (test isolation / cache-invalidation hooks). */
export function clearLabelCache(): void {
	labelCache.clear();
	termCache.clear();
	termRowCache.clear();
}
registerOntologyCacheClearer(clearLabelCache);

/**
 * Cached (lang, tipo) → display term. Factory-created (hub-cleared on every
 * dd_ontology write) — the S2-27 fix: the old canonical copy in
 * tm_record.ts was UNCACHED and called per-item in loops.
 */
const termCache = createOntologyCache<string, string>();

/**
 * The display term of one ontology node in `lang` (PHP get_term_by_tipo) —
 * THE canonical termByTipo (audit S2-27: this collapses the four parallel
 * resolvers; tm_record/ts_object copies are deleted, read_tm re-exports this
 * one for legacy importers). The label chain (resolveLabel), then the tipo
 * itself — labelByTipo answers null instead. A model='label' node throws in
 * dev/test and, in production, answers the tipo itself — this resolver's
 * existing "no term" value, so its `string` contract holds for every caller
 * (see refuseLabelNode). Never cached when refused.
 */
export async function termByTipo(tipo: string, lang: string): Promise<string> {
	const cacheKey = `${lang} ${tipo}`;
	const cached = termCache.get(cacheKey);
	if (cached !== undefined) return cached;
	const rows = (await sql`
		SELECT term, model, machine_name FROM dd_ontology WHERE tipo = ${tipo} LIMIT 1
	`) as {
		term: Record<string, string> | null;
		model: string | null;
		machine_name: string | null;
	}[];
	if (refuseLabelNode(tipo, rows[0]?.model)) return tipo;
	const resolved = resolveLabel(rows[0]?.term ?? null, lang, rows[0]?.machine_name ?? null) ?? tipo;
	termCache.set(cacheKey, resolved);
	return resolved;
}

/**
 * The display label for a value that IS an ontology tipo: `«term» [tipo]`.
 *
 * Several columns store a tipo as their value and must show which node it is —
 * two nodes routinely share a term, so the term alone is ambiguous. PHP renders
 * them all the same way; TS had the transform written out three times (the TM
 * What column inside its emitter, the dd542 Activity `where` column inside
 * emitDdoData, and nowhere at all for the TM Where column, which therefore
 * showed a bare term). One helper, one shape
 * (WC-2026-08-14-tm-cells-obey-list-emit-policy).
 */
export async function ontologyTermLabel(tipo: string, lang: string): Promise<string> {
	return `${await termByTipo(tipo, lang)} [${tipo}]`;
}

/**
 * Raw `{term, machine_name}` rows for the section_tool ddo_map label stamps
 * (moved here from the retired ontology/term_label.ts, 2026-11-04, so the menu
 * and the section_tool enrichment read the ONE label chain). The per-entry
 * SELECT was the DOMINANT surviving menu cost after the walk cache (~30
 * queries per read across the 6 section_tool nodes, measured 2026-07-09).
 * Lang-free raw rows — resolveLabel applies the per-request application lang
 * downstream. Factory-created, hub-cleared with the other label caches.
 */
/** The two columns the label chain reads off a dd_ontology row. */
interface LabelRow {
	term: Record<string, string> | null;
	machine_name: string | null;
}

const termRowCache = createOntologyCache<string, LabelRow | null>();

/**
 * The app-lang display term of one ontology node (PHP get_term_by_tipo), ''
 * when the chain finds nothing. A model='label' node is refused
 * (refuseLabelNode, ./label_node_guard.ts): dev/test throw; production logs
 * once and answers '' (this resolver's empty-term value). A refusal is NOT
 * cached — only resolvable rows enter termRowCache, so a dev/test throw recurs
 * on every call.
 */
export async function getOntologyTermLabel(tipo: string): Promise<string> {
	// has() (not get()) — an unknown tipo caches null.
	if (termRowCache.has(tipo)) return appLangLabelOfRow(termRowCache.get(tipo) ?? null);
	const rows = (await sql.unsafe(
		'SELECT term, model, machine_name FROM dd_ontology WHERE tipo = $1',
		[tipo],
	)) as (LabelRow & { model: string | null })[];
	const found = rows[0];
	if (refuseLabelNode(tipo, found?.model)) return '';
	const row = found === undefined ? null : { term: found.term, machine_name: found.machine_name };
	termRowCache.set(tipo, row);
	return appLangLabelOfRow(row);
}

/** The application-lang label of a cached row, '' when the chain finds nothing. */
function appLangLabelOfRow(row: LabelRow | null): string {
	if (row === null) return '';
	return resolveLabel(row.term, currentApplicationLang(), row.machine_name) ?? '';
}
