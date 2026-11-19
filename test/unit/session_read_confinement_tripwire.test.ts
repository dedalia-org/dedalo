/**
 * TRIPWIRE — the session STORE is read by three modules only (S09-a).
 *
 * `getSession` answers "is this token a live session" and nothing else: no
 * maintenance verdict (Gate 2b). A route that asks it directly is open to a
 * non-root session under maintenance — which is what eight routes did until
 * 2026-11-19, each behind its own copy of the cookie parser. The behaviour is
 * pinned per route in `non_dispatch_session_gate_native.test.ts`; this file
 * keeps the NEXT route from being written the old way:
 *
 *  (a) only `session_gate.ts` (the gate itself) and `dd_utils_api.ts` (login:
 *      the session it has just minted) may reach `getSession`, in `src/` and
 *      `tools/` — by a named import, an alias, a namespace import, a re-export
 *      or a dynamic import;
 *  (b) the dispatcher's own, verdict-free read (`dispatchSessionFromCookie`) is
 *      reachable from `server.ts` only, which calls it once — for the RQO
 *      dispatch context, where dispatch.ts applies the gate itself.
 *
 * A file "reaches" a binding when it names the module AND either names the
 * binding or holds the module whole. Positive controls plant every spelling.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Glob } from 'bun';

const REPO = join(import.meta.dir, '..', '..');
const ROOTS = ['src', 'tools'];

const STORE = 'session_store.ts';
const GATE = 'session_gate.ts';

/** Who may reach `getSession`: the store's own file is not an importer. */
const GET_SESSION_ALLOWED: readonly string[] = [
	'src/core/security/session_gate.ts',
	'src/core/api/handlers/dd_utils_api.ts',
];
const DISPATCH_READ_ALLOWED: readonly string[] = ['src/server.ts'];

function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Whether `source` can reach `binding` of the module whose file is `moduleFile`.
 * Module named (any import / export-from / dynamic import / require) AND: the
 * binding named anywhere in code, or the module held whole.
 */
function reaches(source: string, moduleFile: string, binding: string): boolean {
	const code = stripComments(source);
	const escaped = moduleFile.replace(/\./g, '\\.');
	const specifier = `['"\`][^'"\`\\n]*\\b${escaped}['"\`]`;
	if (!new RegExp(specifier).test(code)) return false;
	if (new RegExp(`\\b${binding}\\b`).test(code)) return true;
	// Held whole: `import * as x from`, `export * from`, or a dynamic import /
	// require whose result is not destructured on the spot.
	if (new RegExp(`(?:import|export)\\s*\\*[^;]*from\\s*${specifier}`).test(code)) return true;
	const dynamic = new RegExp(`(?:import|require)\\s*\\(\\s*${specifier}\\s*\\)`, 'g');
	for (const match of code.matchAll(dynamic)) {
		const before = code.slice(Math.max(0, (match.index ?? 0) - 160), match.index ?? 0);
		const destructured = /(?:const|let|var)\s*\{[^{}]*\}\s*=\s*(?:await\s*)?$/.test(before);
		if (!destructured) return true;
	}
	return false;
}

function sources(): Map<string, string> {
	const files = new Map<string, string>();
	for (const root of ROOTS) {
		for (const path of new Glob('**/*.ts').scanSync({ cwd: join(REPO, root), absolute: true })) {
			if (path.includes('/node_modules/')) continue;
			files.set(relative(REPO, path), readFileSync(path, 'utf8'));
		}
	}
	return files;
}

function reachers(moduleFile: string, binding: string): string[] {
	return [...sources()]
		.filter(([path]) => !path.endsWith(`/${moduleFile}`))
		.filter(([, source]) => reaches(source, moduleFile, binding))
		.map(([path]) => path)
		.sort();
}

describe('the session store is asked by the gate, never by a route', () => {
	test('FLOOR: the walk reads the engine and the tools', () => {
		const files = sources();
		expect(files.size).toBeGreaterThan(1000);
		expect(files.has('src/server.ts')).toBe(true);
		expect([...files.keys()].some((path) => path.startsWith('tools/'))).toBe(true);
	});

	test('(a) `getSession` is reached by the session gate and login — exactly', () => {
		expect(reachers(STORE, 'getSession')).toEqual([...GET_SESSION_ALLOWED].sort());
	});

	test('(b) the verdict-free dispatch read is reached by server.ts only, and called once', () => {
		expect(reachers(GATE, 'dispatchSessionFromCookie')).toEqual([...DISPATCH_READ_ALLOWED]);
		const server = stripComments(readFileSync(join(REPO, 'src/server.ts'), 'utf8'));
		expect(server.match(/\bdispatchSessionFromCookie\s*\(/g) ?? []).toHaveLength(1);
	});

	test('POSITIVE CONTROLS: every spelling of a store read is seen; a neighbour import is not', () => {
		const planted: Record<string, string> = {
			named: "import { getSession } from '../security/session_store.ts';",
			alias: "import { SESSION_COOKIE, getSession as live } from '../security/session_store.ts';",
			namespace:
				"import * as store from '../security/session_store.ts';\nstore['get' + 'Session'](t);",
			reexport: "export * from './session_store.ts';",
			'named re-export': "export { getSession } from './session_store.ts';",
			'dynamic, destructured':
				"const { getSession } = await import('../../security/session_store.ts');",
			'dynamic, held whole':
				"const store = await import('../../security/session_store.ts');\nstore['get' + 'Session'](t);",
			'dynamic, passed on': "use(await import('../../security/session_store.ts'));",
		};
		for (const [name, source] of Object.entries(planted)) {
			expect(`${name}: ${reaches(source, STORE, 'getSession')}`).toBe(`${name}: true`);
		}
		const innocent: Record<string, string> = {
			'another binding': "import { SESSION_COOKIE, createSession } from './session_store.ts';",
			'dynamic, another binding':
				"const { setSessionLangs } = await import('../../security/session_store.ts');",
			'only a comment': "// getSession lives in session_store.ts\nimport { x } from './other.ts';",
			'the gate, not the store':
				"import { liveSessionFromCookie } from '../security/session_gate.ts';",
		};
		for (const [name, source] of Object.entries(innocent)) {
			expect(`${name}: ${reaches(source, STORE, 'getSession')}`).toBe(`${name}: false`);
		}
	});
});
