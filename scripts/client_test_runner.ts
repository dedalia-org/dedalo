/**
 * CLIENT TEST RUNNER (headless)
 *
 * Bun port of the PHP reference runner `test/client/puppeteer_runner.js`. Drives
 * the copied vanilla-JS client's Mocha/Chai suites in headless Chrome against the
 * TS server, so the browser-level client tests become a repeatable one-shot /
 * CI gate — complementing the server-side differential gates under `test/parity/`.
 *
 * How it works (identical control flow to the PHP runner):
 *   1. Launch headless Chrome and open the test runner page
 *      (`/dedalo/test/client/index.html`, served by src/server.ts under /dedalo/*).
 *   2. If `page_globals.is_logged !== true`, AUTHENTICATE. Two paths:
 *      - `cookie` (DEFAULT) — call `login()` (core/security/auth.ts) IN THIS
 *        PROCESS with the configured test credentials and inject the resulting
 *        session (and media-auth) cookie into the browser. Same password check,
 *        same session row, same audit line as a real login: the only thing
 *        skipped is the FORM. It is skipped because the form path is flaky on
 *        a dev box (the two-step reveal loses the submit and the wait times
 *        out), and a gate nobody can run is not a gate.
 *      - `form` (`--auth form`) — type into the copied client's own login form,
 *        the original path. Keep it: it is the only thing that exercises the
 *        client's login UI against TS auth/CSRF.
 *      - `mint` (`--auth mint`) — DEV ONLY, NO PASSWORD: mint a session for an
 *        EXISTING username straight through the session store. For the case
 *        the other two cannot serve — a dev DB whose `DEDALO_TEST_PASSWORD` is
 *        stale (a restored production dump carries ITS passwords, not the
 *        .env one), where a gate that refuses to run teaches nothing. It is
 *        never the default and prints a banner every run: a green run under
 *        `mint` has NOT exercised authentication.
 *   3. Click "run all" (`#test_run_all`), poll until the button re-enables, then
 *      scrape `window.global_stats` + per-group DOM stats.
 *   4. Exit on the verdict of scripts/lib/client_gate_verdict.ts (`conclude`
 *      below is the ONE exit, shared with `--replay`): 0 iff the inventory
 *      floor is met, no card was loaded twice or ran nothing, no pending
 *      suites, and no failure outside KNOWN_FAILING (the disclosed, shrink-only
 *      baseline below) — a suite in that list that now PASSES is also red, so
 *      the list can never outlive the bug it names.
 *
 * This is deliberately NOT a `bun test` file: it needs a live server + a real
 * browser, so it stays out of the `bunfig.toml` (root=test) discovery and is run
 * explicitly via `bun run test:client`.
 *
 * THE SERVER IS THE RUN'S OWN, ON THE SUITE DATABASE (2026-08-19). This runner
 * used to drive whatever `bun run dev` was already serving — which is the
 * APPLICATION's database by default, so the reseed, the demo-ontology fixture
 * and ~125 browser suites wrote into real records. It now starts its own server
 * on the dedicated suite database and tears it down, and it VERIFIES the target
 * over the wire before Chrome is launched (`/health` must answer the
 * fingerprint of the same `dedalo_test_marker` row this process reads). The
 * mechanism, the alternatives weighed, and the refusal live in
 * scripts/client_test_server.ts. `--url` still points at a server you started
 * yourself — it is checked exactly the same way, never trusted.
 *
 * Usage:
 *   bun run scripts/client_test_runner.ts [options]
 *
 * Options (env var fallback in parens):
 *   --url <url>        Runner page of a server YOU started (TEST_URL) — verified
 *                      to be on the suite database like any other target
 *   --port <n>         Port for the run's own server     (default 4390, next free)
 *   --auth <mode>      cookie (default) | form   (TEST_AUTH)
 *   --timeout <ms>     Max run wait, ms          (TEST_TIMEOUT; default 300000)
 *   --headless <bool>  Headless                  (HEADLESS; default true)
 *   --user <username>  Login username            (DEDALO_TEST_USER, else PHP_API_USERNAME)
 *   --password <pwd>   Login password            (DEDALO_TEST_PASSWORD, else PHP_API_PASSWORD)
 *   --no-reseed        Skip the canonical test3 reseed before/after the run
 *   --strict           Treat EVERY failure as red, ignoring KNOWN_FAILING
 *   --update           After a GREEN run, bank the observed inventory (suites,
 *                      mocha tests RAN, static assertion-free it() count, static
 *                      switched-off registration count) into
 *                      engineering/client_gate_inventory.json. REFUSES to lower
 *                      a floor or raise a budget (scripts/lib/client_gate_verdict.ts).
 *   --check --json     NO browser, NO server: the STATIC half of the inventory
 *                      (assertion-free / switched-off budgets, the suite floor
 *                      the registry derives) as the bank's verdict
 *                      (scripts/lib/ratchet_check.ts; staticInventoryVerdict).
 *   --bank-static      Bank that static half, improvements only (a budget that
 *                      fell, a floor that rose); REFUSES the other direction.
 *                      mocha_test_floor is never touched — only a green run moves it.
 *   --replay <file>    NO browser, NO server: read a scraped observation
 *                      (a ScrapedRun — {cards: [{status, dataset}], counters,
 *                      groups}, exactly what the page scrape returns) from a
 *                      JSON file and run the SAME interpret-conclude-exit tail — the
 *                      subprocess leg client_gate_inventory_tripwire uses to
 *                      prove this process exits on the verdict, not around it.
 *
 * Credentials are read via the project env loader (src/config/env.ts), so they
 * resolve from ../private/.env exactly like the rest of the config — no secret
 * ever needs to be passed on the command line.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { readEnv } from '../src/config/env.ts';
import type { RunCreatedSweeper } from '../src/core/test_data/run_created_records.ts';
import { gatedCardCount, staticCensusTotals } from '../test/helpers/client_suite_census.ts';
import { acquireSuiteRunLock } from '../test/helpers/suite_run_lock.ts';
import {
	assertServedDatabase,
	type ClientTestServer,
	findFreePort,
	localSuiteFingerprint,
	originOf,
	probeServedDatabase,
	repointProcessToSuiteDatabase,
	resolveSuiteDatabase,
	SUITE_DIFFUSION_DOMAIN,
	startClientTestServer,
	suiteServerPaths,
} from './client_test_server.ts';
import {
	type AxeObservation,
	type AxeViolation,
	computeVerdict,
	concludeRun,
	loadA11yBudget,
	loadInventory,
	observeRun,
	type RunResults,
	type ScrapedCard,
	type ScrapedRun,
	staticInventoryVerdict,
	type Verdict,
	writeInventory,
} from './lib/client_gate_verdict.ts';
import { emitRatchetCheck } from './lib/ratchet_check.ts';

/** The install seed's own user, and the credential the suite database gets. */
const SUITE_LOGIN_USER = 'root';
/** Kept in step with src/core/test_data/suite_login.ts (imported lazily below). */
const SUITE_LOGIN_PASSWORD = 'Dedalo-Suite-Client-7';

// ---------------------------------------------------------------------------
// CLI / env argument resolution (mirrors the PHP runner's getArg helper).
// ---------------------------------------------------------------------------

const args = Bun.argv.slice(2);

/** Resolve a value from --flag, then an env var, then a default. */
function getArg(flag: string, envVar: string, defaultValue?: string): string | undefined {
	const index = args.indexOf(flag);
	if (index !== -1 && args[index + 1] !== undefined) {
		return args[index + 1];
	}
	return readEnv(envVar) ?? defaultValue;
}

const log = (message: string): void => {
	process.stdout.write(`${message}\n`);
};
const error = (message: string): void => {
	process.stderr.write(`ERROR: ${message}\n`);
};

/** The runner page, given an origin. */
function runnerPageUrl(origin: string): string {
	return `${origin}/dedalo/test/client/index.html`;
}

const headlessArg = getArg('--headless', 'HEADLESS', 'true');
const headless = headlessArg !== 'false';

/**
 * An EXTERNAL server to drive, or undefined = the run starts its own. Either
 * way the target is probed: `--url` buys you a server you can watch, never a
 * server that is taken on trust.
 */
const externalUrl = getArg('--url', 'TEST_URL');
const preferredPort = Number.parseInt(getArg('--port', 'TEST_PORT', '4390') as string, 10);
const timeout = Number.parseInt(getArg('--timeout', 'TEST_TIMEOUT', '300000') as string, 10);
// Credentials: prefer DEDALO_TEST_*, fall back to the PHP reference creds already
// in ../private/.env (same shared DB, so the same user authenticates on TS).
//
// USERNAME: the seed's own `root` unless told otherwise — the suite database is
// built from install/db/dedalo_install.pgsql.gz, which is where that user comes
// from. PASSWORD: whatever is configured, else the SUITE CONSTANT
// (src/core/test_data/suite_login.ts). The seed ships root with NO password, so
// before the browser logs in the runner MAKES this credential true on the
// disposable database (ensureSuiteLogin below) — that is how the run keeps
// exercising a real, password-verified login instead of falling back to
// `--auth mint`, which verifies nothing.
const username =
	getArg('--user', 'DEDALO_TEST_USER') ?? readEnv('PHP_API_USERNAME') ?? SUITE_LOGIN_USER;
const password = getArg('--password', 'DEDALO_TEST_PASSWORD') ?? SUITE_LOGIN_PASSWORD;

const reseedEnabled = !args.includes('--no-reseed');
const strict = args.includes('--strict');
const updateInventory = args.includes('--update');
const replayFile = getArg('--replay', 'TEST_REPLAY');
/** How the run authenticates: an in-process real login + cookie, or the form. */
const authMode = (getArg('--auth', 'TEST_AUTH', 'cookie') as string).toLowerCase();
if (authMode !== 'cookie' && authMode !== 'form' && authMode !== 'mint') {
	error(`Unknown --auth '${authMode}'. Use 'cookie' (default), 'form' or 'mint' (dev only).`);
	process.exit(1);
}

/**
 * Reseed the canonical test3 playground from the single verified source
 * (src/core/test_data/). The component sweeps save random values into the
 * shared test3 records, so the run must START deterministic (pre-run) and
 * must not leave pollution behind for the parity gates (post-run).
 *
 * DB-only (DEC-20 — save events fan out in-process): a long-lived dev server
 * may still hold stale test3-derived datalist caches after this external
 * reseed. Restart it — or trigger the "Unit test area" maintenance widget,
 * which reseeds in-process — when full cache coherence matters.
 *
 * client/ stays byte-identical: in-run shared-record pollution between suites
 * (per-suite section_ids in elements.js) is future UPSTREAM work — see the
 * rewrite/LEDGER.md known-open row.
 */
async function reseedCanonicalTest3(phase: string): Promise<void> {
	const { restoreCanonicalTest3 } = await import('../src/core/test_data/seed.ts');
	const { restored } = await restoreCanonicalTest3();
	log(`Canonical test3 reseed (${phase}): ${restored} records restored.`);
}

/**
 * Provision the "map of grapes" demo ontology (test480/test507/test506) that
 * `test_additional_text_area.js`'s geolocation block depends on — see
 * src/core/test_data/map_of_grapes_fixture.ts. Idempotent; pre-run only
 * (nothing in the suite mutates the ontology shape, only the record's data,
 * which this re-provisions to the same starting content each run).
 *
 * Same DB-only caveat as reseedCanonicalTest3: this runs in the SCRIPT's own
 * process, so its cache-invalidation call only clears ITS OWN in-memory
 * ontology cache, not the long-lived dev server's. The first time this
 * fixture is created against a server that already cached a negative lookup
 * for these tipos (e.g. from an earlier failed request), restart the TS
 * server once — every run after that is DB-only stable.
 */
async function ensureMapOfGrapesFixture(): Promise<void> {
	const { ensureMapOfGrapesFixture: ensure } = await import(
		'../src/core/test_data/map_of_grapes_fixture.ts'
	);
	await ensure();
	log('Map of grapes fixture (test480/507/506): ensured.');
}

/**
 * Provision the SECOND project `test_component_filter.js` needs — see
 * src/core/test_data/projects_fixture.ts for why one is not enough. Installed
 * before the server spawns (so it reads the row cold) and swept in the same
 * place the post-run reseed runs, so no other tier on this shared database
 * inherits a widened projects catalog.
 */
async function ensureSuiteProjectsFixture(): Promise<void> {
	const { ensureSuiteProjectsFixture: ensure } = await import(
		'../src/core/test_data/projects_fixture.ts'
	);
	await ensure();
	log('Suite projects fixture (dd153 second project): ensured.');
}

/**
 * Provision the NESTING situation `test_nested_portal.js` needs — a real
 * component whose map declares `test80`'s children, so a nested test80's
 * reads carry a caller chain the server VERIFIES (see
 * src/core/test_data/nested_portal_fixture.ts). Installed before the server
 * spawns (it reads the nodes cold) and swept beside the projects fixture.
 */
async function ensureNestedPortalFixture(): Promise<void> {
	const { ensureNestedPortalFixture: ensure } = await import(
		'../src/core/test_data/nested_portal_fixture.ts'
	);
	await ensure();
	log('Nested portal fixture (verified caller chain for test80): ensured.');
}

async function removeNestedPortalFixture(): Promise<void> {
	const { removeNestedPortalFixture: remove } = await import(
		'../src/core/test_data/nested_portal_fixture.ts'
	);
	await remove();
	log('Nested portal fixture (verified caller chain for test80): swept.');
}

async function removeSuiteProjectsFixture(): Promise<void> {
	const { removeSuiteProjectsFixture: remove } = await import(
		'../src/core/test_data/projects_fixture.ts'
	);
	await remove();
	log('Suite projects fixture (dd153 second project): swept.');
}

/**
 * PRE-FLIGHT: the diffusion surface `test_diffusion.js` drives must EXIST.
 *
 * The inspector draws the publish opener only when the section's tools list
 * carries `tool_diffusion`, and that tool's availability is `haveSectionDiffusion`
 * — an O(1) lookup in a map built by walking the CONFIGURED diffusion domain
 * (src/core/diffusion_bridge/diffusion_map.ts). An empty map is not an error
 * anywhere in the engine: a fresh install legitimately has no diffusion, so every
 * caller returns "unavailable" quietly. That silence is exactly what made a
 * misconfigured domain surface as six unexplained `expected false to equal true`
 * DOM assertions instead of naming itself. Assert it here, before Chrome starts,
 * so the run fails with the domain's name in the message.
 *
 * DB-only, like the other pre-run fixtures: it proves this DATABASE answers, in
 * THIS process, for the pinned SUITE_DIFFUSION_DOMAIN. An external `--url`
 * server started with a different domain is outside what this can see.
 */
async function assertSuiteDiffusionSurface(): Promise<void> {
	// The section test_diffusion.js opens (all three of its describes drive it).
	const DIFFUSION_SECTION = 'rsc170';
	const { haveSectionDiffusion, getSectionDiffusionMap } = await import(
		'../src/core/diffusion_bridge/diffusion_map.ts'
	);
	const map = await getSectionDiffusionMap();
	if (!(await haveSectionDiffusion(DIFFUSION_SECTION))) {
		throw new Error(
			`REFUSING to run: the diffusion domain '${SUITE_DIFFUSION_DOMAIN}' resolves ${map.size} publishable section(s) on this database and ${DIFFUSION_SECTION} is not among them` +
				(map.size === 0
					? " — the domain name matches no dd1190 child, or its subtree reaches no section. Rebuild the suite database with 'bun run test:db:setup'."
					: ` (it resolves: ${[...map].join(', ')}).`) +
				' Without it the inspector draws no publish opener and test_diffusion fails with unexplained DOM assertions.',
		);
	}
	log(
		`Diffusion domain '${SUITE_DIFFUSION_DOMAIN}': ${map.size} publishable sections, ${DIFFUSION_SECTION} included.`,
	);
}

/**
 * Make the run's credential true on the suite database (a no-op when it already
 * is). Guarded by the marker like every other test-data write, so it can only
 * ever touch a database that declares itself disposable.
 */
async function ensureSuiteLogin(): Promise<void> {
	const { ensureSuiteLoginPassword, SUITE_LOGIN_PASSWORD: constant } = await import(
		'../src/core/test_data/suite_login.ts'
	);
	if (constant !== SUITE_LOGIN_PASSWORD) {
		error(
			`the suite login constant drifted (${SUITE_LOGIN_PASSWORD} here vs ${constant} in src/core/test_data/suite_login.ts)`,
		);
		process.exit(1);
	}
	const outcome = await ensureSuiteLoginPassword(username, password);
	log(`Suite login for '${username}': ${outcome}.`);
}

// ---------------------------------------------------------------------------
// THE DISCLOSED BASELINE — shrink-only, never a blanket.
// ---------------------------------------------------------------------------

/**
 * Suites that are RED TODAY, each with what it actually asserts when it fails.
 *
 * MEASURED 2026-08-20 through THIS runner (which reseeds canonical test3 before
 * the run) against the :4000 dev listener: 131 suites, 131 pass, 0 fail, 0
 * pending, 0 deferred — the whole inventory runs. Two consecutive runs agree,
 * and a `--strict` run is identical because the list below is empty.
 *
 * (!) Measure the baseline WITH the reseed. A hand-driven run against a polluted
 * test3 showed NINE failures — seven of them were leftover state from earlier
 * runs, not bugs. `--no-reseed` is for iterating, never for freezing this list.
 *
 * This list is a LEDGER, not a mute button:
 *  - a failure NOT listed here is red (that is the whole point of the gate);
 *  - a suite listed here that PASSES is ALSO red — fix the bug, delete the row,
 *    in the same change. A stale excuse outliving its bug is how a baseline
 *    turns into a blanket.
 *  - `--strict` ignores the list entirely (every failure red), for the day the
 *    last row goes.
 *
 * These are client/server bugs, not runner problems; each needs its own change.
 * Do NOT add a row to get a run green — a row costs the same reading as the fix.
 *
 * THE LIST IS EMPTY (2026-08-20). Every failure is red on its own, and a plain
 * run is now equivalent to `--strict`. Keep it that way: the next red suite
 * gets a fix, not a row.
 */
/**
 * THE INVENTORY FLOOR — what this run must OBSERVE before its verdict means
 * anything (P0-2, the green-by-absence class) — lives in
 * engineering/client_gate_inventory.json, read and enforced by
 * scripts/lib/client_gate_verdict.ts (the pure verdict, proved by
 * test/unit/client_gate_inventory_tripwire.test.ts). It floors the SUITE count
 * AND the RAN mocha TEST count (each card's `data-test-count` minus its
 * `data-pending-count`), reds any card the page loaded more than once
 * (`data-run-count`), and reds a suite that ran zero tests. It used to be a
 * `SUITE_FLOOR = 128` constant here, which could see cards and nothing else.
 */

const KNOWN_FAILING: ReadonlyMap<string, string> = new Map([]);

/**
 * KNOWN_FLAKY WAS DELETED (2026-08-24), deliberately and without a replacement.
 *
 * It held one name, had no ratchet, no staleness check and no registration: a
 * listed suite that stopped flaking was never reported, so the row could outlive
 * its bug indefinitely. The honest mechanical form — an N-consecutive-green
 * record — needs an artifact nothing here keeps, and the naive rule ("listed but
 * passed → red") cannot work, because passing is what a flaky suite mostly does.
 *
 * So a flaky failure is now simply RED, and gets fixed or quarantined properly.
 * The principle is already stated for KNOWN_FAILING above: a stale excuse
 * outliving its bug is how a baseline turns into a blanket.
 */

// ---------------------------------------------------------------------------
// Stats shape scraped from the runner page.
// ---------------------------------------------------------------------------

// The shapes are the verdict module's: `ScrapedRun` is what `page.evaluate`
// returns (cards as `{status, dataset: {...card.dataset}}`, VERBATIM — the
// browser side knows no attribute name and applies no default), `observeRun`
// interprets it, `RunResults` is what the tail prints. `--replay` reads a
// ScrapedRun, so the subprocess leg exercises the interpretation too.

/**
 * STEP ZERO, BEFORE ANY ENGINE IMPORT — point this process at the suite
 * database and get the fingerprint of its marker row (what every target is
 * then checked against).
 *
 * Order is load-bearing twice over: src/config/config.ts freezes the connection
 * at import, so the repoint must happen before the first dynamic import of
 * anything under src/core/ (the static imports at the top of this file are
 * puppeteer and src/config/env.ts, neither of which connects); and the
 * fingerprint must exist before a server is spawned, because it is what the
 * spawned server is checked against.
 *
 * `localSuiteFingerprint` calls `assertTestDatabase('client_test_runner')`, so
 * the runner's own writes (the test3 reseed, the map-of-grapes fixture) are
 * refused on an unmarked database by the same door as every other test-data
 * writer — the guarantee no longer depends on this file being careful.
 */
async function prepareSuiteDatabase(): Promise<{ suiteDb: string; fingerprint: string }> {
	const { suiteDb, appDb } = resolveSuiteDatabase();
	acquireSuiteRunLock(suiteDb, 'test:client'); // it reseeds test3: one suite run at a time
	// The per-run session store must be in place BEFORE the first engine import:
	// src/core/security/session_store.ts resolves its path once, at import. Only
	// when the run owns its server — an external --url server reads its own
	// default store, and the runner must mint into that one.
	// (suiteServerPaths is pid-derived, so the spawn below computes the same.)
	repointProcessToSuiteDatabase(
		suiteDb,
		externalUrl === undefined ? suiteServerPaths().sessionDbPath : undefined,
	);
	log(`Suite database: ${suiteDb} (the application database '${appDb}' is never served).`);
	return { suiteDb, fingerprint: await localSuiteFingerprint() };
}

/**
 * The verified target: the run's own server, or the one `--url` names — checked
 * the same way either way.
 *
 * CALLED AFTER THE FIXTURES, deliberately. The runner writes them on its OWN
 * connection, so a server that was already up would be holding caches built
 * before those rows existed (that is what the "restart the TS server once"
 * caveat used to be about). A server started AFTER them has no such history —
 * it reads the reseeded playground and the demo ontology at boot. Nothing can
 * be done about that for an external `--url` server, where the caveat stands.
 */
async function openTarget(options: {
	suiteDb: string;
	fingerprint: string;
}): Promise<{ url: string; server?: ClientTestServer }> {
	if (externalUrl !== undefined) {
		const origin = originOf(externalUrl);
		log(`Verifying the server you started at ${origin}...`);
		const served = await probeServedDatabase(origin);
		assertServedDatabase({ origin, expected: options.fingerprint, served });
		log("Verified: that server is on this checkout's suite database.");
		return { url: externalUrl };
	}
	const port = await findFreePort(preferredPort);
	const server = await startClientTestServer({
		suiteDb: options.suiteDb,
		expectedFingerprint: options.fingerprint,
		port,
		log,
	});
	return { url: runnerPageUrl(server.origin), server };
}

/**
 * Ctrl-C MUST NOT LEAVE SCRATCH DATA ON THE SHARED DATABASE.
 *
 * The projects fixture widens the authorized-projects catalog, and `finally`
 * never runs on a signal — so an interrupted run used to hand every later
 * `bun test` tier a catalog the suite database is not supposed to have, with
 * nothing to say where it came from. Registered ONCE, before any fixture is
 * installed; it sweeps, then re-raises the signal by exiting on the conventional
 * 128+n code so a shell still sees an interrupted run as interrupted.
 */
/**
 * Did THIS run install the projects fixture? The sweep REFUSES when it deletes
 * nothing (that refusal is the guarantee the row never survives a run), so it
 * must only be asked on a run that got as far as creating it — otherwise a run
 * that died in `prepareSuiteDatabase` reports a phantom "unaccounted for" row.
 */
let projectsFixtureInstalled = false;
/** Did THIS run install the nesting situation? (swept only then, like the projects row). */
let nestedPortalFixtureInstalled = false;
/**
 * The run-created sweep, armed at the test3 counter when the run started (after
 * the pre-run reseed): every section_id above its mark is a record THIS run
 * created. Null until armed. Its wiring (armed after the reseed, swept in
 * `finally` and on a signal) is pinned by client_situations_native.
 */
let runCreatedSweeper: RunCreatedSweeper | null = null;

/**
 * Sweep the rows the engine wrote about the records this run CREATED
 * (src/core/test_data/run_created_records.ts): a suite's own `delete` leaves
 * the delete's time-machine snapshot and the create/delete activity behind by
 * design, and the reseed keeps TM history — so without this every run grew
 * the suite database (the export suite alone by ~80 snapshots).
 */
async function sweepRunCreatedRecords(): Promise<void> {
	if (runCreatedSweeper === null) return;
	const swept = await runCreatedSweeper.sweep();
	if (swept === null) return; // already swept (signal and finally both ask)
	log(
		`Records created by the run (test3 > ${runCreatedSweeper.mark}): swept ${swept.records} rows, ${swept.timeMachine} time-machine rows, ${swept.activity} activity rows.`,
	);
}

function sweepOnSignal(): void {
	for (const signal of ['SIGINT', 'SIGTERM'] as const) {
		process.on(signal, () => {
			void (async () => {
				error(`${signal} — sweeping scratch fixtures before exit.`);
				try {
					await sweepRunCreatedRecords();
				} catch (err) {
					error(`run-created sweep on ${signal} failed: ${(err as Error).message}`);
				}
				if (projectsFixtureInstalled) {
					try {
						await removeSuiteProjectsFixture();
					} catch (err) {
						error(`sweep on ${signal} failed: ${(err as Error).message}`);
					}
				}
				if (nestedPortalFixtureInstalled) {
					try {
						await removeNestedPortalFixture();
					} catch (err) {
						error(`nested portal sweep on ${signal} failed: ${(err as Error).message}`);
					}
				}
				process.exit(signal === 'SIGINT' ? 130 : 143);
			})();
		});
	}
}

/**
 * THE TAIL OF EVERY RUN — print the results, decide, bank, and hand back the
 * exit code. Shared by the browser run and by `--replay`, so the subprocess leg
 * of client_gate_inventory_tripwire exercises the exact code the browser run
 * exits through. The DECISION is `concludeRun` (scripts/lib/client_gate_verdict.ts);
 * nothing here looks at the verdict except to print it.
 */
function report(results: RunResults): 0 | 1 {
	const verdict: Verdict = computeVerdict({
		axe: results.axe,
		a11yBudget: results.axe === undefined ? undefined : loadA11yBudget(),
		suites: results.suites,
		pending: results.pending,
		strict,
		knownFailing: KNOWN_FAILING,
		inventory: loadInventory(),
	});

	log('\n=== Test Results ===');
	// SUITES and mocha TESTS, both, labelled: `Total` is the CARD count, and a
	// card count cannot see a suite that registered nothing.
	log(
		`Suites:      ${results.total} cards — ${results.pass} pass / ${results.fail} fail / ${results.pending} pending`,
	);
	log(
		`Mocha tests: ${verdict.mochaTests} ran across ${verdict.observedSuites} gated suites (${verdict.mochaPending} pending)`,
	);
	log(`Total:   ${results.total}`);
	log(`Pass:    ${results.pass}`);
	log(`Fail:    ${results.fail}`);
	log(`Pending: ${results.pending}`);
	if (Object.keys(results.groups).length > 0) {
		log('\n--- Per Group ---');
		for (const [group, stats] of Object.entries(results.groups)) {
			log(`${group}: ${stats.pass} pass, ${stats.fail} fail, ${stats.pending} pending`);
		}
	}
	if (results.suites.length > 0) {
		log('\n--- Per Suite (for the coverage ledger) ---');
		for (const suite of results.suites) {
			const count = suite.testCount === null ? '?' : String(suite.testCount);
			const pending = suite.pendingCount ? `, ${suite.pendingCount} pending` : '';
			const loads =
				suite.runCount !== null && suite.runCount > 1 ? ` LOADED ${suite.runCount}x` : '';
			log(
				`  [${suite.status.toUpperCase().padEnd(7)}] ${suite.group}/${suite.name} (${count} tests${pending})${loads}`,
			);
		}
	}
	log('');

	// WHY EACH RED SUITE IS RED — printed for EVERY failing suite, including one
	// listed in KNOWN_FAILING: a known failure with an unknown reason is still
	// unknown. A failing suite with no listed failure never reached mocha
	// (import/setup error, watchdog) — said explicitly, because that is itself a
	// diagnosis.
	const failing = results.suites.filter((s) => s.status === 'fail');
	if (failing.length > 0) {
		log('--- Failure detail ---');
		for (const suite of failing) {
			log(`  ${suite.group}/${suite.name}`);
			if (suite.failures.length === 0) {
				log('    (no mocha failure reported — the suite did not run to completion)');
				continue;
			}
			for (const failure of suite.failures) {
				log(`    ✗ ${failure.title}`);
				for (const line of String(failure.message).split('\n')) {
					log(`        ${line}`);
				}
				if (failure.stack) {
					for (const line of failure.stack.split('\n')) {
						log(`        ${line.trim()}`);
					}
				}
			}
		}
		log('');
	}

	const annotated = failing.filter((s) => KNOWN_FAILING.has(s.name));
	if (!strict && annotated.length > 0) {
		log('--- Known-failing suites (engineering ledger; see KNOWN_FAILING) ---');
		for (const suite of annotated) {
			log(`  [KNOWN  ] ${suite.name} — ${KNOWN_FAILING.get(suite.name)}`);
		}
	}

	// VERDICT + `--update` banking, one pure decision.
	let current = null;
	try {
		current = loadInventory();
	} catch {
		current = null;
	}
	const conclusion = concludeRun(verdict, {
		update: updateInventory,
		current,
		census: staticCensusTotals(),
	});
	for (const line of conclusion.lines) {
		if (line.level === 'error') error(line.text);
		else log(line.text);
	}
	if (conclusion.banked !== null) writeInventory(conclusion.banked);
	return conclusion.exitCode;
}

/**
 * THE ONE EXIT OF EVERY RUN. The browser run (`main`, once its cleanup ran) and
 * `--replay` both end HERE and nowhere else: interpret the scrape, print,
 * decide, exit on the verdict. There is no exit-code variable for a mutation
 * to pin — client_gate_inventory_tripwire measures this function's exit code as
 * a subprocess over planted scrapes, and that measurement is the browser run's
 * exit code too, by construction.
 */
function conclude(scraped: ScrapedRun): never {
	process.exit(report(observeRun(scraped)));
}

/** The browser run: everything up to and including the scrape, then its cleanup. Returns the RAW scrape; `conclude` exits on it. */
/**
 * THE ACCESSIBILITY PHASE (audit 2026-08-26 row P1-18).
 *
 * After the suites have run, the SAME browser mounts the named cataloguing
 * surfaces (client/dedalo/test/client/js/a11y_surfaces.js — built by the
 * client's own builders, from repo-owned inputs, so they are identical on every
 * machine) and runs axe-core over each one. The result rides the ordinary
 * ScrapedRun, so `--replay` can carry it and the ONE exit judges it.
 *
 * No new CI runtime: axe-core is a devDependency, read off disk and injected
 * into the page this run already has open.
 *
 * @param page the run's page, already authenticated
 * @param origin the run's own server origin
 * @returns what axe saw, per surface
 */
async function runAxePhase(page: Page, origin: string): Promise<AxeObservation> {
	const axeSource = readFileSync(
		join(import.meta.dir, '..', 'node_modules', 'axe-core', 'axe.min.js'),
		'utf8',
	);
	const framePage = `${origin}/dedalo/test/client/frame.html?area=a11y_surfaces`;
	log(`a11y: mounting the named surfaces (${framePage})`);
	const response = await page.goto(framePage, { waitUntil: 'networkidle0', timeout: 30000 });
	if (!response?.ok()) {
		throw new Error(`a11y phase: the surfaces page did not load (${response?.status()})`);
	}
	await page.waitForFunction('window.dd_a11y_surfaces !== undefined', { timeout: 20000 });
	await page.evaluate(axeSource);

	const observed: { surfaces: string[]; violations: AxeViolation[] } = await page.evaluate(
		async () => {
			const w = window as unknown as {
				dd_a11y_surfaces: { SURFACE_BUILDERS: Record<string, () => unknown | Promise<unknown>> };
				axe: {
					run: (
						ctx: unknown,
						options: unknown,
					) => Promise<{
						violations: Array<{ id: string; impact: string | null; nodes: unknown[] }>;
					}>;
				};
			};
			const surfaces: string[] = [];
			const violations: Array<{
				surface: string;
				id: string;
				impact: string | null;
				nodes: number;
			}> = [];
			for (const name of Object.keys(w.dd_a11y_surfaces.SURFACE_BUILDERS)) {
				const builder = w.dd_a11y_surfaces.SURFACE_BUILDERS[name];
				if (builder === undefined) continue;
				// AWAITED: a builder may be async (the login form asks the server for
				// its own context). Reading the host before it resolved would run axe
				// over an empty div and call the surface clean.
				await builder();
				const host = document.getElementById(`a11y_surface_${name}`);
				// EMPTY IS NOT MOUNTED. The host is created before the surface is
				// filled, so a builder that threw — or an async one whose promise was
				// not awaited — would leave an empty div here and axe would call it
				// clean. Such a surface is reported as NOT mounted, which is red for
				// every required one.
				if (host === null || host.children.length === 0) continue;
				surfaces.push(name);
				const result = await w.axe.run(host, {
					runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
				});
				for (const violation of result.violations) {
					violations.push({
						surface: name,
						id: violation.id,
						impact: violation.impact ?? null,
						nodes: violation.nodes.length,
					});
				}
			}
			return { surfaces, violations };
		},
	);

	const sorted: AxeViolation[] = observed.violations.sort((a, b) =>
		`${a.surface}:${a.id}` < `${b.surface}:${b.id}` ? -1 : 1,
	);
	log(`a11y: ${observed.surfaces.length} surface(s), ${sorted.length} violation kind(s)`);
	return { surfaces: observed.surfaces, violations: sorted };
}

async function main(): Promise<ScrapedRun> {
	let browser: Browser | undefined;
	let server: ClientTestServer | undefined;

	sweepOnSignal();
	try {
		const suite = await prepareSuiteDatabase();
		if (authMode !== 'mint') {
			await ensureSuiteLogin();
		}
		if (reseedEnabled) {
			await reseedCanonicalTest3('pre-run');
			await ensureMapOfGrapesFixture();
		}
		// Measured AFTER the reseed (which may raise the counter), before any suite runs.
		{
			const { armRunCreatedSweep } = await import('../src/core/test_data/run_created_records.ts');
			runCreatedSweeper = await armRunCreatedSweep();
		}
		// OUTSIDE the reseed block, deliberately. `--no-reseed` skips restoring the
		// test3 playground to iterate faster; it must not also remove a SITUATION a
		// suite asserts against. test_component_filter requires the projects
		// catalog to offer more options than the record selects, so without this
		// row `--no-reseed` would fail a suite that has nothing wrong with it — a
		// documented flag turning a green suite red is worse than the seconds it
		// saves. The fixture sweeps itself first, so it is idempotent.
		await ensureSuiteProjectsFixture();
		projectsFixtureInstalled = true;
		// Same reasoning as the projects row: a SITUATION a suite asserts against,
		// installed whatever `--no-reseed` says.
		await ensureNestedPortalFixture();
		nestedPortalFixtureInstalled = true;
		await assertSuiteDiffusionSurface();
		const target = await openTarget(suite);
		const testUrl = target.url;
		server = target.server;
		log(`Navigating to ${testUrl}...`);
		log(`Timeout set to ${timeout}ms`);

		// Prefer an explicit browser path (PUPPETEER_EXECUTABLE_PATH), else fall back
		// to a system Chrome install via `channel` so we don't require Puppeteer's
		// bundled-Chromium download (kept out of install to stay lightweight/CI-friendly).
		const executablePath = readEnv('PUPPETEER_EXECUTABLE_PATH');
		browser = await puppeteer.launch({
			headless,
			args: ['--no-sandbox', '--disable-setuid-sandbox'],
			...(executablePath ? { executablePath } : { channel: 'chrome' as const }),
		});

		const page = await browser.newPage();
		await page.setViewport({ width: 1280, height: 1024 });

		// Accept native dialogs (e.g. the remove-confirm `confirm()`); without a
		// handler Chrome auto-dismisses them, cancelling remove/reset operations
		// that several suites exercise.
		page.on('dialog', (dialog) => {
			dialog.accept().catch(() => {});
		});
		page.on('pageerror', (err) => {
			error(`Page error: ${err instanceof Error ? err.message : String(err)}`);
		});

		const response = await page.goto(testUrl, { waitUntil: 'networkidle0', timeout: 30000 });
		if (!response?.ok()) {
			error(`Failed to load test page: ${response?.status()} ${response?.statusText()}`);
			error(
				"The run's own server answered /health but not the client page — check its output above.",
			);
			throw new Error('test page did not load');
		}
		log('Page loaded successfully.');

		await page.waitForSelector('#test_run_all', { timeout: 10000 });

		const needsLogin = await page.evaluate(() => {
			const globals = (window as unknown as { page_globals?: { is_logged?: boolean } })
				.page_globals;
			return globals?.is_logged !== true;
		});

		if (needsLogin) {
			if (!username || (!password && authMode !== 'mint')) {
				error('Login required but credentials not provided.');
				error(
					'The suite database supplies its own credential; pass --user/--password only to override it.',
				);
				process.exit(1);
			}
			if (authMode === 'cookie' || authMode === 'mint') {
				log(
					authMode === 'mint'
						? `Login required, MINTING a session for '${username}' WITHOUT a password...`
						: 'Login required, minting a session (real login, no form)...',
				);
				await injectSessionCookie(browser, page, testUrl, username, password, authMode);
			} else {
				log('Login required, attempting form login...');
				await handleLogin(page, username, password);
			}
		}

		// Sidebar fully populates from test_registry.js once logged in.
		await page.waitForSelector('#test_run_all:not([disabled])', { timeout: 10000 });

		log('Starting tests...');
		await page.click('#test_run_all');

		// Poll for completion: the run-all button re-enables when the queue drains.
		const startTime = performance.now();
		let completed = false;
		while (performance.now() - startTime < timeout) {
			completed = await page.evaluate(() => {
				const button = document.getElementById('test_run_all') as HTMLButtonElement | null;
				return button !== null && !button.disabled;
			});
			if (completed) {
				break;
			}
			await new Promise((r) => setTimeout(r, 1000));
		}

		if (!completed) {
			error(`Tests did not complete within ${timeout}ms timeout.`);
			process.exit(1);
		}
		log('Tests completed. Collecting results...');

		const scraped: ScrapedRun = await page.evaluate(() => {
			const stats =
				(window as unknown as { global_stats?: Partial<ScrapedRun['counters']> }).global_stats ??
				{};
			const groups: ScrapedRun['groups'] = {};
			for (const el of document.querySelectorAll('.test_group')) {
				const groupKey = (el as HTMLElement).dataset.group;
				const statsBar = el.querySelector('.test_group_stats');
				if (groupKey && statsBar) {
					const num = (sel: string) =>
						Number.parseInt(statsBar.querySelector(sel)?.textContent || '0', 10);
					groups[groupKey] = {
						pass: num('.group_stat_pass'),
						fail: num('.group_stat_fail'),
						pending: num('.group_stat_pending'),
					};
				}
			}
			// Per-suite outcome: the dot's status class and the card's dataset,
			// VERBATIM. Nothing is interpreted here — `observeCard`
			// (scripts/lib/client_gate_verdict.ts) reads the attributes, and the
			// hermetic gate drives it over a dataset the page's own card_state.js
			// produced. A default applied in this closure would run in no gate.
			const cards: ScrapedCard[] = [];
			for (const card of document.querySelectorAll('.test_card')) {
				const dot = card.querySelector('.test_card_status');
				// 'deferred' FIRST: a deferred card is excluded from run-all and from
				// the page's counters by design (test_registry.js). Reading it as
				// 'pending' made three known-deferred suites look like a stalled run.
				const status =
					['deferred', 'pass', 'fail', 'running', 'pending'].find((s) =>
						dot?.classList.contains(s),
					) ?? 'pending';
				cards.push({ status, dataset: { ...(card as HTMLElement).dataset } });
			}
			return {
				cards,
				counters: {
					total: stats.total || 0,
					pass: stats.pass || 0,
					fail: stats.fail || 0,
					pending: stats.pending || 0,
				},
				groups,
			};
		});

		// The accessibility phase runs LAST: it navigates the page away from the
		// runner, so nothing after it may read the runner's DOM.
		scraped.axe = await runAxePhase(page, originOf(testUrl));

		return scraped;
	} finally {
		if (browser) {
			await browser.close();
		}
		// Whatever the reseed flag says: these rows are the run's own.
		try {
			await sweepRunCreatedRecords();
		} catch (err) {
			error(`post-run sweep of run-created records failed: ${(err as Error).message}`);
		}
		if (reseedEnabled) {
			// Never mask the test exit code with a reseed failure.
			try {
				await reseedCanonicalTest3('post-run');
			} catch (err) {
				error(`post-run reseed failed: ${(err as Error).message}`);
			}
		}
		// Swept whatever the reseed flag says, because it is INSTALLED whatever the
		// reseed flag says (see above). This row widens the authorized-projects
		// catalog on the SHARED suite database, so leaving it behind changes what
		// the unit and parity tiers see.
		if (projectsFixtureInstalled) {
			try {
				await removeSuiteProjectsFixture();
			} catch (err) {
				error(`post-run projects fixture sweep failed: ${(err as Error).message}`);
			}
		}
		if (nestedPortalFixtureInstalled) {
			try {
				await removeNestedPortalFixture();
			} catch (err) {
				error(`post-run nested portal fixture sweep failed: ${(err as Error).message}`);
			}
		}
		// The run owns its server: it must not outlive the run (an orphan holds
		// the port and the next run picks a different one, silently).
		if (server !== undefined) {
			try {
				await server.stop();
				log("The run's own server stopped.");
			} catch (err) {
				error(`stopping the client-test server failed: ${(err as Error).message}`);
			}
		}
	}
}

/**
 * COOKIE AUTH — a REAL login, without the form.
 *
 * Calls `login()` (core/security/auth.ts) in this process: the same password
 * verification, the same throttle, the same session row in the shared session
 * store (../private/dedalo_ts_sessions.sqlite — the server reads the very row
 * this writes), the same audit line. Then it injects the session cookie into
 * the browser and reloads, which is the ONLY thing the form was doing that
 * this skips.
 *
 * Why not the form: it is a two-step reveal ("Siguiente" → "Entrar"), and on a
 * dev box the second step regularly loses the submit, so the wait for
 * `is_logged` times out and the gate cannot run AT ALL. `--auth form` keeps
 * that path for when the login UI itself is what you want to exercise.
 *
 * The cookie is HttpOnly, so it must be set through CDP (`browser.setCookie`)
 * — `document.cookie` in the page cannot write it. The media-auth cookie rides
 * along when login issued one, or the media-bearing suites see 404s.
 */
async function injectSessionCookie(
	browser: Browser,
	page: Page,
	url: string,
	user: string,
	pass: string,
	mode: string,
): Promise<void> {
	const { SESSION_COOKIE } = await import('../src/core/security/session_store.ts');
	const { MEDIA_AUTH_COOKIE } = await import('../src/core/media/protection.ts');

	const result = mode === 'mint' ? await mintSessionForUser(user) : await realLogin(user, pass);
	if (!result.ok || result.sessionToken === undefined) {
		error(`Login refused for '${user}': ${result.message}`);
		throw new Error('Login failed');
	}
	const { hostname } = new URL(url);
	await browser.setCookie({
		name: SESSION_COOKIE,
		value: result.sessionToken,
		domain: hostname,
		path: '/',
	});
	if (result.mediaAuthCookieValue !== undefined && result.mediaAuthCookieValue !== null) {
		await browser.setCookie({
			name: MEDIA_AUTH_COOKIE,
			value: result.mediaAuthCookieValue,
			domain: hostname,
			path: '/',
		});
	}
	await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
	const logged = await page.evaluate(() => {
		const globals = (window as unknown as { page_globals?: { is_logged?: boolean } }).page_globals;
		return globals?.is_logged === true;
	});
	if (!logged) {
		error('Session cookie injected but page_globals.is_logged is still not true.');
		throw new Error('Login failed');
	}
	log(`Login successful (session for '${user}', cookie injected).`);
}

/** What either auth path hands back to the cookie injector. */
interface RunnerSession {
	ok: boolean;
	message: string;
	sessionToken?: string;
	mediaAuthCookieValue?: string;
}

/** The real thing: password verified, throttle applied, audit line written. */
async function realLogin(user: string, pass: string): Promise<RunnerSession> {
	const { login } = await import('../src/core/security/auth.ts');
	return await login(user, pass, '127.0.0.1');
}

/**
 * DEV ESCAPE HATCH (`--auth mint`): a session for an EXISTING user, no
 * password. It still resolves the real user row and the real admin grant
 * (resolvePrincipal), so the session is not a fabricated superuser — but NO
 * CREDENTIAL IS CHECKED. Refuses an unknown username, so it cannot invent a
 * user, and announces itself every run.
 */
async function mintSessionForUser(user: string): Promise<RunnerSession> {
	error('--auth mint: NO PASSWORD IS VERIFIED. This run does not exercise authentication.');
	const { sql } = await import('../src/core/db/postgres.ts');
	const rows = (await sql`
		SELECT section_id
		FROM matrix_users
		WHERE section_tipo = 'dd128'
		  AND string->'dd132'->0->>'value' = ${user}
		LIMIT 1
	`) as { section_id: number }[];
	const row = rows[0];
	if (row === undefined) {
		return { ok: false, message: `no such user '${user}' in this database` };
	}
	const { resolvePrincipal } = await import('../src/core/security/permissions.ts');
	const { createSession } = await import('../src/core/security/session_store.ts');
	const { isGlobalAdmin } = await resolvePrincipal(row.section_id);
	// Mint this session's MEDIA credential too, exactly as login does. Skipping it would
	// hand the run a session with no media access, so every image/av/pdf the suite loads
	// would 404 under a configured mode — and since the default became fail-closed, that
	// is now the ordinary case rather than an exotic one.
	const { issueSessionMediaKey } = await import('../src/core/media/protection.ts');
	const mediaKey = issueSessionMediaKey();
	return {
		ok: true,
		message: 'ok',
		sessionToken: createSession(row.section_id, user, isGlobalAdmin, mediaKey),
	};
}

/**
 * Log in through the copied client's own login form. The TS-served client uses
 * `#username` + `#auth` (password), with a two-step reveal ("Siguiente" → then
 * "Entrar"). We fill both fields (both live in the DOM) and click the login
 * form's submit button, then wait for `page_globals.is_logged === true`.
 */
async function handleLogin(page: Page, user: string, pass: string): Promise<void> {
	try {
		await page.waitForSelector('#username', { timeout: 5000 });

		await page.evaluate(
			(u, p) => {
				const setValue = (el: Element | null, value: string) => {
					if (el) {
						(el as HTMLInputElement).value = value;
						el.dispatchEvent(new Event('input', { bubbles: true }));
						el.dispatchEvent(new Event('change', { bubbles: true }));
					}
				};
				setValue(document.querySelector('#username'), u);
				setValue(document.querySelector('#auth'), p);

				// Click the visible login button. The login form uses `.button_enter`;
				// its two steps are "Siguiente" (reveal) then "Entrar" (submit). Prefer
				// the submit button; otherwise click whichever `.button_enter` is shown.
				const isVisible = (el: Element) => (el as HTMLElement).offsetParent !== null;
				const enters = Array.from(
					document.querySelectorAll<HTMLButtonElement>('.button_enter'),
				).filter(isVisible);
				const submit = enters.find((b) => b.type === 'submit') ?? enters[0] ?? null;
				submit?.click();
			},
			user,
			pass,
		);

		// If a two-step form only advanced past "Siguiente", the password field is
		// now revealed but not submitted — fill again and submit the final step.
		await page
			.waitForFunction(
				() => {
					const globals = (window as unknown as { page_globals?: { is_logged?: boolean } })
						.page_globals;
					return globals?.is_logged === true;
				},
				{ timeout: 10000 },
			)
			.catch(async () => {
				await page.evaluate(
					(u, p) => {
						const setValue = (el: Element | null, value: string) => {
							if (el) {
								(el as HTMLInputElement).value = value;
								el.dispatchEvent(new Event('input', { bubbles: true }));
								el.dispatchEvent(new Event('change', { bubbles: true }));
							}
						};
						setValue(document.querySelector('#username'), u);
						setValue(document.querySelector('#auth'), p);
						const submit = document.querySelector<HTMLButtonElement>(
							'.button_enter[type="submit"]',
						);
						submit?.click();
					},
					user,
					pass,
				);
				await page.waitForFunction(
					() => {
						const globals = (window as unknown as { page_globals?: { is_logged?: boolean } })
							.page_globals;
						return globals?.is_logged === true;
					},
					{ timeout: 10000 },
				);
			});

		log('Login successful.');
	} catch (err) {
		error(`Login failed: ${(err as Error).message}`);
		throw new Error('Login failed');
	}
}

if (args.includes('--check') && args.includes('--json')) {
	// THE STATIC HALF of the inventory, for `baselines:bank` (scripts/lib/ratchet_check.ts):
	// no browser, no server, no DB — the three numbers the hermetic tripwire derives from
	// the tree. Exits 1 on any drift, like every ratchet's --check.
	const { check } = staticInventoryVerdict(loadInventory(), staticCensusTotals(), gatedCardCount());
	process.exit(emitRatchetCheck(check, log));
} else if (args.includes('--bank-static')) {
	// Bank the static half, IMPROVEMENTS ONLY: a budget that fell, a suite floor that rose.
	// Anything the other way is refused exactly as `--update` refuses it — a lowered
	// floor or a raised budget is a hand edit whose commit says why, never a regeneration.
	const { check, next } = staticInventoryVerdict(
		loadInventory(),
		staticCensusTotals(),
		gatedCardCount(),
	);
	if (check.regressions.length > 0) {
		error(
			`--bank-static REFUSED — the static inventory moved the wrong way:\n  ${check.regressions.join('\n  ')}\nFix it, or edit engineering/client_gate_inventory.json by hand and say why in the commit.`,
		);
		process.exit(1);
	}
	if (check.improvements.length > 0) writeInventory(next);
	log(
		check.improvements.length > 0
			? `--bank-static: banked ${check.improvements.join('; ')}`
			: '--bank-static: nothing to bank',
	);
	process.exit(0);
} else if (replayFile !== undefined) {
	log(`--replay: ${replayFile} (no browser, no server)`);
	conclude(JSON.parse(readFileSync(replayFile, 'utf8')) as ScrapedRun);
} else {
	main().then(conclude, (err: Error) => {
		error(`Unexpected error: ${err.message}`);
		if (err.stack) error(err.stack);
		process.exit(1);
	});
}
