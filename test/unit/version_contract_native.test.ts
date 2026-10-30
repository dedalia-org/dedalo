/**
 * THE VERSION CONTRACT (src/core/update/version_contract.ts; update design §1,
 * owner decisions D-2 / D-4): the data model of a version, and whether an
 * exported ontology may be imported — proven on planted catalogs, plus the
 * shipped catalog's own reading.
 */

import { describe, expect, test } from 'bun:test';
import type { ReleasePlan } from '../../src/core/update/catalog_file.ts';
import { DATA_LINE_START, DEDALO_DATA_VERSION } from '../../src/core/update/version.ts';
import { dataModelOf, ontologyCompatibility } from '../../src/core/update/version_contract.ts';

/** A planted catalog: version → compat (null = code-only). */
function plans(
	entries: Record<string, 'compatible' | 'incompatible' | null>,
): Record<string, ReleasePlan> {
	return Object.fromEntries(
		Object.entries(entries).map(([version, compat]) => [
			version,
			{ version, compat, steps: [{ kind: 'code' }], declared: compat !== null },
		]),
	);
}

const LINE = [7, 0, 0];
const CATALOG = plans({
	'7.0.1': null,
	'7.0.2': 'compatible',
	'7.1.0': 'incompatible',
	'7.1.1': null,
	'7.2.0': 'incompatible',
});

describe('dataModelOf: the newest incompatible release at or below the version', () => {
	test('the line start until the first incompatible release; then that release', () => {
		expect(dataModelOf([7, 0, 0], CATALOG, LINE)).toEqual([7, 0, 0]);
		expect(dataModelOf([7, 0, 2], CATALOG, LINE)).toEqual([7, 0, 0]);
		expect(dataModelOf([7, 1, 0], CATALOG, LINE)).toEqual([7, 1, 0]);
		expect(dataModelOf([7, 1, 1], CATALOG, LINE)).toEqual([7, 1, 0]);
		expect(dataModelOf([7, 2, 0], CATALOG, LINE)).toEqual([7, 2, 0]);
	});

	test('above every known release, or below the line: unknown (null) — never guessed', () => {
		expect(dataModelOf([7, 2, 1], CATALOG, LINE)).toBeNull();
		expect(dataModelOf([8, 0, 0], CATALOG, LINE)).toBeNull();
		expect(dataModelOf([6, 9, 9], CATALOG, LINE)).toBeNull();
	});

	test('the shipped catalog reads the code data version on a known model', () => {
		expect(dataModelOf(DEDALO_DATA_VERSION)).not.toBeNull();
		expect(dataModelOf(DATA_LINE_START)).toEqual([...DATA_LINE_START]);
	});
});

describe('ontologyCompatibility: one data model for the ontology, the code and the database', () => {
	const check = (ontology: string | null, installed: number[], code: number[]) =>
		ontologyCompatibility(ontology, installed, code, CATALOG, LINE);

	test('same model: compatible, even across builds and patches (D-4)', () => {
		const ok = check('7.0.2', [7, 0, 0], [7, 0, 0]);
		expect(ok.ok).toBe(true);
		expect(ok.refusal).toBeNull();
		expect(check('7.1.0', [7, 1, 0], [7, 1, 1]).ok).toBe(true);
	});

	test('a master on a newer model: refused (ontology_model_mismatch)', () => {
		expect(check('7.1.0', [7, 0, 0], [7, 0, 2]).refusal).toBe('ontology_model_mismatch');
	});

	test('a master on a model this code does not know: refused (ontology_model_unknown)', () => {
		expect(check('7.3.0', [7, 2, 0], [7, 2, 0]).refusal).toBe('ontology_model_unknown');
	});

	test('a database behind the code model: refused until Update data (installed_model_mismatch)', () => {
		expect(check('7.1.0', [7, 0, 2], [7, 1, 0]).refusal).toBe('installed_model_mismatch');
	});

	test('no version, or a date instead of one: refused (ontology_version_unreadable)', () => {
		expect(check(null, [7, 0, 0], [7, 0, 0]).refusal).toBe('ontology_version_unreadable');
		expect(check('2026-10-28', [7, 0, 0], [7, 0, 0]).refusal).toBe('ontology_version_unreadable');
	});
});
