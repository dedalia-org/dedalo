/**
 * ATOMIC MEDIA WRITER gate — `src/core/media/atomic.ts`.
 *
 * Nothing here spawns a binary: the producer callback IS the seam, so every
 * failure mode a real ImageMagick run can hit is reproduced by writing the exact
 * files it writes. The one that matters is the SEQUENCE SPLIT — a multi-image
 * source makes ImageMagick write `<stem>-0.jpg`, `<stem>-1.jpg`… and never the
 * bare temp, so the rename throws ENOENT and the split files stay. On 2026-08-04
 * that left six orphaned `…tmp.…-N.jpg` files in a live thumb directory with
 * nothing in the codebase able to clean them.
 *
 * So the gates below assert the DESTINATION DIRECTORY, not the return value: a
 * writer that throws correctly but leaks debris has not done its job.
 */
// MIGRATED TO THE GENERIC `test` TLD, 2026-08-19: every install tipo this gate
// spelled is now its generic twin (sections on the `test` TLD, storing in
// matrix_test). A pure rename — the tipo is an identifier in a path, a filename
// or a locator here, so no corpus and no DB round-trip were added.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { mediaTypeOf } from '../../src/core/concepts/media.ts';
import {
	ensureDir,
	tempSibling,
	writeAtomically,
	writeAtomicallySync,
} from '../../src/core/media/atomic.ts';
import type { MediaIdentity, MediaPathOptions } from '../../src/core/media/path.ts';
import { copyToQuality } from '../../src/core/media/processing.ts';
import { markMediaRoot } from '../helpers/media_scratch_root.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const ROOT = scratchDir('media_atomic');
const DIR = `${ROOT}/thumb`;
const TARGET = `${DIR}/test99_test3_440866.jpg`;

beforeEach(() => {
	rmSync(ROOT, { recursive: true, force: true });
	// DECLARE the scratch root (the media doors refuse an unmarked one under the
	// test-media seam — src/core/media/test_media_root.ts).
	markMediaRoot(ROOT);
	mkdirSync(DIR, { recursive: true });
});

afterAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

/** Everything currently in the destination dir, sorted (the real assertion). */
const contents = (): string[] => readdirSync(DIR).sort();

/** Split a temp path the way ImageMagick names its sequence output. */
function sequenceSibling(temp: string, index: number): string {
	const dot = temp.lastIndexOf('.');
	return `${temp.slice(0, dot)}-${String(index)}${temp.slice(dot)}`;
}

describe('writeAtomically: the destination dir is left clean whatever the producer did', () => {
	test('happy path: the temp is renamed into place and no temp survives', async () => {
		const result = await writeAtomically(TARGET, async (temp) => {
			expect(temp).not.toBe(TARGET);
			// The temp MUST keep the target extension: ImageMagick and ffmpeg infer the
			// OUTPUT FORMAT from the filename, so `x.jpg.tmp.123` makes them fall back
			// to the SOURCE format and write e.g. TIFF bytes into a `.jpg` tier.
			expect(temp.endsWith('.jpg')).toBe(true);
			expect(temp).toContain('.tmp.');
			writeFileSync(temp, 'jpeg-bytes');
		});
		expect(result).toBe(TARGET);
		expect(contents()).toEqual(['test99_test3_440866.jpg']);
	});

	test('the target directory is created when it does not exist yet', async () => {
		const nested = `${ROOT}/deep/440000/x.jpg`;
		await writeAtomically(nested, async (temp) => {
			writeFileSync(temp, 'x');
		});
		expect(existsSync(nested)).toBe(true);
	});

	test('SEQUENCE SPLIT: the producer writes <temp>-0/-1 and nothing survives', async () => {
		// Exactly what `magick layered.tif … thumb.tmp.<uuid>.jpg` did: exit 0, empty
		// stderr, three files named after the temp and no file named the temp.
		let temps: string[] = [];
		const failed = writeAtomically(TARGET, async (temp) => {
			temps = [0, 1, 2].map((index) => sequenceSibling(temp, index));
			for (const split of temps) writeFileSync(split, 'jpeg-bytes');
		});
		// The rename cannot find the temp, so the write fails LOUDLY…
		await expect(failed).rejects.toThrow();
		// …and the directory is exactly as it was before the call: no `.tmp.` file,
		// no `-N.jpg` orphan, no half-written target. Before the sweep existed these
		// three files stayed in the live thumb directory forever.
		expect(contents()).toEqual([]);
		for (const split of temps) expect(existsSync(split)).toBe(false);
	});

	test('a producer error propagates UNCHANGED and still leaves nothing behind', async () => {
		let temp = '';
		const failed = writeAtomically(TARGET, async (path) => {
			temp = path;
			writeFileSync(path, 'partial');
			writeFileSync(sequenceSibling(path, 0), 'partial');
			throw new Error('ImageMagick produced no output file');
		});
		// The cleanup runs in a `finally`: it must not swallow or replace the real
		// diagnostic, which is the only thing that names the failing recipe.
		await expect(failed).rejects.toThrow('ImageMagick produced no output file');
		expect(contents()).toEqual([]);
		expect(existsSync(temp)).toBe(false);
	});

	test('the sweep matches the DOTTED temp stem literally — a sibling record is safe', async () => {
		// A media temp is `test99_test3_440866.tmp.<pid>.<uuid>.jpg`: full of dots. An
		// unescaped '.' in the sweep regex matches ANY character, so the pattern would
		// reach files belonging to other records and other concurrent writes. The
		// decoy below differs from the temp only where the temp has a dot, so it is
		// deleted by an unescaped pattern and untouched by the escaped one.
		let decoy = '';
		let realSplit = '';
		const failed = writeAtomically(TARGET, async (temp) => {
			realSplit = sequenceSibling(temp, 0);
			decoy = sequenceSibling(temp.replace('.tmp.', 'Xtmp.'), 0);
			expect(decoy).not.toBe(realSplit);
			writeFileSync(realSplit, 'mine');
			writeFileSync(decoy, 'someone else’s file');
		});
		await expect(failed).rejects.toThrow();
		expect(existsSync(realSplit)).toBe(false);
		expect(existsSync(decoy)).toBe(true);
		// Clean the decoy by hand: nothing in the writer owns it, which is the point.
		rmSync(decoy, { force: true });
	});

	test('a concurrent write to the SAME target is never swept by the other call', async () => {
		// The sweep is bounded by the temp's unique stem, and that uniqueness is what
		// makes it concurrency-safe. `performance.now()` (the previous suffix) can
		// repeat inside a millisecond; pid + randomUUID cannot.
		const seen = new Set<string>();
		for (let i = 0; i < 5000; i++) seen.add(tempSibling(TARGET));
		expect(seen.size).toBe(5000);

		let otherTemp = '';
		const other = writeAtomically(TARGET, async (temp) => {
			otherTemp = temp;
			writeFileSync(temp, 'the winner');
			// A second, failing write of the same target runs while this temp exists.
			await writeAtomically(TARGET, async (loser) => {
				writeFileSync(sequenceSibling(loser, 0), 'split');
			}).catch(() => undefined);
			expect(existsSync(otherTemp)).toBe(true);
		});
		await other;
		expect(contents()).toEqual(['test99_test3_440866.jpg']);
	});
});

describe('writeAtomicallySync: the sync twin stays sync', () => {
	test('the file is on disk when the call RETURNS (no promise, no await)', () => {
		// Deliberately a non-async test: if this became async the assertion below
		// would still pass on a promise, which is exactly the regression it guards.
		const result = writeAtomicallySync(TARGET, (temp) => {
			writeFileSync(temp, 'jpeg-bytes');
		});
		expect(result).toBe(TARGET);
		expect(typeof (result as unknown as { then?: unknown }).then).toBe('undefined');
		expect(existsSync(TARGET)).toBe(true);
		expect(contents()).toEqual(['test99_test3_440866.jpg']);
	});

	test('it sweeps and rethrows exactly like its async twin', () => {
		let temp = '';
		expect(() =>
			writeAtomicallySync(TARGET, (path) => {
				temp = path;
				writeFileSync(sequenceSibling(path, 0), 'split');
				throw new Error('copy failed');
			}),
		).toThrow('copy failed');
		expect(contents()).toEqual([]);
		expect(existsSync(sequenceSibling(temp, 0))).toBe(false);
	});

	test('copyToQuality is ASYNCHRONOUS — a whole media file never blocks the event loop', async () => {
		// INVERTED 2026-09-05 (MEDIA-02). It used to assert copyToQuality was SYNC,
		// on the argument that regenerate3d was called unawaited from
		// ingest/process_uploaded_file.ts and a promise would become an unhandled
		// rejection. Measured: every call site already awaited inside a try/catch,
		// so the only thing the sync twin bought was a blocked event loop for the
		// length of a whole-file copy. The sync writer itself STAYS — its one caller
		// (ingest/staged_name_record.ts) writes a fixed-size display-name string.
		expect(copyToQuality.constructor.name).toBe('AsyncFunction');
		expect(writeAtomicallySync.constructor.name).toBe('Function');

		const spec = mediaTypeOf('component_3d');
		if (spec === null) throw new Error('component_3d media spec is not registered');
		const identity: MediaIdentity = {
			componentTipo: 'test99',
			sectionTipo: 'test3',
			sectionId: 440866,
			lang: null,
		};
		const pathOpts: MediaPathOptions = {
			initialMediaPath: '',
			maxItemsFolder: null,
			mediaRoot: ROOT,
		};
		const source = `${DIR}/source.obj`;
		ensureDir(source);
		writeFileSync(source, 'v 0.0 0.0 0.0\n');

		const created = await copyToQuality(
			spec,
			identity,
			spec.defaultQuality,
			source,
			'obj',
			pathOpts,
		);
		expect(typeof created).toBe('string');
		expect(existsSync(created)).toBe(true);
		expect(readdirSync(created.slice(0, created.lastIndexOf('/')))).toEqual([
			created.slice(created.lastIndexOf('/') + 1),
		]);
	});
});
