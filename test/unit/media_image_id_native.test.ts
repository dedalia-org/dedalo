/**
 * IMAGE_ID FILE STEM GATE (T1-10 / O06) — a `component_image` declaring
 * `properties.image_id` names its FILES by a sibling component's value on the
 * record (PHP component_image::get_id, class.component_image.php:158-219; v6
 * identical): rsc29 → rsc34 'Filename' writes `photo_2.jpg`, not
 * `rsc29_rsc170_7.jpg`.
 *
 * Before T1-10 only the indexation grid read the property: upload, regenerate,
 * rescan, the edit view's `base_svg_url`, record delete/restore and duplicate
 * all addressed the identifier, so a PHP-era record lost its vector envelope in
 * edit, its index on the first rescan, and its derivatives on the first upload —
 * and a delete left its files live.
 *
 * Scratch discipline: the situation is built HERE (scratch TLD `zzmiid`, swept
 * after), every record is created at runtime and deleted, every media byte lands
 * under a marked per-run scratch root — except the one `base_svg_url` case,
 * whose emitter reads the configured (suite) root: it plants one file there by
 * path and removes it by path.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { mediaTypeOf } from '../../src/core/concepts/media.ts';
import { type MatrixRecord, readMatrixRecord } from '../../src/core/db/matrix.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { mediaEmitHook } from '../../src/core/media/component_emit.ts';
import { resolveMagick } from '../../src/core/media/engine/binaries.ts';
import { runBinary } from '../../src/core/media/engine/spawn.ts';
import {
	duplicateSectionMediaFiles,
	removeSectionMediaFiles,
	restoreDeletedSectionMediaFiles,
} from '../../src/core/media/file_ops.ts';
import { stagingDir } from '../../src/core/media/ingest/add_file.ts';
import { processUploadedFile } from '../../src/core/media/ingest/process_uploaded_file.ts';
import {
	completeMediaPathOptions,
	resolveFileIdOverride,
	resolveMediaPathOptions,
} from '../../src/core/media/ontology_path.ts';
import {
	assertMediaFileStem,
	buildMediaIdentifier,
	buildMediaLocation,
	type MediaIdentity,
	type MediaPathOptions,
} from '../../src/core/media/path.ts';
import { regenerateMediaDerivatives, rescanMediaItems } from '../../src/core/media/repair.ts';
import { svgOverlayLocation } from '../../src/core/media/svg_overlay.ts';
import { resolveMediaToolContext } from '../../src/core/media/tool_support.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { EmissionContext } from '../../src/core/resolve/component_data.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { deleteSectionRecord } from '../../src/core/section/record/delete_record.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { magickTestEnv } from '../helpers/magick_test_env.ts';
import { resetMediaRoot } from '../helpers/media_scratch_root.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const ROOT = scratchDir('media_image_id');
const USER_ID = -1;
const image = mediaTypeOf('component_image');
if (image === null) throw new Error('component_image spec missing');

const SECTION = 'zzmiid1';
/** component_image declaring image_id → STEM_SIBLING. */
const IMAGE = 'zzmiid3';
const STEM_SIBLING = 'zzmiid4';
/** component_image WITHOUT image_id. */
const PLAIN_IMAGE = 'zzmiid5';
/** A NON-image (component_pdf) declaring image_id → PDF_SIBLING: inert (PHP: image-only). */
const PDF_SIBLING = 'zzmiid6';
const PDF = 'zzmiid7';

const ONTOLOGY = situation({
	name: 'image_id file stem',
	tld: 'zzmiid',
	nodes: [
		{
			tipo: SECTION,
			parent: 'test1',
			model: 'section',
			order_number: 92,
			term: { 'lg-eng': 'image_id stem — section' },
			relations: [{ tipo: 'test24' }],
		},
		{ tipo: 'zzmiid2', parent: SECTION, model: 'section_group', order_number: 1 },
		{
			tipo: IMAGE,
			parent: 'zzmiid2',
			model: 'component_image',
			order_number: 1,
			properties: { max_items_folder: 1000, image_id: STEM_SIBLING },
		},
		{
			tipo: STEM_SIBLING,
			parent: 'zzmiid2',
			model: 'component_input_text',
			order_number: 2,
			term: { 'lg-eng': 'Filename' },
		},
		{
			tipo: PLAIN_IMAGE,
			parent: 'zzmiid2',
			model: 'component_image',
			order_number: 3,
			properties: { max_items_folder: 1000 },
		},
		{
			tipo: PDF_SIBLING,
			parent: 'zzmiid2',
			model: 'component_input_text',
			order_number: 4,
			term: { 'lg-eng': 'Not a stem' },
		},
		{
			tipo: PDF,
			parent: 'zzmiid2',
			model: 'component_pdf',
			order_number: 5,
			properties: { max_items_folder: 1000, image_id: PDF_SIBLING },
		},
	],
});

const scratch: number[] = [];
async function scratchRecord(): Promise<number> {
	const sectionId = await createSectionRecord(SECTION, USER_ID);
	scratch.push(sectionId);
	return sectionId;
}

async function setValue(sectionId: number, componentTipo: string, value: string): Promise<void> {
	const result = await saveComponentData({
		componentTipo,
		sectionTipo: SECTION,
		sectionId,
		lang: 'lg-nolan',
		changedData: [{ action: 'set_data', id: null, value: [{ value, lang: 'lg-nolan' }] }],
		userId: USER_ID,
	});
	if (!result.ok) throw new Error(`setValue ${componentTipo}: ${result.message}`);
}

async function readRecord(sectionId: number): Promise<MatrixRecord> {
	const table = await getMatrixTableFromTipo(SECTION);
	if (table === null) throw new Error('no matrix table');
	const record = await readMatrixRecord(table, SECTION, sectionId);
	if (record === null) throw new Error(`record ${SECTION}/${sectionId} missing`);
	return record;
}

function identityOf(sectionId: number, componentTipo = IMAGE): MediaIdentity {
	return { componentTipo, sectionTipo: SECTION, sectionId, lang: null };
}

/** A stem unique to the record (one underscore: never parses as a record's file). */
function stemFor(sectionId: number): string {
	return `photo_${sectionId}`;
}

function bucketOf(sectionId: number): number {
	return 1000 * Math.floor(sectionId / 1000);
}

/** A real NxN jpeg (ImageMagick) at an absolute path. */
async function makeJpeg(absolute: string): Promise<void> {
	mkdirSync(dirname(absolute), { recursive: true });
	await runBinary([resolveMagick(), '-size', '16x16', 'xc:red', absolute], {
		nice: false,
		env: magickTestEnv(),
	});
}

/** A record with its stem sibling filled, plus its record-scoped options on the scratch root. */
async function stemRecord(): Promise<{ sectionId: number; stem: string; opts: MediaPathOptions }> {
	const sectionId = await scratchRecord();
	const stem = stemFor(sectionId);
	await setValue(sectionId, STEM_SIBLING, stem);
	const opts = { ...(await resolveMediaPathOptions(IMAGE, SECTION, sectionId)), mediaRoot: ROOT };
	return { sectionId, stem, opts };
}

beforeAll(async () => {
	await ensureSituation(ONTOLOGY);
	resetMediaRoot(ROOT);
});

afterAll(async () => {
	const failures: string[] = [];
	for (const sectionId of scratch) {
		try {
			const outcome = await deleteSectionRecord(SECTION, sectionId, USER_ID);
			if (outcome.removed !== true) failures.push(`${sectionId}: ${JSON.stringify(outcome)}`);
			await sql.unsafe(
				'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
				[SECTION, sectionId],
			);
		} catch (error) {
			failures.push(`${sectionId}: ${(error as Error).message}`);
		}
	}
	rmSync(ROOT, { recursive: true, force: true });
	expect(await dropSituation(ONTOLOGY)).toBe(0);
	if (failures.length > 0) throw new Error(`scratch records left behind: ${failures.join(' | ')}`);
});

describe('L1 the resolver: image_id is a record value, image-only, three states', () => {
	test('a filled sibling is the TRIMMED stem; empty → null; section-scoped → undefined', async () => {
		const sectionId = await scratchRecord();
		expect((await resolveMediaPathOptions(IMAGE, SECTION, sectionId)).fileIdOverride).toBeNull();
		await setValue(sectionId, STEM_SIBLING, `  ${stemFor(sectionId)} `);
		expect((await resolveMediaPathOptions(IMAGE, SECTION, sectionId)).fileIdOverride).toBe(
			stemFor(sectionId),
		);
		expect((await resolveMediaPathOptions(IMAGE, SECTION)).fileIdOverride).toBeUndefined();
	});

	test('an image without image_id, and a NON-image declaring it, resolve null', async () => {
		const sectionId = await scratchRecord();
		await setValue(sectionId, STEM_SIBLING, stemFor(sectionId));
		await setValue(sectionId, PDF_SIBLING, 'not_a_stem');
		expect(
			(await resolveMediaPathOptions(PLAIN_IMAGE, SECTION, sectionId)).fileIdOverride,
		).toBeNull();
		expect((await resolveMediaPathOptions(PDF, SECTION, sectionId)).fileIdOverride).toBeNull();
	});

	test('completeMediaPathOptions fills the stem and never overrides a resolved one', async () => {
		const { sectionId, stem } = await stemRecord();
		const filled = await completeMediaPathOptions(identityOf(sectionId), {
			initialMediaPath: '',
			maxItemsFolder: 1000,
		});
		expect(filled.fileIdOverride).toBe(stem);
		const kept = await completeMediaPathOptions(identityOf(sectionId), {
			initialMediaPath: '',
			maxItemsFolder: 1000,
			fileIdOverride: null,
		});
		expect(kept.fileIdOverride).toBeNull();
	});
});

describe('L2 the grammar: the stem names the files, the identifier stays the clone signature', () => {
	test('quality files and the SVG envelope are <stem>.<ext>', async () => {
		const { sectionId, stem, opts } = await stemRecord();
		const bucket = bucketOf(sectionId);
		expect(
			buildMediaLocation(image, identityOf(sectionId), '1.5MB', 'jpg', opts).relativePath,
		).toBe(`/image/1.5MB/${bucket}/${stem}.jpg`);
		expect(svgOverlayLocation(image, identityOf(sectionId), opts).relativePath).toBe(
			`/image/svg/${bucket}/${stem}.svg`,
		);
		expect(buildMediaIdentifier(identityOf(sectionId))).toBe(`${IMAGE}_${SECTION}_${sectionId}`);
	});
});

describe('L3 upload: the ingest writes under the stem (tool_upload call shape)', () => {
	test('section-scoped options in, <stem>.jpg out — original, default quality and envelope', async () => {
		const sectionId = await scratchRecord();
		const stem = stemFor(sectionId);
		await setValue(sectionId, STEM_SIBLING, stem);
		const keyDir = `kd_stem_${sectionId}`;
		await makeJpeg(`${stagingDir(USER_ID, keyDir, ROOT)}/staged.jpg`);
		const sectionScoped = await resolveMediaPathOptions(IMAGE, SECTION);
		const result = await processUploadedFile({
			spec: image,
			identity: identityOf(sectionId),
			pathOpts: { ...sectionScoped, mediaRoot: ROOT },
			userId: USER_ID,
			keyDir,
			tmpName: 'staged.jpg',
			extension: 'jpg',
		});
		const bucket = bucketOf(sectionId);
		expect(result.originalFileName).toBe(`${stem}.jpg`);
		expect(existsSync(`${ROOT}/image/original/${bucket}/${stem}.jpg`)).toBe(true);
		expect(existsSync(`${ROOT}/image/${image.defaultQuality}/${bucket}/${stem}.jpg`)).toBe(true);
		expect(existsSync(`${ROOT}/image/svg/${bucket}/${stem}.svg`)).toBe(true);
		expect(
			existsSync(`${ROOT}/image/original/${bucket}/${IMAGE}_${SECTION}_${sectionId}.jpg`),
		).toBe(false);
		const indexed = result.filesInfo
			.filter((entry) => entry.file_exist)
			.map((entry) => entry.file_path ?? '');
		expect(indexed.length).toBeGreaterThan(0);
		for (const path of indexed) expect(path).toContain(`/${stem}.`);
	}, 60_000);
});

describe('L4 regenerate: the media tools resolve the stem (resolveMediaToolContext)', () => {
	test('derivatives are rebuilt from a PHP-era <stem> original', async () => {
		const sectionId = await scratchRecord();
		const stem = stemFor(sectionId);
		await setValue(sectionId, STEM_SIBLING, stem);
		const ctx = await resolveMediaToolContext({
			tipo: IMAGE,
			section_tipo: SECTION,
			section_id: sectionId,
		});
		expect(ctx.pathOpts.fileIdOverride).toBe(stem);
		const pathOpts = { ...ctx.pathOpts, mediaRoot: ROOT };
		const bucket = bucketOf(sectionId);
		await makeJpeg(`${ROOT}/image/original/${bucket}/${stem}.jpg`);
		const errors = await regenerateMediaDerivatives({
			componentTipo: IMAGE,
			sectionTipo: SECTION,
			sectionId,
			model: 'component_image',
			items: [{ lang: null, files_info: [] }],
			pathOpts,
		});
		expect(errors).toEqual([]);
		expect(existsSync(`${ROOT}/image/${image.defaultQuality}/${bucket}/${stem}.jpg`)).toBe(true);
	}, 60_000);
});

describe('L5 rescan: a PHP-era record GROWS its index from the stem files', () => {
	test('rescanMediaItems lists <stem> files (record-scoped options)', async () => {
		const { sectionId, stem, opts } = await stemRecord();
		const bucket = bucketOf(sectionId);
		await makeJpeg(`${ROOT}/image/original/${bucket}/${stem}.jpg`);
		await makeJpeg(`${ROOT}/image/${image.defaultQuality}/${bucket}/${stem}.jpg`);
		const { items } = rescanMediaItems([{ lang: null, files_info: [] }], {
			spec: image,
			identityBase: { componentTipo: IMAGE, sectionTipo: SECTION, sectionId },
			pathOpts: opts,
			holdShrink: true,
		});
		const filesInfo = (items[0] as { files_info: { file_exist: boolean; file_path: string }[] })
			.files_info;
		const existing = filesInfo.filter((entry) => entry.file_exist).map((entry) => entry.file_path);
		expect(existing).toContain(`/image/original/${bucket}/${stem}.jpg`);
		expect(existing).toContain(`/image/${image.defaultQuality}/${bucket}/${stem}.jpg`);
	});
});

describe('L6 emit: the edit view finds the <stem>.svg envelope (base_svg_url)', () => {
	test('section read edit mode carries the stem envelope URL', async () => {
		const sectionId = await scratchRecord();
		const stem = stemFor(sectionId);
		await setValue(sectionId, STEM_SIBLING, stem);
		// The emitter reads the CONFIGURED root (the suite's marked media tree).
		const resolved = await resolveMediaPathOptions(IMAGE, SECTION, sectionId);
		const envelope = svgOverlayLocation(image, identityOf(sectionId), resolved);
		expect(envelope.relativePath.endsWith(`/${stem}.svg`)).toBe(true);
		if (existsSync(envelope.absolutePath)) {
			throw new Error(`refusing to adopt an existing file: ${envelope.absolutePath}`);
		}
		mkdirSync(dirname(envelope.absolutePath), { recursive: true });
		writeFileSync(envelope.absolutePath, '<svg/>');
		try {
			const record = await readRecord(sectionId);
			const emission = new EmissionContext();
			await mediaEmitHook.emitItem?.({
				ddo: { tipo: IMAGE, section_tipo: SECTION } as never,
				record,
				row: { section_tipo: SECTION, section_id: sectionId },
				model: 'component_image',
				ddoMode: 'edit',
				ddoLang: 'lg-nolan',
				defaultMode: 'edit',
				defaultLang: 'lg-nolan',
				callerTipo: SECTION,
				emission,
				door: 'read',
			});
			const url = (emission.items[0] as { base_svg_url?: unknown }).base_svg_url;
			expect(typeof url).toBe('string');
			expect(String(url)).toContain(`${envelope.relativePath}?v=`);
		} finally {
			rmSync(envelope.absolutePath, { force: true });
		}
	});
});

describe('L7 record delete/restore sweeps the stem files (post-commit snapshot path)', () => {
	test('the snapshot sibling names the files even when the row no longer does', async () => {
		const { sectionId, stem } = await stemRecord();
		const bucket = bucketOf(sectionId);
		const live = `${ROOT}/image/${image.defaultQuality}/${bucket}/${stem}.jpg`;
		await makeJpeg(live);
		const snapshot = (await readRecord(sectionId)).columns as Record<string, unknown>;
		const mediaColumn = { [IMAGE]: [{ lang: null, files_info: [] }] };
		// The row's sibling is gone (emptied / deleted) — only the snapshot knows the stem.
		await setValue(sectionId, STEM_SIBLING, '');
		const removed = await removeSectionMediaFiles(SECTION, sectionId, mediaColumn, {
			mediaRoot: ROOT,
			snapshot,
		});
		expect(removed.errors).toEqual([]);
		expect(existsSync(live)).toBe(false);
		expect(removed.files.some((path) => path.includes(`/deleted/${stem}_deleted_`))).toBe(true);
		const restored = await restoreDeletedSectionMediaFiles(SECTION, sectionId, mediaColumn, {
			mediaRoot: ROOT,
			snapshot,
		});
		expect(restored.errors).toEqual([]);
		expect(existsSync(live)).toBe(true);
	}, 60_000);
});

describe('L8 duplicate: a shared stem never copies a file onto itself', () => {
	test('the source file stays intact and the component reports why nothing was copied', async () => {
		const { sectionId, stem } = await stemRecord();
		const target = await scratchRecord();
		const bucket = bucketOf(sectionId);
		const source = `${ROOT}/image/original/${bucket}/${stem}.jpg`;
		await makeJpeg(source);
		const before = readFileSync(source);
		const sourceColumns = {
			...((await readRecord(sectionId)).columns as Record<string, unknown>),
			media: { [IMAGE]: [{ lang: null, files_info: [] }] },
		};
		const { perComponent } = await duplicateSectionMediaFiles(
			SECTION,
			sectionId,
			target,
			sourceColumns,
			{ mediaRoot: ROOT },
		);
		const copy = perComponent.find((entry) => entry.tipo === IMAGE);
		expect(copy?.sourceFiles).toBe(1);
		expect(copy?.copiedFiles).toBe(0);
		expect(copy?.error).toContain('image_id');
		expect(readFileSync(source).equals(before)).toBe(true);
	}, 60_000);
});

describe('L9 refusals: a stem that is no file name, or names another record, is refused', () => {
	test('the stem law (pure)', () => {
		const own = identityOf(7);
		for (const bad of ['a/b', 'a\\b', '.', '..', 'x"y', 'a<b', 'a>b', 'a\0b', 'a\nb']) {
			expect(() => assertMediaFileStem(bad, own)).toThrow(/image_id file name/);
		}
		// another record's file name (the media-protection grammar maps it to 8 / zzother1)
		expect(() => assertMediaFileStem(`${IMAGE}_${SECTION}_8`, own)).toThrow(/names record/);
		expect(() => assertMediaFileStem('x_zzother1_7', own)).toThrow(/names record/);
		// its own identifier, a plain stem, and one mapping to itself are accepted
		expect(assertMediaFileStem(`${IMAGE}_${SECTION}_7`, own)).toBe(`${IMAGE}_${SECTION}_7`);
		expect(assertMediaFileStem('photo_2', own)).toBe('photo_2');
		expect(assertMediaFileStem(`scan_${SECTION}_7`, own)).toBe(`scan_${SECTION}_7`);
	});

	test('a refused stem stops the upload before anything is written', async () => {
		for (const bad of ['a/b', '..', 'x"y']) {
			const sectionId = await scratchRecord();
			await setValue(sectionId, STEM_SIBLING, bad);
			await expect(resolveFileIdOverride(IMAGE, SECTION, sectionId)).rejects.toThrow(
				/image_id file name/,
			);
		}
		const sectionId = await scratchRecord();
		await setValue(sectionId, STEM_SIBLING, `${IMAGE}_${SECTION}_${sectionId + 1}`);
		const keyDir = `kd_refused_${sectionId}`;
		const staged = `${stagingDir(USER_ID, keyDir, ROOT)}/staged.jpg`;
		await makeJpeg(staged);
		const sectionScoped = await resolveMediaPathOptions(IMAGE, SECTION);
		let refusal: unknown = null;
		try {
			await processUploadedFile({
				spec: image,
				identity: identityOf(sectionId),
				pathOpts: { ...sectionScoped, mediaRoot: ROOT },
				userId: USER_ID,
				keyDir,
				tmpName: 'staged.jpg',
				extension: 'jpg',
			});
		} catch (error) {
			refusal = error;
		}
		expect((refusal as { code?: string } | null)?.code).toBe('media.invalid_identifier');
		expect(existsSync(staged)).toBe(true);
		const dir = `${ROOT}/image/original/${bucketOf(sectionId)}`;
		expect(existsSync(`${dir}/${IMAGE}_${SECTION}_${sectionId + 1}.jpg`)).toBe(false);
		expect(existsSync(`${dir}/${IMAGE}_${SECTION}_${sectionId}.jpg`)).toBe(false);
	}, 60_000);
});

describe('L10 deleted versions match ONE stem exactly (T1-10 review)', () => {
	test("restoring 'coin_N' never takes 'coin_N_reverse''s soft-deleted bytes", async () => {
		const a = await scratchRecord();
		const b = await scratchRecord();
		const stemA = `coin_${a}`;
		const stemB = `coin_${a}_reverse`;
		await setValue(a, STEM_SIBLING, stemA);
		await setValue(b, STEM_SIBLING, stemB);
		const dirOf = (sectionId: number): string =>
			`${ROOT}/image/${image.defaultQuality}/${bucketOf(sectionId)}`;
		const liveA = `${dirOf(a)}/${stemA}.jpg`;
		const liveB = `${dirOf(b)}/${stemB}.jpg`;
		// The prefix collision needs both in ONE deleted/ folder.
		expect(dirOf(a)).toBe(dirOf(b));
		mkdirSync(dirOf(a), { recursive: true });
		writeFileSync(liveA, 'bytes of A');
		writeFileSync(liveB, 'bytes of B');
		const mediaColumn = { [IMAGE]: [{ lang: null, files_info: [] }] };
		const snapshotA = (await readRecord(a)).columns as Record<string, unknown>;
		const snapshotB = (await readRecord(b)).columns as Record<string, unknown>;
		const now = new Date(2026, 10, 12, 14, 0);
		for (const [sectionId, snapshot] of [
			[a, snapshotA],
			[b, snapshotB],
		] as const) {
			const removed = await removeSectionMediaFiles(SECTION, sectionId, mediaColumn, {
				mediaRoot: ROOT,
				snapshot,
				now,
			});
			expect(removed.errors).toEqual([]);
		}
		const deletedB = `${dirOf(b)}/deleted/${stemB}_deleted_2026-11-12_1400.jpg`;
		expect(existsSync(deletedB)).toBe(true);
		const restored = await restoreDeletedSectionMediaFiles(SECTION, a, mediaColumn, {
			mediaRoot: ROOT,
			snapshot: snapshotA,
		});
		expect(restored.errors).toEqual([]);
		expect(readFileSync(liveA, 'utf8')).toBe('bytes of A');
		expect(existsSync(deletedB)).toBe(true);
		expect(existsSync(liveB)).toBe(false);
	});
});

describe('L11 camera / inventory names are stems: only a TIPO-shaped token names a record (T1-10 review)', () => {
	test('an all-digit "section" token names no record', () => {
		const own = identityOf(7);
		for (const name of ['IMG_20230512_142233', 'inv_1987_23', 'DSC_0001_2', 'scan_2024_07_15']) {
			expect(assertMediaFileStem(name, own)).toBe(name);
		}
		// tipo-shaped tokens still name a record
		expect(() => assertMediaFileStem('IMG_rsc170_142233', own)).toThrow(/names record/);
	});

	test('the media tools resolve a camera-name stem instead of refusing the record', async () => {
		const sectionId = await scratchRecord();
		await setValue(sectionId, STEM_SIBLING, 'IMG_20230512_142233');
		const ctx = await resolveMediaToolContext({
			tipo: IMAGE,
			section_tipo: SECTION,
			section_id: sectionId,
		});
		expect(ctx.pathOpts.fileIdOverride).toBe('IMG_20230512_142233');
	});
});
