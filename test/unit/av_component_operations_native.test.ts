/**
 * A1-01 owner ruling 4 — EVERY AV OPERATION THAT WRITES TIER FILES OUTSIDE THE
 * JOB MANAGER JOINS THE PER-COMPONENT LOCK.
 *
 * conform_headers, delete_quality, delete_version, sync_files (Regenerate), the
 * av thumb build, posterframe create / delete, and the update-cache regenerate
 * sweep each write files of an av component synchronously. Before this gate they
 * ran straight through a live build or upload of the same component: a remux of
 * the 404 while the ingest transcode wrote it, a delete of the master an encode
 * was reading. Now each holds the component claim (withAvComponentClaim — the
 * arbiter's own claim, memory + lock file) for its whole write and refuses with
 * `media.build_running` while anything else holds it.
 *
 * Per operation, against its own mutation (drop the wrapper there): with the
 * component held by an upload claim, the operation answers media.build_running
 * and the disk is byte-for-byte what it was. Controls: free, delete_version and
 * delete_posterframe run and give the component back. The helper itself: holds
 * during the work, releases on a throw, runs any other model unheld.
 *
 * Situation: the generic `test` TLD (test3, test94 = component_av), scratch
 * records created here and deleted after, media under the marked SUITE root
 * (the handlers resolve it from config) swept by this file's own identifiers.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { config } from '../../src/config/config.ts';
import type { ApiRequestContext } from '../../src/core/api/handler_context.ts';
import { componentAvApiActions } from '../../src/core/api/handlers/dd_component_av_api.ts';
import { mediaTypeOf } from '../../src/core/concepts/media.ts';
import { sql } from '../../src/core/db/postgres.ts';
import {
	avComponentTarget,
	withAvComponentClaim,
} from '../../src/core/media/av_component_claim.ts';
import { avIngestTarget } from '../../src/core/media/av_versions.ts';
import { runBinary } from '../../src/core/media/engine/spawn.ts';
import { mediaJobs } from '../../src/core/media/jobs.ts';
import { resolveMediaPathOptions } from '../../src/core/media/ontology_path.ts';
import {
	buildMediaLocation,
	type MediaIdentity,
	type MediaPathOptions,
	requireMediaRoot,
} from '../../src/core/media/path.ts';
import { regenerateMediaDerivatives } from '../../src/core/media/repair.ts';
import { posterframeAbsolutePath } from '../../src/core/media/tools/posterframe.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { deleteSectionRecord } from '../../src/core/section/record/delete_record.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import { mustGet } from '../helpers/assert.ts';
import { refusalOf } from '../helpers/refusal.ts';

const av = mustGet(mediaTypeOf('component_av'), 'component_av spec');
const image = mustGet(mediaTypeOf('component_image'), 'component_image spec');
const HAVE_FFMPEG = Bun.which(config.media.binaries.ffmpeg) !== null;
const SECTION = 'test3';
const AV_COMPONENT = 'test94';
const THUMB = config.media.thumb.quality;
const scratchIds: number[] = [];

interface Situation {
	identity: MediaIdentity;
	pathOpts: MediaPathOptions;
	tier: string;
}

/** A real 1 s mp4 with audio at `path`. */
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

/** A scratch record whose av component has its default tier (404) on disk. */
async function situation(): Promise<Situation> {
	const sectionId = await createSectionRecord(SECTION, -1);
	scratchIds.push(sectionId);
	const identity: MediaIdentity = {
		componentTipo: AV_COMPONENT,
		sectionTipo: SECTION,
		sectionId,
		lang: null,
	};
	const pathOpts = await resolveMediaPathOptions(AV_COMPONENT, SECTION, sectionId);
	const tier = buildMediaLocation(av, identity, av.defaultQuality, 'mp4', pathOpts).absolutePath;
	await writeVideo(tier);
	return { identity, pathOpts, tier };
}

/** Every file under the record's av folders, with its bytes' length + mtime — "the disk". */
function diskOf(s: Situation): string[] {
	const root = requireMediaRoot();
	const own = new RegExp(`^${AV_COMPONENT}_${SECTION}_${s.identity.sectionId}[._]`);
	const found: string[] = [];
	const walk = (dir: string): void => {
		if (!existsSync(dir)) return;
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			const stat = statSync(full);
			if (stat.isDirectory()) walk(full);
			else if (own.test(entry)) found.push(`${full}:${stat.size}:${stat.mtimeMs}`);
		}
	};
	walk(root);
	return found.sort();
}

/** Hold the component the way an upload does (the engine's own ingest target). */
function holdComponent(s: Situation): () => void {
	const claim = mustGet(mediaJobs.claimTarget(avIngestTarget(av, s.identity)), 'upload claim');
	return () => claim.release();
}

function componentFree(s: Situation): boolean {
	const probe = mediaJobs.claimTarget(avIngestTarget(av, s.identity));
	probe?.release();
	return probe !== null;
}

async function toolAction(action: string, s: Situation, options: Record<string, unknown>) {
	const loaded = await getLoadedTool('tool_media_versions');
	const entry = mustGet(loaded?.module.apiActions[action], action);
	return entry.handler({
		principal: await resolvePrincipal(-1),
		userId: -1,
		background: false,
		options: {
			tipo: AV_COMPONENT,
			section_tipo: SECTION,
			section_id: s.identity.sectionId,
			...options,
		},
	});
}

async function posterframeAction(op: 'create' | 'delete', s: Situation) {
	const handler = mustGet(componentAvApiActions[`${op}_posterframe`], `${op}_posterframe`);
	return handler(
		{
			action: `${op}_posterframe`,
			source: { tipo: AV_COMPONENT, section_tipo: SECTION, section_id: s.identity.sectionId },
			options: { current_time: '0.2' },
		} as never,
		{
			requestId: 'a101-ops',
			clientIp: '127.0.0.1',
			principal: await resolvePrincipal(-1),
		} as unknown as ApiRequestContext,
	);
}

/** The refusal: build_running, nothing on disk changed, the holder still holds. */
async function expectRefused(s: Situation, run: () => Promise<unknown>): Promise<void> {
	const before = diskOf(s);
	const release = holdComponent(s);
	try {
		const refused = await refusalOf(run());
		expect(refused.code).toBe('media.build_running');
		expect(diskOf(s)).toEqual(before);
	} finally {
		release();
	}
	expect(componentFree(s)).toBe(true);
}

beforeAll(() => {
	requireMediaRoot();
});

afterAll(async () => {
	const failures: string[] = [];
	for (const id of scratchIds) {
		for (const job of mediaJobs.jobsForRecord(SECTION, id)) {
			for (
				let i = 0;
				i < 120 && ['queued', 'running'].includes(String(mediaJobs.status(job.id)?.status));
				i++
			) {
				await Bun.sleep(250);
			}
		}
		try {
			await deleteSectionRecord(SECTION, id, -1);
		} catch (error) {
			failures.push(`${SECTION}/${id}: ${(error as Error).message}`);
		}
	}
	const root = requireMediaRoot();
	for (const id of scratchIds) {
		const own = new RegExp(`^${AV_COMPONENT}_${SECTION}_${id}[._]`);
		const walk = (dir: string): void => {
			if (!existsSync(dir)) return;
			for (const entry of readdirSync(dir)) {
				const full = join(dir, entry);
				if (statSync(full).isDirectory()) walk(full);
				else if (own.test(entry)) rmSync(full, { force: true });
			}
		};
		walk(root);
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[SECTION, id],
		);
	}
	if (failures.length > 0) throw new Error(`scratch cleanup failed: ${failures.join('; ')}`);
});

describe('withAvComponentClaim', () => {
	test.if(HAVE_FFMPEG)('holds the component during the work and gives it back after', async () => {
		const s = await situation();
		let heldDuring = false;
		await withAvComponentClaim(av, s.identity, 'probe', async () => {
			heldDuring = !componentFree(s);
		});
		expect(heldDuring).toBe(true);
		expect(componentFree(s)).toBe(true);
	});

	test.if(HAVE_FFMPEG)('gives it back when the work throws', async () => {
		const s = await situation();
		const thrown = await refusalOf(
			withAvComponentClaim(av, s.identity, 'probe', async () => {
				throw new Error('a101: work failed');
			}),
		).catch((error: unknown) => error);
		expect(String((thrown as Error).message ?? thrown)).toContain('a101: work failed');
		expect(componentFree(s)).toBe(true);
	});

	test('another model runs unheld — no claim taken, none needed', async () => {
		let ran = false;
		let freeDuring = false;
		const identity: MediaIdentity = {
			componentTipo: 'test99',
			sectionTipo: SECTION,
			sectionId: 1,
			lang: null,
		};
		// Hold the component FIRST: a non-av operation must neither take the
		// av hold nor be refused by it (the rule is av's).
		const held = mediaJobs.claimTarget(avComponentTarget(identity, 'other'));
		expect(held).not.toBeNull();
		try {
			await withAvComponentClaim(image, identity, 'probe', async () => {
				ran = true;
			});
		} finally {
			held?.release();
		}
		await withAvComponentClaim(image, identity, 'probe', async () => {
			const probe = mediaJobs.claimTarget(avComponentTarget(identity, 'probe'));
			probe?.release();
			freeDuring = probe !== null;
		});
		expect(ran).toBe(true);
		expect(freeDuring).toBe(true);
	});
});

describe('each av operation refuses while the component is held, the disk untouched', () => {
	test.if(HAVE_FFMPEG)(
		'conform_headers',
		async () => {
			const s = await situation();
			await expectRefused(s, () =>
				toolAction('conform_headers', s, { quality: av.defaultQuality }),
			);
		},
		60_000,
	);

	test.if(HAVE_FFMPEG)(
		'delete_quality',
		async () => {
			const s = await situation();
			await expectRefused(s, () => toolAction('delete_quality', s, { quality: av.defaultQuality }));
			expect(existsSync(s.tier)).toBe(true);
		},
		60_000,
	);

	test.if(HAVE_FFMPEG)(
		'delete_version',
		async () => {
			const s = await situation();
			await expectRefused(s, () =>
				toolAction('delete_version', s, { quality: av.defaultQuality, extension: 'mp4' }),
			);
			expect(existsSync(s.tier)).toBe(true);
		},
		60_000,
	);

	test.if(HAVE_FFMPEG)(
		'sync_files (Regenerate)',
		async () => {
			const s = await situation();
			await expectRefused(s, () => toolAction('sync_files', s, {}));
		},
		60_000,
	);

	test.if(HAVE_FFMPEG)(
		'build_version of the thumb tier',
		async () => {
			const s = await situation();
			await expectRefused(s, () => toolAction('build_version', s, { quality: THUMB }));
		},
		60_000,
	);

	test.if(HAVE_FFMPEG)(
		'create_posterframe',
		async () => {
			const s = await situation();
			await expectRefused(s, () => posterframeAction('create', s));
			expect(existsSync(posterframeAbsolutePath(av, s.identity, s.pathOpts))).toBe(false);
		},
		60_000,
	);

	test.if(HAVE_FFMPEG)(
		'delete_posterframe',
		async () => {
			const s = await situation();
			const poster = posterframeAbsolutePath(av, s.identity, s.pathOpts);
			mkdirSync(poster.slice(0, poster.lastIndexOf('/')), { recursive: true });
			writeFileSync(poster, 'a101 posterframe');
			await expectRefused(s, () => posterframeAction('delete', s));
			expect(readFileSync(poster, 'utf8')).toBe('a101 posterframe');
		},
		60_000,
	);

	test.if(HAVE_FFMPEG)(
		'the update-cache regenerate sweep reports it and builds nothing',
		async () => {
			const s = await situation();
			const before = diskOf(s);
			const release = holdComponent(s);
			try {
				const errors = await regenerateMediaDerivatives({
					componentTipo: AV_COMPONENT,
					sectionTipo: SECTION,
					sectionId: s.identity.sectionId,
					model: 'component_av',
					items: [{ lang: null }],
					pathOpts: s.pathOpts,
				});
				expect(errors.join(' ')).toContain('a build or another operation holds');
				expect(diskOf(s)).toEqual(before);
			} finally {
				release();
			}
		},
		60_000,
	);
});

describe('controls: a free component lets the operation run and gives it back', () => {
	test.if(HAVE_FFMPEG)(
		'delete_version moves the tier and frees the component',
		async () => {
			const s = await situation();
			await toolAction('delete_version', s, { quality: av.defaultQuality, extension: 'mp4' });
			expect(existsSync(s.tier)).toBe(false);
			expect(componentFree(s)).toBe(true);
		},
		60_000,
	);

	test.if(HAVE_FFMPEG)(
		'delete_posterframe removes it and frees the component',
		async () => {
			const s = await situation();
			const poster = posterframeAbsolutePath(av, s.identity, s.pathOpts);
			mkdirSync(poster.slice(0, poster.lastIndexOf('/')), { recursive: true });
			writeFileSync(poster, 'a101 posterframe');
			await posterframeAction('delete', s);
			// The planted still is gone (moved to deleted/); the thumb self-heal may
			// mint a fresh one from the video right after — never these bytes.
			expect(existsSync(poster) && readFileSync(poster, 'utf8') === 'a101 posterframe').toBe(false);
			expect(componentFree(s)).toBe(true);
		},
		60_000,
	);
});
