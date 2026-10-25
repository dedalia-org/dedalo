/**
 * html_text — the ONE home of regex-shaped tag matching and of `&amp;` decoding
 * for server-side "rich text → plain text" work (CodeQL #7958
 * js/polynomial-redos; #7934/#7935/#7936 js/double-escaping, 2026-10-25).
 *
 * ENFORCED, not claimed: `html_text_tripwire` refuses, in src/, tools/<tool>/server
 * and publication/<pkg>/src, any unanchored regex that matches a tag up to its first `>`
 * (`<…[^>]*>`) and any CHAINED decode step of `&amp;`, outside this file — each
 * survivor carries a named reason in the gate. (`babel.ts stripTagsAllowing` is
 * the PHP `strip_tags` state machine: a different function, already linear.)
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

/** One tag found by {@link htmlTags}: where it starts, its text, the opener's match. */
export interface HtmlTagMatch {
	readonly index: number;
	readonly tag: string;
	readonly opener: RegExpExecArray;
}

/**
 * Every tag `opener…>` — the opener's match followed by everything up to the
 * FIRST `>` — left to right, non-overlapping: the matches of the global regex
 * `new RegExp(opener.source + '[^>]*>', 'g' + flags)`, in linear time.
 *
 * `opener` must be STICKY (`y`), begin with a literal `<`, and never match a
 * `>` (a name, a lookahead: `/<svg\b/iy`, `/<\/?([a-z]+)\b/iy`). Linear because
 * an opener is tried once per `<` (and cannot cross the next one when it has no
 * `<` in it), and once a `<` has no `>` after it no later `<` has one either.
 */
export function* htmlTags(text: string, opener: RegExp): Generator<HtmlTagMatch> {
	if (!opener.sticky) throw new TypeError(`htmlTags: opener /${opener.source}/ must be sticky (y)`);
	let open = text.indexOf('<');
	while (open !== -1) {
		opener.lastIndex = open;
		const match = opener.exec(text);
		if (match === null) {
			open = text.indexOf('<', open + 1);
			continue;
		}
		const close = text.indexOf('>', open + match[0].length);
		if (close === -1) return;
		yield { index: open, tag: text.slice(open, close + 1), opener: match };
		open = text.indexOf('<', close + 1);
	}
}

/** The first {@link htmlTags} match, or null. Same as `text.match(/<opener[^>]*>/)`. */
export function firstHtmlTag(text: string, opener: RegExp): HtmlTagMatch | null {
	for (const match of htmlTags(text, opener)) return match;
	return null;
}

/**
 * Replace the FIRST `opener…>` tag through `replace(tag)`. Same output as
 * `text.replace(/<opener[^>]*>/, replace)` (non-global), linear.
 */
export function replaceFirstHtmlTag(
	text: string,
	opener: RegExp,
	replace: (tag: string) => string,
): string {
	const found = firstHtmlTag(text, opener);
	if (found === null) return text;
	return (
		text.slice(0, found.index) + replace(found.tag) + text.slice(found.index + found.tag.length)
	);
}

const TAG_NAME = /^[a-z][a-z0-9]*$/;

/**
 * Remove every complete tag EXCEPT those named in `keep` (open or closing form,
 * case-insensitive). Same output as
 * `text.replace(/<(?!\/?(?:keep1|keep2)\b)[^>]*>/gi, '')`, linear.
 */
export function stripTagsExcept(text: string, keep: readonly string[]): string {
	for (const name of keep) {
		if (!TAG_NAME.test(name)) throw new TypeError(`stripTagsExcept: '${name}' is not a tag name`);
	}
	const opener = new RegExp(keep.length === 0 ? '<' : `<(?!\\/?(?:${keep.join('|')})\\b)`, 'iy');
	let out = '';
	let from = 0;
	for (const match of htmlTags(text, opener)) {
		out += text.slice(from, match.index);
		from = match.index + match.tag.length;
	}
	return out + text.slice(from);
}

/** What {@link decodeHtmlSpecialChars} decodes beyond the htmlspecialchars set. */
export interface EntityDecodeOptions {
	/** Decode `&nbsp;` to this string (absent ⇒ `&nbsp;` is left as is). */
	readonly nbsp?: string;
	/** Also decode `&apos;` (PHP decodes it only under ENT_XML1/XHTML/HTML5, not the HTML401 default). */
	readonly apos?: boolean;
	/** Also decode EVERY decimal/hex numeric reference (`&#233;`, `&#xE9;`), within Unicode range. */
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

/** The five code points PHP htmlspecialchars_decode (ENT_QUOTES) decodes from a NUMERIC reference. */
const SPECIAL_CODE_POINTS: ReadonlySet<number> = new Set([0x26, 0x3c, 0x3e, 0x22, 0x27]);

const MAX_CODE_POINT = 0x10ffff;

/**
 * Single-pass decode of the PHP `htmlspecialchars_decode` (ENT_QUOTES, HTML401)
 * set — `&amp; &lt; &gt; &quot;` by name, and ANY decimal/hex numeric reference
 * whose code point is one of `& < > " '` (`&#39;`, `&#039;`, `&#x27;`, `&#60;`,
 * `&#X3C;`…: PHP html.c traverse_for_entities, `!all` ⇒ only those five) — plus
 * whatever `options` adds. Anything unrecognised (an other numeric reference
 * without `numeric`, an out-of-range one) is left verbatim. `&amp;lt;` decodes
 * to `&lt;` — never to `<`.
 */
export function decodeHtmlSpecialChars(text: string, options: EntityDecodeOptions = {}): string {
	if (!text.includes('&')) return text;
	return text.replace(
		// Leading zeros are free (PHP strtol): `&#0000039;` is `'` too.
		/&(#[xX]0*[0-9a-fA-F]{1,6}|#0*[0-9]{1,7}|[A-Za-z]{2,4});/g,
		(match, body: string) => {
			if (body[0] === '#') {
				const hex = body[1] === 'x' || body[1] === 'X';
				const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
				if (code > MAX_CODE_POINT) return match;
				if (SPECIAL_CODE_POINTS.has(code) || options.numeric === true)
					return String.fromCodePoint(code);
				return match;
			}
			const name = options.ignoreCase === true ? body.toLowerCase() : body;
			if (name === 'nbsp') return options.nbsp ?? match;
			if (name === 'apos') return options.apos === true ? "'" : match;
			return Object.hasOwn(SPECIAL_CHARS, name) ? (SPECIAL_CHARS[name] as string) : match;
		},
	);
}
