/**
 * TRIPWIRE — every migration is FROZEN in install/db/migrations.lock.json, and
 * its declared class is honest (update audit 2026-10-29, U-23; design §1/§5 1.5;
 * owner decisions D-2, D-4).
 *
 *  1. every install/db/migrations file is ledgered with its exact sha256, and
 *     every ledger entry names a file — an edit after release fails here before
 *     it can fail on an install (where migrate.ts refuses it at boot);
 *  2. a `compatible` claim is PROVEN by the lexer (migration_ledger.ts
 *     isProvablyCompatible) — an index, a new table, a nullable column; anything
 *     the lexer cannot prove must be declared `incompatible`;
 *  3. a migration shipped after the line start names a catalog release
 *     (install/update/catalog.json) that runs a `schema` step, and an
 *     `incompatible` one only an `incompatible` release (a minor at least, D-4:
 *     catalog_file.ts enforces compat ⇒ minor) — so a patch can never carry a
 *     schema change the previous code cannot run against (D-2's rollback ground).
 *
 * HERMETIC: tracked files only. The runtime leg (record / refuse / backfill) is
 * test/unit/ops_migrations.test.ts.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIGRATIONS_DIR, shippedMigrationFiles } from '../../install/db/migrate.ts';
import {
	isProvablyCompatible,
	ledgerMismatch,
	type MigrationLedger,
	migrationSha256,
	readMigrationLedger,
} from '../../install/db/migration_ledger.ts';
import { RELEASE_PLANS } from '../../src/core/update/catalog.ts';
import {
	compareVersionArrays,
	DATA_LINE_START,
	parseVersionString,
} from '../../src/core/update/version.ts';

const ledger: MigrationLedger = await readMigrationLedger();
// the runner's own enumeration (migrate.ts) — the ledger is checked against what boot applies
const files = shippedMigrationFiles();
const contentOf = (file: string) => readFileSync(join(MIGRATIONS_DIR, file), 'utf8');

type Plans = typeof RELEASE_PLANS;

/** Why a ledger entry's release does not carry its class; null when it does. */
function releaseViolation(
	file: string,
	within: MigrationLedger = ledger,
	plans: Plans = RELEASE_PLANS,
): string | null {
	const entry = within.migrations[file];
	if (entry === undefined) return null;
	const triple = parseVersionString(entry.release);
	if (triple.length !== 3 || triple.some(Number.isNaN))
		return `${file}: release '${entry.release}' is not a version`;
	if (compareVersionArrays(triple, DATA_LINE_START) <= 0) return null;
	const plan = plans[entry.release];
	if (plan === undefined)
		return `${file}: release ${entry.release} is not in install/update/catalog.json`;
	if (!plan.steps.some((step) => step.kind === 'schema')) {
		return `${file}: release ${entry.release} runs no schema step`;
	}
	if (entry.class === 'incompatible' && plan.compat !== 'incompatible') {
		return `${file}: an incompatible migration needs an incompatible release (${entry.release} is ${plan.compat ?? 'code-only'})`;
	}
	return plan.compat === null ? `${file}: release ${entry.release} declares no compat` : null;
}

describe('migration content-hash tripwire — install/db/migrations.lock.json', () => {
	test('anti-vacuity: the shipped migrations are scanned', () => {
		expect(files.length).toBeGreaterThanOrEqual(14);
		expect(files).toContain('0001_baseline.sql');
	});

	test('every migration file is ledgered with its exact hash; every entry names a file', () => {
		const mismatches = files
			.map((file) => ledgerMismatch(file, contentOf(file), ledger))
			.filter((line): line is string => line !== null);
		expect(mismatches).toEqual([]);
		expect(Object.keys(ledger.migrations).filter((file) => !files.includes(file))).toEqual([]);
	});

	test('every `compatible` claim is lexer-proven', () => {
		const unproven = files.filter(
			(file) =>
				ledger.migrations[file]?.class === 'compatible' && !isProvablyCompatible(contentOf(file)),
		);
		expect(unproven).toEqual([]);
	});

	test('a migration after the line start rides a catalog release whose compat carries its class', () => {
		expect(files.map((file) => releaseViolation(file)).filter((line) => line !== null)).toEqual([]);
	});

	test('anti-vacuity: the release rule refuses each planted violation (every shipped file is line-start today)', () => {
		const planted = (klass: 'compatible' | 'incompatible', release: string): MigrationLedger => ({
			format: ledger.format,
			migrations: { '0099_probe.sql': { sha256: '0'.repeat(64), class: klass, release } },
		});
		const plans = {
			'7.0.1': { version: '7.0.1', compat: null, steps: [{ kind: 'code' }], declared: true },
			'7.0.2': {
				version: '7.0.2',
				compat: 'compatible',
				steps: [{ kind: 'code' }, { kind: 'schema' }],
				declared: true,
			},
			'7.1.0': {
				version: '7.1.0',
				compat: 'incompatible',
				steps: [{ kind: 'code' }, { kind: 'schema' }],
				declared: true,
			},
		} as unknown as Plans;
		const verdict = (klass: 'compatible' | 'incompatible', release: string) =>
			releaseViolation('0099_probe.sql', planted(klass, release), plans);
		expect(verdict('compatible', '7.0.9')).toMatch(/is not in install\/update\/catalog\.json/);
		expect(verdict('compatible', '7.0.1')).toMatch(/runs no schema step/);
		expect(verdict('incompatible', '7.0.2')).toMatch(/needs an incompatible release/);
		expect(verdict('compatible', 'x.y')).toMatch(/is not a version/);
		expect(verdict('compatible', '7.0.2')).toBeNull();
		expect(verdict('incompatible', '7.1.0')).toBeNull();
	});

	test('anti-vacuity: the lexer proves only the additive shapes', () => {
		for (const compatible of [
			'CREATE INDEX IF NOT EXISTS a_idx ON dedalo_ts_x (id);',
			"SET LOCAL lock_timeout = '5s';\nCREATE INDEX CONCURRENTLY a_idx ON matrix USING gin (data);",
			'DROP INDEX IF EXISTS a_idx, b_idx; ANALYZE matrix_time_machine (tm_role);',
			"CREATE TABLE IF NOT EXISTS dedalo_ts_x (id int); COMMENT ON TABLE dedalo_ts_x IS 'x';",
			'ALTER TABLE matrix ADD COLUMN IF NOT EXISTS probe smallint NULL;',
			"-- don't panic: a quote in a comment\nCREATE INDEX a_idx ON matrix (id);",
		]) {
			expect(isProvablyCompatible(compatible), compatible).toBe(true);
		}
		for (const incompatible of [
			'CREATE UNIQUE INDEX a_idx ON matrix (id);',
			'ALTER TABLE matrix ADD COLUMN IF NOT EXISTS probe smallint DEFAULT 0;',
			'ALTER TABLE matrix ADD COLUMN IF NOT EXISTS probe smallint NOT NULL;',
			'ALTER TABLE matrix DROP COLUMN probe;',
			"UPDATE matrix SET data = '{}' WHERE id = 1;",
			'DO $$ BEGIN CREATE INDEX a_idx ON matrix (id); END $$;',
			'CREATE TABLE dedalo_ts_x (id int);',
			'-- only a comment',
			"COMMENT ON TABLE t IS '--'; DROP TABLE matrix_x;",
			"COMMENT ON TABLE t IS 'it''s -- fine'; DROP TABLE matrix_x;",
			"COMMENT ON TABLE t IS 'never closed",
			'/* never closed CREATE INDEX a ON b (c);',
		]) {
			expect(isProvablyCompatible(incompatible), incompatible).toBe(false);
		}
	});

	test('anti-vacuity: an edited or unledgered file is caught, and the hash is of the exact bytes', () => {
		const [first] = files as [string];
		expect(ledgerMismatch(first, `${contentOf(first)}\n`, ledger)).toMatch(
			/does not match its frozen hash/,
		);
		expect(ledgerMismatch('9999_probe.sql', 'SELECT 1', ledger)).toMatch(
			/is not in install\/db\/migrations\.lock\.json/,
		);
		expect(migrationSha256('SELECT 1')).not.toBe(migrationSha256('SELECT 1\n'));
	});
});
