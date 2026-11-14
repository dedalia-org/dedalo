# tool_transcription

Turns time-based and document media into editable text: in-browser Whisper speech-to-text on audio/video, server-side automatic transcription via Babel, PDF text extraction, audio format conversion for the recognizer, remote-process monitoring, and VTT subtitle generation.

## What it does / why & when to use it

Oral-history and audiovisual archives accumulate hours of recorded interviews and stacks of scanned documents that are useless for search and publication until someone produces a text transcript. `tool_transcription` is the workbench that produces that text directly inside a record, next to the media, so the result lands in the record's transcription component without copy-paste.

Concrete scenario: an oral-history project (rsc167-style AV section) holds a 90-minute recorded interview in a `component_av` element, with an empty `component_text_area` transcription field beside it. The archivist opens the transcription tool on the interview. The tool window shows the editable transcription text area on the left and the media player on the right. They pick a Whisper quality (small / large / large_turbo) and press **Automatic transcription**: the browser loads the Whisper model (WebGPU when available, WASM as the compatible fallback), the tool builds a recognizer-friendly audio rendition (WAV, 16 kHz, mono) on the server, streams the audio through the model, and writes the result back into the text area as Dédalo-format paragraphs with `[TC_hh:mm:ss.mmm_TC]` timecode tags. The archivist then corrects the text, sets a characters-per-line value and presses **Build subtitles** to emit a `.vtt` file synced to the AV duration. For very large jobs, an engine configured with `type: "server"` hands the work to a Babel transcription service instead, which runs as a background process the tool polls by PID.

The same tool also surfaces on `component_pdf` (extract text from a scanned/born-digital PDF via `pdftotext`) and on `component_image`. Use it whenever you need machine-generated text from a media element rather than re-keying it. For the *printable* / formatted rendering of a finished transcript and its VTT, use [tool_tr_print](index.md); for hand-editing subtitles in a rich editor, [tool_subtitles](tool_subtitles.md); for shifting all timecodes at once, [tool_tc](index.md).

## How it works

### Server

`tools/tool_transcription/server/index.ts` implements five actions:

| Action | Status |
| --- | --- |
| `create_transcribable_audio_file` | implemented |
| `delete_transcribable_audio_file` | implemented |
| `automatic_transcription` | implemented (remote-ASR submit) |
| `check_server_transcriber_status` | implemented (remote-ASR status poll) |
| `build_subtitles_file` | implemented (VTT generation) |
| `get_text_from_pdf` | not implemented on this engine (SEC-024 record-scope concerns) — use [tool_pdf_extractor](index.md) instead |

The five implemented actions:

- **Audio conversion** — `create_transcribable_audio_file`/`delete_transcribable_audio_file` (`src/core/media/tools/transcription.ts::ensureTranscribableAudio`/`deleteTranscribableAudio`) build/remove a temporary `audio_tr` quality (WAV/16 kHz/mono) via real ffmpeg, idempotently; the deleted file is hard-removed (not sent to trash/time machine).
- **Remote ASR submit** — `automaticTranscription` ensures the audio quality, then submits the audio URL to the configured transcriber provider (`resolveTranscriberProvider`, `src/core/tools/transcription_asr.ts` — a provider-seam abstraction, verified with a **stub** provider) and returns the job PID. It also schedules a detached background poll (`backgroundTranscriberPoll`, allowlisted in `backgroundRunnable` as `check_background_transcriber_status`, not itself an `apiActions` entry) that writes the finished transcript back automatically once the remote job completes.
- **Remote ASR status poll** — `checkServerTranscriberStatus` is the client-facing, read-gated poll of a running remote job: it rebuilds the same audio URL `automatic_transcription` submitted and asks the provider for status, without deleting the provider's stored result (`deleteResult: false`) so the detached background poll can still consume it.
- **Subtitles** — `buildSubtitlesFile` reads the transcription text, resolves the paired `component_av`'s duration, and writes a WEBVTT file under the AV subtitles folder; the target subtitles directory must already exist (it is not created on demand), and the action returns the file's public URL on success.

Permission gating: the write/read target for each action is a nested `media_ddo`/`transcription_ddo` locator (or, for `build_subtitles_file`, a top-level triple whose RELATED AV must be gated too), which a declarative gate kind cannot name on both halves — so `apiActions` declares `permission: null` for every action, and each handler runs `gateRecord`: the **write door** (`src/core/security/write_door.ts` `authorizeRecordAccess`) on the lifted locator — the section floor, the (section, **component**) pair (level 2 on what the action authors — the transcript; level 1 on the audiovisual SOURCE, which every path only reads or derives throwaway files from: the browser-ASR WAV, the local engine's WAV, the remote engine's `audio` quality, the duration a VTT is cut to — so a transcriber who may hear the recording and write its transcript gets the same answer from every engine), the record scope. Every gate is **unconditional and runs first** — before validation, any config lookup, any ASR call and any file; a ddo without `component_tipo` / `section_tipo`, or a missing `section_id`, is refused as `request.invalid`, and an out-of-scope record as `perm.out_of_scope`. The detached background poll re-runs the write door on the transcription target immediately before it saves, for the principal resolved at that moment — and only while the account is still active (`resolveLivePrincipal`: a deactivated or deleted account is refused even if its profile still grants the component) — so a grant revoked, or an account deactivated, after the enqueue writes nothing. Tool configuration (transcriber URIs/keys, quality list) is read through `getToolConfig('tool_transcription')`.

### Client

`tools/tool_transcription/js/` wires the standard lifecycle on top of `tool_common` (`init`/`build`/`edit`/`render`). The tool opens in its own window (`properties.open_as: "window"`). `build()` resolves five components from the tool's `ddo_map` into instance roles: `media_component` (the AV/PDF/image being transcribed), `transcription_component` (the target `component_text_area`), `status_user_component`, `status_admin_component` and `references_component`; it forces the text area to the media's original language when `related_component_lang` is set, and loads a `relation_list` (related-search RQO) so the user can pick the top section. `render_tool_transcription.js` lays out the text area + player, a header with buttons to jump to related tools (`tool_tr_print`, `tool_time_machine`) via `open_tool(...)`, an **Insert tag** control, a **Build subtitles** button with a characters-per-line input (persisted in `localStorage`), and the **Automatic transcription** block with engine/quality/device selectors.

Two transcription paths, chosen by the configured engine's `type`:

- `type: "browser"` (default, e.g. the `local` engine) → `automatic_transcription()` (client) spins up `transcribers/browser_whisper/browser_whisper.js` as a Web Worker (Transformers.js Whisper), first calls the server `create_transcribable_audio_file` action to get the 16 kHz WAV URL, fetches it **from the web server** (never through the engine — see `engineering/TRANSCRIPTION.md`; a media host on another origin must allow CORS), decodes it via `AudioContext`, **transfers** the channel data to the worker, streams progress into the UI and, on `end`, formats the returned segments into paragraphs and `set_value`s them into the text area. `delete_transcribable_audio_file` fires on EVERY exit path — success, error, cancel — because the temporary WAV is a copy of the interview. Partial results are persisted in the local `status` store (see *Interrupting a browser run* below), so a closed window resumes instead of restarting.
- `type: "server"` → `automatic_transcription_server()` (client) sends the `automatic_transcription` action, stores the returned `pid` in the local status DB, and polls `check_server_transcriber_status` every ~4 s until the server reports done, then refreshes the text component. Two providers sit behind it: `babel_transcriber` (external service, fetches a public media URL — stub-verified only) and `local_whisper` (the institution's own recognition box, POSTed the audio bytes; see `engineering/TRANSCRIPTION.md`).

#### The browser recognition pipeline

The worker does not hand the model the whole recording. That was the previous
design, and it is what produced the repeated words users reported: blind
30-second windows with a 5-second overlap transcribe the overlap twice, and the
silence inside those windows is the classic trigger of a Whisper repetition loop.

1. `transcribers/lib/vad.js` finds the speech and plans decode windows that start
   and end **at pauses** — no overlap needed, long silences never sent;
2. each window is decoded independently: greedy with `repetition_penalty`,
   `no_repeat_ngram_size`, and no conditioning on the previous window (beam
   search is unsupported by the ONNX ASR pipeline and is clamped to 1);
3. a window whose output still looks degenerate is retried up a temperature
   ladder, and the least repetitive attempt wins;
4. `transcribers/lib/transcript_postprocess.js` collapses in-segment loops,
   strips cross-window duplication and repairs missing end timestamps;
5. `transcribers/lib/paragraphs.js` groups the segments into paragraphs.

Quantisation is per model, from the catalog (`dtype`), and the encoder and the
decoder are chosen separately: a 4-bit **decoder** — which is what the old code
forced for every large model — is the single best-known cause of repetition
loops.

The three `transcribers/lib/*.js` modules are plain ESM with `.d.ts` siblings and
no build step, imported unchanged by the Bun test gates and (for `paragraphs.js`)
by the server write-back, so browser-produced and server-produced transcripts are
formatted identically.

#### The status panel

Everything the engine says to the user goes through one panel
(`js/render_transcription_status.js`), which cannot hide a message: it replaced a
one-line, overflow-hidden div whose error writer never removed its `hide` class,
so every failure raised before a run started was invisible by construction.

It renders three kinds of thing, in three separate nodes, and the separation is
load-bearing:

- **readiness** — what is true BEFORE the button is pressed: the selected model
  and its state, whether the run will fall back to the processor, the language,
  and any interrupted run waiting to be resumed. Unremarkable facts join one
  quiet run-on line; only a line that needs attention takes a row of its own,
  with its remedy as a **button** beside the text rather than as a sentence
  inside it. Machine identifiers (the model id, a language's codes) go on the
  row's `title`, not into the sentence.
- **progress** — the transient line: phases and percentages, overwritten, never
  stacked.
- **messages** — standing reports, oldest first. Warnings ACCUMULATE: a run that
  fell back to the CPU or skipped a fragment must still say so when it finishes,
  which is why they cannot share the transient node.

Severity is the panel's own vocabulary (`REPORT_SEVERITIES` in
`js/transcription_report.js`) and rows are classed `severity_<name>`, never the
bare word: `error` and `warning` are page-wide utility classes, and a row wearing
the bare `error` inherited that rule's `color: white !important` and rendered
invisible on the panel's surface. `success` is a real severity rather than a
shade of `info` — an outcome arriving in the same neutral grey as "the model is
unverified" is an end the reader has to infer. An unknown severity coerces to
`error`, so an outcome can never LOSE its colour in either direction.

Every severity that can reach a row must have a rule that paints it; `info` (the
neutral default) and `progress` (which never reaches a row) are the two
documented exceptions. A gate enforces this — see *Gates* below.

#### Interrupting a browser run

A browser transcription lives in the tool's tab, so a reload or a close kills the
worker mid-window. Three mechanisms make that survivable, and they are worth
reading together because each one covers a gap the others leave:

1. **A slot per model.** Every completed window is persisted to the local
   `status` store under `partial_id(self)` — one key per record AND per
   component, so two transcriptions open at once cannot overwrite each other. The
   record is `{partials: {<model>: {segments, updated}}}`: keyed BY MODEL, because
   a single slot meant the next run's first completed window destroyed the
   previous one — an hour recognised under one quality died at window one of
   another, before anything could ask. Writes are read-modify-write per window
   (a second tool window on the same record must not erase the first's slots),
   records in the older single-slot shape are migrated on read, and slots older
   than `PARTIAL_MAX_AGE` (14 days) are dropped on write so the store cannot grow
   a slot per model forever. A finished run clears only its own slot.
2. **The readiness line reads that store.** Before the button is pressed, not
   after — the defect this fixed was not a lost transcript but an unannounced
   one: the store was read in a single place, inside the run, so the archivist
   returned to a tool that looked untouched. The line states how far the run got
   (`resume_seconds_of`, the same cursor the worker restarts from, so the stated
   timecode and the actual restart point cannot disagree) and offers
   `action_resume`. When the saved partial belongs to a DIFFERENT model, the line
   is a warning naming that model and offering `action_use_saved_model`, which
   moves the picker (dispatching `change`, since assigning `.value` fires no
   event) and lets the readiness line re-offer the resume proper.
3. **An unload guard.** `beforeunload` is armed when the worker starts — the
   point from which work exists that no server holds a copy of — and disarmed by
   both `end_run` and `delete_audio`, because the success path resolves straight
   to the caller without passing through `end_run`. The browser ignores any
   custom text, so there is no string to translate here.

The **server** engine deliberately has none of this: the job runs on the
transcriber, the PID is in the local status store, and `get_server_status()` is
called on render — so reopening the tool re-polls a job that never noticed the
reload. Warning about a reload there would be a lie.

!!! note "Speaker detection is not resumable"
    Diarization runs after the last decode window and writes no partial, so an
    interruption during that stage keeps the transcript and restarts the speaker
    pass.

Client actions worth knowing about, beyond the API ones:

| Client method | What it does |
| --- | --- |
| `automatic_transcription(options)` | the browser pipeline above; resolves `[html]` for the text component, or `false` when it failed |
| `abort_transcription()` | asks the worker to stop; it finishes the current window and returns everything recognised so far through the normal `end` path |
| `regroup_paragraphs(options)` | re-paragraphs the transcript ALREADY in the component (`parse_transcript` → `segments_to_html`). No recognition, no word changes, saved through the normal component save |

Styling: `css/tool_transcription.less`.

## Actions & options

`apiActions` declares five record actions (plus the install-level model actions), each `permission: null` + the write door on the nested locator (see above):

| Action | Gate | Key options it reads |
| --- | --- | --- |
| `automatic_transcription` | write door, write/2 on `transcription_ddo` (component REQUIRED) + read/1 on `media_ddo`; the background save re-gates write/2 | `source_lang` (`lg-…`), `transcription_ddo` `{component_tipo, section_id, section_tipo}` (where the text is written), `media_ddo` `{…}` (source AV), `transcriber_engine`, `transcriber_quality`, `config` (optional) |
| `create_transcribable_audio_file` | write door, read/1 on `media_ddo` (section, component, record) — the WAV is a derivative of the AV, the level every WAV-deriving path asks — with the SECTION at write/2: the WAV is one shared file per record | `media_ddo` `{component_tipo, section_id, section_tipo}` — builds the temporary `audio_tr` WAV/16 kHz/mono and returns its URL |
| `delete_transcribable_audio_file` | write door, read/1 on `media_ddo` with the SECTION at write/2 — the same level as its creation: deleting the one shared WAV affects every other user of the record, so a read-only viewer may not | `media_ddo` `{…}` — hard-deletes the `audio_tr` file |
| `check_server_transcriber_status` | write door, read/1 on `media_ddo` — unconditional, before validation — then the POLL HANDLE: `pid` must be the handle `automatic_transcription` issued to this user for this record | `media_ddo`, `pid` (the handle) — polls the handle's job on the handle's engine and answers `{status, msg?}` only; a handle that does not verify or belongs to another user or record answers `{status: 1}` without polling anything. `transcriber_engine` is no longer read |
| `build_subtitles_file` | write door, write/2 on `(section_tipo, component_tipo, section_id)` (the transcript the VTT is derived from) AND read/1 on the RELATED AV (whose duration it reads and whose media folder receives the VTT) — unconditional, before the record is read | `component_tipo`, `section_tipo`, `section_id`, `lang`, `max_charline`, `key` — builds the WEBVTT file and returns its URL |

Notes:

- `get_text_from_pdf` is not implemented on this engine (SEC-024 record-scope concerns) — use [tool_pdf_extractor](index.md).
- The internal completion poll (`check_background_transcriber_status`) is the only entry in `backgroundRunnable`; it is not itself callable from the client (absent from `apiActions`) and is scheduled only by `automatic_transcription` itself. None of the five client-facing actions run through the background executor: the remote-ASR submit returns immediately with a job PID and the completion poll runs detached, while the browser-Whisper path runs entirely in the user's browser.
- Engine names and models come from the tool config (`getToolConfig('tool_transcription')` — same dd996/dd1633 resolution as every other tool). The shipped default declares two engines: `local` (browser) and `local_whisper` (the institution's own recognition box), plus a `transcriber_quality` **catalog** whose entries carry `tier`, `languages`, `size_mb`, `requires` (`webgpu` models are disabled when the user picks the compatible device) and `dtype`. Default: `large_turbo` — near large-v3 accuracy with far fewer repetition loops. A server-type engine needs its `uri`/`key` in `transcriber_config`; for `local_whisper` on a LAN address, also `DEDALO_TRANSCRIBER_ALLOW_PRIVATE_HOSTS=true`.
- Model WEIGHTS for the browser engine come from the install's own model store (`/dedalo/ai_models/`, `DEDALO_AI_MODEL_STORE`) and the runtime from the client-lib registry — never a CDN or a public hub. Seeding has two doors, one downloader (`src/core/ai/model_fetch.ts`): the operator CLI `scripts/fetch_ai_models.ts`, and the `download_model` action — global-admin-only, catalog names only (the id becomes a hub URL and a store directory), run as a background job while the client polls `get_model_sources` until the model reports installed. See `engineering/TRANSCRIPTION.md`.
- **Every model artifact is PINNED and VERIFIED** (`src/core/ai/model_pins.json`, read by `src/core/ai/model_pins.ts`): per catalog model the hub's immutable commit `revision` and, per file, its `sha256` + `size`. The downloader fetches `…/resolve/<revision>/<file>` (never a branch), hashes the bytes after transport and only then records completion (`.dedalo_model.json` carries `size`, `sha256`, `revision`); a mismatch is moved to `<store>/.quarantine/<model>/<file>.<timestamp>` (evidence kept, never served) and the job fails with `ai.model_integrity`. A model with no pin is refused before a byte. The serving door (`/dedalo/ai_models/`) re-hashes a file with a known digest once per process (a stat-identity verdict cache) and quarantines + 404s a mismatch — the digest is the one the REQUESTED name is pinned to and the bytes hashed are whatever that name resolves to, so a symlink planted under a pinned name (an `rsync -a` carries them) is judged against that pin, and the link itself is what gets quarantined. The repo pin is the authority at EVERY directory depth: it is looked up before any `.dedalo_model.json` at any split of the path, so a manifest planted one directory up (`<store>/<org>/.dedalo_model.json` claiming `<name>/config.json`) can never shadow the pin of `<org>/<name>`; among manifests the deepest one — the model's own — speaks for its files; `verify_model` hashes locally against the pin — no hub, so an air-gapped install gets a real verdict — and reports `damaged` with the `quarantined` names (remedy: `repair_model`, which re-fetches at the pinned revision). A file the store has no digest for (an operator's own rsynced model) is served as before and reported `unverified`.
  **Updating a pin** — the ONE procedure: `bun run scripts/pin_ai_models.ts --model <id> --reason "<why the digest changes>"` (or `--all`). It reads the hub's model API — `revision/main` for the commit sha, `tree/<sha>?recursive=true` for every LFS weight's `lfs.oid` (its sha256) — downloads and hashes the small non-LFS files at that revision, cross-checks sizes, and rewrites the model's block with `revision`, `pinned_at` and your `reason`. Never edit a digest by hand: `model_artifact_integrity_native` refuses an entry without a date and a reason, and a hand-invented digest quarantines every real download. A catalog model the hub does not serve is recorded under `unpinned` with the reason (shrink-only census). `--check` verifies coverage offline. Gate: `test/unit/model_artifact_integrity_native.test.ts`.
- **Speaker detection**: two config slots — `diarization_model` (pyannote segmentation ONNX, ~6 MB: who speaks when) and `diarization_embedding_model` (WeSpeaker ResNet34-LM ONNX, ~26 MB: voice fingerprints, so the same voice keeps the same id across the whole recording) — both in-browser via the same transformers.js runtime. A run saves IMMEDIATELY with placeholder tags (`[person-a-N-PN-data::data]`) opening every turn; the archivist binds identities any time via `assign_speakers` (header button; a deterministic whole-tag swap through the save path, TM-protected, re-bindable). `get_model_sources` reports both under `diarization` (`installed` = both present); `download_model` accepts either catalog name (diarization file profile — no tokenizer, mandatory preprocessor config). Pure post-processing in `transcribers/lib/diarize.js`; subsystem doc: `engineering/TRANSCRIPTION.md` "Speaker detection".
- The speaker/language/note tag helpers in the editor are NOT this tool's code: they belong to `component_text_area`'s edit view, fed server-side by the text_area's `properties.tags_persons` ontology config (EDIT data carries `tags_persons` + `related_sections`; the edit context carries `toolbar_buttons`). The tool's parent-record selector uses the `related_search` read. Wire shapes: `engineering/wire_contract/` WC-065/WC-066; subsystem doc: `engineering/TRANSCRIPTION.md` "The transcription helpers".

## How it is registered & surfaced

`tools/tool_transcription/register.json` is a **column-keyed dump** (`string`/`relation`/`misc`/… keyed by component tipo — a seeded matrix-row snapshot, not a hand-authored file); `importTools()` passes it through as-is (see [register.json reference](../register_json.md)). Essentials it declares:

- `name` (dd1326): `tool_transcription`; `version` (dd1327): `3.0.3`; `dedalo_version_min` (dd1328): `6.6.0`; developer (dd1644): "Dédalo team"; label (dd799): "Transcription".
- **affected_models** (dd1330 → dd1342 model records, section_ids 8 / 20 / 30): `component_av`, `component_image`, `component_pdf`. The tool therefore attaches inline to those media components.
- **active** (dd1354 → dd64 §1 = Yes): registered active.
- **show_in_inspector** (dd1331 → dd64 §1 = Yes) **and** **show_in_component** (dd1332 → dd64 §1 = Yes): both true — the button renders both in the inspector panel and inline in the component.
- `properties` (dd1335): `{ "open_as": "window", "windowFeatures": null }`.
- `default_config` (dd1633): the `transcriber_engine` / `transcriber_quality` blocks described above.
- UI labels (dd1372): a large multilingual set (`automatic_transcription`, `build_subtitles`, `quality`, `engine`, `chars_per_line`, `preparing_audio`, `processing_audio`, `initializing`, `setting_up`, `transcription_completed`, `readiness_model`/`readiness_language`/`readiness_speakers`/`readiness_interrupted`, `state_*`, `error_*`/`cause_*`/`action_*`, `warning_*`, `device`/`device_auto`/`device_gpu`/`cpu_device`, `paragraphs`, `tc_mode_*`, `cancel`, `regroup_paragraphs`, `large`/`small`/`medium`/`large_turbo`/`parakeet_v3`, …), fetched client-side via `get_tool_label(...)`.

!!! warning "A missing label fails silently, and forever"
    Every call site is written `get_tool_label('x') || 'English literal'`, so a key
    absent from the seed still RENDERS — in English, for every operator on the
    install. Nothing throws and nothing logs; the only symptom is one line of a
    translated panel that is not translated.

    Half this tool's strings are also reached INDIRECTLY, through key tables
    rather than literal calls: `MODEL_STATES` and the failure rules name their
    words as `state_key`/`message_key`/`cause_key`/`action_key`, `ACTION_LABELS`
    keys the remedies, and the worker posts a `label_key` with each degradation
    warning. Grepping for `get_tool_label('…')` therefore sees only half the
    surface — when the gate below was first written, 30 of the 49 missing keys
    lived in exactly that blind spot. Adding a NEW indirection means teaching the
    gate to read it.

    Editing the seed is not enough on a running install: the registry import is
    dormant, so a label lands only when it is merged into the tool's live
    `matrix_tools` row.

Surfacing is element-driven (`getElementTools`, `src/core/tools/registry.ts`): once the user's profile is authorized for the tool, its button appears on any `component_av`, `component_image` or `component_pdf` element (matched against `affected_models`). The transcription workbench is most useful on AV components that have an adjacent transcription `component_text_area` declared in the section's `tool_config.ddo_map`.

## Examples

Start a server-side (Babel) transcription — the RQO the client builds in `automatic_transcription_server()`:

``` js
const source = create_source(self, 'automatic_transcription') // → tool_transcription::automatic_transcription(options)
const rqo = {
    dd_api  : 'dd_tools_api',
    action  : 'tool_request',
    source  : source,
    options : {
        source_lang       : 'lg-spa',
        transcription_ddo : { component_tipo: 'dd32', section_id: 1, section_tipo: 'rsc167' }, // WRITE-gated text target
        media_ddo         : { component_tipo: 'rsc35', section_id: 1, section_tipo: 'rsc167' }, // source AV
        transcriber_engine  : 'babel_transcriber',
        transcriber_quality : 'large',
        config              : self.context.config
    }
}
data_manager.request({ body: rqo, retries: 1, timeout: 3600 * 1000 })
// → response.data.pid — an OPAQUE poll handle (not the transcriber's job id): it is
//   bound to this user, this engine and this recording, and sealed per server process.
//   The client polls check_server_transcriber_status with it every ~4s until the job
//   completes, while a detached server-side poll writes the finished transcript back
//   automatically (the status poll never returns the text itself)
```

`build_subtitles_file()` generates the VTT file once a transcript is ready:

``` js
const rqo = {
    dd_api  : 'dd_tools_api',
    action  : 'tool_request',
    source  : create_source(self, 'build_subtitles_file'),
    options : {
        component_tipo : component_text_area.tipo,        // text component holding the transcript
        section_tipo   : component_text_area.section_tipo,
        section_id     : component_text_area.section_id,
        lang           : component_text_area.data.lang,   // from data, not context
        max_charline   : 90,
        key            : 0
    }
}
data_manager.request({ body: rqo })
// → { result:true, url:'…/media/av/subtitles/rsc35_rsc167_1_lg-spa.vtt', msg:'OK. Request done successfully' }
```

The browser-Whisper path instead calls the `create_transcribable_audio_file` action (to get the 16 kHz WAV URL) and runs the model in a Web Worker client-side, writing the result straight into the text component with `set_value`.

## Gates

`test/unit/tool_transcription.test.ts` covers the server half (audio build,
action surface, the remote-ASR seam and its fail-closed cases) and, for the
client, the things that fail silently rather than loudly:

| Gate | What it stops |
| --- | --- |
| label coverage | Every key the client asks for exists in the seed, in every language the seed speaks — reading the key TABLES as well as the literal calls. A companion test pins the extractor itself with one canary key per indirection, so a pattern that stops matching fails instead of quietly shrinking the surface. |
| severity paint | Every emittable severity has a rule in the `.less` AND in the committed `.css`; and the panel prefixes the class (`severity_error`), so no row can collide with a page-wide utility. |
| readiness facts | The language line renders no `undefined` when a project language has no 2-letter code, and the model line names its model. |
| interrupted-run recovery | Partials stay isolated per model, records in the older single-slot shape still migrate, a finished run clears only its own slot, both resume remedies are pressable AND handled, and the unload guard is armed and disarmed at every exit. |

`test/unit/tool_transcription_gate_native.test.ts` drives every record action through
its handler with real identities (the component denied, out of scope, a missing ddo key,
the transcript writable but its AV not, the transcript in scope but ONLY the media record
out of scope) and asserts the refusal code — and, for the media source, that it names the
AV — AND that nothing was produced: no WAV, no VTT, no config or provider call. Its
background-save legs read the STORED transcription back: a grant revoked, or the account
deactivated, between the enqueue and the save leaves it empty; the live, granted twin
stores the transcript.

The pure client functions are tested as the REAL bytes — sliced out of the source
by their `}//end <name>` terminator, which the slice asserts — rather than
re-implemented in the test. `js/tool_transcription.js` cannot be imported in
isolation the way the render module can: its module body evaluates identifiers
from the tool's own dependency graph, so stripping the imports would leave a stub
chain that tests the stubs.

## Related

- [tool_subtitles](tool_subtitles.md) — rich-editor subtitle editing tied to AV transcription text
- [tool_tr_print](index.md) — printable/formatted transcript + VTT rendering
- [tool_tc](index.md) — offset all `[TC_…_TC]` timecodes at once
- [tool_pdf_extractor](index.md) — gated PDF text extraction (the supported route for PDF text)
- [tool_posterframe](tool_posterframe.md) and [tool_media_versions](tool_media_versions.md) — other AV media tooling
- [tool_lang](tool_lang.md) / [tool_lang_multi](index.md) — translate the transcribed text
- [Creating new tools](../creating_tools.md), [Server contract](../server_contract.md), [register.json reference](../register_json.md), [Security](../security.md)
- [Exporting data](../../../using/exporting_data.md) (the [tool_export](tool_export.md) side)
- Source: `tools/tool_transcription/server/index.ts`; local audio core: `src/core/media/tools/transcription.ts`; ASR provider seam: `src/core/tools/transcription_asr.ts`.
