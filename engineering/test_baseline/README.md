# Test baseline artifacts

**Generator:** `bun run test:baseline` / `bun run test:timings`
(`scripts/test_baseline.ts` — the validators there ARE the schema; the gate
`test/unit/test_baseline_tripwire.test.ts` imports them, so there is exactly one
implementation).
**Never compare failset text files again** — that measure had four verified
holes (see the generator's header): the default reporter names only failures,
three `(fail) (unnamed)` lines collapse under set-compare, failures carry no
file attribution, and a test that stops being *registered* (132 files use
`test.if`/`describe.if`/`skipIf`) makes the failset smaller, which a
subset-compare scores as a PASS.

## The four acceptance assertions

A candidate run (a parallel runner, a new Bun, a re-ordered suite) EQUALS the
recorded baseline **iff**, over the per-test three-state map both sides record:

1. **The key set is identical.** Every `(file, suite path, test name)` key in
   the baseline appears in the candidate and vice versa. A missing key is a
   deregistered test — the exact hole a failure-set subset check cannot see.
2. **No pass ↔ skip transition.** A skip is a recorded state, not a gap; a
   green that became a skip (or the reverse) is a behaviour change.
3. **No pass → fail.** The classic regression, now attributed to a file.
4. **No fail → pass without a ledger line.** A red that turns green is either a
   real fix (named in the commit / `rewrite/LEDGER.md` by its author) or a test
   that silently stopped exercising what it exercised. It is never a free win.

Keys classified FLAPPING or ORDER_SENSITIVE (below) are excluded from
assertions 2–4 *by name* — that is the entire point of recording them: the
noise is quarantined key-by-key instead of eyeballed away, and the quarantine
list can only shrink.

## Artifacts

All are written atomically (temp + rename) because the campaign's own child
runs execute the tripwire that reads them. Each carries the ISO `generated`
date and the 40-hex `commit` it was measured at; `runs.json` additionally
carries the plan (K, J, the recorded seeds).

### `runs.json` — `dedalo.test_baseline.runs/1`

The raw campaign record.

| field | meaning |
|---|---|
| `timeout_ms`, `cap_adjacent_threshold` | the cap the runs executed under (`--timeout=30000`, from `scripts/lib/test_flags.ts`) and the headroom ratio |
| `files` | `null` = full suite. A list = a file-scoped (tiny-mode) campaign — legal only under an explicit `--out-dir`, and REFUSED by the tripwire inside this directory |
| `fixed_runs_planned` (K), `order_runs_planned` (J), `order_seeds` | the plan, decided up front so `--resume` continues the same campaign |
| `keys` | append-only list of `<repo-relative file>::<describe chain > test name>`; every later array/string is positionally aligned to it |
| `runs[]` | one per completed run: `kind` (`fixed`/`order`), `seed` (null for fixed), `started`, `wall_ms`, `exit_code`, `statuses` (one char per key: `p`ass `f`ail `s`kip `a`bsent), `durations_ms` (per key, ms; `-1` = absent) |
| `complete`, `summary` | `false` while a campaign is in flight (a legal, tripwire-green state); the classification tallies land with `complete: true` |

Classification, derived (K = fixed runs, K+J = all runs):
**STABLE-GREEN** = K/K pass · **STABLE-RED** = K/K fail · **FLAPPING** = not
constant across the K fixed runs · **ORDER-SENSITIVE** = constant across the
fixed runs but not across all K+J (the order campaign varies order ALONE —
same DB, same process model, same preload pass — so this isolates "it was
always an order artifact" from "parallelism broke it"). Absence (`a`) is an
outcome: a key that vanishes under `--randomize` is order-sensitive.

### `order_sensitive.json` — `dedalo.test_baseline.order_sensitive/1`

The FLAPPING + ORDER_SENSITIVE quarantine — a **shrink-only ratchet**.
`entries[]`: `key`, `file`, `classification`, `outcomes` (pass/fail/skip/absent
tallies over all K+J runs), `first_seen`. `seeded` is the date of the campaign
that seeded the ratchet, carried forward. Growth is refused by the generator
unless run with `--accept-growth "<reason>"`, which records
`accepted_growth[]: {key, date, reason}`; the tripwire re-checks that every
entry either dates from the seed campaign or carries such a reason. A
delete-and-reseed defeats both locks and is visible only in this file's git
diff — review it like code.

### `cap_adjacent.json` — `dedalo.test_baseline.cap_adjacent/1`

The duration-headroom census, from the **JUnit per-test times** — deliberately
NOT from `--timings`, which records FILE totals and cannot tell one 4.9 s test
from ten 490 ms ones. `entries[]`: every key whose worst measured duration over
all runs exceeds `threshold × timeout_ms` (0.3 × 30000 ms = 9 s), with
`worst_ms` and `ratio`, sorted worst-first. These are the tests one slow
machine away from a timeout red; a timeout tuning starts here, not at the flag.

### `timings.json` — bun's own `{version: 1, files: {...}}` format

Written by `bun test --timings=… --update-timings` (per-FILE totals, consumed
by bun to balance `--shard`/`--parallel`), then re-stamped with a
`meta: {generated, commit, command}` block by the wrapper — bun strips unknown
keys when it rewrites the file (measured 2026-08-25), so a `meta`-less
timings.json means a bare bun call lost the provenance, and the tripwire is red
on it. Regenerate with `bun run test:timings` (which pins cwd to the repo root:
the file keys and the `--timings` path are cwd-relative).

## Running

```
bun run test:baseline                       # K=5 fixed + J=8 order runs (hours)
bun run test:baseline --resume              # continue an interrupted campaign (same HEAD only)
bun run test:baseline --accept-growth "…"   # the only door through the ratchet
bun run test:timings                        # refresh timings.json + meta
bun run test:shard --junit-dir=<dir>        # a sharded candidate, one bin<N>.xml per bin
bun run test:baseline:compare <dir>         # the four assertions vs runs.json (same commit); exit 1 = NOT EQUAL
bun run test:baseline:compare <dir> --expect-fixed  # strict: fixed-order runs only, quarantine = FLAPPING only
# tiny end-to-end verification (first-class, never writes this directory):
bun run test:baseline --files test/unit/locator_law.test.ts --runs 2 --order-runs 1 --out-dir <scratch>
```

Every run is persisted into `runs.json` as it completes — a crash loses one
run, not the campaign.
