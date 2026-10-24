/**
 * THE rich-text sanitizer for stored HTML (XSS-01 defense in depth, 2026-07-28;
 * rebuilt on a spec tokenizer for CLIENT-2, 2026-10-11).
 *
 * component_text_area is a CKEditor field, so legitimate FORMATTING HTML (bold,
 * paragraphs, links, images, tables) must survive — an escape-everything pass
 * would destroy every curator's content. This is therefore a targeted DENYLIST
 * that removes only the executable/dangerous constructs and leaves formatting
 * intact. Users: the text_area SAVE gate (`sanitizeRichTextChanges`, from
 * src/core/section/record/save_component.ts), the indexation grid's text
 * fragments (src/core/section/indexation_grid.ts) and tool_pdf_extractor's
 * html payload (tools/tool_pdf_extractor/server/pdf_payload.ts).
 *
 * A SPEC TOKENIZER, NOT A REGEX. The earlier version rewrote the string with
 * regular expressions, and a regex does not see HTML the way a browser does:
 * `<img/onerror=…>`, a handler glued to a closing quote (`src="x"onerror=…`),
 * a character-referenced scheme (`&#106;avascript:`) and RCDATA/RAWTEXT
 * content (`<title>…</title>`) all passed through it live, while prose such as
 * `x = "javascript:foo" and the onion=3` was corrupted. This pass runs Bun's
 * HTMLRewriter (lol-html, an HTML5 tokenizer with the RCDATA/RAWTEXT/comment
 * states), so a tag is judged by what a browser parses, and:
 *   - TEXT NODES ARE NEVER TOUCHED — prose survives byte for byte (the one
 *     exception: a raw `<` as the very last byte becomes `&lt;`, see 5.);
 *   - an element nothing below applies to is emitted VERBATIM (no
 *     re-serialisation), so benign content comes back byte-identical.
 * The rewriter is built PER CALL (no module singleton — module_state_tripwire).
 * There is no catch-and-passthrough: if the tokenizer throws, the save fails
 * loudly rather than storing an unsanitized value.
 *
 * A TOKENIZER, NOT A TREE BUILDER. lol-html switches its text state by tag NAME
 * alone; a browser's tree builder can veto that switch by context — classic
 * in-select parsing IGNORES `<title>`, so `<select><title><input onfocus=…>` is
 * markup to the browser and RCDATA text (never touched) to lol-html. So NO kept
 * element may own a context-dependent text state: every element lol-html would
 * tokenize as RCDATA/RAWTEXT/script/plaintext is in rule 1, content and all.
 *
 * THE RULES.
 *   1. Removed WITH their content: script, style, iframe, noscript, noembed,
 *      noframes, xmp, plaintext, template, svg, math, title, textarea. These
 *      execute, embed, or hold content a browser re-parses under a different
 *      rule (svg/math are FOREIGN content: CDATA and raw-text rules differ from
 *      HTML's, so keeping their content while dropping the tags re-parses it as
 *      HTML; noscript is parsed differently with scripting on and off — the
 *      mutation-XSS route; title/textarea are RCDATA whose raw-markup content
 *      revives under any re-parse or tree-builder veto). None is CKEditor
 *      formatting.
 *   2. Removed as a TAG, content kept as inert markup: object, embed, form,
 *      base, meta, link, applet, frame, frameset.
 *   3. On EVERY remaining element: every `on*` attribute is removed, and EVERY
 *      attribute value whose decoded form starts with a dangerous scheme
 *      (javascript:, vbscript:, or any data: URL that is not a raster
 *      image/png|jpeg|gif|webp|avif|bmp — the prose attributes listed in
 *      isProseAttribute keep only the old data:text/html + data:application/
 *      denylist) is set to `#` — every attribute, not an href allowlist, because formaction, xlink,
 *      poster, srcset and future attributes all carry URLs; a scheme allowlist
 *      would rewrite legitimate urn:/doi:/ftp: links instead. ONE verdict per
 *      attribute NAME: a duplicated name keeps its FIRST value, as a browser
 *      does, and the later occurrences are dropped (judgeAttributes) — never a
 *      dangerous duplicate stored behind a rewritten first one.
 *   4. Comments are removed — every bogus-comment spelling too (`<!x>`,
 *      `<?x>`, `</ x>`): invisible in rich text, and raw markup hidden in one
 *      revives under any later textual strip. (A doctype needs no rule: every
 *      fragment parse ignores a complete one, and an open one is a rule-5 tail.)
 *   5. THE OUTPUT IS CONTEXT-FREE: it ends in the tokenizer's DATA state, so it
 *      may be wrapped (`<mark>${v}</mark>`) or joined with another sanitized
 *      value and every byte still tokenizes as it did alone. Without this, a
 *      construct left open at EOF — `<img src=x onerror=alert(1) ` (lol-html
 *      emits an EOF-in-tag tail verbatim, with no event to judge), an open
 *      comment, an open RCDATA element — swallows the following bytes, and
 *      raw markup that was harmless INSIDE an attribute value of the next value
 *      (`<p title="--><img onerror=…>">`) comes out live. An open tail is
 *      DROPPED — what a browser does with an EOF-in-tag anyway — and a final
 *      raw `<` (data `<` at EOF, which glues to a following tag name) becomes
 *      `&lt;`, the same character to a browser.
 *      THE CUT IS BOUNDED (CLIENT-2): at most CLOSE_EXACT_PROBES `<` are probed
 *      backwards (one pass each — the exact cut, unchanged for every realistic
 *      tail); a longer tail is cut at the last offset ONE boundary pass proves
 *      to be in the data state, at most CLOSE_VERIFY_LIMIT candidates verified.
 *      Such a cut may also drop invisible markup just before the tail (stray
 *      end tags, comments, a doctype, CDATA) — never text, never an element.
 *      No verified boundary → the value is ESCAPED whole (kept as visible text,
 *      never markup, never silently emptied). Cost: ≤ 23 passes per rule-6
 *      iteration, whatever n is — the old walk spent one pass per `<` of the
 *      tail, O(n²).
 *   6. THE OUTPUT IS A FIXED POINT: rules 1–5 are re-run on their own output
 *      until a pass changes nothing (at most SANITIZE_PASS_LIMIT passes; not
 *      reached → the value is ESCAPED whole). One pass judges its INPUT's
 *      tokens, not the bytes it emits: a removal splices its neighbours
 *      (`<<script></script>img onerror=…>` → a live `<img onerror>`), and an
 *      svg/math implicitly closed by an ancestor's end tag (`<b><svg></b>`)
 *      leaves lol-html in foreign content, emitting `<![CDATA[ …]]>` as text a
 *      browser reads as markup once rule 1 removed the root. The fixed point is
 *      bytes the tokenizer itself read, in the state their reader will, and
 *      found clean — idempotent by construction. Benign content is a fixed
 *      point of the first pass: one pass, byte-identical, as before.
 *
 * THE SCHEME CHECK DECODES. HTMLRewriter hands attribute values back RAW —
 * character references NOT resolved — while a browser resolves them before the
 * URL parser sees the value. `decodeForSchemeCheck` resolves every numeric
 * reference and every NAMED reference whose value is scheme-relevant ASCII —
 * of the whole HTML5 table that is exactly &Tab; &NewLine; &colon; &sol; (the
 * other ASCII-valued names are punctuation no denylisted scheme contains, and
 * &fjlig; "fj" is in none of them) — then applies the WHATWG URL rules: ASCII
 * tab/LF/CR removed anywhere, leading C0-control-or-space removed, scheme compared
 * case-insensitively. The stored value keeps its original bytes; only the
 * verdict uses the decoded form. The gate lists the table's ASCII-valued names,
 * proves each against the spec parser, and spells every denylisted scheme with
 * each of them (html_sanitize.test.ts, "every ASCII-valued named reference").
 *
 * RESIDUAL. The `style` attribute is not inspected: CSS cannot execute script in
 * any supported browser (expression()/behavior: were IE-only). The enforcing CSP
 * (static_asset.ts APP_CSP) remains the primary control; this pass reduces the
 * STORED attack surface so a payload never reaches a context the CSP does not
 * cover (an export renderer, a non-browser consumer, a future CSP relaxation).
 *
 * Gate: test/unit/html_sanitize.test.ts — judged by an independent spec parser
 * (test/helpers/html_oracle.ts, cheerio over parse5), byte-identity on benign
 * content, idempotence.
 */

import { escapeHtml } from './html_escape.ts';

/**
 * Elements removed WITH their content (they execute, embed, or re-parse it).
 * Exported for the gate: every member must have a drop-with-content case there.
 */
export const REMOVE_WITH_CONTENT: ReadonlySet<string> = new Set([
	'script',
	'style',
	'iframe',
	'noscript',
	'noembed',
	'noframes',
	'xmp',
	'plaintext',
	'template',
	'svg',
	'math',
	'title',
	'textarea',
]);

/** Elements whose TAGS are removed; their content is kept. */
const REMOVE_TAG_KEEP_CONTENT: ReadonlySet<string> = new Set([
	'object',
	'embed',
	'form',
	'base',
	'meta',
	'link',
	'applet',
	'frame',
	'frameset',
]);

/** The named references that can spell scheme-relevant ASCII. Case-sensitive, as in HTML. */
const SCHEME_NAMED_REFERENCES: Readonly<Record<string, string>> = {
	Tab: '\t',
	NewLine: '\n',
	colon: ':',
	sol: '/',
};

/** A numeric reference's code point as the HTML spec resolves it (NUL / out of range / surrogate → U+FFFD). */
function codePointToString(codePoint: number): string {
	if (
		!Number.isFinite(codePoint) ||
		codePoint === 0 ||
		codePoint > 0x10ffff ||
		(codePoint >= 0xd800 && codePoint <= 0xdfff)
	) {
		return '�';
	}
	return String.fromCodePoint(codePoint);
}

/**
 * The attribute value as the browser's URL parser would see it — for the VERDICT
 * only. Numeric references (decimal and hex, with or without `;`, any zero
 * padding) and the scheme-relevant named references are resolved; then the
 * WHATWG URL pre-processing: tab/LF/CR removed anywhere, leading C0+space
 * removed; lowercased (schemes are ASCII case-insensitive).
 */
export function decodeForSchemeCheck(raw: string): string {
	const decoded = raw.replace(
		/&(?:#[xX]([0-9a-fA-F]+);?|#([0-9]+);?|([A-Za-z]+);)/g,
		(match, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
			if (hex !== undefined) return codePointToString(Number.parseInt(hex, 16));
			if (dec !== undefined) return codePointToString(Number.parseInt(dec, 10));
			if (name !== undefined && Object.hasOwn(SCHEME_NAMED_REFERENCES, name)) {
				return SCHEME_NAMED_REFERENCES[name] as string;
			}
			return match;
		},
	);
	return (
		decoded
			.replace(/[\t\n\r]/g, '')
			// biome-ignore lint/suspicious/noControlCharactersInRegex: the URL parser strips leading C0 controls — that IS the rule being applied
			.replace(/^[\u0000- ]+/, '')
			.toLowerCase()
	);
}

/**
 * The only `data:` URLs an attribute may keep: RASTER images (CodeQL #9673,
 * 2026-10-25). The scheme check stays a denylist (urn:/doi:/ftp: must survive),
 * but `data:` is inverted to an allowlist — a denylist of media types missed
 * `data:image/svg+xml` (scriptable), `data:text/xml`, and `data: text/html`
 * (the data-URL parser strips the space). Anything else after `data:` → `#`.
 */
const RASTER_DATA_URL = /^data:image\/(?:png|jpeg|jpg|gif|webp|avif|bmp)(?:[;,]|$)/;

/**
 * Attributes a browser never resolves as a URL, so a value that merely STARTS
 * with "data:" there is prose (`alt="Data: 1923"`), not a data URL. Only the
 * `data:` allowlist skips them; the javascript:/vbscript: denylist still
 * applies to every attribute. A name not listed (including any future URL
 * attribute) gets the allowlist — the safe default.
 */
function isProseAttribute(name: string): boolean {
	return (
		name === 'alt' ||
		name === 'title' ||
		name === 'class' ||
		name === 'id' ||
		name === 'lang' ||
		name === 'dir' ||
		name.startsWith('aria-') ||
		name.startsWith('data-')
	);
}

/** True when an already-decoded attribute value uses a dangerous scheme. */
function isDangerousUrl(normalized: string, attributeName: string): boolean {
	if (normalized.startsWith('javascript:') || normalized.startsWith('vbscript:')) return true;
	if (!normalized.startsWith('data:')) return false;
	if (isProseAttribute(attributeName)) {
		// Prose attribute: the historical media-type denylist only.
		return normalized.startsWith('data:text/html') || normalized.startsWith('data:application/');
	}
	return !RASTER_DATA_URL.test(normalized);
}

/** The tag of the end-of-input probe (see {@link endsInDataState}). */
const EOF_PROBE_TAG = 'dedalo-eof-probe';

/**
 * True when `html` ends in the tokenizer's DATA state — nothing left open. A
 * probe element carrying a per-call nonce is appended: only in the data state
 * does its `<` open a tag of its own; inside an open tag, attribute value,
 * comment, doctype or raw-text element it is swallowed and never fires. The
 * nonce makes the probe unforgeable by the content itself.
 */
function endsInDataState(html: string): boolean {
	const nonce = crypto.randomUUID();
	let seen = false;
	new HTMLRewriter()
		.on('*', {
			element(element) {
				if (element.tagName === EOF_PROBE_TAG && element.getAttribute('data-nonce') === nonce) {
					seen = true;
				}
			},
		})
		.transform(`${html}<${EOF_PROBE_TAG} data-nonce="${nonce}">`);
	return seen;
}

/**
 * How many `<` the exact backward walk of rule 5 probes (one pass each) before
 * it hands over to the boundary pass. A tail with this many `<` or fewer is cut
 * exactly where the unbounded walk cut it.
 */
export const CLOSE_EXACT_PROBES = 16;

/** How many boundary candidates rule 5 verifies (one pass each) before it escapes. */
export const CLOSE_VERIFY_LIMIT = 4;

/** Raw-text / RCDATA / script / plaintext elements: no data-state offset inside them. */
const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set([
	'script',
	'style',
	'xmp',
	'iframe',
	'noembed',
	'noframes',
	'noscript',
	'textarea',
	'title',
	'plaintext',
]);

/** Foreign-content roots: CDATA and breakout rules differ, so no offset inside them. */
const FOREIGN_ROOTS: ReadonlySet<string> = new Set(['svg', 'math']);

/**
 * The per-call state of ONE {@link dataStateBoundaries} pass: the nonce marker,
 * its insert options, and where the tokenizer sits (inside a raw-text element,
 * how deep inside foreign content). Built per call — never module state.
 */
interface BoundaryMarking {
	readonly marker: string;
	readonly insert: { readonly html: true };
	rawOpen: boolean;
	foreignDepth: number;
}

/** {@link dataStateBoundaries}' element rule: the offsets around ONE element. */
function markElementBoundaries(element: HTMLRewriterTypes.Element, marking: BoundaryMarking): void {
	if (marking.rawOpen || marking.foreignDepth > 0) {
		trackNestedForeignRoot(element, marking);
		return;
	}
	const name = element.tagName.toLowerCase();
	if (RAW_TEXT_ELEMENTS.has(name)) {
		markRawTextElement(element, marking);
		return;
	}
	if (FOREIGN_ROOTS.has(name)) {
		markForeignRoot(element, marking);
		return;
	}
	const { marker, insert } = marking;
	if (!element.canHaveContent) {
		element.after(marker, insert);
		return;
	}
	element.prepend(marker, insert);
	element.onEndTag((end) => {
		if (!marking.rawOpen && marking.foreignDepth === 0) end.after(marker, insert);
	});
}

/**
 * Inside raw text or foreign content nothing is marked; only nested foreign
 * roots are tracked, so the depth returns to 0 at the matching end tag.
 */
function trackNestedForeignRoot(
	element: HTMLRewriterTypes.Element,
	marking: BoundaryMarking,
): void {
	const name = element.tagName.toLowerCase();
	if (marking.foreignDepth > 0 && FOREIGN_ROOTS.has(name) && element.canHaveContent) {
		marking.foreignDepth++;
		element.onEndTag(() => {
			marking.foreignDepth--;
		});
	}
}

/** A raw-text element: marked BEFORE its start tag and after its end tag, never inside. */
function markRawTextElement(element: HTMLRewriterTypes.Element, marking: BoundaryMarking): void {
	const { marker, insert } = marking;
	element.before(marker, insert);
	if (!element.canHaveContent) return;
	marking.rawOpen = true;
	element.onEndTag((end) => {
		marking.rawOpen = false;
		end.after(marker, insert);
	});
}

/**
 * An svg/math root: marked before it and right after its own start tag (still
 * the data state — CDATA can only open after it); nothing inside is marked.
 */
function markForeignRoot(element: HTMLRewriterTypes.Element, marking: BoundaryMarking): void {
	const { marker, insert } = marking;
	element.before(marker, insert);
	if (!element.canHaveContent) {
		element.after(marker, insert);
		return;
	}
	element.prepend(marker, insert);
	marking.foreignDepth++;
	element.onEndTag((end) => {
		marking.foreignDepth--;
		if (marking.foreignDepth === 0) end.after(marker, insert);
	});
}

/**
 * Every offset of `html` that ONE tokenizer pass places in the DATA state,
 * ascending, starting with 0 — or `[]` when the pass cannot vouch for them.
 *
 * A per-call nonce marker (wrapped in private-use characters, unforgeable by
 * the content) is inserted where the tokenizer provably sits in the data state:
 *   - after a whole text node (never after one ending in `</`, which is an
 *     end-tag-open at EOF, not data);
 *   - right after the start tag of an element that can hold content, after its
 *     end tag, and after a void / self-closing element;
 *   - BEFORE the start tag of a raw-text element (script, style, xmp, iframe,
 *     noembed, noframes, noscript, textarea, title, plaintext) — never inside
 *     it until its end tag; and before / right after an svg/math root's start
 *     tag, never inside foreign content (lol-html emits CDATA there as text,
 *     and its breakout differs from the spec's).
 * The marked output is split on the marker; when the parts do not join back to
 * `html` byte for byte (the pass re-encoded something — a lone surrogate
 * becomes U+FFFD), the offsets would point into another string, so `[]`.
 * Every offset is still VERIFIED by the caller before a cut — this pass
 * proposes, {@link endsInDataState} decides.
 */
export function dataStateBoundaries(html: string): number[] {
	const marking: BoundaryMarking = {
		marker: `\uE000${crypto.randomUUID()}\uE001`,
		insert: { html: true },
		rawOpen: false,
		foreignDepth: 0,
	};
	const { marker, insert } = marking;
	let textNode = '';
	const marked = new HTMLRewriter()
		.onDocument({
			text(text) {
				textNode += text.text;
				if (!text.lastInTextNode) return;
				const whole = textNode;
				textNode = '';
				if (marking.rawOpen || marking.foreignDepth > 0 || whole.endsWith('</')) return;
				text.after(marker, insert);
			},
		})
		.on('*', {
			element(element) {
				markElementBoundaries(element, marking);
			},
		})
		.transform(html);
	const parts = marked.split(marker);
	if (parts.join('') !== html) return [];
	const boundaries = [0];
	let offset = 0;
	for (let i = 0; i < parts.length - 1; i++) {
		offset += (parts[i] as string).length;
		if (offset !== boundaries[boundaries.length - 1]) boundaries.push(offset);
	}
	return boundaries;
}

/**
 * Rule 5: make `html` end in the data state, in a bounded number of passes.
 *   1. Already in the data state → kept whole.
 *   2. The EXACT walk: an open tail always begins at a `<`, and every `<`
 *      inside it has a prefix that is itself still open — so the LAST `<`
 *      whose prefix ends in the data state is where the tail starts. At most
 *      CLOSE_EXACT_PROBES `<` are probed; within that the cut is exact.
 *   3. Beyond it: ONE boundary pass ({@link dataStateBoundaries}), then at most
 *      CLOSE_VERIFY_LIMIT candidates verified from the last. The first verified
 *      one is the cut (it may sit before invisible markup the exact walk kept:
 *      stray end tags, comments, a doctype, CDATA — never text or an element).
 *   4. Nothing verified → the value is ESCAPED whole: kept as visible text,
 *      never markup, never silently dropped.
 * The tail is dropped (a browser drops an EOF-in-tag as well). A final raw `<`
 * is escaped: harmless alone, it would open a tag with whatever bytes follow.
 * Passes: 1 + 16 + 1 + 4 = 22 at most (23 with the rewriter pass of the same
 * rule-6 iteration), independent of the tail's length.
 */
export function closeAtDataState(html: string): string {
	let out = html;
	if (!endsInDataState(out)) {
		out = exactCut(html) ?? boundedCut(html, dataStateBoundaries(html)) ?? escapeHtml(html);
	}
	return out.endsWith('<') ? `${out.slice(0, -1)}&lt;` : out;
}

/** Step 2 of {@link closeAtDataState}: the exact backward walk, or null past its probe budget. */
function exactCut(html: string): string | null {
	let cut = html.lastIndexOf('<');
	for (let probes = 0; cut > 0; probes++) {
		if (probes >= CLOSE_EXACT_PROBES) return null;
		if (endsInDataState(html.slice(0, cut))) return html.slice(0, cut);
		cut = html.lastIndexOf('<', cut - 1);
	}
	// reached the start (or no `<` at all): the whole value is the open tail
	return '';
}

/**
 * Step 3 of {@link closeAtDataState}: the last of `boundaries` that verifies,
 * trying at most CLOSE_VERIFY_LIMIT of them (one pass each) — or null. The list
 * is a PARAMETER so the gate can hand it candidates that all fail verification:
 * the boundary pass never proposes one in practice (G3), so without that seam
 * the cap — the half of the rule-5 bound that keeps a wrong boundary pass from
 * costing O(n) passes of O(n) on the SAVE path — would be untested.
 */
export function boundedCut(html: string, boundaries: readonly number[]): string | null {
	let verified = 0;
	for (let i = boundaries.length - 1; i >= 0 && verified < CLOSE_VERIFY_LIMIT; i--) {
		const prefix = html.slice(0, boundaries[i] as number);
		verified++;
		if (endsInDataState(prefix)) return prefix;
	}
	return null;
}

/**
 * Rule 3 on one element, ONE VERDICT PER ATTRIBUTE NAME — the name a browser
 * keeps. A duplicated name is a parse error a browser resolves by keeping the
 * FIRST occurrence and dropping the rest; lol-html lists every occurrence, but
 * `setAttribute`/`removeAttribute` touch only the first. Judging occurrence by
 * occurrence therefore rewrote the benign first `href` to `#` and STORED the
 * dangerous duplicate behind it — dead in a browser, live for any last-wins
 * consumer (an export re-serialiser, a non-browser parser), the very consumers
 * this denylist exists for. So: the first value is judged, every occurrence is
 * removed, and the name is set ONCE to the judged value. A name the rewriter
 * cannot emit (`=x`) is left removed — dropping an attribute is the safe side.
 * A name that occurs once keeps its original bytes unless it is rewritten.
 */
function judgeAttributes(element: HTMLRewriterTypes.Element): void {
	// A COPY of the attribute list: it is mutated while walked. Names come back
	// lowercased, so `href` and `HREF` are one name, as in a browser.
	const occurrences = new Map<string, number>();
	for (const [name] of [...element.attributes]) {
		occurrences.set(name, (occurrences.get(name) ?? 0) + 1);
	}
	for (const [name, count] of occurrences) judgeAttributeName(element, name, count);
}

/** {@link judgeAttributes} for ONE name occurring `count` times. */
function judgeAttributeName(element: HTMLRewriterTypes.Element, name: string, count: number): void {
	if (/^on/i.test(name)) {
		removeEveryOccurrence(element, name, count);
		return;
	}
	const first = element.getAttribute(name) ?? '';
	const judged = judgedAttributeValue(name, first);
	if (count === 1) {
		if (judged !== first) element.setAttribute(name, judged);
		return;
	}
	removeEveryOccurrence(element, name, count);
	try {
		element.setAttribute(name, judged);
	} catch {
		// the name is not emittable (`=` and kin): it stays removed — not a
		// passthrough, the attribute is gone
	}
}

/** Rule 3's verdict on one attribute value: a dangerous URL becomes `#`. */
function judgedAttributeValue(name: string, value: string): string {
	return isDangerousUrl(decodeForSchemeCheck(value), name) ? '#' : value;
}

/** Remove every occurrence of `name` (removeAttribute touches only the first). */
function removeEveryOccurrence(
	element: HTMLRewriterTypes.Element,
	name: string,
	count: number,
): void {
	for (let i = 0; i < count && element.hasAttribute(name); i++) element.removeAttribute(name);
}

/**
 * How many rewriter passes {@link sanitizeRichText} runs to reach a FIXED
 * POINT (rule 6) before it gives up and escapes the value whole. Benign content
 * is a fixed point of the first pass; each level of a nested splice costs one.
 */
export const SANITIZE_PASS_LIMIT = 4;

/** ONE pass of rules 1–4 (the rewriter), built per call. */
function rewriteOnce(input: string): string {
	// Built per call: a rewriter is stateful, and a module-level one would be
	// shared by concurrent requests.
	return new HTMLRewriter()
		.onDocument({
			comments(comment) {
				comment.remove();
			},
		})
		.on('*', {
			element(element) {
				const tag = element.tagName.toLowerCase();
				if (REMOVE_WITH_CONTENT.has(tag)) {
					element.remove();
					return;
				}
				if (REMOVE_TAG_KEEP_CONTENT.has(tag)) {
					element.removeAndKeepContent();
				}
				judgeAttributes(element);
			},
		})
		.transform(input);
}

/**
 * Sanitize a stored rich-text HTML string. Non-strings / empty pass through.
 *
 * Rule 6 — THE OUTPUT IS A FIXED POINT: it is returned only once one more pass
 * (rules 1–5) leaves it byte-identical, i.e. the tokenizer read THE STORED
 * BYTES and found nothing to change. One pass is not enough, because a pass
 * judges its INPUT's tokens and emits other bytes:
 *   - a removal SPLICES its neighbours: `<<script></script>img onerror=…>` —
 *     the text `<` and the text `img …>` meet across the removed element and
 *     the output is a live `<img onerror>` no pass ever saw as a tag (any
 *     rule-1/2/4 removal: an element, a tag, a comment);
 *   - lol-html's tokenizer can sit in a state the output's reader never will:
 *     an ancestor's end tag implicitly closes an svg/math (`<b><svg></b>`),
 *     lol-html stays in FOREIGN content and emits `<![CDATA[ a><img onerror>]]>`
 *     as text (never touched), while the output — its svg start tag removed by
 *     rule 1 — parses as plain HTML: a bogus comment ending at the first `>`,
 *     then live markup.
 * The next pass reads the output itself, in the state its reader will (no
 * svg/math is left to enter foreign content; no text-state element is left —
 * rule 1), so a fixed point holds no construct the tokenizer did not judge.
 * Not reached in SANITIZE_PASS_LIMIT passes (a splice nested deeper than any
 * real text) → the last pass's output is ESCAPED whole: visible text, never
 * markup, never silently dropped — and itself a fixed point. Idempotence
 * (`s(s(x)) === s(x)`) follows by construction.
 */
export function sanitizeRichText(input: string): string {
	if (typeof input !== 'string' || input === '') return input;

	let current = input;
	for (let pass = 0; pass < SANITIZE_PASS_LIMIT; pass++) {
		const next = closeAtDataState(rewriteOnce(current));
		if (next === current) return current;
		current = next;
	}
	return escapeHtml(current);
}

/**
 * Apply {@link sanitizeRichText} to the string `value` of every item in a
 * save change set (mirrors the shape of password_hash.hashPasswordChanges) —
 * the XSS-01 SAVE gate for component_text_area, funnelling every write door
 * (client API, MCP tools, agent change-plan, import) through one place.
 */
export function sanitizeRichTextChanges<T extends { value: unknown }>(changes: readonly T[]): T[] {
	const sanitizeItem = (item: unknown): unknown => {
		if (
			item !== null &&
			typeof item === 'object' &&
			typeof (item as { value?: unknown }).value === 'string'
		) {
			return { ...item, value: sanitizeRichText((item as { value: string }).value) };
		}
		return item;
	};
	return changes.map((change) =>
		Array.isArray(change.value)
			? { ...change, value: change.value.map(sanitizeItem) }
			: { ...change, value: sanitizeItem(change.value) },
	);
}
