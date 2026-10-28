/**
 * SELECT family resolver (RELATIONS_SPEC.md §6.1, list-of-values models):
 * component_select, component_select_lang, component_radio_button,
 * component_check_box, component_publication, component_relation_model.
 *
 * These relations offer the FULL records of the target section as options.
 * The mode switch is the one every PHP json controller of the family spells
 * (component_<model>_json.php, `switch($mode)`):
 * - `list` → the datalist LABEL strings of the stored locators
 *   (PHP component_relation_common::get_list_value);
 * - EVERY other mode (`case 'edit': default:`) → the stored locators as entries
 *   + the full datalist of options (PHP component_common::get_list_of_values,
 *   class.component_common.php:2740). That includes `search` and the `solved`
 *   mode the dataframe rating hide ddo declares (`role:'rating'`,
 *   WC-2026-09-29-select-family-mode-datalist): the client paints the rating
 *   chip from THAT item's datalist, and an item without one crashed the portal
 *   refresh after a time machine apply.
 *
 * The PHP controllers' third arm — the retired display mode of the Time
 * Machine (list value, or data+datalist for a radio_button inside a
 * dataframe) — has no reachable input here: that mode is retired
 * (WC-2026-08-14-tm-ddo-mode-retired), history cells are LIST reads, and the
 * tool's preview pane renders an EDIT read.
 *
 * No mode takes the generic portal path: PHP never paginated nor expanded a
 * select-family value into subdatum rows.
 */

import { configOwnerOf } from '../../concepts/emit_row.ts';
import { getNode } from '../../ontology/resolver.ts';
import type { DataItem } from '../../resolve/component_data.ts';
import { buildDataItem } from '../../resolve/component_data.ts';
import { getEditDatalist, getRelationListValue } from '../datalist.ts';
import type { RelationEmitContext, RelationModelResolver } from '../registry.ts';

/** Relation models whose LIST value is label strings (relation_common get_list_value). */
export const SELECT_FAMILY_MODELS: ReadonlySet<string> = new Set([
	'component_select',
	'component_select_lang',
	'component_radio_button',
	'component_check_box',
	'component_publication',
	'component_relation_model',
]);

type StoredLocator = { section_tipo?: unknown; section_id?: unknown };
type NodeProperties = Parameters<typeof getEditDatalist>[1];

/** The component's stored locators (keyed by the DATA tipo — WC-020 aliases). */
function readStoredLocators(context: RelationEmitContext): StoredLocator[] {
	const relation = context.record.columns.relation as Record<string, unknown[]> | null;
	return (relation?.[context.dataTipo] as StoredLocator[] | undefined) ?? [];
}

/**
 * LIST value: the labels of the stored locators. component_select_lang
 * overrides the option source — the project default languages, not the records
 * of a target section (PHP class.component_select_lang get_list_value).
 */
async function listLabels(
	context: RelationEmitContext,
	storedLocators: StoredLocator[],
	properties: NodeProperties,
): Promise<string[]> {
	if (context.model === 'component_select_lang') {
		const { currentDataLang } = await import('../../resolve/request_lang.ts');
		const { getSelectLangListValue } = await import('../select_lang.ts');
		return getSelectLangListValue(storedLocators, currentDataLang());
	}
	return getRelationListValue(
		context.ddo.tipo,
		properties,
		configOwnerOf(context.row).section_tipo,
		context.ddoLang,
		storedLocators,
	);
}

/** `list` mode: one item carrying the label strings (null when none). */
async function buildListItem(
	context: RelationEmitContext,
	storedLocators: StoredLocator[],
	properties: NodeProperties,
): Promise<DataItem> {
	const labels = await listLabels(context, storedLocators, properties);
	return buildDataItem(
		context.ddo.tipo,
		context.row.section_tipo,
		context.row.section_id,
		context.ddoMode,
		'lg-nolan',
		labels.length > 0 ? labels : null,
	);
}

/**
 * Every other mode: the stored locators as entries + the option datalist.
 * Empty → [] (NOT null) so the client's data.entries is always an array
 * (life-cycle suites assert Array.isArray(entries), e.g.
 * test_component_check_box:222). getEditDatalist is the ONE edit door: it
 * applies the model's own option source (select_lang → project langs,
 * descriptor `datalistSource`) and its edit guard against the stored value
 * (select_lang → the "<name> *" entry of a non-project lang), so the
 * save/temporal echoes that call it cannot diverge from this read.
 */
async function buildOptionsItem(
	context: RelationEmitContext,
	storedLocators: StoredLocator[],
	properties: NodeProperties,
): Promise<DataItem> {
	const datalist =
		(await ownReadOnlyDatalist(context, storedLocators, properties)) ??
		(await getEditDatalist(
			context.ddo.tipo,
			properties,
			configOwnerOf(context.row).section_tipo,
			context.ddoLang,
			storedLocators,
		));
	const item = buildDataItem(
		context.ddo.tipo,
		context.row.section_tipo,
		context.row.section_id,
		context.ddoMode,
		'lg-nolan',
		storedLocators,
	);
	item.datalist = datalist;
	return item;
}

/**
 * YOUR OWN USER RECORD, READ-ONLY (TODO-071): tool_user_admin shows the actor's
 * profile (dd1725) read-only, but its option labels come from the Profiles
 * section, which most profiles grant nothing on — request_config drops the label
 * ddo and the name rendered blank. A read-only field offers no choice, so the
 * datalist carries only the STORED option(s), labelled without the per-user ddo
 * filter: the user learns the name of their own profile, never the list of
 * profiles. null = not this case (another record, or the field is editable).
 */
async function ownReadOnlyDatalist(
	context: RelationEmitContext,
	storedLocators: StoredLocator[],
	properties: NodeProperties,
): Promise<Awaited<ReturnType<typeof getEditDatalist>> | null> {
	if (storedLocators.length === 0) return null;
	const { currentRequestContext } = await import('../../security/request_context.ts');
	const requestContext = currentRequestContext();
	const principal = requestContext?.principal;
	if (requestContext === undefined || principal === undefined) return null;
	const { getRecordComponentPermission, isActorsOwnUserRecord } = await import(
		'../../security/permissions.ts'
	);
	const { section_tipo: sectionTipo, section_id: sectionId } = context.row;
	if (!isActorsOwnUserRecord(principal, sectionTipo, sectionId)) return null;
	if ((await getRecordComponentPermission(principal, sectionTipo, context.ddo.tipo, sectionId)) > 1)
		return null;
	const { runWithRequestContext } = await import('../../security/request_context.ts');
	const all = await runWithRequestContext({ ...requestContext, principal: undefined }, () =>
		getEditDatalist(
			context.ddo.tipo,
			properties,
			configOwnerOf(context.row).section_tipo,
			context.ddoLang,
			storedLocators,
		),
	);
	const { isLocatorInArray } = await import('../../concepts/locator.ts');
	return all.filter((option) => {
		const value = (option as { value?: StoredLocator }).value;
		return (
			value !== undefined &&
			isLocatorInArray(value as never, storedLocators as never[], ['section_tipo', 'section_id'])
		);
	});
}

export const selectFamilyResolver: RelationModelResolver = {
	model: 'component_select',

	async emitDdoItems(context: RelationEmitContext): Promise<void> {
		const storedLocators = readStoredLocators(context);
		const properties = (await getNode(context.ddo.tipo))?.properties ?? null;
		const build = context.ddoMode === 'list' ? buildListItem : buildOptionsItem;
		const item = await build(context, storedLocators, properties);
		item.row_section_id = context.row.section_id;
		item.parent_tipo = context.callerTipo;
		context.emission.items.push(item);
	},
};
