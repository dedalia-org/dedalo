/**
 * TEST CO-LOCATION COMPONENTS — the ownership census of every surface two test
 * files can DESTROY for each other, and the union-find closure over it.
 *
 * WHY THIS EXISTS (verified 2026-08-25). Planning a sharded suite over per-file
 * timings assumed the co-location constraints were small disjoint groups. They
 * are not — they are ONE CONNECTED COMPONENT, and that makes a naive
 * cost-balanced bin-pack over timings INCORRECT, not merely suboptimal. Three
 * surfaces weld the files together:
 *
 *  1. SCRATCH zz* TLDs. `src/core/test_data/situations/situation.ts` validates
 *     only the SHAPE (`/^zz[a-z]*$/`) — there is NO uniqueness check anywhere —
 *     while `dropSituation` is TLD-WIDE DESTRUCTIVE (`deleteTldNodes` + `DELETE
 *     FROM <table> WHERE section_tipo=$1` + TM rows + the `matrix_counter`
 *     row). Two files sharing a zz TLD in different processes: one deletes the
 *     other's ontology mid-run. Measured at the census seed (this scanner,
 *     2026-08-25): 124 files carry a zz* literal across 165 alphabetic TLDs;
 *     20 TLDs are shared (the plan's cruder prefix count said 23 — the delta
 *     is helper-ownership attribution plus maximal-alphabetic-head folding).
 *  2. TEST-CORPUS SCOPES. `ensureTestCorpus(scope?)` is delete-then-insert and
 *     `dropTestCorpus(scope?)` asserts residue 0 — two files driving the same
 *     scope concurrently corrupt each other's substrate. An UNSCOPED call is
 *     the whole 446-record / 36-section corpus, so it conflicts with EVERY
 *     scoped caller: the two unscoped files (`unit/json_codec_roundtrip`,
 *     `unit/test_corpus_fixture`) weld all corpus callers into one component,
 *     and `unit/diffusion_export_unified`'s ['testmint1','test6099'] scope
 *     bridges the two largest clusters.
 *  3. The CANONICAL test3 RECORD SET (records 1/2/27): `restoreCanonicalTest3`
 *     rewrites the rows other gates are mid-assertion on. (This is NOT the
 *     WC-021 partition — `manifest.ts`'s SUITE_ISOLATION_RECORDS belongs
 *     to the CLIENT suites and is a different contract.)
 *
 * Membership is DERIVED BY SCANNING SOURCE — never a hand list: comment-
 * stripped `.test.ts` files plus `test/helpers/*.ts`, with helper usage
 * attributed to consumers through the import graph (`extractImportSpecifiers`
 * from `test/helpers/no_write_scan.ts`, which already covers dynamic
 * `import()` — the exact hole that once let a full matrix write past a
 * no-write gate; this module deliberately does NOT grow a second extractor).
 *
 * CONSUMERS. Two shrink-only tripwires read the classification
 * (`test/unit/scratch_tld_uniqueness_tripwire.test.ts`,
 * `test/unit/corpus_scope_ownership_tripwire.test.ts`); the Phase 3 shard
 * partitioner imports `buildTestComponentCensus()` so a shard boundary can
 * never split a component. `--write` snapshots the map to
 * `engineering/test_baseline/components.json` (engineering/, never rewrite/ —
 * the file is machine-read).
 *
 * WHAT THIS DOES NOT PROVE, stated plainly:
 *  - It reads SOURCE, not runtime behaviour. A tipo assembled from fragments
 *    the tiny evaluator cannot see (arbitrary calls, data-driven maps) is
 *    invisible to the zz census; the corpus census refuses that shape loudly
 *    instead — an unresolvable scope argument is CLASSIFIED as `unresolved`
 *    and treated as conflicting with every corpus caller (over-welding is the
 *    safe direction for a scheduler; under-welding is a wrong answer).
 *  - Sharing a surface is a CO-LOCATION constraint, not proof of a bug today:
 *    the current single-process runner serializes files, so the destruction is
 *    latent until files run in parallel processes. That latency is exactly why
 *    the census exists before the partitioner does.
 *  - It does not model DB-global surfaces every file shares by construction
 *    (the marker row, sequences); those are the suite database's own contract.
 *
 * HERMETIC: filesystem reads of tracked test source. No DB, no network.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Glob } from 'bun';
import { extractImportSpecifiers } from '../../test/helpers/no_write_scan.ts';
import { stripComments } from '../../test/helpers/strip_comments.ts';

/** Repo root — this file lives at scripts/lib/. */
const REPO_ROOT = join(import.meta.dir, '..', '..');
const TEST_DIR = join(REPO_ROOT, 'test');

/**
 * Census meta-files: the two tripwires that BASELINE these surfaces spell
 * zz TLD names as data (their shrink-only lists), so scanning them would make
 * each gate a phantom "carrier" of every TLD it merely lists. They own no
 * scratch data and call no corpus door; excluding them is scope hygiene, not a
 * blind spot — and the anti-vacuity floors below fail if the exclusion ever
 * silently swallows real carriers.
 */
export const CENSUS_META_FILES: readonly string[] = [
	'test/unit/scratch_tld_uniqueness_tripwire.test.ts',
	'test/unit/corpus_scope_ownership_tripwire.test.ts',
];

/** Every census file, repo-relative (`test/unit/foo.test.ts`), sorted. */
export function censusFiles(): string[] {
	const tests = [...new Glob('**/*.test.ts').scanSync({ cwd: TEST_DIR })].map((f) => `test/${f}`);
	const helpers = [...new Glob('*.ts').scanSync({ cwd: join(TEST_DIR, 'helpers') })].map(
		(f) => `test/helpers/${f}`,
	);
	return [...tests, ...helpers].filter((f) => !CENSUS_META_FILES.includes(f)).sort();
}

export function isHelperFile(file: string): boolean {
	return file.startsWith('test/helpers/');
}

function read(file: string): string {
	return readFileSync(join(REPO_ROOT, file), 'utf8');
}

// ── zz* TLD census ───────────────────────────────────────────────────────────

/**
 * A zz literal's TLD is its maximal alphabetic head (`'zzd05'` → `zzd`),
 * because that is the unit `situation()` validates (`/^zz[a-z]*$/`) and
 * `dropSituation` destroys. The match requires the quote IMMEDIATELY before
 * `zz` so identifiers and prose inside longer strings do not count; comments
 * are stripped first so a header may NAME a TLD without owning it.
 */
const ZZ_LITERAL = /['"`](zz[a-z]*)(?=[0-9'"`]|\$\{)/g;

/** TLD → the files whose SOURCE carries a literal under it. */
export function zzTldCarriers(files: readonly string[] = censusFiles()): Map<string, Set<string>> {
	const carriers = new Map<string, Set<string>>();
	for (const file of files) {
		const source = stripComments(read(file));
		for (const match of source.matchAll(ZZ_LITERAL)) {
			const tld = match[1] as string;
			const set = carriers.get(tld) ?? new Set<string>();
			set.add(file);
			carriers.set(tld, set);
		}
	}
	return carriers;
}

/**
 * file → every `test/helpers/*.ts` module it reaches through imports,
 * TRANSITIVELY (helpers import helpers). Static and dynamic forms both count —
 * see the extractor's own header for why that matters.
 */
export function helperImportClosure(
	files: readonly string[] = censusFiles(),
): Map<string, Set<string>> {
	const direct = new Map<string, Set<string>>();
	for (const file of files) {
		const out = new Set<string>();
		for (const specifier of extractImportSpecifiers(read(file))) {
			if (!specifier.startsWith('.')) continue;
			const absolute = resolve(REPO_ROOT, dirname(file), specifier);
			if (!absolute.startsWith(join(TEST_DIR, 'helpers'))) continue;
			const relative = absolute.slice(REPO_ROOT.length + 1);
			if (existsSync(absolute)) out.add(relative);
		}
		direct.set(file, out);
	}
	// Transitive closure, helper hops only (the graph is tiny).
	const closure = new Map<string, Set<string>>();
	for (const file of files) {
		const seen = new Set<string>();
		const queue = [...(direct.get(file) ?? [])];
		while (queue.length > 0) {
			const helper = queue.shift() as string;
			if (seen.has(helper)) continue;
			seen.add(helper);
			for (const next of direct.get(helper) ?? []) queue.push(next);
		}
		closure.set(file, seen);
	}
	return closure;
}

export interface SharedTld {
	tld: string;
	/** Files carrying a literal under the TLD, sorted. */
	carriers: string[];
	/** Why the ownership rule convicts this TLD. */
	why: 'multiple-carriers' | 'carrier-outside-helper-consumers' | 'multiple-helper-carriers';
}

/**
 * The ownership rule, PURE so a gate can feed it a synthetic corpus as its
 * positive control. A TLD is OWNED when either:
 *  - exactly ONE file carries it (test file or helper), or
 *  - exactly ONE helper carries it and every other carrier IMPORTS that helper
 *    (the helper is the named owner; a consumer may spell the owner's tipos in
 *    its assertions without becoming a second owner).
 * Everything else is SHARED — the latent mutual destruction this census exists
 * to name.
 */
export function classifySharedTlds(
	carriers: Map<string, Set<string>>,
	importClosure: Map<string, Set<string>>,
	isHelper: (file: string) => boolean = isHelperFile,
): SharedTld[] {
	const shared: SharedTld[] = [];
	for (const [tld, set] of [...carriers.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		const files = [...set].sort();
		if (files.length <= 1) continue;
		const helpers = files.filter(isHelper);
		if (helpers.length > 1) {
			shared.push({ tld, carriers: files, why: 'multiple-helper-carriers' });
			continue;
		}
		if (helpers.length === 1) {
			const owner = helpers[0] as string;
			const outside = files.filter(
				(f) => f !== owner && !(importClosure.get(f)?.has(owner) ?? false),
			);
			if (outside.length === 0) continue; // helper-owned: consumers all import the owner
			shared.push({ tld, carriers: files, why: 'carrier-outside-helper-consumers' });
			continue;
		}
		shared.push({ tld, carriers: files, why: 'multiple-carriers' });
	}
	return shared;
}

// ── test-corpus scope census ─────────────────────────────────────────────────

export interface CorpusCall {
	file: string;
	line: number;
	/**
	 * The section tipos the call names; `'unscoped'` = whole-corpus call;
	 * `'unresolved'` = an argument the static evaluator cannot read — treated
	 * as conflicting with EVERY corpus caller, because guessing narrower would
	 * be silently narrowing scope.
	 */
	scope: string[] | 'unscoped' | 'unresolved';
}

/** `const NAME = <expr>` declarations with offsets (a name may repeat per block). */
function constDeclarations(source: string): Map<string, { offset: number; expr: string }[]> {
	const out = new Map<string, { offset: number; expr: string }[]>();
	for (const match of source.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*/g)) {
		const start = (match.index ?? 0) + match[0].length;
		// Walk to the terminating `;` at depth 0 (biome enforces semicolons).
		let depth = 0;
		let end = start;
		while (end < source.length) {
			const char = source[end] as string;
			if ('([{'.includes(char)) depth++;
			else if (')]}'.includes(char)) depth--;
			else if (char === ';' && depth === 0) break;
			end++;
		}
		const list = out.get(match[1] as string) ?? [];
		list.push({ offset: match.index ?? 0, expr: source.slice(start, end).trim() });
		out.set(match[1] as string, list);
	}
	return out;
}

/** Split on TOP-LEVEL commas (same shape as the mock tripwire's splitter). */
function splitTopLevel(source: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let current = '';
	for (const char of source) {
		if ('([{'.includes(char)) depth++;
		else if (')]}'.includes(char)) depth--;
		if (char === ',' && depth === 0) {
			out.push(current);
			current = '';
			continue;
		}
		current += char;
	}
	if (current.trim() !== '') out.push(current);
	return out;
}

type Consts = Map<string, { offset: number; expr: string }[]>;

/** Nearest declaration of `name` BEFORE `at` (block-local `const scope` repeats). */
function constBefore(consts: Consts, name: string, at: number): string | null {
	const candidates = (consts.get(name) ?? []).filter((d) => d.offset < at);
	if (candidates.length === 0) return null;
	return (candidates[candidates.length - 1] as { expr: string }).expr;
}

/**
 * Evaluate the tiny expression language scope arguments are written in:
 * string literals, templates over literal parts (`` `dd${542}` ``), file-local
 * const strings, and the pilot `seed('tld', N)` concat convention. `null` =
 * unresolvable, and the CALLER decides what that means (it never guesses).
 */
function evaluateString(expression: string, consts: Consts, at: number, depth = 0): string | null {
	if (depth > 8) return null;
	let text = expression.trim().replace(/\s+as\s+const$/, '');
	if (text.startsWith('(') && text.endsWith(')')) text = text.slice(1, -1).trim();
	let match = /^'([^'\\]*)'$/.exec(text) ?? /^"([^"\\]*)"$/.exec(text);
	if (match !== null) return match[1] as string;
	if (/^\d+$/.test(text)) return text;
	if (text.startsWith('`') && text.endsWith('`')) {
		const body = text.slice(1, -1);
		let value = '';
		let rest = body;
		while (rest.length > 0) {
			const hole = rest.indexOf('${');
			if (hole === -1) {
				value += rest;
				break;
			}
			value += rest.slice(0, hole);
			const close = rest.indexOf('}', hole);
			if (close === -1) return null;
			const part = evaluateString(rest.slice(hole + 2, close), consts, at, depth + 1);
			if (part === null) return null;
			value += part;
			rest = rest.slice(close + 1);
		}
		return value;
	}
	if (/^[A-Za-z_$][\w$]*$/.test(text)) {
		const expr = constBefore(consts, text, at);
		return expr === null ? null : evaluateString(expr, consts, at, depth + 1);
	}
	// The pilot `seed('rsc', 205)` convention: callee must be the file-local
	// concat arrow — anything else stays unresolvable on purpose.
	match = /^([A-Za-z_$][\w$]*)\(([\s\S]*)\)$/.exec(text);
	if (match !== null) {
		const callee = constBefore(consts, match[1] as string, at);
		if (
			callee === null ||
			!/^\([^)]*\)(?:\s*:\s*string)?\s*=>\s*`\$\{\w+\}\$\{\w+\}`$/.test(callee)
		)
			return null;
		const parts = splitTopLevel(match[2] as string).map((argument) =>
			evaluateString(argument, consts, at, depth + 1),
		);
		if (parts.some((p) => p === null)) return null;
		return parts.join('');
	}
	return null;
}

/** Evaluate a scope argument into tipos; `null` on ANY unresolvable element. */
function evaluateScope(expression: string, consts: Consts, at: number, depth = 0): string[] | null {
	if (depth > 8) return null;
	const text = expression.trim().replace(/\s+as\s+const$/, '');
	if (text.startsWith('[') && text.endsWith(']')) {
		const out: string[] = [];
		for (const element of splitTopLevel(text.slice(1, -1))) {
			const item = element.trim();
			if (item === '') continue;
			if (item.startsWith('...')) {
				const inner = evaluateScope(item.slice(3), consts, at, depth + 1);
				if (inner === null) return null;
				out.push(...inner);
				continue;
			}
			const value = evaluateString(item, consts, at, depth + 1);
			if (value === null) return null;
			out.push(value);
		}
		return out;
	}
	const single = evaluateString(text, consts, at, depth);
	if (single !== null) return [single];
	if (/^[A-Za-z_$][\w$]*$/.test(text)) {
		const expr = constBefore(consts, text, at);
		return expr === null ? null : evaluateScope(expr, consts, at, depth + 1);
	}
	return null;
}

/** Every `ensureTestCorpus(...)` / `dropTestCorpus(...)` CALL in the tree. */
export function corpusCalls(files: readonly string[] = censusFiles()): CorpusCall[] {
	const calls: CorpusCall[] = [];
	for (const file of files) {
		const source = stripComments(read(file));
		const consts = constDeclarations(source);
		for (const match of source.matchAll(/\b(?:ensureTestCorpus|dropTestCorpus)\s*\(/g)) {
			const at = match.index ?? 0;
			const argsStart = at + match[0].length;
			let depth = 1;
			let end = argsStart;
			while (end < source.length && depth > 0) {
				const char = source[end] as string;
				if ('([{'.includes(char)) depth++;
				else if (')]}'.includes(char)) depth--;
				end++;
			}
			const argument = splitTopLevel(source.slice(argsStart, end - 1))[0]?.trim() ?? '';
			const line = source.slice(0, at).split('\n').length;
			if (argument === '') {
				calls.push({ file, line, scope: 'unscoped' });
				continue;
			}
			const scope = evaluateScope(argument, consts, at);
			calls.push({ file, line, scope: scope === null ? 'unresolved' : scope });
		}
	}
	return calls;
}

export interface CorpusOwnership {
	/** scope tipo → the files that drive it, sorted. */
	scopeFiles: Map<string, Set<string>>;
	/** Files with at least one whole-corpus call. */
	unscopedFiles: Set<string>;
	/** Files with at least one statically unreadable scope, with coordinates. */
	unresolvedCalls: CorpusCall[];
	/** Every file that calls either corpus door at all. */
	allCallers: Set<string>;
}

/** Fold the call list into per-scope ownership. PURE over its input. */
export function corpusOwnership(calls: readonly CorpusCall[]): CorpusOwnership {
	const scopeFiles = new Map<string, Set<string>>();
	const unscopedFiles = new Set<string>();
	const unresolvedCalls: CorpusCall[] = [];
	const allCallers = new Set<string>();
	for (const call of calls) {
		allCallers.add(call.file);
		if (call.scope === 'unscoped') {
			unscopedFiles.add(call.file);
			continue;
		}
		if (call.scope === 'unresolved') {
			unresolvedCalls.push(call);
			continue;
		}
		for (const tipo of call.scope) {
			const set = scopeFiles.get(tipo) ?? new Set<string>();
			set.add(call.file);
			scopeFiles.set(tipo, set);
		}
	}
	return { scopeFiles, unscopedFiles, unresolvedCalls, allCallers };
}

/** Scopes with more than one owning file — the shared set the gate ratchets. */
export function sharedCorpusScopes(
	ownership: CorpusOwnership,
): { scope: string; owners: string[] }[] {
	return [...ownership.scopeFiles.entries()]
		.filter(([, files]) => files.size > 1)
		.map(([scope, files]) => ({ scope, owners: [...files].sort() }))
		.sort((a, b) => a.scope.localeCompare(b.scope));
}

// ── canonical test3 census ───────────────────────────────────────────────────

/**
 * Files that rewrite the canonical test3 records (1/2/27) mid-suite. Both
 * spellings count: the raw `restoreCanonicalTest3` and the drift-checking
 * `ensureCanonicalTest3` wrapper — the wrapper restores too when drift exists,
 * and whether it fires depends on what ran before it, which is exactly the
 * ordering hazard this census records.
 */
export function canonicalTest3Users(files: readonly string[] = censusFiles()): Set<string> {
	const users = new Set<string>();
	for (const file of files) {
		if (isHelperFile(file)) continue; // the wrapper's own home is not a user
		// Import statements are dropped first: a USE is a call (`restore…()`) or
		// a reference handed to the runner (`beforeAll(ensureCanonicalTest3)`) —
		// agent_loop.test.ts uses exactly that spelling, and a call-paren-only
		// matcher missed it at the census seed.
		const source = stripComments(read(file)).replace(/^import[\s\S]*?;$/gm, '');
		if (/\b(?:ensureCanonicalTest3|restoreCanonicalTest3)\b/.test(source)) users.add(file);
	}
	return users;
}

// ── union-find closure ───────────────────────────────────────────────────────

export interface ComponentEdge {
	kind: 'zz_tld' | 'corpus_scope' | 'corpus_unscoped' | 'corpus_unresolved' | 'canonical_test3';
	/** The surface's name — the TLD, the scope tipo, or the welding file. */
	surface: string;
	/** The files this surface welds together, sorted. */
	files: string[];
}

export interface Component {
	files: string[];
	edges: ComponentEdge[];
}

export interface TestComponentCensus {
	/** Multi-file components, LARGEST FIRST — the partitioner's atomic units. */
	components: Component[];
	/** Test files touching none of the shared surfaces (free to schedule alone). */
	unconstrained: string[];
	sharedTlds: SharedTld[];
	sharedScopes: { scope: string; owners: string[] }[];
	corpus: CorpusOwnership;
}

class UnionFind {
	private readonly parent = new Map<string, string>();
	find(node: string): string {
		let root = this.parent.get(node) ?? node;
		if (root !== node) {
			root = this.find(root);
			this.parent.set(node, root);
		}
		return root;
	}
	union(a: string, b: string): void {
		const ra = this.find(a);
		const rb = this.find(b);
		if (ra !== rb) this.parent.set(ra, rb);
	}
}

/** The full census: scan, weld, and group. Test FILES are the nodes. */
export function buildTestComponentCensus(): TestComponentCensus {
	const files = censusFiles();
	const testFiles = files.filter((f) => !isHelperFile(f));
	const closure = helperImportClosure(files);
	const carriers = zzTldCarriers(files);
	const uf = new UnionFind();
	const edges: ComponentEdge[] = [];

	// 1. zz TLDs. USERS of a TLD = direct carriers that are test files, plus
	//    every test file importing a helper carrier — the helper's drop is the
	//    consumer's drop.
	for (const [tld, carrierSet] of carriers) {
		const users = new Set<string>();
		for (const carrier of carrierSet) {
			if (!isHelperFile(carrier)) {
				users.add(carrier);
				continue;
			}
			for (const file of testFiles) {
				if (closure.get(file)?.has(carrier) ?? false) users.add(file);
			}
		}
		if (users.size < 2) continue;
		const list = [...users].sort();
		for (const file of list) uf.union(list[0] as string, file);
		edges.push({ kind: 'zz_tld', surface: tld, files: list });
	}

	// 2. Corpus scopes. A shared scope welds its owners; an UNSCOPED or
	//    UNRESOLVED caller welds to EVERY corpus caller (see the header for why
	//    over-welding is the safe direction).
	const corpus = corpusOwnership(corpusCalls(files));
	for (const [scope, owners] of corpus.scopeFiles) {
		if (owners.size < 2) continue;
		const list = [...owners].sort();
		for (const file of list) uf.union(list[0] as string, file);
		edges.push({ kind: 'corpus_scope', surface: scope, files: list });
	}
	const allCallers = [...corpus.allCallers].sort();
	const wholeCorpus = new Set([
		...corpus.unscopedFiles,
		...corpus.unresolvedCalls.map((c) => c.file),
	]);
	for (const file of [...wholeCorpus].sort()) {
		for (const other of allCallers) uf.union(file, other);
		edges.push({
			kind: corpus.unscopedFiles.has(file) ? 'corpus_unscoped' : 'corpus_unresolved',
			surface: file,
			files: allCallers,
		});
	}

	// 3. The canonical test3 record set: one clique.
	const canonical = [...canonicalTest3Users(files)].sort();
	if (canonical.length >= 2) {
		for (const file of canonical) uf.union(canonical[0] as string, file);
		edges.push({ kind: 'canonical_test3', surface: 'test3 records 1/2/27', files: canonical });
	}

	// Group.
	const groups = new Map<string, Set<string>>();
	const welded = new Set(edges.flatMap((edge) => edge.files));
	for (const file of welded) {
		const root = uf.find(file);
		const set = groups.get(root) ?? new Set<string>();
		set.add(file);
		groups.set(root, set);
	}
	const components: Component[] = [...groups.values()]
		.map((set) => {
			const members = [...set].sort();
			return {
				files: members,
				edges: edges
					.filter((edge) => set.has(edge.files[0] as string))
					.sort((a, b) => a.kind.localeCompare(b.kind) || a.surface.localeCompare(b.surface)),
			};
		})
		.sort(
			(a, b) =>
				b.files.length - a.files.length || (a.files[0] ?? '').localeCompare(b.files[0] ?? ''),
		);

	return {
		components,
		unconstrained: testFiles.filter((f) => !welded.has(f)).sort(),
		sharedTlds: classifySharedTlds(carriers, closure),
		sharedScopes: sharedCorpusScopes(corpus),
		corpus,
	};
}

// ── report + snapshot ────────────────────────────────────────────────────────

export function componentReport(census: TestComponentCensus = buildTestComponentCensus()): string {
	const lines: string[] = [];
	lines.push(
		`components: ${census.components.length} (multi-file), ` +
			`largest ${census.components[0]?.files.length ?? 0} files; ` +
			`unconstrained: ${census.unconstrained.length}`,
	);
	for (const [index, component] of census.components.entries()) {
		lines.push(`\n== component ${index + 1} — ${component.files.length} files ==`);
		for (const file of component.files) lines.push(`  ${file}`);
		lines.push('  welded by:');
		for (const edge of component.edges) {
			lines.push(`    [${edge.kind}] ${edge.surface} (${edge.files.length} files)`);
		}
	}
	lines.push(`\nshared zz TLDs: ${census.sharedTlds.length}`);
	for (const shared of census.sharedTlds) {
		lines.push(`  ${shared.tld} (${shared.why}): ${shared.carriers.join(', ')}`);
	}
	lines.push(`shared corpus scopes: ${census.sharedScopes.length}`);
	for (const shared of census.sharedScopes) {
		lines.push(`  ${shared.scope}: ${shared.owners.join(', ')}`);
	}
	lines.push(`unscoped corpus callers: ${[...census.corpus.unscopedFiles].sort().join(', ')}`);
	for (const call of census.corpus.unresolvedCalls) {
		lines.push(`unresolved corpus scope: ${call.file}:${call.line}`);
	}
	return lines.join('\n');
}

/** The machine-read snapshot. engineering/, never rewrite/ (hard rule). */
export const COMPONENTS_JSON_PATH = join(REPO_ROOT, 'engineering', 'test_baseline');

export function writeComponentsJson(
	census: TestComponentCensus = buildTestComponentCensus(),
): string {
	mkdirSync(COMPONENTS_JSON_PATH, { recursive: true });
	const path = join(COMPONENTS_JSON_PATH, 'components.json');
	const payload = {
		// Deliberately NO timestamp: the file must be byte-stable so a re-run on
		// an unchanged tree diffs empty.
		components: census.components,
		unconstrained: census.unconstrained,
	};
	writeFileSync(path, `${JSON.stringify(payload, null, '\t')}\n`);
	return path;
}

if (import.meta.main) {
	const args = new Set(Bun.argv.slice(2));
	const census = buildTestComponentCensus();
	if (args.has('--write')) {
		console.log(`wrote ${writeComponentsJson(census)}`);
	}
	console.log(componentReport(census));
}
