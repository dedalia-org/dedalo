/**
 * RUNTIME-PATH CENSUS TRIPWIRE (DEC-12; 2026-08-23).
 *
 * THE INVARIANT: every filesystem path the engine writes at runtime is
 * declared in `src/core/install/runtime_paths.ts RUNTIME_PATH_CENSUS`, so the
 * code updater (`code_update.ts renameSwap()` — it renames the WHOLE
 * projectRoot to a backup and swaps a new tree in) can refuse a swap that
 * would silently carry runtime data away with the old tree. The measured
 * offenders this closes: the in-tree default media root (the entire media
 * library, `.publication` markers included), the hard-coded ontology recovery
 * dump, the ontology IO dir, the transform-definitions dir, and the
 * `ts_state.json` cwd fallback.
 *
 * THREE LEGS:
 *   1. STATIC — no src/ file constructs a path from `projectRoot` or
 *      `process.cwd()` unless it is exempted (with a reason) in the census
 *      module itself; the census and its exemptions travel together.
 *   2. RUNTIME — every census entry resolves without throwing, ids are
 *      unique, and every non-null envKey is a real config-catalog key (or a
 *      declared bootstrap key the catalog is loaded through).
 *   3. POSITIVE CONTROL — `runtimePathsInsideTree()` against a scratch root
 *      with a planted `media/` actually reports it: a gate that cannot fail
 *      is worse than none.
 *
 * HONEST LIMITS: the static leg binds the SPELLINGS `join(projectRoot`,
 * `resolve(projectRoot`, `${projectRoot}` and `process.cwd()` — a path built
 * through an intermediate variable, or an operator key set to an in-tree path
 * by hand, is invisible to it (the census RESOLUTION covers the second: the
 * updater consults the effective value, not the default). And it proves the
 * census is CONSULTABLE and total over those spellings, not that the updater
 * consults it — that wiring is code_update's own gate.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { Glob } from 'bun';
import { CONFIG_CATALOG } from '../../src/config/catalog/index.ts';
import { privateDir } from '../../src/config/env.ts';
import {
	RUNTIME_PATH_BOOTSTRAP_KEYS,
	RUNTIME_PATH_CENSUS,
	RUNTIME_PATH_SCAN_EXEMPTIONS,
	runtimePathsInsideTree,
} from '../../src/core/install/runtime_paths.ts';
import { registryPath } from '../../src/core/publication_host/registry.ts';
import { secretsRoot } from '../../src/core/publication_host/secrets.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';
import { stripComments } from '../helpers/strip_comments.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');

/** All non-test TS source files under src/, repo-relative paths. */
function sourceFiles(): string[] {
	const files: string[] = [];
	const glob = new Glob('**/*.ts');
	for (const match of glob.scanSync({ cwd: join(REPO_ROOT, 'src') })) {
		if (match.endsWith('.test.ts')) continue;
		files.push(relative(REPO_ROOT, join(REPO_ROOT, 'src', match)));
	}
	return files.sort();
}

/** The spellings that anchor a path INSIDE the code tree (or the cwd, which under systemd IS the tree). */
const TREE_ANCHOR_PATTERNS: readonly RegExp[] = [
	/\bjoin\(projectRoot\b/,
	/\bresolve\(projectRoot\b/,
	/\$\{projectRoot\}/,
	/\bprocess\.cwd\(\)/,
];

describe('runtime_paths_census_tripwire', () => {
	// -----------------------------------------------------------------------
	// Leg 1 — STATIC: tree-anchored path construction is censused or exempted.
	// -----------------------------------------------------------------------
	test('every projectRoot/process.cwd() path construction in src/ is exempted with a reason', async () => {
		const offenders: string[] = [];
		for (const file of sourceFiles()) {
			const source = stripComments(await Bun.file(join(REPO_ROOT, file)).text());
			const hits = TREE_ANCHOR_PATTERNS.filter((pattern) => pattern.test(source));
			if (hits.length === 0) continue;
			if (RUNTIME_PATH_SCAN_EXEMPTIONS[file] !== undefined) continue;
			offenders.push(`${file} (${hits.map(String).join(', ')})`);
		}
		expect(
			offenders,
			'files constructing tree-anchored paths without a census exemption — a path the engine ' +
				'writes at runtime must default OUTSIDE projectRoot (a code update renames the whole ' +
				'tree away); register the path in RUNTIME_PATH_CENSUS and, if the construction is ' +
				'code/asset serving, add the file to RUNTIME_PATH_SCAN_EXEMPTIONS with a reason ' +
				'(src/core/install/runtime_paths.ts)',
		).toEqual([]);
	});

	test('every exemption is live (names an existing file that still matches) and carries a substantive reason', async () => {
		for (const [file, reason] of Object.entries(RUNTIME_PATH_SCAN_EXEMPTIONS)) {
			expect(reason.length, `exemption reason for ${file} must be substantive`).toBeGreaterThan(20);
			const bunFile = Bun.file(join(REPO_ROOT, file));
			expect(await bunFile.exists(), `stale exemption: ${file} does not exist`).toBe(true);
			const source = stripComments(await bunFile.text());
			expect(
				TREE_ANCHOR_PATTERNS.some((pattern) => pattern.test(source)),
				`stale exemption: ${file} no longer constructs a tree-anchored path — remove its entry`,
			).toBe(true);
		}
	});

	// -----------------------------------------------------------------------
	// Leg 2 — RUNTIME: the census is well-formed and resolvable.
	// -----------------------------------------------------------------------
	test('census ids are unique and every entry carries a consumer', () => {
		const ids = RUNTIME_PATH_CENSUS.map((entry) => entry.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const entry of RUNTIME_PATH_CENSUS) {
			expect(
				entry.consumer.length,
				`census entry '${entry.id}' must name its consumer`,
			).toBeGreaterThan(5);
		}
	});

	test('every entry resolves without throwing, to an absolute path or null', () => {
		for (const entry of RUNTIME_PATH_CENSUS) {
			const path = entry.resolve(); // a throw here fails the test loudly
			if (path !== null) {
				expect(path.length, `census entry '${entry.id}' resolved to an empty path`).toBeGreaterThan(
					0,
				);
			}
		}
	});

	test('every non-null envKey is a real registered config key (or a declared bootstrap key)', () => {
		for (const entry of RUNTIME_PATH_CENSUS) {
			if (entry.envKey === null) continue;
			const registered =
				CONFIG_CATALOG[entry.envKey] !== undefined ||
				RUNTIME_PATH_BOOTSTRAP_KEYS.includes(entry.envKey);
			expect(
				registered,
				`census entry '${entry.id}' names env key '${entry.envKey}', which is neither in the ` +
					'config catalog nor a declared bootstrap key — an unregistered key cannot be documented, ' +
					'so an operator could never follow the updater refusal that names it',
			).toBe(true);
		}
	});

	test('the publication-host stores are censused through their own resolvers (phase 3)', () => {
		const resolved = new Map(RUNTIME_PATH_CENSUS.map((entry) => [entry.id, entry.resolve()]));
		expect(resolved.get('publication_hosts_registry')).toBe(
			join(privateDir, 'publication_hosts.json'),
		);
		expect(resolved.get('publication_hosts_secrets')).toBe(join(privateDir, 'publication_hosts'));
		expect(resolved.get('publication_hosts_registry')).toBe(registryPath());
		expect(resolved.get('publication_hosts_secrets')).toBe(secretsRoot());
	});

	// -----------------------------------------------------------------------
	// Leg 3 — POSITIVE CONTROL: the containment question can answer YES.
	// -----------------------------------------------------------------------
	test('runtimePathsInsideTree reports a planted in-tree media root (the gate can fail)', () => {
		const scratch = scratchDir('runtime_paths_census');
		const planted = join(scratch, 'media');
		mkdirSync(planted, { recursive: true });
		// DEDALO_TEST_MEDIA_ROOT is the highest-precedence media root and the
		// census reads env LIVE (never the frozen config), so pointing it into
		// the scratch tree is exactly the defect shape: a media root inside the
		// tree that a swap would carry away.
		const previous = process.env.DEDALO_TEST_MEDIA_ROOT;
		try {
			process.env.DEDALO_TEST_MEDIA_ROOT = planted;
			const inside = runtimePathsInsideTree(scratch);
			const media = inside.find((hit) => hit.id === 'media_root');
			expect(
				media,
				'the planted in-tree media root was NOT reported — the census gate cannot fail',
			).toBeDefined();
			expect(media?.envKey).toBe('MEDIA_PATH');
			expect(media?.path).toBe(resolve(planted));
			// And the converse: against a root that holds nothing, it stays out.
			const other = join(scratch, 'elsewhere');
			mkdirSync(other, { recursive: true });
			expect(runtimePathsInsideTree(other).find((hit) => hit.id === 'media_root')).toBeUndefined();
		} finally {
			if (previous === undefined) delete process.env.DEDALO_TEST_MEDIA_ROOT;
			else process.env.DEDALO_TEST_MEDIA_ROOT = previous;
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	// Boundary exactness: a SIBLING whose name shares the root as a prefix is
	// NOT inside (the `root + sep` check, not a bare startsWith).
	test('containment is path-segment exact, not a string prefix', () => {
		const scratch = scratchDir('runtime_paths_prefix');
		const sibling = `${scratch}_sibling`;
		mkdirSync(join(sibling, 'media'), { recursive: true });
		const previous = process.env.DEDALO_TEST_MEDIA_ROOT;
		try {
			process.env.DEDALO_TEST_MEDIA_ROOT = join(sibling, 'media');
			expect(
				runtimePathsInsideTree(scratch).find((hit) => hit.id === 'media_root'),
			).toBeUndefined();
			expect(runtimePathsInsideTree(sibling).find((hit) => hit.id === 'media_root')).toBeDefined();
		} finally {
			if (previous === undefined) delete process.env.DEDALO_TEST_MEDIA_ROOT;
			else process.env.DEDALO_TEST_MEDIA_ROOT = previous;
			rmSync(sibling, { recursive: true, force: true });
		}
	});
});
