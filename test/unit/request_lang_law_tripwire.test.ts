/**
 * THE REQUEST-LANGUAGE LAW (T2 B10 — OX7-1, SL-2, O15-3, THES-06; one law):
 * "request identity (application lang, data lang) is read from the request
 * scope; a language is configuration, never a literal."
 *
 * ONE tripwire, two rules, ZERO allowlist in this file. Scans every `.ts`
 * under src/, tools/ and scripts/ (the shared write-path lister; comments stripped, line numbers kept):
 *
 *   RULE 1 — no install-language read outside `src/config/` and the
 *   request-lang module (`src/core/resolve/request_lang.ts`, whose accessors
 *   ARE the fallback): `config.menu.applicationLang` / `config.menu.dataLang`
 *   (also `menu.X` after a destructure, `menu['X']`, `const { dataLang } =
 *   config.menu`) and an env read of `DATA_LANG` / `APPLICATION_LANG` (the
 *   `readString('DATA_LANG')` shape SL-2 deleted from the search assembler).
 *   On a request path the value is the INSTALL default, not the caller's:
 *   a label, a sort or a write lands in a language the user did not choose.
 *   `currentApplicationLang()` / `currentDataLang()` answer instead (and fall
 *   back to the install default outside any scope).
 *
 *   RULE 2 — no language-code literal used as a DEFAULT: `?? 'lg-…'`,
 *   `|| 'lg-…'` (and `??=` / `||=`), a default parameter or destructuring
 *   default `= 'lg-…'`. `lg-nolan` is the no-language constant, not a
 *   language — excluded by definition.
 *
 * A DELIBERATE install-language read (a scope SEED: dispatch, a scheduler or
 * an indexer opening its own scope; a test-data generator; the installer
 * deriving the configuration itself) is a NAMED EXEMPTION next to the code,
 * as a `//` comment:
 *
 *     // lang-law-exempt(<name>): <reason, ≥ 20 chars>
 *
 * A STANDALONE marker (the comment is alone on its line) covers ONLY the next
 * line; a TRAILING marker (code before it on the line) covers ONLY its own
 * line. A marker is a real comment — the same scanner that blanks comments
 * finds it, so the text inside a string or template literal is never one.
 * Verified here: every marker covers EXACTLY ONE offender (none = stale, two =
 * one name hiding a second read), names are unique, reasons are stated. There
 * is no list of exempt files in this test — moving the reason away from the
 * code is how it rots.
 *
 * Anti-vacuity: the corpus is floored, the detector must find the request-lang
 * module's own fallback read (allowed by definition, so it proves the scanner
 * sees a real read), and every shape — positive and negative — is driven on
 * synthetic text.
 *
 * HONEST LIMITS: textual, not data-flow. A literal reaching a default through
 * a ternary (`x !== undefined ? x : 'lg-spa'`), an `if (x === undefined) x =
 * 'lg-spa'` assignment, or a named constant holding a language and passed as
 * one is not a default SHAPE and is not seen; a config value aliased through a
 * second binding (`const m = config.menu; m.dataLang`) is not seen. The
 * behavioural twins live in request_lang_law_native and the per-site gates.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { REPO_ROOT, writePathSourceFiles } from '../helpers/write_path_corpus.ts';

/** The request-lang module: its accessors' fallback IS the install default. */
const REQUEST_LANG_MODULE = 'src/core/resolve/request_lang.ts';

/** Corpus floor: a walk that reads fewer files is a broken walk, not a smaller engine. */
const CORPUS_FLOOR = 1000;

/** One comment span of a source text: [start, end) offsets, the `//` or `/*` included. */
interface CommentSpan {
	start: number;
	end: number;
}

/**
 * Blank every comment (line + block) to spaces, keeping newlines and every
 * string/template literal intact, so offsets still map to source lines; and
 * report where each comment was (the marker scanner reads ONLY those spans).
 */
function scanComments(source: string): { code: string; comments: CommentSpan[] } {
	let out = '';
	const comments: CommentSpan[] = [];
	let index = 0;
	const length = source.length;
	/** Template-literal nesting: each entry is the brace depth of an open `${`. */
	const templateStack: number[] = [];
	let braceDepth = 0;
	const blank = (text: string) => text.replace(/[^\n]/g, ' ');
	const readString = (quote: string): void => {
		let end = index + 1;
		while (end < length) {
			const char = source[end];
			if (char === '\\') {
				end += 2;
				continue;
			}
			if (char === quote || char === '\n') break;
			end += 1;
		}
		out += source.slice(index, end + 1);
		index = end + 1;
	};
	const readTemplate = (): void => {
		// From a backtick or a `}` closing an interpolation, up to the next `${` or closing backtick.
		let end = index + 1;
		while (end < length) {
			const char = source[end];
			if (char === '\\') {
				end += 2;
				continue;
			}
			if (char === '`') break;
			if (char === '$' && source[end + 1] === '{') {
				out += source.slice(index, end + 2);
				index = end + 2;
				templateStack.push(braceDepth);
				braceDepth += 1;
				return;
			}
			end += 1;
		}
		out += source.slice(index, end + 1);
		index = end + 1;
	};
	while (index < length) {
		const char = source[index] as string;
		const next = source[index + 1];
		if (char === '/' && next === '/') {
			const end = source.indexOf('\n', index);
			const stop = end === -1 ? length : end;
			comments.push({ start: index, end: stop });
			out += blank(source.slice(index, stop));
			index = stop;
		} else if (char === '/' && next === '*') {
			const end = source.indexOf('*/', index + 2);
			const stop = end === -1 ? length : end + 2;
			comments.push({ start: index, end: stop });
			out += blank(source.slice(index, stop));
			index = stop;
		} else if (char === '"' || char === "'") {
			readString(char);
		} else if (char === '`') {
			readTemplate();
		} else if (char === '{') {
			braceDepth += 1;
			out += char;
			index += 1;
		} else if (char === '}') {
			braceDepth -= 1;
			if (templateStack.length > 0 && templateStack[templateStack.length - 1] === braceDepth) {
				templateStack.pop();
				readTemplate();
			} else {
				out += char;
				index += 1;
			}
		} else {
			out += char;
			index += 1;
		}
	}
	return { code: out, comments };
}

/** {@link scanComments}' code half: comments blanked, offsets kept. */
function stripComments(source: string): string {
	return scanComments(source).code;
}

/** A language code literal that is not the no-language constant. */
const LANG_LITERAL = String.raw`(['"\x60])lg-(?!nolan\b)[a-z]{2,8}\1`;

/** RULE 1 — an install-language read. */
const RULE1_SHAPES: readonly RegExp[] = [
	/\bmenu\s*\??\.\s*(?:applicationLang|dataLang)\b/g,
	/\bmenu\s*\[\s*['"](?:applicationLang|dataLang)['"]\s*\]/g,
	/\{[^{}]*\b(?:applicationLang|dataLang)\b[^{}]*\}\s*=\s*config\s*\.\s*menu\b/g,
	/\b(?:readEnv|readString|readOptionalString|requireString|requireEnv)\s*\(\s*['"](?:DEDALO_)?(?:DATA_LANG|APPLICATION_LANG)['"]/g,
];

/** RULE 2 — a language literal used as a default. */
const RULE2_SHAPES: readonly RegExp[] = [
	new RegExp(String.raw`(?:\?\?|\|\|)=?\s*${LANG_LITERAL}`, 'g'),
	// Default parameter / destructuring default: `= 'lg-…'` followed by `,` `)` `}` `]`
	// — never `==`/`===`/`!=`/`<=`/`>=`/`=>`, never a statement (`;`).
	new RegExp(String.raw`(?<![=!<>+\-*/%&|^?])=(?![=>])\s*${LANG_LITERAL}\s*[,)}\]]`, 'g'),
];

interface Offender {
	file: string;
	line: number;
	rule: 1 | 2;
	text: string;
}

/** Offenders of both rules in one source text (comments stripped first). */
function findOffenders(file: string, source: string, rules: { rule1: boolean }): Offender[] {
	const code = stripComments(source);
	const lineOf = (offset: number): number => code.slice(0, offset).split('\n').length;
	const lines = source.split('\n');
	const offenders: Offender[] = [];
	const scan = (shapes: readonly RegExp[], rule: 1 | 2) => {
		for (const shape of shapes) {
			for (const match of code.matchAll(new RegExp(shape.source, shape.flags))) {
				const line = lineOf(match.index ?? 0);
				offenders.push({ file, line, rule, text: (lines[line - 1] ?? '').trim() });
			}
		}
	};
	if (rules.rule1) scan(RULE1_SHAPES, 1);
	scan(RULE2_SHAPES, 2);
	return offenders;
}

interface Marker {
	file: string;
	line: number;
	/** The ONE line it exempts: the next line (standalone) or its own (trailing). */
	coveredLine: number;
	name: string;
	reason: string;
}

/** A marker comment, from its `//` to the end of the line. */
const MARKER = /^\/\/\s*lang-law-exempt\(([a-z0-9_.-]+)\):\s*(.*)$/;

/**
 * The exemption markers of one source text — read ONLY inside real `//`
 * comment spans (scanComments), so marker-shaped text in a string or a
 * template literal is never a marker.
 */
function findMarkers(file: string, source: string): Marker[] {
	const { code, comments } = scanComments(source);
	const codeLines = code.split('\n');
	const markers: Marker[] = [];
	for (const span of comments) {
		const match = MARKER.exec(source.slice(span.start, span.end));
		if (match === null) continue;
		const line = source.slice(0, span.start).split('\n').length;
		const standalone = (codeLines[line - 1] ?? '').trim() === '';
		markers.push({
			file,
			line,
			coveredLine: standalone ? line + 1 : line,
			name: match[1] as string,
			reason: (match[2] ?? '').trim(),
		});
	}
	return markers;
}

/** A marker covers an offender on its ONE covered line. */
const covers = (marker: Marker, offender: Offender): boolean =>
	marker.file === offender.file && offender.line === marker.coveredLine;

/** Markers covering no offender (stale) and more than one (ambiguous). */
function dishonestMarkers(
	markers: readonly Marker[],
	offenders: readonly Offender[],
): { stale: string[]; ambiguous: string[] } {
	const label = (marker: Marker) => `${marker.file}:${marker.line} ${marker.name}`;
	const count = (marker: Marker) => offenders.filter((offender) => covers(marker, offender)).length;
	return {
		stale: markers.filter((marker) => count(marker) === 0).map(label),
		ambiguous: markers.filter((marker) => count(marker) > 1).map(label),
	};
}

function corpus(): { file: string; source: string }[] {
	// The shared write-path lister (src, tools, scripts; .test.ts excluded) —
	// census_derivation_tripwire: a gate never picks its own walk root.
	return (
		writePathSourceFiles()
			// src/config/ IS where a language is configuration — reading its own keys is the point.
			.filter((file) => !file.startsWith('src/config/'))
			.map((file) => ({ file, source: readFileSync(join(REPO_ROOT, file), 'utf8') }))
	);
}

const FILES = corpus();
const OFFENDERS = FILES.flatMap(({ file, source }) =>
	findOffenders(file, source, { rule1: file !== REQUEST_LANG_MODULE }),
);
const MARKERS = FILES.flatMap(({ file, source }) => findMarkers(file, source));
const UNEXEMPTED = OFFENDERS.filter(
	(offender) => !MARKERS.some((marker) => covers(marker, offender)),
);

const describeOffender = (offender: Offender) =>
	`${offender.file}:${offender.line} [rule ${offender.rule}] ${offender.text}`;

describe('request-language law (T2 B10)', () => {
	test('floor: the corpus is the whole engine, and the scanner sees a real read', () => {
		expect(FILES.length).toBeGreaterThan(CORPUS_FLOOR);
		// The request-lang module's fallback is the one read allowed BY DEFINITION
		// (it is not counted as an offender); the scanner must still see it, or a
		// blind detector would pass the whole corpus.
		const home = FILES.find((item) => item.file === REQUEST_LANG_MODULE);
		expect(home).toBeDefined();
		const seen = findOffenders(REQUEST_LANG_MODULE, home?.source ?? '', { rule1: true });
		expect(seen.some((offender) => offender.rule === 1)).toBe(true);
		expect(relative(REPO_ROOT, join(REPO_ROOT, REQUEST_LANG_MODULE))).toBe(REQUEST_LANG_MODULE);
	});

	test('RULE 1 + RULE 2: no install-language read and no language-literal default without a named exemption', () => {
		if (UNEXEMPTED.length > 0) {
			throw new Error(
				`request-language law broken:\n  ${UNEXEMPTED.map(describeOffender).join('\n  ')}\n` +
					'Read the request scope: currentApplicationLang() / currentDataLang() ' +
					'(src/core/resolve/request_lang.ts). A deliberate install-language read is a named ' +
					'exemption on the line or the line above: `// lang-law-exempt(<name>): <reason>`.',
			);
		}
		expect(UNEXEMPTED).toEqual([]);
	});

	test('every exemption is honest: covers exactly one offender, unique name, stated reason', () => {
		const { stale, ambiguous } = dishonestMarkers(MARKERS, OFFENDERS);
		expect(stale).toEqual([]);
		expect(ambiguous).toEqual([]);
		const names = MARKERS.map((marker) => marker.name);
		expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
		const reasonless = MARKERS.filter((marker) => marker.reason.length < 20).map(
			(marker) => `${marker.file}:${marker.line} ${marker.name}`,
		);
		expect(reasonless).toEqual([]);
	});
});

describe('the detector, driven on synthetic text (positive + negative controls)', () => {
	const rulesOf = (source: string) =>
		findOffenders('synthetic.ts', source, { rule1: true }).map((offender) => offender.rule);

	test('RULE 1 shapes are detected', () => {
		for (const source of [
			'const lang = config.menu.applicationLang;',
			'f(config.menu.dataLang);',
			'const { menu } = config;\nconst x = menu.dataLang;',
			"const x = config.menu['dataLang'];",
			'const { dataLang } = config.menu;',
			"const L = readString('DATA_LANG');",
			"const L = readEnv('DEDALO_APPLICATION_LANG');",
			'const x = config.menu?.applicationLang;',
		]) {
			expect(rulesOf(source), source).toContain(1);
		}
	});

	test('RULE 2 shapes are detected', () => {
		for (const source of [
			"const lang = input.lang ?? 'lg-eng';",
			"const lang = input.lang || 'lg-spa';",
			"lang ??= 'lg-cat';",
			"f(context.lang ??\n\t'lg-spa',\n);",
			"function f(tipo: string, lang = 'lg-spa') {}",
			"function f(tipo: string, lang: string = 'lg-spa', x = 1) {}",
			"const { lang = 'lg-eng' } = options;",
			'const lang = input.lang ?? "lg-eng";',
			'const lang = input.lang ?? `lg-eng`;',
		]) {
			expect(rulesOf(source), source).toContain(2);
		}
	});

	test('NOT offenders: lg-nolan, comparisons, statements, comments, dataLangSync, config.lang', () => {
		for (const source of [
			"const lang = input.lang ?? 'lg-nolan';",
			"function f(lang = 'lg-nolan') {}",
			"if (lang === 'lg-eng') return;",
			"if (lang == 'lg-eng' || x) return;",
			"const MASTER_SOURCE_LANG = 'lg-eng';",
			"recorded.lang = 'lg-spa';",
			"const item = { lang: 'lg-eng', value: 1 };",
			"// const lang = input.lang ?? 'lg-eng'; config.menu.dataLang",
			"/* lang = 'lg-spa', config.menu.applicationLang */",
			'const sync = config.menu.dataLangSync;',
			'const main = config.lang.dataLangDefault;',
			"const s = 'a // b'; const t = config.lang.dataLangDefault;",
			'const t = `${x}` + y;',
		]) {
			expect(rulesOf(source), source).toEqual([]);
		}
	});

	test('a template literal with an interpolation does not hide the code after it', () => {
		expect(rulesOf("const s = `${a}`; const lang = x ?? 'lg-eng';")).toEqual([2]);
		expect(rulesOf('const s = `a ${b ? `c` : d} e`; f(config.menu.dataLang);')).toEqual([1]);
	});

	/** The offender lines of `source` no marker covers, plus its dishonest markers. */
	const judge = (source: string) => {
		const offenders = findOffenders('s.ts', source, { rule1: true });
		const markers = findMarkers('s.ts', source);
		return {
			offenders: offenders.map((offender) => offender.line),
			markers: markers.map((marker) => marker.name),
			uncovered: offenders
				.filter((offender) => !markers.some((m) => covers(m, offender)))
				.map((offender) => offender.line),
			...dishonestMarkers(markers, offenders),
		};
	};

	test('a STANDALONE marker covers the next line only', () => {
		const verdict = judge(
			[
				'// lang-law-exempt(seed.one): the scope seed reads the install default by design',
				'const a = config.menu.dataLang;',
				'const b = config.menu.dataLang;',
			].join('\n'),
		);
		expect(verdict.offenders).toEqual([2, 3]);
		expect(verdict.markers).toEqual(['seed.one']);
		expect(verdict.uncovered).toEqual([3]);
		expect(verdict.stale).toEqual([]);
	});

	test('a TRAILING marker covers its own line only — never the next', () => {
		const verdict = judge(
			[
				'const a = config.menu.dataLang; // lang-law-exempt(seed.two): the scope seed reads the install default',
				'const b = config.menu.dataLang;',
			].join('\n'),
		);
		expect(verdict.markers).toEqual(['seed.two']);
		expect(verdict.uncovered).toEqual([2]);
		expect(verdict.stale).toEqual([]);
		// Trailing a line with no offender: stale, even with one right below it.
		const stale = judge(
			[
				'const ok = 1; // lang-law-exempt(seed.three): the scope seed reads the install default',
				'const b = config.menu.dataLang;',
			].join('\n'),
		);
		expect(stale.uncovered).toEqual([2]);
		expect(stale.stale).toEqual(['s.ts:1 seed.three']);
	});

	test('a marker covering TWO offenders is ambiguous (red): one name, one read', () => {
		const verdict = judge(
			[
				'// lang-law-exempt(seed.four): the scope seed reads the install default by design',
				'f({ a: config.menu.applicationLang, b: config.menu.dataLang });',
			].join('\n'),
		);
		expect(verdict.offenders).toEqual([2, 2]);
		expect(verdict.uncovered).toEqual([]);
		expect(verdict.ambiguous).toEqual(['s.ts:1 seed.four']);
	});

	test('marker-shaped text in a string or template literal is NOT a marker', () => {
		for (const fake of [
			"const s = '// lang-law-exempt(fake.one): a string that only looks like a marker';",
			'const s = "// lang-law-exempt(fake.two): a string that only looks like a marker";',
			'const s = `// lang-law-exempt(fake.three): a template that only looks like a marker`;',
			'const s = `\n// lang-law-exempt(fake.four): a template line that only looks like a marker\n`;',
		]) {
			const verdict = judge([fake, 'const b = config.menu.dataLang;'].join('\n'));
			expect(verdict.markers, fake).toEqual([]);
			expect(verdict.uncovered.length, fake).toBe(1);
		}
		// A marker inside a block comment is not the `//` shape either.
		const block = judge(
			[
				'/* lang-law-exempt(fake.five): a block comment is not the marker shape */',
				'const b = config.menu.dataLang;',
			].join('\n'),
		);
		expect(block.markers).toEqual([]);
		expect(block.uncovered).toEqual([2]);
	});
});
