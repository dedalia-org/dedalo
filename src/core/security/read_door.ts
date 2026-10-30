/**
 * THE READ DOOR — one shape for the component-read authorization of every
 * record-addressing read door that is NOT the human read (P1-3 — SEC-04,
 * SEC-06, SEC-10, SEC-11, SEC-12, SEC-13; class closed 2026-09-03).
 *
 * The human read (`section/read.ts`) drops any ddo the caller holds level 0
 * on: `ddoIsAuthorized(principal, sectionTipo, componentTipo)`, per component,
 * per record section. Six other doors returned component VALUES behind a
 * SECTION grant or a RECORD-scope check only — `read_raw` dumped every jsonb
 * column verbatim (on dd128 that is the dd133 Argon2id hash), the MCP media
 * tool returned variant paths + fetch URLs, `find_matches` emitted a preview
 * thumb the profile chose, `identify_by_image` searched the WHOLE image index
 * when no scope was named, the criterion path reader authorized the DECLARED
 * leaf while landing on the LOCATOR's section, and `get_element_context` built
 * a section context with no principal so every button rendered. Six doors,
 * six re-implementations of a subset of one rule. This module is the rule.
 *
 * ── WHAT A DOOR IS, and how it differs from a FRONTIER ──────────────────────
 *
 * A FRONTIER crossing (`security/frontier_scope.ts`) is a hop the ENGINE
 * mints — a component_filter's sort path into the projects section, an export
 * column's relation walk — which is why the frontier's component key carries
 * exemptions for the sections the record key already declares globally
 * visible. A DOOR reads what the CALLER TYPED: `options.tipo`, `field`, a
 * profile's `previewComponent`. There is nothing engine-minted to exempt, so
 * the door's component key is the human read's predicate EXACTLY — the
 * section read grant AND `ddoIsAuthorized`, no exemptions — and its record key
 * is the one the door already holds: the MCP tools' `assertRecordInScope`, the
 * SQO assembler's own predicate for a landed row (`principalCanAccessRecord`
 * behind both) — the same answer the list shows, never a second copy here.
 * The ONE door that IS a frontier — the criterion path reader's hops — uses
 * the frontier's predicates with its scope's `surface: 'door'`; this module
 * owns the law, `frontier_scope.ts` owns the exemptions.
 *
 * ── THE REFUSAL LAW for the DOOR surface ────────────────────────────────────
 *
 *   ONE typed (record, component)  → THROW `perm.denied` (read_raw's
 *                                    'component' arm on the primary section,
 *                                    the MCP media tool). The caller asked one
 *                                    question about one field; "no" is the
 *                                    answer, and an empty value in its place
 *                                    would be a lie about the record.
 *   MANY assembled (record, key)s  → NARROW per key AND SAY SO: the refused key
 *                                    is absent / null, the operator log line
 *                                    names it, and the envelope carries ONE
 *                                    `notices[]` entry (`perm.out_of_scope`)
 *                                    however many keys were refused — the
 *                                    count is itself an existence oracle.
 *
 * In every case the refusal is LOUD through `noteFrontierRefusal` (surface
 * 'door'): AGENTS.md forbids a silent narrowing even when the narrowing is
 * correct.
 *
 * ── SUPERUSER, ADMIN, INTERNAL ──────────────────────────────────────────────
 *
 * The superuser (-1) resolves to level 3 everywhere (`getPermissions`), so the
 * frozen read_raw differential — which runs as -1 — is byte-identical. A GLOBAL
 * ADMIN resolves through their profile like the human read (no admin bypass on
 * the component key; PHP parity 2026-07-18) — the record key exempts admins,
 * as `frontierRecordAllowed` does. An ABSENT principal is an INTERNAL read
 * (background jobs, the installer, unit harnesses) and gates nothing — the
 * posture every caller-less read in this engine already takes.
 *
 * ── THE POSTURE MAP ─────────────────────────────────────────────────────────
 *
 * {@link READ_DOOR_POSTURE} classifies EVERY registered HTTP action
 * (`core/api/dispatch.ts` listRegisteredActions) and EVERY MCP tool
 * (`ai/mcp/registry.ts` TOOL_REGISTRY), plus the one door outside both
 * registries (`api/raw_view.ts`, a GET). `test/unit/read_door_acl_tripwire`
 * derives the census from the registries and fails on any door the map does
 * not classify — a new door cannot ship unclassified — and pins the OPEN set
 * shrink-only. `test/unit/read_door_acl_native` probes every door whose
 * posture is `component` and names this gate.
 */

import { DedaloError } from '../errors/dedalo_error.ts';
import {
	frontierRefusalNotice,
	noteFrontierRefusal,
	resolveDeclaredTipo,
} from './frontier_scope.ts';
import { ddoIsAuthorized, getPermissions, type Principal } from './permissions.ts';

/** The per-(section, component) LEVEL reader — `getPermissions` in production. */
export type DoorComponentGrant = (
	principal: Principal,
	sectionTipo: string,
	componentTipo: string,
) => Promise<number>;

/**
 * The per-request scope a door builds ONCE and threads through (frontier
 * property 1). `principal` undefined = internal read, nothing to gate.
 */
export interface ReadDoorScope {
	readonly principal?: Principal;
	/** The concrete door, for the log line: 'read_raw', 'mcp.get_media_info', … */
	readonly door: string;
	/**
	 * Injectable level read — the same seam `frontier_scope.ts` and
	 * `identify/component_access.ts` expose, so a gate proves the RULE without
	 * a dd774 fixture. Production omits it and gets `ddoIsAuthorized`.
	 */
	readonly grant?: DoorComponentGrant;
}

/** The (section, component[, record]) a door is about to read. */
export interface ReadDoorStep {
	readonly sectionTipo: string;
	readonly componentTipo: string;
	readonly sectionId?: number | string;
}

/**
 * THE COMPONENT KEY of the door surface: may this principal read THIS component
 * of THIS section? TWO grants, both required, exactly what the human read
 * demands before it shows a component: the SECTION read grant
 * (`getPermissions(section, section) >= 1` — dd_core_api's Gate A/B, without
 * which the human read refuses the whole record) and the component's own
 * (`ddoIsAuthorized` verbatim, no frontier exemptions — module header). A
 * profile that grants a component but NOT its section is a misconfigured
 * matrix (SEC-11's shape); the human read refuses it, so a door must too — a
 * component key alone would serve through the MCP media tool what the record
 * page denies. Never throws: the door applies the law. A refusal is recorded
 * (log line + request notice) HERE, so no door can narrow silently by
 * forgetting to.
 */
export async function doorComponentAllowed(
	scope: ReadDoorScope,
	step: ReadDoorStep,
): Promise<boolean> {
	if (scope.principal === undefined) return true; // internal read
	const sectionTipo = resolveDeclaredTipo(step.sectionTipo);
	const allowed =
		sectionTipo === null
			? false // unresolvable section: fail closed (SEC-01)
			: await pairGranted(scope, scope.principal, sectionTipo, step.componentTipo);
	if (!allowed) {
		noteFrontierRefusal(
			{ principal: scope.principal, surface: 'door', door: scope.door },
			{
				surface: 'door',
				door: scope.door,
				sectionTipo: step.sectionTipo,
				componentTipo: step.componentTipo,
				...(step.sectionId === undefined ? {} : { sectionId: step.sectionId }),
				key: 'component',
			},
		);
	}
	return allowed;
}

/**
 * The PAIR: the section read grant first, then the component's own — through
 * the injected seam when a gate supplies one, else the real resolvers.
 */
async function pairGranted(
	scope: ReadDoorScope,
	principal: Principal,
	sectionTipo: string,
	componentTipo: string,
): Promise<boolean> {
	if (scope.grant !== undefined) {
		return (
			(await scope.grant(principal, sectionTipo, sectionTipo)) >= 1 &&
			(await scope.grant(principal, sectionTipo, componentTipo)) >= 1
		);
	}
	return (
		(await getPermissions(principal, sectionTipo, sectionTipo)) >= 1 &&
		(await ddoIsAuthorized(principal, sectionTipo, componentTipo))
	);
}

/**
 * The ONE-typed-question law: the caller named one (record, component) and
 * may not read it → `perm.denied`. `coordinates` name the refused pair for the
 * operator log only (`perm.denied` discloses at operator level, never public).
 */
export async function authorizeComponentRead(
	scope: ReadDoorScope,
	step: ReadDoorStep,
): Promise<void> {
	if (await doorComponentAllowed(scope, step)) return;
	throw new DedaloError('perm.denied', {
		message: `${scope.door}: no read grant on (${step.sectionTipo}, ${step.componentTipo})`,
		coordinates: {
			section_tipo: step.sectionTipo,
			tipo: step.componentTipo,
			...(step.sectionId === undefined ? {} : { section_id: step.sectionId }),
		},
	});
}

/**
 * THE MANY-keys law for a raw row: every jsonb column of a matrix record is a
 * `{ [componentTipo]: value }` map, and each key is a component read of its
 * own. Keep exactly the keys the caller may read ON THE ROW'S OWN SECTION —
 * the section the row LANDED in, never the section the SQO declared, because a
 * multi-section SQO (or a sibling section sharing the matrix table) lands rows
 * of other sections and their ontology is the one the key belongs to.
 *
 * A column that is null stays null; a column that loses every key becomes an
 * empty object, not null — "the column exists and you may read none of it" is
 * not the same claim as "the record has no such column", and the client's
 * shape test (`column !== null`) must not turn one into the other.
 */
export async function projectAuthorizedColumns(
	scope: ReadDoorScope,
	record: { sectionTipo: string; sectionId: number | string },
	columns: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
	if (scope.principal === undefined) return { ...columns };
	const out: Record<string, unknown> = {};
	for (const [column, value] of Object.entries(columns)) {
		out[column] = isComponentMap(value)
			? await projectComponentMap(scope, record, value)
			: (value ?? null);
	}
	return out;
}

/** A jsonb column that IS a `{ [componentTipo]: value }` map — the only shape projected. */
function isComponentMap(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The keys of one component map the caller may read on the row's own section. */
async function projectComponentMap(
	scope: ReadDoorScope,
	record: { sectionTipo: string; sectionId: number | string },
	map: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
	const kept: Record<string, unknown> = {};
	for (const [componentTipo, slice] of Object.entries(map)) {
		const allowed = await doorComponentAllowed(scope, {
			sectionTipo: record.sectionTipo,
			componentTipo,
			sectionId: record.sectionId,
		});
		if (allowed) kept[componentTipo] = slice;
	}
	return kept;
}

/**
 * The `notices[]` a narrowed door answer must carry — ONE `perm.out_of_scope`
 * entry when anything in this request was refused, else undefined so the
 * envelope omits the key. Thin wrapper so a door never reaches into the
 * frontier module for its own surface's notice.
 */
export function readDoorNotices():
	| readonly NonNullable<ReturnType<typeof frontierRefusalNotice>>[]
	| undefined {
	const notice = frontierRefusalNotice();
	return notice === undefined ? undefined : [notice];
}

/* ═══════════════════════════ THE POSTURE MAP ═══════════════════════════ */

/**
 * How a registered door relates to the component read grant.
 *
 *   component        Returns component VALUES of addressed records and consults
 *                    the component grant AT THE DOOR (this module, or the
 *                    frontier for a hop). `gate` names the test that probes it.
 *   chokepoint       Returns component values THROUGH a subsystem chokepoint
 *                    that carries the component grant (the human read's
 *                    `ddoIsAuthorized`, the RAG `aclGate`, the tree's
 *                    per-element `getPermissionsElement`). `via` names it.
 *   record_identity  Emits locators / counts / existence only; component
 *                    filtering is the assembler's own predicate (the SQO path
 *                    ACL), never a value read.
 *   structure_only   Ontology, configuration, session or system state — no
 *                    record data at all.
 *   mutating         A write door: the write grant (level >= 2) is its gate,
 *                    out of this map's scope (human_write_scope_tripwire).
 *   delegates        A polymorphic door that names the door it delegates to;
 *                    the delegate's posture applies.
 *   open             ENUMERATED, SHRINK-ONLY: reads component values behind a
 *                    section grant / record scope only — the component grant
 *                    is NOT consulted. Each carries the reason it is still
 *                    open; `read_door_acl_tripwire` pins the count.
 */
export type ReadDoorPosture =
	| { posture: 'component'; gate: string; reason: string }
	| { posture: 'chokepoint'; via: string; reason: string }
	| { posture: 'record_identity'; reason: string }
	| { posture: 'structure_only'; reason: string }
	| { posture: 'mutating'; reason: string }
	| { posture: 'delegates'; to: string; reason: string }
	| { posture: 'open'; reason: string };

/** The gate that probes every `component` door of this batch. */
export const READ_DOOR_GATE = 'test/unit/read_door_acl_native.test.ts';

const HUMAN_READ =
	'src/core/section/read.ts buildStructureContextEntries → ddoIsAuthorized per ddo';
const RAG_GATE =
	'src/ai/rag/retrieval.ts aclGate — section + every contributing component >= 1, then the record scope';

/**
 * TOTAL over `listRegisteredActions()` (`<dd_api>:<action>`) + `TOOL_REGISTRY`
 * (`mcp:<tool>`) + {@link READ_DOOR_EXTRA_DOORS}. Gated total by
 * `test/unit/read_door_acl_tripwire.test.ts`.
 */
export const READ_DOOR_POSTURE: ReadonlyMap<string, ReadDoorPosture> = new Map<
	string,
	ReadDoorPosture
>([
	// ── dd_core_api ──────────────────────────────────────────────────────────
	[
		'dd_core_api:read',
		{ posture: 'chokepoint', via: HUMAN_READ, reason: 'THE human read — the reference predicate.' },
	],
	[
		'dd_core_api:read_raw',
		{
			posture: 'component',
			gate: READ_DOOR_GATE,
			reason:
				"every arm gated per LANDED row section: 'component' throws on the primary section, per-row null elsewhere; 'section' projects each jsonb column's keys; 'target_section' skips the relation keys of denied components.",
		},
	],
	[
		'dd_core_api:relation_targets',
		{
			posture: 'record_identity',
			reason:
				'target section tipos + EXACT record counts of a referenced_by source set (WC-2026-10-30-search-referenced-by-leaf); no component value is read. The owner side carries the SEC-1 component key (builder_referenced_by.ts buildOwnerRelationScope: a hidden relation component contributes no locator, perm.out_of_scope noticed), each total is the target search’s own full_count (its records ACL), unreadable targets are dropped.',
		},
	],
	['dd_core_api:save', { posture: 'mutating', reason: 'the component save door.' }],
	['dd_core_api:create', { posture: 'mutating', reason: 'record lifecycle.' }],
	['dd_core_api:duplicate', { posture: 'mutating', reason: 'record lifecycle.' }],
	['dd_core_api:delete', { posture: 'mutating', reason: 'record lifecycle.' }],
	[
		'dd_core_api:count',
		{
			posture: 'record_identity',
			reason: 'full_count of a principal-scoped SQO — a number; the path ACL is the assembler’s.',
		},
	],
	[
		'dd_core_api:start',
		{
			posture: 'chokepoint',
			via: HUMAN_READ,
			reason:
				'environment + the default section structure context (no data), built with the principal.',
		},
	],
	[
		'dd_core_api:get_element_context',
		{
			posture: 'component',
			gate: READ_DOOR_GATE,
			reason:
				'one element’s structure context, built WITH the principal so section buttons pass the per-button grant (buildSectionButtons) instead of the caller-cap path.',
		},
	],
	[
		'dd_core_api:get_section_elements_context',
		{
			posture: 'chokepoint',
			via: 'src/core/resolve/section_elements_context.ts — ddoIsAuthorized per element',
			reason: 'the search-filter panel’s element list; structure, gated per ddo.',
		},
	],
	[
		'dd_core_api:get_section_terms',
		{
			posture: 'open',
			reason:
				'returns the section_map DISPLAY TERM of each locator behind the SECTION grant only (PHP get_section_terms parity): neither the record scope nor the term component’s grant is consulted. The term is what every resolved relation quotes, so the exposure is the label of a record the caller can name — open, not closed by P1-3.',
		},
	],
	[
		'dd_core_api:get_indexation_grid',
		{
			posture: 'open',
			reason:
				'the thesaurus “show indexations” grid: section grant >= 1 on the term’s section, then the indexing records’ fragments are quoted with no component grant on THEIR sections. Open.',
		},
	],
	[
		'dd_core_api:get_activity_metric',
		{ posture: 'structure_only', reason: 'dashboard activity counts, gated as the area read.' },
	],
	['dd_core_api:get_ip_country', { posture: 'structure_only', reason: 'geo lookup of an IP.' }],
	[
		'dd_core_api:get_environment',
		{ posture: 'structure_only', reason: 'page globals + labels, no record data.' },
	],
	// ── dd_tools_api ─────────────────────────────────────────────────────────
	[
		'dd_tools_api:user_tools',
		{ posture: 'structure_only', reason: 'the caller’s authorized tool list.' },
	],
	[
		'dd_tools_api:tool_request',
		{
			posture: 'delegates',
			to: 'src/core/tools/* per-tool handlers (tool_security + the tool’s own read/write gates)',
			reason: 'polymorphic on the tool + nested action.',
		},
	],
	// ── dd_area_maintenance_api ──────────────────────────────────────────────
	[
		'dd_area_maintenance_api:widget_request',
		{
			posture: 'delegates',
			to: 'src/core/area_maintenance/widgets/* (global-admin area)',
			reason: 'polymorphic on the widget action; the area itself is admin-gated.',
		},
	],
	[
		'dd_area_maintenance_api:get_widget_value',
		{
			posture: 'delegates',
			to: 'src/core/area_maintenance/widgets/* (global-admin area)',
			reason: 'polymorphic on the widget; admin-gated.',
		},
	],
	[
		'dd_area_maintenance_api:lock_components_actions',
		{ posture: 'mutating', reason: 'lock-state maintenance.' },
	],
	// ── dd_diffusion_api ─────────────────────────────────────────────────────
	['dd_diffusion_api:diffuse', { posture: 'mutating', reason: 'enqueues a publication run.' }],
	['dd_diffusion_api:cancel_process', { posture: 'mutating', reason: 'cancels a run.' }],
	['dd_diffusion_api:rebuild_media_index', { posture: 'mutating', reason: 'rebuilds an index.' }],
	[
		'dd_diffusion_api:retry_pending_deletions',
		{ posture: 'mutating', reason: 'replays deletions.' },
	],
	[
		'dd_diffusion_api:count_pending_deletions',
		{
			posture: 'structure_only',
			reason: 'a global queue size, global-admin only; no record data.',
		},
	],
	['dd_diffusion_api:sweep_published_langs', { posture: 'mutating', reason: 'sweeps a target.' }],
	[
		'dd_diffusion_api:follow_queue',
		{ posture: 'structure_only', reason: 'job frames, global-admin only; no record data.' },
	],
	['dd_diffusion_api:get_process_status', { posture: 'structure_only', reason: 'a run’s status.' }],
	[
		'dd_diffusion_api:get_diffusion_info',
		{ posture: 'structure_only', reason: 'the diffusion configuration of a section.' },
	],
	[
		'dd_diffusion_api:get_engine_advisory',
		{ posture: 'structure_only', reason: 'engine advisory text.' },
	],
	['dd_diffusion_api:list_processes', { posture: 'structure_only', reason: 'run listing.' }],
	[
		'dd_diffusion_api:validate',
		{ posture: 'structure_only', reason: 'ontology validation, global-admin only.' },
	],
	// ── component families ───────────────────────────────────────────────────
	['dd_component_portal_api:delete_locator', { posture: 'mutating', reason: 'removes a locator.' }],
	[
		'dd_component_text_area_api:get_tags_info',
		{
			posture: 'open',
			reason:
				'resolves a text_area’s tag payload — the host record’s content and every tagged record’s — behind the RECORD scope only (AUTHZ-01); the text_area component’s own grant and the tagged components’ are not consulted. Open.',
		},
	],
	['dd_component_text_area_api:delete_tag', { posture: 'mutating', reason: 'removes a tag.' }],
	['dd_component_av_api:create_posterframe', { posture: 'mutating', reason: 'writes a frame.' }],
	['dd_component_av_api:delete_posterframe', { posture: 'mutating', reason: 'removes a frame.' }],
	[
		'dd_component_av_api:get_media_streams',
		{
			posture: 'component',
			gate: READ_DOOR_GATE,
			reason:
				'ffprobe stream metadata of an AV component’s file — through the write door’s read mode (media_action_context.ts → write_door.authorizeRecordAccess): the section floor, the AV component’s own grant (authorizeComponentRead) and the record scope (closure Step 3, SEC-2-media).',
		},
	],
	[
		'dd_component_av_api:download_fragment',
		{
			posture: 'component',
			gate: READ_DOOR_GATE,
			reason:
				'cuts and serves a fragment of an AV component’s file — through the write door’s read mode (media_action_context.ts → write_door.authorizeRecordAccess): the section floor, the AV component’s own grant and the record scope (closure Step 3, SEC-2-media).',
		},
	],
	[
		'dd_component_info:get_widget_data',
		{
			posture: 'open',
			reason:
				'component_info’s computed widget over a record behind the RECORD scope only (AUTHZ-01); the info component’s grant is not consulted. Open.',
		},
	],
	['dd_component_3d_api:move_file_to_dir', { posture: 'mutating', reason: 'moves a 3D file.' }],
	['dd_component_3d_api:delete_posterframe', { posture: 'mutating', reason: 'removes a frame.' }],
	// ── dd_ts_api (thesaurus tree) ───────────────────────────────────────────
	[
		'dd_ts_api:get_node_data',
		{
			posture: 'chokepoint',
			via: 'src/core/ts_object/ts_object.ts — section grant + getPermissionsElement per button; term through the resolver',
			reason: 'a thesaurus node (term, children, buttons) for the tree.',
		},
	],
	[
		'dd_ts_api:get_children_data',
		{
			posture: 'chokepoint',
			via: 'src/core/ts_object/ts_object.ts — as get_node_data, per child',
			reason: 'a node’s children for the tree.',
		},
	],
	['dd_ts_api:add_child', { posture: 'mutating', reason: 'mints a term.' }],
	['dd_ts_api:update_parent_data', { posture: 'mutating', reason: 'moves a term.' }],
	['dd_ts_api:save_order', { posture: 'mutating', reason: 'reorders terms.' }],
	// ── dd_utils_api ─────────────────────────────────────────────────────────
	['dd_utils_api:update_lock_components_state', { posture: 'mutating', reason: 'lock state.' }],
	['dd_utils_api:get_lock_status', { posture: 'structure_only', reason: 'lock poll.' }],
	[
		'dd_utils_api:get_dedalo_files',
		{ posture: 'structure_only', reason: 'the service-worker pre-cache manifest.' },
	],
	['dd_utils_api:get_job_events', { posture: 'structure_only', reason: 'a job’s frames.' }],
	['dd_utils_api:get_process_status', { posture: 'structure_only', reason: 'a job’s status.' }],
	[
		'dd_utils_api:get_record_jobs',
		{ posture: 'record_identity', reason: 'jobs running for a record — identity + job state.' },
	],
	[
		'dd_utils_api:get_record_info',
		{
			posture: 'component',
			gate: 'test/unit/record_info_native.test.ts',
			reason:
				'a record’s created / modified stamps (audit components dd199/dd200/dd201/dd197, each behind the standing metadata grant or the component grant) + its dd1758 publication history, behind the section grant and the record scope.',
		},
	],
	['dd_utils_api:get_activity', { posture: 'structure_only', reason: 'the caller’s own jobs.' }],
	['dd_utils_api:stop_process', { posture: 'mutating', reason: 'stops a job.' }],
	['dd_utils_api:get_system_info', { posture: 'structure_only', reason: 'upload limits.' }],
	[
		'dd_utils_api:join_chunked_files_uploaded',
		{ posture: 'mutating', reason: 'assembles an upload.' },
	],
	['dd_utils_api:change_lang', { posture: 'mutating', reason: 'session state.' }],
	['dd_utils_api:get_login_context', { posture: 'structure_only', reason: 'the login form.' }],
	[
		'dd_utils_api:list_uploaded_files',
		{ posture: 'structure_only', reason: 'the caller’s own staged uploads.' },
	],
	['dd_utils_api:delete_uploaded_file', { posture: 'mutating', reason: 'removes a staged file.' }],
	['dd_utils_api:login', { posture: 'mutating', reason: 'session creation.' }],
	['dd_utils_api:request_password_reset', { posture: 'mutating', reason: 'reset flow.' }],
	['dd_utils_api:confirm_password_reset', { posture: 'mutating', reason: 'reset flow.' }],
	['dd_utils_api:quit', { posture: 'mutating', reason: 'session end.' }],
	[
		'dd_utils_api:convert_search_object_to_sql_query',
		{
			posture: 'open',
			reason:
				'the global-admin SQO→SQL developer console executes the built query and returns its rows; the admin’s own profile grants are not consulted per column. Admin-only, open.',
		},
	],
	['dd_utils_api:get_server_ready_status', { posture: 'structure_only', reason: 'readiness.' }],
	[
		'dd_utils_api:get_ontology_update_info',
		{ posture: 'structure_only', reason: 'ontology update state.' },
	],
	[
		'dd_utils_api:get_code_update_info',
		{ posture: 'structure_only', reason: 'code update state.' },
	],
	// ── dd_rag_api ───────────────────────────────────────────────────────────
	['dd_rag_api:semantic_search', { posture: 'chokepoint', via: RAG_GATE, reason: 'record hits.' }],
	[
		'dd_rag_api:embed_groups',
		{ posture: 'structure_only', reason: 'the section’s declared embed groups (ontology).' },
	],
	['dd_rag_api:retrieve', { posture: 'chokepoint', via: RAG_GATE, reason: 'passage hits.' }],
	[
		'dd_rag_api:get_agent_context',
		{ posture: 'chokepoint', via: RAG_GATE, reason: 'passage hits for the agent.' },
	],
	[
		'dd_rag_api:similar_to',
		{
			posture: 'chokepoint',
			via: RAG_GATE,
			reason:
				'neighbours of a record; every chunk (image included) needs the section grant + its component.',
		},
	],
	['dd_rag_api:ask', { posture: 'chokepoint', via: RAG_GATE, reason: 'retrieval + egress gate.' }],
	[
		'dd_rag_api:similar_objects',
		{ posture: 'chokepoint', via: RAG_GATE, reason: 'image-partition neighbours.' },
	],
	[
		'dd_rag_api:search_by_text_image',
		{ posture: 'chokepoint', via: RAG_GATE, reason: 'image-partition hits.' },
	],
	[
		'dd_rag_api:characterize_object',
		{ posture: 'chokepoint', via: RAG_GATE, reason: 'neighbour characterization.' },
	],
	// ── dd_identify_api ──────────────────────────────────────────────────────
	[
		'dd_identify_api:find_matches',
		{
			posture: 'component',
			gate: READ_DOOR_GATE,
			reason:
				'criteria through match.ts (criterionReadableOn + the path reader’s landed-section frontier); the preview thumb only for records whose previewComponent the caller may read.',
		},
	],
	[
		'dd_identify_api:identify_by_image',
		{
			posture: 'component',
			gate: READ_DOOR_GATE,
			reason:
				'every surviving hit needs the section grant whether the scope was named or omitted; labels and Type links re-gated per component; aclGate requires the section grant for every chunk.',
		},
	],
	[
		'dd_identify_api:get_proposals',
		{
			posture: 'chokepoint',
			via: 'src/ai/identify/propose.ts + vision.ts — criterionReadableOn per neighbour + the path reader’s frontier',
			reason: 'proposals quote neighbours’ values; each is per-component gated.',
		},
	],
	[
		'dd_identify_api:resolve_type_link',
		{
			posture: 'chokepoint',
			via: 'src/core/api/handlers/dd_identify_api.ts resolve_type_link — deps.componentGrant before every readValues, scopeRecords before every label',
			reason: 'Type links + labels, each re-gated.',
		},
	],
	// ── dd_external_api ──────────────────────────────────────────────────────
	[
		'dd_external_api:search',
		{
			posture: 'structure_only',
			reason: 'a third-party catalogue search through the outbound door; no matrix record is read.',
		},
	],
	// ── dd_error_report_api ──────────────────────────────────────────────────
	[
		'dd_error_report_api:receive_report',
		{ posture: 'mutating', reason: 'pre-auth report intake.' },
	],
	// ── dd_mcp_api ───────────────────────────────────────────────────────────
	[
		'dd_mcp_api:mcp_proxy',
		{
			posture: 'delegates',
			to: 'mcp:<tool> (this map’s MCP rows)',
			reason: 'runs one registered MCP tool under the caller’s principal.',
		},
	],
	['dd_mcp_api:agent_models', { posture: 'structure_only', reason: 'model catalogue.' }],
	[
		'dd_mcp_api:agent_chat',
		{
			posture: 'delegates',
			to: 'mcp:<tool> via src/ai/agent/loop.ts runTool',
			reason: 'the agent loop reaches records only through the MCP tools.',
		},
	],
	[
		'dd_mcp_api:agent_chat_stream',
		{
			posture: 'delegates',
			to: 'mcp:<tool> via src/ai/agent/loop.ts runTool',
			reason: 'as agent_chat, streamed.',
		},
	],
	[
		'dd_mcp_api:agent_apply',
		{ posture: 'mutating', reason: 'applies a change plan through the write tools.' },
	],
	// ── MCP tools (ai/mcp/registry.ts) ───────────────────────────────────────
	['mcp:dedalo_list_sections', { posture: 'structure_only', reason: 'ontology.' }],
	['mcp:dedalo_describe_section', { posture: 'structure_only', reason: 'ontology.' }],
	['mcp:dedalo_resolve', { posture: 'structure_only', reason: 'ontology label → tipo.' }],
	['mcp:dedalo_resolve_path', { posture: 'structure_only', reason: 'ontology path.' }],
	['mcp:dedalo_describe_node', { posture: 'structure_only', reason: 'ontology node.' }],
	[
		'mcp:dedalo_search_section',
		{
			posture: 'component',
			gate: READ_DOOR_GATE,
			reason:
				'principal-scoped SQO hits (locators + the section_map label through the assembler), behind the SECTION read grant asked at the tool door (authorizeComponentRead before the SQO is built — closure Step 3, SEC-1).',
		},
	],
	[
		'mcp:dedalo_search_records',
		{
			posture: 'component',
			gate: READ_DOOR_GATE,
			reason:
				'principal-scoped SQO hits, behind the SECTION read grant asked at the tool door (search.ts buildGatedSqo → authorizeComponentRead — closure Step 3, SEC-1).',
		},
	],
	[
		'mcp:dedalo_count_records',
		{
			posture: 'component',
			gate: READ_DOOR_GATE,
			reason:
				'a count, behind the SECTION read grant asked at the tool door (search.ts buildGatedSqo → authorizeComponentRead — closure Step 3, SEC-1).',
		},
	],
	[
		'mcp:dedalo_read_record',
		{
			posture: 'component',
			gate: READ_DOOR_GATE,
			reason:
				'the SECTION read grant at the door (authorizeComponentRead on (section, section) — dd_core_api Gate B, which readSection itself does not carry), then the record through the human read path (ddoIsAuthorized per ddo, the projects filter).',
		},
	],
	[
		'mcp:dedalo_get_media_info',
		{
			posture: 'component',
			gate: READ_DOOR_GATE,
			reason:
				'authorizeComponentRead on (section, field) — the section grant AND the component’s — BEFORE the record scope and the column read; the read twin of uploadMedia’s level >= 2.',
		},
	],
	['mcp:dedalo_upload_media', { posture: 'mutating', reason: 'write tool.' }],
	['mcp:dedalo_save_component', { posture: 'mutating', reason: 'write tool.' }],
	['mcp:dedalo_create_record', { posture: 'mutating', reason: 'write tool.' }],
	['mcp:dedalo_delete_record', { posture: 'mutating', reason: 'write tool.' }],
	['mcp:dedalo_set_field', { posture: 'mutating', reason: 'write tool.' }],
	['mcp:dedalo_portal_link', { posture: 'mutating', reason: 'write tool.' }],
	['mcp:dedalo_portal_unlink', { posture: 'mutating', reason: 'write tool.' }],
	['mcp:dedalo_find_or_create', { posture: 'mutating', reason: 'write tool.' }],
	['mcp:dedalo_duplicate_record', { posture: 'mutating', reason: 'write tool.' }],
	// ── outside both registries ──────────────────────────────────────────────
	[
		'http:GET /dedalo/core/api/v1/raw',
		{
			posture: 'component',
			gate: READ_DOOR_GATE,
			reason:
				'api/raw_view.ts — a fixed server-built read_raw (type section) for global admins, so the projection above applies; keeps its dd128 denylist as defense in depth.',
		},
	],
]);

/**
 * Doors that exist OUTSIDE the two registries and must still be classified.
 * The tripwire asserts each key is in the map AND that the file it names
 * exists, so a removed door is removed here too. (A TOOL's HTTP route is the
 * third source and classifies ITSELF — ToolHttpRoute.readPosture, required by
 * the loader, never `open`; the tripwire reads the loaded registry — so src/
 * never names a tool route here.)
 */
export const READ_DOOR_EXTRA_DOORS: readonly { key: string; file: string }[] = [
	{ key: 'http:GET /dedalo/core/api/v1/raw', file: 'src/core/api/raw_view.ts' },
];
