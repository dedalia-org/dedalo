/**
 * HTML-TEXT TRIPWIRE — regex-shaped tag matching and `&amp;` decoding live in
 * ONE file, src/core/resolve/html_text.ts (2026-10-25, CodeQL #7958
 * js/polynomial-redos; #7934/#7935/#7936 js/double-escaping).
 *
 * ── WHAT IT GUARDS ───────────────────────────────────────────────────────────
 * 1. QUADRATIC TAG SCANS. A regex that starts at `<` and scans to the closing
 *    `>` (`<[^>]*>`, `<(?!br)[^>]*>`, `<x\b[^>]*>`, `<…[\s\S]*?…`) is retried at
 *    EVERY `<`: on a run of UNCLOSED `<` each attempt reads to the end of the
 *    input, O(n²) — 0.7 s per call at 64 KB on the single event loop, from a
 *    stored value any editor can write. html_text has the linear twins
 *    (`stripTags`, `replaceHtmlTags`, `stripTagsExcept`, `htmlTags`,
 *    `firstHtmlTag`, `replaceFirstHtmlTag`) with byte-identical output.
 * 2. DOUBLE DECODING. A decoder that turns `&amp;` into `&` as one step of a
 *    chain re-reads its own output: `&amp;lt;` (a curator who TYPED `&lt;`)
 *    becomes `<`. `decodeHtmlSpecialChars` decodes every entity once. (The
 *    other single-pass decoders — babel's HTML401 table, rdf_xml's XML set,
 *    html_sanitize's URL-scheme normaliser — are one regex each: not chains.)
 *
 * ── THE MEASURE ──────────────────────────────────────────────────────────────
 * An AST census (comments are not code) of src/, tools/<tool>/server and
 * publication/<pkg>/src — html_text.ts INCLUDED: its twins are loops and its one
 * decoder is single-pass, so the home itself holds zero findings (asserted):
 *  - TAG SCAN: a regex literal (or `new RegExp('literal')`) whose pattern has a
 *    `<` followed by a scan-to-close atom (`[^>]*>`, `[^>]+>`, `[^>]*?>`,
 *    `[\s\S]*?`, `.*?`, `.+?`). Acquitted structurally: `^`-anchored without
 *    the `m` flag, or sticky (`y`) — both are tried at ONE position.
 *  - CHAINED `&amp;` DECODE — measured on BEHAVIOUR, not spelling: the search
 *    argument of a `replace`/`replaceAll`/`split` — a string, a no-expression
 *    template, a regex literal or `new RegExp('literal', 'flags')` — that
 *    consumes the text `&amp;` but NOT `&lt;` — one step of a chain (a single-pass decoder
 *    over every entity name consumes both; an encoder's `/&/g` consumes one
 *    char); an object key `'&amp;'` or a `['&amp;', '&']` pair (the table a
 *    replaceAll loop walks — a single-pass decoder keys on the NAME `amp`).
 *
 * ── THE RULE: SHRINK-ONLY, NAMED EXEMPTIONS ──────────────────────────────────
 * The census must equal EXEMPTIONS exactly: a new finding is red (route it
 * through html_text), and a count that fell is red too (lower it the same
 * commit).
 *
 * ── HONEST LIMITS ────────────────────────────────────────────────────────────
 * Static: a pattern built at runtime from non-literal parts, or a search value
 * that reaches the call through a variable or parameter, is invisible, and
 * the tag-scan shape list is the one CodeQL reports (other ReDoS shapes are not
 * this gate's business). The OUTCOME half — same output, linear time, single
 * decode, at the callers — is test/unit/server_codeql_hardening_native.test.ts.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import { Glob } from 'bun';

const REPO = join(import.meta.dir, '../..');
const HOME = 'src/core/resolve/html_text.ts';
const SCAN_GLOBS = ['src/**/*.ts', 'tools/*/server/**/*.ts', 'publication/*/src/**/*.ts'];

/** Files that keep a finding, with the exact count and why. Shrink-only. */
const EXEMPTIONS: Readonly<Record<string, { readonly count: number; readonly reason: string }>> = {
	'src/core/resolve/truncate_html.ts': {
		count: 2,
		reason:
			'The PHP preg_match_all pair scan and the open-tag rebuild are TOKENIZERS (tag + text pairs, ' +
			'alternation), not strips; both read input clamped to MAX_SCAN_CHARS (16 KiB) first — the ' +
			'bound is the DOS-01 fix, and a list preview of ≤200 chars needs no more.',
	},
	'src/diffusion/writers/xml.ts': {
		count: 1,
		reason:
			'The merge reads the root element of a part THIS writer produced (its own `<?xml …?>` ' +
			'declaration and root tag, record values escaped by escapeXml), never stored or remote text.',
	},
};

interface Finding {
	readonly file: string;
	readonly line: number;
	readonly kind: 'tag-scan' | 'amp-decode';
	readonly snippet: string;
}

type AstNode = { type: string; [key: string]: unknown };

const NOT_CODE_KEYS = new Set([
	'loc',
	'start',
	'end',
	'extra',
	'comments',
	'leadingComments',
	'trailingComments',
	'innerComments',
]);

function walk(node: unknown, visit: (node: AstNode) => void): void {
	if (node === null || typeof node !== 'object') return;
	if (Array.isArray(node)) {
		for (const child of node) walk(child, visit);
		return;
	}
	const ast = node as AstNode;
	if (typeof ast.type === 'string') visit(ast);
	for (const [key, value] of Object.entries(ast)) {
		if (!NOT_CODE_KEYS.has(key)) walk(value, visit);
	}
}

/** `<` followed (anywhere later) by an atom that scans to the closing `>`. */
const SCAN_TO_CLOSE = /<.*?(\[\^>\][*+]\??[)?]*>|\[\\s\\S\][*+]\?|\.[*+]\?)/;

/** A tag scan the engine retries at every `<` (see header). */
function isTagScan(pattern: string, flags: string): boolean {
	if (!SCAN_TO_CLOSE.test(pattern)) return false;
	if (flags.includes('y')) return false;
	if (pattern.startsWith('^') && !flags.includes('m')) return false;
	return true;
}

/** Does `search` consume the whole `&amp` of `text`'s leading entity? */
function consumesEntity(compiled: RegExp, text: string): boolean {
	const match = compiled.exec(text);
	return match !== null && match.index === 0 && match[0].length >= 4;
}

/**
 * Is a replace SEARCH argument ONE STEP of a chained decode of `&amp;`? Measured
 * by what it matches: it consumes `&amp;` but NOT `&lt;` — a step that decodes
 * `&amp;` alone only makes sense followed (or preceded) by the other steps, which
 * is the double decode. A single-pass decoder (one regex over every entity name,
 * like html_text's, babel's HTML401 table, rdf_xml's) consumes both: acquitted.
 * An encoder (`/&/g` → `&amp;`) consumes one char: acquitted.
 */
function decodesAmpAlone(search: AstNode): boolean {
	// a string search: `'&amp;'` or a no-expression template `` `&amp;` ``
	const text = literalString(search);
	if (text !== null) return text.startsWith('&amp');
	// a regex search: a literal, or `new RegExp('literal', 'flags')` / `RegExp(…)`
	let pattern: string | null = null;
	let flags = '';
	if (search.type === 'RegExpLiteral') {
		pattern = search.pattern as string;
		flags = search.flags as string;
	} else if (
		(search.type === 'NewExpression' || search.type === 'CallExpression') &&
		(search.callee as AstNode).type === 'Identifier' &&
		(search.callee as AstNode).name === 'RegExp'
	) {
		const args = search.arguments as AstNode[];
		pattern = literalString(args[0]);
		flags = literalString(args[1]) ?? '';
	}
	if (pattern === null) return false;
	let compiled: RegExp;
	try {
		compiled = new RegExp(pattern, flags.replace(/[gy]/g, ''));
	} catch {
		return false;
	}
	return consumesEntity(compiled, '&amp;') && !consumesEntity(compiled, '&lt;');
}

function literalString(node: AstNode | undefined): string | null {
	if (node === undefined) return null;
	if (node.type === 'StringLiteral') return node.value as string;
	if (node.type === 'TemplateLiteral' && (node.expressions as unknown[]).length === 0) {
		return ((node.quasis as AstNode[])[0]?.value as { cooked: string }).cooked;
	}
	return null;
}

function calleeProperty(callee: AstNode): string | null {
	if (callee.type !== 'MemberExpression' && callee.type !== 'OptionalMemberExpression') return null;
	const property = callee.property as AstNode;
	return callee.computed !== true && property.type === 'Identifier'
		? (property.name as string)
		: null;
}

/** Census one source text (`file` repo-relative). */
function htmlTextFindings(file: string, source: string): Finding[] {
	const ast = parse(source, {
		sourceType: 'module',
		errorRecovery: true,
		plugins: file.endsWith('.ts') ? ['typescript'] : [],
	});
	const lines = source.split('\n');
	const findings: Finding[] = [];
	const report = (node: AstNode, kind: Finding['kind']): void => {
		const line = (node.loc as { start: { line: number } }).start.line;
		findings.push({ file, line, kind, snippet: (lines[line - 1] ?? '').trim().slice(0, 160) });
	};
	walk(ast.program, (node) => {
		if (node.type === 'RegExpLiteral') {
			if (isTagScan(node.pattern as string, node.flags as string)) report(node, 'tag-scan');
			return;
		}
		if (node.type === 'NewExpression' || node.type === 'CallExpression') {
			const callee = node.callee as AstNode;
			const args = node.arguments as AstNode[];
			if (callee.type === 'Identifier' && callee.name === 'RegExp') {
				const pattern = literalString(args[0]);
				const flags = literalString(args[1]) ?? '';
				if (pattern !== null && isTagScan(pattern, flags)) report(node, 'tag-scan');
				return;
			}
			const method = calleeProperty(callee);
			if (
				// `.split('&amp;')` is the split/join spelling of the same step
				(method === 'replace' || method === 'replaceAll' || method === 'split') &&
				args[0] &&
				decodesAmpAlone(args[0])
			) {
				report(node, 'amp-decode');
			}
			return;
		}
		if (node.type === 'ObjectProperty' && literalString(node.key as AstNode) === '&amp;') {
			report(node, 'amp-decode');
			return;
		}
		if (node.type === 'ArrayExpression') {
			const [first, second] = node.elements as AstNode[];
			if (literalString(first) === '&amp;' && literalString(second) === '&')
				report(node, 'amp-decode');
		}
	});
	return findings;
}

function census(): { scanned: string[]; findings: Finding[] } {
	const files = new Set<string>();
	for (const pattern of SCAN_GLOBS) {
		for (const rel of new Glob(pattern).scanSync({ cwd: REPO })) {
			if (rel.includes('node_modules/') || rel.includes('/dist/') || rel.endsWith('.test.ts'))
				continue;
			files.add(rel);
		}
	}
	const scanned = [...files].sort();
	const findings: Finding[] = [];
	for (const rel of scanned) {
		findings.push(...htmlTextFindings(rel, readFileSync(join(REPO, rel), 'utf8')));
	}
	return { scanned, findings };
}

const count = (source: string): number => htmlTextFindings('src/x.ts', source).length;

describe('html_text tripwire — tag scans and &amp; decodes live in html_text.ts only', () => {
	const { scanned, findings } = census();

	test('the census equals EXEMPTIONS exactly (new finding → html_text; fewer → lower the count)', () => {
		const byFile = new Map<string, Finding[]>();
		for (const finding of findings)
			byFile.set(finding.file, [...(byFile.get(finding.file) ?? []), finding]);
		const unexpected = [...byFile.entries()]
			.filter(([file, list]) => EXEMPTIONS[file]?.count !== list.length)
			.flatMap(([, list]) => list.map((f) => `${f.file}:${f.line} [${f.kind}] ${f.snippet}`));
		expect(unexpected, 'route these through src/core/resolve/html_text.ts').toEqual([]);
		const stale = Object.entries(EXEMPTIONS)
			.filter(([file, entry]) => (byFile.get(file)?.length ?? 0) !== entry.count)
			.map(
				([file, entry]) => `${file}: banked ${entry.count}, found ${byFile.get(file)?.length ?? 0}`,
			);
		expect(stale, 'lower EXEMPTIONS in the same commit').toEqual([]);
		for (const entry of Object.values(EXEMPTIONS)) expect(entry.reason.length).toBeGreaterThan(40);
	});

	test('anti-vacuity: the walk saw the trees (home included) and convicts the live truncate_html tokenizers', () => {
		expect(scanned.length).toBeGreaterThan(1000);
		for (const file of [
			'src/core/media/tools/subtitles.ts',
			'src/external/fields_map.ts',
			'src/core/tools/import_code_lookup.ts',
		]) {
			expect(scanned).toContain(file);
		}
		expect(scanned.some((f) => f.startsWith('tools/') && f.includes('/server/'))).toBe(true);
		expect(scanned.some((f) => f.startsWith('publication/'))).toBe(true);
		// Live code the measure must SEE: the bounded truncate_html tokenizers are
		// convicted (and exempted) — a detector that misses them is blind.
		expect(findings.filter((f) => f.file === 'src/core/resolve/truncate_html.ts').length).toBe(2);
		// The home is censused like every file and is clean on its own merits (no
		// name exemption): a regex tag scan or a chained decode added there is red.
		expect(scanned).toContain(HOME);
		expect(findings.filter((f) => f.file === HOME)).toEqual([]);
	});

	test('positive controls: every shape the header names is convicted', () => {
		expect(count(`x.replace(/<[^>]*>/g, '');`)).toBe(1);
		expect(count(`x.replace(/<[^>]+>/g, ' ');`)).toBe(1);
		expect(count(`x.replace(/<(?!\\/?(?:br|strong|em)\\b)[^>]*>/gi, '');`)).toBe(1);
		expect(count(`x.match(/<svg\\b[^>]*>/i);`)).toBe(1);
		expect(count(`x.replace(/<script\\b[\\s\\S]*?<\\/script>/gi, '');`)).toBe(1);
		expect(count(`x.replace(/<!--.*?-->/g, '');`)).toBe(1);
		expect(count(`new RegExp('<[^>]*>', 'g');`)).toBe(1);
		expect(count(`x.match(/^<a[^>]*>/m);`)).toBe(1);
		expect(count(`x.replace(/&amp;/g, '&');`)).toBe(1);
		expect(count(`x.replaceAll('&amp;', '&');`)).toBe(1);
		expect(count(`x.replace(/&amp;/gi, '&').replace(/&lt;/gi, '<');`)).toBe(1);
		expect(count(`x.replace(/&(amp);/g, '&');`)).toBe(1);
		expect(count(`const T = { '&amp;': '&', '&lt;': '<' };`)).toBe(1);
		expect(count(`const M = new Map([['&amp;', '&']]);`)).toBe(1);
		expect(count(`x.replace(new RegExp('&amp;', 'g'), '&');`)).toBe(1);
		expect(count(`x.replace(RegExp('&amp;', 'gi'), '&');`)).toBe(1);
		expect(count("x.replaceAll(`&amp;`, '&');")).toBe(1);
		expect(count(`x.split('&amp;').join('&');`)).toBe(1);
		expect(count(`x.split(/&amp;/).join('&');`)).toBe(1);
	});

	test('negative controls: encoders, anchored/sticky scans and comments are not findings', () => {
		expect(count(`x.replace(/&/g, '&amp;').replace(/</g, '&lt;');`)).toBe(0);
		expect(count(`x.replaceAll('&', '&amp;');`)).toBe(0);
		expect(count(`const T = { '&': '&amp;' };`)).toBe(0);
		expect(count(`x.match(/^(\\s*)<VirtualHost\\b[^>]*>\\s*$/i);`)).toBe(0);
		expect(count(`const OPENER = /<svg\\b[^>]*>/y;`)).toBe(0);
		expect(count(`x.replace(/<br\\s*\\/?>/gi, '\\n');`)).toBe(0);
		expect(count(`// x.replace(/<[^>]*>/g, '') and x.replace(/&amp;/g, '&')\nconst a = 1;`)).toBe(
			0,
		);
		expect(count(`x.replace(/&nbsp;/g, ' ');`)).toBe(0);
		expect(count(`x.split('&').join('&amp;'); y.split(',');`)).toBe(0);
		expect(count(`x.replace(new RegExp('&', 'g'), '&amp;');`)).toBe(0);
		// single pass over every entity name: no chain, no double decode
		expect(count(`x.replace(/&(amp|lt|gt);/g, (m, n) => T[n]);`)).toBe(0);
		expect(count(`x.replace(/;\\s*$/, '').replace(/[#;].*$/, '').replace(/m/g, 'x');`)).toBe(0);
	});
});
