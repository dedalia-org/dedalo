/**
 * THE GATES OF A TILE REQUEST — who may ask for a source, and which source the name
 * resolves to. Everything that decides "may this person see this map" lives here, before
 * an address is built, before the memory is read, before a socket is opened.
 *
 * ORDER (each step answers null — ONE refusal for the caller — when it fails):
 *
 *   1. THE COMPONENT KEY (security/read_door.ts doorComponentGranted): the SECTION read
 *      grant AND the component's own, asked of the section AS ADDRESSED. A virtual
 *      section's grants are keyed on the virtual tipo (the human read passes the tipo
 *      the client sent), so the permission is never asked of the real section. The QUIET
 *      predicate, not `doorComponentAllowed`: that one writes a `[frontier] REFUSED` line
 *      for every refusal, and any session holder can name any (section, component) it can
 *      spell on a cheap GET, a real viewport asking dozens. A refusal here is counted
 *      (`map_tile_denied`) and said once a window per person (`noteDenied`).
 *   2. THE ONTOLOGY'S TRUTH about the pair: the component is a `component_geolocation`
 *      and belongs to that section (`tipoBelongsToSection`, which resolves a virtual
 *      section to its real one — a virtual section borrows its real section's children).
 *      A request that names another model's tipo is the same refusal, not a different
 *      one: the route is not a way to read any component's column.
 *   3. THE RECORD SCOPE (a stored source only): `principalCanAccessRecord` — the projects
 *      filter and the tenant boundary every other record door applies. A global
 *      administrator is unscoped; a non-positive id is never a record.
 *   4. THE SOURCE: a stored one is read from the record's own value and RE-VALIDATED
 *      (geo/stored_source.ts — a template can predate a rule that has tightened); a
 *      default from the component node's `properties.map_sources`; a built-in from the
 *      closed registry. Nothing else names a source.
 *
 * THE STORED READ IS NARROW. A viewport asks dozens of tiles of one source (up to 160 on a 4K display), and the
 * memory saves the provider call, not this work, so it must be cheap: the database is asked
 * for the ONE source object (`readNestedItemsById`, a JSONPath evaluated in Postgres), not
 * the row. The geolocation value it sits in also holds the drawn layers (`lib_data`, GeoJSON
 * that can run to megabytes), none of which crosses to the engine. Every grant and the
 * record scope are still asked on EVERY request, before this read.
 *
 * "Unknown" and "forbidden" are one outcome: every `null` below is the same refusal at
 * the route, so the response cannot tell a caller which of the two it hit. The gates
 * come in an order that keeps it true for a caller who may not read the component at all:
 * steps 1-2 depend on the (section, component) pair and the caller's profile, never on
 * whether the source id exists.
 *
 * `addressFrom` is the truth the interactive door needs (OUTBOUND_SPEC.md §3.1): an
 * address an EDITOR wrote is `'stored'` and draws on the smaller share of the global
 * budget; the closed registry and an ontology default (chosen by administrators) are
 * `'registry'`.
 */

import { incrementCounter } from '../../api/counters.ts';
import type { MatrixJsonbColumn } from '../../db/matrix.ts';
import { readNestedItemsById } from '../../db/matrix_entry_read.ts';
import type { InteractiveAddressFrom } from '../../harvest/interactive_limits.ts';
import {
	getColumnNameByModel,
	getMatrixTableFromTipo,
	getModelByTipo,
	tipoBelongsToSection,
} from '../../ontology/resolver.ts';
import type { Principal } from '../../security/permissions.ts';
import { doorComponentGranted } from '../../security/read_door.ts';
import { principalCanAccessRecord } from '../../security/record_scope.ts';
import type { MapSourceBody } from '../map_source.ts';
import { findMapSourceDefault, readMapSourceDefaults } from '../map_source_defaults.ts';
import { lookupStoredMapSource } from '../stored_source.ts';
import { findBuiltinSource } from './builtin_sources.ts';
import { reportOncePerWindow } from './tile_log.ts';
import type { TileRef } from './tile_request.ts';

/** The read door's name in the operator log. THE key `READ_DOOR_POSTURE` classifies. */
export const MAP_TILE_DOOR = 'http:GET /dedalo/core/api/v1/map_tile';

const GEOLOCATION_MODEL = 'component_geolocation';

/** A source the caller may read, and who chose its address. */
export interface ResolvedTileSource {
	readonly source: MapSourceBody;
	readonly addressFrom: InteractiveAddressFrom;
}

/**
 * A person asked for a (section, component) they may not read. What they named is theirs to
 * vary at will, so it is COUNTED and never logged; the operator hears of it once a window per
 * person (the line names the user and no tipo — a caller could otherwise mint a distinct line
 * per spelled pair), which is how a stale client or a probe shows up.
 */
function noteDenied(principal: Principal): void {
	incrementCounter('map_tile_denied');
	const line = `[map_tile] perm.denied user=${principal.userId} asked for a map it may not read (counted; repeats within the window are not logged)`;
	reportOncePerWindow(line, Date.now(), () => console.warn(line));
}

/** Steps 1 and 2: the component key, and the ontology's truth about the pair. */
async function mayReadGeolocation(principal: Principal, ref: TileRef): Promise<boolean> {
	const step = {
		sectionTipo: ref.sectionTipo,
		componentTipo: ref.componentTipo,
		...(ref.kind === 'stored' ? { sectionId: ref.sectionId } : {}),
	};
	if (!(await doorComponentGranted({ principal, door: MAP_TILE_DOOR }, step))) {
		noteDenied(principal);
		return false;
	}
	if ((await getModelByTipo(ref.componentTipo)) !== GEOLOCATION_MODEL) return false;
	return tipoBelongsToSection(ref.componentTipo, ref.sectionTipo);
}

/** The stored source `ref` names, as the matrix holds it (raw, at most one object), or none. */
async function readStoredSource(
	ref: Extract<TileRef, { kind: 'stored' }>,
	table: string,
): Promise<unknown[]> {
	const column = getColumnNameByModel(GEOLOCATION_MODEL);
	if (column === null) return [];
	return readNestedItemsById({
		tableName: table,
		sectionTipo: ref.sectionTipo,
		sectionId: ref.sectionId,
		column: column as MatrixJsonbColumn,
		componentTipo: ref.componentTipo,
		key: 'sources',
		itemId: ref.sourceId,
	});
}

/**
 * A stored source that fails today's rules is reported once per source per window, not once
 * per tile: a viewport asks for dozens, and any reader of the record can ask. The reason names
 * a rule and a path, never a value (geo/checked.ts): safe to log.
 */
function reportInvalidStored(ref: Extract<TileRef, { kind: 'stored' }>, reason: string): void {
	const where = `${ref.sectionTipo}.${ref.componentTipo}#${ref.sectionId}`;
	const line = `[map_tile] stored source ${ref.sourceId} of ${where} fails today's rules, not relayed: ${reason}`;
	reportOncePerWindow(line, Date.now(), () => console.warn(line));
}

/** Steps 3 and 4 for a stored source: the record scope, then the source in the record's own value. */
async function storedSource(
	principal: Principal,
	ref: Extract<TileRef, { kind: 'stored' }>,
): Promise<ResolvedTileSource | null> {
	if (!(await principalCanAccessRecord(ref.sectionTipo, ref.sectionId, principal))) return null;
	const table = await getMatrixTableFromTipo(ref.sectionTipo);
	if (table === null) return null;
	const found = lookupStoredMapSource(
		[{ sources: await readStoredSource(ref, table) }],
		ref.sourceId,
	);
	if (found.status === 'invalid') reportInvalidStored(ref, found.reason);
	return found.status === 'found' ? { source: found.source, addressFrom: 'stored' } : null;
}

/** Step 4 for an ontology default: the entry of the component node's `properties.map_sources`. */
async function defaultSource(
	ref: Extract<TileRef, { kind: 'default' }>,
): Promise<ResolvedTileSource | null> {
	const hit = findMapSourceDefault(await readMapSourceDefaults(ref.componentTipo), ref.defaultId);
	return hit === null ? null : { source: hit.source, addressFrom: 'registry' };
}

/**
 * The source `ref` names, if `principal` may read it; null for "unknown" and "forbidden"
 * alike (see the header). Never throws for a refusal.
 */
export async function resolveTileSource(
	principal: Principal,
	ref: TileRef,
): Promise<ResolvedTileSource | null> {
	if (!(await mayReadGeolocation(principal, ref))) return null;
	if (ref.kind === 'stored') return storedSource(principal, ref);
	if (ref.kind === 'default') return defaultSource(ref);
	const builtin = findBuiltinSource(ref.builtinId);
	return builtin === null ? null : { source: builtin.source, addressFrom: 'registry' };
}
