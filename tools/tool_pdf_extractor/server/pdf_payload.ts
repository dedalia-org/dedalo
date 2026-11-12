/**
 * THE PAYLOAD DOOR of tool_pdf_extractor (CLIENT-2, 2026-10-11): what
 * `get_pdf_data` answers, decided on the SERVER — `{value, render_class}`.
 *
 *  - text → the extractor's characters VERBATIM, render_class 'text'. The
 *    client escapes it (render_value), so `IMP CAES<A>R` — an epigraphic
 *    edition — arrives as the PDF holds it, never parsed as a tag.
 *  - html → the pdftohtml document SHAPED (doctype gone, <head> gone with its
 *    content, <html>/<body> unwrapped, each numeric `<a name="N">` page anchor
 *    replaced by a Dédalo page tag paragraph `<p>[page-n-N-K-data:[N]:data]</p>`
 *    with K = N - 1 + offset), and then passed through THE rich-text sanitizer
 *    (security/html_sanitize.ts) LAST, so nothing the shaping emits can bypass
 *    it. render_class 'html'.
 *
 * The client used to receive a bare string, re-parse it with DOMParser, shape
 * it there and assign the result to innerHTML whatever the method — so a text
 * extraction was rendered as markup (and its `<…>` runs were lost), and an html
 * extraction made the parse → serialise → re-parse round trip that mutation
 * XSS rides. The client now only renders by the class this door names.
 *
 * THE REQUEST HALF lives here too: `pdfPayloadRequest` validates the options
 * the door reads (method allowlist, offset) into ONE object, and the handler
 * hands that object back to `answerPdfPayload` — so the offset a caller sent
 * cannot be validated and then dropped on the way to the page keys.
 *
 * Each call builds its own rewriter (no module singleton — module_state_tripwire).
 * Gates: test/unit/tool_pdf_extractor.test.ts, pdf_extract_symmetry_tripwire.
 */

import { DedaloError } from '../../../src/core/errors/index.ts';
// The page tag grammar has ONE builder, shared with the upload transcription.
import { pdfPageTag } from '../../../src/core/media/pdf_page_tag.ts';
import { sanitizeRichText } from '../../../src/core/security/html_sanitize.ts';

export interface PdfPayload {
	value: string;
	render_class: 'text' | 'html';
}

/** A validated `get_pdf_data` request: what the payload is shaped by. */
export interface PdfPayloadRequest {
	method: 'text' | 'html';
	/** The logical page of physical page 1 (page tags carry key = page - 1 + offset). */
	offset: number;
}

/**
 * The logical page offset. Absent → 1; otherwise an integer (a number, or a
 * string of digits as a form input sends it) — anything else is refused, never
 * coerced.
 */
function offsetOption(raw: unknown): number {
	if (raw === undefined || raw === null || raw === '') return 1;
	const value =
		typeof raw === 'number'
			? raw
			: typeof raw === 'string' && /^-?\d+$/.test(raw)
				? Number(raw)
				: Number.NaN;
	if (!Number.isSafeInteger(value)) {
		throw new DedaloError('request.invalid_options', {
			publicMessage: 'offset must be an integer',
		});
	}
	return value;
}

/** Validate the options the payload door reads. Throws `request.invalid_options`. */
export function pdfPayloadRequest(options: Readonly<Record<string, unknown>>): PdfPayloadRequest {
	if (options.method !== 'text' && options.method !== 'html') {
		throw new DedaloError('request.invalid_options', {
			publicMessage: "method must be 'text' or 'html'",
		});
	}
	return { method: options.method, offset: offsetOption(options.offset) };
}

/** Shape the extractor's raw output for a validated request. */
export function answerPdfPayload(raw: string, request: PdfPayloadRequest): PdfPayload {
	return shapePdfPayload(raw, request.method, request.offset);
}

/** Shape the extractor's raw output into the wire payload. */
export function shapePdfPayload(raw: string, method: 'text' | 'html', offset: number): PdfPayload {
	if (method === 'text') {
		return { value: raw, render_class: 'text' };
	}
	// Sanitize LAST: the shaped markup is what the client will render. The order
	// is load-bearing — removing <head>/a doctype and unwrapping <html>/<body>
	// JOINS the text on either side (`<<head></head>img onerror=…>` → a live
	// `<img onerror>`), and only a sanitizer pass over the SHAPED bytes judges
	// the tag that join creates. Gate: tool_pdf_extractor.test.ts, "a shaper
	// removal never splices…" (its positive control is the swapped order).
	return { value: sanitizeRichText(shapePdfHtml(raw, offset)), render_class: 'html' };
}

/**
 * The html SHAPING alone — UNSANITIZED, never a payload. Exported for the gate's
 * positive control only (the swapped order `shapePdfHtml(sanitizeRichText(x))`
 * must be convicted, or the order gate proves nothing); every answer goes
 * through {@link shapePdfPayload}.
 */
export function shapePdfHtml(raw: string, offset: number): string {
	return new HTMLRewriter()
		.onDocument({
			doctype(doctype) {
				doctype.remove();
			},
		})
		.on('head', {
			element(element) {
				element.remove();
			},
		})
		.on('html, body', {
			element(element) {
				element.removeAndKeepContent();
			},
		})
		.on('a[name]', {
			element(element) {
				const name = element.getAttribute('name') ?? '';
				// pdftohtml marks each page with a numeric anchor; any other named
				// anchor is ordinary content and stays (the sanitizer judges it).
				if (/^\d+$/.test(name)) {
					element.replace(pdfPageTag(Number(name), offset), { html: true });
				}
			},
		})
		.transform(raw);
}
