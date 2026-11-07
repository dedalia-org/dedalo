/**
 * THE CLOSED TABLE OF GEO SERVICES — every endpoint the engine will ever ask for a
 * place name, a coordinate, a parcel or an elevation, written down once.
 *
 * A service id names ONE request shape on ONE provider: its origin and path, the
 * parameters the provider is sent on every call (`fixed`), the parameters a caller
 * may add and the grammar of each (`params`), how large an answer may be and how
 * long the call may take, what a good answer looks like, and what "nothing there"
 * looks like. The provider's PACING (how many calls at once, how far apart) is a
 * property of its ORIGIN, not of a request, so it lives in `GEO_ORIGINS` and every
 * service of an origin shares it.
 *
 * THERE IS NO CONFIG OVERRIDE, and no run-time edit either. No key moves an endpoint,
 * a path, a parameter, a ceiling or a pacing: the providers' terms are the code's, and a
 * change to one is a reviewed change to this file. The table is exported, so it is frozen
 * to its LEAVES (`frozen.ts`): a shallow freeze would leave every row writable, and a tool
 * that set `GEO_ORIGINS.nominatim.base` would redirect the cataloguer's queries to a host of
 * its choosing. (Nominatim's policy asks that an application can
 * be switched away from its service at the foundation's request without a software
 * update; with no override key, a switch here is a code update — a stated
 * deviation, decided by the maintainer.) A request never carries a URL —
 * `callGeoService` takes an id from this table and parameters from its grammar, and
 * builds the address itself (`request.ts`).
 *
 * WHY THESE PROVIDERS, AND UNDER WHAT TERMS (what a maintainer must re-read before
 * adding to the table; the engineering notes are in engineering/OUTBOUND_SPEC.md §2):
 *   - Nominatim: user-triggered use only, at most 1 request a second for the whole
 *     installation, an identifying User-Agent, attribution shown, no as-you-type
 *     search (hence the 3-character floor on `q`), and RESULTS CACHED on our side — a
 *     client that sends the same query again and again may be classified as faulty and
 *     blocked (hence `keepAnswerMs` on both services: an identical question inside that
 *     time is answered from memory, `answer_memory.ts`).
 *   - DARE (imperium.ahlfeldt.se): the Digital Atlas of the Roman Empire's own
 *     GeoJSON API, released CC BY with scholarly attribution.
 *   - Catastro (ovc.catastro.meh.es): the INSPIRE view and download services. Its
 *     licence forbids distributing the ORIGINAL information over the Internet
 *     without transforming it, and its WMS notice forbids massive downloads: these
 *     are LOOKUPS (one parcel, one pixel, a small box) for a caller that extracts
 *     what it needs, never a relay of the provider's imagery, and the box is capped.
 *   - IGN (www.ign.es WMS-INSPIRE): CC BY 4.0, attribution "CC BY 4.0 ign.es".
 *   - open-elevation: a best-effort public service with a small keyless allowance;
 *     a 429 is a typed refusal, not something to route around.
 *
 * THE QUEUE AND THE CEILING (what an origin's numbers add up to). A caller that waits
 * for an origin that lets ONE call fly at a time starts after every call ahead of it has
 * ended and rested an interval, so the Nth caller in line starts about N x (call time +
 * `minIntervalMs`) after it arrived. `maxQueue` is reached only while that stays inside
 * `maxWaitMs`: with Nominatim's numbers, four callers queue behind a call as long as calls
 * last under 400 ms (4 x (400 + 1100) = 6000); slower calls make the wait ceiling refuse the
 * last in line (`rate.limited`, `wait_exceeded`) before the queue is full. Both bounds are
 * real: the queue bounds memory, the ceiling bounds the wait. The gate drives the ceiling at
 * the millisecond, with calls that take time, and requires that an origin's queue could fill
 * with instantaneous calls (`maxQueue` x `minIntervalMs` inside `maxWaitMs`, per slot).
 *
 * CRS CHOICES. The WMS services accept `CRS:84` (lon, lat) and the projected CRSs
 * (x, y) only. EPSG:4326 and EPSG:4258 are left out ON PURPOSE: a WMS 1.3.0 reads
 * their bounding box as lat, lon, and a caller who writes lon, lat gets a valid
 * answer for the wrong place.
 */

import { deepFreeze } from './frozen.ts';
import {
	choice,
	decimal,
	integer,
	matching,
	numbers,
	optional,
	type ParamDef,
	type ParamReader,
	points,
	type Range,
	type Refinement,
	required,
	text,
	token,
} from './params.ts';

/** The providers the engine talks to. */
export type GeoOriginId = 'nominatim' | 'dare' | 'catastro' | 'ign' | 'open_elevation';

/** A provider: where it lives and what its terms ask of us. */
export interface GeoOrigin {
	/** `https://host` — scheme and host only, no path. */
	readonly base: string;
	/** Calls in flight at once. */
	readonly maxConcurrent: number;
	/**
	 * The least time between two calls (the provider's rate): between their STARTS and, for
	 * an origin that lets one call fly at a time, also from the END of one to the START of the
	 * next (`restAfterCallMs`, `limiters.ts`), so the rate holds on the wire.
	 */
	readonly minIntervalMs: number;
	/** Callers that may wait for a slot; the next is refused (`rate.limited`). */
	readonly maxQueue: number;
	/** The longest a caller waits for its start (queue, spacing and back-off together). */
	readonly maxWaitMs: number;
	/**
	 * How long the origin is left alone after a 429 or a 503. Longer than `maxWaitMs`
	 * (gated), so a newcomer during it is refused fast instead of queueing behind it.
	 */
	readonly backoffMs: number;
	/** What the provider asks to be shown beside its data. */
	readonly attribution: string;
}

export const GEO_ORIGINS = deepFreeze({
	nominatim: {
		base: 'https://nominatim.openstreetmap.org',
		maxConcurrent: 1,
		// The policy is "an absolute maximum of 1 request per second" for the whole
		// installation. One call flies at a time and the interval is also rested after a
		// call ends, so a slow lookup or handshake before one call cannot shrink the gap
		// at the provider; the margin covers the clock and network jitter between two requests.
		minIntervalMs: 1_100,
		maxQueue: 4,
		maxWaitMs: 6_000,
		backoffMs: 30_000,
		attribution: '© OpenStreetMap contributors (ODbL)',
	},
	dare: {
		base: 'https://imperium.ahlfeldt.se',
		maxConcurrent: 1,
		minIntervalMs: 500,
		maxQueue: 6,
		maxWaitMs: 8_000,
		backoffMs: 10_000,
		attribution:
			'Digital Atlas of the Roman Empire (DARE), Johan Åhlfeldt, Centre for Digital Humanities, University of Gothenburg, CC BY',
	},
	catastro: {
		base: 'https://ovc.catastro.meh.es',
		maxConcurrent: 2,
		minIntervalMs: 250,
		maxQueue: 8,
		maxWaitMs: 8_000,
		backoffMs: 15_000,
		attribution: 'Dirección General del Catastro (Spain)',
	},
	ign: {
		base: 'https://www.ign.es',
		maxConcurrent: 2,
		minIntervalMs: 250,
		maxQueue: 8,
		maxWaitMs: 8_000,
		backoffMs: 10_000,
		attribution: 'CC BY 4.0 ign.es',
	},
	open_elevation: {
		base: 'https://api.open-elevation.com',
		maxConcurrent: 1,
		minIntervalMs: 1_000,
		maxQueue: 3,
		maxWaitMs: 6_000,
		backoffMs: 30_000,
		attribution: 'NASA/USGS SRTM 1 arc-second, resampled by Open-Elevation',
	},
} as const satisfies Record<GeoOriginId, GeoOrigin>);

/** The origin ids, in table order. */
export const GEO_ORIGIN_IDS = Object.freeze(Object.keys(GEO_ORIGINS)) as readonly GeoOriginId[];

/** What an answer's JSON must look like to be the provider's. */
export type JsonShape =
	/** A JSON array (Nominatim search). */
	| 'array'
	/** A JSON object (Nominatim reverse). */
	| 'object'
	/** A GeoJSON FeatureCollection. */
	| 'features'
	/** An object with a `results` array (open-elevation). */
	| 'results';

/** How a well-formed JSON answer says "nothing there". */
export type JsonNotFound =
	/** A FeatureCollection with no feature. */
	| 'empty_features'
	/** An object carrying an `error` key (Nominatim reverse answers 200 with one). */
	| 'error_key';

/** What a good answer looks like, and how "nothing there" shows. */
export type AnswerSpec =
	| { readonly kind: 'json'; readonly shape: JsonShape; readonly notFound?: JsonNotFound }
	| {
			readonly kind: 'markup';
			/**
			 * A provider's exception report (HTTP 200) whose text this accepts means
			 * "nothing there"; any other exception report is a failed request. A function,
			 * never a RegExp: see `matching` in `params.ts`.
			 */
			readonly notFound: (text: string) => boolean;
	  };

/** One request shape on one provider. */
export interface GeoService {
	readonly origin: GeoOriginId;
	/** The fixed path, starting with `/`. */
	readonly path: string;
	/** The parameters the service sends on every call, in order, ahead of the caller's. */
	readonly fixed: readonly (readonly [name: string, value: string])[];
	/** The parameters a caller may add, with their grammar. */
	readonly params: readonly ParamDef[];
	/** A check across the caller's parameters, run after each passed its own. */
	readonly refine?: Refinement;
	/** The `Accept` header. */
	readonly accept: string;
	/** The answer's byte ceiling; an answer over it is refused, not truncated. */
	readonly maxBytes: number;
	/** The TOTAL deadline of the call: resolve, connect, headers and body. */
	readonly timeoutMs: number;
	readonly answer: AnswerSpec;
	/**
	 * How long an answer is kept for an IDENTICAL question (milliseconds): the provider asks
	 * for its results to be cached. Absent: nothing is kept. The text door hands back no
	 * response headers, so a provider's own `Cache-Control` is replaced by this number.
	 */
	readonly keepAnswerMs?: number;
}

const KIB = 1024;

/**
 * How long a Nominatim answer is kept: an hour. The policy says results must be cached and
 * gives no duration; place names change slowly, and a cataloguer who re-runs a search, or a
 * client that re-sends one, is exactly the repeat the policy does not want at the provider.
 */
const NOMINATIM_KEEP_MS = 60 * 60_000;

// ---------------------------------------------------------------------------
// Shared parameter groups
// ---------------------------------------------------------------------------

/** A language list for `Accept-Language`-style parameters: `es`, `ca-ES,es`. */
const LANGUAGES = token(
	/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*(?:,[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*){0,4}$/,
	64,
);

const FLAG = choice(['0', '1']);

const LON: Range = [-180, 180];
const LAT: Range = [-90, 90];
/** A coordinate of a projected CRS, in metres: far beyond any place on Earth. */
const PROJECTED: Range = [-30_000_000, 30_000_000];

const BBOX = numbers([PROJECTED, PROJECTED, PROJECTED, PROJECTED]);

/** The CRS codes the WMS services read, and the unit their bounding box is in. */
const WMS_CRS: Readonly<Record<string, 'degrees' | 'metres'>> = Object.freeze({
	'CRS:84': 'degrees',
	'EPSG:3857': 'metres',
	'EPSG:25828': 'metres',
	'EPSG:25829': 'metres',
	'EPSG:25830': 'metres',
	'EPSG:25831': 'metres',
});

/** How big a box a service accepts, per unit of the CRS. */
interface SpanLimit {
	readonly degrees: number;
	readonly metres: number;
}

/** What is wrong with a box (inverted, or wider than `limit` allows in this CRS), or null. */
function boxProblem(crs: string, box: readonly number[], limit: SpanLimit): string | null {
	const [minX = 0, minY = 0, maxX = 0, maxY = 0] = box;
	if (minX >= maxX || minY >= maxY) return 'bbox must run from its minimum to its maximum corner';
	const ceiling = WMS_CRS[crs] === 'degrees' ? limit.degrees : limit.metres;
	const tooWide = maxX - minX > ceiling || maxY - minY > ceiling;
	return tooWide ? 'bbox is larger than the service accepts' : null;
}

/** The first number of a validated parameter (0 when it was not given). */
function firstNumber(read: ParamReader, name: string): number {
	return read(name)?.numbers[0] ?? 0;
}

/**
 * The cross-check of a WMS GetFeatureInfo: the box is a real box under the ceiling,
 * and the pixel (`i`, `j`) lies inside the `width` x `height` image.
 */
function featureInfoGeometry(limit: SpanLimit): Refinement {
	return (read) => {
		const inside = firstNumber(read, 'i') < firstNumber(read, 'width');
		if (!inside || firstNumber(read, 'j') >= firstNumber(read, 'height')) {
			return 'the pixel (i, j) must lie inside width x height';
		}
		return boxProblem(read('crs')?.key ?? '', read('bbox')?.numbers ?? [], limit);
	};
}

/** The cross-check of a WFS box query: a real box under the ceiling. */
function wfsBox(limit: SpanLimit): Refinement {
	return (read) => boxProblem(read('crs')?.key ?? '', read('bbox')?.numbers ?? [], limit);
}

/** The six parameters of a WMS GetFeatureInfo, the CRS from the given list. */
function featureInfoParams(crsCodes: readonly string[]): readonly ParamDef[] {
	return [
		required('crs', choice(crsCodes), 'CRS'),
		required('bbox', BBOX, 'BBOX'),
		required('width', integer(1, 2048), 'WIDTH'),
		required('height', integer(1, 2048), 'HEIGHT'),
		required('i', integer(0, 2047), 'I'),
		required('j', integer(0, 2047), 'J'),
	];
}

/** A WMS 1.3.0 GetFeatureInfo's fixed parameters on one layer, in the given info format. */
function featureInfoFixed(
	layer: string,
	infoFormat: string,
): readonly (readonly [string, string])[] {
	return [
		['SERVICE', 'WMS'],
		['VERSION', '1.3.0'],
		['REQUEST', 'GetFeatureInfo'],
		['LAYERS', layer],
		['QUERY_LAYERS', layer],
		['STYLES', ''],
		['FORMAT', 'image/png'],
		['INFO_FORMAT', infoFormat],
		['FEATURE_COUNT', '1'],
	];
}

/** The Catastro WFS' projected CRSs, as the URN the service reads. */
const CATASTRO_WFS_CRS: Readonly<Record<string, string>> = Object.freeze({
	'EPSG:25829': 'urn:ogc:def:crs:EPSG::25829',
	'EPSG:25830': 'urn:ogc:def:crs:EPSG::25830',
	'EPSG:25831': 'urn:ogc:def:crs:EPSG::25831',
});

/** A Catastro exception report that means the parcel or the area holds nothing. */
const CATASTRO_NOT_FOUND = matching(/not found|no se ha encontrado|no records found/i);

// ---------------------------------------------------------------------------
// The services
// ---------------------------------------------------------------------------

export const GEO_SERVICES = deepFreeze({
	// --- Nominatim ----------------------------------------------------------
	nominatim_search: {
		origin: 'nominatim',
		path: '/search',
		fixed: [['format', 'jsonv2']],
		params: [
			// Three characters at least: Nominatim forbids as-you-type search.
			required('q', text(3, 200)),
			optional('countrycodes', token(/^[a-z]{2}(?:,[a-z]{2}){0,9}$/, 29, 'lower')),
			optional('limit', integer(1, 10)),
			optional('viewbox', numbers([LON, LAT, LON, LAT])),
			optional('bounded', FLAG),
			optional('language', LANGUAGES, 'accept-language'),
			optional('addressdetails', FLAG),
		],
		accept: 'application/json',
		maxBytes: 256 * KIB,
		timeoutMs: 10_000,
		answer: { kind: 'json', shape: 'array' },
		keepAnswerMs: NOMINATIM_KEEP_MS,
	},
	nominatim_reverse: {
		origin: 'nominatim',
		path: '/reverse',
		fixed: [['format', 'jsonv2']],
		params: [
			required('lat', decimal(-90, 90)),
			required('lon', decimal(-180, 180)),
			optional('zoom', integer(0, 18)),
			optional('language', LANGUAGES, 'accept-language'),
			optional('addressdetails', FLAG),
		],
		accept: 'application/json',
		maxBytes: 64 * KIB,
		timeoutMs: 10_000,
		answer: { kind: 'json', shape: 'object', notFound: 'error_key' },
		keepAnswerMs: NOMINATIM_KEEP_MS,
	},

	// --- DARE (Digital Atlas of the Roman Empire) ----------------------------
	dare_search_modern: {
		origin: 'dare',
		path: '/api/geojson.php',
		fixed: [],
		params: [required('name', text(3, 100), 'mss')],
		accept: 'application/json',
		maxBytes: 512 * KIB,
		timeoutMs: 12_000,
		answer: { kind: 'json', shape: 'features' },
	},
	dare_search_ancient: {
		origin: 'dare',
		path: '/api/geojson.php',
		fixed: [],
		params: [required('name', text(3, 100), 'ass')],
		accept: 'application/json',
		maxBytes: 512 * KIB,
		timeoutMs: 12_000,
		answer: { kind: 'json', shape: 'features' },
	},
	dare_nearest: {
		origin: 'dare',
		path: '/api/geojson.php',
		fixed: [],
		params: [
			required('point', numbers([LON, LAT])),
			// How coarse the places may be (the atlas' own map zoom); without it, every kind.
			optional('zoom', integer(0, 22)),
			optional('count', integer(1, 20)),
		],
		accept: 'application/json',
		maxBytes: 512 * KIB,
		timeoutMs: 12_000,
		answer: { kind: 'json', shape: 'features' },
	},
	dare_place: {
		origin: 'dare',
		path: '/api/geojson.php',
		fixed: [['full', '1']],
		params: [required('id', token(/^[0-9]{1,9}$/, 9))],
		accept: 'application/json',
		maxBytes: 512 * KIB,
		timeoutMs: 12_000,
		answer: { kind: 'json', shape: 'features', notFound: 'empty_features' },
	},

	// --- Catastro (Spain) ------------------------------------------------------
	catastro_wms_featureinfo: {
		origin: 'catastro',
		path: '/cartografia/INSPIRE/spadgcwms.aspx',
		fixed: featureInfoFixed('CP.CadastralParcel', 'text/html'),
		params: featureInfoParams(['CRS:84', 'EPSG:3857', 'EPSG:25829', 'EPSG:25830', 'EPSG:25831']),
		refine: featureInfoGeometry({ degrees: 0.5, metres: 50_000 }),
		accept: 'text/html, text/xml;q=0.8',
		maxBytes: 64 * KIB,
		timeoutMs: 15_000,
		answer: { kind: 'markup', notFound: CATASTRO_NOT_FOUND },
	},
	catastro_wfs_parcel: {
		origin: 'catastro',
		path: '/INSPIRE/wfsCP.aspx',
		fixed: [
			['service', 'wfs'],
			['version', '2'],
			['request', 'getfeature'],
			['STOREDQUERY_ID', 'GetParcel'],
		],
		params: [
			// Fourteen characters name a parcel, twenty a property on it.
			required('refcat', token(/^[0-9A-Z]{14}(?:[0-9A-Z]{6})?$/, 20, 'upper')),
			required('crs', choice(Object.keys(CATASTRO_WFS_CRS), CATASTRO_WFS_CRS), 'srsname'),
		],
		accept: 'text/xml, application/xml;q=0.9',
		maxBytes: 256 * KIB,
		timeoutMs: 15_000,
		answer: { kind: 'markup', notFound: CATASTRO_NOT_FOUND },
	},
	catastro_wfs_parcels_bbox: {
		origin: 'catastro',
		path: '/INSPIRE/wfsCP.aspx',
		fixed: [
			['service', 'wfs'],
			['version', '2.0.0'],
			['request', 'GetFeature'],
			['typenames', 'CP:CadastralParcel'],
		],
		params: [
			required('crs', choice(Object.keys(CATASTRO_WFS_CRS), CATASTRO_WFS_CRS), 'srsname'),
			// In the CRS of `crs`: the provider reads the box in the CRS asked for.
			required('bbox', BBOX),
		],
		// Catastro does not allow massive downloads: a block, not a district.
		refine: wfsBox({ degrees: 0.01, metres: 1_000 }),
		accept: 'text/xml, application/xml;q=0.9',
		maxBytes: 1024 * KIB,
		timeoutMs: 20_000,
		answer: { kind: 'markup', notFound: CATASTRO_NOT_FOUND },
	},

	// --- IGN (Spain) -------------------------------------------------------------
	ign_admin_units_featureinfo: {
		origin: 'ign',
		path: '/wms-inspire/unidades-administrativas',
		fixed: [
			...featureInfoFixed('AU.AdministrativeUnit', 'application/json'),
			// GeoServer's vendor parameter: without it the answer carries the unit's whole
			// polygon (about 170 KB for a city) that no caller of this service wants.
			['propertyName', 'inspireid,country,nationallevel,nationalcode,nameunit'],
		],
		params: featureInfoParams([
			'CRS:84',
			'EPSG:3857',
			'EPSG:25828',
			'EPSG:25829',
			'EPSG:25830',
			'EPSG:25831',
		]),
		refine: featureInfoGeometry({ degrees: 1, metres: 200_000 }),
		accept: 'application/json',
		maxBytes: 256 * KIB,
		timeoutMs: 15_000,
		answer: { kind: 'json', shape: 'features', notFound: 'empty_features' },
	},

	// --- open-elevation ----------------------------------------------------------
	open_elevation_lookup: {
		origin: 'open_elevation',
		path: '/api/v1/lookup',
		fixed: [],
		// The keyless allowance is counted in coordinates: a small cap per call.
		params: [required('locations', points(25))],
		accept: 'application/json',
		maxBytes: 64 * KIB,
		timeoutMs: 15_000,
		answer: { kind: 'json', shape: 'results' },
	},
} as const satisfies Record<string, GeoService>);

/** Every service id. */
export type GeoServiceId = keyof typeof GEO_SERVICES;

/** The service ids, in table order. */
export const GEO_SERVICE_IDS = Object.freeze(Object.keys(GEO_SERVICES)) as readonly GeoServiceId[];

/**
 * The service an id names, or null. Own keys of a STRING only: `__proto__`,
 * `constructor` and `toString` are not services, a URL is not one, and neither is a
 * value that merely reads as a key (`Object.hasOwn` converts an array or an object
 * with a `toString` into its key).
 */
export function geoServiceOf(id: unknown): GeoService | null {
	if (!isGeoServiceId(id)) return null;
	return (GEO_SERVICES as Readonly<Record<string, GeoService>>)[id] ?? null;
}

/** True when `id` names a service of the table. */
export function isGeoServiceId(id: unknown): id is GeoServiceId {
	return typeof id === 'string' && Object.hasOwn(GEO_SERVICES, id);
}
