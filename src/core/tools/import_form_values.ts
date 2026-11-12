/**
 * The import tools' VALUES FORM (role `input_component`) — the values an
 * operator types once into the tool's staging form (service_tmp_section) and
 * that every imported record receives (PHP tool_import_files :1698,
 * tool_import_marc21 :947 / v6 :270). WC-079: the form persists server-side and
 * the tool CONSUMES it after a run that wrote something; this module is the
 * read half, shared so every import door reads the form the same way.
 *
 * The client ships each form component's `data` verbatim in
 * `components_temp_data` (service_tmp_section.get_components_data). Under
 * WC-001 the live key is `entries`; `value` is the PHP-era fallback only.
 */

import { DedaloError } from '../errors/index.ts';
import type { MappedField } from './import_execute.ts';

/** One components_temp_data entry (the import-form component payload). */
export interface TempDataEntry {
	tipo?: string;
	section_tipo?: string;
	entries?: unknown;
	value?: unknown;
}

/** One ddo_map row as the client's `tool_config.ddo_map` carries it. */
export interface FormDdo {
	role?: unknown;
	tipo?: unknown;
	section_tipo?: unknown;
}

/**
 * The items a form entry holds, `entries` first (WC-001), `value` as the
 * fallback. PHP `!empty`: null / '' holes are dropped, never persisted as
 * `[null]`.
 */
export function formValueItems(entry: TempDataEntry | undefined): unknown[] {
	const raw = entry?.entries ?? entry?.value;
	if (Array.isArray(raw)) return raw.filter((item) => item !== null && item !== '');
	return raw === null || raw === undefined || raw === '' ? [] : [raw];
}

/** The form entry for one ddo (same tipo AND section_tipo — PHP array_find). */
function formEntryFor(
	tempData: readonly TempDataEntry[],
	tipo: string,
	sectionTipo: string,
): TempDataEntry | undefined {
	return tempData.find((item) => item?.tipo === tipo && item?.section_tipo === sectionTipo);
}

/**
 * The Values form as MAPPED FIELDS for the shared executor: one field per
 * `input_component` ddo whose form entry holds items, carrying the items as one
 * JSON value. They go through the same conform + write door + per-record
 * transaction as the mapped file fields, and an item's own `lang` splits the
 * save per language (import_data.ts `groupItemsByLang`).
 *
 * An empty form entry writes NOTHING (PHP `!empty`): a field the operator left
 * blank is not a clear.
 *
 * REFUSED: an `input_component` ddo of another section than the one imported
 * into. The imported record's id addresses nothing in a third section, and PHP
 * wrote that section's record of the same number (a defect). Computed before
 * any write, so a refusal writes nothing.
 */
export function formValueFields(
	ddoMap: readonly FormDdo[],
	tempData: readonly TempDataEntry[],
	sectionTipo: string,
	door: string,
): MappedField[] {
	const fields: MappedField[] = [];
	for (const ddo of ddoMap) {
		if (ddo?.role !== 'input_component') continue;
		const field = formFieldOf(ddo, tempData, sectionTipo, door);
		if (field !== null) fields.push(field);
	}
	return fields;
}

/** One `input_component` ddo → its field (null when the form left it empty), or a refusal. */
function formFieldOf(
	ddo: FormDdo,
	tempData: readonly TempDataEntry[],
	sectionTipo: string,
	door: string,
): MappedField | null {
	const tipo = typeof ddo.tipo === 'string' ? ddo.tipo : '';
	const ddoSection = typeof ddo.section_tipo === 'string' ? ddo.section_tipo : '';
	if (ddoSection !== sectionTipo) {
		const sentence =
			`${door}: the Values form field '${tipo}' belongs to section '${ddoSection}', but this ` +
			`import writes into '${sectionTipo}'. A form value is written into the imported record, ` +
			`so its field must belong to that record's section; fix the tool's ddo_map.`;
		throw new DedaloError('request.invalid_options', {
			message: sentence,
			publicMessage: sentence,
		});
	}
	const items = formValueItems(formEntryFor(tempData, tipo, ddoSection));
	return items.length === 0 ? null : { component_tipo: tipo, values: [JSON.stringify(items)] };
}
