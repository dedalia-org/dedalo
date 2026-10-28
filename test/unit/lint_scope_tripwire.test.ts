/**
 * TRIPWIRE — biome's own FILE SCOPE is a decision, and every decision in it is
 * written down (P1-17 / GATE-44).
 *
 * `bun run lint` is `biome check .`, and the linter only sees what
 * `biome.jsonc`'s `files.includes` lets it see. Nothing in this repo guarded
 * that list: `ci_workflow_tripwire` guards the TRIPWIRES array, so a new
 * `!**​/some_tree` was invisible to every mechanical check — the one edit that
 * can silently retire a whole subsystem from static analysis while lint stays
 * green.
 *
 * It had already happened. `!**​/client` excluded the tree AGENTS.md calls "the
 * PRIMARY, TS-OWNED client source" — ~315k lines, 1765 biome errors, including
 * the 157 a11y/noSvgWithoutTitle and the noAsyncPromiseExecutor hits that other
 * findings in this audit name by rule id. The file is JSONC precisely so rule
 * decisions can carry their justification inline, and two of the twenty-four
 * exclusions did.
 *
 * THE RULE. Every `!` entry carries an inline reason, and the browser trees are
 * not merely excluded and forgotten — they are measured by a shrink-only budget
 * (scripts/lint_browser_budget.ts), which this file pins as still armed.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
	BROWSER_EXCLUSIONS,
	materializeScopeConfig,
	parseBiomeSummary,
	readBudget,
} from '../../scripts/lint_browser_budget.ts';
import { daemonPackages } from '../helpers/daemon_package_corpus.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const CONFIG = join(REPO_ROOT, 'biome.jsonc');

/**
 * The closed census of what biome does not read. Grouped as biome.jsonc groups
 * them, so the two lists read the same way.
 */
const EXPECTED_EXCLUSIONS = [
	// Not ours, not edited here.
	'!**/node_modules',
	'!**/vendor',
	'!**/tools/tool_lang/translators/browser_transformer',
	'!**/tools/tool_transcription/transcribers/browser_whisper',
	'!**/tools/**/*/transcribers/lib/**/*.js',
	// Tooling and editor state.
	'!**/.agents',
	'!**/.claude',
	'!**/.vscode',
	'!**/.venv',
	// Generated output and prose.
	'!**/docs_site',
	// Local-only, gitignored, never on a clone.
	'!**/audits',
	'!**/.cache',
	'!**/dev',
	'!**/dev_tools',
	'!**/rewrite',
	'!**/.superpowers',
	'!**/docs',
	// Frozen fixture bytes — reformatting one is a wire-contract edit.
	'!**/test/parity/fixtures/**/*.response.json',
	'!**/test/parity/fixtures/oracle_harvest',
	'!**/src/core/components/**/*/samples/**/*.json',
	'!**/.claude_migration_component_alias_preimage.json',
	// Install seed data and generated registries.
	'!**/install/import',
	'!**/tools/**/*/register.json',
	// Static assets with no JS/TS in them.
	'!**/tools/**/*/css',
	'!**/tools/**/*/img',
	// The publication daemons — excluded from lint, but carried by the shrink-only
	// per-package budget below (PUBLICATION_BUDGETS).
	'!**/publication/site_builder',
	'!**/publication/host_agent',
	'!**/publication/server_api/v2',
	// The legacy PHP v1 Publication API and its vendored swagger-ui bundle.
	'!**/publication/server_api/v1',
	// The browser trees — excluded from lint, but carried by the shrink-only
	// budget in scripts/lint_browser_budget.ts.
	'!**/client',
	'!**/tools/**/*/js',
	// Generated data over biome's 1 MiB cap (these two already carried their
	// reason before this gate existed).
	'!**/src/core/test_data/test_tld_ontology.json',
	'!**/src/core/test_data/test_corpus/**/*.json',
] as const;

interface Exclusion {
	pattern: string;
	line: number;
	reasoned: boolean;
}

/**
 * Every `!`-prefixed entry, with whether a comment sits directly above it (or
 * above the run of exclusions it belongs to — one reason may cover a group, the
 * way the generated-data pair is already written).
 */
function exclusions(): Exclusion[] {
	const lines = readFileSync(CONFIG, 'utf8').split('\n');
	const found: Exclusion[] = [];
	let reasonedSinceComment = false;
	for (const [index, raw] of lines.entries()) {
		const text = raw.trim();
		if (text.startsWith('//')) {
			reasonedSinceComment = true;
			continue;
		}
		// EVERY quoted "!" pattern on the line, not just a line that IS one entry:
		// `"**", "!**/src/core/security",` is valid JSONC that biome honours, and a
		// whole-line regex never sees the second pattern. Measured — that evaded
		// both this test and the closed census below.
		const patterns = text.match(/"![^"]+"/g) ?? [];
		if (patterns.length === 0) {
			// A blank line does NOT end a reason's run (the groups in biome.jsonc are
			// separated by blanks); any other content does.
			if (text !== '') reasonedSinceComment = false;
			continue;
		}
		for (const quoted of patterns) {
			found.push({
				pattern: quoted.slice(1, -1),
				line: index + 1,
				// A reason must be the NEAREST preceding comment with no unrelated
				// content between. One comment may license a contiguous group, which
				// is how biome.jsonc is written.
				reasoned: reasonedSinceComment,
			});
		}
	}
	return found;
}

/**
 * THE TREES THAT MUST ACTUALLY BE LINTED — one representative directory per
 * subsystem `bun run lint` is believed to cover.
 */
const MUST_BE_LINTED = [
	'src/core/security',
	'src/core/db',
	'src/core/api',
	'src/external',
	'src/diffusion',
	'tools/tool_time_machine/server',
	'scripts',
	'test/unit',
] as const;

/**
 * Does biome REALLY lint this directory? Writes a file with a violation biome's
 * recommended rules certainly flag, asks biome, removes it.
 *
 * WHY MEASURE INSTEAD OF READING THE CONFIG. Reading `files.includes` checks one
 * of the FOUR independent ways a tree leaves static analysis, and an adversarial
 * review drove a truck through the other three while this gate stayed green:
 *   - narrowing the positive include (`"**"` → `"src"`) retires every other tree;
 *   - an `overrides` entry with `"linter": {"enabled": false}` silences a path
 *     without touching the exclusion list at all;
 *   - `vcs.useIgnoreFile: true` hands biome's scope to .gitignore, where a single
 *     appended line removes a TRACKED tree.
 * None of those moves a `!` pattern. Asking biome what it actually does is the
 * only question with one answer.
 */
function isLinted(directory: string, configPath?: string): boolean {
	const dir = join(REPO_ROOT, directory);
	// A tree that MOVED is not a tree that is linted — say so, rather than dying
	// on an ENOENT that reads like a broken test.
	if (!existsSync(dir)) throw new Error(`${directory} does not exist — fix MUST_BE_LINTED`);
	const probe = join(dir, 'zz_lint_scope_probe.ts');
	try {
		// `var` (style/noVar) and `debugger` (suspicious/noDebugger) are both
		// recommended-preset rules this repo declares explicitly.
		writeFileSync(probe, 'var zzProbe = 1;\ndebugger;\nexport default zzProbe;\n');
		const command =
			configPath === undefined
				? ['bunx', 'biome', 'lint', probe]
				: ['bunx', 'biome', 'lint', `--config-path=${configPath}`, probe];
		const run = Bun.spawnSync(command, {
			cwd: REPO_ROOT,
			stdout: 'pipe',
			stderr: 'pipe',
		});
		// biome exits NON-ZERO when it finds the violation — that is the good case,
		// so the exit code is not the signal; the rule name is.
		const output = run.stdout.toString() + run.stderr.toString();
		return /noVar|noDebugger/.test(output);
	} finally {
		rmSync(probe, { force: true });
	}
}

describe('lint scope is a written-down decision', () => {
	const all = exclusions();

	test('the parse actually finds the exclusion list (anti-vacuity)', () => {
		// A regex that matched nothing would make every assertion below pass.
		expect(all.length).toBeGreaterThan(15);
		expect(all.map((e) => e.pattern)).toContain('!**/node_modules');
	});

	test('every exclusion carries an inline reason', () => {
		const bare = all.filter((entry) => !entry.reasoned);
		expect(
			bare.map((entry) => `biome.jsonc:${entry.line}  ${entry.pattern}`),
			'An unexplained exclusion is a subsystem silently retired from static analysis. ' +
				'This file is JSONC so the reason can sit right above the pattern — write it: ' +
				'what the tree is, and why biome must not read it.\n  ' +
				bare.map((entry) => `${entry.pattern} (line ${entry.line})`).join('\n  '),
		).toEqual([]);
	});

	test('the exclusion SET is closed — a new one cannot ride an existing reason', () => {
		// The reason-above-the-line rule alone is not enough: a comment licenses the
		// contiguous run beneath it, so a new pattern dropped INTO a reasoned group
		// inherits a justification written about something else. Measured — that is
		// exactly how `"!**/src/core/security"` slipped past the first draft of this
		// file. So the set is frozen here too: excluding a new tree takes an edit in
		// BOTH places, which is the point at which somebody has to justify it.
		expect(
			all.map((entry) => entry.pattern).sort(),
			'The biome exclusion list changed. If a tree genuinely must leave static ' +
				'analysis, write the reason inline in biome.jsonc AND add the pattern here — ' +
				'deliberately, in the same commit. If one was REMOVED, delete it here too.',
		).toEqual([...EXPECTED_EXCLUSIONS].sort());
	});

	test('the browser trees are excluded from lint but NOT from measurement', () => {
		// The exclusion is allowed to stand — a flag day would leave verify red for
		// the length of the burn-down, which is how a gate gets switched off. What
		// is NOT allowed is for it to stand unmeasured.
		const config = readFileSync(CONFIG, 'utf8');
		for (const exclusion of BROWSER_EXCLUSIONS) {
			expect(
				config,
				`${exclusion} is gone from biome.jsonc. If the browser tree is genuinely linted ` +
					'now, DELETE the budget script and this test rather than leaving them ' +
					'measuring an empty scope.',
			).toContain(exclusion);
		}
	});

	test('the budget is real, current, and non-trivial', () => {
		const budget = readBudget();
		// It must actually cover the client tree — a budget over 3 files would pass
		// forever while saying nothing.
		expect(budget.files).toBeGreaterThan(900);
		expect(budget.errors).toBeGreaterThan(0);
		expect(budget.measured).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	test('the summary parser reads biome real output shape', () => {
		// The ratchet is only as good as this parse: a silent 0 would make every
		// future run look like a total win.
		const sample =
			'Checked 1,123 files in 3s. No fixes applied.\n' +
			'Found 2,148 errors.\nFound 6,921 warnings.\n';
		expect(parseBiomeSummary(sample)).toEqual({ files: 1123, errors: 2148, warnings: 6921 });
		// A clean tree prints no "Found …" line at all — that must read as zero,
		// not as a parse failure.
		expect(parseBiomeSummary('Checked 12 files in 1s. No fixes applied.\n')).toEqual({
			files: 12,
			errors: 0,
			warnings: 0,
		});
	});

	test('biome REALLY lints every tree lint is believed to cover', () => {
		// The outcome test. A config-reading gate checks one of four doors; this
		// one asks biome. Slower (a biome run per tree) and worth it: three of the
		// four evasions an adversarial review found leave every `!` pattern intact.
		const dark = MUST_BE_LINTED.filter((directory) => !isLinted(directory));
		expect(
			dark,
			'These trees are NOT actually linted, however biome.jsonc reads. Check for a ' +
				'narrowed positive include, an `overrides` entry disabling the linter, or ' +
				'`vcs.useIgnoreFile` handing scope to .gitignore.\n  ' +
				dark.join('\n  '),
		).toEqual([]);
	});

	test('the probe itself can detect an unlinted tree (anti-vacuity)', () => {
		// If isLinted() returned true unconditionally the test above proves nothing.
		// client/ is EXCLUDED by design, so it must read as not-linted.
		expect(isLinted('client/dedalo/core/common/js')).toBe(false);
	});

	test('the BUDGET config really lints the browser trees it counts', () => {
		// The compensating control needs its own control. The derived config is a
		// COPY of biome.jsonc with two exclusion lines removed — so an `overrides`
		// entry disabling the linter over `**/client/**` is copied in with it. The
		// file count stays ~1123, assertMeasured's floor passes, the error count
		// collapses to nothing, and `--update` (which only refuses a HIGHER number)
		// banks the collapse permanently. A zeroed shrink-only ratchet cannot be
		// un-zeroed. So: prove the budget's own config still LINTS what it counts.
		const configPath = materializeScopeConfig();
		try {
			expect(isLinted('client/dedalo/core/common/js', configPath)).toBe(true);
		} finally {
			rmSync(dirname(configPath), { force: true, recursive: true });
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// THE PUBLICATION DAEMONS (audit 2026-09-26 W4 residual, 2026-10-21).
//
// `!**/publication` sat in biome.jsonc with the reason "publication/ is read-only
// and gated separately (`bun run test:publication` runs its own tsc + suite)".
// Measured false on both counts: site_builder and host_agent are WRITERS (sites,
// web-server rules, provisioning as root), and their separate gate — the hermetic
// daemon block, `test:sitebuilder`, `hostagent:test` — is tsc + bun test with no
// lint at all. `biome check publication/site_builder` answered "Checked 0 files".
// So ~530 files of first-party TypeScript had NO static analysis while lint was
// green: 350 errors in site_builder, 436 in host_agent, 126 in server_api/v2.
//
// Same remedy as the browser trees, same reason (a flag day would leave lint red
// for the length of the burn-down): each daemon package is excluded from `bun run
// lint` but measured under a SHRINK-ONLY error ceiling with the SAME rule set —
// the budget config is biome.jsonc with exactly the three budget exclusions
// removed, never a second rule list. The package census is DERIVED (every
// directory under publication/ with a package.json and a tsconfig.json —
// test/helpers/daemon_package_corpus.ts), so a
// fourth daemon cannot be born dark: it is either linted by `bun run lint` or
// budgeted here.
// ─────────────────────────────────────────────────────────────────────────────

/** The exclusion lines the publication budget removes (exactly as biome.jsonc spells them). */
const PUBLICATION_BUDGET_EXCLUSIONS = [
	'"!**/publication/site_builder",',
	'"!**/publication/host_agent",',
	'"!**/publication/server_api/v2",',
] as const;

/**
 * Error ceilings per package — SHRINK-ONLY. Measured 2026-10-21 (biome 2.5.15).
 * When a burn-down lowers a count by more than PUBLICATION_SLACK, lower the
 * ceiling in the same commit; raising one is never the fix.
 */
const PUBLICATION_BUDGETS: Record<string, number> = {
	'publication/host_agent': 436,
	'publication/server_api/v2': 126,
	'publication/site_builder': 350,
};

/** How far below its ceiling a package may fall before the ceiling must follow. */
const PUBLICATION_SLACK = 20;

/** A budget run that saw fewer files than this did not measure the package. */
const PUBLICATION_MIN_FILES = 40;

/** biome.jsonc minus the publication budget exclusions, outside the repo (see materializeScopeConfig). */
function materializePublicationConfig(): string {
	let scoped = readFileSync(CONFIG, 'utf8');
	for (const exclusion of PUBLICATION_BUDGET_EXCLUSIONS) {
		if (!scoped.includes(exclusion)) {
			throw new Error(
				`biome.jsonc no longer excludes ${exclusion} — if that package is linted for real ` +
					'now, delete its budget here rather than measuring nothing.',
			);
		}
		scoped = scoped.replace(exclusion, '');
	}
	// `scratchDir`, not `dir`: hermetic_parallel_safety_tripwire resolves names file-wide,
	// and a second `dir` (this mkdtemp) would hide isLinted's in-tree probe from its anchor.
	const scratchDir = mkdtempSync(join(tmpdir(), 'dedalo-lint-publication-'));
	const path = join(scratchDir, 'biome.jsonc');
	writeFileSync(path, scoped);
	return path;
}

function measurePackage(pkg: string, configPath: string) {
	const run = Bun.spawnSync(
		['bunx', 'biome', 'check', `--config-path=${configPath}`, '--reporter=summary', pkg],
		{ cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' },
	);
	return parseBiomeSummary(run.stdout.toString() + run.stderr.toString());
}

describe('the publication daemons are linted, or measured under a shrink-only budget', () => {
	const packages = daemonPackages();

	test('the package census is derived and real (anti-vacuity)', () => {
		expect(packages.length).toBeGreaterThan(2);
		expect(packages).toContain('publication/site_builder');
		expect(packages).toContain('publication/host_agent');
		expect(packages).toContain('publication/server_api/v2');
	});

	test('every daemon package is either linted by `bun run lint` or budgeted', () => {
		const dark = packages.filter(
			(pkg) => PUBLICATION_BUDGETS[pkg] === undefined && !isLinted(`${pkg}/src`),
		);
		expect(
			dark,
			'These daemon packages are read by NO static analysis: excluded from biome.jsonc and ' +
				'not budgeted. Lint them (remove the exclusion and fix), or add a shrink-only ' +
				'ceiling to PUBLICATION_BUDGETS with its exclusion in PUBLICATION_BUDGET_EXCLUSIONS.',
		).toEqual([]);
		// And a budget names a package that exists (a stale ceiling measures nothing),
		// whose exclusion is exactly the one the budget config removes.
		for (const pkg of Object.keys(PUBLICATION_BUDGETS)) {
			expect(packages).toContain(pkg);
			expect(PUBLICATION_BUDGET_EXCLUSIONS as readonly string[]).toContain(`"!**/${pkg}",`);
		}
	});

	test('each budgeted package stays within its ceiling, and the ceiling follows a burn-down', () => {
		const configPath = materializePublicationConfig();
		try {
			for (const [pkg, ceiling] of Object.entries(PUBLICATION_BUDGETS)) {
				const counts = measurePackage(pkg, configPath);
				// A run that measured nothing is an error, never a perfect score.
				expect(counts.files, `${pkg}: biome measured almost nothing`).toBeGreaterThanOrEqual(
					PUBLICATION_MIN_FILES,
				);
				expect(
					counts.errors,
					`${pkg}: ${counts.errors} biome errors > ceiling ${ceiling}. The budget only SHRINKS — ` +
						`fix the new finding (bunx biome check --config-path=<biome.jsonc minus the ` +
						`publication exclusions> ${pkg}).`,
				).toBeLessThanOrEqual(ceiling);
				expect(
					ceiling - counts.errors,
					`${pkg}: ${counts.errors} errors is far below the ceiling ${ceiling} — lower it in PUBLICATION_BUDGETS so the gain is banked.`,
				).toBeLessThan(PUBLICATION_SLACK);
			}
		} finally {
			rmSync(dirname(configPath), { force: true, recursive: true });
		}
	});

	test('the BUDGET config really lints every budgeted package (the control has its own control)', () => {
		const configPath = materializePublicationConfig();
		try {
			for (const pkg of Object.keys(PUBLICATION_BUDGETS)) {
				expect(isLinted(`${pkg}/src`, configPath), pkg).toBe(true);
				// …while `bun run lint` does not (else the budget is a stale double count).
				expect(isLinted(`${pkg}/src`), `${pkg} is linted for real — delete its budget`).toBe(false);
			}
		} finally {
			rmSync(dirname(configPath), { force: true, recursive: true });
		}
	});
});
