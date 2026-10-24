/**
 * Phase D gate: the ingest pipeline (staging → add_file SEC-063 → regenerate →
 * files_info) with a REAL image, and the supervised job manager (concurrency
 * cap, progress, stop, status frames). Scratch media root — never the shared dir.
 */
// MIGRATED TO THE GENERIC `test` TLD, 2026-08-19: every install tipo this gate
// spelled is now its generic twin (sections on the `test` TLD, storing in
// matrix_test). A pure rename — the tipo is an identifier in a path, a filename
// or a locator here, so no corpus and no DB round-trip were added.
// The census entry that remains for this file is a FALSE POSITIVE: the token is
// `libx264`, the ffmpeg H.264 encoder, not a tipo. `libx` is not an install TLD.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { config } from '../../src/config/config.ts';
import { AUDIO_TR_QUALITY, mediaTypeOf } from '../../src/core/concepts/media.ts';
import { updateMatrixKeysData } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { getDimensions, resolveMagick } from '../../src/core/media/engine/imagemagick.ts';
import { runBinary } from '../../src/core/media/engine/spawn.ts';
import { addFile, sanitizeSegment, stagingDir } from '../../src/core/media/ingest/add_file.ts';
import {
	fireMediaIngestEvent,
	type MediaIngestEvent,
	registerMediaIngestHook,
} from '../../src/core/media/ingest/ingest_event.ts';
import { processUploadedFile } from '../../src/core/media/ingest/process_uploaded_file.ts';
import { MediaJobManager, mediaJobs } from '../../src/core/media/jobs.ts';
import {
	buildMediaLocation,
	type MediaIdentity,
	type MediaPathOptions,
} from '../../src/core/media/path.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { deleteSectionRecord } from '../../src/core/section/record/delete_record.ts';
import { mustGet } from '../helpers/assert.ts';
import { magickTestEnv } from '../helpers/magick_test_env.ts';
import { markMediaRoot } from '../helpers/media_scratch_root.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const ROOT = scratchDir('media_ingest');
const image = mediaTypeOf('component_image')!;
const av = mediaTypeOf('component_av')!;
const HAVE_MAGICK = existsSync(resolveMagick());
const HAVE_FFMPEG = Bun.which(config.media.binaries.ffmpeg) !== null;
const identity: MediaIdentity = {
	componentTipo: 'test99',
	sectionTipo: 'test3',
	sectionId: 42,
	lang: null,
};
const pathOpts: MediaPathOptions = { initialMediaPath: '', maxItemsFolder: 1000, mediaRoot: ROOT };
/** The av playground identity (test3/test94), shared by the av ingest cases. */
const avIdentity: MediaIdentity = {
	componentTipo: 'test94',
	sectionTipo: 'test3',
	sectionId: 44,
	lang: null,
};
const USER_ID = 7;
/**
 * The stored-cue case needs a REAL record (the ingest re-reads the stored item),
 * so it uses the canonical test3 playground — the one write surface the suite
 * owns — with the scratch media ROOT above. Everything else here is DB-free.
 */
const CUE_SECTION = 'test3';
const CUE_COMPONENT = 'test99'; // component_image
const scratchIds: number[] = [];
async function scratchRecord(): Promise<number> {
	const sectionId = await createSectionRecord(CUE_SECTION, -1);
	scratchIds.push(sectionId);
	return sectionId;
}

/** Stage a real jpg in the upload tmp dir and return its tmp name. */
async function stageImage(tmpName: string, size = '2500x1800'): Promise<void> {
	const dir = stagingDir(USER_ID, 'kd1', ROOT);
	mkdirSync(dir, { recursive: true });
	await runBinary([resolveMagick(), '-size', size, 'xc:green', `${dir}/${tmpName}`], {
		nice: false,
		env: magickTestEnv(),
	});
}

/** Stage a real tiny 16x9 mp4 (via ffmpeg lavfi) in the upload tmp dir. */
async function stageVideo(tmpName: string): Promise<void> {
	const dir = stagingDir(USER_ID, 'kdav', ROOT);
	mkdirSync(dir, { recursive: true });
	// 320x180 (16:9), 1s, silent stereo track so the audio derivative has a stream.
	await runBinary(
		[
			config.media.binaries.ffmpeg,
			'-y',
			'-f',
			'lavfi',
			'-i',
			'testsrc=duration=1:size=320x180:rate=10',
			'-f',
			'lavfi',
			'-i',
			'anullsrc=r=44100:cl=stereo',
			'-t',
			'1',
			'-c:v',
			'libx264',
			'-pix_fmt',
			'yuv420p',
			'-c:a',
			'aac',
			'-shortest',
			`${dir}/${tmpName}`,
		],
		{ nice: false },
	);
}

/** Stage a real tiny 16x9 mp4 with NO audio stream (video-only). */
async function stageSilentVideo(tmpName: string): Promise<void> {
	const dir = stagingDir(USER_ID, 'kdav', ROOT);
	mkdirSync(dir, { recursive: true });
	await runBinary(
		[
			config.media.binaries.ffmpeg,
			'-y',
			'-f',
			'lavfi',
			'-i',
			'testsrc=duration=1:size=320x180:rate=10',
			'-t',
			'1',
			'-c:v',
			'libx264',
			'-pix_fmt',
			'yuv420p',
			`${dir}/${tmpName}`,
		],
		{ nice: false },
	);
}

/** Poll a media job to a terminal state (or timeout). */
async function awaitJob(jobId: string): Promise<void> {
	for (let i = 0; i < 240; i++) {
		const s = mediaJobs.status(jobId)?.status;
		if (s !== 'queued' && s !== 'running') return;
		await new Promise((r) => setTimeout(r, 250));
	}
}

beforeAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
	// DECLARE the scratch root (the media doors refuse an unmarked one under the
	// test-media seam — src/core/media/test_media_root.ts).
	markMediaRoot(ROOT);
});
afterAll(async () => {
	rmSync(ROOT, { recursive: true, force: true });
	const failures: string[] = [];
	for (const id of scratchIds) {
		try {
			const outcome = await deleteSectionRecord(CUE_SECTION, id, -1);
			if (outcome.removed !== true) {
				failures.push(`${CUE_SECTION}/${id}: ${JSON.stringify(outcome)}`);
			}
			// deleteSectionRecord writes a 'deleted' snapshot into matrix_time_machine,
			// a REAL shared table — one orphan row per suite run otherwise.
			await sql.unsafe(
				'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
				[CUE_SECTION, id],
			);
		} catch (error) {
			failures.push(`${CUE_SECTION}/${id}: ${(error as Error).message}`);
		}
	}
	// Throw, don't warn: silent cleanup failure is how a shared playground fills.
	if (failures.length > 0) {
		throw new Error(`scratch cleanup failed: ${failures.join('; ')}`);
	}
});

describe('add_file (SEC-063 confinement)', () => {
	test('sanitizeSegment blocks traversal / bad charset', () => {
		expect(sanitizeSegment('abc.jpg')).toBe('abc.jpg');
		expect(() => sanitizeSegment('../etc')).toThrow();
		expect(() => sanitizeSegment('a/b')).toThrow();
		expect(() => sanitizeSegment('..')).toThrow();
	});

	test('stagingDir confines under the upload root', () => {
		const dir = stagingDir(USER_ID, 'kd1', ROOT);
		expect(dir).toContain(`${config.media.upload.tmpSubdir}/${USER_ID}/kd1`);
		expect(() => stagingDir(USER_ID, '../../escape', ROOT)).toThrow();
	});

	test('the ROOT user (id -1) is a valid staging owner', () => {
		// Regression: root's userId is -1 (PHP logged_user_id()); the old
		// `userId <= 0` guard rejected it, so EVERY root upload failed 400
		// ("Invalid user id for staging dir"). Negative ids are valid; only
		// non-integers and 0 are refused.
		const dir = stagingDir(-1, 'kd1', ROOT);
		expect(dir).toContain(`${config.media.upload.tmpSubdir}/-1/kd1`);
		expect(() => stagingDir(0, 'kd1', ROOT)).toThrow();
		expect(() => stagingDir(1.5, 'kd1', ROOT)).toThrow();
	});

	test.if(HAVE_MAGICK)('moves the staged file into the original tier', async () => {
		await stageImage('up1.jpg');
		const result = addFile({
			spec: image,
			identity,
			pathOpts,
			userId: USER_ID,
			keyDir: 'kd1',
			tmpName: 'up1.jpg',
			extension: 'jpg',
		});
		expect(result.originalFilePath).toContain('/image/original/0/test99_test3_42.jpg');
		expect(existsSync(result.originalFilePath)).toBe(true);
	});

	test.if(HAVE_MAGICK)('quality parks the file in another tier (PHP set_quality)', async () => {
		// tool_import_files' custom_target_quality / tool_upload's quality. The
		// selector used to be inert server-side: every file landed in original.
		await stageImage('up3.jpg');
		const result = addFile({
			spec: image,
			identity: { ...identity, sectionId: 60 },
			pathOpts,
			userId: USER_ID,
			keyDir: 'kd1',
			tmpName: 'up3.jpg',
			extension: 'jpg',
			quality: image.defaultQuality,
		});
		expect(result.originalFilePath).toContain(
			`/image/${image.defaultQuality}/0/test99_test3_60.jpg`,
		);
		expect(existsSync(result.originalFilePath)).toBe(true);
	});

	test.if(HAVE_MAGICK)('a bogus quality is refused, never used as a path segment', async () => {
		// The value is CLIENT-supplied and becomes a directory name.
		await stageImage('up4.jpg');
		const attempt = (quality: string): (() => void) => {
			return () =>
				addFile({
					spec: image,
					identity: { ...identity, sectionId: 61 },
					pathOpts,
					userId: USER_ID,
					keyDir: 'kd1',
					tmpName: 'up4.jpg',
					extension: 'jpg',
					quality,
				});
		};
		expect(attempt('../../etc')).toThrow();
		expect(attempt('..')).toThrow();
		expect(attempt('not_a_tier')).toThrow();
	});
});

describe('processUploadedFile (ingest → derivatives → files_info)', () => {
	test.if(HAVE_MAGICK)('image ingest builds derivatives and returns files_info', async () => {
		await stageImage('up2.jpg', '2500x1800');
		const id2: MediaIdentity = { ...identity, sectionId: 43 };
		// An upload never goes through the record save path, so this event is the
		// ONLY notification that a record gained media (see ingest_event.ts).
		const ingestEvents: MediaIngestEvent[] = [];
		registerMediaIngestHook((event) => {
			ingestEvents.push(event);
		});
		// try/finally: the hook is a GLOBAL. A failing assertion below used to skip
		// the unregister and leak this listener into every later test in the suite.
		try {
			const result = await processUploadedFile({
				spec: image,
				identity: id2,
				pathOpts,
				userId: USER_ID,
				keyDir: 'kd1',
				tmpName: 'up2.jpg',
				extension: 'jpg',
			});
			expect(result.startTranscode).toBeNull(); // image is synchronous
			const qualities = new Set(result.filesInfo.map((e) => e.quality));
			expect(qualities.has('original')).toBe(true);
			expect(qualities.has('1.5MB')).toBe(true);
			expect(qualities.has('thumb')).toBe(true);
			// every entry points at a real file
			for (const e of result.filesInfo) {
				expect(existsSync(`${ROOT}${e.file_path}`)).toBe(true);
			}
			// Fired once, after the derivatives exist — a listener's whole job is to
			// read them, so an event that arrived earlier would be useless.
			expect(ingestEvents).toEqual([
				{
					componentTipo: id2.componentTipo,
					sectionTipo: id2.sectionTipo,
					sectionId: 43,
					model: 'component_image',
				},
			]);
		} finally {
			registerMediaIngestHook(null);
		}
	});

	test.if(HAVE_MAGICK)(
		'a non-original target quality regenerates AROUND the placed file',
		async () => {
			// PHP set_quality()'d the component and still ran regenerate_component.
			// Skipping it would leave the thumb showing the PREVIOUS image while this
			// tier serves the new one — so the non-original path runs the
			// build-only-what-is-missing regenerate: the placed file is NOT re-encoded,
			// the thumb IS rebuilt from it, and no original is invented.
			await stageImage('up5.jpg', '2500x1800');
			const id5: MediaIdentity = { ...identity, sectionId: 62 };
			const placed = buildMediaLocation(
				image,
				id5,
				image.defaultQuality,
				'jpg',
				pathOpts,
			).absolutePath;
			const result = await processUploadedFile({
				spec: image,
				identity: id5,
				pathOpts,
				userId: USER_ID,
				keyDir: 'kd1',
				tmpName: 'up5.jpg',
				extension: 'jpg',
				quality: image.defaultQuality,
			});
			expect(result.startTranscode).toBeNull();
			const qualities = new Set(result.filesInfo.map((e) => e.quality));
			expect(qualities.has(image.defaultQuality)).toBe(true);
			expect(qualities.has(config.media.thumb.quality)).toBe(true);
			// The placed file is the SOURCE size, untouched — regenerate builds the
			// default tier only when it is ABSENT, so the upload is never re-encoded.
			expect((await getDimensions(placed)).width).toBe(2500);
			// No original is invented for a tier that never received one.
			expect(qualities.has(image.originalQuality)).toBe(false);
			expect(
				existsSync(
					buildMediaLocation(image, id5, image.originalQuality, 'jpg', pathOpts).absolutePath,
				),
			).toBe(false);
		},
	);

	test.if(HAVE_MAGICK)('a non-jpg original also gets the browser-viewable copy', async () => {
		// The reported defect (rsc29/rsc170/1, 2026-10-23): a `.tif` into
		// 'original' left ONLY the tif, and every reader of a tier's picture
		// addresses it by the type's default extension (files_info scans it first,
		// the client quality selector filters by it) — so 'original' vanished from
		// the selector. The copy is the Original law's other half.
		const id6: MediaIdentity = { ...identity, sectionId: 64 };
		await stageImage('up6.tif', '1200x800');
		const result = await processUploadedFile({
			spec: image,
			identity: id6,
			pathOpts,
			userId: USER_ID,
			keyDir: 'kd1',
			tmpName: 'up6.tif',
			extension: 'tif',
		});
		const raw = buildMediaLocation(image, id6, image.originalQuality, 'tif', pathOpts).absolutePath;
		const copy = buildMediaLocation(
			image,
			id6,
			image.originalQuality,
			image.defaultExtension,
			pathOpts,
		).absolutePath;
		expect([existsSync(raw), existsSync(copy)]).toEqual([true, true]);
		// ORDER IS THE CONTRACT: the default extension comes FIRST, which is what
		// makes every quality-only reader resolve the displayable file.
		expect(
			result.filesInfo
				.filter((entry) => entry.quality === image.originalQuality)
				.map((entry) => entry.extension),
		).toEqual(['jpg', 'tif']);
		// A master tier has no pixel budget: the copy is the raw's own size.
		expect(await getDimensions(copy)).toMatchObject({ width: 1200, height: 800 });
		// …and it is written at maximum compression quality (100): it is the record's
		// full-resolution viewable, not a web tier.
		const encoded = await runBinary([resolveMagick(), copy, '-format', '%Q', 'info:'], {
			nice: false,
			env: magickTestEnv(),
		});
		expect(encoded.stdout.trim()).toBe('100');
		// The ladder's own tiers use PHP's 90 (not the old 82).
		const tierPath = buildMediaLocation(
			image,
			id6,
			image.defaultQuality,
			image.defaultExtension,
			pathOpts,
		).absolutePath;
		const tierEncoded = await runBinary([resolveMagick(), tierPath, '-format', '%Q', 'info:'], {
			nice: false,
			env: magickTestEnv(),
		});
		expect(tierEncoded.stdout.trim()).toBe('90');
	});

	test.if(HAVE_MAGICK)(
		'a default-extension upload is never overwritten by a leftover raw',
		async () => {
			// THE HAZARD the copy builder must not create: a tier holding a previous
			// raw (.tif) plus its copy, then an operator uploads a `.jpg` into
			// 'original'. That upload IS the displayable file, so nothing may be
			// converted — converting "whatever else the tier holds" would replace the
			// operator's fresh picture with one of the leftover tif.
			const id7: MediaIdentity = { ...identity, sectionId: 65 };
			await stageImage('up7.tif', '1200x800');
			await processUploadedFile({
				spec: image,
				identity: id7,
				pathOpts,
				userId: USER_ID,
				keyDir: 'kd1',
				tmpName: 'up7.tif',
				extension: 'tif',
			});
			await stageImage('up8.jpg', '640x480');
			const stagedSize = statSync(`${stagingDir(USER_ID, 'kd1', ROOT)}/up8.jpg`).size;
			await processUploadedFile({
				spec: image,
				identity: id7,
				pathOpts,
				userId: USER_ID,
				keyDir: 'kd1',
				tmpName: 'up8.jpg',
				extension: 'jpg',
			});
			const copy = buildMediaLocation(
				image,
				id7,
				image.originalQuality,
				image.defaultExtension,
				pathOpts,
			).absolutePath;
			// Byte-for-byte the upload (a re-encode of the leftover tif would differ).
			expect(statSync(copy).size).toBe(stagedSize);
			expect(await getDimensions(copy)).toMatchObject({ width: 640, height: 480 });
		},
	);

	test.if(HAVE_MAGICK)('a non-original upload PRESERVES the stored scan cues', async () => {
		// A re-scan must read the stored item's cues (external_source + the
		// original/modified normalized-name twins) — scanContextFromItem is the one
		// reader of that mapping. The ORIGINAL branch replaces its own cue with what
		// it just stored; the non-original branch has nothing to replace, so it must
		// carry them over, or the upload persists an index built from the wrong
		// premises.
		//
		// external_source is the cue that DISCRIMINATES: every image extension is in
		// the scanner's walk list, so a dropped original_normalized_name changes
		// nothing, while a dropped external_source flips the whole scan from
		// external entries to disk entries.
		const sectionId = await scratchRecord();
		const idCue: MediaIdentity = {
			componentTipo: CUE_COMPONENT,
			sectionTipo: CUE_SECTION,
			sectionId,
			lang: null,
		};
		const table = mustGet(await getMatrixTableFromTipo(CUE_SECTION), 'test3 matrix table');
		await updateMatrixKeysData(table, CUE_SECTION, sectionId, [
			{
				column: 'media',
				key: CUE_COMPONENT,
				value: [{ id: 1, external_source: 'https://example.org/remote.jpg', files_info: [] }],
			},
		]);

		await stageImage('up8.jpg');
		const result = await processUploadedFile({
			spec: image,
			identity: idCue,
			pathOpts,
			userId: USER_ID,
			keyDir: 'kd1',
			tmpName: 'up8.jpg',
			extension: 'jpg',
			quality: image.defaultQuality,
		});
		// The scan still resolves EXTERNAL — it read the stored cue, not just the disk.
		expect(result.filesInfo.length).toBeGreaterThan(0);
		expect(result.filesInfo.every((entry) => entry.external === true)).toBe(true);
		expect(result.filesInfo[0]?.file_path).toBe('https://example.org/remote.jpg');
	});

	test.if(HAVE_MAGICK)('a derived tier is refused as an upload target', async () => {
		// thumb is probed with the thumb extension ALONE, so a file placed there
		// under any other extension is invisible to the record forever — and
		// regenerate rebuilds the thumb anyway. Refuse instead of writing a file
		// nothing will ever see.
		await stageImage('up6.jpg');
		await expect(
			processUploadedFile({
				spec: image,
				identity: { ...identity, sectionId: 63 },
				pathOpts,
				userId: USER_ID,
				keyDir: 'kd1',
				tmpName: 'up6.jpg',
				extension: 'jpg',
				quality: config.media.thumb.quality,
			}),
		).rejects.toThrow(/generated thumbnail/);
		// Refused BEFORE the move: the staged file is still staged, the media tree
		// untouched.
		expect(existsSync(`${stagingDir(USER_ID, 'kd1', ROOT)}/up6.jpg`)).toBe(true);
	});

	test.if(HAVE_MAGICK)('a non-normalized extension is refused for a derivative tier', async () => {
		// Regression: the placed file would be SHADOWED. The tier's canonical
		// `<id>.<defaultExtension>` still exists (or gets rebuilt from the OLD
		// original), the scanner emits it FIRST for that quality, and the thumb is
		// regenerated from it — so the record keeps serving the previous image
		// while the upload sits beside it, reported as a success.
		await stageImage('up7.png');
		await expect(
			processUploadedFile({
				spec: image,
				identity: { ...identity, sectionId: 65 },
				pathOpts,
				userId: USER_ID,
				keyDir: 'kd1',
				tmpName: 'up7.png',
				extension: 'png',
				quality: image.defaultQuality,
			}),
		).rejects.toThrow(/would be shadowed/);
		// EVERY MASTER tier is exempt — each keeps the raw upload it is there to
		// hold: the archival original (Original law) and the human-retouched second
		// master (2026-08-07 — a retouch is delivered as a .tif/.psd and IS the new
		// source of every derived tier; see MediaTypeSpec.masterQualities).
		let nextId = 66;
		for (const master of image.masterQualities) {
			await stageImage('up7.png');
			await expect(
				processUploadedFile({
					spec: image,
					identity: { ...identity, sectionId: nextId },
					pathOpts,
					userId: USER_ID,
					keyDir: 'kd1',
					tmpName: 'up7.png',
					extension: 'png',
					quality: master,
				}),
			).resolves.toBeDefined();
			nextId += 1;
		}
	});

	test.if(HAVE_FFMPEG)('the av transcription tier is refused too', async () => {
		// audio_tr is the OTHER off-ladder carve-out assertValidQuality admits:
		// a real av directory scanFilesInfo never walks. Both arms of the guard
		// need a gate, or half of it can be deleted silently.
		await stageVideo('upaudiotr.mp4');
		await expect(
			processUploadedFile({
				spec: av,
				identity: { componentTipo: 'test94', sectionTipo: 'test3', sectionId: 64, lang: null },
				pathOpts,
				userId: USER_ID,
				keyDir: 'kdav',
				tmpName: 'upaudiotr.mp4',
				extension: 'mp4',
				quality: AUDIO_TR_QUALITY,
			}),
		).rejects.toThrow(/transcription derivative/);
		expect(existsSync(`${stagingDir(USER_ID, 'kdav', ROOT)}/upaudiotr.mp4`)).toBe(true);
	});

	test('a listener that throws can never fail an upload', async () => {
		registerMediaIngestHook(() => {
			throw new Error('indexer exploded');
		});
		try {
			await expect(
				fireMediaIngestEvent({
					componentTipo: 'test99',
					sectionTipo: 'test3',
					sectionId: 44,
					model: 'component_image',
				}),
			).resolves.toBeUndefined();
		} finally {
			registerMediaIngestHook(null);
		}
	});

	test('no listener registered is a silent no-op', async () => {
		registerMediaIngestHook(null);
		await expect(
			fireMediaIngestEvent({
				componentTipo: 'test99',
				sectionTipo: 'test3',
				sectionId: 45,
				model: 'component_image',
			}),
		).resolves.toBeUndefined();
	});

	test.if(HAVE_FFMPEG)(
		'av ingest transcodes the default derivative into a freshly-created tier dir',
		async () => {
			// Regression: submitAvTranscode wrote the two-pass passlog + output into
			// the quality tier dir (e.g. av/404/0/) WITHOUT creating it first — only
			// the original tier existed (addFile made it). ffmpeg pass 1 then died with
			// "ratecontrol_init: can't open stats file", so NO derivative was produced
			// and the client (which defaults to quality '404') showed no video.
			await stageVideo('upav.mp4');
			const idAv: MediaIdentity = {
				componentTipo: 'test94',
				sectionTipo: 'test3',
				sectionId: 44,
				lang: null,
			};
			const result = await processUploadedFile({
				spec: av,
				identity: idAv,
				pathOpts,
				userId: USER_ID,
				keyDir: 'kdav',
				tmpName: 'upav.mp4',
				extension: 'mp4',
			});
			// The transcode is handed back UNSTARTED — the caller starts it after its
			// own persist commits (IngestResult.startTranscode).
			expect(result.startTranscode).not.toBeNull();
			const jobId = mustGet(result.startTranscode, 'startTranscode')();

			await awaitJob(jobId);
			const job = mediaJobs.status(jobId);
			expect(job?.errors ?? ['no job']).toEqual([]);
			expect(job?.status).toBe('done');

			// The default-quality derivative exists → the tier dir was created.
			const q404 = buildMediaLocation(
				av,
				idAv,
				av.defaultQuality,
				av.defaultExtension,
				pathOpts,
			).absolutePath;
			expect(existsSync(q404)).toBe(true);
			// No two-pass passlog scratch left littering the media tree.
			expect(existsSync(`${q404}.passlog-0.log`)).toBe(false);
			expect(existsSync(`${q404}.passlog-0.log.mbtree`)).toBe(false);
		},
	);

	test.if(HAVE_FFMPEG)(
		'a non-original av upload transcodes only what it CAN derive',
		async () => {
			// regenerateMissingDerivatives has no component_av branch, so the av case
			// is handled here — but a transcode derives from the ORIGINAL. Both arms
			// matter: no original ⇒ nothing to offer (submitting would only produce a
			// job that fails 'AV original not found'); original present + default tier
			// missing ⇒ rebuild it, as PHP's regenerate_component did.
			const noOriginal: MediaIdentity = { ...avIdentity, sectionId: 70 };
			await stageVideo('upaudio1.mp4');
			const bare = await processUploadedFile({
				spec: av,
				identity: noOriginal,
				pathOpts,
				userId: USER_ID,
				keyDir: 'kdav',
				tmpName: 'upaudio1.mp4',
				extension: 'mp4',
				quality: 'audio',
			});
			expect(bare.startTranscode).toBeNull();

			// Same again on a record that DOES have an original: the missing default
			// tier is rebuildable, so the transcode is offered.
			const withOriginal: MediaIdentity = { ...avIdentity, sectionId: 71 };
			await stageVideo('upaudio2.mp4');
			await processUploadedFile({
				spec: av,
				identity: withOriginal,
				pathOpts,
				userId: USER_ID,
				keyDir: 'kdav',
				tmpName: 'upaudio2.mp4',
				extension: 'mp4',
			}); // lands in `original`
			rmSync(
				buildMediaLocation(av, withOriginal, av.defaultQuality, av.defaultExtension, pathOpts)
					.absolutePath,
				{ force: true },
			);
			await stageVideo('upaudio3.mp4');
			const derivable = await processUploadedFile({
				spec: av,
				identity: withOriginal,
				pathOpts,
				userId: USER_ID,
				keyDir: 'kdav',
				tmpName: 'upaudio3.mp4',
				extension: 'mp4',
				quality: 'audio',
			});
			expect(derivable.startTranscode).not.toBeNull();
			await awaitJob(mustGet(derivable.startTranscode, 'startTranscode')());
		},
		120_000,
	);

	test.if(HAVE_FFMPEG)(
		'av ingest of a SILENT (no-audio) source still succeeds (skips the audio tier)',
		async () => {
			// Regression: extractAudio on a video-only source makes ffmpeg emit
			// "Output file does not contain any stream" and exit non-zero. Letting
			// that throw failed the WHOLE transcode job even though the video
			// derivative was built — the client then saw a failed job and never
			// played the (existing) video. A silent source must transcode the video
			// tier and simply skip audio.
			await stageSilentVideo('upsilent.mp4');
			const idAv: MediaIdentity = {
				componentTipo: 'test94',
				sectionTipo: 'test3',
				sectionId: 45,
				lang: null,
			};
			const result = await processUploadedFile({
				spec: av,
				identity: idAv,
				pathOpts,
				userId: USER_ID,
				keyDir: 'kdav',
				tmpName: 'upsilent.mp4',
				extension: 'mp4',
			});
			const jobId = mustGet(result.startTranscode, 'startTranscode')();
			await awaitJob(jobId);
			const job = mediaJobs.status(jobId);
			expect(job?.errors ?? ['no job']).toEqual([]);
			expect(job?.status).toBe('done');

			// Video tier built; audio tier skipped (no audio to extract).
			const q404 = buildMediaLocation(
				av,
				idAv,
				av.defaultQuality,
				av.defaultExtension,
				pathOpts,
			).absolutePath;
			const audio = buildMediaLocation(
				av,
				idAv,
				'audio',
				av.defaultExtension,
				pathOpts,
			).absolutePath;
			expect(existsSync(q404)).toBe(true);
			expect(existsSync(audio)).toBe(false);
		},
	);
});

describe('job manager (supervised, capped, cancellable)', () => {
	test('runs a job to completion with progress + status frame', async () => {
		let tick = 0;
		const mgr = new MediaJobManager({
			budgets: { media: 2 },
			clock: () => {
				tick += 10;
				return tick;
			},
		});
		const rec = mgr.submit(
			'probe',
			async ({ onProgress }) => {
				onProgress(50);
				return { ok: true };
			},
			{ lane: 'media' },
		);
		expect(rec.status).toBe('queued');
		// let the microtask/worker run
		await new Promise((r) => setTimeout(r, 20));
		const done = mgr.status(rec.id)!;
		expect(done.status).toBe('done');
		expect(done.data).toEqual({ ok: true });
		const frame = mgr.frame(rec.id)!;
		expect(frame.is_running).toBe(false);
		expect(frame.pfile).toContain(`${rec.id}.json`);
	});

	test('concurrency cap: only N run at once', async () => {
		const mgr = new MediaJobManager({ budgets: { media: 2 }, clock: () => 0 });
		let concurrent = 0;
		let maxConcurrent = 0;
		const gate = (): Promise<unknown> =>
			new Promise((resolve) => {
				concurrent++;
				maxConcurrent = Math.max(maxConcurrent, concurrent);
				setTimeout(() => {
					concurrent--;
					resolve({ done: true });
				}, 15);
			});
		const jobs = Array.from({ length: 5 }, () => mgr.submit('slow', gate, { lane: 'media' }));
		await new Promise((r) => setTimeout(r, 120));
		expect(maxConcurrent).toBeLessThanOrEqual(2);
		for (const j of jobs) expect(mgr.status(j.id)!.status).toBe('done');
	});

	test('stop() cancels a running job', async () => {
		const mgr = new MediaJobManager({ budgets: { media: 1 }, clock: () => 0 });
		const rec = mgr.submit(
			'cancellable',
			({ signal }) =>
				new Promise((resolve, reject) => {
					const timer = setTimeout(() => resolve({ finished: true }), 200);
					signal.addEventListener('abort', () => {
						clearTimeout(timer);
						reject(new Error('aborted'));
					});
				}),
			{ lane: 'media' },
		);
		await new Promise((r) => setTimeout(r, 10));
		expect(mgr.stop(rec.id)).toBe(true);
		await new Promise((r) => setTimeout(r, 20));
		expect(mgr.status(rec.id)!.status).toBe('stopped');
	});
});
