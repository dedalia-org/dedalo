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
 * them. <pre> (code) is one atom and is not translated; so is every HTML comment, and every
 * element with nothing to translate (a '<p> </p>' spacer, an empty cell: no text but
 * whitespace and NBSP), restored as written.
 *
 * A <p> or a <strong>/<b>/<em>/<i>/<u>/<code> (MD_INLINE_TAGS) is shielded instead of
 * written as Markdown wherever Markdown would not read back the same markup: an attribute,
 * edge whitespace, a block inside it (a <strong> wrapping a <p>), nested or adjacent
 * emphasis, emphasis inside <code>, a <br> or another <code> inside <code>. <b>/<i> stay
 * <b>/<i>: emphasis_tags_of picks the family name the record uses most, markdown_to_html
 * writes that name back, and the other name is shielded. The inline/block split is the HTML
 * phrasing-content set (PHRASING_CONTENT_TAGS) plus the obsolete phrasing tags old records
 * carry (LEGACY_INLINE_TAGS); an unknown plain tag name is a block.
 *
 * WHITESPACE IS KEPT EXACTLY. Whitespace-only text with an inline element or text on both
 * sides is a WORD space and travels as text does ('<strong>Roma</strong> <em>antigua</em>'
 * never welds); every other whitespace-only text — indentation, the newline between two
 * blocks, a space at the edge of a run — is an atom restored byte for byte. Inside text a
 * newline run is one space (a model returns prose, not line layout): that, and the
 * serialiser's normal form, is the whole difference an identity model leaves
 * (test/unit/tool_lang_identity_roundtrip.test.ts — N∘W). NBSP is a character, decoded from
 * &nbsp; before conversion: the model sees it, nothing adds or drops one. Loose top-level
 * text and inline elements are bracketed by two empty block tokens, so a cut can isolate
 * them and nothing wraps them in a <p>. Private-use characters U+E000–E008 of the TEXT (epigraphic
 * fonts) are escaped around this module's own stand-ins (escape_pua/unescape_pua), never
 * deleted. segment_markdown cuts at every block-token edge (block_token_cuts), so each list
 * item / paragraph of a shielded container is its own segment, free of structural tokens
 * once the edges are hoisted; long text inside one is still cut a few sentences at a time.
 * v6 sent these elements to the model as raw
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
 * PHRASING CONTENT (WHATWG HTML §3.2.5.2.5): every element the standard allows inside a
 * paragraph — the INLINE elements. Shielded, their start and end tags are a pair of tokens
 * inside the running text; shielded as a block, they would split the paragraph and drop the
 * word spaces around them. The list is the standard's, complete (A1-02 re-review: strike,
 * big, tt… were missing, so a paragraph split at each of them); `area`, `link`, `meta` are
 * phrasing in context and listed. Autonomous custom elements (a '-' in the name) are
 * phrasing too: see is_inline_tag.
 * @type {Set<string>}
 */
export const PHRASING_CONTENT_TAGS = new Set([
	'a',
	'abbr',
	'area',
	'audio',
	'b',
	'bdi',
	'bdo',
	'br',
	'button',
	'canvas',
	'cite',
	'code',
	'data',
	'datalist',
	'del',
	'dfn',
	'em',
	'embed',
	'i',
	'iframe',
	'img',
	'input',
	'ins',
	'kbd',
	'label',
	'link',
	'map',
	'mark',
	'math',
	'meta',
	'meter',
	'noscript',
	'object',
	'output',
	'picture',
	'progress',
	'q',
	'ruby',
	's',
	'samp',
	'script',
	'select',
	'slot',
	'small',
	'span',
	'strong',
	'sub',
	'sup',
	'svg',
	'template',
	'textarea',
	'time',
	'u',
	'var',
	'video',
	'wbr',
]);

/**
 * Inline elements that are not phrasing content of today's standard but are rendered inline
 * (WHATWG HTML §15 Rendering): the ruby internals, and the obsolete presentational elements
 * (§16) a heritage record written by an older editor still carries.
 * @type {Set<string>}
 */
export const LEGACY_INLINE_TAGS = new Set([
	'rb',
	'rp',
	'rt',
	'rtc',
	'acronym',
	'big',
	'blink',
	'font',
	'marquee',
	'nobr',
	'strike',
	'tt',
]);

/**
 * IS_INLINE_TAG
 * Phrasing content, a legacy inline element, an autonomous custom element ('-' in the name,
 * phrasing per the standard) or a namespaced name ('o:p' — what a word processor pastes; the
 * HTML parser makes it an unknown element, which every browser renders inline). A plain
 * unknown name is not phrasing content and stays block-level.
 * @param {string} tag - lower-case tag name
 * @returns {boolean}
 */
export const is_inline_tag = (tag) =>
	PHRASING_CONTENT_TAGS.has(tag) || LEGACY_INLINE_TAGS.has(tag) || tag.includes('-') || tag.includes(':');

/**
 * IS_BLOCK_TAG
 * Is a shielded element block-level? Everything that is not inline (is_inline_tag) and not
 * an inline void element; <hr> is a block.
 * @param {string} tag - lower-case tag name
 * @returns {boolean}
 */
export const is_block_tag = (tag) => BLOCK_VOID_TAGS.has(tag) || (!VOID_TAGS.has(tag) && !is_inline_tag(tag));

/**
 * The elements html_to_markdown writes as Markdown inline syntax even inside a shielded
 * element (emphasis and code survive the trip as Markdown; everything else in there is
 * shielded, so a shielded element's content is one line of text and tokens).
 * @type {Set<string>}
 */
const MD_INLINE_TAGS = new Set(['strong', 'b', 'em', 'i', 'u', 'code']);

/**
 * The emphasis elements: written as Markdown (** * __) — except inside <code>, where
 * Markdown is not read (a code span is literal) and they are shielded instead.
 * @type {Set<string>}
 */
const MD_EMPHASIS_TAGS = new Set(['strong', 'b', 'em', 'i', 'u']);

/**
 * Elements whose content model admits NO text: a whitespace-only text node directly inside
 * one is layout (the browser would even move it out of a <tr>), never a word space.
 * @type {Set<string>}
 */
const NO_TEXT_PARENTS = new Set(['ul', 'ol', 'menu', 'dl', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'colgroup']);

/**
 * The Markdown delimiter of each emphasis tag family.
 * @type {Object<string,string>}
 */
const EMPHASIS_DELIMITER = { strong: '**', b: '**', em: '*', i: '*', u: '__' };

/** The tags '**' and '*' are written as when nothing says otherwise. */
const DEFAULT_EMPHASIS_TAGS = Object.freeze({ bold: 'strong', italic: 'em' });

/**
 * EMPHASIS_TAGS_OF
 * Which tag of each family a document uses MOST ('<b>' or '<strong>' for '**', '<i>' or
 * '<em>' for '*'; a tie keeps strong/em). Markdown has one bold and one italic, and the
 * translation must give back the source's own tag names (A1-02 re-review: '<b>' came back
 * '<strong>', CKEditor's '<i>' came back '<em>'): the majority name travels as Markdown and
 * markdown_to_html writes it back with that name; the other name, if the document also
 * has it, is shielded.
 * @param {string} html
 * @returns {{bold:string, italic:string}}
 */
export const emphasis_tags_of = (html) => {
	const counts = { strong: 0, b: 0, em: 0, i: 0 };
	const visit = (node) => {
		if (node.nodeType !== 1) {
			return;
		}
		const tag = node.tagName.toLowerCase();
		if (Object.hasOwn(counts, tag)) {
			counts[tag]++;
		}
		for (const child of Array.from(node.childNodes)) {
			visit(child);
		}
	};
	visit(new DOMParser().parseFromString(String(html), 'text/html').body);
	return {
		bold: counts.b > counts.strong ? 'b' : 'strong',
		italic: counts.i > counts.em ? 'i' : 'em',
	};
}; //end emphasis_tags_of

/**
 * IS_BLOCK_ELEMENT
 * Is a DOM node a block-level element (a paragraph, a shielded block)? Emphasis, code,
 * inline shielded tags and inline void elements are not.
 * @param {Node|null} node
 * @returns {boolean}
 */
const is_block_element = (node) => {
	if (!node || node.nodeType !== 1) {
		return false;
	}
	const tag = node.tagName.toLowerCase();
	return !MD_INLINE_TAGS.has(tag) && is_block_tag(tag);
};

/** ASCII whitespace only (U+00A0 is content). */
const ASCII_WHITESPACE_ONLY_RE = /^[ \t\n\r\f]*$/;

/**
 * IS_SKIPPED_NEIGHBOUR
 * A comment or a whitespace-only text node: neither makes its neighbour inline or block.
 * @param {Node} node
 * @returns {boolean}
 */
const is_skipped_neighbour = (node) =>
	node.nodeType === 8 || (node.nodeType === 3 && ASCII_WHITESPACE_ONLY_RE.test(node.textContent));

/**
 * ELEMENT_NEIGHBOUR
 * The nearest sibling of a node in one direction, skipping comments and whitespace-only text.
 * @param {Node} node
 * @param {'previousSibling'|'nextSibling'} direction
 * @returns {Node|null}
 */
const element_neighbour = (node, direction) => {
	let sibling = node[direction];
	while (sibling && is_skipped_neighbour(sibling)) {
		sibling = sibling[direction];
	}
	return sibling;
};

/**
 * IN_BLOCK_CONTEXT
 * Does a whitespace-only text node or a comment stand BETWEEN BLOCKS (A1-02 re-review):
 * directly inside an element that admits no text (NO_TEXT_PARENTS), or with only
 * block-level siblings (and the edges of its parent) on both sides? Such whitespace is
 * LAYOUT, never a word space, and such a comment belongs to no paragraph. Whitespace between
 * two inline elements ('<strong>Roma</strong> <em>antigua</em>') is a word space.
 * @param {Node} node - a text node or a comment
 * @returns {boolean}
 */
const in_block_context = (node) => {
	const parent = node.parentElement;
	if (parent && NO_TEXT_PARENTS.has(parent.tagName.toLowerCase())) {
		return true;
	}
	const previous = element_neighbour(node, 'previousSibling');
	const next = element_neighbour(node, 'nextSibling');
	if (!previous && !next) {
		return false;
	}
	return (!previous || is_block_element(previous)) && (!next || is_block_element(next));
};

/**
 * IS_WORD_SPACE
 * Is a whitespace-only text node a WORD space — an inline sibling on BOTH sides
 * ('<strong>Roma</strong> <em>antigua</em>')? It belongs to the text and travels as text
 * does (a newline run is one space; anything else as written). Whitespace with a block, or nothing, on one side is not between words: it is
 * restored exactly and never sent (layout between blocks — in_block_context — or the edge of
 * a run of text: '<li>\n  <strong>a</strong>\n</li>').
 * @param {Node} node - a whitespace-only text node
 * @returns {boolean}
 */
const is_word_space = (node) => {
	const parent = node.parentElement;
	if (parent && NO_TEXT_PARENTS.has(parent.tagName.toLowerCase())) {
		return false;
	}
	const previous = element_neighbour(node, 'previousSibling');
	const next = element_neighbour(node, 'nextSibling');
	return Boolean(previous && next && !is_block_element(previous) && !is_block_element(next));
};

/**
 * HAS_TRANSLATABLE_TEXT
 * Does an element carry any text a model could translate? Whitespace — U+00A0 included, the
 * editor's spacer — and markup are not text; a [[[n]]] token (a Dédalo mark) is.
 * @param {Element} node
 * @returns {boolean}
 */
const has_translatable_text = (node) => /\S/.test(node.textContent);

/**
 * EDGE_LEAF
 * The first or last leaf of an element, descending through first/last children.
 * @param {Node} node
 * @param {'first'|'last'} side
 * @returns {Node|null}
 */
const edge_leaf = (node, side) => {
	let current = node;
	for (;;) {
		const children = Array.from(current.childNodes);
		if (children.length === 0) {
			return current === node ? null : current;
		}
		current = side === 'first' ? children[0] : children[children.length - 1];
		if (current.nodeType !== 1 || VOID_TAGS.has(current.tagName.toLowerCase())) {
			return current;
		}
	}
};

/**
 * HAS_EDGE_SPACE
 * Does an element's content begin or end with whitespace (U+00A0 included) or a <br>? A
 * Markdown paragraph or emphasis run is trimmed at both ends, so such an element cannot
 * travel as Markdown without losing them.
 * @param {Element} node
 * @returns {boolean}
 */
const has_edge_space = (node) => {
	if (/^\s|\s$/.test(node.textContent)) {
		return true;
	}
	return ['first', 'last'].some((side) => {
		const leaf = edge_leaf(node, side);
		return leaf !== null && leaf.nodeType === 1 && leaf.tagName.toLowerCase() === 'br';
	});
};

/**
 * HAS_DESCENDANT_TAG
 * @param {Element} node
 * @param {string} tag - lower-case tag name
 * @returns {boolean}
 */
const has_descendant_tag = (node, tag) =>
	Array.from(node.childNodes).some(
		(child) => child.nodeType === 1 && (child.tagName.toLowerCase() === tag || has_descendant_tag(child, tag)),
	);

/**
 * HAS_BLOCK_DESCENDANT
 * Does an element contain a block-level element? Emphasis wrapping blocks
 * ('<em><p>A.</p><p>B.</p></em>') cannot be Markdown emphasis, which never spans blocks.
 * @param {Element} node
 * @returns {boolean}
 */
const has_block_descendant = (node) =>
	Array.from(node.childNodes).some(
		(child) => child.nodeType === 1 && (is_block_element(child) || has_block_descendant(child)),
	);


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

/**
 * The escape character of the stand-in range. A character of the text in U+E000–U+E008
 * (private use: real in epigraphic fonts — a heritage text may carry them) is NEVER deleted
 * (A1-02 re-review): markdown_to_html escapes it as U+E008 + a letter before any stand-in is
 * made and restores it at the end, so no text character can be read as a stand-in and none
 * is lost.
 */
const PUA_ESCAPE = '\uE008';
const PUA_RE = /[\uE000-\uE008]/g;
const PUA_ESCAPED_RE = /\uE008([a-i])/g;

/**
 * ESCAPE_PUA / UNESCAPE_PUA
 * @param {string} text
 * @returns {string}
 */
const escape_pua = (text) =>
	text.replace(PUA_RE, (char) => PUA_ESCAPE + String.fromCharCode(0x61 + char.charCodeAt(0) - 0xe000));
const unescape_pua = (text) =>
	text.replace(PUA_ESCAPED_RE, (_match, letter) => String.fromCharCode(0xe000 + letter.charCodeAt(0) - 0x61));

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
 *   tables, <div> included — as tokens from options.shield; <pre> as one atom. Also shielded
 *   (A1-02 re-reviews), because Markdown cannot carry them exactly:
 *     - a <p> or <strong>/<em>/<u>/<code>… with ATTRIBUTES, or whose content begins or ends
 *       with whitespace or a <br> (a Markdown paragraph or emphasis run is trimmed);
 *     - emphasis INSIDE <code> (Markdown is not read there: '**x**' would be saved literally);
 *     - emphasis WRAPPING a block ('<em><p>A.</p><p>B.</p></em>'), as an inline pair:
 *       Markdown emphasis never spans blocks;
 *     - emphasis Markdown would read back as other markup (is_markdown_emphasis: the other
 *       tag name of the family, nested or adjacent emphasis), code holding a <br> (a code
 *       span never spans a line) or another code.
 *   A <br> right after another <br> is an atom ('\n\n' would be a paragraph break).
 *   An element with NO translatable text (has_translatable_text: '<p> </p>', '<p>&nbsp;</p>',
 *   '<li></li>', '<td>\n</td>', '<p><br></p>') is ONE atom, restored exactly as the source.
 *   A comment is an atom too.
 *
 * Whitespace-only text: a WORD space (is_word_space — inline siblings on both sides) is ONE
 * space, so '<strong>Roma</strong> <em>antigua</em>' keeps it; any other — LAYOUT between
 * blocks (in_block_context: inside a <ul>/<tr>…, or between block siblings) or the edge of a
 * run of text — is an atom, restored exactly and never sent.
 *
 * Loose top-level text (no <p> around it: 'texto<br>más' — legacy records) is bracketed by
 * a pair of EMPTY block tokens, so markdown_to_html gives it no <p> it never had.
 *
 * <br> is a single '\n' (v6 55c816b41c): '\n\n' is a paragraph boundary, the strongest cut
 * of segment_markdown, and emitting it cut any inline element containing a <br> in half.
 *
 * Text nodes: Markdown metacharacters (\ * _ `) are backslash-escaped so literal characters
 * survive; [ and ] are not (v6: escaping them made the model reproduce the backslashes). A
 * raw newline inside a text node is whitespace in HTML, so it travels as a space — left as
 * '\n' it would come back as a <br>.
 *
 * @param {string} html - HTML with Dédalo marks already replaced by [[[n]]] tokens.
 * @param {Object} [options]
 * @param {{bold:string, italic:string}} [options.emphasis_tags] - the tag names '**' and '*'
 *   stand for (emphasis_tags_of; default strong/em); the other name is shielded.
 * @param {Function} [options.shield] - ({html, kind, block, pair}) => token. Called for
 *   each start tag (kind 'open'), end tag ('close', pair = the open's token) and void or
 *   raw element, comment, layout whitespace or text-less element ('atom'); `block` is true
 *   for a block-level one. Without it, anything that needs shielding THROWS — it cannot be
 *   represented in Markdown, and it must never travel to the model as markup.
 * @returns {string} Markdown, trimmed, runs of 3+ newlines collapsed to 2.
 */
export function html_to_markdown(html, options = {}) {
	const shield = options.shield;
	const emphasis_tags = options.emphasis_tags || DEFAULT_EMPHASIS_TAGS;

	const parser = new DOMParser();
	const doc = parser.parseFromString(html, 'text/html');

	// Regex to detect [[[n]]] placeholder strings — never escaped
	const token_re = /^\[\[\[\d+\]\]\]$/;

	// how many shielded elements enclose the node being walked. Inside one, every element
	// without a Markdown inline form is shielded too — a <p> or <br> inside a merged-cell
	// table converted to '\n\n' / '\n' would split the table's tokens across Markdown
	// blocks. Only an outermost block-level shield is set apart as its own block.
	let shield_depth = 0;

	// how many <code> elements enclose the node being walked (emphasis in there is shielded)
	let code_depth = 0;

	// the Markdown emphasis delimiters open around the node being walked
	const open_delimiters = [];

	/**
	 * IS_MARKDOWN_EMPHASIS (inner)
	 * Can an emphasis element travel as Markdown and come back as exactly itself? Not when
	 * (A1-02 re-review — each one came back as different markup):
	 *   - its name is not the one the document's Markdown stands for ('<b>' in a '<strong>'
	 *     document: emphasis_tags_of);
	 *   - the same delimiter is already open around it ('<u>a<u>b</u></u>' → '__a__b____');
	 *   - it touches another emphasis element: directly after one ('<em>c</em><em>d</em>' →
	 *     '*c**d*', read as bold), or with one as its first or last child
	 *     ('<em><strong>a</strong></em>' → '***a***', read back strong-outside).
	 * (A run cut at a <br> or a sentence comes back whole: run_blocks strips the delimiters
	 * balancing added where the two halves meet.)
	 * @param {Element} node
	 * @param {string} tag
	 * @returns {boolean}
	 */
	const is_markdown_emphasis = (node, tag) => {
		if ((tag === 'strong' || tag === 'b') && tag !== emphasis_tags.bold) {
			return false;
		}
		if ((tag === 'em' || tag === 'i') && tag !== emphasis_tags.italic) {
			return false;
		}
		if (open_delimiters.includes(EMPHASIS_DELIMITER[tag])) {
			return false;
		}
		const is_emphasis = (other) => other?.nodeType === 1 && MD_EMPHASIS_TAGS.has(other.tagName.toLowerCase());
		const children = Array.from(node.childNodes);
		return !(
			is_emphasis(node.previousSibling) ||
			is_emphasis(children[0]) ||
			is_emphasis(children[children.length - 1])
		);
	};

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
	 * ATOM (inner)
	 * One atom token for markup restored as it was; a block one outside every shielded
	 * element is set apart as its own Markdown block.
	 * @param {string} markup
	 * @param {boolean} block
	 * @returns {string}
	 */
	const atom = (markup, block) => {
		const token = call_shield({ html: markup, kind: 'atom', block, pair: null });
		return block && shield_depth === 0 ? `\n\n${token}\n\n` : token;
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

		if (RAW_ATOM_TAGS.has(tag) || VOID_TAGS.has(tag)) {
			return atom(node.outerHTML, block);
		}

		const set_apart = block && shield_depth === 0;

		const open = call_shield({ html: start_tag(node), kind: 'open', block, pair: null });

		shield_depth++;
		const inner = walk_children(node);
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
			if (ASCII_WHITESPACE_ONLY_RE.test(text)) {
				// a word space is text: it travels under the rule of all text (a newline run is one
				// space); any other whitespace (layout between blocks, the edge of a run of text)
				// is kept exactly, out of the model's reach
				if (is_word_space(node)) {
					return text.replace(/[ \t]*[\r\n]+[ \t]*/g, ' ');
				}
				return atom(text, in_block_context(node));
			}
			return escape_md(text.replace(/[ \t]*[\r\n]+[ \t]*/g, ' '));
		}

		if (node.nodeType === 8) {
			// a comment is restored where it stood, never sent
			return atom(`<!--${node.textContent}-->`, in_block_context(node));
		}

		if (node.nodeType !== 1) {
			return '';
		}

		const tag = node.tagName.toLowerCase();

		if (tag === 'br' && shield_depth === 0) {
			// a <br> right after another is an atom: two '\n' would be a paragraph break, and
			// '<br><br>' came back as a new <p> (A1-02 re-review)
			const previous = node.previousSibling;
			if (previous?.nodeType === 1 && previous.tagName.toLowerCase() === 'br') {
				return atom(node.outerHTML, false);
			}
			return '\n';
		}

		// code inside code: one code span cannot hold another ('``x``')
		if (tag === 'code' && code_depth > 0) {
			return shield_element(node, false);
		}

		// nothing to translate (a spacer, an empty cell, an image paragraph): ONE atom,
		// restored exactly — never a synthetic &nbsp;, never dropped
		if (!VOID_TAGS.has(tag) && !RAW_ATOM_TAGS.has(tag) && !has_translatable_text(node)) {
			return atom(node.outerHTML, is_block_element(node));
		}

		if (MD_INLINE_TAGS.has(tag) || tag === 'p') {
			const block = tag === 'p';
			// what Markdown cannot carry: attributes, edge whitespace or <br>, emphasis inside
			// code, emphasis wrapping blocks, emphasis Markdown would read back as other
			// markup (A1-02 re-reviews)
			if (
				node.attributes.length > 0 ||
				has_edge_space(node) ||
				(MD_EMPHASIS_TAGS.has(tag) && (code_depth > 0 || !is_markdown_emphasis(node, tag))) ||
				(tag === 'code' && has_descendant_tag(node, 'br')) ||
				(!block && has_block_descendant(node))
			) {
				return shield_element(node, block);
			}
		}

		if (shield_depth > 0 && !MD_INLINE_TAGS.has(tag)) {
			return shield_element(node, is_block_tag(tag));
		}

		switch (tag) {
			case 'p':
				return `\n\n${walk_children(node)}\n\n`;

			case 'strong':
			case 'b':
			case 'em':
			case 'i':
			case 'u': {
				const delimiter = EMPHASIS_DELIMITER[tag];
				open_delimiters.push(delimiter);
				const inner = walk_children(node);
				open_delimiters.pop();
				return `${delimiter}${inner}${delimiter}`;
			}

			case 'code': {
				code_depth++;
				const inner = walk_children(node);
				code_depth--;
				return `\`${inner}\``;
			}

			default:
				// no Markdown equivalent: shielded (block-level unless it is inline — see
				// is_inline_tag — so a block's content cannot weld onto a paragraph)
				return shield_element(node, is_block_tag(tag));
		}
	};

	/**
	 * WALK_CHILDREN (inner)
	 * @param {Node} node
	 * @returns {string}
	 */
	const walk_children = (node) => Array.from(node.childNodes).map(walk).join('');

	/**
	 * IS_IN_LOOSE_RUN (inner)
	 * Does a top-level node belong to a run of loose inline content (text outside any <p>)?
	 * Block elements, layout whitespace and comments between blocks are set apart instead.
	 * @param {Node} node
	 * @returns {boolean}
	 */
	const is_in_loose_run = (node) => {
		if (node.nodeType === 1) {
			return !is_block_element(node);
		}
		if (node.nodeType === 8) {
			return !in_block_context(node);
		}
		if (node.nodeType === 3) {
			return !(ASCII_WHITESPACE_ONLY_RE.test(node.textContent) && in_block_context(node));
		}
		return false;
	};

	// top level: each run of loose inline content is bracketed by a pair of EMPTY block
	// tokens, so it comes back without a <p> it never had
	const parts = [];
	let run = [];
	const flush_run = () => {
		if (run.length === 0) {
			return;
		}
		const nodes = run;
		run = [];
		const text = nodes.map(walk).join('');
		// only whitespace text: nothing to bracket (a <br> alone is something — '\n')
		if (nodes.every((node) => node.nodeType === 3) && ascii_trim(text) === '') {
			parts.push(text);
			return;
		}
		const open = call_shield({ html: '', kind: 'open', block: true, pair: null });
		const close = call_shield({ html: '', kind: 'close', block: true, pair: open });
		parts.push(`\n\n${open}${text}${close}\n\n`);
	};
	for (const node of Array.from(doc.body.childNodes)) {
		if (is_in_loose_run(node)) {
			run.push(node);
			continue;
		}
		flush_run();
		parts.push(walk(node));
	}
	flush_run();

	return ascii_trim(parts.join('')).replace(/\n{3,}/g, '\n\n');
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
 * A '<p>' in the text is TEXT (escaped): the wrapper a model adds around its answer is
 * stripped per block, where the segment it translated is known (block_runner.js
 * clean_output) — stripped here, a source's own literal '<p>texto</p>' was lost.
 *
 * @param {string} md - Markdown from the model.
 * @param {Object} [options]
 * @param {Set<string>} [options.block_tokens] - tokens that stand for a block-level tag.
 * @param {{bold:string, italic:string}} [options.emphasis_tags] - the tag names '**' and '*'
 *   are written as (emphasis_tags_of the source; default strong/em).
 * @returns {string} HTML ('' for falsy input).
 */
export function markdown_to_html(md, options = {}) {
	if (!md) {
		return '';
	}

	const block_tokens = options.block_tokens || new Set();
	const emphasis_tags = options.emphasis_tags || DEFAULT_EMPHASIS_TAGS;
	const starts_with_block_token = (block) => {
		const first = block.match(/^\[\[\[\d+\]\]\]/);
		return first !== null && block_tokens.has(first[0]);
	};

	// a text character in the stand-in range is ESCAPED (never deleted, never read as ours)
	// and restored after every stand-in is gone
	const raw_blocks = ascii_trim(escape_pua(String(md))).split(/\n{2,}/);

	const html_blocks = [];

	for (const raw_block of raw_blocks) {
		const block = ascii_trim(raw_block);
		if (!block) {
			continue;
		}

		const lines = block.split('\n');

		// The lines are joined BEFORE process_inline (v6 55c816b41c): run per line, the
		// inline rules (which exclude newlines) could never match emphasis spanning a <br>.
		const inline_html = with_line_breaks(process_inline(lines.join(LINE_BREAK_STANDIN), emphasis_tags));

		// a shielded block element: its own tags are its structure
		if (starts_with_block_token(block)) {
			html_blocks.push(inline_html);
			continue;
		}

		html_blocks.push(`<p>${inline_html}</p>`);
	}

	return unescape_pua(html_blocks.join(''));
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
function process_inline(text, emphasis_tags = DEFAULT_EMPHASIS_TAGS) {
	if (!text) {
		return '';
	}

	const B = emphasis_tags.bold;
	const I = emphasis_tags.italic;

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
	out = out.replace(/\*\*\*([^*\n]+)\*\*\*/g, `<${B}><${I}>$1</${I}></${B}>`);
	out = out.replace(/\*\*([^*\n]*)\*([^*\n]+)\*\*\*/g, `<${B}>$1<${I}>$2</${I}></${B}>`);
	out = out.replace(/\*\*\*([^*\n]+)\*([^*\n]*)\*\*/g, `<${B}><${I}>$1</${I}>$2</${B}>`);

	// 5. bold
	out = out.replace(/\*\*((?:[^*\n]|\*(?!\*))+)\*\*/g, `<${B}>$1</${B}>`);

	// 6. italic
	out = out.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, `<${I}>$1</${I}>`);

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
 * Spans a segment cut may never fall inside: bracketed link-shaped text (its dots read as
 * sentence ends) and inline code. (v6) No fenced code or GFM table: neither is Markdown
 * syntax here any more (A1-02 re-review — <pre> and <table> are shielded), so '|' and '```'
 * are text and are cut like any other.
 * @param {string} md
 * @returns {Array<[number, number]>} [start, end) ranges, unsorted.
 */
const segment_protected_ranges = (md) => {
	const ranges = [];
	for (const match of md.matchAll(/\[[^[\]]*\]\([^)\s]*\)/g)) {
		ranges.push([match.index, match.index + match[0].length]);
	}

	// inline code: an UNESCAPED backtick to the next unescaped one on the same line. '\`' is
	// a literal backtick of the text (escape_md) — an apostrophe in 'l`Hospitalet' — and
	// opens nothing (A1-02 re-review: read as a code span, two of them swallowed the block
	// cuts between list items)
	let open_at = -1;
	for (let i = 0; i < md.length; i++) {
		const char = md[i];
		if (char === '\\') {
			i++;
			continue;
		}
		if (char === '\n') {
			open_at = -1;
		} else if (char === '`') {
			if (open_at === -1) {
				open_at = i;
			} else {
				ranges.push([open_at, i + 1]);
				open_at = -1;
			}
		}
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
 * BLOCK_TOKEN_CUTS
 * MANDATORY cuts at the edges of shielded BLOCK tags (A1-02 re-review): before a block
 * start tag (or block atom) unless a block start tag precedes it, and after a block end tag
 * (or block atom) unless a block end tag follows it. So '</li><li>', '</p><p>',
 * '</td><td>', '</h2><ul>' are cuts, and a list item / cell / paragraph of a shielded block
 * is a segment of its own whose structural tokens all sit at its edges — hoisted, so the
 * model sees the item's text and nothing else. Without them a shielded block is ONE line of
 * tokens, cut only at sentence or word boundaries: a 40-item list became 10 segments of 8–10
 * tokens each.
 * @param {string} md
 * @param {Map<string,string>|undefined} block_kinds - block token → 'open'|'close'|'atom'
 * @param {Array<[number,number]>} ranges
 * @returns {number[]} Offsets (the start of the separator run, like structural_boundaries).
 */
const block_token_cuts = (md, block_kinds, ranges) => {
	const cuts = [];
	if (!block_kinds || block_kinds.size === 0) {
		return cuts;
	}

	const tokens = Array.from(md.matchAll(/\[\[\[\d+\]\]\]/g), (match) => ({
		token: match[0],
		start: match.index,
		end: match.index + match[0].length,
	}));
	const ending_at = new Map(tokens.map((item) => [item.end, item]));
	const starting_at = new Map(tokens.map((item) => [item.start, item]));
	const kind_of = (item) => (item ? (block_kinds.get(item.token) ?? null) : null);

	for (const item of tokens) {
		const kind = kind_of(item);
		if (kind === 'open' || kind === 'atom') {
			let before = item.start;
			while (before > 0 && (md[before - 1] === ' ' || md[before - 1] === '\t')) {
				before--;
			}
			if (before > 0 && md[before - 1] !== '\n' && kind_of(ending_at.get(before)) !== 'open') {
				cuts.push(before);
			}
		}
		if (kind === 'close' || kind === 'atom') {
			let after = item.end;
			while (after < md.length && (md[after] === ' ' || md[after] === '\t')) {
				after++;
			}
			if (after < md.length && md[after] !== '\n' && kind_of(starting_at.get(after)) !== 'close') {
				cuts.push(item.end);
			}
		}
	}

	return cuts.filter((cut) => !in_protected(ranges, cut));
}; //end block_token_cuts

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
 * Every edge of a shielded block tag between two items is a cut too (block_token_cuts), when
 * options.block_kinds names the block tokens.
 *
 * @param {string} md
 * @param {number} [max_chars=250] - Soft upper bound per segment.
 * @param {Object} [options]
 * @param {Map<string,string>} [options.block_kinds] - block token → 'open'|'close'|'atom'
 *   (browser_translation.js source_to_markdown).
 * @returns {Array<{text:string, sep:string}>} `sep` is '' for the first segment.
 */
export function segment_markdown(md, max_chars = 250, options = {}) {
	if (!md) {
		return [];
	}

	const ranges = segment_protected_ranges(md);
	// a protected range that carries a token is no reason to keep a block cut: a real link or
	// code span never holds a block tag, so such a range is text that only looks like one
	const token_free_ranges = ranges.filter(([start, end]) => !/\[\[\[\d+\]\]\]/.test(md.slice(start, end)));
	const structural = [
		...new Set([
			...structural_boundaries(md, ranges),
			...block_token_cuts(md, options.block_kinds, token_free_ranges),
		]),
	].sort((a, b) => a - b);
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
