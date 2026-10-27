/**
 * reconcile_status widget — the ONE maintenance door onto the reconcile
 * registry (core/reconcile/registry.ts, audit 2026-08-26 S-10).
 *
 * Lists every registered cross-store reconcile (name, the two stores, schedule,
 * last run + drift from this process's gauge) and runs one — DRY BY DEFAULT.
 * `apply:true` repairs; the widget never decides that, the operator does, with
 * the dry report in view. The per-subsystem doors that predate the registry
 * (counters_status.reconcile_media_counters, media_control's index status, the
 * CLI shells) keep working; they wrap the same definitions.
 */

import { DedaloError } from '../../errors/dedalo_error.ts';
import { registerAllReconciles } from '../../reconcile/catalog.ts';
import {
	applyPolicyOf,
	applyPolicyReason,
	getReconcile,
	lastReconcileRun,
	type ReconcileApplyPolicy,
	type ReconcileDefinition,
	type ReconcileReport,
	type ReconcileScope,
	runReconcile,
} from '../../reconcile/registry.ts';
import { type Principal, SUPERUSER_ID } from '../../security/permissions.ts';
import type { WidgetModule, WidgetResponse } from './support.ts';

/** One listing row — the wire shape the client renders. */
export interface ReconcileStatusRow {
	name: string;
	stores: [string, string];
	description: string;
	scope_label: string | null;
	schedule: ReconcileDefinition['schedule'];
	auto_apply: string | null;
	/** Who may APPLY through this door (registry.ts applyPolicyOf). */
	apply: ReconcileApplyPolicy;
	/** Why `apply` is not `'admin'` (the definition's declared reason), else null. */
	apply_reason: string | null;
	/** THIS viewer may apply it here — the client offers APPLY only when true. */
	can_apply: boolean;
	last_run: ReturnType<typeof lastReconcileRun>;
}

/** May `principal` apply a definition of this policy through the widget? */
function principalMayApply(policy: ReconcileApplyPolicy, principal: Principal): boolean {
	if (policy === 'refused') return false;
	return policy === 'admin' || principal.userId === SUPERUSER_ID;
}

function rowOf(definition: ReconcileDefinition, principal: Principal): ReconcileStatusRow {
	const apply = applyPolicyOf(definition);
	return {
		name: definition.name,
		stores: [definition.stores[0], definition.stores[1]],
		description: definition.description,
		scope_label: definition.scopeLabel,
		schedule: definition.schedule,
		auto_apply: definition.autoApply?.reason ?? null,
		apply,
		apply_reason: applyPolicyReason(definition),
		can_apply: principalMayApply(apply, principal),
		last_run: lastReconcileRun(definition.name),
	};
}

async function reconcileRows(principal: Principal): Promise<ReconcileStatusRow[]> {
	return (await registerAllReconciles()).map((definition) => rowOf(definition, principal));
}

async function reconcileStatusGetValue(
	_options: Record<string, unknown>,
	principal: Principal,
): Promise<WidgetResponse> {
	return { data: { reconciles: await reconcileRows(principal) } };
}

/**
 * A definition declaring `applyRootOnly` (e.g. media_copy: it puts and deletes files on a
 * public machine, E10) refuses an APPLY from any principal but root, before it runs. A dry
 * run stays admin-level. The listing says so first (`can_apply: false`), so the client never
 * offers that APPLY: this `perm.denied` answers a request no rendered button sends. (An
 * `applyRefused` definition is refused by the registry itself, `request.invalid`.)
 */
function requireApplyPrincipal(name: string, apply: boolean, principal: Principal): void {
	const definition = getReconcile(name);
	if (!apply || definition === null || applyPolicyOf(definition) !== 'root') return;
	if (principal.userId === SUPERUSER_ID) return;
	throw new DedaloError('perm.denied', {
		message: `only the root user can apply the '${name}' reconcile`,
	});
}

/**
 * What a run found but could not repair: the owner's `missing` / `held` / `failed`
 * LISTS (rich_text_images: a referenced file absent from the web folder is never
 * drift). Counters of the same name elsewhere are not lists and are not read.
 */
function unresolvedNote(report: ReconcileReport): string {
	const parts = (['missing', 'held', 'failed'] as const).flatMap((key) => {
		const list = report.detail[key];
		return Array.isArray(list) && list.length > 0 ? [`${key} ${list.length}`] : [];
	});
	return parts.length === 0 ? '' : `; unresolved: ${parts.join(', ')} — see the report`;
}

/** The operator sentence for one run: in sync, repaired, DEFERRED (nothing applied, owed), or dry. */
export function runMessage(name: string, apply: boolean, report: ReconcileReport): string {
	if (report.deferred !== undefined) {
		return `${name}: drift ${report.drift}, nothing applied — DEFERRED: ${report.deferred.reason}. Run it again`;
	}
	const note = unresolvedNote(report);
	if (report.drift === 0) {
		return note === ''
			? `OK. ${name}: the two stores agree (drift 0)`
			: `${name}: drift 0, nothing to repair${note}`;
	}
	return apply
		? `${name}: drift ${report.drift}, applied ${report.applied}${note}`
		: `${name}: drift ${report.drift} — dry run, nothing written. Run with apply to repair${note}`;
}

/**
 * reconcile_status.run_reconcile — run ONE registered reconcile.
 * options: { name, apply?: boolean (default false), scope?: string[] }.
 */
async function reconcileStatusRunReconcile(
	options: Record<string, unknown>,
	principal: Principal,
): Promise<WidgetResponse> {
	await registerAllReconciles();
	const name = typeof options.name === 'string' ? options.name : '';
	const apply = options.apply === true;
	requireApplyPrincipal(name, apply, principal);
	let scope: ReconcileScope | undefined;
	if (options.scope !== undefined && options.scope !== null) {
		if (!Array.isArray(options.scope) || !options.scope.every((v) => typeof v === 'string')) {
			throw new DedaloError('request.invalid', {
				publicMessage: 'scope must be an array of strings',
				coordinates: { widget_action: 'reconcile_status.run_reconcile' },
			});
		}
		scope = options.scope as string[];
	}
	let outcome: Awaited<ReturnType<typeof runReconcile>>;
	try {
		outcome = await runReconcile(name, { apply, ...(scope === undefined ? {} : { scope }) });
	} catch (error) {
		if (error instanceof DedaloError && error.code === 'resource.not_found') {
			return { data: false, msg: `Error. Unknown reconcile '${name}'` };
		}
		throw error;
	}
	const { report, record } = outcome;
	const rows = await reconcileRows(principal);
	return {
		data: true,
		msg: runMessage(name, apply, report),
		extend: { report, record, reconciles: rows },
	};
}

export const widget: WidgetModule = {
	spec: {
		id: 'reconcile_status',
		category: 'integrity',
		label: { kind: 'literal', text: 'Reconcile' },
	},
	apiActions: {
		run_reconcile: reconcileStatusRunReconcile,
	},
	// A reconcile walks every mirror of its stores: maintenance (PERF-11).
	unboundedActions: ['run_reconcile'],
	getValue: reconcileStatusGetValue,
};
