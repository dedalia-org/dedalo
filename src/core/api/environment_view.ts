/**
 * Environment diagnostic view — a dedicated GET endpoint (developer tool).
 *
 * The PHP menu debug-bar "environment" link opened
 * `core/common/js/environment.js.php` (a PHP-generated JS dump of the client
 * environment) in a new tab so a developer could inspect the live config. The TS
 * server runs no PHP and does not serve `.php` files (sync_client.sh excludes
 * them), so that path 404s. The environment PAYLOAD is already built by
 * `buildEnvironment()` and returned to every authenticated client at page boot via
 * the `get_environment` API action — this route re-exposes it as a pretty-printed
 * JSON diagnostic for the new-tab link.
 *
 * Gate: a valid session. This is PARITY with `get_environment`, which is
 * session-only (CSRF-exempt) and hands the same payload to ANY authenticated user
 * — so admin-gating here would be stricter than the data's existing exposure. Fail
 * closed with a 404 when unauthenticated (no existence leak), matching the media /
 * raw-view routes. Read-only, no arbitrary action reachable.
 *
 * URL: GET /dedalo/core/api/v1/environment  (+ the direct twin /api/v1/environment)
 */

import { toErrorEnvelope } from '../errors/convert.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { buildEnvironment } from '../resolve/environment.ts';
import { resolvePrincipal } from '../security/permissions.ts';
import { getSession, SESSION_COOKIE, type Session } from '../security/session_store.ts';

/** Resolve the caller's session from the TS-native cookie (null when absent/expired). */
function readSessionFromCookie(request: Request): Session | null {
	const cookieHeader = request.headers.get('cookie') ?? '';
	const token = cookieHeader
		.split(';')
		.map((pair) => pair.trim())
		.find((pair) => pair.startsWith(`${SESSION_COOKIE}=`))
		?.slice(SESSION_COOKIE.length + 1);
	return token !== undefined ? getSession(token) : null;
}

/**
 * Handle GET /…/environment. Returns the client environment payload
 * ({page_globals, plain_vars}) pretty-printed for a human diagnostic.
 */
export async function handleEnvironmentView(
	request: Request,
	// server.ts routes by path + method only and does not thread its per-request
	// id here yet; a fresh one keeps `request_id` present and unique per response.
	requestId: string = crypto.randomUUID(),
): Promise<Response> {
	// Session gate — fail-closed 404 (never reveal the endpoint to the
	// unauthenticated). Converter-made, like every other refusal body.
	const session = readSessionFromCookie(request);
	if (session === null) {
		const converted = toErrorEnvelope(new DedaloError('resource.not_found'), { requestId });
		return new Response(JSON.stringify(converted.body), {
			status: converted.status,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	// Same payload the boot-time get_environment returns to this user.
	const principal = await resolvePrincipal(session.userId);
	const environment = await buildEnvironment(session, principal);

	// Pretty-printed — this endpoint exists for human inspection.
	return new Response(JSON.stringify(environment, null, 2), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}
