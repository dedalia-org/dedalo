/**
 * TS_OBJECT (PHP core/ts_object/class.ts_object.php, read side) — assembles the
 * display payload of ONE thesaurus/ontology tree node for area_thesaurus /
 * area_ontology.
 *
 * A tree node is a section record. Guided by the section's `section_list_thesaurus`
 * ontology config (`properties.show.ddo_map`), buildNodeData iterates the mapped
 * elements (term / icon / link_children) and produces the TsNodeData object the
 * client renders as one tree row. The heavy reads (order, is_indexable,
 * is_descriptor) are batched through node_repository; term strings through
 * term_resolver.
 *
 * COVERAGE LEDGER (format_component_data model branches — PHP :1430):
 *   COVERED: term/string family (string/date/number/iri columns, lang-filtered),
 *   is_descriptor/icon relations, component_relation_index counts,
 *   link_children (children resolution + descriptor/ND classification),
 *   portal/autocomplete_hi (locators → term strings, cached), the 'M' icon's
 *   model_value badge (get_value via the component's request_config ddo_map).
 *   DEFERRED (ledgered): component_relation_related inverse-reference merge (tree
 *   term rarely a related component) and the legacy component_relation_struct
 *   skip (PHP drops a relation_index tagged legacy component_relation_struct;
 *   TS emits it, so a v6-legacy install renders one extra count badge).
 *   CLOSED SINCE: component_svg URL/file-exists resolution (2026-09-01,
 *   WC-2026-09-01-ts-object-svg-url) and get_indexation_grid, which is served
 *   by src/core/section/indexation_grid.ts and differential-gated — the line
 *   claiming otherwise was stale.
 *
 * PHP anchors: get_ar_elements (:212), parse_child_data (:329), get_data (:488),
 * get_children_data (:594), has_children_of_type (:714), is_indexable (:827),
 * get_permissions_element (:1111), get_count_data_group_by (:1202),
 * process_element_details/format_component_data/resolve_element_value (:1320-1604).
 */

import { statSync } from 'node:fs';
import { config } from '../../config/config.ts';
import { canonicalizeStoredSectionId, isSectionId } from '../concepts/section_id.ts';
import { type MatrixRecord, readMatrixRecord } from '../db/matrix.ts';
import { sql } from '../db/postgres.ts';
import { DedaloError } from '../errors/index.ts';
import { createDataCache } from '../ontology/cache_factory.ts';
import { labelByTipo, ONTOLOGY_STRUCTURE_LANG } from '../ontology/labels.ts';
import {
	HIERARCHY_BUTTON_NEW,
	HIERARCHY_MAIN_SECTION,
	THESAURUS_BUTTON_DELETE,
	THESAURUS_BUTTON_NEW,
	THESAURUS_SECTION,
} from '../ontology/ontology_tipos.ts';
import {
	findFirstDescendantTipoByModel,
	getColumnNameByModel,
	getMatrixTableFromTipo,
	getModelByTipo,
	getNode,
	getSectionRealTipo,
	getTranslatableByTipo,
} from '../ontology/resolver.ts';
import { getSectionMap } from '../ontology/section_map.ts';
import {
	type ChildLocator,
	countChildrenOrNull,
	getChildren,
	getChildrenRecursive,
	getComponentOrderTipo,
} from '../relations/children.ts';
import { stripTags } from '../resolve/html_text.ts';
import { currentDataLang } from '../resolve/request_lang.ts';
import { countInverseReferences } from '../search/search_related.ts';
import type { Principal } from '../security/permissions.ts';
import { getPermissions } from '../security/permissions.ts';
import { batchDescriptorFlags, fetchNodeInfo, type NodeLocator } from './node_repository.ts';
import {
	getDdoValueByLocator,
	getTermByLocator,
	invalidateNode as invalidateTermNode,
	type TermLocator,
} from './term_resolver.ts';

// DEDALO_DATA_LANG is read PER REQUEST via currentDataLang() at each use site
// (S2-11): PHP passes the per-request data lang (class.ts_object.php:1441-1445);
// a module-level capture froze the install default for every session.
/** DEDALO_DATA_LANG_DEFAULT — the main-lang fallback for untranslated term data. */
const DATA_LANG_DEFAULT = config.lang.dataLangDefault;
/** DEDALO_ONTOLOGY_SECTION_TIPO — the ontology main section root. */
const ONTOLOGY_SECTION_TIPO = 'ontology35';

/** One ddo_map entry (from section_list_thesaurus properties.show.ddo_map). */
interface DdoMapEntry {
	type?: string;
	tipo?: string | string[];
	icon?: string;
	show_data?: string;
	[extra: string]: unknown;
}

/** The caller options bag threaded into a node build (PHP $options stdClass). */
export interface TsOptions {
	order?: number | string | null;
	is_indexable?: boolean;
	model?: boolean | null;
	have_children?: boolean;
	area_model?: string;
}

/** One rendered element in a node's ar_elements. */
export interface TsElement {
	type: string;
	tipo: string | string[];
	value?: unknown;
	model?: string;
	/** 'M'-icon only: the target's model name ('area_tool'), the Ctrl+M badge. */
	model_value?: string;
	show_data?: string;
	count_result?: unknown;
}

/**
 * The node payload (PHP get_data() property insertion order preserved for wire
 * familiarity). children_tipo / has_descriptor_children / model_value are added
 * conditionally, exactly where PHP adds them.
 */
export interface TsNodeData {
	section_tipo: string;
	// A tree node IS a matrix record, so its address is an int
	// (WC-2026-08-10-section-id-int-canonical): every producer canonicalizes
	// before building — parseChildData at the locator boundary, the dd_ts_api
	// door via coerceSectionId, search.ts straight off the int DB column.
	section_id: number;
	ts_id: string;
	ts_parent: string | null;
	order: number | string | null;
	mode: 'list';
	lang: string;
	is_descriptor: boolean;
	is_indexable: boolean;
	ar_elements: TsElement[];
	permissions_button_new: number;
	permissions_button_delete: number;
	children_tipo?: string | null;
	has_descriptor_children?: boolean;
}

// ---------------------------------------------------------------------------
// Resolved-child cache for indexation counting (content-keyed; bounded 1000).
// Data-derived (child sets come from relation data of arbitrary thesaurus
// records) with NO cheap reverse mapping from a written section to the cached
// subtrees containing it — so ANY record write/delete drops the whole cache
// (S2-10). PHP's twin was request-scoped; the full clear on write is the
// process-lifetime equivalent (the cache exists for within-request batch
// counting, so post-write cold starts are the designed cost, not a regression).
// ---------------------------------------------------------------------------
const resolvedChildCache = createDataCache<string, ChildLocator[]>((cache) => {
	cache.clear();
});

/** Targeted eviction after a tree write (PHP invalidate_node :1021). */
export function invalidateNode(sectionTipo: string, sectionId: number): void {
	invalidateTermNode(sectionTipo, sectionId);
	resolvedChildCache.clear();
}

// ---------------------------------------------------------------------------
// GET_AR_ELEMENTS (PHP :212).
// ---------------------------------------------------------------------------

/** The section_list_thesaurus ddo_map of a section (direct child, virtual-aware). */
async function readDdoMap(sectionTipo: string): Promise<DdoMapEntry[] | null> {
	const read = async (parent: string) =>
		(await sql.unsafe(
			`SELECT properties FROM dd_ontology WHERE parent = $1 AND model = 'section_list_thesaurus' LIMIT 1`,
			[parent],
		)) as { properties: { show?: { ddo_map?: DdoMapEntry[] } } | null }[];
	let rows = await read(sectionTipo);
	let props = rows[0]?.properties ?? null;
	if (props?.show?.ddo_map === undefined) {
		// virtual section → real section fallback (the one law, getSectionRealTipo).
		const real = await getSectionRealTipo(sectionTipo);
		if (real !== sectionTipo) {
			rows = await read(real);
			props = rows[0]?.properties ?? null;
		}
	}
	const ddoMap = props?.show?.ddo_map;
	return Array.isArray(ddoMap) ? ddoMap : null;
}

/**
 * The ddo_map elements to render (PHP get_ar_elements :212). model transform:
 * model===false drops 'link_children_model'; model===true drops 'link_children'
 * for the hierarchy/ontology roots and promotes 'link_children_model'→'link_children'.
 */
export async function getArElements(
	sectionTipo: string,
	model: boolean | null = false,
): Promise<DdoMapEntry[]> {
	const ddoMap = await readDdoMap(sectionTipo);
	if (ddoMap === null) return [];
	const elements: DdoMapEntry[] = [];
	for (const current of ddoMap) {
		const type = current.type ?? null;
		if (model === false && type === 'link_children_model') {
			continue;
		}
		if (model === true) {
			if (
				type === 'link_children' &&
				(sectionTipo === HIERARCHY_MAIN_SECTION || sectionTipo === ONTOLOGY_SECTION_TIPO)
			) {
				continue;
			}
			if (type === 'link_children_model') {
				// promote a shallow copy so the shared ddo_map is not mutated.
				elements.push({ ...current, type: 'link_children' });
				continue;
			}
		}
		elements.push(current);
	}
	return elements;
}

// ---------------------------------------------------------------------------
// IS_INDEXABLE (PHP :827).
// ---------------------------------------------------------------------------
export async function isIndexable(sectionTipo: string, sectionId: number): Promise<boolean> {
	if (sectionTipo.startsWith('hierarchy') || sectionTipo.startsWith('ontology')) {
		return false; // roots are always structural
	}
	const model = await getModelByTipo(sectionTipo);
	if (model === null) return false;
	const sectionMap = await getSectionMap(sectionTipo);
	const isIndexableTipo = (sectionMap?.thesaurus as { is_indexable?: unknown } | undefined)
		?.is_indexable;
	if (isIndexableTipo === null || isIndexableTipo === undefined) return false;
	if (isIndexableTipo === false) return false;
	if (typeof isIndexableTipo !== 'string') return false;
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === null) return false;
	const record = await readMatrixRecord(table, sectionTipo, sectionId);
	const items =
		((record?.columns.relation as Record<string, { section_id?: unknown }[]> | null)?.[
			isIndexableTipo
		] as { section_id?: unknown }[] | undefined) ?? [];
	const first = items[0];
	return first?.section_id !== undefined && Math.trunc(Number(first.section_id)) === 1;
}

// ---------------------------------------------------------------------------
// GET_PERMISSIONS_ELEMENT (PHP :1111).
// ---------------------------------------------------------------------------

/**
 * First child component of `model` under a section subtree (virtual-aware).
 * Delegates to the canonical (cached, hub-cleared) T3 accessor — audit S2-19.
 */
async function sectionChildTipoByModel(sectionTipo: string, model: string): Promise<string | null> {
	return findFirstDescendantTipoByModel(sectionTipo, model);
}

/** The permission bitmask for a node UI control (PHP get_permissions_element). */
export async function getPermissionsElement(
	sectionTipo: string,
	elementName: 'button_new' | 'button_delete',
	principal: Principal,
): Promise<number> {
	const childPermissions = async (model: string): Promise<number> => {
		const buttonTipo = await sectionChildTipoByModel(sectionTipo, model);
		if (buttonTipo === null) return 0;
		return getPermissions(principal, sectionTipo, buttonTipo);
	};

	if (elementName === 'button_new') {
		if (sectionTipo === HIERARCHY_MAIN_SECTION) {
			return getPermissions(principal, sectionTipo, HIERARCHY_BUTTON_NEW);
		}
		if (sectionTipo === THESAURUS_SECTION) {
			return getPermissions(principal, sectionTipo, THESAURUS_BUTTON_NEW);
		}
		return childPermissions('button_new');
	}
	// button_delete
	if (sectionTipo === HIERARCHY_MAIN_SECTION) {
		return 0; // hierarchy roots are never deletable
	}
	if (sectionTipo === THESAURUS_SECTION) {
		return getPermissions(principal, sectionTipo, THESAURUS_BUTTON_DELETE);
	}
	return childPermissions('button_delete');
}

// ---------------------------------------------------------------------------
// GET_COUNT_DATA_GROUP_BY (PHP :1202) — indexation-icon counts.
// ---------------------------------------------------------------------------

interface CountGroupResult {
	total: number;
	// PHP count_data_group_by items carry `value` (not `count`); ts_object's
	// array_map enriches each with the ontology `label` and flattens `key`.
	totals_group: { key: string; label: string | null; value: number }[];
}

/**
 * Grouped indexation cross-reference count for an index-icon (PHP :1202). When
 * the ddo entry carries `show_data`, the count spans the node AND its recursive
 * descendants; otherwise just the node. The recursive child set is cached by
 * node identity (bounded 1000). Result shape mirrors count_data_group_by with the
 * label-enriched totals_group.
 */
export async function getCountDataGroupBy(
	sectionTipo: string,
	sectionId: number,
	componentTipo: string,
	ddoEntry: DdoMapEntry,
): Promise<CountGroupResult> {
	// The component's inverse question (PHP count_data_group_by applies BOTH
	// the config_relation.relation_type and the get_target_section filter —
	// tchi59 on dc1 must NOT count a tch1 pointer). Dynamic import: the
	// relation model modules are a heavier subsystem than this counter needs
	// statically.
	const { resolveIndexConfig } = await import('../relations/models/relation_index.ts');
	const indexConfig = await resolveIndexConfig(componentTipo, sectionTipo);
	const targets: { section_tipo: string; section_id: number }[] = [
		{ section_tipo: sectionTipo, section_id: sectionId },
	];
	if (ddoEntry.show_data !== undefined) {
		const cacheKey = `${sectionTipo}_${sectionId}`;
		let records = resolvedChildCache.get(cacheKey);
		if (records === undefined) {
			records = await getChildrenRecursive(sectionId, sectionTipo);
			if (resolvedChildCache.size >= 1000) resolvedChildCache.clear();
			resolvedChildCache.set(cacheKey, records);
		}
		for (const record of records) {
			targets.push({ section_tipo: record.section_tipo, section_id: record.section_id });
		}
	}

	const filterLocators = targets.map((target) => ({
		type: indexConfig.relationType,
		section_tipo: target.section_tipo,
		section_id: target.section_id,
	}));
	const counted = await countInverseReferences(filterLocators, {
		groupBy: ['section_tipo'],
		sectionTipos: indexConfig.targetSections,
	});

	const totalsGroup: { key: string; label: string | null; value: number }[] = [];
	for (const group of counted.totals_group ?? []) {
		const key = group.key[0] ?? '';
		// Structure-lang term or first non-empty, null when the node has no term
		// (the old private copy's exact chain) — S2-27: resolved through the
		// cached canonical label module instead of a raw per-call query.
		totalsGroup.push({
			key,
			label: await labelByTipo(key, ONTOLOGY_STRUCTURE_LANG),
			value: group.value,
		});
	}
	return { total: counted.total, totals_group: totalsGroup };
}

// ---------------------------------------------------------------------------
// component data reads for the element loop.
// ---------------------------------------------------------------------------

/** Raw stored items for a component tipo on a preloaded record. */
function readItemsFromRecord(
	record: MatrixRecord | null,
	tipo: string,
	model: string,
): Record<string, unknown>[] {
	if (record === null) return [];
	const column = getColumnNameByModel(model);
	if (column === null) return [];
	const bag = record.columns[column as keyof typeof record.columns] as Record<
		string,
		Record<string, unknown>[]
	> | null;
	return bag?.[tipo] ?? [];
}

/**
 * The component_data for one element tipo (PHP get_data_lang + format_component_data).
 * relation_children → child locators; relation_index → [] (counted separately);
 * section_id → the record's own id (virtual component, no jsonb column);
 * portal/autocomplete_hi → locators resolved to term strings; translatable string
 * families → lang-filtered items; everything else → raw items.
 */
async function getComponentDataLang(
	record: MatrixRecord | null,
	sectionTipo: string,
	sectionId: number,
	tipo: string,
	model: string,
	lang: string,
): Promise<unknown[] | string> {
	if (model === 'component_relation_index') return [];
	if (model === 'component_relation_children') {
		return getChildren(sectionId, sectionTipo, tipo);
	}
	if (model === 'component_section_id') {
		// Virtual, read-only: its `column` is the section_id PK, not a jsonb bag,
		// so it can never be read from the record (PHP component_section_id::get_data
		// :63 → [(int)section_id], [null] when unset). The ontology ddo_map term is
		// the 3-tipo array [term, tld, section_id], and the client PARSES that value
		// back with /^(.*) ([a-z]{2,}) ([0-9]+)$/ (render_ts_line.js render_ontology_term)
		// — drop the id and the regex fails, so the whole "Term dd" string renders as
		// the label and the [tipo] badge falls back to section_tipo+section_id.
		return [sectionId !== 0 ? sectionId : null];
	}

	let items = readItemsFromRecord(record, tipo, model);
	// Lang filter for literal families (string/date/iri/geo), in the component's
	// ELEMENT LANG (PHP common::get_element_lang :3684): a translatable component
	// resolves in DEDALO_DATA_LANG, a NON-translatable one in lg-nolan. This is
	// load-bearing for the empty-skip icon check — e.g. a non-translatable
	// text_area holding a lg-spa value is EMPTY for its element lang (lg-nolan),
	// so PHP skips the icon; reading it cross-lang would leak the icon.
	const column = getColumnNameByModel(model);
	const literalColumns = new Set(['string', 'date', 'iri', 'geo']);
	if (column !== null && literalColumns.has(column)) {
		const elementLang = (await getTranslatableByTipo(tipo)) ? lang : 'lg-nolan';
		items = items.filter((item) => (item.lang ?? 'lg-nolan') === elementLang);
	}

	// format_component_data: component_svg → the URL of the file ON DISK, as a
	// STRING, replacing the stored media-item array outright (PHP :1349). The
	// client renders the tree's `img` element straight from this value
	// (render_ts_line.js `src: current_element.value`), so an array reaches its
	// DOM builder as a non-URL and is refused — the thesaurus term thumbnails
	// (tool_cataloging's glyph illustrations) simply never appeared. '' when
	// there is no file: the client's own `if(current_element.value)` is then the
	// suppression, exactly as in PHP.
	if (model === 'component_svg') {
		return await svgElementUrl(tipo, sectionTipo, sectionId);
	}

	// format_component_data: portal/autocomplete_hi → resolve locators to strings.
	if (model === 'component_portal' || model === 'component_autocomplete_hi') {
		const values: unknown[] = [];
		for (const locator of items) {
			values.push(await getTermByLocator(locator as NodeLocator, currentDataLang(), true));
		}
		return values;
	}
	return items;
}

/**
 * The web URL of a component_svg's default-quality file, or '' when nothing is
 * on disk (PHP format_component_data's component_svg case: get_media_filepath →
 * file_exists → get_url, else '').
 *
 * WIRE (WC-2026-09-01-ts-object-svg-url): PHP appended the REQUEST's start time
 * as the cache-buster (`?<start_time()>`), a value that changes on every read
 * and therefore re-downloads every thumbnail of every tree paint. The bust here
 * is the file's own mtime, so a browser re-fetches exactly when the file
 * changed — which is what a cache-buster is for. The path itself is byte-identical.
 *
 * Fail-soft, like every other media URL emitter here: an unresolvable path
 * (an id that is not a record address, a component whose ontology path cannot be
 * built) yields '' rather than failing the whole tree node.
 */
async function svgElementUrl(
	tipo: string,
	sectionTipo: string,
	sectionId: number,
): Promise<string> {
	try {
		const { mediaTypeOf } = await import('../concepts/media.ts');
		const spec = mediaTypeOf('component_svg');
		if (spec === null) return '';
		// Namespace form on purpose: a destructured binding reads as a BARE
		// reference to the section-scoped seam, and the shrink-only census that
		// guards it (media_ingest_properties_native) counts such a binding as one.
		// This call is the RECORD-scoped three-argument form.
		const ontologyPath = await import('../media/ontology_path.ts');
		const { buildMediaLocation } = await import('../media/path.ts');
		// RECORD-scoped, not section-scoped: only this form resolves
		// `properties.additional_path` — the sibling component's value on THIS
		// record, which is the folder the WRITER used. Asking the two-argument
		// form leaves it undefined and the numeric max_items_folder bucket wins,
		// so on an install that names its buckets the thumbnail is stat-ed at a
		// path nothing was ever written to and disappears for good.
		const pathOptions = await ontologyPath.resolveMediaPathOptions(tipo, sectionTipo, sectionId);
		// The identifier's lang follows the NODE's translatable flag, exactly as
		// the writer's own resolver does (media/tool_support.ts) and as PHP's
		// get_id does — `component_svg` is not class-translatable, but the flag
		// lives on the dd_ontology node, and a node that carries it stores
		// `<id>_<lang>.svg`.
		const lang = (await getTranslatableByTipo(tipo)) ? currentDataLang() : null;
		const location = buildMediaLocation(
			spec,
			{ componentTipo: tipo, sectionTipo, sectionId, lang },
			spec.defaultQuality,
			spec.defaultExtension,
			pathOptions,
		);
		const stats = statSync(location.absolutePath, { throwIfNoEntry: false });
		if (stats === undefined) return '';
		return `${config.media.webBase}${location.relativePath}?${Math.trunc(stats.mtimeMs)}`;
	} catch {
		return '';
	}
}

/** get_component_data_fallback: main-lang → nolan → any non-empty (PHP :310). */
function componentDataFallbackValue(items: Record<string, unknown>[]): string {
	const pick = (lang: string): string => {
		const item = items.find((entry) => (entry.lang ?? 'lg-nolan') === lang);
		return typeof item?.value === 'string' ? item.value : '';
	};
	let value = pick(DATA_LANG_DEFAULT);
	if (value === '') value = pick('lg-nolan');
	if (value === '') {
		const any = items.find((entry) => typeof entry.value === 'string' && entry.value !== '');
		value = (any?.value as string | undefined) ?? '';
	}
	return value;
}

/**
 * PHP is_empty (shared/core_functions.php :2987) — the "pseudo-empty" test behind
 * the icon empty-skip: 0/''/[]/null are empty, a string is empty once trimmed and
 * stripped of tags ('<p></p>'), an array is empty when every entry is.
 *
 * ONE DELIBERATE DIVERGENCE (WC-029): PHP's object branch returns "not empty" for
 * an object with ANY property — and every stored data item is a `{id, lang?, value}`
 * wrapper, so an item whose value was cleared (`{id:1, value:null}`) counts as
 * non-empty forever. That is why an ontology term with EMPTY properties still renders
 * its 'P' icon and opens an empty JSON editor. Here a data-item wrapper is judged by
 * its `value` alone (id/lang are pairing metadata, never content); any other object
 * (a locator) is empty only when every property is.
 */
export function isEmptyData(value: unknown): boolean {
	// PHP empty(): null, false, 0, 0.0, '', '0', [].
	if (value === null || value === undefined || value === false || value === '') return true;
	if (typeof value === 'number' && value === 0) return true;
	if (value === '0') return true;

	if (Array.isArray(value)) return value.every(isEmptyData);
	if (typeof value === 'object') {
		const entries = value as Record<string, unknown>;
		if ('value' in entries) return isEmptyData(entries.value);
		return Object.values(entries).every(isEmptyData);
	}
	if (typeof value === 'string') return stripTags(value).trim() === '';

	return false;
}

/** to_string parity for a scalar element value. */
function toStr(value: unknown): string {
	if (value === null || value === undefined) return '';
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// HAS_CHILDREN_OF_TYPE (PHP :714).
// ---------------------------------------------------------------------------
async function hasChildrenOfType(
	arChildren: { section_tipo?: string; section_id?: number }[],
	type: 'descriptor' | 'nd',
	options: TsOptions,
): Promise<boolean> {
	if (arChildren.length === 0) {
		if (type === 'descriptor') return options.have_children ?? false;
		return false;
	}
	const descriptorValue = type === 'descriptor' ? 1 : 2;
	const flags = await batchDescriptorFlags(arChildren as NodeLocator[]);
	for (const locator of arChildren) {
		const key = `${locator.section_tipo}_${locator.section_id}`;
		if (flags.get(key) === descriptorValue) return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// BUILD_NODE_DATA (PHP get_data :488 + element resolution :1320-1604).
// ---------------------------------------------------------------------------
export async function buildNodeData(
	sectionTipo: string,
	sectionId: number,
	options: TsOptions,
	tsParent: string | null,
	principal: Principal,
): Promise<TsNodeData> {
	const isIndexableValue =
		options.is_indexable !== undefined
			? Boolean(options.is_indexable)
			: await isIndexable(sectionTipo, sectionId);

	const permissionsButtonNew = await getPermissionsElement(sectionTipo, 'button_new', principal);
	const permissionsButtonDelete = await getPermissionsElement(
		sectionTipo,
		'button_delete',
		principal,
	);

	// Property insertion order mirrors PHP get_data() exactly.
	const data: TsNodeData = {
		section_tipo: sectionTipo,
		// WC-2026-08-10-section-id-int-canonical: repeals the PHP-era law this
		// comment used to state ("set_section_id casts to string, so the payload
		// section_id is ALWAYS a string on the wire"). A tree node addresses a
		// matrix record, so the payload carries the canonical INT — the
		// canonicalization now happens ONCE, at the boundary that builds the
		// locator (parseChildData / the dd_ts_api door), never per emit.
		section_id: sectionId,
		ts_id: `${sectionTipo}_${sectionId}`,
		ts_parent: tsParent,
		order: options.order ?? null,
		mode: 'list',
		lang: currentDataLang(),
		is_descriptor: true,
		is_indexable: isIndexableValue,
		ar_elements: [],
		permissions_button_new: permissionsButtonNew,
		permissions_button_delete: permissionsButtonDelete,
	};

	const arElements = await getArElements(sectionTipo, options.model ?? null);
	if (arElements.length === 0) return data;

	// Preload the record once (all typed columns) for literal/relation reads.
	const table = await getMatrixTableFromTipo(sectionTipo);
	const record = table === null ? null : await readMatrixRecord(table, sectionTipo, sectionId);

	for (const current of arElements) {
		const currentTipo = current.tipo ?? null;
		if (
			currentTipo === null ||
			currentTipo === '' ||
			(Array.isArray(currentTipo) && currentTipo.length === 0)
		) {
			continue;
		}
		// non-descriptor rule: no children config for ND nodes.
		if (data.is_descriptor === false && current.type === 'link_children') {
			data.children_tipo = null;
			continue;
		}
		const arElementTipo = Array.isArray(currentTipo) ? currentTipo : [currentTipo];
		const elementObj: TsElement = { type: current.type ?? '', tipo: currentTipo };

		const valid = await processElementDetails(
			current,
			arElementTipo,
			elementObj,
			data,
			record,
			sectionTipo,
			sectionId,
			options,
		);
		if (valid) {
			assertImgElementIsRenderable(elementObj, sectionTipo);
			data.ar_elements.push(elementObj);
		}
	}

	return data;
}

/**
 * An `img` element's value is a URL STRING or nothing — the CHOKEPOINT for the
 * class of bug that made this element ship an array (see
 * WC-2026-09-01-ts-object-svg-url).
 *
 * The client assigns the value straight to an `<img>` src
 * (render_ts_line.js), where the scheme allowlist refuses anything that is not
 * an http(s) URL — silently, one console warning per node. Only
 * `component_svg` resolves to a URL here (PHP's format_component_data converts
 * that model and no other), so an ontology that declares `type:'img'` over
 * ANY other media model — `component_image` is the live case, `test213`'s
 * `test99` — hands the client the raw stored items.
 *
 * So the engine says so, once, where an operator can act on it: a
 * configuration failure gets `console.error` (engineering/CONVENTIONS.md), and
 * the value is emptied so the client renders NOTHING rather than an empty
 * `<img>` shell. Never a throw: a mis-declared column must not take down the
 * whole tree of a heritage install.
 */
function assertImgElementIsRenderable(element: TsElement, sectionTipo: string): void {
	if (element.type !== 'img' || typeof element.value === 'string') return;
	console.error(
		`[ts_object] ddo_map declares type:'img' over '${element.tipo}' (section '${sectionTipo}'), ` +
			`whose model resolves to no URL — only component_svg does. The client cannot render it; ` +
			'emitting nothing. Fix the section_list_thesaurus ddo_map or the component model.',
	);
	element.value = '';
}

/** PHP process_element_details (:1320): resolve each tipo, populate elementObj. */
async function processElementDetails(
	current: DdoMapEntry,
	arElementTipo: string[],
	elementObj: TsElement,
	data: TsNodeData,
	record: MatrixRecord | null,
	sectionTipo: string,
	sectionId: number,
	options: TsOptions,
): Promise<boolean> {
	for (const elementTipo of arElementTipo) {
		const model = await getModelByTipo(elementTipo);
		if (model === null || model === 'box elements') return false;
		// (legacy component_relation_struct skip is ledgered as deferred)

		const componentData = await getComponentDataLang(
			record,
			sectionTipo,
			sectionId,
			elementTipo,
			model,
			currentDataLang(),
		);

		const ok = await resolveElementValue(
			current,
			elementObj,
			elementTipo,
			model,
			componentData,
			data,
			record,
			sectionTipo,
			sectionId,
			options,
		);
		if (ok === false) return false;

		// ontology model case (PHP :518): the 'M' icon carries the MODEL NAME of the
		// term next to it ('area_tool'), which area_ontology renders as the orange
		// badge toggled with Ctrl+M. Gated on the RESOLVED value, exactly like PHP —
		// not on the ddo `icon` key, so a component_relation_index 'M:3' never matches.
		if (elementObj.value === 'M') {
			elementObj.model_value = await resolveModelValue(
				record,
				elementTipo,
				model,
				currentDataLang(),
			);
		}

		if (elementObj.model === undefined) elementObj.model = model;
		if (current.show_data !== undefined) elementObj.show_data = current.show_data;
	}
	return true;
}

// ---------------------------------------------------------------------------
// MODEL_VALUE — the 'M' icon badge (PHP :518 `$element_obj->model_value =
// $component->get_value()`).
// ---------------------------------------------------------------------------

/** component_common::get_grid_value defaults (:1064 / :1071). */
const DEFAULT_FIELDS_SEPARATOR = ', ';
const DEFAULT_RECORDS_SEPARATOR = ' | ';

/** One `show.ddo_map` entry of a relation component's request_config. */
interface ShowDdoEntry {
	tipo?: unknown;
	parent?: unknown;
	section_tipo?: unknown;
}

/** The tipos a relation component displays its TARGET with, plus its separators. */
interface ComponentShowMap {
	tipos: string[];
	fieldsSeparator: string;
	recordsSeparator: string;
}

/**
 * The component's OWN display map — `properties.source.request_config[].show`.
 * PHP get_grid_value builds a grid from exactly these ddo, then resolve_value
 * flattens it to the string get_value() returns.
 *
 * Only `section_tipo:'self'` entries are taken: 'self' is the placeholder PHP
 * substitutes for the resolved target section, i.e. "read this tipo ON the
 * target record" — the flat one-hop shape both live 'M' components use
 * (ontology6 → [ontology5, ontology9], hierarchy27 → [hierarchy25]). An entry
 * naming a real foreign section would be a nested sub-portal hop, which this
 * badge does not resolve.
 */
async function readComponentShowMap(tipo: string): Promise<ComponentShowMap | null> {
	const node = await getNode(tipo);
	const properties = (node?.properties ?? null) as {
		fields_separator?: unknown;
		records_separator?: unknown;
		source?: {
			request_config?: {
				api_engine?: unknown;
				show?: {
					ddo_map?: unknown;
					fields_separator?: unknown;
					records_separator?: unknown;
				};
			}[];
		};
	} | null;

	const requestConfig = properties?.source?.request_config;
	if (!Array.isArray(requestConfig)) return null;
	// PHP array_find api_engine==='dedalo' (:279). 'dedalo' is also the implicit
	// engine of a config that declares none — every stored 'M' component does.
	// An EXTERNAL-only component reaches the adapter first: the badge renders a
	// value per target record, which is what capabilities.listColumns answers.
	const { selectConfigItemForConcern } = await import(
		'../relations/request_config/engine_select.ts'
	);
	const config = await selectConfigItemForConcern(
		requestConfig as { api_engine?: string }[],
		'listColumns',
		'ts_object.readComponentShowMap',
	);
	const show = (
		config as {
			show?: { ddo_map?: unknown; fields_separator?: unknown; records_separator?: unknown };
		} | null
	)?.show;
	const ddoMap = show?.ddo_map;
	if (!Array.isArray(ddoMap)) return null;

	const tipos = (ddoMap as ShowDdoEntry[])
		.filter((entry) => entry?.section_tipo === 'self' || entry?.section_tipo === undefined)
		.map((entry) => entry.tipo)
		.filter((entryTipo): entryTipo is string => typeof entryTipo === 'string');
	if (tipos.length === 0) return null;

	const pickSeparator = (fromShow: unknown, fromProperties: unknown, fallback: string): string =>
		typeof fromShow === 'string'
			? fromShow
			: typeof fromProperties === 'string'
				? fromProperties
				: fallback;

	return {
		tipos,
		fieldsSeparator: pickSeparator(
			show?.fields_separator,
			properties?.fields_separator,
			DEFAULT_FIELDS_SEPARATOR,
		),
		recordsSeparator: pickSeparator(
			show?.records_separator,
			properties?.records_separator,
			DEFAULT_RECORDS_SEPARATOR,
		),
	};
}

/**
 * The 'M' element's model name (PHP $component->get_value()).
 *
 * Reads the RAW locators off the record — NOT the resolved componentData: for the
 * portal family getComponentDataLang has already flattened those locators through
 * the target's section_map `thesaurus` term scope, which for a dd0 model record is
 * [term, tld, section_id] and, with the untranslated term dropping out, serves the
 * bare tld ('dd') instead of the model name.
 *
 * Empty string when the component declares no usable display map: the badge is
 * suppressed client-side (`if (current_element.model_value)`), and the degraded
 * path is logged rather than thrown — a tree read must not die over a decoration.
 */
async function resolveModelValue(
	record: MatrixRecord | null,
	elementTipo: string,
	model: string,
	lang: string,
): Promise<string> {
	const locators = readItemsFromRecord(record, elementTipo, model) as TermLocator[];
	if (locators.length === 0) return '';

	const showMap = await readComponentShowMap(elementTipo);
	if (showMap === null) {
		console.warn(
			`[ts_object] no request_config show.ddo_map for 'M' component ${elementTipo} (model ${model}) — model badge suppressed`,
		);
		return '';
	}

	const values: string[] = [];
	for (const locator of locators) {
		const value = await getDdoValueByLocator(locator, showMap.tipos, showMap.fieldsSeparator, lang);
		if (value !== '') values.push(value);
	}
	return values.join(showMap.recordsSeparator);
}

/** PHP resolve_element_value (:1504): dispatch by element type; false = skip. */
async function resolveElementValue(
	current: DdoMapEntry,
	elementObj: TsElement,
	elementTipo: string,
	model: string,
	// `mixed` in PHP: format_component_data replaces a component_svg's data with
	// its URL STRING, everything else stays an item array.
	componentData: unknown[] | string,
	data: TsNodeData,
	record: MatrixRecord | null,
	sectionTipo: string,
	sectionId: number,
	options: TsOptions,
): Promise<boolean> {
	switch (elementObj.type) {
		case 'term': {
			let elementValue: unknown;
			if (componentData.length === 0) {
				// lang fallback: main-lang → nolan → any, decorated as untranslated.
				const rawItems = readItemsFromRecord(record, elementTipo, model);
				const fallback = componentDataFallbackValue(rawItems);
				elementValue = fallback === '' ? '' : `<mark>${toStr(fallback)}</mark>`;
			} else {
				const first = componentData[0] as { value?: unknown } | string | undefined;
				elementValue =
					first !== null && typeof first === 'object'
						? ((first as { value?: unknown }).value ?? '')
						: (first ?? '');
			}
			elementObj.value =
				elementObj.value !== undefined
					? `${toStr(elementObj.value)} ${toStr(elementValue)}`
					: toStr(elementValue);
			return true;
		}
		case 'icon': {
			if (current.icon === 'CH') return false;
			if (current.icon === 'ND') {
				const first = componentData[0] as { section_id?: unknown } | undefined;
				if (first?.section_id !== undefined && Math.trunc(Number(first.section_id)) === 2) {
					data.is_descriptor = false; // set_term_as_nd leaves the term value unchanged
				}
				return false;
			}
			elementObj.value = current.icon;
			if (model === 'component_relation_index') {
				const count = await getCountDataGroupBy(sectionTipo, sectionId, elementTipo, current);
				if (count.total === 0) return false;
				elementObj.value = `${current.icon}:${count.total}`;
				elementObj.count_result = count;
			} else if (isEmptyData(componentData)) {
				// PHP is_empty (:1565), not a length check: an icon whose component
				// holds only pseudo-empty data ('', '<p></p>', a cleared {id,value:null}
				// wrapper) is suppressed — see isEmptyData / WC-029.
				return false;
			}
			return true;
		}
		case 'link_children': {
			data.children_tipo = elementTipo;
			const children = componentData as { section_tipo?: string; section_id?: number }[];
			data.has_descriptor_children =
				children.length === 0 ? false : await hasChildrenOfType(children, 'descriptor', options);
			elementObj.value =
				data.has_descriptor_children === true
					? 'button show children'
					: 'button show children unactive';
			const hasNd =
				children.length === 0 ? false : await hasChildrenOfType(children, 'nd', options);
			if (hasNd === true) {
				data.ar_elements.push({ type: 'link_children_nd', tipo: elementTipo, value: 'ND' });
			}
			return true;
		}
		default:
			elementObj.value = componentData;
			return true;
	}
}

// ---------------------------------------------------------------------------
// PARSE_CHILD_DATA (PHP :329).
// ---------------------------------------------------------------------------

/**
 * A locator as it arrives from a child list / request source.
 *
 * KEPT UNION: this is a DOOR shape — `dd_ts_api.get_children_data` mode B hands
 * `source.children` in verbatim, and the same interface types locators lifted
 * off unswept stored jsonb. The canonicalization happens ONCE, in parseChildData
 * below, so nothing past this boundary carries the string leg.
 */
export interface ParseLocator {
	section_tipo?: string;
	section_id?: number | string;
	from_component_tipo?: string;
	[extra: string]: unknown;
}

/**
 * Convert child locators into TsNodeData objects (PHP parse_child_data). Assumes
 * homogeneous children (order tipo resolved from the FIRST locator). Prefetches
 * order + is_indexable in one batch, parent-aware when `parentLocator` is given.
 * Invalid locators are skipped.
 *
 * A locator whose id is not a RECORD ADDRESS after canonicalization (a synthetic
 * token, an external remote id, junk) is skipped by that same rule: a tree node
 * is a matrix record, and the pre-canonical code built it anyway with a NaN id —
 * a node that could only render empty (WC-2026-08-10-section-id-int-canonical).
 */
export async function parseChildData(
	locators: ParseLocator[],
	areaModel: string,
	tsObjectOptions: TsOptions | null,
	parentLocator: NodeLocator | null,
	principal: Principal,
): Promise<TsNodeData[]> {
	void areaModel;
	const childrenData: TsNodeData[] = [];
	const firstLocator = locators[0];
	if (firstLocator === undefined || typeof firstLocator.section_tipo !== 'string') {
		return childrenData;
	}

	const componentOrderTipo = await getComponentOrderTipo(firstLocator.section_tipo);
	const prefetched = await fetchNodeInfo(locators as NodeLocator[], parentLocator);

	for (const locator of locators) {
		if (typeof locator.section_tipo !== 'string') continue;
		const sectionId = canonicalizeStoredSectionId(locator.section_id);
		if (!isSectionId(sectionId)) continue;
		const sectionTipo = locator.section_tipo;
		const tsOptions: TsOptions = { ...(tsObjectOptions ?? {}) };

		const nodeInfo = prefetched.get(`${sectionTipo}_${sectionId}`) ?? null;
		if (nodeInfo !== null) {
			tsOptions.order = componentOrderTipo !== null ? nodeInfo.order : null;
			tsOptions.is_indexable = nodeInfo.is_indexable;
		} else {
			tsOptions.order = null;
		}

		const childObject = await buildNodeData(sectionTipo, sectionId, tsOptions, null, principal);
		childrenData.push(childObject);
	}

	return childrenData;
}

// ---------------------------------------------------------------------------
// GET_CHILDREN_DATA (PHP :594).
// ---------------------------------------------------------------------------

/**
 * The children payload. NOT a wire body: ts_api wraps it (a refusal is a THROW
 * — see the wrong-model refusal below), so nothing here spells `result:false`.
 */
export interface ChildrenDataResult {
	ar_children_data: TsNodeData[];
	pagination: Record<string, unknown>;
}

/**
 * Load, paginate and format the direct children of a node (PHP get_children_data).
 * countChildrenOrNull → load-and-count fallback when null. Paginate whenever
 * limit>0 (a client-supplied total never switches paging off). default limit 300.
 */
export async function getChildrenData(
	sectionTipo: string,
	sectionId: number,
	childrenTipo: string,
	defaultLimit: number,
	areaModel: string,
	tsObjectOptions: TsOptions | null,
	pagination: Record<string, unknown> | null,
	principal: Principal,
): Promise<ChildrenDataResult> {
	const model = await getModelByTipo(childrenTipo);
	if (model !== 'component_relation_children') {
		// The caller named a component that cannot have children: a caller fault,
		// and the only refusal on this path.
		throw new DedaloError('request.invalid_model', {
			coordinates: {
				children_tipo: childrenTipo,
				section_tipo: sectionTipo,
				calculated_model: String(model),
			},
		});
	}

	const currentPagination: Record<string, unknown> =
		pagination !== null && pagination !== undefined
			? { ...pagination }
			: { limit: defaultLimit, offset: 0 };

	if (currentPagination.total === undefined) {
		let total = await countChildrenOrNull(sectionId, sectionTipo, childrenTipo);
		if (total === null) {
			const loaded = await getChildren(sectionId, sectionTipo, childrenTipo);
			total = loaded.length;
		}
		currentPagination.total = total;
	}

	// The read is PAGED whenever the limit is positive (audit P2-31 / CLI-30).
	// PHP paged only when `total > limit`, and `total` here may be the CLIENT's
	// own cached count — so a client total at or below its limit switched
	// paging OFF and the whole branch came back through a request that named a
	// limit. The total still drives nothing but the echo; the limit itself is
	// clamped at the door (ts_api clampChildrenPagination), so it is never 0
	// from a client. A non-positive limit can only be server-internal.
	const limit = Number(currentPagination.limit ?? defaultLimit);
	const offset = Number(currentPagination.offset ?? 0);
	const usePagination = limit > 0;
	const children = usePagination
		? await getChildren(sectionId, sectionTipo, childrenTipo, limit, offset)
		: await getChildren(sectionId, sectionTipo, childrenTipo);

	const arChildrenData = await parseChildData(
		children as unknown as ParseLocator[],
		areaModel,
		tsObjectOptions,
		{ section_tipo: sectionTipo, section_id: sectionId },
		principal,
	);

	return { ar_children_data: arChildrenData, pagination: currentPagination };
}
