# WC-2026-10-30-portal-get-data-external-refresh — the portal's "update external" button recomputes the mirror at read level 1

- **Date:** 2026-10-30 (owner ruling Q2 of the same day: read level 1, PHP parity).
- **Decision:** DEC-12 (gated: `test/unit/external_refresh_native.test.ts` (the door:
  preconditions, read-level gate, notices, no-drift zero writes, the bounded lock wait);
  the client case `COMPONENT_PORTAL UPDATE EXTERNAL` in
  `client/dedalo/test/client/js/test_component_portal.js`; `error_registry_native`,
  `labels_tripwire`, `client_idempotency_tripwire`).

### Shape before (PHP)

v6 honoured `source.build_options.get_dato_external` on a component read: the portal
recomputed its external data and saved it, gated by READ permission. Frozen v7 PHP read
`get_data_external` while its client still sent `get_dato_external`, so the button was
dead there.

### Shape before (TS, until 2026-10-30)

The read path ignored `build_options` entirely (`rqoSourceSchema` passthrough, undeclared).
The client sent `get_dato_external: true`, did not await the refresh, and never cleared
the flag, so it rode every later read of that instance. The button did nothing; it
rendered only for permissions ≥ 2.

### Shape after (TS)

**Wire.** The client sends `source.build_options = {get_data_external: true}` ONCE: it
awaits `refresh({build_autoload: true, render_level: 'content'})` and deletes
`build_options` in a `finally`. The button is DISABLED while that refresh is in flight
and re-enabled in the same `finally`, so a repeated click cannot queue a second
refresh behind the first. `rqoSourceSchema.build_options` is declared
(`get_data_external`, `terms_are_model`, passthrough). `get_dato_external` is NOT
honoured — counted `rqo_deprecated_get_dato_external` and ignored.

**Door** (`src/core/section/record/external_refresh.ts` `maybeRefreshExternal`, called
from `read_facade.ts` `routeSectionRead`'s component get_data branch after the record
gate and before `readComponentData`). Preconditions — any miss is a SILENT no-op (no
notice):

- `get_data_external === true`; `rqo.action === 'read'` on `dd_core_api` (so
  `dd_core_api:start`, CSRF-exempt, cannot reach it — structurally, and checked again);
- never a Time Machine read (`sqo.mode === 'tm'` or the TM read scope; counted
  `observers_external_refresh_skipped_tm`), never a temporal source;
- the requested element only: a component tipo (≠ the section), a `section_id`
  classified `record` by `classifyWireSectionId`, a node with `source.mode: external`.

Then, in order:

1. inside a transaction ⇒ withheld `error`;
2. a consultation-only section ⇒ refused (a conservative extra guard: Activity and TM
   sections carry no external portals);
3. `authorizeRecordAccess(principal, {section_tipo, component_tipo, section_id},
   {mode: 'read', level: 1, sectionFloor: 1, door: 'dd_core_api.read.refresh_external'})`
   — **read level 1, PHP parity**; a refusal ⇒ notice `observers.refresh_refused`;
4. the law refused ⇒ withheld `law_refused`; the section not a host ⇒ withheld
   `target_not_host`;
5. `refreshExternalMirror(tipo, section_tipo, section_id, requester, now)` — a fresh
   root cascade guard, `recomputeMirrorAndHop('on-write')`, awaited to COMMIT so the
   read that follows serves the new value; the outcome's `refusedBigResult` ⇒ withheld
   `frozen`, `skippedShrink` ⇒ withheld `degraded_seed` — UNLESS the recompute WROTE
   (`wrote: true`: a degraded seed still persists the additions it can prove; the
   refresh did its job, so no notice, `observers_external_refresh_done`); any caught
   error ⇒ withheld `error` (`observers_external_refresh_failed`).

**The lock wait is bounded on this door.** The recompute takes the target row
`FOR UPDATE` on the request pool. Before this door, `dd_core_api:read` never took a row
lock; a read-level user can now start one, and with the default
`DB_STATEMENT_TIMEOUT_MS=0` a wait behind a long transaction (an import, a bulk revert,
a wide cascade) had no limit and held a pool connection — enough of them and every
request answers `db.pool_exhausted`. So the refresh's OWN transaction carries a short
`lock_timeout` — `EXTERNAL_REFRESH_LOCK_TIMEOUT` = `3s`, a named constant, the first
statement of the locked write transaction (`recomputeExternalRelation`
`options.lockTimeout`, refused inside an ambient transaction) (the save path and every other request-pool lock keep the pool's
posture, `engineering/PRODUCTION.md` §4). When it fires (SQLSTATE `55P03`) nothing is
written and the read is served with withheld `busy` (`details.retryable: true`, the
only retryable reason; counter `observers_external_refresh_busy`) — the target row is
held by another write; retrying later succeeds. The bound covers the refresh's own
transaction only: when it wrote, the post-COMMIT cascade hop keeps the cascade's
lock posture, by owner ruling (2026-10-30): a timed-out hop would leave downstream
mirrors stale, and every save's cascade accepts the same wait. If a downstream chain ever
makes the wait matter, the fix is to stop the read awaiting the hop, not a timeout. The
client sends one refresh at a time (the button ignores clicks while
one is in flight).

**The read is always served.** Notices ride envelope v2: `observers.refresh_refused`
(permission/403, warn, no details) and `observers.refresh_withheld` (conflict/409, warn,
`details.reason` ∈ `law_refused | target_not_host | degraded_seed | frozen | busy |
error`).
Both are notice-only codes, never thrown. Counters: `observers_external_refresh_{done,
withheld,refused,failed,busy,skipped_tm}`.

**Why level 1 is safe.** An external mirror is derived, informative state, not an edit
component: the result is a pure function of committed data, independent of the
requester. A no-drift refresh writes nothing (no TM row, no stamp), so
`dd_core_api:read` stays `idempotent` in `ACTION_IDEMPOTENCY`. When it does write, the
requester is the TM actor and the stamp user (audit honesty).

**Client toolbar.** `get_buttons_by_permissions(self)`: full toolbar at permissions > 1;
at permissions 1 on an external portal outside the print view, a toolbar holding only
the update-external button; otherwise none. Every edit view that gated its toolbar on
`permissions > 1` (`view_default`, `view_line`, `view_mosaic`, `view_tree`) calls it;
`view_indexation` builds its toolbar unconditionally.

### Known open

- None for TM provenance. Owner ruling 2026-10-30: NO `external_refresh` origin tag. The
  mirror is a calculation; the real change was made in its source ("real") components,
  whose TM rows already record it. The requester is the TM actor, exactly as an observer
  cascade records the saving user.

### Gate reconciliation

No fixture re-harvest: the read's served bytes are unchanged for every request without
the flag, and a flagged read serves the same shape over fresh data plus optional
`notices`.
