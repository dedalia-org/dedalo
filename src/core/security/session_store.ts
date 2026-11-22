/**
 * Session store + login throttle — NEW NATIVE TS AUTH (spec §7.2; explicitly
 * NOT PHP-session-compatible, per project decision).
 *
 * Storage: bun:sqlite database in the private config dir. Deliberate choice:
 * - the shared PostgreSQL schema must stay untouched (spec §2.2) — TS-only
 *   infrastructure lives outside it;
 * - bun:sqlite is built-in, zero-dep, transactional, survives restarts.
 *
 * Security properties (each mirrors or exceeds a PHP guarantee):
 * - session tokens: 32 random bytes; the DB stores only their SHA-256 —
 *   a leaked DB file cannot be replayed as a cookie;
 * - session fixation resistance: tokens are server-minted (never client-set) and
 *   there are no pre-auth/anonymous sessions to fixate, so login issuing a fresh
 *   token cannot be pinned by an attacker. AUTHZ-04: concurrent multi-device
 *   sessions are allowed BY DEFAULT — `login` does not evict a user's other
 *   sessions, so a stolen token survives an ordinary re-login until its TTL. The
 *   opt-in `DEDALO_SINGLE_SESSION` flag closes that window (login calls
 *   `destroyUserSessions(userId, newToken)` — one active session per user). A
 *   password reset revokes ALL of a user's sessions regardless of the flag
 *   (password_reset.ts), so account recovery always cuts off a stolen token.
 * - per-session CSRF token (PHP SEC-008), constant-time compared;
 * - sliding-window login throttle keyed namespace|username|ip (PHP SEC-019),
 *   reset on success, shared across processes via the same sqlite file;
 * - sessions expire after SESSION_TTL_SECONDS of inactivity, and unconditionally
 *   at SESSION_ABSOLUTE_TTL_SECONDS since creation. Both clocks are enforced on
 *   read (getSession) AND swept by the GC (pruneExpiredSessions) — a session the
 *   reader rejects but the GC keeps is a row that never dies.
 */

import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { privateDir, readEnv } from '../../config/env.ts';
import { readString } from '../../config/readers.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { dropAuthMarker } from '../media/protection.ts';

/** Session cookie name — TS-native, distinct from any PHP cookie. */
export const SESSION_COOKIE = 'dedalo_ts_session';

const SESSION_TTL_SECONDS = Number(readString('SESSION_TTL_SECONDS')); // 12h
/**
 * Absolute session lifetime (L3): a session is rejected once it is older than
 * this since CREATION, regardless of activity — an idle-only TTL let a session
 * used at least once per window live forever, so a stolen token never aged out.
 * Default 30 days; set 0 to disable the absolute cap (idle-only).
 */
const SESSION_ABSOLUTE_TTL_SECONDS = Number(readString('SESSION_ABSOLUTE_TTL_SECONDS'));
export const LOGIN_MAX_ATTEMPTS = Number(readString('LOGIN_MAX_ATTEMPTS'));
export const LOGIN_ATTEMPT_WINDOW_SECONDS = Number(readString('LOGIN_ATTEMPT_WINDOW'));
export const LOGIN_LOCKOUT_SECONDS = Number(readString('LOGIN_LOCKOUT_SECONDS'));
/**
 * Account-global lockout threshold (per-username, IP-independent). A DEFENSE against
 * IP-rotation brute force that the per-IP bucket alone cannot stop. Deliberately
 * HIGHER than LOGIN_MAX_ATTEMPTS: a low value would let anyone lock a victim's
 * account with a burst of bad passwords (a self-inflicted DoS). Set it very high
 * to effectively disable the account dimension.
 */
export const LOGIN_ACCOUNT_MAX_ATTEMPTS = Number(readString('LOGIN_ACCOUNT_MAX_ATTEMPTS'));

/**
 * SOURCE-GLOBAL lockout threshold: failed logins from ONE address, whatever
 * username they name (audit 2026-08-26 SEC-21).
 *
 * The two older dimensions are keyed (username, ip) and (username). Both start
 * from the username, so a caller who ROTATES the username gets a fresh bucket on
 * both of them at every single request — the throttle stopped brute force
 * against an account and did nothing at all about VOLUME from one source, which
 * is how one unauthenticated client could keep writing denial rows for as long
 * as it liked. This bucket is the missing dimension.
 *
 * Sized well above the other two on purpose. It must never refuse a shared
 * address doing ordinary work — a museum behind one NAT, a reading room, a
 * proxy — so it is a FLOOD ceiling, not a guessing ceiling: at this many failed
 * logins from one address inside the window, that address is not a person
 * mistyping a password. CONFIGURED like its two siblings (default 100), because
 * the address behind a large institution's NAT is exactly the case that needs to
 * raise it, and a code edit is not a knob.
 */
export const LOGIN_SOURCE_MAX_ATTEMPTS = Number(readString('LOGIN_SOURCE_MAX_ATTEMPTS'));

/** One authenticated session as the dispatch layer consumes it. */
export interface Session {
	userId: number;
	username: string;
	/**
	 * The login-time SNAPSHOT of the account's global-admin grant — DESCRIPTIVE ONLY,
	 * NOT AN AUTHORIZATION INPUT. Nothing rewrites it after login, so any reader would
	 * serve a demoted administrator the old authority for the session's whole TTL
	 * (SEC-14). Every admin-only surface resolves the Principal per request instead:
	 * dispatched actions via `dispatchRqo`, the raw routes via
	 * `security/session_gate.ts`. Behavioural gate: account_revocation_native ("the
	 * principal, not the snapshot, decides").
	 *
	 * FOLLOW-UP (named, not silent): the column and `createSession`'s third argument
	 * are now reader-less; removing them changes the createSession arity across the
	 * test helpers and scripts/client_test_runner.ts, which is a separate sweep.
	 */
	isGlobalAdmin: boolean;
	csrfToken: string;
	/**
	 * Per-session language overrides (PHP $_SESSION['dedalo']['config']
	 * ['dedalo_application_lang'/'dedalo_data_lang'], set by dd_utils_api::
	 * change_lang). Null until the user picks a language from the menu selector;
	 * null means "use the installation default" (see core/resolve/request_lang.ts).
	 */
	applicationLang: string | null;
	dataLang: string | null;
	/**
	 * The sha256 of the session token — the row key, carried so per-request
	 * writers (setSessionSqo) can update THIS session without the raw token.
	 * Never a secret leak: it is the stored key, not the cookie value.
	 * OPTIONAL: synthetic harness sessions omit it (in-memory-only writes).
	 */
	tokenHash?: string;
	/**
	 * This session's MEDIA credential: the value of its `dedalo_media_auth` cookie and
	 * the name of the zero-byte marker under `<media>/.publication/auth/` that the web
	 * server stats to authorize rule A. Per-SESSION since 2026-08-24 — it used to be one
	 * value per install per day, which meant a stolen cookie could not be revoked by
	 * logging out or by resetting the password, for up to ~48 hours.
	 *
	 * null when protection is off, when the media root is unset, or on a session created
	 * before the column existed — the per-request re-issue re-keys those lazily. OPTIONAL
	 * for synthetic harness sessions.
	 */
	mediaKey?: string | null;
	/**
	 * Per-section navigation SQOs (PHP $_SESSION['dedalo']['config']['sqo'],
	 * keyed by section::build_sqo_id = the caller tipo). Written by section
	 * list/edit reads (dd_core_api :2276-98), stamped on section contexts as
	 * `sqo_session`, re-read by tools (tool_export, section_tool navigation).
	 * OPTIONAL for synthetic sessions; getSession always populates it.
	 */
	sqoSession?: Record<string, unknown>;
	/**
	 * Seconds this session has left, as of the request that resolved it: the LOWER
	 * of the idle window (which this very request just refreshed) and what remains
	 * of the absolute cap. Dispatch ships it to the client as `session_expires_in`
	 * so the UI can warn BEFORE the next click fails — see SESSION_WARNING_SECONDS.
	 *
	 * Undefined for synthetic harness sessions, which have no row to age.
	 */
	expiresIn?: number;
	/**
	 * Seconds left on the ABSOLUTE cap alone (null when the cap is disabled).
	 *
	 * Split out from `expiresIn` because the two clocks behave differently for the
	 * client's warning timer: the idle window restarts on every request, so the
	 * client can re-arm it locally from SESSION_TTL_SECONDS, while the absolute
	 * deadline only ever approaches and cannot be derived from a min() that the
	 * idle term usually wins.
	 */
	absoluteExpiresIn?: number | null;
}

/** The idle window, in seconds — read by the boot payload so the client can re-arm
 * its warning timer on each response without a per-response wire field. */
export const SESSION_IDLE_TTL_SECONDS = SESSION_TTL_SECONDS;

/**
 * Seconds until `session` dies, given its row timestamps. The idle clock is
 * measured from `last_seen` — and every caller of this has just refreshed it —
 * so the idle term is effectively the full window; the absolute term is what
 * actually shrinks across a working day. Never negative: a session that has
 * already expired is destroyed by getSession before this is reached.
 */
function secondsUntilExpiry(row: { created_at: number; last_seen: number }, now: number): number {
	const idleLeft = SESSION_TTL_SECONDS - (now - row.last_seen);
	if (SESSION_ABSOLUTE_TTL_SECONDS <= 0) return Math.max(0, idleLeft);
	const absoluteLeft = SESSION_ABSOLUTE_TTL_SECONDS - (now - row.created_at);
	return Math.max(0, Math.min(idleLeft, absoluteLeft));
}

/**
 * Store path (S1-18): the live file in ../private by default; the
 * DEDALO_SESSION_DB_PATH override exists so `bun test` (bunfig [test].preload
 * → test/preload/session_db.ts) points the WHOLE test process at a per-run
 * scratch file — tests and the live dev server must never share this database.
 */
/** The store a SERVING process opens. Exported so `session_media` can tell a real
 *  installation from a repointed throwaway one (the smoke boot) before it reconciles
 *  markers against the inherited media root. */
export const LIVE_SESSION_DB_PATH = join(privateDir, 'dedalo_ts_sessions.sqlite');
const sessionDbPath = readEnv('DEDALO_SESSION_DB_PATH') ?? LIVE_SESSION_DB_PATH;
/** The resolved on-disk session store path (honours the override) — read-only
 * accessor for status surfaces (e.g. the check_config maintenance widget). */
export const SESSION_DB_PATH = sessionDbPath;

// BOOTSTRAP ORDER (install): sqlite's `create: true` creates the FILE, never its
// parent DIRECTORY — an absent one is SQLITE_CANTOPEN. This module opens the DB
// at import, which on a fresh tree happens BEFORE the installer has run
// persistConfig/checkDirectories (the steps that would mkdir privateDir), so
// merely importing anything that reaches the session store used to abort the
// install. Create the parent ourselves: 0o700 because this file holds session
// and throttle state (same mode install/config_persist.ts gives privateDir).
// Recursive+idempotent, and a no-op mode-wise when the directory already exists.
mkdirSync(dirname(sessionDbPath), { recursive: true, mode: 0o700 });

const database = new Database(sessionDbPath, { create: true });
// OPS-04 (2026-07-28 audit): the session store holds session tokens, CSRF
// secrets and password-reset codes — make the file OWNER-ONLY. It was created
// with the process umask (commonly world-readable 0644). Best-effort: an
// in-memory (:memory:) test path or a file we do not own must never block boot.
try {
	if (sessionDbPath !== ':memory:') chmodSync(sessionDbPath, 0o600);
} catch {
	/* best-effort hardening */
}
// busy_timeout is PER-CONNECTION state: set it immediately after every open,
// or a concurrent writer (dev server + test run) throws SQLITE_BUSY after ~1ms.
database.exec('PRAGMA busy_timeout = 5000');
// journal_mode=WAL is a persistent property of the FILE (idempotent to re-run):
// switched deliberately so cross-process readers and one writer coexist instead
// of serializing on the rollback journal.
database.exec('PRAGMA journal_mode = WAL');
database.exec(`
	CREATE TABLE IF NOT EXISTS sessions (
		token_hash TEXT PRIMARY KEY,
		user_id INTEGER NOT NULL,
		username TEXT NOT NULL,
		is_global_admin INTEGER NOT NULL DEFAULT 0,
		csrf_token TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		last_seen INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS login_attempts (
		attempt_key TEXT NOT NULL,
		attempted_at INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_attempts_key ON login_attempts(attempt_key, attempted_at);
	CREATE TABLE IF NOT EXISTS password_resets (
		reset_key TEXT PRIMARY KEY,
		user_id INTEGER NOT NULL,
		code_hash TEXT NOT NULL,
		expires INTEGER NOT NULL,
		attempts INTEGER NOT NULL DEFAULT 0
	);
`);

// Migration: the per-session language columns were added after the sessions
// table shipped. ADD COLUMN on an existing DB throws "duplicate column" once
// applied, so each is guarded — SQLite has no idempotent ADD COLUMN.
for (const column of ['application_lang', 'data_lang', 'sqo_session', 'media_key']) {
	try {
		database.exec(`ALTER TABLE sessions ADD COLUMN ${column} TEXT`);
	} catch (error) {
		// ONLY the expected duplicate-column error is benign (the migration
		// already applied). Anything else (locked DB, disk full, corrupt file)
		// must fail the boot loudly — swallowing it leaves the column missing
		// and every subsequent getSession() throwing (audit S2-39).
		if (!String((error as Error).message ?? error).includes('duplicate column')) {
			throw error;
		}
	}
}

/** One session row as a REVOCATION addresses it: the row key and the credential it holds. */
interface SessionRowKey {
	token_hash: string;
	media_key: string | null;
}

/**
 * Bound on the token hashes bound into ONE delete statement.
 *
 * MEASURED on this Bun (1.4.0, bun:sqlite): a bound-parameter list is accepted up to
 * 32766 and refused above it ("SQLite query expected 34464 values, received 100000") —
 * so the ceiling is real, just higher than the folkloric 999. The periodic sweep is the
 * statement that can approach it: an installation coming back from a long downtime
 * selects every expired session at once. And this delete runs AFTER the markers are
 * unlinked, so one oversized statement would throw with every credential in the batch
 * already revoked and every row still present — the one shape worse than either half.
 * Chunking keeps each statement valid, and keeps a failure part-way through in the
 * fail-CLOSED direction (some sessions ended, the rest still work).
 */
const DELETE_CHUNK = 400;

/**
 * SEC-09 / the FAIL-CLOSED ORDER — every session deletion in this file goes through
 * here, and it unlinks the MEDIA MARKER BEFORE it deletes the ROW.
 *
 * The two stores fail in opposite directions, which is why the order is not a detail:
 *
 *   delete-then-unlink — a crash in between leaves NO session row and a LIVE marker.
 *     The web server never consults the session store, so that cookie keeps read access
 *     to the entire digitised archive, permanently, and nothing is left to name it: the
 *     row that held the key is gone. That was the shipped shape, on every path.
 *   unlink-then-delete — a crash in between leaves a session that STILL WORKS. The next
 *     request, the next logout or the periodic sweep ends it properly, and in the
 *     meantime the account holds exactly the access it already had.
 *
 * So the marker goes first. The DELETE then addresses the rows BY TOKEN HASH — the same
 * rows the SELECT read — rather than re-running the predicate, so a session that was
 * touched between the two statements cannot escape the delete after its marker is
 * already gone (that would be a live row with a dead credential, and nothing to fix it
 * but a re-login).
 *
 * `dropAuthMarker` is a STATIC import, not a registered hook. The hook shape was tried
 * first and it is vacuous exactly where it matters: any process that expires a session
 * without having imported the registering module revokes nothing and only logs about
 * it. `media/protection.ts` imports config, env, server_state and svg_safety — none of
 * which reaches back here — so the static edge closes no cycle, and it makes the unlink
 * unconditionally present in every process that can read a session.
 */
function endSessionRows(rows: SessionRowKey[]): { removed: number; mediaKeys: string[] } {
	const mediaKeys = rows
		.map((row) => row.media_key)
		.filter((key): key is string => key !== null && key !== '');
	// MARKER FIRST. Idempotent and never throws (protection.ts swallows ENOENT), so a
	// marker already gone cannot block the row delete.
	for (const key of mediaKeys) dropAuthMarker(key);
	let removed = 0;
	for (let start = 0; start < rows.length; start += DELETE_CHUNK) {
		const chunk = rows.slice(start, start + DELETE_CHUNK);
		const placeholders = chunk.map(() => '?').join(',');
		const deleted = database
			.query(`DELETE FROM sessions WHERE token_hash IN (${placeholders}) RETURNING token_hash`)
			.all(...chunk.map((row) => row.token_hash)) as unknown[];
		removed += deleted.length;
	}
	return { removed, mediaKeys };
}

function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

function sha256Hex(value: string): string {
	return new Bun.CryptoHasher('sha256').update(value).digest('hex');
}

/**
 * Create a session for a verified user. Returns the RAW token (cookie value).
 *
 * `mediaKey` is this session's MEDIA credential — the value of the `dedalo_media_auth`
 * cookie and the name of its marker file under `<media>/.publication/auth/`. It is
 * per-session precisely so that logging out can revoke it: it used to be one value per
 * INSTALL per DAY, which meant no logout and no password reset could take it away from
 * whoever had stolen it, for up to ~48 hours (today's and yesterday's markers are both
 * valid). Storing it on the session row makes the marker set a PROJECTION of this table.
 *
 * OPTIONAL, and that is deliberate rather than lax: more than a hundred test files and
 * the client-suite runner construct sessions three-arity, and a required fourth argument
 * would turn a security fix into a mass edit of unrelated call sites. A session with no
 * media key simply holds no media credential and is re-keyed lazily on its next
 * authenticated request — the same path that carries sessions across the upgrade.
 */
export function createSession(
	userId: number,
	username: string,
	isGlobalAdmin: boolean,
	mediaKey: string | null = null,
): string {
	const rawToken =
		crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
	const csrfToken =
		crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
	database
		.query(
			`INSERT INTO sessions (token_hash, user_id, username, is_global_admin, csrf_token, created_at, last_seen, media_key)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			sha256Hex(rawToken),
			userId,
			username,
			isGlobalAdmin ? 1 : 0,
			csrfToken,
			nowSeconds(),
			nowSeconds(),
			mediaKey,
		);
	// Language columns start NULL (installation default) — a fresh login carries
	// no per-user language preference until the user picks one from the menu.
	return rawToken;
}

/**
 * Persist a per-session language override (PHP change_lang → $_SESSION). Only
 * the languages supplied are written; passing `undefined` leaves that column
 * untouched. Missing session (expired between the read and this write) is a
 * silent no-op — the caller already validated the request.
 */
export function setSessionLangs(
	rawToken: string,
	langs: { applicationLang?: string; dataLang?: string },
): void {
	if (langs.applicationLang !== undefined) {
		database
			.query('UPDATE sessions SET application_lang = ? WHERE token_hash = ?')
			.run(langs.applicationLang, sha256Hex(rawToken));
	}
	if (langs.dataLang !== undefined) {
		database
			.query('UPDATE sessions SET data_lang = ? WHERE token_hash = ?')
			.run(langs.dataLang, sha256Hex(rawToken));
	}
}

/** Resolve a raw token to a live session (touching last_seen); null if invalid/expired. */
export function getSession(rawToken: string): Session | null {
	const row = database
		.query(
			'SELECT user_id, username, is_global_admin, csrf_token, created_at, last_seen, application_lang, data_lang, sqo_session, media_key FROM sessions WHERE token_hash = ?',
		)
		.get(sha256Hex(rawToken)) as {
		user_id: number;
		username: string;
		is_global_admin: number;
		csrf_token: string;
		created_at: number;
		last_seen: number;
		application_lang: string | null;
		data_lang: string | null;
		sqo_session: string | null;
		media_key: string | null;
	} | null;
	if (row === null) return null;
	if (nowSeconds() - row.last_seen > SESSION_TTL_SECONDS) {
		destroySession(rawToken);
		return null;
	}
	// Absolute lifetime cap (L3): even a continuously-used session must expire.
	if (
		SESSION_ABSOLUTE_TTL_SECONDS > 0 &&
		nowSeconds() - row.created_at > SESSION_ABSOLUTE_TTL_SECONDS
	) {
		destroySession(rawToken);
		return null;
	}
	const touchedAt = nowSeconds();
	database
		.query('UPDATE sessions SET last_seen = ? WHERE token_hash = ?')
		.run(touchedAt, sha256Hex(rawToken));
	let sqoSession: Record<string, unknown> = {};
	if (row.sqo_session !== null && row.sqo_session !== '') {
		try {
			sqoSession = JSON.parse(row.sqo_session) as Record<string, unknown>;
		} catch (error) {
			// A corrupt map must not kill the session — report and start empty.
			console.error('[session_store] corrupt sqo_session JSON dropped', error);
		}
	}
	return {
		userId: row.user_id,
		username: row.username,
		isGlobalAdmin: row.is_global_admin === 1,
		csrfToken: row.csrf_token,
		applicationLang: row.application_lang,
		dataLang: row.data_lang,
		tokenHash: sha256Hex(rawToken),
		sqoSession,
		// This session's media credential (the `dedalo_media_auth` cookie value and the
		// name of its marker file). null on a session created before the column existed
		// or before a media mode was configured — the re-issue path re-keys it lazily.
		mediaKey: row.media_key,
		// Computed from the JUST-refreshed last_seen, so the client is told what it
		// has left starting now — not what was left before this request landed.
		expiresIn: secondsUntilExpiry({ created_at: row.created_at, last_seen: touchedAt }, touchedAt),
		absoluteExpiresIn:
			SESSION_ABSOLUTE_TTL_SECONDS > 0
				? Math.max(0, SESSION_ABSOLUTE_TTL_SECONDS - (touchedAt - row.created_at))
				: null,
	};
}

/**
 * Persist ONE section's navigation SQO on a live session (PHP
 * section::set_session_sqo + the dd_core_api :2288/:2339 write sites). Also
 * mutates the in-memory session so the SAME request's context stamp
 * (sqo_session) sees the just-stored value — PHP stores before resolving the
 * context and stamps the fresh value.
 *
 * The row write is a READ-MERGE-WRITE, NOT a dump of the in-memory map, and the
 * merge is what fixes the bug. `session` is this request's own snapshot —
 * getSession builds a fresh object with a freshly parsed map on every call — and
 * it is taken at the START of a request that then awaits many times before
 * reaching here. Two overlapping requests therefore both hold snapshots that
 * predate the other's write, so dumping the snapshot back dropped the sibling's
 * key. It showed up as a filter that silently did not apply: opening several
 * related-record windows at once (render_open_list_with_direct_relations)
 * persists one SQO per target section, and every one but the last lost its
 * filter, so those windows listed the WHOLE section instead of the related
 * records.
 *
 * The IMMEDIATE transaction is for a different reader: other PROCESSES on the
 * same session file (a second dev instance, a script). It buys nothing
 * in-process — bun:sqlite is synchronous and this function has no await, so two
 * in-process calls can never interleave at the SQL level. IMMEDIATE, not the
 * default DEFERRED: a deferred transaction that SELECTs and then UPDATEs has to
 * upgrade its lock, and under WAL that upgrade fails with SQLITE_BUSY_SNAPSHOT
 * the moment another connection committed in between — a failure for which
 * SQLite does NOT invoke the busy handler, so the busy_timeout set at open would
 * not save it. Taking the write lock up front keeps the timeout in play.
 */
export function setSessionSqo(session: Session, sqoId: string, sqo: unknown): void {
	// Synthetic (harness) sessions carry no tokenHash — in-memory only.
	if (session.tokenHash === undefined) {
		session.sqoSession ??= {};
		session.sqoSession[sqoId] = sqo;
		return;
	}

	const tokenHash = session.tokenHash;
	// Holder, not a plain `let`: the closure's assignment is invisible to TS's
	// narrowing, and the value is only trustworthy once COMMIT has returned.
	const outcome: { merged: Record<string, unknown> | null } = { merged: null };

	const merge = database.transaction(() => {
		const row = database
			.query('SELECT sqo_session FROM sessions WHERE token_hash = ?')
			.get(tokenHash) as { sqo_session: string | null } | null;
		if (row === null) {
			// The session was destroyed under us (logout, eviction, expiry sweep).
			// Nothing to merge into; the in-memory fallback below is all there is.
			return;
		}

		let stored: Record<string, unknown> = {};
		if (row.sqo_session !== null && row.sqo_session !== '') {
			try {
				const parsed = JSON.parse(row.sqo_session) as unknown;
				if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
					stored = parsed as Record<string, unknown>;
				}
			} catch (error) {
				// Same policy as getSession: a corrupt blob is dropped, not fatal.
				console.error('[session_store] corrupt sqo_session JSON dropped', error);
			}
		}

		stored[sqoId] = sqo;
		database
			.query('UPDATE sessions SET sqo_session = ? WHERE token_hash = ?')
			.run(JSON.stringify(stored), tokenHash);
		outcome.merged = stored;
	});
	merge.immediate();

	// AFTER commit only. The same response stamps this map back to the client as
	// `sqo_session` (section/context.ts), so publishing it before the row is
	// durable would advertise a filter the next request cannot find. A throw
	// above leaves the in-memory map untouched and propagates, as it did before.
	if (outcome.merged !== null) {
		session.sqoSession = outcome.merged;
	} else {
		session.sqoSession ??= {};
		session.sqoSession[sqoId] = sqo;
	}
}

/**
 * Delete one session AND revoke its media credential, in that order — marker first, row
 * second (see `endSessionRows`). Returns the media key it revoked, for logging.
 *
 * A BARE DESTROY IS NOW SAFE, which inverts the old rule. The unlink used to live in
 * `session_media.endSession`, so this function's own docblock had to warn that calling
 * it directly leaked a marker; a warning is not a mechanism, and both expiry branches in
 * `getSession` right above called it anyway. The order is enforced here instead.
 */
export function destroySession(rawToken: string): string | null {
	const row = database
		.query('SELECT token_hash, media_key FROM sessions WHERE token_hash = ?')
		.get(sha256Hex(rawToken)) as SessionRowKey | null;
	if (row === null) return null;
	return endSessionRows([row]).mediaKeys[0] ?? null;
}

/**
 * Evict all of a user's sessions except an optional one to keep (AUTHZ-04 —
 * "log out everywhere"). Returns the number of sessions removed. Not called by
 * login automatically (concurrent sessions are allowed by design); expose it via
 * an explicit user action or call it from login if the deployment opts into
 * single-session semantics.
 */
export function destroyUserSessions(userId: number, keepRawToken?: string): number {
	return destroyUserSessionsDetail(userId, keepRawToken).removed;
}

/**
 * The same eviction, reporting the MEDIA KEYS it freed. A password reset uses this: the
 * reset exists to cut off whoever holds a stolen token, and before the media credential
 * became per-session there was one thing it could not cut off — the media cookie, which
 * stayed valid at the web server for up to ~48 hours no matter what the account did.
 */
export function destroyUserSessionsDetail(
	userId: number,
	keepRawToken?: string,
	/**
	 * Keep one session addressed by its TOKEN HASH instead of its raw token.
	 *
	 * The revocation seam runs post-commit, deep under a save, where the only thing
	 * in reach is the request's `Session` object — and a Session carries `tokenHash`,
	 * never the raw cookie value (that never leaves the HTTP layer, by design). The
	 * self-password-change rule ("the acting session survives, every other session of
	 * that account dies") is unimplementable without this second address.
	 */
	keepTokenHash?: string,
): { removed: number; mediaKeys: string[] } {
	const keepHash = keepTokenHash ?? (keepRawToken !== undefined ? sha256Hex(keepRawToken) : null);
	// SELECT, then unlink, then DELETE by token hash (endSessionRows) — never
	// DELETE … RETURNING, which frees the credential before anything can revoke it.
	const rows = (
		keepHash !== null
			? database
					.query('SELECT token_hash, media_key FROM sessions WHERE user_id = ? AND token_hash <> ?')
					.all(userId, keepHash)
			: database.query('SELECT token_hash, media_key FROM sessions WHERE user_id = ?').all(userId)
	) as SessionRowKey[];
	return endSessionRows(rows);
}

/** Every live session's media key — the exact set of markers that should exist. */
export function listActiveMediaKeys(): string[] {
	const rows = database
		.query('SELECT media_key FROM sessions WHERE media_key IS NOT NULL')
		.all() as { media_key: string }[];
	return rows.map((row) => row.media_key);
}

/** Attach a media key to an existing session (the lazy re-key path). */
export function setSessionMediaKey(rawToken: string, mediaKey: string): void {
	database
		.query('UPDATE sessions SET media_key = ? WHERE token_hash = ?')
		.run(mediaKey, sha256Hex(rawToken));
}

/** Constant-time CSRF comparison (PHP hash_equals equivalent). */
export function verifyCsrf(session: Session, candidate: string | null): boolean {
	if (candidate === null || candidate.length === 0) return false;
	const expected = Buffer.from(session.csrfToken);
	const received = Buffer.from(candidate);
	if (expected.length !== received.length) return false;
	return crypto.timingSafeEqual(expected, received);
}

/**
 * Longest UNTRUSTED identity kept verbatim inside a throttle key.
 *
 * THE DEFECT THIS CLOSES (audit 2026-08-26 SEC-21, second mechanism). A throttle
 * key is an opaque bucket label, but it was built by concatenating the caller's
 * raw username — and it is INSERTED into `login_attempts` on every failure, once
 * per key, and a second time into `idx_attempts_key`. A 520 KB username (in
 * bounds at the parse door, because the untyped `options` bag ceiling is 512 KiB
 * and no real username needs a per-key declaration) therefore measured ~2 MB of
 * durable sqlite per unauthenticated login denial — the same "stored twice"
 * amplification SEC-21 named, in the session store instead of `matrix_activity`.
 *
 * WHY BOUND HERE AND NOT AT THE DOOR: the bucket must stay STABLE (the same
 * identity must always hash to the same bucket) and DISTINCT (two identities must
 * not share one), and both are properties of the KEY, not of the request. So the
 * construction site owns it: short identities stay verbatim (a readable key an
 * operator can grep), anything longer is replaced by a digest of the whole
 * identity — bounded, stable and collision-free, with nothing of the caller's
 * bytes reaching disk.
 */
export const THROTTLE_IDENTITY_MAX_CHARS = 128;

/**
 * The bounded, lowercased projection of an untrusted identity (username, email,
 * reset id) for use inside a throttle key. Never the raw string.
 */
export function throttleIdentity(identity: string): string {
	const lowered = identity.toLowerCase();
	return lowered.length <= THROTTLE_IDENTITY_MAX_CHARS ? lowered : `#${sha256Hex(lowered)}`;
}

/**
 * Throttle key: namespace|bounded-identity|bounded-source (PHP SEC-019 shape).
 *
 * BOTH axes go through `throttleIdentity`, not only the username. The `ip`
 * argument is NOT a validated address: with `TRUSTED_PROXY_HOPS >= 2` (a
 * supported configuration) the hop `server.ts` reads out of X-Forwarded-For is
 * caller-written, so its LENGTH is the caller's too — up to Bun's ~16 KiB header
 * cap — and it lands in `login_attempts.attempt_key` + `idx_attempts_key` on
 * every denial: the same row+index amplification, on the other axis.
 */
export function buildThrottleKey(namespace: string, username: string, ip: string): string {
	return `${namespace}|${throttleIdentity(username)}|${throttleIdentity(ip)}`;
}

/**
 * Account-global throttle key: namespace|acct|lowercased-username (NO ip). Rotating
 * a spoofed X-Forwarded-For cannot mint a fresh bucket for this key, so it caps
 * total failures against one account regardless of source IP. Distinct shape from
 * buildThrottleKey so the two dimensions never collide.
 */
export function buildAccountThrottleKey(namespace: string, username: string): string {
	return `${namespace}|acct|${throttleIdentity(username)}`;
}

/**
 * SOURCE-GLOBAL throttle key: namespace|src|bounded-source (NO username). The
 * third dimension: it caps failures from one source however the username is
 * rotated. Distinct shape from the other two builders so the three can never
 * collide. The source is bounded by `throttleIdentity` for the same reason
 * `buildThrottleKey` bounds it — under a hop count >= 1 the address is read out
 * of a caller-written header, so it is untrusted in BOTH value and length. (It
 * is therefore NOT a dimension a caller can never rotate: with a trusted-hop
 * count above the real proxy depth, a spoofed hop mints fresh buckets on all
 * three. What this bound guarantees is that rotating it stays cheap for the
 * ENGINE — a bounded key per attempt, self-pruned at the window + lockout.)
 */
export function buildSourceThrottleKey(namespace: string, ip: string): string {
	return `${namespace}|src|${throttleIdentity(ip)}`;
}

/**
 * True when this key is currently locked out (sliding window). `maxAttempts`
 * defaults to the per-IP threshold; the account-global caller passes the higher
 * LOGIN_ACCOUNT_MAX_ATTEMPTS.
 */
export function isThrottled(attemptKey: string, maxAttempts: number = LOGIN_MAX_ATTEMPTS): boolean {
	const windowStart = nowSeconds() - LOGIN_ATTEMPT_WINDOW_SECONDS;
	const row = database
		.query(
			'SELECT COUNT(*) AS attempts, MAX(attempted_at) AS latest FROM login_attempts WHERE attempt_key = ? AND attempted_at > ?',
		)
		.get(attemptKey, windowStart) as { attempts: number; latest: number | null };
	return (
		row.attempts >= maxAttempts &&
		row.latest !== null &&
		row.latest + LOGIN_LOCKOUT_SECONDS > nowSeconds()
	);
}

export function recordFailedAttempt(attemptKey: string): void {
	database
		.query('INSERT INTO login_attempts (attempt_key, attempted_at) VALUES (?, ?)')
		.run(attemptKey, nowSeconds());
	// Opportunistic residue GC (audit S3-46): attempts older than the sliding
	// window + lockout can never influence a throttle decision again, yet the
	// table previously grew forever. One indexed DELETE per failed login is
	// cheap and keeps the store bounded without a background timer.
	database
		.query('DELETE FROM login_attempts WHERE attempted_at < ?')
		.run(nowSeconds() - (LOGIN_ATTEMPT_WINDOW_SECONDS + LOGIN_LOCKOUT_SECONDS));
}

/** Give back the newest attempt of `attemptKey` (a reserved slot whose action
 * delivered nothing). No-op when the key has no attempt. */
export function releaseAttempt(attemptKey: string): void {
	database
		.query(
			'DELETE FROM login_attempts WHERE rowid = (SELECT rowid FROM login_attempts WHERE attempt_key = ? ORDER BY attempted_at DESC LIMIT 1)',
		)
		.run(attemptKey);
}

/**
 * Drop every session-store row that can no longer affect a decision: expired
 * sessions, spent login-attempt buckets, expired password resets.
 *
 * Each writer already GCs its own table opportunistically on insert; this is the
 * same work reachable by name, so the retention registry can state a rule for
 * this store instead of it being an undocumented side effect of writing to it
 * (core/retention/prune.ts, `session_store`).
 *
 * `apply:false` COUNTS with the same predicates and deletes nothing; `apply:true`
 * removes. Sessions are expired by the store's real law (idle OR absolute — see
 * pruneExpiredSessionsDetail), never by a second predicate written here.
 */
export function purgeExpiredSessionState(options: { apply: boolean } = { apply: true }): {
	candidates: number;
	deleted: number;
} {
	const now = nowSeconds();
	const attemptCutoff = now - (LOGIN_ATTEMPT_WINDOW_SECONDS + LOGIN_LOCKOUT_SECONDS);
	if (!options.apply) {
		// A DRY RUN EXECUTES THE SAME PREDICATES, on purpose: a counted-but-never-run
		// statement is exactly how a prune that cannot execute stayed green (the
		// `sessions` table has no `expires` column — session expiry is idle OR
		// absolute, see pruneExpiredSessionsDetail). The retention gate calls every
		// registered prune dry, so the SQL has to run for it to prove anything.
		const idleCutoff = now - SESSION_TTL_SECONDS;
		const ageCutoff = SESSION_ABSOLUTE_TTL_SECONDS > 0 ? now - SESSION_ABSOLUTE_TTL_SECONDS : 0;
		const candidates =
			countRows('SELECT COUNT(*) AS n FROM sessions WHERE last_seen < ? OR created_at < ?', [
				idleCutoff,
				ageCutoff,
			]) +
			countRows('SELECT COUNT(*) AS n FROM login_attempts WHERE attempted_at < ?', [
				attemptCutoff,
			]) +
			countRows('SELECT COUNT(*) AS n FROM password_resets WHERE expires < ?', [now]);
		return { candidates, deleted: 0 };
	}
	// Sessions go through the ONE session-expiry door (both clocks, and it unlinks
	// the media marker before the row) — never a second, divergent predicate here.
	const sessions = pruneExpiredSessionsDetail().pruned;
	const attempts = database
		.query('DELETE FROM login_attempts WHERE attempted_at < ? RETURNING attempt_key')
		.all(attemptCutoff) as unknown[];
	const resets = database
		.query('DELETE FROM password_resets WHERE expires < ? RETURNING reset_key')
		.all(now) as unknown[];
	const removed = sessions + attempts.length + resets.length;
	return { candidates: removed, deleted: removed };
}

/** One COUNT(*) — the dry-run half of the purge, so the branch above stays one decision. */
function countRows(statement: string, binds: (number | string)[]): number {
	const row = database.query(statement).get(...binds) as { n: number } | null;
	return row?.n ?? 0;
}

/** Successful login unlocks immediately (PHP behavior). */
export function clearAttempts(attemptKey: string): void {
	database.query('DELETE FROM login_attempts WHERE attempt_key = ?').run(attemptKey);
}

// ---------------------------------------------------------------------------
// Password-recovery entries (security/password_reset.ts) — the TS analog of
// PHP's DEDALO_CACHE/dd_password_reset/<sha1(reset_id)>.json file store. The
// row key is sha256(reset_id), never the raw id, so a leaked DB file cannot be
// replayed against confirm(); code_hash is an Argon2id digest of the 8-digit
// code — the plaintext code exists only in the recovery email.
// ---------------------------------------------------------------------------

export interface PasswordResetEntry {
	userId: number;
	codeHash: string;
	expires: number;
	attempts: number;
}

/** Persist a pending reset (replacing any prior entry for the same reset_id). */
export function storePasswordReset(
	resetId: string,
	userId: number,
	codeHash: string,
	ttlSeconds: number,
): void {
	database
		.query(
			`INSERT OR REPLACE INTO password_resets (reset_key, user_id, code_hash, expires, attempts)
			 VALUES (?, ?, ?, ?, 0)`,
		)
		.run(sha256Hex(resetId), userId, codeHash, nowSeconds() + ttlSeconds);
	// Opportunistic GC (same pattern as recordFailedAttempt): expired entries can
	// never verify again, so drop them here rather than with a background timer.
	database.query('DELETE FROM password_resets WHERE expires < ?').run(nowSeconds());
}

export function loadPasswordReset(resetId: string): PasswordResetEntry | null {
	const row = database
		.query('SELECT user_id, code_hash, expires, attempts FROM password_resets WHERE reset_key = ?')
		.get(sha256Hex(resetId)) as {
		user_id: number;
		code_hash: string;
		expires: number;
		attempts: number;
	} | null;
	if (row === null) return null;
	return {
		userId: row.user_id,
		codeHash: row.code_hash,
		expires: row.expires,
		attempts: row.attempts,
	};
}

/** Bump the wrong-guess counter; returns the new count (0 when the entry vanished). */
export function incrementPasswordResetAttempts(resetId: string): number {
	const key = sha256Hex(resetId);
	database.query('UPDATE password_resets SET attempts = attempts + 1 WHERE reset_key = ?').run(key);
	const row = database
		.query('SELECT attempts FROM password_resets WHERE reset_key = ?')
		.get(key) as { attempts: number } | null;
	return row?.attempts ?? 0;
}

export function deletePasswordReset(resetId: string): void {
	database.query('DELETE FROM password_resets WHERE reset_key = ?').run(sha256Hex(resetId));
}

/**
 * SEC-15 — drop every pending recovery code of ONE account, by user.
 *
 * A code in flight is a live credential for the account: it rewrites the password
 * without proving anything but possession of the mailbox. Nothing deleted these rows on
 * a deactivation, a deletion or a competing password change, so the standard operator
 * response to a compromise ("deactivate the account") left a code that still worked for
 * the rest of its TTL. `user_id` is a plain column here precisely so a by-account delete
 * is possible; nothing used it until the revocation seam.
 *
 * Returns the number of rows removed (the seam logs it — an operator revoking a
 * compromised account wants to see that a code was in flight).
 */
export function deleteUserPasswordResets(userId: number): number {
	const rows = database
		.query('DELETE FROM password_resets WHERE user_id = ? RETURNING reset_key')
		.all(userId) as unknown[];
	return rows.length;
}

/**
 * Test hook: age one session's clocks so the EXPIRY branches of `getSession` can be
 * exercised without sleeping past the configured TTL. Same S1-18 guard as the wipe
 * below — it may only touch a store opened at the DEDALO_SESSION_DB_PATH override, so a
 * stray call can never rewrite live session state.
 */
export function ageSessionForTests(
	rawToken: string,
	ages: { lastSeenSecondsAgo?: number; createdSecondsAgo?: number },
): void {
	assertTestSessionStore('ageSessionForTests');
	const now = nowSeconds();
	if (ages.lastSeenSecondsAgo !== undefined) {
		database
			.query('UPDATE sessions SET last_seen = ? WHERE token_hash = ?')
			.run(now - ages.lastSeenSecondsAgo, sha256Hex(rawToken));
	}
	if (ages.createdSecondsAgo !== undefined) {
		database
			.query('UPDATE sessions SET created_at = ? WHERE token_hash = ?')
			.run(now - ages.createdSecondsAgo, sha256Hex(rawToken));
	}
}

/** The S1-18 guard shared by every test-only mutator here (see resetSessionStoreForTests). */
function assertTestSessionStore(caller: string): void {
	const override = readEnv('DEDALO_SESSION_DB_PATH');
	if (
		override === undefined ||
		resolve(sessionDbPath) !== resolve(override) ||
		resolve(sessionDbPath) === resolve(LIVE_SESSION_DB_PATH)
	) {
		throw new DedaloError('internal.invariant', {
			message: `${caller} refused: the open session store ('${sessionDbPath}') is not the DEDALO_SESSION_DB_PATH test override — mutating it would touch live sessions (S1-18). Run under the bunfig [test] preload.`,
		});
	}
}

/** Test hook: wipe volatile state (sessions + attempts). */
export function resetSessionStoreForTests(): void {
	// S1-18 guard: this wipes both tables, and the open store may be the LIVE
	// ../private file. Refuse unless the store was opened at the explicit
	// DEDALO_SESSION_DB_PATH test override — re-read at call time (inside the
	// shared predicate) so a mutated/unset environment cannot leave a stale pass.
	assertTestSessionStore('resetSessionStoreForTests');
	database.exec('DELETE FROM sessions; DELETE FROM login_attempts; DELETE FROM password_resets;');
}

/**
 * Prune dead sessions (the TS analog of PHP session-file GC).
 *
 * BOTH clocks, or the GC leaks: getSession rejects a session that breaches EITHER
 * the idle window or the absolute cap, but this swept only `last_seen`. A session
 * kept warm by a polling client past the absolute cap was therefore rejected on
 * every request and never deleted — a row that can only grow in number, and the
 * exact population the cap exists to remove.
 */
export function pruneExpiredSessions(): number {
	return pruneExpiredSessionsDetail().pruned;
}

/** The same prune, reporting the media keys it freed (see destroyUserSessionsDetail). */
export function pruneExpiredSessionsDetail(): { pruned: number; mediaKeys: string[] } {
	const now = Math.floor(Date.now() / 1000);
	const idleCutoff = now - SESSION_TTL_SECONDS;
	const ageCutoff = SESSION_ABSOLUTE_TTL_SECONDS > 0 ? now - SESSION_ABSOLUTE_TTL_SECONDS : 0;
	const rows = database
		.query('SELECT token_hash, media_key FROM sessions WHERE last_seen < ? OR created_at < ?')
		.all(idleCutoff, ageCutoff) as SessionRowKey[];
	// Marker first, row second, and the DELETE addresses exactly the rows this SELECT
	// read — a session touched between the two statements is still ended, rather than
	// surviving with a credential that was already unlinked.
	const { removed, mediaKeys } = endSessionRows(rows);
	return { pruned: removed, mediaKeys };
}
