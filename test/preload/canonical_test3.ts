/**
 * bun test preload — the canonical test3 playground is RE-SEEDED FROM CODE before
 * every run, so the suite stops depending on whatever the database happens to hold.
 *
 * WHY. The playground records (test3/1, /2, /27) are the fixture a large part of the
 * suite reads, and their VALUES are pinned inside oracle-captured goldens — e.g.
 * fixtures/info_widget_native/entries.golden.json hard-codes "input text content of
 * one", which is the live value of test3/1's test52. Nothing re-seeded them: a
 * developer who opened test3 record 1 in the UI and edited a field (exactly what a
 * playground invites) silently broke those gates, and the failure pointed at the
 * engine rather than at the edit. The data is the source of truth in CODE
 * (src/core/test_data/test3_canonical.json); the DB copy is a cache — so refresh the
 * cache before every run instead of trusting it.
 *
 * restoreCanonicalTest3() is surgical (seed.ts): it replaces the test3 rows —
 * canonical plus any strays a crashed run left behind — and leaves every other tipo,
 * the id sequence and the counters alone. It does NOT touch user data outside test3.
 *
 * MUST NOT BREAK A DB-LESS RUN. The hermetic CI tier (scripts/ci/hermetic.sh) runs
 * typecheck, lint and the DB-less tripwires on a bare runner with no Postgres at all.
 * A preload that throws there would take down all ~2000 tests, the pure ones included.
 * So a failure here WARNS and continues: the DB-dependent gates then fail on their own
 * terms, with their own messages, exactly as they did before this file existed. It is
 * loud, never silent — a swallowed restore that leaves stale data is the green-suite
 * trap this file exists to close.
 *
 * WHAT THIS PRELOAD DOES **NOT** DO: it does not provision the derived test
 * corpus (src/core/test_data/test_corpus/). That corpus is 446 records over 36
 * sections, and ambient rows are not free — a census gate, a scratch-surface
 * emptiness check or a "count the rows this save appended" assertion all read
 * WHATEVER THE DATABASE HOLDS, so seeding the corpus for every test changed the
 * situation under gates that never asked for it. The corpus is therefore
 * EXPLICIT: a gate that needs it calls `ensureTestCorpus(scope)` in its own
 * `beforeAll` and `dropTestCorpus(scope)` in `afterAll`, exactly like every
 * other situation fixture (test/helpers/zzd_diffusion_fixture.ts). The
 * canonical test3 playground stays here because it is the OPPOSITE case: seven
 * records the suite already assumed were present, whose drift is the bug.
 *
 * Escape hatch: DEDALO_TEST_SKIP_CANONICAL_RESTORE=true (for a run that deliberately
 * inspects drifted data — e.g. debugging the fixture itself).
 */

// Marks this file an ES module, which top-level `await` below requires (TS1375). The
// import is DYNAMIC on purpose: a static one would pull the DB layer into every test
// process at parse time, including the DB-less hermetic tier.
export {};

// ONE SUITE RUN AT A TIME (test/helpers/suite_run_lock.ts): this reseed would wipe a
// running crawl's or client suite's fixtures. A refusal THROWS — unlike the restore below,
// it is never a warning. No suite database (opt-out, hermetic tier) → nothing to lock.
if (process.env.DEDALO_TEST_DB_DISABLE !== 'true' && process.env.DEDALO_TEST_DATABASE) {
	const { acquireSuiteRunLock } = await import('../helpers/suite_run_lock.ts');
	acquireSuiteRunLock(process.env.DEDALO_TEST_DATABASE, 'bun test');
}

if (process.env.DEDALO_TEST_SKIP_CANONICAL_RESTORE !== 'true') {
	try {
		const { restoreCanonicalTest3 } = await import('../../src/core/test_data/seed.ts');
		const { restored } = await restoreCanonicalTest3();
		console.log(`[test-preload] canonical test3 playground restored (${restored} records)`);
	} catch (error) {
		console.warn(
			`[test-preload] could NOT restore the canonical test3 playground — the DB-backed gates will run against whatever the database currently holds, so a stale or edited record can fail them. Harmless on the hermetic (DB-less) tier. Cause: ${(error as Error).message}`,
		);
	}
}
