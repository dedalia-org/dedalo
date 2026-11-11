/**
 * The error taxonomy — one class per way this agent is allowed to fail.
 *
 * Shape copied from publication/site_builder/src/errors.ts (ApiError + RFC 9457 classes);
 * the type base, the closed REASON_CODES list and the classes this agent does not need
 * (site_builder's confinement family) are this package's own. Every error renders as an
 * `application/problem+json` document; throwing is the ONLY way to produce an error
 * response. The engine's phase-3 client branches on `type` and `reason`, never on prose.
 */

export const PROBLEM_TYPE_BASE = 'https://dedalo.dev/publication-host/problems/';

/**
 * THE CLOSED SET OF MACHINE REASONS. A `reason` extension outside this list is a type
 * error. Append-only: a code the engine maps must never change meaning.
 */
export const REASON_CODES = Object.freeze([
  'actor_missing',
  'body_invalid',
  'bundle_refused',
  'hash_mismatch',
  'release_id_invalid',
  'no_previous_release',
  'configtest_failed',
  'reload_failed',
  'restart_failed',
  'health_failed',
  'v2_env_missing',
  'busy',
  // rules.apply (src/rules/apply.ts). Status per event: every one is a 422 RefusedError except
  // reload_failed (503 HostActionFailedError). configtest_failed is listed above.
  'server_mismatch',
  'hash_invalid',
  'rules_too_large',
  'rules_nul_byte',
  'stamp_missing',
  'directive_refused',
  // release.install / release.rollback (src/releases/install.ts): every one a 422 ReleaseRefusedError
  // (RELEASE_REFUSAL_REASONS below; bundle_refused, health_failed and no_previous_release
  // are listed above).
  'sha_mismatch',
  'release_unverified',
  'shared_config_missing',
  'shared_config_exposed',
  'php_lint_failed',
  'node_modules_missing',
  'scratch_health_failed',
  'rollback_unhealthy',
  'no_current_release',
  'store_refused',
  // The v2 scratch boot (exec.ts v2ScratchBoot): 503 HostActionFailedError — systemd/polkit
  // refused to start or stop `<V2_UNIT>-scratch@<port>`, a host fault, not the release's.
  'scratch_start_failed',
  'scratch_stop_failed',
  // copy-mode media commands (src/media/copy.ts). media_mode / key_unpublished are 409
  // ConflictError; media_path_refused / size_mismatch / key_invalid are 422 RefusedError.
  // A body that does not hash to X-Sha256 reuses 'hash_mismatch' (same meaning: the bytes
  // do not hash to what the request declared).
  'media_mode',
  'media_path_refused',
  'size_mismatch',
  'key_unpublished',
  'key_invalid',
  // a level under the copy root the agent does not own, whose mode fails what the web server
  // needs (src/media/fs_modes.ts meetsNeed): 409 ConflictError, never chmodded by the agent.
  'media_level_foreign',
  // The host web lock (src/rules/apply.ts withHostWebLock, spec S12) around every
  // configtest+reload: host_busy = a holder past the 30 s wait, host_lock_missing = the
  // root-created lock file is absent (run `provision apply`). Both 503 HostActionFailedError.
  'host_busy',
  'host_lock_missing',
  // rules.map, the host-wide nginx map (src/rules/map.ts, spec §13.4). map_refused (the map
  // grammar, src/rules/directives.ts parseNginxMap; `line`/`directive` extensions) is a 422
  // RefusedError; map_unmanaged, map_contribution_foreign, map_contribution_newer,
  // map_envelope_rebind and map_renderer_missing are 409 ConflictError. server_mismatch,
  // hash_invalid, rules_too_large, rules_nul_byte, stamp_missing, hash_mismatch,
  // configtest_failed, reload_failed and host_busy are reused with rules.apply's meaning.
  'map_unmanaged',
  'map_refused',
  'map_contribution_foreign',
  'map_contribution_newer',
  'map_envelope_rebind',
  'map_renderer_missing',
  // release.install / release.rollback of an API this host does not serve (a v2-only host: no
  // PHP_BIN, src/config.ts servedApis): 422 ReleaseRefusedError, the body never read.
  'api_not_served',
  // A fapolicyd host: the root trust oneshot (src/provision/fapolicyd_trust_main.ts) did not
  // trust the release before it would run (install: before the scratch boot; rollback: before
  // the swap). 422 ReleaseRefusedError; the previous release still serves.
  'trust_failed',
] as const);

export type ReasonCode = (typeof REASON_CODES)[number];

export class ApiError extends Error {
  constructor(
    public status: number,
    public type: string,
    public title: string,
    detail?: string,
    public extensions?: Record<string, unknown>,
  ) {
    super(detail ?? title);
    this.name = 'ApiError';
  }

  get detail(): string {
    return this.message;
  }
}

/** The request is malformed: a missing actor, an unreadable body, a path outside a root. */
export class ValidationError extends ApiError {
  constructor(detail: string, reason?: ReasonCode) {
    super(400, `${PROBLEM_TYPE_BASE}validation-error`, 'Validation Error', detail, reason ? { reason } : undefined);
    this.name = 'ValidationError';
  }
}

/** Missing or wrong bearer token. This agent has no anonymous surface but GET /health. */
export class UnauthorizedError extends ApiError {
  constructor(detail: string) {
    super(401, `${PROBLEM_TYPE_BASE}unauthorized`, 'Unauthorized', detail);
    this.name = 'UnauthorizedError';
  }
}

export class NotFoundError extends ApiError {
  constructor(detail: string) {
    super(404, `${PROBLEM_TYPE_BASE}not-found`, 'Not Found', detail);
    this.name = 'NotFoundError';
  }
}

export class MethodNotAllowedError extends ApiError {
  constructor(
    method: string,
    public allow: string[],
  ) {
    super(
      405,
      `${PROBLEM_TYPE_BASE}method-not-allowed`,
      'Method Not Allowed',
      `Method ${method} is not allowed for this resource. Allowed: ${allow.join(', ')}`,
    );
    this.name = 'MethodNotAllowedError';
  }
}

/** A real resource in a state that cannot accept the request (no previous release, busy). */
export class ConflictError extends ApiError {
  constructor(detail: string, reason: ReasonCode, extensions: Record<string, unknown> = {}) {
    super(409, `${PROBLEM_TYPE_BASE}conflict`, 'Conflict', detail, { reason, ...extensions });
    this.name = 'ConflictError';
  }
}

/**
 * The request was well-formed and its CONTENT was refused by a shape check (a hostile
 * bundle, a hash that does not match the text). 422: retrying the same bytes cannot help.
 */
export class RefusedError extends ApiError {
  constructor(detail: string, reason: ReasonCode, extensions: Record<string, unknown> = {}) {
    super(422, `${PROBLEM_TYPE_BASE}refused`, 'Refused', detail, { reason, ...extensions });
    this.name = 'RefusedError';
  }
}

/**
 * A HOST EFFECT FAILED: a reload, restart or health check said no. 503: the request was
 * right, the host could not carry it out. The detail is scrubbed in production like every
 * 5xx; `reason` and `extensions` survive the scrub, so extensions carry MACHINE fields only
 * (codes, hashes, booleans), never a child process's output. A configtest that refuses
 * SUBMITTED text is not this class: the bytes are wrong, not the host, so it is a
 * RefusedError(…, 'configtest_failed') 422 (rules.apply, src/rules/apply.ts).
 */
export class HostActionFailedError extends ApiError {
  constructor(detail: string, reason: ReasonCode, extensions: Record<string, unknown> = {}) {
    super(503, `${PROBLEM_TYPE_BASE}host-action-failed`, 'Host Action Failed', detail, { reason, ...extensions });
    this.name = 'HostActionFailedError';
  }
}

/** Our fault. Unrecognised throws become this (util/response.ts). */
export class ServiceError extends ApiError {
  constructor(detail: string) {
    super(500, `${PROBLEM_TYPE_BASE}internal-error`, 'Internal Server Error', detail);
    this.name = 'ServiceError';
  }
}

/**
 * WHY A release.install / release.rollback IS REFUSED (src/releases/install.ts) — a typed SUBSET of the one
 * closed REASON_CODES list (never a second list). The phase-3 engine client branches on
 * these strings; the prose `detail` is for the operator.
 */
export const RELEASE_REFUSAL_REASONS = Object.freeze([
  /** The ustar reader refused the stream; `bundle_reason` carries its BundleRefusalReason. */
  'bundle_refused',
  /** The bytes received do not hash to X-Bundle-Sha256, or an existing id recorded another sha. */
  'sha_mismatch',
  /** The current release, or the rollback target, carries no .bundle_sha256 record. */
  'release_unverified',
  /** shared/server_config_api.php or a headers file (v1), or shared/v2.env (v2), is missing. */
  'shared_config_missing',
  /** shared/server_config_api.php (v1) is not a regular file private to its owner (the v1 pool user). */
  'shared_config_exposed',
  /** `php -l` rejected a file of a v1 bundle. */
  'php_lint_failed',
  /** A v2 bundle without node_modules/: the host never runs `bun install`. */
  'node_modules_missing',
  /** The v2 release did not answer its health URL when booted on a scratch loopback port. */
  'scratch_health_failed',
  /** Post-restart health failed; `current` is back on `rolled_back_to` (null: none existed). */
  'health_failed',
  /** …and the restored release failed its health check too: an operator must act. */
  'rollback_unhealthy',
  'no_previous_release',
  'no_current_release',
  /** The release store refused (a corrupt `current`, a non-directory release path); `store_reason` names it. */
  'store_refused',
  /** The API is not served here: a v1 release (or rollback) on a v2-only host (no PHP_BIN). */
  'api_not_served',
  /** fapolicyd: the trust oneshot did not trust the release before it ran; `trust` carries its record. */
  'trust_failed',
] as const satisfies readonly ReasonCode[]);

export type ReleaseRefusalReason = (typeof RELEASE_REFUSAL_REASONS)[number];

/**
 * 422, never 5xx, even for `rollback_unhealthy`: a 5xx detail is scrubbed in production, and
 * every refusal here is a sentence the operator has to read (which file to create, which unit
 * to look at).
 */
export class ReleaseRefusedError extends ApiError {
  constructor(
    public readonly reason: ReleaseRefusalReason,
    detail: string,
    extensions: Record<string, unknown> = {},
  ) {
    super(422, `${PROBLEM_TYPE_BASE}release-refused`, 'Release Refused', detail, { reason, ...extensions });
    this.name = 'ReleaseRefusedError';
  }
}
