/**
 * S1-07 ROUND-TRIP SCRATCH GATE — writeRegistryRecord (dd1324 tools registry).
 *
 * The pre-fix writer had BOTH corruption modes of the unpoliced binding
 * convention: UPDATE bound `JSON.stringify` output as `$n::jsonb` (Bun 1.3.9
 * double-encodes → jsonb STRING scalar — the row becomes unfindable by TS
 * readRegistryByName AND PHP get_tools on the SHARED registry), and the
 * INSERT referenced an unbound `$1` (42P18 — could never execute, which also
 * shielded a bare MAX+1 counter race).
 *
 * The writer is live (installer, Register tools widget, the update run's
 * ancillary phase — REMEDIATION WS-A item 3). It runs the real writer against the SCRATCH
 * surface (matrix_test + a zztws* section tipo) via the injectable
 * RegistryWriteTarget:
 *   - INSERT lands with jsonb_typeof='object' on every written column;
 *   - section_id allocation goes through the matrix counter (advances, never
 *     bare MAX+1) and self-heals like any counter insert;
 *   - the row is findable by name through the same ->> extraction the
 *     registry reader uses;
 *   - UPDATE keeps jsonb_typeof='object' and replaces the identity columns;
 *   - keepStoredActive (the update run's ancillary write): the STORED dd1354
 *     value survives the file's declaration, and a toggle committed while the
 *     write waits on the row lock is the value that lands (review #25).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { updateMatrixRecord } from '../../src/core/db/matrix_write.ts';
import { sql, withTransaction } from '../../src/core/db/postgres.ts';
import type { RegistryRow, ToolRecord } from '../../src/core/tools/register.ts';
import { writeRegistryRecord } from '../../src/core/tools/register.ts';
import { cleanScratchTipo } from '../helpers/test_data.ts';

const TARGET = { table: 'matrix_test', sectionTipo: 'zztws2' } as const;

/** Minimal column-keyed tool record (TIPO.NAME dd1326 lives in `string`). */
function toolRecord(name: string, version: string): ToolRecord {
	return {
		data: {},
		string: {
			dd1326: [{ value: name, lang: 'lg-nolan' }],
			dd1327: [{ value: version, lang: 'lg-nolan' }],
		},
		relation: {
			dd1354: [{ section_tipo: 'dd64', section_id: '1', type: 'dd96' }], // active
		},
		misc: {
			dd1335: [{ value: { view: 'default' } }],
		},
	} as unknown as ToolRecord;
}

async function clean(): Promise<void> {
	await cleanScratchTipo(TARGET.sectionTipo);
}

describe('S1-07 — writeRegistryRecord round-trip on the scratch target', () => {
	beforeAll(clean);
	afterAll(clean);

	test('INSERT: executes, allocates via the counter, stores objects (never jsonb strings)', async () => {
		await writeRegistryRecord('tool_scratch_probe', toolRecord('tool_scratch_probe', '1.0'), null, {
			...TARGET,
		});

		const rows = (await sql.unsafe(
			`SELECT section_id,
			        jsonb_typeof(string)   AS string_type,
			        jsonb_typeof(relation) AS relation_type,
			        jsonb_typeof(misc)     AS misc_type,
			        string->'dd1326'->0->>'value' AS name
			 FROM matrix_test WHERE section_tipo = $1`,
			[TARGET.sectionTipo],
		)) as {
			section_id: number;
			string_type: string;
			relation_type: string;
			misc_type: string;
			name: string;
		}[];
		expect(rows.length).toBe(1);
		// The double-encode corruption mode: these would be 'string'.
		expect(rows[0]?.string_type).toBe('object');
		expect(rows[0]?.relation_type).toBe('object');
		expect(rows[0]?.misc_type).toBe('object');
		// Findable by name via the reader's ->> extraction (the corrupted row
		// was unfindable by BOTH engines).
		expect(rows[0]?.name).toBe('tool_scratch_probe');

		// Counter-backed allocation (never bare MAX+1): the counter row exists
		// and matches the allocated id.
		const counter = (await sql.unsafe('SELECT value FROM matrix_counter WHERE tipo = $1', [
			TARGET.sectionTipo,
		])) as { value: number }[];
		expect(Number(counter[0]?.value)).toBe(Number(rows[0]?.section_id));

		// A second insert advances the counter (no id reuse).
		await writeRegistryRecord(
			'tool_scratch_probe2',
			toolRecord('tool_scratch_probe2', '1.0'),
			null,
			{
				...TARGET,
			},
		);
		const ids = (await sql.unsafe(
			'SELECT section_id FROM matrix_test WHERE section_tipo = $1 ORDER BY section_id',
			[TARGET.sectionTipo],
		)) as { section_id: number }[];
		expect(ids.length).toBe(2);
		expect(Number(ids[1]?.section_id)).toBe(Number(ids[0]?.section_id) + 1);
	}, 30000);

	test('UPDATE: replaces the identity columns, still objects', async () => {
		const before = (await sql.unsafe(
			`SELECT section_id FROM matrix_test WHERE section_tipo = $1
			 AND string->'dd1326'->0->>'value' = 'tool_scratch_probe'`,
			[TARGET.sectionTipo],
		)) as { section_id: number }[];
		const sectionId = Number(before[0]?.section_id);
		expect(Number.isFinite(sectionId)).toBe(true);

		const existing = {
			sectionId,
			record: toolRecord('tool_scratch_probe', '1.0'),
		} as unknown as RegistryRow;
		await writeRegistryRecord(
			'tool_scratch_probe',
			toolRecord('tool_scratch_probe', '2.0'),
			existing,
			{ ...TARGET },
		);

		const rows = (await sql.unsafe(
			`SELECT jsonb_typeof(string) AS string_type,
			        string->'dd1327'->0->>'value' AS version
			 FROM matrix_test WHERE section_tipo = $1 AND section_id = $2`,
			[TARGET.sectionTipo, sectionId],
		)) as { string_type: string; version: string }[];
		expect(rows[0]?.string_type).toBe('object'); // UPDATE was the live corruption mode
		expect(rows[0]?.version).toBe('2.0');
	}, 30000);

	test('keepStoredActive: the stored ACTIVE value wins; a toggle committed under the lock is not reverted', async () => {
		const found = (await sql.unsafe(
			`SELECT section_id FROM matrix_test WHERE section_tipo = $1
			 AND string->'dd1326'->0->>'value' = 'tool_scratch_probe'`,
			[TARGET.sectionTipo],
		)) as { section_id: number }[];
		const sectionId = Number(found[0]?.section_id);
		// PRECONDITION (the INSERT case planted the row): run alone (`-t keepStoredActive`)
		// this must fail HERE, by name — never proceed with a NaN section_id.
		expect(
			Number.isFinite(sectionId),
			'precondition: the tool_scratch_probe row (planted by the INSERT case) must exist',
		).toBe(true);
		const existing = {
			sectionId,
			record: toolRecord('tool_scratch_probe', '2.0'),
		} as unknown as RegistryRow;
		const activeId = async () =>
			(
				(await sql.unsafe(
					`SELECT relation->'dd1354'->0->>'section_id' AS id
					 FROM matrix_test WHERE section_tipo = $1 AND section_id = $2`,
					[TARGET.sectionTipo, sectionId],
				)) as { id: string }[]
			)[0]?.id;
		const relationWith = (id: string) => ({
			relation: { dd1354: [{ section_tipo: 'dd64', section_id: id, type: 'dd96' }] },
		});

		// An admin turned the tool off; the file still declares it on (section_id 1).
		await updateMatrixRecord(TARGET.table, TARGET.sectionTipo, sectionId, relationWith('2'));
		const record = toolRecord('tool_scratch_probe', '3.0');
		await writeRegistryRecord('tool_scratch_probe', record, existing, TARGET, {
			keepStoredActive: true,
		});
		expect(await activeId()).toBe('2');
		// the caller reports what landed (record mutated to the stored value)
		expect(
			(record.relation as Record<string, { section_id: string }[]>).dd1354?.[0]?.section_id,
		).toBe('2');

		// A toggle IN FLIGHT: a transaction holds the row (admin turns it back on)
		// while the import starts; the import waits on the lock and keeps the
		// committed value — a value read before the toggle would revert it.
		let releaseToggle: () => void = () => {};
		const toggleHeld = new Promise<void>((resolve) => {
			releaseToggle = resolve;
		});
		let toggleLocked: () => void = () => {};
		const locked = new Promise<void>((resolve) => {
			toggleLocked = resolve;
		});
		let toggleBackend = 0;
		const toggle = withTransaction(async () => {
			await updateMatrixRecord(TARGET.table, TARGET.sectionTipo, sectionId, relationWith('1'));
			const [self] = (await sql.unsafe('SELECT pg_backend_pid() AS pid', [])) as {
				pid: number;
			}[];
			toggleBackend = Number(self?.pid);
			toggleLocked();
			await toggleHeld;
		});
		await locked;
		const importing = writeRegistryRecord(
			'tool_scratch_probe',
			toolRecord('tool_scratch_probe', '3.1'),
			existing,
			TARGET,
			{ keepStoredActive: true },
		);
		// Release the toggle only once the import is PROVEN blocked behind it: another
		// backend waits on a Lock whose blocker is the toggle's backend (a row lock on
		// the matrix_test tuple surfaces as a transactionid/tuple wait on that pid).
		// A sleep proved nothing — an import that read before locking would race past.
		const deadline = Date.now() + 10_000;
		let blocked = false;
		while (!blocked) {
			const waiting = (await sql.unsafe(
				`SELECT a.pid FROM pg_stat_activity a
				 WHERE a.pid <> $1 AND a.pid <> pg_backend_pid()
				   AND a.wait_event_type = 'Lock'
				   AND $1 = ANY (pg_blocking_pids(a.pid))
				   AND a.query ILIKE '%matrix_test%'`,
				[toggleBackend],
			)) as { pid: number }[];
			blocked = waiting.length > 0;
			if (blocked) break;
			if (Date.now() > deadline) {
				releaseToggle();
				await toggle;
				await importing.catch(() => {});
				throw new Error(
					'keepStoredActive: within 10 s no backend waited on the toggle’s matrix_test row lock — the import never blocked on it (did it read the stored value before locking?)',
				);
			}
			await Bun.sleep(20);
		}
		releaseToggle();
		await toggle;
		await importing;
		expect(await activeId()).toBe('1');

		// Without the option the file's declaration lands (the widget path).
		await updateMatrixRecord(TARGET.table, TARGET.sectionTipo, sectionId, relationWith('2'));
		await writeRegistryRecord(
			'tool_scratch_probe',
			toolRecord('tool_scratch_probe', '3.2'),
			existing,
			TARGET,
		);
		expect(await activeId()).toBe('1');
	}, 30000);
});
