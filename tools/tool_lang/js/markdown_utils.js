// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0



/**
 * MARKDOWN_UTILS
 * Bidirectional HTML ↔ Markdown conversion for the tool_lang browser translation pipeline.
 *
 * The LLM (browser-local Gemma model or remote API) operates on plain Markdown rather than
 * raw HTML because HTML tags confuse seq2seq models and inflate token counts. This module
 * bridges the gap:
 *
 *   HTML → html_to_markdown → [LLM translates] → markdown_to_html → HTML
 *
 * Dédalo inline tags (indexIn, tc, svg, geo, …) are replaced with [[[n]]] triple-bracket
 * placeholders (placeholders.js) BEFORE calling html_to_markdown, so the LLM never sees or
 * corrupts them. The caller (browser_translation.js) is responsible for that substitution
 * and for restoring the originals after markdown_to_html.
 *
 * Exports:
 *   html_to_markdown            — DOM-parser walk: HTML string → Markdown string
 *   markdown_to_html            — regex pass: Markdown string → HTML string
 *   split_markdown_by_paragraph — split Markdown on \n\n+ boundaries → string[]
 *   group_markdown_into_chunks  — merge paragraphs into ≤N-char chunks for batched API calls
 */



/**
 * HTML_TO_MARKDOWN
 * Convert an HTML string to Markdown suitable for LLM translation.
 *
 * Parses the HTML with DOMParser and walks the resulting DOM tree, converting
 * each element to its closest Markdown equivalent. The conversion is lossy by
 * design: only semantics the LLM needs to preserve (structure, emphasis, links)
 * are encoded; presentation-only attributes (class, style, id) are discarded.
 *
 * Supported conversions:
 *   Block:  <p> → \n\n  |  <br> → \n\n  |  <h1>–<h6> → #…######
 *           <ul>/<ol>/<li> → -/1.  |  <blockquote> → >  |  <hr> → ---
 *           <div> → recurse + \n\n  |  <table> → GFM pipe table | … |
 *           <pre> → fenced ``` code block
 *   Inline: <strong>/<b> → **  |  <em>/<i> → *  |  <u> → __
 *           <a href> → [text](url)  |  <code> → `code`  |  <img alt src> → ![alt](src)
 *   Pass-through (raw outerHTML): <span>, <sub>, <sup>, <small>, <mark>, <del>, <s>, <ins>
 *   Unknown tags: raw outerHTML verbatim.
 *
 * Text-node escaping: markdown metacharacters (*, _, [, ], `, \) are
 * backslash-escaped so literal text characters survive the HTML→MD→HTML round-trip.
 * [[[n]]] placeholder tokens are intentionally NOT escaped — they must pass through
 * the LLM unchanged and be detected by restore_placeholders after conversion back.
 *
 * Empty paragraph special case: whitespace-only <p> emits &nbsp; so that the
 * paragraph is not collapsed by markdown_to_html's block splitter (which trims
 * and skips empty blocks). This is necessary for CKEditor content that uses
 * <p>&nbsp;</p> as explicit blank-line separators.
 *
 * Table with colspan/rowspan: falls back to raw outerHTML — Markdown pipe tables
 * cannot represent merged cells without losing structure.
 *
 * @param {string} html - HTML string with Dédalo tags already replaced by [[[n]]] placeholders.
 * @returns {string} Markdown string with trailing whitespace trimmed and runs of 3+ newlines
 *   collapsed to 2 (a single paragraph boundary).
 */
export function html_to_markdown(html) {

	const parser	= new DOMParser();
	const doc		= parser.parseFromString(html, 'text/html');
	const result	= [];

	// Regex to detect [[[n]]] placeholder strings — do NOT escape these
	const placeholder_re = /^\[\[\[\d+\]\]\]$/;

	/**
	 * ESCAPE_MD (inner)
	 * Backslash-escape Markdown metacharacters in a plain text string so they
	 * are treated as literal characters by markdown_to_html.
	 *
	 * The text is first split on [[[n]]] placeholder tokens; the placeholders pass
	 * through unmodified (they must survive to restore_placeholders); only the
	 * non-placeholder segments are escaped. Escaped chars: \ * _ [ ] `
	 *
	 * @param {string} text - Raw text-node content.
	 * @returns {string} Escaped text with [[[n]]] tokens preserved verbatim.
	 */
	function escape_md(text) {
		if (!text) return '';
		// Split around [[[n]]] placeholders, escape non-placeholder parts
		const parts = text.split(/(\[\[\[\d+\]\]\])/);
		return parts.map(part => {
			if (placeholder_re.test(part)) return part;
			return part
				.replace(/\\/g, '\\\\')
				.replace(/\*/g, '\\*')
				.replace(/_/g, '\\_')
				.replace(/\[/g, '\\[')
				.replace(/\]/g, '\\]')
				.replace(/`/g, '\\`');
		}).join('');
	}

	/**
	 * WALK (inner)
	 * Recursively convert a single DOM node to its Markdown representation.
	 *
	 * Handles two node types:
	 *   nodeType === 3 (Text) — escaped via escape_md().
	 *   nodeType === 1 (Element) — dispatched through the tag switch; all other
	 *     nodeType values (Comment, CDATA, …) are silently ignored (return '').
	 *
	 * The switch covers every tag documented in html_to_markdown. Inline elements
	 * that have no standard Markdown equivalent (span, sub, sup, mark, del, s,
	 * ins, small) fall through to raw outerHTML so their content is not lost.
	 * Unknown tags also emit outerHTML to avoid silent data loss.
	 *
	 * @param {Node} node - Any DOM node from the parsed document body.
	 * @returns {string} Markdown fragment for this node and all its descendants.
	 */
	function walk(node) {

		if (node.nodeType === 3) {
			// Text node
			const text = node.textContent;
			if (!text) return '';
			return escape_md(text);
		}

		if (node.nodeType !== 1) return '';

		const tag = node.tagName.toLowerCase();

		// --- Block-level elements ---
		switch (tag) {

			case 'p': {
				const inner = walk_children(node);
				// Whitespace-only <p> (e.g. <p>&nbsp;</p>) must emit
				// &nbsp; so the paragraph survives the round-trip
				// (markdown_to_html trims blocks and skips empty ones;
				// \u00A0 is also trimmed by ES2015+ String.trim())
				const content = inner.trim() ? inner : '&nbsp;';
				return content + '\n\n';
			}

			case 'br':
				return '\n\n';

			case 'h1': case 'h2': case 'h3':
			case 'h4': case 'h5': case 'h6': {
				const level = parseInt(tag[1]);
				const inner = walk_children(node);
				return '#'.repeat(level) + ' ' + inner + '\n\n';
			}

			case 'ul': {
				const items = [];
				for (const child of node.children) {
					if (child.tagName.toLowerCase() === 'li') {
						items.push('- ' + walk_children(child));
					}
				}
				return items.join('\n') + '\n\n';
			}

			case 'ol': {
				const items = [];
				let n = 1;
				for (const child of node.children) {
					if (child.tagName.toLowerCase() === 'li') {
						items.push(n + '. ' + walk_children(child));
						n++;
					}
				}
				return items.join('\n') + '\n\n';
			}

			case 'blockquote': {
				const inner = walk_children(node);
				return inner.split('\n').map(l => '> ' + l).join('\n') + '\n\n';
			}

			case 'hr':
				return '---\n\n';

			case 'div': {
				const inner = walk_children(node);
				return inner + '\n\n';
			}

			case 'table': {
				return convert_table(node) + '\n\n';
			}

			// --- Inline elements ---
			case 'strong': case 'b': {
				const inner = walk_children(node);
				if (!inner.trim()) return inner;
				return '**' + inner + '**';
			}

			case 'em': case 'i': {
				const inner = walk_children(node);
				if (!inner.trim()) return inner;
				return '*' + inner + '*';
			}

			case 'u': {
				const inner = walk_children(node);
				if (!inner.trim()) return inner;
				return '__' + inner + '__';
			}

			case 'a': {
				const href	= node.getAttribute('href') || '';
				const inner	= walk_children(node);
				return '[' + inner + '](' + href + ')';
			}

			case 'code': {
				const inner = walk_children(node);
				return '`' + inner + '`';
			}

			case 'pre': {
				const inner = walk_children(node);
				return '```\n' + inner + '\n```\n\n';
			}

			case 'img': {
				const alt	= node.getAttribute('alt') || '';
				const src	= node.getAttribute('src') || '';
				if (alt || src) {
					return '![' + alt + '](' + src + ')';
				}
				return node.outerHTML;
			}

			case 'span': case 'sub': case 'sup': case 'small':
			case 'mark': case 'del': case 's': case 'ins': {
				// No standard markdown equivalent → keep raw HTML
				return node.outerHTML;
			}

			default: {
				// Unknown tag → emit raw HTML
				return node.outerHTML;
			}
		}
	}

	/**
	 * WALK_CHILDREN (inner)
	 * Walk all child nodes of a given DOM element and concatenate their Markdown output.
	 * Delegates each child to walk(); the results are joined without any separator
	 * so block-level children emit their own trailing \n\n as needed.
	 *
	 * @param {Node} node - Parent DOM element whose children are to be walked.
	 * @returns {string} Concatenated Markdown of all child nodes.
	 */
	function walk_children(node) {
		return Array.from(node.childNodes).map(walk).join('');
	}

	/**
	 * CONVERT_TABLE (inner)
	 * Convert a <table> DOM element to a GitHub-Flavored Markdown (GFM) pipe table.
	 *
	 * Strategy:
	 *   1. Bail to raw outerHTML if any cell carries colspan/rowspan — GFM tables
	 *      cannot represent merged cells without losing data.
	 *   2. Query all <tr> rows and collect their <th>/<td> cell texts; cell content
	 *      is processed via walk_children() (inline HTML inside cells is converted).
	 *   3. Collapse newlines and runs of whitespace inside each cell to a single space
	 *      (Markdown table syntax requires all content on one line).
	 *   4. Pad short rows to the widest row so the output is a valid rectangular table.
	 *   5. Emit: header row → separator row (all `---`) → data rows.
	 *      The first <tr> is always treated as the header regardless of whether its
	 *      cells use <th> or <td>.
	 *
	 * The output does NOT include a trailing \n\n — the caller (the 'table' case in
	 * walk()) appends that.
	 *
	 * @param {Element} table - A <table> DOM element from the parsed document.
	 * @returns {string} GFM pipe-table string, or the element's outerHTML for complex tables.
	 */
	function convert_table(table) {

		// Check for colspan/rowspan — fall back to raw HTML
		const complex_cells = table.querySelectorAll('td[colspan], td[rowspan], th[colspan], th[rowspan]');
		if (complex_cells.length > 0) {
			return table.outerHTML;
		}

		const rows = table.querySelectorAll('tr');
		if (rows.length === 0) return table.outerHTML;

		const md_rows = [];

		for (const row of rows) {
			const cells = row.querySelectorAll('th, td');
			const cell_texts = [];
			for (const cell of cells) {
				// Process cell contents recursively (inline HTML inside cells)
				let cell_md = walk_children(cell).trim();
				// Collapse whitespace inside cells
				cell_md = cell_md.replace(/\n/g, ' ').replace(/\s+/g, ' ');
				cell_texts.push(cell_md);
			}
			md_rows.push(cell_texts);
		}

		if (md_rows.length === 0) return table.outerHTML;

		// Determine column count
		const col_count = Math.max(...md_rows.map(r => r.length));

		// Pad rows to uniform width
		for (const row of md_rows) {
			while (row.length < col_count) row.push('');
		}

		// Build markdown table
		const lines = [];

		// Header row (first row)
		lines.push('| ' + md_rows[0].join(' | ') + ' |');

		// Separator
		lines.push('| ' + md_rows[0].map(() => '---').join(' | ') + ' |');

		// Data rows
		for (let i = 1; i < md_rows.length; i++) {
			lines.push('| ' + md_rows[i].join(' | ') + ' |');
		}

		return lines.join('\n');
	}

	// Walk all body children
	for (const node of doc.body.childNodes) {
		result.push(walk(node));
	}

	let md = result.join('').trim();

	// Collapse 3+ consecutive newlines down to 2 (paragraph boundary)
	md = md.replace(/\n{3,}/g, '\n\n');

	return md;
}


/**
 * MARKDOWN_TO_HTML
 * Convert a Markdown string back to HTML after LLM translation.
 *
 * This is the inverse of html_to_markdown and is applied to the LLM's output
 * before restoring the [[[n]]] Dédalo-tag placeholders. It implements a subset of
 * CommonMark + GFM sufficient for CKEditor-compatible output.
 *
 * Algorithm (two-pass):
 *   1. Split the input on \n\n+ boundaries into "blocks". Each block is classified
 *      by its leading characters:
 *        ``` ... ```  → <pre><code> (escape_html applied to the code body)
 *        ---/--- or ***or ___ → <hr>
 *        # … ######   → <h1>…<h6>
 *        - / * / + lines (all) → <ul><li>…</li></ul>
 *        1. 2. … lines (all) → <ol><li>…</li></ol>
 *        > lines (all) → <blockquote>…</blockquote>
 *        | … | … with | --- | separator → <table> via convert_md_table
 *        Starts with < and ends with > → raw HTML passthrough (un-converted spans, etc.)
 *        Everything else → <p> (single \n within a block becomes <br>)
 *   2. Each block's text content is processed by process_inline() to convert
 *      bold, italic, underline, code, and link syntax.
 *
 * Classification is done in priority order so that (for example) a block
 * starting with `---` is treated as <hr> before falling through to paragraph.
 * The regex /^\|[\s\-:|]+\|$/ detects the GFM separator row for tables.
 *
 * Produces bare HTML matching CKEditor output format — no class/style attributes
 * beyond the optional `class="lang-X"` on fenced-code blocks.
 *
 * @param {string} md - Markdown string produced by the LLM.
 * @returns {string} HTML string suitable for saving as a CKEditor component value.
 *   Returns '' for falsy input.
 */
export function markdown_to_html(md) {

	if (!md) return '';

	// Normalize trailing whitespace
	md = md.trim();

	// --- Step 1: Split into blocks by \n\n+ ---
	const raw_blocks = md.split(/\n{2,}/);

	// --- Step 2: Classify and convert each block ---
	const html_blocks = [];

	for (let block of raw_blocks) {

		block = block.trim();
		if (!block) continue;

		// Fenced code block
		const code_match = block.match(/^```([a-zA-Z0-9_-]*)\n([\s\S]*?)```$/);
		if (code_match) {
			const lang	= code_match[1];
			const code	= code_match[2];
			html_blocks.push('<pre><code' + (lang ? ' class="lang-' + lang + '"' : '') + '>' + escape_html(code) + '</code></pre>');
			continue;
		}

		// Horizontal rule
		if (/^(-{3,}|\*{3,}|_{3,})$/.test(block)) {
			html_blocks.push('<hr>');
			continue;
		}

		// Heading
		const heading_match = block.match(/^(#{1,6})\s+(.+)$/);
		if (heading_match) {
			const level	= heading_match[1].length;
			const inner	= process_inline(heading_match[2]);
			html_blocks.push('<h' + level + '>' + inner + '</h' + level + '>');
			continue;
		}

		// Unordered list
		const ul_lines = block.split('\n');
		if (ul_lines.length > 0 && ul_lines.every(l => /^\s*[-*+]\s+/.test(l))) {
			const items = ul_lines.map(l => '<li>' + process_inline(l.replace(/^\s*[-*+]\s+/, '')) + '</li>');
			html_blocks.push('<ul>' + items.join('') + '</ul>');
			continue;
		}

		// Ordered list
		const ol_lines = block.split('\n');
		if (ol_lines.length > 0 && ol_lines.every(l => /^\s*\d+\.\s+/.test(l))) {
			const items = ol_lines.map(l => '<li>' + process_inline(l.replace(/^\s*\d+\.\s+/, '')) + '</li>');
			html_blocks.push('<ol>' + items.join('') + '</ol>');
			continue;
		}

		// Blockquote
		const bq_lines = block.split('\n');
		if (bq_lines.length > 0 && bq_lines.every(l => /^>\s?/.test(l))) {
			const inner = bq_lines.map(l => l.replace(/^>\s?/, '')).join('<br>');
			html_blocks.push('<blockquote>' + process_inline(inner) + '</blockquote>');
			continue;
		}

		// Markdown table
		const table_lines = block.split('\n');
		if (table_lines.length >= 2 && table_lines[0].startsWith('|') && /^\|[\s\-:|]+\|$/.test(table_lines[1])) {
			html_blocks.push(convert_md_table(table_lines));
			continue;
		}

		// Raw HTML passthrough (starts with < and ends with >)
		if (/^<[^>]+>/.test(block) && />$/.test(block)) {
			html_blocks.push(block);
			continue;
		}

		// Default: paragraph — single \n inside becomes <br>
		const para_html = block.split('\n').map(line => process_inline(line)).join('<br>');
		html_blocks.push('<p>' + para_html + '</p>');
	}

	return html_blocks.join('');
}


/**
 * PROCESS_INLINE
 * Apply inline Markdown syntax transformations to a text string, converting
 * Markdown tokens to HTML inline elements.
 *
 * Processing order is significant — earlier rules protect content from later rules:
 *   1. Unescape backslash-escaped Markdown metacharacters (inserted by escape_md).
 *   2. Inline code `…` — processed first so ** or * inside backticks is not treated
 *      as bold/italic markup.
 *   3. Bold+italic ***…*** — must precede bold and italic individually so the three-star
 *      sequence is consumed in full rather than as nested ** + *.
 *   4. Bold **…**
 *   5. Italic *…* — negative lookbehind/lookahead avoids matching inside <strong>.
 *   6. Underline __…__ (Dédalo extension; not standard CommonMark).
 *   7. Links [text](url)
 *
 * Does NOT handle block-level elements; call from within each block's text content
 * after block classification in markdown_to_html.
 *
 * @param {string} text - Single-line or inline Markdown text segment.
 * @returns {string} HTML string with inline elements applied. Returns '' for falsy input.
 */
function process_inline(text) {

	if (!text) return '';

	// 1. Unescape markdown metacharacters FIRST
	text = text
		.replace(/\\([\\\*\_\[\]\`])/g, '$1');

	// 2. Inline code (before bold/italic so ** inside ` is not processed)
	text = text.replace(/`([^`\n]+)`/g, '<code>$1</code>');

	// 3. Bold+italic ***text*** (must come before bold and italic individually)
	text = text.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>');

	// 4. Bold **text**
	text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');

	// 5. Italic *text* (avoid matching inside <strong>)
	text = text.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');

	// 6. Underline __text__
	text = text.replace(/__([^_\n]+)__/g, '<u>$1</u>');

	// 7. Links [text](url)
	// The inner class excludes brackets so that a [[[n]]] placeholder followed by an
	// opening parenthesis — '…[[[5]]] (see below)' — is not mistaken for link syntax
	// and swallowed into an <a> (v6 d3991c3a66).
	text = text.replace(/\[([^[\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

	return text;
}


/**
 * CONVERT_MD_TABLE
 * Convert an array of GFM pipe-table lines to an HTML <table> string.
 *
 * Line layout expected:
 *   lines[0]  — header row:  | H1 | H2 | H3 |
 *   lines[1]  — separator:   | -- | -- | -- |  (ignored; just signals "this is a table")
 *   lines[2+] — data rows:   | D1 | D2 | D3 |
 *
 * Each cell's text is processed through process_inline() so bold/italic/link
 * syntax inside table cells is converted correctly.
 *
 * Output format: <table><thead><tr><th>…</th></tr></thead><tbody><tr><td>…</td></tr></tbody></table>
 * <tbody> is omitted when there are no data rows (header-only table).
 *
 * @param {string[]} lines - Array of raw Markdown pipe-table lines (including the separator).
 * @returns {string} HTML table string, or the raw lines joined by '\n' if fewer than 2 lines.
 */
function convert_md_table(lines) {

	if (lines.length < 2) return lines.join('\n');

	// Parse header
	const header_cells = parse_md_row(lines[0]);

	// Skip separator line (lines[1])
	const data_lines = lines.slice(2);

	let html = '<table><thead><tr>';
	for (const cell of header_cells) {
		html += '<th>' + process_inline(cell) + '</th>';
	}
	html += '</tr></thead>';

	if (data_lines.length > 0) {
		html += '<tbody>';
		for (const line of data_lines) {
			const cells = parse_md_row(line);
			html += '<tr>';
			for (const cell of cells) {
				html += '<td>' + process_inline(cell) + '</td>';
			}
			html += '</tr>';
		}
		html += '</tbody>';
	}

	html += '</table>';
	return html;
}


/**
 * PARSE_MD_ROW
 * Split a single GFM pipe-table row into trimmed cell strings.
 *
 * Strips the leading and trailing `|` characters, then splits on the remaining
 * `|` separators and trims whitespace from each cell. Empty leading/trailing
 * cells (from `| … |` delimiters) are removed.
 *
 * Example:
 *   "| cell1 | cell2 | cell3 |" → ["cell1", "cell2", "cell3"]
 *
 * @param {string} line - A single Markdown table row line.
 * @returns {string[]} Array of cell content strings (not yet HTML-processed).
 */
function parse_md_row(line) {
	return line
		.replace(/^\|/, '')
		.replace(/\|$/, '')
		.split('|')
		.map(cell => cell.trim());
}


/**
 * ESCAPE_HTML
 * Escape HTML special characters so that a string is safe to embed as text
 * content inside an HTML element.
 *
 * Used exclusively within markdown_to_html for fenced code block bodies
 * (<pre><code>…</code></pre>) where the raw code must not be interpreted as HTML.
 * The order of replacements matters: & must be escaped first to avoid double-escaping.
 *
 * Replaces: & → &amp;  |  < → &lt;  |  > → &gt;  |  " → &quot;
 *
 * @param {string} text - Raw text that may contain HTML special characters.
 * @returns {string} HTML-safe string.
 */
function escape_html(text) {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}


/**
 * SPLIT_MARKDOWN_BY_PARAGRAPH
 * Split a Markdown string into its constituent paragraph-level blocks.
 *
 * Blocks are separated by one or more blank lines (\n\n+). After splitting,
 * each block is trimmed of leading/trailing whitespace and empty blocks are
 * discarded. The function is the low-level building block used by
 * group_markdown_into_chunks to determine how to bin content for the LLM.
 *
 * @param {string} md - Markdown string to split.
 * @returns {string[]} Array of non-empty trimmed block strings.
 *   Returns an empty array for falsy input.
 */
export function split_markdown_by_paragraph(md) {

	if (!md) return [];

	const blocks = md.split(/\n{2,}/)
		.map(b => b.trim())
		.filter(b => b.length > 0);

	return blocks;
}


/**
 * GROUP_MARKDOWN_INTO_CHUNKS
 * Merge paragraph-level Markdown blocks into chunks that fit within a character limit.
 *
 * Batching reduces the number of calls to the translation model (one postMessage per
 * chunk) while keeping each chunk short enough for the LLM's effective token window.
 * The default limit of 1 000 characters was chosen to fit comfortably within the
 * Gemma 4B browser model's context length and to avoid per-sentence fragmentation on
 * short paragraphs.
 *
 * Algorithm (greedy, single-pass):
 *   - For each block from split_markdown_by_paragraph():
 *       • If the block alone exceeds maxChars: flush the accumulator, push the
 *         oversized block as its own chunk (no sub-splitting — the LLM must handle it).
 *       • Otherwise: if appending the block (with \n\n separator) keeps the accumulator
 *         within maxChars, merge it; otherwise flush the accumulator and start a new one.
 *   - After all blocks: flush any remaining accumulator content.
 *
 * The rejoined blocks inside each chunk are separated by \n\n so that markdown_to_html
 * can re-parse them correctly after translation.
 *
 * @param {string} md        - Markdown string to split into chunks.
 * @param {number} maxChars  - Soft upper bound (in characters) per chunk. Default: 1000.
 * @returns {string[]} Array of chunk strings. Individual oversized blocks may exceed maxChars.
 */
export function group_markdown_into_chunks(md, maxChars = 1000) {

	const blocks	= split_markdown_by_paragraph(md);
	const chunks	= [];
	let current		= '';

	for (const block of blocks) {
		// Block too large to share a chunk → flush and push solo
		if (block.length > maxChars) {
			if (current) {
				chunks.push(current);
				current = '';
			}
			chunks.push(block);
			continue;
		}

		// Attempt to merge this block with the current accumulator using \n\n as separator
		const candidate = current
			? current + '\n\n' + block
			: block;

		if (candidate.length <= maxChars) {
			current = candidate;
		} else {
			chunks.push(current);
			current = block;
		}
	}

	// Flush any remaining accumulated text
	if (current) {
		chunks.push(current);
	}

	return chunks;
}



// @license-end
