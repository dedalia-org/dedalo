/**
 * HERMETIC PARALLEL SAFETY — a tripwire that runs in a parallel worker does not write
 * into the checkout (2026-10-21).
 *
 * hermetic.sh runs its tripwires under `bun test --parallel`: every file in its own
 * worker, many at once, over ONE checkout. A file that writes into the repo tree races
 * every gate that walks that tree. Measured on the first parallel run:
 * `lint_scope_tripwire` planted `test/unit/zz_lint_scope_probe.ts`, and
 * `diffusion_scratch_tables_tripwire`, walking `test/unit/` in a sibling worker, read it
 * mid-delete (ENOENT). The audit that followed found `operator_commands_tripwire`
 * building fixed-name scratch trees under `test/` — which `tier_wiring_tripwire` stats
 * while it walks — and moved them to mkdtemp.
 *
 * The runtime guard in hermetic.sh (`git status` before vs after) only sees a write a
 * test LEAVES; every writer above cleaned up after itself, so it would never fire. And
 * the nightly serial run cannot see a race at all. This gate is the one that holds the
 * rule BEFORE the race: every HERMETIC_TRIPWIRES file outside HERMETIC_SERIAL_LANE is
 * scanned for a filesystem write whose arguments reach a checkout-rooted path. A hit
 * moves to mkdtemp(tmpdir()) — or to the serial lane with its reason — or, when the
 * write is provably invisible to every walker, to WRITERS_IN_TREE below with that
 * reason (shrink-only: a row whose file no longer writes is red).
 *
 * THE SCAN, and its one limit. Per file: a name is CHECKOUT-ROOTED when it is assigned
 * from `import.meta.dir` / `import.meta.dirname` / `process.cwd()`, or from `join` /
 * `resolve` / a template over a rooted name (iterated to a fixpoint, so
 * `const root = join(REPO_ROOT, 'test', 'x')` is rooted). A write is any call of the
 * sinks below; it is a hit when any argument names a rooted identifier or
 * `import.meta.dir` directly.
 * shortcut: one file at a time — a helper that writes into a path its caller passes in
 * is not followed; upgrade to an import-resolved scan the day a helper writes in-tree
 * (the 2026-10-21 audit read every helper the list imports: all write into
 * caller-supplied mkdtemp dirs).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { escapeRegExp } from '../helpers/regex_escape.ts';
import { stripComments } from '../helpers/strip_comments.ts';

const ROOT = resolve(import.meta.dir, '../..');
const read = (relative: string): string => readFileSync(join(ROOT, relative), 'utf8');

/** Files allowed to write into the checkout from a parallel worker, each with WHY it is safe. */
const WRITERS_IN_TREE: Readonly<Record<string, string>> = {
	'test/unit/dependency_integrity_tripwire.test.ts':
		'the census reads REPO-RELATIVE paths, so its positive controls plant files in `.scratch_third_party_*_<pid>/` at the repo root: pid-keyed (no two workers share it), dot-prefixed and `.gitignore`d (`.scratch_*/`), so Bun Glob walkers (no dot) and `git ls-files --others --exclude-standard` never list it; the two plain readdirSync(ROOT) walkers (census_derivation, deploy_env_contract) filter by name (audit 2026-10-21)',
};

/** Each write sink, and which of its arguments is the path it WRITES (a copy's source is a read). */
const SINKS: Readonly<Record<string, readonly number[]>> = {
	writeFileSync: [0],
	appendFileSync: [0],
	mkdirSync: [0],
	mkdtempSync: [0],
	rmSync: [0],
	renameSync: [0, 1],
	symlinkSync: [1],
	cpSync: [1],
	copyFileSync: [1],
	'Bun.write': [0],
	writeFile: [0],
	appendFile: [0],
	mkdir: [0],
	rm: [0],
	rename: [0, 1],
	symlink: [1],
	cp: [1],
	copyFile: [1],
};

const DIRECT_ROOT = /\bimport\.meta\.dir(?:name)?\b|\bprocess\.cwd\(\)/;

/** The text between the `(` at `open` and its matching `)`. */
function callArgs(source: string, open: number): string {
	let depth = 0;
	for (let index = open; index < source.length; index++) {
		const char = source[index];
		if (char === '(') depth++;
		else if (char === ')' && --depth === 0) return source.slice(open + 1, index);
	}
	return source.slice(open + 1);
}

/** A call's arguments, split at its top-level commas. */
function splitArgs(args: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let from = 0;
	for (let index = 0; index < args.length; index++) {
		const char = args[index];
		if (char === '(' || char === '[' || char === '{') depth++;
		else if (char === ')' || char === ']' || char === '}') depth--;
		else if (char === ',' && depth === 0) {
			parts.push(args.slice(from, index));
			from = index + 1;
		}
	}
	parts.push(args.slice(from));
	return parts;
}

/**
 * Names assigned a checkout-rooted path, to a fixpoint. Scope-blind on purpose, so a name
 * is rooted only when EVERY assignment to it in the file is: `const path = …` rooted in
 * one test and mkdtemp in the next is ambiguous and skipped, never guessed.
 * shortcut: a name reused across scopes with one rooted write is missed; upgrade to a
 * scoped (AST) scan if such a writer appears.
 */
function rootedNames(source: string): Set<string> {
	const valuesByName = new Map<string, string[]>();
	for (const match of source.matchAll(
		/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*([^;\n]+)/g,
	)) {
		const name = match[1] ?? '';
		valuesByName.set(name, [...(valuesByName.get(name) ?? []), match[2] ?? '']);
	}
	// A loop variable (`for (const path of …)`) is a declaration with no rooted value.
	for (const match of source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+(?:of|in)\b/g)) {
		const name = match[1] ?? '';
		valuesByName.set(name, [...(valuesByName.get(name) ?? []), '']);
	}
	const isRooted = (value: string, rooted: Set<string>): boolean =>
		DIRECT_ROOT.test(value) ||
		(/^\s*(?:join|resolve|path\.join|path\.resolve)\(|^\s*`/.test(value) &&
			[...rooted].some((other) =>
				new RegExp(`(?<![\\w$.])${escapeRegex(other)}(?![\\w$])`).test(value),
			));
	const rooted = new Set<string>();
	let grew = true;
	while (grew) {
		grew = false;
		for (const [name, values] of valuesByName) {
			if (rooted.has(name) || !values.every((value) => isRooted(value, rooted))) continue;
			rooted.add(name);
			grew = true;
		}
	}
	return rooted;
}

const escapeRegex = (text: string): string => escapeRegExp(text);

/** Every write call whose arguments reach a checkout-rooted path: `line: call`. */
function inTreeWrites(raw: string): string[] {
	// Comments gone, literal CONTENT blanked (a name inside a string is not a reference),
	// `${…}` kept as the code it is, regex bodies blanked so paren matching holds.
	const source = stripComments(raw, {
		blankStrings: true,
		blankRegexBodies: true,
		keepTemplateSubstitutions: true,
	});
	const rooted = rootedNames(source);
	const hits: string[] = [];
	const sinkPattern = new RegExp(
		`(?<![\\w$.])(?:fs\\.|fsp\\.|promises\\.)?(${Object.keys(SINKS).map(escapeRegex).join('|')})\\s*\\(`,
		'g',
	);
	for (const match of source.matchAll(sinkPattern)) {
		const open = (match.index ?? 0) + match[0].length - 1;
		const args = callArgs(source, open);
		const parts = splitArgs(args);
		const targets = (SINKS[match[1] ?? ''] ?? []).map((index) => parts[index] ?? '');
		const reaches = targets.some(
			(target) =>
				DIRECT_ROOT.test(target) ||
				[...rooted].some((name) =>
					new RegExp(`(?<![\\w$.])${escapeRegex(name)}(?![\\w$])`).test(target),
				),
		);
		if (!reaches) continue;
		const line = source.slice(0, match.index).split('\n').length;
		hits.push(`${line}: ${match[1]}(${args.replace(/\s+/g, ' ').slice(0, 100)})`);
	}
	return hits;
}

/** A bash array literal's entries (comments and blanks dropped). */
function bashArray(source: string, name: string): string[] {
	const block = source.match(new RegExp(`^${name}=\\(\\n([\\s\\S]*?)\\n\\)`, 'm'))?.[1];
	if (block === undefined) throw new Error(`scripts/ci/hermetic.sh: ${name} not found`);
	return block
		.split('\n')
		.map((line) => line.replace(/#.*$/, '').trim())
		.filter((line) => line.length > 0);
}

const HERMETIC = read('scripts/ci/hermetic.sh');
const TRIPWIRES = bashArray(HERMETIC, 'HERMETIC_TRIPWIRES');
const SERIAL_LANE = new Set(bashArray(HERMETIC, 'HERMETIC_SERIAL_LANE'));
const PARALLEL = [...new Set(TRIPWIRES)].filter((file) => !SERIAL_LANE.has(file)).sort();

describe('hermetic parallel safety — no parallel-lane tripwire writes into the checkout', () => {
	test('the census is not empty (anti-vacuity)', () => {
		expect(TRIPWIRES.length).toBeGreaterThan(200);
		expect(SERIAL_LANE.size).toBeGreaterThan(0);
		expect(PARALLEL.length).toBe(new Set(TRIPWIRES).size - SERIAL_LANE.size);
	});

	test('every parallel-lane file is free of in-tree writes, or reasoned in WRITERS_IN_TREE', () => {
		const offenders = PARALLEL.filter((file) => WRITERS_IN_TREE[file] === undefined)
			.map((file) => ({ file, hits: inTreeWrites(read(file)) }))
			.filter(({ hits }) => hits.length > 0)
			.map(({ file, hits }) => `${file}\n    ${hits.join('\n    ')}`);
		expect(
			offenders,
			'A tripwire in a parallel worker writes into the checkout, racing every gate that walks it. ' +
				'Write scratch under mkdtempSync(join(tmpdir(), …)); if the file must touch the tree, move it ' +
				'to HERMETIC_SERIAL_LANE in scripts/ci/hermetic.sh with its reason:\n  ' +
				offenders.join('\n  '),
		).toEqual([]);
	});

	test('WRITERS_IN_TREE is shrink-only: every row is a parallel-lane file that still writes in-tree', () => {
		for (const [file, reason] of Object.entries(WRITERS_IN_TREE)) {
			expect(PARALLEL, `${file} is no longer a parallel-lane tripwire — delete its row`).toContain(
				file,
			);
			expect(
				inTreeWrites(read(file)).length,
				`${file} no longer writes in-tree — delete its row`,
			).toBeGreaterThan(0);
			expect(reason.length).toBeGreaterThan(40);
		}
		expect(Object.keys(WRITERS_IN_TREE).length).toBeLessThanOrEqual(1);
	});

	test('the serial lane holds the file that motivated it, and the scan SEES its write (named anchor)', () => {
		expect(SERIAL_LANE.has('test/unit/lint_scope_tripwire.test.ts')).toBe(true);
		expect(inTreeWrites(read('test/unit/lint_scope_tripwire.test.ts')).length).toBeGreaterThan(0);
	});

	test('POSITIVE CONTROL — the scan flags each in-tree shape and passes the mkdtemp ones', () => {
		const flagged = [
			"const REPO_ROOT = resolve(import.meta.dir, '../..');\nwriteFileSync(join(REPO_ROOT, 'x'), '');",
			// The operator_commands shape: a rooted name, then a write through it.
			"const REPO_ROOT = join(import.meta.dir, '..', '..');\nconst root = join(REPO_ROOT, 'test', '.tmp-x');\nmkdirSync(join(root, 'bin'), { recursive: true });",
			"const dir = `${process.cwd()}/scratch`;\nawait Bun.write(dir + '/f', 'x');",
			"symlinkSync('target', join(import.meta.dir, 'link'));",
			"const a = resolve(import.meta.dir, '..');\nconst b = join(a, 'x');\nconst c = join(b, 'y');\nrmSync(c, { recursive: true });",
		];
		for (const source of flagged) expect(inTreeWrites(source).length, source).toBeGreaterThan(0);
		const clean = [
			"const root = mkdtempSync(join(tmpdir(), 'dedalo-x-'));\nwriteFileSync(join(root, 'f'), '');",
			"const REPO_ROOT = resolve(import.meta.dir, '../..');\nconst text = readFileSync(join(REPO_ROOT, 'x'), 'utf8');",
			"const REPO_ROOT = resolve(import.meta.dir, '../..');\nconst scratch = join(tmpdir(), `x-${process.pid}`);\nmkdirSync(scratch);",
			// A rooted name INSIDE a string literal is not a reference.
			"const backup = join(import.meta.dir, 'b');\nconst root = mkdtempSync(join(tmpdir(), 'opcmd-backup-'));",
			// A name rooted once and loop-bound elsewhere is ambiguous — skipped, not guessed.
			"const path = join(import.meta.dir, 'x');\nfor (const path of [join(tmp, 'a')]) mkdirSync(path);",
		];
		for (const source of clean) expect(inTreeWrites(source), source).toEqual([]);
	});
});
