/**
 * NO INSTALLATION'S TIPO IS AN ENGINE CONSTANT — AND TLD-OWNED CODE NAMES ONLY
 * ITS OWN TLD.
 *
 * `generic_tld_tripwire` holds this line for TESTS. It stops at `test/`, and the
 * same accident is worse one directory over: a tipo belonging to one
 * installation, compiled into `src/`, is not a gate that passes on one machine —
 * it is BEHAVIOUR that is correct on one machine. It does not fail anywhere
 * else, it just quietly resolves nothing.
 *
 * Measured 2026-08-22, that had happened four times, in three distinct shapes,
 * and all four were DEFAULTS — the one place an install name hides in plain
 * sight, because the code around it reads perfectly generic:
 *
 *   - `MAIN_SECTION` defaulted to `oh1`, the oral-history install's section and
 *     the page every user lands on after login. Now empty: a login with no deep
 *     link opens the menu, which is a real state rather than a broken tipo.
 *   - `MENU_SKIP_TIPOS` defaulted to two more installs' menu nodes, in a key
 *     whose own documentation already showed the default as an empty array. Now
 *     empty, as documented.
 *   - a test fixture named after the `dmm` install wrote its record into
 *     `matrix`, the installation's table — moved to the generic `test` TLD.
 *   - the iconography ddo defaults `inner_relation` to `numisdata722`, inherited
 *     verbatim from PHP. It is the ONE survivor, and the baseline below says why.
 *
 * ── THE SIX LEGS (2026-11-13, T1-1 rulings: `src/tld/` packages) ─────────────
 * Some code legitimately serves ONE installation's ontology — the mdcat grant
 * chain hard-codes the section whose final_total takes the major branch. The
 * owner ruled that such code is TLD-OWNED and lives in `src/tld/<tld>/`, a peer
 * of core, reached only through `src/tld/registry.ts`. So the rule has scopes:
 *
 *  1. GENERIC ENGINE (`src/` minus `src/tld/`): the set of install-named tipo
 *     literals may only SHRINK (the inline baseline, LIVE — a stale entry is red).
 *  2. OWN TLD ONLY: a file under `src/tld/<tld>/` may name `<tld>`'s tipos and
 *     no other install's.
 *  3. IMPORT DIRECTION: `src/tld/<tld>/…` is imported only by `src/tld/registry.ts`
 *     or from inside the same package; `src/tld/**` never imports `src/diffusion/`,
 *     `src/external/`, `src/ai/`; outside `src/tld/`, the registry's importers
 *     are an enumerated door list (today: the calculation widget).
 *  4. NO SHADOWING: no package fn name equals a generic calculation fn name
 *     (a generic file naming a TLD fn, or the reverse, must REFUSE, which only
 *     holds when the name sets are disjoint).
 *  5. REGISTRY CENSUS: every directory under `src/tld/` is registered, every
 *     registered TLD is a census TLD, and every module's dispatch key is
 *     `/<tld>/<module>.ts` (so a test never spells the path).
 *  6. TOOLS: `tools/tool_<tld>_*` names only its own TLD's tipos; a tool whose
 *     name carries no install TLD names none (measured 0 on adoption day).
 *
 * SEED-SHIPPED TLDs ARE NOT INSTALL NAMES. `rsc`, `dd`, `hierarchy`, `ontology`,
 * `ontologytype` and `lg` ship with EVERY installation, so `rsc170` in engine
 * code is a reference to the shipped ontology, not to somebody's data. They are
 * excluded here — and only here: a TEST may still not name an `rsc` SECTION,
 * because section_ids collide, which is `generic_tld_tripwire`'s business.
 *
 * ── HONEST LIMITATIONS ───────────────────────────────────────────────────────
 *  - SOURCE TEXT, so a tipo built by concatenation (`${tld}1`) is invisible.
 *    That shape has its own history in the hierarchy family and its own gates
 *    (hierarchy_state_native, "foreign target sections").
 *  - SINGLE-QUOTED tipo literals only (biome's quote style; measured 2026-11-13:
 *    the any-quote scan adds only `"oh1"`/`"oh23"` inside MCP tool DESCRIPTION
 *    prose and a config default's documentation string, none of them behaviour).
 *  - A per-install widget directory (`component_info/widgets/{numisdata,oh,dmm}/`)
 *    is a port layout, not a hardcode; a per-install PACKAGE is what leg 2
 *    measures.
 *  - The TLD list is imported from the census, never re-typed: one source of
 *    truth, so an install added there is covered here the same day.
 *
 * HERMETIC: filesystem reads of tracked source + one in-process import of the
 * two registries (frozen tables, no DB). No network, no clock.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { INSTALL_TLDS } from '../../scripts/lib/tld_census.ts';
import {
	CALCULATION_FUNCTIONS,
	type CalculationFn,
} from '../../src/core/components/component_info/widgets/calculation/functions.ts';
import { CORE_ONTOLOGY_TLDS } from '../../src/core/ontology/core_tlds.ts';
import { MDCAT_CALCULATION_FILE } from '../../src/tld/mdcat/calculation.ts';
import { mdcat } from '../../src/tld/mdcat/index.ts';
import { resolveCalculationFn, TLD_PACKAGES } from '../../src/tld/registry.ts';
import type { TldPackage } from '../../src/tld/types.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const SRC_DIR = join(REPO_ROOT, 'src');
const TLD_DIR = join(SRC_DIR, 'tld');
const TOOLS_DIR = join(REPO_ROOT, 'tools');

/**
 * Ships with every installation, so naming one is naming the ONTOLOGY, not an
 * install: the CORE ontologies the install seed carries — linked, never
 * duplicated (src/core/ontology/core_tlds.ts; install_seed_drift_tripwire holds
 * that list equal to the seed's dd_ontology TLD set). `rsc` is the only member
 * that the census also lists (it lists it for the test-side section rule,
 * which is a different question).
 */
const SEED_SHIPPED: ReadonlySet<string> = new Set(CORE_ONTOLOGY_TLDS);

/**
 * LEG 1 — `<file>:<tipo>` → why it is still here. SHRINK-ONLY.
 *
 * All four were DEFAULTS, which is the one place an install name can hide in
 * plain sight: the code is generic and the constant it falls back to is not.
 */
const ENGINE_INSTALL_TIPOS: Record<string, string> = {
	'diffusion/resolve/ddo_fns.ts:numisdata722':
		'PHP_DEFAULT_INNER_RELATION — inherited verbatim from component_portal (:479-482), not chosen. Deleting it is a WIRE change: if the one element using get_diffusion_iconography relies on the implicit default, its published column empties. The durable fix is on the ONTOLOGY side (that ddo declares inner_relation), after which this entry goes.',
};

/**
 * LEG 3c — the files outside `src/tld/` that may import `src/tld/registry.ts`
 * (repo-relative). Grows only by review: a second door is a second dispatch
 * home, and the registry's whole point is that there is one.
 */
const REGISTRY_DOORS: ReadonlySet<string> = new Set([
	'src/core/components/component_info/widgets/calculation/calculation.ts',
]);

/** Subsystems a TLD package may never reach (tld → core only). */
const FORBIDDEN_FOR_PACKAGES = ['src/diffusion/', 'src/external/', 'src/ai/'];

/** This file NAMES every literal it hunts, in its baseline and its prose. */
const SELF = 'engine_install_tld_tripwire.test.ts';

const HUNTED = [...INSTALL_TLDS].filter((tld) => !SEED_SHIPPED.has(tld));

/** `'<tld><digits>'` — a quoted tipo literal. Longest tld first, so `tch` cannot
 * shadow `tchi`. */
const TIPO_LITERAL = new RegExp(
	`'(${[...HUNTED].sort((a, b) => b.length - a.length).join('|')})(\\d+)'`,
	'g',
);

function sourceFiles(dir: string, extensions: readonly string[], found: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			if (entry !== 'node_modules') sourceFiles(full, extensions, found);
		} else if (extensions.some((extension) => entry.endsWith(extension))) {
			found.push(full);
		}
	}
	return found;
}

const relativeToRepo = (file: string): string => file.slice(REPO_ROOT.length + 1);

/** A comment line carries prose, not behaviour — this gate is about behaviour. */
function isComment(line: string): boolean {
	const trimmed = line.trimStart();
	return trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*');
}

/**
 * A literal PAIRED with an IRI (`['dc11', 'http://purl.org/dc/elements/1.1/']`)
 * is an RDF namespace PREFIX — a fixed vocabulary name that happens to share a
 * TLD's spelling (Dublin Core elements 1.1 under the `dc` pattern), never a tipo.
 */
// `https?:` only: the `//` of the IRI is where lineInstallTipos cuts a trailing comment.
const NAMESPACE_PAIR_TAIL = /^\s*,\s*['"`]https?:/;

/** The install tipos one line of CODE names (comment prose and namespace prefixes excluded). */
function lineInstallTipos(line: string): string[] {
	if (isComment(line)) return [];
	const code = line.split('//')[0] ?? '';
	const tipos: string[] = [];
	for (const match of code.matchAll(TIPO_LITERAL)) {
		const tail = code.slice((match.index ?? 0) + match[0].length);
		if (NAMESPACE_PAIR_TAIL.test(tail)) continue;
		tipos.push(`${match[1]}${match[2]}`);
	}
	return tipos;
}

/** `<tipo>` → its TLD (the letters). */
const tldOf = (tipo: string): string => tipo.replace(/\d+$/, '');

/** Every install tipo one source TEXT names, with the line it sits on. */
function textInstallTipos(text: string): { tipo: string; line: number }[] {
	const found: { tipo: string; line: number }[] = [];
	const lines = text.split('\n');
	for (let index = 0; index < lines.length; index++) {
		for (const tipo of lineInstallTipos(lines[index] as string))
			found.push({ tipo, line: index + 1 });
	}
	return found;
}

// ─── leg 1: the generic engine ────────────────────────────────────────────────

/** Every `<src-relative file>:<tipo>` naming an install, in non-comment code of `src/` minus `src/tld/`. */
function engineInstallTipos(): string[] {
	const keys = new Set<string>();
	for (const file of sourceFiles(SRC_DIR, ['.ts'])) {
		if (file.startsWith(`${TLD_DIR}/`)) continue;
		const relative = file.slice(SRC_DIR.length + 1);
		for (const { tipo } of textInstallTipos(readFileSync(file, 'utf8'))) {
			keys.add(`${relative}:${tipo}`);
		}
	}
	return [...keys].sort();
}

// ─── leg 2: a package names only its own TLD ──────────────────────────────────

/** The package directories under `src/tld/` (files are not packages). */
function packageDirectories(): string[] {
	return readdirSync(TLD_DIR)
		.filter((entry) => statSync(join(TLD_DIR, entry)).isDirectory())
		.sort();
}

/** `<repo-relative file>:<line>:<tipo>` for every tipo of ANOTHER install a package text names. */
function foreignTiposIn(packageTld: string, file: string, text: string): string[] {
	return textInstallTipos(text)
		.filter(({ tipo }) => tldOf(tipo) !== packageTld)
		.map(({ tipo, line }) => `${file}:${line}:${tipo}`);
}

function packageForeignTipos(): { findings: string[]; files: number } {
	const findings: string[] = [];
	let files = 0;
	for (const tld of packageDirectories()) {
		for (const file of sourceFiles(join(TLD_DIR, tld), ['.ts'])) {
			files++;
			findings.push(...foreignTiposIn(tld, relativeToRepo(file), readFileSync(file, 'utf8')));
		}
	}
	return { findings: findings.sort(), files };
}

// ─── leg 3: import direction ──────────────────────────────────────────────────

/** Every import / export-from / import() specifier of a source text. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"`]([^'"`]+)['"`]/g;

interface ImportEdge {
	/** Repo-relative importing file. */
	file: string;
	line: number;
	/** Repo-relative resolved target (relative specifiers only). */
	target: string;
}

/** The repo-internal import edges of one source text (`file` repo-relative). */
function importEdgesOf(file: string, text: string): ImportEdge[] {
	const edges: ImportEdge[] = [];
	const lines = text.split('\n');
	for (let index = 0; index < lines.length; index++) {
		const lineText = lines[index] as string;
		if (isComment(lineText)) continue;
		for (const match of lineText.matchAll(SPECIFIER)) {
			const specifier = match[1] as string;
			if (!specifier.startsWith('.')) continue;
			const target = resolve(REPO_ROOT, dirname(file), specifier);
			if (!target.startsWith(`${REPO_ROOT}/`)) continue;
			edges.push({ file, line: index + 1, target: relativeToRepo(target) });
		}
	}
	return edges;
}

/** The package a repo-relative path belongs to (`src/tld/<tld>/…`), else null. */
function packageOf(path: string): string | null {
	const match = /^src\/tld\/([^/]+)\//.exec(path);
	return match === null ? null : (match[1] as string);
}

/** Every leg-3 violation one edge is (empty = legal). */
function judgeEdge(edge: ImportEdge): string[] {
	const problems: string[] = [];
	const at = `${edge.file}:${edge.line} → ${edge.target}`;
	const targetPackage = packageOf(edge.target);
	const sourcePackage = packageOf(edge.file);
	// (a) a package's internals are the registry's (or its own) business.
	if (
		targetPackage !== null &&
		edge.file !== 'src/tld/registry.ts' &&
		sourcePackage !== targetPackage
	) {
		problems.push(
			`${at}: a TLD package is imported only by src/tld/registry.ts or from inside itself`,
		);
	}
	// (b) tld → core only.
	if (edge.file.startsWith('src/tld/')) {
		for (const forbidden of FORBIDDEN_FOR_PACKAGES) {
			if (edge.target.startsWith(forbidden))
				problems.push(`${at}: src/tld/ never imports ${forbidden}`);
		}
	}
	// (c) one door into the registry from outside.
	if (
		!edge.file.startsWith('src/tld/') &&
		edge.target.startsWith('src/tld/') &&
		!REGISTRY_DOORS.has(edge.file)
	) {
		problems.push(`${at}: src/tld/ is reached from outside only through the enumerated doors`);
	}
	return problems;
}

/** Leg 3 over every `.ts` under `src/` and `tools/` (tests may import a package). */
function importDirectionFindings(): { findings: string[]; edges: number } {
	const findings: string[] = [];
	let edges = 0;
	for (const file of [...sourceFiles(SRC_DIR, ['.ts']), ...sourceFiles(TOOLS_DIR, ['.ts'])]) {
		for (const edge of importEdgesOf(relativeToRepo(file), readFileSync(file, 'utf8'))) {
			edges++;
			findings.push(...judgeEdge(edge));
		}
	}
	return { findings: findings.sort(), edges };
}

// ─── leg 4: no shadowing ──────────────────────────────────────────────────────

/** `<tld>/<module>:<fn>` for every package fn whose name is a generic fn name. */
function shadowedNames(packages: Iterable<TldPackage>): string[] {
	const generic = new Set(Object.keys(CALCULATION_FUNCTIONS));
	const found: string[] = [];
	for (const pkg of packages) {
		for (const [module, fns] of Object.entries(pkg.calculationModules)) {
			for (const name of Object.keys(fns)) {
				if (generic.has(name)) found.push(`${pkg.tld}/${module}:${name}`);
			}
		}
	}
	return found.sort();
}

// ─── leg 6: tools ─────────────────────────────────────────────────────────────

/** The install TLD a tool's directory name carries (`tool_numisdata_x` → numisdata), else null. */
function toolOwnTld(toolDirectory: string): string | null {
	const name = toolDirectory.replace(/^tool_/, '');
	const candidates = [...INSTALL_TLDS].filter((tld) => name === tld || name.startsWith(`${tld}_`));
	if (candidates.length === 0) return null;
	return candidates.sort((a, b) => b.length - a.length)[0] as string;
}

/** `<tool>:<file>:<line>:<tipo>` for every install tipo a tool text names outside its own TLD. */
function toolForeignTipos(toolDirectory: string, file: string, text: string): string[] {
	const own = toolOwnTld(toolDirectory);
	return textInstallTipos(text)
		.filter(({ tipo }) => tldOf(tipo) !== own)
		.map(({ tipo, line }) => `${toolDirectory}:${file}:${line}:${tipo}`);
}

/** A tool's own test tree is a TEST (generic_tld_tripwire's business), not tool code. */
const isToolTestFile = (relative: string): boolean => /\/test\//.test(relative);

function toolsFindings(): { findings: string[]; tools: number; files: number } {
	const findings: string[] = [];
	let files = 0;
	const tools = readdirSync(TOOLS_DIR).filter(
		(entry) => entry.startsWith('tool_') && statSync(join(TOOLS_DIR, entry)).isDirectory(),
	);
	for (const tool of tools) {
		for (const file of sourceFiles(join(TOOLS_DIR, tool), ['.ts', '.js'])) {
			const relative = relativeToRepo(file);
			if (isToolTestFile(relative)) continue;
			files++;
			findings.push(...toolForeignTipos(tool, relative, readFileSync(file, 'utf8')));
		}
	}
	return { findings: findings.sort(), tools: tools.length, files };
}

/** A TLD literal the census lists, assembled so this file does not itself name a tipo. */
const FOREIGN_TLD = ['numis', 'data'].join('');

describe('no installation tipo is an engine constant', () => {
	test('LEG 1: NO NEW install-named tipo in the generic engine (shrink-only)', () => {
		const added = engineInstallTipos().filter((key) => !(key in ENGINE_INSTALL_TIPOS));
		expect(
			added,
			"An installation's tipo compiled into the engine is not a portable default — it is behaviour that is correct on exactly one machine and silently resolves nothing everywhere else. Derive it from the ontology, read it from config, make its absence loud — or, when the code really serves ONE install's ontology, move it into that install's package under src/tld/<tld>/ (leg 2).",
		).toEqual([]);
	});

	test('LEG 1: the baseline is LIVE — a stale entry is a finding', () => {
		const present = new Set(engineInstallTipos());
		expect(
			Object.keys(ENGINE_INSTALL_TIPOS).filter((key) => !present.has(key)),
			'fixed — delete these names in the same change that fixed them',
		).toEqual([]);
	});

	test('LEG 2: a TLD package names only its OWN TLD', () => {
		const { findings, files } = packageForeignTipos();
		expect(files, 'src/tld/<tld>/ files scanned').toBeGreaterThan(1);
		expect(
			findings,
			"A package under src/tld/<tld>/ is that install's code: another install's tipo there is the leg-1 accident wearing a package name.",
		).toEqual([]);
		// Positive controls: a foreign literal planted in a package text IS reported, its own is not.
		const planted = `const x = '${FOREIGN_TLD}4';\nconst y = '${mdcat.tld}1';`;
		expect(foreignTiposIn(mdcat.tld, 'src/tld/x/y.ts', planted)).toEqual([
			`src/tld/x/y.ts:1:${FOREIGN_TLD}4`,
		]);
	});

	test('LEG 3: tld → core only; a package is reached through src/tld/registry.ts; one door from outside', () => {
		const { findings, edges } = importDirectionFindings();
		expect(edges, 'repo-internal import edges judged').toBeGreaterThan(1000);
		expect(findings).toEqual([]);
		// The door itself is a real edge (the law has something to protect).
		const doorEdges = importEdgesOf(
			[...REGISTRY_DOORS][0] as string,
			readFileSync(join(REPO_ROOT, [...REGISTRY_DOORS][0] as string), 'utf8'),
		).filter((edge) => edge.target.startsWith('src/tld/'));
		expect(doorEdges.map((edge) => edge.target)).toEqual(['src/tld/registry.ts']);
		// Positive controls, each direction.
		const edge = (file: string, target: string): ImportEdge => ({ file, line: 1, target });
		expect(
			judgeEdge(edge('src/core/section/read.ts', `src/tld/${mdcat.tld}/index.ts`)),
		).toHaveLength(2);
		expect(judgeEdge(edge('src/tld/registry.ts', `src/tld/${mdcat.tld}/index.ts`))).toEqual([]);
		expect(
			judgeEdge(edge(`src/tld/${mdcat.tld}/index.ts`, `src/tld/${mdcat.tld}/calculation.ts`)),
		).toEqual([]);
		expect(
			judgeEdge(edge(`src/tld/${mdcat.tld}/calculation.ts`, 'src/diffusion/api/index.ts')),
		).toHaveLength(1);
		expect(judgeEdge(edge('src/core/section/read.ts', 'src/tld/registry.ts'))).toHaveLength(1);
		expect(judgeEdge(edge([...REGISTRY_DOORS][0] as string, 'src/tld/registry.ts'))).toEqual([]);
		// The specifier scanner reads the three import shapes and ignores bare packages.
		const text = [
			"import { a } from '../tld/registry.ts';",
			"export { b } from './x.ts';",
			"const c = await import('../../src/tld/registry.ts');",
			"import { z } from 'bun:test';",
		].join('\n');
		expect(importEdgesOf('src/core/y.ts', text).map((item) => item.target)).toEqual([
			'src/tld/registry.ts',
			'src/core/x.ts',
			'src/tld/registry.ts',
		]);
	});

	test('LEG 4: no package fn shadows a generic calculation fn name', () => {
		expect(TLD_PACKAGES.size).toBeGreaterThan(0);
		expect(Object.keys(CALCULATION_FUNCTIONS).length).toBeGreaterThan(0);
		expect(shadowedNames(TLD_PACKAGES.values())).toEqual([]);
		// Positive control: a synthetic package re-exporting a generic name IS reported.
		const generic = Object.keys(CALCULATION_FUNCTIONS)[0] as string;
		const synthetic: TldPackage = {
			tld: 'zz',
			calculationModules: { 'calculation/x': { [generic]: () => [] } },
		};
		expect(shadowedNames([synthetic])).toEqual([`zz/calculation/x:${generic}`]);
	});

	test('LEG 5: every package directory is registered, every registered TLD is a census TLD, every module key is its dispatch file', () => {
		const directories = packageDirectories();
		expect(directories.length).toBeGreaterThan(0);
		expect([...TLD_PACKAGES.keys()].sort()).toEqual(directories);
		for (const [key, pkg] of TLD_PACKAGES) {
			expect(pkg.tld, `map key ${key}`).toBe(key);
			expect(INSTALL_TLDS.has(key), `${key} is a census TLD`).toBe(true);
			expect(SEED_SHIPPED.has(key), `${key} is not seed-shipped`).toBe(false);
			const modules = Object.keys(pkg.calculationModules);
			expect(modules.length, `${key} declares a module`).toBeGreaterThan(0);
			for (const module of modules) {
				expect(module).toMatch(/^calculation\/[a-z][a-z0-9_]*$/);
				const fns = pkg.calculationModules[module] as Record<string, unknown>;
				const [firstFn] = Object.keys(fns);
				expect(firstFn, `${key}/${module} holds an fn`).toBeDefined();
				// The dispatch key of a module IS `/<tld>/<module>.ts` — proven by resolving through it.
				const resolved = resolveCalculationFn(
					{ fn: firstFn, file: `/${key}/${module}.ts`, engine: 'ts' },
					{ ipo_key: 0 },
				);
				expect(resolved).toBe(fns[firstFn as string] as CalculationFn);
			}
		}
		// The mdcat package's exported file constant is one of its own dispatch keys.
		expect(
			Object.keys(mdcat.calculationModules).map((module) => `/${mdcat.tld}/${module}.ts`),
		).toContain(MDCAT_CALCULATION_FILE);
	});

	test('LEG 6: tools/tool_<tld>_* name only their own TLD; a generic-named tool names none', () => {
		const { findings, tools, files } = toolsFindings();
		expect(tools, 'tool directories walked').toBeGreaterThan(30);
		expect(files, 'tool source files (.ts + .js) scanned').toBeGreaterThan(150);
		expect(
			findings,
			"A tool's tipo map belongs to the install its name carries; another install's tipo there is a hardcode that silently resolves nothing elsewhere.",
		).toEqual([]);
		// Own-TLD derivation: the longest census TLD the name carries, else none.
		expect(toolOwnTld(`tool_${FOREIGN_TLD}_acquisition`)).toBe(FOREIGN_TLD);
		expect(toolOwnTld('tool_bibliography_acquisition')).toBeNull();
		expect(toolOwnTld('tool_qr')).toBeNull();
		// Positive controls: a foreign tipo in a TLD tool, any install tipo in a generic tool.
		expect(
			toolForeignTipos(
				`tool_${FOREIGN_TLD}_x`,
				'tools/t/server/index.ts',
				`const a = '${mdcat.tld}1';`,
			),
		).toEqual([`tool_${FOREIGN_TLD}_x:tools/t/server/index.ts:1:${mdcat.tld}1`]);
		expect(toolForeignTipos('tool_qr', 'tools/t/js/x.js', `const a = '${FOREIGN_TLD}1';`)).toEqual([
			`tool_qr:tools/t/js/x.js:1:${FOREIGN_TLD}1`,
		]);
		expect(
			toolForeignTipos(`tool_${FOREIGN_TLD}_x`, 'tools/t/js/x.js', `const a = '${FOREIGN_TLD}1';`),
		).toEqual([]);
	});

	test('ANTI-VACUITY: the scan hunts real TLDs, spares the seed, and reads real files', () => {
		// The TLD set must be non-trivial, or every rule above is free.
		expect(HUNTED.length).toBeGreaterThan(30);
		expect(HUNTED).not.toContain('rsc');
		expect(HUNTED).toContain(FOREIGN_TLD);
		// It must actually be scanning the engine.
		expect(sourceFiles(SRC_DIR, ['.ts']).length).toBeGreaterThan(500);
		// And it must match the shape it claims to, and only that shape.
		const probe = (text: string): boolean => new RegExp(TIPO_LITERAL.source).test(text);
		expect(probe(`const x = '${FOREIGN_TLD}722';`)).toBe(true);
		expect(probe("const x = 'rsc170';")).toBe(false); // seed-shipped
		expect(probe('const x = `${tld}1`;')).toBe(false); // derived, not literal — see the header
		expect(probe("const x = 'test480';")).toBe(false); // the generic TLD is the destination
		// A namespace PREFIX paired with its IRI is not a tipo; the same literal alone is.
		const prefix = ['nu', 'misdata7'].join('');
		expect(lineInstallTipos(`\t['${prefix}', 'http://example.org/ns#'],`)).toEqual([]);
		expect(lineInstallTipos(`const x = '${prefix}';`)).toEqual([prefix]);
	});

	test('the file naming these literals is this one, and it is excluded', () => {
		expect(import.meta.file).toBe(SELF);
		expect(engineInstallTipos().every((key) => !key.includes(SELF))).toBe(true);
	});
});
