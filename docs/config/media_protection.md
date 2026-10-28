# Media protection (media file access control)

> See also: [Configuration](config.md) · [Reverse proxy](../install/reverse_proxy.md) · [area_maintenance](../core/areas/area_maintenance.md) · [media_protection (internals)](../core/system/media_protection.md)

Media protection controls who may read the files served from the media directory — images,
audiovisual masters and web copies, PDFs, SVG, 3D and subtitles. This page is for the system
administrator: what to configure, how to wire the web server, and how to verify that the gate
is really closed before you expose media to the internet.

> Example media URL: `https://mydomain.org/dedalo/media/av/404/rsc35_rsc167_2.mp4`

## The model: one tree, two audiences

One media tree serves two audiences at the same URLs, **with no file duplication**:

* **Rule A — the work system.** A logged-in user carries the fixed-name cookie
  `dedalo_media_auth`. Its per-session value must exist as a zero-byte marker file in
  `<media>/.publication/auth/{value}`. Rule A grants unrestricted media access: masters,
  unpublished records, everything.
* **Rule B — publication.** An anonymous visitor may read only the files of **published**
  records, and only inside the configured public quality folders. The web server stats
  `<media>/.publication/pub/{section_tipo}_{section_id}`, deriving the record identity from
  the media **file name**. Those markers are written by the diffusion engine
  (`src/diffusion/targets/mediastore/media_index.ts`) — never by the protection module.

Without this, every media file is readable by anyone who knows or guesses its URL, including
unpublished masters and the `.vtt` subtitle files that carry unpublished transcriptions. That
is why an install that configures nothing now gets `publication` rather than nothing at all. The classic workaround — copying published media to a second public tree —
doubles terabytes of storage and desynchronizes on every publish.

### The web server enforces, not the application

This is the point that justifies the whole design. Authorization is **one `stat()` call per
request, performed by Apache or nginx itself**. Multi-GB files therefore keep native
`sendfile` and HTTP `Range` delivery, and the real-time clip handlers (the Apache H.264
streaming module, the nginx `mp4` module) still receive the request untouched — URL
parameters like `?start=1&end=89` keep working exactly as before.

!!! success "No engine process is ever in the media byte path"
    Dédalo only **maintains the artifacts the web server reads**: the marker files and the
    generated rule files. It never proxies, streams or gates a media byte itself. The
    consequence you can rely on: the gate can never break streaming, and it can never become
    a bottleneck on a busy publication server.

### Fail closed, and as 404

Every failure path — missing marker, malformed cookie, a file name that does not parse, an
absent marker store — **denies**. The default deny answers **404, not 403**, so the existence
of unpublished media is never disclosed.

Rule A markers are engine-owned and completely independent of publication state, so a
diffusion failure can never lock editors out of their own media.

## The marker store

Authorization state lives in a directory of zero-byte marker files inside the media root.
Ownership is exclusive: crossing it is a bug.

```text
<media>/.publication/
    auth/{cookie_value}                 rule A — written by the engine at login, and only there
    pub/{section_tipo}_{section_id}     rule B — "published in at least one target"; the ONLY
                                        thing the web server stats for an anonymous request
    dbs/{database}/{table}/{key}        per-target ground truth; pub/ is the derived union
```

`pub/{key}` exists exactly when the key exists in at least one `dbs/<db>/<table>/` directory.
A record published on two sites stays public until the **last** one unpublishes. An unpublish
takes effect on the very next HTTP request, including for the record's subtitle files.

The store itself is **never served, in any mode** — the file names under `auth/` are live
credentials and the ones under `pub/` would enumerate every published record.

### The file name grammar

The web server maps a URL to its record through the media file name:

```text
{component_tipo}_{section_tipo}_{section_id}[_{lang}].{extension}

rsc35_rsc167_2.mp4              → record rsc167-2  (web quality video)
rsc35_rsc167_2.jpg              → record rsc167-2  (posterframe)
rsc35_rsc167_2_lg-spa.vtt       → record rsc167-2  (Spanish subtitles)
rsc29_rsc170_3_lg-spa.jpg       → record rsc170-3  (translatable image)
```

The gate takes the **last two** underscore tokens (`section_tipo`, `section_id`) and stats
`pub/rsc167_2`. One marker therefore covers every derived artifact of the record: all
qualities, the posterframe, every subtitle language.

!!! note "Files that do not parse stay login-only — by design"
    Media renamed away from this grammar (for example images renamed through
    `properties.image_id`, or an external-source file name) cannot be mapped to a record, so
    rule B never matches them and they remain readable only by logged-in users. That is
    fail-closed behavior, not a defect. Never ask for the grammar to be "loosened" to fix
    them: that would hand anonymous visitors every unparseable file in a public folder.

!!! note "Images inserted into rich text"
    An image inserted from the rich-text editor's toolbar is stored in `image/web` (the
    `DEDALO_IMAGE_WEB_FOLDER`) under a name that ends with the record it was inserted into,
    for example `photo_rsc167_2.jpg`. It is therefore public exactly while that record is
    published, like the record's own media. Only a user who may edit that text can insert an
    image into it. Images inserted before this naming (for example `photo.jpg`) have no record
    in their name and stay login-only until the `rich_text_images` entry of **Maintenance →
    Reconcile status** renames them after their record (see
    [Upgrading](../install/upgrading.md#one-time-data-update-images-inserted-into-rich-text)).
    The `web_image_exposure` entry, which runs at every start, lists any file in `image/web`
    that is public although the published record its name points at does not use it.

## Configuration

All keys live in `../private/.env`.

### `DEDALO_MEDIA_ACCESS_MODE`

`private` | `publication` | `false` (**unset = `publication`**, fail-closed since 2026-08-24)

| Mode | Logged-in users | Anonymous users |
|---|---|---|
| *unset* | everything | **published records only** — the fail-closed default |
| `publication` | everything | published records only, and only in the public quality folders |
| `private` | everything | nothing |
| `false` / `off` / `0` | everything | everything — an EXPLICIT choice to serve an open tree |
| *an unrecognised value* | everything | published records only (a typo fails closed, and is logged) |

!!! warning "The default changed on 2026-08-24"
    It used to be "protection off". An institution that installed Dédalo and configured
    nothing served its entire media tree — unpublished records, master-quality originals,
    rights-restricted material — to anyone who could guess a URL.

    `publication` rather than `private`, because on an install with no publications the two
    behave identically, while `private` would later 404 the archive's own published site the
    day diffusion writes its first marker.

    Setting `false` is still a real choice and is honoured; what is no longer honoured is
    silence. **nginx installs must reload** for this to take effect
    (`nginx -t && nginx -s reload`); the Apache `.htaccess` applies immediately.

```ini
# ../private/.env
DEDALO_MEDIA_ACCESS_MODE=publication
```

Use `private` for a pure work system with no public website. Use `publication` when the same
server — or a server sharing the media tree — also feeds public websites.

**Precedence** (`resolveMediaAccessMode()`), highest first:

1. The runtime override in `<private>/ts_state.json` (`media_access_mode`), written by the
   **media_control** maintenance widget. `null` or absent means "no override"; a stored
   `false` means "explicitly off" and does **not** fall through to the `.env` value.
2. `DEDALO_MEDIA_ACCESS_MODE` from `../private/.env`.
3. The deprecated `DEDALO_PROTECT_MEDIA_FILES=true`, honored as `private`.
4. Otherwise: off.

Anything that is not exactly `private` or `publication` resolves to off. The override is
re-read from disk on every request, so a mode change from the widget takes effect immediately,
with no restart.

!!! warning "A stale runtime override is the classic 'my config change did nothing'"
    The widget's override **wins over `.env`**. If you edit `DEDALO_MEDIA_ACCESS_MODE` and
    nothing changes, open the media_control widget: it reports the effective mode *and where
    it came from*. Set the selector back to "Use config file value" to drop the override.

### `MEDIA_PATH`

The absolute filesystem media root. Everything in this subsystem hangs off it: the marker
store, the generated rule files, the file the web server finally serves.

If `MEDIA_PATH` is unset while a mode is configured, **login fails loudly** rather than
serving media unprotected. If it is unset and no mode is configured, the whole subsystem is a
no-op.

### `DEDALO_MEDIA_PUBLIC_QUALITIES`

The quality folders (relative to the media root) an anonymous user may read in `publication`
mode when the record is published. When unset, they are **derived from this install's own
quality catalog**, so an install that renamed a quality still gets rules that match its real
folder names:

```text
av/404, av/posterframe, av/subtitles, image/1.5MB, image/thumb, image/web, pdf/web, svg/web, 3d/web
```

`image/web` holds the images inserted into rich text. If you set this key yourself, list it,
or those images stay private. On nginx, reload it after the list changes (Apache reads the
regenerated `.htaccess` by itself).

```ini
# publish higher-quality video too, and keep thumbnails private
DEDALO_MEDIA_PUBLIC_QUALITIES=["av/404","av/720","av/posterframe","av/subtitles","image/1.5MB","pdf/web"]
```

!!! danger "Master qualities can never be made public"
    `filterPublicQualities()` refuses `original` and `modified`, **plus this install's
    configured original quality for every media type and the retouched image twin**, whatever
    you write in the list. It also refuses `..` and any character outside
    `[A-Za-z0-9_./-]` — these strings are interpolated into a web-server regex. A refused
    entry is dropped and logged; it never silently becomes public and never aborts the boot.

### `MEDIA_HTACCESS_ADDONS`

A JSON array of raw Apache rewrite directives, appended to the generated `.htaccess` just
before the final deny rule. You own their syntax; Dédalo only places them.

```ini
# allow an internal network unconditionally
MEDIA_HTACCESS_ADDONS=["RewriteCond %{REMOTE_ADDR} ^10\\.0\\.","RewriteRule ^ - [L]"]
```

!!! warning "It is **JSON**, so every backslash must be doubled"
    Note the `\\.` above. A regex is written `^10\.0\.` in Apache, but inside a JSON string
    each backslash must be escaped again — so the value carries `\\.`. Write it the natural
    way (`^10\.0\.`) and the value is no longer valid JSON.

    When that happens the key is **refused, loudly, and ignored**:

    ```text
    [config] MEDIA_HTACCESS_ADDONS must be a JSON array of strings — ignoring the value.
    ```

    Your addon lines simply do not appear in the `.htaccess` — the gate itself is unaffected
    and stays closed. Fix the escaping and restart. (The reader is deliberately JSON-only: a
    directive legitimately contains commas — `[R=404,L]` — so a comma-separated list would
    tear one directive into two invalid ones and Apache would then reject the whole media
    directory.)

### `MEDIA_DEV_ROUTE_ENABLED`

**You normally leave this unset.** The engine can serve media itself, with **no per-record
access control**, bypassing everything on this page. That fallback exists for the one setup
with no web server in the request path: a developer on the TCP dev listener. It is bound to
conditions production cannot meet, so it needs no flag and cannot leak:

| Situation | Engine serves media? |
|---|---|
| TCP dev listener (`SERVER_TCP_PORT`) **and** no `DEDALO_MEDIA_ACCESS_MODE` | **yes** — session-gated, no per-record ACL |
| Unix socket (production is socket-only) | **no**, always |
| Any listener, once protection is `private`/`publication` | **no** — the generated rules are authoritative and the engine must not undercut them |

Set the key only to override: `true` forces the fallback on for **every** listener, the
production socket included (the server logs a loud warning — do not do this on a shared
host); `false` forces it off even in development. Gate:
`test/unit/media_fallback_listener.test.ts`.

## The generated rule files

This is the operator step nobody can guess. The engine **generates** its web-server rules into
the media root; you have to make the web server read them.

| Generated file | Web server | What you must do |
|---|---|---|
| `.htaccess` | Apache | Nothing — honored automatically, provided `AllowOverride` permits it. |
| `dedalo_media_protection.nginx.conf` | nginx | `include` it in the media `server` / `location` block. |
| `dedalo_media_protection_map.nginx.conf` | nginx | `include` it at **`http{}`** scope (a `map` cannot live inside `server{}`). |

The exact wiring, with the surrounding site configuration, is in
[the web server site](../install/reverse_proxy.md).

The files are written at **boot**, at **every login**, and whenever the mode is changed from
the media_control widget — so a fresh deploy or a wiped media directory heals itself without
anyone noticing. Each file embeds a `# config-hash:` comment covering the mode, the public
qualities, the addon lines, the media root and the template version, so a login normally
compares two hashes and writes nothing.

!!! note "`TEMPLATE_VERSION`"
    The hash folds in a `TEMPLATE_VERSION` constant. Bumping it in code is the **only** thing
    that makes an existing install regenerate rule files whose other inputs are unchanged.
    Nothing you can set in `.env` does that.

### Apache

Requirements: `mod_rewrite`, and `AllowOverride All` (or at least `FileInfo Options`) on the
media directory. Apache re-reads `.htaccess` per request, so a mode change applies
**immediately**.

The generated gate, in order: deny the marker store → rule A (cookie value exists as an `auth/`
marker) → rule B (public quality folder **and** a `pub/` marker for the record the file name
identifies) → your addon lines → default deny as 404. The rewrite substitution is always `-`
and the query string is never touched, which is why `Range` requests and `?start=` clipping
survive.

### nginx

nginx reads its include at **reload**, not per request.

!!! warning "nginx needs a reload after a mode change — Apache does not"
    Flip the mode from `off` to `publication` and forget `nginx -t && nginx -s reload`, and
    nginx keeps serving the **old** rules while the widget cheerfully reports the new mode.
    The widget's success message says so, and it reports `rules.nginx.reload_required`.

    What does **not** need a reload: a **new session's cookie value**. The cookie *name* is fixed
    and the rules never mention a *value* — only the marker file whose name is the value. That
    is the entire reason the name is fixed.

An `include` of a file that does not exist makes nginx refuse to start. That is fail-closed and
intended. The tempting "fix" — commenting the include out — leaves your media world-open;
generate the rules instead (boot the engine once).

Operational notes, also written into the generated file:

* Do **not** enable `open_file_cache` on the media locations (or keep `open_file_cache_valid`
  ≤ 2s): it caches `stat()` results and delays an unpublish taking effect.
* On NFS or a shared-storage web farm the marker `stat()` honors the attribute cache, so an
  unpublish can lag a few seconds across hosts.
* Behind a CDN or caching proxy, **purge the record's media paths on unpublish** (especially
  the `.vtt` subtitles): the origin denies immediately, downstream caches do not.

!!! note "Verification status"
    The Apache rules have been exercised end-to-end against a live server, including the
    `Range`/`206` check. The nginx rules are currently **pattern-verified only** (the tripwire
    compiles them and pins the known traps) — run the verification matrix against a real nginx
    before your first nginx deployment.

## Always-on hardening

Three things are emitted in **every** mode, including `off`, because none of them is part of
the access gate:

* **Script execution under the media root is denied.** The media root is full of user-uploaded
  files, and the web server must never interpret one as code. Extensions no media model
  accepts at all (`.html`, `.swf`, `.hta`…) are refused outright.
* **SVG is served inert.** SVG is the one image format that is also a *document*: it can carry
  `<script>`, inline event handlers and `<foreignObject>`. Since the media origin is the
  application origin, an uploaded `.svg` served inline is stored XSS against a curator's
  session. So every uploader-supplied `.svg`/`.xml` is handed over as a **download**
  (`Content-Disposition: attachment`) inside an opaque origin
  (`Content-Security-Policy: default-src 'none'; sandbox`), while the *server-generated*
  image envelope — the file the edit view embeds through `<object>` — stays inline under a
  CSP that blocks script but preserves the same-origin access that view needs.
  `X-Content-Type-Options: nosniff` is emitted for the whole tree.
* **The marker store is denied.** The names under `auth/` are working media credentials and the
  ones under `pub/` enumerate every published record.

!!! note "Uploaded SVG is never refused or rewritten"
    Refusing a curator's vector file would be data loss — a heritage archive legitimately
    holds files it did not author — and sanitising SVG is lossy and unverifiable. The serving
    rule above is what makes such a file harmless; active content in an upload is *noticed* in
    the server log so it can be found, never rejected.

!!! warning "Apache needs `mod_headers`"
    Without it the CSP cannot be emitted, so the rules **deny** uploader-supplied vector and
    XML rather than serve it unprotected. Headers may not fail open. The engine-written
    envelopes stay served.

!!! danger "`off` disables the gate — it never deletes the rule file"
    Turning protection off writes a **hardening-only** rule file. It must never unlink it: a
    media directory with no rule file is one where an uploaded script becomes executable, and
    where yesterday's credential file names were harvestable. "Protection is off today" must
    not mean "the cookie that works tomorrow was readable yesterday".

## The auth cookie

* **Fixed name**, `dedalo_media_auth`; **one value per session**, 128 hex characters.
* Each login mints its own value and lays its own marker, so two sessions of the same user
  hold two credentials and neither displaces the other. The fixed *name* is what keeps the
  generated rules static: they never mention a value, so no rotation needs an nginx reload.
* Attributes: `HttpOnly; SameSite=Lax; Path=/`, `Max-Age` = the session idle window
  (`SESSION_TTL_SECONDS`), plus `Secure` when the session cookie is configured secure.
  `HttpOnly` still lets the browser attach it to `<img>` and `<video>` subresource loads —
  that is the whole mechanism.
* **The cookie lives exactly as long as the session.** It is re-issued on any authenticated
  request whose value is missing or stale, so it can neither expire under a live session nor
  outlive a dead one. See [login](../core/system/login.md) for the two session clocks.
* **Logout revokes it.** The value is one per SESSION, so logging out unlinks that session's
  marker and no other; a password reset unlinks every marker belonging to that user.
* The old day-global store, `<private>/media_auth.json`, is retired: boot renames it
  `.migrated` once. There is no shared value left to persist.

!!! danger "What the old design cost"
    Until 2026-08-24 the value was one per **install per day** — every logged-in editor held
    the identical cookie — so logout could not unlink the marker without locking everyone out,
    and a stolen cookie stayed valid for up to **48 hours** across a logout *and* a password
    reset. Holders of an old cookie lose access at the first boot after the upgrade and are
    re-issued on their next request; no re-login is needed.

A leaked value now grants media read access until that session ends. The cookie NAME is still
fixed and the value is still 128 hex characters, so none of this needs an nginx reload.

## The media_control widget

Area Maintenance carries the **Media access control** widget:

* it reports the effective mode **and where it came from** (runtime override, `.env`, or the
  legacy flag), the public quality folders actually in force, the media path, the state of both
  generated rule files (`exists` / `up_to_date`, and `reload_required` for nginx), the marker
  counts, and whether the media index is live;
* the **root user** can change the mode (`Use config file value` / `Off` / `Private` /
  `Publication`). The change applies in the same request: the override is stored, both rule
  files are regenerated with the new mode, and the auth markers are re-laid so users who
  already hold a cookie keep access without re-authenticating. Everyone else receives the
  cookie at their next login;
* **Rebuild media index** (global admins) resyncs the publication markers from the publication
  databases. It is safe to re-run at any time and never opens a deny-everything window;
* a read-only line links to the **Publication hosts** panel, where the media rules of each
  separate publication server are compared and applied
  ([publication host agent](../install/publication_host.md#the-publication-hosts-panel)).

The mode switch is **root-only**, not merely admin-only: setting the mode to `off` opens the
entire media tree to the world.

## Enabling on an existing installation

1. Set the mode:

    ```ini
    # ../private/.env
    DEDALO_MEDIA_ACCESS_MODE=publication
    ```

2. Restart the server. It writes the rule files into `MEDIA_PATH` at boot.
3. **nginx only**: on an instance installed by the installer, refresh the validated copies
   the site includes ([Production › Changing the media access mode](../install/production.md#changing-the-media-access-mode));
   on a site written by hand, add the two `include` lines
   ([the web server site](../install/reverse_proxy.md#a-site-written-by-hand)), then
   `nginx -t && nginx -s reload`. Apache needs nothing.
4. If the instance already has published records, run **Rebuild media index** once from the
   widget so the `pub/` markers exist.
5. Ask editors to log out and back in once — the auth cookie is minted at login.

## Verify before you expose anything

Take one published record and one unpublished record and check the three answers that matter:

```shell
# published record, public quality, no cookie → served
curl -I https://mydomain.org/dedalo/media/av/404/rsc35_rsc167_2.mp4
# HTTP/1.1 200 OK

# unpublished record, same folder, no cookie → denied, and denied as 404
curl -I https://mydomain.org/dedalo/media/av/404/rsc35_rsc167_3.mp4
# HTTP/1.1 404 Not Found

# a master, no cookie → denied even though the record IS published
curl -I https://mydomain.org/dedalo/media/av/original/rsc35_rsc167_2.mp4
# HTTP/1.1 404 Not Found
```

The **full verification matrix** — subtitles, non-grammar file names, traversal and hostile
cookie values, the marker store, `Range`/`206`, uploaded-script execution, and marker removal
taking effect on the next request — is the definition of done for this subsystem and lives in
`engineering/MEDIA_PROTECTION.md`. Run it against the **generated** rule files, never against
hand-written ones.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Published media still 404s for anonymous users | `pub/` marker missing, the file is outside the public qualities, or its name does not follow the grammar | check the widget status; **Rebuild media index**; review `DEDALO_MEDIA_PUBLIC_QUALITIES` |
| Editors get 404 on everything after enabling | they logged in before protection was on, so they hold no cookie | log out, log in |
| Mode changed but nothing happened (nginx) | nginx reads its include at reload | `nginx -t && nginx -s reload` |
| Mode changed in `.env` but nothing happened (any server) | a runtime override from the widget wins over `.env` | check "mode source" in the widget; select "Use config file value" |
| Publishes succeed but anonymous access stays 404 | `MEDIA_PATH` is unset, so no markers are maintained | set it, restart, rebuild the index — the widget flags this state |
| `.publication/` deleted, or the media tree restored from a backup | markers gone | **Rebuild media index**; the auth markers are re-laid at the next login |
| Unpublished media still reachable | a downstream CDN or proxy holds the copy | purge the record's media paths on unpublish |
| nginx refuses to start: unknown `$dedalo_auth_key` | the `http{}` map include is missing | add it — never comment the includes out. On a publication host provisioned with `provision init`, the `http{}` map is pushed by **Apply media rules** into the host-wide include and must not be placed by hand; the manual path below still applies to work hosts and hand-provisioned publication hosts. There, run **Apply media rules** in the **Publication hosts** panel; `provision check` on the host shows whether the host-wide map include exists |
| **Apply media rules** says the media map is *not managed* (`map_unmanaged`) | the publication host's nginx declaration has no `"nginx_map": "conf_d"`, so its map is placed by hand | expected on such a host (the rules are still applied); to let the panel push the map, provision the host with `provision init` |
| **Apply media rules** refuses the media map: *a newer contribution* (`map_contribution_newer`) | another instance on the same publication host runs a newer Dédalo, and the host's shared map renderer predates its map | run `provision apply` of that newer instance on the host: it upgrades the renderer |

## Internals

The maintainer's view of the subsystem — the module map, the three enforcement surfaces kept in
lockstep, the historical bugs the tripwire pins — is in
[media_protection](../core/system/media_protection.md). The authoritative definition, including
the curl verification matrix, is `engineering/MEDIA_PROTECTION.md`.
