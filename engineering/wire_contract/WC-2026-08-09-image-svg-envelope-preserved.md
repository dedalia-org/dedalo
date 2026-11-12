# WC-2026-08-09-image-svg-envelope-preserved — component_image: the SVG envelope is written, and never destroyed by a rebuild

- **Date:** 2026-08-09, adopted with the M6-lifecycle wave of the
  `audits/2026-08_oh1_beta` remediation (§5.2, the lifecycle half).
- **Decision:** no DEC- reference. It follows the Original law's posture —
  a derivative pass may rebuild what it generated, never what a person authored.

## Shape before (PHP)

The image edit view loads its raster through an SVG ENVELOPE
(`<object type="image/svg+xml" data="{base_svg_url}">`), and the vector editor's
annotation layers ("Capas de dibujo") live in that same file. Two behaviours
shaped it:

1. **The envelope was written from the client's payload, verbatim.**
   `component_image::save()` (class.component_image.php:119-133) looked for a
   `svg_file_data` key on each saved data item — a temporal container the client
   fills from `project.exportSVG()` / `stage.getSvgString()` — and passed it to
   `create_svg_file()`, which is a bare
   `file_put_contents($path, $svg_string_node)` (:987). Any bytes the client sent
   became the served file.

2. **Every regenerate destroyed it.** `regenerate_component` (:1501-1513)
   `unlink`ed the envelope and wrote the DEFAULT template back — an `<svg>` with
   one `<g id="raster">` and nothing else.

The TS engine had inherited only the second half: `createDefaultSvgFile` wrote
the default template over whatever was there, `regenerateImage` called it on
every rebuild (a retouched master deleted, a master replaced, the tool's
Regenerate, the post-delete tier resync in `media/tools/versions.ts`), and
NOTHING anywhere wrote `svg_file_data` at all. So the annotations existed in
`lib_data` and in no file the image was ever shown through.

## Shape after (TS)

`src/core/media/svg_overlay.ts`:

1. **`writeSvgEnvelope(spec, identity, pathOpts, svgString)`** persists the
   client's layers at the envelope path — atomically, confined to the media root,
   and **REFUSING** a payload that is not drawing markup: `<script>`,
   `<foreignObject>`, `<iframe>/<embed>/<object>/<animate>/<set>/<handler>`, a
   `DOCTYPE` or `ENTITY` declaration, an inline `on…=` handler, a
   `javascript:` / `data:text/html` / `vbscript:` URL, a payload over 8 MB, or
   anything whose root is not `<svg>`. A refusal THROWS; nothing is stripped and
   nothing partial is written. `svgFileDataOf(item)` is the one reader of the
   `svg_file_data` temporal container.

2. **`createDefaultSvgFile` no longer overwrites an existing envelope.** Absent
   (or unreadable, or not an `<svg>` at all — debris, not scholarship) it writes
   the default template exactly as before. PRESENT, it keeps every node and only
   re-points the raster: the root `<svg>`'s `width`/`height`/`viewBox` and the
   first `<image>`'s size and `xlink:href`/`href` (`repointEnvelopeRaster`,
   exported and unit-tested as a pure function). Layer COORDINATES are never
   rescaled — a transform invented for them would move a curator's marks off the
   features they annotate, silently.

No API response changes shape. The observable difference is `base_svg_url`'s
FILE: after a rebuild it still carries the annotation layers, where PHP's
would have carried the bare raster group.

## Reason

Two different things were wrong and only one of them is a port defect.

**The rebuild.** On a heritage image an annotation overlay is scholarship — a
curator's marks ON the object, made once, in front of the object. The layer JSON
survives in `lib_data`, so the record is not unrecoverable; what a rebuild
destroyed is the RENDERED overlay, which is the only form in which anyone ever
sees it. No derivative pass has standing to decide that is disposable, and the
passes that called it are routine: deleting a retouch, replacing a master,
clicking Regenerate. Preserving costs a read and two regex substitutions.

**The refusal.** This is the ONE file under the media root whose bytes come from
a client, and it is served back to browsers from the media origin. In the
documented production topology media is served by the web server from the
generated access rules (`core/media/protection.ts`), which emit access control
and NO headers — so the Bun route's envelope CSP is not there to catch anything,
and `file_put_contents` of a client string is a stored-XSS surface on the media
origin. Porting PHP's write verbatim would port that with it.

It refuses rather than sanitizes because a real vector-editor export contains
none of these constructs: a payload that carries one is not the drawing it claims
to be, and silently deleting part of an operator's save is precisely the
"plausible-but-narrowed result" this codebase forbids. `lib_data` — the layers'
source of truth, which the editor reloads from — is untouched either way, so a
refusal costs the rendered overlay of THAT save and never the annotation data.

## Gate reconciliation

No re-harvest. No parity gate covers `base_svg_url`'s file CONTENT (the harvest
records the URL, which is unchanged), and no recorded PHP response shape is
contradicted.

Gated by `test/unit/media_lifecycle_native.test.ts` (the "component_image SVG
envelope" describe): the writer persists the client layers and the read then
offers the URL; each refusal class rejects and leaves NO file; a regenerate over
an annotated envelope keeps the layer nodes and re-points a drifted raster href;
an absent envelope still yields the default; an empty/garbage one is replaced.
`test/unit/media_regenerate_thumb.test.ts` and `media_files_info_repair.test.ts`
continue to pin the create-when-absent path.

## Addendum 2026-08-09 — where the writer is wired

The entry above described `writeSvgEnvelope` as if landing it were the whole
change. It was not: for a few hours the function existed with **no production
call site at all**, so the engine's behaviour was unchanged — `svg_file_data`
still arrived on every vector-editor save and was still dropped. The wiring is
part of the divergence and belongs in the record:

`section_record/record_write.ts persistRecordKeys` — THE key-write chokepoint —
calls `persistSvgEnvelopesForKeys(target, savePath)` for any write touching the
`media` column, BEFORE the row write. That is PHP's own placement
(`component_image::save()` calls `create_svg_file()` and only then
`parent::save()`), so a refused payload fails the save rather than following it,
and the transaction rolls back with no file and no row change.

It hangs off the chokepoint rather than off `saveComponentData` because PHP's
hook is on the COMPONENT SAVE, which every door reaches: the client API, the MCP
tools, the agent change-plan, the CSV and media imports. The hook is a no-op for
every non-`media` write (column-gated before the module is even imported), for
non-image media components, and for items carrying no `svg_file_data`.

Gate: `test/unit/media_lifecycle_native.test.ts`, describe *"the delete and save
DOORS reach the media lifecycle"* — `saveComponentData` on a scratch `test3`
record writes the envelope at the record's own path on the real media root, and
a hostile payload REJECTS the save with nothing written and nothing stored.
Both cases go red if the chokepoint call is removed.

## Addendum 2026-10-23 — the drawing goes with the last file

The envelope policy above retires the FILE when the record holds no media file,
but the drawing lived in the DB too (`lib_data` and the `svg_file_data` temporal
container). The delete left them behind, and the next upload — whose
`persistUploadedMedia` preserves `lib_data` by design — loaded the old vectors over
the new picture (MEASURED on rsc29_rsc170_463941: new original/1.5MB/thumb files,
old ellipses/rect still in `lib_data`, the annotated envelope in `svg/…/deleted/`).

`deleteAndResyncCore` now returns `noMediaFilesLeft` (the same `managedFileSlots`
census that retires the envelope). The media-versions delete passes it to
`reconcileStoredFilesInfo` as `resetDrawing`; the same locked transform writes
`lib_data: null`, drops `svg_file_data`, and appends the cleared value to the Time
Machine (`recordTimeMachine`) in the same transaction. Build/rotate/sync never set
the flag. No API response changes shape; the observable difference is the stored
item after a full delete, and the editor opened after a later upload.

Gate: `test/unit/media_drawing_reset.test.ts` (DB + TM row), the pure
`resetDrawing` cases in `test/unit/files_info_persist.test.ts`, and the
`noMediaFilesLeft` census in `test/unit/media_two_masters.test.ts`.

**Amended 2026-11-12 (T1-22):** a DUPLICATE keeps the layers too — the clone's envelope is
the source's (file, else `svg_file_data`) with only the raster href repointed at the clone
(`WC-2026-11-12-duplicate-image-svg-envelope`).
