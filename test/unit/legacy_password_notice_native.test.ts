/**
 * AN ACCOUNT STILL ON A v6 PASSWORD IS TOLD HOW TO FIX IT — and counted at boot (T2 D08-a).
 *
 * v6 stored passwords as reversible AES ciphertext; the v7 login accepts Argon2id
 * only, and the "upgrade on next login" rehash of the PHP engine is retired
 * (WC-2026-11-19-legacy-aes-lazy-rehash-retired). Such an account is refused —
 * and until 2026-11-19 the server log told the operator to "log into the PHP
 * server once", an engine that no longer exists. The fix is
 * `bun run dedalo:migrate-passwords`, and nothing said so at boot: the operator
 * learned of it from the first user who could not get in.
 *
 * Pinned: the refusal's log line names the command (and still says nothing on
 * the wire); the count reads the users section; the boot notice counts and
 * names the command; /health carries a notice, never red and never a number
 * (it answers anyone).
 *
 * And (T2 B1 review, S3-2 / S3-5 / S3-7): the notice FOLLOWS the condition —
 * the fix runs in another process, so /health re-takes the count at most once
 * per LEGACY_PASSWORD_RECOUNT_MS (never per call) and the notice goes, or comes,
 * without a restart; and the REAL server's boot is what counts: spawned on the
 * suite database with a legacy account planted, its stderr carries the boot
 * line and its /health the notice.
 *
 * The legacy value is planted on the ACL identity fixture's reader (a scratch
 * dd128 record the fixture owns and removes) — never on an installed account.
 */

import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { anonymousHealthView, buildHealthPayload } from '../../src/core/api/health_payload.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { countLegacyPasswordAccounts, login } from '../../src/core/security/auth.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import {
	currentLegacyPasswordAccounts,
	LEGACY_PASSWORD_RECOUNT_MS,
	legacyPasswordAccounts,
	refreshLegacyPasswordNotice,
	resetBootStateForTest,
} from '../../src/core/update/boot_state.ts';
import { createRequestContext, handleRequest } from '../../src/server.ts';
import {
	ACL_NON_ADMIN_USER_ID,
	installAclIdentityFixture,
	removeAclIdentityFixture,
} from '../helpers/acl_identity_fixture.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';
import { markProcessesDir } from '../helpers/test_media_root.ts';

registerSessionCleanup();

const COMMAND = 'bun run dedalo:migrate-passwords';
const USERNAME = 'zzacl_reader';
/** The v6 storage shape: base64 of base64 of AES blocks — not a hash, and not this test's secret. */
const LEGACY_VALUE = Buffer.from(Buffer.alloc(32, 7).toString('base64')).toString('base64');

async function setStoredPassword(value: string | null): Promise<void> {
	if (value === null) {
		await sql.unsafe(
			`UPDATE matrix_users SET string = string - 'dd133' WHERE section_tipo = 'dd128' AND section_id = $1`,
			[ACL_NON_ADMIN_USER_ID],
		);
		return;
	}
	const rows = (await sql.unsafe(
		`UPDATE matrix_users
		    SET string = COALESCE(string, '{}'::jsonb) || jsonb_build_object('dd133', $2::text::jsonb)
		  WHERE section_tipo = 'dd128' AND section_id = $1 RETURNING section_id`,
		[ACL_NON_ADMIN_USER_ID, JSON.stringify([{ id: 1, lang: 'lg-nolan', value }])],
	)) as unknown[];
	// FLOOR: the scratch account exists and took the value.
	expect(rows).toHaveLength(1);
}

async function captured(run: () => Promise<unknown>): Promise<string[]> {
	const lines: string[] = [];
	const [warn, error] = [console.warn, console.error];
	console.warn = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
	console.error = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
	try {
		await run();
	} finally {
		console.warn = warn;
		console.error = error;
	}
	return lines;
}

beforeAll(async () => {
	await assertTestDatabase('legacy_password_notice_native');
	await installAclIdentityFixture();
}, 60_000);

afterEach(() => {
	resetBootStateForTest();
	setSystemTime();
});

afterAll(async () => {
	await removeAclIdentityFixture();
});

describe('the refusal of a legacy password', () => {
	test('the server log names the account and the command — never the retired PHP engine; the wire stays ambiguous', async () => {
		await setStoredPassword(LEGACY_VALUE);
		let outcome: Awaited<ReturnType<typeof login>> | null = null;
		const lines = await captured(async () => {
			outcome = await login(USERNAME, 'whatever-the-user-typed', '203.0.113.7');
		});
		const result = outcome as unknown as { ok: boolean; message: string };
		expect(result.ok).toBe(false);
		const line = lines.find((entry) => entry.includes(USERNAME)) ?? '';
		expect(line).toContain(COMMAND);
		expect(lines.join('\n')).not.toMatch(/PHP/);
		// The wire says what it says for a wrong password: nothing about the account.
		const wrong = await login('zz_no_such_account_7731', 'x', '203.0.113.8');
		expect(result.message).toBe(wrong.message);
		expect(result.message).not.toContain('migrate');
	});
});

describe('the count', () => {
	test('one more account on a legacy value is one more; an Argon2id hash or no password is none', async () => {
		await setStoredPassword(null);
		const baseline = await countLegacyPasswordAccounts();
		await setStoredPassword(LEGACY_VALUE);
		expect(await countLegacyPasswordAccounts()).toBe(baseline + 1);
		await setStoredPassword(await Bun.password.hash('Conforming-Passw0rd-2017!', 'argon2id'));
		expect(await countLegacyPasswordAccounts()).toBe(baseline);
		await setStoredPassword('');
		expect(await countLegacyPasswordAccounts()).toBe(baseline);
	});
});

describe('the boot notice', () => {
	test('N accounts → one warning with the number and the command; recorded for /health', async () => {
		const lines = await captured(() => refreshLegacyPasswordNotice(async () => 3));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain('3');
		expect(lines[0]).toContain(COMMAND);
		expect(lines[0]).not.toMatch(/PHP/);
		expect(legacyPasswordAccounts()).toBe(3);
	});

	test('none → silence; an unreadable count → said, never a number invented', async () => {
		expect(await captured(() => refreshLegacyPasswordNotice(async () => 0))).toEqual([]);
		expect(legacyPasswordAccounts()).toBe(0);
		const lines = await captured(() =>
			refreshLegacyPasswordNotice(async () => {
				throw new Error('db down');
			}),
		);
		expect(lines).toHaveLength(1);
		expect(legacyPasswordAccounts()).toBeNull();
	});

	test('the REAL reader, with a legacy account planted: the boot line counts it', async () => {
		await setStoredPassword(LEGACY_VALUE);
		const lines = await captured(() => refreshLegacyPasswordNotice(countLegacyPasswordAccounts));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(COMMAND);
		expect(legacyPasswordAccounts()).toBeGreaterThanOrEqual(1);
	});
});

describe('/health', () => {
	const BASE = { dbOk: true, entity: 'e', installDigest: null, requestId: 'r' };

	test('a notice, not red, and never the number (the probe answers anyone)', () => {
		const payload = buildHealthPayload({ ...BASE, legacyPasswordAccounts: 3 });
		expect(payload.result).toBe('ok');
		const wire = anonymousHealthView(payload);
		expect(wire.notices).toEqual(['legacy_password_accounts']);
		expect(JSON.stringify(wire)).not.toContain('3');
	});

	test('none, or not counted → no notices key', () => {
		for (const count of [0, null, undefined]) {
			const wire = anonymousHealthView(
				buildHealthPayload({ ...BASE, legacyPasswordAccounts: count }),
			);
			expect('notices' in wire).toBe(false);
		}
	});

	test('through the real route: the recorded count becomes the notice, status 200', async () => {
		await captured(() => refreshLegacyPasswordNotice(async () => 2));
		const response = await handleRequest(
			new Request('http://localhost/health'),
			createRequestContext(),
		);
		const body = (await response.json()) as Record<string, unknown>;
		expect(response.status).toBe(200);
		expect(body.notices).toEqual(['legacy_password_accounts']);
		resetBootStateForTest();
		const clean = await handleRequest(
			new Request('http://localhost/health'),
			createRequestContext(),
		);
		expect('notices' in ((await clean.json()) as Record<string, unknown>)).toBe(false);
	});
});

async function healthNotices(): Promise<unknown> {
	const response = await handleRequest(
		new Request('http://localhost/health'),
		createRequestContext(),
	);
	expect(response.status).toBe(200);
	return ((await response.json()) as Record<string, unknown>).notices;
}

describe('/health follows the condition without a restart', () => {
	/** The real reader, counted: how many queries the probe cost. */
	function countedReader(): { count: () => Promise<number>; calls: () => number } {
		let calls = 0;
		return {
			count: async () => {
				calls += 1;
				return countLegacyPasswordAccounts();
			},
			calls: () => calls,
		};
	}

	test('migrated in another process → the notice is gone after the window; put back → it returns; never one query per call', async () => {
		// FLOOR: the suite database holds no legacy account of its own, so the
		// planted one is the whole condition.
		await setStoredPassword(null);
		expect(await countLegacyPasswordAccounts()).toBe(0);

		await setStoredPassword(LEGACY_VALUE);
		const reader = countedReader();
		const bootAt = Date.now();
		// the boot's step, exactly as server.ts takes it
		await captured(() => refreshLegacyPasswordNotice(reader.count));
		expect(reader.calls()).toBe(1);
		expect(await healthNotices()).toEqual(['legacy_password_accounts']);

		// what `bun run dedalo:migrate-passwords` leaves: an Argon2id hash
		await setStoredPassword(await Bun.password.hash('Conforming-Passw0rd-2017!', 'argon2id'));

		// inside the window the probe costs NO query, however often it is asked
		for (let call = 0; call < 25; call += 1) await healthNotices();
		expect(reader.calls()).toBe(1);

		// past the window: ONE recount, shared by concurrent callers; the notice is gone
		setSystemTime(new Date(bootAt + LEGACY_PASSWORD_RECOUNT_MS + 1_000));
		const lines = await captured(async () => {
			const answers = await Promise.all(Array.from({ length: 20 }, () => healthNotices()));
			expect(answers.every((notices) => notices === undefined)).toBe(true);
		});
		expect(reader.calls()).toBe(2);
		expect(legacyPasswordAccounts()).toBe(0);
		// the change is said once, with no command left to run
		expect(lines.filter((line) => line.includes('LEGACY PASSWORDS'))).toHaveLength(1);
		for (let call = 0; call < 25; call += 1) await healthNotices();
		expect(reader.calls()).toBe(2);

		// the reverse: an account put back on a legacy value after boot is noticed
		await setStoredPassword(LEGACY_VALUE);
		setSystemTime(new Date(bootAt + 2 * LEGACY_PASSWORD_RECOUNT_MS + 2_000));
		const back = await captured(async () => {
			expect(await healthNotices()).toEqual(['legacy_password_accounts']);
		});
		expect(reader.calls()).toBe(3);
		expect(back.join('\n')).toContain(COMMAND);
	});

	test('a recount that fails is said and served as not counted; a process whose boot never counted asks nothing', async () => {
		let fail = false;
		const lines = await captured(async () => {
			await refreshLegacyPasswordNotice(async () => {
				if (fail) throw new Error('db down');
				return 4;
			}, 1_000);
			fail = true;
			expect(await currentLegacyPasswordAccounts(1_000 + LEGACY_PASSWORD_RECOUNT_MS)).toBeNull();
		});
		expect(lines.some((line) => line.includes('could not be counted'))).toBe(true);
		resetBootStateForTest();
		expect(await currentLegacyPasswordAccounts(Number.MAX_SAFE_INTEGER)).toBeNull();
	});

	test('the window is a minute or less (the doc says "within a minute") and not zero', () => {
		expect(LEGACY_PASSWORD_RECOUNT_MS).toBeGreaterThanOrEqual(10_000);
		expect(LEGACY_PASSWORD_RECOUNT_MS).toBeLessThanOrEqual(60_000);
	});
});

describe('the REAL server boot counts (the wiring in startServer)', () => {
	const ROOT = resolve(import.meta.dir, '../..');
	// Short: macOS caps a unix socket path at 104 bytes.
	const scratch = mkdtempSync(join(tmpdir(), 'zzlp_'));
	afterAll(() => rmSync(scratch, { recursive: true, force: true }));

	test('spawned on the suite database with a legacy account planted: the boot line on stderr, the notice on /health', async () => {
		await setStoredPassword(LEGACY_VALUE);
		const socket = join(scratch, 's.sock');
		const server = Bun.spawn([process.execPath, 'run', 'src/server.ts'], {
			cwd: ROOT,
			env: {
				...(process.env as Record<string, string>),
				SERVER_UNIX_SOCKET: socket,
				SERVER_TCP_PORT: '',
				SERVER_TCP_TLS_CERT_FILE: '',
				SERVER_TCP_TLS_KEY_FILE: '',
				DEDALO_DIFFUSION_SCHEDULER_ENABLED: 'false',
				DEDALO_MEDIA_PROCESSES_DIR: markProcessesDir(join(scratch, 'processes')),
			},
			stdout: 'ignore',
			stderr: 'pipe',
		});
		const stderr = new Response(server.stderr as ReadableStream).text();
		let health: { status: number; body: Record<string, unknown> } | null = null;
		try {
			const deadline = Date.now() + 60_000;
			while (Date.now() < deadline && health === null) {
				if (server.exitCode !== null) break;
				try {
					const response = await fetch('http://localhost/health', { unix: socket });
					health = {
						status: response.status,
						body: (await response.json()) as Record<string, unknown>,
					};
				} catch {
					await Bun.sleep(100);
				}
			}
		} finally {
			server.kill('SIGTERM');
			await server.exited;
		}
		const log = await stderr;
		expect(
			health,
			`the server never answered /health; stderr:\n${log.slice(-2000)}`,
		).not.toBeNull();
		expect(health?.status).toBe(200);
		expect(health?.body.notices).toEqual(['legacy_password_accounts']);
		const line = log.split('\n').find((entry) => entry.includes('[boot] LEGACY PASSWORDS')) ?? '';
		expect(line).toContain('1 account(s)');
		expect(line).toContain(COMMAND);
	}, 90_000);
});
