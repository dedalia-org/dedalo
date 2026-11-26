/**
 * GET /dedalo/install/seed_build/<file> (src/core/install/seed_build_download.ts):
 * the maintenance panel's Download buttons. Exactly the three files a build
 * writes, of the NEWEST finished build only, to a caller who may use the
 * maintenance area now; anything else is `null` (the router's 404).
 *
 * Builds live in a scratch builds dir (the route's `buildsDir` seam) — never the
 * installation's `<private>/seed_builds`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	SEED_BUILD_URL_PREFIX,
	serveSeedBuildFile,
} from '../../src/core/install/seed_build_download.ts';
import { SUPERUSER_ID } from '../../src/core/security/permissions.ts';
import { createSession, SESSION_COOKIE } from '../../src/core/security/session_store.ts';
import {
	ACL_NON_ADMIN_USER_ID,
	installAclIdentityFixture,
	removeAclIdentityFixture,
} from '../helpers/acl_identity_fixture.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

registerSessionCleanup();

let buildsDir = '';
let rootCookie = '';
let readerCookie = '';

/** A finished build: its record + seed + manifest, each carrying the stamp so a leg can tell which one served. */
function writeBuild(stamp: string, finished = true): void {
	const dir = join(buildsDir, stamp);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'dedalo_install.pgsql.gz'), `seed ${stamp}`);
	writeFileSync(join(dir, 'dedalo_install.pgsql.gz.manifest.json'), `{"stamp":"${stamp}"}`);
	writeFileSync(join(dir, 'secret.txt'), 'never served');
	if (finished) writeFileSync(join(dir, 'build.json'), JSON.stringify({ built_at: stamp }));
}

const url = (name: string) => `${SEED_BUILD_URL_PREFIX}${name}`;

beforeAll(async () => {
	await installAclIdentityFixture();
	buildsDir = mkdtempSync(join(tmpdir(), 'seed_build_download_'));
	rootCookie = `${SESSION_COOKIE}=${createSession(SUPERUSER_ID, 'root', true)}`;
	readerCookie = `${SESSION_COOKIE}=${createSession(ACL_NON_ADMIN_USER_ID, 'zzacl_reader', false)}`;
});

afterAll(async () => {
	rmSync(buildsDir, { recursive: true, force: true });
	await removeAclIdentityFixture();
});

describe('seed build download route', () => {
	test('no build yet → null', async () => {
		expect(await serveSeedBuildFile(url('build.json'), rootCookie, buildsDir)).toBeNull();
	});

	test('serves the three build files of the NEWEST finished build, as attachments', async () => {
		writeBuild('2026-01-01T00-00-00-000Z');
		writeBuild('2026-02-01T00-00-00-000Z');
		writeBuild('2026-03-01T00-00-00-000Z', false); // unfinished: no build.json
		writeBuild('zz_not_a_build'); // sorts after every stamp, has a build.json: still not a build
		const seed = await serveSeedBuildFile(url('dedalo_install.pgsql.gz'), rootCookie, buildsDir);
		expect(seed?.status).toBe(200);
		expect(await seed?.text()).toBe('seed 2026-02-01T00-00-00-000Z');
		expect(seed?.headers.get('Content-Type')).toBe('application/gzip');
		expect(seed?.headers.get('Content-Disposition')).toBe(
			'attachment; filename="dedalo_install.pgsql.gz"',
		);
		expect(seed?.headers.get('Cache-Control')).toBe('no-store');
		const manifest = await serveSeedBuildFile(
			url('dedalo_install.pgsql.gz.manifest.json'),
			rootCookie,
			buildsDir,
		);
		expect(await manifest?.json()).toEqual({ stamp: '2026-02-01T00-00-00-000Z' });
		const record = await serveSeedBuildFile(url('build.json'), rootCookie, buildsDir);
		expect(await record?.json()).toEqual({ built_at: '2026-02-01T00-00-00-000Z' });
	});

	test('any other name, path or stamp → null', async () => {
		for (const name of [
			'secret.txt',
			'',
			'../build.json',
			'2026-01-01T00-00-00-000Z/build.json',
			'build.json/',
			'BUILD.JSON',
			'%2e%2e/build.json',
		]) {
			expect(await serveSeedBuildFile(url(name), rootCookie, buildsDir)).toBeNull();
		}
		expect(
			await serveSeedBuildFile('/dedalo/install/other/build.json', rootCookie, buildsDir),
		).toBeNull();
	});

	test('no session, a forged one, or a caller without the maintenance area → null', async () => {
		expect(await serveSeedBuildFile(url('build.json'), null, buildsDir)).toBeNull();
		expect(
			await serveSeedBuildFile(url('build.json'), `${SESSION_COOKIE}=${'f'.repeat(64)}`, buildsDir),
		).toBeNull();
		expect(await serveSeedBuildFile(url('build.json'), readerCookie, buildsDir)).toBeNull();
	});
});
