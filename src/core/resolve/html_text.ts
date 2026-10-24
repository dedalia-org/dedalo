/**
 * html_text — the ONE tag stripper and the ONE entity decoder for server-side
 * "rich text → plain text" work (CodeQL #7958 js/polynomial-redos; #7934/#7935/
 * #7936 js/double-escaping, 2026-10-25).
 *
 * WHY A LOOP, NOT `/<[^>]*>/g`. That regex is the right MEANING (a tag ends at
 * the first `>`), but a regex engine retries it at every `<`: on a run of
 * UNCLOSED `<` each attempt scans to the end of the input before failing, so
 * `'<'.repeat(n)` costs O(n²) — measured 0.7 s at 64 KB on Bun/JSC, per call, on
 * the single event loop. `stripTags` returns byte-identical output to
 * `text.replace(/<[^>]*>/g, '')` and is linear: once a `<` has no `>` after it,
 * no later `<` can have one either, so the scan stops instead of retrying.
 * (`/<[^<>]*>/g` is also linear but is NOT the same function — `a<b<c>` keeps
 * `a<b` — so it would change every caller's output on malformed markup.)
 *
 * WHY ONE PASS. Decoding entity by entity (`&amp;` → `&`, then `&lt;` → `<`)
 * decodes TWICE: the literal text `&amp;lt;` (a curator who typed `&lt;`)
 * becomes `<` instead of `&lt;`. PHP `htmlspecialchars_decode` is a single
 * `strtr`, which this mirrors: every entity is matched once, against the
 * original text, and its replacement is never re-scanned.
 *
 * Leaf module: imports nothing, so any layer (core, diffusion, ai) may use it.
 */

/**
 * Replace every complete HTML tag — `<` up to the FIRST following `>` — with
 * `replacement`. Same output as `text.replace(/<[^>]*>/g, replacement)` (or, with
 * `requireInner`, as `/<[^>]+>/g`: an empty `<>` is left alone), in linear time.
 */
export function replaceHtmlTags(text: string, replacement: string, requireInner = false): string {
	let open = text.indexOf('<');
	if (open === -1) return text;
	let out = '';
	let from = 0;
	while (open !== -1) {
		const close = text.indexOf('>', open + 1);
		// No `>` after this `<` ⇒ none after any later `<` either: nothing more matches.
		if (close === -1) break;
		if (requireInner && close === open + 1) {
			// `<>` does not match `<[^>]+>`; the regex resumes at the `>` itself.
			open = text.indexOf('<', close);
			continue;
		}
		out += text.slice(from, open) + replacement;
		from = close + 1;
		open = text.indexOf('<', from);
	}
	return out + text.slice(from);
}

/** Remove every complete HTML tag. Same output as `text.replace(/<[^>]*>/g, '')`, linear. */
export function stripTags(text: string): string {
	return replaceHtmlTags(text, '');
}

/** What {@link decodeHtmlSpecialChars} decodes beyond the htmlspecialchars set. */
export interface EntityDecodeOptions {
	/** Decode `&nbsp;` to this string (absent ⇒ `&nbsp;` is left as is). */
	readonly nbsp?: string;
	/** Also decode decimal/hex numeric references (`&#233;`, `&#xE9;`), within Unicode range. */
	readonly numeric?: boolean;
	/** Match the NAMED entities case-insensitively (`&AMP;`, `&Lt;`). */
	readonly ignoreCase?: boolean;
}

/** PHP htmlspecialchars_decode (ENT_QUOTES) table — named part. */
const SPECIAL_CHARS: Readonly<Record<string, string>> = Object.freeze({
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
});

const MAX_CODE_POINT = 0x10ffff;

/**
 * Single-pass decode of `&amp; &lt; &gt; &quot; &#39; &#039;` (PHP
 * `htmlspecialchars_decode`, ENT_QUOTES), plus whatever `options` adds. Anything
 * unrecognised (including an out-of-range numeric reference) is left verbatim.
 * `&amp;lt;` decodes to `&lt;` — never to `<`.
 */
export function decodeHtmlSpecialChars(text: string, options: EntityDecodeOptions = {}): string {
	if (!text.includes('&')) return text;
	return text.replace(
		/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z]{2,4});/g,
		(match, body: string) => {
			if (body[0] === '#') {
				// ENT_QUOTES: the apostrophe is decoded in its two PHP spellings only.
				if (body === '#39' || body === '#039') return "'";
				if (options.numeric !== true) return match;
				const hex = body[1] === 'x' || body[1] === 'X';
				const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
				return code <= MAX_CODE_POINT ? String.fromCodePoint(code) : match;
			}
			const name = options.ignoreCase === true ? body.toLowerCase() : body;
			if (name === 'nbsp') return options.nbsp ?? match;
			return Object.hasOwn(SPECIAL_CHARS, name) ? (SPECIAL_CHARS[name] as string) : match;
		},
	);
}
