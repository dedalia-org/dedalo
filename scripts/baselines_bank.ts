#!/usr/bin/env bun
/**
 * BASELINES BANK — lock in every ratchet's IMPROVEMENTS, automatically, before a push.
 *
 *   bun run baselines:bank                    # check every ratchet; write improvement-only drift
 *   bun run baselines:bank -- --dry-run       # classify only, write nothing
 *   bun run baselines:bank -- --only crap_complexity_baseline,twin_map
 *   bun run baselines:bank -- --with-db       # also the unit + parity red baselines (runs the tiers)
 *   bun run baselines:bank -- --with-network  # also the dependency-advisory baseline (removals only)
 *   bun run baselines:bank -- --json          # one machine-readable summary on stdout
 *   bun run baselines:bank -- --ephemeral     # the CALLER discards this tree after the run
 *                                             # (the pre-push hook's worktree): the report
 *                                             # never tells a human to commit files from it
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────
 * Most of this repo's ratchets are red in BOTH directions on purpose: a count that grew
 * is a regression, and a count that FELL without being re-frozen is a stale entry that
 * would let the debt quietly climb back. That second rule is right — and it was the
 * single largest cause of red CI: a push that genuinely improved something (removed an
 * untyped throw, fixed a frozen red, deleted an it.skip) went red on GitHub because
 * nobody ran the one regeneration command, and nobody saw it until CI did. The fix is
 * not to loosen the gates; it is to run the regeneration for the improvement direction
 * mechanically, BEFORE the push, and to keep refusing the other direction exactly as
 * loudly as before.
 *
 * ── THE CONTRACT ────────────────────────────────────────────────────────────────
 * Every registered ratchet prints ONE verdict under `--check --json` — the shape is
 * scripts/lib/ratchet_check.ts (`RatchetCheck`: `{ratchet, baselines, improvements,
 * regressions}`), and each ratchet classifies its own drift with its own drift
 * computation. This file never reads a ratchet's prose and never writes an artifact
 * itself: it asks each ratchet for its verdict, and when that verdict is improvement-
 * only it runs that ratchet's OWN flagless writer — the same command every failure
 * message already names, which independently REFUSES growth. Two locks, not one: a
 * misclassified line still meets the writer's refusal.
 *
 *   regressions non-empty  → nothing is written for that ratchet; the run exits 1 and
 *                            prints the deliberate path (`--allow-regression`, with a
 *                            `--reason` where that writer takes one). The bank itself
 *                            has NO such flag: accepting debt is never automatic.
 *   improvements only      → the writer runs, then the check runs AGAIN and must come
 *                            back clean (a writer that did not converge is an error,
 *                            not a banked win).
 *   error                  → a check that could not run writes nothing; a writer that
 *                            failed or did not converge DID write, so the bank puts its
 *                            registered artifacts back to their pre-run bytes — an
 *                            error leaves those files as they were. A path the restore
 *                            could not put back is reported as LEFT MODIFIED, never as
 *                            banked.
 *
 * ── EXIT CODES (scripts/hooks/pre-push reads them) ─────────────────────────────
 *   0  no drift anywhere that was checked
 *   3  improvement-only drift was WRITTEN (or, with --dry-run, WOULD be) — the files are
 *      listed; commit them
 *   1  at least one regression, a check that could not run, or a writer that failed or
 *      did not converge (its artifacts restored to their pre-run bytes). Improvements
 *      of OTHER ratchets are still written: one red ratchet does not hold every other
 *      win hostage. Where they land decides what the report tells
 *      the reader to do with them — see {@link ReportContext} (`--ephemeral`).
 *
 * ── THE REGISTRY IS TOTAL ───────────────────────────────────────────────────────
 * Every committed baseline/budget/ledger JSON a gate reads is in {@link REGISTRY} —
 * including the ones this file cannot bank, each with the REASON it cannot (a hand-
 * curated exemption list, a budget only a browser run measures, a ceiling measured on an
 * installation's data). test/unit/baseline_registry_tripwire.test.ts DISCOVERS the read
 * paths from the tree and fails on any artifact missing here, so a new ratchet cannot be
 * left out of the bank by forgetting it.
 *
 * ── TIERS ───────────────────────────────────────────────────────────────────────
 *   hermetic  tracked-source reads only (seconds). Always run.
 *   db        RUNS a test tier to measure it (~5 min each, needs the suite DB from
 *             `bun run test:db:setup`). Only with --with-db.
 *   network   reads a third-party advisory feed. Only with --with-network — it is a
 *             time-based input, so its home is the nightly job, not the push.
 *   manual    no writer by design; reported, never run.
 */

import {
	cpSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RatchetCheck } from './lib/ratchet_check.ts';

export const REPO_ROOT = join(import.meta.dir, '..');

export type RatchetTier = 'hermetic' | 'db' | 'network' | 'manual';

export interface RatchetEntry {
	/** Stable id; `RatchetCheck.ratchet` of the verdict must equal it. */
	id: string;
	/** The committed artifacts this ratchet owns, repo-relative. */
	artifacts: string[];
	tier: RatchetTier;
	/** `bun run` argv printing the `RatchetCheck` JSON line (absent on `manual`). */
	check?: string[];
	/** `bun run` argv of the ratchet's own FLAGLESS writer — refuses growth itself. */
	bank?: string[];
	/** The deliberate path a regression takes, printed verbatim. */
	regressionPath?: string;
	/** Why a `manual` entry has no bank, or what a non-hermetic tier needs. */
	reason?: string;
	/**
	 * Skip the post-write re-check (only where the check IS a multi-minute tier run).
	 * Sound only because such a writer re-measures and REFUSES by itself everything the
	 * check would call a regression — vacuity and crashed files included
	 * (scripts/lib/red_baseline.ts `writeRefusal` derives from `classifyTierDrift`).
	 */
	skipReverify?: boolean;
	/** A custom verdict (the advisory baseline: a scratch `--update` is its only check). */
	customCheck?: (root: string) => RatchetCheck;
}

/**
 * The advisory baseline has no `--check --json` of its own: its verdict IS "what would a
 * flagless `--update` write". So it is measured by running that writer over a SCRATCH
 * copy (`--baseline <scratch>`, which the script supports for exactly this kind of probe)
 * with `--require-network` (an unreachable feed must not look like "every advisory is
 * gone"), then comparing accepted KEYS. The writer refuses any new advisory by itself, so
 * the only drift a clean scratch run can show is removals — the improvement direction.
 */
function dependencyAuditCheck(root: string): RatchetCheck {
	const verdict: RatchetCheck = {
		ratchet: 'dependency_audit_baseline',
		baselines: ['engineering/dependency_audit_baseline.json'],
		improvements: [],
		regressions: [],
	};
	const committedPath = join(root, 'engineering/dependency_audit_baseline.json');
	const scratchDir = mkdtempSync(join(tmpdir(), 'dedalo-bank-audit-'));
	try {
		const scratch = join(scratchDir, 'baseline.json');
		cpSync(committedPath, scratch);
		const run = spawn(
			['scripts/ci/audit.ts', '--update', '--require-network', '--baseline', scratch],
			root,
		);
		if (run.exitCode !== 0) {
			verdict.regressions.push(
				`scripts/ci/audit.ts --update refused or failed (exit ${run.exitCode}): ${tail(run.stderr || run.stdout)}`,
			);
			return verdict;
		}
		const keys = (path: string): Set<string> => {
			const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
				accepted?: Record<string, { package?: string; id?: string | number }[]>;
			};
			const out = new Set<string>();
			for (const [dir, entries] of Object.entries(parsed.accepted ?? {})) {
				for (const entry of entries) out.add(`${dir}::${entry.package}::${entry.id}`);
			}
			return out;
		};
		const before = keys(committedPath);
		const after = keys(scratch);
		for (const key of before) {
			if (!after.has(key)) verdict.improvements.push(`advisory no longer reported: ${key}`);
		}
		for (const key of after) {
			if (!before.has(key)) verdict.regressions.push(`advisory newly accepted (?!): ${key}`);
		}
		return verdict;
	} finally {
		rmSync(scratchDir, { recursive: true, force: true });
	}
}

/**
 * EVERY committed baseline, budget and ledger JSON a gate reads. ORDER MATTERS: a
 * ratchet that READS another's artifact runs after it (twin_map derives its
 * `unmapped_reds` from engineering/parity_baseline.json).
 */
export const REGISTRY: readonly RatchetEntry[] = [
	{
		id: 'gate_vacuity_budget',
		artifacts: ['engineering/gate_vacuity_budget.json'],
		tier: 'hermetic',
		check: ['scripts/gate_vacuity_budget.ts', '--check', '--json'],
		bank: ['scripts/gate_vacuity_budget.ts', '--update'],
		regressionPath:
			'none — this budget only shrinks; remove the new silent return / unfloored toEqual([])',
	},
	{
		id: 'crap_complexity_baseline',
		artifacts: ['engineering/crap_complexity_baseline.json'],
		tier: 'hermetic',
		check: ['scripts/crap_baseline.ts', '--check', '--json'],
		bank: ['scripts/crap_baseline.ts', '--update'],
		regressionPath:
			'bun run scripts/crap_baseline.ts --update --allow-regression --reason "<the irreducible structure>"',
	},
	{
		id: 'error_throw_baseline',
		artifacts: ['engineering/error_throw_baseline.json'],
		tier: 'hermetic',
		check: ['scripts/error_throw_baseline.ts', '--check', '--json'],
		bank: ['scripts/error_throw_baseline.ts'],
		regressionPath:
			'bun run scripts/error_throw_baseline.ts --allow-regression (and say why in the commit message)',
	},
	{
		id: 'generic_tld_baseline',
		artifacts: ['engineering/generic_tld_baseline.json'],
		tier: 'hermetic',
		check: ['scripts/generic_tld_baseline.ts', '--check', '--json'],
		bank: ['scripts/generic_tld_baseline.ts'],
		regressionPath:
			'bun run scripts/generic_tld_baseline.ts --allow-regression (and say why in the commit message)',
	},
	{
		id: 'site_builder_single_source_baseline',
		artifacts: ['engineering/site_builder_single_source_baseline.json'],
		tier: 'hermetic',
		check: ['scripts/site_builder_single_source_baseline.ts', '--check', '--json'],
		bank: ['scripts/site_builder_single_source_baseline.ts'],
		regressionPath:
			'bun run scripts/site_builder_single_source_baseline.ts --allow-regression (the reason goes in the entry and the commit message)',
	},
	{
		id: 'lint_browser_budget',
		artifacts: ['engineering/lint_browser_budget.json'],
		tier: 'hermetic',
		check: ['scripts/lint_browser_budget.ts', '--check', '--json'],
		bank: ['scripts/lint_browser_budget.ts', '--update'],
		regressionPath: 'none — this budget only shrinks; fix the new browser lint finding',
	},
	{
		id: 'client_gate_inventory',
		artifacts: ['engineering/client_gate_inventory.json'],
		tier: 'hermetic',
		check: ['scripts/client_test_runner.ts', '--check', '--json'],
		bank: ['scripts/client_test_runner.ts', '--bank-static'],
		regressionPath:
			'a hand edit of engineering/client_gate_inventory.json whose commit says which suites went / why a budget rose',
		reason:
			'the STATIC half only (budgets + the registry-derived suite floor); mocha_test_floor moves only with a green `bun run test:client -- --update`',
	},
	{
		id: 'unit_baseline',
		artifacts: ['engineering/unit_baseline.json'],
		tier: 'db',
		check: ['scripts/unit_baseline.ts', '--check', '--json'],
		bank: ['scripts/unit_baseline.ts'],
		regressionPath:
			'bun run ci:local --docker --record-unit-baseline --allow-regression --reason "<why, per file>" (and say WHY in the commit message)',
		reason:
			"runs test/unit + test/integration (~5 min) on the suite DB; recorded in the CI image only — the writer refuses elsewhere (UNIT_TIER.recordOnlyInCiImage), so on a desk this row's bank fails by design: bun run ci:local --docker --record-unit-baseline. A NEW file's floor alone (the hermetic suite_assertion_floor_tripwire reddens on an unrecorded file) has its own narrow door that measures only that file and refuses a red — in the image too: bun run ci:local --docker --record-unit-baseline --new <file>",
		skipReverify: true,
	},
	{
		id: 'parity_baseline',
		artifacts: ['engineering/parity_baseline.json'],
		tier: 'db',
		check: ['scripts/parity_baseline.ts', '--check', '--json'],
		bank: ['scripts/parity_baseline.ts'],
		regressionPath:
			'bun run scripts/parity_baseline.ts --allow-regression (plus an engineering/wire_contract/ entry the same day)',
		reason: 'runs test/parity against the frozen fixture store on the suite DB',
		skipReverify: true,
	},
	{
		id: 'twin_map',
		artifacts: ['engineering/twin_map.json'],
		tier: 'hermetic',
		check: ['scripts/twin_map.ts', '--check', '--json'],
		bank: ['scripts/twin_map.ts'],
		regressionPath:
			'fix the @twin-of / @twin-status / @twinned-by headers or NOT_A_TWIN; growth: bun run scripts/twin_map.ts --allow-regression',
	},
	{
		id: 'dependency_audit_baseline',
		artifacts: ['engineering/dependency_audit_baseline.json'],
		tier: 'network',
		customCheck: dependencyAuditCheck,
		bank: ['scripts/ci/audit.ts', '--update', '--require-network'],
		regressionPath:
			'bun run scripts/ci/audit.ts --update --allow-regression --reason "<why it is accepted rather than fixed>"',
		reason:
			'reads the advisory feed — a time-based input; its home is the nightly job. Banks REMOVALS only',
	},
	{
		id: 'crap_coverage_exempt',
		artifacts: ['engineering/crap_coverage_exempt.json'],
		tier: 'manual',
		reason:
			'a hand-curated list of DECISIONS (a function no test may execute, each with its reason and a COVERAGE-EXEMPT marker next to the code); there is no measure to regenerate it from',
	},
	{
		id: 'client_a11y_budget',
		artifacts: ['engineering/client_a11y_budget.json'],
		tier: 'manual',
		reason:
			'measured only by the axe phase of a real browser run (bun run test:client); every row carries a human reason, and the gate is judged there',
	},
	{
		id: 'crawl_inventory',
		artifacts: ['engineering/crawl_inventory.json'],
		tier: 'manual',
		reason:
			'measured only by a real browser run (bun run test:crawl, its own server and three personas); banked there by `--update` after a green FULL run, which never lowers a floor',
	},
	{
		id: 'crawl_posture_budget',
		artifacts: ['engineering/crawl_posture_budget.json'],
		tier: 'manual',
		reason:
			'measured only by a real browser run (bun run test:crawl: axe, keyboard and 360px checks on every page as three personas); lowered there by `--update` after a green FULL run',
	},
	{
		id: 'client_a11y_backlog',
		artifacts: ['engineering/client_a11y_backlog.json'],
		tier: 'manual',
		reason:
			'its census lives INSIDE test/unit/client_keyboard_activation_tripwire.test.ts and has no generator yet; a fall is lowered by hand until that census moves to scripts/lib/ with a --check --json',
	},
	{
		id: 'observer_shrink_budget',
		artifacts: ['engineering/observer_shrink_budget.json'],
		tier: 'manual',
		reason:
			'a CEILING for an ops sweep over an INSTALLATION’s relation data (scripts/observer_reconcile.ts --budget), not a measure of this tree; raised only with a --json census proving every drop genuine',
	},
	{
		id: 'el_drill_record',
		artifacts: ['engineering/el_drill_record.json'],
		tier: 'manual',
		reason:
			'MEASURED only by the EL init drill on a disposable SELinux-enforcing RHEL/Rocky/Alma VM (`bun run test:pubhost:init:el --record`, after a green run): no CI runner has an EL kernel, so there is nothing to regenerate here. test/unit/publication_host_el_drill_record.test.ts judges it (the inputs digest of EL_DRILL_INPUTS, the hosts, the legs)',
	},
	{
		id: 'release_root_entries',
		artifacts: ['engineering/release_root_entries.json'],
		tier: 'manual',
		reason:
			'a DECISION list, not a measure: which top-level entries a release ships to every install (test/unit/release_root_entries_tripwire.test.ts). Regenerating it from the tree would bank exactly the accident it exists to stop (an editor config committed at the root), so every add or removal is a hand edit in review',
	},
	{
		id: 'image_registries',
		artifacts: ['engineering/image_registries.json'],
		tier: 'manual',
		reason:
			'a SOURCE, not a measure: the official image registry list (addresses, signing identity) is a hand decision; the generated copies (deploy/image_registries.sh, the docs/install/docker.md table) derive FROM it via `bun run registries:gen` and are gated by `registries:check` (test/unit/image_registries_tripwire.test.ts) — nothing derives the list itself',
	},
	{
		id: 'derivation_versions',
		artifacts: ['engineering/derivation_versions.json'],
		tier: 'manual',
		reason:
			'an EQUALITY bank of hand-bumped derivation versions (update audit U-38/U-30: media rules TEMPLATE_VERSION, SEARCH_STORE_DERIVATION_VERSION) and the hash of what each surface produces; release_manifest_completeness_tripwire demands equality. The decision is the BUMP in code, so the bank cannot raise it on its own: `bun run scripts/derivation_versions.ts --update` re-records after a bump and refuses a hash that moved under an unchanged version or a version that went backwards',
	},
	{
		id: 'install_seed_contract',
		artifacts: ['engineering/install_seed_contract.json'],
		tier: 'manual',
		reason:
			'an EXACT, shrink-only exception list whose every entry carries a hand-written reason: the core seed’s dangling DEPENDENCY references (src/core/ontology/ontology_references.ts measures them; test/unit/install_seed_drift_tripwire.test.ts demands equality). A writer would bank a new dangling reference without the reason the gate exists to demand, so an entry leaves only by hand after the seed is rebuilt',
	},
];

// ── execution ────────────────────────────────────────────────────────────────

interface Spawned {
	exitCode: number;
	stdout: string;
	stderr: string;
}

function spawn(argv: readonly string[], root: string): Spawned {
	const proc = Bun.spawnSync(['bun', 'run', ...argv], {
		cwd: root,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	return {
		exitCode: proc.exitCode ?? 1,
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
	};
}

function tail(text: string, lines = 12): string {
	return text.trim().split('\n').slice(-lines).join('\n');
}

/**
 * The verdict line out of a check's stdout — the LAST line that parses as a
 * RatchetCheck for this id. Anything else (a crash, a missing line, the wrong id) is
 * null, and the caller treats null as an error: a check that could not speak is not a
 * clean check.
 */
export function parseVerdict(stdout: string, id: string): RatchetCheck | null {
	const lines = stdout.trim().split('\n').reverse();
	for (const line of lines) {
		if (!line.startsWith('{')) continue;
		try {
			const parsed = JSON.parse(line) as Partial<RatchetCheck>;
			if (
				parsed.ratchet === id &&
				Array.isArray(parsed.improvements) &&
				Array.isArray(parsed.regressions) &&
				parsed.improvements.every((l) => typeof l === 'string') &&
				parsed.regressions.every((l) => typeof l === 'string')
			) {
				return {
					ratchet: id,
					baselines: Array.isArray(parsed.baselines) ? parsed.baselines : [],
					improvements: parsed.improvements,
					regressions: parsed.regressions,
				};
			}
		} catch {
			// not the verdict line
		}
	}
	return null;
}

export type RatchetStatus =
	| 'clean'
	| 'banked'
	| 'would_bank'
	| 'regressed'
	| 'error'
	| 'skipped'
	| 'manual';

export interface RatchetOutcome {
	id: string;
	tier: RatchetTier;
	status: RatchetStatus;
	improvements: string[];
	regressions: string[];
	/**
	 * Artifacts whose bytes differ from before the run once the ratchet is done. On
	 * `banked` these are the banked files; on `error` only a path the restore could NOT
	 * put back (left modified — never to be committed as a win).
	 */
	written: string[];
	/** `error` only: artifacts the writer changed and the bank put back to pre-run bytes. */
	restored: string[];
	/** One line: why skipped/manual, the error, or the regression path. */
	note?: string;
}

export interface BankOptions {
	dryRun: boolean;
	only: ReadonlySet<string> | null;
	withDb: boolean;
	withNetwork: boolean;
	root: string;
	/** Progress lines (stderr in the CLI, so --json keeps stdout). */
	progress: (line: string) => void;
}

/**
 * THE DECISION, pure: what one verdict means. Exported so the unit gate proves the
 * classification (regressions ⇒ never write; improvements only ⇒ write; nothing ⇒
 * clean) without spawning a single ratchet.
 */
export function decide(verdict: RatchetCheck, dryRun: boolean): RatchetStatus {
	if (verdict.regressions.length > 0) return 'regressed';
	if (verdict.improvements.length === 0) return 'clean';
	return dryRun ? 'would_bank' : 'banked';
}

function measureVerdict(entry: RatchetEntry, root: string): RatchetCheck | string {
	if (entry.customCheck !== undefined) {
		try {
			return entry.customCheck(root);
		} catch (error) {
			return `custom check threw: ${String(error)}`;
		}
	}
	if (entry.check === undefined) return 'no check registered';
	const run = spawn(entry.check, root);
	const verdict = parseVerdict(run.stdout, entry.id);
	if (verdict === null) {
		return `\`bun run ${entry.check.join(' ')}\` printed no verdict (exit ${run.exitCode}):\n${tail(`${run.stdout}\n${run.stderr}`)}`;
	}
	return verdict;
}

type Snapshot = Map<string, Buffer | null>;

/** Raw BYTES (not text): a restore must put back exactly what was there. */
function snapshot(root: string, artifacts: readonly string[]): Snapshot {
	return new Map(
		artifacts.map((path) => {
			const abs = join(root, path);
			return [path, existsSync(abs) ? readFileSync(abs) : null];
		}),
	);
}

function sameBytes(a: Buffer | null | undefined, b: Buffer | null | undefined): boolean {
	if (a == null || b == null) return a == null && b == null;
	return a.equals(b);
}

function changedPaths(before: Snapshot, after: Snapshot): string[] {
	return [...before.keys()].filter((path) => !sameBytes(before.get(path), after.get(path)));
}

/**
 * An ERROR after the writer ran: put every artifact it changed back to its pre-run
 * bytes (a file that did not exist is removed). Returns what is back and what is not —
 * measured by re-reading, never assumed from the write succeeding.
 */
function restore(
	root: string,
	before: Snapshot,
	changed: readonly string[],
): { restored: string[]; leftModified: string[] } {
	for (const path of changed) {
		const abs = join(root, path);
		const bytes = before.get(path) ?? null;
		try {
			if (bytes === null) {
				if (existsSync(abs)) unlinkSync(abs);
			} else writeFileSync(abs, bytes);
		} catch {
			// measured below: a path that is still different is reported LEFT MODIFIED
		}
	}
	const now = snapshot(root, changed);
	const leftModified = changed.filter((path) => !sameBytes(before.get(path), now.get(path)));
	return { restored: changed.filter((path) => !leftModified.includes(path)), leftModified };
}

export function runRatchet(entry: RatchetEntry, options: BankOptions): RatchetOutcome {
	const base: RatchetOutcome = {
		id: entry.id,
		tier: entry.tier,
		status: 'clean',
		improvements: [],
		regressions: [],
		written: [],
		restored: [],
	};
	if (entry.tier === 'manual') {
		return { ...base, status: 'manual', note: entry.reason };
	}
	if (entry.tier === 'db' && !options.withDb) {
		return { ...base, status: 'skipped', note: `db tier — pass --with-db (${entry.reason})` };
	}
	if (entry.tier === 'network' && !options.withNetwork) {
		return {
			...base,
			status: 'skipped',
			note: `network tier — pass --with-network (${entry.reason})`,
		};
	}

	options.progress(`bank: ${entry.id} — checking`);
	const verdict = measureVerdict(entry, options.root);
	if (typeof verdict === 'string') return { ...base, status: 'error', note: verdict };
	const outcome: RatchetOutcome = {
		...base,
		improvements: verdict.improvements,
		regressions: verdict.regressions,
		status: decide(verdict, options.dryRun),
	};
	if (outcome.status === 'regressed') {
		return { ...outcome, note: `nothing written. Deliberate path: ${entry.regressionPath}` };
	}
	if (outcome.status !== 'banked') return outcome;

	// THE WRITE — the ratchet's own flagless writer, which refuses growth by itself.
	if (entry.bank === undefined) {
		return { ...outcome, status: 'error', note: 'improvement found but no writer registered' };
	}
	options.progress(`bank: ${entry.id} — banking ${verdict.improvements.length} improvement(s)`);
	const before = snapshot(options.root, entry.artifacts);
	const wrote = spawn(entry.bank, options.root);
	outcome.written = changedPaths(before, snapshot(options.root, entry.artifacts));
	// Every error past this point comes AFTER the writer ran: undo what it wrote, so an
	// error leaves the artifacts as they were, and report exactly what is (not) back.
	const failed = (note: string): RatchetOutcome => {
		const { restored, leftModified } = restore(options.root, before, outcome.written);
		return { ...outcome, status: 'error', note, written: leftModified, restored };
	};
	if (wrote.exitCode !== 0) {
		return failed(
			`the writer refused or failed (exit ${wrote.exitCode}):\n${tail(`${wrote.stdout}\n${wrote.stderr}`)}`,
		);
	}
	if (entry.skipReverify === true) return outcome;
	// CONVERGENCE: after the write the ratchet must be clean. A writer that left drift
	// behind banked something other than what was classified — an error, never a win.
	const again = measureVerdict(entry, options.root);
	if (typeof again === 'string') return failed(again);
	if (again.improvements.length + again.regressions.length > 0) {
		return failed(
			`the writer did not converge — still drifting after the write:\n  ${[...again.regressions, ...again.improvements].join('\n  ')}`,
		);
	}
	return outcome;
}

export interface BankResult {
	exitCode: 0 | 1 | 3;
	outcomes: RatchetOutcome[];
	/** Files BANKED (status `banked`) — the only ones a human or the hook may commit. */
	written: string[];
	/** ERROR outcomes' paths the restore could not put back: modified, NOT banked. */
	leftModified: string[];
}

/** The run's exit code from its outcomes: 1 beats 3 beats 0. */
export function exitCodeOf(outcomes: readonly RatchetOutcome[]): 0 | 1 | 3 {
	if (outcomes.some((o) => o.status === 'regressed' || o.status === 'error')) return 1;
	if (outcomes.some((o) => o.status === 'banked' || o.status === 'would_bank')) return 3;
	return 0;
}

export function bank(options: BankOptions): BankResult {
	const outcomes: RatchetOutcome[] = [];
	for (const entry of REGISTRY) {
		if (options.only !== null && !options.only.has(entry.id)) continue;
		outcomes.push(runRatchet(entry, options));
	}
	return summarize(outcomes);
}

/** The run's result from its outcomes (exported: the gate renders planted runs with it). */
export function summarize(outcomes: RatchetOutcome[]): BankResult {
	return {
		exitCode: exitCodeOf(outcomes),
		outcomes,
		written: outcomes.filter((o) => o.status === 'banked').flatMap((o) => o.written),
		leftModified: outcomes.filter((o) => o.status === 'error').flatMap((o) => o.written),
	};
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function readOnly(argv: readonly string[]): Set<string> | null {
	const index = argv.indexOf('--only');
	const inline = argv.find((arg) => arg.startsWith('--only='));
	const raw =
		inline !== undefined
			? inline.slice('--only='.length)
			: index >= 0
				? argv[index + 1]
				: undefined;
	if (index < 0 && inline === undefined) return null;
	const ids = (raw ?? '')
		.split(',')
		.map((id) => id.trim())
		.filter((id) => id !== '');
	const known = new Set(REGISTRY.map((entry) => entry.id));
	const unknown = ids.filter((id) => !known.has(id));
	if (ids.length === 0 || unknown.length > 0) {
		throw new Error(
			`baselines:bank: --only needs registered ids (unknown: ${unknown.join(', ') || '(none given)'}). Known: ${[...known].join(', ')}`,
		);
	}
	return new Set(ids);
}

/**
 * WHERE THE WRITES LAND, and therefore what the report may tell a human to do with them.
 *
 *   in place   (default) the bank ran in the tree the human works in: the written files
 *              are there, and "commit these" is the true instruction.
 *   ephemeral  (`--ephemeral`) the CALLER runs the bank in a tree it discards afterwards
 *              — scripts/hooks/pre-push runs it in a throwaway `git worktree` of the
 *              pushed commit. On exit 3 the caller collects and commits the files
 *              itself; on exit 1 it commits nothing and deletes the tree, so the other
 *              ratchets' banked improvements are GONE, and "commit these files too"
 *              would send the human looking for files that no longer exist. The true
 *              statement is that nothing is left to commit and the next run (after the
 *              regression is fixed) re-measures and banks them again.
 *
 * Every path is printed ABSOLUTE (under `root`) in both modes, so a line never names a
 * file relative to a directory the reader is not in.
 */
export interface ReportContext {
	dryRun: boolean;
	/** The tree the bank measured and wrote into. */
	root: string;
	/** The caller discards `root` after the run (see above). */
	ephemeral: boolean;
}

/**
 * The human report — TRUE PER OUTCOME, because each outcome left the tree differently:
 *
 *   REGRESSED  nothing was written; its line names the deliberate path.
 *   ERROR      no deliberate path exists (nothing about the floor is known). A check
 *              that could not run wrote nothing; a writer that failed or did not
 *              converge DID write, and its lines say what the bank restored to pre-run
 *              bytes — or, if the restore failed, what is LEFT MODIFIED (never banked).
 *   BANKED     its lines name the files banked; only these are ever offered to commit.
 *
 * On exit 1 it STILL accounts for what was banked for the other ratchets (their
 * improvements are written even when one ratchet is red) — and says where, and what (if
 * anything) the reader must do about it, per {@link ReportContext}. Exported for the
 * unit gate.
 */
export function render(result: BankResult, context: ReportContext): string[] {
	const lines: string[] = [];
	const abs = (path: string): string => join(context.root, path);
	const listOf = (paths: readonly string[]): string => `\n  ${paths.map(abs).join('\n  ')}`;
	for (const o of result.outcomes) {
		lines.push(`${o.status.toUpperCase().padEnd(10)} ${o.id}${o.note ? ` — ${o.note}` : ''}`);
		for (const line of o.regressions) lines.push(`    - ${line}`);
		for (const line of o.improvements) lines.push(`    + ${line}`);
		if (o.status === 'banked') {
			for (const path of o.written) lines.push(`    = banked: ${abs(path)}`);
		} else if (o.status === 'error') {
			if (o.written.length + o.restored.length === 0) {
				lines.push('    nothing was written for it');
			}
			for (const path of o.restored) {
				lines.push(`    ~ the writer changed it; restored to its pre-run bytes: ${abs(path)}`);
			}
			for (const path of o.written) {
				lines.push(
					`    ! the writer changed it and the restore FAILED — LEFT MODIFIED, not banked: ${abs(path)}`,
				);
			}
		}
	}
	if (result.exitCode === 3) {
		const list = listOf(result.written);
		if (context.dryRun) {
			lines.push(
				'\nImprovement-only drift found (dry run — nothing written). Run without --dry-run to bank it.',
			);
		} else if (context.ephemeral) {
			lines.push(
				`\nBANKED improvement-only drift into ${context.root} — a tree the caller discards; the caller collects and commits:${list}`,
			);
		} else {
			lines.push(`\nBANKED improvement-only drift. Commit these files:${list}`);
		}
	} else if (result.exitCode === 1) {
		const regressed = result.outcomes.filter((o) => o.status === 'regressed');
		const errored = result.outcomes.filter((o) => o.status === 'error');
		if (regressed.length > 0) {
			lines.push(
				`\nRED: ${regressed.length} ratchet(s) REGRESSED (${regressed.map((o) => o.id).join(', ')}). Nothing was written for them; each one's deliberate path is printed on its line.`,
			);
		}
		if (errored.length > 0) {
			const restored = errored.flatMap((o) => o.restored);
			const what =
				restored.length + result.leftModified.length === 0
					? 'Nothing was written for them.'
					: restored.length > 0
						? `What a failed writer wrote was restored to its pre-run bytes (${restored.length} file(s), named on its line)${result.leftModified.length > 0 ? ' — except the files below' : ''}.`
						: 'The restore of what a failed writer wrote FAILED — see the files below.';
			lines.push(
				`\nRED: ${errored.length} ratchet(s) hit an ERROR (${errored.map((o) => o.id).join(', ')}) — a check that could not run or a writer that failed / did not converge. There is no deliberate path; fix the cause on its line. ${what}`,
			);
			if (result.leftModified.length > 0) {
				lines.push(
					context.ephemeral
						? `\nLEFT MODIFIED by a failed writer (restore failed), in ${context.root}, a tree the caller DISCARDS — NOT banked, nothing to commit:${listOf(result.leftModified)}`
						: `\nLEFT MODIFIED by a failed writer (restore failed) — NOT banked; do NOT commit them, restore them by hand (git checkout -- <file>):${listOf(result.leftModified)}`,
				);
			}
		}
		if (result.written.length > 0) {
			const list = listOf(result.written);
			lines.push(
				context.ephemeral
					? `\nOther ratchets' improvements were written into ${context.root}, a tree the caller DISCARDS on this exit — nothing to commit from them. Once the red ratchet is fixed, the next run re-measures and banks them again:${list}`
					: `\nOther ratchets' improvements WERE banked — commit these files too:${list}`,
			);
		}
	} else {
		lines.push('\nNo baseline drift.');
	}
	return lines;
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const dryRun = argv.includes('--dry-run');
	const json = argv.includes('--json');
	const ephemeral = argv.includes('--ephemeral');
	let only: Set<string> | null;
	try {
		only = readOnly(argv);
	} catch (error) {
		console.error((error as Error).message);
		process.exit(1);
	}
	const result = bank({
		dryRun,
		only,
		withDb: argv.includes('--with-db'),
		withNetwork: argv.includes('--with-network'),
		root: REPO_ROOT,
		progress: (line) => console.error(line),
	});
	if (json) {
		console.log(
			JSON.stringify({
				exit: result.exitCode,
				dry_run: dryRun,
				root: REPO_ROOT,
				ephemeral,
				written: result.written,
				left_modified: result.leftModified,
				outcomes: result.outcomes,
			}),
		);
	} else
		for (const line of render(result, { dryRun, root: REPO_ROOT, ephemeral })) console.log(line);
	process.exit(result.exitCode);
}
