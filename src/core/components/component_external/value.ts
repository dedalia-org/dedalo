/**
 * component_external VALUE DERIVATION — the one place a component_external's
 * strings come from, shared by the emit hook (emit.ts) and the flat-value path
 * (resolve/relation_list.ts, family 'external').
 *
 * THE MODEL. There is no stored value. A component_external's record IS the
 * remote record: the host row's `section_id` is the remote id (a zero-padded
 * STRING like '001338683' — never Number()'d, that drops the padding and asks
 * the service for a different record), the host section's ontology
 * `properties.api_config` says which service and where, and the COMPONENT's own
 * `properties.fields_map` says which remote fields become this component's
 * entries. All three are read here; the network is entirely
 * src/external/'s business, reached through its facade.
 *
 * NO SILENT BLANKS — the rule this module exists to keep. Every path that
 * cannot produce values says WHY, in a `source_status` block the client can
 * render. The failure modes are a matter of fact (the service is down, the
 * record was deleted upstream, the operator has not allowlisted the host), and
 * a cataloguer looking at an empty field must be able to tell them apart from
 * "this record genuinely has no author". v6 emitted nothing at all in every one
 * of these cases.
 *
 * WHY THE FACADE IS A DYNAMIC IMPORT (engineering/CONVENTIONS.md): `src/core`
 * and `src/external` are peers, and a STATIC value edge from core into the
 * external subsystem would fuse them into one import component — the S2-20
 * defect class. The type import is static (erased, and the SCC gate excludes
 * `import type`); the value import is lazy, so a core module that never touches
 * an external section never loads the subsystem at all.
 */

import type {
	ExternalEntriesResult,
	ExternalErrorKind,
	ExternalRowView,
	FetchExternalRowsOptions,
} from '../../../external/api/index.ts';
import type { EmissionContext } from '../../resolve/component_data.ts';

// ---------------------------------------------------------------------------
// The wire field
// ---------------------------------------------------------------------------

/**
 * The provenance of a derived value, on the wire.
 *
 * `state` is a CLOSED set — the client switches on it — and `label_key` is a
 * key into the labels catalog (src/core/labels/master.json), never prose: the
 * message a user reads must be translatable, and the server does not know the
 * user's application language at this depth.
 *
 * `state: 'ok'` NEVER reaches the wire: a plain fresh success omits the whole
 * field, so the happy path stays byte-identical to what a caller would emit
 * with no provenance at all. The one nuance is a fresh row whose values hit an
 * emission ceiling — the row is 'ok' but something WAS dropped, so the field is
 * emitted with the drop counters (see `externalSourceStatus`).
 */
export interface ExternalSourceStatus {
	/** The external service name (registry key), or 'unknown' before resolution. */
	readonly service: string;
	readonly state: ExternalSourceState;
	/** Labels-catalog KEY (never prose) — the client localizes it. */
	readonly label_key: string;
	/** Whether trying again later can plausibly succeed. */
	readonly retryable: boolean;
	/** Epoch ms the served row was fetched. Present when state === 'stale'. */
	readonly stale_since?: number;
	/** Values cut because the per-component count ceiling was reached. */
	readonly dropped_over_count?: number;
	/** Values REFUSED because they exceeded the per-entry character ceiling. */
	readonly dropped_over_length?: number;
	/** Values REFUSED because they have no canonical text form (see fields_map.ts). */
	readonly dropped_unrenderable?: number;
}

export type ExternalSourceState =
	| 'ok'
	| 'stale'
	| 'unavailable'
	| 'timeout'
	| 'not_found'
	| 'circuit_open'
	| 'disabled'
	| 'misconfigured';

/**
 * state → labels-catalog key. Every non-'ok' state HAS one (the tripwire
 * asserts both that the map is total and that each key exists in master.json);
 * 'ok' has none because 'ok' never reaches the wire.
 */
export const EXTERNAL_STATE_LABEL_KEY: Readonly<Record<ExternalSourceState, string | null>> = {
	ok: null,
	stale: 'external_source_stale',
	unavailable: 'external_source_unavailable',
	timeout: 'external_source_timeout',
	not_found: 'external_source_not_found',
	circuit_open: 'external_source_circuit_open',
	disabled: 'external_source_disabled',
	misconfigured: 'external_source_misconfigured',
};

/**
 * Whether a later attempt can plausibly succeed. The three FALSE states are the
 * ones where waiting changes nothing: the record is not there ('not_found'), an
 * operator turned the service off ('disabled'), or the ontology/settings are
 * wrong ('misconfigured'). A client may use this to decide whether to offer a
 * retry — offering one for a misconfiguration is how a user ends up hammering a
 * host that will never answer.
 */
export const EXTERNAL_STATE_RETRYABLE: Readonly<Record<ExternalSourceState, boolean>> = {
	ok: false,
	stale: true,
	unavailable: true,
	timeout: true,
	not_found: false,
	circuit_open: true,
	disabled: false,
	misconfigured: false,
};

// ---------------------------------------------------------------------------
// Per-read seams (EmissionContext.scratch — never module state)
// ---------------------------------------------------------------------------

/**
 * Rows a CALLER already fetched for this read, keyed by
 * `${section_tipo}|${remote_id}` (the facade's `externalRowViewKey`). The
 * portal/section wiring batches a page's records into ONE fan-out and parks the
 * result here; a hook that finds its row here issues no request.
 *
 * Nothing is REQUIRED to prefetch — a direct read of an external section, a
 * section_list cell, an indexation cell and resolve_data all arrive with an
 * empty scratch, and the derivation falls back to fetching its own row rather
 * than emitting a blank. The prefetch is a batching optimisation, never a
 * precondition.
 */
const PREFETCHED_ROW_VIEWS = Symbol('external.prefetched_row_views');

/**
 * The remote FIELDS each parked section's rows were fetched with, when the
 * parker declared them (`setPrefetchedExternalRows`'s third argument). A parked
 * row is served to a component ONLY if it was fetched with every field that
 * component's fields_map reads — a row fetched for {title} handed to a
 * component reading {author} would render a SILENT BLANK (the v6 defect the
 * cache key's field signature exists to prevent). A parker that PREDICTS its
 * consumers (the export walk's batch prefetch, diffusion/export/
 * external_prefetch.ts) declares the fields, so a wrong prediction costs one
 * fallback fetch, never a wrong value. Absent = the parker fetched for exactly
 * the components it expands (the portal prepass) and the rows are served as is.
 * A view that names its own `remoteFields` (every view the row layer builds,
 * since 2026-09-24 the section's whole record field set) is checked against
 * THOSE instead — the declaration is only the fallback for hand-built views.
 */
const PREFETCHED_ROW_FIELDS = Symbol('external.prefetched_row_fields');

/**
 * Transport seams for THIS read. TEST-ONLY: the setter is exported for tests
 * that must drive the whole hook without a socket, and
 * `external_degradation_tripwire` asserts nothing under `src/` or `tools/`
 * calls it. Per-READ scratch rather than module state, so two concurrent
 * requests can never see each other's seam (the S2-11 defect class).
 */
const TRANSPORT_DEPS = Symbol('external.transport_deps');

/**
 * Park a batch of already-fetched rows for this read (the wiring stage's door).
 * REPLACES whatever was parked (a batch-scoped parker keeps the scratch bounded
 * to one batch). `fieldsBySection` — section tipo → the remote fields its rows
 * were fetched with — arms the coverage check (PREFETCHED_ROW_FIELDS); omitted,
 * any previously declared coverage is cleared with the rows it described.
 */
export function setPrefetchedExternalRows(
	emission: EmissionContext,
	views: ReadonlyMap<string, ExternalRowView>,
	fieldsBySection?: ReadonlyMap<string, ReadonlySet<string>>,
): void {
	emission.scratch.set(PREFETCHED_ROW_VIEWS, views);
	if (fieldsBySection === undefined) emission.scratch.delete(PREFETCHED_ROW_FIELDS);
	else emission.scratch.set(PREFETCHED_ROW_FIELDS, fieldsBySection);
}

/**
 * ADD a batch to what this read already has parked. The portal prepass
 * (relations/relation_core.ts) runs once per expansion and a read expands many
 * portals, including nested ones — a plain `set` would throw away the outer
 * expansion's rows and make the inner one re-fetch them. Later batches win on a
 * key collision (they are the fresher answer for the same record).
 */
export function mergePrefetchedExternalRows(
	emission: EmissionContext,
	views: ReadonlyMap<string, ExternalRowView>,
): void {
	if (views.size === 0) return;
	const existing = emission.scratch.get(PREFETCHED_ROW_VIEWS) as
		| ReadonlyMap<string, ExternalRowView>
		| undefined;
	emission.scratch.set(
		PREFETCHED_ROW_VIEWS,
		existing === undefined ? views : new Map([...existing, ...views]),
	);
}

/**
 * The transport seams a TEST parked on this read, for the batching prepass —
 * which must drive the same stubbed fetch the per-component fallback does, or a
 * test would silently exercise only one of the two paths. Production reads
 * `undefined` here (nothing under src/ sets it; external_degradation_tripwire
 * asserts that).
 */
export function externalTransportDepsForRead(
	emission: EmissionContext | undefined,
): FetchExternalRowsOptions['deps'] {
	return emission?.scratch.get(TRANSPORT_DEPS) as FetchExternalRowsOptions['deps'] | undefined;
}

/** TEST SEAM — see TRANSPORT_DEPS. Production never calls this. */
export function setExternalTransportDepsForTests(
	emission: EmissionContext,
	deps: FetchExternalRowsOptions['deps'],
): void {
	emission.scratch.set(TRANSPORT_DEPS, deps);
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/** What one component_external shows for one record, plus its provenance. */
export interface DerivedExternalValue {
	readonly entries: string[];
	/**
	 * Parallel to `entries`: 'text' (render with textContent) or 'markup'
	 * (already reduced to bare allowlisted tags by the subsystem's sanitizer,
	 * so the client may parse it). Absent = all text, which is every live read
	 * today — see external/api/types.ts ExternalEntriesResult.entries_kind.
	 */
	readonly entries_kind?: ('text' | 'markup')[];
	/** Absent exactly when the values are a plain, complete, fresh success. */
	readonly source_status?: ExternalSourceStatus;
}

export interface DeriveExternalOptions {
	/** The read's emission context, when there is one (prefetch + test seams). */
	readonly emission?: EmissionContext;
	/**
	 * The data lang the remote row is fetched in, when the CALLER fixes it (a
	 * publication run: one lang per run, never the trigger's — T1-42). Absent =
	 * the request's ambient data lang (the facade's own backstop).
	 */
	readonly dataLang?: string;
}

/**
 * Derive one component_external's entries for one record.
 *
 * A FOREIGN TARGET IS NOT A FAILURE. A component_external belongs to ONE
 * section — its ontology owner (see externalComponentAppliesTo). A target in any
 * other section (a local rsc205 publication sharing the rsc368 portal with its
 * zenon1 locators) answers `{ entries: [] }` with NO remote call and NO
 * `source_status`: the column does not apply to that record, exactly as a stored
 * component resolves to nothing on a record that does not carry it. The TARGET
 * section's own `api_config` is never consulted for that decision — rsc205
 * carries a stale 2024 copy, and consulting it sent the LOCAL id to Zenon (a
 * 400 per target, three of which opened the breaker for every Zenon lookup; a
 * padded local id would have fetched an UNRELATED remote record).
 *
 * NEVER THROWS. Every failure — a section with no api_config, a service no
 * adapter implements, a malformed fields_map, a blocked host, a dead remote —
 * becomes an empty `entries` plus a `source_status` naming the state. Throwing
 * here would blank the WHOLE record's read for one degraded field, which is the
 * opposite of the degradation posture: the record must render, with the gap
 * visible and explained.
 */
export async function deriveExternalValue(
	componentTipo: string,
	sectionTipo: string,
	/** The remote id in STORAGE form — the host row's section_id, verbatim. */
	remoteId: string,
	options: DeriveExternalOptions = {},
): Promise<DerivedExternalValue> {
	const api = await import('../../../external/api/index.ts');
	let service = 'unknown';
	try {
		const applies = await externalComponentAppliesTo(componentTipo, sectionTipo);
		if (applies === 'foreign') return { entries: [] };
		if (applies === 'orphan') {
			// A component_external whose parent chain reaches no section: nothing
			// says which records it describes. A configuration error, named.
			return misconfigured(service);
		}
		if (!/^[^|]+$/.test(remoteId) || remoteId.length === 0) {
			// An id carrying the row-view key separator (or none at all) addresses no
			// remote record. Refusing here keeps the key grammar unambiguous.
			return misconfigured(service);
		}
		const resolved = await api.getExternalServiceForSection(sectionTipo);
		if (resolved === null) {
			// A component_external outside an external section: the ontology declares
			// a remote-valued component in a section that names no service. Nothing
			// can be fetched, and the cataloguer must be told which of the two is wrong.
			return misconfigured(service);
		}
		service = resolved.model.service;

		const { getPropertiesByTipo } = await import('../../ontology/resolver.ts');
		const properties = (await getPropertiesByTipo(componentTipo)) as {
			fields_map?: unknown;
		} | null;
		const fieldsMap = api.parseFieldsMap(properties?.fields_map, { tipo: componentTipo });
		if (fieldsMap.length === 0) {
			// No mapping = no way to know which remote fields this component shows.
			// v6 rendered an empty component; this says why.
			return misconfigured(service);
		}
		// A remote field name the ADAPTER refuses (Zenon: bare identifiers only —
		// 'dc:title'). The section's shared record request leaves it out
		// (record_fields.ts), so the rest of the record still renders; THIS
		// component is the one misconfigured, and says so — logged (deduped by
		// the door, the same line the search path logs) so the operator sees
		// WHICH name, never fetched.
		if (
			api.reportRefusedRemoteFields(resolved.model, componentTipo, sectionTipo, fieldsMap).length >
			0
		) {
			return misconfigured(service);
		}

		const rowView =
			prefetchedRow(
				options.emission,
				api.externalRowViewKey(sectionTipo, remoteId),
				sectionTipo,
				api.remoteFieldsOf(fieldsMap),
			) ?? (await fetchOwnRow(api, sectionTipo, remoteId, fieldsMap, options));

		return toDerived(service, api.mapRowToEntries(resolved.model, rowView, fieldsMap), rowView);
	} catch (error) {
		// Classified failures are already logged by the subsystem; an UNCLASSIFIED
		// one is loud here (CONVENTIONS §1) and still degrades rather than throws.
		const kind = (error as { kind?: ExternalErrorKind } | null)?.kind;
		if (kind === undefined) {
			console.error(
				`[external:${service}] unexpected failure deriving ${componentTipo} of ${sectionTipo}/${remoteId}`,
				error,
			);
			return statusOnly(service, 'unavailable');
		}
		return statusOnly(service, stateForKind(kind));
	}
}

/**
 * THE OWNERSHIP RULE — whether a component_external resolves at all for a record
 * of `targetSectionTipo`. Decided from the ONTOLOGY, never from the target's
 * `api_config`:
 *
 *   'owner'   the target IS the component's owning section (the first `section`
 *             on its dd_ontology parent chain — zenon3 → zenon1, test215 →
 *             test3), or a VIRTUAL section whose real section is that owner
 *             (getSectionRealTipo — a virtual section borrows its real
 *             section's children, so their records carry the same components);
 *   'foreign' any other section — the column does not apply to the record;
 *   'orphan'  the component's chain reaches no section at all.
 *
 * Cached underneath (both accessors are hub-cleared ontology caches), so the
 * per-cell cost on a hot export is two map hits.
 */
export async function externalComponentAppliesTo(
	componentTipo: string,
	targetSectionTipo: string,
): Promise<'owner' | 'foreign' | 'orphan'> {
	const { getAncestorSectionTipo, getSectionRealTipo } = await import('../../ontology/resolver.ts');
	const owner = await getAncestorSectionTipo(componentTipo);
	if (owner === null) return 'orphan';
	if (owner === targetSectionTipo) return 'owner';
	return (await getSectionRealTipo(targetSectionTipo)) === owner ? 'owner' : 'foreign';
}

function prefetchedRow(
	emission: EmissionContext | undefined,
	viewKey: string,
	sectionTipo: string,
	neededFields: readonly string[],
): ExternalRowView | null {
	const parked = emission?.scratch.get(PREFETCHED_ROW_VIEWS) as
		| ReadonlyMap<string, ExternalRowView>
		| undefined;
	const view = parked?.get(viewKey);
	if (view === undefined) return null;
	const fetchedWith = parkedViewFields(emission, view, sectionTipo);
	// Undefined = nothing says what it was fetched with (the old portal-prepass
	// shape): served as parked.
	if (fetchedWith === undefined) return view;
	return neededFields.every((field) => fetchedWith.has(field)) ? view : null;
}

/**
 * The fields a parked view is KNOWN to cover. A SELF-DESCRIBING view (every
 * view the row layer builds names the fields it was requested with — the
 * section's record field set) answers for itself: the truth beats a parker's
 * prediction. Otherwise the parker's declared coverage for the section (an
 * empty set when it declared coverage but not for this section — never
 * served), or undefined when nothing was declared at all.
 */
function parkedViewFields(
	emission: EmissionContext | undefined,
	view: ExternalRowView,
	sectionTipo: string,
): ReadonlySet<string> | undefined {
	if (view.remoteFields !== undefined) return new Set(view.remoteFields);
	const coverage = emission?.scratch.get(PREFETCHED_ROW_FIELDS) as
		| ReadonlyMap<string, ReadonlySet<string>>
		| undefined;
	if (coverage === undefined) return undefined;
	return coverage.get(sectionTipo) ?? new Set<string>();
}

/** The FALLBACK: no caller prefetched this row, so fetch it (coalesced + cached). */
async function fetchOwnRow(
	api: typeof import('../../../external/api/index.ts'),
	sectionTipo: string,
	remoteId: string,
	fieldsMap: Parameters<typeof api.mapRowToEntries>[2],
	options: DeriveExternalOptions,
): Promise<ExternalRowView> {
	const deps = externalTransportDepsForRead(options.emission);
	const views = await api.fetchExternalRows(
		[{ sectionTipo, remoteId, remoteFields: api.remoteFieldsOf(fieldsMap) }],
		{
			...(deps === undefined ? {} : { deps }),
			...(options.dataLang === undefined ? {} : { dataLang: options.dataLang }),
		},
	);
	const view = views.get(api.externalRowViewKey(sectionTipo, remoteId));
	if (view === undefined) {
		// fetchExternalRows answers every target it is given; a missing view would
		// be an engine bug, not a remote failure. Loud, and still degraded.
		throw new Error(
			`deriveExternalValue: no row view for ${sectionTipo}/${remoteId} (facade contract broken)`,
		);
	}
	return view;
}

/** Map the subsystem's row status + error kind onto the wire state. */
export function stateForRowView(rowView: ExternalRowView): ExternalSourceState {
	if (rowView.status === 'ok') return 'ok';
	if (rowView.status === 'stale') return 'stale';
	if (rowView.status === 'not_found') return 'not_found';
	return rowView.reason === undefined ? 'unavailable' : stateForKind(rowView.reason);
}

/**
 * error kind → wire state. The kinds a USER can act on get their own state
 * (retry later / call the operator); the rest collapse to 'unavailable', whose
 * label says exactly that. Total over ExternalErrorKind — the tripwire asserts it.
 */
export function stateForKind(kind: ExternalErrorKind): ExternalSourceState {
	switch (kind) {
		case 'disabled':
			return 'disabled';
		case 'not_registered':
		case 'bad_config':
		case 'blocked_host':
			return 'misconfigured';
		case 'circuit_open':
			return 'circuit_open';
		case 'timeout':
			return 'timeout';
		case 'not_found':
			return 'not_found';
		case 'transport':
		case 'http_status':
		case 'too_large':
		case 'protocol':
			return 'unavailable';
	}
}

/** Build the wire status for a state (+ optional row/ceiling detail). */
export function externalSourceStatus(
	service: string,
	state: ExternalSourceState,
	detail: {
		readonly staleSince?: number;
		readonly droppedOverCount?: number;
		readonly droppedOverLength?: number;
		readonly droppedUnrenderable?: number;
	} = {},
): ExternalSourceStatus | null {
	const dropped =
		(detail.droppedOverCount ?? 0) +
		(detail.droppedOverLength ?? 0) +
		(detail.droppedUnrenderable ?? 0);
	// 'ok' with nothing dropped is the happy path: no field at all.
	if (state === 'ok' && dropped === 0) return null;
	const labelKey = EXTERNAL_STATE_LABEL_KEY[state];
	return {
		service,
		state,
		// 'ok'-with-drops still needs a key; the drops ARE the message.
		label_key: labelKey ?? 'external_source_truncated',
		retryable: EXTERNAL_STATE_RETRYABLE[state],
		...(state === 'stale' && detail.staleSince !== undefined
			? { stale_since: detail.staleSince }
			: {}),
		...(detail.droppedOverCount ? { dropped_over_count: detail.droppedOverCount } : {}),
		...(detail.droppedOverLength ? { dropped_over_length: detail.droppedOverLength } : {}),
		...(detail.droppedUnrenderable ? { dropped_unrenderable: detail.droppedUnrenderable } : {}),
	};
}

/** The subsystem's entries result + row view → the wire value. */
function toDerived(
	service: string,
	result: ExternalEntriesResult,
	rowView: ExternalRowView,
): DerivedExternalValue {
	const status = externalSourceStatus(service, stateForRowView(rowView), {
		...(rowView.status === 'stale' ? { staleSince: rowView.fetchedAt } : {}),
		...(result.source_status?.dropped_over_count === undefined
			? {}
			: { droppedOverCount: result.source_status.dropped_over_count }),
		...(result.source_status?.dropped_over_length === undefined
			? {}
			: { droppedOverLength: result.source_status.dropped_over_length }),
		...(result.source_status?.dropped_unrenderable === undefined
			? {}
			: { droppedUnrenderable: result.source_status.dropped_unrenderable }),
	});
	// The kind travels with the values it describes: dropping it here would make
	// the client fall back to textContent for a value the sanitizer already
	// reduced, rendering its tags as visible text.
	const kinds = result.entries_kind === undefined ? {} : { entries_kind: [...result.entries_kind] };
	return status === null
		? { entries: [...result.entries], ...kinds }
		: { entries: [...result.entries], ...kinds, source_status: status };
}

function statusOnly(service: string, state: ExternalSourceState): DerivedExternalValue {
	// externalSourceStatus only returns null for a clean 'ok', which no caller
	// here can reach; the ?? keeps the type honest without a cast.
	return {
		entries: [],
		source_status: externalSourceStatus(service, state) ?? {
			service,
			state,
			label_key: 'external_source_unavailable',
			retryable: false,
		},
	};
}

function misconfigured(service: string): DerivedExternalValue {
	return statusOnly(service, 'misconfigured');
}
