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
 *  - the panel's bounded wait as production binds it (OPS-1, I3), and the
 *     update_code JOB handing its stop signal to the update run and on to
 *     updateCode (OPS-1 review).
 *
 * The image-update request/cancel doors are registered by the widget (the apiActions
 * census in the first describe); their gates live in image_update_request_native.test.ts.
 */

import { afterAll, describe, expect, mock, test } from 'bun:test';
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
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
	test("a STOP of the widget's job aborts the signal the update run awaits on", async () => {
		// The job starts an UPDATE RUN (core/update/run/start.ts, Phase 2.6) and the
		// run's code phase hands the same signal to updateCode (run/production.ts
		// codePhase; code_update.test.ts drives the refusal of a stopped run before
		// the swap). This is the wiring half: the job the widget submits must pass
		// ITS signal, or no operator stop ever reaches the pipeline. The run is
		// intercepted — nothing is fetched or swapped.
		const realStart = await import('../../src/core/update/run/start.ts');
		const REAL_START = { ...realStart };
		const seen = Promise.withResolvers<AbortSignal | undefined>();
		const release = Promise.withResolvers<void>();
		mock.module('../../src/core/update/run/start.ts', () => ({
			...REAL_START,
			startCodeUpdateRun: async (
				_options: unknown,
				_principal: unknown,
				hooks: { signal?: AbortSignal },
			) => {
				seen.resolve(hooks.signal);
				await release.promise;
				return {
					state: 'restarting',
					journal: { run_id: 'r', state: 'BACKED_UP', note: null, phases: [] },
				};
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
			mock.module('../../src/core/update/run/start.ts', () => REAL_START);
		}
	});

	test('…and the run’s code phase hands that signal to updateCode', async () => {
		const realCodeUpdate = await import('../../src/core/update/code_update.ts');
		const REAL_CODE_UPDATE = { ...realCodeUpdate };
		let received: AbortSignal | undefined;
		mock.module('../../src/core/update/code_update.ts', () => ({
			...REAL_CODE_UPDATE,
			updateCode: async (
				_options: unknown,
				_principal: unknown,
				seams: { signal?: AbortSignal },
			) => {
				received = seams.signal;
				return { ok: true };
			},
		}));
		try {
			const { productionRunEffects } = await import('../../src/core/update/run/production.ts');
			const { SUPERUSER_ID } = await import('../../src/core/security/permissions.ts');
			const controller = new AbortController();
			const effects = productionRunEffects({
				principal: { userId: SUPERUSER_ID, isGlobalAdmin: true, isDeveloper: true },
				codeRequest: {},
				waiveBackup: true,
				signal: controller.signal,
			});
			const result = await effects.runners.code(
				{ release: '7.0.1', step: { kind: 'code' } },
				{} as never,
			);
			expect(result).toMatchObject({ outcome: 'ok', restarting: true });
			expect(received).toBe(controller.signal);
		} finally {
			mock.module('../../src/core/update/code_update.ts', () => REAL_CODE_UPDATE);
		}
	});
});
