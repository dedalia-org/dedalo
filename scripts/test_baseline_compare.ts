/**
 * COMPARE A CANDIDATE RUN TO THE RECORDED CAMPAIGN (`bun run test:baseline:compare`).
 *
 *   bun run test:baseline:compare <junit file|dir>… [--expect-fixed] [--out-dir <dir>]
 *
 * Applies the four acceptance assertions (engineering/test_baseline/README.md) to a
 * candidate's JUnit output — e.g. the per-bin XML of
 * `bun run test:shard --junit-dir=<dir>` — against a COMPLETE full-suite campaign
 * recorded at the SAME commit (`--out-dir` names it; default the committed home).
 * Exit 1 on any violation. A fail → pass is red too: the README's assertion 4 needs a
 * human ledger line, which a tool cannot verify. `--expect-fixed` is the STRICT form
 * for a candidate that keeps each file's test order (the shard runner does): the
 * expectation is the FIXED-order runs alone and only FLAPPING keys are quarantined — an
 * ORDER_SENSITIVE key moved by `--randomize` is still a key the candidate must reproduce.
 *
 * Its own CLI, apart from scripts/test_baseline.ts, ON PURPOSE: the comparison lists a
 * directory of reports, and test_baseline_tripwire imports that library — a lister there
 * makes the gate a walker by reach (census_derivation_tripwire). The pure comparator
 * (`compareCandidate`) stays in the library, where the gate drives it.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { junitReportsIn } from './lib/junit_reports.ts';
import { SHARD_PLAN_LITERAL, shardedRunReports } from './lib/tier_run.ts';
import {
	assertOrderSensitiveArtifact,
	assertRunsArtifact,
	compareCandidate,
	DEFAULT_ARTIFACT_DIR,
	gitHead,
	keyFile,
	parseJunitCases,
	REPO_ROOT,
	readJsonIfExists,
} from './test_baseline.ts';

interface CompareOptions {
	compare: string[];
	expectFixed: boolean;
	outDir: string | null;
}

function parseArgs(argv: readonly string[]): CompareOptions {
	const options: CompareOptions = { compare: [], expectFixed: false, outDir: null };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		if (arg === '--expect-fixed') options.expectFixed = true;
		else if (arg === '--out-dir') {
			const value = argv[++i];
			if (value === undefined) throw new Error('--out-dir needs a value');
			options.outDir = value;
		} else if (arg.startsWith('--')) throw new Error(`unknown argument: ${arg}`);
		else options.compare.push(arg);
	}
	if (options.compare.length === 0) throw new Error('name at least one JUnit file or directory');
	return options;
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
		// A shard runner's directory is read through ITS protocol — planned bins only,
		// refused on a missing bin or an invalid verdict (template contact, interrupt):
		// an EQUAL here is the licence to shard, so it must never be granted by a run
		// the gate itself would refuse.
		const inDir = existsSync(join(path, SHARD_PLAN_LITERAL))
			? shardedRunReports(path, `in ${raw}`)
			: junitReportsIn(path);
		if (inDir.length === 0)
			throw new Error(`--compare ${raw}: the directory holds no *.xml report`);
		reports.push(...inDir);
	}
	return reports;
}

function runCompare(options: CompareOptions): number {
	const outDir =
		options.outDir === null ? DEFAULT_ARTIFACT_DIR : resolve(REPO_ROOT, options.outDir);
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
		process.exit(runCompare(parseArgs(process.argv.slice(2))));
	} catch (error) {
		console.error(
			`test_baseline_compare: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(1);
	}
}
