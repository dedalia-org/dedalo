/**
 * THE PER-TEST TIMEOUT THE SUITE ACTUALLY RUNS UNDER — one constant, passed on
 * the command line, because the config file that used to declare it is dead.
 *
 * MEASURED (2026-08-25, Bun 1.4.0, pinned then; re-measured unchanged on 1.4.2 2026-09-23, 1.4.3 2026-10-14 and 1.4.4 2026-11-02):
 * `bunfig.toml`'s `[test] timeout = 30000` is SILENTLY IGNORED. Proven in a
 * sandbox: a test that sleeps 8 s under that exact bunfig dies at 5001.50 ms
 * with "this test timed out after 5000ms"; the same test run as
 * `bun test --timeout=30000` passes in 8.01 s. Only the CLI flag is honoured.
 * Bun prints no warning about the unread key, so the repo spent its whole
 * recorded history measuring a baseline under a 5000 ms cap nobody chose — and
 * at least one long-standing "race flake" was never a race: the
 * `dd_diffusion_api … crash recovery` gate fired at 5001.33 ms on a test whose
 * OWN internal deadline is 15000 ms (test/unit/diffusion_actions.test.ts).
 *
 * WHY THE NUMBER LIVES HERE AND NOT IN bunfig.toml. A rule stated in a config
 * file that nothing reads is exactly the stated-but-unenforced invariant DEC-12
 * forbids. Here it is a real export with real importers: every TypeScript site
 * that spawns `bun test` imports it, so the number cannot drift per call site,
 * and the shell/JSON/YAML sites that cannot import (package.json has no
 * comments and no imports; the CI shell tiers and workflow files are not TS)
 * carry the literal with a comment naming THIS file as the source of truth. A
 * tripwire gate holds those copies in step with this constant — the literals are
 * a copy under mechanical guard, not a second source.
 *
 * WHAT THIS DOES NOT COVER, stated plainly:
 *  - It does not make any test faster or more correct. It only stops the runner
 *    from killing a test before the test's own deadline can report WHY it hung.
 *  - It does not touch the ~375 test files that carry a per-test `, 30000)`
 *    argument as a workaround for the same defect. Those are now redundant, not
 *    wrong, and are left alone.
 *  - It does NOT apply to the two isolated daemon packages
 *    (publication/site_builder, publication/server_api/v2). Their bunfigs never
 *    declared a 30000 timeout — one is empty, the other declares only coverage —
 *    so unlike the root suite they are not losing a number they chose. Their
 *    green baselines were measured under the built-in 5000 ms cap and stay
 *    comparable; widening them on no evidence would be silently loosening a gate.
 *  - It proves nothing about which tests were passing only because they were
 *    killed early. Re-measuring the baseline under the real cap is a separate,
 *    deliberate act.
 */

/** Per-test timeout, in milliseconds, for the ROOT suite (`test/`). */
export const TEST_TIMEOUT_MS = 30000;

/**
 * The same number as the single CLI argument bun accepts. Use this form (one
 * argv entry, `--timeout=N`) everywhere, so a grep for the flag finds every
 * call site regardless of how the argv was assembled.
 */
export const TEST_TIMEOUT_FLAG = `--timeout=${TEST_TIMEOUT_MS}`;
