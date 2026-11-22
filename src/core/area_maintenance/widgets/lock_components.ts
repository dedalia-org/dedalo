/**
 * lock_components widget — live component-lock status. The panel renders from
 * the eager catalog value (PHP eager load); the client also refreshes it via
 * the dd_area_maintenance_api `lock_components_actions` area-level action
 * (PHP class_request), which is NOT a widget_request — dispatched directly by
 * the API handler through dispatchLockComponentsActions below.
 */

import { DedaloError } from '../../errors/dedalo_error.ts';
import { canAccessMaintenanceArea, type Principal } from '../../security/permissions.ts';
import type { WidgetModule, WidgetResponse } from './support.ts';

/**
 * dd_area_maintenance_api.lock_components_actions — the lock_components widget's
 * area-level action (PHP class_request). Gated by THE maintenance rule. Dispatches on fn_action:
 *  - 'get_active_users' → the enriched live lock map ({result, ar_user_actions});
 *  - 'force_unlock_all_components' → clear ONE user's locks (options.user_id) or
 *    ALL locks (user_id null/empty), then report the freed count.
 * Returns the raw client-facing body (the client reads result/ar_user_actions
 * directly), not a widget_request envelope.
 */
export async function dispatchLockComponentsActions(
	principal: Principal,
	options: Record<string, unknown>,
): Promise<WidgetResponse> {
	// THE maintenance rule (T2-O15-2 — every maintenance dispatcher asks it)
	if (!(await canAccessMaintenanceArea(principal))) {
		throw new DedaloError('perm.denied', {
			message: 'maintenance widgets need the maintenance area',
		});
	}
	const fnAction = typeof options.fn_action === 'string' ? options.fn_action : '';
	const { getActiveLockUsers, forceUnlockAllComponents, forceUnlockAllUsers } = await import(
		'../../section/locks.ts'
	);
	switch (fnAction) {
		case 'get_active_users': {
			// `ar_user_actions` is a TOP-LEVEL key: render_lock_components.js:261
			// hands the refresh response straight to print_active_users, which reads
			// it there (the eager catalog value nests it under `active_users`).
			const active = await getActiveLockUsers();
			return { data: active.result, extend: { ar_user_actions: active.ar_user_actions } };
		}
		case 'force_unlock_all_components': {
			const rawUser = options.user_id;
			const hasUser = rawUser !== null && rawUser !== undefined && String(rawUser) !== '';
			const freed = hasUser
				? await forceUnlockAllComponents(Number(rawUser))
				: await forceUnlockAllUsers();
			return {
				data: true,
				msg: `OK. ${freed} lock(s) released${hasUser ? ` for user ${String(rawUser)}` : ' (all users)'}`,
				extend: { freed },
			};
		}
		default:
			throw new DedaloError('maintenance.invalid_fn_action', {
				coordinates: { fn_action: fnAction },
			});
	}
}

export const widget: WidgetModule = {
	spec: {
		id: 'lock_components',
		category: 'integrity',
		class: 'width_100',
		label: { kind: 'literal', text: 'Lock components status' },
	},
	eagerValue: async () => {
		// The lock_components panel renders from this on open (PHP eager load);
		// the client also refreshes it via lock_components_actions.get_active_users.
		const { getActiveLockUsers } = await import('../../section/locks.ts');
		return { active_users: await getActiveLockUsers() };
	},
};
