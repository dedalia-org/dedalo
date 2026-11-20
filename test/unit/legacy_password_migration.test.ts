/**
 * v6 → v7 PASSWORD RECOVERY: a legacy AES password can be re-hashed to Argon2id
 * without the user choosing a new one.
 *
 * The interop claim being pinned: our TS decryption reproduces PHP's
 * `dedalo_encrypt_openssl` exactly — double base64, AES-256-CBC, key
 * `md5(md5(DEDALO_INFORMATION))`, IV = first 16 hex chars of
 * `sha256(DEDALO_INFO_KEY)`, plaintext `serialize()`d. The fixture below is a
 * blob produced by REAL PHP (`php -r`), not by our own encryptor, so this test
 * fails if we ever drift from PHP's scheme.
 *
 * Everything here uses DUMMY key material and DUMMY passwords on a SCRATCH user.
 * No real credential is read or decrypted.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE v6 PASSWORDS ARE CONVERTED FROM THE SERVER — the `legacy_passwords`
 * maintenance widget (owner ruling 2026-11-19, T2 B1 follow-up D08-a;
 * WC-2026-11-19-maintenance-legacy-passwords-widget).
 *
 * An account still on a Dédalo v6 password value (reversible AES, not a hash)
 * cannot log in, and the only fix was a command line on the server. The widget
 * shows how many accounts are affected — to a maintenance admin, never to the
 * anonymous /health — and runs THE SAME DOOR as `bun run dedalo:migrate-passwords`
 * (src/core/security/legacy_password_migration.ts).
 *
 * Pinned, through the real API door (dispatchRqo):
 *  - a non-admin is refused on the panel AND on the run, and nothing is written;
 *  - the admin's panel counts the planted accounts, and /health's fact follows;
 *  - a dry run converts nothing; a run converts the accounts the typed keys
 *    decrypt — each then verifies its ORIGINAL password — and reports the ones
 *    they do not, by name, leaving their value alone;
 *  - the report's exact shape; batches (`limit` / `next_after`) add up to it;
 *  - NO credential on the wire or in the log: no stored value (old or new), no
 *    plaintext, no key material;
 *  - a password changed while the run was hashing is skipped, never overwritten;
 *  - a malformed key option is refused without echoing it;
 *  - the command line is the same door (it holds no statement of its own);
 *  - EVERY EXECUTE RUN IS IN THE ACTIVITY LOG (owner ruling 2026-11-20) — from
 *    the panel and from the command line: who ran it, which accounts (user
 *    section_ids) it converted, the counts — and no credential value, hash,
 *    plaintext or typed key in the row. A dry run converts nothing and writes
 *    no row.
 *
 * Scratch for these legs: four more dd128 records at ids this file owns,
 * planted before each test and swept after — never an installed account.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../src/config/config.ts';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import { boundActivityData } from '../../src/core/api/handlers/activity_log.ts';
import { widget } from '../../src/core/area_maintenance/widgets/legacy_passwords.ts';
import { sql } from '../../src/core/db/postgres.ts';
import {
	decryptLegacyPassword,
	encryptLegacyPasswordForTest,
	type LegacyKeyMaterial,
	rehashLegacyPassword,
} from '../../src/core/security/legacy_password.ts';
import {
	type ConversionActor,
	conversionActivityEntries,
	LEGACY_CONVERSION_ACTION,
	LEGACY_CONVERSION_IDS_PER_ENTRY,
	legacyPasswordCensus,
	migrateLegacyPasswords,
} from '../../src/core/security/legacy_password_migration.ts';
import { isArgon2Hash } from '../../src/core/security/password_hash.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import {
	legacyPasswordAccounts,
	refreshLegacyPasswordNotice,
	resetBootStateForTest,
} from '../../src/core/update/boot_state.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

const USERS_SECTION = config.usersSectionTipo;
const PASSWORD_TIPO = 'dd133';
const SCRATCH_ID = 999_000_778;

/** Produced by REAL PHP with information='TEST_INFORMATION', infoKey='test_entity': */
const PHP_BLOB = 'ZHdKVDU5Y0FsOTZYTGZudkw4Y1ZVQTUxTHNMY0tna2JST2hORHRFMTRCUT0=';
const PHP_PLAINTEXT = 'dummy-password-123';
const PHP_MATERIAL: LegacyKeyMaterial = {
	information: 'TEST_INFORMATION',
	infoKey: 'test_entity',
};

beforeAll(async () => {
	await sql`DELETE FROM matrix_users WHERE section_id = ${SCRATCH_ID}`;
});
afterAll(async () => {
	await sql`DELETE FROM matrix_users WHERE section_id = ${SCRATCH_ID}`;
});

describe('interop with PHP dedalo_encrypt_openssl', () => {
	test('a blob produced by REAL PHP decrypts here', () => {
		expect(decryptLegacyPassword(PHP_BLOB, PHP_MATERIAL)).toBe(PHP_PLAINTEXT);
	});

	test('the WRONG key material does not decrypt (no false positives)', () => {
		expect(decryptLegacyPassword(PHP_BLOB, { information: 'WRONG', infoKey: 'test_entity' })).toBe(
			null,
		);
		expect(
			decryptLegacyPassword(PHP_BLOB, { information: 'TEST_INFORMATION', infoKey: 'wrong' }),
		).toBe(null);
	});

	test('non-v6 input is refused rather than mangled', () => {
		expect(decryptLegacyPassword('not-base64-at-all!!', PHP_MATERIAL)).toBe(null);
		expect(decryptLegacyPassword('', PHP_MATERIAL)).toBe(null);
	});

	test('unicode and long passwords survive the round-trip (byte-length check)', () => {
		const material: LegacyKeyMaterial = { information: 'Dédalo install version', infoKey: 'museu' };
		for (const pw of ['contrasenya-ñ-€', 'a'.repeat(200), 'p@ss word #1']) {
			const blob = encryptLegacyPasswordForTest(pw, material);
			expect(decryptLegacyPassword(blob, material)).toBe(pw);
		}
	});
});

describe('re-hash: the user keeps their password', () => {
	test('a legacy blob becomes an Argon2id hash that verifies the ORIGINAL password', async () => {
		const hash = (await rehashLegacyPassword(PHP_BLOB, PHP_MATERIAL)) as string;
		expect(isArgon2Hash(hash)).toBe(true);
		// The whole point: the user logs in with the password they already had.
		expect(await Bun.password.verify(PHP_PLAINTEXT, hash)).toBe(true);
		expect(await Bun.password.verify('some-other-password', hash)).toBe(false);
	});

	test('end to end on a SCRATCH user: legacy row → Argon2id row, login would now succeed', async () => {
		const material: LegacyKeyMaterial = { information: 'Dédalo install version', infoKey: 'museu' };
		const plaintext = 'scratch-user-pw';
		const legacy = encryptLegacyPasswordForTest(plaintext, material);

		// Seed the scratch user exactly as a v6 install would have left them.
		await sql`
			INSERT INTO matrix_users (section_id, section_tipo, "string")
			VALUES (
				${SCRATCH_ID}, ${USERS_SECTION},
				jsonb_build_object(${PASSWORD_TIPO}::text,
					jsonb_build_array(jsonb_build_object('id', 1, 'value', ${legacy}::text, 'lang', 'lg-nolan')))
			)
		`;

		const before = (await sql`
			SELECT "string"->${PASSWORD_TIPO}->0->>'value' AS v FROM matrix_users WHERE section_id = ${SCRATCH_ID}
		`) as { v: string }[];
		expect(isArgon2Hash(before[0]?.v)).toBe(false); // locked out of v7 today

		// What the migration does.
		const hash = (await rehashLegacyPassword(before[0]?.v as string, material)) as string;
		await sql`
			UPDATE matrix_users
			   SET "string" = jsonb_set("string", ${`{${PASSWORD_TIPO}}`}::text[],
			         jsonb_build_array(jsonb_build_object('id', 1, 'value', ${hash}::text, 'lang', 'lg-nolan')))
			 WHERE section_id = ${SCRATCH_ID}
		`;

		const after = (await sql`
			SELECT "string"->${PASSWORD_TIPO}->0->>'value' AS v FROM matrix_users WHERE section_id = ${SCRATCH_ID}
		`) as { v: string }[];

		expect(isArgon2Hash(after[0]?.v)).toBe(true);
		// The stored value is a hash of the ORIGINAL password — auth.ts would accept it.
		expect(await Bun.password.verify(plaintext, after[0]?.v as string)).toBe(true);
		// And the plaintext is nowhere in the row.
		expect(after[0]?.v).not.toContain(plaintext);
	});
});

// ── the conversion from the server (widget + door) ────────────────────────────

registerSessionCleanup();

/** Dummy v6 key material — not this installation's, not anyone's. */
const MATERIAL: LegacyKeyMaterial = {
	information: 'ZZ_WIDGET_TEST_INFORMATION_4471',
	infoKey: 'zz_widget_test_entity_4471',
};
/** Another install's keys: what "the admin typed the wrong ones" looks like. */
const FOREIGN: LegacyKeyMaterial = {
	information: 'ZZ_FOREIGN_INFORMATION_9920',
	infoKey: 'zz_foreign_entity_9920',
};

interface Scratch {
	id: number;
	username: string;
	plaintext: string;
	material: LegacyKeyMaterial;
}
/** Above every installed account, so `after: SCRATCH[0].id - 1` is "the scratch accounts only". */
const SCRATCH: readonly Scratch[] = [
	{ id: 999_000_781, username: 'zz_legacy_pw_a', plaintext: 'dummy-A-pw-1!', material: MATERIAL },
	{ id: 999_000_782, username: 'zz_legacy_pw_b', plaintext: 'dummy-B-pw-ñ€', material: MATERIAL },
	{ id: 999_000_783, username: 'zz_legacy_pw_c', plaintext: 'dummy-C-pw-3#', material: FOREIGN },
	{ id: 999_000_784, username: 'zz_legacy_pw_d', plaintext: 'dummy-D-pw-4$', material: MATERIAL },
];
const SCRATCH_IDS = SCRATCH.map((account) => account.id);
const AFTER = (SCRATCH[0] as Scratch).id - 1;
const legacyValue = (account: Scratch) =>
	encryptLegacyPasswordForTest(account.plaintext, account.material);

async function sweep(): Promise<void> {
	await sql.unsafe(
		`DELETE FROM matrix_users WHERE section_tipo = 'dd128' AND section_id = ANY($1::bigint[])`,
		[SCRATCH_IDS],
	);
}

async function plant(): Promise<void> {
	await sweep();
	for (const account of SCRATCH) {
		await sql.unsafe(
			`INSERT INTO matrix_users (section_id, section_tipo, string) VALUES ($1, 'dd128', $2::text::jsonb)`,
			[
				account.id,
				JSON.stringify({
					dd132: [{ id: 1, lang: 'lg-nolan', value: account.username }],
					dd133: [{ id: 1, lang: 'lg-nolan', value: legacyValue(account) }],
				}),
			],
		);
	}
}

async function storedPasswords(): Promise<Map<number, string>> {
	const rows = (await sql.unsafe(
		`SELECT section_id, string->'dd133'->0->>'value' AS v FROM matrix_users
		  WHERE section_tipo = 'dd128' AND section_id = ANY($1::bigint[])`,
		[SCRATCH_IDS],
	)) as { section_id: unknown; v: string }[];
	return new Map(rows.map((row) => [Number(row.section_id), row.v]));
}

/** The same dispatchRqo door the browser uses — root, or a logged-in non-admin. */
async function call(rqo: Record<string, unknown>, admin = true): Promise<Record<string, unknown>> {
	const token = admin ? createSession(-1, 'root', true) : createSession(999999, 'nobody', false);
	const session = getSession(token);
	const principal = await resolvePrincipal(admin ? -1 : 999999);
	const result = await dispatchRqo(
		structuredClone(rqo) as never,
		{
			requestId: 'legacy_passwords_widget_test',
			clientIp: '127.0.0.1',
			session,
			csrfCandidate: session?.csrfToken ?? null,
			principal,
		} as never,
	);
	return result.body;
}

const PANEL_RQO = {
	action: 'get_widget_value',
	dd_api: 'dd_area_maintenance_api',
	prevent_lock: true,
	source: { typo: 'source', model: 'legacy_passwords' },
};
const migrateRqo = (options: Record<string, unknown>) => ({
	action: 'widget_request',
	dd_api: 'dd_area_maintenance_api',
	prevent_lock: true,
	source: { typo: 'source', model: 'legacy_passwords', action: 'migrate' },
	options,
});
const KEYS = { information: MATERIAL.information, info_key: MATERIAL.infoKey };

/** Everything the run printed, whatever the stream. */
async function captured(run: () => Promise<unknown>): Promise<string> {
	const lines: string[] = [];
	const original = {
		log: console.log,
		warn: console.warn,
		error: console.error,
		info: console.info,
	};
	const sink = (...args: unknown[]) =>
		void lines.push(
			args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '),
		);
	Object.assign(console, { log: sink, warn: sink, error: sink, info: sink });
	try {
		await run();
	} finally {
		Object.assign(console, original);
	}
	return lines.join('\n');
}

/** The actor a direct door call names in these legs (the panel/CLI legs name their own). */
const DOOR_ACTOR: ConversionActor = { userId: -1, host: 'zz_door_test', via: 'panel' };

interface ConversionRow {
	section_id: number;
	who: number;
	what: number;
	where: string;
	host: string;
	data: Record<string, unknown>;
	/** The whole stored row, serialized — what a secret would have to be absent from. */
	raw: string;
}

/** The highest activity id there is: rows above it are the ones a leg wrote. */
async function activityHighWater(): Promise<number> {
	const rows = (await sql.unsafe(
		`SELECT COALESCE(MAX(section_id), 0) AS id FROM matrix_activity WHERE section_tipo = 'dd542'`,
	)) as { id: unknown }[];
	return Number(rows[0]?.id);
}

/** The conversion rows written above `base`, oldest first. */
async function conversionRows(base: number): Promise<ConversionRow[]> {
	const rows = (await sql.unsafe(
		`SELECT section_id, relation, string, misc, row_to_json(matrix_activity)::text AS raw
		   FROM matrix_activity
		  WHERE section_tipo = 'dd542' AND section_id > $1
		    AND misc->'dd551'->0->'value'->>'action' = $2
		  ORDER BY section_id`,
		[base, LEGACY_CONVERSION_ACTION],
	)) as {
		section_id: unknown;
		relation: Record<string, { section_id: number }[]>;
		string: Record<string, { value: string }[]>;
		misc: Record<string, { value: Record<string, unknown> }[]>;
		raw: string;
	}[];
	return rows.map((row) => ({
		section_id: Number(row.section_id),
		who: Number(row.relation.dd543?.[0]?.section_id),
		what: Number(row.relation.dd545?.[0]?.section_id),
		where: String(row.string.dd546?.[0]?.value),
		host: String(row.string.dd544?.[0]?.value),
		data: row.misc.dd551?.[0]?.value as Record<string, unknown>,
		raw: row.raw,
	}));
}

async function sweepConversionRows(base: number): Promise<void> {
	await sql.unsafe(
		`DELETE FROM matrix_activity
		  WHERE section_tipo = 'dd542' AND section_id > $1
		    AND misc->'dd551'->0->'value'->>'action' = $2`,
		[base, LEGACY_CONVERSION_ACTION],
	);
}

describe('the conversion from the server — the legacy_passwords widget and its door', () => {
	/** Activity ids above this were written by this file (the rows it sweeps). */
	let fileBase = 0;
	/** …and above this, by the running test. */
	let base = 0;
	beforeAll(async () => {
		await assertTestDatabase('legacy_password_migration');
		fileBase = await activityHighWater();
	}, 60_000);
	beforeEach(async () => {
		await plant();
		base = await activityHighWater();
	});
	afterEach(async () => {
		resetBootStateForTest();
		await sweepConversionRows(fileBase);
	});
	afterAll(async () => {
		await sweep();
		// FLOOR of the sweep: no scratch account outlives the file…
		expect((await storedPasswords()).size).toBe(0);
		// …and no conversion row either.
		expect(await conversionRows(fileBase)).toEqual([]);
	});

	describe('who may use it', () => {
		test('a logged-in non-admin is refused on the panel and on the run — and nothing is written', async () => {
			const before = await storedPasswords();
			const panel = await call(PANEL_RQO, false);
			expect(panel.ok).toBe(false);
			expect((panel.error as { code: string }).code).toBe('perm.denied');
			expect(JSON.stringify(panel)).not.toMatch(/"legacy"|"accounts"/);
			const run = await call(migrateRqo({ ...KEYS, execute: true, after: AFTER }), false);
			expect(run.ok).toBe(false);
			expect((run.error as { code: string }).code).toBe('perm.denied');
			expect(await storedPasswords()).toEqual(before);
		});

		test('only `migrate` is a method: the panel value is not reachable as an action', async () => {
			expect(Object.keys(widget.apiActions ?? {})).toEqual(['migrate']);
			const refused = await call({
				...migrateRqo({}),
				source: { typo: 'source', model: 'legacy_passwords', action: 'get_value' },
			});
			expect((refused.error as { code: string }).code).toBe('tool.method_not_allowed');
		});
	});

	describe('the panel', () => {
		test('the admin sees the count: the planted accounts are in it, and it moves with them', async () => {
			const withPlanted = await call(PANEL_RQO);
			expect(withPlanted.ok).toBe(true);
			const data = withPlanted.data as Record<string, unknown>;
			expect(Object.keys(data).sort()).toEqual([
				'accounts',
				'argon2',
				'batch',
				'command',
				'default_info_key',
				'legacy',
			]);
			expect(data.command).toBe('bun run dedalo:migrate-passwords');
			expect(data.accounts).toBe((data.argon2 as number) + (data.legacy as number));
			await sweep();
			const without = (await call(PANEL_RQO)).data as Record<string, number>;
			expect((data.legacy as number) - (without.legacy as number)).toBe(SCRATCH.length);
			expect((data.accounts as number) - (without.accounts as number)).toBe(SCRATCH.length);
			expect(data.argon2).toBe(without.argon2 as number);
		});

		test('opening the panel hands /health the count it just took (no 60 s wait)', async () => {
			// The boot counted before the accounts existed…
			await refreshLegacyPasswordNotice(async () => 0);
			expect(legacyPasswordAccounts()).toBe(0);
			const data = (await call(PANEL_RQO)).data as Record<string, number>;
			// …and the panel's own read is now what /health answers from.
			expect(legacyPasswordAccounts()).toBe(data.legacy as number);
			expect(legacyPasswordAccounts()).toBeGreaterThanOrEqual(SCRATCH.length);
		});
	});

	describe('the run', () => {
		test('dry by default: it says what WOULD convert and writes nothing', async () => {
			const before = await storedPasswords();
			const body = await call(migrateRqo({ ...KEYS, after: AFTER }));
			expect(body.ok).toBe(true);
			const report = body.data as Record<string, unknown>;
			expect(report.execute).toBe(false);
			expect(report.examined).toBe(4);
			expect(report.recoverable).toBe(3);
			expect(report.failed).toBe(1);
			expect(report.converted).toBe(0);
			expect(report.skipped).toBe(0);
			expect(await storedPasswords()).toEqual(before);
			// `execute` is a boolean true, nothing looser.
			for (const loose of ['true', 1, 'yes']) {
				const again = (await call(migrateRqo({ ...KEYS, execute: loose, after: AFTER })))
					.data as Record<string, unknown>;
				expect(again.execute).toBe(false);
			}
			expect(await storedPasswords()).toEqual(before);
		});

		test('execute: the accounts the keys decrypt become Argon2id of their ORIGINAL password; the other is reported and left alone', async () => {
			const before = await storedPasswords();
			const censusBefore = await legacyPasswordCensus();
			await refreshLegacyPasswordNotice(async () => censusBefore.legacy);

			const body = await call(migrateRqo({ ...KEYS, execute: true, after: AFTER }));
			expect(body.ok).toBe(true);
			const report = body.data as Record<string, unknown>;
			// THE REPORT'S SHAPE — exactly these keys.
			expect(Object.keys(report).sort()).toEqual([
				'accounts',
				'argon2',
				'converted',
				'examined',
				'execute',
				'failed',
				'failed_accounts',
				'legacy',
				'next_after',
				'recoverable',
				'remaining',
				'skipped',
			]);
			expect(report).toMatchObject({
				execute: true,
				accounts: censusBefore.accounts,
				argon2: censusBefore.argon2,
				legacy: censusBefore.legacy,
				examined: 4,
				recoverable: 3,
				converted: 3,
				failed: 1,
				skipped: 0,
				remaining: censusBefore.legacy - 3,
				next_after: null,
				failed_accounts: [{ section_id: 999_000_783, username: 'zz_legacy_pw_c' }],
			});

			const after = await storedPasswords();
			for (const account of SCRATCH) {
				const stored = after.get(account.id) as string;
				if (account.material === FOREIGN) {
					// not decryptable with the typed keys: untouched, still legacy
					expect(stored).toBe(before.get(account.id) as string);
					continue;
				}
				expect(isArgon2Hash(stored), account.username).toBe(true);
				expect(await Bun.password.verify(account.plaintext, stored), account.username).toBe(true);
				expect(await Bun.password.verify('not-the-password', stored)).toBe(false);
			}
			// The census agrees with the report, and /health's fact followed the run.
			expect((await legacyPasswordCensus()).legacy).toBe(report.remaining as number);
			expect(legacyPasswordAccounts()).toBe(report.remaining as number);
		});

		test('the stored value keeps its shape: one lg-nolan item, the username untouched', async () => {
			await call(migrateRqo({ ...KEYS, execute: true, after: AFTER }));
			const rows = (await sql.unsafe(
				`SELECT string FROM matrix_users WHERE section_tipo = 'dd128' AND section_id = $1`,
				[999_000_781],
			)) as { string: Record<string, { id: number; lang: string; value: string }[]> }[];
			const record = rows[0]?.string as Record<
				string,
				{ id: number; lang: string; value: string }[]
			>;
			expect(Object.keys(record).sort()).toEqual(['dd132', 'dd133']);
			expect(record.dd132).toEqual([{ id: 1, lang: 'lg-nolan', value: 'zz_legacy_pw_a' }]);
			expect(record.dd133).toHaveLength(1);
			expect(record.dd133?.[0]).toMatchObject({ id: 1, lang: 'lg-nolan' });
		});

		test('the wrong keys convert nobody and write nothing', async () => {
			const before = await storedPasswords();
			const report = (
				await call(
					migrateRqo({
						information: 'ZZ_NOBODYS_INFORMATION',
						info_key: 'zz_nobodys_entity',
						execute: true,
						after: AFTER,
					}),
				)
			).data as Record<string, unknown>;
			expect(report).toMatchObject({ examined: 4, recoverable: 0, converted: 0, failed: 4 });
			expect(await storedPasswords()).toEqual(before);
		});

		test('in batches: `limit` and `next_after` walk the same accounts to the same totals', async () => {
			const totals = { examined: 0, converted: 0, failed: 0 };
			const cursors: (number | null)[] = [];
			let after: number | null = AFTER;
			for (let guard = 0; after !== null && guard < 10; guard++) {
				const report = (await call(migrateRqo({ ...KEYS, execute: true, after, limit: 1 })))
					.data as Record<string, number | null>;
				expect(report.examined).toBe(1);
				totals.examined += report.examined as number;
				totals.converted += report.converted as number;
				totals.failed += report.failed as number;
				after = report.next_after ?? null;
				cursors.push(after);
			}
			// A failed account is passed, not retried for ever: the cursor moves on.
			expect(cursors).toEqual([999_000_781, 999_000_782, 999_000_783, null]);
			expect(totals).toEqual({ examined: 4, converted: 3, failed: 1 });
		});

		test('a request never examines more than the batch, whatever `limit` asks', async () => {
			const batch = ((await call(PANEL_RQO)).data as Record<string, number>).batch as number;
			expect(batch).toBeGreaterThanOrEqual(SCRATCH.length);
			const report = (await call(migrateRqo({ ...KEYS, after: AFTER, limit: 10_000 })))
				.data as Record<string, number>;
			expect(report.examined).toBeLessThanOrEqual(batch);
		});
	});

	describe('no credential leaves the server', () => {
		test('neither the wire nor the log carries a stored value, a plaintext or the typed keys', async () => {
			const before = await storedPasswords();
			const bodies: unknown[] = [];
			const log = await captured(async () => {
				bodies.push(await call(PANEL_RQO));
				bodies.push(await call(migrateRqo({ ...KEYS, after: AFTER })));
				bodies.push(await call(migrateRqo({ ...KEYS, execute: true, after: AFTER })));
				bodies.push(await call(PANEL_RQO));
			});
			const after = await storedPasswords();
			const wire = JSON.stringify(bodies);
			// FLOOR: the run happened (so there were values to leak).
			expect(wire).toContain('"converted":3');
			const secrets = [
				...SCRATCH.map((account) => account.plaintext),
				...before.values(),
				...after.values(),
				MATERIAL.information,
				MATERIAL.infoKey,
			];
			expect(secrets.length).toBe(SCRATCH.length * 3 + 2);
			for (const secret of secrets) {
				expect(wire.includes(secret), 'on the wire').toBe(false);
				expect(log.includes(secret), 'in the log').toBe(false);
			}
			// No hash of any kind either — not even one this test did not plant.
			expect(wire).not.toContain('$argon2');
			expect(log).not.toContain('$argon2');
		});

		test('a malformed key is refused by NAME — its value is not echoed', async () => {
			const marker = 'ZZ_SECRET_LOOKING_VALUE_7719';
			const refusedBodies: Record<string, unknown>[] = [];
			const log = await captured(async () => {
				refusedBodies.push(await call(migrateRqo({ information: [marker], info_key: 'x' })));
				refusedBodies.push(
					await call(migrateRqo({ information: 'x', info_key: marker.repeat(200) })),
				);
			});
			for (const body of refusedBodies) {
				expect(body.ok).toBe(false);
				expect((body.error as { code: string }).code).toBe('maintenance.action_refused');
			}
			expect(JSON.stringify(refusedBodies)).not.toContain(marker);
			expect(log).not.toContain(marker);
			// …and a bad cursor is refused too, before anything runs.
			const badCursor = await call(migrateRqo({ ...KEYS, execute: true, after: '0' }));
			expect((badCursor.error as { code: string }).code).toBe('maintenance.action_refused');
		});
	});

	describe('the activity log (owner ruling 2026-11-20)', () => {
		const ROOT = join(import.meta.dir, '../..');
		const DATA_KEYS = [
			'action',
			'completed',
			'converted',
			'converted_section_ids',
			'examined',
			'execute',
			'msg',
			'part',
			'parts',
			'remaining',
			'skipped',
			'unconverted',
			'via',
		];

		/** No stored value (old or new), plaintext, typed key or hash of any kind in `text`. */
		function expectNoSecret(text: string, stored: Iterable<string>, where: string): void {
			const secrets = [
				...SCRATCH.map((account) => account.plaintext),
				...stored,
				MATERIAL.information,
				MATERIAL.infoKey,
				FOREIGN.information,
				FOREIGN.infoKey,
			];
			// FLOOR: there are values to look for.
			expect(secrets.length).toBeGreaterThanOrEqual(SCRATCH.length * 2 + 4);
			for (const secret of secrets) expect(text.includes(secret), where).toBe(false);
			expect(text, where).not.toContain('$argon2');
		}

		test('a panel run that executes writes ONE row: the admin, the maintenance area, the converted ids, the counts — and no secret', async () => {
			const before = await storedPasswords();
			const report = (await call(migrateRqo({ ...KEYS, execute: true, after: AFTER })))
				.data as Record<string, number>;
			const after = await storedPasswords();
			const rows = await conversionRows(base);
			expect(rows).toHaveLength(1);
			const row = rows[0] as ConversionRow;
			expect(row.who).toBe(-1); // the principal that ran it (root, here)
			expect(row.what).toBe(5); // SAVE
			expect(row.where).toBe('dd88'); // the maintenance area
			expect(row.host).toBe('localhost');
			expect(Object.keys(row.data).sort()).toEqual(DATA_KEYS);
			expect(row.data).toEqual({
				msg: 'Dédalo v6 passwords converted to Argon2id',
				action: LEGACY_CONVERSION_ACTION,
				via: 'panel',
				execute: true,
				completed: true,
				examined: 4,
				converted: 3,
				skipped: 0,
				unconverted: 1,
				remaining: report.remaining,
				converted_section_ids: [999_000_781, 999_000_782, 999_000_784],
				part: 1,
				parts: 1,
			});
			expectNoSecret(row.raw, [...before.values(), ...after.values()], 'in the activity row');
			// The accounts are named by id only.
			for (const account of SCRATCH) expect(row.raw).not.toContain(account.username);
		});

		test('a DRY run writes no row; neither does a refused caller', async () => {
			const dry = await call(migrateRqo({ ...KEYS, after: AFTER }));
			expect((dry.data as Record<string, unknown>).recoverable).toBe(3);
			const refused = await call(migrateRqo({ ...KEYS, execute: true, after: AFTER }), false);
			expect(refused.ok).toBe(false);
			expect(await conversionRows(base)).toEqual([]);
			// POSITIVE CONTROL: the same request, executed by the admin, does write one.
			await call(migrateRqo({ ...KEYS, execute: true, after: AFTER }));
			expect(await conversionRows(base)).toHaveLength(1);
		});

		test('an execute run that converts NOBODY (wrong keys) is still on record', async () => {
			await call(
				migrateRqo({
					information: 'ZZ_NOBODYS_INFORMATION',
					info_key: 'zz_nobodys_entity',
					execute: true,
					after: AFTER,
				}),
			);
			const rows = await conversionRows(base);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.data).toMatchObject({
				examined: 4,
				converted: 0,
				unconverted: 4,
				converted_section_ids: [],
			});
			expect(rows[0]?.raw).not.toContain('ZZ_NOBODYS_INFORMATION');
			expect(rows[0]?.raw).not.toContain('zz_nobodys_entity');
		});

		test('each executed batch is its own row; together they name every converted account once', async () => {
			let after: number | null = AFTER;
			for (let guard = 0; after !== null && guard < 10; guard++) {
				const report = (await call(migrateRqo({ ...KEYS, execute: true, after, limit: 1 })))
					.data as Record<string, number | null>;
				after = report.next_after ?? null;
			}
			const rows = await conversionRows(base);
			expect(rows.map((row) => row.data.converted_section_ids)).toEqual([
				[999_000_781],
				[999_000_782],
				[],
				[999_000_784],
			]);
		});

		test('a run that dies half way still records what it wrote', async () => {
			const run = migrateLegacyPasswords(MATERIAL, DOOR_ACTOR, {
				execute: true,
				afterSectionId: AFTER,
				beforeWrite: async (sectionId) => {
					if (sectionId === 999_000_784) throw new Error('zz planted failure');
				},
			});
			await expect(run).rejects.toThrow('zz planted failure');
			const stored = await storedPasswords();
			expect(isArgon2Hash(stored.get(999_000_781))).toBe(true);
			expect(isArgon2Hash(stored.get(999_000_784))).toBe(false);
			const rows = await conversionRows(base);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.host).toBe('zz_door_test');
			expect(rows[0]?.data).toMatchObject({
				completed: false,
				converted: 2,
				converted_section_ids: [999_000_781, 999_000_782],
				remaining: null,
			});
		});

		test('a long run is several rows, none cut by the row ceiling', () => {
			const ids = Array.from(
				{ length: LEGACY_CONVERSION_IDS_PER_ENTRY * 2 + 7 },
				(_, index) => 9_000_000_000_000 + index,
			);
			const entries = conversionActivityEntries(
				{ userId: -1, host: 'cli', via: 'cli', osUser: 'zz_operator' },
				{
					completed: true,
					examined: ids.length + 3,
					converted: ids.length,
					skipped: 1,
					unconverted: 2,
					remaining: 2,
					convertedSectionIds: ids,
				},
			);
			expect(entries).toHaveLength(3);
			expect(entries.flatMap((entry) => entry.data.converted_section_ids as number[])).toEqual(ids);
			expect(entries.map((entry) => [entry.data.part, entry.data.parts])).toEqual([
				[1, 3],
				[2, 3],
				[3, 3],
			]);
			for (const entry of entries) {
				// what the activity writer stores is the entry itself: nothing shortened or dropped
				expect(boundActivityData(entry.data)).toEqual(entry.data);
				expect(entry.data).toMatchObject({ converted: ids.length, os_user: 'zz_operator' });
			}
		});

		test('the COMMAND LINE: an --execute run writes the row as the CLI identity; a dry run writes none; nothing secret is printed or stored', async () => {
			const before = await storedPasswords();
			const census = await legacyPasswordCensus();
			const cli = async (...flags: string[]) => {
				const child = Bun.spawn(
					[
						process.execPath,
						'run',
						'scripts/migrate_v6_passwords.ts',
						`--information=${MATERIAL.information}`,
						`--info-key=${MATERIAL.infoKey}`,
						...flags,
					],
					{
						cwd: ROOT,
						env: process.env as Record<string, string>,
						stdout: 'pipe',
						stderr: 'pipe',
					},
				);
				const [out, err, code] = await Promise.all([
					new Response(child.stdout as ReadableStream).text(),
					new Response(child.stderr as ReadableStream).text(),
					child.exited,
				]);
				return { text: `${out}\n${err}`, code };
			};

			const dry = await cli();
			expect(dry.code, dry.text).toBe(0);
			expect(dry.text).toContain('DRY-RUN');
			expect(await storedPasswords()).toEqual(before);
			expect(await conversionRows(base)).toEqual([]);

			const run = await cli('--execute');
			expect(run.code, run.text).toBe(0);
			const after = await storedPasswords();
			for (const account of SCRATCH) {
				expect(isArgon2Hash(after.get(account.id)), account.username).toBe(
					account.material === MATERIAL,
				);
			}
			const rows = await conversionRows(base);
			expect(rows).toHaveLength(1);
			const row = rows[0] as ConversionRow;
			expect(row.who).toBe(-1);
			expect(row.what).toBe(5);
			expect(row.where).toBe('dd88');
			expect(row.host).toBe('cli');
			expect(Object.keys(row.data).sort()).toEqual([...DATA_KEYS, 'os_user'].sort());
			expect(row.data).toMatchObject({
				action: LEGACY_CONVERSION_ACTION,
				via: 'cli',
				execute: true,
				completed: true,
				examined: census.legacy,
				converted: 3,
				skipped: 0,
				unconverted: census.legacy - 3,
				remaining: census.legacy - 3,
				converted_section_ids: [999_000_781, 999_000_782, 999_000_784],
			});
			expect(typeof row.data.os_user).toBe('string');
			expect((row.data.os_user as string).length).toBeGreaterThan(0);
			const stored = [...before.values(), ...after.values()];
			expectNoSecret(row.raw, stored, 'in the activity row');
			expectNoSecret(`${dry.text}\n${run.text}`, stored, 'printed by the command line');
		}, 120_000);
	});

	describe('the door', () => {
		test('a password changed while the run was hashing is skipped — never overwritten with the old one', async () => {
			const reset = await Bun.password.hash('an-admin-reset-it-meanwhile', 'argon2id');
			const report = await migrateLegacyPasswords(MATERIAL, DOOR_ACTOR, {
				execute: true,
				afterSectionId: AFTER,
				beforeWrite: async (sectionId) => {
					// only this account's password is changed under the run
					// (the statement is a no-op for every other account)
					await sql.unsafe(
						`UPDATE matrix_users SET string = jsonb_set(string, '{dd133,0,value}', to_jsonb($2::text))
						  WHERE section_tipo = 'dd128' AND section_id = $1 AND section_id = $3`,
						[sectionId, reset, 999_000_782],
					);
				},
			});
			expect(report).toMatchObject({ recoverable: 3, converted: 2, skipped: 1, failed: 1 });
			expect((await storedPasswords()).get(999_000_782)).toBe(reset);
			// The activity row names the accounts WRITTEN — the skipped one is not among them.
			const rows = await conversionRows(base);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.data).toMatchObject({
				converted: 2,
				skipped: 1,
				unconverted: 1,
				converted_section_ids: [999_000_781, 999_000_784],
			});
		});

		test('empty keys stand for the v6 defaults (the published information string, this entity)', async () => {
			const { DEFAULT_INFORMATION } = await import('../../src/core/security/legacy_password.ts');
			const { config } = await import('../../src/config/config.ts');
			const defaults: LegacyKeyMaterial = {
				information: DEFAULT_INFORMATION,
				infoKey: config.entity,
			};
			const account = SCRATCH[0] as Scratch;
			await sql.unsafe(
				`UPDATE matrix_users SET string = jsonb_set(string, '{dd133,0,value}', to_jsonb($2::text))
				  WHERE section_tipo = 'dd128' AND section_id = $1`,
				[account.id, encryptLegacyPasswordForTest(account.plaintext, defaults)],
			);
			const report = (
				await call(migrateRqo({ information: '', execute: true, after: AFTER, limit: 1 }))
			).data as Record<string, unknown>;
			expect(report).toMatchObject({ examined: 1, converted: 1, failed: 0 });
			const stored = (await storedPasswords()).get(account.id) as string;
			expect(await Bun.password.verify(account.plaintext, stored)).toBe(true);
		});

		test('the command line is this door: it holds no statement of its own', () => {
			const cli = readFileSync(
				join(import.meta.dir, '../../scripts/migrate_v6_passwords.ts'),
				'utf8',
			);
			expect(cli).toContain("'../src/core/security/legacy_password_migration.ts'");
			expect(cli).toContain('migrateLegacyPasswords(');
			expect(cli).not.toMatch(/\bsql\b|UPDATE |SELECT /);
		});
	});
});
