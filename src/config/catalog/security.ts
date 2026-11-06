/**
 * CONFIG CATALOG — domain: security
 *
 * GENERATED SCAFFOLD (probe_emit_catalog.ts). Hand-edit from here on.
 */

import type { CatalogEntry } from '../catalog_types.ts';

export const SECURITY_KEYS = {
	DEDALO_AR_EXCLUDE_COMPONENTS: {
		type: 'string_list',
		scope: 'operator',
		default: [],
		heading: 'Defining exclude components',
		typeLabel: 'array',
		doc: `This parameter defines components to be excluded.

Some installations need to block the global access to specific components, use this param to remove the components adding the tipo into the array.

\`\`\`bash
DEDALO_AR_EXCLUDE_COMPONENTS=[]
\`\`\``,
	},
	DEDALO_CORS_ALLOWED_ORIGINS: {
		type: 'string_list',
		scope: 'operator',
		default: [],
		heading: 'Cross-origin API callers (CORS)',
		typeLabel: 'array',
		doc: `Origins allowed to call this server's JSON API from a **browser** on another origin.

Empty (the default) means **no CORS headers are sent at all** and the browser blocks every
cross-origin call — the safe default, and the behaviour of every install that does not set this.

The one workflow that needs it is a Dédalo acting as an **ontology master**
(\`IS_AN_ONTOLOGY_SERVER=true\`): the update panel on the *client* Dédalo fetches
\`get_ontology_update_info\` from the master **directly from the browser**
(\`client/dedalo/core/area_maintenance/widgets/update_ontology/js/render_update_ontology.js\`),
so the master must name the client origins here. The master's **Serve Ontology** maintenance
panel shows whether this key (and the other two serving keys) is set. The server-to-server probe
(\`checkRemoteServer\`) is unaffected — it is a Bun \`fetch\`, and CORS is a browser rule.

An entry is matched as an **exact, case-sensitive origin string** — scheme + host + port, no
path, no trailing slash, no partial wildcards. \`https://a.example.org\` does not match
\`https://a.example.org:443\` or \`http://a.example.org\`.

Only a listed origin is echoed back in \`Access-Control-Allow-Origin\`; \`*\` is never sent on
the wire, and neither is \`Access-Control-Allow-Credentials\` — the client calls cross-origin
with \`credentials: 'same-origin'\` (\`data_manager.js\`), and the session cookie is
\`SameSite=Lax\`, so no cookie ever rides one of these requests whatever the calling page asks
for. A cross-origin caller is therefore ALWAYS unauthenticated and reaches only what the
API opens to an anonymous request; listing an origin does not grant it a session.

\`\`\`bash
DEDALO_CORS_ALLOWED_ORIGINS=["https://archive.example.org","https://museum.example.org"]
\`\`\`

**A PUBLIC ontology master sets the single entry \`*\`, meaning any origin.** It is the only
way to express a master that serves its manifest to installations you do not know in advance:
that set of client origins is unbounded, so it cannot be enumerated. \`*\` is a whole-list
sentinel, not a pattern — it simply wins over any other entry, and there is no
\`*.example.org\` form, because a suffix rule is the classic CORS bypass. The request origin
is still what gets echoed back, so \`Vary: Origin\` keeps meaning what it says.

What \`*\` changes is **who may ASK**: from "any HTTP client" — already true today, since CORS
is a browser rule and not a firewall — to "any HTTP client, plus any web page in a visitor's
browser". The surface it opens is the anonymous one \`curl\` already reaches: the update
manifest and the reachability probe (still behind an access code listed in the server's
\`ONTOLOGY_SERVERS\`, which every client presents), plus login and password reset, which are throttled per client address
(\`LOGIN_MAX_ATTEMPTS\`) — note that a page running in a visitor's browser spends the
VISITOR's address against that throttle. Nothing authenticated is reachable either way, on
any setting. Use \`*\` on a deliberately public master; on an ordinary installation, name the
origins.

\`\`\`bash
# public ontology master (IS_AN_ONTOLOGY_SERVER=true) serving unknown clients
DEDALO_CORS_ALLOWED_ORIGINS=["*"]
\`\`\``,
	},
	DEDALO_LOCK_COMPONENTS: {
		type: 'boolean',
		scope: 'operator',
		default: true,
		heading: 'Defining lock components',
		typeLabel: 'bool',
		doc: `This parameter defines if Dédalo will lock / unlock components to avoid replacement data when more than one user edit the same component or Dédalo do not manage the user edition unlocking all components. By default Dédalo do not manage the editions (option false).

\`\`\`bash
DEDALO_LOCK_COMPONENTS=false
\`\`\``,
	},
	DEDALO_MEDIA_ACCESS_MODE: {
		type: 'string',
		scope: 'operator',
		default: 'publication',
		heading: 'Defining protect media files for external access',
		typeLabel: 'false | string',
		doc: `This parameter defines if the directory of the media files (av, images, pdf, subtitles, ...) will be protected and controlled for undesired/external access. The full documentation, with the architecture, use cases, web server configuration and examples, is in [Media protection (media file access control)](./media_protection.md).

* \`'publication'\` (**default**) : logged-in users access everything; anonymous users access only media of published records in the configured public quality folders (see \`DEDALO_MEDIA_PUBLIC_QUALITIES\`)
* \`'private'\` : only logged-in Dédalo users can access media files
* \`false\` : no protection — media files are world-readable

**The default is fail-closed, and that is deliberate.** Until 2026-08-24 an install that
configured nothing served its whole media tree — unpublished records, master-quality
originals, rights-restricted material — to anyone who could guess a URL. \`'publication'\`
rather than \`'private'\` because on an install with no publications the two behave
identically, while \`'private'\` would later 404 the archive's own published site the day
diffusion writes its first marker.

Setting \`false\` is still a real choice and is honoured — an operator who deliberately
serves an open media tree said so. What is no longer honoured is silence.

**nginx installs must reload** after this takes effect (\`nginx -t && nginx -s reload\`);
the Apache \`.htaccess\` applies immediately. See the maintenance widget, which reports it.

\`\`\`bash
DEDALO_MEDIA_ACCESS_MODE=publication
\`\`\``,
	},
	DEDALO_MEDIA_PUBLIC_QUALITIES: {
		type: 'string_list',
		scope: 'operator',
		default: undefined,
		heading: 'Defining protect media files for external access',
		typeLabel: 'string[]',
		typeSuffix: '(optional)',
		doc: `The quality folders an **anonymous** visitor may read when the record is published (rule B).
A JSON array, or a comma-separated list. Leave it unset to derive the delivery-grade folders
from this installation's own quality catalog — \`av/404\`, \`av/posterframe\`, \`av/subtitles\`,
\`image/1.5MB\`, \`image/thumb\`, \`image/web\`, \`pdf/web\`, \`svg/web\`, \`3d/web\`.

\`image/web\` holds the images inserted into rich text from the editor. Each is named after the
record whose text it was inserted into, so it is public exactly while that record is published.
Images inserted before this naming have no record in their name and stay visible to logged-in
users only. If you set this list yourself, add \`image/web\` to it, or rich-text images stay
private.

Master and working qualities (\`original\`, \`modified\`) are **always refused, even if you list
them**: they are the source files, they are the large ones, and they are never public. A
refused entry is dropped and logged; it never silently becomes public and never aborts the boot.

\`\`\`bash
# publish the larger image derivative too, and keep thumbnails private
DEDALO_MEDIA_PUBLIC_QUALITIES=["image/1.5MB","av/404","av/subtitles"]
\`\`\``,
	},
	DEDALO_NAT64_PREFIXES: {
		type: 'string_list',
		scope: 'operator',
		default: [],
		heading: 'Declaring the NAT64 prefixes of an IPv6-only host',
		typeLabel: 'array',
		doc: `Only for a server on an **IPv6-only network that reaches the IPv4 internet through a
NAT64 translator using its own network-specific prefix** (RFC 6052). Leave it empty
everywhere else — that is almost every installation.

Whenever the server fetches a URL on a user's behalf (an RDF import, a catalogue lookup,
a translation or transcription service, a harvest), it first checks that the address is on
the public internet. Behind a NAT64 translator an IPv6 address *inside the translator's
prefix* actually reaches the IPv4 address embedded in it — so with a provider prefix such
as \`2001:db8:64::/96\`, the address \`2001:db8:64::a9fe:a9fe\` is really \`169.254.169.254\`,
the cloud metadata endpoint, although it looks like an ordinary public IPv6 address.
Declaring the prefix here makes the check judge every address inside it by the IPv4
address it carries.

The well-known prefix \`64:ff9b::/96\` is always understood and needs no entry. The engine
also asks the network itself (the RFC 7050 \`ipv4only.arpa\` lookup) and uses what it
learns, but only to refuse MORE: an answer from a resolver is not your word, so a prefix it
reports never makes an otherwise-refused address acceptable. If your translator's prefix
is taken from the local-use block \`64:ff9b:1::/48\` or from a unique-local range such as
\`fd00::/8\` — those are the RANGES it comes from, not entries to copy — sites on the IPv4
internet are reachable only once you declare the translator's OWN prefix here, for example
\`64:ff9b:1::/96\`.

Each entry is the translator's prefix exactly as it is configured, of length 32, 40, 48, 56,
64 or 96 — the only lengths RFC 6052 defines (most translators use /96). Declare the length
the translator uses: the length decides which bytes carry the IPv4 address, so a /48 entry
for a /96 translator reads the wrong bytes and every IPv4 site it reaches is refused. An
entry of any other length (\`fd00::/8\` is one) is refused loudly: until it is fixed,
**every IPv6 destination is refused**, because the check can no longer tell which of them
lead into IPv4.

\`\`\`bash
DEDALO_NAT64_PREFIXES=2001:db8:64::/96
\`\`\``,
	},
	DEDALO_NOTIFICATIONS: {
		type: 'boolean',
		scope: 'operator',
		default: false,
		heading: 'Defining lock components notifications',
		typeLabel: 'bool',
		doc: `This parameter defines if Dédalo will notify to the user than other users are editing the same field in the same section when the user try to edit the field.

\`\`\`bash
DEDALO_NOTIFICATIONS=false
\`\`\``,
	},
	DEDALO_PROTECT_MEDIA_FILES: {
		type: 'boolean',
		scope: 'operator',
		default: false,
		heading: 'Defining protect media files for external access',
		typeLabel: 'bool',
		typeSuffix: '(deprecated)',
		doc: `The legacy boolean is kept for back-compat: \`true\` behaves as \`DEDALO_MEDIA_ACCESS_MODE='private'\` when the new constant is not defined.

\`\`\`bash
DEDALO_PROTECT_MEDIA_FILES=false
\`\`\`

!!! note "The mode can also be set at runtime"
    The root user can change the mode from the **media_control** maintenance widget. That
    override is stored in \`<private>/ts_state.json\` and **wins over this key**, taking effect
    with no restart. If editing \`.env\` appears to do nothing, the widget reports the effective
    mode and where it came from.`,
	},
	DEDALO_SESSION_CACHE_EXPIRE: {
		type: 'number',
		scope: 'operator',
		default: 180,
		heading: 'Defining the upload session cache expiry',
		typeLabel: 'int',
		doc: `The lifetime, **in minutes**, that the upload service announces for a queued upload
session. The engine reports it with the rest of the system information, and the upload
panel displays it, so a user knows how long files that were uploaded but not yet saved
into a record remain available in the temporary upload directory.

Default \`180\` (3 hours). This value is what the interface announces — it does not by
itself prune the temporary upload directory, so keep it in step with whatever
housekeeping runs over \`DEDALO_UPLOAD_TMP_SUBDIR\`.

\`\`\`bash
DEDALO_SESSION_CACHE_EXPIRE=180
\`\`\``,
	},
	DEDALO_SESSION_DB_PATH: {
		type: 'string',
		scope: 'test_seam',
		default: undefined,
		heading: 'Session store path (test seam — not an administrator setting)',
		typeLabel: 'string',
		doc: `**Do not set this.** Sessions and the login-throttle counters live in a small SQLite
database that always sits at \`dedalo_ts_sessions.sqlite\` inside the private directory.

This key redirects the whole process at a scratch file, so the test suite never opens —
or wipes — the live store; the suite sets it for itself. On a real installation it must
stay unset.`,
	},
	DEDALO_SINGLE_SESSION: {
		type: 'boolean',
		scope: 'operator',
		default: false,
		heading: 'Defining single-session (one active session per user)',
		typeLabel: 'bool',
		doc: `Restricts each user to ONE active session. When \`true\`, a successful login evicts every
other session that user already holds (keeping only the one just created) — so logging in
again anywhere immediately invalidates a token stolen earlier, closing the re-login window
(security finding AUTHZ-04). A password reset already revokes all of a user's sessions
regardless of this flag; this key extends that guarantee to ordinary re-login.

Default \`false\`: concurrent sessions are allowed, so the same user can stay logged in on
several devices at once. Set it \`true\` for a stricter, single-device policy — at the cost
that a new login logs the user out everywhere else.

\`\`\`bash
DEDALO_SINGLE_SESSION=false
\`\`\``,
	},
	LOGIN_ACCOUNT_MAX_ATTEMPTS: {
		type: 'number',
		scope: 'operator',
		default: 50,
		heading: 'Defining the account-wide login attempt limit',
		typeLabel: 'int',
		doc: `The second dimension of the login throttle: how many failed logins one **user name**
may accumulate inside \`LOGIN_ATTEMPT_WINDOW\` **from any address at all**, before that
account is locked for \`LOGIN_LOCKOUT_SECONDS\`. It is what stops an attacker who rotates
addresses (every new address gets a fresh per-address bucket, but they all share this one).

It is deliberately much higher than \`LOGIN_MAX_ATTEMPTS\` (default \`50\` against \`10\`),
and it should stay that way: a low account-wide limit lets anyone lock a colleague out of
their own account with a burst of wrong passwords — a denial of service you inflict on
yourself. Set it very high to effectively disable this dimension and rely on the
per-address limit alone.

\`\`\`bash
LOGIN_ACCOUNT_MAX_ATTEMPTS=50
\`\`\``,
	},
	LOGIN_SOURCE_MAX_ATTEMPTS: {
		type: 'number',
		scope: 'operator',
		default: 100,
		heading: 'Defining the source-wide login attempt limit',
		typeLabel: 'int',
		doc: `The third dimension of the login throttle: how many failed logins one **address**
may accumulate inside \`LOGIN_ATTEMPT_WINDOW\` **whatever user name they name**, before
that address is refused for \`LOGIN_LOCKOUT_SECONDS\`.

The other two dimensions both start from the user name, so a caller who ROTATES the name
got a fresh bucket on both at every request: they bounded guessing against an account and
did nothing at all about VOLUME from one source — which is how one unauthenticated client
could keep the engine writing denial rows for as long as it liked (audit 2026-08-26
SEC-21).

It is a FLOOD ceiling, not a guessing ceiling: it must never refuse a shared address doing
ordinary work — a museum behind one NAT, a reading room, a proxy. Raise it if a large
institution shares one address; at the default, that many failed logins from one address
inside the window is not a person mistyping a password.

\`\`\`bash
LOGIN_SOURCE_MAX_ATTEMPTS=100
\`\`\``,
	},
	LOGIN_ATTEMPT_WINDOW: {
		type: 'number',
		scope: 'operator',
		default: 900,
		heading: 'Defining the login attempt window',
		typeLabel: 'int',
		doc: `The sliding window, **in seconds**, over which failed logins are counted for both
throttle limits (\`LOGIN_MAX_ATTEMPTS\` and \`LOGIN_ACCOUNT_MAX_ATTEMPTS\`). A failure
older than the window no longer counts against anyone, and is deleted from the store
once it can no longer influence a decision.

Default \`900\` (15 minutes). A longer window makes the throttle stricter — failures
spread over a slow, patient attack still add up.

\`\`\`bash
LOGIN_ATTEMPT_WINDOW=900
\`\`\``,
	},
	LOGIN_LOCKOUT_SECONDS: {
		type: 'number',
		scope: 'operator',
		default: 900,
		heading: 'Defining the login lockout time',
		typeLabel: 'int',
		doc: `How long, **in seconds**, a login stays refused once a throttle limit has been reached.
The lock lifts this long after the most recent counted failure; a successful login clears
the counters immediately, so a user who finally remembers the password is not kept waiting.

Default \`900\` (15 minutes). Raising it slows a brute-force attempt further; lowering it
mostly buys convenience for people who mistype.

\`\`\`bash
LOGIN_LOCKOUT_SECONDS=900
\`\`\``,
	},
	LOGIN_MAX_ATTEMPTS: {
		type: 'number',
		scope: 'operator',
		default: 10,
		heading: 'Defining the login attempt limit per address',
		typeLabel: 'int',
		doc: `How many failed logins the same user name may accumulate **from the same client
address** inside \`LOGIN_ATTEMPT_WINDOW\` before further attempts are refused for
\`LOGIN_LOCKOUT_SECONDS\`. A successful login clears the counter at once.

Default \`10\` — room for a run of typos, nowhere near enough for a password-guessing
attack. Note that the client address is taken from the trusted reverse-proxy hop
(\`TRUSTED_PROXY_HOPS\`): if that number is wrong, every request looks like it comes from
your proxy and one user's mistakes will lock out everybody.

\`\`\`bash
LOGIN_MAX_ATTEMPTS=10
\`\`\``,
	},
	MEDIA_HTACCESS_ADDONS: {
		type: 'json_array',
		scope: 'operator',
		default: [],
		heading: 'Defining protect media files for external access',
		typeLabel: 'string[]',
		typeSuffix: '(optional, Apache only)',
		doc: `Raw Apache rewrite directives appended to the generated \`.htaccess\` immediately before the
final deny rule. You own their syntax; Dédalo only places them.

The value is **JSON only** — a directive legitimately contains commas (\`[R=404,L]\`), so a
comma-separated list would tear one directive into two invalid ones. That means **every
backslash must be doubled** for JSON. A malformed value is refused and logged
(\`[config] MEDIA_HTACCESS_ADDONS must be a JSON array of strings — ignoring the value.\`);
your lines are dropped, and the access gate itself is unaffected and stays closed.

\`\`\`bash
# allow an internal network unconditionally (note the doubled backslashes)
MEDIA_HTACCESS_ADDONS=["RewriteCond %{REMOTE_ADDR} ^10\\\\.0\\\\.","RewriteRule ^ - [L]"]
\`\`\``,
	},
	PERMISSIONS_CACHE_TTL_SECONDS: {
		type: 'number',
		scope: 'operator',
		default: 300,
		heading: 'Defining the permissions cache lifetime',
		typeLabel: 'int',
		doc: `Each user's permission table — the grants their profile gives them over sections and
components — is resolved from the database once and then kept in memory. Saving a profile
or changing a user's profile drops the cached table immediately, so a grant change is
normally visible on the next request.

This key is the **backstop**, in seconds: it caps how long a *missed* invalidation can
keep serving stale permissions. A grant changed by a different process (a second engine
instance, a background worker) cannot reach this process's memory, and the time limit is
what eventually corrects it. Default \`300\` (5 minutes). Lower it if several processes
share one database and you want a tighter bound; set \`0\` to disable the time limit and
rely on explicit invalidation alone.

\`\`\`bash
PERMISSIONS_CACHE_TTL_SECONDS=300
\`\`\``,
	},
	SESSION_ABSOLUTE_TTL_SECONDS: {
		type: 'number',
		scope: 'operator',
		default: 43200,
		heading: 'Defining the absolute session lifetime',
		typeLabel: 'int',
		doc: `The hard ceiling, in seconds, on a session's life **counted from the moment it was
created** — regardless of how active it has been. It exists because an idle limit alone
(\`SESSION_TTL_SECONDS\`) never expires a session that is used at least once per window:
a stolen cookie would live forever, and a browser left open on a workstation renews itself
indefinitely through the client's own background polling.

Default \`43200\` (12 hours): a session spans one working day and then dies on its own,
whatever the user was doing. Set \`0\` to disable the absolute cap and keep the idle limit
only — NOT recommended, that is the "lives forever" case above.

Long-running work is NOT affected. A background import keeps its requesting user on the
job record and never re-reads the session (\`core/tools/background.ts\`), and diffusion
re-derives the enqueuing principal from \`owner_user_id\` at run time (\`diffusion/runner.ts\`,
DIFF-01), so publication and massive imports survive their owner's logout by construction.

\`\`\`bash
SESSION_ABSOLUTE_TTL_SECONDS=43200
\`\`\``,
	},
	SESSION_COOKIE_SECURE: {
		type: 'boolean',
		scope: 'operator',
		default: true,
		heading: 'Defining the Secure flag of the session cookie',
		typeLabel: 'bool',
		doc: `Marks the session cookie \`Secure\`, so the browser only ever sends it back over HTTPS
(the media access cookie carries the same posture). It is \`true\` by default and it should
stay \`true\` on anything reachable over a network: a session cookie that travels once in
clear text is a session an eavesdropper can replay.

Only the exact value \`false\` turns it off. The single legitimate reason is a plain-HTTP
development listener on localhost — a browser silently discards a \`Secure\` cookie over
\`http://\`, so login there appears to succeed and then does nothing. Never set it on a
server that anyone else can reach; terminate TLS at the web server instead.

The installer writes it to match the listener it sets up: \`true\` over HTTPS, \`false\` on
a developer install that serves plain HTTP (\`--tls none\`).

\`\`\`bash
SESSION_COOKIE_SECURE=true
\`\`\``,
	},
	SESSION_TTL_SECONDS: {
		type: 'number',
		scope: 'operator',
		default: 3600,
		heading: 'Defining the session idle timeout',
		typeLabel: 'int',
		doc: `How long, in seconds, a session survives **without being used**. Every authenticated
request refreshes it; a session left untouched for longer than this is destroyed and the
user must log in again.

Default \`3600\` (1 hour): an unattended browser is the real threat, and an hour of no
requests at all means nobody is there. The separate \`SESSION_ABSOLUTE_TTL_SECONDS\` caps
the total life of a session that is being used continuously.

This value also bounds the media access cookie: \`dedalo_media_auth\` is re-issued with
this same \`Max-Age\` on every authenticated request, so the media credential can never
outlive the session that earned it (\`core/media/protection.ts\`).

\`\`\`bash
SESSION_TTL_SECONDS=3600
\`\`\``,
	},
	SESSION_WARNING_SECONDS: {
		type: 'number',
		scope: 'operator',
		default: 300,
		heading: 'Defining the pre-expiry warning window',
		typeLabel: 'int',
		doc: `How many seconds before a session expires the client warns the user, so unsaved work
can be committed (or the session extended — any request extends it) instead of the next
click failing. Every authenticated response carries \`session_expires_in\`; the client
warns once that value drops below this threshold.

Default \`300\` (5 minutes). Set \`0\` to disable the warning: expiry then surfaces only
through the re-login modal, which the client already raises on the \`not_logged\` error.

\`\`\`bash
SESSION_WARNING_SECONDS=300
\`\`\``,
	},
} as const satisfies Record<string, CatalogEntry>;
