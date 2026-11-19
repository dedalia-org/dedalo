/**
 * A reader of the tool's modules as text, for its censuses: the files, and for the
 * request budgets call arguments, loop spans, top-level functions and the wait each
 * one adds up to. Not a parser: it reads the shapes the tool's code is written in.
 */

import { Glob } from 'bun';
import { stripComments } from '../../../helpers/strip_comments.ts';

/** A path under the tool's root, `tools/tool_uca_maps/`. */
export function toolUrl(relative = ''): URL {
	return new URL(`../../../../tools/tool_uca_maps/${relative}`, import.meta.url);
}

/** Each file under the tool's root that `pattern` matches: its relative path and raw text. */
export async function toolSources(pattern: string): Promise<Array<[string, string]>> {
	const found: Array<[string, string]> = [];
	for await (const relative of new Glob(pattern).scan({ cwd: Bun.fileURLToPath(toolUrl()) })) {
		found.push([relative, await Bun.file(toolUrl(relative)).text()]);
	}
	return found;
}

/**
 * A module with its comments stripped, so a name or a loop mentioned in prose is
 * never read as code. Regex bodies are blanked too: a bracket inside one would
 * throw off every bracket count below.
 */
export function codeOf(source: string): string {
	return stripComments(source, { blankRegexBodies: true });
}

/** The first `{…}` argument of every `<callee>(` call, brace-matched. */
export function callArguments(source: string, callee = 'tool_request'): string[] {
	const found: string[] = [];
	const call = new RegExp(`\\b${callee}\\(\\s*\\{`, 'g');
	for (let match = call.exec(source); match !== null; match = call.exec(source)) {
		const open = source.indexOf('{', match.index);
		let depth = 0;
		let end = open;
		for (; end < source.length; end++) {
			if (source[end] === '{') depth++;
			else if (source[end] === '}' && --depth === 0) break;
		}
		found.push(source.slice(open, end + 1));
		call.lastIndex = end;
	}
	return found;
}

/** `4 * 60 * 1000`, `15_000`: digits, `_` and `*` only; anything else is null. */
export function productMs(expression: string): number | null {
	if (!/^[0-9_ *]+$/.test(expression.trim())) return null;
	return expression
		.split('*')
		.map((factor) => Number(factor.trim().replaceAll('_', '')))
		.reduce((product, factor) => product * factor, 1);
}

/** Tool modules a module imports (`from './x.ts'`). */
export function localImports(source: string): string[] {
	return [...source.matchAll(/from '\.\/([a-z_]+\.ts)'/g)].map((m) => m[1] as string);
}

/** The `(…)` or `{…}` span that opens at or after `from`, bracket-matched. */
export function bracketSpan(source: string, from: number): [number, number] {
	const open = source.slice(from).search(/[({]/) + from;
	const close = source[open] === '(' ? ')' : '}';
	let depth = 0;
	for (let at = open; at < source.length; at++) {
		if (source[at] === source[open]) depth++;
		else if (source[at] === close && --depth === 0) return [open, at];
	}
	return [open, source.length];
}

/** A statement body: a `{…}` block, or one statement up to its `;` (brackets matched). */
export function statementSpan(source: string, from: number): [number, number] {
	const start = source.slice(from).search(/\S/) + from;
	if (source[start] === '{') return bracketSpan(source, start);
	let depth = 0;
	for (let at = start; at < source.length; at++) {
		const char = source[at] as string;
		if ('([{'.includes(char)) depth++;
		else if (')]}'.includes(char)) depth--;
		else if (char === ';' && depth === 0) return [start, at];
	}
	return [start, source.length];
}

/** Spans a call repeats in: a loop body (braced or not, `for await` too), an iterating callback. */
export function loopSpans(source: string): Array<[number, number]> {
	const spans: Array<[number, number]> = [];
	for (const match of source.matchAll(/\b(?:for(?:\s+await)?|while)\s*\(/g)) {
		const [, head] = bracketSpan(source, match.index + match[0].length - 1);
		spans.push(statementSpan(source, head + 1));
	}
	for (const match of source.matchAll(/\bdo\s*\{/g)) {
		spans.push(bracketSpan(source, match.index));
	}
	for (const match of source.matchAll(/\.(?:map|flatMap|forEach|reduce|filter|some|every)\(/g)) {
		spans.push(bracketSpan(source, match.index + 1));
	}
	return spans;
}

/** A top-level function of a module: its name and the span of its body. */
export interface ModuleFunction {
	name: string;
	body: [number, number];
}

/** Top-level `function f(…) {…}` and `const f = (…) => …` of a module. */
export function moduleFunctions(source: string): ModuleFunction[] {
	const found: ModuleFunction[] = [];
	for (const match of source.matchAll(/^(?:export )?(?:async )?function\s+(\w+)/gm)) {
		const [, params] = bracketSpan(source, match.index + match[0].length);
		// the body is the first `{` outside a return type's `<…>`
		let angle = 0;
		let at = params + 1;
		for (; at < source.length; at++) {
			const char = source[at];
			if (char === '<') angle++;
			else if (char === '>' && source[at - 1] !== '=') angle--;
			else if (char === '{' && angle === 0) break;
		}
		found.push({ name: match[1] as string, body: bracketSpan(source, at) });
	}
	for (const match of source.matchAll(/^(?:export )?const (\w+)\s*=\s*(?:async\s*)?\(/gm)) {
		const [, params] = bracketSpan(source, match.index + match[0].length - 1);
		const arrow = source.indexOf('=>', params);
		found.push({ name: match[1] as string, body: statementSpan(source, arrow + 2) });
	}
	return found;
}

/** Where each name a module calls lives: its own functions, then its `./x.ts` imports. */
export function moduleScope(file: string, source: string): Map<string, string> {
	const scope = new Map<string, string>();
	for (const match of source.matchAll(/import \{([^}]*)\} from '\.\/([a-z_]+\.ts)'/g)) {
		for (const name of (match[1] as string).split(',')) {
			const bare = name.replace(/^\s*type\s+/, '').trim();
			if (bare !== '' && !name.trim().startsWith('type ')) scope.set(bare, match[2] as string);
		}
	}
	for (const fn of moduleFunctions(source)) scope.set(fn.name, file);
	return scope;
}

/** A priced call in a function body: the callee, where it is, what it costs. */
export interface PricedCall {
	callee: string;
	at: number;
	price: number;
}

/**
 * Prices every top-level function of `sources`: `primitives` at their price, the
 * rest at the sum of the priced calls in their body (a reference counts as a call,
 * so `.then(f)` is no escape). Recursion is priced once. It reads plain `function f`
 * and `const f = (…) =>` with named imports: a wrapped const, an aliased or namespace
 * import or an object return type is outside what it parses.
 */
export function priceServer(
	sources: ReadonlyMap<string, string>,
	primitives: ReadonlyMap<string, number>,
): {
	priceOf: (file: string, name: string) => number;
	callsIn: (file: string, fn: ModuleFunction) => PricedCall[];
} {
	const functions = new Map([...sources].map(([file, source]) => [file, moduleFunctions(source)]));
	const memo = new Map<string, number>();
	const callsIn = (file: string, fn: ModuleFunction): PricedCall[] => {
		const source = sources.get(file) ?? '';
		const scope = moduleScope(file, source);
		const body = source.slice(fn.body[0], fn.body[1]);
		const calls: PricedCall[] = [];
		for (const name of new Set([...scope.keys(), ...primitives.keys()])) {
			for (const match of body.matchAll(new RegExp(`(?<![.\\w])${name}\\b`, 'g'))) {
				const price = primitives.get(name) ?? priceOf(scope.get(name) as string, name);
				if (price > 0) calls.push({ callee: name, at: fn.body[0] + match.index, price });
			}
		}
		return calls;
	};
	const priceOf = (file: string, name: string): number => {
		const primitive = primitives.get(name);
		if (primitive !== undefined) return primitive;
		const key = `${file}:${name}`;
		const known = memo.get(key);
		if (known !== undefined) return known;
		memo.set(key, 0);
		const fn = functions.get(file)?.find((candidate) => candidate.name === name);
		const price =
			fn === undefined ? 0 : callsIn(file, fn).reduce((sum, call) => sum + call.price, 0);
		memo.set(key, price);
		return price;
	};
	return { priceOf, callsIn };
}
