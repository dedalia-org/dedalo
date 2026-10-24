/**
 * truncate_html — faithful port of PHP component_string_common::truncate_html
 * (:537-686). Used by text_area list values (max_chars 130 by default; the
 * fallback list path uses 200).
 *
 * Behavior contract (must match PHP byte-for-byte on real data):
 * - if the PLAIN text (tags stripped) fits in `length`, return input unchanged;
 * - scan tag/text pairs; tags are appended uncounted; void elements ignored
 *   for the open-tag stack; comments passed through;
 * - text length counts HTML entities as ONE character;
 * - cut at the last word boundary (space) unless `exact`;
 * - append `ending` ('...') and close all still-open tags in stack order.
 *
 * DOS-01 (2026-07-28 audit): the tag patterns use `<[^>]*>`, NOT `<.+?>`/`<.*?>`.
 * The lazy dot forms backtrack catastrophically on a long run of unclosed `<`
 * (a stored CKEditor value is attacker-controllable) — a 200 KB value froze the
 * event loop ~19 s. `<[^>]*>` stops at the first `>` exactly like the lazy form
 * for well-formed markup and never backtracks — but it is still O(n²) on a run
 * of unclosed `<` (each attempt scans to the end; CodeQL #7958, 2026-10-25). So
 * the plain-length strips use the linear `stripTags` (html_text.ts) and the pair
 * scan below stays bounded by MAX_SCAN_CHARS.
 */

import { stripTags } from './html_text.ts';

const VOID_ELEMENT_PATTERN =
	/^<(\s*.+?\/\s*|\s*(area|base|basefont|br|col|embed|frame|hr|img|input|isindex|link|meta|param|source|track|wbr|command|keygen|menuitem)(\s.+?)?)>$/is;
const ENTITY_PATTERN = /&[0-9a-z]{2,8};|&#[0-9]{1,7};|&#x[0-9a-f]{1,6};/gi;

export function truncateHtml(
	length: number,
	text: string,
	considerHtml = true,
	ending = '...',
	exact = false,
): string {
	let truncate = '';
	let openTags: string[] = [];

	// DOS-01 (2026-07-28 audit): matching `<…>` against a long run of UNCLOSED
	// `<` is O(n²) at EVERY position regardless of the tag pattern (each `<` scans
	// forward for a `>` that never comes) — a 200 KB stored CKEditor value froze
	// the event loop ~19 s. This produces a LIST PREVIEW of at most `length` (≤200)
	// plain chars, so any input far larger carries no preview value: cap the raw
	// input the scan sees. 16 KiB holds thousands of plain chars — vastly more
	// than `length` — for any non-adversarial markup ratio, so a real preview is
	// unchanged while the worst case is bounded to a few hundred ms.
	const MAX_SCAN_CHARS = 16 * 1024;
	if (text.length > MAX_SCAN_CHARS) {
		// biome-ignore lint/style/noParameterAssign: a deliberate input clamp — every later read must see the bounded text, and a shadow variable invites using the unbounded one
		text = text.slice(0, MAX_SCAN_CHARS);
	}

	if (considerHtml) {
		// Whole text fits? (plain length, tags stripped)
		if (stripTags(text).length <= length) {
			return text;
		}
		// Split into (tag?, text) pairs — PHP preg_match_all('/(<.+?>)?([^<>]*)/s').
		const lines = [...text.matchAll(/(<[^>]*>)?([^<>]*)/g)];
		let totalLength = ending.length;

		for (const lineMatch of lines) {
			const tag = lineMatch[1];
			const content = lineMatch[2] ?? '';
			if (tag !== undefined && tag !== '') {
				if (/^<!--.*?-->$/s.test(tag)) {
					truncate += tag; // comments pass through
				} else if (VOID_ELEMENT_PATTERN.test(tag)) {
					truncate += tag; // void element: no stack effect
				} else {
					const closing = /^<\s*\/([^\s]+?)\s*>$/s.exec(tag);
					if (closing !== null) {
						const position = openTags.indexOf((closing[1] as string).toLowerCase());
						if (position !== -1) openTags.splice(position, 1);
						truncate += tag;
					} else {
						const opening = /^<\s*([^\s>!]+).*?>$/s.exec(tag);
						if (opening !== null) openTags.unshift((opening[1] as string).toLowerCase());
						truncate += tag;
					}
				}
			}
			// Plain-length of this text chunk; entities count as one char.
			const contentLength = content.replace(ENTITY_PATTERN, ' ').length;
			if (totalLength + contentLength > length) {
				let left = length - totalLength;
				let entitiesLength = 0;
				for (const entity of content.matchAll(ENTITY_PATTERN)) {
					if ((entity.index as number) + 1 - entitiesLength <= left) {
						left--;
						entitiesLength += entity[0].length;
					} else {
						break;
					}
				}
				truncate += content.slice(0, left + entitiesLength);
				break;
			}
			truncate += content;
			totalLength += contentLength;
			if (totalLength >= length) break;
		}
	} else {
		if (text.length <= length) return text;
		truncate = text.slice(0, length - ending.length);
	}

	// Word-boundary cut.
	if (!exact) {
		const plainTruncate = considerHtml ? stripTags(truncate) : truncate;
		const spacePosition = plainTruncate.lastIndexOf(' ');
		if (spacePosition !== -1) {
			if (considerHtml) {
				// Map the plain-text space position back to the HTML string.
				let charCount = 0;
				let htmlPosition = 0;
				let inTag = false;
				for (let index = 0; index < truncate.length; index++) {
					const char = truncate[index];
					if (char === '<') inTag = true;
					if (!inTag) {
						if (charCount === spacePosition) {
							htmlPosition = index;
							break;
						}
						charCount++;
					}
					if (char === '>') inTag = false;
				}
				if (htmlPosition > 0) {
					truncate = truncate.slice(0, htmlPosition);
					// Rebuild the open-tags stack from the shortened content.
					openTags = [];
					for (const match of truncate.matchAll(/<([^\s>/]+)(?:\s[^>]*)?>|<\/([^\s>]+)>/gs)) {
						const fullTag = match[0];
						const isVoid = VOID_ELEMENT_PATTERN.test(fullTag);
						if (isVoid || fullTag.startsWith('<!--')) continue;
						if (match[1] !== undefined) {
							openTags.unshift(match[1].toLowerCase());
						} else if (match[2] !== undefined) {
							const position = openTags.indexOf(match[2].toLowerCase());
							if (position !== -1) openTags.splice(position, 1);
						}
					}
				}
			} else {
				truncate = truncate.slice(0, spacePosition);
			}
		}
	}

	truncate += ending;
	if (considerHtml) {
		for (const tag of openTags) {
			truncate += `</${tag}>`;
		}
	}
	return truncate;
}
