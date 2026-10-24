/**
 * PREDICTABLE-TMP TRIPWIRE — no gate, script or probe builds a NAMED path under
 * the shared OS temp directory. Scratch space comes from `mkdtemp`, through
 * test/helpers/scratch_dir.ts.
 *
 * ── WHAT IT GUARDS ───────────────────────────────────────────────────────────
 * The old idiom — `${tmpdir()}/dedalo_<name>_${process.pid}`, then mkdir and
 * writes beneath it — is a predictable path in a shared, sticky directory. On a
 * multi-user Linux box (the self-hosted CI tier, a shared staging host) another
 * local user who pre-creates that name, or plants a symlink there, redirects the
 * gate's writes or feeds it bytes: pids and `Date.now()` are guessable, and
 * `Math.random()` is neither unguessable nor atomic. CodeQL reported it 193 times
 * (js/insecure-temporary-file) plus the production writers those tests fed
 * (G10, 21 alerts). `mkdtempSync` closes it structurally: atomic create, random
 * suffix, mode 0700.
 *
 * ── THE MEASURE (ONE IMPLEMENTATION) ─────────────────────────────────────────
 * scripts/lib/predictable_tmp_census.ts — an AST census, not a grep. It finds
 * the PATH EXPRESSIONS that build a name under a temp root (`tmpdir()` under any
 * import name, `os.tmpdir()`, `process.env.TMPDIR`, `'/tmp'`, through
 * `realpathSync`/`??`/`const` aliases), and allows exactly one construction: the
 * template handed straight to `mkdtemp`/`mkdtempSync`. This gate computes
 * nothing of its own.
 *
 * ── THE RULE: SHRINK-ONLY, LIVE EXEMPTIONS ───────────────────────────────────
 * EXEMPTIONS below are the files that MUST keep a fixed temp name, each with its
 * count and the reason. The census must equal them EXACTLY: a new finding is
 * red (route it through scratch_dir.ts), and a count that fell is red too (lower
 * it in the same commit — a stale entry is how a ratchet stops ratcheting).
 *
 * ── THE OUTCOME HALF ─────────────────────────────────────────────────────────
 * A source scan says what the code SPELLS; the helper's own behaviour is RUN
 * here: two scratch dirs are distinct, private (0700) and under the temp dir; an
 * absent path really is absent; the cleanup refuses anything that is not one of
 * its own dirs.
 *
 * ── HONEST LIMITS ────────────────────────────────────────────────────────────
 * Static: a temp root reaching a join through a function parameter or a `let`
 * is invisible; a `'/tmp/x'` literal with no interpolation is not counted (the
 * tree uses those as fake paths in assertions). The suite media root
 * (`../private/test_media/<suite db>`) is not a temp path and is not this gate's
 * business — test_media_root_tripwire owns it.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
	PREDICTABLE_TMP_SCAN_GLOBS,
	predictableTmpCensus,
	predictableTmpFindings,
	SCRATCH_HELPER,
} from '../../scripts/lib/predictable_tmp_census.ts';
import {
	absentScratchPath,
	removeScratchDir,
	SCRATCH_PREFIX,
	scratchDir,
	scratchFile,
} from '../helpers/scratch_dir.ts';

/** Repo root — derived locally: this gate imports no config and needs no database (hermetic tier). */
const REPO_ROOT = resolve(import.meta.dir, '..', '..');

interface Exemption {
	readonly count: number;
	readonly reason: string;
}

/** Files that must keep a FIXED temp name. Shrink-only; every count exact. */
const EXEMPTIONS: Readonly<Record<string, Exemption>> = {
	'scripts/client_test_server.ts': {
		count: 1,
		reason:
			'cross-process RENDEZVOUS: the client runner and the suite server it spawns derive the same pid-keyed socket/session paths independently, so the parent dir must be derivable; it is VERIFIED instead (real dir, owned by this uid, 0700) and refused otherwise',
	},
	'scripts/install_main.ts': {
		count: 1,
		reason:
			'sweep of ORPHANS: joins the temp dir with names read back from readdirSync(tmpdir()) (prefix dedalo_ontology_source_, older than a day) to remove them — it creates nothing and chooses no name',
	},
	'test/helpers/suite_mariadb_env.ts': {
		count: 1,
		reason:
			"the suite MariaDB is DETACHED and outlives `bun test`: every process (preload, CI tier, stop/sweep CLI) must derive the same socket dir from the lane root (sha-keyed), under /tmp because of the 104-byte socket cap; created 0700 + chmod, which fails on a squatter's dir",
	},
	'test/unit/publication_host_copy_drill_kit.test.ts': {
		count: 1,
		reason:
			'SYNTHETIC string only: a fake marker path added to the in-memory `exists` set of engineChildRefusal — no filesystem call ever sees it',
	},
	'test/unit/publication_host_transport_native.test.ts': {
		count: 2,
		reason:
			'the gate IS the sticky-/tmp squatting rule: it must place a socket directly in /tmp, and a squatted dir under it, to prove the transport refuses both',
	},
	'test/unit/seed_contract_private_tmp.test.ts': {
		count: 1,
		reason:
			'plays the ATTACKER: plants a file at the pre-fix predictable seed-contract name to prove the engine no longer uses it',
	},
	'test/unit/seed_restore_temp_confinement_native.test.ts': {
		count: 1,
		reason:
			'plays the ATTACKER: computes the pre-fix predictable seed-restore name (frozen clock) and plants a trap there to prove restoreSeed never writes, truncates or removes it',
	},
};

describe('predictable tmp — the census matches the exemptions exactly', () => {
	const census = predictableTmpCensus(REPO_ROOT);
	const byFile = new Map<string, string[]>();
	for (const finding of census.findings) {
		const list = byFile.get(finding.file) ?? [];
		list.push(`${finding.file}:${finding.line}  ${finding.snippet}`);
		byFile.set(finding.file, list);
	}

	test('anti-vacuity: the census walks the measured trees', () => {
		expect(PREDICTABLE_TMP_SCAN_GLOBS).toContain('test/**/*.{ts,js,mjs}');
		expect(PREDICTABLE_TMP_SCAN_GLOBS).toContain('scripts/**/*.{ts,js,mjs}');
		expect(census.scanned).toBeGreaterThan(1500);
	});

	test('no file outside EXEMPTIONS builds a named temp path', () => {
		const offenders = [...byFile.entries()]
			.filter(([file]) => EXEMPTIONS[file] === undefined)
			.flatMap(([, lines]) => lines);
		expect(
			offenders,
			`Predictable temp path(s): use scratchDir()/scratchFile()/absentScratchPath() from ${SCRATCH_HELPER} (mkdtemp, 0700) instead`,
		).toEqual([]);
	});

	test('every exemption is LIVE and exact (shrink-only: lower the count in the same commit)', () => {
		for (const [file, exemption] of Object.entries(EXEMPTIONS)) {
			const found = byFile.get(file)?.length ?? 0;
			expect(found, `${file}: exemption count ${exemption.count}, census ${found}`).toBe(
				exemption.count,
			);
			expect(exemption.reason.length, `${file}: the reason must say WHY`).toBeGreaterThan(60);
		}
	});
});

describe('predictable tmp — the matcher, both directions (positive controls)', () => {
	const count = (source: string, file = 'test/unit/x.test.ts'): number =>
		predictableTmpFindings(file, source).length;
	const OS = "import { tmpdir } from 'node:os';\nimport { join } from 'node:path';\n";

	test('the old idioms are convicted', () => {
		expect(count(`${OS}const R = \`\${tmpdir()}/dedalo_x_\${process.pid}\`;`)).toBe(1);
		expect(count(`${OS}const R = join(tmpdir(), 'dedalo_fixed');`)).toBe(1);
		expect(count(`${OS}const R = join(\n\ttmpdir(),\n\t\`x_\${Math.random()}\`,\n);`)).toBe(1);
		expect(
			count(
				`${OS}import { realpathSync } from 'node:fs';\nconst R = join(realpathSync(tmpdir()), 'x');`,
			),
		).toBe(1);
		expect(
			count(
				"import { join } from 'node:path';\nconst R = join(process.env.TMPDIR ?? '/tmp', 'x');",
			),
		).toBe(1);
		expect(count("const R = join(readEnv('TMPDIR') ?? '/tmp', `x_${PID}.log`);")).toBe(1);
		expect(count('const R = `/tmp/dd_x_${process.pid}.sock`;')).toBe(1);
		expect(
			count(
				'const R = tmpdir() + "/x";'
					.replace('tmpdir', 'os.tmpdir')
					.replace(/^/, "import * as os from 'node:os';\n"),
			),
		).toBe(1);
	});

	test('the root is recognised by MEANING, not by spelling', () => {
		// a renamed import and a const alias of the root are still the root
		expect(
			count(
				"import { tmpdir as osTmp } from 'node:os';\nconst base = osTmp();\nconst R = `${base}/x`;",
			),
		).toBe(1);
		expect(count("import os from 'node:os';\nconst R = path.join(os.tmpdir(), 'x');")).toBe(1);
		// a comment that SPELLS the idiom builds nothing
		expect(
			count(`${OS}// const R = \`\${tmpdir()}/dedalo_x_\${process.pid}\`;\nconst y = 1;`),
		).toBe(0);
	});

	test('the safe and the inert shapes are acquitted', () => {
		expect(count(`${OS}const R = mkdtempSync(join(tmpdir(), 'dedalo_x_'));`)).toBe(0);
		expect(count(`${OS}const R = await mkdtemp(\`\${tmpdir()}/x-\`);`)).toBe(0);
		expect(count(`${OS}spawn(['x'], { cwd: tmpdir(), env: { TMPDIR: tmpdir() } });`)).toBe(0);
		expect(count(`${OS}expect(p.startsWith(resolve(tmpdir()) + sep)).toBe(true);`)).toBe(0);
		// documented limit: an uninterpolated literal is a fake path, not counted
		expect(count("expect(f('/tmp/x')).toBe(false);")).toBe(0);
		// the helper itself is the one place mkdtemp is wrapped
		expect(count(readFileSync(join(REPO_ROOT, SCRATCH_HELPER), 'utf8'), SCRATCH_HELPER)).toBe(0);
	});
});

describe('predictable tmp — the helper, RUN (the outcome)', () => {
	test('two scratch dirs are distinct, private (0700) and directly under the temp dir', () => {
		const a = scratchDir('tripwire_probe');
		const b = scratchDir('tripwire_probe');
		try {
			expect(a).not.toBe(b);
			for (const dir of [a, b]) {
				expect(dirname(dir)).toBe(resolve(tmpdir()));
				expect(basename(dir).startsWith(`${SCRATCH_PREFIX}tripwire_probe_`)).toBe(true);
				expect(statSync(dir).mode & 0o777).toBe(0o700);
			}
		} finally {
			removeScratchDir(a);
			removeScratchDir(b);
		}
		expect(existsSync(a)).toBe(false);
	});

	test('scratchFile names a file inside its own private dir; absentScratchPath is absent', () => {
		const file = scratchFile('tripwire_probe', 'x.log');
		try {
			expect(basename(file)).toBe('x.log');
			expect(existsSync(file)).toBe(false);
			expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
		} finally {
			removeScratchDir(dirname(file));
		}
		const absent = absentScratchPath('tripwire_probe', 'deeper');
		expect(existsSync(dirname(absent))).toBe(false);
	});

	test('cleanup refuses anything that is not one of its own dirs, and deletes nothing', () => {
		expect(() => removeScratchDir(REPO_ROOT)).toThrow(/REFUSED/);
		expect(() => removeScratchDir(tmpdir())).toThrow(/REFUSED/);
		// the right prefix under the WRONG parent is refused too
		expect(() => removeScratchDir(join(REPO_ROOT, `${SCRATCH_PREFIX}x`))).toThrow(/REFUSED/);
		expect(existsSync(REPO_ROOT)).toBe(true);
	});
});
