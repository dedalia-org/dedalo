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
import { type Ddo, SELF_SENTINEL } from '../concepts/ddo.ts';
import { configOwnerOf, type EmitRow } from '../concepts/emit_row.ts';
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
import type { ApiNotice } from '../errors/schema.ts';
import {
	getAncestorSectionTipo,
	getColumnNameByModel,
	getMatrixTableFromTipo,
	getModelByTipo,
	tipoBelongsToSection,
} from '../ontology/resolver.ts';
import type { SlotTarget } from '../relations/dataframe_slots.ts';
import type { ResolveElementInput } from '../relations/element_node.ts';
import { MAX_DDO_DEPTH } from '../relations/element_node.ts';
import {
	type ElementNode,
	ElementNodeRegistry,
	type EmitScope,
} from '../relations/element_registry.ts';
import { emitDataframeItem, expandPortal } from '../relations/relation_core.ts';
import type { RqoRequestConfigItem } from '../relations/request_config/from_rqo.ts';
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
	type ContextConfigSource,
	type StructureContextEntry,
} from '../resolve/structure_context.ts';
import {
	ddoIsAuthorized,
	getPermissions,
	getRecordComponentPermission,
	getSectionPermissions,
	inheritSubdatumPermission,
	metadataComponentTipos,
	type Principal,
	resolveComponentContextPermission,
} from '../security/permissions.ts';
import type { TargetSearchScope } from '../security/writer_chain_scope.ts';
import type { LaneValue, RowLaneState } from '../tm_record/lane_state.ts';
import {
	classifyRelationSnapshot,
	MALFORMED_RELATION_VALUE_ERROR,
} from '../tm_record/relation_snapshot_shape.ts';
import {
	currentTimeMachineScopeSection,
	isTimeMachineRead,
} from './list_definitions/tm_scope_context.ts';
import {
	appendItemContexts,
	type DerivedItemContextOptions,
	NodeContextSet,
	withListPageLimit,
} from './node_contexts.ts';
import { type NodeLevelPolicy, NodePermissionLevels } from './node_permissions.ts';
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
	/**
	 * The notices the read's emission owes its response (relations/
	 * element_registry.ts notices()), present only when there are any. NOT part
	 * of the result payload: the door lifts them onto the envelope's `notices`.
	 */
	notices?: ApiNotice[];
}

/**
 * Full read: context[] + data[]. Context entries: the section first, then one
 * per resolved component ddo, deduplicated by context_key (tipo+section+mode,
 * first occurrence wins — PHP merge_unique_context).
 */
/**
 * What a section read may be handed beyond the rqo and the principal.
 *
 * `targetSearchScope` — a SCOPED TARGET SEARCH (owner decision (h),
 * security/writer_chain_scope.ts): Gate B admitted sqo sections the principal
 * holds no grant on ONLY through a writer component's verified caller chain.
 * On those sections the read's columns are limited to the pairs that
 * component's effective config shows / searches / offers to choose
 * (`columnPairs` — data AND context, judged at every scoped row section),
 * stamped read (1), and the search's filter paths to `filterPairs`
 * (security/read_floor.ts withScopedPairs). Built at the API door, threaded
 * explicitly — never ambient request state.
 */
export interface SectionReadOptions {
	readonly targetSearchScope?: TargetSearchScope;
}

export async function readSection(
	rqo: Rqo,
	principal?: Principal,
	options: SectionReadOptions = {},
): Promise<ReadResult> {
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
		runWithRecordMemo(() => readSectionScoped(rqo, principal, options)),
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

async function readSectionScoped(
	rqo: Rqo,
	principal: Principal | undefined,
	options: SectionReadOptions,
): Promise<ReadResult> {
	// The data half FIRST: its emission registry holds every element node the
	// context below is serialised from (section/node_contexts.ts), and its column
	// map is the ONE map both halves read (never re-derived here).
	const {
		items: data,
		nodes,
		ddoMap: rqoDdoMap,
		stageOneConfig,
	} = await readSectionRowsEmission(rqo, principal, options);
	const scope = sectionReadScope(rqo, principal, nodes, options.targetSearchScope);
	const dataItems = data.filter(
		(item): item is DataItem => (item as { typo?: string }).typo !== 'sections',
	);

	// Sources may OWN the structure-context (the dd15 TM source does — its columns
	// are client-driven, not ontology-derived). When present, skip the generic
	// context building below. The source is keyed by sqo.mode (the TM signal),
	// not source.mode (which stays 'list'/'edit').
	const readSource = await pickReadSource((rqo.sqo as { mode?: string } | undefined)?.mode);
	const contexts = new NodeContextSet(
		nodes,
		await sourceOwnedContexts(readSource, rqo, principal, nodes),
	);
	const sourceOwned = readSource.buildContext !== undefined;
	const sectionEntry = sourceOwned
		? null
		: await appendSectionOwnContexts(contexts, {
				rqo,
				ddoMap: rqoDdoMap,
				stageOneConfig,
				data,
				nodes,
				...scope,
			});

	// SUBDATUM CHILD contexts (PHP get_subdatum merges every element's
	// subcontext into the response): one entry per UNIQUE (tipo, section,
	// mode) among the emitted child items — per occurrence when two parents
	// resolved different configs (owner decision (b)) — each from its node.
	// Without these the client's portal/autocomplete rows have no component
	// structure to render (the empty-chips bug of 2026-07-03). A source that
	// owns its section + column contexts (dd15) still gets these: the dd132
	// username under the dd578 user column renders from them.
	await appendItemContexts(
		contexts,
		dataItems,
		nodes,
		sectionDerivedOptions(contexts.entries, scope.sectionTipo, principal, scope, nodes),
	);
	// PHP traversal order: each column's undeclared subcontexts right after it,
	// before the next column (the column pass above added every column first).
	contexts.orderByTraversal();
	contexts.stampItems(data);
	if (!sourceOwned) {
		finishSectionContexts(contexts.entries, sectionEntry, rqo, rqoDdoMap, stageOneConfig);
	}
	return sectionReadResult(contexts.entries, data, rqo.source ?? {}, nodes);
}

/** The contexts a read source OWNS (dd15), or none (the generic door builds them). */
async function sourceOwnedContexts(
	readSource: Awaited<ReturnType<typeof pickReadSource>>,
	rqo: Rqo,
	principal: Principal | undefined,
	nodes: ElementNodeRegistry,
): Promise<StructureContextEntry[]> {
	if (readSource.buildContext === undefined) return [];
	return readSource.buildContext(rqo, principal ?? SOURCE_CONTEXT_PRINCIPAL, nodes);
}

/**
 * The generic door's last two passes: section_tab children, then the
 * caller-show narrowing of the section entry — only when the entry was NOT
 * built from stage 1 (a stage-1 entry already IS the caller's config; the
 * narrowing serves the get_ddo_map directive and the component-sourced read).
 */
function finishSectionContexts(
	entries: StructureContextEntry[],
	sectionEntry: StructureContextEntry | null,
	rqo: Rqo,
	ddoMap: readonly Ddo[],
	stageOneConfig: readonly RqoRequestConfigItem[] | null,
): void {
	attachSectionTabChildren(entries);
	if (sectionEntry !== null && stageOneConfig === null && hasCallerShow(rqo)) {
		narrowSectionShowToCaller(sectionEntry, ddoMap, entries);
	}
}

/** A source-owned context build with no principal runs as an internal superuser. */
const SOURCE_CONTEXT_PRINCIPAL: Principal = Object.freeze({
	userId: -1,
	isGlobalAdmin: true,
	isDeveloper: false,
}) as Principal;

/** The section door's request scope (the context half matches the data half's normalisation). */
interface SectionReadScope {
	readonly callerTipo: string;
	readonly sectionTipo: string;
	readonly mode: string;
	readonly lang: string;
	readonly principal: Principal | undefined;
	readonly permissionsOf: SectionReadPermissions;
	/**
	 * The PHP subdatum level of every element occurrence of this read
	 * (section/node_permissions.ts — owner decision (d)): a column is stamped
	 * with its own level (permissionsOf.elementPermissions), every nested
	 * element inherits from its IMMEDIATE caller occurrence.
	 */
	readonly levels: NodePermissionLevels;
	/** The scoped target search Gate B admitted (SectionReadOptions), if any. */
	readonly targetSearchScope: TargetSearchScope | undefined;
}

function sectionReadScope(
	rqo: Rqo,
	principal: Principal | undefined,
	nodes: ElementNodeRegistry,
	targetSearchScope: TargetSearchScope | undefined,
): SectionReadScope {
	const source = rqo.source ?? {};
	const callerTipo = source.tipo as string;
	const permissionsOf = sectionReadPermissions(source, callerTipo, principal, targetSearchScope);
	return {
		callerTipo,
		sectionTipo: source.section_tipo ?? callerTipo,
		// Same 'search'→'list' normalization as readSectionRows (the context half
		// must match the data half for the search-panel picker read).
		mode: source.mode === 'search' ? 'list' : (source.mode ?? 'list'),
		// Request-scoped data lang, never a hardcoded install default (S2-28): an
		// RQO that omits lang resolves the session's active data language.
		lang: source.lang ?? currentDataLang(),
		principal,
		permissionsOf,
		targetSearchScope,
		levels: new NodePermissionLevels(nodes, {
			topLevelOf: (node) => permissionsOf.elementPermissions(node.section_tipo, node.tipo),
			ownLevelOf: async (sectionTipo, tipo, sectionId, mode) =>
				principal === undefined
					? 3
					: resolveComponentContextPermission(principal, sectionTipo, tipo, sectionId, mode),
			...scopedRaisePolicy(targetSearchScope),
		}),
	};
}

/**
 * On a read a writer scope opened (owner decision (h)), the subdatum raise
 * reaches the writer component's column pairs ONLY (NodeLevelPolicy.raises):
 * a scoped relation column's OWN-config child on a section outside them keeps
 * the actor's own grant, so a third section the scope never opened is not
 * served on every scoped row (WC-2026-11-04-writer-chain-scoped-search).
 */
function scopedRaise(scope: TargetSearchScope, sectionTipo: string, tipo: string): boolean {
	return scope.columnPairs.has(`${sectionTipo}_${tipo}`);
}

/** The NodeLevelPolicy.raises bound of a scoped read (scopedRaise); nothing without a scope. */
function scopedRaisePolicy(scope: TargetSearchScope | undefined): Pick<NodeLevelPolicy, 'raises'> {
	if (scope === undefined) return {};
	return { raises: (sectionTipo, tipo) => scopedRaise(scope, sectionTipo, tipo) };
}

/**
 * The generic section door's OWN contexts: the section entry, then THE COLUMN
 * PASS — one entry per column-map ddo, each built from the element NODE the
 * data half resolved for it (or resolves now, for a column no row emitted) —
 * never from the raw map with a re-processed narrowing. Returns the section
 * entry (narrowSectionShowToCaller rewrites it last).
 */
async function appendSectionOwnContexts(
	contexts: NodeContextSet,
	pass: SectionColumnPass & { readonly stageOneConfig: readonly RqoRequestConfigItem[] | null },
): Promise<StructureContextEntry | null> {
	const sectionEntry = await buildSectionEntry(pass);
	if (sectionEntry !== null) contexts.addOwn(sectionEntry);
	await appendSectionColumnContexts(contexts, pass);
	return sectionEntry;
}

/**
 * The read's result: its context (session stamp stripped when the read opted
 * out of session navigation) and data, plus the notices the emission owes
 * (refused level >= 2 'self' ddos, stopped record cycles) — which ride OUT of
 * the result: the door puts them on the envelope (read_facade.ts), never
 * inside the result payload.
 */
function sectionReadResult(
	context: StructureContextEntry[],
	data: (SectionsEnvelope | DataItem)[],
	source: NonNullable<Rqo['source']>,
	nodes: ElementNodeRegistry,
): ReadResult {
	const notices = nodes.notices();
	return {
		context: stripSessionSqoStamp(context, source as Record<string, unknown>),
		data,
		...(notices.length > 0 ? { notices } : {}),
	};
}

/**
 * An emitted item's own row id for the per-instance own level
 * (section/node_permissions.ts): a string / number id, else null.
 */
function itemRowId(sectionId: unknown): string | number | null {
	return typeof sectionId === 'string' || typeof sectionId === 'number' ? sectionId : null;
}

/** The per-element permission stamp of one section read (sectionReadPermissions). */
interface SectionReadPermissions {
	/** The read-target consultation-only cap. */
	readonly capForReadTarget: (level: number) => number;
	/** One element's stamped level. */
	readonly elementPermissions: (elementSection: string, elementTipo: string) => Promise<number>;
	/** The section entry's own level. */
	readonly sectionLevel: () => Promise<number>;
}

/**
 * PER-ELEMENT permissions stamp (PHP build_json_rows: each element's context
 * carries get_permissions(section, tipo) — the client renders <1 hidden,
 * ===1 read-only, >1 editable from exactly this field). An undefined
 * principal (internal calls, parity fixture replays) stamps 3; everyone
 * else — global admins included, PHP has no admin bypass — resolves through
 * the matrix (the superuser short-circuits to 3 inside getPermissions).
 *
 * CONSULTATION-ONLY read: when the READ TARGET is a read-only section
 * (Activity dd542, Time Machine dd15, …) cap the whole emitted tree at read
 * (1) AT THE SOURCE — not just the section's own columns (buildStructureContext
 * handles those by section_tipo), but also the cross-section subdatum children
 * a portal pulls in (e.g. the 'Who' column's username dd132, whose own
 * section_tipo is dd128/Users and would otherwise escape the cap and render
 * editable). The derived item contexts thread the same cap.
 *
 * dd128 OWN-USER-RECORD override (PHP component_common::
 * get_component_permissions → resolve_component_read_permission, which EVERY
 * component instance's stamp goes through). It both upgrades the four
 * self-editable components (name/password/email/image → 2, what makes
 * tool_user_admin's self-service editor work for a user whose profile grants
 * nothing on dd128) and downgrades the guarded ones (own security-admin flag
 * → 1 always; profile/developer/username/section_id → 1 for a non-global-admin,
 * the anti-self-elevation half). The save door already consults the same
 * resolver; without it here the read stamp and the write gate disagree.
 *
 * Scoped to ddos of the READ TARGET section: only then is source.section_id
 * the element's own record id. A cross-section COLUMN that happens to be a
 * dd128 component (the Activity 'Who' column's dd132) has no single row at
 * the column level, so its column entry keeps the matrix level; its emitted
 * ITEMS are judged with their own row (section/node_permissions.ts — PHP
 * builds each subdatum instance with its locator's section_id).
 */
function sectionReadPermissions(
	source: NonNullable<Rqo['source']>,
	callerTipo: string,
	principal: Principal | undefined,
	targetSearchScope?: TargetSearchScope,
): SectionReadPermissions {
	const readTargetSection = source.section_tipo ?? callerTipo;
	const capForReadTarget = (level: number): number =>
		level > 1 && isConsultationOnlySection(readTargetSection) ? 1 : level;
	const ownRecordSectionId = source.section_id;
	return {
		capForReadTarget,
		elementPermissions: async (elementSection, elementTipo) => {
			if (principal === undefined) return capForReadTarget(3);
			// A SCOPED column (owner decision (h)): read, raised like every child
			// of the writer component it is shown through (PHP :2564-2571) — and
			// only when that component's config shows it; anything else on an
			// ungranted section stays at its own (zero) level.
			const scoped = scopedColumnLevel(targetSearchScope, elementSection, elementTipo);
			if (scoped !== null) return scoped;
			return capForReadTarget(
				elementSection === readTargetSection
					? await getRecordComponentPermission(
							principal,
							elementSection,
							elementTipo,
							ownRecordSectionId,
						)
					: await getPermissions(principal, elementSection, elementTipo),
			);
		},
		// Section-level ACL (PHP section::get_section_permissions — includes the
		// consultation-only cap); the handler's Gate A/B guarantee ≥ 1 here.
		sectionLevel: async () =>
			principal === undefined
				? capForReadTarget(3)
				: capForReadTarget(await getSectionPermissions(principal, readTargetSection)),
	};
}

/**
 * The READ TARGET section's own entry (the root of the read — OWN_CONTEXT_REASONS
 * 'section-root'). A caller may request a SECTION view (PHP get_view top
 * precedence — the ddo/source-injected view wins over the section_list
 * child's and the model default): the search-panel preset picker requests
 * view:'search_user_presets' so the SAME section (dd623) renders compact HERE
 * while its general menu list (no source.view) keeps the section_list default.
 */
async function buildSectionEntry(entry: {
	readonly rqo: Rqo;
	readonly callerTipo: string;
	readonly mode: string;
	readonly lang: string;
	readonly principal: Principal | undefined;
	readonly permissionsOf: SectionReadPermissions;
	readonly stageOneConfig: readonly RqoRequestConfigItem[] | null;
}): Promise<StructureContextEntry | null> {
	const { rqo, callerTipo, mode, lang, principal, permissionsOf } = entry;
	const source = rqo.source ?? {};
	return buildStructureContext({
		tipo: callerTipo,
		sectionTipo: source.section_tipo ?? callerTipo,
		mode,
		lang,
		view: typeof source.view === 'string' && source.view !== '' ? source.view : null,
		permissions: await permissionsOf.sectionLevel(),
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
		configFrom: sectionEntryConfigFrom(entry.stageOneConfig, await getModelByTipo(callerTipo)),
	});
}

/**
 * Where the read root's request_config comes from:
 *  - STAGE 1 when the client sent a show for a SECTION read target (PHP
 *    build_request_config returns build_request_config_from_rqo's one dedalo
 *    main item and stops, :2964-2975): the consolidated show map the data half
 *    read, the rqo search map, the validated rqo sqo — never the ontology's;
 *  - the section's OWN config otherwise (no client show: the section is the
 *    root map, never an element under a caller);
 *  - a COMPONENT-sourced read's caller entry keeps its own config
 *    ('component-sourced-root').
 */
function sectionEntryConfigFrom(
	stageOneConfig: readonly RqoRequestConfigItem[] | null,
	callerModel: string | null,
): ContextConfigSource {
	if (stageOneConfig !== null) return { source: 'stage1', config: stageOneConfig };
	return callerModel === 'section'
		? { source: 'own', reason: 'section-root' }
		: { source: 'own', reason: 'component-sourced-root' };
}

/** What the section door's column pass reads. */
interface SectionColumnPass {
	readonly rqo: Rqo;
	/** The column map the DATA half emitted (readSectionRowsEmission). */
	readonly ddoMap: readonly Ddo[];
	readonly callerTipo: string;
	readonly sectionTipo: string;
	readonly mode: string;
	readonly lang: string;
	readonly data: readonly unknown[];
	readonly nodes: ElementNodeRegistry;
	readonly principal: Principal | undefined;
	readonly permissionsOf: SectionReadPermissions;
	/** The read's node-chain levels (SectionReadScope.levels). */
	readonly levels: NodePermissionLevels;
	/** The scoped target search Gate B admitted (SectionReadOptions), if any. */
	readonly targetSearchScope: TargetSearchScope | undefined;
}

/**
 * A SCOPED column's level (owner decision (h)): on a section the scope opened,
 * 1 when the writer component's config shows / searches the pair, else 0 —
 * null when the section is not scoped (the ordinary rule applies).
 */
function scopedColumnLevel(
	scope: TargetSearchScope | undefined,
	sectionTipo: string,
	tipo: string,
): number | null {
	if (scope === undefined || !scope.sections.has(sectionTipo)) return null;
	return scope.columnPairs.has(`${sectionTipo}_${tipo}`) ? 1 : 0;
}

/**
 * The column read gate of BOTH halves (PHP check_ddo_permissions): the
 * actor's own grant (ddoIsAuthorized), except on a section a scoped target
 * search opened, where ONLY the writer component's shown pairs pass (owner
 * decision (h) — the scoped rows carry exactly those columns).
 * NOTE: this judges the column at ONE section. The DATA half also judges it at
 * every section the scoped rows come from (scopedRowsReadable), because a row
 * emits every direct ddo from its OWN record whatever section the ddo declares.
 */
async function scopedDdoReadable(
	principal: Principal | undefined,
	scope: TargetSearchScope | undefined,
	sectionTipo: string,
	tipo: string,
): Promise<boolean> {
	const scoped = scopedColumnLevel(scope, sectionTipo, tipo);
	if (scoped !== null) return scoped > 0;
	return ddoIsAuthorized(principal, sectionTipo, tipo);
}

/**
 * THE ROW SIDE of the scoped column gate (owner decision (h)): a row emits
 * every direct ddo of the map from the row's OWN record, reading the
 * component by tipo whatever section the ddo DECLARES (read_source.ts
 * emitRow / emitDdoDataUnbound). So a ddo declaring another section — a
 * rule-granted one (dd1324, dd655) that scopedDdoReadable admits — would
 * still serve the value of a component of a scoped section on every scoped
 * row. Every section the scope opened therefore judges the ddo too: a
 * component that BELONGS to that section must be one of the writer
 * component's column pairs on it. A component of another section reads
 * nothing from that section's records (a multi-target config's per-section
 * columns stay served). No scope = true.
 */
async function scopedRowsReadable(
	scope: TargetSearchScope | undefined,
	tipo: string,
): Promise<boolean> {
	if (scope === undefined) return true;
	for (const rowSection of scope.sections) {
		if (scope.columnPairs.has(`${rowSection}_${tipo}`)) continue;
		if (!(await provablyNotOnScopedRecord(tipo, rowSection))) return false;
	}
	return true;
}

/**
 * The section-info tipos EVERY record stores or answers by tipo whatever
 * section owns it (W4b review): the audit pair dd199/dd200 + dd197/dd201
 * (record_metadata.ts) and the inverse-relations info component dd1596. They
 * do not belong to the scoped section, yet a row emits them from its own record
 * — the filter side already denies them on a scoped section
 * (frontier_scope.ts exclusiveFloorVerdict), the column side agrees.
 */
const RECORD_WIDE_TIPOS: ReadonlySet<string> = new Set([
	...metadataComponentTipos(),
	// DEDALO_SECTION_INFO_INVERSE_RELATIONS (resolve/environment.ts).
	'dd1596',
]);

/**
 * May a ddo outside the writer component's pairs on `rowSection` pass the
 * scoped rows (scopedRowsReadable)? Only when the value it would read is
 * provably NOT on that section's records: the tipo is owned by ANOTHER real
 * section (a multi-target config's per-section column) and is not a
 * record-wide section-info tipo. A tipo whose ancestry reaches no section
 * (the dd196 section-info group's components among them) is refused — its
 * ownership is unknown, so it fails closed.
 */
async function provablyNotOnScopedRecord(tipo: string, rowSection: string): Promise<boolean> {
	if (RECORD_WIDE_TIPOS.has(tipo)) return false;
	if ((await getAncestorSectionTipo(tipo)) === null) return false;
	return !(await tipoBelongsToSection(tipo, rowSection));
}

/** The column pass's read gate (scopedDdoReadable for the pass). */
function columnReadable(pass: SectionColumnPass, sectionTipo: string, tipo: string) {
	return scopedDdoReadable(pass.principal, pass.targetSearchScope, sectionTipo, tipo);
}

/**
 * THE COLUMN PASS of the section door: one context entry per column-map ddo
 * (top-level columns and the nested children the map declares), in map order,
 * each serialised from its element NODE (columnNodeOf).
 */
async function appendSectionColumnContexts(
	contexts: NodeContextSet,
	pass: SectionColumnPass,
): Promise<void> {
	const columnNodes: ColumnNodeMemo = { nodes: new Map(), visiting: new Set() };
	for (const ddo of pass.ddoMap) {
		// A multi-target ddo (a picker whose show map names N target sections, e.g.
		// the epigraphy autocomplete's hierarchy95 over the eight glyph thesauri)
		// is a DIFFERENT ontology element in each of those sections. The client
		// looks its context up by (tipo, section_tipo) of the row it is rendering
		// (view_default_autocomplete.render_grid_choose), so one entry built against
		// the first target silently drops every row from the other seven. Emit one
		// entry per section the read ACTUALLY returned rows from; with no rows to
		// go on (an empty result still ships structure) fall back to the first target.
		for (const ddoSectionTipo of resolveDdoContextSections(ddo, pass.sectionTipo, pass.data)) {
			await appendColumnEntry(contexts, ddo, ddoSectionTipo, pass, columnNodes);
		}
	}
}

/** One column-map ddo's entry at one of its sections (appendSectionColumnContexts). */
async function appendColumnEntry(
	contexts: NodeContextSet,
	ddo: Ddo,
	ddoSectionTipo: string,
	pass: SectionColumnPass,
	columnNodes: ColumnNodeMemo,
): Promise<void> {
	// Per-component READ gate (PHP check_ddo_permissions / STEP 5
	// filter_authorized_related): a denied component contributes NO context
	// entry. This is the confidentiality boundary for CLIENT-SENT maps —
	// the client can name any tipo in show.ddo_map, and the config-build
	// gates only shape the server-derived default.
	if (!(await columnReadable(pass, ddoSectionTipo, ddo.tipo))) return;
	const node = await columnNodeOf(ddo, ddoSectionTipo, pass, columnNodes);
	// A nested COMPONENT whose parent element has no node (its parent is not
	// in the map, or the read gate dropped it) emits no data: no column entry
	// either. An own-config entry here would ship a config no cell used, and
	// absorb the derived pass's node-built entry.
	if (node === ORPHAN_COLUMN) return;
	const entry = await buildColumnEntry(ddo, ddoSectionTipo, node, pass, contexts.entries);
	if (entry === null) return;
	withListPageLimit(entry, node);
	if (!contexts.add(entry, node)) return;
	await stampColumnContextOptions(entry, ddo, ddoSectionTipo, pass);
}

/**
 * The resolved parent of a column ddo: 'self' / undeclared = the caller (a
 * TOP-LEVEL column); anything else names the column's parent element.
 */
function columnParentOf(ddo: Ddo, callerTipo: string): string {
	return ddo.parent === undefined || ddo.parent === SELF_SENTINEL ? callerTipo : ddo.parent;
}

/**
 * A nested COMPONENT column whose parent element resolves to no node (the
 * parent is absent from the map, gate-dropped, or a cycle): it has no
 * occurrence, so it gets no column entry (appendSectionColumnContexts).
 */
const ORPHAN_COLUMN = Symbol('orphan-column');
type ColumnNode = ElementNode | null | typeof ORPHAN_COLUMN;

/**
 * The column pass's node memo: by `tipo@section` and by bare tipo (the first
 * section's node — a nested child looks its parent up by tipo), plus the
 * ddos being resolved (a parent chain that loops resolves to ORPHAN).
 */
interface ColumnNodeMemo {
	readonly nodes: Map<string, ColumnNode>;
	readonly visiting: Set<string>;
}

/**
 * The element NODE of one column-map ddo at `ddoSectionTipo` — the occurrence
 * the data half resolved (the FIRST one, PHP first-wins: element_registry.ts
 * findChild), else resolved now under the same parent (a column no row
 * emitted — an empty page still ships its structure). A TOP-LEVEL column's
 * parent is the read's ROOT map; a NESTED one's is its parent column's node
 * (resolved on demand, WHATEVER the map order — the data side collects
 * children by parent alone), and its governing ddo is that node's line for it
 * (exactly what the data path handed it). null = not an element with a node
 * (a grouper, a button, a child of one); ORPHAN = a component whose parent
 * has no node.
 */
async function columnNodeOf(
	ddo: Ddo,
	ddoSectionTipo: string,
	pass: SectionColumnPass,
	memo: ColumnNodeMemo,
): Promise<ColumnNode> {
	const memoKey = `${ddo.tipo}@${ddoSectionTipo}`;
	const known = memo.nodes.get(memoKey);
	if (known !== undefined) return known;
	if (memo.visiting.has(memoKey)) return ORPHAN_COLUMN;
	memo.visiting.add(memoKey);
	const node = await resolveColumnNode(ddo, ddoSectionTipo, pass, memo);
	memo.visiting.delete(memoKey);
	memo.nodes.set(memoKey, node);
	if (!memo.nodes.has(ddo.tipo)) memo.nodes.set(ddo.tipo, node);
	return node;
}

/**
 * A NESTED column's parent node, by node lookup, never by map order: the
 * memo when the parent was already processed, else the parent ddo's node
 * resolved now at its first READABLE section (a parent the read gate denies
 * at every section has no node — its data is not expanded either). A
 * non-component parent (a grouper) = null.
 */
async function nestedColumnParentNode(
	parentTipo: string,
	pass: SectionColumnPass,
	memo: ColumnNodeMemo,
): Promise<ColumnNode> {
	const known = memo.nodes.get(parentTipo);
	if (known !== undefined) return known;
	const parentDdo = pass.ddoMap.find((candidate) => candidate.tipo === parentTipo);
	// A component parent the map never lists is never expanded by the data
	// side either: its children are orphans. A non-component one (a grouper)
	// has no node by nature.
	if (parentDdo === undefined)
		return (await componentModelOf(parentTipo)) === null ? null : ORPHAN_COLUMN;
	for (const section of resolveDdoContextSections(parentDdo, pass.sectionTipo, pass.data)) {
		if (!(await columnReadable(pass, section, parentDdo.tipo))) continue;
		return columnNodeOf(parentDdo, section, pass, memo);
	}
	return ORPHAN_COLUMN;
}

/** A column's parent node (the read's ROOT map for a top-level column), and whether it is top-level. */
async function columnParentNode(
	ddo: Ddo,
	pass: SectionColumnPass,
	memo: ColumnNodeMemo,
): Promise<{ parentNode: ColumnNode; topLevel: boolean }> {
	const parentTipo = columnParentOf(ddo, pass.callerTipo);
	const topLevel = parentTipo === pass.callerTipo || parentTipo === pass.sectionTipo;
	if (!topLevel)
		return { parentNode: await nestedColumnParentNode(parentTipo, pass, memo), topLevel };
	const { rootNodeFor } = await import('../relations/element_node.ts');
	return {
		parentNode: rootNodeFor(
			pass.nodes,
			pass.callerTipo,
			pass.sectionTipo,
			pass.mode,
			pass.ddoMap as Ddo[],
		),
		topLevel,
	};
}

/**
 * A column's GOVERNING ddo: its own line at the top level; a nested column's
 * is its parent node's line for it — exactly what the data path handed it
 * (relation_core expandPortal: node.children).
 */
function governingColumnDdo(ddo: Ddo, parentNode: ElementNode, topLevel: boolean): Ddo {
	if (topLevel) return ddo;
	const line = parentNode.children.find((child) => child.tipo === ddo.tipo) as unknown as
		| Ddo
		| undefined;
	return line ?? ddo;
}

/**
 * The section a column ddo's READ gate judges it on: its declared section, or
 * the read's (`readSection`) for an undeclared / 'self' one. A multi-target
 * NESTED ddo (sectionColumnDdo keeps its whole section_tipo) is judged on its
 * FIRST target — exactly the section the flattened map handed this gate
 * before; a client map's array likewise.
 */
function ddoGateSection(ddo: Ddo, readSection: string): string {
	const declared = Array.isArray(ddo.section_tipo) ? ddo.section_tipo[0] : ddo.section_tipo;
	return declared === undefined || declared === 'self' ? readSection : declared;
}

/**
 * THE SCOPED read drop over EVERY section a ddo declares (owner decision (h),
 * W4b review) — the scoped path's stand-in for stage 1's strict drop
 * (request_config/from_rqo.ts readableSectionTipoOf), which a scoped search
 * runs without (its actor-less stage 1 must keep the scoped columns the
 * actor's own grant would drop). Each declared section ('self' / undeclared =
 * the read's section) is judged by scopedDdoReadable: a section the scope
 * opened admits only the writer component's shown pairs, every other one the
 * actor's own grant. A multi-section ddo is NARROWED to the sections that
 * pass (a copy — the map's ddo is never mutated); none passing drops it
 * (null). This is what keeps a nested client child declaring ['dd1324', Z]
 * under a scoped relation column from serving Z's values: Z is judged on its
 * own (and dropped), not hidden behind the rule-granted dd1324.
 */
async function scopedDeclaredSections(
	principal: Principal,
	scope: TargetSearchScope,
	ddo: Ddo,
	readSection: string,
): Promise<Ddo | null> {
	const declared = ddo.section_tipo;
	const entries: readonly unknown[] = Array.isArray(declared)
		? declared.length > 0
			? declared
			: [undefined]
		: [declared];
	const kept: string[] = [];
	for (const entry of entries) {
		const judged = declaredSectionOf(entry, readSection);
		if (await scopedDdoReadable(principal, scope, judged, ddo.tipo)) kept.push(String(entry));
	}
	return narrowedDdo(ddo, kept);
}

/**
 * `ddo` narrowed to the `kept` sections of its declared list (a copy), itself
 * when nothing was dropped, null when nothing was kept (scopedDeclaredSections).
 */
function narrowedDdo(ddo: Ddo, kept: readonly string[]): Ddo | null {
	if (kept.length === 0) return null;
	const declared = ddo.section_tipo;
	if (!Array.isArray(declared) || kept.length === declared.length) return ddo;
	return { ...ddo, section_tipo: [...kept] } as Ddo;
}

/** A declared section entry, 'self' / undeclared standing for the read's section (scopedDeclaredSections). */
function declaredSectionOf(entry: unknown, readSection: string): string {
	if (typeof entry !== 'string' || entry === '' || entry === 'self') return readSection;
	return entry;
}

/**
 * The DATA side's per-column READ gate of a section read (readSectionRowsEmission):
 * each ddo is kept when its declared section(s) pass scopedDdoReadable and
 * its rows side passes scopedRowsReadable. A Time Machine read judges every
 * ddo in dd15 (its rows are virtual dd15 records). A SCOPED search's stage 1
 * ran with no actor, so the strict drop that judges EVERY section a ddo
 * declares — and narrows a nested multi-section ddo to its readable ones —
 * did not run; it is re-done here on the scoped rule (scopedDeclaredSections),
 * or a nested client child declaring ['dd1324', Z] would be judged on dd1324
 * alone and serve Z's values under a scoped relation column.
 */
async function authorizedColumnMap(
	principal: Principal,
	scope: TargetSearchScope | undefined,
	ddoMap: readonly Ddo[],
	readSection: string,
	readsTimeMachine: boolean,
): Promise<Ddo[]> {
	const authorized: Ddo[] = [];
	for (const ddo of ddoMap) {
		const gated = await gatedColumnDdo(principal, scope, ddo, readSection, readsTimeMachine);
		if (gated !== null && (await scopedRowsReadable(scope, ddo.tipo))) authorized.push(gated);
	}
	return authorized;
}

/** One ddo through the column gate (authorizedColumnMap): the ddo (narrowed on a scoped read), or null. */
async function gatedColumnDdo(
	principal: Principal,
	scope: TargetSearchScope | undefined,
	ddo: Ddo,
	readSection: string,
	readsTimeMachine: boolean,
): Promise<Ddo | null> {
	if (readsTimeMachine) {
		return (await scopedDdoReadable(principal, scope, TIME_MACHINE_SECTION_TIPO, ddo.tipo))
			? ddo
			: null;
	}
	if (scope !== undefined) return scopedDeclaredSections(principal, scope, ddo, readSection);
	return (await scopedDdoReadable(principal, scope, ddoGateSection(ddo, readSection), ddo.tipo))
		? ddo
		: null;
}

/** Whose map a read's ROOT is: the client's (a sent show map) or the ontology's. */
function rootMapOrigin(rqo: Rqo): 'client' | 'ontology' {
	return clientShowDdoMap(rqo) !== null ? 'client' : 'ontology';
}

/** The element's model when it is a COMPONENT (the elements that have a node), else null. */
async function componentModelOf(tipo: string): Promise<string | null> {
	const model = await getModelByTipo(tipo);
	return model?.startsWith('component_') ? model : null;
}

/** columnNodeOf's resolution (no memo). */
async function resolveColumnNode(
	ddo: Ddo,
	ddoSectionTipo: string,
	pass: SectionColumnPass,
	memo: ColumnNodeMemo,
): Promise<ColumnNode> {
	const model = await componentModelOf(ddo.tipo);
	if (model === null) return null;
	const { parentNode, topLevel } = await columnParentNode(ddo, pass, memo);
	// A component under a non-component parent (a grouper) keeps the own-config
	// entry (no node exists there); under a node-less COMPONENT it is an orphan.
	if (parentNode === null) return null;
	if (parentNode === ORPHAN_COLUMN) return ORPHAN_COLUMN;
	return emittedOrFreshColumnNode(ddo, ddoSectionTipo, parentNode, topLevel, model, pass);
}

/** A column's node under its resolved parent: the emitted occurrence, else resolved now. */
async function emittedOrFreshColumnNode(
	ddo: Ddo,
	ddoSectionTipo: string,
	parentNode: ElementNode,
	topLevel: boolean,
	model: string,
	pass: SectionColumnPass,
): Promise<ElementNode> {
	const governing = governingColumnDdo(ddo, parentNode, topLevel);
	// Nested children render in their declared mode, LIST by default (the data
	// path's portal children default).
	const mode = governing.mode ?? (topLevel ? pass.mode : 'list');
	const emitted = pass.nodes.findChild(parentNode.key, ddo.tipo, ddoSectionTipo, mode);
	return (
		emitted ?? resolveFreshColumnNode(ddo, governing, parentNode, ddoSectionTipo, mode, model, pass)
	);
}

/** A column node no row emitted (an empty page still ships its structure): resolved now. */
async function resolveFreshColumnNode(
	ddo: Ddo,
	governing: Ddo,
	parentNode: ElementNode,
	ddoSectionTipo: string,
	mode: string,
	model: string,
	pass: SectionColumnPass,
): Promise<ElementNode> {
	const { elementLang } = await import('../ontology/resolver.ts');
	const { resolveElement } = await import('../relations/element_node.ts');
	const requested = ddo.lang ?? null;
	return resolveElement({
		ddo: governing,
		parentNode,
		ownerSectionTipo: ddoSectionTipo,
		mode,
		lang: await elementLang(ddo.tipo, model, { requested, ambient: pass.lang }),
		configLang: requested ?? pass.lang,
		registry: pass.nodes,
		model,
	});
}

/**
 * A NESTED column (parent is a component, not the section) is a subdatum: its
 * sort join must start at the LISTED section, so hand its parent-portal to
 * buildOrderPath for the prepend (PHP get_order_path from_component/from_section).
 */
function columnOrderPathFrom(
	resolvedParent: string | null,
	pass: SectionColumnPass,
	entries: readonly StructureContextEntry[],
): { componentTipo: string; sectionTipo: string } | undefined {
	if (resolvedParent === null || resolvedParent === pass.callerTipo) return undefined;
	const parentEntry = entries.find((existing) => existing.tipo === resolvedParent);
	return {
		componentTipo: resolvedParent,
		sectionTipo: parentEntry?.section_tipo ?? pass.sectionTipo,
	};
}

/** A column ddo's declared per-occurrence fields, defaulted from the pass. */
function columnDeclaredFields(ddo: Ddo, pass: SectionColumnPass) {
	return {
		mode: ddo.mode ?? pass.mode,
		lang: ddo.lang ?? pass.lang,
		// Only a DECLARED ddo lang is an explicit ask; the section read's
		// own `lang` is the ambient page data lang, which must never make
		// the edit form build a transliterable in a version (elementLang).
		requestedLang: ddo.lang ?? null,
		view: ddo.view ?? null,
		childrenView: (ddo as { children_view?: string | null }).children_view ?? null,
	};
}

/** One column entry (appendSectionColumnContexts), from its node when it has one. */
async function buildColumnEntry(
	ddo: Ddo,
	ddoSectionTipo: string,
	node: ElementNode | null,
	pass: SectionColumnPass,
	entries: readonly StructureContextEntry[],
): Promise<StructureContextEntry | null> {
	const resolvedParent = ddo.parent === 'self' ? pass.callerTipo : (ddo.parent ?? null);
	return buildStructureContext({
		tipo: ddo.tipo,
		sectionTipo: ddoSectionTipo,
		...columnDeclaredFields(ddo, pass),
		// The entry declares the mode of the node it serialises: a NESTED column
		// whose map line names no mode resolves (and its data emits) in 'list',
		// whatever the read's mode — an '_edit' key over a list-mode config would
		// be a context no cell binds to.
		...(node !== null ? { mode: node.mode } : {}),
		// Per-element level (the ddoIsAuthorized drop guarantees ≥ 1 for defined
		// principals — the client renders 1 read-only, ≥2 edit): a TOP-LEVEL
		// column's own matrix level; a NESTED declared column (its parent is a
		// component of the map) inherits from that parent occurrence's computed
		// level (PHP get_subdatum :2564-2571 — a read-only parent caps it at 1;
		// owner decision (d), section/node_permissions.ts).
		permissions: await columnPermissions(ddo, ddoSectionTipo, node, pass),
		parent: resolvedParent,
		orderPathFrom: columnOrderPathFrom(resolvedParent, pass, entries),
		// WC-079: a temporal clone ships no component toolbar.
		isTemporal: isTemporalSource(pass.rqo.source ?? {}),
		configFrom:
			node !== null
				? { source: 'emission', node }
				: { source: 'own', reason: 'non-component-element' },
	});
}

/**
 * A column entry's stamped level (buildColumnEntry): the node chain's when the
 * column has a node (section/node_permissions.ts — its section is the entry's,
 * a multi-target column is stamped per section), else the column's own level.
 */
async function columnPermissions(
	ddo: Ddo,
	ddoSectionTipo: string,
	node: ElementNode | null,
	pass: SectionColumnPass,
): Promise<number> {
	if (node === null || pass.principal === undefined || pass.levels.isTop(node)) {
		return pass.permissionsOf.elementPermissions(ddoSectionTipo, ddo.tipo);
	}
	const level = await pass.levels.itemLevel(node, ddoSectionTipo, ddo.tipo);
	return pass.permissionsOf.capForReadTarget(level ?? 3);
}

/**
 * PER-RECORD context options for section EDIT views (the same
 * resolveContextOptions facet buildGetDataContext dispatches on the
 * tool/get_data route — see there for the full why; registry dispatch,
 * never a model conditional, S2-24). The context is deduped by
 * contextKey across the read's rows, so this is first-record-wins —
 * exactly PHP merge_unique_context, which kept the first component
 * context it built.
 */
async function stampColumnContextOptions(
	entry: StructureContextEntry,
	ddo: Ddo,
	ddoSectionTipo: string,
	pass: SectionColumnPass,
): Promise<void> {
	if ((entry.mode ?? pass.mode) !== 'edit') return;
	const firstRow = pass.data.find((item) => (item as { typo?: string }).typo === 'sections') as
		| { section_id?: unknown }
		| undefined;
	mergeContextOptions(
		entry,
		await recordContextOptions(ddo.tipo, ddoSectionTipo, positiveRecordId(firstRow?.section_id)),
	);
}

/** A positive integer record id, else null (a search/temporal id has no record options). */
function positiveRecordId(value: unknown): number | null {
	const id = Number(value ?? Number.NaN);
	return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * The model's per-record context options (the resolveContextOptions emit-hook
 * facet — registry dispatch, never a model conditional, S2-24), or null.
 */
async function recordContextOptions(
	tipo: string,
	sectionTipo: string,
	sectionId: number | null,
): Promise<Record<string, unknown> | null> {
	if (sectionId === null) return null;
	const model = await getModelByTipo(tipo);
	const contextHook = model === null ? undefined : getEmitHook(model);
	if (contextHook?.resolveContextOptions === undefined) return null;
	return contextHook.resolveContextOptions({ tipo, sectionTipo, sectionId });
}

/** Merge per-record options into a (fresh, per-call) context entry. */
function mergeContextOptions(
	entry: StructureContextEntry,
	options: Record<string, unknown> | null,
): void {
	if (options !== null) entry.options = { ...(entry.options ?? {}), ...options };
}

/**
 * The section door's DERIVED item rules (appendItemContexts): an item with no
 * creating component is the column's own (already covered); the subdatum
 * permission inheritance (PHP get_subdatum, class.common.php :2564-2571 —
 * owner decision (d), section/node_permissions.ts): the child's own matrix
 * level, floored to read through its component caller (portal targets stay
 * visible without a target-section grant) and capped at read under a
 * read-only caller, judged against the IMMEDIATE caller OCCURRENCE's computed
 * level (the item's node chain — never the first context entry of the parent
 * tipo, which owner decision (b) made ambiguous), then the read-target
 * consultation-only cap; the sort join of a subdatum starts at the LISTED
 * section (the parent portal's own section when its entry is built, else the
 * listed section).
 */
function sectionDerivedOptions(
	entries: readonly StructureContextEntry[],
	sectionTipo: string,
	principal: Principal | undefined,
	scope: Pick<SectionReadScope, 'permissionsOf' | 'levels' | 'targetSearchScope'>,
	nodes: ElementNodeRegistry,
): DerivedItemContextOptions {
	const { permissionsOf, levels, targetSearchScope } = scope;
	const parentEntryOf = (parentTipo: string) =>
		entries.find((existing) => existing.tipo === parentTipo);
	return {
		isOwnItem: (item) => String(item.from_component_tipo ?? item.tipo) === String(item.tipo),
		fallbackParent: (item) => String(item.tipo),
		permissionsOf: async (item, parentTipo) => {
			if (principal === undefined) return permissionsOf.capForReadTarget(3);
			const chained = await levels.itemLevel(
				nodes.nodeOfItem(item),
				String(item.section_tipo),
				String(item.tipo),
				itemRowId(item.section_id),
			);
			// An item no emitter bound (defensive — every emitter binds today):
			// the parent tipo's first entry stands in for the caller occurrence.
			const level =
				chained ??
				(await unboundItemLevel(
					principal,
					item,
					parentEntryOf(parentTipo)?.permissions ?? 3,
					targetSearchScope,
				));
			return permissionsOf.capForReadTarget(level);
		},
		orderPathFrom: (parentTipo) => ({
			componentTipo: parentTipo,
			sectionTipo: parentEntryOf(parentTipo)?.section_tipo ?? sectionTipo,
		}),
	};
}

/**
 * The level of an item no emitter bound (sectionDerivedOptions): its own grant
 * inherited from the parent tipo's first entry — the raise bounded on a scoped
 * read exactly as NodeLevelPolicy.raises bounds it (scopedRaise).
 */
async function unboundItemLevel(
	principal: Principal,
	item: { readonly section_tipo?: unknown; readonly tipo?: unknown },
	callerLevel: number,
	scope: TargetSearchScope | undefined,
): Promise<number> {
	const sectionTipo = String(item.section_tipo);
	const tipo = String(item.tipo);
	const own = await getPermissions(principal, sectionTipo, tipo);
	if (own < 1 && scope !== undefined && !scopedRaise(scope, sectionTipo, tipo)) return 0;
	return inheritSubdatumPermission(own, callerLevel);
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
	// A multi-target ddo binds its column by its FIRST target (the flattened
	// shape this lookup always saw).
	const ddoSection = selfOr(
		Array.isArray(ddo.section_tipo) ? ddo.section_tipo[0] : ddo.section_tipo,
		sectionEntry.section_tipo,
	);
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

/**
 * What a data PRODUCER answers: the data items AND the element nodes the
 * emission resolved (relations/element_registry.ts) — the one effective config
 * per element occurrence the context is serialised from, and the notices the
 * read owes its response (`nodes.notices()`: refused level >= 2 'self' ddos,
 * stopped record cycles).
 */
export interface ProducedData {
	readonly items: DataItem[];
	readonly nodes: ElementNodeRegistry;
	/**
	 * The TARGETED element's own node — the one its data was emitted from (the
	 * portal get_data and resolve_data hand it to expandPortal; a literal, the
	 * select/filter family and relation_index PIN it before emitting,
	 * pinGetDataTarget): the main context entry is serialised from it
	 * (buildGetDataContext) — its stage-1 config when the rqo carried a show.
	 * Absent only for an answer that emitted no element (an empty shell, a bare
	 * item): the context door resolves it then (resolveGetDataMainNode).
	 */
	readonly mainNode?: ElementNode;
}

/** A producer answer that resolved no element (an empty shell, a bare item). */
function bareData(items: DataItem[]): ProducedData {
	return { items, nodes: new ElementNodeRegistry() };
}

/** A producer answer whose targeted element resolved `mainNode` (or none). */
function producedFrom(
	items: DataItem[],
	nodes: ElementNodeRegistry,
	mainNode: ElementNode | null,
): ProducedData {
	return { items, nodes, ...(mainNode !== null ? { mainNode } : {}) };
}

/**
 * Run a producer that fills a registry it is handed, with the rqo's TARGET
 * node pinned in it first (pinGetDataTarget) — `governing` is the ddo fields
 * the producer emits the target with (its page `limit`).
 */
async function producedWithTarget(
	rqo: Rqo,
	governing: GetDataGoverning,
	produce: (nodes: ElementNodeRegistry) => Promise<DataItem[]>,
): Promise<ProducedData> {
	const nodes = new ElementNodeRegistry();
	const mainNode = await pinGetDataTarget(rqo, nodes, governing);
	return producedFrom(await produce(nodes), nodes, mainNode);
}

/**
 * Resolve the get_data TARGET's node ONCE — in the read's real mode, over the
 * rqo `source.properties` override, STAGE 1 when the rqo carries a show
 * (resolveGetDataMainNode) — and PIN it in the producer's registry
 * (element_registry.ts setTarget), so the producer's top-level emission of the
 * target answers this very node (element_node.ts resolveEmittedElement). The
 * returned node is the producer's `mainNode`: its data children and its main
 * context entry are one projection — a literal's frames, the select/filter
 * family's item and relation_index's own-config children no longer follow the
 * own config while the context ships the client's show.
 */
async function pinGetDataTarget(
	rqo: Rqo,
	nodes: ElementNodeRegistry,
	governing: GetDataGoverning = {},
): Promise<ElementNode | null> {
	const { currentPrincipal } = await import('../security/request_context.ts');
	const node = await resolveGetDataMainNode(rqo, nodes, currentPrincipal(), governing);
	if (node !== null) nodes.setTarget(node);
	return node;
}

/** A component get_data's items (readComponentDataEmission without its nodes). */
export async function readComponentData(rqo: Rqo): Promise<DataItem[]> {
	return (await readComponentDataEmission(rqo)).items;
}

/**
 * A component get_data — items AND nodes (ProducedData). The doors that build a
 * context or owe notices call this one; readComponentData is the items-only
 * convenience.
 */
export async function readComponentDataEmission(rqo: Rqo): Promise<ProducedData> {
	const refusal: TmPreviewRefusal = { reason: null };
	const produced = await readComponentDataUnflagged(rqo, refusal);
	return {
		items: flagRefusedPreview(produced.items, String(rqo.source?.tipo ?? ''), refusal.reason),
		nodes: produced.nodes,
		...(produced.mainNode !== undefined ? { mainNode: produced.mainNode } : {}),
	};
}

/**
 * A component read's EXPLICITLY requested lang: its own non-empty
 * `source.lang`, else null — an omitted one leaves the instance-lang rule
 * (resolver.ts elementLang) to pick the default, never the ambient lang posing
 * as an ask.
 */
function explicitSourceLang(source: { lang?: unknown }): string | null {
	return typeof source.lang === 'string' && source.lang !== '' ? source.lang : null;
}

/** The ddo `lang` field of that ask: present only when the caller sent one (explicitSourceLang). */
function explicitLangField(source: { lang?: unknown }): { lang?: string } {
	const lang = explicitSourceLang(source);
	return lang === null ? {} : { lang };
}

/** readComponentData's body; a refused TM preview row is recorded in `refusal`. */
async function readComponentDataUnflagged(
	rqo: Rqo,
	refusal: TmPreviewRefusal,
): Promise<ProducedData> {
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
	if (preview.served === false) return bareData([]);
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
			if (shell === null) return bareData([]); // PHP empty shell
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
		// The literal's node (and its frames' governing lines) IS the main
		// context entry's: pinned before the emission (pinGetDataTarget).
		const literalNode = await pinGetDataTarget(rqo, literalEmission.nodes);
		// The ddo carries the lang ONLY when the caller sent one: a component
		// read's own `source.lang` is an EXPLICIT ask (the tool_lang target
		// building rsc85-like transliterables in lg-spa — resolver.ts
		// elementLang), while an omitted one leaves the instance-lang rule to
		// pick the default (the ambient lang for a translatable, the lg-nolan
		// base otherwise). Stamping the ambient default here would make every
		// lang-less read look explicit.
		await emitDdoData(
			{
				tipo,
				section_tipo: sectionTipo,
				mode: literalMode,
				...explicitLangField(source),
			} as Ddo,
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
		return producedFrom(literalData as DataItem[], literalEmission.nodes, literalNode);
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
		// The index element's node — governed by this page's limit, exactly the
		// ddo its own-config portal expansion emits — pinned before the emission,
		// so the own-config children and the main context entry are ONE node.
		return producedWithTarget(rqo, { limit }, (nodes) =>
			readRelationIndexData(
				tipo,
				sectionTipo,
				String(sectionId),
				limit,
				sqoOffset,
				currentDataLang(),
				emitDdoData,
				source.mode ?? 'edit',
				nodes,
			),
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
			return bareData([emptyItem]);
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
				return bareData([buildDataItem(tipo, sectionTipo, sectionId, 'search', lang, [])]);
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
					return bareData([
						buildDataItem(tipo, sectionTipo, sectionId, source.mode ?? 'edit', lang, []),
					]);
				}
				const { makeVirtualRecord } = await import('../section_record/virtual_record.ts');
				record = makeVirtualRecord(sectionTipo, Number(sectionId));
				await graftScratch(record);
			} else {
				return bareData([]);
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
		const familyNode = await pinGetDataTarget(rqo, familyEmission.nodes);
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
		return producedFrom(familyData as DataItem[], familyEmission.nodes, familyNode);
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
				return bareData([emptyItem]);
			}
		}
	}

	// THE ELEMENT'S NODE (relations/element_node.ts resolveElement) — its ONE
	// effective config, the same one its context reads:
	//  - STAGE 1 when this rqo carries a `show` (request_config/from_rqo.ts —
	//    validated, consolidated, grant-judged client ddos; PHP
	//    build_request_config_from_rqo). The portal paginator sends none
	//    (add_show=false), so paging resolves the element's own map;
	//  - otherwise its OWN config through the one base resolver
	//    (request_config/own_config.ts): an rqo `source.properties` OVERRIDE
	//    replaces the ontology properties (PHP dd_core_api read :2305-2308 —
	//    TOOL component instances read with their ddo_map-declared properties,
	//    so the child map, the external sqo and the page size all derive from
	//    the override: the epigraphy coins portal pages by the override's
	//    sqo_config.limit 1, not the ontology's 9, wire-pinned 2026-07-10), else
	//    the alias-merged properties (WC-020).
	// The mode is the READ's real mode (`source.mode ?? 'edit'` — exactly the
	// main context entry's, buildGetDataContext), so a LIST get_data (a list
	// cell's paginator) resolves the section_list config its context declares
	// and page 2 expands the same children the section read's list cell did
	// (models/portal.ts resolves that cell in its real mode too). The emitted
	// items keep their pinned 'edit' expansion below — only the CONFIG follows
	// the mode. A top-level read has no caller: nothing is injected.
	const { occurrenceKey, resolveElement } = await import('../relations/element_node.ts');
	const { currentPrincipal: principalOfRequest } = await import('../security/request_context.ts');
	const propertiesOverride = source.properties ?? undefined;
	const portalRoot = await tmPreviewEmission(preview, record);
	const emission = portalRoot.emission;
	const data = emission.items;
	const nodeMode = source.mode ?? 'edit';
	const node = await resolveElement({
		ddo: { tipo, section_tipo: sectionTipo, parent: 'self', mode: nodeMode } as Ddo,
		parentNode: await getDataCallerNode(rqo, emission.nodes, principalOfRequest(), lang),
		ownerSectionTipo: sectionTipo,
		ownerSectionId: sectionId,
		mode: nodeMode,
		lang,
		registry: emission.nodes,
		model,
		...(propertiesOverride !== undefined ? { propertiesOverride } : {}),
		rqo,
		principal: principalOfRequest(),
	});

	// PHP page-size precedence (calculate_default_limit + the element's
	// pagination sync, wire-pinned 2026-07-10): the client's sqo.limit wins;
	// else the component's EFFECTIVE config limit (sqo.limit ??
	// show.sqo_config.limit, LAST config item wins — same chain as
	// relation_core's ownEditLimit); else the clamped mode default above.
	const configuredLimit = rawLimit == null ? await getDataConfigLimit(node) : null;
	const effectiveLimit = configuredLimit ?? limit;
	// EVERY config item's children, not just the first one's (PHP full_ddo_map,
	// class.common.php:2312) — the node's direct children through the ONE
	// mapper shared with the section read (config_ddo_map.ts
	// configChildRenderFields). It keeps the DECLARED section list INTACT (a
	// picked fr1 term under rsc92's hierarchy25 [es1,fr1,…] must match the
	// per-locator grouping — found live 2026-07-09), carries the child `limit`
	// (numisdata965 → numisdata9 limit 4 on every refresh / save echo / page) and
	// a second source's columns (rsc368: dedalo + zenon).
	const childDdos = node.children as unknown as Ddo[];

	// Portal ddo: paginate the locators by the rqo sqo (get_data pages fully).
	// tmAsOf: a TM preview's frame children read as of the row
	// (WC-2026-09-29-tm-preview-frame-children-as-of), rooted at this record
	// (the emission above, whose registry holds the node).
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
		// read, where the outer record re-stamp applies. The node's children are
		// the component's OWN config (nothing injects into a top-level read),
		// which keeps the autocomplete_hi ddinfo breadcrumb in its BARE get_data
		// shape (the save echo depends on it — the picked chip renders its
		// thesaurus chain without a reload; byte-diffed vs the oracle,
		// 2026-07-09). A stage-1 (client show) config is not the own config.
		{
			node,
			path: [occurrenceKey({ section_tipo: sectionTipo, section_id: Number(sectionId) }, tipo)],
			offset: sqoOffset,
			// The TEMPORARY header-click order (sqo.view_order, wire-validated by
			// sqoSchema — WC-2026-10-31-portal-order-model): the full list ordered
			// before this page is cut; paginated_key stays the stored index.
			viewOrder: rqo.sqo?.view_order,
			childRowFromTarget: true,
			childrenFromOwnConfig: node.configSource === 'own' && !node.dataChildrenInjected,
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
	return { items: data as DataItem[], nodes: emission.nodes, mainNode: node };
}

/**
 * resolve_data (PHP dd_core_api read case 'resolve_data'): a component in
 * SEARCH mode resolves INJECTED locators (rqo.source.value) instead of a
 * stored record value — the portal filter chips. The main item carries the
 * injected entries (id-stamped, mode 'search', null record identity) and the
 * children resolve each locator's TARGET record through the component's own
 * child ddos, stamped with the target's raw section_id.
 */
/** resolve_data's items (resolveSearchDataEmission without its nodes). */
export async function resolveSearchData(rqo: Rqo, principal?: Principal): Promise<DataItem[]> {
	return (await resolveSearchDataEmission(rqo, principal)).items;
}

/** resolve_data — items AND nodes (ProducedData). */
export async function resolveSearchDataEmission(
	rqo: Rqo,
	principal?: Principal,
): Promise<ProducedData> {
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

	// THE ELEMENT'S NODE (relations/element_node.ts resolveElement), mode
	// 'search': its own config through the one base resolver (the alias-merged
	// properties — WC-020 — through the RELATIONS-driven builder; reading the
	// component's raw `source.request_config` missed the display children of a
	// section component whose target display is section/relation-defined: dd543
	// "Who" carries only `show_interface`, so its chip rendered blank —
	// reported 2026-07-17), or stage 1 when the rqo carries a show. Its
	// children are show + hide of that config, like every other door (PHP
	// get_subdatum full_ddo_map) — they were show-only here.
	const { getTranslatableByTipo, getModelByTipo: modelOf } = await import(
		'../ontology/resolver.ts'
	);
	const { occurrenceKey, resolveElement } = await import('../relations/element_node.ts');
	const searchEmission = new EmissionContext();
	const data = searchEmission.items;
	const node = await resolveElement({
		ddo: { tipo, section_tipo: sectionTipo, parent: 'self', mode: 'search' } as Ddo,
		parentNode: await getDataCallerNode(rqo, searchEmission.nodes, principal, lang),
		ownerSectionTipo: sectionTipo,
		mode: 'search',
		lang,
		registry: searchEmission.nodes,
		model,
		rqo,
		principal,
	});
	// Dataframe ddos are NOT per-target children — they pair with the MAIN
	// item's entries (id_key) and are emitted separately below.
	const dataframeDdos: Ddo[] = [];
	const childDdos: Ddo[] = [];
	for (const child of node.children as unknown as Ddo[]) {
		if ((await modelOf(child.tipo)) === 'component_dataframe') {
			dataframeDdos.push(child);
			continue;
		}
		// PHP instantiates each child with its INSTANCE lang: the request lang
		// for translatable components, lg-nolan otherwise.
		const childLang = (await getTranslatableByTipo(child.tipo)) ? lang : 'lg-nolan';
		childDdos.push({ ...child, lang: child.lang ?? childLang } as Ddo);
	}

	// Synthetic record carrying ONLY the injected locators (via the substitution
	// API — the model routes to its column and the byte twin is voided).
	const { makeVirtualRecord, injectComponentData } = await import('../section_record/index.ts');
	const syntheticRecord = makeVirtualRecord(sectionTipo, 0);
	injectComponentData(syntheticRecord, tipo, model, injected);

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
		{
			node,
			path: [occurrenceKey({ section_tipo: sectionTipo, section_id: 0 }, tipo)],
			childRowFromTarget: true,
			stampParentSectionId: true,
		},
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
		if (injected.length === 0) continue;
		// THE FRAME'S NODE under the search node (the same occurrence the frame's
		// child line came from: own, caller-injected or stage 1), in the mode the
		// synthesized items carry — each item is BOUND to it, so its context is
		// serialised from that node like every other emitted item
		// (node_contexts.ts), never rebuilt from the frame's own definition.
		const frameNode = await resolveElement({
			ddo: dataframeDdo,
			parentNode: node,
			ownerSectionTipo: sectionTipo,
			mode: 'list',
			lang: 'lg-nolan',
			registry: searchEmission.nodes,
			model: 'component_dataframe',
		});
		for (let index = 0; index < injected.length; index++) {
			const idKey = index + 1;
			const frameItem = {
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
			} as unknown as DataItem;
			searchEmission.nodes.bindItem(frameItem, frameNode);
			data.push(frameItem);
		}
	}
	return { items: data as DataItem[], nodes: searchEmission.nodes, mainNode: node };
}

/**
 * The page size a get_data's node CONFIGURES, or null. LIST: the list cell's
 * own rule (element_node.ts nodeListPageLimit — the governing limit, else the
 * local item's show.sqo_config.limit ?? sqo.limit), so page 2 of a list cell
 * pages exactly like the section read's page 1 did (owner decision (a): a
 * component resolves the same way on every page). Otherwise the edit chain:
 * sqo.limit ?? show.sqo_config.limit, LAST config item wins — the same chain
 * as relation_core's ownEditLimit.
 */
async function getDataConfigLimit(node: ElementNode): Promise<number | null> {
	if (node.mode === 'list') {
		const { nodeListPageLimit } = await import('../relations/element_node.ts');
		return nodeListPageLimit(node);
	}
	let configured: number | null = null;
	for (const item of node.effectiveConfig) {
		const candidate =
			(item.sqo as { limit?: unknown } | undefined)?.limit ??
			((item.show?.sqo_config as { limit?: unknown } | undefined)?.limit as unknown);
		if (typeof candidate === 'number' && candidate > 0) configured = candidate;
	}
	return configured;
}

/**
 * The mode a literal main's ddo_map DECLARES for one of its frames, or
 * undefined when it declares none (section/read.ts emitDdoData, literal frames).
 *
 * The literal's OWN show line is read RAW (section_list.ts resolveOwnConfigMap):
 * the config builder stamps 'list' on every undeclared child mode of a
 * non-section owner (explicit.ts processSingleDdo step 7), so in the processed
 * governing ddo a declared "mode":"list" and an undeclared mode look the same —
 * reading the processed one either lost the declared 'list' to the frame
 * node's properties.mode (a dd560-shaped frame rendered in edit) or let an
 * undeclared one mask that property. A line the CALLER supplied (an injected
 * show, a caller-only or stage-1 config) is taken as given — the caller's map
 * IS the declaration, as on a relation main (relation_core `childDdo.mode`).
 */
async function declaredFrameMode(
	literalNode: ElementNode,
	literalTipo: string,
	frameTipo: string,
	governing: Readonly<Record<string, unknown>> | undefined,
): Promise<string | undefined> {
	const ownShow = literalNode.configSource === 'own' && !literalNode.injectedSlots.includes('show');
	if (!ownShow) return typeof governing?.mode === 'string' ? governing.mode : undefined;
	const { resolveOwnConfigMap } = await import('./list_definitions/section_list.ts');
	const declared = ((await resolveOwnConfigMap(literalTipo)).rawDdos ?? []).find(
		(raw) => raw.tipo === frameTipo,
	);
	return typeof declared?.mode === 'string' ? declared.mode : undefined;
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
	/**
	 * The response's notice sink (owner decision (c)): a level >= 2 'self' ddo
	 * the build refuses in the section's OWN map is named here as
	 * `ontology.ddo_self_refused` (owner = the section), exactly like a
	 * component-owned map (own_config.ts). Only a door that HAS a response to
	 * carry it passes one (readSectionRowsEmission); a door without one (the TM
	 * scope, the chain verifier, the area boot) keeps the bounded log line.
	 */
	notices?: ApiNotice[],
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
			...(notices !== undefined ? { notices } : {}),
		},
	);
	const showDdos = config[0]?.show?.ddo_map ?? [];
	return showDdos.map((ddo) =>
		sectionColumnDdo(ddo as unknown as Record<string, unknown>, sectionTipo),
	);
}

/**
 * The governing fields a server-derived section column map carries per ddo,
 * beyond tipo / section_tipo / parent / mode / lang / view — what the read's
 * ROOT node hands each element (relations/element_node.ts rootNodeFor →
 * resolveElement / collectCallerChildren). PHP get_subdatum hands the
 * PROCESSED ddo whole: its `limit` is the element's page size
 * (class.common.php:2592-2596), its `value_with_parents` the ddinfo trigger,
 * and the caller injection (:2603-2681) copies the caller's ddos verbatim.
 * Dropping them here (the pre-2026-11 shape) silently lost a section-declared
 * column limit and every section-declared nested child's limit / ddinfo
 * trigger at the default door (a client read with add_show=false).
 */
const SECTION_COLUMN_GOVERNING_FIELDS = [
	'limit',
	'value_with_parents',
	'properties',
	'permissions',
	'parent_grouper',
] as const;

/**
 * ONE ddo of a server-derived section column map (deriveSectionDdoMap, the
 * get_ddo_map directive). The section_tipo is flattened to its FIRST entry
 * only for a TOP-LEVEL column (parent = the section / 'self' / undeclared):
 * the read loop and the per-row gates bind a column to one section. A NESTED
 * child keeps its whole section_tipo — it reaches the column portal through
 * the caller injection, whose per-locator grouping matches by membership
 * (relation_core ddoTargetsSection): [es1, fr1] cut to es1 dropped the child
 * at every fr1 target.
 */
function sectionColumnDdo(
	ddo: Record<string, unknown>,
	sectionTipo: string,
	callerTipo: string = sectionTipo,
): Ddo {
	const parent = ddo.parent as string | undefined;
	// undefined / 'self' / the section / the caller: a TOP-LEVEL column.
	const topLevel = [undefined, SELF_SENTINEL, sectionTipo, callerTipo].includes(parent);
	const declaredSection = ddo.section_tipo as string | string[] | undefined;
	const column: Record<string, unknown> = {
		tipo: ddo.tipo,
		// The read loop resolves direct children against each row's
		// section; keep the ddo's own section_tipo for cross-section ddos.
		section_tipo: topLevel && Array.isArray(declaredSection) ? declaredSection[0] : declaredSection,
		parent,
		mode: ddo.mode as string | undefined,
		lang: ddo.lang as string | undefined,
		// view drives the client's per-cell renderer choice (e.g. the
		// publication toggle needs view 'line') — must survive derivation.
		view: ddo.view as string | undefined,
	};
	for (const field of SECTION_COLUMN_GOVERNING_FIELDS) {
		if (ddo[field] !== undefined) column[field] = ddo[field];
	}
	return column as unknown as Ddo;
}

/**
 * The rqo's own show.ddo_map when it carries a non-empty one (the CLIENT
 * literal resolveSectionColumnDdoMap returns verbatim), else `null` — the one
 * test both that function and the descendant walk's origin use, so the two
 * cannot disagree about whose map it is.
 */
function clientShowDdoMap(rqo: Rqo): Ddo[] | null {
	const literal = rqo.show?.ddo_map;
	return Array.isArray(literal) && literal.length > 0 ? literal : null;
}

/**
 * The CLIENT's literal show.ddo_map for a SECTION read, through STAGE 1 (PHP
 * build_request_config_from_rqo :3056-3131 — relations/request_config/
 * from_rqo.ts): every ddo validated (an object, a known tipo, an installed
 * TLD), consolidated on a clone ('self' parent → the section, 'self'
 * section_tipo → the section, label / mode filled, `model` the server's,
 * `permissions` dropped, a `limit` clamped) and read-judged for the actor (a
 * SECTION element's strict drop — PHP STEP 11). Only its show map is taken:
 * the client's sqo is the read's own (sanitizeClientSqo, below) and its
 * sqo_config is never copied.
 *
 * Two element shapes, both PHP-exact on WHICH element runs stage 1:
 *  - a SECTION-sourced read (source.tipo is the section): the gate passes on
 *    the source tipo; one build, the section element;
 *  - a COMPONENT-sourced read (the service_autocomplete picker, the
 *    input_text find_equal probe: source.tipo is the component, the rows are
 *    its targets): PHP routes it through each TARGET SECTION instance
 *    (dd_core_api case 'search' → sections_json → section::get_json →
 *    build_request_config STAGE 1, whose gate :3062-3066 passes because the
 *    section is in sqo.section_tipo). So stage 1 runs once per string target
 *    in sqo.section_tipo as a SECTION element (stageOneTargetSectionsMap) —
 *    the client ddos are validated, consolidated and read-judged exactly as
 *    for a section read; never the component's own element.
 * One read keeps the literal verbatim: a Time Machine read (dd15) — its
 * columns are judged by the dd15 floor (WC-2026-08-14-tm-permission-floor),
 * which a stage-1 section judgement on the subject section would contradict.
 */
async function stageOneSectionMap(
	rqo: Rqo,
	literal: Ddo[],
	callerTipo: string,
	sectionTipo: string,
	mode: string,
	principal: Principal | undefined,
): Promise<SectionColumnMap> {
	if (sectionTipo === TIME_MACHINE_SECTION_TIPO || rqo.sqo?.mode === 'tm') {
		return { ddoMap: literal, stageOneConfig: null };
	}
	if ((await getModelByTipo(callerTipo)) !== 'section') {
		return {
			ddoMap: await stageOneTargetSectionsMap(rqo, literal, callerTipo, mode, principal),
			stageOneConfig: null,
		};
	}
	const { buildRequestConfigFromRqo } = await import('../relations/request_config/from_rqo.ts');
	const built = await buildRequestConfigFromRqo(
		rqo,
		{ kind: 'section', tipo: callerTipo, mode },
		principal,
	);
	if (built === null) return { ddoMap: literal, stageOneConfig: null };
	// The WHOLE stage-1 config is kept, not only its show map: it IS the
	// section's own context request_config (PHP build_request_config returns it
	// and stops — :2964-2975), so the section entry ships exactly what the data
	// half read (buildSectionEntry).
	return { ddoMap: (built[0]?.show.ddo_map ?? []) as unknown as Ddo[], stageOneConfig: built };
}

/**
 * A section read's column map, and — when the read target is a SECTION the
 * client sent a show for — the stage-1 request_config that map came from
 * (null for every other source: derived, directive, TM, component-sourced).
 */
interface SectionColumnMap {
	readonly ddoMap: Ddo[];
	readonly stageOneConfig: readonly RqoRequestConfigItem[] | null;
}

/**
 * STAGE 1 of a COMPONENT-sourced section read (stageOneSectionMap): one build
 * per string target section the rqo's sqo.section_tipo names (PHP: one
 * section instance per target, each running build_request_config_from_rqo
 * through the sqo.section_tipo gate), merged in client order.
 *
 * Two TS adaptations of the merge, both shape-only (validation, consolidation
 * and the read grant are each target's own build):
 *  - PHP's section instance rewrites a direct child's parent (the component,
 *    or 'self') to ITSELF and emits it as its own direct child. Here the rows
 *    read stays the COMPONENT's read (read_source emitRow: a direct child is
 *    one whose parent is the caller), so a parent the build set to a target
 *    is handed back to the caller — the same direct child, in this read's
 *    grammar.
 *  - every target build answers the SAME client ddo, consolidated against its
 *    own section; one rows read emits every direct ddo on every row, so one
 *    ddo per (tipo, parent) survives, its section_tipo the union of what the
 *    targets kept (one string when one section) — never one copy per target.
 * No string target (no build passes its gate) → the literal unchanged: no
 * element the rqo targets, so no stage 1 (PHP); the per-ddo read gate below
 * still judges every client ddo.
 *
 *   source {tipo: portal P, section_tipo: S}, sqo.section_tipo ['A', 'B'],
 *   show [{tipo: x, parent: P, section_tipo: 'self'}, {tipo: bogus}]
 *     → [{tipo: x, parent: P, section_tipo: ['A', 'B'], label, mode, model}]
 */
async function stageOneTargetSectionsMap(
	rqo: Rqo,
	literal: Ddo[],
	callerTipo: string,
	mode: string,
	principal: Principal | undefined,
): Promise<Ddo[]> {
	const merged = new Map<string, Record<string, unknown>>();
	let built = false;
	for (const target of stringSqoSections(rqo)) {
		const map = await stageOneTargetMap(rqo, target, mode, principal);
		if (map === null) continue;
		built = true;
		for (const consolidated of map) {
			const ddo = { ...(consolidated as Record<string, unknown>) };
			if (ddo.parent === target) ddo.parent = callerTipo;
			mergeTargetDdo(merged, ddo);
		}
	}
	if (!built) return literal;
	return [...merged.values()] as unknown as Ddo[];
}

/** The rqo sqo.section_tipo's distinct non-empty STRING members (the client grammar PHP's in_array gate matches). */
function stringSqoSections(rqo: Rqo): string[] {
	const raw = rqo.sqo?.section_tipo as unknown;
	const list = Array.isArray(raw) ? raw : [raw];
	return [
		...new Set(
			list.filter((target): target is string => typeof target === 'string' && target !== ''),
		),
	];
}

/** One target SECTION's stage-1 show map, or null (not a section, or the rqo does not target it). */
async function stageOneTargetMap(
	rqo: Rqo,
	target: string,
	mode: string,
	principal: Principal | undefined,
): Promise<readonly unknown[] | null> {
	if ((await getModelByTipo(target)) !== 'section') return null;
	const { buildRequestConfigFromRqo } = await import('../relations/request_config/from_rqo.ts');
	const items = await buildRequestConfigFromRqo(
		rqo,
		{ kind: 'section', tipo: target, mode },
		principal,
	);
	if (items === null) return null;
	return items[0]?.show.ddo_map ?? [];
}

/** One target build's ddo into the merge: first-wins per (tipo, parent), sections unioned. */
function mergeTargetDdo(
	merged: Map<string, Record<string, unknown>>,
	ddo: Record<string, unknown>,
): void {
	const key = `${String(ddo.tipo)}|${String(ddo.parent ?? SELF_SENTINEL)}`;
	const existing = merged.get(key);
	if (existing === undefined) {
		merged.set(key, ddo);
		return;
	}
	const sectionsOf = (value: unknown): unknown[] =>
		Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
	const union = [
		...new Set([...sectionsOf(existing.section_tipo), ...sectionsOf(ddo.section_tipo)]),
	];
	if (union.length === 0) return;
	existing.section_tipo = union.length === 1 ? union[0] : union;
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
	principal: Principal | undefined,
	/** The response's notice sink for the derived map's refusals (deriveSectionDdoMap). */
	notices: ApiNotice[],
): Promise<SectionColumnMap> {
	const literal = clientShowDdoMap(rqo);
	if (literal !== null)
		return stageOneSectionMap(rqo, literal, callerTipo, sectionTipo, mode, principal);
	return {
		ddoMap: await resolveServerSectionColumnDdoMap(rqo, callerTipo, sectionTipo, mode, notices),
		stageOneConfig: null,
	};
}

/** resolveSectionColumnDdoMap's server-side sources: a get_ddo_map directive, the TM scope, the ontology. */
async function resolveServerSectionColumnDdoMap(
	rqo: Rqo,
	callerTipo: string,
	sectionTipo: string,
	mode: string,
	notices: ApiNotice[],
): Promise<Ddo[]> {
	const directive = (rqo.show as { get_ddo_map?: unknown } | undefined)?.get_ddo_map;
	if (directive !== undefined) {
		const { resolveSectionMapGetDdoMap } = await import('../relations/request_config/explicit.ts');
		const raw = await resolveSectionMapGetDdoMap(callerTipo, sectionTipo, directive);
		if (raw.length > 0) {
			return raw.map((d) =>
				sectionColumnDdo(d as unknown as Record<string, unknown>, sectionTipo, callerTipo),
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
		rqo.source?.properties ?? undefined,
		notices,
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
	/**
	 * The response's notice sink — the SAME one the column map was built with
	 * (deriveSectionDdoMap): this second build of the same config refuses the
	 * same deep 'self' ddos, and the registry deduplicates them (one notice per
	 * refusal, never a stray log line next to it).
	 */
	notices?: ApiNotice[],
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
			...(notices !== undefined ? { notices } : {}),
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

/** A section read's rows: the envelope + data items (readSectionRowsEmission without its nodes). */
export async function readSectionRows(
	rqo: Rqo,
	principal?: Principal,
): Promise<(SectionsEnvelope | DataItem)[]> {
	return (await readSectionRowsEmission(rqo, principal)).items;
}

/** What a section read's DATA half produced (readSectionRowsEmission). */
export interface SectionRowsEmission {
	readonly items: (SectionsEnvelope | DataItem)[];
	/** The element nodes the emission resolved (the context half serialises them). */
	readonly nodes: ElementNodeRegistry;
	/**
	 * The column map the rows were emitted through — resolved ONCE (stage 1 /
	 * directive / derived) and read-gated; the context half reads THIS map, so
	 * the two halves can never derive different columns (nor different roots:
	 * the read's root node is keyed by this map object, element_node.ts
	 * rootNodeFor).
	 */
	readonly ddoMap: Ddo[];
	/**
	 * The stage-1 request_config the column map came from, when the read target
	 * is a SECTION the client sent a show for (SectionColumnMap), else null —
	 * the section entry's request_config (buildSectionEntry).
	 */
	readonly stageOneConfig: readonly RqoRequestConfigItem[] | null;
}

/** A section read's rows — items AND the element nodes they resolved (ProducedData). */
export async function readSectionRowsEmission(
	rqo: Rqo,
	principal?: Principal,
	options: SectionReadOptions = {},
): Promise<SectionRowsEmission> {
	const { targetSearchScope } = options;
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
	// A SCOPED target search (owner decision (h)) runs stage 1 with no actor:
	// its read grant would drop exactly the scoped columns, which the gate
	// below admits by the writer component's shown pairs instead (every other
	// ddo is still judged by its own grant there).
	// The notices the section's OWN config build owes the response (a refused
	// level >= 2 'self' ddo in its section_list / edit map — owner decision (c)):
	// collected here, lifted onto the emission registry below, so a section-owned
	// map names its refusal exactly as a component-owned one does.
	const configNotices: ApiNotice[] = [];
	const columnMap = await resolveSectionColumnDdoMap(
		rqo,
		callerTipo,
		source.section_tipo ?? callerTipo,
		mode,
		targetSearchScope === undefined ? principal : undefined,
		configNotices,
	);
	let ddoMap: Ddo[] = columnMap.ddoMap;
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
		ddoMap = await authorizedColumnMap(
			principal,
			targetSearchScope,
			ddoMap,
			source.section_tipo ?? callerTipo,
			readsTimeMachine,
		);
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
				configNotices,
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
	const { subdatumReadFloor, withScopedPairs } = await import('../security/read_floor.ts');
	// A scoped target search (owner decision (h)) may also FILTER by what its
	// writer component shows / searches on the sections it opened.
	const readFloor = withScopedPairs(await subdatumReadFloor(principal, source), targetSearchScope);
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
	const emission = new EmissionContext([envelope], {
		callerChildrenOnly: targetSearchScope !== undefined,
	});
	// Whose map the ROOT is (relations/element_node.ts rootNodeFor): a fan-out
	// below a CLIENT-sent show map is the request's fault, below a derived one
	// the definition's (caller_injection.ts, BOUNDED WALK).
	emission.nodes.rootOrigin = rootMapOrigin(rqo);
	emission.nodes.addNotices(configNotices);
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
	return {
		items: emission.items,
		nodes: emission.nodes,
		ddoMap,
		stageOneConfig: columnMap.stageOneConfig,
	};
}

// MAX_DDO_DEPTH (relations/element_node.ts) — the hard recursion bound. An
// ONTOLOGY-driven chain never reaches the throw below: EVERY hop that adds a
// level checks the bound first and stops one hop earlier with a
// `relation.depth_bound_stopped` notice — a portal's children
// (models/portal.ts), a dataframe's frame children (relation_core.ts
// emitDataframeItem, relation AND literal mains), a relation_index's
// related_list children (models/relation_index.ts emitRelationIndexData). What
// still arrives here past the bound is a chain driven by a CLIENT-sent map —
// the request's fault, refused loudly as before. A NEW depth+1 emitter must add
// the same check (or this comment is false).

/**
 * Resolve one ddo against one record and push its data item(s) — the single
 * per-component emission path shared by the section read and portal
 * expansion. Splits by model family (relation label/portal/media/literal)
 * exactly as PHP's component get_json controllers do.
 *
 * EVERY ITEM IS BOUND TO ITS NODE (element_registry.ts bindItem): the element's
 * own item(s) this call pushed project the element's node, so the context door
 * (section/node_contexts.ts) serialises each child's context from exactly
 * the effective config its data came from — data and context are two
 * projections of ONE node (PHP's one request_config object per element
 * instance). An emitter that knows a more exact occurrence binds first
 * (expandPortal's own item, a dataframe's frame item); this pass binds what is
 * still unbound, resolving the node only then (literal elements included —
 * they get a node like any element).
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
	scope?: EmitScope,
): Promise<void> {
	const before = emission.items.length;
	// A scoped read expands relation elements one level only (EmissionContext.callerChildrenOnly).
	const ownChildren = allowOwnConfigChildren && !emission.callerChildrenOnly;
	await emitDdoDataUnbound(
		ddo,
		ddoMap,
		record,
		row,
		defaultMode,
		defaultLang,
		callerTipo,
		emission,
		ownChildren,
		depth,
		scope,
	);
	const unbound = emission.items
		.slice(before)
		.filter((item) => item.tipo === ddo.tipo && !emission.nodes.isItemBound(item));
	if (unbound.length === 0) return;
	const model = await componentModelOf(ddo.tipo);
	if (model === null) return;
	const node = await resolveUnboundElementNode({
		ddo,
		ddoMap,
		row,
		model,
		defaultMode,
		defaultLang,
		callerTipo,
		emission,
		allowOwnConfigChildren: ownChildren,
		scope,
	});
	for (const item of unbound) emission.nodes.bindItem(item, node);
}

/** What resolveUnboundElementNode needs (emitDdoData's own arguments). */
interface UnboundElementInput {
	readonly ddo: Ddo;
	readonly ddoMap: Ddo[];
	readonly row: EmitRow;
	readonly model: string;
	readonly defaultMode: string;
	readonly defaultLang: string;
	readonly callerTipo: string;
	readonly emission: EmissionContext;
	readonly allowOwnConfigChildren: boolean;
	readonly scope: EmitScope | undefined;
}

/** The node of an element whose items no emitter bound (literals; relation fallbacks). */
async function resolveUnboundElementNode(input: UnboundElementInput): Promise<ElementNode> {
	const { ddo, model, scope } = input;
	const { elementLang } = await import('../ontology/resolver.ts');
	const { resolveEmittedElement } = await import('../relations/element_node.ts');
	// A relation element's node carries its one-level flag exactly as its
	// resolver asked for it (models/portal.ts); a literal has no own children
	// to withhold.
	const oneLevel = getColumnNameByModel(model) === 'relation' && !input.allowOwnConfigChildren;
	return resolveEmittedElement({
		ddo,
		ddoMap: input.ddoMap,
		row: input.row,
		model,
		ddoMode: ddo.mode ?? input.defaultMode,
		ddoLang: await elementLang(ddo.tipo, model, {
			requested: ddo.lang ?? null,
			ambient: input.defaultLang,
		}),
		defaultMode: input.defaultMode,
		defaultLang: input.defaultLang,
		callerTipo: input.callerTipo,
		registry: input.emission.nodes,
		...(scope !== undefined ? { scope } : {}),
		...(oneLevel ? { useOwnConfig: false } : {}),
	});
}

/**
 * A literal's FRAME ddo: the governing line (the literal node's child for the
 * frame, or a bare ddo) placed on its record. Frames live on the caller's
 * record unless the ddo names ANOTHER section — the sibling-record case
 * emitDataframeItem resolves. The builder resolves 'self' to the owner
 * section, so the owner (or an undeclared / 'self' section) means the row's
 * own record.
 */
function literalFrameDdo(
	governing: Readonly<Record<string, unknown>> | undefined,
	frameTipo: string,
	literalTipo: string,
	row: EmitRow,
): Ddo {
	const governingSections = governing?.section_tipo;
	const declared = Array.isArray(governingSections) ? governingSections[0] : governingSections;
	const frameSection =
		typeof declared === 'string' &&
		declared !== 'self' &&
		declared !== configOwnerOf(row).section_tipo
			? declared
			: row.section_tipo;
	return {
		...(governing ?? {}),
		tipo: frameTipo,
		section_tipo: frameSection,
		parent: literalTipo,
	} as unknown as Ddo;
}

/** emitDdoData's body (the per-model emission), before the item → node binding. */
async function emitDdoDataUnbound(
	ddo: Ddo,
	ddoMap: Ddo[],
	record: MatrixRecord,
	row: EmitRow,
	defaultMode: string,
	defaultLang: string,
	callerTipo: string,
	emission: EmissionContext,
	allowOwnConfigChildren: boolean,
	depth: number,
	scope?: EmitScope,
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
	// Instance lang — THE one rule (resolver.ts elementLang, PHP
	// component_common __construct :666-678 + get_element_lang): a translatable
	// component runs in the ddo's declared lang, else the read's lang; a
	// TRANSLITERABLE one (with_lang_versions, component_iri) in the ddo's
	// DECLARED lang (an explicit ask: a component read's own source.lang, an
	// ontology ddo_map `lang`), else its lg-nolan base; anything else is
	// nolan-forced, whatever the ddo says. `defaultLang` (the section/portal
	// read's ambient lang) never counts as an explicit ask.
	const { elementLang } = await import('../ontology/resolver.ts');
	const ddoLang = await elementLang(ddo.tipo, model, {
		requested: ddo.lang ?? null,
		ambient: defaultLang,
	});

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
			scope,
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
	// `explicitLang`: effectiveLang IS the instance lang the rule above (or the
	// hook) settled, so the read shows exactly that slice — a transliterable's
	// requested version when one was asked for, its base otherwise.
	let { value, fallbackValue } = await resolveComponentValue(
		record,
		ddo.tipo,
		model,
		effectiveLang,
		{ explicitLang: true },
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
			// THE LITERAL'S NODE (relations/element_node.ts resolveElement), under
			// ITS caller: the portal node a nested literal sits under, else — at a
			// read's top level — the read's ROOT map (rootNodeFor), exactly as a
			// top-level portal resolves (models/portal.ts), so every top-level
			// element has the same caller. PHP get_subdatum injects the caller's
			// children and limit into EVERY child component, literals included
			// (class.common.php :2598-2681, no model filter), and a literal's frames
			// re-enter get_subdatum over that injected config
			// (trait.dataframe_common.php:432 build_dataframe_subdatum) — so a
			// section map [L, F<L, X<F] reaches the frame F's children [X].
			const { resolveEmittedElement } = await import('../relations/element_node.ts');
			const literalNode = await resolveEmittedElement({
				ddo,
				ddoMap,
				row,
				model,
				ddoMode,
				ddoLang,
				defaultMode,
				defaultLang,
				callerTipo,
				registry: emission.nodes,
				...(scope !== undefined ? { scope } : {}),
			});
			const frameScope: EmitScope = { parentNode: literalNode, path: scope?.path ?? [] };
			for (const frameTipo of frameTipos) {
				// THE FRAME'S GOVERNING DDO = the literal node's line for it (its
				// effective config: own, or the caller's when it named the frame) —
				// the relation main's rule (relation_core: the portal node's
				// childDdo), so a dataframe behaves IDENTICALLY on a literal and on a
				// relation main and a caller-declared frame limit / view / mode /
				// properties reach it. Discovery still walks fixedDataframeTipos /
				// has_dataframe children (a slot need not be declared to exist); a
				// slot the node names nothing for renders from a bare ddo.
				const governing = literalNode.children.find((child) => child.tipo === frameTipo);
				// Frame item mode: the governing ddo's DECLARED mode (PHP get_subdatum
				// `$dd_object->mode ?? …` — a declared 'list' included), else the
				// frame NODE's own properties.mode (dd560 → 'edit'), else LIST (the
				// generic literal default, oracle-pinned).
				const frameMode =
					(await declaredFrameMode(literalNode, ddo.tipo, frameTipo, governing)) ??
					(await resolveFrameConfig(frameTipo)).nodeMode ??
					'list';
				const frameDdo = literalFrameDdo(governing, frameTipo, ddo.tipo, row);
				for (const pairId of pairIds) {
					await emitDataframeItem(
						frameDdo,
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
						frameScope,
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
 * The TARGETED element's node when its producer resolved none (a literal
 * get_data, an empty shell, a bare item): the same top-level resolution
 * readComponentData runs for a relation component — no caller, the read's real
 * mode, the rqo `source.properties` override, and STAGE 1 when the rqo carries
 * a show (element_node.ts resolveElement) — so the main context entry is a
 * projection of a node at every get_data door.
 */
async function resolveGetDataMainNode(
	rqo: Rqo,
	nodes: ElementNodeRegistry,
	principal: Principal | undefined,
	governing: GetDataGoverning = {},
): Promise<ElementNode | null> {
	const target = getDataTarget(rqo);
	const model = await getModelByTipo(target.tipo);
	if (model === null) return null;
	const { resolveElement } = await import('../relations/element_node.ts');
	return resolveElement({
		ddo: {
			tipo: target.tipo,
			section_tipo: target.sectionTipo,
			parent: 'self',
			mode: target.mode,
			...(governing.limit !== undefined ? { limit: governing.limit } : {}),
		} as Ddo,
		parentNode: await getDataCallerNode(rqo, nodes, principal, target.lang),
		ownerSectionTipo: target.sectionTipo,
		...getDataOwnerFields(rqo.source ?? {}),
		mode: target.mode,
		lang: target.lang,
		registry: nodes,
		model,
		rqo,
		principal,
	});
}

/**
 * The get_data TARGET's verified caller node (relations/caller_chain.ts): when
 * the rqo names the element's caller instances (`source.callers`) and every
 * link verifies, the target resolves UNDER its caller — its effective config
 * carries the caller's injected children, so page 2 of a nested portal expands
 * the same children page 1 did, and stage 1 treats a resent show of those
 * children as inherited (from_rqo.ts READ GRANT — owner decisions (a), (d)).
 * null = no chain, or a refused one: a top-level read, as before. Built once
 * per registry (every door resolving the target in it agrees).
 */
function getDataCallerNode(
	rqo: Rqo,
	registry: ElementNodeRegistry,
	principal: Principal | undefined,
	lang: string,
): Promise<ElementNode | null> {
	return registry.callerParent(async () => {
		// No chain (callers absent/null) → resolveCallerChain answers null itself.
		const { resolveCallerChain } = await import('../relations/caller_chain.ts');
		const target = getDataTarget(rqo);
		const chain = await resolveCallerChain({
			callers: rqo.source?.callers,
			targetTipo: target.tipo,
			targetSectionTipo: target.sectionTipo,
			lang,
			principal,
		});
		return chain?.parentNode ?? null;
	});
}

/** The governing ddo fields a producer emits its get_data target with (its page limit). */
interface GetDataGoverning {
	readonly limit?: number;
}

/** The get_data door's TARGET element (source tipo/section/mode/lang, defaulted). */
function getDataTarget(rqo: Rqo): {
	tipo: string;
	sectionTipo: string;
	mode: string;
	lang: string;
} {
	const source = rqo.source ?? {};
	return {
		tipo: String(source.tipo ?? ''),
		sectionTipo: String(source.section_tipo ?? ''),
		mode: source.mode ?? 'edit',
		// Request-scoped data lang, never a hardcoded install default (S2-28): an
		// RQO that omits lang resolves the session's active data language.
		lang: source.lang ?? currentDataLang(),
	};
}

/** The owning record and the rqo `source.properties` override, when the source carries them. */
function getDataOwnerFields(
	source: NonNullable<Rqo['source']>,
): Pick<ResolveElementInput, 'ownerSectionId' | 'propertiesOverride'> {
	return {
		...(source.section_id !== undefined && source.section_id !== null
			? { ownerSectionId: source.section_id as ResolveElementInput['ownerSectionId'] }
			: {}),
		...(source.properties !== undefined && source.properties !== null
			? { propertiesOverride: source.properties }
			: {}),
	};
}

/**
 * The CONTEXT of a get_data response (PHP: each recursive get_json merges its
 * structure context, deduped by context_key) — serialised from the SAME
 * element nodes its data was emitted from (section/node_contexts.ts): one
 * entry for the component itself (its node: stage 1 when the rqo targets it
 * with a show, else its own config), then one per subdatum item in emission
 * order (an element, then its subcontexts), each from the node its item was
 * bound to and parented to its generating component (from_component_tipo).
 * First-wins by context_key for identical configs; one entry per occurrence
 * when two parents resolved different configs (owner decision (b)).
 */
export async function buildGetDataContext(
	rqo: Rqo,
	produced: ProducedData,
	principal?: Principal,
): Promise<StructureContextEntry[]> {
	const source = rqo.source ?? {};
	const target = getDataTarget(rqo);
	const { items, nodes } = produced;
	const mainLevel = await getDataMainLevel(source, target, principal);
	const contexts = new NodeContextSet(nodes);
	const mainNode = await getDataMainNodeFor(rqo, produced, target, principal);
	const mainEntry = await buildGetDataMainEntry(source, target, mainLevel, mainNode);
	if (mainEntry !== null) {
		contexts.add(mainEntry, mainNode);
		await stampMainContextOptions(mainEntry, target.tipo, target.sectionTipo, source, target.mode);
		await syncMainContextPagination(mainEntry, items, target.tipo);
	}
	await appendIriLabelFrameContext(contexts, source, target, mainLevel, produced);
	await appendItemContexts(
		contexts,
		items,
		nodes,
		getDataDerivedOptions(source, target, mainLevel, principal, nodes, mainNode),
	);
	// PHP traversal order (get_subdatum: an element's context, THEN its
	// subcontexts): a literal's frames are emitted before the literal's own item,
	// so raw item order would put a nested frame's context ahead of its element.
	contexts.orderByTraversal();
	contexts.stampItems(items);
	return contexts.entries;
}

/** The get_data door's target, as getDataTarget resolves it. */
type GetDataTarget = ReturnType<typeof getDataTarget>;

/**
 * The node the get_data MAIN entry is serialised from: the producer's own
 * target node when it resolved one IN THE ENTRY'S MODE (the entry declares the
 * mode its config was built for — the derived items' rule, node_contexts.ts
 * itemConfigSource 'item-mode-restamped'), else resolved now in that mode. Only
 * a resolve_data read under a non-search source.mode (the temporal save's
 * echo) takes the second branch: its producer resolves in 'search', and the
 * entry's mode is the caller's.
 */
async function getDataMainNodeFor(
	rqo: Rqo,
	produced: ProducedData,
	target: GetDataTarget,
	principal: Principal | undefined,
): Promise<ElementNode | null> {
	const producedMain = produced.mainNode;
	if (producedMain !== undefined && producedMain.mode === target.mode) return producedMain;
	return resolveGetDataMainNode(rqo, produced.nodes, principal);
}

/**
 * MAIN element permission: the matrix level with PHP's search-mode special
 * grants (thesaurus / metadata tipos / synthetic 'search_<n>' ids → 2). An
 * undefined principal (internal calls, harnesses) stamps 3. The handler's
 * Gate A already denied level 0 for the non-search path.
 */
async function getDataMainLevel(
	source: NonNullable<Rqo['source']>,
	target: GetDataTarget,
	principal: Principal | undefined,
): Promise<number> {
	if (principal === undefined) return 3;
	return resolveComponentContextPermission(
		principal,
		target.sectionTipo,
		target.tipo,
		source.section_id as number | string | null | undefined,
		String(target.mode),
	);
}

/**
 * The get_data MAIN entry, from the element's node (or its own config when no
 * node resolves). It carries the REQUESTED view (source.view) — a get_data for
 * a ?view=viewer deep link must ship view:'viewer' so the client instance
 * adopts it (self.view is a getter over context.view) and mounts the dedicated
 * view (e.g. component_image view_viewer_image) instead of the edit view.
 * The entry emits from the EFFECTIVE properties: an rqo source.properties
 * override replaces the ontology's (PHP set_properties, dd_core_api read
 * :2305-2308) — properties echo, css, view and request_config all follow the
 * override (the node was resolved over the same override).
 */
function buildGetDataMainEntry(
	source: NonNullable<Rqo['source']>,
	target: GetDataTarget,
	mainLevel: number,
	mainNode: ElementNode | null,
): Promise<StructureContextEntry | null> {
	return buildStructureContext({
		tipo: target.tipo,
		sectionTipo: target.sectionTipo,
		mode: target.mode,
		lang: target.lang,
		// The read's own source.lang is the EXPLICIT ask (the tool_lang target
		// of a transliterable runs in it); an omitted one is not — `lang` above
		// is then only the ambient default.
		requestedLang: explicitSourceLang(source),
		permissions: mainLevel,
		parent: target.sectionTipo,
		view: requestedView(source),
		propertiesOverride: source.properties ?? undefined,
		// WC-079: a temporal clone ships no component toolbar. This is the
		// get_data door — the one service_tmp_section's children actually use,
		// so the suppression has to be stamped here and not only on the
		// section ddo-map path.
		isTemporal: isTemporalSource(source),
		configFrom:
			mainNode !== null
				? { source: 'emission', node: mainNode }
				: { source: 'own', reason: 'item-without-node' },
	});
}

/** The source's requested view (a non-empty string), else null. */
function requestedView(source: { view?: unknown }): string | null {
	return typeof source.view === 'string' && source.view !== '' ? source.view : null;
}

/**
 * component_iri label dataframe (dd560): the list/text render resolves the title
 * frame via get_dataframe, which requires the dataframe's OWN structure context in
 * datum.context (dataframe.js:249 returns null — then a null.render() crash —
 * without it). PHP class.component_iri::get_properties injects the dd560 slot
 * with the caller's edit rights (at least 2) and the 'line' view.
 *
 * Two shapes:
 *  - the literal emission DID emit a dd560 frame for the IRI (every non-search
 *    get_data — read.ts emitDdoData's literal branch, one frame per pair id,
 *    bound to its frame node): the entry is built FROM THAT NODE (data and
 *    context, one node), the PHP injection kept as overrides — the view
 *    defaults to 'line' when the governing line declares none, and the level
 *    is max(main, 2). The derived pass then dedupes the frame item into it.
 *  - no frame item (search mode emits none): the synthetic `own` entry, the
 *    one case OWN_CONTEXT_REASONS['iri-label-dataframe'] names.
 */
async function appendIriLabelFrameContext(
	contexts: NodeContextSet,
	source: NonNullable<Rqo['source']>,
	target: GetDataTarget,
	mainLevel: number,
	produced: { readonly items: readonly unknown[]; readonly nodes: ElementNodeRegistry },
): Promise<void> {
	if ((await getModelByTipo(target.tipo)) !== 'component_iri') return;
	const frame = iriLabelFrameOf(produced, target) ?? SYNTHETIC_IRI_FRAME;
	const frameNode = frame.node;
	const frameEntry = await buildStructureContext({
		tipo: 'dd560',
		sectionTipo: frame.sectionTipo ?? target.sectionTipo,
		mode: frame.mode,
		lang: target.lang,
		requestedLang: null,
		// The dd560 label frame is system-managed and always writable through its
		// IRI (PHP component_iri injection carries the caller's edit rights).
		permissions: Math.max(mainLevel, 2),
		parent: target.tipo,
		view: frame.view,
		isTemporal: isTemporalSource(source),
		configFrom:
			frameNode !== null
				? { source: 'emission', node: frameNode }
				: { source: 'own', reason: 'iri-label-dataframe' },
	});
	if (frameEntry === null) return;
	contexts.add(frameEntry, frameNode);
}

/** The dd560 frame an IRI get_data builds its entry from (iriLabelFrameOf), or the synthetic one. */
interface IriLabelFrame {
	readonly node: ElementNode | null;
	/** null = the read target's section. */
	readonly sectionTipo: string | null;
	readonly mode: string;
	readonly view: string;
}

/** No frame item emitted (search mode): PHP's injected slot — edit mode, the 'line' view. */
const SYNTHETIC_IRI_FRAME: IriLabelFrame = Object.freeze({
	node: null,
	sectionTipo: null,
	mode: 'edit',
	view: 'line',
});

/**
 * The IRI's own dd560 frame item's node (the first one the literal emission
 * bound, in the frame item's mode — its context must say the mode its cell
 * carries), or null when none was emitted (search mode).
 */
function iriLabelFrameOf(
	produced: { readonly items: readonly unknown[]; readonly nodes: ElementNodeRegistry },
	target: GetDataTarget,
): IriLabelFrame | null {
	for (const raw of produced.items) {
		const item = raw as DataItem;
		if (item?.tipo !== 'dd560' || item.from_component_tipo !== target.tipo) continue;
		const node = produced.nodes.nodeOfItem(item);
		if (!nodeStandsForItem(node, item)) continue;
		return {
			node,
			sectionTipo: String(item.section_tipo),
			mode: node.mode,
			// PHP's injected default when the governing line declares no view
			view: node.view ?? 'line',
		};
	}
	return null;
}

/** Whether an item's bound node can stand for its context (node_contexts.ts itemConfigSource's emission case). */
function nodeStandsForItem(node: ElementNode | undefined, item: DataItem): node is ElementNode {
	return node !== undefined && node.mode === item.mode && !node.oneLevel;
}

/**
 * The get_data door's DERIVED item rules (appendItemContexts): the component's
 * own item gets no derived entry; subdatum permission inheritance (PHP
 * get_subdatum :2564-2571 — owner decision (d), section/node_permissions.ts):
 * floor-1 through the component caller, cap-1 under a read-only caller, each
 * element judged against its IMMEDIATE caller occurrence — the MAIN element's
 * level for its direct children, the child's own computed level for a
 * grandchild (a level-2 grandchild under a read-only child stamps 1 even when
 * the main element is editable). The main node is the chain's top whatever its
 * own parent is (a verified caller chain, source.callers).
 */
function getDataDerivedOptions(
	source: NonNullable<Rqo['source']>,
	target: GetDataTarget,
	mainLevel: number,
	principal: Principal | undefined,
	nodes: ElementNodeRegistry,
	mainNode: ElementNode | null,
): DerivedItemContextOptions {
	const ownId = String(source.section_id ?? '');
	const levels = new NodePermissionLevels(nodes, {
		isTop: (node) => node.key === mainNode?.key,
		topLevelOf: async () => mainLevel,
		ownLevelOf: async (sectionTipo, tipo, sectionId, mode) =>
			principal === undefined
				? 3
				: resolveComponentContextPermission(principal, sectionTipo, tipo, sectionId, mode),
	});
	return {
		isOwnItem: (item) => item.tipo === target.tipo && String(item.section_id) === ownId,
		fallbackParent: () => target.tipo,
		permissionsOf: async (item) => {
			if (principal === undefined) return 3;
			const chained = await levels.itemLevel(
				nodes.nodeOfItem(item),
				String(item.section_tipo),
				String(item.tipo),
				itemRowId(item.section_id),
			);
			// An item no emitter bound (a hand-built answer): the main element
			// stands in for its caller.
			return (
				chained ??
				inheritSubdatumPermission(
					await getPermissions(principal, String(item.section_tipo), String(item.tipo)),
					mainLevel,
				)
			);
		},
		isTemporal: isTemporalSource(source),
	};
}

/**
 * PER-RECORD context options (the resolveContextOptions facet — today
 * component_text_area's original language, PHP component_text_area_json
 * :61-69: the transcription/indexation/lang tools read
 * `options.related_component_lang` to open the component in the interview's
 * own language). Dispatched through the REGISTRY, never a model conditional
 * (S2-24). Stamped HERE because this entry is per-request and per-record
 * (clone-before-stamp: buildStructureContext returns a fresh object; the
 * structural core cache never sees `options`).
 */
async function stampMainContextOptions(
	mainEntry: StructureContextEntry,
	tipo: string,
	sectionTipo: string,
	source: NonNullable<Rqo['source']>,
	mode: string,
): Promise<void> {
	if (mode !== 'edit') return;
	mergeContextOptions(
		mainEntry,
		await recordContextOptions(tipo, sectionTipo, positiveRecordId(source.section_id)),
	);
}

/**
 * The get_data context mirrors the element's RUNTIME pagination (PHP syncs the
 * element's sqo before emitting it): the dedalo request_config item's sqo
 * carries the limit the data actually paged with — 9 (ontology sqo_config) /
 * 1 (tool override) / the governing / client-sent value; sqo.offset is NOT
 * stamped (wire-pinned 2026-07-10).
 *
 * LOCAL narrowing (relations/request_config/engine_select.ts): the dedalo item
 * when there is one, else the first. NO capability gate — the number stamped
 * here is the limit THIS engine already paged the emitted data with, so the
 * remote service's own paging ability cannot change it; negotiating
 * `capabilities.pagination` would throw an external-only component's whole
 * get_data out of the read path.
 */
async function syncMainContextPagination(
	mainEntry: StructureContextEntry,
	items: readonly DataItem[],
	tipo: string,
): Promise<void> {
	if (!Array.isArray(mainEntry.request_config)) return;
	const mainItem = items.find(
		(item) =>
			item.tipo === tipo &&
			typeof (item as { pagination?: { limit?: unknown } }).pagination?.limit === 'number',
	);
	if (mainItem === undefined) return;
	const { selectLocalConfigItem } = await import('../relations/request_config/engine_select.ts');
	const dedaloItem = selectLocalConfigItem(
		mainEntry.request_config as { api_engine?: string; sqo?: Record<string, unknown> }[],
	);
	if (dedaloItem?.sqo !== undefined) {
		dedaloItem.sqo.limit = (
			mainItem as unknown as { pagination: { limit: number } }
		).pagination.limit;
	}
}
