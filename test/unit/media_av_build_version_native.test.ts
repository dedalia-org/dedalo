/**
 * tool_media_versions build_version for component_av — THE REQUESTED QUALITY.
 *
 * The panel's gear on 1080/720/576/240 submitted a job that built the DEFAULT
 * quality (404) plus audio, because the av branch of `buildVersionCore` handed
 * the ingest transcode the extension and dropped the quality entirely. The tier
 * the operator asked for was never written, and the client — which polls
 * get_files_info until that tier appears — blinked "Processing" forever against
 * a job that had already finished 'done'.
 *
 * So the assertion that matters is NOT "a file appeared": it is "the file that
 * appeared is the tier that was asked for, and the default tier was NOT touched".
 *
 * Real ffmpeg against a SCRATCH media root + a scratch test3 record (the suite's
 * one write surface); both are cleaned up. '240' is the cheapest ladder tier.
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
import { AvBuildRefused, submitAvVersionBuild } from '../../src/core/media/av_versions.ts';
import { runBinary } from '../../src/core/media/engine/spawn.ts';
import { mediaJobs } from '../../src/core/media/jobs.ts';
import {
	buildMediaLocation,
	type MediaIdentity,
	type MediaPathOptions,
} from '../../src/core/media/path.ts';
import { buildVersionCore } from '../../src/core/media/tools/versions.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { deleteSectionRecord } from '../../src/core/section/record/delete_record.ts';
import { mustGet } from '../helpers/assert.ts';
import { markMediaRoot, markProcessesDir } from '../helpers/media_scratch_root.ts';
import { refusalOf } from '../helpers/refusal.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const ROOT = scratchDir('av_build_version');
// The job-manager test seam (jobs.ts processesDir): without it these real
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
async function seedOriginal(identity: MediaIdentity): Promise<void> {
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
}

/** Poll a media job to a terminal state (or give up). */
async function awaitJob(jobId: string): Promise<void> {
	for (let i = 0; i < 240; i++) {
		const status = mediaJobs.status(jobId)?.status;
		if (status !== 'queued' && status !== 'running') return;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

/** A fresh scratch record with a real av original on disk. */
async function scratchWithOriginal(): Promise<MediaIdentity> {
	const sectionId = await createSectionRecord(SCRATCH_SECTION, -1);
	scratchIds.push(sectionId);
	const identity: MediaIdentity = {
		componentTipo: AV_COMPONENT,
		sectionTipo: SCRATCH_SECTION,
		sectionId,
		lang: null,
	};
	await seedOriginal(identity);
	return identity;
}

const qualityPath = (identity: MediaIdentity, quality: string): string =>
	buildMediaLocation(av, identity, quality, av.defaultExtension, pathOpts).absolutePath;

beforeAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
	// DECLARE the scratch root: under the test-media seam every media door refuses
	// an unmarked root, and the rmSync above would take an earlier marker with it
	// (src/core/media/test_media_root.ts, test/helpers/media_scratch_root.ts).
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

describe('av build_version builds the quality that was asked for', () => {
	test.if(HAVE_FFMPEG)(
		"a '240' request writes the 240 tier and leaves the default tier alone",
		async () => {
			const identity = await scratchWithOriginal();

			const built = await buildVersionCore(av, identity, pathOpts, '240');
			const jobId = built.jobId;
			expect(jobId).not.toBeNull();
			await awaitJob(mustGet(jobId, 'job id'));

			const job = mediaJobs.status(mustGet(jobId, 'job id'));
			expect(job?.errors ?? ['no job']).toEqual([]);
			expect(job?.status).toBe('done');

			expect(existsSync(qualityPath(identity, '240'))).toBe(true);
			// The regression itself: the default tier is what the old code built
			// INSTEAD of the requested one.
			expect(existsSync(qualityPath(identity, av.defaultQuality))).toBe(false);
			expect((job?.data as { created?: string[] } | null)?.created ?? []).toEqual([
				qualityPath(identity, '240'),
			]);
		},
		120_000,
	);

	test.if(HAVE_FFMPEG)(
		'no source file ⇒ REFUSED before a job id exists',
		async () => {
			// The panel shows "Processing" the moment it gets a job id, so a refusal
			// that is knowable up front must be raised up front.
			const sectionId = await createSectionRecord(SCRATCH_SECTION, -1);
			scratchIds.push(sectionId);
			const identity: MediaIdentity = {
				componentTipo: AV_COMPONENT,
				sectionTipo: SCRATCH_SECTION,
				sectionId,
				lang: null,
			};
			await expect(submitAvVersionBuild(av, identity, pathOpts, '240')).rejects.toThrow(
				AvBuildRefused,
			);
		},
		30_000,
	);

	test.if(HAVE_FFMPEG)(
		'the original tier is refused as a build target',
		async () => {
			const identity = await scratchWithOriginal();
			await expect(
				submitAvVersionBuild(av, identity, pathOpts, av.originalQuality),
			).rejects.toThrow(AvBuildRefused);
			// AvBuildRefused IS a DedaloError family (errors/families.ts pattern):
			// the pre-flight refusal converts to the registered 400 the panel renders.
			expect(
				(await refusalOf(submitAvVersionBuild(av, identity, pathOpts, av.originalQuality))).code,
			).toBe('media.av_build_refused');
		},
		60_000,
	);
});
