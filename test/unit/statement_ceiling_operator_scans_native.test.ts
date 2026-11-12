/**
 * READ-ONLY OPERATOR SCANS RUN ON THE MAINTENANCE LANE (T1-24 review).
 *
 * The request statement ceiling (`DB_STATEMENT_TIMEOUT_MS`) is on by default
 * (60 s). Two read-only operator scripts send single statements over WHOLE
 * tables — on a production install those run for minutes, and on the request
 * lane the first one is cancelled with `db.statement_timeout`, aborting the run
 * with no result:
 *  - `scripts/census_section_id.ts` — a `jsonb_path_query` `$.**` descent over
 *    every matrix table × JSONB column plus the Time Machine (the same shape
 *    migrate_section_id_locators' post-verify census runs in the scope);
 *  - `scripts/detect_csv_import_damage.ts` — `jsonb_each` over every record
 *    table, a `lag()` window over all of matrix_time_machine.
 * Each declares the unbounded scope at its source (engineering/PRODUCTION.md
 * §4 census).
 *
 * MEASURED, not spelled (pattern: statement_ceiling_long_work_native): a child
 * with a real ceiling runs the script's `main`, then counts the backends
 * carrying ITS OWN maintenance application_name in pg_stat_activity. The
 * maintenance pool is built lazily and its connections linger idle, so a count
 * > 0 proves the scan ran there; a scan on the request pool leaves 0. The suite
 * tables are small, so elapsed time could not tell the lanes apart. Both scripts
 * write nothing (the damage scan proves its own READ ONLY barrier).
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { childDriver, driverResult, repoModule } from '../helpers/child_driver.ts';

const CEILING_MS = 250;

type Subject = 'census' | 'damage';

interface SubjectResult {
	returned?: unknown;
	error?: string;
	maintenanceBackends: number;
}

function driverFor(subject: Subject): string {
	const script =
		subject === 'census' ? 'scripts/census_section_id.ts' : 'scripts/detect_csv_import_damage.ts';
	return `
import { sql } from ${repoModule('src/core/db/postgres.ts')};
import { assertTestDatabase } from ${repoModule('src/core/test_data/test_database_marker.ts')};
import { main } from ${repoModule(script)};
await assertTestDatabase('statement_ceiling_operator_scans_native');
const result = { maintenanceBackends: 0 };
try {
	result.returned = (await main()) ?? null;
} catch (e) {
	result.error = String(e?.message ?? e).slice(0, 400);
}
result.maintenanceBackends = Number((await sql.unsafe(
	"SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND application_name LIKE $1",
	['dedalo_maintenance:' + process.pid + ':%']))[0].n);
console.log('RESULT ' + JSON.stringify(result));
process.exit(0);
`;
}

const driver = childDriver('dedalo-operator-scans');
const results: Partial<Record<Subject, { result: SubjectResult; stdout: string }>> = {};

beforeAll(async () => {
	await assertTestDatabase('statement_ceiling_operator_scans_native');
	try {
		for (const subject of ['census', 'damage'] as const) {
			const { stdout, stderr } = await driver.run(`${subject}_driver.ts`, driverFor(subject), {
				DB_STATEMENT_TIMEOUT_MS: String(CEILING_MS),
			});
			results[subject] = { result: driverResult<SubjectResult>(stdout, stderr), stdout };
		}
	} finally {
		driver.dispose();
	}
}, 300_000);

describe('read-only operator scans run in the unbounded scope (T1-24 review)', () => {
	test('census_section_id: completes, and its scans ran on the maintenance lane', () => {
		const run = results.census;
		expect(run?.result.error).toBeUndefined();
		expect(run?.result.returned).toBe(0);
		// Non-vacuity: the census walked its surfaces to the end.
		expect(run?.stdout).toContain('census complete in');
		expect(run?.result.maintenanceBackends).toBeGreaterThan(0);
	});

	test('detect_csv_import_damage: completes, and its scans ran on the maintenance lane', () => {
		const run = results.damage;
		expect(run?.result.error).toBeUndefined();
		// Non-vacuity: the barrier was proven and the signature queries ran.
		expect(run?.stdout).toContain('READ-ONLY PROVEN');
		const queries = Number(/Queries run: (\d+)/.exec(run?.stdout ?? '')?.[1] ?? 0);
		expect(queries).toBeGreaterThan(0);
		expect(run?.result.maintenanceBackends).toBeGreaterThan(0);
	});
});
