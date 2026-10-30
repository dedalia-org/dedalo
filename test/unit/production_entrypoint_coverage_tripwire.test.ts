/**
 * PRODUCTION ENTRYPOINT COVERAGE TRIPWIRE (GATE-41).
 *
 * THE DEFECT. `src/diffusion/runner.ts` — the process the scheduler spawns per
 * publication job, the code that unpublishes rows from the public site — was
 * loaded by NO test. Nothing said so: the CRAP ratchet scans src/core only, and
 * there is no coverage gate over the engine. A production entrypoint can sit
 * outside every suite indefinitely and the tree stays green. A second one had:
 * `src/ai/rag/cli/rag_drain.ts` ran an unguarded top-level `main()` +
 * `process.exit`, so it COULD not be imported by a test, and was not.
 *
 * THE LAW. Every production entrypoint is EXECUTED by something in the test
 * tree — reachable from a `test/**\/*.test.ts` file over transitive import
 * edges (static value imports + dynamic `import('…')` literals), or spawned by
 * PATH from a test that calls spawn. A spawn made by PRODUCTION code during a
 * test (the scheduler spawning the runner in stub mode) does NOT count: that is
 * exactly the vacuity GATE-41 found — the process ran, its pipeline did not.
 * And every entrypoint under src/ is IMPORTABLE: its process side effects live
 * under `if (import.meta.main)`, so a gate can drive its exported driver
 * in-process. Anything else is an ENUMERATED exemption with a reason, and the
 * count is shrink-only.
 *
 * THE CENSUS IS DERIVED, NEVER LISTED. An entrypoint is any of:
 *   1. a src/ module carrying `import.meta.main`;
 *   2. a src/ module reading `process.argv` (a CLI shape, guarded or not);
 *   3. a module spawned by src/ code by path (`new URL('…ts', import.meta.url)`
 *      or `join('src', '…ts')` in a file that calls spawn);
 *   4. a `package.json` script target (`bun run <path>.ts`) whose key is a
 *      PRODUCTION key (`start*`, `dedalo:*`) — tooling keys are excluded by a
 *      CLOSED prefix set, and an UNKNOWN prefix is red, so a new script cannot
 *      slip past unclassified;
 *   5. a handler module `src/core/api/dispatch.ts` statically imports (the
 *      request-dispatch registry — each is a wire entrypoint).
 * Each derivation carries a floor, so a scan that finds nothing is red, not
 * green, and a synthetic orphan planted into the census is asserted REPORTED.
 *
 * HONEST LIMIT. "Reachable by import" proves a module is LOADED by a test,
 * not that its driver is exercised: the behavioural half is the entrypoint's
 * own gate (`diffusion_runner_native`, `rag_drain_cli_native`, the server
 * gates). This tripwire is the census that says such a gate must exist.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const rel = (path: string): string => relative(ROOT, path);

// --------------------------------------------------------------- exemptions

/**
 * ENUMERATED, reasoned, shrink-only. An entry here is a production entrypoint
 * no test reaches, with the structural reason. Guarding + a hermetic arg-parse
 * gate (the rag_drain shape) is the durable fix; an entry may not be added
 * without lowering nothing and stating why that fix is not available.
 */
const UNREACHED_EXEMPTIONS: ReadonlyMap<string, string> = new Map([
	[
		'scripts/migrate_v6_config.ts',
		'one-shot v6→v7 migration CLI: its only input is a v6 install tree (config.inc + config_db), which no repo-owned fixture provides; the migration RULES it applies are src/config/migration_map.ts, gated by config_migration.test.ts',
	],
	[
		'scripts/migrate_v6_passwords.ts',
		'one-shot v6→v7 password re-hash CLI: needs legacy v6 password rows in a live users table; the re-hash it performs is src/core/security/legacy_password.ts, gated by legacy_password_migration.test.ts',
	],
]);
/** Shrink-only: two today. */
const UNREACHED_EXEMPTIONS_MAX = 2;

// ---------------------------------------------------------------- the tree

function walk(dir: string, acc: string[] = []): string[] {
	if (!existsSync(dir)) return acc;
	for (const entry of readdirSync(dir)) {
		if (entry === 'node_modules') continue;
		const path = join(dir, entry);
		const st = statSync(path);
		if (st.isDirectory()) walk(path, acc);
		else if (path.endsWith('.ts') && !path.endsWith('.d.ts')) acc.push(path);
	}
	return acc;
}

/** One module of the census (or a planted synthetic one). */
interface ModuleSource {
	path: string;
	source: string;
}

function readTree(): ModuleSource[] {
	const files = [
		...walk(join(ROOT, 'src')),
		...walk(join(ROOT, 'scripts')),
		...walk(join(ROOT, 'deploy')),
		...walk(join(ROOT, 'test')),
		...walk(join(ROOT, 'tools')).filter((f) => f.includes('/server/')),
	];
	return files.map((path) => ({ path, source: readFileSync(path, 'utf8') }));
}

// -------------------------------------------------------- the import graph

const staticImportRe = /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;'"]*?)from\s+['"]([^'"]+)['"]/g;
const bareImportRe = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
const dynamicImportRe = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

function resolveSpecifier(from: string, spec: string, fileSet: Set<string>): string | null {
	if (!spec.startsWith('.')) return null;
	let target = resolve(dirname(from), spec);
	if (fileSet.has(target)) return target;
	if (fileSet.has(`${target}.ts`)) return `${target}.ts`;
	target = join(target, 'index.ts');
	return fileSet.has(target) ? target : null;
}

/** file → the modules it LOADS (static value imports, bare imports, dynamic literals). */
function buildGraph(modules: ModuleSource[]): Map<string, Set<string>> {
	const fileSet = new Set(modules.map((m) => m.path));
	const graph = new Map<string, Set<string>>();
	for (const { path, source } of modules) {
		const edges = new Set<string>();
		for (const match of source.matchAll(staticImportRe)) {
			if (match[2]) continue; // `import type … from`
			const clause = (match[3] ?? '').trim();
			const inner = clause.match(/^\{([\s\S]*)\}$/);
			if (inner?.[1] !== undefined) {
				const specifiers = inner[1]
					.split(',')
					.map((s) => s.trim())
					.filter(Boolean);
				if (specifiers.length > 0 && specifiers.every((s) => s.startsWith('type '))) continue;
			}
			const target = resolveSpecifier(path, match[4] ?? '', fileSet);
			if (target !== null) edges.add(target);
		}
		for (const match of source.matchAll(bareImportRe)) {
			const target = resolveSpecifier(path, match[1] ?? '', fileSet);
			if (target !== null) edges.add(target);
		}
		for (const match of source.matchAll(dynamicImportRe)) {
			const target = resolveSpecifier(path, match[1] ?? '', fileSet);
			if (target !== null) edges.add(target);
		}
		graph.set(path, edges);
	}
	return graph;
}

/** Every module some test file loads, transitively. */
function reachableFromTests(modules: ModuleSource[], graph: Map<string, Set<string>>): Set<string> {
	const seen = new Set<string>();
	const queue = modules.map((m) => m.path).filter((p) => p.endsWith('.test.ts'));
	for (const start of queue) seen.add(start);
	while (queue.length > 0) {
		const current = queue.pop() as string;
		for (const next of graph.get(current) ?? []) {
			if (!seen.has(next)) {
				seen.add(next);
				queue.push(next);
			}
		}
	}
	return seen;
}

/**
 * Modules a TEST spawns by path. The rule is STRICT, because a loose one is
 * the GATE-41 vacuity in a new coat: a `.ts` literal counts ONLY when it is an
 * argument of a spawn CALL in code — written inside the call's argument list,
 * or held by a `const`/`let` whose NAME appears in that argument list (the
 * `const CLI = resolve(import.meta.dir, '…/install.ts'); Bun.spawnSync([…CLI…])`
 * shape). A `.ts` path a test merely READS (`new URL('…/runner.ts',
 * import.meta.url)` next to a string scan) is not a spawn, and the word
 * `spawn(` inside a quoted string (`toContain('Bun.spawn([')`) is not a call:
 * comments and string bodies are MASKED before the call is looked for.
 * Only test files count — a production spawn during a test is the vacuity.
 */
function spawnedByTests(
	modules: ModuleSource[],
	exists: (path: string) => boolean = existsSync,
): Set<string> {
	const targets = new Set<string>();
	for (const { path, source } of modules) {
		if (!path.endsWith('.test.ts')) continue;
		for (const literal of spawnCallPathLiterals(source)) {
			for (const candidate of [resolve(dirname(path), literal), resolve(ROOT, literal)]) {
				if (exists(candidate)) targets.add(candidate);
			}
		}
	}
	return targets;
}

/** Same length as the input, with comment and string BODIES blanked (offsets survive). */
function maskCommentsAndStrings(source: string): string {
	return source.replace(
		/\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g,
		(m) => m.replace(/[^\n]/g, ' '),
	);
}

/** The text between a `(` at `open` and its balanced `)` in the MASKED source, or null. */
function balancedCallSpan(masked: string, open: number): [number, number] | null {
	let depth = 0;
	for (let i = open; i < masked.length; i++) {
		const ch = masked[i];
		if (ch === '(') depth++;
		else if (ch === ')') {
			depth--;
			if (depth === 0) return [open + 1, i];
		}
	}
	return null;
}

const tsLiteralRe = /['"]([^'"\n]+\.ts)['"]/g;

/** `.ts` literals that are arguments of a spawn CALL, directly or via a named const. */
function spawnCallPathLiterals(source: string): string[] {
	const masked = maskCommentsAndStrings(source);
	if (!/\bspawn(?:Sync)?\s*\(/.test(masked)) return [];
	const literals: string[] = [];
	for (const call of masked.matchAll(/\bspawn(?:Sync)?\s*\(/g)) {
		const open = call.index + call[0].length - 1;
		const span = balancedCallSpan(masked, open);
		if (span === null) continue;
		const argumentText = source.slice(span[0], span[1]);
		for (const m of argumentText.matchAll(tsLiteralRe)) literals.push(m[1] as string);
		// a const/let NAMED in the argument list carries its initializer's literals
		const names = new Set(masked.slice(span[0], span[1]).match(/\b[A-Za-z_$][\w$]*\b/g) ?? []);
		for (const name of names) {
			const declaration = source.match(
				new RegExp(`\\b(?:const|let)\\s+${name.replace(/\\$/g, '\\\\$')}\\b[^=;]*=([^;]*);`),
			);
			if (declaration === null) continue;
			for (const m of (declaration[1] as string).matchAll(tsLiteralRe))
				literals.push(m[1] as string);
		}
	}
	return literals;
}

// ------------------------------------------------------------- the census

interface Entrypoint {
	path: string;
	/** Which derivation(s) produced it. */
	because: Set<string>;
}

/** Closed classification of package.json script KEY prefixes. */
const TOOLING_SCRIPT_PREFIXES = new Set([
	// `seed:build` (2026-10-09, installer unification A2) compiles THIS
	// REPOSITORY's vendored install seed from its sources
	// (src/core/install/seed_build.ts) — a build artefact a developer commits,
	// like `changelog`; it touches no installation's data. Its outcome is gated
	// by install_seed_drift_tripwire + install_seed_manifest_tripwire.
	'seed',
	'test',
	'ci',
	'lint',
	'css',
	'config',
	'context',
	'dev',
	// `docs:publish` (2026-09-21) ships THIS REPOSITORY's manual to dedalo.dev.
	// The dichotomy below is developer tooling vs an OPERATOR-run entrypoint, and
	// "operator" here means the person running a Dédalo INSTALLATION — what
	// `start`/`dedalo:*` are. Nothing under `docs:` touches an installation, its
	// database or its media; its three siblings (serve/build/setup) are plainly
	// tooling. Noted honestly: the script does `rsync --delete` against a live
	// site, so if the reading ever changes to PRODUCTION it needs the coverage
	// test that classification demands, not an exemption.
	'docs',
	// `changelog` (2026-09-26) renders docs/change_log.md from changes/ and cuts a
	// release's note snapshot — repository files only, like `docs:*`; it never
	// touches an installation.
	'changelog',
	// `libs:gen` / `libs:check` (2026-10-02) render the client-lib version table of
	// docs/development/vendored_library_versions.md from package.json + the
	// client_libs registry — repository files only, like `changelog`.
	'libs',
	// `registries:gen` / `registries:check` (2026-10-09, installer unification D1) render
	// deploy/image_registries.sh and the docs/install/docker.md table from
	// engineering/image_registries.json — repository files only, like `libs`.
	'registries',
	'probe',
	'publication',
	'sitebuilder',
	// `hostagent:*` (2026-10-04) drives publication/host_agent — an ISOLATED daemon package
	// (own lockfile, own tsc, own coverage-ENFORCING suite in the hermetic daemon_gate), like
	// `sitebuilder`. Its targets live outside the root src/ census, so a PRODUCTION reading
	// would cover nothing here; `hostagent:provision` is operator-run on a PUBLICATION host,
	// not a Dédalo installation, and is gated by the package's own provision_* tests.
	'hostagent',
	'typecheck',
	'format',
	// `baselines:bank` (ratchet banking) and `push` (the gated multi-remote
	// push) are the 2026-09 pre-push gate: they act on THIS repository's
	// baselines and remotes, never on an installation.
	'baselines',
	'push',
	// `drill:install-host` (2026-10-12, terminal installer phase 4) is an OPT-IN
	// developer drill: it runs the installer's host steps inside a DISPOSABLE
	// privileged container it creates and removes (scripts/install_host_drill.ts;
	// no tier runs it, and tier_wiring_tripwire's census walks test:* / ci:* only,
	// so nothing holds its wiring — run by hand). It never touches an
	// installation — the operator's entrypoint is install.sh / the installer, not
	// the drill — so it is tooling, like `test:update`'s drill.
	'drill',
]);
// `media:*` (2026-10-03, `media:publication-host-rules`) is OPERATOR-run: it renders the
// web-server gate of a publication host serving an installation's media. Covered by
// test/unit/media_publication_host_rules_cli.test.ts (imports the CLI's runner).
// `tls:*` (2026-10-17, DEV_ROUTE_SERVE §1.2): renew / untrust the developer
// route's local authority — it acts on an INSTALLATION's certificate and this
// machine's trust stores, so it is operator-run (gate: install_dev_tls_native).
// `update` (2026-10-30, update audit U-33): `bun run update status|check|plan|abort`
// is the update run's OPERATOR command line on an installation (its journals, its
// UPDATE_RUN lock, its master's manifest) — production, covered by
// test/unit/update_cli_native.test.ts.
const PRODUCTION_SCRIPT_PREFIXES = new Set(['start', 'dedalo', 'media', 'tls', 'update']);

function scriptPrefix(key: string): string {
	return key.split(':')[0] as string;
}

/** `bun run [--watch] <path>.ts` targets of one package.json command. */
function bunRunTargets(command: string): string[] {
	return [...command.matchAll(/\bbun\s+run\s+(?:--\S+\s+)*(\S+\.ts)\b/g)].map(
		(m) => m[1] as string,
	);
}

interface Census {
	entrypoints: Map<string, Entrypoint>;
	counts: Record<string, number>;
	unknownScriptKeys: string[];
}

function deriveCensus(modules: ModuleSource[], packageScripts: Record<string, string>): Census {
	const fileSet = new Set(modules.map((m) => m.path));
	const entrypoints = new Map<string, Entrypoint>();
	const counts: Record<string, number> = {
		import_meta_main: 0,
		process_argv: 0,
		spawn_target: 0,
		package_script: 0,
		dispatch_handler: 0,
	};
	const add = (path: string, because: string): void => {
		const entry = entrypoints.get(path) ?? { path, because: new Set<string>() };
		if (!entry.because.has(because)) counts[because] = (counts[because] ?? 0) + 1;
		entry.because.add(because);
		entrypoints.set(path, entry);
	};
	const srcModules = modules.filter(
		(m) => m.path.startsWith(`${ROOT}/src/`) && !m.path.endsWith('.test.ts'),
	);

	// 1 + 2: self-declared process modules under src/
	for (const { path, source } of srcModules) {
		if (/\bimport\.meta\.main\b/.test(source)) add(path, 'import_meta_main');
		if (/\bprocess\.argv\b/.test(source)) add(path, 'process_argv');
	}

	// 3: spawn targets named by src/ code
	for (const { path, source } of srcModules) {
		if (!/\bspawn(?:Sync)?\s*\(/.test(source)) continue;
		for (const match of source.matchAll(
			/new URL\(\s*['"]([^'"]+\.ts)['"]\s*,\s*import\.meta\.url\s*\)/g,
		)) {
			const target = resolve(dirname(path), match[1] as string);
			if (fileSet.has(target)) add(target, 'spawn_target');
		}
		for (const match of source.matchAll(/join\(\s*'src'\s*,\s*'([^']+\.ts)'\s*\)/g)) {
			const target = resolve(ROOT, 'src', match[1] as string);
			if (fileSet.has(target)) add(target, 'spawn_target');
		}
	}

	// 4: package.json production script targets (closed prefix classification)
	const unknownScriptKeys: string[] = [];
	for (const [key, command] of Object.entries(packageScripts)) {
		const targets = bunRunTargets(command);
		if (targets.length === 0) continue; // delegates to a tool or another package
		const prefix = scriptPrefix(key);
		if (TOOLING_SCRIPT_PREFIXES.has(prefix)) continue;
		if (!PRODUCTION_SCRIPT_PREFIXES.has(prefix)) {
			unknownScriptKeys.push(key);
			continue;
		}
		for (const target of targets) {
			const path = resolve(ROOT, target);
			if (fileSet.has(path)) add(path, 'package_script');
		}
	}

	// 5: the request-dispatch registry's handler modules
	const dispatch = modules.find((m) => m.path === join(ROOT, 'src/core/api/dispatch.ts'));
	if (dispatch !== undefined) {
		for (const match of dispatch.source.matchAll(staticImportRe)) {
			if (match[2]) continue;
			const spec = match[4] ?? '';
			if (!spec.includes('/handlers/')) continue;
			const target = resolveSpecifier(dispatch.path, spec, fileSet);
			if (target !== null) add(target, 'dispatch_handler');
		}
	}

	return { entrypoints, counts, unknownScriptKeys };
}

/**
 * IMPORTABLE: the module's process side effects are guarded. A column-0
 * call statement or `process.` statement outside any block is a top-level
 * side effect (the old rag_drain shape: `main()\n\t.then(process.exit)`);
 * a guarded block indents its body. Comments and the `import.meta.main`
 * block's own `if` line are not statements.
 */
function topLevelSideEffects(source: string): string[] {
	const offenders: string[] = [];
	for (const line of source.split('\n')) {
		if (/^(?:void\s+|await\s+)?[A-Za-z_$][\w$.]*\s*\(/.test(line) || /^process\./.test(line)) {
			const keyword = line.match(/^[A-Za-z_$]+/)?.[0] ?? '';
			if (
				[
					'if',
					'for',
					'while',
					'switch',
					'function',
					'async',
					'export',
					'const',
					'let',
					'var',
					'class',
					'import',
					'type',
					'interface',
					'return',
					'declare',
				].includes(keyword)
			) {
				continue;
			}
			offenders.push(line.trim());
		}
	}
	return offenders;
}

// ------------------------------------------------------------------ gates

const MODULES = readTree();
const PACKAGE_SCRIPTS = (
	JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
		scripts: Record<string, string>;
	}
).scripts;
const GRAPH = buildGraph(MODULES);
const REACHABLE = reachableFromTests(MODULES, GRAPH);
const SPAWNED = spawnedByTests(MODULES);
const CENSUS = deriveCensus(MODULES, PACKAGE_SCRIPTS);

/** Anti-vacuity floors per derivation (a scan that finds nothing is red). */
const FLOORS: Record<string, number> = {
	import_meta_main: 3, // server.ts, mcp/server.ts, diffusion/runner.ts
	process_argv: 2, // runner.ts, rag_drain.ts
	spawn_target: 1, // scheduler → runner.ts
	package_script: 2, // start → server.ts, dedalo:install → scripts/install.ts
	dispatch_handler: 10,
};

function isCovered(path: string): boolean {
	return REACHABLE.has(path) || SPAWNED.has(path);
}

describe('production entrypoint coverage tripwire (GATE-41)', () => {
	test('the census is derived from the tree and clears every floor', () => {
		expect(MODULES.filter((m) => m.path.endsWith('.test.ts')).length).toBeGreaterThan(200);
		for (const [derivation, floor] of Object.entries(FLOORS)) {
			expect(
				CENSUS.counts[derivation] ?? 0,
				`derivation '${derivation}' found ${CENSUS.counts[derivation] ?? 0} entrypoint(s), below its floor ${floor} — the scan regressed, the tree did not shrink`,
			).toBeGreaterThanOrEqual(floor);
		}
		expect(REACHABLE.size).toBeGreaterThan(300);
	});

	test('every package.json script that runs a .ts file has a CLASSIFIED key prefix', () => {
		expect(
			CENSUS.unknownScriptKeys,
			`package.json script key(s) with an unclassified prefix — add the prefix to TOOLING_SCRIPT_PREFIXES (developer tooling) or PRODUCTION_SCRIPT_PREFIXES (an operator-run entrypoint, which then needs a test): ${CENSUS.unknownScriptKeys.join(', ')}`,
		).toEqual([]);
	});

	test('every production entrypoint is executed by a test (import-reachable or spawned by path), or exempt with a reason', () => {
		const unreached: string[] = [];
		const staleExemptions: string[] = [];
		for (const entry of CENSUS.entrypoints.values()) {
			const key = rel(entry.path);
			const exempt = UNREACHED_EXEMPTIONS.get(key);
			if (isCovered(entry.path)) {
				if (exempt !== undefined) staleExemptions.push(key);
				continue;
			}
			if (exempt !== undefined) continue;
			unreached.push(`${key}  [${[...entry.because].join(', ')}]`);
		}
		expect(
			unreached,
			`Production entrypoint(s) no test executes. Write the gate that imports and drives it (or spawns it by path); a production spawn during another test does not count.\n  ${unreached.join('\n  ')}`,
		).toEqual([]);
		expect(
			staleExemptions,
			`Exempt entrypoint(s) are now reached by a test — delete the exemption: ${staleExemptions.join(', ')}`,
		).toEqual([]);
		// every exemption names a real entrypoint of the census
		for (const key of UNREACHED_EXEMPTIONS.keys()) {
			expect(
				CENSUS.entrypoints.has(join(ROOT, key)),
				`exemption '${key}' names no entrypoint of the derived census — stale`,
			).toBe(true);
		}
		expect(UNREACHED_EXEMPTIONS.size).toBeLessThanOrEqual(UNREACHED_EXEMPTIONS_MAX);
	});

	test('every src/ entrypoint is IMPORTABLE: process side effects live under `if (import.meta.main)`', () => {
		const offenders: string[] = [];
		let scanned = 0;
		for (const entry of CENSUS.entrypoints.values()) {
			if (!entry.path.startsWith(`${ROOT}/src/`)) continue;
			// dispatch handlers are library modules by construction; the rule is
			// about the PROCESS-shaped ones (a CLI, a server, a spawned runner).
			const processShaped = [...entry.because].some((b) => b !== 'dispatch_handler');
			if (!processShaped) continue;
			scanned++;
			const source = MODULES.find((m) => m.path === entry.path)?.source ?? '';
			if (!/\bif\s*\(\s*import\.meta\.main\s*\)/.test(source)) {
				offenders.push(`${rel(entry.path)}: no \`if (import.meta.main)\` guard`);
			}
			for (const line of topLevelSideEffects(source)) {
				offenders.push(`${rel(entry.path)}: top-level side effect \`${line}\``);
			}
		}
		expect(scanned).toBeGreaterThanOrEqual(4);
		expect(
			offenders,
			`src/ entrypoint(s) that EXECUTE on import — a test cannot load them without running the process. Move the body into an exported driver and call it under \`if (import.meta.main)\` (the rag_drain.ts shape).\n  ${offenders.join('\n  ')}`,
		).toEqual([]);
	});

	test('positive control: a planted src/ orphan with import.meta.main is REPORTED, and the unguarded shape is caught', () => {
		const orphan: ModuleSource = {
			path: join(ROOT, 'src/zz_synthetic/orphan_entry.ts'),
			source: [
				"import { sql } from '../core/db/postgres.ts';",
				'export async function drive(): Promise<void> { await sql`select 1`; }',
				'if (import.meta.main) {',
				'\tawait drive();',
				'}',
			].join('\n'),
		};
		const planted = [...MODULES, orphan];
		const census = deriveCensus(planted, PACKAGE_SCRIPTS);
		expect(census.entrypoints.get(orphan.path)?.because).toEqual(new Set(['import_meta_main']));
		const reachable = reachableFromTests(planted, buildGraph(planted));
		expect(reachable.has(orphan.path)).toBe(false);
		expect(spawnedByTests(planted).has(orphan.path)).toBe(false);
		// …and the moment a test imports it, it is covered.
		const importer: ModuleSource = {
			path: join(ROOT, 'test/unit/zz_synthetic_orphan.test.ts'),
			source: "import { drive } from '../../src/zz_synthetic/orphan_entry.ts';\nvoid drive;",
		};
		const withImporter = [...planted, importer];
		expect(reachableFromTests(withImporter, buildGraph(withImporter)).has(orphan.path)).toBe(true);
		// a test that SPAWNS it by path counts too — the literal held by a const
		// NAMED in the spawn call's argument list (the install_e2e shape)…
		const exists = (candidate: string): boolean =>
			candidate === orphan.path || existsSync(candidate);
		const spawner: ModuleSource = {
			path: join(ROOT, 'test/unit/zz_synthetic_spawn.test.ts'),
			source:
				"const CLI = resolve(import.meta.dir, '../../src/zz_synthetic/orphan_entry.ts');\nBun.spawnSync(['bun', 'run', CLI]);",
		};
		expect(spawnedByTests([spawner], exists).has(orphan.path)).toBe(true);
		// …or written inside the call itself
		const inlineSpawner: ModuleSource = {
			path: spawner.path,
			source:
				"Bun.spawn([process.execPath, resolve(import.meta.dir, '../../src/zz_synthetic/orphan_entry.ts')]);",
		};
		expect(spawnedByTests([inlineSpawner], exists).has(orphan.path)).toBe(true);
		// THE ATTACK SHAPES DO NOT COUNT: a path-shaped const the test only READS
		// (a string scan) next to the word `spawn(` inside a quoted expectation…
		const reader: ModuleSource = {
			path: spawner.path,
			source: [
				"const RUNNER_PATH = new URL('../../src/zz_synthetic/orphan_entry.ts', import.meta.url);",
				'const source = await Bun.file(RUNNER_PATH).text();',
				"expect(source).toContain('Bun.spawn([process.execPath,');",
			].join('\n'),
		};
		expect(spawnedByTests([reader], exists).has(orphan.path)).toBe(false);
		// …and a real spawn of SOMETHING ELSE in the same file does not lend its
		// call to a path const it never names.
		const bystander: ModuleSource = {
			path: spawner.path,
			source: [
				"const RUNNER_PATH = new URL('../../src/zz_synthetic/orphan_entry.ts', import.meta.url);",
				'void RUNNER_PATH;',
				"Bun.spawnSync(['bash', '-n', `${deployDir}${script}`]);",
				'// Bun.spawn([RUNNER_PATH]) — a comment is not a call either',
			].join('\n'),
		};
		expect(spawnedByTests([bystander], exists).has(orphan.path)).toBe(false);
		// and the real tree: install_e2e spawns scripts/install.ts through its CLI const
		expect(SPAWNED.has(join(ROOT, 'scripts/install.ts'))).toBe(true);
		// …and queue_fence_tripwire spawns the diffusion runner itself, to measure
		// that a runner started without a valid --epoch refuses (PUB-13): the
		// collector must SEE that spawn, or the runner would count as unreached.
		expect(SPAWNED.has(join(ROOT, 'src/diffusion/runner.ts'))).toBe(true);
		// The negative half stays: an import.meta.main entrypoint that the suite
		// only IMPORTS (mcp/server.ts — buildMcpServer in mcp_write_tools.test.ts)
		// is not collected, so spawnedByTests does not over-collect from imports.
		expect(SPAWNED.has(join(ROOT, 'src/ai/mcp/server.ts'))).toBe(false);

		// the unguarded CLI shape (rag_drain before GATE-41) is a top-level side effect
		expect(
			topLevelSideEffects(
				'async function main(): Promise<number> { return 0; }\nmain()\n\t.then((code) => process.exit(code));\n',
			),
		).toEqual(['main()']);
		expect(topLevelSideEffects('if (import.meta.main) {\n\tvoid main();\n}\n')).toEqual([]);
		// an unclassified package.json key is reported
		expect(
			deriveCensus(MODULES, { ...PACKAGE_SCRIPTS, 'ops:sweep': 'bun run scripts/dev.ts' })
				.unknownScriptKeys,
		).toEqual(['ops:sweep']);
	});
});
