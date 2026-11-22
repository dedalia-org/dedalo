/**
 * TS_TERM_RESOLVER (PHP core/ts_object/class.ts_term_resolver.php) — resolves the
 * human-readable label of a thesaurus/ontology node from a locator.
 *
 * A "term" is not one component: a section's section_map declares (per scope) a
 * `term` key holding one OR several component tipos whose values are joined by a
 * scope-defined `fields_separator` (default ', '). This module reads those term
 * components straight off the matrix JSONB columns (no PHP component machinery —
 * TS has none) and joins them.
 *
 * THE STRING-FRAGMENT LAW (T2 THES-01/03, 2026-11-22) — ONE rule for a literal
 * (string-family) term part, whichever door asks (the section_map term, the
 * explicit ddo_map label, the tree's term element): the part is EVERY non-empty
 * item of its lang slice joined with the flat reader's ' | ' (PHP get_value
 * joins every item — reading only the first lost the rest), the slice being the
 * requested lang for a translatable component, lg-nolan otherwise. An empty
 * slice of a TRANSLATABLE component falls back, first non-empty wins (a
 * non-translatable one reads lg-nolan only, as both doors always did): requested lang → the hierarchy's main
 * lang → lg-nolan → the project langs in config order (PHP
 * component_string_common::get_value_with_fallback_from_data). Nothing past
 * the project langs: a value held only in a language the install does not
 * declare is not shown.
 *
 * THE UNTRANSLATED FLAG (T2 THES-02, FYI-3): a part supplied by the fallback is
 * flagged, and a term with any flagged part is (getTermTextByLocator →
 * {text, untranslated}). The TEXT never carries markup (owner ruling T1-18): a
 * screen may decorate it AFTER escaping (the tree's `<mark>`), what an export,
 * a publication or the RAG index reads (getTermByLocator) never is.
 * Wire contract: WC-2026-11-22-term-fallback-chain.
 *
 * Cache discipline (spec §4 / plan constraint): the cache is module-level and
 * keyed ONLY by CONTENT — `${section_tipo}_${section_id}_${scope}_${lang}` — never
 * by user/session. Bounded to 1000 entries; on overflow the whole cache is
 * dropped (PHP's O(1) eviction, not LRU). Registered with the ontology
 * invalidation hub so ontology writes drop it; targeted `invalidateNode` prefix
 * eviction runs after tree mutations.
 *
 * MODEL-AWARE PARTS (T1-32 / O10): a term part whose model has a non-string
 * flatValue family (a relation — the numisdata651 Catalog's autocomplete_hi —,
 * a select, the record's own component_section_id, a date …) is read through
 * THE interactive flat reader `resolveCellValue` (PHP get_value →
 * get_export_value()->to_flat_string), never as literal `value` items. A term
 * that CROSSES into other records (anything but the string / section_id
 * families) is never served from nor stored in the content-keyed cache: it
 * depends on the targets' data and, for an implicit request_config, on the
 * request principal — see {@link termCrossesRecords}.
 *
 * THE CALLER'S FRONTIER (T1-32 review): a record-crossing term reads OTHER
 * records, so a frontier-armed caller (the export: parents chain, a relation
 * label resolved through the term) hands its `CellFrontier` in
 * {@link TermReadOptions}; every crossing and implicit child the term's flat
 * read makes is then asked of it, exactly as the caller's own cell read would.
 * Absent = the interactive contract (ALS principal narrows implicit children).
 *
 * PHP anchors: get_term_data_by_locator (:95), get_term_by_locator (:188),
 * invalidate_node (:304). section_map scope resolution mirrors
 * class.section_map.php resolve_key_scope/get_term_tipos/get_fields_separator.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from '../../config/config.ts';
import { getComponentModel, getFlatValueFamily } from '../components/registry.ts';
import { readMatrixRecord } from '../db/matrix.ts';
import { sql } from '../db/postgres.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { createDataCache } from '../ontology/cache_factory.ts';
import { registerOntologyCacheClearer } from '../ontology/cache_invalidation.ts';
import {
	getColumnNameByModel,
	getMatrixTableFromTipo,
	getModelByTipo,
	getTranslatableByTipo,
} from '../ontology/resolver.ts';
import { getSectionMap } from '../ontology/section_map.ts';
import { getTldFromTipo } from '../ontology/tld.ts';
import { isEmptyDataItem } from '../resolve/data_item_emptiness.ts';
import type { CellFrontier, CellValueResolveOptions } from '../resolve/relation_list.ts';
import { currentDataLang } from '../resolve/request_lang.ts';

/**
 * What a frontier-armed caller threads into a term read. `frontier` = the
 * caller's CellFrontier (relation_list.ts): the term's record-crossing parts
 * ask it for every target record and implicit child, so a term never reads
 * what the caller's own cell read would refuse. The HOST record is not asked —
 * the caller authorized it before asking for its term.
 */
export interface TermReadOptions {
	frontier?: CellFrontier;
}

/** The flat-reader options a term part passes on (only the frontier, never the caller's sinks). */
function cellOptsOf(opts: TermReadOptions): CellValueResolveOptions | undefined {
	return opts.frontier === undefined ? undefined : { frontier: opts.frontier };
}

/** section_map::DEFAULT_FIELDS_SEPARATOR. */
const DEFAULT_FIELDS_SEPARATOR = ', ';
/** The flat reader's multi-item glue (resolve/relation_list.ts resolveCellValue). */
const ITEM_SEPARATOR = ' | ';
/** DEDALO_DATA_NOLAN — the structural no-language token. */
const NOLAN = 'lg-nolan';

/**
 * A term (or one part of it) as a screen needs it: the TEXT — never markup —
 * and whether a language fallback supplied it (THES-02).
 */
export interface TermText {
	text: string;
	untranslated: boolean;
}

const NO_TEXT: TermText = Object.freeze({ text: '', untranslated: false });
/** section_map::SCOPE_FALLBACK. */
const SCOPE_FALLBACK = ['main', 'thesaurus', 'relation_list'];

/**
 * A locator that identifies a node (plus optional decoration keys PHP appends).
 *
 * KEPT UNION (WC-2026-08-10-section-id-int-canonical): term resolution is fed
 * RAW STORED locators — portal / autocomplete_hi / in-text tag values read off
 * unswept jsonb — and it is also where an EXTERNAL remote id ('001338683',
 * 'Q42') lands: those never address a matrix row, and the locator-string
 * fallback below renders them verbatim instead of corrupting them into an int.
 */
export interface TermLocator {
	section_tipo?: string;
	section_id?: number | string;
	component_tipo?: string;
	tag_id?: number | string;
	[extra: string]: unknown;
}

// ---------------------------------------------------------------------------
// Module cache (content-keyed only). Registered with the invalidation hub AND
// the save/delete event channel: a term value comes from a RECORD's data, so
// an ordinary section save (component_input_text edit on an es1 record) must
// drop every entry built from that section — before this hook only ts_api tree
// mutations invalidated, and the tree served renamed terms stale (S2-10). The
// eviction is per-section-tipo (key prefix `${section_tipo}_`), coarser than
// invalidateNode's per-record prefix but correct and bounded by the 1000-entry
// cache. PHP needs no such hook — its twin cache is request-scoped (S3-15);
// this eviction plus the hub clear is the process-lifetime replacement.
// ---------------------------------------------------------------------------
const termByLocatorCache = createDataCache<string, TermText>((cache, sectionTipo) => {
	const prefix = `${sectionTipo}_`;
	for (const key of cache.keys()) {
		if (key.startsWith(prefix)) cache.delete(key);
	}
});

/** Full flush — worker cache_manager parity (PHP ts_term_resolver::clear). */
export function clearTermCache(): void {
	termByLocatorCache.clear();
}
registerOntologyCacheClearer(clearTermCache);

/**
 * Targeted eviction after a tree write (PHP invalidate_node :304): drop every
 * `${tipo}_${id}_…` cache entry (all langs/scopes) for the mutated node.
 */
export function invalidateNode(sectionTipo: string, sectionId: number): void {
	const prefix = `${sectionTipo}_${sectionId}_`;
	for (const key of termByLocatorCache.keys()) {
		if (key.startsWith(prefix)) termByLocatorCache.delete(key);
	}
}

// ---------------------------------------------------------------------------
// section_map scope resolution (per-key chain walk).
// ---------------------------------------------------------------------------

/** Name of the first scope providing `key` (PHP resolve_key_scope, non-strict). */
function resolveKeyScope(
	map: Record<string, unknown>,
	key: string,
	scope: string | null,
): string | null {
	const requested = scope ?? 'main';
	const requestedNode = map[requested];
	if (requestedNode !== null && typeof requestedNode === 'object' && key in requestedNode) {
		return requested;
	}
	for (const candidate of SCOPE_FALLBACK) {
		if (candidate === requested) continue;
		const node = map[candidate];
		if (node !== null && typeof node === 'object' && key in (node as Record<string, unknown>)) {
			return candidate;
		}
	}
	return null;
}

/** Normalized list of `term` component tipos for the scope (PHP get_term_tipos). */
export async function getTermTipos(sectionTipo: string, scope: string | null): Promise<string[]> {
	const map = await getSectionMap(sectionTipo);
	if (map === null) return [];
	const winning = resolveKeyScope(map, 'term', scope);
	if (winning === null) return [];
	const value = (map[winning] as Record<string, unknown>).term;
	if (value === null || value === undefined) return [];
	if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
	return typeof value === 'string' ? [value] : [];
}

/** The separator from the SAME scope that supplied `term` (PHP get_fields_separator). */
async function getFieldsSeparator(sectionTipo: string, scope: string | null): Promise<string> {
	const map = await getSectionMap(sectionTipo);
	if (map === null) return DEFAULT_FIELDS_SEPARATOR;
	const termScope = resolveKeyScope(map, 'term', scope);
	if (termScope === null) return DEFAULT_FIELDS_SEPARATOR;
	const sep = (map[termScope] as Record<string, unknown>).fields_separator;
	return typeof sep === 'string' ? sep : DEFAULT_FIELDS_SEPARATOR;
}

// ---------------------------------------------------------------------------
// main-lang fallback (PHP hierarchy::get_main_lang).
// ---------------------------------------------------------------------------
// Ontology-derived (TLD walk) AND data-derived: the main lang comes from the
// hierarchy1 registry record and the lg1 lang record's ISO code — a write to
// either section re-resolves it (S2-10 lifecycle sweep).
const mainLangCache = createDataCache<string, string>((cache, sectionTipo) => {
	if (sectionTipo === 'hierarchy1' || sectionTipo === 'lg1') cache.clear();
});
registerOntologyCacheClearer(() => mainLangCache.clear());

/**
 * The hierarchy main language of a node's TLD (PHP get_main_lang) — the fallback
 * language used when the requested lang has no value. Resolves the hierarchy1
 * record for the TLD, reads its hierarchy8 lang locator, and converts it to a
 * `lg-xxx` code via the lang record's hierarchy41 ISO-code component. The
 * hard-coded tails (es1→lg-spa, hierarchy1→DATA_LANG_DEFAULT, else lg-eng) match
 * v6. Exported for its gate (request_lang_static_default_native: the cached
 * hierarchy1 pick never follows the request lang).
 */
export async function getMainLang(sectionTipo: string): Promise<string> {
	if (sectionTipo === 'lg1') return 'lg-eng';
	const cached = mainLangCache.get(sectionTipo);
	if (cached !== undefined) return cached;

	let mainLang: string | null = null;
	const tld = (getTldFromTipo(sectionTipo) ?? '').toLowerCase();
	if (tld !== '') {
		// hierarchy1 record whose hierarchy6 TLD value equals the node's TLD.
		// KEPT UNION on lang_items[].section_id: a stored relation slice off
		// matrix_hierarchy_main — an install whose sweep has not run still holds
		// the string form here (WC-2026-08-10-section-id-int-canonical).
		const rows = (await sql.unsafe(
			`SELECT relation#>'{hierarchy8}' AS lang_items
			 FROM matrix_hierarchy_main
			 WHERE section_tipo = 'hierarchy1'
			   AND string @? ('$.hierarchy6[*].value ? (@ like_regex "^' || $1 || '$" flag "i")')::jsonpath
			 LIMIT 1`,
			[tld],
		)) as { lang_items: { section_id?: number | string }[] | null }[];
		const langLocator = rows[0]?.lang_items?.[0];
		if (langLocator?.section_id !== undefined) {
			mainLang = await codeFromLangLocator(Number(langLocator.section_id));
		}
	}
	if (mainLang === null || mainLang === '') {
		if (sectionTipo === 'es1') mainLang = 'lg-spa';
		// hierarchy1 → DEDALO_DATA_LANG_DEFAULT (v6 get_main_lang): the install's
		// main DATA lang — the first candidate of the one read chain — never the
		// menu's DEDALO_DATA_LANG, a per-session selection (request-language law, T2 B10).
		// Cached per section tipo, so it must not be a request-scoped value.
		// lang-law-exempt(term_resolver.hierarchy1_main_lang): owner ruling — hierarchy1's main lang is the install DATA_LANG_DEFAULT (v6 get_main_lang), static; cached per section tipo, so a request lang here would bleed across requests
		else if (sectionTipo === 'hierarchy1') mainLang = config.lang.dataLangDefault;
		else mainLang = 'lg-eng';
	}
	mainLangCache.set(sectionTipo, mainLang);
	return mainLang;
}

/** lang record id → `lg-xxx` (PHP lang::get_code_from_locator; hierarchy41 ISO code). */
async function codeFromLangLocator(langSectionId: number): Promise<string | null> {
	const table = (await getMatrixTableFromTipo('lg1')) ?? 'matrix';
	const record = await readMatrixRecord(table, 'lg1', langSectionId);
	if (record === null) return null;
	const items =
		((record.columns.string as Record<string, { value?: unknown }[]> | null)?.hierarchy41 as
			| { value?: unknown }[]
			| undefined) ?? [];
	const code = items[0]?.value;
	return typeof code === 'string' && code !== '' ? `lg-${code}` : null;
}

// ---------------------------------------------------------------------------
// term reads.
// ---------------------------------------------------------------------------

/** The raw items stored for one component tipo on a record (its typed column). */
async function readComponentItems(
	sectionTipo: string,
	sectionId: number | string,
	tipo: string,
): Promise<{ lang?: string; value?: unknown }[]> {
	const model = await getModelByTipo(tipo);
	if (model === null) return [];
	const column = getColumnNameByModel(model);
	if (column === null) return [];
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === null) return [];
	const record = await readMatrixRecord(table, sectionTipo, Number(sectionId));
	if (record === null) return [];
	const bag = record.columns[column as keyof typeof record.columns] as Record<
		string,
		{ lang?: string; value?: unknown }[]
	> | null;
	return bag?.[tipo] ?? [];
}

/**
 * Flat-value families whose term part is read off the HOST record alone (the
 * literal items, the record's own id). Every other declared family crosses
 * into other records (relation targets, iri frames, inverse referrers) or into
 * request state (info widgets, media export base) — see termCrossesRecords.
 */
const RECORD_LOCAL_FAMILIES: ReadonlySet<string> = new Set(['string', 'section_id', 'json']);

/**
 * The tipo's flat-value family when it is NOT read as literal items: a declared
 * family other than 'string'. Null = the literal path (a string-family model,
 * or an unknown tipo). A model with NO flatValue facet THROWS
 * `engine.uncovered_scope` naming section / tipo / model (owner C37
 * 2026-11-13, T1-32 O1 ruled (a); AGENTS.md: an uncovered path throws loudly —
 * a term part that silently rendered '' hid a configuration defect in every
 * label built from it; WC-2026-11-13-section-map-term-uncovered-throws).
 */
async function modelFlatFamily(sectionTipo: string, tipo: string): Promise<string | null> {
	const model = await getModelByTipo(tipo);
	if (model === null) return null;
	const family = getFlatValueFamily(model);
	if (family === undefined) {
		throw new DedaloError('engine.uncovered_scope', {
			message: `term resolver: section_map term ${sectionTipo}/${tipo} (${model}) has no flatValue facet — the model is not readable as a term part`,
			coordinates: { section_tipo: sectionTipo, tipo },
		});
	}
	return family === 'string' ? null : family;
}

/**
 * Does a term over `tipos` read beyond the host record? True when any part's
 * family is outside RECORD_LOCAL_FAMILIES. Such a term is computed per call:
 * the content-keyed cache is evicted only by a write to the HOST section, so a
 * renamed target would serve stale, and an implicit-config relation narrows
 * its children by the REQUEST principal (implicit.ts filterAuthorizedRelated)
 * — one user's narrowed label must never be served to another (DEC-13).
 */
async function termCrossesRecords(sectionTipo: string, tipos: readonly string[]): Promise<boolean> {
	for (const tipo of tipos) {
		const family = await modelFlatFamily(sectionTipo, tipo);
		if (family !== null && !RECORD_LOCAL_FAMILIES.has(family)) return true;
	}
	return false;
}

/**
 * One NON-LITERAL term part: the component's flat display string through THE
 * interactive flat reader (PHP component::get_value). Relations join their
 * targets with the records separator ' | ' (PHP default); null → ''. No
 * main-lang retry: PHP's empty-value retry reads string items of get_data(),
 * which a locator / id component does not hold.
 */
async function modelFlatFragment(
	sectionTipo: string,
	sectionId: number | string,
	tipo: string,
	lang: string,
	opts: TermReadOptions,
): Promise<string> {
	// CONVENTIONS §2 rationale 1 (cycle-breaking at the term chokepoint):
	// relation_list → relations/datalist → term_resolver is a static edge, and a
	// relation term legitimately recurses term(X) → relation value → term(target).
	const { resolveCellValue } = await import('../resolve/relation_list.ts');
	const unresolved: string[] = [];
	const value = await resolveCellValue(
		sectionTipo,
		sectionId,
		tipo,
		lang,
		unresolved,
		undefined,
		cellOptsOf(opts),
	);
	// The reader's `unresolved` notes (a nested model with no family, a cell the
	// reader could not resolve) are a GAP in the term, never a silent '' (owner
	// C37 2026-11-13, T1-32 O1 ruled (a); WC-2026-11-13-section-map-term-uncovered-throws).
	if (unresolved.length > 0) {
		throw new DedaloError('engine.uncovered_scope', {
			message: `term resolver: section_map term ${sectionTipo}/${tipo} could not be resolved — unresolved: ${unresolved.join(', ')}`,
			coordinates: { section_tipo: sectionTipo, tipo },
		});
	}
	return value ?? '';
}

/**
 * One term part in `lang` (THE string-fragment law, header): a non-literal
 * family through the flat reader (never flagged — no language fallback there),
 * a literal one through {@link stringTermFragment}.
 */
async function termPartText(
	sectionTipo: string,
	sectionId: number | string,
	tipo: string,
	lang: string,
	opts: TermReadOptions,
): Promise<TermText> {
	if ((await modelFlatFamily(sectionTipo, tipo)) !== null) {
		return {
			text: await modelFlatFragment(sectionTipo, sectionId, tipo, lang, opts),
			untranslated: false,
		};
	}
	return stringTermFragment(
		sectionTipo,
		tipo,
		await readComponentItems(sectionTipo, sectionId, tipo),
		lang,
	);
}

/** The fallback langs, in order, deduplicated (THES-01: lang → main → nolan → project langs). */
async function termLangChain(sectionTipo: string, lang: string): Promise<string[]> {
	const chain = [lang, await getMainLang(sectionTipo), NOLAN, ...config.menu.projectsDefaultLangs];
	return chain.filter((code, index) => code !== '' && chain.indexOf(code) === index);
}

/**
 * THE STRING-FRAGMENT LAW over a literal part's stored items (header): the
 * slice of the component's own lang (`lang` when translatable, lg-nolan
 * otherwise) — every non-empty item, by the model's emptiness rule, joined
 * with ' | ' — else, for a translatable component only, the first non-empty
 * slice of the fallback chain, flagged untranslated. Exported for the tree, which holds the record already
 * (ts_object.ts term element).
 */
export async function stringTermFragment(
	sectionTipo: string,
	tipo: string,
	items: readonly { lang?: string; value?: unknown }[],
	lang: string,
): Promise<TermText> {
	if (items.length === 0) return NO_TEXT;
	const model = await getModelByTipo(tipo);
	// A string-family model without a declared rule (component_number: not
	// class-translatable) reads PHP's common emptiness ('0' and 0 are values).
	const rule =
		(model === null ? undefined : getComponentModel(model)?.dataItemEmptiness) ?? 'common';
	const sliceText = (target: string): string =>
		items
			.filter((item) => (item.lang ?? NOLAN) === target && !isEmptyDataItem(rule, item))
			.map((item) => String(item.value))
			.join(ITEM_SEPARATOR);
	// A NON-translatable component reads lg-nolan ONLY — no fallback of any
	// kind (unchanged: neither prior door fell back for one; PHP's callers pass
	// the chain only for translatable data).
	if (!(await getTranslatableByTipo(tipo))) {
		const text = sliceText(NOLAN);
		return text === '' ? NO_TEXT : { text, untranslated: false };
	}
	const direct = sliceText(lang);
	if (direct !== '') return { text: direct, untranslated: false };
	for (const candidate of await termLangChain(sectionTipo, lang)) {
		if (candidate === lang) continue;
		const text = sliceText(candidate);
		if (text !== '') return { text, untranslated: true };
	}
	return NO_TEXT;
}

/**
 * The merged raw item array across every `term` tipo of the scope (PHP
 * get_term_data_by_locator :95). No cache. Null when the locator is invalid or
 * the scope resolves no term tipos.
 */
export async function getTermDataByLocator(
	locator: TermLocator,
	scope: string | null = 'thesaurus',
): Promise<{ lang?: string; value?: unknown }[] | null> {
	const sectionTipo = locator.section_tipo;
	const sectionId = locator.section_id;
	if (typeof sectionTipo !== 'string' || sectionTipo === '') return null;
	const termTipos = await getTermTipos(sectionTipo, scope);
	if (termTipos.length === 0 || sectionId === undefined || sectionId === null || sectionId === '') {
		return null;
	}
	let merged: { lang?: string; value?: unknown }[] = [];
	for (const tipo of termTipos) {
		const items = await readComponentItems(sectionTipo, sectionId, tipo);
		if (items.length > 0) merged = [...merged, ...items];
	}
	return merged;
}

/**
 * The display label for a locator in `lang` (PHP get_term_by_locator :188), with
 * the request-scope cache. When no term tipos resolve, returns the deterministic
 * locator-string fallback `${section_tipo}_${section_id}[_component_tipo[_tag_id]]`
 * so orphan locators always render something. Writes the cache unless the term
 * crosses into other records (termCrossesRecords). A frontier-armed caller
 * passes its frontier in `opts` (TermReadOptions).
 *
 * TEXT ONLY — never markup, never the untranslated flag: this is what an export,
 * a publication, the RAG index and every non-screen consumer read. A screen that
 * decorates a fallback asks {@link getTermTextByLocator}.
 */
export async function getTermByLocator(
	locator: TermLocator,
	// Per-REQUEST data lang, resolved at call time (S2-11 — a module-level
	// capture froze the install default for every session). The resolved lang
	// is baked into the cache key, so the ambient read cannot bleed (DEC-13).
	lang: string = currentDataLang(),
	fromCache = false,
	scope: string | null = 'thesaurus',
	opts: TermReadOptions = {},
): Promise<string | null> {
	return (await getTermTextByLocator(locator, lang, fromCache, scope, opts))?.text ?? null;
}

/**
 * {@link getTermByLocator} with the untranslated flag (THES-02): `untranslated`
 * is true when any term part was supplied by the language fallback. Null when
 * the locator names no section. For a SCREEN: decorate after escaping, never
 * store or publish the decoration.
 */
export async function getTermTextByLocator(
	locator: TermLocator,
	lang: string = currentDataLang(),
	fromCache = false,
	scope: string | null = 'thesaurus',
	opts: TermReadOptions = {},
): Promise<TermText | null> {
	const sectionTipo = locator.section_tipo;
	if (typeof sectionTipo !== 'string') return null;
	const sectionId = locator.section_id;

	const scopeKey = scope ?? '';
	const cacheUid = `${sectionTipo}_${sectionId}_${scopeKey}_${lang}`;
	const termTipos = await getTermTipos(sectionTipo, scope);
	// A term crossing into other records never touches the cache (T1-32).
	const cacheable = !(await termCrossesRecords(sectionTipo, termTipos));
	if (cacheable && fromCache) {
		const cached = termByLocatorCache.get(cacheUid);
		if (cached !== undefined) return cached;
	}

	const value: TermText =
		termTipos.length === 0
			? { text: locatorStringFallback(locator, sectionTipo), untranslated: false }
			: await joinCrossingGuarded(cacheable, cacheUid, async () =>
					joinParts(
						await termParts(sectionTipo, sectionId ?? '', termTipos, lang, opts),
						await getFieldsSeparator(sectionTipo, scope),
					),
				);
	if (cacheable) storeTerm(cacheUid, value);
	return value;
}

/** The non-empty parts joined; untranslated when any of them is. */
function joinParts(parts: readonly TermText[], separator: string): TermText {
	return {
		text: parts.map((part) => part.text).join(separator),
		untranslated: parts.some((part) => part.untranslated),
	};
}

/** The legacy locator-string label `${section_tipo}_${section_id}[_component_tipo[_tag_id]]`. */
function locatorStringFallback(locator: TermLocator, sectionTipo: string): string {
	let fallback = `${sectionTipo}_${locator.section_id}`;
	if (locator.component_tipo !== undefined) fallback += `_${locator.component_tipo}`;
	if (locator.tag_id !== undefined) fallback += `_${locator.tag_id}`;
	return fallback;
}

/** The non-empty term parts of a record, in `termTipos` order. */
async function termParts(
	sectionTipo: string,
	sectionId: number | string,
	termTipos: readonly string[],
	lang: string,
	opts: TermReadOptions,
): Promise<TermText[]> {
	const fragments: TermText[] = [];
	for (const tipo of termTipos) {
		const current = await termPartText(sectionTipo, sectionId, tipo, lang, opts);
		if (current.text !== '') fragments.push(current);
	}
	return fragments;
}

/** Bounded content-keyed store (PHP's O(1) whole-cache drop on overflow). */
function storeTerm(cacheUid: string, value: TermText): void {
	if (termByLocatorCache.size >= 1000) termByLocatorCache.clear();
	termByLocatorCache.set(cacheUid, value);
}

/**
 * THE TERM CYCLE GUARD (T1-32). A record-crossing term re-enters the term
 * resolver for its targets (resolveCellValue → datalist resolveLocatorLabels →
 * getTermByLocator), through public doors that carry no flat-reader cycle
 * trail — so records whose terms quote each other (A → B → A) recursed without
 * end. The trail rides the async path (AsyncLocalStorage: request-scoped by
 * construction, never module state): a term key re-entered on its OWN path has
 * no finite value and contributes '' there; sibling paths are unaffected
 * (path-scoped, like relation_list withCycleGuard). Record-local terms never
 * recurse, so they skip the guard.
 */
const crossingTermTrail = new AsyncLocalStorage<ReadonlySet<string>>();

async function joinCrossingGuarded(
	recordLocal: boolean,
	key: string,
	compute: () => Promise<TermText>,
): Promise<TermText> {
	if (recordLocal) return compute();
	const trail = crossingTermTrail.getStore();
	if (trail?.has(key) === true) return NO_TEXT;
	return crossingTermTrail.run(new Set([...(trail ?? []), key]), compute);
}

/**
 * The display value of a locator built from an EXPLICIT tipo list instead of the
 * section_map `term` scope — the tree's 'M' model badge (PHP
 * component_common::get_value → get_grid_value → dd_grid_cell_object::resolve_value).
 * The tipos come from the CALLER component's own `properties.source.request_config[].show.ddo_map`,
 * so a component that displays its target by something other than the section's
 * thesaurus term resolves the same string PHP renders.
 *
 * Lang chain: THE string-fragment law (header) — the same as the section_map
 * term's (THES-01: the two used to differ, this one ending on "any non-empty").
 * A label held in ONE lang (a dd0 model record named by its lg-spa label)
 * resolves through the chain's project langs; a model record named by its
 * machine name reads the lg-nolan rung.
 *
 * Shares termByLocatorCache under a `ddo:<tipos>` scope key so it inherits the
 * per-section-tipo eviction on save/delete and the ontology-hub clear; a private
 * cache here would serve renamed models stale forever. A tipo list crossing into
 * other records bypasses the cache (termCrossesRecords, T1-32) and asks a
 * frontier-armed caller's `opts.frontier` for every crossing (TermReadOptions).
 */
export async function getDdoValueByLocator(
	locator: TermLocator,
	tipos: string[],
	fieldsSeparator: string = DEFAULT_FIELDS_SEPARATOR,
	lang: string = currentDataLang(),
	opts: TermReadOptions = {},
): Promise<string> {
	const sectionTipo = locator.section_tipo;
	const sectionId = locator.section_id;
	if (typeof sectionTipo !== 'string' || sectionTipo === '') return '';
	if (sectionId === undefined || sectionId === null || sectionId === '') return '';
	if (tipos.length === 0) return '';

	const cacheUid = `${sectionTipo}_${sectionId}_ddo:${tipos.join('+')}_${lang}`;
	const cacheable = !(await termCrossesRecords(sectionTipo, tipos));
	const cached = cacheable ? termByLocatorCache.get(cacheUid) : undefined;
	if (cached !== undefined) return cached.text;

	const value = await joinCrossingGuarded(cacheable, cacheUid, async () =>
		joinParts(await termParts(sectionTipo, sectionId, tipos, lang, opts), fieldsSeparator),
	);
	if (cacheable) storeTerm(cacheUid, value);
	return value.text;
}
