/**
 * Maintenance-widget REGISTRY (S2-23 split) — assembles the per-widget
 * modules (`widgets/<widget_id>.ts`, each exporting ONE WidgetModule) into:
 *
 *  - the ordered dashboard CATALOG (PHP area_maintenance::get_ar_widgets +
 *    widget_factory — same order, labels in the application language);
 *  - the widget_request dispatch (PHP dd_area_maintenance_api::widget_request
 *    — the four gates + each module's explicit apiActions registry);
 *  - the get_widget_value dispatch (ALWAYS the widget's getValue; widgets
 *    without one return the PHP unavailable-class error shape).
 *
 * Adding a widget = ONE new module file + ONE import line here (the
 * tools/loader.ts pattern; static imports are fine — mirrors the client's
 * per-widget directory layout).
 *
 * Labels resolve from the same dictionary the client is served as
 * `get_label` (src/core/labels/catalog.ts repo catalogs, WC-033), falling
 * back to PHP's exact behaviors: `<mark>key</mark>` for a missing term, the
 * mark-detection literal fallback for config_areas/menu_skip_tipos.
 */

import { config } from '../../../config/config.ts';
import { typedMaintenanceLockWait, withUnboundedStatements } from '../../db/postgres.ts';
import { DedaloError } from '../../errors/dedalo_error.ts';
import { getLabels } from '../../labels/catalog.ts';
import { currentApplicationLang } from '../../resolve/request_lang.ts';
import type { Principal } from '../../security/permissions.ts';
import { widget as add_hierarchy } from './add_hierarchy.ts';
import { widget as ai_models } from './ai_models.ts';
import { widget as build_database_version } from './build_database_version.ts';
import { widget as check_config } from './check_config.ts';
import { widget as config_areas } from './config_areas.ts';
import { widget as counters_status } from './counters_status.ts';
import { widget as database_info } from './database_info.ts';
import { widget as dataframe_control } from './dataframe_control.ts';
import { widget as dedalo_api_test_environment } from './dedalo_api_test_environment.ts';
import { widget as diffusion_server_control } from './diffusion_server_control.ts';
import { widget as environment } from './environment.ts';
import { widget as error_reports } from './error_reports.ts';
import { widget as export_hierarchy } from './export_hierarchy.ts';
import { widget as lock_components } from './lock_components.ts';
import { widget as make_backup } from './make_backup.ts';
import { widget as media_control } from './media_control.ts';
import { widget as menu_skip_tipos } from './menu_skip_tipos.ts';
import { widget as move_lang } from './move_lang.ts';
import { widget as move_locator } from './move_locator.ts';
import { widget as move_tld } from './move_tld.ts';
import { widget as move_to_portal } from './move_to_portal.ts';
import { widget as move_to_table } from './move_to_table.ts';
import { widget as publication_api } from './publication_api.ts';
import { widget as publication_hosts } from './publication_hosts.ts';
import { widget as reconcile_status } from './reconcile_status.ts';
import { widget as register_tools } from './register_tools.ts';
import { widget as runtime_info } from './runtime_info.ts';
import { widget as sequences_status } from './sequences_status.ts';
import { widget as serve_code, servesCode } from './serve_code.ts';
import { widget as serve_ontology } from './serve_ontology.ts';
import { widget as site_builder_status } from './site_builder_status.ts';
import { widget as sqo_test_environment } from './sqo_test_environment.ts';
import type { LabelRule, WidgetHandler, WidgetModule, WidgetResponse } from './support.ts';
import { widget as system_info } from './system_info.ts';
import { widget as unit_test } from './unit_test.ts';
import { widget as update_code } from './update_code.ts';
import { widget as update_data_version } from './update_data_version.ts';
import { widget as update_ontology } from './update_ontology.ts';

/** The maintenance area tipo (model area_maintenance). */
export const MAINTENANCE_AREA_TIPO = 'dd88';

export interface MaintenanceWidget {
	id: string;
	class: string | null;
	category: string;
	type: 'widget';
	tipo: string;
	parent: string;
	label: string;
	info: null;
	body: null;
	run: [];
	trigger: null;
	value: Record<string, unknown> | null;
	background: boolean;
}

/**
 * Every widget module that EXISTS IN THE CODE, ungated — the total EXECUTE surface.
 *
 * This is what update_ownership_tripwire classifies. It must NOT be the config-gated
 * catalog below: `error_reports` only joins that catalog when this installation
 * participates in error reporting, so on a machine whose ../private/.env disables it
 * (every bare CI runner) the widget disappears and its ENGINE_NATIVE exemption looks
 * "rotted". The gate's verdict would then depend on the developer's .env rather than
 * on the code — it passed locally and failed on the first real CI run (2026-07-11).
 * Ownership is a property of the code, so classify the code.
 */
const CORE_WIDGET_MODULES: readonly WidgetModule[] = [
	make_backup,
	check_config,
	config_areas,
	menu_skip_tipos,
	update_ontology,
	serve_ontology,
	register_tools,
	move_tld,
	move_locator,
	move_to_portal,
	move_to_table,
	move_lang,
	build_database_version,
	update_data_version,
	update_code,
	export_hierarchy,
	publication_api,
	diffusion_server_control,
	add_hierarchy,
	dedalo_api_test_environment,
	sqo_test_environment,
	lock_components,
	database_info,
	environment,
	unit_test,
	sequences_status,
	media_control,
	counters_status,
	reconcile_status,
	dataframe_control,
	runtime_info,
	system_info,
	site_builder_status,
	publication_hosts,
	ai_models,
];

/** The total surface: every module in the code, gated or not. Ownership classifies THIS. */
export const ALL_WIDGET_MODULES: readonly WidgetModule[] = [
	...CORE_WIDGET_MODULES,
	serve_code,
	error_reports,
];

/**
 * The ordered catalog THIS INSTALLATION serves — one module per PHP get_ar_widgets
 * block, same order.
 *
 * TS-only (WC-018): the catalog gains the error-report browser on any installation
 * that PARTICIPATES in error reporting — a master (receiver enabled, browses stored
 * reports) OR a sender (a master URL configured, shows the relay target).
 * Installations that do neither keep a catalog byte-identical to the PHP oracle
 * (widgets_differential filters the id). Runtime behaviour is unchanged by the
 * ALL_WIDGET_MODULES split above.
 */
export const WIDGET_MODULES: readonly WidgetModule[] = [
	// serve_code (WC-2026-09-28-maintenance-serve-code-widget) sits right after
	// update_code, and only where it can act — a code server or the development
	// entity. Elsewhere it is neither in the catalog nor reachable through
	// widget_request (MODULE_BY_ID below).
	...CORE_WIDGET_MODULES.flatMap((module) =>
		module === update_code && servesCode() ? [module, serve_code] : [module],
	),
	...(config.errorReport.receiverEnabled || config.errorReport.masterApiUrl ? [error_reports] : []),
];

const MODULE_BY_ID: ReadonlyMap<string, WidgetModule> = new Map(
	WIDGET_MODULES.map((module) => [module.spec.id, module]),
);

/**
 * The catalog widget ids (static, in order). Used by the widget_request dispatch
 * gate to validate a requested widget id WITHOUT rebuilding the full catalog (so
 * an action never pays for the eager per-widget values below).
 */
export const MAINTENANCE_WIDGET_IDS: readonly string[] = WIDGET_MODULES.map(
	(module) => module.spec.id,
);

/** PHP label::get_label — the dictionary term, or `<mark>key</mark>` when missing. */
function resolveLabel(labels: Record<string, string>, key: string): string {
	return labels[key] ?? `<mark>${key}</mark>`;
}

export function labelFor(labels: Record<string, string>, rule: LabelRule): string {
	switch (rule.kind) {
		case 'label':
			// PHP `get_label(key) ?? fallback` — get_label never returns null in
			// practice (missing keys come back marked), so the marked key wins.
			return resolveLabel(labels, rule.key);
		case 'label_mark_fallback': {
			const resolved = resolveLabel(labels, rule.key);
			return resolved.includes('<mark') ? rule.literal : resolved;
		}
		case 'label_concat':
			return `${resolveLabel(labels, rule.keys[0])} ${resolveLabel(labels, rule.keys[1])}`;
		case 'literal':
			return rule.text;
	}
}

/**
 * Compute ONE widget's eager catalog value, FAIL-SOFT
 * (WC-2026-08-10-maintenance-catalog-fail-soft).
 *
 * Best-effort by oracle contract: PHP computes these inside get_ar_widgets and
 * a single failing block never withheld the dashboard. The eager values are the
 * DB-touching ones (checkSequences, lock_components' active-lock read,
 * publication_api's diffusion scan, check_config's connection probe), so a
 * rejecting widget is EXPECTED on a degraded install — and that is precisely
 * when the operator needs the dashboard that would let them fix it.
 *
 * Degraded behaviour: the widget joins the catalog with `value: null` — the
 * same shape a widget with no eagerValue serves, which the client already
 * renders (an error-object `value` would instead be a wire change, and the
 * panel-load getValue path still reports the real failure). The failure is
 * reported per CONVENTIONS §1: never silent.
 */
async function eagerValueOf(module: WidgetModule): Promise<MaintenanceWidget['value']> {
	try {
		return ((await module.eagerValue?.()) ?? null) as MaintenanceWidget['value'];
	} catch (error) {
		console.error(
			`[area_maintenance] widget eager value failed, serving null widget=${module.spec.id}`,
			error,
		);
		return null;
	}
}

/**
 * Build the full ordered widget catalog (PHP get_ar_widgets), labels in the
 * application language. Eager per-widget values come from each module's
 * eagerValue (PHP computes these inside get_ar_widgets; fail-soft — a widget
 * value failure must never break the dashboard read: see eagerValueOf).
 *
 * `modules` is a TEST SEAM (default = the served catalog): WIDGET_MODULES is a
 * module-level const, so proving the fail-soft otherwise requires a real widget
 * to break. Production callers never pass it.
 */
export async function getMaintenanceWidgets(
	modules: readonly WidgetModule[] = WIDGET_MODULES,
): Promise<MaintenanceWidget[]> {
	const labels = await getLabels(currentApplicationLang());
	const widgets: MaintenanceWidget[] = [];
	for (const module of modules) {
		const spec = module.spec;
		widgets.push({
			id: spec.id,
			class: spec.class ?? null,
			category: spec.category,
			type: 'widget' as const,
			tipo: MAINTENANCE_AREA_TIPO,
			parent: MAINTENANCE_AREA_TIPO,
			label: labelFor(labels, spec.label),
			info: null,
			body: null,
			run: [] as [],
			trigger: null,
			value: await eagerValueOf(module),
			background: spec.background ?? false,
		});
	}
	return widgets;
}

/**
 * The maintenance area's get_data item (PHP area_maintenance_json): the
 * widget catalog rides as `datalist` on one data item.
 */
export async function buildMaintenanceDataItem(): Promise<Record<string, unknown>> {
	return {
		section_id: null,
		section_tipo: MAINTENANCE_AREA_TIPO,
		tipo: MAINTENANCE_AREA_TIPO,
		pagination: null,
		from_component_tipo: MAINTENANCE_AREA_TIPO,
		value: [],
		datalist: await getMaintenanceWidgets(),
	};
}

/**
 * The admin gate both dispatchers open with: the maintenance area is a
 * global-admin surface (`perm.denied`, 403 — the message names nothing,
 * it is shown to the refused user).
 */
function requireMaintenanceAdmin(principal: Principal): void {
	if (!principal.isGlobalAdmin) {
		throw new DedaloError('perm.denied', {
			message: 'maintenance widgets are an admin surface',
		});
	}
}

/** Dispatch one get_widget_value RQO (admin-gated like the PHP manager). */
export async function dispatchGetWidgetValue(
	principal: Principal,
	source: { model?: unknown },
): Promise<WidgetResponse> {
	requireMaintenanceAdmin(principal);
	const widgetId = typeof source.model === 'string' ? source.model : '';
	if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(widgetId)) {
		throw new DedaloError('maintenance.widget_unknown', { coordinates: { widget: widgetId } });
	}
	const handler = MODULE_BY_ID.get(widgetId)?.getValue;
	if (handler === undefined) {
		// unported panel — loud and ledgered, like the PHP missing-class refusal
		throw new DedaloError('maintenance.widget_unavailable', {
			publicMessage: `Error. The '${widgetId}' panel is not available on this engine.`,
			coordinates: { widget: widgetId },
		});
	}
	return handler({}, principal);
}

/**
 * Dispatch one widget_request RQO through all gates (PHP
 * dd_area_maintenance_api::widget_request; spec §7.1 — a widget method exists
 * on this API only if its module registers it):
 *
 *  1. ADMIN-ONLY — the maintenance area is a global-admin surface;
 *  2. options must be an object (PHP type guard);
 *  3. the widget id must be in the maintenance catalog;
 *  4. the method must be registered (`tool.method_not_allowed` otherwise);
 *  5. the door's precondition class (core/update/door_class.ts).
 *
 * A handler the widget declares maintenance then runs inside
 * `withUnboundedStatements` (see below); every other one stays bounded.
 */
export async function dispatchWidgetRequest(
	principal: Principal,
	source: { model?: unknown; action?: unknown },
	options: unknown,
): Promise<WidgetResponse> {
	// Gate 1: admin-only surface.
	requireMaintenanceAdmin(principal);
	// Gate 2: options must be an object when present.
	if (options !== undefined && (typeof options !== 'object' || options === null)) {
		throw new DedaloError('request.invalid_options', { publicMessage: 'invalid options' });
	}
	const widgetId = typeof source.model === 'string' ? source.model : '';
	const method = typeof source.action === 'string' ? source.action : '';

	// Gate 3: the widget must exist in the maintenance catalog. Membership is a
	// cheap id check against the static module list — NOT a full
	// getMaintenanceWidgets() build, so an action never pays for the catalog's
	// eager per-widget values.
	const module = MODULE_BY_ID.get(widgetId);
	if (module === undefined) {
		throw new DedaloError('maintenance.widget_unknown', { coordinates: { widget: widgetId } });
	}

	// Gate 4: explicit method registry. Resolve with Object.hasOwn + a
	// typeof-function guard (OPS-03/TOOLS-11, 2026-07-28 audit): a bare
	// `apiActions?.[method]` would let a prototype-chain key (`__proto__`,
	// `constructor`, `toString`) reflect an inherited Object method as a
	// "handler" — the API-01 vector the prior audit closed in dispatch.ts but
	// not here.
	const handler =
		typeof method === 'string' &&
		module.apiActions !== undefined &&
		Object.hasOwn(module.apiActions, method)
			? module.apiActions[method]
			: undefined;
	if (typeof handler !== 'function') {
		throw new DedaloError('tool.method_not_allowed', {
			details: { method },
			coordinates: { widget: widgetId },
		});
	}

	// THE UNBOUNDED DOOR (PERF-11), PER ACTION: an action the widget DECLARES
	// maintenance (`unboundedActions` — a store rebuild, a VACUUM, a move_* bulk
	// transform) must not die on the request pool's statement ceiling (nor for
	// merely queueing behind a reader's lock). Its scope is entered HERE, before
	// the handler opens any transaction, so even its in-transaction statements
	// run on the maintenance pool. Every other action — and every panel load
	// (dispatchGetWidgetValue) — stays on the request pool and its ceiling: the
	// maintenance pool is small, and a cheap read must not queue behind a
	// REINDEX. Background jobs a handler submits are detached and inherit
	// nothing: the ones that must be unbounded declare their own scope.
	// The CEILING is lifted, the LOCK-WAIT bound is not: the maintenance pool is
	// born with a lock_timeout (postgres.ts MAINTENANCE_LOCK_TIMEOUT), so an
	// action queued for ACCESS EXCLUSIVE behind a long reader gives up instead of
	// stalling every reader queued behind it; escaping, it is the typed 503.
	return runAtDoor(module, `${widgetId}.${method}`, method, handler, principal, options);
}

/**
 * Gate 5 and the run: THE DOOR'S PRECONDITION CLASS (update audit 2026-10-29,
 * Phase 2.8; core/update/door_class.ts) — a destructive_shared door needs the
 * superuser, maintenance, a fresh backup (or a logged waiver), no update run in
 * flight, and holds the UPDATE_RUN lock while it runs; an unclassified door is
 * refused — then the handler, bounded or not (see the caller).
 */
async function runAtDoor(
	module: WidgetModule,
	what: string,
	method: string,
	handler: WidgetHandler,
	principal: Principal,
	options: unknown,
): Promise<WidgetResponse> {
	const request = (options ?? {}) as Record<string, unknown>;
	const { enterDoor } = await import('../../update/door_class.ts');
	const release = await enterDoor(what, principal, request);
	const run = () => handler(request, principal);
	try {
		if (!isUnboundedAction(module, method)) return await run();
		return await withUnboundedStatements(run).catch((error: unknown) => {
			throw typedMaintenanceLockWait(error);
		});
	} finally {
		await release();
	}
}

/** Whether `method` is one of the actions `module` declares maintenance (see WidgetModule). */
export function isUnboundedAction(module: WidgetModule, method: string): boolean {
	return module.unboundedActions?.includes(method) === true;
}

// The lock_components AREA-LEVEL action (PHP class_request) — owned by its
// widget module, surfaced here so the API handler has ONE import site.
export { dispatchLockComponentsActions } from './lock_components.ts';
export type { WidgetResponse } from './support.ts';
