/**
 * THE GLOBAL-ADMIN SESSION GATE for routes that live OUTSIDE the RQO dispatcher.
 *
 * Two raw HTTP routes are admin-only and never pass `dispatchRqo`: the hierarchy dump
 * download (`server.ts` serveHierarchyExportFile) and `/api/v1/counters`
 * (`api/counters.ts`). Until 2026-09-03 both read `session.isGlobalAdmin` — the flag
 * STAMPED ON THE SESSION ROW AT LOGIN — so a demoted administrator kept both surfaces
 * for the rest of the session's life (SEC-14). The revocation seam ends the session on
 * a dd244 write it SEES (revocation.ts), but that is a belt, not the authority: a write
 * the seam never saw (a suppressed scope, another process, a failed best-effort
 * revocation) left the login-time snapshot deciding for the whole TTL.
 *
 * This module is the ONE place a non-dispatch route asks "is the caller, RIGHT NOW, a
 * global admin". It answers the way the dispatcher does for every API action
 * (`dispatch.ts` seeds `context.principal = await resolvePrincipal(session.userId)`
 * per request): the session row proves WHO is calling, the Principal — resolved from
 * the dd128 record on every request, through the cache the dd128 write reaction
 * drops — proves WHAT they are. `Session.isGlobalAdmin` is not an authorization input
 * anywhere any more (session_store.ts docblock).
 *
 * Gate: test/unit/account_revocation_native.test.ts ("the principal, not the
 * snapshot, decides" legs — a dd244 flip applied with the seam suppressed, so the
 * session SURVIVES, closes / opens both routes on the very next request).
 */

import { getServerState } from '../resolve/server_state.ts';
import { type Principal, resolvePrincipal, SUPERUSER_ID } from './permissions.ts';
import { getSession, SESSION_COOKIE, type Session } from './session_store.ts';

/**
 * One named cookie's value out of a raw Cookie header, or undefined. THE one
 * cookie parser of the server (S09-a: five hand copies of it lived beside the
 * routes until 2026-11-19).
 *
 * Exact-name match on the split pairs — a `startsWith(name)` scan over the whole
 * header would also match any cookie whose name merely BEGINS with this one.
 */
export function readCookie(cookieHeader: string, name: string): string | undefined {
	return cookieHeader
		.split(';')
		.map((pair) => pair.trim())
		.find((pair) => pair.startsWith(`${name}=`))
		?.slice(name.length + 1);
}

/**
 * GATE 2b's ONE rule (maintenance): while `maintenance_mode` is on, every session
 * but the superuser's is treated as unauthenticated — root is who lifts it. The
 * dispatcher throws `auth.maintenance` on it (dispatch.ts runAuthGates); a
 * non-dispatch route answers its null/404 on it. Read uncached per call
 * (getServerState reads ts_state.json), so it bites the instant root sets it.
 */
export function refusedUnderMaintenance(userId: number): boolean {
	return userId !== SUPERUSER_ID && getServerState().maintenance_mode === true;
}

/**
 * THE session read of every route outside the dispatcher: the cookie parsed, the
 * session store asked, and Gate 2b applied — null when there is no cookie, no live
 * session, or while maintenance refuses it ({@link refusedUnderMaintenance}). A
 * route answers its own "unauthenticated" on null (a 404: no existence leak).
 *
 * `getSession` is importable by this module, the dispatch context
 * ({@link dispatchSessionFromCookie}) and login only — a route that asked the
 * store itself skipped the maintenance verdict (S09-a). Gates:
 * test/unit/non_dispatch_session_gate_native.test.ts (the outcome, per route),
 * test/unit/session_read_confinement_tripwire.test.ts (the importers).
 */
export function liveSessionFromCookie(cookieHeader: string | null): Session | null {
	const token = readCookie(cookieHeader ?? '', SESSION_COOKIE);
	if (token === undefined || token === '') return null;
	const session = getSession(token);
	if (session === null) return null;
	return refusedUnderMaintenance(session.userId) ? null : session;
}

/**
 * The session and its raw token for the RQO DISPATCHER's request context — and for
 * nothing else. NO maintenance verdict here on purpose: the dispatcher applies
 * Gate 2b itself (dispatch.ts runAuthGates), where the refusal is the typed
 * `auth.maintenance` the client renders, and where the few pre-auth actions
 * (login, the environment bootstrap) stay reachable. Every other route reads
 * {@link liveSessionFromCookie}.
 */
export function dispatchSessionFromCookie(cookieHeader: string | null): {
	session: Session | null;
	token: string | null;
} {
	const token = readCookie(cookieHeader ?? '', SESSION_COOKIE);
	if (token === undefined) return { session: null, token: null };
	return { session: getSession(token), token };
}

/**
 * The live session behind this request's cookie header, IF its account is a global
 * admin as of THIS request; null otherwise (no cookie, no live session, refused by
 * maintenance, or not an admin any more). Callers answer 404 on null — never 403 —
 * so an outsider cannot confirm the surface exists.
 *
 * The Principal is resolved per call on purpose: it is the cached, invalidated-on-write
 * read of the dd128 record, and the ONLY value here that a demotion can reach without
 * ending the session.
 */
export async function globalAdminSessionFromCookie(
	cookieHeader: string | null,
): Promise<Session | null> {
	const session = liveSessionFromCookie(cookieHeader);
	if (session === null) return null;
	const principal = await resolvePrincipal(session.userId);
	return principal.isGlobalAdmin ? session : null;
}

/**
 * The live session behind this request's cookie header AND its Principal resolved
 * as of THIS request, for ANY authenticated account; null when there is no cookie or
 * no live session, or while maintenance refuses it (refusedUnderMaintenance). The per-user sibling of {@link globalAdminSessionFromCookie}, for a
 * non-dispatch route that authorizes by OWNERSHIP + the permission matrix rather than
 * by admin-ness (the export artifact download, tools/tool_export/server/download.ts).
 * The caller decides what the Principal may do — this only proves who is calling and
 * what they are right now; it grants nothing.
 */
export async function sessionPrincipalFromCookie(
	cookieHeader: string | null,
): Promise<{ session: Session; principal: Principal } | null> {
	const session = liveSessionFromCookie(cookieHeader);
	if (session === null) return null;
	return { session, principal: await resolvePrincipal(session.userId) };
}
