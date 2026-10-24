/**
 * WHERE THE TWO VERSIONS FLOW — the module-level data-flow model behind
 * test/unit/release_identity_separation_tripwire.test.ts (release identity
 * design gate 9; WC-2026-10-15-release-identity-from-tag).
 *
 * Two values must never be confused (src/core/update/release_identity.ts):
 *  - the RELEASE IDENTITY — what the program calls itself (`7.0.0-beta.6`);
 *  - the DATA version — `version.ts` DEDALO_VERSION_TRIPLE and what derives
 *    from it (`7.0.0`), which compares, migrates and names code-server files.
 *
 * A literal scan for `DEDALO_ENGINE_VERSION` would enforce a spelling: a
 * re-export under another name, a helper returning `RELEASE_IDENTITY.version`,
 * a `const { … } = await import(…)` or a namespace import would all walk past
 * it. So this models the FLOW instead, from the one producer outward:
 *
 *  IDENTITY TAINT. Seeded at the one function that produces an identity
 *  (`resolveReleaseIdentity`, release_identity.ts) and closed to a fixpoint
 *  over every module in scope: a top-level declaration (function, const,
 *  class…) is tainted when its body REFERENCES a tainted binding — an
 *  imported one (static named, default, namespace member, dynamic
 *  destructure, dynamic namespace member, re-export chains, `export *`) or a
 *  tainted declaration of its own module. So `build_stamp.ts`'s
 *  `readReleaseIdentityOf` → `RELEASE_IDENTITY` → `DEDALO_ENGINE_VERSION`,
 *  `installer_identity.ts`'s `installerIdentity`, and anything that calls
 *  them, are tainted without one of those names being written here.
 *
 *  DATA ALIASES. Seeded at `DEDALO_VERSION_TRIPLE` (version.ts) and closed
 *  over VALUE aliases only — import/re-export bindings and module-level
 *  const/let/var declarations — never through functions (nor a function
 *  inside a value, an action table's handlers): a function that merely
 *  consults the data version is not that value. A value can carry BOTH
 *  labels; the one exemption is the PRODUCER HANDOFF — the triple passed as an
 *  argument to the seed or a function calling it directly (build_stamp.ts
 *  `readReleaseIdentityOf(…, { triple })`) is the producer's input.
 *
 *  DISPLAY SITES walk what a value reaches: a module-level value's
 *  initializer and a function's `return` expressions, own or imported — so a
 *  HOISTED mix (`const SHOWN = beta ? DEDALO_VERSION : DEDALO_ENGINE_VERSION`,
 *  or a helper returning either) is red like the inline one.
 *
 *  IMPORTS resolve as Bun resolves them (exact, `.js`→`.ts`, added extension,
 *  directory index). A relative import naming no module of the analysed set
 *  and no data file REFUSES the model: a dropped binding is one no leg sees.
 *  engineSources() follows the engine's imports out of src/ and the tools'
 *  server trees (publication host agent, install/db, a shared client leaf).
 *
 * Input is TRANSPILED (Bun.Transpiler: types gone, one canonical layout),
 * then scanned with comments stripped and string/regex bodies blanked
 * (test/helpers/strip_comments.ts), so prose and literals never count.
 *
 * HONEST LIMITS: taint is per top-level declaration (a function that touches
 * the identity anywhere is tainted as a whole); names are not scoped (an inner
 * local shadowing a top-level name reads as that name — the red direction); a
 * computed dynamic-import specifier is not resolved — it is REPORTED
 * (`unresolvedDynamic`), never silently skipped; a module-level side-effect
 * statement taints no export. Client: a `dedalo_version` bound by a FUNCTION
 * PARAMETER pattern (`({ dedalo_version }) => …`) is not followed.
 */

import { readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { browserSources } from './browser_corpus.ts';
import { escapeRegExp } from './regex_escape.ts';
import { stripComments } from './strip_comments.ts';
import { writePathSourceFiles } from './write_path_corpus.ts';

export const REPO_ROOT = resolve(import.meta.dir, '..', '..');

/** The one producer of a release identity. */
export const IDENTITY_SEED = Object.freeze({
	module: 'src/core/update/release_identity.ts',
	name: 'resolveReleaseIdentity',
});

/** The one hand pin of the data version. */
export const DATA_SEED = Object.freeze({
	module: 'src/core/update/version.ts',
	name: 'DEDALO_VERSION_TRIPLE',
});

interface ImportBinding {
	local: string;
	/** Repo-relative target module, or null for a package / non-.ts specifier. */
	from: string | null;
	/** Imported export name, `default`, or `*` for a namespace. */
	imported: string;
}

interface DynamicImport {
	from: string | null;
	/** `destructure`: names maps local → imported; `namespace`: local holds the module; `property`: one member read; `opaque`: anything else. */
	kind: 'destructure' | 'namespace' | 'property' | 'opaque';
	names: Map<string, string>;
	local: string | null;
	property: string | null;
}

export interface Chunk {
	/** Names this top-level statement declares (empty for a side-effect statement or an import). */
	names: string[];
	/** Offsets into the module's blanked text. */
	start: number;
	end: number;
	refs: Set<string>;
	/** `ns.member` pairs read anywhere in the chunk. */
	members: Array<[string, string]>;
	dynamics: DynamicImport[];
	/** True for a function/class declaration: never a data alias. */
	callable: boolean;
}

export interface ModuleFacts {
	path: string;
	/** Transpiled source (strings intact). */
	code: string;
	/** Same length as `code`, comments gone, string/regex bodies blanked. */
	blank: string;
	imports: ImportBinding[];
	/** exported name → local name */
	exportAliases: Map<string, string>;
	/** exported name → [module, imported name] */
	reexports: Map<string, [string, string]>;
	starFrom: string[];
	chunks: Chunk[];
	unresolvedDynamic: number;
	/** Relative specifiers naming no module of the set (buildFlowModel refuses any). */
	unresolvedImports: string[];
}

const tsTranspiler = new Bun.Transpiler({ loader: 'ts' });
const jsTranspiler = new Bun.Transpiler({ loader: 'js' });

/** Extensions of a module that can carry code (and so a version). */
const CODE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.jsx'] as const;

const isCodePath = (path: string): boolean => CODE_EXTENSIONS.some((ext) => path.endsWith(ext));

/**
 * The files a relative specifier may name, in the order Bun tries them: the
 * exact path, the `.js`→`.ts` swap (TS-style `.js` specifiers), an added
 * extension (`'../update/build_stamp'`), a directory index. An extensionless
 * import is legal and Bun runs it — the model must see it too.
 */
function resolutionCandidates(target: string): string[] {
	const out = [target];
	const js = /\.(?:m?js|jsx)$/.exec(target);
	if (js) {
		const stem = target.slice(0, -js[0].length);
		out.push(`${stem}.ts`, `${stem}.tsx`);
	}
	for (const ext of CODE_EXTENSIONS) out.push(`${target}${ext}`);
	for (const ext of CODE_EXTENSIONS) out.push(`${target}/index${ext}`);
	return out;
}

interface Resolution {
	/** Repo-relative module in the analysed set, or null (a package, or a non-code file). */
	from: string | null;
	/** A relative specifier that names no module of the set and no data file: the model would go blind. */
	unresolved: boolean;
}

function resolveSpecifier(
	fromPath: string,
	specifier: string,
	known: ReadonlySet<string>,
): Resolution {
	if (!specifier.startsWith('.')) return { from: null, unresolved: false };
	const target = relative(REPO_ROOT, resolve(dirname(resolve(REPO_ROOT, fromPath)), specifier));
	for (const candidate of resolutionCandidates(target)) {
		if (known.has(candidate)) return { from: candidate, unresolved: false };
	}
	// A data file (`.json`, `.txt` …) is read, not run: it carries no version flow.
	if (/\.[A-Za-z0-9]+$/.test(target) && !isCodePath(target))
		return { from: null, unresolved: false };
	return { from: null, unresolved: true };
}

/** Relative specifiers a module imports (static, re-export, side-effect, literal dynamic). */
function relativeSpecifiers(code: string): string[] {
	return [...code.matchAll(/(?:\bfrom|\bimport\s*\(?)\s*"(\.[^"]*)"/g)].map((m) => m[1] as string);
}

function transpile(path: string, source: string): string {
	return (
		path.endsWith('.ts') || path.endsWith('.tsx') ? tsTranspiler : jsTranspiler
	).transformSync(source);
}

const IDENT = '[A-Za-z_$][\\w$]*';

/** Top-level statement spans of blanked code: depth-0 newline followed by a statement start. */
function splitChunks(blank: string): Array<[number, number]> {
	const spans: Array<[number, number]> = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < blank.length; i++) {
		const c = blank[i];
		if (c === '(' || c === '{' || c === '[') depth++;
		else if (c === ')' || c === '}' || c === ']') depth--;
		else if (c === '\n' && depth === 0) {
			const next = blank[i + 1];
			if (next !== undefined && !/[\s)}\].]/.test(next)) {
				if (blank.slice(start, i).trim() !== '') spans.push([start, i]);
				start = i + 1;
			}
		}
	}
	if (blank.slice(start).trim() !== '') spans.push([start, blank.length]);
	return spans;
}

/** Names bound by a destructuring pattern body (`a, b: c, d = 1, ...rest`). */
function patternNames(body: string): Array<[string, string]> {
	const out: Array<[string, string]> = [];
	for (const raw of body.split(',')) {
		const part = raw.trim().replace(/^\.\.\./, '');
		if (part === '') continue;
		const renamed = new RegExp(`^(${IDENT})\\s*:\\s*(${IDENT})`).exec(part);
		if (renamed) {
			out.push([renamed[2] as string, renamed[1] as string]);
			continue;
		}
		const plain = new RegExp(`^(${IDENT})`).exec(part);
		if (plain) out.push([plain[1] as string, plain[1] as string]);
	}
	return out;
}

/** Identifier reads (not property names after `.`). */
export function identifierRefs(text: string): Set<string> {
	const out = new Set<string>();
	for (const m of text.matchAll(new RegExp(`(?<![\\w$.])(${IDENT})`, 'g'))) out.add(m[1] as string);
	return out;
}

function memberRefs(text: string): Array<[string, string]> {
	const out: Array<[string, string]> = [];
	for (const m of text.matchAll(
		new RegExp(`(?<![\\w$.])(${IDENT})\\s*\\??\\.\\s*(${IDENT})`, 'g'),
	)) {
		out.push([m[1] as string, m[2] as string]);
	}
	return out;
}

function dynamicImports(
	path: string,
	known: ReadonlySet<string>,
	unresolved: string[],
	code: string,
	blank: string,
	start: number,
	end: number,
): DynamicImport[] {
	const out: DynamicImport[] = [];
	const re = /\bimport\s*\(/g;
	re.lastIndex = start;
	for (let m = re.exec(blank); m !== null && m.index < end; m = re.exec(blank)) {
		const at = m.index;
		const literal = /^import\s*\(\s*"([^"]+)"\s*\)/.exec(code.slice(at));
		const resolution = literal ? resolveSpecifier(path, literal[1] as string, known) : null;
		if (resolution?.unresolved) unresolved.push(literal?.[1] as string);
		const from = resolution?.from ?? null;
		const before = blank.slice(Math.max(start, at - 400), at);
		const after = literal ? blank.slice(at + literal[0].length) : '';
		const destructure = /(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*(?:await\s*)?$/.exec(before);
		const namespace = new RegExp(`(?:const|let|var)\\s+(${IDENT})\\s*=\\s*await\\s*$`).exec(before);
		const property = /\(\s*await\s*$/.test(before)
			? new RegExp(`^\\s*\\)\\s*\\??\\.\\s*(${IDENT})`).exec(after)
			: null;
		const base = {
			from: literal ? from : null,
			names: new Map<string, string>(),
			local: null,
			property: null,
		};
		if (!literal) out.push({ ...base, kind: 'opaque' });
		else if (destructure) {
			out.push({
				...base,
				kind: 'destructure',
				names: new Map(patternNames(destructure[1] as string)),
			});
		} else if (namespace) out.push({ ...base, kind: 'namespace', local: namespace[1] as string });
		else if (property) out.push({ ...base, kind: 'property', property: property[1] as string });
		else out.push({ ...base, kind: 'opaque' });
	}
	return out;
}

/** Parse one module's facts from its source; `known` is the analysed set imports resolve into. */
export function moduleFacts(path: string, source: string, known: ReadonlySet<string>): ModuleFacts {
	const code = transpile(path, source);
	const blank = stripComments(code, {
		blankStrings: true,
		keepTemplateSubstitutions: true,
		blankRegexBodies: true,
	});
	if (blank.length !== code.length) {
		// The offsets below index BOTH texts; a transpiler that kept a comment
		// would shift them. Fail closed rather than read the wrong bytes.
		throw new Error(`${path}: transpiled source carries a comment — offsets would drift`);
	}
	const facts: ModuleFacts = {
		path,
		code,
		blank,
		imports: [],
		exportAliases: new Map(),
		reexports: new Map(),
		starFrom: [],
		chunks: [],
		unresolvedDynamic: 0,
		unresolvedImports: [],
	};
	const resolveIn = (specifier: string): string | null => {
		const resolution = resolveSpecifier(path, specifier, known);
		if (resolution.unresolved) facts.unresolvedImports.push(specifier);
		return resolution.from;
	};
	for (const [start, end] of splitChunks(blank)) {
		const text = code.slice(start, end);
		const btext = blank.slice(start, end);
		const chunk: Chunk = {
			names: [],
			start,
			end,
			refs: identifierRefs(btext),
			members: memberRefs(btext),
			dynamics: dynamicImports(path, known, facts.unresolvedImports, code, blank, start, end),
			callable: false,
		};
		facts.unresolvedDynamic += chunk.dynamics.filter((d) => d.from === null).length;
		const imp = new RegExp(
			`^import\\s+(?:(${IDENT})\\s*,?\\s*)?(?:\\{([^}]*)\\}|\\*\\s*as\\s+(${IDENT}))?\\s*from\\s*"([^"]+)"`,
		).exec(text);
		const reexp = /^export\s*\{([^}]*)\}\s*from\s*"([^"]+)"/.exec(text);
		const star = new RegExp(`^export\\s*\\*\\s*(?:as\\s+(${IDENT})\\s*)?from\\s*"([^"]+)"`).exec(
			text,
		);
		const aliases = /^export\s*\{([^}]*)\}/.exec(text);
		if (imp) {
			const from = resolveIn(imp[4] as string);
			if (imp[1]) facts.imports.push({ local: imp[1], from, imported: 'default' });
			if (imp[3]) facts.imports.push({ local: imp[3], from, imported: '*' });
			for (const [local, imported] of patternNames((imp[2] ?? '').replace(/\bas\b/g, ':'))) {
				facts.imports.push({ local, from, imported });
			}
			chunk.refs = new Set();
			chunk.members = [];
		} else if (reexp) {
			const from = resolveIn(reexp[2] as string);
			for (const [exported, imported] of patternNames(
				(reexp[1] as string).replace(/\bas\b/g, ':'),
			)) {
				if (from) facts.reexports.set(exported, [from, imported]);
			}
			chunk.refs = new Set();
		} else if (star) {
			const from = resolveIn(star[2] as string);
			if (from && star[1]) facts.reexports.set(star[1], [from, '*']);
			else if (from) facts.starFrom.push(from);
			chunk.refs = new Set();
		} else if (aliases) {
			for (const [exported, local] of patternNames(
				(aliases[1] as string).replace(/\bas\b/g, ':'),
			)) {
				facts.exportAliases.set(exported, local);
			}
			chunk.refs = new Set();
		} else {
			const exported = /^export\s+/.test(text);
			const body = text.replace(/^export\s+(?:default\s+)?/, '');
			const decl = new RegExp(`^(?:async\\s+)?(function\\s*\\*?|class)\\s+(${IDENT})`).exec(body);
			const variable = new RegExp(`^(?:const|let|var)\\s+(${IDENT})`).exec(body);
			const pattern = /^(?:const|let|var)\s*[{[]([^}\]]*)[}\]]/.exec(body);
			if (decl) {
				chunk.names = [decl[2] as string];
				chunk.callable = true;
			} else if (variable) chunk.names = [variable[1] as string];
			else if (pattern) chunk.names = patternNames(pattern[1] as string).map(([local]) => local);
			if (/^export\s+default\s+/.test(text)) {
				facts.exportAliases.set('default', chunk.names[0] ?? `default@${start}`);
				if (chunk.names.length === 0) chunk.names = [`default@${start}`];
			} else if (exported) {
				for (const name of chunk.names) facts.exportAliases.set(name, name);
			}
		}
		facts.chunks.push(chunk);
	}
	return facts;
}

/** The whole analysed program: module facts plus the two closed relations. */
export interface FlowModel {
	modules: Map<string, ModuleFacts>;
	/** module → tainted local names, each with the reason it is tainted. */
	identityLocals: Map<string, Map<string, string>>;
	/** module → data-alias local names. */
	dataLocals: Map<string, Set<string>>;
	/** module → producer callables (the seed and its direct callers): data handed to them is their input. */
	producers: Map<string, Set<string>>;
	exportCarriesIdentity(module: string, name: string): boolean;
	exportIsDataAlias(module: string, name: string): boolean;
	/** Why a module's local is identity-tainted, as a readable chain down to the seed. */
	why(module: string, local: string): string;
}

function exportResolver(
	modules: Map<string, ModuleFacts>,
	locals: Map<string, Map<string, string> | Set<string>>,
): (module: string, name: string, seen?: Set<string>) => boolean {
	const resolveExport = (module: string, name: string, seen = new Set<string>()): boolean => {
		const key = `${module}#${name}`;
		if (seen.has(key)) return false;
		seen.add(key);
		const facts = modules.get(module);
		if (!facts) return false;
		const local = facts.exportAliases.get(name);
		if (local !== undefined && locals.get(module)?.has(local)) return true;
		const re = facts.reexports.get(name);
		if (re) {
			if (re[1] === '*') return anyExport(re[0], seen);
			return resolveExport(re[0], re[1], seen);
		}
		if (name !== 'default' && local === undefined) {
			return facts.starFrom.some((from) => resolveExport(from, name, seen));
		}
		return false;
	};
	const anyExport = (module: string, seen: Set<string>): boolean => {
		const facts = modules.get(module);
		if (!facts) return false;
		const names = [...facts.exportAliases.keys(), ...facts.reexports.keys()];
		return (
			names.some((name) => resolveExport(module, name, seen)) ||
			facts.starFrom.some((from) => anyExport(from, seen))
		);
	};
	return (module, name, seen) =>
		name === '*' ? anyExport(module, seen ?? new Set()) : resolveExport(module, name, seen);
}

/** Does a chunk read a tainted binding? Returns the reason, or null. */
function chunkTaint(
	facts: ModuleFacts,
	chunk: Chunk,
	locals: Map<string, string>,
	carries: (module: string, name: string) => boolean,
): string | null {
	for (const ref of chunk.refs) {
		if (chunk.names.includes(ref)) continue;
		if (locals.has(ref)) return `reads ${ref}`;
	}
	const namespaces = new Map<string, string>();
	for (const binding of facts.imports) {
		if (binding.imported === '*' && binding.from) namespaces.set(binding.local, binding.from);
	}
	for (const d of chunk.dynamics) {
		if (d.kind === 'namespace' && d.local && d.from) namespaces.set(d.local, d.from);
	}
	for (const [ns, member] of chunk.members) {
		const from = namespaces.get(ns);
		if (from && carries(from, member)) return `reads ${ns}.${member} (${from})`;
	}
	for (const [ns, from] of namespaces) {
		// A namespace used whole (passed on, spread, iterated) hands every export on.
		const bare = new RegExp(
			`(?<![\\w$.])${escapeRegExp(ns)}(?!\\s*\\??\\.\\s*[A-Za-z_$])(?![\\w$])`,
		);
		const own = facts.blank.slice(chunk.start, chunk.end);
		const declaresIt = chunk.dynamics.some((d) => d.local === ns);
		const uses = declaresIt ? own.replace(new RegExp(`(?:const|let|var)\\s+${ns}\\s*=`), '') : own;
		if (bare.test(uses) && carries(from, '*')) return `uses the whole namespace ${ns} (${from})`;
	}
	for (const d of chunk.dynamics) {
		if (!d.from) continue;
		if (d.kind === 'destructure') {
			for (const [, imported] of d.names) {
				if (carries(d.from, imported)) return `await import(${d.from}) → ${imported}`;
			}
		} else if (d.kind === 'property' && d.property && carries(d.from, d.property)) {
			return `(await import(${d.from})).${d.property}`;
		} else if (d.kind === 'opaque' && carries(d.from, '*')) {
			return `an unanalysed import(${d.from}) of a module that carries the identity`;
		}
	}
	return null;
}

/** Build the flow model over `sources` (repo-relative path → TypeScript source). */
export function buildFlowModel(sources: Map<string, string>): FlowModel {
	const modules = new Map<string, ModuleFacts>();
	const known = new Set(sources.keys());
	for (const [path, source] of sources) modules.set(path, moduleFacts(path, source, known));
	// Fail closed: an import the model cannot follow is a binding it cannot
	// taint, and every leg would go green over it.
	const blind = [...modules.values()].flatMap((facts) =>
		facts.unresolvedImports.map((specifier) => `${facts.path} → '${specifier}'`),
	);
	if (blind.length > 0) {
		throw new Error(
			`release identity flow: relative import(s) naming no module of the analysed set — the model would not see what flows through them:\n  ${blind.join('\n  ')}`,
		);
	}

	// ── identity taint: references through anything, to a fixpoint ──────────
	const identityLocals = new Map<string, Map<string, string>>();
	for (const path of modules.keys()) identityLocals.set(path, new Map());
	identityLocals
		.get(IDENTITY_SEED.module)
		?.set(IDENTITY_SEED.name, 'THE producer of a release identity');
	const carries = exportResolver(modules, identityLocals);
	for (let changed = true; changed; ) {
		changed = false;
		for (const [path, facts] of modules) {
			const locals = identityLocals.get(path) as Map<string, string>;
			for (const binding of facts.imports) {
				if (locals.has(binding.local) || !binding.from || binding.imported === '*') continue;
				if (carries(binding.from, binding.imported)) {
					locals.set(binding.local, `imported as ${binding.imported} from ${binding.from}`);
					changed = true;
				}
			}
			for (const chunk of facts.chunks) {
				if (chunk.names.length === 0 || chunk.names.every((n) => locals.has(n))) continue;
				const reason = chunkTaint(facts, chunk, locals, carries);
				if (reason === null) continue;
				for (const name of chunk.names) locals.set(name, reason);
				changed = true;
			}
		}
	}

	const producers = producerCallables(modules);

	// ── data aliases: value bindings only ────────────────────────────────────
	const dataLocals = new Map<string, Set<string>>();
	for (const path of modules.keys()) dataLocals.set(path, new Set());
	dataLocals.get(DATA_SEED.module)?.add(DATA_SEED.name);
	const isData = exportResolver(modules, dataLocals);
	for (let changed = true; changed; ) {
		changed = false;
		for (const [path, facts] of modules) {
			const locals = dataLocals.get(path) as Set<string>;
			for (const binding of facts.imports) {
				if (locals.has(binding.local) || !binding.from || binding.imported === '*') continue;
				if (isData(binding.from, binding.imported)) {
					locals.add(binding.local);
					changed = true;
				}
			}
			for (const chunk of facts.chunks) {
				if (chunk.callable || chunk.names.length === 0) continue;
				if (chunk.names.every((n) => locals.has(n))) continue;
				// A value may carry BOTH labels (`cond ? DEDALO_VERSION : DEDALO_ENGINE_VERSION`
				// is a mixed value, and a display site showing it is red). The one
				// exemption is the PRODUCER HANDOFF: the triple handed to a producer
				// as an argument (build_stamp.ts → readReleaseIdentityOf) is its
				// input, and the result is the identity, not the data version.
				// And, as for top-level functions, a function INSIDE a value (an
				// action table's handlers) only consults: its body is not the value.
				const refs = identifierRefs(
					withoutFunctionBodies(withoutProducerArgs(producers, facts, chunk)),
				);
				if ([...refs].some((ref) => !chunk.names.includes(ref) && locals.has(ref))) {
					for (const name of chunk.names) locals.add(name);
					changed = true;
				}
			}
		}
	}

	const why = (module: string, local: string): string => {
		const steps: string[] = [];
		let current: [string, string] | null = [module, local];
		const seen = new Set<string>();
		while (current && steps.length < 12) {
			const [m, l]: [string, string] = current;
			if (seen.has(`${m}#${l}`)) break;
			seen.add(`${m}#${l}`);
			const reason = identityLocals.get(m)?.get(l);
			if (reason === undefined) break;
			steps.push(`${m}:${l} — ${reason}`);
			const imported = /^imported as (\S+) from (\S+)$/.exec(reason);
			const read = /^reads ([\w$]+)$/.exec(reason);
			if (imported) {
				current = followExport(
					modules,
					imported[2] as string,
					imported[1] as string,
					identityLocals,
				);
			} else if (read) current = [m, read[1] as string];
			else current = null;
		}
		return steps.join('\n      ← ');
	};

	return {
		modules,
		identityLocals,
		dataLocals,
		producers,
		exportCarriesIdentity: (module, name) => carries(module, name),
		exportIsDataAlias: (module, name) => isData(module, name),
		why,
	};
}

/**
 * The PRODUCERS, per module: the seed itself, every top-level function that
 * calls it directly (build_stamp.ts readReleaseIdentityOf), and every import
 * binding of one. ONE hop on purpose: a function that merely calls a producer
 * may return anything — what it returns is judged, not exempted.
 */
function producerCallables(modules: Map<string, ModuleFacts>): Map<string, Set<string>> {
	const out = new Map<string, Set<string>>();
	for (const path of modules.keys()) out.set(path, new Set());
	const isSeed = (module: string, name: string): boolean => {
		const origin = followExport(modules, module, name, new Map(), 0, true);
		return origin?.[0] === IDENTITY_SEED.module && origin[1] === IDENTITY_SEED.name;
	};
	out.get(IDENTITY_SEED.module)?.add(IDENTITY_SEED.name);
	for (const [path, facts] of modules) {
		const seedLocals = new Set(
			facts.imports
				.filter((b) => b.from && b.imported !== '*' && isSeed(b.from, b.imported))
				.map((b) => b.local),
		);
		if (path === IDENTITY_SEED.module) seedLocals.add(IDENTITY_SEED.name);
		for (const local of seedLocals) out.get(path)?.add(local);
		for (const chunk of facts.chunks) {
			if (chunk.callable && [...chunk.refs].some((ref) => seedLocals.has(ref))) {
				for (const name of chunk.names) out.get(path)?.add(name);
			}
		}
	}
	for (const facts of modules.values()) {
		for (const b of facts.imports) {
			if (!b.from || b.imported === '*') continue;
			const origin = followExport(modules, b.from, b.imported, new Map(), 0, true);
			if (origin && out.get(origin[0])?.has(origin[1])) out.get(facts.path)?.add(b.local);
		}
	}
	return out;
}

/** The chunk's blanked text with the argument lists of producer calls blanked (the handoff). */
function withoutProducerArgs(
	producers: Map<string, Set<string>>,
	facts: ModuleFacts,
	chunk: Chunk,
): string {
	const text = facts.blank.slice(chunk.start, chunk.end);
	const names = producers.get(facts.path);
	if (!names || names.size === 0) return text;
	let out = text;
	for (const m of text.matchAll(new RegExp(`(?<![\\w$.])(${IDENT})\\s*\\(`, 'g'))) {
		if (!names.has(m[1] as string)) continue;
		const open = (m.index ?? 0) + m[0].length - 1;
		const close = balancedClose(text, open);
		out = out.slice(0, open + 1) + ' '.repeat(close - open - 1) + out.slice(close);
	}
	return out;
}

/**
 * Blank every function body inside a value's text: a block after `)` or `=>`
 * (function expression, method, arrow) and an arrow's expression body. Same
 * length, so offsets still hold.
 */
function withoutFunctionBodies(text: string): string {
	let out = text;
	for (const m of text.matchAll(/(?:\)|=>)\s*\{/g)) {
		const open = (m.index ?? 0) + m[0].length - 1;
		const close = balancedClose(text, open);
		out = out.slice(0, open + 1) + ' '.repeat(Math.max(0, close - open - 1)) + out.slice(close);
	}
	for (const m of out.matchAll(/=>\s*(?=[^\s{])/g)) {
		const [s, e] = expressionAt(out, (m.index ?? 0) + m[0].length, false);
		out = out.slice(0, s) + ' '.repeat(e - s) + out.slice(e);
	}
	return out;
}

/** Offset of the bracket closing the one at `open` (or the text's end). */
function balancedClose(text: string, open: number): number {
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		const c = text[i];
		if (c === '(' || c === '{' || c === '[') depth++;
		else if ((c === ')' || c === '}' || c === ']') && --depth === 0) return i;
	}
	return text.length;
}

/** The local an export resolves to (through re-exports), for the `why` chain. */
function followExport(
	modules: Map<string, ModuleFacts>,
	module: string,
	name: string,
	locals: Map<string, Map<string, string>>,
	depth = 0,
	/** Accept the first `export *` hit whatever its taint (the producer census asks WHERE, not whether). */
	anyStar = false,
): [string, string] | null {
	const facts = modules.get(module);
	if (!facts || depth > 20) return null;
	const local = facts.exportAliases.get(name);
	if (local !== undefined) return [module, local];
	const re = facts.reexports.get(name);
	if (re) return followExport(modules, re[0], re[1], locals, depth + 1, anyStar);
	for (const from of facts.starFrom) {
		const hit = followExport(modules, from, name, locals, depth + 1, anyStar);
		if (hit && (anyStar || locals.get(hit[0])?.has(hit[1]))) return hit;
	}
	return null;
}

// ── facts about one module, for the gate's legs ────────────────────────────

/** Every way `module` READS the identity: tainted imports, tainted chunks. */
export function identityReadsOf(
	model: FlowModel,
	module: string,
	onlyChunks?: readonly string[],
): string[] {
	const facts = model.modules.get(module);
	if (!facts) throw new Error(`${module}: not in the analysed source set`);
	const locals = model.identityLocals.get(module) as Map<string, string>;
	const reads: string[] = [];
	if (onlyChunks === undefined) {
		for (const binding of facts.imports) {
			if (binding.imported !== '*' && locals.has(binding.local)) {
				reads.push(
					`imports ${binding.imported} from ${binding.from}:\n      ${model.why(module, binding.local)}`,
				);
			}
		}
	}
	const carries = (m: string, n: string) => model.exportCarriesIdentity(m, n);
	for (const chunk of facts.chunks) {
		if (onlyChunks !== undefined && !chunk.names.some((n) => onlyChunks.includes(n))) continue;
		if (
			chunk.names.length > 0 &&
			onlyChunks === undefined &&
			chunk.names.every((n) => !locals.has(n))
		) {
			continue;
		}
		const reason = chunkTaint(facts, { ...chunk, names: [] }, locals, carries);
		if (reason === null) continue;
		const read = /^reads ([\w$]+)$/.exec(reason);
		const chain = read ? `\n      ${model.why(module, read[1] as string)}` : '';
		reads.push(`${chunk.names.join(',') || '(module statement)'} ${reason}${chain}`);
	}
	return reads;
}

/** Does `module` read a data-version alias through an import (directly)? */
export function readsDataVersion(model: FlowModel, module: string): boolean {
	const facts = model.modules.get(module);
	if (!facts) return false;
	const locals = model.dataLocals.get(module) as Set<string>;
	return (
		facts.imports.some((b) => b.imported !== '*' && locals.has(b.local)) ||
		facts.chunks.some((c) =>
			c.dynamics.some(
				(d) =>
					d.from !== null &&
					[...d.names.values()].some((n) => model.exportIsDataAlias(d.from as string, n)),
			),
		)
	);
}

/**
 * The identity VALUES `module` imports (directly): bindings that resolve to a
 * tainted top-level const — `RELEASE_IDENTITY`, `DEDALO_ENGINE_VERSION`, or
 * any alias of them — not a function that merely consults one.
 */
export function identityValueImports(model: FlowModel, module: string): string[] {
	const facts = model.modules.get(module);
	if (!facts) return [];
	const asked: Array<[string, string]> = [];
	for (const b of facts.imports) if (b.from && b.imported !== '*') asked.push([b.from, b.imported]);
	for (const c of facts.chunks) {
		for (const d of c.dynamics) {
			if (d.from) for (const imported of d.names.values()) asked.push([d.from, imported]);
			if (d.from && d.property) asked.push([d.from, d.property]);
		}
	}
	const out: string[] = [];
	for (const [from, imported] of asked) {
		const origin = followExport(model.modules, from, imported, model.identityLocals);
		if (!origin || !model.identityLocals.get(origin[0])?.has(origin[1])) continue;
		const chunk = model.modules.get(origin[0])?.chunks.find((c) => c.names.includes(origin[1]));
		if (chunk && !chunk.callable) out.push(`${imported} (${from})`);
	}
	return [...new Set(out)].sort();
}

// ── display sites: what flows into one emitted value ───────────────────────

export interface DisplaySite {
	module: string;
	/** The top-level declaration holding the site. */
	fn: string;
	/** Property key whose VALUE is the displayed version; omit to check the `return` expressions. */
	key?: string;
	/** Narrow to the object literal enclosing the first match of this pattern (on the transpiled text). */
	within?: RegExp;
}

export interface SiteValue {
	expression: string;
	identity: string[];
	data: string[];
}

/** Balanced expression starting at `from`, ending before a depth-0 `,` `;` `}` `)` or newline-statement. */
function expressionAt(blank: string, from: number, stopAtNewline: boolean): [number, number] {
	let depth = 0;
	let i = from;
	for (; i < blank.length; i++) {
		const c = blank[i];
		if (c === '(' || c === '{' || c === '[') depth++;
		else if (c === ')' || c === '}' || c === ']') {
			if (depth === 0) break;
			depth--;
		} else if (depth === 0 && (c === ',' || c === ';')) break;
		else if (depth === 0 && stopAtNewline && c === '\n') break;
	}
	return [from, i];
}

/** The innermost `{ … }` of `blank` that encloses offset `at`. */
function enclosingObject(blank: string, at: number): [number, number] {
	let depth = 0;
	let open = -1;
	for (let i = at; i >= 0; i--) {
		const c = blank[i];
		if (c === '}') depth++;
		else if (c === '{') {
			if (depth === 0) {
				open = i;
				break;
			}
			depth--;
		}
	}
	if (open < 0) throw new Error('no enclosing object literal');
	depth = 0;
	for (let i = open; i < blank.length; i++) {
		if (blank[i] === '{') depth++;
		else if (blank[i] === '}' && --depth === 0) return [open, i + 1];
	}
	throw new Error('unbalanced object literal');
}

/** What `classify` collects, plus the declarations it already walked (cycles, re-visits). */
interface Classified {
	identity: Set<string>;
	data: Set<string>;
	walked: Set<string>;
}

/** The top-level declaration a name resolves to: this module's own, or an import's origin. */
function declarationOf(
	model: FlowModel,
	facts: ModuleFacts,
	chunk: Chunk,
	ref: string,
	member: string | null,
): [ModuleFacts, Chunk] | null {
	let origin: [string, string] | null = null;
	if (member === null) {
		const own = facts.chunks.find((c) => c !== chunk && c.names.includes(ref));
		if (own) return [facts, own];
		const binding = facts.imports.find((b) => b.local === ref && b.imported !== '*');
		const dynamic = chunk.dynamics.find((d) => d.kind === 'destructure' && d.names.has(ref));
		if (binding?.from) origin = [binding.from, binding.imported];
		else if (dynamic?.from) origin = [dynamic.from, dynamic.names.get(ref) as string];
	} else {
		const binding = facts.imports.find((b) => b.local === ref && b.imported === '*');
		if (binding?.from) origin = [binding.from, member];
	}
	if (origin === null) return null;
	const local = followExport(model.modules, origin[0], origin[1], new Map(), 0, true);
	const module = local ? model.modules.get(local[0]) : undefined;
	const declared = module?.chunks.find((c) => c.names.includes((local as [string, string])[1]));
	return module && declared ? [module, declared] : null;
}

/**
 * Walk a top-level declaration a value reaches: a function's `return`
 * expressions, a value's initializer. This is what makes a HOISTED mix red
 * (`const SHOWN = kind === 'prerelease' ? DEDALO_VERSION : DEDALO_ENGINE_VERSION`,
 * or a helper returning either): the value's own taint says "identity", the
 * walk finds the data version inside it. The producer handoff stays exempt.
 */
function walkDeclaration(
	model: FlowModel,
	facts: ModuleFacts,
	chunk: Chunk,
	out: Classified,
	depth: number,
): void {
	const key = `${facts.path}@${chunk.start}`;
	if (out.walked.has(key)) return;
	out.walked.add(key);
	const text = withoutProducerArgs(model.producers, facts, chunk);
	if (!chunk.callable) {
		classify(model, facts, chunk, text, out, depth + 1);
		return;
	}
	for (const m of text.matchAll(/\breturn\b/g)) {
		const [s, e] = expressionAt(text, (m.index ?? 0) + m[0].length, true);
		classify(model, facts, chunk, text.slice(s, e), out, depth + 1);
	}
}

/** Classify every identifier an expression reads: identity-sourced, data alias, or neither (recursing into locals and the declarations they reach). */
function classify(
	model: FlowModel,
	facts: ModuleFacts,
	chunk: Chunk,
	expression: string,
	out: Classified,
	depth: number,
): void {
	if (depth > 12) return;
	const ilocals = model.identityLocals.get(facts.path) as Map<string, string>;
	const dlocals = model.dataLocals.get(facts.path) as Set<string>;
	const body = withoutProducerArgs(model.producers, facts, chunk);
	for (const ref of identifierRefs(expression)) {
		if (ilocals.has(ref) && !chunk.names.includes(ref)) out.identity.add(ref);
		if (dlocals.has(ref) && !chunk.names.includes(ref)) out.data.add(ref);
		// A binding of the chunk's own `const { x } = await import(…)`.
		for (const d of chunk.dynamics) {
			const imported = d.kind === 'destructure' && d.from ? d.names.get(ref) : undefined;
			if (imported === undefined || !d.from) continue;
			if (model.exportCarriesIdentity(d.from, imported)) out.identity.add(ref);
			if (model.exportIsDataAlias(d.from, imported)) out.data.add(ref);
		}
		// An inner local: follow its initializer (const/let/var, a parameter default).
		const decl = new RegExp(
			`(?:\\b(?:const|let|var)\\s+|[(,]\\s*)${escapeRegExp(ref)}\\s*=(?![=>])`,
		).exec(body);
		if (decl && !chunk.names.includes(ref)) {
			const begin = decl.index + decl[0].length;
			const [s, e] = expressionAt(body, begin, true);
			const inner = body.slice(s, e);
			if (!out.walked.has(`${facts.path}@${chunk.start}#${ref}`)) {
				out.walked.add(`${facts.path}@${chunk.start}#${ref}`);
				classify(model, facts, chunk, inner, out, depth + 1);
			}
			continue;
		}
		// A top-level declaration (own or imported): walk what it returns / holds.
		const declared = declarationOf(model, facts, chunk, ref, null);
		if (declared) walkDeclaration(model, declared[0], declared[1], out, depth);
	}
	for (const [ns, member] of memberRefs(expression)) {
		const binding = facts.imports.find((b) => b.local === ns && b.imported === '*');
		if (binding?.from && model.exportCarriesIdentity(binding.from, member))
			out.identity.add(`${ns}.${member}`);
		if (binding?.from && model.exportIsDataAlias(binding.from, member))
			out.data.add(`${ns}.${member}`);
		const declared = binding?.from ? declarationOf(model, facts, chunk, ns, member) : null;
		if (declared) walkDeclaration(model, declared[0], declared[1], out, depth);
	}
}

const LITERAL_WORDS = new Set(['null', 'undefined', 'true', 'false', 'void', 'typeof']);

/** Every value the site emits (skipping pure literals such as `null`), classified. */
export function siteValues(model: FlowModel, site: DisplaySite): SiteValue[] {
	const facts = model.modules.get(site.module);
	if (!facts) throw new Error(`${site.module}: not in the analysed source set`);
	const chunk = facts.chunks.find((c) => c.names.includes(site.fn));
	if (!chunk) throw new Error(`${site.module}: no top-level declaration '${site.fn}'`);
	let [start, end] = [chunk.start, chunk.end];
	if (site.within) {
		const anchor = site.within.exec(facts.code.slice(start, end));
		if (!anchor) throw new Error(`${site.module}:${site.fn}: anchor ${site.within} not found`);
		[start, end] = enclosingObject(facts.blank, start + anchor.index);
	}
	const region = facts.blank.slice(start, end);
	const values: SiteValue[] = [];
	const pattern = site.key ? new RegExp(`(?<=[{,\\s])${site.key}\\s*:(?!:)`, 'g') : /\breturn\b/g;
	for (const m of region.matchAll(pattern)) {
		const [s, e] = expressionAt(region, (m.index ?? 0) + m[0].length, !site.key);
		const expression = region.slice(s, e);
		const names = [...identifierRefs(expression)].filter((ref) => !LITERAL_WORDS.has(ref));
		if (names.length === 0) continue; // a literal (null, '') names nothing
		const out: Classified = { identity: new Set(), data: new Set(), walked: new Set() };
		classify(model, facts, chunk, expression, out, 0);
		values.push({
			expression: expression.trim(),
			identity: [...out.identity],
			data: [...out.data],
		});
	}
	return values;
}

// ── the source set ─────────────────────────────────────────────────────────

/**
 * The engine's modules: src/ plus every tool's server/ tree — read through the
 * registered write-path lister (census_derivation_tripwire: a gate never
 * chooses a root of its own), keeping the code the server process runs.
 */
export function engineSources(): Map<string, string> {
	const out = new Map<string, string>();
	for (const file of writePathSourceFiles()) {
		if (file.endsWith('.d.ts')) continue;
		if (!file.startsWith('src/') && !(file.startsWith('tools/') && file.includes('/server/')))
			continue;
		out.set(file, readFileSync(join(REPO_ROOT, file), 'utf8'));
	}
	// …plus the code those modules IMPORT from outside the two trees (the
	// publication host agent, install/db, a client leaf the server shares):
	// it runs in the server process too, and a version can flow through it.
	// Followed import by import, never by choosing another root to walk.
	const queue = [...out.keys()];
	for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
		for (const specifier of relativeSpecifiers(transpile(file, out.get(file) as string))) {
			const target = relative(REPO_ROOT, resolve(dirname(join(REPO_ROOT, file)), specifier));
			const candidates = resolutionCandidates(target);
			if (candidates.some((candidate) => out.has(candidate))) continue;
			const found = candidates.find((candidate) => isCodePath(candidate) && isFile(candidate));
			if (found === undefined) continue; // a data file, or unresolvable: buildFlowModel judges
			out.set(found, readFileSync(join(REPO_ROOT, found), 'utf8'));
			queue.push(found);
		}
	}
	return out;
}

function isFile(repoPath: string): boolean {
	try {
		return statSync(join(REPO_ROOT, repoPath)).isFile();
	} catch {
		return false;
	}
}

/** The browser sources (the registered browser lister, vendored code excluded), repo-relative. */
export function clientSources(): string[] {
	return browserSources();
}

// ── client: no numeric read of the identity ────────────────────────────────

/**
 * Operations that read a version as NUMBERS or ORDER it — the regression family
 * (`'7.0.0-beta.6'.split('.')` → NaN). After the value (`.split(`…) or around
 * it (`Number(`, `parseInt(`, a RegExp `.exec(` / `.test(` — how the client
 * parses a version —, a relational operator, unary `+`).
 */
const NUMERIC_AFTER =
	/^\s*(?:\?\.|\.)\s*(?:split|match|matchAll|localeCompare|charCodeAt|codePointAt)\s*\(|^\s*(?:<=?|>=?|-(?!-)|\*|\/(?![/*]))(?!>)/;
const NUMERIC_BEFORE =
	/(?:\b(?:Number|parseInt|parseFloat|Math\.\w+)\s*\(\s*|\.\s*(?:exec|test)\s*\(\s*|(?:<=?|>=?|[-*/])\s*|(?:^|[=(,:?&|!]\s*)\+\s*)$/;
/**
 * String-returning methods: the value flows THROUGH them still a version
 * string — `.replace(/\.dev$/, '')` then `.split('.')` is exactly how
 * pre-identity code read it, and on `7.0.0-beta.6` it yields NaN.
 */
const PASS_METHOD =
	/^\s*(?:\?\.|\.)\s*(?:trim|trimStart|trimEnd|toString|valueOf|toLowerCase|toUpperCase|toLocaleLowerCase|toLocaleUpperCase|replace|replaceAll|slice|substring|substr|padStart|padEnd|normalize|concat|at)\s*\(/;
/** A `|| ''` / `?? null` fallback. */
const PASS_FALLBACK = /^\s*(?:\|\||\?\?)\s*(?:''|""|``|null|undefined|'[^']*'|"[^"]*")/;

/** Length of the value-preserving step right after a value, or 0. */
function passAfter(text: string): number {
	const method = PASS_METHOD.exec(text);
	if (method) {
		const close = balancedClose(text, method[0].length - 1);
		return close < text.length ? close + 1 : 0;
	}
	return PASS_FALLBACK.exec(text)?.[0].length ?? 0;
}

/**
 * Every place a client source reads `<x>.dedalo_version` (the release identity
 * of page_globals / info_data) as numbers — read as a member, a computed
 * `['dedalo_version']` member or a destructured binding; directly, through
 * value-preserving wrappers (`String(…)`, a template literal holding only it,
 * `.trim()`, `.replace(…)`, `.slice(…)`, `|| ''`), or through a local it was
 * bound to. Passing it to the client leaf (release_identity.js) ENDS the flow:
 * that is the door, and it returns no identity.
 */
export interface ClientIdentityReads {
	/** Every `<object>.dedalo_version` read: its line and the object it is read from. */
	sources: Array<{ line: number; object: string }>;
	/** The numeric ones, with the object they started from. */
	numeric: Array<{ line: number; object: string; detail: string }>;
}

export function clientNumericReads(source: string, field = 'dedalo_version'): ClientIdentityReads {
	const options = { keepTemplateSubstitutions: true, blankRegexBodies: true };
	const blank = stripComments(source, { ...options, blankStrings: true });
	// Strings KEPT (for `obj['dedalo_version']`), same offsets as `blank`.
	const kept = stripComments(source, options);
	if (kept.length !== blank.length) {
		throw new Error('clientNumericReads: the two scans disagree on length — offsets would drift');
	}
	const result: ClientIdentityReads = { sources: [], numeric: [] };
	const lineOf = (at: number) => blank.slice(0, at).split('\n').length;
	const usesOf = (name: string) =>
		new RegExp(`(?<![\\w$.])${escapeRegExp(name)}(?![\\w$])(?!\\s*:(?!:))(?!\\s*=[^=>])`, 'g');
	/** Visit every use of a local that holds the identity, from offset `from` on. */
	const followBinding = (
		name: string,
		from: number,
		label: string,
		object: string,
		seen: Set<string>,
	) => {
		if (seen.has(name)) return;
		seen.add(name);
		for (const use of blank.slice(from).matchAll(usesOf(name))) {
			const at = from + (use.index ?? 0);
			visit(at, at + name.length, `${label} (as '${name}')`, object, seen);
		}
	};
	const visit = (start: number, end: number, label: string, object: string, seen: Set<string>) => {
		let [s, e] = [start, end];
		for (let moved = true; moved; ) {
			moved = false;
			const pass = passAfter(blank.slice(e));
			if (pass > 0) {
				e += pass;
				moved = true;
			}
			// `String(x)` or a bare grouping paren — never a call like `parseInt(x)`, which NUMERIC_BEFORE must see.
			const before = blank.slice(Math.max(0, s - 40), s);
			const wrap = /(?:\bString\s*\(|(?<![\w$\])]\s*)\()\s*$/.exec(before);
			const close = /^\s*\)/.exec(blank.slice(e));
			if (wrap && close) {
				s -= wrap[0].length;
				e += close[0].length;
				moved = true;
				continue;
			}
			// A template literal whose only substitution is the value: still the value.
			const tplOpen = /`\s*\$\{\s*$/.exec(before);
			const tplClose = /^\s*\}\s*`/.exec(blank.slice(e));
			if (tplOpen && tplClose) {
				s -= tplOpen[0].length;
				e += tplClose[0].length;
				moved = true;
			}
		}
		const before = blank.slice(Math.max(0, s - 40), s);
		const after = blank.slice(e, e + 40);
		if (NUMERIC_AFTER.test(after) || NUMERIC_BEFORE.test(before)) {
			result.numeric.push({
				line: lineOf(s),
				object,
				detail: `${label} read as numbers — \`${blank
					.slice(s, e + 12)
					.replace(/\s+/g, ' ')
					.trim()}\``,
			});
			return;
		}
		const bound = new RegExp(
			`(?:\\b(?:const|let|var)\\s+|(?<![\\w$.])(?=${IDENT}\\s*=[^=]))(${IDENT})\\s*=\\s*$`,
		).exec(blank.slice(Math.max(0, s - 80), s));
		if (bound) followBinding(bound[1] as string, e, label, object, seen);
	};
	/** The object chain a read starts from (`page_globals`, `self.info_data` …). */
	const objectBefore = (at: number): [number, string] => {
		const chain = new RegExp(`(?:${IDENT}\\s*\\??\\.\\s*)*${IDENT}\\s*$`).exec(
			blank.slice(Math.max(0, at - 80), at),
		);
		const object = chain ? chain[0].replace(/\s+/g, '').replace(/\??\.$/, '') : '';
		return [chain ? at - chain[0].length : at, object];
	};
	const seed = (at: number, end: number) => {
		const [start, object] = objectBefore(at);
		result.sources.push({ line: lineOf(start), object });
		visit(start, end, field, object, new Set());
	};
	// `<obj>.dedalo_version` (not an object-literal key, not an assignment target).
	for (const m of blank.matchAll(
		new RegExp(`\\??\\.\\s*${field}\\b(?!\\s*:(?!:))(?!\\s*=[^=])`, 'g'),
	)) {
		seed(m.index ?? 0, (m.index ?? 0) + m[0].length);
	}
	// `<obj>['dedalo_version']` — read on the strings-kept text.
	for (const m of kept.matchAll(
		new RegExp(`(?:\\?\\.)?\\s*\\[\\s*(['"\`])${field}\\1\\s*\\](?!\\s*=[^=])`, 'g'),
	)) {
		seed(m.index ?? 0, (m.index ?? 0) + m[0].length);
	}
	// `const { dedalo_version } = <obj>` / `{ dedalo_version: v } = <obj>`.
	for (const m of blank.matchAll(/\{([^{}]*)\}\s*=(?![=>])\s*/g)) {
		const local = patternNames(m[1] as string).find(([, key]) => key === field)?.[0];
		if (local === undefined) continue;
		const end = (m.index ?? 0) + m[0].length;
		const chain = new RegExp(`^(?:${IDENT}\\s*\\??\\.\\s*)*${IDENT}`).exec(blank.slice(end));
		const object = chain ? chain[0].replace(/\s+/g, '') : '';
		result.sources.push({ line: lineOf(m.index ?? 0), object });
		followBinding(local, end, `${field} (destructured)`, object, new Set());
	}
	return result;
}
