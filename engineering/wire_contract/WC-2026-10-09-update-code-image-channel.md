# WC-2026-10-09-update-code-image-channel — `update_code` on a container installation: `consumer.image`, and two widget actions that record an update for the Docker host

- **Date:** 2026-10-09 (installer unification, items D3 + the engine side of D4).
- **Decision:** installer unification plan D3 (the code-update panel is
  image-channel aware instead of a dead-end refusal) and D4 (an opt-in HOST
  updater acts only on a request the panel recorded; the engine is never given
  docker access). TS-native: no PHP shape exists for any of it.

## Shape before (TS)

- **`update_code` `get_widget_value` → `consumer`:** `{ engine, checks, ready,
  last_update, restore_points, tree }` on every installation. On a container
  installation the only statement was the `channel` check
  (`{id:'channel', state:'blocked', detail:'image'}`) and `ready:false` — the
  panel headlined "Update blocked" with nothing to act on.
- **`update_code.apiActions`:** `update_code`, `restore_code`,
  `delete_restore_point`.

## Shape after (TS)

- **`consumer.image`** — present ONLY when `detectDeploymentChannel(projectRoot)
  === 'image'` (the `channel` check's own predicate); ABSENT otherwise, so the
  tree-swap wire is byte-unchanged. `checks` and `ready` are unchanged on both
  channels (the in-container swap really is refused). Built by
  `src/core/update/image_channel.ts`, never throws (each part degrades to null):

  ```
  image: {
    source: {
      mode: 'pull' | 'build' | null,          // DEDALO_CONTAINER_IMAGE_MODE (validated)
      repository: string | null,              // DEDALO_CONTAINER_IMAGE (validated, no tag)
      official: { id, label, role: 'primary'|'mirror' } | null   // engineering/image_registries.json
    },
    update_command: { program: 'deploy/dedalo-image-update.sh', version_flag: '--version' },
    host_updater: {
      state: 'absent' | 'stale' | 'alive',    // alive ⇔ now − seen_at ≤ max(3 × interval_seconds, 180 s)
      seen_at: ISO | null, interval_seconds: number | null,
      mode: 'pull'|'build'|null, image: string|null, pinned: string|null,
      verify: 'cosign'|'none'|null, running_digest: 'sha256:<64hex>'|null
    },
    request: {
      id: uuid-v4, tag: 'X.Y.Z' | 'X.Y.Z-dev', version: 'X.Y.Z', channel: 'master'|'dev',
      from_version: string, requested_at: ISO, requested_by: number,
      state: 'requested' | 'claimed', claimed_at: ISO | null
    } | null,
    last_outcome: {
      schema: 1, request_id: uuid|null, from: string, to: string, mode: 'pull'|'build'|null,
      image: string, status: 'green'|'rolled_back'|'rollback_failed'|'refused'|'failed',
      detail: 'healthy'|'health_timeout'|'unhealthy'|'pull_failed'|'verify_failed'|'build_failed'|
              'backup_failed'|'version_refused'|'downgrade_refused'|'same_version'|'not_running'|'env_incomplete'|
              'locked'|'interrupted'|'malformed_request',
      backup: string|null, digest: 'sha256:<64hex>'|null,
      started_at: ISO|null, finished_at: ISO|null, recorded_at: ISO
    } | null
  }
  ```

  Facts and machine ids only; the client composes the host command from
  `update_command` + the manifest item (`<program> --version <version>[-dev]`,
  only for a strict `X.Y.Z` version) and words everything from labels.
- **Two new `update_code` actions** (`widget_request`, ownership-gated like their
  neighbours — `update_ownership_tripwire`):
  - `request_image_update` — options `{ version: 'X.Y.Z', channel?: 'master'|'dev' }`.
    Gates in order: superuser (`perm.superuser_required`) and maintenance mode
    (`maintenance.mode_required`) — the code update's own preconditions; then
    refusals `maintenance.action_refused` with `coordinates.reason` ∈
    `not_image_channel | host_updater_not_alive | request_pending |
    malformed_version | dev_channel_not_enabled | version_refused`
    (`dev_channel_not_enabled`: a `channel: 'dev'` target while the host updater's
    heartbeat pins a RELEASE tag — a request never moves a release installation onto
    developer images; the host updater refuses the same request as `version_refused`;
    the last with `coordinates.walk` ∈
    `downgrade_or_same_version | version_skip`, the id of THE walk rule,
    `src/core/update/version_walk.ts`). Success writes
    `<private>/image_update/request.json` exclusively and answers
    `{ data: { request: <the request object above> } }`.
  - `cancel_image_update_request` — options `{}`. Superuser only (no
    maintenance-mode demand). Refusals `coordinates.reason` ∈
    `request_claimed | no_request`. Success answers `{ data: { cancelled: true } }`.
- **The host side** reads the same files through
  `scripts/ops/image_update_channel.ts` (`check-target`, `heartbeat`, `claim`,
  `orphan`, `outcome`, `status`) — a CLI contract, not a wire one, gated by
  `test/unit/image_update_channel_native.test.ts`.

## Reason

A container installation's code IS its image; only the Docker host can replace
it, and the engine must never hold docker.sock. The panel therefore has to say
where the image comes from and give the operator the exact host command — or,
when the operator installed the host updater, record a request the host claims.
Before this the panel's whole answer was a refusal.

## Gate reconciliation

- TS-native, no parity gate involved: `update_status_native` (the block appears
  iff the channel is image; host-updater thresholds; request/inflight/outcome;
  malformed files never throw), `update_code_widget_native` (every refusal id in
  gate order, one write, the walk verdict equals `assertLinearUpgrade`, cancel),
  `image_update_channel_native` (every CLI verb executed, file modes),
  `client_update_code_render` + the browser suite `test_update_code.js` "image
  channel" (the block, the command, the request button only when alive),
  `update_ownership_tripwire` (EXPECTED_GATED) and
  `maintenance_door_unbounded_native` (REQUEST_BOUNDED) enumerate both actions.
- **Fixture interaction (DEC-14b):** NO re-harvest; the frozen PHP fixtures never
  contained `consumer` (a TS-native panel) nor these actions.

## Addendum 2026-10-30 (update audit 2026-10-29: U-35, U-43, U-20)

- `last_outcome.detail` gains `same_version` (already in the shape above): a request for the
  version the stack is pinned at is refused with it, not `downgrade_refused`.
- **Claim is rename-first** (`image_update_channel.ts claimRequest`): the updater renames the
  request file to its claimed name BEFORE it reads or rewrites it, so a cancel racing a claim either
  removes the request (no claim) or finds nothing (the claim won). `request.state` keeps its values.
- **Interrupted update** (`deploy/dedalo-image-update.sh`): before the re-pin the script writes
  `.dedalo-image-update.pin` (`from`, `to`, the rollback tag, request id, checkout to restore) and
  traps TERM/INT/HUP → one rollback with `status: rolled_back|rollback_failed`, `detail:
  interrupted`. A marker left by a KILL refuses every run (`refused`/`interrupted`) until
  `--recover` reconciles it (rollback when the pin still names the marker's source or target;
  refused, marker kept, when it was changed by hand). The host updater runs `--recover` first on
  each pass (`reconcile_pin`). Gates: `image_update_script_native`, `image_update_claim_native`.
