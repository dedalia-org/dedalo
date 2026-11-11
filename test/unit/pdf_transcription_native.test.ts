/**
 * T0-11 — A PDF UPLOAD FILLS ITS TRANSCRIPTION; OCR IS HONOURED; THE REGENERATE
 * DOORS FILL ONLY AN EMPTY ONE (owner decisions D1 = c, D2 = b).
 *
 * RED ON HEAD f597625f78 (before this change), by construction:
 *   1/2 processUploadedFile's pdf branch ran regeneratePdf only — test97 stayed
 *       empty after any upload (no transcription code existed);
 *   3   `processOptions` did not exist and buildOcrArgv had no caller — the OCR
 *       job, `startOcr`, never existed;
 *   4   tool_upload never read `ctx.options.process_options` (silently dropped:
 *       no refusal, no job) and `readProcessOptions` did not exist;
 *   5   no transcription message channel (the failure case had nothing to say);
 *   6   no `ingest_notices`, no `transcriptions_*` counters in update_cache.
 *
 * SITUATION: the generic `test` TLD — section test3, component_pdf test85 whose
 * `relations` name the translatable component_text_area test97. Records are
 * created here and swept (records, TM rows, activity rows, dd800 runs). PDFs are
 * built at runtime with Ghostscript. Ingest-level cases use a scratch media root;
 * the handler / update_cache cases go through the doors that resolve the
 * CONFIGURED root — the suite's own marked test media root — and remove the
 * files they made.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { config } from '../../src/config/config.ts';
import { mediaTypeOf } from '../../src/core/concepts/media.ts';
import { readMatrixRecord } from '../../src/core/db/matrix.ts';
import { getPoolStats, sql, withTransaction } from '../../src/core/db/postgres.ts';
import { DedaloError } from '../../src/core/errors/index.ts';
import { writeAtomically } from '../../src/core/media/atomic.ts';
import { runBinary } from '../../src/core/media/engine/spawn.ts';
import { fileFingerprint, stillSameFile } from '../../src/core/media/file_fingerprint.ts';
import { stagingDir } from '../../src/core/media/ingest/add_file.ts';
import {
	buildTranscriptionHtml,
	sliceVisibleLength,
	transcribePdf,
	transcribeStoredPdf,
} from '../../src/core/media/ingest/pdf_transcription.ts';
import {
	type IngestProcessOptions,
	ocrRefusal,
	processUploadedFile,
} from '../../src/core/media/ingest/process_uploaded_file.ts';
import { mediaJobs } from '../../src/core/media/jobs.ts';
import {
	buildMediaLocation,
	type MediaIdentity,
	type MediaPathOptions,
} from '../../src/core/media/path.ts';
import {
	assertCurrentBeforeRename,
	assertOcrCurrent,
	OcrDiscarded,
	submitPdfOcr,
} from '../../src/core/media/pdf_ocr.ts';
import { readStoredMediaItems } from '../../src/core/media/tool_support.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { readComponentItems } from '../../src/core/resolve/component_data.ts';
import { currentDataLang, runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import type { ToolActionContext, ToolResponse } from '../../src/core/tools/module.ts';
import { toolTimeMachineBulkRevert } from '../../tools/tool_time_machine/server/bulk_revert.ts';
import {
	ocrStartFailureMessage,
	readProcessOptions,
	startOcrReporting,
} from '../../tools/tool_upload/server/index.ts';
import { mustGet } from '../helpers/assert.ts';
import { scratchMediaRoot } from '../helpers/media_scratch_root.ts';
import { refusalOf } from '../helpers/refusal.ts';

const SECTION = 'test3';
const PDF = 'test85';
const TEXT_AREA = 'test97';
const USER_ID = -1;
const KEY_DIR = 'kd_pdf_transcription';
const spec = mustGet(mediaTypeOf('component_pdf'), 'component_pdf spec');
const ROOT = scratchMediaRoot('pdf_transcription');
const scratchPathOpts: MediaPathOptions = {
	initialMediaPath: '',
	maxItemsFolder: 1000,
	mediaRoot: ROOT,
};

const which = (bin: string): boolean => existsSync(bin) || Bun.which(bin) !== null;
const HAVE_PDF_TOOLS =
	which(config.media.binaries.ghostscript) && which(config.media.binaries.pdftotext);
const HAVE_OCR = HAVE_PDF_TOOLS && which(config.media.binaries.ocrmypdf);

const records: number[] = [];
const runs: number[] = [];
let table = '';
let lang = '';

async function newRecord(): Promise<number> {
	const id = await createSectionRecord(SECTION, USER_ID);
	records.push(id);
	return id;
}

/** A text PDF, one page per entry, built with Ghostscript (pdfwrite keeps the text). */
async function textPdf(path: string, pages: string[]): Promise<void> {
	mkdirSync(join(path, '..'), { recursive: true });
	const body = pages.map((page) => `20 100 moveto (${page}) show showpage`).join(' ');
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
			`<< /PageSize [400 200] >> setpagedevice /Helvetica findfont 20 scalefont setfont ${body}`,
		],
		{ nice: false },
	);
	expect(result.ok, result.stderr).toBe(true);
}

/** An IMAGE-ONLY PDF (pdfimage24 rasterizes the page — no text layer). */
async function imagePdf(path: string, word: string): Promise<void> {
	mkdirSync(join(path, '..'), { recursive: true });
	const ps = `${path}.ps`;
	writeFileSync(
		ps,
		`%!PS\n/Helvetica findfont 48 scalefont setfont\n72 600 moveto (${word}) show\nshowpage\n`,
	);
	const result = await runBinary(
		[config.media.binaries.ghostscript, '-q', '-sDEVICE=pdfimage24', '-r200', '-o', path, ps],
		{ nice: false },
	);
	rmSync(ps, { force: true });
	expect(result.ok, result.stderr).toBe(true);
}

/** Stage a file for the ingest (scratch root, or the configured root when null). */
function stagedPath(tmpName: string, mediaRoot?: string): string {
	const dir = stagingDir(USER_ID, KEY_DIR, mediaRoot);
	mkdirSync(dir, { recursive: true });
	return join(dir, tmpName);
}

const identityOf = (sectionId: number): MediaIdentity => ({
	componentTipo: PDF,
	sectionTipo: SECTION,
	sectionId,
	lang: null,
});

async function ingest(
	sectionId: number,
	tmpName: string,
	processOptions?: IngestProcessOptions,
	extension = 'pdf',
) {
	return processUploadedFile({
		spec,
		identity: identityOf(sectionId),
		pathOpts: scratchPathOpts,
		userId: USER_ID,
		keyDir: KEY_DIR,
		tmpName,
		extension,
		...(processOptions === undefined ? {} : { processOptions }),
	});
}

/** The stored test97 items of a record. */
async function textItems(sectionId: number): Promise<Record<string, unknown>[]> {
	const record = await readMatrixRecord(table, SECTION, sectionId);
	return (readComponentItems(mustGet(record, 'record'), TEXT_AREA, 'component_text_area') ??
		[]) as Record<string, unknown>[];
}

/** The value of the current data-lang slice ('' when empty). */
async function sliceValue(sectionId: number): Promise<string> {
	return (await textItems(sectionId))
		.filter((item) => item.lang === lang)
		.map((item) => String(item.value ?? ''))
		.join('');
}

async function setText(sectionId: number, value: string | null): Promise<void> {
	const saved = await saveComponentData({
		componentTipo: TEXT_AREA,
		sectionTipo: SECTION,
		sectionId,
		lang,
		changedData: [{ action: 'set_data', id: null, value: value === null ? [] : [{ value, lang }] }],
		userId: USER_ID,
	});
	expect(saved.ok).toBe(true);
}

async function tmRows(sectionId: number): Promise<{ user_id: string; data: string }[]> {
	return (await sql.unsafe(
		`SELECT user_id::text AS user_id, data::text AS data FROM matrix_time_machine
		  WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3 ORDER BY id`,
		[SECTION, sectionId, TEXT_AREA],
	)) as { user_id: string; data: string }[];
}

/** Wait until the job's worker is RUNNING (the OCR child is spawning). */
async function awaitRunning(jobId: string): Promise<void> {
	for (let i = 0; i < 400; i++) {
		if (mediaJobs.status(jobId)?.status === 'running') return;
		await Bun.sleep(25);
	}
	throw new Error(`job ${jobId} never started`);
}

const defaultTierOf = (sectionId: number): string =>
	buildMediaLocation(spec, identityOf(sectionId), spec.defaultQuality, 'pdf', scratchPathOpts)
		.absolutePath;

async function awaitJob(jobId: string): Promise<void> {
	for (let i = 0; i < 1200; i++) {
		const status = mediaJobs.status(jobId)?.status;
		if (status !== 'queued' && status !== 'running') return;
		await Bun.sleep(250);
	}
	throw new Error(`job ${jobId} never ended`);
}

const sha256 = (path: string): string =>
	createHash('sha256').update(readFileSync(path)).digest('hex');

async function context(options: Record<string, unknown>): Promise<ToolActionContext> {
	return {
		principal: await resolvePrincipal(USER_ID),
		userId: USER_ID,
		options,
		background: false,
	};
}

/** tool_upload's process_uploaded_file through its real handler (configured media root). */
async function uploadViaTool(
	sectionId: number,
	tmpName: string,
	processOptions?: unknown,
	extra: Record<string, unknown> = {},
): Promise<ToolResponse> {
	const loaded = await getLoadedTool('tool_upload');
	const handler = mustGet(loaded?.module.apiActions.process_uploaded_file, 'upload').handler;
	return handler(
		await context({
			tipo: PDF,
			section_tipo: SECTION,
			section_id: sectionId,
			file_data: { key_dir: KEY_DIR, tmp_name: tmpName, extension: 'pdf', name: tmpName },
			...(processOptions === undefined ? {} : { process_options: processOptions }),
			...extra,
		}),
	);
}

/** Remove every media file of a record from the configured (suite) root. */
function sweepConfiguredMedia(sectionId: number): void {
	const root = config.media.rootPath;
	if (root === null) return;
	const walk = (dir: string): void => {
		if (!existsSync(dir)) return;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.name.startsWith(`${PDF}_${SECTION}_${sectionId}.`))
				rmSync(path, { force: true });
		}
	};
	walk(join(root, 'pdf'));
}

beforeAll(async () => {
	await assertTestDatabase('pdf_transcription_native');
	table = mustGet(await getMatrixTableFromTipo(SECTION), 'test3 table');
	lang = currentDataLang();
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
		sweepConfiguredMedia(id);
	}
	const bulkTable = await getMatrixTableFromTipo('dd800');
	for (const id of runs) {
		await sql.unsafe(
			`DELETE FROM "${bulkTable}" WHERE section_tipo = 'dd800' AND section_id = $1`,
			[id],
		);
		await sql.unsafe(
			`DELETE FROM matrix_time_machine WHERE section_tipo = 'dd800' AND section_id = $1`,
			[id],
		);
		await sql.unsafe('DELETE FROM matrix_time_machine WHERE bulk_process_id = $1', [id]);
	}
	rmSync(stagingDir(USER_ID, KEY_DIR), { recursive: true, force: true });
	rmSync(ROOT, { recursive: true, force: true });
}, 120_000);

describe('the transcription shape (pure)', () => {
	test('pages split on form feed, text ESCAPED, line breaks are paragraphs, offset honoured', () => {
		const html = mustGet(
			buildTranscriptionHtml('IMP CAES<A>R\nline two\n\fsecond & last\n\f', 5),
			'html',
		);
		expect(html).toBe(
			'<p>[page-n-1-5-data:[1]:data]</p><p>IMP CAES&lt;A&gt;R</p><p>line two</p><p></p>' +
				'<p>[page-n-2-6-data:[2]:data]</p><p>second &amp; last</p><p></p>',
		);
	});
	test('no text layer (≤ 2 chars) → null', () => {
		expect(buildTranscriptionHtml('\f\f', 1)).toBeNull();
		expect(buildTranscriptionHtml(' a \f', 1)).toBeNull();
	});
	test('the slice length counts visible text of ONE lang', () => {
		const items = [
			{ lang: 'lg-spa', value: '<p>[page-n-1]</p><p>abc</p>' },
			{ lang: 'lg-eng', value: '<p>zzzzzzzz</p>' },
			{ lang: 'lg-cat', value: '<p> </p>' },
		];
		expect(sliceVisibleLength(items, 'lg-spa')).toBe('[page-n-1]abc'.length);
		expect(sliceVisibleLength(items, 'lg-cat')).toBe(0);
		expect(sliceVisibleLength(items, 'lg-fra')).toBe(0);
	});
});

describe('gate 4: tool_upload process_options', () => {
	/** A pdf target on a host with these Tesseract models installed. */
	const pdfOn = (...models: string[]) => ({
		model: 'component_pdf',
		masterTier: true,
		installedModels: async () => new Set(models),
	});
	const ALL = pdfOn('eng', 'spa', 'cat', 'osd');

	test('validated: unknown key, non-boolean ocr, bad / unmapped ocr_lang WITH ocr on → request.invalid_options', async () => {
		for (const bad of [
			{ ocr: true, extra: 1 },
			{ ocr: 'yes' },
			{ ocr: true, ocr_lang: 'spa' },
			{ ocr: true, ocr_lang: 'lg-xxx' },
			'ocr',
			[true],
		]) {
			expect((await refusalOf(readProcessOptions(bad, ALL))).code).toBe('request.invalid_options');
		}
		expect(await readProcessOptions(undefined, ALL)).toEqual({});
		expect(await readProcessOptions({ ocr: false, ocr_lang: null }, ALL)).toEqual({ ocr: false });
		// The client sends the selected lang with the checkbox OFF: never refused then.
		expect(await readProcessOptions({ ocr: false, ocr_lang: 'lg-xxx' }, ALL)).toEqual({
			ocr: false,
		});
		expect(await readProcessOptions({ ocr: true, ocr_lang: 'lg-eng' }, ALL)).toEqual({
			ocr: true,
			ocrLang: 'lg-eng',
		});
	});

	test('ocr ON: a MAPPED language whose model is NOT INSTALLED here is refused before the move', async () => {
		const refusal = await refusalOf(
			readProcessOptions({ ocr: true, ocr_lang: 'lg-spa' }, pdfOn('eng', 'osd')),
		);
		expect(refusal.code).toBe('request.invalid_options');
		expect(refusal.message).toContain("'spa'");
		expect(refusal.message).toContain('not installed');
		// No tesseract at all (empty listing): every language is refused, never a doomed job.
		expect(
			(await refusalOf(readProcessOptions({ ocr: true, ocr_lang: 'lg-eng' }, pdfOn()))).code,
		).toBe('request.invalid_options');
		expect(
			await readProcessOptions({ ocr: true, ocr_lang: 'lg-eng' }, pdfOn('eng', 'osd')),
		).toEqual({ ocr: true, ocrLang: 'lg-eng' });
	});

	test('ocr ON for a component that is not a PDF is refused; OFF it is ignored', async () => {
		const image = {
			model: 'component_image',
			masterTier: true,
			installedModels: async () => new Set(['eng']),
		};
		const refusal = await refusalOf(readProcessOptions({ ocr: true, ocr_lang: 'lg-eng' }, image));
		expect(refusal.code).toBe('request.invalid_options');
		expect(refusal.message).toContain('PDF components only');
		expect(await readProcessOptions({ ocr: false, ocr_lang: 'lg-eng' }, image)).toEqual({
			ocr: false,
		});
	});

	test('ocr ON without a lang: the data lang is RESOLVED and VALIDATED before the move', async () => {
		const langs = (dataLang: string) => ({ applicationLang: 'lg-eng', dataLang });
		expect(
			await runWithRequestLangs(langs('lg-spa'), () =>
				readProcessOptions({ ocr: true, ocr_lang: null }, ALL),
			),
		).toEqual({ ocr: true, ocrLang: 'lg-spa' });
		expect(
			await runWithRequestLangs(langs('lg-cat'), () => readProcessOptions({ ocr: true }, ALL)),
		).toEqual({ ocr: true, ocrLang: 'lg-cat' });
		// A data lang Tesseract has no model for: refused HERE, not stranded after the move.
		const refusal = await refusalOf(
			runWithRequestLangs(langs('lg-xyz'), () => readProcessOptions({ ocr: true }, ALL)),
		);
		expect(refusal.code).toBe('request.invalid_options');
		// With OCR off the data lang is never asked.
		expect(
			await runWithRequestLangs(langs('lg-xyz'), () => readProcessOptions({ ocr: false }, ALL)),
		).toEqual({ ocr: false });
	});

	test('an OCR submit that throws AFTER the move is a derivative error, never an error response', () => {
		expect(startOcrReporting(null)).toEqual({ jobId: null, failureCode: null });
		expect(startOcrReporting(() => 'pdf_ocr_1')).toEqual({ jobId: 'pdf_ocr_1', failureCode: null });
		const failed = startOcrReporting(() => {
			throw new DedaloError('media.action_failed', {
				message: 'no PDF master on /secret/abs/path',
			});
		});
		expect(failed).toEqual({ jobId: null, failureCode: 'media.action_failed' });
		// the wire sentence names the CODE, never the raw (path-bearing) text
		const sentence = ocrStartFailureMessage('media.action_failed');
		expect(sentence).toBe('the OCR job could not be started (media.action_failed)');
		expect(sentence).not.toContain('/secret');
	});

	test.if(HAVE_PDF_TOOLS)(
		'the handler refuses a bad ocr_lang before moving anything',
		async () => {
			const id = await newRecord();
			const staged = stagedPath('refused.pdf');
			await textPdf(staged, ['NOT MOVED']);
			const refusal = await refusalOf(
				uploadViaTool(id, 'refused.pdf', { ocr: true, ocr_lang: 'lg-xxx' }),
			);
			expect(refusal.code).toBe('request.invalid_options');
			expect(existsSync(staged)).toBe(true);
			rmSync(staged, { force: true });
		},
		60_000,
	);

	test.if(HAVE_OCR)(
		'the handler FORWARDS ocr: the response carries the pdf_ocr job',
		async () => {
			const id = await newRecord();
			await textPdf(stagedPath('forwarded.pdf'), ['FORWARDED']);
			const response = await uploadViaTool(id, 'forwarded.pdf', { ocr: true, ocr_lang: 'lg-eng' });
			expect(response.ok).toBe(true);
			const jobId = (response as unknown as { job_id: string | null }).job_id;
			expect(typeof jobId).toBe('string');
			expect(mediaJobs.status(mustGet(jobId, 'job id'))?.kind).toBe('pdf_ocr');
			await awaitJob(mustGet(jobId, 'job id'));
		},
		300_000,
	);
});

describe.if(HAVE_PDF_TOOLS)('gates 1/2/5: the upload transcribes', () => {
	test('1+2 a text PDF fills test97[data lang] with page tags + ESCAPED text; TM actor = uploader', async () => {
		const id = await newRecord();
		await textPdf(stagedPath('text.pdf', ROOT), ['IMP CAES<A>R', 'SECOND PAGE']);
		const result = await ingest(id, 'text.pdf');
		expect(result.derivativeErrors.filter((m) => m.includes('transcription'))).toEqual([]);
		expect(result.notices).toEqual([]);
		const value = await sliceValue(id);
		expect(value).toContain('[page-n-1-1-data:[1]:data]');
		expect(value).toContain('[page-n-2-2-data:[2]:data]');
		expect(value).toContain('IMP CAES&lt;A&gt;R');
		expect(value).toContain('SECOND PAGE');
		const rows = await tmRows(id);
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.every((row) => row.user_id === String(USER_ID))).toBe(true);
	}, 60_000);

	test('5 a corrupt PDF: the ingest stands, one message, test97 untouched', async () => {
		const id = await newRecord();
		await setText(id, 'UNTOUCHED CURATED TEXT');
		writeFileSync(stagedPath('broken.pdf', ROOT), '%PDF-1.4\nthis is not a pdf body\n');
		const result = await ingest(id, 'broken.pdf');
		expect(result.originalFileName).toContain(`${PDF}_${SECTION}_${id}`);
		expect(result.derivativeErrors.some((m) => m.includes(`transcription '${TEXT_AREA}'`))).toBe(
			true,
		);
		expect(await sliceValue(id)).toContain('UNTOUCHED CURATED TEXT');
	}, 60_000);

	test('5b an image-only PDF without OCR: "no text layer", nothing written', async () => {
		const id = await newRecord();
		await imagePdf(stagedPath('scan.pdf', ROOT), 'SCANNED');
		const result = await ingest(id, 'scan.pdf');
		expect(result.derivativeErrors.some((m) => m.includes('no text layer'))).toBe(true);
		expect(await sliceValue(id)).toBe('');
	}, 60_000);
});

describe.if(HAVE_OCR)('gate 3: OCR as a media job', () => {
	test('image-only + ocr lg-eng → the job writes the text; the archival original is unchanged', async () => {
		const id = await newRecord();
		await imagePdf(stagedPath('ocr.pdf', ROOT), 'HERITAGE LEDGER');
		const result = await ingest(id, 'ocr.pdf', { ocr: true, ocrLang: 'lg-eng' });
		// With OCR asked, an image-only master's "no text layer" is a NOTICE, not a failure.
		expect(result.derivativeErrors.filter((m) => m.includes('transcription'))).toEqual([]);
		expect(result.notices.some((m) => m.includes('no text layer yet'))).toBe(true);
		const master = buildMediaLocation(
			spec,
			identityOf(id),
			spec.originalQuality,
			'pdf',
			scratchPathOpts,
		).absolutePath;
		const before = sha256(master);
		const jobId = mustGet(result.startOcr, 'startOcr')();
		await awaitJob(jobId);
		const job = mediaJobs.status(jobId);
		expect(job?.status, JSON.stringify(job?.errors)).toBe('done');
		expect(await sliceValue(id)).toContain('HERITAGE');
		expect(sha256(master)).toBe(before);
	}, 600_000);
});

describe.if(HAVE_PDF_TOOLS)('gate 6: D1 overwrite + notice, D2 fill-if-empty + bulk revert', () => {
	test('re-upload overwrites with a notice; update_cache keeps curated, fills empty; revert clears the fill', async () => {
		// A: curated text, then an upload over it (D1 c).
		const a = await newRecord();
		await setText(a, 'PREVIOUS CURATED TEXT');
		await textPdf(stagedPath('a.pdf'), ['FRESH PAGE TEXT']);
		const response = await uploadViaTool(a, 'a.pdf');
		expect(response.ok).toBe(true);
		const notices = (response.data as { ingest_notices: string[] }).ingest_notices;
		expect(notices.some((n) => /replaced 21 chars of existing transcription/.test(n))).toBe(true);
		expect((response.data as { derivative_errors: string[] }).derivative_errors).toEqual([]);
		expect(await sliceValue(a)).toContain('FRESH PAGE TEXT');
		expect((await tmRows(a)).some((row) => row.data.includes('PREVIOUS CURATED TEXT'))).toBe(true);
		// The curator edits again: a sweep must keep this.
		await setText(a, 'CURATED AGAIN');

		// B: uploaded, then its transcription emptied.
		const b = await newRecord();
		await textPdf(stagedPath('b.pdf'), ['B PAGE TEXT']);
		expect((await uploadViaTool(b, 'b.pdf')).ok).toBe(true);
		await setText(b, null);
		expect(await sliceValue(b)).toBe('');

		const loaded = await getLoadedTool('tool_update_cache');
		const sweep = mustGet(loaded?.module.apiActions.update_cache, 'update_cache').handler;
		const swept = await sweep(
			await context({
				section_tipo: SECTION,
				components_selection: [{ tipo: PDF }],
				sqo: {
					section_tipo: [SECTION],
					filter_by_locators: [
						{ section_tipo: SECTION, section_id: String(a) },
						{ section_tipo: SECTION, section_id: String(b) },
					],
				},
			}),
		);
		const data = swept.data as {
			bulk_process_id: number;
			transcriptions_filled: number;
			transcriptions_kept: number;
			summary: string;
			errors: string[];
		};
		runs.push(data.bulk_process_id);
		expect(data.transcriptions_filled, data.summary).toBe(1);
		expect(data.transcriptions_kept, data.summary).toBe(1);
		expect(data.summary).toContain('kept');
		expect(await sliceValue(a)).toContain('CURATED AGAIN');
		expect(await sliceValue(b)).toContain('B PAGE TEXT');

		const reverted = await toolTimeMachineBulkRevert(
			await context({ bulk_process_id: data.bulk_process_id }),
		);
		expect(reverted.ok).toBe(true);
		runs.push((reverted.data as { bulk_process_id: number }).bulk_process_id);
		expect(await sliceValue(b)).toBe('');
		expect(await sliceValue(a)).toContain('CURATED AGAIN');
	}, 300_000);
});

describe.if(HAVE_PDF_TOOLS)(
	'gate 7 (review #2/#3): the upload ALWAYS transcribes, from the master it ingested',
	() => {
		test('ocr ticked + a PDF that has text: written NOW (the OCR replaces it later), announced as provisional', async () => {
			const id = await newRecord();
			await setText(id, 'OLDER DOCUMENT TEXT');
			await textPdf(stagedPath('withtext.pdf', ROOT), ['TEXT LAYER NOW']);
			const result = await ingest(id, 'withtext.pdf', { ocr: true, ocrLang: 'lg-eng' });
			expect(result.derivativeErrors.filter((m) => m.includes('transcription'))).toEqual([]);
			expect(await sliceValue(id)).toContain('TEXT LAYER NOW');
			expect(await sliceValue(id)).not.toContain('OLDER DOCUMENT TEXT');
			expect(result.notices.some((m) => m.includes('the OCR job replaces it'))).toBe(true);
			expect(result.notices.some((m) => /replaced \d+ chars/.test(m))).toBe(true);
			expect(result.startOcr).not.toBeNull(); // handed back, deliberately not started here
		}, 60_000);

		test('the source is the INGESTED master, never a stale default tier', async () => {
			const id = await newRecord();
			await textPdf(stagedPath('first.pdf', ROOT), ['FIRST DOCUMENT']);
			await ingest(id, 'first.pdf');
			// A web copy that stayed behind from the PREVIOUS document (a failed rebuild).
			const web = defaultTierOf(id);
			await textPdf(web, ['STALE WEB COPY']);
			await textPdf(stagedPath('second.pdf', ROOT), ['SECOND DOCUMENT']);
			// The web-copy rebuild FAILS (its folder is read-only), so the stale copy stays.
			const webDir = join(web, '..');
			chmodSync(webDir, 0o555);
			let result: Awaited<ReturnType<typeof ingest>>;
			try {
				result = await ingest(id, 'second.pdf');
			} finally {
				chmodSync(webDir, 0o755);
			}
			expect(result.derivativeErrors.length).toBeGreaterThan(0); // the rebuild failure, reported
			expect(readFileSync(web).length).toBeGreaterThan(0);
			expect(result.derivativeErrors.filter((m) => m.includes(`transcription '`))).toEqual([]);
			expect(await sliceValue(id)).toContain('SECOND DOCUMENT');
			expect(await sliceValue(id)).not.toContain('STALE WEB COPY');
		}, 60_000);
	},
);

describe.if(HAVE_OCR)('gate 8 (review #1): a stale OCR job writes nothing', () => {
	test('re-upload DURING the OCR → the live job is STOPPED and discards: the new text and web copy stand', async () => {
		const id = await newRecord();
		await imagePdf(stagedPath('old_scan.pdf', ROOT), 'OBSOLETE SCAN');
		const first = await ingest(id, 'old_scan.pdf', { ocr: true, ocrLang: 'lg-eng' });
		const jobId = mustGet(first.startOcr, 'startOcr')();
		await awaitRunning(jobId);
		// The curator replaces the document while ocrmypdf runs.
		await textPdf(stagedPath('new_doc.pdf', ROOT), ['REPLACEMENT DOCUMENT']);
		const second = await ingest(id, 'new_doc.pdf');
		expect(second.derivativeErrors.filter((m) => m.includes('transcription'))).toEqual([]);
		const webAfterReupload = sha256(defaultTierOf(id));
		await awaitJob(jobId);
		const job = mediaJobs.status(jobId);
		// The new master's ingest stops the OCR of the old one (stopLiveOcr); the
		// fingerprint path (a stop that never came) is gate 10's.
		expect(job?.status, JSON.stringify(job?.errors)).toBe('stopped');
		const data = job?.data as { superseded: string | null; ocr_file: string | null };
		expect(data.superseded).toContain('discarded');
		expect(data.ocr_file).toBeNull();
		expect(await sliceValue(id)).toContain('REPLACEMENT DOCUMENT');
		expect(await sliceValue(id)).not.toContain('OBSOLETE');
		expect(sha256(defaultTierOf(id))).toBe(webAfterReupload);
	}, 600_000);

	test('a STOPPED job writes nothing: no text, the web copy untouched, no temp left', async () => {
		const id = await newRecord();
		await imagePdf(stagedPath('stop_scan.pdf', ROOT), 'NEVER WRITTEN');
		const result = await ingest(id, 'stop_scan.pdf', { ocr: true, ocrLang: 'lg-eng' });
		const web = defaultTierOf(id);
		const webBefore = sha256(web);
		const jobId = mustGet(result.startOcr, 'startOcr')();
		await awaitRunning(jobId);
		expect(mediaJobs.stop(jobId)).toBe(true);
		await awaitJob(jobId);
		expect(mediaJobs.status(jobId)?.status).toBe('stopped');
		expect(await sliceValue(id)).toBe('');
		expect(sha256(web)).toBe(webBefore);
		const dir = join(web, '..');
		const stem = `${PDF}_${SECTION}_${id}`;
		// No temp sibling of the web copy survived (atomic.ts tempSibling: `<stem>.tmp.<pid>.<uuid>.pdf`).
		expect(readdirSync(dir).filter((name) => name.startsWith(`${stem}.tmp.`))).toEqual([]);
	}, 600_000);

	test('a second OCR submit for the same target STOPS the live one', async () => {
		const id = await newRecord();
		await imagePdf(stagedPath('twice.pdf', ROOT), 'ONLY ONCE');
		const result = await ingest(id, 'twice.pdf', { ocr: true, ocrLang: 'lg-eng' });
		const start = mustGet(result.startOcr, 'startOcr');
		const firstId = start();
		await awaitRunning(firstId);
		const secondId = start();
		await awaitJob(firstId);
		await awaitJob(secondId);
		expect(mediaJobs.status(firstId)?.status).toBe('stopped');
		const second = mediaJobs.status(secondId);
		expect(second?.status, JSON.stringify(second?.errors)).toBe('done');
		expect(await sliceValue(id)).toContain('ONLY');
	}, 600_000);
});

describe.if(HAVE_PDF_TOOLS)(
	'gate 9 (review #6): a sweep never waits unbounded on a held record',
	() => {
		test('fill_empty on a row another session holds → `locked`, nothing written', async () => {
			const id = await newRecord();
			await textPdf(stagedPath('held.pdf'), ['HELD RECORD TEXT']);
			expect((await uploadViaTool(id, 'held.pdf')).ok).toBe(true);
			await setText(id, null);
			const items = await readStoredMediaItems(SECTION, id, PDF);
			expect(items.length).toBeGreaterThan(0);
			let release = (): void => {};
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			let signalLocked = (): void => {};
			const isLocked = new Promise<void>((resolve) => {
				signalLocked = resolve;
			});
			const holder = withTransaction(async () => {
				await sql.unsafe(
					`SELECT section_id FROM "${table}" WHERE section_tipo = $1 AND section_id = $2 FOR UPDATE`,
					[SECTION, id],
				);
				signalLocked();
				await held;
			});
			await isLocked;
			// Sample the pools WHILE the sweep waits: it must wait on the REQUEST pool
			// (the per-record unit), never hold one of the two maintenance slots.
			const samples: { main: number; maintenance: number }[] = [];
			const sampler = setInterval(() => {
				const stats = getPoolStats();
				samples.push({ main: stats.inUse, maintenance: stats.maintenance.inUse });
			}, 100);
			let outcome: Awaited<ReturnType<typeof transcribeStoredPdf>>;
			try {
				outcome = await transcribeStoredPdf({
					componentTipo: PDF,
					sectionTipo: SECTION,
					sectionId: id,
					items,
					pathOpts: { initialMediaPath: '', maxItemsFolder: 1000 },
					userId: USER_ID,
				});
			} finally {
				clearInterval(sampler);
				release();
				await holder;
			}
			expect(outcome.status, outcome.messages.join('; ')).toBe('locked');
			expect(samples.length).toBeGreaterThan(5);
			expect(samples.every((sample) => sample.maintenance === 0)).toBe(true);
			// The holder + the waiting sweep, both on the request pool.
			expect(samples.every((sample) => sample.main >= 2)).toBe(true);
			expect(outcome.messages.join(' ')).toContain('locked by another session');
			expect(await sliceValue(id)).toBe('');
		}, 120_000);
	},
);

describe('gate 10 (review 2 B): the OCR currency check reads abort + fingerprint AFTER its await', () => {
	const file = join(ROOT, 'currency', 'master.pdf');
	const fresh = (signal: AbortSignal = new AbortController().signal) => {
		mkdirSync(join(file, '..'), { recursive: true });
		writeFileSync(file, 'v1');
		return { master: file, fingerprint: mustGet(fileFingerprint(file), 'fingerprint'), signal };
	};
	const failureOf = (run: Promise<void>): Promise<unknown> =>
		run.then(
			() => null,
			(caught: unknown) => caught,
		);

	test('a stop landing DURING the record read is still seen', async () => {
		const controller = new AbortController();
		const error = await failureOf(
			assertOcrCurrent(fresh(controller.signal), async () => {
				controller.abort();
				return true;
			}),
		);
		expect(error).toBeInstanceOf(OcrDiscarded);
		expect((error as Error).message).toContain('stopped');
	});

	test('a re-upload landing DURING the record read is still seen', async () => {
		const current = fresh();
		const error = await failureOf(
			assertOcrCurrent(current, async () => {
				writeFileSync(`${file}.new`, 'version two, longer');
				renameSync(`${file}.new`, file);
				return true;
			}),
		);
		expect(error).toBeInstanceOf(OcrDiscarded);
		expect((error as Error).message).toContain('superseded');
	});

	test('control: nothing changed → current; record gone → superseded', async () => {
		const current = fresh();
		expect(await failureOf(assertOcrCurrent(current, async () => true))).toBeNull();
		const gone = await failureOf(assertOcrCurrent(current, async () => false));
		expect((gone as Error).message).toContain('record is gone');
	});
});

describe.if(HAVE_PDF_TOOLS)(
	'gate 11 (review 2 D): an upload transcription is bound to ITS master',
	() => {
		test('stillSameFile: a rename-into-place makes it false', () => {
			const file = join(ROOT, 'fingerprint', 'm.pdf');
			mkdirSync(join(file, '..'), { recursive: true });
			writeFileSync(file, 'one');
			const check = stillSameFile(file);
			expect(check()).toBe(true);
			writeFileSync(`${file}.n`, 'two');
			renameSync(`${file}.n`, file);
			expect(check()).toBe(false);
			rmSync(file, { force: true });
			expect(stillSameFile(file)()).toBe(false);
		});

		test('a transcription whose master was replaced meanwhile is `superseded`: nothing written', async () => {
			const id = await newRecord();
			await setText(id, 'NEWER UPLOAD TEXT');
			const source = join(ROOT, 'older_master.pdf');
			await textPdf(source, ['OLDER MASTER TEXT']);
			const outcome = await transcribePdf({
				spec,
				identity: identityOf(id),
				pathOpts: scratchPathOpts,
				userId: USER_ID,
				mode: 'overwrite',
				source,
				stillCurrent: () => false,
			});
			expect(outcome.status).toBe('superseded');
			expect(outcome.messages.join(' ')).toContain('superseded');
			expect(await sliceValue(id)).toContain('NEWER UPLOAD TEXT');
		}, 60_000);
	},
);

describe.if(HAVE_OCR)('gate 12 (review 2 A): the OCR reads the master JUST INGESTED', () => {
	test('a .doc over an old .pdf: no OCR of the old PDF, a notice, and the live OCR stopped', async () => {
		const id = await newRecord();
		await imagePdf(stagedPath('old_original.pdf', ROOT), 'OLD ORIGINAL');
		const first = await ingest(id, 'old_original.pdf', { ocr: true, ocrLang: 'lg-eng' });
		const jobId = mustGet(first.startOcr, 'startOcr')();
		await awaitRunning(jobId);
		writeFileSync(stagedPath('replacement.doc', ROOT), 'a word-processor file, not a PDF');
		const second = await ingest(id, 'replacement.doc', { ocr: true, ocrLang: 'lg-eng' }, 'doc');
		expect(second.startOcr).toBeNull();
		expect(second.notices.some((m) => m.includes('OCR needs a PDF master'))).toBe(true);
		// The old .pdf original is still on disk — the very file a re-resolve would OCR.
		const oldPdf = buildMediaLocation(
			spec,
			identityOf(id),
			spec.originalQuality,
			'pdf',
			scratchPathOpts,
		).absolutePath;
		expect(existsSync(oldPdf)).toBe(true);
		await awaitJob(jobId);
		expect(mediaJobs.status(jobId)?.status).toBe('stopped');
		expect(await sliceValue(id)).not.toContain('OLD');
	}, 600_000);
});

describe('gate 13 (review 3): OCR binds to the ingest, refuses what it cannot do, renames with no await', () => {
	test('3 ocr ON into a DERIVATIVE tier is refused (never silently ignored)', async () => {
		const derivative = {
			model: 'component_pdf',
			masterTier: false,
			installedModels: async () => new Set(['eng', 'osd']),
		};
		const refusal = await refusalOf(
			readProcessOptions({ ocr: true, ocr_lang: 'lg-eng' }, derivative),
		);
		expect(refusal.code).toBe('request.invalid_options');
		expect(refusal.message).toContain('master tier');
		expect(await readProcessOptions({ ocr: false }, derivative)).toEqual({ ocr: false });
	});

	test.if(HAVE_PDF_TOOLS)(
		'3 the handler refuses ocr into the web tier BEFORE moving anything',
		async () => {
			const id = await newRecord();
			const staged = stagedPath('to_web.pdf');
			await textPdf(staged, ['NOT MOVED EITHER']);
			const refusal = await refusalOf(
				uploadViaTool(
					id,
					'to_web.pdf',
					{ ocr: true, ocr_lang: 'lg-eng' },
					{
						quality: spec.defaultQuality,
					},
				),
			);
			expect(refusal.code).toBe('request.invalid_options');
			expect(existsSync(staged)).toBe(true);
			rmSync(staged, { force: true });
		},
		60_000,
	);

	test('2 no OCR is handed back when the upload text was SUPERSEDED, nor for a non-PDF master', () => {
		const outcome = (status: string) =>
			({ status, targetTipo: TEXT_AREA, messages: [], notices: [] }) as never;
		expect(ocrRefusal('/m/x.pdf', outcome('written'))).toBeNull();
		expect(ocrRefusal('/m/x.pdf', outcome('no_text'))).toBeNull();
		expect(ocrRefusal('/m/x.pdf', outcome('superseded'))).toContain('newer upload');
		expect(ocrRefusal('/m/x.doc', outcome('written'))).toContain('OCR needs a PDF master');
	});

	test.if(HAVE_OCR)(
		'2 a job handed a fingerprint that is not the file on disk OCRs nothing',
		async () => {
			const id = await newRecord();
			await imagePdf(stagedPath('fp_scan.pdf', ROOT), 'NEVER OCRED');
			const ingested = await ingest(id, 'fp_scan.pdf');
			const master = buildMediaLocation(
				spec,
				identityOf(id),
				spec.originalQuality,
				'pdf',
				scratchPathOpts,
			).absolutePath;
			const webBefore = sha256(defaultTierOf(id));
			const jobId = submitPdfOcr({
				spec,
				identity: identityOf(id),
				pathOpts: scratchPathOpts,
				userId: USER_ID,
				ocrLang: 'lg-eng',
				master,
				masterFingerprint: '1:2:3', // what an OLDER ingest of this path saw
			});
			await awaitJob(jobId);
			const job = mediaJobs.status(jobId);
			expect(job?.status, JSON.stringify(job?.errors)).toBe('done');
			expect((job?.data as { superseded: string }).superseded).toContain('superseded');
			expect(sha256(defaultTierOf(id))).toBe(webBefore);
			expect(await sliceValue(id)).toBe('');
			void ingested;
		},
		120_000,
	);

	test.if(HAVE_OCR)(
		'1 a live OCR is stopped BEFORE the move: even an upload whose move then fails stops it',
		async () => {
			const id = await newRecord();
			await imagePdf(stagedPath('pre_move.pdf', ROOT), 'PRE MOVE');
			const first = await ingest(id, 'pre_move.pdf', { ocr: true, ocrLang: 'lg-eng' });
			const jobId = mustGet(first.startOcr, 'startOcr')();
			await awaitRunning(jobId);
			// No staged file: addFile refuses — after the stop, which is the point.
			const failed = await ingest(id, 'missing_staged.pdf').then(
				() => null,
				(caught: unknown) => caught,
			);
			expect(failed).not.toBeNull();
			await awaitJob(jobId);
			expect(mediaJobs.status(jobId)?.status).toBe('stopped');
		},
		600_000,
	);

	test('4 writeAtomically: a throwing beforeRename discards the temp, runs AFTER the producer', async () => {
		const target = join(ROOT, 'before_rename', 'out.pdf');
		const order: string[] = [];
		const error = await writeAtomically(
			target,
			async (temp) => {
				writeFileSync(temp, 'produced');
				order.push('produce');
			},
			() => {
				order.push('beforeRename');
				throw new Error('vetoed');
			},
		).then(
			() => null,
			(caught: unknown) => caught,
		);
		expect((error as Error).message).toBe('vetoed');
		expect(order).toEqual(['produce', 'beforeRename']);
		expect(existsSync(target)).toBe(false);
		expect(readdirSync(join(target, '..'))).toHaveLength(0);
		await writeAtomically(
			target,
			async (temp) => writeFileSync(temp, 'kept'),
			() => {},
		);
		expect(readFileSync(target, 'utf8')).toBe('kept');
	});

	test('4 the final OCR check: a stop after the text committed SAYS the text was saved', () => {
		const file = join(ROOT, 'final_check', 'm.pdf');
		mkdirSync(join(file, '..'), { recursive: true });
		writeFileSync(file, 'v1');
		const controller = new AbortController();
		const run = {
			master: file,
			fingerprint: mustGet(fileFingerprint(file), 'fp'),
			signal: controller.signal,
		};
		const written = {
			status: 'written',
			targetTipo: TEXT_AREA,
			messages: [],
			notices: [],
		} as never;
		expect(() => assertCurrentBeforeRename(run, written)).not.toThrow();
		controller.abort();
		let saved: unknown = null;
		try {
			assertCurrentBeforeRename(run, written);
		} catch (caught) {
			saved = caught;
		}
		expect(saved).toBeInstanceOf(OcrDiscarded);
		expect((saved as OcrDiscarded).textSaved).toBe(written);
		expect((saved as Error).message).toContain('SAVED');
		let discarded: unknown = null;
		try {
			assertCurrentBeforeRename(run, undefined);
		} catch (caught) {
			discarded = caught;
		}
		expect((discarded as OcrDiscarded).textSaved).toBeNull();
		expect((discarded as Error).message).toContain('discarded');
	});
});
