/**
 * dd_area_maintenance_api handlers (WS-C S2-25 extraction — bodies moved
 * VERBATIM from api/dispatch.ts; dispatch keeps registry assembly + gates +
 * envelope).
 *
 * THE ONE WRAPPING SITE for the maintenance surface (engineering/ERRORS_SPEC.md
 * §4): a widget answers with its PAYLOAD (`WidgetResponse` — data + the
 * top-level keys the panel reads by name) and FAILS by throwing a DedaloError,
 * which the dispatch catch converts. `widgetEnvelope` below is the only place
 * that payload becomes a body.
 */

import type { WidgetResponse } from '../../area_maintenance/widgets/support.ts';
import { ok } from '../../errors/index.ts';
import { type ActionHandler, requirePrincipal } from '../handler_context.ts';
import type { ApiResult } from '../response.ts';

/**
 * One widget payload → the ok envelope. `msg` / `errors` / the widget's own
 * `extend` keys ride as EXTENSION KEYS (ERRORS_SPEC §3.0 — the names the
 * maintenance client already reads); an absent msg and an empty errors list
 * emit no key at all, exactly as the panel expects.
 */
function widgetEnvelope(out: WidgetResponse, requestId: string): ApiResult {
	return {
		status: 200,
		body: ok(out.data, {
			requestId,
			extend: {
				...out.extend,
				...(out.msg === undefined ? {} : { msg: out.msg }),
				...(out.errors === undefined || out.errors.length === 0 ? {} : { errors: out.errors }),
			},
		}),
	};
}

/** dd_area_maintenance_api action handlers (registered in dispatch.ts). */
export const areaMaintenanceApiActions: Record<string, ActionHandler> = {
	widget_request: async (rqo, context) => {
		// Maintenance-widget execution (PHP dd_area_maintenance_api) — all
		// gates + the explicit widget registry live in widgets/registry.ts.
		const principal = requirePrincipal(context);
		const { dispatchWidgetRequest } = await import('../../area_maintenance/widgets/registry.ts');
		const out = await dispatchWidgetRequest(
			principal,
			(rqo.source ?? {}) as { model?: unknown; action?: unknown },
			rqo.options,
		);
		return widgetEnvelope(out, context.requestId);
	},
	get_widget_value: async (rqo, context) => {
		// Panel value load (PHP get_widget_value: ALWAYS the widget's static
		// get_value) — explicit GET_VALUE registry in widgets/registry.ts.
		const principal = requirePrincipal(context);
		const { dispatchGetWidgetValue } = await import('../../area_maintenance/widgets/registry.ts');
		const out = await dispatchGetWidgetValue(principal, (rqo.source ?? {}) as { model?: unknown });
		return widgetEnvelope(out, context.requestId);
	},
	lock_components_actions: async (rqo, context) => {
		// lock_components widget area-level action (PHP dd_area_maintenance_api::
		// lock_components_actions). Admin-gated inside the dispatcher. fn_action ∈
		// {get_active_users, force_unlock_all_components}.
		const principal = requirePrincipal(context);
		const { dispatchLockComponentsActions } = await import(
			'../../area_maintenance/widgets/registry.ts'
		);
		const out = await dispatchLockComponentsActions(
			principal,
			(rqo.options ?? {}) as Record<string, unknown>,
		);
		return widgetEnvelope(out, context.requestId);
	},
	parse_simple_schema_changes_files: async (rqo, context) => {
		// component_security_access "Latest changes": one ontology schema-change
		// file, labelled (PHP dd_area_maintenance_api::parse_simple_schema_changes_files).
		// Admin-gated like every maintenance action (PHP: the whole api needed dd88).
		const principal = requirePrincipal(context);
		const { requireMaintenanceAdmin } = await import('../../area_maintenance/widgets/registry.ts');
		requireMaintenanceAdmin(principal);
		const { parseSchemaChangesFile } = await import('../../ontology/schema_changes.ts');
		const options = (rqo.options ?? {}) as { filename?: unknown };
		return widgetEnvelope(
			{ data: await parseSchemaChangesFile(options.filename) },
			context.requestId,
		);
	},
};
