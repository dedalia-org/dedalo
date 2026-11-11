/**
 * TRIPWIRE — the publication-host agent's media tree never REQUESTS a mode (T0-6, D5).
 *
 * THE DEFECT. A requested mode is `mode & ~umask`. The agent runs under `UMask=0027`, so every
 * `mkdir(p, { mode: 0o755 })` landed 0750 and every `writeFile(p, b, { mode: 0o644 })` landed
 * 0640: the web server (not in the agent's group) could not traverse the tree and every
 * published file of a copy-mode host answered 404. Asking for a mode is a wish the process
 * umask is free to refuse; the only mode a file is GUARANTEED to have is one APPLIED after
 * the create (fchmod/chmod — not filtered by the umask).
 *
 * THE RULE (one rule, no "harmless" exemption list to rot — plan D5):
 *
 *   §1 Every `.ts` under `publication/host_agent/src/media/` OTHER THAN `fs_modes.ts` reaches
 *      the filesystem only through a CLOSED list of no-create, no-mode functions
 *      ({@link NO_CREATE_FS}). Anything else from `node:fs` / `node:fs/promises` /
 *      `bun:sqlite` (mkdir, writeFile, appendFile, open, copyFile, cp, mkdtemp, symlink, link,
 *      createWriteStream, truncate, `Database`, … and chmod/chown: applying a mode has ONE
 *      home too) is a finding — derived from the IMPORTS and their scope-resolved bindings
 *      (named, aliased, namespace, default, `promises`), never from a call's spelling, the
 *      agent_confinement_tripwire §7 way: the file is transpiled, the fs imports removed, each
 *      binding `define`d to a sentinel (`define` replaces only UNBOUND references, so strings,
 *      comments, property names and shadowing locals are not references). Also refused:
 *      `Bun.write`, a `Bun.file(…)` not consumed by a read method, any `Bun` member outside a
 *      closed inert list, `Bun` bare; a dynamic import / `require` / re-export of an fs module;
 *      an fs namespace used bare or destructured; the process-capable modules (a `mkdir -m`
 *      child is a requested mode too); `globalThis`/`global`/`require`; a non-inert `process`
 *      member (`process.umask(…)`, `process.binding`).
 *
 *      WHY `rename` IS ALLOWED: rename(2) neither creates an inode nor takes a mode — the
 *      moved file keeps the mode it already carries (applied by fs_modes before the move).
 *      `unlink`/`rm`/`rmdir` remove; `stat`/`lstat`/`readdir`/`opendir`/`readFile`/`readlink`/
 *      `realpath`/`access`/`exists`/`createReadStream` read. None of them asks the umask
 *      anything.
 *
 *   §2 `fs_modes.ts` EXISTS and is the door: every create it makes (mkdir, mkdtemp, open,
 *      writeFile, appendFile, copyFile, cp, createWriteStream, `Bun.write`) is a CALL (never a
 *      value handed on — an alias would carry the raw create past this check) followed, later
 *      in the SAME top-level declaration, by an APPLY (`chmod`/`fchmod`/`lchmod`, any `Sync`
 *      twin, or a handle's `.chmod(`). It may not re-export an fs module, nor create at module
 *      top level.
 *
 * HONEST LIMIT of §2: "the same function" is the OUTERMOST brace block (the top-level
 * declaration), read by a brace lexer over the transpiled output — not an AST of nested
 * functions. A nested helper that creates and a sibling helper in the same declaration that
 * chmods would pass; "followed by" is source order, not control flow (a chmod in an
 * early-return branch counts); the apply's TARGET is not matched to the create's (an fchmod of
 * another descriptor counts); helper indirection is followed one level (a non-exported helper
 * whose every caller applies after the call); an `open` flag expression spelling `O_RDONLY` is
 * trusted not to carry `O_CREAT` in an OR'd variable. The BEHAVIOUR — modes actually landing 0755/0644 under
 * `UMask=0027` — is the agent's own suite (`publication/host_agent/tests/media_copy.test.ts`,
 * "modes under UMask=0027"); this gate keeps the requested-mode SHAPE from coming back.
 *
 * Every scanner has planted controls below: each respelling of a create is reported, the
 * no-create spellings are not, and the scanned set is the real tree, non-empty.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const MEDIA_ROOT = join(REPO_ROOT, 'publication/host_agent/src/media');
const DOOR = 'fs_modes.ts';

/** The modules whose bindings are followed. `bun:sqlite`'s `Database` creates a file at a path. */
const FS_MODULES: ReadonlySet<string> = new Set([
	'node:fs',
	'fs',
	'node:fs/promises',
	'fs/promises',
	'bun:sqlite',
]);

/** Modules a media file may not import at all: each can create a file with a requested mode. */
const PROCESS_MODULES: ReadonlySet<string> = new Set([
	'node:child_process',
	'child_process',
	'bun',
	'bun:ffi',
	'node:worker_threads',
	'worker_threads',
	'node:module',
	'module',
	'node:vm',
	'vm',
]);

/**
 * §1's CLOSED allowlist: fs functions that neither create an inode nor apply a mode. Anything
 * else imported from an fs module is a finding — closed-world, so a new creating API is red the
 * day it is used, not the day someone remembers to list it.
 */
const NO_CREATE_FS: ReadonlySet<string> = new Set([
	...[
		'access',
		'exists',
		'stat',
		'lstat',
		'fstat',
		'readdir',
		'opendir',
		'readFile',
		'readlink',
		'realpath',
		'rename',
		'unlink',
		'rm',
		'rmdir',
	].flatMap((name) => [name, `${name}Sync`]),
	'createReadStream',
	'constants',
]);

/** §2: what CREATES (and so must be followed by an apply) inside the door. */
const CREATE_FS: ReadonlySet<string> = new Set([
	...['mkdir', 'mkdtemp', 'open', 'writeFile', 'appendFile', 'copyFile', 'cp'].flatMap((name) => [
		name,
		`${name}Sync`,
	]),
	'createWriteStream',
]);

/** §2: what APPLIES a mode (not filtered by the umask). A handle's `.chmod(` counts too. */
const APPLY_FS: ReadonlySet<string> = new Set(
	['chmod', 'fchmod', 'lchmod'].flatMap((name) => [name, `${name}Sync`]),
);

/** `Bun` members that touch no file. `file` is allowed only as a READ (see bunFileIsRead). */
const BUN_INERT: ReadonlySet<string> = new Set(['CryptoHasher', 'hash', 'nanoseconds', 'sleep']);
/** BunFile methods that only read. */
const BUN_FILE_READS: ReadonlySet<string> = new Set([
	'stream',
	'text',
	'json',
	'arrayBuffer',
	'bytes',
	'exists',
	'slice',
	'size',
	'type',
]);
/** `process` members that cannot create a file nor change the umask. */
const PROCESS_INERT: ReadonlySet<string> = new Set([
	'pid',
	'platform',
	'arch',
	'hrtime',
	'nextTick',
	'version',
	'versions',
	'uptime',
	'memoryUsage',
]);

const FS_NAMED = '__DEDALO_RM_FSN_';
const FS_NS = '__DEDALO_RM_FSNS__';
const BUN_REF = '__DEDALO_RM_BUN__';
const PROC_REF = '__DEDALO_RM_PROC__';
const ESCAPE_REF = '__DEDALO_RM_ESCAPE__';

const TS = new Bun.Transpiler({ loader: 'ts' });
/** A static import / re-export as the transpiler prints it (one line or several). */
const IMPORT_LINE = /^import\s+([^;"'`]+?)\s+from\s*["']([^"']+)["'];?[ \t]*$/gm;
const EXPORT_FROM_LINE = /^export\s+([^;"'`]+?)\s+from\s*["']([^"']+)["'];?[ \t]*$/gm;

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

/** One scope-resolved fs/Bun/process reference in the transpiled output. */
interface Ref {
	readonly kind: 'fs' | 'bun' | 'process' | 'unresolvable';
	/** The fs function / Bun member / process member reached ('' when bare). */
	readonly name: string;
	/** Offset in {@link Resolved.js}. */
	readonly index: number;
	/** Offset just past the reference (the member name included). */
	readonly end: number;
}

interface Resolved {
	readonly js: string;
	readonly refs: readonly Ref[];
	/** Findings that need no reference: dynamic import / require / re-export / process module. */
	readonly structural: readonly string[];
}

/**
 * Transpile, drop the fs imports, `define` every binding they made (and `Bun`, `process`,
 * the loader escapes) to sentinels, and read the references back out. Imports are read off the
 * transpiled source (types gone); dynamic imports / requires off the CONSTANT-FOLDED output
 * (`import('node:' + 'fs')` is a literal only after folding).
 */
function resolve(code: string): Resolved {
	const structural: string[] = [];
	for (const entry of [
		...TS.scanImports(code).filter((e) => e.kind === 'import-statement'),
		...TS.scanImports(TS.transformSync(code)).filter((e) => e.kind !== 'import-statement'),
	]) {
		if (PROCESS_MODULES.has(entry.path)) structural.push(`imports ${entry.path}`);
		else if (FS_MODULES.has(entry.path) && entry.kind !== 'import-statement')
			structural.push(`${entry.kind} ${entry.path}`);
	}
	const define: Record<string, string> = {
		Bun: BUN_REF,
		process: PROC_REF,
		globalThis: ESCAPE_REF,
		global: ESCAPE_REF,
		require: ESCAPE_REF,
	};
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
			structural.push(`re-exports ${from}`);
			return '';
		});
	const out = new Bun.Transpiler({ loader: 'js', define }).transformSync(js);
	const refs: Ref[] = [];
	const member = '(?:\\s*\\.\\s*([A-Za-z_$][\\w$]*))?';
	for (const m of out.matchAll(new RegExp(`${FS_NAMED}([\\w$]+?)__`, 'g')))
		refs.push({ kind: 'fs', name: m[1] as string, index: m.index, end: m.index + m[0].length });
	for (const m of out.matchAll(new RegExp(`${FS_NS}(?:\\s*\\.\\s*promises)?${member}`, 'g'))) {
		const name = m[1];
		refs.push({
			kind: name === undefined || name === 'promises' ? 'unresolvable' : 'fs',
			name:
				name === undefined || name === 'promises' ? 'fs namespace used bare/destructured' : name,
			index: m.index,
			end: m.index + m[0].length,
		});
	}
	for (const m of out.matchAll(new RegExp(`${BUN_REF}${member}`, 'g')))
		refs.push({ kind: 'bun', name: m[1] ?? '', index: m.index, end: m.index + m[0].length });
	for (const m of out.matchAll(new RegExp(`${PROC_REF}${member}`, 'g')))
		refs.push({ kind: 'process', name: m[1] ?? '', index: m.index, end: m.index + m[0].length });
	for (const m of out.matchAll(new RegExp(ESCAPE_REF, 'g')))
		refs.push({
			kind: 'unresolvable',
			name: 'globalThis/global/require',
			index: m.index,
			end: m.index + m[0].length,
		});
	refs.sort((a, b) => a.index - b.index);
	return { js: out, refs, structural };
}

/** Index just past the balanced `( … )` starting at `open` (−1 if `js[open]` is not `(`). */
function pastParens(js: string, open: number): number {
	if (js[open] !== '(') return -1;
	let depth = 0;
	for (let i = open; i < js.length; i++) {
		if (js[i] === '(') depth++;
		else if (js[i] === ')' && --depth === 0) return i + 1;
	}
	return -1;
}

/** `Bun.file(<args>).<read method>` — the only `Bun.file` shape that cannot write. */
function bunFileIsRead(js: string, end: number): boolean {
	const close = pastParens(js, js.slice(end).search(/\S/) + end);
	if (close < 0) return false;
	const method = js.slice(close).match(/^\s*\.\s*([A-Za-z_$][\w$]*)/)?.[1];
	return method !== undefined && BUN_FILE_READS.has(method);
}

/** §1: everything in one non-door media source that can create or apply a mode. */
function requestedModeFindings(code: string): string[] {
	const { js, refs, structural } = resolve(code);
	const findings = [...structural];
	for (const ref of refs) {
		if (ref.kind === 'unresolvable') findings.push(ref.name);
		else if (ref.kind === 'fs' && !NO_CREATE_FS.has(ref.name)) findings.push(`fs ${ref.name}`);
		else if (ref.kind === 'bun') {
			if (ref.name === 'file' && bunFileIsRead(js, ref.end)) continue;
			if (!BUN_INERT.has(ref.name)) findings.push(`Bun.${ref.name || '(bare)'}`);
		} else if (ref.kind === 'process' && !PROCESS_INERT.has(ref.name))
			findings.push(`process.${ref.name || '(bare)'}`);
	}
	return findings;
}

/**
 * The outermost brace blocks of transpiled code, as [open, close] offsets — a lexer that skips
 * string and template literals (template `${…}` holes are code). `null` when the braces do not
 * balance: the caller fails closed rather than passing what it could not read.
 */
function outermostBlocks(js: string): Array<[number, number]> | null {
	const blocks: Array<[number, number]> = [];
	let depth = 0;
	let open = -1;
	// Stack of contexts: 'c' = code (with its brace depth inside a template hole), 't' = template.
	const holes: number[] = [];
	let inTemplate = false;
	for (let i = 0; i < js.length; i++) {
		const c = js[i];
		if (inTemplate) {
			if (c === '\\') i++;
			else if (c === '`') inTemplate = false;
			else if (c === '$' && js[i + 1] === '{') {
				holes.push(depth);
				depth++;
				inTemplate = false;
				i++;
			}
			continue;
		}
		if (c === '"' || c === "'") {
			for (i++; i < js.length && js[i] !== c; i++) if (js[i] === '\\') i++;
			continue;
		}
		if (c === '`') {
			inTemplate = true;
			continue;
		}
		if (c === '{') {
			if (depth === 0) open = i;
			depth++;
		} else if (c === '}') {
			depth--;
			if (holes.length > 0 && depth === holes[holes.length - 1]) {
				holes.pop();
				inTemplate = true;
				continue;
			}
			if (depth < 0) return null;
			if (depth === 0) blocks.push([open, i]);
		}
	}
	return depth === 0 && !inTemplate ? blocks : null;
}

/** The argument text of the call whose `(` follows `end` (null when it is not a call). */
function callArgs(js: string, end: number): string | null {
	const open = end + (js.slice(end).match(/^\s*/)?.[0].length ?? 0);
	const close = pastParens(js, open);
	return close < 0 ? null : js.slice(open + 1, close - 1);
}

/**
 * Does this `open`/`openSync` CREATE? Spelled `O_CREAT`, or a string flag `w…`/`a…`/`x…` → yes.
 * A string flag `r`/`r+`, a flag expression spelling `O_RDONLY` without `O_CREAT`, or no flag
 * argument at all (default `'r'`) → no. Anything else fails CLOSED (counted a create). Limit: a
 * variable OR'd into an `O_RDONLY` expression is trusted not to carry `O_CREAT`.
 */
function openCreates(args: string): boolean {
	if (/O_CREAT/.test(args) || /["'][wax]/.test(args)) return true;
	if (/["']r\+?s?["']/.test(args) || /O_RDONLY/.test(args)) return false;
	return /,/.test(args);
}

/** A top-level declaration: its brace block and the name it binds (if any). */
interface Declaration {
	readonly open: number;
	readonly close: number;
	readonly name: string | null;
	readonly exported: boolean;
}

function declarations(js: string, blocks: Array<[number, number]>): Declaration[] {
	return blocks.map(([open, close]) => {
		const head = js.slice(js.lastIndexOf('\n', open) + 1, open);
		const m = head.match(/function\s*\*?\s*([\w$]+)|(?:const|let|var)\s+([\w$]+)\s*=/);
		return { open, close, name: m?.[1] ?? m?.[2] ?? null, exported: /^\s*export\s/.test(head) };
	});
}

/**
 * §2: every create in the door is a CALL, inside a declaration, followed in that declaration by an
 * APPLY — a chmod/fchmod/lchmod, a handle's `.chmod(`, or a call of a declaration that applies
 * (fixpoint: `settle` → `settleMode` → `fchmodSync`). A create whose own declaration does not
 * apply is accepted when that declaration is a non-exported helper and EVERY call of it in the
 * file is followed, in the caller's declaration, by an apply (`makeLevel` → `ensureDirExact`) —
 * one level of indirection. `writeFile`/`appendFile` aimed at a descriptor the same declaration
 * got from `open` is not a create (the open is, and is checked).
 */
function doorFaults(code: string): { faults: string[]; creates: number; applies: number } {
	const { js, refs, structural } = resolve(code);
	const faults = structural.filter((s) => s.startsWith('re-exports') || s.startsWith('imports'));
	const blocks = outermostBlocks(js);
	if (blocks === null)
		return { faults: ['braces do not balance: cannot read'], creates: 0, applies: 0 };
	const decls = declarations(js, blocks);
	const declAt = (index: number) => decls.find((d) => index > d.open && index < d.close);
	const directApplies: number[] = [
		...refs.filter((r) => r.kind === 'fs' && APPLY_FS.has(r.name)).map((r) => r.index),
		...[...js.matchAll(/\.\s*chmod\s*\(/g)].map((m) => m.index),
	];
	// Fixpoint: a declaration APPLIES when it applies directly or calls one that does.
	const appliers = new Set<string>();
	const callsOf = (name: string) =>
		[...js.matchAll(new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}\\s*\\(`, 'g'))]
			.map((m) => m.index)
			.filter((at) => !/function\s*\*?\s*$/.test(js.slice(Math.max(0, at - 40), at)));
	for (let changed = true; changed; ) {
		changed = false;
		for (const d of decls) {
			if (d.name === null || appliers.has(d.name)) continue;
			const inside = (at: number) => at > d.open && at < d.close;
			if (directApplies.some(inside) || [...appliers].some((a) => callsOf(a).some(inside))) {
				appliers.add(d.name);
				changed = true;
			}
		}
	}
	const applyAt = [...directApplies, ...[...appliers].flatMap(callsOf)];
	const appliedAfter = (at: number, d: Declaration) => applyAt.some((x) => x > at && x < d.close);
	const openRe = `(?:${FS_NAMED}open(?:Sync)?__|${FS_NS}(?:\\s*\\.\\s*promises)?\\s*\\.\\s*open(?:Sync)?)`;
	let creates = 0;
	for (const ref of refs) {
		if (ref.kind === 'unresolvable') faults.push(ref.name);
		const isCreate =
			(ref.kind === 'fs' && CREATE_FS.has(ref.name)) ||
			(ref.kind === 'bun' && ref.name === 'write');
		if (!isCreate) continue;
		const label = ref.kind === 'bun' ? 'Bun.write' : ref.name;
		const args = callArgs(js, ref.end);
		if (args === null) {
			faults.push(`${label} referenced as a value (an alias carries the raw create out)`);
			continue;
		}
		const decl = declAt(ref.index);
		if (!decl) {
			faults.push(`${label} at module top level`);
			continue;
		}
		if (/^open(Sync)?$/.test(ref.name) && !openCreates(args)) continue;
		const target = args.match(/^\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/)?.[1];
		if (
			/^(writeFile|appendFile)(Sync)?$/.test(ref.name) &&
			target !== undefined &&
			new RegExp(`(?<![\\w$])${target}\\s*=\\s*(?:await\\s+)?${openRe}\\s*\\(`).test(
				js.slice(decl.open, ref.index),
			)
		)
			continue;
		creates++;
		if (appliedAfter(ref.index, decl)) continue;
		const callers =
			decl.name === null || decl.exported
				? []
				: callsOf(decl.name).filter((at) => !(at > decl.open && at < decl.close));
		const unapplied = callers.filter((at) => {
			const caller = declAt(at);
			return caller === undefined || !appliedAfter(at, caller);
		});
		if (callers.length === 0 || unapplied.length > 0)
			faults.push(
				`${label} not followed by chmod/fchmod in its declaration (nor in every caller's)`,
			);
	}
	return { faults, creates, applies: applyAt.length };
}

function mediaSources(): string[] {
	return (readdirSync(MEDIA_ROOT, { recursive: true }) as string[])
		.filter((rel) => rel.endsWith('.ts') && !rel.endsWith('.d.ts'))
		.map((rel) => join(MEDIA_ROOT, rel))
		.sort();
}

describe('host_agent media: no create requests a mode; fs_modes.ts applies them', () => {
	test('the scanned set is the real media tree, non-empty', () => {
		const scanned = mediaSources().filter((file) => !file.endsWith(`/${DOOR}`));
		const names = scanned.map((file) => relative(MEDIA_ROOT, file));
		expect(names.length).toBeGreaterThanOrEqual(3);
		for (const known of ['copy.ts', 'sha_index.ts', 'probe.ts']) expect(names).toContain(known);
	});

	test('§1 no media file other than fs_modes.ts reaches a creating or mode-applying fs call', () => {
		const offenders: Record<string, string[]> = {};
		for (const file of mediaSources()) {
			if (file.endsWith(`/${DOOR}`)) continue;
			const findings = requestedModeFindings(readFileSync(file, 'utf8'));
			if (findings.length > 0) offenders[relative(REPO_ROOT, file)] = [...new Set(findings)];
		}
		expect(offenders).toEqual({});
	});

	test('§2 fs_modes.ts exists, and every create in it is followed by an applied mode', () => {
		const door = join(MEDIA_ROOT, DOOR);
		expect(existsSync(door)).toBe(true);
		const { faults, creates, applies } = doorFaults(readFileSync(door, 'utf8'));
		expect(faults).toEqual([]);
		expect(creates).toBeGreaterThan(0);
		expect(applies).toBeGreaterThan(0);
	});

	test('control: every respelling of a create is reported (§1)', () => {
		const planted: Record<string, string> = {
			named: `import { mkdir } from 'node:fs/promises'; export async function f(p: string) { await mkdir(p, { mode: 0o755 }); }`,
			aliased: `import { writeFile as wf } from 'node:fs/promises'; export const f = (p: string) => wf(p, 'x');`,
			namespace: `import * as fsp from 'node:fs/promises'; export const f = (p: string) => fsp.open(p, 'wx', 0o644);`,
			default: `import fs from 'node:fs'; export const f = (p: string) => fs.mkdirSync(p, { recursive: true });`,
			promisesMember: `import fs from 'node:fs'; export const f = (p: string) => fs.promises.appendFile(p, 'x');`,
			promisesNamed: `import { promises as fsp } from 'node:fs'; export const f = (p: string) => fsp.copyFile(p, p + '.b');`,
			sync: `import { appendFileSync } from 'node:fs'; export const f = (p: string) => appendFileSync(p, 'x');`,
			stream: `import { createWriteStream } from 'node:fs'; export const f = (p: string) => createWriteStream(p);`,
			localAlias: `import { open } from 'node:fs/promises'; const o = open; export const f = (p: string) => o(p, 'w');`,
			bunWrite: `export const f = (p: string) => Bun.write(p, 'x');`,
			bunFileWrite: `export const f = (p: string) => Bun.file(p).write('x');`,
			bunFileStored: `export const f = (p: string) => { const b = Bun.file(p); return b; };`,
			bunAliased: `const B = Bun; export const f = (p: string) => B.write(p, 'x');`,
			destructured: `import * as fs from 'node:fs'; const { mkdirSync: m } = fs; export const f = (p: string) => m(p);`,
			dynamicImport: `export const f = async (p: string) => (await import('node:' + 'fs/promises')).mkdir(p);`,
			requireFs: `export const f = (p: string) => require('node:fs').mkdirSync(p);`,
			reExport: `export { mkdir } from 'node:fs/promises';`,
			childProcess: `import { spawnSync } from 'node:child_process'; export const f = (p: string) => spawnSync('mkdir', ['-m', '755', p]);`,
			bunShell: `import { $ } from 'bun'; export const f = (p: string) => $\`mkdir \${p}\`;`,
			globalThisBun: `export const f = (p: string) => (globalThis as any).Bun.write(p, 'x');`,
			umask: `export const f = () => process.umask(0);`,
			chmodOutsideDoor: `import { chmod } from 'node:fs/promises'; export const f = (p: string) => chmod(p, 0o755);`,
			sqlite: `import { Database } from 'bun:sqlite'; export const f = (p: string) => new Database(p);`,
			multiLine: `import {\n  stat,\n  mkdir,\n} from 'node:fs/promises';\nexport const f = (p: string) => stat(p).then(() => mkdir(p));`,
		};
		const silent = Object.entries(planted)
			.filter(([, source]) => requestedModeFindings(source).length === 0)
			.map(([name]) => name);
		expect(silent).toEqual([]);
	});

	test('control: the no-create spellings are NOT reported (§1)', () => {
		const clean = [
			`import { lstat, readdir, realpath, rename, rm, stat, unlink, type FileHandle } from 'node:fs/promises';
			 import { existsSync, readFileSync, renameSync, statSync, constants } from 'node:fs';
			 // mkdir(p, { mode: 0o755 }) in a comment, and in a string:
			 const note = "writeFile(p, { mode: 0o644 })";
			 function mkdir(p: string) { return p; } // a local of the name, not the fs function
			 export async function f(p: string, h: FileHandle) {
			   await stat(p); await lstat(p); await readdir(p); await realpath(p);
			   await rename(p, p + '.x'); await rm(p); await unlink(p);
			   existsSync(p); statSync(p); readFileSync(p); renameSync(p, p); void constants.O_RDONLY;
			   await h.writeFile('x'); // a handle's method: the open that made it is the create
			   const hasher = new Bun.CryptoHasher('sha256');
			   for await (const c of Bun.file(p).stream()) hasher.update(c);
			   return [note, mkdir(p), process.pid];
			 }`,
		];
		for (const source of clean) expect(requestedModeFindings(source)).toEqual([]);
	});

	test('control: the door check tells an applied mode from a requested one (§2)', () => {
		const good = `import { mkdir, chmod, open } from 'node:fs/promises';
			export async function ensureDir(p: string) { await mkdir(p, { recursive: false }); await chmod(p, 0o755); }
			export async function writeMarker(p: string, b: string) {
			  const h = await open(p, 'wx', 0o600);
			  try { await h.writeFile(b); await h.chmod(0o644); } finally { await h.close(); }
			}
			const tpl = (x: string) => \`\${x}{\`;`;
		const result = doorFaults(good);
		expect(result.faults).toEqual([]);
		expect(result.creates).toBe(2);

		// The shapes the door legitimately uses: a helper whose every caller applies after it
		// (through an applier chain), a read-only no-follow open, a write aimed at the
		// descriptor its own open made.
		const helpers = `import { mkdirSync, openSync, fchmodSync, closeSync, writeFileSync, constants as FS } from 'node:fs';
			function settleMode(fd: number, mode: number) { fchmodSync(fd, mode); }
			function settle(p: string, mode: number) { const fd = openSync(p, FS.O_RDONLY | FS.O_NOFOLLOW); try { settleMode(fd, mode); } finally { closeSync(fd); } }
			function makeLevel(p: string) { try { mkdirSync(p); } catch {} }
			export function ensureDir(p: string) { makeLevel(p); settle(p, 0o755); }
			export function writePrivate(p: string, t: string) { const fd = openSync(p, FS.O_WRONLY | FS.O_CREAT); try { fchmodSync(fd, 0o600); writeFileSync(fd, t); } finally { closeSync(fd); } }`;
		const helperResult = doorFaults(helpers);
		expect(helperResult.faults).toEqual([]);
		expect(helperResult.creates).toBe(2);

		const bad: Record<string, string> = {
			noApply: `import { mkdir } from 'node:fs/promises'; export async function f(p: string) { await mkdir(p, { mode: 0o755 }); }`,
			applyBefore: `import { mkdir, chmod } from 'node:fs/promises'; export async function f(p: string) { await chmod(p, 0o755); await mkdir(p); }`,
			applyElsewhere: `import { writeFile, chmod } from 'node:fs/promises'; export async function f(p: string) { await writeFile(p, 'x'); } export async function g(p: string) { await chmod(p, 0o644); }`,
			valueAlias: `import { mkdir, chmod } from 'node:fs/promises'; export const raw = mkdir; export async function f(p: string) { await chmod(p, 0o755); }`,
			topLevel: `import { mkdirSync, chmodSync } from 'node:fs'; mkdirSync('/x'); chmodSync('/x', 0o755);`,
			bunWrite: `export async function f(p: string) { await Bun.write(p, 'x'); }`,
			reExport: `export { mkdir } from 'node:fs/promises';`,
			namespaceNoApply: `import * as fs from 'node:fs'; export function f(p: string) { fs.openSync(p, 'w'); }`,
			exportedHelper: `import { mkdirSync } from 'node:fs'; export function make(p: string) { mkdirSync(p); }`,
			callerNoApply: `import { mkdirSync, chmodSync } from 'node:fs'; function make(p: string) { mkdirSync(p); } export function a(p: string) { make(p); chmodSync(p, 0o755); } export function b(p: string) { make(p); }`,
			uncalledHelper: `import { mkdirSync } from 'node:fs'; function make(p: string) { mkdirSync(p); }`,
			openVariableFlags: `import { openSync } from 'node:fs'; export function f(p: string, flags: number) { return openSync(p, flags); }`,
		};
		const silent = Object.entries(bad)
			.filter(([, source]) => doorFaults(source).faults.length === 0)
			.map(([name]) => name);
		expect(silent).toEqual([]);
	});
});
