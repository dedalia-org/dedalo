/**
 * TOOL_EXPORT MEDIA ZIP — behavioural gate for the server-built media archive
 * (tools/tool_export/server/writers/media_zip.ts), through the ONE door a file
 * comes into existence by (writers/index.ts `buildArtifactFile`).
 *
 * THE SITUATION IS BUILT, NOT BORROWED. On the SUITE database (marker-checked)
 * the scope-binding fixture mints user A (test3 = 2, test3.test99 = 2 — the
 * component_image — NOTHING on test3.test85, the component_pdf; own project)
 * and user B (default project). Records are created at runtime through the
 * engine (`createSectionRecord` — A's are born inside A's project, B's outside
 * it), their media column written, and real files planted in the SUITE MEDIA
 * ROOT (config.media.rootPath, repointed + marked by the test_media preload).
 * The export spool lives in a DECLARED scratch export root. Everything is swept.
 *
 * The export runs as A (the manifest's user_id) and asks for the image MASTER
 * ('original'), so every leg says something about the policy:
 *
 *  A. files present → archived STORED, bytes identical, name = basename,
 *     the same file referenced twice archived once, info.txt lists it;
 *  B. a stored file absent from disk → failed 'missing_file';
 *  C. a record outside A's projects → failed 'not_authorized', bytes absent;
 *  D. a component A holds no grant on (test85) → 'not_authorized';
 *  E. a traversal-shaped stored file_path → 'invalid_path'; a symlink inside
 *     the root pointing outside it → 'invalid_path'; the outside bytes absent;
 *  F. a crafted cell naming A's record but not its stored file → 'not_in_record';
 *     an unparseable name in a nested column → 'unidentified';
 *  G. a name outside the grammar in a TOP-LEVEL column → addressed by the row;
 *     a renamed name that FITS the grammar and parses wrong ('inv_a12_<id>.jpg'
 *     → component 'inv') → still addressed by the row, archived;
 *  K. a name addressing a non-media component (nested column) → 'not_media';
 *     no file at the target quality / file_exist false → 'quality_unavailable';
 *     an external source at the target quality → 'external';
 *  H. dedalo_raw cells resolve the same way;
 *  I. quality validation: an off-ladder quality → media.invalid_quality, no file;
 *     a non-media key → request.invalid_options; the variant slug is legal and
 *     distinct per choice;
 *  J. ZIP64 (injected limits) still reads back identically; cancel → nothing.
 *  O. a STORED files_info path is never trusted to name the file: a master
 *     entry A wrote pointing at another user's import CSV, at the .publication
 *     marker store, at B's canonical master in the same bucket, or at a
 *     web-server-denied suffix in A's own folder, or A's own canonical master
 *     symlinked to that CSV (inside the root) → 'invalid_path', bytes absent;
 *  M. 60,000 refused candidates: the writer's heap stays within a few MB (the
 *     failure list lives in an unlinked temp, the candidate memo is a bounded
 *     window) and info.txt is still byte-exact JSON.stringify(failures, null, 2).
 *     The heap is read in its own child (test/helpers/media_zip_heap_child.ts —
 *     the heap holds that writer and nothing else) over 15,000 and 60,000
 *     refusals: under 8 MB at 60,000, and 4x the refusals may add only a small
 *     fraction of the extra archive bytes to the sampled peak (a writer that
 *     keeps the list adds about all of them). Measured in-process, against the
 *     gate's own allocations, the same leg went red in the full unit tier.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { config } from '../../src/config/config.ts';
import { mediaTypeOf } from '../../src/core/concepts/media.ts';
import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { updateMatrixRecord } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { isDedaloError } from '../../src/core/errors/index.ts';
import { resolveMediaPathOptions } from '../../src/core/media/ontology_path.ts';
import { buildMediaLocation, type MediaPathOptions } from '../../src/core/media/path.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { deleteSectionRecord } from '../../src/core/section/record/delete_record.ts';
import {
	clearPermissionsCache,
	clearPrincipalCache,
	clearUserProjectsCache,
	resolvePrincipal,
} from '../../src/core/security/permissions.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { exportRecordScope } from '../../tools/tool_export/server/access.ts';
import {
	type ArtifactJobRef,
	type ArtifactStore,
	openArtifactStore,
} from '../../tools/tool_export/server/artifact_store.ts';
import {
	exportReadSections,
	runBuildExportFile,
	runExportArtifact,
} from '../../tools/tool_export/server/export_job.ts';
import { readExportPreview } from '../../tools/tool_export/server/preview.ts';
import { openSpoolReader } from '../../tools/tool_export/server/spool_reader.ts';
import { buildArtifactFile } from '../../tools/tool_export/server/writers/index.ts';
import {
	isArchivableEntryName,
	MEDIA_ZIP_INFO_NAME,
	mediaZipVariant,
	mediaZipWriter,
	parseMediaFileName,
} from '../../tools/tool_export/server/writers/media_zip.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import { markExportArtifactsRoot } from '../helpers/media_scratch_root.ts';
import type { MediaZipHeapReport } from '../helpers/media_zip_heap_child.ts';
import {
	installScopeBindingFixture,
	removeScopeBindingFixture,
	SB_PROFILE_A,
	SB_PROJECT_OF_A,
	SB_USER_A,
	SB_USER_B,
} from '../helpers/scope_binding_fixture.ts';
import { readZip, type ZipReadResult, zipText } from '../helpers/zip_xml_reader.ts';

const SECTION = 'test3';
const IMAGE = 'test99';
const PDF = 'test85';
const EXPORT_BASE = 'https://media.example.test/dedalo/media';

const image = mediaTypeOf('component_image')!;
const pdf = mediaTypeOf('component_pdf')!;
const MASTER = image.originalQuality;
const DEFAULT = image.defaultQuality;

const createdRecords: number[] = [];
const createdFiles: string[] = [];
const scratchDirs: string[] = [];
let imageOpts: MediaPathOptions;
let pdfOpts: MediaPathOptions;

/** A's records */
let recFull = 0; // default + master present
let recMissing = 0; // master listed, absent on disk
let recTraversal = 0; // master file_path climbs out of the root
let recSymlink = 0; // master is a symlink to a file outside the root
let recRenamed = 0; // files outside the grammar (top-level fallback)
let recGrammarRenamed = 0; // renamed files that FIT the grammar and parse wrong
let recNoMaster = 0; // only the default quality is stored
let recNotExist = 0; // master listed with file_exist false
let recExternal = 0; // master is an external source
/** The renamed name that fits the grammar ('inv' parses as a component tipo). */
const grammarRenamedName = (id: number): string => `inv_a12_${id}.jpg`;
/** B's record — outside A's projects */
let recOut = 0;

let outsideFile = '';
const OUTSIDE_BYTES = 'SECRET OUTSIDE THE MEDIA ROOT';

function fileInfo(quality: string, relativePath: string, exists = true) {
	return {
		quality,
		file_exist: exists,
		file_name: relativePath.split('/').pop(),
		file_path: relativePath,
		file_size: 10,
		file_time: null,
		extension: 'jpg',
	};
}

/** Plant a file (in the suite media root) at a model's canonical location. */
function plant(
	spec: typeof image,
	componentTipo: string,
	sectionId: number,
	quality: string,
	opts: MediaPathOptions,
	extension = 'jpg',
): { relativePath: string; bytes: string } {
	const location = buildMediaLocation(
		spec,
		{ componentTipo, sectionTipo: SECTION, sectionId, lang: null },
		quality,
		extension,
		opts,
	);
	const bytes = `media ${componentTipo} ${sectionId} ${quality} ${'x'.repeat(sectionId % 7)}`;
	mkdirSync(dirname(location.absolutePath), { recursive: true });
	writeFileSync(location.absolutePath, bytes);
	createdFiles.push(location.absolutePath);
	return { relativePath: location.relativePath, bytes };
}

function locationOf(
	spec: typeof image,
	componentTipo: string,
	sectionId: number,
	quality: string,
	opts: MediaPathOptions,
) {
	return buildMediaLocation(
		spec,
		{ componentTipo, sectionTipo: SECTION, sectionId, lang: null },
		quality,
		'jpg',
		opts,
	);
}

async function setMedia(sectionId: number, media: Record<string, unknown>): Promise<void> {
	await updateMatrixRecord('matrix_test', SECTION, sectionId, { media });
}

/**
 * A test3 record created through the engine and filed under ONE project
 * (test101, test3's component_filter): A's own project puts it inside A's
 * scope, the default project outside it.
 */
async function newRecord(userId: number, projectId: number): Promise<number> {
	const id = await createSectionRecord(SECTION, userId);
	createdRecords.push(id);
	await sql.unsafe(
		`UPDATE matrix_test SET relation = coalesce(relation, '{}'::jsonb) || $3::text::jsonb
		 WHERE section_tipo = $1 AND section_id = $2`,
		[
			SECTION,
			id,
			encodeForJsonb({
				test101: [
					{
						id: 1,
						type: 'dd675',
						section_id: projectId,
						section_tipo: config.features.filterSectionTipo,
						from_component_tipo: 'test101',
					},
				],
			}),
		],
	);
	return id;
}

const planted: Record<string, { relativePath: string; bytes: string }> = {};

function removeEmptyDir(dir: string): void {
	try {
		rmdirSync(dir);
	} catch {
		/* not empty (shared bucket) or absent — leave it */
	}
}

/**
 * Every trace this gate's records left in the suite media root: in each
 * quality dir of each model, the records' bucket and its deleted/ folder —
 * only names that carry one of OUR record ids — then the dirs, if empty.
 */
function sweepMediaTraces(): void {
	const root = config.media.rootPath;
	if (root === null) return;
	const models: [typeof image, string, MediaPathOptions][] = [
		[image, IMAGE, imageOpts],
		[pdf, PDF, pdfOpts],
	];
	for (const [spec, tipo, opts] of models) {
		const typeRel = `${spec.folder}${opts.initialMediaPath}`;
		const typeDir = join(root, typeRel);
		if (!existsSync(typeDir)) continue;
		for (const id of createdRecords) {
			const prefix = `${typeRel}/${spec.defaultQuality}`;
			const bucket = dirname(
				locationOf(spec, tipo, id, spec.defaultQuality, opts).relativePath,
			).slice(prefix.length);
			const ours = (name: string): boolean =>
				name.startsWith(`${tipo}_${SECTION}_${id}.`) ||
				name.startsWith(`${tipo}_${SECTION}_${id}_`) ||
				name === `renamed photo ${id}.jpg` ||
				name === grammarRenamedName(id);
			for (const quality of readdirSync(typeDir)) {
				const dir = join(typeDir, quality + bucket);
				for (const sub of [join(dir, 'deleted'), dir]) {
					if (!existsSync(sub)) continue;
					for (const name of readdirSync(sub)) {
						if (ours(name)) rmSync(join(sub, name), { force: true });
					}
					removeEmptyDir(sub);
				}
			}
		}
	}
}

// --------------------------------------------------------------- the export spool

function markedStore(): ArtifactStore {
	const dir = mkdtempSync(join(tmpdir(), 'dedalo_export_media_zip_'));
	scratchDirs.push(dir);
	return openArtifactStore({
		root: markExportArtifactsRoot(join(dir, 'artifacts')),
		quotaBytes: 0,
		ttlHours: 24,
	});
}

type Line = Record<string, unknown>;

async function endedJob(
	store: ArtifactStore,
	lines: Line[],
	dataFormat = 'standard',
	/** The export's options and read set as runExportArtifact records them. */
	recorded: { options?: Record<string, unknown> } = {},
): Promise<ArtifactJobRef> {
	const options = { data_format: dataFormat, breakdown: 'rows', ...(recorded.options ?? {}) };
	const { job } = await store.createJob({
		userId: SB_USER_A,
		sectionTipo: SECTION,
		// exactly what the build records: every section the export READS
		sections: exportReadSections({ section_tipo: SECTION, ...options }),
		options,
		// A's real scope: leg L reaches the job through the owned-job door.
		recordScope: await exportRecordScope(await resolvePrincipal(SB_USER_A)),
		applicationLang: 'lg-eng',
	});
	const writer = await store.openSpoolWriter(job, { indexEvery: 4 });
	for (const line of lines) await writer.write(line);
	await writer.close();
	await store.updateManifest(job, { status: 'ended', ended_at: new Date().toISOString() });
	return job;
}

const url = (relativePath: string): string => `${EXPORT_BASE}${relativePath}`;

async function build(
	store: ArtifactStore,
	job: ArtifactJobRef,
	extra: Record<string, unknown>,
	signal: AbortSignal = new AbortController().signal,
): Promise<{ zip: ZipReadResult; info: string; rows: number }> {
	const file = await buildArtifactFile({
		store,
		job,
		format: 'media_zip',
		options: { origin: 'https://example.test', showTipoInLabel: false, ...extra },
		signal,
	});
	const bytes = new Uint8Array(readFileSync(join(job.dir, file.basename)));
	const zip = readZip(bytes);
	return { zip, info: zipText(zip, MEDIA_ZIP_INFO_NAME), rows: file.rows };
}

function parseInfo(info: string): {
	downloaded: string[];
	failed: { file: string; reason: string }[];
} {
	const downloaded = /Downloaded files: (\[[\s\S]*?\])\nFailed files:/.exec(info)?.[1];
	const failed = /Failed files: (\[[\s\S]*\])\n?$/.exec(info)?.[1];
	return { downloaded: JSON.parse(downloaded ?? 'null'), failed: JSON.parse(failed ?? 'null') };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
	let caught: unknown = null;
	try {
		await promise;
	} catch (error) {
		caught = error;
	}
	expect(isDedaloError(caught), `expected ${code}, got ${String(caught)}`).toBe(true);
	expect((caught as { code: string }).code).toBe(code);
}

function expectNoArtifact(job: ArtifactJobRef): void {
	expect(readdirSync(job.dir).sort()).toEqual([
		'cols.ndjson',
		'grid.idx',
		'grid.ndjson',
		'manifest.json',
		'request.json',
	]);
}

const text = (entry: { data: Uint8Array }): string => new TextDecoder().decode(entry.data);

/** The measured process of leg M (test/helpers/media_zip_heap_child.ts). */
const M_HEAP_CHILD = join(import.meta.dir, '..', 'helpers', 'media_zip_heap_child.ts');
/** Leg M refusal counts: the large spool is M_SCALE × the small one. */
const M_SMALL_REFUSED = 15_000;
const M_SCALE = 4;

/** Leg M's k-th candidate: outside the grammar, with chars JSON escapes. */
const refusedCandidate = (k: number): string => `/nowhere/refused-${k}-${'ñ"\\'.repeat(40)}.jpg`;

/**
 * An ended job whose every candidate is refused 'unidentified' without a DB
 * read: one media column with NO path (no row fallback) and names outside the
 * grammar.
 */
async function refusedJob(store: ArtifactStore, refused: number): Promise<ArtifactJobRef> {
	const lines: Line[] = [
		{ t: 'meta', v: 1, data_format: 'standard', breakdown: 'rows', section_tipo: SECTION },
		{ t: 'col', i: 0, key: 'id', label: 'Id', cell_type: 'section_id', after: null },
		{
			t: 'col',
			i: 1,
			key: 'img',
			label: 'Image',
			cell_type: 'img',
			model: 'component_image',
			after: 0,
		},
	];
	for (let k = 1; k <= refused; k++) {
		lines.push({ t: 'row', rec: k, sub: 0, c: { '0': String(k), '1': refusedCandidate(k) } });
	}
	lines.push({ t: 'end', columns: [0, 1], rows: refused, records: refused });
	return endedJob(store, lines);
}

/** Run mediaZipWriter over `job` in a fresh child; its report. */
async function measureMediaZipHeap(job: ArtifactJobRef): Promise<MediaZipHeapReport> {
	const child = Bun.spawn(
		[process.execPath, 'run', M_HEAP_CHILD, job.dir],
		// the preload-repointed env: the child's module graph opens the SUITE pool
		// (A's principal) and the marked SUITE media root, never the app's
		{ env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' },
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`media zip heap child exited ${exitCode}: ${stderr.slice(-2000)}`);
	}
	return JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as MediaZipHeapReport;
}

/**
 * Sweep everything a describe block of this file created — planted files,
 * test3 records and the rows the engine wrote about them, the media traces,
 * the scratch dirs, the scope-binding fixture — then COUNT what is left (a
 * gate that leaves suite-DB rows behind is red, not quiet). Resets the shared
 * lists, so the next block starts clean.
 */
async function sweepCreated(): Promise<void> {
	// planted files first (so the record delete has nothing to move), then the
	// records, then whatever the delete still parked under deleted/
	for (const path of createdFiles) rmSync(path, { force: true });
	// Every record is attempted: one failed delete must not strand the rest.
	const deleteFailures: unknown[] = [];
	for (const id of createdRecords) {
		try {
			await deleteSectionRecord(SECTION, id, -1);
		} catch (error) {
			deleteFailures.push(error);
		}
	}
	// The rows the engine wrote ABOUT these records: the create/delete
	// activity (dd542) and the delete's time-machine snapshot. Swept, then
	// COUNTED — a gate that leaves suite-DB rows behind is red, not quiet.
	const ids = createdRecords.map(String);
	await sql.unsafe(
		'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id::text = ANY($2::text[])',
		[SECTION, `{${ids.join(',')}}`],
	);
	await sql.unsafe(
		`DELETE FROM matrix_activity
		 WHERE section_tipo = 'dd542'
		   AND misc->'dd551'->0->'value'->>'section_tipo' = $1
		   AND misc->'dd551'->0->'value'->>'section_id' = ANY($2::text[])`,
		[SECTION, `{${ids.join(',')}}`],
	);
	const [left] = (await sql.unsafe(
		`SELECT
		   (SELECT count(*) FROM matrix_test WHERE section_tipo = $1 AND section_id::text = ANY($2::text[]))
		 + (SELECT count(*) FROM matrix_time_machine WHERE section_tipo = $1 AND section_id::text = ANY($2::text[]))
		 + (SELECT count(*) FROM matrix_activity WHERE section_tipo = 'dd542'
		      AND misc->'dd551'->0->'value'->>'section_tipo' = $1
		      AND misc->'dd551'->0->'value'->>'section_id' = ANY($2::text[])) AS n`,
		[SECTION, `{${ids.join(',')}}`],
	)) as { n: number | string }[];
	sweepMediaTraces();
	for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
	await removeScopeBindingFixture();
	createdRecords.length = 0;
	createdFiles.length = 0;
	scratchDirs.length = 0;
	expect(deleteFailures).toEqual([]);
	expect(Number(left?.n)).toBe(0);
}

// ------------------------------------------------------------------ situation

describe.if(DB_READY)('tool_export media ZIP — built on the server, authorized per file', () => {
	beforeAll(async () => {
		await assertTestDatabase('tool_export_media_zip_native');
		await installScopeBindingFixture();
		imageOpts = await resolveMediaPathOptions(IMAGE, SECTION);
		pdfOpts = await resolveMediaPathOptions(PDF, SECTION);

		// A: default + master present
		recFull = await newRecord(SB_USER_A, SB_PROJECT_OF_A);
		planted.fullDefault = plant(image, IMAGE, recFull, DEFAULT, imageOpts);
		planted.fullMaster = plant(image, IMAGE, recFull, MASTER, imageOpts);
		planted.pdfWeb = plant(pdf, PDF, recFull, pdf.defaultQuality, pdfOpts, 'pdf');
		await setMedia(recFull, {
			[IMAGE]: [
				{
					id: 1,
					files_info: [
						fileInfo(MASTER, planted.fullMaster.relativePath),
						fileInfo(DEFAULT, planted.fullDefault.relativePath),
					],
				},
			],
			[PDF]: [{ id: 1, files_info: [fileInfo(pdf.defaultQuality, planted.pdfWeb.relativePath)] }],
		});

		// A: master listed but absent
		recMissing = await newRecord(SB_USER_A, SB_PROJECT_OF_A);
		planted.missingDefault = plant(image, IMAGE, recMissing, DEFAULT, imageOpts);
		const missingMaster = locationOf(image, IMAGE, recMissing, MASTER, imageOpts);
		await setMedia(recMissing, {
			[IMAGE]: [
				{
					id: 1,
					files_info: [
						fileInfo(DEFAULT, planted.missingDefault.relativePath),
						fileInfo(MASTER, missingMaster.relativePath),
					],
				},
			],
		});

		// outside file (for the traversal + symlink legs)
		const outsideDir = mkdtempSync(join(tmpdir(), 'dedalo_media_zip_outside_'));
		scratchDirs.push(outsideDir);
		outsideFile = join(outsideDir, 'secret.jpg');
		writeFileSync(outsideFile, OUTSIDE_BYTES);

		// A: master file_path climbs out of the media root
		recTraversal = await newRecord(SB_USER_A, SB_PROJECT_OF_A);
		planted.travDefault = plant(image, IMAGE, recTraversal, DEFAULT, imageOpts);
		await setMedia(recTraversal, {
			[IMAGE]: [
				{
					id: 1,
					files_info: [
						fileInfo(DEFAULT, planted.travDefault.relativePath),
						fileInfo(MASTER, `/image/${MASTER}/../../../../../../..${outsideFile}`),
					],
				},
			],
		});

		// A: master is a symlink leaving the root
		recSymlink = await newRecord(SB_USER_A, SB_PROJECT_OF_A);
		planted.symDefault = plant(image, IMAGE, recSymlink, DEFAULT, imageOpts);
		const symMaster = locationOf(image, IMAGE, recSymlink, MASTER, imageOpts);
		mkdirSync(dirname(symMaster.absolutePath), { recursive: true });
		symlinkSync(outsideFile, symMaster.absolutePath);
		createdFiles.push(symMaster.absolutePath);
		await setMedia(recSymlink, {
			[IMAGE]: [
				{
					id: 1,
					files_info: [
						fileInfo(DEFAULT, planted.symDefault.relativePath),
						fileInfo(MASTER, symMaster.relativePath),
					],
				},
			],
		});

		// A: files renamed outside the grammar (properties.image_id-style)
		recRenamed = await newRecord(SB_USER_A, SB_PROJECT_OF_A);
		const renamedDir = dirname(
			locationOf(image, IMAGE, recRenamed, MASTER, imageOpts).absolutePath,
		);
		const renamedDefaultDir = dirname(
			locationOf(image, IMAGE, recRenamed, DEFAULT, imageOpts).absolutePath,
		);
		const renamedMasterRel = `${dirname(locationOf(image, IMAGE, recRenamed, MASTER, imageOpts).relativePath)}/renamed photo ${recRenamed}.jpg`;
		const renamedDefaultRel = `${dirname(locationOf(image, IMAGE, recRenamed, DEFAULT, imageOpts).relativePath)}/renamed photo ${recRenamed}.jpg`;
		mkdirSync(renamedDir, { recursive: true });
		mkdirSync(renamedDefaultDir, { recursive: true });
		planted.renamedMaster = {
			relativePath: renamedMasterRel,
			bytes: `renamed master ${recRenamed}`,
		};
		writeFileSync(join(renamedDir, `renamed photo ${recRenamed}.jpg`), planted.renamedMaster.bytes);
		writeFileSync(join(renamedDefaultDir, `renamed photo ${recRenamed}.jpg`), 'renamed default');
		createdFiles.push(
			join(renamedDir, `renamed photo ${recRenamed}.jpg`),
			join(renamedDefaultDir, `renamed photo ${recRenamed}.jpg`),
		);
		await setMedia(recRenamed, {
			[IMAGE]: [
				{
					id: 1,
					files_info: [fileInfo(DEFAULT, renamedDefaultRel), fileInfo(MASTER, renamedMasterRel)],
				},
			],
		});

		// A: renamed files that FIT the grammar and parse to a wrong address
		recGrammarRenamed = await newRecord(SB_USER_A, SB_PROJECT_OF_A);
		const grName = grammarRenamedName(recGrammarRenamed);
		const grMasterAbs = join(
			dirname(locationOf(image, IMAGE, recGrammarRenamed, MASTER, imageOpts).absolutePath),
			grName,
		);
		const grDefaultAbs = join(
			dirname(locationOf(image, IMAGE, recGrammarRenamed, DEFAULT, imageOpts).absolutePath),
			grName,
		);
		planted.grMaster = {
			relativePath: `${dirname(locationOf(image, IMAGE, recGrammarRenamed, MASTER, imageOpts).relativePath)}/${grName}`,
			bytes: `grammar-renamed master ${recGrammarRenamed}`,
		};
		planted.grDefault = {
			relativePath: `${dirname(locationOf(image, IMAGE, recGrammarRenamed, DEFAULT, imageOpts).relativePath)}/${grName}`,
			bytes: `grammar-renamed default ${recGrammarRenamed}`,
		};
		mkdirSync(dirname(grMasterAbs), { recursive: true });
		mkdirSync(dirname(grDefaultAbs), { recursive: true });
		writeFileSync(grMasterAbs, planted.grMaster.bytes);
		writeFileSync(grDefaultAbs, planted.grDefault.bytes);
		createdFiles.push(grMasterAbs, grDefaultAbs);
		await setMedia(recGrammarRenamed, {
			[IMAGE]: [
				{
					id: 1,
					files_info: [
						fileInfo(DEFAULT, planted.grDefault.relativePath),
						fileInfo(MASTER, planted.grMaster.relativePath),
					],
				},
			],
		});

		// A: only the default quality stored
		recNoMaster = await newRecord(SB_USER_A, SB_PROJECT_OF_A);
		planted.noMasterDefault = plant(image, IMAGE, recNoMaster, DEFAULT, imageOpts);
		await setMedia(recNoMaster, {
			[IMAGE]: [{ id: 1, files_info: [fileInfo(DEFAULT, planted.noMasterDefault.relativePath)] }],
		});

		// A: master listed but file_exist false (a file planted there anyway: the
		// flag, not the disk, is what says there is no master)
		recNotExist = await newRecord(SB_USER_A, SB_PROJECT_OF_A);
		planted.notExistDefault = plant(image, IMAGE, recNotExist, DEFAULT, imageOpts);
		planted.notExistMaster = plant(image, IMAGE, recNotExist, MASTER, imageOpts);
		await setMedia(recNotExist, {
			[IMAGE]: [
				{
					id: 1,
					files_info: [
						fileInfo(DEFAULT, planted.notExistDefault.relativePath),
						fileInfo(MASTER, planted.notExistMaster.relativePath, false),
					],
				},
			],
		});

		// A: master is an external source (a URL, not a file on disk)
		recExternal = await newRecord(SB_USER_A, SB_PROJECT_OF_A);
		planted.externalDefault = plant(image, IMAGE, recExternal, DEFAULT, imageOpts);
		await setMedia(recExternal, {
			[IMAGE]: [
				{
					id: 1,
					files_info: [
						fileInfo(DEFAULT, planted.externalDefault.relativePath),
						{
							...fileInfo(MASTER, `https://external.example.test/master_${recExternal}.jpg`),
							external: true,
						},
					],
				},
			],
		});

		// B: outside A's projects
		recOut = await newRecord(SB_USER_B, config.features.defaultProject);
		planted.outDefault = plant(image, IMAGE, recOut, DEFAULT, imageOpts);
		planted.outMaster = plant(image, IMAGE, recOut, MASTER, imageOpts);
		await setMedia(recOut, {
			[IMAGE]: [
				{
					id: 1,
					files_info: [
						fileInfo(DEFAULT, planted.outDefault.relativePath),
						fileInfo(MASTER, planted.outMaster.relativePath),
					],
				},
			],
		});
	});

	afterAll(sweepCreated);

	/** A standard-format export: a top-level image column, a nested image column, the pdf column. */
	function standardLines(): Line[] {
		const lines: Line[] = [
			{ t: 'meta', v: 1, data_format: 'standard', breakdown: 'rows', section_tipo: SECTION },
			{ t: 'col', i: 0, key: 'id', label: 'Id', cell_type: 'section_id', after: null },
			{
				t: 'col',
				i: 1,
				key: IMAGE,
				label: 'Image',
				cell_type: 'img',
				model: 'component_image',
				path: [{ section_tipo: SECTION, component_tipo: IMAGE }],
				after: 0,
			},
			{
				t: 'col',
				i: 2,
				key: `test80_${IMAGE}`,
				label: 'Linked image',
				cell_type: 'img',
				model: 'component_image',
				path: [
					{ section_tipo: SECTION, component_tipo: 'test80' },
					{ section_tipo: SECTION, component_tipo: IMAGE },
				],
				after: 1,
			},
			{
				t: 'col',
				i: 3,
				key: PDF,
				label: 'Pdf',
				cell_type: 'text',
				model: 'component_pdf',
				path: [{ section_tipo: SECTION, component_tipo: PDF }],
				after: 2,
			},
		];
		const rows: Line[] = [
			{
				rec: recFull,
				c: {
					'0': String(recFull),
					'1': url(planted.fullDefault!.relativePath),
					// the SAME file again via the nested column (+ a crafted + an unparseable candidate)
					'2': [
						`${url(planted.fullDefault!.relativePath)}?v=9`, // same file, other text
						url(`/image/${DEFAULT}/elsewhere/${IMAGE}_${SECTION}_${recFull}.jpg`),
						'https://cdn.example.test/foo.jpg',
						// names a NON-media component (test80, the portal) of A's record
						url(`/image/${DEFAULT}/unrelated/test80_${SECTION}_${recFull}.jpg`),
					].join(' | '),
					'3': url(planted.pdfWeb!.relativePath),
				},
			},
			{ rec: recMissing, c: { '1': url(planted.missingDefault!.relativePath) } },
			{ rec: recTraversal, c: { '1': url(planted.travDefault!.relativePath) } },
			{ rec: recSymlink, c: { '1': `${url(planted.symDefault!.relativePath)}?v=3` } },
			{
				rec: recRenamed,
				c: {
					'1': url(
						`${dirname(locationOf(image, IMAGE, recRenamed, DEFAULT, imageOpts).relativePath)}/renamed photo ${recRenamed}.jpg`,
					),
				},
			},
			{ rec: recGrammarRenamed, c: { '1': url(planted.grDefault!.relativePath) } },
			{ rec: recNoMaster, c: { '1': url(planted.noMasterDefault!.relativePath) } },
			{ rec: recNotExist, c: { '1': url(planted.notExistDefault!.relativePath) } },
			{ rec: recExternal, c: { '1': url(planted.externalDefault!.relativePath) } },
			// B's record reaches A's export through a portal (nested column)
			{ rec: recFull, c: { '2': url(planted.outDefault!.relativePath) } },
		];
		let n = 0;
		for (const row of rows) {
			lines.push({ t: 'row', rec: row.rec, sub: 0, c: row.c });
			n++;
		}
		lines.push({ t: 'end', columns: [0, 1, 2, 3], rows: n, records: n });
		return lines;
	}

	test('A-G. the master archive: authorized files in, every refusal listed with its reason', async () => {
		const store = markedStore();
		const job = await endedJob(store, standardLines());
		const { zip, info, rows } = await build(store, job, {
			mediaQualities: { component_image: MASTER, component_pdf: pdf.defaultQuality },
		});

		const names = zip.entries.map((entry) => entry.name);
		const fullMasterName = planted.fullMaster!.relativePath.split('/').pop()!;
		// A: present master archived STORED, bytes identical, once (referenced twice)
		expect(names.filter((name) => name === fullMasterName)).toHaveLength(1);
		const fullEntry = zip.entries.find((entry) => entry.name === fullMasterName)!;
		expect(fullEntry.method).toBe(0);
		expect(text(fullEntry)).toBe(planted.fullMaster!.bytes);
		// G: renamed file addressed by the row (top-level column)
		const renamedEntry = zip.entries.find(
			(entry) => entry.name === `renamed photo ${recRenamed}.jpg`,
		);
		expect(renamedEntry && text(renamedEntry)).toBe(planted.renamedMaster!.bytes);
		// G: a renamed name that FITS the grammar ('inv' is no component) → the row
		const grEntry = zip.entries.find(
			(entry) => entry.name === grammarRenamedName(recGrammarRenamed),
		);
		expect(grEntry && text(grEntry)).toBe(planted.grMaster!.bytes);
		// info.txt last; exactly the three authorized files + info
		expect(names[names.length - 1]).toBe(MEDIA_ZIP_INFO_NAME);
		const archived = [
			fullMasterName,
			`renamed photo ${recRenamed}.jpg`,
			grammarRenamedName(recGrammarRenamed),
		];
		expect(names.sort()).toEqual([...archived, MEDIA_ZIP_INFO_NAME].sort());
		expect(rows).toBe(3);
		// nothing from outside the root, nothing of B's, no pdf
		for (const entry of zip.entries) {
			expect(text(entry)).not.toContain(OUTSIDE_BYTES);
			expect(text(entry)).not.toBe(planted.outMaster!.bytes);
			// a master whose record says file_exist false is not archived
			expect(text(entry)).not.toBe(planted.notExistMaster!.bytes);
		}

		const { downloaded, failed } = parseInfo(info);
		expect(downloaded.sort()).toEqual([...archived].sort());
		const reasonOf = (needle: string): string[] =>
			failed.filter((item) => item.file.includes(needle)).map((item) => item.reason);
		// B: missing master
		expect(reasonOf(locationOf(image, IMAGE, recMissing, MASTER, imageOpts).relativePath)).toEqual([
			'missing_file',
		]);
		// C: B's record, outside A's projects
		expect(reasonOf(planted.outDefault!.relativePath)).toEqual(['not_authorized']);
		// D: the pdf component A holds no grant on
		expect(reasonOf(planted.pdfWeb!.relativePath)).toEqual(['not_authorized']);
		// E: traversal + symlink
		expect(reasonOf(outsideFile)).toEqual(['invalid_path']);
		expect(reasonOf(locationOf(image, IMAGE, recSymlink, MASTER, imageOpts).relativePath)).toEqual([
			'invalid_path',
		]);
		// F: crafted name of A's record / unparseable name in a nested column
		expect(reasonOf('/elsewhere/')).toEqual(['not_in_record']);
		expect(reasonOf('cdn.example.test/foo.jpg')).toEqual(['unidentified']);
		// K: non-media component / no master / file_exist false / external master
		expect(reasonOf(`test80_${SECTION}_${recFull}.jpg`)).toEqual(['not_media']);
		expect(reasonOf(planted.noMasterDefault!.relativePath)).toEqual(['quality_unavailable']);
		expect(reasonOf(planted.notExistDefault!.relativePath)).toEqual(['quality_unavailable']);
		expect(reasonOf(planted.externalDefault!.relativePath)).toEqual(['external']);
		expect(failed).toHaveLength(11);
		expect(info).toContain(`component_image: ${MASTER}`);
	});

	test('P. a legacy file name no ZIP entry can carry is listed invalid_path — one odd name never aborts the archive', async () => {
		// properties.image_id renames may hold ANY name; a drive-like prefix is one
		// the zip writer refuses (normalizeZipEntryName). Its good twin sits in the
		// same record, same folder.
		const rec = await newRecord(SB_USER_A, SB_PROJECT_OF_A);
		const dirOf = (quality: string) => ({
			rel: dirname(locationOf(image, IMAGE, rec, quality, imageOpts).relativePath),
			abs: dirname(locationOf(image, IMAGE, rec, quality, imageOpts).absolutePath),
		});
		const odd = `D:scan ${rec}.jpg`;
		const good = `legacy scan ${rec}.jpg`;
		const items = [];
		for (const [n, name] of [odd, good].entries()) {
			for (const quality of [DEFAULT, MASTER]) {
				const dir = dirOf(quality);
				mkdirSync(dir.abs, { recursive: true });
				writeFileSync(join(dir.abs, name), `${quality} ${name}`);
				createdFiles.push(join(dir.abs, name));
			}
			items.push({
				id: n + 1,
				files_info: [
					fileInfo(DEFAULT, `${dirOf(DEFAULT).rel}/${name}`),
					fileInfo(MASTER, `${dirOf(MASTER).rel}/${name}`),
				],
			});
		}
		await setMedia(rec, { [IMAGE]: items });
		const lines = standardLines().filter((line) => line.t !== 'row' && line.t !== 'end');
		lines.push({
			t: 'row',
			rec,
			sub: 0,
			c: { '1': [odd, good].map((name) => url(`${dirOf(DEFAULT).rel}/${name}`)).join(' | ') },
		});
		lines.push({ t: 'end', columns: [0, 1, 2, 3], rows: 1, records: 1 });
		const store = markedStore();
		const job = await endedJob(store, lines);
		const { zip, info, rows } = await build(store, job, { mediaQuality: MASTER });
		expect(zip.entries.map((entry) => entry.name).sort()).toEqual(
			[good, MEDIA_ZIP_INFO_NAME].sort(),
		);
		expect(rows).toBe(1);
		const { failed } = parseInfo(info);
		expect(failed).toEqual([{ file: `${dirOf(MASTER).rel}/${odd}`, reason: 'invalid_path' }]);
	});

	test('O. a stored file_path names only the record own file: forged paths inside the root are refused', async () => {
		const root = config.media.rootPath as string;
		const tag = `mz_forge_${process.pid}_${Date.now()}`;
		// Files the web server denies to EVERYONE, logged in or not.
		const importDir = join(root, 'import', 'files', String(SB_USER_B));
		const pubDir = join(root, '.publication', 'pub');
		const madeDirs: string[] = [];
		for (const dir of [
			join(root, 'import'),
			join(root, 'import', 'files'),
			importDir,
			join(root, '.publication'),
			pubDir,
		]) {
			if (!existsSync(dir)) {
				mkdirSync(dir);
				madeDirs.push(dir);
			}
		}
		const importCsv = join(importDir, `${tag}.csv`);
		const pubMarker = join(pubDir, `${tag}_marker`);
		const IMPORT_BYTES = `SECRET IMPORT CSV ${tag}`;
		const PUB_BYTES = `SECRET PUBLICATION MARKER ${tag}`;
		writeFileSync(importCsv, IMPORT_BYTES);
		writeFileSync(pubMarker, PUB_BYTES);
		const forgedFiles = [importCsv, pubMarker];
		try {
			const forged: { id: number; master: string }[] = [];
			const forge = async (master: (id: number) => string): Promise<void> => {
				const id = await newRecord(SB_USER_A, SB_PROJECT_OF_A);
				const def = plant(image, IMAGE, id, DEFAULT, imageOpts);
				planted[`forged_${id}`] = def;
				const path = master(id);
				forged.push({ id, master: path });
				await setMedia(id, {
					[IMAGE]: [
						{ id: 1, files_info: [fileInfo(DEFAULT, def.relativePath), fileInfo(MASTER, path)] },
					],
				});
			};
			await forge(() => `/import/files/${SB_USER_B}/${tag}.csv`);
			await forge(() => `/.publication/pub/${tag}_marker`);
			// B's master: same model, same bucket — another record's canonical file
			await forge(() => planted.outMaster!.relativePath);
			// a denied working-file suffix in A's OWN master folder, named after A's own record
			const DENIED_BYTES = `SECRET WORKING FILE ${tag}`;
			await forge((id) => {
				const own = locationOf(image, IMAGE, id, MASTER, imageOpts);
				const csv = own.absolutePath.replace(/\.jpg$/, '.csv');
				mkdirSync(dirname(csv), { recursive: true });
				writeFileSync(csv, DENIED_BYTES);
				forgedFiles.push(csv);
				return own.relativePath.replace(/\.jpg$/, '.csv');
			});

			// A's OWN canonical master, a symlink to the import CSV — still inside the root
			await forge((id) => {
				const own = locationOf(image, IMAGE, id, MASTER, imageOpts);
				mkdirSync(dirname(own.absolutePath), { recursive: true });
				symlinkSync(importCsv, own.absolutePath);
				forgedFiles.push(own.absolutePath);
				return own.relativePath;
			});

			const lines: Line[] = [
				{ t: 'meta', v: 1, data_format: 'standard', breakdown: 'rows', section_tipo: SECTION },
				{
					t: 'col',
					i: 0,
					key: IMAGE,
					label: 'Image',
					cell_type: 'img',
					model: 'component_image',
					path: [{ section_tipo: SECTION, component_tipo: IMAGE }],
					after: null,
				},
			];
			for (const { id } of forged) {
				lines.push({
					t: 'row',
					rec: id,
					sub: 0,
					c: { '0': url(planted[`forged_${id}`]!.relativePath) },
				});
			}
			lines.push({ t: 'end', columns: [0], rows: forged.length, records: forged.length });
			const store = markedStore();
			const job = await endedJob(store, lines);
			const { zip, info, rows } = await build(store, job, {
				mediaQualities: { component_image: MASTER },
			});

			expect(rows).toBe(0);
			expect(zip.entries.map((entry) => entry.name)).toEqual([MEDIA_ZIP_INFO_NAME]);
			for (const entry of zip.entries) {
				for (const secret of [IMPORT_BYTES, PUB_BYTES, DENIED_BYTES, planted.outMaster!.bytes]) {
					expect(text(entry)).not.toContain(secret);
				}
			}
			const { failed } = parseInfo(info);
			expect(failed).toEqual(
				forged.map(({ master }) => ({ file: master, reason: 'invalid_path' })),
			);
		} finally {
			for (const file of forgedFiles) rmSync(file, { force: true });
			for (const dir of madeDirs.reverse()) removeEmptyDir(dir);
		}
	});

	test('the default quality archives the default files of the same records', async () => {
		const store = markedStore();
		const job = await endedJob(store, standardLines());
		const { zip, info } = await build(store, job, {});
		const byName = new Map(zip.entries.map((entry) => [entry.name, text(entry)]));
		// eight A default files (full, missing-master's, traversal's, symlink's,
		// no-master's, not-exist's, external's, grammar-renamed) + renamed + info
		expect(byName.get(planted.fullDefault!.relativePath.split('/').pop()!)).toBe(
			planted.fullDefault!.bytes,
		);
		expect(byName.get(planted.symDefault!.relativePath.split('/').pop()!)).toBe(
			planted.symDefault!.bytes,
		);
		expect(byName.get(grammarRenamedName(recGrammarRenamed))).toBe(planted.grDefault!.bytes);
		expect(zip.entries).toHaveLength(10);
		const { failed } = parseInfo(info);
		expect(failed.map((item) => item.reason).sort()).toEqual(
			['not_authorized', 'not_authorized', 'not_in_record', 'unidentified', 'not_media'].sort(),
		);
	});

	test('G2. the row fallback follows the SELECTION, not the read set: a portal column into another section keeps it', async () => {
		// A top-level image column + a portal column whose path steps into ANOTHER
		// section: the export READS two sections, its rows are still one section's.
		const OTHER = 'test2';
		const renamedRow = (): Line[] => [
			{ t: 'meta', v: 1, data_format: 'standard', breakdown: 'rows', section_tipo: SECTION },
			{
				t: 'col',
				i: 0,
				key: IMAGE,
				label: 'Image',
				cell_type: 'img',
				model: 'component_image',
				path: [{ section_tipo: SECTION, component_tipo: IMAGE }],
				after: null,
			},
			{
				t: 'row',
				rec: recRenamed,
				sub: 0,
				c: {
					'0': url(
						`${dirname(locationOf(image, IMAGE, recRenamed, DEFAULT, imageOpts).relativePath)}/renamed photo ${recRenamed}.jpg`,
					),
				},
			},
			{ t: 'end', columns: [0], rows: 1, records: 1 },
		];
		const portalColumn = {
			path: [
				{ section_tipo: SECTION, component_tipo: 'test80' },
				{ section_tipo: OTHER, component_tipo: 'test52' },
			],
		};
		const oneSectionSelection = {
			sqo: { section_tipo: [SECTION] },
			ar_ddo_to_export: [
				{ path: [{ section_tipo: SECTION, component_tipo: IMAGE }] },
				portalColumn,
			],
		};
		const store = markedStore();
		const job = await endedJob(store, renamedRow(), 'standard', { options: oneSectionSelection });
		// non-vacuous: the READ set really is two sections
		expect((await store.readManifest(job)).sections.sort()).toEqual([SECTION, OTHER].sort());
		const { zip, info } = await build(store, job, { mediaQualities: { component_image: MASTER } });
		const renamed = zip.entries.find((entry) => entry.name === `renamed photo ${recRenamed}.jpg`);
		expect(renamed && text(renamed)).toBe(planted.renamedMaster!.bytes);
		expect(parseInfo(info).failed).toEqual([]);

		// Control: a selection of TWO sections makes `rec` ambiguous — no fallback.
		const twoSections = markedStore();
		const ambiguous = await endedJob(twoSections, renamedRow(), 'standard', {
			options: { ...oneSectionSelection, sqo: { section_tipo: [SECTION, OTHER] } },
		});
		const refused = await build(twoSections, ambiguous, {
			mediaQualities: { component_image: MASTER },
		});
		expect(refused.zip.entries.map((entry) => entry.name)).toEqual([MEDIA_ZIP_INFO_NAME]);
		expect(parseInfo(refused.info).failed.map((item) => item.reason)).toEqual(['unidentified']);
	});

	test('H. dedalo_raw cells resolve through the record, not the cell', async () => {
		const store = markedStore();
		const raw = (items: unknown[]) => JSON.stringify({ dedalo_data: items });
		const lines: Line[] = [
			{ t: 'meta', v: 1, data_format: 'dedalo_raw', section_tipo: SECTION },
			{
				t: 'col',
				i: 0,
				key: IMAGE,
				label: 'Image',
				cell_type: 'json',
				model: 'component_image',
				path: [{ section_tipo: SECTION, component_tipo: IMAGE }],
				after: null,
			},
			{
				t: 'row',
				rec: recFull,
				sub: 0,
				c: {
					'0': raw([
						// the cell names only the DEFAULT file; the master is re-read from the record
						{ files_info: [fileInfo(DEFAULT, planted.fullDefault!.relativePath)] },
					]),
				},
			},
			{
				t: 'row',
				rec: recOut,
				sub: 0,
				c: { '0': raw([{ files_info: [fileInfo(DEFAULT, planted.outDefault!.relativePath)] }]) },
			},
			{ t: 'row', rec: recMissing, sub: 0, c: { '0': '{not json' } },
			{ t: 'end', columns: [0], rows: 3, records: 3 },
		];
		const job = await endedJob(store, lines, 'dedalo_raw');
		const { zip, info } = await build(store, job, { mediaQuality: MASTER });
		const fullMasterName = planted.fullMaster!.relativePath.split('/').pop()!;
		expect(zip.entries.map((entry) => entry.name)).toEqual([fullMasterName, MEDIA_ZIP_INFO_NAME]);
		expect(text(zip.entries[0]!)).toBe(planted.fullMaster!.bytes);
		const { failed } = parseInfo(info);
		expect(failed.map((item) => item.reason).sort()).toEqual(['not_authorized', 'unreadable_cell']);
	});

	test('I. quality validation refuses before anything is written; the variant is a legal, distinct slug', async () => {
		const store = markedStore();
		const job = await endedJob(store, standardLines());
		await expectCode(
			build(store, job, { mediaQualities: { component_image: 'bogus' } }),
			'media.invalid_quality',
		);
		expectNoArtifact(job);
		await expectCode(
			build(store, job, { mediaQualities: { component_image: '../original' } }),
			'media.invalid_quality',
		);
		await expectCode(
			build(store, job, { mediaQualities: { component_input_text: DEFAULT } }),
			'request.invalid_options',
		);
		// one quality for every model must be valid for every model present
		await expectCode(build(store, job, { mediaQuality: DEFAULT }), 'media.invalid_quality');
		expectNoArtifact(job);

		const variants = [
			mediaZipVariant({ mediaQuality: '1.5MB' }),
			mediaZipVariant({ mediaQuality: '<1MB' }),
			mediaZipVariant({ mediaQuality: '15MB' }),
			mediaZipVariant({ mediaQualities: { component_image: '1.5MB' } }),
			mediaZipVariant({}),
		];
		for (const variant of variants) expect(variant).toMatch(/^[a-z0-9]{1,32}$/);
		expect(new Set(variants).size).toBe(variants.length);
		expect(mediaZipVariant({ mediaQualities: { component_av: 'x', component_image: 'y' } })).toBe(
			mediaZipVariant({ mediaQualities: { component_image: 'y', component_av: 'x' } }),
		);
	});

	test('L. the ACTION carries a per-model choice: a mixed image+pdf export builds at the master', async () => {
		// Through runBuildExportFile — the build_export_file action's body — not
		// the writer seam: the options the client sends (media_qualities) must
		// reach the writer, and the file name must hash the whole choice.
		const store = markedStore();
		const job = await endedJob(store, standardLines());
		const principal = await resolvePrincipal(SB_USER_A);
		const run = (extra: Record<string, unknown>) =>
			runBuildExportFile({
				store,
				principal,
				userId: SB_USER_A,
				options: {
					section_tipo: SECTION,
					job_id: job.jobId,
					format: 'media_zip',
					origin: 'https://example.test',
					...extra,
				},
				signal: new AbortController().signal,
			});
		const choice = { component_image: MASTER, component_pdf: pdf.defaultQuality };
		const result = await run({ media_qualities: choice });
		expect(result.basename).toBe(`media_${mediaZipVariant({ mediaQualities: choice })}.zip`);
		expect(result.url).toContain(`/${job.jobId}/${result.basename}`);
		const zip = readZip(new Uint8Array(readFileSync(join(job.dir, result.basename))));
		const fullMasterName = planted.fullMaster!.relativePath.split('/').pop()!;
		expect(zip.entries.map((entry) => entry.name)).toContain(fullMasterName);
		expect(result.rows).toBe(3);
		// the single shorthand cannot serve both models (the pdf ladder has no image default)
		await expectCode(run({ media_quality: DEFAULT }), 'media.invalid_quality');
		// a malformed choice is refused before anything is written
		await expectCode(run({ media_qualities: ['original'] }), 'request.invalid_options');
		// no choice: the defaults' archive, the plain name
		expect((await run({})).basename).toBe('media.zip');
	});

	test('J. ZIP64 (injected limits) reads back identically; cancel leaves nothing', async () => {
		const store = markedStore();
		const job = await endedJob(store, standardLines());
		const { zip } = await build(store, job, {
			mediaQualities: { component_image: MASTER, component_pdf: pdf.defaultQuality },
			zip64Limits: { size: 8, count: 2 },
		});
		expect(zip.zip64End).toBe(true);
		const fullMasterName = planted.fullMaster!.relativePath.split('/').pop()!;
		const entry = zip.entries.find((item) => item.name === fullMasterName)!;
		expect(entry.centralZip64 || entry.localZip64).toBe(true);
		expect(text(entry)).toBe(planted.fullMaster!.bytes);

		const cancelled = markedStore();
		const cancelJob = await endedJob(cancelled, standardLines());
		// a signal that turns aborted MID-WRITE (after the writer has started reading)
		let reads = 0;
		const midWrite = {
			get aborted() {
				reads++;
				return reads > 4;
			},
		} as unknown as AbortSignal;
		await expectCode(
			build(
				cancelled,
				cancelJob,
				{ mediaQualities: { component_image: MASTER, component_pdf: pdf.defaultQuality } },
				midWrite,
			),
			'export.cancelled',
		);
		expect(reads).toBeGreaterThan(4);
		expectNoArtifact(cancelJob);
	});

	test('K. Stop is honoured INSIDE one large file, not only between files', async () => {
		// A master can be tens of GB and export_file lane jobs have no default
		// deadline: a Stop that waits for the file to finish keeps the lane slot
		// and fills the temp file against the quota. The signal turns aborted once
		// the archive under construction is past ABORT_AT bytes — i.e. mid-file —
		// and the build must stop there, far short of the file's size.
		const BIG = 48 * 1024 * 1024;
		const ABORT_AT = 2 * 1024 * 1024;
		const masterPath = locationOf(image, IMAGE, recFull, MASTER, imageOpts).absolutePath;
		const original = readFileSync(masterPath);
		writeFileSync(masterPath, new Uint8Array(BIG).fill(0x61));
		try {
			const store = markedStore();
			const job = await endedJob(store, standardLines());
			const spoolFiles = new Set(readdirSync(job.dir));
			let archiveBytesAtAbort = -1;
			const archiveBytes = (): number =>
				readdirSync(job.dir)
					.filter((name) => !spoolFiles.has(name))
					.reduce((sum, name) => {
						try {
							return sum + statSync(join(job.dir, name)).size;
						} catch {
							return sum; // committed/unlinked between readdir and stat
						}
					}, 0);
			const midFile = {
				get aborted() {
					if (archiveBytesAtAbort >= 0) return true;
					const bytes = archiveBytes();
					if (bytes < ABORT_AT) return false;
					archiveBytesAtAbort = bytes;
					return true;
				},
			} as unknown as AbortSignal;
			await expectCode(
				build(
					store,
					job,
					{ mediaQualities: { component_image: MASTER, component_pdf: pdf.defaultQuality } },
					midFile,
				),
				'export.cancelled',
			);
			expect(archiveBytesAtAbort).toBeGreaterThanOrEqual(ABORT_AT);
			// stopped within a few chunks of the trigger, not after the whole file
			expect(archiveBytesAtAbort).toBeLessThan(BIG / 2);
			expectNoArtifact(job);
		} finally {
			writeFileSync(masterPath, original);
		}
	});

	test('M. refused candidates never stay in memory: info.txt lists all of them, byte-exact, streamed from disk', async () => {
		const store = markedStore();
		const small = M_SMALL_REFUSED;
		const large = M_SCALE * M_SMALL_REFUSED;
		const smallJob = await refusedJob(store, small);
		const largeJob = await refusedJob(store, large);

		// THE HEAP, in a child per size (the heap holds the writer and nothing else)
		const atSmall = await measureMediaZipHeap(smallJob);
		const atLarge = await measureMediaZipHeap(largeJob);
		for (const report of [atSmall, atLarge]) {
			expect(report.rows).toBe(0);
			// anti-vacuity: info.txt streamed in many writes, every one after the first sampled
			expect(report.writes).toBeGreaterThan(3);
			expect(report.samples).toBe(report.writes - 1);
		}
		// bounded, absolutely: 60,000 refusals of ~150 characters held in memory
		// are tens of MB (measured 25-47 MB for the in-memory list / an unbounded
		// memo); on disk the writer's heap stays within a few MB of where it started
		expect(
			atLarge.peakGrowth,
			`${large} refusals: peak live heap growth ${atLarge.peakGrowth}`,
		).toBeLessThan(8 * 1024 * 1024);
		// bounded, by scaling: M_SCALE× the refusals adds ~(M_SCALE-1)× the list to
		// a writer that keeps it (an array of failures, the pretty text) — at
		// least every extra candidate's text, held as UTF-16 (the 'ñ'), so >= 2
		// bytes a character (measured: +16 MB here); a streaming writer's live
		// heap is one buffer whatever the count (measured: +60 KB typical, one
		// conservatively-reachable 1.7 MB spike in ~1 of 20 pairs), so the bound
		// is a quarter of the smallest list a keeping writer could hold. (The
		// archive's own bytes are no yardstick here: info.txt deflates the
		// repetitive list to a few percent.)
		let listGrowth = 0;
		for (let k = small + 1; k <= large; k++) listGrowth += refusedCandidate(k).length;
		const heapGrowth = atLarge.peakGrowth - atSmall.peakGrowth;
		expect(
			heapGrowth,
			`${M_SCALE}× the refusals grew the peak live heap by ${heapGrowth} (peaks ${atSmall.peakGrowth} → ${atLarge.peakGrowth}) for ${listGrowth} more candidate characters`,
		).toBeLessThan(listGrowth / 2);

		// THE CONTENT, in-process (no heap read here): the archive goes to a file
		// in the job directory, read back once and removed
		const archivePath = join(largeJob.dir, 'probe_media_zip.bin');
		const sink = {
			bytes: 0,
			async admitScratch() {},
			async write(chunk: string | Uint8Array) {
				appendFileSync(archivePath, chunk);
				this.bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
			},
		};
		const result = await mediaZipWriter(
			{
				spool: openSpoolReader(largeJob.dir, { indexEvery: 4 }),
				manifest: await store.readManifest(largeJob),
				options: { origin: '', showTipoInLabel: false },
			},
			sink,
			new AbortController().signal,
		);
		expect(result.rows).toBe(0);
		// the child walked the same spool to the same archive size
		expect(sink.bytes).toBe(atLarge.bytes);

		const archive = new Uint8Array(readFileSync(archivePath));
		rmSync(archivePath);
		const info = zipText(readZip(archive), MEDIA_ZIP_INFO_NAME);
		const expected = Array.from({ length: large }, (_, k) => ({
			file: refusedCandidate(k + 1),
			reason: 'unidentified',
		}));
		// byte-exact: the streamed list IS JSON.stringify(failures, null, 2)
		expect(info).toBe(
			`Qualities: component_image: ${mediaTypeOf('component_image')?.defaultQuality}\n` +
				'Downloaded files: []\n' +
				`Failed files: ${JSON.stringify(expected, null, 2)}\n`,
		);
		// and the unlinked failure logs (the children's and this one) left
		// nothing in the job directories
		for (const job of [smallJob, largeJob]) {
			expect(readdirSync(job.dir).filter((name) => name.includes('media_zip_failures'))).toEqual(
				[],
			);
		}
	}, 120_000);

	test('N. the unlinked failure log is METERED: past the owner quota the build stops mid-walk, not after the whole log landed on disk', async () => {
		// The same refusal-only shape as M (no row fallback, names outside the
		// grammar): nothing is ever archived, so no archive byte runs the sink's
		// meter while the log grows. The log has no name, so the store's
		// directory measure never sees it. Unmetered, the walk ran to its end and
		// the quota fired only when info.txt copied the log back through the sink.
		const creating = markedStore();
		const REFUSED = 20_000;
		const lines: Line[] = [
			{ t: 'meta', v: 1, data_format: 'standard', breakdown: 'rows', section_tipo: SECTION },
			{ t: 'col', i: 0, key: 'id', label: 'Id', cell_type: 'section_id', after: null },
			{
				t: 'col',
				i: 1,
				key: 'img',
				label: 'Image',
				cell_type: 'img',
				model: 'component_image',
				after: 0,
			},
		];
		for (let k = 1; k <= REFUSED; k++) {
			const name = `/nowhere/refused-${k}-${'x'.repeat(200)}.jpg`;
			lines.push({ t: 'row', rec: k, sub: 0, c: { '0': String(k), '1': name } });
		}
		lines.push({ t: 'end', columns: [0, 1], rows: REFUSED, records: REFUSED });
		const job = await endedJob(creating, lines);
		const manifest = await creating.readManifest(job);
		// The log for 20,000 refusals is ~5 MB; the quota leaves the build 512 KiB
		// over what the export already holds (its spool), so ~1/10 of the walk fits.
		const held = await creating.usedBytes(SB_USER_A);
		const budget = 512 * 1024;
		const metered = openArtifactStore({
			root: job.root,
			quotaBytes: held + budget,
			ttlHours: 24,
		});
		const file = metered.allocateFile(job, 'media_zip');
		const opened = await metered.openFileSink(job, file);
		const reader = openSpoolReader(job.dir, { indexEvery: 4 });
		let walked = 0;
		const counting = Object.create(reader) as typeof reader;
		counting.rows = async function* (options) {
			for await (const row of reader.rows(options)) {
				walked++;
				yield row;
			}
		};
		try {
			await expectCode(
				mediaZipWriter(
					{ spool: counting, manifest, options: { origin: '', showTipoInLabel: false } },
					opened.sink,
					new AbortController().signal,
				),
				'export.artifact_quota',
			);
		} finally {
			await opened.abort();
		}
		// stopped while the log grew — never at the info.txt copy after the end
		expect(walked).toBeGreaterThan(0);
		expect(walked).toBeLessThan(REFUSED / 2);
	});
});

test('isArchivableEntryName: a name the zip writer would refuse, or read as folders, is not archivable', () => {
	expect(isArchivableEntryName('photo 1.jpg')).toBe(true);
	expect(isArchivableEntryName('test99_test3_1.jpg')).toBe(true);
	for (const bad of [
		'',
		'.',
		'..',
		'D:scan.jpg',
		'scan\\01.jpg',
		'scan\\\\01.jpg',
		'a/b.jpg',
		'nul\0.jpg',
	]) {
		expect(isArchivableEntryName(bad), JSON.stringify(bad)).toBe(false);
	}
});

test('the file-name grammar addresses the record (component, section, id) and refuses the rest', () => {
	expect(parseMediaFileName('test99_test3_12.jpg')).toEqual({
		componentTipo: 'test99',
		sectionTipo: 'test3',
		sectionId: 12,
	});
	expect(parseMediaFileName('test3205_test3203_7_lg-spa.pdf')).toEqual({
		componentTipo: 'test3205',
		sectionTipo: 'test3203',
		sectionId: 7,
	});
	expect(parseMediaFileName('renamed photo 3.jpg')).toBeNull();
	expect(parseMediaFileName('test99_test3_0.jpg')).toBeNull();
	expect(parseMediaFileName('../test99_test3_1.jpg')).toBeNull();
});

// ======================================================================
// RELATED MEDIA (2026-09-24): media reached THROUGH a portal, in every format
// ======================================================================

/**
 * THE BUILT SITUATION. A scratch HOST section `zzmz1` (no component_filter:
 * its records are visible to every scope) holds `zzmz2`, a component_portal
 * into test3 whose OWN request_config shows three children of the target:
 * test99 (component_image), test52 (component_input_text — the "photographer"
 * text that shares the cell with the URLs) and test85 (component_pdf, which
 * user A holds NO grant on). The export runs as A through the real build
 * (runExportArtifact → the capturing walk → spool + media.ndjson), and the ZIP
 * is built from that spool — nothing is hand-written.
 *
 *   T1 (A's project)  image default+master, pdf, text 'Photographer One'
 *   T2                image default+master — in A's project while the export
 *                     WALKS (the frontier refuses an out-of-scope crossing
 *                     loudly, the whole export), moved to B's project before
 *                     the ZIP is built: the record left A's scope after the
 *                     snapshot, and the per-file check is what refuses it
 *   T3 (A's project)  image RENAMED outside the grammar (default+master),
 *                     text = FORGED URLs: T4's master, and a path out of the root
 *   T4 (A's project)  image default+master, referenced by NO host — only named
 *                     by T3's forged text
 *   T6 (A's project)  image MASTER ONLY (no default file yet): its value is
 *                     empty in every format, its master is still read
 *   H1 → [T1, T2, T3], H2 → [T1], H3 → [T6] (+ the text-only portal → [T1])
 *   C10 → C11 → … → C25: a self-referencing chain portal (config [chain, image])
 */
const ZZMZ_HOST = 'zzmz1';
const ZZMZ_PORTAL = 'zzmz2';
/** A second portal into test3 whose OWN config shows only the text. */
const ZZMZ_PORTAL_TEXT = 'zzmz3';
/** A portal into zzmz1 ITSELF whose own config shows [itself, image]. */
const ZZMZ_CHAIN = 'zzmz4';
const TEXT = 'test52';
const ZZMZ_HOST_IDS = [1, 2] as const;
const ZZMZ_H3 = 3;
/** Chain records: past MAX_FANOUT_DEPTH (12) distinct hops. */
const ZZMZ_CHAIN_IDS = Array.from({ length: 16 }, (_, k) => 10 + k);

function zzmzSituation(targets: { h1: number[]; h2: number[]; h3: number[]; h3Text: number[] }) {
	const link = (
		sectionId: number,
		id: number,
		from: string = ZZMZ_PORTAL,
		sectionTipo: string = SECTION,
	) => ({
		id,
		type: 'dd151',
		section_id: sectionId,
		section_tipo: sectionTipo,
		from_component_tipo: from,
	});
	const portal = (
		tipo: string,
		orderNumber: number,
		target: string,
		shows: string[],
		term: string,
	) => ({
		tipo,
		parent: ZZMZ_HOST,
		term: { 'lg-eng': term },
		model: 'component_portal',
		order_number: orderNumber,
		relations: [{ tipo: target }],
		properties: {
			view: 'default',
			source: {
				request_config: [
					{
						sqo: { section_tipo: [{ value: [target], source: 'section' }] },
						show: {
							ddo_map: shows.map((tipo) => ({
								tipo,
								parent: 'self',
								section_tipo: 'self',
							})),
						},
					},
				],
			},
		},
	});
	return situation({
		name: 'zzmz media zip related media',
		tld: 'zzmz',
		nodes: [
			{
				tipo: ZZMZ_HOST,
				parent: 'dd14',
				term: { 'lg-eng': 'zzmz host' },
				model: 'section',
				relations: [{ tipo: 'test24' }],
			},
			portal(ZZMZ_PORTAL, 1, SECTION, [IMAGE, TEXT, PDF], 'zzmz photos'),
			portal(ZZMZ_PORTAL_TEXT, 2, SECTION, [TEXT], 'zzmz captions'),
			portal(ZZMZ_CHAIN, 3, ZZMZ_HOST, [ZZMZ_CHAIN, IMAGE], 'zzmz chain'),
		],
		records: [
			{
				section_tipo: ZZMZ_HOST,
				section_id: ZZMZ_HOST_IDS[0],
				columns: { relation: { [ZZMZ_PORTAL]: targets.h1.map((id, k) => link(id, k + 1)) } },
			},
			{
				section_tipo: ZZMZ_HOST,
				section_id: ZZMZ_HOST_IDS[1],
				columns: { relation: { [ZZMZ_PORTAL]: targets.h2.map((id, k) => link(id, k + 1)) } },
			},
			{
				section_tipo: ZZMZ_HOST,
				section_id: ZZMZ_H3,
				columns: {
					relation: {
						[ZZMZ_PORTAL]: targets.h3.map((id, k) => link(id, k + 1)),
						[ZZMZ_PORTAL_TEXT]: targets.h3Text.map((id, k) => link(id, k + 1, ZZMZ_PORTAL_TEXT)),
					},
				},
			},
			...ZZMZ_CHAIN_IDS.map((id, k) => ({
				section_tipo: ZZMZ_HOST,
				section_id: id,
				columns: {
					relation:
						k + 1 < ZZMZ_CHAIN_IDS.length
							? {
									[ZZMZ_CHAIN]: [link(ZZMZ_CHAIN_IDS[k + 1] as number, 1, ZZMZ_CHAIN, ZZMZ_HOST)],
								}
							: {},
				},
			})),
		],
	});
}

describe.if(DB_READY)(
	'tool_export media ZIP — media reached through a portal, every format',
	() => {
		let zzmz: ReturnType<typeof zzmzSituation> | null = null;
		let store: ArtifactStore;
		let t1 = 0;
		let t2 = 0;
		let t3 = 0;
		let t4 = 0;
		/** A's record with ONLY the default quality — a refusal the direct leg must list exactly once. */
		let t5 = 0;
		/** A's record with ONLY the master: an empty value in every format, its master still read. */
		let t6 = 0;
		type Planted = { relativePath: string; bytes: string };
		const files: Record<string, Planted> = {};
		const OUTSIDE_TEXT = 'SECRET OUTSIDE THE MEDIA ROOT (related leg)';
		let outside = '';
		/** The file every leg expects at the master: T1's canonical, T3's renamed one. */
		let expectedMaster: Record<string, string> = {};

		/** Re-file a test3 record under ONE project (test101, test3's component_filter). */
		async function setProject(sectionId: number, projectId: number): Promise<void> {
			await sql.unsafe(
				`UPDATE matrix_test SET relation = relation || $3::text::jsonb
			 WHERE section_tipo = $1 AND section_id = $2`,
				[
					SECTION,
					sectionId,
					encodeForJsonb({
						test101: [
							{
								id: 1,
								type: 'dd675',
								section_id: projectId,
								section_tipo: config.features.filterSectionTipo,
								from_component_tipo: 'test101',
							},
						],
					}),
				],
			);
		}

		async function setString(sectionId: number, value: string): Promise<void> {
			await updateMatrixRecord('matrix_test', SECTION, sectionId, {
				string: { [TEXT]: [{ id: 1, lang: 'lg-eng', value }] },
			});
		}

		/** Plant a default + master image pair for a record; `name` renames both (outside the grammar). */
		function plantPair(sectionId: number, name?: string): { def: Planted; master: Planted } {
			if (name === undefined) {
				return {
					def: plant(image, IMAGE, sectionId, DEFAULT, imageOpts),
					master: plant(image, IMAGE, sectionId, MASTER, imageOpts),
				};
			}
			const renamed = (quality: string): Planted => {
				const location = locationOf(image, IMAGE, sectionId, quality, imageOpts);
				const relativePath = `${dirname(location.relativePath)}/${name}`;
				const absolute = join(dirname(location.absolutePath), name);
				const bytes = `renamed ${quality} ${sectionId}`;
				mkdirSync(dirname(absolute), { recursive: true });
				writeFileSync(absolute, bytes);
				createdFiles.push(absolute);
				return { relativePath, bytes };
			};
			return { def: renamed(DEFAULT), master: renamed(MASTER) };
		}

		beforeAll(async () => {
			await assertTestDatabase('tool_export_media_zip_native related media');
			await installScopeBindingFixture();
			imageOpts = await resolveMediaPathOptions(IMAGE, SECTION);
			pdfOpts = await resolveMediaPathOptions(PDF, SECTION);
			store = markedStore();

			t1 = await newRecord(SB_USER_A, SB_PROJECT_OF_A);
			const p1 = plantPair(t1);
			files.t1Def = p1.def;
			files.t1Master = p1.master;
			files.t1Pdf = plant(pdf, PDF, t1, pdf.defaultQuality, pdfOpts, 'pdf');
			await setMedia(t1, {
				[IMAGE]: [
					{
						id: 1,
						files_info: [
							fileInfo(MASTER, files.t1Master!.relativePath),
							fileInfo(DEFAULT, files.t1Def!.relativePath),
						],
					},
				],
				[PDF]: [{ id: 1, files_info: [fileInfo(pdf.defaultQuality, files.t1Pdf!.relativePath)] }],
			});
			await setString(t1, 'Photographer One');

			t2 = await newRecord(SB_USER_A, SB_PROJECT_OF_A);
			const p2 = plantPair(t2);
			files.t2Def = p2.def;
			files.t2Master = p2.master;
			await setMedia(t2, {
				[IMAGE]: [
					{
						id: 1,
						files_info: [
							fileInfo(MASTER, files.t2Master!.relativePath),
							fileInfo(DEFAULT, files.t2Def!.relativePath),
						],
					},
				],
			});

			t4 = await newRecord(SB_USER_A, SB_PROJECT_OF_A);
			const p4 = plantPair(t4);
			files.t4Def = p4.def;
			files.t4Master = p4.master;
			await setMedia(t4, {
				[IMAGE]: [
					{
						id: 1,
						files_info: [
							fileInfo(MASTER, files.t4Master!.relativePath),
							fileInfo(DEFAULT, files.t4Def!.relativePath),
						],
					},
				],
			});

			t5 = await newRecord(SB_USER_A, SB_PROJECT_OF_A);
			files.t5Def = plant(image, IMAGE, t5, DEFAULT, imageOpts);
			await setMedia(t5, {
				[IMAGE]: [{ id: 1, files_info: [fileInfo(DEFAULT, files.t5Def.relativePath)] }],
			});

			t6 = await newRecord(SB_USER_A, SB_PROJECT_OF_A);
			files.t6Master = plant(image, IMAGE, t6, MASTER, imageOpts);
			await setMedia(t6, {
				[IMAGE]: [{ id: 1, files_info: [fileInfo(MASTER, files.t6Master.relativePath)] }],
			});

			const outsideDir = mkdtempSync(join(tmpdir(), 'dedalo_media_zip_related_outside_'));
			scratchDirs.push(outsideDir);
			outside = join(outsideDir, 'secret.jpg');
			writeFileSync(outside, OUTSIDE_TEXT);

			t3 = await newRecord(SB_USER_A, SB_PROJECT_OF_A);
			const p3 = plantPair(t3, `renamed photo ${t3}.jpg`);
			files.t3Def = p3.def;
			files.t3Master = p3.master;
			await setMedia(t3, {
				[IMAGE]: [
					{
						id: 1,
						files_info: [
							fileInfo(DEFAULT, files.t3Def!.relativePath),
							fileInfo(MASTER, files.t3Master!.relativePath),
						],
					},
				],
			});
			// FORGED URLs typed into a text child that shares the portal cell with
			// the image URLs: another record's canonical master, and a climb out of
			// the root. Neither may ever reach the archive.
			await setString(
				t3,
				[
					url(files.t4Master!.relativePath),
					url(`/image/${MASTER}/../../../../../..${outside}`),
				].join(', '),
			);

			zzmz = zzmzSituation({ h1: [t1, t2, t3], h2: [t1], h3: [t6], h3Text: [t1] });
			await ensureSituation(zzmz);

			// A's profile gains the host section and its portal (the declaration
			// gate); NOTHING on test85 — the pdf child stays ungranted.
			await sql.unsafe(
				`UPDATE matrix_profiles SET misc = jsonb_set(misc, '{dd774}', (misc->'dd774') || $2::text::jsonb)
			 WHERE section_tipo = 'dd234' AND section_id = $1`,
				[
					SB_PROFILE_A,
					encodeForJsonb([
						{ id: 90, tipo: ZZMZ_HOST, section_tipo: ZZMZ_HOST, value: 2 },
						{ id: 91, tipo: ZZMZ_PORTAL, section_tipo: ZZMZ_HOST, value: 2 },
						{ id: 92, tipo: ZZMZ_PORTAL_TEXT, section_tipo: ZZMZ_HOST, value: 2 },
						{ id: 93, tipo: ZZMZ_CHAIN, section_tipo: ZZMZ_HOST, value: 2 },
					]),
				],
			);
			clearPermissionsCache();
			clearPrincipalCache();
			clearUserProjectsCache();

			expectedMaster = {
				[`${IMAGE}_${SECTION}_${t1}.jpg`]: files.t1Master!.bytes,
				[`renamed photo ${t3}.jpg`]: files.t3Master!.bytes,
			};
		});

		afterAll(async () => {
			try {
				if (zzmz !== null) expect(await dropSituation(zzmz)).toBe(0);
			} finally {
				await sweepCreated();
			}
		});

		const step = (sectionTipo: string, componentTipo: string) => ({
			section_tipo: sectionTipo,
			component_tipo: componentTipo,
			name: componentTipo,
		});
		/** The bare portal: the portal's own config names the image child. */
		const BARE = [{ path: [step(ZZMZ_HOST, ZZMZ_PORTAL)] }];
		/** The declared portal → image path. */
		const DECLARED = [{ path: [step(ZZMZ_HOST, ZZMZ_PORTAL), step(SECTION, IMAGE)] }];

		async function run(
			ddos: unknown[],
			dataFormat: string,
			breakdown = 'default',
			section = ZZMZ_HOST,
			ids: number[] = [...ZZMZ_HOST_IDS],
		): Promise<ArtifactJobRef> {
			// T2 is inside A's scope while the export walks, outside it once it ended
			await setProject(t2, SB_PROJECT_OF_A);
			const summary = await runExportArtifact({
				store,
				principal: await resolvePrincipal(SB_USER_A),
				userId: SB_USER_A,
				applicationLang: 'lg-eng',
				options: {
					section_tipo: section,
					data_format: dataFormat,
					breakdown,
					lang: 'lg-eng',
					ar_ddo_to_export: structuredClone(ddos),
					sqo: {
						section_tipo: [section],
						filter_by_locators: ids.map((id) => ({
							section_tipo: section,
							section_id: String(id),
						})),
					},
				},
			});
			await setProject(t2, config.features.defaultProject);
			return store.jobRef(SB_USER_A, summary.job_id);
		}

		/** The archive's media entries (info.txt excluded), name → text. */
		function mediaEntries(zip: ZipReadResult): Record<string, string> {
			const out: Record<string, string> = {};
			for (const entry of zip.entries) {
				if (entry.name !== MEDIA_ZIP_INFO_NAME) out[entry.name] = text(entry);
			}
			return out;
		}

		/** Nothing a user may not read, nothing a forged text named, ever. */
		function expectNoForbiddenBytes(zip: ZipReadResult): void {
			const all = zip.entries.map(text);
			for (const forbidden of [
				files.t2Master!.bytes,
				files.t2Def!.bytes,
				files.t4Master!.bytes,
				files.t4Def!.bytes,
				files.t1Pdf!.bytes,
				OUTSIDE_TEXT,
			]) {
				expect(all).not.toContain(forbidden);
			}
		}

		const masterChoice = { mediaQualities: { component_image: MASTER } };

		test('R1. value format, bare portal: the portal column (model component_portal) archives its targets images — the ungranted record and component listed, the forged URLs never followed', async () => {
			const job = await run(BARE, 'value');
			const manifest = await store.readManifest(job);
			// what the walk READ, data-exact: the image AND the pdf child
			expect(manifest.media_models).toEqual(['component_image', 'component_pdf']);
			const cols = await openSpoolReader(job.dir, { indexEvery: manifest.index_every }).readCols();
			expect([...cols.values()].map((col) => col.model)).toEqual(['component_portal']);
			expect(existsSync(join(job.dir, 'media.ndjson'))).toBe(true);

			const { zip, info, rows } = await build(store, job, masterChoice);
			expect(mediaEntries(zip)).toEqual(expectedMaster);
			expect(rows).toBe(2);
			expectNoForbiddenBytes(zip);
			const { downloaded, failed } = parseInfo(info);
			expect(downloaded.sort()).toEqual(Object.keys(expectedMaster).sort());
			expect(failed).toContainEqual({
				file: `${SECTION}/${t2}/${IMAGE}`,
				reason: 'not_authorized',
			});
			expect(failed).toContainEqual({ file: `${SECTION}/${t1}/${PDF}`, reason: 'not_authorized' });
			// T1 is reached from BOTH hosts and archived once; nothing else refused
			expect(failed).toHaveLength(2);
			expect(info).not.toContain(String(t4));
			expect(info).toContain(
				`Qualities: component_image: ${MASTER}, component_pdf: ${pdf.defaultQuality}`,
			);
		});

		test('R2. the default quality archives the default files of the same targets', async () => {
			const job = await run(BARE, 'value');
			const { zip } = await build(store, job, {});
			expect(mediaEntries(zip)).toEqual({
				[`${IMAGE}_${SECTION}_${t1}.jpg`]: files.t1Def!.bytes,
				[`renamed photo ${t3}.jpg`]: files.t3Def!.bytes,
			});
			expectNoForbiddenBytes(zip);
		});

		test('R3. the SAME ddo gives the SAME archive in grid_value (default / rows / columns) and dedalo_raw', async () => {
			for (const [format, breakdown] of [
				['grid_value', 'default'],
				['grid_value', 'rows'],
				['grid_value', 'columns'],
				['dedalo_raw', 'default'],
			] as const) {
				const job = await run(BARE, format, breakdown);
				const manifest = await store.readManifest(job);
				expect(manifest.media_models, `${format}/${breakdown}`).toEqual([
					'component_image',
					'component_pdf',
				]);
				const { zip, info } = await build(store, job, masterChoice);
				expect(mediaEntries(zip), `${format}/${breakdown}`).toEqual(expectedMaster);
				expectNoForbiddenBytes(zip);
				const { failed } = parseInfo(info);
				expect(failed, `${format}/${breakdown}`).toContainEqual({
					file: `${SECTION}/${t2}/${IMAGE}`,
					reason: 'not_authorized',
				});
				expect(failed, `${format}/${breakdown}`).toContainEqual({
					file: `${SECTION}/${t1}/${PDF}`,
					reason: 'not_authorized',
				});
			}
		});

		test.if(Boolean(config.media.exportBase))(
			'R4. a DECLARED portal → image path archives the same authorized files in value and grid_value (default / rows / columns)',
			async () => {
				for (const [format, breakdown] of [
					['value', 'default'],
					['grid_value', 'default'],
					['grid_value', 'rows'],
					['grid_value', 'columns'],
				] as const) {
					const job = await run(DECLARED, format, breakdown);
					const manifest = await store.readManifest(job);
					expect(manifest.media_models, `${format}/${breakdown}`).toEqual(['component_image']);
					const { zip } = await build(store, job, masterChoice);
					expect(mediaEntries(zip), `${format}/${breakdown}`).toEqual(expectedMaster);
					expectNoForbiddenBytes(zip);
				}
			},
		);

		test('R5. the preview serves media_models (what the client offers), while col_models keeps the portal', async () => {
			const job = await run(BARE, 'value');
			const preview = await readExportPreview({
				store,
				principal: await resolvePrincipal(SB_USER_A),
				userId: SB_USER_A,
				sectionTipo: ZZMZ_HOST,
				jobId: job.jobId,
				page: 0,
				pageSize: 10,
			});
			expect(preview.col_models).toEqual(['component_portal']);
			expect(preview.media_models).toEqual(['component_image', 'component_pdf']);
			expect(preview.media_rerun_required).toBe(false);
		});

		test('R6. an export built WITHOUT capture says so (rerun_required) and archives nothing it would have to guess from URL text', async () => {
			const job = await run(BARE, 'value');
			await store.updateManifest(job, { media_models: undefined });
			expect((await store.readManifest(job)).media_models).toBeUndefined();
			const { zip, info } = await build(store, job, masterChoice);
			expect(mediaEntries(zip)).toEqual({});
			const { failed } = parseInfo(info);
			expect(failed).toEqual([{ file: expect.any(String), reason: 'rerun_required' }]);
			const preview = await readExportPreview({
				store,
				principal: await resolvePrincipal(SB_USER_A),
				userId: SB_USER_A,
				sectionTipo: ZZMZ_HOST,
				jobId: job.jobId,
				page: 0,
				pageSize: 10,
			});
			expect(preview.media_models).toEqual([]);
			// ...and the client still OFFERS the build that says so: without this
			// flag the button stayed disabled and rerun_required was unreachable
			expect(preview.media_rerun_required).toBe(true);
		});

		test('R8. the record is read NOW: a target whose image was removed after the walk is listed not_in_record, the rest still archived', async () => {
			const job = await run(BARE, 'value');
			const [stored] = (await sql.unsafe(
				'SELECT media FROM matrix_test WHERE section_tipo = $1 AND section_id = $2',
				[SECTION, t3],
			)) as { media: Record<string, unknown> }[];
			await setMedia(t3, {});
			try {
				const { zip, info } = await build(store, job, masterChoice);
				expect(mediaEntries(zip)).toEqual({
					[`${IMAGE}_${SECTION}_${t1}.jpg`]: files.t1Master!.bytes,
				});
				expect(parseInfo(info).failed).toContainEqual({
					file: `${SECTION}/${t3}/${IMAGE}`,
					reason: 'not_in_record',
				});
			} finally {
				await setMedia(t3, stored?.media ?? {});
			}
		});

		/** Every data format / breakdown a ddo must give the same archive in. */
		const EVERY_FORMAT = [
			['value', 'default'],
			['grid_value', 'default'],
			['grid_value', 'rows'],
			['grid_value', 'columns'],
			['dedalo_raw', 'default'],
		] as const;

		test('R9. a target whose value is EMPTY (master only, no default file yet) is archived in EVERY format — grid_value no longer drops the media of an empty atom', async () => {
			const t6Name = files.t6Master!.relativePath.split('/').pop()!;
			for (const ddos of [BARE, DECLARED]) {
				for (const [format, breakdown] of EVERY_FORMAT) {
					const where = `${ddos === BARE ? 'bare' : 'declared'} ${format}/${breakdown}`;
					const job = await run(ddos, format, breakdown, ZZMZ_HOST, [ZZMZ_H3]);
					expect((await store.readManifest(job)).media_models, where).toContain('component_image');
					const { zip } = await build(store, job, masterChoice);
					expect(mediaEntries(zip), where).toEqual({ [t6Name]: files.t6Master!.bytes });
				}
			}
			// a DIRECT image column: its cell is empty in value / grid_value (no
			// default URL), so no cell names the file — the read does (null column)
			for (const [format, breakdown] of EVERY_FORMAT) {
				const job = await run([{ path: [step(SECTION, IMAGE)] }], format, breakdown, SECTION, [t6]);
				const { zip } = await build(store, job, masterChoice);
				expect(mediaEntries(zip), `direct ${format}/${breakdown}`).toEqual({
					[t6Name]: files.t6Master!.bytes,
				});
			}
		});

		test('R10. raw follows the DECLARED path, like value and grid_value: portal → text reads no media; a portal → image the portal config does not show is read', async () => {
			const toText = [{ path: [step(ZZMZ_HOST, ZZMZ_PORTAL), step(SECTION, TEXT)] }];
			const bareTextPortal = [{ path: [step(ZZMZ_HOST, ZZMZ_PORTAL_TEXT)] }];
			const textPortalToImage = [
				{ path: [step(ZZMZ_HOST, ZZMZ_PORTAL_TEXT), step(SECTION, IMAGE)] },
			];
			const t1Master = { [`${IMAGE}_${SECTION}_${t1}.jpg`]: files.t1Master!.bytes };
			for (const [format, breakdown] of EVERY_FORMAT) {
				const where = `${format}/${breakdown}`;
				// (a) the portal's config shows the image; the ddo declared the text
				let job = await run(toText, format, breakdown);
				expect((await store.readManifest(job)).media_models, `a ${where}`).toEqual([]);
				expect(mediaEntries((await build(store, job, masterChoice)).zip), `a ${where}`).toEqual({});
				// a portal whose config shows no media reads none
				job = await run(bareTextPortal, format, breakdown, ZZMZ_HOST, [ZZMZ_H3]);
				expect((await store.readManifest(job)).media_models, `bare ${where}`).toEqual([]);
				// (b) the declared image, absent from the portal's own config
				job = await run(textPortalToImage, format, breakdown, ZZMZ_HOST, [ZZMZ_H3]);
				expect((await store.readManifest(job)).media_models, `b ${where}`).toEqual([
					'component_image',
				]);
				expect(mediaEntries((await build(store, job, masterChoice)).zip), `b ${where}`).toEqual(
					t1Master,
				);
			}
		});

		test('R11. a self-referencing portal chain longer than the fan-out ceiling still builds (the media capture never fails an export)', async () => {
			const chain = [{ path: [step(ZZMZ_HOST, ZZMZ_CHAIN)] }];
			for (const format of ['dedalo_raw', 'value', 'grid_value'] as const) {
				const job = await run(chain, format, 'default', ZZMZ_HOST, [ZZMZ_CHAIN_IDS[0] as number]);
				const manifest = await store.readManifest(job);
				expect(manifest.status, format).toBe('ended');
				expect(manifest.media_models, format).toEqual([]);
				const csv = await buildArtifactFile({
					store,
					job,
					format: 'csv',
					options: { origin: 'https://example.test', showTipoInLabel: false },
					signal: new AbortController().signal,
				});
				expect(csv.rows, format).toBeGreaterThan(0);
			}
		});

		test('R7. a DIRECT image export is byte-identical with and without the sidecar (its cells stay its input)', async () => {
			const direct = [{ path: [step(SECTION, IMAGE)] }];
			for (const format of ['value', 'grid_value', 'dedalo_raw'] as const) {
				const job = await run(direct, format, 'default', SECTION, [t1, t3, t5]);
				expect((await store.readManifest(job)).media_models).toEqual(['component_image']);
				expect(existsSync(join(job.dir, 'media.ndjson'))).toBe(true);
				const captured = await build(store, job, masterChoice);
				const first = captured.zip.entries.map((entry) => [entry.name, text(entry)]);
				await store.updateManifest(job, { media_models: undefined });
				const legacy = await build(store, job, masterChoice);
				expect(legacy.zip.entries.map((entry) => [entry.name, text(entry)])).toEqual(first);
				expect(legacy.info).toBe(captured.info);
				expect(mediaEntries(captured.zip)).toEqual(expectedMaster);
				// the one refusal, listed ONCE (the sidecar never re-reads a direct column)
				expect(parseInfo(captured.info).failed, format).toEqual([
					{
						file: expect.stringContaining(`${IMAGE}_${SECTION}_${t5}`),
						reason: 'quality_unavailable',
					},
				]);
			}
		});
	},
);
