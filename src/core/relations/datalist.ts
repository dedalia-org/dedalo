/**
 * Relation LIST VALUES — the label strings a selection component shows in
 * list mode (PHP component_relation_common::get_list_value, backed by the
 * canonical datalist resolver component_common::get_list_of_values).
 *
 * Contract (per the datalist-resolution conventions):
 * - the DATALIST is every option of the component's target section(s):
 *   each record → {locator, label}, label = EVERY component show-ddo value
 *   joined with ' | ' (PHP implode), strnatcmp-sorted (or properties.sort_by);
 * - the LIST VALUE is the labels of the datalist entries whose locator
 *   appears in the component's stored data (matched on
 *   section_id+section_tipo) — datalist order.
 *
 * fixed_filter narrowing (PHP get_list_of_values :2860): when the built
 * request_config sqo carries fixed_filter, its FIRST group becomes the
 * option search's filter (bad format → ignored with an error log, PHP
 * parity) — the state widget's vocabulary leaves (rsc80 family) are the
 * live users. A `component_data` fixed_filter reads its value FROM THE RECORD
 * being edited (rsc1214), so every door names its owner RECORD
 * ({@link DatalistOwner}); `section_id: null` states "no record" (search
 * panel, state widget, identify, an unsaved temporal record). Else (PHP
 * `elseif` :2871) `properties.filtered_by_search` is the filter verbatim.
 *
 * THE PRINCIPAL (PHP COMP-01): the enumeration is the REAL search — the
 * request principal's projects filter and dd478 allow-list apply, exactly as
 * PHP's search::get_instance did. One enumeration path (the assembler), with or
 * without a filter.
 *
 * HIDE ddo values are resolved per option (PHP :2931-2955) — see
 * DatalistHideItem. They were emitted as `[]` until 2026-07-31, which broke
 * the dataframe rating colour: the client reads `hide[0].literal` to paint the
 * frame chip and threw "Cannot read properties of undefined (reading
 * 'literal')", killing the whole record render.
 *
 * `properties.filtered_by_search_dynamic` (PHP parse_search_dynamic, the v5
 * record-dependent grammar) is NOT PORTED — owner ruling C5 (2026-11-13): it is
 * SUPERSEDED by `fixed_filter source:'component_data'`, its v7 translation on
 * every node that carried it (no vendored v7 node declares it live; the legacy
 * copies live in ontology19 `propiedades`, which this engine never reads). A
 * LIVE node still declaring it with neither a fixed_filter nor a
 * `filtered_by_search` is REFUSED at datalist build (`ontology.invalid_node`
 * naming the fix) — never silently served the full list; next to either, the
 * key is ignored (WC-2026-11-13-datalist-labels-restricted-and-dynamic-filter).
 *
 * A STORED pick outside the built list (owner ruling C6, same WC): when its
 * target row still exists it is marked, not hidden — the edit datalist gains an
 * opaque `restricted` entry and the list value the `restricted` label — so the
 * widget keeps the selection and the next save cannot drop it unnoticed (PHP
 * hid it). A pick whose target row is gone stays blank, as in PHP.
 */

import type { FilterRecordsDatalistItem } from '../api/handlers/filter_records_datalist.ts';
import { getComponentModel } from '../components/registry.ts';
import type { DatalistSourceId } from '../components/types.ts';
import { compareLocators, type Locator } from '../concepts/locator.ts';
import type { MatrixRecord } from '../db/matrix.ts';
import { memoizedReadMatrixRecord } from '../db/record_memo.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { getLabels } from '../labels/catalog.ts';
import { createOntologyCache } from '../ontology/cache_factory.ts';
import { registerOntologyCacheClearer } from '../ontology/cache_invalidation.ts';
import { registerPairingChangeListener } from '../ontology/model_section.ts';
import { getMatrixTableFromTipo, getModelByTipo, getNode } from '../ontology/resolver.ts';
import { resolveComponentValue, shownItems } from '../resolve/component_data.ts';
import { currentApplicationLang } from '../resolve/request_lang.ts';
import type { SearchStatement } from '../search/search_statement.ts';
import { registerSectionDataListener } from '../section_record/save_event.ts';
import type { Principal } from '../security/permissions.ts';
import { currentPrincipal } from '../security/request_context.ts';
import {
	getTermByLocator,
	getTermTipos,
	type TermReadOptions,
} from '../ts_object/term_resolver.ts';
import type { FilterDatalistItem } from './filter_projects.ts';
import { buildRequestConfigForElement } from './request_config/build.ts';
import { extractSqoSectionTipos, type RequestConfigContext } from './request_config/explicit.ts';
import {
	appendMissingLang,
	getSelectLangDatalist,
	type SelectLangDatalistItem,
} from './select_lang.ts';

/**
 * One resolved HIDE-ddo value of an option (PHP `$hide_item`, :2949-2953).
 * Field names and order are the PHP object's — the client indexes into this
 * by position (`hide[0]`) and reads `.literal`.
 */
export interface DatalistHideItem {
	/** The component's solved value on the OPTION record (PHP get_value()). */
	literal: string;
	/** Which hide ddo produced it. */
	tipo: string;
	/** The option record this was read from — INT, like the option's own. */
	section_id: number;
	section_tipo: string;
}

/** One datalist option (PHP get_list_of_values result item). */
export interface DatalistItem {
	/**
	 * The option locator. INT since WC-2026-08-10-section-id-int-canonical —
	 * this is the client→DB byte funnel of the whole select family: the widget
	 * posts back the option's `value` verbatim and save persists those bytes,
	 * so the type emitted HERE is the type NEW selections are stored as. The
	 * old law ("PHP stores section_id as a STRING here") is repealed.
	 */
	value: { section_tipo: string; section_id: number };
	label: string;
	/** INT too — the option record's address, not a display token. */
	section_id: number;
	/**
	 * The option's HIDE-ddo values (PHP get_list_of_values :2931-2955,
	 * `$ar_hide`): data the widget CONSUMES without rendering it as a column.
	 *
	 * The live user is the dataframe rating colour: `rsc1246` (a
	 * component_radio_button whose options are `rsc1256` records) declares
	 * `rsc1259` "Valuation" in SHOW — the option's label — and `rsc1260`
	 * "Colour" in HIDE. The client looks the picked option up in this datalist
	 * and paints the frame chip with `hide[0].literal`
	 * (client/…/view_default_list_dataframe.js).
	 */
	hide: DatalistHideItem[];
	/**
	 * EDIT-only opaque completion (owner ruling C6, 2026-11-13;
	 * WC-2026-11-13-datalist-labels-restricted-and-dynamic-filter): the
	 * component's STORED pick is outside the built list (out of the caller's
	 * scope, or outside the record-resolved filter) but its target row exists.
	 * `value` is the stored locator (so the widget keeps the selection and the
	 * next save round-trips it), `label` the `restricted` catalog string,
	 * `hide` empty. Never on a shared getDatalist list — only
	 * {@link getEditDatalist} and the list value know the stored value.
	 */
	restricted?: true;
	/**
	 * security-tools (dd1067) `view_tools` enrichment ONLY (PHP
	 * tool_common::hydrate_tools_info): internal tool name (icon URL + label
	 * segment), its always_active flag and its description (dd612, raw stored
	 * HTML in the datalist lang; null when none — the client folds it under the
	 * row as plain text). Absent on every other datalist.
	 */
	tool_name?: string;
	always_active?: boolean;
	tool_description?: string | null;
}

/**
 * Any component's datalist option: the generic target-section option, or a
 * model-sourced one (DatalistSourceId) — today select_lang's language option,
 * which carries no `hide` and keys by the 'lg-<code>' token (PHP parity).
 */
export type ComponentDatalistItem = DatalistItem | SelectLangDatalistItem;

/**
 * THE RECORD an option list is built for. `section_tipo` resolves `self` /
 * `section_model` sqo sources; `section_id` feeds a `component_data`
 * fixed_filter (the value is read from that record — PHP get_fixed_filter
 * with the component's own section_id). REQUIRED on every door: `null` is an
 * explicit "no record" (search panel, state widget, identify, an unsaved
 * temporal record), and then a record-dependent filter narrows nothing. An
 * INT when present (WC-2026-08-10-section-id-int-canonical): the save echo
 * passes the coerced record id, never the wire value.
 */
export interface DatalistOwner {
	section_tipo: string;
	section_id: number | null;
}

/**
 * Model-declared option sources (descriptor facet `datalistSource`,
 * components/types.ts DatalistSourceId). Consulted FIRST by getDatalist and
 * probeDatalistSize — the one door — so no caller can reach the generic
 * enumeration for a model whose options are something else. Each source owns
 * its own caching (select_lang: the resolved project langs, cleared by an lg1
 * write).
 *
 * `editGuard` (optional) is the EDIT-only completion of the options against the
 * component's stored value, applied by {@link getEditDatalist} and nowhere else
 * (select_lang: the "<name> *" entry of a stored non-project lang). It never
 * reaches getDatalist's shared list — filters, the state widget and identify
 * consume the options themselves, not a record's value.
 */
interface DatalistSourceImplementation {
	options: (lang: string) => Promise<ComponentDatalistItem[]>;
	editGuard?: (
		datalist: readonly ComponentDatalistItem[],
		storedLocators: readonly unknown[],
	) => Promise<ComponentDatalistItem[]>;
}

export const DATALIST_SOURCE_IMPLEMENTATIONS: Readonly<
	Record<DatalistSourceId, DatalistSourceImplementation>
> = {
	project_langs: {
		options: (lang) => getSelectLangDatalist(lang),
		// The missing lang's name is in the APPLICATION lang (PHP
		// get_lang_name_by_locator default), read per request (ALS).
		editGuard: (datalist, storedLocators) =>
			appendMissingLang(datalist, storedLocators, currentApplicationLang()),
	},
};

/** The component's model-declared option source, or null for the generic one. */
async function modelDatalistSource(
	componentTipo: string,
): Promise<DatalistSourceImplementation | null> {
	const model = await getModelByTipo(componentTipo);
	if (model === null) return null;
	const sourceId = getComponentModel(model)?.datalistSource;
	return sourceId === undefined ? null : DATALIST_SOURCE_IMPLEMENTATIONS[sourceId];
}

/**
 * Growth bound (S3-22): each entry pins a full target-section option list per
 * (component, owner section, lang, label set, enumeration statement), so an
 * unbounded Map grows with every such tuple ever requested. On overflow BOTH maps are
 * dropped together (the O(1) wipe of the term-resolver precedent, not LRU) —
 * clearing the list cache without its section index would leave unreachable
 * keys behind. The owner-section key part (below) multiplies the key space by
 * caller section against this cap, and the overflow is a TOTAL wipe, not an
 * LRU eviction: a wide multi-hierarchy browse that thrashes past 500 entries
 * rebuilds everything from zero — measure the hit rate there and raise the
 * cap if it thrashes, never remove the owner from the key. The statement part
 * adds keys only where the enumeration DIFFERS (a record-resolved filter, a
 * scoped principal on a gated section) — equal scopes share one entry.
 */
const MAX_DATALIST_CACHE_ENTRIES = 500;

/**
 * Per-component datalist cache. Keyed `componentTipo_ownerSectionTipo_lang`:
 * the OWNER SECTION is part of the option-list identity because the built
 * request_config's sqo can resolve `section_tipo` FROM THE CALLER — any
 * `{source:'self'}` sqo, and the component_relation_model default
 * (`section_model`: hierarchy27 in `es1` targets `es2`, the same tipo in
 * `fr1` targets `fr2`). A tipo_lang key cannot express that answer: the first
 * caller's list would be served to every other owner section, and a locator
 * picked from the wrong list writes the wrong `section_tipo` into the record
 * — silent cross-thesaurus corruption, not just a display bug.
 */
const datalistCache = createOntologyCache<string, DatalistItem[]>();

/**
 * The cache key. The LABEL and HIDE ddo sets are part of it because they are
 * PRINCIPAL-DEPENDENT: request_config drops the show ddos the actor holds level 0
 * on (implicit.ts filterAuthorizedRelated, PHP filter_authorized_related), so a
 * user without a grant on the target's label component builds blank labels. Keyed
 * without them, the FIRST caller's list was served to everyone — blank profile
 * names for root after an editor opened dd1725, or labels a user may not read
 * after root did (TODO-071). Keyed by the resolved set, not the user: users with
 * the same grants share one list.
 *
 * THE ENUMERATION (`statements`): the fingerprint of every target section's
 * option search — the WHERE the assembler renders for THIS caller and THIS
 * record: the record-resolved filter (T1-9: two records with the same
 * reference value share one list, no per-record eviction needed), the
 * projects filter + dd478 allow-list of the principal, on the main alias AND
 * on every hop the filter path opens (T1-13 / PHP COMP-01). Keyed by WHAT the
 * search selects, never by user id: two non-admins with the same projects, or
 * any callers of an ungated vocabulary section, share one list; and no second
 * statement of the ACL rules exists to drift from the assembler's.
 */
function datalistCacheKey(
	componentTipo: string,
	ownerSectionTipo: string,
	lang: string,
	sources: Pick<DatalistSources, 'labelDdos' | 'hideDdos'>,
	statements: readonly TargetStatement[],
): string {
	const tipos = (ddos: readonly { tipo: string }[]) => ddos.map((ddo) => ddo.tipo).join(',');
	const enumeration = statements.map((entry) => entry.fingerprint).join(',');
	return `${componentTipo}_${ownerSectionTipo}_${lang}_${tipos(sources.labelDdos)}|${tipos(sources.hideDdos)}|${enumeration}`;
}

/**
 * Populate-time index: target section tipo → the datalist cache keys built
 * from its records (S1-11). It stores WHOLE cache keys (opaque strings), so
 * without this index a record write to a TARGET section could not be mapped
 * back to the cached option lists it staled.
 */
const datalistKeysBySection = createOntologyCache<string, Set<string>>();

export function clearDatalistCache(): void {
	datalistCache.clear();
	datalistKeysBySection.clear();
}
// Ontology-derived too (request_config/ddo resolution) — hub-cleared (S1-11 stopgap).
registerOntologyCacheClearer(clearDatalistCache);
// REGISTRY RETARGET (2026-08-14). A component's target sections can now derive
// from hierarchy-registry RECORD data (hierarchy53 → hierarchy58,
// ontology/model_section.ts — the `section_model` sqo source and the
// component_relation_model default). The per-section index below is keyed by the
// resolved TARGET section, so a write to a REGISTRY section evicts nothing: an
// operator retargeting the ES hierarchy from es2 to esX would clear the pairing
// map while every already-built es1 list kept serving es2's options. A registry
// section is not the target of anything, so there is no key to look up — the
// honest eviction is the whole cache, and registry writes are rare operator
// maintenance. Registered rather than polled so this file keeps its one
// direction of dependency (relations → ontology), matching the
// registerOntologyCacheClearer inversion above.
registerPairingChangeListener(clearDatalistCache);
// Data-derived: a write/delete of a TARGET section record evicts every option
// list built from that section (the durable S1-11 channel).
registerSectionDataListener((sectionTipo) => {
	const staleKeys = datalistKeysBySection.get(sectionTipo);
	if (staleKeys === undefined) return;
	for (const key of staleKeys) {
		datalistCache.delete(key);
	}
	datalistKeysBySection.delete(sectionTipo);
});

/**
 * PHP strnatcmp — the DEFAULT datalist ordering (get_list_of_values
 * "Alphabetic ascendant label"). Faithful port of the C natsort algorithm
 * (Martin Pool's strnatcmp.c, which PHP embeds): WHITESPACE IS SKIPPED
 * before each comparison step ("Petit-Aledón" sorts before "Petit 1981"),
 * digit runs compare numerically (longer run wins; leading zeros compare
 * fractionally), everything else is byte-ordered and case-SENSITIVE.
 */
export function strnatcmp(a: string, b: string): number {
	const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9';
	const isSpace = (ch: string): boolean => ch === ' ' || (ch >= '\t' && ch <= '\r');

	// Both runs start on digits: integer comparison — the run with MORE
	// digits is larger; equal lengths remember the first digit difference.
	const compareRight = (): number => {
		let bias = 0;
		for (; ; indexA++, indexB++) {
			const digitA = indexA < a.length && isDigit(a[indexA] as string);
			const digitB = indexB < b.length && isDigit(b[indexB] as string);
			if (!digitA && !digitB) return bias;
			if (!digitA) return -1;
			if (!digitB) return 1;
			const charA = a[indexA] as string;
			const charB = b[indexB] as string;
			if (charA < charB) {
				if (bias === 0) bias = -1;
			} else if (charA > charB) {
				if (bias === 0) bias = 1;
			}
		}
	};

	// Leading zeros: fractional comparison — first difference decides.
	const compareLeft = (): number => {
		for (; ; indexA++, indexB++) {
			const digitA = indexA < a.length && isDigit(a[indexA] as string);
			const digitB = indexB < b.length && isDigit(b[indexB] as string);
			if (!digitA && !digitB) return 0;
			if (!digitA) return -1;
			if (!digitB) return 1;
			const charA = a[indexA] as string;
			const charB = b[indexB] as string;
			if (charA < charB) return -1;
			if (charA > charB) return 1;
		}
	};

	let indexA = 0;
	let indexB = 0;
	for (;;) {
		while (indexA < a.length && isSpace(a[indexA] as string)) indexA++;
		while (indexB < b.length && isSpace(b[indexB] as string)) indexB++;
		const charA = indexA < a.length ? (a[indexA] as string) : '';
		const charB = indexB < b.length ? (b[indexB] as string) : '';

		if (charA !== '' && charB !== '' && isDigit(charA) && isDigit(charB)) {
			const result = charA === '0' || charB === '0' ? compareLeft() : compareRight();
			if (result !== 0) return result;
			continue;
		}
		if (charA === '' && charB === '') return 0;
		if (charA < charB) return -1;
		if (charA > charB) return 1;
		indexA++;
		indexB++;
	}
}

/**
 * Resolve one show-ddo's display value on a record (the datalist label atom).
 */
async function resolveDdoLabel(
	record: MatrixRecord,
	ddoTipo: string,
	lang: string,
): Promise<string> {
	const model = await getModelByTipo(ddoTipo);
	if (model === null) return '';
	const first = shownItems(await resolveComponentValue(record, ddoTipo, model, lang))?.[0] as
		| { value?: unknown }
		| undefined;
	return typeof first?.value === 'string' ? first.value : '';
}

/** What {@link resolveDatalistSources} answers. */
interface DatalistSources {
	targetSections: string[];
	labelDdos: { tipo: string }[];
	hideDdos: { tipo: string }[];
	filterGroup: Record<string, unknown> | undefined;
}

/**
 * The option SOURCES of a selection component — which target sections its
 * request_config points at, which show-ddos label an option, and the filter
 * that narrows the enumeration. Shared by the full build
 * ({@link getDatalist}) and the bounded count ({@link probeDatalistSize}) so
 * the two can never disagree about what the component's options ARE.
 *
 * The OWNER RECORD rides into the request_config build (`ownerSectionId`): a
 * `component_data` fixed_filter reads its search value from that record through
 * the ddo_map walker (request_config/filters.ts expandFixedFilter).
 */
async function resolveDatalistSources(
	componentTipo: string,
	componentProperties: unknown,
	owner: DatalistOwner,
	lang: string,
): Promise<DatalistSources> {
	const context: RequestConfigContext = {
		ownerTipo: componentTipo,
		ownerSectionTipo: owner.section_tipo,
		ownerSectionId: owner.section_id,
		mode: 'edit', // options come from the component's EDIT config (full ddos)
		ownerIsSection: false,
		lang,
	};
	const config = await buildRequestConfigForElement(componentProperties, context);
	const mainItem = config[0];
	// Every COMPONENT-model show ddo contributes to the label (PHP skips
	// non-component ddos with an error log) — EXCEPT a component_dataframe
	// slot (owner ruling C2, 2026-11-13): a frame ddo names the HOST's frames,
	// not a value of the option record, so it resolves to '' there and PHP's
	// implode left every label ending in ' | '. Dropped from both sets.
	const labelDdos = (mainItem?.show?.ddo_map ?? []).filter(isOptionValueDdo);
	// HIDE ddos (PHP :2934-2936) — same component-model filter as the labels;
	// their values ride on each option as internal data for the widget.
	const hideDdos = (mainItem?.hide?.ddo_map ?? []).filter(isOptionValueDdo);
	const fixedFilter = (mainItem?.sqo as { fixed_filter?: unknown[] } | undefined)?.fixed_filter;
	await refuseUnsupersededDynamicFilter(componentTipo, fixedFilter);
	return {
		targetSections: extractSqoSectionTipos(mainItem),
		labelDdos,
		hideDdos,
		filterGroup: optionFilterGroup(componentTipo, fixedFilter, componentProperties),
	};
}

/** A ddo whose value lives ON the option record: a component, not a frame slot. */
function isOptionValueDdo(ddo: { model?: unknown }): boolean {
	return (
		typeof ddo.model === 'string' &&
		ddo.model.startsWith('component_') &&
		ddo.model !== 'component_dataframe'
	);
}

/**
 * The C5 refusal: a LIVE node (`getNode(tipo).properties` — never the
 * ontology19 legacy `propiedades`) still declaring the unported v5
 * `filtered_by_search_dynamic` with NO superseding filter — neither a
 * `fixed_filter` (declared on its request_config, or present in the built sqo)
 * nor a `filtered_by_search` — would silently be served the FULL list. Refused
 * instead, naming the fix. Declared next to either, the key is ignored. The
 * DECLARATION supersedes, not the per-record expansion: a `component_data`
 * fixed_filter expands to no group on a record without a value, and that
 * record is not an invalid node.
 */
async function refuseUnsupersededDynamicFilter(
	componentTipo: string,
	builtFixedFilter: unknown[] | undefined,
): Promise<void> {
	const live = (await getNode(componentTipo))?.properties;
	if (!isPlainObject(live) || !('filtered_by_search_dynamic' in live)) return;
	if (hasSupersedingFilter(live, builtFixedFilter)) return;
	throw new DedaloError('ontology.invalid_node', {
		message:
			`component '${componentTipo}' declares properties.filtered_by_search_dynamic, the v5 ` +
			'record-dependent option filter, which this engine does not read (superseded). Declare ' +
			"its translation instead: a `fixed_filter source:'component_data'` entry on the sqo of " +
			'its request_config (or properties.filtered_by_search), then remove the key.',
		coordinates: { tipo: componentTipo },
	});
}

/** The v7 translations that supersede `_dynamic`: a fixed_filter (built or declared) or filtered_by_search. */
function hasSupersedingFilter(
	live: Record<string, unknown>,
	builtFixedFilter: unknown[] | undefined,
): boolean {
	return (
		(Array.isArray(builtFixedFilter) && builtFixedFilter.length > 0) ||
		declaresFixedFilter(live) ||
		isPlainObject(live.filtered_by_search)
	);
}

/** Whether a node's live `source.request_config[*].sqo.fixed_filter` names any group. */
function declaresFixedFilter(properties: Record<string, unknown>): boolean {
	const source = properties.source;
	const configs = isPlainObject(source) ? source.request_config : undefined;
	if (!Array.isArray(configs)) return false;
	return configs.some((entry) => {
		const sqo = isPlainObject(entry) ? entry.sqo : undefined;
		const fixedFilter = isPlainObject(sqo) ? sqo.fixed_filter : undefined;
		return Array.isArray(fixedFilter) && fixedFilter.length > 0;
	});
}

/**
 * The option search's filter, PHP get_list_of_values (:2860-2877) branch for
 * branch: a non-empty (expanded) fixed_filter → its FIRST group (a non-object
 * entry is ignored with an error log, and then NOTHING filters — PHP's `if`
 * does not fall through); else `properties.filtered_by_search` verbatim (the
 * `elseif`), cloned so the search never holds the cached ontology object.
 */
function optionFilterGroup(
	componentTipo: string,
	fixedFilter: unknown[] | undefined,
	componentProperties: unknown,
): Record<string, unknown> | undefined {
	if (Array.isArray(fixedFilter) && fixedFilter.length > 0) {
		const first = fixedFilter[0];
		if (isPlainObject(first)) return first;
		console.error(`getDatalist '${componentTipo}': ignored fixed filter, bad format`);
		return undefined;
	}
	const filteredBySearch = (componentProperties as { filtered_by_search?: unknown } | null)
		?.filtered_by_search;
	return isPlainObject(filteredBySearch) ? structuredClone(filteredBySearch) : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * THE READ FLOOR of an option filter: every `${section}_${component}` pair its
 * paths name. The filter is SERVER-AUTHORED (ontology fixed_filter /
 * filtered_by_search; a component_data value only fills `q`), so a reader
 * without a grant on the filter component must still get the narrowed list —
 * not the frontier's refusal (an empty list) and never the unfiltered one. PHP
 * get_subdatum's floor semantics (sql_assembler SearchOptions.readFloor).
 */
function filterReadFloor(filterGroup: Record<string, unknown>): ReadonlySet<string> {
	const floor = new Set<string>();
	collectPathPairs(filterGroup, floor);
	return floor;
}

function collectPathPairs(node: unknown, floor: Set<string>): void {
	if (Array.isArray(node)) {
		for (const child of node) collectPathPairs(child, floor);
		return;
	}
	if (!isPlainObject(node)) return;
	for (const step of Array.isArray(node.path) ? node.path : []) {
		const { section_tipo: sectionTipo, component_tipo: componentTipo } = (step ?? {}) as {
			section_tipo?: unknown;
			component_tipo?: unknown;
		};
		if (typeof sectionTipo === 'string' && typeof componentTipo === 'string') {
			floor.add(`${sectionTipo}_${componentTipo}`);
		}
	}
	for (const [key, value] of Object.entries(node)) {
		if (key !== 'path' && key !== 'q') collectPathPairs(value, floor);
	}
}

/** One target section's option search, built for the current caller. */
interface TargetStatement {
	targetSection: string;
	statement: SearchStatement;
	fingerprint: string;
}

/**
 * THE ONE ENUMERATION of a target section (PHP get_list_of_values →
 * search::get_instance, limit 0 = all): the real option search, scoped by the
 * request PRINCIPAL — projects filter + dd478 allow-list (PHP COMP-01) — read
 * from the request context at call time, the same ALS source the label-ddo
 * filter of this very build reads (never a parameter that could disagree with
 * it). No principal = internal/system caller → unscoped (the assembler's
 * posture). The root user (-1) stays enumerable (PHP select edit
 * `include_negative=true`); a non-admin's users-section rule still drops it.
 * Ids only, so a cap check and the full build run the same WHERE.
 */
async function buildTargetStatement(
	targetSection: string,
	filterGroup: Record<string, unknown> | undefined,
	limit: number | 'all',
	principal: Principal | undefined,
): Promise<SearchStatement> {
	const { sanitizeClientSqo } = await import('../concepts/sqo.ts');
	const { buildSearchSql } = await import('../search/sql_assembler.ts');
	const sqo = sanitizeClientSqo({
		section_tipo: [targetSection],
		...(filterGroup === undefined ? {} : { filter: filterGroup }),
		limit: 1,
	});
	// AFTER sanitizing: the bound is the CALLER's ('all' for the build, the cap
	// for the probe), never squeezed through the client ceiling (a small
	// DEDALO_SEARCH_CLIENT_MAX_LIMIT would silently under-count a probe).
	sqo.limit = limit;
	return buildSearchSql(sqo, {
		...(principal === undefined ? {} : { principal }),
		...(filterGroup === undefined ? {} : { readFloor: filterReadFloor(filterGroup) }),
		idsOnly: true,
		includeRootUser: true,
	});
}

/** Every resolvable target section's full option search + its fingerprint (the cache key part). */
async function buildTargetStatements(
	sources: DatalistSources,
	principal: Principal | undefined,
): Promise<TargetStatement[]> {
	const { searchStatementFingerprint } = await import('../search/search_statement.ts');
	const statements: TargetStatement[] = [];
	for (const targetSection of sources.targetSections) {
		// A target resolving no matrix table (a component tipo, a dead node) is
		// skipped, never fatal.
		if ((await getMatrixTableFromTipo(targetSection)) === null) continue;
		const statement = await buildTargetStatement(
			targetSection,
			sources.filterGroup,
			'all',
			principal,
		);
		statements.push({
			targetSection,
			statement,
			fingerprint: searchStatementFingerprint(statement),
		});
	}
	return statements;
}

/** Run an option search: its ids, ascending (the enumeration order before the label sort). */
async function runOptionSearch(statement: SearchStatement): Promise<number[]> {
	const { runSearch } = await import('../search/search_statement.ts');
	const rows = (await runSearch(statement)) as { section_id: number }[];
	return rows.map((row) => row.section_id).sort((a, b) => a - b);
}

/**
 * HOW MANY OPTIONS DOES THIS COMPONENT OFFER — counted up to `limit` and no
 * further, without building (or caching) the list.
 *
 * For a caller whose only question is "is this list over a cap?", building the
 * datalist to find out is the whole cost for none of the value: the full build
 * reads EVERY record of every target section to label it, and a 60k-term
 * thesaurus is 60k sequential reads whose result is then thrown away — and,
 * worse, stored first, evicting the shared `datalistCache` that ordinary reads
 * depend on. This is the O(limit) answer: a `LIMIT limit` row probe per target
 * section, nothing read, nothing cached.
 *
 * Returns `min(total, limit)`, so `result >= limit` means "at least this many",
 * never "exactly". It counts RECORDS, where the full build drops options whose
 * label resolves empty — so the probe can only OVER-count, and over-counting a
 * cap check refuses a list that was borderline. That is the conservative
 * direction, and the one "refuse, never truncate" already chose.
 */
export async function probeDatalistSize(
	componentTipo: string,
	componentProperties: unknown,
	owner: DatalistOwner,
	lang: string,
	limit: number,
): Promise<number> {
	if (limit <= 0) return 0;
	// A model-sourced list is small by construction and cheap to build: count it.
	const modelSource = await modelDatalistSource(componentTipo);
	if (modelSource !== null) return Math.min((await modelSource.options(lang)).length, limit);
	const sources = await resolveDatalistSources(componentTipo, componentProperties, owner, lang);
	const principal = currentPrincipal();
	const statements = await buildTargetStatements(sources, principal);
	// A list already built is already paid for — count it rather than re-probe.
	// SAME key as getDatalist — the doc-block on resolveDatalistSources is the
	// contract: probe and build must never disagree about what the options ARE.
	const cached = datalistCache.get(
		datalistCacheKey(componentTipo, owner.section_tipo, lang, sources, statements),
	);
	if (cached !== undefined) return Math.min(cached.length, limit);
	let found = 0;
	for (const { targetSection } of statements) {
		if (found >= limit) break;
		// The SAME option search the full build runs, capped (a filter can narrow
		// a huge section to a handful, so counting the raw table would refuse
		// lists that are perfectly small).
		const capped = await buildTargetStatement(
			targetSection,
			sources.filterGroup,
			limit - found,
			principal,
		);
		found += (await runOptionSearch(capped)).length;
	}
	return Math.min(found, limit);
}

/**
 * Build the datalist for a selection component: all records of its
 * request_config target section(s), each labeled with EVERY show-ddo value
 * joined by ' | ' (PHP get_list_of_values `implode(' | ', $ar_label)`),
 * strnatcmp-sorted by label — or by the component's `properties.sort_by`
 * custom rule when declared (path + direction, numeric-aware).
 */
export async function getDatalist(
	componentTipo: string,
	componentProperties: unknown,
	owner: DatalistOwner,
	lang: string,
): Promise<ComponentDatalistItem[]> {
	// The model's OWN option source wins (descriptor `datalistSource`): for
	// component_select_lang that is the project languages — the node's sqo
	// names lg1, whose generic enumeration is every language record there is.
	const modelSource = await modelDatalistSource(componentTipo);
	if (modelSource !== null) return modelSource.options(lang);
	return getTargetSectionDatalist(componentTipo, componentProperties, owner, lang);
}

/**
 * FILTER family — models whose options are USER-SCOPED, never a target-section
 * enumeration: component_filter/_master list the caller's authorized projects
 * (relations/models/portal.ts filterResolver → filter_projects.ts
 * getFilterDatalist, AUTHZ-06) and component_filter_records the sections the
 * caller administers (components/component_filter_records/emit.ts →
 * api/handlers/filter_records_datalist.ts). Not members of
 * SELECT_FAMILY_MODELS — that set is the LIST-value/label family. Read doors
 * emit their datalist directly; the save echoes join through
 * {@link getEchoDatalist} so echo == read.
 */
export const FILTER_FAMILY_MODELS: ReadonlySet<string> = new Set([
	'component_filter',
	'component_filter_master',
	'component_filter_records',
]);

/**
 * Does a SAVE ECHO attach a datalist for `model`? The ONE guard both echo doors
 * ask (the persisted echo and the temporal echo), so a family member can never
 * be routed by one and skipped by the other. Dynamic import: select_family.ts
 * imports this module, so a static one would close a cycle.
 */
export async function echoesDatalist(model: string): Promise<boolean> {
	const { SELECT_FAMILY_MODELS } = await import('./models/select_family.ts');
	return SELECT_FAMILY_MODELS.has(model) || FILTER_FAMILY_MODELS.has(model);
}

/**
 * The datalist a SAVE ECHO attaches next to the saved value — ONE door for the
 * persisted echo (api/handlers/dd_core_api.ts) and the temporal echo
 * (section/record/temporal.ts), so the two cannot drift and neither can fall
 * behind the read door. Select-family models go through {@link getEditDatalist}
 * (options completed against the SAVED value); the FILTER family goes to its
 * own user-scoped sources — the generic target-section enumeration getDatalist
 * builds is wrong here by construction (a filter's options are what the CALLER
 * may grant, not what the target section holds), and completing against the
 * stored value has no meaning for them.
 *
 * `value` is what the echo is about to hand the client (the saved / echoed
 * entries). Unused by the filter family branch — filter options are never
 * completed against a record's value.
 *
 * No lang parameter: the option labels are ALWAYS in the request data lang
 * ({@link datalistLabelLang}), never the saved instance's lang — the read
 * labels the same way, so echo == read whatever lang the save carried.
 */
export async function getEchoDatalist(
	model: string,
	componentTipo: string,
	componentProperties: unknown,
	owner: DatalistOwner,
	value: readonly unknown[],
	completion: DatalistCompletion = 'stored',
): Promise<ComponentDatalistItem[] | FilterDatalistItem[] | FilterRecordsDatalistItem[]> {
	// The SET is the routing knowledge — the guard that decides whether an echo
	// attaches a datalist ({@link echoesDatalist}) and the branch that builds it
	// are the same test, so a
	// future family member cannot silently fall through to getEditDatalist's
	// generic target-section enumeration (an UNSCOPED list for a user-scoped
	// family: the leak this router exists to prevent). A new member routes to
	// getFilterDatalist by default and must name its own source here if its
	// options live elsewhere.
	if (FILTER_FAMILY_MODELS.has(model)) {
		if (model === 'component_filter_records') {
			const { currentDataLang } = await import('../resolve/request_lang.ts');
			const { getFilterRecordsDatalist } = await import(
				'../api/handlers/filter_records_datalist.ts'
			);
			const principal = currentPrincipal();
			// Fail CLOSED (ISO-01 polarity, the emit hook's rule): no request scope
			// — no sections to grant, never another user's authorized set.
			return principal === undefined
				? []
				: getFilterRecordsDatalist(principal.userId, currentDataLang());
		}
		const { getFilterDatalist } = await import('./filter_projects.ts');
		return getFilterDatalist();
	}
	return getEditDatalist(
		componentTipo,
		componentProperties,
		owner,
		await datalistLabelLang(),
		value,
		completion,
	);
}

/**
 * What the locators handed to an edit datalist ARE, which decides whether the
 * C6 `restricted` completion runs:
 *
 * - `stored` — the record's STORED value (the edit read, the persisted save's
 *   echo): a stored pick the built list lacks whose row exists is marked, so it
 *   is not dropped unnoticed on the next save (owner C6).
 * - `picked` — the CLIENT's own picks on a TEMPORAL instance (temporal.ts):
 *   nothing is stored, so nothing can be dropped unnoticed, and the locators are
 *   the caller's payload — any section, any id, never through the insert law.
 *   Completing them would answer "this row exists" for whatever address the
 *   caller names (a record-existence oracle over every section, outside the
 *   caller's grants); so the temporal echo carries the built list and nothing
 *   else. A model-declared `editGuard` (select_lang's "<name> *") still runs:
 *   its completion reads the language table, not a record of the caller's
 *   choosing.
 */
export type DatalistCompletion = 'stored' | 'picked';

/**
 * THE LABEL LANG of a select-family option list and list value: the request
 * DATA lang — PHP builds them with DEDALO_DATA_LANG
 * (class.component_relation_common.php get_list_of_values(DEDALO_DATA_LANG),
 * component_select_json.php, component_radio_button_json.php), NEVER with the
 * instance lang. These models are relations, never translatable, so their
 * instance lang is lg-nolan (ontology/resolver.ts elementLang): labelling with
 * it would serve the lg-nolan fallback chain (the install's default lang) to a
 * curator working in another language, whatever lang the caller asked for.
 * ONE rule for the read (models/select_family.ts) and both save echoes
 * ({@link getEchoDatalist}), so they cannot disagree.
 */
export async function datalistLabelLang(): Promise<string> {
	const { currentDataLang } = await import('../resolve/request_lang.ts');
	return currentDataLang();
}

/**
 * The datalist an EDIT door attaches next to a component's value: the options
 * ({@link getDatalist}) completed against the stored value by the model
 * source's `editGuard` — for component_select_lang the "<name> *" entry of a
 * stored lang that is not a project lang (PHP component_select_lang_json edit
 * branch). The ONE door for the three edit surfaces — the edit read
 * (select_family emitter), and the save echoes (dd_core_api + temporal.ts)
 * through {@link getEchoDatalist} — so they cannot disagree.
 * `storedLocators` is the value the door is about to hand the client (read:
 * the stored data; echoes: the saved / echoed entries).
 *
 * The GENERIC source's own completion (owner ruling C6): every stored locator
 * absent from the list whose target row still exists is appended as an opaque
 * `restricted` entry ({@link DatalistItem.restricted}); a stored locator whose
 * row is gone gets nothing (PHP). A model-declared source completes through its
 * own `editGuard` instead (its stored values are not record locators).
 */
export async function getEditDatalist(
	componentTipo: string,
	componentProperties: unknown,
	owner: DatalistOwner,
	lang: string,
	storedLocators: readonly unknown[],
	completion: DatalistCompletion = 'stored',
): Promise<ComponentDatalistItem[]> {
	const datalist = await getDatalist(componentTipo, componentProperties, owner, lang);
	const modelSource = await modelDatalistSource(componentTipo);
	if (modelSource === null) {
		// The generic completion marks STORED picks only ({@link DatalistCompletion}).
		return completion === 'stored'
			? appendRestrictedEntries(datalist as DatalistItem[], storedLocators)
			: datalist;
	}
	if (modelSource.editGuard === undefined) return datalist;
	return modelSource.editGuard(datalist, storedLocators);
}

/**
 * The stored locators a built list does NOT carry whose target row still
 * exists — the ones C6 marks. Matched by the locator law (section_tipo +
 * section_id, loose id); a locator without a usable address, a duplicate, or
 * one whose row is gone (deleted target: PHP's blank) is skipped. INT ids out
 * (WC-2026-08-10-section-id-int-canonical).
 */
async function restrictedStoredLocators(
	datalist: readonly DatalistItem[],
	storedLocators: readonly unknown[],
): Promise<{ section_tipo: string; section_id: number }[]> {
	const restricted: { section_tipo: string; section_id: number }[] = [];
	const known = datalist.map((option) => option.value);
	for (const stored of storedLocators) {
		const address = storedAddressOf(stored);
		if (address === null) continue;
		if (known.some((value) => compareLocators(address, value, ['section_tipo', 'section_id'])))
			continue;
		known.push(address);
		const table = await getMatrixTableFromTipo(address.section_tipo);
		if (typeof table !== 'string') continue;
		const row = await memoizedReadMatrixRecord(table, address.section_tipo, address.section_id);
		if (row !== null) restricted.push(address);
	}
	return restricted;
}

/** The (section_tipo, INT section_id) address of a stored value, or null when it has none. */
function storedAddressOf(stored: unknown): { section_tipo: string; section_id: number } | null {
	if (!isPlainObject(stored) || typeof stored.section_tipo !== 'string') return null;
	const sectionId = Number(stored.section_id);
	if (!Number.isInteger(sectionId)) return null;
	return { section_tipo: stored.section_tipo, section_id: sectionId };
}

/** The C6 opaque entries, appended AFTER the built options in stored order. */
async function appendRestrictedEntries(
	datalist: DatalistItem[],
	storedLocators: readonly unknown[],
): Promise<DatalistItem[]> {
	const restricted = await restrictedStoredLocators(datalist, storedLocators);
	if (restricted.length === 0) return datalist;
	const label = await restrictedLabel();
	return [
		...datalist,
		...restricted.map((address) => ({
			value: address,
			label,
			section_id: address.section_id,
			hide: [],
			restricted: true as const,
		})),
	];
}

/**
 * The marker's text: the `restricted` key of the UI label catalog in the
 * request APPLICATION lang (program string, not data — the option labels are
 * in the DATA lang). The master is tripwired complete (labels_tripwire), so the
 * key is never absent; the fallback only types the read.
 */
async function restrictedLabel(): Promise<string> {
	return (await getLabels(currentApplicationLang())).restricted ?? 'restricted';
}

/**
 * security-tools enrichment: the dd1067 profile-tools component renders in the
 * client `view_tools` layout, which needs a per-option tool_name (icon URL +
 * label segment), always_active flag and description NOT stored in the dd1324 option
 * section. Stamp them from the active-tools registry, keyed by section_id
 * (PHP component_check_box::get_datalist → tool_common::hydrate_tools_info,
 * guarded on DEDALO_COMPONENT_SECURITY_TOOLS_PROFILES_TIPO === dd1067).
 */
async function stampToolsInfo(
	componentTipo: string,
	items: DatalistItem[],
	lang: string,
): Promise<void> {
	const { PROFILE_TOOLS_COMPONENT } = await import('../tools/ontology_map.ts');
	if (componentTipo !== PROFILE_TOOLS_COMPONENT) return;
	const { getActiveToolMetaBySectionId } = await import('../tools/registry.ts');
	// Description in the datalist lang (the option labels' lang, part of the cache key).
	const toolsBySectionId = await getActiveToolMetaBySectionId(lang);
	for (const item of items) {
		const meta = toolsBySectionId.get(Number(item.section_id));
		// Unknown/unregistered tools mirror PHP's 'Unknown'/false fallback.
		item.tool_name = meta?.name ?? 'Unknown';
		item.always_active = meta?.always_active ?? false;
		item.tool_description = meta?.description ?? null;
	}
}

/**
 * The GENERIC option list — every record of the request_config target
 * section(s) the caller may see, narrowed by the record-resolved filter.
 * Private: reached only through getDatalist, after the model's own source was
 * consulted.
 */
async function getTargetSectionDatalist(
	componentTipo: string,
	componentProperties: unknown,
	owner: DatalistOwner,
	lang: string,
): Promise<DatalistItem[]> {
	const sources = await resolveDatalistSources(componentTipo, componentProperties, owner, lang);
	const statements = await buildTargetStatements(sources, currentPrincipal());
	// Owner section is part of the key — see the datalistCache doc-block: the
	// sqo target can resolve from the CALLER, so the same component tipo means
	// a different option list per owner section. The label set and the
	// enumeration statements too — see datalistCacheKey.
	const cacheKey = datalistCacheKey(componentTipo, owner.section_tipo, lang, sources, statements);
	const cached = datalistCache.get(cacheKey);
	if (cached !== undefined) return cached;
	const items: DatalistItem[] = [];
	const { labelDdos, hideDdos, targetSections } = sources;

	for (const { targetSection, statement } of statements) {
		const table = (await getMatrixTableFromTipo(targetSection)) as string;
		const rows = (await runOptionSearch(statement)).map((sectionId) => ({ section_id: sectionId }));
		for (const row of rows) {
			const labelParts: string[] = [];
			const hideItems: DatalistHideItem[] = [];
			// ONE record read feeding both projections (PHP instantiates a
			// component per ddo against the same row) — the read is the expensive
			// part, and a 60k-option thesaurus cannot afford two.
			if (labelDdos.length > 0 || hideDdos.length > 0) {
				const record = await memoizedReadMatrixRecord(table, targetSection, row.section_id);
				if (record !== null) {
					for (const ddo of labelDdos) {
						labelParts.push(await resolveDdoLabel(record, ddo.tipo, lang));
					}
					for (const ddo of hideDdos) {
						hideItems.push({
							literal: await resolveDdoLabel(record, ddo.tipo, lang),
							tipo: ddo.tipo,
							section_id: row.section_id,
							section_tipo: targetSection,
						});
					}
				}
			}
			items.push({
				// The DB column is already an int — no cast in either direction
				// (a String() here is what made every new select-family value
				// persist as a string; WC-2026-08-10-section-id-int-canonical).
				value: { section_tipo: targetSection, section_id: row.section_id },
				label: labelParts.join(' | '),
				section_id: row.section_id,
				hide: hideItems,
			});
		}
	}

	// Sort (PHP get_list_of_values): properties.sort_by custom rule when
	// declared, else natural-ascending label.
	const sortBy = (
		componentProperties as { sort_by?: { path?: string; direction?: string }[] } | null
	)?.sort_by;
	const customSort = Array.isArray(sortBy) ? sortBy[0] : undefined;
	if (customSort !== undefined) {
		const path = String(customSort.path ?? 'label');
		const descending = customSort.direction === 'DESC';
		items.sort((a, b) => {
			const valueA = (a as unknown as Record<string, unknown>)[path] ?? 0;
			const valueB = (b as unknown as Record<string, unknown>)[path] ?? 0;
			const numericA = typeof valueA === 'number' || /^\d+(\.\d+)?$/.test(String(valueA));
			const numericB = typeof valueB === 'number' || /^\d+(\.\d+)?$/.test(String(valueB));
			const diff =
				numericA && numericB
					? Number(valueA) - Number(valueB)
					: strnatcmp(String(valueA), String(valueB));
			return descending ? -diff : diff;
		});
	} else {
		items.sort((a, b) => strnatcmp(a.label, b.label));
	}

	await stampToolsInfo(componentTipo, items, lang);

	// Store + index in ONE synchronous block (no await in between): an eviction
	// event landing mid-populate must never leave a cached list the section
	// index cannot reach (see datalistKeysBySection).
	if (datalistCache.size >= MAX_DATALIST_CACHE_ENTRIES) clearDatalistCache();
	datalistCache.set(cacheKey, items);
	for (const targetSection of targetSections) {
		let keysOfSection = datalistKeysBySection.get(targetSection);
		if (keysOfSection === undefined) {
			keysOfSection = new Set<string>();
			datalistKeysBySection.set(targetSection, keysOfSection);
		}
		keysOfSection.add(cacheKey);
	}
	return items;
}

/**
 * Resolve the label of EACH stored locator DIRECTLY (read the target
 * record's label component) — O(locators) instead of materializing the full
 * datalist (which enumerates every target-section record; unbounded
 * hierarchies reach 200K+ rows). Labels return in alphabetical order,
 * matching the datalist-ordered output of get_list_value.
 * `termOpts` = a frontier-armed caller's frontier, threaded into a label read
 * through the term resolver (its term may cross further — T1-32 review).
 */
export async function resolveLocatorLabels(
	componentTipo: string,
	componentProperties: unknown,
	ownerSectionTipo: string,
	lang: string,
	storedLocators: { section_tipo?: unknown; section_id?: unknown }[],
	termOpts: TermReadOptions = {},
): Promise<string[]> {
	if (storedLocators.length === 0) return [];
	const context: RequestConfigContext = {
		ownerTipo: componentTipo,
		ownerSectionTipo,
		mode: 'edit',
		ownerIsSection: false,
	};
	const config = await buildRequestConfigForElement(componentProperties, context);
	const labelDdo = config[0]?.show?.ddo_map[0];
	if (labelDdo === undefined) return [];
	const labelModel = await getModelByTipo(labelDdo.tipo);
	if (labelModel === null) return [];

	const labels: string[] = [];
	for (const locator of storedLocators) {
		const targetSection = String(locator.section_tipo ?? '');
		const targetId = Number(locator.section_id ?? 0);
		if (targetSection === '' || !Number.isFinite(targetId)) continue;
		// A THESAURUS target whose configured label IS its term component
		// (toponymy, thesauri) is read through the term resolver's one chain
		// (T2 THES-01): data lang, the thesaurus's OWN main lang, lg-nolan, then
		// the project langs in config order — never the install default first,
		// which the component chain below would pick, and never a lang no project
		// declares. Toponymy shows its own lang before any other. Text only: the
		// untranslated flag is for screens. A portal showing another component
		// keeps that one.
		if ((await getTermTipos(targetSection, 'thesaurus')).includes(labelDdo.tipo)) {
			const term = await getTermByLocator(
				{ section_tipo: targetSection, section_id: targetId },
				lang,
				true,
				'thesaurus',
				termOpts,
			);
			if (term !== null && term !== '') labels.push(term);
			continue;
		}
		const table = await getMatrixTableFromTipo(targetSection);
		if (table === null) continue;
		const record = await memoizedReadMatrixRecord(table, targetSection, targetId);
		if (record === null) continue;
		const first = shownItems(
			await resolveComponentValue(record, labelDdo.tipo, labelModel, lang),
		)?.[0] as { value?: unknown } | undefined;
		if (typeof first?.value === 'string' && first.value !== '') labels.push(first.value);
	}
	labels.sort(strnatcmp);
	return labels;
}

/**
 * The label strings for a component's STORED locators (PHP get_list_value):
 * datalist entries matching the stored locators, in datalist (label) order —
 * then, for each stored locator the list lacks whose target row exists, the
 * `restricted` marker (owner ruling C6; PHP showed nothing). A stored locator
 * whose row is gone stays blank.
 */
export async function getRelationListValue(
	componentTipo: string,
	componentProperties: unknown,
	owner: DatalistOwner,
	lang: string,
	storedLocators: { section_tipo?: unknown; section_id?: unknown }[],
): Promise<string[]> {
	const datalist = await getDatalist(componentTipo, componentProperties, owner, lang);
	const labels: string[] = [];
	for (const option of datalist) {
		// Locator law (DEC-21): value-based section_tipo+section_id match via
		// compareLocators (loose section_id: 5 == '5', same as the Number()
		// coercion this replaced).
		const matched = storedLocators.some((locator) =>
			compareLocators(locator as Locator, option.value, ['section_tipo', 'section_id']),
		);
		if (matched) labels.push(option.label);
	}
	const restricted = await restrictedStoredLocators(datalist as DatalistItem[], storedLocators);
	if (restricted.length === 0) return labels;
	const label = await restrictedLabel();
	return [...labels, ...restricted.map(() => label)];
}
