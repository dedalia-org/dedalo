/**
 * A DERIVATIVE FAILURE MUST NEVER COST THE RECORD ITS INDEX (2026-08-04).
 *
 * Measured damage on records 440866/440867: the derivative pass threw AFTER
 * `addFile` had irreversibly moved the staged upload, so `processUploadedFile`
 * unwound before its caller could persist `files_info`. The result was a created
 * record, a linked portal, an original sitting in `image/original/440000/` and
 * `matrix.media` NULL — the file existed, no record knew it, the staged source
 * was consumed, and the import could not be retried. tool_import_files reported
 * "Imported 0 of 2 with errors".
 *
 * So the derivative pass is NON-FATAL and reports through
 * `IngestResult.derivativeErrors`; every consumer surfaces those in the channel
 * it already has. A missing tier is rebuildable at any time; a lost index is not.
 *
 * WHY ITS OWN FILE: the tool drive below installs a `mock.module`, which is
 * process-GLOBAL in bun and is NOT reverted by `mock.restore()` — a mock left
 * installed here would follow every file that runs after it (this once reddened
 * seven gates). It is snapshot-and-reinstalled in `afterAll`, and kept away from
 * the media gates in media_processing.test.ts / media_ingest.test.ts.
 *
 * The failure is produced with NO stubbing at all: a file staged as `.jpg` whose
 * bytes are not an image. That is a real curator accident (a renamed file, a
 * truncated transfer), and it fails exactly where the layered TIFF failed — in
 * the probe/convert pass, after the move.
 */
// MIGRATED TO THE GENERIC `test` TLD, 2026-08-19: every install tipo this gate
// spelled is now its generic twin (sections on the `test` TLD, storing in
// matrix_test). A pure rename — the tipo is an identifier in a path, a filename
// or a locator here, so no corpus and no DB round-trip were added.

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mediaTypeOf } from '../../src/core/concepts/media.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { stagingDir } from '../../src/core/media/ingest/add_file.ts';
import { processUploadedFile } from '../../src/core/media/ingest/process_uploaded_file.ts';
import type { MediaIdentity, MediaPathOptions } from '../../src/core/media/path.ts';
import * as tool_support from '../../src/core/media/tool_support.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { deleteSectionRecord } from '../../src/core/section/record/delete_record.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import { mustGet } from '../helpers/assert.ts';
import { magickTestEnv } from '../helpers/magick_test_env.ts';
import { markMediaRoot } from '../helpers/media_scratch_root.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const ROOT = scratchDir('media_derivative_failure');
const image = mustGet(mediaTypeOf('component_image'), 'component_image spec');
const pathOpts: MediaPathOptions = { initialMediaPath: '', maxItemsFolder: null, mediaRoot: ROOT };
const USER = -1; // the ROOT user (PHP logged_user_id()), a valid staging owner

/** The bytes staged as an image. Deliberately NOT an image. */
const BROKEN_BYTES = 'this file is not an image, and the probe must say so\n';

/** Stage `BROKEN_BYTES` under a scratch key_dir and return its staged name. */
function stageBrokenImage(keyDir: string, tmpName: string): void {
	const dir = stagingDir(USER, keyDir, ROOT);
	mkdirSync(dir, { recursive: true });
	writeFileSync(`${dir}/${tmpName}`, BROKEN_BYTES);
}

// ── the tool drive needs the DB; probe it at COLLECTION time so an offline run
// reports a visible SKIP instead of a silent pass (S2-40 posture).
let hasDb = false;
try {
	await sql`SELECT 1`;
	hasDb = true;
} catch {
	console.warn('[media_ingest_derivative_failure] DB unavailable — the tool drive is SKIPPED');
}
// The test3 playground: the one write surface this suite owns.
const SECTION = 'test3';
const COMPONENT = 'test99'; // component_image
const scratchIds: number[] = [];

beforeAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
	// DECLARE the scratch root (the media doors refuse an unmarked one under the
	// test-media seam — src/core/media/test_media_root.ts).
	markMediaRoot(ROOT);
});
afterAll(async () => {
	rmSync(ROOT, { recursive: true, force: true });
	const failures: string[] = [];
	for (const id of scratchIds) {
		try {
			const outcome = await deleteSectionRecord(SECTION, id, USER);
			if (outcome.removed !== true) failures.push(`${SECTION}/${id}: ${JSON.stringify(outcome)}`);
			// deleteSectionRecord writes a 'deleted' snapshot into matrix_time_machine,
			// a REAL shared table — one orphan row per suite run otherwise.
			await sql.unsafe(
				'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
				[SECTION, id],
			);
		} catch (error) {
			failures.push(`${SECTION}/${id}: ${(error as Error).message}`);
		}
	}
	// Throw, don't warn: silent cleanup failure is how a shared playground fills.
	if (failures.length > 0) throw new Error(`scratch cleanup failed: ${failures.join('; ')}`);
});

describe('processUploadedFile: the original is indexed even when the derivatives fail', () => {
	const identity: MediaIdentity = {
		componentTipo: 'test99',
		sectionTipo: 'test3',
		sectionId: 90,
		lang: null,
	};

	test('a failing derivative pass RESOLVES, reporting through derivativeErrors', async () => {
		stageBrokenImage('kdfail', 'broken.jpg');
		// Pre-fix this call REJECTED, which is the whole defect: the caller never
		// reached its persist, so the moved original was never indexed.
		const result = await processUploadedFile({
			spec: image,
			identity,
			pathOpts,
			userId: USER,
			keyDir: 'kdfail',
			tmpName: 'broken.jpg',
			extension: 'jpg',
		});

		// The failure is REPORTED, never swallowed — one message per failing pass.
		expect(result.derivativeErrors.length).toBe(1);
		expect(result.derivativeErrors[0]).toContain('test99_test3_90.jpg');

		// The index is intact: files_info describes the original that landed.
		const original = result.filesInfo.find((entry) => entry.quality === image.originalQuality);
		expect(original).toBeDefined();
		expect(existsSync(`${ROOT}${mustGet(original, 'original entry').file_path}`)).toBe(true);
		expect(result.originalFileName).toBe('test99_test3_90.jpg');

		// The moved file is INTACT and the staged source is consumed — the move is
		// irreversible, which is precisely why nothing after it may abort.
		const stored = `${ROOT}/image/original/test99_test3_90.jpg`;
		expect(readFileSync(stored, 'utf8')).toBe(BROKEN_BYTES);
		expect(existsSync(`${stagingDir(USER, 'kdfail', ROOT)}/broken.jpg`)).toBe(false);

		// The tiers that could not be built are absent — the record is honest about
		// what exists rather than claiming a derivative it never wrote.
		expect(existsSync(`${ROOT}/image/${image.defaultQuality}/test99_test3_90.jpg`)).toBe(false);
		expect(result.filesInfo.some((entry) => entry.quality === 'thumb')).toBe(false);
	});

	test('a SOUND upload reports no derivative errors (the flag is not stuck on)', async () => {
		// The complement: without it, a `derivativeErrors` that is always non-empty
		// would pass the gate above and make every import look half-failed.
		const soundId: MediaIdentity = { ...identity, sectionId: 91 };
		const dir = stagingDir(USER, 'kdok', ROOT);
		mkdirSync(dir, { recursive: true });
		const { runBinary } = await import('../../src/core/media/engine/spawn.ts');
		const { resolveMagick } = await import('../../src/core/media/engine/imagemagick.ts');
		await runBinary([resolveMagick(), '-size', '300x200', 'xc:green', `${dir}/ok.jpg`], {
			nice: false,
			env: magickTestEnv(),
		});
		const result = await processUploadedFile({
			spec: image,
			identity: soundId,
			pathOpts,
			userId: USER,
			keyDir: 'kdok',
			tmpName: 'ok.jpg',
			extension: 'jpg',
		});
		expect(result.derivativeErrors).toEqual([]);
		expect(result.filesInfo.some((entry) => entry.quality === 'thumb')).toBe(true);
	});
});

/**
 * THE SAME LAW FOR THE ALTERNATE TWINS (2026-08-07, decision D9).
 *
 * `regenerateImage` now builds the configured alternate-extension twins, and a
 * twin failure is NON-FATAL by construction: a box with no AVIF delegate must
 * still get its whole jpg ladder. With the old `string[]` return that failure had
 * NOWHERE TO GO — `derivativeErrors` was populated at exactly one site, the
 * ingest catch — so a host that cannot write the configured format would have
 * reported every upload a complete success while the format was silently never
 * produced. That is the defect this whole subsystem exists to end, which is why
 * the error channel is part of the signature.
 *
 * The failure is produced with NO stubbing, exactly like the broken-bytes case
 * above: a real image, ingested on a host whose ImageMagick genuinely cannot
 * write the configured format. `.jxl` is that format here (measured on this box:
 * `canWriteImageFormat('jxl')` is false, and a bare `magick src.png out.jxl`
 * exits 0 leaving 316 bytes of PNG under the .jxl name — the silent-wrong-format
 * hazard the coder token closes). Config is frozen at boot, so it runs in a child
 * (the established technique — see active_ontology_tlds.test.ts).
 */
describe('an UNWRITABLE configured twin is reported, never silently skipped', () => {
	const PROBE = [
		"const { mediaTypeOf } = await import('./src/core/concepts/media.ts');",
		"const { processUploadedFile } = await import('./src/core/media/ingest/process_uploaded_file.ts');",
		"const spec = mediaTypeOf('component_image');",
		'const result = await processUploadedFile({',
		'\tspec,',
		"\tidentity: { componentTipo: 'test99', sectionTipo: 'test3', sectionId: 92, lang: null },",
		"\tpathOpts: { initialMediaPath: '', maxItemsFolder: null, mediaRoot: process.env.PROBE_MEDIA_ROOT },",
		'\tuserId: -1,',
		"\tkeyDir: 'kdjxl',",
		"\ttmpName: 'twin.jpg',",
		"\textension: 'jpg',",
		'});',
		'console.log(',
		'\tJSON.stringify({',
		'\t\tconfigured: spec.alternateExtensions,',
		'\t\tderivativeErrors: result.derivativeErrors,',
		'\t\tqualities: result.filesInfo.map((entry) => `${entry.quality}.${entry.extension}`),',
		'\t}),',
		');',
	].join('');

	test('the upload succeeds, the ladder is intact, and the refusal names the KEY', async () => {
		// A REAL image (not the broken bytes above): the jpg ladder must build.
		const dir = stagingDir(USER, 'kdjxl', ROOT);
		mkdirSync(dir, { recursive: true });
		const { runBinary } = await import('../../src/core/media/engine/spawn.ts');
		const { resolveMagick } = await import('../../src/core/media/engine/imagemagick.ts');
		await runBinary([resolveMagick(), '-size', '300x200', 'xc:green', `${dir}/twin.jpg`], {
			nice: false,
			env: magickTestEnv(),
		});

		const child = Bun.spawnSync(['bun', '-e', PROBE], {
			cwd: join(import.meta.dir, '../..'),
			env: {
				...process.env,
				DEDALO_IMAGE_ALTERNATIVE_EXTENSIONS: '["jxl"]',
				PROBE_MEDIA_ROOT: ROOT,
			} as Record<string, string>,
			stdout: 'pipe',
			stderr: 'pipe',
		});
		expect([child.exitCode, child.stderr.toString()]).toEqual([0, child.stderr.toString()]);
		const out = JSON.parse((child.stdout.toString().trim().split('\n').pop() ?? '').trim()) as {
			configured: string[];
			derivativeErrors: string[];
			qualities: string[];
		};

		// The child really was configured for a format this host cannot write —
		// otherwise everything below passes for the wrong reason.
		expect(out.configured).toEqual(['jxl']);
		// THE INDEX IS INTACT: the original landed, the jpg ladder built, the record
		// knows its files. A twin nobody can encode costs the record a FORMAT, never
		// its index (and never the upload).
		expect(out.qualities).toContain(`${image.originalQuality}.jpg`);
		expect(out.qualities).toContain(`${image.defaultQuality}.jpg`);
		expect(out.qualities.some((entry) => entry.startsWith('thumb.'))).toBe(true);
		// …and the operator is TOLD, in the one channel every consumer already
		// surfaces, with the config key that asked for it.
		expect(out.derivativeErrors.length).toBeGreaterThan(0);
		const named = out.derivativeErrors.filter(
			(line) => line.includes('DEDALO_IMAGE_ALTERNATIVE_EXTENSIONS') && line.includes('jxl'),
		);
		expect(named.length).toBeGreaterThan(0);
		// THE UNWRITABLE FORMAT NEVER LANDS. Without the coder token ImageMagick
		// writes PNG bytes into a file named .jxl, exit 0 and empty stderr: it would
		// pass every post-condition, enter files_info and be served with the wrong
		// MIME. Nothing named .jxl may exist anywhere under the media root.
		expect(out.qualities.some((entry) => entry.endsWith('.jxl'))).toBe(false);
		expect(existsSync(`${ROOT}/image/${image.defaultQuality}/test99_test3_92.jxl`)).toBe(false);
	});
});

/**
 * The consumer half: tool_import_files counts such a file as IMPORTED and puts
 * the failure in front of the operator.
 *
 * The ONE stub is `resolveMediaToolContext`, whose `pathOpts` come from the
 * config media root — the LIVE tree. It is redirected to the scratch ROOT and
 * otherwise runs for real (real ontology reads, real record, real add_file, real
 * files_info persist), so the assertion below is about the real code path.
 */
const REAL_TOOL_SUPPORT = { ...tool_support };

describe.if(hasDb)('tool_import_files surfaces a derivative failure per file', () => {
	beforeAll(() => {
		mock.module('../../src/core/media/tool_support.ts', () => ({
			...REAL_TOOL_SUPPORT,
			resolveMediaToolContext: async (
				options: Parameters<typeof tool_support.resolveMediaToolContext>[0],
			): Promise<tool_support.MediaToolContext> => {
				const resolved = await REAL_TOOL_SUPPORT.resolveMediaToolContext(options);
				return { ...resolved, pathOpts: { ...resolved.pathOpts, mediaRoot: ROOT } };
			},
		}));
	});
	afterAll(() => {
		// mock.restore() does NOT revert mock.module — re-install the real exports or
		// this stub follows every file that runs after this one.
		mock.module('../../src/core/media/tool_support.ts', () => REAL_TOOL_SUPPORT);
	});

	test('the file counts as imported, and the failure rides in errors[]', async () => {
		const sectionId = await createSectionRecord(SECTION, USER);
		scratchIds.push(sectionId);
		stageBrokenImage('kdtool', 'broken2.jpg');

		const loaded = await getLoadedTool('tool_import_files');
		const response = (await mustGet(
			loaded?.module.apiActions.import_files,
			'import_files action',
		).handler({
			principal: await resolvePrincipal(USER),
			userId: USER,
			background: false,
			options: {
				section_tipo: SECTION,
				tipo: COMPONENT,
				section_id: sectionId,
				key_dir: 'kdtool',
				tool_config: {},
				files_data: [
					{
						name: 'broken2.jpg',
						tmp_name: 'broken2.jpg',
						extension: 'jpg',
						key_dir: 'kdtool',
						section_id: sectionId,
					},
				],
			},
		})) as unknown as Record<string, unknown>;

		// IMPORTED: the original landed and was indexed. Pre-fix this was 0 with
		// nothing persisted anywhere.
		expect(response.ok).toBe(true);
		const report = response.data as { imported: number; errors: string[] };
		expect(report.imported).toBe(1);
		// …and the operator is told, per file, in the ONE channel the panel renders
		// (render_tool_import_files.js reads sse_response.data.errors and nothing
		// else — a `warnings` field would be dropped on the floor).
		const errors = report.errors;
		expect(errors.some((line) => /imported, but a derivative could not be built/.test(line))).toBe(
			true,
		);
		expect(errors.some((line) => line.startsWith('broken2.jpg:'))).toBe(true);
		expect('warnings' in (response.data as object)).toBe(false);

		// The record KNOWS ITS FILE: this is the damage the whole change exists to
		// prevent — matrix.media NULL against an original sitting on disk.
		const items = await REAL_TOOL_SUPPORT.readStoredMediaItems(SECTION, sectionId, COMPONENT);
		const filesInfo = (items[0]?.files_info ?? []) as { quality?: string; file_path?: string }[];
		expect(filesInfo.length).toBeGreaterThan(0);
		const persistedOriginal = filesInfo.find((entry) => entry.quality === image.originalQuality);
		expect(persistedOriginal).toBeDefined();
		// …and that entry points at the file that really landed (the path carries the
		// live max_items_folder bucketing, so it is READ from the record, never
		// rebuilt here — a hand-built path would assert against the wrong tree).
		expect(existsSync(`${ROOT}${mustGet(persistedOriginal, 'persisted original').file_path}`)).toBe(
			true,
		);
	});
});
