/**
 * R1 gate: tool_posterframe. The media CORE extracts a frame from a scratch AV
 * (real ffmpeg) into the image original path and regenerates image derivatives
 * (real ImageMagick); audio-only sources yield no frame. The tool module loads
 * with both actions. The DB portal-create + inverse-reference walk are ledgered
 * (media/DB not synced here), matching the media_tools.test.ts convention.
 */
// Migrated to the generic `test` TLD 2026-08-19: every tipo here is a media IDENTITY
// (the `<component>_<section>_<id>` filename grammar) inside this file's own scratch
// media root, so they only have to be real nodes of the right model — they now name
// generic `test` ones (test94 = component_av, test99 = component_image,
// test26 = component_3d, test17 = component_text_area, test80 = component_portal).

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { config } from '../../src/config/config.ts';
import { mediaTypeOf } from '../../src/core/concepts/media.ts';
import { resolveMagick } from '../../src/core/media/engine/imagemagick.ts';
import { runBinary } from '../../src/core/media/engine/spawn.ts';
import { stagingDir } from '../../src/core/media/ingest/add_file.ts';
import type { MediaIdentity, MediaPathOptions } from '../../src/core/media/path.ts';
import {
	createAvPosterframe,
	createIdentifyingImageCore,
	deletePosterframe,
	getAvMediaStreams,
	moveUploadedToMediaDir,
	posterframeAbsolutePath,
} from '../../src/core/media/tools/posterframe.ts';
import { buildVersionCore } from '../../src/core/media/tools/versions.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import { mustGet } from '../helpers/assert.ts';
import { resetMediaRoot } from '../helpers/media_scratch_root.ts';
import { refusalOf } from '../helpers/refusal.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const ROOT = scratchDir('posterframe');
const av = mediaTypeOf('component_av')!;
const image = mediaTypeOf('component_image')!;
const HAVE_FFMPEG = existsSync(config.media.binaries.ffmpeg);
const HAVE_MAGICK = existsSync(resolveMagick());
const HAVE_BOTH = HAVE_FFMPEG && HAVE_MAGICK;

const avIdentity: MediaIdentity = {
	componentTipo: 'test94',
	sectionTipo: 'test3',
	sectionId: 8,
	lang: null,
};
const imageIdentity: MediaIdentity = {
	componentTipo: 'test99',
	sectionTipo: 'test2',
	sectionId: 3,
	lang: null,
};
const pathOpts: MediaPathOptions = { initialMediaPath: '', maxItemsFolder: null, mediaRoot: ROOT };

async function makeAv(name: string, withVideo: boolean): Promise<void> {
	const abs = `${ROOT}/av/original/${name}.mp4`;
	mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
	const argv = withVideo
		? [
				config.media.binaries.ffmpeg,
				'-y',
				'-f',
				'lavfi',
				'-i',
				'testsrc=size=320x240:duration=1',
				'-f',
				'lavfi',
				'-i',
				'sine=frequency=440:duration=1',
				'-shortest',
				abs,
			]
		: [
				config.media.binaries.ffmpeg,
				'-y',
				'-f',
				'lavfi',
				'-i',
				'sine=frequency=440:duration=1',
				'-c:a',
				'aac',
				abs,
			];
	await runBinary(argv, { nice: false });
}

const avCtx = () => ({ spec: av, identity: avIdentity, pathOpts });
const imageCtx = () => ({ spec: image, identity: imageIdentity, pathOpts });

beforeAll(() => resetMediaRoot(ROOT));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe('tool_posterframe core', () => {
	test.if(HAVE_BOTH)(
		'extracts a frame into the image original + regenerates derivatives',
		async () => {
			await makeAv('test94_test3_8', true);
			const out = await createIdentifyingImageCore(avCtx(), imageCtx(), '00:00:00');
			expect(out.created).toBe(true);
			expect(out.posterframePath).toContain('/image/original/test99_test2_3.jpg');
			expect(existsSync(out.posterframePath as string)).toBe(true);
			// derivatives were scanned (at least the original tier is present)
			expect(out.filesInfo.some((e) => e.quality === 'original')).toBe(true);
		},
	);

	test.if(HAVE_FFMPEG)('audio-only source yields no frame (created:false)', async () => {
		await makeAv('test94_test3_8', false);
		rmSync(`${ROOT}/image`, { recursive: true, force: true });
		const out = await createIdentifyingImageCore(avCtx(), imageCtx(), '00:00:00');
		expect(out.created).toBe(false);
		expect(out.posterframePath).toBeNull();
	});

	test('rejects a non-av source / non-image target', async () => {
		await expect(createIdentifyingImageCore(imageCtx(), imageCtx(), '0')).rejects.toThrow(
			/component_av/,
		);
		await expect(createIdentifyingImageCore(avCtx(), avCtx(), '0')).rejects.toThrow(
			/component_image/,
		);
		// One registered caller fact for the whole "wrong model here" family
		// (ERRORS_SPEC §1) — a 400 with the sentence, not an untyped throw.
		expect((await refusalOf(createIdentifyingImageCore(imageCtx(), imageCtx(), '0'))).code).toBe(
			'media.unsupported_operation',
		);
	});
});

describe('component_av posterframe (the tool_posterframe primary path)', () => {
	// This is the create/delete-posterframe path dd_component_av_api serves — the
	// tool's main two buttons. Distinct from the identifying-image (portal) path.
	test.if(HAVE_BOTH)(
		'creates the posterframe under av/posterframe + regenerates the thumb',
		async () => {
			resetMediaRoot(ROOT);
			await makeAv('test94_test3_8', true);
			const ok = await createAvPosterframe(avCtx(), '00:00:00');
			expect(ok).toBe(true);
			const target = posterframeAbsolutePath(av, avIdentity, pathOpts);
			expect(target).toContain('/av/posterframe/test94_test3_8.jpg');
			expect(existsSync(target)).toBe(true);
			// PHP create_posterframe → create_thumb: the thumb is derived from it.
			expect(
				existsSync(
					`${ROOT}/av/${config.media.thumb.quality}/test94_test3_8.${config.media.thumb.extension}`,
				),
			).toBe(true);
		},
	);

	test.if(HAVE_FFMPEG)('audio-only source yields no posterframe (result:false)', async () => {
		resetMediaRoot(ROOT);
		await makeAv('test94_test3_8', false);
		const ok = await createAvPosterframe(avCtx(), '00:00:00');
		expect(ok).toBe(false);
		expect(existsSync(posterframeAbsolutePath(av, avIdentity, pathOpts))).toBe(false);
	});

	test('missing source returns false (never throws)', async () => {
		resetMediaRoot(ROOT);
		expect(await createAvPosterframe(avCtx(), '0')).toBe(false);
	});

	test.if(HAVE_BOTH)(
		'a timecode past the source duration is clamped to a valid frame (short/truncated video)',
		async () => {
			resetMediaRoot(ROOT);
			await makeAv('test94_test3_8', true); // 1-second source
			// Request a frame 30s in — far past EOF. ffmpeg input-seeking (`-ss` before
			// `-i`) past the end yields NO frame → the mjpeg encoder errors and the whole
			// extraction fails. createPosterframe clamps the seek into range, so a poster
			// is still produced instead of silently failing (the tool_posterframe report).
			const ok = await createAvPosterframe(avCtx(), '30');
			expect(ok).toBe(true);
			expect(existsSync(posterframeAbsolutePath(av, avIdentity, pathOpts))).toBe(true);
		},
	);

	test.if(HAVE_BOTH)(
		'delete removes the posterframe and MINTS a replacement for the thumb',
		async () => {
			resetMediaRoot(ROOT);
			await makeAv('test94_test3_8', true);
			await createAvPosterframe(avCtx(), '00:00:00');
			const thumb = `${ROOT}/av/${config.media.thumb.quality}/test94_test3_8.${config.media.thumb.extension}`;
			expect(existsSync(thumb)).toBe(true);

			const outcome = await deletePosterframe(avCtx());
			expect(outcome.ok).toBe(true);
			// The thumb it depicted was retired in the same call — never left serving a
			// picture of a file the operator just deleted…
			expect(outcome.retiredThumb).not.toBeNull();
			// …and because the engine CAN mint an av posterframe, the record does not
			// go pictureless: a replacement frame and its thumb are already back.
			expect(outcome.rebuiltThumb).toBe(thumb);
			expect(existsSync(thumb)).toBe(true);
			expect(existsSync(posterframeAbsolutePath(av, avIdentity, pathOpts))).toBe(true);
		},
	);

	test.if(HAVE_BOTH)('the deleted posterframe is RECOVERABLE (moved, never unlinked)', async () => {
		resetMediaRoot(ROOT);
		await makeAv('test94_test3_8', true);
		await createAvPosterframe(avCtx(), '00:00:00');
		await deletePosterframe(avCtx());
		// The No-hard-delete law: the operator's bytes are one move away.
		const deleted = `${ROOT}/av/posterframe/deleted`;
		expect(existsSync(deleted)).toBe(true);
		expect(readdirSync(deleted).length).toBeGreaterThan(0);
	});

	test('a delete with nothing to delete reports it, and does nothing else', async () => {
		resetMediaRoot(ROOT);
		const outcome = await deletePosterframe(avCtx());
		expect(outcome).toEqual({ ok: false, retiredThumb: null, rebuiltThumb: null });
	});

	test('rejects an unsupported model', async () => {
		await expect(deletePosterframe(imageCtx())).rejects.toThrow(/component_av or component_3d/);
		expect((await refusalOf(deletePosterframe(imageCtx()))).code).toBe(
			'media.unsupported_operation',
		);
	});
});

describe('component_3d posterframe (move staged upload + delete)', () => {
	// The 3D "create posterframe" path: the client renders a canvas snapshot,
	// uploads it to the staging tree, then move_file_to_dir binds it to the record.
	const threeD = mediaTypeOf('component_3d')!;
	const tdIdentity: MediaIdentity = {
		componentTipo: 'test26',
		sectionTipo: 'test3',
		sectionId: 8,
		lang: null,
	};
	const tdCtx = () => ({ spec: threeD, identity: tdIdentity, pathOpts });
	const USER = 42;

	async function stageJpg(tmpName: string): Promise<void> {
		const dir = stagingDir(USER, '3d', ROOT);
		mkdirSync(dir, { recursive: true });
		await runBinary(
			[
				config.media.binaries.ffmpeg,
				'-y',
				'-f',
				'lavfi',
				'-i',
				'color=c=red:s=64x64:d=1',
				'-frames:v',
				'1',
				`${dir}/${tmpName}`,
			],
			{ nice: false },
		);
	}

	test.if(HAVE_BOTH)(
		'moves the staged snapshot into 3d/posterframe + regenerates the thumb',
		async () => {
			resetMediaRoot(ROOT);
			await stageJpg('up_abc.jpg');
			const ok = await moveUploadedToMediaDir({
				ctx: tdCtx(),
				userId: USER,
				keyDir: '3d',
				tmpName: 'up_abc.jpg',
				fileName: 'test26_test3_8.jpg',
				targetDir: 'posterframe',
			});
			expect(ok).toBe(true);
			const target = posterframeAbsolutePath(threeD, tdIdentity, pathOpts);
			expect(target).toContain('/3d/posterframe/test26_test3_8.jpg');
			expect(existsSync(target)).toBe(true);
			// staged source consumed by the move
			expect(existsSync(`${stagingDir(USER, '3d', ROOT)}/up_abc.jpg`)).toBe(false);
			// thumb derived from the posterframe
			expect(
				existsSync(
					`${ROOT}/3d/${config.media.thumb.quality}/test26_test3_8.${config.media.thumb.extension}`,
				),
			).toBe(true);
		},
	);

	test('missing staged source returns false', async () => {
		resetMediaRoot(ROOT);
		const ok = await moveUploadedToMediaDir({
			ctx: tdCtx(),
			userId: USER,
			keyDir: '3d',
			tmpName: 'nope.jpg',
			fileName: 'test26_test3_8.jpg',
			targetDir: 'posterframe',
		});
		expect(ok).toBe(false);
	});

	test('rejects a traversal tmp_name (fail-closed)', async () => {
		await expect(
			moveUploadedToMediaDir({
				ctx: tdCtx(),
				userId: USER,
				keyDir: '3d',
				tmpName: '../../etc/passwd',
				fileName: 'test26_test3_8.jpg',
				targetDir: 'posterframe',
			}),
		).rejects.toThrow();
	});

	// THE 3D THUMB IS BUILT FROM THE POSTERFRAME, NEVER FROM THE MESH. Before this
	// route existed the media-versions panel's thumb gear fell through to the
	// generic image branch, which handed `3d/web/0/<id>.glb` to ImageMagick and
	// answered `identify: no decode delegate for this image format`. Both halves are
	// gated: the build that works, and the refusal that names how to get a
	// posterframe — the refusal is the half that runs on a box with no binaries, and
	// the one an operator meets when nothing has captured the scene yet.
	describe('build_version thumb (the panel gear)', () => {
		test.if(HAVE_BOTH)('builds the thumb from the posterframe', async () => {
			resetMediaRoot(ROOT);
			await stageJpg('up_thumb.jpg');
			await moveUploadedToMediaDir({
				ctx: tdCtx(),
				userId: USER,
				keyDir: '3d',
				tmpName: 'up_thumb.jpg',
				fileName: 'test26_test3_8.jpg',
				targetDir: 'posterframe',
			});
			const thumb = `${ROOT}/3d/${config.media.thumb.quality}/test26_test3_8.${config.media.thumb.extension}`;
			rmSync(thumb, { force: true }); // the move already built one — start from none
			const out = await buildVersionCore(threeD, tdIdentity, pathOpts, config.media.thumb.quality);
			expect(out.built).toEqual([thumb]);
			expect(existsSync(thumb)).toBe(true);
			expect(out.jobId).toBeNull();
		});

		test('with no posterframe it refuses, naming the 3D viewer as the source', async () => {
			resetMediaRoot(ROOT);
			// A model file in the web tier is present — the exact state that used to
			// send a .glb to the raster thumbnailer instead of refusing.
			const model = `${ROOT}/3d/${threeD.defaultQuality}/test26_test3_8.${threeD.defaultExtension}`;
			mkdirSync(model.slice(0, model.lastIndexOf('/')), { recursive: true });
			writeFileSync(model, 'glTF-not-an-image');
			await expect(
				buildVersionCore(threeD, tdIdentity, pathOpts, config.media.thumb.quality),
			).rejects.toThrow(/has no posterframe yet.*3D viewer/s);
			expect(
				existsSync(
					`${ROOT}/3d/${config.media.thumb.quality}/test26_test3_8.${config.media.thumb.extension}`,
				),
			).toBe(false);
		});
	});

	test.if(HAVE_BOTH)(
		'delete removes the 3D posterframe AND retires the thumb (nothing can re-render a mesh)',
		async () => {
			resetMediaRoot(ROOT);
			await stageJpg('up_del.jpg');
			await moveUploadedToMediaDir({
				ctx: tdCtx(),
				userId: USER,
				keyDir: '3d',
				tmpName: 'up_del.jpg',
				fileName: 'test26_test3_8.jpg',
				targetDir: 'posterframe',
			});
			const thumb = `${ROOT}/3d/${config.media.thumb.quality}/test26_test3_8.${config.media.thumb.extension}`;
			expect(existsSync(thumb)).toBe(true);

			const outcome = await deletePosterframe(tdCtx());
			expect(outcome.ok).toBe(true);
			// Retired WITH the posterframe — and NOT rebuilt, because this engine has
			// no mesh renderer: the record honestly falls back to its placeholder
			// until a browser captures a new scene.
			expect(outcome.retiredThumb).not.toBeNull();
			expect(outcome.rebuiltThumb).toBeNull();
			expect(existsSync(thumb)).toBe(false);
			expect(existsSync(posterframeAbsolutePath(threeD, tdIdentity, pathOpts))).toBe(false);

			expect((await deletePosterframe(tdCtx())).ok).toBe(false);
		},
	);
});

describe('component_av get_media_streams (player render path)', () => {
	// The AV player edit view calls this on every render; the tool can't open
	// without it (PHP dd_component_av_api::get_media_streams → ffprobe).
	test.if(HAVE_FFMPEG)('probes the streams of an existing quality file', async () => {
		resetMediaRoot(ROOT);
		await makeAv('test94_test3_8', true);
		const probe = await getAvMediaStreams(avCtx(), 'original');
		expect(probe).not.toBeNull();
		expect(Array.isArray(probe!.streams)).toBe(true);
		expect(probe!.streams.some((s) => (s as { codec_type?: string }).codec_type === 'video')).toBe(
			true,
		);
	});

	test('returns null when no file exists at the quality (client degrades to [])', async () => {
		resetMediaRoot(ROOT);
		expect(await getAvMediaStreams(avCtx(), 'original')).toBeNull();
	});

	test('rejects a non-av context', async () => {
		await expect(getAvMediaStreams(imageCtx())).rejects.toThrow(/component_av/);
	});
});

/**
 * SEC gate (audit 2026-07-28): create_identifying_image WRITES a new record
 * through a portal on a CALLER-SUPPLIED host locator (item_value.section_tipo /
 * .section_id). The declarative record/1 gate covers the AV SOURCE only, so the
 * host record needs its own per-record scope assertion — PHP does exactly that
 * (class.tool_posterframe.php:152-160, SEC-024 §9.4). Without it a user could
 * create a portal element on a record outside their projects filter.
 *
 * Driven with a SUPERUSER id but isGlobalAdmin:false: getPermissions
 * short-circuits on the id (so the portal WRITE gate passes) while
 * isRecordInScope is still evaluated literally. The host section_id does not
 * exist, so no scope can contain it. `tipo` is deliberately a non-media
 * component: BEFORE the fix the handler fell through to the media resolve and
 * failed there, which is what this asserts against — and neither branch writes.
 */
describe('create_identifying_image per-record scope gate', () => {
	const scopedPrincipal: Principal = { userId: -1, isGlobalAdmin: false, isDeveloper: false };

	test('denies a portal host record outside the caller scope', async () => {
		const loaded = await getLoadedTool('tool_posterframe');
		const handler = mustGet(
			loaded!.module.apiActions.create_identifying_image,
			'create_identifying_image',
		).handler;
		const refusal = await refusalOf(
			handler({
				principal: scopedPrincipal,
				userId: -1,
				background: false,
				options: {
					tipo: 'test17', // component_text_area — never reached once the gate fires
					section_tipo: 'test3',
					section_id: 1,
					current_time: '00:00:01',
					item_value: {
						component_portal: 'test80',
						component_image: 'test99',
						section_tipo: 'test3',
						section_id: 99999999, // no such record — cannot be in any scope
					},
				},
			}),
		);
		expect(refusal.code).toBe('perm.out_of_scope');
	});
});

describe('tool_posterframe module', () => {
	test('loads with both actions gated at record level', async () => {
		const loaded = await getLoadedTool('tool_posterframe');
		expect(loaded).not.toBeNull();
		const actions = loaded!.module.apiActions;
		expect(Object.keys(actions).sort()).toEqual([
			'create_identifying_image',
			'get_ar_identifying_image',
		]);
		// create_identifying_image names an AV component: PHP asserts the tipo PAIR
		// (class.tool_posterframe.php:136-138) plus the record scope -> 'record_tipo'.
		expect(mustGet(actions.create_identifying_image, 'create_identifying_image').permission).toBe(
			'record_tipo',
		);
		// get_ar_identifying_image names NO component — its handler and client send
		// only section_tipo + section_id, and PHP asserts assert_section_permission(1)
		// + assert_record_in_user_scope (:382-384) -> 'record'. Gating a pair here made
		// the action unsatisfiable for every caller, global admins included.
		expect(mustGet(actions.get_ar_identifying_image, 'get_ar_identifying_image').permission).toBe(
			'record',
		);
	});
});
