# WC-2026-10-03-publication-hosts-widget — the `publication_hosts` maintenance widget is TS-ONLY (no PHP twin)

- **Date:** 2026-10-03, with phase 3 of `engineering/PUBLICATION_HOST_SPEC.md` (§8): the
  engine side of the publication host (registry, the paired agent channel, the panel).
- **Decision:** DEC-12 (the invariants are gated: root-only actions, the non-root reduced
  row and the secret-free payload by `test/unit/publication_host_widget_native.test.ts`, the
  ownership classification by `update_ownership_tripwire`, the per-action pool by
  `maintenance_door_unbounded_native`). Catalog divergence in the WC-018 / WC-035 /
  WC-2026-09-03-maintenance-reconcile-status-widget TS-only pattern.
- **Shape before (PHP):** nothing. The frozen PHP engine had no publication-host
  registry and no agent channel, so its `get_ar_widgets` catalog can never contain
  this id.
- **Shape after (TS):** the maintenance catalog gains one block,
  `id: 'publication_hosts'`, category `publication`, label key `publication_hosts`,
  served right after `site_builder_status` on every install (no eager `value`; the
  panel loads through `get_widget_value`).
  - **panel** (`get_widget_value`, global-admin readable):
    `{ registry: { state: 'ok' | 'registry_invalid', reason, check },
    registry_path, engine_qualities, is_root, hosts }`. `registry.check` is `null` when
    the state is `'ok'`, else Task 6's `registryInvalidCheck(reason)` —
    `{ id: 'registry', state: 'blocked', detail: reason }`, a row the panel renders
    with the host check renderer (amended 2026-10-04, Task 7 review; the client
    renders it through `check_row(…, 'publication_hosts')` inside the loud note since
    2026-10-05). The panel read takes no registry lock, so `registry_locked` is not a
    panel state (dropped 2026-10-05, review finding): were a read ever to meet a held
    lock, get_value fails with `publication_host.busy`, never a "repair" instruction. `hosts` is one row per
    registered host, built by `src/core/publication_host/host_status.ts`
    (`buildHostPanelRow`, served unchanged): `{ name, address_label, public_url,
    checks: [{id, state, detail?}], rules: { expected, reported },
    apis: { v1, v2: { current, previous } }, token_present, bundle_present,
    pairing_proved }`. Root's rows add the edit-form fields `qualities` and
    `probe: { published, unpublished }`. A caller who is not root gets rows WITHOUT
    `address_label`, `qualities` and `probe`, and `registry_path: null` (no
    infrastructure topology below root). `hosts` is `null` (never `[]`) exactly when
    the registry cannot be read (`registry.state` not `'ok'`). No token, key or PEM text
    is ever in the payload; a failed agent call contributes its registered error code,
    never its message. Secrets are read with `secretPresenceOutcome`: a secret refused
    on disk (`bad_mode`/`bad_owner`/`bad_token`/`bad_bundle`) reaches
    `buildHostPanelRow` as `refused` and blocks that host's `secrets` check with the
    reason; a host with a refused or missing required secret (token; plus the engine
    bundle for a TLS host) is not dialled. The other hosts render.
  - **Decided:** a non-root read still asks each paired agent for its read-only
    `status` (pairing proved first; no actor; no mutation), because the checks are the
    panel's content. Every agent-changing or agent-probing action stays root-only.
  - **actions** (`widget_request`, ROOT-ONLY — a global admin who is not root gets
    `perm.denied` before anything is loaded or dialled):
    `apply_rules({name})` → `{ host, server, hash, dropped }`;
    `probe({name})` → `{ host, probe }` (the agent's `media.probe` BOUNDED, E7 —
    amended 2026-10-05: exactly the seven known fields; `root` only as a printable
    absolute path ≤ 300 chars, else `'malformed'`; `problems` at most 16 lines of
    ≤ 300 chars with control/format characters removed, then one `… N more` line; the
    `msg` counts every problem the agent reported; the client renders it as text);
    `rollback_api({name, api: 'v1'|'v2'})` → `{ host, api, from, to }` (`from`/`to` are
    the agent's release ids only when they match `AGENT_RELEASE_ID`, else the literal
    `'malformed'`: agent prose is log-only, E7);
    `set_host_fields({name, public_url?, qualities?, probe?})` → `{ host, fields }`;
    `remove_host({name})` → `{ host, removed: true }` (under ONE registry lock hold:
    the entry is re-checked to be the pairing read before — same `fingerprint` and
    `paired_at`, else `maintenance.action_refused` "re-paired, retry" — then secrets,
    then the registry entry; then the in-process pairing proof). Every answer carries an
    operator `msg`. `set_host_fields` judges `qualities` / `probe` with the registry's
    own field checks (`validateQualities` / `validateProbePath`), so a value the registry
    would refuse is `maintenance.action_refused`, never `registry_invalid`. A hash the
    agent reports that is not 64-hex is named only as "a malformed rule hash".
    Failures: agent failures surface as the `publication_host.*` codes; a registry that
    cannot be read or written as `publication_host.registry_invalid`, or
    `publication_host.busy` when its lock is held (`wire.ts` `registryError`); input
    faults and unknown hosts as `maintenance.action_refused`; a hash the agent reports
    other than the one sent, or a secret dir that cannot be deleted, as
    `maintenance.action_failed`.
  All five are classified `ENGINE_NATIVE`.
- **Reason:** a publication host is a native TS subsystem (the agent under
  `publication/host_agent/`, the registry under `<private>/`); the panel is its only
  interactive door on the work host. Hosts are added by the root pairing CLI
  (`scripts/publication_host_pair.ts`), never typed into the panel, so the panel takes
  no address and no credential.
- **Gate reconciliation:**
  - `test/parity/widgets_differential.test.ts` — `publication_hosts` joins
    `TS_ONLY_WIDGET_IDS`, filtered out of the catalog byte-compare against the frozen
    PHP oracle. No re-harvest needed and none is possible.
  - `test/parity/dedalo_files_differential.test.ts` — the widget's CLIENT tree
    (`/dedalo/core/area_maintenance/widgets/publication_hosts/`) joins `isTsOnlyEntry`
    in the commit that adds that tree. The area's new cross-widget event LEAF
    (`/dedalo/core/area_maintenance/js/maintenance_events.js`, `OPEN_WIDGET_EVENT`:
    media_control's one line opening this panel) lives outside that prefix and joins
    `POST_HARVEST_CLIENT_ADDITIONS` in the same commit.
  - TS ground truth: `test/unit/publication_host_widget_native.test.ts`.
- **Fixture interaction (DEC-14b):** NO re-harvest; the frozen PHP fixtures never
  contained this id.

## Addendum 2026-10-05 — the shipped story, read against the code (docs review)

- **Who adds a host.** "the root pairing CLI" above is superseded: the pairing CLI
  (`scripts/publication_host_pair.ts`) is run as the engine user, the owner of
  `<private>` (`sudo -u <engine user> bun run dedalo:pair-publication-host …`), never root.
  It refuses any other uid, root included, because root-owned 0600 secrets would be
  unreadable by the engine. The panel's own unknown-host refusal and the
  `publication_hosts_none` label say the same.
- **`registry.check` is rendered.** The client draws the server's `registry.check` row with
  `check_row(…, 'publication_hosts')` inside the loud registry note; with no row it shows
  `registry.reason` as text. The wire shape above is unchanged.
- **`busy` on the panel read.** The server never sends a `registry_locked` state. A held
  registry lock fails `get_value` with `publication_host.busy` (`wire.ts` `registryError`,
  logged `registry_reason: locked`); the client keeps that failure on `read_error` and
  shows the `publication_hosts_registry_busy` note with a Reload retry, never the
  "invalid, repair" sentence. It still reads a `registry_locked` state as busy, defensively
  only. `busy` therefore has two causes: the agent (a 409, another change running on that
  host) and the work host's own registry lock (the pairing CLI or another panel write).
- **Gate:** `test/unit/publication_host_door_tripwire.test.ts` (*the operator is told how
  pairing and the panel really work*) holds this addendum, the operator page and the spec
  to the code. No fixture interaction.

## Addendum 2026-10-05 — phase 4 (Publication API lockstep)

- `get_value` `data` gains `runtime_invalid: string|null`: the runtime results file
  (`<private>/publication_hosts_runtime.json`) is read ONCE per call; a corrupt/locked file
  degrades to its reason (the panel still renders, results empty) instead of failing the call.
  Present on the `registry_invalid` branch too.
- `get_value` `data` gains `api_lockstep: {engine_release: string|null, refused: string|null,
  checked_at: string|null, rows: {host, api: 'v2'|'v1', engine, host_current,
  last_push: {state, release, error, at}|null, state: 'ok'|'mismatch'|'failed'|'unknown'}[]}`
  — the verdict of the last Publication API round in this server process (push, confirm
  hook, or the hourly dry check) with its time; `checked_at: null` = not verified since boot
  (no release, no refusal). get_value never hashes the tree. v2 row first per host; `error`
  is a CODE (`bundle_refused:<reason>`, `bundle_write:<reason>`, `runtime_invalid`, a
  `publication_host.*` code, `internal.*`), never agent prose; no secret field. `rows` is
  `[]` when the registry is invalid.
- New ROOT-ONLY action `push_apis` (`options.hosts?: string[]`, each `HOST_NAME`): answers
  `data: true` only when nothing was refused and nothing failed; `msg` is the operator
  sentence naming the refusal or each failed host×API with its code and named paths (and
  notes an unrecorded runtime); `report` is the `ApiReconcileReport` (actions may carry
  `detail`, the report may carry `runtime_error`). The agent audits it as actor
  `dedalo_user:<id>` (the other actions' actor). Non-root → `perm.denied` (before anything
  loads), malformed hosts → `maintenance.action_refused` (the widget's own refusal family,
  like a bad `name`), an unregistered host → `resource.not_found`, a concurrent push →
  `resource.conflict`.
- TS ground truth: `test/unit/publication_host_push_apis_widget.test.ts`,
  `test/unit/publication_host_api_reconcile.test.ts`; client:
  `client/dedalo/test/client/js/test_publication_api_lockstep.js`. No fixture interaction.

## Addendum 2026-10-05 — push_apis answers within a bounded wait; a refusal no longer disables the push (phase-4 review)

- `push_apis` waits for its round at most `pushAnswerWithinMs` = min(60 s, half
  `SERVER_IDLE_TIMEOUT_S`): Bun cuts a silent connection at the idle timeout (at most
  255 s), and a first push of a release can run far longer (v2 deps build, agent installs).
  A round that settles in time answers exactly as before, plus `running: false`. A round
  still going answers `data: null`, `running: true`, `report: null` and a `msg` saying it is
  still running; it finishes detached (outcome logged, every host×API recorded in the
  runtime file each row's `last_push` reads; the single-flight latch still refuses a second
  push with `resource.conflict` until it ends). A refusal or throw INSIDE the wait answers
  as itself. The client deadline is the widget's common 120 s (no per-action override).
- Client: the push button is disabled only when there are no host rows. `api_lockstep.refused`
  is the LAST round's verdict (it refreshes only on the next round), so it is shown with its
  `checked_at` next to an ENABLED button — the push re-verifies the tree before sending.
- TS ground truth: `test/unit/publication_host_push_apis_widget.test.ts`; client:
  `client/dedalo/test/client/js/test_publication_api_lockstep.js`. No fixture interaction.

## Amendment 2026-10-05 — phase 5 (media copy)

- `get_value` host rows gain one check `media_copy` (`HostCheck`, appended AFTER the fixed
  `HOST_CHECK_IDS` list from the same runtime read; `host_status.ts DECORATOR_CHECK_IDS`).
  `detail` is a fact, never a sentence: `ok` `<present>/<desired>` (in sync); `warn` the
  round's code, else `puts:<n> deletions:<n>` (puts or young deletions pending); `blocked`
  `unverified_deletions:<n>` (a deletion unverified past one reconcile period — decided before
  anything else) or the recorded failure code (e.g. `copy_mode_withdrawn`,
  `deletion_unverified`, `delete_failed`, `linked_quality`, a `publication_host.*` code); `unknown`
  `not_reconciled` (no runtime row, or only a default row another writer created). A host the
  agent said is not a copy host, holding nothing, carries no such check. The row's own live
  `media_mode` (the trusted agent's word) decides at once: `shared` / `none` with nothing held
  → no check (a shared or freshly paired host never shows it); with bytes or debt held →
  `blocked` `copy_mode_withdrawn`; an unavailable mode leaves the stored verdict. `present` is
  the round's closing manifest count (a stopped round adds what it landed), `desired` the
  plan's. No secret field.
- Copy-mode hosts now get the media rules too: `apply_rules` refuses only a `none` host
  (`maintenance.action_refused`); a `copy` host is gated by the same `publication_host`
  profile over its copy root. The rows' `media_mode` reads `ok` for `copy` and `rules_hash`
  is compared for it (it was `warn` / `not_applicable`).
- New ROOT-ONLY action `reconcile_media_copy {name}` (a registry name, the same `name`
  option as every other per-host action): runs the registered `media_copy` reconcile APPLY
  for that host through the registry door and answers `data: true`, `msg`,
  `extend: {report, running: false}` (`ReconcileReport`, `detail.hosts[name]` =
  `{takes_copy, planned, sent, state, pending_deletions, remaining, error}`). Non-root →
  `perm.denied` (nothing loaded or dialled); invalid, unknown or missing host →
  `maintenance.action_refused`; the host's round failed → `maintenance.action_failed`
  naming the code. Like `push_apis` it waits at most `pushAnswerWithinMs`: a round still
  going answers `data: null`, `extend: {report: null, running: true}` and finishes detached
  in the copy lane. Request-bounded (not in `unboundedActions`): its statements are short
  advisory try-locks.
- TS ground truth: `test/unit/publication_host_media_copy_widget_native.test.ts`,
  `test/unit/publication_host_widget_native.test.ts`,
  `test/unit/publication_host_media_copy_status.test.ts`; client:
  `test/unit/publication_host_media_copy_client.test.ts`. No fixture interaction.

## Addendum 2026-10-05 — phase 6 (public-URL probe)

- New ROOT-ONLY action `probe_public {name}` → `data` = the probe verdict
  `{state: ok|failed|unknown, at, published_status, unpublished_status, detail}` (also
  recorded in the runtime file as `runtime.probe`), `msg` = an operator sentence naming the
  host. Non-root → `perm.denied` (nothing loaded); invalid, unknown or missing host →
  `maintenance.action_refused`. It dials no agent: two bounded GETs through the public door
  (`fetchGuardedText`, `Range: bytes=0-0`, 1 KiB cap, redirects refused). A `public_url` that
  is not a bare http(s) origin, or probe paths that do not mean what they claim (not a
  public quality, not the grammar, a working file, absent from the work media tree, or a
  `pub/` marker that contradicts the claim), answer `state: unknown` with `detail` naming
  why, and NOTHING is sent; a non-public address is `unknown` too, never `ok`. `failed` when
  either side is definitely wrong (the unpublished file served: the gate is OPEN), even if
  the other side is unknown. Request-bounded.
- `apply_rules` answers the extension key `probe` (same shape), measured right after the
  apply; a probe that cannot run is `unknown`, never a failed apply.
- `get_value` host rows (root and non-root) gain `public_probe` (same shape; never probed →
  `state: unknown, at: null, detail: 'never probed'`) — NOT `probe`, which on a root row
  stays the registry's probe PATHS for the edit form — and one decorator check
  `public_gate`, LAST: `ok` `published:<n> unpublished:<n>`; `warn` `stale:<at>` (an ok proof
  older than two probe periods, 30 min); `blocked` `published:<n|none> unpublished:<n|none>`
  (failed); `unknown` `never_probed` | `unproven`. Details are facts; the sentence is
  `public_probe.detail`, rendered as text.
- TS ground truth: `test/unit/publication_host_probe_native.test.ts`,
  `test/unit/publication_host_widget_native.test.ts`. No fixture interaction.

## Addendum 2026-10-07 — `bun_version` check + `bun` row field

- `get_value` host rows (root AND non-root) gain one fixed check `bun_version`, placed in
  `HOST_CHECK_IDS` right after `agent_version` (order: registry, secrets, reachable, pairing,
  agent_version, bun_version, media_mode, media_mount, media_read_only, rules_hash, api_v1,
  api_v2; the decorators `media_copy`, `public_gate` still follow). It compares the trusted
  agent status's `bun_version` with the WORK system's `.bun-version` pin, by EXACT equality.
  Closed detail vocabulary: `ok` `<v>` (equal); `blocked` `<reported> != <pin>` (any
  difference, prerelease tail included) | `malformed` (not shaped like a Bun version,
  `host_status.ts BUN_VERSION`); `unknown` `not_reported` (empty) | `unpinned` (this tree
  pins none) | `status_unavailable` (unreachable, unpaired, or a fingerprint mismatch).
- Row field `bun: {expected: string|null, reported: string|null}` on root and non-root rows.
  `expected` is the work system's pin (`code_restore.ts bunPinOf(projectRoot)`; null when
  unpinned) — a non-root global admin sees it, like `agent_version`: a version string, no
  secret. `reported` is null unless the status is trusted AND the value is shaped (agent
  text never reaches the row unvalidated).
- TS ground truth: `test/unit/publication_host_host_status_native.test.ts`,
  `test/unit/publication_host_widget_native.test.ts`,
  `test/unit/publication_host_media_copy_widget_native.test.ts` (the REAL deps feed the repo
  pin); client: `client/dedalo/test/client/js/test_publication_hosts.js`. No fixture
  interaction.

## Addendum 2026-10-08 — host-wide nginx map (provision init §13.4)

- `get_value` host rows (root AND non-root) gain `nginx_map`. Root:
  `{managed, expected, applied, host_hash, contributions, invalid, refused, drift,
  agent_outdated}` (`rules.ts nginxMapPanel`). `null` when no host-wide map applies or no
  trusted status was obtained: a non-nginx host, media mode `none`, the status call failed
  (unreachable, unpaired, fingerprint mismatch), or the engine's own computation threw.
  `managed: false` (map placed by hand) carries `expected/applied/host_hash: null`,
  `drift: false`. An agent whose status has no `rules.map` reads `agent_outdated: true`,
  `drift: true`. `applied` / `host_hash` are null unless 64-hex; `refused` is null or one of
  the agent's closed `map_*` reasons (`wire.ts AGENT_REASON_SENTENCES`), any other recorded
  value served as the literal `'malformed'` (E7: never agent text verbatim).
- **Decided (non-root):** a global admin who is not root gets `nginx_map` WITHOUT
  `host_hash`, `contributions` and `invalid` (keys absent, not null) — those describe the
  OTHER instances sharing that host, i.e. topology, which the entry keeps below root. The
  instance's own state (`managed`, `expected`, `applied`, `refused`, `drift`,
  `agent_outdated`) stays: hashes and a reason word, no address, no secret. The client
  renders the host-wide rows only when `host_hash` is present.
- `apply_rules` `data` becomes `{ host, server, hash, dropped, map }`, `map` one of
  `{state: 'pushed', hash, host_hash, contributions}` | `{state: 'current', hash}` |
  `{state: 'not_applicable'}` (apache, media `none`, `managed: false`). On nginx the map is
  pushed (`rules.map`) BEFORE the include, and only when the reported map hash differs; the
  `msg` gains "Host media map <12 hex> (<n> instance(s))." or "Host media map already
  current.". New failures on this existing action: an nginx agent whose status lacks
  `rules.map` → `maintenance.action_refused` before anything is sent; a map hash reported
  other than the one sent → `maintenance.action_failed` (the include is then never sent).
- New agent reasons reach the wire through `wire.ts`: `host_busy` → `publication_host.busy`
  (retryable, reason-before-status); `host_lock_missing` and the `map_*` reasons
  (`map_unmanaged`, `map_refused`, `map_contribution_foreign`, `map_contribution_newer`,
  `map_envelope_rebind`, `map_renderer_missing`) → `publication_host.rejected` /
  `publication_host.failed` by status class, with the engine-authored sentence for
  `rejected`.
- TS ground truth: `test/unit/publication_host_widget_native.test.ts`,
  `test/unit/publication_host_rules_native.test.ts`; client:
  `client/dedalo/test/client/js/test_publication_hosts.js`. No fixture interaction.

## Addendum 2026-10-09 — the map's state is a CHECK (`nginx_map`)

- A row whose `nginx_map` is non-null (root AND non-root) gains ONE check
  `{id: 'nginx_map', state, detail}` (`host_status.ts nginxMapCheck` / `withNginxMapCheck`,
  a `DECORATOR_CHECK_IDS` member appended right after the fixed list, before `media_copy` /
  `public_gate`): `blocked agent_outdated` | `blocked <refused reason>` (the shaped `map_*`
  reason or `malformed`) | `ok unmanaged` | `blocked none` (nothing of ours loaded) |
  `blocked drift` | `ok <expected hash, 12 hex>`. A row with `nginx_map: null` carries no
  such check. Before, `drift` was painted red by the client but counted nowhere a check is.
- The client no longer derives the state (`nginx_map_state` removed): the check renders
  through `check_row(…, 'publication_hosts')` with the new label
  `publication_hosts_check_nginx_map`; `publication_hosts_map_state` (its only reader was
  the removed row) is removed from `master.json` and every catalog. The `nginx_map` object
  and its fact rows are unchanged.
- TS ground truth: `test/unit/publication_host_host_status_native.test.ts`,
  `test/unit/publication_host_widget_native.test.ts`; client:
  `client/dedalo/test/client/js/test_publication_hosts.js`. No fixture interaction.

## Addendum 2026-10-09 — "New publication host" (drafts, kit, sealed-package pairing)

- Root's `get_value` gains `drafts_state` + `drafts`, and the widget gains six root-only actions
  (`propose_draft`, `save_draft`, `remove_draft`, `build_kit`, `download_kit`,
  `pair_package`) and four `publication_host_setup.*` codes — recorded in full in
  `engineering/wire_contract/WC-2026-10-09-publication-host-panel-setup.md`.
- "Hosts are added only on the command line" now reads: hosts are added only by the pairing
  path (`src/core/publication_host/pair_flow.ts`) — the CLI, or a sealed package that completes
  a draft this panel created, its address taken from inside the package and proved live. The
  panel still takes no typed address and no loose credential.
- TS ground truth: `test/unit/publication_host_setup_native.test.ts`,
  `test/unit/publication_host_widget_native.test.ts`; client:
  `client/dedalo/test/client/js/test_publication_host_setup.js`. No fixture interaction.

## Addendum 2026-11-10 — `web_traversable` (T0-6: a copy host 404s while it reads healthy)

- The agent's `media.probe` gains `web_traversable: boolean | null` (`PUBLICATION_HOST_SPEC.md`
  §6): `true` every directory from the media root to `.publication/pub` grants o+x; `false`
  a directory is dark to the web server's user, so Rule B's marker stat fails and EVERY
  published file 404s (the agent adds a `problems[]` line naming it); `null` not measured
  (mode `none`, root absent). Required by the engine's shape guard
  (`agent_client.ts isMediaProbe`): a status or probe from an agent that predates it is
  unreadable, as with `served_apis` — no skew window (TS-era beta, engine and agent ship
  from one tree).
- `probe({name})` → `data.probe` carries it: exactly the EIGHT known fields now
  (`boundMediaProbe`), the value passed as the agent measured it.
- `get_value` host rows (root AND non-root) gain one fixed check `media_web_traversable`,
  placed in `HOST_CHECK_IDS` right after `media_read_only` (order: registry, secrets,
  reachable, pairing, agent_version, bun_version, media_mode, media_mount, media_read_only,
  media_web_traversable, rules_hash, api_v1, api_v2; the decorators still follow). Closed
  detail vocabulary (`host_status.ts mediaWebTraversableCheck`): `ok` `traversable` |
  `none` (media mode `none`); `blocked` `not_web_traversable` (COPY mode only — the agent
  owns those levels); `unknown` `unverified_owner_group` (SHARED mode, `false`: the web user
  may reach the work host's read-only export as its owner or group, which o+x does not show —
  never a hard block; the agent's problems[] line for it is worded as advisory) |
  `unmeasured` | `status_unavailable`. New label `publication_hosts_check_media_web_traversable`
  (master + every catalog).
- TS ground truth: `test/unit/publication_host_host_status_native.test.ts`,
  `test/unit/publication_host_widget_native.test.ts`,
  `test/unit/publication_host_probe_client.test.ts`. No fixture interaction.
- New agent refusal reason `media_level_foreign` (409, `media.put` / `media.mark`): a dir
  level under the copy root owned by another user whose mode fails what serving needs (a
  public dir without o+x, or the private `.publication/copy/` granting group/other bits); the
  agent never chmods it. `wire.ts` maps it `publication_host.rejected` (reason before status)
  with an operator sentence (fix that folder's owner or permissions); it reaches the panel as
  `details.reason` like every agent reason. Gates: `test/unit/publication_host_copy_wire_native.test.ts`,
  agent `tests/media_copy.test.ts`, `tests/media_repair.test.ts`.
