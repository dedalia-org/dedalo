# WC-042 — media URLs honor `DEDALO_MEDIA_WEB_BASE` (config-dependent absolute wire URLs)

- **PHP:** every client media URL was built on the constant `DEDALO_MEDIA_URL`
  (= configurable `DEDALO_ROOT_WEB` + media dir) — an install serving media from
  another origin emitted absolute URLs everywhere.
- **TS before this entry:** the base was HARDCODED relative
  (`/dedalo/<mediaDir>`), so an app browsed on one origin (the Bun dev port)
  could never fetch media served on another (the web server enforcing the
  generated protection rules) — images 404'd by design with no configuration
  escape.
- **Now:** `config.media.webBase` = `DEDALO_MEDIA_WEB_BASE` (trailing slash
  stripped; unset/'' → the relative default, i.e. the exact previous shape).
  Emitters on it: the client `DEDALO_MEDIA_URL` plain var
  (resolve/environment.ts), `base_svg_url` (media/svg_overlay.ts wire path),
  `posterframe_url` + `subtitles_url` (media/component_emit.ts + media/path.ts),
  the indexation-grid thumb URLs (section/indexation_grid.ts), the MCP media
  `url` field (ai/mcp/tools/media.ts), and the text_area tag 302 redirect
  (component_text_area/tag_endpoint.ts).
- **Deliberately NOT on it:** persisted content (the SVG envelope's embedded
  raster href stays relative — resolves against the envelope's own fetch
  origin), diffusion/publication output (`svgUrlFromTagLocator`,
  diffusion runner/default_value — published data must not embed a dev origin),
  bare `files_info.file_path` values (the client prefixes those with
  `DEDALO_MEDIA_URL`; absolutizing would double-prefix), inbound route matching
  (server.ts, protection.ts rules), and `DEDALO_MEDIA_EXPORT_BASE` (export cells —
  unchanged semantics: unset means unresolved, never guessed; read via
  `config.media.exportBase`). That key was spelled `DEDALO_MEDIA_BASE_URL` until
  2026-07-25; the two names were indistinguishable, so the pair was renamed to
  state its audience (WEB = the client, EXPORT = what leaves the app) and the old
  spelling is RETIRED (`RETIRED_ENV_KEYS`, refuses the boot). Same value shape as
  `webBase` — origin + `/dedalo/<mediaDir>`, trailing slash now stripped on both,
  since both are prefixed to the same media-root relative `file_path`.
- **Fixtures:** every harvest fixture pins the harvest-era RELATIVE shape, so
  `test/preload/test_database.ts` pins `DEDALO_MEDIA_WEB_BASE=''` for the whole
  suite — gates are hermetic against the developer's .env, no fixture edits.
- `DEDALO_MEDIA_URL` (the v6 constant name) stays DROPPED in
  `config/migration_map.ts`; the new key is a v7-native knob (classified NEW).

### Gate

`test/unit/media_web_base.test.ts` (default shape, builder rooting, fresh-import
override + trailing-slash strip) + the pinned relative shape across the existing
media gates and parity fixtures.

## Addendum 2026-09-01 — the served cell and the published cell are two audiences, not one

`svgUrlFromTagLocator` was one function feeding two consumers with opposite
requirements. The entry above resolved it for one of them and did not see the
other.

**The two shapes.** A `component_text_area` value carries `[svg-…]` marks that
`addTagImgOnTheFly` renders to `<img src>`. That same rendered cell reaches two
places:

- **Published** (diffusion/publication output, `diffusion/resolve/ddo_fns.ts`):
  base stays the root-relative `/dedalo/<mediaDir>`. The URL is PERSISTED into
  data that leaves this application and is fetched by a browser pointed at the
  publication site — it must resolve against that site's origin, and must never
  freeze this engine's origin (on a dev machine, a localhost port) into
  published bytes. Unchanged, byte for byte.
- **App-served** (the list value this engine hands its OWN client,
  `component_text_area/emit.ts` → `renderListString`): base is
  `config.media.webBase`, like every other media URL the client receives
  (`media/path.ts`, `tag_endpoint.ts`, the `DEDALO_MEDIA_URL` client global).
  This URL is not persisted; it is consumed immediately by the browser that
  just loaded the app, whose origin need not be the media origin.

Mechanically: `svgTagRelativePath()` now carries the media-root-relative tail,
and the two exported builders differ ONLY in what they prefix to it —
`svgUrlFromTagLocator` (publication, unchanged output) and
`appServedSvgUrlFromTagLocator` (webBase). One tail, so "same file, two
audiences" holds by construction rather than by two copies staying in step.
`addTagImgOnTheFly`'s default resolver is still the publication one: a caller
that does not state its audience gets the shape that is safe to persist.

**The original bullet was right; its scope was not.** "Deliberately NOT on it:
… `svgUrlFromTagLocator`" was and remains correct for the audience it was
decided for. Published data must not embed this origin — that reasoning is
untouched. The defect was that a second audience existed and went unenumerated:
the app-serving list read path called the same builder, and the entry's emitter
list (which does enumerate `tag_endpoint.ts`, the OTHER text_area media door)
never noticed the pair had been split apart. So this is not an error in the
line; it is a missing row in the emitters list, which this addendum adds:

> Emitters on `webBase`, also: the `component_text_area` LIST cell served to the
> client (`component_text_area/emit.ts` via `appServedSvgUrlFromTagLocator`).

**Measured symptom** (install with app on `:3500`, Apache media on `:8080`,
`DEDALO_MEDIA_WEB_BASE` set). Same path, same session cookie, from the
logged-in browser:

    http://localhost:3500/dedalo/media/svg/web/hierarchy95_scxibo1_59.svg -> 404
    http://localhost:8080/dedalo/media/svg/web/hierarchy95_scxibo1_59.svg -> 200 image/svg+xml

Every glyph in every text_area list cell 404'd — silently, a broken-image
placeholder, nothing in the log, because the app origin serves no media at all
under the generated protection rules.

**Not a PHP regression — a capability-scope correction.** Verified in the frozen
tree: `shared/class.TR.php:367` calls
`component_svg::get_url_from_locator` (`class.component_svg.php:426`) which
instantiates the component and returns `get_url()` (`:233`), whose base is the
constant `DEDALO_MEDIA_URL = DEDALO_ROOT_WEB . '/media'`
(`config/sample.config.php:411`), and `DEDALO_ROOT_WEB` is
`'/' . explode('/', $_SERVER["REQUEST_URI"])[1]` (`:39-42`) — derived from the
inbound request path, always root-relative, with no media-origin concept
anywhere in the chain (`get_url`'s `$absolute` flag prepends
`DEDALO_PROTOCOL . DEDALO_HOST`, the APP host, never a media host). The oracle
therefore emitted the identical relative shape, and a split-origin install was
simply not expressible in PHP. **No regression entry.** The pre-fix TS behaviour
matched the oracle exactly; what changed is that a configuration the oracle
could not express now reaches the emitter that had been left out of WC-042.

**Gate.** `test/unit/text_area_svg_split_origin.test.ts` — the assertion MUST
inject an absolute `DEDALO_MEDIA_WEB_BASE` into a FRESH process
(`Bun.spawnSync` + `bun -e`, the `test/unit/media_web_base.test.ts:33-46`
pattern), because config freezes at first import AND
`test/preload/test_database.ts:38` pins the key to `''` suite-wide. Under that
pin `webBase` is byte-identical to the hardcoded literal, so any assertion
phrased in terms of `webBase` — including the obvious one — passes with the
defect fully intact. The gate pins both halves in the split-origin child: the
served list cell rooted on the absolute base, and `svgUrlFromTagLocator` (the
publication resolver, `test/unit/diffusion_ddo_fns.test.ts:133`) still emitting
`/dedalo/<mediaDir>/…` in the same process.

**Re-harvest: NO.** With the key unset or `''`, `config.media.webBase` computes
to exactly `/dedalo/<mediaDir>` (`src/config/config.ts` ~745-749), so the
app-served cell is byte-identical to the harvest-era shape. No fixture pins an
absolute base and none may; the frozen store keeps the relative shape for both
audiences, and the divergence is reachable only through a configuration the
suite pins shut.

### Left open — publication on a split origin

WC-042's reasoning settles what the published URL must NOT be (this app's
origin). It does not settle what it should be when the publication site itself
serves media from a different origin than its pages: there the relative form
breaks for the published consumer exactly as it broke for ours, and this
addendum does not fix that — it only stops the two cases sharing one builder.

The naive answer ("reuse `webBase`") is wrong: `webBase` is THIS app's client
origin, which is the thing published data must not carry. The instructive
comparison is `config.media.exportBase` (`DEDALO_MEDIA_EXPORT_BASE`), the base
for cells that LEAVE the application: it has **no default**, and unset means
*unresolved*, never guessed — a travelling cell may not carry a relative URL,
because nothing here knows where it will be read. Published tag URLs are
travelling cells by the same argument, yet today they do carry a relative one.
Either that relative form is defensible (the published site serves its own
media, and the tail is correct by construction), or publication needs a third,
target-scoped base with `exportBase`'s never-guess semantics. Not decided here;
no key invented. Whoever hits a split-origin publication site should settle it
in its own entry and cite this paragraph.
## Addendum 2026-10-26 — rich-text `<img src>`: stored relative, served on `webBase` (TODO-067)

The CKEditor image upload (`media/ingest/upload_endpoint.ts`, key_dir `web`)
answers `{ url: <webBase>/image/web/<name> }` — on `webBase` like every client
media URL, so the editor displays the image at once on a split-origin install.
The editor then writes that url VERBATIM into the text_area HTML, which made it
**persisted content** — the "Deliberately NOT on it" row: a record must not
embed the media origin. Same two-audience split as the 2026-09-01 addendum:

- **Stored** (the html write gate, `save_component.ts` `applyWriteValueGates`,
  after the sanitizer): `src="<webBase>/…"` → `src="/dedalo/<mediaDir>/…"`
  (`media/web_base_src.ts` `relativizeMediaSrc`). Every write door funnels
  through it, so a pre-fix record carrying the absolute host is cured on its
  next save.
- **Served** (`component_text_area/emit.ts` `transformValue`, every mode the
  engine emits to its own client): `src="/dedalo/<mediaDir>/…"` →
  `src="<webBase>/…"` (`appServedMediaSrc`). Diffusion does not read through
  the emit hook, so published HTML keeps the relative form.
- **Echoed** (the `save` response, `dd_core_api.ts` `servedRichTextEcho`): the
  stored items rebased like the read. The client takes the echo as its
  post-save change baseline (`component_common.js` `db_data`); a relative echo
  against the editor's absolute src made every later blur re-send a no-op save.

Both are exact `src="<base>/` string swaps and no-ops when the key is unset
(`webBase` IS `/dedalo/<mediaDir>`), so the wire is byte-identical in the
default config. **Re-harvest: NO.**

Gate: `test/unit/text_area_media_src_split_origin.test.ts` — a child process
under an absolute base saves through `dispatchRqo` (the client's door), reads the stored row
(relative), the save echo and the `readSection` EDIT item (both absolute); red
on the pre-fix code.
