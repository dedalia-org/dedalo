/**
 * ZENON — the DAI (Deutsches Archäologisches Institut) bibliographic catalogue.
 *
 * The one adapter that exists today, and the worked example services/README.md
 * points at. It is DATA plus pure functions: no socket, no config read, no DB.
 *
 * REQUEST FORM. Reproduced from the FROZEN v7 PHP
 * (v7_php_frozen/…/core/component_external/entities/class.zenon.php), which had
 * already diverged from v6:
 *
 *     <api_url>?id=<id>&lgn=<alpha2>[&field[]=<f>…]
 *
 * with `lgn` defaulting to `en` when the Dédalo lang code has no ISO 639-1
 * mapping (v6 emitted an empty `&lgn=&`), and the field segment OMITTED
 * ENTIRELY when no fields are requested (no dangling `&`). The literal
 * `field[]=` is why this is assembled as a string rather than through
 * URLSearchParams, which would percent-encode the brackets and change the
 * bytes. Injection is closed at the source instead: the id must match the
 * declared `numeric_string` shape and every field name must be a bare
 * identifier, both refused loudly before they reach the string.
 *
 * IDs are zero-padded strings ("001338683"). The codec is the identity, and
 * that is the whole point — parsing one as a number would silently rewrite the
 * locator of every record in the section.
 *
 * SEARCH REQUEST FORM (implemented 2026-08-06,
 * `WC-2026-08-06-external-search-request`). Reproduced from the browser engine
 * that used to issue it directly — VuFind's search API, POST with the query in
 * the QUERY STRING and no body:
 *
 *     POST <api_url_search>?lookfor=<q>&type=AllFields&sort=relevance
 *          &limit=<n>[&page=<p>]&prettyPrint=false&lng=<alpha2>[&field[]=<f>…]
 *
 * Three things the browser did are carried over but made honest:
 *
 *  - `lng` was the hard-coded literal `de`. It is now derived from the REQUEST's
 *    data lang through the same alpha-2 helper and the same `en` default as the
 *    record path, so a Spanish cataloguer stops getting German labels.
 *  - the EMPTY-QUERY SENTINEL (a seven-enye nonsense literal) is GONE. It existed because
 *    Zenon answers an empty `lookfor` with its first ten records; a magic string
 *    that only works while a remote's tokeniser keeps failing to match it is not
 *    a contract. An empty query is refused here (and, before any socket, by the
 *    facade, which answers an empty result).
 *  - `limit` was frozen at 20. It comes from the caller now; `offset` too, via
 *    VuFind's 1-based `page`. An offset that is not a whole number of pages is
 *    REFUSED rather than rounded — VuFind cannot express it, and answering a
 *    neighbouring window is a wrong answer that looks right.
 *
 * As on the record path, the literal `field[]=` is why the query string is
 * assembled by hand; every VALUE is percent-encoded and every field name must be
 * a bare identifier.
 */

import { getAlpha2FromCode } from '../../core/resolve/lang_names.ts';
import type {
	ExternalRecordRequestContext,
	ExternalRequestSpec,
	ExternalSearchPayload,
	ExternalSearchRequestContext,
	ExternalServiceModel,
	FormattedValue,
	ResponseMap,
} from '../descriptor_types.ts';
import { ExternalServiceError } from '../errors.ts';
import { defaultUnwrapRows, remoteKeyFor } from '../fields_map.ts';

const SERVICE = 'zenon';

/** Zenon's `lgn` fallback when the Dédalo lang code has no ISO 639-1 mapping. */
const DEFAULT_ALPHA2 = 'en';

/** The separator PHP used for every multi-value Zenon format. */
const VALUE_SEPARATOR = ' | ';

/** A remote field name may only be a bare identifier (it is spliced into a URL). */
const FIELD_NAME = /^[A-Za-z0-9_]+$/;

function refuse(detail: string, remoteId?: string): never {
	throw new ExternalServiceError({
		service: SERVICE,
		kind: 'bad_config',
		...(remoteId === undefined ? {} : { remoteId }),
		detail,
	});
}

/**
 * `array_values` — PHP `implode(' | ', $row_data->{$name})`. Non-array input is
 * rendered as the single value it is (PHP would have fataled; refusing an
 * otherwise usable scalar helps nobody).
 *
 * OBJECTS ARE REFUSED, not stringified. A `format:'array_values'` entry pointed
 * at a field that turns out to hold objects is a one-word cataloguing error, and
 * `String(item)` would write "[object Object]" into a heritage record with
 * `degraded:false` and no `source_status` — a wrong value wearing a correct
 * value's clothes. The refusal is COUNTED and reaches the wire as
 * `dropped_unrenderable`, exactly as the unformatted path already does
 * (fields_map.ts coerceUnformatted).
 *
 * EMPTY ELEMENTS ARE DROPPED — a deliberate divergence from PHP's `implode`,
 * which keeps them ("213 p. | "). Ledgered in
 * engineering/wire_contract/WC-2026-08-05-external-entry-normalisation.md.
 */
function formatArrayValues(raw: unknown): FormattedValue {
	const items = Array.isArray(raw) ? raw : [raw];
	const renderable: string[] = [];
	let refused = 0;
	for (const item of items) {
		if (item === null || item === undefined || item === '') continue;
		if (typeof item === 'object') {
			refused++;
			continue;
		}
		renderable.push(String(item));
	}
	return {
		text: renderable.join(VALUE_SEPARATOR),
		kind: 'text',
		...(refused === 0 ? {} : { refused }),
	};
}

/**
 * `zenon_authors` — v6 PHP class.component_external.php:213-232. `authors` is
 * an object of role → { "Name": […] }:
 *
 *   for each NON-EMPTY role:  "<role>: " + KEYS of the role object joined ' - '
 *   the roles themselves joined ' | '
 *
 * "Empty" is PHP's `empty()`: an empty array/object/string is skipped, which is
 * why `secondary: []` and `corporate: []` contribute nothing. All roles empty →
 * `''`, which the emission drops as a missing value (T1-P06).
 *
 * Two deliberate divergences from v6 (which warned on a foreach over a scalar
 * and rendered garbage), ledgered in WC-2026-11-13-external-empty-entry-dropped:
 * a non-object `authors` (string, number, boolean, array) is REFUSED whole, and
 * a role holding a scalar is REFUSED (the other roles still render) — a lost
 * value is reported as `dropped_unrenderable`, never shown blank or as
 * `primary: 0 - 1 - 2`.
 */
function formatZenonAuthors(raw: unknown): FormattedValue {
	return formatAuthorRoles(raw, (role, names) => `${role}: ${names.join(' - ')}`, VALUE_SEPARATOR);
}

/**
 * `zenon_author_names` — the SEARCH rendering of the same `authors` object
 * (owner C55, 2026-11-13; `searchFormats` below): the NAMES of every non-empty
 * role joined ' - ', roles joined ' - ' too, no role labels — what the v6
 * browser formatter showed in the autocomplete dropdown ('Doe, J. - Roe, R. -
 * DAI'). A dropdown answers "who wrote it"; the API's role keys (`primary`,
 * `corporate`) are untranslated vocabulary that belongs to the record view,
 * which keeps `zenon_authors`. Same empty and refusal rules as `zenon_authors`
 * — the two renderings never disagree on WHAT is a value.
 */
function formatZenonAuthorNames(raw: unknown): FormattedValue {
	return formatAuthorRoles(raw, (_role, names) => names.join(' - '), ' - ');
}

/** The shared walk of a VuFind `authors` object: one text per non-empty role, joined. */
function formatAuthorRoles(
	raw: unknown,
	renderRole: (role: string, names: readonly string[]) => string,
	roleSeparator: string,
): FormattedValue {
	// Empty first: VuFind's json_encode writes an empty assoc array as `[]`, so a
	// record with no authors arrives as `authors: []` — missing, never refused.
	if (isPhpEmpty(raw)) return { text: '', kind: 'text' };
	if (!isPlainObject(raw)) return { text: '', kind: 'text', refused: 1 };
	const roles: string[] = [];
	let refused = 0;
	for (const [role, value] of Object.entries(raw)) {
		if (isPhpEmpty(value)) continue;
		if (typeof value !== 'object' || value === null) {
			refused++;
			continue;
		}
		// array_keys((array)$element): the NAMES are the keys of the role object.
		const names = Array.isArray(value)
			? value.map((_item, index) => String(index))
			: Object.keys(value);
		roles.push(renderRole(role, names));
	}
	return {
		text: roles.join(roleSeparator),
		kind: 'text',
		...(refused === 0 ? {} : { refused }),
	};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** PHP `empty()` for the shapes a JSON payload can produce. */
function isPhpEmpty(value: unknown): boolean {
	if (value === null || value === undefined || value === '' || value === 0 || value === false) {
		return true;
	}
	if (Array.isArray(value)) return value.length === 0;
	if (typeof value === 'object') return Object.keys(value as object).length === 0;
	return false;
}

function buildRecordRequest(context: ExternalRecordRequestContext): ExternalRequestSpec {
	const { apiUrl, remoteId, dataLang, remoteFields } = context;
	if (!/^[0-9]+$/.test(remoteId)) {
		refuse('remote id is not a Zenon numeric_string id', remoteId);
	}
	for (const field of remoteFields) {
		if (!FIELD_NAME.test(field)) refuse(`remote field name '${field}' is not a bare identifier`);
	}
	const langValue = getAlpha2FromCode(dataLang) ?? DEFAULT_ALPHA2;
	// Omit the whole segment when there are no fields — a trailing '&' would be
	// a different URL, and the frozen oracle does not emit one.
	const fieldsQuery =
		remoteFields.length === 0 ? '' : `&${remoteFields.map((f) => `field[]=${f}`).join('&')}`;
	return {
		url: `${apiUrl}?id=${remoteId}&lgn=${langValue}${fieldsQuery}`,
		method: 'GET',
		accept: 'application/json',
	};
}

/**
 * The response_map local name for the remote's own result count, and the key
 * VuFind actually uses when the ontology declares no mapping. Same indirection
 * as `ar_records`: the ontology may rename it, the adapter knows the default.
 */
const TOTAL_LOCAL_KEY = 'total';
const TOTAL_FALLBACK_KEY = 'resultCount';

/**
 * The FIXED query parameters, in the exact order and with the exact values the
 * browser engine sent. Reproduced deliberately rather than "cleaned up": this is
 * a live wire form against a third-party service, and the only evidence that any
 * of it is load-bearing is that it works.
 */
const SEARCH_TYPE = 'AllFields';
const SEARCH_SORT = 'relevance';

function buildSearchRequest(context: ExternalSearchRequestContext): ExternalRequestSpec {
	const { apiUrlSearch, terms, dataLang, remoteFields, limit, offset } = context;

	// The sentinel's replacement. An empty lookfor makes Zenon answer with its
	// first ten records, which a caller would render as "matches" — so the query
	// never leaves without terms. The facade refuses earlier, before any socket;
	// this is the adapter's own refusal, because an adapter is DATA and may be
	// called by something that skipped the facade.
	const lookfor = terms
		.map((term) => term.trim())
		.filter((term) => term.length > 0)
		.join(' ');
	if (lookfor === '')
		refuse('search query is empty — an empty lookfor asks Zenon for its first page');

	for (const field of remoteFields) {
		if (!FIELD_NAME.test(field)) refuse(`remote field name '${field}' is not a bare identifier`);
	}
	if (!Number.isInteger(limit) || limit <= 0)
		refuse(`search limit '${limit}' is not a positive integer`);
	if (!Number.isInteger(offset) || offset < 0)
		refuse(`search offset '${offset}' is not a non-negative integer`);
	// VuFind pages, it does not offset. A partial page is not expressible, and
	// silently serving the page the offset falls INSIDE would answer a different
	// window than the caller asked for.
	if (offset % limit !== 0) {
		refuse(
			`search offset ${offset} is not a whole number of pages of ${limit} — Zenon pages, it does not offset`,
		);
	}

	const langValue = getAlpha2FromCode(dataLang) ?? DEFAULT_ALPHA2;
	const page = offset / limit + 1;
	// Every VALUE percent-encoded; the keys are fixed ASCII identifiers and the
	// `field[]` literal stays verbatim (URLSearchParams would encode the brackets
	// and change the bytes VuFind matches on).
	const pairs = [
		`lookfor=${encodeURIComponent(lookfor)}`,
		`type=${encodeURIComponent(SEARCH_TYPE)}`,
		`sort=${encodeURIComponent(SEARCH_SORT)}`,
		`limit=${encodeURIComponent(String(limit))}`,
		// Omitted on the first page, so the byte form is IDENTICAL to the one the
		// browser engine has been sending — the only shape with field evidence.
		...(page === 1 ? [] : [`page=${encodeURIComponent(String(page))}`]),
		`prettyPrint=${encodeURIComponent('false')}`,
		`lng=${encodeURIComponent(langValue)}`,
	];
	const fieldsQuery =
		remoteFields.length === 0
			? ''
			: `&${remoteFields.map((f) => `field[]=${encodeURIComponent(f)}`).join('&')}`;
	return {
		url: `${apiUrlSearch}?${pairs.join('&')}${fieldsQuery}`,
		// POST with the query in the query string and NO body — what VuFind is
		// being asked for, and what the browser engine sent. `method` is re-checked
		// at the door (transport step 0) against the read-only verb set.
		method: 'POST',
		accept: 'application/json',
	};
}

/**
 * Search payload → rows + total, through the section's `response_map`.
 *
 * Rows use the SAME indirection as a record answer (`defaultUnwrapRows`, i.e.
 * the map's `ar_records` local, default `records`) — one declaration in the
 * ontology serves both endpoints, which is the whole point of the map.
 */
function unwrapSearch(payload: unknown, responseMap: ResponseMap): ExternalSearchPayload {
	const rows = defaultUnwrapRows(payload, responseMap);
	let total: number | null = null;
	if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
		const key = remoteKeyFor(responseMap, TOTAL_LOCAL_KEY) ?? TOTAL_FALLBACK_KEY;
		const raw = (payload as Record<string, unknown>)[key];
		// A non-integer, a negative, or an absent count is NO ANSWER — never
		// coerced to 0 and never replaced by rows.length (see ExternalSearchPayload).
		if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) total = raw;
	}
	return { rows, total };
}

export const zenon: ExternalServiceModel = {
	service: SERVICE,
	// Only ids, the lang code and field NAMES leave the installation. Note that
	// the id set is itself a disclosure of which records this install holds.
	egress: 'record_identifiers',
	// A SEARCH sends what a cataloguer typed. Strictly heavier than the record
	// path, and declared separately so neither class can cover for the other.
	searchEgress: 'query_terms',
	remoteIdShape: 'numeric_string',
	capabilities: {
		ordering: false, // the record endpoint answers one id; there is no order to choose
		// The RECORD path cannot page — and this flag is what the request_config
		// narrowing sites consult (relations/request_config/engine_select.ts), which
		// are all read-path questions about a locator array Dédalo already holds.
		// The SEARCH endpoint does page, through `limit`/`page`; that is the search
		// contract's own business and flipping this to `true` would answer a
		// different question with the wrong fact.
		pagination: false,
		listColumns: true, // zenon8 section_list already lists zenon3/4/5/6
		search: true, // /api/v1/search — and the engine uses it, since 2026-08-06
	},
	remoteIdPath: 'id',
	// The same grammar buildRecordRequest/buildSearchRequest enforce, declared so
	// the record field set leaves a refused name out (record_fields.ts).
	acceptsRemoteField: (field) => FIELD_NAME.test(field),
	buildRecordRequest,
	buildSearchRequest,
	unwrapSearch,
	formats: {
		array_values: formatArrayValues,
		zenon_authors: formatZenonAuthors,
		zenon_author_names: formatZenonAuthorNames,
	},
	// The autocomplete dropdown shows author NAMES, the record keeps the roles
	// (owner C55; WC-2026-08-06-external-search-request item 4, addendum 2026-11-13).
	searchFormats: { zenon_authors: 'zenon_author_names' },
	// Zenon's public API needs no credential today; the KEY NAME exists so that
	// adding one is config, not code. A value never comes from the ontology.
	credentialCatalogKey: 'DEDALO_EXTERNAL_ZENON_API_KEY',
	credentialScheme: 'bearer',
	uiRecordUrl: (uiBaseUrl, remoteId) => `${uiBaseUrl.replace(/\/+$/, '')}/${remoteId}`,
};
