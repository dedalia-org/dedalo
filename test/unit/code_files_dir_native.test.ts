/**
 * The release files directory provisioner (src/core/update/code_files_dir.ts).
 *
 * The invariant: a code server whose DEDALO_CODE_FILES_DIR is configured but
 * absent gets it CREATED, recursively, AT THE DECLARED MODE — not at whatever
 * the process umask happens to give, which is what `mkdirSync`'s `mode` option
 * alone yields (0700 under a hardened `UMask=0077`). An existing directory is
 * observed, never re-moded. Nothing here throws.
 *
 * The boot wrapper is gated on config, which a unit test cannot rebuild
 * (`config` is frozen at import), so its WIRING is asserted structurally —
 * the same shape as media_tree_provision_native.test.ts's boot-pass gate,
 * because a provisioner nobody calls is exactly the regression that matters.
 *
 * Scratch root under TMPDIR: no ../private, no live tree, no DB.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { CODE_DIR_MODE, ensureCodeFilesDir } from '../../src/core/update/code_files_dir.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const ROOT = scratchDir('code_files_dir');
/** Root ignores permission bits, so a "cannot create" case cannot mean anything. */
const asRoot = process.getuid?.() === 0;

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const modeOf = (path: string): number => statSync(path).mode & 0o777;

/**
 * Run with a pinned umask: the gate must assert the FORCED mode, not the
 * ambient one. SYNCHRONOUS BODIES ONLY — the umask is process-global, so an
 * `await` inside would leak the mask to whatever else runs in this process.
 */
function withUmask<T>(mask: number, body: () => T): T {
	const previous = process.umask(mask);
	try {
		return body();
	} finally {
		process.umask(previous);
	}
}

describe('ensureCodeFilesDir', () => {
	test('creates a missing directory, recursively, at CODE_DIR_MODE', () => {
		const dir = join(ROOT, 'missing', 'srv', 'dedalo', 'code');
		const report = ensureCodeFilesDir(dir);
		expect(report.created).toBe(true);
		expect(report.error).toBeNull();
		expect(report.writable).toBe(true);
		expect(report.isDirectory).toBe(true);
		expect(existsSync(dir)).toBe(true);
		expect(modeOf(dir)).toBe(CODE_DIR_MODE);
		// Every level it minted, not just the leaf.
		expect(modeOf(join(ROOT, 'missing', 'srv'))).toBe(CODE_DIR_MODE);
		// The REPORTED mode is the observed one (the log line quotes it).
		expect(report.mode).toBe(CODE_DIR_MODE);
	});

	test('the mode survives a hardened umask (the whole point of the module)', () => {
		// Without the post-mkdir chmod this lands at 0700 and the log line lies.
		const dir = withUmask(0o077, () => {
			const target = join(ROOT, 'hardened', 'code');
			expect(ensureCodeFilesDir(target).mode).toBe(CODE_DIR_MODE);
			return target;
		});
		expect(modeOf(dir)).toBe(CODE_DIR_MODE);
		expect(modeOf(join(ROOT, 'hardened'))).toBe(CODE_DIR_MODE);
	});

	test('never touches a level that already existed', () => {
		const parent = join(ROOT, 'preexisting');
		mkdirSync(parent, { recursive: true });
		chmodSync(parent, 0o775);
		ensureCodeFilesDir(join(parent, 'code'));
		expect(modeOf(parent)).toBe(0o775);
		expect(modeOf(join(parent, 'code'))).toBe(CODE_DIR_MODE);
	});

	test('is idempotent and never re-modes an existing directory', () => {
		const dir = join(ROOT, 'existing');
		mkdirSync(dir, { recursive: true });
		chmodSync(dir, 0o775); // an operator's deliberate wider mode
		const report = ensureCodeFilesDir(dir);
		expect(report.created).toBe(false);
		expect(report.writable).toBe(true);
		expect(report.isDirectory).toBe(true);
		expect(modeOf(dir)).toBe(0o775);
	});

	test('a regular FILE at the path is reported as not-a-directory, not as unwritable', () => {
		const path = join(ROOT, 'a_file');
		mkdirSync(ROOT, { recursive: true });
		writeFileSync(path, 'not a directory');
		const report = ensureCodeFilesDir(path);
		expect(report.isDirectory).toBe(false);
		expect(report.writable).toBe(false);
		expect(report.error).toBeNull();
	});

	test('a path with .. is normalised, so every minted level really is forced', () => {
		// `relative()` normalises `..` away, so without the resolve() at the top
		// of ensureCodeFilesDir mkdir would mint a level (`x`) that the mode
		// walk then never visits — left at the umask's mode while the report
		// claimed every minted level was forced.
		withUmask(0o077, () => {
			const dir = join(ROOT, 'dots', 'x', '..', 'y', 'z');
			const report = ensureCodeFilesDir(dir);
			expect(report.created).toBe(true);
			expect(report.modeForced).toBe(true);
			// `path` is the normalised path, and because mkdir is given that same
			// normalised path, the `..` level is never minted at all — the
			// created set and the forced set are one set by construction.
			expect(report.path).toBe(join(ROOT, 'dots', 'y', 'z'));
			expect(existsSync(join(ROOT, 'dots', 'x'))).toBe(false);
			for (const level of [
				join(ROOT, 'dots'),
				join(ROOT, 'dots', 'y'),
				join(ROOT, 'dots', 'y', 'z'),
			]) {
				expect(modeOf(level), level).toBe(CODE_DIR_MODE);
			}
		});
	});

	test('a vanished path is reported, never thrown (the never-throws contract)', () => {
		// existsSync + statSync is a race. The guarded stat is what keeps an
		// ENOENT from escaping into startServer (S1-15) and into code_build.ts,
		// which calls this outside any try. Simulated by racing the same window
		// a removal opens: a dangling symlink is the reachable shape of it.
		const link = join(ROOT, 'dangling');
		const target = join(ROOT, 'gone');
		mkdirSync(target, { recursive: true });
		symlinkSync(target, link);
		rmSync(target, { recursive: true, force: true });
		// existsSync follows the link and answers false, so this takes the
		// CREATE branch and mkdirSync throws EEXIST — reported, not thrown.
		const report = ensureCodeFilesDir(link);
		expect(report.created).toBe(false);
		expect(report.error).toBeInstanceOf(Error);
		expect(report.isDirectory).toBe(false);
	});

	test('a chmod refusal is a REPORT field, never a creation failure', () => {
		// The regression this split exists for: a filesystem without POSIX modes
		// (CIFS/SMB, exFAT — an ordinary home for release archives on a mirror
		// box) answers EPERM to every chmod. Such a mount cannot be conjured in
		// a unit test, so the invariant is asserted where it bites: a successful
		// create reports `error:null` + `isDirectory:true` and carries the mode
		// outcome SEPARATELY, on `modeForced` — the two fields code_build.ts
		// keys its refusal on stay clean either way.
		const report = ensureCodeFilesDir(join(ROOT, 'forced'));
		expect(report.error).toBeNull();
		expect(report.isDirectory).toBe(true);
		expect(report.created).toBe(true);
		expect(report.modeForced).toBe(true);
	});

	test.skipIf(asRoot)('reports the failure instead of throwing when it cannot create', () => {
		const parent = join(ROOT, 'sealed');
		mkdirSync(parent, { recursive: true });
		chmodSync(parent, 0o500); // read+execute only: no mkdir inside
		const report = ensureCodeFilesDir(join(parent, 'code'));
		expect(report.created).toBe(false);
		expect(report.writable).toBe(false);
		expect(report.error).toBeInstanceOf(Error);
		chmodSync(parent, 0o700); // so afterAll can sweep it
	});
});

describe('the boot wiring', () => {
	test('src/server.ts calls ensureCodeFilesDirAtBoot() at boot, statically imported', () => {
		// Structural, because startServer binds a socket: a provisioner with no
		// boot caller never reaches an installed box (DEC-12 — the invariant is
		// the CALL, so the call is what is gated).
		const src = readFileSync(join(REPO_ROOT, 'src', 'server.ts'), 'utf8');
		const startServer = src.indexOf('export async function startServer');
		const bootCall = src.indexOf('ensureCodeFilesDirAtBoot()');
		expect(startServer).toBeGreaterThan(-1);
		expect(bootCall, 'src/server.ts must call ensureCodeFilesDirAtBoot() at boot').toBeGreaterThan(
			startServer,
		);
		expect(src).toContain(
			"import { ensureCodeFilesDirAtBoot } from './core/update/code_files_dir.ts'",
		);
	});

	test('the wrapper is gated on IS_A_CODE_SERVER and on a non-empty key', () => {
		// The gate is read from the frozen `config`, which a unit test cannot
		// rebuild — so the three refusals are asserted on the source, next to the
		// structural call gate above.
		const src = readFileSync(join(REPO_ROOT, 'src', 'core', 'update', 'code_files_dir.ts'), 'utf8');
		expect(src).toContain('if (config.update.isCodeServer !== true) return null;');
		expect(src).toContain("if (configured === undefined || configured === '') return null;");
	});

	test('code_build refuses on creation/not-a-directory ONLY, never on the mode', () => {
		// A build must not be refused because a chmod was refused: keying the
		// refusal on anything mode-shaped would hard-fail a release on a mount
		// that cannot carry POSIX modes.
		const src = readFileSync(join(REPO_ROOT, 'src', 'core', 'update', 'code_build.ts'), 'utf8');
		expect(src).toContain('dirReport.error !== null || !dirReport.isDirectory');
		expect(src).not.toContain('dirReport.modeForced');
	});
});
