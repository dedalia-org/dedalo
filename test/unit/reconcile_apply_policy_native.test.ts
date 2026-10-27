/**
 * WHO MAY APPLY A RECONCILE IS DECLARED IN THE REGISTRY (cross-ops:r1, review finding
 * "run_reconcile gained perm.denied refusals (applyRootOnly facet, publication_apis
 * apply) with no wire_contract amendment and no row flag, so the client's APPLY button
 * sends users to no_access_page").
 *
 * Two refusals lived where no door could see them: `applyRootOnly` was read by the
 * widget alone, and publication_apis refused every apply from INSIDE its `run()` —
 * so the listing offered an APPLY that could never succeed, and the refusal came back
 * as `perm.denied` (the client's full no-access treatment). The registry now owns the
 * whole policy:
 *  - `applyRefused` — a reason-required facet: an apply is never offered through the
 *    registry's doors. `runReconcile` refuses it BEFORE `run` with `request.invalid`
 *    (a caller asking a door for what it never offers — a toast on the client, never
 *    the no-access page), and nothing is recorded: nothing ran;
 *  - `applyPolicyOf` — the ONE derivation (`'admin' | 'root' | 'refused'`) every door
 *    publishes, so a client never renders a button the server will refuse.
 *
 * LEGS (pure + the live catalog; no store is touched — the one run is a stub):
 *  P1 the facet contract: a reason is required; `applyRefused` excludes
 *     `applyRootOnly` and `autoApply` (both describe an apply that runs).
 *  P2 the derivation, and the live catalog: media_copy is `'root'`.
 *  P3 `runReconcile` refuses an apply of an `applyRefused` definition before its
 *     run, records nothing, and still runs it dry.
 *  P4 THE WIRE ROW (WC-2026-09-03 addendum 2026-10-21): every reconcile_status row
 *     carries `apply` / `apply_reason` / `can_apply` for ITS viewer — publication_apis
 *     is `'refused'` for root too; media_copy is applicable by root alone; an ordinary
 *     reconcile by any global admin. The client renders APPLY from `can_apply` alone.
 *  P5 THE REFUSAL OFF THE PAGE: root's APPLY of publication_apis through the widget
 *     door is `request.invalid` — never a `perm.*` code (the client's no-access page)
 *     — and nothing runs, nothing is recorded.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import {
	type ReconcileStatusRow,
	widget as reconcileStatusWidget,
	runMessage,
} from '../../src/core/area_maintenance/widgets/reconcile_status.ts';
import { registerAllReconciles } from '../../src/core/reconcile/catalog.ts';
import {
	applyPolicyOf,
	applyPolicyReason,
	getReconcile,
	lastReconcileRun,
	type ReconcileDefinition,
	runReconcile,
	validateDefinition,
} from '../../src/core/reconcile/registry.ts';
import { type Principal, SUPERUSER_ID } from '../../src/core/security/permissions.ts';

const ADMIN = { isGlobalAdmin: true, userId: 7 } as unknown as Principal;
const ROOT = { isGlobalAdmin: true, userId: SUPERUSER_ID } as unknown as Principal;

async function rowsFor(principal: Principal): Promise<Map<string, ReconcileStatusRow>> {
	const value = (await reconcileStatusWidget.getValue?.({}, principal)) as {
		data: { reconciles: ReconcileStatusRow[] };
	};
	return new Map(value.data.reconciles.map((row) => [row.name, row]));
}

const REASON = 'pushing code to a public machine has its own root-only door (a test reason)';

/** A complete definition under a registered name (validateDefinition checks the name). */
function definition(facets: Partial<ReconcileDefinition>): ReconcileDefinition {
	return {
		name: 'publication_apis',
		stores: ['store a', 'store b'],
		description: 'a test definition',
		scopeLabel: null,
		schedule: 'operator',
		sources: ['src/core/reconcile/registry.ts'],
		run: async () => ({ drift: 0, applied: 0, detail: {} }),
		...facets,
	};
}

beforeAll(async () => {
	await registerAllReconciles();
});

describe('reconcile apply policy', () => {
	test('P1 applyRefused needs a reason and excludes applyRootOnly / autoApply', () => {
		expect(() =>
			validateDefinition(definition({ applyRefused: { reason: REASON } })),
		).not.toThrow();
		expect(() => validateDefinition(definition({ applyRefused: { reason: '  ' } }))).toThrow(
			/applyRefused needs a reason/,
		);
		for (const other of [
			{ applyRootOnly: { reason: REASON } },
			{ autoApply: { reason: REASON } },
		] as Partial<ReconcileDefinition>[]) {
			expect(() =>
				validateDefinition(definition({ applyRefused: { reason: REASON }, ...other })),
			).toThrow(/applyRefused excludes applyRootOnly and autoApply/);
		}
	});

	test('P2 applyPolicyOf: refused > root > admin, with the declared reason; media_copy is root-only', () => {
		expect(applyPolicyOf(definition({}))).toBe('admin');
		expect(applyPolicyReason(definition({}))).toBeNull();
		expect(applyPolicyOf(definition({ applyRootOnly: { reason: REASON } }))).toBe('root');
		expect(applyPolicyOf(definition({ applyRefused: { reason: REASON } }))).toBe('refused');
		expect(applyPolicyReason(definition({ applyRefused: { reason: REASON } }))).toBe(REASON);
		const mediaCopy = getReconcile('media_copy');
		expect(mediaCopy, 'media_copy is not registered').not.toBeNull();
		expect(applyPolicyOf(mediaCopy as ReconcileDefinition)).toBe('root');
	});

	test('P3 runReconcile refuses an applyRefused APPLY before its run (request.invalid), records nothing, still runs dry', async () => {
		// A live registered definition, its facet and run swapped for the test's and put back:
		// the registry's guard is what is measured, not any owner's run().
		const live = getReconcile('counters_media') as ReconcileDefinition;
		expect(live, 'counters_media is not registered').not.toBeNull();
		const original = { run: live.run, applyRefused: live.applyRefused };
		const calls: boolean[] = [];
		const mutable = live as { -readonly [K in keyof ReconcileDefinition]: ReconcileDefinition[K] };
		mutable.applyRefused = { reason: REASON };
		mutable.run = async ({ apply }) => {
			calls.push(apply);
			return { drift: 0, applied: 0, detail: {} };
		};
		try {
			const before = lastReconcileRun('counters_media');
			await expect(runReconcile('counters_media', { apply: true })).rejects.toMatchObject({
				code: 'request.invalid',
			});
			expect(calls.length, 'the refused apply reached run()').toBe(0);
			expect(lastReconcileRun('counters_media'), 'a refusal is not a run').toBe(before);
			const dry = await runReconcile('counters_media', { apply: false });
			expect(dry.record).toMatchObject({ apply: false, error: null });
			expect(calls).toEqual([false]);
		} finally {
			mutable.run = original.run;
			if (original.applyRefused === undefined) mutable.applyRefused = undefined;
			else mutable.applyRefused = original.applyRefused;
		}
	});

	test('P4 every listing row says who may apply it, for its viewer', async () => {
		const admin = await rowsFor(ADMIN);
		const root = await rowsFor(ROOT);
		for (const row of admin.values()) {
			const definition = getReconcile(row.name) as ReconcileDefinition;
			expect(row.apply, row.name).toBe(applyPolicyOf(definition));
			expect(row.apply_reason, row.name).toBe(applyPolicyReason(definition));
		}
		expect(admin.get('publication_apis')).toMatchObject({ apply: 'refused', can_apply: false });
		expect(root.get('publication_apis')).toMatchObject({ apply: 'refused', can_apply: false });
		expect(root.get('publication_apis')?.apply_reason).toContain('root-only');
		expect(admin.get('media_copy')).toMatchObject({ apply: 'root', can_apply: false });
		expect(root.get('media_copy')).toMatchObject({ apply: 'root', can_apply: true });
		expect(admin.get('counters_media')).toMatchObject({
			apply: 'admin',
			apply_reason: null,
			can_apply: true,
		});
	});

	test("P5 root's APPLY of publication_apis is request.invalid — never perm.* — and nothing runs", async () => {
		const before = lastReconcileRun('publication_apis');
		await expect(
			reconcileStatusWidget.apiActions?.run_reconcile?.(
				{ name: 'publication_apis', apply: true },
				ROOT,
			) as Promise<unknown>,
		).rejects.toMatchObject({ code: 'request.invalid' });
		expect(lastReconcileRun('publication_apis'), 'a refusal is not a run').toBe(before);
	});
});

describe('P6 the operator sentence never says OK over unresolved items', () => {
	test('drift 0 with missing files is not "the two stores agree"', () => {
		const report = { drift: 0, applied: 0, detail: { missing: ['a', 'b'], held: [], failed: [] } };
		const msg = runMessage('rich_text_images', false, report);
		expect(msg).not.toContain('agree');
		expect(msg).toContain('missing 2');
		expect(runMessage('x', false, { drift: 0, applied: 0, detail: { missing: 3 } })).toContain(
			'agree',
		);
	});
});
