/**
 * THE ERROR REGISTRY — the one closed vocabulary of failure codes for every
 * surface of the engine (HTTP envelope, tool responses, MCP structured
 * output, SSE/stream frames, logs).
 *
 * This file is a DATA TABLE. It imports nothing and computes nothing beyond
 * two derived constants (`ERROR_CODES`, `CATEGORY_STATUS` is authored). Every
 * behaviour is a lookup: category → HTTP status, code → label key, code →
 * English message, code → severity/disclosure/retryable. Anything that needs
 * a branch lives in convert.ts, not here.
 *
 * Canon: engineering/ERRORS_SPEC.md §1-2. Gate: test/unit/error_registry_native.test.ts.
 *
 * Code grammar: `<domain>.<condition>` — `^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$`.
 * Label convention: `error_<code with . → _>` unless an existing master.json
 * key already says the same thing (`no_access_page`, `external_source_*`,
 * `fail_to_save`, `search_failed`, `external_search_failed`).
 *
 * `message` is registry-owned English (logs, MCP, curl). It NEVER interpolates
 * caller data — the label + `details` do that on the client. `hint` is the
 * model-facing next move (from the former MCP HINTS table).
 */

/** The closed category set. Status is a function of category (CATEGORY_STATUS). */
export type ErrorCategory =
	| 'caller'
	| 'auth'
	| 'permission'
	| 'not_found'
	| 'conflict'
	| 'limit'
	| 'unavailable'
	| 'internal';

export type ErrorSeverity = 'info' | 'warn' | 'error' | 'fatal';

/** 'public': a vetted `publicMessage` may replace `message` on the wire. 'operator': never. */
export type ErrorDisclosure = 'public' | 'operator';

export interface ErrorSpec {
	readonly category: ErrorCategory;
	/** Must equal CATEGORY_STATUS[category] unless the code is in STATUS_EXEMPTIONS. */
	readonly status: number;
	readonly label_key: string;
	/** Registry-owned English. Never interpolates caller data. */
	readonly message: string;
	readonly severity: ErrorSeverity;
	readonly disclosure: ErrorDisclosure;
	readonly retryable: boolean;
	/** The ONLY `details` keys the converter lets onto the wire (scalars only). Label placeholders ≡ this list. */
	readonly details_keys?: readonly string[];
	/** Model-facing next move (MCP structured errors). */
	readonly hint?: string;
	/** Named exemption text — why this code exists although no engine path throws it (parity tables, reserved). */
	readonly reason?: string;
}

/** Category → HTTP status. A code needing another status is another code (or a STATUS_EXEMPTIONS entry). */
export const CATEGORY_STATUS: Readonly<Record<ErrorCategory, number>> = {
	caller: 400,
	auth: 401,
	permission: 403,
	not_found: 404,
	conflict: 409,
	limit: 429,
	unavailable: 503,
	internal: 500,
};

/** Codes whose `status` may differ from CATEGORY_STATUS[category]. Empty; every entry needs a reason next to it. */
export const STATUS_EXEMPTIONS: readonly string[] = [];

export const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

/** The label-key convention: `error_` + code with `.` → `_`. */
export function defaultLabelKey(code: string): string {
	return `error_${code.replace('.', '_')}`;
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

export const ERROR_REGISTRY = {
	// ── auth ────────────────────────────────────────────────────────────────
	'auth.not_logged': {
		category: 'auth',
		status: 401,
		label_key: 'error_auth_not_logged',
		message: 'Authentication required',
		severity: 'info',
		disclosure: 'operator',
		retryable: false,
	},
	// Category `permission` (403), NOT `auth`: the session is valid, the request
	// lacked proof of origin — HTTP's Forbidden, the status the client's
	// transparent single retry (auth.csrf_failed + fresh csrf_token) has always
	// keyed beside. The domain stays `auth` (isErrorInDomain(e, 'auth')).
	'auth.csrf_failed': {
		category: 'permission',
		status: 403,
		label_key: 'error_auth_csrf_failed',
		message: 'CSRF validation failed',
		severity: 'warn',
		disclosure: 'operator',
		retryable: true,
	},
	'auth.maintenance': {
		category: 'auth',
		status: 401,
		label_key: 'error_auth_maintenance',
		message: 'Server under maintenance',
		severity: 'info',
		disclosure: 'operator',
		retryable: true,
	},

	// ── permission ──────────────────────────────────────────────────────────
	'perm.denied': {
		category: 'permission',
		status: 403,
		label_key: 'no_access_page',
		message: 'Insufficient permissions',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
		hint:
			'The configured Dédalo user does not have permission for this action. ' +
			'Use a section this user can write, or ask an administrator to widen the profile.',
	},
	'perm.out_of_scope': {
		category: 'permission',
		status: 403,
		label_key: 'error_perm_out_of_scope',
		message: 'The record is out of the user scope',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
		hint:
			"The record exists outside the user's project scope. The user cannot " +
			'reach it; pick a record from their own search results.',
	},
	'perm.section_not_writable': {
		category: 'permission',
		status: 403,
		label_key: 'error_perm_section_not_writable',
		message: 'The section is not in the write allowlist',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
		hint:
			'The section is not in the write allowlist (DEDALO_MCP_WRITE_SECTIONS). ' +
			'Write to an allowlisted section or ask the deployer to extend the list.',
	},
	'perm.developer_required': {
		category: 'permission',
		status: 403,
		label_key: 'error_perm_developer_required',
		message: 'Developer privileges required',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},

	// ── request (caller shape) ──────────────────────────────────────────────
	// Disclosure public: the refusing site states WHAT was invalid as
	// `publicMessage` (a tool argument, a plan op) — the caller's own input
	// echoed back is the whole value of a 400 (same reasoning as resource.conflict).
	'request.invalid': {
		category: 'caller',
		status: 400,
		label_key: 'error_request_invalid',
		message: 'Invalid request',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
		hint: 'The input did not match the tool schema. Review the parameters and retry.',
	},
	'request.unknown_action': {
		category: 'caller',
		status: 400,
		label_key: 'error_request_unknown_action',
		message: 'Undefined or unauthorized method (action)',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
		details_keys: ['action'],
	},
	'request.malformed_body': {
		category: 'caller',
		status: 400,
		label_key: 'error_request_malformed_body',
		message: 'The request body is not valid JSON',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},
	'request.invalid_rqo': {
		category: 'caller',
		status: 400,
		label_key: 'error_request_invalid_rqo',
		message: 'The request object does not match the API schema',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
		details_keys: ['issue_paths'],
	},
	'request.invalid_source': {
		category: 'caller',
		status: 400,
		label_key: 'error_request_invalid_source',
		message: 'Invalid or incomplete request source',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},
	'request.invalid_tipo': {
		category: 'caller',
		status: 400,
		label_key: 'error_request_invalid_tipo',
		message: 'The identifier is not a valid ontology tipo',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
		hint:
			'The identifier is not a valid ontology tipo. Resolve names to tipos first ' +
			'(dedalo_resolve / dedalo_list_sections) — never guess a tipo.',
	},
	'request.invalid_model': {
		category: 'caller',
		status: 400,
		label_key: 'error_request_invalid_model',
		message: 'Invalid or unsupported component model',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},
	'request.invalid_options': {
		category: 'caller',
		status: 400,
		label_key: 'error_request_invalid_options',
		message: 'Invalid request options',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
	},

	// ── idempotency (CLI-01 / P0-10, WC-2026-08-28-idempotency-key) ─────────
	// The two ways a REPLAY can fail. Neither is retryable: re-sending the same
	// key produces the same answer, so a `retryable:true` here would put the
	// browser transport back in the loop this whole change set removes.
	'idempotency.key_reused': {
		category: 'conflict',
		status: 409,
		label_key: 'error_idempotency_key_reused',
		message: 'This idempotency key was already used for a different request',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
		hint: 'Mint one key per logical operation. Do not reuse a key across different requests.',
	},
	// THE AMBIGUOUS OUTCOME — the rule this whole gate turns on. The first
	// attempt's handler THREW, and the write doors it fronts commit outside any
	// transaction (section/record/duplicate_record.ts opens none at all;
	// dd_core_api:create commits its row and then fires save/activity), so
	// "it threw" does NOT mean "it wrote nothing". Re-executing on that retry is
	// exactly the duplicate-heritage-record defect CLI-01 exists to close, so the
	// retry is refused instead — and NOT retryable, because no amount of retrying
	// can turn an unknown outcome into a known one. The operator's own re-click
	// mints a NEW key and executes normally; only the automatic resend of the one
	// ambiguous attempt is stopped.
	'idempotency.outcome_unknown': {
		category: 'conflict',
		status: 409,
		label_key: 'error_idempotency_outcome_unknown',
		message: 'The first attempt failed after it may already have been applied',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
		// NAMES WHAT TO CHECK, on the wire and not only in the log: which action,
		// which request_id the failed attempt carried (so the operator can find it
		// in the access log), and what it failed with. All three are this server's
		// own identifiers, already disclosed elsewhere in every envelope.
		details_keys: ['action', 'original_request_id', 'original_error_code'],
		hint: 'Reload the record or the list and check whether the change was applied before trying again.',
	},
	// The first attempt is STILL RUNNING past the twin-wait bound (a leader stuck
	// on a row lock). The most ambiguous outcome there is: refuse, never execute.
	'idempotency.in_progress': {
		category: 'conflict',
		status: 409,
		label_key: 'error_idempotency_in_progress',
		message: 'The first attempt at this operation is still running',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
		details_keys: ['action'],
		hint: 'Wait for the operation to finish, then reload the record to see whether it was applied.',
	},
	// The original answer could not be stored (over the ledger's per-entry cap),
	// and RE-EXECUTING a non-idempotent write is the defect, not the fallback —
	// so the replay is refused and the operator reloads to see the real state.
	'idempotency.replay_unavailable': {
		category: 'conflict',
		status: 409,
		label_key: 'error_idempotency_replay_unavailable',
		message: 'The original answer for this request is no longer available',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
		hint: 'The first attempt was accepted. Reload the record instead of re-sending it.',
	},

	// ── rate limit ──────────────────────────────────────────────────────────
	'rate.limited': {
		category: 'limit',
		status: 429,
		label_key: 'error_rate_limited',
		message: 'Too many requests',
		severity: 'warn',
		disclosure: 'operator',
		retryable: true,
	},

	// ── generic not found ───────────────────────────────────────────────────
	// Disclosure public for the same reason as request.invalid: "No section
	// matches 'x'" is the caller's own reference — the sentence IS the 404.
	'resource.not_found': {
		category: 'not_found',
		status: 404,
		label_key: 'error_resource_not_found',
		message: 'Not found',
		severity: 'info',
		disclosure: 'public',
		retryable: false,
		hint: 'Nothing matches. Verify the tipo/id via discovery tools before retrying.',
	},

	// ── generic conflict ────────────────────────────────────────────────────
	// The state-based refusal with no more specific code (a picker target with
	// no active hierarchy, …). Disclosure public: the refusing site states the
	// exact conflict as `publicMessage`, which is the whole value of a 409.
	'resource.conflict': {
		category: 'conflict',
		status: 409,
		label_key: 'error_resource_conflict',
		message: 'The request conflicts with the current state',
		severity: 'info',
		disclosure: 'public',
		retryable: false,
	},

	// ── engine scope ────────────────────────────────────────────────────────
	'engine.uncovered_scope': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_engine_uncovered_scope',
		message: 'This operation is uncovered scope on this server (ledgered)',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},

	// ── section / section_id ────────────────────────────────────────────────
	'section.bad_locators': {
		category: 'caller',
		status: 400,
		label_key: 'error_section_bad_locators',
		message: 'Invalid or empty locators',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},
	'section_id.not_an_address': {
		category: 'caller',
		status: 400,
		label_key: 'error_section_id_not_an_address',
		message: 'section_id is not a record address',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},
	'section_id.numeric_shaped': {
		category: 'caller',
		status: 400,
		label_key: 'error_section_id_numeric_shaped',
		message:
			'section_id is numeric-shaped but not a record address (leading zeros or beyond safe-integer range)',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},
	'section_id.unusable_type': {
		category: 'caller',
		status: 400,
		label_key: 'error_section_id_unusable_type',
		message: 'section_id has an unusable type',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},

	// ── widget (area_maintenance) ───────────────────────────────────────────
	'widget.not_defined': {
		category: 'caller',
		status: 400,
		label_key: 'error_widget_not_defined',
		message: 'Widget name is not defined',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},
	'widget.empty': {
		category: 'caller',
		status: 400,
		label_key: 'error_widget_empty',
		message: 'Widget name is empty',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},

	// ── client-minted codes ─────────────────────────────────────────────────
	// The browser mints these itself (`new ApiError({code})` / the CORE_POLICY
	// table in client/dedalo/core/common/js/error_policy.js) — the registry is
	// still the ONE vocabulary (error_taxonomy_tripwire: every code string in
	// client/ resolves here or is `client.*`), so they carry a `reason`.
	'record.in_use': {
		category: 'conflict',
		status: 409,
		label_key: 'error_record_in_use',
		message: 'The record is being edited by another user',
		severity: 'warn',
		disclosure: 'operator',
		retryable: true,
		reason:
			'Client-minted (page.js) from the lock outcome — section/locks.ts answers ' +
			'`ok:true, in_use:true` (a lock is not a failure); the CORE_POLICY routes it to a modal.',
	},
	'lock.update_state': {
		category: 'conflict',
		status: 409,
		label_key: 'error_lock_update_state',
		message: 'The lock keep-alive could not be updated',
		severity: 'info',
		disclosure: 'operator',
		retryable: true,
		reason:
			'CORE_POLICY key only (action silent): the lock keep-alive poll is background ' +
			'chatter the client never surfaces. No server path throws it.',
	},
	'validation.invalid_date_format': {
		category: 'caller',
		status: 400,
		label_key: 'error_validation_invalid_date_format',
		message: 'The date format is invalid',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
		reason:
			'Client-minted (component_date.js) for browser-side date validation before any ' +
			'request leaves; the `validation.*` CORE_POLICY entry renders it inline.',
	},
	'validation.password_policy': {
		category: 'caller',
		status: 400,
		label_key: 'error_validation_password_policy',
		message: 'The password does not meet the password policy',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
		details_keys: ['rule'],
	},
	'request.invalid_context': {
		category: 'caller',
		status: 400,
		label_key: 'error_request_invalid_context',
		message: 'The page context could not be built',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
		reason:
			'CORE_POLICY key (action page_panel) reserved for the page builder — a start/read ' +
			'whose context cannot be built. No server path throws it yet.',
	},

	// ── record ──────────────────────────────────────────────────────────────
	'record.dataframe_unduplicable': {
		category: 'conflict',
		status: 409,
		label_key: 'error_record_dataframe_unduplicable',
		message:
			'The record cannot be duplicated: a dataframe field frames a record the copy cannot own',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
		// The slot the curator has to repair, and which of the five refusal
		// branches fired. PUBLIC because acting on this needs both: the actor
		// holds write on the host record, so neither is news to them.
		details_keys: ['component_tipo', 'reason'],
	},
	'record.delete_children_refused': {
		category: 'conflict',
		status: 409,
		label_key: 'error_record_delete_children_refused',
		message: 'Some child records could not be deleted; the parent was kept',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
		details_keys: ['not_deleted'],
	},
	'record.remove_without_id': {
		category: 'caller',
		status: 400,
		label_key: 'error_record_remove_without_id',
		// THE REMOVE SENTINEL (DATA-06, 2026-08-30). A `remove` change that names
		// no item id used to empty the component in EVERY language and answer
		// ok:true — while a remove naming a WRONG id failed the save. The null id
		// is every caller's unknown-id sentinel (an unsaved row, `item.id || null`
		// collapsing 0, an omitted MCP `item_id`), never "all", so the engine
		// refuses it and the wipe is the separate `clear` action.
		// PUBLIC: the actor holds write on the component, the answer is entirely
		// about the request THEY sent, and a refusal nobody can read is a delete
		// button that silently does nothing.
		message: "A 'remove' must name the item id it removes",
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
	},
	'record.save_failed': {
		category: 'internal',
		status: 500,
		label_key: 'fail_to_save',
		message: 'The record could not be saved',
		severity: 'error',
		disclosure: 'operator',
		retryable: false,
	},

	// ── search ──────────────────────────────────────────────────────────────
	'search.failed': {
		category: 'internal',
		status: 500,
		label_key: 'search_failed',
		message: 'The search could not be completed',
		severity: 'error',
		disclosure: 'operator',
		retryable: false,
	},

	// ── tree ────────────────────────────────────────────────────────────────
	'tree.cycle': {
		category: 'conflict',
		status: 409,
		label_key: 'error_tree_cycle',
		message: 'The move would create a cycle in the tree',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},

	// ── tools (dd_tools_api dispatch + job status) ──────────────────────────
	'tool.invalid_name': {
		category: 'caller',
		status: 400,
		label_key: 'error_tool_invalid_name',
		message: 'Invalid tool name',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},
	'tool.not_authorized': {
		category: 'permission',
		status: 403,
		label_key: 'error_tool_not_authorized',
		message: 'Tool not active or not authorized for the current user',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},
	'tool.no_server_module': {
		category: 'caller',
		status: 400,
		label_key: 'error_tool_no_server_module',
		message: 'The tool has no server module',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},
	'tool.method_not_allowed': {
		category: 'caller',
		status: 400,
		label_key: 'error_tool_method_not_allowed',
		message: 'Tool method not allowed',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
		details_keys: ['method'],
	},
	'tool.invalid_target': {
		category: 'caller',
		status: 400,
		label_key: 'error_tool_invalid_target',
		message: 'Invalid or conflicting permission target',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
		reason:
			'Registered by WC-2026-08-15-tool-response-envelope-v2 for the tools/security.ts ' +
			'permission-target refusal; that gate still answers a PermissionCheck token that ' +
			'dispatch.ts maps through LEGACY_TOKEN_MAP (request.invalid). The P3 tools sweep ' +
			'throws this code at the source.',
	},
	'tool.background_not_allowed': {
		category: 'caller',
		status: 400,
		label_key: 'error_tool_background_not_allowed',
		message: 'Method not allowed for background execution',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},
	/**
	 * A backgroundRunnable action whose module declares NO lane for it (PERF-11).
	 * Distinct from `background_not_allowed`, which says the action may not run in
	 * the background at all: this one says it may, but the module never said which
	 * budget it spends — and a lane guessed from the action name is exactly how a
	 * new job silently starves another class of work.
	 */
	'tool.background_lane_undeclared': {
		category: 'internal',
		status: 500,
		label_key: 'error_tool_background_lane_undeclared',
		message: 'Background action declares no job lane',
		severity: 'error',
		disclosure: 'operator',
		retryable: false,
	},
	'tool.job_not_found': {
		category: 'not_found',
		status: 404,
		label_key: 'error_tool_job_not_found',
		message: 'Background job not found',
		severity: 'info',
		disclosure: 'operator',
		retryable: false,
	},

	// ── export (tool_export's server-built files) ───────────────────────────
	// The export job writes a spool + files under the export store
	// (tools/tool_export/server/artifact_store.ts); every refusal of that path
	// is one of these. Throw sites: artifact_store.ts, spool_reader.ts,
	// writers/types.ts (the shared limit + cancel helpers the writers call).
	// The user stopped the export (stop_process); the partial spool is deleted.
	// `conflict`, not `caller`: nothing in the request was wrong — the
	// artifact's state is what refuses. A lane DEADLINE is not a stop:
	// export.deadline_exceeded.
	'export.cancelled': {
		category: 'conflict',
		status: 409,
		label_key: 'error_export_cancelled',
		message: 'The export was stopped before it finished',
		severity: 'info',
		disclosure: 'operator',
		retryable: false,
	},
	// The export ran past its lane's deadline (DEDALO_JOB_DEADLINE_EXPORT_S — an
	// operator limit, not the user's stop) and was aborted; the partial spool is
	// deleted. `limit`: the same selection will hit it again — export fewer
	// records or columns, or the operator raises the limit. `limit_s` = the
	// deadline in seconds. Throw site: tools/tool_export/server/export_job.ts.
	'export.deadline_exceeded': {
		category: 'limit',
		status: 429,
		label_key: 'error_export_deadline_exceeded',
		message: 'The export ran longer than this server allows and was stopped',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
		details_keys: ['limit_s'],
	},
	// A file format's hard ceiling the export exceeds and that cannot be split
	// around (XLSX/ODS: 16,384 columns). Rows are NOT this code — they split into
	// sheets. `caller`: the same selection can never fit, retrying is pointless.
	'export.format_limit': {
		category: 'caller',
		status: 400,
		label_key: 'error_export_format_limit',
		message: 'The export exceeds a limit of the requested file format',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
		details_keys: ['format', 'limit'],
	},
	// The export exists but has not ended (still running, or it failed / was
	// interrupted before its 'end' line): a file can only be built from a whole
	// spool. Retryable — a running export finishes.
	'export.artifact_not_ready': {
		category: 'conflict',
		status: 409,
		label_key: 'error_export_artifact_not_ready',
		message: 'The export has not finished yet',
		severity: 'info',
		disclosure: 'operator',
		retryable: true,
	},
	// The export is in use and cannot be deleted: it is still running, or a file
	// is being built from it (tool_export.delete_export_job). `conflict`: the
	// artifact's state refuses, not the request. Retryable — a stopped export or
	// a finished build frees it (the owner stops a running export first).
	'export.artifact_busy': {
		category: 'conflict',
		status: 409,
		label_key: 'error_export_artifact_busy',
		message: 'The export is running or a file is being built from it',
		severity: 'info',
		disclosure: 'operator',
		retryable: true,
	},
	// The user's export files would exceed DEDALO_EXPORT_ARTIFACTS_QUOTA_BYTES.
	// `limit` (429): the user holds too much; deleting older exports
	// (tool_export.delete_export_job) or the TTL sweep expiring them makes the
	// same request succeed.
	'export.artifact_quota': {
		category: 'limit',
		status: 429,
		label_key: 'error_export_artifact_quota',
		message: 'The export storage quota for this user is full',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
		details_keys: ['quota_bytes'],
	},
	// The user already keeps DEDALO_EXPORT_ARTIFACTS_MAX_EXPORTS exports (a count
	// cap beside the byte quota: tiny exports cost almost no bytes, yet every
	// list/reclaim reads each one). Deleting older exports or the TTL sweep
	// makes the same request succeed.
	'export.artifact_count': {
		category: 'limit',
		status: 429,
		label_key: 'error_export_artifact_count',
		message: 'This user already keeps the maximum number of exports',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
		details_keys: ['max_exports'],
	},
	// The export volume would fall below DEDALO_EXPORT_ARTIFACTS_MIN_FREE_BYTES
	// free — an installation-wide floor, whatever the users' quotas (the default
	// root shares the private volume with the session store and the settings).
	// `unavailable` (503): nothing the caller did; space freed by the sweep, a
	// delete or the operator makes the same request succeed.
	'export.storage_low': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_export_storage_low',
		message: 'The export volume is short of free space',
		severity: 'error',
		disclosure: 'operator',
		retryable: true,
	},
	// Per-user admission on the shared export lane: refused at SUBMIT, nothing queued.
	'export.too_many_jobs': {
		category: 'limit',
		status: 429,
		label_key: 'error_export_too_many_jobs',
		message: 'This user already has the maximum number of export jobs queued or running',
		severity: 'warn',
		disclosure: 'operator',
		retryable: true,
		details_keys: ['limit'],
	},
	// Unknown / expired / not-yours / disallowed name — ONE answer for all of
	// them, so the store never tells a caller which of the four it was.
	'export.artifact_not_found': {
		category: 'not_found',
		status: 404,
		label_key: 'error_export_artifact_not_found',
		message: 'The export was not found or has expired',
		severity: 'info',
		disclosure: 'operator',
		retryable: false,
	},
	// The export directory cannot be used: not writable, or — under the test
	// seam — a root that carries no test marker (nothing is written).
	'export.store_unavailable': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_export_store_unavailable',
		message: 'The export storage directory is not usable',
		severity: 'error',
		disclosure: 'operator',
		retryable: false,
	},

	// ── MCP / agent ─────────────────────────────────────────────────────────
	// The `mcp.*` refusals are MODEL-FACING: the tool authors the sentence FOR
	// the model (which record matched, which op is wrong) — disclosure public,
	// the tool's `publicMessage` is the message. `hint` is the registry's next move.
	'mcp.label_ambiguous': {
		category: 'caller',
		status: 400,
		label_key: 'error_mcp_label_ambiguous',
		message: 'More than one field matches that label',
		severity: 'info',
		disclosure: 'public',
		retryable: false,
		hint:
			'More than one field matches that label. Pick one of the returned ' +
			'candidates by its tipo and retry with the tipo.',
	},
	'mcp.ambiguous_match': {
		category: 'caller',
		status: 400,
		label_key: 'error_mcp_ambiguous_match',
		message: 'More than one record matches',
		severity: 'info',
		disclosure: 'public',
		retryable: false,
		hint:
			'More than one record matches. Refine the match fields or pick one of ' +
			'the returned candidates and use its section_id directly.',
	},
	'mcp.media_path_disabled': {
		category: 'caller',
		status: 400,
		label_key: 'error_mcp_media_path_disabled',
		message: 'File-path media sources are disabled on this install',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
		hint:
			'File-path media sources are disabled (DEDALO_MCP_MEDIA_IMPORT_DIR is not set). ' +
			'Send the file as base64 instead, or ask the deployer to configure the import dir.',
	},
	'mcp.media_too_large': {
		category: 'caller',
		status: 400,
		label_key: 'error_mcp_media_too_large',
		message: 'The file exceeds the configured media size limit',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
		details_keys: ['max_bytes'],
		hint: 'The file exceeds DEDALO_MCP_MEDIA_MAX_BYTES. Reduce it or raise the limit.',
	},
	// The MCP proxy's stale/missing session id. Category `auth`, message is the
	// LITERAL an MCP client's stale-session recovery matches on (kept exact).
	'mcp.session_invalid': {
		category: 'auth',
		status: 401,
		label_key: 'error_mcp_session_invalid',
		message: 'No valid MCP session ID provided',
		severity: 'info',
		disclosure: 'operator',
		retryable: true,
		hint: 'Re-run initialize to mint a session id and send it as mcp_session_id.',
	},
	'mcp.plan_hash_mismatch': {
		category: 'conflict',
		status: 409,
		label_key: 'error_mcp_plan_hash_mismatch',
		message: 'The change plan differs from what was confirmed',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
		hint:
			'The change plan differs from what was confirmed. Re-propose the plan and ' +
			'confirm it again — never edit a confirmed plan in place.',
	},
	'mcp.egress_restricted': {
		category: 'permission',
		status: 403,
		label_key: 'error_mcp_egress_restricted',
		message: 'This content is restricted from external model providers',
		severity: 'info',
		disclosure: 'public',
		retryable: false,
		hint:
			'This content is restricted from external model providers and was not included. ' +
			'Answer without it, or suggest the user switch this conversation to a model ' +
			'marked "local" in the model picker to include restricted records.',
	},

	// A write tool called on a surface whose write opt-in is off — a deployment
	// posture, not the user's profile (that is perm.denied).
	'mcp.write_disabled': {
		category: 'permission',
		status: 403,
		label_key: 'error_mcp_write_disabled',
		message: 'Write tools are not enabled on this surface',
		severity: 'info',
		disclosure: 'operator',
		retryable: false,
		hint:
			'This surface is read-only (DEDALO_MCP_ALLOW_WRITE / DEDALO_AGENT_ALLOW_WRITE is off). ' +
			'Answer without writing, or ask the deployer to enable write mode.',
	},

	// ── external services (one code per ExternalErrorKind) ──────────────────
	'external.disabled': {
		category: 'unavailable',
		status: 503,
		label_key: 'external_source_disabled',
		message: 'External source disabled',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},
	'external.not_registered': {
		category: 'unavailable',
		status: 503,
		label_key: 'external_source_misconfigured',
		message: 'The ontology names an external service no adapter implements',
		severity: 'error',
		disclosure: 'operator',
		retryable: false,
	},
	'external.bad_config': {
		category: 'unavailable',
		status: 503,
		label_key: 'external_source_misconfigured',
		message: 'The external service configuration is malformed or refused',
		severity: 'error',
		disclosure: 'operator',
		retryable: false,
	},
	'external.circuit_open': {
		category: 'unavailable',
		status: 503,
		label_key: 'external_source_circuit_open',
		message: 'External source temporarily suspended after repeated failures',
		severity: 'warn',
		disclosure: 'operator',
		retryable: true,
	},
	'external.blocked_host': {
		category: 'unavailable',
		status: 503,
		label_key: 'external_source_misconfigured',
		message: 'The external host is not allowed',
		severity: 'error',
		disclosure: 'operator',
		retryable: false,
	},
	'external.timeout': {
		category: 'unavailable',
		status: 503,
		label_key: 'external_source_timeout',
		message: 'The external source did not answer in time',
		severity: 'warn',
		disclosure: 'operator',
		retryable: true,
	},
	'external.transport': {
		category: 'unavailable',
		status: 503,
		label_key: 'external_source_unavailable',
		message: 'The external source could not be reached',
		severity: 'error',
		disclosure: 'operator',
		retryable: true,
	},
	'external.http_status': {
		category: 'unavailable',
		status: 503,
		label_key: 'external_source_unavailable',
		message: 'The external source answered with an error status',
		severity: 'error',
		disclosure: 'operator',
		retryable: true,
	},
	'external.too_large': {
		category: 'unavailable',
		status: 503,
		label_key: 'external_source_unavailable',
		message: 'The external response exceeded the byte ceiling',
		severity: 'error',
		disclosure: 'operator',
		retryable: true,
	},
	'external.protocol': {
		category: 'unavailable',
		status: 503,
		label_key: 'external_source_unavailable',
		message: 'The external response was not the shape the contract requires',
		severity: 'error',
		disclosure: 'operator',
		retryable: true,
	},
	'external.not_found': {
		category: 'not_found',
		status: 404,
		label_key: 'external_source_not_found',
		message: 'Record not found in the external source',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},

	// ── identify (object identification) ────────────────────────────────────
	'identify.missing_seed': {
		category: 'caller',
		status: 400,
		label_key: 'error_identify_missing_seed',
		message: 'Missing or invalid seed (section_tipo, section_id)',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},
	'identify.missing_section': {
		category: 'caller',
		status: 400,
		label_key: 'error_identify_missing_section',
		message: 'Missing or invalid section_tipo',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},
	'identify.invalid_profile': {
		category: 'caller',
		status: 400,
		label_key: 'error_identify_invalid_profile',
		message: 'The identification profile is invalid',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
	},
	'identify.no_profile': {
		category: 'caller',
		status: 400,
		label_key: 'error_identify_no_profile',
		message: 'The section has no identification profile',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},
	'identify.invalid_source': {
		category: 'caller',
		status: 400,
		label_key: 'error_identify_invalid_source',
		message: 'The requested identification source is invalid',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
	},
	'identify.rag_disabled': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_identify_rag_disabled',
		message: 'RAG is disabled',
		severity: 'info',
		disclosure: 'operator',
		retryable: false,
	},
	'identify.media_disabled': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_identify_media_disabled',
		message: 'RAG media is disabled',
		severity: 'info',
		disclosure: 'operator',
		retryable: false,
	},
	'identify.missing_image': {
		category: 'caller',
		status: 400,
		label_key: 'error_identify_missing_image',
		message: 'Missing image (base64 or data: URL)',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},
	'identify.invalid_image': {
		category: 'caller',
		status: 400,
		label_key: 'error_identify_invalid_image',
		message: 'The image is not decodable',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},
	'identify.image_too_large': {
		category: 'caller',
		status: 400,
		label_key: 'error_identify_image_too_large',
		message: 'The image exceeds the size limit',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
		details_keys: ['max_bytes'],
	},
	'identify.egress_forbidden': {
		category: 'permission',
		status: 403,
		label_key: 'error_identify_egress_forbidden',
		message:
			'The configured provider would send object images off this host under a local-only policy',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
	},
	'identify.provider_unavailable': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_identify_provider_unavailable',
		message: 'The multimodal embedding provider is unavailable',
		severity: 'error',
		disclosure: 'public',
		retryable: true,
	},
	'identify.embed_failed': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_identify_embed_failed',
		message: 'The multimodal provider returned no embedding for this image',
		severity: 'error',
		disclosure: 'public',
		retryable: true,
	},
	'identify.empty_index': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_identify_empty_index',
		message: 'Nothing has been indexed to compare against; run the image indexer first',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
	},
	'identify.no_type_section': {
		category: 'caller',
		status: 400,
		label_key: 'error_identify_no_type_section',
		message: 'The identification profile declares no Type section',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
	},
	'identify.no_link_component': {
		category: 'caller',
		status: 400,
		label_key: 'error_identify_no_link_component',
		message: 'No criterion in the profile links this section to its Type section in one hop',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
	},

	// ── site builder ────────────────────────────────────────────────────────
	// ── rag (dd_rag_api — src/ai/rag/api.ts) ──────────────────────────────
	'rag.disabled': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_rag_disabled',
		message: 'RAG is disabled',
		severity: 'info',
		disclosure: 'operator',
		retryable: false,
	},
	'rag.media_disabled': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_rag_media_disabled',
		message: 'RAG media is disabled',
		severity: 'info',
		disclosure: 'operator',
		retryable: false,
	},
	// Thrown by the retrieval read path (src/ai/rag/retrieval.ts) when the
	// embedding provider answers a query batch SHORT — the documented fail-closed
	// answer of SidecarEmbeddingProvider.embed(), returned on every ordinary
	// sidecar hiccup (non-ok HTTP, malformed body, non-numeric row, fetch throw,
	// abort timeout). Without this refusal the dense leg ran with no query vector
	// and returned arbitrary rows (AIX-01, audit 2026-08-26). `unavailable` +
	// retryable: the sidecar coming back makes the same query succeed.
	'rag.embedding_unavailable': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_rag_embedding_unavailable',
		message: 'The embedding service did not return a query vector',
		severity: 'error',
		disclosure: 'operator',
		retryable: true,
	},
	'rag.generation_failed': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_rag_generation_failed',
		message: 'The grounded answer could not be generated',
		severity: 'error',
		disclosure: 'operator',
		retryable: true,
	},

	'site_builder.unconfigured': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_site_builder_unconfigured',
		message: 'The site builder is not configured on this install',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},
	'site_builder.unreachable': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_site_builder_unreachable',
		message: 'The site builder daemon could not be reached',
		severity: 'error',
		disclosure: 'operator',
		retryable: true,
	},
	'site_builder.auth': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_site_builder_auth',
		message: 'The site builder daemon rejected the engine token',
		severity: 'error',
		disclosure: 'operator',
		retryable: false,
	},
	/**
	 * THE PAIRING PROOF FAILED (2026-08-29). The daemon at the configured address did not
	 * publish the fingerprint this engine's DEDALO_SITE_BUILDER_INSTANCE +
	 * DEDALO_SITE_BUILDER_TOKEN imply, so it is not the instance this install is paired
	 * with (or does not hold the same shared bearer). Nothing was sent.
	 *
	 * `operator` disclosure and one undifferentiated message, on purpose: a wrong instance
	 * name, an unknown instance and a wrong token must be indistinguishable to the caller,
	 * or the refusal becomes an oracle enumerating a host's museums. The operator's half —
	 * which key to look at — is in the server log.
	 */
	'site_builder.instance_mismatch': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_site_builder_instance_mismatch',
		message: 'The site builder daemon is not the paired instance',
		severity: 'error',
		disclosure: 'operator',
		retryable: false,
	},
	'site_builder.rejected': {
		category: 'caller',
		status: 400,
		label_key: 'error_site_builder_rejected',
		message: 'The site builder rejected the request',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
	},
	'site_builder.failed': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_site_builder_failed',
		message: 'The site builder reported an error',
		severity: 'error',
		disclosure: 'operator',
		retryable: true,
	},
	'site_builder.stream_lost': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_site_builder_stream_lost',
		message: 'The site builder stream was lost',
		severity: 'error',
		disclosure: 'operator',
		retryable: true,
	},
	/**
	 * THE DAEMON WILL NOT RUN THE AGENT ON THIS HOST AS IT STANDS (2026-10-01). Its 503
	 * `confinement_unavailable` / `confinement.*` refusals that an OPERATOR must act on: the
	 * host cannot confine a run, a site has no agent identity, PID 1 loaded a unit that is not
	 * what the daemon expects, a unit refused to start, or the installed agent CLI cannot be
	 * told to ignore agent-written configuration (PLANT). Not retryable: nothing changes until
	 * someone does. The daemon's own sentence (which names the key or command) is log-only.
	 */
	'site_builder.confinement_unavailable': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_site_builder_confinement_unavailable',
		message: 'The site builder cannot run its agent safely on this server',
		severity: 'error',
		disclosure: 'operator',
		retryable: false,
	},
	/**
	 * THE SITE IS BUSY ON THE DAEMON'S SIDE (2026-10-01): a run of this site is still alive or
	 * being proved dead (`confinement.site_busy`, `identity_quarantined`), or the daemon is
	 * restarting (`daemon_stopping`). Retryable — it clears without anyone acting.
	 */
	'site_builder.busy': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_site_builder_busy',
		message: 'The site builder is busy with this site',
		severity: 'warn',
		disclosure: 'operator',
		retryable: true,
	},

	// ── publication host (src/core/publication_host/ — PUBLICATION_HOST_SPEC §2) ──
	// The engine's side of its paired publication-host agents. One code per thing the panel
	// must tell apart. The agent's own prose is LOG-ONLY (src/core/publication_host/wire.ts),
	// so no agent can write a browser's error text. `rejected` is the one public code: its
	// sentence is ENGINE-authored, chosen by a closed machine `reason`. `rejected` and
	// `failed` carry that reason in `details` (always a closed-list member or 'unspecified'),
	// and only wire.ts mints them (publication_host_wire_native source law).
	'publication_host.unconfigured': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_publication_host_unconfigured',
		message:
			'The publication host is not registered on this install, or its credentials are missing',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},
	/**
	 * THE REGISTRY FILE IS CORRUPT OR HAND-EDITED INTO AN INVALID SHAPE (phase-3 Review Focus 2).
	 * Never read as "no hosts" and never as a partial list: every action refuses until an
	 * operator repairs the file or re-pairs. Not retryable — nothing changes until someone acts.
	 */
	'publication_host.registry_invalid': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_publication_host_registry_invalid',
		message: 'The publication host registry is unreadable or invalid',
		severity: 'error',
		disclosure: 'operator',
		retryable: false,
	},
	'publication_host.unreachable': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_publication_host_unreachable',
		message: 'The publication host agent could not be reached',
		severity: 'error',
		disclosure: 'operator',
		retryable: true,
	},
	'publication_host.timeout': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_publication_host_timeout',
		message: 'The publication host agent did not answer in time',
		severity: 'error',
		disclosure: 'operator',
		retryable: true,
	},
	/**
	 * THE PAIRING PROOF FAILED: the agent at the registered address did not publish the
	 * fingerprint this engine's registry instance + token imply. Nothing was sent — not the
	 * bearer, not the actor, not the request. One undifferentiated message on purpose: a wrong
	 * instance and a wrong token must be indistinguishable (same reasoning as
	 * site_builder.instance_mismatch); which one it is lives in the server log.
	 */
	'publication_host.pairing_mismatch': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_publication_host_pairing_mismatch',
		message: 'The publication host agent is not the paired instance',
		severity: 'error',
		disclosure: 'operator',
		retryable: false,
	},
	'publication_host.auth': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_publication_host_auth',
		message: 'The publication host agent rejected the engine credentials',
		severity: 'error',
		disclosure: 'operator',
		retryable: false,
	},
	'publication_host.rejected': {
		category: 'caller',
		status: 400,
		label_key: 'error_publication_host_rejected',
		message: 'The publication host refused the request',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
		details_keys: ['reason'],
	},
	/**
	 * THE AGENT COULD NOT CARRY OUT A HOST EFFECT (a 5xx: reload, restart, health), answered
	 * a route it does not know (404/405 with a valid bearer = version skew), or answered
	 * something this engine cannot take (an oversized or unreadable body). Not retryable:
	 * repeating the command before an operator acts repeats the refusal. The agent restores
	 * the previous state before answering (phase-2 Review Focus 3/4).
	 */
	'publication_host.failed': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_publication_host_failed',
		message: 'The publication host could not carry out the action',
		severity: 'error',
		disclosure: 'operator',
		retryable: false,
		details_keys: ['reason'],
	},
	'publication_host.busy': {
		category: 'conflict',
		status: 409,
		label_key: 'error_publication_host_busy',
		message: 'The publication host is busy with another operation',
		severity: 'warn',
		disclosure: 'operator',
		retryable: true,
	},

	// ── publication host setup (the panel's "New publication host": drafts, kit, package) ──
	// engineering/PUBLICATION_HOST_SPEC.md §9.14. Not the publication_host.* family: nothing here
	// is an agent answer (that family's codes are what a dialled agent call can end in). Every
	// sentence is ENGINE-authored (the widget's), so the three refusals are public; the field list
	// and the closed reasons ride `details` so the client names the input or the cause.
	'publication_host_setup.draft_invalid': {
		category: 'caller',
		status: 400,
		label_key: 'error_publication_host_setup_draft_invalid',
		message: 'The publication host draft was refused',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
		details_keys: ['fields'],
	},
	/** The drafts file is corrupt or hand-edited: never read as "no drafts" (the registry's rule). */
	'publication_host_setup.drafts_invalid': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_publication_host_setup_drafts_invalid',
		message: 'The publication host drafts file is unreadable or invalid',
		severity: 'error',
		disclosure: 'operator',
		retryable: false,
	},
	/** The kit could not be built from this release (kit_build.ts KitBuildReason). */
	'publication_host_setup.kit_refused': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_publication_host_setup_kit_refused',
		message: 'The publication host kit could not be built',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
		details_keys: ['reason'],
	},
	/** An uploaded pairing package was refused before anything was stored (pair_flow.ts reasons + the package's). */
	'publication_host_setup.pairing_refused': {
		category: 'caller',
		status: 400,
		label_key: 'error_publication_host_setup_pairing_refused',
		message: 'The publication host pairing was refused',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
		details_keys: ['reason'],
	},

	// ── mailer ──────────────────────────────────────────────────────────────
	'mailer.not_configured': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_mailer_not_configured',
		message: 'The mailer is not configured on this install',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},
	'mailer.invalid_recipient': {
		category: 'caller',
		status: 400,
		label_key: 'error_mailer_invalid_recipient',
		message: 'Invalid recipient address',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},
	'mailer.send_failed': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_mailer_send_failed',
		message: 'The message could not be sent',
		severity: 'error',
		disclosure: 'operator',
		retryable: true,
	},

	// ── password reset ──────────────────────────────────────────────────────
	'password_reset.invalid_or_expired': {
		category: 'caller',
		status: 400,
		label_key: 'error_password_reset_invalid_or_expired',
		message: 'The reset link is invalid or has expired',
		severity: 'info',
		disclosure: 'operator',
		retryable: false,
	},
	'password_reset.too_many_attempts': {
		category: 'limit',
		status: 429,
		label_key: 'error_password_reset_too_many_attempts',
		message: 'Too many attempts; try again later',
		severity: 'warn',
		disclosure: 'operator',
		retryable: true,
	},
	'password_reset.weak_password': {
		category: 'caller',
		status: 400,
		label_key: 'error_password_reset_weak_password',
		message: 'The password does not meet the strength requirements',
		severity: 'info',
		disclosure: 'operator',
		retryable: false,
	},
	'password_reset.failed': {
		category: 'internal',
		status: 500,
		label_key: 'error_password_reset_failed',
		message: 'The password could not be reset',
		severity: 'error',
		disclosure: 'operator',
		retryable: false,
	},

	// ── diffusion server control ────────────────────────────────────────────
	'diffusion.invalid_process_id': {
		category: 'caller',
		status: 400,
		label_key: 'error_diffusion_invalid_process_id',
		message: 'Invalid diffusion process id',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},
	'diffusion.invalid_job_id': {
		category: 'caller',
		status: 400,
		label_key: 'error_diffusion_invalid_job_id',
		message: 'Invalid diffusion job id',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},
	'diffusion.not_requeueable': {
		category: 'conflict',
		status: 409,
		label_key: 'error_diffusion_not_requeueable',
		message: 'The job is not in a state that can be re-queued',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},
	'diffusion.invalid_action': {
		category: 'caller',
		status: 400,
		label_key: 'error_diffusion_invalid_action',
		message: 'Invalid diffusion server action',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},
	'diffusion.already_draining': {
		category: 'conflict',
		status: 409,
		label_key: 'error_diffusion_already_draining',
		message: 'The diffusion server is already draining',
		severity: 'info',
		disclosure: 'operator',
		retryable: false,
	},

	// A diffusion runner failure the run itself did not type (the persisted job
	// `result` + the follow stream frame carry it; the cause is log-only —
	// engineering/ERRORS_SPEC.md §5).
	'diffusion.run_failed': {
		category: 'internal',
		status: 500,
		label_key: 'error_diffusion_run_failed',
		message: 'An unexpected error stopped the diffusion run',
		severity: 'error',
		disclosure: 'operator',
		retryable: false,
	},
	// The scheduler claimed the job but the runner process never started (a
	// deployment fault: interpreter path, cwd) — failed, never re-queued.
	// The persisted OUTCOME of a job the user stopped (runner.ts / queue.ts
	// finishJob 'cancelled'): a job result is `{ok:false, error}` like any
	// failure record, and the cancellation is the coded fact — never a status
	// on the HTTP wire (the cancel action itself answers ok:true).
	'diffusion.cancelled': {
		category: 'caller',
		status: 400,
		label_key: 'error_diffusion_cancelled',
		message: 'Process cancelled by user',
		severity: 'info',
		disclosure: 'operator',
		retryable: false,
	},
	// The sweeper's verdict on a running job whose heartbeat went stale past
	// its attempt budget (queue.ts sweepStaleJobs): the runner is gone.
	'diffusion.runner_lost': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_diffusion_runner_lost',
		message: 'The diffusion runner was lost (heartbeat stale) after the attempt budget',
		severity: 'error',
		disclosure: 'operator',
		retryable: true,
		details_keys: ['attempts'],
	},
	// A runner (or the scheduler acting for one) tried to write to a job row it
	// no longer owns: the lease is (job_id, attempt) and the sweeper's requeue
	// handed the row to a NEW attempt. The loser aborts without writing —
	// engineering/wire_contract/WC-2026-09-05-diffusion-lease-epoch-fence.md.
	// Never a caller-facing HTTP failure: it is a runner-process abort.
	'diffusion.lease_revoked': {
		category: 'conflict',
		status: 409,
		label_key: 'error_diffusion_lease_revoked',
		message: 'The diffusion job lease was revoked (the row belongs to a newer attempt)',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},
	// DIFF-3: a second diffuse on an (element, section) with an ACTIVE run that
	// is not the caller's own identical request (another owner, or another
	// selection). The body names nothing of the live run (queue.ts
	// enqueueDiffusionJob; WC-2026-09-30-diffusion-attach-scope).
	'diffusion.target_busy': {
		category: 'conflict',
		status: 409,
		label_key: 'error_diffusion_target_busy',
		message: 'The publication target is busy with another run; retry when it finishes',
		severity: 'warn',
		disclosure: 'public',
		retryable: true,
	},
	'diffusion.runner_spawn_failed': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_diffusion_runner_spawn_failed',
		message: 'The diffusion runner process could not be started',
		severity: 'error',
		disclosure: 'operator',
		retryable: false,
	},
	// The element's diffusion config does not compile (PlanCompileError). The
	// operator authored that config; the compiler's per-cause list is the
	// `publicMessage` — public, because the report's cause list IS the fix.
	'diffusion.plan_compile_failed': {
		category: 'caller',
		status: 400,
		label_key: 'error_diffusion_plan_compile_failed',
		message: 'The diffusion plan could not be compiled',
		severity: 'error',
		disclosure: 'public',
		retryable: false,
	},

	// ── ai (agent model catalog / provider) ─────────────────────────────────
	// Catalog refusals are deliberate OPERATOR feedback (a misconfigured
	// DEDALO_AGENT_MODELS, an unknown id, images on a non-vision model):
	// disclosure public so the catalog's own sentence reaches the wire.
	'ai.model_catalog_invalid': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_ai_model_catalog_invalid',
		message: 'The assistant model catalog is invalid (assistant disabled)',
		severity: 'error',
		disclosure: 'public',
		retryable: false,
	},
	'ai.models_unconfigured': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_ai_models_unconfigured',
		message: 'No assistant models configured',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
	},
	'ai.model_unknown': {
		category: 'caller',
		status: 400,
		label_key: 'error_ai_model_unknown',
		message: 'Unknown assistant model',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
	},
	'ai.model_no_vision': {
		category: 'caller',
		status: 400,
		label_key: 'error_ai_model_no_vision',
		message: 'The selected model does not accept images',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
	},
	// A model ARTIFACT refused on integrity grounds (P1-25): no revision pin, or
	// downloaded/stored bytes that do not hash to the pinned sha256 (quarantined
	// under <store>/.quarantine). Operator disclosure: the message names files
	// and digests, which an administrator needs and a cataloguer does not.
	'ai.model_integrity': {
		category: 'conflict',
		status: 409,
		label_key: 'error_ai_model_integrity',
		message: 'The model artifact failed its integrity check and was refused',
		severity: 'error',
		disclosure: 'operator',
		retryable: false,
		hint: 'Pin the model (scripts/pin_ai_models.ts) or repair it from a clean source; see the server log.',
	},
	// A provider/transport failure during an agent run. Its text carries config
	// internals (env key names, upstream bodies) — never echoed; log-only cause.
	'ai.provider_failed': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_ai_provider_failed',
		message: 'The assistant is not available right now (see server logs)',
		severity: 'error',
		disclosure: 'operator',
		retryable: true,
		hint: 'Retry; if it persists, check the server model configuration.',
	},

	// THE AI SPEND BUDGET (closure Step 3, TOOLS-4; WC-2026-10-01-ai-spend-budget).
	// Every model spend — an agent run, a generative RAG answer, a query embedding,
	// a vision call — is RESERVED against the caller's per-day ledger
	// (security/ai_spend.ts) before the provider is touched. `limit` (429): the
	// same request succeeds after `window_resets_at` (the next UTC midnight) or
	// once an administrator raises the DEDALO_AI_USER_DAILY_* budget.
	'ai.budget_exhausted': {
		category: 'limit',
		status: 429,
		label_key: 'error_ai_budget_exhausted',
		message: 'The daily AI budget for this user is used up',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
		details_keys: ['budget_kind', 'limit', 'window_resets_at'],
		hint: 'Stop: the user has no AI budget left today. It resets at window_resets_at (UTC); an administrator can raise the DEDALO_AI_USER_DAILY_* budgets.',
	},
	// The ledger could not be read or written (its engine ontology is missing, or
	// the database failed): FAIL CLOSED — an unmetered spend is never admitted.
	'ai.budget_unavailable': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_ai_budget_unavailable',
		message: 'The AI usage ledger is unavailable, so no AI request is admitted (see server logs)',
		severity: 'error',
		disclosure: 'operator',
		retryable: true,
		hint: 'Retry later; if it persists, the server log names why the AI usage ledger cannot be used.',
	},

	// ── install wizard ──────────────────────────────────────────────────────
	'install.unknown_step': {
		category: 'caller',
		status: 400,
		label_key: 'error_install_unknown_step',
		message: 'Unknown install step',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},
	'install.not_reachable': {
		category: 'not_found',
		status: 404,
		label_key: 'error_install_not_reachable',
		message: 'The installer is not reachable on an installed system',
		severity: 'info',
		disclosure: 'operator',
		retryable: false,
	},
	'install.ip_denied': {
		category: 'permission',
		status: 403,
		label_key: 'error_install_ip_denied',
		message: 'The installer is not allowed from this address',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
		// The address the engine SAW (the trusted X-Forwarded-For hop). Behind a
		// container proxy that is never what the operator would guess (Docker
		// Desktop's 192.168.65.1, a bridge gateway), and without it the refusal
		// was unactionable (WC-2026-10-08-install-ip-denied-names-address).
		// Telling a caller its own address discloses nothing.
		details_keys: ['client_address'],
	},

	// ── maintenance widgets ─────────────────────────────────────────────────
	'maintenance.store_missing': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_maintenance_store_missing',
		message: 'A required search store does not exist; recreate the DB assets first',
		severity: 'error',
		disclosure: 'operator',
		retryable: false,
	},
	'maintenance.invalid_fn_action': {
		category: 'caller',
		status: 400,
		label_key: 'error_maintenance_invalid_fn_action',
		message: 'Invalid widget action',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},

	// ── db (PERF-11) ────────────────────────────────────────────────────────
	// The two database ceilings, typed so a fired bound is a 503 the client can
	// show — not a 500 `internal.unexpected` indistinguishable from an engine
	// bug. Raised ONLY by core/db/postgres.ts; the numbers (lane, ceiling, pool)
	// ride in operator-only `coordinates`.
	// A 57014 at or past the lane ceiling (DB_STATEMENT_TIMEOUT_MS, or a recorded SET
	// LOCAL). An operator cancel, an abort cancel and the reserved lane stay raw.
	'db.statement_timeout': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_db_statement_timeout',
		message: 'A database statement ran past the configured statement ceiling',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
	},
	// A 55P03 escaping a declared maintenance widget action: the maintenance pool
	// lifts the statement ceiling but keeps a startup lock_timeout
	// (MAINTENANCE_LOCK_TIMEOUT), so readers never queue behind its waiting ACCESS
	// EXCLUSIVE request. The transaction that waited rolled back — not
	// necessarily the whole action (units it committed earlier stand).
	'db.lock_timeout': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_db_lock_timeout',
		message: 'A maintenance action waited too long for a database lock',
		severity: 'warn',
		disclosure: 'public',
		retryable: true,
	},
	// The acquire gate waited DB_POOL_ACQUIRE_TIMEOUT_MS for a pooled connection
	// (every path that takes a connection takes a slot).
	'db.pool_exhausted': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_db_pool_exhausted',
		message: 'No database connection became available in time',
		severity: 'warn',
		disclosure: 'public',
		retryable: true,
	},

	// ── internal ────────────────────────────────────────────────────────────
	'internal.unexpected': {
		category: 'internal',
		status: 500,
		label_key: 'error_internal_unexpected',
		message: 'An unexpected error occurred',
		severity: 'error',
		disclosure: 'operator',
		retryable: false,
	},
	// Engine invariant / uncovered-scope throws (P3 burn-down): the fail-loud typed
	// form of a former `throw new Error(...)`. Coordinates carry the module + input;
	// the sentence stays server-side.
	'internal.invariant': {
		category: 'internal',
		status: 500,
		label_key: 'error_internal_invariant',
		message: 'The server detected an internal contract violation',
		severity: 'error',
		disclosure: 'operator',
		retryable: false,
	},
	'internal.module_poisoned': {
		category: 'internal',
		status: 500,
		label_key: 'error_internal_module_poisoned',
		message: 'A module failed to load; the process is scheduled for restart',
		severity: 'fatal',
		disclosure: 'operator',
		retryable: true,
	},

	// ── parity-table classification codes (never thrown by the engine) ──────
	'php_fault.not_reproduced': {
		category: 'internal',
		status: 500,
		label_key: 'error_php_fault_not_reproduced',
		message: 'A frozen PHP-era fault the engine deliberately does not reproduce',
		severity: 'error',
		disclosure: 'operator',
		retryable: false,
		reason: 'Parity table classification (test/parity/normalize.ts) — never thrown by the engine.',
	},
	'envelope.not_an_envelope': {
		category: 'internal',
		status: 500,
		label_key: 'error_envelope_not_an_envelope',
		message: 'The frozen body is not an API envelope',
		severity: 'error',
		disclosure: 'operator',
		retryable: false,
		reason: 'Parity table classification (test/parity/normalize.ts) — never thrown by the engine.',
	},

	// --- core modules (P1 sweep) ---
	// The refusals the core read/write/maintenance/media/tree modules used to
	// spell as `denied(status, sentence)` or a hand-built legacy failure body.
	// Public disclosure where the sentence is the whole value of the refusal
	// (it names the caller's own mistake and no engine internal).
	'area.picker_caller_invalid': {
		category: 'caller',
		status: 400,
		label_key: 'error_area_picker_caller_invalid',
		message: 'The declared picker caller is not usable',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
	},
	'area.write_refused': {
		category: 'caller',
		status: 400,
		label_key: 'error_area_write_refused',
		message: 'Areas hold no data — write refused',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},
	'record.temporal_action_refused': {
		category: 'caller',
		status: 400,
		label_key: 'error_record_temporal_action_refused',
		message: 'The action is not available on a temporal instance',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
	},
	'tree.parent_unresolved': {
		category: 'conflict',
		status: 409,
		label_key: 'error_tree_parent_unresolved',
		message: 'The tree parent component could not be resolved for this section',
		severity: 'error',
		disclosure: 'public',
		retryable: false,
	},
	'tree.node_write_failed': {
		category: 'internal',
		status: 500,
		label_key: 'error_tree_node_write_failed',
		message: 'The tree write failed and was rolled back',
		severity: 'error',
		disclosure: 'public',
		retryable: false,
	},
	'maintenance.widget_unknown': {
		category: 'caller',
		status: 400,
		label_key: 'error_maintenance_widget_unknown',
		message: 'Unknown maintenance widget',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},
	'maintenance.widget_unavailable': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_maintenance_widget_unavailable',
		message: 'The maintenance widget is not available on this engine',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
	},
	'maintenance.action_refused': {
		category: 'caller',
		status: 400,
		label_key: 'error_maintenance_action_refused',
		message: 'The maintenance action was refused',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
	},
	'maintenance.action_failed': {
		category: 'internal',
		status: 500,
		label_key: 'error_maintenance_action_failed',
		message: 'The maintenance action failed',
		severity: 'error',
		disclosure: 'public',
		retryable: false,
	},
	'media.upload_rejected': {
		category: 'caller',
		status: 400,
		label_key: 'error_media_upload_rejected',
		message: 'Upload rejected',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
	},
	'media.operation_failed': {
		category: 'internal',
		status: 500,
		label_key: 'error_media_operation_failed',
		message: 'The media operation failed',
		severity: 'error',
		disclosure: 'public',
		retryable: false,
	},

	// --- install-update-tools (P1 sweep) -----------------------------------
	// The install surface is PRE-AUTH and has NO label catalog (a fresh box has
	// no ontology and the wizard renders `msg` verbatim), so these three codes
	// are `public`: the refusing step states the exact reason as `publicMessage`
	// and the compat mirror puts it back on `msg` where render_installer.js
	// reads it. Their registry messages are readable ALONE, for the wire a
	// non-wizard caller (the CLI, curl) sees.
	'install.invalid_input': {
		category: 'caller',
		status: 400,
		label_key: 'error_install_invalid_input',
		message: 'The installer rejected a submitted value',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
	},
	'install.state_conflict': {
		category: 'conflict',
		status: 409,
		label_key: 'error_install_state_conflict',
		message: 'The install step cannot run in the current state',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
	},
	'install.step_failed': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_install_step_failed',
		message: 'The install step could not be completed',
		severity: 'error',
		disclosure: 'public',
		retryable: true,
	},
	// The vendored thesaurus manifest (install/import/hierarchy/hierarchy.json —
	// src/core/ontology/hierarchy_manifest_format.ts) is malformed or a data
	// file does not match its declared digest. The REQUEST was fine, the release
	// (or the operator's replacement file) behind it is not — same posture as
	// ontology.invalid_node. Public: the refusing reader names the JSON path and
	// the rule it broke (never a secret: the file is a vendored release asset),
	// and the wizard renders that sentence verbatim.
	'install.manifest_invalid': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_install_manifest_invalid',
		message: 'The vendored hierarchy manifest is malformed or does not match its data files',
		severity: 'error',
		disclosure: 'public',
		retryable: false,
	},

	// Update (data migration + code update). `refused` is a STATE refusal the
	// operator can act on (not owned, not supervised, not linear, checksum
	// mismatch); `failed` is the machine/network half of the same pipeline.
	'update.refused': {
		category: 'conflict',
		status: 409,
		label_key: 'error_update_refused',
		message: 'The update was refused in the current state',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
	},
	'update.failed': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_update_failed',
		message: 'The update could not be completed',
		severity: 'error',
		disclosure: 'public',
		retryable: true,
	},
	// ── the archive door (core/archive/) ─────────────────────────────────────
	'archive.refused': {
		category: 'conflict',
		status: 409,
		label_key: 'error_archive_refused',
		message: 'The archive operation was refused before anything was written',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},
	'archive.invalid': {
		category: 'caller',
		status: 400,
		label_key: 'error_archive_invalid',
		message: 'The archive is malformed or its digests do not match',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},
	'perm.superuser_required': {
		category: 'permission',
		status: 403,
		label_key: 'error_perm_superuser_required',
		message: 'Only the Dédalo superuser can perform this action',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},
	'maintenance.mode_required': {
		category: 'conflict',
		status: 409,
		label_key: 'error_maintenance_mode_required',
		message: 'This action requires maintenance mode to be enabled',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},
	'maintenance.dev_mode_required': {
		category: 'conflict',
		status: 409,
		label_key: 'error_maintenance_dev_mode_required',
		message: 'This action is only available on a development server (DEDALO_DEV_MODE)',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},

	// ── the restore door (audit 2026-08-26 S-7, src/core/area_maintenance/restore_door.ts) ──
	// A DATA restore the engine owns, CLI-only with the engine stopped. Each
	// refusal names the phase it fired in: the artifact was disproved BEFORE any
	// write, a foreign backend held the target so the swap could not be atomic,
	// or pg_restore itself failed — in which case the sidecar was dropped and the
	// target is untouched. None is retryable by a transport: the operator acts.
	'recovery.artifact_unusable': {
		category: 'conflict',
		status: 409,
		label_key: 'error_recovery_artifact_unusable',
		message: 'The backup artifact is not a usable restore point; nothing was written',
		severity: 'error',
		disclosure: 'operator',
		retryable: false,
		hint: 'Run `pg_restore -f /dev/null <artifact>` to read its own words; pick an artifact whose verdict is verified_deep.',
	},
	'recovery.writers_active': {
		category: 'conflict',
		status: 409,
		label_key: 'error_recovery_writers_active',
		message: 'The target database still has connections; a restore needs zero',
		severity: 'error',
		disclosure: 'operator',
		retryable: false,
		hint: 'Stop the engine (and its watchdog timer) and every other client of the database, then run the door again.',
	},
	'recovery.restore_failed': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_recovery_restore_failed',
		message: 'The restore failed; the sidecar was dropped and the target database is untouched',
		severity: 'error',
		disclosure: 'operator',
		retryable: false,
	},

	// Translation. WC-2026-08-09: the provider sentence is UNTRUSTED third-party
	// prose (an Apertium box answers whole HTML error pages), so it rides as the
	// declared `provider_message` DETAIL — truncated to the 512-byte budget by
	// the caller — and never as a publicMessage that would replace the registry
	// English on the wire.
	'translation.provider_failed': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_translation_provider_failed',
		message: 'The translation service reported an error',
		severity: 'warn',
		disclosure: 'operator',
		retryable: true,
		details_keys: ['provider_message'],
	},
	'translation.not_configured': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_translation_not_configured',
		message: 'The translation service is not configured for this engine',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
	},

	// --- core handlers (P1 sweep) ------------------------------------------
	// Codes born in the src/core/api/handlers/** + src/core/api/*_view.ts sweep,
	// each replacing a hand-built legacy body. Deliberately few and reusable.
	'auth.login_failed': {
		category: 'auth',
		status: 401,
		label_key: 'error_auth_login_failed',
		// The AMBIGUOUS refusal (security/auth.ts LOGIN_FAILED_MESSAGE): a wrong
		// user, a wrong password and a lockout answer the same thing, so a probe
		// cannot learn which accounts exist. Disclosure `operator` keeps it that
		// way — no call site may narrow it with a publicMessage.
		message: 'User does not exist or password is invalid',
		severity: 'info',
		disclosure: 'operator',
		retryable: false,
	},
	'request.invalid_data': {
		category: 'caller',
		status: 400,
		label_key: 'error_request_invalid_data',
		// The twin of `request.invalid_source`, for the `data` half of an RQO
		// (save's `data.changed_data must be an array`).
		message: 'Invalid or incomplete request data',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},
	'record.delete_failed': {
		category: 'internal',
		status: 500,
		label_key: 'error_record_delete_failed',
		message: 'The record could not be deleted',
		severity: 'error',
		disclosure: 'operator',
		retryable: false,
	},
	'media.action_failed': {
		category: 'internal',
		status: 500,
		label_key: 'error_media_action_failed',
		// A media side operation (fragment cut, chunked-upload join, posterframe
		// bind) that could not complete. The engine reason rides `cause` (log +
		// DEDALO_DEBUG_API_ERRORS), never the wire: it is a filesystem/ffmpeg
		// message and can carry paths.
		message: 'The media operation could not be completed',
		severity: 'error',
		disclosure: 'operator',
		retryable: false,
	},
	'update_server.refused': {
		category: 'permission',
		status: 403,
		label_key: 'error_update_server_refused',
		// The ontology/code master doors (dd_utils_api get_server_ready_status,
		// get_ontology_update_info, get_code_update_info). ONE code for every
		// refusal reason ON PURPOSE — "not a master", "invalid code" and "invalid
		// version" must be indistinguishable, or a probe confirms master-ness by
		// elimination (dd_utils_api authorizeUpdateManifest "ORDER IS SECURITY").
		// Disclosure `public` so the PHP-parity sentence still reaches the peer
		// install that speaks this machine-to-machine wire.
		message: 'This server does not serve that request',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
	},

	// --- tools/servers + diffusion (P1 sweep) -------------------------------
	// The four codes the tool server modules and the diffusion facade needed
	// that no earlier domain covered. Deliberately GENERIC and reusable: a tool
	// refuses because its target cannot be processed, because a thing it needs
	// is not there, because a service it depends on is down, or because the
	// operation it performed failed.
	'tool.unsupported_target': {
		category: 'caller',
		status: 400,
		label_key: 'error_tool_unsupported_target',
		message: 'The tool cannot operate on this target',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
	},
	// A request carries more items than the action processes in one call (an
	// interactive action bounded by its caller's wait: tool_import_rdf dereferences
	// at most RDF_MAX_URIS IRIs, each paced by the harvesting door). `caller`, not
	// `limit`: the same request is refused every time — send fewer items.
	'tool.too_many_items': {
		category: 'caller',
		status: 400,
		label_key: 'error_tool_too_many_items',
		message: 'The request has more items than this action processes at once',
		severity: 'info',
		disclosure: 'public',
		retryable: false,
		details_keys: ['count', 'limit'],
	},
	// An RDF/XML document past the graph reader's bounds (src/core/tools/rdf_graph.ts:
	// element nesting deeper than maxDepth, or more than maxTriples statements). A
	// remote linked-data answer is untrusted input: the bound stops a hostile or
	// runaway document before it costs the server, and the same document is
	// refused every time — `caller`, not retryable. The bound that tripped rides
	// `coordinates.bound` (log-only); `limit` is its value.
	'tool.rdf_graph_too_large': {
		category: 'caller',
		status: 400,
		label_key: 'error_tool_rdf_graph_too_large',
		message: 'The RDF document is too large or too deeply nested to read',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
		details_keys: ['limit'],
	},
	// An RDF resource tool_import_rdf dereferenced whose rdf:type no owl:Class of
	// the external ontology maps INTO the caller record's section (or maps at all):
	// there is nothing the record can hold, so nothing of that IRI is written. A
	// per-URI payload error (data.errors), never the call's failure. `type` is the
	// subject's first type as the document names it (prefixed through the
	// ontology's xmlns), '-' when it has none: remote data the cataloguer chose,
	// public. Same document, same answer — caller, not retryable.
	'tool.rdf_class_unmapped': {
		category: 'caller',
		status: 400,
		label_key: 'error_tool_rdf_class_unmapped',
		message: 'The external ontology maps no class of this section to the RDF resource type',
		severity: 'info',
		disclosure: 'public',
		retryable: false,
		details_keys: ['type'],
	},
	// A record tool_import_rdf would BIRTH (a linked term, an intermediate) whose
	// identifier — what finds it again on the next run — the record cannot hold:
	// the write is refused (a component grant, remote text carrying tag syntax, an
	// undeclared language). Born without it, the record could never be found
	// again and every run would add another, so the op is refused instead and its
	// savepoint takes the record and its link back. A per-op skip of the import
	// report, never the call's failure. `reason` is the skip sentence of the
	// refused write (engine text naming no record). Same data, same answer —
	// caller, not retryable.
	'tool.rdf_identifier_unwritable': {
		category: 'caller',
		status: 400,
		label_key: 'error_tool_rdf_identifier_unwritable',
		message: 'Not created: the record could not hold the identifier that finds it again',
		severity: 'info',
		disclosure: 'public',
		retryable: false,
		details_keys: ['reason'],
	},
	// A remote source a tool reads interactively did not answer in time, dropped
	// the connection, answered 5xx/408/429, or could not deliver its robots.txt
	// (tool_import_rdf, RDF_IRI_DEADLINE_MS). For the cataloguer the source is out
	// of service: the label says so and sends them to its maintainer. `site` is the
	// origin of the address the cataloguer gave, never a redirect target.
	'tool.source_unavailable': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_tool_source_unavailable',
		message: 'The remote server is not responding or is out of service',
		severity: 'warn',
		disclosure: 'public',
		retryable: true,
		details_keys: ['site'],
	},
	'tool.target_not_found': {
		category: 'not_found',
		status: 404,
		label_key: 'error_tool_target_not_found',
		message: 'The tool target does not exist',
		severity: 'info',
		disclosure: 'operator',
		retryable: false,
	},
	/**
	 * A bulk revert refused because the run it would undo is still executing in
	 * this process, or another revert of the same run is (decision D5 of the
	 * bulk-revert undo log; src/core/tools/bulk_run_registry.ts). Retryable: the
	 * refusal lifts when the run or the other revert finishes.
	 */
	'tool.bulk_run_live': {
		category: 'conflict',
		status: 409,
		label_key: 'error_tool_bulk_run_live',
		message: 'The bulk process is still running or already being reverted',
		severity: 'info',
		disclosure: 'public',
		retryable: true,
	},
	'tool.dependency_unavailable': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_tool_dependency_unavailable',
		message: 'A service this tool depends on is unavailable',
		severity: 'error',
		disclosure: 'operator',
		retryable: true,
	},
	'tool.action_failed': {
		category: 'internal',
		status: 500,
		label_key: 'error_tool_action_failed',
		message: 'The tool action could not be completed',
		severity: 'error',
		disclosure: 'operator',
		retryable: false,
	},
	'diffusion.connection_failed': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_diffusion_connection_failed',
		message: 'The diffusion target database could not be reached',
		severity: 'error',
		disclosure: 'operator',
		retryable: true,
	},

	// --- read paths (P3) ---------------------------------------------------
	// The read side (search/conform, section read, relations resolution, the
	// ontology accessors, the tree node repository) refused with untyped
	// throws. Four codes cover every caller-actionable refusal it makes; the
	// engine invariants there stay untyped under the ratchet.
	'search.invalid_sqo': {
		category: 'caller',
		status: 400,
		label_key: 'error_search_invalid_sqo',
		message: 'The search query object is not valid',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
		hint: 'The search filter is malformed. Rebuild the SQO from the section schema and retry.',
	},
	'search.index_unavailable': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_search_index_unavailable',
		// Operator-actionable and the remediation IS the message: relation
		// searches run only on matrix_relation_index, and the two maintenance
		// actions that rebuild it are named here so the log line is the fix.
		message:
			'matrix_relation_index is not available: sync triggers are missing, or the store is ' +
			'empty while relation data exists. Remediation: Area Maintenance → Database info → ' +
			'"Recreate database assets", then "Backfill search stores".',
		severity: 'error',
		disclosure: 'operator',
		retryable: false,
	},
	'ontology.invalid_node': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_ontology_invalid_node',
		// Same shape as external.bad_config: the REQUEST was well formed, the
		// definition behind it is not. Operator disclosure — the sentence names
		// tipos and install structure, and travels in the log (`message`).
		message: 'An ontology node definition is unusable; the install must be corrected',
		severity: 'error',
		disclosure: 'operator',
		retryable: false,
	},
	'widget.unported': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_widget_unported',
		message: 'This widget has no server implementation on this engine',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},

	// --- periphery (P3) -----------------------------------------------------
	// The codes the P3 burn-down of the PERIPHERY needed (api handlers, the SSRF
	// guard, the tools layer, update/install, the diffusion writers/resolver).
	// Two families, both deliberately small:
	//
	//  - `security.*` — the shared outbound-fetch guard (core/security/ssrf_guard.ts).
	//    Disclosure OPERATOR on purpose: the refusal must never echo the URL, the
	//    resolved address or the protocol back to the caller (that is what turns a
	//    blocked fetch into an internal-network oracle). Which condition fired,
	//    and against which host, rides as LOG-ONLY `coordinates`.
	//  - `diffusion.*` — the four typed diffusion classes folded in here
	//    (UnsupportedRewriterError, MissingDiffusionFilesRootError,
	//    UnknownDiffusionFormatError, InvalidFileTargetError; the fifth,
	//    MissingTargetDatabaseError, reuses `diffusion.connection_failed`),
	//    plus the resolver/writer sites that state the SAME facts inline.
	'security.ssrf_blocked': {
		category: 'caller',
		status: 400,
		label_key: 'error_security_ssrf_blocked',
		message: 'The requested outbound address is refused',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},
	'security.outbound_failed': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_security_outbound_failed',
		message: 'The outbound request could not be completed',
		severity: 'warn',
		disclosure: 'operator',
		retryable: true,
	},
	// --- harvest.* — the harvesting door (core/harvest/) --------------------
	// How a tool reads another institution's site: robots.txt obeyed, pace kept,
	// every redirect hop re-vetted. The domain is the door's own (§2.1: the
	// subsystem that OWNS the refusal), not `security`: these are the door's
	// published POLICY answers, which a cataloguer who pasted a URL must be able to
	// read — which site, and what said no. `site` is the origin the caller asked
	// for — or, for every ROBOTS verdict (robots_disallowed, robots_unavailable, and
	// harvest.refused reasons robots_too_complex / robots_redirect_refused), the public origin whose robots.txt
	// decided — or a fixed token for text that is not a URL: never a path, never a
	// query or credentials, never a resolved address (core/harvest/refusals.ts is
	// the one builder and states that rule). ADDRESS refusals stay `security.ssrf_blocked`
	// above — operator disclosure, because naming what a host resolved to is the
	// internal-network oracle that code exists to deny.
	'harvest.refused': {
		category: 'caller',
		status: 400,
		label_key: 'error_harvest_refused',
		// PUBLIC: the per-reason sentence is authored in refusals.ts (a closed
		// table, never caller text); `reason` is the machine token beside it.
		message: 'The harvesting rules refused this address',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
		details_keys: ['site', 'reason'],
	},
	// The site's robots.txt (RFC 9309) disallows the path. The site's own policy.
	'harvest.robots_disallowed': {
		category: 'permission',
		status: 403,
		label_key: 'error_harvest_robots_disallowed',
		message: "The site's robots.txt does not allow automated access to this address",
		severity: 'info',
		disclosure: 'operator',
		retryable: false,
		details_keys: ['site'],
	},
	// RFC 9309 §2.3.1.4: a robots.txt the SERVER failed to deliver (5xx, 429, a
	// redirect without a target, or no answer) means "assume complete disallow" —
	// never "assume allowed". Retryable: the verdict is re-asked after minutes.
	'harvest.robots_unavailable': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_harvest_robots_unavailable',
		message: "The site's robots.txt could not be read, so automated access is not assumed",
		severity: 'warn',
		disclosure: 'operator',
		retryable: true,
		details_keys: ['site'],
	},
	// The body passed the caller's ceiling (maxBytes). Category `caller` (400), NOT
	// `limit`, for media.too_large's reason: the request is wrong for this file, not
	// rate-limited, and the same request reads the same file — a 429 that is not
	// retryable would contradict itself on the wire. The primitive's own
	// `security.outbound_failed` (reason body_cap) is mapped to this at the door.
	'harvest.too_large': {
		category: 'caller',
		status: 400,
		label_key: 'error_harvest_too_large',
		message: 'The remote file is larger than this request allows',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
		details_keys: ['site', 'max_bytes'],
	},
	// A 2xx answer whose media type is not one the caller declared
	// (`expectContentType`) — refused before its body is read.
	'harvest.unexpected_type': {
		category: 'caller',
		status: 400,
		label_key: 'error_harvest_unexpected_type',
		message: 'The remote site answered with a different kind of file than expected',
		severity: 'info',
		disclosure: 'operator',
		retryable: false,
		details_keys: ['site', 'content_type'],
	},
	'diffusion.unported_fn': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_diffusion_unported_fn',
		message: 'The publication uses an ontology function this engine does not implement yet',
		severity: 'error',
		disclosure: 'operator',
		retryable: false,
	},
	'diffusion.files_root_missing': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_diffusion_files_root_missing',
		message: 'No diffusion files root is configured on this server',
		severity: 'error',
		disclosure: 'operator',
		retryable: false,
	},
	'diffusion.unknown_format': {
		category: 'caller',
		status: 400,
		label_key: 'error_diffusion_unknown_format',
		message: 'No diffusion writer serves that publication format',
		severity: 'error',
		disclosure: 'operator',
		retryable: false,
	},
	'diffusion.invalid_target': {
		category: 'caller',
		status: 400,
		label_key: 'error_diffusion_invalid_target',
		message: 'The publication target does not match the writer',
		severity: 'error',
		disclosure: 'operator',
		retryable: false,
	},

	// --- media (P3) ---------------------------------------------------------
	// The media subsystem (src/core/media/**, src/core/concepts/media.ts) speaks
	// to three callers: the browser upload/versions/posterframe panels, the media
	// tools, and the MCP agent. Its refusals are overwhelmingly CALLER FACTS —
	// "that quality is not on this type's ladder", "that extension is not
	// allowed", "there is no master to build from" — so they get codes here while
	// the genuine engine invariants (an ffmpeg that reported success and wrote
	// nothing, a probe line with the wrong field count) stay untyped under the
	// throw ratchet. Every message below is registry-owned English: the throwing
	// site keeps its own sentence as the LOG `message`, and only passes it as
	// `publicMessage` when it carries no path and no raw caller string.
	'media.invalid_quality': {
		category: 'caller',
		status: 400,
		label_key: 'error_media_invalid_quality',
		message: 'Invalid media quality',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
	},
	'media.invalid_extension': {
		category: 'caller',
		status: 400,
		label_key: 'error_media_invalid_extension',
		message: 'Invalid media file extension',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
	},
	// section_id / lang / path segment of a media identifier — the grammar
	// path.ts builds every media file name from.
	'media.invalid_identifier': {
		category: 'caller',
		status: 400,
		label_key: 'error_media_invalid_identifier',
		message: 'Invalid media identifier',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
	},
	// A confinement guard tripped (a staged name, a segment or a resolved path
	// that leaves its root). Disclosure `operator`: the sentence names filesystem
	// paths and must never reach the wire.
	'media.invalid_path': {
		category: 'caller',
		status: 400,
		label_key: 'error_media_invalid_path',
		message: 'Invalid media path',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},
	'media.invalid_timecode': {
		category: 'caller',
		status: 400,
		label_key: 'error_media_invalid_timecode',
		message: 'Invalid media timecode range',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
	},
	// "not for this component model / not for this tier / this host writes other
	// formats here" — the caller asked for something this media type cannot do.
	'media.unsupported_operation': {
		category: 'caller',
		status: 400,
		label_key: 'error_media_unsupported_operation',
		message: 'This media operation is not supported for this component',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
	},
	// Category `caller` (400), NOT `limit`: the same reading as
	// `identify.image_too_large` / `mcp.media_too_large` — the request is wrong,
	// not rate-limited, and a retry with the same bytes can never succeed.
	'media.too_large': {
		category: 'caller',
		status: 400,
		label_key: 'error_media_too_large',
		message: 'The file is larger than the allowed maximum',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
	},
	// The file the caller named is not on this box (no master to build from, no
	// staged parts for this upload, no source to cut a fragment out of).
	'media.file_not_found': {
		category: 'not_found',
		status: 404,
		label_key: 'error_media_file_not_found',
		message: 'The media file was not found',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
	},
	// A staged transfer whose state refuses the request AS IT STANDS: another
	// join is assembling it, or the staged name is ambiguous. Retryable — the
	// competing operation finishes.
	'media.upload_conflict': {
		category: 'conflict',
		status: 409,
		label_key: 'error_media_upload_conflict',
		message: 'The upload conflicts with another staged transfer',
		severity: 'warn',
		disclosure: 'public',
		retryable: true,
	},
	// MEDIA_PATH absent where a media path is required. Operator-actionable,
	// never the caller's fault.
	'media.not_configured': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_media_not_configured',
		message: 'Media storage is not configured on this server',
		severity: 'error',
		disclosure: 'operator',
		retryable: false,
	},
	// A media binary / shipped asset this host does not have (rsvg-convert, an
	// ImageMagick coder for the requested format, the ICC profile, the watermark
	// file). Operator installs it; the caller can only wait.
	'media.engine_unavailable': {
		category: 'unavailable',
		status: 503,
		label_key: 'error_media_engine_unavailable',
		message: 'This media conversion is not available on this server',
		severity: 'error',
		disclosure: 'operator',
		retryable: false,
	},
	// Every refusal knowable BEFORE an av build job id exists (av_versions.ts
	// AvBuildRefused). Public: the panel renders the operator-facing reason.
	'media.av_build_refused': {
		category: 'caller',
		status: 400,
		label_key: 'error_media_av_build_refused',
		message: 'The version build was refused',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
	},
	// --- write paths (P3) ---
	// The record write doors (section/record/**, section_record/**): the
	// caller-addressable refusals that used to be bare `throw new Error(`.
	// Engine invariants on the same paths (json_codec, matrix_write identifier
	// gates, tx guards, lost-update guards) are `internal.invariant`.
	'record.external_write_refused': {
		category: 'caller',
		status: 400,
		label_key: 'error_record_external_write_refused',
		// A write addressed to a component whose value is DERIVED from a
		// third-party service at read time (WC-2026-08-06-external-write-refusal):
		// the local record has no slot for it and the remote is never written to.
		message: 'Write refused: the component value is derived from an external service',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},
	'record.lang_not_installed': {
		category: 'caller',
		status: 400,
		label_key: 'error_record_lang_not_installed',
		// The write language named by the caller is not one this installation
		// declares (DEDALO_PROJECTS_DEFAULT_LANGS + the default data lang + their
		// equivalence classes + lg-nolan). The caller's lang is stamped verbatim
		// onto every stored item, so an undeclared code stores a slice no read
		// path reaches — P0-7 / DATA-01 / DATA-25.
		message: 'Write refused: the language is not one this installation declares',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
		details_keys: ['lang'],
		hint:
			'The write language must be one the installation declares. Omit `lang` to use the ' +
			"session's data language, or name a language the install actually catalogues in.",
	},
	'relation.insert_refused': {
		category: 'caller',
		status: 400,
		label_key: 'error_relation_insert_refused',
		// A NET-NEW relation locator refused by the insert chokepoint's
		// constraint gates (relations/save.ts refuseByPickerConstraint):
		// `constraint` names which — off_target / term_not_selectable /
		// selection_limit — and `section_tipo` the linked section the actor
		// itself named in the payload. The read-grant refusal is NOT this code:
		// it is the generic perm.denied, so a refusal never describes what the
		// actor may not reach. WC-2026-08-14-relation-insert-target-validation.
		message: 'The linked record was refused by the relation constraint',
		severity: 'warn',
		disclosure: 'public',
		retryable: false,
		details_keys: ['constraint', 'section_tipo'],
	},
	'relation.subtree_too_large': {
		category: 'caller',
		status: 400,
		label_key: 'error_relation_subtree_too_large',
		// The recursive children walk hit its DEPTH or NODE cap
		// (relations/children.ts CHILDREN_RECURSIVE_MAX_DEPTH / _MAX_NODES).
		// Refused, never truncated: a narrowed subtree is a wrong answer that
		// looks like a right one. `limit` says which cap, `cap` its value; the
		// root coordinates stay off the wire (coordinates, not details).
		message: 'The requested subtree is too large to expand',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
		details_keys: ['limit', 'cap'],
	},
	'section.no_matrix_table': {
		category: 'caller',
		status: 400,
		label_key: 'error_section_no_matrix_table',
		// The tipo names no section with a matrix table (not a section, an
		// external section, or an unprovisioned one) — nothing can be written.
		message: 'The section has no matrix table',
		severity: 'warn',
		disclosure: 'operator',
		retryable: false,
	},
} as const satisfies Record<string, ErrorSpec>;

export type ErrorCode = keyof typeof ERROR_REGISTRY;

/** Every registered code, in table order. */
export const ERROR_CODES = Object.keys(ERROR_REGISTRY) as readonly ErrorCode[];

export function isErrorCode(value: unknown): value is ErrorCode {
	return typeof value === 'string' && Object.hasOwn(ERROR_REGISTRY, value);
}

/** Resolve a code's spec (typed lookup; the table is total by construction). */
export function specOf(code: ErrorCode): ErrorSpec {
	return ERROR_REGISTRY[code];
}

/**
 * The former MCP HINTS keys → their code. Kept as a named export so the P2
 * fold-in and the registry gate ("every former HINT key mapped") share one list.
 */
export const MCP_HINT_CODES: Readonly<Record<string, ErrorCode>> = {
	invalid_tipo: 'request.invalid_tipo',
	permission_denied: 'perm.denied',
	out_of_scope: 'perm.out_of_scope',
	section_not_writable: 'perm.section_not_writable',
	label_ambiguous: 'mcp.label_ambiguous',
	ambiguous_match: 'mcp.ambiguous_match',
	not_found: 'resource.not_found',
	invalid_request: 'request.invalid',
	media_path_disabled: 'mcp.media_path_disabled',
	media_too_large: 'mcp.media_too_large',
	plan_hash_mismatch: 'mcp.plan_hash_mismatch',
	egress_restricted: 'mcp.egress_restricted',
};

/** The ExternalErrorKind set, mirrored here (registry imports nothing). `external.<kind>` is total over it. */
export const EXTERNAL_ERROR_KINDS = [
	'disabled',
	'not_registered',
	'bad_config',
	'circuit_open',
	'blocked_host',
	'timeout',
	'transport',
	'http_status',
	'too_large',
	'protocol',
	'not_found',
] as const;

/**
 * Old wire token → registered code — the SINGLE translation source for the
 * P1 call-site sweepers and the parity reconciler. Keys are the literal
 * strings that appear in today's `errors: ['…']` arrays, MCP `err()` codes,
 * identify `decline()` codes and tool-dispatch tokens. Where one old token
 * meant two things (`unauthorized` = permission in tools/security, = not
 * logged in install/engine.ts) the map records the DOMINANT meaning; the
 * sweeper picks the other by hand and says so.
 */
export const LEGACY_TOKEN_MAP: Readonly<Record<string, ErrorCode>> = {
	// HTTP envelope tokens
	// The Gate-1 sentence itself: dd_error_report_api mimics the unregistered-
	// action shape by message (WC-017) until P2 restates it as code identity.
	'Undefined or unauthorized method (action)': 'request.unknown_action',
	not_logged: 'auth.not_logged',
	csrf_failed: 'auth.csrf_failed',
	'CSRF validation failed': 'auth.csrf_failed',
	not_authorized: 'perm.denied',
	permissions_denied: 'perm.denied',
	permission_denied: 'perm.denied',
	forbidden: 'perm.denied',
	unauthorized: 'perm.denied',
	'insufficient permissions': 'perm.denied',
	invalid_request: 'request.invalid',
	'invalid model': 'request.invalid_model',
	'invalid rqo source': 'request.invalid_source',
	bad_source: 'request.invalid_source',
	bad_options: 'request.invalid_options',
	bad_locators: 'section.bad_locators',
	not_found: 'resource.not_found',
	uncovered_scope: 'engine.uncovered_scope',
	'An unexpected error occurred': 'internal.unexpected',
	cycle: 'tree.cycle',
	// password reset
	invalid_or_expired: 'password_reset.invalid_or_expired',
	too_many_attempts: 'password_reset.too_many_attempts',
	weak_password: 'password_reset.weak_password',
	reset_failed: 'password_reset.failed',
	// mailer
	mailer_not_configured: 'mailer.not_configured',
	invalid_recipient: 'mailer.invalid_recipient',
	send_failed: 'mailer.send_failed',
	// diffusion server control
	invalid_process_id: 'diffusion.invalid_process_id',
	invalid_job_id: 'diffusion.invalid_job_id',
	not_requeueable: 'diffusion.not_requeueable',
	invalid_action: 'diffusion.invalid_action',
	already_draining: 'diffusion.already_draining',
	// install / maintenance
	unknown_step: 'install.unknown_step',
	store_missing: 'maintenance.store_missing',
	invalid_fn_action: 'maintenance.invalid_fn_action',
	// tools dispatch / jobs
	unauthorized_method: 'tool.method_not_allowed',
	background_not_allowed: 'tool.background_not_allowed',
	job_not_found: 'tool.job_not_found',
	// site builder
	site_builder_unconfigured: 'site_builder.unconfigured',
	site_builder_unreachable: 'site_builder.unreachable',
	site_builder_auth: 'site_builder.auth',
	site_builder_rejected: 'site_builder.rejected',
	site_builder_failed: 'site_builder.failed',
	site_builder_stream_lost: 'site_builder.stream_lost',
	// MCP envelope codes (HINTS keys + the hint-less 'unknown')
	invalid_tipo: 'request.invalid_tipo',
	out_of_scope: 'perm.out_of_scope',
	section_not_writable: 'perm.section_not_writable',
	label_ambiguous: 'mcp.label_ambiguous',
	ambiguous_match: 'mcp.ambiguous_match',
	media_path_disabled: 'mcp.media_path_disabled',
	media_too_large: 'mcp.media_too_large',
	plan_hash_mismatch: 'mcp.plan_hash_mismatch',
	egress_restricted: 'mcp.egress_restricted',
	unknown: 'internal.unexpected',
	// identify decline codes
	missing_seed: 'identify.missing_seed',
	missing_section: 'identify.missing_section',
	invalid_profile: 'identify.invalid_profile',
	no_profile: 'identify.no_profile',
	invalid_source: 'identify.invalid_source',
	rag_disabled: 'identify.rag_disabled',
	media_disabled: 'identify.media_disabled',
	missing_image: 'identify.missing_image',
	invalid_image: 'identify.invalid_image',
	image_too_large: 'identify.image_too_large',
	egress_forbidden: 'identify.egress_forbidden',
	provider_unavailable: 'identify.provider_unavailable',
	embed_failed: 'identify.embed_failed',
	empty_index: 'identify.empty_index',
	no_type_section: 'identify.no_type_section',
	no_link_component: 'identify.no_link_component',
};
