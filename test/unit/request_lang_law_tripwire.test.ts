/**
 * THE REQUEST-LANGUAGE LAW (T2 B10 — OX7-1, SL-2, O15-3, THES-06; one law):
 * "request identity (application lang, data lang) is read from the request
 * scope; a language is configuration, never a literal."
 *
 * ONE tripwire, two rules, ZERO allowlist in this file. Scans every `.ts`
 * under src/ and tools/ (comments stripped, line numbers kept):
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
 * on the offending line or the line directly above it:
 *
 *     // lang-law-exempt(<name>): <reason, ≥ 20 chars>
 *
 * verified here: every marker covers a real offender (a stale marker is red),
 * names are unique, reasons are stated. There is no list of exempt files in
 * this test — moving the reason away from the code is how it rots.
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
import { Glob } from 'bun';

const REPO = join(import.meta.dir, '..', '..');

/** The request-lang module: its accessors' fallback IS the install default. */
const REQUEST_LANG_MODULE = 'src/core/resolve/request_lang.ts';

/** Corpus floor: a walk that reads fewer files is a broken walk, not a smaller engine. */
const CORPUS_FLOOR = 1000;

/**
 * Blank every comment (line + block) to spaces, keeping newlines and every
 * string/template literal intact, so offsets still map to source lines.
 */
function stripComments(source: string): string {
	let out = '';
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
			out += blank(source.slice(index, stop));
			index = stop;
		} else if (char === '/' && next === '*') {
			const end = source.indexOf('*/', index + 2);
			const stop = end === -1 ? length : end + 2;
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
	return out;
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
	name: string;
	reason: string;
}

const MARKER = /\/\/\s*lang-law-exempt\(([a-z0-9_.-]+)\):\s*(.*)$/;

/** The exemption markers of one source text (read from the RAW text: they are comments). */
function findMarkers(file: string, source: string): Marker[] {
	const markers: Marker[] = [];
	source.split('\n').forEach((text, index) => {
		const match = MARKER.exec(text);
		if (match !== null) {
			markers.push({
				file,
				line: index + 1,
				name: match[1] as string,
				reason: (match[2] ?? '').trim(),
			});
		}
	});
	return markers;
}

/** A marker covers an offender on its own line or on the line directly below it. */
const covers = (marker: Marker, offender: Offender): boolean =>
	marker.file === offender.file &&
	(offender.line === marker.line || offender.line === marker.line + 1);

function corpus(): { file: string; source: string }[] {
	const files: { file: string; source: string }[] = [];
	for (const root of ['src', 'tools']) {
		for (const rel of new Glob('**/*.ts').scanSync(join(REPO, root))) {
			const file = `${root}/${rel}`;
			// src/config/ IS where a language is configuration — reading its own keys is the point.
			if (file.startsWith('src/config/')) continue;
			files.push({ file, source: readFileSync(join(REPO, file), 'utf8') });
		}
	}
	return files;
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
		expect(relative(REPO, join(REPO, REQUEST_LANG_MODULE))).toBe(REQUEST_LANG_MODULE);
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

	test('every exemption is honest: covers a real offender, unique name, stated reason', () => {
		const stale = MARKERS.filter(
			(marker) => !OFFENDERS.some((offender) => covers(marker, offender)),
		).map((marker) => `${marker.file}:${marker.line} ${marker.name}`);
		expect(stale).toEqual([]);
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

	test('a marker covers its own line and the line below, nothing else', () => {
		const source = [
			'// lang-law-exempt(seed.one): the scope seed reads the install default by design',
			'const a = config.menu.dataLang;',
			'',
			'const b = config.menu.dataLang;',
		].join('\n');
		const offenders = findOffenders('s.ts', source, { rule1: true });
		const markers = findMarkers('s.ts', source);
		expect(offenders.map((offender) => offender.line)).toEqual([2, 4]);
		expect(markers.map((marker) => marker.name)).toEqual(['seed.one']);
		const uncovered = offenders.filter((offender) => !markers.some((m) => covers(m, offender)));
		expect(uncovered.map((offender) => offender.line)).toEqual([4]);
	});
});
