/**
 * Phase A unit gate: the binary-adapter ARGV recipes + MIME sniffer + ffmpeg
 * profile table. These pin the PHP command shapes (engineering/MEDIA_SPEC.md §4) as
 * argv arrays WITHOUT spawning any binary — the recipe is the parity contract;
 * the actual binary output is gated in Phase C against ffprobe/identify.
 */
// NO INSTALL TLD IS BOUND HERE (checked 2026-08-19). The census entry for this
// file is a FALSE POSITIVE: the only token it matches is `libx264`, the ffmpeg
// H.264 ENCODER name, which is `<letters><digits>`-shaped and so indistinguishable
// from a tipo to scripts/lib/tld_census.ts. `libx` is not an ontology TLD and
// should leave INSTALL_TLDS; until it does, the entry stays frozen.

import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../../src/config/config.ts';
import {
	buildConformHeaderArgv,
	buildPosterframeArgv,
	buildTranscodePass1Argv,
	buildTranscodePass2Argv,
	standardFromFps,
} from '../../src/core/media/engine/ffmpeg.ts';
import {
	ffmpegProfileNames,
	getFfmpegProfile,
	settingName,
} from '../../src/core/media/engine/ffmpeg_profiles.ts';
import {
	backgroundForTarget,
	buildBilevelMaskArgv,
	buildConnectedComponentsArgv,
	buildConvertArgv,
	buildCropAndPadArgv,
	buildCropArgv,
	buildRotateArgv,
	buildThumbArgv,
	CMYK_SOURCE_PROFILE,
	coderToken,
	compressionForTarget,
	resolveMagick,
	SRGB_TARGET_PROFILE,
} from '../../src/core/media/engine/imagemagick.ts';
import { sniffAndValidate, sniffBytes } from '../../src/core/media/engine/mime.ts';
import { buildExtractArgv, buildOcrArgv } from '../../src/core/media/engine/pdf.ts';
import { verifyFileContent } from '../../src/core/media/engine/verify_content.ts';
import { magickTestEnv } from '../helpers/magick_test_env.ts';

describe('ffmpeg profiles (37 settings files → typed data)', () => {
	test('all 37 profiles present', () => {
		expect(ffmpegProfileNames().length).toBe(37);
	});

	test('404_pal_16x9 matches the PHP settings file verbatim', () => {
		const p = getFfmpegProfile('404_pal_16x9')!;
		expect(p.videoBitrate).toBe('1024k');
		expect(p.scale).toBe('720x404');
		expect(p.gop).toBe(25);
		expect(p.videoCodec).toBe('libx264');
		expect(p.audioRate).toBe(44100);
		expect(p.audioBitrate).toBe('64k');
		expect(p.audioChannels).toBe(1);
		expect(p.force).toBe('mp4');
		expect(p.targetPath).toBe('404');
		// One ordered chain of bare specs: deinterlace FIRST, then gamma.
		expect(p.videoFilters).toEqual([
			'yadif=deint=interlaced',
			'lutyuv=u=gammaval(1.01):v=gammaval(0.98):y=gammaval(0.97)',
		]);
	});

	test('1080i has NO deinterlace filter; audio tiers are video-null', () => {
		expect(getFfmpegProfile('1080i_pal')!.videoFilters).toEqual([
			'lutyuv=u=gammaval(1.01):v=gammaval(0.98):y=gammaval(0.97)',
		]);
		expect(getFfmpegProfile('audio')!.videoFilters).toEqual([]);
		const audio = getFfmpegProfile('audio')!;
		expect(audio.videoCodec).toBeNull();
		expect(audio.force).toBe('mp4');
		expect(getFfmpegProfile('audio_tr')!.force).toBe('wav');
	});

	test('setting_name derivation (get_setting_name)', () => {
		expect(settingName('404', 'pal', '16x9')).toBe('404_pal_16x9');
		expect(settingName('720', 'ntsc', null)).toBe('720_ntsc');
		expect(settingName('audio', 'pal', '16x9')).toBe('audio'); // audio ignores standard/aspect
	});

	test('standardFromFps: ≥29 → ntsc else pal', () => {
		expect(standardFromFps('30000/1001')).toBe('ntsc');
		expect(standardFromFps('25/1')).toBe('pal');
		expect(standardFromFps(undefined)).toBe('pal');
	});
});

describe('ffmpeg argv recipes (PHP class.Ffmpeg.php)', () => {
	test('two-pass pass1: -an -pass 1 … -passlogfile … -y /dev/null', () => {
		const argv = buildTranscodePass1Argv(getFfmpegProfile('404_pal_16x9')!, '/src.mov', '/log');
		const s = argv.join(' ');
		expect(s).toContain('-i /src.mov');
		expect(s).toContain('-an -pass 1');
		expect(s).toContain('-vcodec libx264');
		expect(s).toContain('-vb 1024k');
		expect(s).toContain('-s 720x404');
		expect(s).toContain('-g 25');
		expect(s).toContain(
			'-vf yadif=deint=interlaced,lutyuv=u=gammaval(1.01):v=gammaval(0.98):y=gammaval(0.97) -f mp4',
		);
		expect(s).toContain('-passlogfile /log');
		expect(argv[argv.length - 1]).toBe('/dev/null');
		// no shell tokens ever
		expect(argv).not.toContain('sh');
		expect(argv.some((t) => t.includes('"'))).toBe(false);
	});

	// ffmpeg honours only the LAST -vf of an output stream ("Multiple -filter/-af/-vf
	// options specified … only the last option … will be used"): PHP's recipe passed
	// '-vf yadif' and '-vf lutyuv=…' separately, so yadif was silently dropped and no
	// interlaced source was ever deinterlaced. Every video profile, both passes: ONE
	// -vf carrying the profile's whole chain, in order. Real-encode twin (the warning
	// and the deinterlace measured on output): media_deinterlace_native.test.ts.
	test('every video profile: exactly ONE -vf per pass, carrying the whole chain', () => {
		let videoProfiles = 0;
		for (const name of ffmpegProfileNames()) {
			const profile = getFfmpegProfile(name)!;
			if (profile.videoCodec === null) continue;
			videoProfiles++;
			for (const argv of [
				buildTranscodePass1Argv(profile, '/src.mov', '/log'),
				buildTranscodePass2Argv(profile, '/src.mov', '/log', '/tmp.mp4', 'aac'),
			]) {
				const flags = argv.filter(
					(t) => t === '-vf' || t.startsWith('-filter') || t === '-vfilter',
				);
				if (profile.videoFilters.length === 0) {
					expect(flags).toEqual([]);
					continue;
				}
				expect(flags).toEqual(['-vf']);
				const chain = argv[argv.indexOf('-vf') + 1]!;
				expect(chain).toBe(profile.videoFilters.join(','));
			}
			// The ladder's deinterlacing tiers carry BOTH filters, yadif first.
			if (!name.startsWith('1080i') && name !== '288_pal') {
				expect(profile.videoFilters[0]).toBe('yadif=deint=interlaced');
				expect(profile.videoFilters[1]).toStartWith('lutyuv=');
			}
		}
		expect(videoProfiles).toBe(35);
	});

	test('two-pass pass2 adds the audio track + temp target', () => {
		const argv = buildTranscodePass2Argv(
			getFfmpegProfile('404_pal_16x9')!,
			'/src.mov',
			'/log',
			'/tmp.mp4',
			'aac',
		);
		const s = argv.join(' ');
		expect(s).toContain('-pass 2');
		expect(s).toContain('-acodec aac');
		expect(s).toContain('-ar 44100');
		expect(s).toContain('-ab 64k');
		expect(s).toContain('-ac 1');
		// A failing pass 2 must report its ERROR line, not a stderr tail of banner
		// and per-frame stats (logging only: output bytes are unchanged).
		expect(s).toContain('-loglevel error -y /tmp.mp4');
		expect(argv[argv.length - 1]).toBe('/tmp.mp4');
	});

	test('posterframe: -ss <tc.3f> -i src -y -vframes 1 -f rawvideo -an -vcodec mjpeg -s WxH', () => {
		const argv = buildPosterframeArgv('/v.mp4', '12.5', '/poster.jpg', {
			width: 1280,
			height: 720,
		});
		const s = argv.join(' ');
		expect(s).toContain('-ss 12.500');
		expect(s).toContain('-vframes 1 -f rawvideo -an -vcodec mjpeg');
		expect(s).toContain('-s 1280x720');
		expect(argv[argv.length - 1]).toBe('/poster.jpg');
	});

	test('conform_header: -c:v copy -c:a copy', () => {
		expect(buildConformHeaderArgv('/s.mp4', '/t.mp4').join(' ')).toContain('-c:v copy -c:a copy');
	});
});

/**
 * SCENE SELECTION (2026-08-04). An image source can hold N images — Photoshop
 * layers, TIFF/PDF pages, GIF frames — and an argv that leaves N images in the
 * pipeline makes ImageMagick write `<stem>-0.jpg`, `<stem>-1.jpg`… and never the
 * bare target. So the recipes below are pinned as EXACT argv arrays rather than
 * `toContain` fragments: what matters is not that a token is present somewhere,
 * it is which image the recipe names and where the collapse operator sits
 * relative to the resize. A `toContain` set stays green while the scene selector
 * is missing, which is why this block asserts equality.
 */
describe('imagemagick argv recipes (PHP class.ImageMagick.php)', () => {
	const magick = resolveMagick();

	test('dd_thumb, representative scene: exact argv (SOURCE[0], flatten BEFORE -thumbnail)', () => {
		expect(
			buildThumbArgv('/s.tif', '/t.jpg', 222, 148, {
				selection: 'representative',
				background: '#ffffff',
			}),
		).toEqual([
			magick,
			'-define',
			'jpeg:size=400x400',
			'/s.tif[0]',
			'-background',
			'#ffffff',
			'-flatten',
			'-thumbnail',
			'222x148>',
			'-auto-orient',
			'-gravity',
			'center',
			'-unsharp',
			'0x.5',
			'-quality',
			'90',
			// THE OUTPUT TOKEN CARRIES ITS CODER (2026-08-07), never the bare path.
			'JPEG:/t.jpg',
		]);
	});

	test('dd_thumb, composite scene: byte-identical to representative minus the [0]', () => {
		const representative = buildThumbArgv('/s.tif', '/t.jpg', 222, 148, {
			selection: 'representative',
			background: '#ffffff',
		});
		const composite = buildThumbArgv('/s.tif', '/t.jpg', 222, 148, {
			selection: 'composite',
			background: '#ffffff',
		});
		// The ONLY difference is the source token: the collapse operator is the same
		// `-flatten` in both, so a source with no representative image still leaves
		// exactly one image in the pipeline.
		expect(composite).toEqual(
			representative.map((token) => (token === '/s.tif[0]' ? '/s.tif' : token)),
		);
		expect(composite).toContain('/s.tif');
		expect(composite).not.toContain('/s.tif[0]');
	});

	test('dd_thumb, cmyk: the ICC trio sits between the source token and -background', () => {
		const argv = buildThumbArgv('/s.tif', '/t.jpg', 222, 148, {
			selection: 'representative',
			background: '#ffffff',
			cmyk: true,
		});
		const source = argv.indexOf('/s.tif[0]');
		const background = argv.indexOf('-background');
		// THE PROFILES MUST BE REAL FILES. This branch named `engine/icc/…` while
		// that directory did not exist in the repo at all: measured, ImageMagick then
		// exits 1 with `unable to open image '…/Generic_CMYK_Profile.icc'` and writes
		// NOTHING, so every CMYK master lost its whole derivative ladder. An argv
		// assertion alone cannot see that — hence the existence check here, next to
		// the shape it certifies.
		for (const profile of [CMYK_SOURCE_PROFILE, SRGB_TARGET_PROFILE]) {
			expect([profile, existsSync(profile)]).toEqual([profile, true]);
		}
		// A CMYK JPEG renders INVERTED in every browser, so the conversion must
		// happen; and it must happen before the flatten, or the background colour is
		// composited in the wrong colorspace.
		expect(argv.slice(source + 1, background)).toEqual([
			'-profile',
			expect.stringContaining('Generic_CMYK_Profile.icc'),
			'-profile',
			expect.stringContaining('sRGB_Profile.icc'),
			'-strip',
		]);
		// Everything else is untouched by the CMYK branch.
		expect(argv.slice(background)).toEqual(
			buildThumbArgv('/s.tif', '/t.jpg', 222, 148, {
				selection: 'representative',
				background: '#ffffff',
			}).slice(4),
		);
	});

	/**
	 * META-CHANNEL → ALPHA (2026-08-04, the reported medal defect).
	 *
	 * Photoshop stores the mask as a TIFF extra sample; ImageMagick does not read
	 * it as transparency, so the retouch paint outside the medal silhouette
	 * survived into every jpg tier. `-channel-fx meta0=>alpha` promotes it.
	 *
	 * These gates pin the two things an argv can get wrong:
	 *  - POSITION: right after the source token, before the CMYK trio and before
	 *    -background. The alpha must exist before anything composites against it —
	 *    on an opaque target that composite is what the mask is FOR.
	 *  - QUOTING: v6 built a shell string (`-channel-fx "meta0=>alpha"`); this argv
	 *    goes to spawn directly, so a quoted token would reach ImageMagick
	 *    literally and the fx would fail.
	 */
	test('dd_thumb, applyMetaAlpha: the fx sits right after the source, unquoted', () => {
		const argv = buildThumbArgv('/s.tif', '/t.jpg', 222, 148, {
			selection: 'representative',
			background: '#ffffff',
			applyMetaAlpha: true,
		});
		expect(argv).toEqual([
			magick,
			'-define',
			'jpeg:size=400x400',
			'/s.tif[0]',
			'-channel-fx',
			'meta0=>alpha',
			'-background',
			'#ffffff',
			'-flatten',
			'-thumbnail',
			'222x148>',
			'-auto-orient',
			'-gravity',
			'center',
			'-unsharp',
			'0x.5',
			'-quality',
			'90',
			// THE OUTPUT TOKEN CARRIES ITS CODER (2026-08-07), never the bare path.
			'JPEG:/t.jpg',
		]);
		// Absent by default: the fx HARD-FAILS (no output file at all) on a source
		// without a meta channel, so it can only ever be probe-gated opt-in.
		expect(
			buildThumbArgv('/s.tif', '/t.jpg', 222, 148, {
				selection: 'representative',
				background: '#ffffff',
			}),
		).not.toContain('-channel-fx');
	});

	test('dd_thumb, applyMetaAlpha + cmyk: the fx precedes the ICC trio', () => {
		const argv = buildThumbArgv('/s.tif', '/t.jpg', 222, 148, {
			selection: 'representative',
			background: '#ffffff',
			cmyk: true,
			applyMetaAlpha: true,
		});
		const source = argv.indexOf('/s.tif[0]');
		expect(argv.slice(source + 1, argv.indexOf('-background'))).toEqual([
			'-channel-fx',
			'meta0=>alpha',
			'-profile',
			expect.stringContaining('Generic_CMYK_Profile.icc'),
			'-profile',
			expect.stringContaining('sRGB_Profile.icc'),
			'-strip',
		]);
	});

	test('buildConvertArgv, applyMetaAlpha: the fx sits right after the source, unquoted', () => {
		const argv = buildConvertArgv('/s.tif', '/t.jpg', {
			quality: '1.5MB',
			selection: 'representative',
			background: '#ffffff',
			applyMetaAlpha: true,
		});
		expect(argv.slice(0, 4)).toEqual([magick, '/s.tif[0]', '-channel-fx', 'meta0=>alpha']);
		expect(argv[4]).toBe('-background');
		// The whole rest of the recipe is untouched by the branch.
		expect(argv.slice(4)).toEqual(
			buildConvertArgv('/s.tif', '/t.jpg', {
				quality: '1.5MB',
				selection: 'representative',
				background: '#ffffff',
			}).slice(2),
		);
		// And with the CMYK trio the fx still comes first.
		//
		// `selection: 'representative'` deliberately, NOT 'composite'. This builder is
		// a dumb argv assembler and would happily emit both, but the pair is never
		// built: `-channel-fx` COLLAPSES the image list to image 0, so it destroys the
		// stack the composite selection exists to keep (measured — see
		// `shouldApplyMetaAlpha` in processing.ts, and the recipe gate in
		// media_processing.test.ts that holds the rule). A gate must not pin a
		// combination the engine forbids as though it were contract.
		const cmyk = buildConvertArgv('/s.tif', '/t.jpg', {
			quality: '1.5MB',
			selection: 'representative',
			background: '#ffffff',
			cmyk: true,
			applyMetaAlpha: true,
		});
		expect(cmyk.slice(1, 8)).toEqual([
			'/s.tif[0]',
			'-channel-fx',
			'meta0=>alpha',
			'-profile',
			expect.stringContaining('Generic_CMYK_Profile.icc'),
			'-profile',
			expect.stringContaining('sRGB_Profile.icc'),
		]);
		expect(
			buildConvertArgv('/s.tif', '/t.jpg', {
				quality: '1.5MB',
				selection: 'representative',
				background: '#ffffff',
			}),
		).not.toContain('-channel-fx');
	});

	test('backgroundForTarget is decided by the TARGET, for a path or a bare extension', () => {
		// Bare JPEG encoding does not composite alpha: it drops the plane and keeps
		// the producing application's hidden RGB (measured red, black AND white on
		// different sources). What matters is what the target can STORE.
		expect(backgroundForTarget('/media/image/thumb/0/x.jpg')).toBe('#ffffff');
		expect(backgroundForTarget('/media/image/1.5MB/0/x.JPEG')).toBe('#ffffff');
		expect(backgroundForTarget('bmp')).toBe('#ffffff');
		expect(backgroundForTarget('pnm')).toBe('#ffffff');
		// Alpha-capable targets keep their transparency.
		expect(backgroundForTarget('/media/image/thumb/0/x.png')).toBe('none');
		expect(backgroundForTarget('avif')).toBe('none');
		expect(backgroundForTarget('webp')).toBe('none');
	});

	test('buildConvertArgv threads the scene token + background, and ports no v6 layer operator', () => {
		const argv = buildConvertArgv('/s.tif', '/t.jpg', {
			quality: '1.5MB',
			selection: 'representative',
			background: '#ffffff',
		});
		expect(argv[1]).toBe('/s.tif[0]');
		const flatten = argv.indexOf('-flatten');
		expect(argv[flatten - 2]).toBe('-background');
		expect(argv[flatten - 1]).toBe('#ffffff');
		expect(argv[argv.length - 1]).toBe('JPEG:/t.jpg');

		// An alpha-capable target must NOT be whited out (the recipe carried a
		// literal '#ffffff' before the background became a caller decision).
		expect(
			buildConvertArgv('/s.png', '/t.png', {
				quality: '1.5MB',
				selection: 'composite',
				background: backgroundForTarget('/t.png'),
			}),
		).toContain('none');

		// v6's `-layers merge` GROWS the canvas and emits negative page offsets
		// (200x100 → 250x180, `240x120+-40+-20`), desynchronising the tier from
		// getDimensions and the SVG envelope; `remove_layer_0` (`-delete 0`) was
		// measured 59.7 % wrong on the reported files. Neither is ported, and this
		// is the gate that keeps them out.
		for (const options of [
			{ quality: '1.5MB', selection: 'representative' as const, background: '#ffffff' },
			{ quality: 'original', selection: 'composite' as const, background: 'none' },
		]) {
			const built = buildConvertArgv('/s.tif', '/t.jpg', options);
			expect(built).not.toContain('-layers');
			expect(built).not.toContain('+layers');
			expect(built).not.toContain('-delete');
		}
	});

	test('rotate expanded: +distort SRT <deg> +repage', () => {
		const s = buildRotateArgv('/s.jpg', '/t.jpg', 90, 'expanded', '#ffffff').join(' ');
		expect(s).toContain('+distort SRT 90 +repage');
		expect(s).toContain('-background #ffffff');
	});

	test('crop: -crop WxH+x+y +repage', () => {
		const s = buildCropArgv('/s.jpg', '/t.jpg', { x: 10, y: 20, width: 100, height: 50 }).join(' ');
		expect(s).toContain('-crop 100x50+10+20 +repage');
	});

	test('crop-and-pad: -crop then -background white -gravity center -extent (PHP crop_50)', () => {
		const s = buildCropAndPadArgv(
			'/s.jpg',
			'/t.jpg',
			{ x: 10, y: 20, width: 100, height: 50 },
			100,
			220,
		).join(' ');
		expect(s).toContain('-crop 100x50+10+20 +repage');
		expect(s).toContain('-background white -gravity center -extent 100x220');
	});

	test('bilevel mask: -colorspace gray -negate -threshold 5% -type bilevel (PHP crop_50)', () => {
		const s = buildBilevelMaskArgv('/s.jpg', '/t.jpg').join(' ');
		expect(s).toContain('-colorspace gray -negate -threshold 5% -type bilevel');
	});

	test('connected-components: verbose + area-threshold, writing to the null: sink (PHP crop_50)', () => {
		const argv = buildConnectedComponentsArgv('/s.jpg', 30000);
		const s = argv.join(' ');
		expect(s).toContain('-define connected-components:verbose=true');
		expect(s).toContain('-define connected-components:area-threshold=30000');
		expect(s).toContain('-connected-components 8');
		expect(argv[argv.length - 1]).toBe('null:'); // no output file — the report is stdout
		expect(s).not.toContain('-crop');
	});

	/**
	 * THE OUTPUT TOKEN (2026-08-07, the alternate-extension twin builder).
	 *
	 * ImageMagick picks the output coder from the file EXTENSION, and when it does
	 * not recognise one it does not refuse — it writes SOMETHING. MEASURED on
	 * IM 7.1.2-18 under the repo policy dir: `magick src.png out.jxl` exits 0 with
	 * an EMPTY stderr and leaves 316 bytes of PNG in a file named `out.jxl`. That
	 * output passes `nonEmptyFile`, passes the one-scene post-condition, enters
	 * files_info and is served with the wrong MIME — a failure class no exit code
	 * and no stderr check can see. Stating the coder turns it into a loud one.
	 *
	 * These are ARGV gates, deliberately: the recipes are pure functions and this
	 * is the one property that must hold for EVERY target the engine can be
	 * configured to write, including the ones this box has no delegate for.
	 */
	describe('every recipe states its output CODER', () => {
		test('every image-writing recipe ends in <CODER>:<abs path>, never a bare path', () => {
			// The connected-components recipe is NOT here: it writes no image (its
			// `null:` sink is asserted separately), so the coder rule cannot apply
			// to it.
			const recipes: [string, string[]][] = [
				[
					'thumb',
					buildThumbArgv('/s.tif', '/t.jpg', 222, 148, {
						selection: 'representative',
						background: '#ffffff',
					}),
				],
				[
					'convert',
					buildConvertArgv('/s.tif', '/t.jpg', {
						quality: '1.5MB',
						selection: 'representative',
						background: '#ffffff',
					}),
				],
				['rotate', buildRotateArgv('/s.jpg', '/t.jpg', 90, 'expanded', '#ffffff')],
				['crop', buildCropArgv('/s.jpg', '/t.jpg', { x: 1, y: 2, width: 3, height: 4 })],
				[
					'crop_and_pad',
					buildCropAndPadArgv('/s.jpg', '/t.jpg', { x: 1, y: 2, width: 3, height: 4 }, 3, 9),
				],
				['bilevel_mask', buildBilevelMaskArgv('/s.jpg', '/t.jpg')],
			];
			for (const [label, argv] of recipes) {
				expect([label, argv[argv.length - 1]]).toEqual([label, 'JPEG:/t.jpg']);
			}
		});

		test('the coder is the CANONICAL module name, and an unlisted one uppercases', () => {
			// jpg/tif are ALIASES of the JPEG/TIFF modules (measured byte-identical
			// output through `TIF:` and `TIFF:`), but the canonical name is what
			// `-list format` prints, so that is what we send.
			expect(coderToken('/x/y.jpg')).toBe('JPEG:/x/y.jpg');
			expect(coderToken('/x/y.JPEG')).toBe('JPEG:/x/y.JPEG');
			expect(coderToken('/x/y.tif')).toBe('TIFF:/x/y.tif');
			// The formats a twin can be configured as.
			expect(coderToken('/x/y.avif')).toBe('AVIF:/x/y.avif');
			expect(coderToken('/x/y.png')).toBe('PNG:/x/y.png');
			expect(coderToken('/x/y.webp')).toBe('WEBP:/x/y.webp');
			// UNLISTED IS NOT REFUSED: an operator may configure any format their
			// ImageMagick can encode, so the map declares only what the engine itself
			// writes and everything else uppercases. The loudness comes from the
			// absolute path (below) plus canWriteImageFormat's real 1x1 probe, not
			// from a closed list this engine has no business owning.
			expect(coderToken('/x/y.jxl')).toBe('JXL:/x/y.jxl');
		});

		test('a RELATIVE target is refused — the token would become the filename', () => {
			// Measured: `magick src.png JXL:rel.jxl` exits 0, stderr empty, and creates
			// a file literally named `JXL:rel.jxl` in the cwd. With an ABSOLUTE path the
			// same unrecognised coder exits 1 and writes nothing, which is what makes
			// this rule load-bearing rather than tidy.
			expect(() => coderToken('rel.jxl')).toThrow(/ABSOLUTE/);
			expect(() => coderToken('./rel.jpg')).toThrow(/ABSOLUTE/);
			// …and a target with no extension has no coder to state.
			expect(() => coderToken('/dir/name')).toThrow(/extension/);
		});
	});

	/**
	 * PER-TARGET COMPRESSION. `-quality` used to be a literal 82; PHP's image
	 * recipe uses 90 for every target (`class.ImageMagick.php:281`, thumbs `:208`)
	 * and 82 appears nowhere in the frozen engine. The value is still read from the
	 * call site, because it is a property of the OUTPUT: master normalized copies
	 * pass 100, the pdf thumb its own literal.
	 *
	 * PNG's `-quality` IS NOT A QUALITY (it encodes `zlib_level*10 + filter_type`),
	 * and that is the other half of the measurement that once justified 82: at 90
	 * PNG compresses BETTER. MEASURED through the real 1.5MB recipe, the layered
	 * medal master gives 721 858 B at 82 vs 535 300 B at 90 (+34.9 % for nothing),
	 * and this install's largest master at full size 12 347 424 B vs 9 957 081 B
	 * (+24.0 %).
	 */
	describe('compressionForTarget', () => {
		test('90 for every target — PHP value, path or bare extension', () => {
			for (const target of [
				'/m/image/1.5MB/0/x.jpg',
				'jpg',
				'jpeg',
				'avif',
				'tif',
				'tiff',
				'/m/image/1.5MB/0/x.png',
				'png',
				'webp',
			]) {
				expect([target, compressionForTarget(target)]).toEqual([target, 90]);
			}
		});

		test('an EXPLICIT compression always wins — this is a default, not a policy', () => {
			// component_pdf's thumb passes 75 (PHP create_thumb literal) and a master
			// normalized copy passes 100; a per-target rule that overrode the caller
			// would silently change both recipes.
			expect(compressionForTarget('/x.png', 75)).toBe(75);
			expect(compressionForTarget('/x.jpg', 100)).toBe(100);
		});

		test('buildConvertArgv takes its -quality from the TARGET, not from a literal', () => {
			const qualityOf = (target: string, compression?: number): string => {
				const argv = buildConvertArgv('/s.tif', target, {
					quality: '1.5MB',
					selection: 'representative',
					background: backgroundForTarget(target),
					compression,
				});
				return argv[argv.indexOf('-quality') + 1] as string;
			};
			expect(qualityOf('/t.jpg')).toBe('90');
			// The alpha-capable twin an install configures — same recipe, other target.
			expect(qualityOf('/t.avif')).toBe('90');
			expect(qualityOf('/t.png')).toBe('90');
			expect(qualityOf('/t.png', 75)).toBe('75');
		});
	});
});

describe('pdf argv recipes (PHP component_pdf)', () => {
	test('text extraction: -enc UTF-8 -f -l', () => {
		const s = buildExtractArgv('/s.pdf', '/o.txt', { method: 'text', pageIn: 2, pageOut: 5 }).join(
			' ',
		);
		expect(s).toContain('-enc UTF-8');
		expect(s).toContain('-f 2');
		expect(s).toContain('-l 5');
	});

	test('html extraction adds -i -p -noframes, and no pdftotext-only -layout', () => {
		const argv = buildExtractArgv('/s.pdf', '/o.html', { method: 'html' });
		expect(argv.join(' ')).toContain('-i -p -noframes');
		// pdftohtml has no -layout: it exits 1 on it (the html end-to-end case in
		// tool_pdf_extractor.test.ts measures the real binary)
		expect(argv).not.toContain('-layout');
	});

	test('ocr: --pdfa-image-compression lossless -l <lang> --force-ocr', () => {
		const s = buildOcrArgv('/s.pdf', '/o.pdf', 'lg-spa').join(' ');
		expect(s).toContain('--pdfa-image-compression lossless -l spa --force-ocr');
		// The model comes from the ONE map (ocr_langs.ts): Valencian shares Catalan's,
		// and a Dédalo lang with no model — or a bare Tesseract code — is refused.
		expect(buildOcrArgv('/s.pdf', '/o.pdf', 'lg-vlca')).toContain('cat');
		for (const lang of ['lg-xxx', 'spa', 'eng+spa']) {
			expect(() => buildOcrArgv('/s.pdf', '/o.pdf', lang)).toThrow(/Tesseract language model/);
		}
	});

	// THE OCR DOOR ON A REAL BINARY. The argv leg above pins the recipe's spelling; this
	// one proves the recipe still RUNS on the ocrmypdf a host ships (flags drift between
	// majors) and really adds text. Fixture: an IMAGE-ONLY PDF (ghostscript's pdfimage24
	// rasterizes a PostScript page — built-in font, no ImageMagick PDF policy), so the
	// control finds no text before and any text after is the OCR's. In place, as the door
	// runs (source === target). Skips where the binaries are absent; the CI image ships
	// all three (ci/Dockerfile), so there it runs.
	const ocrBinaries = [
		config.media.binaries.ocrmypdf,
		config.media.binaries.ghostscript,
		config.media.binaries.pdftotext,
	];
	test.if(ocrBinaries.every((bin) => existsSync(bin)))(
		'ocr (real binary): the recipe runs and puts the page words into an image-only PDF',
		() => {
			const dir = mkdtempSync(join(tmpdir(), 'dedalo-ocr-'));
			// ocrmypdf resolves tesseract/gs through PATH, so the host env stays; the
			// shipped ImageMagick policy rides on top (magick_policy_tripwire).
			const spawnEnv = { ...(process.env as Record<string, string>), ...magickTestEnv() };
			try {
				const ps = join(dir, 'page.ps');
				writeFileSync(
					ps,
					'%!PS\n/Helvetica findfont 48 scalefont setfont\n72 600 moveto (HERITAGE LEDGER) show\nshowpage\n',
				);
				const pdf = join(dir, 'scan.pdf');
				const raster = Bun.spawnSync(
					[config.media.binaries.ghostscript, '-q', '-sDEVICE=pdfimage24', '-r200', '-o', pdf, ps],
					{ stderr: 'pipe' },
				);
				expect(raster.exitCode, raster.stderr.toString()).toBe(0);
				const textOf = (): string => {
					const out = join(dir, 'out.txt');
					const run = Bun.spawnSync(buildExtractArgv(pdf, out, { method: 'text' }), {
						stderr: 'pipe',
						env: spawnEnv,
					});
					expect(run.exitCode, run.stderr.toString()).toBe(0);
					return readFileSync(out, 'utf-8');
				};
				// Control: the fixture really is image-only.
				expect(textOf()).not.toContain('HERITAGE');
				const ocr = Bun.spawnSync(buildOcrArgv(pdf, pdf, 'lg-eng'), {
					stderr: 'pipe',
					env: spawnEnv,
				});
				expect(ocr.exitCode, ocr.stderr.toString()).toBe(0);
				expect(textOf()).toContain('HERITAGE LEDGER');
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		120_000,
	);
});

describe('mime sniffer (magic bytes, no library)', () => {
	const bytesOf = (...n: number[]) => new Uint8Array(n);

	test('images', () => {
		expect(sniffBytes(bytesOf(0xff, 0xd8, 0xff, 0xe0))?.kind).toBe('jpeg');
		expect(sniffBytes(bytesOf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))?.kind).toBe('png');
		expect(sniffBytes(bytesOf(0x49, 0x49, 0x2a, 0x00))?.kind).toBe('tiff');
		expect(sniffBytes(bytesOf(0x38, 0x42, 0x50, 0x53))?.kind).toBe('psd');
	});

	test('RIFF + ftyp dispatch', () => {
		const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
		expect(sniffBytes(webp)?.kind).toBe('webp');
		const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
		expect(sniffBytes(wav)?.kind).toBe('wav');
		const mp4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
		expect(sniffBytes(mp4)?.kind).toBe('mp4');
	});

	test('pdf, zip, svg text, glb', () => {
		expect(sniffBytes(new TextEncoder().encode('%PDF-1.7'))?.kind).toBe('pdf');
		expect(sniffBytes(bytesOf(0x50, 0x4b, 0x03, 0x04))?.kind).toBe('zip');
		expect(sniffBytes(new TextEncoder().encode('<?xml version="1.0"?><svg xmlns='))?.kind).toBe(
			'svg',
		);
		expect(sniffBytes(new TextEncoder().encode('glTF'))?.kind).toBe('glb');
	});

	test('plain text: csv/txt/json/xml accepted, html rejected under any extension', () => {
		const enc = (s: string) => new TextEncoder().encode(s);
		// The import tools upload CSV through the same endpoint as media (the bug:
		// a CSV has no magic bytes, so the closed-world sniffer failed it closed).
		expect(sniffAndValidate(enc('id,name\n1,"Ana"\n'), 'csv')).toBe('csv');
		// A latin-1 CSV out of Excel is text too — the sniff is charset-agnostic.
		expect(sniffAndValidate(new Uint8Array([0x61, 0x2c, 0xe1, 0x0a]), 'csv')).toBe('csv');
		expect(sniffAndValidate(enc('{"a":1}'), 'json')).toBe('json');
		expect(sniffAndValidate(enc('<?xml version="1.0"?><root/>'), 'xml')).toBe('xml');
		expect(sniffAndValidate(enc('plain\n'), 'txt')).toBe('txt');
		// MEDIA-01: an HTML document is refused whatever it is named.
		expect(() => sniffAndValidate(enc('<!DOCTYPE html><html><body>x'), 'csv')).toThrow(
			/not an allowed upload type/,
		);
		// Still fail-closed: text is not a free pass for a media extension.
		expect(() => sniffAndValidate(enc('id,name\n'), 'jpg')).toThrow();
		// An empty file is not text (PHP: application/x-empty → not allowlisted).
		expect(() => sniffAndValidate(new Uint8Array(0), 'csv')).toThrow();
		// Binary declared as csv → rejected.
		expect(() => sniffAndValidate(bytesOf(0xff, 0xd8, 0xff), 'csv')).toThrow();
	});

	test('sniffAndValidate: matches, mismatches fail closed', () => {
		expect(sniffAndValidate(new TextEncoder().encode('%PDF-1.4'), 'pdf')).toBe('pdf');
		expect(sniffAndValidate(bytesOf(0xff, 0xd8, 0xff), 'jpg')).toBe('jpg');
		// jpeg bytes declared as png → rejected
		expect(() => sniffAndValidate(bytesOf(0xff, 0xd8, 0xff), 'png')).toThrow();
		// unknown signature declared as an image → rejected (fail closed)
		expect(() => sniffAndValidate(bytesOf(0x00, 0x01, 0x02, 0x03), 'jpg')).toThrow();
		// text-based 3D (.obj) with no magic → accepted when not a known binary
		expect(sniffAndValidate(new TextEncoder().encode('v 0.0 0.0 0.0\n'), 'obj')).toBe('obj');
	});
});

/**
 * CONTENT-VERIFICATION POLICY (2026-08-03, WC-2026-08-03-chunked-upload-identity).
 *
 * `verify_content.ts` states, per content class, how deeply an upload's BODY is
 * verified — and the point of stating it is that nothing may be missing from
 * the statement. A signature added to mime.ts with no policy row would silently
 * fall back to a header-only check, which is precisely the narrowing this
 * change exists to end, so the source is scanned for `kind:` literals and every
 * one of them must be listed.
 */
describe('content verification: every sniffable kind has a stated depth', () => {
	test('mime.ts kinds and VERIFICATION_POLICY agree exactly', async () => {
		const { VERIFICATION_POLICY } = await import('../../src/core/media/engine/verify_content.ts');
		const source = readFileSync(
			new URL('../../src/core/media/engine/mime.ts', import.meta.url).pathname,
			'utf8',
		);
		const kinds = new Set<string>();
		for (const match of source.matchAll(/kind:\s*'([a-z0-9]+)'/g)) kinds.add(match[1] as string);
		// The scan must find the known families, or it is passing vacuously.
		expect(kinds.size).toBeGreaterThan(15);
		const unstated = [...kinds].filter((kind) => VERIFICATION_POLICY[kind] === undefined);
		expect(unstated.sort()).toEqual([]);
		// The extension-only 3D formats have no signature and so no `kind:` line;
		// they are keyed by extension and must be stated too.
		for (const extension of ['obj', 'fbx', 'dae']) {
			expect(VERIFICATION_POLICY[extension]).toBeDefined();
		}
		// Every exemption carries a REASON — a named exemption, never a silent one.
		for (const [kind, policy] of Object.entries(VERIFICATION_POLICY)) {
			expect(policy.reason.length, `${kind} has no stated reason`).toBeGreaterThan(20);
		}
	});

	test('structural verifiers catch a truncated/smuggled container without reading the file', async () => {
		const { verifyFileContent } = await import('../../src/core/media/engine/verify_content.ts');
		const { mkdtempSync, writeFileSync: write } = await import('node:fs');
		const { tmpdir } = await import('node:os');
		const { join } = await import('node:path');
		const dir = mkdtempSync(join(tmpdir(), 'dedalo_verify_'));

		// A WHOLE mp4: one 'ftyp' box that tiles the file exactly.
		const ftyp = new Uint8Array([
			0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0,
		]);
		const good = join(dir, 'good.mp4');
		write(good, ftyp);
		expect(verifyFileContent(good, 'mp4')).toBe('mp4');

		// The same header with a NON-ZERO payload bolted on: the appended block reads
		// as a box declaring 0x41414141 bytes, far past EOF. (The zero-filled variant
		// this test used until 2026-08-03 is now ACCEPTED on purpose — see the
		// false-positive suite below: it is indistinguishable from the block padding
		// a capture card writes.)
		const smuggled = new Uint8Array(ftyp.length + 4096).fill(0x41);
		smuggled.set(ftyp, 0);
		const bad = join(dir, 'bad.mp4');
		write(bad, smuggled);
		expect(() => verifyFileContent(bad, 'mp4')).toThrow(/verification failed/);

		const { rmSync } = await import('node:fs');
		rmSync(dir, { recursive: true, force: true });
	});
});

/**
 * THE FALSE-POSITIVE SURFACE — the surface that DESTROYS DATA.
 *
 * The first version of this verifier was gated by one synthetic accept and one
 * synthetic reject: it tested the mechanism's happy path, not the question that
 * actually matters for an archival ingest path, which is "what LEGAL file does
 * this refuse?". An adversarial review then reproduced five classes of real,
 * standards-legal encoder output that it rejected — and, at the time, a rejected
 * join DELETED the transfer.
 *
 * Every row below is one of those classes, asserted as an ACCEPTANCE. They are
 * constructed byte by byte rather than committed as binaries, so the gate stays
 * readable and the repository stays free of fixture blobs.
 *
 * Adding a rule to VERIFICATION_POLICY means adding the real-world file it could
 * refuse to this list first. If you cannot write that case, the rule does not
 * belong at a depth deeper than `header`.
 */
describe('content verification: real encoder output is never refused', () => {
	const be32 = (n: number): number[] => [
		(n >>> 24) & 255,
		(n >>> 16) & 255,
		(n >>> 8) & 255,
		n & 255,
	];
	const le32 = (n: number): number[] => [
		n & 255,
		(n >>> 8) & 255,
		(n >>> 16) & 255,
		(n >>> 24) & 255,
	];
	const chars = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

	/** `RIFF<size>WAVE` + a `fmt ` and a `data` chunk of `payload` bytes. */
	function wav(riffSize: number | 'sentinel', payload: number, trailer: number[] = []): Uint8Array {
		const data = [...chars('data'), ...le32(payload), ...new Array(payload).fill(0x7f)];
		const fmt = [...chars('fmt '), ...le32(16), ...new Array(16).fill(0)];
		const body = [...chars('WAVE'), ...fmt, ...data];
		const size = riffSize === 'sentinel' ? [255, 255, 255, 255] : le32(riffSize);
		return new Uint8Array([...chars('RIFF'), ...size, ...body, ...trailer]);
	}

	/** One `ftyp` box + one `mdat` box of `payload` bytes, plus optional trailing bytes. */
	function mp4(payload: number, trailer: number[] = []): Uint8Array {
		const ftyp = [...be32(16), ...chars('ftypisom'), 0, 0, 0, 0];
		const mdat = [...be32(8 + payload), ...chars('mdat'), ...new Array(payload).fill(0x21)];
		return new Uint8Array([...ftyp, ...mdat, ...trailer]);
	}

	const dir = mkdtempSync(join(tmpdir(), 'dedalo_verify_ok_'));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	/** Write the constructed fixture and return its path. */
	const stage = (name: string, bytes: Uint8Array): string => {
		const path = join(dir, name);
		writeFileSync(path, bytes);
		return path;
	};

	test('an ffmpeg WAV written to a PIPE (RIFF size 0xFFFFFFFF) is accepted', () => {
		// A non-seekable sink cannot patch the size back in, so ffmpeg leaves the
		// streaming sentinel. Every decoder reads it as extends-to-EOF; the first
		// version of this verifier recognised it explicitly and refused it anyway.
		expect(verifyFileContent(stage('pipe.wav', wav('sentinel', 4096)), 'wav')).toBe('wav');
	});

	test('a WAV with a trailing tag OUTSIDE the RIFF size is accepted', () => {
		// An ID3v1/APE tag (or any writer that did not update the header) leaves
		// bytes the chunk chain cannot account for. Refusing them refused real files.
		const tag = [...chars('TAG'), ...new Array(125).fill(0x20)];
		const inner = 4 + (8 + 16) + (8 + 4096); // 'WAVE' + fmt chunk + data chunk
		expect(verifyFileContent(stage('tagged.wav', wav(inner, 4096, tag)), 'wav')).toBe('wav');
	});

	test('an MP4 with 512 B of trailing ZERO block padding is accepted', () => {
		// Capture cards and block-aligned tape-out pad to a boundary. The box chain
		// cannot tile that, and calling it "an appended payload" refused masters.
		expect(verifyFileContent(stage('padded.mp4', mp4(2048, new Array(512).fill(0))), 'mp4')).toBe(
			'mp4',
		);
	});

	test('an MP4 whose last box is the streaming size-0 form is accepted', () => {
		const ftyp = [...be32(16), ...chars('ftypisom'), 0, 0, 0, 0];
		const mdat = [...be32(0), ...chars('mdat'), ...new Array(1024).fill(0x21)];
		const bytes = new Uint8Array([...ftyp, ...mdat]);
		expect(verifyFileContent(stage('frag.mp4', bytes), 'mp4')).toBe('mp4');
	});

	test('a JPEG with a >1 MiB appended block after EOI (Motion Photo / JUMBF) is accepted', () => {
		// The tail window was 1 MiB, so a Motion Photo's embedded MP4 — or a large
		// XMP/JUMBF/C2PA packet — pushed the EOI out of range and the master was
		// refused (and, before the quarantine fix, DELETED).
		const bytes = new Uint8Array([
			0xff,
			0xd8,
			0xff,
			0xe0,
			...new Array(64).fill(0x30),
			0xff,
			0xd9,
			...new Array((1 << 20) + 4096).fill(0x5a),
		]);
		expect(verifyFileContent(stage('motion.jpg', bytes), 'jpg')).toBe('jpg');
	});

	test('a CSV carrying a NUL and a DOS 0x1A EOF is accepted', () => {
		// A NUL in a CSV is not evidence of corruption: it is what a UTF-16→UTF-8
		// conversion leaves behind, and 0x1A is the CP/M end-of-file every DOS-era
		// export ends with. Refusing them destroys exactly the legacy material a
		// heritage repository exists to keep.
		const head = new TextEncoder().encode(`id,name\n${'1,ok\n'.repeat(2000)}`);
		expect(head.length).toBeGreaterThan(8192); // past the sniffed prefix, as before
		const bytes = new Uint8Array(head.length + 2);
		bytes.set(head, 0);
		bytes.set([0x00, 0x1a], head.length);
		expect(verifyFileContent(stage('legacy.csv', bytes), 'csv')).toBe('csv');
	});

	test('a BMP/GLB whose declared size is SHORTER than the file is accepted', () => {
		// bfSize left at the pixel-array size (or 0), and exporters that pad to an
		// alignment boundary — both legal, both previously refused for "declares N
		// but the file holds M".
		const bmp = new Uint8Array([...chars('BM'), ...le32(40), ...new Array(120).fill(0)]);
		expect(verifyFileContent(stage('short.bmp', bmp), 'bmp')).toBe('bmp');
		const glb = new Uint8Array([
			...chars('glTF'),
			...le32(2),
			...le32(64),
			...new Array(120).fill(0),
		]);
		expect(verifyFileContent(stage('short.glb', glb), 'glb')).toBe('glb');
	});

	test('but a TRUNCATED container is still refused (the invariant that survives)', () => {
		// A RIFF chunk declaring more payload than the file holds = missing bytes.
		expect(() => verifyFileContent(stage('short.wav', wav(1 << 20, 64)), 'wav')).toThrow(
			/truncated transfer/,
		);
		// An ISO-BMFF box declaring past EOF, likewise.
		expect(() => verifyFileContent(stage('cut.mp4', mp4(4096).slice(0, 512)), 'mp4')).toThrow(
			/truncated transfer/,
		);
		// And a JPEG with no EOI anywhere in range is still a header over garbage.
		const headless = new Uint8Array([0xff, 0xd8, 0xff, ...new Array(16384).fill(0x00)]);
		expect(() => verifyFileContent(stage('headless.jpg', headless), 'jpg')).toThrow(/JPEG EOI/);
	});

	test('no policy row claims a depth that reads the whole file (S-7)', async () => {
		// The `full` depth ran a synchronous per-byte loop over every byte — ~43 s of
		// total server freeze for a 30 GB CSV. It is gone, and this keeps it gone:
		// a row that needs O(file size) work belongs off the request path, not here.
		const { VERIFICATION_POLICY } = await import('../../src/core/media/engine/verify_content.ts');
		for (const [kind, policy] of Object.entries(VERIFICATION_POLICY)) {
			expect(['structural', 'header'], `${kind} has an unbounded depth`).toContain(policy.depth);
		}
	});
});
