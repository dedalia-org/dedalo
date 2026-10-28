/**
 * update_code WIDGET wiring (UPDATE_PROCESS Phase 4) — where the panel meets
 * the engine (silently broken until 2026-08-15). The BUILD action's option-shape
 * gate moved with the action to serve_code_widget_native.test.ts (2026-09-28).
 *
 *  - the reachability PROBE's role. The panel probes each configured code
 *     server with `get_server_ready_status`, and the remote answers only for the
 *     role it holds — asking a code-only master the ONTOLOGY question got a
 *     refusal, so its row rendered UNREACHABLE with the radio disabled.
 *
 * Pure wiring: asserted through the widget's own getValue, with the engine call
 * intercepted, so no network is involved. Also pins the split: the consumer panel
 * no longer registers the build action nor answers `code_server`.
 *
 *  - the IMAGE-UPDATE REQUEST and its cancel (installer unification D3/D4,
 *     2026-10-09; core/update/image_update_request.ts): every refusal id, in the
 *     gate order, against a scratch channel dir; success writes exactly ONE
 *     request; the walk verdict is the identity walk's (version_walk.ts
 *     identityWalkRefusal — the data walk's on a release or -dev target, a
 *     prerelease named by its identity); a claimed request
 *     cannot be cancelled. The widget's own door is asked once, on this real
 *     checkout, for the refusal → `coordinates.reason` mapping.
 */

import { afterAll, describe, expect, mock, test } from 'bun:test';
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realDataIoModule from '../../src/core/ontology/data_io_import.ts';

const REAL_DATA_IO = { ...realDataIoModule };

/**
 * The panel's getValue now judges the DATABASE backup dir (`backup_fresh`, a full
 * pg_restore read that writes `.verified` sidecars). Without this the call read —
 * and wrote sidecars into — the installation's ../private/backups/db.
 */
const SCRATCH_BACKUP_DIR = mkdtempSync(join(tmpdir(), 'dedalo_update_code_widget_backups_'));

afterAll(() => {
	mock.module('../../src/core/ontology/data_io_import.ts', () => REAL_DATA_IO);
	mock.restore();
	rmSync(SCRATCH_BACKUP_DIR, { recursive: true, force: true });
});

/** The widget module, imported AFTER the mocks so its dynamic imports see them. */
async function widgetModule() {
	return await import('../../src/core/area_maintenance/widgets/update_code.ts');
}

describe('update_code is the CONSUMER panel only (serve_code split)', () => {
	test('no build action, no code_server half', async () => {
		const { widget } = await widgetModule();
		expect(Object.keys(widget.apiActions ?? {}).sort()).toEqual([
			'cancel_image_update_request',
			'delete_restore_point',
			'request_image_update',
			'restore_code',
			'update_code',
		]);
	});
});

describe('code-server reachability probe', () => {
	test('the panel probes each configured server for the CODE role', async () => {
		const asked: unknown[] = [];
		mock.module('../../src/core/ontology/data_io_import.ts', () => ({
			...REAL_DATA_IO,
			checkRemoteServer: async (server: { url: string }, check?: string) => {
				asked.push({ url: server.url, check });
				return { result: { result: true }, msg: 'OK', errors: [], code: 200 };
			},
		}));
		const realConfigModule = await import('../../src/config/config.ts');
		const REAL_CONFIG = { ...realConfigModule };
		try {
			mock.module('../../src/config/config.ts', () => ({
				...REAL_CONFIG,
				config: {
					...REAL_CONFIG.config,
					ops: { ...REAL_CONFIG.config.ops, backupDir: SCRATCH_BACKUP_DIR },
					update: {
						...REAL_CONFIG.config.update,
						codeServers: [
							{ name: 'master', url: 'https://m.example/dedalo/core/api/v1/json/', code: 'c' },
						],
					},
				},
			}));
			// SAFETY BEFORE THE CALL, measured as an outcome: the directory the panel
			// will judge IS the scratch one. If the mock ever stops reaching the
			// backup module, this reds instead of touching the installation's dumps.
			const { getBackupDir } = await import('../../src/core/area_maintenance/backup.ts');
			expect(getBackupDir()).toBe(SCRATCH_BACKUP_DIR);
			const { widget } = await widgetModule();
			const value = await widget.getValue?.({}, {} as never);
			expect(readdirSync(SCRATCH_BACKUP_DIR)).toEqual([]); // judged, nothing planted
			// asking 'ontology_server' here is what made a code-only master
			// unreachable forever — the probe must name the role it needs.
			expect(asked).toEqual([
				{ url: 'https://m.example/dedalo/core/api/v1/json/', check: 'code_server' },
			]);
			const data = value?.data as { servers: { response_code: number }[] };
			expect('code_server' in data).toBe(false);
			const servers = data.servers;
			expect(servers.length).toBe(1);
			expect(servers[0]?.response_code).toBe(200);
		} finally {
			mock.module('../../src/config/config.ts', () => REAL_CONFIG);
		}
	});
});

describe("the panel's bounded wait, as PRODUCTION binds it (OPS-1, I3)", () => {
	test("a superuser's getValue answers within PANEL_WAIT_MS while a full read blocks", async () => {
		// Every other panel leg injects `waitMs`; this one passes NOTHING but the
		// configured backup dir and pg binaries, exactly as the HTTP request does.
		// A default that awaited the settled verdict (or waited an hour) hung the
		// panel request on a multi-GB read past the server's idle timeout.
		const dir = join(SCRATCH_BACKUP_DIR, 'bounded');
		const binDir = join(SCRATCH_BACKUP_DIR, 'bounded_bin');
		const gate = join(SCRATCH_BACKUP_DIR, 'bounded.release');
		mkdirSync(dir, { recursive: true });
		mkdirSync(binDir, { recursive: true });
		const archive = join(dir, '2026-01-01_000000.zz.postgresql_-1_forced_dbv7.custom.backup');
		writeFileSync(archive, 'PGDMP a dump cut short');
		const halfHourAgo = new Date(Date.now() - 30 * 60_000);
		utimesSync(archive, halfHourAgo, halfHourAgo);
		// The TOC lists; the FULL read blocks until released (self-releasing after
		// 30 s, far past PANEL_WAIT_MS ≤ 5 s), then reports the cut.
		writeFileSync(
			join(binDir, 'pg_restore'),
			`#!/bin/sh\nif [ "$1" = "--list" ]; then exit 0; fi\ni=0\nwhile [ ! -f '${gate}' ] && [ $i -lt 600 ]; do sleep 0.05; i=$((i+1)); done\necho "pg_restore: error: could not read from input file: end of file" >&2\nexit 1\n`,
		);
		chmodSync(join(binDir, 'pg_restore'), 0o755);
		const realConfigModule = await import('../../src/config/config.ts');
		const REAL_CONFIG = { ...realConfigModule };
		const { SUPERUSER_ID } = await import('../../src/core/security/permissions.ts');
		const { PANEL_WAIT_MS } = await import('../../src/core/update/preconditions.ts');
		const backup = await import('../../src/core/area_maintenance/backup.ts');
		try {
			mock.module('../../src/config/config.ts', () => ({
				...REAL_CONFIG,
				config: {
					...REAL_CONFIG.config,
					ops: { ...REAL_CONFIG.config.ops, backupDir: dir, pgBinPath: binDir },
					// No code server: this leg measures the backup line, not the network.
					update: { ...REAL_CONFIG.config.update, codeServers: [] },
				},
			}));
			// SAFETY as an outcome: the dir and the binary the panel will use are ours.
			expect(backup.getBackupDir()).toBe(dir);
			expect(backup.resolvePgRestore()).toBe(join(binDir, 'pg_restore'));
			const { widget } = await widgetModule();
			const startedAt = performance.now();
			const value = await widget.getValue?.({}, { userId: SUPERUSER_ID } as never);
			expect(performance.now() - startedAt).toBeLessThan(PANEL_WAIT_MS + 5000);
			const checks = (
				value?.data as { consumer: { checks: { id: string; state: string; detail?: string }[] } }
			).consumer.checks;
			const line = checks.find((check) => check.id === 'backup_fresh');
			expect(line?.state).toBe('warn');
			expect(line?.detail).toBe('verifying');
			// Settle the detached scan before the config is restored.
			writeFileSync(gate, '');
			await backup.newestUsableBackup(dir);
		} finally {
			writeFileSync(gate, '');
			mock.module('../../src/config/config.ts', () => REAL_CONFIG);
		}
	}, 60_000);
});

describe('the update_code JOB hands its stop to the pipeline (OPS-1 review, third round)', () => {
	test("a STOP of the widget's job aborts the signal updateCode awaits on", async () => {
		// code_update.ts refuses a stopped run before the swap (code_update.test.ts
		// drives that with its own controller); this is the wiring half: the job the
		// widget submits must pass ITS signal, or no operator stop ever reaches the
		// pipeline. The pipeline is intercepted — nothing is fetched or swapped.
		const realCodeUpdate = await import('../../src/core/update/code_update.ts');
		const REAL_CODE_UPDATE = { ...realCodeUpdate };
		const seen = Promise.withResolvers<AbortSignal | undefined>();
		const release = Promise.withResolvers<void>();
		mock.module('../../src/core/update/code_update.ts', () => ({
			...REAL_CODE_UPDATE,
			updateCode: async (
				_options: unknown,
				_principal: unknown,
				seams: { signal?: AbortSignal },
			) => {
				seen.resolve(seams.signal);
				await release.promise;
				return { ok: true };
			},
		}));
		try {
			const { mediaJobs } = await import('../../src/core/media/jobs.ts');
			const { SUPERUSER_ID } = await import('../../src/core/security/permissions.ts');
			const { widget } = await widgetModule();
			const response = await widget.apiActions?.update_code?.({}, {
				userId: SUPERUSER_ID,
			} as never);
			const pfile = String((response?.extend as { pfile?: unknown } | undefined)?.pfile ?? '');
			const jobId = pfile.replace(/\.json$/, '');
			const signal = await seen.promise;
			expect(signal).toBeInstanceOf(AbortSignal);
			expect(signal?.aborted).toBe(false);
			expect(mediaJobs.stop(jobId)).toBe(true);
			expect(signal?.aborted).toBe(true);
		} finally {
			release.resolve();
			mock.module('../../src/core/update/code_update.ts', () => REAL_CODE_UPDATE);
		}
	});
});

// ---------------------------------------------------------------------------
// request_image_update / cancel_image_update_request
// ---------------------------------------------------------------------------

describe('the image-update request (D3/D4): gates, one write, and the walk rule', () => {
	const NOW = new Date('2026-10-09T12:00:00.000Z');
	const dirs: string[] = [];
	afterAll(async () => {
		const { setServerState } = await import('../../src/core/resolve/server_state.ts');
		setServerState({ maintenance_mode: false });
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	});

	async function modules() {
		const request = await import('../../src/core/update/image_update_request.ts');
		const channel = await import('../../src/core/update/image_update_channel.ts');
		const walk = await import('../../src/core/update/version_walk.ts');
		const { setServerState } = await import('../../src/core/resolve/server_state.ts');
		const { SUPERUSER_ID } = await import('../../src/core/security/permissions.ts');
		const { DEDALO_ENGINE_VERSION } = await import('../../src/core/update/build_stamp.ts');
		const { readEnv } = await import('../../src/config/env.ts');
		// the scratch state file the preload points at — never the live server's
		expect(readEnv('DEDALO_TS_STATE_PATH')).toBeDefined();
		setServerState({ maintenance_mode: true });
		return {
			...request,
			...channel,
			...walk,
			setServerState,
			superuser: { userId: SUPERUSER_ID } as never,
			DEDALO_ENGINE_VERSION,
		};
	}

	/** A scratch channel dir with a host updater that checked in `secondsAgo`, pinned at `pinned`. */
	function channelDir(secondsAgo: number | null = 10, pinned = '7.0.0'): string {
		const dir = mkdtempSync(join(tmpdir(), 'dedalo_image_request_'));
		dirs.push(dir);
		if (secondsAgo !== null) {
			writeFileSync(
				join(dir, 'host_updater.json'),
				JSON.stringify({
					schema: 1,
					interval_seconds: 60,
					mode: 'pull',
					image: 'ghcr.io/test/dedalo',
					pinned,
					verify: 'none',
					running_digest: null,
					seen_at: new Date(NOW.getTime() - secondsAgo * 1000).toISOString(),
				}),
			);
		}
		return dir;
	}

	const CURRENT = [7, 0, 0] as const;
	/** The engine the walk starts from — pinned: the checkout's own identity moves with the commit. */
	const RUNNING = '7.0.0';
	const seams = (
		dir: string,
		channel: 'image' | 'tree_swap' = 'image',
	): import('../../src/core/update/image_update_request.ts').ImageRequestSeams => ({
		dir,
		channel,
		now: NOW,
		running: RUNNING,
	});
	const requestFiles = (dir: string) =>
		readdirSync(dir).filter((name) => name === 'request.json' || name === 'inflight.json');

	test('the preconditions throw their own typed errors first (superuser, then maintenance mode)', async () => {
		const m = await modules();
		const dir = channelDir();
		await expect(
			m.requestImageUpdate({ version: '7.0.1' }, { userId: 42 } as never, seams(dir)),
		).rejects.toThrow();
		m.setServerState({ maintenance_mode: false });
		try {
			await m.requestImageUpdate({ version: '7.0.1' }, m.superuser, seams(dir));
			throw new Error('expected a refusal');
		} catch (error) {
			expect((error as { code?: string }).code).toBe('maintenance.mode_required');
		}
		m.setServerState({ maintenance_mode: true });
		expect(requestFiles(dir)).toEqual([]);
	});

	test('every refusal id, in gate order, and none of them writes', async () => {
		const m = await modules();
		const ask = (options: Record<string, unknown>, dir: string, channel?: 'image' | 'tree_swap') =>
			m.requestImageUpdate(options, m.superuser, seams(dir, channel));
		const fresh = channelDir();
		expect(await ask({ version: '7.0.1' }, fresh, 'tree_swap')).toEqual({
			ok: false,
			reason: 'not_image_channel',
		});
		expect(await ask({ version: '7.0.1' }, channelDir(null))).toEqual({
			ok: false,
			reason: 'host_updater_not_alive',
		});
		expect(await ask({ version: '7.0.1' }, channelDir(181))).toEqual({
			ok: false,
			reason: 'host_updater_not_alive',
		});
		for (const options of [
			{},
			{ version: '7.0' },
			{ version: '7.0.1-dev' },
			{ version: '7.0.1', channel: 'nightly' },
			{ version: 701 },
		]) {
			expect(await ask(options, fresh)).toEqual({ ok: false, reason: 'malformed_version' });
		}
		expect(requestFiles(fresh)).toEqual([]);
	});

	test('the walk verdict is the identity walk’s, by id (the data walk’s for a release or -dev target)', async () => {
		const m = await modules();
		const cases: [Record<string, unknown>, string | null][] = [
			[{ version: '7.0.1' }, null],
			[{ version: '7.1.0' }, null],
			[{ version: '8.0.0' }, null],
			[{ version: '7.0.0' }, 'not_newer_release'],
			[{ version: '6.9.9' }, 'downgrade_or_same_version'],
			[{ version: '7.0.2' }, 'version_skip'],
			[{ version: '7.2.0' }, 'version_skip'],
			[{ version: '9.0.0' }, 'version_skip'],
		];
		for (const [options, walk] of cases) {
			const target = m.requestedTag(options);
			expect(target).not.toBeNull();
			// the expectation table agrees with THE rule (positive control on the table)
			const sentence = m.assertLinearUpgrade(CURRENT, target?.triple ?? [], target?.channel);
			expect(sentence === null).toBe(walk === null);
			expect(m.walkRefusalOf(RUNNING, target?.identity ?? '', target?.channel)).toBe(walk as never);
			// an installation already on developer images, so the walk is what decides
			const result = await m.requestImageUpdate(
				options,
				m.superuser,
				seams(channelDir(10, '7.0.0-dev')),
			);
			if (walk === null) expect(result.ok).toBe(true);
			else expect(result as unknown).toEqual({ ok: false, reason: 'version_refused', walk });
		}
	});

	test('a PRERELEASE item is requested by its identity: the tag IS the release, the walk starts from the running identity', async () => {
		const m = await modules();
		// malformed: no release, a release of another triple, a release that is no prerelease
		for (const options of [
			{ version: '7.0.1', channel: 'prerelease' },
			{ version: '7.0.1', channel: 'prerelease', release: '7.0.2-beta.1' },
			{ version: '7.0.1', channel: 'prerelease', release: '7.0.1' },
			{ version: '7.0.1', channel: 'prerelease', release: '7.0.1-pre.1' },
		]) {
			const dir = channelDir();
			expect(await m.requestImageUpdate(options, m.superuser, seams(dir))).toEqual({
				ok: false,
				reason: 'malformed_version',
			});
			expect(requestFiles(dir)).toEqual([]);
		}
		// the next rung's prerelease from a release: recorded, tagged by the identity
		const dir = channelDir();
		const result = await m.requestImageUpdate(
			{ version: '7.0.1', channel: 'prerelease', release: '7.0.1-beta.2' },
			m.superuser,
			seams(dir),
		);
		expect(result.ok).toBe(true);
		const written = JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8'));
		expect({ tag: written.tag, version: written.version, channel: written.channel }).toEqual({
			tag: '7.0.1-beta.2',
			version: '7.0.1',
			channel: 'prerelease',
		});
		// within a triple the IDENTITY orders: forward from beta.6, back from rc.1
		const within = { version: '7.0.0', channel: 'prerelease', release: '7.0.0-beta.7' };
		expect(
			(
				await m.requestImageUpdate(within, m.superuser, {
					...seams(channelDir()),
					running: '7.0.0-beta.6',
				})
			).ok,
		).toBe(true);
		expect(
			await m.requestImageUpdate(within, m.superuser, {
				...seams(channelDir()),
				running: '7.0.0-rc.1',
			}),
		).toEqual({ ok: false, reason: 'version_refused', walk: 'not_newer_release' });
	});

	test('a -dev image is never requested, on any installation: version_refused with the nightly sentence, nothing written', async () => {
		// Docker has no nightly images (VERSIONING_SPEC S3). The refusal is the same whatever
		// the installation runs, release or developer, and it writes no request.
		const m = await modules();
		const release = channelDir(10, '7.0.0');
		const onDev = channelDir(10, '7.0.0-dev');
		for (const dir of [release, onDev])
			for (const options of [
				{ version: '7.0.0', channel: 'dev' },
				{ version: '7.0.1', channel: 'dev' },
			]) {
				const result = await m.requestImageUpdate(options, m.superuser, seams(dir));
				expect(result).toMatchObject({ ok: false, reason: 'version_refused' });
				expect(result.ok === false && result.message).toContain('Docker has no nightly images');
			}
		expect(requestFiles(release)).toEqual([]);
		expect(requestFiles(onDev)).toEqual([]);
		// the release channel is unaffected on a release installation
		expect((await m.requestImageUpdate({ version: '7.0.1' }, m.superuser, seams(release))).ok).toBe(
			true,
		);
	});

	test('success writes exactly ONE request; a second ask is refused as pending', async () => {
		const m = await modules();
		const dir = channelDir();
		const result = await m.requestImageUpdate({ version: '7.0.1' }, m.superuser, seams(dir));
		if (!result.ok) throw new Error(`refused: ${result.reason}`);
		expect(requestFiles(dir)).toEqual(['request.json']);
		expect(result.request).toMatchObject({
			tag: '7.0.1',
			version: '7.0.1',
			channel: 'master',
			from_version: m.DEDALO_ENGINE_VERSION,
			requested_at: NOW.toISOString(),
			requested_by: -1,
			state: 'requested',
			claimed_at: null,
		});
		expect(m.isUuid4(result.request.id)).toBe(true);
		expect(await m.requestImageUpdate({ version: '7.0.1' }, m.superuser, seams(dir))).toEqual({
			ok: false,
			reason: 'request_pending',
		});
		// a developer target is no image (Docker has no nightlies): refused, nothing written
		const dev = await m.requestImageUpdate({ version: '7.0.0', channel: 'dev' }, m.superuser, {
			...seams(channelDir(10, '7.0.0-dev')),
			running: '7.0.0-dev',
		});
		expect(dev.ok).toBe(false);
		// an inflight request blocks a new one too
		const busy = channelDir();
		await m.requestImageUpdate({ version: '7.0.1' }, m.superuser, seams(busy));
		expect((await m.claimRequest(NOW, busy)).kind).toBe('claimed');
		expect(await m.requestImageUpdate({ version: '7.0.1' }, m.superuser, seams(busy))).toEqual({
			ok: false,
			reason: 'request_pending',
		});
	});

	test('cancel: removes an unclaimed request; refused once claimed, or when there is none', async () => {
		const m = await modules();
		const dir = channelDir();
		expect(m.cancelImageUpdateRequest(m.superuser, { dir })).toEqual({
			ok: false,
			reason: 'no_request',
		});
		await m.requestImageUpdate({ version: '7.0.1' }, m.superuser, seams(dir));
		expect(m.cancelImageUpdateRequest(m.superuser, { dir })).toEqual({ ok: true });
		expect(requestFiles(dir)).toEqual([]);
		await m.requestImageUpdate({ version: '7.0.1' }, m.superuser, seams(dir));
		await m.claimRequest(NOW, dir);
		expect(m.cancelImageUpdateRequest(m.superuser, { dir })).toEqual({
			ok: false,
			reason: 'request_claimed',
		});
		expect(requestFiles(dir)).toEqual(['inflight.json']);
		expect(() => m.cancelImageUpdateRequest({ userId: 42 } as never, { dir })).toThrow();
		// no maintenance-mode demand on a withdrawal
		m.setServerState({ maintenance_mode: false });
		const other = channelDir();
		m.setServerState({ maintenance_mode: true });
		await m.requestImageUpdate({ version: '7.0.1' }, m.superuser, seams(other));
		m.setServerState({ maintenance_mode: false });
		expect(m.cancelImageUpdateRequest(m.superuser, { dir: other })).toEqual({ ok: true });
		m.setServerState({ maintenance_mode: true });
	});

	test('the widget door maps a refusal to maintenance.action_refused with coordinates.reason', async () => {
		const m = await modules();
		// THIS checkout is tree_swap, so the first state gate refuses before
		// anything reads or writes the private dir
		const { widget } = await widgetModule();
		try {
			await widget.apiActions?.request_image_update?.({ version: '7.0.1' }, m.superuser);
			throw new Error('expected a refusal');
		} catch (error) {
			const typed = error as { code?: string; coordinates?: Record<string, unknown> };
			expect(typed.code).toBe('maintenance.action_refused');
			expect(typed.coordinates).toEqual({ reason: 'not_image_channel' });
		}
	});
});
