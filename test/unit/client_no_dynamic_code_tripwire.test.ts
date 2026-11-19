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
 *   every `.js` file under `client/dedalo/**` and `tools/**` holds no
 *   `Function(` / `new Function(` / `eval(` call. There is no allowlist: both
 *   trees are first-party. Third-party libraries are not in them — they are
 *   served from `node_modules` through the CLIENT_LIBS registry
 *   (src/core/client_libs/) — so a library copied into either tree is scanned
 *   like our own code.
 *
 * Comments are stripped before the scan (the word may be discussed, not used).
 * Positive controls plant each spelling; the walk is floored.
 * It is also why the CSP's `'unsafe-eval'` has a KNOWN list of dependants
 * (src/core/api/static_asset.ts): third-party libraries, never our own code.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { browserSourcesUnfiltered } from '../helpers/browser_corpus.ts';

const REPO = join(import.meta.dir, '..', '..');

/** A dependency install inside a tool directory is not the tool's code. */
function isVendored(path: string): boolean {
	return `/${path}`.includes('/node_modules/');
}

function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/** The dynamic-code calls in a source text: `Function(`, `new Function(`, `eval(`. */
function dynamicCode(source: string): string[] {
	const code = stripComments(source);
	return [...code.matchAll(/(?<![\w$])(?:new\s+)?(?:Function|eval)\s*\(/g)].map((m) => m[0]);
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

	test('zero `Function(` / `eval(` calls in the client and the tools', () => {
		const offenders = firstPartyFiles()
			.map((path) => ({ path, calls: dynamicCode(readFileSync(join(REPO, path), 'utf8')) }))
			.filter((entry) => entry.calls.length > 0)
			.map((entry) => `${entry.path}: ${entry.calls.join(' ')}`);
		expect(offenders).toEqual([]);
	});

	test('POSITIVE CONTROLS: each spelling is seen; a lookalike is not', () => {
		const planted: Record<string, string> = {
			'Function call': 'const value = Function(features[key])()',
			'new Function': "const run = new Function('a', 'return a')",
			eval: 'const out = eval(text)',
			'eval, spaced': 'eval (text)',
			'through the global object':
				'const a = window.eval(text); const b = globalThis.Function(body)()',
		};
		for (const [name, source] of Object.entries(planted)) {
			expect(`${name}: ${dynamicCode(source).length > 0}`).toBe(`${name}: true`);
		}
		const innocent: Record<string, string> = {
			'a method named like it': 'assert.isFunction(form.on_submit); page.waitForFunction(fn)',
			'a type check': "if (typeof handler === 'function') handler()",
			'only a comment': "// never eval() a label\n/* Function('return this') */\nconst a = 1",
			'a property': 'const retrieval = options.evaluate(x); medieval(1)',
		};
		for (const [name, source] of Object.entries(innocent)) {
			expect(`${name}: ${dynamicCode(source).length > 0}`).toBe(`${name}: false`);
		}
	});
});
