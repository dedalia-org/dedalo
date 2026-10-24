/**
 * SECTION READ pipeline — the TS re-expression of dd_core_api::build_json_rows'
 * 'search' action for SECTION reads (spec §3.2 read flow).
 *
 * PHP references: class.dd_core_api.php build_json_rows (:2022-2641),
 * sections_json.php (row builder + envelope), section_json.php,
 * common::get_subdatum (:2254).
 *
 * CONTRACT (header re-dated 2026-07-07, S2-45 — coverage-state lists live in
 * rewrite/STATUS.md, never here):
 * - readSection returns the FULL {context[], data[]} pair (PHP
 *   build_json_rows shape): structure context (section entry first, then one
 *   per resolved ddo, deduplicated by context_key) + record-major /
 *   ddo-minor data items stamped with row_section_id + parent_tipo;
 *   data[0] is the sections envelope
 *   {typo:'sections', tipo, section_tipo:[], entries:[locators]}.
 * - the request's own show.ddo_map drives resolution when present (the PHP
 *   stage-1 build_request_config_from_rqo short-circuit); otherwise the
 *   ontology-driven default request_config (explicit/implicit builders,
 *   relations/request_config/) supplies it.
 * - permissions: the caller's Principal is threaded through — the projects
 *   filter scopes the record search per-record (ACL) and the structure
 *   context is permission-stamped per element. No global-admin assumption.
 * - sources may OWN the read (the dd15 Time Machine source builds its own
 *   context/rows) — dispatched by sqo.mode via readSource.
 */

import { config as dedaloConfig } from '../../config/config.ts';
import { type EmitHookContext, getEmitHook } from '../components/emit_hooks.ts';
import { getComponentModel } from '../components/registry.ts';
import type { Ddo } from '../concepts/ddo.ts';
import type { EmitRow } from '../concepts/emit_row.ts';
import {
	callerDataframePairing,
	isTemporalSource,
	type Rqo,
	type RqoSource,
} from '../concepts/rqo.ts';
import { isConsultationOnlySection, TIME_MACHINE_SECTION_TIPO } from '../concepts/section.ts';
import { canonicalizeStoredSectionId, classifyWireSectionId } from '../concepts/section_id.ts';
import { mergeSessionSqo, sanitizeClientSqo } from '../concepts/sqo.ts';
import type { MatrixRecord } from '../db/matrix.ts';
import { memoizedReadMatrixRecord, runWithRecordMemo } from '../db/record_memo.ts';
import type { TmCoords } from '../db/time_machine.ts';
import { DedaloError, isErrorInDomain } from '../errors/dedalo_error.ts';
import {
	getColumnNameByModel,
	getMatrixTableFromTipo,
	getModelByTipo,
} from '../ontology/resolver.ts';
import type { SlotTarget } from '../relations/dataframe_slots.ts';
import { emitDataframeItem, expandPortal } from '../relations/relation_core.ts';
import {
	buildDataItem,
	type DataItem,
	EmissionContext,
	resolveComponentValue,
	type SectionsEnvelope,
	type TmAsOf,
} from '../resolve/component_data.ts';
import { currentDataLang } from '../resolve/request_lang.ts';
import {
	buildStructureContext,
	contextKey,
	type StructureContextEntry,
} from '../resolve/structure_context.ts';
import {
	ddoIsAuthorized,
	getPermissions,
	getSectionPermissions,
	inheritSubdatumPermission,
	type Principal,
	resolveComponentContextPermission,
	resolveOwnUserRecordPermission,
} from '../security/permissions.ts';
import type { LaneValue, RowLaneState } from '../tm_record/lane_state.ts';
import {
	classifyRelationSnapshot,
	MALFORMED_RELATION_VALUE_ERROR,
} from '../tm_record/relation_snapshot_shape.ts';
import {
	currentTimeMachineScopeSection,
	isTimeMachineRead,
} from './list_definitions/tm_scope_context.ts';
import { pickReadSource } from './read_source.ts';
import { prefetchRecords } from './record_loader.ts';

/**
 * Execute a section 'search' read and build the PHP-shaped data[] array.
 *
 * `principal` scopes the record search to the user's projects (per-record ACL,
 * §7.4). The dispatch read handler ALWAYS passes it for user requests so a
 * non-admin cannot over-see records on a project-gated section; global admins
 * pass through unfiltered.
 */
/** A full read result: parallel context[] + data[] (PHP build_json_rows shape). */
export interface ReadResult {
	context: StructureContextEntry[];
	data: (SectionsEnvelope | DataItem)[];
}

/**
 * Full read: context[] + data[]. Context entries: the section first, then one
 * per resolved component ddo, deduplicated by context_key (tipo+section+mode,
 * first occurrence wins — PHP merge_unique_context).
 */
export async function readSection(rqo: Rqo, principal?: Principal): Promise<ReadResult> {
	// One read = one point-in-time view, so a matrix row fetched for one
	// component is reused by every other component that wants it (see
	// db/record_memo.ts — the component_info widgets otherwise re-read the same
	// whole row once per declared path). The scope dies with the read; nothing
	// on the write path opens it.
	// A Time Machine read ALSO publishes its SCOPE — the caller section whose
	// history it reads — for the per-ddo permission floor
	// (WC-2026-08-14-tm-permission-floor). Here rather than in read_facade so
	// direct callers (readTimeMachineData, the native gates) resolve the same
	// permissions an HTTP request would. The scope is opened for EVERY TM read,
	// browse included: its PRESENCE is the `data_source === 'tm'` signal, its
	// SECTION is the authorization input, and an absent section (the bare browse)
	// is the fail-closed "admin only" answer.
	// The API handlers open the same scope around their whole body (Gate A
	// included — WC-2026-10-22-tm-scope-whole-request); this re-open is the
	// same answer from the same SQO, kept for the direct callers.
	const { withTimeMachineReadScope } = await import('./list_definitions/time_machine_list.ts');
	return withTimeMachineReadScope(rqo.sqo, () =>
		runWithRecordMemo(() => readSectionScoped(rqo, principal)),
	);
}

/**
 * A read that declared `source.session_save:false` has declared itself OUTSIDE
 * session navigation — so its context must not carry the section's stored
 * session SQO back to the client either. The client ADOPTS `sqo_session`
 * wholesale on its next build (section.js: `self.rqo.sqo = self.context
 * .sqo_session`), so stamping it onto a session-less read hands that read a
 * FOREIGN query: the embedded Time Machine panels share callerTipo 'dd15' with
 * the standalone dd15 browse, and a panel that adopted the browse's stored sqo
 * (offset 26, no filter) started listing the WHOLE 2.4M-row table on its first
 * pagination — silently, as always. Persist and merge already honour the flag
 * (readSectionRows); this closes the third door.
 *
 * WIRE: a deliberate divergence from PHP (which stamps sqo_session on every
 * section read) — WC-2026-08-16-sqo-session-not-persisted-on-session-save-false.
 * Gate: tm_session_sqo_isolation_native ("door 3 — THE STAMP").
 */
function stripSessionSqoStamp(
	context: StructureContextEntry[],
	source: Record<string, unknown>,
): StructureContextEntry[] {
	if (source.session_save !== false) return context;
	for (const entry of context) {
		if ((entry as { sqo_session?: unknown }).sqo_session !== undefined) {
			(entry as { sqo_session?: unknown }).sqo_session = null;
		}
	}
	return context;
}

/**
 * The stored session SQO a read may inherit from. The rule: the session never
 * widens a Time Machine read (`sqo.mode 'tm'`) past the scope the §7.4 gate
 * admitted — and the gate judged the SQO the client SENT, before this merge.
 *
 *   - A PER-SECTION scope is open (the client named section S): the read
 *     inherits NO scope-bearing key (`filter`, `filter_by_locators`). A stored
 *     pin naming another section (an earlier admitted read, a grant revoked
 *     since, pins a plain read stored under the same callerTipo) would otherwise
 *     replace S after the gate (WC-2026-10-22-tm-scope-whole-request, review r1
 *     addendum). Pagination keys (order/limit/offset) still ride the session.
 *   - UNSCOPED (the standalone dd15 browse: no filter sent, or none yet): the
 *     gate admitted the global admin only — there is no per-section scope to
 *     widen, so the admin's saved TM search is his own navigation and is
 *     inherited whole (else a reload lost it and the persist below overwrote
 *     the stored SQO with the bare one). Anyone else, or no TM scope open at
 *     all, keeps the strip — fail-closed.
 *
 * The row/count backstop (read_tm assertTmWhereInOpenedScope) still refuses any
 * WHERE outside a per-section scope, whatever produced it.
 */
const TM_SCOPE_SQO_KEYS = ['filter', 'filter_by_locators'] as const;
function sessionSqoForMerge(
	clientSqo: Rqo['sqo'],
	storedSqo: unknown,
	principal: Principal | undefined,
): unknown {
	const sqo = clientSqo as { mode?: unknown } | undefined;
	if (sqo?.mode !== 'tm' || isUnscopedAdminTmBrowse(principal)) return storedSqo;
	return withoutTmScopeKeys(storedSqo);
}

/** A copy of the stored SQO minus its scope-bearing keys (a non-object passes through). */
function withoutTmScopeKeys(storedSqo: unknown): unknown {
	if (storedSqo === null || typeof storedSqo !== 'object' || Array.isArray(storedSqo)) {
		return storedSqo;
	}
	const inheritable = { ...(storedSqo as Record<string, unknown>) };
	for (const key of TM_SCOPE_SQO_KEYS) delete inheritable[key];
	return inheritable;
}

/**
 * The unscoped dd15 browse, read by whom its gate admits: a TM read scope is
 * open WITHOUT a section, and the principal is a global admin (or there is no
 * request principal — an internal caller, which no gate judges).
 */
function isUnscopedAdminTmBrowse(principal: Principal | undefined): boolean {
	if (!isTimeMachineRead() || currentTimeMachineScopeSection() !== undefined) return false;
	return principal === undefined || principal.isGlobalAdmin;
}

async function readSectionScoped(rqo: Rqo, principal?: Principal): Promise<ReadResult> {
	const data = await readSectionRows(rqo, principal);
	const source = rqo.source ?? {};
	const callerTipo = source.tipo as string;
	// Same 'search'→'list' normalization as readSectionRows (the context half
	// must match the data half for the search-panel picker read).
	const mode = source.mode === 'search' ? 'list' : (source.mode ?? 'list');
	// Request-scoped data lang, never a hardcoded install default (S2-28): an
	// RQO that omits lang resolves the session's active data language.
	const lang = source.lang ?? currentDataLang();
	// PER-ELEMENT permissions stamp (PHP build_json_rows: each element's context
	// carries get_permissions(section, tipo) — the client renders <1 hidden,
	// ===1 read-only, >1 editable from exactly this field). An undefined
	// principal (internal calls, parity fixture replays) stamps 3; everyone
	// else — global admins included, PHP has no admin bypass — resolves through
	// the matrix (the superuser short-circuits to 3 inside getPermissions).
	// CONSULTATION-ONLY read: when the READ TARGET is a read-only section
	// (Activity dd542, Time Machine dd15, …) cap the whole emitted tree at read
	// (1) AT THE SOURCE — not just the section's own columns (buildStructureContext
	// handles those by section_tipo), but also the cross-section subdatum children
	// a portal pulls in (e.g. the 'Who' column's username dd132, whose own
	// section_tipo is dd128/Users and would otherwise escape the cap and render
	// editable). appendDerivedItemContexts threads the same cap.
	const readTargetSection = source.section_tipo ?? callerTipo;
	const capForReadTarget = (level: number): number =>
		level > 1 && isConsultationOnlySection(readTargetSection) ? 1 : level;
	// dd128 OWN-USER-RECORD override (PHP component_common::
	// get_component_permissions → resolve_component_read_permission, which EVERY
	// component instance's stamp goes through). It both upgrades the four
	// self-editable components (name/password/email/image → 2, what makes
	// tool_user_admin's self-service editor work for a user whose profile grants
	// nothing on dd128) and downgrades the guarded ones (own security-admin flag
	// → 1 always; profile/developer/username/section_id → 1 for a non-global-admin,
	// the anti-self-elevation half). The save door already consults the same
	// resolver; without it here the read stamp and the write gate disagree.
	//
	// Scoped to ddos of the READ TARGET section: only then is source.section_id
	// the element's own record id. A cross-section subdatum that happens to be a
	// dd128 component (the Activity 'Who' column's dd132) carries the id of ITS
	// row, not the read target's, so it must keep the matrix level.
	const ownRecordSectionId = source.section_id;
	const elementPermissions = async (
		elementSection: string,
		elementTipo: string,
	): Promise<number> => {
		if (principal === undefined) return capForReadTarget(3);
		const ownLevel =
			elementSection === readTargetSection
				? resolveOwnUserRecordPermission(principal, elementSection, elementTipo, ownRecordSectionId)
				: null;
		return capForReadTarget(
			ownLevel ?? (await getPermissions(principal, elementSection, elementTipo)),
		);
	};

	// Sources may OWN the structure-context (the dd15 TM source does — its columns
	// are client-driven, not ontology-derived). When present, skip the generic
	// context building below. The source is keyed by sqo.mode (the TM signal),
	// not source.mode (which stays 'list'/'edit').
	const readSource = await pickReadSource((rqo.sqo as { mode?: string } | undefined)?.mode);
	if (readSource.buildContext !== undefined) {
		const ctxPrincipal: Principal = principal ?? {
			userId: -1,
			isGlobalAdmin: true,
			isDeveloper: false,
		};
		const ownContext = await readSource.buildContext(rqo, ctxPrincipal);
		// The source owns the section + column contexts; the SUBDATUM child
		// contexts (e.g. the dd132 username under the dd578 user column) still come
		// from the emitted data items, same as the generic path — without them the
		// client can't render the subdatum rows (PHP get_subdatum merge).
		const ownSeen = new Set(ownContext.map(contextKey));
		await appendDerivedItemContexts(
			ownContext,
			ownSeen,
			data.filter((item): item is DataItem => (item as { typo?: string }).typo !== 'sections'),
			{ sectionTipo: source.section_tipo ?? callerTipo, lang, principal, capForReadTarget },
		);
		return { context: stripSessionSqoStamp(ownContext, source as Record<string, unknown>), data };
	}

	const context: StructureContextEntry[] = [];
	const seen = new Set<string>();
	// A caller may request a SECTION view (PHP get_view top precedence — the
	// ddo/source-injected view wins over the section_list child's and the model
	// default). The search-panel preset picker requests view:'search_user_presets'
	// so the SAME section (dd623) renders compact HERE while its general menu list
	// (no source.view) keeps the section_list default. Mirrors the MAIN-component
	// requestedView below (the ?view=viewer deep link).
	const requestedSectionView =
		typeof source.view === 'string' && source.view !== '' ? source.view : null;
	const sectionEntry = await buildStructureContext({
		tipo: callerTipo,
		sectionTipo: source.section_tipo ?? callerTipo,
		mode,
		lang,
		view: requestedSectionView,
		// Section-level ACL (PHP section::get_section_permissions — includes the
		// consultation-only cap); the handler's Gate A/B guarantee ≥ 1 here.
		permissions:
			principal === undefined
				? capForReadTarget(3)
				: capForReadTarget(await getSectionPermissions(principal, readTargetSection)),
		// Thread the principal so the section button context uses the real
		// per-button ACL (SECTION_SPEC §9) instead of the caller-permission cap.
		principal,
		// An rqo source.properties OVERRIDE replaces the section's ontology
		// properties (PHP dd_core_api read :2305-2308 — `$element->set_properties`
		// runs for the SECTION branch too, before the context build). A TOOL opens
		// a section with its OWN declared layout: tool_cataloging's
		// `section_to_cataloging` ddo ships a source.request_config whose columns
		// carry `in_mosaic` / `hover`, and the mosaic view renders exactly those.
		// Ignoring the override served the section's plain section_list instead —
		// different columns, none of them flagged, so the view filtered every one
		// out and each record rendered as a bare drag handle.
		propertiesOverride: (source.properties ?? undefined) as Record<string, unknown> | undefined,
	});
	if (sectionEntry !== null) {
		context.push(sectionEntry);
		seen.add(contextKey(sectionEntry));
	}
	const rqoDdoMap = await resolveSectionColumnDdoMap(
		rqo,
		callerTipo,
		source.section_tipo ?? callerTipo,
		mode,
	);
	for (const ddo of rqoDdoMap) {
		// A multi-target ddo (a picker whose show map names N target sections, e.g.
		// the epigraphy autocomplete's hierarchy95 over the eight glyph thesauri)
		// is a DIFFERENT ontology element in each of those sections. The client
		// looks its context up by (tipo, section_tipo) of the row it is rendering
		// (view_default_autocomplete.render_grid_choose), so one entry built against
		// the first target silently drops every row from the other seven. Emit one
		// entry per section the read ACTUALLY returned rows from; with no rows to
		// go on (an empty result still ships structure) fall back to the first target.
		const ddoSectionTipos = resolveDdoContextSections(ddo, source.section_tipo ?? callerTipo, data);
		for (const ddoSectionTipo of ddoSectionTipos) {
			// Per-component READ gate (PHP check_ddo_permissions / STEP 5
			// filter_authorized_related): a denied component contributes NO context
			// entry. This is the confidentiality boundary for CLIENT-SENT maps —
			// the client can name any tipo in show.ddo_map, and the config-build
			// gates only shape the server-derived default.
			if (!(await ddoIsAuthorized(principal, ddoSectionTipo, ddo.tipo))) continue;
			// The element's descendants in the caller's map narrow its show config
			// (PHP get_subdatum children-injection).
			const rqoChildren = collectCallerDescendants(rqoDdoMap, ddo.tipo);
			const resolvedParent = ddo.parent === 'self' ? callerTipo : (ddo.parent ?? null);
			// A NESTED ddo (parent is a component, not the section) is a subdatum: its
			// sort join must start at the LISTED section, so hand its parent-portal to
			// buildOrderPath for the prepend (PHP get_order_path from_component/from_section).
			const orderPathFrom =
				resolvedParent !== null && resolvedParent !== callerTipo
					? {
							componentTipo: resolvedParent,
							sectionTipo:
								context.find((existing) => existing.tipo === resolvedParent)?.section_tipo ??
								source.section_tipo ??
								callerTipo,
						}
					: undefined;
			const entry = await buildStructureContext({
				tipo: ddo.tipo,
				sectionTipo: ddoSectionTipo,
				mode: ddo.mode ?? mode,
				lang: ddo.lang ?? lang,
				// Per-element matrix level (the ddoIsAuthorized drop above guarantees
				// ≥ 1 for defined principals — the client renders 1 read-only, ≥2 edit).
				permissions: await elementPermissions(ddoSectionTipo, ddo.tipo),
				parent: resolvedParent,
				view: ddo.view ?? null,
				childrenView: (ddo as { children_view?: string | null }).children_view ?? null,
				rqoChildrenDdos: rqoChildren as unknown as Record<string, unknown>[],
				orderPathFrom,
				// WC-079: a temporal clone ships no component toolbar.
				isTemporal: isTemporalSource(source),
			});
			if (entry !== null && !seen.has(contextKey(entry))) {
				seen.add(contextKey(entry));

				// PER-RECORD context options for section EDIT views (the same
				// resolveContextOptions facet buildGetDataContext dispatches on the
				// tool/get_data route — see there for the full why; registry dispatch,
				// never a model conditional, S2-24). The context is deduped by
				// contextKey across the read's rows, so this is first-record-wins —
				// exactly PHP merge_unique_context, which kept the first component
				// context it built.
				if ((entry.mode ?? mode) === 'edit') {
					const ddoModel = await getModelByTipo(ddo.tipo);
					const contextHook = ddoModel === null ? undefined : getEmitHook(ddoModel);
					if (contextHook?.resolveContextOptions !== undefined) {
						const firstRow = data.find((item) => (item as { typo?: string }).typo === 'sections') as
							| { section_id?: unknown }
							| undefined;
						const rowId = Number(firstRow?.section_id ?? Number.NaN);
						if (Number.isInteger(rowId) && rowId > 0) {
							const options = await contextHook.resolveContextOptions({
								tipo: ddo.tipo,
								sectionTipo: ddoSectionTipo,
								sectionId: rowId,
							});
							if (options !== null) {
								entry.options = { ...(entry.options ?? {}), ...options };
							}
						}
					}
				}

				context.push(entry);
			}
		}
	}

	// SUBDATUM CHILD contexts (PHP get_subdatum merges every element's
	// subcontext into the response): one entry per UNIQUE (tipo, section,
	// mode) among the emitted child items, parented to its generating
	// component. Without these the client's portal/autocomplete rows have no
	// component structure to render (the empty-chips bug of 2026-07-03).
	await appendDerivedItemContexts(
		context,
		seen,
		data.filter((item): item is DataItem => (item as { typo?: string }).typo !== 'sections'),
		{ sectionTipo: source.section_tipo ?? callerTipo, lang, principal, capForReadTarget },
	);

	attachSectionTabChildren(context);

	if (sectionEntry !== null && hasCallerShow(rqo)) {
		narrowSectionShowToCaller(sectionEntry, rqoDdoMap, context);
	}

	return { context: stripSessionSqoStamp(context, source as Record<string, unknown>), data };
}

/** The caller sent its own columns (a literal show.ddo_map or a get_ddo_map directive). */
function hasCallerShow(rqo: Rqo): boolean {
	const show = rqo.show as { ddo_map?: unknown; get_ddo_map?: unknown } | undefined;
	return (
		(Array.isArray(show?.ddo_map) && show.ddo_map.length > 0) || show?.get_ddo_map !== undefined
	);
}

/**
 * A caller-shaped read (PHP build_request_config_from_rqo short-circuit) must
 * ship the SAME columns on the section entry's own request_config as the data
 * half resolved (resolveSectionColumnDdoMap). The client builds its
 * columns_map from context.request_config (common.js get_columns_map), so
 * leaving the ontology section_list there rendered one EMPTY cell per
 * unrequested column — the preset pickers (dd623/dd1781) asked for the name
 * only and got 5 blank cells, wrapping their rows. Only the dedalo main item's
 * show.ddo_map is replaced, immutably: the entry is a shallow clone of the
 * structural cache, so its nested request_config is shared.
 */
function narrowSectionShowToCaller(
	sectionEntry: StructureContextEntry,
	callerDdoMap: readonly Ddo[],
	context: readonly StructureContextEntry[],
): void {
	const items = sectionEntry.request_config;
	if (!Array.isArray(items)) return;
	const mainIndex = items.findIndex(isDedaloMainItem);
	if (mainIndex === -1) return;
	const main = items[mainIndex] as { show?: { ddo_map?: Record<string, unknown>[] } };
	const narrowed = callerColumns(callerDdoMap, sectionEntry, main.show?.ddo_map ?? [], context);
	const replaced = [...items];
	replaced[mainIndex] = { ...main, show: { ...main.show, ddo_map: narrowed } };
	sectionEntry.request_config = replaced;
}

function callerColumns(
	callerDdoMap: readonly Ddo[],
	sectionEntry: StructureContextEntry,
	ontologyDdos: readonly Record<string, unknown>[],
	context: readonly StructureContextEntry[],
): Record<string, unknown>[] {
	const columns: Record<string, unknown>[] = [];
	for (const ddo of callerDdoMap) {
		const column = callerColumn(ddo, sectionEntry, ontologyDdos, context);
		if (column !== undefined) columns.push(column);
	}
	return columns;
}

function isDedaloMainItem(item: unknown): boolean {
	const i = item as { api_engine?: string; type?: string };
	return i.api_engine === 'dedalo' && i.type === 'main';
}

/** `self` / absent resolves to the fallback (the section entry's own tipo). */
function selfOr<T>(value: T | undefined, fallback: string): T | string {
	return value === undefined || value === 'self' ? fallback : value;
}

/**
 * One caller ddo as a section-list column: the ontology's own ddo when it has
 * one, else a minimal ddo from the built context entry. undefined = no context
 * entry (the per-component READ gate dropped it): no column either.
 */
function callerColumn(
	ddo: Ddo,
	sectionEntry: StructureContextEntry,
	ontologyDdos: readonly Record<string, unknown>[],
	context: readonly StructureContextEntry[],
): Record<string, unknown> | undefined {
	const ddoSection = selfOr(ddo.section_tipo, sectionEntry.section_tipo);
	const built = context.find((c) => c.tipo === ddo.tipo && c.section_tipo === ddoSection);
	if (built === undefined) return undefined;
	const known = ontologyDdos.find((d) => d.tipo === ddo.tipo && d.section_tipo === ddoSection);
	return (
		known ?? {
			tipo: ddo.tipo,
			model: built.model,
			section_tipo: ddoSection,
			parent: selfOr(ddo.parent, sectionEntry.tipo),
			mode: built.mode,
			label: built.label,
		}
	);
}

/**
 * section_tab tab bar (client contract, render_section_tab.js:139): each
 * section_tab grouper carries a `children` array [{tipo,label}] naming its tab
 * panels — the client reads `context.children.length` and crashes the whole edit
 * view if it is absent. Derive from the already-built, permission-filtered
 * sibling entries parented to this grouper (parent_grouper = the ONTOLOGY parent;
 * the flat legacy ddo_map parents every element to the section, so `parent` can't
 * be used here), so the tab labels exactly match the panels that will render, in
 * ontology order. Mutates the entries in place. The inner tab nodes are also
 * model 'section_tab' (view 'tab') and get a `children` array too — harmless, the
 * client only reads it in the 'section_tab' view.
 */
export function attachSectionTabChildren(context: StructureContextEntry[]): void {
	for (const entry of context) {
		if (entry.model === 'section_tab') {
			entry.children = context
				.filter((child) => child.parent_grouper === entry.tipo)
				.map((child) => ({ tipo: child.tipo, label: child.label }));
		}
	}
}

/**
 * An element's descendants in the caller's ddo_map — RECURSIVE, child then its
 * own descendants, order-preserving (PHP get_subdatum $get_children_recursive,
 * class.common.php:2297-2310): a grandchild declared in the caller's map lands
 * in the SAME flat injected show.ddo_map as its parent. The seen-set guards a
 * malformed self-/cyclic-parent map (PHP would recurse forever there too — the
 * ontology never declares one, but a client-sent map could).
 */
/**
 * The section(s) a ddo_map entry's structure context must be built for.
 *
 * A single-target ddo has exactly one ('self' resolving to the read's own
 * section). A MULTI-target ddo — a picker whose show map names N target
 * sections, e.g. the epigraphy autocomplete's `hierarchy95` over the eight glyph
 * thesauri (scell1, scxpu1, scxibo1, scxibm1, sctxr1, sclat1, scsym1, sccmk1) —
 * is a distinct ontology element in each one: different label, features and ACL.
 * The client resolves a row's component context by BOTH tipo and section_tipo
 * (view_default_autocomplete.render_grid_choose:
 * `context.find(item => item.tipo===ddo_item.tipo && item.section_tipo===data.section_tipo)`),
 * so a single entry built against the first target makes every row from the
 * other targets fail that lookup and render nothing — the empty glyph grid of
 * tool_numisdata_epigraphy.
 *
 * Narrow to the sections the read ACTUALLY returned rows for, so the common
 * single-section search still ships exactly one entry. With no rows to go on
 * (an empty result still ships structure) fall back to the first declared
 * target — the pre-existing behaviour.
 */
export function resolveDdoContextSections(
	ddo: Ddo,
	ownSectionTipo: string,
	data: readonly unknown[],
): string[] {
	const declared = declaredDdoTargets(ddo, ownSectionTipo);
	if (declared.length < 2) return declared;

	const present = sectionTiposPresentFor(data, ddo.tipo);
	const matched = declared.filter((tipo) => present.has(tipo));

	return matched.length > 0 ? matched : [declared[0] as string];
}

/** The sections a ddo_map entry NAMES, 'self' resolved, non-string members dropped. */
function declaredDdoTargets(ddo: Ddo, ownSectionTipo: string): string[] {
	if (ddo.section_tipo === undefined || ddo.section_tipo === 'self') return [ownSectionTipo];
	if (!Array.isArray(ddo.section_tipo)) return [ddo.section_tipo];
	const declared = ddo.section_tipo.filter((tipo): tipo is string => typeof tipo === 'string');
	return declared.length > 0 ? declared : [ownSectionTipo];
}

/** The sections this read ACTUALLY emitted rows of `tipo` for. */
function sectionTiposPresentFor(data: readonly unknown[], tipo: string): Set<string> {
	const present = new Set<string>();
	for (const item of data) {
		const row = item as { tipo?: unknown; section_tipo?: unknown };
		if (row.tipo === tipo && typeof row.section_tipo === 'string') present.add(row.section_tipo);
	}
	return present;
}

export function collectCallerDescendants(callerDdoMap: Ddo[], elementTipo: string): Ddo[] {
	const collect = (parentTipo: string, seenTipos: Set<string>): Ddo[] => {
		const descendants: Ddo[] = [];
		for (const candidate of callerDdoMap) {
			if (candidate.parent !== parentTipo || seenTipos.has(candidate.tipo)) continue;
			seenTipos.add(candidate.tipo);
			descendants.push(candidate, ...collect(candidate.tipo, seenTipos));
		}
		return descendants;
	};
	return collect(elementTipo, new Set([elementTipo]));
}

/**
 * Derive context entries from ACTUALLY-EMITTED data items (the get_data
 * derivation generalized): each unique (tipo, section_tipo, mode) gets one
 * entry, parented to its generating component (from_component_tipo), with
 * the ddo view looked up in the parent's own edit config. Deduplicates
 * against — and appends to — the caller's entries/seen set.
 */
async function appendDerivedItemContexts(
	entries: StructureContextEntry[],
	seen: Set<string>,
	items: DataItem[],
	defaults: {
		sectionTipo: string;
		lang: string;
		principal?: Principal;
		capForReadTarget: (level: number) => number;
	},
): Promise<void> {
	// per-parent ddo-view lookup: a child's context `view` comes from the
	// GENERATING component's config ddo (e.g. numisdata158 declares 'line' in
	// numisdata77's show.ddo_map).
	const ownerSectionOf = new Map<string, string>();
	const viewCache = new Map<string, Map<string, string | null>>();
	const ddoViewOf = async (parentTipo: string, childTipo: string): Promise<string | null> => {
		let views = viewCache.get(parentTipo);
		if (views === undefined) {
			views = new Map<string, string | null>();
			const { getEffectivePropertiesByTipo } = await import('../ontology/alias.ts');
			const { buildRequestConfigForElement } = await import('../relations/request_config/build.ts');
			// component_alias (WC-020): a child's view may be declared in an ALIAS
			// parent's merged show map.
			const parentConfig = await buildRequestConfigForElement(
				(await getEffectivePropertiesByTipo(parentTipo)) ?? null,
				{
					ownerTipo: parentTipo,
					ownerSectionTipo: ownerSectionOf.get(parentTipo) ?? defaults.sectionTipo,
					mode: 'edit',
					ownerIsSection: false,
				},
			);
			// EVERY config item's show map (PHP full_ddo_map): a second source's
			// column may carry the `view` its child renders with.
			const { flattenConfigDdoMaps } = await import('../relations/config_ddo_map.ts');
			for (const ddo of flattenConfigDdoMaps(parentConfig, { ownerTipo: parentTipo })) {
				if (typeof ddo.tipo !== 'string') continue;
				views.set(ddo.tipo, (ddo.view as string | undefined) ?? null);
			}
			viewCache.set(parentTipo, views);
		}
		return views.get(childTipo) ?? null;
	};

	for (const item of items) {
		const itemTipo = String(item.tipo);
		const parentTipo = String(item.from_component_tipo ?? itemTipo);
		if (parentTipo === itemTipo) continue; // own items — already covered
		if (!ownerSectionOf.has(itemTipo)) {
			ownerSectionOf.set(itemTipo, String(item.section_tipo));
		}
		// A subdatum's sort join must start at the LISTED section (PHP
		// get_order_path from_component/from_section prepend): the parent portal's
		// own section is where it hangs (already-built context entry), else the
		// listed section for a direct child.
		const parentEntry = entries.find((existing) => existing.tipo === parentTipo);
		const parentSection = parentEntry?.section_tipo ?? defaults.sectionTipo;
		// Subdatum permission inheritance (PHP get_subdatum, class.common.php
		// :2567-2575): the child's own matrix level, floored to read through the
		// authorized generating component (portal targets stay visible without a
		// target-section grant) and capped at read under a read-only caller —
		// then the read-target consultation-only cap.
		const permissions =
			defaults.principal === undefined
				? defaults.capForReadTarget(3)
				: defaults.capForReadTarget(
						inheritSubdatumPermission(
							await getPermissions(defaults.principal, String(item.section_tipo), itemTipo),
							parentEntry?.permissions ?? 3,
						),
					);
		const entry = await buildStructureContext({
			tipo: itemTipo,
			sectionTipo: String(item.section_tipo),
			mode: String(item.mode),
			lang: String(item.lang),
			permissions,
			parent: parentTipo,
			view: await ddoViewOf(parentTipo, itemTipo),
			orderPathFrom: { componentTipo: parentTipo, sectionTipo: parentSection },
		});
		if (entry !== null && !seen.has(contextKey(entry))) {
			seen.add(contextKey(entry));
			entries.push(entry);
		}
	}
}

/**
 * Component `get_data` read (PHP dd_core_api build_json_rows action='get_data'):
 * resolve ONE relation component (portal/autocomplete) directly — its own item
 * (paginated by the rqo sqo) plus each paged locator expanded through the
 * component's OWN request_config (edit-mode child tree). This is the "show
 * more" / portal-pagination path the runtime client uses.
 *
 * Returns data[] only (context is Phase 4 continuation for this action).
 */
/** The classified record id, or NaN on any no-record kind (legacy local shape). */
function recordIdOrNaN(wireSectionId: { kind: string; id?: number }): number {
	return wireSectionId.kind === 'record' && wireSectionId.id !== undefined
		? wireSectionId.id
		: Number.NaN;
}

/**
 * Why a LITERAL component whose record resolved to null still deserves an
 * emission — null means "serve the PHP empty shell" (`return []`):
 *
 * - 'tm'       — a TM preview of a component whose live record is gone
 *                (restored-from-deletion history): PHP still plays the snapshot
 *                back, so it needs an empty virtual record to carry it;
 * - 'temporal' — a tool's throwaway editable clone (WC-059): the client's
 *                `self.data = data || {}` leaves the widget with no entries
 *                array at all when the item is missing;
 * - 'search'   — SEARCH mode against a SYNTHETIC filter-row id ('search_<n>',
 *                search.js get_section_id) addresses no record BY DESIGN. The
 *                relation branch already serves this as "the component's own
 *                item, entries:[]" (PHP get_json emits the item whenever
 *                permissions > 0, record or not) and the literal branch used to
 *                answer NOTHING: component_filter_records' search render
 *                iterates self.data.datalist UNGUARDED
 *                (render_search_component_filter_records:165), so that filter
 *                row threw and never reached 'rendered'.
 */
function literalNoRecordKind(
	source: { mode?: string },
	tmOverride: unknown | null,
): 'tm' | 'temporal' | 'search' | null {
	if (tmOverride !== null) return 'tm';
	if (isTemporalSource(source)) return 'temporal';
	return (source.mode ?? 'edit') === 'search' ? 'search' : null;
}

/**
 * The empty virtual record a null-record LITERAL read is served on, or null
 * when the honest answer is the PHP empty shell (see literalNoRecordKind).
 * `rowId` is the id the emission stamps: the SEARCH shell's wire id is
 * SYNTHETIC (Number('search_1') is NaN), so it emits at 0 and the verbatim id
 * is restored by stampSearchShellItems.
 */
async function materializeLiteralShell(
	source: { mode?: string },
	sectionTipo: string,
	sectionId: unknown,
	tmOverride: unknown | null,
): Promise<{ record: MatrixRecord; rowId: number; searchShell: boolean } | null> {
	const kind = literalNoRecordKind(source, tmOverride);
	if (kind === null) return null;
	const searchShell = kind === 'search';
	const rowId = searchShell ? 0 : Number(sectionId);
	const { makeVirtualRecord } = await import('../section_record/virtual_record.ts');
	return { record: makeVirtualRecord(sectionTipo, rowId), rowId, searchShell };
}

/**
 * Does this time-machine snapshot belong to the record living at
 * (sectionTipo, sectionId) NOW?
 *
 * The ADDRESS ALONE IS NOT IDENTITY (P0-14). Where a section_id was re-minted,
 * a dead record's rows carry the living record's exact coordinates — so the
 * preview pane would graft the dead record's value over the living record's
 * fields and present it as that record's own history. The generation epoch is
 * the second half of the identity.
 */
async function tmRowBelongsToRecord(
	tmRow: { id: number; section_tipo: string; section_id: number },
	sectionTipo: string,
	sectionId: number,
): Promise<boolean> {
	if (tmRow.section_tipo !== sectionTipo || tmRow.section_id !== sectionId) return false;
	const { recordEpoch } = await import('../db/record_generation.ts');
	return tmRow.id >= (await recordEpoch(sectionTipo, sectionId));
}

/**
 * Whether a TM row may be served as the preview of `tipo` on this record: it
 * belongs to the record (tmRowBelongsToRecord), and it is not a row under a
 * dataframe slot's OWN tipo — no supported history has one (PHP never wrote
 * one; a slot's frames ride in its main's composed row), so it previews empty.
 */
async function tmRowServable(
	tmRow: { id: number; section_tipo: string; section_id: number; tipo: string },
	sectionTipo: string,
	sectionId: number,
	model: string,
	tipo: string,
): Promise<boolean> {
	if (model === 'component_dataframe' && tmRow.tipo === tipo) return false;
	return tmRowBelongsToRecord(tmRow, sectionTipo, sectionId);
}

/**
 * A TM preview's graft over the record the read serves (resolveTmPreview) —
 * the STATE AT THE ROW, reconstructed from the two lanes
 * (tm_record/lane_state.ts). `value`: the row's state and the other half of
 * the timeline AS OF the row (an lg-nolan row previews the view language as it
 * stood; a language row previews the lg-nolan value as it stood), put back over
 * the live key by lane_state.ts previewLaneValue — the row's own lane exactly
 * as apply_value writes it. Null: the component keeps its live value. `slots`
 * are the frame state as of the row, per dataframe slot of `mainTipo`; a slot
 * the frame state carries no frame for previews EMPTY; null (no slot in play)
 * keeps the live frames.
 */
interface TmPreviewGraft {
	value: { state: RowLaneState; asOf: LaneValue | null } | null;
	law: { sliced: boolean; translatable: boolean };
	mainTipo: string;
	slots: Map<string, Record<string, unknown>[]> | null;
}

/**
 * The Time Machine PREVIEW override (PHP component_common::get_data
 * data_source='tm', dd_core_api :2372-2383): the tool_time_machine preview pane
 * loads a component's value from a SPECIFIC matrix_time_machine row, not the
 * live record. The section context and datalist stay live — only the value
 * changes.
 *
 * TWO LANES (WC-2026-09-27-bulk-revert-undo-log, addendum "two lanes"): a row
 * of a main is ONE lane — a language's value, or the lg-nolan value + every
 * frame — so the preview shows the FULL state at the row: the row's lane, the
 * other lane as of the row, and the frames as of the row (the newest frame
 * state at or below it), so a middle state of the timeline is visible exactly
 * as it stood. A dataframe requested by the main's row id (PHP searches the
 * MAIN's row for a component_dataframe) takes the frames as of that row. A row
 * under a slot's OWN tipo is no supported history (PHP never wrote one; TS-era
 * beta rows are unsupported) and previews empty, like an absent row.
 *
 * `served:false` means the caller must answer empty, as PHP does for an absent
 * row — and, since P0-14, for a row belonging to a dead generation at the same
 * address. A bulk run's undo-log row (tm_role set: a hidden BEFORE image, a
 * birth marker) is answered as ABSENT by readTimeMachineRow's visibility
 * narrowing, so its id previews empty, never as history nobody saw.
 */
async function resolveTmPreview(
	source: RqoSource,
	model: string,
	tipo: string,
	sectionTipo: string,
	sectionId: number,
	refusal: TmPreviewRefusal,
): Promise<TmPreview> {
	if (source.data_source !== 'tm' || source.matrix_id === null || source.matrix_id === undefined) {
		return { served: true, graft: null, asOf: null, siblingSlot: false };
	}
	const { readTimeMachineRow } = await import('../db/time_machine.ts');
	const storedRow = await readTimeMachineRow(Number(source.matrix_id));
	if (storedRow === null) return TM_PREVIEW_NOT_SERVED;
	const tmRow = shapedPreviewRow(storedRow, model, tipo, refusal);
	if (await tmRowServable(tmRow, sectionTipo, sectionId, model, tipo)) {
		const graft = await tmPreviewGraft(
			tmRow,
			model,
			{ sectionTipo, sectionId },
			viewLangOf(source),
		);
		// asOf even when graft is null: a row with nothing to graft on the main
		// still previews its frame children as of the row.
		return { served: true, graft, asOf: await tmAsOfRow(tmRow), siblingSlot: false };
	}
	if (await siblingSlotServable(source, tmRow, model, tipo, sectionTipo, sectionId)) {
		return { served: true, graft: null, asOf: await tmAsOfRow(tmRow), siblingSlot: true };
	}
	return TM_PREVIEW_NOT_SERVED;
}

/**
 * The preview's half of the relation shape gate (WC-2026-10-24-tm-malformed-relation-cell,
 * tm_record/relation_snapshot_shape.ts — the dd15 list's twin). The row of the
 * previewed relation component itself: a non-locator value (a pre-v6 bare id,
 * label strings…) previews as the EMPTY value, never handed to the relation
 * readers (it threw there) nor to the client, and its reason is recorded in
 * `refusal` for readComponentData to flag the item; a single locator object
 * previews as `[locator]`. Not converted. Every other row passes verbatim.
 */
function shapedPreviewRow<T extends { tipo: string; data: unknown }>(
	tmRow: T,
	model: string,
	tipo: string,
	refusal: TmPreviewRefusal,
): T {
	if (tmRow.tipo !== tipo || model === 'component_dataframe') return tmRow;
	if (getColumnNameByModel(model) !== 'relation' || tmRow.data === null) return tmRow;
	const shape = classifyRelationSnapshot(tmRow.data);
	if (shape.kind === 'locators') return { ...tmRow, data: shape.items };
	refusal.reason = shape.reason;
	return { ...tmRow, data: [] };
}

/** Where resolveTmPreview records a refused relation snapshot (shapedPreviewRow). */
interface TmPreviewRefusal {
	reason: string | null;
}

/**
 * readComponentData's flag of a refused preview: the requested component's
 * item(s) carry `error: 'malformed_relation_value'` + the reason — the same
 * named exemption the history list's cell carries (read_tm.ts flaggedTmCell).
 */
function flagRefusedPreview(items: DataItem[], tipo: string, reason: string | null): DataItem[] {
	if (reason === null) return items;
	for (const item of items) {
		if (item.tipo !== tipo) continue;
		const flagged = item as DataItem & { error?: string; reason?: string };
		flagged.error = MALFORMED_RELATION_VALUE_ERROR;
		flagged.reason = `This Time Machine row stores a malformed relation value that cannot be shown as a record link: ${reason}. The snapshot is kept unchanged.`;
	}
	return items;
}

/**
 * What resolveTmPreview answers. `asOf`: the bound the preview subject's frame
 * children read at (tm_record/frame_as_of.ts) — non-null whenever a row is
 * served. `siblingSlot`: the read is a SIBLING-anchored slot previewed through
 * its main's row (siblingSlotServable) — its bag is taken as of the bound.
 */
type TmPreview =
	| { served: true; graft: TmPreviewGraft | null; asOf: TmAsOf | null; siblingSlot: boolean }
	| { served: false; graft: null; asOf: null; siblingSlot: false };

const TM_PREVIEW_NOT_SERVED: TmPreview = {
	served: false,
	graft: null,
	asOf: null,
	siblingSlot: false,
};

/**
 * A TM preview's emission and the record it emits from. Under a served bound
 * the emission ROOT is a CLONE of `record` (frame_as_of.ts rootedAt): the one
 * object that stands for the subject — never the live object record_loader
 * answers when the subject's own address is met again NESTED (a portal target
 * pointing back at it), which therefore stays live, as in the history list.
 * No bound: `record` itself and a plain emission.
 */
async function tmPreviewEmission(
	preview: TmPreview,
	record: MatrixRecord,
): Promise<{ emission: EmissionContext; root: MatrixRecord }> {
	if (preview.asOf === null) return { emission: new EmissionContext(), root: record };
	const { rootedAt } = await import('../tm_record/frame_as_of.ts');
	const { cloneRecord } = await import('../section_record/index.ts');
	const root = cloneRecord(record);
	return { emission: new EmissionContext([], { tmAsOf: rootedAt(preview.asOf, root) }), root };
}

/** The preview bound of a served row: frame_as_of.ts tmAsOfRow (the one bound computation). */
async function tmAsOfRow(tmRow: {
	id: number;
	section_tipo: string;
	section_id: number;
	tipo: string;
}): Promise<TmAsOf> {
	const { tmAsOfRow: boundOf } = await import('../tm_record/frame_as_of.ts');
	return boundOf(tmRow);
}

/**
 * DOOR 3 ON A SIBLING-ANCHORED SLOT. A main whose slot is declared on a SIBLING
 * section (numisdata75 on numisdata3/N keeps its frames on numisdata4/N) has
 * its preview's frame widget read DIRECTLY with section_tipo = the sibling and
 * matrix_id = a row of the MAIN's record — which tmRowBelongsToRecord refuses
 * (the section differs), so the widget came back empty. Served ONLY when every
 * one of these holds — anything looser would serve a foreign row as this
 * record's history:
 *   - the model is component_dataframe and the row is not under the slot's own tipo;
 *   - the caller's pairing is complete and names the row's main;
 *   - the row's record is the sibling's id at another section;
 *   - the main's own config declares THIS slot on THIS section;
 *   - the row belongs to the MAIN's living record (its epoch).
 */
async function siblingSlotServable(
	source: RqoSource,
	tmRow: { id: number; section_tipo: string; section_id: number; tipo: string },
	model: string,
	tipo: string,
	sectionTipo: string,
	sectionId: number,
): Promise<boolean> {
	if (model !== 'component_dataframe' || tmRow.tipo === tipo) return false;
	if (tmRow.section_tipo === sectionTipo || tmRow.section_id !== sectionId) return false;
	const pairing = callerDataframePairing(source);
	if (pairing === null || pairing.main_component_tipo !== tmRow.tipo) return false;
	const { resolveOwnConfigMap } = await import('./list_definitions/section_list.ts');
	const declared = ((await resolveOwnConfigMap(tmRow.tipo)).rawDdos ?? []).some((ddo) => {
		const declaredSection = Array.isArray(ddo.section_tipo)
			? ddo.section_tipo[0]
			: ddo.section_tipo;
		return ddo.tipo === tipo && declaredSection === sectionTipo;
	});
	if (!declared) return false;
	return tmRowBelongsToRecord(tmRow, tmRow.section_tipo, sectionId);
}

/**
 * Whether the preview plays a recorded state back over the record (live or a
 * virtual stand-in): a grafted row, or door 3 on a sibling slot.
 */
function previewPlaysBack(preview: TmPreview): boolean {
	return preview.graft !== null || preview.siblingSlot;
}

/**
 * The record with the served preview played back (previewPlaysBack): the
 * row's graft, else DOOR 3 ON A SIBLING SLOT (siblingSlotServable) — the slot
 * bag of this sibling record as of the main row's bound (the frames the row's
 * state held, other mains' frames live). `liveRecord`: the record as it lives
 * NOW (null when gone) — the anchor's lifecycle is judged by it
 * (frame_as_of.ts wholeRowIsDelete), never by the virtual stand-in.
 */
async function applyTmPreview(
	record: MatrixRecord,
	liveRecord: MatrixRecord | null,
	tipo: string,
	model: string,
	preview: TmPreview,
): Promise<MatrixRecord> {
	if (preview.graft !== null) return applyTmGraft(record, tipo, model, preview.graft);
	if (preview.asOf === null) return record;
	const { frameBagAsOf } = await import('../tm_record/frame_as_of.ts');
	const bag = await frameBagAsOf(
		null,
		{ sectionTipo: record.section_tipo, sectionId: Number(record.section_id) },
		liveRecord,
		preview.asOf.mainTipo,
		tipo,
		preview.asOf,
	);
	return bag ?? record;
}

/**
 * The portal expansion's `targetsAsOf` option: a DIRECT dataframe read's
 * locators are frames, so inside a TM preview their targets read as of the
 * row (door 3). No other model.
 */
function portalAsOfOption(model: string, preview: TmPreview): { targetsAsOf?: TmAsOf } {
	return model === 'component_dataframe' && preview.asOf !== null
		? { targetsAsOf: preview.asOf }
		: {};
}

/** The language the preview is asked in ('' when the request names none). */
function viewLangOf(source: { lang?: unknown }): string {
	return typeof source.lang === 'string' ? source.lang : '';
}

/** The graft of one visible TM row (see resolveTmPreview); null = nothing to graft. */
async function tmPreviewGraft(
	tmRow: { id: number; tipo: string; lang: string | null; data: unknown },
	model: string,
	live: Omit<SlotTarget, 'table'>,
	viewLang: string,
): Promise<TmPreviewGraft | null> {
	// Rationale 3 (CONVENTIONS §2): the TM preview is a cold, tool-scale path.
	// The state + frames at the row: frame_as_of.ts rowFrameState, the one
	// source the history list's cells read too (resolve/read_tm.ts).
	const { rowFrameState } = await import('../tm_record/frame_as_of.ts');
	const mainModel = model === 'component_dataframe' ? await getModelByTipo(tmRow.tipo) : model;
	const { state, law, slots } = await rowFrameState(tmRow, mainModel, live, viewLang);
	const coords = { ...live, componentTipo: tmRow.tipo };
	const value =
		model === 'component_dataframe'
			? null
			: previewValueOf(state, await previewAsOf(state, coords, tmRow.id, law, viewLang));
	if (value === null && slots === null) return null;
	return { value, law, mainTipo: tmRow.tipo, slots };
}

/** The value half of a graft: null when the row shows no value (a frames-only row with no lane as of it). */
function previewValueOf(state: RowLaneState, asOf: LaneValue | null): TmPreviewGraft['value'] {
	return state.own.recorded || asOf !== null ? { state, asOf } : null;
}

/**
 * The timeline's other half AS OF the row (the view language for an lg-nolan
 * row, the lg-nolan value for a language row); null when that lane holds no
 * value history speaks for (readLaneValueAt).
 */
async function previewAsOf(
	state: RowLaneState,
	coords: TmCoords,
	rowId: number,
	law: { sliced: boolean; translatable: boolean },
	viewLang: string,
): Promise<LaneValue | null> {
	const { readLaneValueAt } = await import('../tm_record/lane_state.ts');
	const other = state.rowLane === 'lg-nolan' ? viewLang : 'lg-nolan';
	if (other === '' || other === state.rowLane) return null;
	const asOf = await readLaneValueAt(coords, other, rowId, law);
	return asOf.recorded ? asOf : null;
}

/**
 * The record with a TM preview grafted over it — a CLONE, never the shared
 * record. The main's key is its live value with the graft's lanes put back
 * (every other lane stays live); each recorded slot holds the frames of OTHER
 * mains as they are live (a shared slot stores every main's frames; this
 * history speaks only for its own) followed by the frame state's frames of the
 * main.
 */
async function applyTmGraft(
	record: MatrixRecord,
	tipo: string,
	model: string,
	graft: TmPreviewGraft,
): Promise<MatrixRecord> {
	const { cloneRecord, injectComponentData } = await import('../section_record/index.ts');
	const { previewLaneValue } = await import('../tm_record/lane_state.ts');
	const { liveFramesOfOtherMains } = await import('../tm_record/frame_as_of.ts');
	const grafted = cloneRecord(record);
	if (graft.value !== null) {
		const { state, asOf } = graft.value;
		const value = previewLaneValue(liveKeyOf(grafted, tipo, model), state, asOf, graft.law);
		injectComponentData(grafted, tipo, model, value ?? emptyKeyOf(graft.law));
	}
	for (const [slot, frames] of graft.slots ?? []) {
		const others = liveFramesOfOtherMains(grafted, slot, graft.mainTipo);
		injectComponentData(grafted, slot, 'component_dataframe', [...others, ...frames]);
	}
	return grafted;
}

/** The value an emptied key previews with: `[]` for a sliced model, `null` otherwise. */
function emptyKeyOf(law: { sliced: boolean }): unknown {
	return law.sliced ? [] : null;
}

/** A record's raw stored value of one component key (`undefined` = absent). */
function liveKeyOf(record: MatrixRecord, tipo: string, model: string): unknown {
	const column = getColumnNameByModel(model);
	const bag = column === null ? null : record.columns[column as keyof typeof record.columns];
	return (bag as Record<string, unknown> | null | undefined)?.[tipo];
}

/**
 * The no-record SEARCH shell's item fixups (a no-op for every other read): the
 * client resolves its filter row by
 * `String(el.section_id)===String(self.section_id)`, so the SYNTHETIC id is
 * echoed VERBATIM (the relation branch's search item does the same), and
 * row_section_id — a subdatum-ROW stamp — has no meaning without a record.
 */
function stampSearchShellItems(items: DataItem[], sectionId: unknown, searchShell: boolean): void {
	if (!searchShell) return;
	for (const entry of items) {
		entry.section_id = sectionId as number | string;
		// biome-ignore lint/performance/noDelete: no record ⇒ the key must be ABSENT
		delete (entry as { row_section_id?: unknown }).row_section_id;
	}
}

export async function readComponentData(rqo: Rqo): Promise<DataItem[]> {
	const refusal: TmPreviewRefusal = { reason: null };
	const items = await readComponentDataUnflagged(rqo, refusal);
	return flagRefusedPreview(items, String(rqo.source?.tipo ?? ''), refusal.reason);
}

/** readComponentData's body; a refused TM preview row is recorded in `refusal`. */
async function readComponentDataUnflagged(
	rqo: Rqo,
	refusal: TmPreviewRefusal,
): Promise<DataItem[]> {
	const source = rqo.source ?? {};
	const tipo = source.tipo;
	const sectionTipo = source.section_tipo;
	const sectionId = source.section_id;
	if (
		tipo === undefined ||
		sectionTipo === undefined ||
		sectionId === undefined ||
		sectionId === null
	) {
		throw new DedaloError('request.invalid_source', {
			message: 'readComponentData: source.tipo/section_tipo/section_id are required',
		});
	}
	const model = await getModelByTipo(tipo);
	if (model === null) {
		throw new DedaloError('request.invalid_tipo', {
			message: `readComponentData: unknown component tipo '${tipo}'`,
			coordinates: { tipo },
		});
	}
	// Request-scoped data lang, never a hardcoded install default (S2-28): an
	// RQO that omits lang resolves the session's active data language.
	const lang = source.lang ?? currentDataLang();

	// TEMPORAL SCRATCH (WC-079). service_tmp_section's staging form persists its
	// values server-side, per user; load them ONCE here and GRAFT below, so all
	// three record-less branches share one lookup and one policy.
	//
	// The graft is the point: it feeds the value into the SAME virtual-record slot
	// the Time Machine override and component_relation_children use, so the
	// STANDARD pipeline resolves it — relation locators come back as real labelled
	// chips with a real pagination, in the caller's language and under the caller's
	// grants, instead of the bare locators that were stored.
	//
	// Identity comes from the request-scoped ALS rather than a threaded parameter:
	// readComponentData is reached from several doors and this is a leaf-position
	// read, which is the backstop role request_context.ts documents. FAIL-CLOSED —
	// no principal (unit tests, timer/scheduler work — a job-manager job carries
	// its submitter's principal snapshot) means no graft and today's
	// behaviour, never another user's row.
	let scratchEntries: unknown[] | null = null;
	{
		const { temporalScratchAddress, readTemporalScratch } = await import(
			'./record/temporal_store.ts'
		);
		const scratchAddress = temporalScratchAddress(source);
		if (scratchAddress !== null) {
			const { currentPrincipal } = await import('../security/request_context.ts');
			const scratchPrincipal = currentPrincipal();
			if (scratchPrincipal !== undefined) {
				scratchEntries = await readTemporalScratch(scratchPrincipal.userId, scratchAddress);
				// AUTHZ-02 (the hole this store shipped with, fixed 2026-07-30). The
				// stored locators are CLIENT-SUPPLIED: the save door persists `picked`
				// before resolveRelationEcho applies its own scope filter, admits at a
				// READ grant, and read_facade exempts temporal sources from the
				// per-record gate. Grafting them unscoped let a level-1 user inject any
				// locator and have the standard expansion hand back another tenant's
				// field values. Scope them with the SAME filter the search-chip door
				// uses — at read time, because a projects assignment can change after
				// the row was written.
				if (scratchEntries !== null && getColumnNameByModel(model) === 'relation') {
					const { filterLocatorsInScope } = await import('../security/record_scope.ts');
					scratchEntries = await filterLocatorsInScope(
						scratchEntries as Record<string, unknown>[],
						scratchPrincipal,
						dedaloConfig.usersSectionTipo,
					);
				}
			}
		}
	}
	/** Graft the scratch value into a record's slot for the standard pipeline. */
	const graftScratch = async (target: MatrixRecord): Promise<void> => {
		if (scratchEntries === null || scratchEntries.length === 0) return;
		// Under the DATA tipo, not the ddo tipo: expandPortal and the select-family
		// resolver both look the slot up by resolveDataTipo, so an aliased component
		// (WC-020) would otherwise graft into a slot nothing reads.
		const { resolveDataTipo } = await import('../ontology/alias.ts');
		const { injectComponentData } = await import('../section_record/index.ts');
		injectComponentData(target, await resolveDataTipo(tipo), model, scratchEntries);
	};

	// Classify the wire id ONCE (WC-2026-08-10-section-id-int-canonical) —
	// replaces the Number()/NaN sniff. A SYNTHETIC search-filter id
	// ('search_<n>', search.js get_section_id) addresses NO matrix record, and
	// an EXTERNAL remote id ('001338683', 'Q42') is not a matrix address at all
	// (the old sniff coerced a digits-only remote id into a bogus record read):
	// both resolve to a null record WITHOUT touching the DB, so the branches
	// below build a record-independent widget (PHP get_data serves the
	// datalist/empty item). This also spares VIRTUAL sections whose matrix
	// "table" is not a readable record store: dd15 Time Machine →
	// matrix_time_machine, which readMatrixRecord rejects via the identifier
	// allowlist. Without this guard, dragging any dd15 field into the search
	// panel threw and every filter rendered "Invalid component". A real record
	// id (incl. 0 and root -1) still reads normally.
	// DELIBERATE DIVERGENCE (WC-2026-08-10-section-id-int-canonical): '' now
	// classifies as `absent` and takes the no-record branch — the NaN era's
	// Number('') === 0 slipped an empty id past this gate and read record 0.
	// A TEMPORAL instance (source.is_temporal — a tool's throwaway editable
	// clone, WC-059) is the second no-record case: its section_id is a client
	// sentinel (1), so reading it would serve a STRANGER'S record as the clone's
	// starting value. Same resolution as the synthetic search id — context and
	// datalist, empty value.
	// A classifier refusal ('007', out-of-range digits, non-scalar) on a READ is
	// served as the no-record widget, never a 500: the value addresses nothing,
	// and the read pipeline's honest answer to "no address" already exists.
	// (The WRITE doors 400 instead — a refusal there must be visible.)
	const wireSectionId = await classifyWireSectionId(
		sectionId,
		sectionTipo,
		'rqo.section.read',
	).catch((error: unknown) => {
		if (isErrorInDomain(error, 'section_id')) {
			console.warn(`[section/read] unusable section_id served as no-record: ${error.message}`);
			return { kind: 'absent' } as const;
		}
		throw error;
	});
	const hasRecordId = wireSectionId.kind === 'record' && !isTemporalSource(source);
	// Only meaningful under hasRecordId — the no-record branches never read it.
	const numericSectionId = recordIdOrNaN(wireSectionId);

	// Time Machine preview override (PHP component_common::get_data data_source
	// ='tm' branch, dd_core_api :2372-2383): the tool_time_machine preview pane
	// loads this component's value from a SPECIFIC matrix_time_machine row
	// (matrix_id), not the live record. Resolve that snapshot once here and graft
	// it over whatever record the branches below read — the section context /
	// datalist stay live (real section_tipo/section_id), only the value changes.
	// Without this, every preview shows the live value regardless of the row the
	// user picked (the "always the last value" bug).
	const preview = await resolveTmPreview(
		source,
		model,
		tipo,
		sectionTipo,
		numericSectionId,
		refusal,
	);
	// PHP get_data returns null (empty) when the snapshot is absent — or, since
	// P0-14, when it belongs to a dead generation at the same address.
	if (preview.served === false) return [];
	const tmOverride: TmPreviewGraft | null = preview.graft;

	// NON-relation components: PHP dd_core_api serves get_data for ANY
	// component (the autocomplete_hi edit-in-place widget refreshes the chosen
	// term's `component_input_text` value this way) — resolve the single ddo
	// through the generic emission path against the target record.
	if (getColumnNameByModel(model) !== 'relation') {
		const literalTable = (await getMatrixTableFromTipo(sectionTipo)) ?? 'matrix';
		let literalRecord = hasRecordId
			? await memoizedReadMatrixRecord(literalTable, sectionTipo, numericSectionId)
			: null;
		/** The no-record SEARCH shell — drives the id fixups after the emission. */
		let literalSearchShell = false;
		let literalRowId = Number(sectionId);
		if (literalRecord === null) {
			const shell = await materializeLiteralShell(source, sectionTipo, sectionId, tmOverride);
			if (shell === null) return []; // PHP empty shell
			literalRecord = shell.record;
			literalRowId = shell.rowId;
			literalSearchShell = shell.searchShell;
			// WC-079: the staged value, if the operator has one. Freshly built there,
			// so no cloneRecord is needed. A TM preview still wins below — a history
			// playback must never be overwritten by a scratch form.
			await graftScratch(literalRecord);
		}
		if (tmOverride !== null) {
			literalRecord = await applyTmGraft(literalRecord, tipo, model, tmOverride);
		}
		const literalRoot = await tmPreviewEmission(preview, literalRecord);
		const literalEmission = literalRoot.emission;
		const literalData = literalEmission.items;
		const literalMode = source.mode ?? 'edit';
		await emitDdoData(
			{ tipo, section_tipo: sectionTipo, mode: literalMode, lang } as Ddo,
			[],
			literalRoot.root,
			{ section_tipo: sectionTipo, section_id: literalRowId },
			literalMode,
			lang,
			tipo,
			literalEmission,
		);

		stampSearchShellItems(literalData as DataItem[], sectionId, literalSearchShell);

		// component_security_access DIRECT get_data: the datalist / changes_files /
		// parent locator are attached in the shared emitDdoData literal branch
		// above. get_data-specific tweaks vs the section read (PHP get_data_item):
		// the response SUBJECT is not a subdatum row, so it drops row_section_id,
		// and its section_id / parent_section_id echo the source id in CANONICAL
		// form (WC-2026-08-10-section-id-int-canonical — repeals the raw-String()
		// echo: a record address is an INT; anything else survives verbatim).
		if (model === 'component_security_access') {
			const item = literalData.find(
				(entry): entry is DataItem => (entry as DataItem).tipo === tipo,
			);
			if (item !== undefined) {
				// biome-ignore lint/performance/noDelete: PHP parity — row_section_id must be ABSENT here
				delete (item as { row_section_id?: unknown }).row_section_id;
				const canonicalId = canonicalizeStoredSectionId(sectionId) as number | string;
				item.section_id = canonicalId;
				item.parent_section_id = canonicalId;
			}
		}
		return literalData as DataItem[];
	}
	// Client-managed paging: the paginator rqo carries sqo.limit/offset — a
	// CLIENT page, bounded HERE by the ONE page primitive (clampClientPage,
	// READ-4), never by trusting that the wire schema bounded it first: save's
	// echo hands this door a limit read from `data.pagination`, which no sqo
	// schema ever parsed. 0/'all'/out-of-range → the client ceiling (show-all
	// becomes the ceiling in the response pagination); a negative / non-numeric
	// offset → 0, one past any page (1e21) → an empty page, never a raw sink
	// refusal.
	// A NULL (or absent) limit is NOT show-all: the real client sends
	// sqo.limit:null on every tool-component read meaning "server decides"
	// (common.js "force to generate default limit from server") — PHP answers
	// with the component's config limit (wire-pinned 2026-07-10: the epigraphy
	// coins read with limit:null pages at the override's 1, not 1000). So the
	// DOOR DEFAULT is maxRowsPerPage (clamped too); treating null as 0 clamped
	// every tool portal to the full list — the 34-coins bug.
	// Gate: client_page_doors_native (every member bounds its OWN page).
	const { clampClientPage } = await import('../concepts/sqo.ts');
	const rawLimit = rqo.sqo?.limit;
	const { limit, offset: sqoOffset } = clampClientPage(
		rawLimit,
		rqo.sqo?.offset,
		sectionTipo,
		dedaloConfig.features.maxRowsPerPage,
	);

	// relation_index: COMPUTED inverse page (offset-aware) + pool-accumulated
	// related_list children — its own flow, no stored locators to expand.
	if (model === 'component_relation_index') {
		const { readRelationIndexData } = await import('../relations/models/relation_index.ts');
		// related_list children resolve in the CURRENT data lang (PHP
		// DEDALO_DATA_LANG, seeded from the session), independent of the rqo lang
		// (a lg-nolan get_data still renders translatable pointing-section values
		// in the active data language).
		const { currentDataLang } = await import('../resolve/request_lang.ts');
		return readRelationIndexData(
			tipo,
			sectionTipo,
			String(sectionId),
			limit,
			sqoOffset,
			currentDataLang(),
			emitDdoData,
			source.mode ?? 'edit',
		);
	}

	// SELECT / FILTER family flag — reused by BOTH the null-record search path
	// (synthetic filter-row ids) and the datalist dispatch below: these models
	// resolve to option lists (get_list_of_values), never paginated portals.
	const { SELECT_FAMILY_MODELS } = await import('../relations/models/select_family.ts');
	const isSelectOrFilterFamily =
		SELECT_FAMILY_MODELS.has(model) ||
		model === 'component_filter' ||
		model === 'component_filter_master';

	const table = (await getMatrixTableFromTipo(sectionTipo)) ?? 'matrix';
	let record = hasRecordId
		? await memoizedReadMatrixRecord(table, sectionTipo, numericSectionId)
		: null;
	// The record as it lives NOW, before any virtual stand-in (applyTmPreview).
	const liveRecord = record;
	if (record === null && previewPlaysBack(preview)) {
		// TM preview of a component whose live record is gone: play back the
		// snapshot against an empty virtual record (PHP get_data still renders it).
		const { makeVirtualRecord } = await import('../section_record/virtual_record.ts');
		record = makeVirtualRecord(sectionTipo, Number(sectionId));
	}
	if (record === null) {
		// CHILDREN always answer with their (empty) own item — PHP instantiates
		// the component regardless of record resolution (the dz1 §503 pin:
		// data-driven tipos resolve no table/record through this generic path).
		if (model === 'component_relation_children') {
			const emptyItem = buildDataItem(
				tipo,
				sectionTipo,
				sectionId,
				source.mode ?? 'edit',
				'lg-nolan',
				[],
			);
			emptyItem.pagination = { total: 0, limit, offset: sqoOffset };
			emptyItem.parent_tipo = tipo;
			emptyItem.parent_section_id = Number(sectionId);
			return [emptyItem];
		}
		// SELECT / FILTER family in SEARCH mode against a SYNTHETIC filter-row id:
		// the search panel builds each filter component with a client-minted
		// section_id ('search_<n>', search.js get_section_id) that resolves NO
		// matrix record. PHP still emits the option datalist here (get_list_of_values
		// lists the target section's records — yes/no, projects… — independent of
		// any stored value), so component_publication renders its radio buttons and
		// component_select its options. Materialize an EMPTY virtual record and fall
		// through to the SELECT/FILTER datalist dispatch below (entries:[]) — instead
		// of the bare, datalist-less item the generic search branch returns, which
		// left the filter blank (render_search_component_publication iterates
		// data.datalist).
		// A TEMPORAL instance (WC-059) reaches here for the SAME reason — it
		// addresses no record — but in mode 'edit', so it needs its own clause or
		// the `return []` below blanks it. `service_tmp_section`'s staging form is
		// built almost entirely from this family (component_select / _filter /
		// _radio_button, all mode 'edit'): an empty answer leaves `self.data = {}`
		// and the widget renders ZERO options, which nothing can then repair —
		// nothing can be picked, so no save echo ever arrives.
		if (
			((source.mode ?? 'edit') === 'search' || isTemporalSource(source)) &&
			isSelectOrFilterFamily
		) {
			const { makeVirtualRecord } = await import('../section_record/virtual_record.ts');
			record = makeVirtualRecord(sectionTipo, 0);
			// WC-079: the staged pick. The select-family resolver emits its item
			// regardless of the slot, so there is no empty-set trap here — the
			// datalist still renders when nothing is staged.
			await graftScratch(record);
		} else {
			// SEARCH mode builds a blank search form independent of any stored record —
			// PHP get_data returns the component's own item with empty entries so the
			// search widget renders even when the source points at a record that does
			// not exist (e.g. component_external's zenon fixture on a DB without that
			// record). The client's search renders read self.data.entries directly and
			// the external one is unguarded (render_search_component_external :178
			// data.entries[0]), so a null record must still answer an item with
			// entries:[] rather than nothing. section_id is echoed VERBATIM (leading
			// zeros kept) so String(el.section_id)===String(self.section_id) matches.
			if ((source.mode ?? 'edit') === 'search') {
				return [buildDataItem(tipo, sectionTipo, sectionId, 'search', lang, [])];
			}
			// TEMPORAL (WC-059): same contract, the clone's own mode. The client
			// resolves its item by the stringified section_id, so the SENTINEL is
			// echoed verbatim — an item with entries:[] is what makes the widget
			// render empty rather than not render at all.
			if (isTemporalSource(source)) {
				// WC-079: with a staged value, graft it and FALL THROUGH to the
				// standard expansion, which resolves the locators into labelled chips
				// with a real pagination (expandPortal).
				//
				// (!) THE EMPTY-SET TRAP. expandPortal returns early on an empty
				// locator set and emits NO item at all (relation_core.ts, the PHP
				// portal_json guard). Falling through with nothing staged would leave
				// the client's `self.data = data || {}` without an entries array —
				// a worse regression than the bug this store fixes. So an empty
				// scratch keeps the bare item and only a NON-empty one falls through.
				if (scratchEntries === null || scratchEntries.length === 0) {
					return [buildDataItem(tipo, sectionTipo, sectionId, source.mode ?? 'edit', lang, [])];
				}
				const { makeVirtualRecord } = await import('../section_record/virtual_record.ts');
				record = makeVirtualRecord(sectionTipo, Number(sectionId));
				await graftScratch(record);
			} else {
				return [];
			}
		}
	}

	// TM preview: graft the snapshot over the (live or virtual) record so the
	// SELECT-family and portal paths below page/resolve it exactly like a stored
	// value. This REPLACES the live value and short-circuits the relation_children
	// computation (the snapshot already holds what changed).
	if (previewPlaysBack(preview)) {
		record = await applyTmPreview(record, liveRecord, tipo, model, preview);
	} else if (model === 'component_relation_children') {
		// relation_children: COMPUTED locators (inverse dd47 — the component owns
		// no rows). Grafted into a CLONE of the record (never the shared original)
		// via the substitution API, so the shared portal expansion pages and
		// resolves child ddos exactly like a stored relation (PHP get_data :113
		// computes, then the json controller runs the standard pipeline).
		const { getChildren } = await import('../relations/children.ts');
		const { cloneRecord, injectComponentData } = await import('../section_record/index.ts');
		const computed = await getChildren(sectionId, sectionTipo, tipo);
		record = cloneRecord(record);
		injectComponentData(record, tipo, model, computed);
	}

	// SELECT / FILTER family get_data: the PHP json controllers of these models
	// (component_publication_json / component_select_lang_json / component_filter_json,
	// etc.) switch on mode — list/tm → label strings (get_list_value), edit →
	// stored locators + the option datalist (get_list_of_values) — and NEVER run
	// the portal pagination/child-expansion path. Dispatch through the SAME
	// registry resolver the section-read uses (emitDdoData → getRelationResolver),
	// honoring source.mode, so the direct get_data endpoint and the section read
	// produce identical output. Portal/dataframe/parent/external keep the
	// pagination path below.
	if (isSelectOrFilterFamily) {
		const mode = source.mode ?? 'edit';
		const familyRoot = await tmPreviewEmission(preview, record);
		const familyEmission = familyRoot.emission;
		const familyData = familyEmission.items;
		// Echo a non-record id VERBATIM — the search filter's 'search_<n>' token
		// and an external remote id both match the client instance by String()
		// equality; a RECORD address emits as canonical INT
		// (WC-2026-08-10-section-id-int-canonical — the old blanket Number()
		// corrupted digits-only external ids, '001338683' → 1338683).
		const emitSectionId = wireSectionId.kind === 'record' ? wireSectionId.id : sectionId;
		await emitDdoData(
			{ tipo, section_tipo: sectionTipo, mode, lang } as Ddo,
			[],
			familyRoot.root,
			{ section_tipo: sectionTipo, section_id: emitSectionId as number },
			mode,
			lang,
			tipo,
			familyEmission,
		);
		// The direct get_data item is the response SUBJECT, not a subdatum row —
		// PHP get_data_item carries no row_section_id (that stamp belongs to
		// get_subdatum rows only, as the portal get_data path also strips below).
		for (const item of familyData) {
			if ((item as DataItem).tipo === tipo)
				// biome-ignore lint/performance/noDelete: PHP parity — row_section_id must be ABSENT here
				delete (item as { row_section_id?: unknown }).row_section_id;
		}
		return familyData as DataItem[];
	}

	// DATAFRAME get_data — the PAIRED read (PHP component_dataframe::get_data
	// :103-129 filters the slot by the caller predicate; component_dataframe_json
	// :196-206 stamps id_key + main_component_tipo on the item).
	//
	// This branch is the read half of the pairing contract, and it was MISSING:
	// the generic portal expansion below reads the whole slot, so a frame widget
	// refresh — and, worse, the SAVE ECHO, which is the same call — served every
	// frame belonging to every main item, with no id_key on the item. The client
	// assigns that response straight onto `self.data` (component_common.js :409
	// on build, :776 on save success) and sources its next write's `id_key` from
	// it (common.js create_source :1192), so the missing stamp did not just show
	// the wrong rows: it destroyed the pairing key of the following write.
	//
	// HOW: by GRAFTING the caller's frame subset over the record and letting the
	// STANDARD portal expansion below run on it — the same substitution trick
	// component_relation_children uses a few lines up. A bespoke emitter here
	// (the first attempt) silently dropped everything that path provides: the
	// sqo limit/offset paging, the source.properties override, the ddinfo
	// breadcrumb, and the mode handling — it re-derived the render mode from
	// source.mode where the portal path pins 'edit', which routes the client
	// into a different view. Grafting keeps ONE expansion for every door and
	// confines this branch to the one thing it owns: the pairing.
	//
	// Only a COMPLETE pairing takes this path (callerDataframePairing is the
	// single gate). Search mode is excluded outright: the client sends
	// caller_dataframe on every dataframe request, including search, where the
	// widget wants the blank search shape and not a paired frame.
	let dataframeStamp: { main_component_tipo: string; id_key: number | string } | null = null;
	if (model === 'component_dataframe' && (source.mode ?? 'edit') !== 'search') {
		const pairing = callerDataframePairing(source);
		if (pairing !== null) {
			const { filterCallerEntries } = await import('../relations/dataframe.ts');
			const { resolveDataTipo } = await import('../ontology/alias.ts');
			const { cloneRecord, injectComponentData } = await import('../section_record/index.ts');
			const frameDataTipo = await resolveDataTipo(tipo);
			const slotBag =
				((record.columns.relation as Record<string, unknown[]> | null)?.[frameDataTipo] as
					| Record<string, unknown>[]
					| undefined) ?? [];
			const paired = filterCallerEntries(
				slotBag,
				{ main_component_tipo: pairing.main_component_tipo, id_key: pairing.id_key },
				tipo,
			);
			// A CLONE — never the shared record: the graft must not leak this
			// caller's narrowed slot into another request's view of the row.
			record = cloneRecord(record);
			injectComponentData(record, tipo, model, paired);
			dataframeStamp = pairing;
			if (paired.length === 0) {
				// THE EMPTY-SET TRAP. expandPortal emits NO item for an empty
				// relation, and the client's `self.data = data || {}` would then
				// leave the widget with no entries array at all — worse than the
				// wrong rows this branch is fixing. A main item with no frames yet
				// is the NORMAL state of a fresh dataframe, so answer the empty
				// item explicitly, carrying the pairing the client echoes back.
				const emptyItem = buildDataItem(
					tipo,
					sectionTipo,
					sectionId,
					source.mode ?? 'edit',
					'lg-nolan',
					[],
				);
				emptyItem.pagination = { total: 0, limit, offset: sqoOffset };
				emptyItem.parent_tipo = tipo;
				emptyItem.id_key = Number(pairing.id_key);
				emptyItem.main_component_tipo = pairing.main_component_tipo;
				return [emptyItem];
			}
		}
	}

	// The component's OWN request_config (edit mode → the full child tree).
	// An rqo source.properties OVERRIDE replaces the ontology properties (PHP
	// dd_core_api read :2305-2308, $element->set_properties): TOOL component
	// instances read with their ddo_map-declared properties (client
	// create_source), so the child map, the external sqo and the page size all
	// derive from the override — the epigraphy coins portal pages by the
	// override's sqo_config.limit 1, not the ontology's 9 (wire-pinned
	// 2026-07-10, section_tool_component_read_differential).
	// component_alias (WC-020): the EFFECTIVE properties accessor returns the
	// alias-merged config for alias tipos and the plain node properties
	// otherwise — the rqo override still wins on top (precedence chain:
	// override → alias merge → target).
	const { getEffectivePropertiesByTipo } = await import('../ontology/alias.ts');
	const { buildRequestConfigForElement } = await import('../relations/request_config/build.ts');
	const propertiesOverride = source.properties ?? undefined;
	const config = await buildRequestConfigForElement(
		propertiesOverride ?? (await getEffectivePropertiesByTipo(tipo)) ?? null,
		{
			ownerTipo: tipo,
			ownerSectionTipo: sectionTipo,
			mode: 'edit',
			ownerIsSection: false,
			ownerSectionId: sectionId,
			lang,
		},
	);

	// PHP page-size precedence (calculate_default_limit + the element's
	// pagination sync, wire-pinned 2026-07-10): the client's sqo.limit wins;
	// else the component's EFFECTIVE config limit (sqo.limit ??
	// show.sqo_config.limit, LAST config item wins — same chain as
	// relation_core's ownEditLimit); else the clamped mode default above.
	let effectiveLimit = limit;
	if (rawLimit == null) {
		let configured: number | undefined;
		for (const item of config) {
			const candidate =
				(item.sqo as { limit?: unknown } | undefined)?.limit ??
				((item.show?.sqo_config as { limit?: unknown } | undefined)?.limit as unknown);
			if (typeof candidate === 'number' && candidate > 0) configured = candidate;
		}
		if (configured !== undefined) effectiveLimit = configured;
	}
	// EVERY config item's children, not just the first one's (PHP full_ddo_map,
	// class.common.php:2312) — the get_data twin of the section-read rule in
	// relations/models/portal.ts. Without it, paging a two-source component
	// (rsc368: dedalo + zenon) drops the second source's columns.
	const { flattenConfigDdoMaps } = await import('../relations/config_ddo_map.ts');
	const childDdos: Ddo[] = flattenConfigDdoMaps(config, { ownerTipo: tipo }).map(
		(ddo) =>
			({
				tipo: ddo.tipo,
				// Keep the DECLARED section list INTACT (same rule as the section-read
				// twin, relations/models/portal.ts): a multi-target component's child
				// spans EVERY target section and the per-locator grouping picks the
				// matching one. Flattening to [0] skipped every non-first target —
				// rsc92's hierarchy25 spans [es1,fr1,…], so a picked fr1 term emitted
				// NO subdatum in the save echo and the chip stayed blank until reload
				// (found live 2026-07-09).
				section_tipo: ddo.section_tipo,
				parent: ddo.parent,
				mode: ddo.mode,
				lang: (ddo as { lang?: string }).lang,
			}) as Ddo,
	);

	// Portal ddo: paginate the locators by the rqo sqo (get_data pages fully).
	// tmAsOf: a TM preview's frame children read as of the row
	// (WC-2026-09-29-tm-preview-frame-children-as-of), rooted at this record.
	const portalRoot = await tmPreviewEmission(preview, record);
	const emission = portalRoot.emission;
	const data = emission.items;
	const portalDdo: Ddo = {
		tipo,
		section_tipo: sectionTipo,
		parent: 'self',
		mode: 'edit',
		limit: effectiveLimit,
	} as Ddo;
	await expandPortal(
		portalRoot.root,
		portalDdo,
		model,
		childDdos,
		'edit',
		lang,
		{ section_tipo: sectionTipo, section_id: Number(sectionId) },
		tipo, // caller is the component itself
		emission,
		emitDdoData,
		// get_data subdatum rows anchor on the LOCATOR TARGET (PHP get_subdatum
		// row_section_id = $current_locator->section_id) — unlike the section
		// read, where the outer record re-stamp applies. ownConfig: the children
		// above came from the component's OWN config, which also enables the
		// autocomplete_hi ddinfo breadcrumb in its BARE get_data shape (the save
		// echo depends on it — the picked chip renders its thesaurus chain
		// without a reload; byte-diffed vs the oracle, 2026-07-09).
		{
			offset: sqoOffset,
			childRowFromTarget: true,
			ownConfig: true,
			ddinfoBare: true,
			...portalAsOfOption(model, preview),
		},
	);
	// The portal's OWN item in a direct get_data carries NO row_section_id —
	// that stamp belongs to SUBDATUM rows (PHP get_subdatum :2792); the item
	// here is the top-level response subject, not a row of a parent.
	const portalItem = data[0] as DataItem | undefined;
	if (portalItem !== undefined && portalItem.tipo === tipo) {
		// biome-ignore lint/performance/noDelete: PHP parity — row_section_id must be ABSENT here
		delete portalItem.row_section_id;
		// DATAFRAME pairing stamp (PHP component_dataframe_json :196-206), the
		// same two fields emitDataframeItem puts on the section-read frame item.
		// Load-bearing, not cosmetic: the client assigns this response onto
		// self.data and sources the NEXT write's id_key from it (common.js
		// create_source), so an unstamped echo destroys the following write's
		// pairing.
		if (dataframeStamp !== null) {
			portalItem.id_key = Number(dataframeStamp.id_key);
			portalItem.main_component_tipo = dataframeStamp.main_component_tipo;
		}
	}
	// CHILDREN particularities (PHP component_relation_children get_data):
	// computed locators carry NO paginated_key, the own item echoes the
	// source's RAW (string) section_id, and the item emits even when the
	// computed set is EMPTY (entries [], total 0 — the dz1 §503 pin).
	if (model === 'component_relation_children') {
		if (portalItem !== undefined && portalItem.tipo === tipo) {
			portalItem.section_id = sectionId;
			portalItem.entries = (portalItem.entries ?? []).map((entry) => {
				const clean = { ...(entry as Record<string, unknown>) };
				// biome-ignore lint/performance/noDelete: PHP children locators never carry the key
				delete clean.paginated_key;
				return clean;
			});
		} else {
			const emptyItem = buildDataItem(tipo, sectionTipo, sectionId, 'edit', 'lg-nolan', []);
			emptyItem.pagination = { total: 0, limit: effectiveLimit, offset: sqoOffset };
			emptyItem.parent_tipo = tipo;
			emptyItem.parent_section_id = Number(sectionId);
			data.unshift(emptyItem);
		}
	}
	return data as DataItem[];
}

/**
 * resolve_data (PHP dd_core_api read case 'resolve_data'): a component in
 * SEARCH mode resolves INJECTED locators (rqo.source.value) instead of a
 * stored record value — the portal filter chips. The main item carries the
 * injected entries (id-stamped, mode 'search', null record identity) and the
 * children resolve each locator's TARGET record through the component's own
 * child ddos, stamped with the target's raw section_id.
 */
export async function resolveSearchData(rqo: Rqo, principal?: Principal): Promise<DataItem[]> {
	const source = rqo.source ?? {};
	const tipo = source.tipo;
	const sectionTipo = source.section_tipo;
	if (tipo === undefined || sectionTipo === undefined) {
		throw new DedaloError('request.invalid_source', {
			message: 'resolveSearchData: source.tipo/section_tipo are required',
		});
	}
	const model = await getModelByTipo(tipo);
	if (model === null || getColumnNameByModel(model) !== 'relation') {
		throw new DedaloError('request.invalid_model', {
			message: `resolveSearchData: only relation components supported, got '${model}'`,
			coordinates: { tipo, model: String(model) },
		});
	}
	// Request-scoped data lang, never a hardcoded install default (S2-28): an
	// RQO that omits lang resolves the session's active data language.
	const lang = source.lang ?? currentDataLang();
	const limit =
		typeof rqo.sqo?.limit === 'number' ? rqo.sqo.limit : dedaloConfig.features.maxRowsPerPage;
	let injected = Array.isArray((source as { value?: unknown }).value)
		? ((source as { value?: unknown }).value as Record<string, unknown>[])
		: [];
	// §7.4 per-record projects (tenant) ACL on the client-injected target locators
	// (foundation audit AUTHZ-02): a non-admin must not resolve the child values of
	// a record outside their projects filter by injecting its locator as a search
	// chip. Drop out-of-scope targets; locators with no (section_tipo, section_id)
	// identity carry nothing to scope and pass through. Global admins are unscoped.
	// Shared with the WC-079 temporal scratch graft (security/record_scope.ts
	// filterLocatorsInScope) — the two client-locator doors must not drift, and
	// they did: the scratch store shipped without this filter and was a live
	// cross-tenant read until 2026-07-30.
	if (injected.length > 0) {
		const { filterLocatorsInScope } = await import('../security/record_scope.ts');
		injected = await filterLocatorsInScope(injected, principal, dedaloConfig.usersSectionTipo);
	}

	// Canonical echo (WC-2026-08-10-section-id-int-canonical) — REPEALS the PHP
	// string law this block used to enforce (class.locator.php set_section_id
	// :338, "locators carry section_id AS STRING"). The client still feeds these
	// entries back verbatim as the search q (component_portal get_search_value),
	// but the byte-exact string echo is no longer what makes the search match:
	// the relation containment probes are DUAL-FORM per element
	// (search/containment.ts relationProbeGroups), so a canonical-int chip finds
	// string-stored legacy rows and int-stored canonical rows alike. Emit
	// canonical: int for a record address; an external remote id ('001338683',
	// 'Q42') survives verbatim — never Number() blindly.
	injected = injected.map((locator) =>
		locator !== null &&
		typeof locator === 'object' &&
		locator.section_id !== undefined &&
		locator.section_id !== null
			? { ...locator, section_id: canonicalizeStoredSectionId(locator.section_id) }
			: locator,
	);

	// The component's child ddos — the RAW config entries so section_tipo
	// stays AS DECLARED ('self' = match-all in the per-locator grouping).
	// component_alias (WC-020): the effective accessor merges an alias's config.
	const { getTranslatableByTipo, getModelByTipo: modelOf } = await import(
		'../ontology/resolver.ts'
	);
	const { getEffectivePropertiesByTipo: effectivePropsOf } = await import('../ontology/alias.ts');
	// The child ddos (the target's DISPLAY components — e.g. dd132 Username for the
	// dd543 Who portal) come from the RELATIONS-driven request_config builder, the
	// same one buildGetDataContext uses for the edit-mode child tree. Reading the
	// component's OWN `source.request_config` misses them for a section component
	// whose target display is section/relation-defined (dd543 carries only
	// `show_interface`), so the picked chip resolved NO subdatum and rendered blank
	// (reported 2026-07-17: Activity "Who" search chip had no username).
	const { buildRequestConfigForElement } = await import('../relations/request_config/build.ts');
	const searchConfig = await buildRequestConfigForElement((await effectivePropsOf(tipo)) ?? null, {
		ownerTipo: tipo,
		ownerSectionTipo: sectionTipo,
		mode: 'search',
		ownerIsSection: false,
		lang,
	});
	const allDdos = searchConfig.flatMap((rc) => rc?.show?.ddo_map ?? []) as {
		tipo: string;
		parent?: string;
		section_tipo?: string | string[];
		mode?: string;
		lang?: string;
	}[];
	// Dataframe ddos are NOT per-target children — they pair with the MAIN
	// item's entries (id_key) and are emitted separately below.
	const dataframeDdos: typeof allDdos = [];
	const childDdos: Ddo[] = [];
	for (const ddo of allDdos) {
		if (typeof ddo?.tipo !== 'string') continue;
		if ((await modelOf(ddo.tipo)) === 'component_dataframe') {
			dataframeDdos.push(ddo);
			continue;
		}
		// PHP instantiates each child with its INSTANCE lang: the request lang
		// for translatable components, lg-nolan otherwise.
		const childLang = (await getTranslatableByTipo(ddo.tipo)) ? lang : 'lg-nolan';
		childDdos.push({
			tipo: ddo.tipo,
			section_tipo: ddo.section_tipo,
			parent: ddo.parent === 'self' || ddo.parent === undefined ? tipo : ddo.parent,
			mode: ddo.mode,
			lang: ddo.lang ?? childLang,
		} as Ddo);
	}

	// Synthetic record carrying ONLY the injected locators (via the substitution
	// API — the model routes to its column and the byte twin is voided).
	const { makeVirtualRecord, injectComponentData } = await import('../section_record/index.ts');
	const syntheticRecord = makeVirtualRecord(sectionTipo, 0);
	injectComponentData(syntheticRecord, tipo, model, injected);

	const searchEmission = new EmissionContext();
	const data = searchEmission.items;
	await expandPortal(
		syntheticRecord,
		{ tipo, section_tipo: sectionTipo, parent: 'self', mode: 'search', limit } as Ddo,
		model,
		childDdos,
		'search',
		lang,
		{ section_tipo: sectionTipo, section_id: null as unknown as number },
		tipo,
		searchEmission,
		emitDdoData,
		{ childRowFromTarget: true, stampParentSectionId: true },
	);

	// Main-item fixups (PHP set_data on the element): injected entries are
	// id-stamped 1..n, WITHOUT the paginated_key of the stored-value path.
	const mainItem = data.find((item) => (item as DataItem).tipo === tipo) as DataItem | undefined;
	if (mainItem !== undefined) {
		mainItem.entries = injected.map((locator, index) => ({ ...locator, id: index + 1 }));
		(mainItem as Record<string, unknown>).row_section_id = undefined;
	}

	// Dataframe slot items: one per injected entry per paired dataframe ddo,
	// EMPTY (no stored record ⇒ no frames), keyed by id_key = the entry id
	// (PHP emits them even when empty; row_section_id carries the id_key —
	// as canonical INT, WC-2026-08-10-section-id-int-canonical: it is a
	// number-typed key here, so the old String() minting is repealed).
	for (const dataframeDdo of dataframeDdos) {
		for (let index = 0; index < Math.max(injected.length, 0); index++) {
			const idKey = index + 1;
			data.push({
				section_id: null,
				section_tipo: sectionTipo,
				tipo: dataframeDdo.tipo,
				mode: 'list',
				lang: 'lg-nolan',
				from_component_tipo: tipo,
				entries: [],
				parent_tipo: tipo,
				parent_section_id: null,
				pagination: { total: 0, limit: 1, offset: 0 },
				id_key: idKey,
				main_component_tipo: tipo,
				row_section_id: idKey,
			} as unknown as DataItem);
		}
	}
	return data as DataItem[];
}

/**
 * Derive a section's default ddo_map from its ontology request_config when the
 * client sends no explicit show (PHP build_request_config for a section:
 * list mode → section_list columns; edit mode → the full component tree).
 */
export async function deriveSectionDdoMap(
	sectionTipo: string,
	ownerSectionTipo: string,
	mode: string,
	/**
	 * The rqo `source.properties` override, when the caller sent one — it
	 * REPLACES the section's ontology properties as the config feed, exactly as
	 * in the context half (PHP set_properties runs before the config build). The
	 * two halves MUST agree: the client binds each rendered cell to its context
	 * by an exact (tipo, mode, section_tipo) match and silently drops the rest.
	 */
	propertiesOverride?: unknown,
): Promise<Ddo[]> {
	const { getNode } = await import('../ontology/resolver.ts');
	const { buildRequestConfigForElement } = await import('../relations/request_config/build.ts');
	const node = propertiesOverride !== undefined ? null : await getNode(sectionTipo);
	const config = await buildRequestConfigForElement(
		propertiesOverride ?? node?.properties ?? null,
		{
			ownerTipo: sectionTipo,
			ownerSectionTipo,
			mode,
			ownerIsSection: true,
		},
	);
	const showDdos = config[0]?.show?.ddo_map ?? [];
	return showDdos.map(
		(ddo) =>
			({
				tipo: ddo.tipo,
				// The read loop resolves direct children against each row's
				// section; keep the ddo's own section_tipo for cross-section ddos.
				section_tipo: Array.isArray(ddo.section_tipo) ? ddo.section_tipo[0] : ddo.section_tipo,
				parent: ddo.parent,
				mode: ddo.mode,
				lang: (ddo as { lang?: string }).lang,
				// view drives the client's per-cell renderer choice (e.g. the
				// publication toggle needs view 'line') — must survive derivation.
				view: (ddo as { view?: string }).view,
			}) as Ddo,
	);
}

/**
 * The section read's column ddo_map, with the same precedence as PHP
 * build_request_config for a section read PLUS the caller `get_ddo_map` hook:
 *  1. the client's literal show.ddo_map wins (it may name any tipo);
 *  2. else a client show.get_ddo_map section_map DIRECTIVE — the search-panel
 *     preset picker names its label column by ROLE ({path:['default','term']})
 *     so the tipo is never hardcoded (was the v6 literal ddo_map:[dd624]);
 *  3. else the section's ontology default (section_list columns / edit tree).
 * Shared by readSection (context half) and readSectionRows (data half) so the
 * two halves never diverge on which columns the picker shows.
 */
async function resolveSectionColumnDdoMap(
	rqo: Rqo,
	callerTipo: string,
	sectionTipo: string,
	mode: string,
): Promise<Ddo[]> {
	const literal = rqo.show?.ddo_map;
	if (Array.isArray(literal) && literal.length > 0) return literal;
	const directive = (rqo.show as { get_ddo_map?: unknown } | undefined)?.get_ddo_map;
	if (directive !== undefined) {
		const { resolveSectionMapGetDdoMap } = await import('../relations/request_config/explicit.ts');
		const raw = await resolveSectionMapGetDdoMap(callerTipo, sectionTipo, directive);
		if (raw.length > 0) {
			return raw.map(
				(d) =>
					({
						tipo: d.tipo,
						section_tipo: Array.isArray(d.section_tipo) ? d.section_tipo[0] : d.section_tipo,
						parent: d.parent,
						mode: (d as { mode?: string }).mode,
						lang: (d as { lang?: string }).lang,
						view: (d as { view?: string }).view,
					}) as Ddo,
			);
		}
	}
	// TIME MACHINE (dd15): the columns are derived from the AUTHORISED SCOPE, not
	// from dd15's own ontology (WC-2026-08-14-tm-scope-server-owned). Resolved
	// through the SAME helper the structure-context uses, so the data half and the
	// context half cannot disagree — a client binds a cell to its context by an
	// exact (tipo, mode, section_tipo) match and silently drops any column where
	// the two differ. `null` = no server opinion (the bare browse), which falls
	// through to the ordinary ontology derivation below.
	if (sectionTipo === TIME_MACHINE_SECTION_TIPO) {
		const { resolveTimeMachineScope, tmListColumns } = await import(
			'./list_definitions/time_machine_list.ts'
		);
		const source = rqo.source ?? {};
		const scope = resolveTimeMachineScope(rqo.sqo as Record<string, unknown> | undefined, {
			surface: (source as { tm_surface?: unknown }).tm_surface,
		});
		const derived = await tmListColumns(scope);
		if (derived !== null) {
			return derived.map(
				(column) =>
					({
						tipo: column.tipo,
						section_tipo: TIME_MACHINE_SECTION_TIPO,
						parent: TIME_MACHINE_SECTION_TIPO,
						mode: 'list',
						view: column.view ?? undefined,
					}) as Ddo,
			);
		}
	}
	return deriveSectionDdoMap(
		callerTipo,
		sectionTipo,
		mode,
		(rqo.source ?? {}).properties ?? undefined,
	);
}

/**
 * A section's list default page size + sort, read from its resolved
 * request_config sqo (list mode → the section_list child's
 * properties.source.request_config[dedalo].sqo — e.g. dd542 Activity's dd549
 * carries limit 30 + order [section_id DESC]). PHP resolves the same values
 * (resolve_pagination_defaults + the request_config sqo.order) and applies them
 * to the search when the client omits them; readSectionRows mirrors that.
 * Returns an empty object when the section declares neither — the global
 * maxRowsPerPage / section_id-ASC defaults then stand. `order` is passed through
 * verbatim (the search assembler's buildOrderClauses shape).
 */
export async function deriveSectionListSqoDefaults(
	sectionTipo: string,
	ownerSectionTipo: string,
	mode: string,
	/**
	 * The rqo `source.properties` override, when the caller sent one — the SAME
	 * feed the columns derive from, so a tool that declares its own page size or
	 * sort gets it (PHP resolves calculate_default_limit and the config
	 * `sqo.order` from the REPLACED properties too).
	 *
	 * It is CLIENT input, so the limit it yields is clamped at CLIENT_MAX_LIMIT
	 * — these defaults are applied AFTER sanitizeClientSqo, and without the
	 * clamp a declared `limit` would be the one number on the read that never
	 * met the sanitizer.
	 */
	propertiesOverride?: unknown,
): Promise<{ limit?: number; order?: unknown }> {
	const { getNode } = await import('../ontology/resolver.ts');
	const { buildRequestConfigForElement } = await import('../relations/request_config/build.ts');
	const node = propertiesOverride !== undefined ? null : await getNode(sectionTipo);
	const config = await buildRequestConfigForElement(
		propertiesOverride ?? node?.properties ?? null,
		{
			ownerTipo: sectionTipo,
			ownerSectionTipo,
			mode,
			ownerIsSection: true,
		},
	);
	const sqo = config[0]?.sqo as { limit?: unknown; order?: unknown } | undefined;
	const rawLimit = typeof sqo?.limit === 'number' && sqo.limit > 0 ? sqo.limit : undefined;
	const { CLIENT_MAX_LIMIT } = await import('../concepts/sqo.ts');
	const limit =
		rawLimit === undefined
			? undefined
			: propertiesOverride === undefined
				? rawLimit
				: Math.min(rawLimit, CLIENT_MAX_LIMIT);
	// `order` may be authored as an array OR a single {path,direction} object
	// (PHP tolerates both); pass either through — buildOrderClauses normalizes it.
	const rawOrder = sqo?.order;
	const order =
		Array.isArray(rawOrder) && rawOrder.length > 0
			? rawOrder
			: rawOrder !== null && typeof rawOrder === 'object'
				? rawOrder
				: undefined;
	return { limit, order };
}

export async function readSectionRows(
	rqo: Rqo,
	principal?: Principal,
): Promise<(SectionsEnvelope | DataItem)[]> {
	const source = rqo.source ?? {};
	const callerTipo = source.tipo;
	if (callerTipo === undefined) {
		throw new DedaloError('request.invalid_source', {
			message: 'readSectionRows: rqo.source.tipo is required',
		});
	}
	// A search-panel component read (the service_autocomplete picker, the
	// input_text find_equal probe) stamps the COMPONENT's own mode ('search')
	// on the source (client create_source). PHP serves it as a plain read
	// regardless (dd_core_api.php:2256 case 'search' → sections::get_instance
	// with the given mode; row acquisition is mode-agnostic there). Normalize
	// to 'list': 'search' is a UI mode, not a row-read mode — the emission
	// path is the frozen BUG-0 picker contract (autocomplete_search_differential).
	// A Time Machine read is a LIST read (WC-2026-08-14-tm-ddo-mode-retired): the
	// row SOURCE is chosen by sqo.mode, never by this render mode. DECLARED
	// EXEMPTION — 'tm' is still ACCEPTED here and normalized rather than refused,
	// because tool/component JS is served without a cachebust: a browser holding
	// yesterday's client still sends the old render mode, and answering a 500 to a
	// stale-but-honest request would break the history panel until a hard reload.
	// The alias is input tolerance only; nothing downstream ever sees 'tm'.
	const rawMode = source.mode === 'tm' ? 'list' : source.mode;
	const mode = rawMode === 'search' ? 'list' : (rawMode ?? 'list');
	// Request-scoped data lang, never a hardcoded install default (S2-28): an
	// RQO that omits lang resolves the session's active data language.
	const lang = source.lang ?? currentDataLang();
	// 'list_thesaurus' (the thesaurus section build — client section.js:800
	// normalizes it back to 'list' after the fetch) is a plain list read on the
	// row side (PHP dd_core_api :2256 row acquisition is mode-agnostic); the mode
	// only steers the derived column selection (request_config build →
	// section_list_thesaurus instead of section_list) and the context swap.
	if (mode !== 'list' && mode !== 'edit' && mode !== 'list_thesaurus') {
		throw new DedaloError('engine.uncovered_scope', {
			message: `readSectionRows: mode '${mode}' not implemented yet (covered: 'list', 'edit', 'list_thesaurus')`,
			coordinates: { mode: String(mode) },
		});
	}
	// The client's show.ddo_map wins; else a caller section_map get_ddo_map
	// directive (the preset picker), else the section's ontology default (PHP
	// build_request_config → the section_list/implicit columns).
	let ddoMap: Ddo[] = await resolveSectionColumnDdoMap(
		rqo,
		callerTipo,
		source.section_tipo ?? callerTipo,
		mode,
	);
	// Per-component READ gate on the DATA side (PHP check_ddo_permissions +
	// STEP 5 filter_authorized_related): a component the actor holds level 0 on
	// never reaches emitDdoData — client-sent maps included (the config-build
	// gates only shape the server-derived default map). Admin-flagged users go
	// through the matrix too (PHP parity); superuser passes via getPermissions.
	// A Time Machine (dd15) read judges EVERY ddo in dd15, whatever parent the
	// client names: emitTmRow reads each cell from the virtual dd15 record by
	// tipo alone, so the parent the gate judges must be the record the value
	// comes from — the dd15 floor (the (scope section, component) pair), the
	// same parent buildTmContext's authorizedTmColumns judges. Otherwise a
	// rule-granted parent (dd655 preset, dd1324 tools register, a public list)
	// re-authorized a level-0 component's past values. Keyed on what picks the
	// read source (sqo.mode 'tm' → tmReadSource), not only on the request
	// source: a forged source naming another section still reads dd15 rows.
	const readsTimeMachine =
		rqo.sqo?.mode === 'tm' || (source.section_tipo ?? callerTipo) === TIME_MACHINE_SECTION_TIPO;
	if (principal !== undefined) {
		const authorized: Ddo[] = [];
		for (const ddo of ddoMap) {
			const gateSection = readsTimeMachine
				? TIME_MACHINE_SECTION_TIPO
				: ddo.section_tipo === undefined || ddo.section_tipo === 'self'
					? (source.section_tipo ?? callerTipo)
					: ddo.section_tipo;
			if (await ddoIsAuthorized(principal, gateSection, ddo.tipo)) authorized.push(ddo);
		}
		ddoMap = authorized;
	}
	if (rqo.sqo === undefined) {
		throw new DedaloError('request.invalid_rqo', {
			message:
				'readSectionRows: rqo.sqo is required (PHP "non received case" dd_core_api :2201-2251 uncovered)',
		});
	}

	// Session navigation read-back (PHP dd_core_api :2159-2199): with session
	// navigation on, navigation properties the client did NOT send are filled
	// from the session's stored SQO for this section — a plain secondary
	// window (page/?tipo=X) inherits the filter its opener stored, tools
	// re-enter the user's navigation. Runs BEFORE the limit/order capture
	// below so a merged session value counts as client-sent (PHP passes the
	// merged sqo straight to sections). ALS session read at call time.
	const sessionSave = (source as { session_save?: boolean }).session_save ?? true;
	if (sessionSave) {
		const { currentRequestContext } = await import('../security/request_context.ts');
		const storedSqo = currentRequestContext()?.session?.sqoSession?.[callerTipo];
		if (storedSqo !== undefined) {
			mergeSessionSqo(
				rqo.sqo as Record<string, unknown>,
				sessionSqoForMerge(rqo.sqo, storedSqo, principal),
			);
		}
	}

	// --- run the search (Phase 3 engine) -----------------------------------
	// Mode default page size: the client sends a NULL/absent limit when it has
	// no explicit pagination yet — by design it defers the default to the server
	// ("force to generate default limit from server", client common.js
	// build_rqo_show:1723; the client-side default at section.js:827 only lands
	// on the NEXT request, after the first list load has already gone out). If we
	// let sanitizeClientSqo see that missing limit it clamps to the 1000 security
	// CEILING — so the first list load would show 1000 rows. Apply the mode
	// default here instead: edit → 1 record, list → 10 rows (PHP section.js:827).
	// A genuine oversized/invalid client limit still hits the ceiling in sanitize.
	const clientLimit = (rqo.sqo as { limit?: unknown }).limit;
	const clientLimitMissing = clientLimit === undefined || clientLimit === null;
	const clientOrder = (rqo.sqo as { order?: unknown }).order;
	const clientOrderMissing =
		clientOrder === undefined ||
		clientOrder === null ||
		(Array.isArray(clientOrder) && clientOrder.length === 0);
	// A section's LIST defaults (page size + sort) live on its request_config
	// sqo (properties.source.request_config[dedalo].sqo of the section_list
	// child). The byte-identical client's first list load fires BEFORE it derives
	// any client-side pagination (build_autoload sends the pre-context rqo), so it
	// sends neither limit nor order — PHP resolves both from the request_config
	// and applies them to the search SERVER-SIDE (which is why live PHP returns
	// dd542 Activity's 30-row/newest-first list on first paint). Mirror that:
	// resolve the config once and apply each default only when the client omitted
	// it. Only fetched when a default is actually needed.
	const needsSqoDefaults = mode !== 'edit' && (clientLimitMissing || clientOrderMissing);
	const sqoDefaults = needsSqoDefaults
		? await deriveSectionListSqoDefaults(
				callerTipo,
				source.section_tipo ?? callerTipo,
				mode,
				source.properties ?? undefined,
			)
		: {};
	const sqo = sanitizeClientSqo(structuredClone(rqo.sqo) as Record<string, unknown>);
	if (mode === 'edit') {
		if (clientLimitMissing) {
			// Mode default: one record (client section.js:827 defers to the server).
			sqo.limit = 1;
		} else {
			// PHP's edit clamp is SECTION-only (dd_core_api.php:2259-61:
			// model==='section' && limit missing-or->1 → 1). Component-source edit
			// searches (the input_text find_equal probe) keep their explicit limit.
			const callerModel = source.model ?? (await getModelByTipo(callerTipo));
			if (callerModel === 'section' && Number(clientLimit) > 1) {
				sqo.limit = 1;
			}
		}
	} else if (clientLimitMissing) {
		// Configured page size (PHP calculate_default_limit) → else the global
		// DEDALO_MAX_ROWS_PER_PAGE default.
		sqo.limit = sqoDefaults.limit ?? dedaloConfig.features.maxRowsPerPage;
	}
	// Default sort: the section's configured order (PHP applies request_config
	// sqo.order server-side; the client never emits a config-default order on
	// first load). A client-sent order always wins.
	if (clientOrderMissing && sqoDefaults.order !== undefined) {
		(sqo as { order?: unknown }).order = sqoDefaults.order;
	}
	// Session navigation SQO (PHP dd_core_api :2276-98/:2339): SECTION reads in
	// list/edit persist their resolved sqo per session unless the caller opts
	// out (source.session_save=false — secondary windows). Tools re-read it
	// (tool_export record preservation, section_tool navigation) and the section
	// context stamps it back as `sqo_session`. The ALS session is read at call
	// time; requests without one (harnesses, background) skip.
	// (PHP $session_save_modes = ['edit','list','list_thesaurus'], :2276.)
	if (sessionSave && (mode === 'list' || mode === 'edit' || mode === 'list_thesaurus')) {
		const callerModel = source.model ?? (await getModelByTipo(callerTipo));
		if (callerModel === 'section') {
			const { currentRequestContext } = await import('../security/request_context.ts');
			const requestSession = currentRequestContext()?.session ?? null;
			if (requestSession !== null) {
				const { setSessionSqo } = await import('../security/session_store.ts');
				setSessionSqo(requestSession, callerTipo, structuredClone(sqo));
			}
		}
	}
	// The read STRATEGY: the default matrix source (buildSearchSql → rows,
	// readMatrixRecord → record, direct-child ddo loop), or the virtual dd15
	// Time Machine source — same generic envelope/context/count, only row
	// acquisition + per-row cell policy differ (PHP search_tm parity). The TM
	// signal is sqo.mode (the SOURCE mode stays 'list'/'edit' — PHP mirrors this:
	// sqo->mode 'tm' picks search_tm while the read action is still 'search').
	const readSource = await pickReadSource((sqo as { mode?: string }).mode);
	// The subdatum READ FLOOR (closure Step 3, SEC-1): a portal / autocomplete
	// search may filter its target section by the components its VERIFIED
	// source's request_config names, although the profile holds 0 on them (PHP
	// get_subdatum's floor). Computed from the ontology, re-verified against the
	// principal — never read from the client payload.
	const { subdatumReadFloor } = await import('../security/read_floor.ts');
	const readFloor = await subdatumReadFloor(principal, source);
	const rows = await readSource.getRows(sqo, principal, readFloor);

	// --- envelope (PHP sections_json.php :136) ------------------------------
	// Each entry is {section_tipo, section_id, paginated_key} plus any
	// source-specific extras (the TM source adds matrix_id/timestamp/caller_*/…).
	const offset = typeof sqo.offset === 'number' ? sqo.offset : 0;
	const envelope: SectionsEnvelope = {
		typo: 'sections',
		tipo: callerTipo,
		section_tipo: [],
		entries: rows.map((row, index) => ({
			section_tipo: row.section_tipo,
			section_id: row.section_id,
			paginated_key: index + offset,
			...(row.envelopeExtra ?? {}),
		})),
	};

	// PER-ROW SELECTABILITY (thesaurus picker). A list row is a term like any
	// tree node, but the tree got its `is_indexable` answer from get_node_data /
	// get_children_data and the list read emitted none — so the client's
	// term_selectability answered UNKNOWN and refused the pick arrow on every
	// search result (the primary way into a large thesaurus). Stamp the SAME
	// fact here, from the SAME resolver, so the affordance follows a server
	// answer and never a guess.
	//
	// TWO ANSWERS, BOTH EXPLICIT (2026-08-17). A section that declares no
	// `thesaurus.is_indexable` has no per-term contract — and `relations/save.ts`
	// gate 3 ALREADY exempts it: the pick is authorized, nothing to re-ask. The
	// read used to say nothing at all in that case, the client read the silence
	// as UNKNOWN, and every row of such a section (rsc197, People, reached
	// through tool_indexation's people picker) rendered with no link arrow while
	// the write door stood open. So the no-contract case is now STATED —
	// `selectability_declared: false` on each entry, from `declaresTermSelectability`,
	// the same predicate the gate reads. Silence is no longer an answer here.
	if (mode === 'list' || mode === 'list_thesaurus') {
		const { declaresTermSelectability } = await import('../ontology/section_map.ts');
		const declared = await declaresTermSelectability(callerTipo);
		if (!declared) {
			// No contract: say so once per row. The client turns this into
			// "selectable", matching gate 3's exemption exactly.
			for (const entry of envelope.entries) {
				entry.selectability_declared = false;
			}
		} else if (envelope.entries.length > 0) {
			const { fetchNodeInfo } = await import('../ts_object/node_repository.ts');
			const info = await fetchNodeInfo(
				envelope.entries.map((entry) => ({
					section_tipo: entry.section_tipo,
					section_id: entry.section_id,
				})),
			);
			for (const entry of envelope.entries) {
				const node = info.get(`${entry.section_tipo}_${entry.section_id}`);
				if (node !== undefined) entry.is_indexable = node.is_indexable;
			}
		}
	}

	// --- subdatum: record-major, ddo-minor (PHP get_subdatum loop order) ----
	// The source owns per-row emission (matrix: record + direct-child ddo loop;
	// tm: who/when/where/what + snapshot cell policy). emitDdoData is passed in
	// so the source can resolve generic components without an import cycle.
	const emission = new EmissionContext([envelope]);
	// Pre-seed the per-read record loader with the page's first-level relation
	// targets: one batch read per target section replaces the per-locator
	// round-trips inside the relation-cell expansion (nested levels load lazily
	// through the same deduping cache). Rows without a hydrated MatrixRecord
	// (the TM source's flat raw) are skipped — their cells keep the lazy path.
	// The per-key cap bounds pathological many-locator cells; anything beyond
	// it lazy-loads, so the cap only shapes the batch width, never the output.
	{
		const pageLocators: { section_tipo?: unknown; section_id?: unknown }[] = [];
		for (const row of rows) {
			const relation = (row.raw as { columns?: { relation?: unknown } } | null | undefined)?.columns
				?.relation;
			if (relation === null || typeof relation !== 'object') continue;
			for (const value of Object.values(relation as Record<string, unknown>)) {
				if (!Array.isArray(value)) continue;
				for (const locator of value.slice(0, 30)) {
					if (locator !== null && typeof locator === 'object') {
						pageLocators.push(locator as { section_tipo?: unknown; section_id?: unknown });
					}
				}
			}
		}
		if (pageLocators.length > 0) await prefetchRecords(emission, pageLocators);
	}
	for (const row of rows) {
		await readSource.emitRow({
			row,
			ddoMap,
			mode,
			lang,
			callerTipo,
			emission,
			emitDdo: emitDdoData,
			principal,
		});
	}
	return emission.items;
}

/**
 * The hard bound on ddo recursion depth (this function re-enters itself
 * through every relation expansion — portal children, dataframe frames,
 * autocomplete targets).
 *
 * THE MAP IS CLIENT-SUPPLIED (`show.ddo_map` — the client's map wins, see the
 * config-build note above), and a map is a parent-CHAIN, not a tree the
 * server validated: `[{A,parent:section},{B,parent:A},{A,parent:B}]` is a
 * cycle, and every hop with stored locators re-enters here one level deeper.
 * Nothing else stops it — relation_core's `depth < 4` gates the nested
 * OWN-CONFIG lookup, never this recursion — so without this bound a cyclic
 * map blows the stack instead of answering.
 *
 * The value is generous on purpose: PHP's deepest observed real chain is
 * three levels (bibliography → reference → author) and the numisdata3 list
 * cell is three (numisdata77 → numisdata164 → rsc29), so 12 refuses only
 * maps that are already pathological. A refusal is LOUD (a caller-category
 * DedaloError naming the chain), never a silent truncation: a legitimately
 * deeper map must be seen and raised here, not quietly served short one
 * level — which is the exact failure this whole change fixes.
 */
const MAX_DDO_DEPTH = 12;

/**
 * Resolve one ddo against one record and push its data item(s) — the single
 * per-component emission path shared by the section read and portal
 * expansion. Splits by model family (relation label/portal/media/literal)
 * exactly as PHP's component get_json controllers do.
 */
export async function emitDdoData(
	ddo: Ddo,
	ddoMap: Ddo[],
	record: MatrixRecord,
	row: EmitRow,
	defaultMode: string,
	defaultLang: string,
	callerTipo: string,
	emission: EmissionContext,
	allowOwnConfigChildren = true,
	depth = 0,
): Promise<void> {
	if (depth > MAX_DDO_DEPTH) {
		throw new DedaloError('request.invalid_rqo', {
			message: `emitDdoData: ddo_map recursion exceeded ${MAX_DDO_DEPTH} levels at '${ddo.tipo}' (parent '${callerTipo}') — the map is cyclic or pathologically deep`,
			coordinates: { tipo: ddo.tipo, section_tipo: row.section_tipo, section_id: row.section_id },
		});
	}
	const model = await getModelByTipo(ddo.tipo);
	if (model === null) {
		throw new DedaloError('request.invalid_tipo', {
			message: `emitDdoData: unknown ddo tipo '${ddo.tipo}'`,
			coordinates: { tipo: ddo.tipo },
		});
	}
	if (!model.startsWith('component_')) {
		return; // groupers etc. contribute context only (deferred)
	}

	// Activity 'where' (dd546): the stored value is an ontology tipo — PHP
	// renders "«term» [tipo]" (same transform as the TM dd577 column).
	if (ddo.tipo === 'dd546') {
		const stored =
			((record.columns.string as Record<string, unknown[]> | null)?.[ddo.tipo] as {
				lang?: string;
				value?: string;
			}[]) ?? [];
		// Same helper as the TM What/Where columns — one «term» [tipo] shape for
		// every column that stores a tipo (WC-2026-08-14-tm-cells-obey-list-emit-policy).
		const { ontologyTermLabel } = await import('../ontology/labels.ts');
		const entries: unknown[] = [];
		for (const item of stored) {
			const raw = String(item?.value ?? '');
			const resolved = /^[a-z]+[0-9]+$/.test(raw) ? await ontologyTermLabel(raw, defaultLang) : raw;
			entries.push({ ...item, value: resolved });
		}
		const whereItem = buildDataItem(
			ddo.tipo,
			row.section_tipo,
			row.section_id,
			ddo.mode ?? defaultMode,
			'lg-nolan',
			entries.length > 0 ? entries : null,
		);
		whereItem.fallback_value = null;
		whereItem.row_section_id = row.section_id;
		whereItem.parent_tipo = callerTipo;
		emission.items.push(whereItem);
		return;
	}
	const ddoMode = ddo.mode ?? defaultMode;
	// Instance lang: non-translatable components are nolan-forced at
	// instantiation (PHP get_element_lang) when the ddo carries no lang.
	const { getTranslatableByTipo: isTranslatable } = await import('../ontology/resolver.ts');
	const ddoLang = ddo.lang ?? ((await isTranslatable(ddo.tipo)) ? defaultLang : 'lg-nolan');

	// Per-model emit hook (audit S2-24): the descriptor names it as DATA
	// (emitHook), components/emit_hooks.ts maps it to its implementation in the
	// model's home. REPLACE hooks (media, section_id) fully own the emission;
	// value/decoration hooks ride the generic literal path below.
	const emitHook = getEmitHook(model);

	// component_alias scope guard (WC-020 v1): the alias-wired emissions are
	// the PORTAL family (expandPortal keys by dataTipo) and the generic
	// LITERAL path (resolveComponentValue hops internally). Any other face —
	// children/parent/related/index/select-family datalists, REPLACE emit
	// hooks (media/section_id) — reads data by the ddo's own tipo and would
	// silently serve the alias's EMPTY slot: refuse loudly instead
	// (rewrite/LEDGER.md known-open gaps).
	const { resolveDataTipo } = await import('../ontology/alias.ts');
	const dataTipo = await resolveDataTipo(ddo.tipo);
	if (dataTipo !== ddo.tipo) {
		const aliasWired =
			getColumnNameByModel(model) === 'relation'
				? model === 'component_portal'
				: emitHook?.emitItem === undefined;
		if (!aliasWired) {
			throw new DedaloError('engine.uncovered_scope', {
				message: `component_alias '${ddo.tipo}': target model '${model}' is not alias-wired yet (WC-020 v1)`,
				coordinates: { tipo: ddo.tipo, model },
			});
		}
	}
	const hookContext: EmitHookContext = {
		ddo,
		record,
		row,
		model,
		ddoMode,
		ddoLang,
		defaultMode,
		defaultLang,
		callerTipo,
		emission,
	};
	if (emitHook?.emitItem !== undefined) {
		await emitHook.emitItem(hookContext);
		return;
	}

	if (getColumnNameByModel(model) === 'relation') {
		// Relation family: dispatch to the registered model resolver
		// (relations/registry.ts). The per-model particularities live there;
		// child recursion re-enters THIS function via the emitDdo callback.
		const { getRelationResolver } = await import('../relations/registry.ts');
		await getRelationResolver(model).emitDdoItems({
			ddo,
			ddoMap,
			record,
			row,
			model,
			dataTipo,
			ddoMode,
			ddoLang,
			defaultMode,
			defaultLang,
			callerTipo,
			emission,
			allowOwnConfigChildren,
			depth,
			emitDdo: emitDdoData,
		});
		return;
	}

	// LITERAL components: resolve the lang-sliced value, run the model's value
	// hook (info live-compute, text_area list truncation), build + decorate.
	// A hook may FORCE the slice lang per record BEFORE the read (text_area
	// original-language: the transcript lives in the interview's own language,
	// whatever the data-lang menu says) — the emitted item's `lang` follows,
	// exactly as PHP's `$this->lang` switch did on the wire.
	const forcedLang = (await emitHook?.resolveEmitLang?.(hookContext)) ?? null;
	const effectiveLang = forcedLang ?? ddoLang;
	let { value, fallbackValue } = await resolveComponentValue(
		record,
		ddo.tipo,
		model,
		effectiveLang,
	);
	if (emitHook?.transformValue !== undefined) {
		value = await emitHook.transformValue(value, hookContext);
	}

	const item = buildDataItem(
		ddo.tipo,
		row.section_tipo,
		row.section_id,
		ddoMode,
		effectiveLang,
		value,
	);
	// text_area ALWAYS carries the fallback_value key (PHP
	// component_text_area_json attaches it unconditionally — explicit null
	// when the value is present or no cross-lang fallback exists); other
	// literals attach it only when a fallback resolved.
	if (fallbackValue !== null || model === 'component_text_area') {
		item.fallback_value = fallbackValue;
	}
	item.row_section_id = row.section_id;
	item.parent_tipo = callerTipo;

	// LITERAL mains pair with their dataframe slots too (the user-confirmed
	// contract: any component — input_text, date, iri… — can declare frames):
	//   - component_iri ALWAYS pairs with its dd560 label dataframe (PHP
	//     component_iri_json, hardcoded DEDALO_COMPONENT_IRI_LABEL_DATAFRAME);
	//   - other literals require properties.has_dataframe === true (PHP
	//     build_dataframe_subdatum) and pair with their ontology dataframe
	//     children.
	// One frame per stored item id; the empty case uses the next provisional
	// id (counter+1) so the editor can render a blank slot. The frame node's
	// own properties.mode ('edit') is the item mode. Frames emit BEFORE the
	// literal's own item (PHP merges the subdatum first).
	if (ddoMode !== 'search') {
		const { resolveFrameConfig, getDataframeChildTipos } = await import(
			'../section/list_definitions/section_list.ts'
		);
		// Fixed frames are descriptor DATA (component_iri's dd560 — the PHP
		// hardcoded DEDALO_COMPONENT_IRI_LABEL_DATAFRAME); other literals pair
		// via the generic properties.has_dataframe ontology walk.
		const fixedFrames = getComponentModel(model)?.fixedDataframeTipos;
		let frameTipos: string[] = fixedFrames !== undefined ? [...fixedFrames] : [];
		if (frameTipos.length === 0) {
			const { getNode } = await import('../ontology/resolver.ts');
			const hasDataframe =
				((await getNode(ddo.tipo))?.properties as { has_dataframe?: boolean } | null)
					?.has_dataframe === true;
			if (hasDataframe) {
				frameTipos = await getDataframeChildTipos(ddo.tipo);
			}
		}
		if (frameTipos.length > 0) {
			// has_dataframe literals carry the frame item-id counter (PHP
			// get_counter — data.counters[tipo], 0 when never assigned).
			const counters = (record.columns.data as { counters?: Record<string, number> } | null)
				?.counters;
			const frameCounter = Number(counters?.[ddo.tipo] ?? 0);
			item.counter = frameCounter;
			const storedIds = (Array.isArray(value) ? value : [])
				.map((valueItem) => (valueItem as { id?: number | string } | null)?.id)
				.filter((id): id is number | string => id !== undefined && id !== null);
			// Blank slot = the NEXT provisional id, counter+1 — the client's own
			// derivation (dataframe.js `item?.id ?? self.data.counter + 1`,
			// render_edit_component_iri `current_value.id ?? self.data.counter+1`),
			// so the emitted frame is the one the editor looks up. A literal `1`
			// here (DATA-27) paired the blank frame at a key the client never asks
			// for whenever the counter had moved past zero.
			const pairIds = storedIds.length > 0 ? storedIds : [frameCounter + 1];
			// The main's OWN declared ddo for each slot. A dataframe must behave
			// IDENTICALLY on a literal and on a relation main — one component,
			// one ontology contract — so the frame's mode/target come from the
			// same place in both: the ddo the main declares in its
			// `show.ddo_map`. The relation path already does exactly this
			// (relation_core: `childDdo.mode ?? portalMode`); this path used to
			// pass a SYNTHETIC ddo `{tipo, section_tipo}` and read the mode off
			// the slot NODE instead, so a ddo that declared `"mode":"edit"` was
			// silently ignored on a literal and the frame resolved to 'list' —
			// which, with any view other than default/text/mini, renders nothing.
			// Discovery still walks fixedDataframeTipos / has_dataframe children
			// (a slot need not be declared to exist); the ddo only supplies HOW
			// it renders, and the node-property fallback keeps every config that
			// declares no ddo byte-identical.
			const { resolveOwnConfigMap } = await import('../section/list_definitions/section_list.ts');
			const declaredDdos = (await resolveOwnConfigMap(ddo.tipo)).rawDdos ?? [];
			for (const frameTipo of frameTipos) {
				const declared = declaredDdos.find((entry) => entry.tipo === frameTipo);
				// Frame item mode: the DECLARED ddo, else the frame NODE's own
				// properties.mode (dd560 → 'edit'), else LIST (the generic
				// literal default, oracle-pinned).
				const frameMode =
					declared?.mode ?? (await resolveFrameConfig(frameTipo)).nodeMode ?? 'list';
				// Frames live on the caller's record unless the ddo names another
				// section ('self'/undeclared = the caller's) — the sibling-record
				// case emitDataframeItem resolves.
				const declaredSection =
					typeof declared?.section_tipo === 'string' && declared.section_tipo !== 'self'
						? declared.section_tipo
						: row.section_tipo;
				for (const pairId of pairIds) {
					await emitDataframeItem(
						{ tipo: frameTipo, section_tipo: declaredSection, view: declared?.view } as Ddo,
						record,
						ddo.tipo,
						pairId,
						frameMode,
						row,
						defaultLang,
						callerTipo,
						emission,
						depth,
						emitDdoData,
					);
				}
			}
		}
	}

	// Per-model item decoration (filter_records datalist backstop,
	// security_access ACL payload, text_area's unconditional fallback key).
	if (emitHook?.decorateItem !== undefined) {
		await emitHook.decorateItem(item, hookContext);
	}
	emission.items.push(item);
}

/**
 * The CONTEXT of a get_data response (PHP: each recursive get_json merges its
 * structure context, deduped by context_key). Faithful derivation: one entry
 * for the component itself, then one per UNIQUE (tipo, section_tipo, mode)
 * among the emitted subdatum items in first-emission order — the context
 * mirrors the children ACTUALLY resolved (per-locator section grouping
 * included), each parented to its generating component
 * (from_component_tipo).
 */
export async function buildGetDataContext(
	rqo: Rqo,
	items: DataItem[],
	principal?: Principal,
): Promise<StructureContextEntry[]> {
	const source = rqo.source ?? {};
	const tipo = String(source.tipo ?? '');
	const sectionTipo = String(source.section_tipo ?? '');
	const mode = source.mode ?? 'edit';
	// Request-scoped data lang, never a hardcoded install default (S2-28): an
	// RQO that omits lang resolves the session's active data language.
	const lang = source.lang ?? currentDataLang();

	// per-parent ddo-view lookup: a child's context `view` comes from the
	// GENERATING component's config ddo (e.g. numisdata158 declares 'line' in
	// numisdata77's show.ddo_map).
	const ownerSectionOf = new Map<string, string>([[tipo, sectionTipo]]);
	const viewCache = new Map<string, Map<string, string | null>>();
	const ddoViewOf = async (parentTipo: string, childTipo: string): Promise<string | null> => {
		let views = viewCache.get(parentTipo);
		if (views === undefined) {
			views = new Map<string, string | null>();
			const { getEffectivePropertiesByTipo } = await import('../ontology/alias.ts');
			const { buildRequestConfigForElement } = await import('../relations/request_config/build.ts');
			// component_alias (WC-020): a child's view may be declared in an ALIAS
			// parent's merged show map.
			const parentConfig = await buildRequestConfigForElement(
				(await getEffectivePropertiesByTipo(parentTipo)) ?? null,
				{
					ownerTipo: parentTipo,
					ownerSectionTipo: ownerSectionOf.get(parentTipo) ?? sectionTipo,
					mode: 'edit',
					ownerIsSection: false,
				},
			);
			// EVERY config item's show map (PHP full_ddo_map): a second source's
			// column may carry the `view` its child renders with.
			const { flattenConfigDdoMaps } = await import('../relations/config_ddo_map.ts');
			for (const ddo of flattenConfigDdoMaps(parentConfig, { ownerTipo: parentTipo })) {
				if (typeof ddo.tipo !== 'string') continue;
				views.set(ddo.tipo, (ddo.view as string | undefined) ?? null);
			}
			viewCache.set(parentTipo, views);
		}
		return views.get(childTipo) ?? null;
	};

	// MAIN element permission: the matrix level with PHP's search-mode special
	// grants (thesaurus / metadata tipos / synthetic 'search_<n>' ids → 2). An
	// undefined principal (internal calls, harnesses) stamps 3. The handler's
	// Gate A already denied level 0 for the non-search path.
	const mainLevel =
		principal === undefined
			? 3
			: await resolveComponentContextPermission(
					principal,
					sectionTipo,
					tipo,
					source.section_id as number | string | null | undefined,
					String(mode),
				);

	const entries: StructureContextEntry[] = [];
	const seen = new Set<string>();
	const push = async (entry: {
		tipo: string;
		sectionTipo: string;
		mode: string;
		lang: string;
		permissions: number;
		parent: string | null;
		view: string | null;
		propertiesOverride?: Record<string, unknown>;
	}): Promise<StructureContextEntry | null> => {
		const built = await buildStructureContext({
			tipo: entry.tipo,
			sectionTipo: entry.sectionTipo,
			mode: entry.mode,
			lang: entry.lang,
			permissions: entry.permissions,
			parent: entry.parent,
			view: entry.view,
			propertiesOverride: entry.propertiesOverride,
			// WC-079: a temporal clone ships no component toolbar. This is the
			// get_data door — the one service_tmp_section's children actually use,
			// so the suppression has to be stamped here and not only on the
			// section ddo-map path.
			isTemporal: isTemporalSource(source),
		});
		if (built === null) return null;
		const key = contextKey(built);
		if (seen.has(key)) return null;
		seen.add(key);
		entries.push(built);
		return built;
	};

	// The MAIN component's context carries the REQUESTED view (source.view) — a
	// get_data for a ?view=viewer deep link must ship view:'viewer' so the client
	// instance adopts it (self.view is a getter over context.view) and mounts the
	// dedicated view (e.g. component_image view_viewer_image) instead of the edit
	// view. Hardcoding null here left the viewer window rendering the edit UI.
	const requestedView = typeof source.view === 'string' && source.view !== '' ? source.view : null;
	// The MAIN entry emits from the EFFECTIVE properties: an rqo
	// source.properties override replaces the ontology's (PHP set_properties,
	// dd_core_api read :2305-2308) — properties echo, css, view and
	// request_config all follow the override.
	const mainEntry = await push({
		tipo,
		sectionTipo,
		mode,
		lang,
		permissions: mainLevel,
		parent: sectionTipo,
		view: requestedView,
		propertiesOverride: source.properties ?? undefined,
	});
	// PER-RECORD context options (the resolveContextOptions facet — today
	// component_text_area's original language, PHP component_text_area_json
	// :61-69: the transcription/indexation/lang tools read
	// `options.related_component_lang` to open the component in the interview's
	// own language). Dispatched through the REGISTRY, never a model conditional
	// (S2-24). Stamped HERE because this entry is per-request and per-record
	// (clone-before-stamp: buildStructureContext returns a fresh object; the
	// structural core cache never sees `options`).
	if (mainEntry !== null && String(mode) === 'edit') {
		const sectionId = Number(source.section_id ?? Number.NaN);
		const mainModel = await getModelByTipo(tipo);
		const contextHook = mainModel === null ? undefined : getEmitHook(mainModel);
		if (
			Number.isInteger(sectionId) &&
			sectionId > 0 &&
			contextHook?.resolveContextOptions !== undefined
		) {
			const options = await contextHook.resolveContextOptions({ tipo, sectionTipo, sectionId });
			if (options !== null) {
				mainEntry.options = { ...(mainEntry.options ?? {}), ...options };
			}
		}
	}

	// The get_data context mirrors the element's RUNTIME pagination (PHP
	// syncs the element's sqo before emitting it): the dedalo request_config
	// item's sqo carries the limit the data actually paged with — 9 (ontology
	// sqo_config) / 1 (tool override) / the client-sent value; sqo.offset is
	// NOT stamped (wire-pinned 2026-07-10).
	if (mainEntry !== null && Array.isArray(mainEntry.request_config)) {
		const mainItem = items.find(
			(item) =>
				item.tipo === tipo &&
				typeof (item as { pagination?: { limit?: unknown } }).pagination?.limit === 'number',
		);
		if (mainItem !== undefined) {
			// LOCAL narrowing (relations/request_config/engine_select.ts): the
			// dedalo item when there is one, else the first. NO capability gate —
			// the number stamped here is the limit THIS engine already paged the
			// emitted data with, so the remote service's own paging ability cannot
			// change it; negotiating `capabilities.pagination` would throw an
			// external-only component's whole get_data out of the read path.
			const { selectLocalConfigItem } = await import(
				'../relations/request_config/engine_select.ts'
			);
			const dedaloItem = selectLocalConfigItem(
				mainEntry.request_config as { api_engine?: string; sqo?: Record<string, unknown> }[],
			);
			if (dedaloItem?.sqo !== undefined) {
				dedaloItem.sqo.limit = (
					mainItem as unknown as { pagination: { limit: number } }
				).pagination.limit;
			}
		}
	}
	// component_iri label dataframe (dd560): the list/text render resolves the title
	// frame via get_dataframe, which requires the dataframe's OWN structure context in
	// datum.context (dataframe.js:249 returns null — then a null.render() crash —
	// without it). No dd560 DATA item exists to derive it from, so emit it explicitly,
	// mirroring the request_config slot synthesized in buildStructureContext (PHP
	// class.component_iri::get_properties dd560 injection).
	if ((await getModelByTipo(tipo)) === 'component_iri') {
		// The dd560 label frame is system-managed and always writable through its
		// IRI (PHP component_iri injection carries the caller's edit rights).
		await push({
			tipo: 'dd560',
			sectionTipo,
			mode: 'edit',
			lang,
			permissions: Math.max(mainLevel, 2),
			parent: tipo,
			view: 'line',
		});
	}
	for (const item of items) {
		if (item.tipo === tipo && String(item.section_id) === String(source.section_id ?? '')) {
			continue; // the component's own item
		}
		const itemTipo = String(item.tipo);
		const parentTipo = String(item.from_component_tipo ?? tipo);
		if (!ownerSectionOf.has(itemTipo)) {
			ownerSectionOf.set(itemTipo, String(item.section_tipo));
		}
		await push({
			tipo: itemTipo,
			sectionTipo: String(item.section_tipo),
			mode: String(item.mode),
			lang: String(item.lang),
			// Subdatum inheritance off the MAIN element (PHP get_subdatum
			// :2567-2575): floor-1 through the authorized caller, cap-1 under a
			// read-only caller.
			permissions:
				principal === undefined
					? 3
					: inheritSubdatumPermission(
							await getPermissions(principal, String(item.section_tipo), itemTipo),
							mainLevel,
						),
			parent: parentTipo,
			view: await ddoViewOf(parentTipo, itemTipo),
		});
	}
	return entries;
}
