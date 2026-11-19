/**
 * Authentication — login against the SHARED user records (matrix_users,
 * section dd128) with Argon2id verification, new-native session issuance
 * (spec §7.2; session mechanics in session_store.ts).
 *
 * User data contract (verified on the live DB):
 *   matrix_users.string = { "dd132":[{value: username}], "dd133":[{value: password_hash}], … }
 *   root user is section_id -1 and carries an $argon2id$ hash.
 *
 * Guarantees carried over from PHP login (class.login.php):
 * - Argon2id verify (Bun.password — native, same algorithm);
 * - sliding-window brute-force throttle, reset on success;
 * - ambiguous failure message + no user-existence disclosure;
 * - session rotation on login (a fresh token is always issued);
 * - the dd131 'Active account' refusal (2026-08-28, SEC-07) — ONE measured divergence
 *   from the frozen PHP (a MISSING datum logs in; PHP refused it) plus the root
 *   exemption, which is PARITY (class.login.php:1086 returns true for section_id -1).
 *   Both are argued in full at `isRefusedForInactivity` and at the root branch in
 *   `login()`, and recorded as
 *   `engineering/wire_contract/WC-2026-08-28-login-active-account.md`.
 *
 * REFUSED, loudly (never silently): a stored password that is not Argon2id —
 * above all v6's reversible AES values, still present on an account nobody
 * migrated. Login never verifies one: that needs the v6 key material
 * (DEDALO_INFORMATION / DEDALO_INFO_KEY), which v7 deliberately does not carry,
 * and the PHP engine's rehash-on-next-login is RETIRED
 * (engineering/wire_contract/WC-2026-11-19-legacy-aes-lazy-rehash-retired.md).
 * The operator runs `bun run dedalo:migrate-passwords` once
 * (scripts/migrate_v6_passwords.ts); the boot counts the accounts still waiting
 * (countLegacyPasswordAccounts → update/boot_state.ts). SAML is Phase 5
 * continuation.
 */

import { config } from '../../config/config.ts';
import { sql } from '../db/postgres.ts';
import { ARGON2_OPTIONS, needsPasswordRehash } from './argon2_params.ts';
import { MIGRATE_PASSWORDS_COMMAND } from './password_hash.ts';
import { resolvePrincipal } from './permissions.ts';
import { runWithoutAccountRevocation } from './revocation.ts';
import { endUserSessions } from './session_media.ts';
import {
	buildAccountThrottleKey,
	buildSourceThrottleKey,
	buildThrottleKey,
	clearAttempts,
	createSession,
	isThrottled,
	LOGIN_ACCOUNT_MAX_ATTEMPTS,
	LOGIN_SOURCE_MAX_ATTEMPTS,
	recordFailedAttempt,
} from './session_store.ts';

const USERS_SECTION_TIPO = 'dd128';
const USERNAME_COMPONENT = 'dd132';
const PASSWORD_COMPONENT = 'dd133';
/**
 * component_radio_button dd131, 'Active account'. Its first locator points at the
 * yes/no list dd64: entry 1 = 'Yes'/'Sí', entry 2 = 'No' (read out of
 * `matrix_dd.string.dd62` on the suite DB — this is the fact the whole rule hangs on,
 * so it was measured, not assumed).
 */
const ACTIVE_ACCOUNT_COMPONENT = 'dd131';
/** dd64 list entry that means ACTIVE. Anything else present is a refusal. */
const ACTIVE_ACCOUNT_YES_ID = 1;

/**
 * The WHERE tipo every login/logout activity row carries (PHP
 * login::get_login_tipo — "fixed because never changes").
 */
export const LOGIN_ACTIVITY_TIPO = 'dd229';

/**
 * Append the 'LOG IN' activity row (dd42 code 1). PHP logs BOTH outcomes —
 * a denied attempt is the security-relevant one, and it carries the attempted
 * username so an operator can see who is being probed.
 *
 * The actor is ANONYMOUS_USER_ID on every failure, including a wrong password
 * for a real account: PHP passes logged_user_id(), and nobody is logged in yet
 * at that point. The username lives in the payload instead.
 *
 * DIVERGENCE (recorded): PHP's success payload also carries `browser`
 * ($_SERVER['HTTP_USER_AGENT']) and `DB-backup`. The TS request path does not
 * carry a user-agent at all, so we omit both rather than fake them.
 */
async function logLoginActivity(
	outcome: 'allow' | 'deny',
	cause: string,
	username: string,
	clientIp: string,
	userId?: number,
): Promise<void> {
	const { logActivity, hostFromClientIp, ANONYMOUS_USER_ID } = await import(
		'../api/handlers/activity_log.ts'
	);
	const actor = userId ?? ANONYMOUS_USER_ID;
	await logActivity({
		what: 'LOG IN',
		tipo: LOGIN_ACTIVITY_TIPO,
		userId: actor,
		host: hostFromClientIp(clientIp),
		data: {
			// THE UNTRUSTED STRING IS STORED ONCE (audit 2026-08-26 SEC-21;
			// WC-2026-09-05-preauth-intake-bounds). It used to appear in `msg` AND
			// in `username`, so every denial — including a THROTTLED one, which by
			// definition refuses the login and used to pay the storage anyway —
			// wrote the caller's own bytes to the audit trail twice over. `username`
			// is the field that MEANS it; the sentence now says what happened.
			msg:
				outcome === 'allow'
					? `User ${actor} is logged. Hello ${username}`
					: `Denied login. ${cause}`,
			result: outcome,
			cause,
			username,
		},
	});
}

/**
 * Rewrite one user's stored password at the CURRENT cost, after they proved they know it —
 * when, and only when, the stored cost is below target.
 *
 * Through `saveComponentData` — the one write door — so the row lock, the Argon2 hashing
 * gate and the TM audit row all apply exactly as they do to any other password change.
 * The plaintext is handed over, not a hash: hashing is that door's job (`password_hash`),
 * and duplicating it here would be a second place where the cost is decided.
 *
 * Best-effort by construction. It runs off the login's critical path and swallows its own
 * failures: a full disk or a locked row must not turn a correct password into a failed
 * login. The account simply keeps its old hash and is retried at the next login.
 */
async function rehashStoredPassword(
	userId: number,
	storedHash: string,
	plaintext: string,
): Promise<void> {
	// The PREDICATE lives here, not at the call site: login is already the most
	// branch-dense function in this module, and "should this be upgraded" is this
	// function's own question, not a decision its caller has to carry.
	if (!needsPasswordRehash(storedHash)) return;
	try {
		const { saveComponentData } = await import('../section/record/save_component.ts');
		// NOT AN ACCOUNT TRANSITION (P1-4). A dd133 write fires the revocation seam,
		// which ends every session of the account — and this rewrite carries the SAME
		// plaintext the user proved they knew a millisecond ago, on the login path,
		// racing the `createSession` below it. Unsuppressed it would intermittently
		// destroy the session the login is in the middle of issuing: a correct password
		// that sometimes does not log you in. ALS-scoped, so the suppression is
		// request-local and cannot bleed into a concurrent, genuine password change.
		const result = await runWithoutAccountRevocation('login password cost upgrade', () =>
			saveComponentData({
				componentTipo: PASSWORD_COMPONENT,
				sectionTipo: USERS_SECTION_TIPO,
				sectionId: userId,
				lang: 'lg-nolan',
				changedData: [
					{ action: 'set_data', value: [{ id: 1, value: plaintext, lang: 'lg-nolan' }] },
				],
				userId,
			}),
		);
		if (!result.ok) {
			console.error(
				`[auth] password cost upgrade failed for user_id=${String(userId)}: ${result.message}`,
			);
		}
	} catch (error) {
		console.error(`[auth] password cost upgrade threw for user_id=${String(userId)}:`, error);
	}
}

/** Ambiguous by design — never reveals whether the user exists. */
export const LOGIN_FAILED_MESSAGE = 'User does not exist or password is invalid';

/**
 * Memoized Argon2id decoy hash (AUTHZ-03). Login previously returned FAST on the
 * no-user / legacy-hash paths (no crypto) but spent an Argon2id verify for an
 * existing user — a measurable timing side-channel that enumerates usernames
 * despite the ambiguous message. We run a real verify against this decoy on the
 * failure paths so every login costs ~one Argon2id regardless of whether the
 * account exists. (Online guessing rate is bounded by the two-dimension throttle,
 * which already exceeds PHP's per-connection sleep — so no fixed sleep is added.)
 *
 * COST-MATCHED, deliberately: it is built from ARGON2_OPTIONS like every other hash,
 * because `Bun.password.verify` costs what the STORED hash declares. If the decoy were
 * cheaper or dearer than a real one, the failure path would be distinguishable again by
 * exactly the difference.
 *
 * KNOWN, BOUNDED, SELF-CLOSING WINDOW (2026-08-24): raising t=2 → t=3 means an account
 * that has not logged in since the upgrade still verifies at the OLD cost, ~25 ms below
 * this decoy — a weak residual signal that such an account exists. It is far below the
 * ~70 ms-vs-0 ms gap AUTHZ-03 closed, it is bounded by the same throttle, and it closes
 * per account at that account's next login (the rehash above). Recorded rather than
 * papered over; pinning the decoy to the old cost instead would simply invert the sign
 * of the same signal for every already-upgraded account.
 */
let decoyHashPromise: Promise<string> | null = null;
function decoyHash(): Promise<string> {
	if (decoyHashPromise === null) {
		decoyHashPromise = Bun.password.hash(crypto.randomUUID(), ARGON2_OPTIONS);
	}
	return decoyHashPromise;
}
/** Spend one Argon2id verify against the decoy to normalize failure-path timing.
 * Exported for security/password_reset.ts, which applies the same AUTHZ-03
 * posture to its anti-enumeration no-op paths (in place of PHP's sleep(2)). */
export async function normalizeTiming(password: string): Promise<void> {
	try {
		await Bun.password.verify(password, await decoyHash());
	} catch {
		// never throws in practice; a decoy failure must not change the outcome
	}
}

export interface LoginResult {
	ok: boolean;
	message: string;
	/** Raw session token (cookie value) on success. */
	sessionToken?: string;
	userId?: number;
	/**
	 * The 128-hex media-auth cookie value (Rule A — core/media/protection.ts). Present
	 * only when media protection is enabled; absent means the mode is false and no media
	 * cookie should be set.
	 */
	mediaAuthCookieValue?: string;
}

/**
 * How the account's dd131 'Active account' flag reads, for the ONE row login resolved.
 *
 *  'active'   — the datum is present and points at dd64/1.
 *  'inactive' — the datum is present and points at anything else (dd64/2 = 'No').
 *  'missing'  — no dd131 datum at all, or an empty array. See the rule at the gate.
 */
export type ActiveAccountState = 'active' | 'inactive' | 'missing';

/**
 * Find a user row by exact username (jsonb containment — indexed, parameterized).
 *
 * `relation` is read in the SAME select as `string`, deliberately: a SECOND lookup for
 * the flag could check one row's flag and verify another row's hash on an install with a
 * duplicated username. dd132 declares `unique`, but `duplicate_record.ts` bypasses
 * `saveComponentData` and therefore the unique check, so duplicates are reachable — and
 * this query has no ORDER BY (a deliberate difference from password_reset's
 * USER_ROW_SELECT, which needs determinism because it resolves ALL matches).
 */
async function findUserByUsername(username: string): Promise<{
	section_id: number;
	passwordHash: string | null;
	activeAccount: ActiveAccountState;
} | null> {
	const rows = (await sql.unsafe(
		`SELECT section_id, string, relation FROM matrix_users
		 WHERE section_tipo = $1
		   AND string->$2 @> $3::text::jsonb
		 LIMIT 1`,
		[USERS_SECTION_TIPO, USERNAME_COMPONENT, JSON.stringify([{ value: username }])],
	)) as {
		section_id: number;
		string: Record<string, { value?: string }[]> | null;
		relation: Record<string, { section_id?: unknown }[] | undefined> | null;
	}[];
	const row = rows[0];
	if (row === undefined) return null;
	return {
		section_id: row.section_id,
		passwordHash: row.string?.[PASSWORD_COMPONENT]?.[0]?.value ?? null,
		activeAccount: readActiveAccountState(row.relation?.[ACTIVE_ACCOUNT_COMPONENT]),
	};
}

/**
 * How many accounts hold a stored password that is NOT an Argon2id hash — the
 * accounts `login()` refuses as legacy (above all v6's reversible AES values,
 * which `bun run dedalo:migrate-passwords` converts). An account with no
 * password at all is not one of them. Read at boot for the operator's notice
 * (update/boot_state.ts refreshLegacyPasswordNotice): they should learn of a
 * locked-out user base from the log, not from the first user who cannot get in.
 */
export async function countLegacyPasswordAccounts(): Promise<number> {
	const rows = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM matrix_users
		 WHERE section_tipo = $1
		   AND COALESCE(string->$2->0->>'value', '') <> ''
		   AND string->$2->0->>'value' NOT LIKE '$argon2%'`,
		[USERS_SECTION_TIPO, PASSWORD_COMPONENT],
	)) as { n: number }[];
	return Number(rows[0]?.n ?? 0);
}

/**
 * THE dd131 STATE OF ONE ACCOUNT, BY ID — for the surfaces that hold a user id rather
 * than a username, and that outlive a single request.
 *
 * `login()` reads this state on the way in, which is enough for a session-bearing door:
 * ending the account's sessions is what makes a deactivation take effect there. It is
 * NOT enough for a process that resolves an identity once and keeps serving under it —
 * the MCP stdio server is exactly that — because such a process holds no session for a
 * revocation to end. Those surfaces re-ask, per call, here.
 *
 * `'absent'` means no such dd128 record: a DELETED account, which every caller must
 * treat at least as strictly as `'inactive'`.
 */
export async function readAccountStateById(userId: number): Promise<ActiveAccountState | 'absent'> {
	const rows = (await sql.unsafe(
		`SELECT relation FROM matrix_users WHERE section_tipo = $1 AND section_id = $2 LIMIT 1`,
		[USERS_SECTION_TIPO, userId],
	)) as { relation: Record<string, { section_id?: unknown }[] | undefined> | null }[];
	const row = rows[0];
	if (row === undefined) return 'absent';
	return readActiveAccountState(row.relation?.[ACTIVE_ACCOUNT_COMPONENT]);
}

/**
 * The dd131 locator -> {missing|active|inactive}. KEPT UNION on section_id
 * (WC-2026-08-10-section-id-int-canonical): an unswept install stores the locator
 * target as the string '1'.
 */
function readActiveAccountState(
	activeItems: { section_id?: unknown }[] | undefined,
): ActiveAccountState {
	const first = Array.isArray(activeItems) ? activeItems[0] : undefined;
	if (first === undefined || first === null) return 'missing';
	return Number(first.section_id) === ACTIVE_ACCOUNT_YES_ID ? 'active' : 'inactive';
}

/**
 * MISSING dd131 IS TREATED AS ACTIVE, AND THAT IS A MEASURED DECISION — not laziness.
 *
 * The frozen PHP refused a missing datum too (class.login.php:1102-1104 —
 * `empty($active_account_data)` returns false), and copying it looks like the safe move. It is not: it is a
 * total lockout generator for every account this engine has created since the cutover.
 * The shipped `dd131` ontology node carries no `properties.dato_default`,
 * `record_defaults.ts` seeds only `dato_default`, the client radio has no preselect,
 * dd131 is not `mandatory`, and NOTHING in `src/` writes dd131 — so every user created
 * through the TS engine is born with the datum ABSENT. "Missing = inactive" would lock
 * out zero existing records and every future one, silently, with no message explaining
 * why. A login outage in a museum is not a smaller harm than a stale session.
 *
 * MEASURED 2026-08-28, three corpora, read-only: suite DB `dedalo_v7_mht_test` 1 dd128
 * record (root, dd131 = Yes); the shipped install seed exactly one user (root, dd131 =
 * Yes); the live install `dedalo_v7_mht` 24 records — 8 Yes, 16 No, **0 absent, 0
 * empty**; the pinned monedaiberica snapshot 75 records — 37 Yes, 38 No, **0 absent, 0
 * empty**. So the PRESENT-and-No half revokes 54 already-intended deactivations across
 * the two installs and locks out **zero accounts that can log in today** (none of those
 * 54 carries an Argon2 hash, and `auth.ts` already refuses a non-Argon2 hash). The
 * MISSING half would have locked out zero existing records — and every one created since.
 *
 * The safe order, of which this ships steps 1 and 4a (the rest are OPEN, and each is a
 * file outside this change's scope):
 *   1. refuse a PRESENT dd131 pointing anywhere but dd64/1  ← SHIPPED HERE
 *   2. give the shipped dd131 ontology node `properties.dato_default` = dd64/1, so a
 *      created user is born Active through the one chokepoint (record_defaults.ts) —
 *      covering every door at once  ← OPEN (install seed + ontology)
 *   3. a one-shot boot migration stamping dd131 = Yes on every dd128 record with
 *      section_id > 0 and no dd131 datum, logging the count and the usernames  ← OPEN
 *   4a. name every missing datum LOUDLY at login  ← SHIPPED HERE
 *   4b. only after 2 and 3, treat missing as inactive  ← OPEN, and it must not ship
 *       before them.
 * Recorded as `engineering/wire_contract/WC-2026-08-28-login-active-account.md`.
 */
function isRefusedForInactivity(state: ActiveAccountState): boolean {
	return state === 'inactive';
}

/**
 * Once-per-process census of dd128 records with no dd131 datum — the population step 3
 * above has to stamp, and the number step 4b would lock out. Fired the first time a
 * login meets a missing datum, so an install that has none never pays for the query.
 */
let missingActiveAccountCensusDone = false;
function warnMissingActiveAccountDatum(username: string, userId: number): void {
	console.error(
		`auth: user '${username}' (user_id=${String(userId)}) has NO dd131 'Active account' datum. Login is ALLOWED — treating a missing datum as inactive would lock out every account this engine has created (the shipped dd131 node has no dato_default). Stamp dd131 = Yes on this record; see engineering/wire_contract/WC-2026-08-28-login-active-account.md.`,
	);
	if (missingActiveAccountCensusDone) return;
	missingActiveAccountCensusDone = true;
	void (async () => {
		try {
			const rows = (await sql.unsafe(
				`SELECT count(*) AS absent FROM matrix_users
				 WHERE section_tipo = $1
				   AND section_id > 0
				   AND (NOT (relation ? $2) OR jsonb_array_length(coalesce(relation->$2, '[]'::jsonb)) = 0)`,
				[USERS_SECTION_TIPO, ACTIVE_ACCOUNT_COMPONENT],
			)) as { absent: number | string }[];
			console.error(
				`auth: ${String(rows[0]?.absent ?? '?')} user record(s) on this installation carry no dd131 'Active account' datum. They are not UN-deactivatable — an operator deactivates one by CREATING the datum as No, and the refusal then applies immediately like any other — but the flag cannot be flipped on a form field that renders empty, so in practice nobody discovers the control. Stamp them Yes and the deactivation path becomes a one-click flip.`,
			);
		} catch (error) {
			console.error('auth: could not count dd131-less user records:', error);
		}
	})();
}

/**
 * EVERY REFUSAL THAT PRECEDES THE PASSWORD VERIFY, in one place: the two throttle
 * dimensions, the unknown account, and the legacy pre-Argon2 hash.
 *
 * Extracted from `login()` for readability and to keep that function under the
 * complexity ratchet, NOT to change it: the order, the ambiguous message, the activity
 * rows and — critically — the AUTHZ-03 timing normalization on both non-verifying paths
 * are byte-for-byte what they were. A caller must treat `user === null` as "return the
 * refusal verbatim"; there is no third outcome.
 */
async function resolveLoginCandidate(
	request: {
		username: string;
		password: string;
		clientIp: string;
		throttleKey: string;
		accountKey: string;
		sourceKey: string;
	},
	recordFailure: () => void,
): Promise<
	| { user: null; refusal: LoginResult }
	| { user: { section_id: number; passwordHash: string; activeAccount: ActiveAccountState } }
> {
	const { username, password, clientIp, throttleKey, accountKey, sourceKey } = request;
	const refusal = { user: null, refusal: { ok: false, message: LOGIN_FAILED_MESSAGE } } as const;

	if (
		isThrottled(throttleKey) ||
		isThrottled(accountKey, LOGIN_ACCOUNT_MAX_ATTEMPTS) ||
		isThrottled(sourceKey, LOGIN_SOURCE_MAX_ATTEMPTS)
	) {
		// Same ambiguous message: lockout must not confirm the account exists.
		// (No PHP twin — v6 had no throttle. Logged anyway: a lockout is exactly
		// the event an operator reviewing the audit trail wants to see.)
		await logLoginActivity('deny', 'Too many failed attempts (throttled)', username, clientIp);
		return refusal;
	}

	const user = await findUserByUsername(username);
	if (user === null || user.passwordHash === null) {
		await normalizeTiming(password); // AUTHZ-03: match the existing-user Argon2id cost
		recordFailure();
		await logLoginActivity('deny', 'User does not exist', username, clientIp);
		return refusal;
	}

	if (!user.passwordHash.startsWith('$argon2')) {
		// A v6 password value — refused (see module header). Deny loudly in the
		// server log, naming the fix; ambiguously on the wire.
		console.error(
			`auth: user '${username}' still has a legacy (pre-Argon2) password value and cannot log in — run \`${MIGRATE_PASSWORDS_COMMAND}\` against this database (docs/install/migrating_from_v6.md, "Migrate the passwords").`,
		);
		await normalizeTiming(password); // AUTHZ-03: no fast-path timing tell
		recordFailure();
		await logLoginActivity('deny', 'Legacy (pre-Argon2) password hash', username, clientIp);
		return refusal;
	}

	return { user: { ...user, passwordHash: user.passwordHash } };
}

/**
 * SHOUT about the two dd131 states that are ALLOWED but should not be silent.
 *
 * The users section has carried a component_radio_button 'Active account' since v5, and
 * the frozen PHP refused an inactive one at login in two places; the TS login consulted
 * NOTHING. The flag was honoured by exactly one non-test file — the password RECOVERY
 * path — so an operator could deactivate an account, watch recovery honour it, and the
 * account kept logging in. The refusal itself is one line in `login()`, AFTER the
 * password verify (deliberately: a deactivated account must not be distinguishable from
 * a wrong password by an unauthenticated prober, so it costs the same Argon2id verify
 * and returns the same ambiguous sentence). What is left here are the two states that
 * pass:
 *
 * ROOT (-1) IS EXEMPT, AND SO IS THE FROZEN PHP'S — this half is PARITY, not a
 * divergence. `login::active_account_check()` opens with
 * `if( (int)$section_id===-1 ){ return true; }`
 * (v7_php_frozen/master_dedalo/core/login/class.login.php:1086-1088, read 2026-08-28).
 * An earlier revision of this comment, and of the WC entry, claimed PHP had no root
 * carve-out. That was wrong, and wrong in the direction that makes an engine look bolder
 * than it is. The reason PHP had it is the reason to keep it: root is the install's
 * recovery identity, and if a single mis-click on root's radio could refuse root's
 * login, the recovery story for a museum is "restore a backup". Measured: root ships Yes
 * in the install seed and IS Yes at both installs read for this change. It is also
 * unreachable-by-escalation: no door writes root's dd131 — the record-lifecycle doors
 * refuse a non-positive section_id ahead of the admin bypass, and the ONE exception (an
 * account editing its OWN record) covers only the four self-editable components, of
 * which dd131 is not one.
 *
 * A MISSING datum is allowed and shouted — see `isRefusedForInactivity`.
 */
function announceActiveAccountState(
	sectionId: number,
	state: ActiveAccountState,
	username: string,
): void {
	if (sectionId === -1) {
		if (isRefusedForInactivity(state)) {
			console.error(
				"auth: the ROOT user record (dd128/-1) is marked dd131 'Active account' = No. Root is EXEMPT from the deactivation refusal on purpose — refusing it would lock this installation out of itself with no in-engine recovery. Fix the flag on the record.",
			);
		}
		return;
	}
	if (state === 'missing') warnMissingActiveAccountDatum(username, sectionId);
}

/**
 * Authenticate and open a session. `clientIp` feeds the throttle key — the
 * HTTP layer passes the proxy-validated address.
 */
export async function login(
	username: string,
	password: string,
	clientIp: string,
): Promise<LoginResult> {
	// THREE throttle dimensions: per-(username, IP), account-global (IP-independent
	// — a spoofed X-Forwarded-For rotation cannot evade it) and SOURCE-GLOBAL
	// (username-independent). The third exists because the first two both start
	// from the username, so a caller ROTATING usernames minted a fresh bucket on
	// both at every request and the throttle bounded guessing but not VOLUME
	// (audit 2026-08-26 SEC-21). A lockout on ANY of them refuses, with the same
	// ambiguous message.
	const throttleKey = buildThrottleKey('login', username, clientIp);
	const accountKey = buildAccountThrottleKey('login', username);
	const sourceKey = buildSourceThrottleKey('login', clientIp);
	const recordFailure = (): void => {
		recordFailedAttempt(throttleKey);
		recordFailedAttempt(accountKey);
		recordFailedAttempt(sourceKey);
	};
	const candidate = await resolveLoginCandidate(
		{ username, password, clientIp, throttleKey, accountKey, sourceKey },
		recordFailure,
	);
	if (candidate.user === null) return candidate.refusal;
	const user = candidate.user;

	const verified = await Bun.password.verify(password, user.passwordHash);
	if (!verified) {
		recordFailure();
		await logLoginActivity('deny', 'wrong password', username, clientIp);
		return { ok: false, message: LOGIN_FAILED_MESSAGE };
	}

	clearAttempts(throttleKey);
	clearAttempts(accountKey);

	// ACTIVE ACCOUNT (SEC-07, P1-4) — the whole rule, and the reason for every branch
	// in it, lives in `refuseInactiveAccount` below.
	if (isRefusedForInactivity(user.activeAccount) && user.section_id !== -1) {
		await logLoginActivity('deny', 'Account is not active (dd131)', username, clientIp);
		return { ok: false, message: LOGIN_FAILED_MESSAGE };
	}
	announceActiveAccountState(user.section_id, user.activeAccount, username);

	// COST UPGRADE (P2-7, 2026-08-24). A stored hash carries the parameters it was
	// made with, forever: `isArgon2Hash` passes any `$argon2…` string through
	// untouched, so before this there was no path by which an old, weaker hash could
	// ever become a current one — the cost of a heritage archive's credentials was
	// frozen at whatever the runtime chose on the day each account was created.
	//
	// The one moment the plaintext exists is a successful verify, so that is where the
	// upgrade has to happen. UPGRADE-ONLY (see needsPasswordRehash): a PHP-era hash at
	// m=65536,t=4 is stronger than the target and must never be rewritten downwards.
	//
	// Started INSIDE the request and not awaited: the ALS request context
	// (principal, language) is captured at call time, which a truly detached call
	// would lose — and a login must not wait on, or fail because of, a write to a
	// credential the user has just proved they know.
	void rehashStoredPassword(user.section_id, user.passwordHash, password);

	// MAINTENANCE MODE (TS-native server state): only the superuser may log
	// in while the flag is set (the TS analog of PHP's
	// DEDALO_MAINTENANCE_MODE_CUSTOM config_core override).
	if (user.section_id !== -1) {
		const { getServerState } = await import('../resolve/server_state.ts');
		if (getServerState().maintenance_mode === true) {
			// Credentials were CORRECT — the refusal is the maintenance gate, and
			// the audit row must say so rather than read as a failed attempt.
			await logLoginActivity('deny', 'Server under maintenance', username, clientIp);
			return { ok: false, message: 'Server under maintenance. Please try again later.' };
		}
	}

	// MEDIA ACCESS CONTROL, Rule A (PHP login::init_cookie_auth). Mints THIS SESSION's
	// media credential, lays its marker, and refreshes the generated web-server rules.
	// Returns null when the mode is false — then this is a TOTAL no-op.
	//
	// PER SESSION since 2026-08-24. It used to mint one value per INSTALL per DAY, which
	// is why logout could not revoke it (unlinking the shared marker would have logged
	// every other editor out of the media tree) and why a stolen cookie outlived a
	// password reset by up to ~48 hours. Now the value goes onto the session row below,
	// and ending the session unlinks the marker — see security/session_media.ts.
	//
	// It lives HERE, beside createSession, and not in the login HANDLER, so that no
	// future login door (SAML is a ledgered open item) can ship without it and leave its
	// users 404ing on every media file.
	//
	// It runs BEFORE createSession deliberately: it throws on filesystem failure
	// (CONVENTIONS §1 — a configured gate that cannot be written must not degrade into
	// silently unprotected media), and doing it first means a throw leaves no orphan
	// session behind. Divergence from PHP, recorded: PHP unlinked its cookie store on a
	// rules-write failure — we do NOT. This session's marker is already laid, and there
	// is no longer any shared value whose deletion could revoke media access
	// install-wide over a transient EPERM.
	const { issueSessionMediaKey } = await import('../media/protection.ts');
	const mediaAuthCookieValue = issueSessionMediaKey();

	// GLOBAL-ADMIN SESSION STAMP (PHP login sets $_SESSION['dedalo']['auth']
	// ['is_global_admin'] from security::is_global_admin(), class.security.php
	// :636-690): the superuser (-1) is always admin, everyone else is admin iff
	// their dd244 security-administrator locator points at dd64/1.
	//
	// The stamp is a SNAPSHOT taken at login, exactly like PHP's, and since
	// 2026-09-03 it is NOT AN AUTHORIZATION INPUT: no route reads it (SEC-14 — the
	// two that did resolve the Principal per request through
	// security/session_gate.ts, like every dispatched action). It is kept as the
	// row's descriptive column only (session_store.ts Session.isGlobalAdmin), and
	// resolvePrincipal — the ONE resolver of the grant (permissions.ts) — is what
	// fills it, so it cannot disagree with the Principal at the moment of login.
	const { isGlobalAdmin } = await resolvePrincipal(user.section_id);
	const sessionToken = createSession(
		user.section_id,
		username,
		isGlobalAdmin,
		mediaAuthCookieValue,
	);
	// AUTHZ-04 single-session policy (opt-in, DEDALO_SINGLE_SESSION). When on,
	// evict every OTHER session of this user — a new login invalidates a token
	// stolen earlier, closing the re-login window. Off by default: concurrent
	// multi-device sessions stay allowed. (Password reset revokes all sessions
	// regardless — that path is already covered in password_reset.ts.) Runs AFTER
	// createSession, keeping the token just minted.
	if (config.features.singleSession) {
		// endUserSessions, not destroyUserSessions: an evicted session's MEDIA marker
		// must go with it, or single-session mode would revoke the token while leaving
		// the stolen media cookie working — the precise gap this policy exists to close.
		endUserSessions(user.section_id, sessionToken);
	}
	await logLoginActivity('allow', 'correct user and password', username, clientIp, user.section_id);
	return {
		ok: true,
		message: 'ok',
		sessionToken,
		userId: user.section_id,
		...(mediaAuthCookieValue !== null ? { mediaAuthCookieValue } : {}),
	};
}
