/**
 * TRIPWIRE — the client builds no code from strings (T2 S10-a).
 *
 * `Function(text)` and `eval(text)` turn DATA into script. The one use the
 * client's own code had — `tool_common.js` running a tool registration's
 * `windowFeatures` value — let whoever could write a tool record run script in
 * every user's page; it is a parser now
 * (`client/dedalo/core/tools_common/js/window_features.js`,
 * gate `client_window_features.test.ts`). This file keeps the next one out:
 *
 *   every `.js` file under `client/dedalo/**` and `tools/**` holds no ROUTE to
 *   the string compilers. There is no allowlist: both trees are first-party.
 *   Third-party libraries are not in them — they are served from
 *   `node_modules` through the CLIENT_LIBS registry (src/core/client_libs/) —
 *   so a library copied into either tree is scanned like our own code.
 *
 * WHAT IS MEASURED (T2 B1 review, S3-4). Until 2026-11-19 this was a regex for
 * the call SPELLINGS `Function(` / `eval(`, so `const F = globalThis.Function;
 * F(text)`, `window['eval']`, `Reflect.construct(Function, [text])` and
 * `setTimeout(text)` all read as zero. The census is now over the parsed
 * program (@babel/parser — comments and unrelated strings are not code), and
 * what it refuses is every way the NAME of a compiler can be reached, called or
 * not:
 *
 *   1. the identifier `Function` or `eval` anywhere — a call, a bare reference
 *      (an alias, an argument: `Reflect.construct(Function, …)`), a property
 *      (`globalThis.Function`, `window.eval`), a destructuring key;
 *   2. the string `'eval'` / `'Function'` / `'constructor'` as a literal or a
 *      whole template (`window['eval']`, `fn['constructor']`);
 *   3. `.constructor` used as anything but a read of itself: called
 *      (`(() => {}).constructor(text)`, `new x.constructor(…)`), chained
 *      (`.constructor.constructor`), or carried away (assigned, passed,
 *      destructured). `x.constructor.name`, a comparison and an assignment TO
 *      it stay legal — the six real uses;
 *   4. a timer (`setTimeout` / `setInterval` / `setImmediate` / `execScript`)
 *      whose first argument is not function-shaped: a string, a template, a
 *      concatenation — the browser compiles those.
 *
 * A file that does not parse is RED, never skipped. Positive controls plant
 * each route (the review's four among them); the real `.constructor` shapes and
 * the lookalikes are negatives; the walk is floored.
 *
 * HONEST LIMITS. A name assembled at run time (`window['ev' + 'al']`) and a
 * timer handed an IDENTIFIER that holds a string cannot be decided from the
 * source; the other string-to-script sinks (a `<script>` node's text, an
 * `on*` attribute, a `javascript:` URL, `import()` of a built URL, a Worker
 * from a Blob) are render_escape_tripwire's and the CSP's ground, not this
 * file's. The CSP cannot be the measurement here: `'unsafe-eval'` stays for a
 * KNOWN list of third-party dependants (src/core/api/static_asset.ts).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import { browserSourcesUnfiltered } from '../helpers/browser_corpus.ts';

const REPO = join(import.meta.dir, '..', '..');

/** A dependency install inside a tool directory is not the tool's code. */
function isVendored(path: string): boolean {
	return `/${path}`.includes('/node_modules/');
}

interface AstNode {
	type: string;
	loc?: { start: { line: number } };
	[key: string]: unknown;
}

const COMPILER_NAMES = new Set(['Function', 'eval']);
const COMPILER_STRINGS = new Set(['Function', 'eval', 'constructor']);
const TIMERS = new Set(['setTimeout', 'setInterval', 'setImmediate', 'execScript']);
/** What a timer's first argument may be: a function, or something that can only be judged at run time. */
const TIMER_CALLBACK_SHAPES = new Set([
	'ArrowFunctionExpression',
	'FunctionExpression',
	'Identifier',
	'MemberExpression',
	'OptionalMemberExpression',
	'CallExpression',
	'OptionalCallExpression',
]);
const MEMBERS = new Set(['MemberExpression', 'OptionalMemberExpression']);
const CALLS = new Set(['CallExpression', 'OptionalCallExpression', 'NewExpression']);
const COMPARISONS = new Set(['===', '!==', '==', '!=', 'instanceof']);

/** `x.name` (not `x[name]`) → the name; anything else → null. */
function plainProperty(node: AstNode): string | null {
	if (!MEMBERS.has(node.type) || node.computed === true) return null;
	const property = node.property as AstNode;
	return property.type === 'Identifier' ? (property.name as string) : null;
}

/** The name a call is made through: `f(…)` → f, `a.b.f(…)` → f. */
function calleeName(call: AstNode): string | null {
	const callee = call.callee as AstNode;
	if (callee.type === 'Identifier') return callee.name as string;
	return plainProperty(callee);
}

/** Is this `.constructor` read one of the harmless ones (see the header, rule 3)? */
function constructorReadIsInert(parent: AstNode, key: string): boolean {
	// x.constructor.name — but never x.constructor.constructor
	if (MEMBERS.has(parent.type) && key === 'object') return plainProperty(parent) !== 'constructor';
	// x.constructor === Foo
	if (parent.type === 'BinaryExpression') return COMPARISONS.has(parent.operator as string);
	// proto.constructor = Foo
	return parent.type === 'AssignmentExpression' && key === 'left';
}

function sinksOfNode(node: AstNode, parent: AstNode, key: string): string[] {
	const found: string[] = [];
	if (node.type === 'Identifier' && COMPILER_NAMES.has(node.name as string)) {
		found.push(`the name ${node.name as string}`);
	}
	if (node.type === 'StringLiteral' && COMPILER_STRINGS.has(node.value as string)) {
		found.push(`the string '${node.value as string}'`);
	}
	if (node.type === 'TemplateElement') {
		const cooked = (node.value as { cooked?: string }).cooked ?? '';
		if (COMPILER_STRINGS.has(cooked)) found.push(`the template \`${cooked}\``);
	}
	if (plainProperty(node) === 'constructor' && !constructorReadIsInert(parent, key)) {
		found.push('.constructor called, chained or carried away');
	}
	// const { constructor: F } = fn
	if (node.type === 'ObjectPattern') {
		for (const property of node.properties as AstNode[]) {
			const name = (property.key as AstNode | undefined)?.name;
			if (name === 'constructor') found.push('.constructor destructured');
		}
	}
	if (CALLS.has(node.type) && TIMERS.has(calleeName(node) ?? '')) {
		const first = (node.arguments as AstNode[])[0];
		if (first !== undefined && !TIMER_CALLBACK_SHAPES.has(first.type)) {
			found.push(`${calleeName(node)} given a ${first.type}, not a function`);
		}
	}
	return found;
}

/**
 * Every route to a string compiler in a source text (see the header), as
 * `line N: <what>`. Throws when the text does not parse — an unreadable file is
 * not a clean one.
 */
function dynamicCode(source: string): string[] {
	const program = parse(source, { sourceType: 'unambiguous' }).program as unknown as AstNode;
	const found: string[] = [];
	const visit = (node: AstNode, parent: AstNode, key: string): void => {
		for (const what of sinksOfNode(node, parent, key)) {
			found.push(`line ${node.loc?.start.line ?? '?'}: ${what}`);
		}
		for (const [childKey, value] of Object.entries(node)) {
			if (childKey === 'loc' || childKey.endsWith('Comments')) continue;
			for (const child of Array.isArray(value) ? value : [value]) {
				if (child !== null && typeof child === 'object' && typeof child.type === 'string') {
					visit(child as AstNode, node, childKey);
				}
			}
		}
	};
	visit(program, program, '');
	return found;
}

/** Every .js under the browser trees in git's view (a registered lister), UNFILTERED. */
function firstPartyFiles(): string[] {
	return browserSourcesUnfiltered()
		.filter((path) => !isVendored(path))
		.sort();
}

describe('no first-party client code is built from a string', () => {
	test('FLOOR: the walk reads the client and the tools — a `lib/` directory included', () => {
		const files = firstPartyFiles();
		expect(files.length).toBeGreaterThan(500);
		expect(files).toContain('client/dedalo/core/tools_common/js/tool_common.js');
		expect(files.some((path) => path.startsWith('tools/'))).toBe(true);
		expect(files).toContain('tools/tool_transcription/transcribers/lib/vad.js');
		expect(files.some((path) => path.includes('/node_modules/'))).toBe(false);
	});

	test('zero routes to a string compiler in the client and the tools — and every file PARSED', () => {
		let parsed = 0;
		const offenders = firstPartyFiles()
			.map((path) => {
				const calls = dynamicCode(readFileSync(join(REPO, path), 'utf8'));
				parsed += 1;
				return { path, calls };
			})
			.filter((entry) => entry.calls.length > 0)
			.map((entry) => `${entry.path}: ${entry.calls.join('; ')}`);
		expect(offenders).toEqual([]);
		// the census read programs, not file names
		expect(parsed).toBeGreaterThan(500);
	});

	test('a file that does not parse is refused, never read as clean', () => {
		expect(() => dynamicCode('const = ;')).toThrow();
	});

	test('POSITIVE CONTROLS: every route is seen, called or not', () => {
		const planted: Record<string, string> = {
			'Function call': 'const value = Function(features[key])()',
			'new Function': "const run = new Function('a', 'return a')",
			eval: 'const out = eval(text)',
			'eval, spaced': 'eval (text)',
			'through the global object':
				'const a = window.eval(text); const b = globalThis.Function(body)()',
			// the review's four (T2 B1 S3-4): none is a `Function(` / `eval(` spelling
			'an alias of the global': 'const F = globalThis.Function; F(features.left)()',
			'bracket access': "const run = window['eval']; run(text)",
			'Reflect.construct': 'Reflect.construct(Function, [body])',
			'a timer given text': "setTimeout('location.reload()', 10)",
			// and their neighbours
			'a bare alias': 'const compile = Function; compile(body)()',
			'indirect eval': '(0, eval)(text)',
			'optional call': 'globalThis.eval?.(text)',
			'bracket access, template': 'const run = self[`eval`]; run(text)',
			destructured: 'const { eval: run } = window; run(text)',
			'Function.prototype': 'Function.prototype.constructor.call(null, body)()',
			'the constructor of a function, called': 'const f = (() => {}).constructor(body); f()',
			'the constructor of a constructor': 'const f = [].constructor.constructor(body); f()',
			'the constructor, carried away': 'const F = handler.constructor; F(body)()',
			'the constructor, passed': 'Reflect.construct(handler.constructor, [body])',
			'the constructor, by string': "const F = handler['constructor']; F(body)()",
			'the constructor, destructured': 'const { constructor: F } = handler; F(body)()',
			'new on a constructor': 'const f = new handler.constructor(body)',
			'a timer given a template': 'window.setTimeout(`run(${id})`, 0)',
			'a timer given a concatenation': "setInterval('tick(' + id + ')', 1000)",
			'a timer given a choice of texts': "setTimeout(fast ? 'a()' : 'b()', 5)",
		};
		for (const [name, source] of Object.entries(planted)) {
			expect(`${name}: ${dynamicCode(source).length > 0}`).toBe(`${name}: true`);
		}
	});

	test('NEGATIVE CONTROLS: lookalikes and the real `.constructor` reads are not routes', () => {
		const innocent: Record<string, string> = {
			'a method named like it': 'assert.isFunction(form.on_submit); page.waitForFunction(fn)',
			'a type check': "if (typeof handler === 'function') handler()",
			'only a comment': "// never eval() a label\n/* Function('return this') */\nconst a = 1",
			'a property': 'const retrieval = options.evaluate(x); medieval(1)',
			'a string that only mentions it':
				"const hint = 'do not use eval here'; const k = 'Functions'",
			// the six real shapes in the client today
			'constructor.name': 'const model = instance.constructor.name',
			'constructor compared': 'const plain = value.constructor === Object',
			'constructor assigned to': 'child.prototype.constructor = child',
			'a class constructor': 'class A { constructor() { this.a = 1 } }',
			// timers with a function, or something only run time can judge
			'a timer with an arrow': 'setTimeout(() => tick(), 10)',
			'a timer with a function': 'setInterval(function () { tick() }, 10)',
			'a timer with a named callback':
				'window.setTimeout(tick, 2000); setTimeout(self.refresh.bind(self), 1)',
		};
		for (const [name, source] of Object.entries(innocent)) {
			expect(`${name}: ${dynamicCode(source).join(' | ')}`).toBe(`${name}: `);
		}
	});
});
