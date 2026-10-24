/**
 * THE THUMB RULE, EXERCISED — "the thumb depicts its source; when the source
 * changes or disappears, the thumb is rebuilt or retired in the same seam".
 *
 * media_thumb_census_tripwire.test.ts holds the DECLARATIONS together; this file drives the
 * behaviour on a scratch media tree with the real binaries. Every case below is a
 * defect that was reachable in the shipped engine before 2026-08-08:
 *
 *  - a fresh av record had NO picture at all until an operator opened
 *    tool_posterframe (the transcode writes tiers only);
 *  - re-uploading a video left the old posterframe and thumb in place, reported by
 *    files_info as present and current — a picture of a file the record no longer
 *    held;
 *  - deleting a posterframe left its thumb serving;
 *  - the repair sweep could not rebuild an av or 3d thumb at all, so a deleted one
 *    was gone for good.
 *
 * The 3d half of each pair asserts the OPPOSITE outcome on purpose: that model's
 * posterframe cannot be minted here (no mesh renderer), so the honest end state is
 * "retired, and the refusal names the browser gear". A future change that makes 3d
 * behave like av would be wrong, and this is what says so.
 */
// MIGRATED TO THE GENERIC `test` TLD, 2026-08-19: every install tipo this gate
// spelled is now its generic twin (sections on the `test` TLD, storing in
// matrix_test). A pure rename — the tipo is an identifier in a path, a filename
// or a locator here, so no corpus and no DB round-trip were added.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { config } from '../../src/config/config.ts';
import { mediaTypeOf } from '../../src/core/concepts/media.ts';
import { resolveMagick } from '../../src/core/media/engine/imagemagick.ts';
import { runBinary } from '../../src/core/media/engine/spawn.ts';
import { scanFilesInfo } from '../../src/core/media/files_info.ts';
import type { MediaIdentity, MediaPathOptions } from '../../src/core/media/path.ts';
import { rebuildThumb, resolveThumbSource, thumbIsMissing } from '../../src/core/media/thumb.ts';
import { posterframeAbsolutePath } from '../../src/core/media/tools/posterframe.ts';
import { resetMediaRoot } from '../helpers/media_scratch_root.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const ROOT = scratchDir('thumb_rule');
const av = mediaTypeOf('component_av')!;
const threeD = mediaTypeOf('component_3d')!;
const HAVE_FFMPEG = existsSync(config.media.binaries.ffmpeg);
const HAVE_MAGICK = existsSync(resolveMagick());
const HAVE_BOTH = HAVE_FFMPEG && HAVE_MAGICK;

const pathOpts: MediaPathOptions = { initialMediaPath: '', maxItemsFolder: null, mediaRoot: ROOT };
const avIdentity: MediaIdentity = {
	componentTipo: 'test94',
	sectionTipo: 'test3',
	sectionId: 8,
	lang: null,
};
const tdIdentity: MediaIdentity = {
	componentTipo: 'test26',
	sectionTipo: 'test3',
	sectionId: 8,
	lang: null,
};
const avCtx = () => ({ spec: av, identity: avIdentity, pathOpts });
const tdCtx = () => ({ spec: threeD, identity: tdIdentity, pathOpts });
const avThumb = `${ROOT}/av/${config.media.thumb.quality}/test94_test3_8.${config.media.thumb.extension}`;
const tdThumb = `${ROOT}/3d/${config.media.thumb.quality}/test26_test3_8.${config.media.thumb.extension}`;

/** A real clip of `seconds` duration in the av original tier. */
async function makeAv(seconds: number, withVideo = true): Promise<void> {
	const abs = `${ROOT}/av/original/test94_test3_8.mp4`;
	mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
	const argv = withVideo
		? [
				config.media.binaries.ffmpeg,
				'-y',
				'-f',
				'lavfi',
				'-i',
				`testsrc=size=320x240:duration=${seconds}`,
				'-f',
				'lavfi',
				'-i',
				`sine=frequency=440:duration=${seconds}`,
				'-shortest',
				abs,
			]
		: [
				config.media.binaries.ffmpeg,
				'-y',
				'-f',
				'lavfi',
				'-i',
				`sine=frequency=440:duration=${seconds}`,
				'-c:a',
				'aac',
				abs,
			];
	await runBinary(argv, { nice: false });
}

/**
 * Put a file through the REAL ingest seam: stage it where the receiver would, then
 * call processUploadedFile exactly as the upload endpoint does. Driving the seam
 * (rather than the regenerates under it) is the point — the retire/rebuild rules
 * live in that seam.
 */
async function stageAndIngest(
	spec: typeof av,
	identity: MediaIdentity,
	fileName: string,
	extension: string,
	write: (target: string) => Promise<void>,
): Promise<void> {
	const { stagingDir } = await import('../../src/core/media/ingest/add_file.ts');
	const { processUploadedFile } = await import(
		'../../src/core/media/ingest/process_uploaded_file.ts'
	);
	const userId = 42;
	const keyDir = spec.typeFolder;
	const dir = stagingDir(userId, keyDir, ROOT);
	mkdirSync(dir, { recursive: true });
	const tmpName = `up_${fileName}`;
	await write(`${dir}/${tmpName}`);
	await processUploadedFile({
		spec,
		identity,
		pathOpts,
		userId,
		keyDir,
		tmpName,
		extension,
		quality: spec.originalQuality,
	});
}

// DECLARE the scratch root — the media doors refuse an unmarked one under the
// test-media seam (src/core/media/test_media_root.ts).
beforeAll(() => resetMediaRoot(ROOT));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe('the engine mints what it can (av), and says who can when it cannot (3d)', () => {
	test.if(HAVE_BOTH)('av: a record with NO posterframe still gets a thumb', async () => {
		resetMediaRoot(ROOT);
		await makeAv(20);
		expect(existsSync(posterframeAbsolutePath(av, avIdentity, pathOpts))).toBe(false);

		const outcome = await rebuildThumb(avCtx());

		// The whole point: no operator, no tool_posterframe, no waiting for the
		// transcode — the picture exists because the engine could make it.
		expect(outcome.mintedPosterframe).not.toBeNull();
		expect(outcome.built).toBe(avThumb);
		expect(existsSync(avThumb)).toBe(true);
		expect(existsSync(posterframeAbsolutePath(av, avIdentity, pathOpts))).toBe(true);
	});

	test.if(HAVE_BOTH)('av: a SHORT clip is sampled inside its own duration', async () => {
		// PHP minted at a fixed t=10 and its own doc block flagged the flaw: on a
		// 4-second clip that is past the end. A still nobody can see is not a
		// thumbnail, so the timecode is clamped to the middle of the clip.
		resetMediaRoot(ROOT);
		await makeAv(4);
		const outcome = await rebuildThumb(avCtx());
		expect(outcome.mintedPosterframe).not.toBeNull();
		expect(Bun.file(avThumb).size).toBeGreaterThan(0);
	});

	test.if(HAVE_FFMPEG)('av: an AUDIO-ONLY record refuses, and says why', async () => {
		resetMediaRoot(ROOT);
		await makeAv(3, false);
		await expect(rebuildThumb(avCtx())).rejects.toThrow(/audio-only|no video frame/i);
		expect(existsSync(avThumb)).toBe(false);
	});

	test('3d: refuses with the BROWSER remedy — never a silent no-op', async () => {
		resetMediaRoot(ROOT);
		mkdirSync(`${ROOT}/3d/web`, { recursive: true });
		writeFileSync(`${ROOT}/3d/web/test26_test3_8.glb`, 'glTF-not-an-image');
		const resolution = resolveThumbSource(tdCtx());
		expect(resolution.source).toBeNull();
		// `mintable:false` is the census fact that separates 3d from av.
		expect(resolution.mintable).toBe(false);
		await expect(rebuildThumb(tdCtx())).rejects.toThrow(/3D viewer/);
		expect(existsSync(tdThumb)).toBe(false);
	});
});

describe('a thumb never outlives what it depicts', () => {
	test.if(HAVE_BOTH)('av: replacing the master retires the stale pair, then rebuilds', async () => {
		resetMediaRoot(ROOT);
		await makeAv(20);
		await rebuildThumb(avCtx());
		const firstThumb = await Bun.file(avThumb).arrayBuffer();

		// A different video in the same record — through the real ingest seam.
		await stageAndIngest(av, avIdentity, 'new_clip.mp4', 'mp4', async (target) => {
			await runBinary(
				[
					config.media.binaries.ffmpeg,
					'-y',
					'-f',
					'lavfi',
					'-i',
					'color=c=red:size=320x240:duration=20',
					target,
				],
				{ nice: false },
			);
		});

		// The picture must depict the NEW video, not the old one.
		expect(existsSync(avThumb)).toBe(true);
		const secondThumb = await Bun.file(avThumb).arrayBuffer();
		expect(Buffer.from(secondThumb).equals(Buffer.from(firstThumb))).toBe(false);
	});

	test.if(HAVE_BOTH)(
		'3d: replacing the master retires the pair (nothing can re-render it)',
		async () => {
			resetMediaRoot(ROOT);
			// A record with a posterframe + thumb already in place…
			const poster = posterframeAbsolutePath(threeD, tdIdentity, pathOpts);
			mkdirSync(poster.slice(0, poster.lastIndexOf('/')), { recursive: true });
			await runBinary(
				[
					config.media.binaries.ffmpeg,
					'-y',
					'-f',
					'lavfi',
					'-i',
					'color=c=blue:s=64x64:d=1',
					'-frames:v',
					'1',
					poster,
				],
				{ nice: false },
			);
			await rebuildThumb(tdCtx());
			expect(existsSync(tdThumb)).toBe(true);

			// …then a NEW mesh lands, through the real ingest seam.
			await stageAndIngest(threeD, tdIdentity, 'new_model.glb', 'glb', async (target) => {
				writeFileSync(target, 'glTF-binary-ish');
			});

			// Both are gone: the record shows its placeholder until the browser captures
			// the new scene. A stale picture would be worse than none.
			expect(existsSync(tdThumb)).toBe(false);
			expect(existsSync(poster)).toBe(false);
			// And they are RECOVERABLE — retired, not destroyed.
			expect(existsSync(`${ROOT}/3d/posterframe/deleted`)).toBe(true);
		},
	);
});

describe('the repair sweep can restore any model’s thumb', () => {
	test.if(HAVE_BOTH)('av: a deleted thumb comes back on the next sweep', async () => {
		resetMediaRoot(ROOT);
		await makeAv(20);
		await rebuildThumb(avCtx());
		rmSync(avThumb, { force: true });
		expect(thumbIsMissing(avCtx())).toBe(true);

		// The sweep's own pass, with the scratch root (refreshMediaItems resolves
		// path options from the ontology, so it cannot be pointed at a test tree).
		const { regenerateMissingDerivatives } = await import('../../src/core/media/repair.ts');
		const errors = await regenerateMissingDerivatives('component_av', av, avIdentity, pathOpts, {
			rawExtension: 'mp4',
			deleteNormalized: false,
			bulkProcessId: null,
		});
		// It used to be structurally impossible: the sweep had no av branch at all.
		expect(errors).toEqual([]);
		expect(existsSync(avThumb)).toBe(true);
	});

	test.if(HAVE_BOTH)('the restored thumb is INDEXED, not just on disk', async () => {
		const entries = scanFilesInfo(av, avIdentity, pathOpts);
		const thumb = entries.find((entry) => entry.quality === config.media.thumb.quality);
		expect(thumb?.file_exist).toBe(true);
	});
});
