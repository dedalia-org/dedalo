/**
 * TOOL_EXPORT JOB + PREVIEW — behavioural gate of the server-built export
 * (tools/tool_export/server/{export_job,preview}.ts; tool_export at scale,
 * plan step 5). Every claim is measured on OUTCOMES: spool bytes, pages, what
 * a refusal leaves on disk.
 *
 *  A. THE SPOOL IS THE STREAM. A job run as a NON-ADMIN outside any request
 *     (no request context — only the lang scope the job manager lets it
 *     inherit) writes grid.ndjson byte-for-byte equal to the get_export_grid
 *     NDJSON stream the same user gets INSIDE a request, and to the
 *     `openExportGrid` lines serialized directly; a contrary ambient scope
 *     (a global-admin request principal, decoy langs) and hydrate/checkpoint
 *     batches of 1 do not move a byte. cols.ndjson is the col lines; the
 *     manifest records the end (counts, end.columns, the live notes).
 *  B. PREVIEW PAGING. Pages are in RECORDS: every page size walks the whole
 *     spool exactly once, a record's sub-rows never straddle a page, and the
 *     page size is clamped server-side (1..200, default from config).
 *  C. WHILE RUNNING. Paused at a checkpoint, the preview serves exactly the
 *     records written so far (a prefix of the final rows), in the live column
 *     order, status 'running'.
 *  D. CANCEL. A stop deletes the partial spool, marks the manifest cancelled
 *     and finishes with export.cancelled; a file cannot be built from it.
 *  D2. NOT EVERY ABORT IS A STOP. Through a real MediaJobManager: the lane
 *     deadline records 'failed' + export.deadline_exceeded {limit_s}, a
 *     graceful shutdown (interruptLive) 'interrupted', and only the user's
 *     stop 'cancelled'.
 *  E. QUOTA. Overflowing mid-spool fails with export.artifact_quota and
 *     deletes the partial spool; an owner already over quota is refused before
 *     any job directory exists.
 *  F. OWNER-ONLY. Through the real handlers: the owner previews, lists and
 *     builds a file (the URL is the download route, the bytes the spool);
 *     another user — a global admin included — gets export.artifact_not_found
 *     for the preview and the file, and does not see the job in its list.
 *     The owner REMOVED FROM THE PROJECT after the build (every grant kept)
 *     loses the preview, the file build and the list: the export is bound to
 *     the record scope its walk ran under (manifest.record_scope).
 *  H. THE RE-CHECK IS THE BUILD GATE. A path section held on the component
 *     grant alone (all Gate B asks) keeps the export open for its owner, and
 *     so does a global admin's Gate-B exemption; revoking ONLY the second
 *     hop's grant closes preview, file and list.
 *  I. REFUSALS. An unreadable sqo section or Gate-B column leaves no job
 *     directory; a spool refused after the job exists marks it failed.
 *  L. THE OWNER'S DELETE (delete_export_job). Through the real handler: another
 *     user (a global admin included) and the owner under another section get
 *     not_found and nothing is removed; the owner's delete removes the whole
 *     directory (spool + built file), answers the bytes it held, and the list
 *     no longer shows it. The freed bytes are REAL quota: an export refused at
 *     the full quota succeeds after the delete. A running export, and an ended
 *     one a file build holds a live lease on, answer export.artifact_busy and
 *     keep every byte; a foreign 'running' manifest whose owner is dead is
 *     deletable, one whose owner lives and heartbeats is busy.
 *  N. A DOWNLOAD NEVER WAITS BEHIND A WALK. With the `export` lane FULL (every
 *     slot held by another user's export), the owner's file build is scheduled
 *     through the real module and RUNS at once — it is on a lane of its own
 *     (`export_file`), not queued FIFO behind a multi-hour walk.
 *  M. A FAILED FINALIZATION ENDS THE JOB. The final spool close failing
 *     (ENOSPC on the last flush) or the terminal 'ended' manifest write failing
 *     leaves the job 'failed' with its spool deleted — never 'running' for the
 *     rest of the boot. If the failure write fails TOO, the manifest says
 *     'running' but its lane job is gone: reported interrupted, swept and
 *     deletable without a restart (a direct writer with no lane job stays live).
 *
 * SITUATION (generic `test` TLD, BUILT here, swept in afterAll): a non-admin
 * (profile granting test3 and its components at read level, one project) and
 * scratch test3 records carrying that project — SOURCES whose test80 portal
 * points at one to three TARGETS, so breakdown 'rows' yields sub-rows. Export
 * roots: a scratch root this file DECLARES (the export test marker) and, for
 * the handler legs, the suite's derived default root (itself vouched for by
 * the marked suite media root); every job this file creates is deleted.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
	appendFileSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmdirSync,
	rmSync,
	statSync,
	truncateSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../../src/config/config.ts';
import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { deleteMatrixRecord } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { DedaloError, isDedaloError, ok, specOf } from '../../src/core/errors/index.ts';
import { MediaJobManager } from '../../src/core/media/jobs.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';
import { clearUserFilterRecordsCache } from '../../src/core/security/filter_records.ts';
import {
	clearPermissionsCache,
	clearPrincipalCache,
	clearUserProjectsCache,
	getPermissions,
	type Principal,
	resolvePrincipal,
} from '../../src/core/security/permissions.ts';
import {
	type RequestContext,
	runWithRequestContext,
} from '../../src/core/security/request_context.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import type { ToolActionContext } from '../../src/core/tools/module.ts';
import { exportGridUnified, openExportGrid } from '../../src/diffusion/export/index.ts';
import {
	type ExportReadCheckMemo,
	exportRecordScope,
	exportStillReadable,
} from '../../tools/tool_export/server/access.ts';
import {
	type ArtifactJobRef,
	type ArtifactStore,
	type ExportManifest,
	MANIFEST_OPTIONS_MAX_BYTES,
	openArtifactStore,
	SPOOL_FILES,
	STORE_BOOT_ID,
} from '../../tools/tool_export/server/artifact_store.ts';
import {
	admitExportFileJob,
	admitExportJob,
	EXPORT_MANIFEST_OPTION_KEYS,
	type ExportArtifactRun,
	type ExportProgress,
	exportFileLaneShare,
	listOwnedExportJobs,
	runBuildExportFile,
	runDeleteExportJob,
	runExportArtifact,
	summarizeJob,
	summarizeJobError,
	toolExportBuildArtifact,
	toolExportBuildFile,
	toolExportDeleteJob,
	toolExportListJobs,
	validOrigin,
} from '../../tools/tool_export/server/export_job.ts';
import {
	previewCell,
	readExportPreview,
	toolExportGetPreview,
	windowRow,
} from '../../tools/tool_export/server/preview.ts';
import {
	PREVIEW_CELL_MAX_CHARS,
	PREVIEW_COLUMN_BUDGET,
	PREVIEW_PAGE_SIZE_MAX,
	type SpoolColLine,
} from '../../tools/tool_export/server/spool_reader.ts';
import { markExportArtifactsRoot, markProcessesDir } from '../helpers/media_scratch_root.ts';

// --- the situation ----------------------------------------------------------

const SECTION = 'test3';
const TABLE = 'matrix_test';
const TEXT = 'test52'; // component_input_text, translatable
const PORTAL = 'test80'; // component_portal → the fan-out
const FILTER = 'test101'; // component_filter (projects)
const DENIED = 'test166'; // component_input_text the reader holds NO grant on

const USER_ID = 946201;
const PROFILE_ID = 946211;
const PROJECT_ID = 946221;
const TARGET_IDS = [946311, 946312, 946313];
const SOURCE_IDS = [946301, 946302, 946303, 946304, 946305, 946306, 946307];
/** The H leg's runtime-frontier source (test3) and target (test2, a section
 * the declared path never names). */
const RUNTIME_SOURCE_ID = 946308;
const RUNTIME_TARGET_ID = 946331;
const OWNED_TEST3 = [...SOURCE_IDS, RUNTIME_SOURCE_ID, ...TARGET_IDS];
const IDENTITY_ROWS = [
	{ table: 'matrix_users', sectionTipo: 'dd128', sectionId: USER_ID },
	{ table: 'matrix_profiles', sectionTipo: 'dd234', sectionId: PROFILE_ID },
	{ table: 'matrix_projects', sectionTipo: 'dd153', sectionId: PROJECT_ID },
];
const DATA_LANG = 'lg-spa';

const locator = (from: string, sectionTipo: string, sectionId: number, id = 1) => ({
	id,
	type: 'dd151',
	section_id: sectionId,
	section_tipo: sectionTipo,
	from_component_tipo: from,
});
const bilingual = (spa: string, eng: string) => [
	{ id: 1, lang: 'lg-spa', value: spa },
	{ id: 1, lang: 'lg-eng', value: eng },
];
const projectSlot = { [FILTER]: [locator(FILTER, 'dd153', PROJECT_ID)] };

async function insertRow(
	table: string,
	sectionTipo: string,
	sectionId: number,
	columns: Record<string, unknown>,
): Promise<void> {
	const names = ['"section_tipo"', '"section_id"'];
	const placeholders = ['$1', '$2'];
	const params: (string | number)[] = [sectionTipo, sectionId];
	for (const [column, value] of Object.entries(columns)) {
		names.push(`"${column}"`);
		// ::text::jsonb — a bare ::jsonb bind stores a jsonb STRING scalar.
		placeholders.push(`$${params.length + 1}::text::jsonb`);
		params.push(encodeForJsonb(value));
	}
	await sql.unsafe(
		`INSERT INTO "${table}" (${names.join(', ')}) VALUES (${placeholders.join(', ')})`,
		params,
	);
}

function clearCaches(): void {
	clearPrincipalCache();
	clearUserProjectsCache();
	clearPermissionsCache();
}

async function sweepRows(): Promise<void> {
	for (const row of [
		...IDENTITY_ROWS,
		...OWNED_TEST3.map((sectionId) => ({ table: TABLE, sectionTipo: SECTION, sectionId })),
		{
			table: (await getMatrixTableFromTipo('test2')) ?? TABLE,
			sectionTipo: 'test2',
			sectionId: RUNTIME_TARGET_ID,
		},
	]) {
		await deleteMatrixRecord(row.table, row.sectionTipo, row.sectionId);
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[row.sectionTipo, row.sectionId],
		);
	}
	clearCaches();
}

/** Every component tipo of the test3 subtree — the reader is granted all at 1. */
async function test3ComponentTipos(): Promise<string[]> {
	const rows = (await sql.unsafe(
		`WITH RECURSIVE t AS (
			SELECT tipo, model FROM dd_ontology WHERE parent = $1
			UNION ALL SELECT o.tipo, o.model FROM dd_ontology o JOIN t ON o.parent = t.tipo)
		 SELECT tipo FROM t WHERE model LIKE 'component_%'`,
		[SECTION],
	)) as { tipo: string }[];
	return rows.map((row) => row.tipo);
}

// --- export roots -----------------------------------------------------------

const scratchDirs: string[] = [];

/** A fresh DECLARED scratch export root + store. */
function scratchStore(quotaBytes = 0): ArtifactStore {
	const dir = mkdtempSync(join(tmpdir(), 'dedalo_export_job_'));
	scratchDirs.push(dir);
	const root = markExportArtifactsRoot(join(dir, 'artifacts'));
	return openArtifactStore({ root, quotaBytes, ttlHours: 24 });
}

/** Jobs created in the suite's DEFAULT root (the handler legs) — deleted in afterAll. */
const defaultRootJobs: { userId: number; jobId: string }[] = [];

let reader!: Principal;
let root!: Principal;
let readerGrants: Record<string, unknown>[] = [];

/** Rewrite the reader profile's dd774 grants (the revocation legs), caches cleared. */
async function setReaderGrants(grants: Record<string, unknown>[]): Promise<void> {
	await sql.unsafe(
		'UPDATE "matrix_profiles" SET misc = $1::text::jsonb WHERE section_tipo = $2 AND section_id = $3',
		[encodeForJsonb({ dd774: grants }), 'dd234', PROFILE_ID],
	);
	clearCaches();
}
const APP_LANG = config.menu.applicationLang;

beforeAll(async () => {
	await assertTestDatabase('tool_export_job_native');
	await sweepRows();

	await insertRow('matrix_projects', 'dd153', PROJECT_ID, {
		string: { dd156: [{ id: 1, lang: 'lg-eng', value: 'zzexpjob scratch project' }] },
	});
	const tipos = await test3ComponentTipos();
	expect(tipos).toContain(TEXT);
	expect(tipos).toContain(PORTAL);
	expect(tipos).toContain(DENIED);
	readerGrants = [SECTION, ...tipos.filter((tipo) => tipo !== DENIED)].map((tipo, index) => ({
		id: index + 1,
		tipo,
		section_tipo: SECTION,
		value: 1,
	}));
	await insertRow('matrix_profiles', 'dd234', PROFILE_ID, {
		string: { dd237: [{ id: 1, lang: 'lg-eng', value: 'zzexpjob reader profile' }] },
		misc: { dd774: readerGrants },
	});
	await insertRow('matrix_users', 'dd128', USER_ID, {
		string: { dd132: [{ id: 1, lang: 'lg-nolan', value: 'zzexpjob_reader' }] },
		relation: {
			dd131: [locator('dd131', 'dd64', 1)],
			dd244: [locator('dd244', 'dd64', 2)],
			dd515: [locator('dd515', 'dd64', 2)],
			dd1725: [locator('dd1725', 'dd234', PROFILE_ID)],
			dd170: [locator('dd170', 'dd153', PROJECT_ID)],
		},
	});
	for (const [k, targetId] of TARGET_IDS.entries()) {
		await insertRow(TABLE, SECTION, targetId, {
			string: { [TEXT]: bilingual(`Destino ${k}`, `Target ${k}`) },
			relation: { ...projectSlot },
		});
	}
	for (const [j, sourceId] of SOURCE_IDS.entries()) {
		// 1, 2, 3, 1, 2, 3, 1 targets: records of different sub-row counts.
		const targets = TARGET_IDS.slice(0, (j % TARGET_IDS.length) + 1);
		await insertRow(TABLE, SECTION, sourceId, {
			string: { [TEXT]: bilingual(`Origen ${j}`, `Source ${j}`) },
			relation: {
				...projectSlot,
				[PORTAL]: targets.map((target, index) => locator(PORTAL, SECTION, target, index + 1)),
			},
		});
	}
	clearCaches();
	reader = await resolvePrincipal(USER_ID);
	expect(reader.isGlobalAdmin).toBe(false);
	root = await resolvePrincipal(-1);
	expect(root.isGlobalAdmin).toBe(true);
});

afterAll(async () => {
	const store = openArtifactStore();
	for (const { userId, jobId } of defaultRootJobs) {
		await store.deleteJob(store.jobRef(userId, jobId));
	}
	// The owner directory this file created (rmdir: only when it is empty).
	for (const owner of new Set([USER_ID, ...defaultRootJobs.map((job) => job.userId)])) {
		try {
			rmdirSync(join(store.root, String(owner)));
		} catch {
			// not empty (another run's job) or already gone — never forced
		}
	}
	for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
	await assertTestDatabase('tool_export_job_native');
	await sweepRows();
});

// --- shared pieces ----------------------------------------------------------

const exportOptions = (): Record<string, unknown> => ({
	section_tipo: SECTION,
	data_format: 'grid_value',
	breakdown: 'rows',
	lang: DATA_LANG,
	ar_ddo_to_export: [
		{ path: [{ section_tipo: SECTION, component_tipo: TEXT, name: TEXT }] },
		{
			path: [
				{ section_tipo: SECTION, component_tipo: PORTAL, name: PORTAL },
				{ section_tipo: SECTION, component_tipo: TEXT, name: TEXT },
			],
		},
	],
	sqo: {
		section_tipo: [SECTION],
		filter_by_locators: SOURCE_IDS.map((id) => ({ section_tipo: SECTION, section_id: id })),
	},
});

type Line = Record<string, unknown>;

/** The get_export_grid NDJSON body the reader gets INSIDE a request. */
async function inRequestStream(): Promise<string> {
	return runWithRequestContext(
		{ principal: reader, session: null, requestId: 'zzexpjob-req', clientIp: '' },
		() =>
			runWithRequestLangs({ applicationLang: APP_LANG, dataLang: DATA_LANG }, async () => {
				const response = (await exportGridUnified({
					principal: reader,
					userId: USER_ID,
					background: false,
					options: { ...exportOptions(), ndjson_stream: true },
				} as ToolActionContext)) as unknown as { ok: boolean; stream: ReadableStream };
				expect(response.ok).toBe(true);
				return new Response(response.stream).text();
			}),
	);
}

/** A job run with no request context (the detached shape), on `store`. */
function jobRun(store: ArtifactStore, extra: Partial<ExportArtifactRun> = {}): ExportArtifactRun {
	return {
		store,
		principal: reader,
		userId: USER_ID,
		options: exportOptions(),
		applicationLang: APP_LANG,
		...extra,
	};
}

const spoolText = (store: ArtifactStore, jobId: string, name: string): string =>
	readFileSync(join(store.jobRef(USER_ID, jobId).dir, name), 'utf8');

const parseLines = (text: string): Line[] =>
	text
		.split('\n')
		.filter((line) => line !== '')
		.map((line) => JSON.parse(line) as Line);

async function expectCode(promise: Promise<unknown>, code: string): Promise<unknown> {
	let caught: unknown = null;
	try {
		await promise;
	} catch (error) {
		caught = error;
	}
	expect(isDedaloError(caught), `expected DedaloError ${code}, got ${String(caught)}`).toBe(true);
	expect((caught as { code: string }).code).toBe(code);
	return caught;
}

/** The job manager's pfile directory seam (a test must never write ../private/processes). */
const PROCESSES_DIR_KEY = 'DEDALO_MEDIA_PROCESSES_DIR';
function readProcessesDirOverride(): string | undefined {
	return process.env[PROCESSES_DIR_KEY];
}
function setProcessesDirOverride(value: string | undefined): void {
	if (value === undefined) Reflect.deleteProperty(process.env, PROCESSES_DIR_KEY);
	else process.env[PROCESSES_DIR_KEY] = markProcessesDir(value);
}

let baseline!: string;
let baselineRows!: Line[];

// --- A. the spool is the stream ----------------------------------------------

describe('A. the spool is the get_export_grid stream, byte for byte', () => {
	test('non-admin job outside a request === in-request stream === openExportGrid lines', async () => {
		baseline = await inRequestStream();
		const lines = parseLines(baseline);
		baselineRows = lines.filter((line) => line.t === 'row');
		// Non-vacuous: every source is a record, and the breakdown fans out.
		expect(baselineRows.filter((row) => row.sub === 0).length).toBe(SOURCE_IDS.length);
		expect(baselineRows.some((row) => Number(row.sub) > 0)).toBe(true);
		expect(baseline).toContain('Origen 0');
		expect(baseline).toContain('Destino 2');

		// The producer, serialized directly (no request, explicit identity).
		const grid = await openExportGrid({
			principal: reader,
			options: exportOptions(),
			applicationLang: APP_LANG,
		});
		let direct = '';
		for await (const line of grid.lines) direct += `${JSON.stringify(line)}\n`;
		expect(direct).toBe(baseline);

		// The job: NO request context, only the inherited lang scope.
		const store = scratchStore();
		const frames: ExportProgress[] = [];
		const summary = await runWithRequestLangs(
			{ applicationLang: APP_LANG, dataLang: DATA_LANG },
			() => runExportArtifact(jobRun(store, { publishProgress: (frame) => frames.push(frame) })),
		);
		expect(spoolText(store, summary.job_id, SPOOL_FILES.grid)).toBe(baseline);

		// cols.ndjson is exactly the col lines, in stream order.
		const colsExpected = lines
			.filter((line) => line.t === 'col')
			.map((line) => `${JSON.stringify(line)}\n`)
			.join('');
		expect(spoolText(store, summary.job_id, SPOOL_FILES.cols)).toBe(colsExpected);

		// The manifest records the end.
		const end = lines.find((line) => line.t === 'end') as Line;
		const manifest = await store.readManifest(store.jobRef(USER_ID, summary.job_id));
		expect(manifest.status).toBe('ended');
		expect(manifest.ended_at).not.toBeNull();
		expect(manifest.records).toBe(SOURCE_IDS.length);
		expect(manifest.rows).toBe(baselineRows.length);
		expect(manifest.total).toBe(SOURCE_IDS.length);
		expect(manifest.columns).toEqual(end.columns as number[]);
		expect(manifest.unresolved).toEqual([...grid.unresolved]);
		expect(manifest.frontier_refusals).toEqual(JSON.parse(JSON.stringify(grid.frontierRefusals)));
		expect(manifest.application_lang).toBe(APP_LANG);
		expect(manifest.sections).toEqual([SECTION]);
		expect(manifest.options.background_running).toBeUndefined();

		// Progress: truthful frames, the last one terminal.
		expect(frames.length).toBeGreaterThan(0);
		const last = frames[frames.length - 1] as ExportProgress;
		expect(last).toMatchObject({ written: SOURCE_IDS.length, total: SOURCE_IDS.length });
		expect(last.is_running).toBe(false);
		expect(frames.every((frame) => typeof frame.msg === 'string' && frame.msg !== '')).toBe(true);
	});

	test('a CONTRARY ambient scope and batches of 1 do not move a byte', async () => {
		const store = scratchStore();
		const summary = await runWithRequestContext(
			{ principal: root, session: null, requestId: 'zzexpjob-decoy', clientIp: '' },
			() =>
				runWithRequestLangs({ applicationLang: APP_LANG, dataLang: 'lg-eng' }, () =>
					runExportArtifact(
						jobRun(store, { hydrateBatch: 1, checkpointRecords: 1, checkpointMs: 0 }),
					),
				),
		);
		expect(spoolText(store, summary.job_id, SPOOL_FILES.grid)).toBe(baseline);
		// Non-vacuous decoy: the admin principal and the eng data lang would
		// both change the bytes if they leaked in.
		expect(baseline).not.toContain('Source 0');
	});

	test("the background handler records the interface lang of the scope it runs in (the job manager pins the SUBMITTER's there)", async () => {
		const frames: object[] = [];
		// THE CONTRACT (media/jobs.ts JobRunScope): the handler reads the AMBIENT
		// interface lang at entry; the job manager guarantees that ambient value
		// is the submitter's, pinned at submit (gate: media_jobs_reconcile's
		// pinned-identity leg; the end-to-end submit leg is "G.
		// build_export_artifact through the background executor" below). Here the handler runs under scope X — a lang
		// that is NOT the installation default — and the manifest must record X:
		// a handler that ignored the ambient scope (the old threaded field) or
		// re-read the install default would record something else.
		const scopeLang =
			Object.keys(config.lang.applicationLangs).find((lang) => lang !== APP_LANG) ?? APP_LANG;
		expect(scopeLang).not.toBe(APP_LANG); // non-vacuous: X is not the install default
		const response = (await runWithRequestLangs(
			{ applicationLang: scopeLang, dataLang: DATA_LANG },
			() =>
				toolExportBuildArtifact({
					principal: reader,
					userId: USER_ID,
					background: true,
					options: { ...exportOptions(), background_running: true },
					publishProgress: (data) => frames.push(data),
					signal: new AbortController().signal,
				}),
		)) as unknown as { ok: boolean; data: { job_id: string } };
		expect(response.ok).toBe(true);
		defaultRootJobs.push({ userId: USER_ID, jobId: response.data.job_id });
		const store = openArtifactStore();
		const manifest = await store.readManifest(store.jobRef(USER_ID, response.data.job_id));
		expect(manifest.application_lang).toBe(scopeLang);
		expect(frames.length).toBeGreaterThan(0);
	});
});

describe('A3. a queued handler runs on the principal AS OF NOW, not of submit', () => {
	test('a submit-time global-admin flag the user no longer holds gets the SCOPED walk (the record scope recorded is the current one)', async () => {
		// The context carries a stale Principal: global admin at submit, demoted
		// (in the DB, USER_ID is a plain reader) while the job waited in the lane.
		const staleAdmin: Principal = { ...reader, isGlobalAdmin: true };
		expect(await exportRecordScope(staleAdmin)).not.toBe(await exportRecordScope(reader));
		const response = (await toolExportBuildArtifact({
			principal: staleAdmin,
			userId: USER_ID,
			background: true,
			options: { ...exportOptions(), background_running: true },
			signal: new AbortController().signal,
		})) as unknown as { ok: boolean; data: { job_id: string } };
		expect(response.ok).toBe(true);
		defaultRootJobs.push({ userId: USER_ID, jobId: response.data.job_id });
		const store = openArtifactStore();
		const manifest = await store.readManifest(store.jobRef(USER_ID, response.data.job_id));
		expect(manifest.record_scope).toBe(await exportRecordScope(reader));
		// One door invocation computes the principal's scope ONCE for every
		// manifest it re-checks (the listing / reclaim loops share the memo).
		const memo: ExportReadCheckMemo = {};
		expect(await exportStillReadable(reader, manifest, store, memo)).toBe(true);
		const shared = memo.recordScope;
		expect(shared).toBeDefined();
		expect(await exportStillReadable(reader, manifest, store, memo)).toBe(true);
		expect(memo.recordScope).toBe(shared);
	});

	test('a user who lost the section grant while queued is refused before anything is written', async () => {
		const store = openArtifactStore();
		const before = (await store.listJobStates(USER_ID)).length;
		// submitted with the grant (`reader`), revoked while the job waited
		await setReaderGrants([]);
		try {
			await expectCode(
				toolExportBuildArtifact({
					principal: reader,
					userId: USER_ID,
					background: true,
					options: { ...exportOptions(), background_running: true },
					signal: new AbortController().signal,
				}),
				'perm.denied',
			);
		} finally {
			await setReaderGrants(readerGrants);
		}
		expect((await store.listJobStates(USER_ID)).length).toBe(before);
	});
});

/** The export options with an SQO filter hop through a component the reader cannot read. */
const narrowingOptions = () => ({
	...exportOptions(),
	sqo: {
		section_tipo: [SECTION],
		filter_by_locators: SOURCE_IDS.map((id) => ({ section_tipo: SECTION, section_id: id })),
		filter: {
			$and: [
				{
					q: ['refused hop'],
					path: [
						{ section_tipo: SECTION, component_tipo: PORTAL, model: 'component_portal' },
						{ section_tipo: SECTION, component_tipo: DENIED, model: 'component_input_text' },
					],
				},
			],
		},
	},
});

describe('A2. narrowing is carried into the manifest and told to the owner', () => {
	test('an unreadable filter hop: the frontier refusal lands in the manifest', async () => {
		const store = scratchStore();
		const options = narrowingOptions();
		const summary = await runExportArtifact(jobRun(store, { options }));
		const manifest = await store.readManifest(store.jobRef(USER_ID, summary.job_id));
		expect(manifest.status).toBe('ended');
		expect(manifest.records).toBe(0);
		const refusals = manifest.frontier_refusals as {
			sectionTipo?: string;
			componentTipo?: string;
		}[];
		expect(refusals.some((r) => r.sectionTipo === SECTION && r.componentTipo === DENIED)).toBe(
			true,
		);
		// The OWNER is told — as a flag, never the coordinates (a refusal may name
		// a record the owner cannot see): on the terminal summary and in the list.
		expect(summary.narrowed).toBe(true);
		expect(JSON.stringify(summary)).not.toContain(DENIED);
		const listed = await listOwnedExportJobs(store, reader, USER_ID, SECTION);
		const entry = listed.find((job) => job.job_id === summary.job_id);
		expect(entry?.narrowed).toBe(true);
		expect(JSON.stringify(entry)).not.toContain(DENIED);
		// Control: the same export without the unreadable hop is not narrowed.
		const control = await runExportArtifact(jobRun(store));
		expect(control.narrowed).toBe(false);
		const controlEntry = (await listOwnedExportJobs(store, reader, USER_ID, SECTION)).find(
			(job) => job.job_id === control.job_id,
		);
		expect(controlEntry?.narrowed).toBe(false);
	});

	test("a detached run never writes into the SUBMITTING request's context", async () => {
		// The job manager detaches only the transaction stores: the worker runs
		// with the submitter's request context still ambient, long after that
		// request answered. The walk's refusals must stay on the job.
		const store = scratchStore();
		const submitting: RequestContext = {
			principal: reader,
			session: null,
			requestId: 'zzexpjob-submit',
			clientIp: '',
		};
		const summary = await runWithRequestContext(submitting, () =>
			runExportArtifact(jobRun(store, { options: narrowingOptions() })),
		);
		expect(summary.narrowed).toBe(true);
		expect(submitting.frontierRefusals ?? []).toEqual([]);
	});
});

// --- B. preview paging --------------------------------------------------------

describe('B. preview pages are in records, exact, clamped', () => {
	test('every page size walks the whole spool once; sub-rows never split', async () => {
		const store = scratchStore();
		// R = 2: page seeks go through grid.idx, not a scan from the start.
		const summary = await runExportArtifact(jobRun(store, { indexEvery: 2 }));
		for (const pageSize of [1, 2, 3, 5, 200]) {
			const collected: Line[] = [];
			let page = 0;
			for (;;) {
				const preview = await readExportPreview({
					store,
					principal: reader,
					userId: USER_ID,
					sectionTipo: SECTION,
					jobId: summary.job_id,
					page,
					pageSize,
				});
				expect(preview.status).toBe('ended');
				expect(preview.final_order).toBe(true);
				expect(preview.page_size).toBe(pageSize);
				expect(preview.first_record).toBe(page * pageSize);
				expect(preview.records).toBeLessThanOrEqual(pageSize);
				expect(preview.total_records).toBe(SOURCE_IDS.length);
				expect(preview.written_records).toBe(SOURCE_IDS.length);
				// A page starts at a record's FIRST row and holds whole records.
				if (preview.rows.length > 0) expect(preview.rows[0]?.sub).toBe(0);
				expect(preview.rows.filter((row) => row.sub === 0).length).toBe(preview.records);
				collected.push(...(preview.rows as unknown as Line[]));
				if (!preview.has_more) break;
				page++;
			}
			expect(page).toBe(Math.ceil(SOURCE_IDS.length / pageSize) - 1);
			expect(collected).toEqual(baselineRows);
		}
		// Columns in the final order, one descriptor per ordinal.
		const preview = await readExportPreview({
			store,
			principal: reader,
			userId: USER_ID,
			sectionTipo: SECTION,
			jobId: summary.job_id,
			page: 0,
			pageSize: 1,
		});
		expect(preview.cols.map((col) => col.i)).toEqual(summary.columns);
	});

	test('the page size is clamped server-side', async () => {
		const store = scratchStore();
		const summary = await runExportArtifact(jobRun(store));
		const sizeOf = async (pageSize: unknown, page: unknown = 0) =>
			(
				await readExportPreview({
					store,
					principal: reader,
					userId: USER_ID,
					sectionTipo: SECTION,
					jobId: summary.job_id,
					page,
					pageSize,
				})
			).page_size;
		const fallback = Math.min(PREVIEW_PAGE_SIZE_MAX, config.ops.exportPreviewPageSize);
		expect(await sizeOf(1_000_000)).toBe(PREVIEW_PAGE_SIZE_MAX);
		expect(await sizeOf(201)).toBe(PREVIEW_PAGE_SIZE_MAX);
		expect(await sizeOf(0)).toBe(fallback);
		expect(await sizeOf(-3)).toBe(fallback);
		expect(await sizeOf('abc')).toBe(fallback);
		expect(await sizeOf(undefined)).toBe(fallback);
		expect(await sizeOf(3.9)).toBe(3);
		// A nonsense page is page 0.
		const nonsense = await readExportPreview({
			store,
			principal: reader,
			userId: USER_ID,
			sectionTipo: SECTION,
			jobId: summary.job_id,
			page: 'x',
			pageSize: 2,
		});
		expect(nonsense.page).toBe(0);
	});
});

// --- B2. preview column window ------------------------------------------------------

describe('B2. a wide export: the preview is bounded in COLUMNS too', () => {
	test('one window of the display order per page, rows cut to it, every model named', async () => {
		const store = scratchStore();
		const WIDTH = PREVIEW_COLUMN_BUDGET * 2 + 50;
		const IMAGE_AT = WIDTH - 10; // the one media column lives in the LAST window
		const { job } = await store.createJob({
			userId: USER_ID,
			sectionTipo: SECTION,
			sections: [SECTION],
			options: { section_tipo: SECTION, data_format: 'value', breakdown: 'columns' },
			recordScope: await exportRecordScope(reader),
			frameColumns: [],
			applicationLang: APP_LANG,
		});
		const writer = await store.openSpoolWriter(job, { indexEvery: 2 });
		await writer.write({ t: 'meta', v: 1, data_format: 'value', breakdown: 'columns', total: 3 });
		for (let i = 0; i < WIDTH; i++) {
			await writer.write({
				t: 'col',
				i,
				key: `k${i}`,
				label: `L${i}`,
				cell_type: i === IMAGE_AT ? 'img' : 'text',
				model: i === IMAGE_AT ? 'component_image' : 'component_input_text',
				after: i === 0 ? null : i - 1,
			});
		}
		for (let rec = 1; rec <= 3; rec++) {
			const c: Record<string, string> = {};
			for (let i = 0; i < WIDTH; i++) c[String(i)] = `r${rec}c${i}`;
			await writer.write({ t: 'row', rec, sub: 0, c });
		}
		await writer.write({
			t: 'end',
			columns: Array.from({ length: WIDTH }, (_, i) => i),
			rows: 3,
			records: 3,
		});
		await writer.close();
		await store.updateManifest(job, {
			status: 'ended',
			ended_at: new Date().toISOString(),
			records: 3,
			total: 3,
		});
		const read = (colPage: unknown) =>
			readExportPreview({
				store,
				principal: reader,
				userId: USER_ID,
				sectionTipo: SECTION,
				jobId: job.jobId,
				page: 0,
				pageSize: 10,
				colPage,
			});
		const seen: number[] = [];
		for (const colPage of [0, 1, 2]) {
			const preview = await read(colPage);
			expect(preview.col_page).toBe(colPage);
			expect(preview.total_cols).toBe(WIDTH);
			expect(preview.col_page_size).toBe(PREVIEW_COLUMN_BUDGET);
			expect(preview.first_col).toBe(colPage * PREVIEW_COLUMN_BUDGET);
			expect(preview.cols.length).toBeLessThanOrEqual(PREVIEW_COLUMN_BUDGET);
			const window = new Set(preview.cols.map((col) => String(col.i)));
			// every served cell belongs to the window: cells <= rows x budget
			for (const row of preview.rows) {
				expect(Object.keys(row.c).every((ordinal) => window.has(ordinal))).toBe(true);
				expect(Object.keys(row.c).length).toBe(preview.cols.length);
			}
			// the media download is offered from EVERY column's model, not the window's
			expect(preview.col_models.sort()).toEqual(['component_image', 'component_input_text']);
			seen.push(...preview.cols.map((col) => col.i));
		}
		// the windows tile the display order exactly once
		expect(seen).toEqual(Array.from({ length: WIDTH }, (_, i) => i));
		// past the last window: clamped to it; garbage: window 0
		expect((await read(99)).col_page).toBe(2);
		expect((await read('x')).col_page).toBe(0);
	});
});

// --- C. while running -----------------------------------------------------------

describe('C. the preview works while the job runs', () => {
	test('paused at a checkpoint: exactly the written records, live order, running', async () => {
		const store = scratchStore();
		const snapshots: { written: number; rows: Line[]; status: string; final: boolean }[] = [];
		const summary = await runExportArtifact(
			jobRun(store, {
				hydrateBatch: 1,
				indexEvery: 2,
				checkpointRecords: 2,
				checkpointMs: 60_000,
				onCheckpoint: async ({ job, written }) => {
					// The meta checkpoint (written 0) pages nothing yet — asserted too.
					const preview = await readExportPreview({
						store,
						principal: reader,
						userId: USER_ID,
						sectionTipo: SECTION,
						jobId: job.jobId,
						page: 0,
						pageSize: 200,
					});
					expect(preview.written_records).toBe(written);
					snapshots.push({
						written,
						rows: preview.rows as unknown as Line[],
						status: preview.status,
						final: preview.final_order,
					});
				},
			}),
		);
		expect(summary.records).toBe(SOURCE_IDS.length);
		// The meta checkpoint (0), then every 2 records: 2, 4, 6 (7 is the end,
		// not a checkpoint).
		expect(snapshots.map((snap) => snap.written)).toEqual([0, 2, 4, 6]);
		for (const snap of snapshots) {
			expect(snap.status).toBe('running');
			expect(snap.final).toBe(false);
			expect(snap.rows.filter((row) => row.sub === 0).length).toBe(snap.written);
			expect(snap.rows).toEqual(baselineRows.slice(0, snap.rows.length));
		}
	});
});

describe('C2. a preview never reads past the COMMITTED grid', () => {
	test('a flush in flight (the next record half on disk) is not served, cut short or elided', async () => {
		const store = scratchStore();
		let checked = 0;
		await runExportArtifact(
			jobRun(store, {
				hydrateBatch: 1,
				indexEvery: 1,
				checkpointRecords: 2,
				checkpointMs: 60_000,
				onCheckpoint: async ({ job, written }) => {
					// Only the FIRST data checkpoint is probed (`checked` pins exactly one).
					if (written === 2) {
						const gridPath = join(job.dir, SPOOL_FILES.grid);
						const manifest = await store.readManifest(job);
						const committed = statSync(gridPath).size;
						// the checkpoint recorded exactly what is on disk, a record boundary
						expect(manifest.grid_bytes).toBe(committed);
						// What a read racing one 256 KiB write can see: the NEXT record's
						// first row complete, its sub-rows not on disk yet.
						appendFileSync(gridPath, `${JSON.stringify({ t: 'row', rec: 999, sub: 0, c: {} })}\n`);
						try {
							const preview = await readExportPreview({
								store,
								principal: reader,
								userId: USER_ID,
								sectionTipo: SECTION,
								jobId: job.jobId,
								page: 0,
								pageSize: 200,
							});
							expect(preview.records).toBe(written);
							expect(preview.rows.some((row) => row.rec === 999)).toBe(false);
							expect(preview.elided).toEqual([]);
							expect(preview.rows.filter((row) => row.sub === 0).length).toBe(written);
						} finally {
							truncateSync(gridPath, committed);
						}
						checked++;
					}
				},
			}),
		);
		expect(checked).toBe(1);
	});
});

// --- D. cancel ------------------------------------------------------------------

describe('D. a stop deletes the partial spool', () => {
	test('abort mid-run: export.cancelled, no spool, manifest cancelled, no file', async () => {
		const store = scratchStore();
		const controller = new AbortController();
		let jobId = '';
		const frames: ExportProgress[] = [];
		await expectCode(
			runExportArtifact(
				jobRun(store, {
					signal: controller.signal,
					hydrateBatch: 1,
					checkpointRecords: 1,
					publishProgress: (frame) => frames.push(frame),
					onCheckpoint: async ({ job, written }) => {
						jobId = job.jobId;
						// Something WAS spooled before the stop (non-vacuous).
						if (written >= 2) {
							expect(existsSync(join(job.dir, SPOOL_FILES.grid))).toBe(true);
							controller.abort();
						}
					},
				}),
			),
			'export.cancelled',
		);
		expect(jobId).not.toBe('');
		const job = store.jobRef(USER_ID, jobId);
		for (const name of [SPOOL_FILES.grid, SPOOL_FILES.cols, SPOOL_FILES.index]) {
			expect(existsSync(join(job.dir, name)), name).toBe(false);
		}
		const manifest = await store.readManifest(job);
		expect(manifest.status).toBe('cancelled');
		expect(manifest.error?.code).toBe('export.cancelled');
		expect(frames.some((frame) => frame.written >= 2)).toBe(true);

		// The preview says so (no rows); a file cannot be built from it.
		const preview = await readExportPreview({
			store,
			principal: reader,
			userId: USER_ID,
			sectionTipo: SECTION,
			jobId,
			page: 0,
			pageSize: 10,
		});
		expect(preview.status).toBe('cancelled');
		expect(preview.rows).toEqual([]);
		await expectCode(
			runBuildExportFile({
				store,
				principal: reader,
				userId: USER_ID,
				options: { section_tipo: SECTION, job_id: jobId, format: 'ndjson' },
				signal: new AbortController().signal,
			}),
			'export.artifact_not_ready',
		);
		expect(readdirSync(job.dir).sort()).toEqual([SPOOL_FILES.manifest, SPOOL_FILES.request].sort());
	});
});

describe('D2. a deadline and a shutdown are not a Stop (the REAL job manager aborts)', () => {
	/**
	 * Run one export as a job of a private MediaJobManager (the same class the
	 * lanes use), let `act` abort it the way the manager does, and answer the
	 * manifest and the error the run threw.
	 */
	async function runManaged(
		meta: { deadlineMs?: number },
		act: (manager: MediaJobManager, recordId: string, written: number) => void,
	): Promise<{ manifest: ExportManifest; thrown: unknown }> {
		const previousDir = readProcessesDirOverride();
		const processesDir = mkdtempSync(join(tmpdir(), 'dedalo_export_abort_pfiles_'));
		scratchDirs.push(processesDir);
		setProcessesDirOverride(processesDir);
		try {
			const store = scratchStore();
			const manager = new MediaJobManager({});
			let jobId = '';
			let thrown: unknown = null;
			let recordId = '';
			let settle: () => void = () => {};
			const settled = new Promise<void>((resolve) => {
				settle = resolve;
			});
			const record = manager.submit(
				'export_abort_probe',
				async ({ signal }) => {
					try {
						return await runExportArtifact(
							jobRun(store, {
								signal,
								hydrateBatch: 1,
								checkpointRecords: 1,
								onCheckpoint: async ({ job, written }) => {
									jobId = job.jobId;
									act(manager, recordId, written);
									await Bun.sleep(80);
								},
							}),
						);
					} catch (error) {
						thrown = error;
						throw error;
					} finally {
						settle();
					}
				},
				{ lane: 'export', userId: USER_ID, deadlineMs: meta.deadlineMs ?? 0 },
			);
			recordId = record.id;
			await settled;
			expect(jobId).not.toBe('');
			return { manifest: await store.readManifest(store.jobRef(USER_ID, jobId)), thrown };
		} finally {
			setProcessesDirOverride(previousDir);
		}
	}

	test("the lane DEADLINE: 'failed' with export.deadline_exceeded {limit_s}, never 'cancelled'", async () => {
		const { manifest, thrown } = await runManaged({ deadlineMs: 150 }, () => {});
		expect(manifest.status).toBe('failed');
		expect(manifest.error).toEqual({ code: 'export.deadline_exceeded', details: { limit_s: 1 } });
		expect(isDedaloError(thrown) && thrown.code).toBe('export.deadline_exceeded');
		const served = summarizeJobError(manifest.error);
		expect(served?.label_key).toBe('error_export_deadline_exceeded');
		expect(served?.details).toEqual({ limit_s: 1 });
	});

	test("a graceful SHUTDOWN (interruptLive): 'interrupted', no error, never 'cancelled'", async () => {
		const { manifest } = await runManaged({}, (manager, _id, written) => {
			if (written >= 2) manager.interruptLive('test shutdown');
		});
		expect(manifest.status).toBe('interrupted');
		expect(manifest.error).toBeNull();
	});

	test("the user's STOP (stop_process → manager.stop) is still 'cancelled'", async () => {
		const { manifest, thrown } = await runManaged({}, (manager, id, written) => {
			if (written >= 2) manager.stop(id);
		});
		expect(manifest.status).toBe('cancelled');
		expect(manifest.error).toEqual({ code: 'export.cancelled' });
		expect(isDedaloError(thrown) && thrown.code).toBe('export.cancelled');
	});
});

// --- E. quota -----------------------------------------------------------------

describe('E. the per-user quota', () => {
	test('overflow mid-spool fails typed and leaves no spool; over quota refuses creation', async () => {
		// Room for the manifest and part of the spool, never the whole of it.
		const store = scratchStore(Buffer.byteLength(baseline));
		const refusal = (await expectCode(
			runExportArtifact(jobRun(store)),
			'export.artifact_quota',
		)) as { details?: Record<string, unknown> };
		expect(refusal.details?.quota_bytes).toBe(store.quotaBytes);
		const userDir = join(store.root, String(USER_ID));
		const jobs = readdirSync(userDir);
		expect(jobs.length).toBe(1);
		const failedDir = join(userDir, jobs[0] as string);
		expect(readdirSync(failedDir).sort()).toEqual(
			[SPOOL_FILES.manifest, SPOOL_FILES.request].sort(),
		);
		const manifest = await store.readManifest(store.jobRef(USER_ID, jobs[0] as string));
		expect(manifest.status).toBe('failed');
		// The code AND the converter-filtered details are recorded — and served
		// with the registry label, so the client renders the FILLED sentence.
		expect(manifest.error).toEqual({
			code: 'export.artifact_quota',
			details: { quota_bytes: store.quotaBytes },
		});
		const quotaSpec = specOf('export.artifact_quota');
		expect(summarizeJob(manifest, store).error).toEqual({
			code: 'export.artifact_quota',
			label_key: quotaSpec.label_key,
			message: quotaSpec.message,
			retryable: quotaSpec.retryable,
			details: { quota_bytes: store.quotaBytes },
		});

		// Over quota already: refused BEFORE a job directory exists.
		const full = scratchStore(1);
		await runExportArtifact(jobRun(openArtifactStore({ root: full.root, quotaBytes: 0 })));
		await expectCode(runExportArtifact(jobRun(full)), 'export.artifact_quota');
		expect(readdirSync(join(full.root, String(USER_ID))).length).toBe(1);
	});
});

// --- E2. the manifest records only the export's own options, size-capped ----

describe("E2. the manifest records only the export's own options, size-capped", () => {
	test('unknown keys and transport flags never reach manifest.json; the spool is unchanged', async () => {
		const store = scratchStore();
		const summary = await runExportArtifact(
			jobRun(store, {
				options: {
					...exportOptions(),
					background_running: true,
					ndjson_stream: true,
					junk: 'j'.repeat(64 * 1024),
					nested: { deep: ['k'.repeat(1024)] },
				},
			}),
		);
		const manifest = await store.readManifest(store.jobRef(USER_ID, summary.job_id));
		expect(manifest.options).toEqual(exportOptions());
		const allowed = new Set<string>(EXPORT_MANIFEST_OPTION_KEYS);
		expect(Object.keys(manifest.options).filter((key) => !allowed.has(key))).toEqual([]);
		const onDisk = readFileSync(
			join(store.jobRef(USER_ID, summary.job_id).dir, SPOOL_FILES.manifest),
			'utf8',
		);
		expect(onDisk.includes('jjjj')).toBe(false);
		expect(spoolText(store, summary.job_id, SPOOL_FILES.grid)).toBe(baseline);
	});

	test('an allowlisted option over MANIFEST_OPTIONS_MAX_BYTES is refused before any job directory exists', async () => {
		const store = scratchStore();
		const options = exportOptions();
		options.sqo = {
			...(options.sqo as Record<string, unknown>),
			pad: 'p'.repeat(MANIFEST_OPTIONS_MAX_BYTES),
		};
		await expectCode(runExportArtifact(jobRun(store, { options })), 'request.invalid_options');
		expect(existsSync(join(store.root, String(USER_ID)))).toBe(false);
		// The ceiling is the FIRST gate — before the sqo gate and the producer
		// (an oversized body never costs a selection): an sqo that also targets
		// an unreadable section is refused for its size, not perm.denied.
		options.sqo = { section_tipo: [SECTION, 'test1'], pad: 'p'.repeat(MANIFEST_OPTIONS_MAX_BYTES) };
		await expectCode(runExportArtifact(jobRun(store, { options })), 'request.invalid_options');
		// Control: the same unreadable sqo, small, is the sqo gate's perm.denied.
		options.sqo = { section_tipo: [SECTION, 'test1'] };
		await expectCode(runExportArtifact(jobRun(store, { options })), 'perm.denied');
	});
});

// --- F. owner-only through the handlers ------------------------------------------

describe('F. owner-only: the preview, the file and the list', () => {
	let jobId = '';

	const ctx = (
		principal: Principal,
		userId: number,
		options: Record<string, unknown>,
		background = false,
	): ToolActionContext =>
		({
			principal,
			userId,
			options: { section_tipo: SECTION, ...options },
			background,
			...(background ? { signal: new AbortController().signal } : {}),
		}) as ToolActionContext;

	beforeAll(async () => {
		const summary = await runExportArtifact(jobRun(openArtifactStore()));
		jobId = summary.job_id;
		defaultRootJobs.push({ userId: USER_ID, jobId });
	});

	test('the owner previews, lists and builds a file', async () => {
		const preview = (await toolExportGetPreview(
			ctx(reader, USER_ID, { job_id: jobId, page: 0, page_size: 3 }),
		)) as unknown as { ok: boolean; data: { rows: unknown[]; records: number } };
		expect(preview.ok).toBe(true);
		expect(preview.data.records).toBe(3);

		const listed = (await toolExportListJobs(ctx(reader, USER_ID, {}))) as unknown as {
			data: { jobs: { job_id: string; status: string }[] };
		};
		expect(listed.data.jobs.find((job) => job.job_id === jobId)?.status).toBe('ended');

		const built = (await toolExportBuildFile(
			ctx(reader, USER_ID, { job_id: jobId, format: 'ndjson' }, true),
		)) as unknown as {
			ok: boolean;
			data: { url: string; bytes: number; rows: number; basename: string };
		};
		expect(built.ok).toBe(true);
		expect(built.data.url).toBe(`/dedalo/export/artifact/${jobId}/export.ndjson`);
		expect(built.data.bytes).toBe(Buffer.byteLength(baseline));
		const store = openArtifactStore();
		expect(spoolText(store, jobId, built.data.basename)).toBe(baseline);
		// ...and the list now carries the file with its URL.
		const relisted = (await toolExportListJobs(ctx(reader, USER_ID, {}))) as unknown as {
			data: { jobs: { job_id: string; files: { url: string }[] }[] };
		};
		expect(relisted.data.jobs.find((job) => job.job_id === jobId)?.files[0]?.url).toBe(
			built.data.url,
		);
	});

	test('another user — a global admin included — gets not_found and sees nothing', async () => {
		await expectCode(
			toolExportGetPreview(ctx(root, -1, { job_id: jobId, page: 0 })),
			'export.artifact_not_found',
		);
		await expectCode(
			toolExportBuildFile(ctx(root, -1, { job_id: jobId, format: 'ndjson' }, true)),
			'export.artifact_not_found',
		);
		const listed = (await toolExportListJobs(ctx(root, -1, {}))) as unknown as {
			data: { jobs: { job_id: string }[] };
		};
		expect(listed.data.jobs.some((job) => job.job_id === jobId)).toBe(false);
	});

	test('the owner asking under another section, or with a malformed id, gets not_found', async () => {
		await expectCode(
			toolExportGetPreview({
				...ctx(reader, USER_ID, { job_id: jobId }),
				options: { section_tipo: 'test1', job_id: jobId },
			}),
			'export.artifact_not_found',
		);
		await expectCode(
			toolExportGetPreview(ctx(reader, USER_ID, { job_id: '../../etc' })),
			'export.artifact_not_found',
		);
	});

	test('a read grant revoked after the build closes the preview, the file and the list', async () => {
		await setReaderGrants([]);
		try {
			const revoked = await resolvePrincipal(USER_ID);
			await expectCode(
				toolExportGetPreview(ctx(revoked, USER_ID, { job_id: jobId, page: 0 })),
				'export.artifact_not_found',
			);
			// The background handler re-asks the SECTION grant on the principal as of
			// now (currentExportPrincipal) before it looks any job up — the answer
			// the dispatcher's own section gate gives this user at submit.
			await expectCode(
				toolExportBuildFile(ctx(revoked, USER_ID, { job_id: jobId, format: 'ndjson' }, true)),
				'perm.denied',
			);
			const listed = (await toolExportListJobs(ctx(revoked, USER_ID, {}))) as unknown as {
				data: { jobs: { job_id: string }[] };
			};
			expect(listed.data.jobs.some((job) => job.job_id === jobId)).toBe(false);
		} finally {
			await setReaderGrants(readerGrants);
		}
		// Control: restored, the owner reads it again.
		const restored = await resolvePrincipal(USER_ID);
		const preview = (await toolExportGetPreview(
			ctx(restored, USER_ID, { job_id: jobId, page: 0 }),
		)) as unknown as { ok: boolean };
		expect(preview.ok).toBe(true);
	});

	test('removed from the project after the build: preview, file build and list close; put back, they open', async () => {
		// Every grant still holds — only the RECORD SCOPE the walk ran under changed.
		const setProjects = async (projects: unknown[]): Promise<void> => {
			await sql.unsafe(
				`UPDATE matrix_users SET relation = jsonb_set(relation, '{dd170}', $1::text::jsonb)
				 WHERE section_tipo = 'dd128' AND section_id = $2`,
				[encodeForJsonb(projects), USER_ID],
			);
			clearCaches();
		};
		try {
			await setProjects([]);
			const moved = await resolvePrincipal(USER_ID);
			await expectCode(
				toolExportGetPreview(ctx(moved, USER_ID, { job_id: jobId, page: 0 })),
				'export.artifact_not_found',
			);
			await expectCode(
				toolExportBuildFile(ctx(moved, USER_ID, { job_id: jobId, format: 'csv' }, true)),
				'export.artifact_not_found',
			);
			const listed = (await toolExportListJobs(ctx(moved, USER_ID, {}))) as unknown as {
				data: { jobs: { job_id: string }[] };
			};
			expect(listed.data.jobs.some((job) => job.job_id === jobId)).toBe(false);
		} finally {
			await setProjects([locator('dd170', 'dd153', PROJECT_ID)]);
		}
		const restored = await resolvePrincipal(USER_ID);
		const preview = (await toolExportGetPreview(
			ctx(restored, USER_ID, { job_id: jobId, page: 0 }),
		)) as unknown as { ok: boolean };
		expect(preview.ok).toBe(true);
	});

	test('the file build is background-only', async () => {
		await expectCode(
			toolExportBuildFile(ctx(reader, USER_ID, { job_id: jobId, format: 'ndjson' })),
			'request.invalid_options',
		);
	});
});

// --- H. the re-check mirrors the build's own gates ---------------------------------------

describe('H. the doors re-ask the BUILD gates — same keys, same admin posture', () => {
	// A second section the export's ddo path steps into. The reader is given the
	// COMPONENT grant Gate B asks for (S2_C2) and NO section grant (S2_S2).
	const S2 = 'test1';
	const C2 = 'test17'; // component_text_area of test1
	const secondHopOptions = (): Record<string, unknown> => {
		const options = exportOptions();
		(options.ar_ddo_to_export as unknown[]).push({
			path: [
				{ section_tipo: SECTION, component_tipo: PORTAL, name: PORTAL },
				{ section_tipo: S2, component_tipo: C2, name: C2 },
			],
		});
		return options;
	};
	const withSecondHopGrant = () => [
		...readerGrants,
		{ id: readerGrants.length + 1, tipo: C2, section_tipo: S2, value: 1 },
	];

	/** Every door on one job: preview, file, list — true when all three open. */
	async function doorsOpen(store: ArtifactStore, principal: Principal, jobId: string) {
		const preview = await readExportPreview({
			store,
			principal,
			userId: USER_ID,
			sectionTipo: SECTION,
			jobId,
			page: 0,
			pageSize: 2,
		}).then(
			() => 'open',
			(error) => (isDedaloError(error) ? error.code : String(error)),
		);
		const file = await runBuildExportFile({
			store,
			principal,
			userId: USER_ID,
			options: { section_tipo: SECTION, job_id: jobId, format: 'ndjson' },
			signal: new AbortController().signal,
		}).then(
			() => 'open',
			(error) => (isDedaloError(error) ? error.code : String(error)),
		);
		const listed = (await listOwnedExportJobs(store, principal, USER_ID, SECTION)).some(
			(job) => job.job_id === jobId,
		);
		return { preview, file, listed };
	}

	test('a path section held on the COMPONENT grant only: the owner keeps the export; revoking that grant alone closes it', async () => {
		await setReaderGrants(withSecondHopGrant());
		try {
			const granted = await resolvePrincipal(USER_ID);
			// Non-vacuous: the build passes on the component key, never the section key.
			expect(await getPermissions(granted, S2, C2)).toBeGreaterThanOrEqual(1);
			expect(await getPermissions(granted, S2, S2)).toBe(0);
			const store = scratchStore();
			const summary = await runExportArtifact(
				jobRun(store, { principal: granted, options: secondHopOptions() }),
			);
			const manifest = await store.readManifest(store.jobRef(USER_ID, summary.job_id));
			expect(manifest.status).toBe('ended');
			expect(manifest.sections).toContain(S2);
			expect(await doorsOpen(store, granted, summary.job_id)).toEqual({
				preview: 'open',
				file: 'open',
				listed: true,
			});

			// Revoke ONLY the second-hop grant: every test3 grant stays.
			await setReaderGrants(readerGrants);
			const revoked = await resolvePrincipal(USER_ID);
			expect(await doorsOpen(store, revoked, summary.job_id)).toEqual({
				preview: 'export.artifact_not_found',
				file: 'export.artifact_not_found',
				listed: false,
			});
			// Control: a test3-only export of the same owner still opens.
			const control = await runExportArtifact(jobRun(store, { principal: revoked }));
			expect((await doorsOpen(store, revoked, control.job_id)).preview).toBe('open');
		} finally {
			await setReaderGrants(readerGrants);
		}
	});

	test('a grant on a section reached only at RUNTIME is re-asked: revoking it after the build closes the export', async () => {
		// The declared path is test3.test80 → test3.test52 (Gate B asks test3
		// only), but the portal's stored locator lands in `zzejr1` — a VIRTUAL of
		// test3 the declaration never names (so it lawfully holds test52; a
		// section that does not hold the component is skipped by the walk, never
		// crossed — WC-2026-11-11-section-elements-target-groups). The build's
		// frontier authorized the RUNTIME pair (zzejr1, test52) and read the value
		// under it; the manifest records that pair (frontier_grants) and every
		// later door re-asks it.
		const RUNTIME_SECTION = 'zzejr1';
		const RUNTIME_FILTER = FILTER; // a virtual borrows test3's component_filter
		const runtimeSituation = situation({
			name: 'tool_export_job runtime virtual',
			tld: 'zzejr',
			nodes: [
				{
					tipo: RUNTIME_SECTION,
					parent: 'test1',
					model: 'section',
					term: { 'lg-eng': 'zz runtime virtual of test3' },
					relations: [{ tipo: 'test24' }, { tipo: SECTION }],
				},
			],
		});
		await ensureSituation(runtimeSituation);
		const runtimeTable = await getMatrixTableFromTipo(RUNTIME_SECTION);
		expect(runtimeTable, 'test2 must resolve to a matrix table').not.toBeNull();
		const runtimeRow = {
			table: runtimeTable as string,
			sectionTipo: RUNTIME_SECTION,
			sectionId: RUNTIME_TARGET_ID,
		};
		const runtimeGrants = () => [
			...readerGrants,
			{
				id: readerGrants.length + 1,
				tipo: RUNTIME_SECTION,
				section_tipo: RUNTIME_SECTION,
				value: 1,
			},
			{ id: readerGrants.length + 2, tipo: TEXT, section_tipo: RUNTIME_SECTION, value: 1 },
		];
		const options = (): Record<string, unknown> => ({
			...exportOptions(),
			ar_ddo_to_export: [
				{
					path: [
						{ section_tipo: SECTION, component_tipo: PORTAL, name: PORTAL },
						{ section_tipo: SECTION, component_tipo: TEXT, name: TEXT },
					],
				},
			],
			sqo: {
				section_tipo: [SECTION],
				filter_by_locators: [{ section_tipo: SECTION, section_id: RUNTIME_SOURCE_ID }],
			},
		});
		await insertRow(runtimeRow.table, RUNTIME_SECTION, RUNTIME_TARGET_ID, {
			string: { [TEXT]: bilingual('zzruntime destino', 'zzruntime target') },
			relation: { [RUNTIME_FILTER]: [locator(RUNTIME_FILTER, 'dd153', PROJECT_ID)] },
		});
		await insertRow(TABLE, SECTION, RUNTIME_SOURCE_ID, {
			string: { [TEXT]: bilingual('zzruntime origen', 'zzruntime source') },
			relation: {
				...projectSlot,
				[PORTAL]: [locator(PORTAL, RUNTIME_SECTION, RUNTIME_TARGET_ID)],
			},
		});
		try {
			await setReaderGrants(runtimeGrants());
			const granted = await resolvePrincipal(USER_ID);
			const store = scratchStore();
			const summary = await runExportArtifact(
				jobRun(store, { principal: granted, options: options() }),
			);
			const job = store.jobRef(USER_ID, summary.job_id);
			const manifest = await store.readManifest(job);
			expect(manifest.status).toBe('ended');
			// Non-vacuous: the value really was read from the runtime section…
			expect(spoolText(store, summary.job_id, SPOOL_FILES.grid)).toContain('zzruntime destino');
			// …the declaration never names it…
			expect(JSON.stringify(manifest.options)).not.toContain(RUNTIME_SECTION);
			// …and the build recorded the runtime pair it was read under.
			expect(manifest.frontier_grants).toContainEqual({
				section_tipo: RUNTIME_SECTION,
				component_tipo: TEXT,
			});
			expect(await doorsOpen(store, granted, summary.job_id)).toEqual({
				preview: 'open',
				file: 'open',
				listed: true,
			});

			// Revoke ONLY the runtime component grant: every test3 grant (all the
			// declaration asks), the test2 section grant and the record scope stay.
			await setReaderGrants(runtimeGrants().slice(0, -1));
			const revoked = await resolvePrincipal(USER_ID);
			expect(await getPermissions(revoked, SECTION, TEXT)).toBeGreaterThanOrEqual(1);
			expect(await getPermissions(revoked, SECTION, PORTAL)).toBeGreaterThanOrEqual(1);
			expect(await exportRecordScope(revoked)).toBe(manifest.record_scope);
			expect(await doorsOpen(store, revoked, summary.job_id)).toEqual({
				preview: 'export.artifact_not_found',
				file: 'export.artifact_not_found',
				listed: false,
			});
			// Control: the grant back, the doors open again — it was that grant.
			await setReaderGrants(runtimeGrants());
			const restored = await resolvePrincipal(USER_ID);
			expect((await doorsOpen(store, restored, summary.job_id)).preview).toBe('open');
			// A manifest carrying no grant list is bound to none (fail closed).
			const { frontier_grants: _dropped, ...withoutList } = await store.readManifest(job);
			await store.writeManifest(job, withoutList as ExportManifest);
			expect((await doorsOpen(store, restored, summary.job_id)).listed).toBe(false);
		} finally {
			await setReaderGrants(readerGrants);
			await deleteMatrixRecord(TABLE, SECTION, RUNTIME_SOURCE_ID);
			await deleteMatrixRecord(runtimeRow.table, RUNTIME_SECTION, RUNTIME_TARGET_ID);
			expect(await dropSituation(runtimeSituation)).toBe(0);
		}
	});

	test('a global admin (exempt from Gate B at build) is not locked out of its own export', async () => {
		const plainReader = await resolvePrincipal(USER_ID);
		// Control: WITHOUT the admin flag the build refuses the second hop — so it
		// is the admin posture, not a grant, that lets it through.
		await expectCode(
			runExportArtifact(
				jobRun(scratchStore(), { principal: plainReader, options: secondHopOptions() }),
			),
			'perm.denied',
		);
		const admin: Principal = { ...plainReader, isGlobalAdmin: true };
		const store = scratchStore();
		const summary = await runExportArtifact(
			jobRun(store, { principal: admin, options: secondHopOptions() }),
		);
		expect(await doorsOpen(store, admin, summary.job_id)).toEqual({
			preview: 'open',
			file: 'open',
			listed: true,
		});
	});
});

describe('H2. the record scope includes the dd478 record allow-list — exactly where the walk applies it', () => {
	/** Set (or with null, remove) the scratch user's dd478 allow-list, caches dropped. */
	async function setAllowList(ids: number[] | null): Promise<void> {
		if (ids === null) {
			await sql.unsafe(
				`UPDATE "matrix_users" SET misc = misc - 'dd478' WHERE section_tipo = 'dd128' AND section_id = $1 AND misc IS NOT NULL`,
				[USER_ID],
			);
		} else {
			await sql.unsafe(
				`UPDATE "matrix_users" SET misc = COALESCE(misc, '{}'::jsonb) || $1::text::jsonb WHERE section_tipo = 'dd128' AND section_id = $2`,
				[encodeForJsonb({ dd478: [{ id: 1, tipo: SECTION, value: ids }] }), USER_ID],
			);
		}
		clearUserFilterRecordsCache();
		clearCaches();
	}

	/** Preview, file and list on one job: all 'open' or all closed. */
	async function doors(store: ArtifactStore, principal: Principal, jobId: string) {
		const outcome = (promise: Promise<unknown>) =>
			promise.then(
				() => 'open',
				(error) => (isDedaloError(error) ? error.code : String(error)),
			);
		return {
			preview: await outcome(
				readExportPreview({
					store,
					principal,
					userId: USER_ID,
					sectionTipo: SECTION,
					jobId,
					page: 0,
					pageSize: 2,
				}),
			),
			file: await outcome(
				runBuildExportFile({
					store,
					principal,
					userId: USER_ID,
					options: { section_tipo: SECTION, job_id: jobId, format: 'ndjson' },
					signal: new AbortController().signal,
				}),
			),
			listed: (await listOwnedExportJobs(store, principal, USER_ID, SECTION)).some(
				(job) => job.job_id === jobId,
			),
		};
	}

	test("narrowing a reader's allow-list AFTER the walk closes the export", async () => {
		try {
			await setAllowList(null);
			const principal = await resolvePrincipal(USER_ID);
			const store = scratchStore();
			const summary = await runExportArtifact(jobRun(store, { principal }));
			// non-vacuous: the walk reached every record, and the doors are open
			expect(summary.records).toBe(SOURCE_IDS.length);
			expect(await doors(store, principal, summary.job_id)).toEqual({
				preview: 'open',
				file: 'open',
				listed: true,
			});
			// an admin edits dd478: this user may now read ONE source record (and
			// the one target its portal names)
			await setAllowList([SOURCE_IDS[0] as number, TARGET_IDS[0] as number]);
			expect(await doors(store, principal, summary.job_id)).toEqual({
				preview: 'export.artifact_not_found',
				file: 'export.artifact_not_found',
				listed: false,
			});
			// control: a walk under the NEW scope reaches exactly that record and opens
			const narrowed = await runExportArtifact(jobRun(store, { principal }));
			expect(narrowed.records).toBe(1);
			expect(await doors(store, principal, narrowed.job_id)).toEqual({
				preview: 'open',
				file: 'open',
				listed: true,
			});
		} finally {
			await setAllowList(null);
		}
	});

	test("a global admin's walk does not apply dd478, so its re-check does not either (never stricter than the build)", async () => {
		try {
			await setAllowList(null);
			const admin: Principal = { ...(await resolvePrincipal(USER_ID)), isGlobalAdmin: true };
			const store = scratchStore();
			const summary = await runExportArtifact(jobRun(store, { principal: admin }));
			await setAllowList([SOURCE_IDS[0] as number, TARGET_IDS[0] as number]);
			// the build under the narrowed allow-list still reaches every record
			// (grid.ts selects with no principal for a global admin) ...
			const again = await runExportArtifact(jobRun(store, { principal: admin }));
			expect(again.records).toBe(SOURCE_IDS.length);
			// ... so the finished export was taken under the SAME scope: it stays open
			expect(await doors(store, admin, summary.job_id)).toEqual({
				preview: 'open',
				file: 'open',
				listed: true,
			});
		} finally {
			await setAllowList(null);
		}
	});
});

// --- I. a refusal leaves nothing behind ---------------------------------------------------

describe('I. refusals: nothing on disk, or a job marked failed', () => {
	const ownerDirEntries = (store: ArtifactStore): string[] => {
		const dir = join(store.root, String(USER_ID));
		return existsSync(dir) ? readdirSync(dir) : [];
	};

	test('an unreadable sqo section and a Gate-B column are refused before any job directory exists', async () => {
		const store = scratchStore();
		await expectCode(
			runExportArtifact(
				jobRun(store, {
					options: { ...exportOptions(), sqo: { section_tipo: [SECTION, 'test1'] } },
				}),
			),
			'perm.denied',
		);
		expect(ownerDirEntries(store)).toEqual([]);
		const denied = exportOptions();
		(denied.ar_ddo_to_export as unknown[]).push({
			path: [{ section_tipo: SECTION, component_tipo: DENIED, name: DENIED }],
		});
		await expectCode(runExportArtifact(jobRun(store, { options: denied })), 'perm.denied');
		expect(ownerDirEntries(store)).toEqual([]);
		// Control: the same store takes a lawful export.
		await runExportArtifact(jobRun(store));
		expect(ownerDirEntries(store).length).toBe(1);
	});

	test('the spool refused AFTER createJob (quota counted with the new manifest): failed, not running', async () => {
		// createJob now charges the manifest to the quota BEFORE writing it, so a
		// quota too small for the manifest never reaches this path. The owner
		// going over between createJob and openSpoolWriter (a concurrent export's
		// spool) still does: modelled by a store whose spool door sees a 1-byte
		// budget over the SAME root — the real openSpoolWriter refusal, the real
		// manifest bytes counted.
		const store = scratchStore();
		const tight = openArtifactStore({ root: store.root, quotaBytes: 1, ttlHours: 24 });
		const racing: ArtifactStore = {
			...store,
			openSpoolWriter: (job, options) => tight.openSpoolWriter(job, options),
		};
		await expectCode(runExportArtifact(jobRun(racing)), 'export.artifact_quota');
		const jobs = ownerDirEntries(store);
		expect(jobs.length).toBe(1);
		const jobId = jobs[0] as string;
		expect(readdirSync(join(store.root, String(USER_ID), jobId)).sort()).toEqual(
			[SPOOL_FILES.manifest, SPOOL_FILES.request].sort(),
		);
		const manifest = await store.readManifest(store.jobRef(USER_ID, jobId));
		expect(manifest.status).toBe('failed');
		expect(manifest.error?.code).toBe('export.artifact_quota');
		expect(summarizeJob(manifest, store).error?.label_key).toBe('error_export_artifact_quota');
		expect(manifest.ended_at).not.toBeNull();
	});

	test('a quota too small for the MANIFEST refuses at createJob: nothing on disk', async () => {
		const store = scratchStore(10);
		await expectCode(runExportArtifact(jobRun(store)), 'export.artifact_quota');
		expect(ownerDirEntries(store)).toEqual([]);
	});
});

// --- G. through the real background executor -----------------------------------------

describe('G. build_export_artifact through the background executor (lane export)', () => {
	test('scheduled like the client schedules it: runs on the export lane, spool === stream', async () => {
		const previousDir = readProcessesDirOverride();
		const processesDir = mkdtempSync(join(tmpdir(), 'dedalo_export_job_pfiles_'));
		scratchDirs.push(processesDir);
		setProcessesDirOverride(processesDir);
		try {
			const { scheduleBackground, getBackgroundJob } = await import(
				'../../src/core/tools/background.ts'
			);
			const { getLoadedTool } = await import('../../src/core/tools/loader.ts');
			const { mediaJobs } = await import('../../src/core/media/jobs.ts');
			const loaded = await getLoadedTool('tool_export');
			const spec = loaded?.module.apiActions.build_export_artifact;
			expect(spec).toBeDefined();
			// A submit-time interface lang that is NOT the installation default:
			// the manifest must carry THIS one (captured, not re-read later).
			const submitLang =
				Object.keys(config.lang.applicationLangs).find((lang) => lang !== APP_LANG) ?? APP_LANG;
			expect(submitLang).not.toBe(APP_LANG); // non-vacuous: two interface langs exist
			const response = runWithRequestLangs(
				{ applicationLang: submitLang, dataLang: DATA_LANG },
				() =>
					scheduleBackground(
						loaded as NonNullable<typeof loaded>,
						'build_export_artifact',
						spec as NonNullable<typeof spec>,
						{ ...exportOptions(), background_running: true },
						reader,
						USER_ID,
					),
			);
			expect(response.ok).toBe(true);
			const laneJobId = response.background_job_id as string;
			expect(mediaJobs.status(laneJobId)?.lane).toBe('export');
			for (let i = 0; i < 200 && getBackgroundJob(laneJobId)?.status === 'running'; i++) {
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			const job = getBackgroundJob(laneJobId);
			expect(job?.status).toBe('done');
			const data = (job?.result as unknown as { data: { job_id: string } }).data;
			defaultRootJobs.push({ userId: USER_ID, jobId: data.job_id });
			const store = openArtifactStore();
			expect(spoolText(store, data.job_id, SPOOL_FILES.grid)).toBe(baseline);
			const manifest = await store.readManifest(store.jobRef(USER_ID, data.job_id));
			expect(manifest.application_lang).toBe(submitLang);
			// The lane job that wrote it is recorded and served: a reopened client
			// ties the export to exactly this job (follow / stop), no guessing.
			expect(manifest.background_job_id).toBe(laneJobId);
			expect(summarizeJob(manifest, store).background_job_id).toBe(laneJobId);
			// another boot's manifest never serves its lane id: the id can repeat in
			// this boot, and a client matching on it would bind a new job to an old export
			expect(
				summarizeJob({ ...manifest, owner_boot: 'a-previous-boot' }, store).background_job_id,
			).toBeNull();
		} finally {
			setProcessesDirOverride(previousDir);
		}
	});
});

// --- J. per-user admission ----------------------------------------------------------

describe('J. per-user admission on the shared export lane', () => {
	test('at most DEDALO_EXPORT_JOBS_PER_USER queued or running: the next is refused at SUBMIT, nothing queued', async () => {
		const previousDir = readProcessesDirOverride();
		const processesDir = mkdtempSync(join(tmpdir(), 'dedalo_export_admit_pfiles_'));
		scratchDirs.push(processesDir);
		setProcessesDirOverride(processesDir);
		const { scheduleBackground, getBackgroundJob, listBackgroundJobs } = await import(
			'../../src/core/tools/background.ts'
		);
		const { dispatchToolRequest } = await import('../../src/core/tools/dispatch.ts');
		const { getLoadedTool } = await import('../../src/core/tools/loader.ts');
		const loaded = await getLoadedTool('tool_export');
		expect(loaded).toBeDefined();
		// Through the REAL dispatcher (gates, then admission, then the fork), as the
		// superuser: tool grants come from a profile, and the superuser holds every
		// active tool (the reader's scratch profile grants none).
		const caller: Principal = root;
		const OWNER = caller.userId;
		const submit = () =>
			dispatchToolRequest(
				caller,
				OWNER,
				{ model: 'tool_export', action: 'build_export_artifact' },
				{ ...exportOptions(), background_running: true },
			);
		const waitDone = async (id: string): Promise<void> => {
			for (let i = 0; i < 400 && getBackgroundJob(id)?.status === 'running'; i++) {
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
		};
		const inFlight = () =>
			listBackgroundJobs('tool_export', OWNER).filter((job) => job.status === 'running').length;
		const limit = config.ops.exportJobsPerUser;
		expect(limit).toBeGreaterThanOrEqual(1);
		// `limit` export-lane jobs of this user that stay in flight until released.
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const blocker = {
			permission: 'section' as const,
			minLevel: 1,
			handler: async () => {
				await held;
				return ok(null, { requestId: '' });
			},
		};
		const blockers: string[] = [];
		const store = openArtifactStore();
		// Every job this test leaves in the default root is swept, even one a
		// broken admission let through (it would run once the lane frees).
		const preexisting = new Set((await store.listJobs(OWNER)).map((job) => job.job_id));
		const sweepNew = async (): Promise<void> => {
			for (const manifest of await store.listJobs(OWNER)) {
				if (preexisting.has(manifest.job_id)) continue;
				if (defaultRootJobs.some((job) => job.jobId === manifest.job_id)) continue;
				defaultRootJobs.push({ userId: OWNER, jobId: manifest.job_id });
			}
		};
		try {
			expect(inFlight()).toBe(0);
			for (let i = 0; i < limit; i++) {
				const response = scheduleBackground(
					loaded as NonNullable<typeof loaded>,
					'build_export_file',
					blocker,
					{ section_tipo: SECTION, background_running: true },
					caller,
					OWNER,
				);
				blockers.push(response.background_job_id as string);
			}
			expect(inFlight()).toBe(limit);
			const jobsBefore = (await store.listJobs(OWNER)).length;

			const refused = (await expectCode(submit(), 'export.too_many_jobs')) as {
				details?: Record<string, unknown>;
			};
			expect(refused.details).toEqual({ limit });
			// nothing queued, no export directory
			expect(inFlight()).toBe(limit);
			expect((await store.listJobs(OWNER)).length).toBe(jobsBefore);
			// the cap is PER USER, and a foreground (read) request is never counted
			expect(() =>
				admitExportJob({ principal: reader, userId: USER_ID, options: {}, background: true }),
			).not.toThrow();
			expect(() =>
				admitExportJob({ principal: caller, userId: OWNER, options: {}, background: false }),
			).not.toThrow();
		} finally {
			release();
			for (const id of blockers) await waitDone(id);
			for (const job of listBackgroundJobs('tool_export', OWNER)) await waitDone(job.id);
			await sweepNew();
		}
		try {
			// freed: the same request is admitted and runs to its end
			expect(inFlight()).toBe(0);
			const response = await submit();
			expect(response.ok).toBe(true);
			const laneJobId = response.background_job_id as string;
			await waitDone(laneJobId);
			const job = getBackgroundJob(laneJobId);
			expect(job?.status).toBe('done');
			const data = (job?.result as unknown as { data: { job_id: string } }).data;
			defaultRootJobs.push({ userId: OWNER, jobId: data.job_id });
			expect((await store.readManifest(store.jobRef(OWNER, data.job_id))).status).toBe('ended');
		} finally {
			for (const job of listBackgroundJobs('tool_export', OWNER)) await waitDone(job.id);
			await sweepNew();
			setProcessesDirOverride(previousDir);
		}
	});

	test('CONCURRENT submissions at limit-1 in flight: exactly one is admitted (check and register are one step)', async () => {
		const previousDir = readProcessesDirOverride();
		const processesDir = mkdtempSync(join(tmpdir(), 'dedalo_export_admit_race_pfiles_'));
		scratchDirs.push(processesDir);
		setProcessesDirOverride(processesDir);
		const { scheduleBackground, getBackgroundJob, listBackgroundJobs } = await import(
			'../../src/core/tools/background.ts'
		);
		const { dispatchToolRequest } = await import('../../src/core/tools/dispatch.ts');
		const { getLoadedTool } = await import('../../src/core/tools/loader.ts');
		const loaded = await getLoadedTool('tool_export');
		expect(loaded).toBeDefined();
		const caller: Principal = root;
		const OWNER = caller.userId;
		const submit = () =>
			dispatchToolRequest(
				caller,
				OWNER,
				{ model: 'tool_export', action: 'build_export_artifact' },
				{ ...exportOptions(), background_running: true },
			);
		const waitDone = async (id: string): Promise<void> => {
			for (let i = 0; i < 400 && getBackgroundJob(id)?.status === 'running'; i++) {
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
		};
		const limit = config.ops.exportJobsPerUser;
		expect(limit).toBeGreaterThanOrEqual(1);
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const blocker = {
			permission: 'section' as const,
			minLevel: 1,
			handler: async () => {
				await held;
				return ok(null, { requestId: '' });
			},
		};
		const blockers: string[] = [];
		const store = openArtifactStore();
		const preexisting = new Set((await store.listJobs(OWNER)).map((job) => job.job_id));
		const sweepNew = async (): Promise<void> => {
			for (const manifest of await store.listJobs(OWNER)) {
				if (preexisting.has(manifest.job_id)) continue;
				if (defaultRootJobs.some((job) => job.jobId === manifest.job_id)) continue;
				defaultRootJobs.push({ userId: OWNER, jobId: manifest.job_id });
			}
		};
		try {
			// limit-1 in flight: ONE slot left.
			for (let i = 0; i < limit - 1; i++) {
				const response = scheduleBackground(
					loaded as NonNullable<typeof loaded>,
					'build_export_file',
					blocker,
					{ section_tipo: SECTION, background_running: true },
					caller,
					OWNER,
				);
				blockers.push(response.background_job_id as string);
			}
			// Warm the dispatcher's lookups (tool list, module, section grant) so the
			// requests' path to admission is pure microtasks — the interleaving a
			// double click on a warm server gets. Cold, a DB read per request would
			// serialize them and hide the gap this leg measures.
			const { getUserTools } = await import('../../src/core/tools/registry.ts');
			await getUserTools(OWNER, caller.isGlobalAdmin);
			await getPermissions(caller, SECTION, SECTION);
			// A double click (and one more): the requests enter the dispatcher together.
			const settled = await Promise.allSettled([submit(), submit(), submit()]);
			const admitted = settled.filter((outcome) => outcome.status === 'fulfilled');
			const refused = settled.filter(
				(outcome): outcome is PromiseRejectedResult =>
					outcome.status === 'rejected' &&
					isDedaloError(outcome.reason) &&
					(outcome.reason as { code: string }).code === 'export.too_many_jobs',
			);
			expect(admitted.length).toBe(1);
			expect(refused.length).toBe(2);
		} finally {
			release();
			for (const id of blockers) await waitDone(id);
			for (const job of listBackgroundJobs('tool_export', OWNER)) await waitDone(job.id);
			await sweepNew();
			setProcessesDirOverride(previousDir);
		}
	});
});

// --- K. a job stopped while QUEUED ---------------------------------------------------

describe('K. a lane job stopped while still QUEUED', () => {
	test('ends at once and gives its per-user admission slot back — while the lane is still full', async () => {
		const previousDir = readProcessesDirOverride();
		const processesDir = mkdtempSync(join(tmpdir(), 'dedalo_export_queued_stop_pfiles_'));
		scratchDirs.push(processesDir);
		setProcessesDirOverride(processesDir);
		const { scheduleBackground, getBackgroundJob, listBackgroundJobs } = await import(
			'../../src/core/tools/background.ts'
		);
		const { getLoadedTool } = await import('../../src/core/tools/loader.ts');
		const { mediaJobs } = await import('../../src/core/media/jobs.ts');
		const loaded = await getLoadedTool('tool_export');
		expect(loaded).toBeDefined();
		const OWNER = root.userId;
		// The lane is filled by ANOTHER user's jobs, so the owner's count is
		// exactly its own queued job.
		const FILLER = USER_ID;
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ran = { value: false };
		const blocker = {
			permission: 'section' as const,
			minLevel: 1,
			handler: async () => {
				await held;
				return ok(null, { requestId: '' });
			},
		};
		const victim = {
			permission: 'section' as const,
			minLevel: 1,
			handler: async () => {
				ran.value = true;
				return ok(null, { requestId: '' });
			},
		};
		const waitDone = async (id: string): Promise<void> => {
			for (let i = 0; i < 400 && getBackgroundJob(id)?.status === 'running'; i++) {
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
		};
		const blockers: string[] = [];
		const admitOne = () =>
			admitExportJob({ principal: root, userId: OWNER, options: {}, background: true }, 1);
		try {
			const depth = mediaJobs.laneDepths().export;
			for (let i = 0; i < depth.max - depth.active; i++) {
				const response = scheduleBackground(
					loaded as NonNullable<typeof loaded>,
					'build_export_artifact',
					blocker,
					{ section_tipo: SECTION, background_running: true },
					reader,
					FILLER,
				);
				blockers.push(response.background_job_id as string);
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(mediaJobs.laneDepths().export.active).toBe(mediaJobs.laneDepths().export.max);
			const queued = scheduleBackground(
				loaded as NonNullable<typeof loaded>,
				'build_export_artifact',
				victim,
				{ section_tipo: SECTION, background_running: true },
				root,
				OWNER,
			);
			const laneJobId = queued.background_job_id as string;
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(mediaJobs.status(laneJobId)?.status).toBe('queued');
			// non-vacuous: the queued job holds the owner's one slot
			expect(() => admitOne()).toThrow();

			expect(mediaJobs.stop(laneJobId)).toBe(true);
			await new Promise((resolve) => setTimeout(resolve, 10));
			// The lane is STILL full, and yet the job is over and the slot is back.
			expect(mediaJobs.laneDepths().export.active).toBe(mediaJobs.laneDepths().export.max);
			expect(mediaJobs.status(laneJobId)?.status).toBe('stopped');
			expect(getBackgroundJob(laneJobId)?.status).toBe('stopped');
			expect(
				listBackgroundJobs('tool_export', OWNER).some(
					(job) => job.id === laneJobId && job.status === 'running',
				),
			).toBe(false);
			expect(() => admitOne()).not.toThrow();
		} finally {
			release();
			for (const id of blockers) await waitDone(id);
			setProcessesDirOverride(previousDir);
		}
		expect(ran.value).toBe(false);
	});
});

// --- K2. a QUEUED walk is visible to reconnect -----------------------------------------

describe('K2. a walk QUEUED behind the lane is listed as pending (reconnect can find it)', () => {
	test('list_export_jobs names the queued lane job of THIS section; a manifest-backed or other-section job is not pending', async () => {
		const previousDir = readProcessesDirOverride();
		const processesDir = mkdtempSync(join(tmpdir(), 'dedalo_export_pending_pfiles_'));
		scratchDirs.push(processesDir);
		setProcessesDirOverride(processesDir);
		const { scheduleBackground, getBackgroundJob } = await import(
			'../../src/core/tools/background.ts'
		);
		const { getLoadedTool } = await import('../../src/core/tools/loader.ts');
		const { mediaJobs } = await import('../../src/core/media/jobs.ts');
		const loaded = (await getLoadedTool('tool_export')) as NonNullable<
			Awaited<ReturnType<typeof getLoadedTool>>
		>;
		expect(loaded).toBeDefined();
		const OWNER = root.userId;
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const blocker = {
			permission: 'section' as const,
			minLevel: 1,
			handler: async () => {
				await held;
				return ok(null, { requestId: '' });
			},
		};
		const idle = {
			permission: 'section' as const,
			minLevel: 1,
			handler: async () => ok(null, { requestId: '' }),
		};
		const waitDone = async (id: string): Promise<void> => {
			for (let i = 0; i < 400 && getBackgroundJob(id)?.status === 'running'; i++) {
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
		};
		const listPending = async (): Promise<
			{ background_job_id: string; submitted_at: number }[]
		> => {
			const listed = (await toolExportListJobs({
				principal: root,
				userId: OWNER,
				options: { section_tipo: SECTION },
				background: false,
			} as ToolActionContext)) as unknown as {
				data: { pending: { background_job_id: string; submitted_at: number }[] };
			};
			return listed.data.pending;
		};
		const scheduled: string[] = [];
		const schedule = (
			spec: typeof blocker,
			section: string,
			principal: Principal,
			userId: number,
		): string => {
			const response = scheduleBackground(
				loaded,
				'build_export_artifact',
				spec,
				{ section_tipo: section, background_running: true },
				principal,
				userId,
			);
			const id = response.background_job_id as string;
			scheduled.push(id);
			return id;
		};
		try {
			// the lane is filled by ANOTHER user's walks
			const depth = mediaJobs.laneDepths().export;
			for (let i = 0; i < depth.max - depth.active; i++)
				schedule(blocker, SECTION, reader, USER_ID);
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(mediaJobs.laneDepths().export.active).toBe(mediaJobs.laneDepths().export.max);
			expect(await listPending()).toEqual([]);

			const mine = schedule(idle, SECTION, root, OWNER);
			const elsewhere = schedule(idle, 'test2', root, OWNER);
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(mediaJobs.status(mine)?.status).toBe('queued');
			const pending = await listPending();
			// THIS section's queued walk only — never another section's, never
			// another user's (the blockers)
			expect(pending.map((job) => job.background_job_id)).toEqual([mine]);
			expect(pending[0]?.submitted_at).toBeGreaterThan(0);
			expect(elsewhere).not.toBe(mine);

			// once a manifest OF THIS BOOT names the lane job, it is a listed export, not pending
			const { pendingExportJobs } = await import('../../tools/tool_export/server/export_job.ts');
			const listing = (manifests: { background_job_id: string; owner_boot: string }[]) => ({
				listJobStates: async () =>
					manifests as unknown as Awaited<ReturnType<ArtifactStore['listJobStates']>>,
			});
			expect(
				await pendingExportJobs(
					listing([{ background_job_id: mine, owner_boot: STORE_BOOT_ID }]),
					OWNER,
					SECTION,
				),
			).toEqual([]);
			// ANOTHER boot's manifest carrying the same id (lane ids are
			// <kind>_<pid>_<counter>: the counter restarts, bun is PID 1 in the
			// container) is an old export, not this queued walk — still pending
			const stale = await pendingExportJobs(
				listing([{ background_job_id: mine, owner_boot: 'a-previous-boot' }]),
				OWNER,
				SECTION,
			);
			expect(stale.map((job) => job.background_job_id)).toEqual([mine]);
		} finally {
			for (const id of scheduled) mediaJobs.stop(id);
			release();
			for (const id of scheduled) await waitDone(id);
			setProcessesDirOverride(previousDir);
		}
	});
});

// --- N. file builds have their own lane ---------------------------------------------

describe('N. a file build never waits behind an export walk', () => {
	test('the export lane is FULL, yet a file build scheduled through the real module starts at once', async () => {
		const previousDir = readProcessesDirOverride();
		const processesDir = mkdtempSync(join(tmpdir(), 'dedalo_export_file_lane_pfiles_'));
		scratchDirs.push(processesDir);
		setProcessesDirOverride(processesDir);
		const { scheduleBackground, getBackgroundJob } = await import(
			'../../src/core/tools/background.ts'
		);
		const { getLoadedTool } = await import('../../src/core/tools/loader.ts');
		const { mediaJobs } = await import('../../src/core/media/jobs.ts');
		const loaded = await getLoadedTool('tool_export');
		expect(loaded).toBeDefined();
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		// Stand-ins for the handlers: what is under test is WHERE the real module
		// files each action (its backgroundLanes), not what the handlers write.
		const walk = {
			permission: 'section' as const,
			minLevel: 1,
			handler: async () => {
				await held;
				return ok(null, { requestId: '' });
			},
		};
		const started = { value: false };
		const fileBuild = {
			permission: 'section' as const,
			minLevel: 1,
			handler: async () => {
				started.value = true;
				await held;
				return ok(null, { requestId: '' });
			},
		};
		const waitDone = async (id: string): Promise<void> => {
			for (let i = 0; i < 400 && getBackgroundJob(id)?.status === 'running'; i++) {
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
		};
		const jobs: string[] = [];
		try {
			// Another user's walks take EVERY export slot.
			const depth = mediaJobs.laneDepths().export;
			for (let i = 0; i < depth.max - depth.active; i++) {
				const response = scheduleBackground(
					loaded as NonNullable<typeof loaded>,
					'build_export_artifact',
					walk,
					{ section_tipo: SECTION, background_running: true },
					reader,
					USER_ID,
				);
				jobs.push(response.background_job_id as string);
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(mediaJobs.laneDepths().export.active).toBe(mediaJobs.laneDepths().export.max);
			// One MORE walk queues: the lane really is full (non-vacuous).
			const queuedWalk = scheduleBackground(
				loaded as NonNullable<typeof loaded>,
				'build_export_artifact',
				walk,
				{ section_tipo: SECTION, background_running: true },
				reader,
				USER_ID,
			);
			jobs.push(queuedWalk.background_job_id as string);

			const download = scheduleBackground(
				loaded as NonNullable<typeof loaded>,
				'build_export_file',
				fileBuild,
				{ section_tipo: SECTION, background_running: true },
				root,
				root.userId,
			);
			const downloadId = download.background_job_id as string;
			jobs.push(downloadId);
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(mediaJobs.status(queuedWalk.background_job_id as string)?.status).toBe('queued');
			expect(mediaJobs.status(downloadId)?.lane).not.toBe('export');
			expect(mediaJobs.status(downloadId)?.status).toBe('running');
			expect(started.value).toBe(true);
			// the walk lane is still full: the file build did not take its slot
			expect(mediaJobs.laneDepths().export.active).toBe(mediaJobs.laneDepths().export.max);
		} finally {
			release();
			for (const id of jobs) await waitDone(id);
			setProcessesDirOverride(previousDir);
		}
	});
});

// --- O. one user never fills the shared export_file lane ------------------------------

describe('O. one user never holds every export_file slot', () => {
	test("a user's second file build is refused while the lane still has a slot for another user", async () => {
		const previousDir = readProcessesDirOverride();
		const processesDir = mkdtempSync(join(tmpdir(), 'dedalo_export_file_share_pfiles_'));
		scratchDirs.push(processesDir);
		setProcessesDirOverride(processesDir);
		const { scheduleBackground, getBackgroundJob, listBackgroundJobs } = await import(
			'../../src/core/tools/background.ts'
		);
		const { dispatchToolRequest } = await import('../../src/core/tools/dispatch.ts');
		const { getLoadedTool } = await import('../../src/core/tools/loader.ts');
		const { mediaJobs } = await import('../../src/core/media/jobs.ts');
		const loaded = await getLoadedTool('tool_export');
		expect(loaded).toBeDefined();
		const OWNER = root.userId;
		const budget = mediaJobs.laneDepths().export_file.max;
		const share = exportFileLaneShare(budget);
		// Non-vacuous: the per-user TOTAL alone would admit the refused build.
		expect(config.ops.exportJobsPerUser).toBeGreaterThan(share);
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const blocker = {
			permission: 'section' as const,
			minLevel: 1,
			handler: async () => {
				await held;
				return ok(null, { requestId: '' });
			},
		};
		const waitDone = async (id: string): Promise<void> => {
			for (let i = 0; i < 400 && getBackgroundJob(id)?.status === 'running'; i++) {
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
		};
		const blockers: string[] = [];
		try {
			expect(
				listBackgroundJobs('tool_export', OWNER).filter((j) => j.status === 'running'),
			).toEqual([]);
			// The owner's long file builds take their whole share of the lane.
			for (let i = 0; i < share; i++) {
				const response = scheduleBackground(
					loaded as NonNullable<typeof loaded>,
					'build_export_file',
					blocker,
					{ section_tipo: SECTION, background_running: true },
					root,
					OWNER,
				);
				blockers.push(response.background_job_id as string);
			}
			// Through the REAL dispatcher (gates, admission, fork): refused, nothing queued.
			const refused = (await expectCode(
				dispatchToolRequest(
					root,
					OWNER,
					{ model: 'tool_export', action: 'build_export_file' },
					{
						section_tipo: SECTION,
						job_id: 'exp_zz_share',
						format: 'csv',
						background_running: true,
					},
				),
				'export.too_many_jobs',
			)) as { details?: Record<string, unknown> };
			expect(refused.details).toEqual({ limit: share });
			expect(
				listBackgroundJobs('tool_export', OWNER).filter((job) => job.status === 'running').length,
			).toBe(share);
			// Another user is admitted, and the lane really has a slot for them.
			expect(() =>
				admitExportFileJob({ principal: reader, userId: USER_ID, options: {}, background: true }),
			).not.toThrow();
			if (budget > 1) {
				const depth = mediaJobs.laneDepths().export_file;
				expect(depth.active).toBeLessThan(depth.max);
			}
			// The WALK lane is not this rule's: the owner may still start an export.
			expect(() =>
				admitExportJob({ principal: root, userId: OWNER, options: {}, background: true }),
			).not.toThrow();
		} finally {
			release();
			for (const id of blockers) await waitDone(id);
			setProcessesDirOverride(previousDir);
		}
	});

	test("a user's running WALKS never block a file build of a finished export", async () => {
		const previousDir = readProcessesDirOverride();
		const processesDir = mkdtempSync(join(tmpdir(), 'dedalo_export_walks_pfiles_'));
		scratchDirs.push(processesDir);
		setProcessesDirOverride(processesDir);
		const { scheduleBackground, getBackgroundJob, listBackgroundJobs } = await import(
			'../../src/core/tools/background.ts'
		);
		const { getLoadedTool } = await import('../../src/core/tools/loader.ts');
		const loaded = await getLoadedTool('tool_export');
		const OWNER = -1;
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const walk = {
			permission: 'section' as const,
			minLevel: 1,
			handler: async () => {
				await held;
				return ok(null, { requestId: '' });
			},
		};
		const walks: string[] = [];
		try {
			// the owner's walks fill the per-user TOTAL (running or queued)
			for (let i = 0; i < config.ops.exportJobsPerUser; i++) {
				const response = scheduleBackground(
					loaded as NonNullable<typeof loaded>,
					'build_export_artifact',
					walk,
					{ section_tipo: SECTION, background_running: true },
					root,
					OWNER,
				);
				walks.push(response.background_job_id as string);
			}
			const context = { principal: root, userId: OWNER, options: {}, background: true };
			// non-vacuous: another walk IS refused on the total ...
			expect(
				listBackgroundJobs('tool_export', OWNER).filter((job) => job.status === 'running').length,
			).toBe(config.ops.exportJobsPerUser);
			expect(() => admitExportJob(context)).toThrow();
			// ... yet a download of a finished export is admitted
			expect(() => admitExportFileJob(context, { laneBudget: 2 })).not.toThrow();
		} finally {
			release();
			for (const id of walks) {
				for (let i = 0; i < 400 && getBackgroundJob(id)?.status === 'running'; i++) {
					await new Promise((resolve) => setTimeout(resolve, 25));
				}
			}
			setProcessesDirOverride(previousDir);
		}
	});

	test('the share is every slot but one, never zero', () => {
		expect([1, 2, 3, 5].map(exportFileLaneShare)).toEqual([1, 1, 2, 4]);
	});
});

// --- L. the owner's delete ----------------------------------------------------------

/** Bytes of every regular file under `dir` (independent of the store's own meter). */
/** Bytes the tree HOLDS on disk: a hard-linked file (export.ndjson IS the spool) counts once. */
function treeBytes(dir: string, seen: Set<string> = new Set()): number {
	let total = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) total += treeBytes(path, seen);
		else if (entry.isFile()) {
			const info = statSync(path);
			const identity = `${info.dev}:${info.ino}`;
			if (seen.has(identity)) continue;
			seen.add(identity);
			total += info.size;
		}
	}
	return total;
}

describe("L. the owner's delete: owner-only, frees the quota, never under a live writer", () => {
	const ctx = (principal: Principal, userId: number, options: Record<string, unknown>) =>
		({
			principal,
			userId,
			options: { section_tipo: SECTION, ...options },
			background: false,
		}) as ToolActionContext;
	const deleteRun = (store: ArtifactStore, jobId: string) =>
		runDeleteExportJob({
			store,
			principal: reader,
			userId: USER_ID,
			options: { section_tipo: SECTION, job_id: jobId },
		});

	test('non-owner and wrong section: not_found, nothing removed; the owner deletes everything', async () => {
		const store = openArtifactStore();
		const { job_id: jobId } = await runExportArtifact(jobRun(store));
		defaultRootJobs.push({ userId: USER_ID, jobId });
		await runBuildExportFile({
			store,
			principal: reader,
			userId: USER_ID,
			options: { section_tipo: SECTION, job_id: jobId, format: 'ndjson' },
			signal: new AbortController().signal,
		});
		const dir = store.jobRef(USER_ID, jobId).dir;
		const held = treeBytes(dir);
		expect(readdirSync(dir)).toContain('export.ndjson');

		await expectCode(
			toolExportDeleteJob(ctx(root, -1, { job_id: jobId })),
			'export.artifact_not_found',
		);
		await expectCode(
			toolExportDeleteJob({
				...ctx(reader, USER_ID, {}),
				options: { section_tipo: 'test1', job_id: jobId },
			}),
			'export.artifact_not_found',
		);
		expect(treeBytes(dir)).toBe(held);

		const usedBefore = await store.usedBytes(USER_ID);
		const deleted = (await toolExportDeleteJob(
			ctx(reader, USER_ID, { job_id: jobId }),
		)) as unknown as {
			ok: boolean;
			data: { job_id: string; deleted: boolean; freed_bytes: number };
		};
		expect(deleted.ok).toBe(true);
		expect(deleted.data).toEqual({ job_id: jobId, deleted: true, freed_bytes: held });
		expect(existsSync(dir)).toBe(false);
		expect(await store.usedBytes(USER_ID)).toBe(usedBefore - held);
		const listed = (await toolExportListJobs(ctx(reader, USER_ID, {}))) as unknown as {
			data: { jobs: { job_id: string }[] };
		};
		expect(listed.data.jobs.some((job) => job.job_id === jobId)).toBe(false);
		// A second delete finds nothing (the one answer for absent).
		await expectCode(
			toolExportDeleteJob(ctx(reader, USER_ID, { job_id: jobId })),
			'export.artifact_not_found',
		);
	});

	test('the freed bytes are quota: refused at a full quota, admitted after the delete', async () => {
		const measure = scratchStore();
		const { job_id: measured } = await runExportArtifact(jobRun(measure));
		const oneJob = treeBytes(measure.jobRef(USER_ID, measured).dir);
		// Room for one whole export, not for two.
		const store = scratchStore(oneJob + Math.floor(oneJob / 2));
		const { job_id: first } = await runExportArtifact(jobRun(store));
		await expectCode(runExportArtifact(jobRun(store)), 'export.artifact_quota');
		await deleteRun(store, first);
		const third = await runExportArtifact(jobRun(store));
		expect(third.status).toBe('ended');
	});

	test('MAY DISCARD is not MAY READ: an export its owner can no longer read is still theirs to delete', async () => {
		const store = scratchStore();
		const { job_id: jobId } = await runExportArtifact(jobRun(store));
		const dir = store.jobRef(USER_ID, jobId).dir;
		const held = treeBytes(dir);
		const setProjects = async (projects: unknown[]): Promise<void> => {
			await sql.unsafe(
				`UPDATE matrix_users SET relation = jsonb_set(relation, '{dd170}', $1::text::jsonb)
				 WHERE section_tipo = 'dd128' AND section_id = $2`,
				[encodeForJsonb(projects), USER_ID],
			);
			clearCaches();
		};
		try {
			await setProjects([]);
			const moved = await resolvePrincipal(USER_ID);
			// hidden from the owner's list (the read door) …
			expect(
				(await listOwnedExportJobs(store, moved, USER_ID, SECTION)).some((j) => j.job_id === jobId),
			).toBe(false);
			// … and still the owner's to discard: every byte back to the quota.
			const deleted = await runDeleteExportJob({
				store,
				principal: moved,
				userId: USER_ID,
				options: { section_tipo: SECTION, job_id: jobId },
			});
			expect(deleted).toEqual({ job_id: jobId, deleted: true, freed_bytes: held });
			expect(existsSync(dir)).toBe(false);
		} finally {
			await setProjects([locator('dd170', 'dd153', PROJECT_ID)]);
		}
	});

	test('an export the owner can no longer read does not hold their quota: the next export reclaims it', async () => {
		const measure = scratchStore();
		const { job_id: measured } = await runExportArtifact(jobRun(measure));
		const oneJob = treeBytes(measure.jobRef(USER_ID, measured).dir);
		// Room for one whole export, not for two.
		const store = scratchStore(oneJob + Math.floor(oneJob / 2));
		const { job_id: first } = await runExportArtifact(jobRun(store));
		const firstJob = store.jobRef(USER_ID, first);
		// Non-vacuous: while the first is readable the second does not fit.
		await expectCode(runExportArtifact(jobRun(store)), 'export.artifact_quota');
		// The first passes its lifetime ceiling (end + TTL): no door serves it any
		// more, the hourly sweep has not run yet.
		await store.updateManifest(firstJob, {
			ended_at: new Date(Date.now() - (store.ttlHours + 1) * 60 * 60 * 1000).toISOString(),
		});
		expect(
			(await listOwnedExportJobs(store, reader, USER_ID, SECTION)).some((j) => j.job_id === first),
		).toBe(false);
		expect(existsSync(firstJob.dir)).toBe(true);
		const second = await runExportArtifact(jobRun(store));
		expect(second.status).toBe('ended');
		expect(existsSync(firstJob.dir)).toBe(false);
		// A readable export is never reclaimed: the second one survives the next run's reclaim.
		await expectCode(runExportArtifact(jobRun(store)), 'export.artifact_quota');
		expect(existsSync(store.jobRef(USER_ID, second.job_id).dir)).toBe(true);
	});

	test('a FILE BUILD reclaims too (the other door that consumes quota)', async () => {
		const build = (store: ArtifactStore, jobId: string) =>
			runBuildExportFile({
				store,
				principal: reader,
				userId: USER_ID,
				options: { section_tipo: SECTION, job_id: jobId, format: 'csv' },
				signal: new AbortController().signal,
			});
		const measure = scratchStore();
		const { job_id: measured } = await runExportArtifact(jobRun(measure));
		const oneJob = treeBytes(measure.jobRef(USER_ID, measured).dir);
		const csvBytes = (await build(measure, measured)).bytes;
		expect(csvBytes).toBeGreaterThan(1);
		// Two exports fit; a file on top of both does not.
		const store = scratchStore(2 * oneJob + Math.floor(csvBytes / 2));
		const { job_id: stale } = await runExportArtifact(jobRun(store));
		const { job_id: live } = await runExportArtifact(jobRun(store));
		await store.updateManifest(store.jobRef(USER_ID, stale), {
			ended_at: new Date(Date.now() - (store.ttlHours + 1) * 60 * 60 * 1000).toISOString(),
		});
		const file = await build(store, live);
		expect(file.bytes).toBe(csvBytes);
		expect(existsSync(store.jobRef(USER_ID, stale).dir)).toBe(false);
	});

	test('a RUNNING export is busy: refused, every byte kept; deletable once it ended', async () => {
		const store = scratchStore();
		let jobId = '';
		let refusedWhileRunning = false;
		await runExportArtifact(
			jobRun(store, {
				hydrateBatch: 1,
				checkpointRecords: 1,
				onCheckpoint: async ({ job, written }) => {
					// Probed ONCE, once something is spooled (`refusedWhileRunning` pins it).
					if (written >= 2 && !refusedWhileRunning) {
						jobId = job.jobId;
						const before = treeBytes(job.dir);
						await expectCode(deleteRun(store, job.jobId), 'export.artifact_busy');
						expect(existsSync(join(job.dir, SPOOL_FILES.grid))).toBe(true);
						expect(treeBytes(job.dir)).toBe(before);
						refusedWhileRunning = true;
					}
				},
			}),
		);
		expect(refusedWhileRunning).toBe(true);
		await deleteRun(store, jobId);
		expect(existsSync(store.jobRef(USER_ID, jobId).dir)).toBe(false);
	});

	test('a live FILE BUILD on an ended export is busy; its release frees the delete', async () => {
		const store = scratchStore();
		const { job_id: jobId } = await runExportArtifact(jobRun(store));
		const job = store.jobRef(USER_ID, jobId);
		const sink = await store.openFileSink(job, store.allocateFile(job, 'csv'));
		try {
			await expectCode(deleteRun(store, jobId), 'export.artifact_busy');
			expect(existsSync(join(job.dir, SPOOL_FILES.grid))).toBe(true);
		} finally {
			await sink.abort();
		}
		await deleteRun(store, jobId);
		expect(existsSync(job.dir)).toBe(false);
	});

	test("a foreign 'running' manifest: a dead owner is deletable, a live heartbeating one is busy", async () => {
		const store = scratchStore();
		const foreign = async (ownerPid: number): Promise<string> => {
			const { job_id: jobId } = await runExportArtifact(jobRun(store));
			const job = store.jobRef(USER_ID, jobId);
			const manifest = await store.readManifest(job);
			await store.writeManifest(job, {
				...manifest,
				status: 'running',
				ended_at: null,
				owner_boot: 'zz-another-boot',
				owner_pid: ownerPid,
				updated_at: new Date().toISOString(),
			});
			return jobId;
		};
		// A pid no process holds (above every platform's pid_max).
		const dead = await foreign(2 ** 30);
		await deleteRun(store, dead);
		expect(existsSync(store.jobRef(USER_ID, dead).dir)).toBe(false);
		// Our parent process lives and is not us: another boot's live writer.
		const live = await foreign(process.ppid);
		await expectCode(deleteRun(store, live), 'export.artifact_busy');
		expect(existsSync(join(store.jobRef(USER_ID, live).dir, SPOOL_FILES.grid))).toBe(true);
	});
});

// --- M. a failure while finalizing -------------------------------------------------

describe('M. a failure while FINALIZING still ends the job (never stuck running)', () => {
	const enospc = (): Error =>
		Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });

	/** The store, with a fault injected into one of its doors. */
	const faulty = (
		store: ArtifactStore,
		fault: { closeFails?: boolean; failStatuses?: readonly string[] },
	): ArtifactStore => ({
		...store,
		openSpoolWriter: async (job, options) => {
			const writer = await store.openSpoolWriter(job, options);
			if (fault.closeFails !== true) return writer;
			// The final flush hits a full disk: the writer's own close ran, then failed.
			return {
				...writer,
				stats: writer.stats,
				close: async () => {
					await writer.close();
					throw enospc();
				},
			};
		},
		updateManifest: async (job, patch) => {
			const status = typeof patch === 'function' ? undefined : patch.status;
			if (status !== undefined && (fault.failStatuses ?? []).includes(status)) {
				throw new DedaloError('export.store_unavailable', {
					message: `injected: manifest lock timed out writing '${status}'`,
				});
			}
			return store.updateManifest(job, patch);
		},
	});

	const onlyJob = (store: ArtifactStore): ArtifactJobRef => {
		const entries = readdirSync(join(store.root, String(USER_ID)));
		expect(entries.length).toBe(1);
		return store.jobRef(USER_ID, entries[0] as string);
	};
	const deleteRun = (store: ArtifactStore, jobId: string) =>
		runDeleteExportJob({
			store,
			principal: reader,
			userId: USER_ID,
			options: { section_tipo: SECTION, job_id: jobId },
		});

	test('the final spool close fails: failed, spool deleted, quota freed, deletable', async () => {
		const store = scratchStore();
		let caught: unknown = null;
		try {
			await runExportArtifact(jobRun(faulty(store, { closeFails: true })));
		} catch (error) {
			caught = error;
		}
		expect((caught as { code?: string } | null)?.code).toBe('ENOSPC');
		const job = onlyJob(store);
		const manifest = await store.readManifest(job);
		expect(manifest.status).toBe('failed');
		expect(manifest.ended_at).not.toBeNull();
		expect(readdirSync(job.dir).sort()).toEqual([SPOOL_FILES.manifest, SPOOL_FILES.request].sort());
		await deleteRun(store, job.jobId);
		expect(existsSync(job.dir)).toBe(false);
	});

	test("the terminal 'ended' manifest write fails: failed, spool deleted", async () => {
		const store = scratchStore();
		await expectCode(
			runExportArtifact(jobRun(faulty(store, { failStatuses: ['ended'] }))),
			'export.store_unavailable',
		);
		const job = onlyJob(store);
		expect((await store.readManifest(job)).status).toBe('failed');
		expect(readdirSync(job.dir).sort()).toEqual([SPOOL_FILES.manifest, SPOOL_FILES.request].sort());
	});

	test("BOTH terminal writes fail: 'running' on disk, yet reported interrupted, swept and deletable without a restart", async () => {
		const run = async (backgroundJobId: string | null) => {
			const store = scratchStore();
			const errors: unknown[] = [];
			const originalError = console.error;
			console.error = (...args: unknown[]) => void errors.push(args);
			try {
				await expectCode(
					runExportArtifact(
						jobRun(faulty(store, { failStatuses: ['ended', 'failed'] }), { backgroundJobId }),
					),
					'export.store_unavailable',
				);
			} finally {
				console.error = originalError;
			}
			// the stuck terminal write is LOUD
			expect(String(errors[0])).toContain('the terminal manifest write failed');
			const job = onlyJob(store);
			const manifest = await store.readManifest(job);
			expect(manifest.status).toBe('running');
			expect(manifest.owner_boot).toBe(STORE_BOOT_ID);
			return { store, job, manifest };
		};

		// The lane job that wrote it is no longer running in this process (its
		// id is not in the live registry): the writer is certainly gone.
		const gone = await run('zz_finished_lane_job');
		expect(summarizeJob(gone.manifest, gone.store).status).toBe('interrupted');
		const report = await gone.store.sweep();
		expect(report.interrupted).toBe(1);
		expect((await gone.store.readManifest(gone.job)).status).toBe('interrupted');
		expect(existsSync(join(gone.job.dir, SPOOL_FILES.grid))).toBe(false);
		await deleteRun(gone.store, gone.job.jobId);
		expect(existsSync(gone.job.dir)).toBe(false);

		// Control: a manifest with NO lane job id (a direct writer) cannot be
		// asked, so it stays live — busy, kept by the sweep.
		const direct = await run(null);
		expect(summarizeJob(direct.manifest, direct.store).status).toBe('running');
		expect((await direct.store.sweep()).kept).toBe(1);
		await expectCode(deleteRun(direct.store, direct.job.jobId), 'export.artifact_busy');
	});
});

// --- small pure helpers -------------------------------------------------------------

describe('served job error', () => {
	test('label_key + registry message + details filtered against the CURRENT registry; an unknown code answers only its code', () => {
		const formatSpec = specOf('export.format_limit');
		expect(
			summarizeJobError({
				code: 'export.format_limit',
				// an undeclared key and a non-scalar under a declared one never reach the wire
				details: {
					format: 'xlsx',
					limit: 16384,
					secret: 'x',
				} as unknown as Record<string, string | number>,
			}),
		).toEqual({
			code: 'export.format_limit',
			label_key: formatSpec.label_key,
			message: formatSpec.message,
			retryable: formatSpec.retryable,
			details: { format: 'xlsx', limit: 16384 },
		});
		expect(
			summarizeJobError({
				code: 'export.format_limit',
				details: { format: { nested: 1 } } as unknown as Record<string, string>,
			}),
		).toEqual({
			code: 'export.format_limit',
			label_key: formatSpec.label_key,
			message: formatSpec.message,
			retryable: formatSpec.retryable,
		});
		expect(summarizeJobError({ code: 'no_such.code' })).toEqual({ code: 'no_such.code' });
		expect(summarizeJobError(null)).toBeNull();
	});
});

describe('wire helpers', () => {
	test('a preview cell is bounded in characters; the client renders the same text, only cut', () => {
		const max = PREVIEW_CELL_MAX_CHARS;
		const text: SpoolColLine = { t: 'col', i: 1, cell_type: 'text' };
		const media: SpoolColLine = { t: 'col', i: 2, cell_type: 'img' };
		expect(previewCell(text, 'short')).toBe('short');
		expect(previewCell(text, 42)).toBe(42);
		expect(previewCell(text, null)).toBeNull();
		const long = 'x'.repeat(max * 50);
		expect(previewCell(text, long)).toBe(`${'x'.repeat(max)}…`);
		// an oversized non-string is served as the String() the client renders, cut
		const wide = Array.from({ length: max }, (_, n) => `v${n}`);
		const served = previewCell(text, wide) as string;
		expect(typeof served).toBe('string');
		expect(served.startsWith(String(wide).slice(0, max))).toBe(true);
		expect(served.length).toBe(max + 1);
		// a small object stays as sent
		expect(previewCell(text, { a: 1 })).toEqual({ a: 1 });
		// media: cut at a URL boundary, never inside a URL
		const url = `/media/image/1.5MB/0/test3_test3_${'9'.repeat(40)}.jpg`;
		const urls = Array.from({ length: 200 }, () => url).join(' | ');
		const cutUrls = previewCell(media, urls) as string;
		expect(cutUrls.length).toBeLessThanOrEqual(max);
		expect(cutUrls.split(' | ').every((part) => part === url)).toBe(true);
	});

	test('windowRow keeps only the window cells, each through previewCell', () => {
		const cols: SpoolColLine[] = [
			{ t: 'col', i: 3, cell_type: 'text' },
			{ t: 'col', i: 7, cell_type: 'text' },
		];
		const row = {
			t: 'row' as const,
			rec: 1,
			sub: 0,
			c: { '1': 'out of window', '3': 'y'.repeat(PREVIEW_CELL_MAX_CHARS + 5), '9': 'also out' },
		};
		const cut = windowRow(row, cols);
		expect(Object.keys(cut.c)).toEqual(['3']);
		expect(cut.c['3']).toBe(`${'y'.repeat(PREVIEW_CELL_MAX_CHARS)}…`);
		expect(cut.rec).toBe(1);
	});

	test('origin: an http(s) origin or nothing', () => {
		expect(validOrigin('https://example.org')).toBe('https://example.org');
		expect(validOrigin('http://localhost:3500')).toBe('http://localhost:3500');
		expect(validOrigin('https://example.org/path')).toBe('');
		expect(validOrigin('javascript:alert(1)')).toBe('');
		expect(validOrigin(42)).toBe('');
	});
});
