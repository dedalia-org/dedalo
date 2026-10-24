/**
 * THE TWO-MASTERS GATE (2026-08-07).
 *
 * Dédalo's image domain has TWO masters, not one: the ORIGINAL (the camera /
 * scanner shot, stored as is) and the RETOUCHED tier
 * (DEDALO_IMAGE_QUALITY_RETOUCHED, canonically 'modified') — the human-retouched
 * second master, which may be a full-quality .tif or .psd and which OUTRANKS the
 * original as the source of every derived tier for as long as it exists (v6
 * component_image::get_image_source, frozen class.component_image.php:1569).
 *
 * Before this change the engine had one notion, `originalQuality`, so the
 * retouched tier was classified as a derivative: a .tif into it was REFUSED
 * ("Cannot upload a '.tif' file into the 'modified' tier"), an accepted retouch
 * re-encoded nothing, and nothing could ever be built FROM it.
 *
 * These assertions are about CONTENT, not existence: the fixtures are two
 * visually distinct flat colours, so "the derived tier came from the modified"
 * is a pixel value, not a file listing.
 */
// MIGRATED TO THE GENERIC `test` TLD, 2026-08-19: every install tipo this gate
// spelled is now its generic twin (sections on the `test` TLD, storing in
// matrix_test). A pure rename — the tipo is an identifier in a path, a filename
// or a locator here, so no corpus and no DB round-trip were added.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
} from 'node:fs';
import { config } from '../../src/config/config.ts';
import { assertNormalizedExtensionForTier, mediaTypeOf } from '../../src/core/concepts/media.ts';
import { resolveMagick } from '../../src/core/media/engine/imagemagick.ts';
import { runBinary } from '../../src/core/media/engine/spawn.ts';
import { scanFilesInfo } from '../../src/core/media/files_info.ts';
import { stagingDir } from '../../src/core/media/ingest/add_file.ts';
import {
	isMasterTier,
	processUploadedFile,
	replacesArchivalCue,
} from '../../src/core/media/ingest/process_uploaded_file.ts';
import {
	buildMediaLocation,
	type MediaIdentity,
	type MediaPathOptions,
} from '../../src/core/media/path.ts';
import {
	buildMasterNormalizedCopy,
	noteOutrankingMaster,
	regenerateImage,
	resolveMasterQuality,
	resolveMasterSource,
} from '../../src/core/media/processing.ts';
import { svgOverlayLocation } from '../../src/core/media/svg_overlay.ts';
import { applyRotationCore } from '../../src/core/media/tools/rotation.ts';
import { buildVersionCore, deleteAndResyncCore } from '../../src/core/media/tools/versions.ts';
import { magickTestEnv } from '../helpers/magick_test_env.ts';
import { markMediaRoot } from '../helpers/media_scratch_root.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const ROOT = scratchDir('two_masters');
const image = mediaTypeOf('component_image')!;
const av = mediaTypeOf('component_av')!;
const pdf = mediaTypeOf('component_pdf')!;

/**
 * The alternate the TWIN tests drive, and a spec that configures exactly that
 * one machine-only twin — built by the engine, refused by the upload allowlist.
 * BUILT, not borrowed: reading both off the install tied these gates to two
 * operator keys (DEDALO_IMAGE_ALTERNATIVE_EXTENSIONS defaults to [] — the gates
 * then died on `undefined`; DEDALO_IMAGE_EXTENSIONS_SUPPORTED's shipped default
 * admits avif — the default-tier churn assertion then went red). A clone keeps
 * the folders/ladder/paths, so the code under test cannot tell it apart.
 */
const ALT = image.alternateExtensions[0] ?? 'avif';
const twinImage = Object.freeze({
	...image,
	alternateExtensions: Object.freeze([ALT]),
	allowedExtensions: Object.freeze(image.allowedExtensions.filter((e) => e !== ALT)),
	managedExtensions: Object.freeze([
		...new Set([image.defaultExtension, ...image.allowedExtensions, ALT]),
	]),
}) as typeof image;
const HAVE_MAGICK = existsSync(resolveMagick());
const pathOpts: MediaPathOptions = { initialMediaPath: '', maxItemsFolder: null, mediaRoot: ROOT };

/** The retouched tier name as this install configures it — never the literal. */
const MODIFIED = config.media.imageQualityRetouched;
/** A tier that really IS a derivative, for the contrast cases. */
const DERIVED = image.defaultQuality;

let sectionId = 0;
function nextIdentity(): MediaIdentity {
	sectionId += 1;
	return { componentTipo: 'test99', sectionTipo: 'test3', sectionId, lang: null };
}

function pathOf(identity: MediaIdentity, quality: string, extension: string): string {
	return buildMediaLocation(image, identity, quality, extension, pathOpts).absolutePath;
}

/** Write a real flat-colour image at an absolute path. */
async function makeImage(absolute: string, color: string, size = '900x600'): Promise<void> {
	mkdirSync(absolute.slice(0, absolute.lastIndexOf('/')), { recursive: true });
	const result = await runBinary([resolveMagick(), '-size', size, `xc:${color}`, absolute], {
		nice: false,
		env: magickTestEnv(),
	});
	if (result.exitCode !== 0) {
		throw new Error(`fixture build failed for ${absolute}: ${result.stderr}`);
	}
}

/** Read the centre pixel as 8-bit r,g,b (the fixtures are flat, so one probe decides). */
async function centrePixel(path: string): Promise<[number, number, number]> {
	const format =
		'%[fx:int(255*p{w/2,h/2}.r)],%[fx:int(255*p{w/2,h/2}.g)],%[fx:int(255*p{w/2,h/2}.b)]';
	const result = await runBinary([resolveMagick(), path, '-format', format, 'info:'], {
		nice: false,
		env: magickTestEnv(),
	});
	const parts = result.stdout.trim().split(',').map(Number);
	if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
		throw new Error(`cannot read the centre pixel of ${path}: '${result.stdout}'`);
	}
	return [parts[0] as number, parts[1] as number, parts[2] as number];
}

/** `<w>x<h>` of a written file — the assertion for rotation/crop work. */
async function dimensions(path: string): Promise<string> {
	const result = await runBinary([resolveMagick(), path, '-format', '%wx%h', 'info:'], {
		nice: false,
		env: magickTestEnv(),
	});
	return result.stdout.trim();
}

/** A real derived tier ABOVE the default one (the '6MB'-class tiers). */
function higherTier(): string {
	const quality = image.qualities.find(
		(value) =>
			!image.masterQualities.includes(value) &&
			value !== image.defaultQuality &&
			value !== config.media.thumb.quality,
	);
	if (quality === undefined) throw new Error('this ladder has no higher derived tier');
	return quality;
}

/** Which flat fixture colour a written derivative depicts — the content assertion. */
async function depicts(path: string): Promise<'red' | 'blue' | 'green' | 'other'> {
	const [r, g, b] = await centrePixel(path);
	if (r > 200 && g < 60 && b < 60) return 'red';
	if (b > 200 && r < 60 && g < 60) return 'blue';
	// ImageMagick's 'green' is (0,128,0), not (0,255,0) — the band is around 128.
	if (g > 100 && r < 60 && b < 60) return 'green';
	return 'other';
}

beforeAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
	// DECLARE the scratch root (the media doors refuse an unmarked one under the
	// test-media seam — src/core/media/test_media_root.ts).
	markMediaRoot(ROOT);
	mkdirSync(ROOT, { recursive: true });
});
afterAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

describe('masterQualities — the concept', () => {
	test('component_image has TWO masters, retouched first (precedence order)', () => {
		expect(image.masterQualities).toEqual([MODIFIED, image.originalQuality]);
	});

	test('every other model has exactly one master: its own original', () => {
		for (const spec of [av, pdf, mediaTypeOf('component_svg')!, mediaTypeOf('component_3d')!]) {
			expect(spec.masterQualities).toEqual([spec.originalQuality]);
		}
	});

	test('the masters are REAL ladder tiers (a source nothing can fill is not a master)', () => {
		for (const master of image.masterQualities) {
			expect(image.qualities).toContain(master);
		}
	});

	test('"is a master" and "replaces the archival cue" are DIFFERENT questions', () => {
		// The retouch re-encodes the derived tiers (isMaster) but must NOT claim the
		// archival tier's stored name cue — collapsing the two into one boolean
		// stamps original_normalized_name with the retouch and discards the record's
		// stored cues. See replacesArchivalCue for what is and is not gated here.
		expect(isMasterTier(image, MODIFIED)).toBe(true);
		expect(replacesArchivalCue(image, MODIFIED)).toBe(false);
		// They agree everywhere else — on the archival tier, on an unset target,
		// and on a real derivative tier.
		expect(isMasterTier(image, image.originalQuality)).toBe(true);
		expect(replacesArchivalCue(image, image.originalQuality)).toBe(true);
		expect(isMasterTier(image, undefined)).toBe(true);
		expect(replacesArchivalCue(image, undefined)).toBe(true);
		expect(isMasterTier(image, DERIVED)).toBe(false);
		expect(replacesArchivalCue(image, DERIVED)).toBe(false);
	});
});

describe('the shadowing guard — masters exempt, derivative tiers still guarded', () => {
	test('a .tif into the RETOUCHED tier is ACCEPTED (the reported defect)', () => {
		expect(() => assertNormalizedExtensionForTier(image, MODIFIED, 'tif')).not.toThrow();
		// The retouch arrives in whatever the photographer delivered.
		for (const extension of ['psd', 'tiff', 'png']) {
			expect(() => assertNormalizedExtensionForTier(image, MODIFIED, extension)).not.toThrow();
		}
	});

	test('a .tif into the ORIGINAL tier is still accepted (unchanged Original law)', () => {
		expect(() =>
			assertNormalizedExtensionForTier(image, image.originalQuality, 'tif'),
		).not.toThrow();
	});

	test('a .tif into a REAL derivative tier is still REFUSED (guard not lost)', () => {
		expect(() => assertNormalizedExtensionForTier(image, DERIVED, 'tif')).toThrow(
			/would be shadowed/,
		);
		// av has no retouched tier at all, so its derivative tiers are unchanged.
		expect(() => assertNormalizedExtensionForTier(av, av.defaultQuality, 'mkv')).toThrow(
			/would be shadowed/,
		);
	});

	test('the refusal names the MASTER tiers as the target, not just the original', () => {
		let message = '';
		try {
			assertNormalizedExtensionForTier(image, DERIVED, 'tif');
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain(`'${MODIFIED}'`);
		expect(message).toContain(`'${image.originalQuality}'`);
	});

	test('a normalized extension into a derivative tier is accepted', () => {
		expect(() =>
			assertNormalizedExtensionForTier(image, DERIVED, image.defaultExtension),
		).not.toThrow();
	});
});

describe.if(HAVE_MAGICK)('resolveMasterSource — precedence', () => {
	test('the RETOUCHED master outranks the original', async () => {
		const identity = nextIdentity();
		await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red');
		expect(resolveMasterQuality(image, identity, pathOpts)).toBe(image.originalQuality);

		await makeImage(pathOf(identity, MODIFIED, 'tif'), 'blue');
		expect(resolveMasterQuality(image, identity, pathOpts)).toBe(MODIFIED);
		expect(resolveMasterSource(image, identity, pathOpts)).toContain(`/${MODIFIED}/`);
	});

	test('the original is used when no retouch exists', async () => {
		const identity = nextIdentity();
		await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red');
		expect(resolveMasterSource(image, identity, pathOpts)).toContain(`/${image.originalQuality}/`);
	});

	test('no master at all resolves to null', () => {
		expect(resolveMasterSource(image, nextIdentity(), pathOpts)).toBeNull();
		expect(resolveMasterQuality(image, nextIdentity(), pathOpts)).toBeNull();
	});
});

describe.if(HAVE_MAGICK)('the derived tiers depict the best master', () => {
	test('with BOTH masters present, the derived tiers come from the RETOUCH', async () => {
		const identity = nextIdentity();
		await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red');
		await makeImage(pathOf(identity, MODIFIED, 'tif'), 'blue');

		await regenerateImage(image, identity, pathOpts, 'tif');

		expect(await depicts(pathOf(identity, DERIVED, image.defaultExtension))).toBe('blue');
		expect(
			await depicts(pathOf(identity, config.media.thumb.quality, config.media.thumb.extension)),
		).toBe('blue');
		// And the masters themselves are untouched.
		expect(await depicts(pathOf(identity, image.originalQuality, 'tif'))).toBe('red');
		expect(await depicts(pathOf(identity, MODIFIED, 'tif'))).toBe('blue');
	});

	test('a NEW ORIGINAL while a retouch exists still builds from the RETOUCH', async () => {
		const identity = nextIdentity();
		await makeImage(pathOf(identity, MODIFIED, 'tif'), 'blue');
		await regenerateImage(image, identity, pathOpts, 'tif');
		expect(await depicts(pathOf(identity, DERIVED, image.defaultExtension))).toBe('blue');

		// The operator re-scans the object: a fresh, DIFFERENT original lands.
		await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red');
		await regenerateImage(image, identity, pathOpts, 'tif');

		// Decision 1: the retouch keeps outranking it — the visible image is unchanged.
		expect(await depicts(pathOf(identity, DERIVED, image.defaultExtension))).toBe('blue');
	});

	test('an ALREADY EXISTING higher tier is RE-ENCODED, not left stale', async () => {
		const identity = nextIdentity();
		await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red');
		// A higher tier built earlier, from a master that is about to be superseded.
		const higher = image.qualities.find(
			(quality) =>
				!image.masterQualities.includes(quality) &&
				quality !== image.defaultQuality &&
				quality !== config.media.thumb.quality,
		);
		expect(higher).toBeDefined();
		const higherPath = pathOf(identity, higher as string, image.defaultExtension);
		await makeImage(higherPath, 'green');
		expect(await depicts(higherPath)).toBe('green');

		// The retouch arrives and becomes the best master.
		await makeImage(pathOf(identity, MODIFIED, 'tif'), 'blue');
		await regenerateImage(image, identity, pathOpts, 'tif');

		expect(await depicts(higherPath)).toBe('blue');
	});

	test('an ABSENT higher tier is NOT minted (tiers stay on-demand)', async () => {
		const identity = nextIdentity();
		await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red');
		await regenerateImage(image, identity, pathOpts, 'tif');
		const absent = image.qualities.filter(
			(quality) =>
				!image.masterQualities.includes(quality) &&
				quality !== image.defaultQuality &&
				quality !== config.media.thumb.quality,
		);
		for (const quality of absent) {
			expect(existsSync(pathOf(identity, quality, image.defaultExtension))).toBe(false);
		}
	});
});

/**
 * THE DELETE SEAM, driven through `deleteAndResyncCore` — the function BOTH tool
 * actions call, so the ordering (delete → rebuild → re-scan) and the
 * rebuild-only-when-the-master-changed guard are gated where they live. As a
 * sequence spelled out inside the tool handler it had no gate at all: replacing
 * both call sites with a stub left the entire media suite green.
 */
describe.if(HAVE_MAGICK)('deleting a master re-sources the derived tiers', () => {
	test('deleting the RETOUCH rebuilds the derived tiers from the ORIGINAL at once', async () => {
		const identity = nextIdentity();
		await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red');
		await makeImage(pathOf(identity, MODIFIED, 'tif'), 'blue');
		await regenerateImage(image, identity, pathOpts, 'tif');
		expect(await depicts(pathOf(identity, DERIVED, image.defaultExtension))).toBe('blue');

		const outcome = await deleteAndResyncCore(image, identity, pathOpts, MODIFIED, 'tif');

		expect(outcome.errors).toEqual([]);
		expect(outcome.rebuilt.length).toBeGreaterThan(0);
		expect(await depicts(pathOf(identity, DERIVED, image.defaultExtension))).toBe('red');
		expect(
			await depicts(pathOf(identity, config.media.thumb.quality, config.media.thumb.extension)),
		).toBe('red');
		expect(outcome.filesInfo.some((info) => info.quality === MODIFIED)).toBe(false);
	});

	test('THE ORDER: the returned scan is taken AFTER the rebuild, never before', async () => {
		// The tool PERSISTS this files_info. Taken before the rebuild it would record
		// the state the delete left behind, and the record would then describe files
		// the rebuild has already replaced.
		//
		// THE OBSERVABLE CHANGED ON 2026-08-07, and had to. It used to be the
		// alternate twin DISAPPEARING: nothing in src/ could author one, so the pass
		// could only retire it, and a scan from the wrong moment still listed it.
		// Now the twin is REBUILT from the surviving master, so it is present either
		// way — presence proves nothing at all. What still separates the two moments
		// is WHICH BYTES the entry describes, so the stale twin is stamped with an
		// unmistakable mtime (2020) and the assertion is that the returned entry
		// describes the REBUILT file, down to its size and its file_time.
		//
		// The PIXEL is the other half: it proves the rebuild reached the twin at all
		// (it must now depict the surviving ORIGINAL, not the deleted retouch), which
		// is the twin-builder's claim rather than the ordering's.
		const alternate = ALT;
		expect(twinImage.alternateExtensions).toEqual([alternate]);
		const identity = nextIdentity();
		await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red');
		await makeImage(pathOf(identity, MODIFIED, 'tif'), 'blue');
		await regenerateImage(twinImage, identity, pathOpts);
		const twin = pathOf(identity, DERIVED, alternate);
		// The engine itself authored it, from the retouch — the state the delete is
		// about to invalidate.
		expect(existsSync(twin)).toBe(true);
		expect(await depicts(twin)).toBe('blue');
		const stale = new Date('2020-01-02T03:04:05');
		utimesSync(twin, stale, stale);
		const staleSize = statSync(twin).size;
		// What a scan taken at the WRONG MOMENT reports — captured, not assumed.
		const early = scanFilesInfo(twinImage, identity, pathOpts, {}).find(
			(info) => info.quality === DERIVED && info.extension === alternate,
		);
		expect(early?.file_exist).toBe(true);
		expect(early?.file_time?.year).toBe(2020);

		const outcome = await deleteAndResyncCore(twinImage, identity, pathOpts, MODIFIED, 'tif');

		expect(outcome.rebuilt.length).toBeGreaterThan(0);
		// The twin is still indexed…
		const entry = outcome.filesInfo.find(
			(info) => info.quality === DERIVED && info.extension === alternate,
		);
		expect(entry?.file_exist).toBe(true);
		// …it depicts the master that SURVIVED the delete…
		expect(await depicts(twin)).toBe('red');
		// …and the returned entry describes THOSE bytes, not the ones the delete left
		// behind. This is the ordering assertion: a scan taken above the rebuild call
		// reports the 2020 stamp it just read from disk.
		expect(entry?.file_time?.year).toBe(new Date(statSync(twin).mtime).getFullYear());
		expect(entry?.file_time?.year).not.toBe(2020);
		expect(entry?.file_size).toBe(statSync(twin).size);
		// The two moments really are distinguishable — if the rebuild happened to
		// produce byte-identical output the size clause above would prove nothing,
		// so the stamp is what carries it and the size rides along.
		expect([staleSize, entry?.file_size]).toEqual([staleSize, statSync(twin).size]);
	});

	test('the whole retouched TIER can be deleted (delete_quality) and rebuilds too', async () => {
		const identity = nextIdentity();
		await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red');
		await makeImage(pathOf(identity, MODIFIED, 'tif'), 'blue');
		await regenerateImage(image, identity, pathOpts, 'tif');

		const outcome = await deleteAndResyncCore(image, identity, pathOpts, MODIFIED, null);

		expect(outcome.moved.length).toBeGreaterThan(0);
		expect(outcome.rebuilt.length).toBeGreaterThan(0);
		expect(await depicts(pathOf(identity, DERIVED, image.defaultExtension))).toBe('red');
	});

	test('deleting the ORIGINAL while a retouch survives rebuilds NOTHING', async () => {
		// The retouch was ALREADY the source, so the resolved master file is the
		// same before and after. Measured before this guard: 3 files rebuilt and
		// the derived tier lossily re-encoded on a delete that changed nothing.
		const identity = nextIdentity();
		await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red');
		await makeImage(pathOf(identity, MODIFIED, 'tif'), 'blue');
		await regenerateImage(image, identity, pathOpts, 'tif');
		const derivedPath = pathOf(identity, DERIVED, image.defaultExtension);
		const before = statSync(derivedPath).mtimeMs;

		const outcome = await deleteAndResyncCore(
			image,
			identity,
			pathOpts,
			image.originalQuality,
			'tif',
		);

		expect(outcome.rebuilt).toEqual([]);
		expect(statSync(derivedPath).mtimeMs).toBe(before);
		expect(await depicts(derivedPath)).toBe('blue');
	});

	test('removing a LOWER-PRECEDENCE extension of a master rebuilds NOTHING', async () => {
		// The same FILE resolves as master before and after — the master resolution
		// prefers the default extension, so a '.tif' sitting beside the '.jpg' the
		// engine actually reads is not what any tier was built from. Nothing to
		// re-source. Measured before the guard: 3 files rebuilt, and a derived tier
		// an operator had rotated to portrait came back landscape.
		const identity = nextIdentity();
		await makeImage(pathOf(identity, image.originalQuality, image.defaultExtension), 'red');
		await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red'); // lower precedence
		await regenerateImage(image, identity, pathOpts);
		const derivedPath = pathOf(identity, DERIVED, image.defaultExtension);
		// Operator work that lives ONLY in the derived tier: a portrait rotation.
		await makeImage(derivedPath, 'red', '600x900');
		const before = await dimensions(derivedPath);

		const outcome = await deleteAndResyncCore(
			image,
			identity,
			pathOpts,
			image.originalQuality,
			'tif',
		);

		expect(outcome.rebuilt).toEqual([]);
		expect(await dimensions(derivedPath)).toBe(before);
	});

	test('deleting the LAST master LEAVES the derived tiers standing (never wipes them)', async () => {
		const identity = nextIdentity();
		await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red');
		await regenerateImage(image, identity, pathOpts, 'tif');
		const derivedPath = pathOf(identity, DERIVED, image.defaultExtension);
		expect(await depicts(derivedPath)).toBe('red');

		const outcome = await deleteAndResyncCore(
			image,
			identity,
			pathOpts,
			image.originalQuality,
			'tif',
		);

		expect(outcome.rebuilt).toEqual([]);
		expect(outcome.errors).toEqual([]);
		// They are all that is left of this record's image — still there, still honest.
		expect(existsSync(derivedPath)).toBe(true);
		expect(await depicts(derivedPath)).toBe('red');
	});

	test('deleting a DERIVATIVE tier rebuilds nothing (only masters re-source)', async () => {
		const identity = nextIdentity();
		await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red');
		await regenerateImage(image, identity, pathOpts, 'tif');
		const derivedPath = pathOf(identity, DERIVED, image.defaultExtension);

		const outcome = await deleteAndResyncCore(
			image,
			identity,
			pathOpts,
			DERIVED,
			image.defaultExtension,
		);

		expect(outcome.rebuilt).toEqual([]);
		expect(existsSync(derivedPath)).toBe(false);
	});

	/**
	 * The delete-time drawing reset rides this census: the SVG envelope AND the
	 * stored drawing (`lib_data`/`svg_file_data`) go only when NO file of any
	 * quality remains. Deleting one tier — even the master — leaves a picture, so
	 * the layers stay (they are re-pointed, never discarded, by a rebuild).
	 */
	test('noMediaFilesLeft is TRUE only when the delete took the last file of ANY quality', async () => {
		const identity = nextIdentity();
		await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red');
		await regenerateImage(image, identity, pathOpts, 'tif');

		// The web tier and the thumb still depict the object.
		const master = await deleteAndResyncCore(
			image,
			identity,
			pathOpts,
			image.originalQuality,
			'tif',
		);
		expect(master.noMediaFilesLeft).toBe(false);

		const web = await deleteAndResyncCore(
			image,
			identity,
			pathOpts,
			image.defaultQuality,
			image.defaultExtension,
		);
		expect(web.noMediaFilesLeft).toBe(false); // the thumb is still there

		const thumb = await deleteAndResyncCore(
			image,
			identity,
			pathOpts,
			config.media.thumb.quality,
			config.media.thumb.extension,
		);
		expect(thumb.noMediaFilesLeft).toBe(true);
		expect(thumb.filesInfo.every((info) => info.file_exist !== true)).toBe(true);
	});

	test('a master tier that still holds another extension re-sources FROM IT', async () => {
		// Deleting the file the tiers WERE built from, while the same tier still
		// holds a lower-precedence twin: the tier is still a master, the resolved
		// file changed, so the derived tiers follow the twin.
		const identity = nextIdentity();
		await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red');
		await makeImage(pathOf(identity, MODIFIED, image.defaultExtension), 'blue');
		await makeImage(pathOf(identity, MODIFIED, 'png'), 'green');
		await regenerateImage(image, identity, pathOpts);
		expect(await depicts(pathOf(identity, DERIVED, image.defaultExtension))).toBe('blue');

		const outcome = await deleteAndResyncCore(
			image,
			identity,
			pathOpts,
			MODIFIED,
			image.defaultExtension,
		);

		expect(outcome.rebuilt.length).toBeGreaterThan(0);
		expect(await depicts(pathOf(identity, DERIVED, image.defaultExtension))).toBe('green');
	});
});

/**
 * A MASTER IS AUTHORED, NEVER GENERATED. Without the refusal the panel's build
 * gear on the retouched row resolved the retouch as its OWN source and rewrote
 * it: measured, jpeg quality 100 / 3 169 136 bytes → the then-default quality 82 / 1 798 308
 * bytes. The client only hides the gear for the literal 'original', so the
 * server is the chokepoint.
 */
/**
 * THE NORMALIZED MASTER COPY (2026-10-23) — the Original law's other half: a
 * master tier holds the raw upload AND a browser-viewable `<id>.<defaultExt>`.
 * No writer existed in the TS engine, so a `.tif` original had no displayable
 * form (the client's quality selector filters by the default extension and hid
 * the tier entirely). The writer is `buildMasterNormalizedCopy`, driven by the
 * INGEST (which knows the tier and the extension that just landed) and by
 * repair; these are the properties it must never lose.
 */
describe.if(HAVE_MAGICK)(
	'the normalized master copy — the displayable half of a raw master',
	() => {
		const hash = (path: string): string =>
			createHash('sha256').update(readFileSync(path)).digest('hex');
		const buildCopy = async (identity: MediaIdentity, tier: string): Promise<string | null> =>
			await buildMasterNormalizedCopy(image, identity, tier, pathOpts, {
				rawExtension: 'tif',
				rebuild: true,
			});

		test('a .tif master gains the copy, which depicts the RAW', async () => {
			const identity = nextIdentity();
			const raw = pathOf(identity, image.originalQuality, 'tif');
			await makeImage(raw, 'red');
			const copy = await buildCopy(identity, image.originalQuality);
			expect(copy).toBe(pathOf(identity, image.originalQuality, image.defaultExtension));
			expect(existsSync(copy as string)).toBe(true);
			expect(await depicts(copy as string)).toBe('red');
			// THE COPY IS NOT THE SOURCE: naming the raw still resolves it as the master
			// (a flattened jpg would lose the alpha the twin builder exists for).
			expect(resolveMasterSource(image, identity, pathOpts, 'tif')).toBe(raw);
		});

		test('the copy is NEVER its own source', async () => {
			const identity = nextIdentity();
			await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red');
			const first = await buildCopy(identity, image.originalQuality);
			const before = hash(first as string);
			await buildCopy(identity, image.originalQuality);
			// Re-encoding the jpg from itself loses a generation and changes the bytes;
			// a rebuild from the tier's raw is deterministic and must not.
			expect(hash(first as string)).toBe(before);
		});

		test('deleting the copy does not resurrect it; deleting the RAW leaves it and rebuilds NOTHING', async () => {
			const identity = nextIdentity();
			await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red');
			await regenerateImage(image, identity, pathOpts, 'tif');
			const copy = pathOf(identity, image.originalQuality, image.defaultExtension);
			const raw = pathOf(identity, image.originalQuality, 'tif');
			const derived = pathOf(identity, DERIVED, image.defaultExtension);
			await buildCopy(identity, image.originalQuality);

			// A per-file delete MEANS delete: the raw survives, the copy does not come
			// back from the delete-rebuild pass (repair is what restores it — see
			// media_files_info_repair.test.ts).
			await deleteAndResyncCore(
				image,
				identity,
				pathOpts,
				image.originalQuality,
				image.defaultExtension,
			);
			expect(existsSync(copy)).toBe(false);
			expect(existsSync(raw)).toBe(true);

			// With the copy present, removing the RAW changes nothing about the picture
			// (the copy depicts the same object), so no tier is re-sourced — a rebuild
			// here would re-encode every tier from a jpg and discard operator rotations.
			await buildCopy(identity, image.originalQuality);
			const before = statSync(derived).mtimeMs;
			const outcome = await deleteAndResyncCore(
				image,
				identity,
				pathOpts,
				image.originalQuality,
				'tif',
			);
			expect(outcome.rebuilt).toEqual([]);
			expect(existsSync(copy)).toBe(true);
			expect(statSync(derived).mtimeMs).toBe(before);
		});
	},
);

describe.if(HAVE_MAGICK)('build_version refuses a master target', () => {
	test('every master tier of every type is refused', async () => {
		for (const spec of [
			image,
			av,
			pdf,
			mediaTypeOf('component_svg')!,
			mediaTypeOf('component_3d')!,
		]) {
			for (const master of spec.masterQualities) {
				await expect(
					buildVersionCore(spec, nextIdentity(), pathOpts, master, 'tif'),
				).rejects.toThrow(/is a MASTER tier, not a derivative/);
			}
		}
	});

	test('the retouched master is BYTE-IDENTICAL after a refused build', async () => {
		const identity = nextIdentity();
		await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red');
		const retouch = pathOf(identity, MODIFIED, image.defaultExtension);
		await makeImage(retouch, 'blue');
		const before = statSync(retouch).size;

		await expect(buildVersionCore(image, identity, pathOpts, MODIFIED)).rejects.toThrow(
			/MASTER tier/,
		);

		expect(statSync(retouch).size).toBe(before);
		expect(await depicts(retouch)).toBe('blue');
	});

	test('a real DERIVATIVE tier still builds (the refusal is not a blanket)', async () => {
		const identity = nextIdentity();
		await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red');
		const built = await buildVersionCore(image, identity, pathOpts, DERIVED, 'tif');
		// THE TIER IS BUILT COMPLETE (2026-08-07): its normalized file plus every
		// configured twin. A tier minted on demand must not arrive half-built, or the
		// ⟺ invariant is false the moment it is created and the next master change
		// retires a twin nobody ever built. (This asserted `1` while nothing in src/
		// could write a twin at all.)
		expect(built.built.length).toBe(1 + image.alternateExtensions.length);
		expect(built.errors).toEqual([]);
		expect(await depicts(pathOf(identity, DERIVED, image.defaultExtension))).toBe('red');
		for (const alternate of image.alternateExtensions) {
			const twin = pathOf(identity, DERIVED, alternate);
			expect([alternate, existsSync(twin)]).toEqual([alternate, true]);
			expect([alternate, await depicts(twin)]).toEqual([alternate, 'red']);
		}
	});
});

/**
 * THE RE-ENCODE PASS REPLACES BYTES THE ENGINE DID NOT NECESSARILY AUTHOR —
 * tool_image_rotation rotates and crops the DERIVED tiers in place, and an
 * operator can park a curated file in any tier. The tiers must end up honest AND
 * the previous bytes must survive, so they go to the sibling deleted/ first.
 */
describe.if(HAVE_MAGICK)('what the re-encode pass replaces stays recoverable', () => {
	test('the previous higher-tier bytes are in deleted/, not gone', async () => {
		const identity = nextIdentity();
		await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red');
		const higher = higherTier();
		const higherPath = pathOf(identity, higher, image.defaultExtension);
		await makeImage(higherPath, 'green'); // curated by hand / rotated by the operator

		await makeImage(pathOf(identity, MODIFIED, 'tif'), 'blue');
		await regenerateImage(image, identity, pathOpts, 'tif');

		// The tier is honest…
		expect(await depicts(higherPath)).toBe('blue');
		// …and the operator's file is one move away, under the No-hard-delete name.
		const deletedDir = `${higherPath.slice(0, higherPath.lastIndexOf('/'))}/deleted`;
		// The tier dir is shared by every identity in this file, so filter by stem.
		const stem = `test99_test3_${identity.sectionId}_deleted_`;
		const backups = readdirSync(deletedDir).filter((name) => name.startsWith(stem));
		expect(backups.length).toBe(1);
		expect(await depicts(`${deletedDir}/${backups[0]}`)).toBe('green');
	});

	/**
	 * THE ASSERTION HERE FLIPPED ON 2026-08-07, and the history is the point.
	 *
	 * It used to read "a stale ALTERNATE-extension twin is RETIRED to deleted/,
	 * never left serving", because `DEDALO_*_ALTERNATIVE_EXTENSIONS` was read by
	 * seven modules and written by none: v6's create_alternative_version was never
	 * ported, so a twin on disk came from v6 or from an operator, and after a master
	 * change the engine could not rebuild it. Retiring it was the honest half of
	 * v6's own retire-then-rebuild loop — the record lost a format rather than
	 * keeping a file that depicted a master it no longer had (measured: 6MB.jpg went
	 * blue while 6MB.avif stayed red, and files_info reported both as current).
	 *
	 * Now the engine BUILDS them, so the same fixture must come out REBUILT. The
	 * retirement did not go away: it is the branch below it — a twin with no tier
	 * file to accompany, and the failure branch on a host that cannot encode the
	 * format — which is why the three tests are kept together.
	 */
	test('a stale twin in the DEFAULT tier is REBUILT from the new master', async () => {
		const alternate = ALT;
		expect(twinImage.alternateExtensions).toEqual([alternate]);
		const identity = nextIdentity();
		await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red');
		await regenerateImage(twinImage, identity, pathOpts, 'tif');
		// A v6-era twin depicting the master that is about to be superseded.
		const twin = pathOf(identity, DERIVED, alternate);
		await makeImage(twin, 'red');

		await makeImage(pathOf(identity, MODIFIED, 'tif'), 'blue');
		await regenerateImage(twinImage, identity, pathOpts, 'tif');

		// It depicts the CURRENT best master, in step with the tier it accompanies.
		expect(existsSync(twin)).toBe(true);
		expect(await depicts(twin)).toBe('blue');
		expect(await depicts(pathOf(identity, DERIVED, image.defaultExtension))).toBe('blue');
		// …and it is indexed, so the panel's cell opens the picture the record has.
		expect(
			scanFilesInfo(twinImage, identity, pathOpts, {}).some(
				(info) => info.quality === DERIVED && info.extension === alternate && info.file_exist,
			),
		).toBe(true);
		// NO deleted/ CHURN in the default tier. The conditional-backup rule is the
		// exact test for "could a human have put this file here?":
		// assertNormalizedExtensionForTier admits an upload into a derived tier only
		// for [defaultExtension, ...alternateExtensions], and assertAllowedExtension
		// additionally requires the UPLOAD allowlist — which `twinImage` refuses for this
		// format. The default tier is rebuilt on EVERY master ingest, so backing up a
		// machine-authored twin there would turn every upload on the install into
		// deleted/ churn for bytes nobody authored.
		expect(twinImage.allowedExtensions).not.toContain(alternate);
		const deletedDir = `${twin.slice(0, twin.lastIndexOf('/'))}/deleted`;
		const churn = existsSync(deletedDir)
			? readdirSync(deletedDir).filter(
					(name) =>
						name.startsWith(`test99_test3_${identity.sectionId}_deleted_`) &&
						name.endsWith(`.${alternate}`),
				)
			: [];
		expect(churn).toEqual([]);
	});

	test('a HIGHER-tier twin is rebuilt AND its previous bytes land in deleted/', async () => {
		// Higher tiers are minted on demand and an operator may have curated or
		// rotated them, so — unlike the default tier — every replacement is backed up
		// first. Same rule, and the same reason, as their jpg (see regenerateImage).
		const alternate = ALT;
		const identity = nextIdentity();
		const higher = higherTier();
		await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red');
		// The tier exists, so the twin is a companion the engine keeps in step.
		await makeImage(pathOf(identity, higher, image.defaultExtension), 'red');
		await regenerateImage(twinImage, identity, pathOpts, 'tif');
		const twin = pathOf(identity, higher, alternate);
		expect(existsSync(twin)).toBe(true);
		expect(await depicts(twin)).toBe('red');

		await makeImage(pathOf(identity, MODIFIED, 'tif'), 'blue');
		await regenerateImage(twinImage, identity, pathOpts, 'tif');

		expect(await depicts(twin)).toBe('blue');
		const deletedDir = `${twin.slice(0, twin.lastIndexOf('/'))}/deleted`;
		const backups = readdirSync(deletedDir).filter(
			(name) =>
				name.startsWith(`test99_test3_${identity.sectionId}_deleted_`) &&
				name.endsWith(`.${alternate}`),
		);
		expect(backups.length).toBe(1);
		expect(await depicts(`${deletedDir}/${backups[0]}`)).toBe('red');
	});

	test('a twin with NO tier file to accompany is still RETIRED, never left serving', async () => {
		// The other direction of the ⟺ invariant, and the branch the whole
		// pre-2026-08-07 behaviour collapsed into. It is not tidiness: one
		// delete_version('6MB','jpg') click leaves the twin behind, and nothing would
		// ever touch it again — indexed, openable, depicting a master the tier no
		// longer has.
		const alternate = ALT;
		const identity = nextIdentity();
		const higher = higherTier();
		await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red');
		const orphan = pathOf(identity, higher, alternate);
		await makeImage(orphan, 'green'); // a twin whose tier holds no jpg at all
		expect(existsSync(pathOf(identity, higher, image.defaultExtension))).toBe(false);

		await makeImage(pathOf(identity, MODIFIED, 'tif'), 'blue');
		await regenerateImage(twinImage, identity, pathOpts, 'tif');

		// Gone from the tier…
		expect(existsSync(orphan)).toBe(false);
		// …never destroyed: it is one move away, under the No-hard-delete name.
		const deletedDir = `${orphan.slice(0, orphan.lastIndexOf('/'))}/deleted`;
		const retired = readdirSync(deletedDir).filter(
			(name) =>
				name.startsWith(`test99_test3_${identity.sectionId}_deleted_`) &&
				name.endsWith(`.${alternate}`),
		);
		expect(retired.length).toBe(1);
		expect(await depicts(`${deletedDir}/${retired[0]}`)).toBe('green');
		// …and the scan stops reporting a file that depicts a master the record lost.
		expect(
			scanFilesInfo(twinImage, identity, pathOpts, {}).some(
				(info) => info.quality === higher && info.extension === alternate && info.file_exist,
			),
		).toBe(false);
		// The absent tier itself was NOT minted to satisfy the invariant: tiers stay
		// on demand, so the honest outcome is one fewer file, not one more.
		expect(existsSync(pathOf(identity, higher, image.defaultExtension))).toBe(false);
	});

	test('a MASTER tier is never re-encoded or retired by the pass', async () => {
		const alternate = ALT;
		const identity = nextIdentity();
		await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red');
		const masterTwin = pathOf(identity, image.originalQuality, alternate);
		await makeImage(masterTwin, 'green'); // a twin IN a master tier
		await makeImage(pathOf(identity, MODIFIED, 'tif'), 'blue');

		await regenerateImage(twinImage, identity, pathOpts, 'tif');

		expect(await depicts(pathOf(identity, image.originalQuality, 'tif'))).toBe('red');
		expect(existsSync(masterTwin)).toBe(true);
		expect(await depicts(masterTwin)).toBe('green');
		expect(await depicts(pathOf(identity, MODIFIED, 'tif'))).toBe('blue');
	});
});

/**
 * THE PRECEDENCE NOTICE. It exists for ONE case — a master was written but a
 * different one outranks it — and a line that also fires on every ordinary
 * upload is a line nobody reads.
 */
describe.if(HAVE_MAGICK)('noteOutrankingMaster only speaks when it must', () => {
	function captureInfo(): { lines: string[]; restore: () => void } {
		const lines: string[] = [];
		const original = console.info;
		console.info = (...args: unknown[]): void => {
			lines.push(args.map(String).join(' '));
		};
		return { lines, restore: () => (console.info = original) };
	}

	test('SILENT when the tier just written IS the resolved master', async () => {
		const identity = nextIdentity();
		await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red');
		const captured = captureInfo();
		try {
			noteOutrankingMaster(image, identity, pathOpts, image.originalQuality, 'uploaded');
		} finally {
			captured.restore();
		}
		expect(captured.lines).toEqual([]);
	});

	test('NAMES THE RECORD when a retouch outranks the original just written', async () => {
		const identity = nextIdentity();
		await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red');
		await makeImage(pathOf(identity, MODIFIED, 'tif'), 'blue');
		const captured = captureInfo();
		try {
			noteOutrankingMaster(image, identity, pathOpts, image.originalQuality, 'uploaded');
		} finally {
			captured.restore();
		}
		expect(captured.lines.length).toBe(1);
		expect(captured.lines[0]).toContain(`test99_test3_${identity.sectionId}`);
		expect(captured.lines[0]).toContain(MODIFIED);
	});
});

/**
 * ROTATION. The archival original is the invariant this file must hold; the
 * RETOUCHED master is rotated in place on purpose (v6 tool_image_rotation :190
 * skips the literal 'original' and nothing else), because that is the only way a
 * rotation survives the next master change — see tools/rotation.ts.
 */
describe.if(HAVE_MAGICK)('tool_image_rotation and the two masters', () => {
	test('the ARCHIVAL ORIGINAL is never rotated; the RETOUCH is', async () => {
		const identity = nextIdentity();
		const originalPath = pathOf(identity, image.originalQuality, image.defaultExtension);
		const retouchPath = pathOf(identity, MODIFIED, image.defaultExtension);
		const derivedPath = pathOf(identity, DERIVED, image.defaultExtension);
		await makeImage(originalPath, 'red');
		await makeImage(retouchPath, 'blue');
		await makeImage(derivedPath, 'blue');

		await applyRotationCore(
			image,
			identity,
			pathOpts,
			[
				{ quality: image.originalQuality, extension: image.defaultExtension },
				{ quality: MODIFIED, extension: image.defaultExtension },
				{ quality: DERIVED, extension: image.defaultExtension },
			],
			{ degrees: 90 },
		);

		// The archival master is byte-for-byte what it was…
		expect(await dimensions(originalPath)).toBe('900x600');
		// …while the RETOUCHED master turned with the derived tiers ('expanded'
		// mode grows the canvas, so the exact numbers are ImageMagick's, not 600x900).
		const rotated = await dimensions(derivedPath);
		expect(rotated).not.toBe('900x600');
		expect(await dimensions(retouchPath)).toBe(rotated);
	});
});

/**
 * THE REPORTED DEFECT, end to end. "Importing with the target quality set to
 * 'modified' fails per file" — tool_import_files / tool_upload / the MCP media
 * tool all funnel into processUploadedFile with `quality`, so the ingest
 * orchestrator is where the report is reproduced and fixed.
 */
describe.if(HAVE_MAGICK)('ingesting into the retouched tier', () => {
	const USER_ID = 7;
	const KEY_DIR = 'kdtwomasters';

	/** Stage a real image of `color` in the upload tmp dir under `tmpName`. */
	async function stage(tmpName: string, color: string): Promise<void> {
		await makeImage(`${stagingDir(USER_ID, KEY_DIR, ROOT)}/${tmpName}`, color);
	}

	test('a .tif retouch is ACCEPTED and lands in the retouched tier', async () => {
		const identity = nextIdentity();
		await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red');
		await stage('retouch1.tif', 'blue');

		const result = await processUploadedFile({
			spec: image,
			identity,
			pathOpts,
			userId: USER_ID,
			keyDir: KEY_DIR,
			tmpName: 'retouch1.tif',
			extension: 'tif',
			quality: MODIFIED,
		});

		// No per-file error, and the raw master is on disk where it was asked for.
		expect(result.derivativeErrors).toEqual([]);
		expect(result.extension).toBe('tif');
		expect(existsSync(pathOf(identity, MODIFIED, 'tif'))).toBe(true);
		expect(await depicts(pathOf(identity, MODIFIED, 'tif'))).toBe('blue');
	});

	test('the raw .tif retouch is INDEXED by the scan (not stored invisibly)', async () => {
		const identity = nextIdentity();
		await stage('retouch2.tif', 'blue');

		const result = await processUploadedFile({
			spec: image,
			identity,
			pathOpts,
			userId: USER_ID,
			keyDir: KEY_DIR,
			tmpName: 'retouch2.tif',
			extension: 'tif',
			quality: MODIFIED,
		});

		// scanFilesInfo walks every quality across the whole upload allowlist, so a
		// raw master needs no normalized twin to be visible to the record. If this
		// ever regresses, the retouch is stored but invisible — the same class of
		// defect as refusing it outright.
		const entry = result.filesInfo.find(
			(info) => info.quality === MODIFIED && info.extension === 'tif',
		);
		expect(entry).toBeDefined();
		expect(entry?.file_exist).toBe(true);
	});

	test('a retouch RE-ENCODES the derived tiers that ALREADY EXIST', async () => {
		const identity = nextIdentity();
		await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red');
		await regenerateImage(image, identity, pathOpts, 'tif');
		const derivedPath = pathOf(identity, DERIVED, image.defaultExtension);
		const thumbPath = pathOf(identity, config.media.thumb.quality, config.media.thumb.extension);
		expect(await depicts(derivedPath)).toBe('red');
		expect(await depicts(thumbPath)).toBe('red');

		await stage('retouch3.tif', 'blue');
		const result = await processUploadedFile({
			spec: image,
			identity,
			pathOpts,
			userId: USER_ID,
			keyDir: KEY_DIR,
			tmpName: 'retouch3.tif',
			extension: 'tif',
			quality: MODIFIED,
		});

		expect(result.derivativeErrors).toEqual([]);
		// Decision 2: everything derived now depicts the retouch, overwritten in place.
		expect(await depicts(derivedPath)).toBe('blue');
		expect(await depicts(thumbPath)).toBe('blue');
		// The SVG envelope the edit view renders through exists too (without it the
		// client falls back to the placeholder and the image never shows).
		expect(existsSync(svgOverlayLocation(image, identity, pathOpts).absolutePath)).toBe(true);
	});

	test('a retouch leaves the ARCHIVAL tier alone — it adds a master, never moves one', async () => {
		const identity = nextIdentity();
		await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red');
		await stage('retouch4.tif', 'blue');

		const result = await processUploadedFile({
			spec: image,
			identity,
			pathOpts,
			userId: USER_ID,
			keyDir: KEY_DIR,
			tmpName: 'retouch4.tif',
			extension: 'tif',
			quality: MODIFIED,
		});

		// The original is still there, still the original picture, still indexed.
		expect(await depicts(pathOf(identity, image.originalQuality, 'tif'))).toBe('red');
		expect(
			result.filesInfo.some(
				(info) => info.quality === image.originalQuality && info.file_exist === true,
			),
		).toBe(true);
		// The OTHER half of the isOriginal/isMaster split — that a retouch keeps the
		// record's STORED cues (external_source, the normalized-name twins) — needs a
		// component that actually STORES some. It is NOT gated end to end; see
		// replacesArchivalCue for why the module-mock route is unreliable in this
		// suite and what the durable gate would be.
	});

	test('a .tif into a REAL derivative tier is still refused BEFORE the move', async () => {
		const identity = nextIdentity();
		await stage('shadowed.tif', 'blue');

		await expect(
			processUploadedFile({
				spec: image,
				identity,
				pathOpts,
				userId: USER_ID,
				keyDir: KEY_DIR,
				tmpName: 'shadowed.tif',
				extension: 'tif',
				quality: DERIVED,
			}),
		).rejects.toThrow(/would be shadowed/);
		// Refused before add_file moved anything: staging intact, media tree clean.
		expect(existsSync(`${stagingDir(USER_ID, KEY_DIR, ROOT)}/shadowed.tif`)).toBe(true);
		expect(existsSync(pathOf(identity, DERIVED, 'tif'))).toBe(false);
	});
});
