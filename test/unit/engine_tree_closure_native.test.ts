/**
 * GATE — a module the gates run FROM AN ENGINE TREE imports nothing the tree
 * does not hold.
 *
 * `test/helpers/engine_cli_tree.ts` builds a scratch engine that calls itself a
 * chosen release identity: a copy of `ENGINE_FILES` (the `src/` tree, the ops
 * scripts, the release catalog) and nothing else — no `client/`, no `tools/`.
 * The gates then run real modules of that copy in a child `bun`: the
 * image-update channel CLI, and the update engine itself
 * (`src/core/update/engine.ts`, the catalog-once walk of
 * release_identity_walk_native).
 *
 * 2026-11-20: `boot_state.ts` took the migrate-passwords command line from
 * `security/password_hash.ts`, whose own import of `password_policy.ts` reaches
 * the client's shared policy module — so `engine.ts` could no longer be
 * imported from a tree, and the failure surfaced only as a child's exit code in
 * a database-bound gate of the full run. This gate says it at once, by name,
 * with no database: the STATIC import closure of every entry is walked on the
 * checkout and each file must lie inside `ENGINE_FILES`.
 *
 * Static edges only, on purpose: a static import is resolved before a line of
 * the entry runs, so one edge out of the tree kills the whole module; an
 * `await import()` costs nothing until its call site is reached, and the gates
 * that run a tree reach those for real.
 *
 * The entries are DERIVED from the gates that build a tree (their
 * `module('src/…')` specifiers and the CLI the helper returns), floored so a
 * renamed idiom cannot empty the walk.
 *
 * Hermetic: fs only.
 */

import { describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { ENGINE_FILES } from '../helpers/engine_cli_tree.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');

/** The CLI `engineCliAt` hands back. */
const TREE_CLI = join('scripts', 'ops', 'image_update_channel.ts');

interface Escape {
	/** Repo-relative file outside the tree (or missing). */
	readonly file: string;
	/** Importer chain back to the entry, nearest first. */
	readonly chain: readonly string[];
}

const loaderOf = (file: string): 'ts' | 'js' | null =>
	/\.(ts|mts)$/.test(file) ? 'ts' : /\.(js|mjs)$/.test(file) ? 'js' : null;

/**
 * Walk the static relative-import closure of `entry` under `root` and return
 * the files reached plus those `inside` rejects. Type-only imports are erased
 * by the transpiler before the scan, exactly as at run time.
 */
function staticClosure(
	root: string,
	entry: string,
	inside: (rel: string) => boolean,
): { files: string[]; escapes: Escape[] } {
	const start = resolve(root, entry);
	const importer = new Map<string, string | null>([[start, null]]);
	const queue = [start];
	const escapes: Escape[] = [];
	while (queue.length > 0) {
		const file = queue.shift() as string;
		const rel = relative(root, file);
		if (!inside(rel) || !existsSync(file)) {
			const chain: string[] = [];
			for (let at = importer.get(file); at; at = importer.get(at)) chain.push(relative(root, at));
			escapes.push({ file: rel, chain });
			continue;
		}
		const loader = loaderOf(file);
		if (loader === null) continue; // a data file (json): a leaf
		const imports = new Bun.Transpiler({ loader }).scanImports(readFileSync(file, 'utf8'));
		for (const edge of imports) {
			if (edge.kind !== 'import-statement' || !edge.path.startsWith('.')) continue;
			const dep = resolve(dirname(file), edge.path);
			if (!importer.has(dep)) {
				importer.set(dep, file);
				queue.push(dep);
			}
		}
	}
	return { files: [...importer.keys()].map((file) => relative(root, file)), escapes };
}

const insideEngineTree = (rel: string): boolean =>
	ENGINE_FILES.some((held) => rel === held || rel.startsWith(held + sep));

/** Every module a gate imports from a tree it built: `module('src/…')` + the CLI. */
function treeEntries(): { entry: string; gate: string }[] {
	const dir = join(REPO_ROOT, 'test', 'unit');
	const entries: { entry: string; gate: string }[] = [];
	for (const name of readdirSync(dir).filter((file) => file.endsWith('.test.ts'))) {
		if (name === 'engine_tree_closure_native.test.ts') continue;
		const source = readFileSync(join(dir, name), 'utf8');
		if (!source.includes('engineCliAt(')) continue;
		entries.push({ entry: TREE_CLI, gate: name });
		for (const match of source.matchAll(/\bmodule\('([^']+)'\)/g)) {
			entries.push({ entry: match[1] as string, gate: name });
		}
	}
	return entries;
}

describe('engine tree closure — what a tree-run module imports is in the tree', () => {
	const entries = treeEntries();
	const distinct = [...new Set(entries.map((row) => row.entry))].sort();

	test('the walk has entries: the CLI and the modules the gates import from a tree', () => {
		expect(distinct).toContain(TREE_CLI);
		expect(distinct).toContain(join('src', 'core', 'update', 'engine.ts'));
		expect(distinct.length).toBeGreaterThanOrEqual(3);
		for (const entry of distinct) {
			expect(existsSync(join(REPO_ROOT, entry)), `${entry} does not exist`).toBe(true);
			expect(insideEngineTree(entry), `${entry} is not in the tree`).toBe(true);
		}
	});

	test('the walk reads a real graph: the update engine alone reaches dozens of modules', () => {
		// a walk that read nothing proves nothing
		const engine = staticClosure(REPO_ROOT, join('src', 'core', 'update', 'engine.ts'), () => true);
		expect(engine.files.length).toBeGreaterThan(30);
		expect(engine.files).toContain(join('src', 'core', 'update', 'boot_state.ts'));
	});

	for (const entry of distinct) {
		test(`${entry}: its static closure stays inside the engine tree`, () => {
			const { files, escapes } = staticClosure(REPO_ROOT, entry, insideEngineTree);
			expect(files).toContain(entry);
			expect(
				escapes.map((out) => `${out.file} <- ${out.chain.join(' <- ')}`),
				`${entry} cannot be imported from an engine tree (test/helpers/engine_cli_tree.ts ENGINE_FILES)`,
			).toEqual([]);
		});
	}

	test('positive control: one static edge out of the tree is named with its chain; a lazy or type-only one is not', () => {
		const root = mkdtempSync(join(tmpdir(), 'dedalo-engine-closure-'));
		try {
			const write = (rel: string, body: string): void => {
				const path = join(root, rel);
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, body);
			};
			write('src/entry.ts', "import { mid } from './mid.ts';\nexport const entry = mid;\n");
			write(
				'src/mid.ts',
				"import { policy } from '../client/policy.js';\nimport type { T } from '../client/types.ts';\nexport const mid: T = policy;\n",
			);
			write('client/policy.js', 'export const policy = 1;\n');
			write(
				'src/lazy.ts',
				"export const lazy = async () => (await import('../client/policy.js')).policy;\n",
			);
			const inside = (rel: string): boolean => rel.startsWith(`src${sep}`);

			const broken = staticClosure(root, 'src/entry.ts', inside);
			expect(broken.escapes).toEqual([
				{
					file: join('client', 'policy.js'),
					chain: [join('src', 'mid.ts'), join('src', 'entry.ts')],
				},
			]);
			expect(staticClosure(root, 'src/lazy.ts', inside).escapes).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
