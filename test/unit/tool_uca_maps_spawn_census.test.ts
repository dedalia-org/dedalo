/**
 * tool_uca_maps — every binary the server runs goes through `runToolBinary`. That
 * one door is what gives every spawn gdal_offline's `OFFLINE_ENV`, its scratch as
 * temp dir and a named input driver, so a spawn outside it would bypass all three.
 * Read as source: a binding census of the server modules, with planted cases.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { Glob } from 'bun';

/** Server files that may spawn outside `runToolBinary`, each with its reason. */
const SPAWN_EXEMPT: Readonly<Record<string, string>> = {
	'capabilities.ts': '--version only, no input file: probeOnPath bounds it itself',
};

// A binding census (after agent_confinement_tripwire's), one hop deep: what a
// file reaches of `bun`, child_process or core's media engine, however bound.
// Every engine export counts as a spawn unless ENGINE_INERT names it, so a core
// wrapper that spawns (`runIdentify`) is red by default. The spelling census
// stays as a backstop: a re-export or a `globalThis.Bun` still spells it.
const PROCESS_MODULES = new Set(['bun', 'node:child_process', 'child_process']);
const ENGINE_DIR = resolve(import.meta.dir, '../../src/core/media/engine');
/** Engine exports that start no process, by module. Closed: a new import is a spawn until listed. */
const ENGINE_INERT: Readonly<Record<string, readonly string[]>> = {
	'admission.ts': ['withConverterSlot'],
	'binaries.ts': [
		'identifyAvailable',
		'magickPolicyEnv',
		'magickResourceLimitArgs',
		'resolveIdentify',
		'resolveMagick',
	],
	'spawn.ts': ['assertSpawnOk'],
};
const SERVER = resolve(import.meta.dir, '../../tools/tool_uca_maps/server');
/** `Bun.<member>` reads (or named imports from 'bun') that cannot start a process. Closed. */
const BUN_INERT = new Set(['file', 'write', 'which', 'Glob']);
const PROCESS_REF = '__UCA_PROCESS_REF__';
const BUN_GLOBAL = '__UCA_BUN_GLOBAL__';
const IMPORT_LINE = /^import\s+([^;"'`]+?)\s+from\s*["']([^"']+)["'];?[ \t]*$/gm;
const EXPORT_FROM_LINE = /^export\s+([^;"'`]+?)\s+from\s*["']([^"']+)["'];?[ \t]*$/gm;
const SPELLED_SPAWN =
	/\brunBinary\b|\bBun\.spawn(Sync)?\b|\bBun\.\$|['"](node:)?child_process['"]|import\s*\{[^}]*(\bspawn(Sync)?\b|\$)[^}]*\}\s*from\s*['"]bun['"]/;
const TS = new Bun.Transpiler({ loader: 'ts' });

/** The locals an import clause binds, with what each imports (`*`, `default` or a name). */
function importBindings(clause: string): { imported: string; local: string }[] {
	const out: { imported: string; local: string }[] = [];
	const namespace = clause.match(/\*\s*as\s+([\w$]+)/);
	if (namespace?.[1]) out.push({ imported: '*', local: namespace[1] });
	for (const part of (clause.match(/\{([^}]*)\}/)?.[1] ?? '').split(',')) {
		const [imported, local] = part.trim().split(/\s+as\s+/);
		if (imported) out.push({ imported, local: local ?? imported });
	}
	const fallback = clause
		.replace(/\{[^}]*\}/, '')
		.replace(/\*\s*as\s+[\w$]+/, '')
		.replace(/,/g, ' ')
		.trim();
	if (fallback) out.push({ imported: 'default', local: fallback });
	return out;
}

/** The engine module `specifier` resolves to from a server file (relative to ENGINE_DIR), or null. */
function engineModule(specifier: string): string | null {
	try {
		const resolved = Bun.resolveSync(specifier, SERVER);
		return resolved.startsWith(ENGINE_DIR + sep) ? resolved.slice(ENGINE_DIR.length + 1) : null;
	} catch {
		return null;
	}
}
const isDoor = (specifier: string) => engineModule(specifier) !== null;

/** Process-capable references in one server source, or the dynamic loads no scan resolves. */
function processRefs(code: string): { refs: number; unresolvable: string[]; spelled: boolean } {
	const transpiled = TS.transformSync(code);
	const unresolvable = TS.scanImports(transpiled)
		.filter((entry) => entry.kind !== 'import-statement')
		.filter((entry) => PROCESS_MODULES.has(entry.path) || isDoor(entry.path))
		.map((entry) => `${entry.kind} ${entry.path}`);
	for (const [, , from] of transpiled.matchAll(EXPORT_FROM_LINE)) {
		if (from !== undefined && (PROCESS_MODULES.has(from) || isDoor(from))) {
			unresolvable.push(`re-export ${from}`);
		}
	}
	const bindings: string[] = [];
	const js = transpiled.replace(IMPORT_LINE, (line, clause: string, from: string) => {
		const engine = engineModule(from);
		if (engine === null && !PROCESS_MODULES.has(from)) return line;
		for (const { imported, local } of importBindings(clause)) {
			const counted =
				engine !== null
					? !(ENGINE_INERT[engine] ?? []).includes(imported)
					: !(from === 'bun' && BUN_INERT.has(imported));
			if (counted) bindings.push(local);
		}
		return '';
	});
	const define: Record<string, string> = { Bun: BUN_GLOBAL };
	for (const name of bindings) define[name] = PROCESS_REF;
	const out = new Bun.Transpiler({ loader: 'js', define }).transformSync(js);
	let refs = out.split(PROCESS_REF).length - 1;
	for (const match of out.matchAll(
		new RegExp(`${BUN_GLOBAL}(\\s*\\.\\s*([A-Za-z_$][\\w$]*))?`, 'g'),
	)) {
		if (!(match[2] && BUN_INERT.has(match[2]))) refs++;
	}
	return { refs, unresolvable, spelled: SPELLED_SPAWN.test(transpiled) };
}

const reaches = (reach: ReturnType<typeof processRefs>) =>
	reach.refs > 0 || reach.unresolvable.length > 0 || reach.spelled;

describe('tool_uca_maps spawn census — every binary runs through runToolBinary', () => {
	const DOOR = "import { runBinary } from '../../../src/core/media/engine/spawn.ts';\n";

	test.each([
		['the door', `${DOOR}export const go = () => runBinary(['/bin/true'], {});`],
		[
			'the door aliased',
			`${DOOR.replace('runBinary', 'runBinary as run')}export const go = () => run([]);`,
		],
		[
			'the door as a namespace',
			"import * as door from '../../../src/core/media/engine/spawn.ts';\nexport const go = () => door.runBinary([]);",
		],
		[
			'the door without its extension',
			"import { runBinary } from '../../../src/core/media/engine/spawn';\nexport const go = () => runBinary([]);",
		],
		['Bun.spawn', "export const go = () => Bun.spawn(['gdalinfo']);"],
		['Bun.$', 'export const go = () => Bun.$`gdalinfo`;'],
		['an alias of Bun', "const B = Bun;\nexport const go = () => B.spawn(['gdalinfo']);"],
		[
			'a destructure of Bun',
			"const { spawnSync } = Bun;\nexport const go = () => spawnSync(['x']);",
		],
		[
			'a named import from bun',
			"import { spawn as s } from 'bun';\nexport const go = () => s(['x']);",
		],
		[
			'a namespace import of bun',
			"import * as B from 'bun';\nexport const go = () => B.spawn(['x']);",
		],
		[
			'node child_process',
			"import { execFile } from 'node:child_process';\nexport const go = () => execFile('x');",
		],
		[
			'a re-export of the door',
			"export { runBinary as go } from '../../../src/core/media/engine/spawn.ts';",
		],
		['a re-export of child_process', "export * from 'node:child_process';"],
		[
			'an engine wrapper that spawns',
			"import { runIdentify } from '../../../src/core/media/engine/binaries.ts';\nexport const go = () => runIdentify([]);",
		],
		[
			'an engine module as a namespace',
			"import * as bin from '../../../src/core/media/engine/binaries.ts';\nexport const go = () => bin.resolveMagick();",
		],
		[
			'an unlisted engine export',
			"import { producerSpawnOptions } from '../../../src/core/media/engine/ffmpeg.ts';\nexport const go = () => producerSpawnOptions();",
		],
		['Bun through globalThis', "export const go = () => globalThis.Bun.spawn(['x']);"],
		[
			'child_process through import.meta',
			"export const go = () => import.meta.require('child_process').spawn('x');",
		],
	])('the census sees %s', (_, code) => {
		expect(reaches(processRefs(code))).toBe(true);
	});

	test('a dynamic import or require of a process module is unresolvable, never counted as none', () => {
		for (const code of [
			"export const go = async () => (await import('node:child_process')).spawn('x');",
			"export const go = () => require('child_process').spawn('x');",
			"export const go = async () => (await import('../../../src/core/media/engine/spawn')).runBinary([]);",
		]) {
			expect(processRefs(code).unresolvable.length).toBeGreaterThan(0);
		}
	});

	test.each([
		['a comment', '// Bun.spawn would bypass the offline env\nexport const n = 0;'],
		['an inert Bun read', "export const f = () => Bun.file('/x');"],
		['an inert import from bun', "import { Glob } from 'bun';\nexport const g = new Glob('*');"],
		[
			'a type-only door import',
			"import type { SpawnResult } from '../../../src/core/media/engine/spawn.ts';\nexport let r: SpawnResult;",
		],
		[
			'another door export',
			"import { assertSpawnOk } from '../../../src/core/media/engine/spawn.ts';\nexport const f = assertSpawnOk;",
		],
		[
			'the inert engine exports',
			"import { identifyAvailable, resolveMagick } from '../../../src/core/media/engine/binaries.ts';\nimport { withConverterSlot } from '../../../src/core/media/engine/admission.ts';\nexport const f = () => withConverterSlot('x', async () => identifyAvailable() && resolveMagick());",
		],
	])('the census ignores %s', (_, code) => {
		expect(reaches(processRefs(code))).toBe(false);
	});

	test('every inert engine name is still a function its module exports', async () => {
		for (const [file, names] of Object.entries(ENGINE_INERT)) {
			const module = (await import(join(ENGINE_DIR, file))) as Record<string, unknown>;
			for (const name of names) {
				expect([file, name, typeof module[name]]).toEqual([file, name, 'function']);
			}
		}
	});

	test('only gdal.ts spawns, once, inside runToolBinary; the exemptions still spawn', () => {
		const files = [...new Glob('**/*.ts').scanSync({ cwd: SERVER })];
		expect(files.length).toBeGreaterThanOrEqual(15);
		const census = Object.fromEntries(
			files
				.map((file) => [file, processRefs(readFileSync(join(SERVER, file), 'utf-8'))] as const)
				.filter(([, reach]) => reaches(reach)),
		);
		const expected = Object.fromEntries(
			['gdal.ts', ...Object.keys(SPAWN_EXEMPT)].map((file) => [
				file,
				{ refs: 1, unresolvable: [], spelled: true },
			]),
		);
		expect(census).toEqual(expected);
		// and gdal.ts's one reference is runToolBinary's own call
		const gdal = readFileSync(join(SERVER, 'gdal.ts'), 'utf-8');
		const from = gdal.slice(gdal.indexOf('export async function runToolBinary('));
		expect(from.slice(0, from.indexOf('\n}\n'))).toContain('await runBinary(argv,');
	});
});
