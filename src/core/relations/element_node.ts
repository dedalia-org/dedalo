/**
 * resolveElement — ONE element occurrence → ONE node (relations/element_registry.ts),
 * the TS form of PHP's one request_config object per element instance
 * (class.common.php build_request_config :2956, injected by the parent's
 * get_subdatum :2603-2681, read by the element's own subdatum AND its context).
 *
 * THE EFFECTIVE CONFIG, in order:
 *
 *   1. STAGE 1 — when the rqo TARGETS this element and carries a show
 *      (request_config/from_rqo.ts buildRequestConfigFromRqo, PHP
 *      build_request_config_from_rqo :3056-3131): the validated client config.
 *      A SECTION takes it whole; a COMPONENT has only its show / search ddo_map
 *      replaced on the base of steps 2-3 (mergeComponentStageOne — hide, choose,
 *      other engines and the server sqo stay). Only a top-level element of a read can be targeted (the caller passes the
 *      rqo for that one element and never for a nested one).
 *   2. Otherwise the element's OWN config through THE one base resolver
 *      (request_config/own_config.ts resolveOwnRequestConfig: override → alias →
 *      section_list swap → real mode) …
 *   3. … with the PARENT's children injected (request_config/caller_injection.ts:
 *      collectCallerChildren over the parent node's effective config, then
 *      injectCallerChildren — per engine, per slot, non-empty slots only).
 *
 *        tch197 (portal → rsc1389)
 *          effective show: [rsc1399, rsc1400, rsc86<rsc1400, rsc85<rsc1400, …]
 *        rsc1400 own show: [rsc85, rsc86]   sqo → rsc197
 *        rsc1400 under tch197 → show [rsc86, rsc85], sqo → rsc197 (own)
 *
 *   4. The GOVERNING ddo's `limit` (the parent's line for this element) becomes
 *      the config's page size on `sqo.limit` ONLY — PHP :2592-2596 sets the
 *      instance `pagination->limit`, which overwrites `$parsed_item->sqo->limit`
 *      alone (trait.request_config_utils.php:597-598 resolve_pagination_override;
 *      trait.request_config_v6.php:415-418 leaves a DECLARED
 *      show.sqo_config.limit as declared; plan E5). The data page reads it
 *      first (nodeListPageLimit: the node's governing limit wins over the
 *      config's own sqo_config / sqo), and the client paginator reads sqo.limit
 *      before show.sqo_config.limit (component_portal.js). Deliberate divergence
 *      `WC-2026-11-04-governing-limit-sqo-limit-only`: PHP SYNTHESISES a default
 *      show.sqo_config from the instance pagination when a config declares none,
 *      so there the governing limit does reach sqo_config in PHP; the TS builder
 *      synthesises one only for a config with its own sqo.limit (explicit.ts)
 *      and it keeps the own value.
 *
 * NO OWN CONFIG AT ALL. An element whose own config resolves to NOTHING (`[]`:
 * no source.request_config and no relation graph — a bare scratch portal) still
 * has a config in PHP: `get_ar_request_config` falls back to
 * `build_request_config_v5` (class.common.php ~3500,
 * trait.request_config_v5.php:78-159), which ALWAYS returns one
 * `{api_engine:'dedalo', type:'main'}` item (its ddo_map possibly empty). The
 * injection loop (:2637-2648) finds that dedalo item and replaces its slots
 * with the caller's children. So the PHP outcome is "the caller's DEDALO
 * children stand as the element's config" — which the TS form reproduces
 * (configSource 'caller'): ONE dedalo item carrying the collected slots. Only
 * the dedalo engine — the v5 fallback never yields another one, so a caller's
 * non-dedalo children have nothing to land on, exactly as PHP. An element that
 * HAS a config but lacks one of the caller's engines is skipped for that
 * engine exactly as PHP.
 *
 * ONE-LEVEL EXPANSIONS (useOwnConfig false: relation_index related_list
 * children, component_filter outside list/edit/search). The element still has
 * its OWN config — its sqo, its page size, its section_list swap — it only must
 * not expand its OWN children. So the own config is resolved and its four slots
 * EMPTIED before the caller's children are injected: the cell keeps paging by
 * its own section_list / sqo limit (what resolveListCellMap read before the
 * rewire) while its children come from the caller alone.
 * Dataframe FRAME children are NOT one-level (2026-11-03): PHP
 * component_dataframe_json.php:221 runs get_subdatum over the frame's config,
 * and get_subdatum (class.common.php :2603-2681) keeps each child's OWN
 * build_request_config() slots wherever the caller supplied none — a frame child
 * portal expands its own children like any other element.
 * The related_list case is PHP-backed (verified 2026-11-04): PHP's
 * no-request_config branch (component_relation_index_json.php :190-206) builds
 * each pointing section in 'related_list' mode, where a config-less (v5)
 * relation child resolves NO children (resolve_ar_related_related_list → []
 * for a non-section) while one with an EXPLICIT request_config expands its own
 * show map — so models/relation_index.ts emitRelatedListChildren passes
 * useOwnConfig only for the explicit ones; the v5 ones stay one-level.
 *
 * INJECTED SLOTS. `injectedSlots` names the slots the caller replaced;
 * `dataChildrenInjected` is true only when show or hide was among them — a
 * search- or choose-only caller (plan E3) leaves the DATA children the
 * element's own, and every consumer that asks "are these children the
 * element's own?" reads that flag, never the any-slot `injected`.
 *
 * DATA CHILDREN. `node.children` = the DIRECT children (parent === the element)
 * of show + hide of the effective config, flattened over every item
 * (config_ddo_map.ts flattenConfigDdoMaps — PHP full_ddo_map :2312-2341). Every
 * mode resolves them except 'solved' (PHP get_subdatum's only exclusion); the
 * retired `depth < 4 && (edit || list && ownConfig)` gate is gone, so a nested
 * portal in a LIST cell now falls back to its own config like PHP (plan E2).
 * The hard bounds are MAX_DDO_DEPTH (below — an ontology-driven chain stops
 * there with a notice at every depth+1 hop, a client-driven one is refused by
 * emitDdoData) and the per-path record-cycle guard (models/portal.ts, owner
 * decision (e)).
 *
 * MEMOISED per EmissionContext (never module state), keyed per PARENT
 * occurrence (owner decision (b)): `<parent key> > tipo @ section : mode`, plus
 * the owning record when the config reads it (a fixed_filter —
 * own_config.ts ownConfigDependsOnRecord), the governing limit, and the
 * stage-1 / override / caller-only flavour. A Time Machine fork shares the
 * registry by reference (resolve/component_data.ts EmissionContext.nodes).
 *
 * LEVEL >= 2 'self' (owner decision (c)): refused, never guessed. The own
 * config refuses it inside the builder (explicit.ts parseBlock — so the
 * context agrees); a stage-1 config and a ROOT map are partitioned here
 * (self_depth.ts). Every refusal is a typed `ontology.ddo_self_refused` notice
 * in the emission registry, bounded and deduplicated there.
 */

import { type Ddo, SELF_SENTINEL } from '../concepts/ddo.ts';
import { configOwnerOf, type EmitRow } from '../concepts/emit_row.ts';
import type { StoredSectionId } from '../concepts/locator.ts';
import type { ApiNotice } from '../errors/schema.ts';
import type { Principal } from '../security/permissions.ts';
import { type ConfigDdo, configChildRenderFields, flattenConfigDdoMaps } from './config_ddo_map.ts';
import type {
	ElementConfigSource,
	ElementNode,
	ElementNodeRegistry,
	EmitScope,
} from './element_registry.ts';
import {
	type CallerEngineChildren,
	CONFIG_SLOTS,
	type ConfigSlot,
	collectCallerChildren,
	type DdoMapOrigin,
	type InjectableConfigItem,
	injectCallerChildren,
} from './request_config/caller_injection.ts';
import { engineOf, selectLocalConfigItem } from './request_config/engine_select.ts';
import { partitionDeepSelfDdos } from './request_config/self_depth.ts';

/** What one element occurrence is resolved from. */
export interface ResolveElementInput {
	/** The GOVERNING ddo: the parent's line for this element (or the read's own ddo). */
	readonly ddo: Ddo;
	/** The parent element's node; null = a top-level element with no caller config. */
	readonly parentNode: ElementNode | null;
	/** The section the element's own config resolves against (its owner section). */
	readonly ownerSectionTipo: string;
	/** The owning record — keys the node only when the config reads it (fixed_filter). */
	readonly ownerSectionId?: number | string | null;
	/** The element's render mode under this parent. */
	readonly mode: string;
	/** The element's instance lang (node.lang — lg-nolan for a non-translatable element). */
	readonly lang: string;
	/**
	 * The READ's data lang the own config is BUILT in (its filter_by_list
	 * datalist and simple contexts — PHP get_filter_list_data uses
	 * DEDALO_DATA_LANG unconditionally): the same lang the context door hands
	 * the one base resolver (section/read.ts `ddo.lang ?? lang` →
	 * buildStructureContext → resolveOwnRequestConfig). Never the instance
	 * lang — a portal's lg-nolan built its filter_by_list labels in lg-nolan, a
	 * config the element's context never declared. Defaults to `lang` (a
	 * top-level get_data, whose read lang IS the element's).
	 */
	readonly configLang?: string;
	/** The emission's registry (EmissionContext.nodes). */
	readonly registry: ElementNodeRegistry;
	/** The element's model, when the caller has it. */
	readonly model?: string | null;
	/**
	 * false = the element takes ONLY its caller's children, never its OWN
	 * children — its own sqo / page size still stand (module header, ONE-LEVEL
	 * EXPANSIONS: relation_index related_list children, component_filter
	 * outside list/edit/search). Default true.
	 */
	readonly useOwnConfig?: boolean;
	/** An rqo `source.properties` override (top-level component reads only). */
	readonly propertiesOverride?: unknown;
	/** The client rqo, when this element is the read's TARGET (stage 1). */
	readonly rqo?: unknown;
	/** The actor stage 1 judges client ddos for (undefined = internal resolution). */
	readonly principal?: Principal;
}

/** A positive integer page size, else null (the governing limit rule). */
function governingLimitOf(ddo: Ddo): number | null {
	const limit = (ddo as { limit?: unknown }).limit;
	return typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? limit : null;
}

/** A string field of the governing ddo, else null. */
function stringField(ddo: Ddo, key: string): string | null {
	const value = (ddo as Record<string, unknown>)[key];
	return typeof value === 'string' && value !== '' ? value : null;
}

/** The governing ddo's `properties` object, else null. */
function propertiesField(ddo: Ddo): Readonly<Record<string, unknown>> | null {
	const value = (ddo as Record<string, unknown>).properties;
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** Whether a collected engine names any child at all. */
function namesAnyChild(engine: CallerEngineChildren): boolean {
	return CONFIG_SLOTS.some((slot) => engine.slots[slot].length > 0);
}

/**
 * The config an element with NO own config takes from its caller (module
 * header, NO OWN CONFIG AT ALL — PHP's v5 fallback item): ONE dedalo main
 * item carrying exactly the collected dedalo slots, or nothing when the
 * caller names no dedalo child of the element.
 */
function callerOnlyConfig(children: readonly CallerEngineChildren[]): InjectableConfigItem[] {
	const engine = children.find((candidate) => candidate.api_engine === 'dedalo');
	if (engine === undefined || !namesAnyChild(engine)) return [];
	const item: Record<string, unknown> = { api_engine: 'dedalo', type: 'main' };
	for (const slot of CONFIG_SLOTS) {
		const slotChildren = engine.slots[slot];
		item[slot] = slotChildren.length > 0 ? { ddo_map: [...slotChildren] } : null;
	}
	return [item as InjectableConfigItem];
}

/**
 * A config with its four slots EMPTIED (module header, ONE-LEVEL EXPANSIONS):
 * the own sqo / sqo_config / page size stand, the own children do not. Fresh
 * objects — the config may share blocks with a cached build.
 */
function withoutOwnSlots(config: readonly InjectableConfigItem[]): InjectableConfigItem[] {
	return config.map((item) => {
		const next: Record<string, unknown> = { ...item };
		for (const slot of CONFIG_SLOTS) {
			const block = item[slot];
			if (block === null || block === undefined) continue;
			next[slot] = { ...block, ddo_map: [] };
		}
		return next as InjectableConfigItem;
	});
}

/**
 * The governing ddo's per-occurrence fields that change what the node IS
 * (view, parent_grouper, properties, value_with_parents) as a stable key
 * fragment — two sibling ddos of one tipo that differ in any of them
 * (config_ddo_map.ts keeps both, WC-2026-08-05) are two nodes. A ddo's
 * `permissions` is NOT one of them: it changes nothing the node is (the level
 * is computed, section/node_permissions.ts — element_registry.ts ElementNode).
 */
function governingFieldsKey(ddo: Ddo): string {
	const record = ddo as Record<string, unknown>;
	const fields: Record<string, unknown> = {};
	for (const name of ['view', 'parent_grouper', 'properties', 'value_with_parents']) {
		if (record[name] !== undefined && record[name] !== null) fields[name] = record[name];
	}
	return Object.keys(fields).length === 0 ? '' : `&${stableJson(fields)}`;
}

/** JSON with object keys sorted at every level (a key fragment, never parsed back). */
function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
	if (value !== null && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, entry]) => entry !== undefined)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
		return `{${entries.map(([name, entry]) => `${JSON.stringify(name)}:${stableJson(entry)}`).join(',')}}`;
	}
	return JSON.stringify(value) ?? 'null';
}

/**
 * Step 4: the governing limit onto every item's `sqo.limit` — and ONLY there
 * (module header, step 4: PHP's instance pagination never rewrites a declared
 * show.sqo_config.limit). Fresh objects — the config may share blocks with a
 * cached build.
 */
function withGoverningLimit(
	config: readonly InjectableConfigItem[],
	limit: number | null,
): InjectableConfigItem[] {
	if (limit === null) return [...config];
	return config.map((item) => {
		const sqo = item.sqo;
		return { ...item, sqo: { ...(isPlainObject(sqo) ? sqo : {}), limit } } as InjectableConfigItem;
	});
}

/** A non-null object (an sqo / show / sqo_config block). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object';
}

/** Every walkable ddo of one slot block's ddo_map. */
function slotDdos(block: unknown): (Record<string, unknown> & { tipo: string })[] {
	const map = (block as { ddo_map?: unknown } | null | undefined)?.ddo_map;
	if (!Array.isArray(map)) return [];
	return map.filter(
		(ddo): ddo is Record<string, unknown> & { tipo: string } =>
			ddo !== null &&
			typeof ddo === 'object' &&
			typeof (ddo as { tipo?: unknown }).tipo === 'string',
	);
}

/**
 * A config with its level >= 2 'self' ddos removed slot by slot (self_depth.ts)
 * — for the configs the builder did NOT already judge (stage 1, a root map).
 * Notices go to `notices`.
 */
function withoutDeepSelf(
	ownerTipo: string,
	config: readonly InjectableConfigItem[],
	notices: ApiNotice[],
): InjectableConfigItem[] {
	return config.map((item) => {
		const next: Record<string, unknown> = { ...item };
		for (const slot of CONFIG_SLOTS) {
			const block = item[slot];
			if (block === null || block === undefined || !Array.isArray(block.ddo_map)) continue;
			const { kept, notices: refused } = partitionDeepSelfDdos(ownerTipo, slotDdos(block));
			if (refused.length === 0) continue;
			notices.push(...refused);
			next[slot] = { ...block, ddo_map: kept };
		}
		return next as InjectableConfigItem;
	});
}

/**
 * The element's DIRECT data children (module header, DATA CHILDREN) as the
 * emission path takes them: the render fields of the ONE mapper
 * (config_ddo_map.ts configChildRenderFields) plus the governing fields the
 * child's own node reads (view, parent_grouper, properties). Never a declared
 * `permissions`: the child's level is computed (section/node_permissions.ts).
 * `'self'` parents resolve to the element.
 */
export function directDataChildren(
	tipo: string,
	config: readonly InjectableConfigItem[],
	logEmptyShowMap = true,
): Record<string, unknown>[] {
	const flattened = flattenConfigDdoMaps(
		config as unknown as Parameters<typeof flattenConfigDdoMaps>[0],
		{ ownerTipo: tipo, logEmptyShowMap },
	);
	const children: Record<string, unknown>[] = [];
	for (const child of flattened) {
		const childTipo = child.tipo;
		if (typeof childTipo !== 'string' || childTipo === '') continue;
		if (child.parent !== tipo && child.parent !== SELF_SENTINEL) continue;
		children.push(dataChildDdo(tipo, child));
	}
	return children;
}

/** One config child as the emission path takes it. */
function dataChildDdo(ownerTipo: string, child: ConfigDdo): Record<string, unknown> {
	const ddo: Record<string, unknown> = {
		tipo: child.tipo,
		parent: ownerTipo,
		lang: typeof child.lang === 'string' ? child.lang : undefined,
		...configChildRenderFields(child),
	};
	// The governing fields the child's own node reads, each only when well-typed.
	const governing: [string, unknown, boolean][] = [
		['view', child.view, typeof child.view === 'string'],
		['parent_grouper', child.parent_grouper, typeof child.parent_grouper === 'string'],
		['properties', child.properties, isPlainObject(child.properties)],
	];
	for (const [name, value, valid] of governing) {
		if (valid) ddo[name] = value;
	}
	return ddo;
}

/**
 * The list-cell page size of a node: the GOVERNING ddo's limit when the parent's
 * line declares one (module header, step 4 — it lands on sqo.limit only, so it
 * must be read first: an own show.sqo_config.limit would otherwise mask it),
 * else the LOCAL item's show.sqo_config.limit ?? sqo.limit (positive), else
 * null — the rule section_list.ts pickConfig applied to the raw map, now read
 * off the one effective config.
 */
export function nodeListPageLimit(node: ElementNode): number | null {
	if (node.limit !== null) return node.limit;
	const item = selectLocalConfigItem(node.effectiveConfig);
	if (item === null) return null;
	const raw =
		(item.show?.sqo_config as { limit?: unknown } | undefined)?.limit ??
		(item.sqo as { limit?: unknown } | undefined)?.limit;
	return typeof raw === 'number' && raw > 0 ? raw : null;
}

/**
 * The node's children-map origin: a client config stays 'client' all the way
 * down. Decided on the DATA slots (`dataChildrenInjected`): the node's children
 * are show + hide, so a client search-only injection leaves them ontology-owned.
 */
function childOriginOf(
	configSource: ElementConfigSource,
	dataChildrenInjected: boolean,
	parentNode: ElementNode | null,
): DdoMapOrigin {
	if (configSource === 'rqo') return 'client';
	if ((dataChildrenInjected || configSource === 'caller') && parentNode?.childOrigin === 'client') {
		return 'client';
	}
	return 'ontology';
}

/** Every slot ddo of a config — stage 1's "inherited" set (from_rqo.ts READ GRANT). */
function everySlotDdo(config: readonly InjectableConfigItem[]): Record<string, unknown>[] {
	return config.flatMap((item) => CONFIG_SLOTS.flatMap((slot) => slotDdos(item[slot])));
}

/**
 * Stage 1 for a TARGETED element (module header, step 1), or null.
 * `baseConfig` is the element's own config WITH its caller's children injected
 * (from_rqo.ts READ GRANT: the inherited set is "its own config ddos plus the
 * ones its ontology caller injects") — its target sections and its inherited
 * ddos come from it. A targeted element has a parent node only when its read
 * named a VERIFIED caller chain (relations/caller_chain.ts — `source.callers`);
 * otherwise it is a top-level read and the injected set is the own set.
 */
async function stageOneConfig(
	input: ResolveElementInput,
	baseConfig: readonly InjectableConfigItem[],
	model: string,
): Promise<InjectableConfigItem[] | null> {
	if (input.rqo === undefined) return null;
	const { buildRequestConfigFromRqo } = await import('./request_config/from_rqo.ts');
	const { extractSqoSectionTipos } = await import('./request_config/explicit.ts');
	const element =
		model === 'section'
			? ({ kind: 'section', tipo: input.ddo.tipo, mode: input.mode } as const)
			: ({
					kind: 'component',
					tipo: input.ddo.tipo,
					mode: input.mode,
					sectionTipo: input.ownerSectionTipo,
					targetSectionTipos: baseConfig.flatMap((item) =>
						extractSqoSectionTipos(item as unknown as Parameters<typeof extractSqoSectionTipos>[0]),
					),
					inheritedDdos: everySlotDdo(baseConfig) as { tipo: string }[],
				} as const);
	const built = await buildRequestConfigFromRqo(input.rqo, element, input.principal);
	return built === null ? null : (built as unknown as InjectableConfigItem[]);
}

/** The lang the element's own config is built in (ResolveElementInput.configLang). */
function configLangOf(input: ResolveElementInput): string {
	return input.configLang ?? input.lang;
}

/** The own-config request of an element occurrence (request_config/own_config.ts). */
function ownRequestOf(input: ResolveElementInput, model: string) {
	return {
		tipo: input.ddo.tipo,
		sectionTipo: input.ownerSectionTipo,
		mode: input.mode,
		model,
		lang: configLangOf(input),
		...(input.ownerSectionId !== undefined ? { sectionId: input.ownerSectionId } : {}),
		...(input.propertiesOverride !== undefined
			? { propertiesOverride: input.propertiesOverride }
			: {}),
	};
}

/**
 * The node's registry key (module header, MEMOISED): the parent occurrence, the
 * element + owner section + mode, the instance lang (node.lang — two TM cells
 * of one column under one root map differ by it) and the config lang where it
 * differs (it feeds the own build's filter_by_list), the owning record when the config reads it, the governing
 * limit and fields, and the resolution flavour.
 */
function nodeKey(
	input: ResolveElementInput,
	recordDependent: boolean,
	limit: number | null,
): string {
	const flags: [boolean, string][] = [
		[recordDependent, `#${String(input.ownerSectionId ?? '')}`],
		[limit !== null, `~${limit}`],
		[input.useOwnConfig === false, '!caller'],
		[input.propertiesOverride !== undefined, '!override'],
		[input.rqo !== undefined, '!rqo'],
	];
	return [
		`${input.parentNode?.key ?? 'top'}>${input.ddo.tipo}@${input.ownerSectionTipo}:${input.mode}`,
		`/${input.lang}`,
		// The config lang splits the key only where it differs from the instance
		// lang (the own build's filter_by_list follows it).
		configLangOf(input) !== input.lang ? `^${configLangOf(input)}` : '',
		governingFieldsKey(input.ddo),
		...flags.map(([applies, part]) => (applies ? part : '')),
	].join('');
}

/** A resolved effective config (before the governing limit) and where it came from. */
interface ResolvedConfig {
	readonly config: InjectableConfigItem[];
	readonly configSource: ElementConfigSource;
	/** The slots the caller replaced (module header, INJECTED SLOTS). */
	readonly injectedSlots: readonly ConfigSlot[];
}

/** The DATA slots — what `node.children` is built from (show + hide). */
const DATA_SLOTS: readonly ConfigSlot[] = ['show', 'hide'];

/**
 * The slots the injection replaced, comparing each item's slot blocks with the
 * base's (injectCallerChildren returns a fresh block exactly where it injected;
 * an untouched slot keeps the base's block by reference).
 */
function replacedSlots(
	config: readonly InjectableConfigItem[],
	base: readonly InjectableConfigItem[],
): ConfigSlot[] {
	return CONFIG_SLOTS.filter((slot) =>
		config.some((item, index) => item !== base[index] && item[slot] !== base[index]?.[slot]),
	);
}

/**
 * Steps 2 + 3 (module header): the base config with the parent's children
 * injected — or, when there is no base at all, the caller's dedalo children as
 * the config (NO OWN CONFIG AT ALL).
 */
function injectedConfig(
	input: ResolveElementInput,
	base: readonly InjectableConfigItem[],
): ResolvedConfig {
	const { parentNode } = input;
	const children =
		parentNode === null
			? []
			: collectCallerChildren(parentNode.effectiveConfig, input.ddo.tipo, parentNode.childOrigin);
	if (base.length === 0) {
		const config = callerOnlyConfig(children);
		const item = config[0];
		return {
			config,
			configSource: 'caller',
			injectedSlots:
				item === undefined
					? []
					: CONFIG_SLOTS.filter((slot) => item[slot] !== null && item[slot] !== undefined),
		};
	}
	const config = injectCallerChildren(base, children);
	return {
		config,
		configSource: input.useOwnConfig === false ? 'caller' : 'own',
		// injectCallerChildren replaces exactly the items and slots it injected
		// into (an engine the element lacks, an empty caller slot, stay untouched).
		injectedSlots: replacedSlots(config, base),
	};
}

/** Steps 1-3: stage 1 when the rqo targets the element, else the injected base. */
async function resolveConfig(
	input: ResolveElementInput,
	model: string,
	notices: ApiNotice[],
): Promise<ResolvedConfig> {
	const { resolveOwnRequestConfig } = await import('./request_config/own_config.ts');
	const ownConfig = (await resolveOwnRequestConfig({
		...ownRequestOf(input, model),
		notices,
	})) as unknown as InjectableConfigItem[];
	if (input.useOwnConfig === false) {
		// A one-level expansion keeps its own sqo / page size, never its own
		// children (module header, ONE-LEVEL EXPANSIONS) — and is never targeted.
		return injectedConfig(input, withoutOwnSlots(ownConfig));
	}
	const injected = injectedConfig(input, ownConfig);
	const stageOne = await stageOneConfig(input, injected.config, model);
	if (stageOne === null) return injected;
	if (model === 'section') {
		// A SECTION's stage 1 is PHP's whole client-shaped config (its sqo is
		// the client's page — from_rqo.ts module header).
		return {
			config: withoutDeepSelf(input.ddo.tipo, stageOne, notices),
			configSource: 'rqo',
			injectedSlots: [],
		};
	}
	const merged = mergeComponentStageOne(injected.config, stageOne);
	return {
		config: withoutDeepSelf(input.ddo.tipo, merged.config, notices),
		configSource: 'rqo',
		injectedSlots: injected.injectedSlots.filter((slot) => !merged.replacedSlots.includes(slot)),
	};
}

/**
 * A targeted COMPONENT's stage 1, merged onto its resolved base (own config +
 * caller injection) — nested-ddo_map plan W5 review, 2026-11-03, owner
 * decision (a): "a component's definition resolves the same way on every
 * page". The client sends a component's show / search ddo_map on its own
 * get_data (component_portal.js sends_own_show — every nested portal and every
 * top-level one whose section map injects its children), so stage 1 applies
 * on page 2 and on refresh. It replaces ONLY the slots the client sent, on the
 * base's FIRST dedalo item (the injection rule's item), keeping the block's
 * other keys (sqo_config …):
 *
 *   base   [{dedalo, show:[rsc85, rsc86], hide:[rating frame], sqo:{fixed_filter: <fresh>}},
 *           {zenon, show:[…]}]
 *   client show [rsc86, rsc85]
 *   → [{dedalo, show:[rsc86, rsc85], hide:[rating frame], sqo:{fixed_filter: <fresh>}},
 *      {zenon, show:[…]}]
 *
 * Everything else stays the SERVER's: the hide / choose slots (a dataframe
 * rating, a geolocation target read from hide), every other api_engine item,
 * and the sqo — its fixed_filter / filter_by_list are re-expanded from live
 * record data on every read (explicit.ts), never echoed back from the client's
 * stale copy. The client's limit / offset still page the read: the get_data
 * door reads them from `rqo.sqo` directly (section/read.ts). Diverges from PHP,
 * whose client never sent add_show for a component
 * (WC-2026-11-04-nested-paging-add-show).
 *
 * A base with no dedalo item (nothing to merge onto) takes stage 1 as is.
 */
function mergeComponentStageOne(
	base: readonly InjectableConfigItem[],
	stageOne: readonly InjectableConfigItem[],
): { config: InjectableConfigItem[]; replacedSlots: ConfigSlot[] } {
	const [clientItem] = stageOne;
	const targetIndex = base.findIndex((item) => engineOf(item) === 'dedalo');
	const target = base[targetIndex];
	if (clientItem === undefined || target === undefined) {
		return { config: [...stageOne], replacedSlots: [] };
	}
	const { item, replacedSlots } = mergeClientSlots(target, clientItem);
	return {
		config: base.map((entry, index) => (index === targetIndex ? item : entry)),
		replacedSlots,
	};
}

/**
 * The base's dedalo item with the client's SHOW ddo_map (always — stage 1
 * carries one) and SEARCH ddo_map (when sent), every other key of the item and
 * of each block kept (mergeComponentStageOne).
 */
function mergeClientSlots(
	target: InjectableConfigItem,
	clientItem: InjectableConfigItem,
): { item: InjectableConfigItem; replacedSlots: ConfigSlot[] } {
	const replacedSlots: ConfigSlot[] = ['show'];
	const merged: Record<string, unknown> = {
		...target,
		show: withClientDdoMap(target.show, clientItem.show?.ddo_map),
	};
	const search = clientItem.search;
	if (search !== undefined && search !== null) {
		replacedSlots.push('search');
		merged.search = withClientDdoMap(target.search, search.ddo_map);
	}
	return { item: merged as InjectableConfigItem, replacedSlots };
}

/** A slot block with its ddo_map replaced by the client's (absent = empty), its other keys kept. */
function withClientDdoMap(
	block: InjectableConfigItem['show'],
	ddoMap: unknown,
): Record<string, unknown> {
	return { ...(block ?? {}), ddo_map: ddoMap ?? [] };
}

/**
 * Resolve ONE element occurrence to its node (module header), memoised in the
 * emission's registry.
 */
export async function resolveElement(input: ResolveElementInput): Promise<ElementNode> {
	const { ddo, parentNode, registry } = input;
	const tipo = ddo.tipo;
	const limit = governingLimitOf(ddo);
	const { getModelByTipo } = await import('../ontology/resolver.ts');
	const model = input.model ?? (await getModelByTipo(tipo)) ?? '';
	const { ownConfigDependsOnRecord } = await import('./request_config/own_config.ts');
	// The own config is resolved for one-level expansions too (their page
	// size), so whether it reads the record matters either way.
	const recordDependent = await ownConfigDependsOnRecord(ownRequestOf(input, model));
	const key = nodeKey(input, recordDependent, limit);

	return registry.memo(key, async () => {
		const notices: ApiNotice[] = [];
		const { config, configSource, injectedSlots } = await resolveConfig(input, model, notices);
		const dataChildrenInjected = injectedSlots.some((slot) => DATA_SLOTS.includes(slot));
		registry.addNotices(notices);
		const effectiveConfig = withGoverningLimit(config, limit);
		return {
			key,
			parentKey: parentNode?.key ?? null,
			tipo,
			section_tipo: input.ownerSectionTipo,
			mode: input.mode,
			view: stringField(ddo, 'view'),
			lang: input.lang,
			limit,
			parent_grouper: stringField(ddo, 'parent_grouper'),
			properties: propertiesField(ddo),
			effectiveConfig,
			configSource,
			injected: injectedSlots.length > 0,
			injectedSlots,
			dataChildrenInjected,
			childOrigin: childOriginOf(configSource, dataChildrenInjected, parentNode),
			children: nodeDataChildren(input, effectiveConfig),
			oneLevel: input.useOwnConfig === false,
		};
	});
}

/**
 * The node's data children (module header, DATA CHILDREN): none in 'solved'.
 * A one-level expansion's own map is emptied on purpose — no empty-show-map
 * warning for it.
 */
function nodeDataChildren(
	input: ResolveElementInput,
	effectiveConfig: readonly InjectableConfigItem[],
): Record<string, unknown>[] {
	if (input.mode === 'solved') return [];
	return directDataChildren(input.ddo.tipo, effectiveConfig, input.useOwnConfig !== false);
}

/**
 * The ROOT pseudo node of a read: the map its top-level elements are children
 * of (a section's column ddo_map, a Time Machine column map, a RAG embed map),
 * standing in for the caller config of every top-level element. One per map
 * object per emission; its level >= 2 'self' ddos are refused here (the map
 * may be client-sent and never went through the builder).
 *
 *   root of dd_map [rsc1400<self, rsc86<rsc1400]  →  rsc1400's caller children [rsc86]
 */
export function rootNodeFor(
	registry: ElementNodeRegistry,
	callerTipo: string,
	sectionTipo: string,
	mode: string,
	ddoMap: readonly Ddo[],
): ElementNode {
	const build = (key: string): ElementNode => {
		const notices: ApiNotice[] = [];
		const [rootItem] = withoutDeepSelf(
			callerTipo,
			[{ api_engine: 'dedalo', type: 'main', show: { ddo_map: [...ddoMap] } }],
			notices,
		);
		registry.addNotices(notices);
		const effectiveConfig = rootItem === undefined ? [] : [rootItem];
		return {
			key,
			parentKey: null,
			tipo: callerTipo,
			section_tipo: sectionTipo,
			mode,
			view: null,
			lang: '',
			limit: null,
			parent_grouper: null,
			properties: null,
			effectiveConfig,
			configSource: 'root',
			injected: false,
			injectedSlots: [],
			dataChildrenInjected: false,
			childOrigin: registry.rootOrigin,
			// No empty-map warning: a read with no caller map (a component get_data)
			// has an empty root by construction.
			children: directDataChildren(callerTipo, effectiveConfig, false),
			oneLevel: false,
		};
	};
	// An EMPTY map is the same root for every cell of one caller (registry
	// emptyRootFor) — a fresh `[]` per cell must not mint a node per cell.
	return ddoMap.length === 0
		? registry.emptyRootFor(`${callerTipo}@${sectionTipo}:${mode}`, build)
		: registry.rootFor(ddoMap, build);
}

/** One EMITTED element occurrence — what every emitter knows when it resolves its node. */
export interface EmittedElementInput {
	/** The governing ddo (the caller's line for the element). */
	readonly ddo: Ddo;
	/** The read's root map (the caller of a top-level element). */
	readonly ddoMap: readonly Ddo[];
	/** The record the element sits on. */
	readonly row: EmitRow;
	readonly model: string;
	/** The element's render mode (`ddo.mode ?? defaultMode`). */
	readonly ddoMode: string;
	/** The element's instance lang (resolver.ts elementLang). */
	readonly ddoLang: string;
	/** The read's default mode (the root map's mode). */
	readonly defaultMode: string;
	/** The read's data lang (the own config's build lang). */
	readonly defaultLang: string;
	/** The read's caller tipo (the root map's owner). */
	readonly callerTipo: string;
	readonly registry: ElementNodeRegistry;
	/** The nested scope; undefined at a read's top level (the root map is the caller). */
	readonly scope?: EmitScope;
	/** false = a one-level expansion (ResolveElementInput.useOwnConfig). Default true. */
	readonly useOwnConfig?: boolean;
}

/**
 * THE node of one emitted element occurrence — the ONE spelling of its
 * resolveElement input, shared by every emitter (models/portal.ts for the
 * relation family, section/read.ts emitDdoData for a literal and for its
 * frames, and the generic item binding there). Same input → same registry key
 * → the memo answers, so the data path and the context door read the SAME
 * node however many emitters ask for it. The caller is the scope's parent
 * node, else — at a read's top level — the read's ROOT map (rootNodeFor); the
 * config is owned by the record the cell sits on (configOwnerOf: a TM dd15 row
 * cell is the subject record's component) and built in the read's data lang.
 */
export function resolveEmittedElement(input: EmittedElementInput): Promise<ElementNode> {
	const owner = configOwnerOf(input.row);
	const target = pinnedTargetOf(input, owner.section_tipo);
	if (target !== undefined) return Promise.resolve(target);
	return resolveElement({
		ddo: input.ddo,
		parentNode:
			input.scope?.parentNode ??
			rootNodeFor(
				input.registry,
				input.callerTipo,
				input.row.section_tipo,
				input.defaultMode,
				input.ddoMap as Ddo[],
			),
		ownerSectionTipo: owner.section_tipo,
		ownerSectionId: owner.section_id,
		mode: input.ddoMode,
		lang: input.ddoLang,
		configLang: input.ddo.lang ?? input.defaultLang,
		registry: input.registry,
		model: input.model,
		...(input.useOwnConfig === false ? { useOwnConfig: false } : {}),
	});
}

/**
 * The read's TARGETED element node when this emission IS its top-level
 * occurrence (element_registry.ts setTarget): a get_data door resolved it
 * already — stage 1, governing limit, override — and the emission must be a
 * projection of THAT node, never of a second own-config one (the main context
 * entry reads the pinned node). Nested occurrences (a scope) and one-level
 * expansions resolve as usual.
 */
function pinnedTargetOf(
	input: EmittedElementInput,
	ownerSectionTipo: string,
): ElementNode | undefined {
	if (input.scope !== undefined || input.useOwnConfig === false) return undefined;
	return input.registry.targetFor(input.ddo.tipo, ownerSectionTipo, input.ddoMode);
}

/** The code a stopped record cycle reports (registry: src/core/errors/registry.ts). */
export const RECORD_CYCLE_CODE = 'relation.record_cycle_stopped' as const;

/** A record an occurrence / notice names (its id in any stored form — echoed, never written). */
type OccurrenceRow = { readonly section_tipo: string; readonly section_id: StoredSectionId };

/**
 * One relation element's OCCURRENCE on a record — the unit of the per-path
 * record-cycle guard (owner decision (e)): `${section_tipo}|${section_id}|${tipo}`.
 * A repeat on the SAME path (A's portal → B → B's portal → A → A's portal) is a
 * cycle; the same occurrence reached through two different paths (a diamond)
 * is not.
 */
export function occurrenceKey(row: OccurrenceRow, tipo: string): string {
	return `${row.section_tipo}|${String(row.section_id)}|${tipo}`;
}

/** Longest tipo / id a cycle notice echoes (the map and ids may be client-shaped). */
const NOTICE_FIELD_MAX = 64;

/** A notice field capped at NOTICE_FIELD_MAX characters. */
function printable(value: string): string {
	return value.length > NOTICE_FIELD_MAX ? `${value.slice(0, NOTICE_FIELD_MAX)}…` : value;
}

/**
 * The typed notice for a stopped record cycle: the element `tipo` on record
 * (`section_tipo`, `section_id`) was met again on its own path, `depth`
 * relation hops below the read's top level. The repeated occurrence renders its
 * own item without its nested children; the rest of the read completes.
 */
export async function recordCycleNotice(
	row: OccurrenceRow,
	tipo: string,
	depth: number,
): Promise<ApiNotice> {
	const { specOf } = await import('../errors/registry.ts');
	const spec = specOf(RECORD_CYCLE_CODE);
	return {
		code: RECORD_CYCLE_CODE,
		label_key: spec.label_key,
		retryable: spec.retryable,
		details: {
			tipo: printable(tipo),
			section_tipo: printable(row.section_tipo),
			section_id: printable(String(row.section_id)),
			depth,
			more: 0,
		},
	};
}

/**
 * The hard bound on ddo recursion depth — emitDdoData (section/read.ts)
 * re-enters itself through every relation expansion (portal children,
 * dataframe frames, autocomplete targets), and every hop adds one.
 *
 * Two guards run BEFORE it: a cyclic MAP is cut by the caller-children walk
 * (request_config/caller_injection.ts) and a RECORD cycle by the per-path
 * occurrence guard (models/portal.ts, RECORD_CYCLE_CODE). What is left is a
 * long NON-cyclic chain, each hop a new record (people → father → father …).
 * Where that chain comes from decides what happens at the bound:
 *   - from the ONTOLOGY (own configs, or a derived map): ordinary data, never
 *     the request's fault — the element whose children would cross the bound
 *     stops expanding, renders its own item, and a typed DEPTH_BOUND_CODE
 *     notice names it; the rest of the read completes (owner decision (e)'s
 *     rule). EVERY depth+1 hop applies it before recursing: a portal's
 *     children (models/portal.ts), a dataframe's frame children under a
 *     relation OR a literal main (relation_core.ts emitDataframeItem), a
 *     relation_index's related_list children (models/relation_index.ts);
 *   - from a CLIENT-sent map: emitDdoData refuses the read loudly
 *     (request.invalid_rqo) — the client asked for a pathological map.
 *
 * 12 is generous: PHP's deepest observed real chain is three levels
 * (bibliography → reference → author; numisdata77 → numisdata164 → rsc29).
 */
export const MAX_DDO_DEPTH = 12;

/** The code a depth-bound stop reports (registry: src/core/errors/registry.ts). */
export const DEPTH_BOUND_CODE = 'relation.depth_bound_stopped' as const;

/**
 * The typed notice for an ontology-driven chain stopped at MAX_DDO_DEPTH: the
 * element `tipo` on record (`section_tipo`, `section_id`) rendered its own item
 * but its targets were not expanded, `depth` hops below the read's top level.
 */
export async function depthBoundNotice(
	row: OccurrenceRow,
	tipo: string,
	depth: number,
): Promise<ApiNotice> {
	const { specOf } = await import('../errors/registry.ts');
	const spec = specOf(DEPTH_BOUND_CODE);
	return {
		code: DEPTH_BOUND_CODE,
		label_key: spec.label_key,
		retryable: spec.retryable,
		details: {
			tipo: printable(tipo),
			section_tipo: printable(row.section_tipo),
			section_id: printable(String(row.section_id)),
			depth,
			more: 0,
		},
	};
}
