/**
 * LIST/TM-cell effective config resolution (PHP resolve_source_properties +
 * get_ar_request_config): what a relation component's list cell actually
 * expands is NOT always its own request_config —
 *
 *   1. If the component has a `section_list` ontology CHILD, that child's
 *      properties REPLACE the component's own for list/tm builds:
 *      a. child properties carry source.request_config → explicit build from THEM
 *         (numisdata77 → numisdata564 → [numisdata164, rsc29, numisdata165,
 *         rsc29], sqo_config.limit 1);
 *      b. child properties are null/without config → implicit LEGACY build: the
 *         ddos are the section_list NODE's relations (minus the target
 *         section), all mode 'list' (numisdata163 → numisdata273 → [rsc368]).
 *   2. No section_list child → the component's own properties:
 *      a. source.request_config → explicit (numisdata161 — full map INCLUDING its
 *         component_dataframe ddo numisdata1447);
 *      b. none → implicit from the component node's own relations.
 *
 * The cell page limit follows the SAME resolved config: show.sqo_config.limit
 * ?? sqo.limit ?? null (caller falls back to the 1-locator list cell /
 * 10-record edit page). A ddo-level `limit` on the child entry (rsc139 → 5 in
 * rsc368's map) overrides it from the parent side.
 */

import { sql } from '../../db/postgres.ts';
import { createOntologyCache } from '../../ontology/cache_factory.ts';
import { registerOntologyCacheClearer } from '../../ontology/cache_invalidation.ts';
import { getModelByTipo } from '../../ontology/resolver.ts';
import { type ConfigDdoMapSource, flattenConfigDdoMaps } from '../../relations/config_ddo_map.ts';
import { selectLocalConfigItem } from '../../relations/request_config/engine_select.ts';

export interface RawConfigDdo {
	tipo: string;
	parent?: string;
	section_tipo?: string | string[];
	mode?: string;
	lang?: string;
	limit?: number;
	model?: string;
	[key: string]: unknown;
}

export interface ListCellMap {
	/** Explicit path: the raw ddo_map entries of the resolved request_config. */
	rawDdos: RawConfigDdo[] | null;
	/** Implicit path: related tipos (relations of the section_list node / own node). */
	implicitRelations: string[] | null;
	/** show.sqo_config.limit ?? sqo.limit of the resolved config. */
	cellLimit: number | null;
}

interface RcEntry {
	api_engine?: string;
	sqo?: { limit?: number };
	show?: { ddo_map?: RawConfigDdo[]; sqo_config?: { limit?: number } };
}

/**
 * The effective LIST config of one node: the flattened child ddos of EVERY
 * config item, plus the page limit of the item that owns the paging.
 *
 * CHILDREN come from every item (PHP's full_ddo_map — a zenon item's ddos
 * declare zenon1 and only a zenon1 locator ever matches them, so mixing is
 * safe); the shared flattener adds the structural dedup the hand-rolled concat
 * here was missing. `includeHideDdos` splits the two consumers: emission gets
 * the hide maps, the flat/export JOIN does not (resolveOwnConfigMap below).
 *
 * THE LIMIT is a single item's property, so it needs a narrowing decision — but
 * NOT a capability negotiation. `cellLimit` slices the caller's LOCALLY STORED
 * locator array (relation_core/portal), so the remote service's own paging
 * ability is irrelevant to it; asking `capabilities.pagination` here made an
 * external-only component (zenon declares `pagination: false`) throw
 * ExternalEngineConcernUnsupportedError uncaught through expandPortal and 500
 * the whole section list. Local concern ⇒ selectLocalConfigItem: the dedalo
 * item, else the first item.
 */
// PHP validate_ddo_tipo: a ddo naming a tipo with no resolvable model (an
// optional TLD not installed here — rsc's tchi15 on an install without tchi)
// is DROPPED, never emitted; every rawDdos consumer would otherwise throw.
async function dropUnresolvableDdos(
	flattened: RawConfigDdo[],
	ownerTipo: string,
): Promise<RawConfigDdo[]> {
	const ddos: RawConfigDdo[] = [];
	for (const ddo of flattened) {
		if (typeof ddo?.tipo === 'string' && (await getModelByTipo(ddo.tipo)) === null) {
			console.warn(
				`[section_list] dropped ddo '${ddo.tipo}' from '${ownerTipo}' map: no resolvable ontology model (tld not installed?)`,
			);
			continue;
		}
		ddos.push(ddo);
	}
	return ddos;
}

async function pickConfig(
	properties: unknown,
	ownerTipo: string,
	options?: { readonly includeHideDdos?: boolean },
): Promise<{ ddos: RawConfigDdo[]; limit: number | null } | null> {
	const rcs = (properties as { source?: { request_config?: RcEntry[] } } | null)?.source
		?.request_config;
	if (!Array.isArray(rcs) || rcs.length === 0) return null;
	const flattened = flattenConfigDdoMaps(rcs as unknown as ConfigDdoMapSource[], {
		ownerTipo,
		includeHideDdos: options?.includeHideDdos,
	}) as unknown as RawConfigDdo[];
	const ddos = await dropUnresolvableDdos(flattened, ownerTipo);
	const main = selectLocalConfigItem(rcs);
	const rawLimit = main?.show?.sqo_config?.limit ?? main?.sqo?.limit;
	return {
		ddos,
		limit: typeof rawLimit === 'number' && rawLimit > 0 ? rawLimit : null,
	};
}

const cellMapCache = createOntologyCache<string, ListCellMap>();

/** Drop ALL three ontology-derived maps of this module (cell/frame/own). */
export function clearListCellConfigCache(): void {
	cellMapCache.clear();
	frameChildrenCache.clear();
	ownMapCache.clear();
}
registerOntologyCacheClearer(clearListCellConfigCache);

/** The component's effective LIST/TM-cell child map + page limit (see doc). */
export async function resolveListCellMap(tipo: string): Promise<ListCellMap> {
	const cached = cellMapCache.get(tipo);
	if (cached !== undefined) return cached;

	const childRows = (await sql.unsafe(
		`SELECT tipo, properties, relations FROM dd_ontology
		 WHERE parent = $1 AND model = 'section_list' LIMIT 1`,
		[tipo],
	)) as { tipo: string; properties: unknown; relations: { tipo?: unknown }[] | null }[];

	let resolved: ListCellMap;
	const sectionList = childRows[0];
	if (sectionList !== undefined) {
		const config = await pickConfig(sectionList.properties, sectionList.tipo);
		resolved =
			config !== null
				? { rawDdos: config.ddos, implicitRelations: null, cellLimit: config.limit }
				: {
						rawDdos: null,
						implicitRelations: (sectionList.relations ?? [])
							.map((node) => node.tipo)
							.filter((t): t is string => typeof t === 'string'),
						cellLimit: null,
					};
	} else {
		const ownRows = (await sql.unsafe(
			'SELECT properties, relations FROM dd_ontology WHERE tipo = $1',
			[tipo],
		)) as { properties: unknown; relations: { tipo?: unknown }[] | null }[];
		const config = await pickConfig(ownRows[0]?.properties ?? null, tipo);
		resolved =
			config !== null
				? { rawDdos: config.ddos, implicitRelations: null, cellLimit: config.limit }
				: {
						rawDdos: null,
						implicitRelations: (ownRows[0]?.relations ?? [])
							.map((node) => node.tipo)
							.filter((t): t is string => typeof t === 'string'),
						cellLimit: null,
					};
	}
	cellMapCache.set(tipo, resolved);
	return resolved;
}

const frameChildrenCache = createOntologyCache<string, string[]>();

/**
 * The component's ontology dataframe slots (children of model
 * component_dataframe) — the frame tipos a LITERAL main with
 * has_dataframe:true pairs with (PHP get_dataframe_tipo).
 */
export async function getDataframeChildTipos(tipo: string): Promise<string[]> {
	const cached = frameChildrenCache.get(tipo);
	if (cached !== undefined) return cached;
	const rows = (await sql.unsafe(
		`SELECT tipo FROM dd_ontology WHERE parent = $1 AND model = 'component_dataframe'`,
		[tipo],
	)) as { tipo: string }[];
	const tipos = rows.map((row) => row.tipo);
	frameChildrenCache.set(tipo, tipos);
	return tipos;
}

/** The frame's own page limit + child ddos (its request_config). */
export async function resolveFrameConfig(
	frameTipo: string,
): Promise<{ limit: number; ddos: RawConfigDdo[]; nodeMode: string | null }> {
	const rows = (await sql.unsafe('SELECT properties FROM dd_ontology WHERE tipo = $1', [
		frameTipo,
	])) as { properties: { mode?: string } | null }[];
	const properties = rows[0]?.properties ?? null;
	const config = await pickConfig(properties, frameTipo);
	return {
		limit: config?.limit ?? 1,
		ddos: config?.ddos ?? [],
		nodeMode: typeof properties?.mode === 'string' ? properties.mode : null,
	};
}

const ownMapCache = createOntologyCache<string, ListCellMap>();

/**
 * The component's OWN config map — NO section_list substitution (the export
 * atoms recursion reads the component's own request_config children;
 * numisdata163 exports rsc368 + rsc336 + rsc369, not its section_list's
 * [rsc368]-only list projection).
 *
 * SHOW-ONLY. This is the FLAT/EXPORT map (resolve/relation_list.ts cell JOIN,
 * diffusion/export/atoms.ts), and PHP builds those from `show->ddo_map` alone
 * while resolving hide into a separate `$ar_hide` that "doesn't show into the
 * list". Excluded HERE rather than in each consumer's loop so a new consumer
 * cannot forget it. resolveListCellMap / resolveFrameConfig keep hide: they
 * feed the client emission, where PHP's full_ddo_map does include it.
 */
export async function resolveOwnConfigMap(tipo: string): Promise<ListCellMap> {
	const cached = ownMapCache.get(tipo);
	if (cached !== undefined) return cached;
	const rows = (await sql.unsafe('SELECT properties, relations FROM dd_ontology WHERE tipo = $1', [
		tipo,
	])) as { properties: unknown; relations: { tipo?: unknown }[] | null }[];
	const config = await pickConfig(rows[0]?.properties ?? null, tipo, { includeHideDdos: false });
	const resolved: ListCellMap =
		config !== null
			? { rawDdos: config.ddos, implicitRelations: null, cellLimit: config.limit }
			: {
					rawDdos: null,
					implicitRelations: (rows[0]?.relations ?? [])
						.map((node) => node.tipo)
						.filter((t): t is string => typeof t === 'string'),
					cellLimit: null,
				};
	ownMapCache.set(tipo, resolved);
	return resolved;
}
