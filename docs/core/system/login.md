# login

> See also: [security](security.md) · [component_password](../components/component_password.md) · [Architecture overview](../architecture_overview.md)

The authentication subsystem is Dédalo's entry point: it validates credentials
against the users section and issues a **server-side session** — Argon2id
verification, rotating tokens, a sliding-window throttle and a per-session CSRF
token.

## Role

Authentication lives in **`src/core/security/auth.ts`** (the credential gate) on
top of **`src/core/security/session_store.ts`** (session issuance, storage and
the login throttle). Together they own the **authentication** half of Dédalo's
access control: they turn a username/password into an authenticated
server-side session, and tear that session down on logout.

They are deliberately thin on *what you may do* once you are in: per-element
**authorization** (profiles, projects, integer permissions) lives in
[`permissions.ts`](security.md), which the login path only *touches* to stamp
the admin flag. The split is:

| module | role |
| --- | --- |
| **`security/auth.ts`** | **Authentication** — verify credentials against the shared user records, throttle brute force, open a session, stamp the admin flag. A user record is just a record in the **users section** (`dd128`); `auth.ts` reads its components to authenticate. |
| **`security/session_store.ts`** | **Sessions & throttle** — issue/rotate/expire tokens (bun:sqlite store), mint the per-session CSRF token, keep the sliding-window login-attempt counter. |
| **`security/permissions.ts`** | **Authorization** — given a logged user, resolve the integer permission over any ontology element, the user's projects, and the `isGlobalAdmin` / `isDeveloper` flags. |

!!! warning "The session store holds hashes, not tokens"
    Sessions are rows in a **bun:sqlite** database in the private config
    directory. The cookie (`dedalo_ts_session`) carries a raw random token, and
    only that token's **SHA-256** is stored — so a leaked database file cannot be
    replayed as a live session.

## Responsibilities

- **Authenticate** a username/password pair (`login()` in `auth.ts`), running the
  gate: throttle check → user lookup → Argon2id verification → maintenance-mode
  gate → session issuance.
- **Throttle** brute-force / credential-stuffing attempts, keyed by
  `namespace|lower(username)|ip`, persisted in the sqlite store and shared across
  processes.
- **Build the authenticated session** (`createSession()`): issue a fresh random
  token (session rotation), mint the per-session CSRF token, stamp `userId` /
  `username` / `isGlobalAdmin`.
- **Verify** the current session (`getSession()`) — the dispatcher resolves the
  request cookie to a live session (sliding TTL) on every authenticated call.
- **Log out** (`destroySession()`): delete the session row; the HTTP layer clears
  the cookie.
- **Resolve the login-form context** consumed by the client
  (`buildLoginContext()` in `src/core/api/handlers/login_context.ts`).

## Key concepts

### The session row

A successful login writes a row in the sqlite `sessions` table; the dispatcher
consumes it as a `Session` value:

```ts
interface Session {
    userId: number;          // the user's section_id (root = -1)
    username: string;        // short login name
    isGlobalAdmin: boolean;  // stamped at login (superuser in v0)
    csrfToken: string;       // per-session, constant-time compared
    applicationLang: string | null; // per-session lang override (change_lang)
    dataLang: string | null;         // null ⇒ installation default
    expiresIn?: number;              // seconds left, the lower of the two clocks
    absoluteExpiresIn?: number | null; // seconds left on the cap alone
}
```

The DB stores only the token's SHA-256 (`token_hash` is the primary key), plus
`created_at` / `last_seen`. The session is the single source of truth — there is
no separate token store, and the CSRF token is only ever compared with
`crypto.timingSafeEqual`.

### Two expiry clocks

A session dies at whichever comes first:

| clock | key | default | measured from |
| --- | --- | --- | --- |
| Idle timeout | `SESSION_TTL_SECONDS` | `3600` (1h) | `last_seen`, refreshed by every authenticated request |
| Absolute cap | `SESSION_ABSOLUTE_TTL_SECONDS` | `43200` (12h) | `created_at`, and nothing can postpone it |

`getSession()` enforces both on read, touching `last_seen` (this is what makes
the idle window sliding) and destroying the row when either clock has run out.
`pruneExpiredSessions()` sweeps on **both** as well — a session the reader
rejects but the GC keeps would be a row that never dies.

The idle window alone is not a policy: the client polls in the background, so an
unattended browser renews itself indefinitely. The cap is what actually ends a
working day. Set it to `0` to disable it and keep the idle limit only.

!!! note "Long-running work is not affected"
    Background jobs never re-read the session. A background tool keeps its
    requesting user on the job record (`core/tools/background.ts`) and diffusion
    re-derives the enqueuing principal from `owner_user_id` at run time
    (`diffusion/runner.ts`). A **publication run or a massive import therefore
    survives its owner's logout**, and reattaches to the same user after
    re-login (`listBackgroundJobs` filters by `userId`).

### Expiry as the client sees it

Two mechanisms, in order:

1. **The warning.** The boot payload carries three `page_globals` keys —
   `dedalo_session_ttl_seconds`, `dedalo_session_absolute_expires_in` and
   `dedalo_session_warning_seconds` (`SESSION_WARNING_SECONDS`, default `300`;
   `0` disables). `session_expiry.js` re-arms a local timer from the
   `session_activity` beat that `data_manager` publishes on every authenticated
   response, and warns once the window drops below the threshold. Only the
   *absolute* deadline is sent because it is the only one the client cannot
   re-derive — the idle window restarts on every request.
2. **The recovery.** Once the session is gone, the auth gate answers **401**
   with `errors: ['not_logged']`. The client raises the re-login modal in place
   (`render_relogin`), and a queued save or read is retried once, only when
   `error_dispatch.settle_relogin_attempt` reports `'resume'` — the page's own
   user logged back in — so page state survives. Any other identity latches the
   page (`is_page_identity_revoked()`: no transport sends anything but the
   login actions, so not even a keyboard-triggered delete leaves the page) and
   reloads it. `login_successful` is a notification, never an authorisation to resume. `msg` carries the human text; `errors` carries the token
   every client branch dispatches on.

!!! note "A *re*-login, never a second login"
    The modal opens only on a page that booted **logged in**
    (`page_globals.is_logged`). A page loaded logged out is already showing the
    login form, and overlaying a dimmed copy of it on top made the operator
    enter the credentials twice — which is exactly what happened when the
    activity tray read the server from the login screen. Any caller may
    therefore answer `not_logged` pre-auth without duplicating the form.

!!! warning "`not_logged` is load-bearing on both sides"
    The server must emit that exact token and the client must be able to
    *receive* it: `data_manager` exempts 401 from its retry-wrapper throw, or
    the envelope never reaches `.json()` and the modal never opens. Both halves
    are pinned by `test/unit/session_not_logged_contract.test.ts`.

Media access is bound to the same clock — see
[media protection](media_protection.md).

### The users section is the credential store

There is no bespoke `users` table. A user is a record in the section `dd128`, and
`auth.ts` authenticates by reading its components straight from `matrix_users`:

| datum | tipo | model | read by |
| --- | --- | --- | --- |
| Login name | `dd132` | `component_input_text` | `findUserByUsername()` |
| Password | `dd133` | `component_password` | `login()` (Argon2id verify) |
| Global-admin flag | `dd244` | relation | `resolvePrincipal()` ([security](security.md)) |
| Developer flag | `dd515` | relation | `resolvePrincipal()` |
| Projects (filter master) | `dd170` | `component_filter_master` | `getUserProjects()` |
| Profile select | `dd1725` | relation | `resolveProfileId()` |

User lookup is **not** done through the SQO/search stack. `findUserByUsername()`
issues a direct, parameterised JSONB-containment query against `matrix_users`
(`string->'dd132' @> $3::text::jsonb`, `LIMIT 1`), deliberately without a
`section_id > 0` restriction so the root user (`section_id = -1`) is found. The
value is bound as a parameter (`$3`), never interpolated.

!!! note "root user (`-1`) special cases"
    The super-user (`root`, `section_id = -1`) carries an `$argon2id$` hash, is
    the only account allowed while maintenance mode is set, and is always treated
    as global admin (`resolvePrincipal` short-circuits it to admin+developer).
    The **session row's** `isGlobalAdmin` field is stamped `true` only for `-1`;
    it is informational — per-request authorization identity is resolved fresh
    by `resolvePrincipal(userId)`, which reads the `dd244` admin flag from the
    user record, so flag-based admins are fully recognized regardless of the
    session stamp. Note that root is also the only identity that bypasses the
    permissions matrix; a `dd244` admin resolves per-element levels through
    their profile like any other user (see [security](security.md)).

### Argon2id verification

Verification is `Bun.password.verify(password, hash)`. `auth.ts` refuses any
stored value that does **not** start with `$argon2` — there is no fallback
algorithm and no "try the old scheme" branch.

!!! warning "A v6 account cannot log in until its password is migrated"
    Very old installations stored passwords **reversibly encrypted** rather than
    hashed. Such a value is refused: `auth.ts` denies loudly in the server log
    (naming the account) and ambiguously on the wire.

    These accounts do **not** need to choose a new password. Run
    `scripts/migrate_v6_passwords.ts`, which decrypts each legacy value once,
    re-hashes it with Argon2id, and writes the hash back.

### Brute-force throttle (SEC-019)

Failed attempts are rows in the sqlite `login_attempts` table, keyed by
`buildThrottleKey('login', username, ip)` = `namespace|lower(username)|ip`.
Defaults (env-overridable via `../private/.env`): `LOGIN_MAX_ATTEMPTS` = 10,
`LOGIN_ATTEMPT_WINDOW` = 900s, `LOGIN_LOCKOUT_SECONDS` = 900s. `isThrottled()`
locks the key when the count over the sliding window is reached; a locked login
returns the same **ambiguous** failure message *before* touching the user
lookup, so lockout never confirms the account exists. Only genuine
credential-guess signals feed the counter (wrong password, unknown user, empty
stored password, legacy hash). A confirmed success clears the counter
(`clearAttempts()`).

!!! note "Shared across processes, per node"
    The throttle state is a single sqlite file, so every worker on a node shares
    the counter. Behind a multi-node load balancer the state is still per node.

### Maintenance-mode gate

`login()` blocks any non-superuser while the server state `maintenance_mode` is
set, returning an "under maintenance" message. Only `root` (`-1`) passes.

### Every attempt is audited

`login()` appends a `LOG IN` row to the [activity log](logger.md) on **both**
outcomes, and the `quit` action appends a `LOG OUT` row before it destroys the
session. The WHERE tipo is the fixed `dd229`.

A denial records why — `wrong password`, `User does not exist`, `Legacy
(pre-Argon2) password hash`, `Too many failed attempts (throttled)` or `Server
under maintenance` — together with the attempted username, under the WHO
`ANONYMOUS_USER_ID` (`-666`), because no principal exists yet.

!!! note "The audit is deliberately more specific than the response"
    The response to a failed login is intentionally **ambiguous** so it never
    reveals whether an account exists. The audit row is not: it is readable only
    by operators through the Activity section, and a trail that cannot
    distinguish "unknown user" from "wrong password" cannot tell a typo from a
    credential-stuffing run. Do not copy a `cause` value into a client response.

## The media-auth cookie

A successful login also arms the **media-auth cookie**. `login()` calls
`issueSessionMediaKey()` (`src/core/media/protection.ts`), which mints THIS
SESSION's media credential, lays its marker file and refreshes the generated
web-server rule files; the value is then stored on the session row and
`src/server.ts` sets it alongside the session cookie. Because it belongs to one
session, logging out revokes it — see
[media protection](media_protection.md).

This is what lets the web server authorize a protected-media read with a single
`stat()`, without calling back into the application. The cookie is arranged
**before** the session is issued, so a failure there cannot leave a logged-in user
whose every media file 404s.

See [Media protection](media_protection.md) for the marker store, the cookie
grammar and the generated rule files.

## The session lifecycle

Authentication is done through the module functions; nothing is instantiated.

```ts
// Authenticate (what the dd_utils_api::login dispatch handler calls)
const outcome = await login(username, password, clientIp);
if (outcome.ok) {
    // outcome.sessionToken is the RAW cookie value; the HTTP layer sets it as
    // `dedalo_ts_session=<token>; HttpOnly; SameSite=Lax; Path=/`
    // outcome.userId is the user's section_id
}
```

The full life cycle: `login()` → `createSession()` (session row + CSRF minted) →
… work (each request `getSession()`-resolves the cookie, sliding the TTL) …→
`destroySession()` (logout). Session **rotation on login** is structural: a fresh
token is always issued, so any pre-login token is superseded (the SEC-004
session-fixation guarantee).

## Public API

Grouped by concern. Functions are exported from `auth.ts` and `session_store.ts`
and verified against the source.

### Authentication (`auth.ts`)

| function | purpose |
| --- | --- |
| `login(username, password, clientIp)` | The credential gate. Runs throttle → `findUserByUsername()` → Argon2id verify (`Bun.password.verify`) → maintenance-mode gate → `createSession()`. Returns `{ ok, message, sessionToken?, userId? }`. Every deny path returns the same ambiguous `LOGIN_FAILED_MESSAGE`; the failing signals feed the throttle. |
| `LOGIN_FAILED_MESSAGE` | The single ambiguous message ("User does not exist or password is invalid") — never reveals whether the account exists. |

### Sessions & throttle (`session_store.ts`)

| function | purpose |
| --- | --- |
| `createSession(userId, username, isGlobalAdmin)` | Insert a session row; return the RAW token (cookie value). Mints a per-session CSRF token; stores only the token's SHA-256. |
| `getSession(rawToken)` | Resolve a raw cookie token to a live `Session` (touching `last_seen`); `null` if unknown or past the TTL (self-expiring). |
| `destroySession(rawToken)` | Delete the session row (logout). |
| `verifyCsrf(session, candidate)` | Constant-time CSRF comparison (`crypto.timingSafeEqual`); `false` on empty/length-mismatch. |
| `setSessionLangs(rawToken, {applicationLang?, dataLang?})` | Persist the user's per-session language choice (the `change_lang` handler). |
| `buildThrottleKey(namespace, username, ip)` | The `namespace|lower(username)|ip` throttle key (SEC-019 shape). |
| `isThrottled(key)` / `recordFailedAttempt(key)` / `clearAttempts(key)` | The sliding-window throttle: test lockout, record a failure, clear on success. |
| `pruneExpiredSessions()` | Delete sessions idle past the TTL. |
| `SESSION_COOKIE` | The cookie name constant, `dedalo_ts_session`. |

### The pre-auth language cookie (`dedalo_lang`)

The login form has a language selector, but an anonymous caller has no session
row to store the choice in — so before this cookie existed the form snapped back
to the install default on the reload that follows every switch.

`change_lang` is therefore in `NO_LOGIN_ACTIONS`. With a session it writes
`setSessionLangs()` as always; whenever an APPLICATION language is named it also
returns
`ApiResult.setPreauthLangCookie`, which `src/server.ts` emits as `dedalo_lang`
(HttpOnly, SameSite=Lax, Path=/, `Secure` per `SESSION_COOKIE_SECURE`,
`Max-Age` one year — a preference, not a credential). It carries the
**application** language only, so an anonymous call that names only the data
language is refused (`auth.not_logged`) rather than answering OK and storing
nothing.

The cookie is refreshed by **authenticated** changes too, not only by the login
form. It outlives the session and `login()` adopts it, so a cookie that only the
form could move would reinstate itself over every later in-app choice: pick
Català once on the form, set Deutsch from the menu, log out — and the next login
would come back Catalan with no way to undo it.

On a SHARED browser the cookie carries a preference across users: an
application-language change made in the app is inherited by the next person to
log in there, until they change it themselves. Accepted deliberately — the
alternative makes the login form forget the choice again, which is the bug this
exists to fix.

Precedence when dispatch seeds the request language scope is
`session → cookie → install default`: a logged-in user's session row always
wins. The cookie is caller-controlled input, so it is read back through one
door — `allowlistedPreauthLang()` in `src/core/resolve/request_lang.ts` — and
only if it names a language of this install's `DEDALO_APPLICATION_LANGS` map, so
it never reaches a lang-keyed JSONB path unvalidated. `login()` adopts it onto
the fresh session through that same door (re-applying `DEDALO_DATA_LANG_SYNC`),
so the app opens in the language the form was switched to.

Because the anonymous branch runs before the CSRF gate — the login POST's own
posture — a third-party page can make a browser store a `dedalo_lang`, and
adoption carries it into the victim's next session. Accepted deliberately: the
cookie authorizes nothing, names no record, and the whole effect is labels in the
wrong language until the user picks another. The reasoning is in the divergence
entry.

Divergence entry: `engineering/wire_contract/WC-2026-08-22-preauth-language-cookie.md`.
Gates: `test/unit/change_lang.test.ts`.

### Login-form context (`src/core/api/handlers/login_context.ts`)

| function | purpose |
| --- | --- |
| `buildLoginContext()` | Build the login-form `ddo` (`type:'login', tipo:'dd229', model:'login'`): the ontology children of `dd229` (`login_items`) plus an `info` block (entity, code/build/data/ontology versions). Served pre-auth by the `get_login_context` / `start` handlers so the form renders before any session exists. |

## How it fits with the rest of Dédalo

- **API surface.** Clients never call `auth.ts` directly; they hit the API
  dispatcher (`src/core/api/dispatch.ts`). The `dd_utils_api` registry exposes
  `get_login_context`, `login`, `quit` and `change_lang`; `dd_core_api.start`
  serves the login element context when unauthenticated. The `login` handler maps
  the wire `{username, auth}` to `login(username, auth, clientIp)` and, on
  success, returns the envelope with the fresh session's `csrf_token`, its
  `user_id` and the account's `user_image` — the URL of the user's own image
  (users-section `component_image`, `dd522`), or `null` when the account has
  none, which the login panel shows in its loading circle; the `quit` handler
  calls `destroySession()` and clears the cookie. The client model is the copied
  `core/login/js/login.js`.
- **The dispatch gates.** `dispatchRqo()` runs three gates per request:
  (1) the action must be in the `ACTION_REGISTRY` allowlist; (2) a session is
  required unless the action is in `NO_LOGIN_ACTIONS` (`login`,
  `get_environment`, `start`, `get_login_context`, `change_lang` — the login
  panel's own language selector, see below); (3) CSRF is verified
  (`verifyCsrf`) for every authenticated, non-exempt action — read and count are
  **not** exempt. A CSRF failure (`auth.csrf_failed`) carries the session's
  current token and, beside it, its owner `session_user_id` (every token on the
  wire does). The client's single transparent retry runs only when that owner is
  the page's own user: a session replaced by another user's login (in another
  tab or window) is never adopted — the page latches and reloads, as after a
  refused re-login.
- **Authorization.** `login()` stamps `isGlobalAdmin` into the session;
  [`permissions.ts`](security.md) then decides per-element access.
  `resolvePrincipal(userId)` reads the admin/developer flags back for the current
  user. An unauthenticated request never reaches a permission check — the auth
  gate rejects it first, which is the structural "not logged ⇒ 0".
- **Credentials.** Hashing and the credential lifecycle are owned by
  [`component_password`](../components/component_password.md); verification here
  is `Bun.password.verify` against the stored Argon2id hash.
- **Media protection.** A successful login arms the media-auth cookie — see
  [Media protection](media_protection.md).

```mermaid
flowchart TB
    JS["client login.js"] -->|"action:'login' {username, auth}"| API["dd_utils_api login handler"]
    API --> L["login() (auth.ts)"]
    L -->|verify| PW["Bun.password.verify (Argon2id)"]
    L -->|throttle| TH["session_store: isThrottled / recordFailedAttempt"]
    L -->|admin flag| SEC["security (isGlobalAdmin)"]
    L --> CS["createSession() → sqlite sessions row + CSRF"]
    CS -->|raw token| CK["Set-Cookie: dedalo_ts_session=... (HttpOnly, SameSite=Lax)"]
```

**Prose description of the diagram above:** The client posts `action:'login'` to
the `dd_utils_api` login handler, which calls `login()` in `auth.ts`. That runs
the throttle check, verifies the password with `Bun.password.verify` (Argon2id),
resolves the admin flag, and calls `createSession()` — inserting a row in the
sqlite `sessions` store (with a per-session CSRF token) and returning the raw
token. The HTTP layer sets it as the `HttpOnly; SameSite=Lax` `dedalo_ts_session`
cookie.

## Examples

### Guard an API action

```ts
// The dispatcher's gate 2 already rejected unauthenticated requests, so a
// handler for a non-NO_LOGIN action can rely on context.session being non-null:
const principal = context.principal ?? (await resolvePrincipal(context.session.userId));
```

### Authenticate and open a session

```ts
const outcome = await login('render', plaintext, clientIp);
if (!outcome.ok) {
    // outcome.message is the ambiguous LOGIN_FAILED_MESSAGE on any deny
    return { status: 200, body: { result: false, msg: outcome.message } };
}
// success: outcome.sessionToken → the dedalo_ts_session cookie
```

### Log out

```ts
if (context.sessionToken) destroySession(context.sessionToken);
// the HTTP layer clears the cookie:
//   Set-Cookie: dedalo_ts_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0
```

## Related

- [security](security.md) — authorization: profiles, projects, integer
  permissions, `isGlobalAdmin` / `isDeveloper`.
- [component_password](../components/component_password.md) — the credential
  field: Argon2id hashing, masked reads, `verify_password()`.
- [component_security_access](../components/component_security_access.md) — the
  per-profile permission grid resolved after login.
- [Architecture overview](../architecture_overview.md) — the request lifecycle
  and the dispatch gates this login path sits in front of.
