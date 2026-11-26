# WC-2026-10-09-publication-host-panel-setup — "New publication host": drafts, the kit and the sealed-package pairing in the maintenance panel

- **Date:** 2026-10-09, with steps 4 and 5 of the publication-host guided install
  (`engineering/PUBLICATION_HOST_SPEC.md` §9.14).
- **Decision:** DEC-12 (each branch gated: the draft rules, the store, the kit and the upload by
  `test/unit/publication_host_setup_native.test.ts`; the action set, root-only and the
  bad-name refusal by `test/unit/publication_host_widget_native.test.ts`; the codes and labels
  by `test/unit/error_registry_native.test.ts` and `test/unit/labels_tripwire.test.ts`; the
  view by `client/dedalo/test/client/js/test_publication_host_setup.js`). Amends the TS-only
  widget of WC-2026-10-03-publication-hosts-widget: its "hosts are added only on the command
  line" rule now reads "hosts are added only by the pairing path (`pair_flow.ts`) — the CLI,
  or a sealed package that completes a draft the panel created".
- **Shape before (PHP):** nothing — the frozen PHP engine had no publication host. Before this
  entry (TS): the `publication_hosts` widget had eight actions and no way to start a host;
  pairing was the CLI's alone.
- **Shape after (TS):**
  - **`get_value`** (ROOT ONLY — another admin's payload has neither key): `drafts_state:
    'ok' | 'drafts_invalid'` and `drafts: DraftRow[] | null` (null whenever the state is not
    `ok`, never an empty list for a file that could not be read). `DraftRow` =
    `{name, created_at, draft, state: 'awaiting'|'paired', paired_as: string|null, kit:
    {name, instance, release, sha256, size, built_at, file_name} | null}`. `draft` is the
    panel draft: `{instance, layout, apis, listen, agent_user, engine_group?, web: {server},
    site: {domain}, v1?: {user}, media: {mode, root?}, v2: {unit, user, port}}` — the agent's
    draft format, nothing else, no secret. `state` is derived from the registry.
  - **six new actions, all root-only** (`perm.denied` first, before any module loads):
    `propose_draft {domain, machines: 'one'|'two', listen_host?, apis?}` → `data: {name,
    draft}`; `save_draft {name, draft}` → `data: {name, draft}`, `msg`; `remove_draft {name}`
    → `data: {name, removed: true}`, `msg`; `build_kit {name}` → `data: <kit summary> | null`,
    `msg`, extension `running` (a first build that outlives the bounded wait answers `data:
    null, running: true`, like `push_apis`); `download_kit {name}` → `data: {…kit summary,
    kit_base64}`; `pair_package {name, package_base64, passphrase}` → `data: {name, instance,
    address_label}`, `msg`.
  - **four new codes**, `publication_host_setup.*` (not the `publication_host.*` family: no
    agent answered them): `draft_invalid` (400, public, `details.fields` = the refused form
    fields, comma-separated declaration paths), `drafts_invalid` (503, operator),
    `kit_refused` (503, public, `details.reason` ∈ kit_build.ts KitBuildReason),
    `pairing_refused` (400, public, `details.reason` ∈ publication_host_setup.ts
    PANEL_PAIR_REASONS). Every sentence is engine-authored; a live proof that fails is the
    existing `publication_host.pairing_mismatch` / `unreachable` / `timeout`.
  - **the pairing upload takes no address.** The address comes from inside the package and
    must equal the listener of the saved draft named `name` (`address_mismatch` otherwise),
    with the draft's instance (`draft_mismatch`), both checked BEFORE the token is read and
    before anything is dialled; then the CLI's own path (pair_flow.ts pairWith): fingerprint,
    registry slot, the live `/health` proof over mTLS (no bearer), the locked commit. The
    passphrase and the package are never logged, echoed or stored.
- **Reason:** the guided install's two machines need the kit carried to the publication host
  and the package carried back; an operator who works in the panel needs both there, and the
  CLI path stays (owner decision D5). A typed address stays impossible: the binding to a
  panel-created draft and the live proof are what make the upload safe.
- **Gate reconciliation:** no parity gate covers the publication-host channel (TS-only); no
  fixture changes, no re-harvest.

## Addendum 2026-11-25 — one-machine install block, topology sentences, IPv6 listener

Root's `drafts[]` rows gain `install` (the one-machine block), `save_draft`'s sentence follows
the topology and `pair_package`'s names First use
(`WC-2026-11-25-publication-host-one-machine-install`); a two-machine draft's `listen.host` may
be a private IPv6, canonicalized, and the pairing binding compares hosts canonically
(`WC-2026-11-25-publication-host-ipv6-listener`).
