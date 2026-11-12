/**
 * PDF ADAPTER — argv recipes ported from PHP component_pdf + media_docs config.
 *
 * pure `build*Argv` + `run*` over the spawn discipline. Text/HTML extraction
 * uses XPDF/Poppler `pdftotext`/`pdftohtml`; OCR uses `ocrmypdf`; page count via
 * `pdfinfo`. The PDF→jpg cover is rendered by `engine/ghostscript.ts` (the engine
 * spawns Ghostscript itself; ImageMagick only encodes the raster it produces) and
 * the page box that render is refused on is read here, by `readPdfPageSize`.
 *
 * PHP anchors: get_text_from_pdf (:743, command :831), OCR (:1003-1006),
 * transcription/ocr engine consts (media_docs.php :100/:109).
 */

import { dirname, isAbsolute } from 'node:path';
import { config } from '../../../config/config.ts';
import { DedaloError } from '../../errors/dedalo_error.ts';
import { requireTesseractModel } from './ocr_langs.ts';
import { assertSpawnOk, describeSpawnFailure, runBinary } from './spawn.ts';

export interface PdfExtractOptions {
	method: 'text' | 'html';
	pageIn?: number | null;
	pageOut?: number | null;
	/**
	 * Keep pdftotext's page separator (form feed, U+000C) between the cleaned
	 * pages. The cleanup strips every control character, U+000C included, so a
	 * caller that needs the PAGES (the transcription's page tags) asks for them
	 * here instead of re-reading the file with a second recipe.
	 */
	keepPageBreaks?: boolean;
}

/**
 * Text/HTML extraction argv (PHP :808-831):
 * `<engine> -enc UTF-8 [-f <in>] [-l <out>] [html: -i -p -noframes] <src> <out_file>`.
 * Text mode uses pdftotext; html mode uses pdftohtml.
 *
 * NO `-layout` for pdftohtml (CLIENT-2, 2026-10-11): it is a pdftotext option
 * pdftohtml does not have — poppler prints its usage and exits 1, so the PHP
 * recipe's flag made EVERY html extraction fail. Measured end to end by
 * test/unit/tool_pdf_extractor.test.ts (the gs-built html case).
 */
export function buildExtractArgv(
	source: string,
	outFile: string,
	options: PdfExtractOptions,
): string[] {
	const engine =
		options.method === 'html' ? config.media.binaries.pdftohtml : config.media.binaries.pdftotext;
	const argv: string[] = [engine, '-enc', 'UTF-8'];
	if (options.pageIn != null) argv.push('-f', String(options.pageIn));
	if (options.pageOut != null) argv.push('-l', String(options.pageOut));
	if (options.method === 'html') {
		argv.push('-i', '-p', '-noframes');
	}
	argv.push(source, outFile);
	return argv;
}

/**
 * OCR argv (PHP :1003-1006 recipe): PDF/A, lossless images, forced OCR.
 *
 * `dedaloLang` is a DÉDALO language (`lg-spa`), never a Tesseract code: the model
 * comes from the ONE map (ocr_langs.ts requireTesseractModel — the table the
 * installer's language-pack plan reads too), so the OCR can only ask for a model
 * the installer knows how to ship. A language with no model is a loud
 * `request.invalid_options`, never a guessed code that fails three binaries later.
 *
 * `source` and `target` are different files on every engine path: the OCR reads
 * the archival master and writes the DEFAULT tier (media/pdf_ocr.ts) — PHP ran
 * it in place over the original, which the engine never mutates.
 */
export function buildOcrArgv(source: string, target: string, dedaloLang: string): string[] {
	return [
		config.media.binaries.ocrmypdf,
		'--pdfa-image-compression',
		'lossless',
		'-l',
		requireTesseractModel(dedaloLang),
		'--force-ocr',
		source,
		target,
	];
}

/**
 * The directory put first on the ocrmypdf spawn's PATH (runBinary pathPrepend): the
 * CONFIGURED tesseract first. ocrmypdf finds tesseract on PATH, never through a
 * flag, so without this the OCR would run whatever `tesseract` the service PATH
 * happens to hold — not the binary `config.media.binaries.tesseract` names, whose
 * models the submit's language check and the system_info probe inspected. A bare
 * name (no directory) adds nothing: PATH already is how it resolves.
 */
export function ocrPathPrepend(): string | undefined {
	const tesseract = config.media.binaries.tesseract;
	return isAbsolute(tesseract) ? dirname(tesseract) : undefined;
}

/** pdfinfo argv (page count / metadata). */
export function buildPdfInfoArgv(source: string): string[] {
	return [config.media.binaries.pdfinfo, source];
}

/**
 * pdfinfo argv for ONE page's box: `-f N -l N` restricts the report to that page,
 * which is what makes `Page N size:` appear instead of the document-wide
 * `Page size:` (a PDF may declare a different MediaBox per page).
 */
export function buildPdfPageSizeArgv(source: string, page: number): string[] {
	return [config.media.binaries.pdfinfo, '-f', String(page), '-l', String(page), source];
}

/** A PDF page box, in PDF user-space points (1/72 inch) — never pixels. */
export interface PdfPageSize {
	readonly widthPoints: number;
	readonly heightPoints: number;
}

/**
 * The page box of ONE page, read with poppler.
 *
 * THIS IS THE MEASUREMENT THE PDF RASTERIZER REFUSES ON (engine/ghostscript.ts,
 * audit MEDIA-01): a 441-byte PDF may declare a 200000x200000-point page, and the
 * only cheap place to see that is a header read. poppler is used rather than
 * ImageMagick because `identify` on a PDF is not a header read at all — it invokes
 * the Ghostscript DELEGATE, which is the unbounded child this whole path exists to
 * stop (measured: refused outright under the shipped policy, which denies `gs`).
 *
 * IT THROWS RATHER THAN DEGRADING, unlike `getPageCount` next door, and the
 * difference is what the answer is FOR: an unknown page count costs a metadata
 * field, an unknown page box would mean rendering an untrusted document with no
 * idea how large it is. No geometry, no render.
 */
export async function readPdfPageSize(source: string, page = 1): Promise<PdfPageSize> {
	const result = await runBinary(buildPdfPageSizeArgv(source, page), { nice: false });
	if (!result.ok) {
		throw new DedaloError('media.operation_failed', {
			message: `pdf page size: pdfinfo failed for ${source} page ${String(page)}: ${describeSpawnFailure(result)}`,
			publicMessage: 'The page geometry of this PDF could not be read.',
		});
	}
	// `Page 1 size: 612 x 792 pts (letter)` — the trailing paper name is optional.
	const match = result.stdout.match(/^Page\s+\d+\s+size:\s*([0-9.]+)\s*x\s*([0-9.]+)\s*pts/m);
	if (match === null) {
		throw new DedaloError('media.operation_failed', {
			message: `pdf page size: pdfinfo reported no page box for ${source} page ${String(page)}: ${
				result.stdout.slice(0, 400) || '<empty stdout>'
			}`,
			publicMessage: 'The page geometry of this PDF could not be read.',
		});
	}
	const widthPoints = Number(match[1]);
	const heightPoints = Number(match[2]);
	if (!Number.isFinite(widthPoints) || !Number.isFinite(heightPoints)) {
		throw new DedaloError('media.operation_failed', {
			message: `pdf page size: unparseable page box '${String(match[0])}' for ${source} page ${String(page)}`,
			publicMessage: 'The page geometry of this PDF could not be read.',
		});
	}
	return { widthPoints, heightPoints };
}

// -------- runners --------

/**
 * Extract text (or html) from a PDF into `outFile`, then read and clean it.
 * Returns the cleaned UTF-8 string. Mirrors PHP's validate + iconv-IGNORE clean.
 */
export async function extractText(
	source: string,
	outFile: string,
	options: PdfExtractOptions,
): Promise<string> {
	const result = await runBinary(buildExtractArgv(source, outFile, options));
	// assertSpawnOk FIRST (T0-11): a killed / timed-out / non-zero pdftotext leaves a
	// TRUNCATED outFile, and since the ingest persists this text as the record's
	// transcription, "no stderr" must never read as success (the old
	// `/error/ && exitCode !== 0` let a SIGKILL with empty stderr through).
	assertSpawnOk(result, `pdf extraction of ${source}`);
	const raw = await Bun.file(outFile).text();
	return options.keepPageBreaks === true
		? raw.split(PAGE_BREAK).map(cleanUtf8).join(PAGE_BREAK)
		: cleanUtf8(raw);
}

/** pdftotext's page separator (it ends every page with one). */
export const PAGE_BREAK = '\f';

/** Page count via pdfinfo (parses the 'Pages:' line). Returns null when unknown. */
export async function getPageCount(source: string): Promise<number | null> {
	const result = await runBinary(buildPdfInfoArgv(source), { nice: false });
	const match = result.stdout.match(/^Pages:\s*(\d+)/m);
	return match ? Number(match[1]) : null;
}

/**
 * UTF-8 cleanup (PHP utf8_clean): drop invalid sequences and control chars.
 * TextDecoder with fatal:false already substitutes U+FFFD for invalid bytes;
 * we then strip control chars except tab/newline/carriage-return.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control chars IS the point — this strips them (PHP utf8_clean)
const CONTROL_AND_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFD]/g;

export function cleanUtf8(text: string): string {
	return text.replace(CONTROL_AND_INVALID, '');
}
