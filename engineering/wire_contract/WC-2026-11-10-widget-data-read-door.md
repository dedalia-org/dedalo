# WC-2026-11-10-widget-data-read-door — get_widget_data asks the section, the info component and the record scope

- **Date:** 2026-11-10 (T0-3 S12 residue, owner decision of 2026-11-10: CLOSE). The gate site is
  `get_widget_data` (`src/core/api/handlers/dd_component_info.ts`), through the write door's READ
  mode (`authorizeRecordAccess`, `src/core/security/write_door.ts`) — the composition the AV reads
  use (`media_action_context.ts`).
- **Decision:** DEC-12. Stricter than PHP, which had NO gate on this action at all.

## Shape before (PHP, and TS until this entry)

```
{action:'get_widget_data', dd_api:'dd_component_info',
 source:{tipo:INFO, section_tipo:S, section_id:N, mode}, options:{widget_name}}
```

- **PHP** (`dd_component_info::get_widget_data`): no permission check. Any logged-in user computed
  any widget of any `component_info` over any record it named.
- **TS until this entry**: the record scope only (`principalCanAccessRecord`), refused as
  `perm.denied`. No section grant, no grant on the info component. The id was `Number(section_id)`:
  a non-address (`'abc'`) was folded into the scope refusal for a non-admin and **computed** for the
  superuser (the widget ran over `section_id 'abc'`).

## Shape after (TS)

In order, before any compute:

1. `source.section_id` must be a record address (`coerceSectionId`, int4) — else
   **`request.invalid_source` 400**, by name, for every caller (the superuser included). A
   strict-numeric string is still accepted (counted coercion,
   WC-2026-08-10-section-id-int-canonical). An empty `source.tipo` / `source.section_tipo` →
   `request.invalid_source` too (an absent component would make the door authorize the section
   itself).
2. The section grant ≥ 1 → else **`perm.denied` 403**. Restores the floor every human read asks.
3. The info component's own pair grant (`authorizeComponentRead`) → else **`perm.denied` 403**.
4. The record scope → else **`perm.out_of_scope` 403** (was `perm.denied`: the scope refusal now
   carries its own code, as on every other read door through the write door).

The widget's `ipo` inputs pass **"as displayed"** (owner decision): a widget is a derived value of
the info component, so the info component's grant is the whole question — no per-input grant. The
compute receives the GRANT's coordinates (int `section_id`), never the raw rqo value.

Success body unchanged: `{ok:true, request_id, data:[…widget items…]}`.

## Reason

A widget is computed OVER a record from its components; a user the human read refuses (no section,
or no grant on the info component) must not read the same value through the async widget channel.
The client's only caller (`widget_common.js` build, autoload) renders a widget the section read
already served it, so a granted user sees no change.

## Gate reconciliation

- `test/unit/widget_data_read_door_native.test.ts` — the paired gate (reader refused / control
  served, exact body): no section grant, info component 0, out of scope (control refused, superuser
  served), non-address id. Red on the record-only gate for all four.
- `test/unit/component_info_widget_data_native.test.ts` — its compute-branch cases now run as the
  superuser (a fabricated userId-1 global admin has no profile); non-positive ids pin
  `perm.out_of_scope`; the "no node" case uses a well-formed tipo (a malformed one is the door
  grammar's `request.invalid`, pinned); the WidgetContext `sectionId` is the int.
- `test/parity/get_widget_data_differential.test.ts` — permanently skipped (live-oracle only); no
  fixture is touched and no re-harvest is needed.
