/**
 * Rewriter semantics — the compile-time parser fns, executed by the RESOLVER
 * (DIFFUSION_SPEC §5.1, DIFFUSION_PLAN D3-P1).
 *
 * The plan compiler classifies these fns 'rewriter' and records them as
 * 'rewriter:<fn>@<field>' warnings; their REAL semantics run here, against the
 * typed chains the resolver produced (ResolvedLink[] with prefetched terms and
 * ancestor paths), through the same chain machine as the runtime parsers
 * (transform.ts extraFns). Oracle bodies: old engine
 * diffusion/api/v1/lib/parsers/parser_locator.ts (parents :455-624,
 * get_locator :357-410, map_section_tipo_to_name :199-228, chain ops
 * :744-911) and parser_global.ts (publication_unix_timestamp :68-73).
 *
 * Differences from the oracle plumbing (semantics preserved):
 * - the oracle's parents read an `item.meta` map keyed by term_id; here the
 *   ancestor path IS the chain atom's links array ([self, parent, …, root]),
 *   each link carrying a prefetched per-lang term record;
 * - map_section_tipo_to_name falls back to the PLAN's section→table lookup
 *   when the ontology step carries no options.map (spec §5.1: plan tables);
 * - parent_end_by_typology_term_id IS ported: the resolver prefetches each
 *   ancestor link's typologyTermId (PHP resolve_map_node_data — section_map
 *   'model' element first locator) and the truncation compares against it;
 * - the remaining typology options (truncate_by_model, value:'typology*') are
 *   NOT ported yet — they throw a named error the resolver collects per field
 *   (never a silent wrong value; ledgered in the run report).
 */

import { DedaloError } from '../../core/errors/index.ts';
import type { MetaValueIR } from '../parsers/types.ts';
import type { ResolvedLink, ValueIR } from './record_ir.ts';
import type { ExtraStepFn } from './transform.ts';

/** Environment the resolver closes the rewriter table over. */
export interface RewriterEnv {
	/** Plan lookup: section_tipo → published table name (map_section_tipo_to_name). */
	planTables: ReadonlyMap<string, string>;
	/** Run-scoped publish timestamp (epoch SECONDS — determinism, never Date.now). */
	runStartedAt: number;
}

/**
 * Rewriter fns that would need typology data we do not resolve yet. A thin
 * DedaloError family (ERRORS_SPEC §2.1): the code is FIXED, the old sentence
 * stays `Error.message` for the log, and `instanceof` catch sites — plus
 * `isErrorInDomain(e, 'diffusion')` — keep working unchanged.
 */
export class UnsupportedRewriterError extends DedaloError {
	constructor(fn: string, detail: string) {
		super('diffusion.unported_fn', {
			message: `diffusion rewriter '${fn}': ${detail} — not ported yet (ledgered, fails loud)`,
			coordinates: { fn },
		});
		this.name = 'UnsupportedRewriterError';
	}
}

/** "{section_tipo}_{section_id}" or null (oracle term_id_from_locator :923). */
function termIdOfLink(link: ResolvedLink): string | null {
	return link.sectionTipo && link.sectionId !== undefined && link.sectionId !== null
		? `${link.sectionTipo}_${link.sectionId}`
		: null;
}

/** The chain links of an atom (non-chain atoms carry none). */
function linksOf(atom: MetaValueIR): ResolvedLink[] {
	return atom.kind === 'chain' ? atom.links : [];
}

/** Rebuild a chain atom with transformed links, dropping emptied atoms. */
function mapChains(
	values: MetaValueIR[],
	transform: (links: ResolvedLink[]) => ResolvedLink[],
): MetaValueIR[] {
	const out: MetaValueIR[] = [];
	for (const atom of values) {
		if (atom.kind !== 'chain') {
			out.push(atom);
			continue;
		}
		out.push({ ...atom, links: transform(atom.links) });
	}
	return out;
}

// ---------------------------------------------------------------------------
// Chain filter helpers (oracle apply_chain_filters :633-695 — same order).
// ---------------------------------------------------------------------------

function truncateByTermId(links: ResolvedLink[], endIds: string[]): ResolvedLink[] {
	const endSet = new Set(endIds);
	const out: ResolvedLink[] = [];
	for (const link of links) {
		const termId = termIdOfLink(link);
		if (termId !== null && endSet.has(termId)) break;
		out.push(link);
	}
	return out;
}

function filterBySectionTipo(links: ResolvedLink[], target: unknown): ResolvedLink[] {
	const targetSet = new Set(Array.isArray(target) ? (target as string[]) : [String(target)]);
	return links.filter((link) => targetSet.has(link.sectionTipo));
}

function filterByTermId(links: ResolvedLink[], target: unknown): ResolvedLink[] {
	const targetSet = new Set(Array.isArray(target) ? (target as string[]) : [String(target)]);
	return links.filter((link) => {
		const termId = termIdOfLink(link);
		return termId !== null && targetSet.has(termId);
	});
}

/** PHP array_splice on parents[1..] with self preserved (oracle :832-856). */
function spliceChain(links: ResolvedLink[], args: number[]): ResolvedLink[] {
	if (links.length === 0) return links;
	const self = links[0] as ResolvedLink;
	const parents = links.slice(1);
	const start = args[0] ?? 0;
	if (args.length === 1) {
		parents.splice(start);
	} else {
		let deleteCount = args[1] ?? 0;
		if (deleteCount < 0) deleteCount = Math.max(0, parents.length - start + deleteCount);
		parents.splice(start, deleteCount);
	}
	return [self, ...parents];
}

/** PHP array_slice semantics (oracle slice_array :866-878). */
function sliceArray(links: ResolvedLink[], args: number[]): ResolvedLink[] {
	const startArg = args[0] ?? 0;
	const lengthArg = args.length > 1 ? args[1] : undefined;
	const start = startArg < 0 ? Math.max(links.length + startArg, 0) : startArg;
	let end = links.length;
	if (lengthArg !== undefined && lengthArg !== null) {
		end = lengthArg < 0 ? links.length + lengthArg : start + lengthArg;
	}
	return links.slice(start, Math.max(start, end));
}

/** The unified filter pass the parents fn applies per chain (oracle order). */
function applyChainFilters(
	links: ResolvedLink[],
	options: Record<string, unknown>,
): ResolvedLink[] {
	let processed = [...links];
	let truncated = false;

	const endIds = options.parent_end_by_term_id;
	if (Array.isArray(endIds) && endIds.length > 0) {
		const before = processed.length;
		processed = truncateByTermId(processed, endIds as string[]);
		truncated = processed.length < before;
	}
	const endTypologyIds = options.parent_end_by_typology_term_id;
	if (Array.isArray(endTypologyIds) && endTypologyIds.length > 0) {
		// Oracle :657-669: cut the chain at the first node whose TYPOLOGY term
		// id matches (node excluded). The resolver prefetches typologyTermId on
		// every ancestor link (section_map 'model' element first locator).
		const endSet = new Set(endTypologyIds as string[]);
		const out: ResolvedLink[] = [];
		for (const link of processed) {
			if (link.typologyTermId != null && endSet.has(link.typologyTermId)) {
				truncated = true;
				break;
			}
			out.push(link);
		}
		processed = out;
	}
	if (options.parent_section_tipo) {
		processed = filterBySectionTipo(processed, options.parent_section_tipo);
	}
	if (options.parent_term_id) {
		processed = filterByTermId(processed, options.parent_term_id);
	}
	const spliceArgs = options.parents_splice;
	if (!truncated && Array.isArray(spliceArgs) && spliceArgs.length > 0) {
		processed = spliceChain(processed, spliceArgs as number[]);
	}
	const sliceArgs = options.parents_slice;
	if (!truncated && Array.isArray(sliceArgs) && sliceArgs.length > 0) {
		processed = sliceArray(processed, sliceArgs as number[]);
	}
	return processed;
}

// ---------------------------------------------------------------------------
// parents (oracle :455-624)
// ---------------------------------------------------------------------------

/**
 * Term of one chain node in `lang`: exact → main_lang → lg-nolan BASE →
 * first PROJECT lang.
 *
 * The lg-nolan rung is the TRANSLITERABLE fallback (with_lang_versions /
 * component_iri term components: an lg-nolan base plus per-language versions,
 * "Augustus" + lg-ell "Αύγουστος"). v6 resolves the term with a component
 * instance IN the row lang and, when that is empty, walks
 * component_common::get_value_with_fallback_from_dato_full (v6
 * class.component_common.php:3079-3140): direct → main lang → NOLAN → project
 * langs. Without the rung the project-lang walk handed every row whose lang
 * has no version the first VERSION in project order (the Greek name in the
 * Spanish row) instead of the base. Byte-neutral for every other term: a
 * translatable term holds no lg-nolan key, and a nolan-only term reached the
 * same value through the last rung.
 *
 * The last rung must walk the PUBLICATION LANGS in their configured order, not
 * whatever order the stored term object happens to enumerate. v6's fallback
 * loops common::get_ar_all_langs() (component_input_text::get_diffusion_value
 * :298-315), so a value stored under a lang OUTSIDE the project list is
 * invisible to it. The place term of dz1/1143 holds only lg-ara ("وھران") and
 * lg-fra ("Oran"); v6 publishes Oran because lg-fra is a project lang, while
 * Object.values order handed v7 the Arabic one — visible in informant
 * birthplace, birthplace_municipality, cut_birthplace and search_data.
 */
export function nodeTermForLang(
	link: ResolvedLink,
	lang: string,
	mainLang: string | null,
	projectLangs?: readonly string[],
): string {
	const term = link.term;
	if (term === undefined || term === null) return '';
	const exact = term[lang];
	if (typeof exact === 'string' && exact !== '') return exact;
	if (mainLang !== null) {
		const main = term[mainLang];
		if (typeof main === 'string' && main !== '') return main;
	}
	const nolan = term['lg-nolan'];
	if (typeof nolan === 'string' && nolan !== '') return nolan;
	if (projectLangs !== undefined) {
		for (const candidate of projectLangs) {
			const value = term[candidate];
			if (typeof value === 'string' && value !== '') return value;
		}
	}
	for (const value of Object.values(term)) {
		if (typeof value === 'string' && value !== '') return value;
	}
	return '';
}

function parentsFn(env: RewriterEnv): ExtraStepFn {
	return (values, options, ctx) => {
		void env;
		if (values.length === 0) return [];

		const valueToExtract = (options.value as string | undefined) ?? 'term';
		if (valueToExtract.startsWith('typology')) {
			throw new UnsupportedRewriterError(
				'parser_locator::parents',
				`value '${valueToExtract}' needs typology resolution`,
			);
		}
		const includeParents = (options.include_parents as boolean | undefined) ?? true;
		const includeSelf = (options.include_self as boolean | undefined) ?? true;
		const fieldsSeparator = (options.fields_separator as string | undefined) ?? ', ';
		const recordsSeparator = (options.records_separator as string | undefined) ?? ' - ';
		const mergeStyle =
			(options.merge as string | undefined) ?? (valueToExtract === 'term' ? 'string' : undefined);

		// Accumulate every locator's chain into one per-lang store (oracle
		// :473-480 — per-item emission would keep only the last locator).
		const langNodes = new Map<string, string[][]>();
		const pushChain = (lang: string, chain: string[]): void => {
			const bucket = langNodes.get(lang);
			if (bucket === undefined) langNodes.set(lang, [chain]);
			else bucket.push(chain);
		};

		for (const atom of values) {
			const chain = linksOf(atom);
			if (chain.length === 0) continue;

			const filtered = applyChainFilters(chain, options);
			if (filtered.length === 0) continue;

			const startIdx = includeSelf ? 0 : 1;
			const endIdx = includeParents ? filtered.length : includeSelf ? 1 : 0;
			if (startIdx >= filtered.length || (endIdx <= startIdx && includeParents)) continue;
			const nodes = filtered.slice(startIdx, endIdx === 0 && !includeParents ? 1 : endIdx);
			if (nodes.length === 0) continue;

			if (valueToExtract === 'term') {
				for (const lang of ctx.langs) {
					const chainValues: string[] = [];
					for (const node of nodes) {
						const term = nodeTermForLang(node, lang, ctx.mainLang, ctx.langs);
						if (term !== '') chainValues.push(term);
					}
					if (chainValues.length > 0) pushChain(lang, chainValues);
				}
			} else {
				const chainValues: string[] = [];
				for (const node of nodes) {
					let extracted: string | null = null;
					if (valueToExtract === 'term_id') extracted = termIdOfLink(node);
					else if (valueToExtract === 'section_id') extracted = String(node.sectionId);
					if (extracted !== null && extracted !== '') chainValues.push(extracted);
				}
				if (chainValues.length > 0) pushChain('__nolan__', chainValues);
			}
		}

		const first = values[0] as MetaValueIR;
		const result: MetaValueIR[] = [];
		for (const [lang, chains] of langNodes) {
			const chainStrings = chains
				.map((chain) => chain.join(fieldsSeparator))
				.filter((joined) => joined.length > 0);
			if (chainStrings.length === 0) continue;

			let finalValue: unknown;
			if (mergeStyle === 'unique') {
				// v6 emits one label per parent, NEVER deduplicated (oracle :600-607).
				finalValue = chains.flat();
			} else if (mergeStyle === 'flat') {
				finalValue = chainStrings;
			} else {
				finalValue = chainStrings.join(recordsSeparator);
			}

			const atomLang = lang === '__nolan__' ? null : lang;
			const atom: MetaValueIR =
				typeof finalValue === 'string'
					? { kind: 'scalar', value: finalValue, lang: atomLang }
					: { kind: 'json', value: finalValue, lang: atomLang };
			if (first.meta) atom.meta = first.meta;
			result.push(atom);
		}
		return result;
	};
}

// ---------------------------------------------------------------------------
// get_locator (oracle :357-410)
// ---------------------------------------------------------------------------

/**
 * Optional relation-edge extras a link may carry from the stored locator.
 * ResolvedLink now declares these directly (they are populated from
 * parseInverseEntry's reconstructed dd96 edge); the alias is kept so the
 * projection below reads as "the edge half" of the link.
 */
type LinkExtras = Pick<
	ResolvedLink,
	| 'type'
	| 'tagId'
	| 'tagType'
	| 'componentTipo'
	| 'sectionTopId'
	| 'sectionTopTipo'
	| 'fromComponentTopTipo'
>;

function getLocatorFn(): ExtraStepFn {
	return (values, options) => {
		// EMPTY DECLARED LABEL LIST — an OPTION, not a new fn: the registry is
		// pinned to oracle-registered fns ("no gaps, no extras"), so this rides on
		// get_locator exactly like v6_raw_dato and index_meta do.
		if (options.empty_label_join === true) return emptyLabelJoin(values, options);

		if (values.length === 0) return [];
		const withMeta = options.with_meta === true;
		const indexMeta = options.index_meta === true;
		const indexFromComponentTipo = (options.from_component_tipo as string | undefined) ?? null;

		const result: MetaValueIR[] = [];
		for (const atom of values) {
			const links = linksOf(atom);
			const locators = links
				.filter((link) => link.sectionTipo != null || link.sectionId != null)
				.map((link) => {
					const extras = link as ResolvedLink & LinkExtras;
					if (options.v6_raw_dato === true) {
						// component_common::get_dato through diffusion_sql::resolve_component_value:
						// the STORED locator, republished as-is. v6 key order, `id` dropped (a v7
						// per-item counter that never existed in the v6 payload) and section_id back
						// to its published STRING form (WC-2026-08-10 made it int-canonical in
						// storage only). Emitting only the address half published `[null]`.
						const locator: Record<string, unknown> = {};
						// A dd96 INDEX EDGE stored on a relation_index component carries the
						// whole edge, and get_dato() republishes all nine keys in the order
						// they were STORED — which is NOT the index_meta construction order
						// below (section_tipo precedes section_id, tag_id follows
						// component_tipo, and the two from_* keys are reversed). Emitting
						// only the address half dropped component_tipo, section_top_id,
						// section_top_tipo and from_component_top_tipo from
						// games.indexations_related on every populated row.
						//
						// Gated on the edge extras actually being present, so a PLAIN stored
						// locator — the text_area reference lists (abstract_references,
						// body_references) that share this projection and already match —
						// keeps its shorter shape and key order untouched.
						const isIndexEdge =
							extras.componentTipo != null ||
							extras.sectionTopId != null ||
							extras.sectionTopTipo != null ||
							extras.fromComponentTopTipo != null;
						if (isIndexEdge) {
							if (extras.type != null) locator.type = extras.type;
							locator.section_tipo = String(link.sectionTipo);
							locator.section_id = String(link.sectionId);
							if (extras.componentTipo != null) locator.component_tipo = extras.componentTipo;
							if (extras.tagId != null) locator.tag_id = String(extras.tagId);
							if (extras.sectionTopId != null) {
								locator.section_top_id = String(extras.sectionTopId);
							}
							if (extras.sectionTopTipo != null) {
								locator.section_top_tipo = extras.sectionTopTipo;
							}
							if (extras.fromComponentTopTipo != null) {
								locator.from_component_top_tipo = extras.fromComponentTopTipo;
							}
							if (link.fromComponentTipo != null) {
								locator.from_component_tipo = link.fromComponentTipo;
							}
							return locator;
						}
						if (extras.type != null) locator.type = extras.type;
						if (extras.tagId != null) locator.tag_id = String(extras.tagId);
						if (extras.tagType != null) locator.tag_type = extras.tagType;
						locator.section_id = String(link.sectionId);
						locator.section_tipo = String(link.sectionTipo);
						if (link.fromComponentTipo != null) {
							locator.from_component_tipo = link.fromComponentTipo;
						}
						return locator;
					}
					if (indexMeta) {
						// v6 component_relation_index key order preserved exactly:
						// type, tag_id, section_id, section_tipo, component_tipo,
						// section_top_id, section_top_tipo, from_component_tipo,
						// from_component_top_tipo. Scalars stay STRINGS: v6 published
						// the DB-driver string form and already-published consumers
						// read them as strings.
						const locator: Record<string, unknown> = {};
						if (extras.type != null) locator.type = extras.type;
						if (extras.tagId != null) locator.tag_id = String(extras.tagId);
						locator.section_id = String(link.sectionId);
						locator.section_tipo = String(link.sectionTipo);
						if (extras.componentTipo != null) locator.component_tipo = extras.componentTipo;
						if (extras.sectionTopId != null) {
							locator.section_top_id = String(extras.sectionTopId);
						}
						if (extras.sectionTopTipo != null) {
							locator.section_top_tipo = extras.sectionTopTipo;
						}
						const fromTipo = link.fromComponentTipo ?? indexFromComponentTipo;
						if (fromTipo != null) locator.from_component_tipo = fromTipo;
						if (extras.fromComponentTopTipo != null) {
							locator.from_component_top_tipo = extras.fromComponentTopTipo;
						}
						return locator;
					}
					const locator: Record<string, unknown> = {
						section_tipo: String(link.sectionTipo),
						section_id: String(link.sectionId),
					};
					if (withMeta) {
						if (link.fromComponentTipo != null)
							locator.from_component_tipo = link.fromComponentTipo;
						if (extras.type != null) locator.type = extras.type;
					}
					return locator;
				});
			result.push({ kind: 'json', value: locators, lang: null, meta: atom.meta });
		}

		// v6 relation_list grouped inverse refs by source section — stable sort
		// by the first locator's section_tipo (oracle :403-407).
		result.sort((a, b) => {
			const firstOf = (atom: MetaValueIR): string => {
				const value = (atom as { value?: unknown }).value;
				const head = Array.isArray(value) ? (value[0] as { section_tipo?: string }) : undefined;
				return head?.section_tipo ?? '';
			};
			const sa = firstOf(a);
			const sb = firstOf(b);
			return sa < sb ? -1 : sa > sb ? 1 : 0;
		});
		return result;
	};
}

// ---------------------------------------------------------------------------
// map_section_tipo_to_name (oracle :199-228) — plan tables as the map source.
// ---------------------------------------------------------------------------

function mapSectionTipoToNameFn(env: RewriterEnv): ExtraStepFn {
	return (values, options) => {
		if (values.length === 0) return [];
		const optionMap = options.map as Record<string, string> | undefined;
		const lookup = (sectionTipo: string): string | undefined =>
			optionMap && typeof optionMap === 'object'
				? optionMap[sectionTipo]
				: env.planTables.get(sectionTipo);

		const result: MetaValueIR[] = [];
		for (const atom of values) {
			const mapped: string[] = [];
			for (const link of linksOf(atom)) {
				const name = lookup(link.sectionTipo);
				if (name !== undefined) mapped.push(name);
			}
			result.push({ kind: 'json', value: mapped, lang: null, meta: atom.meta });
		}
		return result;
	};
}

// ---------------------------------------------------------------------------
// Table assembly
// ---------------------------------------------------------------------------

/**
 * Build the rewriter fn table for one run. merge_columns is deliberately
 * ABSENT: it is a record-level synthetic field (needs every other column of
 * the record) handled by the resolver's deferred pass — a chain containing it
 * never reaches the transform machine.
 */
/**
 * EMPTY LABEL JOIN — v6's autocomplete label for a component that declares NO
 * related components.
 *
 * v5_component_autocomplete.php's $_get_valor reads the label parts from
 * RecordObj_dd::get_relaciones() (:46-57). When that list is empty the inner
 * loop never runs and every locator's label is implode(sep, []) === '' — and
 * the empty-value skip that would drop them is COMMENTED OUT (:111-119), so the
 * labels are still joined: three locators publish " |  | ".
 * resolve_value then stores the joined string only when it is non-empty
 * (class.diffusion_sql.php :5264) and nulls a wholly empty result (:5307), so a
 * SINGLE locator yields NULL instead of ''.
 *
 * That is the whole rule, and it is why publications.other_people_full_names is
 * " |  | " while bibliographic_references.ref_publications_other_people_name —
 * same component, one locator — is NULL.
 */
function emptyLabelJoin(values: MetaValueIR[], options: Record<string, unknown>): MetaValueIR[] {
	{
		const separator = (options.fields_separator as string | undefined) ?? ' | ';
		let count = 0;
		for (const atom of values) {
			const links = linksOf(atom);
			count += links.length > 0 ? links.length : 1;
		}
		if (count === 0) return [];
		const joined = new Array(count).fill('').join(separator);
		// '' (a single locator) is v6's empty_value → the column publishes NULL.
		if (joined === '') return [];
		return [{ kind: 'scalar', value: joined, lang: null, meta: values[0]?.meta ?? {} }];
	}
}

export function buildRewriterFns(env: RewriterEnv): ReadonlyMap<string, ExtraStepFn> {
	const unsupported =
		(fn: string, detail: string): ExtraStepFn =>
		() => {
			throw new UnsupportedRewriterError(fn, detail);
		};

	return new Map<string, ExtraStepFn>([
		['parser_locator::parents', parentsFn(env)],
		['parser_locator::get_locator', getLocatorFn()],
		['parser_locator::map_section_tipo_to_name', mapSectionTipoToNameFn(env)],
		[
			'parser_locator::truncate_by_term_id',
			(values, options) => {
				const endIds = options.parent_end_by_term_id;
				if (!Array.isArray(endIds) || endIds.length === 0) return values;
				return mapChains(values, (links) => truncateByTermId(links, endIds as string[]));
			},
		],
		[
			'parser_locator::filter_by_section_tipo',
			(values, options) => {
				if (!options.parent_section_tipo) return values;
				return mapChains(values, (links) =>
					filterBySectionTipo(links, options.parent_section_tipo),
				);
			},
		],
		[
			'parser_locator::filter_parents_by_term_id',
			(values, options) => {
				if (!options.parent_term_id) return values;
				return mapChains(values, (links) => filterByTermId(links, options.parent_term_id));
			},
		],
		[
			'parser_locator::slice_chain',
			(values, options) => {
				const sliceArgs = options.parents_slice;
				if (!Array.isArray(sliceArgs) || sliceArgs.length === 0) return values;
				return mapChains(values, (links) => sliceArray(links, sliceArgs as number[]));
			},
		],
		[
			'parser_locator::truncate_by_model',
			unsupported('parser_locator::truncate_by_model', 'needs typology resolution'),
		],
		[
			'parser_global::publication_unix_timestamp',
			() => [{ kind: 'scalar', value: env.runStartedAt, lang: null }] as ValueIR[] as MetaValueIR[],
		],
	]);
}
