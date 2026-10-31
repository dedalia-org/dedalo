/**
 * Component DATA reader — the TS re-expression of component_common::get_data /
 * get_data_lang / get_data_item and the string-family language fallback
 * (spec §3.7 "Data").
 *
 * PHP references: class.component_common.php get_data (:1139), get_data_lang
 * (:1297), get_data_item (:3981); component_string_common
 * get_component_data_fallback (:310).
 *
 * A component's stored data lives in its matrix row at
 * row[<column-for-model>][<component tipo>] as an array of items:
 *   literal item  : { id, value, lang }
 *   relation item : a locator { section_tipo, section_id, … }
 *
 * Language rules:
 * - non-translatable components return the FULL item array unfiltered;
 * - translatable components filter items by lang (strict equality);
 * - when the requested lang yields nothing, fallback_value tries: the install
 *   main lang, then lg-nolan, then every other project lang — first non-empty
 *   wins; null when the component holds no data at all.
 */

import { config } from '../../config/config.ts';
import { getComponentModel } from '../components/registry.ts';
import type { MatrixRecord } from '../db/matrix.ts';
import { elementLang, getColumnNameByModel, getTranslatableByTipo } from '../ontology/resolver.ts';
import { equivalentLangsOf } from './lang_alias.ts';

/**
 * The install's MAIN data language — the fallback chain's first candidate.
 * PHP get_component_data_fallback($lang, $main_lang = DEDALO_DATA_LANG_DEFAULT):
 * the INSTALL config defines it (../private/.env DEDALO_DATA_LANG_DEFAULT);
 * languages are configuration, never module literals (owner rule, 2026-07-09).
 */
const DEFAULT_DATA_LANG = config.lang.dataLangDefault;
const NOLAN = 'lg-nolan'; // PHP DEDALO_DATA_NOLAN — the structural no-language token
/**
 * Project languages tried by the fallback chain — PHP get_component_data_fallback
 * iterates common::get_ar_all_langs() = DEDALO_PROJECTS_DEFAULT_LANGS
 * (class.common.php:1255), defined in ../private/.env (PROJECTS_DEFAULT_LANGS).
 * The previous read of 'APPLICATION_LANGS' was DOUBLY wrong (2026-07-09, rsc92
 * picker bug): wrong key (UI langs, and stored as a JSON map so the CSV split
 * produced garbage → silently fell back to a 3-lang literal) — so values
 * stored only in e.g. lg-fra NEVER resolved as fallback and the picker
 * rendered blank terms.
 */
const ALL_LANGS = config.menu.projectsDefaultLangs;

/** Raw stored items of one component in one record (null when absent). */
export function readComponentItems(
	record: MatrixRecord,
	componentTipo: string,
	model: string,
): unknown[] | null {
	const column = getColumnNameByModel(model);
	if (column === null) return null;
	const columnValue = record.columns[column as keyof MatrixRecord['columns']];
	if (columnValue === null || columnValue === undefined || typeof columnValue !== 'object') {
		return null;
	}
	const items = (columnValue as Record<string, unknown>)[componentTipo];
	if (items === undefined || items === null) return null;
	// PHP coerces non-array data to [$data] (legacy matrix_dd compat).
	const array = Array.isArray(items) ? items : [items];
	// Drop null/'' holes: a null data item is never valid, but corrupt/legacy
	// records carry them (e.g. a trailing `null` from a bad delete). PHP emits
	// them verbatim (get_data), which CRASHES the copied client — the date edit
	// renderer reads current_value.id on a null entry at index>0
	// (render_edit_component_date.js). We diverge from that PHP live defect and
	// strip the holes at the single read chokepoint, protecting every view; a
	// later save then self-heals the stored array. Pinned in
	// test/unit/component_data_null_filter.test.ts.
	return array.filter((item) => item !== null && item !== '');
}

/** Language-filtered slice (PHP get_data_lang). */
export function filterItemsByLang(items: unknown[], lang: string): unknown[] {
	return items.filter(
		(item) =>
			item !== null && typeof item === 'object' && (item as { lang?: string }).lang === lang,
	);
}

/**
 * The component's value for a lang + its fallback (PHP list/edit data flow).
 * Returns {value, fallbackValue}: value = lang slice (or full array when not
 * translatable); fallbackValue only computed when value is empty.
 */
/**
 * Whether a model's CLASS supports translation (PHP supports_translation
 * property — a class-level gate, deliberately independent of the ontology
 * `translatable` flag; see class.component_common.php :1301-1308). Only these
 * lang-filter their items; everything else returns the full array. The set of
 * translatable classes now lives per-model in the component registry
 * (descriptor.classSupportsTranslation).
 */
function classSupportsTranslation(model: string): boolean {
	return getComponentModel(model)?.classSupportsTranslation === true;
}

/**
 * What a `secretValue` model's stored value resolves as, on every display
 * door: "something is set", never the value (see ComponentModel.secretValue).
 * Sent back, it cannot become a credential — it breaks the password policy.
 */
export const SECRET_MASK = '****************';

/** Whether a stored scalar is empty ("no value" stays visible through the mask). */
function isEmptyStored(value: unknown): boolean {
	return value === null || value === undefined || value === '';
}

/** One item with its stored value replaced by SECRET_MASK (empty stays empty). */
function maskSecretItem(item: unknown): unknown {
	if (item === null || typeof item !== 'object' || !('value' in item)) {
		return isEmptyStored(item) ? item : SECRET_MASK;
	}
	return isEmptyStored((item as { value: unknown }).value)
		? item
		: { ...(item as object), value: SECRET_MASK };
}

/** Replace every non-empty stored value in an item array with SECRET_MASK. */
export function maskSecretItems(items: unknown[] | null): unknown[] | null {
	return items === null ? null : items.map(maskSecretItem);
}

/**
 * Options of a component value read.
 *
 * `explicitLang`: the caller ASKED for `lang` (a component read's own
 * `source.lang`, a ddo's declared `lang`) rather than passing the ambient
 * request data lang. Only then does a TRANSLITERABLE component (ontology
 * `with_lang_versions` — resolver.ts hasLangVersions) show that lang's version;
 * every other read of one shows its lg-nolan BASE (PHP get_element_lang). Opt-in
 * on purpose: the many display reads (labels, list cells, export atoms, user
 * names…) pass the ambient lang and must keep showing the base.
 */
export interface ComponentValueReadOptions {
	explicitLang?: boolean;
}

export async function resolveComponentValue(
	record: MatrixRecord,
	componentTipo: string,
	model: string,
	lang: string,
	options: ComponentValueReadOptions = {},
): Promise<{ value: unknown[] | null; fallbackValue: unknown[] | null }> {
	const resolved = await resolveStoredComponentValue(record, componentTipo, model, lang, options);
	if (getComponentModel(model)?.secretValue !== true) return resolved;
	return {
		value: maskSecretItems(resolved.value),
		fallbackValue: maskSecretItems(resolved.fallbackValue),
	};
}

/**
 * Effective filter lang = the INSTANCE lang: ontology-non-translatable
 * string-family components are nolan-forced at instantiation (PHP
 * get_element_lang); component_iri honors the requested lang as-is
 * (empirically verified against live PHP, 2026-07-02); a TRANSLITERABLE
 * component (`with_lang_versions`) honors it only when the caller asked
 * for it explicitly (the tool_lang target) — the one rule, elementLang —
 * and shows its lg-nolan base otherwise. An empty explicit version falls
 * through to the fallback chain, whose nolan rung is that base (PHP
 * get_component_data_fallback).
 */
async function readFilterLang(
	componentTipo: string,
	model: string,
	lang: string,
	options: ComponentValueReadOptions,
): Promise<string> {
	if (model === 'component_iri' || (await getTranslatableByTipo(componentTipo))) return lang;
	if (options.explicitLang !== true) return NOLAN;
	return elementLang(componentTipo, model, { requested: lang, ambient: lang });
}

async function resolveStoredComponentValue(
	record: MatrixRecord,
	componentTipo: string,
	model: string,
	lang: string,
	options: ComponentValueReadOptions,
): Promise<{ value: unknown[] | null; fallbackValue: unknown[] | null }> {
	// component_alias data key (WC-020): an alias stores NOTHING under its own
	// tipo — its value lives in the TARGET's column slot.
	const { resolveDataTipo } = await import('../ontology/alias.ts');
	const dataTipo = await resolveDataTipo(componentTipo);
	const items = readComponentItems(record, dataTipo, model);
	if (items === null || items.length === 0) {
		return { value: null, fallbackValue: null };
	}
	if (!classSupportsTranslation(model)) {
		return { value: items, fallbackValue: null };
	}

	const effectiveLang = await readFilterLang(componentTipo, model, lang, options);
	const slice = filterItemsByLang(items, effectiveLang);
	if (slice.length > 0) {
		return { value: slice, fallbackValue: null };
	}

	// Empty slice: iri emits a plain empty array (no fallback machinery);
	// the string family computes the fallback chain (main lang → nolan →
	// remaining project langs), entries stay null.
	if (model === 'component_iri') {
		return { value: [], fallbackValue: null };
	}
	// DECLARED language equivalences go first: a transcript that exists only in
	// Valencian is what a Catalan menu should see (both directions — the class
	// is symmetric for DATA), before the install default gets a say. Fancier
	// than PHP, which only aliased translations (labels/terms), never data.
	const tried = new Set([effectiveLang]);
	for (const candidate of [
		...equivalentLangsOf(effectiveLang),
		DEFAULT_DATA_LANG,
		NOLAN,
		...ALL_LANGS,
		NOLAN,
	]) {
		if (tried.has(candidate)) continue;
		tried.add(candidate);
		const fallbackSlice = filterItemsByLang(items, candidate);
		if (fallbackSlice.length > 0) {
			return { value: null, fallbackValue: fallbackSlice };
		}
	}
	return { value: null, fallbackValue: null };
}

/**
 * The sections envelope: first data item of every section-list response
 * (PHP sections_json.php :136). Lives here with DataItem so every emitter —
 * the section read pipeline and the relations layer — shares one response
 * vocabulary without importing each other.
 */
export interface SectionsEnvelope {
	typo: 'sections';
	tipo: string;
	section_tipo: [];
	entries: {
		section_tipo: string;
		section_id: number;
		paginated_key: number;
		/**
		 * The thesaurus picker's per-row selectability answer, stamped ONLY for
		 * sections whose section_map declares `thesaurus.is_indexable` (the same
		 * fact the tree node reads carry — ts_object/node_repository.fetchNodeInfo).
		 * The client refuses to offer a pick affordance on a guess
		 * (thesaurus_picker.term_selectability), so without it a thesaurus LIST row
		 * renders no link arrow at all. Absent = "not a thesaurus row", never false.
		 */
		is_indexable?: boolean;
		/**
		 * `false` when the row's section declares NO `thesaurus.is_indexable`
		 * component — i.e. it has no per-term selectability contract at all, the
		 * ordinary case for every non-thesaurus picker target (People, rsc197).
		 * The key is emitted ONLY in that case and never carries `true`: a
		 * section that does declare the contract answers per row through
		 * `is_indexable` above, and the two keys are mutually exclusive.
		 *
		 * It exists because silence was being read as "unknown". `relations/
		 * save.ts` gate 3 exempts a no-contract target (the pick is authorized),
		 * so the client must be able to draw the arrow for it —
		 * `thesaurus_picker.term_selectability` turns this key into `true`.
		 * Both sides now read `ontology/section_map.declaresTermSelectability`.
		 */
		selectability_declared?: false;
	}[];
}

/**
 * A data item as the API emits it (PHP get_data_item :3981).
 *
 * KEPT UNION on `section_id`: an item's row anchor is int for every matrix
 * record, but the SAME field carries the non-record concepts the API also
 * emits — an EXTERNAL target's remote id (zenon '001338683', verbatim) and the
 * client's synthetic tokens ('search_1' in search/tool modes) — plus null for
 * the sectionless items (WC-2026-08-10-section-id-int-canonical).
 */
export interface DataItem {
	section_id: number | string | null;
	section_tipo: string;
	tipo: string;
	mode: string;
	lang: string;
	from_component_tipo: string;
	/** The value payload — PHP names this key 'entries'. */
	entries: unknown[] | null;
	[extra: string]: unknown;
}

/**
 * THE TM PREVIEW'S BOUND (WC-2026-09-29-tm-preview-frame-children-as-of): the
 * previewed main row and the record it belongs to. `boundId` = the id just
 * below the row that ends the row's interval (Number.MAX_SAFE_INTEGER when
 * none does) — which rows end it is the WC entry's bound law, not restated
 * here. Another record "as of the row" is its state at that bound
 * (tm_record/frame_as_of.ts). Declared here, a type only, so the resolve layer
 * takes no edge to tm_record.
 */
export interface TmAsOf {
	readonly rowId: number;
	readonly boundId: number;
	readonly sectionTipo: string;
	readonly sectionId: number;
	readonly mainTipo: string;
	/**
	 * THE EMISSION ROOT: the record OBJECT the subject is emitted from at the
	 * top of this emission — the preview's own (grafted) record, or the dd15
	 * history list's virtual row record standing in for it. Confinement is by
	 * this identity, never by address (frame_as_of.ts subjectRowOf): the
	 * subject's record met again NESTED (a portal target) is another object and
	 * stays live on both surfaces. Absent (no emission yet: the door-3 target
	 * and bag reads, which confine per frame) → no emission frame matches.
	 */
	readonly root?: MatrixRecord;
}

/**
 * EmissionContext — the EXPLICIT per-read emission protocol (audit S2-29).
 *
 * One instance is created wherever a response data array is born (a section
 * read, a get_data/resolve_data call, a TM row set) and THREADED through
 * emitDdoData → the relation resolvers → expandPortal/emitDataframeItem. It
 * replaces the old implicit protocol: a bare out-param array plus a
 * MODULE-GLOBAL WeakSet (relation_core.nestedStampedItems) that decided which
 * items an outer re-stamp loop was allowed to rewrite.
 *
 * The contract emitters must follow (unchanged semantics, now visible):
 * - push items to `items` IN EMISSION ORDER (outer loops rewrite identity on
 *   index ranges pushed since a checkpoint — PHP class.common.php:2792-2799);
 * - after stamping an item's identity (from_component_tipo/section_id/row
 *   anchor), call `markStamped(item)` so outer expansions keep the nested
 *   creator's identity and only rewrite the row anchor + outward parent;
 * - cross-item per-read memory (e.g. relation_index's solved pointing
 *   sections) lives in `scratch` under a module-local symbol — never in
 *   module-level state keyed by request objects.
 * - `tmAsOf` (set ONLY by the two tool_time_machine doors: section/read.ts
 *   resolveTmPreview — the preview's row, rooted at its own record — and
 *   resolve/read_tm.ts graftRowFrameState — one bound per framed history-list
 *   row, rooted at the virtual dd15 record): the subject's frame children read as of
 *   the row — tm_record/frame_as_of.ts. Null for every other read.
 */
export class EmissionContext {
	/** The response data array (envelope at [0] on section reads). */
	readonly items: (SectionsEnvelope | DataItem)[];
	/** Items whose identity a NESTED expansion already stamped (see class doc). */
	readonly #stamped = new WeakSet<object>();
	/** Per-read emitter scratch, keyed by module-local symbols (see class doc). */
	readonly scratch = new Map<symbol, unknown>();

	/**
	 * The row's bound (see TmAsOf): set by a TM preview (resolveTmPreview) or a
	 * framed TM-list row (read_tm.ts graftRowFrameState); null for every other read.
	 */
	readonly tmAsOf: TmAsOf | null;

	constructor(
		items: (SectionsEnvelope | DataItem)[] = [],
		options: { tmAsOf?: TmAsOf | null } = {},
	) {
		this.items = items;
		this.tmAsOf = options.tmAsOf ?? null;
	}

	markStamped(item: object): void {
		this.#stamped.add(item);
	}

	isStamped(item: object): boolean {
		return this.#stamped.has(item);
	}
}

/**
 * Build the canonical data item envelope.
 *
 * WC-001 (engineering/wire_contract/, DEC-02): an empty value emits `entries: []`
 * — NEVER null — for EVERY model. PHP emits null; the byte-identical client's
 * lifecycle code requires an array (`entries.map(...)` call sites crash on
 * null), so the TS engine unified on `[]` at this single chokepoint. Parity
 * gates reconcile via test/parity/normalize.ts adoptEntriesArrayContract on
 * the PHP side.
 */
export function buildDataItem(
	componentTipo: string,
	sectionTipo: string,
	sectionId: number | string | null,
	mode: string,
	lang: string,
	entries: unknown[] | null,
	fromComponentTipo?: string,
): DataItem {
	return {
		section_id: sectionId,
		section_tipo: sectionTipo,
		tipo: componentTipo,
		mode,
		lang,
		from_component_tipo: fromComponentTipo ?? componentTipo,
		entries: entries ?? [],
	};
}
