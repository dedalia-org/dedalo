/**
 * dd_external_api — the ONE client-facing action of the external-record
 * subsystem: search a third-party service THROUGH the engine.
 *
 * WHY THIS EXISTS. `service_autocomplete.js`'s `zenon_engine` used to POST at
 * `https://zenon.dainst.org/api/v1/search` from the curator's browser. That
 * request went round every control the subsystem has (engineering/EXTERNAL_SPEC.md
 * §5) — the kill switches, the host allowlist, the SSRF guard and socket pin,
 * the breaker, the concurrency ceiling, the byte cap, the egress classification
 * — because a request the server never makes cannot be gated by the server. It
 * also stopped working outright when the app's CSP dropped third-party origins
 * from `connect-src` (XSS-02/RC-01), which is the symptom that surfaced it. The
 * fix is not to re-open `connect-src`: that directive would then have to name a
 * host taken from an OPERATOR-EDITABLE ontology field.
 *
 * WHAT THE CLIENT MAY SAY, and what it may not. The request carries the
 * CALLER's component `tipo` + `section_tipo`, the terms, and a page. It carries
 * NO url, NO host, NO field list and NO service name — every one of those is
 * resolved server-side from the ontology: the component's `request_config`
 * names the target section, the TARGET SECTION's `api_config` binds the
 * service, and each `component_external` node's own `properties.fields_map`
 * says which remote fields it needs. A client that could name the URL would be
 * the browser-direct call again, wearing the engine's socket.
 *
 * AUTH. Not in `NO_LOGIN_ACTIONS` and not in `CSRF_EXEMPT_ACTIONS`, so dispatch
 * requires a session and a valid CSRF token before this module runs. That is
 * load-bearing rather than conventional: this action makes the SERVER open an
 * outbound socket on the caller's behalf, and an anonymous visitor must never be
 * able to drive it. The actor is then held to READ permission on the caller
 * component, so the action cannot be used to probe a service bound to a section
 * the actor may not see.
 *
 * RATE LIMITING — deliberately NOT invented here. The codebase's one throttle
 * store (`security/session_store.ts` isThrottled/recordFailedAttempt) is a
 * FAILED-ATTEMPT lockout built for authentication: it counts attempts and then
 * locks the key out for minutes, which applied to a keystroke-driven
 * autocomplete would lock a working cataloguer out of search after a dozen
 * characters. There is no per-user rate limiter for legitimate high-frequency
 * reads in this engine, and adding one on the way past is how a half-designed
 * control ends up load-bearing. What DOES bound this path, install-wide and
 * already: the transport's per-(service, origin) concurrency ceiling
 * (`DEDALO_EXTERNAL_MAX_CONCURRENCY`), the circuit breaker, the request
 * timeout, the byte cap, the retry policy, the in-flight coalescing of
 * identical queries, and the `MAX_SEARCH_LIMIT` page ceiling enforced below.
 * A per-principal limiter is a real gap and belongs in a design of its own.
 *
 * OUTPUT is the shape the client's `format_data` used to fabricate, produced
 * server-side so the rendering path downstream is untouched: a `typo:'sections'`
 * entry carrying the locators, then one `record_data` per record × ddo.
 *
 * DEGRADATION OUTPUT (the service down, the target misconfigured, the circuit
 * open) is an `ok:true` envelope with `data.rows` empty and ONE coded notice
 * `external.<kind>` — see `searchDegraded` below. Ledger:
 * `WC-2026-08-06-external-search-request` (superseded on the failure shape by
 * the envelope-v2 fold-in, engineering/ERRORS_SPEC.md §5).
 */

import type {
	ExternalErrorKind,
	ExternalSearchHit,
	ExternalSearchResult,
	ExternalServiceModel,
	FieldsMapEntry,
} from '../../../external/api/index.ts';
import { type ApiNotice, DedaloError, ok, specOf } from '../../errors/index.ts';
import { getModelByTipo, getNode, getPropertiesByTipo } from '../../ontology/resolver.ts';
import { engineOf } from '../../relations/request_config/engine_select.ts';
import { getPermissions } from '../../security/permissions.ts';
import { type ActionHandler, requirePrincipal } from '../handler_context.ts';
import type { ApiResult } from '../response.ts';

/** The relation type the client stamps on a fabricated external record_data. */
const EXTERNAL_RECORD_DATA_TYPE = 'dd687';

/** The mode the client's fabricated record_data carries (list cells). */
const EXTERNAL_RECORD_DATA_MODE = 'list';

/** One resolved display field of the target section. */
export interface SearchDdo {
	readonly tipo: string;
	/** Read from the NODE, never from the request (see resolveExternalSearchTarget). */
	readonly fieldsMap: readonly FieldsMapEntry[];
	/**
	 * The remote field names of `fieldsMap` the bound adapter REFUSES
	 * (`acceptsRemoteField`), present only when non-empty: this column renders
	 * `misconfigured` (formatExternalSearchData), and the names never reach the
	 * wire (hydrateExternalSearchDdos).
	 */
	readonly refusedFields?: readonly string[];
}

/** What the request resolved to, once nothing came from the client but ids. */
export interface ResolvedSearchTarget {
	readonly targetSectionTipo: string;
	readonly ddos: readonly SearchDdo[];
	readonly remoteFields: readonly string[];
	readonly context: readonly Record<string, unknown>[];
	/** The CALLER component's tipo — the client stamps it on the sections entry. */
	readonly callerTipo: string;
	/** The bound adapter — needed to EMIT (formats, ceilings), not to fetch. */
	readonly model: ExternalServiceModel;
}

/** A caller-authored paging value the handler refuses (public: the sentence names the field). */
function invalidOption(sentence: string): DedaloError {
	return new DedaloError('request.invalid_options', { publicMessage: sentence });
}

export const externalApiActions: Record<string, ActionHandler> = {
	/**
	 * dd_external_api::search — terms in, the client's own record_data shape out.
	 *
	 * rqo.source  : { tipo, section_tipo }   the CALLER component
	 * rqo.options : { q | terms, limit, offset }
	 */
	search: async (rqo, context): Promise<ApiResult> => {
		const principal = requirePrincipal(context);

		const source = (rqo.source ?? {}) as { tipo?: unknown; section_tipo?: unknown };
		const callerTipo = typeof source.tipo === 'string' ? source.tipo : '';
		const callerSectionTipo = typeof source.section_tipo === 'string' ? source.section_tipo : '';
		if (callerTipo === '' || callerSectionTipo === '') {
			throw new DedaloError('request.invalid_source', {
				message: 'source.tipo and source.section_tipo are required',
			});
		}

		// The caller component must EXIST and the actor must be able to read it.
		// Without this, an authenticated actor could name any component in the
		// ontology and drive the engine's outbound socket through a binding they
		// are not authorized to see.
		// Existence is decided BEFORE permission: a 403 on an unknown tipo would
		// answer "does this node exist?" — the 400 (same code as a missing source)
		// is the non-disclosing answer; the tipo itself stays LOG-ONLY.
		if ((await getNode(callerTipo)) === null) {
			throw new DedaloError('request.invalid_source', {
				message: 'unknown source tipo',
				coordinates: { tipo: callerTipo },
			});
		}
		if ((await getPermissions(principal, callerSectionTipo, callerTipo)) < 1) {
			throw new DedaloError('perm.denied', {
				coordinates: { tipo: callerTipo, section_tipo: callerSectionTipo },
			});
		}

		const options = (rqo.options ?? {}) as {
			q?: unknown;
			terms?: unknown;
			limit?: unknown;
			offset?: unknown;
		};
		const terms = readTerms(options);
		// A PRESENT-BUT-UNREADABLE paging value is REFUSED, never quietly replaced
		// by the default: `limit: "twenty"` silently answering 20 rows is the
		// "silently narrow scope" failure with a friendly face.
		const limit = readInteger(options.limit);
		const offset = readInteger(options.offset);
		// `request.invalid_options` is public-disclosure: the sentence names the
		// caller's own field, which is the whole value of a 400.
		if (options.limit !== undefined && options.limit !== null && limit === undefined) {
			throw invalidOption('limit must be an integer');
		}
		if (options.offset !== undefined && options.offset !== null && offset === undefined) {
			throw invalidOption('offset must be an integer');
		}
		if (limit !== undefined && limit <= 0) throw invalidOption('limit must be positive');
		if (offset !== undefined && offset < 0) throw invalidOption('offset must not be negative');

		let target: ResolvedSearchTarget;
		try {
			target = await resolveExternalSearchTarget(callerTipo, callerSectionTipo);
		} catch (error) {
			// A CONFIGURATION question, answered identically for every request — the
			// loud posture, not the degraded one (EXTERNAL_SPEC §3.5 / §8). The DETAIL
			// stays server-side (dispatch.ts's own posture for a handler exception):
			// it names ontology nodes and bindings, and the actor cannot act on it.
			console.error(
				`[dd_external_api] search target unresolved for ${callerTipo}@${callerSectionTipo} [req ${context.requestId}]`,
				error,
			);
			return await searchDegraded(context.requestId, 'unknown', 'bad_config');
		}

		const { searchExternalService } = await import('../../../external/api/index.ts');
		let result: ExternalSearchResult;
		try {
			result = await searchExternalService({
				sectionTipo: target.targetSectionTipo,
				terms,
				remoteFields: target.remoteFields,
				...(limit === undefined ? {} : { limit }),
				...(offset === undefined ? {} : { offset }),
			});
		} catch (error) {
			// The search THROWS by design (src/external/search.ts): an empty array
			// on a search box reads as "no matches" and a cataloguer acts on it.
			// Named, logged server-side (logExternalError — the registry severity),
			// and reported as DEGRADATION: ok:true + a coded notice — never as an
			// empty result set the widget cannot tell from "no matches".
			const { ExternalServiceError, ExternalSearchUnsupportedError, logExternalError } =
				await import('../../../external/api/index.ts');
			if (error instanceof ExternalSearchUnsupportedError) {
				logExternalError(error);
				return await searchDegraded(context.requestId, error.service, error.kind, error.reason);
			}
			if (error instanceof ExternalServiceError) {
				logExternalError(error);
				return await searchDegraded(context.requestId, error.service, error.kind);
			}
			throw error;
		}

		return {
			status: 200,
			body: ok(
				{
					context: target.context,
					data: await formatExternalSearchData(result, target),
				},
				{
					requestId: context.requestId,
					// Provenance the browser engine could not report at all — the
					// handler's own extension keys (the client reads them by name).
					extend: {
						total: result.total,
						limit: result.limit,
						offset: result.offset,
						...(result.dropped > 0 ? { dropped_unaddressable: result.dropped } : {}),
					},
				},
			),
		};
	},
};

/** `q` (the client's spelling) or an explicit `terms` array. */
function readTerms(options: { q?: unknown; terms?: unknown }): string[] {
	if (Array.isArray(options.terms)) {
		return options.terms.filter((term): term is string => typeof term === 'string');
	}
	return typeof options.q === 'string' ? [options.q] : [];
}

/**
 * THE DEGRADATION ENVELOPE a search box can act on: `ok:true`, an empty result
 * (`data.data: []`, `data.context: []`), and ONE coded notice
 * `external.<kind>` — the external source did not answer, which is not a
 * failure of the request (the request was well-formed and authorized; the
 * SOURCE is what is degraded). A 4xx never reached the widget anyway
 * (`data_manager.request` discards a non-ok body), and an empty success with
 * no notice would read as "no matches" — the "silently narrow scope" failure
 * with a friendly face.
 *
 * The notice is the registry row of the kind (`label_key`, `retryable`) with
 * `details.service` (+ `details.reason` for a search-unsupported refusal —
 * 'service' | 'engine' | 'config'). Beside it, during the compat window, the
 * SAME `source_status` object the record path emits (component_external/
 * value.ts) rides as an EXTENSION KEY: the autocomplete widget renders its
 * chip from `api_response.source_status` today (`view_default_autocomplete.js`
 * render_search_notice). Removal condition: the widget reads `notices[]`.
 */
export async function searchDegraded(
	requestId: string,
	service: string,
	kind: ExternalErrorKind,
	reason?: string,
): Promise<ApiResult> {
	const { externalSourceStatus, stateForKind } = await import(
		'../../components/component_external/value.ts'
	);
	const code = `external.${kind}` as const;
	const spec = specOf(code);
	const notice: ApiNotice = {
		code,
		label_key: spec.label_key,
		retryable: spec.retryable,
		details: { service, ...(reason === undefined ? {} : { reason }) },
	};
	const state = stateForKind(kind);
	return {
		status: 200,
		body: ok(
			{ context: [], data: [] },
			{
				requestId,
				notices: [notice],
				extend: {
					source_status: externalSourceStatus(service, state) ?? {
						service,
						state,
						label_key: 'external_source_unavailable',
						retryable: false,
					},
				},
			},
		),
	};
}

function readInteger(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isInteger(value)) return value;
	if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
	return undefined;
}

/**
 * The render modes a component's external config may be DECLARED under.
 *
 * A component does not carry one request_config: the builder answers a
 * different set per mode (a `section_list` child substitutes the whole config
 * in list-like modes, so `numisdata162` declares its zenon item in EDIT and not
 * in LIST). The widget that searches is rendered in whichever mode its host
 * view is, and the client is not allowed to name the mode — that would be
 * config travelling from the browser, which is the whole thing this action
 * exists to stop. So the engine asks EVERY mode and requires the answers to
 * AGREE: one external target section, or a loud refusal naming the ambiguity.
 * Hard-coding one mode silently resolved nothing for a third of this
 * installation's external callers.
 */
const SEARCH_RESOLUTION_MODES = ['edit', 'search', 'list'] as const;

/** True when a ddo's model is an external one, by the DESCRIPTOR FACET (§9). */
async function isExternalDdo(tipo: string): Promise<boolean> {
	const model = await getModelByTipo(tipo);
	if (model === null) return false;
	const { getComponentModel } = await import('../../components/registry.ts');
	return getComponentModel(model)?.emitHook === 'external';
}

/** A ddo's declared section, normalised (`['zenon1']` and `'zenon1'` are one thing). */
function declaredSectionOf(declared: unknown): string | null {
	const value = Array.isArray(declared) ? declared[0] : declared;
	return typeof value === 'string' && value !== '' ? value : null;
}

/** The shape this decision reads out of a built request_config item. */
export interface ExternalSearchConfigItem {
	readonly api_engine?: unknown;
	readonly show?: {
		readonly ddo_map?: readonly { readonly tipo: string; readonly section_tipo?: unknown }[];
	} | null;
}

/** One external display field, as the decision found it. */
export interface ExternalSearchDdoRef {
	readonly tipo: string;
	readonly section: string | null;
	readonly ddo: unknown;
}

/**
 * THE TARGET DECISION, isolated from the ontology so it can be gated credlessly
 * (`external_search_target_tripwire`). Three rules, each of which was WRONG in
 * the first cut of this action and measurably broke real callers:
 *
 *  1. THE TARGET IS THE SECTION OF THE EXTERNAL DDOS — never `ddo_map[0]`'s.
 *     A portal's external item leads with its own portal ddo (`rsc1285` →
 *     `rsc368`@`rsc332`) and lists the `zenon1` fields after it, so ddo_map[0]
 *     names a section with no `api_config` at all. Three of this installation's
 *     six external callers resolved to nothing under the first-ddo rule; the
 *     browser engine had hidden it behind a hard-coded fallback URL.
 *  2. EVERY MODE IS ASKED. The builder answers a different item set per mode (a
 *     `section_list` child substitutes the config in list-like modes), so
 *     `numisdata162` declares its external item in EDIT and not in LIST. The
 *     client may not name the mode — that is config travelling from the browser.
 *  3. AMBIGUITY IS REFUSED, never resolved by picking the first. Two external
 *     target sections mean two services; the client cannot say which it
 *     selected (by design), and searching the wrong catalogue is a wrong answer
 *     that looks right.
 */
export async function selectExternalSearchTarget(
	callerTipo: string,
	itemsPerMode: readonly (readonly ExternalSearchConfigItem[])[],
	isExternal: (tipo: string) => Promise<boolean>,
): Promise<{ targetSectionTipo: string; externalDdos: ExternalSearchDdoRef[] }> {
	const externalDdos: ExternalSearchDdoRef[] = [];
	const seenDdo = new Set<string>();
	let sawExternalItem = false;
	for (const items of itemsPerMode) {
		for (const item of items) {
			if (engineOf(item as never) === 'dedalo') continue;
			sawExternalItem = true;
			for (const ddo of item.show?.ddo_map ?? []) {
				if (seenDdo.has(ddo.tipo)) continue;
				seenDdo.add(ddo.tipo);
				if (!(await isExternal(ddo.tipo))) continue;
				externalDdos.push({ tipo: ddo.tipo, section: declaredSectionOf(ddo.section_tipo), ddo });
			}
		}
	}
	if (!sawExternalItem) {
		throw new DedaloError('external.bad_config', {
			message: `component ${callerTipo} declares no external api_engine`,
			coordinates: { tipo: callerTipo },
		});
	}
	const targets = [
		...new Set(externalDdos.map((entry) => entry.section).filter((s) => s !== null)),
	];
	if (targets.length === 0) {
		throw new DedaloError('external.bad_config', {
			message: `component ${callerTipo} external config names no external target section`,
			coordinates: { tipo: callerTipo },
		});
	}
	if (targets.length > 1) {
		throw new DedaloError('external.bad_config', {
			message: `component ${callerTipo} external config names ${targets.length} target sections (${targets.join(', ')}) — the search cannot choose`,
			coordinates: { tipo: callerTipo, targets: targets.join(', ') },
		});
	}
	return { targetSectionTipo: targets[0] as string, externalDdos };
}

/**
 * THE HYDRATION DECISION, isolated from the ontology exactly as the target
 * decision above is: given the ddos the target decision found, produce the
 * three things the search needs — the ddos that will RENDER, the `context`
 * echo that names their columns, and the remote field list that goes on the
 * wire.
 *
 * Three properties, each load-bearing:
 *
 *  1. `remoteFields` keeps DECLARATION ORDER and dedupes across ddos. That
 *     array IS the `field[]=` byte order this installation sends to a live
 *     third party (the same order the browser engine sent), so a sort or a Set
 *     round-trip is a wire change, not a tidy-up.
 *  2. `ddos` and `context` stay INDEX-PAIRED. The client reads column i of the
 *     data as column i of the context; filtering one list and not the other
 *     renders every value under the wrong header.
 *  3. A ddo with an EMPTY fields_map is skipped (it has nothing to ask the
 *     service for), and all-empty is a loud refusal naming the caller — never
 *     a silent empty search.
 *  4. A remote field name the bound ADAPTER refuses (`acceptsRemoteField` —
 *     Zenon splices names into the URL, bare identifiers only: `dc:title`) is
 *     left out of `remoteFields`, exactly as the record path leaves it out of
 *     the section's record request (src/external/record_fields.ts): carried, it
 *     would make `buildSearchRequest` refuse the WHOLE search, blanking every
 *     valid column as "misconfigured". The ddo that maps it still RENDERS (its
 *     column stays index-paired) but is flagged `refusedFields`, so its cells
 *     say `misconfigured`; the component is logged once (deduped) naming its
 *     tipo and the names. If NO ddo is left unflagged, nothing can render: the
 *     same loud refusal as rule 3. With no refused name the output is exactly
 *     what it was before the filter (the `field[]=` bytes are unchanged).
 *
 * The fields_map itself is NOT read here: `loadFieldsMap` is the injected
 * reader, and its one production implementation reads the ddo's own ontology
 * node (never the request).
 */
export async function hydrateExternalSearchDdos(
	callerTipo: string,
	targetSectionTipo: string,
	externalDdos: readonly ExternalSearchDdoRef[],
	loadFieldsMap: (tipo: string) => Promise<readonly FieldsMapEntry[]>,
	/** The target section's bound adapter — whose `acceptsRemoteField` decides rule 4. */
	model: ExternalServiceModel,
): Promise<{
	ddos: SearchDdo[];
	context: Record<string, unknown>[];
	remoteFields: string[];
}> {
	const { remoteFieldsOf, reportRefusedRemoteFields } = await import(
		'../../../external/api/index.ts'
	);
	const ddos: SearchDdo[] = [];
	const context: Record<string, unknown>[] = [];
	const seen = new Set<string>();
	const remoteFields: string[] = [];
	let renderable = 0;
	for (const entry of externalDdos) {
		if (entry.section !== targetSectionTipo) continue;
		const fieldsMap = await loadFieldsMap(entry.tipo);
		if (fieldsMap.length === 0) continue;
		// Rule 4: the record path's own report (one deduped bad_config line).
		const refused = reportRefusedRemoteFields(model, entry.tipo, targetSectionTipo, fieldsMap);
		ddos.push(
			refused.length === 0
				? { tipo: entry.tipo, fieldsMap }
				: { tipo: entry.tipo, fieldsMap, refusedFields: refused },
		);
		context.push(entry.ddo as Record<string, unknown>);
		if (refused.length === 0) renderable++;
		// Declaration order is the `field[]=` order on the wire — the same order
		// the browser engine sent, and part of the byte form gated by the tests.
		for (const field of remoteFieldsOf(fieldsMap)) {
			if (seen.has(field) || refused.includes(field)) continue;
			seen.add(field);
			remoteFields.push(field);
		}
	}
	if (ddos.length === 0) {
		throw new DedaloError('external.bad_config', {
			message: `component ${callerTipo} external config shows no external field with a fields_map`,
			coordinates: { tipo: callerTipo },
		});
	}
	if (renderable === 0) {
		throw new DedaloError('external.bad_config', {
			message: `component ${callerTipo} external config shows no external field the ${model.service} service accepts (every fields_map names a refused remote field)`,
			coordinates: { tipo: callerTipo },
		});
	}
	return { ddos, context, remoteFields };
}

/**
 * Resolve WHICH external section this component searches and WHICH fields it
 * displays — entirely from the ontology.
 *
 * THE TARGET IS THE SECTION OF THE EXTERNAL DDOS, not the first ddo's section.
 * `relations/request_config/external.ts` binds `api_config` from `ddo_map[0]`,
 * and that rule is PHP parity on a PUBLICATION path — but it is wrong as a
 * resolution rule and measurably so: a portal's external item leads with its
 * OWN portal ddo (`rsc1285` → `rsc368`@`rsc332`) and only then lists the
 * `zenon1` fields, so ddo_map[0] names a section with no `api_config` at all.
 * The browser engine survived that by falling back to a hard-coded Zenon URL —
 * the hard-coding this change deleted. The engine instead reads the target off
 * the ddos that ARE external, and refuses loudly if they disagree (two services
 * behind one component would need the client to say which, and the client is
 * deliberately unable to).
 *
 * The fields_map is read from each ddo's OWN ONTOLOGY NODE, never from the ddo
 * echo: the echo exists for the client, and the request that leaves this
 * installation must be built from the source of truth.
 */
export async function resolveExternalSearchTarget(
	callerTipo: string,
	callerSectionTipo: string,
): Promise<ResolvedSearchTarget> {
	const { buildRequestConfigForElement } = await import('../../relations/request_config/build.ts');
	const properties = await getPropertiesByTipo(callerTipo);

	const itemsPerMode: ExternalSearchConfigItem[][] = [];
	for (const mode of SEARCH_RESOLUTION_MODES) {
		itemsPerMode.push(
			(await buildRequestConfigForElement(properties, {
				ownerTipo: callerTipo,
				ownerSectionTipo: callerSectionTipo,
				mode,
				ownerIsSection: false,
			})) as unknown as ExternalSearchConfigItem[],
		);
	}
	const { targetSectionTipo, externalDdos } = await selectExternalSearchTarget(
		callerTipo,
		itemsPerMode,
		isExternalDdo,
	);

	const { getExternalServiceForSection, parseFieldsMap } = await import(
		'../../../external/api/index.ts'
	);
	// The binding FIRST: its adapter decides which remote field names may go on
	// the wire at all (hydration rule 4).
	const resolved = await getExternalServiceForSection(targetSectionTipo);
	if (resolved === null) {
		throw new DedaloError('external.bad_config', {
			message: `target section ${targetSectionTipo} carries no api_config`,
			coordinates: { section_tipo: targetSectionTipo },
		});
	}
	// The ONE reader of a ddo's fields_map: the ddo's OWN ONTOLOGY NODE. Passed
	// as the hydration loader so the ordering/dedup/pairing decision above can be
	// gated without a database, while the source of truth stays right here.
	const { ddos, context, remoteFields } = await hydrateExternalSearchDdos(
		callerTipo,
		targetSectionTipo,
		externalDdos,
		async (tipo: string) => {
			const nodeProperties = (await getPropertiesByTipo(tipo)) as {
				fields_map?: unknown;
			} | null;
			return parseFieldsMap(nodeProperties?.fields_map, { tipo });
		},
		resolved.model,
	);

	return { targetSectionTipo, ddos, remoteFields, context, callerTipo, model: resolved.model };
}

/**
 * THE CLIENT WIRE SHAPE, produced server-side. Reproduced from
 * service_autocomplete.js `format_data` (~:1063-1110) so the rendering path
 * downstream is untouched:
 *
 *   [ { section_tipo, tipo, entries: [locator…], typo: 'sections' },
 *     { section_tipo, section_id, type: 'dd687', tipo, mode: 'list', entries } … ]
 *
 * `section_id` is the remote id in STORAGE form — the zero-padded string, never
 * a number (`"001338683"` and `1338683` address different records).
 *
 * The VALUES come from `mapRowToEntries`, the subsystem's one emission
 * function, so a search cell obeys the same formats, the same per-entry length
 * and count ceilings and the same refusal-counting as the record path. The
 * browser engine had its own ad-hoc formatter (author roles joined with ' - ',
 * arrays with ', ') which agreed with nothing else in the engine; that
 * divergence is ledgered rather than reproduced.
 */
/**
 * The fields_map a SEARCH cell renders with: every `format` the adapter maps in
 * `searchFormats` is replaced by its search-only twin (owner C55: zenon
 * `zenon_authors` → `zenon_author_names`, names without role labels); every
 * other row is the record path's own. The rows are the node's (never the
 * request's) — only the format NAME changes, and only to one the adapter
 * declares (external_registry_totality_tripwire).
 */
function searchFieldsMap(
	model: ExternalServiceModel,
	fieldsMap: readonly FieldsMapEntry[],
): readonly FieldsMapEntry[] {
	const twins = model.searchFormats;
	if (twins === undefined) return fieldsMap;
	return fieldsMap.map((entry) => {
		const twin = entry.format === undefined ? undefined : twins[entry.format];
		return twin === undefined ? entry : { ...entry, format: twin };
	});
}

export async function formatExternalSearchData(
	result: ExternalSearchResult,
	target: ResolvedSearchTarget,
): Promise<Record<string, unknown>[]> {
	const sectionTipo = target.targetSectionTipo;
	const locators = result.hits.map((hit: ExternalSearchHit) => ({
		section_tipo: sectionTipo,
		section_id: hit.remoteId,
	}));
	const section = {
		section_tipo: sectionTipo,
		// The CALLER's tipo — what `self.caller.tipo` resolved to in the browser
		// engine. It is how the client routes the locator set back to the widget
		// that asked, so it is emphatically NOT the service name.
		tipo: target.callerTipo,
		entries: locators,
		typo: 'sections',
	};
	// The facade is reached through the dynamic-import rule the rest of the read
	// path uses (engineering/CONVENTIONS.md) — src/core/api must not join
	// src/external's static graph for a leaf call.
	const { mapRowToEntries } = await import('../../../external/api/index.ts');
	const { externalSourceStatus, stateForKind } = await import(
		'../../components/component_external/value.ts'
	);
	const fetchedAt = Date.now();
	const rows: Record<string, unknown>[] = [];
	for (const hit of result.hits as readonly ExternalSearchHit[]) {
		for (const ddo of target.ddos) {
			const base = {
				section_tipo: sectionTipo,
				section_id: hit.remoteId,
				type: EXTERNAL_RECORD_DATA_TYPE,
				tipo: ddo.tipo,
				mode: EXTERNAL_RECORD_DATA_MODE,
			};
			if ((ddo.refusedFields?.length ?? 0) > 0) {
				// A column whose fields_map names a name the adapter refuses was never
				// asked for (hydration rule 4): it is THIS component's configuration
				// error — the record path's own `misconfigured` value, never a blank
				// cell under `status: 'ok'`.
				rows.push({
					...base,
					entries: [],
					source_status: externalSourceStatus(result.service, stateForKind('bad_config')),
				});
				continue;
			}
			rows.push({
				...base,
				// `status: 'ok'` is a FACT here, not an assumption: these rows came
				// back from a live answer in this same request. A degraded search
				// never reaches this function — it threw.
				...(mapRowToEntries(
					target.model,
					{
						sectionTipo,
						remoteId: hit.remoteId,
						service: result.service,
						row: hit.row,
						status: 'ok',
						fetchedAt,
					},
					searchFieldsMap(target.model, ddo.fieldsMap),
				) as unknown as Record<string, unknown>),
			});
		}
	}
	return [section, ...rows];
}
