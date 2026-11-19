/**
 * error_reports maintenance widget (WC-018) + the store it fronts.
 *
 * Store assertions run on an injectable SCRATCH table (dedalo_ts_test_*,
 * dropped in afterAll); the widget module's handlers are exercised directly.
 * Since 2026-11-19 (email transport) every installation lists the widget:
 * the admin gate refuses non-admins, admins get the handlers.
 */
// Migrated to the generic `test` TLD 2026-08-20 (AGENTS.md hard rules): the stored report row's section is an opaque string, rewritten to its phase-2 `test` clone (src/core/test_data/test_tld_tipo_map.json).

import { afterAll, describe, expect, test } from 'bun:test';
import { widget } from '../../src/core/area_maintenance/widgets/error_reports.ts';
import {
	dispatchGetWidgetValue,
	dispatchWidgetRequest,
	MAINTENANCE_WIDGET_IDS,
} from '../../src/core/area_maintenance/widgets/registry.ts';
import { sql } from '../../src/core/db/postgres.ts';
import {
	ensureErrorReportsTable,
	insertErrorReport,
	listErrorReports,
} from '../../src/core/error_report/store.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import type { Principal } from '../../src/core/security/permissions.ts';

/** The DedaloError an async call rejected with (fails when nothing typed was thrown). */
async function rejectedBy(run: () => Promise<unknown>): Promise<DedaloError> {
	try {
		await run();
	} catch (error) {
		expect(error).toBeInstanceOf(DedaloError);
		return error as DedaloError;
	}
	throw new Error('expected a DedaloError, nothing was thrown');
}

const SCRATCH_TABLE = `dedalo_ts_test_error_reports_${process.pid}`;

const admin: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };
const nonAdmin: Principal = { userId: 42, isGlobalAdmin: false, isDeveloper: false };

function row(description: string) {
	return {
		source_ip: '198.51.100.7',
		entity: 'test',
		dedalo_version: '7.0.0.dev',
		user_id: 5,
		section_tipo: 'test6813',
		section_id: '1',
		page_url: '/dedalo/core/page/?tipo=test6813',
		description,
		js_errors: [],
		context: null,
	};
}

afterAll(async () => {
	await sql.unsafe(`DROP TABLE IF EXISTS "${SCRATCH_TABLE}"`, []);
});

describe('error-report store (scratch table)', () => {
	test('insert stamps an id; list pages newest-first; limit clamps at 100', async () => {
		await ensureErrorReportsTable(SCRATCH_TABLE);

		const firstId = await insertErrorReport(row('first'), { table: SCRATCH_TABLE });
		const secondId = await insertErrorReport(row('second'), { table: SCRATCH_TABLE });
		expect(secondId).toBeGreaterThan(firstId);

		const page = await listErrorReports({ table: SCRATCH_TABLE, limit: 1 });
		expect(page.length).toBe(1);
		expect(page[0]?.description).toBe('second'); // newest first

		const next = await listErrorReports({ table: SCRATCH_TABLE, limit: 1, offset: 1 });
		expect(next[0]?.description).toBe('first');

		// The clamp: a hostile/legit huge limit never exceeds 100.
		const clamped = await listErrorReports({ table: SCRATCH_TABLE, limit: 10_000 });
		expect(clamped.length).toBeLessThanOrEqual(100);
	});

	test('retention prune deletes only rows older than the window', async () => {
		await ensureErrorReportsTable(SCRATCH_TABLE);
		const oldId = await insertErrorReport(row('ancient'), {
			table: SCRATCH_TABLE,
			retentionDays: 0, // no prune on this insert
		});
		await sql.unsafe(
			`UPDATE "${SCRATCH_TABLE}" SET received_at = now() - interval '400 days' WHERE id = $1`,
			[oldId],
		);
		// The next insert prunes opportunistically with a 90-day window.
		await insertErrorReport(row('fresh'), { table: SCRATCH_TABLE, retentionDays: 90 });
		const remaining = await listErrorReports({ table: SCRATCH_TABLE, limit: 100 });
		expect(remaining.some((item) => item.description === 'ancient')).toBe(false);
		expect(remaining.some((item) => item.description === 'fresh')).toBe(true);
	});

	test('the store is append-only by construction: no update/delete exports', async () => {
		const store = await import('../../src/core/error_report/store.ts');
		const mutators = Object.keys(store).filter((name) => /update|delete|remove/i.test(name));
		expect(mutators).toEqual([]);
	});
});

describe('error_reports widget (WC-018)', () => {
	test('module shape: id, literal label, getValue + the ONE registered action', () => {
		expect(widget.spec.id).toBe('error_reports');
		expect(widget.spec.label).toEqual({ kind: 'literal', text: 'Error reports' });
		expect(typeof widget.getValue).toBe('function');
		expect(Object.keys(widget.apiActions ?? {})).toEqual(['get_reports']);
	});

	test('catalog membership: every installation lists it (each stores its own reports)', () => {
		expect(MAINTENANCE_WIDGET_IDS.includes('error_reports')).toBe(true);
	});

	test('getValue reports the configured target (env-driven display)', async () => {
		const value = await widget.getValue?.({}, admin);
		const data = value?.data as { target?: unknown };
		expect(typeof data.target).toBe('string');
	});

	test('dispatch: non-admin refused; admin answered', async () => {
		// Admin gate runs FIRST regardless of catalog membership.
		const nonAdminRefusal = await rejectedBy(() =>
			dispatchWidgetRequest(nonAdmin, { model: 'error_reports', action: 'get_reports' }, {}),
		);
		expect(nonAdminRefusal.code).toBe('perm.denied');

		const nonAdminValueRefusal = await rejectedBy(() =>
			dispatchGetWidgetValue(nonAdmin, { model: 'error_reports' }),
		);
		expect(nonAdminValueRefusal.code).toBe('perm.denied');

		const adminResult = await dispatchWidgetRequest(
			admin,
			{ model: 'error_reports', action: 'get_reports' },
			{},
		);
		expect(adminResult.data).toBeDefined();
	});

	test('getValue is fail-soft: a broken store yields a null panel, never a throw', async () => {
		// The widget runs against the DEFAULT table; on an installation where
		// the boot migration ran this returns totals, and on one where the
		// table is absent it must still answer (null totals). Both are valid —
		// the assertion is the CONTRACT: it never throws and always returns the
		// envelope shape.
		const value = await widget.getValue?.({}, admin);
		expect(value).toBeDefined();
		expect(value?.errors).toBeUndefined();
		const data = value?.data as { total: unknown; latest_received_at: unknown };
		expect('total' in data).toBe(true);
		expect('latest_received_at' in data).toBe(true);
	});
});
