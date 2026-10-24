/**
 * Runtime parsers — parser_helper family.
 * Oracle: diffusion/api/v1/lib/parsers/parser_helper.ts (behavior parity).
 *
 * get_first / get_tail / count / merge are genuine runtime value transforms.
 * This module also hosts the shared ${placeholder} pattern replacer used by
 * parser_text::text_format (oracle port of PHP class.pattern_replacer.php).
 */

import { stripTags } from '../../core/resolve/html_text.ts';
import { phpTrim } from './php_string.ts';
import type { ItemParserFn, ParserItem } from './types.ts';

// ---------------------------------------------------------------------------
// get_first — first item per language
// ---------------------------------------------------------------------------

/**
 * Keeps only the FIRST item of each language group (nolan is its own group).
 * Array values collapse to their first element; a diffusion_data_object
 * wrapper ({errors,tipo,value,id}) is unwrapped to its scalar .value so
 * int/string output formats the value, not "[object Object]".
 */
export const getFirst: ItemParserFn = (items) => {
	if (!items || items.length === 0) return null;

	const langSeen = new Set<string>();
	const result: ParserItem[] = [];

	for (const item of items) {
		const lang = item.lang ?? '__nolan__';
		if (langSeen.has(lang)) continue;
		langSeen.add(lang);

		const val = item.value;
		let finalVal: unknown = Array.isArray(val) && val.length > 0 ? val[0] : val;
		// Unwrap the dd-object shape only (guarded, oracle parser_helper.ts:37-40)
		if (
			finalVal &&
			typeof finalVal === 'object' &&
			!Array.isArray(finalVal) &&
			'value' in finalVal &&
			('errors' in finalVal || 'id' in finalVal || 'tipo' in finalVal)
		) {
			finalVal = (finalVal as { value: unknown }).value;
		}

		result.push({ ...item, value: finalVal });
	}

	return result.length > 0 ? result : null;
};

// ---------------------------------------------------------------------------
// get_tail — everything but the first item, per language
// ---------------------------------------------------------------------------

/** Complement of get_first: drops the first item of each language group. */
export const getTail: ItemParserFn = (items) => {
	if (!items || items.length === 0) return null;

	const langSeen = new Set<string>();
	const result: ParserItem[] = [];

	for (const item of items) {
		const lang = item.lang ?? '__nolan__';
		if (langSeen.has(lang)) {
			result.push(item);
		} else {
			langSeen.add(lang);
		}
	}

	return result.length > 0 ? result : null;
};

// ---------------------------------------------------------------------------
// count — total number of data elements
// ---------------------------------------------------------------------------

/**
 * Counts value elements across all items: array values count their length
 * (a resolved relation chain counts one per link), non-empty scalars count 1,
 * and a bare locator item (null value but section provenance) still counts 1 —
 * v6 count_data_elements counts locators (oracle parser_helper.ts:100-104).
 */
export const count: ItemParserFn = (items) => {
	if (!items || items.length === 0) return null;

	const firstItem = items[0] as ParserItem;
	let countVal = 0;
	for (const item of items) {
		const value = item.value;
		if (Array.isArray(value)) {
			countVal += value.length;
		} else if (value !== null && value !== undefined && value !== '') {
			countVal += 1;
		} else if (item.section_id != null) {
			countVal += 1;
		}
	}

	return [{ ...firstItem, value: countVal }];
};

// ---------------------------------------------------------------------------
// merge — the workhorse collapse/join parser
// ---------------------------------------------------------------------------

/** Column descriptor injected by the plan (oracle: by diffusion_processor). */
interface MergeColumn {
	tipo: string;
	model: string;
}

/**
 * Two oracle modes, selected by the presence of options.columns:
 *
 * STANDALONE (no columns): collapse a flat item list into one item per lang
 * whose value is the list of item values. merge:"unique" dedupes (v6
 * "merged_unique"); implode:true joins into ONE string by records_separator
 * (v6 "merged_unique_implode").
 *
 * COLUMN-AWARE (columns present): build section_id × column-tipo × lang slots
 * and emit one item per lang, shaped by options.merge:
 *   undefined → flat array of non-empty slot values
 *   'string'  → columns joined by fields_separator, sections by records_separator
 *   'nested'  → one sub-array of column values per section
 *   'flat'    → one joined string per section
 *   'pipe'    → JSON.stringify(col_values) per section, joined by records_separator
 *   'unique'  → deduplicated flat list (implode:true joins it)
 *
 * Per-slot lang fallback (oracle parser_helper.ts:245-262):
 *   exact lang → nolan → main_lang → any available → "" (slot kept empty).
 */
export const merge: ItemParserFn = (items, options, ctx) => {
	if (!items || items.length === 0) return null;

	const columns = options.columns as MergeColumn[] | undefined;
	if (!columns || columns.length === 0) {
		return mergeStandalone(items, options);
	}

	const mergeStyle = options.merge as string | undefined;
	const fieldsSep = (options.fields_separator as string) ?? ', ';
	const recordsSep = (options.records_separator as string) ?? ' | ';
	// Old engine received main_lang injected into options by the processor;
	// the new engine's per-run language config travels in ctx instead.
	const mainLang = (options.main_lang as string | undefined) ?? ctx.mainLang ?? null;
	const emptyColumns = (options.empty_columns as boolean) ?? true;

	// Phase 1: index section_id → tipo → lang_key → values (insertion-ordered
	// sections; lang_key '__nolan__' covers null and 'lg-nolan').
	type LangMap = Map<string, unknown[]>;
	type TipoMap = Map<string, LangMap>;

	const sectionData = new Map<string, TipoMap>();
	const seenSections: string[] = [];
	const langRefItems = new Map<string, ParserItem>();

	for (const item of items) {
		const sectionKey = item.section_id != null ? String(item.section_id) : '__no_section__';
		const tipoKey = item.tipo ?? '__unknown__';
		const langKey = !item.lang || item.lang === 'lg-nolan' ? '__nolan__' : item.lang;

		if (!sectionData.has(sectionKey)) {
			sectionData.set(sectionKey, new Map());
			seenSections.push(sectionKey);
		}
		const tipoMap = sectionData.get(sectionKey) as TipoMap;
		if (!tipoMap.has(tipoKey)) tipoMap.set(tipoKey, new Map());
		const langMap = tipoMap.get(tipoKey) as LangMap;
		if (!langMap.has(langKey)) langMap.set(langKey, []);
		(langMap.get(langKey) as unknown[]).push(item.value);

		// First ref item per specific lang (nolan is not emitted standalone)
		if (langKey !== '__nolan__' && !langRefItems.has(langKey)) {
			langRefItems.set(langKey, item);
		}
	}

	// Phase 2: langs to render — nolan-only input emits one lang:null item.
	const specificLangs = [...langRefItems.keys()];
	const langsToRender = specificLangs.length > 0 ? specificLangs : ['__nolan__'];
	if (specificLangs.length === 0) {
		langRefItems.set('__nolan__', items[0] as ParserItem);
	}

	// Phase 3: one output item per lang, slots resolved via the fallback chain.
	const resolveSlot = (tipoMap: TipoMap, tipo: string, langKey: string): string => {
		const langMap = tipoMap.get(tipo);
		if (!langMap || langMap.size === 0) return '';

		let vals: unknown[] | undefined;
		if (langMap.has(langKey))
			vals = langMap.get(langKey); // 1. exact lang
		else if (langMap.has('__nolan__'))
			vals = langMap.get('__nolan__'); // 2. nolan
		else if (mainLang && langMap.has(mainLang))
			vals = langMap.get(mainLang); // 3. main_lang
		else vals = langMap.values().next().value; // 4. any lang

		if (!vals || vals.length === 0) return ''; // 5. empty

		const parts = vals.filter((v) => v !== null && v !== undefined).map((v) => String(v));
		return parts.length > 0 ? parts.join(recordsSep) : '';
	};

	const result: ParserItem[] = [];

	for (const langKey of langsToRender) {
		// Ordered col values per section, '' for missing/empty slots
		const sectionsColValues: string[][] = seenSections.map((sectionKey) => {
			const tipoMap = sectionData.get(sectionKey) as TipoMap;
			return columns.map((col) => {
				const v = resolveSlot(tipoMap, col.tipo, langKey);
				// strip_tags only. v6's get_locator_value pushes $element_value VERBATIM
				// and uses trim() solely as its emptiness test; the real trim happens on
				// the component READ (see default_value.ts component_input_text).
				if (col.model !== 'component_input_text' || v === '') return v;
				const stripped = stripTags(v);
				// phpTrim, not JS trim: PHP's charlist excludes U+00A0, so a decoded
				// &nbsp; slot is NON-empty to v6 and must survive here too.
				return phpTrim(stripped) === '' ? '' : stripped;
			});
		});

		const effectiveColValues = emptyColumns
			? sectionsColValues
			: sectionsColValues.map((cv) => cv.filter((v) => v !== ''));

		let finalValue: unknown;

		switch (mergeStyle) {
			case 'nested':
				finalValue = effectiveColValues;
				break;

			case 'flat':
				finalValue = effectiveColValues.map((cv) => cv.join(fieldsSep));
				break;

			case 'pipe':
				// v6 emits pure-integer values as JSON numbers; the round-trip guard
				// (String(Number(v))===v) coerces "1"→1 but leaves "007" & co alone.
				finalValue = effectiveColValues
					.map((cv) =>
						JSON.stringify(
							cv.map((v) =>
								typeof v === 'string' && v !== '' && String(Number(v)) === v ? Number(v) : v,
							),
						),
					)
					.join(recordsSep);
				break;

			case 'unique': {
				const uniqueVals = [...new Set(effectiveColValues.flat().filter((v) => v !== ''))];
				finalValue = options.implode === true ? uniqueVals.join(recordsSep) : uniqueVals;
				break;
			}

			case 'string':
				// Empty slots produce adjacent separators — preserved intentionally.
				finalValue = effectiveColValues.map((cv) => cv.join(fieldsSep)).join(recordsSep);
				break;

			default:
				// flat array of all non-empty slot values, order preserved, dups allowed
				finalValue = effectiveColValues.flat().filter((v) => v !== '');
				break;
		}

		result.push({
			...(langRefItems.get(langKey) as ParserItem),
			lang: langKey === '__nolan__' ? null : langKey,
			value: finalValue,
		});
	}

	return result.length > 0 ? result : null;
};

/** Standalone merge (oracle parser_helper.ts:154-188): no column context. */
function mergeStandalone(
	items: ParserItem[],
	options: Record<string, unknown>,
): ParserItem[] | null {
	const unique = (options.merge as string | undefined) === 'unique';
	const byLang = new Map<string, unknown[]>();
	const refLang = new Map<string, ParserItem>();

	for (const it of items) {
		const lk = !it.lang || it.lang === 'lg-nolan' ? '__nolan__' : it.lang;
		if (!byLang.has(lk)) {
			byLang.set(lk, []);
			refLang.set(lk, it);
		}
		const v = it.value;
		if (v !== null && v !== undefined && v !== '') (byLang.get(lk) as unknown[]).push(v);
	}

	const recordsSep = (options.records_separator as string) ?? ' | ';
	const implode = options.implode === true;
	const out: ParserItem[] = [];

	for (const [lk, vals] of byLang) {
		let vv = vals;
		if (unique) {
			const seen = new Set<string>();
			vv = [];
			for (const v of vals) {
				const k = JSON.stringify(v);
				if (!seen.has(k)) {
					seen.add(k);
					vv.push(v);
				}
			}
		}
		const ref = refLang.get(lk) as ParserItem;
		// implode:true → ONE string per lang joined by records_separator (v6
		// "merged_unique_implode"); otherwise the value list stays an array.
		const finalV = implode ? vv.map((v) => String(v)).join(recordsSep) : vv;
		out.push({ ...ref, lang: lk === '__nolan__' ? null : lk, value: finalV });
	}

	return out.length > 0 ? out : null;
}

// ---------------------------------------------------------------------------
// Pattern replacer (oracle port of PHP class.pattern_replacer.php)
// ---------------------------------------------------------------------------

/** Sentinel injected for empty values so cleanup can fix surrounding punctuation. */
const EMPTY_MARKER = '\x00EMPTY\x00';

/**
 * Replaces ${a}, ${b}, … placeholders with positional values, then cleans up
 * the punctuation left behind by empty values.
 *
 * @example replace('${a}, ${b}, ${c} /${d}', ['Juan','Perez',null,'2025'])
 *          → 'Juan, Perez /2025'
 */
export function replace(pattern: string, values: (string | null | undefined)[]): string {
	if (!pattern) return '';

	// Collect unique placeholder names in order of appearance (a→0, b→1, …)
	const placeholderNames: string[] = [];
	const regex = /\$\{([a-zA-Z0-9_]+)\}/g;
	let match: RegExpExecArray | null = regex.exec(pattern);
	while (match !== null) {
		const name = match[1] as string;
		if (!placeholderNames.includes(name)) {
			placeholderNames.push(name);
		}
		match = regex.exec(pattern);
	}

	// Phase 1: substitute each placeholder, marking empties
	let result = pattern;
	for (let i = 0; i < placeholderNames.length; i++) {
		const name = placeholderNames[i] as string;
		const value = values[i];
		const isEmpty = value === null || value === undefined || value === '';
		const safeName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const phRegex = new RegExp(`\\$\\{${safeName}\\}`, 'g');
		result = result.replace(phRegex, isEmpty ? EMPTY_MARKER : String(value));
	}

	// Phase 2: cleanup formatting around removed content
	return cleanupFormatting(result);
}

/**
 * Removes empty-value markers together with their adjacent separators
 * (comma, dash, slash, pipe), collapses double spaces and trims stray
 * leading/trailing punctuation.
 */
export function cleanupFormatting(text: string): string {
	let result = text;
	const marker = esc(EMPTY_MARKER);

	// separator+marker / marker+separator pairs, for each separator family
	for (const sep of [',', '-', '/', '\\|']) {
		result = result.replace(new RegExp(`\\s*${sep}\\s*${marker}`, 'g'), '');
		result = result.replace(new RegExp(`${marker}\\s*${sep}\\s*`, 'g'), '');
	}

	// Any remaining markers, then whitespace/punctuation normalization
	result = result.replace(new RegExp(marker, 'g'), '');
	// NO whitespace collapse HERE.
	// CAUTION — this is NOT "the oracle does not collapse": BOTH oracles do
	// (frozen v7 parser_helper cleanup_formatting ends with /\s{2,}/ -> ' ' and
	// trim(); v6 class.pattern_replacer.php :101,108 has '/\s+/' -> ' ' and
	// trim()). The justification is EMPIRICAL: the values that reach this helper
	// on the mht2 corpus are substituted by diffusion_sql itself, and collapsing
	// them here diverged from v6's published bytes — removing it took
	// ref_publications_authors 24 -> 4 cells and typology_name 2 -> 0, with no
	// column regressing. Treat as a measured local deviation, not oracle parity;
	// re-measure before reusing this helper on another path.
	result = result.replace(/^\s*[,\-/|]\s*/, '');
	result = result.replace(/\s*[,\-/|]\s*$/, '');

	return result;
}

/** Escape a literal for RegExp embedding. */
function esc(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
