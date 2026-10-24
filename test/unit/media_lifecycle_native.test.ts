/**
 * MEDIA LIFECYCLE — the three §5.2 lifecycle gaps of the 2026-08 oh1 audit.
 *
 * (a) DELETE / RESTORE. A deleted record's media must LEAVE the live tree (into
 *     `deleted/`, never a hard delete) and a Time-Machine undelete must bring it
 *     BACK. Both directions live in `media/file_ops.ts`; before this they were a
 *     half-pair — the remove side sat in `delete_record.ts` reading an unset
 *     `MEDIA_PATH` (inert on a default install, where the root is DERIVED), and
 *     the restore side `engineering/MEDIA_SPEC.md` §5.6/§8 promises did not
 *     exist at all, so an undeleted rsc167/rsc170/rsc191 record reported success
 *     with its audio / image / scanned consent form still in `deleted/`.
 *     The AV POSTERFRAME is part of both directions (PHP component_av overrides
 *     both methods for it) and was moved by neither.
 *
 * (b) `dd_component_av_api::download_fragment` — the clip an oral-history index
 *     entry points at. Unported: both "Download fragment" buttons on every AV
 *     index row were dead 400s.
 *
 * (c) The component_image SVG ENVELOPE. The vector annotation layers ("Capas de
 *     dibujo") the client exports as `svg_file_data` had no server writer, and
 *     `regenerateImage` overwrote an existing ANNOTATED envelope with the
 *     default raster-only one (WC-2026-08-09-image-svg-envelope-preserved).
 *
 * SCRATCH ONLY: the media root is not test-overridable through config, so every
 * case here passes an explicit `mediaRoot` pointing at a temp tree and plants
 * its own files. No real record's files are ever touched. The cases that need
 * REAL bytes (ImageMagick dimensions, an ffmpeg cut) SYNTHESIZE them into the
 * scratch tree — `magick xc:` for the raster, `ffmpeg -f lavfi testsrc` for the
 * clip, the tool_posterframe idiom — and are `test.if(<binary present>)` with
 * the reason in the test NAME. They used to copy a sample out of the
 * INSTALL's media tree and `return` when it was absent: under the suite's own
 * marked media root that sample never exists, so five cases — including the
 * annotated-envelope preservation guard — passed with `assertions="0"` on every
 * run (GATE-09). A gate that can only execute against an installation's files
 * is exactly what the media-root law forbids; a gate that builds its situation
 * runs everywhere the binary does.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../../src/config/config.ts';
import { componentAvApiActions } from '../../src/core/api/handlers/dd_component_av_api.ts';
import { mediaTypeOf } from '../../src/core/concepts/media.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { resolveMagick } from '../../src/core/media/engine/imagemagick.ts';
import { runBinary } from '../../src/core/media/engine/spawn.ts';
import {
	listDeletedVersions,
	removeSectionMediaFiles,
	restoreDeletedSectionMediaFiles,
	snapshotFlatValue,
} from '../../src/core/media/file_ops.ts';
import { resolveMediaPathOptions } from '../../src/core/media/ontology_path.ts';
import { buildMediaLocation, posterframeLocation } from '../../src/core/media/path.ts';
import {
	baseSvgUrl,
	createDefaultSvgFile,
	svgOverlayLocation,
	writeSvgEnvelope,
} from '../../src/core/media/svg_overlay.ts';
import {
	buildAvFragment,
	buildFragmentWatermarkArgv,
	fragmentFileName,
	fragmentLocation,
	watermarkFilePath,
} from '../../src/core/media/tools/fragment.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { deleteSectionRecord } from '../../src/core/section/record/delete_record.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { toolTimeMachineApplyValue } from '../../tools/tool_time_machine/server/tool_time_machine.ts';
import { magickTestEnv } from '../helpers/magick_test_env.ts';
import { resetMediaRoot } from '../helpers/media_scratch_root.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';
import { cleanScratchRecord } from '../helpers/test_data.ts';

const ROOT = scratchDir('media_lifecycle');
const SECTION_TIPO = 'test3';
/** A scratch section_id: nothing exists on disk or in the DB at this id. */
const SECTION_ID = 987654;

const image = mediaTypeOf('component_image');
const av = mediaTypeOf('component_av');

const imageIdentity = {
	componentTipo: 'test99',
	sectionTipo: SECTION_TIPO,
	sectionId: SECTION_ID,
	lang: null,
};
const avIdentity = {
	componentTipo: 'test94',
	sectionTipo: SECTION_TIPO,
	sectionId: SECTION_ID,
	lang: null,
};
const pathOpts = { initialMediaPath: '', maxItemsFolder: 1000, mediaRoot: ROOT };

/**
 * The two binaries the real-bytes cases need. Gated with `test.if` and the
 * reason in the NAME — never an in-body `return`, which bun reports as a PASS
 * with zero assertions.
 */
const HAVE_FFMPEG = existsSync(config.media.binaries.ffmpeg);
const HAVE_MAGICK = existsSync(resolveMagick());

/**
 * Synthesize the image record's default-quality raster into the scratch root
 * (a 100×50 JPG — the size the annotated envelope below is drawn for) and
 * return its path. Built, not copied: nothing outside ROOT is read.
 */
async function synthesizeRaster(): Promise<string> {
	if (image === null) throw new Error('image spec unavailable');
	resetMediaRoot(ROOT);
	const raster = buildMediaLocation(
		image,
		imageIdentity,
		image.defaultQuality,
		image.defaultExtension,
		pathOpts,
	).absolutePath;
	mkdirSync(dirname(raster), { recursive: true });
	await runBinary([resolveMagick(), '-size', '100x50', 'xc:green', raster], {
		nice: false,
		env: magickTestEnv(),
	});
	if (!existsSync(raster)) throw new Error(`magick wrote no raster at ${raster}`);
	return raster;
}

/** Write `content` at an absolute path, creating the directory. */
function plant(absolutePath: string, content: string): string {
	mkdirSync(dirname(absolutePath), { recursive: true });
	writeFileSync(absolutePath, content);
	return absolutePath;
}

/** A media column shaped as the matrix stores it (tipo → items). */
function mediaColumn(): Record<string, unknown[]> {
	return {
		test99: [{ id: 1, files_info: [] }],
		test94: [{ id: 1, files_info: [] }],
	};
}

afterAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (a) delete → deleted/ , restore → back
// ---------------------------------------------------------------------------

describe('section media delete/restore round trip', () => {
	test('every managed file AND the av posterframe move into deleted/, then come back', async () => {
		if (image === null || av === null) throw new Error('media specs unavailable');
		resetMediaRoot(ROOT);

		const imageDefault = buildMediaLocation(
			image,
			imageIdentity,
			image.defaultQuality,
			image.defaultExtension,
			pathOpts,
		).absolutePath;
		const imageThumb = buildMediaLocation(
			image,
			imageIdentity,
			config.media.thumb.quality,
			config.media.thumb.extension,
			pathOpts,
		).absolutePath;
		const avDefault = buildMediaLocation(
			av,
			avIdentity,
			av.defaultQuality,
			av.defaultExtension,
			pathOpts,
		).absolutePath;
		const posterframe = posterframeLocation(av, avIdentity, pathOpts);
		expect(posterframe).not.toBeNull();

		plant(imageDefault, 'the-image');
		plant(imageThumb, 'the-thumb');
		plant(avDefault, 'the-interview');
		plant((posterframe as { absolutePath: string }).absolutePath, 'the-posterframe');

		const now = new Date(2026, 6, 2, 14, 30, 0);
		const removed = await removeSectionMediaFiles(SECTION_TIPO, SECTION_ID, mediaColumn(), {
			now,
			mediaRoot: ROOT,
		});

		expect(removed.errors).toEqual([]);
		expect(removed.components.map((c) => c.tipo).sort()).toEqual(['test94', 'test99']);
		// Nothing survives at a live path — the posterframe INCLUDED (the gap).
		for (const path of [
			imageDefault,
			imageThumb,
			avDefault,
			(posterframe as { absolutePath: string }).absolutePath,
		]) {
			expect(existsSync(path), `still live: ${path}`).toBe(false);
		}
		// …and nothing was hard-deleted: each one is in its own deleted/ with the
		// PHP move_deleted_file stamp (Y-m-d_Hi).
		expect(
			existsSync(
				`${dirname(imageDefault)}/deleted/test99_test3_987654_deleted_2026-07-02_1430.jpg`,
			),
		).toBe(true);
		expect(
			existsSync(
				`${dirname((posterframe as { absolutePath: string }).absolutePath)}/deleted/test94_test3_987654_deleted_2026-07-02_1430.jpg`,
			),
		).toBe(true);
		expect(removed.files.length).toBe(4);

		// RESTORE — the direction that never existed.
		const restored = await restoreDeletedSectionMediaFiles(
			SECTION_TIPO,
			SECTION_ID,
			mediaColumn(),
			{
				mediaRoot: ROOT,
			},
		);
		expect(restored.errors).toEqual([]);
		expect(restored.files.length).toBe(4);
		expect(readFileSync(imageDefault, 'utf8')).toBe('the-image');
		expect(readFileSync(imageThumb, 'utf8')).toBe('the-thumb');
		expect(readFileSync(avDefault, 'utf8')).toBe('the-interview');
		expect(readFileSync((posterframe as { absolutePath: string }).absolutePath, 'utf8')).toBe(
			'the-posterframe',
		);
		// The deleted/ folder is left EMPTY of this record's versions (moved, not copied).
		expect(
			readdirSync(`${dirname(imageDefault)}/deleted`).filter((n) =>
				n.startsWith('test99_test3_987654_'),
			),
		).toEqual([]);
	});

	test('restore picks the NEWEST deleted version and leaves the older ones', async () => {
		if (image === null) throw new Error('image spec unavailable');
		resetMediaRoot(ROOT);
		const live = buildMediaLocation(
			image,
			imageIdentity,
			image.defaultQuality,
			image.defaultExtension,
			pathOpts,
		).absolutePath;
		const deletedDir = `${dirname(live)}/deleted`;
		plant(`${deletedDir}/test99_test3_987654_deleted_2024-01-01_0900.jpg`, 'older');
		plant(`${deletedDir}/test99_test3_987654_deleted_2024-02-01_0900.jpg`, 'newest');

		const restored = await restoreDeletedSectionMediaFiles(
			SECTION_TIPO,
			SECTION_ID,
			mediaColumn(),
			{
				mediaRoot: ROOT,
			},
		);
		expect(restored.errors).toEqual([]);
		expect(readFileSync(live, 'utf8')).toBe('newest');
		// The older version STAYS recoverable — a restore consumes one version, not
		// the record's whole deletion history.
		expect(existsSync(`${deletedDir}/test99_test3_987654_deleted_2024-01-01_0900.jpg`)).toBe(true);
	});

	test('an empty / absent media column is a silent no-op, and a non-media tipo is reported', async () => {
		resetMediaRoot(ROOT);
		mkdirSync(ROOT, { recursive: true });
		const empty = await removeSectionMediaFiles(SECTION_TIPO, SECTION_ID, null, {
			mediaRoot: ROOT,
		});
		expect(empty.components).toEqual([]);
		expect(empty.files).toEqual([]);
		expect(empty.errors).toEqual([]);

		// test98 is a component_text_area — data in the media column is inconsistent
		// and PHP logs an ERROR and skips. It must be REPORTED, never silently dropped.
		const bogus = await removeSectionMediaFiles(
			SECTION_TIPO,
			SECTION_ID,
			{ test98: [{ id: 1 }] },
			{ mediaRoot: ROOT },
		);
		expect(bogus.components).toEqual([]);
		expect(bogus.errors.length).toBe(1);
		expect(bogus.errors[0]).toContain('test98');
	});

	test('a caller-supplied additional_path bucket is where the sweep looks', async () => {
		// `properties.additional_path` is a NAMED bucket folder taken from another
		// component's value in THIS record (rsc165 — the Certificate of Cession and
		// the Questionnaire). The section delete runs POST-COMMIT, so by then the
		// record cannot be read and the bucket cannot be resolved from the database:
		// the caller passes what it read from the snapshot, and the sweep must use it
		// rather than fall back to the numeric bucket and move nothing.
		if (image === null) throw new Error('image spec unavailable');
		resetMediaRoot(ROOT);
		const bucket = '/cession';
		const named = { ...pathOpts, additionalPathOverride: bucket };
		const live = buildMediaLocation(
			image,
			imageIdentity,
			image.defaultQuality,
			image.defaultExtension,
			named,
		).absolutePath;
		plant(live, 'the-consent-form');
		expect(live).toContain('/cession/');

		const removed = await removeSectionMediaFiles(
			SECTION_TIPO,
			SECTION_ID,
			{ test99: [{ id: 1 }] },
			{ mediaRoot: ROOT, additionalPathOverrides: { test99: bucket } },
		);
		expect(removed.errors).toEqual([]);
		expect(existsSync(live)).toBe(false);
		expect(removed.files.some((p) => p.includes('/cession/deleted/'))).toBe(true);

		const restored = await restoreDeletedSectionMediaFiles(
			SECTION_TIPO,
			SECTION_ID,
			{ test99: [{ id: 1 }] },
			{ mediaRoot: ROOT, additionalPathOverrides: { test99: bucket } },
		);
		expect(restored.errors).toEqual([]);
		expect(readFileSync(live, 'utf8')).toBe('the-consent-form');
	});

	test('NO module resolves the media root from a bare MEDIA_PATH env read', () => {
		// THE (a) DEFECT, as a source gate over the REAL SURFACE. `readEnv('MEDIA_PATH')`
		// is undefined on every install that does not set the key — and MEDIA_PATH is a
		// DERIVED default (`<projectRoot>/media`, config.ts), so the key normally IS
		// unset: a path guarded by `if (root === undefined) return` therefore does
		// NOTHING on an ordinary install, silently. The media root has exactly one
		// source, `config.media.rootPath` (via media/path.ts requireMediaRoot).
		//
		// The gate this replaces greped ONE file — the very file that had just been
		// fixed — so it could never see the defect anywhere else, INCLUDING the copy
		// that sat next to it in delete_record.ts and was the live path. It is now a
		// repo-wide scan, and it is a SUBSET assertion against a named list: a new
		// offender fails it, while the workstream that owns a listed one can strike its
		// entry without breaking this suite.
		// Struck 2026-09-03 (P1-12 / PUB-03): the two diffusion entries — the
		// delete-side `resolvePublishedFilePath` and its publish-side twin
		// writers/files.ts — now resolve through ONE producer that reads
		// `config.media.rootPath` (src/core/diffusion_bridge/published_files.ts).
		const known = new Set<string>([]);
		const repo = join(import.meta.dir, '../..');
		/** Files matching `pattern` under src/ + tools/, repo-relative. */
		const scan = (pattern: string): string[] => {
			const run = Bun.spawnSync(['grep', '-rlE', pattern, '--include=*.ts', 'src', 'tools'], {
				cwd: repo,
			});
			// grep's contract: 0 = matches, 1 = none, ANYTHING ELSE is a broken scan
			// (bad regex, missing directory, wrong cwd). A gate whose scanner silently
			// failed reports "no offenders" forever — the exact way a source gate lies.
			expect([0, 1], `grep failed: ${new TextDecoder().decode(run.stderr)}`).toContain(
				run.exitCode,
			);
			return new TextDecoder()
				.decode(run.stdout)
				.split('\n')
				.map((line) => line.trim())
				.filter((line) => line !== '');
		};

		// SELF-CHECK. The scan must be able to FIND something, or its emptiness proves
		// nothing: `config.media.rootPath` is the sanctioned reader and is definitely
		// present, so a scan that cannot see it is broken rather than clean.
		expect(scan(String.raw`config\.media\.rootPath`).length).toBeGreaterThan(0);

		const offenders = scan(
			String.raw`readEnv\(\s*['"]MEDIA_PATH['"]|process\.env\.MEDIA_PATH|process\.env\[['"]MEDIA_PATH`,
			// `src/config/` is where the key legitimately lives: the typed catalog reads
			// it ONCE and derives `config.media.rootPath` from it (that is the whole
			// point of the rule).
		).filter((file) => !file.startsWith('src/config/'));
		expect(offenders.filter((file) => !known.has(file))).toEqual([]);
		// …and the exemptions stay HONEST: an entry whose file no longer offends is a
		// stale licence to reoffend, so the owning workstream's fix must strike it here.
		expect([...known].filter((file) => !offenders.includes(file))).toEqual([]);
	});

	test('there is exactly ONE removeSectionMediaFiles, and the delete door calls IT', () => {
		// The (a) fix was landed as a SECOND implementation while the defective one
		// stayed live in delete_record.ts — same exported name, different signature,
		// both green at once. That is the shape this asserts away: one definition, and
		// a delete door that imports rather than defines.
		const repo = join(import.meta.dir, '../..');
		const defs = Bun.spawnSync(
			[
				'grep',
				'-rlE',
				`(export )?(async )?function removeSectionMediaFiles`,
				'--include=*.ts',
				'src',
				'tools',
			],
			{ cwd: repo },
		);
		expect(
			new TextDecoder()
				.decode(defs.stdout)
				.split('\n')
				.filter((line) => line.trim() !== ''),
		).toEqual(['src/core/media/file_ops.ts']);

		const deleteDoor = readFileSync(join(repo, 'src/core/section/record/delete_record.ts'), 'utf8');
		expect(deleteDoor).toContain("import('../../media/file_ops.ts')");
		// …and both delete modes sweep: the record delete AND delete_data (PHP
		// delete_data :1123-1126 removes the files of every media component it empties).
		expect(deleteDoor.match(/removeSectionMediaFiles\(/g)?.length).toBe(2);
	});

	test('restore NEVER overwrites a live file (deliberate divergence, WC-2026-08-09-media-restore-no-overwrite)', async () => {
		// PHP restore_component_media_files uses a bare rename() and would clobber.
		// A restore runs AFTER the record's data is back, so an operator may have
		// re-uploaded by then, and silently replacing the newer file with the
		// pre-delete one is the single outcome nothing can undo.
		if (image === null) throw new Error('image spec unavailable');
		resetMediaRoot(ROOT);
		const live = buildMediaLocation(
			image,
			imageIdentity,
			image.defaultQuality,
			image.defaultExtension,
			pathOpts,
		).absolutePath;
		plant(live, 're-uploaded-after-the-delete');
		const deletedDir = `${dirname(live)}/deleted`;
		plant(`${deletedDir}/test99_test3_987654_deleted_2024-01-01_0900.jpg`, 'the-old-one');

		const restored = await restoreDeletedSectionMediaFiles(
			SECTION_TIPO,
			SECTION_ID,
			mediaColumn(),
			{ mediaRoot: ROOT },
		);
		expect(restored.errors).toEqual([]);
		expect(restored.files).toEqual([]); // nothing restored over the live file
		expect(readFileSync(live, 'utf8')).toBe('re-uploaded-after-the-delete');
		// …and the deleted version STAYS recoverable by hand rather than vanishing.
		expect(existsSync(`${deletedDir}/test99_test3_987654_deleted_2024-01-01_0900.jpg`)).toBe(true);
	});

	test('a snapshot flat value reads PHP get_value(): nolan first, joined with " | "', () => {
		// The `additional_path` bucket is a SIBLING COMPONENT'S VALUE, and both delete
		// doors read it from a snapshot because the row is gone (or about to be
		// emptied). The rule must match ontology_path.ts's DB-side twin or the sweep
		// looks in a different folder than the ingest wrote to.
		expect(snapshotFlatValue([{ lang: 'lg-nolan', value: 'cession' }])).toBe('cession');
		expect(snapshotFlatValue([{ value: 'a' }, { value: 'b' }])).toBe('a | b');
		// A translated component with no nolan item falls back to every item…
		expect(snapshotFlatValue([{ lang: 'lg-spa', value: 'uno' }])).toBe('uno');
		// …and nolan wins when both are present.
		expect(
			snapshotFlatValue([
				{ lang: 'lg-spa', value: 'uno' },
				{ lang: 'lg-nolan', value: 'nolan' },
			]),
		).toBe('nolan');
		expect(snapshotFlatValue(null)).toBe('');
		expect(snapshotFlatValue([{ value: 3 }])).toBe('');
	});

	test('listDeletedVersions is scoped to the extension it was asked for', () => {
		// A tier can hold more than one file since the alternate-extension twins
		// landed, and the deleted/ scan keyed only on the STEM — so restoring the
		// '.jpg' of a tier could hand back the '.avif' twin's bytes under a .jpg name.
		if (image === null) throw new Error('image spec unavailable');
		resetMediaRoot(ROOT);
		const live = buildMediaLocation(
			image,
			imageIdentity,
			image.defaultQuality,
			image.defaultExtension,
			pathOpts,
		).absolutePath;
		const deletedDir = `${dirname(live)}/deleted`;
		plant(`${deletedDir}/test99_test3_987654_deleted_2024-01-01_0900.jpg`, 'jpg');
		plant(`${deletedDir}/test99_test3_987654_deleted_2024-01-01_0900.avif`, 'avif');

		const jpgs = listDeletedVersions(image, imageIdentity, image.defaultQuality, 'jpg', pathOpts);
		expect(jpgs.length).toBe(1);
		expect(jpgs[0]).toContain('.jpg');
	});
});

// ---------------------------------------------------------------------------
// (b) download_fragment
// ---------------------------------------------------------------------------

describe('dd_component_av_api::download_fragment', () => {
	test('the action is registered (both index-row buttons stop 400ing)', () => {
		expect(Object.keys(componentAvApiActions)).toContain('download_fragment');
	});

	test('the fragment filename and directory follow the PHP grammar', () => {
		if (av === null) throw new Error('av spec unavailable');
		expect(fragmentFileName(avIdentity, '17', 'mp4')).toBe('fragment_test94_test3_987654_17.mp4');
		const location = fragmentLocation(av, avIdentity, av.defaultQuality, '17', 'mp4', pathOpts);
		expect(location.relativePath).toBe(
			`/av/${av.defaultQuality}/987000/fragments/fragment_test94_test3_987654_17.mp4`,
		);
		expect(location.absolutePath.startsWith(ROOT)).toBe(true);
	});

	test('a tag_id that is not a plain identifier is REFUSED, not sanitized away', () => {
		if (av === null) throw new Error('av spec unavailable');
		// The tag id reaches the filesystem as part of a filename. A traversal
		// attempt must fail loudly rather than be silently rewritten into some
		// other record's fragment.
		expect(() => fragmentFileName(avIdentity, '../../etc/passwd', 'mp4')).toThrow(/tag_id/);
		expect(() => fragmentFileName(avIdentity, '', 'mp4')).toThrow(/tag_id/);
		expect(() => fragmentFileName(avIdentity, 'a b', 'mp4')).toThrow(/tag_id/);
	});

	test('the watermark argv overlays 10px from the top-right and re-encodes the CUT', () => {
		const argv = buildFragmentWatermarkArgv('/m/cut.mp4', '/m/watermark.png', '/m/out.mp4');
		// No shell, no filtergraph path escaping: the watermark is a second INPUT.
		expect(argv).toContain('/m/watermark.png');
		expect(argv.join(' ')).toContain('overlay=main_w-overlay_w-10:10');
		expect(argv[argv.length - 1]).toBe('/m/out.mp4');
		// It re-encodes the already-cut clip, never the whole source.
		expect(argv).toContain('/m/cut.mp4');
	});

	test('the watermark file path is derived from the media root (PHP DEDALO_AV_WATERMARK_FILE)', () => {
		expect(watermarkFilePath(ROOT)).toBe(join(ROOT, 'av/watermark/watermark.png'));
	});

	test('a watermark request with no watermark file on disk fails LOUDLY', async () => {
		if (av === null) throw new Error('av spec unavailable');
		resetMediaRoot(ROOT);
		plant(
			buildMediaLocation(av, avIdentity, av.defaultQuality, av.defaultExtension, pathOpts)
				.absolutePath,
			'not-really-video',
		);
		await expect(
			buildAvFragment({
				spec: av,
				identity: avIdentity,
				pathOpts,
				quality: av.defaultQuality,
				tagId: '17',
				tcInSeconds: 1,
				tcOutSeconds: 2,
				watermark: true,
			}),
		).rejects.toThrow(/watermark/i);
	});

	test('an out-of-order or empty time range is refused before any spawn', async () => {
		if (av === null) throw new Error('av spec unavailable');
		resetMediaRoot(ROOT);
		plant(
			buildMediaLocation(av, avIdentity, av.defaultQuality, av.defaultExtension, pathOpts)
				.absolutePath,
			'not-really-video',
		);
		await expect(
			buildAvFragment({
				spec: av,
				identity: avIdentity,
				pathOpts,
				quality: av.defaultQuality,
				tagId: '17',
				tcInSeconds: 10,
				tcOutSeconds: 4,
				watermark: false,
			}),
		).rejects.toThrow(/duration/i);
	});

	/**
	 * Synthesize a 3 s test-pattern clip at the scratch identity's default
	 * quality (ffmpeg's lavfi `testsrc` + a sine tone, the tool_posterframe
	 * idiom) and return its path. Nothing outside ROOT is read.
	 */
	async function synthesizeAvSource(): Promise<string> {
		if (av === null) throw new Error('av spec unavailable');
		resetMediaRoot(ROOT);
		const target = buildMediaLocation(
			av,
			avIdentity,
			av.defaultQuality,
			av.defaultExtension,
			pathOpts,
		).absolutePath;
		mkdirSync(dirname(target), { recursive: true });
		await runBinary(
			[
				config.media.binaries.ffmpeg,
				'-y',
				'-f',
				'lavfi',
				'-i',
				'testsrc=size=320x240:duration=3',
				'-f',
				'lavfi',
				'-i',
				'sine=frequency=440:duration=3',
				'-shortest',
				target,
			],
			{ nice: false },
		);
		if (!existsSync(target)) throw new Error(`ffmpeg wrote no clip at ${target}`);
		return target;
	}

	/** A 1×1 PNG — enough for ffmpeg's overlay input, no encoder needed to make it. */
	const ONE_PIXEL_PNG = Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
		'base64',
	);

	for (const watermark of [false, true]) {
		test.if(HAVE_FFMPEG)(
			`a real ${watermark ? 'watermarked ' : ''}cut of a synthesized clip lands in fragments/ and leaves no debris (needs ffmpeg)`,
			async () => {
				if (av === null) throw new Error('av spec unavailable');
				await synthesizeAvSource();
				if (watermark) {
					const mark = watermarkFilePath(ROOT);
					mkdirSync(dirname(mark), { recursive: true });
					writeFileSync(mark, ONE_PIXEL_PNG);
				}

				// ffmpeg is present (the gate above), so a spawn failure here is a
				// failure of the port — it throws, never returns.
				const outcome = await buildAvFragment({
					spec: av,
					identity: avIdentity,
					pathOpts,
					quality: av.defaultQuality,
					tagId: '17',
					tcInSeconds: 0,
					tcOutSeconds: 2,
					watermark,
				});
				expect(existsSync(outcome.absolutePath)).toBe(true);
				expect(outcome.url.endsWith('/fragments/fragment_test94_test3_987654_17.mp4')).toBe(true);
				// The two-pass watermark stages an intermediate cut; NOTHING of it may
				// survive beside the fragment (the atomic writer's finally owns both).
				expect(readdirSync(dirname(outcome.absolutePath))).toEqual([
					'fragment_test94_test3_987654_17.mp4',
				]);
			},
		);
	}
});

// ---------------------------------------------------------------------------
// (c) the SVG envelope
// ---------------------------------------------------------------------------

/** A minimal annotated envelope: the raster group + one drawing layer. */
function annotatedEnvelope(rasterUrl: string, width = 100, height = 50): string {
	return (
		`<svg version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
		`width="${width}" height="${height}" viewBox="0,0,${width},${height}">` +
		`<g id="raster"><image width="${width}" height="${height}" xlink:href="${rasterUrl}"/></g>` +
		`<g id="layer_1" class="annotation"><path d="M10,10 L40,40" stroke="#ff0000"/></g></svg>`
	);
}

describe('component_image SVG envelope', () => {
	test('writeSvgEnvelope persists the client layers at the envelope path', async () => {
		if (image === null) throw new Error('image spec unavailable');
		resetMediaRoot(ROOT);
		const svg = annotatedEnvelope('/dedalo/media/image/1.5MB/0/test99_test3_987654.jpg');
		const written = await writeSvgEnvelope(image, imageIdentity, pathOpts, svg);
		const location = svgOverlayLocation(image, imageIdentity, pathOpts);
		expect(written).toBe(location.absolutePath);
		expect(readFileSync(location.absolutePath, 'utf8')).toBe(svg);
		// …and the read now offers it to the client.
		expect(baseSvgUrl(image, imageIdentity, pathOpts)).toContain(
			'/image/svg/987000/test99_test3_987654.svg',
		);
	});

	test('an envelope carrying active content is REFUSED, never written', async () => {
		if (image === null) throw new Error('image spec unavailable');
		resetMediaRoot(ROOT);
		const location = svgOverlayLocation(image, imageIdentity, pathOpts);
		for (const hostile of [
			'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
			'<svg xmlns="http://www.w3.org/2000/svg"><g onload="alert(1)"/></svg>',
			'<svg xmlns="http://www.w3.org/2000/svg"><a xlink:href="javascript:alert(1)"><rect/></a></svg>',
			'<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><b>x</b></foreignObject></svg>',
			'<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg"/>',
			'not an svg at all',
		]) {
			await expect(writeSvgEnvelope(image, imageIdentity, pathOpts, hostile)).rejects.toThrow(
				/svg envelope/i,
			);
		}
		expect(existsSync(location.absolutePath)).toBe(false);
	});

	test('a drawing whose TEXT reads like a handler is still written (no false refusal)', async () => {
		// The refusal replays on every later save of the stored item, so a false
		// positive does not cost one save — it wedges the record's image component.
		// An attribute in an XML document is quoted or the document does not parse,
		// which is what separates the two cases below.
		if (image === null) throw new Error('image spec unavailable');
		resetMediaRoot(ROOT);
		const annotation =
			'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
			'<text x="1" y="1">switch position on=off, lever on = up</text></svg>';
		await expect(
			writeSvgEnvelope(image, imageIdentity, pathOpts, annotation),
		).resolves.toBeDefined();
		expect(
			readFileSync(svgOverlayLocation(image, imageIdentity, pathOpts).absolutePath, 'utf8'),
		).toBe(annotation);
		// …while the real thing is still refused, single and double quoted alike.
		for (const hostile of [
			'<svg xmlns="http://www.w3.org/2000/svg"><g onload="alert(1)"/></svg>',
			"<svg xmlns='http://www.w3.org/2000/svg'><g onmouseover='alert(1)'/></svg>",
		]) {
			await expect(writeSvgEnvelope(image, imageIdentity, pathOpts, hostile)).rejects.toThrow(
				/svg envelope/i,
			);
		}
	});

	test.if(HAVE_MAGICK)(
		'regeneration PRESERVES an annotated envelope and re-points its raster (needs ImageMagick)',
		async () => {
			if (image === null) throw new Error('image spec unavailable');
			await synthesizeRaster();

			const location = svgOverlayLocation(image, imageIdentity, pathOpts);
			// An envelope whose raster href points at a STALE host path, plus a drawing.
			plant(location.absolutePath, annotatedEnvelope('/old/host/path/test99_test3_987654.jpg'));

			const result = await createDefaultSvgFile(image, imageIdentity, pathOpts);
			expect(result).toBe(location.absolutePath);
			const after = readFileSync(location.absolutePath, 'utf8');
			// The scholarship survives…
			expect(after).toContain('id="layer_1"');
			expect(after).toContain('M10,10 L40,40');
			// …and the raster is back in step with where the file actually is.
			expect(after).not.toContain('/old/host/path/');
			expect(after).toContain('/image/1.5MB/987000/test99_test3_987654.jpg');
		},
	);

	test.if(HAVE_MAGICK)(
		'no envelope on disk still yields the default one, sized from the raster (needs ImageMagick)',
		async () => {
			if (image === null) throw new Error('image spec unavailable');
			await synthesizeRaster();

			const written = await createDefaultSvgFile(image, imageIdentity, pathOpts);
			expect(written).not.toBeNull();
			const svg = readFileSync(written as string, 'utf8');
			expect(svg).toContain('<g id="raster">');
			expect(svg).toContain('/image/1.5MB/987000/test99_test3_987654.jpg');
			// The dimensions are READ from the raster, not defaulted: the synthesized
			// file is 100×50, and a 0×0 envelope renders as a blank edit view.
			expect(svg).toContain('width="100"');
			expect(svg).toContain('height="50"');
		},
	);

	test.if(HAVE_MAGICK)(
		'an unusable envelope (empty / not an svg) is replaced, not preserved (needs ImageMagick)',
		async () => {
			if (image === null) throw new Error('image spec unavailable');
			await synthesizeRaster();
			const location = svgOverlayLocation(image, imageIdentity, pathOpts);
			plant(location.absolutePath, '');

			await createDefaultSvgFile(image, imageIdentity, pathOpts);
			expect(readFileSync(location.absolutePath, 'utf8')).toContain('<g id="raster">');
		},
	);
});

// ---------------------------------------------------------------------------
// WIRING — the PRODUCTION doors, not the helpers they call
//
// The two halves above are library functions, and a library function nothing
// calls is not a fix: the previous round of this work landed both while the
// defective delete path stayed live in `delete_record.ts` and the image save
// path still dropped `svg_file_data` on the floor. These cases therefore drive
// the ENGINE doors — `deleteSectionRecord` and `saveComponentData` — against
// scratch records on the real media root, and go red the moment either door
// stops reaching the implementation.
//
// SCRATCH ONLY: a `test3` record created by `createSectionRecord` (never a
// canonical id), files planted at that record's own paths, both swept in
// afterAll.
// ---------------------------------------------------------------------------

const LIVE_SECTION = 'test3';
const LIVE_TABLE = 'matrix_test';
const IMAGE_TIPO = 'test99';
const USER_ID = -1; // root

describe('the delete and save DOORS reach the media lifecycle', () => {
	const scratchIds: number[] = [];
	const plantedPaths: string[] = [];

	afterAll(async () => {
		for (const path of plantedPaths) rmSync(path, { force: true });
		for (const id of scratchIds) await cleanScratchRecord(LIVE_SECTION, id, LIVE_TABLE);
	});

	/** A scratch test3 record + its image identity/path options on the LIVE root. */
	async function scratchRecord(): Promise<{
		sectionId: number;
		identity: { componentTipo: string; sectionTipo: string; sectionId: number; lang: null };
		opts: Awaited<ReturnType<typeof resolveMediaPathOptions>>;
	}> {
		const sectionId = await createSectionRecord(LIVE_SECTION, USER_ID);
		scratchIds.push(sectionId);
		return {
			sectionId,
			identity: {
				componentTipo: IMAGE_TIPO,
				sectionTipo: LIVE_SECTION,
				sectionId,
				lang: null,
			},
			opts: await resolveMediaPathOptions(IMAGE_TIPO, LIVE_SECTION, sectionId),
		};
	}

	test('deleteSectionRecord moves the record’s media into deleted/', async () => {
		if (image === null) throw new Error('image spec unavailable');
		const { sectionId, identity, opts } = await scratchRecord();
		// The media column as the matrix stores it (one stored item, no files_info —
		// the sweep walks the type census, never that filesystem-derived cache).
		await sql.unsafe(
			`UPDATE ${LIVE_TABLE}
			 SET media = COALESCE(media, '{}'::jsonb) || jsonb_build_object($2::text, $3::text::jsonb)
			 WHERE section_tipo = $1 AND section_id = $4`,
			[LIVE_SECTION, IMAGE_TIPO, JSON.stringify([{ id: 1 }]), sectionId],
		);
		const live = buildMediaLocation(
			image,
			identity,
			image.defaultQuality,
			image.defaultExtension,
			opts,
		).absolutePath;
		plant(live, 'a-scratch-image');
		plantedPaths.push(live);

		const now = new Date(2026, 6, 2, 14, 30, 0);
		const result = await deleteSectionRecord(LIVE_SECTION, sectionId, USER_ID, now);
		expect(result.removed).toBe(true);

		const moved = `${dirname(live)}/deleted/${IMAGE_TIPO}_${LIVE_SECTION}_${String(sectionId)}_deleted_2026-07-02_1430.jpg`;
		plantedPaths.push(moved);
		expect(existsSync(live), 'the file is still live under a deleted record').toBe(false);
		expect(existsSync(moved), 'the file was not moved into deleted/').toBe(true);
		// A MOVE, never a hard delete: the bytes are recoverable.
		expect(readFileSync(moved, 'utf8')).toBe('a-scratch-image');
	}, 60000);

	test('the UNDELETE brings the files back — the delete/restore round trip through both doors', async () => {
		// P1-11 / LIFE-08. `restoreDeletedSectionMediaFiles` was written as "the
		// exact inverse" of the delete's media move, was unit-tested, and had ZERO
		// production callers — while delete_record.ts's own comment asserted the
		// undelete called it. So a Time-Machine section restore put the ROW back,
		// answered ok:true, and left the record's media column pointing at live
		// paths holding no files. Only opening the record showed it.
		if (image === null) throw new Error('image spec unavailable');
		const { sectionId, identity, opts } = await scratchRecord();
		await sql.unsafe(
			`UPDATE ${LIVE_TABLE}
			 SET media = COALESCE(media, '{}'::jsonb) || jsonb_build_object($2::text, $3::text::jsonb)
			 WHERE section_tipo = $1 AND section_id = $4`,
			[LIVE_SECTION, IMAGE_TIPO, JSON.stringify([{ id: 1 }]), sectionId],
		);
		const live = buildMediaLocation(
			image,
			identity,
			image.defaultQuality,
			image.defaultExtension,
			opts,
		).absolutePath;
		plant(live, 'the-original-bytes');
		plantedPaths.push(live);

		const now = new Date(2026, 6, 3, 9, 15, 0);
		expect((await deleteSectionRecord(LIVE_SECTION, sectionId, USER_ID, now)).removed).toBe(true);
		const moved = `${dirname(live)}/deleted/${IMAGE_TIPO}_${LIVE_SECTION}_${String(sectionId)}_deleted_2026-07-03_0915.jpg`;
		plantedPaths.push(moved);
		expect(existsSync(live)).toBe(false);
		expect(existsSync(moved)).toBe(true);

		// The delete's own marker row IS the section snapshot the undelete restores
		// from (tipo = section_tipo — "mark every section delete point in the time").
		const marker = (await sql.unsafe(
			`SELECT id FROM matrix_time_machine
			  WHERE section_tipo = $1 AND section_id = $2 AND tipo = $1
			  ORDER BY id DESC LIMIT 1`,
			[LIVE_SECTION, sectionId],
		)) as { id: number }[];
		expect(marker[0]?.id, 'the delete wrote no section marker to restore from').toBeDefined();

		await toolTimeMachineApplyValue({
			principal: await resolvePrincipal(USER_ID),
			userId: USER_ID,
			options: {
				section_tipo: LIVE_SECTION,
				section_id: sectionId,
				tipo: LIVE_SECTION,
				lang: 'lg-nolan',
				matrix_id: Number(marker[0]?.id),
			},
			background: false,
		} as never);

		// THE ROW IS BACK — and so are the BYTES, at the live path.
		expect(existsSync(live), 'the restore put the row back but not the file').toBe(true);
		expect(readFileSync(live, 'utf8')).toBe('the-original-bytes');
	}, 60000);

	test('saveComponentData persists an image item’s svg_file_data as the envelope', async () => {
		if (image === null) throw new Error('image spec unavailable');
		const { sectionId, identity, opts } = await scratchRecord();
		const location = svgOverlayLocation(image, identity, opts);
		plantedPaths.push(location.absolutePath);
		const svg = annotatedEnvelope(
			`/dedalo/media/image/${image.defaultQuality}/0/${IMAGE_TIPO}_${LIVE_SECTION}_${String(sectionId)}.jpg`,
		);

		const outcome = await saveComponentData({
			componentTipo: IMAGE_TIPO,
			sectionTipo: LIVE_SECTION,
			sectionId,
			lang: 'lg-nolan',
			userId: USER_ID,
			// Exactly what vector_editor.save_data / update_draw_data send.
			changedData: [
				{ action: 'update', id: null, value: { id: 1, lib_data: [], svg_file_data: svg } },
			],
		});
		expect(outcome.ok).toBe(true);
		expect(existsSync(location.absolutePath), 'the save door wrote no envelope').toBe(true);
		expect(readFileSync(location.absolutePath, 'utf8')).toBe(svg);
		// …and the read now offers it to the client (no envelope ⇒ placeholder).
		expect(baseSvgUrl(image, identity, opts)).toContain(`/image/svg/`);
	}, 60000);

	test('a hostile envelope FAILS the save at the door, and writes nothing', async () => {
		if (image === null) throw new Error('image spec unavailable');
		const { sectionId, identity, opts } = await scratchRecord();
		const location = svgOverlayLocation(image, identity, opts);
		plantedPaths.push(location.absolutePath);

		await expect(
			saveComponentData({
				componentTipo: IMAGE_TIPO,
				sectionTipo: LIVE_SECTION,
				sectionId,
				lang: 'lg-nolan',
				userId: USER_ID,
				changedData: [
					{
						action: 'update',
						id: null,
						value: {
							id: 1,
							svg_file_data:
								'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
						},
					},
				],
			}),
		).rejects.toThrow(/svg envelope/i);
		expect(existsSync(location.absolutePath)).toBe(false);
		// The refusal runs BEFORE the row write (PHP create_svg_file precedes
		// parent::save()), so the transaction rolled back and nothing was stored.
		const rows = (await sql.unsafe(
			`SELECT media FROM ${LIVE_TABLE} WHERE section_tipo = $1 AND section_id = $2`,
			[LIVE_SECTION, sectionId],
		)) as { media: Record<string, unknown> | null }[];
		expect(rows[0]?.media?.[IMAGE_TIPO]).toBeUndefined();
	}, 60000);
});
