# WC-2026-08-09-ingest-companions-and-human-filename — an upload honours its ontology properties GENERICALLY, and carries the curator's file name

- **Date:** 2026-08-09 (audits/2026-08_oh1_beta REPORT §5.2, the ingest half:
  *"`properties.additional_path` is resolved by nobody"*, *"Upload ignores
  `properties.target_filename` and `target_duration`, so 'Original filename'
  (rsc398) and AV 'Duration' (rsc54) stay empty forever and the oh media-icons
  widget shows `00:00:00.000`"*, *"Upload loses the human filename, persisting
  the sanitized server-allocated staged name"*). Workstream M5-ingest.
- **Decision:** DEC-15 (the four deliberate deltas below), DEC-12 (gate in the
  same change: `test/unit/media_ingest_properties_native.test.ts`).

Most of what this change does is RESTORATION and needs no ledger entry: the
`additional_path` resolution, the two companion writes and the `file_data.name`
key are all PHP behaviour the rewrite dropped. This entry exists for the four
places where the restoration is deliberately NOT byte-for-byte.

## Shape before (PHP)

1. `component_media_common::get_additional_path` (`:753-819`) resolves
   `properties.additional_path` — a tipo naming another component on the same
   record — instantiates it at `DEDALO_DATA_NOLAN`, trims its value, forces a
   leading slash, strips a trailing one, and uses it as the bucket folder; only
   when that is empty does it fall back to
   `'/' . max_items_folder * floor(section_id / max_items_folder)`.
2. `process_uploaded_file` writes the companion fields — but only in THREE of the
   five media classes, copied by hand into each:
   `component_image:802-830` (`target_filename` only),
   `component_av:1188-1236` (`target_filename` + `target_duration`, the latter
   `get_duration($quality)` → `OptimizeTC::seg2tc`),
   `component_pdf:382-399` (`target_filename`, and with a shape bug:
   `set_data($original_file_name)` passes a bare string where every other caller
   passes `[{value, lang}]`). `component_svg` and `component_3d` have no copy at
   all, so the same property on such a node is silently ignored.
3. `dd_utils_api::upload` (`:1259-1272`) returns
   `file_data->name = $file_name` — *'My Picture 1.jpg'* — alongside
   `file_data->tmp_name`, the staged segment. `join_chunked_files_uploaded`
   MUTATES the client's own `file_data` and returns it, so `name` survives the
   join as whatever the client relayed. Neither door defangs it.

## Shape before (TS, the defect)

`MediaPathOptions.additionalPathOverride` was declared and set by NOBODY; the
companion properties were read by nothing; and `file_data` carried no `name` on
either door, so `tool_upload` fell back to `file_data.tmp_name` and the archive
recorded `Mar_a_Pi_n.mp4` for a file uploaded as `María Piñón.mp4`.

Measured: `rsc33`/`rsc324` (the two `additional_path` siblings in the shipped
ontology) hold no value on any record of `dedalo7ts` or `dedalo7_mht`, so on THIS
install the bucket fallback is what both engines compute and the gap is latent —
which is why it survived a first verification pass. It is not latent on an
install that uses the property: every PHP-era file of `rsc29` / `rsc37` / `rsc165`
/ `rsc855` there is unreachable from the TS engine.

## Shape after (TS) — four deliberate deltas

### 1. The companion writes are GENERIC, keyed on the property

`src/core/media/ingest/companion_writes.ts` performs them for ANY media model
whose node declares the property. PHP would ignore `target_filename` on an
`component_svg` node; the TS engine honours it.

The property IS the declaration of intent — the three PHP copies are an accident
of where somebody stopped copying, not a rule, and reproducing the gap would be
an over-strict whitelist masquerading as parity (the same defect class this
audit already found in `record_defaults`). The pdf copy's bare-string `set_data`
is likewise not reproduced: every write goes through the one `[{value, lang}]`
shape, via `saveComponentData` (transaction + Time Machine audit).

Both writes OVERWRITE, as PHP's do: the fields state which file the record's
media came from, so a re-upload must restate them. (This is the opposite of
`tool_import_files`' `target_filename` ROLE, which fills only when empty — there
the value is matching input a curator may have edited.)

`lg-nolan` is kept from the oracle even though the target may be translatable:
PHP instantiates the target at `DEDALO_DATA_NOLAN` unconditionally, and every
target in the shipped ontology is non-translatable, so the two readings coincide.

### 2. A zero-length duration is REPORTED, not just recorded

PHP's `get_duration` returns `0.0` when ffprobe yields nothing, and `seg2tc(0)`
persists `00:00:00.000`. The stored bytes are unchanged here — the value is still
PHP's — but the ingest ALSO returns a message saying a zero-length reading was
recorded, rather than letting it look like a successful measurement. The message
travels on `IngestResult.derivativeErrors`, whose documented meaning is widened
in the same change from "derivative build failures" to "every non-fatal
post-move failure"; `tool_upload` already surfaces that array in `msg` and
`errors[]`, so a companion failure is wire-visible where before it did not exist.

### 3. The chunked join takes `name` from the SERVER, and both doors defang it

- PHP's join returns the client-relayed `name`. TS records the human name in the
  transfer's own `meta.json` when the first chunk arrives and returns THAT, for
  the same reason the staged-name proposal is already server-recorded
  (WC-2026-08-03-chunked-upload-identity): the archive must record the name the
  parts were actually uploaded under, not one a later request asserts.
- `displayFileName` (`ingest/upload.ts`) strips any directory prefix (both
  separator conventions — a Windows client sends `C:\Users\…\María.jpg`), C0/C1
  controls and NUL, trims, and caps at 255 characters. It NEVER transliterates:
  accents, spaces and CJK survive intact, because this value is provenance, not
  a path. PHP stored it raw. An empty residue becomes `upload.bin` rather than an
  empty provenance field.
- A transfer whose parts were staged by an older server has no `name` in its
  meta; it degrades to the staged proposal rather than invalidating the meta,
  so an upload in flight across a deploy still joins.

The sanitized staged name is unchanged and still governs the FILESYSTEM
(`stagedTmpName` → `claimStagedName`). The point of the change is that the two
concerns no longer share one string.

### 4. The ARCHIVE takes the name from the SERVER's staging area, not from the wire

**Added 2026-08-09, second pass.** Delta 3 restored the wire key and stopped
there — and a verification pass proved that half dead: `file_data.name` was
emitted by both doors and read by NOBODY. The ingest is a SEPARATE, LATER request
(`tool_upload::process_uploaded_file`, `tool_import_files`, the MCP media tool),
each of which builds its `processUploadedFile` call from `file_data.key_dir` /
`tmp_name` / `extension` and no name at all. So the archive kept recording
`Mar_a_Pi_n.jpg` while the transport carried the right value past it. A fix
nothing calls is not a fix.

Making the three callers relay it would have been the smaller change and the
wrong one, for the reason already written into delta 3: a name relayed by the
client is re-decidable by a later request, and it makes the archive's provenance
depend on every caller — present and future — remembering to forward a key.

So the RECEIVER persists the display name beside the staged file, and the INGEST
reads it back: `src/core/media/ingest/staged_name_record.ts`, one file per staged
name under `<staging dir>/.names/<staged name>`, written at the moment the staged
name is claimed on BOTH doors (single-shot `receiveUpload`, and `joinChunkedUpload`
— where it is the last moment the value exists, since the artifact dir holding
`meta.json` is deleted immediately after). It is the same law that already governs
the staged-name proposal (WC-2026-08-03-chunked-upload-identity): *the name on
disk must not be re-decidable by a later request*, extended across the one request
boundary it did not yet cross.

`humanFileNameOf` therefore has THREE ranks — an explicit caller name (only
`tool_import_files` supplies one), then the server's record, then the staged name
for a file the server has no record of receiving (an out-of-band drop, or one
staged by a server older than this change). Rank 3 is a real fallback and stays.

Divergence from PHP: PHP had no such store, because its `process_uploaded_file`
read `$_REQUEST['file_data']->name` straight from the relayed blob. The stored
VALUE is the same one PHP stored; what differs is where it comes from, and that
it no longer depends on the client. The record is written with the one atomic
writer (`media/atomic.ts`), never outlives its file (dropped by the ingest that
consumes the file and by `deleteStagedFile`), and is swept by `staging_gc.ts` on
the existing 24 h retention rule if anything removes a staged file without going
through either.

STILL OPEN, and named rather than implied: `persistUploadedMedia`'s
`original_file_name` key is passed by the CALLERS, and `tools/tool_upload` still
passes `String(fileData.tmp_name ?? …)` while `src/ai/mcp/tools/media.ts` passes
`result.originalFileName` (the deterministic identifier). Both should read
`result.humanFileName`, which is now correct at the ingest boundary. Those files
belong to other workstreams; the `target_filename` companion — the field the audit
names, and the one the oh media-icons widget reads — is fixed here.

## Reason

An oral-history archive's `rsc165` is the Certificate of Cession and the
Questionnaire — the consent paperwork. Writing those where PHP would not put them
means a migrated install cannot find its own consent files, and the `rsc398` /
`rsc54` fields are what the oh media-icons widget reads: with nothing writing
them, every TS-ingested interview showed a blank filename and a zero duration
forever. The human filename is the only surviving record of what the curator
actually delivered, since the file itself is renamed to a deterministic
identifier on ingest.

## Gate reconciliation

- `test/unit/media_ingest_properties_native.test.ts` — the gate, 27 cases.
  Headlines: an ingest handed the SECTION-scoped options `tool_upload` supplies
  today still lands its file in `/image/original/cession_files/` (verified RED
  before the change); an AV ingest of a real 1-second mp4 on a scratch `rsc167`
  record fills `rsc398` with `María Piñón entrevista.mp4` and `rsc54` with a real
  time code (RED before: both empty). Also pins the PHP slash normalisation
  including the escaping-value refusal, the three states of
  `additionalPathOverride`, the generic property extraction, the live ontology's
  declarations, `displayFileName`'s defang-without-transliterate rule, and the
  server-recorded name surviving a chunked join against a misleading client hint.
- **THE WIRE DOORS ARE GATED BEHAVIOURALLY TOO** (delta 3). The `file_data.name`
  key was first pinned by a source regex (`/name:\s*received\.name/`). That is not
  a gate: it stays green if the key is emitted but always null, and it reddens
  when somebody renames a local. It is replaced by two cases that POST
  `María Piñón.jpg` through `handleRequest` — the real route — and assert
  `file_data.name` on the single-shot response and on the
  `join_chunked_files_uploaded` response, the latter with a MISLEADING name
  relayed in the client's own `file_data` (the join must answer from its
  server-side meta), while `tmp_name` stays inside the filesystem-safe charset.
  Verified red four ways: dropping the key at either door, emitting `tmpName`
  under it at door 1, and making the join trust `fileData.name` at door 2.
  These are the only cases in the file that touch the CONFIGURED media root — the
  endpoint takes no root override, which is what makes them end to end — and they
  are confined to their own staging user, torn down whole before and after.
- **THE INGEST DOORS ARE GATED BEHAVIOURALLY, NOT BY SOURCE TEXT** (delta 4). Two cases
  stage bytes through the REAL receiver — `receiveUpload` for the single-shot
  door, two chunks + `joinChunkedUpload` for the other — and then call
  `processUploadedFile` with EXACTLY the arguments `tool_upload` builds today (no
  `originalFileName`), asserting the scratch record's `rsc398` reads
  `María Piñón.jpg`. That is the assertion the previous pass did not have: its
  gate supplied `originalFileName` directly, a path no live caller takes, so it
  stayed green while the defect was fully live. Six further cases pin the rank
  order (an explicit caller name still wins), the rank-3 fallback for a file the
  server has no record of, that the record is CONSUMED by the ingest and never
  listed as a staged file of its own, that `deleteStagedFile` drops it with the
  file, that the staging sweeper collects an orphaned one on age and never a live
  one, and that `processUploadedFile` is the ONLY caller of `addFile` in `src/`
  — so a second ingest door cannot appear that bypasses the recovery.

  ELEVEN LINKS, THIRTEEN PROBES. Each link was verified RED by reintroducing its
  defect one at a time, with the tree restored bit-identically (checksummed)
  between probes: dropping the record call at ingest door 1 (4 tests red), at
  ingest door 2 (1), the read in the ingest (3), rank 2 of `humanFileNameOf` (2),
  rank 1 (3), the consume (1), `deleteStagedFile`'s drop (1), the sweeper's prune
  call (1), adding a second `addFile` caller (1), and the four wire-door probes
  above (1 each). Re-measured independently on 2026-08-09 with exactly these
  counts — no link is carried by another link's assertion, and no case is vacuous.
- **THE SHRINK-ONLY EXEMPTION LIST.** `SECTION_SCOPED_PATH_OPTION_CALLERS`
  (`src/core/media/ontology_path.ts`) names every module that still resolves media
  path options WITHOUT a section_id, each with its reason; the gate scans `src/`
  and asserts the set of such call sites equals it EXACTLY. A new section-scoped
  call site reddens; a migrated one must be struck from the list in the same
  change. NINE entries today, one of which (`section/indexation_grid.ts`) is not
  debt — it resolves the property itself for the oracle-pinned export grammar.
  Until the other EIGHT migrate, those READ paths still compute the numeric
  bucket, and this is a WRITE/READ DISAGREEMENT, not "unchanged behaviour": a
  freshly ingested file of a component whose `additional_path` sibling holds a
  value is written to the NAMED bucket while `media_action_context.ts` (the crop
  / rotate / delete tools), `media/component_emit.ts` (posterframe_url,
  base_svg_url), `media/repair.ts`, `section/record/duplicate_record.ts` and
  `ai/rag/image_source.ts` still look for it in the numeric one. Each of those
  paths is individually unchanged; together with the corrected write they now
  disagree where before they agreed on the same wrong answer. Latent on this
  install (`rsc33`/`rsc324` hold no value on any record of `dedalo7ts` — measured
  `count(*) = 0` for both keys), and the list is exactly what stops that being
  forgotten. `media/file_ops.ts` was on the list for a few hours on 2026-08-09
  and the media-lifecycle workstream took it off; that is the intended lifecycle.
- **No re-harvest.** The frozen oracle store holds no upload fixture — the write
  path was never harvestable — and the PHP shapes above are recorded from the
  frozen source as fossils.
- `media_ingest.test.ts`, `media_upload.test.ts`, `media_upload_endpoint.test.ts`,
  `media_ingest_derivative_failure.test.ts`, `tool_upload.test.ts`,
  `media_files_info.test.ts`, `media_thumb_consistency.test.ts` and the tripwires
  around them stay green unchanged, and for a precise reason: those tests PLANT a
  file in the staging dir instead of receiving it, so the server has no record of
  it and rank 3 (the staged name) still applies — exactly the out-of-band case
  the fallback exists for.
- The record is written through `writeAtomicallySync` (`media/atomic.ts`) rather
  than a hand-rolled temp+rename. `media_writer_discipline_tripwire` scans
  `src/core/media/**` and bans both shapes outside that writer; the alternative
  would have been a new exemption entry, and an exemption for a case the one
  writer already handles is a hole, not a carve-out.

## Addendum 2026-11-22 — §2 superseded: an unmeasurable duration writes NOTHING (T2-WID-3)

- **Shape after:** a file whose duration ffprobe cannot read (or that reports none) leaves the
  `target_duration` component untouched; the message says `nothing was written`. PHP's
  `00:00:00.000` is no longer stored (owner FYI-5, C52 — a zero is a fabricated measurement).
  See WC-2026-11-22-media-icons-tc. Gate: `test/unit/media_icons_tc_native.test.ts` (the
  unreadable-file leg, through the update_cache regenerate that re-runs the same companion).
