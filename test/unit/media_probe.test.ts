/**
 * IMAGE SOURCE PROBE gate — `src/core/media/engine/probe.ts` against REAL files.
 *
 * The probe is the abstraction every image recipe now decides on: how many images
 * a source holds, what canvas they occupy, and whether the source declares its own
 * representative image (scene 0 full-frame at +0+0) or has to be composited. Get
 * that wrong and a layered/paged/animated source either splits into `<stem>-N.jpg`
 * or collapses to the WRONG image — a multi-page TIFF flattened to page 3, an
 * animated GIF to its last frame.
 *
 * So this file builds one real fixture per source CLASS with ImageMagick and
 * asserts the classification. Synthetic byte-level fixtures cannot be used here:
 * the whole subject is what ImageMagick reports about a real container.
 *
 * Skipped honestly (`test.if(HAVE_MAGICK)`) when the binary is absent — same idiom
 * as media_processing.test.ts.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolveMagick } from '../../src/core/media/engine/imagemagick.ts';
import {
	canCarryMetaChannel,
	probeContentSpread,
	probeImageSource,
	probeMetaChannels,
} from '../../src/core/media/engine/probe.ts';
import { runBinary } from '../../src/core/media/engine/spawn.ts';
import { magickTestEnv } from '../helpers/magick_test_env.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const ROOT = scratchDir('media_probe');
const HAVE_MAGICK = existsSync(resolveMagick());

/** Run a real `magick` command building a fixture; a failure must be loud. */
async function magick(args: string[]): Promise<void> {
	const result = await runBinary([resolveMagick(), ...args], { nice: false, env: magickTestEnv() });
	if (result.exitCode !== 0) {
		throw new Error(`fixture build failed (exit ${String(result.exitCode)}): ${result.stderr}`);
	}
}

const path = (name: string): string => `${ROOT}/${name}`;

beforeAll(async () => {
	if (!HAVE_MAGICK) return;
	mkdirSync(ROOT, { recursive: true });

	// 1. LAYERED — the reported class (Photoshop-layered master): a full-canvas
	//    composite as scene 0, then two smaller layers at page OFFSETS. Written as
	//    PSD because TIFF does not preserve the per-scene offset on write, and the
	//    offsets are the half of this class that makes it interesting.
	await magick([
		'-size',
		'200x150',
		'xc:#cc8844',
		'(',
		'-size',
		'60x40',
		'xc:blue',
		'-repage',
		'200x150+31+31',
		')',
		'(',
		'-size',
		'50x30',
		'xc:green',
		'-repage',
		'200x150+100+90',
		')',
		path('layered.psd'),
	]);

	// 1b. The same shape in the container the 2026-08-04 import actually failed on.
	await magick([
		'-size',
		'200x150',
		'xc:#cc8844',
		'(',
		'-size',
		'60x40',
		'xc:blue',
		')',
		'(',
		'-size',
		'50x30',
		'xc:green',
		')',
		path('layered.tif'),
	]);

	// 2. PAGED — a 3-page TIFF. Every page is full-canvas, so page 1 IS the
	//    representative image. (A blanket `-flatten` here yields page 3.)
	await magick([
		'-size',
		'200x150',
		'xc:#cc8844',
		'-size',
		'200x150',
		'xc:#448844',
		'-size',
		'200x150',
		'xc:#4488cc',
		path('paged.tif'),
	]);

	// 3. ANIMATED — full-canvas GIF frames. (A blanket `-flatten` yields the LAST
	//    frame.)
	await magick([
		'-size',
		'200x150',
		'xc:#cc8844',
		'-size',
		'200x150',
		'xc:#4488cc',
		'-delay',
		'20',
		path('animated.gif'),
	]);

	// 4. DELTA-FRAME — `-layers optimize` reduces frame 2 to the changed rectangle
	//    at an offset. Frame 1 stays full-canvas, so it is still representative.
	//    (A blanket `-flatten` yields a stack matching NO frame.)
	await magick([
		'-size',
		'200x150',
		'xc:#cc8844',
		'(',
		'-clone',
		'0',
		'-fill',
		'blue',
		'-draw',
		'rectangle 10,10 40,40',
		')',
		'-layers',
		'optimize',
		path('delta.gif'),
	]);

	// 5. OFFSET-PAGE — a scene that does not span its page: 60x40 repaged into a
	//    200x150 page at +70+55. Built twice, because the two variants answer
	//    different questions:
	//      a) single-scene (png) — does the CANVAS follow the page rather than the
	//         raster? The resize budget and the SVG envelope read that number.
	//      b) multi-scene (gif) — is the source refused a representative scene when
	//         scene 0 is only a sub-rectangle? That is the composite fallback's one
	//         trigger, and the GIF container is the one that preserves the offset on
	//         write (TIFF drops it, the PSD writer normalises scene 0 to +0+0).
	await magick(['-size', '60x40', 'xc:blue', '-repage', '200x150+70+55', path('offset.png')]);
	await magick([
		'(',
		'-size',
		'60x40',
		'xc:blue',
		'-repage',
		'200x150+70+55',
		')',
		'(',
		'-size',
		'50x30',
		'xc:green',
		'-repage',
		'200x150+10+10',
		')',
		path('offset_layers.gif'),
	]);

	// 5b. MIXED-SIZE PAGES — a bound volume with a landscape fold-out: page 1
	//     600x800, page 2 800x600. Ordinary in a heritage archive, and the case
	//     that proves the canvas is scene 0's PAGE and not a union across scenes.
	//     Measured on IM 7.1.2: `magick mixed_pages.tif -background white -flatten`
	//     writes 600x800 with page 2 STAMPED OVER page 1 — AE 360000 px against
	//     page 1 alone, 75 % of the frame. So a rule that sent this to the
	//     composite branch would corrupt the derivative, and a canvas of 800x800
	//     would describe no file at all.
	await magick([
		'-size',
		'600x800',
		'xc:#448844',
		'-size',
		'800x600',
		'xc:#cccc44',
		path('mixed_pages.tif'),
	]);

	// 5c. SMALL IMAGE 0 — a 160x120 image ahead of the 2000x1500 master, the shape
	//     a scanner writes when it stores a reduced-resolution preview first.
	await magick([
		'-size',
		'160x120',
		'xc:#cc8844',
		'-size',
		'2000x1500',
		'xc:#4488cc',
		path('preview_first.tif'),
	]);

	// 6. TRANSPARENT — fully transparent alpha over a RED raster. This is the
	//    measured proof that alpha is not cosmetic: a bare JPEG encode drops the
	//    plane and keeps the hidden red (srgb(254,0,0)), which is why every recipe
	//    carries `-background <bg> -flatten`.
	await magick([
		'-size',
		'100x100',
		'xc:red',
		'-alpha',
		'set',
		'-channel',
		'A',
		'-evaluate',
		'set',
		'0',
		'+channel',
		path('hidden.png'),
	]);

	// 6b. PLAIN JPEG — the ordinary single-image case, the one that must never take
	//     the meta-channel branch (the fx would write no file at all).
	await magick(['-size', '120x90', 'xc:#3366aa', path('flat.jpg')]);

	// 7. META CHANNEL — a red raster carrying its mask as a TIFF EXTRA SAMPLE
	//    (`| gray=>meta0` appends the second image's gray plane as meta0), which is
	//    exactly how Photoshop stores a saved selection. Left half of the mask is
	//    white (keep), right half black (cut).
	//
	//    VERIFIED before it was asserted on (a fixture that is secretly 3.0 makes
	//    this gate green for the wrong reason):
	//      magick identify -quiet -format '%[channels]' meta_channel.tif → 'srgb  4.1'
	//      magick identify -ping -quiet …                                → 'srgb  3.0'
	//    The second line is why the count has its own non-ping call: under -ping this
	//    fixture is indistinguishable from a plain RGB TIFF.
	await magick([
		'-size',
		'200x150',
		'xc:red',
		'(',
		'-size',
		'200x150',
		'xc:black',
		'-fill',
		'white',
		'-draw',
		'rectangle 0,0 99,149',
		')',
		'-channel-fx',
		'| gray=>meta0',
		path('meta_channel.tif'),
	]);
});

afterAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

describe('probeImageSource: source-shape classification per real source class', () => {
	test.if(HAVE_MAGICK)(
		'layered PSD: 3 scenes at offsets, canvas 200x150, representative',
		async () => {
			const probe = await probeImageSource(path('layered.psd'));
			expect(probe.sceneCount).toBe(3);
			expect(probe.scenes.length).toBe(3);
			// Every dimension is a NUMBER. ImageMagick does NOT interpret '\t' in a
			// -format string: '%w\t%h' on a 645x888 image prints '645t888', which parses
			// to NaN — and a NaN canvas silently disables the CMYK branch and the resize
			// budget instead of failing. The literal '|' separator is what keeps these
			// finite, so asserting exact numbers here is asserting the separator.
			for (const scene of probe.scenes) {
				expect(Number.isFinite(scene.width)).toBe(true);
				expect(Number.isFinite(scene.height)).toBe(true);
				expect(Number.isFinite(scene.pageX)).toBe(true);
			}
			expect(probe.canvasWidth).toBe(200);
			expect(probe.canvasHeight).toBe(150);
			// Scene 0 is the full-canvas composite; the layers sit at signed offsets
			// ('+31' arrives with an explicit leading '+' and must survive parsing).
			expect(probe.scenes[0]).toMatchObject({
				index: 0,
				width: 200,
				height: 150,
				pageX: 0,
				pageY: 0,
			});
			expect(probe.scenes[1]).toMatchObject({
				index: 1,
				width: 60,
				height: 40,
				pageX: 31,
				pageY: 31,
			});
			expect(probe.scenes[2]).toMatchObject({
				index: 2,
				width: 50,
				height: 30,
				pageX: 100,
				pageY: 90,
			});
			// The canvas is scene 0's PAGE box: `-flatten` composites onto the first
			// image's page (measured), so neither `pageX + pageWidth` (300 here) nor a
			// union across the layers describes the file that gets written.
			expect(probe.hasRepresentativeScene).toBe(true);
		},
	);

	test.if(HAVE_MAGICK)(
		'layered TIFF (the reported container): 3 scenes, representative',
		async () => {
			const probe = await probeImageSource(path('layered.tif'));
			expect(probe.sceneCount).toBe(3);
			expect(probe.canvasWidth).toBe(200);
			expect(probe.canvasHeight).toBe(150);
			expect(probe.hasRepresentativeScene).toBe(true);
		},
	);

	test.if(HAVE_MAGICK)('multi-page TIFF: 3 scenes, representative = page 1', async () => {
		const probe = await probeImageSource(path('paged.tif'));
		expect(probe.sceneCount).toBe(3);
		expect(probe.canvasWidth).toBe(200);
		expect(probe.canvasHeight).toBe(150);
		// True here means the recipe takes page 1. A blanket `-flatten` would take
		// page 3 — measurably the wrong page, and one of the two classes that
		// disqualified v6's collapse operator.
		expect(probe.hasRepresentativeScene).toBe(true);
	});

	test.if(HAVE_MAGICK)('animated GIF: 2 full-canvas frames, representative = frame 1', async () => {
		const probe = await probeImageSource(path('animated.gif'));
		expect(probe.sceneCount).toBe(2);
		expect(probe.canvasWidth).toBe(200);
		expect(probe.canvasHeight).toBe(150);
		expect(probe.hasRepresentativeScene).toBe(true);
	});

	test.if(HAVE_MAGICK)(
		'delta-frame GIF: frame 2 is a repaged sub-rectangle, frame 1 still spans the canvas',
		async () => {
			const probe = await probeImageSource(path('delta.gif'));
			expect(probe.sceneCount).toBe(2);
			// The optimizer reduced frame 2 to the changed region at an offset; the
			// canvas must still describe the FILE, not that rectangle.
			expect(probe.scenes[1]?.width).toBeLessThan(200);
			expect(probe.scenes[1]?.pageX).toBeGreaterThan(0);
			expect(probe.canvasWidth).toBe(200);
			expect(probe.canvasHeight).toBe(150);
			expect(probe.hasRepresentativeScene).toBe(true);
		},
	);

	test.if(HAVE_MAGICK)(
		'offset-page PNG: the CANVAS is the page, not the 60x40 raster',
		async () => {
			const probe = await probeImageSource(path('offset.png'));
			expect(probe.sceneCount).toBe(1);
			expect(probe.scenes[0]).toMatchObject({ width: 60, height: 40, pageX: 70, pageY: 55 });
			// %W/%H is the WHOLE page and %X/%Y the scene's offset INSIDE it, so the
			// canvas is the PAGE — 200x150, not 60x40 (the resize budget and the SVG
			// envelope both read this) and not 270x205 (`pageX + pageWidth`). Measured:
			// `magick offset.png[0] -background white -flatten` writes exactly 200x150.
			expect(probe.canvasWidth).toBe(200);
			expect(probe.canvasHeight).toBe(150);
			// A ONE-image source is representative by definition, offset page or not:
			// measured on this fixture, `magick offset.png[0] -background #ffffff
			// -flatten` and the same recipe without the `[0]` differ by AE 0 — there is
			// no second image for the selector to choose between.
			expect(probe.hasRepresentativeScene).toBe(true);
		},
	);

	test.if(HAVE_MAGICK)(
		'offset-page SEQUENCE: scene 0 is a sub-rectangle → NOT representative',
		async () => {
			const probe = await probeImageSource(path('offset_layers.gif'));
			expect(probe.sceneCount).toBe(2);
			expect(probe.scenes[0]).toMatchObject({ width: 60, height: 40, pageX: 70, pageY: 55 });
			expect(probe.canvasWidth).toBe(200);
			expect(probe.canvasHeight).toBe(150);
			// The composite fallback's ONE trigger: the source declares no full-frame
			// image, so taking `[0]` would ship a 60x40 corner as the whole record.
			// Every other class in this file is representative, which is why this case
			// has to exist — without it the predicate could be a constant `true`.
			expect(probe.hasRepresentativeScene).toBe(false);
		},
	);

	test.if(HAVE_MAGICK)(
		'mixed-size pages: the canvas is PAGE 1, and page 1 is still representative',
		async () => {
			const probe = await probeImageSource(path('mixed_pages.tif'));
			expect(probe.sceneCount).toBe(2);
			// Page 1's box, NOT the 800x800 union of the two pages: `-flatten`
			// composites onto the FIRST image's page (measured), so a union is a number
			// no file ever has — it would inflate the resize budget and write an SVG
			// envelope larger than the raster it wraps.
			expect(probe.canvasWidth).toBe(600);
			expect(probe.canvasHeight).toBe(800);
			// And the source keeps its representative image: scene 0 is a full-frame
			// page. Requiring scene 0's page to equal a cross-scene union (the shape
			// this file gated before 2026-08-04's review) sent this class to the
			// composite branch, where flatten stamps page 2 over page 1.
			expect(probe.hasRepresentativeScene).toBe(true);
		},
	);

	test.if(HAVE_MAGICK)(
		'a small image 0 ahead of a large one is still image 0 (the reduced-preview limit)',
		async () => {
			const probe = await probeImageSource(path('preview_first.tif'));
			expect(probe.sceneCount).toBe(2);
			expect(probe.canvasWidth).toBe(160);
			expect(probe.canvasHeight).toBe(120);
			// KNOWN-OPEN, asserted so the limit is visible rather than implied: geometry
			// cannot tell "page 1 is small" from "image 0 is a reduced-resolution PREVIEW
			// IFD", so both take image 0 and a preview-first master yields a small
			// derivative. Compositing instead is NOT the answer — measured, `-flatten`
			// on this exact fixture also writes 160x120 (it collapses onto image 0's
			// page) while the probe would have claimed a 2000x1500 canvas: same small tier,
			// plus a desynchronised envelope. The honest fix is the TIFF subfiletype tag
			// (`%[tiff:subfiletype]`), and no real REDUCEDIMAGE file exists here to
			// verify it against.
			expect(probe.hasRepresentativeScene).toBe(true);
		},
	);

	test.if(HAVE_MAGICK)(
		'transparent PNG: alpha layout is reported despite the depth suffix',
		async () => {
			const probe = await probeImageSource(path('hidden.png'));
			expect(probe.sceneCount).toBe(1);
			expect(probe.canvasWidth).toBe(100);
			expect(probe.canvasHeight).toBe(100);
			expect(probe.hasRepresentativeScene).toBe(true);
			// ImageMagick 7.1.2 reports %[channels] as the layout PLUS the depth —
			// 'srgba 4.0'. Keeping the raw field would make `endsWith('a')` false for
			// every alpha image, i.e. the flag would never fire.
			expect(probe.scenes[0]?.channels).toBe('srgba');
			expect(probe.scenes[0]?.hasAlpha).toBe(true);
			expect(/cmyk/i.test(probe.colorspace)).toBe(false);
		},
	);

	test.if(HAVE_MAGICK)('an opaque source reports no alpha (the flag discriminates)', async () => {
		const probe = await probeImageSource(path('paged.tif'));
		expect(probe.scenes[0]?.hasAlpha).toBe(false);
		expect(probe.scenes[0]?.channels).not.toContain(' ');
	});

	/**
	 * META CHANNELS — the 2026-08-04 medal defect. Photoshop writes the mask as a
	 * TIFF extra sample; ImageMagick renders it opaque, so without promoting it the
	 * retouch paint outside the medal silhouette survived into every tier.
	 *
	 * THE COUNT IS DELIBERATELY NOT A FIELD OF `SceneInfo`. `probeImageSource` runs
	 * `-ping`, which reports this very fixture as `srgb 3.0` — a scene field would
	 * therefore read 0 for a file that has a meta channel, i.e. it could only be a
	 * confident lie. The count is its own opt-in call that pays a full pixel decode
	 * (measured 7.23 s / 14.4 GB RSS on a 40000x30000 TIFF, which is why every other
	 * caller in the engine keeps `-ping`).
	 */
	test.if(HAVE_MAGICK)('a TIFF extra sample is counted by probeMetaChannels', async () => {
		expect((await probeMetaChannels(path('meta_channel.tif'))).metaChannels).toBe(1);
		const probe = await probeImageSource(path('meta_channel.tif'));
		// The `-ping` probe still parses the LAYOUT token correctly...
		expect(probe.scenes[0]?.channels).toBe('srgb');
		// ...and still reports alpha correctly (alpha survives -ping; meta does not).
		expect(probe.scenes[0]?.hasAlpha).toBe(false);
		// ...and the format is what gates the expensive count.
		expect(probe.format).toBe('TIFF');
		expect(canCarryMetaChannel(probe)).toBe(true);
	});

	test.if(HAVE_MAGICK)('ordinary sources count 0 meta channels — the fx stays off', async () => {
		// `-channel-fx meta0=>alpha` HARD-FAILS and writes NO FILE when meta0 is
		// absent, so a false positive here would break every ordinary image.
		for (const fixture of ['flat.jpg', 'paged.tif', 'hidden.png', 'animated.gif']) {
			expect([fixture, (await probeMetaChannels(path(fixture))).metaChannels]).toEqual([
				fixture,
				0,
			]);
		}
	});

	/**
	 * THE FORMAT COMES FROM THE FILE'S CONTENT, NOT ITS NAME — which is what makes
	 * it safe to gate the meta-channel decode on. An upload's extension is
	 * accident- and attacker-controlled; its magic bytes are what ImageMagick acts
	 * on. A TIFF renamed `.jpg` must still be recognised as a possible mask carrier.
	 */
	test.if(HAVE_MAGICK)(
		'probe.format is content-detected, so a mislabelled TIFF is caught',
		async () => {
			copyFileSync(path('meta_channel.tif'), path('mislabelled.jpg'));
			const probe = await probeImageSource(path('mislabelled.jpg'));
			expect(probe.format).toBe('TIFF');
			expect(canCarryMetaChannel(probe)).toBe(true);
			// And a real JPEG is correctly excluded, so it never pays the decode.
			const flat = await probeImageSource(path('flat.jpg'));
			expect(flat.format).toBe('JPEG');
			expect(canCarryMetaChannel(flat)).toBe(false);
		},
	);

	/**
	 * `-ping` IS A TRIPWIRE, NOT A PREFERENCE — a stated invariant needs a mechanical
	 * gate, and this one cannot be caught behaviourally: dropping `-ping` changes NO
	 * value this probe returns, it only makes ImageMagick decode every pixel.
	 * Measured cost of losing it: 1.04 s / 2.3 GB RSS on a 192 MP TIFF and
	 * 7.23 s / 14.4 GB RSS on a 40000x30000 one — per call, on a function that runs
	 * on every derivative build, inside runMagickTo on every output written, and on
	 * the authenticated upload request path.
	 *
	 * A previous change removed it (to reach the meta-channel count, which is real
	 * but has its own opt-in call now). This gate is what makes that a deliberate act
	 * rather than an invisible one.
	 */
	test('probeImageSource asks identify for a HEADER READ (-ping)', async () => {
		const source = await Bun.file(
			new URL('../../src/core/media/engine/probe.ts', import.meta.url).pathname,
		).text();
		const call = source.slice(source.indexOf('const result = await runIdentify('));
		expect(call.slice(0, call.indexOf(')'))).toContain("'-ping'");
	});

	/**
	 * The blank-derivative safety net's measuring instrument. It MUST be read off a
	 * written derivative: `%[fx:standard_deviation]` counts the meta channel itself
	 * when one is still present, and the meta channel is the mask, which has plenty
	 * of variance — measured 0.106 inline vs 0.0038 on the written jpg for the same
	 * inverted-mask source, i.e. the inline reading hides the very failure this
	 * measurement exists to catch.
	 */
	test.if(HAVE_MAGICK)('probeContentSpread separates a real picture from a blank one', async () => {
		const blank = path('uniform.png');
		await magick(['-size', '80x60', 'xc:white', blank]);
		expect(await probeContentSpread(blank)).toBe(0);
		const real = await probeContentSpread(path('flat.jpg'));
		// A flat colour jpg is also uniform; the gradient fixture is the picture.
		const gradient = path('spread.png');
		await magick(['-size', '80x60', 'gradient:black-white', gradient]);
		const spread = await probeContentSpread(gradient);
		expect(real).not.toBeNull();
		expect(spread).not.toBeNull();
		expect(spread as number).toBeGreaterThan(0.2);
	});

	test.if(HAVE_MAGICK)('colorspace and orientation are reported once, from scene 0', async () => {
		const probe = await probeImageSource(path('paged.tif'));
		// They repeat identically per scene in the report; the accessor must not
		// concatenate them (the same trap as %n printing '333' for a 3-scene file).
		expect(probe.colorspace).toBe('sRGB');
		expect(probe.orientation).toBe('TopLeft');
	});

	test.if(HAVE_MAGICK)(
		'an unreadable source THROWS — a probe never degrades silently',
		async () => {
			// Callers that are allowed to degrade (the RAG indexer, the staged-upload
			// thumbnail) catch it themselves and say so; the probe itself never returns a
			// zeroed shape, because a 0x0 canvas writes a blank derivative.
			await expect(probeImageSource(path('does_not_exist.tif'))).rejects.toThrow(/image probe/);
		},
	);
});
