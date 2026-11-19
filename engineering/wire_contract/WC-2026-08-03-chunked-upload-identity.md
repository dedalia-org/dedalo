# WC-2026-08-03-chunked-upload-identity — staged-upload identity, whole-file join verification, and orphan-part collection

**Date:** 2026-08-03. Adopted ahead of the phase that moves `tool_import_files`
onto the chunking upload client (`DEDALO_UPLOAD_SERVICE_CHUNK_FILES`, default
`4` MB — `src/config/catalog/media.ts:951`). Until now `tool_import_files` never
chunked, so the chunked receive path carried only ad-hoc traffic; from that
phase on it carries the entire media-ingest corpus of the repository. The three
defects below had to be closed BEFORE any consumer can chunk, not after.

**Decision:** no DEC- reference; this is the media-ingest half of the chunking
migration. It touches the upload wire in three additive places and changes the
meaning of one existing field, all recorded here.

## Shape before (PHP)

PHP `dd_utils_api::upload` (:925) staged a chunk as
`DEDALO_UPLOAD_TMP_DIR/<user>/<key_dir>/<i>-<basename>.blob` and
`join_chunked_files_uploaded` (:1379) concatenated `0..n-1`, re-sniffed with
finfo (SEC-066, :1481-1498) and renamed the result to `<basename>`. The staged
identity WAS the file name, per chunk; there was no transfer id on the wire, and
`file_data` carried `{key_dir, tmp_name, extension, chunked, chunk_index,
total_chunks, complete, thumbnail_url}`. Nothing collected the parts of a
transfer that never joined.

The TS port reproduced that shape, with one hardening (`stagedTmpName`:
everything outside `[A-Za-z0-9_.-]` became `_`) and one DOS-03 fix (2026-07-28:
the join's re-sniff reads only the leading 8192 bytes instead of the whole file,
which at multi-GB sizes doubled RSS and could OOM the server).

## Shape after (TS)

### 1. `file_data.upload_id` — NEW, the transfer identity

Every upload response now carries `upload_id: string|null`. The client MAY send
it as a new multipart field `upload_id` on every part of a transfer; when it
does, that value is the identity. It round-trips without any client change on
the join, because `upload_transport.js` forwards the LAST chunk's `file_data`
verbatim into `join_chunked_files_uploaded`.

It is UNTRUSTED input that becomes a path segment, so it is **validated and
refused**, never sanitized: `^[A-Za-z0-9_-]{8,64}$` (`UPLOAD_ID_PATTERN`). A
`../`, a `/`, a NUL, a 4 KB id or a 3-character id is a `400` with the standard
rejection body, and NOTHING is written — the identity is resolved before the
staging directory is even created.

**Requested client contract** (the client is owned by another agent; this entry
specifies it, the server already accepts it):

| What | Value |
|---|---|
| Field name | `upload_id` |
| Format | `crypto.randomUUID()` with the dashes stripped, or any `[A-Za-z0-9_-]{8,64}` |
| Requests | EVERY part POST of one transfer — chunked and single-shot — with the SAME value for every part of the same file, a NEW value per file and per retry-from-scratch |
| Join RQO | nothing to do: `file_data` is already forwarded verbatim and now carries `upload_id` |
| Cancel (optional) | `dd_utils_api::delete_uploaded_file` accepts an optional `upload_id` alongside `{key_dir, file_name}`; sending it on `removedfile`/`abort()` frees a cancelled transfer's bytes immediately instead of at the 24 h sweep |

**Without the field** (every currently deployed client) the receiver DERIVES the
identity: `sha256(key_dir ␠ raw file name ␠ total_chunks)`, truncated. That is
stable across the chunks of one transfer with no client coordination, and —
unlike the staged-name transform — it distinguishes `María.jpg` from `Mar#a.jpg`
because it hashes the RAW name before any sanitizing. The one case it cannot
resolve is two transfers of the SAME raw name into the SAME `key_dir` at the
same time (two tabs, the same file); that residue is exactly what the client
field closes, and it is why the field is requested rather than merely allowed.

### 2. `file_data.tmp_name` on a COMPLETE upload is now SERVER-ASSIGNED

`stagedTmpName` is not injective (`María.jpg` and `Mar#a.jpg` both → `Mar_a.jpg`).
Single-shot that silently overwrote one file with the other — data loss. Chunked
— i.e. every upload, from the next phase on — the two transfers' parts
interleaved under one name, the join concatenated whichever parts won, and the
head-only re-sniff accepted the result: loss became CORRUPTION.

Now: parts live in `.up_<upload_id>/<i>.part` inside the user's `key_dir`, so
two transfers can never interleave; and the final name is claimed ONCE at
completion with an atomic `link(2)` and a `-1`, `-2`, … ladder. Two colliding
client names produce `Mar_a.jpg` and `Mar_a-1.jpg`, both intact.

Consequences a client must respect:

- `tmp_name` on an in-flight CHUNK response is the staged-name PROPOSAL (the
  client only counts these and passes them to the join); `tmp_name` on a
  `complete:true` response — single-shot or join — is the authoritative name on
  disk. Both clients already read it from there.
- A re-upload of the same name no longer overwrites: it stages a second file.
  That is deliberate. A visible extra row the user can delete is strictly better
  than silently destroying staged bytes, and "never silently destroy data" is
  the ranking criterion here.
- `list_uploaded_files` is unchanged in SHAPE (WC-078's `{name, url, size,
  thumbnail_url}`); the `name` is the assigned staged name, so restored rows
  stay identifiable and deletable by the name the user sees. In-flight artifacts
  stay excluded — `.up_*` is a dotted directory, so both the dotfile skip and
  the `isFile()` check exclude it, and `resolveStagedPath` never addresses it
  (it accepts only `<key_dir>[/thumbnail]/<name>`).

### 3. The join verifies the assembled CONTAINER, in bounded memory — and a
### refused transfer is QUARANTINED, never deleted

`src/core/media/engine/verify_content.ts` is new. The 8192-byte head sniff still
runs and still decides the content class; the container is then verified to a
depth that is STATED per class.

**This section was revised the same day it was written.** The first version was
broader than the decoder ecosystem it guards, and an adversarial review
reproduced five classes of real, standards-legal encoder output that it REFUSED —
at a time when a refused join also DELETED the transfer. The governing ranking
for an archival ingest path is:

> silently accepting corrupt bytes < refusing loudly and KEEPING the data <<<
> **destroying a curator's completed upload**

so the rule now written into the file is: **a narrower verifier that never
false-rejects beats a broad one that sometimes does.** When a real encoder's
output and an invariant here disagree, the invariant is wrong.

Two depths remain:

- **structural** (jpeg/png/bmp/pdf/zip/glb, the RIFF chain for webp/wav/avi, the
  ISO-BMFF box chain for mp4/mov/heic/avif): the container's declared extent or
  terminator is checked against the real file size with bounded reads, **and only
  in the direction that means "bytes are missing"**. What survives is TRUNCATION
  detection — which is the failure mode a chunked join actually has. Trailing
  bytes a container does not account for are accepted everywhere, because every
  decoder accepts them and real files carry them.
- **header** (text/svg/gltf/obj/dae, tiff/psd/mp3/aiff/flv/mpeg/ole/rtf/fbx/html):
  NAMED exemptions, each with its reason in `VERIFICATION_POLICY`.

The five reproduced false positives and their fixes:

| Input | Was | Now |
|---|---|---|
| ffmpeg WAV written to a pipe — RIFF size `0xFFFFFFFF` | REJECT | the streaming sentinel means extends-to-EOF, as it does to every decoder |
| WAV with a trailing tag outside the RIFF size (ID3v1/APE) | REJECT | the chunk chain simply ends; trailing bytes are not "unaccounted payload" |
| MP4 + 512 B zero pad (capture cards, block-aligned tape-out) | REJECT | trailing ZERO padding up to 1 MiB is accepted; the box chain need not tile exactly |
| JPEG + >1 MiB appended block (Motion Photo, large XMP/JUMBF/C2PA) | REJECT | the EOI search window is 16 MiB, scanned backward window by window |
| CSV with one `0x00` or `0x1A` (DOS EOF) | REJECT | the `full` depth is GONE — see below |

**The `full` depth is removed entirely**, and with it the whole-file text
predicate. It was wrong on the merits, not merely expensive: no CSV/XML/JSON
consumer enforces it, and control bytes are pervasive in real curator material —
Excel's "Unicode Text" export is UTF-16LE (NUL every second byte), a DOS-era
catalogue dump ends with `0x1A`, OCR transcriptions carry stray `0x7F`. Rejecting
those destroys exactly the legacy material the system exists to preserve, in
exchange for refusing a payload appended to a CSV that nothing in the pipeline
would execute. `bmp` and `glb` were narrowed the same way: a declaration SHORTER
than the file is a writer quirk every decoder ignores, only a LONGER one means
missing bytes.

Removing `full` also closes a denial-of-service the review measured: it was a
synchronous per-byte JS loop at ~705 MiB/s, i.e. ~43 s of total single-threaded
server freeze for a 30 GB CSV, blocking every other user. No rule now reads the
whole file; the worst case is a bounded backward scan of the last 16 MiB.

**QUARANTINE (this is a behaviour change to the staging area).** A failed
verification used to `rmSync` the transfer's whole artifact directory — a
heuristic verdict destroying a completed upload, with no recovery, for a curator
who may have spent forty hours pushing a 30 GB master over a rural link. Now the
artifact dir STAYS: the assembled bytes are parked as `rejected.<proposal>`
alongside a `rejected.json` marker recording the reason, size and timestamp
(`quarantineAssembled` / `listQuarantinedUploads` in `ingest/upload.ts`), the
parts are dropped as redundant, and the rejection response says the bytes were
NOT deleted. A re-join of a quarantined transfer reports that, rather than
"missing chunk 0".

Consequences for the two staging actions, unchanged in SHAPE:

- `delete_uploaded_file` with `upload_id` is now also the **release** for a
  quarantined transfer — it was already the explicit cancel for an in-flight one,
  and `cancelStagedUpload` drops the whole `.up_<id>` dir either way.
- the 24 h age sweep (§4) is the backstop for a quarantine nobody releases; a
  quarantined dir ages from the moment of rejection like any other artifact.
- `list_uploaded_files` is **not** changed: a quarantined transfer is not a
  restorable file, and a row whose URL does not resolve would render as a broken
  one. The read side is `listQuarantinedUploads` plus the reason echoed in the
  rejection body; projecting it onto the wire is a client-side decision and the
  upload clients are owned elsewhere.

Single-shot uploads take the same verification path as the join but do NOT
quarantine, and that asymmetry is deliberate: a single-shot is one request whose
file the browser still holds, so a 400 is fully recoverable by repeating it,
whereas the chunked path holds the only assembled copy of a transfer that may
have taken hours. Retaining every refused single-shot body would turn a stream of
rejections into a disk-exhaustion vector.

The DOS-03 property is preserved exactly: peak memory is O(1), never O(file
size). A 30 GB video is verified with the footprint of a thumbnail.

**What it still cannot do**, stated rather than narrowed: none of this decodes
anything. A structurally valid MP4 with a hostile payload, a JPEG whose
entropy-coded data is corrupt, or a ZIP with malicious members all still pass.

A kind present in `mime.ts` but absent from `VERIFICATION_POLICY` is a LOUD
runtime rejection, not a fallback to header-only.

### 3b. The join is interruptible and retryable

Two further defects on the same path, both reachable in ordinary operation
because the client re-sends the join while a long one runs:

- parts were unlinked **as they were consumed**, so a join killed halfway had
  already destroyed the front of the transfer and no retry could have succeeded.
  Parts are now removed only once assembly AND verification have reached a
  durable outcome.
- the output was opened `wx` with no recovery, so ONE interrupted join blocked
  every later attempt until the 24 h sweep — permanently, from the user's point
  of view. An `assembled` file untouched for `ASSEMBLY_STALE_MS` (10 min) has no
  writer (a live assembly advances its mtime every 1 MiB window), so it is
  discarded and the join starts again from the parts that were kept. A FRESH
  leftover still refuses loudly, which is the concurrent-join case.

**Amended 2026-11-19 (join polling).** The client polls the join in rounds of one
unkeyed attempt (`upload_transport.js` `join_chunked_files`; why unkeyed:
WC-2026-08-28-idempotency-key). Two additions on this seam:

- a resend while an assembly runs answers a NEW code, `media.upload_assembling`
  (409, retryable — it was `media.upload_conflict`), carrying
  `details.assembled_bytes`, the output's current size (a details key must be a
  label placeholder, so the running-join case got its own code and label;
  `media.upload_conflict` keeps the ambiguous-name case). The client treats a
  changed value as progress and gives up only after 15 min without one (longer
  than `ASSEMBLY_STALE_MS`, so a rebuild the server starts is followed), instead
  of a fixed 30 min total that a 10 GB join on slow storage, or two joins sharing
  a disk, could exceed while the server went on to stage a file nobody attached.
  `media.upload_conflict` (several staged uploads match a name) carries no size,
  so it ends after those 15 min.
- the claim records the writer (`assembled.owner`: `{host, pid, writer}`). An
  output whose writer is PROVABLY dead is recovered AT ONCE — after a restart
  the half-written output was otherwise "fresh" and every round got a conflict
  for up to 10 min before the join could start again. Provably dead: the same
  host and either our own pid under another writer id (a container restart
  reuses pid 1) or a pid no process holds (ESRCH). Nothing enforces one engine
  process per media root, so another live pid or another host is NEVER taken
  over (two writers corrupt the file); the age rule decides those, and outputs
  with no readable identity.
- a join that fails unexpectedly after claiming (an I/O error: a full disk) is
  recorded (`join_failed.json` in the transfer's folder) and the NEXT join of
  that `upload_id` answers it once as `media.action_failed` (not retryable)
  before the record is cleared. The round that ran the failed join has usually
  been abandoned by the client's 10 s timeout, so without the record the poll
  saw only a fresh copy growing — progress — and refilled the disk forever.

The assembly copy is also `await`ed now — `joinChunkedUpload` is async and yields
to the event loop between windows, so a multi-GB join no longer holds the single
thread for the whole copy. `dd_utils_api::join_chunked_files_uploaded` awaits it;
the wire is unchanged.

### 3c. `claimStagedName` no longer assumes hardlinks

`link(2)` is the atomic name allocator and the SINGLE chokepoint every upload
passes through, but only `EEXIST` was handled — so on a staging area without
hardlink support (SMB/CIFS-backed media, some FUSE mounts) EVERY upload failed.
The no-hardlink errnos (`EPERM`, `EOPNOTSUPP`, `ENOTSUP`, `ENOSYS`) now fall back
to an exclusive `open(…, 'wx')` reservation followed by a `rename`, which keeps
the atomicity of the claim; the only property lost is that the name exists as a
zero-byte placeholder for the microseconds between the two calls. `EXDEV` is
deliberately NOT handled: source and destination are in the same staging dir by
construction, so it is unreachable.

### 4. Orphaned parts are collected

Parts used to be unlinked ONLY inside a successful join: a cancelled or failed
4 GB upload leaked ~4 GB, repeatably, and nothing in `media/ingest/` swept.

`src/core/media/ingest/staging_gc.ts` adds the rule: **an upload is collectable
when nothing has touched it for 24 h**, measured as the NEWEST mtime among its
artifact directory and its parts — never per part, because part 0 of a live
multi-hour transfer is legitimately old, and an age rule on individual parts
would delete data still in flight. 24 h is far beyond any client-side stall (the
transport fails a stalled part after 5 retries at 5 s). It runs on
`list_uploaded_files` (once per `key_dir`, which service_dropzone calls on every
render) and after a successful join, always within ONE user's own staging tree.
Legacy flat artifacts (`<i>-<name>.blob`, `<name>.assembling`) are collected by
the same rule. `delete_uploaded_file` additionally accepts the optional
`upload_id` for an immediate cancel.

One pinned behaviour changed with this: a SURPLUS part (more parts delivered
than the join's declared `total_chunks`) used to be left in the staging dir
forever. The whole artifact directory is now dropped once the join succeeds —
the client declared the count, so anything past it is garbage by definition.

### 5. The batch importers must forward `tmp_name`

`stagedTmpName` was exported so `tool_import_marc21` and `tool_import_zotero`
could RE-DERIVE the staged name from `files_data[].name`. A server-assigned name
makes that unsound, so both tools' clients now post a JSON-safe projection
(`{name, tmp_name, key_dir, extension}`) instead of `self.files_data` verbatim —
which also stops them serialising Dropzone DOM nodes over the wire — and both
servers prefer the forwarded `tmp_name`.

The fallback for an entry with no `tmp_name` is the legacy derivation, with its
limit made EXPLICIT rather than silent: `resolveStagedName` refuses (throws, and
the tool reports it as that file's error) when collision-suffixed candidates for
the legacy name exist, instead of importing whichever file the ladder landed on.

**ORDER CORRECTION (same day).** That scan first ran only AFTER
`existsSync(legacy)` returned false, so the refusal fired exactly when it did not
matter and stayed silent when it did: with `DSC001.jpg` AND `DSC001-1.jpg` both
staged — the shape a curator produces by re-uploading a corrected scan, since
§2's re-upload no longer overwrites — an entry with no `tmp_name` resolved to the
OLD file. Wrong bytes under the right catalogue record, with no error anywhere.
The scan now runs FIRST: the presence of a suffixed candidate is what makes the
name ambiguous, and whether the unsuffixed one also exists is irrelevant to that.

## Reason

The client is the consumer, and three of its guarantees were false on the
chunked path: that a staged file is the file you uploaded, that the assembled
bytes were verified, and that a cancelled upload costs nothing. Each was
survivable while chunking was opt-in and rare; none is survivable when every
upload in a cultural-heritage repository goes through it. The additive
`upload_id` field is the minimum wire surface that lets one logical transfer be
named once — the property the whole fix rests on.

## Gate reconciliation

- `test/unit/media_upload_endpoint.test.ts` — end-to-end through the real server
  handler: two client names that sanitize alike, uploaded INTERLEAVED as two
  chunked transfers, produce two distinct staged files with byte-identical
  content; a JPEG header over 16 KB of non-JPEG body is rejected; a CSV carrying
  a NUL / `0x1A` / `0x7F` past the sniffed prefix is **accepted**, pinned as a
  deliberate decision with the real-world sources named (UTF-16 export, CP/M EOF,
  OCR artefact) so the next pass does not "fix" it back; six shapes of hostile
  `upload_id` (traversal, slash, NUL, too short, 4 KB, `..`) are refused with
  nothing written. It also PINS the rejection body
  (`{result:false, msg:'Upload rejected', error:<string>, errors:[<string>]}`,
  status 400), which had zero coverage.
- `test/unit/media_upload.test.ts` — the receiver/join contract on a scratch
  root: the sweeper's retention rule (an abandoned transfer collected, nothing
  collected before the TTL, completed files never touched, legacy flat artifacts
  collected), the explicit cancel, `resolveStagedName`'s
  forwarded-wins/refuse-to-guess behaviour INCLUDING the stale-file case (both
  names present ⇒ refuse), the QUARANTINE (rejected bytes still on disk, marked,
  discoverable with their reason, not listed as importable, released by the
  ordinary cancel), and the interrupted-join recovery (a fresh leftover refuses,
  a stale one is recovered, and both parts survive either way). Two existing
  tests were amended, both noted in place: the join call moved to its options
  object and is awaited, and the surplus-part case now asserts the artifact
  directory is GONE rather than left behind.
- `test/unit/media_engine.test.ts` — the verification policy is complete (every
  `kind:` in `mime.ts` has a row, every row states a reason, no row claims a
  whole-file depth), a truncated/smuggled container is still refused, and — the
  gate that did not exist and is the one that matters — an ACCEPTANCE case for
  every false-positive class the review reproduced: the streaming-sentinel WAV,
  the WAV with an uncounted trailing tag, the zero-padded MP4, the size-0 `mdat`,
  the JPEG with a >1 MiB post-EOI block, the control-byte CSV, and the
  short-declaring BMP/GLB. All fixtures are constructed byte by byte; no binaries
  are committed.
- `test/unit/tool_import_marc21.test.ts` / `tool_import_zotero.test.ts` —
  `resolveStagedFile` keeps its two-argument form (the legacy derivation) and
  gains the optional forwarded name. Its `return null` confinement branch became
  UNREACHABLE when the name transform started prefixing a leading dot (`'..'` →
  `'_..'`); that is stated in-code at the function, and the lost branch coverage
  is replaced by a gate on the PROPERTY instead — no hostile client name, of
  sixteen shapes, resolves outside the staging dir or nests inside it.

**Re-harvest: NOT needed, and none is possible.** The frozen fixture store
(`test/parity/fixtures/oracle_harvest/`, final harvest 2026-07-11) contains no
upload-endpoint or `join_chunked_files_uploaded` capture — the multipart upload
route was never part of the read-path harvest, and the live oracle is gone by
definition (`engineering/ORACLE_HARVEST.md`). `test/parity/dedalo_files_differential.test.ts`
is untouched by this change.

---
