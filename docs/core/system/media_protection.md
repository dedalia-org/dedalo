# media_protection

> See also: [Media protection (configuration)](../../config/media_protection.md) · [media_engine](media_engine.md) · [login](login.md) · [security](security.md) · [System hub](index.md)

`media_protection` is the subsystem that makes the **web server** authorize media files:
Apache or nginx answers each request with a single `stat()` on a zero-byte marker file, so
multi-GB media keeps native `sendfile`, `Range` and `?start=` clipping and **no engine process
ever sits in the media byte path**.

This page is the maintainer's orientation — the module map and the invariants that bite. Everything an
administrator needs (modes, keys, web-server wiring, the widget, troubleshooting, verification)
lives on one page and one page only: **[Media protection (configuration)](../../config/media_protection.md)**.
The authoritative subsystem definition, including the curl verification matrix that is its
definition of done, is `engineering/MEDIA_PROTECTION.md`.

## The model in one breath

One media tree, two audiences, no file duplication:

* **Rule A — work system.** A logged-in user carries the fixed-name cookie
  `dedalo_media_auth`; its per-session value must exist as a marker in
  `<media>/.publication/auth/{value}`. Unrestricted access.
* **Rule B — publication.** An anonymous user reads only **published** records, only inside the
  configured public quality folders. The web server stats
  `<media>/.publication/pub/{section_tipo}_{section_id}`, with the record identity parsed out of
  the media **file name**.

Everything fails **closed**, and denies as **404, never 403**. Rule A markers are independent of
publication state, so a diffusion failure can never lock editors out.

## Module map

| Module | Owns |
|---|---|
| `src/core/media/protection.ts` | The engine: mode resolution, the public-quality filter, the rule-file templates and their idempotent write, the `auth/` markers. |
| `src/core/security/auth.ts` | The login hook `issueSessionMediaKey()` — mints THIS SESSION's value, lays its marker, refreshes the rule files, returns the value to set (it is then stored on the session row). |
| `src/server.ts` | Boot-time `writeRuleFiles()`, and the `Set-Cookie` assembly (`HttpOnly; SameSite=Lax; Path=/`, `Max-Age` = the session idle window, `Secure` when the session cookie is secure) — plus the per-request re-issue below. |
| `src/core/security/session_media.ts` | The one door that ENDS a session: `endSession` / `endUserSessions` / `sweepExpiredSessions` delete the row **and** unlink the marker it freed. Nothing in `src/` should call `destroySession` / `pruneExpiredSessions` directly. |
| `src/diffusion/targets/mediastore/media_index.ts` | The rule-B marker **writer**: `pub/` and `dbs/`, and the `rebuild`/`reconcile` resync. |
| `src/core/area_maintenance/widgets/media_control.ts` | The admin widget: status, the **root-only** mode switch, *Rebuild media index*. |

**Marker-store ownership is exclusive.** Under `<media>/.publication/`, `auth/` belongs to
`protection.ts` and nothing else; `pub/` and `dbs/` belong to `media_index.ts` and nothing else.
Crossing that line is a bug.

## Invariants that bite

!!! danger "Three enforcement surfaces must stay in lockstep"
    The file name grammar is stated in three places: the generated Apache rules, the generated
    nginx rules, and `KEY_REGEX` / `makeMarkerKey` in `media_index.ts`. If they disagree, the
    gate either stats a marker nobody writes (every published record 404s — annoying but
    visible) or parses a file name into the **wrong record** and serves a file that was never
    published. `test/unit/media_protection_tripwire.test.ts` enforces the lockstep
    mechanically: it pulls the regexes back out of the generated text, compiles them, and
    asserts that all three classify the same table of real file names identically.

The grammar's **greedy prefix** pins the captures to the last two underscore tokens, so a
component `tipo` — which also contains underscores — can never be read as the section `tipo`:

```text
...{component_tipo}_{section_tipo}_{section_id}[_lg-xxx].{ext}

[^/]*_([a-z0-9]+)_([0-9]+)(?:_lg-[a-zA-Z0-9-]{2,12})?\.[A-Za-z0-9]+$
```

Files that do not parse (images renamed through `properties.image_id`, external sources) stay
**login-only by design**. Never loosen the regex to "fix" them — that hands anonymous users
every unparseable file in a public quality folder.

Rich-text images are named INTO the grammar at upload: the editor's upload names the file
`<name>[-n]_<section_tipo>_<section_id>.<ext>` after the record whose text it goes into (the
endpoint asks the write door for that record's `component_text_area` first), and
`image/<DEDALO_IMAGE_WEB_FOLDER>` is a default public quality. Rule B, the markers and the
publication-host copy then treat it like any other derivative. Older unkeyed names stay
login-only until the `rich_text_images` reconcile (root-only apply) copies them to keyed names and rewrites
their `src`; `web_image_exposure` (dry at every boot) lists web-folder names that parse to a
published record which does not embed them — public for no reason — and its root-only apply
renames them out of the grammar (`<stem>.legacy.<ext>`; `src/core/media/rich_text_image_reconcile.ts`).

Other invariants the gates pin, each of which shipped as a real bug or a near miss:

* **The cookie NAME is fixed; only the VALUE changes (one per session).** That is what lets the
  generated rules stay static and lets nginx accept every new session with no reload — the rules never name a
  value, only the marker whose file name *is* the value.
* **Apache rule B backreferences `$1_$2`, not `%1_%2`**, and its `RewriteRule` must stay
  immediately after its `RewriteCond`.
* **The nginx rule-A location is a plain prefix.** A `^~` there would make nginx stop before
  ever consulting the rule-B regex location, and every anonymous request for published media
  would 404.
* **nginx rule B uses named captures.** The inner `if (-f …)` runs its own regex and resets the
  numeric captures, so a rule built on `$1`/`$2` would stat `pub/_` and deny everything.
* **Master qualities can never enter the public list**, whatever the configuration says — the
  literal `original`/`modified` plus this install's configured original quality per media type.
* **The script-execution hardening and the marker-store deny are emitted in every mode,
  including `off`**, and `off` never unlinks a rule file.
* **The credential is per session, and the marker set is a projection of the sessions table.**
  Every way a session ends unlinks its marker, which is what makes logout and a password reset
  actually revoke media access.

## The cookie's life is the session's life

The Rule-A cookie is **re-issued on any authenticated request** whose value is missing or is
not this session's key, with `Max-Age` = `SESSION_TTL_SECONDS`. In the steady state that costs
one string compare against a value already on the session row — no filesystem read, no write.

!!! danger "Why this is not an optimisation"
    The cookie used to be minted **only at login**, with a fixed `Max-Age=86400`, while the
    session refreshed on every request. That broke in both directions:

    * **Logged in longer than a day** → the browser dropped the cookie while the session
      stayed perfectly valid. Because the *web server* enforces the gate, **every image,
      video, PDF and 3D file 404'd while the application itself looked completely healthy.**
      Rule B cannot cover for it: with no publication markers it never matches, so Rule A is
      the only door.
    * **Just before logout** → a freshly minted cookie stayed a valid media credential for up
      to 48 hours with no session behind it.

    Tying the two together removes both. Gate:
    `test/unit/media_protection_cookies.test.ts`.

## Logout revokes it (2026-08-24)

Logging out unlinks **this session's** marker and no other, and a password reset unlinks every
marker belonging to that user. Both go through `src/core/security/session_media.ts`.

!!! danger "The rule this replaced, and what it cost"
    The value used to be one per **install per day** — every logged-in editor held the
    identical cookie. So logout could not unlink the marker (it would have logged every other
    editor out of the media tree), and the price was that a stolen cookie kept working for up
    to **48 hours** across a logout *and* a password reset, entirely outside the session
    store's reach. A recovery flow whose whole purpose is to cut off whoever holds a stolen
    token could not cut off one of the two credentials it had issued.

    Making the value per-session is what makes revocation possible without collateral.
    Gate: `test/unit/media_session_revocation_native.test.ts`.

## A separate publication server with shared media storage

When the public website runs on another machine that reads the same media storage
(work server read-write, publication server **read-only**), the publication server needs
its own media rules: it must serve only published files, and it must never accept the
work system's login cookie.

1. **Export only what is public**, read-only (`ro,root_squash`): the public quality
   folders and `.publication/pub/`. Never the originals, `.publication/auth/` or
   `.publication/dbs/`. Mount them on the publication server under one directory, keeping
   the same layout (for example `/srv/dedalo_media_ro/image/thumb/…`).
2. **Mount `.publication/pub` without attribute caching** (`lookupcache=none,noac` on
   NFS, `actimeo=0` on SMB), or an unpublished file stays visible for up to a minute.
3. **Render the rules on the work server:**

   ```bash
   bun run media:publication-host-rules --root /srv/dedalo_media_ro --out dedalo_media_publication.conf
   # nginx: --server nginx, plus --server nginx-map for the http{} include
   ```

   On a publication host provisioned with `provision init`, the `http{}` map is pushed by **Apply media rules** into the host-wide include and must not be placed by hand; the manual path below still applies to work hosts and hand-provisioned publication hosts. That one map serves every
   instance on the host: each instance's agent hands in its part and a root service on the host
   renders the shared file, so two instances never define the same variables twice
   ([publication host agent](../../install/publication_host.md#9-map-the-apis-into-the-sites-virtual-host)).

   Any refused quality folder (an original or a bare type folder) is named on screen.
4. **Install on the publication server.** For Apache, `Include` the file inside the
   website's virtual host, before any other `/dedalo` alias, then run
   `apachectl configtest && apachectl graceful`. For nginx, include the map in `http{}` and
   the rules in `server{}`, then run `nginx -t && nginx -s reload`. Do not mount the media
   under the website's document root: keep it in a folder of its own (for example
   `/srv/dedalo_media_ro`). The nginx rules take every `/dedalo/media/` request for
   themselves, so your own caching rules for images or video do not apply to these
   files.
5. **Check:** a published image answers 200; an unpublished one answers 404, even when you
   are logged in to the work system.

Media keeps the same URL (`/dedalo/media/…`) on both servers, so published records and the
Publication APIs need no change. Re-render and reinstall when the public quality folders change.

With a paired [publication host agent](../../install/publication_host.md#the-publication-hosts-panel),
the **Publication hosts** panel does steps 3 and 4 for you: it renders the rules for the
host's own web server and mount, sends them, and shows whether the installed rules are still
the ones the work system would generate. On nginx, a host provisioned with `provision init`
(or declared with `"nginx_map": "conf_d"`) gets the `http{}` map pushed the same way, before the
rules; on any other publication host the map include of step 4 stays manual. Step 5 stays a
manual check.

## Related

* [Media protection (configuration)](../../config/media_protection.md) — the operator's page:
  modes, keys, web-server wiring, the widget, verification, troubleshooting.
* [media_engine](media_engine.md) — how the files being protected are produced and named.
* [login](login.md) — the authentication path that mints the cookie.
* [security](security.md) — the in-application permission layer; media protection is the
  web-server layer in front of the file tree.
* [Media pipeline](../../development/media_pipeline.md) — where this sits in the whole media flow.
