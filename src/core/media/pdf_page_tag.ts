/**
 * THE PDF PAGE TAG — the ONE builder of the Dédalo page tag paragraph a PDF text
 * carries per physical page: `<p>[page-n-N-K-data:[N]:data]</p>`, with
 * K = N - 1 + offset (the logical page number of physical page N, `offset` being
 * the logical page of physical page 1 — `lib_data.offset` of the component_pdf).
 *
 * Two readers, one grammar (T0-11): tool_pdf_extractor's html shaping
 * (tools/tool_pdf_extractor/server/pdf_payload.ts) and the upload / regenerate
 * transcription (media/ingest/pdf_transcription.ts). PHP's transcription wrote
 * the short `[page-n-N]` form while the extractor wrote this one; both parse
 * (tag_grammar.ts), but two builders would drift — so there is one.
 */

/** The page tag paragraph for physical page `page` (1-based) under the logical page `offset`. */
export function pdfPageTag(page: number, offset: number): string {
	const key = page - 1 + offset;
	return `<p>[page-n-${page}-${key}-data:[${page}]:data]</p>`;
}

/**
 * The stored logical page offset (`lib_data.offset`) as a number: absent, null,
 * '' or anything that is not an integer → 1 (no shift). A digit string counts
 * (the client's offset input stores what the form holds). Never throws — the
 * value is stored data read back, not a request option (the extractor's REQUEST
 * offset is validated loudly by its own door).
 */
export function storedPdfPageOffset(raw: unknown): number {
	const value =
		typeof raw === 'number'
			? raw
			: typeof raw === 'string' && /^-?\d+$/.test(raw.trim())
				? Number(raw.trim())
				: Number.NaN;
	return Number.isSafeInteger(value) ? value : 1;
}
