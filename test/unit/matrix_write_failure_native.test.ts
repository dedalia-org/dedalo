/**
 * WRITE-PATH PROPAGATION GATE (P3, ERRORS_SPEC §8) — the DB layer.
 *
 * CONVENTIONS §1: "write paths never absorb integrity errors". Every guard
 * in src/core/db/{matrix_write,json_codec,postgres}.ts is now a TYPED throw
 * (`internal.invariant`, the fail-loud form of the former bare
 * `throw new Error(`), and this gate proves the two things the typing must
 * not have changed:
 *
 *   1. the failure PROPAGATES out of `withTransaction` to the caller as a
 *      DedaloError (code + the old sentence as `error.message`, so the log
 *      still names module + input) — nothing between the guard and the caller
 *      catches it into a soft outcome;
 *   2. the transaction ROLLS BACK: a write that landed inside the same tx
 *      before the guard fired is gone; the scratch row is byte-unchanged.
 *
 * Plus the converter contract on these throws: `toErrorEnvelope` maps them
 * to 500 with the REGISTRY message (the sentence stays server-side), and the
 * converter has no transaction dependency (a source assertion: convert.ts
 * imports nothing from src/core/db/).
 *
 * DB writes ONLY on the matrix_test scratch surface (synthetic tipo);
 * cleaned before and after.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readMatrixRecord } from '../../src/core/db/matrix.ts';
import {
	insertMatrixRecordWithCounter,
	readMatrixKeyForUpdate,
	updateMatrixKeysData,
	updateMatrixRecord,
} from '../../src/core/db/matrix_write.ts';
import { sql, withTransaction } from '../../src/core/db/postgres.ts';
import { toErrorEnvelope } from '../../src/core/errors/convert.ts';
import { DedaloError, isDedaloError } from '../../src/core/errors/dedalo_error.ts';
import { ERROR_REGISTRY } from '../../src/core/errors/registry.ts';
import { cleanScratchRecord, cleanScratchTipo, createScratchRecord } from '../helpers/test_data.ts';

const TABLE = 'matrix_test';
const TIPO = 'zzwf1';
const SECTION_ID = 900101;
const INITIAL_STRING = { zzwf2: [{ id: 1, lang: 'lg-nolan', value: 'initial' }] };

async function currentStringText(): Promise<string | null | undefined> {
	const row = await readMatrixRecord(TABLE, TIPO, SECTION_ID);
	return row?.rawText.string;
}

async function refusalOf(run: Promise<unknown>): Promise<DedaloError> {
	try {
		await run;
	} catch (error) {
		if (isDedaloError(error)) return error;
		throw error;
	}
	throw new Error('expected a DedaloError, but the write succeeded');
}

describe('matrix_write failure propagation (write paths never absorb integrity errors)', () => {
	let initialText: string | null | undefined;

	beforeAll(async () => {
		await cleanScratchTipo(TIPO);
		await createScratchRecord(TIPO, SECTION_ID, { string: INITIAL_STRING });
		initialText = await currentStringText();
		expect(initialText).toContain('initial');
	});
	afterAll(async () => {
		await cleanScratchRecord(TIPO, SECTION_ID);
		await cleanScratchTipo(TIPO);
	});

	test('json_codec guard inside withTransaction: DedaloError propagates, the earlier write in the same tx rolls back', async () => {
		const error = await refusalOf(
			withTransaction(async () => {
				// A write that LANDS inside the tx…
				await updateMatrixRecord(TABLE, TIPO, SECTION_ID, {
					string: { zzwf2: [{ id: 1, lang: 'lg-nolan', value: 'clobbered' }] },
				});
				// …then the integrity guard fires (undefined property is not JSON).
				await updateMatrixRecord(TABLE, TIPO, SECTION_ID, {
					string: { zzwf2: [{ id: 1, value: undefined }] },
				});
			}),
		);
		expect(error.code).toBe('internal.invariant');
		expect(error.message).toContain('json_codec: undefined property');
		// ROLLBACK: the 'clobbered' write is gone; the row is byte-identical.
		expect(await currentStringText()).toBe(initialText);
	});

	test('identifier gate (tipo grammar) inside withTransaction: propagates + rolls back', async () => {
		const error = await refusalOf(
			withTransaction(async () => {
				await updateMatrixKeysData(TABLE, TIPO, SECTION_ID, [
					{ column: 'string', key: 'zzwf2', value: [{ id: 1, value: 'clobbered' }] },
				]);
				await updateMatrixKeysData(TABLE, TIPO, SECTION_ID, [
					{ column: 'string', key: 'not a tipo', value: [] },
				]);
			}),
		);
		expect(error.code).toBe('internal.invariant');
		expect(error.message).toContain('updateMatrixKeysData: key');
		expect(error.coordinates?.table).toBe(TABLE);
		expect(await currentStringText()).toBe(initialText);
	});

	test('a create inside a failing tx leaves NO row and NO counter row', async () => {
		const createdTipo = 'zzwf3';
		await cleanScratchTipo(createdTipo);
		let created = 0;
		const error = await refusalOf(
			withTransaction(async () => {
				created = await insertMatrixRecordWithCounter(TABLE, createdTipo, {
					string: { zzwf2: [{ id: 1, value: 'born' }] },
				});
				await updateMatrixRecord(TABLE, createdTipo, created, {} as never);
			}),
		);
		expect(error.code).toBe('internal.invariant');
		expect(error.message).toBe('updateMatrixRecord: empty values payload');
		expect(created).toBeGreaterThan(0);
		expect(await readMatrixRecord(TABLE, createdTipo, created)).toBeNull();
		const counters = (await sql`SELECT value FROM matrix_counter WHERE tipo = ${createdTipo}`) as {
			value: number;
		}[];
		expect(counters).toEqual([]);
	});

	test('the tx guards themselves are typed (readMatrixKeyForUpdate outside a transaction)', async () => {
		const error = await refusalOf(
			readMatrixKeyForUpdate(TABLE, TIPO, SECTION_ID, 'string', 'zzwf2'),
		);
		expect(error.code).toBe('internal.invariant');
		expect(error.message).toMatch(/FOR NO KEY UPDATE outside a transaction/);
	});

	test('the converter keeps the sentence server-side: 500 + registry message on the wire', () => {
		const error = new DedaloError('internal.invariant', {
			message: 'json_codec: undefined property at $.x — secret coordinates',
			coordinates: { table: TABLE },
		});
		const envelope = toErrorEnvelope(error, { requestId: 'wf-test' });
		expect(envelope.status).toBe(500);
		expect(envelope.body.ok).toBe(false);
		expect(envelope.body.error.code).toBe('internal.invariant');
		expect(envelope.body.error.message).toBe(ERROR_REGISTRY['internal.invariant'].message);
		// Outside the DEDALO_DEBUG_API_ERRORS block (operator opt-in, the ONE
		// place the exception text may appear) the sentence is nowhere on the wire.
		const { debug: _debug, ...wireError } = envelope.body.error as Record<string, unknown>;
		expect(JSON.stringify({ ...envelope.body, error: wireError })).not.toContain(
			'secret coordinates',
		);
	});

	test('the converter has NO transaction dependency (convert.ts imports nothing from src/core/db/)', () => {
		const source = readFileSync(join(import.meta.dir, '../../src/core/errors/convert.ts'), 'utf8');
		const imports = source.match(/^import[^\n]*from '[^']+'/gm) ?? [];
		expect(imports.length).toBeGreaterThan(0);
		for (const line of imports) {
			expect(line).not.toMatch(/\/db\//);
			expect(line).not.toMatch(/postgres\.ts/);
		}
		// And the leaf the write path throws through imports only the registry.
		const leaf = readFileSync(
			join(import.meta.dir, '../../src/core/errors/dedalo_error.ts'),
			'utf8',
		);
		const leafImports = leaf.match(/^import[^\n]*from '[^']+'/gm) ?? [];
		expect(leafImports).toEqual([
			"import { ERROR_REGISTRY, type ErrorCode, type ErrorSpec, specOf } from './registry.ts'",
		]);
	});
});
