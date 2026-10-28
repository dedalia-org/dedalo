# Dédalo v7 — TypeScript/Bun (master_dedalo) — THE engine since 2026-07-11 

Native TS/Bun Dédalo server. **CUTOVER EXECUTED 2026-07-11** (`rewrite/CUTOVER_RUNBOOK.md`): the PHP engine is decommissioned, unmaintained DEAD CODE (`../../v7_php_frozen/master_dedalo` — historical reference only); TS is the single engine and sole writer, and `client/` is the PRIMARY, TS-OWNED client source. 

**This file is the project's instructions for any coding agent.** It is the ONE copy: `CLAUDE.md` is a symlink to it, so Claude Code and any tool following the `AGENTS.md` convention read the same bytes and cannot drift. Never fork the two (the "link, never duplicate" law applies to this file first). 

## 🎯 Project premise — the master criterion 

**Dédalo's goal is to create the best Cultural Heritage management system possible.** It is NOT a commercial product; no decision is judged by market, startup, or product criteria. Every architecture/design decision aligns with this premise. Concretely: 

- **Never rank options by time, cost, or effort.** Recommend the structurally   correct, durable design even when it means a full rebuild. State effort as   information, never as the deciding criterion. Reserve conservatism for real   safety (data integrity), not scope. 
- **Dependencies default to the latest STABLE version.** Staleness is the   risk (debt shipped to long-lived heritage installs), not the upgrade.   Holding an old major needs a stated reason next to the pin (e.g. latest is   only beta/RC). Mechanical side (per DEC-12): Dependabot proposes the bumps,   `scripts/ci/audit.ts` ratchets advisories — never override either toward   older versions. Security pins (SHA-pinned actions, `.bun-version`) are NOT   staleness: they are exactness with an updater, and stay. 
- If a proposal is shaped by commercial instincts (MVP thinking, churn-minimizing, risk-averse scoping), it has the wrong perspective —   restate it from the premise. 

## Interactions 
- In all interactions and commit messages, be extremely concise and precise and sacrifice grammar for the sake of concision. 

## ⚠️ THE VERIFICATION STORY (read this first — post-oracle) 

The live-oracle era is over. The baselines of record are FROZEN: 

- **Read-path parity** replays the frozen fixture store   (`test/parity/fixtures/oracle_harvest/`, final harvest 2026-07-11) —   `ORACLE_MODE` defaults to `fixtures`, credless. **It is NOT green on the   suite DB** (the 76 gates were harvested against the `monedaiberica`   install's records, which the vendored test DB does not and must not hold;   the frozen reds are banked per test name in `engineering/parity_baseline.json`).   The store + the same-instant snapshot (`../private/backups/db/2026-07-11_102750.….custom.backup`,   on disk) are a pinned pair, but restoring it is NOT the fix: a gate that   passes only against one install's records tests that install, not the engine.   The corpus-bound gates are being replaced by generic-`test`-TLD twins   (`engineering/ORACLE_HARVEST.md`, DEC-14b map). 
- **Write-path contracts** live in the TS-native `test/unit/*_native.test.ts`   gates (DEC-14b — each retired differential's twin is mapped in   `engineering/ORACLE_HARVEST.md`). 
- A re-harvest is IMPOSSIBLE by definition. Any fixture change is a   deliberate contract edit and needs its `engineering/wire_contract/`   entry the same day — the WC ledger remains the wire law. 
- Never assert against a mutable production record — use scratch twins   (see the `dedalo-parity-debugging` skill). 

## Hard rules 

- **`client/` is the TS-OWNED primary client source** (since the cutover;   `scripts/sync_client.sh` is retired and refuses to run). Edit it directly;   the gate is serving self-consistency (`client_serving.test.ts`) +   `bun run test:client`. The old law still holds in spirit: when a widget   renders blank, fix the server payload first — the client is vanilla JS   with an exact wire contract. 
- **`../private/.env` is append-only**, documented keys only. Config is   read through `readEnv`/the typed catalog — `process.env.` outside   `src/config/` fails the tripwire. 
- **Invariants are tripwired or deleted** (DEC-12). If you state a rule in a   header/README, add a mechanical gate. Coverage-state lists live ONLY in   `rewrite/LEDGER.md` / `rewrite/STATUS.md` — headers may link, never duplicate   (S2-45). ONE carve-out (2026-07-11): the **tripwire index is a machine-read   contract** and lives in `engineering/TRIPWIRES.md`, because `rewrite/` is not   in the repo. 
- **`rewrite/` is INTERNAL PROCESS and gitignored** — plans, status, history,   the closed COEXISTENCE ledger, the runbooks. It is not on a clone, so **no   gate, script or error message may read a path under it**. Anything mechanically   enforced, or that a consumer of the engine needs, belongs in `engineering/`   (permanent definitions) — that is the difference between the two directories. 
- **Never silently narrow scope**: uncovered paths throw loudly and get a   ledger line — in `rewrite/LEDGER.md` if it is state, but next to the code (a   `reason` field, a named exemption) if a gate must verify it. 
- **DB writes in tests only on scratch surfaces**; clean up after. And the
  suite only writes to a database that SAYS it is one: `bun run test:db:setup`
  stamps the `dedalo_test_marker` row, and every test-data writer
  (`src/core/test_data/**`, `test/helpers/**`) calls `assertTestDatabase()`
  before its first write — a database without the marker is refused, loudly and
  without writing. The name (`<app db>_test`) is a convention; the marker is
  the guarantee. NO bypass exists: the install seed is core-only and an
  installation receives no test fixture (no `test` TLD, no test3), so the
  installer never calls a test-data door. Gate:
  `test/unit/test_db_marker_tripwire.test.ts`. 
- **And FILE writes only into a media root that SAYS it is one.** The suite has
  its own media tree, `../private/test_media/<suite db>` — swept and rebuilt by
  `bun run test:db:setup`, created by `bun test`, marked with a
  `.dedalo_test_media` file. ONE key, `DEDALO_TEST_MEDIA_ROOT`, both repoints
  `config.media.rootPath` and ARMS the refusal, so a run cannot be armed at the
  installation's root nor repointed with the guard asleep; armed, every door
  that resolves a media root refuses one without the marker, names itself, and
  writes nothing (`src/core/media/test_media_root.ts`). A gate's own scratch
  root needs the declaration too — `test/helpers/media_scratch_root.ts`. Gate:
  `test/unit/test_media_root_tripwire.test.ts`. 
- **Tests use the generic `test` TLD and BUILD the situation they test.**   Never a specific install's TLD (`numisdata`, `oh`, `tch`, `rsc`, `ich`,   `mdcat`…): such a gate passes on one machine and nowhere else. Structure   comes from repo-owned node definitions materialized through the engine's   own write path (`src/core/test_data/` situations — `upsertDdOntologyNode`,   `zz*` scratch TLDs, torn down after); records are created at runtime, never   read from whatever the ambient DB happens to hold. Ratcheted by   `generic_tld_tripwire` (shrink-only). 
- **Ontology definitions belong to the MASTER ontology — never create them
  yourself.** Creating an ontology TLD, section, component or any other node
  without specific human authorisation is NOT allowed — no "engine-owned" TLD,
  no node shipped in code. When a feature seems to need ontology state: STOP
  and ASK — is a new TLD really necessary, or is a section/component in an
  existing TLD enough, or does existing structure (Time Machine, Activity, a
  user record) already carry it? You may PROPOSE (TLD, parent, model, how the
  engine reads it); a human decides. An approved definition is set up on the
  master ontology server first and reaches an installation through an ontology
  update; only then may code use its tipos. Sole exception: the suite's own
  fixtures in the marked suite DB (the `test` TLD, `zz*` scratch TLDs torn down
  after) — and a NEW test TLD needs the same authorisation.

## Commands 

- `bun run dev` — server (unix socket / port per `../private/.env`). 
- `bun test test/unit/…` / `bun test test/parity/…` — targeted gates   (full `bun test` takes minutes; parity replays the frozen store, no   oracle, no creds — but see the verification story above: corpus-bound   parity gates are red on the suite DB by construction until replaced). 
- `bun run test:db:setup` — build the SUITE database THROUGH THE INSTALLER'S DOORS (`installDbFromSeed` = the core-only seed + search stores + `lg`; then the default `oh` via `stageOntologies`/`installOntologies` from the vendored file), stamp `dedalo_test_marker`, then add the suite's own fixtures (the `test` TLD, the test3 playground, hierarchies, tools) — AND sweep/rebuild the SUITE MEDIA ROOT (`../private/test_media/<suite db>`, marked `.dedalo_test_media`). `bun test` creates the media root itself if it is missing, so this command is about a clean, rebuildable fixture — not a prerequisite for the media guard being armed. 
- **Suite MariaDB (PUB-05)** — the diffusion gates run against the suite's OWN MariaDB per lane
  (`../private/test_mariadb/<suite db>`, marked `.dedalo_test_mariadb`, `--skip-networking` unix
  socket), armed in every `bun test` by `test/preload/suite_mariadb.ts`; never an installation's.
  Needs `mariadbd`, `mariadb-install-db` and `mariadb` locally (macOS: `brew install mariadb`):
  without them the MariaDB gates go RED, not skip. The server is detached and outlives `bun test`:
  `bun run scripts/ci/suite_mariadb.ts stop` ends it; `… sweep` also deletes the lane root (marked
  roots only). CI: `db_tier.sh` starts it (EXIT trap stops it) and runs `scripts/ci/mariadb_tier.ts`
  LAST. Canon: `engineering/CI.md` → *Suite MariaDB target*.
- `bun run test:client` — the browser client suite (Mocha in headless Chrome).   It STARTS ITS OWN SERVER on the dedicated SUITE database and stops it again:   no dev server to start first, no port to pass, no client test can reach the   application's data (`scripts/client_test_server.ts`; build the database once   with `bun run test:db:setup`). 
  - `bun run test:client:server` — the SAME suite server kept alive for BROWSING
    the page by hand (`scripts/client_test_serve.ts`): same repoint, same login
    credential, same projects fixture (installed on start, swept on Ctrl-C),
    same `/health` fingerprint verification. It does NOT reseed test3 — a
    browsed page is for inspecting state, not wiping it. The replacement for the
    retired habit of opening the page on a dev server — fixture-bound suites
    (e.g. test_additional_text_area's test480/506/507) refuse loudly there.
  - **Auth is real**: the run sets the suite database's own credential
    (`src/core/test_data/suite_login.ts` — the install seed ships `root`
    passwordless), calls `login()` in-process, injects the session cookie.
    `--auth form` uses the login UI; `--auth mint --user <existing>` is the
    no-password escape hatch. 
  - **`--url <page>`** still drives a server you started yourself — VERIFIED,
    not trusted: any target must answer `/health` with the fingerprint of the
    same `dedalo_test_marker` row this process reads (dev-mode-only, an opaque
    hash, never the DB name), or the run refuses before Chrome launches.
    **`--port`** moves the run's own listener (default 4390, next free). 
  - **The baseline is IN the runner**: `KNOWN_FAILING` (shrink-only, reasons
    inline — a listed suite that PASSES is red too); `--strict` ignores it.
    `KNOWN_FAILING` is currently EMPTY, so a plain run equals `--strict`. 
  - **The suite size is banked, not quoted**: `engineering/client_gate_inventory.json`
    (`suite_floor`, `mocha_test_floor` — shrink-only, raised by `--update` after a
    green run). ALWAYS measure with the reseed on — a polluted test3 fakes ~7 failures. 
  - **The run PINS what two suites need instead of borrowing it from the
    machine**. The diffusion domain is `SUITE_DIFFUSION_DOMAIN` (`test`, the
    repo-owned generic domain — the engine matches a domain BY TERM, so the
    installation's name resolves to a truncated clone here and
    `tool_diffusion` silently disappears), asserted before Chrome starts. The
    second project the `dd153` `component_filter` needs (there is no unchecked
    box without it) is installed pre-run and swept after
    (`src/core/test_data/projects_fixture.ts`, at one explicit id it owns and
    sweeps). Gate: `test/unit/client_situations_native.test.ts`.
    (!) There is NO reserved `section_id` band. Test isolation is the dedicated
    test DATABASE and its markers, never an id range: a real heritage section
    may legitimately pass any id, so no range is ever "clear of genuine
    records". An explicit id also does NOT keep the counter still — the
    allocator raises it with GREATEST (`insertMatrixRecordWithExplicitId`),
    which is why `test3`'s counter stands in the hundreds of thousands. That is
    correct behaviour, not drift. 
- `bun run test:crawl` — every feature AS EVERY PERSONA on the SUITE database (own
  server, minted sessions): root, a non-root global admin and a project-scoped editor
  (`test/helpers/crawl_persona_fixture.ts`) walk their own menu — list + first-record
  edit, one component per model at the server's grant level, every inspector block,
  every offered tool — then the direct-URL permission oracle and the user journeys
  (`test/helpers/journey_cases.ts`; tool-operation coverage in
  `test/helpers/tool_operation_cases.ts`). `--persona`, `--only <tipo>`, `--max <n>`,
  `--journey a,b`, `--no-journeys`, `--concurrency <n>`, `--out <dir>` (JSON + PNG per
  finding). Ratchet: `test/helpers/feature_crawl_ratchet.ts`.
- `bun run test:tools:phone` — every tool at 360×740 on the SUITE database (own
  server, real login, click-path probes, scratch records swept): the phone
  contract of `tools_common/css/tool_responsive.less`. `--shots <dir>` for the
  visual review, `--tool a,b` to narrow, `--discover <tipo>/<id|list>` to find
  callers, `--overflow '<query>|<query>'` to find what widens a page. Ratchet:
  `test/helpers/tool_phone_ratchet.ts`.
- `bunx tsc --noEmit` — zero-NEW-errors rule (pre-existing baseline is   ledgered in `rewrite/LEDGER.md`). 
- `bun run test:update` — the code-updater's REAL-SCENARIO drill (opt-in, `scripts/update_drill.ts`): a scratch `git clone` gets the release commit (version bump + bun pin), a REAL master instance builds + serves the newest `UPDATE_CATALOG` release through the wire, a git-archive copy of this checkout under a supervisor loop installs it across the planned-death restart — panel probe → manifest → tampered-sha refusal → job frames → `/health` answering that version → sentinel confirmed. Needs the suite DB (`test:db:setup`) + network for the quarantine `bun install`; ~3–5 min; never touches the app DB or the live private state. 
- `bun run test:update:dev` — the same drill on the DEVELOPER CHANNEL: the
  release is cut from a branch that is not `master` (built and served as
  `<v>-dev.zip`) and installed OVER THE SAME VERSION, which is how unreleased
  branch work reaches a remote installation. The only pass that proves the
  post-swap identity story — with the version fixed on both sides, `/health`'s
  `install_digest` is what tells the new tree from a rolled-back one.
  NOTE both drills bind a smoke-boot unix socket under the scratch dir and
  macOS caps that path at 104 bytes: on a long default `TMPDIR` every run dies
  at `preflight`. Use `TMPDIR=/tmp/dd bun run test:update…`.
- `bun run probe:update` — the MUSEUM-CYCLE probe against the REAL stacks (`scripts/update_probe.ts`): the docker simple stack plays a museum install (recreated with its code tree bind-mounted, so the channel is `tree_swap`), the local dev server plays master; prepares origin consistency (LAN-IP `DEDALO_HOST`), cuts the next patch release (museum version +1) into `<repo>/code/`, materializes the museum tree + override, then verifies channel/serving/manifest — or drives the whole update with `--drive --user/--pass`. Touches the real docker install and appends to `../private/.env` when the advertised origin drifted. 
- `bun run lint` — biome (burn-down owned by a dedicated pass).
- `bun run seed:build` — COMPILE the install seed (`install/db/dedalo_install.pgsql.gz` + `install/db/dedalo_install.manifest.json`) from repo sources only (`install/db/seed/`, the migrations, the ontology release `install/import/ontology/<major.minor>/`) — NEVER from an installation's database; proven by a fresh install before it is written; commit seed + manifest together. A source change without a recompile is STALE (`install_seed_manifest_tripwire`). Same compiler as Maintenance → Build database version. Canon: `docs/development/ts_install_internals.md` §Seed.
- `bun run changelog` — re-render `docs/change_log.md` (GENERATED — never edit it). A reader-visible change ships a fragment in the same commit: `bun run changelog new <slug>`, fill it, re-render. `bun run changelog release <version>` at a release cut. Rules: `changes/README.md`; gate: `change_log_tripwire`. 

## Docs index 

**`engineering/` = what the system IS** (permanent definitions, in the repo). 
**`rewrite/` = how we GOT HERE** (process/history, gitignored, local-only). When in doubt: if a gate reads it or a consumer needs it, it is `engineering/`. 

| Doc | What |
|---|---| 
| `engineering/REWRITE_SPEC.md` | Master spec: constraints, security chokepoints, architecture. | 
| `engineering/TRIPWIRES.md` | **The tripwire index** — machine-read: `verify.ts` TRIPWIRES must equal it exactly. | 
| `engineering/WIRE_CONTRACT.md` | The wire-divergence ledger's RULES + id grammar; the entries are one file each in `engineering/wire_contract/`. | 
| `engineering/RELATIONS_SPEC.md`, `engineering/SECTION_SPEC.md` | Family specs — **read the dated §1 addenda first**: the rebuilds they instruct already landed. | 
| `engineering/DIFFUSION_SPEC.md` | Native diffusion subsystem (`src/diffusion/`, Bun-owns-MariaDB tiering). | 
| `engineering/EXTERNAL_SPEC.md` | External record services (`src/external/`, a PEER of core) — the four ontology pieces, the one outbound door and its order, egress classes, the write invariant. | 
| `engineering/OUTBOUND_SPEC.md` | Every request the engine sends to another server — the FOUR outbound doors (single API call / external record service / tool harvesting via `src/core/harvest/` / the paired private publication-agent channel `src/core/publication_host/transport.ts`), the one SSRF guard under the first three, the harvest hop order, who may use which door. | 
| `engineering/PUBLICATION_HOST_SPEC.md` | A separate publication machine controlled from the work system — the agent channel (work → publication only), API deployment, media modes `copy`/`shared`, the `publication_host` rule profile, phases. | 
| `engineering/IDENTIFY_SPEC.md` | Object identification (`src/core/identify/` + the RAG image index) — a criterion IS an SQO path; read §4 for what each match mode actually does today. | 
| `engineering/CONVENTIONS.md` | Error-handling/logging convention + the dynamic-import rules. | 
| `engineering/ERRORS_SPEC.md` | The error system: closed DedaloError registry, the ONE converter, envelope v2, client contract, gates. | 
| `engineering/ORACLE_HARVEST.md` | The frozen fixture store: how it replays, why a re-harvest is impossible, the retired-differential twin map. | 
| `engineering/PRODUCTION.md` | Ops: supervision, socket, backups, health. | 
| `engineering/STAGING_VALIDATION.md` | Exercise the ops hardening before production. | 
| `engineering/CI.md` | CI/CD: pipeline map, hermetic vs self-hosted tiers, seam env, activation runbook. | 
| *— internal, not in the repo —* | | 
| `rewrite/LEDGER.md` | **Current state** — measured baselines, per-subsystem coverage, known-open gaps. Update rows in place. | 
| `rewrite/STATUS.md` | Historical narrative ledger (long-form phase history; frozen — see its banner). | 
| `rewrite/COEXISTENCE.md` | CLOSED PHP-coexistence ledger (COEX tags, removal conditions) — history since the cutover. | 
| `rewrite/CUTOVER_RUNBOOK.md` | The one-day operator procedure that froze PHP and made TS the single engine. | 
| `rewrite/client_tests.md` | Historical client-gate notes (the LIVE baseline is `KNOWN_FAILING` in `scripts/client_test_runner.ts`). | 
| `audits/2026-07_foundation/` | Foundation audit: FINDINGS / DECISIONS / REMEDIATION (finding ids like S2-26 resolve here). | 

## Architecture in one breath 

Ontology-driven: `dd_ontology` defines everything; `src/core/ontology/resolver.ts` is the cached accessor layer. Reads flow RQO → `core/api/dispatch.ts` → `section/read.ts` (context+data, the PHP build_json_rows shape) with relations expanding through `core/relations/registry.ts`. Component models are declarative descriptors (`core/components/README.md` — the honest model-addition checklist). Writes go through `section/record/save_component.ts` (tx-wrapped, TM-audited) → the record chokepoint `section_record/record_write.ts` (`persist*` → `afterRecordWrite`; observer propagation rides its post-COMMIT obligation ledger) → `db/matrix_write.ts`/`json_codec.ts`. SQL confinement is tiered (T1–T4, DEC-09: `engineering/TRIPWIRES.md` → `sql_confinement_tripwire`). Diffusion is native under `src/diffusion/` (facade: `diffusion/api/`). Request identity (lang, principal) is ALS-scoped — never captured at module level. 

## Virtual sections 

A section is **virtual** when `getSectionRealTipo(tipo)` returns another tipo: its ontology `relations` name a node whose **model is `section`** (e.g. `rsc170` → `rsc2`, `es1` → `hierarchy20`). Real sections have no such relation (`numisdata3`). A `matrix_table` relation (`dd623` → `dd22`) does **not** make the section virtual. 

Virtual sections borrow the real section's children. Never use a plain `WHERE parent = sectionTipo` for child-by-model lookup — use `findSectionChildByModel` / `getSectionRealTipo` (own children are often only `exclude_elements` / `section_list` / buttons). 

- **Edit**: real children **minus** the FIRST `exclude_elements` child (skipping   a grouper drops its subtree). Without this the edit form is empty. 
- **List columns**: inherit the real `section_list` **verbatim** (no `exclude_elements` subtraction). Own `section_list` wins when present; a   zero-children hierarchy instance (`es1`) still needs the real fallback or   only the built-in `Id` column renders. 

Canon: `engineering/SECTION_SPEC.md` (§7.1 + virtual notes). Playbook: `dedalo-section-family-ts`. 

## Tripwires 

The authoritative tripwire list is **`engineering/TRIPWIRES.md`** (in the repo, because it is machine-read; the rest of the coverage state stays in `rewrite/LEDGER.md`). `scripts/verify.ts` TRIPWIRES must match it — `test/unit/ci_workflow_tripwire.test.ts` guards the CI wiring around them. 

## Agent tooling layout 

Vendor-neutral home, vendor-named aliases — one copy of everything, symlinked so any agent tool finds it without a second source of truth: 

| Real path (edit here) | Alias (committed symlink) | What | 
|---|---|---| 
| `AGENTS.md` | `CLAUDE.md` | These instructions. | 
| `.agents/` | `.claude/` | Agent config root. | 
| `.agents/skills/` | — | Project skills — the subsystem playbooks (`dedalo-ts-foundation` first; it maps the rest). | 
| `.agents/workflows/` | — | Multi-agent workflows (e.g. `review-diff`). | 

Rules: 

- **Never duplicate an alias into a real file.** A second copy of `AGENTS.md`   is a fork, not a convenience. 
- **Machine-local state is never versioned** (`.agents/settings.local.json`,   `.agents/scheduled_tasks.lock`) — the skills and workflows ARE. 
- Git does not descend into a symlinked directory: ignore rules and any   tool config must name the **real** path (`.agents/…`), never the alias, or   they silently match nothing. 
- Symlinks need `core.symlinks=true` on Windows checkouts; macOS/Linux (this   project's targets) get them for free. 
- Pipe output through head, tail, or grep to reduce result size. Avoid cat on large files — use Read with offset/limit instead.