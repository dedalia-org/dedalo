/**
 * LEGACY MEDIA-ROOT STICKINESS (2026-08-23 review, FINDING 1).
 *
 * THE INVARIANT: the legacy-vs-modern default-dir decision
 * (`src/config/catalog/media.ts legacyAwareDefaultDir`) is decided ONCE and
 * recorded durably in ts_state.json (`legacy_dir_fallback`) — never re-derived
 * from directory contents at every config build. Re-derivation made the media
 * root BISTABLE: a legacy dir holding only `.publication` (the media
 * access-control marker tree) read as "empty" under the old non-dotfile
 * filter and silently repointed the root; a fresh install that later gained a
 * stray in-tree `media/` silently repointed the live archive; a transient
 * readdir error did the same.
 *
 * Cases gated here: fresh install, legacy-with-files, `.publication`-only
 * legacy, unreadable legacy dir, stickiness in BOTH directions (a recorded
 * decision survives the dir's contents changing), and the census's
 * DEDALO_TEST_MEDIA_ROOT precedence (the seam must keep outranking the
 * default — it arms the suite's write-guard).
 *
 * MECHANICS: `projectRoot`/`privateDir` are import-frozen constants, so the
 * scratch dirs are addressed THROUGH them with `relative()` traversal
 * segments; the sticky store is repointed per-test via DEDALO_TS_STATE_PATH
 * (read live by the helper).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { legacyAwareDefaultDir } from '../../src/config/catalog/media.ts';
import { privateDir, projectRoot } from '../../src/config/env.ts';
import { RUNTIME_PATH_CENSUS } from '../../src/core/install/runtime_paths.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const KEY = 'MEDIA_PATH'; // real key name; the sticky store is scratch, so nothing leaks

let scratch: string;
let legacyDir: string;
let modernDir: string;
let statePath: string;
let previousStatePath: string | undefined;

/** Traversal segments that make legacyAwareDefaultDir land in our scratch dirs. */
function rels(): { legacyRel: string[]; privateRel: string[] } {
	return {
		legacyRel: [relative(projectRoot, legacyDir)],
		privateRel: [relative(privateDir, modernDir)],
	};
}

function callDefault(options: { record?: boolean } = {}): string {
	const { legacyRel, privateRel } = rels();
	return legacyAwareDefaultDir(KEY, legacyRel, privateRel, options);
}

function stickyRecorded(): unknown {
	if (!existsSync(statePath)) return undefined;
	const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
		legacy_dir_fallback?: Record<string, string>;
	};
	return state.legacy_dir_fallback?.[KEY];
}

beforeEach(() => {
	scratch = scratchDir('media_root_sticky');
	legacyDir = join(scratch, 'legacy_media');
	modernDir = join(scratch, 'private_media');
	statePath = join(scratch, 'ts_state.json');
	mkdirSync(scratch, { recursive: true });
	previousStatePath = process.env.DEDALO_TS_STATE_PATH;
	process.env.DEDALO_TS_STATE_PATH = statePath;
});

afterEach(() => {
	if (previousStatePath === undefined) delete process.env.DEDALO_TS_STATE_PATH;
	else process.env.DEDALO_TS_STATE_PATH = previousStatePath;
	try {
		if (existsSync(legacyDir)) chmodSync(legacyDir, 0o700);
	} catch {
		/* already removable */
	}
	rmSync(scratch, { recursive: true, force: true });
});

describe('legacyAwareDefaultDir stickiness (FINDING 1)', () => {
	test('fresh install (no legacy dir) → modern, and the decision is recorded', () => {
		expect(callDefault({ record: true })).toBe(modernDir);
		expect(stickyRecorded()).toBe('modern');
	});

	test('legacy dir with visible files → legacy, recorded', () => {
		mkdirSync(legacyDir, { recursive: true });
		writeFileSync(join(legacyDir, 'image.jpg'), 'x');
		expect(callDefault({ record: true })).toBe(legacyDir);
		expect(stickyRecorded()).toBe('legacy');
	});

	test('legacy dir holding ONLY .publication (access-control markers) → legacy, never repointed', () => {
		// The exact defect: the marker tree is a dot-entry, and dot-entries ARE content.
		mkdirSync(join(legacyDir, '.publication'), { recursive: true });
		expect(callDefault()).toBe(legacyDir);
	});

	test.if(typeof process.getuid !== 'function' || process.getuid() !== 0)(
		'unreadable legacy dir → assume legacy (a transient error must not repoint a live root)',
		() => {
			mkdirSync(legacyDir, { recursive: true });
			writeFileSync(join(legacyDir, 'image.jpg'), 'x');
			chmodSync(legacyDir, 0o000);
			expect(callDefault({ record: true })).toBe(legacyDir);
			expect(stickyRecorded()).toBe('legacy');
		},
	);

	test('STICKY modern: a stray legacy dir appearing later cannot repoint a recorded fresh install', () => {
		expect(callDefault({ record: true })).toBe(modernDir);
		// The stray rsync / old copy arrives afterwards…
		mkdirSync(legacyDir, { recursive: true });
		writeFileSync(join(legacyDir, 'stray.jpg'), 'x');
		// …and the decision holds, record flag or not.
		expect(callDefault({ record: true })).toBe(modernDir);
		expect(callDefault()).toBe(modernDir);
	});

	test('STICKY legacy: emptying the legacy dir cannot flip a recorded legacy install to modern', () => {
		mkdirSync(legacyDir, { recursive: true });
		writeFileSync(join(legacyDir, 'image.jpg'), 'x');
		expect(callDefault({ record: true })).toBe(legacyDir);
		rmSync(join(legacyDir, 'image.jpg'));
		expect(callDefault()).toBe(legacyDir);
		expect(callDefault({ record: true })).toBe(legacyDir);
		expect(stickyRecorded()).toBe('legacy');
	});

	test('a call WITHOUT record is a pure question: it derives but never writes the state file', () => {
		mkdirSync(legacyDir, { recursive: true });
		writeFileSync(join(legacyDir, 'image.jpg'), 'x');
		expect(callDefault()).toBe(legacyDir);
		expect(existsSync(statePath)).toBe(false);
	});

	test('recording merges: other ts_state.json keys survive the sticky write', () => {
		writeFileSync(statePath, `${JSON.stringify({ maintenance_mode: true })}\n`);
		expect(callDefault({ record: true })).toBe(modernDir);
		const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
		expect(state.maintenance_mode).toBe(true);
		expect(stickyRecorded()).toBe('modern');
	});
});

describe('DEDALO_TEST_MEDIA_ROOT precedence (the write-guard seam must keep outranking)', () => {
	test('the census media_root entry resolves the seam before any legacy-aware default', () => {
		const entry = RUNTIME_PATH_CENSUS.find((candidate) => candidate.id === 'media_root');
		expect(entry).toBeDefined();
		const previous = process.env.DEDALO_TEST_MEDIA_ROOT;
		const seamRoot = join(scratch, 'seam_media');
		try {
			process.env.DEDALO_TEST_MEDIA_ROOT = seamRoot;
			// Even with a recorded sticky decision AND MEDIA_PATH-shaped state on
			// disk, the seam wins.
			expect(resolve(entry?.resolve() ?? '')).toBe(resolve(seamRoot));
		} finally {
			if (previous === undefined) delete process.env.DEDALO_TEST_MEDIA_ROOT;
			else process.env.DEDALO_TEST_MEDIA_ROOT = previous;
		}
	});
});
