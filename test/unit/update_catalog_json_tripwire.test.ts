/**
 * UPDATE CATALOG FILE TRIPWIRE (update audit 2026-10-29, owner decision D-7).
 *
 * The update definition is `install/update/catalog.json` + the per-release SQL
 * files beside it (src/core/update/catalog_file.ts). This gate holds:
 *  - the SHIPPED file parses with zero violations, every release key reaches
 *    UPDATE_CATALOG, and the data-version derivation still reads it;
 *  - every `.sql` file under install/update/ is referenced by exactly the
 *    release whose directory holds it (no orphan SQL that looks shipped);
 *  - every rule of the file format refuses its planted offender (walk, compat
 *    D-4, ontology min, step set, SQL path; an ontology step plans), and a
 *    valid data release becomes the engine descriptor with a DERIVED `from`.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RELEASE_PLANS, UPDATE_CATALOG } from '../../src/core/update/catalog.ts';
import {
	parseCatalogFile,
	shippedCatalogSqlFiles,
	UPDATE_CATALOG_DIR,
} from '../../src/core/update/catalog_file.ts';

const shipped = JSON.parse(readFileSync(join(UPDATE_CATALOG_DIR, 'catalog.json'), 'utf8')) as {
	releases: Record<string, unknown>;
};

/** Every .sql file under install/update/, relative to it — the engine's own enumeration. */
function shippedSqlFiles(): string[] {
	return shippedCatalogSqlFiles();
}

/** The SQL paths the shipped file references. */
function referencedSql(): string[] {
	return Object.values(shipped.releases)
		.flatMap((release) => (release as { steps?: { kind: string; sql?: string[] }[] }).steps ?? [])
		.flatMap((step) => (step.kind === 'data' ? (step.sql ?? []) : []))
		.sort();
}

const SQL = 'UPDATE matrix_test SET data = data WHERE false';
const sqlReader = (present: Record<string, string>) => (path: string) => present[path] ?? null;

/** Parse a planted file; `files` are the SQL files that exist. */
function parse(releases: Record<string, unknown>, files: Record<string, string> = {}) {
	return parseCatalogFile({ format: 1, releases }, sqlReader(files), [7, 0, 0]);
}

/** The rules a planted file breaks. */
function rules(releases: Record<string, unknown>, files: Record<string, string> = {}): string[] {
	return parse(releases, files).violations.map((violation) => violation.rule);
}

const dataRelease = (sql: string[] = ['7.1.0/01_a.sql']) => ({
	compat: 'incompatible',
	steps: [{ kind: 'code' }, { kind: 'data', sql }],
});

describe('the shipped update catalog file', () => {
	test('parses with zero violations, and every release reaches UPDATE_CATALOG and RELEASE_PLANS', () => {
		const parsed = parseCatalogFile(shipped, (path) =>
			readFileSync(join(UPDATE_CATALOG_DIR, path), 'utf8').trim(),
		);
		expect(parsed.violations).toEqual([]);
		const keys = Object.keys(shipped.releases);
		expect(keys.length).toBeGreaterThan(0);
		expect(Object.keys(UPDATE_CATALOG)).toEqual(keys);
		expect(Object.keys(RELEASE_PLANS)).toEqual(keys);
	});

	test('every SQL file under install/update/ is referenced by the release whose directory holds it', () => {
		expect(shippedSqlFiles()).toEqual(referencedSql());
	});

	test('the census enumerator FINDS planted SQL files (nested too) — an empty census is not vacuous ((5) #5)', () => {
		const dir = mkdtempSync(join(tmpdir(), 'dedalo_catalog_sql_'));
		try {
			mkdirSync(join(dir, '7.1.0', 'sub'), { recursive: true });
			writeFileSync(join(dir, '7.1.0', '01_a.sql'), SQL);
			writeFileSync(join(dir, '7.1.0', 'sub', '02_b.sql'), SQL);
			writeFileSync(join(dir, '7.1.0', 'notes.txt'), 'not sql');
			expect(shippedCatalogSqlFiles(dir)).toEqual(['7.1.0/01_a.sql', '7.1.0/sub/02_b.sql']);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('the file format refuses what it must (planted)', () => {
	test('a valid file loads (the control every refusal below is measured against)', () => {
		const parsed = parse({ '7.0.1': {}, '7.1.0': dataRelease() }, { '7.1.0/01_a.sql': SQL });
		expect(parsed.violations.map((violation) => violation.rule)).toHaveLength(0);
		expect(Object.keys(parsed.descriptors)).toEqual(['7.0.1', '7.1.0']);
	});

	test('a non-object release is a named violation, never a TypeError', () => {
		for (const release of [null, 7, 'x', []]) {
			expect(rules({ '7.0.1': release })).toContain('release_shape');
		}
	});

	test('the walk: a skipped rung, a wrong order, a non-triple key', () => {
		expect(rules({ '7.0.2': {} })).toContain('release_walk');
		expect(rules({ '7.0.2': {}, '7.0.1': {} })).toContain('release_walk');
		expect(rules({ '7.0.1-beta.1': {} })).toContain('release_key');
	});

	test('compat (D-4): missing, without steps, incompatible on a patch, data declared compatible', () => {
		expect(
			rules({ '7.0.1': {}, '7.1.0': { steps: [{ kind: 'code' }, { kind: 'schema' }] } }),
		).toContain('compat_missing');
		expect(rules({ '7.0.1': { compat: 'compatible' } })).toContain('compat_without_steps');
		expect(
			rules({ '7.0.1': { compat: 'incompatible', steps: [{ kind: 'code' }, { kind: 'schema' }] } }),
		).toContain('incompatible_on_patch');
		expect(
			rules(
				{ '7.0.1': {}, '7.1.0': { ...dataRelease(), compat: 'compatible' } },
				{ '7.1.0/01_a.sql': SQL },
			),
		).toContain('data_is_incompatible');
		// a compatible schema change (an index) may ride a patch
		expect(
			rules({ '7.0.1': { compat: 'compatible', steps: [{ kind: 'code' }, { kind: 'schema' }] } }),
		).toEqual([]);
	});

	test('the step set: no code, code twice, a kind twice, an unknown kind or key', () => {
		expect(rules({ '7.0.1': { compat: 'compatible', steps: [{ kind: 'schema' }] } })).toContain(
			'code_step',
		);
		expect(rules({ '7.0.1': { steps: [{ kind: 'code' }, { kind: 'code' }] } })).toContain(
			'code_step',
		);
		expect(
			rules({
				'7.0.1': {
					compat: 'compatible',
					steps: [{ kind: 'code' }, { kind: 'schema' }, { kind: 'schema' }],
				},
			}),
		).toContain('step_twice');
		expect(rules({ '7.0.1': { steps: [{ kind: 'code' }, { kind: 'reindex' }] } })).toContain(
			'step_kind',
		);
		expect(rules({ '7.0.1': { steps: [{ kind: 'code', when: 'now' }] } })).toContain('unknown_key');
		expect(rules({ '7.0.1': { notes: 'x' } })).toContain('unknown_key');
		expect(rules({ '7.0.1': { steps: [] } })).toContain('steps_shape');
	});

	test('a declared ontology step plans (the run executes it, run/ontology_phase.ts), and its min is checked', () => {
		const parsed = parse({
			'7.0.1': {},
			'7.1.0': {
				compat: 'compatible',
				steps: [{ kind: 'ontology', min: '7.0.1' }, { kind: 'code' }],
			},
		});
		expect(parsed.violations.map((violation) => violation.rule)).not.toContain('ontology_step');
		expect(parsed.violations.map((violation) => violation.code)).not.toContain(
			'engine.uncovered_scope',
		);
		expect(parsed.plans['7.1.0']?.steps.map((step) => step.kind)).toEqual(['ontology', 'code']);
		const placement = rules({
			'7.0.1': {},
			'7.1.0': {
				compat: 'compatible',
				steps: [{ kind: 'code' }, { kind: 'ontology', min: '7.0.1' }],
			},
		});
		expect(placement).toContain('ontology_placement');
		// (4) #8: a non-ontology step before code would vanish from the plan — refused
		for (const kind of ['schema', 'data', 'ancillary'] as const) {
			expect(
				rules({
					'7.0.1': {},
					'7.1.0': { compat: 'incompatible', steps: [{ kind }, { kind: 'code' }] },
				}),
			).toContain('step_placement');
			expect(
				rules({
					'7.0.1': {},
					'7.1.0': { compat: 'incompatible', steps: [{ kind: 'code' }, { kind }] },
				}),
			).not.toContain('step_placement');
		}
		expect(
			rules({
				'7.0.1': {},
				'7.1.0': {
					compat: 'compatible',
					steps: [{ kind: 'ontology', min: '2026-10-01' }, { kind: 'code' }],
				},
			}),
		).toContain('ontology_min');
		expect(
			rules({
				'7.0.1': {},
				'7.1.0': {
					compat: 'compatible',
					steps: [{ kind: 'ontology', min: '7.1.0' }, { kind: 'code' }],
				},
			}),
		).toContain('ontology_min');
		// a min across an incompatible release is another data model
		expect(
			rules(
				{
					'7.0.1': {},
					'7.1.0': dataRelease(),
					'7.1.1': {
						compat: 'compatible',
						steps: [{ kind: 'ontology', min: '7.0.1' }, { kind: 'code' }],
					},
				},
				{ '7.1.0/01_a.sql': SQL },
			),
		).toContain('ontology_min');
	});

	test('data SQL: outside its release directory, missing on disk, no sql and no scripts', () => {
		expect(rules({ '7.0.1': {}, '7.1.0': dataRelease(['7.0.1/01_a.sql']) })).toContain(
			'data_sql_path',
		);
		expect(rules({ '7.0.1': {}, '7.1.0': dataRelease(['7.1.0/../x.sql']) })).toContain(
			'data_sql_path',
		);
		expect(rules({ '7.0.1': {}, '7.1.0': dataRelease() })).toContain('data_sql_missing');
		expect(
			rules({
				'7.0.1': {},
				'7.1.0': { compat: 'incompatible', steps: [{ kind: 'code' }, { kind: 'data' }] },
			}),
		).toContain('data_without_steps');
	});
});

describe('a valid file becomes the engine descriptors', () => {
	test("a data release's from is the previous DATA release (code-only releases never move it)", () => {
		const parsed = parse(
			{
				'7.0.1': {},
				'7.1.0': dataRelease(),
				'7.1.1': {},
				'7.2.0': dataRelease(['7.2.0/01_b.sql']),
			},
			{ '7.1.0/01_a.sql': SQL, '7.2.0/01_b.sql': SQL },
		);
		expect(parsed.violations).toHaveLength(0);
		const first = parsed.descriptors['7.1.0'];
		const second = parsed.descriptors['7.2.0'];
		expect(parsed.descriptors['7.0.1']?.updateData).toBe(false);
		expect(first).toMatchObject({
			updateData: true,
			updateFromMinor: 0,
			updateFromMedium: 0,
			sqlUpdate: [SQL],
		});
		expect(second).toMatchObject({ updateData: true, updateFromMedium: 1, updateFromMinor: 0 });
		expect(parsed.plans['7.0.1']?.declared).toBe(false);
		expect(parsed.plans['7.1.0']?.compat).toBe('incompatible');
	});
});
