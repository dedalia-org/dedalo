/**
 * Parser registry — the fn-name compatibility surface, split (DIFFUSION_SPEC §5).
 *
 * Institution ontologies (dd1190 diffusion properties) reference parsers by
 * `"class::method"` strings. Every fn name the OLD engine registered
 * (oracle diffusion/api/v1/lib/parsers/index.ts:36-68) stays RESOLVABLE here,
 * but each name is classified:
 *
 * - 'runtime'  — a genuine pure value transform; lives in RUNTIME_PARSERS and
 *   executes per record on resolved ValueIR atoms.
 * - 'rewriter' — consumed by the plan compiler into plan structure (chain
 *   transform options, lookup tables, synthetic fields, system source steps);
 *   it NEVER executes at runtime, so it has no entry in RUNTIME_PARSERS.
 *
 * A name absent from PARSER_CLASSIFICATION is 'unknown' — plan validation
 * must surface that as a loud compile error (spec §5: never a silent skip;
 * the old engine's silent default_join fallback is deliberately killed).
 */

import { asRuntimeParser } from './item_bridge.ts';
import {
	dateDefault,
	formatStringDate,
	selectKeys,
	selectProperties,
	stringDate,
	unixTimestamp,
} from './parser_date.ts';
import { count, getFirst, getTail, merge } from './parser_helper.ts';
import {
	getSectionId,
	getSectionIdGrouped,
	getSectionTipo,
	getTermId,
	getV6SectionId,
} from './parser_locator.ts';
import { geoGeojson, infoDefault, infoWidget, iriFlat, mapCustom } from './parser_misc.ts';
import { defaultJoin, mapValue, textFormat, v5Html } from './parser_text.ts';
import type { RuntimeParserFn } from './types.ts';

export type { ParserContext, RuntimeParserFn } from './types.ts';

/** How a registered fn name participates in the new engine. */
export type ParserClassification = 'runtime' | 'rewriter';

/**
 * EVERY fn name the old engine registered, classified. Enumerated 1:1 from
 * the oracle registry (lib/parsers/index.ts:36-68) — the unit gate diffs the
 * two lists, so adding/removing a name there must be mirrored here.
 */
export const PARSER_CLASSIFICATION: ReadonlyMap<string, ParserClassification> = new Map<
	string,
	ParserClassification
>([
	// -- runtime survivors: pure value transforms --------------------------
	['parser_helper::get_first', 'runtime'],
	['parser_helper::get_tail', 'runtime'],
	['parser_helper::count', 'runtime'],
	['parser_helper::merge', 'runtime'],
	['parser_text::default_join', 'runtime'],
	['parser_text::text_format', 'runtime'],
	['parser_text::map_value', 'runtime'],
	['parser_text::v5_html', 'runtime'],
	// the trivial locator projections keep their community names, now over chains
	['parser_locator::get_section_id', 'runtime'],
	// v6-compat twin of get_section_id: same projection, value emitted as a STRING
	// so a migrated column publishes ["1"] where the v7-native one publishes [1].
	['parser_locator::get_v6_section_id', 'runtime'],
	['parser_locator::get_section_tipo', 'runtime'],
	['parser_locator::get_term_id', 'runtime'],
	['parser_locator::get_section_id_grouped', 'runtime'],
	['parser_date::select_properties', 'runtime'],
	['parser_date::select_keys', 'runtime'],
	['parser_date::format_string_date', 'runtime'],
	['parser_date::string_date', 'runtime'],
	['parser_date::unix_timestamp', 'runtime'],
	['parser_date::default', 'runtime'],
	['parser_info::widget', 'runtime'],
	['parser_info::default', 'runtime'],
	['parser_iri::flat', 'runtime'],
	['parser_geo::geojson', 'runtime'],
	['parser_map::custom', 'runtime'],

	// -- compile-time rewriters: consumed into plan structure --------------
	// locator re-synthesis is dead — the IR keeps typed chains end to end
	['parser_locator::get_locator', 'rewriter'],
	// chain ops → chain-transform options on the ResolveStep
	['parser_locator::parents', 'rewriter'],
	['parser_locator::filter_parents_by_term_id', 'rewriter'],
	['parser_locator::truncate_by_term_id', 'rewriter'],
	['parser_locator::truncate_by_model', 'rewriter'],
	['parser_locator::filter_by_section_tipo', 'rewriter'],
	['parser_locator::slice_chain', 'rewriter'],
	// options.map → plan lookup tables
	['parser_locator::map_section_tipo_to_name', 'rewriter'],
	// → synthetic merged plan fields
	['parser_global::merge_columns', 'rewriter'],
	// → a {kind:'system'} source step (single run-scoped timestamp)
	['parser_global::publication_unix_timestamp', 'rewriter'],
]);

/**
 * Classify a fn string from an ontology. 'unknown' is a compile ERROR at the
 * plan-validation chokepoint — callers must never treat it as a no-op.
 */
export function classifyParserFn(fn: string): ParserClassification | 'unknown' {
	return PARSER_CLASSIFICATION.get(fn) ?? 'unknown';
}

/** The runtime survivors, keyed by their community fn name. */
export const RUNTIME_PARSERS: ReadonlyMap<string, RuntimeParserFn> = new Map<
	string,
	RuntimeParserFn
>([
	['parser_helper::get_first', asRuntimeParser(getFirst)],
	['parser_helper::get_tail', asRuntimeParser(getTail)],
	['parser_helper::count', asRuntimeParser(count)],
	['parser_helper::merge', asRuntimeParser(merge)],
	['parser_text::default_join', asRuntimeParser(defaultJoin)],
	['parser_text::text_format', asRuntimeParser(textFormat)],
	['parser_text::map_value', asRuntimeParser(mapValue)],
	['parser_text::v5_html', asRuntimeParser(v5Html)],
	['parser_locator::get_section_id', asRuntimeParser(getSectionId)],
	['parser_locator::get_v6_section_id', asRuntimeParser(getV6SectionId)],
	['parser_locator::get_section_tipo', asRuntimeParser(getSectionTipo)],
	['parser_locator::get_term_id', asRuntimeParser(getTermId)],
	['parser_locator::get_section_id_grouped', asRuntimeParser(getSectionIdGrouped)],
	['parser_date::select_properties', asRuntimeParser(selectProperties)],
	['parser_date::select_keys', asRuntimeParser(selectKeys)],
	['parser_date::format_string_date', asRuntimeParser(formatStringDate)],
	['parser_date::string_date', asRuntimeParser(stringDate)],
	['parser_date::unix_timestamp', asRuntimeParser(unixTimestamp)],
	['parser_date::default', asRuntimeParser(dateDefault)],
	['parser_info::widget', asRuntimeParser(infoWidget)],
	['parser_info::default', asRuntimeParser(infoDefault)],
	['parser_iri::flat', asRuntimeParser(iriFlat)],
	['parser_geo::geojson', asRuntimeParser(geoGeojson)],
	['parser_map::custom', asRuntimeParser(mapCustom)],
]);

// Fail-loud invariant at module load: the two maps must agree exactly.
// A 'runtime' name without an implementation would silently drop values; a
// 'rewriter' with an implementation means the split was decided twice.
for (const [fn, classification] of PARSER_CLASSIFICATION) {
	const implemented = RUNTIME_PARSERS.has(fn);
	if (classification === 'runtime' && !implemented) {
		throw new Error(`parser registry: '${fn}' classified runtime but not implemented`);
	}
	if (classification === 'rewriter' && implemented) {
		throw new Error(`parser registry: '${fn}' classified rewriter but has a runtime body`);
	}
}
for (const fn of RUNTIME_PARSERS.keys()) {
	if (!PARSER_CLASSIFICATION.has(fn)) {
		throw new Error(`parser registry: '${fn}' implemented but not classified`);
	}
}
