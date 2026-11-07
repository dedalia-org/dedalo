# Dédalo API: RQO field mapping

> See also: [JSON API v1](dedalo_api_v1.md) · [Class reference](classes/dd_core_api.md) · [The diffusion engine](../diffusion/native_engine.md)

This page documents the precise, method-specific RQO field usage for the actions the server implements. Every action here is verified against the action registry in `src/core/api/dispatch.ts` — if an action is not in that registry, it is not callable and it is not documented here.

**Every response below is envelope v2**: `{ ok: true, request_id, data, … }` on success — the payload lives in `data`, and the keys a client reads by their own name (`environment`, `table`, `user_id`, `csrf_token`, …) ride at the top level as extension keys — and `{ ok: false, request_id, error: { code, category, message, label_key, retryable } }` on a refusal, carrying the registry's HTTP status. The v1 `{ result, msg, errors }` shape was removed on 2026-08-16 and `result` is a **forbidden** top-level key. Canon: `engineering/ERRORS_SPEC.md` and [the error system](../core/system/errors.md).

## dd_core_api

### start()
**Purpose**: Initialize the client — return the boot context plus the full environment block.
**RQO fields used**:
- `options`: object (optional)
  - `search_obj`: object (optional) — the client's URL vars: `t`/`tipo`, `st`/`section_tipo`, `id`/`section_id`, `m`/`mode`, `view`, `tool`, or a whole `locator`.
  - `menu`: boolean (optional) — also describe the menu element so the client mounts the header.

Unauthenticated (`session === null`) `start` returns the **login element context** (this is what renders the login form). Authenticated `start` returns the page element context derived from `search_obj`, plus the environment.

**Example request**:
```json
{
  "dd_api": "dd_core_api",
  "action": "start",
  "options": { "search_obj": {}, "menu": true }
}
```

**Example response** (authenticated):
```json
{
  "ok": true,
  "request_id": "c0ffeb00",
  "data": { "context": [ /* section/menu element contexts */ ], "data": [] },
  "environment": { "page_globals": {}, "plain_vars": {} }
}
```

---

### read()
**Purpose**: Retrieve record / component data. The concrete strategy branches on `source.action` and whether a `section_id` is present (`readSection`, `readComponentData`, `resolveSearchData`, `buildRelationList`).
**RQO fields used**:
- `source`: object
  - `section_tipo`: string — section type identifier
  - `section_id`: int (optional) — specific record to read. A record address is always an integer (negatives are valid: `-1` is the root record); a numeric string still coerces at the boundary but is **deprecated** and counted. Leading-zero or opaque values (`001338683`, `Q42`) are external-service remote ids, not addresses, and are kept verbatim; synthetic tokens (`search_1`) echo verbatim. Law: `engineering/wire_contract/WC-2026-08-10-section-id-int-canonical.md`
  - `tipo`: string (optional) — component type
  - `model`: string (optional) — component model (a `component_*` model routes to a component read)
  - `mode`: string (optional) — `edit`, `list`, `search`
  - `action`: string (optional) — `get_data` (component pagination), `resolve_data` (search filter chips), `get_relation_list` (the References panel)
  - `lang`: string (optional)
- `sqo`: object (optional) — search query object; `sqo.section_tipo` is mandatory whenever an `sqo` is sent (a string or an array of section tipos), plus `limit`, `offset`, filters; `sqo.mode: "tm"` routes to the Time Machine read source. A section read (`readSectionRows`) also needs `source.tipo` (the section's own tipo), or it is refused with `request.invalid_source`.

**Permission gate**: read requires level ≥ 1 on `(section_tipo, tipo)` and on every SQO target section.

**Example request** (a section list read; `source.tipo` names the section itself, `sqo.section_tipo` the sections to read):
```json
{
  "dd_api": "dd_core_api",
  "action": "read",
  "source": { "tipo": "rsc167", "section_tipo": "rsc167", "mode": "list" },
  "sqo": { "section_tipo": ["rsc167"], "limit": 10, "offset": 0 }
}
```

**Example response**:
```json
{
  "ok": true,
  "request_id": "c0ffeb01",
  "data": { "context": [ /* structure contexts */ ], "data": [ /* records */ ] }
}
```

---

### read_raw()
**Purpose**: Return the raw stored value(s) for a SQO's matched records.
**RQO fields used** (note: these live in **`options`**, not `source`):
- `options`: object (required)
  - `section_tipo`: string (required)
  - `tipo`: string (required)
  - `model`: string (optional)
  - `type`: string (optional)
- `sqo`: object (optional) — target sections default to `[options.section_tipo]` when absent.

**Permission gate**: level ≥ 1 on every SQO target section.

**Example request**:
```json
{
  "dd_api": "dd_core_api",
  "action": "read_raw",
  "options": { "section_tipo": "rsc167", "tipo": "rsc167" },
  "sqo": { "section_tipo": ["rsc167"], "limit": 1 }
}
```

**Example response**:
```json
{
  "ok": true,
  "request_id": "c0ffeb02",
  "data": [ /* raw stored values per matched record */ ],
  "table": "matrix"
}
```

---

### create()
**Purpose**: Create a new (blank) section record.
**RQO fields used**:
- `source`: object (required)
  - `section_tipo`: string (required) — target section type

**Permission gate**: level ≥ 2 on the section. `data` is the new `section_id` (an int).

**Example request**:
```json
{
  "dd_api": "dd_core_api",
  "action": "create",
  "source": { "section_tipo": "rsc167" }
}
```

**Example response**:
```json
{
  "ok": true,
  "request_id": "c0ffeb03",
  "data": 125
}
```

---

### duplicate()
**Purpose**: Clone a record into a new one, with all its data.
**RQO fields used**:
- `source`: object (required)
  - `section_id`: int (required) — source record to duplicate
  - `section_tipo`: string (required) — section type

**Permission gate**: level ≥ 2 on the section; a non-admin must also have the source record in their projects scope. `data` is the new `section_id` (an int).

**Example request**:
```json
{
  "dd_api": "dd_core_api",
  "action": "duplicate",
  "source": { "section_id": 1, "section_tipo": "rsc167" }
}
```

**Example response**:
```json
{
  "ok": true,
  "request_id": "c0ffeb04",
  "data": 126
}
```

---

### delete()
**Purpose**: Delete a record (`delete_record`) or empty its data (`delete_data`, the default).
**RQO fields used**:
- `source`: object (required)
  - `section_tipo`: string (required; `tipo` is accepted as a fallback)
  - `section_id`: int (required unless `sqo` is present)
  - `delete_mode`: string (optional, default `"delete_data"`) — `"delete_data"` empties every component and keeps the row; `"delete_record"` removes the row (TM snapshot first).
- `sqo`: object (optional) — bulk delete by search; **global-admin only**, and constrained to the gated section.

`data` is the array of deleted `section_id`s (**ints**). Children that refused to go do not fail the call: they ride as one `record.delete_children_refused` entry in `notices[]`, listing the refused ids. Ontology-main sections cascade (uninstall the TLD) under `delete_record`, global-admin only.

**Example request**:
```json
{
  "dd_api": "dd_core_api",
  "action": "delete",
  "source": { "section_tipo": "rsc167", "section_id": 528, "delete_mode": "delete_record" }
}
```

**Example response**:
```json
{
  "ok": true,
  "request_id": "c0ffeb05",
  "data": [1]
}
```

---

### save()
**Purpose**: Save component data to a record.
**RQO fields used**:
- `source`: object (required)
  - `tipo`: string (required) — component type
  - `section_tipo`: string (required) — parent section type
  - `section_id`: int (required) — parent section id
  - `lang`: string (optional, default `"lg-nolan"`) — language code
  - `caller_dataframe`: object (optional) — dataframe pairing context (`main_component_tipo`, `id_key`)
- `data`: object (required)
  - `changed_data`: array (required) — change objects, each `{ action, id?, value, key? }` where `action` ∈ `update` / `insert` / `remove` / `set_data` / `sort_data` / `sort_by_column` / `add_new_element`. `id` targets an existing item; `value` is `{ id, lang, value }` for a literal and a locator for a relation.

**Permission gate**: level ≥ 2 on `(section_tipo, tipo)`. On success the server echoes the saved component in the canonical DataItem envelope (relation/select-family saves also carry `datalist` / `pagination` / `context`), triggers server-side observers, and writes an activity-log entry. The echo of a translatable literal carries only the `source.lang` slice — see [dd_core_api → save](classes/dd_core_api.md#save).

**Example request**:
```json
{
  "dd_api": "dd_core_api",
  "action": "save",
  "source": {
    "tipo": "oh16",
    "section_tipo": "oh1",
    "section_id": 368,
    "lang": "lg-eng"
  },
  "data": {
    "changed_data": [
      { "action": "update", "id": 1, "value": { "id": 1, "lang": "lg-eng", "value": "Updated Title" } }
    ]
  }
}
```

**Example response**:
```json
{
  "ok": true,
  "request_id": "c0ffeb06",
  "data": {
    "context": [],
    "data": [
      {
        "tipo": "oh16",
        "section_tipo": "oh1",
        "section_id": 368,
        "mode": "edit",
        "lang": "lg-eng",
        "from_component_tipo": "oh16",
        "entries": [ { "id": 1, "lang": "lg-eng", "value": "Updated Title" } ]
      }
    ]
  }
}
```

---

### count()
**Purpose**: Count records matching a SQO. The read strategy owns counting (the default matrix source runs the SQO full-count; the TM source counts `matrix_time_machine`).
**RQO fields used**:
- `sqo`: object (required) — `section_tipo`, filters, `mode` (`related` counts inverse references).

**Permission gate**: level ≥ 1 on every SQO target section.

**Example request**:
```json
{
  "dd_api": "dd_core_api",
  "action": "count",
  "sqo": { "section_tipo": ["rsc167"] }
}
```

**Example response**:
```json
{
  "ok": true,
  "request_id": "c0ffeb07",
  "data": { "total": 42 }
}
```

---

### get_element_context()
**Purpose**: One element's structure context (no data). Covers section / component / area / tool models.
**RQO fields used**:
- `source`: object (required)
  - `tipo`: string (required for section/component; omitted for a tool, which sends `model: "tool_x"`)
  - `section_tipo`: string (optional, defaults to `tipo`)
  - `mode`: string (optional, default `"list"`)
  - `lang`: string (optional, default = the request's data language: the session's choice, else `DEDALO_DATA_LANG`). A translatable element's entry echoes it as `lang`; a non-translatable one answers `lg-nolan`
  - `model`: string (optional)

**Permission gate**: level ≥ 1 on `(section_tipo, tipo)`. `data` is an array of one context entry (empty when nothing resolves).

**Example request**:
```json
{
  "dd_api": "dd_core_api",
  "action": "get_element_context",
  "source": { "section_tipo": "oh1", "tipo": "oh16", "mode": "edit" }
}
```

---

### get_section_elements_context()
**Purpose**: The edit-mode search-filter panel's element list.
**RQO fields used**:
- `options`: object — passed to `buildSectionElementsContext`. Permissions are **always** enforced server-side (the client's `skip_permissions` flag is ignored).

**Example request**:
```json
{
  "dd_api": "dd_core_api",
  "action": "get_section_elements_context",
  "options": { "section_tipo": "oh1" }
}
```

---

> The ontology locator of a `tipo` is not exposed as an API action: it is resolved internally through the ontology resolver (`src/core/ontology/resolver.ts`).

---

## dd_utils_api

### login()
**Purpose**: Authenticate a user (Argon2id via `Bun.password`; rotating server-side session).
**RQO fields used**:
- `options`: object (required)
  - `username`: string (required)
  - `auth`: string (required) — the password

**Example request**:
```json
{
  "dd_api": "dd_utils_api",
  "action": "login",
  "options": { "username": "admin", "auth": "secret" }
}
```

**Example response** (a session cookie is set on the HTTP response; the session token is never returned in the body — the client uses the fresh `csrf_token`):
```json
{
  "ok": true,
  "request_id": "c0ffeb08",
  "data": true,
  "user_id": 1,
  "csrf_token": "…"
}
```

---

### quit()
**Purpose**: Log out — destroy the server-side session and clear the cookie.
**RQO fields used**: none.

**Example request**:
```json
{ "dd_api": "dd_utils_api", "action": "quit" }
```

**Example response**:
```json
{ "ok": true, "request_id": "c0ffeb09", "data": true }
```

---

### get_system_info()
**Purpose**: The upload / import / media-edit init call — the client reads it before it can transfer a file.
**RQO fields used**: none. The payload comes from the media/upload config catalog; there is no runtime `.ini` to consult.

**Example request**:
```json
{ "dd_api": "dd_utils_api", "action": "get_system_info" }
```

**Example response** (shape from `src/core/api/handlers/system_info.ts`):
```json
{
  "ok": true,
  "request_id": "c0ffeb10",
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

---

### change_lang()
**Purpose**: Persist the user's interface / data language on the session. Every subsequent request rebuilds with the stored language (`src/core/resolve/request_lang.ts`).
**RQO fields used**:
- `options`: object
  - `dedalo_application_lang`: string (optional) — validated against the ontology lang allowlist
  - `dedalo_data_lang`: string (optional) — validated against the allowlist

**Example request**:
```json
{
  "dd_api": "dd_utils_api",
  "action": "change_lang",
  "options": { "dedalo_application_lang": "lg-eng", "dedalo_data_lang": "lg-eng" }
}
```

**Example response**:
```json
{ "ok": true, "request_id": "c0ffeb11", "data": true }
```

---

### list_uploaded_files()
**Purpose**: List the caller's already-staged files under one staging sub-directory — the mechanism by which a pending upload queue survives a page reload.
**RQO fields used**:
- `options.key_dir`: string — the staging sub-directory to scan. Without it the answer is an empty array, never the whole staging root.

`data` is `[{ url, name, size }]`. A failed scan is logged and answered as an empty array rather than an error, so one bad `key_dir` cannot break the sibling renders on the page.

**Example response**:
```json
{ "ok": true, "request_id": "c0ffeb12", "data": [] }
```

---

> **Uploads**: file `upload` is not a JSON-dispatched action — multipart uploads are handled by the media ingest branch of the API path in `src/server.ts`. `join_chunked_files_uploaded` (a JSON RQO) reassembles a completed chunked upload.

---

## dd_area_maintenance_api

> Maintenance operations are widget methods, not top-level actions. Execution goes through `widget_request` / `get_widget_value`; the widget registry and its per-widget `API_ACTIONS` allowlists live in `src/core/area_maintenance/widgets/registry.ts`. Counter administration, for example, is a `modify_counter` method of the `counters_status` widget, invoked through `widget_request`.

### lock_components_actions()
**Purpose**: Area-level lock operations.
**RQO fields used**:
- `options`: object
  - `fn_action`: string (required) — one of `get_active_users`, `force_unlock_all_components` (admin-gated inside the dispatcher).

**Example request**:
```json
{
  "dd_api": "dd_area_maintenance_api",
  "action": "lock_components_actions",
  "options": { "fn_action": "get_active_users" }
}
```

---

## Standard RQO envelope

All API calls use a standard envelope (`rqoSchema`, `src/core/concepts/rqo.ts`):

```json
{
  "dd_api": "dd_core_api",
  "action": "read",
  "source": {},
  "sqo": {},
  "show": {},
  "options": {},
  "data": {}
}
```

### Envelope fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `dd_api` | string | No (defaults to `dd_core_api`) | Target API class |
| `action` | string | Yes | Registered action name |
| `source` | object | No* | Request target (record, section, component, mode) |
| `sqo` | object | No* | Search query object (filtering, pagination) |
| `show` / `search` / `choose` | object | No | ddo_map + per-block `sqo_config` |
| `options` | object | No | Action-specific options |
| `data` | object | No | Payload (for `save`) |
| `api_engine` | string | No | Resolution engine (defaults to `dedalo`) |

*Required fields depend on the specific action (see above). Authentication and CSRF gates are enforced by `dispatchRqo` before any handler runs — see [JSON API v1](dedalo_api_v1.md#security-gates).
