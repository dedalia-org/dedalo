/**
 * A1-01 — AN AV UPLOAD WHILE A BUILD OF THE SAME COMPONENT IS LIVE IS REFUSED.
 *
 * v6 (tool_upload :80, component_av::is_build_locked) refused the upload,
 * removed the staged file and allowed one build per component. Before this gate
 * the engine started a SECOND ingest transcode for the same target: whichever
 * finished last won the default tier (possibly the encode of the OLD master),
 * and the two files_info write-backs raced.
 *
 * What is pinned, each against its own mutation:
 *  - a live build on the default tier OR the audio tier refuses the upload with
 *    `media.build_running`; the staged file is gone, the original byte-identical,
 *    no job added (processUploadedFile → claimAvBuildTarget);
 *  - no live build lets the upload through, and its transcode ADOPTS the claim;
 *  - two CONCURRENT uploads: exactly one passes, exactly one job (the claim, not
 *    a bare hasLiveJobForTarget question across the awaited move);
 *  - submitAvTranscode called directly with a live build is refused, no job
 *    added (the exclusive submit — no second door);
 *  - submitAvVersionBuild racing a claim between its pre-flight and its submit
 *    is refused (exclusive there too — the pre-flight question is asked before
 *    an await);
 *  - THE WIRE: tool_upload's handler throws the code; a persist that throws
 *    gives the claim back (IngestResult.releaseBuildClaim), or the component
 *    would refuse every upload until a restart.
 *
 * Situation: the generic `test` TLD (test3 playground, test94 = component_av),
 * scratch records created here and deleted after; media in a scratch root (the
 * core cases) or the marked SUITE media root (the tool wire, which resolves its
 * root from config), job pfiles in a marked scratch processes dir.
 */

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { uploadMedia } from '../../src/ai/mcp/tools/media.ts';
import { config } from '../../src/config/config.ts';
import { mediaTypeOf } from '../../src/core/concepts/media.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { toErrorEnvelope } from '../../src/core/errors/convert.ts';
import {
	avIngestTarget,
	submitAvTranscode,
	submitAvVersionBuild,
} from '../../src/core/media/av_versions.ts';
import { runBinary } from '../../src/core/media/engine/spawn.ts';
import { stagingDir } from '../../src/core/media/ingest/add_file.ts';
import { ingestAndPersistDeferred } from '../../src/core/media/ingest/ingest_and_persist.ts';
import { processUploadedFile } from '../../src/core/media/ingest/process_uploaded_file.ts';
import { type JobTarget, MediaJobManager, mediaJobs } from '../../src/core/media/jobs.ts';
import {
	buildMediaLocation,
	type MediaIdentity,
	type MediaPathOptions,
	requireMediaRoot,
} from '../../src/core/media/path.ts';
import * as files_info_persist from '../../src/core/media/tools/files_info_persist.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { deleteSectionRecord } from '../../src/core/section/record/delete_record.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import { mustGet } from '../helpers/assert.ts';
import { markMediaRoot, markProcessesDir } from '../helpers/media_scratch_root.ts';
import { refusalOf, refusalOfSync } from '../helpers/refusal.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

// Snapshot the REAL module BEFORE any mock.module swap (process-global; a
// spread copy, never the live namespace — mock_isolation_tripwire rule 3).
const REAL_FILES_INFO_PERSIST = { ...files_info_persist };

const ROOT = scratchDir('av_upload_build_guard');
// The job-manager seam: this file's jobs write their pfiles here, never into
// the live ../private/processes tree. Restored in afterAll.
const previousProcessesDir = process.env.DEDALO_MEDIA_PROCESSES_DIR;
process.env.DEDALO_MEDIA_PROCESSES_DIR = markProcessesDir(join(ROOT, 'processes'));
const av = mustGet(mediaTypeOf('component_av'), 'component_av spec');
const HAVE_FFMPEG = Bun.which(config.media.binaries.ffmpeg) !== null;
const pathOpts: MediaPathOptions = { initialMediaPath: '', maxItemsFolder: 1000, mediaRoot: ROOT };
const USER_ID = 7;
const KEY_DIR = 'kd_a101';
const SECTION = 'test3';
const AV_COMPONENT = 'test94';
/** A second component_av of the test TLD (test81): the different-component control. */
const OTHER_AV_COMPONENT = 'test81';

/** Records this file created (deleted in afterAll); `deleted` ones are already gone. */
const scratchIds: number[] = [];
const deletedIds: number[] = [];
/** Blocking workers still holding a target — released in afterAll whatever happened. */
const releases: (() => void)[] = [];

/**
 * The ingest transcode's target, stated HERE rather than imported: the gate
 * pins which tiers the upload must treat as busy (the default + the audio
 * tier the same job writes), independent of the engine's own derivation.
 */
function ingestTarget(identity: MediaIdentity, quality: string = av.defaultQuality): JobTarget {
	return {
		section_tipo: identity.sectionTipo,
		section_id: identity.sectionId,
		component_tipo: identity.componentTipo,
		lang: identity.lang ?? null,
		quality,
	};
}

/** A live build on `target` that runs until released (maintenance lane: never holds the media slot). */
function liveBuild(manager: MediaJobManager, target: JobTarget): () => void {
	let release = (): void => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	manager.submit('test_live_build', async () => await gate, { lane: 'maintenance', target });
	releases.push(release);
	return release;
}

/** A real 1 s 320x180 mp4 with an audio stream, written to `path`. */
async function writeVideo(path: string): Promise<void> {
	mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
	await runBinary(
		[
			config.media.binaries.ffmpeg,
			'-y',
			'-f',
			'lavfi',
			'-i',
			'testsrc=duration=1:size=320x180:rate=10',
			'-f',
			'lavfi',
			'-i',
			'anullsrc=r=44100:cl=stereo',
			'-t',
			'1',
			'-c:v',
			'libx264',
			'-pix_fmt',
			'yuv420p',
			'-c:a',
			'aac',
			'-shortest',
			path,
		],
		{ nice: false },
	);
}

const stagedPath = (tmpName: string, root?: string, userId = USER_ID): string =>
	join(stagingDir(userId, KEY_DIR, root), tmpName);
const originalPath = (identity: MediaIdentity): string =>
	buildMediaLocation(av, identity, av.originalQuality, 'mp4', pathOpts).absolutePath;

/** A scratch test3 record with a real av ORIGINAL already on disk. */
async function recordWithOriginal(): Promise<MediaIdentity> {
	const sectionId = await createSectionRecord(SECTION, -1);
	scratchIds.push(sectionId);
	const identity: MediaIdentity = {
		componentTipo: AV_COMPONENT,
		sectionTipo: SECTION,
		sectionId,
		lang: null,
	};
	await writeVideo(originalPath(identity));
	return identity;
}

const ingest = (identity: MediaIdentity, tmpName: string) =>
	processUploadedFile({
		spec: av,
		identity,
		pathOpts,
		userId: USER_ID,
		keyDir: KEY_DIR,
		tmpName,
		extension: 'mp4',
	});

/** Poll a media job to a terminal state (or give up). */
async function awaitJob(jobId: string): Promise<void> {
	for (let i = 0; i < 240; i++) {
		const status = mediaJobs.status(jobId)?.status;
		if (status !== 'queued' && status !== 'running') return;
		await Bun.sleep(250);
	}
}

const liveJobsOf = (identity: MediaIdentity): number =>
	mediaJobs
		.jobsForRecord(identity.sectionTipo, identity.sectionId)
		.filter((job) => job.status === 'queued' || job.status === 'running').length;

/** Every file under `dir` whose name matches `needle` (the suite root's cleanup). */
function filesNamed(dir: string, needle: RegExp): string[] {
	if (!existsSync(dir)) return [];
	const found: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const stat = statSync(full);
		if (stat.isDirectory()) found.push(...filesNamed(full, needle));
		else if (needle.test(entry)) found.push(full);
	}
	return found;
}

beforeAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
	markMediaRoot(ROOT);
	markProcessesDir(join(ROOT, 'processes'));
});

afterAll(async () => {
	for (const release of releases) release();
	// Every job this file started (transcodes into the SUITE root included) ends
	// BEFORE the sweep, or it writes behind it.
	for (const id of [...scratchIds, ...deletedIds]) {
		for (const job of mediaJobs.jobsForRecord(SECTION, id)) await awaitJob(job.id);
	}
	const failures: string[] = [];
	for (const id of scratchIds) {
		try {
			const outcome = await deleteSectionRecord(SECTION, id, -1);
			if (outcome.removed !== true) failures.push(`${SECTION}/${id}: ${JSON.stringify(outcome)}`);
		} catch (error) {
			failures.push(`${SECTION}/${id}: ${(error as Error).message}`);
		}
	}
	// AFTER the deletes (which move a record's media to `deleted/` under a
	// `<id>_deleted_<stamp>` name): sweep this file's identifiers out of the
	// marked SUITE root, live and deleted copies alike.
	for (const id of [...scratchIds, ...deletedIds]) {
		const own = new RegExp(`^${AV_COMPONENT}_${SECTION}_${id}[._]`);
		for (const file of filesNamed(requireMediaRoot(), own)) rmSync(file, { force: true });
	}
	// The tool wire stages under the suite root as user -1: this file's key dir.
	rmSync(stagingDir(-1, KEY_DIR), { recursive: true, force: true });
	for (const id of [...scratchIds, ...deletedIds]) {
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[SECTION, id],
		);
	}
	if (previousProcessesDir === undefined)
		Reflect.deleteProperty(process.env, 'DEDALO_MEDIA_PROCESSES_DIR');
	else process.env.DEDALO_MEDIA_PROCESSES_DIR = previousProcessesDir;
	rmSync(ROOT, { recursive: true, force: true });
	if (failures.length > 0) throw new Error(`scratch cleanup failed: ${failures.join('; ')}`);
});

describe('A1-01 job manager: claims + the exclusive submit', () => {
	test('a claim is refused while any tier it occupies is live, and frees on release', async () => {
		const manager = new MediaJobManager({ budgets: { media: 2, maintenance: 4 } });
		const identity: MediaIdentity = {
			componentTipo: AV_COMPONENT,
			sectionTipo: SECTION,
			sectionId: 1,
			lang: null,
		};
		const wide: JobTarget = { ...ingestTarget(identity), also_qualities: ['audio'] };
		// The AUDIO tier alone being live blocks the ingest target (its companion).
		const releaseAudio = liveBuild(manager, ingestTarget(identity, 'audio'));
		expect(manager.claimTarget(wide)).toBeNull();
		releaseAudio();
		await Bun.sleep(20);
		const first = mustGet(manager.claimTarget(wide), 'first claim');
		// A claim is live to every reader of the index…
		expect(manager.hasLiveJobForTarget(ingestTarget(identity))).toBe(true);
		expect(manager.hasLiveJobForTarget(ingestTarget(identity, 'audio'))).toBe(true);
		// …so a second claim is refused, synchronously.
		expect(manager.claimTarget(wide)).toBeNull();
		first.release();
		first.release(); // idempotent
		expect(manager.hasLiveJobForTarget(ingestTarget(identity))).toBe(false);
		mustGet(manager.claimTarget(wide), 'claim after release').release();
	});

	test('an exclusive submit over a live tier is refused and registers nothing', () => {
		const manager = new MediaJobManager({ budgets: { media: 2, maintenance: 4 } });
		const identity: MediaIdentity = {
			componentTipo: AV_COMPONENT,
			sectionTipo: SECTION,
			sectionId: 2,
			lang: null,
		};
		liveBuild(manager, ingestTarget(identity));
		const before = manager.jobsForRecord(SECTION, 2).length;
		const refused = refusalOfSync(() =>
			manager.submit('av_transcode', async () => null, {
				lane: 'media',
				target: ingestTarget(identity),
				exclusive: true,
			}),
		);
		expect(refused.code).toBe('media.build_running');
		expect(toErrorEnvelope(refused, { requestId: 'a101' }).status).toBe(409);
		expect(manager.jobsForRecord(SECTION, 2).length).toBe(before);
	});

	test('a submit ADOPTS its claim: the tier never frees in between, and frees when the job ends', async () => {
		const manager = new MediaJobManager({ budgets: { media: 2, maintenance: 4 } });
		const identity: MediaIdentity = {
			componentTipo: AV_COMPONENT,
			sectionTipo: SECTION,
			sectionId: 3,
			lang: null,
		};
		const claim = mustGet(manager.claimTarget(ingestTarget(identity)), 'claim');
		let finish = (): void => {};
		const gate = new Promise<void>((resolve) => {
			finish = resolve;
		});
		releases.push(finish);
		manager.submit('av_transcode', async () => await gate, {
			lane: 'media',
			target: ingestTarget(identity),
			exclusive: true,
			claim,
		});
		claim.release(); // adopted: a no-op, the JOB holds the tier now
		expect(manager.hasLiveJobForTarget(ingestTarget(identity))).toBe(true);
		finish();
		await Bun.sleep(20);
		expect(manager.hasLiveJobForTarget(ingestTarget(identity))).toBe(false);
	});
});

describe('A1-01 the av upload door (processUploadedFile)', () => {
	for (const tier of [av.defaultQuality, 'audio']) {
		test.if(HAVE_FFMPEG)(
			`a live build of the '${tier}' tier refuses the upload: staged file gone, original intact, no job added`,
			async () => {
				const identity = await recordWithOriginal();
				const originalBytes = readFileSync(originalPath(identity));
				const release = liveBuild(mediaJobs, ingestTarget(identity, tier));
				const tmpName = `refused_${tier}.mp4`;
				await writeVideo(stagedPath(tmpName, ROOT));
				const jobsBefore = mediaJobs.jobsForRecord(SECTION, identity.sectionId).length;

				const refused = await refusalOf(ingest(identity, tmpName));
				expect(refused.code).toBe('media.build_running');
				expect(existsSync(stagedPath(tmpName, ROOT))).toBe(false);
				expect(readFileSync(originalPath(identity)).equals(originalBytes)).toBe(true);
				expect(mediaJobs.jobsForRecord(SECTION, identity.sectionId).length).toBe(jobsBefore);
				release();
			},
			60_000,
		);
	}

	test.if(HAVE_FFMPEG)(
		'no live build: the upload lands and its transcode is the one job',
		async () => {
			const identity = await recordWithOriginal();
			await writeVideo(stagedPath('free.mp4', ROOT));
			const result = await ingest(identity, 'free.mp4');
			expect(existsSync(stagedPath('free.mp4', ROOT))).toBe(false);
			const jobId = mustGet(result.startTranscode, 'startTranscode')();
			expect(liveJobsOf(identity)).toBe(1);
			await awaitJob(jobId);
			expect(mediaJobs.status(jobId)?.status).toBe('done');
			expect(mediaJobs.hasLiveJobForTarget(ingestTarget(identity))).toBe(false);
		},
		120_000,
	);

	test('an ingest that throws after the claim gives the build target back', async () => {
		const identity: MediaIdentity = {
			componentTipo: AV_COMPONENT,
			sectionTipo: SECTION,
			sectionId: 4,
			lang: null,
		};
		// No staged file: the move (after the claim) throws media.file_not_found.
		const refused = await refusalOf(ingest(identity, 'never_staged.mp4'));
		expect(refused.code).toBe('media.file_not_found');
		const claim = mediaJobs.claimTarget({ ...ingestTarget(identity), also_qualities: ['audio'] });
		expect(claim).not.toBeNull();
		claim?.release();
	});

	test.if(HAVE_FFMPEG)(
		'an upload that offers no transcode gives the build target back at once',
		async () => {
			// An av file parked in the audio tier of a record with NO original: there
			// is nothing to derive from, so no transcode is offered (media_ingest).
			const identity: MediaIdentity = {
				componentTipo: AV_COMPONENT,
				sectionTipo: SECTION,
				sectionId: 5,
				lang: null,
			};
			await writeVideo(stagedPath('parked.mp4', ROOT));
			const result = await processUploadedFile({
				spec: av,
				identity,
				pathOpts,
				userId: USER_ID,
				keyDir: KEY_DIR,
				tmpName: 'parked.mp4',
				extension: 'mp4',
				quality: 'audio',
			});
			expect(result.startTranscode).toBeNull();
			const claim = mediaJobs.claimTarget({ ...ingestTarget(identity), also_qualities: ['audio'] });
			expect(claim).not.toBeNull();
			claim?.release();
		},
		60_000,
	);

	test.if(HAVE_FFMPEG)(
		'two CONCURRENT uploads of one component: exactly one passes, exactly one job',
		async () => {
			const identity = await recordWithOriginal();
			await writeVideo(stagedPath('race_a.mp4', ROOT));
			await writeVideo(stagedPath('race_b.mp4', ROOT));
			const settled = await Promise.allSettled([
				ingest(identity, 'race_a.mp4'),
				ingest(identity, 'race_b.mp4'),
			]);
			const passed = settled.filter((outcome) => outcome.status === 'fulfilled');
			const refused = settled.filter((outcome) => outcome.status === 'rejected');
			expect(passed.length).toBe(1);
			expect(refused.length).toBe(1);
			expect((refused[0] as PromiseRejectedResult).reason?.code).toBe('media.build_running');
			// Neither staged file is left: one was ingested, one discarded.
			expect(existsSync(stagedPath('race_a.mp4', ROOT))).toBe(false);
			expect(existsSync(stagedPath('race_b.mp4', ROOT))).toBe(false);
			const winner = (passed[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof ingest>>>)
				.value;
			const jobId = mustGet(winner.startTranscode, 'startTranscode')();
			expect(liveJobsOf(identity)).toBe(1);
			await awaitJob(jobId);
		},
		120_000,
	);

	test.if(HAVE_FFMPEG)(
		'submitAvTranscode called directly over a live build is refused, no job added',
		async () => {
			const identity = await recordWithOriginal();
			for (const tier of [av.defaultQuality, 'audio']) {
				const release = liveBuild(mediaJobs, ingestTarget(identity, tier));
				const before = mediaJobs.jobsForRecord(SECTION, identity.sectionId).length;
				const refused = refusalOfSync(() => submitAvTranscode(av, identity, pathOpts, 'mp4'));
				expect(refused.code).toBe('media.build_running');
				expect(mediaJobs.jobsForRecord(SECTION, identity.sectionId).length).toBe(before);
				release();
				await Bun.sleep(20);
			}
		},
		60_000,
	);

	test.if(HAVE_FFMPEG)(
		'a per-quality build racing a claim between its pre-flight and its submit is refused',
		async () => {
			const identity = await recordWithOriginal();
			const before = mediaJobs.jobsForRecord(SECTION, identity.sectionId).length;
			// The pre-flight's synchronous half runs NOW (no live job → passes), then
			// the build awaits the probe; the claim lands in that window.
			const build = submitAvVersionBuild(av, identity, pathOpts, '240');
			const claim = mustGet(mediaJobs.claimTarget(ingestTarget(identity, '240')), 'claim');
			try {
				const refused = await refusalOf(build);
				expect(refused.code).toBe('media.build_running');
				expect(mediaJobs.jobsForRecord(SECTION, identity.sectionId).length).toBe(before);
			} finally {
				claim.release();
			}
		},
		60_000,
	);
});

describe('A1-01 review MED-2: one build per COMPONENT (v6 build lock parity)', () => {
	// v6 held ONE lock file per component (component_av::get_build_lock_path):
	// an upload, the ingest transcode and any per-quality build of the same
	// component exclude each other whatever tier they write. A tier-scoped guard
	// let a 1080 build run while an upload replaced the master it reads.

	/**
	 * Fill the media lane with held jobs, so a build submitted next stays
	 * QUEUED — live (indexed), never running — for as long as the gate needs.
	 */
	function holdMediaLane(): () => void {
		const depth = mediaJobs.laneDepths().media;
		const frees: (() => void)[] = [];
		for (let i = depth.active; i < depth.max; i++) {
			let free = (): void => {};
			const gate = new Promise<void>((resolve) => {
				free = resolve;
			});
			mediaJobs.submit('test_lane_hold', async () => await gate, { lane: 'media' });
			frees.push(free);
			releases.push(free);
		}
		return () => {
			for (const free of frees) free();
		};
	}

	/** A real per-quality build, held queued; returns its job id. */
	async function queuedBuild(identity: MediaIdentity, quality: string): Promise<string> {
		const jobId = await submitAvVersionBuild(av, identity, pathOpts, quality);
		expect(mediaJobs.status(jobId)?.status).toBe('queued');
		return jobId;
	}

	test.if(HAVE_FFMPEG)(
		'a live 1080 build refuses the upload: staged file gone, original intact',
		async () => {
			const identity = await recordWithOriginal();
			const originalBytes = readFileSync(originalPath(identity));
			const freeLane = holdMediaLane();
			let jobId: string | null = null;
			try {
				jobId = await queuedBuild(identity, '1080');
				await writeVideo(stagedPath('over_1080.mp4', ROOT));
				const refused = await refusalOf(ingest(identity, 'over_1080.mp4'));
				expect(refused.code).toBe('media.build_running');
				expect(existsSync(stagedPath('over_1080.mp4', ROOT))).toBe(false);
				expect(readFileSync(originalPath(identity)).equals(originalBytes)).toBe(true);
			} finally {
				freeLane();
				if (jobId !== null) await awaitJob(jobId);
			}
		},
		120_000,
	);

	test.if(HAVE_FFMPEG)(
		'a held upload claim (the deferred door) refuses a 1080 build, no job added',
		async () => {
			const identity = await recordWithOriginal();
			await writeVideo(stagedPath('held.mp4', ROOT));
			const held = await ingestAndPersistDeferred({
				spec: av,
				identity,
				pathOpts,
				userId: USER_ID,
				keyDir: KEY_DIR,
				tmpName: 'held.mp4',
				extension: 'mp4',
			});
			try {
				const before = mediaJobs.jobsForRecord(SECTION, identity.sectionId).length;
				const refused = await refusalOf(submitAvVersionBuild(av, identity, pathOpts, '1080'));
				expect(refused.code).toBe('media.build_running');
				expect(mediaJobs.jobsForRecord(SECTION, identity.sectionId).length).toBe(before);
			} finally {
				held.transcode.release();
			}
		},
		120_000,
	);

	test('a busy component is answered FIRST: build_running before the source is even looked for', async () => {
		// A record with NO original: a pre-flight that asked about the source
		// before the component would answer media.av_build_refused ("no original").
		const sectionId = await createSectionRecord(SECTION, -1);
		scratchIds.push(sectionId);
		const identity: MediaIdentity = {
			componentTipo: AV_COMPONENT,
			sectionTipo: SECTION,
			sectionId,
			lang: null,
		};
		const claim = mustGet(mediaJobs.claimTarget(avIngestTarget(av, identity)), 'upload claim');
		try {
			const refused = await refusalOf(submitAvVersionBuild(av, identity, pathOpts, '1080'));
			expect(refused.code).toBe('media.build_running');
		} finally {
			claim.release();
		}
	});

	test.if(HAVE_FFMPEG)(
		'two builds of different tiers of one component: the second is refused',
		async () => {
			const identity = await recordWithOriginal();
			const freeLane = holdMediaLane();
			let jobId: string | null = null;
			try {
				jobId = await queuedBuild(identity, '1080');
				const before = mediaJobs.jobsForRecord(SECTION, identity.sectionId).length;
				const refused = await refusalOf(submitAvVersionBuild(av, identity, pathOpts, '720'));
				expect(refused.code).toBe('media.build_running');
				expect(mediaJobs.jobsForRecord(SECTION, identity.sectionId).length).toBe(before);
			} finally {
				freeLane();
				if (jobId !== null) await awaitJob(jobId);
			}
		},
		120_000,
	);

	test.if(HAVE_FFMPEG)(
		'different components of one record: a build of one leaves the other free to upload and build',
		async () => {
			const identity = await recordWithOriginal();
			const other: MediaIdentity = { ...identity, componentTipo: OTHER_AV_COMPONENT };
			await writeVideo(originalPath(other));
			const freeLane = holdMediaLane();
			const jobIds: string[] = [];
			try {
				jobIds.push(await queuedBuild(identity, '1080'));
				await writeVideo(stagedPath('other.mp4', ROOT));
				const uploaded = await processUploadedFile({
					spec: av,
					identity: other,
					pathOpts,
					userId: USER_ID,
					keyDir: KEY_DIR,
					tmpName: 'other.mp4',
					extension: 'mp4',
				});
				uploaded.releaseBuildClaim();
				jobIds.push(await queuedBuild(other, '1080'));
				expect(jobIds.length).toBe(2);
			} finally {
				freeLane();
				for (const jobId of jobIds) await awaitJob(jobId);
			}
		},
		120_000,
	);
});

describe('A1-01 the ingest door (ingest_and_persist.ts)', () => {
	test.if(HAVE_FFMPEG)(
		'deferred: the build claim is held until the caller settles it — release frees it, start adopts it',
		async () => {
			const identity = await recordWithOriginal();
			const busy = (): boolean => {
				const probe = mediaJobs.claimTarget({
					...ingestTarget(identity),
					also_qualities: ['audio'],
				});
				probe?.release();
				return probe === null;
			};
			await writeVideo(stagedPath('deferred_a.mp4', ROOT));
			const released = await ingestAndPersistDeferred({
				spec: av,
				identity,
				pathOpts,
				userId: USER_ID,
				keyDir: KEY_DIR,
				tmpName: 'deferred_a.mp4',
				extension: 'mp4',
			});
			expect(busy()).toBe(true);
			released.transcode.release();
			expect(busy()).toBe(false);

			await writeVideo(stagedPath('deferred_b.mp4', ROOT));
			const started = await ingestAndPersistDeferred({
				spec: av,
				identity,
				pathOpts,
				userId: USER_ID,
				keyDir: KEY_DIR,
				tmpName: 'deferred_b.mp4',
				extension: 'mp4',
			});
			const jobId = mustGet(started.transcode.start(), 'deferred transcode job');
			started.transcode.release(); // after start: a no-op, the JOB holds the slot
			expect(liveJobsOf(identity)).toBe(1);
			await awaitJob(jobId);
			expect(busy()).toBe(false);
		},
		120_000,
	);
});

describe('A1-01 the tool_upload wire', () => {
	async function callUpload(sectionId: number, tmpName: string): Promise<unknown> {
		const loaded = await getLoadedTool('tool_upload');
		const upload = mustGet(
			loaded?.module.apiActions.process_uploaded_file,
			'process_uploaded_file',
		);
		return upload.handler({
			principal: await resolvePrincipal(-1),
			userId: -1,
			background: false,
			options: {
				tipo: AV_COMPONENT,
				section_tipo: SECTION,
				section_id: sectionId,
				file_data: { key_dir: KEY_DIR, tmp_name: tmpName, extension: 'mp4' },
			},
		});
	}

	test.if(HAVE_FFMPEG)(
		'process_uploaded_file answers media.build_running (409) and discards the staged file',
		async () => {
			const sectionId = await createSectionRecord(SECTION, -1);
			scratchIds.push(sectionId);
			const identity: MediaIdentity = {
				componentTipo: AV_COMPONENT,
				sectionTipo: SECTION,
				sectionId,
				lang: null,
			};
			const release = liveBuild(mediaJobs, ingestTarget(identity));
			const tmpName = `${AV_COMPONENT}_${SECTION}_${sectionId}.wire.mp4`;
			await writeVideo(stagedPath(tmpName, undefined, -1));
			const refused = await refusalOf(callUpload(sectionId, tmpName));
			expect(refused.code).toBe('media.build_running');
			expect(toErrorEnvelope(refused, { requestId: 'a101' }).status).toBe(409);
			expect(existsSync(stagedPath(tmpName, undefined, -1))).toBe(false);
			release();
		},
		60_000,
	);

	test.if(HAVE_FFMPEG)(
		'a persist that throws gives the build target back (releaseBuildClaim)',
		async () => {
			// A record that no longer exists: the ingest lands the file, the persist
			// throws resource.not_found — after the claim was taken.
			const sectionId = await createSectionRecord(SECTION, -1);
			const removed = await deleteSectionRecord(SECTION, sectionId, -1);
			expect(removed.removed).toBe(true);
			deletedIds.push(sectionId);
			const identity: MediaIdentity = {
				componentTipo: AV_COMPONENT,
				sectionTipo: SECTION,
				sectionId,
				lang: null,
			};
			const tmpName = `${AV_COMPONENT}_${SECTION}_${sectionId}.gone.mp4`;
			await writeVideo(stagedPath(tmpName, undefined, -1));
			const refused = await refusalOf(callUpload(sectionId, tmpName));
			expect(refused.code).toBe('resource.not_found');
			// Held, this would refuse every later upload of the component.
			const claim = mediaJobs.claimTarget({
				...ingestTarget(identity),
				also_qualities: ['audio'],
			});
			expect(claim).not.toBeNull();
			claim?.release();
		},
		60_000,
	);
});

describe('A1-01 the MCP upload door', () => {
	afterEach(() => {
		mock.module('../../src/core/media/tools/files_info_persist.ts', () => REAL_FILES_INFO_PERSIST);
	});

	test.if(HAVE_FFMPEG)(
		'upload_media: a persist that throws gives the build target back (releaseBuildClaim)',
		async () => {
			const sectionId = await createSectionRecord(SECTION, -1);
			scratchIds.push(sectionId);
			const identity: MediaIdentity = {
				componentTipo: AV_COMPONENT,
				sectionTipo: SECTION,
				sectionId,
				lang: null,
			};
			const source = join(ROOT, 'mcp_source.mp4');
			await writeVideo(source);
			// The door stages under a fresh `mcp_<uuid>` key dir of user -1 in the
			// suite root; whatever this case adds there is removed below.
			const userStaging = stagingDir(-1, 'x').slice(0, -2);
			const stagedBefore = new Set(existsSync(userStaging) ? readdirSync(userStaging) : []);
			// The fault the door must survive: the persist fails AFTER the ingest took
			// the claim (a record locked or deleted mid-flight).
			mock.module('../../src/core/media/tools/files_info_persist.ts', () => ({
				...REAL_FILES_INFO_PERSIST,
				persistUploadedMedia: async () => {
					throw new Error('a101: injected persist failure');
				},
			}));
			await expect(
				uploadMedia(await resolvePrincipal(-1), {
					section_tipo: SECTION,
					section_id: sectionId,
					field: AV_COMPONENT,
					source: {
						kind: 'base64',
						data: readFileSync(source).toString('base64'),
						filename: 'mcp_source.mp4',
					},
				}),
			).rejects.toThrow('a101: injected persist failure');
			for (const entry of readdirSync(userStaging)) {
				if (!stagedBefore.has(entry) && entry.startsWith('mcp_')) {
					rmSync(join(userStaging, entry), { recursive: true, force: true });
				}
			}
			const claim = mediaJobs.claimTarget({
				...ingestTarget(identity),
				also_qualities: ['audio'],
			});
			expect(claim).not.toBeNull();
			claim?.release();
		},
		60_000,
	);
});

describe('A1-01 the tool_import_files door', () => {
	afterEach(() => {
		mock.module('../../src/core/media/tools/files_info_persist.ts', () => REAL_FILES_INFO_PERSIST);
	});

	async function callImport(sectionId: number, tmpName: string) {
		const loaded = await getLoadedTool('tool_import_files');
		const importFiles = mustGet(loaded?.module.apiActions.import_files, 'import_files');
		const response = await importFiles.handler({
			principal: await resolvePrincipal(-1),
			userId: -1,
			background: true,
			options: {
				section_tipo: SECTION,
				tipo: AV_COMPONENT,
				section_id: sectionId,
				key_dir: KEY_DIR,
				// Pre-matched (`section_id` per file): the import writes onto the
				// scratch record this case created, never a fresh one.
				files_data: [{ name: tmpName, tmp_name: tmpName, section_id: sectionId }],
			},
		});
		return response.data as { imported: number; errors: string[] };
	}

	test.if(HAVE_FFMPEG)(
		'ingestAndPersistDeferred: a persist that throws gives the build target back',
		async () => {
			const identity = await recordWithOriginal();
			await writeVideo(stagedPath('deferred_fail.mp4', ROOT));
			mock.module('../../src/core/media/tools/files_info_persist.ts', () => ({
				...REAL_FILES_INFO_PERSIST,
				persistUploadedMedia: async () => {
					throw new Error('a101: injected persist failure');
				},
			}));
			await expect(
				ingestAndPersistDeferred({
					spec: av,
					identity,
					pathOpts,
					userId: USER_ID,
					keyDir: KEY_DIR,
					tmpName: 'deferred_fail.mp4',
					extension: 'mp4',
				}),
			).rejects.toThrow('a101: injected persist failure');
			const claim = mediaJobs.claimTarget({ ...ingestTarget(identity), also_qualities: ['audio'] });
			expect(claim).not.toBeNull();
			claim?.release();
		},
		60_000,
	);

	test.if(HAVE_FFMPEG)(
		'import_files: a persist that throws gives the build target back, and the next import proceeds',
		async () => {
			const sectionId = await createSectionRecord(SECTION, -1);
			scratchIds.push(sectionId);
			const identity: MediaIdentity = {
				componentTipo: AV_COMPONENT,
				sectionTipo: SECTION,
				sectionId,
				lang: null,
			};
			const first = `${sectionId}-imp1.mp4`;
			await writeVideo(stagedPath(first, undefined, -1));
			mock.module('../../src/core/media/tools/files_info_persist.ts', () => ({
				...REAL_FILES_INFO_PERSIST,
				persistUploadedMedia: async () => {
					throw new Error('a101: injected persist failure');
				},
			}));
			const failed = await callImport(sectionId, first);
			// The batch reports the file's failure (it never aborts on one file)…
			expect(failed.imported).toBe(0);
			expect(failed.errors.join(' ')).toContain('a101: injected persist failure');
			// …and the component is NOT left refusing every later upload.
			mock.module(
				'../../src/core/media/tools/files_info_persist.ts',
				() => REAL_FILES_INFO_PERSIST,
			);
			const second = `${sectionId}-imp2.mp4`;
			await writeVideo(stagedPath(second, undefined, -1));
			const passed = await callImport(sectionId, second);
			expect(passed.errors).toEqual([]);
			expect(passed.imported).toBe(1);
			for (const job of mediaJobs.jobsForRecord(SECTION, sectionId)) await awaitJob(job.id);
			expect(mediaJobs.hasLiveJobForTarget(ingestTarget(identity))).toBe(false);
		},
		120_000,
	);
});
