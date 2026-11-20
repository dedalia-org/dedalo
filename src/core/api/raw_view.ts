/**
 * Raw record data view — a DEDICATED, hard-locked GET endpoint (admin tool).
 *
 * The PHP inspector's "View record data" link opens the raw stored JSON of the
 * current record in a new browser tab. PHP served that through an ARBITRARY-RQO
 * GET (core/api/v1/json/index.php, the `$_REQUEST['rqo']` branch). We deliberately
 * do NOT port that: an arbitrary-action GET forces CSRF machinery and a read_raw
 * exemption to stay safe. Instead this single route can ONLY perform a read-only
 * raw SECTION read, with the action BUILT SERVER-SIDE and three independent gates,
 * each stricter than the PHP read_raw path:
 *   1. authenticated  — a valid TS session (else 404, no existence leak);
 *   2. administrator  — principal.isGlobalAdmin (else 403). PHP required only
 *      permission >= 1; requiring global-admin is stricter by design, matching
 *      the tool's intent (a developer/power-user inspection view);
 *   3. sensitive-section denylist — the users section (config.usersSectionTipo,
 *      'dd128') is refused BEFORE any DB read, so password hashes / user data can
 *      never be dumped. This block overrides even the superuser.
 *
 *   4. the COMPONENT KEY (P1-3 / SEC-04, 2026-09-03) — not here, INSIDE
 *      `readRaw`: every jsonb column of the row is projected to the keys the
 *      admin's OWN profile grants on the row's section (`security/read_door.ts`
 *      projectAuthorizedColumns; global admins resolve through their profile
 *      like the human read). Gate 3's dd128 denylist stays as DEFENSE IN DEPTH:
 *      the projection is the rule, the denylist is the belt for the one section
 *      whose disclosure is a credential.
 *
 * Because GET can only ever reach this one server-built read_raw, no arbitrary
 * action is reachable by GET and the global CSRF-exempt set is untouched. The
 * new-tab GET authenticates via the SameSite=Lax session cookie the browser
 * sends automatically on a top-level navigation.
 *
 * URL:      GET /dedalo/core/api/v1/raw?section_tipo=<tipo>&section_id=<int>
 * Response: pretty-printed envelope v2 — `ok(rows, {extend:{table}})`, the same
 *           body the dd_core_api::read_raw action returns with type:'section',
 *           so it stays parity-testable. A refusal is the converter's failure
 *           envelope (ERRORS_SPEC §4: this route builds no body of its own).
 */

import { config } from '../../config/config.ts';
import { readRaw } from '../api/handlers/read_raw.ts';
import { isValidTipo } from '../concepts/ontology.ts';
import { ok, toErrorEnvelope } from '../errors/convert.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import type { ErrorCode } from '../errors/registry.ts';
import { resolvePrincipal } from '../security/permissions.ts';
import { liveSessionFromCookie } from '../security/session_gate.ts';

/**
 * Sections whose raw data is never dumpable through this endpoint, even by an
 * admin or the superuser. A Set so adding adjacent sensitive sections later
 * (e.g. a standalone password section) is a one-line change.
 */
const SENSITIVE_RAW_VIEW_SECTIONS: ReadonlySet<string> = new Set<string>([config.usersSectionTipo]);

/**
 * Fail-closed JSON refusal — the CONVERTER builds it (registry status, no
 * existence/permission leak; `perm.denied`'s disclosure is `operator`, so no
 * refusal here can name what it refused).
 */
function refuse(code: ErrorCode, requestId: string): Response {
	const converted = toErrorEnvelope(new DedaloError(code), { requestId });
	return new Response(JSON.stringify(converted.body), {
		status: converted.status,
		headers: { 'Content-Type': 'application/json' },
	});
}

/**
 * Handle GET /…/raw. Returns a Response; the caller (server.ts) only routes by
 * path + method. All authorization and validation lives here.
 */
export async function handleRawView(
	request: Request,
	url: URL,
	// server.ts routes by path + method only and does not thread its per-request
	// id here yet; a fresh one keeps `request_id` present and unique per response.
	requestId: string = crypto.randomUUID(),
): Promise<Response> {
	// Gate 1 — authenticated. 404 (not 401): never reveal the endpoint exists.
	const session = liveSessionFromCookie(request.headers.get('cookie'));
	if (session === null) {
		return refuse('resource.not_found', requestId);
	}

	// Gate 2 — administrator level. Server-authoritative: re-resolve the flag from
	// the DB rather than trusting anything client-supplied (PHP is_global_admin;
	// superuser -1 always qualifies).
	const principal = await resolvePrincipal(session.userId);
	if (!principal.isGlobalAdmin) {
		console.warn(`[raw_view] denied: user ${session.userId} is not a global admin`);
		return refuse('perm.denied', requestId);
	}

	// Gate 3 — strict identifier validation (§7.6 chokepoint) BEFORE any SQL.
	const sectionTipo = url.searchParams.get('section_tipo') ?? '';
	if (!isValidTipo(sectionTipo)) {
		return refuse('resource.not_found', requestId);
	}
	const sectionId = Number(url.searchParams.get('section_id') ?? '');
	if (!Number.isInteger(sectionId) || sectionId <= 0) {
		return refuse('resource.not_found', requestId);
	}

	// Gate 4 — sensitive-section denylist. Overrides admin/superuser; refused
	// before touching the database so the users section is never even read.
	if (SENSITIVE_RAW_VIEW_SECTIONS.has(sectionTipo)) {
		console.warn(
			`[raw_view] denied: admin ${session.userId} attempted raw read of sensitive section ${sectionTipo}`,
		);
		return refuse('perm.denied', requestId);
	}

	// Server-built read_raw: action/type/model are FIXED here, not client-controllable.
	// A single-locator SQO on the requested record (PHP inspector get_raw_record_rqo).
	const outcome = await readRaw(
		{
			sectionTipo,
			tipo: sectionTipo,
			model: 'section',
			type: 'section',
			sqo: {
				section_tipo: [sectionTipo],
				limit: 1,
				filter_by_locators: [{ section_tipo: sectionTipo, section_id: sectionId }],
			},
		},
		principal,
	);

	// Always pretty-print — this endpoint exists for human inspection.
	const body = ok(outcome.result, { requestId, extend: { table: outcome.table } });
	return new Response(JSON.stringify(body, null, 2), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}
