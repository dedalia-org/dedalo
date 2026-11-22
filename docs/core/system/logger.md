# Activity log

> See also: [Architecture overview](../architecture_overview.md) ·
> [Sections](../sections/index.md) ·
> [section_record](../sections/section_record.md) · [db](db.md)

The **user-activity audit trail**: one structured row per state-changing action,
appended to `matrix_activity`. It is what answers "who changed what, and when".

`src/core/api/handlers/activity_log.ts` is the whole subsystem — one function, one
sink. There is no logging facade, no severity scale and no pluggable-backend
registry: diagnostic output is plain `console` logging, and the audit trail is a
matrix write.

## Role

An activity record is an **ordinary matrix record**, not a parallel storage path.
`logActivity(entry)` builds the typed-column payload and inserts it into
`matrix_activity` (section tipo `dd542`), through the same
[db layer](db.md) as any other write.

## Responsibilities

- **Audit write** — append one row to `matrix_activity` for a state-changing API
  action, an authentication event, or a media/time-machine operation.
- **WHAT mapping** — map the action name to its `dd42` event code. An **unmapped**
  action is skipped, never guessed with a wrong code.
- **Self-log guard** — refuse to audit an action performed on the activity
  section itself (see [the self-log guard](#the-self-log-guard)).
- **History-free sections** — refuse to audit an action on a section that keeps
  no Time Machine history (see [the self-log guard](#the-self-log-guard)).
- **Never break the action** — the write is wrapped in `try`/`catch` and swallows
  its own errors to `console.error`. An audit write must never fail the user's
  save.

!!! warning "A silent skip is a real outcome"
    `logActivity` never throws **and** returns without writing for four
    reasons: an unmapped `what`, an empty tipo, a self-log, or a history-free
    section. If you add an emitter and no row appears, check those four before
    suspecting the database — nothing is logged when a write is skipped.

## The audit model

Each action is recorded as six typed columns:

| field | component tipo | matrix column | source |
| --- | --- | --- | --- |
| IP / host | `dd544` | `string` | the resolved client host (`::1` / `127.0.0.1` → `localhost`) |
| WHO | `dd543` | `relation` | a locator into the Users section (`dd128`) for the acting user |
| WHAT | `dd545` | `relation` | a locator into `dd42` — the event code |
| WHERE | `dd546` | `string` | the `tipo` being acted on |
| WHEN | `dd547` | `date` | the virtual-calendar instant |
| DATA | `dd551` | `misc` | the action payload (`[{lang:'lg-nolan', value: …}]`) |

### The event codes

The WHAT column stores a locator into `dd42`, whose `section_id` is the event
code. `WHAT_CODES` maps the full set:

| code | event | code | event |
| --- | --- | --- | --- |
| 1 | `LOG IN` | 9 | `UPLOAD` |
| 2 | `LOG OUT` | 10 | `DOWNLOAD` |
| 3 | `NEW` | 11 | `UPLOAD COMPLETE` |
| 4 | `DELETE` | 12 | `DELETE FILE` |
| 5 | `SAVE` | 13 | `RECOVER SECTION` |
| 6 | `LOAD EDIT` | 14 | `RECOVER COMPONENT` |
| 7 | `LOAD LIST` | 15 | `STATS` |
| 8 | `SEARCH` | 16 | `NEW VERSION` |

Four of them — `SEARCH` (8), `UPLOAD` (9), `DOWNLOAD` (10) and `STATS` (15) —
have **no emitter**: nothing in the engine writes a row with those codes. They
stay in the map because `matrix_activity` holds older records that carry them,
and the read side must still resolve a code it finds in the data. Treat them as
readable-but-not-written rather than as free code points; if you add an emitter
for one, it needs its own call site, not a new map entry.

!!! note "`LOAD EDIT` and `LOAD LIST` are distinct events"
    They are codes 6 and 7, not one `LOAD`. The action name passed to
    `logActivity` is matched verbatim against `WHAT_CODES` — an action name that
    is not an exact key is skipped silently.

!!! warning "The section_id comes from the sequence, not the counter"
    The insert **omits** `section_id` and lets the
    `matrix_activity_section_id_seq` Postgres sequence allocate it. The `dd542`
    matrix counter is deliberately *not* the allocator here — do not "fix" this by
    routing the insert through the counter.

## Where it fires

The audit is written from the API dispatch path, inline within the request. There
is no deferred queue and no shutdown flush.

| action | emitted from |
| --- | --- |
| `LOG IN` | `src/core/security/auth.ts` — `login()`, on **both** outcomes |
| `LOG OUT` | `src/core/api/handlers/dd_utils_api.ts` — the `quit` action, before the session is destroyed |
| `NEW` | `src/core/api/handlers/dd_core_api.ts` — the `create` action |
| `SAVE` | `src/core/api/handlers/dd_core_api.ts` — after a component save |
| `SAVE` (on the maintenance area, `dd88`) | `src/core/security/legacy_password_migration.ts` — one entry per run of the v6 password conversion, dry or executed, from the **Legacy passwords** panel and from `bun run dedalo:migrate-passwords`: `action: 'legacy_passwords.migrate'`, `via` (`panel` / `cli`), `execute` (`false` for a dry run), the converted user `section_id`s and the counts. The panel works through the accounts 25 at a time and each batch is its own entry. Never a credential value, a hash or the v6 key values. A run that converts more than 200 accounts is split over several entries (`part` / `parts`). Like every activity entry it is best-effort: a failed write is reported in the server log and the conversion stands |
| `DELETE` | `src/core/api/handlers/dd_core_api.ts` — after a record delete, per deleted record |
| `LOAD EDIT` / `LOAD LIST` | `src/core/api/handlers/dd_core_api.ts` — `logReadActivity`, on a section or area read |
| `UPLOAD COMPLETE` | `tools/tool_upload/server/index.ts` — after the uploaded file is processed and persisted |
| `NEW VERSION` | `tools/tool_media_versions/server/media_versions.ts` — `build_version` and `conform_headers` |
| `DELETE FILE` | `tools/tool_media_versions/server/media_versions.ts` (`delete_quality`, `delete_version`) and the posterframe deletes in `dd_component_av_api.ts` / `dd_component_3d_api.ts` |
| `RECOVER SECTION` / `RECOVER COMPONENT` | `tools/tool_time_machine/server/` — `apply_value`, and one row per reverted component in `bulk_revert.ts` |

Emitters live at the **door** — the API handler or tool action — not inside the
engine that does the work. A door knows both the acting user and the client
host; `createSectionRecord`, `deletePosterframe` and their peers know neither,
and several of them are reached from more than one door.

The password conversion is the one emitter that takes its actor as an argument:
its door has two callers — a maintenance panel and a command line — and a caller
cannot run it without naming who it is. The command line has no session, so its
entry names `root` from host `cli` and adds the operating-system account
(`os_user`).

Diffusion keeps a **separate** trail: `src/core/diffusion_bridge/diffusion_delete.ts`
logs unpublish outcomes to the diffusion activity log (`dd1758`). It is not part of
the core audit trail.

### The self-log guard

An audit row is itself a record, so logging an action performed **on the
activity section** would append a row describing the appending of a row.
`logActivity` refuses when the WHERE tipo is one of `dd542` (the Activity
section) or its own components `dd543`, `dd544`, `dd545`, `dd546`, `dd547`,
`dd550`, `dd551`. It also refuses an empty tipo, which would produce a row
naming nothing.

It also refuses an action on one of the sections that keep **no Time Machine
history** — `dd655` (the search preset being edited, rewritten on every filter
change), `dd15` (the Time Machine itself) and `dd1521` (the daily activity
statistics, rebuilt from this log). It is the same set the Time Machine skips
(`TM_EXCLUDED_SECTIONS` in `src/core/concepts/section.ts`), read from one
constant. The section is the payload's `data.section_tipo` when it names one,
else the WHERE tipo (`activitySectionOf`): a SAVE's WHERE is the component, so
every SAVE emitter passes the section it saved into in `data.section_tipo`.

The guard lives in `logActivity`, not at the call sites, so every emitter —
including any added later — inherits it.

## The surface

`src/core/api/handlers/activity_log.ts`:

| symbol | purpose |
| --- | --- |
| `logActivity(entry, now?)` | Append one `matrix_activity` row. Returns early — no write — when `entry.what` has no mapped `dd42` code, when the tipo is empty, when the tipo is the activity section's own, or when the action's section keeps no history. **Never throws.** |
| `activitySectionOf(entry)` | The action's section: `data.section_tipo` when set, else the WHERE tipo. What the history-free skip reads. |
| `ActivityEntry` | The input shape: `{ what, tipo, userId, host, data }`. |
| `hostFromClientIp(clientIp)` | Resolve the `dd544` host value: loopback becomes `localhost`, a missing address becomes `unknown`. Use it rather than re-deriving the rule. |
| `ANONYMOUS_USER_ID` | The WHO used when no one is authenticated (`-666`). |

`ActivityEntry` fields:

| field | purpose |
| --- | --- |
| `what` | The action name, mapped to a `dd42` code. |
| `tipo` | The WHERE tipo — the component tipo for a save, the section tipo for a delete or a create. |
| `userId` | The acting user (the WHO locator into `dd128`). |
| `host` | The resolved client host string — from `hostFromClientIp`. |
| `data` | The `dd551` payload: a message plus action-specific fields. |

### Auditing an unauthenticated action

Most actions run behind the auth gate, so the actor is `principal.userId`. A
**denied login** has no principal — and is exactly the event worth recording.
Those rows carry `ANONYMOUS_USER_ID` as the WHO and name the attempted account
in the payload instead:

```ts
await logActivity({
    what: 'LOG IN',
    tipo: LOGIN_ACTIVITY_TIPO,          // dd229, fixed for login events
    userId: ANONYMOUS_USER_ID,          // nobody is authenticated yet
    host: hostFromClientIp(clientIp),
    data: {
        msg: `Denied login attempted by: ${username}. ${cause}`,
        result: 'deny',
        cause,                          // 'wrong password', 'User does not exist', …
        username,
    },
});
```

A successful login writes the same shape with `result: 'allow'` and the real
`userId`. Both outcomes land in the same trail, so a burst of `deny` rows
against one account is visible in the Activity section without any extra
tooling.

## What the audit feeds

The activity rows are read back by two consumers:

- the **area dashboard** — `metricActivity` (`src/core/area/dashboard.ts`) queries
  `matrix_activity` directly with JSONB operators to build the per-day,
  per-section, per-user activity chart. See
  [area → the dashboard payload](../areas/area.md#the-dashboard-payload).
- **user statistics** — `src/core/area_maintenance/user_stats.ts` aggregates the
  rows into per-user, per-day totals for the maintenance area.

## Diagnostics

Diagnostic output is plain `console` logging. There is no severity scale, no
verbosity threshold and no per-user debug gate.

```ts
console.error('activity log write failed (swallowed):', error);
```

## Example

```ts
import { hostFromClientIp, logActivity } from './activity_log.ts';

await logActivity({
    what: 'SAVE',                 // → dd42 code 5
    tipo: source.tipo,            // the WHERE tipo
    userId: principal.userId,     // the WHO locator into dd128
    host: hostFromClientIp(context.clientIp),
    data: {
        msg: 'Saved component data',
        lang: source.lang ?? 'lg-nolan',
        tipo: source.tipo,
    },
});
```

## Related

- [Architecture overview](../architecture_overview.md) — where the work-system
  server sits relative to data and diffusion.
- [Sections](../sections/index.md) · [section_record](../sections/section_record.md)
  — the matrix storage the activity write uses.
- [db](db.md) — the `sql` handle the audit row runs through.
- [Locator](../locator.md) — the pointer type stored in the WHO and WHAT columns.
- [area](../areas/area.md) — the dashboard that charts the activity rows.
