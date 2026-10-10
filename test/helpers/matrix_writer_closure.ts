/**
 * THE MATRIX WRITER CLOSURE — which declarations in the write-path corpus can
 * reach a raw `db/matrix_write.ts` DML primitive, and by which path.
 *
 * Shared by two gates that each used to carry half of it:
 *   - `write_obligations_tripwire` (leg A): the primitive list DERIVED from the
 *     module's exports minus the declared non-DML ones, the line-based
 *     top-level declaration splitter and `rawCallsIn` (a primitive CALLED by
 *     name inside a declaration). Moved here verbatim; its output is unchanged.
 *   - `tool_lossless_writeback_tripwire` (leg 4): the tool write-back census.
 *     Its server doors used to be a hand list of four `src` names, so a tool
 *     that wrote through any other engine (or through a raw primitive, as
 *     `updateCache` does with `updateMatrixKeyData` behind a dynamic import)
 *     was invisible to it. The doors are now DERIVED: the SEEDS — the primitives,
 *     and the OFF-HOME psql writers (`psqlSeeds`: a declaration with a
 *     BINDING-RESOLVED edge to `pg_exec.ts#runPsql` — named, aliased, namespace
 *     member or a `deps ?? runPsql` value — that carries a matrix DML statement,
 *     past every chokepoint) — plus
 *     every declaration that reaches one through IMPORT-RESOLVED references
 *     (`buildWriterClosure`), taken where a `tools/<tool>/server` declaration
 *     crosses out of its own tool, or IS a psql seed itself (`toolServerCells`).
 *
 * HOW A REFERENCE RESOLVES (never by bare name):
 *   - a binding declared INSIDE the declaration's body (a dynamic import:
 *     `const {a, b: c} = await import('…')`, `const ns = await import('…')`,
 *     `import('…').then(({a}) =>`, `const [{a}, ns] = await Promise.all([import('…'), …])`,
 *     `(await import('…')).a`) wins over a file-level one;
 *   - then the file's static imports (`import {a as b}`, `import * as ns`, the
 *     DEFAULT clause `import w from` → the module's `default`), with
 *     `export {a} from` / `export * from` / `export {a as b}` followed through;
 *   - then the file's MODULE-SCOPE dynamic bindings — the same forms at column 0
 *     (top-level await), which every unit of the file sees, not only the one whose
 *     line range holds the statement;
 *   - then a same-file top-level declaration of that name;
 *   - anything else (a local variable, a global, a property `obj.a`) is no edge.
 *   Only relative specifiers that resolve to corpus files count (a `.js` spelling
 *   names the `.ts` beside it, as Bun resolves it). `export default` resolves to
 *   the named declaration, or to an anonymous `default` unit.
 *
 * A LOCAL HOLDING a value-position import is a namespace binding: `[const] m =`
 * whose initializer is the import, optionally behind an injectable-deps fallback or
 * in a ternary branch (`deps ?? (await import('x'))`, `c ? null : await import('x')`,
 * `m = await import('x')`) — so `m.name` / `m?.name` is a resolved edge counted per
 * SITE (a new call is a new site).
 *
 * A NAMESPACE THAT ESCAPES AS A VALUE reaches EVERY export of its module
 * (conservative — an over-approximation, never a missing edge): a bare `ns` not
 * followed by `.name` (passed, returned, spread, compared), and a literal-specifier
 * `import('x')` in any position nothing above binds (`return await import('x')`, an
 * argument, a property assignment). Its site count is the OCCURRENCE count, not the
 * receiver's calls. Only a WHOLE expression statement `await import('x');` is a
 * side-effect load (namespace discarded). Escape edges count for MEMBERSHIP
 * (`reaches`, `edgesOf`) but never as PROOF (`reachesPrecisely`, `preciseEdgesOf`).
 *
 * NOTHING IS DROPPED SILENTLY — three reports, each held by
 * tool_lossless_writeback over the whole corpus:
 *   - `unresolvedDynamicImports`: a COMPUTED-specifier `import(spec)` site, at its
 *     FILE line (a literal specifier is always resolved, bound, escaped or reported
 *     below);
 *   - `outOfCorpusImports`: a relative import naming no corpus file (with the path it
 *     names) — static, re-export, AND a literal dynamic `import('x')` in every form
 *     (destructure, namespace, `.then`, `(await import('x')).a`, Promise.all, holder,
 *     escape, side-effect load);
 *   - `unresolvedBindings`: a corpus-targeted reference — a bound name, a
 *     `ns.member`, a `(await import('x')).a`, every static import name — whose
 *     EXPORT does not resolve (a type-only export resolves, with no edge).
 *
 * SCANNING SOURCE: `stripComments(src, {blankStrings, keepTemplateSubstitutions,
 * blankRegexBodies})` with the static import/export-from statements and the
 * dynamic-import binding statements blanked — so a string or comment that
 * MENTIONS a writer is no edge, and a binding site is not a reference site. A
 * TYPE unit (`<type:Name>`) has its declaration blanked too — an interface's
 * method signatures are no reference — but not a runtime statement after it.
 *
 * WHAT IT DOES NOT SEE (stated, because an unstated gap reads as coverage):
 * binding is lexical and scope-approximate (a local variable that shadows a
 * same-file top-level name is taken for it; a column-0 statement is taken for
 * module scope); `this.x()` and property-object dispatch (`registry[name](…)`, a
 * callback handed to a non-writer) are unseen; a computed-specifier `import(spec)`
 * is not followed (reported, not resolved); a file OUTSIDE the corpus is not
 * followed (reported by `outOfCorpusImports`); raw DML on the POOL outside
 * `matrix_write.ts` (T2.a), a psql statement built in one declaration and run by
 * another, a whole-database `psql -f` restore, and a psql child spawned DIRECTLY
 * (`Bun.spawn(['psql', …])` — `ontology/data_io.ts#runCopyExport`,
 * `scripts/test_db_setup.ts#psql`) rather than through `runPsql` are not seeds;
 * the declaration
 * splitter reads column-0 lines of
 * a biome-formatted tree (`function`/`const`/`let`/`var`/`[abstract] class`/
 * `[const] enum`/`interface`/`type`/`export default`).
 *
 * This module does NO walk: its default corpus is `writePathSourceFiles()`, the
 * shared lister, called with no argument — it chooses no root.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { stripComments } from './strip_comments.ts';
import { REPO_ROOT, writePathSourceFiles } from './write_path_corpus.ts';

const readRepoFile = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8');

export const MATRIX_WRITE = 'src/core/db/matrix_write.ts';

/**
 * Exports of db/matrix_write.ts that are NOT matrix DML. Each needs a reason: the
 * point of deriving the primitive list from the module is that classifying a new
 * export is a decision somebody makes HERE, not an omission nobody notices.
 */
export const MATRIX_WRITE_NON_DML: Record<string, string> = {
	readMatrixKeyForUpdate:
		'a locked READ (SELECT … FOR UPDATE); the write that follows it is a primitive.',
	allocateComponentItemId:
		'writes the per-component item COUNTER in `meta`, never a component value; the value write that consumes the id is a primitive.',
	absorbComponentItemIds: 'raises the same item counter after a value write; no component value.',
	counterTableFor: 'a pure name derivation (matrix table → its counter table).',
	counterFloorExpression: 'a pure SQL fragment builder for the counter floor.',
	insertMatrixRowSequenceId:
		'DML on a SEQUENCE-ID table (matrix_activity — the door refuses any other, SEQUENCE_ID_MATRIX_TABLES): an audit row, not a curated record — no component value, no stamp, no TM, no RAG obligation. Moved into the writer home by P1-15 (T2), classified here so the census stays TOTAL over the module.',
	appendMatrixUpdateRow:
		'DML on matrix_updates (the update-process version / marker rows): system bookkeeping, not a curated record — no component value, no stamp, no TM, no RAG obligation. Moved into the writer home by P1-15 (T2).',
	MATRIX_COPY_COLUMNS:
		'a frozen column-name LIST (the psql \\copy export order); data, not a callable — nothing can write through it.',
	SEQUENCE_ID_MATRIX_TABLES:
		'the table allowlist insertMatrixRowSequenceId checks; data, not a callable — the door itself is classified above.',
	AGE_PRUNABLE_MATRIX_TABLES:
		'the table allowlist pruneMatrixEventRowsByAge checks; data, not a callable — the door itself is a primitive.',
	asRawJsonText:
		'a re-export of json_codec.ts#asRawJsonText, a pure marker wrapper for pre-encoded jsonb text; it issues no SQL.',
};

/**
 * Every RUNTIME export of a module, in source order: `export [async] function[*]`,
 * `export const|let|var|[abstract] class|[const] enum`, the names of `export { … }`
 * lists (with or without `from`; `type` entries dropped), and `default` for ANY
 * `export default …` (a named `export default function f` exports `default`, not
 * `f`). Type-only exports (`export type`, `export interface`, `export declare`) are
 * not runtime and are not listed. An `export * from` cannot be enumerated from this
 * module's text, so it THROWS — a primitive hidden behind one would otherwise be
 * unclassifiable; so does a DESTRUCTURED export (`export const { a } = …`).
 */
export function moduleRuntimeExports(source: string): string[] {
	const found: { name: string; at: number }[] = [];
	for (const match of source.matchAll(
		/^export\s+(?:async\s+)?(?:function\*?|(?:const\s+)?enum|const|let|var|(?:abstract\s+)?class)\s+([A-Za-z0-9_$]+)/gm,
	)) {
		found.push({ name: match[1] as string, at: match.index });
	}
	for (const match of source.matchAll(/^export\s+default\b/gm)) {
		found.push({ name: 'default', at: match.index });
	}
	for (const match of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
		for (const raw of (match[1] as string).split(',')) {
			const entry = raw.trim();
			if (entry === '' || entry.startsWith('type ')) continue;
			const exported = /(?:^|\s)as\s+([A-Za-z_$][\w$]*)$/.exec(entry)?.[1] ?? entry;
			if (/^[A-Za-z_$][\w$]*$/.test(exported)) found.push({ name: exported, at: match.index });
		}
	}
	if (/^export\s+\*/m.test(source)) {
		throw new Error(
			'matrix_writer_closure: `export * …` cannot be enumerated — list the re-exported names explicitly',
		);
	}
	// `export const { a, b } = …` / `export let [c] = …` export names the patterns above
	// cannot read: refused, like `export *`, rather than silently unlisted
	if (/^export\s+(?:const|let|var)\s*[{[]/m.test(source)) {
		throw new Error(
			'matrix_writer_closure: a DESTRUCTURED export (`export const { a } = …`) cannot be enumerated — export each name explicitly',
		);
	}
	return found.sort((a, b) => a.at - b.at).map((entry) => entry.name);
}

/**
 * The raw DML primitives, DERIVED from the module's RUNTIME exports (every form,
 * not only `export function`) minus the declared non-DML — so an `export const
 * x = async () => …` writer, or a name exported through `export { … }`, is a
 * primitive until somebody classifies it with a reason.
 */
export function deriveRawPrimitives(source: string = readRepoFile(MATRIX_WRITE)): string[] {
	const primitives = moduleRuntimeExports(source).filter(
		(name) => MATRIX_WRITE_NON_DML[name] === undefined,
	);
	// A default-exported primitive has no call NAME: the name-based census (leg A's
	// rawCallsIn) could never see a call to it. Refuse it rather than seed a blind spot.
	if (primitives.includes('default')) {
		throw new Error(
			'matrix_writer_closure: db/matrix_write.ts has an unclassified `export default` — export the primitive by name',
		);
	}
	return primitives;
}

export const RAW_PRIMITIVES = deriveRawPrimitives();

/** One raw primitive call, resolved to the top-level declaration that contains it. */
export interface RawCall {
	file: string;
	/** `<file>#<declaration>` — the census key. */
	key: string;
	primitive: string;
	body: string;
}

/**
 * Split a (comment-stripped) module into its top-level declarations: every
 * `function`/`const`/`let`/`class` that starts at column 0 opens a block that
 * runs to the next such line. Good enough for this tree (biome-formatted, one
 * declaration per top-level statement) and, crucially, verified by the gates'
 * positive controls so a formatting drift that broke the splitter would be red,
 * not silently green. `exported` says whether the opening line is `export …`.
 */
export function topLevelBlocks(
	source: string,
): { name: string; body: string; exported: boolean }[] {
	const lines = source.split('\n');
	return topLevelRanges(lines).map((range) => ({
		name: range.name,
		body: lines.slice(range.start, range.end).join('\n'),
		exported: range.exported,
	}));
}

/** The line ranges behind `topLevelBlocks` (the `<module>` range first, possibly empty). */
function topLevelRanges(
	lines: string[],
	typeDeclarations = false,
): { name: string; start: number; end: number; exported: boolean }[] {
	const starts: { index: number; name: string; exported: boolean }[] = [];
	// Leg A's splitter (typeDeclarations false) is byte-unchanged. The closure's
	// (typeDeclarations true) also opens a unit at every other column-0 RUNTIME
	// declaration form — `var`, `abstract class`, `[const] enum` — so such a body is
	// never credited to the declaration above it and its name is `declared`; and an
	// ANONYMOUS `export default …` (an expression, an arrow, `export default ident;`)
	// is a unit named `default`, what an importer's `import w from` resolves to.
	const declaration = typeDeclarations
		? /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|(?:const\s+)?enum|const|let|var|(?:abstract\s+)?class)\s+([A-Za-z0-9_$]+)/
		: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z0-9_$]+)/;
	// The closure also ends a block at a column-0 `interface` / `type` (a unit of
	// its own, `<type:Name>`), so an interface's property keys and method
	// signatures are never read as references of the function above it.
	const typeDeclaration = /^(?:export\s+)?(?:declare\s+)?(?:interface|type)\s+([A-Za-z0-9_$]+)/;
	lines.forEach((line, index) => {
		const match = declaration.exec(line);
		if (match?.[1] !== undefined) {
			starts.push({ index, name: match[1], exported: line.startsWith('export') });
			return;
		}
		if (!typeDeclarations) return;
		const typed = typeDeclaration.exec(line);
		if (typed?.[1] !== undefined) {
			starts.push({ index, name: `<type:${typed[1]}>`, exported: line.startsWith('export') });
			return;
		}
		// `export default ident;` only ALIASES a declaration (parseFile maps `default` to
		// it): a unit of its own, `<default>`, so its line is nobody's reference
		if (/^export\s+default\s+[A-Za-z_$][\w$]*\s*;?\s*$/.test(line)) {
			starts.push({ index, name: '<default>', exported: true });
		} else if (/^export\s+default\b/.test(line)) {
			starts.push({ index, name: 'default', exported: true });
		}
	});
	// Everything before the first declaration (imports, module-level calls).
	const ranges = [
		{ name: '<module>', start: 0, end: starts[0]?.index ?? lines.length, exported: false },
	];
	starts.forEach((start, position) => {
		ranges.push({
			name: start.name,
			start: start.index,
			end: starts[position + 1]?.index ?? lines.length,
			exported: start.exported,
		});
	});
	return ranges;
}

/** THE one definition of "this body CALLS `name`" (never `obj.name(`, never `xname(`). */
export function callsName(body: string, name: string): boolean {
	return new RegExp(`(?<![.\\w])${name}\\(`).test(body);
}

/** A string blanker that keeps offsets: every non-newline char in [start,end) becomes a space. */
function blankSpan(text: string, start: number, end: number): string {
	return text.slice(0, start) + text.slice(start, end).replace(/[^\n]/g, ' ') + text.slice(end);
}

/** Structure view of a code fragment (strings/regex bodies blanked, offsets kept). */
function structureOf(code: string): string {
	const structure = stripComments(code, {
		blankStrings: true,
		keepTemplateSubstitutions: true,
		blankRegexBodies: true,
	});
	if (structure.length !== code.length) {
		throw new Error('matrix_writer_closure: the structure view lost offset alignment');
	}
	return structure;
}

/**
 * The `apiActions` entries of a top-level `tool` object, as `[name, start, end]`
 * offsets into `structure` (strings blanked, so a brace inside a reason string
 * does not move the depth). Empty when the block is not such an object.
 */
function apiActionSpans(structure: string): { name: string; start: number; end: number }[] {
	const anchor = /\bapiActions\s*:\s*\{/.exec(structure);
	if (anchor === null) return [];
	const spans: { name: string; start: number; end: number }[] = [];
	let index = anchor.index + anchor[0].length;
	let depth = 0;
	let entryStart = -1;
	let entryName = '';
	const close = (at: number) => {
		if (entryStart !== -1) spans.push({ name: entryName, start: entryStart, end: at });
		entryStart = -1;
	};
	for (; index < structure.length; index++) {
		const char = structure[index] as string;
		if (depth === 0) {
			if (char === '}') {
				close(index);
				break;
			}
			if (char === ',') {
				close(index);
				continue;
			}
			if (entryStart === -1 && /[A-Za-z_$]/.test(char)) {
				const key = /^([A-Za-z_$][\w$]*)\s*:/.exec(structure.slice(index));
				if (key?.[1] !== undefined) {
					entryStart = index;
					entryName = key[1];
					index += key[0].length - 1;
					continue;
				}
			}
		}
		if (char === '{' || char === '(' || char === '[') depth++;
		else if (char === '}' || char === ')' || char === ']') depth--;
	}
	return spans;
}

/**
 * Split one top-level block into the units the censuses key on: the block
 * itself, except that a top-level `tool` object with `apiActions:` gives one
 * unit per action (`tool.apiActions.<name>`) and keeps the rest as `tool`.
 * `structure` is the block's offset-aligned structure view.
 */
function splitUnits(
	name: string,
	body: string,
	structure: string,
): { name: string; body: string; structure: string; lineOffset: number }[] {
	if (name !== 'tool') return [{ name, body, structure, lineOffset: 0 }];
	const spans = apiActionSpans(structure);
	if (spans.length === 0) return [{ name, body, structure, lineOffset: 0 }];
	const units: { name: string; body: string; structure: string; lineOffset: number }[] = [];
	let restBody = body;
	let restStructure = structure;
	for (const span of spans) {
		units.push({
			name: `tool.apiActions.${span.name}`,
			body: body.slice(span.start, span.end),
			structure: structure.slice(span.start, span.end),
			// lines of the block before the action's first character
			lineOffset: body.slice(0, span.start).split('\n').length - 1,
		});
		restBody = blankSpan(restBody, span.start, span.end);
		restStructure = blankSpan(restStructure, span.start, span.end);
	}
	units.unshift({ name, body: restBody, structure: restStructure, lineOffset: 0 });
	return units;
}

/**
 * Per top-level declaration (a `tool.apiActions` object split per action), the
 * `doors` its body CALLS by name — in the order of the `doors` argument,
 * deduplicated (so `rawCallsIn` keeps RAW_PRIMITIVES order, which `judge`'s
 * message depends on). Declarations that call none are omitted.
 */
export function declarationDoorCalls(
	file: string,
	source: string,
	doors: readonly string[],
): { file: string; name: string; doors: string[]; body: string }[] {
	const out: { file: string; name: string; doors: string[]; body: string }[] = [];
	for (const block of topLevelBlocks(source)) {
		const units =
			block.name === 'tool' ? splitUnits(block.name, block.body, structureOf(block.body)) : [block];
		for (const unit of units) {
			const called: string[] = [];
			for (const door of doors) {
				if (!called.includes(door) && callsName(unit.body, door)) called.push(door);
			}
			if (called.length > 0) out.push({ file, name: unit.name, doors: called, body: unit.body });
		}
	}
	return out;
}

export function rawCallsIn(
	file: string,
	source: string,
	primitives: readonly string[] = RAW_PRIMITIVES,
): RawCall[] {
	return declarationDoorCalls(file, source, primitives).flatMap((declaration) =>
		declaration.doors.map((primitive) => ({
			file,
			key: `${file}#${declaration.name}`,
			primitive,
			body: declaration.body,
		})),
	);
}

// ---------------------------------------------------------------------------
// Import bindings
// ---------------------------------------------------------------------------

/** Where a local name points: an export of a corpus file, or a whole module (namespace). */
export type BindingTarget = { file: string; name: string } | { ns: string };

/** Is `spec` a RELATIVE module specifier (the only kind that can name a corpus file)? */
const isRelativeSpecifier = (spec: string): boolean =>
	spec.startsWith('./') || spec.startsWith('../');

/**
 * Resolve a relative specifier to a corpus file, or null (package / node: / outside
 * the corpus). As Bun does, a `.js` / `.mjs` / `.jsx` spelling also names the `.ts`
 * / `.tsx` source beside it — `import … from './x.js'` loads `x.ts`.
 */
function resolveSpecifier(from: string, spec: string, corpus: ReadonlySet<string>): string | null {
	if (!isRelativeSpecifier(spec)) return null;
	const base = normalize(join(dirname(from), spec));
	const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')];
	const jsSpelling = /\.(?:m?js|jsx)$/.exec(base);
	if (jsSpelling !== null) {
		const stem = base.slice(0, jsSpelling.index);
		candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`);
	}
	for (const candidate of candidates) {
		if (corpus.has(candidate)) return candidate;
	}
	return null;
}

/** `a, b as c, type T` → [[local, imported]] (type-only entries dropped). */
function importSpecifierList(list: string): [string, string][] {
	const out: [string, string][] = [];
	for (const raw of list.split(',')) {
		const entry = raw.trim();
		if (entry === '' || entry.startsWith('type ')) continue;
		const aliased = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(entry);
		if (aliased !== null) out.push([aliased[2] as string, aliased[1] as string]);
		else if (/^[A-Za-z_$][\w$]*$/.test(entry)) out.push([entry, entry]);
	}
	return out;
}

/** `a, b: c, ...rest` (a destructure pattern) → [[local, imported]]. */
function destructureList(list: string): [string, string][] {
	const out: [string, string][] = [];
	for (const raw of list.split(',')) {
		const entry = raw.trim();
		if (entry === '' || entry.startsWith('...')) continue;
		const renamed = /^([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)$/.exec(entry);
		if (renamed !== null) out.push([renamed[2] as string, renamed[1] as string]);
		else {
			const plain = /^([A-Za-z_$][\w$]*)(?:\s*=.*)?$/s.exec(entry);
			if (plain !== null) out.push([plain[1] as string, plain[1] as string]);
		}
	}
	return out;
}

/** Split a pattern list at top-level commas (braces/brackets aware). */
function topLevelCommaSplit(list: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let current = '';
	for (const char of list) {
		if (char === '{' || char === '[') depth++;
		else if (char === '}' || char === ']') depth--;
		if (char === ',' && depth === 0) {
			parts.push(current);
			current = '';
		} else current += char;
	}
	if (current.trim() !== '') parts.push(current);
	return parts.map((part) => part.trim());
}

interface DynamicBindings {
	bindings: Map<string, BindingTarget>;
	/** Resolved `(await import('x')).a` references: [target, offset]. */
	direct: { target: { file: string; name: string }; start: number; end: number }[];
	/** Offsets of statements that DECLARE a binding (blanked in the scan view). */
	blank: { start: number; end: number }[];
	/**
	 * Corpus files whose WHOLE namespace escapes into the fragment as a value — a
	 * literal-specifier `import('x')` in any other position (`deps ?? (await
	 * import('x'))`, `return import('x')`, an argument): the fragment is taken to
	 * reach EVERY export of `x` (conservative — never a missing edge).
	 */
	escapes: string[];
	/** Runtime `import(` sites whose specifier is COMPUTED (not a string literal). */
	unresolved: string[];
	/**
	 * Literal RELATIVE `import('x')` sites — any form, bound or not — naming no corpus
	 * file: joined to the static out-of-corpus report (`outOfCorpusImports`), so the
	 * same named-target-class judgment covers both spellings of an import.
	 */
	outOfCorpus: UnresolvedStaticImport[];
	/**
	 * The subset of `bindings` declared by a MODULE-SCOPE statement (one that opens at
	 * column 0, optionally `export`ed — top-level await): visible to EVERY unit of the
	 * file, not only to the one whose line range happens to hold the statement.
	 */
	moduleScope: Map<string, BindingTarget>;
	/** The module-scope binding names whose statement is `export`ed. */
	moduleScopeExported: Set<string>;
}

const SPEC = String.raw`['"]([^'"\n]+)['"]`;

/**
 * The dynamic-import bindings of one code fragment (strings kept, comments
 * stripped). `code` and `structure` are offset-aligned; `firstLine` is the
 * 1-based FILE line of the fragment's first character (a reported site names the
 * file's line, not the fragment's).
 */
function dynamicBindings(
	file: string,
	code: string,
	structure: string,
	corpus: ReadonlySet<string>,
	firstLine = 1,
): DynamicBindings {
	const result: DynamicBindings = {
		bindings: new Map(),
		direct: [],
		blank: [],
		escapes: [],
		unresolved: [],
		outOfCorpus: [],
		moduleScope: new Map(),
		moduleScopeExported: new Set(),
	};
	/**
	 * Record a binding; one whose statement opens at column 0 (nothing but an optional
	 * `export` before it on its line, read on the STRUCTURE view so a template literal
	 * cannot fake one) is module-scope too.
	 */
	const bind = (at: number, local: string, target: BindingTarget) => {
		result.bindings.set(local, target);
		const lineStart = structure.lastIndexOf('\n', at - 1) + 1;
		const prefix = /^(export\s+)?$/.exec(structure.slice(lineStart, at));
		if (prefix === null || structure[at] === ' ') return;
		result.moduleScope.set(local, target);
		if (prefix[1] !== undefined) result.moduleScopeExported.add(local);
	};
	const handled: { start: number; end: number }[] = [];
	const inHandled = (at: number) => handled.some((span) => at >= span.start && at < span.end);
	/**
	 * A match that OPENS inside a string or template-literal text (blanked on the
	 * structure view, present on `code`) is text, not code: an import spelled inside a
	 * shell script embedded in a template is no edge and no out-of-corpus site.
	 */
	const inLiteral = (at: number) => structure[at] === ' ' && code[at] !== ' ';
	const claim = (start: number, end: number, blank = true) => {
		handled.push({ start, end });
		if (blank) result.blank.push({ start, end });
	};
	/**
	 * Resolve a LITERAL specifier at `at`; a relative one naming no corpus file is
	 * REPORTED (outOfCorpus) — never a silently unbound site.
	 */
	const resolveLiteral = (spec: string, at: number): string | null => {
		const target = resolveSpecifier(file, spec, corpus);
		if (target === null && isRelativeSpecifier(spec)) {
			result.outOfCorpus.push({
				site: `${file}:${firstLine + code.slice(0, at).split('\n').length - 1}: '${spec}'`,
				target: normalize(join(dirname(file), spec)),
			});
		}
		return target;
	};

	// const [{ a }, ns] = await Promise.all([import('x'), import('y')])
	for (const match of code.matchAll(
		/(?:const|let|var)\s*\[([^\]]*?)\]\s*=\s*await\s+Promise\.all\(\s*\[([^\]]*)\]\s*\)/g,
	)) {
		if (inLiteral(match.index)) continue;
		const specs = [
			...(match[2] as string).matchAll(new RegExp(`import\\(\\s*${SPEC}\\s*\\)`, 'g')),
		];
		const elements = topLevelCommaSplit(match[2] as string);
		const patterns = topLevelCommaSplit(match[1] as string);
		if (specs.length === 0 || specs.length !== elements.length) continue;
		specs.forEach((spec, position) => {
			const target = resolveLiteral(spec[1] as string, match.index);
			const pattern = patterns[position] ?? '';
			if (target === null) return;
			if (pattern.startsWith('{')) {
				for (const [local, imported] of destructureList(pattern.slice(1, -1))) {
					bind(match.index, local, { file: target, name: imported });
				}
			} else if (/^[A-Za-z_$][\w$]*$/.test(pattern)) {
				bind(match.index, pattern, { ns: target });
			}
		});
		claim(match.index, match.index + match[0].length);
	}
	// const { a, b: c } = await import('x')
	for (const match of code.matchAll(
		new RegExp(
			String.raw`(?:const|let|var)\s*\{([^}]*)\}\s*=\s*await\s+import\(\s*${SPEC}\s*\)`,
			'g',
		),
	)) {
		if (inLiteral(match.index) || inHandled(match.index)) continue;
		const target = resolveLiteral(match[2] as string, match.index);
		if (target !== null) {
			for (const [local, imported] of destructureList(match[1] as string)) {
				bind(match.index, local, { file: target, name: imported });
			}
		}
		claim(match.index, match.index + match[0].length);
	}
	// const ns = await import('x')
	for (const match of code.matchAll(
		new RegExp(
			String.raw`(?:const|let|var)\s+([A-Za-z_$][\w$]*)(?:\s*:[^=;]+)?\s*=\s*await\s+import\(\s*${SPEC}\s*\)`,
			'g',
		),
	)) {
		if (inLiteral(match.index) || inHandled(match.index)) continue;
		const target = resolveLiteral(match[2] as string, match.index);
		if (target !== null) bind(match.index, match[1] as string, { ns: target });
		claim(match.index, match.index + match[0].length);
	}
	// import('x').then(({ a, b: c }) =>
	for (const match of code.matchAll(
		new RegExp(String.raw`import\(\s*${SPEC}\s*\)\s*\.then\(\s*\(\s*\{([^}]*)\}\s*\)\s*=>`, 'g'),
	)) {
		if (inLiteral(match.index) || inHandled(match.index)) continue;
		const target = resolveLiteral(match[1] as string, match.index);
		if (target !== null) {
			for (const [local, imported] of destructureList(match[2] as string)) {
				result.bindings.set(local, { file: target, name: imported });
			}
		}
		claim(match.index, match.index + match[0].length);
	}
	// (await import('x')).a — a resolved reference, not a binding
	for (const match of code.matchAll(
		new RegExp(
			String.raw`\(\s*await\s+import\(\s*${SPEC}\s*\)\s*\)\s*\.\s*([A-Za-z_$][\w$]*)`,
			'g',
		),
	)) {
		if (inLiteral(match.index) || inHandled(match.index)) continue;
		const target = resolveLiteral(match[1] as string, match.index);
		if (target !== null) {
			result.direct.push({
				target: { file: target, name: match[2] as string },
				start: match.index,
				end: match.index + match[0].length,
			});
		}
		claim(match.index, match.index + match[0].length);
	}
	// await import('x'); — a side-effect load, no binding. ONLY as a whole EXPRESSION
	// STATEMENT: the `await` opens the statement (nothing but whitespace since the
	// fragment start or a `;` `{` `}` on the STRUCTURE view) and a `;` ends it. Any
	// other position — `return await import('x');`, `m = await import('x');`,
	// `c ? null : await import('x')`, `deps ?? await import('x')`, a biome-wrapped
	// `=\n\tawait import('x')`, an ASI-terminated line — hands the module on as a
	// VALUE, so it falls through to the general loop below and ESCAPES.
	for (const match of code.matchAll(
		new RegExp(String.raw`await\s+import\(\s*${SPEC}\s*\)\s*;`, 'g'),
	)) {
		if (inLiteral(match.index) || inHandled(match.index)) continue;
		if (!/(?:^|[;{}])\s*$/.test(structure.slice(0, match.index))) continue;
		// a side-effect load of an OUT-OF-CORPUS module still runs its top level: reported
		resolveLiteral(match[1] as string, match.index);
		claim(match.index, match.index + match[0].length, false);
	}
	// Every other runtime import(: a literal specifier resolving to the corpus is a
	// namespace ESCAPE (every export reached); anything else is UNRESOLVED. Type
	// positions are not runtime: `typeof import('x')`, and a literal
	// `import('x').Name` that is not awaited (a runtime import expression is a
	// Promise; only .then/.catch are real).
	for (const match of structure.matchAll(/(?<![\w$.])import\(/g)) {
		if (inLiteral(match.index) || inHandled(match.index)) continue;
		const before = structure.slice(0, match.index);
		const after = code.slice(match.index);
		if (/typeof\s*$/.test(before)) continue;
		const literal = new RegExp(String.raw`^import\(\s*${SPEC}\s*\)\s*\.\s*([A-Za-z_$][\w$]*)`).exec(
			after,
		);
		if (
			literal !== null &&
			!/await\s*$/.test(before) &&
			!/^(then|catch|finally)$/.test(literal[2] as string)
		) {
			continue;
		}
		const nonRelative = /^import\(\s*(['"])(?![.]{1,2}\/)[^'"\n]+\1/.test(after);
		if (nonRelative) continue;
		const literalSpec = new RegExp(String.raw`^import\(\s*${SPEC}\s*\)`).exec(after);
		if (literalSpec === null) {
			const line = firstLine + before.split('\n').length - 1;
			result.unresolved.push(`${file}:${line}: ${after.slice(0, 60).replace(/\s+/g, ' ')}`);
			continue;
		}
		const target = resolveLiteral(literalSpec[1] as string, match.index);
		if (target === null) continue; // reported by resolveLiteral
		// A declaration that HOLDS the namespace — `const m = deps ?? (await import('x'))`,
		// `const m = c ? null : await import('x')`, `m = await import('x')` — binds `m` to
		// it: `m.member` is then a resolved edge counted per SITE (a new call is a new
		// site), and a bare `m` still escapes through the namespace rule below.
		const holder = namespaceHolder(structure, match.index, match.index + literalSpec[0].length);
		if (holder !== null) {
			bind(holder.at, holder.name, { ns: target });
			claim(holder.at, holder.end);
			continue;
		}
		result.escapes.push(target);
	}
	return result;
}

/**
 * The local a value-position `import('x')` at [at, end) is the WHOLE value of: a
 * `[export] [const|let|var] NAME [: T] =` statement (on the structure view, from the
 * last `;` `{` `}`) whose initializer before the import is only an injectable-deps
 * fallback or a ternary branch (`deps ?? (await `, `c ? null : await `, `await `) —
 * no call, no assignment, no other bracket — and after it only `)`, an `as` cast and
 * the statement's end or the ternary's `:`. Anything else (an argument, a `return`, a
 * property assignment) is null: the namespace ESCAPES. `at`/`end` of the result span
 * `[export] [const] NAME [: T] =` — the part blanked as a binding site.
 */
function namespaceHolder(
	structure: string,
	at: number,
	end: number,
): { name: string; at: number; end: number } | null {
	const stmtStart =
		Math.max(
			structure.lastIndexOf(';', at - 1),
			structure.lastIndexOf('{', at - 1),
			structure.lastIndexOf('}', at - 1),
		) + 1;
	const head = structure.slice(stmtStart, at);
	const declaration =
		/^(\s*(?:export\s+)?)((?:(?:const|let|var)\s+)?)([A-Za-z_$][\w$]*)(?:\s*:[^=;]+)?\s*=(?![=>])/.exec(
			head,
		);
	if (declaration === null) return null;
	if (
		/^(?:return|await|yield|throw|typeof|void|delete|new|case|else|in|of)$/.test(
			declaration[3] as string,
		)
	) {
		return null;
	}
	const initializer = head.slice(declaration[0].length);
	if (!/^\s*(?:[^;{}()=]*?(?:\?\?|\|\||\?|:)\s*)?\(?\s*(?:await\s+)?$/.test(initializer))
		return null;
	if (!/^\s*\)?\s*(?:as\s+[^;\n]+?)?\s*(?:[;:\n]|$)/.test(structure.slice(end))) return null;
	const start = stmtStart + (declaration[1] as string).length;
	return { name: declaration[3] as string, at: start, end: stmtStart + declaration[0].length };
}

interface ParsedFile {
	file: string;
	/** Static imports: local name → target. */
	imports: Map<string, BindingTarget>;
	/** `export {a as b} from 'x'` / `export * as ns from 'x'`: exported name → target. */
	reexports: Map<string, BindingTarget>;
	/** `export * from 'x'` targets. */
	starExports: string[];
	/** `export { a as b }` (no from): exported name → local name. */
	localAliases: Map<string, string>;
	/** Names of the module's own exported top-level declarations. */
	exportedDeclarations: Set<string>;
	units: Unit[];
	declared: Set<string>;
	/** Names of the module's type-only declarations (`interface` / `type`): no runtime edge. */
	declaredTypes: Set<string>;
	/** Module-scope dynamic-import bindings (top-level await): visible to every unit. */
	moduleDynamic: Map<string, BindingTarget>;
	/** The `export`ed ones among `moduleDynamic` (`export const { a } = await import('x')`). */
	moduleDynamicExported: Set<string>;
	unresolvedDynamic: string[];
	/** Relative imports (static, re-export, or literal dynamic) that name no corpus file. */
	unresolvedStatic: UnresolvedStaticImport[];
}

/** A relative import — static, re-export, or LITERAL dynamic — that names no corpus file. */
export interface UnresolvedStaticImport {
	/** `<file>:<line>: '<specifier>'`. */
	site: string;
	/** The repo-relative path the specifier names (before any extension guess). */
	target: string;
}

interface Unit {
	key: string;
	name: string;
	/** Code (comments stripped, strings kept) — what a verdict's body check reads. */
	body: string;
	/** Scan view: strings/regex blanked, binding statements blanked. */
	scan: string;
	bindings: Map<string, BindingTarget>;
	direct: { file: string; name: string }[];
	/** Corpus files whose whole namespace escapes into this unit (see DynamicBindings). */
	escapes: string[];
}

function parseFile(file: string, source: string, corpus: ReadonlySet<string>): ParsedFile {
	const code = stripComments(source, { keepTemplateSubstitutions: true });
	let structure = structureOf(code);
	const imports = new Map<string, BindingTarget>();
	const reexports = new Map<string, BindingTarget>();
	const starExports: string[] = [];
	const localAliases = new Map<string, string>();
	const unresolvedStatic: UnresolvedStaticImport[] = [];
	const lineOf = (at: number) => code.slice(0, at).split('\n').length;
	/** A relative specifier that resolves to no corpus file is REPORTED, never skipped. */
	const resolveStatic = (spec: string, at: number): string | null => {
		const target = resolveSpecifier(file, spec, corpus);
		if (target === null && isRelativeSpecifier(spec)) {
			unresolvedStatic.push({
				site: `${file}:${lineOf(at)}: '${spec}'`,
				target: normalize(join(dirname(file), spec)),
			});
		}
		return target;
	};

	// Static import statements.
	for (const match of code.matchAll(
		new RegExp(String.raw`^[ \t]*import\s+(?!type\s)([^;'"]*?)\s+from\s+${SPEC}\s*;?`, 'gm'),
	)) {
		const clause = (match[1] as string).trim();
		const target = resolveStatic(match[2] as string, match.index);
		structure = blankSpan(structure, match.index, match.index + match[0].length);
		if (target === null) continue;
		// the DEFAULT clause: `import w from`, `import w, { a } from`, `import w, * as ns from`
		const defaultClause = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause);
		if (defaultClause !== null)
			imports.set(defaultClause[1] as string, { file: target, name: 'default' });
		const namespace = /\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(clause);
		if (namespace !== null) imports.set(namespace[1] as string, { ns: target });
		const named = /\{([^}]*)\}/.exec(clause);
		if (named !== null) {
			for (const [local, imported] of importSpecifierList(named[1] as string)) {
				imports.set(local, { file: target, name: imported });
			}
		}
	}
	// Side-effect imports carry no binding but are still not references.
	for (const match of code.matchAll(new RegExp(String.raw`^[ \t]*import\s+${SPEC}\s*;?`, 'gm'))) {
		resolveStatic(match[1] as string, match.index);
		structure = blankSpan(structure, match.index, match.index + match[0].length);
	}
	// Type-only imports: blank so a type name is never a reference.
	for (const match of code.matchAll(/^[ \t]*import\s+type\s[^;]*?from\s+(['"])[^'"\n]+\1\s*;?/gm)) {
		structure = blankSpan(structure, match.index, match.index + match[0].length);
	}
	// Re-exports.
	for (const match of code.matchAll(
		new RegExp(String.raw`^export\s+(?:type\s+)?\{([^}]*)\}\s*from\s+${SPEC}\s*;?`, 'gm'),
	)) {
		structure = blankSpan(structure, match.index, match.index + match[0].length);
		const target = resolveStatic(match[2] as string, match.index);
		if (target === null) continue;
		for (const [exported, imported] of importSpecifierList(match[1] as string)) {
			reexports.set(exported, { file: target, name: imported });
		}
	}
	for (const match of code.matchAll(
		new RegExp(String.raw`^export\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+${SPEC}\s*;?`, 'gm'),
	)) {
		structure = blankSpan(structure, match.index, match.index + match[0].length);
		const target = resolveStatic(match[2] as string, match.index);
		if (target !== null) reexports.set(match[1] as string, { ns: target });
	}
	for (const match of code.matchAll(
		new RegExp(String.raw`^export\s+\*\s+from\s+${SPEC}\s*;?`, 'gm'),
	)) {
		structure = blankSpan(structure, match.index, match.index + match[0].length);
		const target = resolveStatic(match[1] as string, match.index);
		if (target !== null) starExports.push(target);
	}
	for (const match of code.matchAll(/^export\s+\{([^}]*)\}\s*;/gm)) {
		structure = blankSpan(structure, match.index, match.index + match[0].length);
		for (const [exported, local] of importSpecifierList(match[1] as string)) {
			localAliases.set(exported, local);
		}
	}
	// A NAMED default declaration exports `default` as that declaration (an anonymous
	// one is its own `default` unit — topLevelRanges).
	const namedDefault =
		/^export\s+default\s+(?:async\s+)?(?:function\*?|(?:abstract\s+)?class)\s+([A-Za-z0-9_$]+)/m.exec(
			structure,
		);
	if (namedDefault !== null) localAliases.set('default', namedDefault[1] as string);
	const aliasDefault = /^export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/m.exec(structure);
	if (aliasDefault !== null) localAliases.set('default', aliasDefault[1] as string);

	// Split on the structure view (a column-0 `const` inside a template literal is
	// blanked there, so it cannot open a false declaration); slice the code by the
	// same lines — the two views are offset- and line-aligned.
	const codeLines = code.split('\n');
	const structureLines = structure.split('\n');
	const units: Unit[] = [];
	const declared = new Set<string>();
	const declaredTypes = new Set<string>();
	const exportedDeclarations = new Set<string>();
	const moduleDynamic = new Map<string, BindingTarget>();
	const moduleDynamicExported = new Set<string>();
	const unresolvedDynamic: string[] = [];
	for (const range of topLevelRanges(structureLines, true)) {
		const body = codeLines.slice(range.start, range.end).join('\n');
		const blockStructure = structureLines.slice(range.start, range.end).join('\n');
		const typeName = /^<type:(.+)>$/.exec(range.name)?.[1];
		if (typeName !== undefined) declaredTypes.add(typeName);
		if (!range.name.startsWith('<')) declared.add(range.name);
		if (!range.name.startsWith('<') && range.exported) exportedDeclarations.add(range.name);
		for (const unit of splitUnits(range.name, body, blockStructure)) {
			const dynamic = dynamicBindings(
				file,
				unit.body,
				unit.structure,
				corpus,
				range.start + unit.lineOffset + 1,
			);
			let scan = unit.structure;
			for (const span of dynamic.blank) scan = blankSpan(scan, span.start, span.end);
			for (const span of dynamic.direct) scan = blankSpan(scan, span.start, span.end);
			unresolvedDynamic.push(...dynamic.unresolved);
			unresolvedStatic.push(...dynamic.outOfCorpus);
			for (const [local, target] of dynamic.moduleScope) moduleDynamic.set(local, target);
			for (const local of dynamic.moduleScopeExported) moduleDynamicExported.add(local);
			// `export const ns = await import('x')` IS the unit `ns`: an IMPORTER of `ns`
			// (a plain name binding to `file#ns`) reaches every export of `x`. Only when
			// exported — this file's own units resolve `ns.member` precisely.
			const selfNamespace = range.exported ? dynamic.moduleScope.get(unit.name) : undefined;
			units.push({
				key: `${file}#${unit.name}`,
				name: unit.name,
				body: unit.body,
				scan,
				bindings: dynamic.bindings,
				direct: dynamic.direct.map((entry) => entry.target),
				escapes:
					selfNamespace !== undefined && 'ns' in selfNamespace
						? [...dynamic.escapes, selfNamespace.ns]
						: dynamic.escapes,
			});
		}
	}
	return {
		file,
		imports,
		reexports,
		starExports,
		localAliases,
		exportedDeclarations,
		units,
		declared,
		declaredTypes,
		moduleDynamic,
		moduleDynamicExported,
		unresolvedDynamic,
		unresolvedStatic,
	};
}

/**
 * The static-import bindings of one module (local name → target), for a caller
 * that wants the file-level view. Only relative specifiers resolving to `corpus`
 * files count.
 */
export function importBindings(
	file: string,
	code: string,
	corpus: ReadonlySet<string> = new Set(writePathSourceFiles()),
): Map<string, BindingTarget> {
	return parseFile(file, code, corpus).imports;
}

// ---------------------------------------------------------------------------
// The closure
// ---------------------------------------------------------------------------

export interface WriterClosure {
	/** `file#decl` → the member it reaches first (`via` is null for a seed primitive). */
	members: Map<string, { via: string | null }>;
	/** The path from `key` down to a seed: [key, …, `matrix_write.ts#<primitive>` or a psql seed]. */
	witness(key: string): string[];
	/** Every reference target of a unit (namespace escapes included), with its site count. */
	edgesOf(key: string): Map<string, number>;
	/**
	 * The unit's RESOLVED one-hop targets only — never a namespace escape. What a claim
	 * of PROOF about the unit's own references (a locked read it takes) must read.
	 */
	preciseEdgesOf(key: string): Set<string>;
	/**
	 * Does `from` reach `to` through resolved references (any unit, member or not)?
	 * Walks EVERY edge, the over-approximated namespace escapes included — right for
	 * membership (an extra edge can only add a cell), wrong for PROOF.
	 */
	reaches(from: string, to: string): boolean;
	/**
	 * Does `from` reach `to` through RESOLVED references only — a named binding, a
	 * `ns.member`, a `(await import('x')).a`, a same-file declaration — never through a
	 * namespace escape (a bare `ns` value, a value-position `import('x')`), which only
	 * says "could call any export". What a claim of EVIDENCE must use.
	 */
	reachesPrecisely(from: string, to: string): boolean;
	/**
	 * A path from `from` down to a SEED (a primitive or a psql seed) that enters NO
	 * unit of `cut` — `[from, …, seed]`, or null when every path to a seed crosses the
	 * cut (or `from` reaches none, or is itself in the cut). Walks EVERY edge, the
	 * namespace escapes included: an over-approximation can only add a bypass, which
	 * is the strict direction for a rule that DEMANDS something of a bypassing cell.
	 * With `cut` = RECORD_WRITE_CHOKEPOINTS it answers "does this door write the
	 * matrix past the chokepoint?" — however many wrappers deep the write sits.
	 */
	bypassPath(from: string, cut: ReadonlySet<string>): string[] | null;
	/** Runtime `import(` sites in `file` no handled form resolved. */
	unresolvedDynamicImports(file: string): string[];
	/**
	 * Relative imports in `file` — static, re-export, or a LITERAL dynamic `import('x')`
	 * in any form — whose specifier names no corpus file (with the path it names).
	 */
	outOfCorpusImports(file: string): UnresolvedStaticImport[];
	/**
	 * Corpus-targeted references in `file` whose EXPORT does not resolve — a bound name,
	 * a `ns.member`, a `(await import('x')).a`, a static import specifier — as
	 * `<file#unit or file>: <module>#<name>`. A type-only export is not listed.
	 */
	unresolvedBindings(file: string): string[];
	/** Every unit key, with its code body. */
	bodies: Map<string, string>;
	/** The primitives the closure was seeded with (derived from the corpus's matrix_write). */
	primitives: string[];
	/**
	 * The OFF-HOME seeds: `file#decl` units with a BINDING-RESOLVED edge to PSQL_DOOR
	 * (never a bare-name match: an aliased import, a namespace member and a `deps ??
	 * runPsql` value all count) whose code carries a matrix DML statement (see
	 * PSQL_MATRIX_DML) — writes on psql's own connection, past every chokepoint (no
	 * stamp, no Time Machine row, no obligation hook). DERIVED, sorted.
	 */
	psqlSeeds: string[];
	/** Corpus file list the closure was built over. */
	files: string[];
}

/**
 * Excluded from membership: the primitive module itself (its non-DML helpers are
 * classified above; its DML exports are the seeds). NOT `src/core/test_data/`: those
 * builders are reached from engine doors too (the unit_test maintenance widget;
 * the suite builder's installer path), so cutting them would cut every
 * witness chain through them — a tool delegating to one would have no cell.
 */
const CLOSURE_EXCLUDED_PREFIXES = [MATRIX_WRITE];

/** The psql door: an off-home psql writer is a unit with a resolved edge to it. */
export const PSQL_DOOR = 'src/core/install/pg_exec.ts#runPsql';

const RECORD_WRITE = 'src/core/section_record/record_write.ts';

/**
 * The single post-write OBLIGATION hook (save event, security reaction, RAG event):
 * every chokepoint writer ends in it (write_obligations_tripwire legs A/B).
 */
export const AFTER_RECORD_WRITE = `${RECORD_WRITE}#afterRecordWrite`;

/**
 * THE RECORD-WRITE CHOKEPOINTS — the units that carry the write contract for whoever
 * calls them: modified stamps, key-removal semantics, the obligation hook, and (for
 * the component door) the row lock, the Time Machine row and the observer cascade.
 * A write that reaches the matrix THROUGH one of these is the engine's sanctioned
 * write; a write that reaches a seed while AVOIDING all of them (`bypassPath`) is a
 * BYPASS, however many wrappers deep it sits. Each key is checked by
 * tool_lossless_writeback: it must be a closure member (a stale name is red) and must
 * reach AFTER_RECORD_WRITE through RESOLVED references (a unit that fires no
 * obligation is no chokepoint). What the chokepoint does INSIDE (its own derived
 * writes: the relation_search index, the dataframe slot strip) is write_obligations'
 * subject, not this list's.
 */
export const RECORD_WRITE_CHOKEPOINTS: Readonly<Record<string, string>> = {
	[`${RECORD_WRITE}#persistRecordKeys`]:
		'THE key-level chokepoint: value + modified stamps in ONE UPDATE, key-removal semantics, then afterRecordWrite.',
	[`${RECORD_WRITE}#persistModifiedStamp`]:
		'the stamp-only chokepoint: the modified stamps, then afterRecordWrite (rag:null — its data door indexes).',
	[`${RECORD_WRITE}#persistRecordColumns`]:
		'the whole-column chokepoint: the columns + stamps, then afterRecordWrite.',
	'src/core/section/record/save_component.ts#saveComponentData':
		'THE component save door: row lock, Time Machine row, bulk undo pair, observer cascade, then persistRecordKeys.',
	'src/core/section/record/create_record.ts#createSectionRecord':
		'the record-INSERT door: birth columns at once, the NEW activity row, then afterRecordWrite.',
	'src/core/section/record/duplicate_record.ts#duplicateSectionRecord':
		'the record-CLONE door: every column at once, then afterRecordWrite.',
	'src/core/section/record/delete_record.ts#deleteSectionRecord':
		'the record-DELETE door: the row delete under its lock, TM delete row, holders rewritten through persistRecordKeys, save/RAG events and the observer cascade.',
	// CLOSURE_PLAN Step 2 (the obligation ledger): the chokepoint owns every derived
	// write — each entry below carries its own observer (ledger) and relation_search
	// obligations, so no door remembers them. write_obligations_tripwire leg B.
	[`${RECORD_WRITE}#persistRecordBirth`]:
		'the insert-if-absent chokepoint (a record undelete): the birth columns + derived relation_search, covered observer slots recomputed, then afterRecordWrite with a birth ledger entry.',
	[`${RECORD_WRITE}#persistAppendedKeyItems`]:
		'the atomic-append chokepoint (saveComponentData’s insert branch): the appended items, stamps and derived relation_search, then afterRecordWrite with a keys ledger entry.',
	[`${RECORD_WRITE}#persistRelationRemovalKeys`]:
		'the REMOVAL-law key chokepoint (every relation model re-indexed, P1-7): only the enumerated removal doors call it; ends in afterRecordWrite with a keys ledger entry.',
	[`${RECORD_WRITE}#persistRestoredKeys`]:
		'the COMPONENT-RESTORE key chokepoint (a key’s PAST value — apply_value, the bulk revert-undo): persistRecordKeys, except that a restored COVERED observer slot is never declared as a change — it is queued for its recompute (requestCoveredSlotRecompute) after COMMIT; ends in afterRecordWrite. Its callers are enumerated by write_obligations_tripwire leg B4.',
	[`${RECORD_WRITE}#requestCoveredSlotRecompute`]:
		'the covered-slot RECOMPUTE entry: writes nothing itself — it queues the recompute of a record’s set_dato_external mirrors on the ledger, whose drain writes each mirror through persistObserverMirrorKeys (the one sanctioned path past it is the drain’s dataframe SLOT strip of a dropped mirror item, removeDataframeDataById, exactly as for every other entry’s drain). Its callers are enumerated by write_obligations_tripwire leg B4.',
	[`${RECORD_WRITE}#persistObserverMirrorKeys`]:
		'the observer-MIRROR key chokepoint (cascade-owned, no ledger entry — the cascade hops itself): only recomputeExternalRelation calls it; relation_search derived from what is stored; ends in afterRecordWrite.',
};

/**
 * THE SANCTIONED DERIVED WRITERS — the units that write the matrix PAST every
 * record-write chokepoint by design, because what they write is DERIVED state with no
 * curated value, stamp or history of its own (technical metadata, the hierarchy and
 * ontology definition rows, the dataframe slot strip). ONE list: tool_lossless's BYPASS
 * reasons name these writers and write_obligations' census exempts them; neither may
 * restate one differently. Each key must be a closure member (a stale name is red).
 */
export const SANCTIONED_DERIVED_WRITERS: Readonly<Record<string, string>> = {
	'src/core/section/record/record_metadata.ts#setRecordMetadata':
		'the `data`-column METADATA twin (created_date / created_by_user_id, label, diffusion_info): system bookkeeping, no component value.',
	'src/core/media/tools/files_info_persist.ts#writeItems':
		'files_info — technical metadata derived from the files on disk; its ONE caller is the locked transform (transformStoredMediaItems).',
	'src/core/relations/save.ts#removeDataframeDataById':
		'the dataframe SLOT strip of a removed main item (REL-01): no TM row by contract — the main’s own chokepoint write records the full state.',
	'src/core/ontology/hierarchy_state.ts#write':
		'the HIERARCHY INVARIANT single writer on the hierarchy registry rows — system state, not curated content.',
	'src/core/ontology/hierarchy_state.ts#nameRootTerm':
		'the hierarchy single writer naming a root term record — see #write.',
	'src/core/ontology/hierarchy_provision.ts#provisionVirtualSections':
		'hierarchy PROVISIONING of the `<tld>0` descriptor / model twin records at fixed ids.',
	'src/core/ontology/ontology_write.ts#writeOntologyMainKey':
		'ONTOLOGY registry rows (matrix_ontology_main): the one per-key writer behind createMainSection / syncMainSectionFromDefinition (the registry-row law; hierarchy60 dependencies in `misc`) — definitions, unstamped as in PHP.',
	'src/core/ontology/ontology_write.ts#createParentGrouper':
		'ontology definition rows — see #writeOntologyMainKey.',
};

/**
 * A matrix DML statement in a unit's code (strings kept): `UPDATE` / `INSERT INTO` /
 * `DELETE FROM` / `TRUNCATE` naming the `matrix` table, a `matrix_*` one or an interpolated one (`"${t}"`),
 * or a psql `\copy <matrix table> … FROM` (an import; `\copy … TO` is an export). Case-
 * sensitive: the tree writes SQL keywords upper-case, and prose "update matrix_x" is no
 * statement. Paired with a `runPsql(` CALL in the same unit it is an OFF-HOME seed.
 */
const PSQL_MATRIX_DML =
	/\b(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+"?(?:matrix(?:_[a-z_]*)?\b|\$\{)|\\copy\s+(?:"?matrix(?:_[a-z_]*)?\b|\$\{)[^\n]*\bFROM\b/;

/**
 * The offset where a type unit's DECLARATION ends (its structure view): the first line
 * after it that opens at column 0, at bracket depth 0, with anything but a closing
 * bracket or a union/intersection continuation — i.e. the next top-level statement,
 * which (not being a declaration form) opened no unit of its own. `interface X {…}`
 * ends after its column-0 `}`; `type A =\n\t| { a(): void }\n\t| null;` after the
 * `null;` line.
 */
function typeDeclarationEnd(scan: string): number {
	const lines = scan.split('\n');
	let depth = 0;
	let offset = 0;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] as string;
		if (index > 0 && depth <= 0 && /^[^\s})\]|&]/.test(line)) return offset;
		for (const char of line) {
			if (char === '{' || char === '(' || char === '[') depth++;
			else if (char === '}' || char === ')' || char === ']') depth--;
		}
		offset += line.length + 1;
	}
	return scan.length;
}

/** Does this unit body carry a matrix DML statement (PSQL_MATRIX_DML)? */
export function hasPsqlMatrixDml(body: string): boolean {
	return PSQL_MATRIX_DML.test(body);
}

/**
 * The NAME view of an off-home psql writer: `runPsql(` CALLED by that bare name plus a
 * matrix DML statement. NOT how seeds are derived (that is the binding-resolved edge
 * to PSQL_DOOR); kept so the gate can hold the two views EQUAL on the tree, exactly as
 * it does for the primitives.
 */
export function isPsqlMatrixWriter(body: string): boolean {
	return callsName(body, 'runPsql') && PSQL_MATRIX_DML.test(body);
}

const IDENTIFIER = /(?<![\w$])(?<!(?:^|[^.])\.)([A-Za-z_$][\w$]*)/g;

/** Is the identifier at [at, at+length) an object/interface KEY (followed by `:` / `?:`, opening an entry)? */
function isKeyPosition(scan: string, at: number, length: number): boolean {
	if (!/^[ \t]*\??:(?!:)/.test(scan.slice(at + length, at + length + 8))) return false;
	const before = scan.slice(Math.max(0, at - 200), at);
	return /(?:^|[{,;]|\n)\s*$/.test(before);
}

export function buildWriterClosure(
	input: { files: string[]; read: (rel: string) => string } = {
		files: writePathSourceFiles(),
		read: readRepoFile,
	},
): WriterClosure {
	const corpus = new Set(input.files);
	const parsed = new Map<string, ParsedFile>();
	for (const file of input.files) parsed.set(file, parseFile(file, input.read(file), corpus));
	const primitives = corpus.has(MATRIX_WRITE) ? deriveRawPrimitives(input.read(MATRIX_WRITE)) : [];

	/** What a type-only export resolves to: a real export, but never a runtime edge. */
	const TYPE_ONLY = '<type-only>';
	/** `file#name` of the declaration an export names, TYPE_ONLY, or null (unresolved). */
	const resolveExportOrType = (
		file: string,
		name: string,
		seen: Set<string> = new Set(),
	): string | null => {
		const marker = `${file}#${name}`;
		if (seen.has(marker)) return null;
		seen.add(marker);
		const module = parsed.get(file);
		if (module === undefined) return null;
		if (module.declared.has(name)) return marker;
		if (module.declaredTypes.has(name)) return TYPE_ONLY;
		const re = module.reexports.get(name);
		if (re !== undefined && 'name' in re) return resolveExportOrType(re.file, re.name, seen);
		const local = module.localAliases.get(name);
		if (local !== undefined) {
			if (module.declared.has(local)) return `${file}#${local}`;
			if (module.declaredTypes.has(local)) return TYPE_ONLY;
			const imported = module.imports.get(local);
			if (imported !== undefined && 'name' in imported) {
				return resolveExportOrType(imported.file, imported.name, seen);
			}
		}
		// `export const { a } = await import('x')` — a module-scope dynamic binding
		// exported under its local name resolves through to `x`'s export
		const dynamic = module.moduleDynamic.get(name);
		if (dynamic !== undefined && 'name' in dynamic) {
			return resolveExportOrType(dynamic.file, dynamic.name, seen);
		}
		for (const star of module.starExports) {
			const found = resolveExportOrType(star, name, seen);
			if (found !== null) return found;
		}
		return null;
	};
	const resolveExport = (file: string, name: string): string | null => {
		const found = resolveExportOrType(file, name);
		return found === TYPE_ONLY ? null : found;
	};

	/**
	 * Every export of `file`, resolved to its declaring `file#name` — what a
	 * namespace that ESCAPES as a value (a bare `ns`, a value-position `import('x')`)
	 * is taken to reach.
	 */
	const exportsMemo = new Map<string, string[]>();
	/**
	 * The walk behind allExports. `seen` is the walk's VISITED set: a module reached a
	 * second time (a star/namespace cycle, or a diamond) contributes nothing there, so the
	 * set computed for a NESTED module can be short — `truncated` — and is then not
	 * memoized (it would be served as that module's whole set to a later escape). The
	 * top-level set is the union over every module the walk visited, each counted once,
	 * so it is complete and always memoized.
	 */
	const collectExports = (
		file: string,
		seen: Set<string>,
	): { list: string[]; truncated: boolean } => {
		const memo = exportsMemo.get(file);
		if (memo !== undefined) return { list: memo, truncated: false };
		if (seen.has(file)) return { list: [], truncated: true };
		seen.add(file);
		const module = parsed.get(file);
		if (module === undefined) return { list: [], truncated: false };
		let truncated = false;
		const take = (sub: { list: string[]; truncated: boolean }) => {
			if (sub.truncated) truncated = true;
			return sub.list;
		};
		const out = new Set<string>();
		for (const name of [
			...module.exportedDeclarations,
			...module.reexports.keys(),
			...module.localAliases.keys(),
			...module.moduleDynamicExported,
		]) {
			const re = module.reexports.get(name);
			if (re !== undefined && 'ns' in re) {
				for (const key of take(collectExports(re.ns, seen))) out.add(key);
				continue;
			}
			const resolved = resolveExport(file, name);
			if (resolved !== null) out.add(resolved);
		}
		for (const star of module.starExports) {
			for (const key of take(collectExports(star, seen))) out.add(key);
		}
		const list = [...out].sort();
		if (!truncated) exportsMemo.set(file, list);
		return { list, truncated };
	};
	const allExports = (file: string): string[] => {
		const { list } = collectExports(file, new Set());
		exportsMemo.set(file, list);
		return list;
	};

	const edges = new Map<string, Map<string, number>>();
	/** The same edges minus the namespace ESCAPES (see reachesPrecisely). */
	const preciseEdges = new Map<string, Set<string>>();
	const bodies = new Map<string, string>();
	const unresolvedBindings = new Map<string, Set<string>>();
	const noteUnresolved = (file: string, where: string, module: string, name: string) => {
		const list = unresolvedBindings.get(file) ?? new Set<string>();
		list.add(`${where}: ${module}#${name}`);
		unresolvedBindings.set(file, list);
	};
	const add = (from: string, to: string | null, precise = true) => {
		if (to === null || to === from) return;
		const map = edges.get(from) ?? new Map<string, number>();
		map.set(to, (map.get(to) ?? 0) + 1);
		edges.set(from, map);
		if (precise) {
			const set = preciseEdges.get(from) ?? new Set<string>();
			set.add(to);
			preciseEdges.set(from, set);
		}
	};
	/** Resolve a corpus-targeted `module#name` reference; an unresolvable one is REPORTED. */
	const resolveReference = (
		file: string,
		where: string,
		target: { file: string; name: string },
	): string | null => {
		const found = resolveExportOrType(target.file, target.name);
		if (found === null) noteUnresolved(file, where, target.file, target.name);
		return found === TYPE_ONLY ? null : found;
	};
	for (const module of parsed.values()) {
		// every static import name must name a real export (a type counts), used or not
		for (const target of module.imports.values()) {
			if ('name' in target) resolveReference(module.file, module.file, target);
		}
		for (const target of module.moduleDynamic.values()) {
			if ('name' in target) resolveReference(module.file, module.file, target);
		}
		for (const unit of module.units) {
			bodies.set(unit.key, unit.body);
			if (!edges.has(unit.key)) edges.set(unit.key, new Map());
			for (const target of unit.direct)
				add(unit.key, resolveReference(module.file, unit.key, target));
			for (const escaped of unit.escapes) {
				for (const key of allExports(escaped)) add(unit.key, key, false);
			}
			const declarationLine = /^[^\n]*/.exec(unit.scan)?.[0] ?? '';
			// a TYPE declaration (`<type:Name>`: an interface / type alias) has no runtime
			// reference — its method signatures and member types are no edge. Only the
			// declaration itself is blanked: a column-0 runtime statement AFTER it (a
			// module-level call, which opens no unit) still lands in this unit and is read.
			const scan = unit.name.startsWith('<type:')
				? blankSpan(unit.scan, 0, typeDeclarationEnd(unit.scan))
				: unit.scan;
			for (const match of scan.matchAll(IDENTIFIER)) {
				const name = match[1] as string;
				// the declaration's own name on its opening line is not a reference
				if (match.index < declarationLine.length && name === unit.name) continue;
				// a KEY (`{ name: …`, `, name?: …`, an indented `name: …` line) names a
				// property, not a binding — a shorthand `{ name }` is still a reference
				if (isKeyPosition(scan, match.index, name.length)) continue;
				// the unit's own bindings, then the file's static imports, then the file's
				// MODULE-SCOPE dynamic bindings (top-level await — every unit sees them)
				const binding =
					unit.bindings.get(name) ?? module.imports.get(name) ?? module.moduleDynamic.get(name);
				if (binding !== undefined) {
					if ('name' in binding) {
						add(unit.key, resolveReference(module.file, unit.key, binding));
					} else {
						// `ns.member` and the optional-chained `ns?.member` (a held import that may be null)
						const member = /^\s*\??\.\s*([A-Za-z_$][\w$]*)/.exec(
							scan.slice(match.index + name.length),
						);
						if (member !== null) {
							add(
								unit.key,
								resolveReference(module.file, unit.key, {
									file: binding.ns,
									name: member[1] as string,
								}),
							);
						}
						// a namespace used as a VALUE (passed, returned, spread, indexed) escapes:
						// whatever receives it can call any export, so it reaches every one. A
						// bare DECLARATION of the holder (`let m;`, assigned later) is no use.
						else if (!/\b(?:let|var)\s+$/.test(scan.slice(0, match.index))) {
							for (const key of allExports(binding.ns)) add(unit.key, key, false);
						}
					}
					continue;
				}
				if (module.declared.has(name)) add(unit.key, `${module.file}#${name}`);
			}
		}
	}

	// Reverse fixpoint from the seeds.
	const reverse = new Map<string, string[]>();
	for (const [from, targets] of edges) {
		if (CLOSURE_EXCLUDED_PREFIXES.some((prefix) => from.startsWith(prefix))) continue;
		for (const to of targets.keys()) {
			const list = reverse.get(to) ?? [];
			list.push(from);
			reverse.set(to, list);
		}
	}
	const members = new Map<string, { via: string | null }>();
	const queue: string[] = [];
	for (const primitive of primitives) {
		const seed = `${MATRIX_WRITE}#${primitive}`;
		members.set(seed, { via: null });
		queue.push(seed);
	}
	// the OFF-HOME psql writers seed the closure too: a tool action reaching one writes a
	// stored matrix value with no chokepoint at all, which is exactly what the census is for
	// by the RESOLVED edge to PSQL_DOOR, never by the spelling `runPsql(`: an aliased
	// import, a namespace member or a `deps ?? runPsql` value is the same channel
	const psqlSeeds = [...bodies]
		.filter(
			([key, body]) =>
				!CLOSURE_EXCLUDED_PREFIXES.some((prefix) => key.startsWith(prefix)) &&
				!key.includes('#<type:') &&
				(edges.get(key)?.has(PSQL_DOOR) ?? false) &&
				PSQL_MATRIX_DML.test(body),
		)
		.map(([key]) => key)
		.sort();
	for (const seed of psqlSeeds) {
		if (members.has(seed)) continue;
		members.set(seed, { via: null });
		queue.push(seed);
	}
	while (queue.length > 0) {
		const current = queue.shift() as string;
		for (const caller of (reverse.get(current) ?? []).sort()) {
			if (members.has(caller)) continue;
			members.set(caller, { via: current });
			queue.push(caller);
		}
	}
	const seeds = new Set<string>([
		...primitives.map((primitive) => `${MATRIX_WRITE}#${primitive}`),
		...psqlSeeds,
	]);

	return {
		members,
		bodies,
		primitives,
		psqlSeeds,
		files: input.files,
		witness(key: string): string[] {
			const path: string[] = [];
			let current: string | null = key;
			while (current !== null && !path.includes(current)) {
				path.push(current);
				current = members.get(current)?.via ?? null;
			}
			return path;
		},
		edgesOf(key: string): Map<string, number> {
			return edges.get(key) ?? new Map();
		},
		preciseEdgesOf(key: string): Set<string> {
			return new Set(preciseEdges.get(key) ?? []);
		},
		reaches(from: string, to: string): boolean {
			return walk(from, to, (key) => (edges.get(key) ?? new Map<string, number>()).keys());
		},
		reachesPrecisely(from: string, to: string): boolean {
			return walk(from, to, (key) => (preciseEdges.get(key) ?? new Set<string>()).values());
		},
		bypassPath(from: string, cut: ReadonlySet<string>): string[] | null {
			if (cut.has(from) || !members.has(from)) return null;
			// breadth-first, successors sorted: the SHORTEST bypass, deterministically
			const previous = new Map<string, string | null>([[from, null]]);
			const pending = [from];
			while (pending.length > 0) {
				const current = pending.shift() as string;
				if (seeds.has(current)) {
					const path: string[] = [];
					for (let at: string | null = current; at !== null; at = previous.get(at) ?? null) {
						path.unshift(at);
					}
					return path;
				}
				for (const next of [...(edges.get(current) ?? new Map<string, number>()).keys()].sort()) {
					if (previous.has(next) || cut.has(next) || !members.has(next)) continue;
					previous.set(next, current);
					pending.push(next);
				}
			}
			return null;
		},
		unresolvedDynamicImports(file: string): string[] {
			return parsed.get(file)?.unresolvedDynamic ?? [];
		},
		outOfCorpusImports(file: string): UnresolvedStaticImport[] {
			return parsed.get(file)?.unresolvedStatic ?? [];
		},
		unresolvedBindings(file: string): string[] {
			return [...(unresolvedBindings.get(file) ?? [])].sort();
		},
	};
}

/** Depth-first reachability over a successor function. */
function walk(from: string, to: string, next: (key: string) => Iterable<string>): boolean {
	const seen = new Set<string>([from]);
	const stack = [from];
	while (stack.length > 0) {
		const current = stack.pop() as string;
		if (current === to) return true;
		for (const successor of next(current)) {
			if (!seen.has(successor)) {
				seen.add(successor);
				stack.push(successor);
			}
		}
	}
	return false;
}

/** `tools/<tool>/server/…` → `tools/<tool>/`; null for any other file. */
export function toolServerHome(file: string): string | null {
	const match = /^(tools\/[^/]+\/)server\//.exec(file);
	return match === null ? null : (match[1] as string);
}

/**
 * The tool-server write cells: for every unit in a `tools/<tool>/server/**`
 * file that references a closure member lying OUTSIDE its own
 * `tools/<tool>/server/` (the units that carry their own cells), `<file> :: <decl>`
 * → door → site count. A member in the tool's OWN non-server TS (`tools/<tool>/
 * shared/…`) is therefore a door too — it has no cell of its own, so skipping it
 * would drop its write. The door is the member's bare name, or `file#name` when
 * that bare name is shared by more than one member.
 *
 * A tool-server unit that IS an off-home psql seed (a resolved PSQL_DOOR edge with
 * matrix DML) writes with no door to cross: it carries a SELF cell, door = its own
 * `file#decl` (which resolves to the seed, so the raw rule judges it), sites = its
 * PSQL_DOOR reference sites. A same-tool action calling it reaches it in-home, so the write
 * is censused once, on the seed's own cell — as for any server helper.
 */
export function toolServerCells(closure: WriterClosure): Map<string, Map<string, number>> {
	const byName = new Map<string, number>();
	for (const key of closure.members.keys()) {
		const name = key.slice(key.indexOf('#') + 1);
		byName.set(name, (byName.get(name) ?? 0) + 1);
	}
	const cells = new Map<string, Map<string, number>>();
	for (const key of [...closure.bodies.keys()].sort()) {
		const hash = key.indexOf('#');
		const file = key.slice(0, hash);
		const home = toolServerHome(file);
		if (home === null) continue;
		if (closure.psqlSeeds.includes(key)) {
			const action = `${file} :: ${key.slice(hash + 1)}`;
			const doors = cells.get(action) ?? new Map<string, number>();
			doors.set(key, closure.edgesOf(key).get(PSQL_DOOR) ?? 0);
			cells.set(action, doors);
		}
		for (const [target, sites] of closure.edgesOf(key)) {
			if (!closure.members.has(target) || target.startsWith(`${home}server/`)) continue;
			const name = target.slice(target.indexOf('#') + 1);
			const door = (byName.get(name) ?? 0) > 1 ? target : name;
			const action = `${file} :: ${key.slice(hash + 1)}`;
			const doors = cells.get(action) ?? new Map<string, number>();
			doors.set(door, (doors.get(door) ?? 0) + sites);
			cells.set(action, doors);
		}
	}
	return cells;
}
