/**
 * A PDF RECORD'S DERIVATIVES ARE BUILT FROM ITS PDF RENDITION, NEVER FROM ANOTHER
 * ORIGINAL — owner decision 2026-11-11 (MEDIA-STALE-MASTER, D1 = b: the v6
 * coexistence law stays — `original/<id>.pdf` and `original/<id>.doc|odt|…` live
 * side by side, frozen component_pdf::rename_old_files :663 / v6 :570).
 *
 * RED ON HEAD 85299f1ad5 (before this change), by construction:
 *   1  a non-PDF original uploaded beside a PDF rendition answered nothing: the
 *      web copy/covers keep depicting the PDF and the operator was not told so;
 *   2  a non-PDF original with NO PDF beside it was COPIED as `web/<id>.pdf`
 *      (resolveMaster walked the upload allowlist; copyToQuality is a byte copy)
 *      — doc bytes served under a .pdf name;
 *   3  regeneratePdf / resolveMasterSource resolved `original/<id>.doc` as the
 *      derivative source.
 * Case 4 (a PDF uploaded after an odt is the new rendition) and the image guard
 * are behaviour this change must keep.
 *
 * SITUATION: the generic `test` TLD — section test3, component_pdf test85 — one
 * scratch record per case (swept), a scratch media root (scratchMediaRoot).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../src/config/config.ts';
import { mediaTypeOf } from '../../src/core/concepts/media.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { runBinary } from '../../src/core/media/engine/spawn.ts';
import { stagingDir } from '../../src/core/media/ingest/add_file.ts';
import { processUploadedFile } from '../../src/core/media/ingest/process_uploaded_file.ts';
import {
	buildMediaLocation,
	type MediaIdentity,
	type MediaPathOptions,
} from '../../src/core/media/path.ts';
import { regeneratePdf, resolveMasterSource } from '../../src/core/media/processing.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { mustGet } from '../helpers/assert.ts';
import { scratchMediaRoot } from '../helpers/media_scratch_root.ts';

const SECTION = 'test3';
const PDF = 'test85';
const USER_ID = -1;
const KEY_DIR = 'kd_pdf_rendition';
const spec = mustGet(mediaTypeOf('component_pdf'), 'component_pdf spec');
const imageSpec = mustGet(mediaTypeOf('component_image'), 'component_image spec');
const ROOT = scratchMediaRoot('pdf_rendition_source');
const pathOpts: MediaPathOptions = { initialMediaPath: '', maxItemsFolder: 1000, mediaRoot: ROOT };

const which = (bin: string): boolean => existsSync(bin) || Bun.which(bin) !== null;
const HAVE_GS = which(config.media.binaries.ghostscript);

const records: number[] = [];
let table = '';

async function newRecord(): Promise<number> {
	const id = await createSectionRecord(SECTION, USER_ID);
	records.push(id);
	return id;
}

const identityOf = (sectionId: number): MediaIdentity => ({
	componentTipo: PDF,
	sectionTipo: SECTION,
	sectionId,
	lang: null,
});

const fileOf = (sectionId: number, quality: string, extension: string): string =>
	buildMediaLocation(spec, identityOf(sectionId), quality, extension, pathOpts).absolutePath;

/** A one-page text PDF (Ghostscript pdfwrite). */
async function textPdf(path: string, word: string): Promise<void> {
	mkdirSync(join(path, '..'), { recursive: true });
	const result = await runBinary(
		[
			config.media.binaries.ghostscript,
			'-q',
			'-dNOPAUSE',
			'-dBATCH',
			'-sDEVICE=pdfwrite',
			'-o',
			path,
			'-c',
			`<< /PageSize [400 200] >> setpagedevice /Helvetica findfont 20 scalefont setfont 20 100 moveto (${word}) show showpage`,
		],
		{ nice: false },
	);
	expect(result.ok, result.stderr).toBe(true);
}

/** Bytes that are NOT a PDF — an authored document's stand-in (zip magic, as odt). */
const ODT_BYTES = Buffer.from('PK\u0003\u0004 not a pdf: authored document stand-in\n');

function stage(tmpName: string, bytes: Buffer): void {
	const dir = stagingDir(USER_ID, KEY_DIR, ROOT);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, tmpName), bytes);
}

async function ingest(sectionId: number, tmpName: string, extension: string) {
	return processUploadedFile({
		spec,
		identity: identityOf(sectionId),
		pathOpts,
		userId: USER_ID,
		keyDir: KEY_DIR,
		tmpName,
		extension,
	});
}

const isPdf = (path: string): boolean => readFileSync(path).subarray(0, 5).toString() === '%PDF-';

beforeAll(async () => {
	await assertTestDatabase('media_pdf_rendition_source_native');
	table = mustGet(await getMatrixTableFromTipo(SECTION), 'test3 table');
}, 60_000);

afterAll(async () => {
	for (const id of records) {
		await sql.unsafe(`DELETE FROM "${table}" WHERE section_tipo = $1 AND section_id = $2`, [
			SECTION,
			id,
		]);
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[SECTION, id],
		);
		await sql.unsafe(
			`DELETE FROM matrix_activity WHERE data->>'section_tipo' = $1 AND data->>'section_id' = $2`,
			[SECTION, String(id)],
		);
	}
	rmSync(ROOT, { recursive: true, force: true });
}, 60_000);

describe('component_pdf: the PDF rendition is the only derivative source (D1 = b)', () => {
	test.skipIf(!HAVE_GS)(
		'1 — an odt uploaded beside a PDF keeps both; the PDF still drives web; the operator is told',
		async () => {
			const id = await newRecord();
			const rendition = fileOf(id, spec.originalQuality, 'pdf');
			await textPdf(rendition, 'RENDITION');
			const renditionBytes = readFileSync(rendition);
			stage('upload_1.odt', ODT_BYTES);

			const result = await ingest(id, 'upload_1.odt', 'odt');

			// Coexistence (v6 law): neither original moved, neither mutated.
			expect(readFileSync(rendition).equals(renditionBytes)).toBe(true);
			expect(readFileSync(fileOf(id, spec.originalQuality, 'odt')).equals(ODT_BYTES)).toBe(true);
			// The web copy is the rendition, never the odt.
			const web = fileOf(id, spec.defaultQuality, 'pdf');
			if (existsSync(web)) expect(isPdf(web)).toBe(true);
			// SAID OUT LOUD: which PDF the view still comes from.
			const notice = result.notices.find((n) => n.includes('PDF rendition'));
			expect(notice, JSON.stringify(result.notices)).toBeDefined();
			expect(notice).toContain(`${PDF}_${SECTION}_${id}.pdf`);
		},
		60_000,
	);

	test('2 — an odt with no PDF beside it is never copied as the web PDF; the operator is told', async () => {
		const id = await newRecord();
		stage('upload_2.odt', ODT_BYTES);

		const result = await ingest(id, 'upload_2.odt', 'odt');

		expect(existsSync(fileOf(id, spec.originalQuality, 'odt'))).toBe(true);
		expect(existsSync(fileOf(id, spec.defaultQuality, 'pdf'))).toBe(false);
		const notice = result.notices.find((n) => n.includes('no PDF rendition'));
		expect(notice, JSON.stringify(result.notices)).toBeDefined();
	}, 60_000);

	test('3 — regeneratePdf / resolveMasterSource never resolve a non-PDF original', async () => {
		const id = await newRecord();
		const doc = fileOf(id, spec.originalQuality, 'doc');
		mkdirSync(join(doc, '..'), { recursive: true });
		writeFileSync(doc, ODT_BYTES);

		expect(resolveMasterSource(spec, identityOf(id), pathOpts)).toBeNull();
		expect(resolveMasterSource(spec, identityOf(id), pathOpts, 'doc')).toBeNull();
		const web = fileOf(id, spec.defaultQuality, 'pdf');
		const outcome = await regeneratePdf(spec, identityOf(id), pathOpts);
		expect(outcome.created).not.toContain(web);
		expect(existsSync(web)).toBe(false);

		// Positive control: the SAME door, once a PDF rendition sits beside the doc,
		// builds the web copy from it (byte copy — thumb/cover of these stand-in bytes
		// fail non-fatally) — so the absence above is the rule, not a dead door.
		const pdfBytes = Buffer.from('%PDF-1.4\n% rendition stand-in\n');
		writeFileSync(fileOf(id, spec.originalQuality, 'pdf'), pdfBytes);
		expect(resolveMasterSource(spec, identityOf(id), pathOpts)).toBe(
			fileOf(id, spec.originalQuality, 'pdf'),
		);
		const rebuilt = await regeneratePdf(spec, identityOf(id), pathOpts);
		expect(rebuilt.created).toContain(web);
		expect(readFileSync(web).equals(pdfBytes)).toBe(true);
	});

	test.skipIf(!HAVE_GS)(
		'4 — a PDF uploaded after an odt is the new rendition; the odt stays',
		async () => {
			const id = await newRecord();
			const odt = fileOf(id, spec.originalQuality, 'odt');
			mkdirSync(join(odt, '..'), { recursive: true });
			writeFileSync(odt, ODT_BYTES);
			const staged = join(stagingDir(USER_ID, KEY_DIR, ROOT), 'upload_4.pdf');
			await textPdf(staged, 'NEWRENDITION');
			const stagedBytes = readFileSync(staged);

			const result = await ingest(id, 'upload_4.pdf', 'pdf');

			expect(readFileSync(odt).equals(ODT_BYTES)).toBe(true);
			expect(readFileSync(fileOf(id, spec.defaultQuality, 'pdf')).equals(stagedBytes)).toBe(true);
			expect(result.notices.some((n) => n.includes('PDF rendition'))).toBe(false);
		},
		60_000,
	);

	test('image guard — a raw of any allowed extension stays a derivative source', () => {
		const identity: MediaIdentity = {
			componentTipo: 'test99',
			sectionTipo: SECTION,
			sectionId: 1,
			lang: null,
		};
		const tif = buildMediaLocation(
			imageSpec,
			identity,
			imageSpec.originalQuality,
			'tif',
			pathOpts,
		).absolutePath;
		mkdirSync(join(tif, '..'), { recursive: true });
		writeFileSync(tif, 'raw');
		expect(resolveMasterSource(imageSpec, identity, pathOpts)).toBe(tif);
	});
});
