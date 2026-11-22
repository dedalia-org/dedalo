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
 * model-wrapper strip (F6), on the same chain.
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
	installParse5DomParser,
	mapWordTextNodes,
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
	 * text the model receives. Not inside an element restored whole (<pre>, <textarea>,
	 * <script>…: markdown_utils.js RAW_ATOM_TAGS), whose text never travels.
	 */
	const RESTORED_WHOLE = new Set([
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
		'pre',
	]);
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
			RESTORED_WHOLE,
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
	}

	/** THE pipeline with `model` as the translator (default: identity). */
	async function pipeline(
		html: string,
		model: (text: string) => string = (text) => text,
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
			};
		}
		const sent: string[] = [];
		const structuralSent: string[] = [];
		const byText = new Map<string, Record<string, string>>();
		for (const block of prepared.blocks) byText.set(block.text, block.restore_map);
		const run = await R.run_blocks({
			blocks: prepared.blocks,
			translate: async (text: string) => {
				sent.push(text);
				for (const local of text.match(/\[\[\[\d+\]\]\]/g) ?? []) {
					const global = byText.get(text)?.[local] ?? local;
					if (prepared.block_tokens.has(global)) structuralSent.push(global);
				}
				return model(text);
			},
			post: () => {},
		});
		expect(run.failed_blocks ?? []).toEqual([]);
		const { restored_text, report } = B.finish_translation(
			prepared,
			run.accumulated_text,
			run.repair_stats,
		);
		return { out: restored_text, report, sent, structuralSent, md: prepared.md };
	}

	/** The three identity assertions, with the case named in every message. */
	async function expectIdentity(name: string, html: string, expected = expectedOf(html)) {
		const run = await pipeline(html);
		expect(run.refusedBefore, `${name}: refused before the run`).toBeUndefined();
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
			const attrs =
				tag === 'a' ? ' href="#x"' : tag === 'span' && random() < 0.5 ? ' class="k"' : '';
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
			if (roll < 0.86) return '<hr>';
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

	describe('the inline set is the HTML phrasing-content set (F5)', () => {
		test('every phrasing-content and legacy inline tag is inline; block containers are not', async () => {
			for (const tag of [...M.PHRASING_CONTENT_TAGS, ...M.LEGACY_INLINE_TAGS]) {
				expect(M.is_inline_tag(tag), tag).toBe(true);
			}
			for (const tag of [
				'p',
				'div',
				'ul',
				'ol',
				'li',
				'table',
				'tr',
				'td',
				'h2',
				'blockquote',
				'pre',
				'hr',
				'dl',
			]) {
				expect(M.is_block_tag(tag), tag).toBe(true);
			}
			// the standard's list, complete: a dropped entry is red
			expect(M.PHRASING_CONTENT_TAGS.size).toBe(56);
			// every legacy tag renders inside a paragraph without splitting it
			for (const tag of M.LEGACY_INLINE_TAGS) {
				await expectIdentity(`legacy <${tag}>`, `<p>uno <${tag}>dos</${tag}> tres</p>`);
			}
		});
	});
}
