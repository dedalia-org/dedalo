/**
 * TS-native gate for U-21 — the master's ontology EXPORT publishes every served
 * file ATOMICALLY (src/core/ontology/data_io.ts: `runCopyExport` behind
 * `exportToFile` / `exportPrivateListsToFile`, and `writeTextFileAtomic` behind
 * `exportOntologyInfo` / `exportLlmMap`).
 *
 * The defect: `\copy … TO PROGRAM 'gzip -c > <served path>'` wrote straight onto
 * the served file and only checked that it EXISTED, so a psql failure left a
 * valid-looking truncated gzip in place and reported OK — a consumer then
 * imported that slice (scoped DELETE + partial COPY) and lost the rest of its TLD.
 *
 * Contract asserted here: on failure (psql non-zero, no output, a truncated
 * gzip) the export THROWS, the PREVIOUS served file is byte-identical and no
 * temp sibling is left; on success the served file is replaced. The psql runner
 * is the injected seam (`CopyExportDeps.runCopy`); one case runs the REAL psql
 * door on the suite database (read-only COPY of a scratch section with no rows)
 * to prove the shipped command shape publishes through the temp sibling.
 *
 * Every file lives under a per-test temp base (`deps.ioBaseDir`) — the real IO
 * dir is never touched. Mutations: write onto the served path again → cases 1-3
 * red; ignore the exit code → case 1 red; drop the gzip verification → case 2 red.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { writeTextFileDurablyAsync as writeTextFileAtomic } from '../../src/core/files/durable_async.ts';
import {
	type CopyExportRunner,
	exportPrivateListsToFile,
	exportToFile,
	setOntologyIoPath,
} from '../../src/core/ontology/data_io.ts';

const TLD = 'zzexportatomic';
const PREVIOUS = gzipSync(Buffer.from('previous\tserved\tslice\n'));

const tempRoots: string[] = [];

/** A fresh base + its versioned IO dir, with a previous served `<name>` in place. */
function situation(name: string): { ioBaseDir: string; ioPath: string; served: string } {
	const root = mkdtempSync(join(tmpdir(), 'zz_export_atomic_'));
	tempRoots.push(root);
	// confinedCopyPath refuses whitespace/quotes — such a temp root would read as a refusal.
	expect(/[\s'"\\]/.test(root)).toBe(false);
	const ioBaseDir = join(root, 'io');
	mkdirSync(ioBaseDir);
	const ioPath = setOntologyIoPath(ioBaseDir);
	if (typeof ioPath !== 'string') throw new Error(ioPath.error);
	const served = join(ioPath, name);
	writeFileSync(served, PREVIOUS);
	return { ioBaseDir, ioPath, served };
}

/** The temp path the export asked gzip to write (`gzip -c > <path>'`). */
function gzipTarget(script: string): string {
	const match = /gzip -c > ([^']+)'/.exec(script);
	expect(match).not.toBeNull();
	return (match as RegExpExecArray)[1] as string;
}

/** A runner that writes `bytes` (or nothing) to the gzip target and answers `exitCode`. */
function fakeRunner(bytes: Uint8Array | null, exitCode: number, stderr = ''): CopyExportRunner {
	return async (script) => {
		const target = gzipTarget(script);
		if (bytes !== null) await Bun.write(target, bytes);
		return { exitCode, stderr };
	};
}

/** A gzip stream cut short — what a psql killed mid-COPY leaves behind. */
function truncatedGzip(): Uint8Array {
	const full = gzipSync(Buffer.from('row\n'.repeat(50_000)));
	return full.subarray(0, Math.floor(full.length / 2));
}

/** Temp siblings left in the IO dir — floored: the listing must hold the served file(s). */
function leftovers(ioPath: string): string[] {
	const names = readdirSync(ioPath);
	expect(names.length).toBeGreaterThan(0);
	return names.filter((name) => name.includes('.tmp-'));
}

async function rejectionOf(work: () => Promise<unknown>): Promise<Error> {
	let caught: unknown = null;
	try {
		await work();
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(Error);
	return caught as Error;
}

afterAll(() => {
	for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

describe('U-21 atomic ontology export', () => {
	test('psql failing mid-export: throws, previous served file untouched, no temp left', async () => {
		const { ioBaseDir, ioPath, served } = situation(`${TLD}.copy.gz`);
		const error = await rejectionOf(() =>
			exportToFile(TLD, { ioBaseDir, runCopy: fakeRunner(truncatedGzip(), 1, 'boom') }),
		);
		expect(error.message).toContain('psql exited 1: boom');
		expect(error.message).toContain('the previous file is kept');
		expect(Buffer.from(readFileSync(served)).equals(PREVIOUS)).toBe(true);
		expect(leftovers(ioPath)).toEqual([]);
	});

	test('exit 0 but a truncated gzip: throws, previous served file untouched', async () => {
		const { ioBaseDir, ioPath, served } = situation(`${TLD}.copy.gz`);
		const error = await rejectionOf(() =>
			exportToFile(TLD, { ioBaseDir, runCopy: fakeRunner(truncatedGzip(), 0) }),
		);
		expect(error.message).toContain('not a complete gzip stream');
		expect(Buffer.from(readFileSync(served)).equals(PREVIOUS)).toBe(true);
		expect(leftovers(ioPath)).toEqual([]);
	});

	test('exit 0 but no output file: throws, previous served file untouched', async () => {
		const { ioBaseDir, ioPath, served } = situation('matrix_dd.copy.gz');
		const error = await rejectionOf(() =>
			exportPrivateListsToFile({ ioBaseDir, runCopy: fakeRunner(null, 0) }),
		);
		expect(error.message).toContain('the output file was not created');
		expect(Buffer.from(readFileSync(served)).equals(PREVIOUS)).toBe(true);
		expect(leftovers(ioPath)).toEqual([]);
	});

	test('a complete export replaces the served file', async () => {
		const { ioBaseDir, ioPath, served } = situation(`${TLD}.copy.gz`);
		const fresh = gzipSync(Buffer.from('fresh\trows\n'));
		const out = await exportToFile(TLD, { ioBaseDir, runCopy: fakeRunner(fresh, 0) });
		expect(out.ok).toBe(true);
		expect(gunzipSync(readFileSync(served)).toString()).toBe('fresh\trows\n');
		expect(leftovers(ioPath)).toEqual([]);
	});

	test('the REAL psql door publishes through the temp sibling (scratch section, no rows)', async () => {
		const { ioBaseDir, ioPath, served } = situation(`${TLD}.copy.gz`);
		let script = '';
		const out = await exportToFile(TLD, { ioBaseDir });
		expect(out.ok).toBe(true);
		// No rows for the scratch section: a complete, EMPTY gzip replaced the previous slice.
		expect(gunzipSync(readFileSync(served)).length).toBe(0);
		expect(leftovers(ioPath)).toEqual([]);
		// And the command it ran wrote the temp sibling, never the served path.
		await exportToFile(TLD, {
			ioBaseDir,
			runCopy: async (s) => {
				script = s;
				return { exitCode: 1, stderr: 'recorded' };
			},
		}).catch(() => undefined);
		expect(gzipTarget(script)).toMatch(new RegExp(`/${TLD}\\.copy\\.gz\\.tmp-[a-z0-9]+$`));
	});

	test('writeTextFileAtomic replaces the target; a failed publish leaves it and no temp', async () => {
		const { ioPath } = situation('unused.copy.gz');
		const target = join(ioPath, 'ontology.json');
		writeFileSync(target, '{"previous":true}');
		const bytes = await writeTextFileAtomic(target, '{"fresh":true}');
		expect(bytes).toBe(14);
		expect(readFileSync(target, 'utf8')).toBe('{"fresh":true}');

		// A target that is a non-empty DIRECTORY: the rename fails.
		const blocked = join(ioPath, 'ontology_llm_map.json');
		mkdirSync(join(blocked, 'keep'), { recursive: true });
		await rejectionOf(() => writeTextFileAtomic(blocked, '[]'));
		expect(existsSync(join(blocked, 'keep'))).toBe(true);
		expect(leftovers(ioPath)).toEqual([]);
	});
});
