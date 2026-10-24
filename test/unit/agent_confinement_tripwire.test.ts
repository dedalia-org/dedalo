/**
 * TRIPWIRE — an agent turn is a DIFFERENT PRINCIPAL from the daemon that starts it
 * (PUB-01 / P1-21).
 *
 * The audit's finding was not that a directive was missing. It was that every boundary the
 * site-builder daemon draws around a coding agent — a closed environment key set, a
 * realpath-proved cwd, a HOME outside the workspaces, a pinned git remote, a unit hardened
 * to `ProtectSystem=strict` — described a child that then ran AS THE DAEMON'S OWN UID. No
 * filesystem mode and no `Protect*` directive separates a process from itself, so the
 * shared bearer under `$CREDENTIALS_DIRECTORY`, every provider key and the append handle on
 * the audit trail were readable to text a language model wrote, and stealing the bearer is
 * full daemon control including the irreversible deletion of a museum's published site.
 *
 * WHAT THIS GATE HOLDS, and why it is here rather than in the package's own suite: the
 * package suite runs only when the package's files change (`scripts/verify.ts`), and three
 * of the four properties below live in files a reader would not think of as the site
 * builder's — the ownership matrix, the rendered env, the polkit rule. It is also the
 * CENSUS: every process-creating call site in the daemon's source is enumerated here, so
 * the next one cannot be added without a decision about what it runs as.
 *
 *   §1 THE CENSUS. Every file under `publication/site_builder/src/` that can start a process —
 *      derived from its IMPORTS (`child_process`, `cluster`, `bun`, `bun:ffi`, `module`, and the
 *      evaluators `vm`, `worker_threads`, `inspector`, `repl`) and its scope-resolved references
 *      (aliases, namespaces, the `Bun` global, `Bun.$`), never from a call's spelling — with a
 *      floor; each one an enumerated exemption carrying its reason and its EXACT reference and
 *      import counts. A dynamic import or require of a process module, a re-export of one, and
 *      the escapes no binding names (the loader/evaluator globals incl. `Worker` and `Reflect`,
 *      a non-literal `require`, a non-inert `process` member — the global or `node:process`
 *      imported — `import.meta.require`, a `.constructor` access) are refused everywhere.
 *   §2 THE UNIT. The three directives that are about the agent rather than the daemon
 *      (`ProtectProc=invisible`, `RestrictSUIDSGID`, `LockPersonality`), beside the
 *      hardening set that was already there — asserted on a real render.
 *   §3 THE AUTHORIZATION. The rendered polkit rule: this museum's service user, `manage-units`,
 *      STOP and KILL — never START (F2: polkit sees no run-as uid) — on the socket-activated
 *      instances of this museum's DECLARED sites' root-rendered units, enumerated (LEAD-1b).
 *      The daemon starts nothing: PID 1 starts a run when the daemon connects to a socket.
 *   §4 THE RECORDED DECISION. One agent identity per DECLARED SITE (LEAD-1b) — the choice,
 *      what it does not draw, and what would change it, written beside the derivation.
 *   §5 THE PROVISIONED HOST IS CONFINED BY CONSTRUCTION. The rendered env states the mode,
 *      the site identities and the socket directory, so the daemon's production refusal
 *      never has to fire; each site's units are rendered by root with `User=` its identity.
 *   §6 THE OTHER DOOR. A build step, an install script and a `git add` are agent-authored
 *      text too, executed on a routine publisher-triggered path. No module that runs a
 *      command inside a site workspace may reach the UNCONFINED runner: `util/spawn.ts` is
 *      imported by the confinement and the version probes, and by nothing else — read off the
 *      MODULE GRAPH (resolved specifiers), with any dynamic reach or re-export of it refused.
 *   §7 THE TREE THE TWO UIDS SHARE. The modes that make a confined turn able to write at
 *      all — one constant for the provisioned roots and the runtime workspaces — and the
 *      audit trail closed to the group the agent is in. Plus the two censuses that keep the
 *      tree's DOORS in one module: every path-based MUTATION and every path-based CONTENT
 *      READ under `src/` — read off the fs IMPORTS and their scope-resolved bindings, never a
 *      call's spelling — each enumerated with a destination, because a lexical
 *      `confinedPath` follows a planted link in both directions — the write plant truncates
 *      the daemon's own audit trail, and the read plant serves the daemon's own
 *      `SERVICE_TOKEN` back through `GET /sites/<slug>/builds/<id>`.
 *   §8 THE EGRESS. Every door (turn / build / git) renders a PRIVATE network namespace, a
 *      masked `/run` and `IPAddressDeny=any`; the only reachable path is the door's own
 *      site's `/run/dedalo-egress` sockets (none on git) — asked at 255 (no PID namespace:
 *      nothing of the same uid runs beside a site's run, the per-site identity and its
 *      Conflicts= doors, G6) and at 257 beside a CONCURRENT same-uid run (the extra layer),
 *      and of the host's IPC namespace. Evaluated with a model of systemd
 *      whose filter is ALLOW-WINS — and whose control row, the pre-fix shape
 *      (`IPAddressAllow=any localhost` + a deny list), must come out UNSAFE, or the model is
 *      the longest-prefix misreading that made LEAD-1 look closed. Egress plans are
 *      hostname-only. HONEST LIMIT: the kernel's behaviour is proved by the VM probe, not here.
 *
 * The BEHAVIOUR of a confined run — the socket, the spec, the gate, the refusals, the
 * per-turn credential — is the package's own gate,
 * `publication/site_builder/tests/agent_confinement.test.ts` (and LEAD-1b's lease,
 * conformance and per-site reach, `publication/site_builder/tests/lead1b_*.test.ts`). This
 * one is the invariant scan around it.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
	agentIdentityName,
	agentSocketPath,
} from '../../publication/site_builder/src/drivers/agent_identity.ts';
import {
	derive,
	type InstanceManifest,
	MAX_INSTANCE_LENGTH,
	MODES,
	USER_PREFIX,
} from '../../publication/site_builder/src/provision/layout.ts';
import { AGENT_UNIT_VERBS } from '../../publication/site_builder/src/provision/render/agent_authorization.ts';
import { renderAll } from '../../publication/site_builder/src/provision/render/index.ts';
import { parseManifest } from '../../publication/site_builder/src/provision/schema.ts';
import {
	DAEMON_STATE_DIR_MODE,
	PRIVATE_DIR_MODE,
	SHARED_DIR_MODE,
	SHARED_FILE_MODE,
} from '../../publication/site_builder/src/util/shared_tree.ts';
import {
	allowsFamily,
	canEnumerateInterfaces,
	type Destination,
	describeDestination,
	parseProperties,
	reach,
} from '../../publication/site_builder/tests/support/systemd_reach.ts';
import { SITE_BUILDER_SRC, siteBuilderDaemonFiles } from '../helpers/publication_corpus.ts';
import { escapeRegExp } from '../helpers/regex_escape.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const PACKAGE = join(REPO_ROOT, 'publication/site_builder');
const SOURCE_ROOT = SITE_BUILDER_SRC;
const DECLARATION = join(PACKAGE, 'deploy/examples/instance.example.json');

/* ────────────────────────────────────────────────────────────────────────────────────
 * The corpus
 * ──────────────────────────────────────────────────────────────────────────────────── */

/**
 * WHAT COUNTS AS STARTING A PROCESS — read off what a file can REACH, never off how a call is
 * spelled.
 *
 * The first census matched call SPELLINGS (`Bun.spawn(`, a bare `spawn(`/`execFile(`/…) and
 * was answered, measured, by every respelling of the same decision: `import { spawn as run }`
 * + `run(…)`, `import * as cp` + `cp.spawn(…)`, ``Bun.$`…` ``, and
 * `const { spawn: s } = await import('node:child_process')`. Its exemptions were keyed per FILE
 * with a liveness floor of ONE call, so a fifth spawn added to a file that already had four was
 * invisible. A regression that ran `git`/`bun install` in a workspace through such a spelling
 * would execute agent-authored hooks as the daemon uid, around `util/spawn`'s `CONFINED_ARGV`
 * door, with this census green. So the census is now built from the module graph:
 *
 *   1. THE IMPORT SIDE (`Bun.Transpiler.scanImports`: static, dynamic and `require`). A
 *      process-capable module (`PROCESS_MODULES`) may be imported only STATICALLY and only by
 *      an exempt file. A dynamic import or a `require` of one yields bindings no scan resolves,
 *      so it is refused everywhere, exempt files included.
 *   2. THE REFERENCE SIDE, scope-aware. The file is transpiled (types and comments gone), its
 *      process imports are removed, and each binding they made — default, named, aliased,
 *      namespace — and the `Bun` global are DEFINED to a sentinel. `define` replaces only
 *      UNBOUND identifier references: never a string, a comment, a property name or a local
 *      that shadows the binding. Every sentinel left is one process-capable reference.
 *      `Bun.<member>` counts unless the member is in the closed inert list (`BUN_INERT`); a
 *      bare `Bun` (an alias, a destructure) always counts.
 *   3. THE ESCAPES no binding names are refused EVERYWHERE, exempt files included — and they are
 *      found the same scope-aware way, not by spelling: every GLOBAL that reaches a loader or an
 *      evaluator (`globalThis`, `global`, `self`, `window`, `eval`, `Function`, `module`) is
 *      `define`d to a sentinel, so `global.Bun.spawn` / `self.Bun` / `Function('return Bun')()`
 *      are references however spelled while a local of that name or a string ('self' in a CSP)
 *      is not; `require` is allowed only as a direct call with a literal of a NON-process module;
 *      `process` only through a CLOSED list of inert members (`PROCESS_INERT` — so
 *      `process.getBuiltinModule`, `process.mainModule.require`, `process.binding`, a computed
 *      `process[…]` are escapes); `import.meta` only as `dir`/`url`/`main`/… (so
 *      `import.meta.require` is one); a `.constructor` access (`(() => {}).constructor` IS
 *      `Function`); and a computed `import(…)` / `require(…)`. `node:module` (`createRequire`)
 *      is a process module.
 *   4. RE-EXPORTS. `export { spawnSync as x } from 'node:child_process'` (or `export *`) makes
 *      no local binding — the reference count does not move while every importer of the file
 *      holds a spawn — so a re-export of a process module is refused everywhere.
 *   5. EXACT COUNTS. Each exemption pins its reference count AND its static import count, as
 *      `sql_confinement` pins its sites: one more (or one fewer) is red, and a new one is a
 *      decision in review.
 */
const PROCESS_MODULES: ReadonlySet<string> = new Set([
	'node:child_process',
	'child_process',
	'node:cluster',
	'cluster',
	// `$` (Bun Shell) and `spawn`/`spawnSync` are exports of the 'bun' module too.
	'bun',
	// A foreign call can posix_spawn.
	'bun:ffi',
	// `createRequire(import.meta.url)('child_process')`: a loader, so a process module.
	'node:module',
	'module',
	// THE EVALUATORS (round 5, each measured spawning `id -u` with the census green): source
	// text run in this realm (`vm.runInThisContext('Bun.spawn(…)')`), in a thread
	// (`new Worker(code, {eval: true})`), or through the debugger protocol (`Runtime.evaluate`).
	'node:vm',
	'vm',
	'node:worker_threads',
	'worker_threads',
	'node:inspector',
	'inspector',
	'node:inspector/promises',
	'inspector/promises',
	'node:repl',
	'repl',
]);

/**
 * `node:process` IMPORTED — the `process` global under another name. Not a process module (its
 * inert members are everyday reads), but held to the SAME closed member rule: a default or
 * namespace binding is the global (`proc.getBuiltinModule` is an escape), a named binding is
 * allowed only for an inert member (`{ getBuiltinModule }` is one), and a dynamic import,
 * a `require` or a re-export of it is refused everywhere.
 */
const PROCESS_ALIAS_MODULES: ReadonlySet<string> = new Set(['node:process', 'process']);

/** `process.<member>` reads that cannot start a process or load a module. Closed. */
const PROCESS_INERT: ReadonlySet<string> = new Set([
	'arch',
	'argv',
	'cwd',
	'emitWarning',
	'env',
	'execPath',
	'exit',
	'exitCode',
	'getegid',
	'geteuid',
	'getgid',
	'getgroups',
	'getuid',
	'hrtime',
	'kill',
	'memoryUsage',
	'nextTick',
	'off',
	'on',
	'once',
	'pid',
	'platform',
	'stderr',
	'stdin',
	'stdout',
	'umask',
	'uptime',
	'version',
	'versions',
]);

/** `import.meta.<member>` reads that load nothing. Closed (`require`, `resolve` are not on it). */
const IMPORT_META_INERT: ReadonlySet<string> = new Set([
	'dir',
	'dirname',
	'env',
	'file',
	'filename',
	'main',
	'path',
	'url',
]);

/** Globals that reach a loader or an evaluator: ANY reference is an escape. */
const ESCAPE_GLOBALS: readonly string[] = [
	'globalThis',
	'global',
	'self',
	'window',
	'eval',
	'Function',
	'module',
	// The web `Worker` (a module URL, a blob, a data: URL is code), and `Reflect`, which reaches
	// `.constructor` — i.e. `Function` — without spelling a member access (`Reflect.get(fn,
	// 'constructor')`). HONEST LIMIT: a computed member with a non-literal key on any function
	// value (`fn[k]`, k = 'constructor') is the same reach and is not statically decidable; that
	// is a respelling a REVIEW catches, and the runtime boundary (the run's own uid, units) is
	// what holds regardless.
	'Worker',
	'Reflect',
];

/** `Bun.<member>` reads that cannot start a process. Closed: any other member is a reference. */
const BUN_INERT: ReadonlySet<string> = new Set([
	'argv',
	'connect',
	'CryptoHasher',
	'file',
	'nanoseconds',
	'password',
	'serve',
	'sleep',
	'Transpiler',
	'version',
]);

const PROCESS_REF = '__DEDALO_PROCESS_REF__';
const BUN_GLOBAL = '__DEDALO_BUN_GLOBAL__';
const ESCAPE_GLOBAL = '__DEDALO_ESCAPE_GLOBAL_';
const REQUIRE_REF = '__DEDALO_REQUIRE__';
const PROCESS_GLOBAL = '__DEDALO_PROCESS_GLOBAL__';
/**
 * A static import as the transpiler prints it: `import <clause> from "<module>";` — on ONE line
 * or on SEVERAL (a clause written over several lines is printed over several lines, measured;
 * the one-line version of this pattern missed every one of them). The clause holds no quote
 * and no `;`, so it cannot run from one statement into the next.
 */
const IMPORT_LINE = /^import\s+([^;"'`]+?)\s+from\s*["']([^"']+)["'];?[ \t]*$/gm;
/** A re-export as the transpiler prints it: `export <clause> from "<module>";`, likewise. */
const EXPORT_FROM_LINE = /^export\s+([^;"'`]+?)\s+from\s*["']([^"']+)["'];?[ \t]*$/gm;
/** The lexical escapes left once the globals are sentinels (run on the transpiled code). */
const ESCAPES: readonly RegExp[] = [
	new RegExp(`${ESCAPE_GLOBAL}[A-Za-z]+__`, 'g'),
	/\bimport\s*\(\s*(?!["'])/g,
	/\bimport\s*\.\s*meta\b(?!\s*\.\s*[A-Za-z_$])/g,
	/\.\s*constructor\b|\[\s*["'`]constructor["'`]\s*\]/g,
];

/** One binding an import clause makes: what it imports (`*`, `default` or a name) and its local. */
interface ImportBinding {
	readonly imported: string;
	readonly local: string;
}

/** The bindings an import clause makes: `a`, `* as ns`, `{ x, y as z }`, or a mix. */
function importBindings(clause: string): ImportBinding[] {
	const out: ImportBinding[] = [];
	const namespace = clause.match(/\*\s*as\s+([\w$]+)/);
	if (namespace?.[1]) out.push({ imported: '*', local: namespace[1] });
	const braces = clause.match(/\{([^}]*)\}/);
	for (const part of (braces?.[1] ?? '')
		.split(',')
		.map((p) => p.trim())
		.filter(Boolean)) {
		const [imported, local] = part.split(/\s+as\s+/).map((name) => name.trim());
		out.push({ imported: imported as string, local: local ?? (imported as string) });
	}
	const fallback = clause
		.replace(/\{[^}]*\}/, '')
		.replace(/\*\s*as\s+[\w$]+/, '')
		.replace(/,/g, ' ')
		.trim();
	if (fallback) out.push({ imported: 'default', local: fallback });
	return out;
}

/** The local names an import clause binds. */
function bindingsOf(clause: string): string[] {
	return importBindings(clause).map((binding) => binding.local);
}

interface ProcessReach {
	readonly file: string;
	/** Static imports of a process-capable module. */
	readonly staticImports: number;
	/** Dynamic imports / requires of one — refused everywhere. */
	readonly unresolvable: readonly string[];
	/** Process-capable identifier references (bindings + non-inert `Bun`). */
	readonly refs: number;
	readonly escapes: readonly string[];
}

const TS = new Bun.Transpiler({ loader: 'ts' });

/**
 * EVERY IMPORT A FILE MAKES, as the module graph sees it — the STATIC ones from the source (the
 * transpiler elides an import used only as a type, which is no edge), and every DYNAMIC import
 * and `require` from the CONSTANT-FOLDED output. Round 6, measured: `import('node:' +
 * 'child_process')`, ``import(`node:${'child_process'}`)`` and `import('../util/' + 'spawn')` are
 * literals only after the transpiler folds them, so a source-level scan reported NOTHING (no
 * reacher, no refusal) while the computed-import escape — which runs on the folded output — saw
 * a literal and passed it too. One scan, folded, for all three censuses and the leaf rule; an
 * argument that does not fold stays computed and is the `import(` escape.
 */
function scanAll(code: string): ReturnType<typeof TS.scanImports> {
	return [
		...TS.scanImports(code).filter((entry) => entry.kind === 'import-statement'),
		...TS.scanImports(TS.transformSync(code)).filter((entry) => entry.kind !== 'import-statement'),
	];
}

/** What one source file can reach that starts a process. */
function processReach(code: string, file: string): ProcessReach {
	const scanned = scanAll(code);
	const imports = scanned.filter((entry) => PROCESS_MODULES.has(entry.path));
	const bindings: string[] = [];
	const processAliases: string[] = [];
	const reexports: string[] = [];
	const aliasEscapes: string[] = [];
	const js = TS.transformSync(code)
		.replace(IMPORT_LINE, (line, clause: string, from: string) => {
			if (PROCESS_ALIAS_MODULES.has(from)) {
				for (const { imported, local } of importBindings(clause)) {
					if (imported === '*' || imported === 'default') processAliases.push(local);
					else if (!PROCESS_INERT.has(imported))
						aliasEscapes.push(`process.${imported} (imported from ${from})`);
				}
				return '';
			}
			if (!PROCESS_MODULES.has(from)) return line;
			bindings.push(...bindingsOf(clause));
			return '';
		})
		.replace(EXPORT_FROM_LINE, (line, _clause: string, from: string) => {
			if (!PROCESS_MODULES.has(from) && !PROCESS_ALIAS_MODULES.has(from)) return line;
			reexports.push(`re-export ${from}`);
			return '';
		});
	const define: Record<string, string> = {
		Bun: BUN_GLOBAL,
		require: REQUIRE_REF,
		process: PROCESS_GLOBAL,
	};
	for (const name of ESCAPE_GLOBALS) define[name] = `${ESCAPE_GLOBAL}${name}__`;
	for (const name of bindings) define[name] = PROCESS_REF;
	for (const name of processAliases) define[name] = PROCESS_GLOBAL;
	const out = new Bun.Transpiler({ loader: 'js', define }).transformSync(js);
	let refs = out.split(PROCESS_REF).length - 1;
	for (const match of out.matchAll(
		new RegExp(`${BUN_GLOBAL}(\\s*\\.\\s*([A-Za-z_$][\\w$]*))?`, 'g'),
	)) {
		if (!(match[2] && BUN_INERT.has(match[2]))) refs++;
	}
	const escapes = [
		...aliasEscapes,
		...ESCAPES.flatMap((pattern) => [...out.matchAll(pattern)].map((match) => match[0])),
	];
	// `require` only as `require("<literal>")` of a module that is not a process module (a
	// process one is already `unresolvable`); an alias, a member (`require.call`) or a computed
	// argument is an escape.
	const requires: string[] = [];
	for (const match of out.matchAll(
		new RegExp(`${REQUIRE_REF}(\\s*\\(\\s*"([^"]*)"\\s*\\))?`, 'g'),
	)) {
		if (match[2] === undefined) escapes.push('require (not a literal call)');
		else if (PROCESS_MODULES.has(match[2]) || PROCESS_ALIAS_MODULES.has(match[2]))
			requires.push(`require-call ${match[2]}`);
	}
	for (const match of out.matchAll(
		new RegExp(`${PROCESS_GLOBAL}(\\s*\\.\\s*([A-Za-z_$][\\w$]*))?`, 'g'),
	)) {
		if (!(match[2] && PROCESS_INERT.has(match[2])))
			escapes.push(`process${match[2] ? `.${match[2]}` : ' (bare or computed)'}`);
	}
	for (const match of out.matchAll(/\bimport\s*\.\s*meta\s*\.\s*([A-Za-z_$][\w$]*)/g)) {
		if (!IMPORT_META_INERT.has(match[1] as string)) escapes.push(`import.meta.${match[1]}`);
	}
	const unresolvable = [
		...scanned
			.filter((entry) => PROCESS_MODULES.has(entry.path) || PROCESS_ALIAS_MODULES.has(entry.path))
			.filter((entry) => entry.kind !== 'import-statement')
			.map((entry) => `${entry.kind} ${entry.path}`),
		...reexports,
	];
	for (const entry of requires) if (!unresolvable.includes(entry)) unresolvable.push(entry);
	return {
		file,
		staticImports:
			imports.filter((entry) => entry.kind === 'import-statement').length -
			reexports.filter((entry) => !PROCESS_ALIAS_MODULES.has(entry.slice('re-export '.length)))
				.length,
		unresolvable,
		refs,
		escapes,
	};
}

/** Every file of a tree that can reach a process, with its file relative to that tree. */
function processReachers(files: readonly string[], root: string): ProcessReach[] {
	return files
		.map((path) => processReach(readFileSync(path, 'utf8'), relative(root, path)))
		.filter(
			(reach) =>
				reach.staticImports > 0 ||
				reach.unresolvable.length > 0 ||
				reach.refs > 0 ||
				reach.escapes.length > 0,
		);
}

/**
 * Plant a scratch file and REMEMBER its path. The positive controls feed the
 * scanners a LIST of files, never a directory: the corpus roots belong to the
 * shared lister (`test/helpers/publication_corpus.ts`), and a control that
 * walked a tree of its own would be a second, drifting answer to "what is the
 * corpus".
 */
function plant(planted: string[], path: string, body: string): string {
	writeFileSync(path, body);
	planted.push(path);
	return path;
}

/**
 * THE ENUMERATED EXEMPTIONS — every file that can start a process and is NOT the agent turn,
 * each with the reason and its EXACT reference count. Shrink-only: a new entry, or a count
 * that grew, is a new decision about what runs as whom, and it belongs in a review rather than
 * in a diff nobody reads.
 */
const EXEMPT: Readonly<
	Record<string, { readonly refs: number; readonly imports: number; readonly reason: string }>
> = Object.freeze({
	'provision/apply.ts': {
		refs: 11,
		imports: 1,
		reason:
			'the PROVISIONER, not the daemon: an operator-run root process reading the host (id, ' +
			'getent, systemctl) and setting ownership (chown). It never executes agent-authored ' +
			'text, and confining it under the agent uid would be a root tool asking permission to ' +
			'do the thing it exists to do.',
	},
	'drivers/confinement.ts': {
		refs: 4,
		imports: 1,
		reason:
			"the confinement's OWN control plane, which starts nothing: `systemctl show/list-units` " +
			"(is a site's run alive? what did PID 1 load? which release is it?) and `systemctl stop " +
			"<a live instance>` through the polkit rule's stop grant (the rule grants no start — F2), " +
			'plus `id` / `getent group`, pinned root-owned binaries asked which uid and groups each ' +
			'site identity has, so the trust check can ask whether ANY identity can change what the ' +
			'units execute first. None of them runs anything agent-authored.',
	},
	'util/spawn.ts': {
		refs: 2,
		imports: 0,
		reason:
			'runBinary / spawnChild — the ONE place a process is created, and the door itself. It ' +
			'REFUSES a cwd inside SITES_ROOT without the confinement token (`CONFINED_ARGV`), which ' +
			'only the confinement holds: under systemd_scope nothing is spawned for a run at all (the ' +
			"daemon connects to the site's socket and PID 1 starts the unit), and spawnChild is the " +
			'DECLARED-unconfined run of AGENT_CONFINEMENT=none, announced in its own log. What is ' +
			'left is the driver VERSION PROBE, a pinned binary run with --version outside every ' +
			'workspace. §6 holds the import side of that rule.',
	},
	'drivers/egress_shim.ts': {
		refs: 1,
		imports: 1,
		reason:
			"in-unit exec of the spec's argv: the shim IS the ExecStart of the unit root rendered for " +
			'the site (User= its identity), so its one child_process spawn runs inside the unit PID 1 ' +
			'already started, in its private network namespace — after it has refused a namespace ' +
			'that is not in effect (§8) and a spec that sets a key the unit fixes. It widens nothing ' +
			'the unit did not already grant.',
	},
});

/* ────────────────────────────────────────────────────────────────────────────────────
 * §1 The census
 * ──────────────────────────────────────────────────────────────────────────────────── */

describe('every process the site-builder daemon starts is accounted for', () => {
	const files = siteBuilderDaemonFiles();
	const reachers = processReachers(files, SOURCE_ROOT);
	const describeReach = (reach: ProcessReach) =>
		`${reach.file}: ${reach.staticImports} import(s), ${reach.refs} ref(s)` +
		`${reach.unresolvable.length ? `, ${reach.unresolvable.join(', ')}` : ''}` +
		`${reach.escapes.length ? `, escapes ${reach.escapes.join(', ')}` : ''}`;

	test('the corpus is the tree, and it is not empty', () => {
		// The floor is what makes the emptiness assertions below mean anything: a scanner
		// pointed at a moved directory would otherwise report a clean census of nothing.
		expect(files.length).toBeGreaterThan(40);
		expect(reachers.reduce((sum, reach) => sum + reach.refs, 0)).toBeGreaterThan(8);
	});

	test('no driver spawns an agent turn: the supervisor consumes what confineTurn() opened', () => {
		// The whole point of the row, read off the tree: the supervisor spawns NOTHING — it
		// reads the ConfinedChild `confineTurn()` returned (a unit instance relayed over the
		// site's socket, or the declared-unconfined child). A `Bun.spawn(plan.argv, …)` in
		// process.ts is the defect restored, and it is the exact line the audit found.
		const inDrivers = reachers.filter(
			(reach) => reach.file.startsWith('drivers/') && !(reach.file in EXEMPT),
		);
		expect(inDrivers.map(describeReach)).toEqual([]);
		const supervisor = readFileSync(join(SOURCE_ROOT, 'drivers/process.ts'), 'utf8')
			.split('\n')
			.map((line) => line.replace(/^\s*(\/\/|\*|\/\*).*$/, ''))
			.join('\n');
		expect(supervisor).toContain('confined = await confineTurn(');
		expect(supervisor).not.toContain('plan.argv, {');
	});

	test('every file that can start a process is an enumerated exemption, at its EXACT count, with a reason', () => {
		const unexplained = reachers.filter((reach) => !(reach.file in EXEMPT)).map(describeReach);
		expect(unexplained).toEqual([]);
		// No exemption covers what no scan can count: a dynamic import / require of a process
		// module, or an escape, is refused in an exempt file too.
		expect(
			reachers
				.filter((reach) => reach.unresolvable.length > 0 || reach.escapes.length > 0)
				.map(describeReach),
		).toEqual([]);
		// EXACT, both directions: one more reference in an exempt file is a new spawn nobody
		// decided on; one fewer is an exemption that would silently cover the next one.
		// The IMPORT count too: a second process import in an exempt file is a new door even
		// before anything references it (a re-export is refused outright, above).
		const counted = Object.fromEntries(reachers.map((reach) => [reach.file, reach]));
		for (const [file, { refs, imports, reason }] of Object.entries(EXEMPT)) {
			expect({
				file,
				refs: counted[file]?.refs ?? 0,
				imports: counted[file]?.staticImports ?? 0,
				stated: reason.length > 60,
			}).toEqual({ file, refs, imports, stated: true });
		}
	});

	test('the scanner really finds an offender — every respelling of a spawn is reported', () => {
		// The positive control. Without it every assertion above is satisfied by a scanner that
		// found nothing, in a directory that moved, with a pattern that matches no code. Each
		// row is a shape the spelling census passed GREEN (measured).
		const dir = mkdtempSync(join(tmpdir(), 'agent-confinement-control-'));
		const planted: string[] = [];
		const shapes: Record<string, string> = {
			'rogue.ts': 'export function go() {\n  Bun.spawn(["/bin/sh"]);\n}\n',
			'nested.ts': "import { execFile } from 'node:child_process';\nexecFile('/bin/sh');\n",
			'alias.ts':
				"import { spawn as run } from 'node:child_process';\nexport const go = () => run('/bin/sh');\n",
			'namespace.ts':
				"import * as cp from 'node:child_process';\nexport const go = () => cp.spawn('/bin/sh');\n",
			'default.ts': "import cp from 'child_process';\nexport const go = () => cp.fork('x');\n",
			'shell.ts': 'export async function go() {\n  await Bun.$`sh -c id`;\n}\n',
			'bunshell.ts': "import { $ } from 'bun';\nexport const go = () => $`sh -c id`;\n",
			'dynamic.ts':
				"export async function go() {\n  const { spawn: s } = await import('node:child_process');\n  s('/bin/sh');\n}\n",
			'required.ts': "export const go = () => require('child_process').spawnSync('/bin/sh');\n",
			'bunalias.ts': 'const B = Bun;\nexport const go = () => B.spawn(["/bin/sh"]);\n',
			'global.ts': 'export const go = () => globalThis.Bun.spawn(["/bin/sh"]);\n',
			// The shapes the scope-resolved census of round 4 still passed (measured: a probe file
			// with the first four spawned `git add -A` in a workspace, census green at 49/0).
			'nodeglobal.ts': 'export const go = () => global.Bun.spawn(["/bin/sh"]);\n',
			'selfglobal.ts': 'export const go = () => self.Bun.spawn(["/bin/sh"]);\n',
			'metarequire.ts':
				"export const go = () => import.meta.require('node:child_process').spawnSync('/bin/sh');\n",
			'builtin.ts':
				"export const go = () => process.getBuiltinModule('node:child_process').spawnSync('/bin/sh');\n",
			'mainmodule.ts':
				"export const go = () => process.mainModule.require('child_process').spawnSync('/bin/sh');\n",
			'processcomputed.ts':
				"const k = 'getBuilt' + 'inModule';\nexport const go = () => process[k]('child_process');\n",
			'createrequire.ts':
				"import { createRequire } from 'node:module';\nexport const go = () => createRequire(import.meta.url)('child_process').spawnSync('/bin/sh');\n",
			'functionctor.ts': "export const go = () => Function('return Bun')().spawn(['/bin/sh']);\n",
			'evaluated.ts': "export const go = () => eval('Bun').spawn(['/bin/sh']);\n",
			'constructor.ts':
				"export const go = () => (() => 0).constructor('return Bun')().spawn(['/bin/sh']);\n",
			'requirealias.ts':
				"const r = require;\nexport const go = () => r('child_process').spawnSync('/bin/sh');\n",
			'modulerequire.ts':
				"export const go = () => module.require('child_process').spawnSync('/bin/sh');\n",
			'reexport.ts': "export { spawnSync as hostRun } from 'node:child_process';\n",
			'reexportstar.ts': "export * from 'child_process';\n",
			// The shapes round 5 measured passing GREEN (each one really spawned `id -u` under Bun
			// 1.4.2): the EVALUATOR and LOADER modules, `node:process` as an imported binding, the
			// web `Worker` global, and `Reflect` reaching `.constructor` without spelling it.
			'vm.ts':
				"import { runInThisContext } from 'node:vm';\nexport const go = () => runInThisContext('Bun.spawn([\"id\"])');\n",
			'vmns.ts':
				"import * as vm from 'vm';\nexport const go = () => vm.runInNewContext('1', {});\n",
			'workereval.ts':
				"import { Worker as W } from 'node:worker_threads';\nexport const go = () => new W('Bun.spawn([\"id\"])', { eval: true });\n",
			'webworker.ts': "export const go = () => new Worker('data:text/javascript,0');\n",
			'processdefault.ts':
				"import proc from 'node:process';\nexport const go = () => proc.getBuiltinModule('child_process').spawnSync('id');\n",
			'processnamed.ts':
				"import { getBuiltinModule as gbm } from 'process';\nexport const go = () => gbm('child_process').spawnSync('id');\n",
			'processdynamic.ts':
				"export const go = async () => (await import('node:process')).getBuiltinModule('child_process');\n",
			'reflectctor.ts':
				"export const go = () => Reflect.get(() => 0, 'constructor')('return Bun')().spawn(['id']);\n",
			'inspector.ts':
				"import { Session } from 'node:inspector';\nexport const go = () => new Session();\n",
			// A CONSTANT-FOLDED specifier is a literal only after the transpiler folds it (round 6,
			// measured: `import('node:' + 'child_process')` spawned `id -u` with the census green —
			// the source-level scan reported nothing, and the escape pattern ran on the folded code).
			'folded.ts':
				"export const go = async () => (await import('node:' + 'child_process')).spawnSync('id', ['-u']);\n",
			'foldedtemplate.ts':
				"export const go = async () => (await import(`node:${'child_process'}`)).spawnSync('id');\n",
			'foldedvm.ts':
				"export const go = async () => (await import('node:' + 'vm')).runInThisContext('1');\n",
			'foldedrequire.ts':
				"export const go = () => require('node:' + 'child_process').spawnSync('id');\n",
			// A clause the transpiler prints over SEVERAL lines (as written) is an import too.
			'multiline.ts':
				"import {\n  spawn as run,\n  type ChildProcess,\n} from 'node:child_process';\nexport const go = (): ChildProcess => run('/bin/sh');\n",
		};
		for (const [name, body] of Object.entries(shapes)) plant(planted, join(dir, name), body);
		// …and prose, a string, an inert Bun member and a shadowing local are NOT reports.
		plant(
			planted,
			join(dir, 'prose.ts'),
			"// Bun.spawn(argv) is what this module replaces.\nexport const msg = 'spawn( Bun.spawn(';\n" +
				'export const nap = () => Bun.sleep(1);\nexport const local = (spawn: (x: string) => void) => spawn("x");\n' +
				// …nor a CSP's 'self', a local named like an escape global, an inert process or
				// import.meta member, or a literal require of a non-process module.
				'export const csp = "script-src \'self\'; no eval, no global, no Function";\n' +
				'export const shadow = (self: { a: number }, global: number) => self.a + global;\n' +
				"export const facts = () => [process.env.X, process.getuid?.(), import.meta.dir, require('node:path')];\n",
		);
		// …nor `node:process` imported for an INERT member, default or named: the member rule
		// is the one the `process` global answers to.
		plant(
			planted,
			join(dir, 'processinert.ts'),
			"import proc, { env as e } from 'node:process';\nexport const facts = () => [proc.env.X, e.Y, proc.pid];\n",
		);
		const found = processReachers(planted, dir);
		expect(found.map((reach) => reach.file).sort()).toEqual(Object.keys(shapes).sort());

		// AND A FIFTH CALL IN AN EXEMPT FILE is a count that moved, not a covered call.
		const exemptFile = join(SOURCE_ROOT, 'drivers/confinement.ts');
		const exemptBody = readFileSync(exemptFile, 'utf8');
		const grown = `${exemptBody}\nexport const rogue = () => spawnSync('/bin/sh', ['-c', 'id']);\n`;
		expect(processReach(grown, 'drivers/confinement.ts').refs).toBe(
			(EXEMPT['drivers/confinement.ts']?.refs ?? 0) + 1,
		);
		// …and a RE-EXPORT from an exempt file (its importers hold a spawn while its own count
		// stays put) is refused there too; so is a second static import of a process module.
		const reexported = processReach(
			`${exemptBody}\nexport { spawnSync as hostRun } from 'node:child_process';\n`,
			'drivers/confinement.ts',
		);
		expect({
			refs: reexported.refs,
			unresolvable: reexported.unresolvable,
		}).toEqual({
			refs: EXEMPT['drivers/confinement.ts']?.refs ?? 0,
			unresolvable: ['re-export node:child_process'],
		});
		const imported = processReach(
			`import * as cluster from 'node:cluster';\n${exemptBody}`,
			'drivers/confinement.ts',
		);
		expect(imported.staticImports).toBe((EXEMPT['drivers/confinement.ts']?.imports ?? 0) + 1);
	});
});

/* ────────────────────────────────────────────────────────────────────────────────────
 * The rendered host, from the committed reference declaration
 * ──────────────────────────────────────────────────────────────────────────────────── */

function manifestFrom(patch: Record<string, unknown> = {}): InstanceManifest {
	const doc = JSON.parse(readFileSync(DECLARATION, 'utf8')) as Record<string, unknown>;
	return parseManifest({ ...doc, ...patch }, { source: 'agent_confinement_tripwire' });
}

/**
 * The host as `provision apply` renders it: the ledger's facts are a fresh host's (site k =
 * its declaration order), PID 1 is 255 — the release LEAD-1b's floor and conformance were
 * built against.
 */
function render(patch: Record<string, unknown> = {}) {
	const manifest = manifestFrom(patch);
	const layout = derive(manifest);
	const facts = {
		agentIdentities: new Map(layout.sites.map((site, index) => [site.slug, index + 1])),
		systemdVersion: 255,
		identityEpoch: 1,
	};
	return { layout, facts, artifacts: renderAll(layout, manifest, facts) };
}

/* ────────────────────────────────────────────────────────────────────────────────────
 * §2 The unit
 * ──────────────────────────────────────────────────────────────────────────────────── */

describe("the museum's unit hardens the daemon AND what it starts underneath it", () => {
	const { artifacts } = render();
	const unit = artifacts.find((artifact) => artifact.kind === 'unit');

	test('the unit is rendered at all', () => {
		expect(unit).toBeDefined();
		expect(unit?.body.length).toBeGreaterThan(1000);
	});

	test('the three agent-facing directives stand beside the hardening set that was there', () => {
		const body = unit?.body ?? '';
		// The three this row adds. ProtectProc is the one the audit named by absence: without
		// it every `/proc/<pid>/environ` on the host — this daemon's included — is readable to
		// anything started underneath.
		for (const directive of [
			'ProtectProc=invisible',
			'RestrictSUIDSGID=yes',
			'LockPersonality=yes',
		]) {
			expect({ directive, present: body.includes(`\n${directive}`) }).toEqual({
				directive,
				present: true,
			});
		}
		// …and the set they must not have replaced. A gate that asserted only the new lines
		// would go green on a unit that had dropped ProtectSystem= to make room for them.
		for (const directive of [
			'NoNewPrivileges=yes',
			'ProtectSystem=strict',
			'ProtectHome=yes',
			'PrivateTmp=yes',
			'UMask=',
			'ReadWritePaths=',
			'LoadCredential=',
		]) {
			expect({ directive, present: body.includes(`\n${directive}`) }).toEqual({
				directive,
				present: true,
			});
		}
	});
});

/* ────────────────────────────────────────────────────────────────────────────────────
 * §3 The authorization
 * ──────────────────────────────────────────────────────────────────────────────────── */

describe('the agent authorization is rendered, scoped and per museum', () => {
	const { layout, artifacts } = render();
	const rule = artifacts.find((artifact) => artifact.kind === 'agent_authorization');

	test('it exists, as a root-owned file where polkit reads rules', () => {
		expect(rule).toBeDefined();
		expect(rule?.path).toBe(layout.agentPolicyPath);
		expect(rule?.path).toContain('/polkit-1/rules.d/');
		// Read by polkitd running as root; writable by nobody else. A group-writable rule file
		// is a grant the grantee can widen.
		expect({ owner: rule?.owner, group: rule?.group, mode: rule?.mode }).toEqual({
			owner: 'root',
			group: 'root',
			mode: 0o644,
		});
	});

	test('it grants THIS museum’s service user its DECLARED sites’ run instances, STOP and KILL only', () => {
		const body = rule?.body ?? '';
		expect(body).toContain('org.freedesktop.systemd1.manage-units');
		expect(body).toContain(`subject.user !== "${layout.identity.user}"`);
		// The unit test is ONE anchored regex whose ordinals are ENUMERATED from the ledger's
		// facts — never a prefix: a prefix match is every unit name the service user can spell,
		// a template, a socket, an undeclared site's, a transient-style name.
		// The instance suffix is every spelling PID 1 has given one accepted AF_UNIX connection
		// (socket.c `instance_from_socket`): `<nr>-<pid>-<uid>` up to 257, and from 258
		// `<nr>-<cookie>-<pid>_<pidfd id>-<uid>` or `<nr>-<cookie>-<pid>-<uid>` — a grant that
		// knew only the first would leave a 258 host's daemon unable to stop any run.
		const ordinals = layout.sites.map((_site, index) => index + 1).join('|');
		expect(body).toContain(
			`/^${layout.agentUnitPrefix}s(${ordinals})-(turn|build|git)@[0-9]+-[0-9]+-[0-9]+(?:_[0-9]+-[0-9]+|-[0-9]+)?\\.service$/.test(unit)`,
		);
		expect(body).not.toContain('indexOf("dedalo-site-');
		// The ENTIRE set of verbs answered YES, read off the rendered array — not a substring hunt
		// a comment could satisfy.
		const allowed = /var allowed = \[([^\]]*)\];/.exec(body)?.[1];
		expect(allowed).toBe('"stop", "kill"');
		expect([...AGENT_UNIT_VERBS].sort()).toEqual(['kill', 'stop']);
		// F2. polkit is handed a unit's NAME and VERB, never the uid it runs as, so a "start"
		// grant was root-equivalent on systemd >= 257. No verb that creates or starts a unit may
		// appear in the rule at all — code or comment. (The daemon needs none: PID 1 starts a
		// run when the daemon connects to the site's socket, which asks polkit nothing.)
		for (const verb of [
			'"start"',
			'"restart"',
			'"reload-or-restart"',
			'"enable"',
			'"reload-daemon"',
			'"mask"',
		]) {
			expect({ verb, present: body.includes(verb) }).toEqual({ verb, present: false });
		}
		// Everything unmatched falls through, so this file can only ADD the permission it
		// names — it can never widen or revoke another rule on the host.
		expect(body).toContain('polkit.Result.NOT_HANDLED');
		expect(body).toContain('polkit.Result.YES');
	});

	test('a host with no site identity grants nothing at all', () => {
		// The rule before the ledger has spoken (a render without facts) answers NOT_HANDLED
		// to every question — never a wildcard over the prefix.
		const manifest = manifestFrom();
		const bare = renderAll(derive(manifest), manifest).find(
			(artifact) => artifact.kind === 'agent_authorization',
		);
		expect(bare?.body).toBeDefined();
		expect(bare?.body.includes('polkit.Result.YES')).toBe(false);
	});

	test('the daemon’s control plane cannot start a unit either — start is not a verb it sends', () => {
		// The wiring, read from CODE (comments stripped): the one `systemctl` door refuses every
		// verb but show / list-units / stop. The behaviour is the package gate
		// (tests/agent_confinement.test.ts "a control plane that cannot start").
		const code = readFileSync(join(SOURCE_ROOT, 'drivers/confinement.ts'), 'utf8')
			.split('\n')
			.map((line) => line.replace(/^\s*(\/\/|\*|\/\*).*$/, ''))
			.join('\n');
		expect(code).toContain("verb !== 'show' && verb !== 'list-units' && verb !== 'stop'");
		expect(code).not.toMatch(/systemd-run|--uid=/);
	});

	test("one museum's grant cannot reach another museum's turns", () => {
		const other = render({ instance: 'museum-b' });
		const otherRule = other.artifacts.find((artifact) => artifact.kind === 'agent_authorization');
		expect(otherRule?.path).not.toBe(rule?.path);
		expect(other.layout.agentUnitPrefix).not.toBe(layout.agentUnitPrefix);
		// The decisive one: B's rule must not authorize A's unit prefix, and vice versa.
		expect(otherRule?.body.includes(layout.agentUnitPrefix)).toBe(false);
		expect(rule?.body.includes(other.layout.agentUnitPrefix)).toBe(false);
	});
});

/* ────────────────────────────────────────────────────────────────────────────────────
 * §4 The recorded decision
 * ──────────────────────────────────────────────────────────────────────────────────── */

describe('the agent identity is per DECLARED SITE, and that choice is written down', () => {
	test('a run does not run as the daemon, nor as another site, on any instance', () => {
		for (const instance of ['museum-a', 'museum-b', 'x-y-z']) {
			const { layout, facts, artifacts } = render({ instance });
			const names = [...facts.agentIdentities.values()].map((k) => agentIdentityName(instance, k));
			expect(names.length).toBe(layout.sites.length);
			expect(new Set(names).size).toBe(names.length);
			expect(names).not.toContain(layout.identity.user);
			// The legacy per-museum agent is never one of them (it is retired and locked).
			expect(names).not.toContain(layout.identity.agentUser);
			// The unix ceiling, on the names the grammar admits.
			for (const name of names) expect(name.length).toBeLessThanOrEqual(32);
			expect(layout.agentUnitPrefix.startsWith(`${USER_PREFIX}${instance}`)).toBe(true);
			// OUTCOME, off the RENDERED units: every template of site k runs as site k's identity.
			for (const [slug, k] of facts.agentIdentities) {
				for (const door of ['turn', 'build', 'git']) {
					const template = artifacts.find((artifact) =>
						artifact.path.endsWith(`/${layout.agentUnitPrefix}s${k}-${door}@.service`),
					);
					expect({ slug, door, user: /^User=(.*)$/m.exec(template?.body ?? '')?.[1] }).toEqual({
						slug,
						door,
						user: agentIdentityName(instance, k),
					});
				}
			}
		}
	});

	test('two museums never share one site identity', () => {
		const a = render({ instance: 'museum-a' });
		const b = render({ instance: 'museum-b' });
		const namesOf = (r: typeof a, instance: string) =>
			[...r.facts.agentIdentities.values()].map((k) => agentIdentityName(instance, k));
		const shared = namesOf(a, 'museum-a').filter((name) => namesOf(b, 'museum-b').includes(name));
		expect(shared).toEqual([]);
	});

	test('two SITES of one museum are two identities — the decision, asserted as made', () => {
		// The row's named decision, held in the direction it was decided (LEAD-1b). Going back to
		// one uid per museum would make this fail, which is exactly right: that is the shape
		// whose concurrent runs reached each other's sockets and HOMEs.
		const doc = JSON.parse(readFileSync(DECLARATION, 'utf8')) as Record<string, unknown>;
		const sites = doc.sites as Array<Record<string, unknown>>;
		expect(sites.length).toBeGreaterThan(1);
		const { layout, facts, artifacts } = render();
		expect(layout.sites.length).toBe(sites.length);
		const users = new Set(
			artifacts
				.filter((artifact) => /@\.service$/.test(artifact.path))
				.map((artifact) => /^User=(.*)$/m.exec(artifact.body)?.[1]),
		);
		expect(users.size).toBe(facts.agentIdentities.size);
	});

	test('the acceptance is written beside the derivation, with its expiry condition', () => {
		const source = readFileSync(join(SOURCE_ROOT, 'provision/layout.ts'), 'utf8');
		// The requirement was that the boundary this design does NOT draw is stated where the
		// naming is decided. Three things must be in it: the choice, what it does not protect,
		// and what would change it.
		expect(source).toContain(
			'THE RECORDED DECISION — ONE AGENT IDENTITY PER DECLARED SITE (LEAD-1b)',
		);
		expect(source).toContain('WHAT IS DRAWN');
		expect(source).toContain('WHAT IS NOT DRAWN, AND IS ACCEPTED');
		expect(source).toContain('WHAT WOULD CHANGE IT');
	});
});

/* ────────────────────────────────────────────────────────────────────────────────────
 * §5 A provisioned host is confined by construction
 * ──────────────────────────────────────────────────────────────────────────────────── */

describe('the rendered env leaves the daemon no unconfined mode to fall into', () => {
	const { layout, facts, artifacts } = render();

	test('it states the mode, the site identities and where their sockets are', () => {
		const env = artifacts.find((artifact) => artifact.kind === 'env');
		const body = env?.body ?? '';
		expect(body).toContain('AGENT_CONFINEMENT="systemd_scope"');
		expect(body).toContain(`AGENT_UNIT_PREFIX="${layout.agentUnitPrefix}"`);
		expect(body).toContain(`AGENT_SOCKET_DIR="${layout.agentSocketDir}"`);
		expect(body).toContain(`AGENT_STATE_ROOT="${layout.agentStateRoot}"`);
		const identities = /^AGENT_IDENTITIES="(.*)"$/m.exec(body)?.[1] ?? '';
		expect(JSON.parse(identities.replace(/\\"/g, '"'))).toEqual(
			Object.fromEntries(facts.agentIdentities),
		);
		// The retired keys are gone: no shared agent, no transient runner, no shared HOME.
		expect(body).not.toMatch(/^AGENT_USER=/m);
		expect(body).not.toMatch(/^AGENT_HOME=/m);
		expect(body).not.toMatch(/^SYSTEMD_RUN_BIN=/m);
		// And it still carries no credential — the property that lets this file be readable by
		// the service user's group at all.
		expect(body).not.toMatch(/^SERVICE_TOKEN=/m);
		expect(body).not.toMatch(/^ANTHROPIC_API_KEY=/m);
	});

	test('every declared site has its socket, target and template for every door, rendered by root', () => {
		for (const [, k] of facts.agentIdentities) {
			for (const door of ['turn', 'build', 'git']) {
				for (const suffix of ['.socket', '.target', '@.service']) {
					const name = `${layout.agentUnitPrefix}s${k}-${door}${suffix}`;
					const unit = artifacts.find((artifact) => artifact.path.endsWith(`/${name}`));
					expect({ name, owner: unit?.owner, mode: unit?.mode }).toEqual({
						name,
						owner: 'root',
						mode: 0o644,
					});
				}
				const socket = artifacts.find((artifact) =>
					artifact.path.endsWith(`/${layout.agentUnitPrefix}s${k}-${door}.socket`),
				);
				expect(socket?.body).toContain(
					`ListenStream=${agentSocketPath(layout.agentSocketDir, k, door as 'turn')}`,
				);
				expect(socket?.body).toContain('MaxConnections=1');
				expect(socket?.body).toContain('SocketMode=0600');
				// Stopped in the daemon's own stop transaction: a socket with a stop pending
				// accepts nothing, so no connect during the stop can cancel it.
				expect(socket?.body).toMatch(new RegExp(`^PartOf=${escapeRegExp(layout.unitName)}$`, 'm'));
			}
		}
		// Each proxy door's egress directory is ROOT's (tmpfiles.d): root:<site group> 0770
		// under a root 0755 egress/ — never the daemon's runtime directory, never its uid's.
		const tmpfiles = artifacts.find((artifact) => artifact.path === layout.agentTmpfilesPath);
		expect({ owner: tmpfiles?.owner, mode: tmpfiles?.mode }).toEqual({
			owner: 'root',
			mode: 0o644,
		});
		expect(tmpfiles?.body).toContain(`\nd ${layout.agentSocketDir}/egress 0755 root root -\n`);
		for (const [, k] of facts.agentIdentities) {
			expect(tmpfiles?.body).toContain(
				`\nd ${layout.agentSocketDir}/egress/s${k} 0770 root dedalo-a-${layout.instance}_${k} -\n`,
			);
		}
	});

	test('the shared tree is group-writable and setgid, so two uids can work in it', () => {
		// The ownership half of the second identity. Without the group write bit an identity
		// cannot write its own workspace and every run fails; without setgid its files land in
		// its own group and the daemon's commit reads a tree it half-owns; with the world bits
		// open, one museum's unpublished drafts are readable by every uid on the host.
		const row = MODES.workspaces;
		expect({ owner: row.owner, group: row.group }).toEqual({ owner: 'user', group: 'group' });
		expect((row.mode & 0o2000) !== 0).toBe(true);
		expect((row.mode & 0o020) !== 0).toBe(true);
		expect(row.mode & 0o007).toBe(0);
		// The BUILD HOME is its identity's own, closed to every other principal (LEAD-1b): the
		// cross-site plant channel the one shared HOME was.
		expect({ owner: MODES.agentHome.owner, mode: MODES.agentHome.mode }).toEqual({
			owner: 'identity',
			mode: 0o700,
		});
		// The TURN HOME is ROOT's (S3-HOME): nothing at HOME level is agent-writable, so no turn plants
		// configuration (git's global files, ~/.bunfig.toml, ~/.config/*) a later turn reads; its
		// `state/` alone is the identity's, closed; its `.config` root's.
		expect({
			owner: MODES.agentTurnHome.owner,
			writable: (MODES.agentTurnHome.mode & 0o022) !== 0,
		}).toEqual({
			owner: 'root',
			writable: false,
		});
		expect({ owner: MODES.agentTurnState.owner, mode: MODES.agentTurnState.mode }).toEqual({
			owner: 'identity',
			mode: 0o700,
		});
		expect({
			owner: MODES.agentTurnConfig.owner,
			writable: (MODES.agentTurnConfig.mode & 0o022) !== 0,
		}).toEqual({
			owner: 'root',
			writable: false,
		});
		expect(MODES.agentStateRoot.owner).toBe('root');
		expect(MODES.agentStateSite.owner).toBe('root');
		// The root ABOVE them is still root's: the daemon writes inside its roots and cannot
		// replace one, and neither can an identity.
		expect(MODES.stateDir.owner).toBe('root');
		// The credential store is unreachable to all of them through the filesystem.
		expect({ owner: MODES.secret.owner, mode: MODES.secret.mode }).toEqual({
			owner: 'root',
			mode: 0o600,
		});
	});

	test('the committed example carries the rendered rule, so a reviewer sees the grant', () => {
		// The examples are the third corner (`tests/provision_examples.test.ts`): a rule that
		// existed only in a renderer would be a host permission nobody ever read.
		const committed = join(
			PACKAGE,
			'deploy/examples/rendered/etc/polkit-1/rules.d',
			`49-${USER_PREFIX}${manifestFrom().instance}-agent.rules`,
		);
		expect(statSync(committed).isFile()).toBe(true);
		expect(readFileSync(committed, 'utf8')).toContain('org.freedesktop.systemd1.manage-units');
	});
});

/* ────────────────────────────────────────────────────────────────────────────────────
 * §6 The other door — a build step is agent-authored text too
 * ──────────────────────────────────────────────────────────────────────────────────── */

/**
 * WHO MAY REACH THE UNCONFINED RUNNER.
 *
 * The turn was confined and the BUILD was not, and that made the build a WIDER principal
 * than the turn: `site.json` sits inside the workspace a turn writes, `bun install` executes
 * the lifecycle scripts of a `package.json` a turn authored, and `git add` runs the filters
 * of a `.git` a turn can replace — every one of them as the SERVICE user, the uid that owns
 * the workspaces, the audit trail and the credential directory the museum's bearer is read
 * from. The fix is a door (`util/spawn.ts` refuses a workspace cwd without the confinement's
 * token) and this is its import-side census: only the confinement and the version probes may
 * name the runner at all.
 */
const RUNNER_IMPORTERS: Readonly<Record<string, string>> = Object.freeze({
	'drivers/confinement.ts':
		'the holder of the token: runConfined() wraps the argv under the agent uid first, and is ' +
		'the only way a command runs inside a site workspace.',
	'drivers/claude_code.ts':
		'the driver VERSION AND FLAG PROBE — a pinned binary run with --version and --help (PLANT: ' +
		'a turn is refused unless --help lists every flag its argv needs), cwd /, outside every workspace.',
	'drivers/opencode.ts':
		'the driver VERSION AND PLANT PROBE (LEAD-1c) — a pinned binary asked for its version and ' +
		'its `run --help`, then for what it would LOAD (`debug config|agent|skill`) twice — a control ' +
		"without the four switches and exactly the turn's environment — offline, with cwd a daemon-written " +
		'canary tree under AGENT_STATE_ROOT/probe (0700, built through the private helpers) — outside every ' +
		'workspace, nothing agent-authored near it.',
	'drivers/pi.ts':
		'the driver VERSION PROBE — the same shape again, on the driver that refuses to run a ' +
		'turn at all until it is implemented.',
});

/**
 * Does an import specifier, written in `fromFile`, name `target`? RESOLVED, never matched: the
 * specifier is resolved against the importing file's directory and compared with the target's
 * path with the extension normalised (`.ts` / `.js` / none) — so `'../util/spawn.ts'`,
 * `"../util/spawn"`, `'./spawn'` from a sibling and `'../util/spawn.js'` are all the runner.
 */
function resolvesTo(fromFile: string, specifier: string, target: string): boolean {
	if (!(specifier.startsWith('.') || isAbsolute(specifier))) return false;
	const stem = (path: string) => path.replace(/\.(?:[cm]?[jt]s|tsx|jsx)$/, '');
	return stem(resolve(dirname(fromFile), specifier)) === stem(target);
}

/** Escape a binding name for a pattern (`$` is legal in one). */
const escapeName = (name: string) => escapeRegExp(name);

/** Does transpiled code hand a local binding on as an export (a list, a default, an alias)? */
function exportsBinding(js: string, local: string): boolean {
	for (const match of js.matchAll(/^export\s*\{([^}]*)\}\s*;?[ \t]*$/gm)) {
		const named = (match[1] ?? '')
			.split(',')
			.map((part) => (part.trim().split(/\s+as\s+/)[0] ?? '').trim());
		if (named.includes(local)) return true;
	}
	const name = escapeName(local);
	return (
		new RegExp(`^export\\s+default\\s+${name}\\b`, 'm').test(js) ||
		new RegExp(`^export\\s+(?:const|let|var)\\s+[^=;]+=\\s*${name}\\s*[;,\\n]`, 'm').test(js)
	);
}

interface RunnerReach {
	/** Files that statically import the runner (a re-export from it included). */
	readonly importers: readonly string[];
	/** Refused everywhere, exempt files included: dynamic import / require of it, a re-export. */
	readonly refused: readonly string[];
}

/**
 * WHO REACHES THE UNCONFINED RUNNER — derived from the MODULE GRAPH, as §1 is (round 5: the
 * spelling census `from '(\.\.?\/)+util\/spawn'` passed a `.ts` suffix, double quotes, a dynamic
 * import, a `.js` suffix and a sibling's `./spawn` re-export, measured). Every import
 * `Bun.Transpiler.scanImports` sees — static, dynamic, `require`, export-from — is RESOLVED
 * against its file. A static importer must be enumerated; a dynamic import or a require of the
 * runner yields bindings no scan follows, and a re-export (export-from, or a binding imported
 * from it handed on by `export { … }` / `export default` / `export const x = …`) makes every
 * importer of the re-exporter a runner importer the list never names — so both are refused
 * EVERYWHERE, exempt files included. HONEST LIMIT: a WRAPPER (`export const run = (…a) =>
 * runBinary(…a)`) in an exempt file is a function of its own, which is why the exemptions are
 * few, reasoned, and reviewed.
 */
function runnerReach(files: readonly string[], root: string): RunnerReach {
	const target = join(root, 'util/spawn.ts');
	const importers: string[] = [];
	const refused: string[] = [];
	for (const path of files) {
		const file = relative(root, path);
		if (file === 'util/spawn.ts') continue;
		const code = readFileSync(path, 'utf8');
		const hits = scanAll(code).filter((entry) => resolvesTo(path, entry.path, target));
		if (hits.length === 0) continue;
		if (hits.some((entry) => entry.kind === 'import-statement')) importers.push(file);
		for (const entry of hits) {
			if (entry.kind !== 'import-statement') refused.push(`${file}: ${entry.kind} ${entry.path}`);
		}
		const js = TS.transformSync(code);
		const locals: string[] = [];
		for (const match of js.matchAll(IMPORT_LINE)) {
			if (resolvesTo(path, match[2] as string, target))
				locals.push(...bindingsOf(match[1] as string));
		}
		for (const match of js.matchAll(EXPORT_FROM_LINE)) {
			if (resolvesTo(path, match[2] as string, target))
				refused.push(`${file}: re-export ${match[2]}`);
		}
		for (const local of locals) {
			if (exportsBinding(js, local)) refused.push(`${file}: re-exports ${local}`);
		}
	}
	return { importers: importers.sort(), refused };
}

const CALL_REF = '__DEDALO_IMPORTED_CALL__';
const CALL_NS = '__DEDALO_IMPORTED_NS__';

/**
 * How many CALLS a file makes to `name` imported from `targetRel` — scope-resolved, the §1 way:
 * the import is resolved (not matched), its line removed, its local binding (or namespace)
 * `define`d to a sentinel, so a comment, a string, a type-only import and a local of the same
 * name are not calls, and an alias or a namespace member is.
 */
function importedCalls(code: string, fileRel: string, targetRel: string, name: string): number {
	const base = '/census';
	const from = join(base, fileRel);
	const target = join(base, targetRel);
	const locals: string[] = [];
	const namespaces: string[] = [];
	const js = TS.transformSync(code).replace(IMPORT_LINE, (line, clause: string, spec: string) => {
		if (!resolvesTo(from, spec, target)) return line;
		for (const { imported, local } of importBindings(clause)) {
			if (imported === name) locals.push(local);
			else if (imported === '*') namespaces.push(local);
		}
		return '';
	});
	const define: Record<string, string> = {};
	for (const local of locals) define[local] = CALL_REF;
	for (const local of namespaces) define[local] = CALL_NS;
	const out = new Bun.Transpiler({ loader: 'js', define }).transformSync(js);
	return (
		[...out.matchAll(new RegExp(`${CALL_REF}\\s*\\(`, 'g'))].length +
		[...out.matchAll(new RegExp(`${CALL_NS}\\s*\\.\\s*${escapeName(name)}\\s*\\(`, 'g'))].length
	);
}

describe('a build step, an install script and a git hook run as the agent, never as the daemon', () => {
	const files = siteBuilderDaemonFiles();
	const reach = runnerReach(files, SOURCE_ROOT);
	const importers = [...reach.importers];

	test('the corpus is the tree, and the runner really is imported somewhere', () => {
		expect(files.length).toBeGreaterThan(40);
		expect(importers.length).toBeGreaterThan(3);
	});

	test('only the confinement and the version probes reach the unconfined runner', () => {
		expect(importers).toEqual(Object.keys(RUNNER_IMPORTERS).sort());
		// …and nobody reaches it a way the list cannot see, or hands it on (exempt files too).
		expect(reach.refused).toEqual([]);
		// The two modules whose commands run over agent-authored bytes must NOT be among
		// them — this is the exact shape the refutation reproduced.
		expect(importers).not.toContain('build/builder.ts');
		expect(importers).not.toContain('sites/git.ts');
		for (const [file, reason] of Object.entries(RUNNER_IMPORTERS)) {
			expect({ file, stated: reason.length > 60 }).toEqual({ file, stated: true });
		}
	});

	test('the two modules that execute agent-authored commands go through the confinement', () => {
		// A scope-resolved CALL of the confinement's runConfined — not the substring, which a
		// comment satisfies.
		for (const file of ['build/builder.ts', 'sites/git.ts']) {
			const source = readFileSync(join(SOURCE_ROOT, file), 'utf8');
			const calls = importedCalls(source, file, 'drivers/confinement.ts', 'runConfined');
			expect({ file, confined: calls > 0 }).toEqual({ file, confined: true });
		}
		// And the door is a REFUSAL, not a convention: the runner itself stops a spawn whose
		// cwd is inside the workspaces root. (Its behaviour — the refusal, the resolved-path
		// question, the one key that opens it — is the package's own gate.)
		const runner = readFileSync(join(SOURCE_ROOT, 'util/spawn.ts'), 'utf8');
		expect(runner).toContain('CONFINED_ARGV');
		expect(runner).toContain('config.SITES_ROOT');
	});

	test('the scanner really finds an importer — every spelling of one is reported', () => {
		// Round 5: the spelling census (`from '../util/spawn'`, single quotes, no suffix) passed
		// each of these GREEN, measured — and `runBinary` with no cwd skips the runner's
		// workspace refusal entirely, so any one of them was `git -C <ws>` as the daemon uid.
		const dir = mkdtempSync(join(tmpdir(), 'agent-confinement-runner-'));
		for (const sub of ['build', 'sites', 'util']) mkdirSync(join(dir, sub));
		const planted: string[] = [];
		const rows: Record<string, string> = {
			'build/rogue.ts':
				"import { runBinary } from '../util/spawn';\nrunBinary(['sh'], { timeoutMs: 1 });\n",
			'build/suffix.ts':
				"import { runBinary } from '../util/spawn.ts';\nrunBinary(['git'], { timeoutMs: 1 });\n",
			'build/js_suffix.ts':
				"import { runBinary } from '../util/spawn.js';\nrunBinary(['git'], { timeoutMs: 1 });\n",
			'build/double.ts':
				'import { runBinary as r } from "../util/spawn";\nr(["git"], { timeoutMs: 1 });\n',
			'sites/multiline.ts':
				"import {\n  runBinary,\n} from '../util/spawn';\nrunBinary(['git'], { timeoutMs: 1 });\n",
			'util/sibling.ts': "export { runBinary as run } from './spawn';\n",
		};
		for (const [rel, body] of Object.entries(rows)) plant(planted, join(dir, rel), body);
		const dynamic = plant(
			planted,
			join(dir, 'sites/dynamic.ts'),
			"export const go = async () => (await import('../util/spawn')).runBinary(['git'], { timeoutMs: 1 });\n",
		);
		// …and a CONSTANT-FOLDED one (round 6, measured: `'../util/' + 'spawn'` was no importer
		// and no refusal — git run as the daemon uid with §6 green).
		const folded = plant(
			planted,
			join(dir, 'sites/folded.ts'),
			"export const go = async () => (await import('../util/' + 'spawn')).runBinary(['git'], { timeoutMs: 1 });\n",
		);
		// …and an EXEMPT importer that hands the runner on (a re-export makes every importer of
		// it a runner importer while the census's own list stays put) is refused, too.
		const laundered = plant(
			planted,
			join(dir, 'drivers_claude_code.ts'),
			"import { runBinary } from './util/spawn';\nexport { runBinary as probe };\n",
		);
		plant(
			planted,
			join(dir, 'quiet.ts'),
			"import { join } from 'node:path';\nexport const x = join;\n",
		);
		plant(
			planted,
			join(dir, 'prose.ts'),
			"// import { runBinary } from '../util/spawn';\nexport const s = \"from '../util/spawn'\";\n",
		);
		const reach = runnerReach(planted, dir);
		expect(reach.importers).toEqual([...Object.keys(rows), relative(dir, laundered)].sort());
		expect([...reach.refused].sort()).toEqual(
			[
				`${relative(dir, dynamic)}: dynamic-import ../util/spawn`,
				`${relative(dir, folded)}: dynamic-import ../util/spawn`,
				`${relative(dir, laundered)}: re-exports runBinary`,
				'util/sibling.ts: re-export ./spawn',
			].sort(),
		);
	});

	test('the scope-resolved call scanner really tells a call from a mention', () => {
		const call = (code: string) =>
			importedCalls(code, 'build/x.ts', 'drivers/confinement.ts', 'runConfined');
		expect(
			call("import { runConfined } from '../drivers/confinement';\nawait runConfined({});\n"),
		).toBe(1);
		expect(
			call('import { runConfined as rc } from "../drivers/confinement.ts";\nawait rc({});\n'),
		).toBe(1);
		expect(call("import * as c from '../drivers/confinement';\nawait c.runConfined({});\n")).toBe(
			1,
		);
		// A comment, a string, a type position and a local of the same name are NOT calls.
		expect(
			call(
				"import type { runConfined } from '../drivers/confinement';\n// runConfined(x)\nconst s = 'runConfined(';\nconst f = (runConfined: () => void) => runConfined();\n",
			),
		).toBe(0);
		expect(call('const runConfined = () => 0;\nrunConfined();\n')).toBe(0);
	});
});

/* ────────────────────────────────────────────────────────────────────────────────────
 * §7 The tree the two uids share
 * ──────────────────────────────────────────────────────────────────────────────────── */

describe('the shared tree is writable to the agent, and the daemon’s own state is not', () => {
	test('the provisioned roots and the RUNTIME workspaces state one mode, not two', () => {
		// The half the second identity was missing: `MODES.workspaces` opened the ROOT, while
		// each site directory under it was created at runtime with the daemon's own umask
		// (0027) — drwxr-x---, agent in the group and never the owner. Every turn would have
		// started, been authorized, and failed on its first Write. One constant, both places.
		expect(MODES.workspaces.mode).toBe(SHARED_DIR_MODE);
		expect(SHARED_DIR_MODE & 0o2000).toBe(0o2000); // setgid: agent files keep the museum's group
		expect(SHARED_DIR_MODE & 0o070).toBe(0o070); // group rwx: the other uid may write
		expect(SHARED_DIR_MODE & 0o007).toBe(0); // world: another museum sees nothing
		expect(SHARED_FILE_MODE & 0o060).toBe(0o060); // group rw: the agent EDITS site.json
		expect(SHARED_FILE_MODE & 0o007).toBe(0);
		// And the daemon's own per-site state inside that tree is not shared: `.builder` itself
		// is TRAVERSE-ONLY to the group (the site identity opens the one file it is handed —
		// the turn's MCP config — and lists, creates and renames nothing), everything in it 0700.
		expect(PRIVATE_DIR_MODE & 0o077).toBe(0);
		expect(DAEMON_STATE_DIR_MODE).toBe(0o710);
	});

	test('the audit trail is closed to the group the agent uid is in', () => {
		// `ProtectSystem=strict` makes the audit root read-only to a turn; read-only is not
		// unreadable, and the agent's PRIMARY group is this museum's group. A 0640 trail was
		// therefore every actor row of the instance, readable to text a language model wrote.
		expect(MODES.auditFile.mode & 0o077).toBe(0);
		expect(MODES.auditFile.owner).toBe('user');
		expect(MODES.auditDir.owner).toBe('root');
		// The credential store, for the same reason, in the same direction.
		expect(MODES.secret.mode & 0o077).toBe(0);
		expect(MODES.secretsDir.mode & 0o077).toBe(0);
	});
});

/**
 * WHO STILL MUTATES THE FILESYSTEM BY PATH — the census, TOTAL over `src/`.
 *
 * Two defects, one wiring. `mkdir(dir, {recursive:true})` and `writeFile(path, body)` take
 * the daemon's umask (0027 on a provisioned host), so a module that reaches for them writes
 * a site directory the agent uid cannot enter and a `site.json` it cannot edit. And a
 * path-based write FOLLOWS LINKS: `confinedPath` is lexical, so a link planted where the
 * daemon writes redirects the daemon's own uid out of the tree.
 *
 * THE SCOPE IS THE WHOLE TREE, AND THE QUESTION IS THE DESTINATION. The first version of
 * this census scoped itself to `sites/`, `context/` and `build/` — the directories the fix
 * had touched — which is exactly the shape of a census that answers about itself: measured
 * afterwards, `sites/git.ts` (the `.git/info/exclude` rewritten on EVERY commit), BOTH
 * drivers' MCP configs (which carry the museum's Publication API key) and `sessions/store.ts`
 * (every event of every turn) were all still path-based, and three of the four were not even
 * scanned. So every `.ts` file under `src/` is scanned.
 *
 * AND THE SPELLING IS NOT THE SUBJECT EITHER. The second version required the `(` to follow
 * the bare name, so every `*Sync` variant, `Bun.write(` and `createWriteStream(` were
 * invisible — measured: a planted `src/zz_probe.ts` doing `mkdirSync(<workspace>, {recursive:
 * true})` + `writeFileSync(<workspace>/y.txt, body)` passed this census GREEN, and
 * `sites/webspace.ts` had been writing with `writeFileSync` all along, neither found nor
 * exempted. The name is matched with an optional `Sync`, plus `open`/`openSync` (an
 * `O_CREAT` open is a write), `Bun.write` and `createWriteStream`.
 *
 * AN EXEMPTION MUST SAY WHY A PLANTED LINK AT ITS DESTINATION CANNOT REDIRECT IT, and there
 * are only two honest answers: the destination is OUTSIDE `SITES_ROOT` and outside every
 * workspace, or the call REFUSES a planted name by construction (`O_EXCL|O_NOFOLLOW`, or
 * `symlink(2)`, which creates a link and never writes through one). Never "its modes are
 * someone else's business".
 */
/**
 * The modules whose bindings the two censuses follow. `bun:sqlite` too (2026-10-21): its
 * `Database` OPENS A PATH — a content read of whatever the name resolves to — and the census
 * that followed only the fs modules was blind to it (opencode's turn-database read was invisible).
 */
const FS_MODULES: ReadonlySet<string> = new Set([
	'node:fs',
	'fs',
	'node:fs/promises',
	'fs/promises',
	'bun:sqlite',
]);

/**
 * Path-based MUTATIONS (each with its `Sync` twin). Closed: `open` counts (an O_CREAT open is a
 * write), and so does a DELETE — `rm`/`rmdir`/`unlink` follow every link on the way to their last
 * component, so a planted directory link aims a (recursive) delete wherever the daemon can write.
 */
const FS_WRITE_NAMES: ReadonlySet<string> = new Set([
	...[
		'rm',
		'rmdir',
		'unlink',
		'mkdir',
		'mkdtemp',
		'writeFile',
		'appendFile',
		'copyFile',
		'cp',
		'chmod',
		'chown',
		'truncate',
		'utimes',
		'rename',
		'symlink',
		'link',
		'open',
	].flatMap((name) => [name, `${name}Sync`]),
	'createWriteStream',
]);

/**
 * Path-based CONTENT reads. Closed (listings are names, not content — see the read census).
 * `Database` is bun:sqlite's: `new Database(path)` opens (and reads) the file at a path.
 */
const FS_READ_NAMES: ReadonlySet<string> = new Set([
	'readFile',
	'readFileSync',
	'createReadStream',
	'Database',
]);

const FS_NAMED = '__DEDALO_FS_N_';
const FS_NS = '__DEDALO_FS_NS__';
const FS_BUN = '__DEDALO_FS_BUN__';

/** One fs reference: the fs name it reaches, and the code from there to the end of its line. */
interface FsCall {
	readonly name: string;
	readonly text: string;
}

interface FsReach {
	readonly writes: readonly FsCall[];
	readonly reads: readonly FsCall[];
	/** A namespace used bare / computed / destructured, a dynamic import, a require, a re-export. */
	readonly unresolvable: readonly string[];
}

/**
 * WHAT A FILE CAN DO TO THE FILESYSTEM BY PATH — read off its IMPORTS, the §1 way (round 5).
 * The spelling census (`(?<![.\w])writeFile(` …) kept a HANDLE's `handle.readFile` out with a
 * lookbehind, and with it every member call — `fs.readFile(join(ws,'site.json'))`,
 * `fsp.rename(a,b)` — and an alias (`const rf = readFile; rf(p)`) never names the call at all.
 * Measured: all of them passed GREEN. So: the file is transpiled (types and comments gone), its
 * fs imports removed, and each binding they made `define`d to a sentinel — a named one to its
 * IMPORTED name (an alias is the same function), a default/namespace one (or `promises`) to a
 * namespace sentinel whose MEMBER is then the name. `define` replaces only unbound references,
 * so a string, a comment, a property name and a shadowing local are not references, and a
 * handle's method is told apart by its RECEIVER (it is no fs binding). `Bun.write` / `Bun.file`
 * are the `Bun` global's. A namespace used any other way (bare, computed, destructured), a
 * dynamic import, a `require` or a re-export of an fs module leaves bindings no scan follows —
 * reported as both a write and a read, so no exemption is silent about it.
 */
function fsReach(code: string): FsReach {
	const unresolvable = scanAll(code)
		.filter((entry) => FS_MODULES.has(entry.path) && entry.kind !== 'import-statement')
		.map((entry) => `${entry.kind} ${entry.path}`);
	const define: Record<string, string> = { Bun: FS_BUN };
	const js = TS.transformSync(code)
		.replace(IMPORT_LINE, (line, clause: string, from: string) => {
			if (!FS_MODULES.has(from)) return line;
			for (const { imported, local } of importBindings(clause)) {
				define[local] =
					imported === '*' || imported === 'default' || imported === 'promises'
						? FS_NS
						: `${FS_NAMED}${imported}__`;
			}
			return '';
		})
		.replace(EXPORT_FROM_LINE, (line, _clause: string, from: string) => {
			if (!FS_MODULES.has(from)) return line;
			unresolvable.push(`re-export ${from}`);
			return '';
		});
	const out = new Bun.Transpiler({ loader: 'js', define }).transformSync(js);
	const writes: FsCall[] = [];
	const reads: FsCall[] = [];
	const rest = (index: number) =>
		out.slice(index, out.indexOf('\n', index) < 0 ? undefined : out.indexOf('\n', index));
	const classify = (name: string, text: string) => {
		if (FS_WRITE_NAMES.has(name)) writes.push({ name, text });
		else if (FS_READ_NAMES.has(name)) reads.push({ name, text });
	};
	for (const match of out.matchAll(new RegExp(`${FS_NAMED}([\\w$]+?)__`, 'g'))) {
		const name = match[1] as string;
		classify(name, `${name}${rest((match.index ?? 0) + match[0].length)}`.trim());
	}
	for (const match of out.matchAll(
		new RegExp(`${FS_NS}(?:\\s*\\.\\s*promises)?(?:\\s*\\.\\s*([A-Za-z_$][\\w$]*))?`, 'g'),
	)) {
		const name = match[1];
		if (name === undefined || name === 'promises')
			unresolvable.push('an fs namespace used bare, computed or destructured');
		else classify(name, `${name}${rest((match.index ?? 0) + match[0].length)}`.trim());
	}
	for (const match of out.matchAll(
		new RegExp(`${FS_BUN}(?:\\s*\\.\\s*([A-Za-z_$][\\w$]*))?`, 'g'),
	)) {
		const text = `Bun.${match[1] ?? ''}${rest((match.index ?? 0) + match[0].length)}`.trim();
		if (match[1] === 'write') writes.push({ name: 'Bun.write', text });
		else if (match[1] === 'file') reads.push({ name: 'Bun.file', text });
		else if (match[1] === undefined) unresolvable.push('Bun used bare or computed');
	}
	return { writes, reads, unresolvable };
}

const RAW_FS_EXEMPT: Readonly<Record<string, string>> = Object.freeze({
	'audit.ts':
		'The actor trail under `AUDIT_DIR` — a PROVISIONED root outside `SITES_ROOT`, owned by ' +
		'the service user, 0700 with a 0600 file, and named by no path an agent turn can write ' +
		'in. `ProtectSystem=strict` makes it read-only to a turn on top of that.',
	'drivers/confinement.ts':
		"The DECLARED-unconfined run's HOMEs (`AGENT_CONFINEMENT=none` only), all under " +
		'`<AGENT_STATE_ROOT>/unconfined/`, outside `SITES_ROOT` and every workspace: the build ' +
		"door's `<door>` HOME, and the turn's S3-HOME shape — a persistent `turn/state` (the " +
		"CLI's state, as the unit's `state/`) and a FRESH per-run HOME `turn/run.<random>` with " +
		'its `.config` (mkdtemp; removed when the run exits, stale ones swept at boot), so what ' +
		'one run leaves at HOME level is gone for the next — the same split a unit gives a turn, ' +
		'minus the uid boundary `none` declares away; and, once at boot, the pre-S3 HOME’s CLI ' +
		'state renamed into `turn/state` (the `TURN_HOME_CARRY` allowlist, never through a link, ' +
		'never over a target); a finished run HOME is deleted (`rmSync(runHome)`, recursive, at ' +
		'exit or by the boot sweep) — a mkdtemp name under the daemon-private unconfined root, no ' +
		'path a run is handed but its own HOME. Under systemd_scope the confinement writes ' +
		"NO file at all (LEAD-1b: the spec travels over the site's socket; the per-run " +
		'environment file PID 1 read as root is gone, G8).',
	'provision/apply.ts':
		'THE PROVISIONER, which runs as root before an agent uid exists and CREATES the roots ' +
		'the rest of this census is measured against. Its writes are an interface (`mkdir`, ' +
		'`writeFile`, `symlink`, `chmod` on the fs driver) over paths it derives from the ' +
		'declaration, never from a workspace — its `unlink` included (a link at the path is refused ' +
		'first, and a failed write unlinks only its own temporary).',
	'provision/remove.ts':
		'THE PROVISIONER’S DECOMMISSION (root, the daemon stopped): `unlink` of a generated ' +
		'artifact it proved it wrote (its body-hash stamp names this instance) at a path derived ' +
		'from the layout — unit files, vhost links, the htpasswd — outside `SITES_ROOT`. Every ' +
		'tree with a museum’s bytes is RENAMED aside, never deleted.',
	'provision/adopt.ts':
		'The same provisioner, taking an already-installed tree into the layout: a `rename` of ' +
		'root-owned provisioned paths outside `SITES_ROOT`, before any turn can run.',
	'context/agents_md.ts':
		"`symlink('AGENTS.md', CLAUDE.md)` — CREATING a link, which never writes THROUGH one: " +
		"symlink(2) does not follow its final component and fails EEXIST. The file's content is " +
		'written by `writeFileShared`, which is the leg below. The `rm` before it removes ' +
		'`<slug>/CLAUDE.md` itself: a non-recursive rm never follows its final component (a link ' +
		'there is unlinked as a link), and `<slug>` is a direct child of the trusted root, which ' +
		'no run can rename or plant in (read-only in every unit).',
	'sites/template.ts':
		"`cp` copies a whole template tree, carrying the TEMPLATE's modes; the modes are then " +
		'restated over the result by applySharedModes(), which is the only way to catch what ' +
		'another program created.',
	'build/promote.ts':
		'The release store and the served surface, which are PROVISIONED webspace under ' +
		'`WEBSPACE_BASE` — outside `SITES_ROOT`, never a directory an agent turn can write, ' +
		'and moded by the provisioner rather than by this module. Its deletes (a failed ' +
		'staging copy, a pruned release, the link swap’s own temporary) are names under that ' +
		'store, confined (`confinedPath`) before anything is unlinked.',
	'sites/webspace.ts':
		'The per-build write probe (written, then unlinked), inside the PROVISIONED webspace ' +
		'under `WEBSPACE_BASE` — outside `SITES_ROOT` and outside every workspace, created by ' +
		'the provisioner and read-only to a turn under `ProtectSystem=strict`.',
	'index.ts':
		'`chmodSync` on the LISTEN SOCKET this process just bound, in the daemon runtime ' +
		'directory outside `SITES_ROOT` (the `open()` handler of a `Bun.connect` socket, which ' +
		'the spelling census also matched, is no fs binding and no longer counts); and the ' +
		'`unlinkSync` of that socket path — a stale one nothing answers on, before the bind, ' +
		'and its own at shutdown.',
	'instance/roots.ts':
		'The BOOT PREFLIGHT probes. The audit append is `AUDIT_DIR`, outside `SITES_ROOT`; ' +
		'the create probe DOES land at the root of `SITES_ROOT`, which is 2770, ' +
		'so it is opened `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW` — an existing name of any kind, ' +
		'symlink included, is EEXIST rather than a redirect, and it is unlinked by the same ' +
		'name (unlink never follows its final component). It is the synchronous ' +
		'counterpart of the doors, in the one place that cannot await them.',
	'egress/gate.ts':
		"outside SITES_ROOT: the two sockets (0660, chgrp to the SITE's private group) it binds in a " +
		"site's egress directory `<agent socket dir>/egress/s<k>/` — ROOT-provisioned (tmpfiles.d, " +
		"root:<site group> 0770, refused otherwise), never created, chgrp'd or removed by the daemon, " +
		"never a path an agent run can write: the unit sees only its own site's, read-only, on /run/dedalo-egress. " +
		'Its `rm` of its own two socket names there (a killed run’s, before the bind; its own, at close).',
	'drivers/opencode.ts':
		'THE PROBE’S SCRATCH TREE: `<AGENT_STATE_ROOT>/probe/opencode-<random>` (mkdirPrivate, ' +
		'0700) — outside `SITES_ROOT` and every workspace, in no unit’s view (opencode runs no ' +
		'confined turn: refused under systemd_scope), deleted whole after the probe and its ' +
		'plugin marker after each leg. The brief a turn is handed is removed through the ' +
		'no-follow door (`removeFilePrivate`), not here.',
	'sites/workspace.ts':
		'THE WORKSPACE ITSELF, deleted whole: `<SITES_ROOT>/<slug>` (a create rolled back, or a ' +
		'delete) is a direct child of the trusted root, which no run can rename or plant in, and ' +
		'rm never follows a link it meets inside (each entry is lstat-ed, a link unlinked as a ' +
		'link); both run under the site’s own reservation (create / delete), refused while any ' +
		'run of the site is alive. And the served surface’s link and release store, PROVISIONED ' +
		'webspace under `WEBSPACE_BASE`, outside `SITES_ROOT`.',
});

/**
 * The exemptions whose stated reason is the SECOND kind — "refused by construction" rather
 * than "outside the tree". A claim like that is checkable, so it is checked: the file must
 * really contain the guard it names.
 */
const REFUSAL_BY_CONSTRUCTION: Readonly<Record<string, string>> = Object.freeze({
	'instance/roots.ts': 'O_EXCL',
	'context/agents_md.ts': 'symlink(',
});

/**
 * A call's DESTINATION KEY: `name(arg, …)` — its argument list as the transpiler prints it (an
 * object literal as `{…}`, a binding sentinel as the name it stands for), cut at the call's own
 * `)` or at the end of its line. A reference that is not a call (`const wf = writeFile`) keys as
 * its bare text. Exact strings, so an exemption names WHERE each call writes or reads.
 */
function callKey(call: FsCall): string {
	const text = call.text
		.replace(new RegExp(`${FS_NAMED}([\\w$]+?)__`, 'g'), '$1')
		.replaceAll(FS_NS, 'fs')
		.replaceAll(FS_BUN, 'Bun');
	const open = text.indexOf('(');
	if (open < 0) return text;
	const args: string[] = [];
	let depth = 0;
	let quote = '';
	let current = '';
	for (let i = open + 1; i < text.length; i++) {
		const ch = text[i] as string;
		if (quote) {
			current += ch;
			if (ch === '\\') current += text[++i] ?? '';
			else if (ch === quote) quote = '';
			continue;
		}
		if (ch === '"' || ch === "'" || ch === '`') quote = ch;
		else if (ch === '(' || ch === '[' || ch === '{') depth++;
		else if (ch === ')' || ch === ']' || ch === '}') {
			if (depth === 0) break;
			depth--;
		} else if (ch === ',' && depth === 0) {
			args.push(current.trim());
			current = '';
			continue;
		}
		current += ch;
	}
	if (current.trim()) args.push(current.trim());
	return `${text.slice(0, open)}(${args.map((arg) => (arg.startsWith('{') ? '{…}' : arg)).join(', ')})`;
}

/** The destination keys of a file's raw writes (`side: 'writes'`) or reads, sorted. */
function callKeys(code: string, side: 'writes' | 'reads'): string[] {
	return fsReach(code)[side].map(callKey).sort();
}

/**
 * EVERY EXEMPTED WRITE, KEYED BY DESTINATION — per file, the exact calls (`callKey`). The reason
 * above says why a file may write raw; this says WHAT it writes, so a second write added to an
 * exempt file (`writeFile(join(config.SITES_ROOT, slug, 'site.json'), …)` beside the one it
 * already has) is red — the per-FILE key alone passed it (round 6, the §1 "fifth call" shape).
 * Its keys are the exemption's keys, both ways.
 */
const RAW_FS_CALLS: Readonly<Record<string, readonly string[]>> = Object.freeze({
	'audit.ts': ['appendFile(auditPath(), serialized + `)', 'mkdir(config.AUDIT_DIR, {…})'],
	// THE ONE write: the declared-unconfined run's HOME (`AGENT_CONFINEMENT=none` only).
	'drivers/confinement.ts': [
		'rmSync(runHome, {…})',
		'mkdirSync(dirname(to), {…})',
		'mkdirSync(home, {…})',
		'mkdirSync(join(runHome, TURN_HOME_CONFIG), {…})',
		'mkdirSync(state, {…})',
		'mkdtempSync(join(base, "run."))',
		'renameSync(from, to)',
	],
	'provision/apply.ts': [
		'chmodSync(path, mode)',
		'chmodSync(temporary, mode)',
		'mkdirSync(path, {…})',
		// READ-ONLY opens (counted because `openSync` can create): the observer's no-follow reads
		// in an identity-writable turn HOME — `listRealDirectory` and `readRegularFileNoFollow`.
		'openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)',
		'openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)',
		// …and `readRegularFile` (hostIo().readFile): O_RDONLY|O_NONBLOCK, never a create — a FIFO
		// opens at once and is refused on the handle, never waited on (tests/provision_host_read_nonblocking R1).
		'openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)',
		'renameSync(from, to)',
		'renameSync(temporary, path)',
		'symlinkSync(target, path)',
		'unlinkSync(path)',
		'unlinkSync(temporary)',
		'writeFileSync(temporary, body, {…})',
	],
	'provision/remove.ts': ['unlinkSync(path)'],
	'provision/adopt.ts': ['renameSync(from, to)'],
	'context/agents_md.ts': ['rm(claudePath, {…})', 'symlink("AGENTS.md", claudePath)'],
	'sites/template.ts': ['cp(src, dest, {…})'],
	'build/promote.ts': [
		'copyFile(source, destination)',
		'mkdir(surface.storeDir, {…})',
		'mkdir(to, {…})',
		'rename(staging, target)',
		'rename(tmp, surface.linkPath)',
		'rm(path, {…})',
		'rm(staging, {…})',
		'rm(tmp, {…})',
		'symlink(relativeTarget, tmp)',
	],
	'sites/webspace.ts': ['unlinkSync(probe)', 'writeFileSync(probe, "", {…})'],
	'index.ts': [
		'chmodSync(config.LISTEN_SOCKET, 432)',
		'unlinkSync(config.LISTEN_SOCKET)',
		'unlinkSync(path)',
	],
	'instance/roots.ts': [
		'unlinkSync(probe)',
		'openSync(path, "a")',
		'openSync(probe, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 384)',
	],
	'egress/gate.ts': [
		'chmod(mcpPath, SOCKET_MODE)',
		'chmod(proxyPath, SOCKET_MODE)',
		'chown(path, uid, gid)',
		'rm(mcpPath, {…})',
		'rm(mcpPath, {…})',
		'rm(proxyPath, {…})',
		'rm(proxyPath, {…})',
	],
	'drivers/opencode.ts': ['rm(join(stateRoot, marker), {…})', 'rm(root, {…})'],
	'sites/workspace.ts': [
		'rm(dir, {…})',
		'rm(paths.linkPath, {…})',
		'rm(paths.storeDir, {…})',
		'rm(workspaceDir(slug), {…})',
	],
});

/**
 * The one module every daemon-side write into an agent-writable tree goes through. It is
 * excluded from the census because it IS the answer to it — and it is held to a stricter
 * rule of its own, three legs below.
 */
const THE_WRITER = 'util/shared_tree.ts';

/** Every file in the tree that mutates the filesystem by PATH rather than through the writer. */
function rawFsWriters(files: readonly string[], root: string): string[] {
	const found: string[] = [];
	for (const path of files) {
		const file = relative(root, path);
		if (file === THE_WRITER) continue;
		const reach = fsReach(readFileSync(path, 'utf8'));
		if (reach.writes.length > 0 || reach.unresolvable.length > 0) found.push(file);
	}
	return found.sort();
}

describe('a site workspace is CREATED shared, not created and hoped over', () => {
	const writers = rawFsWriters(siteBuilderDaemonFiles(), SOURCE_ROOT);

	test('every path-based filesystem mutation in the daemon is enumerated', () => {
		// A floor on the scan itself: the census is derived from the tree, and a walk that
		// found nothing would satisfy `unexplained === []` without reading a line.
		expect(siteBuilderDaemonFiles().length).toBeGreaterThan(40);
		expect(writers.length).toBeGreaterThan(4);
		const unexplained = writers.filter((file) => !(file in RAW_FS_EXEMPT));
		expect(unexplained).toEqual([]);
		for (const [file, reason] of Object.entries(RAW_FS_EXEMPT)) {
			// Shrink-only in both directions: an exemption whose file stopped writing raw would
			// silently cover the next unstated mode added to it.
			expect({ file, live: writers.includes(file), stated: reason.length > 60 }).toEqual({
				file,
				live: true,
				stated: true,
			});
		}
		// KEYED BY DESTINATION: each exempt file makes exactly its pinned calls — one more, one
		// fewer or one aimed elsewhere is a decision, not a covered call — and nothing no binding
		// follows (an exempt file's unresolvable fs reach would hide calls from the key).
		expect(Object.keys(RAW_FS_CALLS).sort()).toEqual(Object.keys(RAW_FS_EXEMPT).sort());
		for (const file of Object.keys(RAW_FS_EXEMPT)) {
			const code = readFileSync(join(SOURCE_ROOT, file), 'utf8');
			expect({
				file,
				writes: callKeys(code, 'writes'),
				unresolvable: fsReach(code).unresolvable,
			}).toEqual({
				file,
				writes: [...(RAW_FS_CALLS[file] ?? [])].sort(),
				unresolvable: [],
			});
		}
		// And an exemption that claims to be REFUSED BY CONSTRUCTION rather than out of the
		// tree has to still hold the construction it names — the one kind of reason a scan
		// can check, so it is checked rather than read.
		for (const [file, guard] of Object.entries(REFUSAL_BY_CONSTRUCTION)) {
			// CODE, not prose: a comment that still describes the guard is exactly what a
			// removed guard leaves behind, and it must not answer for it.
			const code = readFileSync(join(SOURCE_ROOT, file), 'utf8')
				.split('\n')
				.map((line) => line.replace(/^\s*(\/\/|\*|\/\*).*$/, ''))
				.join('\n');
			expect({ file, guard, present: code.includes(guard) }).toEqual({
				file,
				guard,
				present: true,
			});
		}
	});

	test('the modules that build a workspace use the shared helpers', () => {
		// The positive side of the same rule, read off the three files that make a site: the
		// directory, the manifest and the agent's brief.
		for (const [file, helper] of [
			// CLAIMED, not ensured: the create owns the workspace only if its mkdir made it (a
			// second create of the same slug scaffolded over — and rolled back — a finished site).
			['sites/workspace.ts', 'mkdirSharedFresh'],
			['sites/manifest.ts', 'writeFileSharedAtomic'],
			['context/agents_md.ts', 'writeFileShared'],
			['sites/template.ts', 'applySharedModes'],
			// And the daemon's own per-build state, which lives INSIDE the tree the agent
			// writes: a record or a log written with a plain writeFile is a path the turn can
			// replace with a link (see the O_NOFOLLOW leg below).
			['build/builder.ts', 'writeFilePrivate'],
			['build/builder.ts', 'appendFilePrivate'],
			// The build record and the session meta are ATOMIC (tmp + rename, through the same
			// O_NOFOLLOW/hard-link/owner door): both are polled by a concurrent reader while
			// they are rewritten, and a truncate-in-place answers that poll with an empty file.
			['build/builder.ts', 'writeFilePrivateAtomic'],
			['sessions/store.ts', 'writeFilePrivateAtomic'],
			// THE FOUR THE FIRST REPAIR MISSED, each measured writing through a planted link
			// as the daemon before it was routed here (the behaviour is in the package gate):
			// the exclusion rewritten on every commit, the key-carrying MCP config, and the
			// session transcript. (opencode's MCP config is GONE since LEAD-1c — the daemon's
			// configuration rides the child's environment; its PLANT probe writes its canaries
			// only into a daemon-private scratch tree, through the private helpers; and the one
			// file it writes for a turn is the BRIEF, `.builder/opencode-brief.md`, through the
			// fd-based agent-readable writer.) The brief itself is READ through the bounded,
			// link-refusing door, by the one reader every driver shares (`brief.ts`).
			['sites/git.ts', 'writeFileSharedAtomic'],
			['sites/git.ts', 'mkdirShared'],
			['drivers/claude_code.ts', 'writeFileAgentReadable'],
			['drivers/opencode.ts', 'mkdirPrivate'],
			['drivers/opencode.ts', 'writeFilePrivate'],
			['drivers/opencode.ts', 'writeFileAgentReadable'],
			['drivers/brief.ts', 'readFileSharedBounded'],
			['sessions/store.ts', 'appendFilePrivate'],
			['sessions/store.ts', 'mkdirPrivate'],
		] as const) {
			const source = readFileSync(join(SOURCE_ROOT, file), 'utf8');
			// The CALL, not the mention: an import that survives while the call is deleted is
			// exactly the shape a mode fix regresses in.
			const called = new RegExp(`(?<![.\\w])${helper}\\s*\\(`).test(source);
			expect({ file, calls: helper, called }).toEqual({ file, calls: helper, called: true });
		}
	});

	/*
	 * THE PLANT THE OPEN TREE MADE POSSIBLE.
	 *
	 * 2770 is what lets a confined turn work; it also lets the turn drop a symlink where the
	 * DAEMON writes. Every path here is built by `confinedPath`, which is LEXICAL — it proves
	 * a spelling and knows nothing about the inode — so a path-based `writeFile`/`chmod`/
	 * `mkdir` follows the link and does the write as the daemon: the instance's own 0600
	 * audit trail truncated, refilled with agent-authored text and re-moded 0660.
	 *
	 * The refusal is BEHAVIOURAL (planted links at site.json.tmp, AGENTS.md, .builder and a
	 * build record, in publication/site_builder/tests/agent_confinement.test.ts). What is
	 * structural, and asserted here, is that the module cannot regress to a path-based write:
	 * the mode is set on a DESCRIPTOR, and every descriptor is opened O_NOFOLLOW.
	 */
	/**
	 * The fs references of a module that mutate by PATH rather than through a handle — every
	 * write name of the census EXCEPT the two the module is built from: `open` (the ONE wrapper
	 * that adds O_NOFOLLOW, counted below) and `rename` (the atomic swap, which replaces a NAME
	 * and never writes through one). Scope-resolved, from the imports (round 5), not spelled.
	 */
	function pathBasedMutations(source: string): string[] {
		const reach = fsReach(source);
		return [
			...reach.unresolvable,
			...reach.writes
				.filter((call) => !['open', 'rename'].includes(call.name))
				// `mkdir(path)` with no mode and no recursion is the ONE allowed path call: it
				// creates a level that is then opened and moded through its descriptor, and it
				// fails EEXIST — it never follows anything.
				.filter((call) => !/^mkdir\s*\(\s*path\s*\)/.test(call.text))
				// `unlink(target)` is the ONE delete (`removeFilePrivate`): after the chain is walked
				// O_NOFOLLOW and proved the daemon's, and unlink(2) never follows its final component.
				.filter((call) => !/^unlink\s*\(\s*target\s*\)/.test(call.text))
				.map((call) => call.text.replace(/;\s*$/, '')),
		];
	}

	test('the shared writers open descriptors, never paths — O_NOFOLLOW is the door', () => {
		const source = readFileSync(join(SOURCE_ROOT, 'util/shared_tree.ts'), 'utf8');
		// Every open in the module goes through the one wrapper, and the wrapper sets it — ONE
		// reference to the fs `open`, scope-resolved (an alias or a namespace member counts).
		expect(source).toContain('flags | FS.O_NOFOLLOW');
		expect(fsReach(source).writes.filter((call) => call.name === 'open').length).toBe(1);
		// The mode is stated on the HANDLE (fchmod), so the thing moded is the thing written.
		expect(source).toContain('handle.chmod(');
		// And nothing in it mutates a path directly, which is what followed a planted link.
		expect(pathBasedMutations(source)).toEqual([]);
		// A floor, so a module reduced to a stub cannot pass the three assertions above.
		expect(source.length).toBeGreaterThan(4000);

		// AND THE OPEN CARRIES NO `O_TRUNC`. Truncation at open time happens before any
		// question can be asked of the thing opened, so a hard-linked victim would already be
		// empty by the time its link count was read. The file is opened, interrogated, and
		// only then emptied — which is why the module holds `truncate(0)` and not O_TRUNC.
		expect(source).not.toContain('FS.O_TRUNC');
		expect(source).toContain('stats.nlink > 1');
		expect(source).toContain('PlantedHardLinkError');
		expect(source).toContain('handle.truncate(0)');

		// AND THE INODE IS ASKED WHOSE IT IS. `O_NOFOLLOW` proves the NAME was not a link and
		// `nlink` proves there is no second name; neither says who owns it. The agent uid can
		// unlink a file in a 2770 workspace and author its own in its place, and a write into
		// that inode lands the museum's Publication API key in a file whose mode the agent
		// chose — the closing `fchmod` fails EPERM only AFTER the bytes are on disk.
		// ONE PER DOOR — the write door (through `assertOwnInode`) and the read door. A single
		// occurrence would mean one of the two stopped asking, which is how the read half of
		// this module was missing in the first place. The refusals themselves are behavioural
		// (`tests/agent_confinement.test.ts` moves `process.getuid`, since one suite cannot be
		// two uids).
		expect((source.match(/stats\.uid !== process\.getuid/g) ?? []).length).toBe(2);
		expect(source).toContain('ForeignOwnerError');

		// AND THE READ DIRECTION EXISTS AT ALL, which is what made the write-only version of
		// this module a half-repair: the same chain walk, refusing a link, a second name and
		// a foreign inode, so the daemon cannot be pointed at its own secrets and asked to
		// serve them back through the API.
		for (const door of ['readFileShared', 'readFilePrivate', 'readdirShared']) {
			expect({ door, exported: source.includes(`export async function ${door}(`) }).toEqual({
				door,
				exported: true,
			});
		}
		// The daemon's own polled state is written atomically: a truncate-then-write through
		// one descriptor lets a concurrent reader see an empty file, and a death inside that
		// window makes the emptiness permanent.
		expect(source).toContain('export async function writeFilePrivateAtomic(');
	});

	test('the path-based scanner really finds one — a planted regression is reported', () => {
		// The positive control for the leg above: without it, `pathBasedMutations` returning
		// [] would be satisfied by a regex that matches nothing.
		const I = "import { chmod, mkdir, writeFile } from 'node:fs/promises';\n";
		expect(pathBasedMutations(`${I}await chmod(target, mode);`)).toEqual(['chmod(target, mode)']);
		expect(pathBasedMutations(`${I}await writeFile(path, body);`)).toEqual([
			'writeFile(path, body)',
		]);
		// A namespace member and an alias are the same mutation (round 5).
		expect(
			pathBasedMutations(
				"import * as fsp from 'node:fs/promises';\nawait fsp.chmod(target, mode);",
			),
		).toEqual(['chmod(target, mode)']);
		expect(pathBasedMutations(`${I}const c = chmod;\nawait c(target, mode);`)).toEqual(['chmod']);
		// …and does not report the two shapes the module legitimately holds.
		expect(pathBasedMutations(`${I}await mkdir(path);`)).toEqual([]);
		expect(pathBasedMutations(`${I}// writeFile(path, body) is what this replaces.`)).toEqual([]);
		expect(pathBasedMutations(`${I}await handle.chmod(mode);`)).toEqual([]);
	});

	test('the scanner really finds a raw write — a planted one is reported', () => {
		const dir = mkdtempSync(join(tmpdir(), 'agent-confinement-fs-'));
		const planted: string[] = [];
		const sites = join(dir, 'sites');
		mkdirSync(sites);
		const P =
			"import { mkdir, mkdirSync, writeFileSync, createWriteStream, openSync, symlink } from 'node:fs';\n";
		plant(planted, join(sites, 'rogue.ts'), `${P}await mkdir(dir, { recursive: true });\n`);
		plant(planted, join(sites, 'quiet.ts'), 'await mkdirShared(dir);\n');
		plant(
			planted,
			join(sites, 'prose.ts'),
			`${P}// mkdir(dir) is what this replaces.\nexport const x = 'mkdir(';\n`,
		);
		// A member call on a HANDLE is a different thing (`io.mkdir`), told apart by its receiver —
		// an `io` that is not an fs binding — never by a lookbehind on the spelling.
		plant(planted, join(sites, 'member.ts'), `${P}await io.mkdir(dir);\n`);
		plant(planted, join(dir, 'top_level.ts'), `${P}await symlink(a, b);\n`);
		// AND THE SPELLING IS NOT A HIDING PLACE. Each of these passed the census green while
		// the `(` had to follow the bare name — the middle one is the exact planted probe
		// (`mkdirSync` + `writeFileSync` straight into a workspace) that was measured GREEN.
		plant(planted, join(sites, 'sync.ts'), `${P}mkdirSync(p, { recursive: true });\n`);
		plant(planted, join(sites, 'sync_write.ts'), `${P}writeFileSync(join(p, "y.txt"), body);\n`);
		plant(planted, join(sites, 'bun_write.ts'), 'await Bun.write(p, body);\n');
		plant(planted, join(sites, 'stream.ts'), `${P}createWriteStream(p).end(body);\n`);
		plant(planted, join(sites, 'open_sync.ts'), `${P}openSync(p, 'w');\n`);
		// ROUND 5: the lookbehind that kept `handle.chmod` out kept EVERY member call out — a
		// namespace's `fs.writeFile`, `fsp.rename` — and an alias never names the call at all.
		plant(
			planted,
			join(sites, 'ns_write.ts'),
			"import * as fsp from 'node:fs/promises';\nawait fsp.writeFile(p, x);\n",
		);
		plant(
			planted,
			join(sites, 'ns_rename.ts'),
			"import * as fsp from 'fs/promises';\nawait fsp.rename(a, b);\n",
		);
		plant(planted, join(sites, 'ns_sync.ts'), "import fs from 'node:fs';\nfs.renameSync(a, b);\n");
		plant(
			planted,
			join(sites, 'ns_promises.ts'),
			"import * as fs from 'fs';\nawait fs.promises.appendFile(p, x);\n",
		);
		plant(
			planted,
			join(sites, 'alias.ts'),
			"import { writeFile } from 'node:fs/promises';\nconst wf = writeFile;\nawait wf(p, x);\n",
		);
		plant(
			planted,
			join(sites, 'renamed.ts'),
			"import { writeFile as put } from 'node:fs/promises';\nawait put(p, x);\n",
		);
		// …and the shapes no binding follows are refused (reported) outright: a destructured
		// namespace, a dynamic import, a require, a re-export.
		plant(
			planted,
			join(sites, 'destructure.ts'),
			"import * as fs from 'node:fs';\nconst { writeFileSync: w } = fs;\nw(p, x);\n",
		);
		plant(
			planted,
			join(sites, 'dynamic.ts'),
			"const { writeFile } = await import('node:fs/promises');\nawait writeFile(p, x);\n",
		);
		plant(planted, join(sites, 'required.ts'), "require('fs').writeFileSync(p, x);\n");
		// …a CONSTANT-FOLDED specifier included (round 6, measured: writes [] and unresolvable []).
		plant(
			planted,
			join(sites, 'folded.ts'),
			"const { writeFile } = await import('node:' + 'fs/promises');\nawait writeFile(p, x);\n",
		);
		plant(
			planted,
			join(sites, 'reexport.ts'),
			"export { writeFile as put } from 'node:fs/promises';\n",
		);
		// An INERT member of a namespace is not a write.
		plant(
			planted,
			join(sites, 'ns_inert.ts'),
			"import * as fs from 'node:fs';\nexport const e = fs.existsSync(p) && fs.constants.O_RDONLY;\n",
		);
		// TOTAL over the tree, not over a directory list: the top-level file is reported too,
		// which is the half the first version of this census could not see.
		expect(rawFsWriters(planted, dir)).toEqual([
			'sites/alias.ts',
			'sites/bun_write.ts',
			'sites/destructure.ts',
			'sites/dynamic.ts',
			'sites/folded.ts',
			'sites/ns_promises.ts',
			'sites/ns_rename.ts',
			'sites/ns_sync.ts',
			'sites/ns_write.ts',
			'sites/open_sync.ts',
			'sites/reexport.ts',
			'sites/renamed.ts',
			'sites/required.ts',
			'sites/rogue.ts',
			'sites/stream.ts',
			'sites/sync.ts',
			'sites/sync_write.ts',
			'top_level.ts',
		]);
	});
});

/**
 * WHO STILL READS A PATH'S CONTENT — the census in the OTHER direction.
 *
 * A confused deputy has two directions, and the first repair closed one. `readFile` on a
 * lexical `confinedPath` follows a planted link exactly as `writeFile` did, and the daemon
 * then hands the bytes to the museum's own API. MEASURED on this package's own fixture, with
 * agent-uid actions only: `rm -rf .builder; mkdir -p .builder/builds; echo '{"id":"b1",…}' >
 * b1.json; ln -s <the daemon's service env> b1.log` made `getBuildLog` return
 * `SERVICE_TOKEN=…` and `GET /sites/<slug>/builds/b1` serve it as `{...record, log}` — which
 * is PUB-01's stated impact ("read the daemon's SERVICE_TOKEN / .env / the actor audit log")
 * reproducing THROUGH the fix for PUB-01. `getBuild`, `readManifest`, `replayEvents`,
 * `readMeta` and `listSessions` were the same shape.
 *
 * So the same rule, the same scope: every `.ts` file under `src/`, and an exemption states
 * that what it reads is outside `SITES_ROOT` and every workspace. DIRECTORY LISTINGS are not
 * in this regex and that is deliberate — a `readdir` yields NAMES, not content, and every
 * file a name leads to is opened through the doors above; `readdirShared` proves the chain
 * anyway, which is the stronger statement, and the honest limit is that a bare `readdir` of
 * a trusted root is not a finding here.
 */

const RAW_READ_EXEMPT: Readonly<Record<string, string>> = Object.freeze({
	'audit.ts':
		'The actor trail under `AUDIT_DIR` — a PROVISIONED root outside `SITES_ROOT`, 0700 ' +
		'with a 0600 file, named by no path an agent turn can write in.',
	'config.ts':
		'The instance `.env` and `$CREDENTIALS_DIRECTORY`, read at boot from roots the ' +
		'provisioner owns OUTSIDE `SITES_ROOT`. These are the very secrets the read plant was ' +
		'after; nothing here reads a path derived from a slug.',
	'instance/roots.ts':
		'The `.dedalo_site_instance` MARKER at the root of each provisioned root. `SITES_ROOT` ' +
		'is 2770, so this one is inside a directory the agent may write — and its content ' +
		'never leaves the process: it is compared to a constant instance name and the answer ' +
		'is boot or refuse-to-boot. A turn can already deny that by unlinking the marker.',
	'provision/apply.ts':
		'THE PROVISIONER, run as root before an agent uid exists, reading its own declaration ' +
		'and the root-owned paths it is about to create. Nothing it reads is under a workspace.',
	// provision/adopt.ts left this census (W3 L4): its one read, the instance marker, now goes
	// through apply.ts's never-blocking `readRegularFile` — a FIFO there is null, not a hung CLI.
	'provision/fleet.ts':
		'The fleet index of instance declarations under the provisioner config root, outside ' +
		'`SITES_ROOT` and root-owned.',
	'drivers/confinement.ts':
		"The TURN units' system gitconfig `<AGENT_STATE_ROOT>/turn.gitconfig` (round 6): ROOT's file " +
		'in the root 0755 agent state root — outside `SITES_ROOT` and every workspace, renamed by ' +
		'nobody but root — lstat-proved a regular non-link file of the provisioner, writable by ' +
		'nobody else, BEFORE it is read; its directives are compared, never served.',
	'drivers/egress_shim.ts':
		'NOT the daemon: the shim runs INSIDE the unit root rendered for the site, as the ' +
		"site's identity. Its one read is `/proc/self/cgroup` — its OWN unit's name, which it " +
		'says in its hello frame — and nothing it reads is served to anyone or carries a ' +
		'privilege the unit did not already have.',
	'drivers/opencode.ts':
		"opencode's turn DATABASE (`<AGENT_STATE_ROOT>/unconfined/turn/state/data/opencode/opencode.db`), " +
		'opened by bun:sqlite READ-ONLY at each admission to prove it holds no console account — under ' +
		'the agent state root, outside `SITES_ROOT` and every workspace; lstat-refused unless a regular ' +
		'file. Only a row COUNT leaves it, never served; and an opencode turn runs only declared `none`, ' +
		'where the turn is this daemon’s own uid (a link it planted reaches nothing the daemon could not read).',
	'sites/site_table.ts':
		"The provisioner's `sites.json` under the config directory (root:root 0644) — outside " +
		'`SITES_ROOT`, and the ONE thing that says where a site may be published.',
	'sites/template.ts':
		'The TEMPLATE catalogue under `TEMPLATES_DIR` — a repo-owned, read-only tree outside ' +
		'`SITES_ROOT`. The one read INSIDE a workspace (the placeholder rewrite) goes through ' +
		'`readFileShared`, which is the required-call leg below.',
});

/**
 * EVERY EXEMPTED READ, KEYED BY SOURCE — the read side of `RAW_FS_CALLS`: a second read in an
 * exempt file (`readFile(join(ws, '.builder/builds/b1.log'))` beside `sites/template.ts`'s
 * catalogue read — the measured confused-deputy plant) is red, not covered by the file's key.
 */
const RAW_READ_CALLS: Readonly<Record<string, readonly string[]>> = Object.freeze({
	'audit.ts': ['readFile(path, "utf8")'],
	'config.ts': [
		'readFileSync(apiKeyFile, "utf8")',
		'readFileSync(envFilePath, "utf8")',
		'readFileSync(path, "utf8")',
	],
	'instance/roots.ts': ['readFileSync(marker, "utf8")'],
	'provision/apply.ts': [
		'readFileSync("/etc/login.defs", "utf8")',
		// The observer's artifact read (S3-HOME): from the HANDLE `readRegularFileNoFollow` opened
		// O_NOFOLLOW|O_NONBLOCK and fstat-proved a one-name regular file — never the path again.
		'readFileSync(fd, "utf8")',
		// hostIo().readFile (`readRegularFile`): from the HANDLE opened O_NONBLOCK and fstat-proved
		// regular — a FIFO planted at a name `remove`/`adopt` reads is null, never a hung root CLI.
		'readFileSync(fd, "utf8")',
		'readFileSync(path, "utf8")',
	],
	'provision/fleet.ts': ['readFileSync(manifestPath, "utf8")'],
	// THE ONE read: root's turn gitconfig, lstat-proved first (`turnGitconfigProblem`).
	'drivers/confinement.ts': ['readFileSync(path, "utf8")'],
	// THE ONE read: its own unit's cgroup, said in its hello frame.
	'drivers/egress_shim.ts': ['readFileSync("/proc/self/cgroup", "utf8")'],
	// THE ONE read: the turn database, read-only, for a console-account COUNT (bun:sqlite).
	'drivers/opencode.ts': ['Database(path, {…})'],
	'sites/site_table.ts': ['readFileSync(path, "utf8")'],
	'sites/template.ts': ['readFile(metaPath, "utf8")'],
});

/** Every file that reads a path's CONTENT rather than reading through the shared door. */
function rawFsReaders(files: readonly string[], root: string): string[] {
	const found: string[] = [];
	for (const path of files) {
		const file = relative(root, path);
		if (file === THE_WRITER) continue;
		const reach = fsReach(readFileSync(path, 'utf8'));
		if (reach.reads.length > 0 || reach.unresolvable.length > 0) found.push(file);
	}
	return found.sort();
}

describe('what the daemon reads back out of an agent-writable tree is proved, not trusted', () => {
	const readers = rawFsReaders(siteBuilderDaemonFiles(), SOURCE_ROOT);

	test('every path-based content read in the daemon is enumerated', () => {
		expect(siteBuilderDaemonFiles().length).toBeGreaterThan(40);
		expect(readers.length).toBeGreaterThan(4);
		const unexplained = readers.filter((file) => !(file in RAW_READ_EXEMPT));
		expect(unexplained).toEqual([]);
		for (const [file, reason] of Object.entries(RAW_READ_EXEMPT)) {
			expect({ file, live: readers.includes(file), stated: reason.length > 60 }).toEqual({
				file,
				live: true,
				stated: true,
			});
		}
		// KEYED BY SOURCE, both ways — as the mutation census.
		expect(Object.keys(RAW_READ_CALLS).sort()).toEqual(Object.keys(RAW_READ_EXEMPT).sort());
		for (const file of Object.keys(RAW_READ_EXEMPT)) {
			const code = readFileSync(join(SOURCE_ROOT, file), 'utf8');
			expect({
				file,
				reads: callKeys(code, 'reads'),
				unresolvable: fsReach(code).unresolvable,
			}).toEqual({
				file,
				reads: [...(RAW_READ_CALLS[file] ?? [])].sort(),
				unresolvable: [],
			});
		}
	});

	test('a DELETE is a write: rm / rmdir / unlink (and each Sync twin), by any binding shape, are counted', () => {
		// A recursive rm aimed through a planted directory link deletes wherever the daemon can
		// write; the census that left deletes out passed one green. Each spelling a module can use:
		const fixture = [
			"import { rmSync, unlinkSync as drop } from 'node:fs';",
			"import { rm, rmdir } from 'node:fs/promises';",
			"import * as fs from 'node:fs';",
			"export const a = (ws: string) => rmSync(join(ws, '.builder'), { recursive: true, force: true });",
			"export const b = (ws: string) => drop(join(ws, '.builder/mcp.json'));",
			"export const c = (ws: string) => rm(join(ws, 'x'), { recursive: true });",
			"export const d = (ws: string) => rmdir(join(ws, 'y'));",
			"export const e = (ws: string) => fs.unlinkSync(join(ws, 'z'));",
			"export const f = (ws: string) => fs.rmdirSync(join(ws, 'w'));",
		].join('\n');
		expect(callKeys(fixture, 'writes')).toEqual(
			[
				'rmSync(join(ws, ".builder"), {…})',
				'unlinkSync(join(ws, ".builder/mcp.json"))',
				'rm(join(ws, "x"), {…})',
				'rmdir(join(ws, "y"))',
				'unlinkSync(join(ws, "z"))',
				'rmdirSync(join(ws, "w"))',
			].sort(),
		);
	});

	test('a SECOND call in an exempt file is red — the key is the destination, not the file (round 6)', () => {
		// The measured plants, appended to the real files: each one leaves the file exempt by
		// NAME, so only the destination key can see it.
		const confinement = readFileSync(join(SOURCE_ROOT, 'drivers/confinement.ts'), 'utf8');
		const template = readFileSync(join(SOURCE_ROOT, 'sites/template.ts'), 'utf8');
		const plantedWrite = callKeys(
			`${confinement}\nexport const plant = (slug: string) => mkdirSync(join(config.SITES_ROOT, slug, '.builder'), { recursive: true });\n`,
			'writes',
		);
		const plantedRead = callKeys(
			`${template}\nexport const plant = (ws: string) => readFile(join(ws, '.builder/builds/b1.log'), 'utf8');\n`,
			'reads',
		);
		// …only when the planted name is an fs binding the file already imports: prove it is.
		expect(plantedWrite.length).toBe((RAW_FS_CALLS['drivers/confinement.ts'] ?? []).length + 1);
		expect(plantedRead.length).toBe((RAW_READ_CALLS['sites/template.ts'] ?? []).length + 1);
		expect(plantedWrite).not.toEqual([...(RAW_FS_CALLS['drivers/confinement.ts'] ?? [])].sort());
		expect(plantedRead).not.toEqual([...(RAW_READ_CALLS['sites/template.ts'] ?? [])].sort());
		// …and the SAME count aimed elsewhere is red too (the key is the argument list).
		expect(
			callKey({
				name: 'mkdirSync',
				text: 'mkdirSync(join(config.SITES_ROOT, slug), { recursive: true });',
			}),
		).toBe('mkdirSync(join(config.SITES_ROOT, slug), {…})');
		expect(
			callKey({ name: 'mkdirSync', text: 'mkdirSync(home, { recursive: true, mode: 448 });' }),
		).toBe('mkdirSync(home, {…})');
	});

	test('the doors that serve a tree back to the museum read through the shared helpers', () => {
		// Each of these was measured serving a planted link's target before it was routed
		// here; the behaviour is `publication/site_builder/tests/agent_confinement.test.ts`.
		for (const [file, helper] of [
			['build/builder.ts', 'readFilePrivate'], // the build record AND the build log
			['build/builder.ts', 'readdirShared'], // latestBuild's listing of `.builder/builds`
			['sessions/store.ts', 'readFilePrivate'], // the transcript and the meta sidecar
			['sessions/store.ts', 'readdirShared'], // the session index
			['sites/manifest.ts', 'readFileShared'], // site.json, which the agent may rewrite
			['sites/template.ts', 'readFileShared'], // the placeholder rewrite, inside the workspace
		] as const) {
			const source = readFileSync(join(SOURCE_ROOT, file), 'utf8');
			const called = new RegExp(`(?<![.\\w])${helper}\\s*\\(`).test(source);
			expect({ file, calls: helper, called }).toEqual({ file, calls: helper, called: true });
		}
	});

	test('the read scanner really finds one — a planted read is reported', () => {
		const dir = mkdtempSync(join(tmpdir(), 'agent-confinement-read-'));
		const planted: string[] = [];
		const sites = join(dir, 'sites');
		mkdirSync(sites);
		const R =
			"import { readFile } from 'node:fs/promises';\nimport { readFileSync } from 'node:fs';\n";
		plant(planted, join(sites, 'rogue.ts'), `${R}const t = await readFile(p, 'utf8');\n`);
		plant(planted, join(sites, 'sync.ts'), `${R}const t = readFileSync(p, 'utf8');\n`);
		plant(planted, join(sites, 'bun.ts'), 'const t = await Bun.file(p).text();\n');
		plant(planted, join(sites, 'quiet.ts'), 'const t = await readFilePrivate(root, rel);\n');
		plant(
			planted,
			join(sites, 'prose.ts'),
			`${R}// readFile(p) is what this replaces.\nexport const x = 'readFile(';\n`,
		);
		// A HANDLE's read is told apart by its receiver (not an fs binding)…
		plant(planted, join(sites, 'member.ts'), `${R}const t = await handle.readFile(p);\n`);
		plant(planted, join(dir, 'top_level.ts'), `${R}const t = readFileSync(p, 'utf8');\n`);
		// …while a NAMESPACE's read, an aliased read and a stream are reads (round 5: the
		// lookbehind passed the first two green — the exact link-following read of a workspace
		// path that serves SERVICE_TOKEN back).
		plant(
			planted,
			join(sites, 'ns_read.ts'),
			"import * as fs from 'node:fs/promises';\nconst t = await fs.readFile(join(ws, 'site.json'));\n",
		);
		plant(planted, join(sites, 'alias.ts'), `${R}const rf = readFile;\nconst t = await rf(p);\n`);
		plant(
			planted,
			join(sites, 'stream.ts'),
			"import { createReadStream as crs } from 'fs';\ncrs(p);\n",
		);
		// …and a CONSTANT-FOLDED specifier (round 6, measured: reads [] and unresolvable []).
		plant(
			planted,
			join(sites, 'folded.ts'),
			"const { readFile } = await import('node:' + 'fs/promises');\nconst t = await readFile(p);\n",
		);
		expect(rawFsReaders(planted, dir)).toEqual([
			'sites/alias.ts',
			'sites/bun.ts',
			'sites/folded.ts',
			'sites/ns_read.ts',
			'sites/rogue.ts',
			'sites/stream.ts',
			'sites/sync.ts',
			'top_level.ts',
		]);
	});
});

/* ────────────────────────────────────────────────────────────────────────────────────
 * §8 The egress
 * ──────────────────────────────────────────────────────────────────────────────────── */

/**
 * WHAT A CONFINED RUN MAY REACH, asked of the unit properties rather than read off them.
 *
 * LEAD-1: the unit said `IPAddressAllow=any localhost` and then denied loopback and the
 * private ranges, under a header claiming "longest-prefix wins". systemd's filter is
 * ALLOW-WINS: an address matching an allow entry is granted whatever the deny list says,
 * so `any` granted Postgres, the engine, the LAN and the metadata service to text a
 * language model wrote. The repair is not a better list — it is a PRIVATE NETWORK
 * NAMESPACE per run, `/run` masked, and one per-run socket directory bound back in, through
 * which the daemon's egress gate speaks hostnames only.
 *
 * The leaf (`drivers/network_profile.ts`) is the ONE producer of every network property a
 * unit receives, and it is config-free so this gate can import it; the package gate
 * (`tests/agent_confinement.test.ts`) proves the real `confineTurn`/`runConfined` render
 * EXACTLY its list. It is imported dynamically so that its absence is this section's red,
 * not the whole file's.
 */

const LEAF = join(PACKAGE, 'src/drivers/network_profile.ts');
const SHIM = join(PACKAGE, 'src/drivers/egress_shim.ts');
const CLASSIFIER = join(PACKAGE, 'src/egress/public_address.ts');

interface NetworkLeaf {
	DOORS: readonly string[];
	DOOR_PROFILE: Readonly<Record<string, { proxy: boolean; mcp: boolean }>>;
	PROXY_PORT: number;
	MCP_PORT: number;
	unitNetworkProperties(
		door: string,
		opts: { egressDir?: string; pidNamespace: boolean },
	): string[];
	egressPlanFor(
		door: string,
		facts: {
			driver?: string;
			providerHosts: string[];
			registryHosts: string[];
		},
	): { hosts: string[]; mcp: boolean };
	planProblems(
		door: string,
		facts: {
			driver?: string;
			providerHosts: string[];
			registryHosts: string[];
		},
	): string[];
	childEgressEnv(door: string): Record<string, string>;
	egressDirFor(runtimeDir: string, k: number): string;
}

async function leaf(): Promise<NetworkLeaf> {
	return (await import(LEAF)) as NetworkLeaf;
}

/** The host a provisioned museum runs on — the runtime dir is the rendered one. */
const RUNTIME = '/run/dedalo-sites/test';
/** Where root renders the per-(site, door) sockets (AGENT_SOCKET_DIR). */
const AGENT_SOCKETS = '/run/dedalo-sites-agents/test';
/** The site under test, and ANOTHER site of the same museum. */
const K = 1;
const SIBLING_K = 2;

/**
 * HOW THE ROWS BELOW ASK, at the two releases LEAD-1b renders for:
 *
 *   255 — no PID namespace. The run is asked ALONE, and that is the claim, not a shortcut:
 *         nothing of the same uid runs beside it — every other site is another identity
 *         (ProtectProc=invisible hides other uids' /proc) and a site's own doors never
 *         overlap (Conflicts=, co-scheduling proved on the rendered files by G6).
 *   257 — PrivatePIDs=yes, the EXTRA layer, asked the worst way: beside a concurrent run of
 *         ANOTHER site under the SAME uid (the pre-LEAD-1b one-uid shape), whose mount view is
 *         one `/proc/<pid>/root` away unless the asking unit has its own PID namespace.
 */
const ALONE = Object.freeze({ netnsHonoured: true as const });
function besideSameUid(net: NetworkLeaf): { netnsHonoured: true; concurrent: string[][] } {
	const sibling = net.unitNetworkProperties('turn', {
		egressDir: net.egressDirFor(AGENT_SOCKETS, SIBLING_K),
		pidNamespace: true,
	});
	return { netnsHonoured: true, concurrent: [sibling] };
}
const RELEASES = Object.freeze([
	{ version: 255, pidNamespace: false, options: (_net: NetworkLeaf) => ALONE },
	{ version: 257, pidNamespace: true, options: besideSameUid },
] as const);

/**
 * WHAT NO DOOR MAY REACH. Host loopback (Postgres, the DNS stub, IPv6 loopback), the LAN,
 * the cloud metadata service, the host's own public address, the public internet directly
 * (egress is the gate's job, by hostname), the engine's and the databases' sockets, this
 * daemon's own socket and per-turn secret files, the docker socket, and an ABSTRACT unix
 * socket (which no mount mask can hide — only a network namespace does).
 */
const FORBIDDEN: readonly Destination[] = Object.freeze([
	{ kind: 'inet', ip: '127.0.0.1', port: 5432 },
	{ kind: 'inet', ip: '127.0.0.1', port: 3306 },
	{ kind: 'inet', ip: '127.0.0.53', port: 53 },
	{ kind: 'inet', ip: '::1', port: 5432 },
	{ kind: 'inet', ip: '10.0.0.5', port: 22 },
	{ kind: 'inet', ip: '192.168.1.1', port: 80 },
	{ kind: 'inet', ip: '169.254.169.254', port: 80 },
	{ kind: 'inet', ip: '203.0.113.7', port: 22 },
	{ kind: 'inet', ip: '1.1.1.1', port: 443 },
	{ kind: 'inet', ip: '2606:4700:4700::1111', port: 443 },
	{ kind: 'unix', path: '/run/postgresql/.s.PGSQL.5432' },
	{ kind: 'unix', path: '/run/dedalo/dedalo_ts.sock' },
	{ kind: 'unix', path: `${RUNTIME}/daemon.sock` },
	// Every site's CONTROL sockets — its own included: a run that could connect to one could
	// launch a run (of any door, of any site).
	{ kind: 'unix', path: `${AGENT_SOCKETS}/s${K}-turn.sock` },
	{ kind: 'unix', path: `${AGENT_SOCKETS}/s${SIBLING_K}-build.sock` },
	{ kind: 'unix', path: '/var/run/docker.sock' },
	{ kind: 'unix', path: '/run/mysqld/mysqld.sock' },
	// RHEL/Fedora MariaDB's DEFAULT socket: outside /run, /tmp and /home, mode 0777 — the
	// path-socket case the /run mask alone does not cover (a netns does not help: path
	// sockets ignore network namespaces).
	{ kind: 'unix', path: '/var/lib/mysql/mysql.sock' },
	{ kind: 'unix', path: '/var/lib/postgresql/.s.PGSQL.5432' },
	// ANOTHER site's egress sockets. A run that could open another site's mcp.sock would
	// speak to the Publication API with the daemon's key, as that site. TWO routes, both
	// asked: a view of the whole egress/ directory (the bind), and a concurrent run's own
	// mount view through /proc/<pid>/root (closed by the per-site uid at 255, and by the PID
	// namespace too at 257).
	{ kind: 'unix', path: `${AGENT_SOCKETS}/egress/s${SIBLING_K}/proxy.sock` },
	{ kind: 'unix', path: `${AGENT_SOCKETS}/egress/s${SIBLING_K}/mcp.sock` },
	// The host's /dev/shm (tmpfs, mode 1777). PrivateDevices= builds a private /dev but binds
	// the HOST's /dev/shm back into it, and path sockets ignore network namespaces: without a
	// per-unit mask it is one world-writable directory every door of every museum shares.
	{ kind: 'unix', path: '/dev/shm/x.sock' },
	// A SysV IPC key (or POSIX message queue) in the HOST's IPC namespace — shared by every
	// unit without PrivateIPC=yes, any museum's, and the host: a rendezvous no path mask sees.
	{ kind: 'ipc', name: 'sysv:0x5a5a0001' },
	{ kind: 'abstract', name: 'lp' },
]);

/** The pre-fix unit shape, kept as the evaluator's control row. */
const HEAD_SHAPE: readonly string[] = Object.freeze([
	'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6',
	'IPAddressAllow=any localhost',
	'IPAddressDeny=localhost link-local multicast 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 fc00::/7 fe80::/10',
]);

function doorProps(
	net: NetworkLeaf,
	door: string,
	pidNamespace = false,
): { props: string[]; egressDir: string | null } {
	const egressDir = net.DOOR_PROFILE[door]?.proxy ? net.egressDirFor(AGENT_SOCKETS, K) : null;
	const props = net.unitNetworkProperties(
		door,
		egressDir ? { egressDir, pidNamespace } : { pidNamespace },
	);
	return { props, egressDir };
}

describe('§8 a confined run reaches its own egress door and nothing else', () => {
	test('control: the evaluator is ALLOW-WINS — the pre-fix shape reaches host loopback', () => {
		// If this row ever reads "blocked", the model is the longest-prefix misreading and every
		// row below it would certify a wide-open unit.
		for (const dest of [
			{ kind: 'inet', ip: '127.0.0.1', port: 5432 },
			{ kind: 'inet', ip: '10.0.0.5', port: 22 },
			{ kind: 'inet', ip: '169.254.169.254', port: 80 },
			{ kind: 'unix', path: '/run/postgresql/.s.PGSQL.5432' },
			{ kind: 'abstract', name: 'lp' },
		] as const) {
			expect({
				dest: describeDestination(dest),
				reached: reach(HEAD_SHAPE, dest, { netnsHonoured: true }),
			}).toEqual({
				dest: describeDestination(dest),
				reached: true,
			});
		}
	});

	test('the doors are exactly turn, build and git, each with a stated profile', async () => {
		const net = await leaf();
		expect([...net.DOORS].sort()).toEqual(['build', 'git', 'turn']);
		expect(Object.keys(net.DOOR_PROFILE).sort()).toEqual([...net.DOORS].sort());
		expect(net.DOOR_PROFILE.turn).toEqual({ proxy: true, mcp: true });
		expect(net.DOOR_PROFILE.build).toEqual({ proxy: true, mcp: false });
		expect(net.DOOR_PROFILE.git).toEqual({ proxy: false, mcp: false });
		expect(net.PROXY_PORT).not.toBe(net.MCP_PORT);
	});

	test('every door, at 255 and at 257: nothing forbidden is reachable, with the netns in effect', async () => {
		const net = await leaf();
		for (const release of RELEASES) {
			for (const door of net.DOORS) {
				const { props } = doorProps(net, door, release.pidNamespace);
				const reached = FORBIDDEN.filter((dest) => reach(props, dest, release.options(net))).map(
					describeDestination,
				);
				expect({ version: release.version, door, reached }).toEqual({
					version: release.version,
					door,
					reached: [],
				});
			}
		}
	});

	test('every door: its own sockets, and only the ones its profile names, are reachable', async () => {
		const net = await leaf();
		for (const door of net.DOORS) {
			const { props, egressDir } = doorProps(net, door);
			const profile = net.DOOR_PROFILE[door] as { proxy: boolean; mcp: boolean };
			const sockets = egressDir
				? [join(egressDir, 'proxy.sock'), ...(profile.mcp ? [join(egressDir, 'mcp.sock')] : [])]
				: [];
			const reachable = sockets.filter((path) =>
				reach(props, { kind: 'unix', path }, { netnsHonoured: true }),
			);
			expect({ door, reachable }).toEqual({ door, reachable: sockets });
			// The shim's own loopback listeners, inside the unit's namespace — the BPF backstop
			// (IPAddressDeny=any) must not have closed the one door it forwards to.
			if (profile.proxy) {
				const lo = { kind: 'inet', ip: '127.0.0.1', port: net.PROXY_PORT, scope: 'unit' } as const;
				expect({ door, loopback: reach(props, lo, { netnsHonoured: true }) }).toEqual({
					door,
					loopback: true,
				});
			}
		}
		// Git talks to nothing: no bind, no proxy, no inet family (the per-door family rows
		// below hold AF_UNIX + the AF_NETLINK the shim's interface enumeration needs).
		const git = doorProps(net, 'git');
		expect(git.egressDir).toBeNull();
		expect(git.props.some((p) => p.startsWith('BindPaths='))).toBe(false);
		expect(
			reach(
				git.props,
				{ kind: 'inet', ip: '127.0.0.1', port: net.PROXY_PORT, scope: 'unit' },
				{ netnsHonoured: true },
			),
		).toBe(false);
	});

	test('every door: the backstop filter denies by default, and allows nothing but the unit loopback', async () => {
		const net = await leaf();
		for (const door of net.DOORS) {
			const { props } = doorProps(net, door);
			const map = parseProperties(props);
			expect({ door, deny: map.get('IPAddressDeny') }).toEqual({ door, deny: ['any'] });
			const allow = (map.get('IPAddressAllow') ?? []).join(' ').split(/\s+/).filter(Boolean);
			expect({ door, extraAllow: allow.filter((token) => token !== 'localhost') }).toEqual({
				door,
				extraAllow: [],
			});
			expect({ door, netns: map.get('PrivateNetwork') }).toEqual({ door, netns: ['yes'] });
		}
	});

	test('every door: its socket families, as outcomes — git has no inet family, and every door can enumerate its interfaces', async () => {
		// The families are what decides whether a door can open a TCP socket at all (git must
		// not) and whether the shim's first act works: getifaddrs(3) is an AF_NETLINK query,
		// and a unit denied it sees NO interface — which the shim refuses (exit 78) on every
		// run. Dropping AF_NETLINK from a door is a silent total outage, not a hardening.
		const net = await leaf();
		for (const door of net.DOORS) {
			const { props } = doorProps(net, door);
			const profile = net.DOOR_PROFILE[door] as { proxy: boolean; mcp: boolean };
			expect({ door, enumerate: canEnumerateInterfaces(props) }).toEqual({ door, enumerate: true });
			expect({ door, unix: allowsFamily(props, 'AF_UNIX') }).toEqual({ door, unix: true });
			// A proxy door needs inet for the shim's loopback listeners; git needs none.
			expect({
				door,
				inet: allowsFamily(props, 'AF_INET'),
				inet6: allowsFamily(props, 'AF_INET6'),
			}).toEqual({ door, inet: profile.proxy, inet6: profile.proxy });
		}
		// Control: the evaluator really denies an unlisted family.
		expect(canEnumerateInterfaces(['RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6'])).toBe(
			false,
		);
		expect(allowsFamily(['RestrictAddressFamilies=AF_UNIX AF_NETLINK'], 'AF_INET')).toBe(false);
		// Control: repeated assignments MERGE, as systemd merges them — an extra allow-list in
		// front of git's own is inet for git, however the last line reads.
		const merged = (lines: string[], family: 'AF_UNIX' | 'AF_INET') =>
			allowsFamily(
				lines.map((line) => `RestrictAddressFamilies=${line}`),
				family,
			);
		expect(merged(['AF_INET', 'AF_UNIX'], 'AF_INET')).toBe(true);
		expect(merged(['AF_UNIX AF_INET', '~AF_INET'], 'AF_INET')).toBe(false);
		expect(merged(['~AF_INET', 'AF_INET'], 'AF_INET')).toBe(true);
		expect(merged(['~AF_INET', 'AF_INET'], 'AF_UNIX')).toBe(true);
		expect(merged(['AF_UNIX', ''], 'AF_INET')).toBe(true);
		expect(merged(['none'], 'AF_UNIX')).toBe(false);
		const git = doorProps(net, 'git').props;
		expect(allowsFamily(['RestrictAddressFamilies=AF_INET AF_INET6', ...git], 'AF_INET')).toBe(
			true,
		);
	});

	test('a host that ignores PrivateNetwork= is REFUSED by the shim, because the filter alone lets loopback in', async () => {
		const net = await leaf();
		// Without the namespace the `localhost` allow is the HOST's loopback — the reason the
		// shim, not the filter, is what makes the backstop safe.
		const { props } = doorProps(net, 'turn');
		expect(
			reach(props, { kind: 'inet', ip: '127.0.0.1', port: 5432 }, { netnsHonoured: false }),
		).toBe(true);
		const shim = (await import(SHIM)) as {
			checkNamespace(
				interfaces: Record<string, Array<{ internal: boolean; address: string; family: string }>>,
			): boolean;
		};
		const lo = [{ internal: true, address: '127.0.0.1', family: 'IPv4' }];
		expect(
			shim.checkNamespace({ lo, eth0: [{ internal: false, address: '10.0.0.5', family: 'IPv4' }] }),
		).toBe(false);
		expect(shim.checkNamespace({ lo })).toBe(true);
	});

	test('a proxy door refuses to render without its egress dir, and git refuses one', async () => {
		const net = await leaf();
		expect(() => net.unitNetworkProperties('turn', { pidNamespace: false })).toThrow();
		expect(() => net.unitNetworkProperties('build', { pidNamespace: false })).toThrow();
		expect(() =>
			net.unitNetworkProperties('git', {
				egressDir: `${AGENT_SOCKETS}/egress/s1`,
				pidNamespace: false,
			}),
		).toThrow();
		// Whether PID 1 renders a PID namespace is STATED, never defaulted.
		expect(() =>
			net.unitNetworkProperties('git', {} as unknown as { pidNamespace: boolean }),
		).toThrow();
	});

	test('every socket path fits sun_path for the longest legal instance and the highest ordinal', async () => {
		// A unix socket path is at most 107 bytes on Linux (108 with the NUL). A site's egress
		// dir or control socket that overflows it makes EVERY run of that site fail — so it is
		// measured on the longest instance name the grammar allows and the last ordinal.
		const net = await leaf();
		const instance = `a${'b'.repeat(MAX_INSTANCE_LENGTH - 1)}`;
		const layout = derive(manifestFrom({ instance }));
		const dir = net.egressDirFor(layout.agentSocketDir, 999);
		for (const path of [
			join(dir, 'proxy.sock'),
			join(dir, 'mcp.sock'),
			...['turn', 'build', 'git'].map((door) =>
				agentSocketPath(layout.agentSocketDir, 999, door as 'turn'),
			),
		]) {
			expect({ path, fits: Buffer.byteLength(path) <= 107 }).toEqual({ path, fits: true });
		}
		// …and it is root's tree (the agent socket dir), never the daemon's runtime directory,
		// which its own uid could re-point under a bind PID 1 resolves as root.
		expect(dir).toBe(`${layout.agentSocketDir}/egress/s999`);
		expect(dir.startsWith(`${layout.runtimeDir}/`)).toBe(false);
	});

	test('egress plans are hostname-only, and git has none', async () => {
		const net = await leaf();
		const facts = { providerHosts: [] as string[], registryHosts: [] as string[] };
		expect(net.egressPlanFor('git', { ...facts, driver: 'claude_code' }).hosts).toEqual([]);
		expect(net.egressPlanFor('turn', { ...facts, driver: 'claude_code' }).hosts).toEqual([
			'api.anthropic.com',
		]);
		expect(net.egressPlanFor('build', facts).hosts).toEqual(['registry.npmjs.org']);
		// NP25: MEMBERSHIP with every other fact non-empty — a host that names provider hosts (for
		// its opencode sites) and registries gives each door exactly its own, nothing appended.
		const everything = {
			providerHosts: ['api.provider.example'],
			registryHosts: ['registry.example.com'],
		};
		expect(net.egressPlanFor('turn', { ...everything, driver: 'claude_code' }).hosts).toEqual([
			'api.anthropic.com',
		]);
		expect(net.egressPlanFor('turn', { ...everything, driver: 'opencode' }).hosts).toEqual([
			'api.provider.example',
		]);
		for (const driver of ['claude_code', 'opencode']) {
			expect({
				driver,
				build: net.egressPlanFor('build', { ...everything, driver }).hosts,
			}).toEqual({
				driver,
				build: ['registry.example.com'],
			});
			expect({ driver, git: net.egressPlanFor('git', { ...everything, driver }).hosts }).toEqual({
				driver,
				git: [],
			});
		}
		expect(net.egressPlanFor('turn', { ...facts, driver: 'claude_code' }).mcp).toBe(true);
		expect(net.egressPlanFor('build', facts).mcp).toBe(false);
		// An opencode/pi turn with no declared provider has no host to reach — a named problem.
		const none = net.planProblems('turn', { ...facts, driver: 'opencode' });
		expect(none.join(' ')).toContain('AGENT_PROVIDER_HOSTS');
		// The grammar: no IP literal, no loopback name, no wildcard, no single label — each
		// refused with a problem and absent from the plan.
		for (const bad of [
			'10.0.0.5',
			'127.0.0.1',
			'[::1]',
			'::1',
			'localhost',
			'any',
			'*',
			'intranet',
			'x.localhost',
		]) {
			const hostile = { ...facts, driver: 'opencode', providerHosts: [bad] };
			expect({ bad, refused: net.planProblems('turn', hostile).length > 0 }).toEqual({
				bad,
				refused: true,
			});
			let hosts: string[] = [];
			try {
				hosts = net.egressPlanFor('turn', hostile).hosts;
			} catch {
				hosts = [];
			}
			expect({ bad, planned: hosts.includes(bad) }).toEqual({ bad, planned: false });
		}
		for (const door of net.DOORS) {
			for (const driver of ['claude_code', 'opencode']) {
				let hosts: string[] = [];
				try {
					hosts = net.egressPlanFor(door, {
						driver,
						providerHosts: ['api.provider.example'],
						registryHosts: ['registry.npmjs.org'],
					}).hosts;
				} catch {
					hosts = [];
				}
				for (const host of hosts) {
					const ok = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host);
					expect({ door, driver, host, hostname: ok }).toEqual({
						door,
						driver,
						host,
						hostname: true,
					});
				}
			}
		}
	});

	test('the child env sends proxy doors through the gate, and gives git no proxy at all', async () => {
		const net = await leaf();
		const proxy = `http://127.0.0.1:${net.PROXY_PORT}`;
		for (const door of ['turn', 'build']) {
			const env = net.childEgressEnv(door);
			for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
				expect({ door, key, value: env[key] }).toEqual({ door, key, value: proxy });
			}
			expect({ door, node: env.NODE_USE_ENV_PROXY }).toEqual({ door, node: '1' });
		}
		// Each driver's own off-plan traffic (claude: the auto-updater, telemetry; opencode:
		// auto-update, the models.dev catalogue, LSP downloads, share uploads) is turned OFF, not
		// refused one CONNECT at a time — by the DRIVER, in every mode (claude_code.ts
		// CLAUDE_TRAFFIC_SWITCHES, held behaviourally by the daemon's tests/claude_turn_plant.test.ts
		// P13): these egress keys reach a CONFINED run only, so a switch held here reached no
		// declared-`none` turn at all — the claude half did exactly that until 2026-10-21.
		const opencodeLeaf = (await import(join(PACKAGE, 'src/drivers/opencode_argv.ts'))) as {
			opencodeTurnEnvironment: (input: {
				operatorEnv: Record<string, string>;
				configJson: string;
			}) => Record<string, string>;
		};
		const stated = opencodeLeaf.opencodeTurnEnvironment({ operatorEnv: {}, configJson: '{}' });
		for (const key of [
			'OPENCODE_DISABLE_AUTOUPDATE',
			'OPENCODE_DISABLE_MODELS_FETCH',
			'OPENCODE_DISABLE_LSP_DOWNLOAD',
			'OPENCODE_DISABLE_SHARE',
		]) {
			expect({ key, value: stated[key] }).toEqual({ key, value: '1' });
		}
		expect(
			Object.keys(net.childEgressEnv('turn')).filter(
				(key) =>
					key.startsWith('OPENCODE_') || key.startsWith('CLAUDE_') || key.includes('AUTOUPDATE'),
			),
		).toEqual([]);
		expect(net.childEgressEnv('git')).toEqual({});
	});

	test('the leaf, the shim and the classifier import only node builtins', () => {
		// They run where the daemon's config does not exist (this gate; inside the unit, under
		// ProtectHome/PrivateTmp/the /run mask), so a config import is a crash in one and a
		// policy that silently differs in the other.
		// The shim may read the leaf's port constants (the leaf is itself builtins-only); it
		// may hold no policy of its own and reach no config.
		const allowed: Record<string, readonly string[]> = {
			[LEAF]: [],
			[CLASSIFIER]: [],
			[SHIM]: ['./network_profile', './unit_frames'],
			// The shim's own leaves — the wire codec and the names — are held to the same rule.
			[join(PACKAGE, 'src/drivers/unit_frames.ts')]: ['./network_profile'],
			[join(PACKAGE, 'src/drivers/agent_identity.ts')]: ['./network_profile'],
		};
		// The module graph as BUN resolves it (static imports, re-exports, dynamic import() and
		// require()), not a regex over the text: a string literal in an `export const` is not
		// an import, and a multi-line import is still one.
		// …folded first (`scanAll`): `import('../' + 'config')` is an import of the config.
		const specifiersOf = (code: string) => scanAll(code).map((entry) => entry.path);
		for (const [file, extra] of Object.entries(allowed)) {
			const specifiers = specifiersOf(readFileSync(file, 'utf8'));
			expect({ file: relative(PACKAGE, file), scanned: specifiers.length > 0 }).toEqual({
				file: relative(PACKAGE, file),
				scanned: true,
			});
			const foreign = specifiers.filter((s) => !s.startsWith('node:') && !extra.includes(s));
			expect({ file: relative(PACKAGE, file), foreign }).toEqual({
				file: relative(PACKAGE, file),
				foreign: [],
			});
		}
		// LEAD-1c: the opencode argv, restriction and configuration leaf — read by the driver, the
		// config parser (OPENCODE_ENV refusals) and the live probe on a host with no config —
		// imports NOTHING at all (stricter than builtins-only).
		expect({
			file: 'src/drivers/opencode_argv.ts',
			imports: specifiersOf(readFileSync(join(PACKAGE, 'src/drivers/opencode_argv.ts'), 'utf8')),
		}).toEqual({ file: 'src/drivers/opencode_argv.ts', imports: [] });
		// WIRE-MAP's stream door: the turn-error vocabulary is read by the supervisor, the session
		// manager, the SSE responder and (type-only) the engine's relay — so it holds no policy of
		// its own: it reads the reason lists of the dependency-free errors module, and nothing else.
		expect({
			file: 'src/drivers/turn_errors.ts',
			imports: specifiersOf(readFileSync(join(PACKAGE, 'src/drivers/turn_errors.ts'), 'utf8')),
		}).toEqual({ file: 'src/drivers/turn_errors.ts', imports: ['../errors'] });
		expect({
			file: 'src/errors.ts',
			imports: specifiersOf(readFileSync(join(PACKAGE, 'src/errors.ts'), 'utf8')),
		}).toEqual({ file: 'src/errors.ts', imports: [] });
		// Positive control: the scanner sees a config import however it is spelled.
		expect(
			specifiersOf(
				"import {\n  config,\n} from '../config';\nconst x = await import('./y');\nexport { z } from \"../z\";\n",
			).sort(),
		).toEqual(['../config', '../z', './y']);
	});

	// (The retired AGENT_EGRESS_ALLOW key is an OUTCOME gate in the package —
	// tests/egress_config.test.ts: a museum env carrying it stops the daemon at parse, naming
	// the replacements. A regex over rendered artifacts for the key's spelling was deleted: the
	// renderer never emitted it, so that row could not fail.)

	test('mutation: any view of the whole egress/ directory reaches a sibling run — the rows above are not blind to it', async () => {
		// The per-site bind is the identity. A leaf that bound the PARENT (egressDirFor returning
		// `<agent socket dir>/egress`), or added a second, read-only view of it anywhere in the unit,
		// hands every run every concurrent turn's mcp.sock. Each shape must turn the
		// "nothing forbidden" row red — or that row certifies the leak.
		const net = await leaf();
		const sibling = [
			`unix:${AGENT_SOCKETS}/egress/s${SIBLING_K}/proxy.sock`,
			`unix:${AGENT_SOCKETS}/egress/s${SIBLING_K}/mcp.sock`,
		];
		for (const door of net.DOORS) {
			const { props } = doorProps(net, door);
			for (const extra of [
				`BindReadOnlyPaths=${AGENT_SOCKETS}/egress:/run/dedalo-all`,
				`BindPaths=${AGENT_SOCKETS}/egress`,
			]) {
				const mutated = [...props, extra];
				const reached = FORBIDDEN.filter((dest) => reach(mutated, dest, ALONE)).map(
					describeDestination,
				);
				expect({ door, extra, reached }).toEqual({ door, extra, reached: sibling });
			}
		}
		// …and the parent-dir bind as the proxy doors' ONE bind (the leaf mutation itself).
		for (const door of ['turn', 'build']) {
			const parent = net.unitNetworkProperties(door, {
				egressDir: `${AGENT_SOCKETS}/egress`,
				pidNamespace: false,
			});
			const reached = FORBIDDEN.filter((dest) => reach(parent, dest, ALONE)).map(
				describeDestination,
			);
			expect({ door, reached }).toEqual({ door, reached: sibling });
		}
	});

	test('mutation: without its per-unit mask, the host /dev/shm is a shared path-socket directory', async () => {
		const net = await leaf();
		const shm = { kind: 'unix', path: '/dev/shm/x.sock' } as const;
		for (const door of net.DOORS) {
			const { props } = doorProps(net, door);
			expect({ door, shm: reach(props, shm, { netnsHonoured: true }) }).toEqual({
				door,
				shm: false,
			});
			// PrivateDevices= alone does not hide it: systemd binds the host's /dev/shm into the
			// private /dev. The model knows that, so dropping the mask is red.
			const unmasked = [
				...props.filter((prop) => !/^TemporaryFileSystem=\/dev\/shm(?::|$)/.test(prop)),
				'PrivateDevices=yes',
			];
			expect({ door, shm: reach(unmasked, shm, { netnsHonoured: true }) }).toEqual({
				door,
				shm: true,
			});
			// Control: PrivateDevices= really does hide the rest of the host's /dev.
			expect(reach(unmasked, { kind: 'unix', path: '/dev/x.sock' }, { netnsHonoured: true })).toBe(
				false,
			);
		}
	});

	test('mutation: a same-uid run beside a door without a PID namespace reaches its sockets through /proc/<pid>/root', async () => {
		// The route the one-uid-per-museum shape left open: a concurrent unit of the same uid is
		// visible in /proc (ProtectProc=invisible hides only OTHER uids) and /proc/<pid>/root is
		// its mount view. At 255 (no PID namespace) the per-site identity is what closes it —
		// asked with the pre-LEAD-1b neighbour, the render must reach EXACTLY the sibling's two
		// sockets, or the 255 row above certifies a leak; at 257 PrivatePIDs= closes it again.
		const net = await leaf();
		const sibling = [
			`unix:${AGENT_SOCKETS}/egress/s${SIBLING_K}/proxy.sock`,
			`unix:${AGENT_SOCKETS}/egress/s${SIBLING_K}/mcp.sock`,
		];
		for (const door of net.DOORS) {
			const at255 = doorProps(net, door, false).props;
			const at257 = doorProps(net, door, true).props;
			expect({ door, extra: at257.length - at255.length }).toEqual({ door, extra: 1 });
			const beside = (props: string[]) =>
				FORBIDDEN.filter((dest) => reach(props, dest, besideSameUid(net))).map(describeDestination);
			expect({ door, reached: beside(at255) }).toEqual({ door, reached: sibling });
			expect({ door, reached: beside(at257) }).toEqual({ door, reached: [] });
			// Control: the route IS the concurrent same-uid unit — alone, the 255 render reaches nothing.
			const alone = FORBIDDEN.filter((dest) => reach(at255, dest, ALONE)).map(describeDestination);
			expect({ door, alone }).toEqual({ door, alone: [] });
		}
	});

	test('mutation: without its IPC namespace, every door shares the host’s SysV keys and message queues', async () => {
		const net = await leaf();
		for (const door of net.DOORS) {
			const { props } = doorProps(net, door);
			const shared = props.filter((prop) => !/^PrivateIPC=/.test(prop));
			expect({ door, dropped: props.length - shared.length }).toEqual({ door, dropped: 1 });
			const reached = FORBIDDEN.filter((dest) => reach(shared, dest, ALONE)).map(
				describeDestination,
			);
			expect({ door, reached }).toEqual({ door, reached: ['ipc:sysv:0x5a5a0001'] });
		}
	});
});
