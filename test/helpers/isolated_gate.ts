/**
 * A GATE THAT SUBSTITUTES A CLIENT MODULE RUNS IN ITS OWN PROCESS.
 *
 * WHY. `bun test` runs every file of a tier in ONE process, and the two ways a
 * gate replaces a browser module — `mock.module` and `Bun.plugin` — are
 * process-global: `mock.restore()` does not revert a module mock, a plugin
 * cannot be unregistered (and survives `--isolate`), and the client modules
 * under test (`common.js`, `component_common.js`, `instances.js` …) are loaded
 * ONCE per process, binding whichever `ui.js` / `events.js` stub was live at
 * that moment. So each client gate measured the stubs of whatever client gate
 * ran before it: green on the Mac, whose readdir is alphabetical, and ~30 reds
 * in the CI image, whose readdir is hash-ordered (measured 2026-10-02 — the
 * upload queue, the data-model guard, the info widget, the render queue, the
 * in-flight registry, the build-failure panel, the TM list and section_record
 * rows). Every earlier repair re-masked the module in the victim and left the
 * same shape of leak behind (transcription_status_panel says so in its own
 * comments); the class only ends when the substitution cannot outlive its file.
 *
 * HOW. The gate's file is loaded twice:
 *   - in the tier's process it registers NOTHING of its own: `mirrorIsolatedGate`
 *     runs `bun test ./<file>` in a child (repo root, so bunfig's preloads arm the
 *     suite database and media root exactly as for any test; `childEnv()` strips
 *     the per-run seams a child must re-derive), parses the child's JUnit, and
 *     registers one case per child case under the SAME full name, asserting the
 *     child's verdict with the child's failure text;
 *   - in the child (`isIsolatedGateChild` true) the real body registers and runs,
 *     alone in its process.
 * The child runs with Bun's on-disk transpiler cache OFF (see runIsolated): that
 * cache bakes plugin-resolved imports into a module's cached build and serves
 * them to every later process, so without it isolation by process isolates
 * nothing.
 * A mirrored case re-executes its `expect` as many times as the child case
 * executed assertions, so the per-file assertion floor (red_baseline per_file)
 * keeps measuring the child's real count — a child that asserts less makes the
 * parent assert less. A child that crashed or reported no case is ONE failing
 * case carrying its stderr tail — never a silent pass.
 *
 * Gate: mock_isolation_tripwire (rule 4) — every test file that substitutes a
 * client module in-process (mock.module of a client/ or tools/ path, or a
 * Bun.plugin) is an isolated gate.
 */

import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { childEnv, type ParityRun, parseJunit } from '../../scripts/lib/parity_census.ts';
import { TEST_TIMEOUT_FLAG, TEST_TIMEOUT_MS } from '../../scripts/lib/test_flags.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');

/** The whole isolated child's budget: ten per-test timeouts. */
const CHILD_TIMEOUT_MS = 10 * TEST_TIMEOUT_MS;

/** The env key naming the ONE file a child process runs as an isolated gate. */
export const ISOLATED_GATE_KEY = 'DEDALO_ISOLATED_GATE';

function repoRelative(file: string): string {
	return relative(REPO_ROOT, file).split('\\').join('/');
}

/**
 * A PINNED ENVIRONMENT for an isolated gate's child, keyed by the gate's
 * repo-relative path. The second reason a gate runs alone: it needs a CONFIG
 * value the engine reads ONCE at module load (e.g. `CLIENT_MAX_LIMIT` from
 * DEDALO_SEARCH_CLIENT_MAX_LIMIT), so the only honest way to measure the
 * engine under that value is a process that boots with it. Declared here — not
 * passed at the call site — so the guard statement keeps its one shape
 * (`census_derivation_tripwire` reads it). Keys a test must NOT pin (the lane
 * database, the media root, the session store) are refused below.
 */
export const ISOLATED_GATE_ENV: Readonly<Record<string, Readonly<Record<string, string>>>> = {
	'test/unit/client_page_doors_native.test.ts': { DEDALO_SEARCH_CLIENT_MAX_LIMIT: '3' },
	'test/unit/export_selection_cursor_native.test.ts': {
		DB_POOL_MAX: '4',
		DEDALO_SEARCH_CLIENT_MAX_LIMIT: '3',
	},
	// The menu's DATA_LANG apart from DATA_LANG_DEFAULT (lg-spa in the suite), so a
	// static pick that read the MENU lang instead of the install main one is red.
	'test/unit/request_lang_static_default_native.test.ts': { DATA_LANG: 'lg-eng' },
	// The same split for the stdio MCP server: its service account is served the
	// web-login seed (DATA_LANG), and a call with no scope would read DATA_LANG_DEFAULT.
	'test/unit/mcp_stdio_request_lang_native.test.ts': { DATA_LANG: 'lg-eng' },
	// change_lang's data-language sync is boot config: pinned ON so the rule
	// "the data lang follows the interface lang only when it is a data lang" runs.
	// DEDALO_APPLICATION_LANGS adds lg-zzzq: an INTERFACE language the install does
	// not catalogue data in (the suite's own map has none), the case the rule is for.
	'test/unit/change_lang_sync_native.test.ts': {
		DATA_LANG_SYNC: 'true',
		DEDALO_APPLICATION_LANGS:
			'{"lg-spa":"Castellano","lg-cat":"Català","lg-eng":"English","lg-zzzq":"Zzzq (interface only)"}',
	},
};

/** Seams an isolated gate's pinned env may never set: the child derives them. */
const UNPINNABLE_KEYS = new Set([
	'DEDALO_TEST_DATABASE',
	'DEDALO_TEST_MEDIA_ROOT',
	'DEDALO_TEST_RAG_DB_NAME',
	'DEDALO_SESSION_DB_PATH',
	'DB_NAME',
	ISOLATED_GATE_KEY,
]);

function pinnedEnv(target: string): Record<string, string> {
	const pinned = ISOLATED_GATE_ENV[target] ?? {};
	for (const key of Object.keys(pinned)) {
		if (UNPINNABLE_KEYS.has(key)) {
			throw new Error(
				`isolated_gate: '${target}' pins '${key}', a per-run seam the child must derive itself`,
			);
		}
	}
	return { ...pinned };
}

/** True in the gate's own child process — the only place its real body may register. */
export function isIsolatedGateChild(file: string): boolean {
	return process.env[ISOLATED_GATE_KEY] === repoRelative(file);
}

/** Run `file` alone in a child `bun test` and return what its JUnit report said. */
function runIsolated(file: string): { run: ParityRun | null; exitCode: number; stderr: string } {
	const target = repoRelative(file);
	const dir = mkdtempSync(join(tmpdir(), 'dedalo-isolated-gate-'));
	const outfile = join(dir, 'gate.junit.xml');
	// childEnv() marks its child as a tier census (its recursion guard); this child
	// is one gate, not a census — it carries the parent's own state of that flag.
	const { DEDALO_TIER_CENSUS_RUNNING: _censusMark, ...base } = childEnv();
	const census = process.env.DEDALO_TIER_CENSUS_RUNNING;
	const env: Record<string, string | undefined> = {
		...base,
		...(census === undefined ? {} : { DEDALO_TIER_CENSUS_RUNNING: census }),
		...pinnedEnv(target),
		[ISOLATED_GATE_KEY]: target,
		// NO TRANSPILER CACHE in the child. Bun's runtime transpiler cache (on disk,
		// shared by every process of the machine, keyed by source — not by the
		// plugins live when it was written) stores a module's RESOLVED imports. A
		// plugin redirect therefore outlives its process: measured 2026-10-02 on the
		// Mac, client_relation_move_native ALONE, in a fresh process, imported
		// component_change_value_refresh's utils stub ("Export named 'strip_tags'
		// not found in …/client_module_stubs/utils_index.js") from a cache entry an
		// earlier run had written — and that gate, alone, loaded the REAL ui.js its
		// plugin redirects, from an entry written without the plugin. Off, a gate's
		// redirects can neither be read from nor written into another run.
		BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
	};
	try {
		const proc = Bun.spawnSync(
			[
				process.execPath,
				'test',
				TEST_TIMEOUT_FLAG,
				'--reporter=junit',
				`--reporter-outfile=${outfile}`,
				`./${target}`,
			],
			// A bound on the whole child: a wedged gate must red its tier, never hang
			// it (the per-test timeout does not cover a hang at import or in a hook).
			{ cwd: REPO_ROOT, env, stdout: 'pipe', stderr: 'pipe', timeout: CHILD_TIMEOUT_MS },
		);
		let run: ParityRun | null = null;
		try {
			run = parseJunit(readFileSync(outfile, 'utf8'));
		} catch {
			run = null;
		}
		return { run, exitCode: proc.exitCode ?? -1, stderr: proc.stderr.toString() };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * The tier-process half: run the gate alone, then register its cases here.
 * Call at module scope, before (and instead of) the gate's own body.
 */
export function mirrorIsolatedGate(file: string): void {
	const target = repoRelative(file);
	const { run, exitCode, stderr } = runIsolated(file);
	const tail = stderr.split('\n').slice(-30).join('\n');
	if (run === null || run.cases.length === 0) {
		test(`isolated gate ${target} ran`, () => {
			expect(
				run?.cases.length ?? 0,
				`the isolated child reported no case (exit ${exitCode}) — it crashed before its first test:\n${tail}`,
			).toBeGreaterThan(0);
		});
		return;
	}
	for (const c of run.cases) {
		if (c.status === 'skip') {
			test.skip(c.name, () => {});
			continue;
		}
		test(c.name, () => {
			const times = Math.max(1, c.assertions ?? 1);
			for (let i = 0; i < times; i++) {
				expect(c.status, c.failure ?? `failed in the isolated child (exit ${exitCode})`).toBe(
					'pass',
				);
			}
		});
	}
	// Every case passed but the child still failed: an error between tests
	// (an unhandled rejection, a failing hook) that no case carries.
	if (exitCode !== 0 && run.cases.every((c) => c.status !== 'fail')) {
		test(`isolated gate ${target} exited cleanly`, () => {
			expect(exitCode, `the isolated child exited ${exitCode} with no failing case:\n${tail}`).toBe(
				0,
			);
		});
	}
}
