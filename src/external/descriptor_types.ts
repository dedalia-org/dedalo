/**
 * EXTERNAL SERVICE MODEL — the descriptor every external record service is
 * declared as.
 *
 * Shape law (mirrors src/core/components/types.ts ComponentModel): an adapter
 * is DATA plus a handful of pure functions. It never opens a socket, never
 * reads config, never touches the DB — transport.ts owns the one outbound
 * door, config.ts owns the ontology-derived settings, cache.ts owns the
 * lifetimes. That is what makes "add a service" one file in services/ plus one
 * registry line, with no engine edit (services/README.md is the checklist).
 *
 * Everything optional here has a DEFAULT implemented in fields_map.ts
 * (extraction, row unwrapping, row picking, id codec). The defaults are the
 * general case — a flat top-level payload with an `id` key is the degenerate
 * one — so a nested-payload, opaque-id service (Wikidata `Q42` +
 * `labels.en.value`) is mappable by a cataloguer through fields_map alone.
 */

/** One decoded remote record, as the service returned it (no engine shaping). */
export type RemoteRow = Record<string, unknown>;

/**
 * WHAT LEAVES THE INSTALLATION on a request to this service. There is no
 * default: an adapter states its class, and the totality tripwire fails if it
 * does not.
 *
 *  - `record_identifiers` — only remote record ids, the language code and
 *    remote FIELD NAMES. Note that the id set is ITSELF a disclosure: it tells
 *    the remote service which records this institution holds, and at what rate
 *    they are being consulted.
 *  - `query_terms`  — free text a cataloguer typed (a search box).
 *  - `record_content` — data stored in this installation's own records. The
 *    heaviest class; nothing declares it today.
 */
export type ExternalEgress = 'record_identifiers' | 'query_terms' | 'record_content';

/**
 * The LOCATOR contract. A remote id is stored as a section_id, so its textual
 * form must survive a round trip byte-for-byte.
 *
 *  - `numeric_string` — digits only, SIGNIFICANT LEADING ZEROS (Zenon's
 *    "001338683"). Never parse it as a number.
 *  - `opaque_token`   — any locator-safe token (Wikidata's "Q42").
 */
export type RemoteIdShape = 'numeric_string' | 'opaque_token';

/** How a credential is attached, once (and only once) the target is vetted. */
export type CredentialScheme = 'bearer' | 'header' | 'query';

/** What one formatted value is, and how the client is allowed to render it. */
export interface FormattedValue {
	readonly text: string;
	/** `markup` goes through the strict server-side allowlist sanitizer. */
	readonly kind: 'text' | 'markup';
	/**
	 * How many source items the formatter REFUSED because they have no canonical
	 * text form (an object where the map promised scalars). Absent = none.
	 *
	 * Same convention as the unformatted path (fields_map.ts coerceUnformatted):
	 * a refusal is COUNTED into `source_status.dropped_unrenderable`, never
	 * guessed — `String({})` writes "[object Object]" into a heritage record,
	 * which is a wrong value that looks like a real one. A format must not be a
	 * hole in a rule the rest of the emission enforces.
	 */
	readonly refused?: number;
}

/** A named value formatter declared by an adapter (fields_map `format`). */
export type ExternalFormat = (raw: unknown) => FormattedValue;

/** A fully-built outbound request. The adapter decides the method; transport obeys it. */
export interface ExternalRequestSpec {
	readonly url: string;
	readonly method: 'GET' | 'POST';
	readonly body?: string;
	readonly contentType?: string;
	readonly accept?: string;
}

/** Everything an adapter may use to build a single-record request. */
export interface ExternalRecordRequestContext {
	readonly apiUrl: string;
	readonly remoteId: string;
	/** The REQUEST's data lang (`lg-…`), read at call time — never module-captured. */
	readonly dataLang: string;
	/** Remote field NAMES the caller needs, in declaration order. */
	readonly remoteFields: readonly string[];
}

/**
 * Everything an adapter may use to build a SEARCH request.
 *
 * IMPLEMENTED 2026-08-06 (`WC-2026-08-06-external-search-request`). Until then
 * the search endpoint was called DIRECTLY FROM THE BROWSER by
 * service_autocomplete.js, which bypassed every control in
 * engineering/EXTERNAL_SPEC.md §5 and, since the XSS-02 CSP landed, was blocked
 * by the app's own `connect-src`. The engine asks now.
 *
 * `limit`/`offset` come from the CALLER — the browser engine froze `limit: 20`
 * as a literal, so paging a result set was not expressible at all.
 */
export interface ExternalSearchRequestContext {
	readonly apiUrlSearch: string;
	/**
	 * The terms a cataloguer typed. Egress class `query_terms` or heavier, which
	 * is why this context is a DIFFERENT type from the record one: a record
	 * request has nowhere to put a term, so it cannot leak one by accident.
	 * NEVER empty — the facade refuses an empty query before any socket, and an
	 * adapter refuses it again (defence in depth).
	 */
	readonly terms: readonly string[];
	readonly dataLang: string;
	readonly remoteFields: readonly string[];
	/** Rows wanted. Caller-driven; the facade clamps nothing and refuses excess. */
	readonly limit: number;
	/** Rows to skip. 0 on the first page — an adapter that cannot express a
	 * non-zero offset must REFUSE it, never silently answer page one. */
	readonly offset: number;
}

/**
 * What `unwrapSearch` decodes a search payload into: the rows, plus the
 * remote's own count of the WHOLE result set.
 *
 * `total` is `null` when the service gives none — never 0 and never
 * `rows.length`. "The service did not say how many there are" and "there are
 * none" are different facts, and a paginator that confuses them either hides
 * pages that exist or offers pages that do not.
 */
export interface ExternalSearchPayload {
	readonly rows: readonly RemoteRow[];
	readonly total: number | null;
}

/**
 * What the service can do. A caller consults this and REFUSES loudly when the
 * capability is absent — it never silently degrades (an unordered list quietly
 * served as an ordered one is a wrong answer that looks right).
 */
export interface ExternalServiceCapabilities {
	/** The service can return rows in a caller-chosen order. */
	readonly ordering: boolean;
	/** The service accepts offset/limit paging. */
	readonly pagination: boolean;
	/** Values from this service may back a section_list column. */
	readonly listColumns: boolean;
	/** The service exposes a search endpoint at all. */
	readonly search: boolean;
}

export interface ExternalServiceModel {
	/** The service name. MUST equal api_config.entity and the request_config api_engine. */
	readonly service: string;
	/** What leaves on a RECORD request. See `searchEgress` for the search path. */
	readonly egress: ExternalEgress;
	/**
	 * What leaves on a SEARCH request — a SEPARATE declaration, because the two
	 * paths disclose different things and one field cannot be honest about both.
	 * A record fetch sends ids the install already holds; a search sends free
	 * text a cataloguer typed, which is strictly heavier and must never be
	 * covered by the record class by accident.
	 *
	 * REQUIRED whenever `buildSearchRequest` is declared, and it must be
	 * `query_terms` or heavier — `external_egress_tripwire` fails otherwise.
	 * Absent when the adapter implements no search.
	 */
	readonly searchEgress?: ExternalEgress;
	readonly remoteIdShape: RemoteIdShape;
	readonly capabilities: ExternalServiceCapabilities;

	/** Build the one-record request. Required — this is the reason an adapter exists. */
	buildRecordRequest(context: ExternalRecordRequestContext): ExternalRequestSpec;

	/** Build a search request. Absent ⇒ server-side search is unported for this service. */
	buildSearchRequest?(context: ExternalSearchRequestContext): ExternalRequestSpec;
	/**
	 * Decode a search payload into rows + the remote's total. Absent ⇒ same as
	 * above. Reads the payload through the section's `response_map`, exactly as
	 * `unwrapRows` does for a record answer — one indirection, declared once in
	 * the ontology, for both paths.
	 */
	unwrapSearch?(payload: unknown, responseMap: ResponseMap): ExternalSearchPayload;

	/** Decode a record payload into rows. Default: `defaultUnwrapRows` (fields_map.ts). */
	unwrapRows?(payload: unknown, responseMap: ResponseMap): readonly RemoteRow[];

	/**
	 * Choose the row that IS the requested record. Default: the row whose
	 * encoded id equals `remoteId`, else null — never a blind first element.
	 * (v6 reduced the array and could not tell a multi-hit response from a
	 * single hit; a non-matching multi-row answer is `not_found`.)
	 */
	pickRow?(rows: readonly RemoteRow[], remoteId: string): RemoteRow | null;

	/** Where the row carries its own id, for the default `pickRow`. Default `'id'`. */
	readonly remoteIdPath?: string;

	/** Storage form → wire form. Default: identity after shape validation. */
	encodeRemoteId?(rawId: string): string;
	/** Wire form → storage form. Must round-trip with `encodeRemoteId`. */
	decodeRemoteId?(token: string): string;

	/**
	 * May a remote field NAME (a fields_map path head) appear in a request to this
	 * service? Default: every name. An adapter that splices names into a URL
	 * declares its grammar here, so the SECTION-WIDE record field set
	 * (record_fields.ts) can leave a refused name out instead of carrying it into
	 * every component's request — one component's cataloguing error then makes
	 * THAT component `misconfigured` (value.ts), never the whole record
	 * `unavailable`. `buildRecordRequest` keeps its own refusal as the last line.
	 */
	acceptsRemoteField?(field: string): boolean;

	/** Pull a value out of a row. Default: the dotted/indexed path resolver. */
	extract?(row: RemoteRow, remotePath: string): unknown;

	/** Named formatters a fields_map entry may reference by `format`. */
	readonly formats?: Readonly<Record<string, ExternalFormat>>;
	/**
	 * A format whose SEARCH rendering differs from its record rendering: record
	 * `format` name → the name of the format a search cell (the autocomplete
	 * dropdown, `formatExternalSearchData`) applies INSTEAD. Both names must be
	 * in `formats` (external_registry_totality_tripwire). The one case today:
	 * zenon `zenon_authors` → `zenon_author_names` (owner C55 — a dropdown shows
	 * who wrote it, not the API's role keys; the record keeps the roles).
	 * Chosen in engine code, never in the ontology: a cataloguer declares ONE
	 * format and gets both renderings.
	 */
	readonly searchFormats?: Readonly<Record<string, string>>;

	/**
	 * The config KEY NAME holding this service's credential — never a value, and
	 * never read from the ontology (which is editable data).
	 */
	readonly credentialCatalogKey?: string;
	readonly credentialScheme?: CredentialScheme;
	/** Header name (`header`) or query parameter name (`query`). */
	readonly credentialParam?: string;

	/** The human-facing page for a record, built from api_config.ui_base_url. */
	uiRecordUrl?(uiBaseUrl: string, remoteId: string): string;

	/** Per-service overrides of the operator's defaults (all optional). */
	readonly timeoutMs?: number;
	readonly retry?: number;
	readonly softTtlMs?: number;
}

/** api_config.response_map: local name → remote payload key. */
export type ResponseMap = readonly { readonly local: string; readonly remote: string }[];

/** One parsed fields_map row (only `local === 'dato'` rows carry a value). */
export interface FieldsMapEntry {
	readonly local: string;
	readonly remote: string;
	readonly format?: string;
}
