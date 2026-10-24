/**
 * v6 create_thumb parity (component_image::create_thumb :393): the thumb builds
 * FROM THE DEFAULT-QUALITY FILE and never needs the original. The first TS port
 * gated the whole tool regenerate — and the versions tool's thumb build — on
 * `resolveMasterSource`, so on a partial-media box (default files present,
 * originals not) "nothing happened": no thumb, no envelope, or a hard
 * 'original not found'. These gates pin the corrected behavior with a scratch
 * media root holding ONLY the default-quality file.
 *
 * Skips honestly when the imagemagick binary or the sample source file is
 * unavailable on this box.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../src/config/config.ts';
import { mediaTypeOf } from '../../src/core/concepts/media.ts';
import { regenerateMissingDerivatives } from '../../src/core/media/repair.ts';
import { buildVersionCore } from '../../src/core/media/tools/versions.ts';
import { markMediaRoot, resetMediaRoot } from '../helpers/media_scratch_root.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const spec = mediaTypeOf('component_image');
const identity = { componentTipo: 'test99', sectionTipo: 'test3', sectionId: 1, lang: null };
const scratchRoot = scratchDir('thumb_parity');
const pathOpts = { initialMediaPath: '', maxItemsFolder: 1000, mediaRoot: scratchRoot };

/** The real default-quality sample on this box (skip when absent). */
const sampleDefault =
	config.media.rootPath !== null
		? join(config.media.rootPath, 'image/1.5MB/0/test99_test3_1.jpg')
		: '';

function seedScratch(): boolean {
	if (spec === null || sampleDefault === '' || !existsSync(sampleDefault)) return false;
	resetMediaRoot(scratchRoot);
	mkdirSync(join(scratchRoot, 'image/1.5MB/0'), { recursive: true });
	copyFileSync(sampleDefault, join(scratchRoot, 'image/1.5MB/0/test99_test3_1.jpg'));
	// Deliberately NO image/original tier — the partial-media-box shape.
	return true;
}

// DECLARE the scratch root even for the cases that never seed it: the media doors
// refuse an UNDECLARED root before they get as far as "there is no file here"
// (src/core/media/test_media_root.ts), and an empty-but-declared root still
// produces exactly the absence this file pins.
beforeAll(() => markMediaRoot(scratchRoot));

afterAll(() => {
	rmSync(scratchRoot, { recursive: true, force: true });
});

describe('thumb builds from the default-quality file (no original needed)', () => {
	test('tool regenerate: thumb + envelope created with only the default file present', async () => {
		if (!seedScratch()) return;
		await regenerateMissingDerivatives('component_image', spec!, identity, pathOpts, {
			rawExtension: null,
			deleteNormalized: false,
			bulkProcessId: null,
		});
		expect(existsSync(join(scratchRoot, 'image/thumb/0/test99_test3_1.jpg'))).toBe(true);
		expect(existsSync(join(scratchRoot, 'image/svg/0/test99_test3_1.svg'))).toBe(true);
	});

	test('versions tool build_version(thumb): succeeds without an original', async () => {
		if (!seedScratch()) return;
		const result = await buildVersionCore(spec!, identity, pathOpts, config.media.thumb.quality);
		expect(result.jobId).toBeNull();
		expect(result.built.length).toBe(1);
		expect(existsSync(join(scratchRoot, 'image/thumb/0/test99_test3_1.jpg'))).toBe(true);
	});

	test('nothing to build from: absent default AND original is a clear error (versions tool)', async () => {
		if (spec === null) return;
		// Emptied AND re-declared: `rmSync(root, {recursive:true})` takes the
		// `.dedalo_test_media` marker with it, and an undeclared root is refused by
		// the media door BEFORE it can report the absence this test pins.
		resetMediaRoot(scratchRoot);
		mkdirSync(join(scratchRoot, 'image'), { recursive: true });
		await expect(
			buildVersionCore(spec, identity, pathOpts, config.media.thumb.quality),
			// The wording moved into the shared handler (media/thumb.ts) when the five
			// per-trigger source rules became one; what this pins is unchanged — a
			// record with neither a delivered file nor a master fails LOUDLY, naming
			// both things it looked for, instead of returning an empty success.
		).rejects.toThrow(/no 1\.5MB file and no master to build the thumb/);
	});
});
