/**
 * tool_pdf_extractor core (PHP tool_pdf_extractor::get_pdf_data → component_pdf
 * ::get_text_from_pdf). Reads the default-quality PDF and extracts text or html
 * for a page range. Read-only.
 *
 * `extractPdfFileText` is the shared temp-file core: the upload transcription
 * (ingest/pdf_transcription.ts) extracts through it too — one recipe, not two.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MediaTypeSpec } from '../../concepts/media.ts';
import { DedaloError } from '../../errors/dedalo_error.ts';
import { extractText, type PdfExtractOptions } from '../engine/pdf.ts';
import { buildMediaLocation, type MediaIdentity, type MediaPathOptions } from '../path.ts';

export interface PdfExtractCoreOptions {
	method: 'text' | 'html';
	pageIn?: number | null;
	pageOut?: number | null;
}

/** Extract text/html from the record's default-quality PDF. Throws when absent. */
export async function extractPdfCore(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	pathOpts: MediaPathOptions,
	options: PdfExtractCoreOptions,
): Promise<string> {
	const source = buildMediaLocation(
		spec,
		identity,
		spec.defaultQuality,
		'pdf',
		pathOpts,
	).absolutePath;
	if (!existsSync(source)) {
		throw new DedaloError('media.file_not_found', {
			message: 'pdf extractor: default-quality PDF not found',
			publicMessage: 'pdf extractor: default-quality PDF not found',
		});
	}
	return await extractPdfFileText(source, {
		method: options.method,
		pageIn: options.pageIn ?? null,
		pageOut: options.pageOut ?? null,
	});
}

/**
 * Extract text/html from ONE PDF file through a PRIVATE temp file — the one
 * temp-file recipe of every engine PDF extraction (tool_pdf_extractor above, and
 * the upload / regenerate transcription, media/ingest/pdf_transcription.ts).
 */
export async function extractPdfFileText(
	source: string,
	options: PdfExtractOptions,
): Promise<string> {
	// UPLOAD-TRAV-01 (2026-07-28 audit): the extractor used a PREDICTABLE shared
	// path (/tmp/dedalo_pdf_<pid>_<sectionId>.txt) — an attacker could pre-place a
	// symlink there to redirect the write, and the residue was world-readable.
	// Use a private per-run temp DIR (mkdtemp: random suffix, mode 0700, so it
	// cannot be pre-created or read by others) and remove it after. Never next to
	// the PDF in the media tree (PHP's residue).
	const tmpDir = mkdtempSync(join(tmpdir(), 'dedalo_pdf_'));
	const outFile = join(tmpDir, `out.${options.method === 'html' ? 'html' : 'txt'}`);
	try {
		return await extractText(source, outFile, options);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
}
