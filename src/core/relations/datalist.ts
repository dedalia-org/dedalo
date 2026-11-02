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
 * live users.
 *
 * HIDE ddo values are resolved per option (PHP :2931-2955) — see
 * DatalistHideItem. They were emitted as `[]` until 2026-07-31, which broke
 * the dataframe rating colour: the client reads `hide[0].literal` to paint the
 * frame chip and threw "Cannot read properties of undefined (reading
 * 'literal')", killing the whole record render.
 *
 * Ledgered: properties filtered_by_search / filtered_by_search_dynamic
 * narrowing (the PHP elseif branch — no live datalist component on this
 * install carries them).
 */

import type { FilterRecordsDatalistItem } from '../api/handlers/filter_records_datalist.ts';
import { getComponentModel } from '../components/registry.ts';
import type { DatalistSourceId } from '../components/types.ts';
import { compareLocators, type Locator } from '../concepts/locator.ts';
import type { MatrixRecord } from '../db/matrix.ts';
import { sql } from '../db/postgres.ts';
import { memoizedReadMatrixRecord } from '../db/record_memo.ts';
import { createOntologyCache } from '../ontology/cache_factory.ts';
import { registerOntologyCacheClearer } from '../ontology/cache_invalidation.ts';
import { registerPairingChangeListener } from '../ontology/model_section.ts';
import { getMatrixTableFromTipo, getModelByTipo } from '../ontology/resolver.ts';
import { resolveComponentValue } from '../resolve/component_data.ts';
import { currentApplicationLang } from '../resolve/request_lang.ts';
import { registerSectionDataListener } from '../section_record/save_event.ts';
import { getTermByLocator, getTermTipos } from '../ts_object/term_resolver.ts';
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
 * (component, owner section, lang), so an unbounded Map grows with every
 * component×owner×lang triple ever requested. On overflow BOTH maps are
 * dropped together (the O(1) wipe of the term-resolver precedent, not LRU) —
 * clearing the list cache without its section index would leave unreachable
 * keys behind. The owner-section key part (below) multiplies the key space by
 * caller section against this cap, and the overflow is a TOTAL wipe, not an
 * LRU eviction: a wide multi-hierarchy browse that thrashes past 500 entries
 * rebuilds everything from zero — measure the hit rate there and raise the
 * cap if it thrashes, never remove the owner from the key.
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
 */
function datalistCacheKey(
	componentTipo: string,
	ownerSectionTipo: string,
	lang: string,
	labelDdos: readonly { tipo: string }[],
	hideDdos: readonly { tipo: string }[],
): string {
	const tipos = (ddos: readonly { tipo: string }[]) => ddos.map((ddo) => ddo.tipo).join(',');
	return `${componentTipo}_${ownerSectionTipo}_${lang}_${tipos(labelDdos)}|${tipos(hideDdos)}`;
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
	const { value, fallbackValue } = await resolveComponentValue(record, ddoTipo, model, lang);
	const first = (value ?? fallbackValue)?.[0] as { value?: unknown } | undefined;
	return typeof first?.value === 'string' ? first.value : '';
}

/**
 * The option SOURCES of a selection component — which target sections its
 * request_config points at, which show-ddos label an option, and the fixed
 * filter that narrows the enumeration. Shared by the full build
 * ({@link getDatalist}) and the bounded count ({@link probeDatalistSize}) so
 * the two can never disagree about what the component's options ARE.
 */
async function resolveDatalistSources(
	componentTipo: string,
	componentProperties: unknown,
	ownerSectionTipo: string,
	lang: string,
): Promise<{
	targetSections: string[];
	labelDdos: { tipo: string }[];
	hideDdos: { tipo: string }[];
	filterGroup: Record<string, unknown> | undefined;
}> {
	const context: RequestConfigContext = {
		ownerTipo: componentTipo,
		ownerSectionTipo,
		mode: 'edit', // options come from the component's EDIT config (full ddos)
		ownerIsSection: false,
		lang,
	};
	const config = await buildRequestConfigForElement(componentProperties, context);
	const mainItem = config[0];
	// Every COMPONENT-model show ddo contributes to the label (PHP skips
	// non-component ddos with an error log).
	const labelDdos = (mainItem?.show?.ddo_map ?? []).filter(
		(ddo) => typeof ddo.model === 'string' && ddo.model.startsWith('component_'),
	);
	// HIDE ddos (PHP :2934-2936) — same component-model filter as the labels;
	// their values ride on each option as internal data for the widget.
	const hideDdos = (mainItem?.hide?.ddo_map ?? []).filter(
		(ddo) => typeof ddo.model === 'string' && ddo.model.startsWith('component_'),
	);

	// PHP get_list_of_values (:2860): the FIRST fixed_filter group becomes the
	// option search's filter; a non-object entry is ignored with an error log.
	const fixedFilter = (mainItem?.sqo as { fixed_filter?: unknown[] } | undefined)?.fixed_filter;
	let filterGroup: Record<string, unknown> | undefined;
	if (Array.isArray(fixedFilter) && fixedFilter.length > 0) {
		const first = fixedFilter[0];
		if (first !== null && typeof first === 'object' && !Array.isArray(first)) {
			filterGroup = first as Record<string, unknown>;
		} else {
			console.error(`getDatalist '${componentTipo}': ignored fixed filter, bad format`);
		}
	}
	return { targetSections: extractSqoSectionTipos(mainItem), labelDdos, hideDdos, filterGroup };
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
	ownerSectionTipo: string,
	lang: string,
	limit: number,
): Promise<number> {
	if (limit <= 0) return 0;
	// A model-sourced list is small by construction and cheap to build: count it.
	const modelSource = await modelDatalistSource(componentTipo);
	if (modelSource !== null) return Math.min((await modelSource.options(lang)).length, limit);
	const { targetSections, labelDdos, hideDdos, filterGroup } = await resolveDatalistSources(
		componentTipo,
		componentProperties,
		ownerSectionTipo,
		lang,
	);
	// A list already built is already paid for — count it rather than re-probe.
	// SAME key as getDatalist — the doc-block on resolveDatalistSources is the
	// contract: probe and build must never disagree about what the options ARE.
	const cached = datalistCache.get(
		datalistCacheKey(componentTipo, ownerSectionTipo, lang, labelDdos, hideDdos),
	);
	if (cached !== undefined) return Math.min(cached.length, limit);
	let found = 0;
	for (const targetSection of targetSections) {
		if (found >= limit) break;
		const table = await getMatrixTableFromTipo(targetSection);
		if (table === null) continue;
		const remaining = limit - found;
		if (filterGroup !== undefined) {
			// The SAME option search the full build runs, capped: a fixed filter can
			// narrow a huge section to a handful, so counting the raw table would
			// refuse lists that are perfectly small.
			const { sanitizeClientSqo } = await import('../concepts/sqo.ts');
			const { buildSearchSql } = await import('../search/sql_assembler.ts');
			const { runSearch } = await import('../search/search_statement.ts');
			const sqo = sanitizeClientSqo({
				section_tipo: [targetSection],
				filter: filterGroup,
				limit: 1,
			});
			// AFTER sanitizing, exactly as the full build sets 'all': the bound is
			// the CALLER's, not a client-supplied one, so it must not be squeezed
			// through the client ceiling (a small DEDALO_SEARCH_CLIENT_MAX_LIMIT
			// would silently under-count and turn every refusal into a pass).
			sqo.limit = remaining;
			const query = await buildSearchSql(sqo);
			const rows = (await runSearch(query)) as unknown[];
			found += rows.length;
			continue;
		}
		const rows = (await sql.unsafe(
			`SELECT section_id FROM "${table}" WHERE section_tipo = $1 LIMIT $2`,
			[targetSection, remaining],
		)) as { section_id: number }[];
		found += rows.length;
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
	ownerSectionTipo: string,
	lang: string,
): Promise<ComponentDatalistItem[]> {
	// The model's OWN option source wins (descriptor `datalistSource`): for
	// component_select_lang that is the project languages — the node's sqo
	// names lg1, whose generic enumeration is every language record there is.
	const modelSource = await modelDatalistSource(componentTipo);
	if (modelSource !== null) return modelSource.options(lang);
	return getTargetSectionDatalist(componentTipo, componentProperties, ownerSectionTipo, lang);
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
	ownerSectionTipo: string,
	value: readonly unknown[],
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
			const { currentPrincipal } = await import('../security/request_context.ts');
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
		ownerSectionTipo,
		await datalistLabelLang(),
		value,
	);
}

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
 */
export async function getEditDatalist(
	componentTipo: string,
	componentProperties: unknown,
	ownerSectionTipo: string,
	lang: string,
	storedLocators: readonly unknown[],
): Promise<ComponentDatalistItem[]> {
	const datalist = await getDatalist(componentTipo, componentProperties, ownerSectionTipo, lang);
	const modelSource = await modelDatalistSource(componentTipo);
	if (modelSource?.editGuard === undefined) return datalist;
	return modelSource.editGuard(datalist, storedLocators);
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
 * section(s). Private: reached only through getDatalist, after the model's own
 * source was consulted.
 */
async function getTargetSectionDatalist(
	componentTipo: string,
	componentProperties: unknown,
	ownerSectionTipo: string,
	lang: string,
): Promise<DatalistItem[]> {
	const { targetSections, labelDdos, hideDdos, filterGroup } = await resolveDatalistSources(
		componentTipo,
		componentProperties,
		ownerSectionTipo,
		lang,
	);
	// Owner section is part of the key — see the datalistCache doc-block: the
	// sqo target can resolve from the CALLER, so the same component tipo means
	// a different option list per owner section. The label set too — see
	// datalistCacheKey.
	const cacheKey = datalistCacheKey(componentTipo, ownerSectionTipo, lang, labelDdos, hideDdos);
	const cached = datalistCache.get(cacheKey);
	if (cached !== undefined) return cached;
	const items: DatalistItem[] = [];

	for (const targetSection of targetSections) {
		const table = await getMatrixTableFromTipo(targetSection);
		if (table === null) continue;
		let rows: { section_id: number }[];
		if (filterGroup !== undefined) {
			// The filtered enumeration runs the REAL option search (PHP sqo
			// limit 0 = all; no principal here → projects filter skipped, the
			// resolver's standing posture).
			const { sanitizeClientSqo } = await import('../concepts/sqo.ts');
			const { buildSearchSql } = await import('../search/sql_assembler.ts');
			const { runSearch } = await import('../search/search_statement.ts');
			const sqo = sanitizeClientSqo({
				section_tipo: [targetSection],
				filter: filterGroup,
				limit: 1,
			});
			sqo.limit = 'all';
			const query = await buildSearchSql(sqo);
			const found = (await runSearch(query)) as ({
				section_id: number;
			} & Record<string, unknown>)[];
			rows = found
				.map((row) => ({ section_id: row.section_id }))
				.sort((a, b) => a.section_id - b.section_id);
		} else {
			rows = (await sql.unsafe(
				`SELECT section_id FROM "${table}" WHERE section_tipo = $1 ORDER BY section_id`,
				[targetSection],
			)) as { section_id: number }[];
		}
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
 */
export async function resolveLocatorLabels(
	componentTipo: string,
	componentProperties: unknown,
	ownerSectionTipo: string,
	lang: string,
	storedLocators: { section_tipo?: unknown; section_id?: unknown }[],
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
		// (toponymy, thesauri) is read through the term resolver: data lang first,
		// then the thesaurus's OWN main lang — never the install default or the
		// first lang found, which the component chain below would pick. Toponymy
		// stays untranslated. A portal showing another component keeps that one.
		if ((await getTermTipos(targetSection, 'thesaurus')).includes(labelDdo.tipo)) {
			const term = await getTermByLocator(
				{ section_tipo: targetSection, section_id: targetId },
				lang,
				true,
			);
			if (term !== null && term !== '') labels.push(term);
			continue;
		}
		const table = await getMatrixTableFromTipo(targetSection);
		if (table === null) continue;
		const record = await memoizedReadMatrixRecord(table, targetSection, targetId);
		if (record === null) continue;
		const { value, fallbackValue } = await resolveComponentValue(
			record,
			labelDdo.tipo,
			labelModel,
			lang,
		);
		const first = (value ?? fallbackValue)?.[0] as { value?: unknown } | undefined;
		if (typeof first?.value === 'string' && first.value !== '') labels.push(first.value);
	}
	labels.sort(strnatcmp);
	return labels;
}

/**
 * The label strings for a component's STORED locators (PHP get_list_value):
 * datalist entries matching the stored locators, in datalist (label) order.
 */
export async function getRelationListValue(
	componentTipo: string,
	componentProperties: unknown,
	ownerSectionTipo: string,
	lang: string,
	storedLocators: { section_tipo?: unknown; section_id?: unknown }[],
): Promise<string[]> {
	const datalist = await getDatalist(componentTipo, componentProperties, ownerSectionTipo, lang);
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
	return labels;
}
