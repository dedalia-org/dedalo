/**
 * THE ONE INSTALL STEP TABLE — `src/core/install/steps.ts` (INSTALL_STEPS) over
 * `step_runs.ts` (STEP_RUNS), the only implementation of every install step.
 *
 * Successor of install_step_router_native (2026-10-12, terminal installer phase 5 —
 * WC-2026-10-12-install-surface-removed): the wizard's step ROUTER is gone, so the
 * live cases it carried are asserted against the table the terminal executor runs:
 *
 *   - the table is keyed by exactly INSTALL_STEP_IDS, and each `run` IS the STEP_RUNS
 *     entry (one implementation, not two);
 *   - the thesaurus choice is normalized by the PLAN (core tlds dropped with a note,
 *     an unlisted tld refused) — the executor's install_hierarchies receives the
 *     plan's list, never a raw answer;
 *   - test_db_connection stops at its required-field guard before any spawn;
 *   - stage_ontologies without a resolved request, and install_ontologies with
 *     nothing staged, REFUSE (install.invalid_input / install.state_conflict);
 *   - check_directories reports one row per managed directory and, without the
 *     create pass, creates nothing.
 *
 * Scratch namespace: zzi. No DB writes; the filesystem-touching runs execute in a
 * CHILD pointed at a scratch private/media/backup root, and are SKIPPED (audibly)
 * unless every resolved directory is under it — dirIsWritable does a real
 * write+unlink and must never touch real user data.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isDedaloError } from '../../src/core/errors/index.ts';
import { buildInstallPlan, INSTALL_STEP_IDS } from '../../src/core/install/install_plan.ts';
import { STEP_RUNS } from '../../src/core/install/step_runs.ts';
import { INSTALL_STEPS } from '../../src/core/install/steps.ts';
import { absentScratchPath, scratchDir } from '../helpers/scratch_dir.ts';

const ROOT = join(import.meta.dir, '..', '..');

describe('the ONE step table', () => {
	test('INSTALL_STEPS is keyed by exactly INSTALL_STEP_IDS, each run IS the STEP_RUNS entry', () => {
		expect(Object.keys(INSTALL_STEPS).sort()).toEqual([...INSTALL_STEP_IDS].sort());
		for (const [key, definition] of Object.entries(INSTALL_STEPS)) {
			expect(definition.id, key).toBe(key as (typeof INSTALL_STEP_IDS)[number]);
			expect(definition.run, key).toBe(STEP_RUNS[key as keyof typeof STEP_RUNS]);
		}
		expect(Object.keys(STEP_RUNS).sort()).toEqual([...INSTALL_STEP_IDS].sort());
	});
});

describe('install_hierarchies takes the PLAN normalization', () => {
	const base = { db_database: 'zzi', db_username: 'zzi', entity: 'zzi' };

	test('a tld hierarchy.json does not list is a plan ERROR (nothing reaches the step)', () => {
		const plan = buildInstallPlan({ ...base, hierarchies: ['zzibogus'] });
		expect(plan.errors).toContain("unknown hierarchy 'zzibogus' (no entry in hierarchy.json)");
	});

	test('a core tld, in any case and repeated, is dropped with the note', () => {
		const plan = buildInstallPlan({ ...base, hierarchies: ['LG', 'lg'] });
		expect(plan.notes).toContain(
			'lg is a core hierarchy (always activated) — dropped from the list',
		);
		expect(plan.errors.filter((error) => error.includes("'lg'"))).toEqual([]);
	});
});

describe('test_db_connection', () => {
	test('stops at the required-field guard (no spawn)', async () => {
		const raw = await STEP_RUNS.test_db_connection({
			posted: {},
			createDirectories: false,
			actorUserId: -1,
		});
		expect(raw).toEqual({
			ok: false,
			can_connect: false,
			db_exists: false,
			can_create: false,
			msg: 'Database name and user are required',
		});
	});
});

describe('stage_ontologies', () => {
	test('without a resolved ontology request REFUSES install.invalid_input', async () => {
		let code: string | null = null;
		try {
			await STEP_RUNS.stage_ontologies({ posted: {}, createDirectories: false, actorUserId: -1 });
		} catch (error) {
			code = isDedaloError(error) ? error.code : 'not-a-dedalo-error';
		}
		expect(code).toBe('install.invalid_input');
	});
});

/**
 * Runs `snippet` in a child whose private / installer-private / media / backup roots
 * are a scratch tree. Returns the child's last stdout line, parsed.
 */
function runScratchChild(snippet: string, scratch: string): Record<string, unknown> {
	// The child models a FRESH INSTALL, so it runs with the test-media seam OFF:
	// DEDALO_TEST_MEDIA_ROOT outranks MEDIA_PATH (src/config/config.ts), and the
	// suite's own root would replace the scratch one (every path "escaped" → skip).
	const childEnv: Record<string, string | undefined> = { ...process.env };
	childEnv.DEDALO_TEST_MEDIA_ROOT = undefined;
	childEnv.ACTIVE_ONTOLOGY_TLDS = undefined;
	const child = Bun.spawnSync(['bun', '-e', snippet], {
		cwd: ROOT,
		env: {
			...childEnv,
			ZZI_SCRATCH_ROOT: scratch,
			DEDALO_INSTALL_PRIVATE_DIR: join(scratch, 'private'),
			MEDIA_PATH: join(scratch, 'media'),
			DEDALO_BACKUP_DIR: join(scratch, 'backups'),
		} as Record<string, string>,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const lastLine = (child.stdout.toString().trim().split('\n').pop() ?? '').trim();
	if (child.exitCode !== 0 || lastLine === '') {
		throw new Error(`scratch child failed (${child.exitCode}): ${child.stderr.toString()}`);
	}
	return JSON.parse(lastLine) as Record<string, unknown>;
}

describe('install_ontologies', () => {
	test('with nothing staged REFUSES install.state_conflict (a child on a scratch root)', () => {
		const scratch = scratchDir('zzi_ontology_steps');
		const outcome = runScratchChild(
			[
				"const { STEP_RUNS } = await import('./src/core/install/step_runs.ts');",
				'let refusal = null;',
				'try { await STEP_RUNS.install_ontologies({ posted: {}, createDirectories: false, actorUserId: -1 }); }',
				'catch (error) { refusal = { code: error.code, message: error.message }; }',
				'console.log(JSON.stringify({ refusal }));',
			].join('\n'),
			scratch,
		);
		expect(outcome.refusal).toEqual({
			code: 'install.state_conflict',
			message: 'No staged ontology files — run stage_ontologies first',
		});
	});
});

// Inside a fresh private dir, and itself ABSENT: the case asserts nothing is created.
const SCRATCH_ROOT = absentScratchPath('zzi_install');

const CHECK_DIRS_SNIPPET = [
	"const scratch = process.env.ZZI_SCRATCH_ROOT ?? '';",
	"const { installPrivateDir } = await import('./src/core/install/paths.ts');",
	"const { config } = await import('./src/config/config.ts');",
	'const roots = [installPrivateDir(), config.ops.backupDir, config.media.rootPath];',
	'const escaped = roots.filter((p) => typeof p !== "string" || !p.startsWith(scratch));',
	'if (escaped.length > 0) {',
	'  console.log(JSON.stringify({ skip: escaped }));',
	'} else {',
	"  const { INSTALL_STEPS } = await import('./src/core/install/steps.ts');",
	'  const table = await INSTALL_STEPS.check_directories.run({ posted: {}, createDirectories: false, actorUserId: -1 });',
	"  const { existsSync } = await import('node:fs');",
	'  const created = table.dirs.filter((d) => existsSync(d.path)).map((d) => d.path);',
	'  console.log(JSON.stringify({ table, created }));',
	'}',
].join('\n');

const childResult = runScratchChild(CHECK_DIRS_SNIPPET, SCRATCH_ROOT);
const scratchConfirmed = childResult.skip === undefined;

describe('check_directories', () => {
	test.if(scratchConfirmed)('reports one row per managed directory; nothing exists yet', () => {
		const table = childResult.table as { ok: boolean; dirs: unknown[]; msg: string };
		expect(Array.isArray(table.dirs)).toBe(true);
		expect(table.dirs.length).toBeGreaterThan(0);
		expect(table.ok).toBe(false);
		expect(table.msg).toBe('One or more directories need attention');
	});

	test.if(scratchConfirmed)('without the create pass, creates nothing', () => {
		const table = childResult.table as { dirs: { exists: boolean }[] };
		expect(childResult.created).toEqual([]);
		expect(table.dirs.every((d) => d.exists === false)).toBe(true);
		expect(existsSync(SCRATCH_ROOT)).toBe(false);
	});

	test.if(!scratchConfirmed)('SKIPPED: install dirs did not resolve under the scratch root', () => {
		console.warn(
			`check_directories cases skipped — these escaped ${SCRATCH_ROOT}: ${JSON.stringify(childResult.skip)}`,
		);
		expect(childResult.skip).toBeDefined();
	});
});
