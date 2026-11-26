/**
 * ROOT'S PASSWORD IS NOT WRITTEN BY THE APPLICATION (S07 — owner ruling 2026-11-19,
 * WC-2026-11-21-root-password-write-refused).
 *
 * The password component (dd133) of the root user record (dd128/-1) is changed by
 * the documented manual procedure only. Every application write door refuses to
 * change it, for every principal — root included — with ONE typed refusal,
 * `record.root_password_write_refused`, thrown by the record-write chokepoint
 * (section_record/record_write.ts → security/root_password_guard.ts), so no door
 * has a rule to remember.
 *
 * WHAT IS MEASURED — outcomes, never spellings:
 *
 *   1. THE CHOKEPOINT CENSUS, TOTAL BY DERIVATION. Every `persist*` export of
 *      record_write.ts is DRIVEN against dd128/-1 with a dd133 change and must
 *      refuse with the code, leaving the stored value byte-identical. The entry
 *      list is read from the module at run time: a new entry without a probe is red.
 *   2. THE DOORS ABOVE IT. The human save door (root itself, and a global admin
 *      holding the grant), and saveComponentData — the engine every import, tool,
 *      MCP and change-plan door writes through — refuse, write nothing, leave no
 *      Time Machine row.
 *   3. THE WRITERS THAT BYPASS THE CHOKEPOINT, TOTAL BY DERIVATION. Every file
 *      that calls a raw value-writing `matrix_write` primitive outside the
 *      chokepoint is classified here with its reason; a new one is red.
 *   4. WHAT MUST KEEP WORKING, each driven for real: the legacy-password
 *      conversion door on root's own row, the suite's credential setter, the
 *      login-time cost upgrade of root's hash (the one sanctioned rewrite — same
 *      plaintext, proved a millisecond earlier), any other account's password,
 *      and root's other keys.
 */
// Generic `test` TLD law (AGENTS.md): the dd128/dd133 tipos are seed-shipped (every
// installation has them) and have no `test` twin; scratch accounts are created here
// and deleted in afterAll. Root's own credential is BUILT when absent and put back.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { coreApiActions } from '../../src/core/api/handlers/dd_core_api.ts';
import { readMatrixRecord } from '../../src/core/db/matrix.ts';
import {
	deleteMatrixRecord,
	insertMatrixRecordWithCounter,
} from '../../src/core/db/matrix_write.ts';
import { sql, withTransaction } from '../../src/core/db/postgres.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import { ERROR_REGISTRY } from '../../src/core/errors/registry.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import * as recordWrite from '../../src/core/section_record/record_write.ts';
import { login } from '../../src/core/security/auth.ts';
import { encryptLegacyPasswordForTest } from '../../src/core/security/legacy_password.ts';
import {
	LEGACY_CONVERSION_ACTION,
	migrateLegacyPasswords,
} from '../../src/core/security/legacy_password_migration.ts';
import {
	clearPermissionsCache,
	clearPrincipalCache,
	type Principal,
	resolvePrincipal,
} from '../../src/core/security/permissions.ts';
import {
	LOGIN_COST_UPGRADE_SCOPE,
	runWithoutAccountRevocation,
} from '../../src/core/security/revocation.ts';
import { refuseRootPasswordWrite } from '../../src/core/security/root_password_guard.ts';
import { ensureSuiteLoginPassword } from '../../src/core/test_data/suite_login.ts';
import { stripComments } from '../helpers/strip_comments.ts';

const ROOT = resolve(import.meta.dir, '../..');
const CODE = 'record.root_password_write_refused';
const USERS_TABLE = 'matrix_users';
const USERS = 'dd128';
const PASSWORD = 'dd133';
const FULL_NAME = 'dd452';
const ROOT_ID = -1;
const ROOT_TARGET = { table: USERS_TABLE, sectionTipo: USERS, sectionId: ROOT_ID };
const RUN_TAG = `rootpw_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
const DERIVED = { actor: ROOT_ID };
/** A value no door may store on root: a well-formed Argon2id hash that is not root's. */
const FOREIGN_HASH =
	'$argon2id$v=19$m=65536,t=3,p=1$c2NyYXRjaHNhbHRzY3JhdGNo$3q2+7wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const FOREIGN_ITEMS = [{ id: 1, lang: 'lg-nolan', value: FOREIGN_HASH }];

let originalRootString: Record<string, unknown> | null = null;
let rootStringCaptured = false;
let tmWatermark = 0;
let scratchUserId = 0;
let superuser: Principal;

async function rootString(): Promise<Record<string, unknown>> {
	const rows = (await sql.unsafe(
		'SELECT string FROM matrix_users WHERE section_tipo = $1 AND section_id = $2',
		[USERS, ROOT_ID],
	)) as { string: Record<string, unknown> | null }[];
	expect(rows.length, 'the suite database holds the root record').toBe(1);
	return rows[0]?.string ?? {};
}

async function rootPasswordItems(): Promise<unknown> {
	return (await rootString())[PASSWORD] ?? null;
}

async function setRootStringRaw(value: Record<string, unknown>): Promise<void> {
	await sql.unsafe(
		'UPDATE matrix_users SET string = $3::text::jsonb WHERE section_tipo = $1 AND section_id = $2',
		[USERS, ROOT_ID, JSON.stringify(value)],
	);
}

async function plantRootPassword(items: unknown): Promise<void> {
	await setRootStringRaw({ ...(await rootString()), [PASSWORD]: items });
}

async function rootTmRows(): Promise<number> {
	const rows = (await sql.unsafe(
		'SELECT count(*)::int AS n FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2 AND id > $3',
		[USERS, ROOT_ID, tmWatermark],
	)) as { n: number }[];
	return rows[0]?.n ?? 0;
}

/** Run `write`; it must throw THE code, and root's stored password must not move. */
async function expectRefused(label: string, write: () => Promise<unknown>): Promise<void> {
	const before = JSON.stringify(await rootPasswordItems());
	let thrown: unknown = null;
	try {
		await write();
	} catch (error) {
		thrown = error;
	}
	expect(thrown, `${label}: the write was NOT refused`).toBeInstanceOf(DedaloError);
	expect((thrown as DedaloError).code, label).toBe(CODE);
	expect(JSON.stringify(await rootPasswordItems()), `${label}: the stored value moved`).toBe(
		before,
	);
}

const ROLLBACK = Symbol('rollback');
/** Run `work` in a transaction that ALWAYS rolls back (a probe that must leave nothing). */
async function rolledBack(work: () => Promise<void>): Promise<void> {
	try {
		await withTransaction(async () => {
			await work();
			throw ROLLBACK;
		});
	} catch (error) {
		if (error !== ROLLBACK) throw error;
	}
}

beforeAll(async () => {
	const rows = (await sql.unsafe(
		'SELECT COALESCE(max(id), 0) AS max_id FROM matrix_time_machine',
	)) as { max_id: number }[];
	tmWatermark = Number(rows[0]?.max_id ?? 0);
	originalRootString = structuredClone(await rootString());
	rootStringCaptured = true;
	// ROOT'S CREDENTIAL IS BUILT, NOT BORROWED: the install seed ships root passwordless,
	// and whatever an earlier file in the same shard left there is ambient state. Planted
	// ALWAYS (afterAll puts the original back): a plant only "when absent" made this file's
	// expect count depend on that state (rootString asserts) — 148 vs 147 in a sharded bin.
	await plantRootPassword([
		{ id: 1, lang: 'lg-nolan', value: await Bun.password.hash(`root-${RUN_TAG}`) },
	]);
	scratchUserId = await insertMatrixRecordWithCounter(USERS_TABLE, USERS, {
		string: {
			dd132: [{ id: 1, lang: 'lg-nolan', value: RUN_TAG }],
			[PASSWORD]: [{ id: 1, lang: 'lg-nolan', value: await Bun.password.hash(`u-${RUN_TAG}`) }],
		},
		data: { label: RUN_TAG, section_tipo: USERS, created_by_user_id: ROOT_ID },
	});
	clearPermissionsCache();
	clearPrincipalCache();
	superuser = await resolvePrincipal(ROOT_ID);
}, 60000);

afterAll(async () => {
	if (rootStringCaptured && originalRootString !== null) {
		await setRootStringRaw(originalRootString);
	}
	if (scratchUserId > 0) {
		await deleteMatrixRecord(USERS_TABLE, USERS, scratchUserId);
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[USERS, scratchUserId],
		);
	}
	await sql.unsafe(
		'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2 AND id > $3',
		[USERS, ROOT_ID, tmWatermark],
	);
	clearPermissionsCache();
	clearPrincipalCache();
});

// ---------------------------------------------------------------------------
// 1. THE CHOKEPOINT CENSUS
// ---------------------------------------------------------------------------

const passwordPath = (value: unknown) => [{ column: 'string' as const, key: PASSWORD, value }];

/**
 * One probe per chokepoint entry: drive it against dd128/-1 with a dd133 change.
 * `refuses: false` needs its reason — an entry that cannot carry the key at all.
 */
const CHOKEPOINT_PROBES: Record<
	string,
	{ refuses: true; drive: () => Promise<unknown> } | { refuses: false; reason: string }
> = {
	persistRecordKeys: {
		refuses: true,
		drive: () =>
			recordWrite.persistRecordKeys(ROOT_TARGET, passwordPath(FOREIGN_ITEMS), false, DERIVED),
	},
	persistRestoredKeys: {
		refuses: true,
		drive: () =>
			recordWrite.persistRestoredKeys(ROOT_TARGET, passwordPath(FOREIGN_ITEMS), false, DERIVED),
	},
	persistRelationRemovalKeys: {
		refuses: true,
		// The removal shape: the key is REMOVED (value null).
		drive: () =>
			recordWrite.persistRelationRemovalKeys(ROOT_TARGET, passwordPath(null), false, DERIVED),
	},
	persistObserverMirrorKeys: {
		refuses: true,
		drive: () =>
			recordWrite.persistObserverMirrorKeys(
				ROOT_TARGET,
				passwordPath(FOREIGN_ITEMS),
				false,
				DERIVED,
			),
	},
	persistObserverResaveKeys: {
		refuses: true,
		drive: () =>
			recordWrite.persistObserverResaveKeys(
				ROOT_TARGET,
				passwordPath(FOREIGN_ITEMS),
				false,
				DERIVED,
			),
	},
	persistAppendedKeyItems: {
		refuses: true,
		drive: () =>
			recordWrite.persistAppendedKeyItems(
				ROOT_TARGET,
				'string',
				PASSWORD,
				[{ id: 2, lang: 'lg-nolan', value: FOREIGN_HASH }],
				false,
				DERIVED,
			),
	},
	persistRecordColumns: {
		refuses: true,
		// The whole-record shape (the Time Machine's full-record restore): the string
		// column as stored, with ONLY the password changed.
		drive: async () =>
			recordWrite.persistRecordColumns(
				ROOT_TARGET,
				{ string: { ...(await rootString()), [PASSWORD]: FOREIGN_ITEMS } },
				false,
				DERIVED,
			),
	},
	persistRecordBirth: {
		refuses: true,
		// A birth writes only where NO row stands, so the probe removes root's row
		// inside a transaction that always rolls back, then births it with a password.
		drive: async () => {
			let refusal: unknown = null;
			await rolledBack(async () => {
				await sql.unsafe('DELETE FROM matrix_users WHERE section_tipo = $1 AND section_id = $2', [
					USERS,
					ROOT_ID,
				]);
				try {
					await recordWrite.persistRecordBirth(
						ROOT_TARGET,
						{
							string: {
								dd132: [{ id: 1, lang: 'lg-nolan', value: 'root' }],
								[PASSWORD]: FOREIGN_ITEMS,
							},
						},
						false,
						DERIVED,
					);
				} catch (error) {
					refusal = error;
				}
			});
			if (refusal !== null) throw refusal;
		},
	},
	persistModifiedStamp: {
		refuses: false,
		reason: 'writes the dd197/dd201 modified stamps only; it takes no key and no value.',
	},
};

describe('the record-write chokepoint refuses every write of root’s password', () => {
	test('the census is TOTAL: every persist* entry of record_write.ts has a probe (and no probe invents one)', () => {
		const entries = Object.keys(recordWrite)
			.filter((name) => name.startsWith('persist'))
			.sort();
		// Floor: an empty derivation would make the equality below vacuous.
		expect(entries.length).toBeGreaterThanOrEqual(9);
		expect(Object.keys(CHOKEPOINT_PROBES).sort()).toEqual(entries);
	});

	for (const [entry, probe] of Object.entries(CHOKEPOINT_PROBES)) {
		if (!probe.refuses) {
			test(`${entry} cannot carry the key — ${probe.reason}`, async () => {
				const before = JSON.stringify(await rootPasswordItems());
				await recordWrite.persistModifiedStamp(ROOT_TARGET, { userId: ROOT_ID });
				expect(JSON.stringify(await rootPasswordItems())).toBe(before);
			});
			continue;
		}
		test(`${entry} → ${CODE}, nothing written`, async () => {
			await expectRefused(entry, probe.drive);
		});
	}

	test('the refusal is the registered, labelled, non-retryable 403 it claims to be', () => {
		const row = ERROR_REGISTRY[CODE as keyof typeof ERROR_REGISTRY];
		expect(row).toBeDefined();
		expect(row.category).toBe('permission');
		expect(row.status).toBe(403);
		expect(row.retryable).toBe(false);
	});

	test('a key path that carries the password BESIDE other keys is refused whole', async () => {
		const name = (await rootString())[FULL_NAME] ?? null;
		await expectRefused('mixed path', () =>
			recordWrite.persistRecordKeys(
				ROOT_TARGET,
				[
					{
						column: 'string',
						key: FULL_NAME,
						value: [{ id: 1, lang: 'lg-nolan', value: RUN_TAG }],
					},
					{ column: 'string', key: PASSWORD, value: FOREIGN_ITEMS },
				],
				false,
				DERIVED,
			),
		);
		expect((await rootString())[FULL_NAME] ?? null).toEqual(name);
	});

	test('an id that arrives as the STRING "-1" addresses the same row and is refused the same', async () => {
		// The type says number; the SQL does not care. A door forwarding a wire value
		// unparsed must not be the way past the rule.
		const stringly = { ...ROOT_TARGET, sectionId: '-1' as unknown as number };
		await expectRefused('string id, key entry', () =>
			recordWrite.persistRecordKeys(stringly, passwordPath(FOREIGN_ITEMS), false, DERIVED),
		);
		await expectRefused('string id, whole record', async () =>
			recordWrite.persistRecordColumns(
				stringly,
				{ string: { ...(await rootString()), [PASSWORD]: FOREIGN_ITEMS } },
				false,
				DERIVED,
			),
		);
	});

	test('CONTROL: a whole-record write that leaves the password AS STORED is not refused', async () => {
		// The Time Machine's full-record restore carries every column; one that does
		// not CHANGE the password is not a password write.
		const stored = await rootString();
		const outcome = await recordWrite.persistRecordColumns(
			ROOT_TARGET,
			{ string: structuredClone(stored) },
			false,
			DERIVED,
		);
		expect(outcome).toBe('updated');
		expect(await rootString()).toEqual(stored);
	});

	test('CONTROL: root’s OTHER keys are still written through the same entry', async () => {
		const stored = (await rootString())[FULL_NAME] ?? null;
		const probe = [{ id: 1, lang: 'lg-nolan', value: `name-${RUN_TAG}` }];
		await recordWrite.persistRecordKeys(
			ROOT_TARGET,
			[{ column: 'string', key: FULL_NAME, value: probe }],
			false,
			DERIVED,
		);
		expect((await rootString())[FULL_NAME]).toEqual(probe);
		await recordWrite.persistRecordKeys(
			ROOT_TARGET,
			[{ column: 'string', key: FULL_NAME, value: stored }],
			false,
			DERIVED,
		);
		expect((await rootString())[FULL_NAME] ?? null).toEqual(stored);
	});

	test('the rule itself binds the ROOT record and the PASSWORD key, nothing wider', () => {
		// The chokepoint pre-filters on the root address before it asks, so the rule's
		// own address half is asked here directly.
		const refused = (sectionTipo: string, sectionId: number, keys: string[]): boolean => {
			try {
				refuseRootPasswordWrite({ sectionTipo, sectionId }, keys, 'gate');
				return false;
			} catch (error) {
				return (error as DedaloError).code === CODE;
			}
		};
		expect(refused(USERS, ROOT_ID, [FULL_NAME, PASSWORD])).toBe(true);
		expect(refused(USERS, scratchUserId, [PASSWORD])).toBe(false);
		expect(refused(USERS, 1, [PASSWORD])).toBe(false);
		expect(refused('dd234', ROOT_ID, [PASSWORD])).toBe(false);
		expect(refused(USERS, ROOT_ID, [FULL_NAME])).toBe(false);
		expect(refused(USERS, ROOT_ID, [])).toBe(false);
	});

	test('CONTROL: ANOTHER account’s password is still written through the key entry', async () => {
		const target = { table: USERS_TABLE, sectionTipo: USERS, sectionId: scratchUserId };
		await recordWrite.persistRecordKeys(target, passwordPath(FOREIGN_ITEMS), false, DERIVED);
		const record = await readMatrixRecord(USERS_TABLE, USERS, scratchUserId);
		expect((record?.columns.string as Record<string, unknown>)[PASSWORD]).toEqual(FOREIGN_ITEMS);
	});
});

// ---------------------------------------------------------------------------
// 2. THE DOORS ABOVE THE CHOKEPOINT
// ---------------------------------------------------------------------------

describe('the doors above the chokepoint refuse, for every principal', () => {
	async function callSave(principal: Principal, value: unknown): Promise<unknown> {
		const handler = coreApiActions.save;
		if (!handler) throw new Error("dd_core_api has no 'save' action registered");
		return handler(
			{
				source: { tipo: PASSWORD, section_tipo: USERS, section_id: ROOT_ID, lang: 'lg-nolan' },
				data: { changed_data: [{ action: 'set_data', value }] },
			} as unknown as Parameters<typeof handler>[0],
			{
				principal,
				session: { userId: principal.userId },
				clientIp: '127.0.0.1',
				requestId: RUN_TAG,
			} as unknown as Parameters<typeof handler>[1],
		);
	}

	test('ROOT ITSELF, through the human save door (its own self-service edit)', async () => {
		await expectRefused('dd_core_api save as root', () =>
			callSave(superuser, [{ id: 1, value: `Fresh-Root-${RUN_TAG}-9` }]),
		);
		expect(await rootTmRows()).toBe(0);
	});

	test('root re-submitting its CURRENT hash is refused too (no value is an exception)', async () => {
		const items = (await rootPasswordItems()) as { value: string }[];
		await expectRefused('dd_core_api save as root, same hash', () =>
			callSave(superuser, [{ id: 1, value: items[0]?.value }]),
		);
	});

	test('saveComponentData — the engine every import / tool / MCP door writes through', async () => {
		for (const [label, changedData] of [
			['set_data', [{ action: 'set_data', value: [{ id: 1, value: `Other-Root-${RUN_TAG}-9` }] }]],
			['clear', [{ action: 'set_data', value: [] }]],
		] as const) {
			await expectRefused(`saveComponentData ${label}`, () =>
				saveComponentData({
					componentTipo: PASSWORD,
					sectionTipo: USERS,
					sectionId: ROOT_ID,
					lang: 'lg-nolan',
					changedData: changedData as never,
					userId: ROOT_ID,
				}),
			);
		}
		expect(await rootTmRows()).toBe(0);
	});

	test('a NON-root principal is refused as well (whichever gate fires first), nothing written', async () => {
		const before = JSON.stringify(await rootPasswordItems());
		const other: Principal = { ...(await resolvePrincipal(scratchUserId)) };
		await expect(callSave(other, [{ id: 1, value: `Takeover-${RUN_TAG}-9` }])).rejects.toThrow();
		expect(JSON.stringify(await rootPasswordItems())).toBe(before);
	});
});

// ---------------------------------------------------------------------------
// 3. THE WRITERS THAT BYPASS THE CHOKEPOINT
// ---------------------------------------------------------------------------

/** The raw matrix_write primitives that can change a stored component VALUE of a live row. */
const VALUE_WRITERS = [
	'updateMatrixRecord',
	'updateMatrixKeyData',
	'updateMatrixKeysData',
	'appendMatrixKeyItems',
];

/**
 * Every file outside the chokepoint that calls one, and why it cannot be an
 * APPLICATION door onto root's password. `sanctioned` = it CAN write it, by design.
 */
const BYPASS_CENSUS: Record<string, string> = {
	'src/core/security/legacy_password_migration.ts':
		'sanctioned — the v6 → v7 conversion door (owner ruling: must NOT be blocked): the same password re-hashed, only over the value read. Driven below.',
	'src/core/test_data/suite_login.ts':
		'sanctioned — the suite’s own credential setter: refuses any database without the dedalo_test_marker row (assertTestDatabase). Driven below.',
	'src/core/test_data/seed.ts':
		'bound to the test3 playground section (CANONICAL_SECTION_TIPO); marker-guarded test data.',
	'src/core/archive/restore.ts':
		'OPERATOR CLI (scripts/archive.ts), not an application door: a row-level, byte-verbatim restore of an archive artifact; reaches an existing row only under an explicit onExistingRecord:overwrite. OWNER QUESTION open (S07 report): whether an archive may overwrite dd128/-1.',
	'src/core/tools/register.ts': 'bound to the tools register section (dd1324 records).',
	'src/core/install/hierarchy_activate.ts':
		'bound to the hierarchy section (HIERARCHY_SECTION) record it just created.',
	'src/core/ontology/ontology_write.ts':
		'bound to the ontology main section and the ontology typology records.',
	'src/core/section/record/record_metadata.ts':
		'writes the `data` metadata column only — no component key.',
	'src/core/update/transform/portalize.ts':
		'the update-process portalize transform: writes the flat components / portal keys its catalog step names, during a data-version update (no principal, no request).',
	'src/core/relations/dataframe.ts': 'writes dataframe frame keys of the `relation` column only.',
	'src/core/relations/save.ts': 'writes one `relation` column slot (a frame slot) only.',
	'src/core/ontology/hierarchy_provision.ts':
		'bound to matrix_ontology node records and the hierarchy section record.',
	'src/core/ontology/hierarchy_state.ts': 'bound to a hierarchy’s root term record.',
	'src/core/media/tools/files_info_persist.ts': 'writes the `media` column only.',
};

function sourceFiles(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) {
			if (name !== 'node_modules') sourceFiles(full, out);
		} else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(full);
	}
	return out;
}

describe('the writers that bypass the chokepoint are censused', () => {
	test('every caller of a raw value-writing primitive is classified (derived, total)', () => {
		const files = [...sourceFiles(join(ROOT, 'src')), ...sourceFiles(join(ROOT, 'tools'))];
		// Floor: the walk really read the tree.
		expect(files.length).toBeGreaterThan(500);
		const pattern = new RegExp(`\\b(?:${VALUE_WRITERS.join('|')})\\s*\\(`);
		const callers = files
			.map((file) => relative(ROOT, file))
			.filter(
				(file) =>
					file !== 'src/core/db/matrix_write.ts' &&
					file !== 'src/core/section_record/record_write.ts',
			)
			.filter((file) =>
				pattern.test(stripComments(readFileSync(join(ROOT, file), 'utf8'), { blankStrings: true })),
			)
			.sort();
		expect(callers).toEqual(Object.keys(BYPASS_CENSUS).sort());
		// The primitive list itself is checked against the module: a new value writer
		// in matrix_write.ts whose name is not here would escape the census.
		const exported = [
			...readFileSync(join(ROOT, 'src/core/db/matrix_write.ts'), 'utf8').matchAll(
				/^export async function ((?:update|append)Matrix\w+)/gm,
			),
		]
			.map((match) => match[1])
			.filter((name) => name !== 'appendMatrixUpdateRow')
			.sort();
		expect(exported).toEqual([...VALUE_WRITERS].sort());
	});
});

// ---------------------------------------------------------------------------
// 4. WHAT MUST KEEP WORKING
// ---------------------------------------------------------------------------

describe('the sanctioned writers of root’s password still write it', () => {
	test('the legacy-password conversion door converts ROOT’s own v6 value', async () => {
		const keep = await rootPasswordItems();
		const material = { information: `info-${RUN_TAG}`, infoKey: `key-${RUN_TAG}` };
		const plaintext = `Legacy-Root-${RUN_TAG}-9`;
		const activityBase = Number(
			(
				(await sql.unsafe(
					"SELECT COALESCE(MAX(section_id), 0) AS id FROM matrix_activity WHERE section_tipo = 'dd542'",
				)) as { id: unknown }[]
			)[0]?.id,
		);
		try {
			await plantRootPassword([
				{ id: 1, lang: 'lg-nolan', value: encryptLegacyPasswordForTest(plaintext, material) },
			]);
			// Root is the lowest section_id: the batch of ONE starting below it is root.
			const report = await migrateLegacyPasswords(
				material,
				{ userId: ROOT_ID, host: 'gate', via: 'cli' },
				{ execute: true, afterSectionId: ROOT_ID - 1, limit: 1 },
			);
			expect(report.converted).toBe(1);
			const items = (await rootPasswordItems()) as { value: string }[];
			expect(items[0]?.value).toStartWith('$argon2');
			expect(await Bun.password.verify(plaintext, items[0]?.value ?? '')).toBe(true);
		} finally {
			await plantRootPassword(keep);
			await sql.unsafe(
				`DELETE FROM matrix_activity
				  WHERE section_tipo = 'dd542' AND section_id > $1
				    AND misc->'dd551'->0->'value'->>'action' = $2`,
				[activityBase, LEGACY_CONVERSION_ACTION],
			);
		}
	}, 60000);

	test('the suite credential setter still sets root’s credential (its own test-data door)', async () => {
		const keep = await rootPasswordItems();
		const username = String(
			((await rootString()).dd132 as { value?: string }[] | undefined)?.[0]?.value ?? '',
		);
		expect(username).not.toBe('');
		const password = `Suite-Root-${RUN_TAG}-9`;
		try {
			expect(await ensureSuiteLoginPassword(username, password)).toBe('set');
			const items = (await rootPasswordItems()) as { value: string }[];
			expect(await Bun.password.verify(password, items[0]?.value ?? '')).toBe(true);
		} finally {
			await plantRootPassword(keep);
		}
	}, 60000);

	test('the login-time COST UPGRADE still rewrites root’s below-target hash (same password)', async () => {
		const keep = await rootPasswordItems();
		const username = String(
			((await rootString()).dd132 as { value?: string }[] | undefined)?.[0]?.value ?? '',
		);
		const password = `Cost-Root-${RUN_TAG}-9`;
		try {
			const weak = await Bun.password.hash(password, {
				algorithm: 'argon2id',
				memoryCost: 65_536,
				timeCost: 2,
			});
			expect(weak).toContain('t=2');
			await plantRootPassword([{ id: 1, lang: 'lg-nolan', value: weak }]);
			const result = await login(username, password, '127.0.0.1');
			expect(result.ok, result.message).toBe(true);
			let stored = weak;
			for (let attempt = 0; attempt < 100 && stored === weak; attempt++) {
				await Bun.sleep(50);
				stored = ((await rootPasswordItems()) as { value: string }[])[0]?.value ?? '';
			}
			expect(stored).toContain('t=3');
			expect(await Bun.password.verify(password, stored)).toBe(true);
		} finally {
			await plantRootPassword(keep);
		}
	}, 60000);

	test('ANOTHER revocation-suppression scope does not admit the write: the exception is the cost upgrade, by name', async () => {
		// The exception rides the revocation-suppression scope, whose own purpose is
		// different ("this write is not an account transition"). A second scope with any
		// other reason must not open root's password.
		await expectRefused('key entry under a foreign suppression scope', () =>
			runWithoutAccountRevocation('gate: not the cost upgrade', () =>
				recordWrite.persistRecordKeys(ROOT_TARGET, passwordPath(FOREIGN_ITEMS), false, DERIVED),
			),
		);
		expect(() =>
			runWithoutAccountRevocation('gate: not the cost upgrade', () =>
				refuseRootPasswordWrite({ sectionTipo: USERS, sectionId: ROOT_ID }, [PASSWORD], 'gate'),
			),
		).toThrow();
		// CONTROL: the named scope is the one that passes.
		expect(() =>
			runWithoutAccountRevocation(LOGIN_COST_UPGRADE_SCOPE, () =>
				refuseRootPasswordWrite({ sectionTipo: USERS, sectionId: ROOT_ID }, [PASSWORD], 'gate'),
			),
		).not.toThrow();
	});

	test('the cost-upgrade scope has exactly ONE caller in the engine: the login', () => {
		// The scope is the one hole in the refusal; a second caller would be a second door.
		const files = [...sourceFiles(join(ROOT, 'src')), ...sourceFiles(join(ROOT, 'tools'))];
		const callers = files
			.filter((file) =>
				/\brunWithoutAccountRevocation\s*\(/.test(
					stripComments(readFileSync(file, 'utf8'), { blankStrings: true }),
				),
			)
			.map((file) => relative(ROOT, file))
			.sort();
		expect(callers).toEqual(['src/core/security/auth.ts']);
	});
});
