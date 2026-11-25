/**
 * A strict-mode MariaDB value refusal (1406 too long / 1264 out of range / 1366
 * incorrect) must reach the operator NAMED — table, column, section_id, lang and
 * the ontology's declared type — not as an untyped `diffusion.run_failed`. The
 * driver messages below are the real Bun mariadb adapter's (probed 2026-11-24).
 * Plan fabricated in full on the generic `test` TLD (no DB, no ontology read).
 */
import { describe, expect, test } from 'bun:test';
import type { FieldPlan, SectionPlan } from '../../src/diffusion/plan/types.ts';
import type { ProjectedRow } from '../../src/diffusion/project/lang_ladder.ts';
import { valueRejection } from '../../src/diffusion/targets/mariadb/db.ts';
import { rejectedValueError } from '../../src/diffusion/writers/mariadb_sql.ts';

function field(columnName: string, fieldModel: string, varcharLength?: number): FieldPlan {
	return {
		id: `test_${columnName}`,
		columnName,
		sourceChain: [],
		transform: [],
		column: { fieldModel, ...(varcharLength ? { varcharLength } : {}) },
		policy: {} as FieldPlan['policy'],
		outputFormat: 'string',
	};
}

const section: SectionPlan = {
	sectionTipo: 'test6099',
	tableName: 'zz_values',
	tableTipo: 'testT',
	fields: [field('short', 'field_varchar', 4), field('long', 'field_text')],
};
const batch: ProjectedRow[] = [
	{ sectionId: 7, lang: 'lg-spa', columns: { short: 'ok', long: 'x' } },
	{ sectionId: 8, lang: 'lg-eng', columns: { short: 'too long', long: 'y'.repeat(300) } },
];
const driverError = (errno: number, message: string) =>
	Object.assign(new Error(message), { errno });

describe('diffusion: MariaDB value refusals are named', () => {
	test('parses both driver message shapes; ignores other errors', () => {
		expect(valueRejection(driverError(1406, "Data too long for column 'v' at row 2"))).toEqual({
			errno: 1406,
			column: 'v',
			row: 2,
		});
		expect(
			valueRejection(
				driverError(1366, "Incorrect integer value: 'x' for column `db`.`zz_probe`.`id` at row 1"),
			),
		).toEqual({ errno: 1366, column: 'id', row: 1 });
		expect(valueRejection(driverError(1146, "Table 'db.t' doesn't exist"))).toBeNull();
		expect(rejectedValueError(section, batch, new Error('boom'))).toBeNull();
	});

	test('too long for the declared type → names the record, says widen the ontology field', () => {
		const error = rejectedValueError(
			section,
			batch,
			driverError(1406, "Data too long for column 'short' at row 2"),
		);
		expect(error?.code).toBe('diffusion.value_rejected');
		expect(error?.message).toContain('zz_values.short, section_id 8, lang lg-eng (8 chars)');
		expect(error?.message).toContain('declares VARCHAR(4): widen the field there');
	});

	test('declared TEXT but refused → the live column drifted; names the ALTER', () => {
		const error = rejectedValueError(
			section,
			batch,
			driverError(1406, "Data too long for column 'long' at row 2"),
		);
		expect(error?.message).toContain('declares TEXT, so the live column is older and narrower');
		expect(error?.coordinates).toMatchObject({
			table: 'zz_values',
			column: 'long',
			section_id: 8,
			errno: 1406,
		});
	});
});
