/**
 * THE REVOCATION SEAM — ending an account's access, once, after a COMMIT.
 *
 * Three stores hold a live credential for one account, and until 2026-08-28 they were
 * revoked separately, or not at all:
 *
 *   1. the SESSIONS table — the token the browser replays;
 *   2. the MEDIA MARKER set — a zero-byte file the WEB SERVER stat()s. No engine
 *      process is in the media byte path, so unlinking that marker is the ONLY thing
 *      that can take the `dedalo_media_auth` cookie away; a session ended without its
 *      marker leaves the cookie reading the entire digitised archive;
 *   3. the PENDING RECOVERY CODES — a code in flight rewrites the password on
 *      possession of a mailbox alone, so it outlived every transition meant to stop it.
 *
 * This module owns all three, and it is DELIBERATELY NOT `session_media.ts`: that
 * module is the session↔marker projection (a mechanism), while this one is the
 * authorization event (a policy). Splitting them is also what keeps the import graph
 * acyclic — `permissions.ts` may statically import THIS, and this may lazily reach back
 * into `permissions.ts` for the cache clears, with no static cycle.
 *
 * ── THE LANE (2026-08-28, reviewer must-fix 1) ────────────────────────────────
 *
 * A revocation is DESTRUCTIVE and NON-IDEMPOTENT-IN-INTENT: it deletes session rows,
 * unlinks filesystem markers and burns recovery codes. It therefore rides
 * `registerCommitAction` (postgres.ts) — the COMMIT-ONLY lane — and never
 * `deferPostTransaction`, whose documented contract is idempotent cache invalidation
 * and which replays on ROLLBACK too. The first shape of this seam hung off the cache
 * clear and inherited its lane: a save that ROLLED BACK still logged every session of
 * the account out, so an admin whose password edit FAILED had destroyed the target's
 * sessions anyway, and the audit trail said an edit happened that did not. The observer
 * cascade moved to `registerCommitAction` for exactly this reason (W12).
 *
 * When no transaction is ambient, `registerCommitAction` returns false and the caller
 * owns the action — it runs inline, which is correct: the write already landed and
 * there is nothing left to roll back.
 *
 * ── THE ORDER (reviewer must-fix 2) ───────────────────────────────────────────
 *
 * Every deletion path is MARKER FIRST, ROW SECOND, and that order is enforced one level
 * down, inside `session_store.ts`, so no caller can get it wrong. Reversing it matters
 * because the two stores fail in opposite directions: delete-then-unlink means a crash
 * in between leaves NO session row and a LIVE marker — and the web server never consults
 * the session store, so that cookie keeps read access to the whole digitised archive,
 * permanently, with nothing left to name it. Unlink-then-delete means a crash leaves a
 * session that still works, which the next request, the next logout or the periodic
 * sweep ends properly.
 *
 * ── WHAT IS ALREADY IN FLIGHT (reviewer must-fix 8) ───────────────────────────
 *
 * A request that is already PAST the dispatch boundary COMPLETES WITH THE AUTHORITY IT
 * RESOLVED THERE. This is ACCEPTED, deliberately: the principal and the session flags
 * are read once per request (request_context.ts) so one request cannot see two different
 * answers to "who is this" halfway through a save; re-checking mid-request would mean a
 * transaction that authorized a write at statement 3 and refused it at statement 7,
 * leaving a half-written record. The window is ONE REQUEST long — the next request
 * presents a token whose row is gone and is refused at the door, and the media cookie is
 * already dead because its marker was unlinked before the row.
 *
 * A LONG-RUNNING BACKGROUND JOB IS THE SAME ANSWER WITH A LONGER WINDOW, and it is the
 * honest residual. A detached tool run (tool_propagate_component_data, the importers, a
 * diffusion job) carries the Principal it was launched with for its whole life; revoking
 * its owner mid-run does not stop it, and nothing in this seam pretends otherwise. What
 * DOES stop it is the cooperative cancel every backgroundRunnable action already honours
 * (`ctx.signal`, driven by dd_utils_api::stop_process from the processes panel). So the
 * operator procedure for a compromised account is TWO steps — deactivate the account,
 * then stop that account's running jobs — and it is written down here and in
 * `engineering/wire_contract/WC-2026-08-28-login-active-account.md` rather than left to
 * be discovered.
 *
 * Gates: test/unit/account_revocation_native.test.ts (transitions × survivals, the lane,
 * the order), test/unit/dd128_write_census_tripwire.test.ts (the REACH census: every
 * record-write door either reaches this seam or carries an enumerated PENDING row).
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { deferPostTransaction, registerCommitAction } from '../db/postgres.ts';
import { currentSession } from './request_context.ts';
import { endUserSessionsDetail } from './session_media.ts';
import { deleteUserPasswordResets } from './session_store.ts';

/** dd128 — the users section. Named here so this module imports no ontology layer. */
export const USERS_SECTION_TIPO = 'dd128';
/** dd234 — the profiles section, whose dd774 grants feed the permission caches. */
export const PROFILES_SECTION_TIPO = 'dd234';

/**
 * The dd128 components whose write is an IDENTITY or AUTHORITY transition. Exported so
 * every gate derives its transition matrix from the code instead of restating it (a new
 * trigger cannot be added without a row).
 *
 *  dd131 Active account   — the operator's only non-destructive revocation.
 *  dd132 Username         — the session row carries the username; a rename is a new
 *                           identity, and the old sessions still speak the old one.
 *  dd133 Password         — "this account is compromised, change its password" is the
 *                           standard operator reflex, and it revoked NOTHING.
 *  dd244 Security admin   — the AUTHORITY transition. Since 2026-09-03 no route reads
 *                           the session row's login-time `is_global_admin` stamp any
 *                           more (the two that did — the thesaurus dump download and
 *                           /api/v1/counters — resolve the Principal per request
 *                           through security/session_gate.ts, SEC-14), so a demotion
 *                           reaches every surface on the next request WITHOUT this
 *                           row. It stays a transition on principle: losing global
 *                           administration is the S-6 revocation event, and ending
 *                           the session is the belt for the ONE request already in
 *                           flight with the old authority (see the header) and for
 *                           anything a future reader might snapshot again.
 *
 * DELIBERATELY NOT HERE — dd1725 (profile), dd515 (developer flag) and dd170
 * (projects). Those are re-resolved per request through `resolvePrincipal` /
 * `getPermissionsTable`, whose caches the same reaction drops, so the change takes
 * effect on the next request without logging the person out mid-edit. Ending
 * sessions for those three would be a mass logout every time an administrator
 * adjusts a project assignment — a real harm bought for no revocation.
 *
 * VALUE-BLIND, on purpose: the seam is reached with the coordinates of the write, never
 * its value. So ANY dd131 write revokes, including a flip back to Yes. A redundant
 * revocation costs a re-login; a missed one leaves a live attacker.
 */
export const ACCOUNT_TRANSITION_COMPONENTS: ReadonlySet<string> = new Set([
	'dd131',
	'dd132',
	'dd133',
	'dd244',
]);

/**
 * Suppression scope for a write that is NOT an account transition.
 *
 * ONE caller exists and one must ever exist: the login-time password COST UPGRADE
 * (auth.ts rehashStoredPassword). It rewrites dd133 with the SAME plaintext the user
 * just proved they know, moments before — and on the login path, so without this scope
 * the upgrade would race `createSession` and destroy the session the login is in the
 * middle of issuing. That is a login that intermittently fails after a correct password.
 *
 * ALS, not a module flag: a flag would leak across concurrent requests in this
 * long-lived process (engineering/REQUEST_ISOLATION.md). The scope is read at SCHEDULE
 * time — inside the awaited save, where it is unambiguously in effect — and not only
 * when the queued action runs, so a commit-lane action draining at the edge of the scope
 * cannot escape it.
 */
const revocationSuppression = new AsyncLocalStorage<string>();

/**
 * The reason the ONE sanctioned caller runs under (auth.ts rehashStoredPassword). Named,
 * because root_password_guard.ts admits root's dd133 write under THIS scope only — a
 * second suppression scope, whatever its purpose, does not open root's password.
 */
export const LOGIN_COST_UPGRADE_SCOPE = 'login password cost upgrade';

/** Run `fn` with the revocation seam suppressed; `reason` is logged if it fires. */
export function runWithoutAccountRevocation<T>(reason: string, fn: () => T): T {
	return revocationSuppression.run(reason, fn);
}

/** The reason the current scope suppresses revocation, or undefined. */
export function accountRevocationSuppressedBy(): string | undefined {
	return revocationSuppression.getStore();
}

/** What one revocation actually took away — logged, and asserted by the gate. */
export interface AccountRevocation {
	userId: number;
	/** Sessions deleted (the kept acting session is not counted). */
	sessions: number;
	/** Pending password-reset rows deleted. */
	resets: number;
	/** The token hash kept alive, when the actor revoked their own account. */
	keptTokenHash: string | null;
}

/**
 * END AN ACCOUNT'S ACCESS — the ONE function every account transition reaches.
 *
 * Deactivate, delete, a password change through ANY door and a global-admin demotion all
 * arrive here. It is BEST-EFFORT and never throws: it runs after the write it reacts to
 * is already durable, and a failure to revoke must be shouted in the log rather than
 * turned into a rolled-back edit the operator will simply repeat.
 *
 * SELF PASSWORD CHANGE — THE RULE. The ACTING session survives its own account's
 * transition; every OTHER session of that account dies. Killing the session a curator is
 * using to change their own password is hostile and teaches people not to change
 * passwords; leaving the other sessions alive is precisely the compromise case, because
 * "someone else is logged in as me" is why the password is being changed. The acting
 * session is identified by the request scope's own token hash and only when it belongs
 * to the account being revoked, so an ADMIN changing someone else's password keeps
 * nothing — every session of the target dies, which is the operator reflex the audit
 * found revoking nothing at all.
 *
 * `keepTokenHash` — when given (`null` included) it WINS over the request scope: the
 * commit-lane scheduler resolves the acting session while the scope is live and hands
 * the answer down, because by the time the commit queue drains the scope may be gone.
 */
export function revokeAccountAccess(
	userId: number,
	reason: string,
	options: { keepActingSession?: boolean; keepTokenHash?: string | null } = {},
): AccountRevocation {
	const outcome: AccountRevocation = { userId, sessions: 0, resets: 0, keptTokenHash: null };
	try {
		// A non-integer id addresses no account. The seam is reached from write doors
		// that receive `Number(request.sectionId)`, and the temporal / search-preset
		// doors carry client sentinels that coerce to NaN — a NaN would go straight into
		// a sqlite bind. Refuse it here rather than at every call site.
		if (!Number.isInteger(userId)) return outcome;
		if (accountRevocationSuppressedBy() !== undefined) return outcome;
		const keepTokenHash = resolveKeptTokenHash(userId, options);
		// MARKER FIRST, ROW SECOND — the order is owned by session_media/session_store.
		outcome.sessions = endUserSessionsDetail(userId, keepTokenHash);
		outcome.keptTokenHash = keepTokenHash ?? null;
		outcome.resets = deleteUserPasswordResets(userId);
		reportRevocation(reason, outcome);
	} catch (error) {
		console.error(
			`[revocation] FAILED for user_id=${String(userId)} (${reason}) — the account's sessions, media markers or recovery codes may still be live:`,
			error,
		);
	}
	return outcome;
}

/**
 * WHICH SESSION, IF ANY, SURVIVES — the self-password-change rule in one place.
 *
 * An explicit `keepTokenHash` (`null` included) WINS: the commit-lane scheduler resolves
 * the acting session while the request scope is live and hands the answer down, because
 * by the time the commit queue drains the scope may be gone. Otherwise the acting
 * session is read from the request scope, and kept ONLY when it belongs to the account
 * being revoked — `currentSession()` is undefined outside a request scope (a CLI, timer
 * work) and null inside a job-manager job (its pinned context carries no session,
 * media/jobs.ts JobRunScope — a background import included), and then nothing is kept,
 * which is the safe answer.
 */
function resolveKeptTokenHash(
	userId: number,
	options: { keepActingSession?: boolean; keepTokenHash?: string | null },
): string | undefined {
	if (options.keepTokenHash !== undefined) return options.keepTokenHash ?? undefined;
	if (options.keepActingSession === false) return undefined;
	return actingSessionHashFor(userId);
}

/**
 * The CURRENT request's session token hash, but only when that session belongs to
 * `userId` — the one place "is the actor the account being revoked?" is decided.
 *
 * Undefined outside a request scope (a CLI, timer work), inside a background job (its
 * pinned context's session is null) and for anybody else's account: an ADMIN changing someone else's password keeps nothing.
 */
function actingSessionHashFor(userId: number): string | undefined {
	const acting = currentSession();
	if (acting === null || acting === undefined) return undefined;
	return acting.userId === userId ? acting.tokenHash : undefined;
}

/**
 * Say what was still live. An operator revoking a compromised account must be able to
 * SEE it — never the token, never the code, counts only. Silent when there was nothing
 * to take, so an ordinary edit does not fill the log.
 */
function reportRevocation(reason: string, outcome: AccountRevocation): void {
	if (outcome.sessions === 0 && outcome.resets === 0) return;
	const kept = outcome.keptTokenHash === null ? '' : ', the acting session kept';
	console.warn(
		`[revocation] ${reason}: user_id=${String(outcome.userId)} — ${String(outcome.sessions)} session(s) ended, ${String(outcome.resets)} pending recovery code(s) dropped${kept}.`,
	);
}

/**
 * The RECORD-level twin: a deleted (or emptied) user record ends that account's access.
 *
 * A no-op for any other section, so the delete doors call it unconditionally rather than
 * each re-deciding what a users section is. Deleting a user dropped the security caches
 * and left the session row and its media marker untouched: the token still resolved, and
 * the re-resolved Principal was NOT zero-access.
 */
export function revokeDeletedAccountAccess(
	sectionTipo: string,
	sectionId: number,
	reason: string,
): AccountRevocation | null {
	if (sectionTipo !== USERS_SECTION_TIPO) return null;
	if (!Number.isInteger(sectionId)) return null;
	// A deleted account has no acting session to protect: the record is gone.
	return revokeAccountAccess(sectionId, reason, { keepActingSession: false });
}

/**
 * THE WRITE-DOOR REACTION — cache invalidation AND revocation, on their OWN lanes.
 *
 * Called from the record-write chokepoint (`section_record/record_write.ts`, beside
 * `fireSaveEvent`) with the coordinates of the keys a write just persisted. Everything
 * about which components matter is decided HERE, so a door only has to say what it
 * wrote — which is the point: `persistRecordKeys` called NO invalidation at all, so
 * every account transition written through it (both time-machine restore doors,
 * tool_propagate_component_data, translation, the observer mirror) revoked nothing AND
 * left the security caches stale.
 *
 * TWO LANES, NOT ONE, and that is the whole point of this function:
 *
 *   - the permission-CACHE clears ride `deferPostTransaction`. They are idempotent and
 *     must replay on ROLLBACK too: over-invalidation costs a rebuild, a skipped
 *     invalidation serves a stale grant for the process lifetime (S1-14).
 *   - the REVOCATION rides `registerCommitAction`. It is destructive, it must run once,
 *     and it must not run at all if the write rolled back.
 *
 * The two used to be one call on the cache lane. That is reviewer must-fix 1.
 */
export async function reactToRecordComponentWrite(
	sectionTipo: string,
	sectionId: number,
	componentTipos: readonly string[],
	door: string,
): Promise<void> {
	if (sectionTipo !== USERS_SECTION_TIPO && sectionTipo !== PROFILES_SECTION_TIPO) return;
	if (componentTipos.length === 0) return;
	// De-duplicate: a multi-key write (the audit stamps ride along) can name the same
	// component twice, and a revocation logged twice reads like two events.
	const tipos = [...new Set(componentTipos)];

	// --- lane 1: the security caches (idempotent, replays on ROLLBACK too) ---
	// The import is awaited HERE, not inside the queued action: `deferPostTransaction`
	// requires a SYNCHRONOUS action, and a floating async continuation queued into it
	// would clear the cache at an unspecified moment after the transaction settled.
	// Dynamic ON PURPOSE — `permissions.ts` statically imports THIS module (the second
	// reach, for the locator-removal door), so a static edge back would close an import
	// cycle (import_scc_tripwire); a dynamic edge is lazy and cannot throw at
	// module-evaluation time.
	try {
		// `clearSecurityCachesForWrite`, NOT `invalidatePermissionsForWrite`: the latter
		// also schedules a revocation, and this action rides the lane that REPLAYS ON
		// ROLLBACK. The revocation is scheduled separately, below, on the commit lane.
		const { clearSecurityCachesForWrite } = await import('./permissions.ts');
		const clearCaches = (): void => {
			for (const tipo of tipos) clearSecurityCachesForWrite(sectionTipo, tipo, sectionId);
		};
		if (!deferPostTransaction(clearCaches)) clearCaches();
	} catch (error) {
		console.error(
			`[revocation] security-cache invalidation failed after ${door} on ${sectionTipo}/${String(sectionId)} — a stale grant may be served until the TTL:`,
			error,
		);
	}

	// --- lane 2: the revocation (destructive, COMMIT-ONLY) ---
	scheduleAccountTransitionRevocation(sectionTipo, sectionId, tipos, door);
}

/**
 * The components of this write that ARE account transitions — empty when the write is
 * not one, and empty when the seam is suppressed.
 *
 * The non-integer guard belongs here rather than at four call sites: the seam is reached
 * from write doors that receive `Number(request.sectionId)`, and the temporal /
 * search-preset doors carry client sentinels that coerce to NaN, which would go straight
 * into a sqlite bind.
 */
function accountTransitionTriggers(
	sectionTipo: string,
	sectionId: number,
	componentTipos: readonly string[],
): string[] {
	if (sectionTipo !== USERS_SECTION_TIPO) return [];
	if (!Number.isInteger(sectionId)) return [];
	if (accountRevocationSuppressedBy() !== undefined) return [];
	return componentTipos.filter((tipo) => ACCOUNT_TRANSITION_COMPONENTS.has(tipo));
}

/**
 * Queue the revocation for an account transition on the COMMIT-ONLY lane.
 *
 * The suppression scope and the acting session are read HERE, at schedule time, rather
 * than inside the queued action: both are AsyncLocalStorage reads, and the commit queue
 * drains in `withTransaction`'s finally, OUTSIDE the transaction context. Capturing them
 * at the call site is what makes the answer identical whether the seam runs inline (no
 * ambient transaction) or one tick later on the commit lane.
 */
export function scheduleAccountTransitionRevocation(
	sectionTipo: string,
	sectionId: number,
	componentTipos: readonly string[],
	door: string,
): void {
	const triggers = accountTransitionTriggers(sectionTipo, sectionId, componentTipos);
	if (triggers.length === 0) return;
	// Resolved HERE, while the request scope is live — the same helper the inline path
	// uses, so the two agree by construction rather than by two copies of the rule.
	const keepTokenHash: string | null = actingSessionHashFor(sectionId) ?? null;
	const reason = `${sectionTipo}/${triggers.join('+')} write (${door})`;
	const revoke = (): void => {
		revokeAccountAccess(sectionId, reason, { keepTokenHash });
	};
	if (!registerCommitAction(revoke)) revoke();
}
