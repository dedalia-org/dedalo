# WC-2026-11-19-data-version-unreachable — a database of an earlier major is `unreachable`: /health red, the Update-data panel says so, the code update refuses with that reason

- **Date:** 2026-11-19 (T2 batch B1, item D08-b; ledgered the same day by the
  batch's review, which found the change shipped without its entry).
- **Decision:** — (DEC-12 gates: `test/unit/data_version_unreachable_native.test.ts`,
  `test/unit/client_update_code_render.test.ts`, the client suite
  `test_update_data_version.js`).

## Shape before (TS, until 2026-11-19)

The data-version state (`src/core/update/boot_state.ts` `DataVersionStateName`)
was `ok | pending | ahead | unknown`. A database whose installed data version is
BELOW the code's was `pending`, whatever its major — including a Dédalo v6
database (6.x), which no rung of the v7 update catalog starts from:

- `GET /health` → **200**, `data_version: { state: 'pending' }`;
- `update_data_version` `get_value` →
  `{ update_version: null, current_version_in_db, dedalo_version, updates: null }`,
  which the client rendered as "Data format is updated: 6.9.1";
- a code update → `update.refused`, `rule: 'data_version_pending'`, public
  sentence "… run "Update data" first, then update the code" (an action that
  cannot work).

The frozen PHP engine has no `/health` and no such classification: this is a
TS-era contract, changed deliberately.

## Shape after

A new closed value, **`unreachable`**: the installed MAJOR is below the major of
the lowest from-version any rung of the update catalog starts at (derived from
the catalog, `catalog.ts lowestReachableFrom` — a future rung starting at 6.9.x
would make such a database `pending` again by itself).

- **`GET /health`** → **503**, `result: 'error'`,
  `data_version: { state: 'unreachable' }` (the anonymous view still carries the
  state only, never the version pair). Red on purpose: the engine cannot serve
  that database, and a supervisor must not read it as healthy.
- **`update_data_version` `get_value`** gains an OPTIONAL string key **`notice`**
  (`"Not updated: <advice>"`), present only in this state; the other four keys
  keep their values (`update_version: null`, `updates: null`). Absent in every
  other state — those answers keep their bytes. The client renders `notice` as
  an error text under a danger label INSTEAD of "Data format is updated".
- **A code update** → `update.refused` with `rule: 'data_version_unreachable'`
  and the public sentence `Error. Code update refused: the database is on data
  version <v>, a Dédalo v<M> database: this engine (<code>) has no update that
  starts from it — run the v<M> → v<N> migration on the v<M> installation first
  (docs/install/migrating_from_v6.md)`.
- **The client's post-update poller** (`update_code_phases.js read_health_body`)
  reads a 503 `unreachable` as a VERDICT, as it does `ahead`: the server came
  back (`version` is the body's, `data_unreachable: true`), and the panel ends
  the run with the `update_code_data_unreachable` note. Before, the 503 was
  "still restarting" and the poll could only end at its deadline with "The
  server did not come back", which is false. (The code-update door refuses an
  unreachable database before any swap, so the case is reached by a database
  swapped under a running update, not by the ordinary path.)

## Reason

The v6 → v7 move is done ON the v6 installation, before v7 ever starts; nothing
this engine offers can update a 6.x database. Reporting it as `pending` sent the
operator to "Update data" (no rung matches: the panel then said "updated"), and
kept `/health` green on an installation that cannot work.

## Gate reconciliation

No parity gate carries `/health` or the maintenance widgets' values (TS-native
surfaces; the frozen store has neither). Native: `data_version_unreachable_native`
(the classification on the shipped and on injected catalogs, the boot line, the
`/health` route → 503 + state, the door's rule and sentence, the panel value's
`notice`); `client_update_code_render` (`read_health_body`: a 503 `unreachable`
is back, with the flag; a 200 never carries it; the poller hands it to the
ending); the client suite `test_update_data_version.js` (the panel renders the
notice and never "Data format is updated"; control without `notice`). Three
gates that staged a 6.x database as `pending` were edited deliberately in the
batch (same-major pending through the code seam). No re-harvest.

## Addendum 2026-11-20 — the panel's sentence is a label

Owner rulings 2026-11-19 (T2 B1 follow-ups, D08-b).

- **`update_data_version` `get_value`** gains, beside `notice` and under the
  same condition (the `unreachable` state only), the OPTIONAL object
  **`notice_data`**: `{ code: 'data_version_unreachable', installed, engine,
  installed_major, engine_major, doc }` — every value a string; the facts the
  sentence is made of (`boot_state.ts dataVersionAdviceFacts`; `notice` is built
  from them, so the two cannot disagree). The client words the notice from its
  label catalog (`update_data_notice_unreachable`, the facts in the label's
  `${placeholders}`) in the reader's language; `notice` stays the engine's own
  English sentence and is what a client without that label shows. Chosen over a
  server-side translation: the maintenance widgets word their own states from
  `get_label` (the `update_code_*` family), and the boot line and the door's
  refusal — the other two users of that sentence — are not per-request-language
  surfaces.
- **Gates:** `data_version_unreachable_native` (`notice_data` exact, its facts in
  the sentence, the label's placeholders ⊆ its keys); the client suite
  `test_update_data_version.js` (a swapped catalog entry is what prints; the
  server sentence only when the dictionary lacks the key). No re-harvest.

## Addendum 2026-11-20 (2) — the code-update panel says it before the click

Owner ruling 2026-11-19 (T2 B1 follow-ups, D08-b): the UPDATE-CODE panel shows
the `unreachable` state too, not only at the end of a run.

- **`update_code` `get_value`** — `consumer.checks[]` gains one line,
  **`{ id: 'data_version', state: 'ok' | 'blocked', detail: '<state>/<installed>/<code>' }`**
  (`<state>` ∈ `ok | pending | ahead | unreachable | unknown`; `<installed>` is
  empty when it could not be read), placed after the operator lines. It is the
  door's own reading (`preconditions.ts installedDataVersionVerdict`, shared with
  `requireDataVersionCurrent`), so every state the door refuses for is `blocked`
  here and `consumer.ready` is false with it. Before, the panel showed "Ready to
  update" over a database the door refused, and the reason arrived only as the
  refusal.
- **Client:** the line is worded from `update_code_data_version_<state>` (the
  versions in its placeholders), `update_code_note_data_version_<state>` and
  `update_code_fix_data_version_<state>` — for `unreachable`: the code update is
  refused because of that database, and the migration runs on the earlier
  major's installation (the manual page is named). The version modal's gate
  says the same instead of "blocked", and keeps Update disabled.
- **Gates:** `update_status_native` (the line per state, equal to the door's
  rule for the same reading; every state has its words); the client suite
  `test_update_code.js` (the panel line per state, the control, the modal's
  gate). No re-harvest.
