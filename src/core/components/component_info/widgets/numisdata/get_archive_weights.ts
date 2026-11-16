/**
 * get_archive_weights widget (PHP core/widgets/numisdata/get_archive_weights).
 *
 * Cross-archive weight/diameter statistics over the coins linked via the
 * source portal. Coins whose 'used' flag is absent or set, and coins whose
 * 'duplicated' flag is set, are excluded — "set" is isFlagSet (first locator
 * section_id 2 by the locator law: int 2, "2", "02"). PHP compared `=== '2'`,
 * which was right only while locators were string-canonical; against the INT
 * locators of WC-2026-08-10 it counted unused and duplicated coins
 * (WC-2026-11-12-numisdata-widgets-locator-law). Per-coin measurement means
 * feed the archive-level mean/max/min/count.
 */

import {
	findTyped,
	type InfoWidgetDescriptor,
	isFlagSet,
	phpRound,
	readWidgetComponentData,
	type WidgetContext,
	type WidgetItem,
} from '../widget_common.ts';

async function computeGetArchiveWeights(
	ipo: unknown[],
	context: WidgetContext,
): Promise<WidgetItem[]> {
	const data: WidgetItem[] = [];
	for (const [key, entry] of ipo.entries()) {
		const block = entry as { input?: unknown[]; output?: { id?: string }[] };
		const input = Array.isArray(block.input) ? block.input : [];
		const output = Array.isArray(block.output) ? block.output : [];

		const source = findTyped(input, 'source');
		if (source?.component_tipo === undefined) continue;
		const portalData = (await readWidgetComponentData(
			source.section_tipo ?? context.sectionTipo,
			context.sectionId,
			source.component_tipo,
		)) as { section_id?: unknown; section_tipo?: unknown }[];
		// early exit: PHP returns [] for the WHOLE widget when the portal is empty
		if (portalData.length === 0) return [];

		const used = findTyped(input, 'used');
		const duplicated = findTyped(input, 'duplicated');
		if (duplicated === undefined) continue; // PHP logs ERROR and skips the block
		const dataWeights = findTyped(input, 'data_weights');
		// (!) 'data_diamenter' is a persistent ontology typo — must match verbatim
		const dataDiameter = findTyped(input, 'data_diamenter');

		const weights: number[] = [];
		const diameters: number[] = [];
		for (const locator of portalData) {
			const coinSection = String(locator.section_tipo ?? '');
			const coinId = locator.section_id as number | string;
			if (coinSection === '' || coinId === undefined) continue;

			const usedData = (await readWidgetComponentData(
				coinSection,
				coinId,
				used?.component_tipo ?? '',
			)) as { section_id?: unknown }[];
			// skip when the 'used' flag is absent or set (2 = no)
			if (usedData.length === 0 || isFlagSet(usedData)) continue;

			const duplicatedData = (await readWidgetComponentData(
				coinSection,
				coinId,
				duplicated.component_tipo ?? '',
			)) as { section_id?: unknown }[];
			if (isFlagSet(duplicatedData)) continue;

			const weightItems = (await readWidgetComponentData(
				coinSection,
				coinId,
				dataWeights?.component_tipo ?? '',
			)) as { value?: unknown }[];
			if (weightItems.length > 0) {
				const sum = weightItems.reduce((total, item) => total + Number(item?.value ?? 0), 0);
				weights.push(sum / weightItems.length);
			}

			const diameterItems = (await readWidgetComponentData(
				coinSection,
				coinId,
				dataDiameter?.component_tipo ?? '',
			)) as { value?: unknown }[];
			if (diameterItems.length > 0) {
				const sum = diameterItems.reduce((total, item) => total + Number(item?.value ?? 0), 0);
				diameters.push(sum / diameterItems.length);
			}
		}

		const stats: Record<string, unknown> = {};
		if (weights.length > 0) {
			stats.media_weight = phpRound(weights.reduce((a, b) => a + b, 0) / weights.length, 2);
			stats.total_elements_weights = weights.length;
			stats.max_weight = Math.max(...weights);
			stats.min_weight = Math.min(...weights);
		}
		if (diameters.length > 0) {
			stats.media_diameter = phpRound(diameters.reduce((a, b) => a + b, 0) / diameters.length, 2);
			stats.total_elements_diameter = diameters.length;
			stats.max_diameter = Math.max(...diameters);
			stats.min_diameter = Math.min(...diameters);
		}

		for (const dataMap of output) {
			const id = dataMap.id ?? '';
			data.push({
				widget: 'get_archive_weights',
				key,
				widget_id: id,
				value: stats[id] ?? null,
			});
		}
	}
	return data;
}

export const get_archive_weights: InfoWidgetDescriptor = {
	name: 'get_archive_weights',
	path: '/numisdata/get_archive_weights',
	computeData: computeGetArchiveWeights,
};
