/**
 * Dédalo TS server — HTTP entry point.
 *
 * Bun.serve on a UNIX SOCKET only: the reverse proxy (Apache/Nginx) owns TCP,
 * serves static files/media, and forwards API traffic here (spec §4; same
 * pattern as the production diffusion engine).
 *
 * PERSISTENT-RUNTIME DISCIPLINE (spec §4, plan risk A5.1): every request gets
 * its own RequestContext created HERE and threaded explicitly through all
 * resolution code. Nothing request-dependent may live at module level. The
 * context object is the one place request identity exists.
 *
 * Routes:
 * - /health (liveness);
 * - /api/v1/json + /dedalo/core/api/v1/json[/] (parse → zod-validate →
 *   dispatch; auth/CSRF/allowlist gates live in core/api/dispatch.ts). The
 *   /dedalo alias is the path the COPIED CLIENT computes relatively from its
 *   page URL (data_manager fallback '../api/v1/json/');
 * - GET /dedalo/* — the copied client static assets (Phase 7 seam), served
 *   from client/dedalo/ at the SAME paths the PHP deployment uses so the
 *   client's relative references need no edits;
 * - GET /, /dedalo[/], /dedalo/core[/] — 302 to the app entry point
 *   (ENTRY_REDIRECT_PATHS; the PHP index.php shims).
 */

import { chmodSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { Glob } from 'bun';
import {
	runBootSchema,
	startOnlineMigrations,
	stopOnlineMigrations,
} from '../install/db/migrate.ts';
import { initRagHooks } from './ai/rag/bootstrap.ts';
import { config } from './config/config.ts';
import { projectRoot, readEnv } from './config/env.ts';
import { AI_MODEL_URL_PREFIX, serveModelRequest } from './core/ai/model_store.ts';
import { handleCountersRequest } from './core/api/counters.ts';
import { type ApiRequestContext, dispatchRqo } from './core/api/dispatch.ts';
import { handleEnvironmentView } from './core/api/environment_view.ts';
import { buildHealthPayload } from './core/api/health_payload.ts';
import { getProcessPoison } from './core/api/process_health.ts';
import { handleRawView } from './core/api/raw_view.ts';
import { MIN_GZIP_BYTES, SECURITY_HEADERS, staticAssetResponse } from './core/api/static_asset.ts';
import { CLIENT_LIB_URL_PREFIX, serveClientLibRequest } from './core/client_libs/serving.ts';
import { handleTagRequest } from './core/components/component_text_area/tag_endpoint.ts';
import { mediaTypeOf } from './core/concepts/media.ts';
import { CLIENT_ROOT, publishClientAtBoot } from './core/install/client_publish.ts';
import { provisionMediaTreeAtBoot } from './core/install/media_tree.ts';
import { resolveStagedPath, STAGED_URL_PREFIX } from './core/media/ingest/staged_files.ts';
import {
	layAuthMarker,
	MEDIA_AUTH_COOKIE,
	mintAuthCookieValue,
	resolveMediaAccessMode,
	resolveMediaAccessModeDetail,
	retireLegacyAuthStore,
	writeRuleFiles,
} from './core/media/protection.ts';
import {
	isImageEnvelopeSvg,
	SVG_ENVELOPE_CSP,
	SVG_QUARANTINE_CSP,
	SVG_QUARANTINE_DISPOSITION,
} from './core/media/svg_safety.ts';
import { publicOrigin, publicOriginIsLocal } from './core/resolve/public_origin.ts';
// S2-20 boot registration: loading the component registry registers the
// ontology↔components model lookup (module-load side effect) BEFORE any request
// resolves a component model. Keep this explicit even though other imports
// reach it transitively — the seam must not depend on incidental import paths.
import './core/components/registry.ts';
import { readString } from './config/readers.ts';
import { HIERARCHY_EXPORT_URL_PREFIX } from './core/area_maintenance/widgets/export_hierarchy.ts';
import { rqoSchema } from './core/concepts/rqo.ts';
import { toErrorEnvelope } from './core/errors/convert.ts';
import { DedaloError } from './core/errors/dedalo_error.ts';
import { describeInstallAllowPolicy, installInProgress } from './core/install/gate.ts';
import { HIERARCHY_IMPORT_DIR } from './core/install/paths.ts';
import { HIERARCHY_MANIFEST_FILE } from './core/ontology/hierarchy_manifest_format.ts';
import { corsPreflightResponse, corsResponseHeaders } from './core/security/cors.ts';
import { globalAdminSessionFromCookie } from './core/security/session_gate.ts';
import {
	getSession,
	SESSION_COOKIE,
	SESSION_IDLE_TTL_SECONDS,
	setSessionMediaKey,
} from './core/security/session_store.ts';
import { startToolBootHooks, toolHttpRouteFor } from './core/tools/loader.ts';
import { safeRealpath } from './core/tools/paths.ts';
import { serveToolsRequest } from './core/tools/serving.ts';
import { DEDALO_ENGINE_VERSION } from './core/update/build_stamp.ts';
import { ensureCodeFilesDirAtBoot } from './core/update/code_files_dir.ts';
import { CODE_RELEASE_URL_PREFIX, serveCodeReleaseRequest } from './core/update/code_serving.ts';
import { INSTALLED_DIGEST } from './core/update/install_stamp.ts';

/**
 * CLIENT_ROOT canonicalised once. The symlink-escape check in serveClientAsset
 * compares canonical paths, so the BASE must be canonical too — otherwise a
 * checkout reached through a symlinked parent (…/v7 → /Volumes/…) would fail
 * every comparison and 404 the whole client. Falls back to the lexical root if
 * the tree is somehow unreadable at boot.
 */
const CLIENT_ROOT_CANONICAL = safeRealpath(CLIENT_ROOT) ?? CLIENT_ROOT;

/**
 * Media directory served under /dedalo/<mediaDir>/ (the PHP DEDALO_MEDIA_URL
 * layout). In production the REVERSE PROXY serves media and enforces the
 * marker-based per-record access control (spec §7.9); this route is a
 * DEV-listener convenience only.
 *
 * The root comes from the CATALOG (config.media.rootPath), which derives
 * <projectRoot>/media unless MEDIA_PATH overrides it. It used to re-read
 * MEDIA_PATH from env here — a shadow read of a key the catalog already owns —
 * so this route stayed dead (MEDIA_ROOT null → 404) even once the catalog
 * resolved the root, and every media URL 404'd on a fresh install.
 *
 * SECURITY (M5): this route checks for a valid session but applies NO per-record
 * / per-project ACL — any authenticated user can read any file under the media
 * root by path. That is acceptable for a single-developer dev listener but a
 * horizontal data break if exposed. It is therefore OFF by default and must be
 * explicitly enabled with MEDIA_DEV_ROUTE_ENABLED=true (never in production —
 * production is socket-only and lets the reverse proxy + marker store serve media).
 */
const MEDIA_ROOT = config.media.rootPath !== null ? resolve(config.media.rootPath) : null;
/**
 * The media TYPE folders, as this install names them — the only first segments
 * the dev media listener may serve (CARRY-11). Derived from the media specs so a
 * renamed DEDALO_*_FOLDER stays servable and a NEW sibling directory does not.
 */
const MEDIA_MODELS = [
	'component_image',
	'component_av',
	'component_pdf',
	'component_svg',
	'component_3d',
] as const;

function MEDIA_TYPE_FOLDERS(): Set<string> {
	return new Set(
		MEDIA_MODELS.map((model) => mediaTypeOf(model)?.folder.replace(/^\//, '')).filter(
			(folder): folder is string => folder !== undefined,
		),
	);
}

const MEDIA_URL_PREFIX = `/dedalo/${config.mediaDir}/`;

/**
 * Whether THIS request may be answered by the engine's media fallback.
 *
 * Media is served by the WEB SERVER (src/core/media/protection.ts generates the
 * Apache/nginx rules; one stat() per request, sendfile + Range intact). This route
 * is the fallback for the one case where no web server is in the path at all: a
 * developer hitting the TCP dev listener directly. Without it a fresh install
 * following docs/install/dev_quickstart.md 404s every image, video and PDF — which
 * is what happened, because the flag below is off by default and the quickstart
 * never mentions it.
 *
 * Rather than a flag an operator must remember, the fallback is bound to conditions
 * that CANNOT hold in production, so MEDIA-04 ("never in production") is structural:
 *
 *  1. PROTECTION WINS, ALWAYS — and no flag can override this. Once an admin sets
 *     private/publication the generated web-server rules are authoritative: the engine
 *     must never serve the same bytes with weaker checks (session-only, no per-record
 *     ACL). Letting MEDIA_DEV_ROUTE_ENABLED=true punch through would (a) hand a logged-in
 *     session every master file the markers were gating and (b) BREAK rule B, because an
 *     anonymous visitor of a published record carries no session and would get a 404 from
 *     here instead of the file the marker says is public. A stale `true` copied between
 *     .env files must not be able to do that.
 *  2. Dev TCP listener only. Production is socket-only (SERVER_TCP_PORT is unset there —
 *     docs/install/production.md), so the fallback does not exist for it.
 *
 * MEDIA_DEV_ROUTE_ENABLED therefore only moves the needle while protection is UNCONFIGURED:
 * 'true' forces the fallback on for every listener (loud boot warning — it reaches the
 * socket), 'false' forces it off even in dev. With protection configured it is inert.
 */
function mediaFallbackAllowed(context: RequestContext): boolean {
	// (1) A CONFIGURED gate is never bypassable — check it before the flag, so the flag
	// cannot re-open what an admin closed. Cheap on the hot path: the mode read only
	// happens for requests actually addressed to the media prefix (see the call site).
	//
	// (!) 'CONFIGURED', not 'on'. Since 2026-08-24 an install that configured nothing
	// resolves to the fail-closed default 'publication', and reading that as "a gate is
	// in place" would stand this route down on every install with NO WEB SERVER in front
	// of its media — the documented dev_quickstart flow — so every image, video and PDF
	// would 404 for logged-in editors, with MEDIA_DEV_ROUTE_ENABLED unable to help
	// (it is inert once a mode is set). A security default whose first effect is that
	// teaches operators exactly one thing: how to switch it off. The DEFAULT stands this
	// route down only where the generated rules are actually being read — i.e. where an
	// operator made the choice.
	const { mode, source } = resolveMediaAccessModeDetail();
	if (mode !== false && source !== 'default') return false;
	if (mode !== false && source === 'default' && context.devListener !== true) {
		// The unconfigured default still refuses the SOCKET listener: there a web server
		// IS in front, reading rules that now gate the tree, and this route would serve
		// the same bytes with weaker checks.
		return false;
	}

	const explicit = readEnv('MEDIA_DEV_ROUTE_ENABLED');
	if (explicit === 'true') return true; // force-on, unprotected installs only
	if (explicit === 'false') return false;

	// (2) Default: the one listener a browser can reach with no web server in front.
	return context.devListener === true;
}

/**
 * Transport-layer request metadata, created by the HTTP handler and threaded
 * explicitly (never stored globally). It deliberately carries ONLY id/timing —
 * the request's IDENTITY (session, principal, permissions, language) lives on
 * the API-layer `ApiRequestContext` (core/api/dispatch.ts) and, for the duration
 * of a handler, in the request-scoped AsyncLocalStorage contexts opened by
 * `dispatchRqo` (core/security/request_context.ts + core/resolve/request_lang.ts).
 * Keeping identity out of every module-level value is the §4 request-isolation
 * invariant.
 */
export interface RequestContext {
	/** Unique id for tracing/log correlation. */
	readonly requestId: string;
	/** Wall-clock start, for latency metrics. */
	readonly startedAt: number;
	/**
	 * True only for requests that arrived on the TCP DEV listener (SERVER_TCP_PORT).
	 * Production is socket-only, so this is permanently false there — which is what
	 * lets the media fallback (mediaFallbackAllowed) be safe by construction rather
	 * than by an operator remembering a flag. Transport fact, not identity.
	 */
	readonly devListener?: boolean;
	/**
	 * The TRANSPORT's own peer address (Bun `server.requestIP`), or null on the unix
	 * socket, where the peer is a local socket with no address to report. Unforgeable:
	 * it comes from the connection, not from a header.
	 */
	readonly peerIp?: string | null;
	/**
	 * May this request's `X-Forwarded-For` be believed? True only when a reverse proxy
	 * is known to stand in front of THIS listener (TRUSTED_PROXY_TRANSPORT). A header
	 * is only as trustworthy as the transport that delivered it.
	 */
	readonly proxyTrusted?: boolean;
}

/**
 * Exported for tests that call `handleRequest` directly (no socket).
 *
 * `proxyTrusted` defaults to FALSE — a context nobody described is a context with no
 * proxy behind it, and defaulting the other way would hand every future caller the
 * spoofable behaviour by omission. The listeners set it explicitly.
 */
export function createRequestContext(
	options: { devListener?: boolean; peerIp?: string | null; proxyTrusted?: boolean } = {},
): RequestContext {
	return {
		requestId: crypto.randomUUID(),
		startedAt: performance.now(),
		devListener: options.devListener === true,
		peerIp: options.peerIp ?? null,
		proxyTrusted: options.proxyTrusted === true,
	};
}

/**
 * Number of TRUSTED reverse-proxy hops in front of this server. The proxy chain
 * APPENDS one X-Forwarded-For entry per hop on the right, so the genuine client
 * address is the entry `TRUSTED_PROXY_HOPS` from the right — everything further
 * left is client-supplied and MUST NOT be trusted. Default 1 (the standard single
 * nginx/Apache in front). The reverse proxy must append (not replace-with-client)
 * XFF for this to hold — the production default.
 *
 * Read through a function rather than captured at module load, so a test can set
 * the key and observe the effect: a module-level const is fixed at import, and a
 * gate written against one would be asserting nothing but its own default.
 */
function trustedProxyHops(): number {
	return Math.max(1, Number(readString('TRUSTED_PROXY_HOPS')) || 1);
}

/**
 * WHICH TRANSPORT MAY SPEAK X-Forwarded-For. `socket` (the default) means only the
 * unix-socket listener — the documented production topology, where the socket is
 * reachable only by the local reverse proxy. `tcp` is the escape hatch for a
 * topology that really does put a proxy in front of SERVER_TCP_PORT; `none`
 * disables XFF entirely.
 */
function trustedProxyTransport(): string {
	const value = readString('TRUSTED_PROXY_TRANSPORT');
	return value === undefined || value === '' ? 'socket' : value;
}

/**
 * The client IP for throttle and audit.
 *
 * X-Forwarded-For is a request HEADER: anything that can open a connection can
 * write it. It is trustworthy only because a reverse proxy is known to have
 * rewritten it — so it may be read only on a transport where a proxy is known to
 * stand in front, and on any other transport the transport's own peer address is
 * the only honest answer.
 *
 * That distinction was missing until 2026-08-24: the hop arithmetic was right, but
 * it ran on EVERY listener. On the direct TCP listener, which has no proxy in
 * front, a client simply sent its own `X-Forwarded-For` and chose what this
 * function returned — unlimited login-throttle buckets (the brute-force protection
 * this value exists for), forged addresses in dd544 activity rows, and, since the
 * install gate matches the literal `127.0.0.1`, a spoofable claim to be loopback.
 * The old comment's "this is never an authorization input" was not true.
 *
 * A short header is treated as forged, not as a shorter chain: fewer entries than
 * there are trusted hops means the request did not come through the proxy chain
 * the operator described.
 */
export function clientIpFromRequest(request: Request, context?: RequestContext): string {
	// No context: a direct handleRequest() call from a test. Fall back to the
	// production shape (socket transport, no peer address) rather than inventing
	// trust — the socket listener is the one this default describes.
	const proxyTrusted = context === undefined ? true : context.proxyTrusted;
	const peerIp = context?.peerIp ?? null;

	if (!proxyTrusted) return peerIp ?? 'local';

	const xff = request.headers.get('x-forwarded-for');
	if (xff === null || xff.trim() === '') return peerIp ?? 'local';
	const parts = xff
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry !== '');
	const hops = trustedProxyHops();
	// FEWER ENTRIES THAN HOPS: the chain the operator described did not happen, so
	// every entry present is client-written. This used to clamp the index to 0 and
	// return the LEFT-MOST entry — i.e. the attacker's own value, which is exactly
	// the spoof the hop arithmetic exists to prevent.
	if (parts.length < hops) return peerIp ?? PROXY_MALFORMED_IP;
	return parts[parts.length - hops] ?? peerIp ?? PROXY_MALFORMED_IP;
}

/**
 * The address for a request whose X-Forwarded-For is shorter than the configured
 * hop count and whose transport has no peer address to fall back on.
 *
 * A distinct token rather than 'local': it must never satisfy a loopback check,
 * and it must be visible to an operator reading an audit row. It cannot amplify
 * into an install-wide lockout, because a login throttle key carries the USERNAME
 * as well (`buildThrottleKey`), so a misconfigured hop count degrades to one
 * bucket per account rather than one bucket for everybody. The exception worth
 * knowing is the password-reset VERIFY throttle, which is keyed by reset id.
 */
const PROXY_MALFORMED_IP = 'proxy-malformed';

/** Parse the Content-Length header to a non-negative integer, else undefined. */
export function parseContentLength(header: string | null): number | undefined {
	if (header === null) return undefined;
	const value = Number(header);
	return Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Whether to mark the session cookie `Secure` (M4). Default TRUE — the app must
 * not silently delegate this to the proxy; a single cleartext hop would leak the
 * token. Set SESSION_COOKIE_SECURE=false ONLY for a plaintext-localhost dev
 * listener (the browser drops a Secure cookie over http://).
 */
const SESSION_COOKIE_SECURE = readString('SESSION_COOKIE_SECURE') !== 'false';

/**
 * Explicit per-request body cap (M6) — replaces reliance on Bun's silent default.
 * Every JSON body and every single multipart chunk is fully buffered in this
 * long-lived process, so an unbounded body is a memory-exhaustion DoS. The
 * vendored client ALWAYS chunks large uploads, so a single request never needs
 * the full per-FILE cap (advertised separately by get_system_info); 256 MiB is
 * generous for one chunk while bounding abuse. Tune via SERVER_MAX_BODY_BYTES.
 */
const MAX_REQUEST_BODY_BYTES = Math.max(
	1,
	Number(readString('SERVER_MAX_BODY_BYTES')) || 256 * 1024 * 1024,
);

/**
 * One named cookie's value out of a raw Cookie header, or undefined.
 *
 * Exact-name match on the split pairs — a `startsWith(name)` scan would also match
 * any cookie whose name merely BEGINS with this one.
 */
function readCookie(cookieHeader: string, name: string): string | undefined {
	return cookieHeader
		.split(';')
		.map((pair) => pair.trim())
		.find((pair) => pair.startsWith(`${name}=`))
		?.slice(name.length + 1);
}

/**
 * The PRE-AUTH LANGUAGE cookie (login-panel change_lang). Anonymous callers have no
 * session row, so the language chosen on the login form is remembered here and read
 * back by dispatch when seeding the request language scope.
 *
 *  HttpOnly     the client never reads it — page_globals already carries the lang.
 *  Max-Age 1y   a preference, not a credential: it must survive the browser session.
 *  Value        an install lang code, allowlisted (DEDALO_APPLICATION_LANGS) at read
 *               time in dispatch — never trusted straight off the wire.
 */
const PREAUTH_LANG_COOKIE = 'dedalo_lang';
const PREAUTH_LANG_MAX_AGE = 60 * 60 * 24 * 365;

function preauthLangCookieHeader(value: string): string {
	const attributes = ['HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${PREAUTH_LANG_MAX_AGE}`];
	if (SESSION_COOKIE_SECURE) attributes.push('Secure');
	return `${PREAUTH_LANG_COOKIE}=${value}; ${attributes.join('; ')}`;
}

/** Assemble the session Set-Cookie header with consistent attributes. */
function sessionCookieHeader(value: string, options: { clear?: boolean } = {}): string {
	const attributes = ['HttpOnly', 'SameSite=Lax', 'Path=/'];
	if (SESSION_COOKIE_SECURE) attributes.push('Secure');
	if (options.clear === true) attributes.push('Max-Age=0');
	return `${SESSION_COOKIE}=${value}; ${attributes.join('; ')}`;
}

/**
 * The media-auth Set-Cookie (Rule A — core/media/protection.ts; PHP
 * login::init_cookie_auth). It carries the same security posture as the session cookie
 * BY CONSTRUCTION: a Secure session cookie sitting next to a cleartext media cookie
 * would leak an authorization value on a single plaintext hop.
 *
 *  HttpOnly     JS never reads it — but the browser still attaches it to <img>/<video>
 *               subresource loads, which is the entire mechanism.
 *  SameSite=Lax matches the session cookie. Consequence to know: media embedded
 *               CROSS-SITE will not carry it (PHP set no SameSite and inherited the
 *               browser default, so this is parity-or-stricter).
 *  Path=/       PHP parity. A narrower Path=/dedalo/<mediaDir> would break on any
 *               install that renamed DEDALO_MEDIA_DIR.
 *  Max-Age      THE SESSION IDLE WINDOW (WC-051), re-issued on every authenticated
 *               request exactly as the session itself is refreshed — so the media
 *               credential and the session die together. It was a fixed 86400 minted
 *               only at login, which broke both ways: images 404'd for anyone logged
 *               in over a day, and a cookie outlived its session by up to 48h.
 *               Max-Age rather than Expires sidesteps the Expires comma-formatting
 *               hazard inside a Set-Cookie.
 */
function mediaAuthCookieHeader(value: string, options: { clear?: boolean } = {}): string {
	const attributes = ['HttpOnly', 'SameSite=Lax', 'Path=/'];
	if (SESSION_COOKIE_SECURE) attributes.push('Secure');
	attributes.push(options.clear === true ? 'Max-Age=0' : `Max-Age=${SESSION_IDLE_TTL_SECONDS}`);
	return `${MEDIA_AUTH_COOKIE}=${value}; ${attributes.join('; ')}`;
}

// SECURITY_HEADERS (L6, every response) now lives in core/api/static_asset.ts
// — one definition shared with the static handlers. Authenticated JSON
// additionally gets Cache-Control: no-store below.

/** JSON response helper with the standard envelope fields. */
function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json', ...SECURITY_HEADERS },
	});
}

/**
 * The dispatch response, gzip-negotiated.
 *
 * NOT a wire-contract entry: `engineering/WIRE_CONTRACT.md` ledgers divergences
 * in the JSON API OUTPUT, and the JSON bytes here are byte-identical either way
 * — only `Content-Encoding` changes. The invariant is tripwired instead, by
 * `test/unit/api_gzip_native.test.ts`, whose central assertion is that what the
 * client parses after decompression equals what the plain door would have sent.
 *
 * A section EDIT read is ~297 KB of JSON and 92.7% of it is compressible
 * redundancy (25.7% is exact-duplicate field values — the repeated `tools`
 * block alone is 39,738 B across 46 of 81 context entries). Measured on the
 * numisdata3/1 edit payload: level 1 → 31,831 B in 1.1 ms (10.7% of the
 * original); level 9 → 21,734 B but costs several times the CPU. Level 1 is
 * the right default — it buys 89% of the level-9 win for ~1 ms.
 *
 * This is a TRANSPORT concern, so it lives here next to the cookie policy and
 * not in api/response.ts, which owns the envelope. The JSON bytes are
 * unchanged, so there is no wire-shape divergence — only Content-Encoding.
 *
 * `Vary: Accept-Encoding` is emitted whenever we compress: authenticated
 * payloads already carry `Cache-Control: no-store`, but unauthenticated ones do
 * not, and an intermediary that cached a gzipped body without Vary would serve
 * it to a client that never asked for gzip.
 *
 * WHY COMPRESSING AN AUTHENTICATED BODY IS SAFE HERE (BREACH). Every response
 * carries `csrf_token` (dispatch.ts appends it for client transparency), and
 * compressing a secret alongside attacker-influenced text is the BREACH shape.
 * It is not reachable on this door, and the load-bearing reason is the COOKIE,
 * not the origin list. BREACH needs the victim's browser to issue many
 * cross-origin requests that come back carrying the VICTIM'S secret; the
 * session cookie is `SameSite=Lax` (see sessionCookieHeader), so it never rides
 * a cross-site POST however the calling page asks for it. A cross-origin
 * response is therefore an ANONYMOUS one: it holds no session of the victim's
 * to compress a token against. `verifyCsrf` (dispatch.ts) and the CORS
 * allowlist (security/cors.ts) narrow the door further, but they are not what
 * closes it — an operator running a PUBLIC ontology master sets
 * `DEDALO_CORS_ALLOWED_ORIGINS=["*"]` and the analysis above still holds. If
 * the session cookie's SameSite posture is ever relaxed, or a cross-origin
 * response is ever allowed to carry credentials, REVISIT THIS.
 */
export function jsonApiResponse(
	body: unknown,
	status: number,
	headers: Headers,
	request: Request,
): Response {
	const json = JSON.stringify(body);
	const bytes = new TextEncoder().encode(json);
	const acceptsGzip = (request.headers.get('accept-encoding') ?? '').includes('gzip');
	// Threshold on the ENCODED length, not json.length — a multibyte-heavy
	// payload (this is a multilingual heritage system) is bigger on the wire
	// than its JS string length suggests.
	if (!acceptsGzip || bytes.byteLength <= MIN_GZIP_BYTES) {
		return new Response(json, { status, headers });
	}
	headers.set('Content-Encoding', 'gzip');
	headers.append('Vary', 'Accept-Encoding');
	return new Response(Bun.gzipSync(bytes, { level: 1 }) as BodyInit, { status, headers });
}

/**
 * THE HTTP-LAYER FAILURE DOOR (engineering/ERRORS_SPEC.md §4): every failure
 * Response this file builds itself — parse/RQO refusals, route 404s, the
 * Bun.serve `error` catch-all — is converter-made (toErrorEnvelope: registry
 * status, envelope v2, `Content-Type: application/json`). Nothing here hand-
 * builds a body; the detail of an unexpected throw is logged server-side and
 * the wire gets the registry message + request_id, never a raw stack (which
 * can carry SQL / paths — API-01 hardening).
 */
function jsonFailureResponse(error: unknown, requestId: string): Response {
	const converted = toErrorEnvelope(error, { requestId });
	const response = jsonResponse(converted.body, converted.status);
	if (converted.retryAfterMs !== undefined) {
		response.headers.set('Retry-After', String(Math.ceil(converted.retryAfterMs / 1000)));
	}
	return response;
}

/** Sanitized 500 for the Bun.serve `error` catch-all — no request context survives to here. */
function jsonErrorResponse(): Response {
	return jsonFailureResponse(new DedaloError('internal.unexpected'), 'unhandled');
}

/** The route-level 404: `resource.not_found` (no existence leak — one shape for every miss). */
function notFoundResponse(requestId: string): Response {
	return jsonFailureResponse(new DedaloError('resource.not_found'), requestId);
}

/** The application entry point — the only client directory with an index.html. */
const APP_ENTRY_PATH = '/dedalo/core/page/';

/**
 * Entry-point redirects. The client tree has NO index.html above core/page/, so a
 * user who types the mount point ("/dedalo/") rather than the full page path used
 * to get a bare 404 — the engine's static branch looked for an index.html that
 * cannot exist. The PHP deployment answered these with 301 shims (index.php →
 * core/page/, core/index.php → page/); those files are gone with the engine, so
 * the redirects live here, where they hold for EVERY topology (dev TCP listener,
 * unix socket, whatever proxy is in front) instead of only where a proxy config
 * happens to repeat them. deploy/nginx.conf repeats the two /dedalo paths only
 * because nginx serves the client tree from an alias and they never reach us.
 *
 * 302, not PHP's 301: a permanent redirect is cached by the browser until the
 * user clears it, which pins the mount point of an install that may later move.
 * Matches the `location = /` line already in deploy/nginx.conf.
 */
const ENTRY_REDIRECT_PATHS: ReadonlySet<string> = new Set([
	'/',
	'/dedalo',
	'/dedalo/',
	'/dedalo/core',
	'/dedalo/core/',
]);

/** 302 to `location`, carrying the baseline security headers like every other response. */
function redirectResponse(location: string): Response {
	return new Response(null, {
		status: 302,
		headers: { Location: location, 'Cache-Control': 'no-store', ...SECURITY_HEADERS },
	});
}

/**
 * Serve one copied-client asset (GET /dedalo/*). Fail-closed: decoded paths are
 * resolved and must stay inside CLIENT_ROOT — LEXICALLY (traversal) and then
 * CANONICALLY (symlink escape); anything missing or outside is a plain 404. A
 * directory path serves its index.html. Response semantics
 * (validators/304/Cache-Control/gzip) come from staticAssetResponse.
 *
 * The canonical half arrived with WC-006 (2026-08-16): the tool_common subtree
 * moved in here from a route of its own whose `confineUnder` canonicalised with
 * realpath, and a move must not weaken a guarantee. The whole client tree gets
 * the stronger check — one realpath per asset request, on a path that is
 * stat()ed anyway. Gate: tools_path_confinement.test.ts plants a real symlink.
 */
async function serveClientAsset(
	pathname: string,
	request: Request,
	requestId: string,
): Promise<Response> {
	let decodedPath: string;
	try {
		decodedPath = decodeURIComponent(pathname);
	} catch {
		return notFoundResponse(requestId);
	}
	// Strip the /dedalo prefix; map onto the client root.
	const relativePath = decodedPath.replace(/^\/dedalo\/?/, '');
	let fullPath = resolve(CLIENT_ROOT, relativePath);
	if (fullPath !== CLIENT_ROOT && !fullPath.startsWith(CLIENT_ROOT + sep)) {
		return notFoundResponse(requestId); // traversal attempt
	}
	// Symlink escape: a lexical check passes a link that POINTS outside the tree.
	// Canonicalise and re-check. A missing path canonicalises to null and falls
	// through to the normal 404 below (existence is never leaked either way).
	const canonicalPath = safeRealpath(fullPath);
	if (
		canonicalPath !== null &&
		canonicalPath !== CLIENT_ROOT_CANONICAL &&
		!canonicalPath.startsWith(CLIENT_ROOT_CANONICAL + sep)
	) {
		return notFoundResponse(requestId); // symlink escape
	}
	const isDirectory = await stat(fullPath)
		.then((entry) => entry.isDirectory())
		.catch(() => false);
	// A directory URL must carry its trailing slash before we serve its index.html:
	// the client references its assets RELATIVELY (core/page/index.html asks for
	// "js/index.js"), so serving the shell at /dedalo/core/page would resolve every
	// one of them against /dedalo/core/ and boot a blank page. Apache (DirectorySlash)
	// and nginx both redirect here; the engine has to, since in dev nothing is in front
	// of it. Redirect the RAW pathname — decodedPath would double-encode on the way out.
	if (isDirectory && !decodedPath.endsWith('/')) {
		return redirectResponse(`${pathname}/${new URL(request.url).search}`);
	}
	// Directory (trailing slash or bare dir) → its index.html.
	if (decodedPath.endsWith('/') || !fullPath.split(sep).pop()?.includes('.')) {
		fullPath = resolve(fullPath, 'index.html');
	}
	const response = await staticAssetResponse(fullPath, request);
	return response ?? notFoundResponse(requestId);
}

/**
 * Hierarchy EXPORT download: GET /dedalo/install/import/hierarchy/<file>.
 *
 * The companion of the export_hierarchy maintenance widget, which writes its
 * `.copy.gz` dumps into HIERARCHY_IMPORT_DIR and hands the panel a link per
 * file. Nothing serves that directory otherwise — the TS engine publishes no
 * static `install/` tree.
 *
 * Unlike its ontology-snapshot sibling below, this is NOT a public master
 * surface: a hierarchy dump is the complete contents of a thesaurus, so the
 * route is gated on an authenticated session whose Principal is a GLOBAL ADMIN
 * AS OF THIS REQUEST (security/session_gate.ts — the same resolver the maintenance
 * area's dispatch uses, never the session row's login-time stamp) and answers 404
 * (never 403) to everyone else, so an anonymous probe cannot even confirm a file
 * exists.
 *
 * Basenames are allowlisted to exactly the two shapes the exporter produces
 * (`<tipo>.copy.gz` with safeExportTipo's tipo grammar, and the `hierarchy.json`
 * manifest — WC-2026-10-10-hierarchy-json-manifest; the retired `all_…`
 * whole-table dump is no longer produced, so no longer served), and the
 * resolved path is confined under the directory — the vendored SEED files share
 * those names, which is correct: they are the same kind of artifact, offered by
 * the same panel.
 */
async function serveHierarchyExportFile(pathname: string, request: Request, requestId: string) {
	const notFound = () => notFoundResponse(requestId);
	// The Principal, resolved for THIS request — never the login-time session stamp
	// (SEC-14: a demoted admin kept this download for the session TTL).
	const session = await globalAdminSessionFromCookie(request.headers.get('cookie'));
	if (session === null) return notFound();
	const fileName = pathname.slice(HIERARCHY_EXPORT_URL_PREFIX.length);
	const isManifest = fileName === HIERARCHY_MANIFEST_FILE;
	if (!isManifest && !/^[a-z]{2,}[0-9]+\.copy\.gz$/.test(fileName)) return notFound();
	const fullPath = resolve(HIERARCHY_IMPORT_DIR, fileName);
	if (!fullPath.startsWith(HIERARCHY_IMPORT_DIR + sep)) return notFound();
	const file = Bun.file(fullPath);
	if (!(await file.exists())) return notFound();
	return new Response(file, {
		headers: {
			'Content-Type': isManifest ? 'application/json; charset=utf-8' : 'application/gzip',
			'Content-Disposition': `attachment; filename="${fileName}"`,
			'Cache-Control': 'no-store',
			...SECURITY_HEADERS,
		},
	});
}

/**
 * Ontology-master snapshot serving (UPDATE_PROCESS Phase 2): GET
 * /dedalo/install/import/ontology/<major.minor>/<file> — the PHP deployment
 * serves the IO dir as plain static files under DEDALO_INSTALL_URL; remote
 * installations (and this instance's own 'Local files' flow) download the
 * manifest's `.copy.gz` snapshots from here. Fail-closed: only when
 * IS_AN_ONTOLOGY_SERVER is set; only a version-shaped dir segment and an
 * allowlisted basename; resolved path confined under the IO dir.
 */
async function serveOntologyIoFile(pathname: string, requestId: string): Promise<Response> {
	const notFound = () => notFoundResponse(requestId);
	if (config.ontologyIo.isOntologyServer !== true) return notFound();
	const match = pathname.match(
		/^\/dedalo\/install\/import\/ontology\/(\d+\.\d+)\/([A-Za-z0-9_.-]+)$/,
	);
	if (match === null) return notFound();
	const [, version, fileName] = match as unknown as [string, string, string];
	if (
		!/^[a-z_]{2,}\.copy\.gz$/.test(fileName) &&
		fileName !== 'ontology.json' &&
		fileName !== 'ontology_llm_map.json'
	) {
		return notFound();
	}
	const baseDir = resolve(config.ops.ontologyDataIoDir, version);
	const fullPath = resolve(baseDir, fileName);
	if (!fullPath.startsWith(baseDir + sep)) return notFound();
	const file = Bun.file(fullPath);
	if (!(await file.exists())) return notFound();
	return new Response(file, {
		headers: {
			'Content-Type': fileName.endsWith('.json') ? 'application/json' : 'application/gzip',
			'Cache-Control': 'no-store',
			...SECURITY_HEADERS,
		},
	});
}

/** The API endpoint paths: the direct one and the copied client's relative path. */
const API_PATHS: ReadonlySet<string> = new Set([
	'/api/v1/json',
	'/dedalo/core/api/v1/json',
	'/dedalo/core/api/v1/json/',
]);

/**
 * The raw record data view — a dedicated, hard-locked GET endpoint (admin tool).
 * Distinct from API_PATHS: it does NOT accept an arbitrary RQO. The direct path
 * plus the client-relative twin (matching the API_PATHS pattern). See
 * core/api/raw_view.ts for the gates.
 */
const RAW_VIEW_PATHS: ReadonlySet<string> = new Set(['/api/v1/raw', '/dedalo/core/api/v1/raw']);

/**
 * The environment diagnostic view — a dedicated, session-gated GET endpoint
 * (developer tool). Replaces the PHP menu link to core/common/js/environment.js.php
 * (which the TS server can't run). Returns the get_environment payload as
 * pretty JSON. See core/api/environment_view.ts.
 */
const ENVIRONMENT_VIEW_PATHS: ReadonlySet<string> = new Set([
	'/api/v1/environment',
	'/dedalo/core/api/v1/environment',
]);

/**
 * DB reachability for /health (audit S3-48): a liveness-only probe reported
 * green during a total DB outage. Cached for 5 s so a tight watchdog cadence
 * never turns the health check itself into DB load; bounded by a 2 s race so
 * a wedged pool answers 503 instead of hanging the probe.
 */
// checkedAt starts at -Infinity: performance.now() is near ZERO at boot, so a
// 0 sentinel would satisfy the cache window and serve the initial ok:false
// without ever probing the database.
const dbHealth = { ok: false, checkedAt: Number.NEGATIVE_INFINITY };
const DB_HEALTH_CACHE_MS = 5000;
const DB_HEALTH_TIMEOUT_MS = 2000;
async function checkDbHealth(): Promise<boolean> {
	const now = performance.now();
	if (now - dbHealth.checkedAt < DB_HEALTH_CACHE_MS) return dbHealth.ok;
	dbHealth.checkedAt = now;
	try {
		const { sql } = await import('./core/db/postgres.ts');
		await Promise.race([
			sql.unsafe('SELECT 1', []),
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error('db health probe timed out')), DB_HEALTH_TIMEOUT_MS),
			),
		]);
		dbHealth.ok = true;
	} catch (error) {
		dbHealth.ok = false;
		console.error('[health] database check failed:', (error as Error).message);
	}
	return dbHealth.ok;
}

/**
 * THE TEST-DATABASE FINGERPRINT ON `/health` — how `bun run test:client` proves
 * the SERVER IT DRIVES is on the suite database and not on the application's.
 *
 * The client suite is the one tier that writes through a live server instead of
 * through the suite's own connection, so the marker guard every other writer
 * calls (src/core/test_data/test_database_marker.ts) could not see it. The
 * runner now owns its server and asks it, over the wire, to identify its
 * database; a mismatch is a hard refusal before a browser is even launched.
 *
 * TWO THINGS KEEP THIS FROM BEING A LEAK:
 *  - DEV MODE ONLY. On the production posture (DEDALO_DEV_MODE unset/false) the
 *    key is absent from the payload and no query is made — `/health` is
 *    anonymous, and production must not answer questions about its database.
 *  - IT IS A HASH, NEVER THE NAME. Only a caller that can already read the same
 *    marker row can recompute and compare it (see testDatabaseFingerprint).
 * `null` means "this server is NOT on a marked test database" — which is
 * exactly what the runner refuses on.
 */
const DEV_MODE_HEALTH_DB_IDENTITY = readEnv('DEDALO_DEV_MODE') === 'true';
async function healthTestDatabaseFingerprint(): Promise<string | null> {
	if (!DEV_MODE_HEALTH_DB_IDENTITY) return null;
	try {
		const { testDatabaseFingerprint } = await import('./core/test_data/test_database_marker.ts');
		return await testDatabaseFingerprint();
	} catch (error) {
		// A refusing marker (one naming another database) must not take /health
		// down: it is a liveness probe. The runner sees a missing fingerprint and
		// refuses, which is the outcome that matters.
		console.error('[health] test-database fingerprint failed:', (error as Error).message);
		return null;
	}
}

/** The admin counters endpoint paths (S2-37; gates live in core/api/counters.ts). */
const COUNTERS_PATHS: ReadonlySet<string> = new Set([
	'/api/v1/counters',
	'/dedalo/core/api/v1/counters',
]);

/**
 * MEDIA-03 (refined — SECURITY_DECISIONS.md DECISION 2): the safety headers for
 * one media file, keyed on WHICH of the two SVG populations under the media root
 * it belongs to. SVG is active content, but the two need opposite treatment:
 *
 *  - Server-generated image ENVELOPES (image/&#42;&#42;/svg/&#42;.svg — written only by
 *    svg_overlay's fixed template; 'svg' is not an image quality and
 *    component_image rejects .svg uploads, so no uploader bytes reach this
 *    path). The client renders them INLINE via <object type="image/svg+xml">
 *    and needs same-origin contentDocument access (quality switch, vector
 *    editor) plus the same-origin raster <image> fetch — attachment/sandbox
 *    breaks all of that (blank image). Script is blocked by CSP instead.
 *  - Every other SVG (raw svg/ uploads) stays download-only + sandboxed:
 *    the client only uses them as <img src>, which ignores the disposition.
 *
 * Split out of the route body and exported so the SELECTION is gated without a
 * media corpus: the route-level MEDIA-03 cases need a real .svg on disk and skip
 * silently on a fresh install or the hermetic CI tier — and since XSS-02's
 * `object-src` admits the envelope folder (core/api/static_asset.ts), a rotted
 * selection here is no longer backstopped by the app CSP.
 *
 * SCOPE (2026-08-24): this is the Bun dev/fallback media route, and it is no
 * longer the only enforcer. The generated Apache/nginx rules
 * (core/media/protection.ts) now emit the SAME two header sets in the documented
 * production topology, from the SAME definition — core/media/svg_safety.ts owns
 * the selection rule, the CSPs and the disposition, and
 * media_protection_tripwire pins that the generated rule text classifies a table
 * of real paths exactly as this function does. Until that landed, the sentence
 * here read "these guarantees do not hold there", and DECISION 2's closing
 * requirement ("the production template must mirror the two path-scoped rules")
 * was unpaid for six weeks.
 *
 * HONEST LIMIT: the tripwire proves the PATTERNS agree, not that Apache and
 * nginx execute them as intended — that is the curl matrix in
 * engineering/MEDIA_PROTECTION.md §9.
 *
 * @param relSegments media-root-relative path segments, e.g. ['image','svg','0','x.svg']
 * @param contentType the file's resolved MIME type
 */
export function mediaSvgSafetyHeaders(
	relSegments: readonly string[],
	contentType: string,
): Record<string, string> {
	const isSvg = contentType.includes('svg');
	if (!isSvg) return {};
	return isImageEnvelopeSvg(relSegments)
		? { 'Content-Security-Policy': SVG_ENVELOPE_CSP }
		: {
				'Content-Disposition': SVG_QUARANTINE_DISPOSITION,
				'Content-Security-Policy': SVG_QUARANTINE_CSP,
			};
}

/**
 * Say ONCE, at boot, when media protection is in force because nobody chose it.
 *
 * The fail-closed default (2026-08-24) changes what anonymous visitors can read on every
 * install that never configured a mode, and on nginx it does so ONLY AFTER A RELOAD —
 * Apache reads .htaccess per request, nginx reads its include at reload. An operator whose
 * public site quietly starts 404ing images, or whose install keeps serving everything
 * because nobody reloaded, must be able to find out why from the log rather than by
 * bisecting a release. Silent security changes are how operators learn to distrust them.
 *
 * Advisory only: it never throws and never changes what is served.
 */
function announceUnconfiguredMediaProtection(): void {
	const { mode, source } = resolveMediaAccessModeDetail();
	if (source !== 'default' || mode === false) return;
	console.warn(
		`[media_protection] no media access mode is configured, so the FAIL-CLOSED DEFAULT '${mode}' applies: ` +
			'logged-in users see everything; anonymous visitors see only media of PUBLISHED records in the ' +
			'public quality folders. Apache picks this up immediately; NGINX NEEDS A RELOAD ' +
			'(include both generated files, then `nginx -t && nginx -s reload`). Set ' +
			'DEDALO_MEDIA_ACCESS_MODE explicitly — including to `false` — to make the choice yours.',
	);
}

/**
 * The media-auth cookie value this live session SHOULD be carrying, or null.
 *
 * Normally just the key already on the session row. The re-key branch exists for two
 * real populations, both of which would otherwise hold a session with no media access
 * at all and no way to get one short of logging out and back in:
 *
 *  - sessions that predate the `media_key` column (every session live across the
 *    upgrade that introduced the per-session credential);
 *  - sessions created while protection was off, on an install where an operator has
 *    since switched it on from the maintenance widget.
 *
 * READ-MOSTLY, and the write it does is one zero-byte marker plus one UPDATE, once per
 * session ever. It deliberately does NOT regenerate the rule files: that is a login/boot
 * job, and doing it on the authenticated hot path would rewrite the whole gate under
 * load.
 */
function sessionMediaKeyFor(
	session: { mediaKey?: string | null } | null,
	cookieHeader: string,
): string | null {
	if (session === null) return null;
	if (typeof session.mediaKey === 'string' && session.mediaKey !== '') return session.mediaKey;
	if (resolveMediaAccessMode() === false) return null;
	const rawToken = readCookie(cookieHeader, SESSION_COOKIE);
	if (rawToken === undefined) return null;
	const minted = mintAuthCookieValue();
	layAuthMarker(minted);
	setSessionMediaKey(rawToken, minted);
	return minted;
}

/**
 * Route a request. Kept as a plain function (not inline in Bun.serve) so tests
 * can call it directly without a socket.
 */
export async function handleRequest(request: Request, context: RequestContext): Promise<Response> {
	const url = new URL(request.url);

	// Health probe for the reverse proxy / process manager: liveness AND a
	// cached DB reachability check (S3-48) — monitoring must go red when the
	// database is down or the pool is wedged, not just when the process dies.
	if (url.pathname === '/health') {
		// Poison latch first (core/api/process_health.ts): a TDZ-poisoned module
		// graph serves identical failures for the whole process life while the DB
		// stays reachable — health MUST go red so the watchdog recycles us.
		const poison = getProcessPoison();
		if (poison.poisoned) {
			return jsonResponse(
				{
					result: 'error',
					entity: config.entity,
					db: 'unchecked',
					process: 'poisoned',
					reason: poison.reason,
					request_id: context.requestId,
				},
				503,
			);
		}
		const dbOk = await checkDbHealth();
		return jsonResponse(
			buildHealthPayload({
				dbOk,
				entity: config.entity,
				// The running engine version (update_code post-restart poll) AND, since
				// 2026-08-24, the installed archive digest — the only token that moves
				// across a same-version dev-channel swap. NOT the database name — see
				// test_db_marker_tripwire's /health rule.
				version: DEDALO_ENGINE_VERSION,
				installDigest: INSTALLED_DIGEST,
				requestId: context.requestId,
				// Dev mode only, and an opaque hash even then (see above).
				...(DEV_MODE_HEALTH_DB_IDENTITY && dbOk
					? { testDatabase: await healthTestDatabaseFingerprint() }
					: {}),
			}),
			dbOk ? 200 : 503,
		);
	}

	// Operational counters (S2-37) — session-gated, global-admin-only.
	if (request.method === 'GET' && COUNTERS_PATHS.has(url.pathname)) {
		return handleCountersRequest(request);
	}

	// Media files — the ENGINE FALLBACK for a dev listener with no web server in
	// front (see mediaFallbackAllowed). Still session-gated; when not allowed the
	// request falls through and 404s. Production serves media from the web server
	// via the generated rules, never from here.
	// Prefix FIRST: mediaFallbackAllowed() reads the protection mode, which re-reads
	// ts_state.json from disk per call (so a widget mode change takes effect with no
	// restart). Evaluating it before the cheap path test would put a file read on EVERY
	// GET in the server.
	if (
		request.method === 'GET' &&
		url.pathname.startsWith(MEDIA_URL_PREFIX) &&
		mediaFallbackAllowed(context)
	) {
		if (MEDIA_ROOT === null) {
			return notFoundResponse(context.requestId);
		}
		const cookieHeader = request.headers.get('cookie') ?? '';
		const mediaSessionToken = cookieHeader
			.split(';')
			.map((pair) => pair.trim())
			.find((pair) => pair.startsWith(`${SESSION_COOKIE}=`))
			?.slice(SESSION_COOKIE.length + 1);
		if (mediaSessionToken === undefined || getSession(mediaSessionToken) === null) {
			return notFoundResponse(context.requestId); // fail-closed, no existence leak
		}
		let mediaPath: string;
		try {
			// Strip the '/dedalo/<mediaDir>/' prefix, then decode the file path.
			mediaPath = decodeURIComponent(url.pathname.slice(MEDIA_URL_PREFIX.length));
		} catch {
			return notFoundResponse(context.requestId);
		}
		const fullMediaPath = resolve(MEDIA_ROOT, mediaPath);
		if (!fullMediaPath.startsWith(MEDIA_ROOT + sep)) {
			return notFoundResponse(context.requestId); // traversal
		}
		// MEDIA-04 / CARRY-11: AN ALLOWLIST, NOT A DENYLIST.
		//
		// This was a denylist of two subtrees — `upload/` and `.publication` — and
		// a denylist only excludes what someone thought of. It did not exclude the
		// import STAGING tree, so the dev listener served another user's
		// un-ingested source CSVs: a curator's raw data, readable across accounts.
		// The class is only closed by inverting it: everything that is not a
		// MEDIA TYPE FOLDER is refused, which makes a new sibling directory
		// (staging, exports, a cache) unreachable by default instead of reachable
		// until someone remembers to name it.
		//
		// The folder labels come from config (DEDALO_*_FOLDER), never hardcoded —
		// an install may rename them, and a hardcoded list would silently deny
		// everything there.
		const relSegments = fullMediaPath.slice((MEDIA_ROOT + sep).length).split(sep);
		if (!MEDIA_TYPE_FOLDERS().has(relSegments[0] ?? '')) {
			return notFoundResponse(context.requestId);
		}
		// ...and the marker store never, wherever it sits (its filenames ARE valid
		// media-auth cookie values).
		if (relSegments.includes('.publication')) {
			return notFoundResponse(context.requestId);
		}
		const mediaFile = Bun.file(fullMediaPath);
		if (!(await mediaFile.exists())) {
			return notFoundResponse(context.requestId);
		}
		// HTTP Range support (RFC 7233). <video>/<audio> elements stream via Range
		// requests and browsers like Safari/iOS REFUSE to play a media response that
		// answers a Range request with a full-body 200 — they require 206 Partial
		// Content. Serving the whole file (as before) "works" in lenient Chrome on
		// localhost but breaks playback (and all seeking) elsewhere. Advertise
		// Accept-Ranges on every response and honour a bytes= range with a 206.
		const contentType = mediaFile.type || 'application/octet-stream';
		const totalSize = mediaFile.size;
		const svgSafetyHeaders = mediaSvgSafetyHeaders(relSegments, contentType);
		const rangeHeader = request.headers.get('range');
		if (rangeHeader) {
			// Only the single "bytes=start-end" form is used by media elements.
			const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
			if (match && (match[1] !== '' || match[2] !== '')) {
				const hasStart = match[1] !== '';
				let start = hasStart ? Number(match[1]) : 0;
				let end = match[2] !== '' ? Number(match[2]) : totalSize - 1;
				// Suffix form "bytes=-N" → the last N bytes.
				if (!hasStart) {
					start = Math.max(0, totalSize - Number(match[2]));
					end = totalSize - 1;
				}
				end = Math.min(end, totalSize - 1);
				if (start > end || start >= totalSize) {
					return new Response(null, {
						status: 416, // Range Not Satisfiable
						headers: { 'Content-Range': `bytes */${totalSize}`, 'Accept-Ranges': 'bytes' },
					});
				}
				return new Response(mediaFile.slice(start, end + 1), {
					status: 206,
					headers: {
						'Content-Type': contentType,
						'Content-Range': `bytes ${start}-${end}/${totalSize}`,
						'Content-Length': String(end - start + 1),
						'Accept-Ranges': 'bytes',
						...SECURITY_HEADERS,
						...svgSafetyHeaders,
					},
				});
			}
		}
		return new Response(mediaFile, {
			headers: {
				'Content-Type': contentType,
				'Content-Length': String(totalSize),
				'Accept-Ranges': 'bytes',
				...SECURITY_HEADERS,
				...svgSafetyHeaders,
			},
		});
	}

	// Tool package assets (served from the repo `tools/` roots, NOT the copied
	// client tree). Must run BEFORE the generic client handler, which no longer
	// holds a tools/ subtree.
	if (request.method === 'GET' && url.pathname.startsWith('/dedalo/tools/')) {
		const toolsResponse = await serveToolsRequest(url.pathname, request);
		if (toolsResponse !== null) return toolsResponse;
	}

	// Raw record data view (admin tool). MUST run before the generic /dedalo/
	// static handler below, since its client-relative path lives under /dedalo/.
	if (request.method === 'GET' && RAW_VIEW_PATHS.has(url.pathname)) {
		return handleRawView(request, url);
	}

	// Environment diagnostic view (developer tool). Same ordering reason as above.
	if (request.method === 'GET' && ENVIRONMENT_VIEW_PATHS.has(url.pathname)) {
		return handleEnvironmentView(request);
	}

	// component_text_area inline-tag image factory (PHP core/component_text_area/tag/).
	// The copied client emits one <img src=".../tag/?id=[TAG]"> per inline tag; this
	// route renders each as an SVG badge (deterministic, immutable-cached) or 302s a
	// locator tag to its media file. MUST run before the generic /dedalo/ static
	// handler (the copied client tree has no tag/ directory).
	if (request.method === 'GET' && url.pathname.endsWith('/core/component_text_area/tag/')) {
		return handleTagRequest(request, url);
	}

	// Hierarchy export downloads (admin-session-gated). Same ordering reason as
	// the ontology route: no client subtree serves this path.
	if (request.method === 'GET' && url.pathname.startsWith(HIERARCHY_EXPORT_URL_PREFIX)) {
		return serveHierarchyExportFile(url.pathname, request, context.requestId);
	}

	// Ontology-master snapshot files (fail-closed on IS_AN_ONTOLOGY_SERVER).
	// MUST run before the generic /dedalo/ static handler (no client subtree).
	if (request.method === 'GET' && url.pathname.startsWith('/dedalo/install/import/ontology/')) {
		return serveOntologyIoFile(url.pathname, context.requestId);
	}

	// Code-master release archives (fail-closed on IS_A_CODE_SERVER). Same
	// ordering reason as the ontology route: no client subtree serves this path.
	if (request.method === 'GET' && url.pathname.startsWith(CODE_RELEASE_URL_PREFIX)) {
		return serveCodeReleaseRequest(
			url.pathname,
			{
				isCodeServer: config.update.isCodeServer,
				codeFilesDir: config.update.codeFilesDir,
			},
			context.requestId,
		);
	}

	// Third-party client libraries, resolved through the CLIENT_LIBS allowlist to
	// node_modules/ or vendor/. MUST run before the generic client handler — there
	// is no client/dedalo/lib/ directory any more, so this is the only way a lib
	// resolves. See src/core/client_libs/registry.ts.
	if (request.method === 'GET' && url.pathname.startsWith(CLIENT_LIB_URL_PREFIX)) {
		const libResponse = await serveClientLibRequest(url.pathname, request);
		if (libResponse !== null) return libResponse;
	}

	// Local AI model weights (in-browser speech recognition / translation), served
	// read-only from the install's own model store instead of a public model hub —
	// the whole point of running inference locally. Same ordering reason as the
	// lib route: the client tree has no ai_models/ subtree.
	//
	// SESSION-GATED, FAIL-CLOSED (P1-25 / MODEL-02). This route reached the model
	// store with NO session read at all — the media route beside it reads one —
	// while stamping `immutable, max-age=31536000` on GB-scale artifacts. The prior
	// remediation asked for exactly this gate and only the realpath half was done.
	// Weights are for THIS install's cataloguers doing in-browser inference; the
	// only consumer is a same-origin worker inside the logged-in app, so an
	// anonymous request is never legitimate. The refusal itself lives in
	// serveModelRequest — the door refuses, not this one caller — and it is a 404,
	// so nothing leaks about what the store holds.
	if (request.method === 'GET' && url.pathname.startsWith(AI_MODEL_URL_PREFIX)) {
		const modelToken = readCookie(request.headers.get('cookie') ?? '', SESSION_COOKIE);
		const modelSession = modelToken !== undefined ? getSession(modelToken) : null;
		const modelResponse = await serveModelRequest(url.pathname, request, modelSession !== null);
		if (modelResponse !== null) return modelResponse;
	}

	// Entry points → the app (PHP's index.php / core/index.php redirect shims).
	// Must precede the static branch: '/dedalo/core/' would otherwise look for an
	// index.html that the client tree does not have, and 404 on the user.
	if (request.method === 'GET' && ENTRY_REDIRECT_PATHS.has(url.pathname)) {
		return redirectResponse(APP_ENTRY_PATH);
	}

	// Staged uploads — a user's OWN in-flight files (upload-queue previews +
	// list_uploaded_files thumbnails). Must precede the static branch, which would
	// otherwise look for a client asset at this path and 404.
	//
	// This is deliberately NOT the general media route: that one authenticates a
	// session but not an owner, which is exactly why MEDIA-04 makes it refuse
	// everything under `upload/`. Here the user id comes from the SESSION and the
	// URL only ever supplies <key_dir>[/thumbnail]/<name>, so one user can never
	// address another's staging dir. Fail-closed: no session → 404, no leak.
	if (request.method === 'GET' && url.pathname.startsWith(STAGED_URL_PREFIX)) {
		const stagedCookie = request.headers.get('cookie') ?? '';
		const stagedToken = stagedCookie
			.split(';')
			.map((pair) => pair.trim())
			.find((pair) => pair.startsWith(`${SESSION_COOKIE}=`))
			?.slice(SESSION_COOKIE.length + 1);
		const stagedSession = stagedToken !== undefined ? getSession(stagedToken) : null;
		if (stagedSession === null) {
			return notFoundResponse(context.requestId);
		}
		let stagedRel: string;
		try {
			stagedRel = decodeURIComponent(url.pathname.slice(STAGED_URL_PREFIX.length));
		} catch {
			return notFoundResponse(context.requestId);
		}
		const stagedPath = resolveStagedPath(stagedSession.userId, stagedRel);
		if (stagedPath === null) {
			return notFoundResponse(context.requestId);
		}
		const stagedFile = Bun.file(stagedPath);
		if (!(await stagedFile.exists())) {
			return notFoundResponse(context.requestId);
		}
		return new Response(stagedFile, {
			headers: {
				'Content-Type': stagedFile.type || 'application/octet-stream',
				// Staging is per-user and short-lived: never let a shared cache hold it.
				'Cache-Control': 'private, no-store',
				// The bytes are unverified user uploads; forbid content sniffing and
				// any active content (an uploaded .svg/.html must not execute here).
				'X-Content-Type-Options': 'nosniff',
				'Content-Security-Policy': "default-src 'none'; sandbox",
				'Content-Disposition': 'inline',
			},
		});
	}

	// Copied-client static assets (Phase 7 seam).
	// TOOL-SERVED ROUTES (ToolServerModule.httpRoutes — e.g. tool_export's
	// built-file downloads). AFTER every engine route, so none can be shadowed;
	// before the client static tree (a tool may not claim a client directory —
	// the loader refuses reserved segments). The engine never names a tool here.
	if (request.method === 'GET' && url.pathname.startsWith('/dedalo/') && !config.installMode) {
		const toolRoute = await toolHttpRouteFor(url.pathname);
		if (toolRoute !== undefined) {
			return (await toolRoute.handle(request, url.pathname)) ?? notFoundResponse(context.requestId);
		}
	}

	if (request.method === 'GET' && url.pathname.startsWith('/dedalo/')) {
		return serveClientAsset(url.pathname, request, context.requestId);
	}

	// CORS preflight for the API path. MUST come before every other API branch:
	// the browser sends OPTIONS (never POST) first, and each branch below tests
	// for POST, so an unhandled preflight would fall through to the 404 and the
	// real request would never be sent. Answers only for an allowlisted origin —
	// null means "not ours", and routing continues as if this block did not exist.
	// See core/security/cors.ts for why the origin list is the only knob.
	if (API_PATHS.has(url.pathname) && request.method === 'OPTIONS') {
		const preflight = corsPreflightResponse(request);
		if (preflight !== null) return preflight;
	}

	// Media upload: the MULTIPART branch of the API path (PHP dd_utils_api::upload).
	// Runs before JSON parsing — the body is form-data, not JSON.
	if (
		API_PATHS.has(url.pathname) &&
		request.method === 'POST' &&
		(request.headers.get('content-type') ?? '').includes('multipart/form-data')
	) {
		const uploadCookie = request.headers.get('cookie') ?? '';
		const uploadToken = uploadCookie
			.split(';')
			.map((pair) => pair.trim())
			.find((pair) => pair.startsWith(`${SESSION_COOKIE}=`))
			?.slice(SESSION_COOKIE.length + 1);
		const uploadSession = uploadToken !== undefined ? getSession(uploadToken) : null;
		// Header-only (L9): the vendored client always sends the token in the
		// X-Dedalo-Csrf-Token header (with a FORM-FIELD fallback in the POST body).
		// The old url.searchParams('csrf_token') fallback was never used by the
		// client and would leak the token into access logs / the Referer header.
		const csrfCandidate = request.headers.get('x-dedalo-csrf-token');
		// NOTE: this branch bypasses dispatchRqo, so the request-scoped IDENTITY and
		// LANGUAGE ALS contexts are NOT open here. That is safe today because the
		// upload path threads the session explicitly and reads no request-scoped
		// accessor (currentPrincipal/currentSession/current*Lang). Any future
		// upload-path code that reaches for those must instead thread identity/lang
		// explicitly, or wrap this call in runWithRequestContext/runWithRequestLangs.
		const { handleMediaUpload } = await import('./core/media/ingest/upload_endpoint.ts');
		return handleMediaUpload(request, uploadSession, csrfCandidate);
	}

	// The API endpoint: parse → validate → dispatch (auth/CSRF/allowlists in dispatch.ts).
	if (API_PATHS.has(url.pathname) && request.method === 'POST') {
		let rawBody: unknown;
		try {
			rawBody = await request.json();
		} catch {
			return jsonFailureResponse(new DedaloError('request.malformed_body'), context.requestId);
		}
		const parsedRqo = rqoSchema.safeParse(rawBody);
		if (!parsedRqo.success) {
			// The zod issues are summarized to their PATHS (a bounded scalar) —
			// never the raw issue objects, which echo caller input.
			return jsonFailureResponse(
				new DedaloError('request.invalid_rqo', {
					details: { issue_paths: summarizeIssuePaths(parsedRqo.error.issues) },
				}),
				context.requestId,
			);
		}

		// Resolve the session from the TS-native cookie.
		const cookieHeader = request.headers.get('cookie') ?? '';
		const sessionToken = readCookie(cookieHeader, SESSION_COOKIE);
		const apiContext: ApiRequestContext = {
			requestId: context.requestId,
			// Behind the reverse proxy the socket has no peer IP; the client IP comes
			// from the TRUSTED X-Forwarded-For hop (never the spoofable left-most).
			clientIp: clientIpFromRequest(request, context),
			session: sessionToken !== undefined ? getSession(sessionToken) : null,
			sessionToken: sessionToken ?? null,
			// Anonymous language preference (login panel). Allowlisted in dispatch.
			preauthLang: readCookie(cookieHeader, PREAUTH_LANG_COOKIE) ?? null,
			// Header first; the body token is the fallback for sendBeacon, which
			// cannot set headers (beforeunload lock release, page.js).
			// WC-2026-08-19-rqo-body-csrf-token.
			csrfCandidate:
				request.headers.get('x-dedalo-csrf-token') ?? parsedRqo.data.csrf_token ?? null,
			// The same precedence, recorded — see ApiRequestContext.csrfSource.
			csrfSource:
				request.headers.get('x-dedalo-csrf-token') !== null
					? 'header'
					: parsedRqo.data.csrf_token !== undefined && parsedRqo.data.csrf_token !== null
						? 'body'
						: null,
			reportTokenCandidate: request.headers.get('x-dedalo-report-token'),
			bodyByteLength: parseContentLength(request.headers.get('content-length')),
			startedAt: context.startedAt,
		};

		const outcome = await dispatchRqo(parsedRqo.data, apiContext);
		// A Headers OBJECT, not a Record<string,string>: a login must ship the session
		// cookie AND the media-auth cookie, and an object key can hold exactly ONE
		// Set-Cookie value — the second assignment would silently drop the first (either
		// breaking login outright, or locking every editor out of media). Do NOT "fix"
		// that by comma-joining: Set-Cookie is the one header that must never be folded
		// (RFC 6265 §3), and the browser would mangle both.
		const headers = new Headers({
			'Content-Type': 'application/json',
			...SECURITY_HEADERS,
			// A successful preflight only buys the right to SEND the request; the
			// browser still discards the RESPONSE unless it too carries
			// Access-Control-Allow-Origin. Both halves or neither.
			...corsResponseHeaders(request),
		});
		// Authenticated API payloads may carry record data — never let a shared
		// cache store them (L6).
		if (apiContext.session !== null) {
			headers.set('Cache-Control', 'no-store');
		}
		if (outcome.setSessionToken !== undefined) {
			// HttpOnly + SameSite=Lax + (default) Secure — see sessionCookieHeader.
			headers.append('Set-Cookie', sessionCookieHeader(outcome.setSessionToken));
		} else if (outcome.clearSessionCookie === true) {
			// Logout: expire the cookie so the browser drops it (Max-Age=0). Same
			// attributes as issuance so the browser matches and overwrites it.
			headers.append('Set-Cookie', sessionCookieHeader('', { clear: true }));
		}
		if (outcome.setPreauthLangCookie !== undefined) {
			headers.append('Set-Cookie', preauthLangCookieHeader(outcome.setPreauthLangCookie));
		}
		if (outcome.setMediaAuthCookie !== undefined) {
			headers.append('Set-Cookie', mediaAuthCookieHeader(outcome.setMediaAuthCookie));
		} else if (outcome.clearMediaAuthCookie === true) {
			headers.append('Set-Cookie', mediaAuthCookieHeader('', { clear: true }));
		} else if (apiContext.session !== null) {
			// WC-051: KEEP THE MEDIA COOKIE ALIVE FOR AS LONG AS THE SESSION IS.
			//
			// It used to be minted at login and never again, with a fixed 24h Max-Age
			// while the session renewed on every request. Any editor logged in longer
			// than a day kept a working session and lost the cookie — and since the web
			// server, not this process, gates media, EVERY image/av/pdf/3d silently
			// 404'd while the app itself looked healthy. The reverse leak was live too:
			// a cookie minted just before logout stayed a valid media credential for up
			// to 48h (today+yesterday markers) with no session behind it.
			//
			// Re-issuing here ties the two together by construction: same idle window,
			// refreshed by the same requests, and dropped by the same logout. Only when
			// the browser's value is actually stale — one string compare against a value
			// already on the session row, no filesystem read — so the steady state costs
			// nothing.
			//
			// (2026-08-24) The expected value is now THIS SESSION's, not the install's
			// value for today, which is what makes logout able to revoke it. Two states
			// need re-keying rather than re-issuing, and both arrive here: a session
			// created before the media_key column existed (the upgrade path), and one
			// created while protection was off and later switched on from the widget.
			// Re-keying lays a marker; it must NEVER call writeRuleFiles() — this is the
			// authenticated hot path, and a rule-file writer here rewrites the whole gate
			// under load.
			const expected = sessionMediaKeyFor(apiContext.session, cookieHeader);
			if (expected !== null && readCookie(cookieHeader, MEDIA_AUTH_COOKIE) !== expected) {
				headers.append('Set-Cookie', mediaAuthCookieHeader(expected));
			}
		}
		// Long-lived streaming responses (diffusion SSE): the handler passed the
		// dispatch gates and returned a ReadableStream — hand it to the client
		// raw with its own headers (text/event-stream + anti-buffering). SSE responses
		// never carry cookies, so this branch keeps its own plain-object headers —
		// do not "unify" it with the Headers above.
		if (outcome.stream !== undefined) {
			return new Response(outcome.stream, {
				status: outcome.status,
				headers: {
					...SECURITY_HEADERS,
					'Cache-Control': 'no-store',
					...outcome.streamHeaders,
				},
			});
		}
		if (outcome.retryAfterMs !== undefined) {
			headers.set('Retry-After', String(Math.ceil(outcome.retryAfterMs / 1000)));
		}
		return jsonApiResponse(outcome.body, outcome.status, headers, request);
	}

	return notFoundResponse(context.requestId);
}

/** `issue_paths` for request.invalid_rqo: comma-joined zod paths, capped at 200 chars. */
function summarizeIssuePaths(issues: readonly { path: readonly PropertyKey[] }[]): string {
	const joined = issues.map((issue) => issue.path.map(String).join('.') || '(root)').join(',');
	return joined.length > 200 ? `${joined.slice(0, 197)}...` : joined;
}

/**
 * Process-level unhandledRejection guard. Bun exits with code 1 on the FIRST
 * floating promise rejection — even with a live Bun.serve — so one detached
 * DB error (SSE poll, scheduler pid write, heartbeat) would kill the whole
 * multi-user server. The guard logs LOUDLY and keeps the process alive; it
 * must never be silent, or crashes become invisible partial failures. Every
 * KNOWN detached path still carries its own .catch — this is the last line,
 * not the error-handling strategy. Exported for the survival gate
 * (test/unit/diffusion_sse_resilience.test.ts).
 */
export function installUnhandledRejectionGuard(): void {
	process.on('unhandledRejection', (reason) => {
		console.error(
			'[FATAL-AVERTED] unhandledRejection: a detached promise rejected with no .catch —',
			'the process survives, but the offending call path must gain its own handler:',
			reason,
		);
	});
}

/**
 * Runtime pin echo (audit S2-36): the code is coupled to version-specific Bun
 * behavior (Bun.sql jsonb params, the mariadb adapter, Bun.serve defaults),
 * all verified against the version pinned in .bun-version + package.json
 * engines.bun. A mismatched runtime WARNS loudly at boot (it does not refuse:
 * patch drift may be deliberate) so `bun upgrade` on a production box is never
 * silent again.
 */
function echoRuntimeVersion(): void {
	let pinned = '';
	try {
		pinned = readFileSync(join(projectRoot, '.bun-version'), 'utf-8').trim();
	} catch {
		/* pin file missing — fall through to the generic echo */
	}
	console.log(`Dédalo TS server starting on Bun ${Bun.version} (pinned: ${pinned || 'none'})`);
	if (pinned !== '' && Bun.version !== pinned) {
		console.warn(
			`[runtime] Bun ${Bun.version} does NOT match the verified pin ${pinned} (.bun-version). Bun.sql/Bun.serve behavior is version-coupled (audit S2-36) — verify before relying on this runtime.`,
		);
	}
	// DEDALO_DEBUG_API_ERRORS COLLAPSES THE ENTIRE DISCLOSURE LADDER (P2-8 / SEC-19).
	//
	// With it on, `{exception, stack, coordinates, cause_chain}` is attached to
	// EVERY failure body — the PRE-AUTH ones included, where an unauthenticated
	// caller reads stack frames, absolute paths and Postgres error text. And
	// `toFailureRecord` shares the builder, so those blocks are PERSISTED into job
	// rows and SURVIVE turning the switch back off: the artefacts outlive the
	// setting that produced them.
	//
	// The directly comparable switch one block below (MEDIA_DEV_ROUTE_ENABLED)
	// has had a loud [security] line for a year. This one had no tripwire, no boot
	// warning and no dashboard row — the most powerful disclosure control in the
	// engine, and nothing said it was on.
	if ((readEnv('DEDALO_DEBUG_API_ERRORS') ?? '') === 'true') {
		console.warn(
			'[security] DEDALO_DEBUG_API_ERRORS=true — every API failure now carries its ' +
				'exception, stack, coordinates and cause chain, INCLUDING pre-authentication ' +
				'failures an anonymous caller can trigger. Job failure records share the same ' +
				'builder, so these blocks are PERSISTED and survive turning this back off. ' +
				'Development only; never on a shared or production install.',
		);
	}

	// MEDIA-04: the engine media fallback applies NO per-record ACL — any authenticated
	// session reads any file under the media root by path. Never be quiet about it.
	// (MEDIA-01 is CLOSED: media protection is now native — see core/media/protection.ts
	// and engineering/MEDIA_PROTECTION.md — but it is enforced by the WEB SERVER reading
	// the generated rules, and this route bypasses the web server entirely.)
	//
	// Report the fallback's ACTUAL state, never its configured intent — a warning that
	// shouts about a setting which is in fact inert teaches operators to ignore warnings.
	const mediaFlag = readEnv('MEDIA_DEV_ROUTE_ENABLED');
	const protectionOn = resolveMediaAccessMode() !== false;
	if (protectionOn) {
		// Protection outranks the flag. Say so when someone set it, so a stale `true`
		// carried between .env files is visible rather than silently ignored.
		if (mediaFlag === 'true') {
			console.log(
				'[media] MEDIA_DEV_ROUTE_ENABLED=true is IGNORED: media protection is configured, so ' +
					'the web server enforces the generated rules and the engine never serves media. ' +
					'Remove the key.',
			);
		}
	} else if (mediaFlag === 'true') {
		console.warn(
			'[security] MEDIA_DEV_ROUTE_ENABLED=true — the engine media fallback is FORCED ON for ' +
				'every listener, the production unix socket included. It serves files with NO ' +
				'per-record/per-project access control. NEVER force this on in a shared or production ' +
				'environment (foundation audit MEDIA-04) — unset it and let the dev listener decide.',
		);
	} else if (mediaFlag !== 'false' && (readEnv('SERVER_TCP_PORT') ?? '') !== '') {
		console.log(
			'[media] serving media from the engine on the DEV listener only (session-gated, no ' +
				'per-record ACL) — media protection is not configured and no web server is in the ' +
				'path. The unix socket never serves media. Configure DEDALO_MEDIA_ACCESS_MODE + a ' +
				'web server (engineering/MEDIA_PROTECTION.md) for anything shared.',
		);
	}
}

/**
 * True when a live process is LISTENING on the unix socket (audit S2-17b): a
 * second `startServer` used to silently unlink the FIRST instance's socket and
 * bind fresh, orphaning the old process. connect() answering = live instance.
 */
async function socketIsLive(socketPath: string): Promise<boolean> {
	try {
		await new Promise<void>((resolvePromise, rejectPromise) => {
			Bun.connect({
				unix: socketPath,
				socket: {
					open(socket) {
						socket.end();
						resolvePromise();
					},
					data() {},
					error(_socket, error) {
						rejectPromise(error);
					},
					connectError(_socket, error) {
						rejectPromise(error);
					},
				},
			}).catch(rejectPromise);
		});
		return true;
	} catch {
		return false;
	}
}

/** Idempotency latch for the signal handlers (a repeated SIGTERM must not re-drain). */
let shuttingDown = false;

/**
 * Graceful shutdown (audit S2-17): stop the scheduler cadences, stop accepting
 * connections, drain in-flight requests inside the grace budget, mark undrained
 * media jobs 'interrupted' in their pfiles, journal dying background tool jobs,
 * close the DB pool, unlink the socket, exit 0. Diffusion RUNNERS survive by
 * design (separate processes completing against Postgres — the sweeper heals
 * anything that does not).
 */
async function shutdownGracefully(
	signal: string,
	servers: ReturnType<typeof Bun.serve>[],
	socketPath: string,
	exitCode = 0,
	/** Boot-armed timers to stop (e.g. the export artifacts sweeper). */
	stops: readonly (() => void)[] = [],
): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log(`[shutdown] ${signal} received — draining (grace ${config.ops.shutdownGraceMs}ms)`);
	for (const stop of stops) {
		try {
			stop();
		} catch (error) {
			console.error('[shutdown] stopping a boot timer failed:', error);
		}
	}
	try {
		const { stopDiffusionScheduler } = await import('./diffusion/jobs/scheduler.ts');
		stopDiffusionScheduler();
	} catch (error) {
		console.error('[shutdown] stopping diffusion scheduler failed:', error);
	}
	try {
		const { stopReconcileScheduler } = await import('./core/reconcile/scheduler.ts');
		stopReconcileScheduler();
	} catch (error) {
		console.error('[shutdown] stopping reconcile scheduler failed:', error);
	}
	try {
		const { stopRetentionScheduler } = await import('./core/retention/scheduler.ts');
		stopRetentionScheduler();
	} catch (error) {
		console.error('[shutdown] stopping retention scheduler failed:', error);
	}
	// Stop ACCEPTING; in-flight requests keep running until the drain deadline.
	for (const server of servers) server.stop();
	const deadline = Date.now() + config.ops.shutdownGraceMs;
	while (servers.some((server) => server.pendingRequests > 0) && Date.now() < deadline) {
		await Bun.sleep(50);
	}
	const undrained = servers.reduce((sum, server) => sum + server.pendingRequests, 0);
	if (undrained > 0) {
		console.warn(`[shutdown] ${undrained} request(s) still in flight at deadline — closing hard`);
		for (const server of servers) server.stop(true);
	}
	// Mark undrained media transcodes 'interrupted' in their pfiles so the poll
	// wire never reports a dead job as running (S2-15/S2-17).
	try {
		const { mediaJobs } = await import('./core/media/jobs.ts');
		const interrupted = mediaJobs.interruptLive('server shutdown');
		if (interrupted.length > 0) {
			console.warn(
				`[shutdown] interrupted ${interrupted.length} media job(s): ${interrupted.join(', ')}`,
			);
		}
	} catch (error) {
		console.error('[shutdown] media job interrupt failed:', error);
	}
	// Journal background tool jobs that die with the process (S2-16).
	try {
		const { logDyingBackgroundJobs } = await import('./core/tools/background.ts');
		logDyingBackgroundJobs();
	} catch (error) {
		console.error('[shutdown] background job journal failed:', error);
	}
	// The background online index build (migrate.ts) holds a reserved
	// connection through an unbounded CONCURRENTLY build: cancel it, or the
	// pool close below waits for the whole build. Unrecorded ⇒ next boot retries.
	await stopOnlineMigrations();
	try {
		const { closeDatabasePool } = await import('./core/db/postgres.ts');
		await closeDatabasePool();
	} catch (error) {
		console.error('[shutdown] closing DB pool failed:', error);
	}
	try {
		if (existsSync(socketPath)) unlinkSync(socketPath);
	} catch (error) {
		console.error('[shutdown] socket unlink failed:', error);
	}
	console.log('[shutdown] complete');
	process.exit(exitCode);
}

/** Start the server. Exported for tests; auto-runs when executed directly. */
/**
 * BOOT WARM-UP — first-load TDZ hardening (the poisoned-process class).
 *
 * The read path keeps sanctioned lazy `import()` seams (CONVENTIONS §2), so
 * without this the FIRST concurrent request burst evaluates those subgraphs in
 * parallel; a temporal-dead-zone ReferenceError inside one of the ~30 known
 * import cycles then poisons the failed module for the entire process life
 * (Bun caches failed evaluations — observed 2026-07-07: 1114 identical
 * `dd_core_api::read` failures until restart, undetectable by the DB-only
 * health probe). Evaluating the whole src/core graph SERIALLY here, before any
 * listener exists, removes request-time module evaluation entirely; the poison
 * latch (core/api/process_health.ts → /health 503 → watchdog) is the
 * defense-in-depth layer behind it.
 *
 * Scope is src/core ONLY: src/diffusion and src/ai stay lazy by boundary
 * design — an unconfigured subsystem must cost nothing at boot (CONVENTIONS §2
 * rationale 2). Tool per-action handlers (rationale 3) load on first use as
 * before; the observed failure class lives in the core graph's cycles.
 *
 * Dynamic import rationale (CONVENTIONS §2 rationale 4, BOOT WARM-UP): the
 * specifier set is the core file tree itself, enumerated at runtime; every
 * target is already a legal static member of the core graph, so no boundary
 * or SCC edge is added.
 *
 * A module that fails to evaluate here is a DETERMINISTIC defect that would
 * otherwise surface as the poisoned-process class on its first request — the
 * boot fails loudly instead (the caller exits non-zero; systemd Restart=always
 * makes the crash loop visible where a silently degraded server was not).
 */
async function warmCoreModuleGraph(): Promise<void> {
	const coreDir = resolve(import.meta.dir, 'core');
	const startedAt = performance.now();
	const files: string[] = [];
	for await (const relPath of new Glob('**/*.ts').scan({ cwd: coreDir })) {
		files.push(relPath);
	}
	files.sort();
	const failures: string[] = [];
	for (const relPath of files) {
		try {
			await import(join(coreDir, relPath));
		} catch (error) {
			failures.push(relPath);
			console.error(`[boot] core module warm-up FAILED for core/${relPath}:`, error);
		}
	}
	if (failures.length > 0) {
		throw new Error(
			`core module warm-up: ${failures.length} module(s) failed to evaluate (${failures.join(', ')}) — refusing to serve with a poisoned module graph`,
		);
	}
	console.log(
		`[boot] core module graph warmed: ${files.length} modules in ${Math.round(performance.now() - startedAt)}ms`,
	);
}

export async function startServer() {
	installUnhandledRejectionGuard();
	echoRuntimeVersion();

	// SMOKE BOOT (core/update/smoke_boot.ts): the code updater boots the
	// QUARANTINE tree once, pre-swap, with DEDALO_SMOKE_BOOT=true. Under the
	// flag this process is READ-ONLY BY CONSTRUCTION: boot migrations,
	// search-store provisioning, schedulers, diffusion, media-tree provisioning
	// and every other boot writer below are SKIPPED — it only binds and answers
	// /health (whose DB ping is the one, read-only, touch of the shared DB).
	const smokeBoot = readEnv('DEDALO_SMOKE_BOOT') === 'true';
	if (smokeBoot) {
		console.warn(
			'================ SMOKE BOOT ================\n' +
				'[boot] DEDALO_SMOKE_BOOT=true — pre-swap boot check of a quarantine tree. ' +
				'Skipping boot migrations, schedulers, diffusion, watchers and media provisioning; ' +
				'serving /health only until SIGTERM.\n' +
				'============================================',
		);
	}

	// Serialize the core module-graph evaluation BEFORE anything can race it
	// (see warmCoreModuleGraph). A failure here is fatal by design: exit
	// explicitly — a throw would only feed the unhandledRejection guard above
	// and leave a half-booted zombie process.
	try {
		await warmCoreModuleGraph();
	} catch (error) {
		console.error('[boot] FATAL:', error);
		process.exit(1);
	}

	// INSTALL MODE (DEC-19): a fresh, unconfigured machine (no `.env`). The DB is
	// a sentinel — skip every DB-dependent boot step (migrations, RAG hooks,
	// diffusion control plane) and serve ONLY the install wizard. persist_config
	// writes `.env` and restarts the process, which then boots normally.
	if (config.installMode) {
		console.warn(
			'[boot] INSTALL MODE — no database configured yet (../private/.env absent). ' +
				'Serving the install wizard at /dedalo/core/page/. Complete it (browser wizard ' +
				'or `bun run dedalo:install`); the server restarts into normal operation once configured.',
		);
	}

	// The install surface is PRE-AUTH while unsealed — persist_config rewrites
	// ../private/.env and forces a restart, test_db_connection spawns psql — and its
	// address allowlist is fail-closed by default since 2026-08-24
	// (WC-2026-08-24-install-ip-gate-fail-closed). Print the effective policy so an
	// operator locked out of their own wizard reads WHY off the log instead of guessing
	// at a key; the catalog doc for DEDALO_INSTALL_ALLOWED_IPS promises this line.
	if (config.installMode || installInProgress()) {
		console.warn(`[boot] ${describeInstallAllowPolicy()}`);
	}

	// An UPDATE SERVER must know its own public name. Both manifests hand OTHER machines
	// absolute urls built from `publicOrigin()` (DEDALO_PROTOCOL + DEDALO_HOST), and
	// the consumer then ORIGIN-PINS every download to the url it was configured with
	// (WC-023 D5). With DEDALO_HOST unset that origin falls back to `localhost`, so a
	// remote install is told to fetch the ontology or the release archive FROM ITSELF:
	// it finds its own files or nonsense, and the failure surfaces at the consumer, not
	// here. The fallback itself stays (a same-machine dev master depends on it —
	// src/core/resolve/public_origin.ts), so this is a loud line, not a refusal; without
	// it the misconfiguration is invisible on the only box that could fix it.
	// Gate: utils_update_manifest_native (the predicate, by behaviour, + this wiring).
	if (config.ontologyIo.isOntologyServer || config.update.isCodeServer) {
		if (publicOriginIsLocal()) {
			const roles = [
				config.ontologyIo.isOntologyServer ? 'IS_AN_ONTOLOGY_SERVER' : '',
				config.update.isCodeServer ? 'IS_A_CODE_SERVER' : '',
			]
				.filter((role) => role !== '')
				.join(' + ');
			console.warn(
				`[boot] ${roles} is on but this install has no public name — every manifest it serves will advertise ${publicOrigin()}, which a remote install resolves to ITSELF. Set DEDALO_HOST to this server's public name.`,
			);
		}
	}

	// THE DATABASE IS NOT THE INSTALL'S YET while the wizard is mid-flight. After
	// *Save config* the process restarts OUT of install mode (config.installMode is
	// false) into a database that is still EMPTY — the seed restore is a later
	// wizard step. Every boot step below that writes the database ran against it
	// anyway: migrations and the search-store DDL created the seed's own objects,
	// and the seed restore then failed ("function f_unaccent already exists"),
	// leaving a half-built database — every browser-wizard install, on every
	// platform (measured 2026-10-08). So DB boot work waits for the SEAL, exactly
	// as on the CLI path (scripts/install.ts restores, seals, and only then does a
	// server boot); install_finish restarts the process so the sealed instance
	// boots with all of it (core/install/engine.ts). A boot-time constant: the
	// state can only move forward by a restart.
	// Gate: test/unit/install_mode_boot.test.ts.
	const databaseBoot = !config.installMode && !installInProgress();

	// Ordered TS-owned schema migrations (audit S2-39) — run BEFORE serving so a
	// request never observes a half-migrated schema. A failure logs loudly and
	// continues: the lazy CREATE IF NOT EXISTS bootstraps remain the fallback,
	// and refusing to boot on a transient DB blip would contradict the
	// fault-tolerant boot posture (S1-15). Skipped entirely in install mode and
	// mid-wizard (databaseBoot above) and in a smoke boot (read-only by
	// construction — running migrations pre-swap would mutate the shared DB while
	// the old code is live).
	if (databaseBoot && !smokeBoot) {
		// runBootSchema logs a failed run and continues, then heals the
		// tm_role column outside any transaction (migrate.ts) — never throws.
		await runBootSchema();

		// Derived search-store self-provisioning (2026-07-21): a database from a
		// previous beta (no matrix_string_search / matrix_relation_index, or
		// present-but-empty) heals here — targeted DDL + one-time backfill —
		// BEFORE serving, since relation searches REQUIRE the index
		// (requireRelationIndex; the flat-function engine is removed). Healthy
		// installs pay a few catalog probes. The backfill can take minutes on a
		// large database — a one-time, loudly-logged boot cost. Failures log and
		// the server serves anyway (S1-15): searches then fail with the
		// maintenance remediation, never silently.
		try {
			const { ensureSearchStores } = await import('./core/db/db_assets.ts');
			const ensured = await ensureSearchStores();
			if (!ensured.healthy) {
				const { clearSearchStoreCache } = await import('./core/search/search_store.ts');
				clearSearchStoreCache();
				const backfilledNote = Object.entries(ensured.backfilled)
					.map(([store, rows]) => `${store}: ${rows} rows`)
					.join(', ');
				console.warn(
					`[boot] search stores provisioned (ddl: ${ensured.ddlApplied}${backfilledNote !== '' ? `; backfilled ${backfilledNote}` : ''})${ensured.errors.length > 0 ? ` with ${ensured.errors.length} error(s):` : ''}`,
					...(ensured.errors.length > 0 ? [ensured.errors] : []),
				);
			}
		} catch (error) {
			console.error(
				'[boot] search-store self-provisioning failed (relation searches will refuse with the maintenance remediation):',
				error,
			);
		}

		// THE ENGINE-OWNED ONTOLOGY (ontology/engine_ontology.ts, 2026-10-01): the
		// sections the engine itself writes (the AI spend ledger) are defined in
		// the repository and materialized HERE — a code update reaches an install
		// through a restart, so boot is its update lane. Idempotent: it writes only
		// when dd_ontology differs from engine_ontology.json. A failure logs and the
		// server serves (S1-15); every consumer of an engine section fails CLOSED
		// without it (AI requests refuse `ai.budget_unavailable`).
		try {
			const { ensureEngineOntology } = await import('./core/ontology/engine_ontology.ts');
			const engine = await ensureEngineOntology();
			if (engine.changed) {
				console.warn(
					`[boot] engine ontology materialized (${engine.written} records; drift was: ${engine.drift.join('; ')})`,
				);
			}
			if (engine.pruned.length > 0) {
				console.warn(`[boot] engine ontology: retired nodes pruned: ${engine.pruned.join('; ')}`);
			}
			if (engine.strays.length > 0) {
				console.warn(
					`[boot] engine ontology: records the definitions do not declare (left in place): ${engine.strays.join(', ')}`,
				);
			}
		} catch (error) {
			console.error(
				'[boot] engine ontology materialization FAILED (AI requests will refuse ai.budget_unavailable until it succeeds):',
				error,
			);
		}
	}

	// Timers this boot armed that the shutdown drain stops (handles stay local
	// to this boot, never module state).
	const shutdownStops: (() => void)[] = [];

	// Everything below through the diffusion control plane is DB-dependent —
	// skipped in install mode and mid-wizard (databaseBoot: no seeded database
	// yet) and in a smoke boot (schedulers, watchers, media provisioning: all
	// writers). The block restores on the post-SEAL restart.
	if (databaseBoot && !smokeBoot) {
		// Register the RAG save/delete → index-queue hook (no-op when
		// DEDALO_RAG_ENABLED is off). Must run before serving so writes are captured.
		initRagHooks();

		// EXPIRED-SESSION SWEEPER (SEC-09, 2026-08-28). An expired session's media
		// marker used to be collected only when the dead token was REPLAYED, or when an
		// administrator opened the maintenance widget. A session nobody touches again —
		// a closed laptop, and precisely a STOLEN token whose thief stops using it —
		// kept its marker forever, and the web server never consults the session store,
		// so that cookie went on reading the whole digitised archive. Hourly from five
		// minutes after boot; the sweep also RECONCILES the marker directory, which is
		// what collects the orphans an installation is already carrying.
		//
		// INSIDE this guard because there is nothing to sweep in either mode — not as
		// the safety story. The reconcile unlinks every marker not backed by a live
		// session, and a SMOKE BOOT holds an empty throwaway store with the production
		// MEDIA_PATH inherited; that refusal now lives in `reconcileIsSafeHere`
		// (session_media.ts), which reads the process's own configuration, so a second
		// caller cannot reintroduce the hazard by forgetting this `if`.
		{
			const { startExpiredSessionSweeper } = await import('./core/security/session_media.ts');
			startExpiredSessionSweeper();
		}

		// section_id deprecation counters (WC-2026-08-10-section-id-int-canonical,
		// D10): the pure concepts leaf can't import api/counters, so the observer
		// is wired here — every legacy string→int coercion increments a per-door
		// counter (`section_id_string_coercions.<source>`). The contraction gate
		// reads these off /api/v1/counters (whose payload carries uptime_s, the
		// evidence qualifier) — `url.*` doors are permanent and excluded from it.
		{
			const { registerSectionIdCoercionObserver } = await import('./core/concepts/section_id.ts');
			const { incrementCounter } = await import('./core/api/counters.ts');
			registerSectionIdCoercionObserver((source) =>
				incrementCounter(`section_id_string_coercions.${source}`),
			);
		}

		// Boot data-cache PRE-WARM (boot backlog #5): the lang-independent
		// ontology caches that gate the FIRST interactive paint (the menu area
		// walk and the active-TLD list) fill before the first request instead of
		// on it. Fire-and-forget and NON-FATAL — a DB blip degrades the first hit
		// back to lazy filling, never blocks the boot (S1-15 posture).
		void (async () => {
			try {
				const startedAt = performance.now();
				const { collectAreaRows } = await import('./core/api/handlers/menu.ts');
				const { getActiveTlds } = await import('./core/db/dd_ontology.ts');
				await Promise.all([collectAreaRows(), getActiveTlds()]);
				console.log(
					`[boot] data caches pre-warmed (menu walk, active TLDs) in ${Math.round(performance.now() - startedAt)}ms`,
				);
			} catch (error) {
				console.warn('[boot] data-cache pre-warm skipped (lazy fill on first request):', error);
			}
		})();

		// GeoIP country database (section Activity dd542 IP→country resolution).
		// Fire-and-forget and NON-FATAL: the server-side download of the
		// openly-licensed DB-IP Country Lite database (or its monthly refresh)
		// must never block boot. Until the reader loads, IP addresses render
		// without a country flag — no error, no third-party browser fetch.
		void (async () => {
			const { ensureGeoipDb } = await import('./core/geoip/ensure.ts');
			await ensureGeoipDb();
		})().catch((error) => console.warn('[geoip] boot init skipped:', error));

		// Diffusion control plane (engineering/DIFFUSION_SPEC.md §4.2): ensure the durable
		// job tables, heal interrupted runs from the previous process life
		// (sweeper), then start claiming queued jobs. Fire-and-forget: a DB hiccup
		// here must not block the interactive server from booting.
		// DEDALO_DIFFUSION_SCHEDULER_ENABLED=false skips ONLY the claim/sweep
		// cadences (deployments that run the scheduler elsewhere, and the ops smoke
		// tests — an ephemeral instance must never claim the live queue's jobs);
		// the delete-propagation executor registers either way.
		const schedulerEnabled = readString('DEDALO_DIFFUSION_SCHEDULER_ENABLED') !== 'false';

		// Native in-process SQL delete propagation (DIFFUSION_SPEC §4.2):
		// registration seam — core never imports src/diffusion statically. AWAITED
		// SYNCHRONOUSLY at boot, BEFORE serving and INDEPENDENT of the fire-and-forget
		// schema chain below (audit S2-30: when the registration rode that chain, a
		// transient DB error in ensureDiffusionJobTables silently skipped it and
		// every record delete went pending for the process lifetime). The
		// registration itself is pure in-memory wiring (no DB). If it
		// still fails, log LOUDLY with the operational consequence — never silently.
		try {
			const { executeSqlDeleteTargets } = await import(
				'./diffusion/targets/mariadb/delete_record.ts'
			);
			const { registerNativeDiffusionSqlDelete } = await import(
				'./core/diffusion_bridge/diffusion_delete.ts'
			);
			registerNativeDiffusionSqlDelete(executeSqlDeleteTargets);
		} catch (error) {
			console.error(
				'[diffusion] FATAL-FOR-DELETES: native SQL delete executor NOT registered — ' +
					'record deletes will go to dd1758 pending rows (DEC-19; no fallback since ' +
					'the 2026-07-11 cutover) for this entire process life. Fix and restart. Cause:',
				error,
			);
		}

		// Native media-index (S2-31): register the marker-store ops through the
		// same seam (the ONLY rebuild/status source since the 2026-07-11
		// cutover), then reconcile pub/ from the dbs/ ground truth to heal crash
		// drift (oracle boot posture, old engine index.ts:1183-1190). Reconcile
		// is pure filesystem hygiene — fire-and-forget, never blocks serving.
		try {
			const { rebuildMediaIndexStore, getMediaIndexStatus, reconcileMediaIndex } = await import(
				'./diffusion/targets/mediastore/media_index.ts'
			);
			const { registerNativeMediaIndex } = await import(
				'./core/diffusion_bridge/diffusion_delete.ts'
			);
			registerNativeMediaIndex({
				rebuild: (targets) => rebuildMediaIndexStore(targets),
				getStatus: getMediaIndexStatus,
				reconcile: reconcileMediaIndex,
			});
			// The boot reconcile itself now runs through the RECONCILE REGISTRY
			// (core/reconcile — audit S-10): `media_index` is its one boot-class,
			// auto-apply definition, so the scheduler below fires it.
		} catch (error) {
			console.error(
				'[media_index] DEC-19: native media-index NOT registered — publication markers ' +
					'will not be maintained (no fallback since the 2026-07-11 cutover). ' +
					'Fix and restart. Cause:',
				error,
			);
		}

		// RECONCILE REGISTRY (audit 2026-08-26 S-10): every cross-store reconcile
		// in ONE shape — listed and run by the reconcile_status widget,
		// scripts/reconcile.ts and the `reconcile` gauge on /api/v1/counters.
		// Registration is pure in-memory wiring; the scheduler runs the
		// boot-class reconciles (media_index heals pub/ from dbs/) and any
		// interval-class ones, fire-and-forget and non-fatal. Gated like the
		// diffusion scheduler: an ephemeral/smoke instance must not heal a shared
		// store from the wrong media root.
		try {
			const { registerAllReconciles } = await import('./core/reconcile/catalog.ts');
			await registerAllReconciles();
			if (readString('DEDALO_RECONCILE_SCHEDULER_ENABLED') !== 'false') {
				const { startReconcileScheduler } = await import('./core/reconcile/scheduler.ts');
				startReconcileScheduler();
				// MEDIA COPY WORKER (PUBLICATION_HOST_SPEC §5.2, M3/M4): forwards every
				// pub/ flip to the copy-mode publication hosts, serialized per host —
				// unpublish at once, publish debounced. Same gate as the reconcile
				// scheduler (an ephemeral/smoke instance must not drive a public host);
				// stopped by the shutdown drain.
				const { startMediaCopy } = await import('./diffusion/api/media_copy.ts');
				// PUBLIC-URL PROBE (PUBLICATION_HOST_SPEC §7, phase 6): a worker run that
				// changed a copy host proves its gate through the public URL — detached,
				// coalesced per host. The ONE copy trigger of a worker run (applyCopy
				// itself never schedules). Dynamic like the line above (CONVENTIONS §2
				// rationale 3: a cold path, once per boot).
				const { scheduleProbeAfterCopyBatch } = await import('./core/publication_host/probe.ts');
				shutdownStops.push(
					startMediaCopy({
						afterSync: (host, report) => {
							void scheduleProbeAfterCopyBatch(host, report);
						},
					}),
				);
			} else {
				console.warn(
					'[reconcile] scheduler disabled (DEDALO_RECONCILE_SCHEDULER_ENABLED=false) — boot/interval reconciles will not run, and no pub/ flip reaches a copy-mode publication host',
				);
			}
		} catch (error) {
			console.error(
				'[reconcile] registry boot failed — the maintenance reconcile panel is empty until restart:',
				error,
			);
		}

		// RETENTION (audit 2026-08-26 P2-9): apply the configured retention
		// windows — matrix_activity, the dd1758 publication ledger, the error
		// report store — once shortly after boot and daily thereafter. With every
		// window at its default (0 = keep everything) this is a no-op; the point
		// is that a window an operator SETS takes effect without anyone having to
		// remember a command. Same gate shape as the reconcile scheduler.
		try {
			if (readString('DEDALO_RETENTION_SCHEDULER_ENABLED') !== 'false') {
				const { startRetentionScheduler } = await import('./core/retention/scheduler.ts');
				startRetentionScheduler();
			}
		} catch (error) {
			console.error('[retention] scheduler boot failed — retention windows will not run:', error);
		}

		// TOOL BOOT HOOKS (ToolServerModule.onBoot — e.g. tool_export's TTL
		// sweeper). Loads the tool registry now, so the first request never
		// evaluates tool modules. Handles are this boot's; stopped on shutdown.
		// Never fatal — a tool never stops the archive from serving.
		try {
			shutdownStops.push(...(await startToolBootHooks()));
		} catch (error) {
			console.error('[tools] boot hooks failed — tool timers will not run:', error);
		}

		// MEDIA TREE (audit 2026-08_oh1_beta §5.2). PHP provisioned the whole tree
		// under the media root on EVERY REQUEST (core/base/dd_init_test.php); the
		// rewrite ported only the media ROOT, so `media/av/subtitles` was never
		// created and tool_transcription refused to write a single VTT. The
		// installer step alone cannot fix that: every existing install is long past
		// the installer, so the pass has to run HERE, at boot, like PHP's did.
		//
		// BEFORE writeRuleFiles below, because the rule files are written INTO the
		// media root and the .publication store lives under it. Synchronous and
		// before serving: one stat per declared directory plus three write probes
		// (sub-millisecond on a healthy tree), and a request must never observe a
		// half-provisioned tree. NEVER fatal — provisionMediaTreeAtBoot swallows and
		// logs everything (S1-15 posture: a broken media root is loud, not a refusal
		// to serve the archive's records).
		provisionMediaTreeAtBoot();

		// RELEASE FILES DIRECTORY (core/update/code_files_dir.ts): a code server's
		// DEDALO_CODE_FILES_DIR is created here, at a deliberate mode, when the key
		// is set and the directory is not. Same reason the media tree is provisioned
		// at boot rather than at install: IS_A_CODE_SERVER is an .env edit away on a
		// box that installed years ago, and until the root exists the build refuses,
		// the manifest advertises nothing and the readiness panel reads `blocked`.
		// No-op on every install that is not a code server. Never fatal.
		ensureCodeFilesDirAtBoot();

		// Media access control (Rule A): refresh the generated web-server rules at BOOT,
		// not only at login. On a fresh deploy or a wiped media dir the rule files would
		// otherwise be absent until the first user happened to log in — and an absent
		// .htaccess means Apache serves the entire media tree to the world in the
		// meantime. Config-hash guarded, so this is normally a no-op.
		try {
			writeRuleFiles();
			announceUnconfiguredMediaProtection();
			// One-shot migration: the day-global auth store is dead once the credential
			// is per-session, and a file full of live-looking credentials left on disk is
			// what gets restored from a backup years later. Renamed, not unlinked, so an
			// operator debugging the upgrade can still see it. NOT a marker reconcile —
			// see session_media.sweepExpiredSessions for why that must not run at boot.
			retireLegacyAuthStore();
		} catch (error) {
			console.error(
				'[media_protection] could not write the media rule files at boot — the media ' +
					'gate on disk may be stale or absent. Check write permissions on the media root. Cause:',
				error,
			);
		}

		// ALTERNATE-EXTENSION PRE-FLIGHT — advisory, never fatal, and the ONLY place
		// an operator learns that a format they configured is refused or unencodable
		// on this host. The rule, the reasons and the gate live with it in
		// core/media/alternate_preflight.ts (an inline fire-and-forget block with no
		// awaited effect is the shape a refactor deletes as dead).
		void (async () => {
			const { reportAlternateExtensionSupport } = await import(
				'./core/media/alternate_preflight.ts'
			);
			await reportAlternateExtensionSupport();
		})();

		// Observer subscription registry boot probe (Act 2 remediation,
		// 2026-08-02): the DEC-12 gates validate the subscription contract
		// against the SUITE database only — a strict subset of a production
		// ontology — so an observer edge authored only in the production
		// ontology can never turn CI red. THIS is the production locus: warm
		// the registry against the REAL ontology at every boot/deploy ("read
		// once at bun start") — the build-of-record logs every contract
		// violation (dead config, unresolved hosts, cycles) loudly and feeds
		// the observers_registry_contract_violations counter — and register
		// the gauge that keeps the current state visible on GET
		// /api/v1/counters between rebuilds.
		void (async () => {
			const { getSubscriptionRegistry, validateSubscriptionContract } = await import(
				'./core/section/record/observer_subscriptions.ts'
			);
			const { registerOpsGauge } = await import('./core/api/counters.ts');
			registerOpsGauge('observers_registry', async () => {
				const index = await getSubscriptionRegistry();
				return {
					contract_violations: validateSubscriptionContract(index),
					dead_wildcards: index.diagnostics.deadWildcards,
					host_unresolved: index.diagnostics.hostUnresolved,
					cycles: index.diagnostics.cycles.length,
				};
			});
			await getSubscriptionRegistry(); // warm + loud-validate the real ontology
		})().catch((error) =>
			console.error('[observers] subscription registry boot probe failed:', error),
		);

		// RELATION-CLOSURE gauge (audit PERF-04) + the client-asset MANIFEST
		// (audit PERF-13), both registered here for the registerOpsGauge reason:
		// core/relations and core/api must not import the process root, and the
		// manifest walk must happen at BOOT rather than on an authenticated
		// request. The manifest prewarm is fire-and-forget: a failure only means
		// the first get_dedalo_files pays the walk it used to pay every time.
		void (async () => {
			const { registerOpsGauge } = await import('./core/api/counters.ts');
			const { relatedClosureStats } = await import('./core/relations/related.ts');
			registerOpsGauge('relation_closure', async () => relatedClosureStats());
			const { prewarmDedaloFilesManifest } = await import('./core/api/dedalo_files.ts');
			prewarmDedaloFilesManifest();
		})().catch((error) =>
			console.error('[boot] relation-closure gauge / client manifest prewarm failed:', error),
		);

		void import('./diffusion/jobs/schema.ts')
			.then(({ ensureDiffusionJobTables }) => ensureDiffusionJobTables())
			.then(async () => {
				if (schedulerEnabled) {
					const { startDiffusionScheduler } = await import('./diffusion/jobs/scheduler.ts');
					startDiffusionScheduler();
				} else {
					console.warn('[diffusion] scheduler disabled (DEDALO_DIFFUSION_SCHEDULER_ENABLED=false)');
				}
			})
			.then(async () => {
				// Diffusion gauge for the admin counters endpoint (S2-37): registered
				// HERE — core/api/counters.ts must not import src/diffusion (the
				// boundary tripwire allows exactly two seams; this is the inversion).
				const { countQueuedJobs, countRunningJobs } = await import('./diffusion/jobs/queue.ts');
				const { getMaxRunners, isSchedulerPaused } = await import('./diffusion/jobs/scheduler.ts');
				const { registerOpsGauge } = await import('./core/api/counters.ts');
				registerOpsGauge('diffusion', async () => ({
					queued: await countQueuedJobs(),
					running: await countRunningJobs(),
					max_runners: getMaxRunners(),
					paused: isSchedulerPaused(),
				}));

				// Publication rows for the ACTIVITY TRAY (dd_utils_api::get_activity),
				// registered by the SAME inversion and for the same reason: core/api/
				// activity.ts must not import src/diffusion. Without this the tray
				// would show media work only and silently omit the longest-running
				// process in the system, which reads as "nothing is happening".
				const { listActiveJobsForOwner } = await import('./diffusion/jobs/queue.ts');
				const { registerActivityProvider, DIFFUSION_STATUS, RECENT_TERMINAL_MS } = await import(
					'./core/api/activity.ts'
				);
				registerActivityProvider('diffusion', async (userId) => {
					// Live AND recently-finished, symmetric with the media half: a
					// client that only ever sees live rows must GUESS what a row's
					// disappearance meant, and that guess painted failed publications
					// green. The outcome is stated, never inferred.
					const jobs = await listActiveJobsForOwner(userId, RECENT_TERMINAL_MS);
					return jobs.map((job) => {
						// counter/total arrive as TEXT on purpose (see listActiveJobs):
						// one malformed legacy value must degrade to "no percentage",
						// never abort the whole read.
						const counter = Number(job.counter_text);
						const total = Number(job.total_text);
						const progress =
							Number.isFinite(counter) && Number.isFinite(total) && total > 0
								? Math.max(0, Math.min(100, Math.round((counter / total) * 100)))
								: null;
						return {
							source: 'diffusion' as const,
							job_id: job.job_id,
							label: job.msg ?? `Publication ${job.diffusion_element_tipo ?? ''}`.trim(),
							record:
								job.section_tipo === null
									? null
									: { section_tipo: job.section_tipo, section_id: null },
							status: DIFFUSION_STATUS[job.state],
							progress,
							started_at: job.created_at === null ? null : new Date(job.created_at).getTime(),
							// A failed publication must be able to say WHY, or the tray
							// reports a red row with no reason and the operator has to go
							// to the admin console to learn what happened.
							errors: Array.isArray(job.errors) ? job.errors.map(String) : [],
							stream: 'diffusion' as const,
						};
					});
				});
			})
			.catch((error) => console.error('[diffusion] boot init failed:', error));

		// Statistics-collector wipe detection (WC-074). DETECTION ONLY — it never
		// repairs: repair is `analyze_statistics` in the Database-info panel, an
		// operator action. Multiple Bun instances against one database is a
		// documented topology, so a rolling restart here would otherwise fire N
		// concurrent ANALYZEs.
		//
		// WHY AT BOOT: the condition is CREATED by a restart or a restore, so boot
		// is exactly when it becomes true — a periodic timer would spend its life
		// re-confirming a healthy state, and once the counters are correct
		// autoanalyze maintains statistics by itself.
		//
		// WHY THIS PREDICATE: `pg_stat_database.stats_reset` is useless here —
		// variable-numbered stats entries are DROPPED and recreated NULL. The
		// FIXED-numbered views are reset in place WITH a timestamp, so
		// `pg_stat_bgwriter.stats_reset >= pg_postmaster_start_time()` means the
		// cumulative counters were discarded at or after this boot. That is exact,
		// unlike the per-table inference in `summarizeStatisticsHealth`, which is a
		// heuristic over current state. Two known limits, both deliberate: it stays
		// TRUE for the whole postmaster lifetime (it is provenance, never "repair
		// owed"), and it is blind to a restore into a fresh cluster (counters zero,
		// flag FALSE) — which is precisely the case the per-table verdict catches.
		// The two signals are complements; neither duplicates autovacuum, because
		// autovacuum is the thing that cannot fire.
		void (async () => {
			const { sql } = await import('./core/db/postgres.ts');
			const rows = (await sql.unsafe(
				`SELECT (stats_reset >= pg_postmaster_start_time()) AS wiped, stats_reset
				 FROM pg_stat_bgwriter`,
				[],
			)) as { wiped: boolean | null; stats_reset: unknown }[];
			if (rows[0]?.wiped === true) {
				console.warn(
					`[db stats] cumulative statistics counters were DISCARDED at or after this boot (pg_stat_bgwriter.stats_reset=${String(rows[0].stats_reset)}). autovacuum and autoanalyze trigger on those counters, so until a table accumulates 50 + 0.1*reltuples modifications from zero they will not fire on it — for a large low-churn table that means never, in practice. Check the Database-info panel and run "Repair table statistics" (ANALYZE) if it reports degraded.`,
				);
			}
		})().catch((error) => console.error('[db stats] boot wipe probe failed:', error));
	} // end if (databaseBoot && !smokeBoot)

	// Media job pfile reconcile + residue GC (audit S2-15/S3-46): flip stale
	// 'running' pfiles from previous process lives to 'interrupted' and prune
	// ancient terminal pfiles. Fire-and-forget — pure filesystem hygiene.
	// Skipped in a smoke boot: the quarantine must not touch the live pfiles.
	if (!smokeBoot)
		void import('./core/media/jobs.ts')
			.then(({ reconcileProcessFiles }) => {
				const { interrupted, pruned } = reconcileProcessFiles();
				if (interrupted.length > 0 || pruned > 0) {
					console.warn(
						`[media jobs] boot reconcile: ${interrupted.length} stale running pfile(s) marked interrupted, ${pruned} old pfile(s) pruned`,
					);
				}
			})
			.catch((error) => console.error('[media jobs] boot reconcile failed:', error));

	// THE CLIENT THE PROXY SERVES IS THIS ENGINE'S (installer unification D2). In a
	// container stack nginx serves the client from a volume this step fills with the
	// client of the code now booting, before the socket binds — so the first request
	// the proxy forwards already meets a client of the same version. EVERY boot mode
	// (the install wizard is client too); a no-op outside containers (key unset) and
	// in a smoke boot. Never fatal: it logs and the API still serves.
	await publishClientAtBoot({ smokeBoot });

	const socketPath = config.server.unixSocketPath;
	// A previous unclean shutdown leaves the socket file behind; Bun cannot
	// bind over it. Removing a STALE socket at boot is the standard fix — but
	// first PROBE it (S2-17b): if something answers, another instance is live
	// and starting would silently orphan it. Refuse loudly instead.
	if (existsSync(socketPath)) {
		if (await socketIsLive(socketPath)) {
			console.error(
				`FATAL: another server instance is already listening on ${socketPath} — refusing to steal its socket. Stop the running instance first (or point SERVER_UNIX_SOCKET elsewhere).`,
			);
			process.exit(1);
		}
		unlinkSync(socketPath);
	}
	const servers: ReturnType<typeof Bun.serve>[] = [];
	const server = Bun.serve({
		unix: socketPath,
		maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
		// Explicit idleTimeout (audit S2-33): Bun's silent 10 s default killed any
		// slow request on the TCP listener; both listeners now share the pinned,
		// configurable value. The proxy in front must be tuned to match
		// (engineering/PRODUCTION.md). Cast: @types/bun omits idleTimeout on the unix
		// options shape (still true of @types/bun 1.4.0 — idleTimeout lives on
		// HostnamePortServeOptions, never on BaseServeOptions, so UnixServeOptions
		// does not inherit it); the runtime accepts it. Re-checked on 1.4.0
		// 2026-08-25: do NOT drop the cast on the strength of the types.
		idleTimeout: config.ops.idleTimeoutSeconds as unknown as undefined,
		fetch(request) {
			// The unix socket is reachable only by whatever can open that file — in the
			// documented topology, the local reverse proxy and nothing else. That is what
			// makes its X-Forwarded-For believable, and why `socket` is the default
			// TRUSTED_PROXY_TRANSPORT. A socket peer has no address to report, so there
			// is no peerIp: on this listener the header is the only source there is.
			return handleRequest(
				request,
				createRequestContext({ proxyTrusted: trustedProxyTransport() === 'socket' }),
			);
		},
		// Catch-all for any throw that escapes handleRequest (API-01 hardening).
		// Without it, an un-try/caught throw returns Bun's raw 500 stack page,
		// leaking SQL fragments / filesystem paths. Return a sanitized JSON
		// envelope; the detail stays server-side in the log.
		error(error) {
			console.error('[server] unhandled fetch error:', error);
			return jsonErrorResponse();
		},
	});
	servers.push(server);

	// THE SOCKET IS THE ONE THING THAT NEEDS TO BE WORLD-WRITABLE (P2-15/OPS-05).
	//
	// Connecting to a unix socket requires WRITE permission on it, and the proxy
	// container runs as a different user — without this, every request is a 502.
	// The Dockerfile used to buy that by setting `umask 0000` for the whole engine
	// process for its whole life: correct reason, wrong scope. EVERY file created
	// without an explicit mode then landed 0666 — the session store and its
	// -wal/-shm, process and job records, media derivatives, and `ts_state.json`,
	// which is not inert: it carries `media_access_mode` (which WINS over .env)
	// and `install_status`, so writing `configured` back into it flips
	// installInProgress() true and RE-OPENS the pre-auth install surface, whose
	// actions rewrite ../private/.env and restart the process.
	//
	// Named volumes bound that in the shipped stacks; an operator bind-mounting
	// /private — which the Dockerfile's own comments contemplate — is where it
	// bites. So the umask is narrow now and the permission is granted HERE, to
	// this file and nothing else.
	try {
		chmodSync(socketPath, 0o666);
	} catch (error) {
		// Never fatal: a platform that refuses chmod on a socket still serves, and
		// a 502 with this line in the log is far easier to diagnose than a silent
		// world-writable private directory.
		console.warn(`[server] could not set the socket mode on ${socketPath}:`, error);
	}

	console.log(`Dédalo TS server listening on unix socket ${socketPath} (entity: ${config.entity})`);

	// ONLINE MIGRATIONS (migrate.ts runOnlineMigrations): the CONCURRENTLY index
	// builds that must never hold the listener — a full-heap build pre-listen
	// outlasted the systemd watchdog (rollback / restart loop). Background, never
	// awaited; every reader is correct without the index. Same skips as the boot
	// runner (install mode: no DB; smoke boot: read-only by construction).
	if (databaseBoot && !smokeBoot) void startOnlineMigrations();

	// CODE-UPDATE BOOT CONFIRMATION (core/update/boot_confirm.ts): once the
	// listener is up AND the first DB ping is green, flip a pending update
	// sentinel to 'confirmed' so the supervisor-side rollback stands down.
	// Skipped in install mode and mid-wizard (no seeded DB) and in a smoke boot
	// (the quarantine must never confirm an update it is merely rehearsing).
	if (databaseBoot && !smokeBoot) {
		void (async () => {
			if (await checkDbHealth()) {
				const { confirmBootedCodeUpdate } = await import('./core/update/boot_confirm.ts');
				// PUBLICATION API LOCKSTEP (PUBLICATION_HOST_SPEC §3, phase 4): once THIS tree
				// is confirmed, push its verified API releases to every paired publication
				// host — detached, never throwing. Dynamic for the same reason as the line
				// above (CONVENTIONS §2 rationale 3: a cold path, once per confirmed boot).
				// The module is loaded INSIDE the hook, AFTER the flip: a publication-host
				// module that fails to load is logged and can never veto the confirmation
				// (an unconfirmed sentinel makes the supervisor roll back a healthy update).
				// The trigger re-checks smoke/install itself: this block's guard is the
				// first line of defence, not the only one.
				await confirmBootedCodeUpdate(undefined, undefined, undefined, () => {
					void import('./core/publication_host/api_reconcile.ts')
						.then(({ triggerPublicationApiPush }) => {
							triggerPublicationApiPush({ smokeBoot, installMode: config.installMode });
						})
						.catch((error) =>
							console.error('[publication_apis] post-confirm trigger failed to load:', error),
						);
				});
			} else {
				console.warn('[code update] boot confirmation deferred: DB ping failed at boot');
			}
		})().catch((error) => console.error('[code update] boot confirmation errored:', error));
	}

	// Optional TCP dev listener (browsers cannot reach a unix socket directly;
	// production stays socket-only behind the reverse proxy). Set
	// SERVER_TCP_PORT to expose the copied client + API at
	// http://localhost:<port>/dedalo/core/page/ for local development.
	// Read via readEnv so it resolves from ../private/.env like all other config
	// (NOT process.env only — a plain `bun run` doesn't export the private .env,
	// which silently dropped the dev listener on restart).
	const tcpPort = readEnv('SERVER_TCP_PORT');
	if (tcpPort !== undefined && tcpPort !== '') {
		servers.push(
			Bun.serve({
				port: Number(tcpPort),
				maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
				idleTimeout: config.ops.idleTimeoutSeconds,
				fetch(request, server) {
					// devListener: THIS listener is the only one a browser can reach without a
					// web server in front, so it is the only one that may answer media from the
					// engine (mediaFallbackAllowed). The socket listener never sets it.
					//
					// And by the same fact it is the one listener a BROWSER talks to directly,
					// so its X-Forwarded-For is written by whoever connected — not by a proxy.
					// The peer address from the connection is the honest client identity here,
					// and the header is believed only if an operator declared a proxy in front
					// of this port (TRUSTED_PROXY_TRANSPORT=tcp).
					return handleRequest(
						request,
						createRequestContext({
							devListener: true,
							peerIp: server.requestIP(request)?.address ?? null,
							proxyTrusted: trustedProxyTransport() === 'tcp',
						}),
					);
				},
				error(error) {
					console.error('[server] unhandled fetch error (dev listener):', error);
					return jsonErrorResponse();
				},
			}),
		);
		console.log(`Dédalo TS dev listener on http://localhost:${tcpPort}/dedalo/core/page/`);
	}

	// Graceful shutdown (audit S2-17): supervisors send SIGTERM; operators ^C.
	process.on(
		'SIGTERM',
		() => void shutdownGracefully('SIGTERM', servers, socketPath, 0, shutdownStops),
	);
	process.on(
		'SIGINT',
		() => void shutdownGracefully('SIGINT', servers, socketPath, 0, shutdownStops),
	);

	// A PLANNED restart (persist_config, code update) is a shutdown too, and gets
	// the same drain. Registered rather than imported: core/install must not close
	// an import cycle back through the process root (same seam as registerOpsGauge).
	{
		const { registerGracefulShutdown } = await import('./core/install/restart.ts');
		registerGracefulShutdown((exitCode, reason) => {
			void shutdownGracefully(reason, servers, socketPath, exitCode, shutdownStops);
		});
	}

	return server;
}

if (import.meta.main) {
	void startServer();
}
