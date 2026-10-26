# MEDIA PROTECTION — web-server-enforced media access control

> **ADDENDUM 2026-08-24 (paths verified — read this before the rest).** Unlike its
> sibling media/diffusion specs, nothing this spec names has moved: every module
> and gate path below was swept and resolves as written —
> `src/core/media/protection.ts`, `src/diffusion/targets/mediastore/media_index.ts`,
> `test/unit/media_protection_tripwire.test.ts`,
> `test/unit/media_fallback_listener.test.ts`. Body text is current, not historical.
> Date is the date of the sweep.

**What this is.** One media tree serves two audiences at the same URLs, with no file
duplication and **no application process in the byte path**. The web server authorizes
each request with a single `stat()` on a zero-byte marker file.

Native TS since 2026-07-12 (closes audit `MEDIA-01` / `SECURITY_DECISIONS.md` DECISION 1,
option B). Before that, Rule A and the rule generation were PHP-owned; the PHP engine is
retired, so nothing minted the cookie and nothing generated the rules.

Engine: `src/core/media/protection.ts`. Publication-host profile: `src/core/media/publication_host_rules.ts` (`engineering/PUBLICATION_HOST_SPEC.md` §5.1). Marker writer: `src/diffusion/targets/mediastore/media_index.ts`.
Gates: `test/unit/media_protection*.test.ts` (one of them a registered tripwire).

## 1. Why the web server enforces, and not Bun

Installs carry millions of images and single AV files of 16–32 GB. The gate must cost one
`stat()` so files keep native `sendfile`/Range and the Apache H.264 / nginx `mp4`
`?start=` clipping handlers. **Never put an application process in the media-serving
path** — no proxying, no streaming through Bun, no `X-Sendfile` for gated media. The gate
never inspects the query string, and its Apache rewrite substitution is always `-`.

Verified: a `Range: bytes=0-99` request against a gated file answers `206 Partial Content`
with the correct `Content-Range`. If that ever becomes a `200` with a full body, something
has been put in the byte path and the design is broken.

## 2. The two rules

- **Rule A — the work system.** A logged-in user carries the fixed-name cookie
  `dedalo_media_auth`, whose per-session 128-hex value must exist as a zero-byte marker
  at `<media>/.publication/auth/{value}`. Grants unrestricted media access.
- **Rule B — publication.** An anonymous user may read only files of **published** records,
  and only inside the configured public quality folders. The web server stats
  `<media>/.publication/pub/{section_tipo}_{section_id}`, deriving the record identity
  from the media **file name**.

**Fail closed, and as 404 — never 403.** Every failure path (missing marker, malformed
cookie, non-grammar filename, absent store) denies, and denies without disclosing that the
file exists. Rule A markers are independent of publication state, so a diffusion failure
can never lock editors out.

**An UNREACHABLE media tree is not an unprotected one.** Fail-loud (a configured mode
whose gate artifacts cannot be written throws, rather than degrading into silently
unprotected media) rests on the premise that the web server is serving the tree. That
premise dies when the root itself is absent — an unmounted volume, a dropped share, a
mistyped path: every media URL then 404s at the web server, so there is nothing to
protect. `mediaTreeUnreachableReason()` (protection.ts) draws that line, on EXISTENCE
only, and the four writers behind it — `issueSessionMediaKey`, `layAuthMarker`,
`syncAuthMarkers`, `writeRuleFiles` — log loudly and do nothing instead of throwing.
**Media availability is never an authorization input for records**: before 2026-09-06 an
unmounted media disk took the exception out of `login()` and nobody could sign in to read
a text record. A root that EXISTS but cannot be written (read-only mount, wrong owner) is
being served, and still throws. So is a root this process merely cannot STAT: the errno
list is closed — `ENOENT`, `ENOTDIR`, `ESTALE` — because `MEDIA_PATH=/srv/media` under a
`/srv` this process may not traverse answers `EACCES` while the web server's own user
traverses it and serves every file in the tree. And the mode is resolved BEFORE the tree
is probed, so an install with protection off and an unplugged disk gets no error line
about files it never wanted. `writeRuleFiles` answers `false` rather than throwing when
the tree is absent, and the `media_control` widget FAILS the action on that `false` — a
mode change that wrote no rules must never report success. Gates: the five
`media_protection.test.ts` cases in the login-hook block named for this behaviour.

Not every unmounted volume is this shape. macOS removes `/Volumes/<name>` with the disk,
so the probe sees `ENOENT`. A Linux mount point SURVIVES the unmount as an empty,
usually root-owned directory: the probe correctly reads it as reachable — the web server
is serving that empty tree — and a login there still fails loud on the unwritable root.

## 3. The marker store, and who owns what

```
<media>/.publication/
  auth/{cookie_value}                 ← core/media/protection.ts, and ONLY it
  pub/{section_tipo}_{section_id}     ← media_index.ts, and ONLY it (the union)
  dbs/{db}/{table}/{key}              ← media_index.ts (per-target ground truth)
```

`pub/{key}` exists ⇔ the key exists in at least one `dbs/<db>/<table>/` dir. Appliers
**recompute that union from full directory state — never refcount**, so concurrent
publish/unpublish stay idempotent. Ownership is exclusive: crossing it is a bug.

The store is **never served, in any mode** — including `off`. The filenames under `auth/`
are live credentials and the ones under `pub/` enumerate every published record id.
(Stricter than the PHP original, whose `off` template omitted this deny.)

## 4. The filename grammar — LOAD-BEARING

```
...{component_tipo}_{section_tipo}_{section_id}[_lg-xxx].{ext}

[^/]*_([a-z0-9]+)_([0-9]+)(?:_lg-[a-zA-Z0-9-]{2,12})?\.[A-Za-z0-9]+$
```

The **greedy prefix** pins the captures to the LAST TWO underscore tokens, so a component
tipo — which also contains underscores — can never be read as the section tipo.

It is stated in **three surfaces that must stay in lockstep**: the generated Apache rules,
the generated nginx rules, and `KEY_REGEX`/`makeMarkerKey` in `media_index.ts`. Touch one,
review all three. `test/unit/media_protection_tripwire.test.ts` enforces this mechanically
— it pulls the regexes back out of the generated text, compiles them, and asserts all
three classify one table of real filenames identically.

**Files that do not parse stay login-only BY DESIGN** (e.g. images renamed through
`properties.image_id` or an external source). Document them; never loosen the regex to
"fix" them — that hands anonymous users every unparseable file in a public quality folder.

**Rich-text images are keyed at upload** (TODO-066, 2026-10-26). The editor's upload
(`publishWebImage`, key_dir `web`) names the file `<stem>[-n]_<section_tipo>_<section_id>.<ext>`
after the record whose text it goes into — the collision discriminator sits BEFORE the key, so
the name still parses — and `image/<DEDALO_IMAGE_WEB_FOLDER>` is a default public quality. Rule B,
the marker writer and `media_copy` therefore treat it like any other derivative, with no new
surface. The endpoint asks the write door (`authorizeRecordAccess`, write level 2, section floor
1) for the text's `(section_tipo, component_tipo, section_id)` BEFORE staging, and requires the
component to be a `component_text_area`: otherwise a user could key an image to a published
record whose text they cannot edit and make it public. Limits, by design: a legacy unkeyed name
(`pic.jpg`) stays login-only; an image pasted into another record's text follows the publication
of the record it was uploaded from; like any component media file, it is public from upload into
an already-published record and after its removal from the text. An explicit
`DEDALO_MEDIA_PUBLIC_QUALITIES` must list `image/web` itself; nginx needs a reload for the new
quality (§7).

## 5. The cookie

Fixed NAME (`dedalo_media_auth`), rotating VALUE (128-char sha512 hex). **The fixed name
is what makes the generated rules static and lets nginx survive every rotation with no
reload** — the rules never mention a value, only the marker whose filename IS the value.
Never reintroduce rotating cookie names.

**One value per SESSION** (2026-08-24). The marker set under `.publication/auth/` is a
PROJECTION of the sessions table: `createSession` stores the key on the row,
`issueSessionMediaKey()` mints it and lays the marker, and every way a session ends
unlinks it. `src/core/security/session_media.ts` is the one door that does both halves —
`endSession` (logout, expiry), `endUserSessions` (password reset, single-session
eviction), `sweepExpiredSessions` (prune + orphan reconcile).

Attributes (`server.ts mediaAuthCookieHeader`): `HttpOnly; SameSite=Lax; Path=/`, `Secure`
under `SESSION_COOKIE_SECURE`, `Max-Age` = **the session idle window**
(`SESSION_TTL_SECONDS`). HttpOnly still lets the browser attach it to `<img>`/`<video>`
subresource loads — that is the whole mechanism.

**The cookie's life is the SESSION's life (WC-051).** It is re-issued on any authenticated
request whose cookie is missing or is not this session's key — one string compare against
a value already on the session row. It was previously minted ONLY at login with a fixed
`Max-Age=86400`, which failed in both directions: an editor logged in longer than a day
kept a working session and lost the cookie, so **every media file 404'd while the app
itself looked healthy** (with no publication markers, Rule A is the only door); and a
cookie minted just before logout stayed a valid credential with no session behind it.

Two populations are RE-KEYED on that path rather than re-issued: sessions predating the
`media_key` column (the upgrade), and sessions created while protection was off on an
install that has since switched it on. Re-keying lays a marker and updates the row; it
must **never** call `writeRuleFiles()` — that is the authenticated hot path.

### Why it used to be install-global, and what that cost

Until 2026-08-24 the value was one per INSTALL per DAY: every logged-in editor held the
identical cookie, today's and yesterday's both valid. Two rules followed, and both were
written into the code:

- *"Logout must never unlink the marker"* — unlinking the shared value would have logged
  every other editor out of the media tree. So logout cleared the browser cookie only.
- A leaked value therefore granted media read until the next daily rotation, **surviving
  logout AND a password reset for up to ~48 hours**, entirely outside the session store's
  reach. The reset flow, whose whole purpose is cutting off whoever holds a stolen token,
  could not cut off that one.

That is now inverted: logout unlinks THIS session's marker and no other, and
`password_reset` goes through `endUserSessions`, so both credentials die together.

**The auth store is retired.** `<private>/media_auth.json` held the day-global values; a
fetchable one would have let anyone set the cookie and read the whole tree for ~48 h,
which is why it lived outside every served root. There is no shared value to persist any
more, so boot renames the file to `media_auth.json.migrated` once
(`retireLegacyAuthStore`) rather than leaving credentials on disk to be restored from a
backup years later.

**The orphan sweep does NOT run at boot**, deliberately. The session store is repointable
(`DEDALO_SESSION_DB_PATH`) and the media root is not: the update's smoke boot starts the
candidate tree with an empty throwaway session store and the inherited `MEDIA_PATH`, so a
boot reconcile would unlink every live editor's marker on the production tree — on every
`bun run test:update` and every real update. It runs from the maintenance widget and after
a prune, where the caller is definitionally holding the real store.

## 6. Modes and precedence

`resolveMediaAccessMode()`:

1. `ts_state.json` `media_access_mode` — the runtime override the **root-only**
   `media_control` widget writes. `null`/absent = no override; `false` = explicitly OFF.
2. `.env` `DEDALO_MEDIA_ACCESS_MODE` — `private` | `publication`.
3. legacy `.env` `DEDALO_PROTECT_MEDIA_FILES=true` → `private`.
4. else `'publication'` — the fail-closed default (2026-08-24, `readMediaAccessMode`). Only an
   explicit opt-out resolves to `false` (media world-readable).

The override lives in `ts_state.json` and **not** in `.env` because `../private/.env` is
append-only *and* parsed once at import — this Bun process lives for weeks, so a `.env`
change could never take effect without a restart. `getServerState()` re-reads its file on
every call, so a widget mode change applies immediately.

`'off'` is a **generator-only** mode: `resolveMediaAccessMode()` never returns it.

## 7. The generated rule files

Written into the media root, config-hash guarded (so a login is normally a no-op), and
regenerated at **boot** as well as at login — a fresh deploy must not serve the whole tree
until someone happens to log in.

| File | Consumer |
|---|---|
| `.htaccess` | Apache, per-directory, **no reload needed** |
| `dedalo_media_protection.nginx.conf` | nginx `server{}` — `include` it |
| `dedalo_media_protection_map.nginx.conf` | nginx `http{}` — `include` it (a `map` cannot live in `server{}`) |

**Bump `TEMPLATE_VERSION` whenever a template changes**, or existing installs — whose other
inputs are unchanged — never regenerate.

`'off'` writes the **hardening-only** template. It must NEVER unlink the files: the media
root is full of user-uploaded files, and an `.htaccess`-less media dir is one where Apache
will execute an uploaded `.php`. The SEC-088 script-execution block, the MEDIA-03 response
headers and the marker-store deny are emitted in **every** mode.

### MEDIA-03: the response headers (2026-08-24)

SVG is the one image format that is also a DOCUMENT, and this origin is the application
origin. The generated rules emit `X-Content-Type-Options: nosniff` for the whole tree and
split SVG into two populations from ONE definition, `src/core/media/svg_safety.ts`, which
the Bun media route consumes too:

- the **server-generated image envelope** (`<imageFolder>/…/svg/…/*.svg`) stays **inline**
  with `script-src 'none'` — the edit view embeds it through `<object type="image/svg+xml">`
  and needs same-origin `contentDocument` access, which a CSP `sandbox` would sever;
- **every other** `.svg`/`.xml`/`.xsl`/`.xslt` is served `attachment` + `default-src 'none';
  sandbox`;
- `html|htm|xhtml|xht|shtml|swf|hta` are denied outright — no media model accepts them.

Two things about this are load-bearing. The envelope lives one bucket directory BELOW its
`svg/` segment, so a pattern anchoring the file directly inside `svg/` matches no real
envelope and blanks every edit view. And **headers may not fail open**: without
`mod_headers`, Apache cannot emit the CSP, so that branch DENIES the uploader-supplied
population rather than serving it inline unprotected.

Uploaded SVG is never refused or sanitized — refusing a curator's vector file is data
loss, and the quarantine is what makes it inert. Active content in an upload is NOTICED in
the log so it can be found. Wire contract: `WC-2026-08-24-media-svg-response-headers`.

### The nginx asymmetry — read this before switching modes

Apache reads `.htaccess` per request: a mode change applies **immediately**. nginx reads
its include at **reload**: a mode change does **nothing** until `nginx -t && nginx -s
reload`. An operator who flips `off → publication` and does not reload keeps serving
everything, with a green widget. The widget says so in its success message and reports
`rules.nginx.reload_required`.

Conversely, an `include` of a *missing* file makes nginx refuse to start. That is
fail-closed and intended — but the tempting "fix" is to comment the include out, which is
world-open. Generate the rules at boot so the file is always there.

Note what does **not** need a reload: a new session's cookie value (§5).

## 8. Operational gotchas

- **`open_file_cache`**: keep it off on the media locations (or `open_file_cache_valid ≤ 2s`).
  It caches `stat()` results and delays an unpublish taking effect.
- **NFS / web farms**: the marker `stat()` honors the attribute cache, so an unpublish can
  lag a few seconds across hosts.
- **CDN**: purge the record's media paths on unpublish (especially `.vtt` subtitles). The
  origin denies immediately; downstream caches do not.
- **Enabling on a live install**: users logged in *before* the change get their cookie on
  their next authenticated request (WC-051 re-issue) — no re-login needed, provided a store
  already exists; if none does, the first login creates it. The widget restores markers for
  existing cookie holders, not the cookies themselves. Existing publications need one
  `rebuild_media_index` run.
- **"All my images suddenly 404 but the app works"** is almost always Rule A: the browser is
  not sending a cookie whose value has a marker. Check, in order — `.publication/auth/`
  holds THIS SESSION's key (the `media_key` column on its row); the browser actually holds
  `dedalo_media_auth` (it is HttpOnly, so read it in DevTools → Application → Cookies, not
  from JS); and `curl -H "Cookie: dedalo_media_auth=<that session's key>" <a real media URL>`
  returns 200. If curl passes and the browser does not, the cookie is missing or stale, not
  the rules.
- **The #1 misconfiguration** is an unset `MEDIA_PATH`: publishes succeed but anonymous
  access stays 404. The widget surfaces it. (`MEDIA_PATH` now DERIVES to `<projectRoot>/media`
  — `config.media.rootPath` — so this bites only when an install overrides it wrongly.)
- The **engine media fallback** (Bun serving media itself: session-gated, no per-record ACL,
  bypasses these rules — MEDIA-04) is bound to conditions production cannot meet, so it needs
  no flag and cannot leak into a real deployment: it answers **only** on the TCP dev listener
  (production is socket-only) and **only** while protection is unconfigured. Setting a mode
  stands the engine down — the generated rules become authoritative, and the engine must never
  serve the same bytes with weaker checks. `MEDIA_DEV_ROUTE_ENABLED=true` overrides that and
  forces the fallback on for EVERY listener, socket included: never do it on a shared host.
  It exists because the dev listener has no web server in front, so without it a fresh install
  set up exactly per `docs/install/dev_quickstart.md` 404s every image, video and PDF.
  Gate: `test/unit/media_fallback_listener.test.ts`.

## 9. Definition of done — the curl matrix

Unit tests prove the patterns; only a real web server proves the **engines**. This method
is what historically caught the Apache rule-B backreference bug (`$1_$2` vs `%1_%2`) and
the nginx `^~` precedence trap. Boot a throwaway server against the **actually generated**
rule files (never hand-written ones) over a scratch media tree, then:

| request | cookie | expect |
|---|---|---|
| published record, public quality | none | **200** (rule B) |
| unpublished record, public quality | none | **404** |
| master (`original`/`modified`) quality | none | **404**, even when published |
| `_lg-spa.vtt` subtitle of a published record | none | **200** |
| non-grammar filename | none | **404** (login-only by design) |
| any of the above | valid | **200** (rule A) |
| `.publication/auth/<value>`, `.publication/pub/<key>`, `.htaccess` | any | **404** |
| any protected file | `../../../etc/passwd`, short, non-hex, 128-hex non-marker | **404**, never 500 |
| uploaded `.php` (or any SEC-088 script extension, any case) under the media root | valid | **404 — never executed, source never served** (also in mode `off`) |
| AV file, `Range: bytes=0-99` | none | **206** + `Content-Range` |
| any media file | any | `X-Content-Type-Options: nosniff` (MEDIA-03) |
| raw uploaded `.svg` (`svg/…`) | valid | **200** + `Content-Disposition: attachment` + `Content-Security-Policy: default-src 'none'; sandbox` |
| server-generated envelope (`<image>/…/svg/…/*.svg`) | valid | **200**, NO disposition, CSP with `script-src 'none'` — and the `<object>` edit view still renders |
| `.xml` under the media root | valid | **200** + `attachment` + sandbox CSP |
| uploaded `.html` / `.swf` under the media root | valid | **404 — denied outright** (also in mode `off`) |
| working file (`.deleted`/`.temp`/`.tmp`/`.import`/`.csv`, any case) of a **published** record | any | **404 — denied outright**, before rule B (also in mode `off`) |
| published file, then `rm` its `pub/` marker | none | **404 on the very next request**; `touch` it back → 200 |

**Status (2026-08-24): the whole matrix, including the five MEDIA-03 header rows, was run
end-to-end against a live Apache 2.4.66 AND a live nginx — the first time the nginx block
has been executed rather than pattern-checked.** Both engines agree on every row: envelope
inline with the script-blocking CSP, raw SVG and XML `attachment` + sandbox, `nosniff`
everywhere, active documents 404, published/unpublished rule-B behaviour, rule A by cookie,
hostile cookies denied, `.publication` denied, an unpublish taking effect on the very next
request, and `Range: bytes=0-4` answering **206** on both.

That run changed the implementation once, which is the argument for doing it: on Apache the
active-document deny was written as `Require all denied` and answered **403**, confirming
the file exists. In a `.htaccess` mod_rewrite runs in the FIXUP phase, i.e. AFTER
authorization, so an authz denial answers first — the opposite of what the code assumed. It
is now a `RewriteRule … [R=404,L]`, and both engines answer 404. Pattern gates cannot see
this class of defect at all.

**2026-10-03 (F2):** the working-file row was missing, and it was red: nginx (both profiles)
had no working-file deny at all, so a published record's grammar-valid `…_test3_1.tmp`/`.csv`
passed rule B and was served; Apache denied it with a case-sensitive `FilesMatch` → **403**,
and `.TMP` on a case-insensitive mount (APFS/SMB) was served (**200**). Both now 404 it from
the shared hardening (`MEDIA_WORKING_FILE_EXTENSIONS`; Apache a `(?i)` `RewriteRule … [R=404,L]`
with a `FilesMatch` deny as the no-mod_rewrite fallback). Proven live on Apache 2.4.68 +
nginx 1.31.6: the publication-host profile by `bun run test:media:pubhost` (`.tmp`, `.csv`,
`.TMP` rows), the work profile (modes `publication` and `off`, with and without a valid
cookie) by a one-off run against the generated `.htaccess`/nginx conf; pinned by the
tripwire's F2 lockstep block (all four generated texts).

**2026-10-03 (F3):** the same 403 trap, still live for SEC-088: Apache denied an uploaded
`.php` (every `MEDIA_SCRIPT_DENY_PATTERN` extension) with an unconditional `FilesMatch`
`Require all denied`, and since authz runs before the per-dir rewrite it answered **403**,
confirming the upload exists. Now `SetHandler none` (never executed) + a `(?i)`
`RewriteRule … [R=404,L]`, the `FilesMatch` deny kept ONLY inside `<IfModule !mod_rewrite.c>`
as the no-mod_rewrite fallback. Proven live on Apache + nginx by `bun run test:media:pubhost`
(`.php`, `.PHP` rows: exactly 404, source never served; the pre-fix template reds both Apache
rows with 403); the work `.htaccess` emits the identical shared block; pinned by the
tripwire's F3 block (every Apache text, any case, deny-only-as-fallback).

Historic note: the **nginx block used to be pattern-verified only**
(the tripwire compiles its regexes and pins the `^~`/named-capture traps) — it has not yet
been run against a live nginx. Do that before the first nginx deployment.

## 10. The publication-host profile (separate publication machine, shared storage)

When a SEPARATE publication machine reads this media tree through a read-only mount, the
rule files above are wrong there twice: they embed the WORK host's root, and they honour
Rule A, whose `auth/` markers are work-session credentials. That host gets its own profile,
rendered from the same templates by `src/core/media/publication_host_rules.ts`:

- hardening + rule 0 + **Rule B against the host's mount root** + 404 default deny; **no Rule A**;
- Apache: a vhost include (`Alias` + `<Directory>` with `AllowOverride None`, so the work
  `.htaccess` on the shared tree is never read), gate NOT in `<IfModule>` (no mod_rewrite = no boot);
- nginx: a server{} include = ONE outer `location ^~ <url>/` (no server-level regex location
  can take a media request) with the shared hardening (`nginxHardeningLocations`) and Rule B
  (aliasing into the root) nested, `return 404` default; the http{} map is `buildNginxMap()`
  unchanged. The mount must not sit under a document root.
- **nginx http{} map on a PROVISIONED publication host** (`web.nginx_map: conf_d`,
  `engineering/PUBLICATION_HOST_SPEC.md` §9.7): on a publication host provisioned with
  `provision init`, the http{} map is pushed by apply_rules into the host-wide include and must
  not be placed by hand; the manual path below still applies to work hosts and hand-provisioned
  publication hosts. The engine sends `buildNginxMap()` with `nginxMapConfigHash()` as
  `rules.map` BEFORE the server include (the include uses the map's variables; a map refusal
  stops the include). The agent validates it against the closed map grammar
  (`parseNginxMap`, `publication/host_agent/src/rules/directives.ts`), writes only its own
  one-envelope contribution, and starts the ROOT map renderer
  (`publication/host_agent/src/rules/host_map_main.ts`, the `dedalo-pubhost-map` oneshot), which
  re-validates every contribution, merges them (`renderHostMap`,
  `publication/host_agent/src/rules/host_map.ts`: distinct envelopes sorted, the newest admitted
  pin set) and is the only writer of the file nginx loads, through the provisioned include
  `/etc/nginx/conf.d/dedalo_media_map.conf`
  (`publication/host_agent/src/provision/render/nginx_map_include.ts`). With every instance on
  one engine version and one `mediaDir`, the host file is byte-identical to `buildNginxMap()`.
  nginx found down after a reload of a new map that passed `-t` (an AVC at the reload) puts
  the last LOADED map back, re-tests it and restarts nginx (`src/rules/txn.ts`, the renderer's
  closed `rendererExec`): the media variables never stay undefined on the host.

Render (work hosts and hand-provisioned publication hosts): `bun run media:publication-host-rules --root <mount> [--server apache|nginx|nginx-map]`.
Lockstep: `media_protection_tripwire.test.ts` (same filename verdicts, host-root markers, no
Rule A). Engine proof: `bun run test:media:pubhost` (the §9 matrix for this profile on live
Apache and nginx, in a HOSTILE harness — mount under the document root, an operator
static-asset regex location before the nginx include — plus: a work cookie is refused, a
permissive work `.htaccess` is ignored, and Apache without mod_rewrite refuses the config).
The agent and engine drills (`bun run test:pubhost:agent`, `bun run test:pubhost:engine`) hold the
MEDIA-03 headers on the PROVISIONED path too, on Apache and nginx: the include the agent applied
(and, on nginx, the host map the root renderer installed from `rules.map`) serves the published
record's envelope SVG with no `Content-Disposition` and `SVG_ENVELOPE_CSP`, and its uploaded SVG
`attachment` with `SVG_QUARANTINE_CSP` (`scripts/lib/publication_host_agent_drill_kit.ts`
`svgTreatmentProblem`, its paths pinned to the selection rule by
`test/unit/publication_host_agent_drill_kit.test.ts`).
Hostile-cookie rows are N/A: this profile reads no cookie. Exports, NFS/SMB attribute caching and
the mount layout: `engineering/PUBLICATION_HOST_SPEC.md` §5.1.
