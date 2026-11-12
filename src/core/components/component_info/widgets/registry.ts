/**
 * component_info WIDGET REGISTRY — the server-side read-time compute (PHP
 * component_info::get_data → widget_common::get_instance → <widget>::get_data).
 *
 * A component_info (and component_calculation / component_state, which map to
 * component_info at runtime) has NO stored row data of its own by default; the
 * section read serves the STORED misc value when the client save cycle has
 * persisted one (use_db_data — PHP get_db_data reads parent::get_data first),
 * and falls back to LIVE widget compute when the row holds nothing — null, [],
 * or (the one divergence) an array every entry of which is positively
 * identified v5-era `misc` residue
 * (WC-2026-08-09-info-legacy-stored-value-fallthrough). This
 * registry is that fallback: it resolves the ontology `properties.widgets`
 * definitions (widget_name + ipo Input-Process-Output blocks) and dispatches
 * BY NAME to the per-discipline widget modules under widgets/<tld>/ — the
 * flat item arrays the PHP widget classes produce, insertion-ordered
 * {widget, key, widget_id, value} objects (the STORED client shape uses `id`
 * instead of `widget_id`; the live fallback emits `widget_id`, verified
 * against live PHP 2026-07-02).
 *
 * Async widgets (isAsync — PHP is_async() true) are SKIPPED here exactly as
 * PHP skips them: they deliver via their own client API call (get_widget_data).
 *
 * The 'calculation' widget (calculation/calculation.ts) computes every
 * formula the shipped ontology declares over typed inputs
 * (components/calculation_data.ts); PHP crashed its summarize on any
 * non-empty input (WC-2026-11-12-calculation-widget-port).
 */

import { getNode } from '../../../ontology/resolver.ts';
import { calculation } from './calculation/calculation.ts';
import { user_activity } from './dd/user_activity.ts';
import { get_archive_states } from './dmm/get_archive_states.ts';
import { sum_dates } from './mdcat/sum_dates.ts';
import { get_archive_weights } from './numisdata/get_archive_weights.ts';
import { get_coins_by_period } from './numisdata/get_coins_by_period.ts';
import { descriptors } from './oh/descriptors.ts';
import { media_icons } from './oh/media_icons.ts';
import { tags } from './oh/tags.ts';
import { state } from './state/state.ts';
import { test_info } from './test/test_info.ts';
import {
	type InfoWidgetDescriptor,
	type WidgetContext,
	type WidgetDef,
	type WidgetItem,
	WidgetNotRegisteredError,
	WidgetUnportedError,
} from './widget_common.ts';

/** Every known widget, keyed by widget_name (globally unique across TLDs — PHP census). */
const INFO_WIDGETS: ReadonlyMap<string, InfoWidgetDescriptor> = new Map(
	[
		calculation,
		state,
		user_activity,
		get_archive_states,
		sum_dates,
		get_archive_weights,
		get_coins_by_period,
		descriptors,
		media_icons,
		tags,
		test_info,
	].map((descriptor) => [descriptor.name, descriptor]),
);

/**
 * Registry lookup by ontology widget_name. FAIL-LOUD (never-narrow law): an
 * unknown name throws (PHP fatals on its include-by-path too); a registered
 * stub throws WidgetUnportedError from its compute — callers that need the
 * descriptor identity (async check, path) still get it.
 */
export function getInfoWidget(name: string): InfoWidgetDescriptor {
	const descriptor = INFO_WIDGETS.get(name);
	if (descriptor === undefined) throw new WidgetNotRegisteredError(name);
	return descriptor;
}

/** All registered descriptors (tripwire + tooling surface). */
export function listInfoWidgets(): InfoWidgetDescriptor[] {
	return [...INFO_WIDGETS.values()];
}

/** The widget's server compute, or a loud throw when it is an unported stub. */
export function widgetComputeData(
	descriptor: InfoWidgetDescriptor,
): (ipo: unknown[], context: WidgetContext) => Promise<WidgetItem[]> {
	if ('unported' in descriptor) {
		return () => {
			throw new WidgetUnportedError(descriptor.name, descriptor.unported.reason);
		};
	}
	return descriptor.computeData;
}

/**
 * The read-time widget aggregate of one component_info (PHP get_db_data's
 * live-compute branch). Returns null when the component declares no widgets
 * (PHP get_widgets → null → get_data → null → entries null); otherwise the
 * concatenation of every non-async widget's items (possibly []).
 */
export async function computeInfoWidgets(
	componentTipo: string,
	context: WidgetContext,
): Promise<WidgetItem[] | null> {
	const node = await getNode(componentTipo);
	const widgets = (node?.properties as { widgets?: WidgetDef[] } | null)?.widgets;
	if (!Array.isArray(widgets) || widgets.length === 0) return null;

	const data: WidgetItem[] = [];
	for (const widget of widgets) {
		const descriptor = getInfoWidget(widget.widget_name ?? '');
		// async widgets deliver via get_widget_data — skipped BEFORE the
		// unported check (PHP skips them before instancing their compute).
		if (descriptor.isAsync === true) continue;
		const ipo = Array.isArray(widget.ipo) ? widget.ipo : [];
		const items = await widgetComputeData(descriptor)(ipo, context);
		if (items.length > 0) data.push(...items);
	}
	return data;
}

/**
 * The merged edit-mode datalist of one component_info (PHP get_data_list —
 * component_info_json edit branch): the concatenation of every widget's
 * computeDataList output. Only the state widget implements it today; widgets
 * without the facet contribute nothing (PHP widgets without get_data_list
 * return null). Unknown names throw exactly as computeInfoWidgets.
 */
export async function computeInfoDataList(
	componentTipo: string,
	context: WidgetContext,
): Promise<WidgetItem[]> {
	const node = await getNode(componentTipo);
	const widgets = (node?.properties as { widgets?: WidgetDef[] } | null)?.widgets;
	if (!Array.isArray(widgets) || widgets.length === 0) return [];

	const data: WidgetItem[] = [];
	for (const widget of widgets) {
		const descriptor = getInfoWidget(widget.widget_name ?? '');
		if ('unported' in descriptor || descriptor.computeDataList === undefined) continue;
		const ipo = Array.isArray(widget.ipo) ? widget.ipo : [];
		const items = await descriptor.computeDataList(ipo, context);
		if (items.length > 0) data.push(...items);
	}
	return data;
}
