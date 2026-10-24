/**
 * Phase E gate: the media tool CORES run real binaries against a scratch root,
 * and the tool server modules load with the expected apiActions + permission
 * gates. Full tool_request→handler→DB drive is ledgered (media not synced to
 * this box); the operations are gated here at the core level.
 */
// MIGRATED TO THE GENERIC `test` TLD, 2026-08-19: every install tipo this gate
// spelled is now its generic twin (sections on the `test` TLD, storing in
// matrix_test). A pure rename — the tipo is an identifier in a path, a filename
// or a locator here, so no corpus and no DB round-trip were added.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { config } from '../../src/config/config.ts';
import { mediaTypeOf } from '../../src/core/concepts/media.ts';
import { getDimensions, resolveMagick } from '../../src/core/media/engine/imagemagick.ts';
import { runBinary } from '../../src/core/media/engine/spawn.ts';
import type { MediaIdentity, MediaPathOptions } from '../../src/core/media/path.ts';
import {
	baseSvgUrl,
	createDefaultSvgFile,
	svgOverlayLocation,
} from '../../src/core/media/svg_overlay.ts';
import { extractPdfCore } from '../../src/core/media/tools/pdf_extract.ts';
import { applyRotationCore } from '../../src/core/media/tools/rotation.ts';
import {
	buildVersionCore,
	conformHeadersCore,
	deleteAndResyncCore,
	deleteQualityCore,
	deleteVersionCore,
	getFilesInfoCore,
	rotateVersionCore,
} from '../../src/core/media/tools/versions.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import { magickTestEnv } from '../helpers/magick_test_env.ts';
import { resetMediaRoot } from '../helpers/media_scratch_root.ts';
import { refusalOf } from '../helpers/refusal.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const ROOT = scratchDir('media_tools');
const image = mediaTypeOf('component_image')!;
const pdf = mediaTypeOf('component_pdf')!;
const av = mediaTypeOf('component_av')!;
// S3-67: binary paths are CONFIG (config.media.binaries — env-overridable,
// platform-defaulted), never hardcoded workstation paths.
const BIN = config.media.binaries;
const HAVE_FFMPEG = existsSync(BIN.ffmpeg) && existsSync(BIN.qtFaststart);

/** Generate a tiny real mp4 (2s testsrc) so ffmpeg conform/probe run for real. */
async function makeMp4(relative: string): Promise<void> {
	const abs = `${ROOT}${relative}`;
	mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
	await runBinary(
		[BIN.ffmpeg, '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x120:rate=10', abs],
		{ nice: false },
	);
}
const HAVE_MAGICK = existsSync(resolveMagick());
// gs is a TEST-FIXTURE generator only (not a Dédalo runtime binary — no
// config key); probe the platform candidates instead of one absolute path.
const GS_BIN =
	['/opt/homebrew/bin/gs', '/usr/local/bin/gs', '/usr/bin/gs'].find((p) => existsSync(p)) ?? 'gs';
const HAVE_GS = GS_BIN !== 'gs';
const identity: MediaIdentity = {
	componentTipo: 'test99',
	sectionTipo: 'test3',
	sectionId: 5,
	lang: null,
};
const pathOpts: MediaPathOptions = { initialMediaPath: '', maxItemsFolder: null, mediaRoot: ROOT };

async function makeImage(relative: string, size: string): Promise<void> {
	const abs = `${ROOT}${relative}`;
	mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
	await runBinary([resolveMagick(), '-size', size, 'xc:orange', abs], {
		nice: false,
		env: magickTestEnv(),
	});
}
async function makePdf(relative: string): Promise<void> {
	const abs = `${ROOT}${relative}`;
	mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
	await runBinary(
		[
			GS_BIN,
			'-q',
			'-dNOPAUSE',
			'-dBATCH',
			'-sDEVICE=pdfwrite',
			'-o',
			abs,
			'-c',
			'<< /PageSize [200 200] >> setpagedevice /Helvetica findfont 20 scalefont setfont 20 100 moveto (WORLD) show showpage',
		],
		{ nice: false },
	);
}

// DECLARE the scratch root — the media doors refuse an unmarked one under the
// test-media seam (src/core/media/test_media_root.ts).
beforeAll(() => resetMediaRoot(ROOT));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe('tool_media_versions core', () => {
	test.if(HAVE_MAGICK)(
		'build_version builds a tier from the original; the original is untouched',
		async () => {
			await makeImage('/image/original/test99_test3_5.jpg', '2000x1500');
			const before = await getDimensions(`${ROOT}/image/original/test99_test3_5.jpg`);
			const built = await buildVersionCore(image, identity, pathOpts, '1.5MB');
			expect(built.jobId).toBeNull();
			expect(built.built[0]).toContain('/image/1.5MB/test99_test3_5.jpg');
			// original unchanged
			const after = await getDimensions(`${ROOT}/image/original/test99_test3_5.jpg`);
			expect(after).toEqual(before);
			// files_info now sees original + 1.5MB
			const info = getFilesInfoCore(image, identity, pathOpts);
			expect(info.some((e) => e.quality === '1.5MB')).toBe(true);
		},
	);

	/**
	 * THE OPERATOR'S CONTROL OVER THE ALTERNATE TWINS (2026-08-07, decision D8).
	 *
	 * Omitting `target_extension` builds the tier COMPLETE — its normalized file
	 * plus every configured twin — because a tier minted on demand must not arrive
	 * half-built: the ⟺ invariant (processing.ts buildAlternateVersions) would be
	 * false the moment it is created, and the next master change would retire a twin
	 * nobody ever built.
	 *
	 * Naming one builds EXACTLY that file. Delete is already granular
	 * (delete_version takes an extension), so without this, recovering a single twin
	 * meant re-encoding the tier's own jpg as well — destroying any rotation or crop
	 * an operator had applied to it, on a request that asked for nothing of the sort.
	 */
	test.if(HAVE_MAGICK)(
		'build_version builds the tier COMPLETE: its file + every twin',
		async () => {
			const id13: MediaIdentity = { ...identity, sectionId: 13 };
			await makeImage('/image/original/test99_test3_13.jpg', '2000x1500');
			const built = await buildVersionCore(image, id13, pathOpts, image.defaultQuality);
			expect(built.errors).toEqual([]);
			expect(built.built.length).toBe(1 + image.alternateExtensions.length);
			for (const alternate of image.alternateExtensions) {
				const twin = `${ROOT}/image/${image.defaultQuality}/test99_test3_13.${alternate}`;
				expect([alternate, existsSync(twin)]).toEqual([alternate, true]);
			}
		},
	);

	test.if(HAVE_MAGICK)(
		'build_version with target_extension rebuilds ONE twin, leaving the tier untouched',
		async () => {
			const alternate = image.alternateExtensions[0];
			expect(
				alternate,
				'this gate needs a configured alternate extension (DEDALO_IMAGE_ALTERNATIVE_EXTENSIONS)',
			).toBeDefined();
			const id14: MediaIdentity = { ...identity, sectionId: 14 };
			await makeImage('/image/original/test99_test3_14.jpg', '2000x1500');
			await buildVersionCore(image, id14, pathOpts, image.defaultQuality);
			const tierFile = `${ROOT}/image/${image.defaultQuality}/test99_test3_14.jpg`;
			const twin = `${ROOT}/image/${image.defaultQuality}/test99_test3_14.${alternate as string}`;
			// The operator's work lives ONLY in the tier's own file, and recovering the
			// twin must not cost it. (statSync, not bytes: an mtime+size pair changes on
			// any re-encode.)
			const tierBefore = statSync(tierFile);
			rmSync(twin, { force: true }); // the twin the operator wants back

			const built = await buildVersionCore(
				image,
				id14,
				pathOpts,
				image.defaultQuality,
				null,
				alternate,
			);

			expect(built.built.length).toBe(1);
			expect(built.built[0]).toBe(twin);
			expect(built.errors).toEqual([]);
			expect(existsSync(twin)).toBe(true);
			// The tier's own file was not re-encoded.
			const tierAfter = statSync(tierFile);
			expect([tierAfter.size, tierAfter.mtimeMs]).toEqual([tierBefore.size, tierBefore.mtimeMs]);
		},
	);

	test.if(HAVE_MAGICK)(
		'…and REFUSES when the tier carries a rotation the master does not',
		async () => {
			// THE TWIN IS A COMPANION, AND ITS SOURCE IS THE MASTER. Those two facts
			// collide exactly here: a tier an operator rotated is no longer a plain
			// resize of the master, so a twin built from the master would be a companion
			// of a DIFFERENT PICTURE. MEASURED on the shipped code before this refusal:
			// rotate 1.5MB by 90° (both extensions rotate together, correctly), lose the
			// twin, recover it here — and the tier ends up holding an 852x620 jpg beside
			// a 618x850 avif, reported by files_info as present and current, with no
			// error anywhere. The same path is what tool_update_cache's repair sweep
			// walks, so on an install that turns the key on it would manufacture one for
			// every already-rotated tier, unattended.
			const alternate = image.alternateExtensions[0];
			const id15: MediaIdentity = { ...identity, sectionId: 15 };
			await makeImage('/image/original/test99_test3_15.jpg', '2000x1500');
			await buildVersionCore(image, id15, pathOpts, image.defaultQuality);
			const tierFile = `${ROOT}/image/${image.defaultQuality}/test99_test3_15.jpg`;
			const twin = `${ROOT}/image/${image.defaultQuality}/test99_test3_15.${alternate as string}`;
			// The rotation, simulated in the one way that matters to the check: the
			// tier's own file is now portrait while its landscape master is untouched.
			await makeImage(`/image/${image.defaultQuality}/test99_test3_15.jpg`, '600x900');
			const tierBefore = statSync(tierFile);
			rmSync(twin, { force: true });

			const built = await buildVersionCore(
				image,
				id15,
				pathOpts,
				image.defaultQuality,
				null,
				alternate,
			);

			// Nothing written, and the refusal is READABLE: it names the two geometries,
			// the config key that asked for the format, and what to do about it.
			expect(built.built).toEqual([]);
			expect(existsSync(twin)).toBe(false);
			expect(built.errors.length).toBe(1);
			expect(built.errors[0]).toContain('600x900');
			expect(built.errors[0]).toContain('2000x1500');
			expect(built.errors[0]).toContain('DEDALO_IMAGE_ALTERNATIVE_EXTENSIONS');
			expect(built.errors[0]).toContain('Rebuild the tier itself');
			// And the operator's rotated file is untouched by the refusal.
			const tierAfter = statSync(tierFile);
			expect([tierAfter.size, tierAfter.mtimeMs]).toEqual([tierBefore.size, tierBefore.mtimeMs]);
			expect(await getDimensions(tierFile)).toEqual({ width: 600, height: 900 });
		},
	);

	test.if(HAVE_MAGICK)(
		'a twin with no tier file to accompany is REFUSED, not empty-success',
		async () => {
			// A twin is a COMPANION. With no tier file the reconciler builds nothing (and
			// would retire the twin), so returning an empty success would have the panel
			// render "done" over a request that produced no file at all.
			const alternate = image.alternateExtensions[0] as string;
			const id15: MediaIdentity = { ...identity, sectionId: 15 };
			await makeImage('/image/original/test99_test3_15.jpg', '800x600');
			const higher = image.qualities.find(
				(quality) =>
					!image.masterQualities.includes(quality) &&
					quality !== image.defaultQuality &&
					quality !== config.media.thumb.quality,
			) as string;
			await expect(
				buildVersionCore(image, id15, pathOpts, higher, null, alternate),
			).rejects.toThrow(/nothing to accompany/);
			expect(existsSync(`${ROOT}/image/${higher}/test99_test3_15.${alternate}`)).toBe(false);
		},
	);

	test('build_version refuses a target extension this engine does not write', async () => {
		const id16: MediaIdentity = { ...identity, sectionId: 16 };
		// An image format the install did not configure: writing it would produce a
		// file no scanner ever walks (files_info reads the configured list), so the
		// refusal names the key to add it to.
		const unconfigured = ['webp', 'gif', 'bmp'].find(
			(extension) => !image.alternateExtensions.includes(extension),
		) as string;
		await expect(
			buildVersionCore(image, id16, pathOpts, image.defaultQuality, null, unconfigured),
		).rejects.toThrow(new RegExp(`cannot build a '\\.${unconfigured}' version`));
		await expect(
			buildVersionCore(image, id16, pathOpts, image.defaultQuality, null, unconfigured),
		).rejects.toThrow(new RegExp(image.alternateExtensionsConfigKey));
		// …and on a model with NO builder at all, the refusal states WHY, naming the
		// code that would have to change (NO_ALTERNATE_BUILDER_REASON).
		await expect(buildVersionCore(av, id16, pathOpts, '404', null, 'webm')).rejects.toThrow(
			/NO alternate-extension builder at all/,
		);
		await expect(buildVersionCore(av, id16, pathOpts, '404', null, 'webm')).rejects.toThrow(
			/ffmpeg_profiles\.ts/,
		);
		// The THUMB tier is fixed by config: files_info scans it with that extension
		// alone, so anything else would be written and never seen.
		await expect(
			buildVersionCore(image, id16, pathOpts, config.media.thumb.quality, null, 'png'),
		).rejects.toThrow(/could never be indexed/);
	});

	test.if(HAVE_MAGICK)('delete_version soft-deletes into deleted/', async () => {
		await makeImage('/image/6MB/test99_test3_5.jpg', '400x300');
		const moved = deleteVersionCore(image, identity, pathOpts, '6MB', 'jpg');
		expect(moved).toContain('/image/6MB/deleted/');
		expect(existsSync(`${ROOT}/image/6MB/test99_test3_5.jpg`)).toBe(false);
	});

	test.if(HAVE_MAGICK)('delete_quality removes every extension of a quality', async () => {
		const id9: MediaIdentity = { ...identity, sectionId: 9 };
		// Two extensions of the same quality (jpg default + png alternate) on disk.
		await makeImage('/image/1.5MB/test99_test3_9.jpg', '120x90');
		await makeImage('/image/1.5MB/test99_test3_9.png', '120x90');
		// Both are seen by the scanner before deletion.
		const before = getFilesInfoCore(image, id9, pathOpts).filter((e) => e.quality === '1.5MB');
		expect(before.map((e) => e.extension).sort()).toEqual(['jpg', 'png']);
		// delete_quality moves BOTH into deleted/.
		const moved = deleteQualityCore(image, id9, pathOpts, '1.5MB');
		expect(moved.length).toBe(2);
		expect(existsSync(`${ROOT}/image/1.5MB/test99_test3_9.jpg`)).toBe(false);
		expect(existsSync(`${ROOT}/image/1.5MB/test99_test3_9.png`)).toBe(false);
		expect(getFilesInfoCore(image, id9, pathOpts).some((e) => e.quality === '1.5MB')).toBe(false);
	});

	test.if(HAVE_MAGICK)(
		'rotate (media_versions) rotates only the named quality, never the original',
		async () => {
			const id10: MediaIdentity = { ...identity, sectionId: 10 };
			await makeImage('/image/original/test99_test3_10.jpg', '400x300');
			await makeImage('/image/1.5MB/test99_test3_10.jpg', '400x300');
			const origBefore = await getDimensions(`${ROOT}/image/original/test99_test3_10.jpg`);
			const outcome = await rotateVersionCore(image, id10, pathOpts, '1.5MB', 90);
			expect(outcome.ok).toBe(true);
			expect(outcome.errors).toEqual([]);
			// the named tier swapped W/H; the original is untouched (Original law).
			const webAfter = await getDimensions(`${ROOT}/image/1.5MB/test99_test3_10.jpg`);
			expect(Math.abs(webAfter.width - 300)).toBeLessThanOrEqual(2);
			expect(await getDimensions(`${ROOT}/image/original/test99_test3_10.jpg`)).toEqual(origBefore);
		},
	);

	test('rotate rejects a non-image model, conform_headers a non-av model', async () => {
		await expect(rotateVersionCore(av, identity, pathOpts, '404', 90)).rejects.toThrow(
			/only supported/,
		);
		await expect(conformHeadersCore(image, identity, pathOpts, '1.5MB')).rejects.toThrow(
			/only supported/,
		);
		// Both are the SAME registered caller fact — a 400 the panel can render,
		// not an untyped throw that reaches the wire as "unexpected" (ERRORS_SPEC §1).
		expect((await refusalOf(rotateVersionCore(av, identity, pathOpts, '404', 90))).code).toBe(
			'media.unsupported_operation',
		);
		expect((await refusalOf(conformHeadersCore(image, identity, pathOpts, '1.5MB'))).code).toBe(
			'media.unsupported_operation',
		);
	});

	test.if(HAVE_FFMPEG)(
		'conform_headers remuxes the av quality and preserves the original as *_untouched',
		async () => {
			const avId: MediaIdentity = {
				componentTipo: 'test94',
				sectionTipo: 'test3',
				sectionId: 7,
				lang: null,
			};
			await makeMp4('/av/404/test94_test3_7.mp4');
			const ok = await conformHeadersCore(av, avId, pathOpts, '404');
			expect(ok).toBe(true);
			// the conformed file remains at the source path…
			expect(existsSync(`${ROOT}/av/404/test94_test3_7.mp4`)).toBe(true);
			// …and the pre-conform file is preserved untouched, temp cleaned up.
			expect(existsSync(`${ROOT}/av/404/test94_test3_7_untouched.mp4`)).toBe(true);
			expect(existsSync(`${ROOT}/av/404/test94_test3_7_temp.mp4`)).toBe(false);
		},
	);
});

describe('tool_image_rotation core', () => {
	test.if(HAVE_MAGICK)('rotates non-original tiers, never the original', async () => {
		await makeImage('/image/original/test99_test3_8.jpg', '400x300');
		await makeImage('/image/1.5MB/test99_test3_8.jpg', '400x300');
		const id8: MediaIdentity = { ...identity, sectionId: 8 };
		const origBefore = await getDimensions(`${ROOT}/image/original/test99_test3_8.jpg`);
		const result = await applyRotationCore(
			image,
			id8,
			pathOpts,
			[
				{ quality: 'original', extension: 'jpg', file_exist: true },
				{ quality: '1.5MB', extension: 'jpg', file_exist: true },
			],
			{ degrees: 90, mode: 'expanded' },
		);
		expect(result.errors).toEqual([]);
		expect(result.rotated.some((p) => p.includes('1.5MB'))).toBe(true);
		expect(result.rotated.some((p) => p.includes('original'))).toBe(false); // original untouched
		// the 1.5MB tier swapped W/H after a 90° expanded rotate (±2px distort
		// interpolation padding — realistic parity, not byte-equality).
		const webAfter = await getDimensions(`${ROOT}/image/1.5MB/test99_test3_8.jpg`);
		expect(Math.abs(webAfter.width - 300)).toBeLessThanOrEqual(2);
		expect(Math.abs(webAfter.height - 400)).toBeLessThanOrEqual(2);
		// original dims unchanged
		expect(await getDimensions(`${ROOT}/image/original/test99_test3_8.jpg`)).toEqual(origBefore);
	});

	// The client (render_tool_image_crop.update_crop_area) sends crop_area in
	// PIXELS of the default-quality file it previews. MEDIA_SPEC §tools: the crop
	// is "proportional […] computed from the default-quality reference
	// dimensions" — so the box must be divided by the reference dims and
	// re-scaled per tier, never fed to ImageMagick as if it were a 0..1 fraction.
	test.if(HAVE_MAGICK)('crops every non-original tier from default-quality pixels', async () => {
		const id11: MediaIdentity = { ...identity, sectionId: 11 };
		await makeImage('/image/original/test99_test3_11.jpg', '800x600');
		await makeImage(`/image/${image.defaultQuality}/test99_test3_11.jpg`, '400x300');
		await makeImage('/image/thumb/test99_test3_11.jpg', '200x150');
		const result = await applyRotationCore(
			image,
			id11,
			pathOpts,
			[
				{ quality: 'original', extension: 'jpg', file_exist: true },
				{ quality: image.defaultQuality, extension: 'jpg', file_exist: true },
				{ quality: 'thumb', extension: 'jpg', file_exist: true },
			],
			// left half / top half of the 400x300 reference tier
			{ degrees: 0, cropArea: { x: 0, y: 0, width: 200, height: 150 } },
		);
		expect(result.errors).toEqual([]);
		expect(result.cropped.some((p) => p.includes('original'))).toBe(false); // original untouched
		expect(await getDimensions(`${ROOT}/image/original/test99_test3_11.jpg`)).toEqual({
			width: 800,
			height: 600,
		});
		// reference tier: exactly the requested pixel box
		expect(
			await getDimensions(`${ROOT}/image/${image.defaultQuality}/test99_test3_11.jpg`),
		).toEqual({ width: 200, height: 150 });
		// thumb tier: the SAME proportion of its own (smaller) dimensions
		expect(await getDimensions(`${ROOT}/image/thumb/test99_test3_11.jpg`)).toEqual({
			width: 100,
			height: 75,
		});
	});

	// A box outside the reference frame is a caller bug, and ImageMagick would
	// answer it by silently clamping to a full-frame no-op. Refuse loudly.
	test.if(HAVE_MAGICK)('refuses a crop box outside the reference frame', async () => {
		const id12: MediaIdentity = { ...identity, sectionId: 12 };
		await makeImage(`/image/${image.defaultQuality}/test99_test3_12.jpg`, '400x300');
		const result = await applyRotationCore(
			image,
			id12,
			pathOpts,
			[{ quality: image.defaultQuality, extension: 'jpg', file_exist: true }],
			{ degrees: 0, cropArea: { x: 380, y: 10, width: 200, height: 150 } },
		);
		expect(result.cropped).toEqual([]);
		expect(result.errors.length).toBe(1);
		expect(result.errors[0]).toMatch(/falls outside/);
		// the tier is left exactly as it was
		expect(
			await getDimensions(`${ROOT}/image/${image.defaultQuality}/test99_test3_12.jpg`),
		).toEqual({ width: 400, height: 300 });
	});
});

describe('tool_pdf_extractor core', () => {
	test.if(HAVE_GS)('extracts text from the web-quality PDF', async () => {
		await makePdf('/pdf/web/test85_test3_5.pdf');
		const text = await extractPdfCore(
			pdf,
			{ componentTipo: 'test85', sectionTipo: 'test3', sectionId: 5, lang: null },
			pathOpts,
			{ method: 'text' },
		);
		expect(text).toContain('WORLD');
	});
});

/**
 * Handler-level ARGUMENT VALIDATION for the destructive media actions (audit
 * 2026-07-28). Every one of these resolves its media context from the DB and
 * then bails BEFORE touching the filesystem, so the drive is read-only — which
 * is exactly the property being pinned: a malformed destructive request must
 * fail on the argument, never half-run. The gates themselves are declarative
 * and asserted in the surface test below.
 */
describe('media tool handlers reject malformed destructive requests', () => {
	const principal: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };
	const IMAGE = { tipo: 'test99', section_tipo: 'test3', section_id: 1 };
	const AV = { tipo: 'test94', section_tipo: 'test3', section_id: 1 };

	async function drive(
		toolName: string,
		action: string,
		options: Record<string, unknown>,
	): Promise<unknown> {
		const loaded = await getLoadedTool(toolName);
		const spec = loaded?.module.apiActions[action];
		if (spec === undefined) throw new Error(`missing action ${toolName}.${action}`);
		return spec.handler({ principal, userId: -1, options, background: false });
	}

	/** The refusal a malformed destructive request throws (ERRORS_SPEC §4). */
	async function refuse(
		toolName: string,
		action: string,
		options: Record<string, unknown>,
	): ReturnType<typeof refusalOf> {
		return refusalOf(drive(toolName, action, options));
	}

	test('tool_media_versions: a delete without a quality is refused', async () => {
		for (const [action, sentence] of [
			['delete_quality', 'delete_quality: missing quality'],
			['delete_version', 'delete_version: missing quality'],
		] as const) {
			const refusal = await refuse('tool_media_versions', action, IMAGE);
			expect(refusal.code).toBe('request.invalid_options');
			expect(refusal.publicMessage).toBe(sentence);
		}
	});

	test('tool_media_versions: conform_headers without a quality is refused', async () => {
		const refusal = await refuse('tool_media_versions', 'conform_headers', AV);
		expect(refusal.code).toBe('request.invalid_options');
		expect(refusal.publicMessage).toBe('conform_headers: missing quality');
	});

	test('tool_media_versions: rotate needs both a quality and finite degrees', async () => {
		const cases: [Record<string, unknown>, string][] = [
			[IMAGE, 'rotate: missing quality'],
			[{ ...IMAGE, quality: '1.5MB' }, 'rotate: missing degrees'],
			[{ ...IMAGE, quality: '1.5MB', degrees: 'x' }, 'rotate: invalid degrees'],
		];
		for (const [options, sentence] of cases) {
			const refusal = await refuse('tool_media_versions', 'rotate', options);
			expect(refusal.code).toBe('request.invalid_options');
			expect(refusal.publicMessage).toBe(sentence);
		}
	});

	test('every media_versions action refuses a non-media component', async () => {
		for (const action of [
			'get_files_info',
			'build_version',
			'sync_files',
			'delete_version',
			'delete_quality',
			'conform_headers',
			'rotate',
		]) {
			// test17 is a component_text_area — the media context resolve must refuse
			// it. That refusal is still an UNTYPED engine throw (tool_support.ts is
			// a different sweep), so it reaches the chokepoint as internal.unexpected
			// instead of a body the handler dresses up as a result.
			expect(
				drive('tool_media_versions', action, {
					tipo: 'test17',
					section_tipo: 'test3',
					section_id: 1,
					quality: '1.5MB',
					degrees: 90,
				}),
			).rejects.toThrow(/is not a media component/);
		}
	});

	test('tool_image_rotation refuses a non-image component before any write', async () => {
		const refusal = await refuse('tool_image_rotation', 'apply_rotation', {
			...AV,
			rotation_degrees: 90,
		});
		expect(refusal.code).toBe('tool.unsupported_target');
		expect(refusal.publicMessage).toBe('Rotation is image-only');
	});
});

describe('media tool server modules load with the right surface', () => {
	test('tool_media_versions exposes the versions actions with record gates', async () => {
		const loaded = await getLoadedTool('tool_media_versions');
		expect(loaded).toBeDefined();
		const actions = loaded!.module.apiActions;
		expect(Object.keys(actions).sort()).toEqual(
			[
				'build_version',
				'conform_headers',
				'delete_quality',
				'delete_version',
				'get_files_info',
				'get_job_status',
				'rotate',
				'sync_files',
			].sort(),
		);
		expect(actions.build_version!.permission).toBe('record_tipo');
		expect(actions.build_version!.minLevel).toBe(2);
		expect(actions.get_files_info!.minLevel).toBe(1);
		// get_job_status polls the transcode build_version minted. permission null
		// is the shared MEDIA_JOB_STATUS_ACTION posture (tool_upload mounts the same
		// spec): dispatch gates 1-4 already require a caller authorized for this
		// tool, and the handler applies the job-record ownership rule itself. Pinned
		// here so mounting it can never be mistaken for an ungated door.
		expect(actions.get_job_status!.permission).toBeNull();
		// component-specific mutations are WRITE-gated like the rest.
		expect(actions.conform_headers!.minLevel).toBe(2);
		expect(actions.rotate!.minLevel).toBe(2);
		// build_version is the ONLY background-runnable action: the gate runs
		// before the fork, so anything added here must stay permission-gated.
		expect(loaded!.module.backgroundRunnable).toEqual(['build_version']);
		// every mutating action is level 2; only the read is level 1.
		for (const action of [
			'build_version',
			'sync_files',
			'delete_version',
			'delete_quality',
			'conform_headers',
			'rotate',
		]) {
			expect(actions[action]?.permission).toBe('record_tipo');
			expect(actions[action]?.minLevel).toBe(2);
		}
	});

	test('tool_image_rotation + tool_pdf_extractor load', async () => {
		const rot = await getLoadedTool('tool_image_rotation');
		expect(rot?.module.apiActions.apply_rotation?.minLevel).toBe(2);
		expect(rot?.module.apiActions.apply_rotation?.permission).toBe('record_tipo');
		expect(rot?.module.backgroundRunnable).toBeUndefined();
		const pdfTool = await getLoadedTool('tool_pdf_extractor');
		expect(pdfTool?.module.apiActions.get_pdf_data?.permission).toBe('record_tipo');
		expect(pdfTool?.module.apiActions.get_pdf_data?.minLevel).toBe(1);
	});
});

/**
 * THE SVG ENVELOPE GOES WITH THE LAST FILE, AND ONLY THEN (policy 2026-10-23).
 *
 * The envelope is the record's picture wrapper, not a quality file. Deleting one
 * tier — even the default one — leaves a picture somewhere in the ladder, so the
 * wrapper stays; only when the record holds NO file of ANY quality is it retired,
 * and it is MOVED to the `svg/…/deleted/` folder like every other media delete
 * (restorable), never unlinked.
 *
 * Reported symptom that motivated the rule: after removing every quality of
 * rsc29_rsc170_463937 the envelope survived with a dead `<image>` href and the
 * browser painted a broken-image icon inside it.
 */
describe.if(HAVE_MAGICK)('the SVG envelope is retired only with the LAST media file', () => {
	test('any surviving tier keeps it; the last delete moves it to deleted/', async () => {
		const id31: MediaIdentity = { ...identity, sectionId: 31 };
		const higher = image.qualities.find(
			(quality) =>
				!image.masterQualities.includes(quality) &&
				quality !== image.defaultQuality &&
				quality !== config.media.thumb.quality,
		);
		if (higher === undefined) throw new Error('this ladder has no higher derived tier');

		// A picture in three tiers: master, default and one higher derivative.
		await makeImage(`/image/${image.originalQuality}/test99_test3_31.jpg`, '1200x900');
		await makeImage(`/image/${image.defaultQuality}/test99_test3_31.jpg`, '1200x900');
		await makeImage(`/image/${higher}/test99_test3_31.jpg`, '1200x900');
		const overlay = await createDefaultSvgFile(image, id31, pathOpts);
		expect(overlay).not.toBeNull();
		const live = svgOverlayLocation(image, id31, pathOpts).absolutePath;

		// The DEFAULT tier first: the master and the higher tier still hold the
		// picture, so the wrapper must survive.
		await deleteAndResyncCore(image, id31, pathOpts, image.defaultQuality, null);
		expect(existsSync(live)).toBe(true);

		// Same for the higher tier — the original is still there.
		await deleteAndResyncCore(image, id31, pathOpts, higher, null);
		expect(existsSync(live)).toBe(true);

		// The LAST file: the wrapper is retired to the envelope's own deleted/ folder.
		const outcome = await deleteAndResyncCore(image, id31, pathOpts, image.originalQuality, null);
		expect(existsSync(live)).toBe(false);
		expect(
			outcome.moved.some(
				(path) =>
					path.includes('/image/svg/') && path.includes('_deleted_') && path.endsWith('.svg'),
			),
		).toBe(true);
		expect(baseSvgUrl(image, id31, pathOpts)).toBeNull();
	});
});
