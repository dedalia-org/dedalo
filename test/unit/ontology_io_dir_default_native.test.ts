/**
 * ONTOLOGY_DATA_IO_DIR DEFAULT (2026-10-21) — the IO dir leaves the code tree.
 *
 * THE INVARIANT: the in-tree `install/import/ontology/` SHIPS the vendored
 * release, and release content is not operator data. A legacy dir holding only
 * what a release ships resolves to `<private>/import/ontology`; anything the
 * release does not ship (a `recovery/` snapshot, a stale `.staging`, a foreign
 * file) or an ontology server keeps the legacy dir (nothing moves on a guess).
 * Before this, the generic "holds any entry" probe kept EVERY install in-tree:
 * an image install died EACCES on `.staging`, and the runtime-path census
 * refused every tree-swap code update.
 *
 * Also gated: the decision is sticky, the private home ends the fallback, and
 * the updater's refusal carries the ontology-specific remedy (moving the
 * SHIPPED files would be wrong advice).
 *
 * MECHANICS as media_root_legacy_sticky_native: `projectRoot`/`privateDir` are
 * import-frozen, so scratch dirs are addressed through `relative()` traversal;
 * the sticky store is repointed via DEDALO_TS_STATE_PATH.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
	isOntologyIoFileName,
	probeOntologyLegacyDir,
} from '../../src/config/catalog/maintenance.ts';
import { legacyAwareDefaultDir } from '../../src/config/catalog/media.ts';
import { privateDir, projectRoot } from '../../src/config/env.ts';
import { runtimePathsInsideTree } from '../../src/core/install/runtime_paths.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const KEY = 'ONTOLOGY_DATA_IO_DIR';

let scratch: string;
let legacyDir: string;
let modernDir: string;
let statePath: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['DEDALO_TS_STATE_PATH', 'IS_AN_ONTOLOGY_SERVER', 'ONTOLOGY_DATA_IO_DIR'];

/** A legacy dir holding exactly what a release ships. */
function plantRelease(): void {
	const version = join(legacyDir, '7.0');
	mkdirSync(version, { recursive: true });
	for (const name of [
		'dd.copy.gz',
		'oh.copy.gz',
		'matrix_dd.copy.gz',
		'ontology.json',
		'ontology_llm_map.json',
	]) {
		writeFileSync(join(version, name), 'x');
	}
}

function callDefault(record = false): string {
	return legacyAwareDefaultDir(
		KEY,
		[relative(projectRoot, legacyDir)],
		[relative(privateDir, modernDir)],
		{ preferPrivateWhenExists: true, probe: probeOntologyLegacyDir, record },
	);
}

function stickyRecorded(): unknown {
	if (!existsSync(statePath)) return undefined;
	return (
		JSON.parse(readFileSync(statePath, 'utf8')) as { legacy_dir_fallback?: Record<string, string> }
	).legacy_dir_fallback?.[KEY];
}

beforeEach(() => {
	scratch = scratchDir('ontology_io_default');
	legacyDir = join(scratch, 'tree', 'install', 'import', 'ontology');
	modernDir = join(scratch, 'private', 'import', 'ontology');
	statePath = join(scratch, 'ts_state.json');
	mkdirSync(scratch, { recursive: true });
	for (const key of ENV_KEYS) saved[key] = process.env[key];
	process.env.DEDALO_TS_STATE_PATH = statePath;
	process.env.IS_AN_ONTOLOGY_SERVER = 'false';
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
	rmSync(scratch, { recursive: true, force: true });
});

describe('the probe: release content is not operator data', () => {
	test('a missing legacy dir is empty', () => {
		expect(probeOntologyLegacyDir(legacyDir)).toBe('empty');
	});

	test('exactly the shipped release reads empty (Finder litter ignored)', () => {
		plantRelease();
		writeFileSync(join(legacyDir, '7.0', '.DS_Store'), 'x');
		expect(probeOntologyLegacyDir(legacyDir)).toBe('empty');
	});

	test('a recovery/ snapshot is content', () => {
		plantRelease();
		mkdirSync(join(legacyDir, '7.0', 'recovery', '1760000000000'), { recursive: true });
		expect(probeOntologyLegacyDir(legacyDir)).toBe('content');
	});

	test('a stale .staging is content', () => {
		plantRelease();
		mkdirSync(join(legacyDir, '7.0', '.staging'));
		expect(probeOntologyLegacyDir(legacyDir)).toBe('content');
	});

	test('a foreign file in the version dir is content', () => {
		plantRelease();
		writeFileSync(join(legacyDir, '7.0', 'notes.txt'), 'x');
		expect(probeOntologyLegacyDir(legacyDir)).toBe('content');
	});

	test('an entry beside the version dirs is content', () => {
		plantRelease();
		writeFileSync(join(legacyDir, 'mine.copy.gz'), 'x');
		expect(probeOntologyLegacyDir(legacyDir)).toBe('content');
	});

	test('an ontology server is content, whatever the dir holds', () => {
		plantRelease();
		process.env.IS_AN_ONTOLOGY_SERVER = 'true';
		expect(probeOntologyLegacyDir(legacyDir)).toBe('content');
	});

	test('the file grammar is the served one', () => {
		expect(isOntologyIoFileName('matrix_dd.copy.gz')).toBe(true);
		expect(isOntologyIoFileName('ontology.json')).toBe(true);
		expect(isOntologyIoFileName('../dd.copy.gz')).toBe(false);
		expect(isOntologyIoFileName('dd.copy')).toBe(false);
	});
});

describe('the default', () => {
	test('a stock install (release only) resolves to the private dir, recorded modern', () => {
		plantRelease();
		expect(callDefault(true)).toBe(join(privateDir, relative(privateDir, modernDir)));
		expect(stickyRecorded()).toBe('modern');
	});

	test('operator content keeps the legacy dir, recorded legacy', () => {
		plantRelease();
		mkdirSync(join(legacyDir, '7.0', 'recovery', '1'), { recursive: true });
		expect(callDefault(true)).toBe(join(projectRoot, relative(projectRoot, legacyDir)));
		expect(stickyRecorded()).toBe('legacy');
	});

	test('sticky: a recorded legacy decision survives the residue being removed', () => {
		plantRelease();
		mkdirSync(join(legacyDir, '7.0', 'recovery', '1'), { recursive: true });
		callDefault(true);
		rmSync(join(legacyDir, '7.0', 'recovery'), { recursive: true });
		expect(callDefault()).toBe(join(projectRoot, relative(projectRoot, legacyDir)));
	});

	test('creating the private home ends a recorded legacy fallback', () => {
		plantRelease();
		mkdirSync(join(legacyDir, '7.0', 'recovery', '1'), { recursive: true });
		callDefault(true);
		mkdirSync(modernDir, { recursive: true });
		expect(callDefault()).toBe(join(privateDir, relative(privateDir, modernDir)));
	});
});

describe('the updater refusal', () => {
	test('an in-tree IO dir is refused with the ontology remedy, never "move it"', () => {
		const tree = join(scratch, 'tree');
		process.env.ONTOLOGY_DATA_IO_DIR = legacyDir;
		const hit = runtimePathsInsideTree(tree).find((entry) => entry.id === 'ontology_data_io_dir');
		expect(hit?.remedy).toContain('<private dir>/import/ontology');
		expect(hit?.remedy).toContain('not ontology release files');
	});

	test('an ONTOLOGY SERVER is told to copy every version dir, never to create the home empty', () => {
		// Its exports carry the shipped names and it serves them: "move the
		// residue + mkdir" would repoint a live master at an empty dir.
		const tree = join(scratch, 'tree');
		process.env.ONTOLOGY_DATA_IO_DIR = legacyDir;
		process.env.IS_AN_ONTOLOGY_SERVER = 'true';
		const hit = runtimePathsInsideTree(tree).find((entry) => entry.id === 'ontology_data_io_dir');
		expect(hit?.remedy).toContain('copy EVERY <major.minor>/ directory');
		expect(hit?.remedy).toContain('never create it empty');
	});

	test('ONTOLOGY_DATA_IO_DIR= (empty) is unset — never the cwd, i.e. the code tree', () => {
		process.env.ONTOLOGY_DATA_IO_DIR = '';
		const hit = runtimePathsInsideTree(projectRoot).find(
			(entry) => entry.id === 'ontology_data_io_dir',
		);
		expect(hit?.path).not.toBe(projectRoot);
	});
});
