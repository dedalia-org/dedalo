// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0

/**
 * MARKDOWN_UTILS
 * Bidirectional HTML ↔ Markdown conversion for the tool_lang browser translation pipeline.
 *
 * The translation model operates on plain Markdown rather than raw HTML because HTML tags
 * confuse it and inflate token counts:
 *
 *   HTML → html_to_markdown → segment_markdown → [model] → markdown_to_html → HTML
 *
 * Dédalo inline marks (indexIn, tc, svg, geo, …) are replaced with [[[n]]] tokens
 * (placeholders.js) BEFORE html_to_markdown, and restored after markdown_to_html, by the
 * caller (browser_translation.js).
 *
 * THE MODEL'S OUTPUT IS TEXT, NEVER MARKUP (A1-02 review). markdown_to_html HTML-escapes
 * everything the model wrote; the only markup in its result is what the converter itself
 * emits (<p>, <br>, <strong>, <em>, <u>, <code>) — none of it carrying an attribute the
 * model wrote. A model that answers '<img src=x onerror=…>' or '<script>' therefore saves
 * those characters as visible text.
 *
 * BLOCK STRUCTURE COMES FROM THE SOURCE, NEVER FROM THE MODEL'S TEXT (A1-02 re-review).
 * Markdown block syntax is inferred from plain text: a paragraph that opens with '1984. '
 * is an ordered list, '- ¿Dónde?' a bullet, '---' a rule, '# 5 de mayo' a heading, '> cita'
 * a quote. So nothing here writes or reads Markdown block syntax: the only block forms are
 * the paragraph (<p> ↔ a blank line) and the line break (<br> ↔ '\n'); headings, lists,
 * quotes, rules, tables, <div> and every other block element travel as shielded tokens like
 * any tag without a Markdown form, and the model's '1984. ' or '---' is just text.
 *
 * What makes that possible is that the model never receives markup either. Elements with
 * no Markdown inline form — <span style>, <sub>, <sup>, <mark>, <a href>, <img>, <h2>, <ul>,
 * <li>, <blockquote>, <hr>, <table>, <div>, anything unknown — are SHIELDED: html_to_markdown
 * hands each start tag, end tag or whole void element to the caller's `shield` callback,
 * which returns a [[[n]]] token and remembers the tag, and the caller restores it like a
 * Dédalo mark. A restored tag is the source tag as the browser SERIALISES it (DOMParser +
 * outerHTML: attribute quoting and entities normalised, the same form an editor saves) — not
 * a byte copy of the stored string; the model only sees (and translates) the text between
 * them. <pre> (code) is one atom and is not translated. v6 sent these elements to the model as raw
 * outerHTML (d3991c3a66), where it could corrupt them and where nothing stopped it from
 * writing its own; the per-block local token numbering and edge hoisting (55c816b41c) made
 * the extra tokens affordable.
 *
 * Ported from v6 (d3991c3a66, 55c816b41c, 92da452aa1, 40bf5eaacf): <br> as a single '\n',
 * the model-added <p> wrapper strip, the join-before-inline emphasis rule, the edge-emphasis
 * rules 3b and the orphan-delimiter drop (rule 8), conform_emphasis,
 * restore_wrapping_emphasis and segment_markdown. Not ported: v6's raw-HTML block
 * passthrough, its balance_inline_html (only needed for model-authored tags, which no
 * longer exist) and its link rule (links are shielded).
 *
 * Exports:
 *   html_to_markdown            — DOM walk: HTML string → Markdown string (tags shielded)
 *   markdown_to_html            — Markdown string → HTML string (model text escaped)
 *   conform_emphasis            — delete emphasis delimiters the model invented
 *   restore_wrapping_emphasis   — re-wrap a wholly-emphasised segment the model unwrapped
 *   split_markdown_by_paragraph — split Markdown on \n\n+ boundaries → string[]
 *   segment_markdown            — split into {text, sep} segments the model can translate
 *                                 one at a time, WITHOUT losing what separated them
 *   marks_in_text_nodes         — every Dédalo-mark-shaped string that sits in a text node
 */

/**
 * Elements whose whole outerHTML is ONE atom token: their content is not prose to
 * translate (a script, an embedded object) or is not reachable as text at all.
 * @type {Set<string>}
 */
const RAW_ATOM_TAGS = new Set([
	'script',
	'style',
	'template',
	'iframe',
	'object',
	'embed',
	'svg',
	'math',
	'video',
	'audio',
	'canvas',
	'noscript',
	'textarea',
	'select',
	// code is not prose, and its line breaks are content: one atom, restored as it was
	'pre',
]);

/**
 * HTML void elements: no content and no end tag, so one atom token.
 * @type {Set<string>}
 */
const VOID_TAGS = new Set([
	'area',
	'base',
	'br',
	'col',
	'hr',
	'img',
	'input',
	'link',
	'meta',
	'source',
	'track',
	'wbr',
]);

/**
 * The void elements that are BLOCK-level: shielded as an atom set apart as its own block (a
 * rule inside a <p> is not valid HTML). Every other void element (img, wbr …) is inline.
 * @type {Set<string>}
 */
const BLOCK_VOID_TAGS = new Set(['hr']);

/**
 * IS_BLOCK_TAG
 * Is a shielded element block-level? Unknown tags are (their content cannot weld onto a
 * paragraph); known inline ones and inline void ones are not.
 * @param {string} tag - lower-case tag name
 * @returns {boolean}
 */
const is_block_tag = (tag) =>
	BLOCK_VOID_TAGS.has(tag) || (!INLINE_SHIELD_TAGS.has(tag) && !VOID_TAGS.has(tag));

/**
 * Elements with no Markdown equivalent that are INLINE: their start and end tags become a
 * pair of tokens inside the running text.
 * @type {Set<string>}
 */
const INLINE_SHIELD_TAGS = new Set([
	'a',
	'span',
	'sub',
	'sup',
	'small',
	'mark',
	'del',
	's',
	'ins',
	'abbr',
	'cite',
	'q',
	'kbd',
	'samp',
	'var',
	'dfn',
	'time',
	'bdi',
	'bdo',
	'font',
	'label',
]);

/**
 * The elements html_to_markdown writes as Markdown inline syntax even inside a shielded
 * element (emphasis and code survive the trip as Markdown; everything else in there is
 * shielded, so a shielded element's content is one line of text and tokens).
 * @type {Set<string>}
 */
const MD_INLINE_TAGS = new Set(['strong', 'b', 'em', 'i', 'u', 'code']);

/**
 * Private-use characters standing in, inside process_inline, for a backslash-escaped
 * Markdown metacharacter: the escaped character must reach the record as a literal, never
 * be read by an emphasis rule (v6 unescaped FIRST, so '2\*3\*4' became '2<em>3</em>4').
 * @type {Object<string,string>}
 */
const ESCAPE_STANDINS = {
	'\\': '',
	'*': '',
	_: '',
	'[': '',
	']': '',
	'`': '',
};

/** The line-break stand-in: a '\n' inside a block, turned into <br> after the inline rules. */
const LINE_BREAK_STANDIN = '';

/** Brackets a set-aside inline code span's index inside process_inline (U+E007 <n> U+E007). */
const CODE_STANDIN = '\uE007';
const CODE_STANDIN_RE = /\uE007(\d+)\uE007/g;

/** Every stand-in, so text that already contains one cannot be misread as ours. */
const STANDIN_RE = /[\uE000-\uE007]/g;

/**
 * ASCII_TRIM
 * Trim ASCII whitespace only. String.prototype.trim also strips U+00A0, which is how an
 * empty paragraph travels (html_to_markdown) — trimming it would drop the paragraph.
 * @param {string} text
 * @returns {string}
 */
const ascii_trim = (text) => text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');

/**
 * ESCAPE_HTML
 * Escape a string for use as HTML text content. U+00A0 is written as &nbsp; (the form
 * CKEditor stores), so an empty paragraph round-trips as <p>&nbsp;</p>.
 * @param {string} text
 * @returns {string}
 */
const escape_html = (text) =>
	text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/ /g, '&nbsp;');

/**
 * HTML_TO_MARKDOWN
 * Convert an HTML string to Markdown for the translation model.
 *
 * Conversions:
 *   Block:  <p> → \n\n  |  <br> → \n
 *   Inline: <strong>/<b> → **  |  <em>/<i> → *  |  <u> → __  |  <code> → `code`
 *   Shielded (see the header): every other element — headings, lists, quotes, rules,
 *   tables, <div> included — as tokens from options.shield; <pre> as one atom.
 *
 * <br> is a single '\n' (v6 55c816b41c): '\n\n' is a paragraph boundary, the strongest cut
 * of segment_markdown, and emitting it cut any inline element containing a <br> in half.
 *
 * Text nodes: Markdown metacharacters (\ * _ `) are backslash-escaped so literal characters
 * survive; [ and ] are not (v6: escaping them made the model reproduce the backslashes). A
 * raw newline inside a text node is whitespace in HTML, so it travels as a space — left as
 * '\n' it would come back as a <br>. A whitespace-only <p> emits U+00A0, so the paragraph
 * survives the round-trip (markdown_to_html writes it as &nbsp;).
 *
 * @param {string} html - HTML with Dédalo marks already replaced by [[[n]]] tokens.
 * @param {Object} [options]
 * @param {Function} [options.shield] - ({html, kind, block, pair}) => token. Called for
 *   each start tag (kind 'open'), end tag ('close', pair = the open's token) and void or
 *   raw element ('atom'); `block` is true for a block-level element. Without it, an
 *   element that needs shielding THROWS — it cannot be represented in Markdown, and it
 *   must never travel to the model as markup.
 * @returns {string} Markdown, trimmed, runs of 3+ newlines collapsed to 2.
 */
export function html_to_markdown(html, options = {}) {
	const shield = options.shield;

	const parser = new DOMParser();
	const doc = parser.parseFromString(html, 'text/html');

	// Regex to detect [[[n]]] placeholder strings — never escaped
	const token_re = /^\[\[\[\d+\]\]\]$/;

	// how many shielded elements enclose the node being walked. Inside one, every element
	// without a Markdown inline form is shielded too — a <p> or <br> inside a merged-cell
	// table converted to '\n\n' / '\n' would split the table's tokens across Markdown
	// blocks. Only an outermost block-level shield is set apart as its own block.
	let shield_depth = 0;

	/**
	 * ESCAPE_MD (inner)
	 * Backslash-escape the Markdown metacharacters of a text node. [[[n]]] tokens pass
	 * through verbatim.
	 * @param {string} text
	 * @returns {string}
	 */
	const escape_md = (text) => {
		const parts = text.split(/(\[\[\[\d+\]\]\])/);
		return parts
			.map((part) => {
				if (token_re.test(part)) {
					return part;
				}
				return part
					.replace(/\\/g, '\\\\')
					.replace(/\*/g, '\\*')
					.replace(/_/g, '\\_')
					.replace(/`/g, '\\`');
			})
			.join('');
	};

	/**
	 * CALL_SHIELD (inner)
	 * @param {Object} request - {html, kind, block, pair}
	 * @returns {string} The token.
	 */
	const call_shield = (request) => {
		if (typeof shield !== 'function') {
			throw new Error(
				`html_to_markdown: '${request.html.slice(0, 40)}' has no Markdown form and no shield was given`,
			);
		}
		return shield(request);
	};

	/**
	 * START_TAG (inner)
	 * The element's start tag exactly as the browser serialises it.
	 * @param {Element} node
	 * @returns {string}
	 */
	const start_tag = (node) => {
		const outer = node.cloneNode(false).outerHTML;
		const end_at = outer.lastIndexOf('</');
		return end_at === -1 ? outer : outer.slice(0, end_at);
	};

	/**
	 * SHIELD_ELEMENT (inner)
	 * Replace an element's tags by tokens and walk its children as text.
	 * @param {Element} node
	 * @param {boolean} block - a block-level element
	 * @returns {string}
	 */
	const shield_element = (node, block) => {
		const tag = node.tagName.toLowerCase();

		const set_apart = block && shield_depth === 0;

		if (RAW_ATOM_TAGS.has(tag) || VOID_TAGS.has(tag)) {
			const atom = call_shield({ html: node.outerHTML, kind: 'atom', block, pair: null });
			return set_apart ? `\n\n${atom}\n\n` : atom;
		}

		const open = call_shield({ html: start_tag(node), kind: 'open', block, pair: null });

		shield_depth++;
		// whitespace-only text directly inside a block-level element is layout, not
		// content (in a <tr> the browser would even move it out of the table)
		const inner = Array.from(node.childNodes)
			.map((child) => (block && child.nodeType === 3 && !child.textContent.trim() ? '' : walk(child)))
			.join('');
		shield_depth--;

		const close = call_shield({ html: `</${tag}>`, kind: 'close', block, pair: open });

		return set_apart ? `\n\n${open}${inner}${close}\n\n` : open + inner + close;
	};

	/**
	 * WALK (inner)
	 * Convert one DOM node and its descendants.
	 * @param {Node} node
	 * @returns {string}
	 */
	const walk = (node) => {
		if (node.nodeType === 3) {
			const text = node.textContent;
			if (!text) {
				return '';
			}
			return escape_md(text.replace(/[ \t]*[\r\n]+[ \t]*/g, ' '));
		}

		if (node.nodeType !== 1) {
			return '';
		}

		const tag = node.tagName.toLowerCase();

		if (shield_depth > 0 && !MD_INLINE_TAGS.has(tag)) {
			return shield_element(node, is_block_tag(tag));
		}

		switch (tag) {
			case 'p': {
				const inner = walk_children(node);
				return `${inner.trim() ? inner : ' '}\n\n`;
			}

			case 'br':
				return '\n';

			case 'strong':
			case 'b': {
				const inner = walk_children(node);
				return inner.trim() ? `**${inner}**` : inner;
			}

			case 'em':
			case 'i': {
				const inner = walk_children(node);
				return inner.trim() ? `*${inner}*` : inner;
			}

			case 'u': {
				const inner = walk_children(node);
				return inner.trim() ? `__${inner}__` : inner;
			}

			case 'code':
				return `\`${walk_children(node)}\``;

			default:
				// no Markdown equivalent: shielded (an unknown tag is treated as block-level
				// unless it is a known inline one, so its content cannot weld onto a paragraph)
				return shield_element(node, is_block_tag(tag));
		}
	};

	/**
	 * WALK_CHILDREN (inner)
	 * @param {Node} node
	 * @returns {string}
	 */
	const walk_children = (node) => Array.from(node.childNodes).map(walk).join('');

	const md = Array.from(doc.body.childNodes).map(walk).join('');

	return ascii_trim(md).replace(/\n{3,}/g, '\n\n');
} //end html_to_markdown

/**
 * MARKDOWN_TO_HTML
 * Convert the translated Markdown back to HTML.
 *
 * Every character the model wrote is HTML-escaped (process_inline / escape_html); the only
 * tags in the result are the ones emitted here. [[[n]]] tokens are untouched — the caller
 * restores them after this.
 *
 * Blocks (split on \n\n+) — NO block syntax is parsed (see the header: '1984. ', '- ',
 * '---', '#', '>' at a line start are text the model wrote, never structure):
 *   starts with a block token (options.block_tokens) → its content, NO <p> wrapper (a
 *                       shielded block element: <p><ul> is not valid HTML)
 *   anything else     → <p>, a single \n inside becoming <br>
 *
 * A <p>…</p> the model wrapped around a block is stripped (v6 55c816b41c): it would
 * otherwise be saved as the literal text '<p>'.
 *
 * @param {string} md - Markdown from the model.
 * @param {Object} [options]
 * @param {Set<string>} [options.block_tokens] - tokens that stand for a block-level tag.
 * @returns {string} HTML ('' for falsy input).
 */
export function markdown_to_html(md, options = {}) {
	if (!md) {
		return '';
	}

	const block_tokens = options.block_tokens || new Set();
	const starts_with_block_token = (block) => {
		const first = block.match(/^\[\[\[\d+\]\]\]/);
		return first !== null && block_tokens.has(first[0]);
	};

	// our own stand-ins must not already be in the text (they would be read as ours)
	const raw_blocks = ascii_trim(String(md).replace(STANDIN_RE, '')).split(/\n{2,}/);

	const html_blocks = [];

	for (const raw_block of raw_blocks) {
		const block = ascii_trim(raw_block)
			.replace(/^<p>\s*/i, '')
			.replace(/\s*<\/p>$/i, '');
		if (!block) {
			continue;
		}

		const lines = block.split('\n');

		// The lines are joined BEFORE process_inline (v6 55c816b41c): run per line, the
		// inline rules (which exclude newlines) could never match emphasis spanning a <br>.
		const inline_html = with_line_breaks(process_inline(lines.join(LINE_BREAK_STANDIN)));

		// a shielded block element: its own tags are its structure
		if (starts_with_block_token(block)) {
			html_blocks.push(inline_html);
			continue;
		}

		html_blocks.push(`<p>${inline_html}</p>`);
	}

	return html_blocks.join('');
} //end markdown_to_html

/**
 * WITH_LINE_BREAKS
 * @param {string} html - process_inline output carrying LINE_BREAK_STANDIN.
 * @returns {string}
 */
const with_line_breaks = (html) => html.split(LINE_BREAK_STANDIN).join('<br>');

/**
 * PROCESS_INLINE
 * Inline Markdown → HTML, with every character of the text escaped.
 *
 * Order:
 *   1. Backslash-escaped metacharacters (escape_md) are set aside as stand-ins, so no
 *      emphasis rule can read them; they come back as literal characters at the end.
 *   2. The whole text is HTML-escaped — from here on, the only '<' in it are the tags
 *      the rules below emit.
 *   3. Inline code `…`, set aside as a stand-in until the end, so no emphasis rule reaches
 *      into or across it.
 *   4. Bold+italic ***…***, then the two edge shapes (rule 3b, v6 55c816b41c):
 *      '**bold *both***' and '***both* bold**'.
 *   5. Bold **…** (may contain a lone '*': an italic in the middle of the bold run).
 *   6. Italic *…*.
 *   7. Underline __…__.
 *   8. Orphan '**' / '__' (a delimiter whose partner the model dropped) are deleted
 *      (v6 rule 8); left in, they reach the record as literal asterisks.
 *
 * @param {string} text - Inline Markdown (line breaks as LINE_BREAK_STANDIN).
 * @returns {string} HTML ('' for falsy input).
 */
function process_inline(text) {
	if (!text) {
		return '';
	}

	// 1. set the escaped metacharacters aside
	let out = text.replace(/\\([\\*_[\]`])/g, (_match, char) => ESCAPE_STANDINS[char]);

	// 2. escape everything the model wrote
	out = escape_html(out);

	// 3. inline code, SET ASIDE until the end: no emphasis rule may reach into or across it
	// ('**a `b** c`' must not become <strong>a <code>b</strong> c</code>)
	const code_spans = [];
	// (a code span never spans a line break: '```' fences are text, not a code block)
	out = out.replace(/`([^`\n\uE000]+)`/g, (_match, code) => {
		code_spans.push(`<code>${code}</code>`);
		return `${CODE_STANDIN}${code_spans.length - 1}${CODE_STANDIN}`;
	});

	// 4. bold+italic, and emphasis at the edge of a bold run
	out = out.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>');
	out = out.replace(/\*\*([^*\n]*)\*([^*\n]+)\*\*\*/g, '<strong>$1<em>$2</em></strong>');
	out = out.replace(/\*\*\*([^*\n]+)\*([^*\n]*)\*\*/g, '<strong><em>$1</em>$2</strong>');

	// 5. bold
	out = out.replace(/\*\*((?:[^*\n]|\*(?!\*))+)\*\*/g, '<strong>$1</strong>');

	// 6. italic
	out = out.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');

	// 7. underline
	out = out.replace(/__([^_\n]+)__/g, '<u>$1</u>');

	// 8. orphan delimiters
	out = out.replace(/\*\*/g, '').replace(/__/g, '');

	// the code spans, then the escaped metacharacters as the literal characters they are
	out = out.replace(CODE_STANDIN_RE, (_match, index) => code_spans[Number(index)]);
	for (const [char, standin] of Object.entries(ESCAPE_STANDINS)) {
		out = out.split(standin).join(char);
	}

	return out;
} //end process_inline

/**
 * Paired Markdown emphasis delimiters, longest first so '**' is recognised before '*'.
 * @type {string[]}
 */
const MD_DELIMITERS = ['**', '__', '*'];

/**
 * DELIMITER_POSITIONS
 * Every emphasis delimiter in a string, in order, longest first so '**' is never read as two
 * '*'. Backslash-escaped characters are skipped: a literal asterisk travels as '\*'. (v6)
 * @param {string} text
 * @returns {Array<{delim:string, index:number}>}
 */
const delimiter_positions = (text) => {
	const found = [];
	if (!text) {
		return found;
	}

	for (let i = 0; i < text.length; i++) {
		if (text[i] === '\\') {
			i++;
			continue;
		}

		const delim = MD_DELIMITERS.find((item) => text.startsWith(item, i));
		if (!delim) {
			continue;
		}

		found.push({ delim, index: i });
		i += delim.length - 1;
	}

	return found;
}; //end delimiter_positions

/**
 * CONFORM_EMPHASIS
 * Forbid the model from inventing emphasis the source never had. (v6 92da452aa1)
 *
 * Translating text does not create formatting, yet a small model scatters ** and __ through
 * its answer. The translation may not use more of a delimiter than the source segment did:
 * excess delimiters are deleted (the text is never touched, only the markers) and the
 * surviving count is floored to an even number, since delimiters come in pairs.
 *
 * @param {string} source_text - The segment as sent to the model.
 * @param {string} output_text - The model's translation of it.
 * @returns {string}
 */
export function conform_emphasis(source_text, output_text) {
	if (!output_text) {
		return output_text;
	}

	const allowed = {};
	for (const item of delimiter_positions(source_text)) {
		allowed[item.delim] = (allowed[item.delim] || 0) + 1;
	}

	const positions = delimiter_positions(output_text);

	const totals = {};
	for (const item of positions) {
		totals[item.delim] = (totals[item.delim] || 0) + 1;
	}

	// how many of each we are willing to keep — capped at the source, and even
	const keep = {};
	for (const delim of MD_DELIMITERS) {
		const count = Math.min(totals[delim] || 0, allowed[delim] || 0);
		keep[delim] = count - (count % 2);
	}

	const seen = {};
	const discard = new Map();
	for (const item of positions) {
		seen[item.delim] = (seen[item.delim] || 0) + 1;
		if (seen[item.delim] > keep[item.delim]) {
			discard.set(item.index, item.delim.length);
		}
	}

	if (discard.size === 0) {
		return output_text;
	}

	let out = '';
	let i = 0;
	while (i < output_text.length) {
		if (discard.has(i)) {
			i += discard.get(i);
			continue;
		}
		out += output_text[i];
		i++;
	}

	return out;
} //end conform_emphasis

/**
 * WHOLLY_WRAPPED_DELIMITER
 * If a string is one emphasis span and nothing else (`**…**`, `*…*`, `__…__`), return that
 * delimiter, else null. (v6)
 * @param {string} text
 * @returns {string|null}
 */
const wholly_wrapped_delimiter = (text) => {
	const trimmed = (text || '').trim();
	if (!trimmed) {
		return null;
	}

	const positions = delimiter_positions(trimmed);

	for (const delim of MD_DELIMITERS) {
		const of_kind = positions.filter((item) => item.delim === delim);
		if (of_kind.length !== 2) {
			continue;
		}
		if (of_kind[0].index === 0 && of_kind[1].index === trimmed.length - delim.length) {
			return delim;
		}
	}

	return null;
}; //end wholly_wrapped_delimiter

/**
 * RESTORE_WRAPPING_EMPHASIS
 * Put back emphasis that wrapped a WHOLE segment when the model dropped it. (v6)
 *
 * Only the whole-segment case: partial emphasis cannot be restored without guessing which
 * translated words carried it, and is left lost (browser_translation.js reports it as
 * emphasis_lost). Runs after conform_emphasis; an output that kept any of that delimiter is
 * left alone.
 * @param {string} source_text - The segment as sent to the model.
 * @param {string} output_text - The model's translation, already conformed.
 * @returns {string}
 */
export function restore_wrapping_emphasis(source_text, output_text) {
	if (!output_text) {
		return output_text;
	}

	const delim = wholly_wrapped_delimiter(source_text);
	if (!delim) {
		return output_text;
	}

	if (delimiter_positions(output_text).some((item) => item.delim === delim)) {
		return output_text;
	}

	const leading = output_text.match(/^\s*/)[0];
	const trailing = output_text.match(/\s*$/)[0];
	const core = output_text.slice(leading.length, output_text.length - trailing.length);
	if (!core) {
		return output_text;
	}

	return `${leading}${delim}${core}${delim}${trailing}`;
} //end restore_wrapping_emphasis

/**
 * SPLIT_MARKDOWN_BY_PARAGRAPH
 * Split Markdown on blank lines into trimmed, non-empty blocks. Lossy (the separators are
 * discarded), so it is NOT what segment_markdown uses.
 * @param {string} md
 * @returns {string[]}
 */
export function split_markdown_by_paragraph(md) {
	if (!md) {
		return [];
	}

	return md
		.split(/\n{2,}/)
		.map((block) => block.trim())
		.filter((block) => block.length > 0);
} //end split_markdown_by_paragraph

/**
 * Absolute ceiling for one segment. A single sentence is never split below this — an intact
 * 400-character sentence is a far better input than two fragments. Past it, the sentence is
 * pathological and is cut at a word boundary. (v6)
 * @type {number}
 */
const HARD_MAX_CHARS = 800;

/**
 * SEGMENT_PROTECTED_RANGES
 * Spans a segment cut may never fall inside: Markdown links (their dots read as sentence
 * ends), inline code, fenced code, and GFM tables (a table cut in half stops being one). (v6)
 * @param {string} md
 * @returns {Array<[number, number]>} [start, end) ranges, unsorted.
 */
const segment_protected_ranges = (md) => {
	const ranges = [];
	const patterns = [/\[[^[\]]*\]\([^)\s]*\)/g, /`[^`\n]*`/g, /```[\s\S]*?```/g];

	for (const pattern of patterns) {
		for (const match of md.matchAll(pattern)) {
			ranges.push([match.index, match.index + match[0].length]);
		}
	}

	// GFM tables: a run of consecutive lines that all start with '|'
	let offset = 0;
	let run = null;
	for (const line of md.split('\n')) {
		if (/^\s*\|/.test(line)) {
			if (run === null) {
				run = offset;
			}
		} else if (run !== null) {
			ranges.push([run, offset]);
			run = null;
		}
		offset += line.length + 1;
	}
	if (run !== null) {
		ranges.push([run, md.length]);
	}

	return ranges;
}; //end segment_protected_ranges

/**
 * IN_PROTECTED
 * @param {Array<[number,number]>} ranges
 * @param {number} offset
 * @returns {boolean} offset strictly inside a protected range
 */
const in_protected = (ranges, offset) => ranges.some(([start, end]) => offset > start && offset < end);

/**
 * SENTENCE_CUTS
 * Offsets at which a new sentence begins. (v6)
 *
 * A boundary REJECTER: a false boundary hands the model a subject-less fragment, while a
 * missed one only makes a segment longer. A '.' is not a sentence end when it sits in a
 * protected span, follows a single-letter token (an initial, 'a.C.', 'p. 400'), separates
 * two digits, is not followed by whitespace, or the next word starts lower-case.
 * @param {string} md
 * @param {Array<[number,number]>} ranges
 * @returns {number[]}
 */
const sentence_cuts = (md, ranges) => {
	const cuts = [];

	for (const match of md.matchAll(/[.!?…]+/g)) {
		const terminator_start = match.index;
		const terminator_end = match.index + match[0].length;

		if (in_protected(ranges, terminator_start)) {
			continue;
		}
		if (terminator_end >= md.length || !/\s/.test(md[terminator_end])) {
			continue;
		}

		const before = md.slice(0, terminator_start);

		const last_token = before.match(/(\S+)$/);
		if (last_token && last_token[1].length === 1 && !/\d/.test(last_token[1])) {
			continue;
		}

		if (match[0] === '.' && /\d$/.test(before) && /^\d/.test(md.slice(terminator_end))) {
			continue;
		}

		let next = terminator_end;
		while (next < md.length && /\s/.test(md[next])) {
			next++;
		}
		if (next >= md.length || in_protected(ranges, next)) {
			continue;
		}

		// scripts without case fall through as 'not lower-case', the permissive answer
		if (/\p{Ll}/u.test(md[next])) {
			continue;
		}

		cuts.push(terminator_end);
	}

	return cuts;
}; //end sentence_cuts

/**
 * STRUCTURAL_BOUNDARIES
 * Offsets of paragraph and line breaks — MANDATORY cuts (v6): a '\n' left inside a segment
 * is a break the model has to reproduce, and it does not reliably do so (a <br> came back as
 * a <p>). Cut there, the break becomes the next segment's `sep` and is carried verbatim.
 * Newlines inside a protected range (a table, fenced code) are part of it and skipped.
 * @param {string} md
 * @param {Array<[number,number]>} ranges
 * @returns {number[]} Ascending; each points at the START of the separator run.
 */
const structural_boundaries = (md, ranges) => {
	const boundaries = new Set();

	for (const match of md.matchAll(/\n{2,}/g)) {
		if (!in_protected(ranges, match.index)) {
			boundaries.add(match.index);
		}
	}

	for (const match of md.matchAll(/\n/g)) {
		if (md[match.index + 1] === '\n' || md[match.index - 1] === '\n') {
			continue;
		}
		if (!in_protected(ranges, match.index)) {
			boundaries.add(match.index);
		}
	}

	return Array.from(boundaries).sort((a, b) => a - b);
}; //end structural_boundaries

/**
 * WORD_CUTS
 * Last-resort cuts inside one unit longer than HARD_MAX_CHARS: word boundaries only, never
 * inside a protected range. (v6)
 * @param {string} md
 * @param {number} from
 * @param {number} to
 * @param {number} max_chars
 * @param {Array<[number,number]>} ranges
 * @returns {number[]}
 */
const word_cuts = (md, from, to, max_chars, ranges) => {
	const cuts = [];
	let start = from;

	for (let i = from; i < to; i++) {
		if (!/\s/.test(md[i]) || in_protected(ranges, i)) {
			continue;
		}
		if (i - start >= max_chars) {
			cuts.push(i);
			start = i;
		}
	}

	return cuts;
}; //end word_cuts

/**
 * SUBDIVIDE
 * Cut one structural unit down to size at sentence boundaries. (v6)
 *
 * Grows greedily, cutting at the last sentence boundary that fits. A single over-long
 * sentence is emitted whole; only past HARD_MAX_CHARS is it cut at a word.
 * @param {string} md
 * @param {number} from
 * @param {number} to
 * @param {number} max_chars
 * @param {number[]} sentences
 * @param {Array<[number,number]>} ranges
 * @returns {number[]} Cuts strictly inside (from, to).
 */
const subdivide = (md, from, to, max_chars, sentences, ranges) => {
	const cuts = [];
	const candidates = sentences.filter((cut) => cut > from && cut < to);
	candidates.push(to);

	let start = from;
	let last_fit = -1;
	let i = 0;

	while (i < candidates.length) {
		const boundary = candidates[i];

		if (boundary <= start) {
			i++;
			continue;
		}

		if (boundary - start <= max_chars) {
			last_fit = boundary;
			i++;
			continue;
		}

		const cut = last_fit > start ? last_fit : boundary;
		if (cut < to) {
			cuts.push(cut);
		}
		start = cut;
		last_fit = -1;

		if (cut === boundary) {
			i++;
		}
	}

	const spans = [from, ...cuts, to];
	const extra = [];
	for (let k = 0; k < spans.length - 1; k++) {
		if (spans[k + 1] - spans[k] > HARD_MAX_CHARS) {
			extra.push(...word_cuts(md, spans[k], spans[k + 1], max_chars, ranges));
		}
	}

	return [...cuts, ...extra].sort((a, b) => a - b);
}; //end subdivide

/**
 * SEGMENT_MARKDOWN
 * Split Markdown into segments the model can translate one at a time, keeping the literal
 * text that separated them. (v6 55c816b41c)
 *
 * `sep` is the text that stood between the previous segment and this one, straight out of
 * the source, so the round-trip is exact by construction:
 *
 *   segments.map(s => s.sep + s.text).join('') === md
 *
 * Every paragraph and line break is a cut; a unit longer than max_chars is cut at the last
 * sentence end that fits (sentence_cuts refuses abbreviations and links); one sentence is
 * never split unless it passes HARD_MAX_CHARS. Small segments are on purpose: a
 * sentence-level model given 1000-character blocks is off-distribution, the dominant cause
 * of the repetition loops seen on long low-resource translations, and at this size nearly
 * every token sits at a segment edge, where it is hoisted out of the model's way.
 *
 * @param {string} md
 * @param {number} [max_chars=250] - Soft upper bound per segment.
 * @returns {Array<{text:string, sep:string}>} `sep` is '' for the first segment.
 */
export function segment_markdown(md, max_chars = 250) {
	if (!md) {
		return [];
	}

	const ranges = segment_protected_ranges(md);
	const structural = structural_boundaries(md, ranges);
	const sentences = sentence_cuts(md, ranges);

	// every structural boundary is a cut, unconditionally
	const units = [];
	let unit_start = 0;
	for (const boundary of structural) {
		units.push([unit_start, boundary]);
		unit_start = boundary;
	}
	units.push([unit_start, md.length]);

	// subdivide any unit that is still too big
	const bounded = [];
	for (const [from, to] of units) {
		bounded.push(from);
		if (to - from > max_chars) {
			bounded.push(...subdivide(md, from, to, max_chars, sentences, ranges));
		}
	}

	// slice, putting each separator run into the FOLLOWING segment
	const segments = [];
	for (let k = 0; k < bounded.length; k++) {
		const from = bounded[k];
		const to = k + 1 < bounded.length ? bounded[k + 1] : md.length;
		if (from >= to) {
			continue;
		}

		let content = from;
		while (content < to && /\s/.test(md[content])) {
			content++;
		}

		segments.push({ sep: md.slice(from, content), text: md.slice(content, to) });
	}

	return segments;
} //end segment_markdown

/**
 * MARKS_IN_TEXT_NODES
 * Every match of the given mark extractor that lies inside a single TEXT node of the
 * parsed HTML. A mark that ended up inside a tag (an attribute, a tag name) is not text —
 * the editor would never show it, and saving it would corrupt the tag — so the caller
 * compares this against the source and refuses a result that has fewer (A1-02 review).
 * @param {string} html
 * @param {Function} extract - (text) => Array<{mark:string}>
 * @returns {string[]}
 */
export const marks_in_text_nodes = (html, extract) => {
	const doc = new DOMParser().parseFromString(html, 'text/html');
	const walker = doc.createTreeWalker(doc.body, 4); // NodeFilter.SHOW_TEXT
	const found = [];
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		for (const item of extract(node.textContent)) {
			found.push(item.mark);
		}
	}
	return found;
}; //end marks_in_text_nodes

// @license-end
