/**
 * The ToolServerModule plugin contract — what a tool package's server/index.ts
 * exports so the loader can register it and the dispatcher can call its actions.
 *
 * This is the TS re-expression of the PHP tool class shape: `const API_ACTIONS`
 * (the remote surface + declarative permission gates), `const BACKGROUND_RUNNABLE`
 * (the second allowlist for async execution), and the framework hooks
 * `is_available()` / `on_register()` / `on_remove()`.
 *
 * DESIGN CHOICE (vs the PHP reflect-a-method model): there is NO reflection. A
 * tool method exists on the API only if it is a property of `apiActions`; the
 * handler is a typed function, so PHP's "method is public + static" and
 * "signature is (object $options)" gates are structural here, not runtime
 * checks. A tool is discovered by a deterministic, allowlisted directory scan
 * (see loader.ts) — never by request-supplied names.
 */

import type { ApiEnvelope } from '../errors/schema.ts';
import type { JobLane } from '../media/jobs.ts';
import type { Principal } from '../security/permissions.ts';
import type { ReadDoorPosture } from '../security/read_door.ts';
import { currentRequestContext } from '../security/request_context.ts';

/**
 * The response every tool action returns. It REPLACES the API envelope
 * wholesale (PHP: the tool's return value is the response body) — so it IS the
 * API envelope v2 (engineering/ERRORS_SPEC.md §3): `ok(data, {requestId,
 * extend?})` on success, with a tool's extra fields (streaming bodies, `pid`,
 * `job_id`, …) as extension keys; a failure is a THROWN DedaloError, never a
 * body (a non-envelope body is refused by the dispatcher as a bug).
 */
export type ToolResponse = ApiEnvelope;

/**
 * The per-request context handed to a tool action handler. `options` are the
 * (already type-checked as an object) method arguments from the RQO; `principal`
 * and `userId` identify the authenticated caller; `background` is true when the
 * action is running under the background executor (PHP process_runner path).
 *
 * `publishProgress` is the live-progress wire (PHP print_cli($process_info) →
 * the process file the client's SSE reader polls). It is present ONLY under the
 * background executor — a foreground call has no job record to publish into — so
 * a handler must treat it as optional. The payload becomes the job frame's
 * `data`, which is what render_common's status machinery renders on every tick.
 */
export interface ToolActionContext {
	principal: Principal;
	userId: number;
	options: Record<string, unknown>;
	background: boolean;
	publishProgress?: (data: object) => void;
	/**
	 * Cooperative-cancellation signal, present ONLY under the background executor
	 * (the job manager's per-job AbortController; dd_utils_api::stop_process
	 * aborts it). A long-running handler checks `signal?.aborted` at its loop
	 * boundaries and returns a partial summary — the executor never kills work
	 * mid-write.
	 */
	signal?: AbortSignal;
	/**
	 * The proxy-validated client address, for tool actions that append an
	 * activity row (dd544 IP). Optional: a handler that logs nothing ignores it,
	 * and the background executor carries the value captured at SUBMIT time —
	 * the job outlives the request, so there is no live socket to ask.
	 */
	clientIp?: string;
	/**
	 * The request id the tool's envelope carries (`ok(data, {requestId})`).
	 * OPTIONAL because a background job outlives the request that started it (the
	 * executor threads none) — read it through `toolRequestId(context)`, never
	 * directly, so a handler running under the executor answers the job's own id
	 * from its job-owned context instead of crashing.
	 */
	requestId?: string;
	/**
	 * The lane job's id (the job manager's record — the id job_follow streams
	 * and stop_process stops), present ONLY under the background executor. A
	 * handler whose work outlives the request stores it beside its product
	 * (tool_export's manifest.background_job_id), so a reopened client can tie
	 * the product to the job that is writing it without guessing.
	 */
	backgroundJobId?: string;
}

/**
 * The request id for a tool handler's envelope: the explicitly threaded one,
 * else the request-scoped identity context — a foreground call runs inside
 * dispatchRqo's `runWithRequestContext` (the request's id); a background handler
 * runs inside the job manager's job-owned context (media/jobs.ts JobRunScope:
 * `job:<job id>`, never the long-answered submitting request's) — else '' (a
 * direct call outside any scope, e.g. a unit harness).
 */
export function toolRequestId(context: ToolActionContext): string {
	return context.requestId ?? currentRequestContext()?.requestId ?? '';
}

/**
 * One entry in a tool's apiActions map (PHP tool_security map form). `permission`
 * selects the declarative gate the framework runs BEFORE the handler:
 *  - 'section'      → read/write level `minLevel` on options.section_tipo;
 *  - 'section_list' → the same level on EVERY target `sectionTipos` pulls out of
 *                     the options (a batch action whose targets ride inside the
 *                     payload — PHP's per-file assert_section_permission loop);
 *  - 'targets'      → level `minLevel` on EVERY write target `targets` derives
 *                     from the options — each a (section_tipo, tipo?, section_id?)
 *                     triple: the component half is gated as the PAIR when
 *                     present, and a section_id must be a positive record
 *                     inside the caller's scope. THE KIND FOR AN ACTION WHOSE
 *                     EFFECT TARGET IS NOT A TOP-LEVEL OPTION: a scope that
 *                     rides in `options.sqo`, a nested client map (a
 *                     tool_config ddo_map), or a section the handler PINS by
 *                     constant. Declaring 'section'/'tipo' on such an action
 *                     asserts a right about a sibling field and leaves the
 *                     thing actually written ungated (audit CARRY-08, 2026-08-26:
 *                     three doors proven open by execution). 'section_list' is
 *                     its tipo-less, id-less special case and stays for the
 *                     pure per-section batch;
 *  - 'tipo'         → level `minLevel` on options.section_tipo + options.tipo;
 *  - 'record'       → section level + the record (numeric options.section_id) must
 *                     be inside the caller's project scope;
 *  - 'record_tipo'  → BOTH: level `minLevel` on the (section_tipo, component tipo)
 *                     PAIR *and* the record scope. This is the gate for an action
 *                     targeting a COMPONENT OF A RECORD (the whole media family).
 *                     'tipo' and 'record' each express only one half, and picking
 *                     either silently drops the other — which is how a user denied
 *                     level 2 on one media component could still delete its files;
 *  - 'developer'    → caller must be a developer (no section target asserted);
 *  - null           → NOT gated here. A NAMED EXEMPTION: see ExemptToolActionSpec
 *                     below, which requires a `gatedInHandler` string saying what
 *                     the handler does instead (or that it does nothing).
 *
 * Choosing between them: does the action name a component AND a record id? Then
 * it is 'record_tipo'. PHP asserted both at every such door
 * (assert_tipo_permission + assert_record_in_user_scope).
 */
export interface GatedToolActionSpec {
	permission:
		| 'section'
		| 'section_list'
		| 'targets'
		| 'tipo'
		| 'record'
		| 'record_tipo'
		| 'developer';
	/** dd774 level required on the target (1=read, 2=write, 3=admin). Default 2. */
	minLevel?: number;
	/**
	 * REQUIRED for 'section_list': extract the batch's section targets from the
	 * request options. Every returned value is gated at `minLevel`; an empty list
	 * or any invalid entry is a denial (fail-closed). It lives on the spec — not
	 * inside the handler — so the gate still runs BEFORE the background fork,
	 * where a denial is still observable to the caller.
	 */
	sectionTipos?: (options: Record<string, unknown>) => unknown[];
	/**
	 * REQUIRED for 'targets': derive the action's WRITE TARGETS from the request
	 * options — the very (section, component, record) triples the handler will
	 * mutate, read off the same keys the handler reads (`options.sqo`, the
	 * ddo_map, the pinned section constant). Every entry is gated at `minLevel`;
	 * an empty list, an invalid entry, or an extractor that throws is a denial
	 * (fail-closed). Pure over the options: it runs BEFORE the background fork,
	 * so it may not read the database — a target the handler can only resolve
	 * at run time (an ontology-derived portal target) is re-authorized IN the
	 * handler and named in the action_scope_binding gate's exemption prose.
	 * Gate: test/unit/action_scope_binding_tripwire.test.ts binds every handler
	 * that reads a scope off a nested key to this extractor.
	 */
	targets?: (options: Record<string, unknown>) => WriteTarget[];
	/**
	 * OPTIONAL ADMISSION: the tool's own policy on whether this request may run
	 * NOW (a per-user cap on queued background jobs, say). Called AFTER the
	 * permission gate and BEFORE the handler or the background fork, so a
	 * refusal is synchronous and nothing is queued; it refuses by throwing a
	 * typed DedaloError. The policy is the tool's — the framework only
	 * guarantees WHEN it runs.
	 *
	 * SYNCHRONOUS BY CONTRACT. For a background request the hook runs INSIDE
	 * scheduleBackground, in the same synchronous step that registers the job:
	 * a policy that counts the job registry is then a check-and-act no other
	 * request can interleave with (an `await` between the count and the
	 * registration let concurrent submissions of one user all pass a cap).
	 * A hook returning a promise is refused as `internal.invariant` — its
	 * refusal would arrive after the job was already queued.
	 */
	admit?: (context: ToolAdmissionContext) => void;
	handler: (context: ToolActionContext) => Promise<ToolResponse>;
}

/** What an action's `admit` hook sees: the caller and the request, before any work. */
export interface ToolAdmissionContext {
	principal: Principal;
	userId: number;
	options: Record<string, unknown>;
	/** True when the request asks for the background executor (`options.background_running`). */
	background: boolean;
}

/**
 * One write target a 'targets' extractor names. `section_tipo` is required;
 * `tipo` (the component) turns the level check into the PAIR check; a
 * `section_id` must be a positive existing record and is scope-checked
 * (isRecordInScope) like the 'record' kinds. The values are `unknown` on
 * purpose — they come off the request, and the gate validates each one.
 */
export interface WriteTarget {
	section_tipo: unknown;
	tipo?: unknown;
	section_id?: unknown;
}

/**
 * The OTHER member: `permission: null` — the action opts OUT of the declarative
 * gate. P2-8(a) (2026-08-24) makes that a NAMED EXEMPTION instead of a silent
 * one: the null member REQUIRES `gatedInHandler`, substantive prose naming the
 * in-handler symbol that stands in for the gate the framework is not running.
 *
 * WHY A TYPE AND NOT A CONVENTION: `permission: null` was choosable by typing
 * four characters, and nothing anywhere proved the handler gated at all. 34 specs
 * had chosen it; several of them do NOT gate. The union makes the author WRITE
 * DOWN what they are relying on, and `test/unit/tool_permission_census_tripwire.test.ts`
 * pins that set shrink-only and checks the named symbol is actually called on the
 * handler's entry path.
 *
 * WHAT THE STRING MUST SAY — the truth, not an aspiration. Three honest shapes:
 *  - a real authorization check: name the symbol, e.g. `assertPublisher()`;
 *  - a confinement that is NOT authorization (every path rebuilt from
 *    ctx.userId): say `NOT AN AUTHORIZATION GATE` and name the symbol;
 *  - nothing at all: say `UNGATED` and who can therefore reach it.
 * Inventing a gate that is not in the handler is the one unacceptable answer —
 * the census exists to be read as a to-do list, and a lie removes the entry from
 * it.
 *
 * `minLevel` / `sectionTipos` / `targets` are `never` here: they are inputs to the
 * declarative gate, so on an action that has no declarative gate they would be
 * dead decoration that reads like protection.
 */
export interface ExemptToolActionSpec {
	permission: null;
	/**
	 * The in-handler gate this exemption stands on, in prose that names its
	 * symbol — or the truthful admission that there is none (`UNGATED — …`).
	 * Census + gate: test/unit/tool_permission_census_tripwire.test.ts.
	 */
	gatedInHandler: string;
	minLevel?: never;
	sectionTipos?: never;
	targets?: never;
	/** See GatedToolActionSpec.admit (synchronous by contract). */
	admit?: (context: ToolAdmissionContext) => void;
	handler: (context: ToolActionContext) => Promise<ToolResponse>;
}

/**
 * One entry in a tool's apiActions map: either a DECLARATIVELY gated action or
 * the named `permission: null` exemption above.
 */
export type ToolActionSpec = GatedToolActionSpec | ExemptToolActionSpec;

/** The caller context passed to a tool's is_available() hook (PHP get_tools context). */
export interface ToolAvailabilityContext {
	/** The calling element's model (e.g. 'section', 'component_relation_children'). */
	callerModel: string;
	tipo: string;
	sectionTipo: string;
	isComponent: boolean;
	mode: string;
	/** The element declares `properties.tool_config[<this tool>]` (PHP `in_properties`). */
	hasToolConfig: boolean;
}

/** The object a tool package's server/index.ts must export as `tool`. */
export interface ToolServerModule {
	/** MUST equal the package directory name and match ^tool_[a-z0-9_]+$. */
	name: string;
	/** The remote action surface. Lifecycle hooks below must NEVER appear here. */
	apiActions: Record<string, ToolActionSpec>;
	/**
	 * The subset of action names allowed to run in the background (PHP
	 * BACKGROUND_RUNNABLE). An action not listed here is refused a background
	 * fork even if the client requests one; absent means no background actions.
	 */
	backgroundRunnable?: readonly string[];
	/**
	 * The JOB LANE each backgroundRunnable action spends its slot from (PERF-11).
	 *
	 * REQUIRED for every name in `backgroundRunnable` — `scheduleBackground`
	 * refuses an undeclared one (`tool.background_lane_undeclared`) and
	 * `job_lane_census_tripwire` refuses it at build time. Deliberately NOT
	 * derivable from the tool or action name: a prefix rule silently files a new
	 * action into whatever lane its name happens to resemble, which is precisely
	 * how one class of work starts starving another without anyone editing a
	 * budget.
	 */
	backgroundLanes?: Readonly<Record<string, JobLane>>;
	/**
	 * Availability hook (PHP is_available) — decides whether the tool shows in a
	 * given element's toolbar. MUST be fast and side-effect-free (the result is
	 * cached per user/tipo/section_tipo). Framework-called only.
	 */
	isAvailable?: (context: ToolAvailabilityContext) => boolean | Promise<boolean>;
	/** Registration hook (PHP on_register) — framework-called, failures logged not fatal. */
	onRegister?: () => Promise<void>;
	/** Removal hook (PHP on_remove) — framework-called, failures logged not fatal. */
	onRemove?: () => Promise<void>;
	/**
	 * HTTP GET routes the tool serves OUTSIDE `dd_tools_api` (a file download —
	 * tool_export's built artifacts). This is how a tool gets a route WITHOUT
	 * src/ naming the tool: server.ts asks the loaded registry
	 * (`loader.ts toolHttpRouteFor`), never a tool path.
	 *
	 * Safety by construction (validated by the loader, a bad route fails only its
	 * tool): the prefix grammar is `/dedalo/<seg>[/<seg>…]/`; its first segment
	 * may not be one the client tree or the engine's tool assets own
	 * (`TOOL_ROUTE_RESERVED_SEGMENTS`); two tools may not claim overlapping
	 * prefixes (first root/name wins, the other tool is refused). The router
	 * consults tool routes AFTER every engine route and just before the client
	 * static tree, so no tool route can shadow an engine one. The handler does
	 * its own authentication — the router passes the raw request.
	 */
	httpRoutes?: readonly ToolHttpRoute[];
	/**
	 * Boot hook — framework-called ONCE per serving boot (not in a smoke boot), after the registry loads (`loader.ts startToolBootHooks`).
	 * For timers the tool owns (tool_export's TTL sweeper). MUST NOT block: arm
	 * and return. The returned handle is stopped on shutdown. A throw is logged,
	 * never fatal — a tool never stops the archive from serving.
	 */
	onBoot?: () => ToolBootHandle | undefined;
}

/** One tool-served HTTP GET route (see `ToolServerModule.httpRoutes`). */
export interface ToolHttpRoute {
	/** `/dedalo/<seg>[/<seg>…]/` — lowercase [a-z0-9_] segments, trailing slash. */
	pathPrefix: string;
	/** Answer the request, or null for the engine's 404. */
	handle: (request: Request, pathname: string) => Promise<Response | null>;
	/**
	 * The route's READ POSTURE against the component read grant — the same
	 * classification every other read door carries (security/read_door.ts
	 * READ_DOOR_POSTURE). A tool route lives outside both registries the
	 * read-door census is derived from, so it CLASSIFIES ITSELF here: the loader
	 * refuses a route without one, and refuses `open` outright (a tool may not
	 * add an ungated read door); read_door_acl_tripwire lists every loaded
	 * route's posture. REQUIRED.
	 */
	readPosture: ReadDoorPosture;
}

/** What `onBoot` hands back: the stop the shutdown drain calls. */
export interface ToolBootHandle {
	stop(): void;
}

/**
 * First path segments (after `/dedalo/`) a tool route may never claim: the
 * client tree's own directories and every segment an ENGINE route lives under.
 * The router order already makes every engine route win; this keeps a tool
 * from answering the rest of an engine namespace or shadowing the client's
 * static files. The media directory (`config.mediaDir`) is refused by the
 * loader too. Kept complete by tool_http_routes_native.test.ts (every engine
 * route prefix and every client top-level directory must be covered).
 */
export const TOOL_ROUTE_RESERVED_SEGMENTS: readonly string[] = [
	'core',
	'tools',
	'test',
	'lib',
	'install',
	'upload_tmp',
	'ai_models',
];

/** The reserved lifecycle keys that must never appear inside apiActions. */
export const LIFECYCLE_KEYS: readonly string[] = [
	'isAvailable',
	'onRegister',
	'onRemove',
	'onBoot',
	'httpRoutes',
];
