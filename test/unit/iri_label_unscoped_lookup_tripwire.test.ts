/**
 * THE UNSCOPED FOLDED LOOKUP HAS NAMED CALLERS ONLY (T0-12, owner decision D6b,
 * 2026-11-11).
 *
 * `findSectionIdsByFoldedText` (src/core/tools/import_code_lookup.ts) answers
 * the records of a section whose value equals a text under the match fold —
 * with NO principal, NO record gate and NO projects filter. That is right for
 * exactly one shape: a SHARED VOCABULARY the caller LINKS to and never writes
 * into (the component_iri label section dd1706 — a scoped lookup there forks
 * the vocabulary per project). Anywhere else it is a scope bypass: an importer
 * learning which records exist past its projects. Its raw read,
 * `readSectionIdsByFoldedValue` (src/core/db/matrix.ts), is the same bypass one
 * level down.
 *
 * Asserted:
 *  1. Every production file (src/, tools/, scripts/) that NAMES either function
 *     outside a comment is its definer or an ALLOW-LISTED caller with a reason
 *     — a reference, not only a call, so an alias (`const f = …`) is caught.
 *     Allow-list entries are LIVE: an entry whose file no longer calls is red.
 *  2. Each allowed call of `findSectionIdsByFoldedText` passes a NON-EMPTY
 *     string-literal reason naming its owner decision (`'D6b: …'`) — and the
 *     function refuses an empty reason at runtime (run here, no DB).
 *  3. The SCOPED path stays scoped: `CandidateScope.principal` is a required
 *     `Principal` (the D6b exemption once widened it to `| undefined`, which
 *     let ANY caller of the scoped search drop its principal).
 *
 * Anti-vacuity: corpus floor; a planted unlisted caller, a planted reasonless
 * call and a planted alias are each reported by the same detector.
 *
 * Honest limits: source text only. Comment stripping is lexical (a `//` inside
 * a string literal truncates that line — harmless for an identifier census).
 * A caller reaching the function through a computed property
 * (`module['find…']`) is outside any literal scanner; the corpus has none.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findSectionIdsByFoldedText } from '../../src/core/tools/import_code_lookup.ts';
import {
	REPO_ROOT,
	WRITE_PATH_CORPUS_FLOOR,
	writePathSourceFiles,
} from '../helpers/write_path_corpus.ts';

interface Guarded {
	/** The function name. */
	name: string;
	/** The file that defines it. */
	definer: string;
	/** Allowed callers → why they may see past the caller's scope. */
	allowed: Record<string, string>;
	/** Whether each call must carry a `'D6b: …'` literal reason argument. */
	needsReasonLiteral: boolean;
}

const GUARDED: readonly Guarded[] = [
	{
		name: 'findSectionIdsByFoldedText',
		definer: 'src/core/tools/import_code_lookup.ts',
		allowed: {
			'src/core/tools/import_iri_label.ts':
				'D6b: an imported iri label resolves against dd1706, the shared label vocabulary of every component_iri; the import links to the record and never writes into it — a scoped lookup would create a per-project duplicate',
		},
		needsReasonLiteral: true,
	},
	{
		name: 'readSectionIdsByFoldedValue',
		definer: 'src/core/db/matrix.ts',
		allowed: {
			'src/core/tools/import_code_lookup.ts':
				'the one door above it: findSectionIdsByFoldedText, which demands the named reason and resolves table/column from the ontology',
		},
		needsReasonLiteral: false,
	},
];

function stripComments(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

interface SourceFile {
	path: string;
	code: string;
}

/** The engine-process code (src/, tools/, scripts/ — the registered write-path corpus, tests excluded). */
function loadCorpus(): SourceFile[] {
	return writePathSourceFiles().map((path) => ({
		path,
		code: stripComments(readFileSync(join(REPO_ROOT, path), 'utf8')),
	}));
}

/** The text of every call `name(` … matching `)`, in one file. */
function callTexts(code: string, name: string): string[] {
	const calls: string[] = [];
	const pattern = new RegExp(`\\b${name}\\s*\\(`, 'g');
	for (const match of code.matchAll(pattern)) {
		let depth = 0;
		let end = match.index + match[0].length - 1;
		for (; end < code.length; end++) {
			if (code[end] === '(') depth++;
			else if (code[end] === ')' && --depth === 0) break;
		}
		calls.push(code.slice(match.index, end + 1));
	}
	return calls;
}

/**
 * The code with the TEXT of every string literal blanked (quotes kept; a
 * template's `${…}` expressions kept, they are code) — an error message that
 * names the function is prose, not a reference.
 */
function stripStringText(code: string): string {
	let out = '';
	let quote: string | null = null;
	const templateDepth: number[] = []; // brace depth at which each open `${` resumes its template
	let braces = 0;
	for (let i = 0; i < code.length; i++) {
		const char = code[i] as string;
		if (quote !== null) {
			if (char === '\\') {
				i++;
				continue;
			}
			if (char === quote) {
				quote = null;
				out += char;
			} else if (quote === '`' && char === '$' && code[i + 1] === '{') {
				templateDepth.push(braces);
				braces++;
				quote = null;
				out += '${';
				i++;
			}
			continue;
		}
		if (char === "'" || char === '"' || char === '`') quote = char;
		else if (char === '{') braces++;
		else if (char === '}') {
			braces--;
			if (templateDepth.at(-1) === braces) {
				templateDepth.pop();
				quote = '`';
			}
		}
		out += char;
	}
	return out;
}

/**
 * The definer may NAME its function exactly once — the definition itself: a
 * second reference inside the definer (a wrapper, a re-export, an alias) is a
 * new caller the allow-list never saw.
 */
function definerViolations(file: SourceFile, guarded: Guarded): string[] {
	const code = stripStringText(file.code);
	const references = code.match(new RegExp(`\\b${guarded.name}\\b`, 'g')) ?? [];
	const defined = new RegExp(`export async function ${guarded.name}\\s*\\(`).test(code);
	if (defined && references.length === 1) return [];
	return [
		`${file.path}: the definer names ${guarded.name} ${references.length} time(s) — only its definition is allowed`,
	];
}

/** Every violation of one guarded function over a corpus (the detector the planted controls run). */
function violations(corpus: readonly SourceFile[], guarded: Guarded): string[] {
	const found: string[] = [];
	const reference = new RegExp(`\\b${guarded.name}\\b`);
	const referencing = new Set<string>();
	for (const file of corpus) {
		if (file.path === guarded.definer) {
			found.push(...definerViolations(file, guarded));
			continue;
		}
		if (!reference.test(file.code)) continue;
		referencing.add(file.path);
		if (!(file.path in guarded.allowed)) {
			found.push(`${file.path}: names ${guarded.name} and is not an allow-listed caller`);
			continue;
		}
		const calls = callTexts(file.code, guarded.name);
		// EXACTLY one sanctioned call site per allowed file: a second call is a
		// second (unreviewed) use, e.g. a new exported wrapper beside the first.
		if (calls.length !== 1) {
			found.push(`${file.path}: ${calls.length} calls of ${guarded.name} (exactly 1 is allowed)`);
		}
		if (!guarded.needsReasonLiteral) continue;
		for (const call of calls) {
			if (!/['"`]D6b: \S[^'"`]*['"`]/.test(call)) {
				found.push(`${file.path}: a ${guarded.name} call without its 'D6b: …' reason literal`);
			}
		}
	}
	for (const [path, reason] of Object.entries(guarded.allowed)) {
		if (reason.trim() === '') found.push(`${path}: allow-list entry without a reason`);
		if (!referencing.has(path))
			found.push(`${path}: STALE allow-list entry (no longer calls ${guarded.name})`);
	}
	return found;
}

describe('iri_label_unscoped_lookup_tripwire', () => {
	const corpus = loadCorpus();

	test('the corpus is real (anti-vacuity floor)', () => {
		expect(corpus.length).toBeGreaterThan(WRITE_PATH_CORPUS_FLOOR);
		for (const guarded of GUARDED) {
			expect(corpus.some((file) => file.path === guarded.definer)).toBe(true);
		}
	});

	for (const guarded of GUARDED) {
		test(`${guarded.name}: only allow-listed callers, each with its reason`, () => {
			expect(violations(corpus, guarded)).toEqual([]);
		});
	}

	test('the scoped search keeps a REQUIRED principal', () => {
		const lookup = corpus.find((file) => file.path === 'src/core/tools/import_code_lookup.ts');
		const scope = /interface CandidateScope\s*\{([\s\S]*?)\n\}/.exec(lookup?.code ?? '')?.[1];
		expect(scope).toBeDefined();
		expect(scope).toMatch(/readonly principal: Principal;/);
		expect(lookup?.code).not.toMatch(/principal:\s*undefined/);
	});

	test('an empty reason is refused at runtime, before any read', async () => {
		await expect(
			findSectionIdsByFoldedText({ sectionTipo: 'dd1706', componentTipo: 'dd1715' }, 'x', '  '),
		).rejects.toThrow(/named reason/);
	});

	describe('positive controls (the detector sees each planted shape)', () => {
		const [lookup] = GUARDED as [Guarded, Guarded];
		const caller = Object.keys(lookup.allowed)[0] as string;
		const good = `await ${lookup.name}(t, text, 'D6b: shared vocabulary');`;

		test('an unlisted caller', () => {
			const planted = [
				{ path: caller, code: good },
				{ path: 'src/core/tools/planted.ts', code: `await ${lookup.name}(t, text, 'D6b: x');` },
			];
			expect(violations(planted, lookup)).toEqual([
				`src/core/tools/planted.ts: names ${lookup.name} and is not an allow-listed caller`,
			]);
		});

		test('a reasonless call in an allowed file', () => {
			const planted = [{ path: caller, code: `await ${lookup.name}(t, text, reason);` }];
			expect(violations(planted, lookup)).toEqual([
				`${caller}: a ${lookup.name} call without its 'D6b: …' reason literal`,
			]);
		});

		test('an alias in an unlisted file, and a stale entry', () => {
			const planted = [{ path: 'scripts/planted.ts', code: `const f = ${lookup.name};` }];
			expect(violations(planted, lookup)).toEqual([
				`scripts/planted.ts: names ${lookup.name} and is not an allow-listed caller`,
				`${caller}: STALE allow-list entry (no longer calls ${lookup.name})`,
			]);
		});

		test('a wrapper inside the definer, and a second call in an allowed file', () => {
			const definer = `export async function ${lookup.name}(a, b, c) {}`;
			const planted = [
				{
					path: lookup.definer,
					code: `${definer}\nexport const wrap = (t) => ${lookup.name}(t, 'x', 'D6b: y');`,
				},
				{ path: caller, code: `${good}\n${good}` },
			];
			expect(violations(planted, lookup)).toEqual([
				`${lookup.definer}: the definer names ${lookup.name} 2 time(s) — only its definition is allowed`,
				`${caller}: 2 calls of ${lookup.name} (exactly 1 is allowed)`,
			]);
		});

		test('a definer whose message string names its function is clean', () => {
			const definer = `export async function ${lookup.name}(a) {\n\tthrow new Error(\`${lookup.name}: \${a} '\${a}'\`);\n\tconst m = '${lookup.name}';\n}`;
			const planted = [
				{ path: lookup.definer, code: definer },
				{ path: caller, code: good },
			];
			expect(violations(planted, lookup)).toEqual([]);
		});

		test('a commented mention is not a reference', () => {
			const planted = [
				{ path: caller, code: good },
				{ path: 'src/x.ts', code: stripComments(`// see ${lookup.name}\n/* ${lookup.name} */`) },
			];
			expect(violations(planted, lookup)).toEqual([]);
		});
	});
});
