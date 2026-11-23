/**
 * THE IDENTITY ROUND-TRIP GATE of tool_lang's browser translation (A1-02 re-review).
 *
 * The pipeline's job is to hand a model the TEXT of a record and nothing else, and to put
 * everything else back exactly. A model that answers with its input is therefore the
 * sharpest probe there is: whatever the pipeline itself loses, welds, splits, adds or
 * reorders shows up as a difference from the source, with no model behaviour to blame. Four
 * review rounds found such defects one by one (welded words, a gained <strong>, a lost
 * spacer, a split paragraph, a lost comment…); this gate is the class.
 *
 * It runs THE pipeline — `prepare_translation` (source → tokens + Markdown → segments →
 * blocks) → the worker's `run_blocks` with an identity translator → `finish_translation`
 * (the on-'end' chain the driver runs: reorder, Markdown → HTML, nesting check, restore,
 * validate) — over a corpus of heritage HTML and a seeded fuzz leg, and asserts:
 *
 *   1. OUTPUT == SOURCE, modulo the ONE stated normalisation N∘W:
 *        N — the spec serialiser (what a browser's innerHTML hands back: attribute quoting,
 *            character references, implied <tbody>), applied to both sides;
 *        W — inside a text node that carries words, a newline run (with the spaces/tabs
 *            around it) is ONE space: in HTML it renders as one, and it is the model's text
 *            to rewrite (left as '\n' it would come back as a <br>).
 *      Nothing else: layout whitespace, spacers, &nbsp;, comments, attributes and loose
 *      text without a <p> come back byte for byte (after N).
 *   2. NO STRUCTURAL TOKEN IN ANY MODEL INPUT: every block-level tag's token sits at a
 *      segment edge and is hoisted; the model sees text and inline tokens only.
 *   3. NOT REFUSED, NOTHING REPAIRED: the run would save, and saves it clean.
 *
 * It also pins the refusals an identity model cannot reach (F3: crossed nesting) and the
 * model-wrapper strip (F6), on the same chain — and runs DEVIANT models (H1/H2/M2: dropped
 * backslashes, empty or tokens-only answers, written HTML, stray backticks and asterisks,
 * swapped/dropped/repeated tokens, reversed words, moved delimiters, the reviewer's literal
 * stars) over the adversarial cases and a seeded fuzz leg: every run is refused, or saves the
 * model's text in the source's structure — the record's literals all there, no markup as
 * text, every emphasis element one the model delimited, no emphasis lost the model did not
 * drop (deviationProblems). A model that only drops backslashes saves N∘W(source) exactly.
 *
 * DOM: Bun has no DOMParser — the pipeline's is test/helpers/parse5_dom.ts (parse5, the
 * declared devDependency: a spec tree builder and serialiser). The real-browser twin is the
 * client suite `test_tool_lang_browser_translation`.
 *
 * ISOLATED GATE (test/helpers/isolated_gate.ts): it registers a Bun.plugin over the client
 * tree and a global DOMParser, both process-global — in the tier's process it only MIRRORS
 * a child run of itself.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join, resolve } from 'node:path';
import { resolveClientModuleOverride } from '../helpers/client_module_overrides.ts';
import { isIsolatedGateChild, mirrorIsolatedGate } from '../helpers/isolated_gate.ts';
import {
	browserSerialize,
	elementNames,
	elementTexts,
	installParse5DomParser,
	mapWordTextNodes,
	visibleText,
} from '../helpers/parse5_dom.ts';

if (!isIsolatedGateChild(import.meta.path)) mirrorIsolatedGate(import.meta.path);
else {
	const ROOT = resolve(import.meta.dir, '../..');
	const CLIENT_COMMON = join(ROOT, 'client', 'dedalo', 'core', 'common', 'js');

	/**
	 * tools/tool_lang/js/browser_translation.js is served from a root where `tools/` and
	 * `core/` are siblings; on disk the client lives under client/dedalo/core. The pipeline's
	 * own dependencies load for REAL — tr.js (the Dédalo mark patterns) and api_error.js are
	 * pure modules; the three that reach the DOM page (utils/index, render_api_error,
	 * render_escape) are used only by the save/overlay half the gate does not run, and are
	 * stubbed. Confined to importers inside tools/tool_lang/js.
	 */
	Bun.plugin({
		name: 'tool-lang-identity-served-root',
		setup(build) {
			const fromToolLang = (importer: string) =>
				importer.includes(`${join('tools', 'tool_lang', 'js')}/`);
			build.onResolve({ filter: /core\/common\/js\/(tr|api_error)\.js$/ }, (args) => {
				const override = resolveClientModuleOverride(args.path);
				if (override !== null) return { path: override };
				if (!fromToolLang(args.importer)) return undefined;
				return {
					path: join(CLIENT_COMMON, args.path.endsWith('tr.js') ? 'tr.js' : 'api_error.js'),
				};
			});
			build.onResolve(
				{ filter: /core\/common\/js\/(utils\/index|render_api_error|utils\/render_escape)\.js$/ },
				(args) => {
					const override = resolveClientModuleOverride(args.path);
					if (override !== null) return { path: override };
					return fromToolLang(args.importer)
						? { path: args.path, namespace: 'tool-lang-identity-stub' }
						: undefined;
				},
			);
			build.onLoad({ filter: /.*/, namespace: 'tool-lang-identity-stub' }, () => ({
				contents:
					'export const clone = (value) => (value === undefined || value === null ? value : structuredClone(value));\n' +
					'export const get_json_langs = async () => [];\n' +
					'export const is_equal = (a, b) => Bun.deepEquals(a, b);\n' +
					"export const error_text = (api_error) => (api_error && api_error.code) || '';\n" +
					"export const render_value = (value) => String(value ?? '');\n",
				loader: 'js',
			}));
		},
	});

	let restoreDom: () => void = () => {};
	// biome-ignore lint/suspicious/noExplicitAny: the pipeline modules are untyped browser JS
	let B: any;
	// biome-ignore lint/suspicious/noExplicitAny: same
	let R: any;
	// biome-ignore lint/suspicious/noExplicitAny: same
	let M: any;

	beforeAll(async () => {
		restoreDom = installParse5DomParser();
		B = await import('../../tools/tool_lang/js/browser_translation.js');
		R = await import('../../tools/tool_lang/js/block_runner.js');
		M = await import('../../tools/tool_lang/js/markdown_utils.js');
	});
	afterAll(() => restoreDom());

	/**
	 * W: a newline run inside a text node with words is one space (see the header) — the
	 * text the model receives. Not inside an element restored whole (markdown_utils.js
	 * RAW_ATOM_TAGS: <pre>, <xmp>, <textarea>, <script>…), whose text never travels, nor where
	 * the line breaks are visible: under the nearest element whose inline style decides that
	 * they are.
	 *
	 * Which styles keep them is WRITTEN OUT here, style string by style string, as CSS answers
	 * it (A1-02 re-review 5, L2) — the gate does not run a parser of its own, nor the engine's:
	 * an engine parser that misreads one of these is red against a stated answer. 'keep': the
	 * breaks are visible; 'transform': collapsed; 'inherit': nothing valid declared, the parent
	 * decides. A style that mentions white-space and is not listed THROWS.
	 */
	const WHITE_SPACE_EXPECTED: Record<string, 'keep' | 'transform' | 'inherit'> = {
		'white-space: pre-wrap': 'keep',
		'white-space:pre-line': 'keep',
		'white-space: normal': 'transform',
		'color:red; white-space:pre-line': 'keep',
		'white-space-collapse: preserve-breaks': 'keep',
		'white-space: pre; white-space: normal': 'transform',
		'WHITE-SPACE: Pre-Wrap !important': 'keep',
		// the reviewer's strings (re-review 5): importance, case, comments, combined keywords,
		// an invalid or prefixed value dropped, a ';' inside a string — every one keeps
		'white-space: pre-wrap !important': 'keep',
		'WHITE-SPACE: PRE-WRAP': 'keep',
		'white-space: pre-wrap ! important': 'keep',
		'white-space: /*c*/ pre-wrap': 'keep',
		'white-space: preserve nowrap': 'keep',
		'white-space: preserve-breaks wrap': 'keep',
		'white-space:pre !important; white-space:normal': 'keep',
		'white-space: pre; white-space: bogus': 'keep',
		'white-space: pre-wrap;': 'keep',
		'white-space:-moz-pre-wrap; white-space:pre-wrap': 'keep',
		'white-space:pre-wrap; white-space:-moz-pre-wrap': 'keep',
		'font-family:"a;b"; white-space:pre-wrap': 'keep',
		// and their mirrors
		'white-space: pre !important; white-space: normal !important': 'transform',
		'white-space: normal !important; white-space: pre': 'transform',
		'white-space: nowrap': 'transform',
		'white-space: collapse wrap': 'transform',
		'white-space: break-spaces': 'keep',
		'white-space: initial': 'transform',
		'white-space: inherit': 'inherit',
		'white-space:-moz-pre-wrap': 'inherit',
		'white-space: pre-wrap nowrap': 'inherit',
		'white-space: /* pre */ normal': 'transform',
		'font-family:"white-space:pre"; color:red': 'inherit',
	};
	const textRule = (tag: string, attribute: (name: string) => string | null) => {
		if (M.RAW_ATOM_TAGS.has(tag)) return 'subtree' as const;
		const style = attribute('style');
		if (style === null || !/white-space/i.test(style)) return undefined;
		const expected = WHITE_SPACE_EXPECTED[style];
		if (expected === undefined)
			throw new Error(`no stated white-space answer for style ${JSON.stringify(style)}`);
		return expected === 'inherit' ? undefined : expected;
	};
	/**
	 * A whitespace-only text node is a WORD space when an inline element or text sits on both
	 * sides and its parent allows text (the HTML content models of lists, tables and
	 * description lists hold none): it is text, under W. Any other is layout, kept exactly.
	 * The inline/block split is the engine's (is_block_tag — pinned on its own by the F5 leg).
	 */
	const NO_TEXT_PARENTS = new Set([
		'ul',
		'ol',
		'menu',
		'dl',
		'table',
		'thead',
		'tbody',
		'tfoot',
		'tr',
		'colgroup',
	]);
	const isWordSpace = (previous: string | null, next: string | null, parent: string) =>
		!NO_TEXT_PARENTS.has(parent) &&
		[previous, next].every((name) => name !== null && (name === '#text' || !M.is_block_tag(name)));
	const collapseTextNewlines = (html: string) =>
		mapWordTextNodes(
			html,
			(text) => text.replace(/[ \t]*[\r\n]+[ \t]*/g, ' '),
			textRule,
			isWordSpace,
		);

	/** N∘W of the source: what an identity run must save, as a browser would read it. */
	const expectedOf = (html: string) => browserSerialize(collapseTextNewlines(html));

	interface Run {
		refusedBefore?: string;
		out: string;
		// biome-ignore lint/suspicious/noExplicitAny: the report is untyped browser JS
		report: any;
		sent: string[];
		/** Block-level tokens (document-wide) that reached a model input. */
		structuralSent: string[];
		md: string;
		/** Blocks the worker failed (a failed block refuses the run). */
		// biome-ignore lint/suspicious/noExplicitAny: worker payload
		failed: any[];
		/** The model's LAST answer per block index (a retried block answers more than once). */
		outputs: Map<number, string>;
		// biome-ignore lint/suspicious/noExplicitAny: the prepared run is untyped browser JS
		prepared: any;
		accumulated: string;
	}

	/**
	 * THE pipeline with `model` as the translator (default: identity). The model gets the
	 * text and the index of the block it belongs to — read from the worker's own label
	 * ('Block i/n…'), so two blocks with the same text are still told apart.
	 */
	async function pipeline(
		html: string,
		model: (text: string, block: number) => string = (text) => text,
	): Promise<Run> {
		const prepared = B.prepare_translation(html);
		if (prepared.refused) {
			return {
				refusedBefore: prepared.refused,
				out: '',
				report: null,
				sent: [],
				structuralSent: [],
				md: '',
				failed: [],
				outputs: new Map(),
				prepared,
				accumulated: '',
			};
		}
		const sent: string[] = [];
		const structuralSent: string[] = [];
		const outputs = new Map<number, string>();
		const run = await R.run_blocks({
			blocks: prepared.blocks,
			mark_patterns: B.mark_pattern_sources(),
			translate: async (text: string, _overrides: unknown, label: string) => {
				const index = Number(/^Block (\d+)\//.exec(label)?.[1]) - 1;
				const block = prepared.blocks[index];
				if (!block || block.text !== text)
					throw new Error(`no block ${label} sent ${JSON.stringify(text)}`);
				sent.push(text);
				for (const local of text.match(/\[\[\[\d+\]\]\]/g) ?? []) {
					const global = block.restore_map?.[local] ?? local;
					if (prepared.block_tokens.has(global)) structuralSent.push(global);
				}
				const output = model(text, index);
				outputs.set(index, output);
				return output;
			},
			post: () => {},
		});
		const { restored_text, report } = B.finish_translation(
			prepared,
			run.accumulated_text,
			run.repair_stats,
		);
		return {
			out: restored_text,
			report,
			sent,
			structuralSent,
			md: prepared.md,
			failed: run.failed_blocks ?? [],
			outputs,
			prepared,
			accumulated: run.accumulated_text,
		};
	}

	/** The three identity assertions, with the case named in every message. */
	async function expectIdentity(name: string, html: string, expected = expectedOf(html)) {
		const run = await pipeline(html);
		expect(run.refusedBefore, `${name}: refused before the run`).toBeUndefined();
		expect(run.failed, `${name}: a block failed`).toEqual([]);
		expect(
			browserSerialize(run.out),
			`${name}: output differs from the source\n  md: ${JSON.stringify(run.md)}`,
		).toBe(expected);
		expect(
			run.structuralSent,
			`${name}: structural tokens reached the model (${JSON.stringify(run.sent)})`,
		).toEqual([]);
		expect(run.report.refused, `${name}: refused ${JSON.stringify(run.report)}`).toBe(false);
		expect(run.report.uncertain_count, `${name}: repaired`).toBe(0);
		return run;
	}

	// the record's marks, in the exact syntax tr.js matches
	const TC = '[TC_00:00:01.000_TC]';
	const IN = '[index-n-1-ballena-data::data]';
	const OUT = '[/index-n-1-ballena-data::data]';
	const SVG = '[svg-n-2--data:{"section_tipo":"test3","section_id":"7"}:data]';
	const NOTE = '[note-n-3--data:{"section_tipo":"test3","section_id":"1"}:data]';
	const PERSON = '[person-a-4-Ana-data:{"section_tipo":"test3","section_id":"5"}:data]';
	const PAGE = '[page-n-5--data:[12]:data]';
	const REF_IN = '[reference-n-6-ref-data:{"section_tipo":"test3","section_id":"2"}:data]';
	const REF_OUT = '[/reference-n-6-ref-data:{"section_tipo":"test3","section_id":"2"}:data]';
	const LANG = '[lang-n-7--data:"lg-cat":data]';
	// the pre-4.9.0 name of svg, still in records and still drawn (final review, F2)
	const DRAW = '[draw-n-8--data:{"section_tipo":"test3","section_id":"7"}:data]';

	/** The corpus: [name, source]. Every case must round-trip under N∘W. */
	const CORPUS: [string, string][] = [
		// the reviewer's t1
		['word space between emphasis', '<p>Moneda de <strong>Roma</strong> <em>antigua</em>.</p>'],
		[
			'indented list, nested list, empty item',
			'<ul>\n  <li>uno <strong>dos</strong></li>\n  <li><p>tres <em>cuatro</em></p><ul><li>anidado</li></ul></li>\n  <li></li>\n</ul>',
		],
		[
			'table with attributes, layout whitespace, entity',
			'<table class="t"><thead><tr><th colspan="2">Título</th></tr></thead><tbody>\n<tr><td>a</td> <td>b &amp; c</td></tr></tbody></table>',
		],
		['div of paragraphs with a newline between', '<div class="x"><p>uno</p>\n<p>dos</p></div>'],
		[
			'heading with a link (dots inside)',
			'<h2>Ver <a href="http://e.x/a?b=1&amp;c=2">enlace. Uno.</a> fin</h2>',
		],
		['line breaks, one followed by a newline', '<p>línea<br>otra<br>\nfin</p>'],
		['pre is one atom', '<pre>code  *x*\n  y</pre>'],
		['emphasis inside code (F5 of the previous round)', '<p><code>a <b>b</b> c</code></p>'],
		[
			'attributed paragraph, rtl, span',
			'<p style="text-align:center" lang="ar" dir="rtl">مرحبا <span data-x="1">hola</span></p>',
		],
		['attributed emphasis', '<p><strong class="k">clase</strong> y <em data-n="2">dato</em></p>'],
		['character references', '<p>a &lt;b&gt; &quot;c&quot; &amp; d © &#169;</p>'],
		['NBSP is kept (F4)', '<p>10&nbsp;km y nbsp literal</p>'],
		['private-use characters (epigraphic fonts)', '<p>pua  a ib  1</p>'],
		['comment inside a paragraph (F7)', '<p>x <!-- comentario --> y</p>'],
		['paragraph with edge spaces', '<p> espacio al borde </p>'],
		['heading with edge spaces around emphasis', '<h3> <strong>Roma</strong> </h3>'],
		['whitespace-only list items (F4)', '<ul><li> </li><li>\n</li></ul>'],
		['whitespace-only div (F4)', '<div>\n</div>'],
		['bidi span', '<p>English <span dir="rtl">עברית</span> mixed</p>'],
		['blockquote then paragraph', '<blockquote><p>cita</p></blockquote><p>tras</p>'],
		['sub and sup', '<p>a<sub>2</sub>b<sup>3</sup></p>'],
		// t2: blocks inside inline elements, loose text
		['div inside strong inside li', '<ul><li><strong>a <div>b</div> c</strong></li></ul>'],
		['paragraph inside emphasis inside div', '<div><em>uno<p>dos</p>tres</em></div>'],
		['div inside span', '<span>a<div>b</div>c</span>'],
		[
			'div inside an attributed span in an item',
			'<ul><li>x <span class="k">y<div>z</div>w</span> v</li></ul>',
		],
		['paragraph inside a link', '<div>uno <a href="#x">enl<p>p</p>ace</a> dos</div>'],
		['loose text after a heading', '<h2>t</h2>bare text'],
		// t3
		[
			'bracketed text with a line break in an item',
			'<ul><li>[roto<br>texto](sic) y fin</li><li>otro</li></ul>',
		],
		['backtick apostrophes (F2)', '<ul><li>l`Hospitalet</li><li>d`Urgell</li></ul>'],
		['literal <p> text (F6)', '<p>&lt;p&gt;texto&lt;/p&gt;</p>'],
		['comment at the end of an item (F7)', '<ul><li>a<!-- c --></li></ul>'],
		[
			'strong wrapping a paragraph, then emphasis',
			'<div><strong>uno<p>dos</p></strong><em>x</em></div>',
		],
		[
			'emphasis wrapping strong wrapping a paragraph',
			'<div><em>x<strong>y<p>z</p></strong></em></div>',
		],
		['underline wrapping a div', '<u>a<div>b</div>c</u>'],
		// t4: emphasis wrapping blocks (F1)
		[
			'emphasis wrapping two paragraphs (F1)',
			'<blockquote><em><p>Primera frase.</p><p>Segunda frase.</p></em></blockquote>',
		],
		['strong wrapping a paragraph (F1)', '<div><strong><p>Título</p></strong></div>'],
		['emphasis per item', '<ul><li><em>a</em></li><li><strong>b</strong></li></ul>'],
		['emphasis around a link', '<ul><li><em>texto <a href="x">enlace</a></em></li></ul>'],
		[
			'emphasis per cell',
			'<table><tr><td><strong>uno</strong></td><td><em>dos</em></td></tr></table>',
		],
		// t5: legacy inline tags (F5) and blank cells
		['strike and big (F5)', '<p>uno <strike>dos</strike> <big>tres</big> cuatro</p>'],
		[
			'strike and tt in an item (F5)',
			'<ul><li>uno <strike>dos</strike> <tt>tres</tt> cuatro</li></ul>',
		],
		[
			'ruby, acronym, nobr (F5)',
			'<p>漢<ruby>字<rp>(</rp><rt>ji</rt><rp>)</rp></ruby> <acronym title="x">ONU</acronym> <nobr>sin corte</nobr></p>',
		],
		[
			'font, blink, marquee (F5)',
			'<p>a <font color="red">rojo</font> <blink>b</blink> <marquee>m</marquee> z</p>',
		],
		[
			'custom and namespaced elements are inline',
			'<p>Texto<o:p></o:p> y <x-tag>propio</x-tag> fin</p>',
		],
		['blank cells', '<table><tr><td> </td><td>\n</td></tr></table>'],
		['attributed spacer', '<p class="c"> </p>'],
		// heritage shapes
		['the editor spacer between paragraphs', '<p>Uno.</p><p>&nbsp;</p><p>Dos.</p>'],
		['spacers inside a div', '<div><p> </p><p>&nbsp;</p><p>Texto.</p></div>'],
		['empty paragraph with a break', '<p><br></p><p>Texto.</p>'],
		['legacy loose text with breaks', 'Línea uno<br>línea dos<br><br>línea tres'],
		['loose text before a paragraph', 'texto suelto\n<p>párrafo</p>'],
		['image paragraph', '<p><img src="a.jpg" alt="x"></p><p>Pie.</p>'],
		[
			'inline svg in text',
			'<p>icono <svg width="10" height="10"><circle r="4"></circle></svg> tras</p>',
		],
		[
			'nested ordered lists with paragraphs',
			'<ol>\n\t<li><p>Uno.</p>\n\t\t<ol>\n\t\t\t<li>Uno punto uno.</li>\n\t\t\t<li>Uno punto dos.</li>\n\t\t</ol>\n\t</li>\n\t<li>Dos.</li>\n</ol>',
		],
		[
			'definition list',
			'<dl>\n<dt>Anverso</dt>\n<dd>Cabeza laureada a derecha.</dd>\n<dt>Reverso</dt>\n<dd>Jinete con lanza.</dd>\n</dl>',
		],
		[
			'table with caption, colgroup and merged cells',
			'<table>\n<caption>Pesos</caption>\n<colgroup><col span="2"></colgroup>\n<tr><th rowspan="2">Ceca</th><td>3,2 g</td></tr>\n<tr><td>3,4 g</td></tr>\n</table>',
		],
		['hr between paragraphs', '<p>Antes.</p>\n<hr>\n<p>Después.</p>'],
		[
			'comments between blocks',
			'<p>a</p><!-- separador --><p>b</p>\n<!-- otro -->\n<ul><li>c</li></ul>',
		],
		[
			'markdown metacharacters in text',
			'<p>2*3*4 = x_y_z \\ `code` ** __ [a](b) # - 1984. ---</p>',
		],
		[
			'Dédalo marks in a paragraph',
			`<p>${TC}La ${IN}ballena blanca${OUT} nada.${SVG} ${NOTE}Fin.</p>`,
		],
		[
			'Dédalo marks across blocks',
			`<p>${PERSON}Ana: ${REF_IN}uno</p><ul><li>${PAGE}dos${REF_OUT}</li><li>${LANG}tres</li></ul>`,
		],
		['marks at item edges', `<ul><li>${IN}a</li><li>b${OUT}</li></ul>`],
		['a draw mark (F2)', `<p>Ver la zona ${DRAW} del mapa antiguo de la ciudad</p>`],
		['a draw mark beside an svg mark (F2)', `<p>${SVG}${DRAW} capa <em>dos</em></p>`],
		[
			'a long list (one segment per item)',
			`<ul>${Array.from({ length: 30 }, (_, i) => `<li>Elemento número ${i + 1} de la lista, con algo de texto.</li>`).join('')}</ul>`,
		],
		[
			'a long paragraph cut at sentences',
			`<p>${Array.from({ length: 12 }, (_, i) => `Frase número ${i + 1} con <em>énfasis</em> y una <a href="#n${i}">nota.</a>`).join(' ')}</p>`,
		],
		['emphasis at a word edge', '<p><strong>Roma </strong>antigua y <em> nueva</em>.</p>'],
		['break at the edge of emphasis', '<p><strong>uno<br></strong>dos</p>'],
		['adjacent emphasis', '<p><strong>a</strong><strong>b</strong> <em>c</em><em>d</em></p>'],
		['unknown element inside a paragraph (M1)', '<p>Texto <foo>x</foo> fin</p>'],
		['unknown element at the top (M1)', 'Texto <foo>x</foo> fin'],
		['xmp, listing (L1)', '<xmp>a\nb  *c*</xmp><listing>a\nb</listing><p>fin</p>'],
		['plaintext swallows the rest (L1)', '<p>a</p><plaintext>x\ny <b>z</b>'],
		[
			'inline white-space keeps its line breaks (L1)',
			'<p>Verso uno<span style="white-space: pre-wrap">\nverso dos\n  verso tres</span> fin\nde línea</p>',
		],
		[
			'pre-line block, a normal span inside resets it (L1)',
			'<div style="color:red; white-space:pre-line">uno\ndos <span style="white-space: normal">tres\ncuatro</span>\ncinco</div>',
		],
		[
			'white-space-collapse longhand (L1)',
			'<p style="white-space-collapse: preserve-breaks">a\nb</p>',
		],
		[
			'the last white-space declaration wins (L1)',
			'<p style="white-space: pre; white-space: normal">a\nb</p>',
		],
		['an !important pre-wrap (L1)', '<p style="WHITE-SPACE: Pre-Wrap !important">a\n b</p>'],
		[
			'word spaces of two and with a newline',
			'<p><strong>a</strong>  <em>b</em> y <b>c</b>\n<i>d</i> e <span>f</span>\n  <sub>g</sub></p>',
		],
		[
			'emphasis across a line break',
			'<p><strong>uno<br>dos</strong> y <em>tres<br>cuatro</em></p>',
		],
		['code across a line break', '<p><code>let a;<br>let b;</code></p>'],
		['a space before a line break (edge whitespace, no token)', '<p>línea <br>otra <br> fin</p>'],
		[
			'a record that repeats itself is not a loop',
			'<p>la la la la la la la la la la la la, canta el coro con su voz de siempre.</p>',
		],
		// re-review 5 (H1′): literal metacharacters touching emphasis — the reviewer's table
		...(
			[
				'<p>Nacido *1890 en <em>Roma</em>.</p>',
				'<p>Moneda de <em>plata</em>* (ver nota).</p>',
				'<p>Moneda *<em>plata</em> fina.</p>',
				'<p><strong>Roma</strong>** nota</p>',
				'<p><em>a</em>*<em>b</em></p>',
				'<p><em>a</em> * <em>b</em></p>',
				'<p><strong>Nota*</strong> y <em>otra</em></p>',
				'<p><u>Ref_1</u> y <u>Ref_2</u></p>',
				'<p><u>título</u>_ final</p>',
				'<p>archivo_ y <u>nota</u></p>',
				'<p><code>a`b</code> c</p>',
				'<p>Del indoeuropeo *kʷékʷlos, <em>rueda</em>.</p>',
				'<p>campo __init__ y <u>nota</u></p>',
				'<p>campo id_ref y <u>nota</u></p>',
				'<p>Valoración: *** (buena), * (mala)</p>',
				'<p>3 * 4 = 12 y <em>más</em></p>',
				'<p>3*4 y <em>más</em> 5*6</p>',
				'<p>l`Hospitalet y <code>x</code></p>',
				'<p><strong>Nota</strong>: valor ** desconocido</p>',
				'<p>Ceca de Roma* y <em>Ostia</em>.</p>',
				'<p>* Ejemplar dudoso, <em>falso</em>.</p>',
				'<p>Ceca: <strong>Roma</strong>* (atribución dudosa)</p>',
				'<p><em>Denario</em>* de <em>plata</em></p>',
				'<p>Forma reconstruida *<em>kʷékʷlos</em>.</p>',
				'<p><strong>Peso:</strong> 3,2 g * 2 ejemplares</p>',
				'<p>Ref. RIC II* 123, <em>rara</em>.</p>',
				'<p>Peso: 3,2 g * (ejemplar *b*) — cat. n.º 12_a, ceca l`Hospitalet.</p>',
				'<p>ruta C:\\fondo\\[sic] y a\\b</p>',
			] as const
		).map((html): [string, string] => [`literal next to emphasis (H1′): ${html}`, html]),
		// a token between the text's own brackets is text, not a mangled token
		['a footnote star in brackets', '<p>nota [*] y [**] fin</p>'],
		['an image in brackets', '<p>ver [<img src="a.jpg">] fin</p>'],
		// re-review 5 (M1′): quirks mode puts a block inside a <p>, which must not split
		[
			'a table inside a paragraph (quirks, M1′)',
			'<p>Medidas: <table><tr><td>3 g</td></tr></table> fin</p>',
		],
		['a legend inside a paragraph (M1′)', '<p>a <legend>x</legend> b</p>'],
		['an option inside a paragraph (M1′)', '<p>a <option>x</option> b</p>'],
		['an optgroup inside a paragraph (M1′)', '<p>a <optgroup>x</optgroup> b</p>'],
		['a button holding a div inside a paragraph (M1′)', '<p>a <button><div>x</div></button> b</p>'],
		// re-review 5 (L1): raw-text elements are one atom
		[
			'noembed, noframes, title (L1)',
			'<p>a <noembed>x <b>y</b></noembed> b <noframes>z</noframes> <title>t &amp; u</title> c</p>',
		],
		// re-review 5 (L2): white-space as CSS reads it — WHITE_SPACE_EXPECTED states each answer
		...Object.keys(WHITE_SPACE_EXPECTED).map((style): [string, string] => [
			`white-space ${JSON.stringify(style)} (L2)`,
			style.includes('"')
				? `<p style='${style}'>uno\ndos <span>tres\n cuatro</span></p>`
				: `<p style="${style}">uno\ndos <span>tres\n cuatro</span></p>`,
		]),
		[
			'an inheriting white-space defers to the parent (L2)',
			'<div style="white-space: pre-wrap"><p style="white-space: inherit">a\nb</p><p style="white-space:-moz-pre-wrap">c\nd</p></div>',
		],
	];

	describe('identity round-trip: the corpus comes back as it went in (modulo N∘W)', () => {
		test.each(CORPUS)('%s', async (name, html) => {
			await expectIdentity(name, html);
		});

		test('W is the only text normalisation: a newline between two inline elements is one word space', async () => {
			// stated, not hidden: the whitespace node between </strong> and <em> carries the
			// word space the model writes back — one space
			await expectIdentity(
				'newline word space',
				'<p><strong>Roma</strong>\n  <em>antigua</em></p>',
				browserSerialize('<p><strong>Roma</strong> <em>antigua</em></p>'),
			);
		});

		test('the gate is not vacuous: a pipeline that drops a word space is red', () => {
			expect(browserSerialize('<p><strong>Roma</strong><em>antigua</em></p>')).not.toBe(
				expectedOf('<p><strong>Roma</strong> <em>antigua</em></p>'),
			);
		});
	});

	/**
	 * A seeded generator of heritage-shaped HTML: blocks (p, div, lists, tables, quotes,
	 * headings, rules), loose text, inline elements (emphasis, code, links, spans, legacy
	 * tags), breaks, comments, layout whitespace, NBSP, private-use characters, Markdown
	 * metacharacters and Dédalo marks. Deterministic: a failure names its seed.
	 */
	function makeGenerator(seed: number) {
		let state = seed >>> 0;
		const random = () => {
			state = (state + 0x6d2b79f5) >>> 0;
			let t = state;
			t = Math.imul(t ^ (t >>> 15), t | 1);
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
		const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
		let markId = 0;

		const WORDS = [
			'moneda',
			'Roma',
			'ceca',
			'l`Hospitalet',
			'2*3',
			'a_b',
			'\\x',
			'&lt;p&gt;',
			'&amp;',
			'10&nbsp;km',
			'',
			'a',
			'[sic]',
			'(nota)',
			'1984.',
			'Fin.',
			'¿Dónde?',
			'—dijo',
			// bare metacharacters and Markdown-looking text (the reviewer's gen2 vocabulary)
			'*',
			'**',
			'__',
			'_x_',
			'`',
			'x\ty',
			'#',
			'|',
			'1.',
			// literals that touch a word, a bracket or emphasis (re-review 5, H1′)
			'*1890',
			'Roma*',
			'__init__',
			'[*]',
			'***',
			'\\[',
		];
		const INLINE = [
			'strong',
			'em',
			'b',
			'i',
			'u',
			'code',
			'span',
			'sub',
			'sup',
			'strike',
			'small',
			'abbr',
			'tt',
			'a',
			// unknown, custom and namespaced names (inline: M1)
			'foo',
			'x-card',
			'o:p',
		];
		const LAYOUT = ['', '', '\n', '\n  ', ' '];

		const words = () =>
			Array.from({ length: 1 + Math.floor(random() * 4) }, () => pick(WORDS)).join(
				pick([' ', ' ', '\n']),
			);

		const inline = (depth: number): string => {
			const roll = random();
			if (roll < 0.45 || depth > 2) return words();
			if (roll < 0.55) return '<br>';
			if (roll < 0.6) return '<!-- c -->';
			if (roll < 0.68) {
				markId++;
				return pick([
					TC,
					`[index-n-${markId}-t${markId}-data::data]${words()}[/index-n-${markId}-t${markId}-data::data]`,
					`[note-n-${markId}--data:{"section_id":"${markId}"}:data]`,
				]);
			}
			const tag = pick(INLINE);
			const attrRoll = random();
			const attrs =
				tag === 'a'
					? ' href="#x"'
					: attrRoll < 0.15
						? ' class="k"'
						: attrRoll < 0.22
							? (() => {
									const style = pick(Object.keys(WHITE_SPACE_EXPECTED));
									return style.includes('"') ? ` style='${style}'` : ` style="${style}"`;
								})()
							: '';
			return `<${tag}${attrs}>${content(depth + 1)}</${tag}>`;
		};
		// inline siblings are separated by nothing, or by a word space as an editor writes one
		const content = (depth: number) =>
			Array.from({ length: 1 + Math.floor(random() * 3) }, () => inline(depth)).join(
				pick(['', ' ', ' ', '  ', '\n', '\n  ']),
			);

		const block = (depth: number): string => {
			const roll = random();
			const ws = () => pick(LAYOUT);
			if (roll < 0.3 || depth > 1)
				return `<p${random() < 0.15 ? ' class="c"' : ''}>${content(0)}</p>`;
			if (roll < 0.38) return pick(['<p> </p>', '<p>&nbsp;</p>', '<p><br></p>']);
			if (roll < 0.5) {
				const tag = pick(['ul', 'ol']);
				const items = Array.from(
					{ length: 1 + Math.floor(random() * 3) },
					() => `${ws()}<li>${random() < 0.3 ? block(depth + 1) : content(0)}</li>`,
				);
				return `<${tag}>${items.join('')}${ws()}</${tag}>`;
			}
			if (roll < 0.6) {
				const rows = Array.from(
					{ length: 1 + Math.floor(random() * 2) },
					() =>
						`${ws()}<tr>${ws()}<td>${content(0)}</td>${ws()}<td>${random() < 0.2 ? ' ' : content(0)}</td></tr>`,
				);
				return `<table>${ws()}<tbody>${rows.join('')}${ws()}</tbody></table>`;
			}
			if (roll < 0.68)
				return `<div>${ws()}${block(depth + 1)}${ws()}${block(depth + 1)}${ws()}</div>`;
			if (roll < 0.74) {
				const tag = pick(['em', 'strong']);
				return `<blockquote><${tag}>${block(depth + 1)}${block(depth + 1)}</${tag}></blockquote>`;
			}
			if (roll < 0.82) {
				const level = 1 + Math.floor(random() * 4);
				return `<h${level}>${content(0)}</h${level}>`;
			}
			if (roll < 0.84) return '<hr>';
			if (roll < 0.86)
				return pick([
					'<xmp>a\n  *b*</xmp>',
					'<listing>uno\ndos</listing>',
					// quirks mode: a block inside a <p> (M1′)
					`<p>${content(0)}<table><tr><td>${content(0)}</td></tr></table>${content(0)}</p>`,
					((tag) => `<p>${content(0)}<${tag}>${content(0)}</${tag}>${content(0)}</p>`)(
						pick(['legend', 'option', 'optgroup']),
					),
					`<p>${content(0)} <noembed>${content(0)}</noembed> <title>${words()}</title></p>`,
				]);
			if (roll < 0.9) return '<!-- bloque -->';
			return depth === 0 ? LOOSE : `<p>${content(0)}</p>`;
		};

		// top level: blocks joined by layout whitespace; loose text (no <p>) is inline, so it
		// meets its neighbours with one space or nothing, like any inline sibling
		const LOOSE = '\u0000loose';
		const document = () => {
			const pieces = Array.from({ length: 1 + Math.floor(random() * 4) }, () => block(0));
			let html = '';
			for (let k = 0; k < pieces.length; k++) {
				const loose = pieces[k] === LOOSE;
				if (k > 0) html += loose || pieces[k - 1] === LOOSE ? pick(['', ' ']) : pick(LAYOUT);
				html += loose ? content(0) : pieces[k];
			}
			return html;
		};

		return { document };
	}

	/** Seeds per run (~1 s). Measured green on 30 000 when the leg was written. */
	const FUZZ_SEEDS = 2000;

	/** Where two serialisations first differ, with 60 characters of context on each side. */
	const firstDivergence = (got: string, want: string) => {
		let at = 0;
		while (at < got.length && at < want.length && got[at] === want[at]) at++;
		const around = (text: string) => JSON.stringify(text.slice(Math.max(0, at - 60), at + 60));
		return `first divergence at ${at}:\n     output ${around(got)}\n     want   ${around(want)}`;
	};

	describe('identity round-trip: seeded fuzz', () => {
		test(`${FUZZ_SEEDS} generated heritage documents come back as they went in`, async () => {
			const failures: string[] = [];
			let ran = 0;
			for (let seed = 1; seed <= FUZZ_SEEDS; seed++) {
				const html = makeGenerator(seed).document();
				const run = await pipeline(html);
				if (run.refusedBefore) continue; // touching tokens: refused by design, never saved
				ran++;
				const got = browserSerialize(run.out);
				const want = expectedOf(html);
				const problems = [
					got === want ? null : firstDivergence(got, want),
					run.structuralSent.length === 0
						? null
						: `structural tokens sent: ${run.structuralSent.join(' ')}`,
					run.failed.length === 0 ? null : `failed: ${JSON.stringify(run.failed)}`,
					run.report.refused ? `refused: ${JSON.stringify(run.report)}` : null,
					run.report.uncertain_count === 0 ? null : 'repaired',
				].filter(Boolean);
				if (problems.length > 0 && failures.length < 5) {
					failures.push(`seed ${seed}: ${JSON.stringify(html)}\n  ${problems.join('\n  ')}`);
				}
			}
			expect(failures, failures.join('\n\n')).toEqual([]);
			// the leg is not vacuous: almost every generated document is translated
			expect(ran).toBeGreaterThan(FUZZ_SEEDS * 0.95);
		});
	});

	describe('what an identity model cannot reach: crossed nesting is REFUSED (F3)', () => {
		test('interleaved shielded pairs: <span>uno <sub>y</span> dos</sub>', async () => {
			const run = await pipeline('<p><span class="a">uno</span> y <sub>dos</sub></p>', (text) =>
				text.replace('uno[[[1]]] y [[[2]]]dos', 'uno [[[2]]]y[[[1]]] dos'),
			);
			expect(run.report.tags_crossed).toBeGreaterThan(0);
			expect(run.report.refused).toBe(true);
			expect(B.mark_report_lines(run.report, () => null).join('\n')).toContain('wrongly nested');
		});

		test('emphasis crossing a shielded tag: **x y [[[1]]]z**[[[2]]]', async () => {
			const run = await pipeline(
				'<p><strong>x</strong> y <span class="k">z</span> w</p>',
				() => '**x y [[[1]]]z**[[[2]]] w',
			);
			expect(run.report.tags_crossed).toBeGreaterThan(0);
			expect(run.report.refused).toBe(true);
		});

		test('tags_crossed counts only crossings: a well-nested result is 0', () => {
			const descriptors = [
				{ token: '[[[1]]]', kind: 'open', pair: '[[[2]]]', shield: true },
				{ token: '[[[2]]]', kind: 'close', pair: '[[[1]]]', shield: true },
				{ token: '[[[3]]]', kind: 'atom', pair: null, shield: true },
			];
			expect(B.tags_crossed('<p><strong>a [[[1]]]b[[[3]]][[[2]]]</strong></p>', descriptors)).toBe(
				0,
			);
			expect(B.tags_crossed('<p><strong>a [[[1]]]b</strong>[[[2]]]</p>', descriptors)).toBe(1);
			expect(B.tags_crossed('<p>[[[1]]]<em>a[[[2]]]</em></p>', descriptors)).toBe(1);
		});
	});

	/**
	 * THE DEVIANT-MODEL LEG (A1-02 re-reviews 4 and 5). A real model does not answer with its
	 * input: it drops backslashes, returns nothing, writes HTML, breaks lines, adds or loses
	 * backticks and asterisks, swaps, drops, repeats and moves tokens and delimiters, reorders
	 * words. Every such run must end in ONE of two ways:
	 *
	 *   - REFUSED (a failed block, or the report refuses): nothing is saved; or
	 *   - SAVED, and then what the record shows is the MODEL'S text in the SOURCE'S
	 *     structure, nothing else (deviationProblems):
	 *       a. its letters are the model's letters, in the model's order (whitespace and the
	 *          Markdown delimiters * _ ` aside; a backslash the model wrote before a bracket
	 *          is its escaping of a token) — nothing deleted, nothing invented;
	 *       b. the record's own literal * _ ` are all there: as many of each as the source shows
	 *          (they travel as tokens — none is deleted, none is invented from a delimiter);
	 *       c. no markup as visible text beyond what the source's text had;
	 *       d. its elements are the source's: every element other than emphasis and code
	 *          exactly as many times; emphasis and code never more often than the source
	 *          (plus one per emphasis run balancing cut across two blocks: a model that moves
	 *          the balancing delimiters gets that run back as two);
	 *       e. every emphasis or code element the MODEL'S text produced spans exactly the
	 *          letters between two delimiters of its kind the model wrote (or an answer edge
	 *          where the segment itself has one: the wrapper restored around a wholly
	 *          emphasised segment, the balancing of a run cut between blocks) — none spans
	 *          text the model did not delimit ('<strong>Roma</strong>*' never saves as
	 *          '*Roma'); an element with no letters spans none of the model's text (leg d
	 *          counts it);
	 *       f. no emphasis is lost (report.emphasis_lost) unless the model itself wrote fewer
	 *          delimiters of a kind than its segment carried (outside code spans).
	 *
	 * The model's text is its answer per block (the LAST one: a loop is retried) less the
	 * tokens and the <p>…</p> wrapper the contract strips (strip_added_paragraph — pinned by
	 * its own leg below).
	 */
	const TOKEN_RE = /\[\[\[\d+\]\]\]/g;
	const TAG_SHAPE = /<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s[^<>]*)?\/?>/g;
	const META = ['*', '_', '`'] as const;
	const MD_INLINE = new Set(['strong', 'b', 'em', 'i', 'u', 'code']);
	// A backslash the MODEL wrote right before a bracket is its escaping of a token
	// ('\\[\\[\\[1\\]\\]\\]'), not a letter: dropped from the model's text only, as written (before
	// anything else is removed) — in the saved text every backslash is a character. Then
	// metacharacters before tokens: a delimiter the model wrote INSIDE a token ('[[[*3]]]') is
	// conformed away, and the token is a token again.
	const lettersOf = (text: string, model = false) =>
		(model ? text.replace(/\\(?=[[\]])/g, '') : text).replace(/[\s*_`]/g, '').replace(TOKEN_RE, '');
	const countOf = (text: string, char: string) => text.split(char).length - 1;
	/** The delimiters of a Markdown text as a reader takes them: longest first, left to right. */
	const DELIMITER_RE = /\*\*|__|\*|_|`/g;
	const delimitersOf = (text: string) =>
		[...text.matchAll(DELIMITER_RE)].map((match) => ({
			kind: match[0],
			at: match.index,
			end: match.index + match[0].length,
		}));
	const KIND_OF: Record<string, string> = {
		strong: '**',
		b: '**',
		em: '*',
		i: '*',
		u: '__',
		code: '`',
	};
	/**
	 * The pairs of a Markdown text that READ as emphasis or code, as a reader takes them
	 * (stated here, not borrowed from the engine): code spans first (a backtick and the next
	 * one; what is inside is literal), then, longest delimiter first, an opener has a
	 * non-space after it, a closer a non-space before it and takes the nearest open one of its
	 * kind, with letters or a token between.
	 */
	const readingPairs = (text: string) => {
		const pairs: {
			kind: string;
			open: number;
			openEnd: number;
			close: number;
			closeEnd: number;
		}[] = [];
		const code: [number, number][] = [];
		const ticks = [...text.matchAll(/`/g)].map((match) => match.index);
		for (let i = 0; i + 1 < ticks.length; i += 2) {
			const open = ticks[i] as number;
			const close = ticks[i + 1] as number;
			if (close > open + 1) {
				code.push([open, close]);
				pairs.push({ kind: '`', open, openEnd: open + 1, close, closeEnd: close + 1 });
			}
		}
		const inCode = (at: number) => code.some(([open, close]) => at >= open && at <= close);
		const stacks = new Map<string, { at: number; end: number }[]>();
		for (const item of delimitersOf(text)) {
			if (item.kind === '`' || inCode(item.at)) continue;
			const before = text[item.at - 1];
			const after = text[item.end];
			const stack = stacks.get(item.kind) ?? [];
			stacks.set(item.kind, stack);
			const top = stack.at(-1);
			const between = top ? text.slice(top.end, item.at) : '';
			if (
				top &&
				before !== undefined &&
				/\S/.test(before) &&
				(lettersOf(between, true) !== '' || /\[\[\[\d+\]\]\]/.test(between))
			) {
				stack.pop();
				pairs.push({
					kind: item.kind,
					open: top.at,
					openEnd: top.end,
					close: item.at,
					closeEnd: item.end,
				});
			} else if (after !== undefined && /\S/.test(after)) {
				stack.push({ at: item.at, end: item.end });
			}
		}
		return pairs;
	};
	const tally = (names: string[]) => {
		const counts = new Map<string, number>();
		for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
		return counts;
	};
	/**
	 * Emphasis on other words than the source's (final review, F1), stated here, not borrowed
	 * from the engine. A word: a run of letters, digits and combining marks; in a script
	 * written without spaces (Han, kana, Thai, Lao, Khmer, Myanmar) each character is one and
	 * none is "inside a word". A token has no width here.
	 */
	const NO_SPACE =
		/[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Thai}\p{sc=Lao}\p{sc=Khmer}\p{sc=Myanmar}]/u;
	const inWord = (char: string | undefined) =>
		char !== undefined && /[\p{L}\p{N}\p{M}]/u.test(char) && !NO_SPACE.test(char);
	const wordsIn = (text: string) =>
		[...text.replace(TOKEN_RE, ' ').matchAll(/[\p{L}\p{N}\p{M}]+/gu)].flatMap((run) => {
			const chars = [...run[0]];
			const pieces: string[] = [];
			let piece = '';
			for (const char of chars) {
				if (NO_SPACE.test(char)) {
					if (piece) pieces.push(piece);
					pieces.push(char);
					piece = '';
				} else piece += char;
			}
			if (piece) pieces.push(piece);
			return pieces.map((word) => word.toLowerCase());
		});
	/** words, tokens and punctuation runs (the delimiters aside): what a translation may keep */
	const itemsIn = (text: string) => {
		const items = [...text.matchAll(TOKEN_RE)].map((match) => match[0]);
		const rest = text.replace(TOKEN_RE, ' ');
		items.push(...wordsIn(rest));
		items.push(...(rest.match(/[^\s*_`\p{L}\p{N}\p{M}]+/gu) ?? []));
		return items;
	};
	/** the character beside an edge, through any token */
	const besideEdge = (text: string, index: number, step: -1 | 1) => {
		let at = index;
		for (;;) {
			const match =
				step < 0
					? /\[\[\[\d+\]\]\]$/.exec(text.slice(0, at + 1))
					: /^\[\[\[\d+\]\]\]/.exec(text.slice(at));
			if (!match) return text[at];
			at += step * match[0].length;
		}
	};
	type Pair = { kind: string; open: number; openEnd: number; close: number; closeEnd: number };
	/** why a span the model wrote is not its source span — or '' */
	const movedBy = (sent: string, had: Pair, wrote: string, got: Pair) => {
		if (!inWord(besideEdge(sent, had.open - 1, -1)) && inWord(besideEdge(wrote, got.open - 1, -1)))
			return 'opens inside a word';
		if (!inWord(besideEdge(sent, had.closeEnd, 1)) && inWord(besideEdge(wrote, got.closeEnd, 1)))
			return 'closes inside a word';
		const shareOf = (text: string, pair: Pair) => {
			const all = wordsIn(text).length;
			return all === 0 ? null : wordsIn(text.slice(pair.openEnd, pair.close)).length / all;
		};
		const before = shareOf(sent, had);
		const after = shareOf(wrote, got);
		if (before !== null && after !== null && (after < before / 2 || after > before * 2))
			return `covers ${after.toFixed(2)} of its words, the source ${before.toFixed(2)}`;
		const inBefore = tally(itemsIn(sent.slice(had.openEnd, had.close)));
		const inAfter = tally(itemsIn(wrote.slice(got.openEnd, got.close)));
		const allBefore = tally(itemsIn(sent));
		const allAfter = tally(itemsIn(wrote));
		for (const item of new Set([...inBefore.keys(), ...inAfter.keys()])) {
			const a = inBefore.get(item) ?? 0;
			const b = inAfter.get(item) ?? 0;
			const outA = (allBefore.get(item) ?? 0) - a;
			const outB = (allAfter.get(item) ?? 0) - b;
			if ((b > a && outB < outA) || (b < a && outB > outA)) return `'${item}' changed sides`;
		}
		return '';
	};

	function deviationProblems(source: string, run: Run): string[] {
		const problems: string[] = [];
		const answers = [...run.outputs.keys()]
			.sort((a, b) => a - b)
			.map((index) => ({
				sent: run.prepared.blocks[index].text as string,
				text: R.strip_added_paragraph(
					run.prepared.blocks[index].text,
					run.outputs.get(index) ?? '',
				) as string,
			}));
		const modelText = answers.map((answer) => answer.text).join(' ');
		const savedHtml = run.prepared.to_html(run.accumulated) as string;
		const savedText = visibleText(savedHtml);

		// a. the model's letters, nothing else
		if (lettersOf(savedText) !== lettersOf(modelText, true)) {
			problems.push(
				`letters differ from the model's\n     saved ${JSON.stringify(savedText)}\n     model ${JSON.stringify(modelText)}`,
			);
		}
		// b. the record's literals, every one
		for (const char of META) {
			const saved = countOf(visibleText(run.out), char);
			const had = countOf(visibleText(source), char);
			if (saved !== had) problems.push(`'${char}': saved ${saved}, the record has ${had}`);
		}
		// c. no markup as visible text
		const visibleMarkup = (savedText.match(TAG_SHAPE) ?? []).length;
		const sourceMarkup = (visibleText(source).match(TAG_SHAPE) ?? []).length;
		if (visibleMarkup > sourceMarkup)
			problems.push(`visible markup: ${savedText.match(TAG_SHAPE)?.join(' ')}`);
		// d. the source's elements
		const saved = tally(elementNames(run.out));
		const original = tally(elementNames(source));
		// an emphasis run cut between two blocks may come back as two runs when the model moved
		// the balancing delimiters (run_blocks then cannot rejoin them): one more per such cut
		const split = new Map<string, number>();
		for (const block of run.prepared.blocks) {
			for (const delimiter of (block.closed as string | undefined)?.match(/\*\*|__|\*/g) ?? []) {
				const tag =
					delimiter === '__'
						? 'u'
						: delimiter === '**'
							? run.prepared.emphasis_tags.bold
							: run.prepared.emphasis_tags.italic;
				split.set(tag, (split.get(tag) ?? 0) + 1);
			}
		}
		for (const name of new Set([...saved.keys(), ...original.keys()])) {
			const got = saved.get(name) ?? 0;
			const had = original.get(name) ?? 0;
			if (MD_INLINE.has(name) ? got > had + (split.get(name) ?? 0) : got !== had) {
				problems.push(`<${name}>: saved ${got}, source ${had}`);
			}
		}
		// e. every emphasis / code element of the model's text is one the model delimited. The
		// bounds of a span are the delimiters the model wrote, and the edges of an answer
		// whose SEGMENT has a delimiter of that kind at that edge (the wrapper of a wholly
		// emphasised segment, the balancing delimiters of a run cut between blocks: the
		// engine restores those, the model never owned them).
		const bounds: { kind: string; at: number; end: number }[] = [];
		let offset = 0;
		for (const answer of answers) {
			for (const item of delimitersOf(answer.text)) {
				bounds.push({ kind: item.kind, at: offset + item.at, end: offset + item.end });
			}
			const sent = answer.sent.trim();
			for (const kind of ['**', '__', '*', '`']) {
				if (sent.startsWith(kind)) bounds.push({ kind, at: offset, end: offset });
				if (sent.endsWith(kind)) {
					const end = offset + answer.text.length;
					bounds.push({ kind, at: end, end });
				}
			}
			offset += answer.text.length + 1;
		}
		const delimited = new Map<string, Set<string>>();
		for (const open of bounds) {
			for (const close of bounds) {
				if (close.kind !== open.kind || close.at < open.end) continue;
				const letters = lettersOf(modelText.slice(open.end, close.at), true);
				if (!delimited.has(open.kind)) delimited.set(open.kind, new Set());
				delimited.get(open.kind)?.add(letters);
			}
		}
		for (const element of elementTexts(savedHtml, new Set(Object.keys(KIND_OF)))) {
			const letters = lettersOf(element.text);
			// tokens only: none of the model's text (a block nobody translated, a shielded
			// span) — its count is leg d's
			if (letters === '') continue;
			const kind = KIND_OF[element.name] as string;
			if (!delimited.get(kind)?.has(letters)) {
				problems.push(
					`<${element.name}> spans ${JSON.stringify(element.text)}, which the model did not delimit`,
				);
			}
		}
		// f. no emphasis lost the model did not drop (a delimiter written inside a code span
		// is not one: code is literal)
		if (run.report.emphasis_lost > 0) {
			// the pairs of each kind a text READS as (F1: delimiters that do not read as a pair
			// are deleted, so a model that wrote them but no pair dropped its emphasis)
			const pairsOf = (text: string) => tally(readingPairs(text).map((pair) => pair.kind));
			const dropped = answers.some((answer) => {
				const sent = pairsOf(answer.sent);
				const wrote = pairsOf(answer.text);
				return [...sent].some(([kind, count]) => (wrote.get(kind) ?? 0) < count);
			});
			if (!dropped)
				problems.push(
					`emphasis lost (${run.report.emphasis_lost}) though the model wrote every delimiter`,
				);
		}
		// g. a CLEAN save (no warning) puts emphasis only where the source had it, or where the
		// model wrote a pair that reads as one while writing no more of that kind than its
		// segment had — the engine chose nothing (re-review 6, F1). The bounds are leg e's,
		// with the model's READING pairs in place of any two delimiters: a pair the engine made
		// out of delimiters that do not read ('Rome* and *Ostia') has none.
		if (run.report.uncertain_count === 0) {
			// the source's emphasis in the same token form as the saved text (its own Markdown,
			// unrestored), so a mark reads the same on both sides
			const sourceSpans = new Set(
				elementTexts(run.prepared.to_html(run.prepared.md), new Set(Object.keys(KIND_OF))).map(
					(element) => `${KIND_OF[element.name]}|${lettersOf(element.text)}`,
				),
			);
			const opens: { kind: string; end: number }[] = [];
			const closes: { kind: string; at: number }[] = [];
			let at = 0;
			for (const answer of answers) {
				const wrote = readingPairs(answer.text);
				const had = tally(readingPairs(answer.sent).map((pair) => pair.kind));
				for (const pair of wrote) {
					if (wrote.filter((other) => other.kind === pair.kind).length > (had.get(pair.kind) ?? 0))
						continue;
					opens.push({ kind: pair.kind, end: at + pair.openEnd });
					closes.push({ kind: pair.kind, at: at + pair.close });
				}
				const sent = answer.sent.trim();
				for (const kind of ['**', '__', '*', '`']) {
					if (sent.startsWith(kind)) opens.push({ kind, end: at });
					if (sent.endsWith(kind)) closes.push({ kind, at: at + answer.text.length });
				}
				at += answer.text.length + 1;
			}
			const modelSpans = new Set<string>();
			for (const open of opens) {
				for (const close of closes) {
					if (close.kind === open.kind && close.at >= open.end)
						modelSpans.add(`${open.kind}|${lettersOf(modelText.slice(open.end, close.at), true)}`);
				}
			}
			for (const element of elementTexts(savedHtml, new Set(Object.keys(KIND_OF)))) {
				const kind = KIND_OF[element.name] as string;
				const letters = lettersOf(element.text);
				if (letters === '') continue;
				if (!sourceSpans.has(`${kind}|${letters}`) && !modelSpans.has(`${kind}|${letters}`)) {
					problems.push(
						`<${element.name}> spans ${JSON.stringify(element.text)} on a clean save: neither the source's emphasis nor a pair the model wrote`,
					);
				}
			}
			// …and a pair the model wrote is on its source span's words (final review, F1): each
			// one, in reading order, against the segment's of its kind, in reading order
			for (const answer of answers) {
				// the model's escaping of a token ('\\[\\[\\[1\\]\\]\\]') is not text (see lettersOf)
				const text = answer.text.replace(/\\(?=[[\]])/g, '');
				const had = readingPairs(answer.sent).sort((a, b) => a.open - b.open);
				const wrote = readingPairs(text).sort((a, b) => a.open - b.open);
				for (const kind of new Set(wrote.map((pair) => pair.kind))) {
					const theirs = had.filter((pair) => pair.kind === kind);
					const own = wrote.filter((pair) => pair.kind === kind);
					if (own.length > theirs.length) continue;
					own.forEach((pair, k) => {
						const why = movedBy(answer.sent, theirs[k] as Pair, text, pair);
						if (why)
							problems.push(
								`'${kind}' moved on a clean save (${why}): ${JSON.stringify(text.slice(pair.open, pair.closeEnd))}`,
							);
					});
				}
			}
		}
		return problems;
	}

	/** Deviant models: (text, random) => answer. */
	const DEVIANTS: Record<string, (text: string, random: () => number) => string> = {
		identity: (text) => text,
		stripBackslashes: (text) => text.replace(/\\/g, ''),
		empty: () => '',
		whitespaceOnly: () => '  \n ',
		tokensOnly: (text) => (text.match(TOKEN_RE) ?? []).join(''),
		addBreak: (text) => text.replace(' ', '<br>'),
		addBold: (text) => text.replace(/(\S+)/, '<b>$1</b>'),
		wrapTwice: (text) => `<p><p>${text}</p></p>`,
		wrap: (text) => `<p>${text}</p>`,
		newlines: (text, random) =>
			text.replace(/ /g, () => (random() < 0.2 ? (random() < 0.5 ? '\n' : '\n\n') : ' ')),
		addBackticks: (text) => text.replace(/(\S+)/, '`$1`'),
		dropBackticks: (text) => text.replace(/\\?`/g, ''),
		addStars: (text, random) =>
			text
				.split(' ')
				.map((word) =>
					random() < 0.2 ? `${['**', '*', '__'][Math.floor(random() * 3)]}${word}` : word,
				)
				.join(' '),
		dropStars: (text) => text.replace(/\*\*/, ''),
		swapTokens: (text, random) => {
			const tokens = text.match(TOKEN_RE) ?? [];
			if (tokens.length < 2) return text;
			const a = tokens[Math.floor(random() * tokens.length)] as string;
			const b = tokens[Math.floor(random() * tokens.length)] as string;
			return text.replace(a, '\u0001').replace(b, a).replace('\u0001', b);
		},
		dropToken: (text, random) => {
			const tokens = text.match(TOKEN_RE) ?? [];
			return tokens.length
				? text.replace(tokens[Math.floor(random() * tokens.length)] as string, '')
				: text;
		},
		dupToken: (text, random) => {
			const tokens = text.match(TOKEN_RE) ?? [];
			return tokens.length ? `${text} ${tokens[Math.floor(random() * tokens.length)]}` : text;
		},
		moveToken: (text, random) => {
			const tokens = text.match(TOKEN_RE) ?? [];
			if (!tokens.length) return text;
			const token = tokens[Math.floor(random() * tokens.length)] as string;
			const rest = text.replace(token, '');
			const at = Math.floor(random() * (rest.length + 1));
			return rest.slice(0, at) + token + rest.slice(at);
		},
		reverseWords: (text) => text.split(' ').reverse().join(' '),
		// the reviewer's model of re-review 5: literal stars at word edges, as a model that
		// never saw the record's own writes them
		starsAtWordEnds: (text, random) =>
			text
				.split(' ')
				.map((word) => (random() < 0.25 ? `${word}${random() < 0.5 ? '*' : '**'}` : word))
				.join(' '),
		// a model that escapes Markdown it thinks it sees
		addEscapes: (text) => text.replace(/([*_`[\]])/g, '\\$1'),
		moveDelimiter: (text, random) => {
			const at = text.search(/\*\*|\*|__/);
			if (at < 0) return text;
			const delimiter = (/^(\*\*|\*|__)/.exec(text.slice(at)) as RegExpExecArray)[0];
			const rest = text.slice(0, at) + text.slice(at + delimiter.length);
			const to = Math.floor(random() * (rest.length + 1));
			return rest.slice(0, to) + delimiter + rest.slice(to);
		},
	};

	/** Run `html` through the pipeline with a deviant answering each block with probability `rate`. */
	async function deviantRun(html: string, deviant: string, seed: number, rate = 0.5) {
		let state = seed >>> 0;
		const random = () => {
			state = (Math.imul(state, 1103515245) + 12345) >>> 0;
			return state / 4294967296;
		};
		const deviate = DEVIANTS[deviant] as (text: string, random: () => number) => string;
		return pipeline(html, (text) => (random() < rate ? deviate(text, random) : text));
	}

	const outcomeProblems = (html: string, run: Run) =>
		run.refusedBefore || run.failed.length > 0 || run.report.refused
			? []
			: deviationProblems(html, run);

	describe('deviant models: refused, or the model’s text in the source’s structure (H1, H2, M2)', () => {
		const H = '<p>Moneda de <a href="#x">plata</a> y <span class="k">oro</span> fina.</p>';
		/**
		 * The reviewer's adversarial cases: [name, source, model, expected outcome, and — where
		 * the oracle cannot see a misplaced literal — the exact saved value].
		 */
		const CASES: [string, string, (text: string) => string, 'refused' | 'saved', string?][] = [
			[
				'swap pair halves',
				H,
				(t) => t.replace('[[[1]]]plata[[[2]]]', '[[[2]]]plata[[[1]]]'),
				'saved',
			],
			[
				'swap two pairs',
				H,
				(t) =>
					t.replace(
						'[[[1]]]plata[[[2]]] y [[[3]]]oro[[[4]]]',
						'[[[3]]]oro[[[4]]] y [[[1]]]plata[[[2]]]',
					),
				'saved',
			],
			['drop all tokens', H, (t) => t.replace(TOKEN_RE, ''), 'saved'],
			['duplicate a token', H, (t) => t.replace('[[[1]]]', '[[[1]]][[[1]]]'), 'refused'],
			['invent a token', H, (t) => `${t} [[[9]]]`, 'saved'],
			['add bold', '<p>Moneda de plata fina.</p>', () => 'Moneda de **plata** fina.', 'saved'],
			['add code', '<p>Moneda de plata fina.</p>', () => 'Moneda de `plata` fina.', 'saved'],
			[
				'add html <br> (M2)',
				'<p>Moneda de plata fina.</p>',
				() => 'Moneda de<br>plata fina.',
				'refused',
			],
			[
				'add html <b> (M2)',
				'<p>Moneda de plata fina.</p>',
				() => 'Moneda de <b>plata</b> fina.',
				'refused',
			],
			['p wrapper twice (M2)', '<p>Moneda.</p>', (t) => `<p><p>${t}</p></p>`, 'refused'],
			[
				'literal <p> source, model wraps again (M2)',
				'<p>&lt;p&gt;texto&lt;/p&gt;</p>',
				(t) => `<p>${t}</p>`,
				'refused',
			],
			[
				'literal <p> source, model keeps it',
				'<p>&lt;p&gt;texto&lt;/p&gt; y más</p>',
				(t) => t,
				'saved',
			],
			['p wrapper', '<p>Moneda de plata fina.</p>', (t) => `<P>\n${t}\n</P>`, 'saved'],
			[
				'add heading syntax',
				'<p>Moneda de plata fina.</p>',
				() => '# Moneda de plata fina.',
				'saved',
			],
			[
				'add newlines in an item',
				'<ul><li>Moneda de plata fina.</li></ul>',
				() => 'Moneda de\n\nplata\nfina.',
				'saved',
			],
			// H1′ (re-review 5): the record's literals are tokens, so a model that drops
			// backslashes has none to drop — the save is the source
			[
				'backslashes dropped: nothing to drop (H1′)',
				'<p>Peso 2*3*4 g, ref. a__b__c, ceca l`Hospitalet y d`Urgell \\ fin.</p>',
				(t) => t.replace(/\\/g, ''),
				'saved',
				'<p>Peso 2*3*4 g, ref. a__b__c, ceca l`Hospitalet y d`Urgell \\ fin.</p>',
			],
			[
				'a backslash the answer ends with is a character (H1′)',
				'<p><em>uno dos</em></p>',
				() => '*uno dos\\',
				'saved',
				'<p><em>uno dos\\</em></p>',
			],
			[
				'a record whose text is only ** is never sent (H1′)',
				'<p>**</p><p>Fin.</p>',
				(t) => (t.includes('Fin') ? t : ''),
				'saved',
				'<p>**</p><p>Fin.</p>',
			],
			// the reviewer's H1′ table: a model that writes the literal stars it never saw
			// gets them deleted (they are not the record's), the record's own placed by repair
			// and REPORTED — and emphasis only where the model delimited it
			[
				'born star reordered (H1′)',
				'<p>Nacido *1890 en <em>Roma</em>.</p>',
				() => 'In *Rome* born *1890.',
				'saved',
			],
			[
				'footnote star (H1′)',
				'<p>Moneda de <em>plata</em>* (ver nota).</p>',
				() => 'Silver* *coin* (see note).',
				'saved',
			],
			[
				'footnote star kept order (H1′)',
				'<p>Moneda de <em>plata</em>* (ver nota).</p>',
				() => '*Silver** coin (see note).',
				'saved',
			],
			[
				'star + em (H1′)',
				'<p>Ceca de Roma* y <em>Ostia</em>.</p>',
				() => 'Mint of Rome* and *Ostia*.',
				'saved',
			],
			[
				'star + em reordered (H1′)',
				'<p>Ceca de Roma* y <em>Ostia</em>.</p>',
				() => 'Mint of *Ostia* and Rome*.',
				'saved',
			],
			[
				'star list leading (H1′)',
				'<p>* Ejemplar dudoso, <em>falso</em>.</p>',
				() => '* Doubtful specimen, *fake*.',
				'saved',
			],
			[
				'underscore snake (H1′)',
				'<p>campo id_ref y <u>nota</u></p>',
				() => 'field id_ref and __note__',
				'saved',
			],
			[
				'double underscore (H1′)',
				'<p>campo __init__ y <u>nota</u></p>',
				() => 'field __init__ and __note__',
				'refused',
			],
			[
				'backtick apostrophe + code (H1′)',
				'<p>l`Hospitalet y <code>x</code></p>',
				() => 'l`Hospitalet and `x`',
				'saved',
			],
			[
				'backtick apostrophe + code reordered (H1′)',
				'<p>l`Hospitalet y <code>x</code></p>',
				() => '`x` and l`Hospitalet',
				'saved',
			],
			[
				'bold + literal ** reordered (H1′)',
				'<p><strong>Nota</strong>: valor ** desconocido</p>',
				() => 'value ** unknown: **Note**',
				'saved',
			],
			[
				'ratings (H1′)',
				'<p>Valoración: *** (buena), * (mala)</p>',
				() => 'Rating: *** (good), * (bad)',
				'saved',
			],
			[
				'multiply compact (H1′)',
				'<p>3*4 y <em>más</em> 5*6</p>',
				() => '3*4 and *more* 5*6',
				'refused',
			],
			[
				'reconstructed form reordered (H1′)',
				'<p>Del indoeuropeo *kʷékʷlos, <em>rueda</em>.</p>',
				() => '*Wheel*, from Indo-European *kʷékʷlos.',
				'saved',
			],
			[
				'emphasis, literal, emphasis (H1′)',
				'<p><em>a</em>*<em>b</em></p>',
				() => '*a**b*',
				'saved',
			],
			[
				'invented backticks are deleted (L5)',
				'<p>Moneda de <em>plata</em> fina.</p>',
				() => 'Silver `coin` of *fine* `x',
				'saved',
				'<p>Silver coin of <em>fine</em> x</p>',
			],
			// the strict-pair reading: the model's emphasis is where it delimited it
			[
				'a stray star never pairs across words (H1′)',
				'<p>Moneda de <em>plata</em>* (ver nota).</p>',
				() => 'Silver* *coin* (see note).[[[1]]]',
				'saved',
				'<p>Silver <em>coin</em> (see note).*</p>',
			],
			[
				'model drops one bold delimiter',
				'<p>Uno <strong>dos</strong> tres</p>',
				(t) => t.replace('**dos**', '**dos'),
				'saved',
			],
			[
				'model triple star',
				'<p>Uno <strong>dos</strong> <em>tres</em></p>',
				() => '***dos tres***',
				'saved',
			],
			[
				'emphasis crossing emphasis',
				'<p><strong>a</strong> b <em>c</em></p>',
				() => '**a *b** c*',
				'refused',
			],
			['empty answer (H2)', H, () => '', 'refused'],
			['whitespace answer (H2)', H, () => '   ', 'refused'],
			['tokens-only answer (H2)', H, (t) => (t.match(TOKEN_RE) ?? []).join(''), 'refused'],
			// conform pairing (re-review 5, found by the 30000-seed deviant run): two delimiters
			// with nothing between never pair, and a code span is settled first
			[
				'an empty pair the model writes before its emphasis',
				'<p><u>Roma antigua</u> y más</p>',
				(t) => t.replace('__', '____'),
				'saved',
				'<p><u>Roma antigua</u> y más</p>',
			],
			[
				'a star the model writes inside a code span costs neither the code nor the emphasis',
				'<p><strong>Ceca <code>RIC II</code> rara</strong> fin</p>',
				(t) => t.replace('RIC', 'RIC**'),
				'saved',
				'<p><strong>Ceca <code>RIC II</code> rara</strong> fin</p>',
			],
			// F1 (re-review 6): delimiters that do not read as a pair are never paired by
			// position; more reading pairs than the segment's is a guess, refused
			[
				'flipped flanks (F1)',
				'<p><em>Roma</em> y Ostia</p>',
				() => 'Rome* and *Ostia',
				'saved',
				'<p>Rome and Ostia</p>',
			],
			[
				'an invented pair first (F1)',
				'<p>Uno <strong>dos</strong> tres</p>',
				() => '**Uno** **dos** tres',
				'refused',
			],
			[
				'split emphasis (F1)',
				'<p>Moneda <em>de plata fina</em></p>',
				() => '*Fine* silver *coin*',
				'refused',
			],
			[
				'a stray pair across words (F1)',
				'<p>Moneda de <strong>plata</strong> fina</p>',
				() => 'Fine ** silver ** coin',
				'saved',
				'<p>Fine  silver  coin</p>',
			],
			['a lone opener (F1)', '<p><em>Roma</em>, capital</p>', () => '*Rome, capital*', 'saved'],
			// F2: a Dédalo mark the model writes is refused, never saved mangled
			[
				'the model writes a TC mark (F2)',
				'<p>Hola mundo</p>',
				() => '[TC_00:00:01.000_TC] Hello world',
				'refused',
			],
			[
				'the model copies an index mark (F2)',
				'<p>Una ballena blanca</p>',
				() => 'A [index-n-1-ballena-data::data]white whale[/index-n-1-ballena-data::data]',
				'refused',
			],
			[
				'the model duplicates the source TC as text (F2)',
				'<p>[TC_00:00:01.000_TC]Hola mundo</p>',
				() => 'Hello [TC_00:00:01.000_TC] world',
				'refused',
			],
			// a draw mark is a token (final review, F2): its 'data:' never reaches the model
			[
				'a draw mark survives a translated text (F2)',
				`<p>Ver la zona ${DRAW} del mapa antiguo de la ciudad</p>`,
				(t) =>
					t
						.replace('Ver la zona', 'See the area')
						.replace('del mapa antiguo de la ciudad', 'of the old city map'),
				'saved',
				`<p>See the area ${DRAW} of the old city map</p>`,
			],
			[
				'a draw mark the model drops is put back, with a warning (F2)',
				`<p>Ver la zona ${DRAW} del mapa antiguo de la ciudad</p>`,
				() => 'See the area of the old city map',
				'saved',
			],
			[
				'a draw mark the model writes is refused (F2)',
				'<p>Ver la zona del mapa antiguo de la ciudad</p>',
				() => 'See [draw-n-2--data:5:data] the area of the old city map',
				'refused',
			],
			// L3 (re-review 5): no length ratio — a short answer is an answer
			[
				'a few characters for a long passage is not a loss (L3)',
				'<p>Moneda de plata acuñada en la ceca de Roma hacia el año 200 a.C.</p>',
				() => 'x.',
				'saved',
				'<p>x.</p>',
			],
			[
				'CJK: two characters for a long phrase (L3)',
				'<p>Lugar de procedencia desconocido</p>',
				() => '不明',
				'saved',
				'<p>不明</p>',
			],
			[
				'one item blank (H2)',
				'<ul><li>Anverso con cabeza laureada.</li><li>Reverso con jinete.</li></ul>',
				(t) => (t.startsWith('Reverso') ? '' : t),
				'refused',
			],
			['a short translation is not a loss', '<p>Sí, señor.</p>', () => 'Yes.', 'saved'],
			[
				'repetition loop',
				'<p>Moneda de plata fina acuñada en Roma.</p>',
				() => 'la moneda la moneda la moneda la moneda la moneda la moneda',
				'refused',
			],
			['reversed words', H, (t) => t.split(' ').reverse().join(' '), 'saved'],
		];
		for (const [name, html, model, expected, saved] of CASES) {
			test(name, async () => {
				const run = await pipeline(html, model);
				const refused = run.failed.length > 0 || run.report.refused;
				expect(
					refused ? 'refused' : 'saved',
					`${name}: ${JSON.stringify(run.out)} ${JSON.stringify(run.failed)}`,
				).toBe(expected);
				expect(outcomeProblems(html, run), name).toEqual([]);
				if (saved !== undefined)
					expect(browserSerialize(run.out), name).toBe(browserSerialize(saved));
			});
		}

		test('a translation cut mid-sentence never saves clean; a short CJK one does (L3)', async () => {
			const cut = await pipeline(
				'<p>La moneda fue acuñada en Roma. Tiene ley baja.</p>',
				() => 'The coin was minted in Rome. It has',
			);
			expect(cut.failed).toEqual([]);
			expect(cut.report.sentences_short).toEqual([1]);
			expect(cut.report.uncertain_count).toBeGreaterThan(0);
			const cjk = await pipeline('<p>Lugar de procedencia desconocido</p>', () => '不明');
			expect(cjk.report.sentences_short).toEqual([]);
			expect(cjk.report.uncertain_count).toBe(0);
			expect(cjk.report.refused).toBe(false);
		});

		test('a character the model wrote that conform deletes is never silent: the save carries a warning (F3)', async () => {
			const run = await pipeline('<p>Nombre del fichero</p>', () => 'file_name');
			expect(run.failed).toEqual([]);
			expect(browserSerialize(run.out)).toBe('<p>filename</p>');
			expect(run.report.residual).toEqual(['_']);
			expect(run.report.uncertain_count).toBeGreaterThan(0);
		});

		test('a draw mark never reaches the model; dropped, it is put back with a warning (F2)', async () => {
			const html = `<p>Ver la zona ${DRAW} del mapa antiguo de la ciudad</p>`;
			const dropped = await pipeline(html, () => 'See the area of the old city map');
			expect(dropped.sent.join()).not.toContain('draw');
			expect(dropped.failed).toEqual([]);
			expect(dropped.report.refused).toBe(false);
			expect(dropped.out).toContain(DRAW);
			expect(dropped.report.uncertain_count).toBeGreaterThan(0);
		});

		/**
		 * Every key of tr.js get_mark_pattern is a mark the pipeline shields (DEDALO_MARKS) or is
		 * named here with why it is not one — a new tr.js mark is red until it is decided
		 * (final review, F2: 'draw' was missed). The keys are read from tr.js's own switch, and
		 * each must answer a RegExp, so the reading cannot go stale.
		 */
		test('the shielded marks are every tr.js mark: derived from get_mark_pattern, minus a stated list (F2)', async () => {
			const { tr } = await import('../../client/dedalo/core/common/js/tr.js');
			const source = await Bun.file(join(CLIENT_COMMON, 'tr.js')).text();
			const body = source.slice(
				source.indexOf('get_mark_pattern : (mark) => {'),
				source.indexOf('//end get_mark_pattern'),
			);
			const keys = [...body.matchAll(/case '([^']+)'\s*:/g)].map((match) => match[1] as string);
			expect(keys).toContain('draw');
			for (const key of keys) expect(tr.get_mark_pattern(key), key).toBeInstanceOf(RegExp);
			/** not a mark of its own: a looser/combined spelling of shielded ones (each example is found whole) */
			const ALIASES: Record<string, string[]> = {
				tc_full: ['[TC_00:01:25.627_TC]'],
				geo_full: ['[geo-n-1--data:{"type":"Point"}:data]'],
				index: ['[index-n-1-a-data::data]', '[/index-n-1-a-data::data]'],
				referenceIn: ['[reference-n-6-ref-data:{}:data]'],
				referenceOut: ['[/reference-n-6-ref-data:{}:data]'],
			};
			/** not a Dédalo mark at all */
			const NOT_MARKS: Record<string, string> = {
				tc_value: 'the time inside a tc mark, never a tag of its own',
				p: 'block structure, carried by the Markdown',
				html_style: 'emphasis: Markdown carries it (strong/em/i/u)',
				strong: 'emphasis: Markdown carries it',
				em: 'emphasis: Markdown carries it',
				i: 'emphasis: Markdown carries it',
				u: 'emphasis: Markdown carries it',
				'apertium-notrans': 'an Apertium element: markup, shielded as a tag',
			};
			const marks = [...B.DEDALO_MARKS];
			expect(marks).toContain('draw');
			expect(
				[...keys].sort(),
				'every tr.js key is a mark, an alias or a stated non-mark — and nothing else',
			).toEqual(
				[...new Set([...marks, ...Object.keys(ALIASES), ...Object.keys(NOT_MARKS)])].sort(),
			);
			for (const [alias, examples] of Object.entries(ALIASES)) {
				for (const example of examples) {
					expect(
						B.extract_dedalo_marks(`a ${example} b`).map((item: { mark: string }) => item.mark),
						`${alias}: ${example}`,
					).toEqual([example]);
				}
			}
			// the worker's copy is the same list
			expect(B.mark_pattern_sources().map((item: { source: string }) => item.source)).toEqual(
				marks.map((mark: string) => (tr.get_mark_pattern(mark) as RegExp).source),
			);
		});

		test('emphasis the model moved onto other words saves with a warning, never clean (F1)', async () => {
			for (const [name, html, model] of [
				[
					'one word for its neighbour',
					'<p><strong>Sí</strong> 200 monedas</p>',
					() => 'Sí **200** monedas',
				],
				['an edge inside a word', '<p>Texto [<em>sic</em>] aquí</p>', () => 'Texto [si*c]* aquí'],
				['an edge alone, mid-word', '<p>Ver <em>Roma</em> hoy</p>', () => 'Ver R*oma* hoy'],
				[
					'one word of five, then four',
					'<p>Una <em>moneda</em> de plata fina</p>',
					() => '*Una moneda de plata* fina',
				],
				[
					'a mark out of the span',
					`<p>Fin <u>${TC}moneda</u> ya</p>`,
					(t: string) => t.replace('__[[[1]]]', '[[[1]]]__'),
				],
			] as const) {
				const run = await pipeline(html, model);
				expect(run.failed, name).toEqual([]);
				expect(run.report.refused, name).toBe(false);
				expect(run.report.emphasis_moved, name).toEqual([1]);
				expect(run.report.uncertain_count, name).toBeGreaterThan(0);
			}
			// a translation that keeps the emphasis on its own words is clean, CJK included
			for (const [html, model] of [
				['<p>Moneda de <strong>plata</strong> fina</p>', () => 'Fine **silver** coin'],
				['<p>Moneda de <strong>plata</strong> fina</p>', () => '上質な**銀**貨'],
				['<p>la ceca de <em>Roma</em></p>', () => 'the mint of *Rome*'],
			] as const) {
				const run = await pipeline(html, model);
				expect(run.report.emphasis_moved, html).toEqual([]);
				expect(run.report.uncertain_count, html).toBe(0);
			}
		});

		test('the elements whose content is not text to translate are restored whole (L1)', () => {
			for (const tag of [
				'pre',
				'xmp',
				'listing',
				'plaintext',
				'textarea',
				'noembed',
				'noframes',
				'title',
			]) {
				expect(M.RAW_ATOM_TAGS.has(tag), tag).toBe(true);
			}
		});

		test('the oracle is not vacuous: each of its eight checks rejects a doctored save', async () => {
			const html = '<p>Peso 2*3 g <em>uno</em> y <span class="k">x</span>.</p>';
			const run = await pipeline(html);
			const doctor = (
				accumulated: string,
				out = run.out,
				report = run.report,
				outputs = run.outputs,
			) => deviationProblems(html, { ...run, accumulated, out, report, outputs });
			expect(doctor(run.accumulated)).toEqual([]);
			// a. letters
			expect(doctor(run.accumulated.replace('Peso', 'Pesa')).join()).toContain('letters');
			// b. a literal of the record deleted
			expect(doctor(run.accumulated, run.out.replace('2*3', '23')).join()).toContain("'*'");
			// c. markup as text
			expect(doctor(`${run.accumulated} <b>`).join()).toContain('visible markup');
			// d. an element the source does not have
			expect(doctor(run.accumulated, `${run.out}<code>z</code>`).join()).toContain('<code>');
			// e. emphasis over text the model did not delimit
			expect(doctor(run.accumulated.replace('*uno* y', '*uno y*')).join()).toContain(
				'did not delimit',
			);
			// f. emphasis lost though the model wrote every delimiter
			expect(
				doctor(run.accumulated, run.out, { ...run.report, emphasis_lost: 1 }).join(),
			).toContain('emphasis lost');
			// g. a clean save with emphasis the engine made of delimiters that do not read as a
			// pair ('uno* y *x' saved as 'uno <em>y</em> x')
			const sent = run.prepared.blocks[0].text as string;
			expect(sent).toContain('*uno* y ');
			const unread = new Map([[0, sent.replace('*uno* y ', 'uno* y *')]]);
			expect(
				doctor(run.accumulated.replace('*uno* y ', 'uno *y* '), run.out, run.report, unread).join(),
			).toContain('on a clean save');
			// g′. a clean save with a READING pair the model moved onto other words (F1): 'uno'
			// out of the span, 'y' into it
			const moved = new Map([[0, sent.replace('*uno* y ', 'uno *y* ')]]);
			const movedProblems = doctor(
				run.accumulated.replace('*uno* y ', 'uno *y* '),
				run.out,
				run.report,
				moved,
			).join();
			expect(movedProblems).toContain('moved on a clean save');
			expect(movedProblems).not.toContain('neither the source');
		});

		/**
		 * A model that ONLY drops backslashes (otherwise identity) — the reviewer's H1′ model —
		 * must save N∘W(source) exactly, clean, or be refused: the record's literals are tokens,
		 * so there is nothing for it to drop, and nothing to guess.
		 */
		test(`a backslash-stripping model saves N∘W(source) or is refused: the corpus and ${FUZZ_SEEDS} generated documents (H1′)`, async () => {
			const failures: string[] = [];
			const sources = [
				...CORPUS.map(([, html]) => html),
				...Array.from({ length: FUZZ_SEEDS }, (_, k) => makeGenerator(k + 1).document()),
			];
			for (const html of sources) {
				const run = await pipeline(html, (text) => text.replace(/\\/g, ''));
				if (run.refusedBefore || run.failed.length > 0 || run.report.refused) continue;
				const got = browserSerialize(run.out);
				const want = expectedOf(html);
				if ((got !== want || run.report.uncertain_count !== 0) && failures.length < 5)
					failures.push(
						`${JSON.stringify(html)}\n  ${firstDivergence(got, want)} uncertain ${run.report.uncertain_count}`,
					);
			}
			expect(failures, failures.join('\n\n')).toEqual([]);
		});

		test(`seeded fuzz: ${FUZZ_SEEDS} generated documents × a deviant model`, async () => {
			const names = Object.keys(DEVIANTS);
			const failures: string[] = [];
			const outcomes = { refused: 0, saved: 0 };
			for (let seed = 1; seed <= FUZZ_SEEDS; seed++) {
				const html = makeGenerator(seed).document();
				const deviant = names[seed % names.length] as string;
				const run = await deviantRun(html, deviant, seed);
				if (run.refusedBefore) continue;
				if (run.failed.length > 0 || run.report.refused) outcomes.refused++;
				else outcomes.saved++;
				const problems = outcomeProblems(html, run);
				if (problems.length > 0 && failures.length < 5) {
					const answers = run.sent.map(
						(sent, k) =>
							`${JSON.stringify(sent)} → ${JSON.stringify([...run.outputs.values()][k])}`,
					);
					failures.push(
						`seed ${seed} (${deviant}): ${problems.join('\n  ')}\n  source ${JSON.stringify(html)}\n  answers:\n    ${answers.join('\n    ')}`,
					);
				}
			}
			expect(failures, failures.join('\n\n')).toEqual([]);
			// both outcomes are exercised
			expect(outcomes.refused).toBeGreaterThan(FUZZ_SEEDS * 0.1);
			expect(outcomes.saved).toBeGreaterThan(FUZZ_SEEDS * 0.3);
		});
	});

	describe('the <p> wrapper a model adds is removed, the source’s own is kept (F6)', () => {
		test('a model that wraps every answer in <p>…</p>', async () => {
			const html = '<ul><li>Uno.</li><li>Dos.</li></ul><p>Tres.</p>';
			const run = await pipeline(html, (text) => `<p>${text}</p>`);
			expect(browserSerialize(run.out)).toBe(expectedOf(html));
			expect(run.report.refused).toBe(false);
		});

		test('a source whose text reads <p>texto</p> keeps it under the same model', async () => {
			const html = '<p>&lt;p&gt;texto&lt;/p&gt;</p>';
			const run = await pipeline(html, (text) => text);
			expect(browserSerialize(run.out)).toBe(expectedOf(html));
		});
	});

	describe('what the model receives (identity alone cannot see it: shielding is exact too)', () => {
		test('an element with nothing to translate is ONE atom, and nothing is sent', async () => {
			for (const html of [
				'<table><tr><td> </td><td>\n</td></tr></table>',
				'<p class="c"> </p>',
				'<div>\n</div>',
			]) {
				const run = await expectIdentity(html, html);
				expect(run.md, html).toBe('[[[1]]]');
				expect(run.sent, html).toEqual([]);
			}
		});

		test('a <b>/<i> document travels as Markdown and comes back <b>/<i>', async () => {
			const run = await expectIdentity(
				'b/i',
				'<p>10&nbsp;km y <b>negrita</b> e <i>cursiva</i>, <b>otra</b></p>',
			);
			expect(run.sent).toEqual(['10\u00A0km y **negrita** e *cursiva*, **otra**']);
			// the minority name is shielded, never renamed (its close is hoisted: an edge token)
			const mixed = await expectIdentity('mixed', '<p><b>a</b> <b>b</b> <strong>c</strong></p>');
			expect(mixed.sent).toEqual(['**a** **b** [[[1]]]c']);
		});

		test('edge whitespace is hoisted out of the model input even where no token sits at the edge', () => {
			// segment_markdown hands leading whitespace to `sep`, so the converter never builds a
			// chunk that starts with a bare space: the leading half is pinned on build_blocks itself
			const [block] = B.build_blocks([{ text: ' uno ', sep: '' }], []);
			expect([block.prefix, block.text, block.suffix]).toEqual([' ', 'uno', ' ']);
		});
	});

	describe('block-level is an explicit list; every other element is inline (F5, M1)', () => {
		/** WHATWG HTML §15.3: the elements the UA stylesheet displays as block / list-item / table parts. */
		const UA_BLOCK = [
			'address',
			'article',
			'aside',
			'blockquote',
			'body',
			'caption',
			'center',
			'col',
			'colgroup',
			'dd',
			'details',
			'dialog',
			'dir',
			'div',
			'dl',
			'dt',
			'fieldset',
			'figcaption',
			'figure',
			'footer',
			'form',
			'frame',
			'frameset',
			'h1',
			'h2',
			'h3',
			'h4',
			'h5',
			'h6',
			'header',
			'hgroup',
			'hr',
			'html',
			'legend',
			'li',
			'listing',
			'main',
			'menu',
			'nav',
			'ol',
			'optgroup',
			'option',
			'p',
			'plaintext',
			'pre',
			'search',
			'section',
			'summary',
			'table',
			'tbody',
			'td',
			'tfoot',
			'th',
			'thead',
			'tr',
			'ul',
			'xmp',
		];
		/** Phrasing content (§3.2.5.2.5), the obsolete inline elements (§16), custom and unknown names. */
		const INLINE = [
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
			'foo',
			'x-card',
			'o:p',
			'selectedcontent',
		];
		/** Of INLINE, the ones that wrap text (no void, no raw atom, nothing the parser rewrites). */
		const WRAPS_TEXT = [
			'abbr',
			'bdi',
			'cite',
			'data',
			'del',
			'dfn',
			'ins',
			'kbd',
			'mark',
			'q',
			's',
			'samp',
			'small',
			'sub',
			'sup',
			'time',
			'var',
			'acronym',
			'big',
			'blink',
			'font',
			'nobr',
			'strike',
			'tt',
			'foo',
			'x-card',
			'o:p',
			'label',
			'button',
		];

		test('BLOCK_TAGS is the UA-stylesheet block set, exactly', () => {
			expect([...M.BLOCK_TAGS].sort()).toEqual([...UA_BLOCK].sort());
			for (const tag of UA_BLOCK) expect(M.is_block_tag(tag), tag).toBe(true);
		});

		test('phrasing, obsolete, custom and UNKNOWN elements are inline, and never split a paragraph', async () => {
			for (const tag of INLINE) expect(M.is_block_tag(tag), tag).toBe(false);
			for (const tag of WRAPS_TEXT) {
				await expectIdentity(`inline <${tag}>`, `<p>uno <${tag}>dos</${tag}> tres</p>`);
			}
			const unknown = await expectIdentity('unknown element', '<p>Texto <foo>x</foo> fin</p>');
			expect(unknown.sent).toEqual(['Texto [[[1]]]x[[[2]]] fin']);
		});
	});
}
