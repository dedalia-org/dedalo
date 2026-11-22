---
name: dedalo-ts-testing
description: >-
  How to test the Dédalo v7 TS/Bun engine honestly — test/unit/ (pure, DB, TS-native *_native write-path gates, tripwires) and test/parity/ (read-path replay of the FROZEN 2026-07-11 fixture store). Use when writing or debugging any *.test.ts; when a test-data writer REFUSES ('no dedalo_test_marker row') or a media door refuses a root without '.dedalo_test_media'; when building the suite DB (bun run test:db:setup); when a gate must BUILD its situation on the generic `test` TLD (ensureSituation, zz* TLDs); when asking "is this test asserting anything or silently green" (gate_vacuity_tripwire, oracle_canary); when a test fails only in full-suite order (mock.module leak); for a wiped session store (DEDALO_SESSION_DB_PATH); for ORACLE_MODE questions; when adding or trusting a tripwire; or for a deliberate wire divergence (engineering/wire_contract/). Sibling: dedalo-parity-debugging for a red parity gate. Index: engineering/TRIPWIRES.md.
---

# Dédalo v7 testing (TypeScript/Bun engine)

The PHP engine was decommissioned at the 2026-07-11 cutover; there is no live oracle. What verifies the engine now: **read-path parity** replaying a frozen fixture store, and **TS-native gates** that build their own situation and assert contracts. The one law of this suite: **a test that cannot fail proves nothing.** The 2026-07 foundation audit found every invariant guarded only by docs/memory violated in practice, every TRIPWIRED boundary held.

Run: `bun test` (full run takes minutes) or `bun test test/unit/<file>` for a targeted gate. Measured baselines live in rewrite/LEDGER.md (gitignored, local-only) and the banked baselines under `engineering/` (`unit_baseline.json`, `parity_baseline.json`). This skill is how to write a test that earns its keep.

## Two tiers

- **`test/unit/`** — pure logic, DB-touching units, the TS-native write-path gates (`*_native.test.ts`), and the tripwires. **New gates go here.**
- **`test/parity/`** — `*_differential.test.ts` gates replaying the frozen PHP capture (read path only). No new differential can be harvested. When one reds, see **`dedalo-parity-debugging`**.

## THE GREEN-SUITE TRAP

Bun counts a test body that `return`s before asserting as a PASS. So:

- **Never early-`return` from a test body.** The honest idiom for a precondition you cannot meet is `test.skip` (or `test.if(cond)`) with the reason in the test NAME, so the runner says it out loud. `gate_vacuity_tripwire` counts silent returns against a shrink-only budget (`engineering/gate_vacuity_budget.json`); a new one is red.
- **Never write an assertion that passes on an empty result.** `toEqual([])` over a census whose walk read nothing is green by construction — floor the walk (`census_derivation_tripwire`). A diff of `[]` vs `[]` is the trap wearing a costume.
- **Do not gate a new test on `hasPhpCredentials()` / `hasLivePhpOracle()`.** The latter is false forever; the former only reports whether the fixture store is present. A native gate needs neither.
- **The canary:** `test/parity/oracle_canary.test.ts` asserts the frozen store is present under `ORACLE_MODE=fixtures` (the default) and prints what the run does and does not verify, including any parity file still holding blocks gated on `hasLivePhpOracle()` (permanently unreachable — retire or twin them). Never gate the canary itself.

## Frozen-fixture parity (DEC-14b)

`ORACLE_MODE` defaults to `fixtures` (`oracleMode()` in `test/parity/oracle_fixtures.ts`): read-path differentials run with no network and no credentials, replaying `test/parity/fixtures/oracle_harvest/` (one JSON per gate) matched by canonical request hash — **a miss THROWS**, it never falls through to green. A generic-`test`-TLD gate still finds its frozen interaction: `unmapRqo` maps the request back to install terms before hashing (WC-2026-08-19-test-tld-replay).

- **A re-harvest is impossible** — the oracle is gone. `scripts/oracle_harvest.ts` and the `record` mode are history. **Any fixture change is a deliberate contract edit** and needs its `engineering/wire_contract/` entry the same day.
- `FIXTURE_EXEMPT_GATES` is EMPTY: the live-only (write-path) differentials retired with the oracle. Their contracts live in `test/unit/*_native.test.ts` twins, mapped in `engineering/ORACLE_HARVEST.md` (DEC-14b punch list, § Generic-TLD replacement map) and derived into `engineering/twin_map.json` from each twin's `@twin-of` / `@twin-status` header directives (`scripts/twin_map.ts`).
- **Corpus-bound by construction.** Every harvested gate carries `entity: monedaiberica`; on the suite DB the tier is mostly red from corpus absence (the frozen reds are banked per test name in `engineering/parity_baseline.json`). Do NOT restore the harvest-day snapshot to make them green — that tests one install, not the engine. Each corpus-bound gate is replaced by a generic-TLD twin, or re-expressed to replay under the `test` TLD.

## The generic `test` TLD law

A test uses the generic `test` TLD and BUILDS its situation: structure through `src/core/test_data/situations/` (`situation({tld:'zz…', …})` → `ensureSituation` / `dropSituation`, written through the engine's own door `upsertDdOntologyNode`, torn down after), records created at runtime. Never `numisdata`/`oh`/`tch`/`rsc`/`ich`/`mdcat`… in a test, and never read whatever records the ambient DB holds. Ratchet: `generic_tld_tripwire` (shrink-only), which scans `test/**/*.test.ts`, the browser suite (`client/dedalo/test/client/js/`) and `src/core/test_data/`. The client suite binds the `test` TLD and the canonical `test3` playground; a write-heavy client suite takes its own test3 record (`SUITE_ISOLATION_RECORDS` in `src/core/test_data/manifest.ts`).

## THE TEST DATABASE AND ITS MARKER

`bun run test:db:setup` builds the suite DB (`DEDALO_TEST_DATABASE`, else `<DB_NAME>_test`) from repo-vendored files, as an INSTALLATION FIRST through the installer's own doors: `installDbFromSeed()` (the core-only seed + search stores + engine ontology + `lg`) → **marker** → the default domain ontology `oh` (`stageOntologies` + `installOntologies` over `defaultOfflineOntologyRequest()`, the vendored file) → then the suite's own fixtures: generic `test` TLD ontology (`src/core/test_data/test_tld_ontology.json`, through the engine's doors) → canonical test3 records (`restoreCanonicalTest3`) → hierarchies + tools. No installation receives the `test` TLD or test3. `bun test` preloads repoint the process at it automatically.

**The marker IS the guarantee.** One row in `dedalo_test_marker` (`src/core/test_data/test_database_marker.ts`): `id=1` PK, the purpose sentence pinned by a CHECK, the database it names, build stamp + git rev + seed/ontology sha256. It cannot be created by accident, a marker naming another database REFUSES (a misrouted restore), and `scripts/test_db_setup.ts` is its only producer.

Every test-data writer calls `await assertTestDatabase('<door>')` **before its first write** and refuses otherwise, with nothing written — e.g. `materializeTestTldOntology`, `ensureTestCorpus`/`dropTestCorpus`/`ensureMediaKit`, `ensureSituation`/`dropSituation`, `createScratchRecord`/`cleanScratchRecord`/`cleanScratchTipo`, `installAclIdentityFixture`/`removeAclIdentityFixture`, `ensureSuiteProjectsFixture`/`removeSuiteProjectsFixture`, `ensureSuiteLoginPassword`.

- **A NEW writer must call it too** — `test_db_marker_tripwire` DERIVES the writer list from `src/core/test_data/**` + `test/helpers/**`, so forgetting is red; an exemption needs a written reason in its `EXEMPT_WRITERS` (today: the marker module itself, the two media-root helpers, and `seed.ts`, whose test3 reset is also the dev-mode maintenance widget — refused where the test TLD is not installed).
- **There is NO bypass** (since 2026-10-09). The installer's old `allowAnyDatabase` opt-out was deleted with the core-only seed: an installation gets no test fixture. `test_db_marker_tripwire` rule 4 holds it at zero (source census + the old call shape must refuse). A writer that needs the `test` TLD runs on a database `test:db:setup` built.
- **There is NO reserved `section_id` band.** Isolation is the dedicated database and its markers, never an id range. A fixture on an identity table (e.g. `src/core/test_data/projects_fixture.ts`) writes an EXPLICIT id it owns and sweeps; the counter still moves through it (`insertMatrixRecordWithExplicitId` raises it with GREATEST) — correct, not drift.
- **The client run is inside the law.** `bun run test:client` starts its OWN server on the suite DB (`scripts/client_test_server.ts`), verifies any `--url` target over `/health` (an opaque fingerprint of the marker row), sets the suite DB's own login credential (`src/core/test_data/suite_login.ts`), and pins what two suites need: the diffusion domain (`SUITE_DIFFUSION_DOMAIN = 'test'` — a domain is matched BY TERM, so an install's name resolves to nothing here) and a second project for the `dd153` filter. Gate: `test/unit/client_situations_native.test.ts`. Browse the same setup by hand with `bun run test:client:server`.
- Symptom → cause: `REFUSING to write test data into database '…'` = your process points at a database the suite did not build. Run `bun run test:db:setup`; never write the marker onto an install.

## THE TEST MEDIA ROOT AND ITS MARKER

The filesystem half. The suite's media land in `../private/test_media/<suite db name>/`, marked by a `.dedalo_test_media` file — `bun run test:db:setup` sweeps and rebuilds it, `bun test` creates it if missing; `test/helpers/test_media_root.ts` is the one derivation and refuses a root overlapping the installation's `MEDIA_PATH`.

**One key does both halves**: `DEDALO_TEST_MEDIA_ROOT` repoints `config.media.rootPath` AND arms the refusal, so a run cannot be armed at the install's root nor repointed with the guard asleep. Armed, every door that resolves a media root (`requireMediaRoot` in `src/core/media/path.ts` and the rest, `src/core/media/test_media_root.ts`) refuses a root without the marker, names itself, and writes nothing.

- **A gate's OWN scratch root needs the declaration too** — `test/helpers/media_scratch_root.ts`: `markMediaRoot(dir)` · `scratchMediaRoot(prefix)` · `resetMediaRoot(dir)` (an `rmSync` takes the marker with it).
- Never create the marker inside an installation's media tree. Gate: `test/unit/test_media_root_tripwire.test.ts`.

## The test corpus: what its values ARE

`src/core/test_data/test_corpus/` is DERIVED by `scripts/derive_test_corpus.ts` from the frozen harvest store; a gate calls `ensureTestCorpus(scope)` / `dropTestCorpus(scope)` itself (one owning file per scope — `corpus_scope_ownership_tripwire`).

- **Most values are LIST PROJECTIONS, not stored bytes** (each record declares `component_sources` and `reconstructed`). Never re-read a `list`-sourced component through the list pipeline and compare VALUES — you truncate twice. Compare values only on `reconstructed: false` rows. A component ABSENT from a reconstructed record is UNKNOWN, not empty.
- **Inverse edges are materialized from the far end** (`inverse_edges[]`, `edge_only: true`); an unmappable one is REFUSED into `refused.json`, never approximated. If your gate's records are in `refused.json`, fix the derive, do not weaken the assertion.

## Scratch-write hygiene

- Write only to the suite DB (the marker guarantees it) and only on surfaces the test built: a `zz*` situation, a scratch record, an explicit-id fixture. **Never assert against a mutable record you did not create**; clean up before AND after, and assert zero residue.
- **Session store isolation (S1-18):** `bun test` preloads `test/preload/session_db.ts`, which points `DEDALO_SESSION_DB_PATH` at a throwaway store. `src/core/security/session_store.ts` reads it ONCE at module load (`sessionDbPath`), so the override must be set before that module is imported — which the preload guarantees. A test run once WIPED the live session store; the guard is `test/unit/session_store_reset_guard.test.ts`. Never hardcode a path that bypasses the override.

## Deliberate wire divergences — ledger, don't normalize

When TS intentionally differs from the frozen PHP shape, the gate transforms the fixture side — and that transform must be **recorded** in `engineering/wire_contract/`, one file per entry (rules: `engineering/WIRE_CONTRACT.md`; e.g. **WC-001**: empty component value is `entries: []`, PHP emitted `null`). A normalization with no ledger entry is a regression in disguise.

## THE TRIPWIRE-TEST PATTERN

Rule: **"tripwire or delete."** Every structural invariant has a gate in `test/unit/` that reddens the moment the rule is broken. The authoritative index is **`engineering/TRIPWIRES.md`** (machine-read: `scripts/verify.ts` `TRIPWIRES` must equal it — add a row to both in the same change). When you rely on a tripwire, **prove it honest**: plant a violation, watch the exact gate go red, revert. Most carry positive controls for exactly this.

## Bun gotcha — `mock.module` leaks across files

`mock.module` is **process-GLOBAL**, and `mock.restore()` does **NOT** revert it. Snapshot the REAL module exports at import time and re-install them in `afterEach` (pattern: `test/unit/record_scope_gates.test.ts`):

```ts
import * as record_scope from '../../src/core/security/record_scope.ts';
const REAL_RECORD_SCOPE = { ...record_scope };
afterEach(() => { mock.module('../../src/core/security/record_scope.ts', () => REAL_RECORD_SCOPE); });
```

The snapshot must be a SPREAD COPY — `const REAL = await import(x)` (no spread) is the live namespace, which `mock.module` rewrites in place, so "restoring" from it re-installs the mock (`mock_isolation_tripwire` rule 3 reads both the `import * as` and the `await import()` shape).

**Client-module substitution is a different class: make the file an ISOLATED GATE.** A `mock.module` of a `client/`/`tools/` path, or any in-process `Bun.plugin`, cannot be undone (the client modules under test bind their leaves once per process; a plugin is never unregistered), so such a file wraps its body as `if (!isIsolatedGateChild(import.meta.path)) mirrorIsolatedGate(import.meta.path); else { … }` (`test/helpers/isolated_gate.ts`): the tier process mirrors a child run of the file, case by case, with the child's failure text and assertion count. Enforced by `mock_isolation_tripwire` rule 4. The child runs with Bun's on-disk transpiler cache OFF — that cache bakes plugin-RESOLVED imports into a module's cached build and serves them to LATER processes (measured 2026-10-02: a gate alone imported another gate's stub). If a client gate reds alone on your machine with a stub path in the error, purge `~/Library/Caches/bun/@t@` entries that name `client_module_stubs`.

A test that fails **only in full-suite order** but passes standalone is almost always a leaked module mock or a scratch-row/session-store collision — not a real regression. Check the leak before "fixing" the code. File order differs per host (readdir: alphabetical on APFS, hash order on the CI image's ext4/overlay) — replay the image's order on the desk with an explicit file list (`bun test ./a ./b …` keeps the order given).

## Checklist for a new test

1. Native gate in `test/unit/`; builds its situation on the `test` TLD / a `zz*` situation; no install TLD, no ambient records.
2. No early `return` in a test body — `test.skip`/`test.if` with the reason in the name. Assert on real structure, floor every census.
3. Writes? → suite DB only, scratch surface, cleaned both ends, zero residue asserted. A NEW write helper calls `assertTestDatabase()` first; a media write uses a declared root.
4. Replaces a retired differential? → `@twin-of` / `@twin-status` header directives, then `scripts/twin_map.ts`.
5. Diverges from the frozen shape on purpose? → an `engineering/wire_contract/` entry the same day.
6. New invariant? → new tripwire + index row, proved red-on-violation.
7. Uses `mock.module`? → spread snapshot + `afterEach` re-install; of a client module or a `Bun.plugin`? → an isolated gate (`test/helpers/isolated_gate.ts`).

Write-path primitives you may assert against: `withTransaction` (`src/core/db/postgres.ts`), `insertMatrixRecordWithCounter` (`src/core/db/matrix_write.ts`), `encodeForJsonb` (`src/core/db/json_codec.ts`), `compareLocators` (`src/core/concepts/locator.ts`), `dbTimestamp` (`src/core/db/db_timestamp.ts`).
