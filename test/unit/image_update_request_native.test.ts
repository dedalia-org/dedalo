/**
 * The IMAGE-UPDATE REQUEST and its cancel (installer unification D3/D4,
 * 2026-10-09; core/update/image_update_request.ts; doors
 * `update_code.request_image_update` / `update_code.cancel_image_update_request`).
 *
 * Every refusal id, in the gate order, against a scratch channel dir; success
 * writes exactly ONE request; the walk verdict is the identity walk's
 * (version_walk.ts identityWalkRefusal — the data walk's on a release or -dev
 * target, a prerelease named by its identity); a claimed request cannot be
 * cancelled. The widget's own door is asked once, on this real checkout, for
 * the refusal → `coordinates.reason` mapping.
 *
 * Recovered 2026-10-30 from update_code_widget_native.test.ts (update audit
 * 2026-10-29, Phase 2 #4/#14), where the block had been dropped.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NOW = new Date('2026-10-09T12:00:00.000Z');
/** Every scratch channel dir this file made — swept after. */
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
/** The request-state files of a channel dir (the heartbeat is not one). */
const requestFiles = (dir: string) =>
	readdirSync(dir).filter((name) => name === 'request.json' || name === 'inflight.json');

describe('the image-update request (D3/D4): gates, one write, and the walk rule', () => {
	test('the preconditions throw their own typed errors first (superuser, then maintenance mode)', async () => {
		const m = await modules();
		const dir = channelDir();
		try {
			await m.requestImageUpdate({ version: '7.0.1' }, { userId: 42 } as never, seams(dir));
			throw new Error('expected a refusal');
		} catch (error) {
			expect((error as { code?: string }).code).toBe('perm.superuser_required');
		}
		m.setServerState({ maintenance_mode: false });
		try {
			await m.requestImageUpdate({ version: '7.0.1' }, m.superuser, seams(dir));
			throw new Error('expected a refusal');
		} catch (error) {
			expect((error as { code?: string }).code).toBe('maintenance.mode_required');
		}
		m.setServerState({ maintenance_mode: true });
		// floor: the dir holds the heartbeat, so the listing below read a real dir
		expect(readdirSync(dir)).toEqual(['host_updater.json']);
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
		expect(readdirSync(fresh)).toEqual(['host_updater.json']);
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
			expect(readdirSync(dir)).toEqual(['host_updater.json']);
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
		let asked = 0;
		for (const dir of [release, onDev])
			for (const options of [
				{ version: '7.0.0', channel: 'dev' },
				{ version: '7.0.1', channel: 'dev' },
			]) {
				const result = await m.requestImageUpdate(options, m.superuser, seams(dir));
				expect(result).toMatchObject({ ok: false, reason: 'version_refused' });
				expect(result.ok === false && result.message).toContain('Docker has no nightly images');
				asked++;
			}
		expect(asked).toBe(4);
		expect(readdirSync(release)).toEqual(['host_updater.json']);
		expect(requestFiles(release)).toEqual([]);
		expect(readdirSync(onDev)).toEqual(['host_updater.json']);
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
		// the floor of every empty requestFiles verdict in this file: the census sees a write
		expect(requestFiles(dir)).toHaveLength(1);
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
		expect(requestFiles(dir)).toEqual(['request.json']);
		// a developer target is no image (Docker has no nightlies): refused, nothing written
		const devDir = channelDir(10, '7.0.0-dev');
		const dev = await m.requestImageUpdate({ version: '7.0.0', channel: 'dev' }, m.superuser, {
			...seams(devDir),
			running: '7.0.0-dev',
		});
		expect(dev).toMatchObject({ ok: false, reason: 'version_refused' });
		expect(readdirSync(devDir)).toEqual(['host_updater.json']);
		// an inflight request blocks a new one too
		const busy = channelDir();
		expect((await m.requestImageUpdate({ version: '7.0.1' }, m.superuser, seams(busy))).ok).toBe(
			true,
		);
		expect((await m.claimRequest(NOW, busy)).kind).toBe('claimed');
		expect(requestFiles(busy)).toEqual(['inflight.json']);
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
		expect((await m.requestImageUpdate({ version: '7.0.1' }, m.superuser, seams(dir))).ok).toBe(
			true,
		);
		expect(requestFiles(dir)).toEqual(['request.json']);
		expect(m.cancelImageUpdateRequest(m.superuser, { dir })).toEqual({ ok: true });
		expect(readdirSync(dir)).toEqual(['host_updater.json']);
		expect(requestFiles(dir)).toEqual([]);
		expect((await m.requestImageUpdate({ version: '7.0.1' }, m.superuser, seams(dir))).ok).toBe(
			true,
		);
		expect((await m.claimRequest(NOW, dir)).kind).toBe('claimed');
		expect(m.cancelImageUpdateRequest(m.superuser, { dir })).toEqual({
			ok: false,
			reason: 'request_claimed',
		});
		expect(requestFiles(dir)).toEqual(['inflight.json']);
		try {
			m.cancelImageUpdateRequest({ userId: 42 } as never, { dir });
			throw new Error('expected a refusal');
		} catch (error) {
			expect((error as { code?: string }).code).toBe('perm.superuser_required');
		}
		expect(requestFiles(dir)).toEqual(['inflight.json']);
		// no maintenance-mode demand on a withdrawal
		const other = channelDir();
		expect((await m.requestImageUpdate({ version: '7.0.1' }, m.superuser, seams(other))).ok).toBe(
			true,
		);
		m.setServerState({ maintenance_mode: false });
		try {
			expect(m.cancelImageUpdateRequest(m.superuser, { dir: other })).toEqual({ ok: true });
		} finally {
			m.setServerState({ maintenance_mode: true });
		}
		expect(requestFiles(other)).toEqual([]);
	});

	test('the widget door maps a refusal to maintenance.action_refused with coordinates.reason', async () => {
		const m = await modules();
		// THIS checkout is tree_swap, so the first state gate refuses before
		// anything reads or writes the private dir
		const { widget } = await import('../../src/core/area_maintenance/widgets/update_code.ts');
		expect(typeof widget.apiActions?.request_image_update).toBe('function');
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
