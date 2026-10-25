/**
 * dd_core_api handlers (WS-C S2-25 extraction — bodies moved VERBATIM from
 * api/dispatch.ts; dispatch keeps registry assembly + gates + envelope).
 *
 * The `read` sub-action routing (relation-list / TM / resolve_data / get_data /
 * generic readSection) lives in the section facade —
 * src/core/section/read_facade.ts — so read semantics stay with the section
 * subsystem; this file keeps only the ACL gates and the menu/area model
 * dispatch that run BEFORE routing.
 */

import { config } from '../../../config/config.ts';
import { dispatchAreaRead, refuseAreaWrite } from '../../area/read.ts';
import { isAreaModel } from '../../concepts/area.ts';
import { isTemporalSource, type Rqo, type RqoSource } from '../../concepts/rqo.ts';
import { isConsultationOnlySection } from '../../concepts/section.ts';
import {
	canonicalizeStoredSectionId,
	classifyWireSectionId,
	coerceSectionId,
	isConvertibleSectionIdString,
	type WireSectionId,
} from '../../concepts/section_id.ts';
import { getSectionTipos } from '../../concepts/sqo.ts';
import { ok } from '../../errors/convert.ts';
import { DedaloError } from '../../errors/dedalo_error.ts';
import { specOf } from '../../errors/registry.ts';
import { currentApplicationLang, currentDataLang } from '../../resolve/request_lang.ts';
import { withTimeMachineReadScope } from '../../section/list_definitions/time_machine_list.ts';
import { gateTimeMachineRead, routeSectionRead } from '../../section/read_facade.ts';
import {
	type ChangedDataItem,
	isLangSlicedModel,
	saveComponentData,
} from '../../section/record/save_component.ts';
import {
	getPermissions,
	getRecordComponentPermission,
	type Principal,
} from '../../security/permissions.ts';
import { getTermByLocator, getTermTipos } from '../../ts_object/term_resolver.ts';
import {
	type ActionHandler,
	type ApiRequestContext,
	requirePrincipal,
} from '../handler_context.ts';
import type { ApiResult } from '../response.ts';
import { normalizeTermLocators } from './section_terms.ts';

/** PHP safe_tipo grammar (shared/core_functions.php:2296). */
const SAFE_TIPO = /^[a-z]{2,}[0-9]+$/;

/**
 * get_indexation_grid's page when the client sends no limit (the thesaurus
 * "show indexations" page) — a door default, still bounded by the client
 * ceiling (clampClientPage).
 */
const INDEXATION_GRID_DEFAULT_LIMIT = 500;

/** The related search's owning-section wildcard (relation_list.js, build_graph_data.js send ['all']). */
const RELATED_ALL_SECTIONS = 'all';

/**
 * THE HOST GATE of the related search (sqo.mode 'related') — D3, 2026-10-21.
 * The related search answers "which records point AT these hosts": its
 * `section_tipo` axis is the OWNING sections, and the panel and the graph send
 * the literal ['all'], which is no section and no grant can name. What the
 * caller must be allowed to read is each HOST locator's section
 * (`filter_by_locators`); the owning records are then scoped row by row by the
 * related search's own predicate (D1, security/record_scope.ts rowScopeFor).
 *
 * Returns true when the sqo is a related search WITH hosts, all readable (the
 * caller may then skip the literal 'all' in its per-target gate); false for any
 * other sqo — a related sqo with no host keeps the literal gate, so 'all' never
 * passes on its own. Throws `perm.denied` on the first unreadable host. Shared
 * by read's Gate B and count, so the two can never gate differently.
 * Wire: WC-2026-10-22-related-search-one-scope.
 */
async function gateRelatedHosts(sqo: unknown, principal: Principal): Promise<boolean> {
	const related = sqo as { mode?: unknown; filter_by_locators?: unknown };
	if (related.mode !== 'related' || !Array.isArray(related.filter_by_locators)) return false;
	const hostSectionTipos = (related.filter_by_locators as { section_tipo?: unknown }[])
		.map((locator) => locator?.section_tipo)
		.filter((tipo): tipo is string => typeof tipo === 'string');
	if (hostSectionTipos.length === 0) return false;
	for (const hostSectionTipo of new Set(hostSectionTipos)) {
		const level = await getPermissions(principal, hostSectionTipo, hostSectionTipo);
		if (level < 1) {
			throw new DedaloError('perm.denied', { coordinates: { section_tipo: hostSectionTipo } });
		}
	}
	return true;
}

/**
 * Gate A: the request source (section_tipo, tipo). For a dd15 source the level
 * is the Time Machine floor, which reads the TM scope — so the caller must run
 * this inside withTimeMachineReadScope. The dd128 own-user-record rules apply
 * first (PHP resolve_component_read_permission): tool_user_admin reads the
 * actor's own name/email/password/image, which most profiles grant 0 on.
 */
async function gateReadSource(source: RqoSource, principal: Principal): Promise<void> {
	if (source.section_tipo === undefined || source.tipo === undefined) return;
	const level = await getRecordComponentPermission(
		principal,
		source.section_tipo,
		source.tipo,
		source.section_id,
	);
	if (level < 1) {
		throw new DedaloError('perm.denied', {
			coordinates: { section_tipo: source.section_tipo, tipo: source.tipo },
		});
	}
}

/**
 * Gate B: every SQO target section, self-keyed — except the related search's
 * literal 'all' (D3, 2026-10-21), which is not a section: for mode 'related'
 * the gate is the HOST locators' sections, and the owning records are scoped
 * row by row by the related search's own predicate (D1).
 */
async function gateReadTargets(sqo: Rqo['sqo'], principal: Principal): Promise<void> {
	if (sqo === undefined) return;
	const relatedHosts = await gateRelatedHosts(sqo, principal);
	for (const targetSectionTipo of getSectionTipos(sqo)) {
		if (relatedHosts && targetSectionTipo === RELATED_ALL_SECTIONS) continue;
		const level = await getPermissions(principal, targetSectionTipo, targetSectionTipo);
		if (level < 1) {
			throw new DedaloError('perm.denied', { coordinates: { section_tipo: targetSectionTipo } });
		}
	}
}

/**
 * The generic section read behind its permission gates (BEFORE any search/DB
 * work — PHP build_json_rows gate A + the per-sqo-target gate). Runs inside
 * the request's TM scope (see the read handler).
 */
async function readGatedSection(
	rqo: Rqo,
	context: Parameters<ActionHandler>[1],
	principal: Principal,
): Promise<ApiResult> {
	await gateReadSource(rqo.source ?? {}, principal);
	await gateReadTargets(rqo.sqo, principal);

	// Sub-action routing + the generic section read live in the section
	// facade (S2-25) — everything below the gates is section semantics.
	const readResult = await routeSectionRead(rqo, principal);
	// LOAD activity (PHP dd_core_api::read :771 → log_activity): every
	// section/area page load appends a 'LOAD EDIT'/'LOAD LIST' audit row keyed
	// by the SECTION tipo. This is the stream the dashboard timeline aggregates
	// (metricActivity filters WHERE ∈ child sections) — without it the activity
	// card is permanently empty (only component-keyed SAVE rows exist, which
	// the section filter correctly ignores).
	await logReadActivity(rqo, principal, context, readResult);
	return readResult;
}

/**
 * The generic count behind the read's gates: Gate B on every SQO target, then
 * the §7.4 Time Machine admission gate (a no-op for a non-TM SQO) — the same
 * decision the read takes. Runs inside the request's TM scope.
 */
async function countGatedRows(
	rqo: Rqo,
	clientSqo: NonNullable<Rqo['sqo']>,
	context: Parameters<ActionHandler>[1],
	principal: Principal,
): Promise<ApiResult> {
	for (const targetSectionTipo of getSectionTipos(clientSqo)) {
		const level = await getPermissions(principal, targetSectionTipo, targetSectionTipo);
		if (level < 1) {
			throw new DedaloError('perm.denied', { coordinates: { section_tipo: targetSectionTipo } });
		}
	}
	await gateTimeMachineRead(rqo, principal);
	// The read STRATEGY owns counting: the default matrix source runs the
	// SQO full_count; the dd15 TM source counts matrix_time_machine with the
	// same scoping as its read (pagination parity — the generic SQO count
	// would hit the wrong table).
	const { sanitizeClientSqo } = await import('../../concepts/sqo.ts');
	const { pickReadSource } = await import('../../section/read_source.ts');
	const sqo = sanitizeClientSqo(structuredClone(clientSqo) as Record<string, unknown>);
	const readSource = await pickReadSource((clientSqo as { mode?: string }).mode);
	// The same subdatum read floor the rows read applies (SEC-1): a count
	// that refused what the page served would paginate a different set.
	const { subdatumReadFloor } = await import('../../security/read_floor.ts');
	const readFloor = await subdatumReadFloor(principal, rqo.source);
	const total = await readSource.count(sqo, principal, readFloor);
	return { status: 200, body: ok({ total }, { requestId: context.requestId }) };
}

/** dd_core_api action handlers, keyed by action (registered in dispatch.ts). */
export const coreApiActions: Record<string, ActionHandler> = {
	read: async (rqo, context) => {
		// Permission gates BEFORE any search/DB work (PHP build_json_rows
		// gate A + per-sqo-target gate). The session is guaranteed here (read
		// is not in NO_LOGIN_ACTIONS).
		const principal = requirePrincipal(context);

		// Menu read (PHP menu::get_json). Navigation, not a section: it carries
		// its own fixed permission (level 2), so it is resolved BEFORE the
		// section permission gates rather than through the dd774 matrix.
		if ((rqo.source?.model ?? '') === 'menu') {
			return await readMenu(rqo, context, principal);
		}

		// Area-model reads (PHP area_*_json controllers) — tree areas
		// (thesaurus/ontology boot data), maintenance (widget catalog), and
		// — Phase B — the dashboard. dispatchAreaRead returns null for
		// dashboard-behavior areas until that engine lands, so they fall
		// through to the generic path exactly as before (engineering/AREA_SPEC.md §2).
		if (isAreaModel(rqo.source?.model ?? '')) {
			const areaResult = await dispatchAreaRead(rqo, principal);
			if (areaResult !== null) {
				await logReadActivity(rqo, principal, context, areaResult);
				return areaResult;
			}
		}

		// ONE Time Machine scope for the WHOLE gated read
		// (WC-2026-10-22-tm-scope-whole-request): Gate A's dd15 floor, Gate B,
		// the §7.4 admission gate and the per-ddo floor all judge the caller
		// section the SQO proves. Opened only inside readSection, Gate A ran
		// unscoped and refused every non-admin — grant or no grant.
		return withTimeMachineReadScope(rqo.sqo, () => readGatedSection(rqo, context, principal));
	},
	save: async (rqo, context) => {
		// State-changing action: CSRF is enforced by the dispatch gate
		// (save is NOT in CSRF_EXEMPT_ACTIONS). Permission gate: level >= 2
		// on (section_tipo, component tipo) — PHP dd_core_api::save parity.
		const principal = requirePrincipal(context);
		const source = rqo.source ?? {};
		const dataPayload = (rqo.data ?? {}) as { changed_data?: ChangedDataItem[] };

		if (
			source.tipo === undefined ||
			source.section_tipo === undefined ||
			source.section_id === undefined ||
			source.section_id === null
		) {
			throw new DedaloError('request.invalid_source', {
				message: 'save: source.tipo/section_tipo/section_id are required',
			});
		}
		// TEMPORAL instance (WC-059): a tool's throwaway editable clone addresses
		// NO record — its section_id is a client sentinel, not an address. Resolve
		// and echo, never persist. FIRST, so it also short-circuits the record
		// scope gate, the activity log and the Time Machine below: none of them
		// have a record to speak about. The gate is a READ level, not a write one
		// — nothing is written (same reasoning as the search_<n> branch).
		if (isTemporalSource(source)) {
			if (!Array.isArray(dataPayload.changed_data)) {
				throw new DedaloError('request.invalid_data', {
					message: 'save: data.changed_data must be an array',
				});
			}
			// A read grant is enough BECAUSE nothing is persisted — with one
			// exception: `add_new_element` really creates a record in the target
			// section. Admitting that at level 1 would be a read→create escalation,
			// since this branch deliberately short-circuits the level-2 gate, the
			// record-scope gate and refuseAreaWrite below. So the required level is
			// a function of what the batch actually does.
			const temporalCreates = dataPayload.changed_data.some(
				(change) => change.action === 'add_new_element',
			);
			const temporalLevel = await getPermissions(principal, source.section_tipo, source.tipo);
			if (temporalLevel < (temporalCreates ? 2 : 1)) {
				throw new DedaloError('perm.denied', {
					coordinates: {
						section_tipo: source.section_tipo,
						tipo: source.tipo,
						required: temporalCreates ? 2 : 1,
					},
				});
			}
			const { resolveTemporalSave } = await import('../../section/record/temporal.ts');
			return await resolveTemporalSave(rqo, principal);
		}
		await refuseAreaWrite(source.section_tipo, source.model);
		// ONE classification replaces the scattered `startsWith('search_')` sniffs
		// and the blind `Number(section_id)` casts below
		// (WC-2026-08-10-section-id-int-canonical). Branch parity with the sniff
		// era: 'record' → the write path (as the coerced int every downstream
		// consumer shares), 'synthetic'/'external-ref' → the non-persisting
		// resolve+echo branch, 'absent' → the required-field refusal. Deliberate,
		// WC-noted divergences: '' is 'absent' (the NaN era read record 0 via
		// Number('') === 0) and numeric-shaped junk ('007') refuses loudly instead
		// of silently becoming record 7. Classified AFTER the temporal branch so
		// the WC-059 sentinel never reaches the classifier.
		let wireId: WireSectionId;
		try {
			wireId = await classifyWireSectionId(
				source.section_id,
				source.section_tipo,
				'rqo.dd_core_api.save.section_id',
			);
		} catch (error) {
			// The classifier's own message names the offending value — LOG-ONLY
			// (coordinates + cause); the wire carries the registry sentence.
			throw new DedaloError('section_id.not_an_address', {
				cause: error,
				coordinates: {
					section_tipo: source.section_tipo,
					section_id: JSON.stringify(source.section_id ?? null),
				},
			});
		}
		if (wireId.kind === 'absent') {
			// '' lands here (the required-guard above only catches undefined/null).
			throw new DedaloError('request.invalid_source', {
				message: 'save: source.tipo/section_tipo/section_id are required',
			});
		}
		// Consultation-only sections (Activity dd542, Time Machine dd15, …) are
		// read-only regardless of any component-level grant (PHP dd_core_api:1330
		// "Illegal save to activity"). Only a RECORD-addressed save is a write:
		// synthetic ids (the search/list-preset flow within the section's list
		// view) land in the resolve+echo branch below, which persists nothing —
		// that is the old search_* exception, stated by kind instead of by prefix.
		// The write ENGINE (saveComponentData) enforces the same rule for
		// MCP/agent doors.
		if (isConsultationOnlySection(source.section_tipo) && wireId.kind === 'record') {
			throw new DedaloError('perm.denied', {
				message: `Illegal save to read-only section '${source.section_tipo}'`,
				coordinates: { section_tipo: source.section_tipo },
			});
		}
		// SEARCH-MODE relation link (portal/relation link_record + unlink_record):
		// the picker lands on a CLIENT-MINTED synthetic id ('search_<n>', search.js
		// get_section_id) that is NOT a matrix row. The picked locator is a search
		// FILTER (client entries → preset JSON → RQO q), never a persisted relation —
		// so RESOLVE it for the chip and ECHO it WITHOUT writing. The write path would
		// materialize the host record (createSectionRecord), which fails on the NaN id
		// and THROWS a 500 on read-only sections (Activity dd542 / Time Machine dd15).
		// Mirrors the resolve_data action; a read grant (>= 1) is enough — nothing is
		// written, and resolveSearchData applies its own per-target projects ACL.
		// The merge + resolve + echo is the shared non-persisting core
		// (section/record/resolve_echo.ts), which the temporal door reuses.
		// An external-service ref ('001338683', 'Q42') addresses no matrix row
		// either, so it takes the same never-write branch (the classifier's
		// BRANCH PARITY LAW).
		if (wireId.kind === 'synthetic' || wireId.kind === 'external-ref') {
			return resolveNonRecordSave(rqo, source, dataPayload, principal);
		}
		// From here down the save addresses a real record: the ONE coerced int that
		// the permission resolver, scope gate, write engine, audit row and echo all
		// share (the era of each site running its own Number()/String() is over).
		const sectionId = wireId.id;
		// THE WRITE DOOR (closure Step 3; WC-2026-09-30-write-door) — the ONE
		// order every record-addressed write shares: the (section, component) pair
		// through getRecordComponentPermission (the dd128 OWN-record rules run
		// BEFORE the matrix level and both raise and lower it — the DOWNGRADE is the
		// security half: without it a dd128 write grant sets its own profile or
		// developer flag; the UPGRADE is what makes tool_user_admin work, since most
		// profiles grant 0 on dd128), then the per-record write-target gate (PHP
		// assert_record_in_user_scope; the non-positive-id refusal AHEAD of the
		// admin bypass — SEC-05 — with the one self-service exception for an
		// account's own name/email/password/image, isSelfServiceAccountWrite).
		//
		// sectionFloor 0 — A NAMED EXCEPTION (write_door SECTION_FLOOR_ZERO_DOORS:
		// this door and its twin, dd_component_text_area_api.delete_tag; any other
		// door asking floor 0 is refused as internal.invariant): this door does not
		// ask the SECTION grant. PHP component_common::save asks the component
		// permission only, and inline editing of a subdatum portal TARGET (a
		// component of a section the profile holds 0 on, reached through a portal
		// the profile may edit) depends on it. Converging it to 1 is an owner-review
		// item of WC-2026-09-30-write-door, not a silent change here.
		const { authorizeRecordAccess } = await import('../../security/write_door.ts');
		await authorizeRecordAccess(
			principal,
			{ section_tipo: source.section_tipo, component_tipo: source.tipo, section_id: sectionId },
			{ mode: 'write', level: 2, sectionFloor: 0, door: 'save' },
		);
		if (!Array.isArray(dataPayload.changed_data)) {
			throw new DedaloError('request.invalid_data', {
				message: 'save: data.changed_data must be an array',
			});
		}

		const outcome = await saveComponentData({
			componentTipo: source.tipo,
			sectionTipo: source.section_tipo,
			sectionId,
			lang: source.lang ?? 'lg-nolan',
			changedData: dataPayload.changed_data,
			userId: principal.userId,
			// The actor the relation-insert read-grant gate judges — explicit, so
			// the write path never depends on ambient ALS state alone.
			principal,
			// Dataframe saves carry the pairing context (PHP source.caller_dataframe).
			callerDataframe:
				(
					source as {
						caller_dataframe?: { main_component_tipo?: string; id_key?: number | string };
					}
				).caller_dataframe ?? null,
		});
		if (!outcome.ok) {
			throw new DedaloError('record.save_failed', {
				message: `save failed: ${outcome.message}`,
				coordinates: {
					section_tipo: source.section_tipo,
					section_id: sectionId,
					tipo: source.tipo,
				},
			});
		}
		// Server-side observers (PHP propagate_to_observers) fire INSIDE the
		// saveComponentData chokepoint (post-commit — every save door
		// propagates, not just this one; 2026-07-24). The alias→data-tipo hop
		// happens there too (WC-020: observers watch the DATA component).
		// Same-record observer items (component_info recomputes) ride the
		// response data below (PHP observers_data merge — the client
		// refreshes the info widget in place).
		const observersData: unknown[] = outcome.observersData ?? [];
		// Activity audit (PHP logger 'SAVE' code 5) — never fails the save.
		{
			const { logActivity, hostFromClientIp } = await import('./activity_log.ts');
			const { getModelByTipo, getMatrixTableFromTipo } = await import('../../ontology/resolver.ts');
			const host = hostFromClientIp(context.clientIp);
			await logActivity({
				what: 'SAVE',
				tipo: source.tipo,
				userId: principal.userId,
				host,
				data: {
					msg: 'Saved component data',
					lang: source.lang ?? 'lg-nolan',
					tipo: source.tipo,
					table: (await getMatrixTableFromTipo(source.section_tipo)) ?? 'matrix',
					// int, repealing the String() minting: a record address is emitted
					// in canonical form (WC-2026-08-10-section-id-int-canonical).
					section_id: sectionId,
					section_tipo: source.section_tipo,
					component_name: (await getModelByTipo(source.tipo)) ?? '',
				},
			});
		}
		// Return the saved component in the canonical DataItem shape the client
		// resolves by (component_common.js save()/build(): result.data.find(el =>
		// el.tipo===tipo && el.section_tipo===… && String(el.section_id)===…)).
		// PHP's save echoes this same {tipo, section_tipo, section_id, entries}
		// envelope; returning the bare items array left the client's .find()
		// empty, so the echoed value never round-tripped (client test suite:
		// "<component>. Data save using API").
		const { buildDataItem, filterItemsByLang } = await import('../../resolve/component_data.ts');
		// LANG SLICE — the echo must be the READ's twin. saveComponentData returns
		// the component's FULL item array (every language in one flat array, its
		// documented contract); the edit read emits only the request-lang slice
		// (resolveComponentValue). Echoing the full array made the client's
		// post-save `self.data = result.data.find(…)` swap a one-language entries
		// array for all of them — visible in the ontology tree, whose inline term
		// editor relabels the node by joining data.entries (ts_object.js), so a
		// term edit repainted "فهرس Inventari Katalog …" (2026-08-03). Same
		// predicate + effective lang as the write engine itself (isLangSlicedModel
		// / translatable-or-iri, PHP get_element_lang).
		const savedLang = source.lang ?? 'lg-nolan';
		let savedItems = Array.isArray(outcome.data) ? outcome.data : [];
		{
			const { getModelByTipo, effectiveSaveLang } = await import('../../ontology/resolver.ts');
			const echoModel = await getModelByTipo(source.tipo);
			if (echoModel !== null && isLangSlicedModel(echoModel)) {
				const echoLang = await effectiveSaveLang(source.tipo, echoModel, savedLang);
				savedItems = filterItemsByLang(savedItems, echoLang);
			}
		}
		// Relation saves echo context too (populated in the block below); [] for scalars.
		let savedContext: unknown[] = [];
		let savedDataItem = buildDataItem(
			source.tipo,
			source.section_tipo,
			sectionId,
			'edit',
			source.lang ?? 'lg-nolan',
			savedItems,
		);
		// The full response data payload: [main item] for scalars; for relation
		// saves the main item PLUS the linked targets' subdatum (below).
		let savedData: unknown[] = [savedDataItem];
		// Select-family AND filter-family components re-render from data.datalist
		// after a save (e.g. component_radio_button get_checked_value_label reads
		// self.data.datalist; view_default_edit_filter iterates it); the edit read
		// attaches it, so the save echo must too or the post-save render
		// dereferences undefined (client suite test_component_radio_button reset
		// flow). getEchoDatalist is the ONE router: select family → getEditDatalist,
		// filter family → its user-scoped sources.
		{
			const { echoesDatalist, getEchoDatalist } = await import('../../relations/datalist.ts');
			const { getModelByTipo, getNode, getColumnNameByModel } = await import(
				'../../ontology/resolver.ts'
			);
			const savedModel = await getModelByTipo(source.tipo);
			if (savedModel !== null && (await echoesDatalist(savedModel))) {
				// The edit door: the read's options completed against the SAVED
				// value (select_lang's "<name> *" entry), so echo == read.
				const savedNode = await getNode(source.tipo);
				(savedDataItem as { datalist?: unknown }).datalist = await getEchoDatalist(
					savedModel,
					source.tipo,
					savedNode?.properties ?? null,
					source.section_tipo,
					source.lang ?? 'lg-nolan',
					savedItems,
				);
			}
			// Relation-column components (portal / relation_*): the client reuses the
			// save response as a BUILD response — link_record/unlink_record → refresh
			// → build_autoload reads result.context.length (component_portal.js:632)
			// and result.data.find(...).pagination.total (…:1063). The edit read emits
			// both (buildGetDataContext, relation_core.ts:140); the save echo must too
			// or the write op crashes / sees total:0 and returns false.
			const isRelationSave = savedModel !== null && getColumnNameByModel(savedModel) === 'relation';
			if (isRelationSave) {
				(savedDataItem as { pagination?: unknown }).pagination = {
					total: savedItems.length,
					limit: savedItems.length,
					offset: 0,
				};
				// PHP save answers get_json: the payload carries the component's
				// FULL resolved data — the main item plus the linked targets'
				// per-ddo subdatum values — so the client's link_record
				// refresh({tmp_api_response}) renders the picked chip WITHOUT a
				// second request (found live 2026-07-09: the picker link saved but
				// stayed blank until reload). Reuse the get_data pipeline; on any
				// resolution hiccup keep the bare echo (never fail a durable save).
				try {
					const { readComponentData } = await import('../../section/read.ts');
					const findMain = (items: unknown[]) =>
						items.find(
							(item) =>
								(item as { tipo?: string }).tipo === source.tipo &&
								// String-compare on BOTH sides: stored items may still carry the
								// legacy string form until the repair sweep lands (WC-2026-08-10).
								String((item as { section_id?: unknown }).section_id) === String(sectionId),
						);
					// PHP pagination sync (dd_core_api::save :1453): the save rqo carries
					// NO sqo, so the read would page at the component's config limit —
					// but the client ships its CURRENT pagination in `data` (clone of
					// self.data), and its limit is the page size the portal is actually
					// showing (0/'show all' included). Honour it, as PHP did.
					const clientLimit = (rqo.data as { pagination?: { limit?: unknown } } | undefined)
						?.pagination?.limit;
					const echoRqo =
						typeof clientLimit === 'number'
							? ({
									...rqo,
									sqo: {
										...(rqo.sqo ?? {}),
										section_tipo: source.section_tipo,
										limit: clientLimit,
									},
								} as typeof rqo)
							: rqo;
					let fullData = await readComponentData(echoRqo);
					let mainItem = findMain(fullData);
					// PHP :1459-1479 — after an ADD or a LINK the echo must answer the
					// LAST page, where the appended locator lives. The echo becomes the
					// client's next self.data, and the add button reads the new record as
					// `entries[entries.length-1]` (component_portal/js/buttons.js): on a
					// paginated portal a page-one echo made that the FIRST linked record,
					// so the modal opened the wrong one (oh1/oh17, `limit: 1`, reported
					// 2026-07-31). It also puts the paginator on the page the user is now
					// looking at instead of snapping back to page one.
					const firstAction = dataPayload.changed_data[0]?.action ?? null;
					if (
						(firstAction === 'add_new_element' || firstAction === 'insert') &&
						mainItem !== undefined
					) {
						const pagination = (
							mainItem as {
								pagination?: { total?: number; limit?: number; offset?: number };
							}
						).pagination;
						const total = pagination?.total ?? 0;
						const pageLimit = pagination?.limit ?? 0;
						// 'Show all' (limit clamped above the total) is a single page → 0.
						const lastPageOffset =
							pageLimit > 0 && pageLimit < total
								? pageLimit * (Math.ceil(total / pageLimit) - 1)
								: 0;
						if (lastPageOffset !== (pagination?.offset ?? 0)) {
							const lastPageData = await readComponentData({
								...echoRqo,
								sqo: {
									...(echoRqo.sqo ?? {}),
									section_tipo: source.section_tipo,
									limit: pageLimit,
									offset: lastPageOffset,
								},
							} as typeof rqo);
							const lastPageMain = findMain(lastPageData);
							if (lastPageMain !== undefined) {
								fullData = lastPageData;
								mainItem = lastPageMain;
							}
						}
					}
					if (mainItem !== undefined) {
						const carriedDatalist = (savedDataItem as { datalist?: unknown }).datalist;
						if (carriedDatalist !== undefined) {
							(mainItem as { datalist?: unknown }).datalist = carriedDatalist;
						}
						savedDataItem = mainItem as typeof savedDataItem;
						savedData = fullData;
					}
				} catch {
					// bare echo fallback — the save itself is already durable
				}
				const { buildGetDataContext } = await import('../../section/read.ts');
				savedContext = await buildGetDataContext(rqo, savedData as never, principal);
			}
			// SCALAR saves: dispatch the model's emit-hook decorateItem on the
			// echoed item (registry facet, no model conditional — S2-24), the
			// same decoration the edit read applies. Without it the echo
			// REPLACES the client's data with an undecorated item and every
			// per-model extra silently vanishes on save — found live 2026-07-29:
			// component_text_area's tags_persons/related_sections feed
			// disappeared after the first save, killing the person button (and
			// tag insertion with it) until a full reload. Relation saves above
			// already reuse the full get_data pipeline, hooks included. Best
			// effort: a decoration hiccup never fails a durable save.
			if (!isRelationSave) {
				try {
					const { getEmitHook } = await import('../../components/emit_hooks.ts');
					const hook = savedModel !== null ? getEmitHook(savedModel) : undefined;
					if (hook?.decorateItem !== undefined) {
						const { getMatrixTableFromTipo: tableFromTipo } = await import(
							'../../ontology/resolver.ts'
						);
						const { readMatrixRecord } = await import('../../db/matrix.ts');
						const { EmissionContext } = await import('../../resolve/component_data.ts');
						const table = await tableFromTipo(source.section_tipo);
						const record =
							table === null ? null : await readMatrixRecord(table, source.section_tipo, sectionId);
						if (record !== null) {
							const lang = source.lang ?? 'lg-nolan';
							await hook.decorateItem(savedDataItem as never, {
								ddo: {
									tipo: source.tipo,
									section_tipo: source.section_tipo,
									mode: 'edit',
								} as never,
								record,
								row: { section_tipo: source.section_tipo, section_id: sectionId },
								model: savedModel as string,
								ddoMode: 'edit',
								ddoLang: lang,
								defaultMode: 'edit',
								defaultLang: lang,
								callerTipo: source.section_tipo,
								emission: new EmissionContext([savedDataItem as never]),
							});
						}
					}
				} catch (error) {
					console.error(
						'[save] emit-hook decoration of the save echo failed (echo kept bare):',
						error,
					);
				}
			}
		}
		// PHP observers_data merge (:1503): the same-record recomputed observer
		// items append AFTER the saved component's own data.
		if (observersData.length > 0) {
			savedData = [...savedData, ...observersData];
		}
		// created_section_id (WC-081, TS-native — PHP echoed no such key): the
		// ADDRESS of the record `add_new_element` just made in the target section.
		// The client's add button opened "the last echoed entry", which is only the
		// new record when the whole list fits on the echoed page — the address makes
		// it exact regardless of paging. Present ONLY when something was created.
		const createdSectionId = outcome.created_section_id;
		return {
			status: 200,
			body: ok(
				{
					context: savedContext,
					data: savedData,
					...(createdSectionId !== undefined ? { created_section_id: createdSectionId } : {}),
				},
				{ requestId: context.requestId },
			),
		};
	},
	read_raw: async (rqo, context) => {
		// Raw stored value(s) for a SQO's matched records (PHP read_raw).
		// Read-only; permission gate level >= 1 on every SQO target section.
		const principal = requirePrincipal(context);
		const options = (rqo.options ?? {}) as {
			section_tipo?: string;
			tipo?: string;
			model?: string;
			type?: string;
		};
		if (options.section_tipo === undefined) {
			throw new DedaloError('request.invalid_source', {
				message: 'read_raw: options.section_tipo is required',
			});
		}
		if (options.tipo === undefined) {
			throw new DedaloError('request.invalid_source', {
				message: 'read_raw: options.tipo is required',
			});
		}
		const targets = rqo.sqo !== undefined ? getSectionTipos(rqo.sqo) : [options.section_tipo];
		for (const targetSectionTipo of targets) {
			const level = await getPermissions(principal, targetSectionTipo, targetSectionTipo);
			if (level < 1) {
				throw new DedaloError('perm.denied', {
					coordinates: { section_tipo: targetSectionTipo },
				});
			}
		}
		const { readRaw } = await import('./read_raw.ts');
		const { readDoorNotices } = await import('../../security/read_door.ts');
		const outcome = await readRaw(
			{
				sectionTipo: options.section_tipo,
				tipo: options.tipo,
				model: options.model,
				type: options.type,
				sqo: rqo.sqo,
			},
			principal,
		);
		// P1-3: the per-component key inside readRaw may have NARROWED the rows
		// (a refused key is absent / null). Never silently: one notice per request.
		const notices = readDoorNotices();
		return {
			status: 200,
			// `table` is an owned top-level extension key (the client + the raw view
			// read it by name); the raw rows are the payload.
			body: ok(outcome.result, {
				requestId: context.requestId,
				extend: { table: outcome.table },
				...(notices === undefined ? {} : { notices }),
			}),
		};
	},
	create: async (rqo, context) => {
		// Create a new section record (PHP dd_core_api::create → create_record).
		// State-changing: CSRF enforced by the dispatch gate; permission gate
		// level >= 2 on (section_tipo, section_tipo). Returns the new section_id.
		const principal = requirePrincipal(context);
		const source = rqo.source ?? {};
		const sectionTipo = source.section_tipo;
		if (sectionTipo === undefined) {
			throw new DedaloError('request.invalid_source', {
				message: 'create: source.section_tipo is required',
			});
		}
		// WC-059: a temporal instance addresses no record, so a record-lifecycle
		// action on one is nonsense. Refusing is cheaper than reasoning about it,
		// and it keeps "every record-addressing door consults isTemporalSource"
		// literally true (temporal_instance_tripwire).
		if (isTemporalSource(source)) {
			throw new DedaloError('request.invalid_source', {
				message: 'create: temporal instances cannot create records',
			});
		}
		await refuseAreaWrite(sectionTipo, source.model);
		// THE WRITE DOOR (closure Step 3): a create names no record, so the
		// consultation-capped SECTION level is its whole authorization — the one
		// rule the duplicate / delete doors and the MCP create share (PHP
		// section::create_record:452 refusal on Activity/TM); the
		// createSectionRecord engine backstops it for other doors.
		const { authorizeSectionTarget } = await import('../../security/write_door.ts');
		const grant = await authorizeSectionTarget(
			principal,
			{ section_tipo: sectionTipo },
			{ level: 2, door: 'create' },
		);
		const { createSectionRecord } = await import('../../section/record/create_record.ts');
		const sectionId = await createSectionRecord(grant.sectionTipo, principal.userId);

		// The 'NEW' activity row is appended by createSectionRecord itself (P1-8 /
		// DATA-19, 2026-09-03): it used to live at this door "because the engine has
		// no client host of its own", which left the duplicate door, the MCP create
		// and the portal "+" each to remember it (duplicate never did). The engine
		// reads the host from the request scope (currentRequestContext) — the same
		// clientIp this handler holds. SAVE and DELETE rows stay at their doors:
		// their payloads are the door's own (the oracle's per-component shape).
		return { status: 200, body: ok(sectionId, { requestId: context.requestId }) };
	},
	duplicate: async (rqo, context) => {
		// Clone a record into a NEW one (PHP dd_core_api::duplicate). WRITE
		// permission required — duplication spawns records, so read-only users
		// must be refused (PHP §5.2 note). Non-admins must also be in the
		// source record's project scope (assert_record_in_user_scope) — that
		// per-record gate is enforced here via a principal-scoped existence
		// search when the caller is not a global admin.
		const principal = requirePrincipal(context);
		const source = rqo.source ?? {};
		const sectionTipo = source.section_tipo;
		if (sectionTipo === undefined) {
			throw new DedaloError('request.invalid_source', {
				message: 'duplicate: source.section_tipo is required',
			});
		}
		if (source.section_id === undefined || source.section_id === null) {
			throw new DedaloError('request.invalid_source', {
				message: 'duplicate: source.section_id is required',
			});
		}
		// WC-059 — see the create door.
		if (isTemporalSource(source)) {
			throw new DedaloError('request.invalid_source', {
				message: 'duplicate: temporal instances cannot duplicate records',
			});
		}
		await refuseAreaWrite(sectionTipo, source.model);
		// Coerce at the door (counted, deprecable string form) instead of the blind
		// Number() that minted NaN for junk (WC-2026-08-10-section-id-int-canonical).
		// A non-address refuses loudly here; the sniff era let NaN ride into the
		// scope gate / duplicate engine.
		let sourceSectionId: number;
		try {
			sourceSectionId = coerceSectionId(source.section_id, 'rqo.dd_core_api.duplicate.section_id');
		} catch (error) {
			throw new DedaloError('section_id.not_an_address', {
				cause: error,
				coordinates: {
					section_tipo: sectionTipo,
					section_id: JSON.stringify(source.section_id ?? null),
				},
			});
		}
		// THE WRITE DOOR (closure Step 3): the SECTION level, consultation-capped
		// (Activity/TM cap at read → duplicate refused; the duplicateSectionRecord
		// engine backstops the same rule for other doors), then the per-record
		// write-target gate: the source must be visible under the caller's
		// projects filter (PHP assert_record_in_user_scope), and no caller — global
		// admin included — may duplicate a non-positive section_id. SEC-05's second
		// consequence lived here: duplicating dd128/-1 copies the whole `string`
		// column, minting a positive-id user record carrying ROOT's Argon2 hash and
		// root's username, and duplicate bypasses saveComponentData so dd132's
		// `unique` check never runs.
		{
			const { authorizeSectionRecord } = await import('../../security/write_door.ts');
			await authorizeSectionRecord(
				principal,
				{ section_tipo: sectionTipo, section_id: sourceSectionId },
				{ level: 2, door: 'duplicate' },
			);
		}
		const { duplicateSectionRecord } = await import('../../section/record/duplicate_record.ts');
		const newSectionId = await duplicateSectionRecord(
			sectionTipo,
			sourceSectionId,
			principal.userId,
		);
		return { status: 200, body: ok(newSectionId, { requestId: context.requestId }) };
	},
	delete: async (rqo, context) => {
		// Delete a section record (PHP dd_core_api::delete): delete_record
		// removes the row (TM snapshot first); delete_data (the PHP DEFAULT)
		// keeps the row and empties every component. State-changing: CSRF
		// enforced; permission gate level >= 2 on the section. Multi-record
		// sqo deletes are ledgered.
		const principal = requirePrincipal(context);
		const source = (rqo.source ?? {}) as {
			tipo?: string;
			section_tipo?: string;
			/** Raw wire value — unknown until coerceSectionId classifies it below. */
			section_id?: unknown;
			delete_mode?: string;
		};
		const sectionTipo = source.section_tipo ?? source.tipo;
		const deleteMode = source.delete_mode ?? 'delete_data';
		// PHP :1214 — the caller may accept subtree orphaning explicitly.
		const deleteWithChildren =
			(rqo.options as { delete_with_children?: boolean } | undefined)?.delete_with_children ===
			true;
		if (sectionTipo === undefined) {
			throw new DedaloError('request.invalid_source', {
				message: 'delete: source.section_tipo is required',
			});
		}
		// WC-059 — see the create door.
		if (isTemporalSource(rqo.source)) {
			throw new DedaloError('request.invalid_source', {
				message: 'delete: temporal instances cannot delete records',
			});
		}
		await refuseAreaWrite(sectionTipo, (rqo.source as { model?: string })?.model);
		if (deleteMode !== 'delete_record' && deleteMode !== 'delete_data') {
			throw new DedaloError('request.invalid_options', {
				// Public disclosure: the sentence states the CLOSED set, never the
				// rejected value (which is caller data).
				publicMessage: "source.delete_mode must be 'delete_record' or 'delete_data'",
				message: `delete: unknown delete_mode '${deleteMode}'`,
			});
		}
		const hasSqo = rqo.sqo !== undefined && rqo.sqo !== null;
		if ((source.section_id === undefined || source.section_id === null) && !hasSqo) {
			throw new DedaloError('request.invalid_source', {
				message: 'delete: source.section_id or rqo.sqo is required',
			});
		}
		// The level + scope gates run per branch below, through the write door:
		// a named record is a record target (authorizeSectionRecord — the id is
		// required by the door), an SQO multi-delete a section target.
		const { authorizeSectionRecord, authorizeSectionTarget } = await import(
			'../../security/write_door.ts'
		);
		const { deleteSectionRecord, deleteSectionData } = await import(
			'../../section/record/delete_record.ts'
		);
		// Targets: the explicit section_id, or the SQO's matched records
		// (PHP sections::delete runs the search then deletes each row).
		// Multi-record deletes are a GLOBAL-ADMIN operation (fail closed).
		let targets: number[];
		if (source.section_id !== undefined && source.section_id !== null) {
			// Coerce at the door (counted, deprecable string form) instead of the
			// blind Number() that minted NaN for junk
			// (WC-2026-08-10-section-id-int-canonical). Loud refusal; the sniff era
			// let NaN ride into the scope gate / delete engines.
			let targetId: number;
			try {
				targetId = coerceSectionId(source.section_id, 'rqo.dd_core_api.delete.section_id');
			} catch (error) {
				throw new DedaloError('section_id.not_an_address', {
					cause: error,
					coordinates: {
						section_tipo: sectionTipo,
						section_id: JSON.stringify(source.section_id ?? null),
					},
				});
			}
			// THE WRITE DOOR (closure Step 3): the SECTION level, consultation-capped
			// (Activity/TM cap at read → delete refused; the delete engines backstop
			// the same rule for other doors), then the per-record write-target gate
			// (PHP assert_record_in_user_scope): a level-2 user may only delete
			// records inside their projects filter — the level gate alone would let
			// them delete a record they can never see (cross-project IDOR) — and no
			// caller, admins included, may address a non-positive section_id (SEC-05;
			// the delete ENGINES already refused it, this door did not).
			await authorizeSectionRecord(
				principal,
				{ section_tipo: sectionTipo, section_id: targetId },
				{ level: 2, door: 'delete' },
			);
			targets = [targetId];
		} else {
			// A section target (no record named): the consultation-capped section
			// level first, then the multi-delete's own admin rule.
			await authorizeSectionTarget(
				principal,
				{ section_tipo: sectionTipo },
				{ level: 2, door: 'delete' },
			);
			if (!principal.isGlobalAdmin) {
				throw new DedaloError('perm.denied', {
					message: 'delete: sqo-based multi-delete requires global admin',
					coordinates: { section_tipo: sectionTipo, operation: 'delete_multi' },
				});
			}
			const { sanitizeClientSqo } = await import('../../concepts/sqo.ts');
			const { buildSearchSql } = await import('../../search/sql_assembler.ts');
			const { sql: db } = await import('../../db/postgres.ts');
			const sqo = sanitizeClientSqo(structuredClone(rqo.sqo) as Record<string, unknown>);
			const { sql: builtSql, params } = await buildSearchSql(sqo, {});
			const matched = (await db.unsafe(builtSql, params as (string | number | null)[])) as {
				section_tipo: string;
				section_id: number;
			}[];
			// The SQO must stay within the gated section (no cross-section leaks).
			targets = matched
				.filter((row) => row.section_tipo === sectionTipo)
				.map((row) => Number(row.section_id));
		}
		// Int addresses (WC-2026-08-10-section-id-int-canonical).
		const deleted: number[] = [];
		const { logActivity, hostFromClientIp } = await import('./activity_log.ts');
		const { getMatrixTableFromTipo: tableOf } = await import('../../ontology/resolver.ts');
		const activityHost = hostFromClientIp(context.clientIp);
		// HIERARCHY/ONTOLOGY registry records cascade: deleting one
		// uninstalls its whole TLD (dd_ontology nodes + main + node
		// records — PHP ontology::delete_main, fired before the record
		// delete). Global-admin only, matching the structural blast radius.
		{
			const { ONTOLOGY_MAIN_SECTIONS, deleteOntologyMain } = await import(
				'../../ontology/ontology_delete.ts'
			);
			if (ONTOLOGY_MAIN_SECTIONS.has(sectionTipo) && deleteMode === 'delete_record') {
				if (!principal.isGlobalAdmin) {
					throw new DedaloError('perm.denied', {
						message: 'delete: ontology-main cascade requires global admin',
						coordinates: { section_tipo: sectionTipo, operation: 'delete_ontology_main' },
					});
				}
				const { deleteSectionRecord: cascadeDelete } = await import(
					'../../section/record/delete_record.ts'
				);
				// Int addresses, matching the plain-delete echo below
				// (WC-2026-08-10-section-id-int-canonical — String() minting repealed).
				const cascaded: number[] = [];
				for (const targetId of targets) {
					const cascade = await deleteOntologyMain(sectionTipo, targetId, (st, id) =>
						cascadeDelete(st, id, principal.userId),
					);
					if (!cascade.ok) {
						throw new DedaloError('record.delete_failed', {
							message: `delete: ontology cascade failed (${cascade.errors.join('; ')})`,
							coordinates: { section_tipo: sectionTipo, section_id: targetId },
						});
					}
					cascaded.push(targetId);
				}
				return { status: 200, body: ok(cascaded, { requestId: context.requestId }) };
			}
		}
		// Children-exist refusal (PHP sections::delete :535-593): a delete_record
		// on a tree/thesaurus parent that still has children is SKIPPED so its
		// subtree is never orphaned. Bypassed by options.delete_with_children;
		// never applies in delete_data mode. Lives HERE (the orchestrator), not
		// the engine — the ontology-main cascade above legitimately tears down
		// whole trees through deleteSectionRecord. Resolve the section's
		// component_relation_children tipo ONCE (PHP get_children_tipo).
		let relationChildrenTipo: string | null = null;
		if (!deleteWithChildren && deleteMode === 'delete_record') {
			const { getChildrenTipo } = await import('../../relations/children.ts');
			relationChildrenTipo = await getChildrenTipo(sectionTipo);
		}
		/** Parents kept because they still have children (the notice's `not_deleted`). */
		const skippedIds: number[] = [];
		for (const targetId of targets) {
			if (relationChildrenTipo !== null) {
				// PHP reads component_relation_children->get_data() — the COMPUTED
				// inverse getChildren(), never a stored value (:574-593). The error
				// enumerates the child ids like PHP; the record is skipped, not
				// deleted and not audited.
				const { getChildren } = await import('../../relations/children.ts');
				const children = await getChildren(targetId, sectionTipo, relationChildrenTipo);
				if (children.length > 0) {
					const childIds = children.map((child) => child.section_id).join(',');
					console.warn(
						`[delete] skipped record deletion because it has children : ${targetId} [${childIds}]`,
					);
					skippedIds.push(targetId);
					continue;
				}
			}
			const outcome =
				deleteMode === 'delete_record'
					? await deleteSectionRecord(sectionTipo, targetId, principal.userId)
					: await deleteSectionData(sectionTipo, targetId, principal.userId);
			deleted.push(...outcome.deleted);
			if (outcome.deleted.length > 0) {
				// Activity audit (PHP 'DELETE' code 4). PHP QUIRK mirrored: the
				// delete_data logger hardcodes delete_mode 'delete_record' too.
				await logActivity({
					what: 'DELETE',
					tipo: sectionTipo,
					userId: principal.userId,
					host: activityHost,
					data: {
						msg:
							deleteMode === 'delete_record'
								? 'DEBUG INFO section_record::delete Deleted section record and its own references. Full deleted record'
								: 'Empty section record and children data',
						tipo: sectionTipo,
						table: (await tableOf(sectionTipo)) ?? 'matrix',
						section_id: targetId,
						delete_mode: 'delete_record',
						section_tipo: sectionTipo,
					},
				});
			}
		}
		// Security-cache invalidation (SEC): deleting a user or profile record can
		// change grants/assignments in ways a per-component save never sees. Drop
		// the affected caches so access reflects the deletion on the next request.
		if (deleted.length > 0) {
			const { invalidateSecurityCachesForSection } = await import('../../security/permissions.ts');
			invalidateSecurityCachesForSection(sectionTipo);
			// THE REVOCATION SEAM (P1-4, SEC-08). Dropping the caches is not
			// revocation: deleting a user left the session row and its media marker
			// untouched, so the token kept resolving and the cookie kept reading the
			// whole media tree. `delete_data` counts too — it empties dd133, which is
			// the same "this account is over" transition without the row removal.
			// A no-op for every non-users section.
			const { revokeDeletedAccountAccess } = await import('../../security/revocation.ts');
			for (const deletedId of deleted) {
				revokeDeletedAccountAccess(sectionTipo, deletedId, `${sectionTipo} record delete`);
			}
		}
		// PHP keeps msg 'OK. Request done' even when records were skipped (its
		// :681 errors check tests an undefined local — always false); the skip
		// reasons travel in `errors` (PHP response->errors passthrough).
		// The skipped parents are a NON-FATAL CODED FACT, not a failure: what was
		// deleted really was deleted and stays the payload. `record.delete_children_refused`
		// carries the refused ids as its one declared detail (ERRORS_SPEC §3 notices).
		const notices =
			skippedIds.length === 0
				? undefined
				: [
						{
							code: 'record.delete_children_refused' as const,
							label_key: specOf('record.delete_children_refused').label_key,
							retryable: specOf('record.delete_children_refused').retryable,
							details: { not_deleted: skippedIds.join(',') },
						},
					];
		return { status: 200, body: ok(deleted, { requestId: context.requestId, notices }) };
	},
	count: async (rqo, context) => {
		// Record total for a search (PHP dd_core_api::count :1592): the SQO
		// runs with full_count=true; the same permission gates + projects
		// ACL as read apply.
		const principal = requirePrincipal(context);
		if (rqo.sqo === undefined) {
			throw new DedaloError('request.invalid_source', { message: 'count: rqo.sqo is required' });
		}

		// Inverse-reference count (mode 'related', relation_list paginator):
		// gate on the HOST record's section (the filter locators), since the
		// targets are 'all' by design (D3 — the same host gate as read's Gate B).
		// The total is the related search's own SCOPED question (D1): the owners
		// this caller may see, counted in SQL through the one record-scope
		// predicate the page and the past-the-page probe use — never an owner
		// enumeration filtered here (related_scope_equivalence_native).
		if ((rqo.sqo as { mode?: string }).mode === 'related') {
			const sqoRelated = rqo.sqo as {
				filter_by_locators?: { section_tipo?: string }[];
				section_tipo?: string[] | 'all';
				group_by?: string[];
			};
			await gateRelatedHosts(rqo.sqo, principal);
			const locators = Array.isArray(sqoRelated.filter_by_locators)
				? sqoRelated.filter_by_locators
				: [];
			const sectionTipos = Array.isArray(sqoRelated.section_tipo)
				? sqoRelated.section_tipo.includes(RELATED_ALL_SECTIONS)
					? ('all' as const)
					: sqoRelated.section_tipo
				: ('all' as const);
			const { countInverseReferences } = await import('../../search/search_related.ts');
			const { rowScopeFor } = await import('../../security/record_scope.ts');
			const result = await countInverseReferences(locators as never, {
				sectionTipos,
				groupBy: sqoRelated.group_by,
				scope: rowScopeFor(principal),
			});
			return { status: 200, body: ok(result, { requestId: context.requestId }) };
		}

		// The same ONE TM scope and the same decision as read
		// (WC-2026-10-22-tm-scope-whole-request): a count must give the answer
		// the read gives, or the paginator either leaks a history total the read
		// refuses or refuses what the read serves. The scope matters when the
		// SQO targets dd15 itself: Gate B then asks the dd15 floor.
		const sqo = rqo.sqo;
		return withTimeMachineReadScope(sqo, () => countGatedRows(rqo, sqo, context, principal));
	},
	start: async (rqo, context) => {
		// The client's first boot call (PHP dd_core_api::start): environment
		// + a structure-context. NOT LOGGED → the LOGIN element context (the
		// client renders whatever element start describes, so this is what
		// makes the login form appear). Logged → the default section context.
		// The section extras section_map is ledgered uncovered.
		const { buildEnvironment: buildEnv } = await import('../../resolve/environment.ts');
		if (context.session === null) {
			const { buildLoginContext } = await import('./login_context.ts');
			return {
				status: 200,
				body: ok(
					{ context: [await buildLoginContext()], data: [] },
					{ requestId: context.requestId, extend: { environment: await buildEnv(null, null) } },
				),
			};
		}
		const { buildStructureContext } = await import('../../resolve/structure_context.ts');
		const principal = requirePrincipal(context);

		// Page element from the URL vars (PHP :266-300): the client forwards
		// its GET params as options.search_obj — t/tipo, st/section_tipo,
		// id/section_id, m/mode (or a whole locator). Defaults to the main
		// section in list mode.
		const searchObj = ((rqo.options as { search_obj?: Record<string, unknown> } | undefined)
			?.search_obj ?? {}) as Record<string, unknown>;
		const locator =
			typeof searchObj.locator === 'string'
				? (JSON.parse(searchObj.locator) as Record<string, unknown>)
				: ((searchObj.locator as Record<string, unknown>) ?? null);
		const pick = (...values: unknown[]): string | null => {
			for (const value of values) {
				if (typeof value === 'string' && value !== '') return value;
				if (typeof value === 'number') return String(value);
			}
			return null;
		};

		// TOOL deep link (PHP start tool case): ?tool=tool_x opens the tool in
		// its own window/tab — start describes the TOOL element so the client
		// renders the tool instead of a section (verified: PHP returns one
		// context entry, type='tool'). The tool must be authorized for the caller.
		const toolParam = pick(searchObj.tool);
		if (toolParam !== null && /^tool_[a-z0-9_]+$/.test(toolParam)) {
			const { buildToolElementContext } = await import('../../tools/registry.ts');
			// The one grant decision (tools/security.ts — closure Step 3 req 8).
			const { assertToolGranted } = await import('../../tools/security.ts');
			await assertToolGranted(principal, toolParam);
			const toolElementContext = await buildToolElementContext(toolParam);
			const toolStartContext: unknown[] = [];
			if ((rqo.options as { menu?: boolean } | undefined)?.menu === true) {
				const menuCtx = await buildStructureContext({
					tipo: 'dd85',
					sectionTipo: 'dd85',
					mode: 'list',
					lang: currentDataLang(),
					langOverride: currentDataLang(),
					permissions: 2,
					addRequestConfig: false,
				});
				if (menuCtx !== null) toolStartContext.push(menuCtx);
			}
			if (toolElementContext !== null) toolStartContext.push(toolElementContext);
			return {
				status: 200,
				body: ok(
					{ context: toolStartContext, data: [] },
					{
						requestId: context.requestId,
						extend: { environment: await buildEnv(context.session, principal) },
					},
				),
			};
		}

		const requestedTipo = pick(locator?.tipo, searchObj.t, searchObj.tipo);

		// NO SECTION ASKED FOR, AND NONE CONFIGURED → the MENU (2026-08-22).
		// MAIN_SECTION used to default to one installation's section, so a login
		// with no deep link landed every OTHER installation on a tipo that need
		// not exist. The key is now install-neutral and may legitimately be empty,
		// which makes "no landing section" a real state rather than a
		// misconfiguration: answer with the menu the client already knows how to
		// mount (the same shape the tool deep link returns), not with a structure
		// read of the empty tipo.
		if (requestedTipo === null && config.mainSection === '') {
			const homeContext: unknown[] = [];
			const menuCtx = await buildStructureContext({
				tipo: 'dd85',
				sectionTipo: 'dd85',
				mode: 'list',
				lang: currentDataLang(),
				langOverride: currentDataLang(),
				permissions: 2,
				addRequestConfig: false,
			});
			if (menuCtx !== null) homeContext.push(menuCtx);
			return {
				status: 200,
				body: ok(
					{ context: homeContext, data: [] },
					{
						requestId: context.requestId,
						extend: { environment: await buildEnv(context.session, principal) },
					},
				),
			};
		}

		let pageTipo = requestedTipo ?? config.mainSection;
		let pageSectionTipo =
			pick(locator?.section_tipo, searchObj.st, searchObj.section_tipo) ?? pageTipo;
		const pageMode = pick(locator?.mode, searchObj.m, searchObj.mode) ?? 'list';
		// The record id from the deep link (?id=1). PHP injects it onto the
		// page-element context (:480 section / :627 component) so the client
		// instance knows its section_id; a component/viewer deep link that omits
		// it leaves get_data reads with section_id null → they fall to
		// readSection and 500.
		//
		// PERMANENT coercion door (WC-2026-08-10-section-id-int-canonical):
		// URLSearchParams yields strings forever, so this conversion never
		// deprecates — it counts under its own 'url.*' key, excluded from the
		// RQO-body contraction gate. A convertible id becomes the canonical int;
		// anything else (synthetic tokens, external refs like '001338683'/'Q42')
		// rides VERBATIM — the old /^\d+$/ + Number() here silently turned a
		// leading-zero remote id into a wrong record address.
		const pageSectionIdRaw = pick(locator?.section_id, searchObj.id, searchObj.section_id);
		const pageSectionId =
			pageSectionIdRaw !== null && isConvertibleSectionIdString(pageSectionIdRaw)
				? coerceSectionId(pageSectionIdRaw, 'url.search_obj')
				: pageSectionIdRaw;
		// The deep-link view (?view=viewer) — PHP element->set_view($view). It
		// makes the client mount a DIFFERENT view (e.g. component_image's
		// view_viewer_image, the floating full-image popup) instead of the
		// default edit view. Without it the viewer window renders the edit UI.
		const pageView = pick(locator?.view, searchObj.view);

		// section_tool reroute (PHP dd_core_api start :386-426): a section_tool
		// page is an ontological ALIAS — the page element is overwritten with the
		// TARGET section and the tool activation ships on config.tool_context
		// (the client's tool_common.js cascade branch (1)). Without this the
		// client builds the tool from a synthetic single-entry ddo_map and the
		// components configured in properties.tool_config.<tool>.ddo_map never
		// render (numisdata201/numisdata670).
		let pageConfig: Record<string, unknown> | null = null;
		const { getModelByTipo, getPropertiesByTipo } = await import('../../ontology/resolver.ts');
		if ((await getModelByTipo(pageTipo)) === 'section_tool') {
			const sectionToolTipo = pageTipo;
			const properties = (await getPropertiesByTipo(sectionToolTipo)) as {
				config?: Record<string, unknown> | null;
				tool_config?: Record<string, unknown> | null;
			} | null;
			// overwrite (!) — PHP :395-398. The whole properties.config replaces
			// the built section context's config below (PHP set_config :456-458).
			const targetSectionTipo = properties?.config?.target_section_tipo;
			if (typeof targetSectionTipo === 'string' && targetSectionTipo !== '') {
				pageTipo = targetSectionTipo;
				pageSectionTipo = targetSectionTipo;
			}
			pageConfig = properties?.config != null ? structuredClone(properties.config) : null;
			// tool_context (PHP :400-424) from the CALLER's authorized tools; an
			// unauthorized/unregistered tool logs and ships WITHOUT tool_context.
			const toolConfigBag = properties?.tool_config;
			if (pageConfig !== null && toolConfigBag != null && typeof toolConfigBag === 'object') {
				const { getUserTools } = await import('../../tools/registry.ts');
				const { buildSectionToolContext } = await import('../../tools/section_tool_context.ts');
				const userTools = await getUserTools(context.session.userId, principal.isGlobalAdmin);
				const toolContext = await buildSectionToolContext(toolConfigBag, userTools);
				if (toolContext === null) {
					console.warn(
						`start: section_tool ${sectionToolTipo}: named tool not in user_tools — context ships without tool_context (PHP parity)`,
					);
				} else {
					pageConfig.tool_context = toolContext;
				}
			}
			// A section_tool whose rerouted tipo is still not a real section is an
			// ERROR in PHP too — section::get_instance returns false and start
			// fatals on ->set_lang (:430-434), answering a refusal (numisdata625,
			// pinned in section_tool_start_differential). Refuse loudly with a
			// registered code instead of emitting a bogus entry.
			if ((await getModelByTipo(pageTipo)) !== 'section') {
				const message = `start: section_tool ${sectionToolTipo} has no buildable target section (config.target_section_tipo)`;
				// A state refusal, not a caller fault: the ontology names a target that
				// is not a section. `resource.conflict` is the public-disclosure state
				// code, so the operator sentence still reaches the panel.
				throw new DedaloError('resource.conflict', {
					publicMessage: message,
					coordinates: { section_tool_tipo: sectionToolTipo, tipo: pageTipo },
				});
			}
		}

		// Permission gate on the requested element (a deep link must not leak
		// context the user cannot read). For a section_tool this gates the
		// REROUTED target section — the element the context actually describes.
		const pagePermissions = await getPermissions(principal, pageSectionTipo, pageTipo);
		if (pagePermissions < 1) {
			// THE ENVIRONMENT RIDES THE REFUSAL
			// (WC-2026-08-12-authorization-denial-token). `start` is the client's
			// FIRST call: without it there is no `get_label`, so the page could only
			// render the refusal in the source language, whatever the operator's
			// interface language is. It is the same block the success path builds,
			// for the same authenticated caller — no permission is implied by it and
			// nothing about the refused element is in it.
			throw new DedaloError('perm.denied', {
				publicMessage: 'Insufficient permissions to read',
				extend: { environment: await buildEnv(context.session, principal) },
			});
		}
		// PHP start instantiates page elements with DEDALO_DATA_LANG and no
		// nolan forcing (differentially verified: section + menu contexts
		// carry lg-spa). The client's instances INHERIT this lang and thread
		// it into every component read/save — nolan here made the whole edit
		// form save as lg-nolan.
		//
		// The three payload builds are independent reads — run them
		// concurrently (the request-context/lang ALS stores flow into every
		// Promise.all branch, engineering/REQUEST_ISOLATION.md); the context array is
		// then assembled in the original order (menu first) for wire stability.
		const menuWanted = (rqo.options as { menu?: boolean } | undefined)?.menu === true;
		// A SECTION deep link carrying a record id is the EDIT view (PHP start
		// :477-501 forces set_mode('edit')): `?tipo=rsc0&section_id=1054` means
		// "open this record", never a one-row list. The client inherits the mode
		// into its instance and its first read, so without this the record opens
		// as a list of one with no edit form (the inspector's "Local Ontology"
		// pen is one such caller). Components/areas keep their requested mode,
		// exactly like PHP's switch, which only forces on the section branch.
		const sectionRecordDeepLink =
			pageSectionId !== null && (await getModelByTipo(pageTipo)) === 'section';
		const [sectionContext, menuContext, environment] = await Promise.all([
			buildStructureContext({
				tipo: pageTipo,
				sectionTipo: pageSectionTipo,
				mode: sectionRecordDeepLink || pageMode === 'edit' ? 'edit' : 'list',
				lang: currentDataLang(),
				langOverride: currentDataLang(),
				permissions: pagePermissions,
				addRequestConfig: false, // PHP start builds context without it
				view: pageView, // ?view=viewer → the client mounts the dedicated view
			}),
			// Menu shell context (PHP :372-380): when the client asks with
			// options.menu=true, start ALSO describes the menu element — the
			// client mounts the header from it and autoloads its tree via the
			// menu get_data read (already served by readMenu). The menu is
			// rendered at fixed permission level 2 (menu_json.php).
			menuWanted
				? buildStructureContext({
						tipo: 'dd85',
						sectionTipo: 'dd85',
						mode: 'list',
						lang: currentDataLang(),
						langOverride: currentDataLang(),
						permissions: 2,
						addRequestConfig: false,
					})
				: null,
			// The FULL environment block (page_globals + plain_vars + get_label) —
			// the copied client injects it via set_environment() at boot
			// (rewrite/client_seam.md seam item 1). Session is non-null on this
			// branch (the anonymous path returned above).
			buildEnv(context.session, principal),
		]);
		const startContext: unknown[] = [];
		if (menuContext !== null) startContext.push(menuContext);
		if (sectionContext !== null) {
			// section_tool config REPLACEMENT (PHP set_config :456-458 — dd_object
			// set_config swaps the whole config object, so keys the plain section
			// context carried, e.g. relation_list_tipo, are dropped on the wire).
			if (pageConfig !== null) {
				(sectionContext as { config?: unknown }).config = pageConfig;
			}
			// Inject the deep-link record id onto the page-element context (PHP
			// $current_context->section_id = $section_id). The client reads it to
			// set the instance's section_id, which every component read/save then
			// threads — without it a viewer/component deep link reads section_id null.
			if (pageSectionId !== null) {
				(sectionContext as { section_id?: unknown }).section_id = pageSectionId;
			}
			startContext.push(sectionContext);
		}
		return {
			status: 200,
			body: ok(
				{ context: startContext, data: [] },
				{ requestId: context.requestId, extend: { environment } },
			),
		};
	},
	get_element_context: async (rqo, context) => {
		// One element's structure context, no data (PHP get_element_context →
		// element get_json(get_context=true, get_data=false)). Covers
		// section/component models; area/tool element contexts are ledgered.
		const { buildStructureContext } = await import('../../resolve/structure_context.ts');
		const principal = requirePrincipal(context);
		const source = rqo.source ?? {};

		// TOOL branch (PHP get_element_context tool branch): the client's
		// open_tool string path sends source:{model:'tool_x'} with NO tipo.
		// Require the tool to be authorized for the caller, then return its
		// full tool context (tipo/lang/labels/description/developer included).
		if (
			source.tipo === undefined &&
			typeof source.model === 'string' &&
			/^tool_[a-z0-9_]+$/.test(source.model)
		) {
			const { buildToolElementContext } = await import('../../tools/registry.ts');
			const toolName = source.model;
			// The one grant decision (tools/security.ts — closure Step 3 req 8), asked
			// of the PRINCIPAL `requirePrincipal` guarantees — never of a session
			// object it does not (the coverage plan's D8/L6 null dereference: a
			// session-less call used to THROW a 500 here instead of the 403).
			const { assertToolGranted } = await import('../../tools/security.ts');
			await assertToolGranted(principal, toolName);
			const toolContext = await buildToolElementContext(toolName);
			return {
				status: 200,
				body: ok(toolContext !== null ? [toolContext] : [], { requestId: context.requestId }),
			};
		}

		const tipo = source.tipo;
		if (tipo === undefined) {
			throw new DedaloError('request.invalid_source', {
				message: 'get_element_context: source.tipo is required',
			});
		}
		const sectionTipo = source.section_tipo ?? tipo;
		const mode = source.mode ?? 'list';
		// Omitted source.lang = the REQUEST's data lang (PHP DEDALO_DATA_LANG), never
		// an install literal: get_instance builds a model-less component from this
		// context's lang — a literal reads a translatable field in the wrong
		// language (WC-2026-10-20-element-context-default-lang).
		const lang = source.lang ?? currentDataLang();
		const { getModelByTipo } = await import('../../ontology/resolver.ts');
		const model = source.model ?? (await getModelByTipo(tipo));
		// Covered element families: sections, components, and the area models
		// (area, area_root, area_admin, … — plain ontology nodes whose context
		// the generic structure builder resolves). Tool element contexts are
		// still ledgered. The area default request_config null-skeleton is
		// ledgered too (TS area entries omit the key).
		const isCoveredModel =
			model !== null &&
			(model === 'section' || model.startsWith('component_') || isAreaModel(model));
		if (!isCoveredModel) {
			throw new DedaloError('request.invalid_model', {
				message: `get_element_context: model '${model}' not implemented (section/component/area only)`,
				coordinates: { tipo, model: model ?? 'null' },
			});
		}
		// Read gate: level >= 1 on (section_tipo, tipo) — PHP assert_section_permission.
		const permissions = await getPermissions(principal, sectionTipo, tipo);
		if (permissions < 1) {
			throw new DedaloError('perm.denied', { coordinates: { section_tipo: sectionTipo, tipo } });
		}
		const entry = await buildStructureContext({
			tipo,
			sectionTipo,
			mode,
			lang,
			permissions,
			// P1-3 / SEC-13: WITH the principal, so a section context's buttons pass
			// the per-button grant (buildSectionButtons) — without it the builder
			// takes the caller-cap path and emits every button, level 0 included.
			principal,
		});
		return {
			status: 200,
			body: ok(entry !== null ? [entry] : [], { requestId: context.requestId }),
		};
	},
	get_section_elements_context: async (rqo, context) => {
		// The edit-mode search-filter panel's element list (PHP dd_core_api::
		// get_section_elements_context). Authenticated read; permissions are
		// ALWAYS enforced server-side (the client skip_permissions flag is
		// ignored). Returns the "simple" structure-context set per section.
		const principal = requirePrincipal(context);
		const { buildSectionElementsContext } = await import(
			'../../resolve/section_elements_context.ts'
		);
		const result = await buildSectionElementsContext(
			principal,
			(rqo.options ?? {}) as Record<string, unknown>,
		);
		return { status: 200, body: ok(result, { requestId: context.requestId }) };
	},
	get_section_terms: async (rqo, context) => {
		// Batch-resolve the section_map display term for a set of records (PHP
		// dd_core_api::get_section_terms :3482) — the graph view labels ALL its
		// nodes with one request instead of one datum read per node. The
		// locators/scope/lang ride at the TOP level of the rqo (client
		// build_graph_data.js fetch_section_terms), not under source/options.
		const principal = requirePrincipal(context);

		const rawLocators = (rqo as { locators?: unknown }).locators;
		if (!Array.isArray(rawLocators) || rawLocators.length === 0) {
			throw new DedaloError('section.bad_locators');
		}
		// Validate + dedup + cap the batch (pure; handlers/section_terms.ts).
		const locatorEntries = normalizeTermLocators(rawLocators);

		// scope null => the section_map main → thesaurus → relation_list chain.
		const scopeRaw = (rqo as { scope?: unknown }).scope;
		const scope = typeof scopeRaw === 'string' ? scopeRaw : null;
		const langRaw = (rqo as { lang?: unknown }).lang;
		const lang = typeof langRaw === 'string' ? langRaw : currentDataLang();

		// Resolve the already-deduped batch; skip unreadable/untermed sections.
		const terms: Record<string, string | null> = {};
		for (const { key, section_tipo: sectionTipo, section_id: sectionId } of locatorEntries) {
			// SEC: read permission required on the section (omit forbidden, never leak).
			if ((await getPermissions(principal, sectionTipo, sectionTipo)) < 1) continue;
			// Only sections with a section_map term — otherwise getTermByLocator
			// returns the "{tipo}_{id}" fallback string, which would clobber the
			// client's own provisional node label.
			if ((await getTermTipos(sectionTipo, scope)).length === 0) continue;
			terms[key] = await getTermByLocator(
				{ section_tipo: sectionTipo, section_id: sectionId },
				lang,
				true, // from_cache
				scope,
			);
		}

		return { status: 200, body: ok(terms, { requestId: context.requestId }) };
	},
	// get_matrix_ontology_locator: DELETED at the DEC-16 re-sync (2026-07-11)
	// together with the PHP endpoint and matrix_ontology_locator_differential —
	// the client's get_ontology_url 'local_ontology' case now derives the
	// locator locally (the pure tld+'0' / digit-run derivation its
	// 'master_ontology' case always used).
	get_indexation_grid: async (rqo, context) => {
		// The thesaurus "show indexations" grid (PHP dd_core_api::
		// get_indexation_grid :2845 → indexation_grid::build_indexation_grid).
		// Client: ts_object.js show_indexations → dd_grid view 'indexation'.
		const principal = requirePrincipal(context);
		const source = (rqo.source ?? {}) as {
			section_tipo?: string;
			/** Raw wire value — unknown until coerceSectionId classifies it below. */
			section_id?: unknown;
			tipo?: string;
			value?: unknown;
		};
		const sectionTipo = source.section_tipo ?? source.tipo;
		if (!source.section_tipo || !source.tipo || !source.section_id) {
			throw new DedaloError('request.invalid_source', {
				message:
					'get_indexation_grid: empty source properties (section_tipo, section_id, tipo are mandatory)',
			});
		}
		// SEC: read permission on the term's section. PHP threw
		// permission_exception → dd_manager:458 answered 'permissions_denied';
		// envelope v2 restates that as the registered `perm.denied` (403).
		const level = await getPermissions(principal, sectionTipo as string, sectionTipo as string);
		if (level < 1) {
			throw new DedaloError('perm.denied', {
				coordinates: { section_tipo: sectionTipo as string, required: 1, have: level },
			});
		}
		// The grid host is the THESAURUS TERM record: coerce at the door
		// (counted, deprecable RQO-body string form — the client still sends the
		// tree node id as text) so the engine works on the canonical int
		// (WC-2026-08-10-section-id-int-canonical). A non-address answers the
		// section's own HTTP-200 failure envelope, never a 500.
		let gridSectionId: number;
		try {
			gridSectionId = coerceSectionId(
				source.section_id,
				'rqo.dd_core_api.get_indexation_grid.section_id',
			);
		} catch (error) {
			// Same code the frozen PHP body maps to (test/parity/normalize.ts
			// FROZEN_ERROR_BODIES): a non-address section_id IS an invalid source.
			// The coercer's own message is LOG-ONLY (cause + coordinates).
			throw new DedaloError('request.invalid_source', {
				cause: error,
				coordinates: {
					section_tipo: sectionTipo as string,
					section_id: JSON.stringify(source.section_id ?? null),
				},
			});
		}
		// The window is a CLIENT page (READ-4): the one page primitive bounds it
		// at the ceiling, offset included. The door's own default (500, the
		// thesaurus "show indexations" page) applies to an absent limit and is
		// itself clamped. The notice follows the ONE rule of every client page
		// door (read_facade owedPageNotices): a SENT value that was changed owes
		// it always; a DEFAULTED page only when the default cut something the
		// CALLER could page to — any group past the page, scoped like the grid
		// itself (AUTHZ-05), is one the caller may see (indexationRowsPast); a
		// page served as sent never.
		const { clampClientPage, pageClampedNotice, requestedPage } = await import(
			'../../concepts/sqo.ts'
		);
		const asSent = requestedPage(rqo.sqo);
		const page = clampClientPage(
			asSent.limit,
			asSent.offset,
			'get_indexation_grid',
			INDEXATION_GRID_DEFAULT_LIMIT,
		);
		const { buildIndexationGrid, indexationRowsPast } = await import(
			'../../section/indexation_grid.ts'
		);
		const gridSqo = {
			...(rqo.sqo ?? {}),
			limit: page.limit,
			offset: page.offset,
		} as import('../../section/indexation_grid.ts').IndexationGridSqo;
		const grid = await buildIndexationGrid(
			{
				sectionTipo: sectionTipo as string,
				sectionId: gridSectionId,
				tipo: source.tipo,
				sqo: gridSqo,
			},
			principal,
		);
		const owesNotice =
			page.bounded === 'clamped' ||
			(page.bounded === 'defaulted' && (await indexationRowsPast(gridSqo, page, principal)));
		const notices = owesNotice
			? [pageClampedNotice('get_indexation_grid', asSent.limit, asSent.offset, page)]
			: undefined;
		return { status: 200, body: ok(grid, { requestId: context.requestId, notices }) };
	},
	get_activity_metric: async (rqo, context) => {
		// On-demand activity dataset for the area dashboard's timeline range
		// switch (client dashboard.js fetch_range → 3m/6m/1y). The dashboard READ
		// serves only activity_30d inline; wider ranges are fetched here so the
		// initial payload stays small. Gated IDENTICALLY to the dashboard read
		// (area/read.ts readDashboardArea): read permission > 0 on the area.
		const principal = requirePrincipal(context);
		const options = (rqo.options ?? {}) as { area_tipo?: unknown; range_days?: unknown };
		const areaTipo = options.area_tipo;
		if (typeof areaTipo !== 'string' || !SAFE_TIPO.test(areaTipo)) {
			throw new DedaloError('request.invalid_tipo', {
				message: 'get_activity_metric: invalid area_tipo',
			});
		}
		const { getModelByTipo } = await import('../../ontology/resolver.ts');
		if (!isAreaModel((await getModelByTipo(areaTipo)) ?? '')) {
			throw new DedaloError('request.invalid_model', {
				message: 'get_activity_metric: not an area',
				coordinates: { tipo: areaTipo },
			});
		}
		const rangeDays = Number(options.range_days);
		const { ACTIVITY_RANGE_DAYS, getAreaActivityMetric } = await import('../../area/dashboard.ts');
		if (!ACTIVITY_RANGE_DAYS.has(rangeDays)) {
			throw new DedaloError('request.invalid_options', {
				publicMessage: `options.range_days must be one of ${[...ACTIVITY_RANGE_DAYS].join(', ')}`,
			});
		}
		// SEC: same permission boundary as the dashboard payload it extends.
		if ((await getPermissions(principal, areaTipo, areaTipo)) < 1) {
			throw new DedaloError('perm.denied', { coordinates: { section_tipo: areaTipo } });
		}
		const data = await getAreaActivityMetric(areaTipo, rangeDays);
		return { status: 200, body: ok(data, { requestId: context.requestId }) };
	},
	get_ip_country: async (rqo, context) => {
		// Server-side IP→country resolution for the Activity (dd542) IP list view.
		// Replaces the former per-visitor browser fetch to a third-party service:
		// resolution is LOCAL and OFFLINE against the openly-licensed DB-IP
		// Country Lite database (src/core/geoip). Authenticated (dispatch gate) +
		// CSRF. Returns country_code:null for private/reserved/unresolved IPs (and
		// when the database is not loaded) so the client simply shows no flag.
		requirePrincipal(context);
		const options = (rqo.options ?? {}) as { ip?: unknown };
		const ip = options.ip;
		if (typeof ip !== 'string' || ip.length === 0 || ip.length > 64) {
			throw new DedaloError('request.invalid_options', {
				publicMessage: 'options.ip must be a non-empty address of at most 64 characters',
			});
		}
		const { resolveCountry } = await import('../../geoip/reader.ts');
		const resolved = resolveCountry(ip);
		return {
			status: 200,
			body: ok({ country_code: resolved?.country_code ?? null }, { requestId: context.requestId }),
		};
	},
	get_environment: async (_rqo, context) => {
		// The full client environment (PHP get_environment): page_globals +
		// plain_vars + get_label — the payload set_environment() injects.
		const { buildEnvironment } = await import('../../resolve/environment.ts');
		// Seeded once by dispatchRqo; null for the unauthenticated environment read.
		const principal = context.principal ?? null;
		// buildEnvironment answers the `{result:{page_globals, plain_vars,
		// get_label}, …}` block that ALSO rides `start` as its `environment`
		// extension key; here its `result` is the data.
		const environment = await buildEnvironment(context.session, principal);
		return { status: 200, body: ok(environment.result, { requestId: context.requestId }) };
	},
};

/** Preset sections excluded from LOAD activity (PHP DEDALO_TEMP_PRESET_SECTION_TIPO
 * dd655 / DEDALO_SEARCH_PRESET_SECTION_TIPO dd623 — user list/search presets are
 * not real navigation and must not pollute the activity timeline). */
const ACTIVITY_EXCLUDED_PRESET_TIPOS: ReadonlySet<string> = new Set(['dd655', 'dd623']);

/**
 * LOAD activity for a section/area read (PHP dd_core_api::log_activity :3603).
 * Appends a 'LOAD EDIT'/'LOAD LIST' audit row keyed by the read's SECTION/AREA
 * tipo — the stream the dashboard timeline aggregates. Fire-and-swallow: an
 * audit write must never fail the read (logActivity already swallows its own
 * errors; this wrapper guards the model/preset lookups too).
 *
 * PHP exclusions mirrored: skip mode 'search'/'tm', skip the Activity section and
 * its own components (self-log loop guard — ACTIVITY_SECTION_TIPO dd542), skip
 * temp/search preset sections, and log ONLY section + area models (never a bare
 * component read, e.g. an autocomplete's get_data — dd_core_api :3628-3633).
 */
/**
 * The NON-PERSISTING half of the save door (hoisted out of `save` for the
 * complexity ratchet): a synthetic search id or an external remote id
 * addresses no matrix row, so a relation pick RESOLVES for the chip and
 * ECHOES without writing (the old search_* exception stated by kind), and any
 * other shape refuses loudly — the sniff era FELL THROUGH here and minted NaN
 * into the write path (WC-2026-08-10-section-id-int-canonical).
 */
async function resolveNonRecordSave(
	rqo: Rqo,
	source: RqoSource,
	dataPayload: { changed_data?: unknown },
	principal: Principal,
): Promise<ApiResult> {
	if (!Array.isArray(dataPayload.changed_data)) {
		throw new DedaloError('request.invalid_data', {
			message: 'save: data.changed_data must be an array',
		});
	}
	const { getColumnNameByModel: columnOf, getModelByTipo: modelOf } = await import(
		'../../ontology/resolver.ts'
	);
	const searchModel = await modelOf(source.tipo as string);
	if (searchModel !== null && columnOf(searchModel) === 'relation') {
		const searchLevel = await getPermissions(
			principal,
			source.section_tipo as string,
			source.tipo as string,
		);
		if (searchLevel < 1) {
			throw new DedaloError('perm.denied', {
				coordinates: { section_tipo: source.section_tipo ?? '', tipo: source.tipo ?? '' },
			});
		}
		const { currentChipsFromPayload, mergeRelationChips, resolveRelationEcho } = await import(
			'../../section/record/resolve_echo.ts'
		);
		const picked = mergeRelationChips(
			currentChipsFromPayload((rqo.data ?? {}) as { entries?: unknown; value?: unknown }),
			dataPayload.changed_data as Parameters<typeof mergeRelationChips>[1],
		);
		return await resolveRelationEcho({ rqo, principal, picked, mode: 'search' });
	}
	throw new DedaloError('section_id.not_an_address', {
		message: `save: section_id ${JSON.stringify(source.section_id)} addresses no record in '${source.section_tipo}'`,
		coordinates: {
			section_tipo: source.section_tipo ?? '',
			section_id: JSON.stringify(source.section_id ?? null),
		},
	});
}

async function logReadActivity(
	rqo: Rqo,
	principal: Principal,
	context: ApiRequestContext,
	result: ApiResult,
): Promise<void> {
	try {
		const source = rqo.source ?? {};
		const tipo = source.tipo ?? '';
		const mode = source.mode ?? '';
		if (tipo === '' || mode === 'search') return;
		// A TIME MACHINE read never logs activity. The test is the SQO's row source,
		// not the render mode: dd15 cells emit mode 'list' now
		// (WC-2026-08-14-tm-ddo-mode-retired), and `source.mode` was already 'list'
		// on the service's reads, so a `mode === 'tm'` check here catches nothing.
		// Without this every history browse, inspector history block and tool open
		// would append a dd542 Activity row — a write side effect of a read-only
		// surface, into the consultation-only twin of the section being read.
		if ((rqo.sqo as { mode?: string } | undefined)?.mode === 'tm') return;
		// (The self-log loop guard — dd542 and its own components — now lives in
		// logActivity, so every emitter inherits it. Not repeated here.)
		if (ACTIVITY_EXCLUDED_PRESET_TIPOS.has(tipo)) return;

		const { getModelByTipo } = await import('../../ontology/resolver.ts');
		const model = (await getModelByTipo(tipo)) ?? '';
		// Only sections and areas generate activity (PHP :3631) — a bare component
		// read (autocomplete get_data, resolve_data) leaves no footprint.
		if (model !== 'section' && !model.startsWith('area')) return;

		const modeToActivity = mode === 'list' ? 'list' : 'edit';
		const data: Record<string, unknown> = {
			msg: `HTML Page is loaded in mode: ${modeToActivity} [${mode}]`,
			tipo,
		};
		// section_id echoed only for a section EDIT load (PHP :3647), read from the
		// response's first entry, falling back to the request source.
		if (model === 'section' && mode === 'edit') {
			// Envelope v2: the payload is `data` (the compat `result` mirror is a
			// bounded fossil — ERRORS_SPEC §3.1 — never read here).
			const body = result.body as
				| { data?: { data?: { section_id?: unknown; entries?: { section_id?: unknown }[] }[] } }
				| undefined;
			const firstItem = body?.data?.data?.[0];
			const sectionId =
				firstItem?.entries?.[0]?.section_id ?? firstItem?.section_id ?? source.section_id ?? null;
			// Canonical emission (WC-2026-08-10-section-id-int-canonical): the value
			// may come from a stored entry that still carries the legacy string form
			// — '7' becomes 7; a non-convertible value rides verbatim.
			if (sectionId !== null && sectionId !== undefined) {
				data.id = canonicalizeStoredSectionId(sectionId);
			}
		}

		const { logActivity, hostFromClientIp } = await import('./activity_log.ts');
		const host = hostFromClientIp(context.clientIp);
		await logActivity({
			what: `LOAD ${modeToActivity.toUpperCase()}`, // 'LOAD EDIT' | 'LOAD LIST'
			tipo,
			userId: principal.userId,
			host,
			data, // PHP data_activity: {msg, tipo, id?} — nothing more
		});
	} catch (error) {
		console.error('LOAD activity log failed (swallowed):', error);
	}
}

/**
 * Menu read (PHP menu::get_json → menu_json.php). Returns the menu's structure
 * context plus one data item carrying the tree_datalist (the permitted
 * navigation nodes), the developer-only ontology-inspection flag, and the
 * current username. info_data (installation diagnostics for the About panel) is
 * ledgered — it is not needed for the boot render.
 */
async function readMenu(
	rqo: Rqo,
	context: ApiRequestContext,
	principal: Principal,
): Promise<ApiResult> {
	const { getMenuTreeDatalist } = await import('./menu.ts');
	const { buildStructureContext } = await import('../../resolve/structure_context.ts');
	const source = rqo.source ?? {};
	const menuTipo = source.tipo ?? 'dd85';
	const lang = source.lang ?? currentApplicationLang();

	// The menu is always rendered at permission level 2 (PHP menu_json.php).
	const menuContext = await buildStructureContext({
		tipo: menuTipo,
		sectionTipo: source.section_tipo ?? menuTipo,
		mode: 'list',
		lang,
		permissions: 2,
		addRequestConfig: false,
	});
	// The tree is viewer-scoped: admins+developers get it unfiltered; anyone
	// else gets the permission-filtered menu (PHP get_tree_datalist).
	const { tree_datalist } = await getMenuTreeDatalist({
		userId: principal.userId,
		isGlobalAdmin: principal.isGlobalAdmin,
		isDeveloper: principal.isDeveloper,
	});
	const { buildInfoData } = await import('../../resolve/environment.ts');

	const dataItem = {
		tipo: menuTipo,
		model: 'menu',
		tree_datalist,
		// Installation diagnostics (PHP get_info_data) — the header info bar
		// prefers these over page_globals; TS-runtime values.
		info_data: await buildInfoData(),
		show_ontology: principal.isDeveloper,
		username: context.session?.username ?? null,
	};
	return {
		status: 200,
		body: ok(
			{ context: menuContext !== null ? [menuContext] : [], data: [dataItem] },
			{ requestId: context.requestId },
		),
	};
}
