/**
 * PREDICTABLE-TMP CENSUS — the ONE measure behind `predictable_tmp_tripwire`.
 *
 * WHAT IT FINDS. A path BUILT under the shared OS temp directory with a name the
 * caller chose: `${tmpdir()}/dedalo_x_${process.pid}`, `join(tmpdir(), 'x')`,
 * `resolve(realpathSync(tmpdir()), …)`, `` `${process.env.TMPDIR ?? '/tmp'}/x` ``,
 * `join('/tmp', …)`, or a `/tmp/…${…}` template. On Linux `/tmp` is shared and
 * sticky: another local user who pre-creates that name, or plants a symlink
 * there (pids and Date.now() are guessable), redirects the gate's writes or feeds
 * it bytes (CodeQL js/insecure-temporary-file + js/file-system-race). The one
 * safe shape is a fresh private directory — `mkdtempSync(join(tmpdir(), prefix))`
 * (0700, unpredictable, created atomically), which is what
 * `test/helpers/scratch_dir.ts` hands out.
 *
 * WHY AN AST, NOT A GREP. The measure is the PATH EXPRESSION, not its spelling:
 * the temp root is recognised wherever it appears (a `tmpdir` import under any
 * local name, `os.tmpdir()`, `process.env.TMPDIR`/`Bun.env.TMPDIR`, the literal
 * `'/tmp'`), seen through the wrappers that keep it a temp root (`realpathSync`,
 * one-argument `resolve`, `??`/`||`, `String()`, a `const` alias), and convicted
 * only when a NAME is joined under it. The one allowed construction is the
 * template handed straight to `mkdtemp`/`mkdtempSync`. A bare `tmpdir()` (a cwd,
 * a `startsWith` precondition, a `TMPDIR:` env value) builds no path and is not
 * counted.
 *
 * HONEST LIMITS. Static: a temp root reaching a join through a function
 * parameter or a non-`const` variable is invisible; a string literal `'/tmp/x'`
 * with no interpolation is NOT counted (the tree uses those as fake paths in
 * assertions and as refusal inputs, which build nothing) — only `/tmp/…${…}`
 * templates and `/tmp` used as a join root are.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import { Glob } from 'bun';

/** The trees the census measures (repo-relative globs). */
export const PREDICTABLE_TMP_SCAN_GLOBS: readonly string[] = [
	'test/**/*.{ts,js,mjs}',
	'scripts/**/*.{ts,js,mjs}',
	'deploy/probes/**/*.{ts,js,mjs}',
	'publication/**/tests/**/*.{ts,js,mjs}',
	'publication/**/deploy/probes/**/*.{ts,js,mjs}',
	'client/dedalo/test/**/*.{ts,js,mjs}',
];

/**
 * The one file entitled to call mkdtemp on behalf of everyone else. NOT exempt
 * from the census: its only join sits inside `mkdtempSync` and is acquitted by
 * the same structural rule as every caller, so a fixed path planted in it is red.
 */
export const SCRATCH_HELPER = 'test/helpers/scratch_dir.ts';

export interface PredictableTmpFinding {
	readonly file: string;
	readonly line: number;
	readonly snippet: string;
}

type AstNode = { type: string; [key: string]: unknown };

const NOT_CODE_KEYS = new Set([
	'loc',
	'start',
	'end',
	'extra',
	'comments',
	'leadingComments',
	'trailingComments',
	'innerComments',
]);

const PATH_BUILDERS = new Set(['join', 'resolve']);
const MKDTEMP = new Set(['mkdtemp', 'mkdtempSync']);
const TRANSPARENT_CALLS = new Set(['realpathSync', 'realpath', 'String', 'normalize']);

/** The name a call is made BY: `f(` → f, `a.b.f(` → f. */
function calleeName(callee: AstNode): string | null {
	if (callee.type === 'Identifier') return callee.name as string;
	const isMember = callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression';
	const property = callee.property as AstNode | undefined;
	return isMember && callee.computed !== true && property?.type === 'Identifier'
		? (property.name as string)
		: null;
}

/** Walk with parent links. */
function walk(root: AstNode, visit: (node: AstNode, parent: AstNode | null) => void): void {
	const stack: Array<[unknown, AstNode | null]> = [[root, null]];
	while (stack.length > 0) {
		const [value, parent] = stack.pop() as [unknown, AstNode | null];
		if (Array.isArray(value)) {
			for (const child of value) stack.push([child, parent]);
			continue;
		}
		if (value === null || typeof value !== 'object') continue;
		const node = value as AstNode;
		if (typeof node.type !== 'string') continue;
		visit(node, parent);
		for (const [key, child] of Object.entries(node)) {
			if (!NOT_CODE_KEYS.has(key) && typeof child === 'object') stack.push([child, node]);
		}
	}
}

function stripTs(node: AstNode): AstNode {
	let current = node;
	while (
		current.type === 'TSAsExpression' ||
		current.type === 'TSNonNullExpression' ||
		current.type === 'TSSatisfiesExpression' ||
		current.type === 'ParenthesizedExpression'
	) {
		current = current.expression as AstNode;
	}
	return current;
}

interface FileScope {
	/** Local names the `tmpdir` function is imported/destructured as. */
	readonly tmpdirNames: Set<string>;
	/** Local names bound to the `os` module namespace. */
	readonly osNames: Set<string>;
	/** `const` names whose initializer is a temp root. */
	readonly rootAliases: Set<string>;
}

function isTmpLiteral(node: AstNode): boolean {
	if (node.type === 'StringLiteral') return node.value === '/tmp' || node.value === '/tmp/';
	if (node.type === 'TemplateLiteral') {
		const quasis = node.quasis as AstNode[];
		const cooked = quasis.map((q) => (q.value as { cooked: string }).cooked).join('');
		return (
			(node.expressions as unknown[]).length === 0 && (cooked === '/tmp' || cooked === '/tmp/')
		);
	}
	return false;
}

function isEnvTmpdir(node: AstNode): boolean {
	if (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression') return false;
	if (calleeName(node) !== 'TMPDIR') return false;
	const object = stripTs(node.object as AstNode);
	return calleeName(object) === 'env';
}

/** Is `node` (itself) an expression that evaluates to the OS temp directory? */
function isTempRoot(raw: AstNode, scope: FileScope): boolean {
	const node = stripTs(raw);
	if (isTmpLiteral(node) || isEnvTmpdir(node)) return true;
	if (node.type === 'Identifier') return scope.rootAliases.has(node.name as string);
	if (node.type === 'LogicalExpression') {
		return isTempRoot(node.left as AstNode, scope) || isTempRoot(node.right as AstNode, scope);
	}
	if (node.type === 'ConditionalExpression') {
		return (
			isTempRoot(node.consequent as AstNode, scope) || isTempRoot(node.alternate as AstNode, scope)
		);
	}
	if (node.type === 'CallExpression') {
		const callee = stripTs(node.callee as AstNode);
		const args = node.arguments as AstNode[];
		if (callee.type === 'Identifier' && scope.tmpdirNames.has(callee.name as string)) return true;
		if (
			callee.type === 'MemberExpression' &&
			calleeName(callee) === 'tmpdir' &&
			stripTs(callee.object as AstNode).type === 'Identifier' &&
			scope.osNames.has((stripTs(callee.object as AstNode).name as string) ?? '')
		) {
			return true;
		}
		const name = calleeName(callee);
		const first = args[0];
		if (first === undefined) return false;
		if (name !== null && TRANSPARENT_CALLS.has(name)) return isTempRoot(first, scope);
		if (name === 'resolve' && args.length === 1) return isTempRoot(first, scope);
	}
	return false;
}

/** Is `node` a path BUILT under a temp root (a name joined beneath it)? */
function isBuiltTempPath(raw: AstNode, scope: FileScope): boolean {
	const node = stripTs(raw);
	if (node.type === 'CallExpression') {
		const name = calleeName(stripTs(node.callee as AstNode));
		const args = node.arguments as AstNode[];
		const first = args[0];
		return (
			name !== null &&
			PATH_BUILDERS.has(name) &&
			args.length >= 2 &&
			first !== undefined &&
			isTempRoot(first, scope)
		);
	}
	if (node.type === 'TemplateLiteral') {
		const quasis = node.quasis as AstNode[];
		const expressions = node.expressions as AstNode[];
		const head = (quasis[0]?.value as { cooked: string } | undefined)?.cooked ?? '';
		const firstExpression = expressions[0];
		if (head === '' && firstExpression !== undefined && isTempRoot(firstExpression, scope)) {
			const next = (quasis[1]?.value as { cooked: string } | undefined)?.cooked ?? '';
			return next.length > 0 || expressions.length > 1;
		}
		// A literal `/tmp/<name>…${…}` template: a path built under /tmp.
		return expressions.length > 0 && /^\/tmp\/./.test(head);
	}
	if (node.type === 'BinaryExpression' && node.operator === '+') {
		// `tmpdir() + sep` / `tmpdir() + '/'` is the root's own prefix (a
		// startsWith operand), not a name built under it.
		const right = stripTs(node.right as AstNode);
		const bareSeparator =
			calleeName(right) === 'sep' || (right.type === 'StringLiteral' && right.value === '/');
		return !bareSeparator && isTempRoot(node.left as AstNode, scope);
	}
	return false;
}

function collectScope(program: AstNode): FileScope {
	const scope: FileScope = { tmpdirNames: new Set(), osNames: new Set(), rootAliases: new Set() };
	walk(program, (node) => {
		if (node.type === 'ImportDeclaration') {
			const source = (node.source as AstNode).value as string;
			if (source !== 'node:os' && source !== 'os') return;
			for (const spec of node.specifiers as AstNode[]) {
				const local = (spec.local as AstNode).name as string;
				if (spec.type === 'ImportSpecifier') {
					const imported = spec.imported as AstNode;
					if ((imported.name ?? imported.value) === 'tmpdir') scope.tmpdirNames.add(local);
				} else {
					scope.osNames.add(local);
				}
			}
		}
		// `const { tmpdir } = require('node:os')` / `await import('node:os')`.
		if (node.type === 'VariableDeclarator' && (node.id as AstNode).type === 'ObjectPattern') {
			const init = node.init as AstNode | null;
			const text = init === null ? '' : JSON.stringify(init);
			if (!/"value":"(node:)?os"/.test(text)) return;
			for (const prop of (node.id as AstNode).properties as AstNode[]) {
				const key = prop.key as AstNode | undefined;
				const value = prop.value as AstNode | undefined;
				if (key?.name === 'tmpdir' && value?.type === 'Identifier')
					scope.tmpdirNames.add(value.name as string);
			}
		}
	});
	// `const base = tmpdir()` / `const tmp = process.env.TMPDIR ?? '/tmp'` — to a
	// fixed point, so an alias of an alias is still a root.
	for (let changed = true; changed; ) {
		changed = false;
		walk(program, (node, parent) => {
			if (node.type !== 'VariableDeclarator' || (node.id as AstNode).type !== 'Identifier') return;
			if (parent?.type !== 'VariableDeclaration' || parent.kind !== 'const') return;
			const init = node.init as AstNode | null;
			const name = (node.id as AstNode).name as string;
			if (init !== null && !scope.rootAliases.has(name) && isTempRoot(init, scope)) {
				scope.rootAliases.add(name);
				changed = true;
			}
		});
	}
	return scope;
}

/** Census one source text. `file` is repo-relative (used for the parser plugin and the report). */
export function predictableTmpFindings(file: string, source: string): PredictableTmpFinding[] {
	const isTs = file.endsWith('.ts');
	const ast = parse(source, {
		sourceType: 'module',
		allowReturnOutsideFunction: true,
		errorRecovery: true,
		plugins: isTs ? ['typescript', 'decorators-legacy'] : [],
	});
	const program = ast.program as unknown as AstNode;
	const scope = collectScope(program);
	const findings: PredictableTmpFinding[] = [];
	const lines = source.split('\n');
	walk(program, (node, parent) => {
		if (!isBuiltTempPath(node, scope)) return;
		// The one allowed construction: the template handed straight to mkdtemp.
		if (
			parent !== null &&
			parent.type === 'CallExpression' &&
			(parent.arguments as AstNode[])[0] === node &&
			MKDTEMP.has(calleeName(stripTs(parent.callee as AstNode)) ?? '')
		) {
			return;
		}
		// A template nested in another built path (`join(`${tmpdir()}/a`, 'b')`) counts once.
		if (parent !== null && isBuiltTempPath(parent, scope)) return;
		const line = (node.loc as { start: { line: number } }).start.line;
		findings.push({ file, line, snippet: (lines[line - 1] ?? '').trim().slice(0, 160) });
	});
	return findings.sort((a, b) => a.line - b.line);
}

/** Census every measured file under `repoRoot`. */
export function predictableTmpCensus(repoRoot: string): {
	readonly scanned: number;
	readonly findings: PredictableTmpFinding[];
} {
	const files = new Set<string>();
	for (const pattern of PREDICTABLE_TMP_SCAN_GLOBS) {
		for (const rel of new Glob(pattern).scanSync({ cwd: repoRoot, dot: false })) {
			if (rel.includes('node_modules/') || rel.includes('/fixtures/')) continue;
			files.add(rel);
		}
	}
	const findings: PredictableTmpFinding[] = [];
	for (const rel of [...files].sort()) {
		findings.push(...predictableTmpFindings(rel, readFileSync(join(repoRoot, rel), 'utf8')));
	}
	return { scanned: files.size, findings };
}
