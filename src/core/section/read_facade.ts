/**
 * Section read facade — the dd_core_api `read` SUB-ACTION ROUTING, extracted
 * verbatim from api/dispatch.ts (WS-C, audit S2-25): the routing that
 * discriminates a read RQO into its concrete section-read strategy lives WITH
 * the section subsystem, so its semantics cannot drift from section/read.ts.
 *
 * The caller (api/handlers/dd_core_api.ts) has already run the ACL gates that
 * are NOT routing: the menu/area model dispatch, permission gate A (source
 * section_tipo+tipo) and gate B (every SQO target section). Everything below —
 * relation-list, related-sections (related_search), time-machine, resolve_data,
 * component get_data, the stale-lock release and the generic readSection — is
 * behavior-identical to the pre-split
 * dispatch body, with ONE deliberate routing fix (2026-07-09, BUG-0): a
 * component-model source with `action:'search'` (the service_autocomplete
 * picker, input_text find_equal) routes to the generic readSection — PHP
 * dispatches on source.action alone (dd_core_api.php:2050/:2256) and the
 * get_data branches used to swallow it into the no-id empty shell.
 */

import type { ApiResult } from '../api/response.ts';
import { isTemporalSource, type Rqo } from '../concepts/rqo.ts';
import { canonicalizeStoredSectionId, classifyWireSectionId } from '../concepts/section_id.ts';
import {
	type ClientPage,
	clampClientPage,
	offsetPastPage,
	pageClampedNotice,
	requestedPage,
} from '../concepts/sqo.ts';
import { type ApiNotice, DedaloError, isErrorInDomain, ok, specOf } from '../errors/index.ts';
import type { RelatedLocatorFilter } from '../search/search_related.ts';
import { getPermissions, type Principal } from '../security/permissions.ts';
import { currentRequestId } from '../security/request_context.ts';
import { readSection } from './read.ts';

/**
 * PHP's empty component shell — the 200 answer for "there is nothing to show
 * here" (non-edit relation_list, a record outside the caller's scope, a
 * level-0 component, a get_data with no id). It is a SUCCESS, never a refusal:
 * a 403 would tell the caller the record/component exists.
 */
function emptyShell(): ApiResult {
	return {
		status: 200,
		body: ok({ context: [], data: [] }, { requestId: currentRequestId() }),
	};
}

/**
 * A cell model the relation_list cannot render is a NON-FATAL coded fact, not a
 * failure (ERRORS_SPEC §3): the panel still answers with every cell it could
 * resolve. The models themselves go to the operator log — engine.uncovered_scope
 * declares no details_keys, so naming them on the wire is not available to it,
 * and inventing one would be a wire change no client asked for (nothing reads
 * this list today).
 */
function uncoveredCellNotices(unresolved: readonly string[]): ApiNotice[] | undefined {
	if (unresolved.length === 0) return undefined;
	console.warn(`[read_facade] unresolved relation_list cell models: ${unresolved.join(', ')}`);
	return [
		{
			code: 'engine.uncovered_scope',
			label_key: specOf('engine.uncovered_scope').label_key,
			retryable: false,
		},
	];
}

/** The page posture a read route declares (READ-4). */
export type SectionReadPagePosture = 'client_sqo' | 'none';

/**
 * One `source.action` read route. `page: 'client_sqo'` = the route pages the
 * CLIENT's sqo window into a sink, so it MUST resolve the window through
 * `clampClientPage` (concepts/sqo.ts) — never mean "all" by an absent limit,
 * never pass the offset raw. 'none' = the route serves no client window.
 * test/unit/client_page_doors_native.test.ts derives the set of doors that
 * reach the relation sink at run time and requires each such route to
 * declare 'client_sqo'.
 */
export interface SectionReadRoute {
	readonly page: SectionReadPagePosture;
	readonly handler: (rqo: Rqo, principal: Principal) => Promise<ApiResult>;
}

/** A source.sqo section_tipo axis → the owning-section narrowing ('all' = none). */
function owningSectionTipos(rawAxis: unknown): string[] | 'all' {
	const rawSectionTipos = Array.isArray(rawAxis)
		? rawAxis.filter((tipo): tipo is string => typeof tipo === 'string')
		: typeof rawAxis === 'string'
			? [rawAxis]
			: [];
	return rawSectionTipos.length === 0 || rawSectionTipos.includes('all')
		? ('all' as const)
		: rawSectionTipos;
}

/** Concatenate notice lists; `undefined` when there are none (no empty key on the wire). */
function joinNotices(...lists: (readonly ApiNotice[] | undefined)[]): ApiNotice[] | undefined {
	const all = lists.flatMap((list) => list ?? []);
	return all.length === 0 ? undefined : all;
}

/** A 'client_sqo' route's page: the bounded window, and the window as sent. */
interface RouteClientPage {
	door: string;
	page: ClientPage;
	asSent: { limit: unknown; offset: unknown };
}

/**
 * The client page of a 'client_sqo' route — `clampClientPage` over the window
 * AS SENT (requestedPage: the wire-recorded original when the body crossed
 * wireSqoSchema).
 */
function routeClientPage(door: string, sqo: unknown, scope: string): RouteClientPage {
	const asSent = requestedPage(sqo);
	return { door, page: clampClientPage(asSent.limit, asSent.offset, scope), asSent };
}

/**
 * The `search.page_clamped` notice a 'client_sqo' route owes, decided by the
 * OUTCOME, never by the spelling of the request:
 *
 * - `'requested'` — served as sent: none;
 * - `'clamped'` — a value the client SENT was changed: always;
 * - `'defaulted'` — the limit was absent. These doors used to read that as
 *   "all", so the notice is owed exactly when the default CUT something the
 *   CALLER could page to: the page is a window of the caller's SCOPED
 *   referencing records (D1), so the notice is owed exactly when that set holds
 *   more than offset + limit records. An absent limit whose answer is whole
 *   (the tools that send none, on a host with a few related records) carries
 *   no notice — the client toasts every notice, and nothing was cut.
 *
 * SCOPED (AUTHZ-05), like the page itself, and BOUNDED whatever the tail: ONE
 * statement over the related search's own scoped question
 * (anyRecordVisiblePast → search_related anyInverseReferencePast, scoped by
 * record_scope rowScopeFor — the predicate the page and the count use). "Is
 * there anything for you past this page" is a question the caller can already
 * ask by paging forward — the notice discloses nothing new. An UNSCOPED probe
 * would answer "do more than offset+limit references exist", counting records
 * in sections and projects the caller cannot reach (a binary search on the
 * offset reads the exact unscoped total); a probe that READ the tail window by
 * window cost a deep OFFSET read per window for a non-admin whose tail is
 * hidden (client_page_doors_native: the non-admin legs and the long hidden
 * tail; related_scope_equivalence_native: count == walk == probe).
 */
async function owedPageNotices(
	route: RouteClientPage,
	locators: RelatedLocatorFilter[],
	sectionTipos: string[] | 'all',
	principal: Principal,
): Promise<ApiNotice[]> {
	const { door, page, asSent } = route;
	if (page.bounded === 'requested') return [];
	if (
		page.bounded === 'defaulted' &&
		!(await anyRecordVisiblePast(locators, sectionTipos, page, principal))
	) {
		return [];
	}
	return [pageClampedNotice(door, asSent.limit, asSent.offset, page)];
}

/**
 * Whether the caller's SCOPED referencing records extend past `page` — the
 * page is a window of that same scoped set (D1: buildRelationList /
 * buildRelatedSections cut it after scoping), so "is anything past this page
 * yours" is "does the scoped set hold more than offset + limit records". ONE
 * statement over the related search's own question, scoped by the same
 * record-scope predicate as the page and the count (search_related
 * anyInverseReferencePast + record_scope rowScopeFor) — never a read of the
 * tail. Nothing lies past MAX_SAFE_INTEGER (offsetPastPage). Dynamic imports,
 * like the sink doors themselves (record_scope pulls in the search assembler).
 */
async function anyRecordVisiblePast(
	locators: RelatedLocatorFilter[],
	sectionTipos: string[] | 'all',
	page: ClientPage,
	principal: Principal,
): Promise<boolean> {
	const past = offsetPastPage(page);
	if (past === null) return false;
	const { anyInverseReferencePast } = await import('../search/search_related.ts');
	const { rowScopeFor } = await import('../security/record_scope.ts');
	return anyInverseReferencePast(locators, { sectionTipos, scope: rowScopeFor(principal) }, past);
}

// Relation list (source.action 'get_relation_list'): the Referencias
// panel — every record pointing AT the host. PHP only answers in
// edit mode (any other mode returns the empty shell) and gates on
// read access to the HOST section (gate A in the handler covered it when
// source carried section_tipo+tipo; enforce host read here).
async function readRelationList(rqo: Rqo, principal: Principal): Promise<ApiResult> {
	const source = rqo.source ?? {};
	const requestId = currentRequestId();
	const { hostSectionTipo, hostSectionId } = await readableRelationListHost(source, principal);
	if ((source.mode ?? 'list') !== 'edit') {
		// PHP relation_list_json: non-edit modes return the empty shell.
		return emptyShell();
	}
	const { buildRelationList } = await import('../resolve/relation_list.ts');
	const sqoOptions = (rqo.sqo ?? {}) as { section_tipo?: unknown };
	// The CLIENT sqo's section_tipo axis narrows the OWNING sections ('all' =
	// no narrowing — the panel sends ["all"], the header open sends the one
	// target section). Its window is a CLIENT page (READ-4): bounded by
	// clampClientPage — an absent / 0 / 'all' limit is the ceiling plus a
	// `search.page_clamped` notice, never "all records" (PHP set_limit(0) did
	// mean all; WC-2026-10-11-relation-reads-client-page).
	const route = routeClientPage('get_relation_list', rqo.sqo, hostSectionTipo);
	const { page } = route;
	const sectionTipos = owningSectionTipos(sqoOptions.section_tipo);
	const relationList = await buildRelationList(hostSectionTipo, hostSectionId, {
		limit: page.limit,
		offset: page.offset,
		lang: source.lang,
		sectionTipos,
		// AUTHZ-05: scope referencing records to the caller (drops references in
		// sections/projects the caller cannot reach). Host-read alone (gate above)
		// is not enough — the scan spans 'all' owning sections.
		principal,
	});
	const pageNotices = await owedPageNotices(
		route,
		[
			{
				section_tipo: hostSectionTipo,
				section_id: canonicalizeStoredSectionId(hostSectionId) as string | number,
			},
		],
		sectionTipos,
		principal,
	);
	return {
		status: 200,
		body: ok(
			{ context: relationList.context, data: relationList.data },
			{
				requestId,
				notices: joinNotices(pageNotices, uncoveredCellNotices(relationList.unresolved)),
			},
		),
	};
}

/** get_relation_list's host: present (else request.invalid_source) and readable (else perm.denied). */
async function readableRelationListHost(
	source: NonNullable<Rqo['source']>,
	principal: Principal,
): Promise<{
	hostSectionTipo: string;
	hostSectionId: NonNullable<NonNullable<Rqo['source']>['section_id']>;
}> {
	const hostSectionTipo = String(source.section_tipo ?? '');
	const hostSectionId = source.section_id;
	if (hostSectionTipo === '' || hostSectionId === undefined || hostSectionId === null) {
		throw new DedaloError('request.invalid_source', {
			coordinates: { action: 'get_relation_list' },
		});
	}
	const hostLevel = await getPermissions(principal, hostSectionTipo, hostSectionTipo);
	if (hostLevel < 1) {
		throw new DedaloError('perm.denied', { coordinates: { section_tipo: hostSectionTipo } });
	}
	return { hostSectionTipo, hostSectionId };
}

// Related-sections read (source.action 'related_search' + sqo.mode
// 'related'): the transcription/indexation/tr_print/epigraphy tools'
// "which records point at me" listing. PHP dispatches on source.action
// alone (dd_core_api.php:2326 `case 'related_search'` →
// sections::get_instance 'related_list'); TS serves the same contract
// through buildRelatedSections (wire shape: WC-065). Keyed on
// source.action ALONE and placed BEFORE the component-model get_data
// branch below, which would otherwise swallow the tools' component-source
// RQO into an empty component shell.
async function readRelatedSections(rqo: Rqo, principal: Principal): Promise<ApiResult> {
	const source = rqo.source ?? {};
	const requestId = currentRequestId();
	const sqoOptions = (rqo.sqo ?? {}) as {
		section_tipo?: unknown;
		filter_by_locators?: { section_tipo?: unknown; section_id?: unknown }[];
	};
	const locators = await readableRelatedHosts(sqoOptions.filter_by_locators, principal);
	const firstHost = (locators[0] as RelatedHost).section_tipo;
	// The window is a CLIENT page (READ-4), bounded exactly like
	// get_relation_list's: absent / 0 / 'all' = the ceiling plus the notice.
	const route = routeClientPage('related_search', rqo.sqo, firstHost);
	const { page } = route;
	const sectionTipos = owningSectionTipos(sqoOptions.section_tipo);
	const { buildRelatedSections } = await import('../resolve/related_sections.ts');
	const result = await buildRelatedSections(locators, {
		callerTipo: String(source.tipo ?? firstHost),
		lang: source.lang,
		sectionTipos,
		limit: page.limit,
		offset: page.offset,
		// AUTHZ-05 / D1: scope referencing records to the caller, like
		// get_relation_list above — the scan spans 'all' owning sections. The
		// scope applies BEFORE the window (in the related search's SQL), so the
		// page is a window of the caller's own records.
		principal,
	});
	// The probe addresses the hosts exactly as buildRelatedSections does (the
	// canonicalizing entrance — a legacy string id or an external remote id).
	const notices = await owedPageNotices(
		route,
		locators.map((locator) => ({
			section_tipo: locator.section_tipo,
			section_id: canonicalizeStoredSectionId(locator.section_id) as string | number,
		})),
		sectionTipos,
		principal,
	);
	return { status: 200, body: ok(result, { requestId, notices: joinNotices(notices) }) };
}

/** A related_search host locator as the wire may send it. */
type RelatedHost = { section_tipo: string; section_id: number | string };

/**
 * related_search's hosts: at least one well-formed locator (else
 * request.invalid_source), each in a section the caller may read (else
 * perm.denied — mirrors the count-mode 'related' gate in the handler).
 *
 * KEPT UNION (WC-2026-08-10-section-id-int-canonical): filter_by_locators is a
 * RAW wire list from the transcription/indexation tools, still sent in the
 * legacy string form by an old client, and it may name an external-service
 * host whose remote id is a string by nature. Narrowing the guard would DROP
 * those hosts and answer a bogus 400; buildRelatedSections canonicalizes each
 * locator at its own entrance.
 */
async function readableRelatedHosts(
	filterByLocators: unknown,
	principal: Principal,
): Promise<RelatedHost[]> {
	const locators = (
		(Array.isArray(filterByLocators) ? filterByLocators : []) as {
			section_tipo?: unknown;
			section_id?: unknown;
		}[]
	).filter(isRelatedHost);
	if (locators.length === 0) {
		throw new DedaloError('request.invalid_source', {
			coordinates: { action: 'related_search' },
		});
	}
	for (const locator of locators) {
		if ((await getPermissions(principal, locator.section_tipo, locator.section_tipo)) < 1) {
			throw new DedaloError('perm.denied', {
				coordinates: { section_tipo: locator.section_tipo },
			});
		}
	}
	return locators;
}

function isRelatedHost(locator: {
	section_tipo?: unknown;
	section_id?: unknown;
}): locator is RelatedHost {
	return (
		typeof locator?.section_tipo === 'string' &&
		(typeof locator.section_id === 'number' || typeof locator.section_id === 'string')
	);
}

// Time Machine read (sqo.mode 'tm'): the record-history listing is now
// served through the GENERIC readSection (the dd15 TM read-source —
// section/read_source.ts). Only the time-machine ACCESS GATE stays here:
// it is a per-CALLER-section ACL (SECTION_SPEC §7.4, stricter than the
// read grant) that must gate BEFORE the read. Gate B in the handler already
// required level >= 1 on every SQO target section. Exported for the count
// action, which must answer exactly what the read answers
// (WC-2026-10-22-tm-scope-whole-request) — a no-op for a non-TM SQO.
export async function gateTimeMachineRead(rqo: Rqo, principal: Principal): Promise<void> {
	if ((rqo.sqo as { mode?: string } | undefined)?.mode !== 'tm') return;
	const { canAccessTimeMachineList, resolveTimeMachineScopeSection } = await import(
		'./list_definitions/time_machine_list.ts'
	);
	// The SCOPE — the caller section whose history this reads — comes from the
	// SQO, not from source.section_tipo: the client pins that to 'dd15', so the
	// gate used to evaluate dd15 against itself and the §7.4 per-section grant
	// was never consulted (WC-2026-08-14-tm-scope-server-owned).
	const scope = resolveTimeMachineScopeSection(rqo.sqo as Record<string, unknown> | undefined);
	if (scope.mixed) {
		throw new DedaloError('perm.denied', {
			message:
				'Time machine reads spanning several sections are not authorized: one section grant cannot cover another',
		});
	}
	// Unscoped (the bare dd15 browse) shows EVERY section's history at once, so
	// no per-section grant can authorize it — global admin only. Gating dd15
	// against itself is exactly that: it declares no time_machine_list child,
	// so canAccessTimeMachineList fails closed for everyone but an admin.
	const gateTipo = scope.sectionTipo ?? 'dd15';
	if (!(await canAccessTimeMachineList(principal, gateTipo))) {
		throw new DedaloError('perm.denied', {
			message: 'Insufficient permissions for the time machine of this section',
			coordinates: { section_tipo: gateTipo },
		});
	}
	// The per-ddo permission FLOOR needs the same scope: the API handlers open
	// it around their whole body (withTimeMachineReadScope) and readSection
	// re-opens it for direct callers — this gate only decides admission.
}

// resolve_data: a component in SEARCH mode resolves INJECTED locators
// (source.value) — the portal filter chips. Gate A in the handler covered
// the (section_tipo, tipo) read permission.
async function readResolveData(rqo: Rqo, principal: Principal): Promise<ApiResult> {
	const source = rqo.source ?? {};
	const requestId = currentRequestId();
	const { resolveSearchData, buildGetDataContext } = await import('./read.ts');
	// Pass the principal so injected target locators outside the caller's
	// projects filter are dropped (foundation audit AUTHZ-02 — same root cause
	// as AUTHZ-01, bounded to the relation's declared target sections).
	const resolved = await resolveSearchData(rqo, principal);
	await ensureOwnSearchItem(source, resolved);
	// The client BUILDS the search-mode instance from this response and
	// aborts if result.context is empty (component_portal.js:632 —
	// "component without context", leaving status stuck at 'building').
	// Emit the component's structure context (buildGetDataContext), same as
	// the get_data path, so the search filter builds + renders.
	const context = await buildGetDataContext(rqo, resolved, principal);
	return { status: 200, body: ok({ context, data: resolved }, { requestId }) };
}

/**
 * resolve_data: guarantee the component's OWN item is present in `resolved`.
 */
async function ensureOwnSearchItem(
	source: NonNullable<Rqo['source']>,
	resolved: unknown[],
): Promise<void> {
	// Guarantee the component's OWN item is present (entries=[] when the
	// search carries no injected value). Some models (e.g. component_external,
	// search-unported) resolve to zero items, and the client search render
	// then reads data.entries of undefined (render_search_component_external
	// :178 data.entries[0]). A [] main item keeps the render safe.
	if (
		source.tipo !== undefined &&
		source.section_tipo !== undefined &&
		!resolved.some((d) => (d as { tipo?: string }).tipo === source.tipo)
	) {
		const { buildDataItem } = await import('../resolve/component_data.ts');
		// Canonical id echo (WC-2026-08-10-section-id-int-canonical — repeals
		// the pass-AS-GIVEN string law that stood here): a record address emits
		// as INT; an external remote id ('000147689' — leading zeros are the
		// id's own bytes) and a synthetic 'search_<n>' token survive VERBATIM,
		// which is exactly what canonicalizeStoredSectionId does. The client
		// matches the item by String(el.section_id)===String(self.section_id),
		// and both typed forms of a record address stringify identically, so
		// the canonical form keeps the match; a blanket Number() would still
		// break it (leading zeros dropped) and stays banned.
		resolved.unshift(
			buildDataItem(
				source.tipo,
				source.section_tipo,
				(canonicalizeStoredSectionId(source.section_id) as number | string | null) ?? 0,
				'search',
				source.lang ?? 'lg-nolan',
				[],
			),
		);
	}
}

/**
 * THE `source.action` route table — every read keyed on `source.action` ALONE
 * (PHP dispatches on it, dd_core_api.php:2050). Each route declares its page
 * posture. Placed BEFORE the component-model get_data branch, which would
 * otherwise swallow a component-source RQO into an empty component shell.
 * `search` and `get_data` are NOT here: they also depend on the source model
 * and section_id (see routeSectionRead).
 */
export const SECTION_READ_ROUTES: ReadonlyMap<string, SectionReadRoute> = new Map<
	string,
	SectionReadRoute
>([
	['get_relation_list', { page: 'client_sqo', handler: readRelationList }],
	['related_search', { page: 'client_sqo', handler: readRelatedSections }],
	['resolve_data', { page: 'none', handler: readResolveData }],
]);

/**
 * The page posture of the reads WITHOUT a `source.action` route (the
 * `read#(default)` door): the component get_data pages the CLIENT's sqo window
 * (a component_relation_index pages the relation sink) and bounds it itself —
 * read.ts readComponentData → clampClientPage — and the generic section read
 * bounds it in sanitizeClientSqo (clampClientLimit + clampClientOffset). Never
 * by trusting the wire schema to have bounded it first.
 * client_page_doors_native requires it of every door that reaches the sink,
 * and measures it with the wire schema bypassed.
 */
export const SECTION_READ_DEFAULT_PAGE: SectionReadPagePosture = 'client_sqo';

/**
 * get_data's RECORD gate (the reasons live above its call site in routeSectionRead): true when
 * the source addresses no record of ours, the actor's own account, or a record the principal
 * may access.
 */
async function getDataRecordGateAdmits(
	source: NonNullable<Rqo['source']>,
	principal: Principal,
): Promise<boolean> {
	if (typeof source.section_tipo !== 'string' || isTemporalSource(source)) return true;
	// Classifier refusal → skip the gate like any non-record kind: the id
	// addresses nothing, and the downstream read serves the no-record
	// widget (read.ts catches the same refusal). Never a 500 on a read.
	const wireSectionId = await classifyWireSectionId(
		source.section_id,
		source.section_tipo,
		'rqo.get_data.record_scope_gate',
	).catch((error: unknown) => {
		if (isErrorInDomain(error, 'section_id')) return { kind: 'absent' } as const;
		throw error;
	});
	// The actor's OWN account record is readable by the actor — root (dd128/-1)
	// included, or tool_user_admin, the one UI for the self-service writes of
	// WC-2026-08-28-root-self-service-write, opens empty for root. The level gate
	// below still applies (WC-2026-10-28-own-account-read).
	if (wireSectionId.kind === 'record') {
		const { isActorsOwnUserRecord } = await import('../security/permissions.ts');
		const { principalCanAccessRecord } = await import('../security/record_scope.ts');
		if (
			!isActorsOwnUserRecord(principal, source.section_tipo, wireSectionId.id) &&
			!(await principalCanAccessRecord(source.section_tipo, wireSectionId.id, principal))
		) {
			return false;
		}
	}
	return true;
}

/** Route a permission-gated dd_core_api read RQO to its read strategy. */
export async function routeSectionRead(rqo: Rqo, principal: Principal): Promise<ApiResult> {
	const source = rqo.source ?? {};
	// The correlation id of the request in scope (dispatchRqo opens the ALS) —
	// this facade is called without the API context, ERRORS_SPEC §3.
	const requestId = currentRequestId();

	// Time Machine admission (sqo.mode 'tm') FIRST, by STRUCTURE: it runs before
	// any route is chosen, so every read — each SECTION_READ_ROUTES handler,
	// today's and any added later, and the generic readSection a TM read falls
	// through to (the dd15 TM read-source) — is admitted by it without a
	// handler having to remember the call. A no-op unless sqo.mode === 'tm'.
	// Gate: tm_scope_authz_native ("every read route is admitted by the gate").
	await gateTimeMachineRead(rqo, principal);

	const route =
		typeof source.action === 'string' ? SECTION_READ_ROUTES.get(source.action) : undefined;
	if (route !== undefined) return route.handler(rqo, principal);

	// Component-source SEARCH read (PHP routes on source.action alone —
	// dd_core_api.php:2050 `$action = $ddo_source->action ?? 'search'`, :2256
	// `case 'search': // Used by section and service autocomplete`): the
	// service_autocomplete target-record picker and the input_text find_equal
	// probe. Never treat it as a component get_data — with or without a
	// section_id it must fall through to the stale-lock release + generic
	// readSection below (PHP runs force_unlock inside `case 'search'` too,
	// dd_core_api.php:2322). Deliberate routing fix (BUG-0, 2026-07-09): the
	// branches below used to swallow it into the get_data no-id empty shell,
	// so the picker rendered empty for every user.
	const isComponentSearch = source.action === 'search';

	// Component-level get_data (portal pagination / "show more"): resolve
	// the single component directly, not the whole section.
	if (
		!isComponentSearch &&
		(source.action === 'get_data' || (source.model ?? '').startsWith('component_')) &&
		source.section_id !== undefined &&
		source.section_id !== null
	) {
		// §7.4 per-record projects (tenant) ACL on the DIRECT record read: get_data
		// addresses a record by section_id with NO sqo, so the handler's Gate B
		// (per-SQO-target) never ran and Gate A only checked the section-level
		// grant. Without this, a non-admin with a section read grant reads any
		// record's component values across the projects filter (foundation audit
		// AUTHZ-01, live cross-tenant read). Symmetric to the save/delete
		// isRecordInScope gate. Out of scope ⇒ PHP empty shell (never reveal the
		// record's existence), not a 403.
		//
		// NON-record ids are EXEMPT — classified, not Number()-sniffed
		// (WC-2026-08-10-section-id-int-canonical). A SYNTHETIC id: the search
		// panel builds each filter component with a client-minted section_id
		// ('search_<n>', search.js get_section_id) that addresses NO matrix
		// record — readComponentData resolves a null record and returns only
		// record-INDEPENDENT data (the option datalist, or an empty item). PHP
		// does not gate this path at all (user_can_access_record is RAG-only;
		// get_data serves the datalist to every searcher). Gating it here is
		// meaningless AND harmful: an out-of-scope verdict on a no-record id
		// blanks the whole search form for non-admins (search is enabled for all
		// users). An EXTERNAL-REF likewise addresses no matrix record — the old
		// NaN sniff already skipped opaque 'Q42'-style tokens, and classification
		// fixes the digits-only remote ids ('001338683') the sniff mis-gated as a
		// bogus record number. Every REAL record id — including non-positive ones
		// (0, root -1) — stays gated, so no record reach is opened
		// (principalCanAccessRecord blocks < 1). An `absent` id ('') also skips:
		// no address, nothing to scope (the NaN era gated it as record 0 — the
		// '' divergence recorded in the WC entry).
		// TEMPORAL instances are exempt for the same reason as the synthetic
		// search ids (WC-059): the sentinel `section_id: 1` addresses no record,
		// so gating on it would blank a tool's editable clone for every user who
		// happens to be out of scope for a record the clone never reads.
		// readComponentData resolves it record-independently.
		if (!(await getDataRecordGateAdmits(source, principal))) return emptyShell();
		// §7.4 per-COMPONENT schema ACL — defense-in-depth (AUTHZ-06). The `read`
		// handler's Gate A already checks (section_tipo, tipo) before routing here,
		// but the component get_data facade must ALSO self-gate: it emits a
		// component's data / datalist directly, and this branch is reachable for a
		// SYNTHETIC search_<n> id that skips the record gate above, so it must not
		// rely solely on an upstream gate to withhold a component the caller holds
		// level 0 on. Mirrors the section-read path's per-ddo ddoIsAuthorized
		// (read.ts:181). Level 0 ⇒ PHP empty shell (never the data), same as the
		// record-scope branch above — never a 403 that reveals the component exists.
		// The dd128 own-user-record rules apply first, as in Gate A: tool_user_admin
		// reads the actor's own name/email/password/image with a zero dd128 grant.
		if (typeof source.section_tipo === 'string' && typeof source.tipo === 'string') {
			const { getRecordComponentPermission } = await import('../security/permissions.ts');
			const level = await getRecordComponentPermission(
				principal,
				source.section_tipo,
				source.tipo,
				source.section_id,
			);
			if (level < 1) {
				return emptyShell();
			}
		}
		// THE EXTERNAL-MIRROR REFRESH (the portal's "update external data"
		// button, source.build_options.get_data_external — PHP
		// component_portal_json.php :97): recompute the requested external
		// mirror BEFORE it is read, AWAITED to commit, so the read below serves
		// the fresh row (this branch opens no record memo). Here — the top-level
		// component get_data only, after the record gate and the level ≥ 1 check
		// above — and nowhere else: never a subdatum, a section read, a search or
		// a TM read (external_refresh.ts states every precondition). The read is
		// ALWAYS served; a refresh that did not run rides as a notice. Dynamic
		// import: the section/record write graph (import_scc_tripwire).
		const { maybeRefreshExternal } = await import('./record/external_refresh.ts');
		const refreshNotices = await maybeRefreshExternal(rqo, principal);
		const { readComponentData, buildGetDataContext } = await import('./read.ts');
		// component_filter_records' datalist rides the SHARED emission hook
		// (components/component_filter_records/emit.ts), so this door and the
		// section read serve the same key — PHP's single json builder.
		const componentData = await readComponentData(rqo);
		const componentContext = await buildGetDataContext(rqo, componentData, principal);
		return {
			status: 200,
			body: ok(
				{ context: componentContext, data: componentData },
				{ requestId, notices: joinNotices(refreshNotices) },
			),
		};
	}

	// A component-level get_data with NO section_id has no record to read
	// (a deep link that failed to carry the id, or a not-yet-saved record).
	// Return an empty component response rather than falling to readSection,
	// which requires an sqo and would 500 (PHP returns empty rows, not a crash).
	if (
		!isComponentSearch &&
		(source.action === 'get_data' || (source.model ?? '').startsWith('component_')) &&
		(source.section_id === undefined || source.section_id === null)
	) {
		return emptyShell();
	}

	// Release the reader's own stale edit locks on a section list read
	// (PHP force_unlock_all_components, dd_core_api:2321): navigating to a
	// list means the user is no longer editing. Best-effort — a lock
	// subsystem hiccup must never fail a read.
	try {
		const { forceUnlockAllComponents } = await import('./locks.ts');
		await forceUnlockAllComponents(principal.userId);
	} catch {
		// non-critical; TTL expiry + blur release still apply
	}

	// Pass the principal so the per-record projects filter applies
	// (non-admins never over-see records on a gated section, §7.4).
	const result = await readSection(rqo, principal);
	return { status: 200, body: ok(result, { requestId }) };
}
