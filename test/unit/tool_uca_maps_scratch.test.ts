/**
 * tool_uca_maps — where GDAL's and ImageMagick's scratch lives: a private dir per
 * call under the marked media root's staging tree, never the OS temp dir, and
 * the boot sweep that collects what a killed process left behind.
 */

import { describe, expect, spyOn, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { config } from '../../src/config/config.ts';
import {
	SCRATCH_ORPHAN_TTL_MS,
	scratchRoot,
	startScratchSweep,
	withScratchDir,
} from '../../tools/tool_uca_maps/server/gdal.ts';
import { tool } from '../../tools/tool_uca_maps/server/index.ts';
import { mustGet } from '../helpers/assert.ts';
import { scratchMediaRoot } from '../helpers/media_scratch_root.ts';
import { expectCode, thrownBy, withTempDir } from './fixtures/tool_uca_maps/helpers.ts';

describe('tool_uca_maps scratch — inside the media root, never the OS temp dir (no GDAL needed)', () => {
	// ImageMagick spills its pixel cache into the scratch dir, and the OS temp
	// dir is the database's volume on the shipped compose stacks
	const within = (dir: string, root: string) => resolve(dir).startsWith(resolve(root) + sep);

	test('each call gets a private dir under the media root, swept afterwards', async () => {
		const mediaRoot = resolve(mustGet(config.media.rootPath, 'config.media.rootPath'));
		const toolRoot = join(mediaRoot, config.media.upload.tmpSubdir, 'tool_uca_maps');
		const seen: string[] = [];
		for (let i = 0; i < 2; i++) {
			await withScratchDir(async (dir) => {
				seen.push(dir);
				expect(existsSync(dir)).toBe(true);
				expect(within(dir, toolRoot)).toBe(true);
			});
		}
		expect(seen.length).toBe(2);
		expect(seen[0]).not.toBe(seen[1]);
		for (const dir of seen) expect(existsSync(dir)).toBe(false);
	});

	test('no media root, or an empty one, refuses as the missing dependency it is', () => {
		for (const root of [null, '']) {
			expectCode(
				thrownBy(() => scratchRoot(root)),
				'tool.dependency_unavailable',
			);
		}
	});

	test('a root without the test-media marker is refused and nothing is created in it', async () => {
		await withTempDir('uca_maps_unmarked_', async (unmarked) => {
			expectCode(
				thrownBy(() => scratchRoot(unmarked)),
				'media.invalid_path',
			);
			expect(existsSync(join(unmarked, config.media.upload.tmpSubdir))).toBe(false);
		});
	});

	test('a marked root gets the scratch under its staging tree, closed to other users', () => {
		const marked = scratchMediaRoot('uca_maps_marked_');
		try {
			const scratch = scratchRoot(marked);
			expect(scratch).toBe(join(marked, config.media.upload.tmpSubdir, 'tool_uca_maps'));
			expect(statSync(scratch).isDirectory()).toBe(true);
			expect(statSync(scratch).mode & 0o007).toBe(0);
		} finally {
			rmSync(marked, { recursive: true, force: true });
		}
	});

	// an orphan exists only once a process died mid-action: the boot after it
	// collects it, and no action's request path walks the scratch tree
	test('the boot hook sweeps an orphan a killed process left; a live one, a foreign entry and every action leave them', async () => {
		const root = scratchRoot();
		const old = join(root, 'scratch_orphan_gate');
		const live = join(root, 'scratch_live_gate');
		const foreign = join(root, 'not_scratch_gate');
		const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
		try {
			for (const dir of [old, live, foreign]) {
				mkdirSync(dir, { recursive: true });
				writeFileSync(join(dir, 'magick-spill'), 'x');
			}
			const stale = (Date.now() - SCRATCH_ORPHAN_TTL_MS - 60_000) / 1000;
			for (const dir of [old, foreign]) {
				utimesSync(join(dir, 'magick-spill'), stale, stale);
				utimesSync(dir, stale, stale);
			}

			await withScratchDir(async () => {});
			expect(existsSync(old)).toBe(true);

			// stopped before it fires (a shutdown during boot): nothing is swept
			mustGet(tool.onBoot, 'tool.onBoot')()?.stop();
			await settle();
			expect(existsSync(old)).toBe(true);

			const handle = mustGet(tool.onBoot, 'tool.onBoot')();
			await settle();
			handle?.stop();
			expect(existsSync(old)).toBe(false);
			expect(existsSync(live)).toBe(true);
			expect(existsSync(foreign)).toBe(true);
		} finally {
			for (const dir of [old, live, foreign]) rmSync(dir, { recursive: true, force: true });
		}
	});

	// a crash shortly before the boot leaves an orphan younger than the TTL: the
	// boot pass spares it, a later pass collects it
	test('the sweep repeats after boot, so an orphan younger than the TTL at boot is collected later; stop ends it', async () => {
		const root = scratchRoot();
		const late = join(root, 'scratch_late_gate');
		const after_stop = join(root, 'scratch_after_stop_gate');
		const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
		const age = (dir: string) => {
			mkdirSync(dir, { recursive: true });
			const stale = (Date.now() - SCRATCH_ORPHAN_TTL_MS - 60_000) / 1000;
			utimesSync(dir, stale, stale);
		};
		const handle = startScratchSweep(undefined, 40);
		try {
			await settle(10);
			age(late); // becomes an orphan after the boot pass
			await settle(120);
			expect(existsSync(late)).toBe(false);

			handle.stop();
			age(after_stop);
			await settle(120);
			expect(existsSync(after_stop)).toBe(true);
		} finally {
			handle.stop();
			for (const dir of [late, after_stop]) rmSync(dir, { recursive: true, force: true });
		}
	});

	// the sweep runs in a timer, past the loader's guard: a bad media root must
	// only warn, never throw where nothing catches it
	test('a sweep that cannot reach the media root warns and writes nothing', async () => {
		const warn = spyOn(console, 'warn').mockImplementation(() => {});
		try {
			await withTempDir('uca_maps_unmarked_sweep_', async (unmarked) => {
				for (const configured of [null, unmarked]) {
					const handle = startScratchSweep(configured, 60_000);
					await new Promise((resolve) => setTimeout(resolve, 20));
					handle.stop();
				}
				expect(warn.mock.calls.map((args) => args[0])).toEqual([
					'[tool_uca_maps] scratch sweep skipped:',
					'[tool_uca_maps] scratch sweep skipped:',
				]);
				expect(readdirSync(unmarked)).toEqual([]);
			});
		} finally {
			warn.mockRestore();
		}
	});
});
