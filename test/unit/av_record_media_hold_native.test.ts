/**
 * A1-01 review M3 — THE RECORD DOORS THAT MOVE AV FILES HOLD THE COMPONENT.
 *
 * Three doors move every file of a record's av components outside the job
 * manager: the record delete (deleteSectionRecord → removeSectionMediaFiles),
 * the data wipe (deleteSectionData → the same mover) and the Time Machine
 * undelete (restoreSection → restoreDeletedSectionMediaFiles). Before this gate
 * they moved the tiers a live build or upload was writing. Now each takes the
 * RECORD AV HOLD (av_component_claim.ts holdRecordAvComponents) BEFORE it writes
 * anything — a busy component refuses the whole operation with
 * `media.build_running`, the row, its Time Machine and the disk untouched — and
 * holds it through its file sweep. The movers themselves refuse an av slot they
 * do not hold (their own hold when the caller passes none).
 *
 * Situation: the generic `test` TLD (test3, test94 = component_av), scratch
 * records created here with a real 404 tier and a minted files_info item
 * (sync_files), deleted after; media under the marked SUITE root; "another
 * instance" = a second MediaJobManager on the same processes dir.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../src/config/config.ts';
import { mediaTypeOf } from '../../src/core/concepts/media.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { AvRecordHold, holdRecordAvComponents } from '../../src/core/media/av_component_claim.ts';
import { avIngestTarget } from '../../src/core/media/av_versions.ts';
import { runBinary } from '../../src/core/media/engine/spawn.ts';
import { removeSectionMediaFiles } from '../../src/core/media/file_ops.ts';
import { MediaJobManager, mediaJobs } from '../../src/core/media/jobs.ts';
import { resolveMediaPathOptions } from '../../src/core/media/ontology_path.ts';
import {
	buildMediaLocation,
	type MediaIdentity,
	requireMediaRoot,
} from '../../src/core/media/path.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import {
	deleteSectionData,
	deleteSectionRecord,
} from '../../src/core/section/record/delete_record.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import { restoreSection } from '../../tools/tool_time_machine/server/tool_time_machine.ts';
import { mustGet } from '../helpers/assert.ts';
import { refusalOf } from '../helpers/refusal.ts';

const av = mustGet(mediaTypeOf('component_av'), 'component_av spec');
const SECTION = 'test3';
const AV_COMPONENT = 'test94';
const scratchIds: number[] = [];

interface Situation {
	identity: MediaIdentity;
	tier: string;
}

/** A real 1 s mp4 at `path`. */
async function writeVideo(path: string): Promise<void> {
	mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
	await runBinary(
		[
			config.media.binaries.ffmpeg,
			'-y',
			'-f',
			'lavfi',
			'-i',
			'testsrc=duration=1:size=160x90:rate=10',
			'-t',
			'1',
			'-c:v',
			'libx264',
			'-pix_fmt',
			'yuv420p',
			path,
		],
		{ nice: false },
	);
}

/**
 * A scratch record whose av component has its 404 tier on disk AND a stored
 * files_info item (minted by the operator's sync_files — the one path that may),
 * so the record's media column names the component and the sweeps walk it.
 */
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
	const loaded = await getLoadedTool('tool_media_versions');
	const syncFiles = mustGet(loaded?.module.apiActions.sync_files, 'sync_files');
	await syncFiles.handler({
		principal: await resolvePrincipal(-1),
		userId: -1,
		background: false,
		options: { tipo: AV_COMPONENT, section_tipo: SECTION, section_id: sectionId },
	});
	expect(await storedAvKey(sectionId)).toBe(true);
	return { identity, tier };
}

/** Does the record's media column name the av component? (null = no row) */
async function storedAvKey(sectionId: number): Promise<boolean | null> {
	const table = mustGet(await getMatrixTableFromTipo(SECTION), 'matrix table');
	const rows = (await sql.unsafe(
		`SELECT media ? $3 AS has FROM "${table}" WHERE section_tipo = $1 AND section_id = $2`,
		[SECTION, sectionId, AV_COMPONENT],
	)) as { has: boolean | null }[];
	return rows[0] === undefined ? null : rows[0].has === true;
}

async function rowExists(sectionId: number): Promise<boolean> {
	return (await storedAvKey(sectionId)) !== null;
}

async function tmRowCount(sectionId: number): Promise<number> {
	const rows = (await sql.unsafe(
		'SELECT count(*)::int AS n FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
		[SECTION, sectionId],
	)) as { n: number }[];
	return rows[0]?.n ?? 0;
}

/** Every file of the record's av component under the media root — "the disk". */
function diskOf(s: Situation): string[] {
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
	walk(requireMediaRoot());
	return found.sort();
}

/** Hold the component the way an upload does (the engine's own ingest target). */
function holdAsUpload(s: Situation): () => void {
	const claim = mustGet(mediaJobs.claimTarget(avIngestTarget(av, s.identity)), 'upload claim');
	return () => claim.release();
}

function componentFree(s: Situation, lang: string | null = null): boolean {
	const probe = mediaJobs.claimTarget(avIngestTarget(av, { ...s.identity, lang }));
	probe?.release();
	return probe !== null;
}

/** The record's newest whole-record Time Machine snapshot (the undelete's input). */
async function deletedSnapshot(sectionId: number): Promise<{ id: number; data: unknown }> {
	const rows = (await sql.unsafe(
		`SELECT id, data FROM matrix_time_machine
		  WHERE section_tipo = $1 AND section_id = $2 AND tipo = $1
		  ORDER BY id DESC LIMIT 1`,
		[SECTION, sectionId],
	)) as { id: number; data: unknown }[];
	return mustGet(rows[0], 'deleted snapshot');
}

beforeAll(() => {
	requireMediaRoot();
});

afterAll(async () => {
	const failures: string[] = [];
	for (const id of scratchIds) {
		try {
			if (await rowExists(id)) await deleteSectionRecord(SECTION, id, -1);
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

describe('the record delete holds its av components', () => {
	test('a live upload refuses the delete — row, Time Machine and disk untouched', async () => {
		const s = await situation();
		const disk = diskOf(s);
		const tm = await tmRowCount(s.identity.sectionId);
		const release = holdAsUpload(s);
		try {
			const refused = await refusalOf(deleteSectionRecord(SECTION, s.identity.sectionId, -1));
			expect(refused.code).toBe('media.build_running');
			expect(await rowExists(s.identity.sectionId)).toBe(true);
			expect(await tmRowCount(s.identity.sectionId)).toBe(tm);
			expect(diskOf(s)).toEqual(disk);
		} finally {
			release();
		}
		expect(componentFree(s)).toBe(true);
	}, 60_000);

	test('free: the delete runs, its sweep moves the tier under the hold, the component is given back', async () => {
		const s = await situation();
		const result = await deleteSectionRecord(SECTION, s.identity.sectionId, -1);
		expect(result.removed).toBe(true);
		expect(await rowExists(s.identity.sectionId)).toBe(false);
		// Moved, not left live: the sweep ran WITH the hold (a released or a
		// missing hold refuses the av slot and leaves the file where it was).
		expect(existsSync(s.tier)).toBe(false);
		expect(diskOf(s).some((line) => line.includes('/deleted/'))).toBe(true);
		expect(componentFree(s)).toBe(true);
	}, 60_000);

	test('a FIRST upload (no media key stored yet) refuses it: the declared av components are held', async () => {
		const sectionId = await createSectionRecord(SECTION, -1);
		scratchIds.push(sectionId);
		const s: Situation = {
			identity: { componentTipo: AV_COMPONENT, sectionTipo: SECTION, sectionId, lang: null },
			tier: '',
		};
		expect(await storedAvKey(sectionId)).toBe(false);
		const release = holdAsUpload(s);
		try {
			const refused = await refusalOf(deleteSectionRecord(SECTION, sectionId, -1));
			expect(refused.code).toBe('media.build_running');
			expect(await rowExists(sectionId)).toBe(true);
		} finally {
			release();
		}
		expect(componentFree(s)).toBe(true);
	}, 60_000);

	test('ANOTHER INSTANCE building a lang the record does not name refuses it too (the lock files are listed)', async () => {
		const s = await situation();
		const other = new MediaJobManager({ instanceId: 'a101-m3-other', lockHeartbeatMs: 0 });
		const claim = mustGet(
			other.claimTarget(avIngestTarget(av, { ...s.identity, lang: 'lg-spa' })),
			'other instance claim',
		);
		// A lock on ANOTHER component of the same record is not this one's lang.
		const neighbour = mustGet(
			other.claimTarget(avIngestTarget(av, { ...s.identity, componentTipo: 'test81' })),
			'neighbour claim',
		);
		try {
			expect(mediaJobs.liveComponentLangs(SECTION, s.identity.sectionId, AV_COMPONENT)).toEqual([
				'lg-spa',
			]);
			const refused = await refusalOf(deleteSectionRecord(SECTION, s.identity.sectionId, -1));
			expect(refused.code).toBe('media.build_running');
			expect(await rowExists(s.identity.sectionId)).toBe(true);
			// The slots the refused hold had already taken were given back.
			expect(componentFree(s)).toBe(true);
		} finally {
			claim.release();
			neighbour.release();
		}
		expect(componentFree(s, 'lg-spa')).toBe(true);
	}, 60_000);
});

describe('the data wipe holds its av components', () => {
	test('a live upload refuses the wipe — nothing emptied, no Time Machine row, disk untouched', async () => {
		const s = await situation();
		const disk = diskOf(s);
		const tm = await tmRowCount(s.identity.sectionId);
		const release = holdAsUpload(s);
		try {
			const refused = await refusalOf(deleteSectionData(SECTION, s.identity.sectionId, -1));
			expect(refused.code).toBe('media.build_running');
			expect(await storedAvKey(s.identity.sectionId)).toBe(true);
			expect(await tmRowCount(s.identity.sectionId)).toBe(tm);
			expect(diskOf(s)).toEqual(disk);
		} finally {
			release();
		}
		expect(componentFree(s)).toBe(true);
	}, 60_000);

	test('free: the wipe empties the key and its sweep moves the tier under the hold', async () => {
		const s = await situation();
		await deleteSectionData(SECTION, s.identity.sectionId, -1);
		expect(await storedAvKey(s.identity.sectionId)).toBe(false);
		expect(existsSync(s.tier)).toBe(false);
		expect(componentFree(s)).toBe(true);
	}, 60_000);
});

describe('the Time Machine undelete holds its av components', () => {
	test('a live hold refuses the undelete — no row back, the files stay in deleted/; free, both come back', async () => {
		const s = await situation();
		await deleteSectionRecord(SECTION, s.identity.sectionId, -1);
		const snapshot = await deletedSnapshot(s.identity.sectionId);
		const disk = diskOf(s);
		const release = holdAsUpload(s);
		try {
			const refused = await refusalOf(
				restoreSection(snapshot.data, snapshot.id, SECTION, s.identity.sectionId, -1),
			);
			expect(refused.code).toBe('media.build_running');
			expect(await rowExists(s.identity.sectionId)).toBe(false);
			expect(diskOf(s)).toEqual(disk);
		} finally {
			release();
		}
		await restoreSection(snapshot.data, snapshot.id, SECTION, s.identity.sectionId, -1);
		expect(await rowExists(s.identity.sectionId)).toBe(true);
		// Restored by the file half, which ran under the restore's own hold.
		expect(existsSync(s.tier)).toBe(true);
		expect(componentFree(s)).toBe(true);
	}, 60_000);
});

describe('the movers and the hold itself', () => {
	test('a mover with no caller hold refuses a busy av slot: reported, the file stays live', async () => {
		const s = await situation();
		// A v6-era item says `lg-nolan`: the same untranslatable slot a build holds as null.
		const media = { [AV_COMPONENT]: [{ lang: 'lg-nolan' }] };
		const release = holdAsUpload(s);
		try {
			const outcome = await removeSectionMediaFiles(SECTION, s.identity.sectionId, media);
			expect(outcome.errors.some((error) => error.includes('record media refused'))).toBe(true);
			expect(existsSync(s.tier)).toBe(true);
		} finally {
			release();
		}
		expect(componentFree(s)).toBe(true);
	}, 60_000);

	test('a released hold takes nothing, and holdRecordAvComponents holds every slot it names', async () => {
		const s = await situation();
		const hold = await holdRecordAvComponents(SECTION, s.identity.sectionId, {
			[AV_COMPONENT]: [{ lang: 'lg-eng' }],
		});
		expect(componentFree(s)).toBe(false);
		expect(componentFree(s, 'lg-eng')).toBe(false);
		hold.release();
		expect(componentFree(s)).toBe(true);
		expect(componentFree(s, 'lg-eng')).toBe(true);
		expect(hold.take(AV_COMPONENT, null)).toBe(false);
		expect(componentFree(s)).toBe(true);
		// An av key the section does NOT declare (test81 lives in test158) is held
		// too when the media column names it.
		const foreign = { ...s.identity, componentTipo: 'test81' };
		const busy = mustGet(mediaJobs.claimTarget(avIngestTarget(av, foreign)), 'test81 claim');
		try {
			const refused = await refusalOf(
				holdRecordAvComponents(SECTION, s.identity.sectionId, { test81: [] }),
			);
			expect(refused.code).toBe('media.build_running');
		} finally {
			busy.release();
		}
		const fresh = new AvRecordHold(SECTION, s.identity.sectionId);
		expect(fresh.take(AV_COMPONENT, null)).toBe(true);
		expect(fresh.take(AV_COMPONENT, null)).toBe(true);
		fresh.release();
		expect(componentFree(s)).toBe(true);
	}, 60_000);
});
