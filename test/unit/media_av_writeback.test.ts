/**
 * The AV transcode's files_info WRITE-BACK.
 *
 * An av transcode finishes long after the request that started it returned, so
 * the ingest caller's own persist could only ever record the ORIGINAL. Nothing
 * wrote the derivatives back, and every consumer of the STORED index (diffusion,
 * publication, export, tool_media_versions) therefore saw an av record that
 * owned nothing but its source file. component_av re-scans on emit, which is why
 * the browser hid the damage.
 *
 * Real ffmpeg transcode against a SCRATCH media root + a scratch test3 record
 * (the one write surface the suite owns); both are cleaned up.
 *
 * NOT GATED HERE, stated rather than implied: the FAILING arm of the
 * write-back's "loud but non-fatal" contract (`persist_error` non-null while the
 * job still reports 'done'). Both assertions below pin its null side. Every
 * input-shaped fault is refused upstream — `buildMediaIdentifier` rejects a
 * non-tipo componentTipo, a missing record resolves to action 'missing' without
 * throwing — so the catch is defence against a genuine RUNTIME fault (the DB
 * going away mid-encode), which can only be injected by mocking the module and
 * would leak that mock across the suite (see the dedalo-ts-testing skill). Buying
 * it with a test-only parameter on `submitAvTranscode` was judged the worse
 * trade: permanent production surface for one defensive branch.
 */
// NO INSTALL TLD IS BOUND HERE (checked 2026-08-19). The census entry for this
// file is a FALSE POSITIVE: the only token it matches is `libx264`, the ffmpeg
// H.264 ENCODER name, which is `<letters><digits>`-shaped and so indistinguishable
// from a tipo to scripts/lib/tld_census.ts. `libx` is not an ontology TLD and
// should leave INSTALL_TLDS; until it does, the entry stays frozen.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../src/config/config.ts';
import { mediaTypeOf } from '../../src/core/concepts/media.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { submitAvTranscode } from '../../src/core/media/av_versions.ts';
import { runBinary } from '../../src/core/media/engine/spawn.ts';
import { scanFilesInfo } from '../../src/core/media/files_info.ts';
import { mediaJobs } from '../../src/core/media/jobs.ts';
import {
	buildMediaLocation,
	type MediaIdentity,
	type MediaPathOptions,
} from '../../src/core/media/path.ts';
import { readStoredMediaItems } from '../../src/core/media/tool_support.ts';
import { persistUploadedMedia } from '../../src/core/media/tools/files_info_persist.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { deleteSectionRecord } from '../../src/core/section/record/delete_record.ts';
import { mustGet } from '../helpers/assert.ts';
import { markMediaRoot, markProcessesDir } from '../helpers/media_scratch_root.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const ROOT = scratchDir('av_writeback');
// The job-manager test seam (jobs.ts processesDir): without it this file's real
// transcode jobs write their pfiles into the LIVE ../private/processes tree.
// Restored in afterAll: this dir is deleted there, and a key left pointing at
// it would aim the NEXT file's jobs at an unmarked directory (refused).
const previousProcessesDir = process.env.DEDALO_MEDIA_PROCESSES_DIR;
process.env.DEDALO_MEDIA_PROCESSES_DIR = markProcessesDir(join(ROOT, 'processes'));
const av = mustGet(mediaTypeOf('component_av'), 'component_av spec');
const HAVE_FFMPEG = Bun.which(config.media.binaries.ffmpeg) !== null;
const pathOpts: MediaPathOptions = { initialMediaPath: '', maxItemsFolder: 1000, mediaRoot: ROOT };

/** The canonical test3 playground (matrix_test) — the suite's only write surface. */
const SCRATCH_SECTION = 'test3';
/** test94 — the av component the ingest gate already drives in this playground. */
const AV_COMPONENT = 'test94';
const scratchIds: number[] = [];

/** Put a real tiny 16x9 mp4 straight into the ORIGINAL tier (what add_file would leave). */
async function seedOriginal(identity: MediaIdentity): Promise<string> {
	const target = buildMediaLocation(av, identity, av.originalQuality, 'mp4', pathOpts).absolutePath;
	mkdirSync(target.slice(0, target.lastIndexOf('/')), { recursive: true });
	await runBinary(
		[
			config.media.binaries.ffmpeg,
			'-y',
			'-f',
			'lavfi',
			'-i',
			'testsrc=duration=1:size=320x180:rate=25',
			'-f',
			'lavfi',
			'-i',
			'anullsrc=channel_layout=stereo:sample_rate=44100',
			'-shortest',
			'-t',
			'1',
			'-c:v',
			'libx264',
			'-pix_fmt',
			'yuv420p',
			target,
		],
		{ nice: false },
	);
	return target;
}

/** Poll a media job to a terminal state (or give up). */
async function awaitJob(jobId: string): Promise<void> {
	for (let i = 0; i < 240; i++) {
		const status = mediaJobs.status(jobId)?.status;
		if (status !== 'queued' && status !== 'running') return;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

const qualitiesOf = (items: Record<string, unknown>[]): string[] => {
	const filesInfo = items[0]?.files_info;
	if (!Array.isArray(filesInfo)) return [];
	return filesInfo.map((entry) => String((entry as { quality?: unknown }).quality));
};

beforeAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
	// DECLARE the scratch root (the media doors refuse an unmarked one under the
	// test-media seam — src/core/media/test_media_root.ts).
	markMediaRoot(ROOT);
	markProcessesDir(join(ROOT, 'processes')); // the job-registry scratch dir (same rmSync, same law)
});
afterAll(async () => {
	if (previousProcessesDir === undefined)
		Reflect.deleteProperty(process.env, 'DEDALO_MEDIA_PROCESSES_DIR');
	else process.env.DEDALO_MEDIA_PROCESSES_DIR = previousProcessesDir;
	rmSync(ROOT, { recursive: true, force: true });
	const failures: string[] = [];
	for (const id of scratchIds) {
		try {
			const outcome = await deleteSectionRecord(SCRATCH_SECTION, id, -1);
			if (outcome.removed !== true) {
				failures.push(`${SCRATCH_SECTION}/${id}: ${JSON.stringify(outcome)}`);
			}
			// deleteSectionRecord writes a 'deleted' snapshot into matrix_time_machine,
			// a REAL shared table — one orphan row per suite run otherwise.
			await sql.unsafe(
				'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
				[SCRATCH_SECTION, id],
			);
		} catch (error) {
			failures.push(`${SCRATCH_SECTION}/${id}: ${(error as Error).message}`);
		}
	}
	// Throw, don't warn: a swallowed cleanup failure is how scratch rows accumulate.
	if (failures.length > 0) {
		throw new Error(`scratch cleanup failed: ${failures.join('; ')}`);
	}
});

describe('av transcode → files_info write-back', () => {
	test.if(HAVE_FFMPEG)(
		'the finished derivatives reach the stored record',
		async () => {
			const sectionId = await createSectionRecord(SCRATCH_SECTION, -1);
			scratchIds.push(sectionId);
			const identity: MediaIdentity = {
				componentTipo: AV_COMPONENT,
				sectionTipo: SCRATCH_SECTION,
				sectionId,
				lang: null,
			};
			await seedOriginal(identity);

			// The state an ingest leaves behind: the original is on disk and recorded,
			// the transcode has not run yet.
			const normalizedName = `${AV_COMPONENT}_${SCRATCH_SECTION}_${sectionId}.mp4`;
			await persistUploadedMedia({
				sectionTipo: SCRATCH_SECTION,
				sectionId,
				componentTipo: AV_COMPONENT,
				lang: null,
				filesInfo: scanFilesInfo(av, identity, pathOpts, {
					originalNormalizedName: normalizedName,
				}),
				originalFileName: 'clip.mp4',
				originalNormalizedName: normalizedName,
			});
			const before = await readStoredMediaItems(SCRATCH_SECTION, sectionId, AV_COMPONENT);
			expect(qualitiesOf(before)).toEqual([av.originalQuality]);

			const jobId = submitAvTranscode(av, identity, pathOpts, 'mp4');
			await awaitJob(jobId);
			const job = mediaJobs.status(jobId);
			expect(job?.errors ?? ['no job']).toEqual([]);
			expect(job?.status).toBe('done');
			// The write-back reports its own failure in the payload rather than failing
			// the transcode — assert it did not have to.
			expect(
				(job?.data as { persist_error?: string | null } | null)?.persist_error ?? null,
			).toBeNull();

			// The derivative is on disk AND now in the record.
			const derivative = buildMediaLocation(
				av,
				identity,
				av.defaultQuality,
				av.defaultExtension,
				pathOpts,
			).absolutePath;
			expect(existsSync(derivative)).toBe(true);
			const after = await readStoredMediaItems(SCRATCH_SECTION, sectionId, AV_COMPONENT);
			expect(qualitiesOf(after)).toContain(av.defaultQuality);
			// The original entry and the provenance keys survive the refresh — it is a
			// files_info-only merge, not a rewrite of the item.
			expect(qualitiesOf(after)).toContain(av.originalQuality);
			expect(mustGet(after[0], 'stored item').original_file_name).toBe('clip.mp4');
		},
		90_000,
	);

	test.if(HAVE_FFMPEG)(
		'a component with NO stored item is left alone',
		async () => {
			// The passive-scan rule: a background transcode must not mint a stored value
			// for a component that has none. Only the operator's explicit sync_files may.
			const sectionId = await createSectionRecord(SCRATCH_SECTION, -1);
			scratchIds.push(sectionId);
			const identity: MediaIdentity = {
				componentTipo: AV_COMPONENT,
				sectionTipo: SCRATCH_SECTION,
				sectionId,
				lang: null,
			};
			await seedOriginal(identity);

			const jobId = submitAvTranscode(av, identity, pathOpts, 'mp4');
			await awaitJob(jobId);
			const job = mediaJobs.status(jobId);
			expect(job?.status).toBe('done');
			// 'left alone' must mean the write-back RAN and declined — not that it
			// exploded into persist_error and never reached the decision.
			expect(
				(job?.data as { persist_error?: string | null } | null)?.persist_error ?? null,
			).toBeNull();
			expect(await readStoredMediaItems(SCRATCH_SECTION, sectionId, AV_COMPONENT)).toEqual([]);
		},
		90_000,
	);
});
