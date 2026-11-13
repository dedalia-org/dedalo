# TRANSCRIPTION — local speech recognition

What the engine guarantees about turning recorded speech into text, and the two
contracts a consumer needs: the **local AI model store** and the **on-premise ASR
sidecar**. Companion of the tool's own docs (`docs/tools/using_transcription.md`
for archivists, `docs/development/tools/reference/tool_transcription.md` for the
tool surface); this file is the permanent definition of the parts that live
outside the tool.

## The law

**Recorded interviews are personal data. Recognition happens on hardware the
institution controls, and the recording is never published to run it.**

Two engines satisfy that, and nothing else may be added without satisfying it:

| Engine | Where inference runs | How the audio travels |
|---|---|---|
| `local` (default) | the archivist's own browser | it does not travel — the audio is decoded in the tab |
| `local_whisper` | a machine on the institution's network | POSTed as bytes to that machine |

The pre-existing `babel_transcriber` engine submits a public URL to an external
service. It stays supported for installations that already use it, and it is the
only engine that publishes anything — do not make it the default anywhere.

## The model store

In-browser inference needs model weights. They come from the install, never from
a public hub.

- **Location**: `DEDALO_AI_MODEL_STORE`, default `<private>/ai_models`. Outside
  the checkout: a large speech model is ~1.5 GB, it is data rather than code, and
  this repo has scars from large files in its history.
- **URL**: `/dedalo/ai_models/<model-id>/<file>`, read-only, served by
  `src/core/ai/model_store.ts`. Fail-closed like the client-lib route: an
  extension allowlist (`.onnx`, `.onnx_data`, `.json`, `.bin`, `.data`, `.txt`,
  `.model`, `.wasm`), realpath confinement, plain 404 for everything else.
  Immutable cache headers — a model id *is* its version.
- **Seeding**: three doors, ONE downloader (`src/core/ai/model_fetch.ts`):
  the operator CLI `bun run scripts/fetch_ai_models.ts --list | <model-id> | --all`;
  the tool's `download_model` action (global admin only, catalog names only —
  the id becomes a hub URL path and a store directory, so free-form input is
  refused; runs as a background job); and an rsync of the directory for an
  air-gapped install. The catalog of offerable models is the tool's registered
  `transcriber_quality` (seeded from `register.json` via the tools registry —
  re-import the registry after editing it, or the picker keeps serving the old
  list).
- **Escape hatch**: `DEDALO_AI_MODEL_ALLOW_HUB=true` lets the browser fall back to
  a public hub. Off by default, and wrong for any collection holding personal
  data.
- The runtime itself is served through the client-lib registry, NOT a CDN: the
  transformers.js bundle is a digest-pinned vendored tree (`vendor/transformers`,
  since 2026-09-04 — the npm package shipped 567 MB of Node-side native code the
  engine never ran) and its WASM glue is the `onnxruntime-web` npm pin. The
  `no_remote_code_tripwire` gate keeps it that way.

## The on-premise ASR sidecar (`local_whisper`)

A small HTTP service the institution runs — faster-whisper, WhisperX,
whisper.cpp, or anything else behind this contract. Configured like any other
transcriber: a `transcriber_config` entry in the tool config carrying `uri` and
`key`.

```
GET  <uri>/models        → { "models": [ { "name": "large-v3", "label": "…",
                                          "languages": "99", "notes": "…" } ] }

POST <uri>/jobs          multipart: audio (the 16 kHz mono WAV), language (ISO 639-1),
                                    model, entity_name, user_id
                         → { "id": "job-42" }

GET  <uri>/jobs/<id>     → { "state": "queued" | "running" | "done" | "error",
                             "segments": [ { "start": 0, "end": 4.2,
                                             "text": "…", "speaker": "SPK_1" } ],
                             "error": "…" }
```

`Authorization: Bearer <key>` is sent when a key is configured.

Notes that are not optional:

- **Segments carry `end` and, when the engine diarizes, `speaker`.** Both are
  what the paragraph grouper breaks on; an engine that returns only `start` will
  produce a readable transcript with worse paragraphs.
- Job states map onto the shared completion poll as `queued`/`running` → keep
  waiting, `done` → save, anything else → terminal. The write-back, the
  overwrite guard and the time-machine-audited save are shared with the other
  engines rather than reimplemented.
- The **audio is deleted** by the completion poll when the job ends, whichever
  way it ends.
- **The sidecar's job id never reaches the browser.** `automatic_transcription`
  hands the client a server-issued POLL HANDLE (`tools/tool_transcription/server/poll_handle.ts`)
  sealing the job id, the engine, the submitting user and the media record it was
  authorized on; `check_server_transcriber_status` accepts only that handle, and only
  from the same user on the same record — a sequential id like `job-42` is not a
  credential to someone else's transcript (WC-2026-09-30-transcription-record-tipo).
  A server restart retires every handle along with the poll that could save its job.

### The private-address exemption

The outbound SSRF guard refuses loopback and private ranges, because an external
service must never be able to make the engine reach inside the network. A sidecar
on the LAN is the legitimate opposite case, so it is allowed **only** with:

```bash
DEDALO_TRANSCRIBER_ALLOW_PRIVATE_HOSTS=true
```

It applies to `local_whisper` alone; `babel_transcriber` keeps the strict guard
regardless, and the cloud metadata address (169.254.169.254) is refused either
way. `test/unit/transcription_local_asr.test.ts` asserts both directions.

## Getting the audio to the recogniser

The in-browser recogniser reads the whole `audio_tr` WAV before it transcribes
(~170 MB for a 90-minute interview). **The web server serves those bytes** — the
engine never does. This is not a preference: installs hold single AV files of
16-32 GB and the media path must stay `sendfile` with Range intact
(`engineering/MEDIA_PROTECTION.md` §1, *"never put an application process in the
media-serving path"*). Authorisation is the existing Rule A marker cookie
(`dedalo_media_auth`), which every logged-in user already carries.

The requirement that follows is a DEPLOYMENT one:

> The media base must be readable from the application's own page.

- **Same origin** (the production layout: one reverse proxy in front of both) —
  nothing to configure.
- **Different origin** — a separate media host, a CDN, or a development box with
  the app on one port and media on another (`DEDALO_MEDIA_WEB_BASE` pointing at
  `http://host:8080/dedalo/media` while the app answers on `:3500`) — that host
  must send CORS headers for the app's origin, or the browser refuses the read.
  The same restriction shows up as a subtitle track failing with *"Domains,
  protocols and ports must match"*.

  Apache, on the media vhost:

  ```apache
  SetEnvIf Origin "^https?://your-app-host(:[0-9]+)?$" APP_ORIGIN=$0
  Header set Access-Control-Allow-Origin %{APP_ORIGIN}e env=APP_ORIGIN
  Header set Access-Control-Allow-Credentials true
  Header append Vary Origin
  ```

An engine route serving this file was written and DELETED on 2026-07-28: it made
the tool work on a split-origin dev box by streaming the WAV from Bun, which is
exactly what §1 forbids. If it reappears, that is the bug.

## The original language (rsc263)

Interviews in one installation are recorded in different languages, so AV
sections carry a `component_select_lang` ("Original language", rsc263): a
locator into the languages section (lg1). The engine forces the transcription
text_area to that per-record language (v6 `get_original_lang`, ported
2026-07-28):

- **Edit contexts** (the get_data route and section edit reads) carry
  `context.options.related_component_lang` = `'lg-<code>'`; the transcription /
  indexation / lang tools read it to open the component in the interview's own
  language — which is also what seeds the recogniser's language hint.
- **List values** emit in the original language (the item's `lang` follows), so
  a list of interviews shows each transcript in its own language instead of an
  empty current-lang slice.
- **Tag statistics** (the `tags` info widget, rsc244) count the same slice the
  list shows — original lang, equivalence-aware, else the request data lang, no
  further fallback (v6 `class.tags.php`; frozen PHP v7 read item [0] of every
  lang). `original_lang.ts::resolveRecordTextLang` is the one resolution both
  consume. WC-2026-11-13-tags-widget-original-lang; gate
  `test/unit/tags_widget_original_lang_native.test.ts`.
- Resolution: `src/core/components/component_text_area/original_lang.ts`
  (ontology-related select_lang → lg1 locator →
  `select_lang.ts::getLangCodeBySectionId`). A record without a value, or a
  text_area whose ontology relates no select_lang, is never forced — behaviour
  is byte-identical to before.
- This RESTORES PHP behaviour (no WIRE_CONTRACT entry); the context stamp is
  per-request (clone-before-stamp — never in the cached structural core), and
  the list forcing is the `resolveEmitLang` emit-hook facet.
- Gate: `test/unit/original_lang.test.ts`.
- Related: `DEDALO_LANG_EQUIVALENCES` (resolve/lang_alias.ts) declares
  same-language classes (Català===Valencià). Ontology terms and UI labels read
  the canonical member's translation; DATA fallback prefers class siblings in
  both directions — a Catalan menu shows a Valencian-only transcript before the
  install default applies. Gate: `test/unit/lang_alias.test.ts`.

## Transcript shape

Recognisers emit subtitle-sized segments. What is stored is an interview
transcript: segments grouped into paragraphs at pauses, speaker changes and
sentence ends, capped so a monologue still breaks up.

- One implementation, `tools/tool_transcription/transcribers/lib/paragraphs.js`,
  plain ESM, imported by BOTH the browser worker and the server write-back
  (`segmentsToTcText`). A second implementation would drift the first time either
  was tuned.
- Timecode density is the archivist's choice: `paragraph_anchors` (default — one
  mark per paragraph plus inline anchors), `paragraph`, or `segment` (the
  historical cue list). Anchors exist because `buildSubtitlesText` interpolates
  cue times *between* marks: paragraph-only marks read beautifully and drift the
  `.vtt`.
- `parse_transcript` reads stored text back into segments, so an existing
  transcript can be re-paragraphed without re-recognising a word.

## The transcription helpers (speakers / language / note tags)

The editing helpers an oral-history transcription needs — insert a SPEAKER tag
(`[person-a-1-DyaDa-data:{'…person locator…'}:data]`), an in-text LANGUAGE tag,
a NOTE tag backed by a notes record — are owned by **`component_text_area`'s
edit view**, not by the tool: the tool hosts the component and the component's
CKEditor toolbar brings the buttons (v6 worked the same way; the v7 client kept
the whole tag UI). The server feed, restored 2026-07-29 (WC-065/WC-066):

- WHICH components hold the speakers is ontology data: the text_area's
  `properties.tags_persons`, keyed by related-section tipo (`oh1` → informants
  portal `oh24`, state `a`; the AV record's own crew autocompletes, state `b`).
  The emit hook stamps `tags_persons` + `related_sections` on EDIT data items
  (`component_text_area/tags_persons.ts`, `resolve/related_sections.ts`).
  The person LABEL comes from the target people section's OWN definition: its
  section_map term (scope `default`, standard fallback walk — rsc197 declares
  it in rsc1023) resolved through `getTermByLocator`, i.e. the same label a
  relation list shows for that record; initials apply the 3+2+2 rule to that
  word order. The PHP-hardcoded `rsc85`/`rsc86` pair survives only as the
  fallback for a people section with no section_map term.
- `context.toolbar_buttons` (structure_context.ts) gates the buttons
  server-side from the same properties; `button_lang` is client-always and
  feeds off the project langs, `button_note` creates its backing record in the
  notes section (`features` bag).
- The tools' parent-record `<select>` and the persons-modal grouping ride the
  `source.action:'related_search'` read (read_facade.ts), same producer.

Wire shapes and the deliberate divergences from PHP are ledgered in
`engineering/wire_contract/` WC-065 (all-string section_ids, sections item always
present, `value: string[]` cells) and WC-066 (note-button gating).

## Speaker detection (diarization)

The browser tier can detect WHO speaks WHEN and open each speaker turn in the
stored text with the right person tag — same privacy posture as the
recognition itself: the audio never leaves the machine, the model comes from
the install's own store.

- **Models** (two, both required for coherent detection — the admin Download
  button and the seeder fetch both; `get_model_sources` reports
  `diarization: {name, embedding_name, size_mb, installed, state, models[]}`,
  where `models[]` carries one entry per half — `{role, name, label, state}` —
  so a remedy can be aimed at the half that is actually broken, `state` is the
  WORST half's, and `installed` stays true only when BOTH halves are runnable.
  `diarization: null` means this install declares no speaker detection; the
  field ABSENT means the server could not read its catalog — see the
  degraded-answer addendum in
  `engineering/wire_contract/WC-2026-08-13-transcription-status-panel.md`):
  - `onnx-community/pyannote-segmentation-3.0` (~6 MB, slot
    `diarization_model`): WHO speaks WHEN, per chunk;
  - `onnx-community/wespeaker-voxceleb-resnet34-LM` (~26 MB, slot
    `diarization_embedding_model`): VOICE FINGERPRINTS — the same voice keeps
    the same speaker id across the whole recording. Without it, identity
    falls back to overlap co-activity stitching, which is coherent on short
    clips but FRAGMENTS one voice into several detected speakers on long
    interviews (observed live on an 87-minute recording).
  Separate catalog slots (never entries of the ASR quality picker); same
  store, same seeding doors; diarization file profile (no tokenizer, the
  preprocessor config is MANDATORY — `DIARIZATION_COMMON_FILES` in
  `src/core/ai/model_fetch.ts`). Their WEIGHTS are a single `onnx/model.onnx`,
  not an ASR encoder/decoder pair: the store answers by the model's KIND
  (`ModelKind` in `src/core/ai/model_store.ts`, threaded from the catalog's own
  `kind` field through `src/core/ai/model_catalog.ts` — never inferred from the
  id), because the ASR file list reported a healthy speaker model `incomplete`
  and aimed its repair at a shape it does not have.
  The `ai_models` maintenance widget lists the pair as its own row group, from
  that same catalog module.
- **Worker** (`browser_whisper.js diarize_audio`): runs after the last decode
  window, on WASM always (small recurrent model; CPU is faster than the
  WebGPU backend's op support is reliable). Long chunks (5 min) with a
  conversational overlap (30 s); the pure post-processing — cross-chunk
  identity stitching by co-activity, segment attribution, per-speaker stats —
  lives in `transcribers/lib/diarize.js` (bun-tested,
  `test/unit/transcript_diarize.test.ts`). GLOBAL identity: each chunk-local
  voice is fingerprinted once (its longest turn, centered, capped at 10 s)
  and duration-weighted agglomerative clustering over cosine similarity
  (threshold `cluster_similarity`, default 0.5) merges the same voice across
  the whole recording; fingerprint-less groups are never merged by guessing.
  STRICTLY BEST-EFFORT at every stage: embedding failure falls back to
  overlap stitching, diarization failure emits `diarize_error` and the
  transcript arrives without speakers, never lost.
- **Turn marking and identity are SEPARATE steps** (the placeholder flow):
  a run with detection saves IMMEDIATELY, opening every detected turn with a
  PLACEHOLDER tag — `[person-a-1-P1-data::data]`, normal person-tag grammar,
  the EMPTY data payload is what marks it unresolved. No dialog blocks the
  save; the draft is reviewable at once, and a wrongly placed tag is
  ordinary editable content (move it, delete it, change it) BEFORE any
  identity is bound.
- **Identity is a HUMAN decision, deferred.** No voice print says who a
  voice belongs to, and enrolling biometric voice prints is exactly what
  this tool avoids. "Assign speakers" (`tool_transcription.js
  assign_speakers` — auto-offered after a run, reopenable any time) reads
  every distinct person tag out of the STORED text (placeholders first,
  bound ones preselected), offers the `tags_persons` people with listen jump
  points (each tag sits beside a TC mark), and applies the binding as a
  DETERMINISTIC whole-tag swap through the normal save path — TM keeps the
  pre-binding version, re-binding later is the same swap again. Two
  placeholders may bind to one person; an unbound placeholder stays.
- **Stored shape**: the (placeholder or bound) person tag opens the first
  paragraph of each speaker TURN, right after the paragraph's TC mark — the
  v6 byte layout; a same-speaker run split by paragraph caps carries the tag
  once (`paragraphs.js segments_to_html` `speaker_tags`). Numeric speaker
  ids never leak into the stored text.
- **Known limits**: up to 3 concurrent voices (the model's powerset);
  overlapping speech attributes to the dominant voice; a voice absent from a
  chunk overlap opens a NEW detected speaker rather than guessing (the
  mapping dialog merges it back — with the embedding model installed this is
  rare). The sidecar contract can still gain a `diarize` flag for
  WhisperX-style boxes.

## Why the transcripts used to repeat words

Recorded for the next person who touches this. Five causes, all fixed 2026-07-28:

1. a 4-bit (`q4`) decoder was forced for every large model — and `large` was the
   default. Quantising Whisper's decoder that far is the best-known trigger of
   repetition loops. Quantisation is now per-model in the catalog, encoder and
   decoder chosen separately (`q4f16`, not `q4`);
2. no anti-loop decoding at all: greedy, no repetition penalty, no
   no-repeat-ngram, no temperature fallback, and conditioning on the previous
   window so one loop poisoned the next;
3. blind 30-second windows with a 5-second overlap — the overlap was transcribed
   twice;
4. no voice-activity detection, so silence and room tone were fed to the model;
5. nothing checked the output.

Now: VAD plans windows at real pauses (`transcribers/lib/vad.js`), each window is
decoded independently with anti-loop parameters (repetition penalty, no-repeat
n-grams, no conditioning on the previous window — beam search is NOT available:
Transformers.js' Whisper pipeline dies on it with "token_ids must be a non-empty
array", so quality comes from the penalties, the retry ladder and VAD), a window
that still looks degenerate is retried up a temperature ladder, and
`transcribers/lib/transcript_postprocess.js` collapses whatever survives. The
audio itself is high-passed and loudness-normalised on extraction, because quiet
and rumbling input is what makes a recogniser hallucinate in the first place.

## Gates

| Gate | What it holds |
|---|---|
| `test/unit/no_remote_code_tripwire.test.ts` | no client/tool code loads from a third-party host (tripwire index) |
| `test/unit/ai_model_store.test.ts` | the store serves models and is fail-closed everywhere else |
| `test/unit/transcription_local_asr.test.ts` | the private-address exemption, both directions; audio travels as bytes to the on-prem engine |
| `test/unit/transcript_postprocess.test.ts` | decoder repetition dies, real speech survives |
| `test/unit/transcript_paragraphs.test.ts` | paragraph grouping, the three timecode modes, and that the `.vtt` still tracks |
| `test/unit/transcript_vad.test.ts` | where the cuts land; no window exceeds the model context; unreadable audio still transcribes |
| `test/unit/tool_transcription.test.ts` | the tool surface, incl. the real-ffmpeg audio build |
