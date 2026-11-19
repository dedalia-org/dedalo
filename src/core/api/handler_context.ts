/**
 * Shared per-request handler context + registry types (WS-C S2-25 extraction).
 *
 * Home of the pieces every api/handlers/<class>.ts module needs WITHOUT
 * importing dispatch.ts (which statically imports the handler modules —
 * importing it back would create a runtime cycle):
 *  - ApiRequestContext — created by the HTTP layer, threaded explicitly;
 *  - ActionHandler — the registry entry signature;
 *  - requirePrincipal — the seeded-identity accessor handlers read instead of
 *    re-resolving the principal from the DB.
 *
 * dispatch.ts re-exports ApiRequestContext so existing importers keep working.
 */

import type { Rqo } from '../concepts/rqo.ts';
import { DedaloError } from '../errors/index.ts';
import type { Principal } from '../security/permissions.ts';
import type { Session } from '../security/session_store.ts';
import type { ApiResult } from './response.ts';

/** Per-request state — created by the HTTP layer, threaded explicitly. */
export interface ApiRequestContext {
	requestId: string;
	clientIp: string;
	session: Session | null;
	/**
	 * The RAW session cookie value (not the hash). Needed by actions that must
	 * mutate THIS session row — e.g. change_lang persisting the language choice.
	 * Null when the request carries no session cookie.
	 */
	sessionToken?: string | null;
	/**
	 * The pre-auth interface language carried by the anonymous language cookie
	 * (see ApiResult.setPreauthLangCookie), or null. Used ONLY when there is no
	 * session lang: the session row always wins once the user is logged in.
	 * Validated against the install's DEDALO_APPLICATION_LANGS allowlist before use.
	 */
	preauthLang?: string | null;
	/** Raw CSRF token from header/body, if any. */
	csrfCandidate: string | null;
	/**
	 * WHICH CHANNEL carried the token — `'header'` (every XHR the client makes),
	 * `'body'` (the rqo field, the ONE door sendBeacon can use: beforeunload cannot
	 * set headers) or null (nothing was sent). Diagnostic only, never authorization:
	 * the refusal in `runAuthGates` prints it, because "the lock beacon at tab close
	 * is sending a stale token" and "a live page never obtained one" are different
	 * faults with the same error code, and a log line that cannot tell them apart is
	 * a log line nobody can act on.
	 */
	csrfSource?: 'header' | 'body' | null;
	/** Transport-layer receipt time (performance.now()), for the access log (S2-37). */
	startedAt?: number;
	/** Resolved authorization identity — seeded ONCE per request by dispatchRqo
	 * (after the auth gate) and read by handlers via requirePrincipal(). */
	principal?: Principal;
}

export type ActionHandler = (rqo: Rqo, context: ApiRequestContext) => Promise<ApiResult>;

/**
 * The seeded authorization identity for the current request. dispatchRqo
 * resolves the principal exactly once (after the auth gate passes) and stores it
 * on the context; every authenticated handler reads it here instead of
 * re-resolving it from the DB. Throws if called without a seeded principal — a
 * programming error, since these paths run only behind the auth gate.
 */
export function requirePrincipal(context: ApiRequestContext): Principal {
	if (context.principal === undefined) {
		throw new DedaloError('internal.invariant', {
			message:
				'requirePrincipal: no authenticated principal on request context (unauthenticated action?)',
		});
	}
	return context.principal;
}
