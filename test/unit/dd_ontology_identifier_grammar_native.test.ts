/**
 * SURF-1 write (G3) — dd_ontology's IDENTIFIER COLUMNS OBEY ONE GRAMMAR, AT
 * EVERY DOOR, AND THE DATABASE AGREES.
 *
 * WHAT WAS WRONG. dd_ontology's `tipo`, `parent`, `model_tipo`, `tld` and
 * `properties.alias_of` are read back as IDENTIFIERS — interpolated into JSONB
 * paths and SQL by the search engine, walked as tree edges, joined as model
 * nodes. Nothing checked them on the way IN: `upsertDdOntologyNode` and
 * `updateDdOntologyColumns` bound whatever string they were handed (and the
 * update door's INSERT fallback planted a partial row for a tipo that did not
 * exist), the archive restore and the recovery slice copied rows through
 * unchecked, and the table had no CHECK — a raw INSERT of `tipo = "zz1'"`
 * landed.
 *
 * THE CONTRACT (CLOSURE_PLAN Step 4, SURF-1 write — W1/W2/W3/W4/W7/W8):
 *  - ONE pure predicate, `ddOntologyIdentifierViolations(row)` →
 *    `{column, value, reason}[]`, with `column` one of the six truth-table
 *    columns below; `DD_ONTOLOGY_IDENTIFIER_LIMITS` = the varchar lengths;
 *  - both write doors run it before any SQL and refuse `ontology.invalid_node`;
 *    the update door no longer INSERTs (absent → false, no row);
 *  - a 23514 on a grammar constraint (or a 22001) is converted, typed, with
 *    `coordinates.constraint` — the path a NOT VALID legacy row takes when an
 *    UPDATE of an unrelated column re-checks it;
 *  - the recovery slice skips violators and REPORTS them
 *    (`createRecoverySlice(tlds)` → `{created, skipped}`);
 *  - the archive restore refuses a violating row at PLAN time (`archive.refused`),
 *    before anything is written;
 *  - the migration `*_dd_ontology_identifier_grammar.sql` adds the six CHECKs
 *    NOT VALID.
 *
 * THE TRUTH TABLE is the heart of the gate: each cell is a hand-written verdict
 * and must hold in THREE places — (a) the TS predicate, (b) a raw INSERT with
 * that column's CHECK present (23514 naming the constraint, or 22001 for an
 * over-length value), (c) the doors with every CHECK dropped (so the door is
 * the only guard). One grammar, three enforcement points, no drift between
 * them. Floor: ≥5 accepted and ≥10 refused cells per column.
 *
 * EVERYTHING RUNS INSIDE TRANSACTIONS THAT END IN A SENTINEL THROW (DDL
 * included): nothing this file plants, drops or re-adds survives it. Scratch
 * tld `zzgram`.
 *
 * MUTATIONS (each must turn this gate red): remove the upsert check / the
 * update check; remove the converter; restore the INSERT fallback; loosen the
 * migration regex (drop `$`), loosen TIPO_PATTERN, or drop one constraint from
 * the migration; set the `model_tipo` limit to 32; remove the slice filter
 * (→ 23514 on the CHECK the slice copies); widen the converter to any 23514,
 * or drop its 22001 branch (the probe-table leg); drop the alias_of length
 * bound from the predicate or the migration (the 33-character alias_of cell).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { extractArchive } from '../../src/core/archive/extract.ts';
import { restoreArchive } from '../../src/core/archive/restore.ts';
import * as ddOntology from '../../src/core/db/dd_ontology.ts';
import {
	type DdOntologyNode,
	updateDdOntologyColumns,
	upsertDdOntologyNode,
} from '../../src/core/db/dd_ontology.ts';
import { sql, sqlStateOf, withTransaction } from '../../src/core/db/postgres.ts';
import { isDedaloError } from '../../src/core/errors/index.ts';
import { clearAliasCaches } from '../../src/core/ontology/alias.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import { ensureSituation, situation } from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import { resetMediaRoot } from '../helpers/media_scratch_root.ts';
import { MIGRATIONS_DIR, migrationFileNames } from '../helpers/migrations_corpus.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const TLD = 'zzgram';
const MIGRATION_SUFFIX = '_dd_ontology_identifier_grammar.sql';
const SCRATCH = scratchDir('surf1_grammar');

/** The six columns of the law and the CHECK that enforces each (hand-written, not imported). */
const CONSTRAINT_OF = {
	tipo: 'dd_ontology_tipo_grammar',
	parent: 'dd_ontology_parent_grammar',
	model_tipo: 'dd_ontology_model_tipo_grammar',
	tld: 'dd_ontology_tld_grammar',
	tipo_in_tld: 'dd_ontology_tipo_in_tld',
	alias_of: 'dd_ontology_alias_of_grammar',
} as const;
type LawColumn = keyof typeof CONSTRAINT_OF;
const LAW_COLUMNS = Object.keys(CONSTRAINT_OF) as LawColumn[];
const ALL_CONSTRAINTS: string[] = Object.values(CONSTRAINT_OF);

/** The varchar lengths as the schema declares them (the limits leg re-reads them live). */
const EXPECTED_LIMITS = { tipo: 32, parent: 32, model_tipo: 8, tld: 32 };

// ── future exports (SURF-1 not landed ⇒ a named, loud red — never a link error) ──

interface Violation {
	column: string;
	value: unknown;
	reason: string;
}
function surfExport<T>(name: string): T {
	const value = (ddOntology as unknown as Record<string, unknown>)[name];
	if (value === undefined) {
		throw new Error(`SURF-1 not landed: src/core/db/dd_ontology.ts exports no '${name}'`);
	}
	return value as T;
}
const violationsOf = (row: Partial<DdOntologyNode>): Violation[] =>
	surfExport<(row: Partial<DdOntologyNode>) => Violation[]>('ddOntologyIdentifierViolations')(row);

/**
 * The grammar migration(s), located by stable suffix (the integrator assigns the
 * number) in the boot migrations corpus — the one lister that owns the root.
 */
const GRAMMAR_MIGRATIONS = migrationFileNames().filter((name) => name.endsWith(MIGRATION_SUFFIX));

/** The migration text. Exactly one file may carry the suffix (the floor test pins it). */
function grammarMigrationText(): string {
	const [file] = GRAMMAR_MIGRATIONS;
	if (file === undefined) {
		throw new Error(
			`SURF-1 not landed: no install/db/migrations/*${MIGRATION_SUFFIX} — dd_ontology has no identifier CHECK`,
		);
	}
	return readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
}

// ── the rolled-back transaction ────────────────────────────────────────────

const ROLLBACK = new Error('dd_ontology_identifier_grammar: sentinel rollback');

async function clearCaches(): Promise<void> {
	clearAliasCaches();
	await clearOntologyDerivedCaches();
}

async function checkNames(): Promise<string[]> {
	const rows = (await sql.unsafe(
		`SELECT conname FROM pg_constraint WHERE conrelid = 'dd_ontology'::regclass AND contype = 'c' ORDER BY conname`,
	)) as { conname: string }[];
	return rows.map((row) => row.conname);
}

async function dropChecks(keep: readonly string[] = []): Promise<void> {
	for (const name of await checkNames()) {
		if (keep.includes(name)) continue;
		if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`unexpected constraint name ${name}`);
		await sql.unsafe(`ALTER TABLE dd_ontology DROP CONSTRAINT "${name}"`);
	}
}

/** `work` inside ONE transaction that never commits. Caches are cleared OUTSIDE it (S1-14). */
async function rolledBack(work: () => Promise<void>): Promise<void> {
	await assertTestDatabase('dd_ontology_identifier_grammar_native');
	await clearCaches();
	try {
		await withTransaction(async () => {
			await dropChecks();
			await work();
			throw ROLLBACK;
		});
	} catch (error) {
		if (error !== ROLLBACK) throw error;
	} finally {
		await clearCaches();
	}
}

/** Run `step` under a savepoint and always roll back to it; return its summary. */
async function underSavepoint(step: () => Promise<string>): Promise<string> {
	await sql.unsafe('SAVEPOINT g3_cell');
	try {
		return await step();
	} catch (error) {
		if (isDedaloError(error)) return `refused:${error.code}`;
		const state = sqlStateOf(error);
		if (state === undefined) throw error;
		const constraint = (error as { constraint?: unknown }).constraint;
		return typeof constraint === 'string' && constraint !== '' ? `${state}:${constraint}` : state;
	} finally {
		await sql.unsafe('ROLLBACK TO SAVEPOINT g3_cell');
	}
}

// ── the truth table ────────────────────────────────────────────────────────

const BASE: DdOntologyNode = {
	tipo: 'zzgram1',
	parent: null,
	term: { 'lg-eng': 'SURF-1 grammar cell' },
	model: 'component_input_text',
	order_number: 1,
	relations: null,
	tld: TLD,
	properties: null,
	model_tipo: 'dd9',
	is_model: false,
	is_translatable: false,
	is_main: false,
	propiedades: null,
};

interface Cell {
	label: string;
	row: Partial<DdOntologyNode>;
	accept: boolean;
	/** The raw INSERT fails on the varchar length (22001), before any CHECK. */
	overLength?: boolean;
}

const q = JSON.stringify;
const TIPO_32 = `zzgram${'1'.repeat(26)}`;
const TIPO_33 = `zzgv${'1'.repeat(29)}`;
const LETTERS_30 = 'zzgramzzgramzzgramzzgramzzgram';

const tipoCell = (tipo: string, accept: boolean, overLength = false): Cell => ({
	label: q(tipo),
	row: { tipo, tld: null },
	accept,
	overLength,
});
const parentCell = (parent: string | null, accept: boolean, overLength = false): Cell => ({
	label: q(parent),
	row: { parent },
	accept,
	overLength,
});
const modelTipoCell = (modelTipo: string | null, accept: boolean, overLength = false): Cell => ({
	label: q(modelTipo),
	row: { model_tipo: modelTipo },
	accept,
	overLength,
});
const tldCell = (tld: string | null, accept: boolean, overLength = false): Cell => ({
	label: q(tld),
	// A letters-only tld owns the tipo `<tld>1`, so an ACCEPTED cell is a wholly valid row.
	row: {
		tld,
		tipo: tld !== null && /^[a-z]+$/.test(tld) && tld.length < 32 ? `${tld}1` : 'zzgram1',
	},
	accept,
	overLength,
});
const pairCell = (tipo: string, tld: string | null, accept: boolean): Cell => ({
	label: `${tipo} in ${q(tld)}`,
	row: { tipo, tld },
	accept,
});
const aliasCell = (properties: unknown, accept: boolean): Cell => ({
	label: q(properties),
	row: { properties: properties as DdOntologyNode['properties'] },
	accept,
});

const TABLE: Record<LawColumn, Cell[]> = {
	tipo: [
		tipoCell('zzgram2', true),
		tipoCell('zzgram42', true),
		tipoCell('a1', true),
		tipoCell('zzgramb7', true),
		tipoCell(TIPO_32, true),
		tipoCell('', false),
		tipoCell('zzgv', false),
		tipoCell('1zz', false),
		tipoCell('Zz1', false),
		tipoCell('zzgv1 ', false),
		tipoCell('zzgv1\n', false),
		tipoCell('zzgv1\r', false),
		tipoCell("zzgv1'", false),
		tipoCell('zzgv-1', false),
		tipoCell('zzgv_1', false),
		tipoCell('ｚｚ1', false),
		tipoCell('zzgv١', false),
		tipoCell('ǆ1', false),
		tipoCell('zzgv1a', false),
		tipoCell(TIPO_33, false, true),
	],
	parent: [
		parentCell(null, true),
		parentCell('zzgram0', true),
		parentCell('dd1', true),
		parentCell('a1', true),
		parentCell(TIPO_32, true),
		parentCell('', false),
		parentCell('zzgv', false),
		parentCell('1zz', false),
		parentCell('Zz1', false),
		parentCell('zzgv1 ', false),
		parentCell('zzgv1\n', false),
		parentCell("zzgv1'", false),
		parentCell("zzgv1' OR '1", false),
		parentCell('zzgv-1', false),
		parentCell('zzgv_1', false),
		parentCell('ｚｚ1', false),
		parentCell('zzgv١', false),
		parentCell(TIPO_33, false, true),
	],
	model_tipo: [
		modelTipoCell(null, true),
		modelTipoCell('dd9', true),
		modelTipoCell('dd1234', true),
		modelTipoCell('a1', true),
		modelTipoCell('dddd1234', true),
		modelTipoCell('', false),
		modelTipoCell('dd', false),
		modelTipoCell('DD9', false),
		modelTipoCell('dd9 ', false),
		modelTipoCell("dd9'", false),
		modelTipoCell('dd-9', false),
		modelTipoCell('dd_9', false),
		modelTipoCell('ｄｄ9', false),
		modelTipoCell('dd٩', false),
		modelTipoCell('dd9\n', false),
		modelTipoCell('ǆ9', false),
		modelTipoCell('ddddd1234', false, true),
	],
	tld: [
		tldCell(null, true),
		tldCell('zzgv', true),
		tldCell(TLD, true),
		tldCell('zzgvq', true),
		tldCell(LETTERS_30, true),
		tldCell('', false),
		tldCell('z', false),
		tldCell('Zz', false),
		tldCell('zzgv1', false),
		tldCell('zzgv ', false),
		tldCell('zzgv\n', false),
		tldCell("zzgv'", false),
		tldCell('zzgv-x', false),
		tldCell('zzgv_x', false),
		tldCell('ｚｚ', false),
		tldCell('ǆz', false),
		tldCell('a'.repeat(33), false, true),
	],
	tipo_in_tld: [
		pairCell('zzgram1', TLD, true),
		pairCell('zzgram1', null, true),
		pairCell('zzgramb1', 'zzgramb', true),
		pairCell('zzgvq1', 'zzgvq', true),
		pairCell('ab1', 'ab', true),
		pairCell('zzgram1', 'zzgv', false),
		pairCell('zzgram1', 'zzg', false),
		pairCell('zzgram1', 'zzgr', false),
		pairCell('zzgram1', 'zzgra', false),
		pairCell('zzgram1', 'zzgramm', false),
		pairCell('zzgram1', 'dd', false),
		pairCell('dd1', TLD, false),
		pairCell('zzgramb1', TLD, false),
		pairCell('zzgv1', TLD, false),
		pairCell('ab1', 'ba', false),
	],
	alias_of: [
		aliasCell(null, true),
		aliasCell({}, true),
		aliasCell({ view: 'line' }, true),
		aliasCell({ alias_of: 'zzgram2' }, true),
		aliasCell({ alias_of: 'a1' }, true),
		// An alias target is a tipo: the same 32-character bound as the tipo column
		// (jsonb has no varchar, so the CHECK itself carries the bound → 23514, not 22001).
		aliasCell({ alias_of: TIPO_32 }, true),
		aliasCell({ alias_of: TIPO_33 }, false),
		aliasCell([], true),
		aliasCell({ alias_of: null }, false),
		aliasCell({ alias_of: 5 }, false),
		aliasCell({ alias_of: [] }, false),
		aliasCell({ alias_of: ['zzgram2'] }, false),
		aliasCell({ alias_of: {} }, false),
		aliasCell({ alias_of: '' }, false),
		aliasCell({ alias_of: 'ZZ1' }, false),
		aliasCell({ alias_of: 'zzgv1 ' }, false),
		aliasCell({ alias_of: "zzgv1'" }, false),
		aliasCell({ alias_of: 'zzgv-1' }, false),
		aliasCell({ alias_of: 'zzgv1\n' }, false),
		aliasCell({ alias_of: 'section_id' }, false),
	],
};

const rowOf = (cell: Cell): DdOntologyNode => ({ ...BASE, ...cell.row });

async function rawInsert(row: DdOntologyNode): Promise<void> {
	const json = (value: unknown) =>
		value === null || value === undefined ? null : JSON.stringify(value);
	await sql.unsafe(
		`INSERT INTO dd_ontology (tipo, parent, term, model, order_number, relations, tld, properties,
		   model_tipo, is_model, is_translatable, is_main, propiedades)
		 VALUES ($1, $2, $3::text::jsonb, $4, $5, $6::text::jsonb, $7, $8::text::jsonb, $9, false, false, false, NULL)`,
		[
			row.tipo,
			row.parent,
			json(row.term),
			row.model,
			row.order_number,
			json(row.relations),
			row.tld,
			json(row.properties),
			row.model_tipo,
		],
	);
}

async function landed(tipo: string): Promise<boolean> {
	const rows = (await sql.unsafe('SELECT 1 FROM dd_ontology WHERE tipo = $1', [tipo])) as unknown[];
	return rows.length > 0;
}

/** What each enforcement point must answer for one cell. */
function expectedFor(column: LawColumn, cell: Cell): Record<string, string> {
	const out: Record<string, string> = {
		ts: cell.accept ? 'accept' : 'refuse',
		raw: cell.accept ? 'ok' : cell.overLength ? '22001' : `23514:${CONSTRAINT_OF[column]}`,
		upsert: cell.accept ? 'landed' : 'refused:ontology.invalid_node',
	};
	if (column === 'tipo')
		out.update = cell.accept ? 'returned:false' : 'refused:ontology.invalid_node';
	if (column === 'parent')
		out.update = cell.accept ? 'returned:true' : 'refused:ontology.invalid_node';
	return out;
}

function tsVerdict(column: LawColumn, cell: Cell): string {
	try {
		return violationsOf(rowOf(cell)).some((violation) => violation.column === column)
			? 'refuse'
			: 'accept';
	} catch (error) {
		return `threw: ${(error as Error).message}`;
	}
}

describe('SURF-1 — the grammar migration is found through the boot migrations corpus', () => {
	test('the corpus names exactly one identifier-grammar migration', () => {
		expect(GRAMMAR_MIGRATIONS.length).toBeGreaterThan(0);
		expect(GRAMMAR_MIGRATIONS).toHaveLength(1);
	});
});

describe.if(DB_READY)('SURF-1 write — dd_ontology identifier grammar (G3)', () => {
	beforeAll(() => rmSync(SCRATCH, { recursive: true, force: true }));
	afterAll(async () => {
		rmSync(SCRATCH, { recursive: true, force: true });
		const left = (await sql.unsafe('SELECT count(*)::int AS n FROM dd_ontology WHERE tld = $1', [
			TLD,
		])) as { n: number }[];
		expect(left[0]?.n).toBe(0);
	});

	test('floor: every column carries >=5 accepted and >=10 refused cells', () => {
		expect(LAW_COLUMNS.length).toBe(6);
		for (const column of LAW_COLUMNS) {
			expect(TABLE[column].filter((cell) => cell.accept).length).toBeGreaterThanOrEqual(5);
			expect(TABLE[column].filter((cell) => !cell.accept).length).toBeGreaterThanOrEqual(10);
		}
	});

	test('limits: DD_ONTOLOGY_IDENTIFIER_LIMITS = the live varchar lengths', async () => {
		const rows = (await sql.unsafe(
			`SELECT column_name, character_maximum_length AS max FROM information_schema.columns
			  WHERE table_name = 'dd_ontology' AND column_name IN ('tipo','parent','model_tipo','tld')`,
		)) as { column_name: string; max: number }[];
		const live = Object.fromEntries(rows.map((row) => [row.column_name, Number(row.max)]));
		expect(live).toEqual(EXPECTED_LIMITS);
		expect(surfExport<Record<string, number>>('DD_ONTOLOGY_IDENTIFIER_LIMITS')).toEqual(live);
	});

	test('the migration adds exactly the six CHECKs, NOT VALID, and the TS list names them', async () => {
		const text = grammarMigrationText();
		let added: { conname: string; convalidated: boolean }[] = [];
		await rolledBack(async () => {
			await sql.unsafe(text);
			added = (await sql.unsafe(
				`SELECT conname, convalidated FROM pg_constraint
				  WHERE conrelid = 'dd_ontology'::regclass AND contype = 'c' ORDER BY conname`,
			)) as typeof added;
		});
		expect(added.map((row) => row.conname)).toEqual([...ALL_CONSTRAINTS].sort());
		expect(added.every((row) => row.convalidated === false)).toBe(true);
		expect([...surfExport<readonly string[]>('DD_ONTOLOGY_GRAMMAR_CONSTRAINTS')].sort()).toEqual(
			[...ALL_CONSTRAINTS].sort(),
		);
	});

	test('TRUTH TABLE: predicate = CHECK = door, cell by cell', async () => {
		const observed: Record<string, Record<string, string>> = {};
		const expected: Record<string, Record<string, string>> = {};
		for (const column of LAW_COLUMNS) {
			for (const cell of TABLE[column]) {
				const key = `${column} ${cell.label}`;
				expected[key] = expectedFor(column, cell);
				observed[key] = { ts: tsVerdict(column, cell) };
			}
		}
		// (b) raw INSERT — only THIS column's CHECK present, so the named constraint is the one that fires.
		let migration: string | null = null;
		try {
			migration = grammarMigrationText();
		} catch (error) {
			for (const key of Object.keys(observed)) {
				(observed[key] as Record<string, string>).raw = (error as Error).message;
			}
		}
		if (migration !== null) {
			const text = migration;
			await rolledBack(async () => {
				await sql.unsafe(text);
				for (const column of LAW_COLUMNS) {
					for (const cell of TABLE[column]) {
						(observed[`${column} ${cell.label}`] as Record<string, string>).raw =
							await underSavepoint(async () => {
								await dropChecks([CONSTRAINT_OF[column]]);
								await rawInsert(rowOf(cell));
								return 'ok';
							});
					}
				}
			});
		}
		// (c) the doors — every CHECK dropped, so the door is the only guard.
		await rolledBack(async () => {
			await rawInsert(BASE); // the row the parent-update cells SET into
			for (const column of LAW_COLUMNS) {
				for (const cell of TABLE[column]) {
					const summary = observed[`${column} ${cell.label}`] as Record<string, string>;
					const row = rowOf(cell);
					summary.upsert = await underSavepoint(async () => {
						await upsertDdOntologyNode(row);
						return (await landed(row.tipo)) ? 'landed' : 'returned-without-row';
					});
					if (column === 'tipo') {
						summary.update = await underSavepoint(
							async () =>
								`returned:${await updateDdOntologyColumns(row.tipo, { order_number: 7 })}`,
						);
					}
					if (column === 'parent') {
						summary.update = await underSavepoint(
							async () =>
								`returned:${await updateDdOntologyColumns(BASE.tipo, { parent: row.parent })}`,
						);
					}
				}
			}
		});
		expect(Object.keys(observed).length).toBeGreaterThan(90);
		expect(observed).toEqual(expected);
	});

	test('update of an ABSENT tipo answers false and inserts nothing (the fallback is gone)', async () => {
		let answer: unknown = null;
		let rowCount = -1;
		await rolledBack(async () => {
			answer = await updateDdOntologyColumns('zzgram77', { order_number: 3, parent: 'zzgram1' });
			const rows = (await sql.unsafe(
				"SELECT 1 FROM dd_ontology WHERE tipo = 'zzgram77'",
			)) as unknown[];
			rowCount = rows.length;
		});
		expect({ answer, rowCount }).toEqual({ answer: false, rowCount: 0 });
	});

	test('converter: a NOT VALID legacy row re-checked by an order_number UPDATE refuses TYPED', async () => {
		const text = grammarMigrationText();
		let outcome: Record<string, unknown> = {};
		await rolledBack(async () => {
			await rawInsert({ ...BASE, tipo: 'zzgram5', parent: "zzgram1'" });
			await sql.unsafe(text); // NOT VALID: the legacy row stays, every write of it is re-checked
			await sql.unsafe('SAVEPOINT g3_conv');
			try {
				await updateDdOntologyColumns('zzgram5', { order_number: 2 });
				outcome = { returned: true };
			} catch (error) {
				outcome = isDedaloError(error)
					? { code: error.code, constraint: error.coordinates?.constraint }
					: { untyped: sqlStateOf(error) ?? String(error) };
			} finally {
				await sql.unsafe('ROLLBACK TO SAVEPOINT g3_conv');
			}
		});
		expect(outcome).toEqual({
			code: 'ontology.invalid_node',
			constraint: CONSTRAINT_OF.parent,
		});
	});

	test('converter: ONLY a grammar 23514 or a 22001 is typed — any other database failure passes through', async () => {
		type Refusal = (
			error: unknown,
			tipo: unknown,
		) => {
			code: string;
			coordinates?: Record<string, unknown>;
		} | null;
		const refusal = surfExport<Refusal>('ddOntologyConstraintRefusal');
		const verdicts: Record<string, string> = {};
		await rolledBack(async () => {
			// Real PostgreSQL errors, raised on a probe table: a varchar overflow, a CHECK
			// that is NOT one of the six, a unique violation.
			await sql.unsafe(
				`CREATE TEMP TABLE g3_converter_probe (
				   v varchar(2), n int CONSTRAINT g3_converter_other_check CHECK (n > 0), u int UNIQUE
				 ) ON COMMIT DROP`,
			);
			const verdict = async (label: string, statement: string) => {
				await sql.unsafe('SAVEPOINT g3_probe');
				try {
					await sql.unsafe(statement);
					verdicts[label] = 'no error';
				} catch (error) {
					const typed = refusal(error, 'zzgram9');
					verdicts[label] =
						typed === null
							? `passed:${sqlStateOf(error)}`
							: `typed:${typed.code}:${String(typed.coordinates?.constraint)}`;
				} finally {
					await sql.unsafe('ROLLBACK TO SAVEPOINT g3_probe');
				}
			};
			await verdict('length', `INSERT INTO g3_converter_probe (v, n, u) VALUES ('abc', 1, 1)`);
			await verdict('other_check', `INSERT INTO g3_converter_probe (v, n, u) VALUES ('a', 0, 1)`);
			await verdict(
				'unique',
				`INSERT INTO g3_converter_probe (v, n, u) VALUES ('a', 1, 1), ('b', 1, 1)`,
			);
		});
		expect(verdicts).toEqual({
			length: 'typed:ontology.invalid_node:column_length',
			other_check: 'passed:23514',
			unique: 'passed:23505',
		});
	});

	test('recovery slice: a violator is skipped AND reported; the slice loads under the copied CHECKs', async () => {
		const createSlice = ddOntology.createRecoverySlice as (
			tlds: readonly string[],
		) => Promise<unknown>;
		let bare: unknown = null;
		let bareSliceRows = -1;
		let checked: unknown = null;
		const migration = grammarMigrationText();
		await rolledBack(async () => {
			await rawInsert({ ...BASE, tipo: 'zzgram7', parent: "zzgram'1" });
			await rawInsert({ ...BASE, tipo: 'zzgram8' });
			// (1) no CHECK anywhere: the TS filter alone keeps the violator out.
			bare = await createSlice([TLD]);
			const rows = (await sql.unsafe('SELECT tipo FROM dd_ontology_recovery ORDER BY tipo')) as {
				tipo: string;
			}[];
			bareSliceRows = rows.length;
			// (2) CHECKs present (NOT VALID): LIKE … INCLUDING ALL copies them, validated,
			// onto the slice — the load succeeds only because the violator is filtered.
			await sql.unsafe(migration);
			await sql.unsafe('SAVEPOINT g3_slice');
			try {
				checked = await createSlice([TLD]);
			} catch (error) {
				checked = { failed: sqlStateOf(error) ?? String(error) };
			} finally {
				await sql.unsafe('ROLLBACK TO SAVEPOINT g3_slice');
			}
		});
		expect(bare).toEqual({ created: true, skipped: ['zzgram7'] });
		expect(bareSliceRows).toBe(1);
		expect(checked).toEqual({ created: true, skipped: ['zzgram7'] });
	});

	test('archive restore: a violating row is refused at PLAN time; nothing is written — the same archive with a valid parent restores', async () => {
		const validDir = join(SCRATCH, 'archive_valid');
		const hostileDir = join(SCRATCH, 'archive_hostile');
		const mediaRoot = resetMediaRoot(join(SCRATCH, 'media_root'));
		const SECTION = 'zzgram90';
		const HOSTILE_PARENT = "test1' OR '1'='1";
		let refused: Record<string, unknown> = {};
		let refusedAfter: Record<string, number> = {};
		let control: Record<string, unknown> = {};
		let controlAfter: Record<string, number> = {};
		const destinationCounts = async (): Promise<Record<string, number>> => {
			// A plan-time refusal leaves the transaction usable; an SQL failure
			// mid-write aborts it, and says so.
			try {
				const counts = (await sql.unsafe(
					`SELECT (SELECT count(*)::int FROM dd_ontology WHERE tld = $1) AS nodes,
					        (SELECT count(*)::int FROM matrix_test WHERE section_tipo = $2) AS records`,
					[TLD, SECTION],
				)) as { nodes: number; records: number }[];
				return { ...(counts[0] as { nodes: number; records: number }) };
			} catch (error) {
				return { aborted_transaction: Number(sqlStateOf(error) ?? -1) };
			}
		};
		const restoreOutcome = async (archiveDir: string): Promise<Record<string, unknown>> => {
			try {
				await restoreArchive({ archiveDir, userId: 1, mediaRoot });
				return { restored: true };
			} catch (error) {
				if (!isDedaloError(error)) return { untyped: sqlStateOf(error) ?? String(error) };
				const coordinates = (error.coordinates ?? {}) as Record<string, unknown>;
				return { code: error.code, tipo: coordinates.tipo, violations: coordinates.violations };
			}
		};
		await rolledBack(async () => {
			await ensureSituation(
				situation({
					tld: TLD,
					name: 'SURF-1 archive leg',
					nodes: [
						{ tipo: SECTION, model: 'section' },
						{ tipo: 'zzgram91', parent: SECTION, model: 'component_input_text' },
					],
					records: [
						{
							section_tipo: SECTION,
							section_id: 1,
							columns: { string: { zzgram91: [{ id: 1, lang: 'lg-nolan', value: 'x' }] } },
						},
					],
				}),
			);
			// The SAME section archived twice: once as built (grammar-valid), once
			// after its parent was planted hostile — the only difference.
			await extractArchive({ sectionTipos: [SECTION], outDir: validDir, mediaRoot });
			await sql.unsafe('UPDATE dd_ontology SET parent = $1 WHERE tipo = $2', [
				HOSTILE_PARENT,
				SECTION,
			]);
			await extractArchive({ sectionTipos: [SECTION], outDir: hostileDir, mediaRoot });
			// The destination as a fresh install sees it: neither the nodes nor the record.
			await sql.unsafe(`DELETE FROM matrix_test WHERE section_tipo = $1`, [SECTION]);
			await sql.unsafe(`DELETE FROM dd_ontology WHERE tld = $1`, [TLD]);
			await sql.unsafe('SAVEPOINT g3_archive');
			refused = await restoreOutcome(hostileDir);
			// Counted BEFORE rolling back to the savepoint — after it, "nothing
			// written" would be true of any outcome.
			refusedAfter = await destinationCounts();
			await sql.unsafe('ROLLBACK TO SAVEPOINT g3_archive');
			// CONTROL: the grammar-valid twin restores — so the refusal above is
			// attributable to the grammar alone, not to any other plan-time refusal.
			control = await restoreOutcome(validDir);
			controlAfter = await destinationCounts();
		});
		expect(refused).toEqual({
			code: 'archive.refused',
			tipo: JSON.stringify(SECTION),
			violations: 'parent:grammar',
		});
		expect(refusedAfter).toEqual({ nodes: 0, records: 0 });
		expect(control).toEqual({ restored: true });
		expect(controlAfter.records).toBe(1);
		expect(controlAfter.nodes).toBeGreaterThanOrEqual(2);
	});
});
