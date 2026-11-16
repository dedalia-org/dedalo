/**
 * tags widget (PHP core/widgets/oh/tags) — transcription tag statistics.
 *
 * Tag statistics over the CURRENT record's transcription text (source entry
 * with var_name 'transcription'). Faithful quirk: PHP reuses $data — each IPO
 * iteration REPLACES the accumulator with the raw component data array and
 * then appends the widget items to it, so the returned array leads with the
 * raw text-area items of the LAST iterated IPO entry.
 *
 * WHICH TEXT (T1-44 / OX6, WC-2026-11-13-tags-widget-original-lang): the
 * statistics count the slice the record's transcript LIVES in. v6
 * class.tags.php instanced the text_area at the data lang, then
 * `set_lang(get_original_lang())` and read the lang-scoped `get_dato()[0]`
 * (`lang_fallback=false`). Frozen PHP v7 kept the set_lang dance but called the
 * FULL-array `get_data()`, so `[0]` was whichever lang was stored first — a
 * regression its own comment contradicts ("must be computed on the source
 * (original) language text"). Here: the record text lang (original lang,
 * equivalence-aware — the SAME resolution the text_area list value uses,
 * component_text_area/original_lang.ts resolveRecordTextLang), else the
 * request data lang; never a further fallback (stats from another language's
 * text would be a silent lie). A non-translatable source is stored lg-nolan:
 * its full array. The raw-items prefix is that slice too (v6 `$dato`).
 */

import { getModelByTipo, getTranslatableByTipo } from '../../../../ontology/resolver.ts';
import {
	type InfoWidgetDescriptor,
	readWidgetRecord,
	type TypedInput,
	type WidgetContext,
	type WidgetItem,
} from '../widget_common.ts';

/**
 * The transcription items the statistics read: the record's text slice of a
 * translatable source (see the header), the full array of a non-translatable
 * one, [] when there is no record.
 */
async function readTranscriptionSlice(
	tipo: string,
	context: WidgetContext,
): Promise<{ value?: unknown }[]> {
	const record = await readWidgetRecord(context.sectionTipo, context.sectionId);
	if (record === null) return [];
	const model = await getModelByTipo(tipo);
	if (model === null) return [];
	const { filterItemsByLang, readComponentItems } = await import(
		'../../../../resolve/component_data.ts'
	);
	const items = readComponentItems(record, tipo, model) ?? [];
	if (!(await getTranslatableByTipo(tipo))) return items as { value?: unknown }[];
	const { resolveRecordTextLang } = await import('../../../component_text_area/original_lang.ts');
	const lang =
		(await resolveRecordTextLang(
			tipo,
			context.sectionTipo,
			Number(context.sectionId),
			record,
			items,
			model,
		)) ?? context.lang;
	return filterItemsByLang(items, lang) as { value?: unknown }[];
}

async function computeTags(ipo: unknown[], context: WidgetContext): Promise<WidgetItem[]> {
	const { tagStatistics } = await import('../../../../resolve/tr_marks.ts');
	let data: WidgetItem[] = [];
	for (const [key, entry] of ipo.entries()) {
		const block = entry as {
			input?: { source?: (TypedInput & { var_name?: string })[] };
			output?: { id?: string }[];
		};
		const output = Array.isArray(block.output) ? block.output : [];
		const transcription = (block.input?.source ?? []).find(
			(item) => item?.var_name === 'transcription',
		);
		if (transcription?.component_tipo === undefined) continue; // PHP logs + continue

		// raw text: item [0] of the record's text slice (v6 get_dato()[0]).
		const componentItems = await readTranscriptionSlice(transcription.component_tipo, context);
		const rawText = typeof componentItems[0]?.value === 'string' ? componentItems[0].value : '';

		const stats = tagStatistics(rawText) as unknown as Record<string, unknown>;

		// PHP quirk: $data is REPLACED with the raw component data array …
		data = [...(componentItems as WidgetItem[])];
		// … then the widget items are appended to it.
		for (const dataMap of output) {
			const id = dataMap.id ?? '';
			data.push({
				widget: 'tags',
				key,
				widget_id: id,
				value: stats[id] ?? null,
			});
		}
	}
	return data;
}

export const tags: InfoWidgetDescriptor = {
	name: 'tags',
	path: '/oh/tags',
	computeData: computeTags,
};
