/**
 * reconcile_status client — what an operator READS on a reconcile row (D5,
 * WC-2026-10-22-reconcile-deferred-rearm). The pure sentences are imported and
 * exercised on the registry's own record shape (`satisfies ReconcileRunRecord`,
 * so a server-side rename breaks this file's typecheck, not the page); the
 * render wiring is pinned at the source level (vanilla JS, no DOM here).
 *
 * Asserted: a DEFERRED and a REFUSED run each say so (WC-2026-11-05-reconcile-apply-refused) — with its reason and "nothing applied" —
 * and never reads as a clean `apply — drift N, applied 0`; a failed run names
 * its code; the interval schedule reads `boot + every 10 min` / `every N min`.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	last_run_text,
	schedule_text,
} from '../../client/dedalo/core/area_maintenance/widgets/reconcile_status/js/reconcile_status_text.js';
import type { ReconcileRunRecord } from '../../src/core/reconcile/registry.ts';
import { MEDIA_INDEX_RECONCILE } from '../../src/diffusion/api/reconcile.ts';

const DIR = join(
	import.meta.dir,
	'../../client/dedalo/core/area_maintenance/widgets/reconcile_status/js',
);

const RAN_AT = '2026-10-22T10:00:00.000Z';
const base = {
	name: 'media_index',
	apply: true,
	scope: null,
	ranAt: RAN_AT,
	durationMs: 12,
	drift: 3,
	applied: 0,
	deferred: null,
	refused: null,
	error: null,
} satisfies ReconcileRunRecord;

describe('reconcile_status client sentences', () => {
	test('a DEFERRED apply reads DEFERRED with its reason and nothing applied — never a clean "applied 0"', () => {
		const reason = 'publication target sql:zz_db held by a writer past the fence budget';
		const text = last_run_text({ ...base, deferred: reason } satisfies ReconcileRunRecord);
		expect(text).toBe(`${RAN_AT} DEFERRED — drift 3, nothing applied: ${reason}`);
		expect(text).not.toContain('applied 0');
	});

	test('a REFUSED apply reads REFUSED with its reason and nothing applied — never a clean "applied 0"', () => {
		const reason =
			'this is an ontology server: master is converted by a human — give an explicit TLD scope';
		const text = last_run_text({ ...base, refused: reason } satisfies ReconcileRunRecord);
		expect(text).toBe(`${RAN_AT} REFUSED — drift 3, nothing applied: ${reason}`);
		expect(text).not.toContain('applied 0');
	});

	test('a scopable row offers a scope field and sends it on check AND apply', () => {
		const render = readFileSync(join(DIR, 'render_reconcile_status.js'), 'utf8');
		const run = readFileSync(join(DIR, 'reconcile_status.js'), 'utf8');
		expect(render).toContain('item.scope_label');
		expect(render.match(/scope: read_scope\(\)/g)?.length).toBe(2);
		expect(run).toContain('scope: options.scope');
	});

	test('a completed apply, a check, a failure and no run each read as what they are', () => {
		expect(last_run_text({ ...base, applied: 3 })).toBe(`${RAN_AT} apply — drift 3, applied 3`);
		expect(last_run_text({ ...base, apply: false })).toBe(`${RAN_AT} check — drift 3`);
		expect(
			last_run_text({
				...base,
				drift: 0,
				error: 'internal.invariant',
			} satisfies ReconcileRunRecord),
		).toBe(`${RAN_AT} FAILED: internal.invariant`);
		expect(last_run_text(null)).toBe('never (this process)');
	});

	test("the schedule reads as the operator's sentence — media_index's own is 'boot + every 10 min'", () => {
		expect(schedule_text(MEDIA_INDEX_RECONCILE.schedule)).toBe('boot + every 10 min');
		expect(schedule_text({ everyMs: 15 * 60_000 })).toBe('every 15 min');
		expect(schedule_text('boot')).toBe('boot');
		expect(schedule_text('operator')).toBe('operator');
	});

	test('the widget renders the row through these sentences (no private copy)', () => {
		const render = readFileSync(join(DIR, 'render_reconcile_status.js'), 'utf8');
		expect(render).toContain("from './reconcile_status_text.js'");
		expect(render).toContain('schedule_text(item.schedule)');
		expect(render).toContain('last_run_text(item.last_run)');
		expect(render).not.toMatch(/const (schedule_text|last_run_text) =/);
	});
});
