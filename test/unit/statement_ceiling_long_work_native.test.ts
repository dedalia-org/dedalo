/**
 * LONG WORK DECLARES ITS OWN SCOPE AT THE SOURCE (T1-24 / audit D02).
 *
 * Before the request statement ceiling (`DB_STATEMENT_TIMEOUT_MS`) can be on by
 * default, every legitimately long piece of work must run on the maintenance
 * lane (`withUnboundedStatements`, PERF-11) — at the SOURCE, so no caller has to
 * remember it:
 *  - `ensureSearchStores` (server boot, completeFreshInstall, the seed verify,
 *    the data-update ancillary);
 *  - `reconcileObserverMirrors` (the CLI, the reconcile registry run, the
 *    post-restore plan, the update engine).
 * (`backfillSearchStores` carries the same one-line source wrap; it is not
 * driven here because it TRUNCATEs the suite's derived stores.)
 *
 * MEASURED, not spelled: a child process with a real ceiling runs the subject,
 * then counts the backends carrying ITS OWN maintenance application_name in
 * pg_stat_activity. The maintenance pool is built lazily and its connections
 * linger idle, so a count > 0 proves the work ran there; a subject that ran on
 * the request pool leaves 0 (the HEAD failure). Each subject gets its own child
 * so one cannot open the pool for the other.
 *
 * Both subjects write nothing on a healthy suite database: the ensure probes and
 * finds nothing to heal, the reconcile is a DRY run.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { childDriver, driverResult, repoModule } from '../helpers/child_driver.ts';

const CEILING_MS = 250;

interface SubjectResult {
	value?: Record<string, unknown>;
	error?: string;
	maintenanceBackends: number;
	insideRequestTx: { code?: string; message?: string } | 'NO ERROR';
}

function driverFor(subject: 'ensure' | 'reconcile'): string {
	return `
import ${repoModule('src/core/components/registry.ts')};
import { sql, withTransaction } from ${repoModule('src/core/db/postgres.ts')};
import { assertTestDatabase } from ${repoModule('src/core/test_data/test_database_marker.ts')};
import { ensureSearchStores } from ${repoModule('src/core/db/db_assets.ts')};
import { reconcileObserverMirrors } from ${repoModule('src/core/section/record/observer_reconcile.ts')};
await assertTestDatabase('statement_ceiling_long_work_native');
const SUBJECT = ${JSON.stringify(subject)};
const run = () => SUBJECT === 'ensure'
	? ensureSearchStores()
	: reconcileObserverMirrors({ apply: false });
const result = { maintenanceBackends: 0 };
try {
	const value = await run();
	result.value = SUBJECT === 'ensure'
		? { healthy: value.healthy, ddlApplied: value.ddlApplied, errors: value.errors.length }
		: { tuples: value.tuples, repaired: value.repaired };
} catch (e) {
	result.error = String(e?.message ?? e).slice(0, 400);
}
result.maintenanceBackends = Number((await sql.unsafe(
	"SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND application_name LIKE $1",
	['dedalo_maintenance:' + process.pid + ':%']))[0].n);
// The scope's existing law: entered inside a request-lane transaction it refuses loudly.
try {
	await withTransaction(() => run());
	result.insideRequestTx = 'NO ERROR';
} catch (e) {
	result.insideRequestTx = { code: e?.code, message: String(e?.message ?? e).slice(0, 300) };
}
console.log('RESULT ' + JSON.stringify(result));
process.exit(0);
`;
}

const driver = childDriver('dedalo-long-work-scope');
const results: Partial<Record<'ensure' | 'reconcile', SubjectResult>> = {};

beforeAll(async () => {
	await assertTestDatabase('statement_ceiling_long_work_native');
	try {
		for (const subject of ['ensure', 'reconcile'] as const) {
			const { stdout, stderr } = await driver.run(`${subject}_driver.ts`, driverFor(subject), {
				DB_STATEMENT_TIMEOUT_MS: String(CEILING_MS),
			});
			results[subject] = driverResult<SubjectResult>(stdout, stderr);
		}
	} finally {
		driver.dispose();
	}
}, 300_000);

describe('long boot/sweep work runs on the maintenance lane (T1-24 / D02)', () => {
	test('ensureSearchStores runs inside the unbounded scope', () => {
		const result = results.ensure as SubjectResult;
		expect(result.error).toBeUndefined();
		expect(result.value).toMatchObject({ healthy: true, errors: 0 });
		expect(result.maintenanceBackends).toBeGreaterThan(0);
	});

	test('reconcileObserverMirrors runs inside the unbounded scope (and found work to sweep)', () => {
		const result = results.reconcile as SubjectResult;
		expect(result.error).toBeUndefined();
		// Non-vacuity: the suite DB declares observers, so the dry sweep walked tuples.
		expect(Number(result.value?.tuples)).toBeGreaterThan(0);
		expect(result.value?.repaired).toBe(0); // dry: nothing written
		expect(result.maintenanceBackends).toBeGreaterThan(0);
	});

	test('either, entered inside a request-lane transaction, refuses loudly', () => {
		for (const subject of ['ensure', 'reconcile'] as const) {
			const refusal = results[subject]?.insideRequestTx;
			expect(refusal, subject).not.toBe('NO ERROR');
			expect((refusal as { code?: string }).code, subject).toBe('internal.invariant');
		}
	});
});
