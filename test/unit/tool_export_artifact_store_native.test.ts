/**
 * TOOL_EXPORT ARTIFACT STORE + SPOOL — behavioural gate for the foundation of
 * server-built exports (tools/tool_export/server/{artifact_store,spool_reader}.ts,
 * writers/{index,types,ndjson}.ts) and the `export` job lane.
 *
 * Every case BUILDS its situation in a scratch export root this file declares
 * (the `.dedalo_test_export_artifacts` marker) and sweeps it afterwards; no
 * database, no install TLD, no ambient files. What is asserted is OUTCOMES:
 * bytes on disk, what a reader sees, what a refusal leaves behind.
 *
 *  A. the test-seam refusal: an undeclared root is refused, nothing is written;
 *  B. confinement: malformed ids / traversal / spool names / symlinks resolve
 *     to nothing, a built file of the owner resolves;
 *  C. the spool: grid bytes == the protocol stream, cols, grid.idx offsets,
 *     pages in records (sub-rows never split), live vs final column order,
 *     mid-run visibility only at record boundaries;
 *  D. quota: creation and writing both stop at the budget with the typed error;
 *  E. the TTL sweep: expired / recent / orphaned-running / live-running / temps;
 *  F. the writer path: registry totality, ndjson == spool, not-ready,
 *     cancel + quota leave no file;
 *  G. the export lane + config defaults;
 *  H. the manifest lock: one holder after a stale takeover, a release
 *     removes only its own lock instance.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../../src/config/config.ts';
import { DedaloError, isDedaloError } from '../../src/core/errors/index.ts';
import { tempPathFor } from '../../src/core/files/temp_path.ts';
import { JOB_LANES, MediaJobManager } from '../../src/core/media/jobs.ts';
import { getRoots as getToolRoots } from '../../src/core/tools/paths.ts';
import {
	type ArtifactJobRef,
	type ArtifactStore,
	artifactFileName,
	assertExportArtifactsRoot,
	confinedPath,
	DEAD_WRITER_SILENCE_MS,
	DEFAULT_INDEX_EVERY,
	defaultExportArtifactsRoot,
	EXPORT_ARTIFACTS_OWNER_MARKER,
	EXPORT_ARTIFACTS_TEST_MARKER,
	EXPORT_FORMATS,
	effectiveJobStatus,
	exportArtifactsGuardArmed,
	exportArtifactsPlacementConflict,
	exportExpired,
	exportStoreInstallFingerprint,
	filesPastFormatBound,
	INDEX_LINE_BYTES,
	isDownloadableArtifactName,
	MANIFEST_LOCK_STALE_MS,
	MANIFEST_OPTIONS_MAX_BYTES,
	MAX_FILES_PER_FORMAT,
	manifestLockWaitMs,
	openArtifactStore,
	quotaRecheckStep,
	SPOOL_FILES,
	STORE_BOOT_ID,
	startExportArtifactSweeper,
	webServedTrees,
	withManifestLock,
	writeFully,
} from '../../tools/tool_export/server/artifact_store.ts';
import { effectiveStatus } from '../../tools/tool_export/server/export_job.ts';
import {
	clampPageSize,
	liveInsertOrder,
	openSpoolReader,
	PREVIEW_ROW_BUDGET,
	type SpoolColLine,
} from '../../tools/tool_export/server/spool_reader.ts';
import {
	artifactFileVariant,
	buildArtifactFile,
	EXPORT_WRITERS,
} from '../../tools/tool_export/server/writers/index.ts';
import { ndjsonWriter } from '../../tools/tool_export/server/writers/ndjson.ts';
import {
	assertFormatLimit,
	type ExportWriter,
	type ExportWriterOptions,
} from '../../tools/tool_export/server/writers/types.ts';
import { markExportArtifactsRoot } from '../helpers/media_scratch_root.ts';
import {
	rebuildTestExportArtifactsRoot,
	testExportArtifactsRootPath,
} from '../helpers/test_media_root.ts';

const scratchDirs: string[] = [];
/**
 * The derived suite root (gate A creates + marks it on demand): swept after when
 * THIS file created it and it still holds nothing but the marker (a concurrent
 * gate's jobs there are never pulled from under it).
 */
const derivedRootExistedBefore = existsSync(defaultExportArtifactsRoot());
afterAll(() => {
	for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
	const derived = defaultExportArtifactsRoot();
	if (derivedRootExistedBefore || !existsSync(derived)) return;
	const held = readdirSync(derived);
	const markers = [EXPORT_ARTIFACTS_TEST_MARKER, EXPORT_ARTIFACTS_OWNER_MARKER];
	if (held.includes(EXPORT_ARTIFACTS_TEST_MARKER) && held.every((name) => markers.includes(name))) {
		rmSync(derived, { recursive: true, force: true });
	}
});

/** A fresh scratch directory (NOT marked). */
function scratch(prefix = 'dedalo_export_store_'): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	scratchDirs.push(dir);
	return dir;
}

/** A fresh, DECLARED export root + store. */
function markedStore(options: { quotaBytes?: number; ttlHours?: number } = {}): ArtifactStore {
	const root = markExportArtifactsRoot(join(scratch(), 'artifacts'));
	return openArtifactStore({
		root,
		quotaBytes: options.quotaBytes ?? 0,
		ttlHours: options.ttlHours ?? 24,
	});
}

async function expectCode(
	promise: Promise<unknown> | (() => unknown),
	code: string,
): Promise<void> {
	let caught: unknown = null;
	try {
		if (typeof promise === 'function') await promise();
		else await promise;
	} catch (error) {
		caught = error;
	}
	expect(isDedaloError(caught), `expected DedaloError ${code}, got ${String(caught)}`).toBe(true);
	expect((caught as { code: string }).code).toBe(code);
}

const INIT = {
	userId: 7,
	sectionTipo: 'test3',
	sections: ['test3'],
	options: { data_format: 'standard', breakdown: 'rows' },
	recordScope: 'store-gate-scope',
	applicationLang: 'lg-eng',
};

/** A protocol stream with breakdown sub-rows and a column that appears mid-stream. */
function protocol(records: number, options: { subRowsOf?: (rec: number) => number } = {}) {
	const lines: Record<string, unknown>[] = [
		{
			t: 'meta',
			v: 1,
			data_format: 'standard',
			breakdown: 'rows',
			fill_the_gaps: true,
			section_tipo: 'test3',
			total: records,
		},
		{ t: 'col', i: 0, key: 'id', label: 'Id', cell_type: 'section_id', after: null },
		{ t: 'col', i: 1, key: 'test52', label: 'Title', cell_type: 'text', after: 0 },
	];
	let rows = 0;
	for (let rec = 1; rec <= records; rec++) {
		if (rec === 3)
			lines.push({ t: 'col', i: 2, key: 'test71', label: 'Parent', cell_type: 'text', after: 0 });
		const subs = options.subRowsOf?.(rec) ?? 1;
		for (let sub = 0; sub < subs; sub++) {
			const c: Record<string, string> = { '0': String(rec), '1': `título ${rec}.${sub} "q" <b>` };
			if (rec >= 3) c['2'] = `p${rec}`;
			lines.push({ t: 'row', rec, sub, c });
			rows++;
		}
	}
	lines.push({ t: 'end', columns: [0, 2, 1], rows, records });
	return lines;
}

async function spoolOf(
	store: ArtifactStore,
	job: ArtifactJobRef,
	lines: Record<string, unknown>[],
	indexEvery = 3,
) {
	const writer = await store.openSpoolWriter(job, { indexEvery });
	for (const line of lines) await writer.write(line);
	return writer;
}

const serialize = (lines: Record<string, unknown>[]): string =>
	lines.map((line) => `${JSON.stringify(line)}\n`).join('');

// ---------------------------------------------------------------------------

describe('A. the test-seam refusal', () => {
	test('the seam is armed in this process (the refusals below are live, not inert)', () => {
		expect(exportArtifactsGuardArmed()).toBe(true);
		expect(config.media.testRoot).not.toBeNull();
		// the default root under the seam is the test media root's sibling, never the install's key
		expect(defaultExportArtifactsRoot()).toBe(`${config.media.testRoot}.export_artifacts`);
		expect(defaultExportArtifactsRoot()).not.toBe(config.ops.exportArtifactsDir);
	});

	test('an UNDECLARED root is refused before anything is written', async () => {
		const root = join(scratch(), 'undeclared');
		mkdirSync(root);
		const store = openArtifactStore({ root, quotaBytes: 0 });
		await expectCode(store.createJob(INIT), 'export.store_unavailable');
		expect(readdirSync(root)).toEqual([]);
		// and the refusal names the door
		try {
			await store.createJob(INIT);
		} catch (error) {
			expect(String((error as Error).message)).toContain('ArtifactStore.createJob');
			expect(String((error as Error).message)).toContain('NOTHING WAS WRITTEN');
		}
	});

	test('the DESTRUCTIVE doors (deleteJob, deleteIdleJob, deleteSpool) refuse an undeclared root too — nothing is deleted', async () => {
		const root = join(scratch(), 'undeclared_rm');
		const jobDir = join(root, '7', 'exp_victim');
		mkdirSync(jobDir, { recursive: true });
		writeFileSync(join(jobDir, SPOOL_FILES.grid), 'keep');
		writeFileSync(join(jobDir, SPOOL_FILES.manifest), '{}');
		const store = openArtifactStore({ root, quotaBytes: 0 });
		const job = store.jobRef(7, 'exp_victim');
		await expectCode(store.deleteSpool(job), 'export.store_unavailable');
		await expectCode(store.deleteJob(job), 'export.store_unavailable');
		await expectCode(store.deleteIdleJob(job), 'export.store_unavailable');
		expect(readFileSync(join(jobDir, SPOOL_FILES.grid), 'utf8')).toBe('keep');
		expect(existsSync(join(jobDir, SPOOL_FILES.manifest))).toBe(true);
	});

	test('the DERIVED suite root is declared by its (marked) test media root — and only it', async () => {
		const derived = defaultExportArtifactsRoot();
		// test:db:setup sweeps THIS path (test/helpers/test_media_root.ts): one derivation.
		expect(derived).toBe(testExportArtifactsRootPath(config.media.testRoot as string));
		expect(await assertExportArtifactsRoot(derived, 'probe')).toBe(derived);
		expect(existsSync(join(derived, EXPORT_ARTIFACTS_TEST_MARKER))).toBe(true);
		// provenance is not a prefix rule: a look-alike path next to it is still refused
		const lookAlike = `${derived}_other`;
		scratchDirs.push(lookAlike); // swept even if a broken guard created it
		await expect(assertExportArtifactsRoot(lookAlike, 'probe')).rejects.toThrow(
			/NOTHING WAS WRITTEN/,
		);
		expect(existsSync(lookAlike)).toBe(false);
	});

	test('a DECLARED root is accepted', async () => {
		const store = markedStore();
		const { job, manifest } = await store.createJob(INIT);
		expect(existsSync(join(store.root, EXPORT_ARTIFACTS_TEST_MARKER))).toBe(true);
		expect(manifest.status).toBe('running');
		expect(manifest.owner_boot).toBe(STORE_BOOT_ID);
		expect(await store.readManifest(job)).toEqual(manifest);
	});
});

describe('A1. the placement rule: never inside, equal to or above a web-served tree', () => {
	test('the conflict is found lexically and through a symlink; siblings and elsewhere are fine', async () => {
		const base = scratch();
		const served = join(base, 'media');
		mkdirSync(served);
		expect(await exportArtifactsPlacementConflict(join(served, 'exports'), [served])).toBe(served);
		expect(await exportArtifactsPlacementConflict(served, [served])).toBe(served);
		expect(await exportArtifactsPlacementConflict(base, [served])).toBe(served);
		expect(
			await exportArtifactsPlacementConflict(join(base, 'media_exports'), [served]),
		).toBeNull();
		expect(
			await exportArtifactsPlacementConflict(join(base, 'private', 'exports'), [served]),
		).toBeNull();
		// a symlinked export dir that lands in the served tree
		const link = join(base, 'big_volume');
		symlinkSync(served, link);
		expect(await exportArtifactsPlacementConflict(join(link, 'exports'), [served])).toBe(served);
		// the live list names the media root, the client tree and the tool roots
		const trees = webServedTrees();
		expect(trees).toContain(config.media.rootPath as string);
		expect(trees.some((tree) => tree.endsWith(join('client', 'dedalo')))).toBe(true);
		for (const root of getToolRoots()) expect(trees).toContain(root.path);
	});

	test('a store rooted in the media root, the client tree or a tool root refuses every door before writing; a private root is accepted', async () => {
		const clientTree = webServedTrees().find((tree) =>
			tree.endsWith(join('client', 'dedalo')),
		) as string;
		// a tool root is served by the engine with no session (.json/.html included)
		const toolRoot = (getToolRoots()[0] as { path: string }).path;
		for (const root of [
			join(config.media.rootPath as string, 'zz_export_placement_probe'),
			join(clientTree, 'zz_export_placement_probe'),
			join(toolRoot, 'tool_export', 'zz_export_placement_probe'),
		]) {
			scratchDirs.push(root); // swept even if a broken rule created it
			const store = openArtifactStore({ root, quotaBytes: 0 });
			for (const attempt of [() => store.createJob(INIT), () => store.sweep()]) {
				let caught: unknown = null;
				try {
					await attempt();
				} catch (error) {
					caught = error;
				}
				expect((caught as { code?: string } | null)?.code).toBe('export.store_unavailable');
				expect(String((caught as Error).message)).toContain('web-served tree');
				expect(String((caught as Error).message)).toContain('NOTHING WAS WRITTEN');
			}
			expect(existsSync(root)).toBe(false);
		}
		// control: a (marked) private root takes a job
		const accepted = markedStore();
		expect((await accepted.createJob(INIT)).manifest.status).toBe('running');
	});
});

describe('A2. test:db:setup sweeps and re-marks the suite export root', () => {
	test('a marked root is swept clean and re-declared; an UNMARKED one is refused untouched', async () => {
		const mediaRoot = join(scratch(), 'suite_media');
		const exportRoot = testExportArtifactsRootPath(mediaRoot);
		scratchDirs.push(exportRoot);
		// fresh: created and marked
		expect(await rebuildTestExportArtifactsRoot(mediaRoot)).toBe(exportRoot);
		expect(existsSync(join(exportRoot, EXPORT_ARTIFACTS_TEST_MARKER))).toBe(true);
		// a leftover job of an earlier run is swept, the marker survives
		mkdirSync(join(exportRoot, '-1', 'exp_leftover'), { recursive: true });
		writeFileSync(join(exportRoot, '-1', 'exp_leftover', SPOOL_FILES.grid), 'old');
		await rebuildTestExportArtifactsRoot(mediaRoot);
		expect(existsSync(join(exportRoot, '-1'))).toBe(false);
		expect(existsSync(join(exportRoot, EXPORT_ARTIFACTS_TEST_MARKER))).toBe(true);
		// not the suite's: refused, nothing deleted
		rmSync(join(exportRoot, EXPORT_ARTIFACTS_TEST_MARKER));
		writeFileSync(join(exportRoot, 'keep.txt'), 'keep');
		await expect(rebuildTestExportArtifactsRoot(mediaRoot)).rejects.toThrow(/NOTHING WAS DELETED/);
		expect(readFileSync(join(exportRoot, 'keep.txt'), 'utf8')).toBe('keep');
	});
});

describe('B. confinement', () => {
	test('malformed ids and traversal never resolve', async () => {
		const store = markedStore();
		for (const bad of ['..', '.', '../x', 'a/b', '', 'x'.repeat(200), 'a\0b', '-lead']) {
			await expectCode(() => store.jobRef(7, bad), 'export.artifact_not_found');
			expect(await store.resolveArtifactFile(7, bad, 'export.csv')).toBeNull();
		}
		await expectCode(() => store.jobRef(Number.NaN, 'exp_1'), 'export.artifact_not_found');
		await expectCode(() => store.jobRef(1.5, 'exp_1'), 'export.artifact_not_found');
	});

	test('only BUILT files are downloadable; spool, manifest, symlinks and other owners are not', async () => {
		const store = markedStore();
		const { job } = await store.createJob(INIT);
		writeFileSync(join(job.dir, 'export.csv'), 'a;b\n');
		writeFileSync(join(job.dir, SPOOL_FILES.grid), '{}\n');
		symlinkSync(join(job.dir, SPOOL_FILES.manifest), join(job.dir, 'export.tsv'));
		expect(await store.resolveArtifactFile(7, job.jobId, 'export.csv')).toBe(
			join(job.dir, 'export.csv'),
		);
		for (const name of [
			SPOOL_FILES.grid,
			SPOOL_FILES.cols,
			SPOOL_FILES.index,
			SPOOL_FILES.manifest,
			'../export.csv',
			'export.csv/..',
			'export.exe',
			'export.tsv',
		]) {
			expect(await store.resolveArtifactFile(7, job.jobId, name)).toBeNull();
		}
		// another user asking for the same job id gets nothing
		expect(await store.resolveArtifactFile(8, job.jobId, 'export.csv')).toBeNull();
		// a missing built file is nothing too
		expect(await store.resolveArtifactFile(7, job.jobId, 'export.html')).toBeNull();
		expect(isDownloadableArtifactName('media_original.zip')).toBe(true);
		expect(isDownloadableArtifactName('media_../x.zip')).toBe(false);
	});

	test('confinedPath: the one containment check the route reuses', () => {
		const dir = '/srv/exports/7/exp_1';
		expect(confinedPath(dir, 'export.csv')).toBe('/srv/exports/7/exp_1/export.csv');
		for (const escapeName of [
			'../x',
			'../../7/exp_2/export.csv',
			'/etc/passwd',
			'..',
			'.',
			'',
			'a\0b',
			'sub/../../x',
		]) {
			expect(confinedPath(dir, escapeName)).toBeNull();
		}
		// a sibling that shares the prefix is NOT inside
		expect(confinedPath(dir, '../exp_1x/export.csv')).toBeNull();
		expect(artifactFileName('media_zip', 'original')).toBe('media_original.zip');
		expect(artifactFileName('xlsx')).toBe('export.xlsx');
		expect(artifactFileName('csv', 'ab12')).toBe('export_ab12.csv');
		expect(() => artifactFileName('csv', 'A/B')).toThrow();
		expect(isDownloadableArtifactName('export_ab12.csv')).toBe(true);
		expect(isDownloadableArtifactName('export_../x.csv')).toBe(false);
		expect(() => artifactFileName('media_zip', '../x')).toThrow();
	});

	test('a manifest whose owner disagrees with its directory is not found', async () => {
		const store = markedStore();
		const { job, manifest } = await store.createJob(INIT);
		writeFileSync(
			join(job.dir, SPOOL_FILES.manifest),
			JSON.stringify({ ...manifest, user_id: 99 }),
		);
		await expectCode(store.readManifest(job), 'export.artifact_not_found');
	});

	test('a duplicate job id is refused (never two exports in one directory)', async () => {
		const store = markedStore();
		await store.createJob({ ...INIT, jobId: 'fixed_1' });
		await expectCode(store.createJob({ ...INIT, jobId: 'fixed_1' }), 'resource.conflict');
	});
});

describe('C. the spool', () => {
	test('grid.ndjson is the protocol stream byte for byte; cols.ndjson holds the col lines only', async () => {
		const store = markedStore();
		const { job } = await store.createJob(INIT);
		const lines = protocol(8, { subRowsOf: (rec) => (rec % 2 === 0 ? 3 : 1) });
		const writer = await spoolOf(store, job, lines);
		const stats = await writer.close();
		expect(readFileSync(join(job.dir, SPOOL_FILES.grid), 'utf8')).toBe(serialize(lines));
		expect(readFileSync(join(job.dir, SPOOL_FILES.cols), 'utf8')).toBe(
			serialize(lines.filter((l) => l.t === 'col')),
		);
		expect(stats.records).toBe(8);
		expect(stats.rows).toBe(lines.filter((l) => l.t === 'row').length);
		expect(stats.ended).toBe(true);
		expect(stats.columns).toEqual([0, 2, 1]);
	});

	test('grid.idx entry k points at the first row of record k*R', async () => {
		const store = markedStore();
		const { job } = await store.createJob(INIT);
		const lines = protocol(10, { subRowsOf: (rec) => (rec % 3 === 0 ? 2 : 1) });
		await (await spoolOf(store, job, lines, 3)).close();
		const grid = readFileSync(join(job.dir, SPOOL_FILES.grid));
		const idx = readFileSync(join(job.dir, SPOOL_FILES.index), 'utf8');
		expect(idx.length % INDEX_LINE_BYTES).toBe(0);
		const offsets = idx.trimEnd().split('\n').map(Number);
		expect(offsets.length).toBe(Math.ceil(10 / 3));
		offsets.forEach((offset, k) => {
			const line = JSON.parse(grid.subarray(offset, grid.indexOf(0x0a, offset)).toString('utf8'));
			expect(line).toMatchObject({ t: 'row', rec: k * 3 + 1, sub: 0 });
		});
	});

	test('pages are in records, sub-rows never split, every page matches a linear read', async () => {
		const store = markedStore();
		const { job } = await store.createJob(INIT);
		const lines = protocol(23, { subRowsOf: (rec) => (rec % 4) + 1 });
		await (await spoolOf(store, job, lines, 3)).close();
		const reader = openSpoolReader(job.dir, { indexEvery: 3 });
		const allRows = lines.filter((l) => l.t === 'row');
		for (const size of [1, 2, 5, 7, 23, 50]) {
			const seen: unknown[] = [];
			for (let page = 0; page * size < 23; page++) {
				const got = await reader.readPage({ page, pageSize: size });
				expect(got.first_record).toBe(page * size);
				expect(got.records).toBe(Math.min(size, 23 - page * size));
				expect(got.has_more).toBe((page + 1) * size < 23);
				// a page starts at a record's first row and ends after its last sub-row
				expect(got.rows[0]?.sub).toBe(0);
				const recs = new Set(got.rows.map((row) => row.rec));
				expect(recs.size).toBe(got.records);
				seen.push(...got.rows);
			}
			expect(seen).toEqual(allRows);
		}
		const beyond = await reader.readPage({ page: 99, pageSize: 5 });
		expect(beyond.rows).toEqual([]);
		expect(beyond.records).toBe(0);
	});

	test('a page has a ROW budget: every record keeps its first row, sub-rows past the budget are elided and counted', async () => {
		const store = markedStore();
		const { job } = await store.createJob(INIT);
		// 6 records: 1, 2, 3, 4, 1 and 2000 rows (the last one a pathological breakdown).
		const subRows = [1, 2, 3, 4, 1, 2000];
		const lines = protocol(6, { subRowsOf: (rec) => subRows[rec - 1] as number });
		await (await spoolOf(store, job, lines, 3)).close();
		const reader = openSpoolReader(job.dir, { indexEvery: 3 });

		// The DEFAULT budget holds a page of 2000+ rows to PREVIEW_ROW_BUDGET.
		const full = await reader.readPage({ page: 0, pageSize: 6 });
		expect(full.records).toBe(6);
		expect(full.rows.length).toBe(PREVIEW_ROW_BUDGET);
		expect(full.elided).toEqual([
			{ rec: 6, rows: 2011 - PREVIEW_ROW_BUDGET, after: PREVIEW_ROW_BUDGET - 1 },
		]);

		// A budget of 8: six first rows + 2 sub-rows, in record order (record 2's
		// one, then one of record 3's two); the rest counted per record.
		const tight = await reader.readPage({ page: 0, pageSize: 6, rowBudget: 8 });
		expect(tight.records).toBe(6);
		expect(tight.rows.length).toBe(8);
		expect(tight.rows.map((row) => `${row.rec}.${row.sub}`)).toEqual([
			'1.0',
			'2.0',
			'2.1',
			'3.0',
			'3.1',
			'4.0',
			'5.0',
			'6.0',
		]);
		expect(tight.elided).toEqual([
			{ rec: 3, rows: 1, after: 4 },
			{ rec: 4, rows: 3, after: 5 },
			{ rec: 6, rows: 1999, after: 7 },
		]);
		// Served + elided = the whole page, never a record lost or split.
		const servedPlusElided =
			tight.rows.length + tight.elided.reduce((sum, item) => sum + item.rows, 0);
		expect(servedPlusElided).toBe(subRows.reduce((a, b) => a + b, 0));
		// A budget the page fits in elides nothing.
		const loose = await reader.readPage({ page: 0, pageSize: 5, rowBudget: 11 });
		expect(loose.rows.length).toBe(11);
		expect(loose.elided).toEqual([]);
	});

	test('an elided record is located by POSITION, not by rec: two sections repeat a section_id on one page', async () => {
		const store = markedStore();
		const { job } = await store.createJob(INIT);
		// An export of two sections, both numbered from 1: records 1-3 are section A's
		// 1, 2, 3 and records 4-6 are section B's 1, 2, 3 (the spool's rec is the
		// bare section_id). B's record 1 has 5 rows; A's record 1 has 1.
		const subRows = [1, 1, 1, 5, 1, 1];
		const lines = protocol(6, { subRowsOf: (rec) => subRows[rec - 1] as number }).map((line) =>
			line.t === 'row' ? { ...line, rec: ((Number(line.rec) - 1) % 3) + 1 } : line,
		);
		await (await spoolOf(store, job, lines, 3)).close();
		const reader = openSpoolReader(job.dir, { indexEvery: 3 });
		// Budget 7: six first rows + one of B-1's four sub-rows; three elided.
		const page = await reader.readPage({ page: 0, pageSize: 6, rowBudget: 7 });
		expect(page.rows.map((row) => `${row.rec}.${row.sub}`)).toEqual([
			'1.0',
			'2.0',
			'3.0',
			'1.0',
			'1.1',
			'2.0',
			'3.0',
		]);
		// ONE elided record, placed after B-1's last served row (index 4) — never
		// after A-1's row 0, which shares its rec.
		expect(page.elided).toEqual([{ rec: 1, rows: 3, after: 4 }]);
	});

	test('a spool deleted under the reader reads as NO spool (an empty page), never an ENOENT', async () => {
		const store = markedStore();
		const { job } = await store.createJob(INIT);
		await (await spoolOf(store, job, protocol(4), 2)).close();
		const reader = openSpoolReader(job.dir, { indexEvery: 2 });
		expect((await reader.readPage({ page: 0, pageSize: 10 })).records).toBe(4);
		// A Stop / the owner's delete / the sweep removes the spool after the door
		// already opened the reader.
		for (const name of [SPOOL_FILES.grid, SPOOL_FILES.cols, SPOOL_FILES.index]) {
			rmSync(join(job.dir, name), { force: true });
		}
		const page = await reader.readPage({ page: 0, pageSize: 10 });
		expect(page.records).toBe(0);
		expect(page.rows).toEqual([]);
		expect(await reader.readEnd()).toBeNull();
		expect(await reader.readCols()).toEqual(new Map());
		expect(await reader.columnOrder()).toEqual({ order: [], final: false });
		const lines: string[] = [];
		for await (const line of reader.rawLines()) lines.push(line);
		expect(lines).toEqual([]);
	});

	test('columnOrder({liveOnly}) never probes the grid tail (a running export: the answer can only be "not ended")', async () => {
		const store = markedStore();
		const { job } = await store.createJob(INIT);
		await (await spoolOf(store, job, protocol(5), 2)).close();
		const reader = openSpoolReader(job.dir, { indexEvery: 2 });
		expect((await reader.columnOrder()).final).toBe(true);
		expect(await reader.columnOrder({ liveOnly: true })).toEqual({
			order: [0, 2, 1],
			final: false,
		});
	});

	test('the page is bounded in BYTES: a transform keeps only what it returns, and sub-rows past the char budget are elided as trailing rows', async () => {
		const store = markedStore();
		const { job } = await store.createJob(INIT);
		const subRows = [3, 3, 1];
		await (
			await spoolOf(store, job, protocol(3, { subRowsOf: (rec) => subRows[rec - 1] as number }), 2)
		).close();
		const reader = openSpoolReader(job.dir, { indexEvery: 2 });
		const cut = (row: { c: Record<string, unknown> }) => ({ ...row, c: { '0': row.c['0'] } });
		const unbounded = await reader.readPage({
			page: 0,
			pageSize: 3,
			transform: (row) => ({ ...row, ...cut(row) }),
		});
		expect(unbounded.rows.length).toBe(7);
		// the transform's output is what the page holds — nothing it dropped
		expect(unbounded.rows.every((row) => Object.keys(row.c).join() === '0')).toBe(true);
		// A budget that fits the three first rows plus ONE sub-row: record 1 keeps
		// 2 rows; every later sub-row (record 1's third, record 2's two) is elided
		// — trailing per record — while every record keeps its FIRST row.
		const oneRow = JSON.stringify({ '0': '1' }).length;
		const tight = await reader.readPage({
			page: 0,
			pageSize: 3,
			transform: (row) => ({ ...row, ...cut(row) }),
			charBudget: oneRow * 2,
		});
		expect(tight.rows.map((row) => `${row.rec}.${row.sub}`)).toEqual(['1.0', '1.1', '2.0', '3.0']);
		expect(tight.elided).toEqual([
			{ rec: 1, rows: 1, after: 1 },
			{ rec: 2, rows: 2, after: 2 },
		]);
	});

	test('column order: live-insert order before end, end.columns after', async () => {
		const store = markedStore();
		const { job } = await store.createJob(INIT);
		const lines = protocol(5);
		const writer = await store.openSpoolWriter(job, { indexEvery: 2 });
		for (const line of lines.slice(0, -1)) await writer.write(line);
		await writer.flush();
		const reader = openSpoolReader(job.dir, { indexEvery: 2 });
		// the 'after' hints: 0 first, 1 after 0, then 2 after 0 → [0, 2, 1]
		expect(await reader.columnOrder()).toEqual({ order: [0, 2, 1], final: false });
		expect(await reader.readEnd()).toBeNull();
		await expectCode(reader.requireEnd(), 'export.artifact_not_ready');
		await writer.write(lines.at(-1) as Record<string, unknown>);
		await writer.close();
		expect(await reader.columnOrder()).toEqual({ order: [0, 2, 1], final: true });
		expect((await reader.requireEnd()).records).toBe(5);
		expect([...(await reader.readCols()).keys()]).toEqual([0, 1, 2]);
	});

	test('liveInsertOrder reproduces flat_table insert_col (null = first, unknown predecessor = last, duplicate ignored)', () => {
		const cols = [
			{ t: 'col', i: 5, after: null },
			{ t: 'col', i: 6, after: null },
			{ t: 'col', i: 7, after: 6 },
			{ t: 'col', i: 8, after: 42 },
			{ t: 'col', i: 7, after: null },
		] as SpoolColLine[];
		expect(liveInsertOrder(cols)).toEqual([6, 7, 5, 8]);
	});

	test('liveInsertOrder equals the insert_col rule on random col streams (differential)', () => {
		// The rule as flat_table.js states it: indexOf the predecessor, splice after it.
		const reference = (cols: readonly SpoolColLine[]): number[] => {
			const order: number[] = [];
			for (const col of cols) {
				if (order.includes(col.i)) continue;
				const at = col.after === null || col.after === undefined ? -1 : order.indexOf(col.after);
				const pos =
					col.after === null || col.after === undefined ? 0 : at === -1 ? order.length : at + 1;
				order.splice(pos, 0, col.i);
			}
			return order;
		};
		let seed = 7;
		const next = (n: number): number => {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			return seed % n;
		};
		let compared = 0;
		for (let run = 0; run < 200; run++) {
			const cols: SpoolColLine[] = [];
			const length = 1 + next(60);
			for (let k = 0; k < length; k++) {
				const roll = next(10);
				const after = roll === 0 ? null : roll === 1 ? undefined : next(80);
				cols.push({ t: 'col', i: next(70), after } as SpoolColLine);
			}
			expect(liveInsertOrder(cols), JSON.stringify(cols)).toEqual(reference(cols));
			compared++;
		}
		expect(compared).toBe(200);
	});

	test('liveInsertOrder is linear: 200k columns, each after the last, rebuild in well under a second', () => {
		// Runs on EVERY preview of a running export, on the shared event loop.
		// The indexOf+splice rule was quadratic: 50k columns ≈ 370 ms, 200k ≈ 6 s.
		const n = 200_000;
		const cols: SpoolColLine[] = [];
		for (let i = 0; i < n; i++)
			cols.push({ t: 'col', i, after: i === 0 ? null : i - 1 } as SpoolColLine);
		const started = performance.now();
		const order = liveInsertOrder(cols);
		const elapsed = performance.now() - started;
		expect(order.length).toBe(n);
		expect(order[0]).toBe(0);
		expect(order[n - 1]).toBe(n - 1);
		expect(elapsed).toBeLessThan(1000);
	});

	test('mid-run, a reader sees WHOLE records only — never half a record', async () => {
		const store = markedStore();
		const { job } = await store.createJob(INIT);
		const writer = await store.openSpoolWriter(job, { indexEvery: 1 });
		const reader = openSpoolReader(job.dir, { indexEvery: 1 });
		await writer.write({ t: 'meta', v: 1, total: 3 });
		await writer.write({ t: 'col', i: 0, key: 'id', after: null });
		await writer.write({ t: 'row', rec: 1, sub: 0, c: { '0': '1' } });
		await writer.write({ t: 'row', rec: 1, sub: 1, c: { '0': '1b' } });
		await writer.write({ t: 'row', rec: 2, sub: 0, c: { '0': '2' } });
		await writer.flush();
		let page = await reader.readPage({ page: 0, pageSize: 10 });
		expect(page.rows.map((r) => r.c['0'])).toEqual(['1', '1b']);
		await writer.write({ t: 'row', rec: 2, sub: 1, c: { '0': '2b' } });
		await writer.flush();
		page = await reader.readPage({ page: 0, pageSize: 10 });
		expect(page.rows.map((r) => r.c['0'])).toEqual(['1', '1b']);
		await writer.write({ t: 'row', rec: 3, sub: 0, c: { '0': '3' } });
		await writer.flush();
		page = await reader.readPage({ page: 0, pageSize: 10 });
		expect(page.rows.map((r) => r.c['0'])).toEqual(['1', '1b', '2', '2b']);
		// the index never points past the flushed grid
		expect(await reader.indexedRecords()).toBe(2);
		await writer.abort();
		expect(existsSync(join(job.dir, SPOOL_FILES.grid))).toBe(false);
		expect(existsSync(join(job.dir, SPOOL_FILES.manifest))).toBe(true);
	});

	test('indexedRecords is a LOWER bound on whole records visible, for any R', async () => {
		for (const indexEvery of [1, 3, 100]) {
			const store = markedStore();
			const { job } = await store.createJob(INIT);
			const writer = await store.openSpoolWriter(job, { indexEvery });
			const reader = openSpoolReader(job.dir, { indexEvery });
			try {
				expect(await reader.indexedRecords()).toBe(0);
				for (let rec = 1; rec <= 8; rec++) {
					await writer.write({ t: 'row', rec, sub: 0, c: { '0': String(rec) } });
					await writer.flush();
					// the record just started is not known whole yet: rec - 1 are
					const seen = await reader.indexedRecords();
					expect(seen, `R=${indexEvery} after ${rec} record(s)`).toBeLessThanOrEqual(rec - 1);
				}
			} finally {
				await writer.close();
			}
			const closed = await reader.indexedRecords();
			expect(closed).toBeLessThanOrEqual(8);
			// and never uselessly low: at most R-1 short of what was written
			expect(closed).toBeGreaterThanOrEqual(8 - indexEvery + 1);
		}
	});

	test('memory stays bounded: a large spool is flushed as it goes, not held', async () => {
		const store = markedStore();
		const { job } = await store.createJob(INIT);
		const writer = await store.openSpoolWriter(job);
		const big = 'x'.repeat(1000);
		for (let rec = 1; rec <= 2000; rec++)
			await writer.write({ t: 'row', rec, sub: 0, c: { '0': big } });
		// ~2 MB written; the in-memory tail is at most one threshold (256 KiB) + one record
		const onDisk = Bun.file(join(job.dir, SPOOL_FILES.grid)).size;
		expect(onDisk).toBeGreaterThan(writer.stats.gridBytes - 300 * 1024);
		await writer.close();
		expect(Bun.file(join(job.dir, SPOOL_FILES.grid)).size).toBe(writer.stats.gridBytes);
	});

	test('a close whose final flush fails (ENOSPC) still releases EVERY handle, then abort cleans up', async () => {
		const store = markedStore();
		const { job } = await store.createJob(INIT);
		// every spool file holds an unflushed tail when close() runs
		const writer = await spoolOf(store, job, protocol(3), 1);
		// The FileHandle prototype every spool handle shares: its write hits a full
		// disk, and every close is counted.
		const probe = await open(join(job.dir, 'probe'), 'w');
		const proto = Object.getPrototypeOf(probe) as {
			write: (...args: unknown[]) => Promise<unknown>;
			close: () => Promise<void>;
		};
		await probe.close();
		rmSync(join(job.dir, 'probe'));
		const realWrite = proto.write;
		const realClose = proto.close;
		let closes = 0;
		proto.write = async () => {
			throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
		};
		proto.close = async function (this: unknown) {
			closes++;
			return realClose.call(this);
		};
		let caught: unknown = null;
		try {
			await writer.close();
		} catch (error) {
			caught = error;
		} finally {
			proto.write = realWrite;
			proto.close = realClose;
		}
		expect((caught as { code?: string } | null)?.code).toBe('ENOSPC');
		// cols, grid AND idx released — none leaks behind the first failure
		expect(closes).toBe(3);
		await writer.abort();
		expect(readdirSync(job.dir).sort()).toEqual([SPOOL_FILES.manifest, SPOOL_FILES.request].sort());
	});

	test('close() keeps flushAll order: the final idx entry is written only after the grid bytes it points at', async () => {
		const store = markedStore();
		const { job } = await store.createJob(INIT);
		// R=1: every record has an idx entry, so the LAST one is still buffered at close
		const writer = await spoolOf(store, job, protocol(3), 1);
		const probe = await open(join(job.dir, 'probe'), 'w');
		const proto = Object.getPrototypeOf(probe) as {
			write: (...args: unknown[]) => Promise<unknown>;
		};
		await probe.close();
		rmSync(join(job.dir, 'probe'));
		const realWrite = proto.write;
		const events: string[] = [];
		// a SLOW grid write: a parallel close would start the idx write meanwhile
		proto.write = async function (this: unknown, ...args: unknown[]) {
			const text = String(args[0]);
			const kind = /^\d+\n/.test(text)
				? 'idx'
				: text.includes('"t":"row"') || text.includes('"t":"end"')
					? 'grid'
					: 'cols';
			events.push(`${kind}:start`);
			if (kind === 'grid') await Bun.sleep(30);
			const result = await realWrite.apply(this, args);
			events.push(`${kind}:done`);
			return result;
		};
		try {
			await writer.close();
		} finally {
			proto.write = realWrite;
		}
		const gridDone = events.lastIndexOf('grid:done');
		const idxStart = events.indexOf('idx:start');
		expect(gridDone, events.join(' ')).toBeGreaterThanOrEqual(0);
		expect(idxStart, events.join(' ')).toBeGreaterThan(gridDone);
	});

	test('a spool whose LATER file cannot be created (EEXIST leftover) releases the handles already opened', async () => {
		const store = markedStore();
		const openFds = (): number => readdirSync('/dev/fd').length;
		for (const blocker of [SPOOL_FILES.cols, SPOOL_FILES.index]) {
			const { job } = await store.createJob({
				...INIT,
				jobId: `leak_${blocker.replace('.', '_')}`,
			});
			writeFileSync(join(job.dir, blocker), 'leftover');
			const before = openFds();
			let caught: unknown = null;
			try {
				await store.openSpoolWriter(job);
			} catch (error) {
				caught = error;
			}
			expect((caught as { code?: string } | null)?.code).toBe('EEXIST');
			// grid (and cols, when idx failed) were opened first: none is left open
			expect(openFds()).toBe(before);
		}
	});

	test('SHORT WRITES: a write(2) that returns a partial count loses nothing — spool, offsets and built file stay whole', async () => {
		const store = markedStore();
		const { job } = await store.createJob(INIT);
		const lines = protocol(40, { subRowsOf: (rec) => (rec % 3 === 0 ? 2 : 1) });
		const probe = await open(join(job.dir, 'probe'), 'w');
		const proto = Object.getPrototypeOf(probe) as {
			write: (...args: unknown[]) => Promise<{ bytesWritten: number }>;
		};
		await probe.close();
		rmSync(join(job.dir, 'probe'));
		const realWrite = proto.write;
		// A nearly full volume: every write(2) puts at most 7 bytes on disk and
		// resolves normally with the short count (FileHandle.write does not loop).
		let calls = 0;
		proto.write = function (this: unknown, data: unknown, a?: unknown, b?: unknown, c?: unknown) {
			calls++;
			const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : (data as Uint8Array);
			const offset = typeof data === 'string' ? 0 : typeof a === 'number' ? a : 0;
			const length =
				typeof data === 'string'
					? buffer.byteLength
					: typeof b === 'number'
						? b
						: buffer.byteLength - offset;
			const position = typeof data === 'string' ? (typeof a === 'number' ? a : null) : (c ?? null);
			return realWrite.call(this, buffer, offset, Math.min(7, length), position);
		};
		let stats: Awaited<ReturnType<Awaited<ReturnType<typeof spoolOf>>['close']>>;
		let file: Awaited<ReturnType<typeof buildArtifactFile>>;
		try {
			stats = await (await spoolOf(store, job, lines, 4)).close();
			await store.updateManifest(job, { status: 'ended', ended_at: new Date().toISOString() });
			file = await buildArtifactFile({
				store,
				job,
				format: 'ndjson',
				options: { origin: 'https://example.test', showTipoInLabel: false },
				signal: new AbortController().signal,
			});
		} finally {
			proto.write = realWrite;
		}
		expect(calls).toBeGreaterThan(10); // the cap was live
		const grid = readFileSync(join(job.dir, SPOOL_FILES.grid), 'utf8');
		expect(grid).toBe(serialize(lines));
		// the offsets the manifest and grid.idx carry are bytes that ARE on disk
		expect(stats.committedGridBytes).toBe(Buffer.byteLength(grid));
		// a page read through grid.idx (R=4) lands on a record's first row
		const page = await openSpoolReader(job.dir, { indexEvery: 4 }).readPage({
			page: 9,
			pageSize: 4,
		});
		expect(page.rows as unknown[]).toEqual(
			lines.filter((l) => l.t === 'row' && Number(l.rec) > 36),
		);
		const built = readFileSync(join(job.dir, 'export.ndjson'), 'utf8');
		expect(built).toBe(serialize(lines));
		expect(file.bytes).toBe(Buffer.byteLength(built));
	});

	test('writeFully: loops a partial write to the end (positional too); NO progress is refused typed', async () => {
		const disk = new Uint8Array(64);
		const shortHandle = {
			write: async (
				buffer: Uint8Array,
				offset: number,
				length: number,
				position: number | null,
			) => {
				const n = Math.min(3, length);
				disk.set(buffer.subarray(offset, offset + n), position ?? 0);
				return { bytesWritten: n, buffer };
			},
		} as unknown as Parameters<typeof writeFully>[0];
		const payload = Buffer.from('0123456789abcdefghij', 'utf8');
		expect(await writeFully(shortHandle, payload, 10)).toBe(payload.byteLength);
		expect(Buffer.from(disk.subarray(10, 30)).toString('utf8')).toBe('0123456789abcdefghij');
		// No progress, no error: refused at once (a bounded fake, so a missing
		// refusal fails this gate instead of spinning forever).
		let stuckCalls = 0;
		const stuck = {
			write: async (buffer: Uint8Array) => {
				if (++stuckCalls > 100) throw new Error('writeFully spun on a write that made no progress');
				return { bytesWritten: 0, buffer };
			},
		} as unknown as Parameters<typeof writeFully>[0];
		await expectCode(writeFully(stuck, payload), 'export.storage_low');
		expect(stuckCalls).toBe(1);
	});
});

describe('C2. the manifest: the caller-sized request is written ONCE, a checkpoint rewrites only the small state', () => {
	test('a checkpoint over a ~512 KiB options manifest writes a few hundred bytes and never touches request.json', async () => {
		const store = markedStore();
		const bigOptions = {
			...INIT.options,
			ar_ddo_to_export: Array.from({ length: 4000 }, (_, n) => ({
				tipo: `test${n}`,
				padding: 'p'.repeat(120),
			})),
		};
		const { job } = await store.createJob({ ...INIT, options: bigOptions });
		const requestFile = join(job.dir, SPOOL_FILES.request);
		const stateFile = join(job.dir, SPOOL_FILES.manifest);
		const requestBefore = statSync(requestFile);
		expect(requestBefore.size).toBeGreaterThan(512 * 1024);
		// the progress patch every walk checkpoint sends
		const joined = await store.updateManifest(job, {
			records: 500,
			rows: 500,
			spool_bytes: 123_456,
			grid_bytes: 120_000,
			total: 1000,
			frontier_grants: [],
		});
		const stateBytes = statSync(stateFile).size;
		expect(stateBytes).toBeLessThan(4096);
		const requestAfter = statSync(requestFile);
		expect(requestAfter.ino).toBe(requestBefore.ino);
		expect(requestAfter.mtimeMs).toBe(requestBefore.mtimeMs);
		// the state file never carries the request keys
		const state = JSON.parse(readFileSync(stateFile, 'utf8'));
		expect('options' in state || 'sections' in state).toBe(false);
		// readers still see ONE joined manifest, options intact
		expect(joined.options).toEqual(bigOptions);
		expect(joined.records).toBe(500);
		const read = await store.readManifest(job);
		expect(read.options).toEqual(bigOptions);
		expect(read.sections).toEqual(INIT.sections);
		expect(read.records).toBe(500);
		// a patch cannot rewrite the request
		await store.updateManifest(job, { options: { hijacked: true } } as never);
		expect((await store.readManifest(job)).options).toEqual(bigOptions);
		expect(statSync(requestFile).ino).toBe(requestBefore.ino);
	});

	test('listJobs(where) filters on the small STATE before any request is read', async () => {
		const store = markedStore();
		const kept = await store.createJob({ ...INIT, jobId: 'where_kept', sectionTipo: 'test3' });
		const other = await store.createJob({ ...INIT, jobId: 'where_other', sectionTipo: 'test71' });
		const listed = await store.listJobs(INIT.userId, (state) => state.section_tipo === 'test3');
		expect(listed.map((manifest) => manifest.job_id)).toEqual([kept.job.jobId]);
		expect(listed[0]?.options).toEqual(INIT.options);
		// the state listing sees both, and reads no request at all: an unreadable
		// request does not hide a job from it
		writeFileSync(join(other.job.dir, SPOOL_FILES.request), '{not json');
		const states = await store.listJobStates(INIT.userId);
		expect(states.map((state) => state.job_id).sort()).toEqual(['where_kept', 'where_other']);
		// a job whose request is unreadable is not listed by the full listing (fail closed)
		expect((await store.listJobs(INIT.userId)).map((manifest) => manifest.job_id)).toEqual([
			'where_kept',
		]);
	});
});

describe('D0. the count cap and the volume floor', () => {
	const declaredRoot = () => markExportArtifactsRoot(join(scratch(), 'artifacts'));

	test('a user keeps at most maxExports exports: the next is refused typed, nothing created; a delete frees a slot', async () => {
		const store = openArtifactStore({ root: declaredRoot(), quotaBytes: 0, maxExports: 2 });
		const first = await store.createJob({ ...INIT, jobId: 'cap_1' });
		await store.createJob({ ...INIT, jobId: 'cap_2' });
		// another user is not counted against this one
		await store.createJob({ ...INIT, userId: 8, jobId: 'cap_other' });
		let caught: unknown = null;
		try {
			await store.createJob({ ...INIT, jobId: 'cap_3' });
		} catch (error) {
			caught = error;
		}
		expect((caught as { code?: string } | null)?.code).toBe('export.artifact_count');
		expect((caught as { details?: unknown }).details).toEqual({ max_exports: 2 });
		expect(existsSync(store.jobRef(7, 'cap_3').dir)).toBe(false);
		await store.deleteJob(first.job);
		expect((await store.createJob({ ...INIT, jobId: 'cap_3' })).manifest.status).toBe('running');
		// 0 = off
		const off = openArtifactStore({ root: declaredRoot(), quotaBytes: 0, maxExports: 0 });
		for (let i = 0; i < 5; i++) await off.createJob({ ...INIT, jobId: `off_${i}` });
	});

	test('the volume floor: a door at the floor refuses before writing; a writer crossing it stops typed', async () => {
		const volume = { free: 500 };
		const store = openArtifactStore({
			root: declaredRoot(),
			quotaBytes: 0,
			minFreeBytes: 1000,
			freeBytes: async () => volume.free,
		});
		await expectCode(store.createJob({ ...INIT, jobId: 'floor_refused' }), 'export.storage_low');
		expect(existsSync(store.jobRef(7, 'floor_refused').dir)).toBe(false);

		// room for ~20 KiB above the floor, then the spool fills it
		volume.free = 1000 + 20 * 1024;
		const { job } = await store.createJob({ ...INIT, jobId: 'floor_writer' });
		const writer = await store.openSpoolWriter(job);
		const before = volume.free;
		let caught: unknown = null;
		try {
			for (let rec = 1; rec <= 400; rec++) {
				await writer.write({ t: 'row', rec, sub: 0, c: { '0': 'y'.repeat(200) } });
				// the volume shrinks as the spool grows (a real disk would)
				volume.free = before - writer.stats.bytes;
			}
		} catch (error) {
			caught = error;
		}
		expect((caught as { code?: string } | null)?.code).toBe('export.storage_low');
		// stopped at the floor, never past it by more than one record
		expect(writer.stats.bytes).toBeLessThanOrEqual(21 * 1024);
		expect(writer.stats.bytes).toBeGreaterThan(0);
		await writer.abort();

		// a file build at the floor refuses before creating its temp
		volume.free = 1000;
		await store.updateManifest(job, { status: 'ended', ended_at: new Date().toISOString() });
		const file = store.allocateFile(job, 'csv');
		await expectCode(store.openFileSink(job, file), 'export.storage_low');
		expect(existsSync(file.tempPath)).toBe(false);
		// 0 = off: the same volume takes a job
		const off = openArtifactStore({
			root: declaredRoot(),
			quotaBytes: 0,
			minFreeBytes: 0,
			freeBytes: async () => 0,
		});
		expect((await off.createJob(INIT)).manifest.status).toBe('running');
	});
});

describe('D. quota', () => {
	test('the MANIFEST is charged to the quota before it is written (its options are persisted cost)', async () => {
		// A quota that holds an empty directory but not this manifest: refused,
		// and no job directory is left behind.
		const options = { ...INIT.options, sqo: { section_tipo: ['test3'], pad: 'm'.repeat(8000) } };
		const store = markedStore({ quotaBytes: 4096 });
		await expectCode(
			store.createJob({ ...INIT, jobId: 'exp_manifest_q', options }),
			'export.artifact_quota',
		);
		expect(existsSync(store.jobRef(7, 'exp_manifest_q').dir)).toBe(false);
		// The same manifest fits a quota that holds it.
		const roomy = markedStore({ quotaBytes: 64 * 1024 });
		const { job } = await roomy.createJob({ ...INIT, jobId: 'exp_manifest_ok', options });
		expect((await roomy.readManifest(job)).options).toEqual(options);
	});

	test('recorded options above MANIFEST_OPTIONS_MAX_BYTES are refused, even with no quota', async () => {
		const store = markedStore({ quotaBytes: 0 });
		const options = { sqo: { pad: 'x'.repeat(MANIFEST_OPTIONS_MAX_BYTES) } };
		await expectCode(
			store.createJob({ ...INIT, jobId: 'exp_big_opts', options }),
			'request.invalid_options',
		);
		expect(existsSync(store.jobRef(7, 'exp_big_opts').dir)).toBe(false);
	});

	test('writing past the budget stops with export.artifact_quota', async () => {
		const store = markedStore({ quotaBytes: 4096 });
		const { job } = await store.createJob(INIT);
		const writer = await store.openSpoolWriter(job);
		let caught: unknown = null;
		try {
			for (let rec = 1; rec <= 100; rec++)
				await writer.write({ t: 'row', rec, sub: 0, c: { '0': 'y'.repeat(200) } });
		} catch (error) {
			caught = error;
		}
		expect((caught as { code?: string })?.code).toBe('export.artifact_quota');
		expect((caught as { details?: Record<string, unknown> }).details).toEqual({
			quota_bytes: 4096,
		});
		await writer.abort();
		expect(await store.usedBytes(7)).toBeLessThanOrEqual(4096);
	});

	test('the re-measure step is proportional to the quota: a multi-GB export walks the tree hundreds of times, not thousands', () => {
		const GiB = 1024 * 1024 * 1024;
		const MiB = 1024 * 1024;
		// the default 10 GiB quota: 16 MiB steps (a 5 GB export re-walks ~320 times, not ~5,000)
		expect(quotaRecheckStep(10 * GiB)).toBe(16 * MiB);
		expect(Math.ceil((5 * GiB) / quotaRecheckStep(10 * GiB))).toBeLessThanOrEqual(320);
		// proportional in between, and the slack stays a sliver of the quota
		expect(quotaRecheckStep(256 * MiB)).toBe(4 * MiB);
		for (const quota of [64 * 1024, 256 * MiB, GiB, 10 * GiB, 100 * GiB]) {
			expect(quotaRecheckStep(quota)).toBeLessThanOrEqual(Math.max(4096, quota / 64));
		}
		expect(quotaRecheckStep(64 * 1024)).toBe(4096);
	});

	test('CONCURRENT spool writers of one user share ONE quota (no per-writer snapshot)', async () => {
		const quota = 64 * 1024;
		const store = markedStore({ quotaBytes: quota });
		const writers = [];
		for (let n = 0; n < 4; n++) {
			const { job } = await store.createJob({ ...INIT, jobId: `exp_conc_${n}` });
			writers.push(await store.openSpoolWriter(job, { indexEvery: 1000 }));
		}
		const record = 'q'.repeat(1000);
		const refused = new Set<number>();
		for (let rec = 1; rec <= 100 && refused.size < writers.length; rec++) {
			for (const [n, writer] of writers.entries()) {
				if (refused.has(n)) continue;
				try {
					await writer.write({ t: 'row', rec, sub: 0, c: { '0': record } });
					await writer.flush();
				} catch (error) {
					expect((error as { code?: string }).code).toBe('export.artifact_quota');
					refused.add(n);
				}
			}
		}
		for (const writer of writers) await writer.close();
		expect(refused.size).toBe(writers.length);
		// bounded slack per live writer (one recheck step + one record), never N x quota
		expect(await store.usedBytes(7)).toBeLessThanOrEqual(quota + writers.length * (4096 + 1100));
	});

	test('CONCURRENT file sinks of one user share ONE quota', async () => {
		const quota = 64 * 1024;
		const store = markedStore({ quotaBytes: quota });
		const { job } = await store.createJob(INIT);
		const sinks = [];
		for (const format of ['csv', 'tsv', 'html'] as const)
			sinks.push(await store.openFileSink(job, store.allocateFile(job, format)));
		const chunk = 'k'.repeat(1024);
		const refused = new Set<number>();
		for (let round = 0; round < 200 && refused.size < sinks.length; round++) {
			for (const [n, opened] of sinks.entries()) {
				if (refused.has(n)) continue;
				try {
					await opened.sink.write(chunk);
				} catch (error) {
					expect((error as { code?: string }).code).toBe('export.artifact_quota');
					refused.add(n);
				}
			}
		}
		for (const opened of sinks) await opened.commit({ rows: 0 });
		expect(refused.size).toBe(sinks.length);
		expect(await store.usedBytes(7)).toBeLessThanOrEqual(quota + sinks.length * (4096 + 1024));
	});

	test('concurrent manifest updates never lose each other (files of parallel builds)', async () => {
		const store = markedStore();
		const { job } = await store.createJob(INIT);
		await Promise.all(
			Array.from({ length: 24 }, (_, n) =>
				store.updateManifest(job, (current) => ({
					...current,
					files: {
						...current.files,
						[`f${n}`]: { format: 'csv', basename: `f${n}`, bytes: n, rows: n, created_at: 'x' },
					},
				})),
			),
		);
		expect(Object.keys((await store.readManifest(job)).files).length).toBe(24);
	});

	test('a user already over the quota cannot start another export; other users can', async () => {
		const store = markedStore({ quotaBytes: 1000 });
		const { job } = await store.createJob(INIT);
		writeFileSync(join(job.dir, 'export.csv'), 'z'.repeat(2000));
		await expectCode(store.createJob(INIT), 'export.artifact_quota');
		await store.createJob({ ...INIT, userId: 8 });
		await store.deleteJob(job);
		await store.createJob(INIT);
	});
});

describe('E. the TTL sweep', () => {
	test('OWNERSHIP: a root the store did not create is never swept — a foreign <digits>/<name> tree survives, typed refusal', async () => {
		// A shared mount holding year-named batches: the shape USER_DIR/JOB_ID match.
		const root = markExportArtifactsRoot(join(scratch(), 'shared_archive'));
		const batch = join(root, '2019', 'scans_batch1');
		mkdirSync(batch, { recursive: true });
		writeFileSync(join(batch, 'photo.tif'), 'irreplaceable');
		const old = new Date(Date.now() - 30 * 24 * 3600_000);
		utimesSync(batch, old, old);
		const store = openArtifactStore({ root, quotaBytes: 0, ttlHours: 24 });
		await expectCode(store.sweep(), 'export.store_unavailable');
		await expectCode(store.createJob(INIT), 'export.store_unavailable');
		expect(readFileSync(join(batch, 'photo.tif'), 'utf8')).toBe('irreplaceable');
		expect(existsSync(join(root, EXPORT_ARTIFACTS_OWNER_MARKER))).toBe(false);
	});

	test("OWNERSHIP: an empty root is claimed (marker planted); a manifest-less job dir is removed only when every entry is the store's", async () => {
		const store = markedStore({ ttlHours: 1 });
		await store.sweep();
		expect(existsSync(join(store.root, EXPORT_ARTIFACTS_OWNER_MARKER))).toBe(true);
		const old = new Date(Date.now() - 3 * 3600_000);
		const crashed = join(store.root, '-5', 'exp_crashed');
		mkdirSync(crashed, { recursive: true });
		writeFileSync(join(crashed, SPOOL_FILES.grid), '{"t":"meta"}\n');
		utimesSync(crashed, old, old);
		const strange = join(store.root, '-5', 'not_ours');
		mkdirSync(strange, { recursive: true });
		writeFileSync(join(strange, 'photo.tif'), 'keep');
		utimesSync(strange, old, old);
		const report = await store.sweep();
		expect(existsSync(crashed)).toBe(false);
		expect(readFileSync(join(strange, 'photo.tif'), 'utf8')).toBe('keep');
		expect(report.deleted).toBe(1);
	});

	test("INSTALL IDENTITY: a root another install's marker names is refused by every door — reads included; a marker naming none is adopted", async () => {
		const owned = markedStore();
		const { job } = await owned.createJob(INIT);
		await (await spoolOf(owned, job, protocol(2))).close();
		await owned.updateManifest(job, { status: 'ended', ended_at: new Date().toISOString() });
		const marker = join(owned.root, EXPORT_ARTIFACTS_OWNER_MARKER);
		expect(readFileSync(marker, 'utf8')).toContain(`install: ${exportStoreInstallFingerprint()}`);
		const theirs = exportStoreInstallFingerprint('another_archive_db');
		expect(theirs).not.toBe(exportStoreInstallFingerprint());
		// Another install (same path, another database) claimed the root.
		writeFileSync(marker, `Dédalo export artifacts root\ninstall: ${theirs}\n`);
		const fresh = () => openArtifactStore({ root: owned.root, quotaBytes: 0, ttlHours: 24 });
		await expectCode(fresh().listJobs(INIT.userId), 'export.store_unavailable');
		await expectCode(fresh().readManifest(job), 'export.store_unavailable');
		await expectCode(
			fresh().createJob({ ...INIT, jobId: 'foreign_root' }),
			'export.store_unavailable',
		);
		await expectCode(fresh().sweep(), 'export.store_unavailable');
		expect(await fresh().resolveArtifactFile(INIT.userId, job.jobId, 'export.ndjson')).toBeNull();
		// nothing of theirs was touched
		expect(existsSync(join(job.dir, SPOOL_FILES.grid))).toBe(true);
		// A marker that names NO install (planted before markers carried one) is
		// the store's own: adopted and bound to this install on the next write.
		writeFileSync(marker, 'Dédalo export artifacts root — the export store owns this directory\n');
		expect((await fresh().listJobs(INIT.userId)).map((manifest) => manifest.job_id)).toEqual([
			job.jobId,
		]);
		await fresh().createJob({ ...INIT, jobId: 'adopted_root' });
		expect(readFileSync(marker, 'utf8')).toContain(`install: ${exportStoreInstallFingerprint()}`);
	});

	test('expired / recent / orphaned-running / live-running / stale temps', async () => {
		const store = markedStore({ ttlHours: 1 });
		const now = Date.now();
		const hour = 3600_000;
		const make = async (jobId: string, patch: Record<string, unknown>) => {
			const { job } = await store.createJob({ ...INIT, jobId });
			await (await spoolOf(store, job, protocol(2))).close();
			await store.updateManifest(job, patch);
			return job;
		};
		const expired = await make('expired', {
			status: 'ended',
			ended_at: new Date(now - 2 * hour).toISOString(),
		});
		const recent = await make('recent', {
			status: 'ended',
			ended_at: new Date(now - 0.5 * hour).toISOString(),
		});
		const orphan = await make('orphan', {
			status: 'running',
			owner_boot: 'another-boot',
			owner_pid: 2 ** 22 + 12345,
		});
		const live = await make('live', { status: 'running' });
		// the leftover is named by the REAL temp namer, so a change to it is measured here
		const temp = tempPathFor(join(recent.dir, 'export.csv'));
		writeFileSync(temp, 'partial');
		utimesSync(temp, new Date(now - 2 * hour), new Date(now - 2 * hour));

		const report = await store.sweep({ now });
		expect(report).toEqual({ deleted: 1, interrupted: 1, temps: 1, kept: 2 });
		expect(existsSync(expired.dir)).toBe(false);
		expect(existsSync(recent.dir)).toBe(true);
		expect(existsSync(temp)).toBe(false);
		expect((await store.readManifest(orphan)).status).toBe('interrupted');
		expect(existsSync(join(orphan.dir, SPOOL_FILES.grid))).toBe(false);
		expect((await store.readManifest(live)).status).toBe('running');
		expect(existsSync(join(live.dir, SPOOL_FILES.grid))).toBe(true);

		// the interrupted one expires one TTL later like any ended export
		const later = await store.sweep({ now: now + 2 * hour });
		expect(existsSync(orphan.dir)).toBe(false);
		expect(later.deleted).toBeGreaterThanOrEqual(2);
		expect(existsSync(live.dir)).toBe(true);
	});

	test('a running job of ANOTHER boot whose pid is OURS is dead (pid reuse: container PID 1)', async () => {
		const store = markedStore({ ttlHours: 24 });
		const { job } = await store.createJob({ ...INIT, jobId: 'reused_pid' });
		await (await spoolOf(store, job, protocol(2))).close();
		await store.updateManifest(job, { owner_boot: 'previous-boot', owner_pid: process.pid });
		const report = await store.sweep();
		expect(report.interrupted).toBe(1);
		expect((await store.readManifest(job)).status).toBe('interrupted');
		expect(existsSync(join(job.dir, SPOOL_FILES.grid))).toBe(false);
	});

	test('the heartbeat: another boot, owner pid ALIVE — stale is interrupted, fresh is kept', async () => {
		const store = markedStore({ ttlHours: 1 });
		const now = Date.now();
		const alivePid = process.ppid; // alive and not ours
		expect(alivePid).not.toBe(process.pid);
		const make = async (jobId: string, updatedAgoMs: number) => {
			const { job, manifest } = await store.createJob({ ...INIT, jobId });
			await (await spoolOf(store, job, protocol(2))).close();
			// writeManifest keeps updated_at as given (updateManifest would refresh it)
			await store.writeManifest(job, {
				...manifest,
				owner_boot: 'another-boot',
				owner_pid: alivePid,
				updated_at: new Date(now - updatedAgoMs).toISOString(),
			});
			return job;
		};
		const stale = await make('stale_heartbeat', 2 * 3600_000);
		const fresh = await make('fresh_heartbeat', 60_000);
		const report = await store.sweep({ now });
		expect(report.interrupted).toBe(1);
		expect((await store.readManifest(stale)).status).toBe('interrupted');
		expect(existsSync(join(stale.dir, SPOOL_FILES.grid))).toBe(false);
		expect((await store.readManifest(fresh)).status).toBe('running');
		expect(existsSync(join(fresh.dir, SPOOL_FILES.grid))).toBe(true);
	});

	test('the heartbeat bound is the WRITER cadence, not the TTL: a foreign export silent 2 h is interrupted under a 24 h TTL even though its pid answers alive', async () => {
		expect(DEAD_WRITER_SILENCE_MS).toBe(3600_000);
		const store = markedStore({ ttlHours: 24 });
		const now = Date.now();
		// alive and not ours — the kill(pid, 0) answer a reused pid also gives
		const alivePid = process.ppid;
		const { job, manifest } = await store.createJob({ ...INIT, jobId: 'silent_under_long_ttl' });
		await (await spoolOf(store, job, protocol(2))).close();
		await store.writeManifest(job, {
			...manifest,
			owner_boot: 'another-boot',
			owner_pid: alivePid,
			updated_at: new Date(now - 2 * 3600_000).toISOString(),
		});
		expect(effectiveJobStatus(await store.readManifest(job), { ttlHours: 24, now })).toBe(
			'interrupted',
		);
		const report = await store.sweep({ now });
		expect(report.interrupted).toBe(1);
		expect((await store.readManifest(job)).status).toBe('interrupted');
	});

	test('file builds: a build in progress is never swept, a built file never extends the TTL, a swept export refuses typed', async () => {
		const store = markedStore({ ttlHours: 1 });
		const now = Date.now();
		const hour = 3600_000;
		const endedLongAgo = async (jobId: string) => {
			const { job } = await store.createJob({ ...INIT, jobId });
			await (await spoolOf(store, job, protocol(3))).close();
			await store.updateManifest(job, {
				status: 'ended',
				ended_at: new Date(now - 5 * hour).toISOString(),
			});
			return job;
		};

		// 1. A build IN PROGRESS on an export past its TTL: kept, temp untouched —
		//    even when its temp has not grown for longer than the stale-temp age.
		const building = await endedLongAgo('building');
		const file = store.allocateFile(building, 'csv');
		const opened = await store.openFileSink(building, file);
		await opened.sink.write('a,b\n');
		const oldMtime = new Date(now - 2 * hour);
		utimesSync(file.tempPath, oldMtime, oldMtime);
		const during = await store.sweep({ now });
		expect(during.deleted).toBe(0);
		expect(during.temps).toBe(0);
		expect(existsSync(file.tempPath)).toBe(true);
		// ...and it commits: recorded, lease released.
		const entry = await opened.commit({ rows: 1 });
		const committed = await store.readManifest(building);
		expect(committed.files[file.basename]).toEqual(entry);
		expect(Object.keys(committed.builds ?? {})).toEqual([]);
		expect(readFileSync(file.finalPath, 'utf8')).toBe('a,b\n');

		// 2. The TTL is a HARD ceiling from the export's END: a file built from it
		//    never extends it. The export past end + TTL goes at the next sweep,
		//    its fresh file with it...
		const after = await store.sweep({ now: Date.now() });
		expect(after.deleted).toBe(1);
		expect(existsSync(building.dir)).toBe(false);
		//    ...and one ended 30 min ago with a file built NOW expires one TTL after
		//    its END (at +36 min), not one TTL after the file.
		const recent = await store.createJob({ ...INIT, jobId: 'recent_rebuilt' });
		await (await spoolOf(store, recent.job, protocol(3))).close();
		await store.updateManifest(recent.job, {
			status: 'ended',
			ended_at: new Date(now - 0.5 * hour).toISOString(),
		});
		const rebuilt = store.allocateFile(recent.job, 'csv');
		await (await store.openFileSink(recent.job, rebuilt)).commit({ rows: 0 });
		expect(exportExpired(await store.readManifest(recent.job), { ttlHours: 1 })).toBe(false);
		const ceiling = now + 0.6 * hour;
		expect(exportExpired(await store.readManifest(recent.job), { ttlHours: 1, now: ceiling })).toBe(
			true,
		);
		expect((await store.sweep({ now: ceiling })).deleted).toBe(1);
		expect(existsSync(recent.job.dir)).toBe(false);

		// 3. An abort releases the lease: the export then expires normally.
		const aborted = await endedLongAgo('aborted');
		const abortedFile = store.allocateFile(aborted, 'tsv');
		const abortedSink = await store.openFileSink(aborted, abortedFile);
		await abortedSink.abort();
		expect(existsSync(abortedFile.tempPath)).toBe(false);
		expect(Object.keys((await store.readManifest(aborted)).builds ?? {})).toEqual([]);
		expect((await store.sweep({ now })).deleted).toBe(1);
		expect(existsSync(aborted.dir)).toBe(false);

		// 4. A lease left by a DEAD process of another boot does not pin the export.
		const orphaned = await endedLongAgo('orphaned_build');
		const orphanFile = store.allocateFile(orphaned, 'html');
		writeFileSync(orphanFile.tempPath, 'partial');
		const orphanManifest = await store.readManifest(orphaned);
		await store.writeManifest(orphaned, {
			...orphanManifest,
			builds: {
				[orphanFile.tempPath.slice(orphaned.dir.length + 1)]: {
					basename: orphanFile.basename,
					owner_pid: 2 ** 22 + 12345,
					owner_boot: 'another-boot',
					started_at: new Date(now - 5 * hour).toISOString(),
				},
			},
		});
		expect((await store.sweep({ now })).deleted).toBe(1);
		expect(existsSync(orphaned.dir)).toBe(false);

		// 5. A build that starts AFTER the sweep removed its export is refused
		//    typed (export.artifact_not_found), and writes nothing.
		const swept = await endedLongAgo('swept_first');
		expect((await store.sweep({ now })).deleted).toBe(1);
		const lateFile = store.allocateFile(swept, 'csv');
		await expectCode(store.openFileSink(swept, lateFile), 'export.artifact_not_found');
		expect(existsSync(swept.dir)).toBe(false);
	});

	test('a job that ENDS while the sweep waits on its lock is left ended — manifest not overwritten, spool not deleted', async () => {
		const store = markedStore({ ttlHours: 24 });
		const { job, manifest } = await store.createJob({ ...INIT, jobId: 'ends_mid_sweep' });
		await (await spoolOf(store, job, protocol(2))).close();
		// What the sweep's unlocked read sees: a running job whose owner is dead.
		await store.writeManifest(job, {
			...manifest,
			owner_boot: 'another-boot',
			owner_pid: 2 ** 22 + 12345,
		});
		// The job's writer holds the manifest lock (finishJob's terminal write).
		const lock = join(job.dir, 'manifest.json.lock');
		writeFileSync(lock, '');
		const sweeping = store.sweep();
		await Bun.sleep(60);
		// ...and ends under it, then releases.
		await store.writeManifest(job, {
			...(await store.readManifest(job)),
			status: 'ended',
			ended_at: new Date().toISOString(),
		});
		rmSync(lock);
		const report = await sweeping;
		expect(report.interrupted).toBe(0);
		expect((await store.readManifest(job)).status).toBe('ended');
		for (const name of [SPOOL_FILES.grid, SPOOL_FILES.cols, SPOOL_FILES.index]) {
			expect(existsSync(join(job.dir, name))).toBe(true);
		}
	});

	test('ONE liveness verdict: the status a reader is served, the owner delete and the sweep agree', async () => {
		const now = Date.now();
		const alivePid = process.ppid; // alive, not ours
		const cases: { name: string; patch: Record<string, unknown>; running: boolean }[] = [
			{ name: 'same_boot_direct', patch: {}, running: true },
			{
				name: 'foreign_alive_fresh',
				patch: {
					owner_boot: 'another-boot',
					owner_pid: alivePid,
					updated_at: new Date(now - 60_000).toISOString(),
				},
				running: true,
			},
			{
				name: 'foreign_alive_stale',
				patch: {
					owner_boot: 'another-boot',
					owner_pid: alivePid,
					updated_at: new Date(now - 3 * 3600_000).toISOString(),
				},
				running: false,
			},
			{
				name: 'foreign_dead_pid',
				patch: { owner_boot: 'another-boot', owner_pid: 2 ** 22 + 12345 },
				running: false,
			},
			{
				name: 'foreign_our_pid',
				patch: { owner_boot: 'another-boot', owner_pid: process.pid },
				running: false,
			},
		];
		for (const leg of cases) {
			const store = markedStore({ ttlHours: 1 });
			const { job, manifest } = await store.createJob({ ...INIT, jobId: leg.name });
			const written = { ...manifest, ...leg.patch } as typeof manifest;
			await store.writeManifest(job, written);
			// the status list_export_jobs / get_export_preview serve
			expect(effectiveStatus(written, store), leg.name).toBe(
				leg.running ? 'running' : 'interrupted',
			);
			expect(effectiveJobStatus(written, { ttlHours: store.ttlHours, now })).toBe(
				leg.running ? 'running' : 'interrupted',
			);
			// the owner's delete: busy exactly when served 'running'
			let deleteCode: string | null = null;
			try {
				await store.deleteIdleJob(job, { now });
			} catch (error) {
				deleteCode = (error as { code?: string }).code ?? 'thrown';
			}
			expect(deleteCode, leg.name).toBe(leg.running ? 'export.artifact_busy' : null);
			if (leg.running) {
				// the sweep keeps it too
				const report = await store.sweep({ now });
				expect(report.interrupted, leg.name).toBe(0);
				expect((await store.readManifest(job)).status).toBe('running');
			}
		}
	});

	test('the sweeper runs a pass and stops', async () => {
		const store = markedStore({ ttlHours: 1 });
		const { job } = await store.createJob(INIT);
		await store.updateManifest(job, {
			status: 'ended',
			ended_at: new Date(Date.now() - 5 * 3600_000).toISOString(),
		});
		const sweeper = startExportArtifactSweeper({ store, intervalMs: 3600_000 });
		const report = await sweeper.runOnce();
		sweeper.stop();
		expect(report?.deleted).toBe(1);
		expect(existsSync(job.dir)).toBe(false);
	});

	test('one pass at a time: the boot pass and an explicit runOnce share ONE report', async () => {
		// The boot timer (setTimeout 0) used to start a second pass beside an
		// explicit runOnce; whichever deleted the job first took the count, so
		// the caller read deleted 0 (GitHub db run 42460566815).
		const store = markedStore({ ttlHours: 1 });
		const { job } = await store.createJob(INIT);
		await store.updateManifest(job, {
			status: 'ended',
			ended_at: new Date(Date.now() - 5 * 3600_000).toISOString(),
		});
		const sweeper = startExportArtifactSweeper({ store, intervalMs: 3600_000 });
		const first = sweeper.runOnce();
		const joined = sweeper.runOnce();
		expect(joined).toBe(first);
		await new Promise((done) => setTimeout(done, 5)); // the boot timer fires mid-pass
		const report = await first;
		sweeper.stop();
		expect(report?.deleted).toBe(1);
		expect(existsSync(job.dir)).toBe(false);
	});
});

describe('F. the writer path', () => {
	const writerOptions = { origin: 'https://example.test', showTipoInLabel: false };

	test('the registry covers every export format exactly', () => {
		expect(Object.keys(EXPORT_WRITERS).sort()).toEqual([...EXPORT_FORMATS].sort());
	});

	test('ndjson download == the spool, byte for byte; recorded in the manifest', async () => {
		const store = markedStore();
		const { job } = await store.createJob(INIT);
		const lines = protocol(6, { subRowsOf: () => 2 });
		const stats = await (await spoolOf(store, job, lines)).close();
		await store.updateManifest(job, { status: 'ended', ended_at: new Date().toISOString() });
		const file = await buildArtifactFile({
			store,
			job,
			format: 'ndjson',
			options: writerOptions,
			signal: new AbortController().signal,
		});
		const built = readFileSync(join(job.dir, 'export.ndjson'), 'utf8');
		expect(built).toBe(serialize(lines));
		expect(file).toMatchObject({
			basename: 'export.ndjson',
			rows: stats.rows,
			bytes: Buffer.byteLength(built),
		});
		expect((await store.readManifest(job)).files['export.ndjson']?.rows).toBe(stats.rows);
		expect(await store.resolveArtifactFile(7, job.jobId, 'export.ndjson')).toBe(
			join(job.dir, 'export.ndjson'),
		);
	});

	test('a commit whose manifest write fails leaves NO final file behind (rename + record are one step)', async () => {
		const store = markedStore();
		const { job } = await store.createJob(INIT);
		await (await spoolOf(store, job, protocol(2))).close();
		await store.updateManifest(job, { status: 'ended', ended_at: new Date().toISOString() });
		const file = store.allocateFile(job, 'csv');
		const opened = await store.openFileSink(job, file);
		await opened.sink.write('a;b\n');
		// The fault: once the commit holds the manifest lock (its readManifest is
		// done), the root loses its declaration, so the manifest WRITE — and only it —
		// is refused. The rename to the final name has already happened by then.
		const marker = join(store.root, EXPORT_ARTIFACTS_TEST_MARKER);
		const lock = join(job.dir, 'manifest.json.lock');
		const probe = await open(join(job.dir, 'probe'), 'w');
		const proto = Object.getPrototypeOf(probe) as { close: () => Promise<void> };
		await probe.close();
		rmSync(join(job.dir, 'probe'));
		const realClose = proto.close;
		let sabotaged = false;
		proto.close = async function (this: unknown) {
			await realClose.call(this);
			if (!sabotaged && existsSync(lock)) {
				sabotaged = true;
				rmSync(marker);
			}
		};
		let caught: unknown = null;
		try {
			await opened.commit({ rows: 1 });
		} catch (error) {
			caught = error;
		} finally {
			proto.close = realClose;
			markExportArtifactsRoot(store.root);
		}
		expect(sabotaged).toBe(true);
		expect(isDedaloError(caught) && (caught as { code: string }).code).toBe(
			'export.store_unavailable',
		);
		// the final file is gone with the failure; the manifest never recorded it
		expect(existsSync(file.finalPath)).toBe(false);
		await opened.abort();
		expect(existsSync(file.tempPath)).toBe(false);
		const manifest = await store.readManifest(job);
		expect(manifest.files[file.basename]).toBeUndefined();
		expect(Object.keys(manifest.builds ?? {})).toEqual([]);
		// the job holds no unrecorded bytes: only the spool and the manifest remain
		expect(readdirSync(job.dir).filter((name) => name.startsWith('export'))).toEqual([]);
	});

	test('BUILT ONCE: the same file asked again is the committed one — no second walk, no new created_at; other options, or a file gone from disk, build', async () => {
		const store = markedStore();
		const { job } = await store.createJob(INIT);
		await (await spoolOf(store, job, protocol(4))).close();
		await store.updateManifest(job, { status: 'ended', ended_at: new Date().toISOString() });
		let walks = 0;
		const counting: ExportWriter = async (_input, sink) => {
			walks++;
			await sink.write(`walk ${walks}\n`);
			return { bytes: sink.bytes, rows: walks };
		};
		const build = (options: ExportWriterOptions, writer = counting) =>
			buildArtifactFile({
				store,
				job,
				format: 'csv',
				options,
				signal: new AbortController().signal,
				writer,
			});
		const first = await build(writerOptions);
		expect(walks).toBe(1);
		await Bun.sleep(5);
		const again = await build(writerOptions);
		expect(walks).toBe(1);
		expect(again).toEqual(first);
		expect(readFileSync(join(job.dir, first.basename), 'utf8')).toBe('walk 1\n');
		expect((await store.readManifest(job)).files[first.basename]?.created_at).toBe(
			first.created_at,
		);
		// other options: another name, another walk
		const other = await build({ ...writerOptions, showTipoInLabel: true });
		expect(walks).toBe(2);
		expect(other.basename).not.toBe(first.basename);
		// a gate knob changes the bytes, so it changes the name too
		const knobbed = await build({ ...writerOptions, sheetRowCap: 3 });
		expect(walks).toBe(3);
		expect(knobbed.basename).not.toBe(first.basename);
		// the committed file gone from disk: built again
		rmSync(join(job.dir, first.basename));
		const rebuilt = await build(writerOptions);
		expect(walks).toBe(4);
		expect(rebuilt.basename).toBe(first.basename);
		expect(readFileSync(join(job.dir, first.basename), 'utf8')).toBe('walk 4\n');
	});

	test('the file NAME is a function of every option that changes its bytes: a rebuild with other options never replaces the first file', async () => {
		const store = markedStore();
		const { job } = await store.createJob(INIT);
		// columns that carry their ontology path, so show_tipo_in_label changes the header
		const lines = protocol(3).map((line) =>
			line.t === 'col' && line.key !== 'id'
				? { ...line, path: [{ component_tipo: line.key }] }
				: line,
		);
		await (await spoolOf(store, job, lines)).close();
		await store.updateManifest(job, { status: 'ended', ended_at: new Date().toISOString() });
		const buildCsv = (options: { origin: string; showTipoInLabel: boolean }) =>
			buildArtifactFile({
				store,
				job,
				format: 'csv',
				options,
				signal: new AbortController().signal,
			});
		const plain = await buildCsv(writerOptions);
		const plainBytes = readFileSync(join(job.dir, plain.basename));
		const tipo = await buildCsv({ ...writerOptions, showTipoInLabel: true });
		const otherOrigin = await buildCsv({ ...writerOptions, origin: 'https://other.test' });
		for (const file of [plain, tipo, otherOrigin]) {
			expect(file.basename).toMatch(/^export_[0-9a-f]{12}\.csv$/);
			expect(isDownloadableArtifactName(file.basename)).toBe(true);
		}
		expect(new Set([plain.basename, tipo.basename, otherOrigin.basename]).size).toBe(3);
		// the first file (and so the URL a client cached for it) still holds its own bytes
		expect(readFileSync(join(job.dir, plain.basename)).equals(plainBytes)).toBe(true);
		expect(readFileSync(join(job.dir, tipo.basename)).equals(plainBytes)).toBe(false);
		// the same options again land on the same name (a rebuild, not a new file)
		expect((await buildCsv(writerOptions)).basename).toBe(plain.basename);
		expect(Object.keys((await store.readManifest(job)).files).sort()).toEqual(
			[plain.basename, tipo.basename, otherOrigin.basename].sort(),
		);
		// ndjson is option-independent: one name
		expect(artifactFileVariant('ndjson', writerOptions)).toBeUndefined();
		expect(
			artifactFileVariant('ndjson', { ...writerOptions, showTipoInLabel: true }),
		).toBeUndefined();
		for (const format of ['csv', 'tsv', 'html', 'xlsx', 'ods'] as const) {
			expect(artifactFileVariant(format, writerOptions)).not.toBe(
				artifactFileVariant(format, { ...writerOptions, showTipoInLabel: true }),
			);
		}
	});

	test('a caller-chosen option cannot grow the files without bound: past MAX_FILES_PER_FORMAT the OLDEST of the format is evicted', async () => {
		const store = markedStore();
		const { job } = await store.createJob(INIT);
		await (await spoolOf(store, job, protocol(2))).close();
		await store.updateManifest(job, { status: 'ended', ended_at: new Date().toISOString() });
		const built: string[] = [];
		const total = MAX_FILES_PER_FORMAT + 3;
		for (let n = 1; n <= total; n++) {
			const file = await buildArtifactFile({
				store,
				job,
				format: 'csv',
				// every distinct origin is a distinct file name (artifactFileVariant)
				options: { ...writerOptions, origin: `http://host.test:${1000 + n}` },
				signal: new AbortController().signal,
			});
			built.push(file.basename);
		}
		expect(new Set(built).size).toBe(total);
		const files = (await store.readManifest(job)).files;
		const csvs = Object.values(files).filter((file) => file.format === 'csv');
		expect(csvs.length).toBe(MAX_FILES_PER_FORMAT);
		// the NEWEST ones kept, the oldest gone from the manifest AND the disk
		expect(csvs.map((file) => file.basename).sort()).toEqual(
			built.slice(-MAX_FILES_PER_FORMAT).sort(),
		);
		for (const evicted of built.slice(0, total - MAX_FILES_PER_FORMAT)) {
			expect(existsSync(join(job.dir, evicted)), evicted).toBe(false);
		}
		// another format is not charged for csv's files
		const ndjson = await buildArtifactFile({
			store,
			job,
			format: 'ndjson',
			options: writerOptions,
			signal: new AbortController().signal,
		});
		expect(Object.keys((await store.readManifest(job)).files)).toContain(ndjson.basename);
		expect(filesPastFormatBound({}, csvs[0] as never)).toEqual([]);
	});

	test('the NDJSON download IS the ended spool: hard-linked into place, never a second copy against the quota', async () => {
		const store = markedStore();
		const { job } = await store.createJob(INIT);
		await (await spoolOf(store, job, protocol(400))).close();
		await store.updateManifest(job, { status: 'ended', ended_at: new Date().toISOString() });
		const grid = join(job.dir, SPOOL_FILES.grid);
		const gridBytes = statSync(grid).size;
		expect(gridBytes).toBeGreaterThan(20_000);
		const before = await store.usedBytes(INIT.userId);
		const file = await buildArtifactFile({
			store,
			job,
			format: 'ndjson',
			options: writerOptions,
			signal: new AbortController().signal,
		});
		const served = join(job.dir, file.basename);
		// the same inode: the bytes exist once
		expect(statSync(served).ino).toBe(statSync(grid).ino);
		expect(readFileSync(served).equals(readFileSync(grid))).toBe(true);
		expect(file.bytes).toBe(gridBytes);
		expect(file.rows).toBe(400);
		// the quota measure counts the inode once (only the manifest grew)
		const after = await store.usedBytes(INIT.userId);
		expect(after - before).toBeLessThan(2048);
		// and it is the exact file the copying writer would have written
		const copied = await buildArtifactFile({
			store,
			job,
			format: 'ndjson',
			options: { ...writerOptions, copyKnob: 1 },
			signal: new AbortController().signal,
			writer: ndjsonWriter,
		});
		expect(readFileSync(join(job.dir, copied.basename)).equals(readFileSync(grid))).toBe(true);
		expect(copied.rows).toBe(file.rows);
	});

	test('not ended → export.artifact_not_ready, nothing built', async () => {
		const store = markedStore();
		const { job } = await store.createJob(INIT);
		await (await spoolOf(store, job, protocol(2).slice(0, -1))).close();
		await expectCode(
			buildArtifactFile({
				store,
				job,
				format: 'ndjson',
				options: writerOptions,
				signal: new AbortController().signal,
			}),
			'export.artifact_not_ready',
		);
		// status says ended but the spool has no 'end' line: still not ready
		await store.updateManifest(job, { status: 'ended' });
		await expectCode(
			buildArtifactFile({
				store,
				job,
				format: 'ndjson',
				options: writerOptions,
				signal: new AbortController().signal,
			}),
			'export.artifact_not_ready',
		);
		expect(readdirSync(job.dir).sort()).toEqual(
			[
				SPOOL_FILES.cols,
				SPOOL_FILES.grid,
				SPOOL_FILES.index,
				SPOOL_FILES.manifest,
				SPOOL_FILES.request,
			].sort(),
		);
	});

	test('a whole spool is still not buildable unless the MANIFEST says ended (running/cancelled/failed)', async () => {
		const store = markedStore();
		const { job } = await store.createJob(INIT);
		await (await spoolOf(store, job, protocol(3))).close();
		for (const status of ['running', 'cancelled', 'failed', 'interrupted'] as const) {
			await store.updateManifest(job, { status });
			await expectCode(
				buildArtifactFile({
					store,
					job,
					format: 'ndjson',
					options: writerOptions,
					signal: new AbortController().signal,
				}),
				'export.artifact_not_ready',
			);
		}
		expect(existsSync(join(job.dir, 'export.ndjson'))).toBe(false);
	});

	test('a torn last line (crash mid-write) is never read as the end line', async () => {
		const store = markedStore();
		const { job } = await store.createJob(INIT);
		const lines = protocol(2);
		const whole = serialize(lines);
		// the end line's bytes are all there but its '\n' is not (plus one torn byte): unterminated
		writeFileSync(join(job.dir, SPOOL_FILES.grid), `${whole.slice(0, -1)} `);
		const reader = openSpoolReader(job.dir, { indexEvery: 3 });
		expect(await reader.readEnd()).toBeNull();
		const seen: unknown[] = [];
		for await (const line of reader.lines()) seen.push(line);
		expect(seen).toEqual(lines.slice(0, -1));
		writeFileSync(join(job.dir, SPOOL_FILES.grid), whole);
		expect(await reader.readEnd()).toEqual(lines.at(-1) as never);
	});

	test('a cancelled or over-quota build leaves no file and no temp', async () => {
		const store = markedStore({ quotaBytes: 200_000 });
		const { job } = await store.createJob(INIT);
		await (await spoolOf(store, job, protocol(40))).close();
		await store.updateManifest(job, { status: 'ended' });
		const before = readdirSync(job.dir).sort();

		const controller = new AbortController();
		const cancelling: ExportWriter = async (_input, sink, signal) => {
			await sink.write('half a file');
			controller.abort();
			const { throwIfCancelled } = await import('../../tools/tool_export/server/writers/types.ts');
			throwIfCancelled(signal);
			return { bytes: sink.bytes, rows: 0 };
		};
		await expectCode(
			buildArtifactFile({
				store,
				job,
				format: 'csv',
				options: writerOptions,
				signal: controller.signal,
				writer: cancelling,
			}),
			'export.cancelled',
		);
		expect(readdirSync(job.dir).sort()).toEqual(before);

		const flooding: ExportWriter = async (_input, sink) => {
			for (let i = 0; i < 1000; i++) await sink.write('w'.repeat(1024));
			return { bytes: sink.bytes, rows: 0 };
		};
		await expectCode(
			buildArtifactFile({
				store,
				job,
				format: 'csv',
				options: writerOptions,
				signal: new AbortController().signal,
				writer: flooding,
			}),
			'export.artifact_quota',
		);
		expect(readdirSync(job.dir).sort()).toEqual(before);
		expect((await store.readManifest(job)).files).toEqual({});
	});

	test('a cleanup that fails never replaces the build error (Stop stays export.cancelled)', async () => {
		const store = markedStore();
		const { job } = await store.createJob(INIT);
		await (await spoolOf(store, job, protocol(3))).close();
		await store.updateManifest(job, { status: 'ended' });
		let aborts = 0;
		// The lease release under the manifest lock throws (lock still held, ENOSPC…).
		const failingCleanup: ArtifactStore = {
			...store,
			async openFileSink(ref, file) {
				const opened = await store.openFileSink(ref, file);
				return {
					...opened,
					async abort() {
						aborts++;
						await opened.abort();
						throw new DedaloError('export.store_unavailable', { message: 'lock held' });
					},
				};
			},
		};
		const controller = new AbortController();
		const cancelling: ExportWriter = async (_input, sink, signal) => {
			await sink.write('half a file');
			controller.abort();
			const { throwIfCancelled } = await import('../../tools/tool_export/server/writers/types.ts');
			throwIfCancelled(signal);
			return { bytes: sink.bytes, rows: 0 };
		};
		await expectCode(
			buildArtifactFile({
				store: failingCleanup,
				job,
				format: 'csv',
				options: writerOptions,
				signal: controller.signal,
				writer: cancelling,
			}),
			'export.cancelled',
		);
		expect(aborts).toBe(1);
	});

	test('assertFormatLimit refuses past the ceiling with the format and the limit', async () => {
		assertFormatLimit('xlsx', 16384, 16384);
		await expectCode(() => assertFormatLimit('xlsx', 16385, 16384), 'export.format_limit');
		try {
			assertFormatLimit('ods', 20000, 16384);
		} catch (error) {
			expect((error as { details?: unknown }).details).toEqual({ format: 'ods', limit: 16384 });
		}
	});
});

describe('G. the export lane + config', () => {
	test('export is a lane: budget 1 and NO deadline by default', () => {
		expect(JOB_LANES).toContain('export');
		const manager = new MediaJobManager({});
		expect(manager.laneDepths().export).toEqual({ active: 0, queued: 0, max: 1 });
		const record = manager.submit('export_probe', async () => 'done', {
			lane: 'export',
			userId: 7,
		});
		expect(record.lane).toBe('export');
		expect(record.deadline_ms).toBe(0);
	});

	test('export_file is a lane of its own: budget 2 and NO deadline by default', () => {
		expect(JOB_LANES).toContain('export_file');
		const manager = new MediaJobManager({});
		expect(manager.laneDepths().export_file).toEqual({ active: 0, queued: 0, max: 2 });
		const record = manager.submit('export_file_probe', async () => 'done', {
			lane: 'export_file',
			userId: 7,
		});
		expect(record.lane).toBe('export_file');
		expect(record.deadline_ms).toBe(0);
	});

	test('config defaults and the preview page-size clamp', () => {
		expect(config.ops.exportArtifactsTtlHours).toBeGreaterThanOrEqual(1);
		expect(config.ops.exportArtifactsQuotaBytes).toBeGreaterThanOrEqual(0);
		expect(config.ops.exportPreviewPageSize).toBeGreaterThanOrEqual(1);
		expect(config.ops.exportPreviewPageSize).toBeLessThanOrEqual(200);
		expect(clampPageSize(500)).toBe(200);
		expect(clampPageSize(0)).toBe(config.ops.exportPreviewPageSize);
		expect(clampPageSize('abc')).toBe(config.ops.exportPreviewPageSize);
		expect(clampPageSize(37.9)).toBe(37);
		expect(DEFAULT_INDEX_EVERY).toBeGreaterThan(0);
	});
});

describe('H. the manifest lock: a stale takeover admits ONE holder, a release removes only its own lock', () => {
	test('a waiter whose stale verdict lands after another waiter took the dead lock over does not join it', async () => {
		const store = markedStore();
		const { job } = await store.createJob({ ...INIT, jobId: 'stale_lock_race' });
		const lock = join(job.dir, 'manifest.json.lock');
		writeFileSync(lock, 'a-dead-holder');
		const longAgo = new Date(Date.now() - 3_600_000);
		utimesSync(lock, longAgo, longAgo);
		let active = 0;
		let peak = 0;
		const inside = async (): Promise<void> => {
			active++;
			peak = Math.max(peak, active);
			await Bun.sleep(100);
			active--;
		};
		// C judges the dead lock stale, then (pinned) B takes it over and is
		// inside before C acts on its verdict.
		let firstInside: () => void = () => {};
		const bInside = new Promise<void>((resolve) => {
			firstInside = resolve;
		});
		const c = withManifestLock(job.dir, inside, { beforeTakeover: () => bInside });
		await Bun.sleep(10);
		const b = withManifestLock(job.dir, async () => {
			firstInside();
			await inside();
		});
		await Promise.all([b, c]);
		expect(peak).toBe(1);
		// Nothing left behind: no lock, no breaker, no lock temp.
		expect(readdirSync(job.dir).filter((name) => name.startsWith('manifest.json.lock'))).toEqual(
			[],
		);
	});

	test('several concurrent waiters on one planted stale lock hold it one at a time', async () => {
		const store = markedStore();
		const { job } = await store.createJob({ ...INIT, jobId: 'stale_lock_many' });
		const lock = join(job.dir, 'manifest.json.lock');
		writeFileSync(lock, 'a-dead-holder');
		const longAgo = new Date(Date.now() - 3_600_000);
		utimesSync(lock, longAgo, longAgo);
		let active = 0;
		let peak = 0;
		let entered = 0;
		await Promise.all(
			Array.from({ length: 8 }, () =>
				withManifestLock(job.dir, async () => {
					active++;
					entered++;
					peak = Math.max(peak, active);
					await Bun.sleep(5);
					active--;
				}),
			),
		);
		expect(entered).toBe(8);
		expect(peak).toBe(1);
	});

	test('a YOUNG dead lock (a holder killed mid-update) is taken over by the first waiter — the wait outlives the stale age', async () => {
		expect(manifestLockWaitMs(MANIFEST_LOCK_STALE_MS)).toBeGreaterThan(MANIFEST_LOCK_STALE_MS);
		const store = markedStore();
		const { job } = await store.createJob({ ...INIT, jobId: 'young_dead_lock' });
		const lock = join(job.dir, 'manifest.json.lock');
		// Planted NOW (mtime fresh): a restart meets a lock only seconds old.
		writeFileSync(lock, 'a-holder-killed-a-moment-ago');
		let entered = false;
		// Only the stale age is given: the wait is the store's own default for it.
		await withManifestLock(
			job.dir,
			async () => {
				entered = true;
			},
			{ staleMs: 300 },
		);
		expect(entered).toBe(true);
		expect(existsSync(lock)).toBe(false);
	});

	test('a holder that overran the stale age and was taken over does not delete its successor', async () => {
		const store = markedStore();
		const { job } = await store.createJob({ ...INIT, jobId: 'overran_lock' });
		const lock = join(job.dir, 'manifest.json.lock');
		const timing = { staleMs: 150, waitMs: 5_000 };
		let successorLockSurvived = null as boolean | null;
		const slow = withManifestLock(job.dir, () => Bun.sleep(400), timing);
		await Bun.sleep(10);
		const successor = withManifestLock(
			job.dir,
			async () => {
				// The slow holder releases while the successor is still inside.
				await Bun.sleep(500);
				successorLockSurvived = existsSync(lock);
			},
			timing,
		);
		await Promise.all([slow, successor]);
		expect(successorLockSurvived).toBe(true);
		expect(existsSync(lock)).toBe(false);
	});
});
