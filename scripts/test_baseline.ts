/**
 * TEST BASELINE HARNESS — the per-test, per-run measurement that can actually
 * prove a future suite run (e.g. a parallel one) EQUALS the recorded serial one.
 *
 * WHY THE OLD BASELINE COULD NOT (all four measured on the recorded Bun 1.4.0
 * logs, 2026-08-25):
 *  - bun's default reporter emits a line ONLY for failures. The recorded run
 *    logs contain zero '(pass)' lines; the 55 skips are a single integer. A
 *    "baseline" that never names its greens cannot detect a green that stopped
 *    being green by DISAPPEARING.
 *  - THREE failset lines are the byte-identical string '(fail) (unnamed)' —
 *    hook-level failures with no attribution at all. A set comparison collapses
 *    three distinct failures into one.
 *  - No file attribution: "parallelism broke a DIFFERENT file" and "the same
 *    file broke again" are the same line in a name-only failset.
 *  - 132 test files use test.if/describe.if/skipIf. A test that stops being
 *    REGISTERED makes the failset SMALLER — and the repo's own precedent
 *    ("strict SUBSET … zero new failures") scores a smaller failset as a PASS.
 *    That is the hole: a change that silently deregisters half a tier looks
 *    like an improvement.
 *
 * WHAT THIS TOOL DOES INSTEAD. It runs the suite under bun's JUnit reporter —
 * the ONLY reporter that emits a record per test, with file attribution and a
 * per-case duration — and records a THREE-STATE outcome (pass | fail | skip;
 * plus 'absent' when a key stops being registered) for EVERY key, per run:
 *
 *  - FIXED-ORDER CAMPAIGN (default; K runs, default 5): the serial baseline.
 *    A key passing K/K is STABLE-GREEN, failing K/K is STABLE-RED, anything
 *    else is FLAPPING — noise that must be quarantined, never averaged away.
 *  - ORDER CAMPAIGN (J runs, default 8): `bun test --randomize --seed=<recorded
 *    seed>`. This varies ORDER ALONE — same database, same process model, same
 *    preload pass — which is the only way to separate "parallelism broke it"
 *    from "it was always an order artifact". A key constant across the K fixed
 *    runs but not across the K+J total is ORDER-SENSITIVE.
 *  - DURATION-HEADROOM CENSUS from the JUnit per-test times (NOT from
 *    `--timings`, which reports FILE totals and cannot tell one 4.9 s test from
 *    ten 490 ms ones): max(duration over runs) / TEST_TIMEOUT_MS >
 *    CAP_ADJACENT_THRESHOLD ⇒ CAP-ADJACENT, recorded with its measured worst
 *    case. These are the tests one slow CI box away from a timeout red.
 *  - TIMINGS RUN (`--timings` mode): `bun test --timings=<artifact>
 *    --update-timings`, the file bun itself consumes to balance `--shard` /
 *    order `--parallel`. Bun STRIPS unknown keys when it rewrites the file
 *    (measured 2026-08-25), so this wrapper re-stamps a `meta` block after bun
 *    writes — a timings.json without `meta` was written by a bare bun call,
 *    and the tripwire treats that as the provenance loss it is.
 *
 * ARTIFACTS (engineering/test_baseline/ — schema documented in its README.md,
 * validated by test/unit/test_baseline_tripwire.test.ts, which imports the
 * validators from THIS file so there is exactly one implementation of the
 * schema): runs.json, order_sensitive.json, cap_adjacent.json, timings.json.
 *
 * RESUMABILITY. A K=5 full-suite campaign is over an hour; a crash must not
 * lose everything. Every completed run is folded into runs.json immediately
 * (atomic write: temp file + rename, because the campaign's own child runs
 * execute the tripwire that READS these artifacts mid-campaign). An
 * interrupted campaign resumes with `--resume`, which refuses a HEAD that
 * moved — a baseline spans exactly one commit or it is not a baseline.
 *
 * TINY MODE IS FIRST-CLASS, NOT A DEBUG HACK: `--files <path> [--files …]`
 * scopes the campaign to named test files so the harness itself can be
 * verified end to end in seconds. A file-scoped campaign REFUSES the default
 * artifact directory — it must name `--out-dir` — so a tiny run can never
 * clobber the committed full-suite baseline, and the tripwire independently
 * rejects a `files`-scoped runs.json inside engineering/test_baseline/.
 *
 * WHAT THIS DOES NOT PROVE, stated plainly:
 *  - It does not make any flaky test stable; it NAMES the flaky ones so an
 *    equivalence claim can exclude exactly them and nothing else.
 *  - The order campaign randomizes what bun randomizes. If bun's --randomize
 *    leaves some scheduling dimension fixed, that dimension is unmeasured here.
 *  - The shrink-only ratchet on FLAPPING/ORDER_SENSITIVE is enforced at WRITE
 *    time (this tool refuses growth without `--accept-growth "<reason>"`) and
 *    re-checked structurally by the tripwire (an entry newer than the seed
 *    campaign must carry an accepted_growth reason); a deletion-and-reseed slips
 *    past both and is caught only by git review of the artifact diff.
 *  - JUnit per-case time is bun's measurement, not wall truth; it is the right
 *    yardstick for cap adjacency because the timeout is enforced against the
 *    same clock.
 *
 * COMPARE MODE (`--compare <junit file|dir>`, repeatable): applies the four
 * acceptance assertions to a candidate's JUnit output — e.g. the per-bin XML of
 * `bun run test:shard --junit-dir=<dir>` — against a COMPLETE full-suite
 * campaign recorded at the SAME commit (`--out-dir` names it; default the
 * committed home). Exit 1 on any violation. A fail → pass is red too: the
 * README's assertion 4 needs a human ledger line, which a tool cannot verify.
 * `--expect-fixed` is the STRICT form for a candidate that keeps each file's
 * test order (the shard runner does): the expectation is the FIXED-order runs
 * alone and only FLAPPING keys are quarantined — an ORDER_SENSITIVE key moved
 * by `--randomize` is still a key the candidate must reproduce.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { childEnv } from './lib/parity_census.ts';
import { TEST_TIMEOUT_FLAG, TEST_TIMEOUT_MS } from './lib/test_flags.ts';

export const REPO_ROOT = join(import.meta.dir, '..');

/** The committed artifact home. A file-scoped campaign may NOT write here. */
export const DEFAULT_ARTIFACT_DIR = join(REPO_ROOT, 'engineering', 'test_baseline');

/** worst-case duration / TEST_TIMEOUT_MS above this ⇒ CAP-ADJACENT. */
export const CAP_ADJACENT_THRESHOLD = 0.3;

export const RUNS_SCHEMA = 'dedalo.test_baseline.runs/1';
export const ORDER_SENSITIVE_SCHEMA = 'dedalo.test_baseline.order_sensitive/1';
export const CAP_ADJACENT_SCHEMA = 'dedalo.test_baseline.cap_adjacent/1';

/** Default campaign sizes (overridable: --runs / --order-runs). */
export const DEFAULT_FIXED_RUNS = 5;
export const DEFAULT_ORDER_RUNS = 8;

// ── key grammar ──────────────────────────────────────────────────────────────
// One string per test: `<repo-relative file>::<describe chain > test name>`.
// The name half is bun's own display form (' > '-joined), same as the parity
// census uses, so a key here and a line in bun's console output correlate by
// eye. '::' cannot appear in a repo path, so the FIRST '::' is the split point.
export const KEY_SEPARATOR = '::';

export function makeKey(file: string, name: string): string {
	return `${file}${KEY_SEPARATOR}${name}`;
}

export function keyFile(key: string): string {
	const at = key.indexOf(KEY_SEPARATOR);
	return at === -1 ? key : key.slice(0, at);
}

// ── JUnit parsing (per-case, WITH durations) ─────────────────────────────────
// Modeled on scripts/lib/parity_census.ts parseJunit — the proven scanner for
// bun's nested-<testsuite> shape — but NOT imported from it: the census parser
// deliberately drops the per-case `time` attribute, and the duration is the
// whole point of the cap-adjacency census here. The census stays the ONE
// measure of the parity tier; this is the ONE measure of per-test baselines,
// and the tripwire imports from here for the same one-implementation reason.

export type CaseStatus = 'pass' | 'fail' | 'skip';

export interface JunitCase {
	/** Repo-relative file, e.g. `test/unit/locator_law.test.ts`. */
	file: string;
	/** Describe chain + test name, ' > '-joined (bun's display form). */
	name: string;
	status: CaseStatus;
	/** bun's per-case `time` attribute, converted from seconds to ms. */
	durationMs: number;
}

const TAG = /<(\/?)(testsuites|testsuite|testcase|failure|skipped|error)\b([^>]*)>/g;

function attr(raw: string, key: string): string | undefined {
	const m = new RegExp(`\\b${key}="([^"]*)"`).exec(raw);
	const value = m?.[1];
	if (value === undefined) return undefined;
	return value
		.replaceAll('&lt;', '<')
		.replaceAll('&gt;', '>')
		.replaceAll('&quot;', '"')
		.replaceAll('&apos;', "'")
		.replaceAll('&amp;', '&');
}

/**
 * Parse a bun JUnit report into per-case records. Exported so the tripwire can
 * prove the measure SEES a failure, a skip and a duration (anti-vacuity)
 * without running any suite.
 */
export function parseJunitCases(xml: string): JunitCase[] {
	const cases: JunitCase[] = [];
	const suites: string[] = [];
	let currentFile = '';
	let open: JunitCase | null = null;

	TAG.lastIndex = 0;
	for (let m = TAG.exec(xml); m !== null; m = TAG.exec(xml)) {
		const closing = m[1] ?? '';
		const tag = m[2] ?? '';
		const rawAttrs = (m[3] ?? '').trimEnd();
		const isClose = closing === '/';
		const isSelf = rawAttrs.endsWith('/');
		const raw = isSelf ? rawAttrs.slice(0, -1) : rawAttrs;

		if (tag === 'testsuite') {
			if (isClose) {
				suites.pop();
				if (suites.length === 0) currentFile = '';
				continue;
			}
			const name = attr(raw, 'name') ?? '';
			// A run given EXPLICIT paths (the shard runner passes `./test/…`) must
			// key exactly like a discovery run, or every key would read as absent.
			if (suites.length === 0) currentFile = (attr(raw, 'file') ?? name).replace(/^\.\//, '');
			suites.push(name);
			continue;
		}

		if (tag === 'testcase') {
			if (isClose) {
				if (open !== null) cases.push(open);
				open = null;
				continue;
			}
			// suites[0] is the file-level wrapper — its name is the path.
			const path = [...suites.slice(1), attr(raw, 'name') ?? ''].filter((s) => s.length > 0);
			const seconds = Number.parseFloat(attr(raw, 'time') ?? '0');
			const parsed: JunitCase = {
				file: currentFile,
				name: path.join(' > '),
				status: 'pass',
				durationMs: Number.isFinite(seconds) ? seconds * 1000 : 0,
			};
			if (isSelf) cases.push(parsed);
			else open = parsed;
			continue;
		}

		if (open !== null && !isClose) {
			if (tag === 'failure' || tag === 'error') open.status = 'fail';
			else if (tag === 'skipped') open.status = 'skip';
		}
	}
	return cases;
}

// ── artifact shapes + validators ─────────────────────────────────────────────
// The validators are the SCHEMA. The tripwire imports them; the README
// describes them; nothing else re-implements them. Each throws with a message
// naming the artifact, the field and the rule — a red gate must say why.

/** One status char per key: p(ass) f(ail) s(kip) a(bsent — not registered). */
export type StatusChar = 'p' | 'f' | 's' | 'a';
const STATUS_CHARS = new Set<string>(['p', 'f', 's', 'a']);

export interface BaselineRun {
	kind: 'fixed' | 'order';
	index: number;
	/** --seed for an order run; null for a fixed-order run. */
	seed: number | null;
	started: string;
	wall_ms: number;
	exit_code: number;
	/** One char per entry of the artifact's `keys`, aligned by position. */
	statuses: string;
	/** ms per key, aligned; -1 where the key was absent in this run. */
	durations_ms: number[];
}

export interface RunsArtifact {
	schema: typeof RUNS_SCHEMA;
	generated: string;
	commit: string;
	timeout_ms: number;
	cap_adjacent_threshold: number;
	/** null = the full suite; a list = a file-scoped (tiny-mode) campaign. */
	files: string[] | null;
	fixed_runs_planned: number;
	order_runs_planned: number;
	/** The recorded --seed of every planned order run, decided up front. */
	order_seeds: number[];
	keys: string[];
	runs: BaselineRun[];
	complete: boolean;
	/** Present once complete: the classification tallies. */
	summary?: {
		stable_green: number;
		stable_red: number;
		flapping: number;
		order_sensitive: number;
		cap_adjacent: number;
	};
}

export interface OrderSensitiveEntry {
	key: string;
	file: string;
	classification: 'FLAPPING' | 'ORDER_SENSITIVE';
	outcomes: { pass: number; fail: number; skip: number; absent: number };
	first_seen: string;
}

export interface OrderSensitiveArtifact {
	schema: typeof ORDER_SENSITIVE_SCHEMA;
	generated: string;
	commit: string;
	/** ISO date of the campaign that SEEDED the ratchet (carried forward). */
	seeded: string;
	fixed_runs: number;
	order_runs: number;
	seeds: number[];
	entries: OrderSensitiveEntry[];
	/** Every post-seed addition, each with the human reason it was accepted. */
	accepted_growth: { key: string; date: string; reason: string }[];
}

export interface CapAdjacentArtifact {
	schema: typeof CAP_ADJACENT_SCHEMA;
	generated: string;
	commit: string;
	timeout_ms: number;
	threshold: number;
	entries: { key: string; file: string; worst_ms: number; ratio: number }[];
}

function fail(artifact: string, message: string): never {
	throw new Error(`${artifact}: ${message}`);
}

function requireObject(artifact: string, value: unknown): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		fail(artifact, 'not a JSON object');
	}
	return value as Record<string, unknown>;
}

function requireIso(artifact: string, field: string, value: unknown): string {
	if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
		fail(artifact, `\`${field}\` must be an ISO date string, got ${JSON.stringify(value)}`);
	}
	return value;
}

function requireCommit(artifact: string, value: unknown): string {
	if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
		fail(artifact, `\`commit\` must be a 40-hex git sha, got ${JSON.stringify(value)}`);
	}
	return value;
}

function requireCount(artifact: string, field: string, value: unknown, min: number): number {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
		fail(artifact, `\`${field}\` must be an integer >= ${min}, got ${JSON.stringify(value)}`);
	}
	return value;
}

/** Every key must name a test file that EXISTS on disk — a baseline over
 * phantom files measures nothing (and a renamed file must re-baseline). */
function requireKeyOnDisk(artifact: string, key: string): void {
	if (typeof key !== 'string' || !key.includes(KEY_SEPARATOR)) {
		fail(artifact, `key ${JSON.stringify(key)} is not \`<file>${KEY_SEPARATOR}<name>\``);
	}
	const file = keyFile(key);
	if (isAbsolute(file)) {
		fail(artifact, `key file ${JSON.stringify(file)} must be repo-relative, not absolute`);
	}
	if (!existsSync(join(REPO_ROOT, file))) {
		fail(artifact, `key names a file that does not exist on disk: ${file}`);
	}
}

/**
 * runs.json validator. ANTI-VACUITY IS SCHEMA: zero keys or zero runs is
 * REFUSED — a campaign that measured nothing must not produce a green
 * artifact. `complete: false` is legal (a campaign in flight commits nothing,
 * but the tripwire runs INSIDE the campaign's own child suites and must not
 * redden the very runs being recorded).
 */
export function assertRunsArtifact(value: unknown): RunsArtifact {
	const A = 'runs.json';
	const o = requireObject(A, value);
	if (o.schema !== RUNS_SCHEMA) {
		fail(A, `\`schema\` must be ${JSON.stringify(RUNS_SCHEMA)}, got ${JSON.stringify(o.schema)}`);
	}
	requireIso(A, 'generated', o.generated);
	requireCommit(A, o.commit);
	requireCount(A, 'timeout_ms', o.timeout_ms, 1);
	if (
		typeof o.cap_adjacent_threshold !== 'number' ||
		!(o.cap_adjacent_threshold > 0 && o.cap_adjacent_threshold < 1)
	) {
		fail(A, '`cap_adjacent_threshold` must be a number in (0, 1)');
	}
	if (o.files !== null) {
		if (
			!Array.isArray(o.files) ||
			o.files.length === 0 ||
			o.files.some((f) => typeof f !== 'string')
		) {
			fail(A, '`files` must be null (full suite) or a non-empty string array (file-scoped)');
		}
	}
	const fixedPlanned = requireCount(A, 'fixed_runs_planned', o.fixed_runs_planned, 1);
	const orderPlanned = requireCount(A, 'order_runs_planned', o.order_runs_planned, 0);
	if (
		!Array.isArray(o.order_seeds) ||
		o.order_seeds.length !== orderPlanned ||
		o.order_seeds.some((s) => !Number.isInteger(s))
	) {
		fail(A, '`order_seeds` must be an integer array of length `order_runs_planned`');
	}
	if (!Array.isArray(o.keys) || o.keys.length === 0) {
		fail(
			A,
			'`keys` is empty — a campaign that registered ZERO tests measured nothing (anti-vacuity)',
		);
	}
	for (const key of o.keys) requireKeyOnDisk(A, key as string);
	if (!Array.isArray(o.runs) || o.runs.length === 0) {
		fail(A, '`runs` is empty — an artifact with no recorded run is not a baseline (anti-vacuity)');
	}
	if (o.runs.length > fixedPlanned + orderPlanned) {
		fail(
			A,
			`\`runs\` holds ${o.runs.length} entries but only ${fixedPlanned + orderPlanned} were planned`,
		);
	}
	for (const [i, rawRun] of o.runs.entries()) {
		const r = requireObject(A, rawRun);
		if (r.kind !== 'fixed' && r.kind !== 'order') fail(A, `runs[${i}].kind must be fixed|order`);
		requireCount(A, `runs[${i}].index`, r.index, 0);
		if (r.kind === 'fixed' ? r.seed !== null : !Number.isInteger(r.seed)) {
			fail(A, `runs[${i}].seed must be null for a fixed run and an integer for an order run`);
		}
		requireIso(A, `runs[${i}].started`, r.started);
		requireCount(A, `runs[${i}].wall_ms`, r.wall_ms, 0);
		requireCount(A, `runs[${i}].exit_code`, r.exit_code, 0);
		if (typeof r.statuses !== 'string' || r.statuses.length !== o.keys.length) {
			fail(
				A,
				`runs[${i}].statuses must be one char per key (${o.keys.length}), got length ${typeof r.statuses === 'string' ? r.statuses.length : '(not a string)'}`,
			);
		}
		for (const c of r.statuses) {
			if (!STATUS_CHARS.has(c))
				fail(A, `runs[${i}].statuses contains ${JSON.stringify(c)} (allowed: p f s a)`);
		}
		if (
			!Array.isArray(r.durations_ms) ||
			r.durations_ms.length !== o.keys.length ||
			r.durations_ms.some((d) => typeof d !== 'number')
		) {
			fail(A, `runs[${i}].durations_ms must be one number per key (${o.keys.length})`);
		}
	}
	if (typeof o.complete !== 'boolean') fail(A, '`complete` must be a boolean');
	if (o.complete) {
		if (o.runs.length !== fixedPlanned + orderPlanned) {
			fail(A, `complete:true but ${o.runs.length}/${fixedPlanned + orderPlanned} runs recorded`);
		}
		const s = requireObject(A, o.summary ?? fail(A, 'complete:true requires `summary`'));
		for (const field of [
			'stable_green',
			'stable_red',
			'flapping',
			'order_sensitive',
			'cap_adjacent',
		]) {
			requireCount(A, `summary.${field}`, s[field], 0);
		}
	}
	return o as unknown as RunsArtifact;
}

/**
 * order_sensitive.json validator — including the RATCHET RULE the tool
 * enforces at write time: every entry either dates from the seed campaign
 * (`first_seen === seeded`) or carries an `accepted_growth` record with a
 * non-empty human reason. Hand-editing an entry in without a reason is red.
 */
export function assertOrderSensitiveArtifact(value: unknown): OrderSensitiveArtifact {
	const A = 'order_sensitive.json';
	const o = requireObject(A, value);
	if (o.schema !== ORDER_SENSITIVE_SCHEMA) {
		fail(A, `\`schema\` must be ${JSON.stringify(ORDER_SENSITIVE_SCHEMA)}`);
	}
	requireIso(A, 'generated', o.generated);
	requireCommit(A, o.commit);
	const seeded = requireIso(A, 'seeded', o.seeded);
	const fixedRuns = requireCount(A, 'fixed_runs', o.fixed_runs, 1);
	const orderRuns = requireCount(A, 'order_runs', o.order_runs, 0);
	if (!Array.isArray(o.seeds) || o.seeds.some((s) => !Number.isInteger(s))) {
		fail(A, '`seeds` must be an integer array');
	}
	if (!Array.isArray(o.accepted_growth)) fail(A, '`accepted_growth` must be an array');
	const accepted = new Map<string, string>();
	for (const [i, rawGrowth] of o.accepted_growth.entries()) {
		const g = requireObject(A, rawGrowth);
		if (typeof g.key !== 'string') fail(A, `accepted_growth[${i}].key must be a string`);
		requireIso(A, `accepted_growth[${i}].date`, g.date);
		if (typeof g.reason !== 'string' || g.reason.trim() === '') {
			fail(
				A,
				`accepted_growth[${i}] (${JSON.stringify(g.key)}) has no reason — growth is accepted with a stated reason or not at all`,
			);
		}
		accepted.set(g.key, g.reason);
	}
	if (!Array.isArray(o.entries))
		fail(A, '`entries` must be an array (empty IS legal: a clean suite)');
	for (const [i, rawEntry] of o.entries.entries()) {
		const e = requireObject(A, rawEntry);
		requireKeyOnDisk(A, e.key as string);
		if (e.file !== keyFile(e.key as string)) {
			fail(A, `entries[${i}].file (${JSON.stringify(e.file)}) does not match its key's file part`);
		}
		if (e.classification !== 'FLAPPING' && e.classification !== 'ORDER_SENSITIVE') {
			fail(A, `entries[${i}].classification must be FLAPPING|ORDER_SENSITIVE`);
		}
		const outcomes = requireObject(A, e.outcomes);
		let total = 0;
		for (const field of ['pass', 'fail', 'skip', 'absent']) {
			total += requireCount(A, `entries[${i}].outcomes.${field}`, outcomes[field], 0);
		}
		if (total !== fixedRuns + orderRuns) {
			fail(
				A,
				`entries[${i}].outcomes sum to ${total}, expected fixed_runs + order_runs = ${fixedRuns + orderRuns}`,
			);
		}
		const firstSeen = requireIso(A, `entries[${i}].first_seen`, e.first_seen);
		if (firstSeen !== seeded && !accepted.has(e.key as string)) {
			fail(
				A,
				`entries[${i}] (${JSON.stringify(e.key)}) post-dates the seed campaign (${seeded}) and has no accepted_growth reason — the ratchet is SHRINK-ONLY`,
			);
		}
	}
	return o as unknown as OrderSensitiveArtifact;
}

/** cap_adjacent.json validator. An entry BELOW the threshold is refused: it
 * could only get there by hand, and a fabricated census is worse than none. */
export function assertCapAdjacentArtifact(value: unknown): CapAdjacentArtifact {
	const A = 'cap_adjacent.json';
	const o = requireObject(A, value);
	if (o.schema !== CAP_ADJACENT_SCHEMA) {
		fail(A, `\`schema\` must be ${JSON.stringify(CAP_ADJACENT_SCHEMA)}`);
	}
	requireIso(A, 'generated', o.generated);
	requireCommit(A, o.commit);
	const timeoutMs = requireCount(A, 'timeout_ms', o.timeout_ms, 1);
	if (typeof o.threshold !== 'number' || !(o.threshold > 0 && o.threshold < 1)) {
		fail(A, '`threshold` must be a number in (0, 1)');
	}
	if (!Array.isArray(o.entries)) fail(A, '`entries` must be an array (empty IS legal)');
	for (const [i, rawEntry] of o.entries.entries()) {
		const e = requireObject(A, rawEntry);
		requireKeyOnDisk(A, e.key as string);
		if (e.file !== keyFile(e.key as string)) {
			fail(A, `entries[${i}].file does not match its key's file part`);
		}
		if (typeof e.worst_ms !== 'number' || !(e.worst_ms > o.threshold * timeoutMs)) {
			fail(
				A,
				`entries[${i}].worst_ms (${JSON.stringify(e.worst_ms)}) does not exceed threshold × timeout_ms — a sub-threshold entry can only be fabricated`,
			);
		}
		if (
			typeof e.ratio !== 'number' ||
			Math.abs(e.ratio - (e.worst_ms as number) / timeoutMs) > 0.005
		) {
			fail(A, `entries[${i}].ratio disagrees with worst_ms / timeout_ms`);
		}
	}
	return o as unknown as CapAdjacentArtifact;
}

/**
 * timings.json validator. The file body is BUN'S OWN format (version + files
 * map — it is handed back to `--timings=` verbatim), plus the `meta` block
 * this wrapper re-stamps after bun writes. Bun tolerates the extra key on
 * read and STRIPS it on --update-timings (both measured 2026-08-25), so a
 * timings.json without `meta` means someone ran bun bare and the artifact's
 * provenance (commit, date, command) is gone — that is red, run
 * `bun run test:timings` instead.
 */
export function assertTimingsArtifact(value: unknown): void {
	const A = 'timings.json';
	const o = requireObject(A, value);
	if (o.version !== 1)
		fail(A, `\`version\` must be 1 (bun's format), got ${JSON.stringify(o.version)}`);
	const files = requireObject(A, o.files);
	if (Object.keys(files).length === 0) {
		fail(
			A,
			'`files` is empty — a timings run that timed ZERO files measured nothing (anti-vacuity)',
		);
	}
	for (const [file, ms] of Object.entries(files)) {
		if (typeof ms !== 'number' || ms < 0)
			fail(A, `files[${JSON.stringify(file)}] must be a duration in ms`);
		if (!existsSync(join(REPO_ROOT, file)))
			fail(A, `names a file that does not exist on disk: ${file}`);
	}
	const meta = requireObject(
		A,
		o.meta ??
			fail(
				A,
				'no `meta` block — written by a bare `bun test --update-timings`, not by `bun run test:timings`; provenance (commit/date) is lost',
			),
	);
	requireIso(A, 'meta.generated', meta.generated);
	requireCommit(A, meta.commit);
	if (typeof meta.command !== 'string' || meta.command === '')
		fail(A, '`meta.command` must name the wrapper command');
}

// ── classification ───────────────────────────────────────────────────────────

export interface Classification {
	stableGreen: string[];
	stableRed: string[];
	/** Not constant across the K fixed-order runs. */
	flapping: OrderSensitiveEntry[];
	/** Constant across the fixed runs, NOT constant once order runs are added. */
	orderSensitive: OrderSensitiveEntry[];
}

/**
 * Classify every key. 'absent' is an OUTCOME, not a gap: a key registered in
 * one run and not another (test.if/skipIf, or --randomize changing what a
 * guard sees) is exactly the disappearing-test hole the old failset-subset
 * comparison scored as a pass.
 */
export function classify(
	artifact: Pick<RunsArtifact, 'keys' | 'runs'>,
	firstSeen: string,
): Classification {
	const out: Classification = { stableGreen: [], stableRed: [], flapping: [], orderSensitive: [] };
	const fixed = artifact.runs.filter((r) => r.kind === 'fixed');
	for (const [i, key] of artifact.keys.entries()) {
		const all = artifact.runs.map((r) => r.statuses[i] as StatusChar);
		const fixedSet = new Set(fixed.map((r) => r.statuses[i] as StatusChar));
		const outcomes = { pass: 0, fail: 0, skip: 0, absent: 0 };
		for (const c of all) {
			if (c === 'p') outcomes.pass += 1;
			else if (c === 'f') outcomes.fail += 1;
			else if (c === 's') outcomes.skip += 1;
			else outcomes.absent += 1;
		}
		const entry: OrderSensitiveEntry = {
			key,
			file: keyFile(key),
			classification: 'FLAPPING',
			outcomes,
			first_seen: firstSeen,
		};
		if (fixedSet.size > 1) {
			out.flapping.push(entry);
			continue;
		}
		if (new Set(all).size > 1) {
			entry.classification = 'ORDER_SENSITIVE';
			out.orderSensitive.push(entry);
			continue;
		}
		if (fixedSet.has('p')) out.stableGreen.push(key);
		else if (fixedSet.has('f')) out.stableRed.push(key);
		// uniform skip / uniform absent: stable, and neither green nor red.
	}
	return out;
}

/** The duration-headroom census: worst case per key, over every recorded run. */
export function capAdjacentEntries(
	artifact: Pick<RunsArtifact, 'keys' | 'runs'>,
	timeoutMs: number,
	threshold: number,
): CapAdjacentArtifact['entries'] {
	const entries: CapAdjacentArtifact['entries'] = [];
	for (const [i, key] of artifact.keys.entries()) {
		let worst = -1;
		for (const run of artifact.runs) {
			const d = run.durations_ms[i] ?? -1;
			if (d > worst) worst = d;
		}
		if (worst > threshold * timeoutMs) {
			entries.push({
				key,
				file: keyFile(key),
				worst_ms: Math.round(worst * 1000) / 1000,
				ratio: Math.round((worst / timeoutMs) * 1000) / 1000,
			});
		}
	}
	entries.sort((a, b) => b.worst_ms - a.worst_ms);
	return entries;
}

// ── candidate comparison: the four acceptance assertions ─────────────────────
// A candidate (a sharded run, a new Bun, a re-ordered suite) EQUALS the
// baseline iff no non-quarantined key moved. The quarantine is the
// FLAPPING + ORDER_SENSITIVE set by name; every other baseline key is constant
// across ALL K+J runs, so its one recorded state is the expectation.

/** Which of the README's four assertions a moved key breaks ('other': fail ↔ skip). */
export type CompareAssertion = 'key_set' | 'pass_skip' | 'pass_fail' | 'fail_pass' | 'other';

export interface CompareViolation {
	key: string;
	assertion: CompareAssertion;
	/** 'a' when the candidate registered a key the baseline never saw. */
	baseline: StatusChar;
	/** 'a' when the candidate did not register a baseline key. */
	candidate: StatusChar;
}

export interface CompareResult {
	/** Baseline keys checked against the candidate (quarantine excluded). */
	compared: number;
	quarantined: number;
	violations: CompareViolation[];
}

function transition(baseline: StatusChar, candidate: StatusChar): CompareAssertion {
	if (baseline === 'a' || candidate === 'a') return 'key_set';
	const pair = new Set([baseline, candidate]);
	if (pair.has('p') && pair.has('s')) return 'pass_skip';
	if (baseline === 'p' && candidate === 'f') return 'pass_fail';
	if (baseline === 'f' && candidate === 'p') return 'fail_pass';
	return 'other';
}

/**
 * Compare a candidate's cases against a recorded campaign. Throws when the
 * candidate measured nothing, or when a baseline key is NOT constant across the
 * runs yet missing from the quarantine — the two artifacts disagree, and an
 * expectation picked from an unstable key would be a coin flip.
 */
export function compareCandidate(
	artifact: Pick<RunsArtifact, 'keys' | 'runs'>,
	quarantine: ReadonlySet<string>,
	cases: JunitCase[],
): CompareResult {
	if (cases.length === 0) {
		throw new Error('the candidate reported ZERO test cases — nothing to compare (anti-vacuity)');
	}
	const candidate = new Map<string, StatusChar>();
	for (const c of cases) {
		candidate.set(
			makeKey(c.file, c.name),
			c.status === 'pass' ? 'p' : c.status === 'fail' ? 'f' : 's',
		);
	}
	const result: CompareResult = { compared: 0, quarantined: 0, violations: [] };
	for (const [i, key] of artifact.keys.entries()) {
		if (quarantine.has(key)) {
			result.quarantined += 1;
			continue;
		}
		const seen = new Set(artifact.runs.map((r) => r.statuses[i] as StatusChar));
		if (seen.size !== 1) {
			throw new Error(
				`baseline key is not constant across the recorded runs (${[...seen].join('/')}) but is not quarantined: ${key} — runs.json and order_sensitive.json disagree; re-run the campaign.`,
			);
		}
		const expected = [...seen][0] as StatusChar;
		const actual = candidate.get(key) ?? 'a';
		result.compared += 1;
		if (expected !== actual) {
			result.violations.push({
				key,
				assertion: transition(expected, actual),
				baseline: expected,
				candidate: actual,
			});
		}
	}
	const known = new Set(artifact.keys);
	for (const [key, actual] of candidate) {
		if (!known.has(key)) {
			result.violations.push({ key, assertion: 'key_set', baseline: 'a', candidate: actual });
		}
	}
	result.violations.sort((a, b) => a.key.localeCompare(b.key));
	return result;
}

// ── the campaign runner (only under `bun run`, never on import) ──────────────

// Child runs strip the per-run env seams through the census's own childEnv()
// (imported above): same launch-context hazard — a child `bun test` inheriting a
// parent test run's rewritten DB_NAME derives `<app>_test_test` and floods the
// run with phantom reds — so same list, one implementation. See the seam header
// in scripts/lib/parity_census.ts (2026-08-24) for the measured incident.

function gitHead(): string {
	const proc = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: REPO_ROOT });
	const sha = proc.stdout.toString().trim();
	if (!/^[0-9a-f]{40}$/.test(sha)) {
		throw new Error(`git rev-parse HEAD failed: ${proc.stderr.toString().trim()}`);
	}
	return sha;
}

/** Atomic write: the campaign's own child suites READ these artifacts (the
 * tripwire runs inside them), so a reader must see the old file or the new
 * one, never a torn half. */
function writeArtifact(path: string, value: unknown): void {
	const temp = `${path}.tmp.${process.pid}`;
	writeFileSync(temp, `${JSON.stringify(value, null, '\t')}\n`);
	renameSync(temp, path);
}

function readJsonIfExists(path: string): unknown {
	if (!existsSync(path)) return undefined;
	return JSON.parse(readFileSync(path, 'utf8'));
}

interface RunOutcome {
	cases: JunitCase[];
	exitCode: number;
	wallMs: number;
}

function runSuiteOnce(files: string[] | null, seed: number | null): RunOutcome {
	const dir = mkdtempSync(join(tmpdir(), 'dedalo-test-baseline-'));
	const outfile = join(dir, 'run.junit.xml');
	try {
		const argv = [
			'bun',
			'test',
			...(files ?? []),
			TEST_TIMEOUT_FLAG,
			'--reporter=junit',
			`--reporter-outfile=${outfile}`,
			...(seed === null ? [] : ['--randomize', `--seed=${seed}`]),
		];
		const startedAt = Date.now();
		const proc = Bun.spawnSync(argv, {
			cwd: REPO_ROOT,
			stdout: 'pipe',
			stderr: 'pipe',
			env: childEnv(),
		});
		const wallMs = Date.now() - startedAt;
		let xml: string;
		try {
			xml = readFileSync(outfile, 'utf8');
		} catch {
			throw new Error(
				`\`${argv.join(' ')}\` wrote no JUnit report (exit ${proc.exitCode}). The suite did not run; refusing to record an empty result.\n--- stderr tail ---\n${proc.stderr.toString().split('\n').slice(-25).join('\n')}`,
			);
		}
		const cases = parseJunitCases(xml);
		if (cases.length === 0) {
			throw new Error(
				`\`${argv.join(' ')}\` reported ZERO test cases (exit ${proc.exitCode}) — nothing was measured; refusing to record it.`,
			);
		}
		return { cases, exitCode: proc.exitCode ?? 0, wallMs };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Fold one run's cases into the artifact, padding earlier runs when the run
 * registered a key nobody had seen yet (append-only key order = alignment). */
function foldRun(
	artifact: RunsArtifact,
	run: Omit<BaselineRun, 'statuses' | 'durations_ms'>,
	cases: JunitCase[],
): void {
	const index = new Map<string, number>(artifact.keys.map((k, i) => [k, i]));
	for (const c of cases) {
		const key = makeKey(c.file, c.name);
		if (!index.has(key)) {
			index.set(key, artifact.keys.length);
			artifact.keys.push(key);
			for (const earlier of artifact.runs) {
				earlier.statuses += 'a';
				earlier.durations_ms.push(-1);
			}
		}
	}
	const statuses: string[] = new Array(artifact.keys.length).fill('a');
	const durations: number[] = new Array(artifact.keys.length).fill(-1);
	for (const c of cases) {
		const at = index.get(makeKey(c.file, c.name)) as number;
		statuses[at] = c.status === 'pass' ? 'p' : c.status === 'fail' ? 'f' : 's';
		durations[at] = Math.round(c.durationMs * 1000) / 1000;
	}
	artifact.runs.push({ ...run, statuses: statuses.join(''), durations_ms: durations });
}

interface CliOptions {
	timings: boolean;
	runs: number;
	orderRuns: number;
	files: string[] | null;
	outDir: string | null;
	resume: boolean;
	acceptGrowth: string | null;
	compare: string[];
	expectFixed: boolean;
}

function parseArgs(argv: string[]): CliOptions {
	const options: CliOptions = {
		timings: false,
		runs: DEFAULT_FIXED_RUNS,
		orderRuns: DEFAULT_ORDER_RUNS,
		files: null,
		outDir: null,
		resume: false,
		acceptGrowth: null,
		compare: [],
		expectFixed: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		const next = (): string => {
			const v = argv[++i];
			if (v === undefined) throw new Error(`${arg} needs a value`);
			return v;
		};
		if (arg === '--timings') options.timings = true;
		else if (arg === '--runs') options.runs = Number.parseInt(next(), 10);
		else if (arg === '--order-runs') options.orderRuns = Number.parseInt(next(), 10);
		else if (arg === '--files') options.files = [...(options.files ?? []), next()];
		else if (arg === '--out-dir') options.outDir = next();
		else if (arg === '--resume') options.resume = true;
		else if (arg === '--accept-growth') options.acceptGrowth = next();
		else if (arg === '--compare') options.compare.push(next());
		else if (arg === '--expect-fixed') options.expectFixed = true;
		else throw new Error(`unknown argument: ${arg}`);
	}
	if (!Number.isInteger(options.runs) || options.runs < 1) throw new Error('--runs must be >= 1');
	if (!Number.isInteger(options.orderRuns) || options.orderRuns < 0)
		throw new Error('--order-runs must be >= 0');
	return options;
}

function resolveOutDir(options: CliOptions): string {
	if (options.outDir !== null) return resolve(REPO_ROOT, options.outDir);
	if (options.files !== null) {
		throw new Error(
			'a file-scoped campaign (--files) must name --out-dir explicitly: the default ' +
				`directory (${DEFAULT_ARTIFACT_DIR}) holds the FULL-SUITE baseline and a tiny run must never clobber it.`,
		);
	}
	return DEFAULT_ARTIFACT_DIR;
}

function runTimingsMode(options: CliOptions): void {
	const outDir = resolveOutDir(options);
	mkdirSync(outDir, { recursive: true });
	const timingsPath = join(outDir, 'timings.json');
	const argv = [
		'bun',
		'test',
		...(options.files ?? []),
		TEST_TIMEOUT_FLAG,
		`--timings=${timingsPath}`,
		'--update-timings',
	];
	// cwd is PINNED to the repo root: bun records file keys relative to the cwd
	// it ran under, and a timings file keyed from anywhere else is unusable.
	const proc = Bun.spawnSync(argv, {
		cwd: REPO_ROOT,
		stdout: 'inherit',
		stderr: 'inherit',
		env: childEnv(),
	});
	const body = readJsonIfExists(timingsPath);
	if (body === undefined) {
		throw new Error(`\`${argv.join(' ')}\` wrote no timings file (exit ${proc.exitCode}).`);
	}
	// Re-stamp provenance: bun strips unknown keys on --update-timings
	// (measured 2026-08-25), so `meta` survives only because THIS wrapper is
	// the doorway. The tripwire treats a meta-less timings.json as red.
	const stamped = {
		...(body as Record<string, unknown>),
		meta: {
			generated: new Date().toISOString(),
			commit: gitHead(),
			command: 'bun run test:timings',
		},
	};
	assertTimingsArtifact(stamped);
	writeArtifact(timingsPath, stamped);
	console.log(`timings written: ${timingsPath} (exit ${proc.exitCode})`);
}

function runCampaign(options: CliOptions): void {
	const outDir = resolveOutDir(options);
	mkdirSync(outDir, { recursive: true });
	const runsPath = join(outDir, 'runs.json');
	const orderPath = join(outDir, 'order_sensitive.json');
	const capPath = join(outDir, 'cap_adjacent.json');
	const commit = gitHead();
	const now = new Date().toISOString();

	let artifact: RunsArtifact;
	const existing = readJsonIfExists(runsPath);
	if (options.resume) {
		if (existing === undefined) throw new Error(`--resume: no ${runsPath} to resume`);
		artifact = assertRunsArtifact(existing);
		if (artifact.complete) throw new Error(`--resume: ${runsPath} is already complete`);
		if (artifact.commit !== commit) {
			throw new Error(
				`--resume: the recorded campaign is at ${artifact.commit.slice(0, 12)} but HEAD is ${commit.slice(0, 12)} — a baseline spans exactly one commit; start a fresh campaign.`,
			);
		}
	} else {
		if (existing !== undefined) {
			const prior = assertRunsArtifact(existing);
			if (!prior.complete) {
				throw new Error(
					`${runsPath} holds an INCOMPLETE campaign (${prior.runs.length}/${prior.fixed_runs_planned + prior.order_runs_planned} runs). Pass --resume to continue it, or delete the file to discard those hours deliberately.`,
				);
			}
		}
		artifact = {
			schema: RUNS_SCHEMA,
			generated: now,
			commit,
			timeout_ms: TEST_TIMEOUT_MS,
			cap_adjacent_threshold: CAP_ADJACENT_THRESHOLD,
			files: options.files,
			fixed_runs_planned: options.runs,
			order_runs_planned: options.orderRuns,
			// Seeds are decided UP FRONT and recorded, so an interrupted campaign
			// resumes into the same plan and the artifact can be replayed exactly.
			order_seeds: Array.from({ length: options.orderRuns }, () =>
				Math.floor(Math.random() * 2 ** 31),
			),
			keys: [],
			runs: [],
			complete: false,
		};
	}

	const totalPlanned = artifact.fixed_runs_planned + artifact.order_runs_planned;
	for (let i = artifact.runs.length; i < totalPlanned; i++) {
		const isFixed = i < artifact.fixed_runs_planned;
		const seed = isFixed ? null : (artifact.order_seeds[i - artifact.fixed_runs_planned] as number);
		console.log(
			`run ${i + 1}/${totalPlanned} (${isFixed ? 'fixed order' : `--randomize --seed=${seed}`}) …`,
		);
		const started = new Date().toISOString();
		const outcome = runSuiteOnce(artifact.files, seed);
		foldRun(
			artifact,
			{
				kind: isFixed ? 'fixed' : 'order',
				index: i,
				seed,
				started,
				wall_ms: outcome.wallMs,
				exit_code: outcome.exitCode,
			},
			outcome.cases,
		);
		// Persist after EVERY run: a crash loses one run, not the campaign.
		writeArtifact(runsPath, artifact);
		console.log(
			`  → ${outcome.cases.length} cases in ${(outcome.wallMs / 1000).toFixed(1)}s (exit ${outcome.exitCode}); recorded.`,
		);
	}

	// ── classification + the shrink-only ratchet ──────────────────────────────
	const priorRaw = readJsonIfExists(orderPath);
	const prior = priorRaw === undefined ? null : assertOrderSensitiveArtifact(priorRaw);
	const seeded = prior?.seeded ?? now;
	const classification = classify(artifact, now);
	const entries = [...classification.flapping, ...classification.orderSensitive].sort((a, b) =>
		a.key.localeCompare(b.key),
	);
	let acceptedGrowth = prior?.accepted_growth ?? [];
	if (prior !== null) {
		const known = new Set([
			...prior.entries.map((e) => e.key),
			...prior.accepted_growth.map((g) => g.key),
		]);
		const priorFirstSeen = new Map(prior.entries.map((e) => [e.key, e.first_seen]));
		for (const entry of entries) {
			const kept = priorFirstSeen.get(entry.key);
			if (kept !== undefined) entry.first_seen = kept;
		}
		const added = entries.filter((e) => !known.has(e.key));
		if (added.length > 0) {
			if (options.acceptGrowth === null || options.acceptGrowth.trim() === '') {
				throw new Error(
					`the FLAPPING/ORDER_SENSITIVE set GREW by ${added.length} key(s) — the ratchet is shrink-only. New:\n` +
						added.map((e) => `  ${e.classification} ${e.key}`).join('\n') +
						'\nRe-run with --accept-growth "<reason>" to accept them WITH a recorded reason (runs.json was kept; the classification artifacts were not written).',
				);
			}
			acceptedGrowth = [
				...acceptedGrowth,
				...added.map((e) => ({ key: e.key, date: now, reason: options.acceptGrowth as string })),
			];
		}
		// Shrink: keys that stopped flapping simply leave `entries`; their
		// accepted_growth records leave too (git history keeps the ledger).
		const live = new Set(entries.map((e) => e.key));
		acceptedGrowth = acceptedGrowth.filter((g) => live.has(g.key));
	}

	const capEntries = capAdjacentEntries(
		artifact,
		artifact.timeout_ms,
		artifact.cap_adjacent_threshold,
	);

	artifact.summary = {
		stable_green: classification.stableGreen.length,
		stable_red: classification.stableRed.length,
		flapping: classification.flapping.length,
		order_sensitive: classification.orderSensitive.length,
		cap_adjacent: capEntries.length,
	};
	artifact.complete = true;

	const orderArtifact: OrderSensitiveArtifact = {
		schema: ORDER_SENSITIVE_SCHEMA,
		generated: now,
		commit,
		seeded,
		fixed_runs: artifact.fixed_runs_planned,
		order_runs: artifact.order_runs_planned,
		seeds: artifact.order_seeds,
		entries,
		accepted_growth: acceptedGrowth,
	};
	const capArtifact: CapAdjacentArtifact = {
		schema: CAP_ADJACENT_SCHEMA,
		generated: now,
		commit,
		timeout_ms: artifact.timeout_ms,
		threshold: artifact.cap_adjacent_threshold,
		entries: capEntries,
	};

	// Validate our OWN output before writing — the tool must not be able to
	// produce an artifact its tripwire rejects.
	assertOrderSensitiveArtifact(orderArtifact);
	assertCapAdjacentArtifact(capArtifact);
	writeArtifact(orderPath, orderArtifact);
	writeArtifact(capPath, capArtifact);
	writeArtifact(runsPath, assertRunsArtifact(artifact));

	console.log(`\ncampaign complete → ${outDir}`);
	console.log(
		`  keys ${artifact.keys.length} | stable-green ${artifact.summary.stable_green} | stable-red ${artifact.summary.stable_red} | flapping ${artifact.summary.flapping} | order-sensitive ${artifact.summary.order_sensitive} | cap-adjacent ${artifact.summary.cap_adjacent}`,
	);
	for (const entry of entries) console.log(`  ${entry.classification}: ${entry.key}`);
	for (const entry of capEntries)
		console.log(`  CAP-ADJACENT (${entry.worst_ms} ms): ${entry.key}`);
}

/** Every `*.xml` a --compare argument names: the file itself, or a directory's. */
function candidateReports(paths: string[]): string[] {
	const reports: string[] = [];
	for (const raw of paths) {
		const path = resolve(process.cwd(), raw);
		if (!statSync(path).isDirectory()) {
			reports.push(path);
			continue;
		}
		const inDir = readdirSync(path)
			.filter((name) => name.endsWith('.xml'))
			.sort()
			.map((name) => join(path, name));
		if (inDir.length === 0)
			throw new Error(`--compare ${raw}: the directory holds no *.xml report`);
		reports.push(...inDir);
	}
	return reports;
}

function runCompare(options: CliOptions): number {
	const outDir = resolveOutDir(options);
	const runsRaw = readJsonIfExists(join(outDir, 'runs.json'));
	if (runsRaw === undefined)
		throw new Error(`--compare: no runs.json in ${outDir} — record a campaign first`);
	const artifact = assertRunsArtifact(runsRaw);
	if (!artifact.complete)
		throw new Error('--compare: the recorded campaign is INCOMPLETE — finish it with --resume');
	if (artifact.files !== null)
		throw new Error('--compare: the recorded campaign is file-scoped, not the full suite');
	const commit = gitHead();
	if (artifact.commit !== commit) {
		throw new Error(
			`--compare: the campaign is at ${artifact.commit.slice(0, 12)} but HEAD is ${commit.slice(0, 12)} — a candidate compares against a baseline of the SAME commit.`,
		);
	}
	const orderRaw = readJsonIfExists(join(outDir, 'order_sensitive.json'));
	if (orderRaw === undefined) throw new Error(`--compare: no order_sensitive.json in ${outDir}`);
	const quarantine = new Set(
		assertOrderSensitiveArtifact(orderRaw)
			.entries.filter((e) => !options.expectFixed || e.classification === 'FLAPPING')
			.map((e) => e.key),
	);
	const expected = options.expectFixed
		? { keys: artifact.keys, runs: artifact.runs.filter((r) => r.kind === 'fixed') }
		: artifact;

	const reports = candidateReports(options.compare);
	const cases = reports.flatMap((path) => parseJunitCases(readFileSync(path, 'utf8')));
	const result = compareCandidate(expected, quarantine, cases);

	console.log(
		`compare: ${reports.length} report(s), ${cases.length} candidate cases vs ${artifact.keys.length} baseline keys at ${commit.slice(0, 12)}${options.expectFixed ? ' (expect-fixed)' : ''} — compared ${result.compared}, quarantined ${result.quarantined}, violations ${result.violations.length}`,
	);
	for (const v of result.violations) {
		console.log(`  ${v.assertion} ${v.baseline}→${v.candidate} ${v.key}`);
	}
	if (result.violations.length > 0) {
		const files = [...new Set(result.violations.map((v) => keyFile(v.key)))].sort();
		console.log(`\nNOT EQUAL — ${files.length} file(s) moved:`);
		for (const file of files) console.log(`  ${file}`);
		return 1;
	}
	console.log('EQUAL — the candidate matches the baseline on every non-quarantined key.');
	return 0;
}

if (import.meta.main) {
	try {
		const options = parseArgs(process.argv.slice(2));
		if (options.timings) runTimingsMode(options);
		else if (options.compare.length > 0) process.exit(runCompare(options));
		else runCampaign(options);
	} catch (error) {
		console.error(`test_baseline: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}
