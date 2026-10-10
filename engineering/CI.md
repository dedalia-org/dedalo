# CI/CD — pipeline map, local gate, invariants, runbooks

CI runs on `dedalia-org/dedalo` (GitHub; transferred from `renderpci/dedalo` on
2026-10-09 — old URLs redirect), a **PUBLIC** repo whose default branch is
**`master`**; development lands directly on **`v7`**. Both facts shape everything
below (see Security posture). Active since 2026-07-11. Invariants in the workflow
files are enforced by `test/unit/ci_workflow_tripwire.test.ts` (rules numbered in its
header) and `test/unit/tier_wiring_tripwire.test.ts` (legs A–L).

The design in one paragraph: every check CI runs is runnable on the desk **in CI's own
image** before the push leaves (`scripts/hooks/pre-push` → `bun run ci:local
--docker`); ratchet IMPROVEMENTS are banked mechanically before the push
(`bun run baselines:bank`); one command publishes both landing branches to every
remote with the gate run once (`bun run push`); on GitHub each sha is verified once,
not once per branch (the `dedupe` job); and the checks whose input is the CALENDAR,
not the commit, run nightly instead of on the push (`nightly.yml`).

> **ONE IMAGE, EVERY HOST** (landed 2026-09-26): GitHub's hermetic/db/instance jobs
> (`container:`), GitLab's hermetic job (`image:`) and `ci:local --docker` all run the
> build `ci/image.json` locks, by digest, as uid 1001 (`scripts/lib/ci_image.ts`;
> `ci_workflow_tripwire` rule 1b holds every copy equal to the lock and the lock's
> fingerprint equal to the checkout's). Before it only `ci:local` used the image — and a
> LOCAL build of it — so a desk verdict predicted neither host.
>
> **The unit tier is BLOCKING (2026-10-02).** Advisory since 2026-08-29 (its red set was
> load- and order-dependent: 7 / 1 / 14 reds on one commit), it flipped once its criterion
> held: the baseline RECORDED IN THE IMAGE on the sorted tier order
> (`ci:local --docker --record-unit-baseline`, below; 0 frozen reds) and zero drift on three EXECUTED GitHub db runs of 674c1f4f76 (37039097260, the v7 push; 37042365421 and 37042378243, dispatched — the master push run was skipped by the dedupe, so it is not counted). The old criterion's "one of them on a loaded runner" leg was NOT separately exercised; a timing-sensitive red that only load exposes would still surface as drift and fail the tier. The desk skip (`--skip-advisory`) went in the same
> commit — a desk that skipped a stage the runner can fail on predicts nothing; the CLI
> now refuses the flag (`ci_local_native` §6). A red unit check fails `db_tier.sh`:
> `tier_wiring_tripwire` legs H (the raise line) and L (executed, stubbed: the check
> exiting 1 makes the root exit non-zero).

## Pipeline map

GitHub executes ONLY `.github/workflows/`. `.github/workflows-selfhosted/` is the
PRIVATE MIRROR's copy of the parked self-hosted steps — inert here, every step twinned
by a hosted one (`tier_wiring_tripwire` leg B).

| Workflow | Trigger | Runner | Runs |
|---|---|---|---|
| `.github/workflows/ci.yml` | pull_request + push master/v7 | hosted ubuntu, `hermetic` in the CI image (uid 1001) | `dedupe` → `hermetic` (`scripts/ci/hermetic.sh`) |
| `.github/workflows/db.yml` | pull_request + push master/v7 + dispatch | hosted ubuntu, each tier job in the CI image (uid 1001) + a `pgvector` service (digest-pinned) reached as `postgres` | `dedupe` → `db` (`scripts/ci/db_tier.sh`: builds the suite database from repo-vendored bytes, starts the suite MariaDB target, then, in this order, the DB-backed tripwires → the unit tier (blocking since 2026-10-02) → the parity tier → the MariaDB tier (blocking — PUB-05, LAST on purpose: see *CI tiers → DB* below; tier_wiring leg K)) and `instance` (`scripts/ci/instance_tier.sh`: its OWN fresh suite database, then the browser client suite via `scripts/ci/client_gate.sh`, the tool phone contract, both update drills, the publication-host media drill on live Apache + nginx, the publication-host agent drill (the suite MariaDB started for it) and the publication-host engine drill (engine ↔ real agent: pair CLI, panel actions, httpd gating)). Both source `scripts/ci/hosted_env.sh` |
| `.github/workflows/nightly.yml` | cron 04:17 UTC daily + dispatch | hosted ubuntu | the TIME-BASED checks the push gate defers: `scripts/ci/audit.ts --force --require-network` with the vendor calendar ON; `image_pin` (`bun run ci:image:pin --check`: the lock is the latest published build); `cosign_pin` (`bun run ci:cosign:pin --check`: `ci/cosign.json` is set and is the latest stable cosign); `full_gate` (environment `gitdedalo-nightly`): fetches **gitdedalo/master** with a read-only deploy key + pinned host key and runs the FULL gate on it — `bun run ci:local --docker --hermetic --db --instance --ref <sha>` — see *The nightly full gate*; `report` keeps one `ci-nightly` issue open/updated/closed (a red full gate is a problem naming the gitdedalo sha and each red stage; absent secrets are a warning) |
| `.github/workflows/ci-image.yml` | push master/v7 touching the image definition + weekly cron (cache OFF) + dispatch | hosted ubuntu-24.04 amd64 + arm64 (native, no QEMU) | builds `ci/Dockerfile`, smoke-tests the exact bytes, pushes `ghcr.io/dedalia-org/dedalo-ci` (`fp-<fingerprint>`, `<YYYYMMDD>`, `latest`) as a multi-arch manifest list |
| `.github/workflows/image-release.yml` | push of a stable tag `vX.Y.Z` + dispatch (`dev` from `master`, or `release` of an existing tag) — never PR or schedule | hosted ubuntu-24.04 amd64 + arm64 (native); `publish` bound to the `image-release` environment | the PRODUCT image (`Dockerfile`): `plan` (refuses a release commit without a successful push run of ci.yml AND db.yml — the full gate) → per-arch `build` from a `git archive` of the release commit + smoke test → `publish` (one index in staging, immutability, cosign keyless sign ONCE, `cosign copy` to every provisioned registry of `engineering/image_registries.json`, same-digest + `cosign verify` check, record) — see *The product image* |
| `.github/workflows/security.yml` | PR + push master + weekly cron + dispatch | hosted ubuntu | secret scan (gitleaks, digest-pinned image): working tree every run, FULL HISTORY weekly |
| `.github/workflows/codeql.yml` | PR + push master + weekly cron | hosted ubuntu | CodeQL dataflow SAST (javascript-typescript, `build-mode: none`) → Security tab |
| `.github/workflows/docs.yml` | PR + push master, both narrowed to `docs/**`/`mkdocs.yml` | hosted ubuntu | the mkdocs manual build (not a tier: legs F/G do not bind it) |
| `.gitlab-ci.yml` | MR + default-branch push (GitLab mirror) | GitLab shared runners, in the CI image (digest-pinned, uid 1001) | hermetic tier only — the SAME `scripts/ci/hermetic.sh` |
| *— PRIVATE MIRROR ONLY (inert on the public repo) —* | | | |
| `.github/workflows-selfhosted/selfhosted.yml` | dispatch (restore PR/push triggers on the mirror) | self-hosted mac | `verify` + `full` (`bun test test/unit test/parity`) — both twinned hosted |
| `.github/workflows-selfhosted/nightly.yml` | cron 01:00 UTC + manual | self-hosted mac | full `bun test` (incl. `test/integration/**`, whose MariaDB legs the hosted `db` tier's blocking MariaDB stage also runs, on the suite's own server — PUB-05) + client gate |
| `.github/workflows-selfhosted/deploy.yml` | manual dispatch | self-hosted mac | **PARKED** — loud failure until DEPLOY_HOST/DEPLOY_SSH_KEY exist, then `deploy/deploy.sh` |

**Every gate has an EXECUTING hosted home.** `tier_wiring_tripwire` holds the whole
wiring: every `scripts/ci/*.sh` is reached from an executing workflow chain or carries
a self-hosted-only reason (A); every parked self-hosted step has a hosted twin (B);
every stage `scripts/verify.ts` reports is executed by one (C); every `test:*`/`ci:*`
package script is run by name on a hosted chain or is local-only with a reason (D);
every tier root keeps its independent-stage accumulator and every suite-building job
its own service (E); a tier job is unconditioned except the sanctioned dedupe `if:`,
untolerated and runs EXACTLY `bash scripts/ci/<tier>.sh` (F); every tier workflow fires
on bare `pull_request` and on `push` to exactly `LANDING_BRANCHES` = `master`, `v7`
(G); every stage line carries its verdict (H). Change the branch list in the constant
and the `on:` blocks together.

`scripts/verify.ts` is the DEVELOPER-environment gate (your `../private/.env`, your
Postgres, your libc) and is run by no workflow; its stages are twinned hosted (leg C).
It is not replaced by the CI-environment gate below — two environments, both matter.

### One verification per sha — the dedupe (2026-09-26)

`bun run push` lands ONE sha on both `master` and `v7`, so every push fired `ci` and
`db` twice on identical bytes. Now:

- **Concurrency.** A PUSH run is grouped by its SHA (`ci-<sha>` / `db-<sha>`) and
  never cancelled: the second landing branch's run QUEUES behind the first (a queued
  run bills nothing). A sha has at most two push runs (one per landing branch), so
  the group's single pending slot never evicts one. A pull request keeps the old
  shape — grouped by ref, a superseded run cancelled. Every OTHER event (a `db`
  `workflow_dispatch`) is keyed by its own run id: in the sha group, a newly queued
  run would CANCEL the pending push run whatever `cancel-in-progress` says. Honest
  limit: re-running a finished run while the other branch's run of the sha is still
  pending re-enters the group and would evict that pending run — dispatch `db`
  instead of re-running while one is queued.
- **`dedupe` job** (first job of both files, byte-identical in the two): holds only
  `actions: read`, runs no action and no repository code, and outputs `skip=true`
  iff the event is `push` AND a push run of the same workflow on ANOTHER branch
  CONCLUDED `success` for the same sha. Serialization decides which run defers, not
  run-id order (admission order is not documented to follow run ids): whichever of
  the two starts second skips. Only success is deferred to — never a run in
  progress: a skip is a green check and may only ever stand next to a green one. A
  red, cancelled or missing first run makes the second run in full. An API error
  fails OPEN (`skip=false`). A re-run of a run whose sibling succeeded defers too —
  to force the tiers, use `workflow_dispatch` (`db`) or push a new sha.
- **Tier jobs** `needs: dedupe` with
  `if: ${{ !cancelled() && (github.event_name != 'push' || needs.dedupe.result != 'success' || needs.dedupe.outputs.skip != 'true') }}`.
  `!cancelled()` replaces GitHub's implicit `success()`, so a FAILED or timed-out
  dedupe RUNS the tiers (the dedupe's own red still makes the run red). The only
  skip is a push whose dedupe concluded success AND said `true`; every non-push event
  runs whatever dedupe says. A skipped tier job shows as **skipped**, not red — and a
  required check treats skipped as passing, which is exactly why a broken dedupe must
  never produce one.
- **Gates.** `ci_workflow_tripwire` rule 19 EXECUTES the probe script from the real
  file under bash against a stubbed `gh` (skip only in the one case above, whatever
  the sibling's run id; never for a PR/dispatch/schedule, the same branch, a red or
  running run, another sha; fail-open on API error) and holds the job's shape, its
  identity across the two files, every other job's `needs`, and the concurrency keys
  (ref / sha / run id). `tier_wiring_tripwire` leg F EVALUATES each tier job's `if:`
  over event × dedupe result × output (closed grammar: an optional
  `!cancelled() && ( … )` around `||`-joined `==`/`!=` comparisons; the implicit
  `success()` is modelled, so an unguarded condition — a failed dedupe skipping the
  tier — is red; `always()`, `success()`, a bare `&&`, negation, functions are red).

## The local gate — CI's verdict before the push

Until 2026-09 every check ran only after the push, on the runner, so the runner was
the debugger (~10 min and a pasted log per iteration): a ratchet red on an
IMPROVEMENT nobody banked, an ubuntu-vs-macOS difference, a baseline nobody
re-recorded. The same verdict now happens on the desk.

### `bun run ci:local` — the tier scripts, as the runner runs them

    bun run ci:local                      # HOST mode: every tier on this machine
    bun run ci:local --hermetic|--db|--instance
    bun run ci:local --docker [--hermetic|--db|--instance]   # IN THE CI IMAGE
        [--ref <rev>]        # that commit exactly (no working-tree overlay)
        [--build]            # build ci/Dockerfile locally, not the locked image
        [--base <branch>]    # behave as a pull_request against <branch>
        [--audit-base <sha>] # the push's `before` (the audit's skip base)
    any mode: [--fail-fast]  # stop after the first red tier; the rest report `not_run`
              [--summary <file.json>]
    bun run ci:local --docker --record-unit-baseline [--ref HEAD]
        [--allow-regression --reason "<why, per file>"]   # RECORD the unit baseline
    bun run ci:local --docker --record-unit-baseline --new <file>[,<file>…]
                                    # record ONLY new test files' floors (--record-new)

It runs `scripts/ci/hermetic.sh`, `db_tier.sh` and `instance_tier.sh` UNCHANGED with an
EMPTY private dir — the runner's condition; every `DEDALO_*` key the tiers need they
compose themselves (`scripts/ci/hosted_env.sh`), which is the property under test.

- **Host mode** borrows only the Postgres CONNECTION from your machine. It catches the
  class where the developer environment supplies something the runner does not
  (measured 2026-08-31: four of twelve defects in one day). It cannot reproduce the
  platform: libc, GNU vs BSD userland, media tools, the browser, the uid. On macOS run
  the instance tier under a short `TMPDIR` (`TMPDIR=/tmp/dd`; the drills bind unix
  sockets and macOS caps the path at 104 bytes).
- **`--docker`** runs the tiers inside the CI image (`ci/Dockerfile`) via
  `ci/compose.yml`: db/instance against the SAME pgvector digest `db.yml` pins, reached
  by its name `postgres` (`DB_HOST=postgres`) as a hosted container job reaches it;
  hermetic with no database at all;
  every tier command as BARE uid 1001, gid 0 — what `--user 1001` makes on GitHub and
  GitLab: no passwd entry, no user name (a named account once hid a GitLab-only red).
  Nothing is read from `../private`. The tree judged is the working tree made into one
  commit on HEAD, or `--ref` exactly; the host repo is mounted read-only. It runs as a
  push to the host's current branch (`GITHUB_REF`, the checkout's branch name), a
  detached HEAD as a push to `master`; `--base` makes it a `pull_request` instead.
- **The image**: the LOCKED build (`ci/image.json`), pulled once and run by digest —
  the bytes GitHub and GitLab run (an Apple-Silicon Mac gets the arm64 half of the same
  multi-arch build). Only while `ci/Dockerfile`/`.bun-version` differ from the lock's
  fingerprint (a definition not yet published) is `dedalo-ci:local` built from
  `ci/Dockerfile` instead, and the run says so; `--build` forces that. The label is
  verified before a tier starts.
- **The audit base** (`--docker`, push shape only): the push's `before`, which
  `hermetic.sh`'s dependency audit diffs against (`DEDALO_CI_AUDIT_BASE`). `--audit-base`
  wins — all zeros or a sha this clone never fetched passes through and the audit RUNS
  (the safe direction); default: merge-base of the tree under test with the host
  branch's `@{upstream}`, none → the audit runs. Never HEAD/HEAD^. Refused together
  with `--base` (a PR diffs against its target).
- **Verdicts.** Each tier is `green`, `red` or `not_run`; stages are parsed from the tier
  scripts' own `== <tier>: …` lines (`green`/`red`/`skipped`; a red stage carries its fix
  hint). `--fail-fast`: once a tier is red the run is red whatever follows, so
  later tiers are not run — REPORTED `not_run` in the summary and the JSON, never
  silently absent (`ci_local_native`). `--summary` writes
  `{mode, tiers:[{tier, verdict, exit_code, duration_s, stages}]}`. Exit: 0 green,
  1 red, 2 could not run (no docker/image/Postgres, bad arguments).

### Recording the unit baseline — in the image, never on a desk (2026-10-02)

`engineering/unit_baseline.json` freezes per-file floors (cases, skips, executed
`expect`s) and the red set — facts about the PLATFORM the tier runs on: the image's
media toolchain, a bare uid, a clone that has no `audits/` and no `../private`. A desk
recording froze the desk, and the runner reported the difference as drift. The difference
runs in BOTH directions — a desk asserts more where it has what a runner lacks (`audits/`,
a GeoIP database, its own configured addons and masters) and less where the image has
what the desk lacks (librsvg: `media_svg_thumb` skips 7 on a Mac, 0 in the image) — so no
desk number is a floor, in either direction. So:

- **The writer refuses off the image.** `UNIT_TIER.recordOnlyInCiImage`: the flagless
  `scripts/unit_baseline.ts` exits 1 BEFORE measuring unless `/etc/dedalo-ci-image`
  (the fingerprint `ci/Dockerfile` writes) equals this checkout's
  `sha256(ci/Dockerfile ++ .bun-version)` (`red_baseline.ts ciImageMarkerMatches`).
  `--record-new` is a write too (a new file's floor is a platform fact like any other)
  and refuses the same way, before measuring; only the READ doors, `--check` and
  `--report`, stay open. `baselines:bank --with-db`'s unit row therefore fails on a desk
  by design. Gate: `suite_assertion_floor_tripwire`.
- **The door is `ci:local --docker --record-unit-baseline`** — the db tier alone, in the
  image, with `db_tier.sh`'s unit stage in RECORD MODE (`DEDALO_CI_UNIT_RECORD_OUT`,
  `DEDALO_CI_UNIT_RECORD_ALLOW`): the same suite build, MariaDB start, installs and
  DB-tripwire stage the check runs after — one preparation, no copy of it to drift. The
  written JSON leaves the container through the ONE writable mount, `/ci-out` (a scratch
  dir, deleted after; the source mounts stay read-only), and is copied into the checkout
  only when the writer did not refuse AND the whole db tier ended GREEN
  (`ci_local.ts recordCopyFault`): a red suite build, DB-tripwire, parity or MariaDB
  stage means the floors were measured on a broken run, so the copy is refused loudly,
  naming the red stages, and the checkout's file stays as it was. Host mode refuses the
  flag; so do `--hermetic`, `--instance`, `--fail-fast`, `--keep`.
  `--ref` must name this checkout's HEAD on a clean working tree (`recordRefFault`): the
  measure is written into THIS tree, so it must be this tree's.
- **A new test file's floor goes through the same door**: `--new <file>[,<file>…]`
  (`DEDALO_CI_UNIT_RECORD_NEW`) runs `unit_baseline.ts --record-new <files>` in the stage
  instead of the full writer — it only ADDS records for files that have none and refuses
  a red, a crash or a vacuous file. Unit-tier paths only (`test/unit|test/integration/…
  .test.ts`, no spaces or shell characters — the list crosses `db_tier.sh`'s word split);
  never beside `--allow-regression`. The working tree (untracked files included) is what
  the container runs, so a new file needs no commit first.
- **A refused write is a list to examine, not to wave through.** The writer prints every
  regression; a real lost assertion is a defect to fix. Only an environment-explained
  difference is accepted: `--allow-regression --reason "<cause, per file>"` (≥ 20
  characters; `--reason` alone is refused). The writer prints what it ACCEPTED, and the
  recorded baseline is committed ON ITS OWN with those reasons in the message.
- **No workflow names any record key** (`ci_workflow_tripwire`); all three are always set
  explicitly by `ci:local` (`ci_local_native` §7 also EXECUTES the pinned stage block
  with `bun`/`cp` stubbed) and pinned off in `tier_wiring`'s drills.

### Fixing a red — reproduce narrow, gate once (2026-10-02)

A full gate is ~15 minutes; it CONFIRMS a fix, it does not find one. On 2026-10-01 ten full
runs (~2.5 h) peeled one red per run. The rule since:

1. **Read every red first.** The pre-push gate runs every tier to its verdict (no
   `--fail-fast`), so one refusal lists them all; the hosts' logs likewise.
2. **Reproduce the ONE failing file or package in the pinned image**, as the host runs it
   (bare uid 1001, the host's checkout shape) — a minute, not fifteen:
   `docker run --rm -v "$PWD/.git":/srcgit:ro <ci/image.json image@digest> bash -c '…clone, setpriv --reuid=1001 --regid=0, bun test <file>'`.
   Fix against that until it is green there.
3. **Then one full gate** (the push), never one per attempt.

**Where the desk still differs from a host — reproduce THERE when the red is about it:**
- *Architecture.* The Mac runs the image's arm64 half, the hosts amd64. For a media /
  native-binary red, or an image change: `DOCKER_DEFAULT_PLATFORM=linux/amd64 bun run
  ci:local --docker …` (emulated, slower; the pinned digest is a multi-arch index).
- *The GitLab checkout.* The docker executor clones as root under `umask 0000` (every file
  0666, every dir 0777); `.gitlab-ci.yml` works on a copy made under `umask 022`, the
  shape GitHub's checkout and ci:local's clone have. A gate that judges who can write a
  file reds on the raw tree (2026-10-01: site_builder confinement, 99 reds).
- *The unit stage's floors.* They are the IMAGE's (a desk asserts more where it has
  `audits/` or `../private`, less where it lacks librsvg), so reproduce a unit-floor red in
  the image: `bun run ci:local --docker --db`. The stage is blocking on the host and on the
  desk alike (no skip since 2026-10-02); improvement drift is re-RECORDED in the image
  (`--record-unit-baseline`, above), never banked on the desk.

### `bun run baselines:bank` — improvements banked mechanically

Most ratchets are red in BOTH directions: growth is a regression, and a count that FELL
without being re-frozen is a stale entry that would let debt climb back. That second
rule is right — and it was the largest single cause of red CI. The bank runs the
improvement direction mechanically and keeps refusing the other exactly as loudly:

- every registered ratchet prints one verdict under `--check --json`
  (`scripts/lib/ratchet_check.ts`: `{ratchet, baselines, improvements, regressions}`);
- improvement-only → the ratchet's OWN flagless writer runs (which independently
  refuses growth — two locks), then the check must come back clean;
- any regression → nothing is written for that ratchet, exit 1, and the deliberate
  path is named (`--allow-regression --reason "…"` where that writer takes one). The
  bank has NO such flag: accepting debt is never automatic.
- exit 0 no drift · 3 improvements written (commit them) · 1 regression / error.
- `--with-db` also measures the unit + parity red baselines; `--with-network` the
  advisory baseline (removals only — its home is the nightly). The registry is TOTAL:
  `baseline_registry_tripwire` discovers every baseline a gate reads and fails on one
  missing from the bank's `REGISTRY` (unbankable ones carry a reason).

### The push policy — per remote (2026-10-10)

The full gate (hermetic + db + instance, ~46 min with `--docker`) on every push was not
viable for day-to-day work. So the gate is chosen by WHERE the push goes:

| Remote (classified by URL, never by name) | Desk gate | Where db/instance run |
|---|---|---|
| **internal** — `gitdedalo`, the day-to-day remote | hermetic only (~3 min) | NIGHTLY on GitHub against gitdedalo/master (`nightly.yml` `full_gate`), red → the `ci-nightly` issue with the sha |
| **public** — `github` (dedalia-org/dedalo), `gitlab` (dedalia/dedalo), synced deliberately | FULL (minus the `HERMETIC_ONLY_PATHS` allow-list), the per-sha green memory as before | at the desk, and again by ci.yml/db.yml on the push |
| **unknown** — anything else (a fork, a local path, an ssh alias) | same as public | — |
| any remote, a **release tag** `refs/tags/vX.Y.Z` | a FULL green for the tag's commit (gated full now when the tag names HEAD; refused otherwise) | image-release.yml `plan` re-checks GitHub's own verdict |

The hook normalizes the URL (scheme, user, default port, trailing `/` and `.git` dropped,
host lowercased; scp-like `user@host:path` = `host/path`) and compares its `git
hash-object` identity with `INTERNAL_REMOTE_IDS` — the internal host is named nowhere in
the repository, and a renamed remote cannot change its class. `sh scripts/hooks/pre-push
--remote-id <url>` prints a URL's identity (register a new internal URL by adding it);
`--remote-class <url>` prints its class. `bun run push --internal` lands both branches on
gitdedalo only (hermetic); `bun run push` lands everywhere (full). `DEDALO_PREPUSH=full`
forces the full gate on any push. A **release** needs a public push first (or
`DEDALO_PREPUSH=full`): a hermetic green never qualifies a commit for a tag.

### `scripts/hooks/pre-push` — the gate git runs

Installed by `bun install` (`package.json` `prepare` sets `core.hooksPath=scripts/hooks`
in a developer checkout; a no-op in CI, the image and a release tree). The header of
`scripts/hooks/pre-push` is the full contract; gate: `pre_push_gate_native` (by outcome,
against local bare remotes with stubbed bank/ci:local). For the pushed refs it:

0. requires that what is pushed IS the checkout (every pushed ref with new commits
   points at HEAD; no tracked file differs from HEAD). Untracked files are only noted:
   neither the bank nor the tiers see them;
1. runs `baselines:bank -- --ephemeral` in a throwaway `git worktree` of the pushed
   commit (the checkout's `node_modules` — real or symlinked, as a linked worktree's
   is — lent in by symlink). Exit 3 commits the banked files there as
   `chore(baselines): bank improvements`, fast-forwards the checkout onto it
   (`--ff-only`: never over a local untracked file) and stops the push (git cannot add
   a commit to a push in progress; re-run it). Exit 1 blocks, reported as ERROR (a
   check that could not run — usually the environment) when the bank printed one,
   else as REGRESSED with the `--allow-regression --reason` path;
2. runs `ci:local --docker --hermetic --ref <sha> --audit-base <base>
   --summary <file>` — blocks on red, listing each red stage `✗` with its fix hint; every tier runs to its verdict (no `--fail-fast`, 2026-10-02), so ONE
   refused push names every red tier instead of one per 15-minute run;
3. adds `--db --instance` unless every file the pushed range touches (renames count
   both paths; a merge is diffed against its first parent; >500 new commits or a URL
   remote count as everything) is in its `HERMETIC_ONLY_PATHS` allow-list (anything
   unlisted selects the full gate) or the remote is INTERNAL (then never — the nightly
   `full_gate` runs them), or always with `DEDALO_PREPUSH=full`. The db tier
   runs WHOLE, its unit stage included: that stage is blocking on the runner, so the
   full gate costs ~5 min more than it did while the desk skipped it (2026-10-02) —
   the price of a desk verdict that predicts the runner's.

**The audit base is the remote's sha**, per ref as git hands it: one gated remote sha
this clone has → that sha; a new branch (`000…`), an unfetched remote tip, or gated refs
whose remote tips differ → FORCED (`--audit-base 000…`, the audit runs, as GitHub runs
it for a new branch). Never ci:local's `@{upstream}` fallback, which is another remote's
state.

**The repository is discovered, never inherited**: git exports `GIT_DIR` into a hook run
from a LINKED worktree, and a caller may export its own; once the pushing checkout is
resolved every `git rev-parse --local-env-vars` variable is unset, so the bank worktree's
diff/add/commit act on the bank worktree, never on the pushing branch. A checkout that
cannot then rediscover the same git dir is refused.

A GREEN verdict is remembered in `$(git rev-parse --git-path dedalo-prepush-green)` as
`<sha> <level> audit:<forced|base>` (last 50): reused only for the same sha, a covering
level (full answers hermetic) and the SAME audit base — or a forced audit, which answers
any base — and only on a clean tree. A red is re-measured every time. So a sha pushed to
several remotes (or two refs in one push) is gated once — an internal (hermetic) green
never answers for a public push. **Docker is required** — there is no silent skip; the
visible bypass is `git push --no-verify` (on a public mirror CI still runs; on the
internal remote NOTHING runs until the nightly `full_gate` — the refusal says which). Exit:
0 push proceeds · 1 red / refused · 3 improvements banked, re-run the push.

### `bun run push` — publish both branches, gated once

Aligns `v7` and `master` on one commit (fast-forward either way; DIVERGED branches are
refused — a merge is a decision, not a push step), runs the pre-push gate ONCE with the
stdin git would hand it (remote tips from `git ls-remote`), re-aligns and re-gates by
itself when the bank committed improvements (exit 3), then pushes both branches to every
remote (`gitdedalo`, `github`, `gitlab`) with `--no-verify` — the gate already ran on
exactly these shas. `--internal` restricts it to `gitdedalo` (the day-to-day landing,
hermetic). `--dry-run` prints the plan. No flag skips the gate: the hook picks each
remote's level from its URL.

### The banking flow, end to end

    edit → commit → bun run push --internal  (day to day: hermetic; nightly runs db/instance)
                  | bun run push             (publish: full gate)
      → pre-push: baselines:bank (worktree of the pushed sha)
          improvement-only → commit "chore(baselines): bank improvements" → exit 3
          → push.ts re-aligns + re-gates (bounded)
          regression → exit 1 (nothing written; the reasoned path is named)
      → ci:local --docker (hermetic; + db/instance unless internal or provably hermetic-only)
      → git push --no-verify to every remote
      → GitHub: ci/db on master (runs) + on v7 (queues, then dedupe → skipped)

## Tiers

- **Hermetic** (`scripts/ci/hermetic.sh` — GitHub AND GitLab call it, so the platforms
  cannot drift; no secrets, no DB): `bun install`, `bunx tsc --noEmit`, `bun run lint`,
  `bun run lint:browser` (the shrink-only budget over the browser trees `biome.jsonc`
  excludes), every DB-less tripwire (the list is the script's; rule 3c of
  `ci_workflow_tripwire` requires every tripwire in `scripts/verify.ts` to be wired here
  or assigned to the DB tier with a reason in `NOT_HERMETIC` — stale rows red both
  ways), the crap-ledger append-only check against a FETCHED reference, the
  dependency-audit ratchet (only when the push changed its inputs — see Time-based
  checks), and the isolated daemon packages, concurrently (`site_builder`,
  `server_api/v2`, `host_agent`: install + tsc + test + coverage). The set is DERIVED —
  every locked package but the root that has its own `bunfig.toml` — and
  `ci_workflow_tripwire` rules 11/11b/15 hold hermetic.sh, the coverage split and
  `.github/dependabot.yml` to it. Each also has a path-triggered stage in
  `scripts/verify.ts` (`site_builder`, `host_agent`). **Runner requirement** of the
  `host_agent` suite: the `openssl` CLI (`tests/boot_mtls.test.ts` issues a scratch CA)
  and sudo's own sudoers parser (`tests/provision_render_grants.test.ts` checks the
  rendered rule with `cvtsudoers` from the `sudo` package when present — it parses
  without a passwd entry, so it works as the job's bare uid 1001 — else `visudo -cf -`,
  which is what macOS ships). The CI image ships both (`ci/Dockerfile`; sudo is never
  configured nor invoked there, its setuid bit is stripped via `dpkg-statoverride`, and the binary is diverted to `/usr/bin/sudo.distrib`: `/usr/bin/sudo` is the exec seam's dispatcher — the Instance bullet). Missing = RED, never a skip. Required config keys get harmless stubs;
  `DB_PORT` points at a closed port so any accidental DB touch fails loudly. No
  hermetic gate starts a server: `suite_mariadb_target_native` (which drives the lane's
  own `mariadbd`) is a DB-tier gate (`NOT_HERMETIC` row + `DB_TIER_TRIPWIRES`).
- **DB** (`db` job, `scripts/ci/db_tier.sh`): builds the suite database from bytes
  vendored in the repo (`scripts/test_db_setup.ts`; the `test` TLD ontology, the
  hierarchy copies; it stamps `dedalo_test_marker`), then the DB-backed tripwires
  (`DB_TIER_TRIPWIRES` = `NOT_HERMETIC` exactly), the unit tier (BLOCKING since
  2026-10-02 vs `engineering/unit_baseline.json`, recorded in the image), the parity tier, and LAST the MariaDB tier
  (BLOCKING — `scripts/ci/mariadb_tier.ts`, see *Suite MariaDB target* below). Last
  because its leg 1b re-runs ~170 Postgres-writing unit and parity files in one extra
  batch: before parity, that extra pass would move the suite database away from the state
  the unit and parity baselines were recorded in (one unit pass, then parity). The order
  is gated, not described: tier_wiring leg K executes every root that runs the stage
  (commands stubbed) and reds any command recorded after it but the EXIT trap's stop
  (mutation H1 — the stage moved ahead of the tripwires — left every other gate green). Before the tripwires it
  starts the suite MariaDB target (`scripts/ci/suite_mariadb.ts start`, stopped by an
  EXIT trap that tier_wiring leg J EXECUTES: a later `trap … EXIT` replacing it, or one
  set after the start, is red) and installs `publication/server_api/v2` for the API
  smoke. The service image is
  `pgvector/pgvector` (the RAG store needs `CREATE EXTENSION vector`), digest-pinned.
  Measured build cost (2026-08-25, warm Mac): ~15 min end to end, ~7.65 GB database,
  gates ~6 s — dominated by the per-row triggers deriving `matrix_relation_index` and
  `matrix_string_search`; that is also why a `pg_dump` cache is not a free win
  (re-fired triggers + duplicated derived rows).
- **Instance** (`instance` job, `scripts/ci/instance_tier.sh`): its own FRESH suite
  database (the unit stage pollutes the fixture the client baseline was measured on),
  then the browser client suite (`scripts/ci/client_gate.sh` → `bun run test:client`:
  own server on the suite DB, real login, pinned diffusion domain + projects fixture,
  Mocha in the system browser), `bun run test:tools:phone` (every tool at 360×740, same suite
  server door) and `bun run test:update` / `test:update:dev` (a real
  master builds and serves a release; a supervised consumer copy installs it across the
  planned-death restart). The checkout is `fetch-depth: 0` (the drills `git clone` it);
  the release commit is cut with `git checkout -B` (a PR checkout is a detached HEAD).
  Drill config comes from `scripts/lib/operator_config.ts` (catalog keys of the process
  env; `update_drill_config_tripwire`).
  Then `bun run test:media:pubhost` (`scripts/media_publication_host_drill.ts`, no
  database): the publication-host include rendered by the engine's builders, driven
  through the MEDIA_PROTECTION §9 curl matrix on a REAL Apache and a REAL nginx bound to
  127.0.0.1 as the job's uid — rewrite phase order, alias + captures and location
  precedence are engine properties the `media_protection_tripwire` regex lockstep cannot
  see. **Runner requirement**: Apache 2.4 + `apxs` (the drill resolves the binary through
  `apxs -q SBINDIR`/`TARGET` — `apache2` on Debian, `httpd` on Homebrew/RHEL — and the
  modules through `LIBEXECDIR`; needs mod_rewrite, mod_alias, mod_headers, mod_mime,
  mod_authz_core, an MPM) and nginx built `--with-http_mp4_module`. The CI image ships
  `apache2 apache2-dev nginx` (Debian's nginx carries the mp4 module). A missing binary
  is RED, never a skip — the suite MariaDB's policy (the drill exits 1 naming it). Locally
  (macOS): `brew install httpd nginx`.
  Then `bun run test:pubhost:agent` (`scripts/publication_host_agent_drill.ts`): the
  publication-host AGENT (`publication/host_agent`) booted for real over mTLS
  (openssl-issued private CA; no client cert, a rogue-CA client cert and a wrong server CA
  are refused; a missing client CA refuses to BOOT, and so does `NODE_ENV=production` on
  the drill's unprovisioned tree — the audit preflight), on nginx the HOST-WIDE map
  (`NGINX_MAP_MODE=conf_d`, never a hand-written map: the main conf includes the provisioned
  zero-match glob of `<HOST_BASE>/nginx_map/`) pushed through `rules.map` — the agent's
  contribution, then `systemctl start dedalo-pubhost-map.service`, which the stand-in answers
  with the agent's OWN root renderer (`host_map_main.ts` `runHostMap`, the kit's
  `renderHostMapDriver`: the scene's lock and user-mode nginx are its two named seams) — the
  live map byte-equal to `buildNginxMap()`, a re-push unchanged; then `rules.apply` of the engine's
  render into the same user-mode Apache and nginx (published 200 / unpublished 404 through
  the server; an include the allowlist passes but configtest fails restores the previous
  one and never reloads), and REAL Publication API v2 releases (built from
  `publication/server_api/v2`, production `node_modules` installed into scratch with
  `--linker hoisted` — network) installed, refused when their scratch boot fails, rolled
  back and re-pointed, over the suite MariaDB (the tier starts it for this stage; its EXIT
  trap stops it). The agent's exec module runs UNMODIFIED and spawns `/usr/bin/sudo` and
  `/usr/bin/systemctl` by ABSOLUTE path, so the only seam is a stand-in AT those paths: in
  the CI image both are the **exec seam**'s dispatchers (`ci/Dockerfile`; the real sudo is
  diverted, setuid stripped), which run the stand-ins the drill writes into
  `/opt/dedalo-ci/exec-seam/`; they accept only exec.ts's closed argv and log every call,
  and the drill asserts the exact call sequence. The agent runs with `NODE_ENV=test`
  stated in its env file (the job's uid 1001 cannot make the root-owned, `chattr +a`
  audit trail production demands — the drill's header). Its COPY pass (phase 5) boots a
  second agent with `MEDIA_MODE=copy` over an empty copy root and drives the ENGINE side in
  child processes (`scripts/lib/publication_host_copy_engine.ts`: the suite database, a
  scratch private dir and a scratch WORK media root, each marker-guarded; no DB row is
  written): publish → reconcile → exactly the public files + the `pub/` marker on the
  agent, served 200; an unpublish through the real hook (the started copy worker) with the
  agent's deletes made to fail → the marker goes first (404) and the deletion stays pending
  until a reconcile verifies it; agent down during an unpublish → the marker's withdrawal
  pending (the gate still serves: no channel), completed when it returns. **Runner
  requirement**: the media drill's plus openssl, git, bash, MariaDB, the exec seam and the
  suite database (the tier builds it first) — all in the CI image, so the drill runs ONLY
  there: anywhere else it is RED, naming the seam, and never touches a real
  sudo/systemctl. Locally: `bun run ci:local --docker --instance`.
  LAST, `bun run test:pubhost:engine` (`scripts/publication_host_engine_drill.ts`): the
  ENGINE side of the publication host against that same real agent (one scene, shared:
  `scripts/lib/publication_host_agent_scene.ts`) — a real engine server on the suite
  database with its own scratch private dir, the pairing CLI
  (`scripts/publication_host_pair.ts`, run as the private dir's owner: a left placeholder,
  a contradicting fingerprint and a token the live agent does not hold are refused with
  exit 3 and nothing written; a pairing writes the 0600 registry and the 0700/0600
  secrets), and the `publication_hosts` widget over the wire: `apply_rules` into user-mode
  Apache (paired over mTLS) and nginx (paired over the unix socket) with published 200 /
  unpublished 404 through the server, `probe`, `rollback_api` of real v2 releases, and
  on nginx the engine's own map push first (`apply_rules`: `systemctl start
  dedalo-pubhost-map.service`, then configtest + reload; the row's `nginx_map` check red before,
  ok after, the live host map byte-equal to `buildNginxMap()`), and
  the refusals (a non-root global admin: `perm.denied` on every action; a re-provisioned
  agent: `pairing_mismatch` until the CLI re-pairs; a frozen or dead agent: typed
  `timeout|unreachable` with the registry untouched; a corrupt registry:
  `registry_invalid` with `hosts: null`, never an empty list). Every engine answer
  (get_value and every action, error states included) and every pair-CLI output (any exit
  code), plus the registry file, is scanned centrally for the tokens (the refused foreign
  one too), the client key and any PEM block. A refused action's "nothing applied" is
  made observable first (expected rules moved off the live include). Its first pass also
  runs the phase-4 LOCKSTEP rows: the live engine (no install stamp) refuses `push_apis`;
  a scratch INSTALLED tree of the checkout (install stamp + extract-time publication
  manifest) runs the engine's own reconciler (`scripts/publication_host_lockstep_driver.ts`)
  against the paired agent — a drifted file (named) and a foreign stamp are refused with
  nothing sent; the confirm hook, driven with server.ts's own callback, answers
  `skipped_smoke_boot` in a smoke boot and pushes nothing, and after a swap starts the
  push: v2 then v1, engine-built `node_modules`, a real `php -l` per v1 file through the
  stand-in; the agent serves `<version>_<digest7>`, a re-run is `none`, a second tree
  installs and the restore back is `promote_existing`. It reuses the agent drill's suite
  MariaDB, agent dependencies and exec seam. **Runner requirement**: the agent drill's plus
  php-cli, network for the engine's v2 dependency builds, and the suite database (the tier
  builds it first). Missing = RED. Runs ONLY in the CI image, like the agent drill:
  `bun run ci:local --docker --instance`.
  Then `bun run test:pubhost:probe` (`scripts/publication_host_probe_drill.ts`, no
  database): the publication-host public-URL probe (`engineering/PUBLICATION_HOST_SPEC.md`
  §7) driven against a REAL Apache and a REAL nginx serving the engine-rendered include.
  Its engine half runs in a child process whose `DEDALO_PRIVATE_DIR` and marked
  `DEDALO_TEST_MEDIA_ROOT` are the drill's own scratch dirs. The guard is not bypassed:
  the drill passes `probePublicGate` only `fetchGuardedText`'s two seams, as that call's
  optional `deps` argument (nothing process-wide): a resolver for its own names and a
  forwarder that accepts only requests pinned to the vetted public address. So the
  private-address refusal is proven in the same run. Same runner requirement as the media
  drill; a missing binary is RED.
- **Local-only drills of the guided install** (`provision init`,
  `engineering/PUBLICATION_HOST_SPEC.md` §9.11; both rows of `LOCAL_ONLY_SCRIPTS` in
  `test/unit/tier_wiring_tripwire.test.ts`, with these reasons):
  - `bun run test:pubhost:init` (`scripts/publication_host_init_drill.ts`, Debian). It must
    create accounts, write `/etc`, run systemd, polkit, a real FPM and web-server reload and
    `kill -9` a root process mid-change, so it runs as root in a disposable PRIVILEGED
    container with systemd as PID 1, built FROM the locked CI image (its Debian trixie,
    apache2, nginx, php-fpm) plus `systemd-sysv`, `polkitd`, `sudo`, `e2fsprogs`, `logrotate`
    and the image's own Bun; it runs a stand-in `dedalo-ts.service` (the one-machine work
    engine init takes `engine_group` from) and makes `/` a shared mount after boot, as systemd
    does on a real host (systemd 257's `LoadCredential=` needs it). **Runner requirement:** a machine with a Docker (or compatible) daemon that may
    start `--privileged` containers with a writable cgroup2 (`--cgroupns=host`), network for
    the image build. A hosted tier cannot: every tier job already runs INSIDE the CI image as
    a `container:` with no daemon socket and no privilege, and mounting one would hand a
    pull request root on the runner. Missing docker or a refused `--privileged` is RED (exit
    2), never a skip. Run it before landing any change to `deploy/install.sh`, the
    `provision init` modules, the renderers, `exec.ts`, `lock.ts`/`flock.ts` or the docs'
    guided-install commands.
  - `bun run test:pubhost:init:el` (same script, `--family el --in-place`), run as root ON a
    disposable RHEL/Rocky/Alma 9 or 10 VM with SELinux enforcing, refusing unless
    `/etc/dedalo_init_drill_host` exists (created by hand on the VM, so the drill can never
    run on a real install) and `getenforce` prints `Enforcing`. No CI runner has an SELinux
    kernel, and a container cannot enforce SELinux, so it proves what no hosted tier can.
    `--record` (after a green run) writes the EL drill record under `engineering/` (inputs
    digest, hosts, measured types and floors) and `--capture <dir>` the
    real EL discovery outputs that replace the typed EL fixtures. The record's ratchet — a
    root gate that recomputes the inputs digest over the EL-relevant sources and is red when
    it differs — lands with the first record, so from then on every EL-relevant change is
    red until the EL drill runs again.
- **Self-hosted** (private mirror's Mac): a duplicate of the hosted tiers. Everything it
  runs is twinned hosted — including the `test/integration/**` MariaDB legs, which ran
  nowhere else until PUB-05 moved them onto the suite's own MariaDB server and into the
  DB tier's blocking MariaDB stage.

### Suite MariaDB target (PUB-05, 2026-09-30)

MariaDB is the fourth suite-owned surface, beside the suite Postgres database
(`dedalo_test_marker`), the media root (`.dedalo_test_media`) and the vector database
(`dedalo_test_rag_marker`). Before it, a test process reached the INSTALLATION's MariaDB
(`DEDALO_DIFFUSION_DB_SOCKET` from `../private/.env`): a developer run created and
dropped tables in a real publication database, and a runner without that socket skipped
every live leg GREEN.

- **Per lane.** The lane (`testDatabaseName()`) keys a root
  `../private/test_mariadb/<suite db>/` (marked `.dedalo_test_mariadb`; datadir, pid,
  logs, `acquisitions.ndjson`) and a socket `/tmp/dedalo_tmdb_<sha256(root)[:12]>/s`
  (dir 0700 — macOS caps a socket path at 104 bytes). The server runs
  `--skip-networking`, so the filesystem is the access control.
- **Armed by a preload.** `test/preload/suite_mariadb.ts` sets `DEDALO_DIFFUSION_DB_*`
  (the lane socket, the suite user, a blank host/port) in EVERY `bun test` process,
  unconditionally and without I/O. Nothing exports them in CI.
- **Acquired, never skipped.** A MariaDB gate calls
  `requireSuiteMariadb(import.meta.path, databases)` in `beforeAll`
  (`test/helpers/suite_mariadb.ts`): the names must be `database` nodes of the
  registered situations (zzd, zzdif) — an installation's database is refused by name;
  the process must be armed; the server is installed/started/provisioned; each
  database's marker row, read through the engine's `getTargetPool`, must name this
  lane. It throws otherwise, and appends an acquisition row when it does not.
- **Grants = production posture.** The diffusion user has
  `SELECT,INSERT,UPDATE,DELETE,CREATE,ALTER,DROP,INDEX` per target database, no global
  privilege, no CREATE DATABASE, and SELECT only on `dedalo_test_mariadb_marker.targets`
  (so the marker cannot be forged). Every ensure self-checks errno 1044 / 1142. Two
  control databases (`zzd_unmarked_control`, `zzd_foreign_marker_control`) are granted
  but refused by the classifier. A third, `zzd_granted_absent`, is granted (no CREATE)
  and never created: the one name that answers errno 1049, since every ungranted
  absent name answers 1044 first. The engine's 1049 branch is gated on it.
- **The stage.** `scripts/ci/mariadb_tier.ts` runs `test/integration/**` (minus the
  shrink-only `INSTALL_BOUND_EXEMPT`) plus every `test/unit` file that imports the
  helper at runtime (resolved by Bun's transpiler, not a regex), EACH FILE IN ITS OWN
  `bun test`, and requires per file: reported, >0 cases, 0 skipped, 0 failed, >0
  assertions, an acquisition row; and that the rows the SUITE USER changed during THAT
  file's run (`information_schema.USER_STATISTICS`, `--userstat=1`: inserted, deleted,
  updated) match its declared `ROW_CONTRACT` row — every counter it declares rises, a
  declared reader moves none. Per file because a set-wide sum rose whenever the
  helper's own gate (which writes rows to prove the measure) passed, whatever the
  product gates wrote. Not global `Com_*`: those count statements dispatched by anyone,
  including the helper's root provisioning and its refused self-check insert
  (measured). The measure is CALIBRATED live on every run: a planted file that only
  acquires must move it by exactly 0, one that inserts, updates and deletes a row by
  more than 0. A measure that cannot be read is a structured fault in the same report.
- **The no-contact population.** Every `test/unit` and `test/parity` file (the preload
  arms both) OUTSIDE the set whose runtime
  import closure reaches `src/diffusion/targets/mariadb/db.ts` (the module that opens
  pools) is derived — transitively, through `test/helpers`, `src` and `tools`, static and
  literal dynamic imports, crossing the reasoned `SEAM_EDGES` of the product modules
  that import by a computed path (the tool loader, the boot warm-up; an unlisted one is
  red) — and RUN in one armed batch with the suite server up (173 files: 136 unit + 37
  parity, measured 2026-09-30; parity replays the frozen fixtures, credless). The suite user's CONTACTS (`TOTAL_CONNECTIONS` + `DENIED_CONNECTIONS`)
  must not move; a non-zero batch is re-run file by file and each file that opened a
  pool without acquiring is named with its import chain; a contact no single file
  reproduces reds the batch itself (fail-closed: an order-dependent or late contact is
  bisected, never passed). Every population file must RUN ≥1 case — reported, not all
  skipped (bun's `tests` counts skipped cases), and ≥1 assertion executed (a file whose
  `beforeAll` threw reports one failed `(unnamed)` case and 0 assertions: it never ran) —
  unless a reasoned, shrink-only `NO_CONTACT_IDLE` row (the three live-PHP-oracle parity
  differentials) says why it runs nothing by construction; a row whose file runs, or left
  the population, is red. Partial skips are printed, not judged; pass/fail is the unit /
  parity tier's verdict. The contact measure has its own
  live calibration: a file that imports the pool module and opens nothing moves it by
  exactly 0; one that opens a pool unacquired (after proving it is armed at a live
  socket) by more than 0 — which also proves the child is armed. Not closed here: a
  contact made only in a situation the suite database does not hold, and a test-side
  computed import.
- **Bun's TCP fallback.** Measured: the `mariadb` adapter given a socket path that does
  not exist connects to `localhost:3306` instead. The helper checks the socket exists
  before any pool opens and its CLI forces `--protocol=socket`, so a gate that acquires
  through `requireSuiteMariadb` never meets the fallback. Arming does NOT close it for
  other `getTargetPool` callers while the lane server is down; only the engine seam
  PUB-05b (`buildTargetOptions` refusing a socket that is not a unix socket;
  `DEDALO_TEST_DIFFUSION_DB_SOCKET`) does.
- **Lifecycle.** The server is detached and outlives the `bun test` that started it.
  `scripts/ci/suite_mariadb.ts stop` ends it; `sweep` also deletes the lane root (only a
  root carrying `.dedalo_test_mariadb`). Ensure/stop are serialized per lane by a
  kernel-released `flock` on `<root>/.lock`, so a killed run leaves no stale lock; a
  stop issued while another process holds it waits (`suite_mariadb_target_native`
  leg j). A sweep stops the server AND renames the root off its path (same directory,
  atomic) under that lock, then deletes it marker-last: the lane path is marked until
  the instant it is absent (leg k), a process queued on the lock is told the lane was
  swept instead of holding a lock over it — every flock is re-validated against the
  current `.lock` inode (leg l) — and a killed sweep's `.<lane>.swept-…` leftover is
  collected by the next one (leg m). Every client call and the installer have a
  deadline, so a hung one cannot hold the lane lock (leg n); a waiter's lock wait is
  DERIVED from those deadlines (the holder's worst ensure plus a margin), so it reports
  the holder's real failure, never "lock held" (leg q). A start that misses its deadline
  stops the server it spawned (leg o); a server that ANSWERS with a server-side error
  (1040, 1045…) is alive and is surfaced, never restarted (leg p). The lane root is
  claimed atomically — built marked under `.<lane>.claim-<pid>-<n>`, then renamed onto
  its path — and a dead claimer's temp is collected by the next sweep (leg r). Before it
installs, starts on or sweeps a datadir, the holder FENCES it: every process whose command
line names that datadir is stopped, not only the pid-file server — an installer orphaned
by a killed holder, a stray server (leg t) — and a stop returns only once the process is
gone, SIGKILL included, or throws naming the survivor (leg s).
  `sweepSuiteMariadbLanes(match)` (`test/helpers/suite_mariadb_lanes.ts`) sweeps every
  marked lane root a matcher names — the shard runner's teardown for its
  `<template>__shard<N>` lanes: `sweepShardClones` (`scripts/lib/test_shard_db.ts`) calls
  it at the entry sweep, the exit sweep and `--sweep`. An unmarked lane root at a shard
  name is REFUSED and a marked one whose sweep fails is a FAILURE with its real error —
  each refuses the run and makes `--sweep` exit non-zero, through ONE pure verdict,
  `sweepBlockers` (`shard_mariadb_sweep_native`, a DB-tier tripwire, which sweeps only a
  probe template it built, never the lane's own).

Locally (needs `mariadbd`, `mariadb-install-db`, `mariadb`; without them the MariaDB
gates are RED, not skipped):

```sh
export DEDALO_TEST_DATABASE=<app db>_test_l3        # the lane key
bun run scripts/ci/suite_mariadb.ts start           # optional: a gate's beforeAll starts it too
bun test --timeout=30000 test/integration/diffusion_mariadb.test.ts
bun run scripts/ci/mariadb_tier.ts                  # the blocking stage, as CI runs it
bun run scripts/ci/suite_mariadb.ts stop            # the server outlives bun test until stopped
```

Every tier root keeps the independent-stage accumulator: each STAGE line aborts bare
under `set -e` or raises `tier_status` (leg H); a `|| true` on a stage is red, with no
exemption (the unit tier's `ADVISORY_STAGES` row went when it turned blocking,
2026-10-02). A red-baseline check that exits 1 fails its root while every later stage
still runs (leg L, executed with stubbed commands). A root that starts the suite MariaDB must stop it on exit (leg J, executed with
stubbed commands: to the end, and SIGTERMed at the first start), and a root that runs
the MariaDB stage runs it LAST (leg K, the same stubbed run).

### Time-based checks — the nightly (2026-09-26)

Three inputs of the dependency-audit ratchet change with the CALENDAR, not the commit:
the `bun audit` registry, the GitHub advisory feed, and the vendored trees' review
windows / acceptance expiries (`vendor/vendor_manifest.json`). On the push gate they
made the same sha green on Monday and red on Tuesday, landing on whoever pushed next.
So `hermetic.sh` runs `audit.ts --changed-since <base>` (only when a lockfile, a
`package.json`, `vendor/` or the audit's inputs changed — the base is the push's
`before`, covering EVERY pushed commit; rule 18 executes that resolution) and runs the
vendor tripwire's tree-only legs (`DEDALO_VENDOR_DATED_CHECKS=0`). `nightly.yml` runs
the whole thing daily, forced, network-required, calendar ON; its red is the run's red,
and the `report` job — the ONE job holding `issues: write`, running no repository code
— keeps a single `ci-nightly` issue: opened/updated when red or when a window closes
within 21 days (warning), closed when green. Rule 17 holds the pair: a deferral with no
nightly home that can fail and report is red. The ratchet itself (DEC-12) is unchanged.

### The nightly full gate — gitdedalo/master on GitHub (2026-10-10)

The internal remote has no CI of its own, and its pushes are gated hermetic-only at the
desk. `nightly.yml`'s `full_gate` job closes that: every night (and on `gh workflow run
nightly.yml`) it fetches `master` from gitdedalo over SSH, checks that sha out (so ITS
`.bun-version`, `ci:local` and image pin are used) and runs exactly the public push's
gate — `bun run ci:local --docker --hermetic --db --instance --ref <sha> --audit-base
<sha>` (the base = the sha makes the push gate's audit skip: `check` runs the audit,
forced). Its rc is the run's verdict; `report` puts a red in the `ci-nightly` issue with
the gitdedalo sha, each red stage and the reproduce command. Rule 20 of
`ci_workflow_tripwire` pairs the hook's downgrade with this job (gate flags, rc carried,
no `if:` / continue-on-error, report needs it, pinned host key) and EXECUTES the fetch
step with stubbed git.

**Without its secrets it skips LOUDLY**: an error annotation on the run and a WARNING in
the `ci-nightly` issue naming the missing secrets — never a quiet green. A refused fetch
(key revoked, host key changed, host down) is RED.

**Posture.** The job is the ONE holder of the `GITDEDALO_*` secrets (rule 11's second
carve-out), bound to the `gitdedalo-nightly` environment; nightly.yml has no push / PR /
workflow_run trigger. The key reaches only the fetch step (written under
`$RUNNER_TEMP`, removed on exit; ssh with `-F /dev/null`, `IdentitiesOnly`,
`StrictHostKeyChecking=yes`, the secret as the ONLY known_hosts, never `ssh-keyscan`).
The checkout is made with `persist-credentials: false`. **The job log is public** (the
repository is): it shows gitdedalo's sha, commit subjects the tiers print and test names
— never the secrets (masked) or the host (a secret too).

**Known gaps.** It runs the three tiers SERIALLY in one hosted job (~46 min on a Mac;
the first green run's wall clock should re-pin `timeout-minutes: 300`). A hermetic-only
commit on gitdedalo is unverified at the db/instance level until the next night (or a
dispatch). The hosted runner must reach the gitdedalo SSH port from the internet (GitHub
Actions ranges: `gh api meta --jq .actions`); if that port is firewalled, the fetch is red.

**Runbook — the read-only deploy key** (owner, once; rotate the same way):

1. On a trusted machine, make a dedicated key (no passphrase — the runner cannot type one):

       ssh-keygen -t ed25519 -N '' -C 'dedalia-org/dedalo nightly full gate (read-only)' -f gitdedalo_nightly_ro

2. On the gitdedalo host, as the account that owns the bare repository, append the
   PUBLIC half to `~/.ssh/authorized_keys`, restricted to fetching that one repository —
   `restrict` drops pty/forwarding/agent/rc, and the forced command runs
   `git-upload-pack` (read) whatever the client asks, so a push (`git-receive-pack`) or a
   shell is impossible with this key:

       restrict,command="git-upload-pack '<absolute path of the bare repository>'" ssh-ed25519 AAAA… dedalia-org/dedalo nightly full gate (read-only)

   Check from your desk: `GIT_SSH_COMMAND='ssh -i gitdedalo_nightly_ro -o IdentitiesOnly=yes' git ls-remote <gitdedalo url> master`
   answers; `… ssh -i gitdedalo_nightly_ro -p <port> <user>@<host> id` does NOT give a shell.

3. The PINNED host key: on the host, `cat /etc/ssh/ssh_host_ed25519_key.pub`, written as
   one known_hosts line (a non-22 port takes the bracket form):

       [<host>]:<port> ssh-ed25519 AAAA…

   Read it ON the host (or from a known_hosts entry you already verified:
   `ssh-keygen -F '[<host>]:<port>'`), and compare fingerprints
   (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`). Never `ssh-keyscan` — that is
   trust-on-first-use, the thing pinning prevents.

4. On GitHub (dedalia-org/dedalo → Settings → Environments): create **`gitdedalo-nightly`**,
   *Deployment branches and tags* = selected branch **`master`** (the default branch —
   schedules run from it; no other ref can read the secrets), NO required reviewers (they
   would stall every night). Add its three environment secrets:

       gh secret set GITDEDALO_DEPLOY_KEY  --env gitdedalo-nightly < gitdedalo_nightly_ro
       gh secret set GITDEDALO_KNOWN_HOSTS --env gitdedalo-nightly --body '[<host>]:<port> ssh-ed25519 AAAA…'
       gh secret set GITDEDALO_URL         --env gitdedalo-nightly --body "$(git remote get-url gitdedalo)"

   Then destroy the local private half (`rm -P gitdedalo_nightly_ro` on macOS).

5. `gh workflow run nightly.yml` and read `full_gate`: `== full gate: gitdedalo/master = <sha>`,
   then the tiers. The ci-nightly issue's warning about absent secrets goes away.

Rotation / revocation: delete the `authorized_keys` line (the next nightly is RED:
fetch refused), then repeat 1–4. A host-key change on gitdedalo makes the fetch RED
until `GITDEDALO_KNOWN_HOSTS` is updated — by design.

### The CI image (`ci/Dockerfile`, `ci-image.yml`)

One definition for the desk and both hosts: bun at `.bun-version`,
postgresql-client-18, the media tools (ffmpeg, ImageMagick 7, poppler, ghostscript,
rsvg), MariaDB, Apache (`apache2` + `apache2-dev` for `apxs`) and nginx (the
publication-host drills), php-cli (the engine drill lints real v1 releases) and php-fpm (the
guided install's FPM pool syntax gate, `php-fpm<v> -t`, and the Debian init drill's real
reload), gpgv (the `.bun-sha256` census row verifies Bun's signed `SHASUMS256.txt.asc`
against the pinned release key on every run), chromium, git/zip/jq; the fingerprint (sha256 of `ci/Dockerfile` ++ `.bun-version`) in
`/etc/dedalo-ci-image` and the `org.dedalo.ci.fingerprint` label. `ci-image.yml`
publishes on a push that moved the definition, weekly with the layer cache OFF (the
updater for the distro half — a cached rebuild would republish old packages forever) and
on dispatch; never on `pull_request` (publishing needs `packages: write`, which a fork
must never reach). Dependabot's `docker` and `docker-compose` ecosystems (directory
`/ci`) propose the base-image and `ci/compose.yml` pin bumps. The `pgvector` digest is
held in THREE places — `db.yml`'s two services and `ci/compose.yml` — bump them in one
change (Dependabot does not see workflow services, so its `/ci` PR moves only the compose
copy). Gate: `ci_workflow_tripwire` "every pgvector image in the workflows equals
ci/compose.yml's digest" turns that PR red until the workflow pins follow.

**The pin** (`ci/image.json` + the literal digest in `ci.yml`, `db.yml`,
`.gitlab-ci.yml`). `bun run ci:image:pin` is its updater: it resolves the digest
`ci-image.yml` published for the checkout's fingerprint and rewrites the lock and every
literal in one diff. What each place asserts (`ci_workflow_tripwire` rule 1b):

- **IN the image** (every tier, every host): `/etc/dedalo-ci-image` = the checkout's
  fingerprint — the tier runs in an image of THIS definition.
- **Every host's literal** = the lock's digest, as uid 1001; the lock's freshness is
  nightly's `image_pin` (`ci:image:pin --check`), which reports into the `ci-nightly`
  issue.

So a `ci/Dockerfile`/`.bun-version` change (a hand edit or Dependabot's `/ci` docker PR)
flows: the local gate builds the new definition (`ci:local` sees the lock is behind and
builds `dedalo-ci:local`) and is GREEN, so the push lands; `ci-image.yml` publishes it;
the hosts, still on the locked older build, are RED on rule 1b until `bun run
ci:image:pin` is committed — that red is the pin-me signal, not a failure of the change.
(Merge a Dependabot `/ci` PR locally and push through the gate; on GitHub it is red by
construction — its tiers run the locked, older image.) Run the updater also when the
nightly `image_pin` is red: the weekly no-cache rebuild published distro security fixes
the lock does not take yet. (Rule 1b asserted `lock == checkout` until review on
2026-09-26 found it deadlocked the push that publishes a new definition.)

**Moving the CI image repository** (2026-10-09: the repo was transferred
`renderpci/dedalo` → `dedalia-org/dedalo`; a user-owned GHCR package does NOT move with
a repository). `ci-image.yml` publishes to `ghcr.io/dedalia-org/dedalo-ci`
(`CI_IMAGE_NAME`, `scripts/lib/ci_image.ts`), and `ci:image:pin` resolves
`fp-<fingerprint>` THERE and always writes that name. Until the first publish under the
new owner is pinned, the lock and the literals still name the old package
`ghcr.io/renderpci/dedalo-ci`, accepted ONLY as the named `CI_IMAGE_LEGACY` (with its
reason). Rule 1b holds both ends: while `CI_IMAGE_LEGACY` is set the lock MUST still
name it, every literal must equal the lock's `<name>@<digest>`, and a `dedalo-ci@sha256`
literal under any third name is red. So the transition cannot outlive its reason —
the pin that drops the old name turns rule 1b red until the legacy constant is deleted.

Stage 2 (in order; each step is the previous one's precondition):

1. Push the stage-1 commit to `v7`/`master`. It touches `ci-image.yml` and `ci/Dockerfile`
   (the `org.opencontainers.image.source` label), so `ci-image.yml` runs and publishes
   `ghcr.io/dedalia-org/dedalo-ci:fp-<fingerprint>`. The label change moved the
   fingerprint: the hosts, still on the locked renderpci build, are RED on rule 1b (a)
   until step 4 lands — the documented pin-me signal ("The pin"), not a fault. The
   pre-push gate is green (`ci:local --docker` builds the new definition locally).
2. Make the new package PUBLIC (org → Packages → `dedalo-ci` → Package settings →
   Change visibility) and confirm it is linked to `dedalia-org/dedalo` (the source label;
   Actions access: the repo with *Write*). `ci:image:pin` pulls anonymously — a private
   package answers like a missing one.
3. `bun run ci:image:pin` — rewrites `ci/image.json` and every literal in `ci.yml`,
   `db.yml`, `.gitlab-ci.yml` to `ghcr.io/dedalia-org/dedalo-ci@<digest>`.
4. In the SAME commit, set `CI_IMAGE_LEGACY = null` in `scripts/lib/ci_image.ts` (rule 1b
   is red without it) and drop the legacy mentions in `.gitlab-ci.yml`, `ci-image.yml`'s
   header and `ci/README.md` (`git grep renderpci/dedalo-ci` must then hit only this section).
   `bunx tsc --noEmit`, `bun test test/unit/ci_workflow_tripwire.test.ts`,
   `bun run ci:image:pin --check` → green; commit; push.
5. CI green on both hosts (GitHub `ci`/`db`, GitLab hermetic) in the new image.
6. Delete the old user package `ghcr.io/renderpci/dedalo-ci` (renderpci → Packages →
   `dedalo-ci` → Delete) — only after step 5, and after any branch still pinning it is
   re-pinned or gone: until then it serves those pins.

### The product image (`image-release.yml`)

Dédalo publishes ONE signed image — one digest — to every **provisioned** registry of
`engineering/image_registries.json`: its own registry (gitdedalo, the primary — not
provisioned yet: its host does not exist) and the mirrors GitHub Container Registry
(`ghcr.io/dedalia-org/dedalo`) and Docker Hub (`docker.io/dedalia/dedalo`). Operators pull from any of them, from a
registry of their own, or build locally (`docs/install/docker.md`). The list is the single
source: the workflow names no registry address; `scripts/ci/image_release.ts` reads the
list, `deploy/image_registries.sh` (sourced by the host tools) and the manual's table are
GENERATED from it (`bun run registries:gen` / `registries:check`). An entry that is not
provisioned names no address (`repository: null` + a reason) and every consumer treats it
as unavailable. Gate: `image_registries_tripwire`.

- **Tags = the code server's release names.** A stable tag `vX.Y.Z` whose `version.ts`
  declares X.Y.Z publishes `:X.Y.Z` (like `<v>.zip`) — IMMUTABLE. A dispatch on the `dev`
  channel from `master` publishes `:X.Y.Z-dev` (like the on-demand `<v>-dev.zip`) —
  mutable, overwritten by the next dev build. No build per master push, no `latest`,
  prerelease tags never match. The rules are `code_build_plan.ts`'s, imported by `plan`.
- **The context is a `git archive`** of the release commit — the code server's mechanism —
  so `build_info.txt` is expanded exactly as in the release zip. The workflow passes the
  channel and the sha256 of that tar stream as build args; the Dockerfile's provenance step
  writes the install stamp, so the image reports `X.Y.Z` (release) or `X.Y.Z.dev` (dev),
  and a local build with no args stays `.dev`. `smoke` asserts it on the pushed bytes,
  with bun = `.bun-version`, pg_dump 18, the media tools, uid 1000, a bun-owned
  `/srv/dedalo/client` and no `deploy/` in the image.
- **Layer order.** The Dockerfile puts the code LAST (`product_image_tripwire`), so the
  base image (digest-pinned) is byte-identical across releases and the code layers are
  the ones that change. A **release** build reads NO registry layer cache: a cache tag in
  the staging repository is writable by any workflow of the repository holding
  `packages: write`, and a poisoned cached layer would be signed as the official image.
  Developer builds use `<staging>:cache-dev-<arch>` (mode=max).
- **Staging, by digest.** Per-arch builds push to `<staging>:run-<run_id>-<arch>`
  (`ci.staging_repository` of the list, a GHCR repository reached with the run's own
  token); each leg's `smoke` hands on the DIGEST it tested (job outputs
  `digest_amd64` / `digest_arm64`), and `publish` assembles the multi-arch index ONCE
  there from `<staging>@<digest>` — never from the run tags, which could be moved while
  `publish` waits for its reviewer → digest D. A missing digest refuses before anything
  is downloaded or pushed.
- **The same-digest rule.** For a release, every registry that already holds `:X.Y.Z`
  must hold the same digest X, which must carry the official signature; X is then copied
  to the registries that lack it and nothing is rebuilt (a disagreement refuses before
  anything is signed). Otherwise D is signed ONCE (`cosign sign`, keyless, recorded in
  Rekor) and `cosign copy` puts image + signature on every target. Every target must then
  hold the SAME digest and pass the operator's own verify. Order executed by
  `image_release_native`.
- **Verify, as an operator does** (identity and issuer: `signing` of the list):

  ```shell
  cosign verify <repository>@sha256:<digest> \
    --certificate-identity-regexp '^https://github\.com/dedalia-org/dedalo/\.github/workflows/image-release\.yml@refs/(tags/v[0-9]+\.[0-9]+\.[0-9]+|heads/master)$' \
    --certificate-oidc-issuer 'https://token.actions.githubusercontent.com'
  ```

- **The record.** The job summary (one row per registry: pushed / unchanged / skipped with
  its reason / failed, verified) and the `image-release` artifact `image-release.json`
  (`{schema, version, tag, channel, source_sha, archive_sha256, digest, registries}`).
  The durable record is Rekor plus the registries themselves.
- **Skips are loud, never silent.** An unprovisioned registry is skipped with its reason; a
  provisioned one whose secret is empty is skipped with a `::warning::` and a summary row;
  the others still publish. A run that can publish to no registry fails.
- **cosign is pinned** (`ci/cosign.json`, updater `bun run ci:cosign:pin`, staleness on the
  nightly `cosign_pin`). `publish` downloads exactly that release and refuses a binary
  whose sha256 is not the pin — and refuses to publish at all while the pin is unset.
- **Provisioning a registry** needs no workflow LOGIC edit: set `repository` +
  `provisioned: true` in the list, `bun run registries:gen`, add the entry's two secrets
  (names = its `auth.username_secret` / `auth.password_secret`) to the repository and to
  the publish job's env (`image_registries_tripwire` leg C is red until both directions
  match), then dispatch the `release` channel once per existing
  release tag — that run copies the published digest and never rebuilds.
- **Developer images** come only from a `dev` dispatch on `master`.

## Non-negotiables (each is tripwired)

- **Bun pin**: every tier runs the CI image `ci/image.json` locks, whose fingerprint
  must equal sha256(`ci/Dockerfile` ++ `.bun-version`) — the image installs exactly
  `.bun-version`; the remaining `setup-bun` steps pin `bun-version-file: .bun-version`;
  `scripts/ci/env_guard.sh` re-checks the actual binary. Never fix a mismatch by
  editing the pin in CI — fix the runner.
- **Oracle flag (post-cutover, largely vestigial)**: PHP is decommissioned and
  `oracleMode()` defaults to `fixtures`, so parity replays the frozen store credlessly.
  Self-hosted parity/verify jobs still set `ORACLE_REQUIRED: "1"` so an explicit
  `ORACLE_MODE=live` run hard-fails on an absent oracle instead of skipping. There is no
  PHP server to restart.
- **ONE self-hosted runner, ever** (private mirror): a single slot serializes every
  self-hosted job machine-wide — the isolation guarantee for shared scratch surfaces.
- **GitLab runs no DB tier.**
- **Least privilege** (rule 7): every workflow declares a top-level `permissions:`
  block, read-only; a job widens only itself — `dedupe` (`actions: read`), nightly's
  `report` (`issues: write`), image-release's `plan` (`actions: read`: the full-gate
  verdict of the release commit), ci-image's publishers (`packages: write`), image-release's `build` (`packages: write`)
  and `publish` (`packages: write`, `id-token: write` for keyless signing), codeql
  (`security-events: write`). `write-all` and `contents: write` are red;
  `pull_request_target`/`workflow_run` are forbidden.
- **No expression in a `run:` script** (rule 7d): inputs, `github.event.*`, secrets and
  job/step outputs reach a script through `env:`.
- **No secret in `.github/workflows/`** (rule 11): a fork PR must find nothing. The
  runs that need a token use the run's own `github.token`. ONE carve-out: the `publish`
  job of `image-release.yml` may map the registry secrets `engineering/image_registries.json`
  declares (today Docker Hub's `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN` and the
  unprovisioned gitdedalo entry's `IMAGE_REGISTRY_GITDEDALO_*`; a registry without OIDC push federation cannot be
  reached otherwise) — only in
  the job that declares `environment: image-release`, only those names, and only while
  that workflow has no `pull_request` / `pull_request_target` / `workflow_run` /
  `schedule` trigger (`secretReferenceFaults`, a planted control per condition). SECOND
  carve-out (2026-10-10): the `full_gate` job of `nightly.yml`, bound to `environment:
  gitdedalo-nightly`, for exactly `GITDEDALO_DEPLOY_KEY`, `GITDEDALO_KNOWN_HOSTS`,
  `GITDEDALO_URL` (NIGHTLY_SECRETS in the gate), while nightly.yml is triggered by
  nothing but `schedule` / `workflow_dispatch` — see *The nightly full gate*.
- **An internal push's downgrade has a nightly home** (rule 20): while the pre-push hook
  holds an internal identity, `nightly.yml` `full_gate` must run the full gate on the
  internal master, carry its rc, report it, and pin the host key.
- **A release is cut only from a full-gate-green commit**: the hook refuses a `vX.Y.Z`
  tag push without a FULL green for its commit (`pre_push_gate_native`), and
  image-release.yml `plan` refuses a commit without a successful push run of ci.yml AND
  db.yml (`image_release_native`; fail closed on an unreadable API). Both live in files
  read AT the tag — the `v*` tag ruleset (activation runbook step 8) is what keeps a
  non-maintainer from tagging a commit that drops them.
- **Pinned actions** (rule 8): every `uses:` is a 40-hex SHA with the version in a
  trailing comment; Dependabot (`github-actions`) proposes bumps. It scans only
  `.github/workflows/` — bump `workflows-selfhosted/` by hand in the same change
  (rule: one action, one SHA across both tiers).
- **Pinned images** (rule 12): every `image:` and `container:` is digest-pinned.
- **CodeQL init and analyze move TOGETHER** (rule 9): one SHA. Dependabot models them as
  two and WILL propose the split (it did, PR #77); take the version, bump both.
- **The secret scanner keeps its default ruleset**: `.gitleaks.toml` sets
  `[extend] useDefault = true` (GitLab loads the same file wholesale).
- **Dependency advisories ratchet, never bare-audit**: `scripts/ci/audit.ts` vs
  `engineering/dependency_audit_baseline.json`. A NEW advisory is red; an accepted one
  is data. A plain `--update` REFUSES an advisory the baseline does not hold (compared
  by KEY); accept one with `--update --allow-regression --reason "…"` — validated by
  `scripts/lib/reason_validator.ts` and written INTO the entry. A missing baseline makes
  every entry NEW; a conflicted or truncated one is refused.
- **The crap ledger is append-only**: `engineering/crap_complexity_baseline.json`'s
  `ledger`, born at `LEDGER_BIRTH`, last line = `summary`, every non-shrink line
  reasoned. `crap_baseline.ts --check --reference <rev>` proves append-only line for
  line against a reference: `verify.ts`'s `crap:ledger` (merge-base with the base) and
  `hermetic.sh` (FETCHED: the base tip on a PR, the first parent on a push), paired by
  leg C. An unresolvable reference is red, never a comparison against the index.

## CI seam environment (why CI never collides with interactive dev)

Externally provided values win over `test/preload/session_db.ts` defaults and over
`../private/.env` (readEnv precedence).

| Var | CI value | Protects |
|---|---|---|
| `DIFFUSION_JOBS_TABLE` | `dedalo_ts_test_ci_diffusion_jobs` | the live diffusion job queue |
| `DIFFUSION_ACTIVITY_TABLE` | `dedalo_ts_test_ci_activity_diffusion` | live activity rows |
| `SERVER_TCP_PORT` | `4390`+ (set by the client runner) | the dev server on 3500 |
| `SERVER_UNIX_SOCKET` | scratch path (runner) | the `/tmp/dedalo_ts.sock` double-start guard |
| `DEDALO_SESSION_DB_PATH` | scratch sqlite (runner; `bun test` preload mkdtemps its own) | the live session store |
| `DEDALO_TS_STATE_PATH` | scratch json (runner) | real maintenance-mode state |
| `DB_NAME` / `DEDALO_DATABASE_CONN` | the SUITE database (runner) | the application's records |
| `DEDALO_TEST_MEDIA_ROOT` | `../private/test_media/<suite db>` (runner and preload) | the installation's media tree; the key also ARMS the `.dedalo_test_media` refusal |
| `DEDALO_DIFFUSION_DB_SOCKET` / `_USER` / `_PASSWORD` / `_HOST` / `_PORT` | `bun test` ONLY: the lane's suite MariaDB socket, its suite user, blank host/port — set by `test/preload/suite_mariadb.ts`, which OVERRIDES any externally provided value (the exception to the precedence rule above). NOT yet the client suite's server (see below) | the installation's MariaDB publication databases |

`scripts/client_test_runner.ts` starts its own server with all of these EXCEPT the
`DEDALO_DIFFUSION_DB_*` row, so `bun run test:client` on a desk gets the isolation CI
gets for everything but MariaDB: its server still resolves `DEDALO_DIFFUSION_DB_*` from
`../private/.env`, i.e. the installation's MariaDB, until `scripts/client_test_server.ts`
composes `suiteMariadbEnvironment` and starts the lane's server first (arming alone is
not enough: an absent socket falls back to TCP `localhost:3306`). Held as a tethered
PENDING row, `CLIENT_SERVER_MARIADB_PENDING` in `suite_mariadb_target_native` leg (u): the
leg composes the server's environment and goes red the day it is armed while the row still
stands, so the row and this paragraph leave together. The `dedalo_ts_test_` table
prefix is schema-enforced (rule 14 extracts the engine's own guard regex).

## Sibling paths and client libraries

`scripts/ci/link_siblings.sh` (first step of every self-hosted job, and the one
`scripts/ci` script no hosted chain may run — `SELF_HOSTED_ONLY` in
`tier_wiring_tripwire`) symlinks `../private` on the mirror's runner. Override with
`DEDALO_CI_PRIVATE_DIR`. Client libraries are not a sibling path: they come from
`bun install` and the committed `vendor/` tree, with no install-time fetch. `mocha`/`chai`
are devDependencies — a `--production` install cannot serve the client harness. Index:
`src/core/client_libs/registry.ts`; gate: `client_libs_tripwire`.

## Deploy (PARKED)

No staging/production server exists yet. `deploy/deploy.sh` is written and reviewed but
has NEVER run against a real host: git-based deploy, pinned-bun `install
--frozen-lockfile --production`, `systemctl restart dedalo-ts`, `/health` wait over the
unix socket, automatic rollback on red health. Boot migrations run inside the server
(`engineering/PRODUCTION.md`). Unparking: provision per `PRODUCTION.md` + `deploy/`
units and run `STAGING_VALIDATION.md` once; set `DEPLOY_HOST` + `DEPLOY_SSH_KEY` and the
`staging`/`production` environments (manual approval on production); the first dispatch
against staging IS the deploy.sh test.

## Security posture (THE hard constraint — tripwired)

**The self-hosted runner must never be attached to the public repo.** It executes
workflow code with the real `../private/.env` and the live matrix Postgres; on a public
repo anyone can fork and open a PR, and a `runs-on: self-hosted` PR job would be remote
code execution on the data host. Rule 5 of `ci_workflow_tripwire`: no `runs-on:` naming
`self-hosted` under `.github/workflows/`. Nothing the repo gates on needs the data host:
the database, browser and update-drill gates run hosted against throwaway services. If
the repo is ever made private again, retire rule 5 deliberately, never in passing.

Repo settings (owner, UI): Actions → "Require approval for all outside collaborators";
restrict allowed actions to the census — `actions/*`, `github/codeql-action/*`,
`oven-sh/setup-bun`, `docker/setup-buildx-action`, `docker/build-push-action`,
`docker/login-action` (+ `webfactory/ssh-agent` on the mirror), all SHA-pinned; the
secret scanner is a digest-pinned container, not an action. Also enable **secret
scanning + push protection** and **private vulnerability reporting** (`SECURITY.md`).

**The nightly deploy key** (rule 11's second carve-out): `GITDEDALO_DEPLOY_KEY` is a
read-only key (forced `git-upload-pack` of one repository), held as an ENVIRONMENT secret
of `gitdedalo-nightly` (deployment branch `master` only) next to the pinned host line and
the URL; only `nightly.yml`'s `full_gate` names them, and that file has no trigger fork
or pushed code can fire. Runbook: *The nightly full gate*.

**The release secrets** (rule 11 carve-out). The only secrets the executed tier may
reference are the registry credentials `engineering/image_registries.json` declares, mapped
by the `publish` job of `image-release.yml`, which is bound to the `image-release`
environment (deployment policy: tags `v*` and branch `master`; required reviewers). That
workflow cannot be fired by a pull request, a `workflow_run` or a schedule, so fork code
never reaches a job that holds them. The reviewers bind only because `v*` tags are
restricted to the release maintainers by a tag ruleset (activation runbook, step 8):
the environment line is read from the workflow AT the pushed tag. GHCR uses the run's own `github.token`. The Docker Hub
credentials (`DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN` — an
access token, Read & Write) are REPOSITORY secrets, which GitHub would hand to any job
naming them: the gate is what keeps every reference inside the environment-bound job.

### Scanners

- **Secret scanning** (`security.yml`, gitleaks): working tree on every PR, full history
  weekly. The first full-history run (2026-08-03: 178 hits over 38,980 commits) was
  triaged entirely to third-party example keys in the deleted PHP trees, public Mapbox
  `pk.` tokens and entropy false positives — no live credential was ever committed; the
  allowlist carries that triage.
- **CodeQL** (`codeql.yml`): `security-extended`, vendored/generated paths excluded in
  `.github/codeql/codeql-config.yml`. Advisory; output is the Security tab.
- **GitLab is deliberately asymmetric**: its own SAST (Semgrep) and Secret Detection
  templates. What must not differ across platforms is the repo's OWN gate — hence one
  `hermetic.sh`.

## Activation runbook — GitHub

1. **Actions allowed**: allowlist the action census above.
2. **Fork-PR safety**: "Require approval for all outside collaborators".
3. **Never register a self-hosted runner here** (rule 5).
4. **Branch protection — OWNER-ONLY and NOT GATED** (a ruleset is unobservable from the
   repo): on **both** `master` and `v7`, require `ci / hermetic`, `db / db` and
   `db / instance`, and a PR to merge. Do NOT add `dedupe` itself as a required check.
   A dedupe-skipped job reports **skipped**, which a required check treats as passing —
   safe because a tier skips ONLY when the dedupe itself concluded success after
   seeing another branch's run of the same sha CONCLUDE success; a failed, timed-out
   or cancelled dedupe runs the tiers (`!cancelled()`, leg F), so no dedupe fault can
   post a skip (see the dedupe). **Periodic check** (calendar it; no gate fires):
   `gh api repos/dedalia-org/dedalo/branches/<b>/protection` for both branches must list
   exactly those three contexts.
5. **Timeouts**: the `instance` job's 60 min is a first pin from the db build plus the
   drills' documented runtimes — re-pin from the first green run's wall clock.
6. **The image**: `ci-image.yml` publishes; `bun run ci:image:pin` moves the lock and
   every literal to it (see "The pin").
7. **GitLab mirror**: the same `.gitlab-ci.yml` hermetic tier on shared runners, in the
   locked image as uid 1001.
8. **The product image** (`image-release.yml`), owner-only, not observable from the repo:
   - create the environment **`image-release`** with a deployment policy allowing tags
     `v*` and the branch `master`, and required reviewers;
   - **MANDATORY — a tag ruleset on `refs/tags/v*`** (Settings → Rules → Rulesets → New
     tag ruleset, enforcement *Active*): *Restrict creations*, *Restrict updates* and
     *Restrict deletions*, with ONLY the release maintainers in the bypass list. Without
     it the reviewers protect nothing: the signing identity accepts `image-release.yml`
     at ANY `refs/tags/vX.Y.Z`, and the `environment: image-release` line that summons
     the reviewers is read from the workflow file AT THAT TAG — any writer who may
     create a `v*` tag can push one on a commit whose workflow drops that line, and the
     run signs keyless as the official release with nobody approving. No in-repo gate
     can check this (a check inside the workflow lives in the very file such a tag
     replaces), so it is on the periodic owner check with branch protection:
     `gh api repos/dedalia-org/dedalo/rulesets` must list it, active;
   - the two secrets of every provisioned registry with `secret` auth — the names are the
     entry's `auth.username_secret` / `auth.password_secret` in
     `engineering/image_registries.json` (Docker Hub's `DOCKERHUB_USERNAME` /
     `DOCKERHUB_TOKEN`, set on dedalia-org/dedalo; GHCR needs
     none — `github.token`);
   - run `bun run ci:cosign:pin` (needs the network) and commit `ci/cosign.json` — until
     then `publish` refuses;
   - after the first publish, make the GHCR package `ghcr.io/dedalia-org/dedalo`
     **public** (anonymous pull); the staging package `dedalo-build` may stay private;
   - when a further registry is stood up, provision it in the list (see *The product
     image*) and dispatch the `release` channel for every existing tag.

9. **The nightly full gate of gitdedalo** (owner-only): the deploy key, host line, URL
   and the `gitdedalo-nightly` environment — *The nightly full gate* → runbook. Until
   then every nightly carries a warning saying the full gate did not run.

## Activation runbook — the self-hosted tier (PRIVATE mirror)

1. Push `master` to a PRIVATE repo (or the `gitdedalo` remote).
2. On that mirror only, move `.github/workflows-selfhosted/*.yml` into
   `.github/workflows/` and restore the commented triggers in `selfhosted.yml`.
3. Register ONE runner (macOS/arm64, `~/actions-runner-dedalo/`, label `dedalo-mac`,
   name `dedalo-mac-1`), `./svc.sh install && ./svc.sh start`; put the pinned bun dir in
   its `.path` (env_guard catches drift). A sleeping Mac queues jobs.
4. GitHub pauses cron schedules after ~60 days of inactivity — re-enable from the
   Actions tab (applies to `nightly.yml` and `ci-image.yml` on the public repo too).
5. Dispatch `deploy.yml` → the loud PARKED failure is the passing test.
