/**
 * FACADE-VISIBLE TYPES for the external-record subsystem.
 *
 * Everything `src/core/**` is allowed to name lives here or is re-exported from
 * here by `api/index.ts`. Internals (transport, breaker, the per-service
 * adapters) are free to change shape as long as these hold.
 */

import type {
	ExternalServiceCapabilities,
	ExternalServiceModel,
	FormattedValue,
	RemoteRow,
	ResponseMap,
} from '../descriptor_types.ts';
import type { ExternalErrorKind } from '../errors.ts';

export type {
	ExternalServiceCapabilities,
	ExternalServiceModel,
	FormattedValue,
	RemoteRow,
	ResponseMap,
};

/** One section's fully-resolved external binding: what it is, and where it points. */
export interface ResolvedExternalService {
	readonly sectionTipo: string;
	readonly model: ExternalServiceModel;
	readonly apiConfig: ExternalApiConfig;
}

/**
 * The typed, credential-stripped, shape-validated form of a section's
 * `properties.api_config`. Nothing outside `config.ts` may build one — the
 * constructor IS the validation. NOT egress-vetted: `apiUrl` may name a host
 * outside the allowlist; egress is enforced only at the outbound door
 * (`fetchExternalJson` → `parseAllowedUrl`, `transport.ts`).
 */
export interface ExternalApiConfig {
	readonly entity: string;
	readonly apiUrl: string;
	readonly apiUrlSearch: string | null;
	readonly uiBaseUrl: string | null;
	readonly responseMap: ResponseMap;
}

/**
 * The api_config form that may reach a BROWSER — snake_case, because it is a
 * live client contract (component_portal.js concatenates `ui_base_url +
 * section_id`). The URLs the SERVER fetches (`api_url`, `api_url_search`) are
 * not part of it: no client code reads them (T2 S09-c). Built
 * ONLY by `publishApiConfig`; see its header for what the shaping guarantees.
 * Optional keys are ABSENT (never null) when the ontology declares none —
 * matching the raw echo the client has always seen.
 */
export interface PublishedApiConfig {
	readonly entity: string;
	readonly ui_base_url?: string;
	readonly response_map: ResponseMap;
}

/** One record the caller wants, plus the remote fields it needs from it. */
export interface ExternalRowTarget {
	readonly sectionTipo: string;
	/** The remote record id, in STORAGE form (the section_id — zero padding intact). */
	readonly remoteId: string;
	/**
	 * Remote field NAMES this caller needs, in declaration order. The row layer
	 * WIDENS them to the section's record field set (record_fields.ts — the id
	 * field + every field the section's component_external nodes map), so what a
	 * caller names here never fragments the request or the cache entry.
	 */
	readonly remoteFields: readonly string[];
}

/**
 * How much to trust the row that came back.
 *  - `ok`          fetched now, or served fresh from the row cache.
 *  - `stale`       served from a cache entry past its soft TTL (a refresh is
 *                  running behind the request, or the service is unreachable).
 *  - `not_found`   the service answered and the record is not in the answer.
 *  - `unavailable` nothing usable: disabled, refused, open circuit, or a
 *                  failure with no cached row to fall back on.
 */
export type ExternalRowStatus = 'ok' | 'stale' | 'not_found' | 'unavailable';

/** One remote record as the engine sees it, with its provenance attached. */
export interface ExternalRowView {
	readonly sectionTipo: string;
	readonly remoteId: string;
	readonly service: string;
	readonly row: RemoteRow | null;
	readonly status: ExternalRowStatus;
	/** Why, when `status` is not `ok`. Present exactly when something failed. */
	readonly reason?: ExternalErrorKind;
	/** Epoch ms the underlying row was fetched (0 when there is no row). */
	readonly fetchedAt: number;
	/**
	 * The remote fields the record was requested WITH (the section's record
	 * field set — record_fields.ts). A parked view is self-describing: a reader
	 * serves it to a component only when these cover the component's fields.
	 * Set on every view the row layer builds; absent only on a hand-built view.
	 */
	readonly remoteFields?: readonly string[];
}

/** What one component_external emits for one record. */
export interface ExternalEntriesResult {
	/** Always strings — a raw array/object never reaches the wire. */
	readonly entries: string[];
	/**
	 * Parallel to `entries`: how the CLIENT is allowed to render each one.
	 * Present only when some entry is `markup` (nothing formats markup today),
	 * so the ordinary emission is unchanged. Absent means "all text", and the
	 * client's default is textContent either way — the field can only ever
	 * WIDEN rendering, for values this subsystem already sanitised.
	 */
	readonly entries_kind?: ('text' | 'markup')[];
	/**
	 * Present whenever the values are not a plain fresh success: the row's
	 * status, plus what the emission ceilings did. Reported, never hidden.
	 */
	readonly source_status?: {
		readonly status: ExternalRowStatus;
		readonly reason?: ExternalErrorKind;
		/** Values dropped because the count ceiling was reached. */
		readonly dropped_over_count?: number;
		/** Values REFUSED because they exceeded the per-entry character ceiling. */
		readonly dropped_over_length?: number;
		/**
		 * Values REFUSED because they have no canonical text form (an object,
		 * mapped without a `format`). Guessing one writes `[object Object]` into
		 * a heritage record; the cataloguer must declare a format instead.
		 */
		readonly dropped_unrenderable?: number;
	};
}

/**
 * ONE hit of an external search: a remote row, plus the locator coordinates
 * that address it inside Dédalo.
 *
 * `remoteId` is the STORAGE form — the string that becomes a `section_id`, zero
 * padding intact. It has been through the adapter's id codec, so a hit is by
 * construction a record a caller can save a locator to.
 */
export interface ExternalSearchHit {
	readonly sectionTipo: string;
	readonly remoteId: string;
	readonly row: RemoteRow;
}

/** What one external search answered. */
export interface ExternalSearchResult {
	readonly service: string;
	readonly sectionTipo: string;
	readonly hits: readonly ExternalSearchHit[];
	/**
	 * The remote's own count of the WHOLE result set, or `null` when it gave
	 * none — never 0, never `hits.length`. "Unknown total" and "no matches" are
	 * different facts and a paginator must be able to tell them apart.
	 */
	readonly total: number | null;
	/** The page actually asked for (echoed, so a caller never has to assume). */
	readonly limit: number;
	readonly offset: number;
	/**
	 * Rows the service returned that carry no id this service's `remoteIdShape`
	 * accepts, and which therefore cannot be addressed by a locator. Dropped —
	 * and COUNTED, because a silently shorter page is the "silently narrow
	 * scope" failure.
	 */
	readonly dropped: number;
}

export type { ExternalErrorKind };
