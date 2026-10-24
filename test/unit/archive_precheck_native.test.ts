/**
 * AN ARCHIVE IS REFUSED BEFORE IT IS UNPACKED, NOT AFTER (P2-7 / DOS-07).
 *
 * `extractArchive` spawned `unzip -o -q` and let it run to completion. The only
 * uncompressed-size bound (1 GiB) was summed inside `walk(destDir)` AFTER unzip
 * had written every byte — so the cap described a disk that was already full.
 *
 * That is not a theoretical ordering problem: `renameSwap`'s same-device
 * requirement GUARANTEES the staging directory shares the install's volume, so
 * a zip bomb fills the LIVE volume of a running heritage install and the
 * refusal arrives after the damage.
 *
 * `preValidateArchive` already checked entry NAMES and symlink MODES, and the
 * verbose `zipinfo` output it already spawned carries the DECLARED UNCOMPRESSED
 * SIZE in its fourth column. The bound now runs there — one more pass over text
 * we already had, not another spawn.
 *
 * The post-extraction sum STAYS where it was. The two catch different things: a
 * declared size can lie, and a bomb that announces itself honestly is refused
 * before it costs anything. Belt and brace, in that order.
 *
 * These tests build REAL archives with the system `zip` and feed them to the
 * REAL door — no fixture, no mock, nothing that could pass by describing the
 * check instead of running it.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { preValidateArchive } from '../../src/core/update/code_update.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const ROOT = scratchDir('archive_precheck');

/** Build a zip whose single entry DECLARES `megabytes` of uncompressed zeroes. */
function buildArchive(name: string, megabytes: number): string {
	const stage = join(ROOT, name);
	const tree = join(stage, 'dedalo_code');
	mkdirSync(tree, { recursive: true });
	// Zeroes compress to almost nothing, so the file on disk stays small while
	// the header declares the full size — the zip-bomb shape, honestly built.
	writeFileSync(join(tree, 'big.bin'), Buffer.alloc(megabytes * 1024 * 1024));
	const zipPath = join(ROOT, `${name}.zip`);
	const built = Bun.spawnSync(['zip', '-q', '-1', '-r', zipPath, 'dedalo_code'], { cwd: stage });
	if (built.exitCode !== 0) throw new Error(`zip failed for ${name}`);
	return zipPath;
}

beforeAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
	mkdirSync(ROOT, { recursive: true });
});
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe('an over-cap archive is refused before extraction', () => {
	test('a small zip declaring more than the cap is REFUSED', async () => {
		// 1200 MiB declared, a few MB on disk — measured 2026-08-31 at ~5.4 MB.
		const zipPath = buildArchive('bomb', 1200);
		const onDisk = Bun.file(zipPath).size;
		expect(onDisk, 'the probe must be small on disk or it proves nothing').toBeLessThan(
			50 * 1024 * 1024,
		);
		const reason = await preValidateArchive(zipPath);
		expect(reason, 'a 1.2 GiB declaration passed the pre-check').not.toBeNull();
		expect(reason).toContain('uncompressed bytes');
	}, 60_000);

	test('the refusal is fast — it reads headers, it does not unpack', async () => {
		// The whole point is ordering. If this ever starts taking as long as an
		// extraction, the check has moved back behind unzip.
		const zipPath = buildArchive('bomb_timing', 1200);
		const started = Date.now();
		await preValidateArchive(zipPath);
		expect(Date.now() - started).toBeLessThan(5_000);
	}, 60_000);

	test('an ordinary release archive still passes', async () => {
		// A gate that refuses everything is not a gate. This is the control.
		const stage = join(ROOT, 'ok');
		mkdirSync(join(stage, 'dedalo_code', 'src'), { recursive: true });
		writeFileSync(join(stage, 'dedalo_code', 'package.json'), '{}');
		writeFileSync(join(stage, 'dedalo_code', 'src', 'index.ts'), "console.log('hi')\n");
		const zipPath = join(ROOT, 'ok.zip');
		Bun.spawnSync(['zip', '-q', '-r', zipPath, 'dedalo_code'], { cwd: stage });
		expect(await preValidateArchive(zipPath)).toBeNull();
	}, 30_000);

	test('the size bound is read from the pre-check, not only after extraction', () => {
		// Structural pin on the ORDERING the tests above exercise: the declared-size
		// refusal must live in the pre-validation path. The post-extraction sum
		// stays — it catches a header that lied — but it can no longer be the ONLY
		// place the cap exists.
		const source = Bun.file(join(import.meta.dir, '..', '..', 'src/core/update/code_update.ts'));
		return source.text().then((text) => {
			const scan = text.slice(text.indexOf('async function scanArchiveModesForSymlinks'));
			expect(scan.slice(0, 2000)).toContain('MAX_EXTRACTED_TOTAL_BYTES');
			// ...and the post-extraction belt is still there.
			expect(text).toMatch(/walk\(destDir\)|MAX_EXTRACTED_TOTAL_BYTES/);
		});
	});
});
