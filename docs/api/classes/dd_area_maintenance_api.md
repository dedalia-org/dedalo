# dd_area_maintenance_api

> See also: [JSON API v1](../dedalo_api_v1.md) · [dd_utils_api](dd_utils_api.md) · [dispatch](dispatch.md)

The maintenance area's server surface: run a maintenance widget's method, load a panel's value, administer component locks, and read an ontology schema-change file.

Registered actions (`src/core/api/handlers/dd_area_maintenance_api.ts`): `widget_request`, `get_widget_value`, `lock_components_actions`, `parse_simple_schema_changes_files`. Widget dispatch and the widget catalog live in `src/core/area_maintenance/widgets/registry.ts`; the widget modules sit alongside it.

## How to call

- POST JSON to `/api/v1/json` (or the client-relative `/dedalo/core/api/v1/json`) with `dd_api: "dd_area_maintenance_api"` and `action: "<method>"`.

## Notes

- **All four actions are global-admin only.** The maintenance area is an admin surface and the gate runs before anything else; a non-admin gets `perm.denied` (HTTP 403).
- The dashboard is a **widget** framework: each panel is one widget, run through `widget_request` (execute) or `get_widget_value` (load). There is no generic class dispatcher — a maintenance operation is always a method of a named widget, and only the methods that widget's module registers are reachable.
- Envelope: **v2**. A widget answers with its **payload**; the handler is the one site that turns it into a body, so success is `{ ok: true, request_id, data, … }` where `data` is the widget's value. The names the maintenance panels read by their own name — `msg`, `errors`, and each widget's own extras — ride at the top level as **extension keys**, and an absent `msg` or an empty `errors` emits no key at all. A refusal is `{ ok: false, request_id, error: { code, category, message, label_key, retryable } }`. There is no `result` key; the v1 `{ result, msg, errors }` shape was removed on 2026-08-16.

### Errors (all actions)

| code | status | when |
| --- | --- | --- |
| `perm.denied` | 403 | the caller is not a global admin. |
| `request.invalid_options` | 400 | `options` is present and is not an object (`widget_request`); `filename` is not a bare `simple_schema_changes_<YYYY-MM-DD_HH-MM-SS>.json` name (`parse_simple_schema_changes_files`). |
| `maintenance.widget_unknown` | 400 | `source.model` names no widget in the catalog (or is not a valid identifier). |
| `maintenance.widget_unavailable` | 503 | the widget exists but deliberately answers no panel-load (`get_widget_value`). |
| `tool.method_not_allowed` | 400 | the method is not registered by that widget's module. Resolution is an own-property lookup with a function guard, so an inherited `Object` member can never reflect as a handler. |
| `maintenance.invalid_fn_action` | 400 | `lock_components_actions` with an `fn_action` outside the two supported values. |

## widget_request

### Purpose

Execute a maintenance widget's method.

### Accepts

- `source`: object (required)
    - `model`: string (required) — the widget id (e.g. `database_info`, `counters_status`, `dataframe_control`).
    - `action`: string (required) — the method the widget's module registers.
- `options`: object (optional) — the method's arguments.

### Returns

`data` is the widget method's payload. Counter administration rides this same channel — it is the `modify_counter` method of the `counters_status` widget (`source.model: "counters_status"`, `source.action: "modify_counter"`), not an action of its own.

### Example request

```json
{
  "dd_api": "dd_area_maintenance_api",
  "action": "widget_request",
  "source": { "model": "dataframe_control", "action": "run_check" },
  "options": {}
}
```

### Example response

```json
{
  "ok": true,
  "request_id": "c0ffee80",
  "data": { "checked": 24, "orphans": [] }
}
```

## get_widget_value

### Purpose

Load a panel's value — always the widget's own `getValue`.

### Accepts

- `source`: object (required)
    - `model`: string (required) — the widget id.

### Returns

`data` is the panel value.

!!! warning
    A widget may deliberately register **no** panel load. `dataframe_control` is the case in point: its scan walks every matrix table end to end, so on a large install a single panel open would be minutes of database work. It is reachable only through `widget_request` (`run_check` / `run_fix`), and `get_widget_value` on it answers `maintenance.widget_unavailable`.

### Example request

```json
{
  "dd_api": "dd_area_maintenance_api",
  "action": "get_widget_value",
  "source": { "model": "database_info" }
}
```

## lock_components_actions

### Purpose

Area-level administration of component locks: list the users currently holding one, or force-release locks.

### Accepts

- `options`: object (required)
    - `fn_action`: string (required) — `get_active_users` or `force_unlock_all_components`.
    - `user_id`: int (optional, `force_unlock_all_components` only) — release one user's locks. Absent or empty releases **all** users' locks.

### Returns

- `get_active_users` — `data` is the read's own boolean status; the live lock map rides as the top-level `ar_user_actions` extension key, which is where the panel reads it. Each entry carries `user_id`, `full_username`, `component_tipo`, `component_model`, `component_label`, `section_tipo`, `section_label`, `section_id` (an int) and `date`.
- `force_unlock_all_components` — `data` is `true`, `msg` narrates the outcome, and `freed` (an extension key) counts the released locks.

Per-component focus/blur soft-locks are **not** here: they are `dd_utils_api::update_lock_components_state` / `get_lock_status`.

### Example request

```json
{
  "dd_api": "dd_area_maintenance_api",
  "action": "lock_components_actions",
  "options": { "fn_action": "get_active_users" }
}
```

### Example response

```json
{
  "ok": true,
  "request_id": "c0ffee81",
  "data": true,
  "ar_user_actions": [
    {
      "user_id": 1,
      "full_username": "Root",
      "component_tipo": "oh16",
      "component_model": "component_input_text",
      "component_label": "Title",
      "section_tipo": "oh1",
      "section_label": "Oral History",
      "section_id": 368,
      "date": "2026-08-24 10:30:00"
    }
  ]
}
```

!!! note
    The lock key store keeps `section_id` as text — a named exemption of the int-canonical rule, because the key is a composite shared with the previous engine's own event store. It is canonicalized to an int on the way out, so what reaches the wire is always a record address.

## parse_simple_schema_changes_files

### Purpose

Read one ontology schema-change file for the **Latest changes** selector of `component_security_access` (the profile permissions tree). Every ontology update writes one additions-only diff to `<private>/backups/ontology/changes/`; the component's edit read lists those filenames, newest first, in `changes_files`.

### Request

```json
{
  "dd_api": "dd_area_maintenance_api",
  "action": "parse_simple_schema_changes_files",
  "options": { "filename": "simple_schema_changes_2026-11-10_09-20-42.json" }
}
```

### Response

`data` is one entry per section that gained children: `{ section: {tipo, label}, parents: [{tipo, label}], children: [{tipo, label}] }`. `parents` runs from the farthest ancestor to the nearest, with the root `dd0` left out; labels are in the application language. A missing, empty or unreadable file answers `[]`.

