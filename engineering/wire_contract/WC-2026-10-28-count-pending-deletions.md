# WC-2026-10-28-count-pending-deletions — the pending-deletions COUNT is its own read action

- **Date:** 2026-10-28 (feature crawl follow-up to WC-2026-10-28-tool-open-defects #10).
- **Decision:** DEC-12 (gate: `test/unit/diffusion_retry_queue_native.test.ts`
  "count_pending_deletions COUNTS and retries nothing, is a READ posture, and is admin-only";
  `client_idempotency_tripwire` ceiling row).
- **Shape before (TS):** tool_diffusion's badge asked `dd_diffusion_api retry_pending_deletions`
  with `options.count_only: true` (honoured since #10). One action, two behaviours: its posture
  had to stay `mutating`, so the read-only crawl audit (and anything classifying actions by their
  posture) blocked a pure count.
- **Shape after (TS):** new action `dd_diffusion_api count_pending_deletions` — global-admin only
  (`perm.denied` otherwise, as the retry), posture `structure_only`, idempotent; answers the same
  payload `{summary, total, retried: 0, remaining}`. `retry_pending_deletions` only retries and
  ignores `count_only`. The maintenance widget's own `widget_request` count path is unchanged.
- **Client:** `tool_diffusion.retry_pending_deletions({count_only: true})` sends the new action.
- **Gate reconciliation:** TS-only.
