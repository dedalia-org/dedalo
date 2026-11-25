/**
 * The error taxonomy — one class per way this API is allowed to fail.
 *
 * Every error the API emits is an RFC 9457 `application/problem+json` document, and each
 * class here fixes the three fields a client is entitled to rely on: the HTTP `status`, a
 * stable `type` URI, and a human `title`. The rendering happens in utils/response.ts
 * (`problem`), and middleware/error-handler.ts is what catches these on the way out; this
 * module only defines what may be thrown.
 *
 * **The `type` URI is a wire contract.** It is the machine-readable identifier clients
 * match on — the one field that is promised not to change, precisely so that `detail`
 * (prose, aimed at a human, freely reworded) can. Changing or removing one of these URIs
 * breaks integrations silently, so treat them as published API, not as strings. They are
 * documented at docs/diffusion/publication_api/v2/http_semantics.md.
 *
 * Throwing is the ONLY way to produce an error response: handlers never construct one.
 * That is what guarantees that no failure path can accidentally return a bare 500 or an
 * ad-hoc JSON error shape.
 */

export const PROBLEM_TYPE_BASE = 'https://dedalo.dev/api/problems/';

/**
 * The base every problem extends. Note that `detail` is carried in Error's own `message`
 * (and re-exposed by the getter) rather than stored twice, so an ApiError read as a plain
 * Error — in a log line, a stack trace — still says something useful. `extensions` are extra
 * RFC 9457 members spread into the body at render time; ValidationError uses them to attach
 * the per-field `errors` array.
 */
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

/**
 * The client's request was malformed: a bad query param, an unknown database or table, an
 * unparseable filter. This is by far the widest-used error, and it is also what a ZodError
 * is converted into by the error handler — which is where `extensions.errors` comes from.
 */
export class ValidationError extends ApiError {
  constructor(detail: string, extensions?: Record<string, unknown>) {
    super(400, `${PROBLEM_TYPE_BASE}validation-error`, 'Validation Error', detail, extensions);
    this.name = 'ValidationError';
  }
}

/**
 * MariaDB errno 1146 (no such table) on a table the API names itself (publication_schema,
 * the AV_* join tables): this publication simply lacks the feature — the client's 400,
 * never a 500. Bun's MySQLError carries the server's number in `errno`.
 */
export function isNoSuchTableError(error: unknown): boolean {
  return error instanceof Error && (error as { errno?: number }).errno === 1146;
}

/**
 * 1146 or 1054 (unknown column) on a join whose every name comes from configuration (the
 * AV_* keys): the publication does not have the tables in the shape the feature expects —
 * a numismatic database may well have an `audiovisual` table without an `image` column.
 */
export function isMissingTableOrColumnError(error: unknown): boolean {
  return isNoSuchTableError(error) || (error instanceof Error && (error as { errno?: number }).errno === 1054);
}

// Only ever raised when API_KEYS is non-empty; with no keys configured the API is open by
// design and this is unreachable. No WWW-Authenticate header is sent — the scheme is a
// bare X-API-Key header, not one of the HTTP authentication schemes.
export class UnauthorizedError extends ApiError {
  constructor(detail: string) {
    super(401, `${PROBLEM_TYPE_BASE}unauthorized`, 'Unauthorized', detail);
    this.name = 'UnauthorizedError';
  }
}

// A path that matches no route at all, or a record/table that does not exist.
export class NotFoundError extends ApiError {
  constructor(detail: string) {
    super(404, `${PROBLEM_TYPE_BASE}not-found`, 'Not Found', detail);
    this.name = 'NotFoundError';
  }
}

/**
 * The path exists but not with this method (router.ts).
 *
 * `allow` is a real field rather than prose because RFC 9110 REQUIRES a 405 to carry an
 * Allow header; utils/response.ts looks for exactly this property to emit it. The same list
 * is also spelled into `detail` so a human reading the body does not have to inspect headers.
 */
export class MethodNotAllowedError extends ApiError {
  constructor(method: string, public allow: string[]) {
    super(
      405,
      `${PROBLEM_TYPE_BASE}method-not-allowed`,
      'Method Not Allowed',
      `Method ${method} is not allowed for this resource. Allowed: ${allow.join(', ')}`,
    );
    this.name = 'MethodNotAllowedError';
  }
}

// The caller's per-IP token bucket is empty. Carries no Retry-After: the bucket refills on a
// rolling 60-second window, so any single number would be a guess.
export class RateLimitError extends ApiError {
  constructor(detail: string) {
    super(429, `${PROBLEM_TYPE_BASE}rate-limit-exceeded`, 'Too Many Requests', detail);
    this.name = 'RateLimitError';
  }
}

/**
 * The request asked for more database work than one request may commission — the
 * per-request query budget (security/request-budget.ts) ran out.
 *
 * 429 rather than 500 or 400: nothing is malformed and nothing failed, the caller simply
 * spent more than a single request's share of a shared read-only database, exactly as with
 * the rate limiter. The remedy is in the client's hands, and the detail says which knob.
 */
export class BudgetExceededError extends ApiError {
  constructor(detail: string) {
    super(429, `${PROBLEM_TYPE_BASE}request-budget-exceeded`, 'Request Budget Exceeded', detail);
    this.name = 'BudgetExceededError';
  }
}

// Our fault, not the caller's. The error handler routes every *unrecognised* throw here, and
// only echoes the underlying message in development — in production the detail is a fixed
// string, so a driver error or a stack trace can never become part of a public response body.
// This is also the only class the handler logs to the console (status >= 500).
export class ServiceError extends ApiError {
  constructor(detail: string) {
    super(500, `${PROBLEM_TYPE_BASE}internal-error`, 'Internal Server Error', detail);
    this.name = 'ServiceError';
  }
}

// The whole request outran REQUEST_TIMEOUT_MS (middleware/timeout.ts). 504 rather than 503:
// the race abandons the in-flight work rather than cancelling it, so from the client's point
// of view the upstream — the database — is what failed to answer in time.
export class TimeoutError extends ApiError {
  constructor(detail = 'The request took too long to process') {
    super(504, `${PROBLEM_TYPE_BASE}timeout`, 'Gateway Timeout', detail);
    this.name = 'TimeoutError';
  }
}
