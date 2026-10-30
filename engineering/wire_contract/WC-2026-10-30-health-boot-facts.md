# WC-2026-10-30-health-boot-facts — /health reports the boot migration verdict and the data version

- **Date:** 2026-10-30 (update audit 2026-10-29, findings U-01 / U-04; owner decision D-2).
- **Decision:** DEC-12 (gated: `test/unit/boot_schema_verdict_native.test.ts`,
  `test/unit/health_boot_facts_native.test.ts`, the watchdog drill in
  `test/unit/install_restart_supervisor_tripwire.test.ts`, `test/unit/client_update_code_render.test.ts`).
- **Shape before (TS):** `{result, entity, version, release_kind?, db, install_digest, request_id,
  test_database?}`; 200 when the database answered, else 503. A failed boot migration run was one
  journal line: `/health` stayed green and the code-update sentinel was confirmed, disarming every
  rollback. Nothing compared the installed data version with the code's.
- **Shape after (TS):** three optional keys —
  - `boot_schema`: `ok` | `failed` | `skipped` (smoke boot / no run);
  - `boot_schema_moved`: present only when `boot_schema` is `failed` — `false` (nothing applied: the
    update stays `pending` and the watchdog rolls the code back), `true` or `null` (applied, or
    unknown and read as moved: the sentinel is `needs_restore`, a human restores a backup);
  - `data_version`: `{state: ok|pending|ahead|unknown}` on the wire. The builder computes
    `{state, installed, code}`; since the 2026-10-30 review (#17) the anonymous route serves the
    state only (`health_payload.ts anonymousHealthView`): the version pair is the operator's
    (`bun run update status`), not an unauthenticated caller's.
  `result` is `error` and the status **503 with `db: "ok"`** when `boot_schema` is `failed` or
  `data_version.state` is `ahead`. `pending` (an "Update data" is due) is reported, not red.
- **Status-only consumers, and what each does now:**
  - `client/dedalo/core/common/js/api_transport.js` `check_health` (slow vs dead probe): a 503 whose
    body says `db: "ok"` is ALIVE — a long request keeps its grace.
  - `deploy/dedalo-ts-watchdog.sh`: reads the body (`curl --fail-with-body`, curl >= 7.76). A pending
    sentinel still rolls back first; a red on a boot fact with no pending update logs "NEEDS A HUMAN"
    and neither restarts nor rolls back (no restart loop over a database a restart cannot fix).
  - The update panel (`update_code_phases.js resolve_health_outcome`): `boot_schema: failed` is
    never "updated"; `boot_schema_moved` false keeps watching for the rollback, true/null reports the
    restore at once.
  - Container healthchecks turn unhealthy — the intended readiness signal.
- **Reason:** a tree whose schema did not land must not be confirmed, and an operator must see it.
- **Gate reconciliation:** TS-only; no parity fixture records `/health`. No re-harvest.
