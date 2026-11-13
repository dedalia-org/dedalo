/**
 * component_info WIDGET REGISTRY — the server-side read-time compute (PHP
 * component_info::get_data → widget_common::get_instance → <widget>::get_data).
 *
 * A component_info (and component_calculation / component_state, which map to
 * component_info at runtime) has NO stored value: every door — the section
 * read, diffusion (diffusion/resolve/info_value.ts), the export walk and the
 * flat readers (computeInfoOutputs) — serves the LIVE widget compute, and a
 * stored `misc` slot is never served
 * (WC-2026-09-03-info-stored-value-never-served, which repealed PHP's
 * use_db_data stored-wins rule). This
 * registry is that compute: it resolves the ontology `properties.widgets`
 * definitions (widget_name + ipo Input-Process-Output blocks) and dispatches
 * BY NAME to the per-discipline widget modules under widgets/<tld>/ — the
 * flat item arrays the PHP widget classes produce, insertion-ordered
 * {widget, key, widget_id, value} objects (the STORED client shape uses `id`
 * instead of `widget_id`; the live fallback emits `widget_id`, verified
 * against live PHP 2026-07-02).
 *
 * Async widgets (isAsync — PHP is_async() true) are SKIPPED on the read/edit
 * path exactly as PHP skips them: they deliver via their own client API call
 * (get_widget_data). A door that sets `WidgetContext.includeAsync` — the
 * publication and export doors (owner C9 2026-11-13,
 * WC-2026-11-13-info-derived-async-published) — computes them too: v6
 * published the user_activity column, PHP v7 published NULL.
 *
 * Two faces of one component (PHP get_data vs get_data_parsed):
 *   computeInfoWidgets        the RAW items (the section read, observers,
 *                             calculation inputs, the export dedalo_raw cell);
 *   computeInfoWidgetsParsed  the PARSED face (grid / export / publication —
 *                             sum_dates humanizes its intervals there), every
 *                             item stamped with its `widget` name (+ `key`)
 *                             when the widget's parsed face omits them, so a
 *                             `parser_info::widget` match on `widget` +
 *                             `id|widget_id` finds it (owner D1 2026-11-13).
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
 * The widget's get_data_parsed face (PHP widget_common::get_data_parsed — the
 * grid / export face; mdcat sum_dates humanizes its intervals there): its
 * `computeDataParsed`, else its computeData. An unported stub throws.
 */
export function widgetComputeDataParsed(
	descriptor: InfoWidgetDescriptor,
): (ipo: unknown[], context: WidgetContext) => Promise<WidgetItem[]> {
	if ('unported' in descriptor) return widgetComputeData(descriptor);
	return descriptor.computeDataParsed ?? descriptor.computeData;
}

/** One declared widget output of a component_info and the values it resolved. */
export interface InfoWidgetOutput {
	widgetName: string;
	/** Position of its ipo block in the widget's `ipo` array (the item `key`). */
	ipoKey: number;
	/** The ontology output id — the export column's `sub_id`. */
	outputId: string;
	/** Every matching item's `value`, in item order (possibly none). */
	values: unknown[];
}

/**
 * Does one computed item belong to (ipo block `ipoKey`, output `outputId`)?
 * The output id is carried as `id` (stored / calculation) or `widget_id`
 * (live weights / state — WC-026 dualises both); `key` names the ipo block
 * when the widget emits it (the parsed faces of some widgets — sum_dates —
 * carry neither `key` nor `widget`, and are attributed by the per-widget loop;
 * computeInfoWidgetsParsed stamps them for the publication door).
 */
export function infoItemMatchesOutput(item: unknown, ipoKey: number, outputId: string): boolean {
	if (!isPlainItem(item)) return false;
	if (item.key !== undefined && item.key !== ipoKey) return false;
	return item.id === outputId || item.widget_id === outputId;
}

function isPlainItem(item: unknown): item is Record<string, unknown> {
	return item !== null && typeof item === 'object' && !Array.isArray(item);
}

/** The component's ontology-declared widgets, or null when it declares none. */
async function declaredWidgets(componentTipo: string): Promise<WidgetDef[] | null> {
	const node = await getNode(componentTipo);
	const widgets = (node?.properties as { widgets?: WidgetDef[] } | null)?.widgets;
	return Array.isArray(widgets) && widgets.length > 0 ? widgets : null;
}

/**
 * Is this widget computed by the door `context` describes? An async widget
 * only when the door asked for it (includeAsync — publication / export); the
 * read/edit path skips it BEFORE the unported check, as PHP skipped it before
 * instancing its compute.
 */
function computesWidget(descriptor: InfoWidgetDescriptor, context: WidgetContext): boolean {
	return descriptor.isAsync !== true || context.includeAsync === true;
}

/** One widget's parsed items; an async widget yields none unless the door includes them. */
function widgetParsedItems(
	descriptor: InfoWidgetDescriptor,
	ipo: unknown[],
	context: WidgetContext,
): Promise<WidgetItem[]> {
	if (!computesWidget(descriptor, context)) return Promise.resolve([]);
	return widgetComputeDataParsed(descriptor)(ipo, context);
}

/**
 * EVERY declared output of one component_info, with its LIVE parsed values
 * (PHP component_info::get_export_value :778-823 — get_data_parsed, then one
 * atom per `widgets[].ipo[].output[]`, in declaration order). Each widget is
 * computed on its own, so an output only ever matches its own widget's items
 * (PHP matched on id alone across every widget). An async widget is computed
 * only for a door that includes them (the export sets includeAsync; the
 * request-path flat readers do not — its outputs stay declared, with no
 * value). Null when the component declares no widgets.
 */
export async function computeInfoOutputs(
	componentTipo: string,
	context: WidgetContext,
): Promise<InfoWidgetOutput[] | null> {
	const widgets = await declaredWidgets(componentTipo);
	if (widgets === null) return null;
	const outputs: InfoWidgetOutput[] = [];
	for (const widget of widgets) {
		const widgetName = widget.widget_name ?? '';
		const ipo = Array.isArray(widget.ipo) ? widget.ipo : [];
		const items = await widgetParsedItems(getInfoWidget(widgetName), ipo, context);
		outputs.push(...declaredOutputs(widgetName, ipo, items));
	}
	return outputs;
}

/** The declared outputs of one widget's ipo blocks, each with its matched values. */
function declaredOutputs(
	widgetName: string,
	ipo: unknown[],
	items: WidgetItem[],
): InfoWidgetOutput[] {
	const outputs: InfoWidgetOutput[] = [];
	for (const [ipoKey, block] of ipo.entries()) {
		const declared = (block as { output?: unknown } | null)?.output;
		if (!Array.isArray(declared)) continue;
		for (const output of declared) {
			const outputId = (output as { id?: unknown } | null)?.id;
			if (typeof outputId !== 'string' || outputId === '') continue;
			const values = items
				.filter((item) => infoItemMatchesOutput(item, ipoKey, outputId))
				.map((item) => item.value);
			outputs.push({ widgetName, ipoKey, outputId, values });
		}
	}
	return outputs;
}

/**
 * An output value as a flat export string (PHP get_export_value: objects and
 * arrays JSON-encoded). Null / undefined → '' (no value); booleans and
 * numbers by their JS string form.
 */
export function infoOutputValueString(value: unknown): string {
	if (value === null || value === undefined) return '';
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return JSON.stringify(value);
}

/**
 * The read-time widget aggregate of one component_info (PHP get_db_data's
 * live-compute branch). Returns null when the component declares no widgets
 * (PHP get_widgets → null → get_data → null → entries null); otherwise the
 * concatenation of every computed widget's RAW items (possibly []) — async
 * widgets only for a door that includes them (computesWidget).
 */
export async function computeInfoWidgets(
	componentTipo: string,
	context: WidgetContext,
): Promise<WidgetItem[] | null> {
	const widgets = await declaredWidgets(componentTipo);
	if (widgets === null) return null;

	const data: WidgetItem[] = [];
	for (const widget of widgets) {
		const descriptor = getInfoWidget(widget.widget_name ?? '');
		if (!computesWidget(descriptor, context)) continue;
		const ipo = Array.isArray(widget.ipo) ? widget.ipo : [];
		const items = await widgetComputeData(descriptor)(ipo, context);
		if (items.length > 0) data.push(...items);
	}
	return data;
}

/**
 * The PARSED face of one component_info (PHP get_data_parsed — what the grid,
 * the export and the publication read): per widget its `computeDataParsed`,
 * else its `computeData` (widgetComputeDataParsed), concatenated in widget
 * order; async widgets per the door (computesWidget). Null when the component
 * declares no widgets, as computeInfoWidgets.
 *
 * Every item is STAMPED with the widget it came from when the parsed face
 * omits it (owner D1 2026-11-13; WC-2026-11-13-info-derived-async-published):
 * `widget` = the widget_name always; `key` = the ipo block index only when the
 * widget declares ONE block (a parsed face computed over several blocks that
 * names no block cannot be attributed to one — stamping a guess would be
 * fabrication, so `key` stays absent there). sum_dates' parsed items carry
 * only `widget_id`, so without the stamp `parser_info::widget` (which matches
 * on `widget` + `id|widget_id`) matched nothing and mdcat1181 published NULL.
 * The raw face is never stamped: a stamp there would hide a widget emitting a
 * malformed item.
 */
export async function computeInfoWidgetsParsed(
	componentTipo: string,
	context: WidgetContext,
): Promise<WidgetItem[] | null> {
	const widgets = await declaredWidgets(componentTipo);
	if (widgets === null) return null;

	const data: WidgetItem[] = [];
	for (const widget of widgets) {
		const widgetName = widget.widget_name ?? '';
		const ipo = Array.isArray(widget.ipo) ? widget.ipo : [];
		const items = await widgetParsedItems(getInfoWidget(widgetName), ipo, context);
		data.push(...items.map((item) => stampWidgetItem(item, widgetName, ipo.length)));
	}
	return data;
}

/** One parsed item with `widget` (+ `key`, single-block widgets) filled in when missing. */
function stampWidgetItem(item: WidgetItem, widgetName: string, blocks: number): WidgetItem {
	if (!isPlainItem(item)) return item;
	const stamped: Record<string, unknown> = { ...item };
	if (typeof stamped.widget !== 'string') stamped.widget = widgetName;
	if (stamped.key === undefined && blocks === 1) stamped.key = 0;
	return stamped as WidgetItem;
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
