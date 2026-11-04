/**
 * CLIENT TEST SERVER (interactive) — the browser page on the SUITE database.
 *
 * `bun run test:client:server [--port <n>]`
 *
 * The headless runner (scripts/client_test_runner.ts) starts its own verified
 * server, runs everything and exits. This is the human counterpart: the SAME
 * suite database, served for browsing `/dedalo/test/client/index.html` by hand
 * — running one area with DevTools open, stepping a failing suite in the UI.
 * Without it the only page a developer has is their dev server's, which serves
 * the APPLICATION database — where the test-TLD fixtures do not exist, so
 * fixture-bound suites die in request.invalid_tipo and read like engine bugs.
 *
 * Same door as the runner, every step:
 *   repoint to the suite db → set its login credential → install the projects
 *   fixture → verify /health answers this checkout's marker fingerprint → serve.
 *   Ctrl-C sweeps the fixture and stops the server cleanly.
 *
 * What it deliberately does NOT do is reseed the canonical test3 playground: a
 * hand-browsed page is for inspecting state, and wiping it on every start would
 * defeat that. A suite that needs a pristine test3 is a `bun run test:client`
 * job — the reseed is the runner's, and only the runner's.
 */

import { acquireSuiteRunLock } from '../test/helpers/suite_run_lock.ts';
import {
	findFreePort,
	localSuiteFingerprint,
	repointProcessToSuiteDatabase,
	resolveSuiteDatabase,
	startClientTestServer,
} from './client_test_server.ts';

const args = Bun.argv.slice(2);
const portFlag = args.indexOf('--port');
const portValue = portFlag === -1 ? undefined : args[portFlag + 1];
const preferredPort = portValue === undefined ? 4390 : Number.parseInt(portValue, 10);

const { suiteDb } = resolveSuiteDatabase();
repointProcessToSuiteDatabase(suiteDb);
acquireSuiteRunLock(suiteDb, 'test:client:server'); // one suite run at a time

// The install seed ships root with NO password; set the suite credential so the
// page's own login form works, exactly as ensureSuiteLogin does for the runner.
const { ensureSuiteLoginPassword, SUITE_LOGIN_PASSWORD } = await import(
	'../src/core/test_data/suite_login.ts'
);
console.log(
	`suite login '${await ensureSuiteLoginPassword('root', SUITE_LOGIN_PASSWORD)}': root / ${SUITE_LOGIN_PASSWORD}`,
);

// The SECOND dd153 project `test_component_filter.js` needs: with the single
// installed project already checked there is no unchecked box, so the widget's
// check/uncheck cases are not expressible (src/core/test_data/projects_fixture.ts).
// The runner installs it whatever `--no-reseed` says; the browsed page needs it
// for the same reason, and BEFORE the server spawns so it reads the row cold —
// the save event that drops the authorized-projects cache only reaches THIS
// process. It widens a catalog on the SHARED suite database, so the exit path
// below sweeps it: leaving it behind changes what the unit and parity tiers see.
const { ensureSuiteProjectsFixture, removeSuiteProjectsFixture } = await import(
	'../src/core/test_data/projects_fixture.ts'
);
await ensureSuiteProjectsFixture();
// Only a run that got this far may sweep: the sweep REFUSES when it deletes
// nothing, and that refusal is the guarantee the row never survives a run.
let projectsFixtureInstalled = true;
console.log('Suite projects fixture (dd153 second project): ensured.');
// The nesting situation test_nested_portal.js needs (a real caller whose map
// declares test80's children — src/core/test_data/nested_portal_fixture.ts):
// same lifecycle, same cold-read reason.
const { ensureNestedPortalFixture, removeNestedPortalFixture } = await import(
	'../src/core/test_data/nested_portal_fixture.ts'
);
// Armed BEFORE the ensure: its node upserts commit before its last check can
// throw, so a failed ensure may still leave rows the sweep must take.
let nestedPortalFixtureInstalled = false;

/**
 * Sweep every fixture this run installed (each once, guarded by its flag). The
 * ONE cleanup of both exits: a failed startup below and Ctrl-C (stop) — a
 * fixture left in the shared suite DB widens what every unit and parity gate
 * sees (nested_portal_fixture.ts header).
 */
const sweepFixtures = async (): Promise<void> => {
	if (projectsFixtureInstalled) {
		projectsFixtureInstalled = false;
		try {
			await removeSuiteProjectsFixture();
			console.log('Suite projects fixture (dd153 second project): swept.');
		} catch (err) {
			console.error(`projects fixture sweep failed: ${(err as Error).message}`);
		}
	}
	if (nestedPortalFixtureInstalled) {
		nestedPortalFixtureInstalled = false;
		try {
			await removeNestedPortalFixture();
			console.log('Nested portal fixture: swept.');
		} catch (err) {
			console.error(`nested portal fixture sweep failed: ${(err as Error).message}`);
		}
	}
};

// Everything between the first install and the signal handlers can throw (the
// nested ensure, no free port, a /health fingerprint mismatch, a server that
// never boots): sweep, then rethrow.
let server: Awaited<ReturnType<typeof startClientTestServer>>;
try {
	nestedPortalFixtureInstalled = true;
	await ensureNestedPortalFixture();
	console.log('Nested portal fixture (verified caller chain for test80): ensured.');
	const port = await findFreePort(preferredPort);
	const expected = await localSuiteFingerprint();
	server = await startClientTestServer({ suiteDb, expectedFingerprint: expected, port });
} catch (err) {
	await sweepFixtures();
	throw err;
}

console.log(`\nClient tests on the SUITE database ('${suiteDb}'):`);
console.log(`  ${server.origin}/dedalo/test/client/index.html`);
console.log('\nCtrl-C stops the server and sweeps the projects and nested portal fixtures.');

let stopping = false;
const stop = async (): Promise<void> => {
	if (stopping) return;
	stopping = true;
	await sweepFixtures();
	await server.stop();
	process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30); // keep the event loop alive; stop() owns exit
