/**
 * state widget (PHP core/widgets/state) — per-record process-state
 * percentages.
 *
 * Process-state summary: each IPO path names a leaf select/check_box whose
 * stored locators point at the dd174 (situation) / dd501 (state) vocabulary;
 * the vocabulary record's percentage (dd92 / dd83) becomes a 'detail' item
 * and per-column running sums emit 'total' items (round((sum / n) / source
 * locator count, 2); n = project-lang count for translatable leaves, else 1).
 * The total also carries that source locator count as `items` — TS-only, see
 * WC-2026-08-03-state-widget-total-source-count.
 * Empty leaves emit a zero detail whose column comes from the leaf's related
 * SECTION relation (dd501 → 'state', else 'situation'); non-empty leaves take
 * the column from the STORED locator's section. Multi-hop paths are UNPORTED
 * (every declared instance — rsc19 / oh28 / test180 — is single-hop).
 */

import { config } from '../../../../../config/config.ts';
import { getModelByTipo, getNode } from '../../../../ontology/resolver.ts';
import {
	type InfoWidgetDescriptor,
	phpRound,
	readWidgetComponentData,
	resolveCurrent,
	type TypedInput,
	type WidgetContext,
	type WidgetItem,
} from '../widget_common.ts';

/** The two controlled vocabularies the state widget reads. */
const STATE_VOCABULARIES: Record<string, { valueTipo: string; column: string }> = {
	dd174: { valueTipo: 'dd92', column: 'situation' }, // user situation vocabulary
	dd501: { valueTipo: 'dd83', column: 'state' }, // admin state vocabulary
};

/** First ontology relation of a tipo whose runtime model is 'section'. */
async function getRelatedSection(tipo: string): Promise<string | null> {
	const node = await getNode(tipo);
	const relations = (node?.relations as { tipo?: unknown }[] | null) ?? [];
	for (const relation of relations) {
		if (typeof relation?.tipo !== 'string') continue;
		if ((await getModelByTipo(relation.tipo)) === 'section') return relation.tipo;
	}
	return null;
}

async function computeState(ipo: unknown[], context: WidgetContext): Promise<WidgetItem[]> {
	// See the note in ai/rag/indexer.ts: 'APPLICATION_LANGS' is not a real key, so this
	// always counted the 3 languages of a hardcoded literal instead of the install's own.
	const projectLangCount = config.menu.projectsDefaultLangs.length;
	const { getTranslatableByTipo } = await import('../../../../ontology/resolver.ts');
	const data: WidgetItem[] = [];

	for (const [key, entry] of ipo.entries()) {
		const block = entry as {
			input?: {
				type?: string;
				source?: TypedInput[];
				paths?: { var_name?: string; section_tipo?: string; component_tipo?: string }[][];
			};
			output?: { id?: string }[];
		};
		const output = Array.isArray(block.output) ? block.output : [];
		const paths = block.input?.paths ?? [];

		// source locators
		const arLocator: { section_tipo?: unknown; section_id?: unknown; lang?: unknown }[] = [];
		if (block.input?.type === 'locator') {
			for (const source of block.input.source ?? []) {
				const locator: Record<string, unknown> = {};
				// PHP only sets the fields whose declared value is 'current'
				if (source.section_tipo === 'current') locator.section_tipo = context.sectionTipo;
				if (source.section_id === 'current') locator.section_id = context.sectionId;
				arLocator.push(locator);
			}
		} else if (block.input?.type === 'component_data') {
			for (const source of block.input.source ?? []) {
				if (source.component_tipo === undefined) continue;
				const sourceSection = String(resolveCurrent(source.section_tipo, context.sectionTipo));
				const sourceId = resolveCurrent(source.section_id, context.sectionId);
				const sourceData = (await readWidgetComponentData(
					sourceSection,
					sourceId,
					source.component_tipo,
				)) as { section_tipo?: unknown; section_id?: unknown }[];
				// EVERY locator of the source, not just the first (PHP
				// class.state.php:75 `array_merge($ar_locator, $source_dato)`; the
				// `reset()` on the line above it only feeds the `!empty($locator)`
				// guard). Keeping just [0] silently dropped every resource after the
				// first on a multi-resource record — the leaf values behind them
				// vanished from the widget AND the totals divided by the wrong
				// count ($items = count($ar_locator), line 207).
				arLocator.push(...sourceData.filter((entry) => entry !== null && entry !== undefined));
			}
		}
		if (arLocator.length === 0) continue;

		// per-path detail items
		interface StateDetail {
			value: unknown;
			locator: unknown;
			lang: string | null;
			widget_id: string;
			column: string;
			type: 'detail';
			n: number;
		}
		const result: StateDetail[] = [];
		for (const path of paths) {
			const lastPath = path[path.length - 1];
			const leafTipo = lastPath?.component_tipo;
			if (leafTipo === undefined) continue;
			const varName = lastPath?.var_name ?? '';
			const translatable = await getTranslatableByTipo(leafTipo);
			const langCount = translatable ? projectLangCount : 1;

			// single-hop walk: the leaf component AT each source locator
			const arValue: { section_tipo?: unknown; section_id?: unknown; lang?: unknown }[] = [];
			for (const locator of arLocator) {
				const stepSection =
					lastPath?.section_tipo === 'self' || lastPath?.section_tipo === undefined
						? context.sectionTipo
						: lastPath.section_tipo;
				const hostSection = String(locator.section_tipo ?? stepSection);
				const hostId = locator.section_id as number | string;
				if (hostId === undefined) continue;
				const items = (await readWidgetComponentData(hostSection, hostId, leafTipo)) as {
					section_tipo?: unknown;
					section_id?: unknown;
					lang?: unknown;
				}[];
				arValue.push(...items);
			}

			if (arValue.length === 0) {
				const relatedSection = await getRelatedSection(leafTipo);
				result.push({
					value: 0,
					locator: null,
					lang: translatable ? null : 'lg-nolan',
					widget_id: varName,
					column: relatedSection === 'dd501' ? 'state' : 'situation',
					type: 'detail',
					n: langCount,
				});
				continue;
			}
			for (const valueLocator of arValue) {
				const vocabulary = STATE_VOCABULARIES[String(valueLocator.section_tipo ?? '')];
				if (vocabulary === undefined) {
					// PHP pushes the untouched empty object (all fields undefined) —
					// unreachable with well-formed data; emit an all-null detail.
					result.push({
						value: null,
						locator: null,
						lang: null,
						widget_id: '',
						column: '',
						type: 'detail',
						n: langCount,
					});
					continue;
				}
				const valueItems = (await readWidgetComponentData(
					String(valueLocator.section_tipo),
					valueLocator.section_id as number | string,
					vocabulary.valueTipo,
				)) as { value?: unknown }[];
				result.push({
					value: valueItems.length > 0 ? (valueItems[0]?.value ?? 0) : 0,
					locator: valueLocator,
					lang: typeof valueLocator.lang === 'string' ? valueLocator.lang : 'lg-nolan',
					widget_id: varName,
					column: vocabulary.column,
					type: 'detail',
					n: langCount,
				});
			}
		}

		// output assembly: detail items + one 'total' per column per output id
		for (const dataMap of output) {
			const currentId = dataMap.id ?? '';
			const found = result.filter((item) => item.widget_id === currentId);
			const arSum = new Map<string, { total: number; n: number; widget_id: string }>();
			for (const item of found) {
				data.push({
					widget: 'state',
					key,
					widget_id: item.widget_id,
					lang: item.lang,
					value: item.value,
					locator: item.locator,
					column: item.column,
					type: item.type,
				});
				const previous = arSum.get(item.column)?.total ?? 0;
				arSum.set(item.column, {
					total: previous + Math.trunc(Number(item.value) || 0),
					n: item.n,
					widget_id: item.widget_id,
				});
			}
			for (const [column, sum] of arSum) {
				const items = arLocator.length;
				data.push({
					widget: 'state',
					key,
					widget_id: sum.widget_id,
					lang: 'lg-nolan',
					value: phpRound(sum.total / sum.n / items, 2),
					column,
					type: 'total',
					// WC-2026-08-03-state-widget-total-source-count: TS-only. The
					// divisor, published. A source record with nothing saved emits no
					// detail item at all, so the client could not tell 50%-of-one from
					// 25%-of-two and its breakdown panel contradicted its own cell.
					items,
				});
			}
		}
	}
	return data;
}

/**
 * PHP state::get_data_list — the edit-mode vocabulary datalist: for each IPO
 * path's LEAF select/radio component, its full option list
 * (get_list_of_values → the canonical relations/datalist resolver), each item
 * enriched with {widget:'state', key}. The client render_edit_state resolves
 * option labels from self.datalist — WITHOUT it the edit render TypeErrors
 * (datalist.find(...).label) and the widget goes blank.
 */
async function computeStateDataList(ipo: unknown[], context: WidgetContext): Promise<WidgetItem[]> {
	const { getDatalist } = await import('../../../../relations/datalist.ts');
	const data: WidgetItem[] = [];
	for (const [key, entry] of ipo.entries()) {
		const block = entry as {
			input?: { paths?: { section_tipo?: string; component_tipo?: string }[][] };
		};
		for (const path of block.input?.paths ?? []) {
			const lastPath = path[path.length - 1];
			const componentTipo = lastPath?.component_tipo;
			if (componentTipo === undefined) continue;
			// PHP passes the path's section_tipo verbatim ('self' included); the
			// option list resolves from the component's OWN request_config targets,
			// so the owner section only matters for {source:'self'} sqos — resolve
			// the sentinel to the real owner for those.
			const declaredSection = lastPath?.section_tipo;
			const ownerSection =
				declaredSection === undefined || declaredSection === 'self'
					? context.sectionTipo
					: declaredSection;
			const node = await getNode(componentTipo);
			// No owner RECORD: the widget lists the vocabulary of a path, not the
			// options of one record's field.
			const items = await getDatalist(
				componentTipo,
				node?.properties ?? null,
				{ section_tipo: ownerSection, section_id: null },
				'lg-nolan',
			);
			for (const item of items) {
				data.push({ ...item, widget: 'state', key });
			}
		}
	}
	return data;
}

export const state: InfoWidgetDescriptor = {
	name: 'state',
	path: '/state',
	computeData: computeState,
	computeDataList: computeStateDataList,
};
