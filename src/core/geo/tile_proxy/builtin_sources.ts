/**
 * THE CORE'S BUILT-IN MAP SOURCES — a CLOSED registry of tile services the engine itself
 * relays, and the per-ORIGIN terms the tile proxy owes the providers it talks to.
 *
 * A request names a built-in by id (`builtin=osm`) and never an address, so the registry is
 * the only place an address of the core's own lives. It is code, not configuration: a
 * provider's terms are a reviewed fact about that provider, and no key of the
 * installation's moves an endpoint, a lifetime or a spacing. A change is an edit of this
 * table.
 *
 * WHAT MAY BE IN IT. A provider whose published terms CLEARLY allow a server to fetch its
 * tiles on behalf of a viewer and hand them on, with the attribution they ask for — or allow it
 * on conditions the row LISTS, each marked as met by the proxy, or as met only where the
 * installation can meet it (and what is sent where it cannot). A row claims no more than that.
 * Each row below states where it was checked (the date is the day the terms were read). A
 * service whose terms were not verified, or forbid the use, is NOT here:
 *
 *   - DARE (the Digital Atlas of the Roman Empire): the author's licence (CC BY) and a
 *     contact are known, but nothing says whether a tile may be relayed, so it stays out
 *     until the author confirms in writing.
 *   - Catastro (Spain): its licence forbids distributing the original information over
 *     the Internet without transforming it, so its imagery is never relayed (its LOOKUPS
 *     live in geo_services, which extract fields instead).
 *   - Carto, ArcGIS, Google: commercial services whose terms do not allow a relay.
 *
 * A source an installation WANTS beyond these is data, not code: a stored source in a
 * record (the editor carries the licence), or an ontology default
 * (`properties.map_sources`, which the administrators choose).
 *
 *   osm              OpenStreetMap standard tiles. Tile Usage Policy
 *                    (operations.osmfoundation.org/policies/tiles/, read 2026-11-06).
 *                    The policy "generally does not recommend" a caching proxy, and allows one
 *                    that meets what it asks of it. What it asks, and what this row delivers:
 *                      - a clear, contactable User-Agent identifying the service, never every
 *                        client behind one anonymous identity. MET WHERE THE INSTALLATION HAS A
 *                        PUBLIC ORIGIN: the interactive door sends
 *                        `dedalo/<release> (+<that origin>)`, naming the INSTALLATION as the
 *                        contact (harvest/installation_identity.ts; the same validated origin
 *                        as the Referer), so OSM sees one contactable installation per origin.
 *                        NOT MET WHERE IT HAS NONE (an installation reachable only from its own
 *                        network, or a malformed DEDALO_HOST): it sends the shared, less
 *                        identifying `dedalo/<release> (+https://dedalo.dev; heritage
 *                        cataloguing)`, the same for every such installation, which the policy
 *                        lets OSM block; the row is still relayed, never refused. Whether such an installation may relay this row at
 *                        all is the maintainer's decision and is OPEN
 *                        (engineering/wire_contract/WC-2026-11-06-map-tile-proxy.md); today it
 *                        does, and docs/core/system/map_tile_proxy.md says so to its operator;
 *                      - the server's caching headers honoured, or a tile kept 7 days when
 *                        they cannot be read. MET (`defaultLifetimeMs` below);
 *                      - conditional requests on expired tiles. MET: a tile that came with an
 *                        `ETag` / `Last-Modified` is kept past its freshness and asked about
 *                        with `If-None-Match` / `If-Modified-Since` (validators.ts,
 *                        tile_cache.ts), so an unchanged tile costs OSM a header;
 *                      - the Referer not stripped. MET WHERE THE INSTALLATION HAS A PUBLIC
 *                        ORIGIN (`sendReferer`); NOT MET where it has none (no Referer is sent);
 *                      - no prefetch and no bulk download. MET: the route relays the tile asked
 *                        for and never a neighbour, and a person's share of the provider is
 *                        bounded (principal_budget.ts);
 *                      - the attribution on the map. MET by the client.
 *   ign_admin_units  IGN (Spain) WMS-INSPIRE, administrative units. Licence CC BY 4.0
 *                    (Orden FOM/2807/2015, art. 4): free reuse naming the origin; for a
 *                    service used unmodified the attribution is the one in the service's
 *                    own AccessConstraints — "CC BY 4.0 ign.es", read from its
 *                    GetCapabilities 2026-11-06, with WMS 1.3.0 and EPSG:3857 listed.
 *
 * THE TERMS ARE A PROPERTY OF THE ORIGIN, not of the way a request found it. A stored
 * source whose host is a registry host gets the same terms (`termsFor`): the provider
 * cannot tell, and does not care, whose record the request came from.
 */

import { bareHost } from '../../harvest/follow.ts';
import { type MapSourceBody, validateMapSource } from '../map_source.ts';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** What the proxy owes the provider that runs an origin. */
export interface ProviderTerms {
	/** The spacing a start owes the starts after it at this origin (the door's `minIntervalMs`). */
	readonly minIntervalMs: number;
	/** Send the installation's public origin as Referer (a policy that asks not to be stripped of it). */
	readonly sendReferer: boolean;
	/** How long a tile is kept when the provider's answer states no freshness at all. */
	readonly defaultLifetimeMs: number;
}

/** The terms of an origin no table names: no spacing beyond the door's cap, no Referer, an hour. */
export const DEFAULT_TERMS: ProviderTerms = Object.freeze({
	minIntervalMs: 0,
	sendReferer: false,
	defaultLifetimeMs: HOUR_MS,
});

export interface BuiltinSource {
	/** What `builtin=` names. */
	readonly id: string;
	/** The picker text. */
	readonly label: string;
	/** The source as the stored shape (geo/map_source.ts), so ONE builder serves every kind. */
	readonly source: MapSourceBody;
	readonly terms: ProviderTerms;
}

/** The registry's rows, as written. Frozen to the leaves by `freezeDeep` below. */
const ROWS: readonly BuiltinSource[] = [
	{
		id: 'osm',
		label: 'OpenStreetMap',
		source: {
			type: 'xyz',
			url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
			params: { min_zoom: 0, max_zoom: 19 },
			attribution: '© OpenStreetMap contributors',
		},
		// The policy's own number: a tile whose freshness cannot be read is kept 7 days.
		terms: { minIntervalMs: 0, sendReferer: true, defaultLifetimeMs: 7 * DAY_MS },
	},
	{
		id: 'ign_admin_units',
		label: 'IGN administrative units',
		source: {
			type: 'wms',
			url: 'https://www.ign.es/wms-inspire/unidades-administrativas',
			params: {
				version: '1.3.0',
				layers: 'AU.AdministrativeBoundary',
				styles: '',
				format: 'image/png',
				transparent: true,
				crs: 'EPSG:3857',
			},
			attribution: 'CC BY 4.0 ign.es',
		},
		terms: { minIntervalMs: 0, sendReferer: false, defaultLifetimeMs: DAY_MS },
	},
];

/** Freeze a plain value to its leaves (the registry is read-only for everyone who imports it). */
function freezeDeep<T>(value: T): T {
	if (value !== null && typeof value === 'object') {
		for (const child of Object.values(value)) freezeDeep(child);
		Object.freeze(value);
	}
	return value;
}

/** The closed registry, by id. */
const REGISTRY: ReadonlyMap<string, BuiltinSource> = new Map(
	ROWS.map((row) => [row.id, freezeDeep(row)] as const),
);

/** The ids of the registry, in table order. */
export const BUILTIN_SOURCE_IDS: readonly string[] = Object.freeze(ROWS.map((row) => row.id));

/** The built-in named `id`, or null. A non-string is never a key. */
export function findBuiltinSource(id: unknown): BuiltinSource | null {
	return typeof id === 'string' ? (REGISTRY.get(id) ?? null) : null;
}

/** What a client picker may be told of the registry: id, label and type — never an address. */
export function builtinPickerEntries(): { id: string; label: string; type: string }[] {
	return ROWS.map((row) => ({ id: row.id, label: row.label, type: row.source.type }));
}

/** The host a template or endpoint names (placeholders read as digits), or null. */
function hostOfTemplate(url: string): string | null {
	return URL.parse(url.replace(/\{(?:z|x|y)\}/g, '0'))?.hostname ?? null;
}

/** The registry's origins' terms, by host as compared (`bareHost`). */
const TERMS_BY_HOST: ReadonlyMap<string, ProviderTerms> = new Map(
	ROWS.flatMap((row) => {
		const host = hostOfTemplate(row.source.url);
		return host === null ? [] : [[bareHost(host), row.terms] as const];
	}),
);

/**
 * The terms owed to the origin `hostname` — a registry origin's own, whoever's record the
 * request came from; the default for any other.
 *
 * A host is compared as the redirect allowlist compares it (`bareHost`, harvest/follow.ts):
 * lower-case, no trailing root dot — `tile.openstreetmap.org.` is OpenStreetMap's server, and
 * missing it would strip the Referer its policy asks for and keep its tiles an hour instead of
 * its week. But EXACTLY, never the allowlist's subdomain rule (`siteAdmits`): a row's terms are
 * what was reviewed for that one service, and a name under it (`a.tile.openstreetmap.org`, a
 * retired alias; any other host the operator's DNS may answer) is a service nobody reviewed —
 * it gets the default, which sends no Referer and claims no longer lifetime than the default.
 */
export function termsFor(hostname: string): ProviderTerms {
	return TERMS_BY_HOST.get(bareHost(hostname)) ?? DEFAULT_TERMS;
}

/**
 * Every row passes the validator the stored sources pass. Called by the gate (and cheap
 * enough to run anywhere): a row that stops conforming is a defect in this file, found
 * before a viewer is.
 */
export function builtinProblems(): string[] {
	const problems: string[] = [];
	for (const row of ROWS) {
		const checked = validateMapSource(row.source, `builtin ${row.id}`);
		if (!checked.ok) problems.push(checked.reason);
	}
	return problems;
}
