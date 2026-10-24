/**
 * THE ALTERNATE-EXTENSION TWIN GATE (2026-08-07).
 *
 * `DEDALO_*_ALTERNATIVE_EXTENSIONS` was read by seven modules and written by
 * NONE: v6's `component_image::create_alternative_version` was never ported, so
 * the engine scanned for, indexed and advertised files nothing could produce.
 * That is *config read but never honoured* — the exact defect class this suite
 * exists to keep closed.
 *
 * WHAT A TWIN IS (processing.ts buildAlternateVersions owns the rule): a per-tier
 * COMPANION of that tier's normalized file — same picture, same tier, other
 * container. The invariant, in the direction the engine holds at ALL times,
 *
 *     exists(Q/<id>.<E>)  ⇒  exists(Q/<id>.<defaultExtension>)   for every derived Q
 *
 * — enforced by the reconciler AND by every path that REMOVES a companion (a
 * delete changes no master, so the reconciler never runs on it). The converse is
 * a reconciliation, not a disk state: a twin may legitimately be absent.
 *
 * and the source is always the MASTER, never the sibling jpg.
 *
 * THESE ASSERTIONS ARE ABOUT CONTENT AND ALPHA, not existence. The fixtures are
 * flat colours (which master does this file depict?) and a half-transparent
 * master (did the cut-out survive into the twin?), because "a file is there" is
 * precisely what the broken engine already satisfied.
 *
 * EVERY TEST HERE FAILS ON THE PRE-BUILDER TREE except A4/A5/A6, which are
 * DECISION PINS: they pass today by construction and are here so that the three
 * deliberate NON-builds (a twin with no companion is retired, masters never get
 * one, the thumb never gets one) cannot be quietly turned into builds later.
 * Each says so at its own describe block — they are not dead weight.
 */
// MIGRATED TO THE GENERIC `test` TLD, 2026-08-19: every install tipo this gate
// spelled is now its generic twin (sections on the `test` TLD, storing in
// matrix_test). A pure rename — the tipo is an identifier in a path, a filename
// or a locator here, so no corpus and no DB round-trip were added.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { config } from '../../src/config/config.ts';
import { type MediaTypeSpec, mediaTypeOf } from '../../src/core/concepts/media.ts';
import {
	canWriteImageFormat,
	getDimensions,
	resolveMagick,
} from '../../src/core/media/engine/imagemagick.ts';
import { runBinary } from '../../src/core/media/engine/spawn.ts';
import { duplicateMediaFiles } from '../../src/core/media/file_ops.ts';
import { scanFilesInfo } from '../../src/core/media/files_info.ts';
import {
	buildMediaLocation,
	type MediaIdentity,
	type MediaPathOptions,
} from '../../src/core/media/path.ts';
import {
	buildAlternateVersions,
	buildPdfCovers,
	derivedTwinQualities,
	regenerateImage,
} from '../../src/core/media/processing.ts';
import { regenerateMissingDerivatives } from '../../src/core/media/repair.ts';
import { svgOverlayLocation } from '../../src/core/media/svg_overlay.ts';
import { applyRotationCore } from '../../src/core/media/tools/rotation.ts';
import { buildVersionCore, deleteAndResyncCore } from '../../src/core/media/tools/versions.ts';
import { magickTestEnv } from '../helpers/magick_test_env.ts';
import { markMediaRoot } from '../helpers/media_scratch_root.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const ROOT = scratchDir('alternate_versions');
const image = mediaTypeOf('component_image') as MediaTypeSpec;
const pdf = mediaTypeOf('component_pdf') as MediaTypeSpec;
const HAVE_MAGICK = existsSync(resolveMagick());
const GS_BIN =
	['/opt/homebrew/bin/gs', '/usr/bin/gs', '/usr/local/bin/gs'].find((path) => existsSync(path)) ??
	'gs';
const HAVE_GS = existsSync(GS_BIN);
const pathOpts: MediaPathOptions = { initialMediaPath: '', maxItemsFolder: null, mediaRoot: ROOT };

/** The retouched master tier as this install names it — never the literal. */
const MODIFIED = config.media.imageQualityRetouched;
/** The tier every ingest rebuilds: the twin's default home. */
const DERIVED = image.defaultQuality;
const THUMB = config.media.thumb.quality;

/**
 * A frozen COPY of a spec with a different alternate list.
 *
 * The only honest way to exercise a format this install does not configure:
 * `config` is read once and frozen at boot and `mediaTypeOf` memoizes its spec,
 * so mutating either would leak into every other suite in the process. A clone
 * carries the same folder/ladder/paths, so the code under test cannot tell it
 * from the real thing.
 */
function withAlternates(spec: MediaTypeSpec, extensions: readonly string[]): MediaTypeSpec {
	return Object.freeze({
		...spec,
		alternateExtensions: Object.freeze([...extensions]),
		// `managedExtensions` is what every ENUMERATION reads (files_info,
		// duplicateMediaFiles), so a clone that changed only the built list would be
		// scanned with the real install's extensions and the gate would measure the
		// wrong thing. Rebuilt here the way concepts/media.ts does: default first.
		managedExtensions: Object.freeze([
			...new Set([spec.defaultExtension, ...spec.allowedExtensions, ...extensions]),
		]),
	}) as MediaTypeSpec;
}

/**
 * `spec` with `extension` ADMITTED to (or REFUSED from) the upload allowlist —
 * the only input `shouldBackUpTwin` reads to decide "could a human have put
 * this file here?". BUILT, never borrowed: the shipped default admits avif
 * (`DEDALO_IMAGE_EXTENSIONS_SUPPORTED`), so a gate that took the install's
 * allowlist asserted a machine-only avif it did not have. `managedExtensions`
 * is left as is — enumeration must still see the twin.
 */
function withUpload(spec: MediaTypeSpec, extension: string, admitted: boolean): MediaTypeSpec {
	const others = spec.allowedExtensions.filter((value) => value !== extension);
	return Object.freeze({
		...spec,
		allowedExtensions: Object.freeze(admitted ? [...others, extension] : others),
	}) as MediaTypeSpec;
}

/**
 * The pdf twin of the above. `coverExtensions` is rebuilt exactly as
 * concepts/media.ts coverExtensionsFor does it — the canonical jpg FIRST, then
 * the configured alternates — so an emptied key still yields ['jpg'].
 */
function withPdfAlternates(extensions: readonly string[]): MediaTypeSpec {
	const covers = ['jpg', ...extensions].filter((value, index, all) => all.indexOf(value) === index);
	return Object.freeze({
		...pdf,
		alternateExtensions: Object.freeze([...extensions]),
		coverExtensions: Object.freeze(covers),
		managedExtensions: Object.freeze([
			...new Set([pdf.defaultExtension, ...pdf.allowedExtensions, ...extensions, ...covers]),
		]),
	}) as MediaTypeSpec;
}

/**
 * The alternate extension the twin tests drive.
 *
 * On this install `DEDALO_IMAGE_ALTERNATIVE_EXTENSIONS=avif`, so `twinImage` IS
 * the shipped spec. On a stock install the key defaults to `[]` (Q1: the shipped
 * default is deliberately unchanged), and a suite that read the config alone
 * would then assert nothing at all while reporting green — the failure mode the
 * testing skill calls the green-suite trap. The clone makes the gate assert the
 * BUILDER's behaviour either way.
 */
const ALT = image.alternateExtensions[0] ?? 'avif';
const twinImage = image.alternateExtensions.length > 0 ? image : withAlternates(image, [ALT]);
/** A spec that configures NO twin — used to build a tier that has none yet. */
const noTwinImage = withAlternates(image, []);
/**
 * A format this ImageMagick cannot write. `.jxl` is the measured case: before the
 * coder token, `magick src.png out.jxl` exited 0 with an EMPTY stderr and wrote
 * 316 bytes of PNG into a file named `.jxl` — it passed nonEmptyFile, passed the
 * scene-count post-condition, entered files_info and was served with the wrong
 * MIME. The precondition is asserted (A9) rather than assumed: on a host that
 * grows a jxl delegate this gate must be re-pointed at another unwritable
 * format, not silently pass.
 */
const UNWRITABLE = 'jxl';

let sectionId = 0;
function nextIdentity(): MediaIdentity {
	sectionId += 1;
	return { componentTipo: 'test99', sectionTipo: 'test3', sectionId, lang: null };
}
function nextPdfIdentity(): MediaIdentity {
	sectionId += 1;
	return { componentTipo: 'test85', sectionTipo: 'test3', sectionId, lang: null };
}

function pathOf(identity: MediaIdentity, quality: string, extension: string): string {
	return buildMediaLocation(image, identity, quality, extension, pathOpts).absolutePath;
}
function pdfPathOf(identity: MediaIdentity, quality: string, extension: string): string {
	return buildMediaLocation(pdf, identity, quality, extension, pathOpts).absolutePath;
}
function dirOf(path: string): string {
	return path.slice(0, path.lastIndexOf('/'));
}

/** Write a real flat-colour image at an absolute path. */
async function makeImage(absolute: string, color: string, size = '900x600'): Promise<void> {
	mkdirSync(dirOf(absolute), { recursive: true });
	const result = await runBinary([resolveMagick(), '-size', size, `xc:${color}`, absolute], {
		nice: false,
		env: magickTestEnv(),
	});
	if (result.exitCode !== 0) {
		throw new Error(`fixture build failed for ${absolute}: ${result.stderr}`);
	}
}

/**
 * A master with a REAL CUT-OUT: the top half opaque red, the bottom half fully
 * transparent, so `mean.a` is 0.5. This is the background-removal fixture — the
 * whole reported symptom is that a removal performed today shows up nowhere,
 * because every derived tier is a jpg and `backgroundForTarget` flattens it onto
 * white.
 */
async function makeAlphaMaster(absolute: string): Promise<void> {
	mkdirSync(dirOf(absolute), { recursive: true });
	const result = await runBinary(
		[
			resolveMagick(),
			'-size',
			'900x600',
			'xc:none',
			'-fill',
			'red',
			'-draw',
			'rectangle 0,0 899,299',
			absolute,
		],
		{ nice: false, env: magickTestEnv() },
	);
	if (result.exitCode !== 0) {
		throw new Error(`alpha fixture build failed for ${absolute}: ${result.stderr}`);
	}
}

/** Create a real one-page PDF via ghostscript (the cover source). */
async function makePdf(absolute: string): Promise<void> {
	mkdirSync(dirOf(absolute), { recursive: true });
	await runBinary(
		[
			GS_BIN,
			'-q',
			'-dNOPAUSE',
			'-dBATCH',
			'-sDEVICE=pdfwrite',
			'-o',
			absolute,
			'-c',
			'<< /PageSize [200 200] >> setpagedevice /Helvetica findfont 24 scalefont setfont 20 100 moveto (HELLO) show showpage',
		],
		{ nice: false },
	);
}

/** One `identify -format` read of a written file. */
async function identify(path: string, format: string): Promise<string> {
	const result = await runBinary([resolveMagick(), path, '-format', format, 'info:'], {
		nice: false,
		env: magickTestEnv(),
	});
	return result.stdout.trim();
}

/** Read one pixel as 8-bit r,g,b (the fixtures are flat, so one probe decides). */
async function centrePixel(path: string, at = 'w/2,h/2'): Promise<[number, number, number]> {
	const stdout = await identify(
		path,
		`%[fx:int(255*p{${at}}.r)],%[fx:int(255*p{${at}}.g)],%[fx:int(255*p{${at}}.b)]`,
	);
	const parts = stdout.split(',').map(Number);
	if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
		throw new Error(`cannot read pixel ${at} of ${path}: '${stdout}'`);
	}
	return [parts[0] as number, parts[1] as number, parts[2] as number];
}

/**
 * Which flat fixture colour a written derivative depicts — the content assertion.
 * `at` exists for the ALPHA master alone: its centre pixel sits exactly on the
 * 50/50 seam between the painted half and the cut-out one, so that fixture is
 * probed inside its painted band instead.
 */
async function depicts(path: string, at?: string): Promise<'red' | 'blue' | 'green' | 'other'> {
	const [r, g, b] = await centrePixel(path, at);
	if (r > 200 && g < 60 && b < 60) return 'red';
	if (b > 200 && r < 60 && g < 60) return 'blue';
	// ImageMagick's 'green' is (0,128,0), not (0,255,0) — the band is around 128.
	if (g > 100 && r < 60 && b < 60) return 'green';
	return 'other';
}

/**
 * Mean of the alpha channel, 0..1 — how much of the picture survived the cut-out.
 *
 * MEASURED on this box, and the reason `mean.a` is never used to prove OPACITY:
 * a JPEG with no alpha channel at all reports `mean.a 0`, exactly like a fully
 * transparent file. Meaningful only where an alpha plane exists; `alphaAt` and
 * `%[opaque]` are what decide opacity.
 */
async function alphaMean(path: string): Promise<number> {
	return Number(await identify(path, '%[fx:mean.a]'));
}

/** Alpha of one pixel, 0..1. An alpha-less container answers 1 (opaque). */
async function alphaAt(path: string, x: number, y: number): Promise<number> {
	return Number(await identify(path, `%[fx:p{${String(x)},${String(y)}}.a]`));
}

/** ImageMagick's own verdict on whether the file carries any transparency. */
async function isOpaque(path: string): Promise<boolean> {
	return (await identify(path, '%[opaque]')) === 'True';
}

/** The `deleted/` siblings of a tier that belong to this identity and extension. */
function deletedTwins(tierFile: string, identity: MediaIdentity, extension: string): string[] {
	const deleted = `${dirOf(tierFile)}/deleted`;
	if (!existsSync(deleted)) return [];
	// The tier dir is shared by every identity in this file, so filter by stem.
	return readdirSync(deleted).filter(
		(name) =>
			name.startsWith(`test99_test3_${String(identity.sectionId)}_deleted_`) &&
			name.endsWith(`.${extension}`),
	);
}

/** A derived tier ABOVE the default one (the '6MB'-class tiers). */
function higherTier(): string {
	const quality = image.qualities.find(
		(value) =>
			!image.masterQualities.includes(value) && value !== image.defaultQuality && value !== THUMB,
	);
	if (quality === undefined) throw new Error('this ladder has no higher derived tier');
	return quality;
}
const HIGHER = HAVE_MAGICK ? higherTier() : '';

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

describe.if(HAVE_MAGICK)(
	'A1-A3 — the twin is built, from the right source, in the right tiers',
	() => {
		test('A1: the twin depicts the CURRENT master, not the one it was born under', async () => {
			// Pre-builder: nothing ever wrote a twin, so this file does not exist at all;
			// a v6-migrated one was RETIRED here and the record was left twin-less.
			const identity = nextIdentity();
			await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red');
			await regenerateImage(twinImage, identity, pathOpts, 'tif');
			const twin = pathOf(identity, DERIVED, ALT);
			expect(existsSync(twin)).toBe(true);
			expect(await depicts(twin)).toBe('red');

			// A retouch arrives and becomes the best master.
			await makeImage(pathOf(identity, MODIFIED, 'tif'), 'blue');
			const outcome = await regenerateImage(twinImage, identity, pathOpts, 'tif');

			expect(outcome.errors).toEqual([]);
			expect(existsSync(twin)).toBe(true);
			expect(await depicts(twin)).toBe('blue');
			// …in step with the file it accompanies, which is what makes it a twin.
			expect(await depicts(pathOf(identity, DERIVED, image.defaultExtension))).toBe('blue');
		});

		test('A2: the twin is built FROM THE MASTER — the cut-out survives, the jpg is flat white', async () => {
			// THE LOAD-BEARING TEST OF THE WHOLE CHANGE. Transcoding the tier's sibling
			// jpg would be cheaper and WRONG: that file has already been composited onto
			// white by backgroundForTarget, so the alpha the twin exists to carry is gone
			// before the transcode starts. Measured on the real medal master through this
			// exact recipe — from the MASTER the avif comes out srgba / opaque=False /
			// PSNR 44.56; from the tier's jpg it comes out opaque=True / PSNR 3.31, the
			// cut-out destroyed. Both files pass every existence check, so ONLY alpha
			// tells them apart. This is also the reported symptom: a background removal
			// performed today shows up nowhere in Dédalo.
			const identity = nextIdentity();
			await makeAlphaMaster(pathOf(identity, image.originalQuality, 'png'));

			const outcome = await regenerateImage(twinImage, identity, pathOpts, 'png');
			expect(outcome.errors).toEqual([]);

			const jpg = pathOf(identity, DERIVED, image.defaultExtension);
			const twin = pathOf(identity, DERIVED, ALT);
			expect(existsSync(twin)).toBe(true);

			// The sibling jpg is flattened onto white — it CANNOT carry the removal, which
			// is why the twin exists at all.
			expect(await isOpaque(jpg)).toBe(true);
			expect(await alphaAt(jpg, 10, 500)).toBe(1);
			expect(await depicts(jpg, 'w/2,h/4')).toBe('red'); // the painted half is still the picture

			// The twin kept it: transparent where the master was cut, opaque where it was
			// painted, and half the frame overall (the fixture is a 50/50 split; the real
			// medal master measures 0.531).
			expect(await isOpaque(twin)).toBe(false);
			expect(await depicts(twin, 'w/2,h/4')).toBe('red'); // same picture, other container
			expect(await alphaAt(twin, 10, 500)).toBe(0);
			expect(await alphaAt(twin, 10, 10)).toBeGreaterThan(0.9);
			const mean = await alphaMean(twin);
			expect(mean).toBeGreaterThanOrEqual(0.3);
			expect(mean).toBeLessThanOrEqual(0.9);
		});

		test('A3: only tiers that HAVE their own file get a twin — an absent tier is not minted', async () => {
			// Twins inherit regenerateImage's standing rule: an absent tier is never
			// created. Building a 100MB derivative nobody asked for on every upload is a
			// different decision from keeping an existing one honest.
			const identity = nextIdentity();
			await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red');
			const higherJpg = pathOf(identity, HIGHER, image.defaultExtension);
			await makeImage(higherJpg, 'green'); // this tier exists

			await regenerateImage(twinImage, identity, pathOpts, 'tif');

			// Present tier → jpg re-encoded from the master AND its twin built beside it.
			expect(await depicts(higherJpg)).toBe('red');
			expect(existsSync(pathOf(identity, HIGHER, ALT))).toBe(true);
			expect(await depicts(pathOf(identity, HIGHER, ALT))).toBe('red');
			// Every other derived tier: neither file, so neither twin.
			for (const quality of derivedTwinQualities(image)) {
				if (quality === HIGHER || quality === DERIVED) continue;
				expect(existsSync(pathOf(identity, quality, image.defaultExtension))).toBe(false);
				expect(existsSync(pathOf(identity, quality, ALT))).toBe(false);
			}
		});
	},
);

/**
 * A4-A6 — THE THREE DELIBERATE NON-BUILDS.
 *
 * READ THIS BEFORE DELETING ANY OF THEM: these three PASS ON THE PRE-BUILDER
 * TREE. They are not proof that the builder works — A1/A2/A3 are. They are PINS
 * on decisions D1/D2 that a later "make twins complete" change would otherwise
 * flip silently, each with damage the pin names. They earn their place by being
 * the only mechanical statement of what a twin may NOT be.
 */
describe.if(HAVE_MAGICK)('A4-A6 — the deliberate non-builds (decision pins, green today)', () => {
	test('A4: a twin whose tier holds no file is RETIRED, never left serving [PIN]', async () => {
		// PASSES PRE-BUILDER (the 2026-08-07 stop-gap retired every twin it met).
		// Pinned because a twin must never outlive its companion: one
		// delete_version('6MB','jpg') click leaves the twin behind, and nothing would
		// ever touch it again — indexed, openable, depicting a master the tier no
		// longer has.
		const identity = nextIdentity();
		await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red');
		await regenerateImage(twinImage, identity, pathOpts, 'tif');
		// A twin in a tier that has NO jpg to accompany (a v6-era leftover).
		const orphan = pathOf(identity, HIGHER, ALT);
		await makeImage(orphan, 'green');
		expect(existsSync(pathOf(identity, HIGHER, image.defaultExtension))).toBe(false);

		await makeImage(pathOf(identity, MODIFIED, 'tif'), 'blue');
		const outcome = await regenerateImage(twinImage, identity, pathOpts, 'tif');

		expect(existsSync(orphan)).toBe(false);
		expect(outcome.retired).toContain(`${HIGHER}.${ALT}`);
		// Retired, never destroyed (No-hard-delete law) — and still the green bytes.
		const retired = deletedTwins(orphan, identity, ALT);
		expect(retired.length).toBe(1);
		expect(await depicts(`${dirOf(orphan)}/deleted/${retired[0] as string}`)).toBe('green');
		// The scan stops reporting a file the record no longer has.
		expect(
			scanFilesInfo(twinImage, identity, pathOpts, {}).some(
				(info) => info.quality === HIGHER && info.extension === ALT && info.file_exist,
			),
		).toBe(false);
	});

	test('A5: MASTER tiers never get a twin, and asking for one is REFUSED [PIN + new refusal]', async () => {
		// PIN (green pre-builder): a machine-authored file parked in a master tier
		// becomes resolvable AS THE MASTER — resolveMaster walks allowedExtensions,
		// which holds png/heic/webp — so the engine would then build every derivative
		// from a file it wrote itself. An operator's twin already sitting there is
		// left strictly alone.
		const identity = nextIdentity();
		await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red');
		const masterTwin = pathOf(identity, image.originalQuality, ALT);
		await makeImage(masterTwin, 'green');
		await makeImage(pathOf(identity, MODIFIED, 'tif'), 'blue');

		await regenerateImage(twinImage, identity, pathOpts, 'tif');

		for (const master of image.masterQualities) {
			expect(derivedTwinQualities(image)).not.toContain(master);
		}
		expect(existsSync(masterTwin)).toBe(true);
		expect(await depicts(masterTwin)).toBe('green'); // untouched, not re-encoded
		expect(existsSync(pathOf(identity, MODIFIED, ALT))).toBe(false); // none minted

		// NEW (fails pre-builder — the function did not exist): a caller that passes a
		// master tier has a wrong model of what a twin is, and is refused LOUDLY
		// rather than skipped. Silently dropping it is how "config read, never
		// honoured" gets recreated one call site at a time.
		await expect(
			buildAlternateVersions(
				twinImage,
				identity,
				pathOpts,
				pathOf(identity, image.originalQuality, 'tif'),
				{ qualities: [image.originalQuality] },
			),
		).rejects.toThrow(/is a MASTER tier/);
	});

	test('A6: the THUMB tier never gets a twin, and asking for one is REFUSED [PIN + new refusal]', async () => {
		// PIN (green pre-builder): files_info scans the thumb tier with
		// config.media.thumb.extension ALONE, so a twin there is permanently
		// unindexable — it would exist on disk, cost an encode per upload, and be
		// invisible to every reader.
		const identity = nextIdentity();
		await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red');
		await regenerateImage(twinImage, identity, pathOpts, 'tif');

		expect(derivedTwinQualities(image)).not.toContain(THUMB);
		expect(existsSync(pathOf(identity, THUMB, config.media.thumb.extension))).toBe(true);
		expect(existsSync(pathOf(identity, THUMB, ALT))).toBe(false);

		// NEW (fails pre-builder): the same loud refusal as A5, for the same reason.
		await expect(
			buildAlternateVersions(
				twinImage,
				identity,
				pathOpts,
				pathOf(identity, image.originalQuality, 'tif'),
				{ qualities: [THUMB] },
			),
		).rejects.toThrow(/thumb tier/);
		// And build_version cannot smuggle one in either.
		await expect(buildVersionCore(twinImage, identity, pathOpts, THUMB, null, ALT)).rejects.toThrow(
			/could never be indexed/,
		);
	});
});

describe.if(HAVE_MAGICK)('A7-A10 — replacement, failure and backup policy', () => {
	test('A7: a replaced twin leaves its previous bytes in deleted/ and a FRESH twin serving', async () => {
		// A twin in a higher tier may be operator-authored (tool_image_rotation
		// rotates every on-disk extension of a tier), so the replacement is
		// recoverable — and the serving file is current, not the old bytes.
		const identity = nextIdentity();
		await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red');
		const higherJpg = pathOf(identity, HIGHER, image.defaultExtension);
		await makeImage(higherJpg, 'green');
		const twin = pathOf(identity, HIGHER, ALT);
		await makeImage(twin, 'green'); // the v6-era / operator twin

		await makeImage(pathOf(identity, MODIFIED, 'tif'), 'blue');
		const outcome = await regenerateImage(twinImage, identity, pathOpts, 'tif');

		expect(outcome.errors).toEqual([]);
		// The twin serves the CURRENT master…
		expect(existsSync(twin)).toBe(true);
		expect(await depicts(twin)).toBe('blue');
		// …and the bytes it replaced are one move away, under the No-hard-delete name.
		const backups = deletedTwins(twin, identity, ALT);
		expect(backups.length).toBe(1);
		expect(await depicts(`${dirOf(twin)}/deleted/${backups[0] as string}`)).toBe('green');
	});

	test('A8: a failed twin build leaves NO stale twin and reports an error naming the config key', async () => {
		// A host with no delegate for the configured format must be left honestly
		// twin-LESS, never quietly stale: the atomic write leaves the PREVIOUS twin in
		// place on failure, and that file depicts a master the record no longer has.
		// The failure has to REACH someone, which is why regenerateImage returns an
		// error channel at all (D9) — before it, derivativeErrors was populated at
		// exactly one site and every upload reported success.
		const jxlSpec = withAlternates(image, [UNWRITABLE]);
		const identity = nextIdentity();
		await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red');
		await regenerateImage(noTwinImage, identity, pathOpts, 'tif');
		// A twin already on disk (v6-migrated) that this host cannot rebuild.
		const stale = pathOf(identity, DERIVED, UNWRITABLE);
		mkdirSync(dirOf(stale), { recursive: true });
		writeFileSync(stale, 'a twin from another install');

		await makeImage(pathOf(identity, MODIFIED, 'tif'), 'blue');
		const outcome = await regenerateImage(jxlSpec, identity, pathOpts, 'tif');

		expect(existsSync(stale)).toBe(false);
		expect(outcome.retired).toContain(`${DERIVED}.${UNWRITABLE}`);
		expect(outcome.errors.length).toBeGreaterThan(0);
		// The operator must read WHICH KEY asked for a format this box cannot write —
		// an ImageMagick sentence alone does not say what to edit.
		expect(outcome.errors.join(' ')).toContain(image.alternateExtensionsConfigKey);
		expect(outcome.errors.join(' ')).toContain(`.${UNWRITABLE}`);
		// The jpg ladder is untouched by the twin failure: non-fatal by construction.
		expect(await depicts(pathOf(identity, DERIVED, image.defaultExtension))).toBe('blue');
	});

	test('A9: an unwritable format NEVER lands on disk — at any size, under any name', async () => {
		// THE SILENT WRONG-FORMAT HAZARD. Measured on IM 7.1.2-18 under the repo
		// policy BEFORE the coder token: `magick src.png out.jxl` exits 0 with an
		// EMPTY stderr and writes 316 BYTES OF PNG into a file named `.jxl`. It passes
		// nonEmptyFile, passes the scene-count post-condition, enters files_info and
		// is served with the wrong MIME. So the assertion is deliberately
		// SIZE-INDEPENDENT: not "the file is small/invalid" but "no file with that
		// extension exists anywhere for this record".
		//
		// WHICH PRE-STATE THIS ONE IS RED ON: the disk assertion below is green on the
		// tree that had no builder at all (nothing was written, so nothing was wrong)
		// — it goes red on a BUILDER WITHOUT THE CODER TOKEN, which is the tree this
		// change would have shipped without step 1. The `errors` assertion is red on
		// both.
		expect(await canWriteImageFormat(UNWRITABLE)).toBe(false);

		const jxlSpec = withAlternates(image, [UNWRITABLE]);
		const identity = nextIdentity();
		await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red');
		const higherJpg = pathOf(identity, HIGHER, image.defaultExtension);
		await makeImage(higherJpg, 'green'); // a second tier, so two chances to write one

		const outcome = await regenerateImage(jxlSpec, identity, pathOpts, 'tif');

		// Loud, not silent: the refusal reaches the caller.
		expect(outcome.errors.length).toBeGreaterThan(0);
		const stem = `test99_test3_${String(identity.sectionId)}`;
		for (const quality of [...image.qualities, THUMB]) {
			const dir = dirOf(pathOf(identity, quality, image.defaultExtension));
			if (!existsSync(dir)) continue;
			// Nothing named `.jxl` — not in the tier, not among the atomic temps, and
			// not in deleted/ either (nothing was ever produced to retire).
			for (const sub of [dir, `${dir}/deleted`]) {
				if (!existsSync(sub)) continue;
				expect(
					readdirSync(sub).filter(
						(name) => name.startsWith(stem) && name.endsWith(`.${UNWRITABLE}`),
					),
				).toEqual([]);
			}
		}
		// And the ladder it CAN write is complete, so the refusal cost the record
		// nothing but the format it could never have had.
		expect(existsSync(pathOf(identity, DERIVED, image.defaultExtension))).toBe(true);
		expect(await depicts(higherJpg)).toBe('red');
	});

	test('A10: the backup of a replaced twin is CONDITIONAL — higher tiers always, the default tier only for an uploadable format', async () => {
		// NOT a size heuristic: `assertNormalizedExtensionForTier` admits an upload
		// into a derived tier for [defaultExtension, ...alternateExtensions] and
		// `assertAllowedExtension` additionally requires the upload allowlist, so a
		// twin in the default tier MAY be an operator's file exactly when its format
		// is uploadable. The default tier is rebuilt on EVERY master ingest, so
		// backing up a machine-authored twin there would turn every upload on the
		// install into deleted/ churn for bytes nobody authored. Both sides are
		// BUILT (withUpload): whether this install's allowlist admits a format is
		// the operator's choice, not this gate's premise.
		const machineSpec = withUpload(twinImage, ALT, false);
		const pngSpec = withUpload(withAlternates(image, ['png']), 'png', true);
		expect(machineSpec.allowedExtensions).not.toContain(ALT);
		expect(pngSpec.allowedExtensions).toContain('png');

		// (a) default tier + a format no human could have uploaded → NO backup.
		const machine = nextIdentity();
		await makeImage(pathOf(machine, image.originalQuality, 'tif'), 'red');
		await regenerateImage(machineSpec, machine, pathOpts, 'tif');
		await makeImage(pathOf(machine, MODIFIED, 'tif'), 'blue');
		await regenerateImage(machineSpec, machine, pathOpts, 'tif');
		const machineTwin = pathOf(machine, DERIVED, ALT);
		expect(await depicts(machineTwin)).toBe('blue'); // rebuilt in place…
		expect(deletedTwins(machineTwin, machine, ALT)).toEqual([]); // …with zero churn

		// (b) default tier + a format the allowlist admits → BACKED UP.
		const human = nextIdentity();
		await makeImage(pathOf(human, image.originalQuality, 'tif'), 'red');
		await regenerateImage(pngSpec, human, pathOpts, 'tif');
		await makeImage(pathOf(human, MODIFIED, 'tif'), 'blue');
		await regenerateImage(pngSpec, human, pathOpts, 'tif');
		const humanTwin = pathOf(human, DERIVED, 'png');
		expect(await depicts(humanTwin)).toBe('blue');
		const humanBackups = deletedTwins(humanTwin, human, 'png');
		expect(humanBackups.length).toBe(1);
		expect(await depicts(`${dirOf(humanTwin)}/deleted/${humanBackups[0] as string}`)).toBe('red');

		// (c) a HIGHER tier is always backed up — minted on demand, and an operator
		// may have curated or rotated it (A7 covers the content side).
		const higher = nextIdentity();
		await makeImage(pathOf(higher, image.originalQuality, 'tif'), 'red');
		await makeImage(pathOf(higher, HIGHER, image.defaultExtension), 'red');
		await regenerateImage(twinImage, higher, pathOpts, 'tif');
		await makeImage(pathOf(higher, MODIFIED, 'tif'), 'blue');
		await regenerateImage(twinImage, higher, pathOpts, 'tif');
		expect(deletedTwins(pathOf(higher, HIGHER, ALT), higher, ALT).length).toBe(1);
	});
});

describe.if(HAVE_MAGICK)('A11-A12 — build_version, the operator seam', () => {
	test('A11: WITHOUT target_extension a tier is built COMPLETE — its file plus every twin', async () => {
		// A tier minted on demand must not arrive half-built, or the ⟺ invariant is
		// false the moment it is created and the NEXT master change would retire the
		// twin nobody ever built.
		const identity = nextIdentity();
		await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red');

		const outcome = await buildVersionCore(twinImage, identity, pathOpts, HIGHER, 'tif');

		expect(outcome.errors).toEqual([]);
		expect(outcome.built.length).toBe(2);
		expect(outcome.built.some((path) => path.endsWith(`.${image.defaultExtension}`))).toBe(true);
		expect(outcome.built.some((path) => path.endsWith(`.${ALT}`))).toBe(true);
		expect(existsSync(pathOf(identity, HIGHER, image.defaultExtension))).toBe(true);
		expect(existsSync(pathOf(identity, HIGHER, ALT))).toBe(true);
		expect(await depicts(pathOf(identity, HIGHER, ALT))).toBe('red');
	});

	test('A12: WITH target_extension exactly ONE file is built, and a companion-less target is refused', async () => {
		// Delete is already granular (delete_version takes an extension). Without a
		// granular build, recovering ONE twin meant re-encoding the tier's jpg as
		// well — destroying any rotation an operator had applied to it. That is the
		// damage this asserts: the jpg must be byte-for-byte untouched.
		const identity = nextIdentity();
		await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red');
		await buildVersionCore(twinImage, identity, pathOpts, HIGHER, 'tif');
		const jpg = pathOf(identity, HIGHER, image.defaultExtension);
		const twin = pathOf(identity, HIGHER, ALT);
		rmSync(twin); // the operator deleted just this cell in the panel
		const before = statSync(jpg).mtimeMs;

		const outcome = await buildVersionCore(twinImage, identity, pathOpts, HIGHER, null, ALT);

		expect(outcome.built.length).toBe(1);
		expect(outcome.built[0]).toBe(twin);
		expect(existsSync(twin)).toBe(true);
		expect(statSync(jpg).mtimeMs).toBe(before); // the tier's own file never re-encoded

		// A twin is a COMPANION: with no tier file to accompany, refuse rather than
		// return an empty success the panel renders as "done".
		const bare = nextIdentity();
		await makeImage(pathOf(bare, image.originalQuality, 'tif'), 'red');
		await expect(buildVersionCore(twinImage, bare, pathOpts, HIGHER, null, ALT)).rejects.toThrow(
			/nothing to accompany/,
		);

		// And a format the install did not configure is refused NAMING THE KEY,
		// instead of being encoded into a file no scanner will ever look for.
		await expect(
			buildVersionCore(twinImage, bare, pathOpts, DERIVED, null, UNWRITABLE),
		).rejects.toThrow(new RegExp(image.alternateExtensionsConfigKey));
	});
});

describe.if(HAVE_MAGICK && HAVE_GS)(
	'A13-A14 — the pdf cover, the one type that ships the key non-empty',
	() => {
		test('A13: covers follow coverExtensions and are ALWAYS opaque', async () => {
			// buildPdfCover hardcoded 'jpg' and was honoured only BY COINCIDENCE
			// (DEDALO_PDF_ALTERNATIVE_EXTENSIONS defaults to ['jpg']); an install using the
			// catalog's own ["avif","jpg"] example got an avif nothing wrote.
			//
			// AND THE COVER IS COMPOSITED ONTO WHITE FOR EVERY EXTENSION. A pdf page has
			// no alpha of its own: it is glyphs on the DEVICE background, and the white
			// paper exists only because the rasterizer puts it there. Measured through
			// this exact recipe onto 'none': alpha_mean 0.129 on the plan's representative
			// page (0.0117 on this sparser ghostscript fixture) — an 87 %-transparent
			// sheet of floating glyphs, illegible over any dark UI. Today's jpg cover is
			// safe only because jpg is in OPAQUE_TARGET_EXTENSIONS, so generalising
			// backgroundForTarget here would have shipped blank covers.
			const identity = nextPdfIdentity();
			const source = pdfPathOf(identity, pdf.originalQuality, 'pdf');
			await makePdf(source);
			const spec = withPdfAlternates(['avif']);

			const covers = await buildPdfCovers(spec, identity, source, pathOpts);

			// The failures are VALUES now (a cover format this host cannot encode must
			// not cost the record the covers it CAN build, nor turn a landed build into
			// a red result) — so the gate asserts BOTH halves.
			expect(covers.errors).toEqual([]);
			expect(covers.created.length).toBe(2);
			const jpgCover = pdfPathOf(identity, pdf.defaultQuality, 'jpg');
			const avifCover = pdfPathOf(identity, pdf.defaultQuality, 'avif');
			expect(existsSync(jpgCover)).toBe(true);
			expect(existsSync(avifCover)).toBe(true);
			// The jpg cover cannot be anything but opaque (no alpha channel at all).
			expect(await isOpaque(jpgCover)).toBe(true);
			// The avif one CAN carry alpha, and must not: measured 0.9997 here — the
			// residual is avif's lossy alpha plane, not transparency. The failure this
			// pins is 0.129, so the band is wide and unambiguous.
			expect(await alphaMean(avifCover)).toBeGreaterThan(0.95);
			expect(await alphaAt(avifCover, 2, 2)).toBeGreaterThan(0.95);
		});

		test('A14: emptying the pdf key can never UN-INDEX a cover already on disk', async () => {
			// The jpg cover is built whether or not the config lists it, so deriving the
			// SCAN list from the config alone let an operator who empties
			// DEDALO_PDF_ALTERNATIVE_EXTENSIONS un-index every cover in the archive: the
			// file keeps existing and the record stops seeing it. `jpg` is NOT in pdf's
			// upload allowlist, so the coverExtensions union is the ONLY route it has.
			expect(pdf.allowedExtensions).not.toContain('jpg');
			expect(pdf.coverExtensions).toContain('jpg');

			const identity = nextPdfIdentity();
			const source = pdfPathOf(identity, pdf.originalQuality, 'pdf');
			await makePdf(source);
			await buildPdfCovers(pdf, identity, source, pathOpts);
			expect(existsSync(pdfPathOf(identity, pdf.defaultQuality, 'jpg'))).toBe(true);

			// Exactly what mediaTypeOf builds when the key is emptied: no alternates,
			// covers still ['jpg'].
			const emptied = withPdfAlternates([]);
			expect(emptied.alternateExtensions).toEqual([]);
			expect(emptied.coverExtensions).toEqual(['jpg']);

			const scanned = scanFilesInfo(emptied, identity, pathOpts, {});
			expect(
				scanned.some(
					(info) =>
						info.quality === pdf.defaultQuality && info.extension === 'jpg' && info.file_exist,
				),
			).toBe(true);
		});
	},
);

describe.if(HAVE_MAGICK)(
	"A15-A16 — repair (tool_update_cache): missing-only, and never at the thumb's expense",
	() => {
		test('A15: repair BUILDS a missing twin and does NOT touch one that is present', async () => {
			// Repair's contract is missing-only (Q2: no stale sweep in this change). It
			// fixes what is absent and never re-encodes or removes what an operator may
			// have authored — the engine cannot tell a stale twin from a curated one
			// without per-tier provenance, which is the ledgered gap.
			const identity = nextIdentity();
			await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red');
			// A record as a migrated install has it: tiers built, no twins anywhere.
			await regenerateImage(noTwinImage, identity, pathOpts, 'tif');
			await makeImage(pathOf(identity, HIGHER, image.defaultExtension), 'red');
			expect(existsSync(pathOf(identity, DERIVED, ALT))).toBe(false);

			const errors = await regenerateMissingDerivatives(
				'component_image',
				twinImage,
				identity,
				pathOpts,
				{ rawExtension: 'tif', deleteNormalized: false, bulkProcessId: null },
			);

			expect(errors).toEqual([]);
			const twin = pathOf(identity, DERIVED, ALT);
			expect(existsSync(twin)).toBe(true);
			expect(await depicts(twin)).toBe('red');
			// The higher tier holds its own file, so it gets a companion too.
			expect(existsSync(pathOf(identity, HIGHER, ALT))).toBe(true);

			// Now an operator's own bytes sit in the twin. A second sweep must leave them
			// EXACTLY as they are — re-encoding here would re-encode the whole archive.
			await makeImage(twin, 'green');
			const before = statSync(twin).mtimeMs;
			const second = await regenerateMissingDerivatives(
				'component_image',
				twinImage,
				identity,
				pathOpts,
				{ rawExtension: 'tif', deleteNormalized: false, bulkProcessId: null },
			);
			expect(second).toEqual([]);
			expect(statSync(twin).mtimeMs).toBe(before);
			expect(await depicts(twin)).toBe('green');
			// missing-only never retires either, so a partial-media box cannot lose a
			// twin to a repair sweep.
			expect(deletedTwins(twin, identity, ALT)).toEqual([]);
		});

		test('A16: a twin this host cannot encode never costs the sweep the thumb, the envelope or the tier', async () => {
			// THE ORDERING RULE. The thumb and the SVG envelope are what tool_update_cache
			// EXISTS to fix — a record whose edit view renders nothing has a missing
			// envelope, not a missing avif. Placed earlier, or wrapped as one block, a
			// missing AVIF delegate on a box would abort the repair of every record in the
			// sweep, turning the repair tool off for a reason unrelated to what it repairs.
			const jxlSpec = withAlternates(image, [UNWRITABLE]);
			const identity = nextIdentity();
			await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red');
			await regenerateImage(noTwinImage, identity, pathOpts, 'tif');
			// Exactly the damage the tool is run for: default tier, thumb and envelope gone.
			rmSync(pathOf(identity, DERIVED, image.defaultExtension));
			rmSync(pathOf(identity, THUMB, config.media.thumb.extension));
			rmSync(svgOverlayLocation(image, identity, pathOpts).absolutePath);

			// It RESOLVES — the twin failure travels as a value, it is never thrown.
			const errors = await regenerateMissingDerivatives(
				'component_image',
				jxlSpec,
				identity,
				pathOpts,
				{ rawExtension: 'tif', deleteNormalized: false, bulkProcessId: null },
			);

			expect(errors.length).toBeGreaterThan(0);
			expect(errors.join(' ')).toContain(image.alternateExtensionsConfigKey);
			// …and every step before it landed.
			expect(existsSync(pathOf(identity, DERIVED, image.defaultExtension))).toBe(true);
			expect(await depicts(pathOf(identity, DERIVED, image.defaultExtension))).toBe('red');
			expect(existsSync(pathOf(identity, THUMB, config.media.thumb.extension))).toBe(true);
			expect(existsSync(svgOverlayLocation(image, identity, pathOpts).absolutePath)).toBe(true);
			expect(existsSync(pathOf(identity, DERIVED, UNWRITABLE))).toBe(false);
		});
	},
);

// ---------------------------------------------------------------------------
// A17-A21 — the reachable states the first review found, and the promises the
// engine makes about them. Every one of these is RED on the tree that shipped
// the builder without them.
// ---------------------------------------------------------------------------

describe.if(HAVE_MAGICK)(
	'A17-A21 — no twin without its companion, and no companion of another picture',
	() => {
		test("A17: deleting a tier's own file RETIRES its twin — the orphan is not left indexed", async () => {
			// MEASURED on the tree that shipped the builder: `delete_version('1.5MB','jpg')`
			// moved one file and left `1.5MB/<id>.avif` on disk, whereupon scanFilesInfo
			// reported the ORPHAN as the 1.5MB entry — so resolve/relation_list.ts and
			// resolve/media_list_value.ts, which pick a tier by QUALITY ALONE, served an
			// AVIF url for a record whose web version had just been deleted. The
			// reconciler could not help: a delete changes no master, so nothing ran.
			const identity = nextIdentity();
			await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red');
			await regenerateImage(twinImage, identity, pathOpts, 'tif');
			const tierFile = pathOf(identity, DERIVED, image.defaultExtension);
			const twin = pathOf(identity, DERIVED, ALT);
			expect(existsSync(twin)).toBe(true);

			const outcome = await deleteAndResyncCore(
				twinImage,
				identity,
				pathOpts,
				DERIVED,
				image.defaultExtension,
			);

			expect(existsSync(tierFile)).toBe(false);
			expect(existsSync(twin)).toBe(false);
			// RETIRED, never destroyed (the No-hard-delete law): the bytes are one move away.
			expect(deletedTwins(twin, identity, ALT).length).toBe(1);
			expect(outcome.retired).toEqual([`${DERIVED}.${ALT}`]);
			// And the scan the caller PERSISTS no longer offers that quality at all.
			expect(outcome.filesInfo.filter((entry) => entry.quality === DERIVED)).toEqual([]);
		});

		test('A18: deleting the TWIN alone does not resurrect it', async () => {
			// The other direction is a reconciliation, not a disk state. An operator who
			// removes one format on one record means it: the tier keeps its own file, the
			// build gear (target_extension) brings the twin back on request, and the next
			// master change rebuilds it. Restoring it here would make the panel's per-file
			// delete a no-op — the invariant would be enforced by ignoring the operator.
			const identity = nextIdentity();
			await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red');
			await regenerateImage(twinImage, identity, pathOpts, 'tif');
			const tierFile = pathOf(identity, DERIVED, image.defaultExtension);
			const twin = pathOf(identity, DERIVED, ALT);

			const outcome = await deleteAndResyncCore(twinImage, identity, pathOpts, DERIVED, ALT);

			expect(existsSync(twin)).toBe(false);
			expect(existsSync(tierFile)).toBe(true);
			expect(outcome.retired).toEqual([]);
			expect(outcome.filesInfo.some((entry) => entry.quality === DERIVED)).toBe(true);
		});

		test('A19: the unattended repair sweep REFUSES a twin whose tier carries a rotation', async () => {
			// THE MIGRATION CASE, and the reason this is a gate rather than a note: the
			// first tool_update_cache sweep after an install turns the key on walks every
			// record. On an already-rotated tier a twin built from the master is ninety
			// degrees from its own companion — measured 852x620 jpg beside a 618x850 avif,
			// files_info reporting both present and current, zero errors. missing-only
			// builds what is ABSENT, so it is exactly this path that would manufacture one.
			const identity = nextIdentity();
			await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red', '900x600');
			await regenerateImage(noTwinImage, identity, pathOpts, 'tif');
			// The operator's rotation, in the one respect the check can see: the tier's own
			// file is portrait while its landscape master is untouched.
			await makeImage(pathOf(identity, DERIVED, image.defaultExtension), 'red', '600x900');

			const errors = await regenerateMissingDerivatives(
				'component_image',
				twinImage,
				identity,
				pathOpts,
				{ rawExtension: 'tif', deleteNormalized: false, bulkProcessId: null },
			);

			expect(existsSync(pathOf(identity, DERIVED, ALT))).toBe(false);
			expect(errors.length).toBe(1);
			expect(errors[0]).toContain('rotation or crop');
			expect(errors[0]).toContain(image.alternateExtensionsConfigKey);
			// The sweep still did its job: thumb and envelope are there, and the operator's
			// rotated file is untouched.
			expect(existsSync(pathOf(identity, THUMB, config.media.thumb.extension))).toBe(true);
			expect(existsSync(svgOverlayLocation(image, identity, pathOpts).absolutePath)).toBe(true);
			expect(await getDimensions(pathOf(identity, DERIVED, image.defaultExtension))).toEqual({
				width: 600,
				height: 900,
			});
		});

		test('A19b: a tier whose re-encode FAILS retires its twin instead of stranding it', async () => {
			// The other way a companion can vanish: `regenerateImage` moves a higher
			// tier's file into deleted/ and then rebuilds it, and a throw between those
			// two steps used to escape the whole function — so the twin pass never ran and
			// the tier was left with NO normalized file and its twin still on disk,
			// indexed, and (with the jpg gone) the FIRST entry files_info reports for that
			// quality. The failure is forced the only way that is deterministic on any
			// box: the tier directory is made read-only, so the backup move itself fails.
			const identity = nextIdentity();
			await makeImage(pathOf(identity, image.originalQuality, 'tif'), 'red');
			await regenerateImage(twinImage, identity, pathOpts, 'tif');
			// Seed the higher tier with a real pair, copied from the default tier.
			const hiJpg = pathOf(identity, HIGHER, image.defaultExtension);
			const hiTwin = pathOf(identity, HIGHER, ALT);
			mkdirSync(dirOf(hiJpg), { recursive: true });
			copyFileSync(pathOf(identity, DERIVED, image.defaultExtension), hiJpg);
			copyFileSync(pathOf(identity, DERIVED, ALT), hiTwin);
			chmodSync(dirOf(hiJpg), 0o555);
			try {
				// It RESOLVES: a higher tier that cannot be rebuilt is not fatal.
				const outcome = await regenerateImage(twinImage, identity, pathOpts, 'tif');
				expect(outcome.errors.length).toBeGreaterThan(0);
				expect(outcome.errors.join(' ')).toContain(HIGHER);
				// …and the default tier, which is what the record is served from, is intact.
				expect(existsSync(pathOf(identity, DERIVED, image.defaultExtension))).toBe(true);
				expect(existsSync(pathOf(identity, DERIVED, ALT))).toBe(true);
				expect(await depicts(pathOf(identity, DERIVED, ALT))).toBe('red');
			} finally {
				chmodSync(dirOf(hiJpg), 0o755);
			}
		});

		test('A20: duplicate_record copies the pdf COVER even with the key emptied', async () => {
			// The cover is built whether or not DEDALO_PDF_ALTERNATIVE_EXTENSIONS lists it,
			// so an enumeration derived from the configured list alone drops it — and the
			// cover is the only visual a pdf record has in a list view. MEASURED before
			// managedExtensions existed: with the key emptied, duplicateMediaFiles copied
			// the document and the thumb and left the cover behind, and no repair path ever
			// rebuilds it (repair only builds when the default-quality file is ABSENT).
			const source = nextPdfIdentity();
			const target = nextPdfIdentity();
			const emptied = withPdfAlternates([]);
			expect(emptied.alternateExtensions).toEqual([]);
			mkdirSync(dirOf(pdfPathOf(source, pdf.defaultQuality, 'pdf')), { recursive: true });
			writeFileSync(pdfPathOf(source, pdf.defaultQuality, 'pdf'), 'a document');
			await makeImage(pdfPathOf(source, pdf.defaultQuality, 'jpg'), 'red');

			const created = await duplicateMediaFiles(emptied, source, target, {
				source: pathOpts,
				target: pathOpts,
			});

			expect(created).toContain(pdfPathOf(target, pdf.defaultQuality, 'jpg'));
			expect(existsSync(pdfPathOf(target, pdf.defaultQuality, 'jpg'))).toBe(true);
			expect(existsSync(pdfPathOf(target, pdf.defaultQuality, 'pdf'))).toBe(true);
		});

		test('A21: rotating an alpha twin keeps its transparency and leaves the corners it exposes transparent', async () => {
			// D10, measured rather than assumed. The rotate recipe carries NO -flatten, so
			// `-background '#ffffff'` does NOT composite the picture: the medal twin comes
			// out `opaque=False`, `mean.a 0.5339` (from 0.531173) with corner
			// srgba(255,254,255,1). What the background really decides is the colour of the
			// area the rotation CREATES — and on a file whose reason to exist is a cut-out,
			// that area belongs transparent. `background: undefined` is what the tool sends
			// when the operator ticks 'Transparent'; each file then answers for itself, and
			// a jpg is still composited onto white (never a transparent jpg — the
			// nondeterministic-background trap backgroundForTarget documents).
			const identity = nextIdentity();
			await makeAlphaMaster(pathOf(identity, image.originalQuality, 'tif'));
			await regenerateImage(twinImage, identity, pathOpts, 'tif');
			const twin = pathOf(identity, DERIVED, ALT);
			const tierFile = pathOf(identity, DERIVED, image.defaultExtension);
			expect(await isOpaque(twin)).toBe(false);

			const rotation = await applyRotationCore(
				image,
				identity,
				pathOpts,
				[
					{ quality: DERIVED, extension: image.defaultExtension, file_exist: true },
					{ quality: DERIVED, extension: ALT, file_exist: true },
				],
				{ degrees: 45, mode: 'expanded' }, // no `background`: per file
			);

			expect(rotation.errors).toEqual([]);
			expect(rotation.rotated.length).toBe(2);
			// The twin keeps its alpha AND its exposed corner is transparent…
			expect(await isOpaque(twin)).toBe(false);
			// A BAND, not 0: avif stores alpha lossily, so a fully transparent corner
			// reads 0.0061 here (the same reason A13's opaque cover reads 0.9997).
			expect(await alphaAt(twin, 1, 1)).toBeLessThan(0.05);
			// …while the jpg companion is still opaque white in the same corner.
			expect(await isOpaque(tierFile)).toBe(true);
			expect(await centrePixel(tierFile, '1,1')).toEqual([255, 255, 255]);
		});
	},
);
