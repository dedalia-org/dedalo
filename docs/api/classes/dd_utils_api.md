# dd_utils_api

> See also: [JSON API v1](../dedalo_api_v1.md) · [RQO field mapping](../RQO_FIELD_MAPPING.md) · [dd_core_api](dd_core_api.md)

Utility API for system operations: authentication, language, system info, and upload assembly.

Registered actions (`src/core/api/handlers/dd_utils_api.ts`): `login`, `quit`, `get_login_context`, `request_password_reset`, `confirm_password_reset`, `get_system_info`, `get_dedalo_files`, `change_lang`, `convert_search_object_to_sql_query`, `join_chunked_files_uploaded`, `list_uploaded_files`, `delete_uploaded_file`, `get_job_events`, `get_process_status`, `get_record_jobs`, `get_activity`, `stop_process`, `update_lock_components_state`, `get_lock_status`, `get_server_ready_status`, `get_ontology_update_info`, `get_code_update_info`.

## How to call

- POST JSON to `/api/v1/json` (or the client-relative `/dedalo/core/api/v1/json`) with `dd_api: "dd_utils_api"` and `action: "<method>"`.
- Multipart file uploads are **not** a JSON-dispatched action here — they are handled by the media ingest branch of the API path in `src/server.ts`.

## Notes

- `login` and `quit` are the entry points for session management: Argon2id (via `Bun.password`) over rotating, server-side sessions.
- `join_chunked_files_uploaded` reassembles a completed chunked upload; `get_system_info` is the pre-transfer init call the client makes before uploading.
- `get_server_ready_status`, `get_ontology_update_info` and `get_code_update_info` are the master-server surface: remote installations call them without a session to probe reachability and fetch an update manifest. They fail closed unless the host is configured as an ontology or code server.
- **Envelope v2 throughout.** Success is `{ ok: true, request_id, data, … }` — the payload lives in `data`, and the names a client reads by their own name (`user_id`, `csrf_token`, `file_data`, `dedalo_version`, `in_use`, `jobs`, `msg`, …) ride at the top level as **extension keys**. A refusal is `{ ok: false, request_id, error: { code, category, message, label_key, retryable } }` and carries the registry's HTTP status; failures are no longer HTTP-200 bodies. The v1 `{ result, msg, errors }` shape was removed on 2026-08-16 and `result` is a **forbidden** top-level key.

## login

### Purpose

Authenticate user with username and password.

### Accepts

- `options`: object (required)
  - `username`: string (required) — user login name
  - `auth`: string (required) — user password

### Returns

`{ ok: true, request_id, data: true, user_id: <int>, csrf_token: <string> }`. `user_id` and `csrf_token` are handler-owned top-level extension keys: the session is minted mid-handler, so the dispatcher's own token append cannot see it.

### Usage

Validates credentials and, on success, creates a rotating server-side session. The session token is set as an HTTP cookie on the response — it is never returned in the body; the fresh `csrf_token` ships in the body so the next non-exempt action can succeed. `login` is a `NO_LOGIN` / CSRF-exempt action.

When media protection is active the response carries a **second** cookie, the fixed-name `dedalo_media_auth` (see [media protection](../../core/system/media_protection.md)). Every later authenticated response re-issues it if the caller's value is stale, so it never outlives — nor dies before — the session.

A wrong username, a wrong password and an unknown account all answer the **same** body — `auth.login_failed` (HTTP 401). The sentence is the registry's and its disclosure is operator-only, so no call site can narrow it into an account-existence oracle.

Once the session expires, any non-exempt action answers `auth.not_logged` (**HTTP 401**). See [login](../../core/system/login.md) for the two expiry clocks and the client's recovery.

### Example Request

```json
{
  "dd_api": "dd_utils_api",
  "action": "login",
  "options": {
    "username": "admin",
    "auth": "secret"
  }
}
```

### Example Response

```json
{
  "ok": true,
  "request_id": "c0ffee90",
  "data": true,
  "user_id": 1,
  "csrf_token": "…"
}
```

## quit

### Purpose

Logout current user session.

### Accepts

- `options`: object (optional) — typically empty

### Returns

`{ ok: true, request_id, data: true }`.

### Usage

Destroys the server-side session and clears the session cookie on the response — and the media-auth cookie with it, unconditionally, since clearing an absent cookie costs nothing while leaving a live one behind does not. An activity row is written **before** the session is destroyed, while the actor is still known.

### Example Request

```json
{
  "dd_api": "dd_utils_api",
  "action": "quit"
}
```

### Example Response

```json
{
  "ok": true,
  "request_id": "c0ffee91",
  "data": true
}
```

## upload — handled outside the JSON dispatcher

`upload` is **not** a JSON-dispatched action. Multipart uploads (single or chunked) hit the media ingest branch of the API path in `src/server.ts`, which routes the form data into `src/core/media/ingest/upload.ts`. Once all chunks have arrived the client fires a JSON `join_chunked_files_uploaded` RQO (below) to reassemble and re-sniff them.

## join_chunked_files_uploaded

### Purpose

Reassemble a completed chunked upload (the JSON follow-up to the multipart chunk POSTs).

### Accepts

- `options`: object (required)
  - `file_data`: object — `{ key_dir, tmp_name, total_chunks, upload_id }`, the descriptor the last chunk response returned. `upload_id` identifies the transfer whose parts are to be joined; a malformed one is refused, and an absent one falls back to matching the recorded file name and part count (ambiguous matches are refused rather than guessed).
  - `files_chunked`: array (optional) — the dense chunk list (its length is used as `total_chunks` when present)

### Returns

`{ ok: true, request_id, data: true, file_data: { key_dir, tmp_name, name, extension, chunked: false, complete: true, thumbnail_url } }` — `file_data` is a top-level extension key.

- `tmp_name` is the name the assembled file really has in the staging directory, which may carry a `-1`, `-2` … suffix when another staged file already held the sanitised name.
- `name` is the **human** file name, taken from the server's own per-transfer record, not from the relayed request — which is why a caller that does not echo it back still archives `María Piñón.jpg` rather than a mangled transliteration.
- `thumbnail_url` is the preview the queue row draws, or `null` when the format is not rasterisable. A chunked transfer's only completion moment is this call, so the thumbnail is built here exactly as the single-shot upload path builds it.

Fail-closed: an anonymous caller gets `resource.not_found` (HTTP 404) — the same shape a route miss answers, so the endpoint leaks no existence. A failed join answers `media.action_failed`; the engine's reason names filesystem paths and stays on the log line.

Idempotent per `upload_id`: a large join can outlast the request and proxy timeouts, so the client resends it until it settles. A resend while the first join is still running answers `media.upload_conflict` (retryable); a resend after it finished answers the same `file_data` again, read from a `joined.json` record left in the transfer's `.up_<upload_id>` folder, as long as the staged file still exists. A join without `upload_id` is not replayable. A refusal the engine already classified (`media.upload_conflict`, `media.upload_rejected`, …) is passed through as is rather than turned into `media.action_failed`.

## list_uploaded_files

### Purpose

List files in upload directory.

### Accepts

- `options.key_dir`: string (required in practice) — the staging sub-directory to scan. **Without it the answer is an empty array**, not the whole staging root.

### Returns

`{ ok: true, request_id, data: [ { url, name, size }, … ] }` — the caller's own staged files under `key_dir`. This is the mechanism by which a pending upload queue survives a page reload: the queue renderer lists the already-staged files on every render and injects them as existing rows.

!!! note
    The answer is **always** a 200 with an array, even when the staging scan itself fails (a malformed `key_dir`, an unreadable root): the failure is logged and an empty array returned. An error here would accumulate into the page's API-error list, which makes the *next* element's render bail before it finishes — one bad scan would break unrelated widgets on the page.

### Example Request

```json
{
  "dd_api": "dd_utils_api",
  "action": "list_uploaded_files",
  "options": { "key_dir": "upload" }
}
```

### Example Response

```json
{
  "ok": true,
  "request_id": "c0ffee92",
  "data": []
}
```

## delete_uploaded_file

### Purpose

Remove one staged file — the queue renderer's row-removal path.

### Accepts

- `options`: object (required)
    - `key_dir`: string (required) and `file_name`: string (required).
    - `upload_id`: string (optional) — an explicit cancel. A row removed *before* its transfer completed has no assembled file, only chunk parts; with this key they go now, without it the age sweep collects them. It is also the release for a **quarantined** transfer — one whose assembled bytes failed content verification and were kept rather than destroyed.

### Returns

`{ ok: true, request_id, data: true }`. Deleting an already-absent file is a successful **no-op**: the client has already removed the row, and a retry must not surface an error the user cannot act on.

A traversal attempt or a malformed name answers `request.invalid_options` with a generic *"Invalid file reference"* — the resolver's own message names the resolved path and is never serialized.

## get_system_info

### Purpose

Retrieve system and server information.

### Accepts

- `options`: object (optional) — none required.

### Returns

`{ ok: true, request_id, data: <SystemInfo> }`. The payload (`src/core/api/handlers/system_info.ts`) is the upload-limit negotiation the client reads before it can transfer a file. The numbers come from the media/upload config catalog — there is no runtime `.ini` to consult. Shape: `{ max_size_bytes, sys_get_temp_dir, upload_tmp_dir, upload_tmp_perms, session_cache_expire, upload_service_chunk_files, pdf_ocr_engine }`.

### Example Request

```json
{
  "dd_api": "dd_utils_api",
  "action": "get_system_info"
}
```

### Example Response

```json
{
  "ok": true,
  "request_id": "c0ffee93",
  "data": {
    "max_size_bytes": 10485760,
    "sys_get_temp_dir": "/tmp",
    "upload_tmp_dir": "/…/media/tmp",
    "upload_tmp_perms": 16877,
    "session_cache_expire": 180,
    "upload_service_chunk_files": 20,
    "pdf_ocr_engine": true
  }
}
```

## change_lang

### Purpose

Persist the user's interface and/or data language choice for subsequent requests.

### Accepts

- `options`: object (required)
  - `dedalo_application_lang`: string (optional) — the interface language
  - `dedalo_data_lang`: string (optional) — the data language

At least one must be present. Each value is validated against the language identifier allowlist **before** it is stored (an invalid tag is dropped, never persisted). When the install couples the two languages, a change to either drives the other.

### Returns

`{ ok: true, request_id, data: true }`. With no valid language supplied the call **refuses** with `request.invalid_options` (*"No valid language supplied"*) — an invalid tag is dropped before validation, so naming only invalid tags is the same as naming none.

### Usage

State-changing. For an authenticated caller the router runs the CSRF gate and the choice is stored on the server-side session; every later request rebuilds with the stored language (`src/core/resolve/request_lang.ts`). The client posts here, then full-reloads.

An **anonymous** call naming only `dedalo_data_lang` answers `auth.not_logged` (HTTP 401): there is nowhere to store a data language before login, and answering success while storing nothing would be a silent no-op.

The action is **also reachable without a session** — the login panel carries its own language selector, and there is no session row to store into before login. The server answers with the pre-auth language cookie (`dedalo_lang`, HttpOnly, one year) carrying the **application** language only — an anonymous call naming only `dedalo_data_lang` is refused (`auth.not_logged`), since there is nowhere to put it. The cookie is honored on the next anonymous request and adopted onto the session at login, so the app opens in the language the login form was switched to; **authenticated** calls refresh it too, so the two stores never disagree. The value is checked against this install's `DEDALO_APPLICATION_LANGS` when read back — a cookie naming any other language is ignored, not persisted. Divergence entry: `engineering/wire_contract/WC-2026-08-22-preauth-language-cookie.md`.

### Example Request

```json
{
  "dd_api": "dd_utils_api",
  "action": "change_lang",
  "options": {
    "dedalo_application_lang": "lg-eng",
    "dedalo_data_lang": "lg-spa"
  }
}
```

### Example Response

```json
{
  "ok": true,
  "request_id": "c0ffee94",
  "data": true
}
```

## get_login_context

### Purpose

Return the login form's own structure context.

### Accepts

- No arguments.

### Returns

`{ ok: true, request_id, data: [ <login context> ] }` — `data` is an **array** of one element, because the client build looks its own element up inside it by model.

### Usage

Pre-auth by design — the form must render before any session exists.

## request_password_reset

### Purpose

Forgot-password step 1: request a reset for an identifier.

### Accepts

- `options`: object (required)
  - `identifier`: string (required) — username or email

### Returns

A generic envelope that is identical regardless of whether the identifier exists (anti-enumeration).

### Usage

Pre-auth by design (`NO_LOGIN` + CSRF-exempt). Anti-enumeration and throttling live in `src/core/security/password_reset.ts`.

### Example Request

```json
{
  "dd_api": "dd_utils_api",
  "action": "request_password_reset",
  "options": {
    "identifier": "admin"
  }
}
```

## confirm_password_reset

### Purpose

Forgot-password step 2: confirm the reset with the emailed code and set a new password.

### Accepts

- `options`: object (required)
  - `reset_id`: string (required)
  - `code`: string (required)
  - `new_password`: string (required)

### Returns

The generic reset envelope (`src/core/security/password_reset.ts`).

### Usage

Pre-auth by design, like `request_password_reset`.

## update_lock_components_state

### Purpose

Record a component soft-lock focus/blur event (the edit-lock mechanism).

### Accepts

- `options`: object (required)
  - `section_tipo`: string (required) — the locked record's section
  - `section_id`: int|string (optional)
  - `component_tipo`: string (optional)
  - `action`: string (optional) — the focus/blur event

### Returns

`{ ok: true, request_id, data: <applied bool>, in_use, full_username, msg, dedalo_notification: null, … }`. `data` is whether the event was applied; the keys the client reads by name ride at the top level as extension keys.

### Usage

Read permission (level ≥ 1) on the section is required — the gate runs unconditionally and `section_tipo` is mandatory (fail-closed), so a user cannot fabricate focus/blur on records they cannot see. This is the per-component soft-lock, distinct from the area-level `dd_area_maintenance_api::lock_components_actions`.

### Example Request

```json
{
  "dd_api": "dd_utils_api",
  "action": "update_lock_components_state",
  "options": {
    "section_tipo": "oh1",
    "section_id": 368,
    "component_tipo": "oh16",
    "action": "lock"
  }
}
```

## get_lock_status

### Purpose

Read-only poll: is the component currently held by another user?

### Accepts

- `options`: object (required)
  - `section_tipo`: string (required)
  - `section_id`: int|string (optional)
  - `component_tipo`: string (optional)

### Returns

`{ ok: true, request_id, data: true, in_use, full_username, … }` — the status fields ride as top-level extension keys (`in_use` is what the client's release poll reads); `data` stays a truthy answer.

### Usage

Same fail-closed read gate as `update_lock_components_state` (`section_tipo` required, level ≥ 1 on the section).

## get_dedalo_files

### Purpose

Return the service-worker pre-cache manifest.

### Accepts

- No arguments.

### Returns

The manifest rides in the standard envelope: `data` carries the `{type, url}[]`
list and `dedalo_version` rides beside it as an extension key. The clients read
`response_data(api_response)` for the list and `api_response.dedalo_version` for
the cache key — there is no top-level `result` or `msg` on the wire.

### Usage

Authenticated read (a session is required) but CSRF-exempt: the service worker calls it without the page's token.

### What the client does with it

`dedalo_version` is **the cache key**, not a display string: it carries the engine
version plus a signature of the client bytes on disk, so editing any manifested file
moves the key and the browser re-fetches. The service worker names its cache
`dedalo_files_<dedalo_version>` and owns every key with that prefix.

The worker is `core/service_worker.js`, registered by the login as a module. The
older URL `core/sw.js` is not the worker: it is a permanent replacement for the v6
worker that browsers still hold there. It handles no request, deletes the v6
`dedalo_files` cache (the unversioned key), unregisters itself and reloads the
windows that ran v6 code. Neither file is in the manifest.

A cache pass follows a fixed **commit order** — fetch every file, write the manifest
record *inside* the cache, purge the superseded caches, then swap the worker's
in-memory state. The manifest record is the *commit marker*: it means "this cache is
whole". A worker killed mid-pass leaves an unmarked cache, which is ignored, so the
last complete cache keeps serving. A pass that stores too little refuses to write the
marker at all, leaving the previous cache authoritative rather than replacing a
working cache with an empty one.

Because a service worker is killed whenever it goes idle and its module state dies
with it, a revived worker rebuilds that state from the marker with no network call,
and re-checks the version periodically so a deploy is picked up without a new login.

The worker reports progress to the login page as `ready`, `loading`, `waiting` and
`finish` messages. `finish` is what the login navigates on, and it is always sent —
success or failure, with an `error` field — because a missing `finish` does not
degrade the login, it hangs it. The login also runs its own watchdog and continues
anyway if every cache path goes silent. That message seam is frozen by the wire
contract ledger entry `WC-2026-08-21-files-cache-finish-message`.

## get_job_events

### Purpose

Subscribe to a native in-process job and receive every state change as it happens.

### Accepts

- The job handle (`job_id`) the caller is subscribing to.

### Returns

A pushed event stream; the stream ends on the terminal frame, whose `data` is the job's return value (for an import, the full report).

### Usage

Session-gated (`src/core/api/job_stream.ts`). This is the native job-status wire — no `{pid, pfile}` handle and no polling; `get_process_status` below is the legacy poll wire kept for the AV-transcode and backup consumers.

## get_process_status

### Purpose

Stream the status of a background process (media transcode / backup).

### Accepts

- The job identifier the client's `update_process_status` polls.

### Returns

An SSE status stream (`src/core/api/process_status.ts`).

### Usage

Session-gated and **owner-gated** — a job that carries user data streams only to its owner, since the ids are guessable. The legacy poll counterpart to `get_job_events`.

## get_record_jobs

### Purpose

Answer "what is running for **this** record?" — the question that made an upload's background transcode invisible and an empty media tier indistinguishable from "never built".

### Accepts

- `options`: object (required)
    - `section_tipo`: string (required) and `section_id`: int (required, positive).

### Returns

`{ ok: true, request_id, data: true, jobs: [ … ] }` — `jobs` is the top-level key the activity tray reads by name.

### Usage

Authorized **by the record**, not by job ownership (read level ≥ 1 on the section) — a second operator looking at the same record must see that a tier is already being built, or they start a duplicate encode over the same output path. The payload is therefore reduced to operational shape: a foreign job's own `data` stays owner-only. A missing `section_tipo` or a non-integer `section_id` answers `request.invalid_options`; an insufficient grant answers `perm.denied`.

## get_activity

### Purpose

The activity tray's read model: the caller's **own** work, aggregated across both job systems.

### Accepts

- No arguments.

### Returns

`{ ok: true, request_id, data: true, jobs: [ … ] }`.

## stop_process

### Purpose

Stop a background job (the generic Stop button's wire).

### Accepts

- The job identifier to abort.

### Returns

The stop outcome (`src/core/api/process_status.ts`).

### Usage

Session-gated and owner-gated. It aborts the job's controller so the handler winds down cooperatively.

## convert_search_object_to_sql_query

### Purpose

The SQO → SQL developer console (the `sqo_test_environment` maintenance widget): translate a client SQO to SQL and run it.

### Accepts

- `options`: object (required) — the client SQO to convert (scrubbed by `sanitizeClientSqo`, the API-boundary security gate).

### Returns

`{ ok: true, request_id, data: { sql_resolved, sql, ar_section_id, db_data } }`. The console's answer is the four pieces **together**, so they are the payload, not top-level keys beside a boolean:

- `sql_resolved` — the resolved SQL with its parameters substituted, **display only**. Envelope v2 has no prose channel, so it is a named field of the data rather than a message.
- `sql` — the parameterized template actually executed.
- `ar_section_id` — the distinct `section_id`s the rows returned.
- `db_data` — the rows.

### Usage

**Global-admin only** (`perm.denied`, HTTP 403, for everyone else). The executed query always uses bound params; the substituted string is for display, never execution. A build or execution failure answers `search.failed`.

### Example Request

```json
{
  "dd_api": "dd_utils_api",
  "action": "convert_search_object_to_sql_query",
  "options": {
    "section_tipo": ["oh1"],
    "limit": 10
  }
}
```

## get_server_ready_status

### Purpose

Remote reachability probe: is this host an available ontology / code master server?

### Accepts

- `options`: object (required)
  - `check`: string (required) — `ontology_server` or `code_server`

### Returns

`{ ok: true, request_id, data: true }` when the requested check matches a role this host is configured for. Every other outcome is the **same** refusal — `update_server.refused` (HTTP 403, *"Error. This is not an accessible Server"*). One code for every reason is deliberate: a probe must not be able to tell "not that kind of server" from "unknown check" by elimination.

### Usage

Machine-to-machine, pre-auth (`NO_LOGIN` + CSRF-exempt). Fail-closed on the configuration flags.

### Example Request

```json
{
  "dd_api": "dd_utils_api",
  "action": "get_server_ready_status",
  "options": {
    "check": "ontology_server"
  }
}
```

## get_ontology_update_info

### Purpose

Serve an ontology-update manifest to a remote installation.

### Accepts

- `options`: object (required)
  - `version`: string (required) — the caller's `major.minor`
  - `code`: string (required) — a configured access code

### Returns

`{ ok: true, request_id, data: <manifest> }` when this host is an ontology master and the code and version both validate. Every refusal — not a master, wrong code, malformed or unsupported version, a version with no ontology files — is the same `update_server.refused` (HTTP 403), for the same anti-enumeration reason as the probe.

### Usage

Served **only** when this instance is an ontology master, to callers presenting a configured access code. Pre-auth master-server surface.

!!! warning
    The update panel of the client installation calls this action **from the browser**, cross-origin — not through its own server, so it has to get past a gate at *each* end.

    On the **master**: the client's origin must be accepted by [`DEDALO_CORS_ALLOWED_ORIGINS`](../../config/config.md#cross-origin-api-callers-cors) — named exactly, or covered by the single entry `*` on a master serving installations it does not know in advance. Otherwise the preflight fails and the panel dies with a network error.

    On the **client**: its own `connect-src` Content-Security-Policy must carry the master's origin, or the browser refuses the call before it leaves. The engine derives that from the client's [`ONTOLOGY_SERVERS`](../../config/config.md#ontology-servers) automatically, but at boot — a client that has just added a master must be restarted.

    The reachability probe next to it (`get_server_ready_status`) is a server-to-server request and is affected by **neither**, so a master can report itself *ready* and still be unreachable from the panel. A cross-origin caller carries no session cookie: it reaches only this pre-auth surface, and admitting an origin grants nothing more.

## get_code_update_info

### Purpose

Serve a code-release manifest to a remote installation.

### Accepts

- `options`: object (required)
  - `version`: string (required) — the caller's version triple
  - `code`: string (required) — a configured `CODE_SERVERS` code

### Returns

`{ ok: true, request_id, data: <manifest> }` when this host is a code master and the code and version both validate; every refusal is `update_server.refused` (HTTP 403). It advertises only built release archives on the caller's linear upgrade path. Unlike the ontology master, a code master honours **no** localhost pseudo-code: it answers configured peers only.

### Usage

Served **only** when this instance is a code master, to callers presenting a configured code. Pre-auth master-server surface.
