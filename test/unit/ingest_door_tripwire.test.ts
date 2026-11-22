/**
 * INGEST DOOR TRIPWIRE — `processUploadedFile` is reached only through THE ingest
 * door, `src/core/media/ingest/ingest_and_persist.ts`.
 *
 * THE INVARIANT: no production file but the door (and the module that defines
 * the function) imports `processUploadedFile` — statically, dynamically, or
 * through a namespace import.
 *
 * WHY (A1-01): an av ingest CLAIMS its component's build slot and holds it until
 * the transcode adopts it. A caller that persists, throws, and never reaches the
 * transcode must release the claim, or the component refuses every upload and
 * build until the process restarts. Six callers wrote the three steps out by
 * hand and one (tool_import_files) forgot the release. The door holds the
 * release in a `finally`, once; this gate holds that nobody walks around it.
 *
 * Scope: src/, tools/, scripts/, publication/. Tests are OUT of scope by design:
 * they exercise the core function itself and settle the claim explicitly
 * (`releaseBuildClaim`), which is the contract the door exists to hide.
 *
 * Honest limit: a source scan. It sees the import and the binding name, not a
 * function value smuggled through another module's re-export under a new name —
 * a re-export of the binding from a production file is itself an offender here.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const SCAN_ROOTS = ['src', 'tools', 'scripts', 'publication'];
const DOOR = 'src/core/media/ingest/ingest_and_persist.ts';
const DEFINER = 'src/core/media/ingest/process_uploaded_file.ts';
/** Files that may name `processUploadedFile` from the defining module, each with its reason. */
const PERMITTED: ReadonlyMap<string, string> = new Map([
	[DOOR, 'THE ingest door: ingest, persist, start, and the build-claim release in one finally.'],
	[DEFINER, 'Defines the function.'],
]);

/** Every .ts file under the scan roots. */
function collectSourceFiles(dir: string, out: string[] = []): string[] {
	if (!existsSync(dir)) return out;
	for (const name of readdirSync(dir)) {
		if (name === 'node_modules' || name.startsWith('.') || name === 'dist') continue;
		const full = join(dir, name);
		if (statSync(full).isDirectory()) collectSourceFiles(full, out);
		else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(full);
	}
	return out;
}

/** Block and line comments out: a comment naming the function is not a use. */
function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

/**
 * Does this source take `processUploadedFile` from the defining module? It must
 * name the module (static `from`, dynamic `import(…)`) AND the binding.
 */
function usesIngestCore(source: string): boolean {
	const code = stripComments(source);
	const namesModule = /['"`][^'"`]*\bprocess_uploaded_file(\.ts)?['"`]/.test(code);
	return namesModule && /\bprocessUploadedFile\b/.test(code);
}

describe('ingest door tripwire', () => {
	const files = SCAN_ROOTS.flatMap((root) => collectSourceFiles(join(REPO_ROOT, root)));
	const users = files
		.filter((file) => usesIngestCore(readFileSync(file, 'utf8')))
		.map((file) => relative(REPO_ROOT, file));

	test('processUploadedFile is imported by THE ingest door only', () => {
		// Anti-vacuity: the scan read the tree and SAW the door use it.
		expect(files.length).toBeGreaterThan(500);
		expect(users).toContain(DOOR);
		const offenders = users.filter((file) => !PERMITTED.has(file));
		expect(
			offenders,
			`Import ingestAndPersist / ingestAndPersistDeferred (${DOOR}) instead of processUploadedFile — the door releases the av build claim (A1-01).`,
		).toEqual([]);
	});

	test('every permitted entry exists and carries a reason (no stale exemption)', () => {
		for (const [file, reason] of PERMITTED) {
			expect(existsSync(join(REPO_ROOT, file))).toBe(true);
			expect(reason.length).toBeGreaterThan(10);
		}
	});

	test('POSITIVE CONTROL: static, dynamic and namespace imports are seen; comments and look-alikes are not', () => {
		expect(
			usesIngestCore(
				"import { processUploadedFile } from '../../src/core/media/ingest/process_uploaded_file.ts';",
			),
		).toBe(true);
		expect(
			usesIngestCore(
				"const { processUploadedFile } = await import('../../src/core/media/ingest/process_uploaded_file.ts');",
			),
		).toBe(true);
		expect(
			usesIngestCore(
				"import * as ingest from '../media/ingest/process_uploaded_file.ts';\nawait ingest.processUploadedFile(x);",
			),
		).toBe(true);
		// A comment is not a use; a same-named local function without the module is not either.
		expect(
			usesIngestCore(
				"import { isMasterTier } from './ingest/process_uploaded_file.ts';\n// processUploadedFile runs later",
			),
		).toBe(false);
		expect(usesIngestCore('async function processUploadedFile(ctx) { return ctx; }')).toBe(false);
	});
});
