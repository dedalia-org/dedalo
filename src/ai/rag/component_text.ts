/**
 * RAG text extraction — reads one component's clean, flat text for one record +
 * lang, READ-ONLY over the matrix (spec §8; Brick 2). This is the seam the
 * indexer uses in place of rag2's `@dedalo/components` `resolveGetValue`.
 *
 * A string-family component stores `[{ id, value, lang }]`; we take the item
 * `value`s (lang-resolved via resolveComponentValue's fallback chain), strip
 * HTML to plain text (text_area holds rich text), and join. Empty → ''.
 */

import { readMatrixRecord } from '../../core/db/matrix.ts';
import { resolveComponentValue } from '../../core/resolve/component_data.ts';
import { decodeHtmlSpecialChars, replaceHtmlTags } from '../../core/resolve/html_text.ts';

/** A stored string item: `{ id, value, lang }`. */
interface StringItem {
	value?: unknown;
}

/** Strip HTML tags + decode the common entities, then collapse whitespace. */
export function htmlToPlainText(html: string): string {
	const blocks = html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n');
	// Tags → ' ' (linear twin of `/<[^>]+>/g`), then ONE entity pass: chained
	// replaces decoded `&amp;lt;` to `<` (CodeQL #7934), and an out-of-range
	// `&#…;` threw a RangeError out of fromCodePoint — it now stays verbatim.
	return decodeHtmlSpecialChars(replaceHtmlTags(blocks, ' ', true), {
		nbsp: ' ',
		numeric: true,
		ignoreCase: true,
	})
		.replace(/[ \t]+/g, ' ')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/** Pull the plain text out of resolved string items. */
export function itemsToText(items: unknown[]): string {
	const parts: string[] = [];
	for (const item of items) {
		if (item === null || typeof item !== 'object') continue;
		const value = (item as StringItem).value;
		if (typeof value === 'string' && value !== '') parts.push(htmlToPlainText(value));
	}
	return parts.join('\n').trim();
}

/**
 * Read one component's clean text for a record + lang. Reads the matrix record
 * from the given table (identifier-gated by readMatrixRecord), resolves the
 * component value with the language-fallback chain, and flattens to plain text.
 * Returns '' on any miss (absent record/column/value) — the indexer treats ''
 * as "prune this component".
 */
export async function readComponentText(input: {
	matrixTable: string;
	componentTipo: string;
	model: string;
	sectionTipo: string;
	sectionId: number;
	lang: string;
}): Promise<string> {
	const record = await readMatrixRecord(input.matrixTable, input.sectionTipo, input.sectionId);
	if (record === null) return '';
	const { value, fallbackValue } = await resolveComponentValue(
		record,
		input.componentTipo,
		input.model,
		input.lang,
	);
	const items = value ?? fallbackValue;
	if (items === null || items.length === 0) return '';
	return itemsToText(items);
}
