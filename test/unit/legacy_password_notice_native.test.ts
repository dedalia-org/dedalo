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
 * The legacy value is planted on the ACL identity fixture's reader (a scratch
 * dd128 record the fixture owns and removes) — never on an installed account.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { anonymousHealthView, buildHealthPayload } from '../../src/core/api/health_payload.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { countLegacyPasswordAccounts, login } from '../../src/core/security/auth.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import {
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
