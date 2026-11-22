/**
 * media_icons widget (PHP core/widgets/oh/media_icons) — per-media icon rows.
 *
 * One row object per linked media record: id + tc value columns and one
 * tool-launch column per declared tool (transcription / indexation /
 * translation), whose tool_context is the user-tools simple context plus the
 * section_tool node's tool_config with 'self' expanded to the media record
 * and each ddo enriched with model/translatable/label (PHP
 * create_tool_simple_context).
 *
 * tc (T2-WID-3, FYI-5 / C52 — WC-2026-11-22-media-icons-tc): the duration
 * STORED in the AV component's declared `target_duration` (PHP hardcoded
 * 'rsc54', kept as the fallback for a component declaring none). When none is
 * stored, the AV file of the path's last hop is MEASURED, read-only (once per
 * file stamp — companion_writes' probe memo, review L1) — PHP
 * probed too, but WROTE the result back during the read, and wrote
 * '00:00:00.000' for a missing file. Here a read never writes and never
 * fabricates: no file (or none readable) = the cell carries no value, which
 * the client renders as empty. The repair door that STORES the measurement is
 * tool_update_cache's regenerate (rewriteDurationCompanion).
 */

import { getModelByTipo, getNode } from '../../../../ontology/resolver.ts';
import { currentApplicationLang } from '../../../../resolve/request_lang.ts';
import {
	type InfoWidgetDescriptor,
	readWidgetComponentData,
	resolveCurrent,
	type TypedInput,
	type WidgetContext,
	type WidgetItem,
} from '../widget_common.ts';

/**
 * The duration component when the AV component declares no `target_duration`
 * (PHP hardcoded it for every media record).
 */
const FALLBACK_DURATION_TIPO = 'rsc54';

/**
 * The tc cell's value: the stored duration, else the file's measured duration
 * (read-only), else undefined — never a fabricated `00:00:00.000`.
 */
async function resolveTc(
	avTipo: string | undefined,
	mediaSection: string,
	mediaId: number | string,
): Promise<unknown> {
	// Dynamic: the media ingest layer reaches the write path; a widget read must
	// not pull it into the read graph's static import set.
	const { measureStoredMediaDuration, resolveMediaCompanionTargets } = await import(
		'../../../../media/ingest/companion_writes.ts'
	);
	const durationTipo =
		(avTipo === undefined ? null : (await resolveMediaCompanionTargets(avTipo)).durationTipo) ??
		FALLBACK_DURATION_TIPO;
	const durationItems = (await readWidgetComponentData(mediaSection, mediaId, durationTipo)) as {
		value?: unknown;
	}[];
	const stored = durationItems[0]?.value;
	if (stored !== undefined && stored !== null && stored !== '') return stored;
	const sectionId = Number(mediaId);
	if (avTipo === undefined || !Number.isInteger(sectionId) || sectionId <= 0) return undefined;
	const avItems = (await readWidgetComponentData(mediaSection, sectionId, avTipo)) as unknown[];
	const measured = await measureStoredMediaDuration({
		componentTipo: avTipo,
		sectionTipo: mediaSection,
		sectionId,
		items: avItems,
	});
	return measured ?? undefined;
}

async function computeMediaIcons(ipo: unknown[], context: WidgetContext): Promise<WidgetItem[]> {
	const data: WidgetItem[] = [];
	const { getUserTools, getSuperuserUserTools } = await import('../../../../tools/registry.ts');
	const { termByTipo } = await import('../../../../ontology/labels.ts');
	const { getTranslatableByTipo } = await import('../../../../ontology/resolver.ts');
	const userTools =
		context.userId === undefined || context.userId === null
			? await getSuperuserUserTools()
			: await getUserTools(context.userId, context.isAdmin === true);

	for (const [key, entry] of ipo.entries()) {
		const block = entry as {
			input?: { source?: TypedInput[]; paths?: { component_tipo?: string }[][] };
			output?: { id?: string; label?: string; process_section_tipo?: string }[];
		};
		const output = Array.isArray(block.output) ? block.output : [];
		const paths = block.input?.paths ?? [];

		const arLocator: { section_tipo?: unknown; section_id?: unknown }[] = [];
		for (const source of block.input?.source ?? []) {
			if (source.component_tipo === undefined) continue;
			const sourceSection = String(resolveCurrent(source.section_tipo, context.sectionTipo));
			const sourceId = resolveCurrent(source.section_id, context.sectionId);
			const sourceData = (await readWidgetComponentData(
				sourceSection,
				sourceId,
				source.component_tipo,
			)) as { section_tipo?: unknown; section_id?: unknown }[];
			arLocator.push(...sourceData);
		}

		for (const path of paths) {
			// the last hop names the AV component whose file the tc measures
			const avTipo = path.at(-1)?.component_tipo;
			for (const locator of arLocator) {
				const mediaSection = String(locator.section_tipo ?? '');
				const mediaId = locator.section_id as number | string;

				const row: Record<string, unknown> = {};
				for (const dataMap of output) {
					const columnId = dataMap.id ?? '';
					const cell: Record<string, unknown> = {
						widget: 'media_icons',
						key,
						widget_id: columnId,
						locator,
					};
					switch (columnId) {
						case 'id':
							cell.value = mediaId;
							break;
						case 'tc': {
							// unknown duration: the value stays UNSET (client renders '')
							const tc = await resolveTc(avTipo, mediaSection, mediaId);
							if (tc !== undefined) cell.value = tc;
							break;
						}
						default: {
							// tool column: value stays UNSET (PHP isset(null) === false)
							const toolName = dataMap.label ?? '';
							const tool = userTools.find((candidate) => candidate.name === toolName);
							if (tool !== undefined) {
								const sectionToolTipo = dataMap.process_section_tipo ?? '';
								const toolNode = await getNode(sectionToolTipo);
								const toolConfig = structuredClone(
									(
										toolNode?.properties as {
											tool_config?: Record<string, { ddo_map?: Record<string, unknown>[] }>;
										} | null
									)?.tool_config?.[toolName] ?? null,
								);
								if (toolConfig !== null && Array.isArray(toolConfig.ddo_map)) {
									for (const ddo of toolConfig.ddo_map) {
										if (ddo.section_id === 'self') ddo.section_id = mediaId;
										if (ddo.model === undefined) {
											ddo.model = await getModelByTipo(String(ddo.tipo));
										}
										ddo.translatable = await getTranslatableByTipo(String(ddo.tipo));
										ddo.label = await termByTipo(String(ddo.tipo), currentApplicationLang());
									}
								}
								cell.tool_context = { ...tool, tool_config: toolConfig };
							}
							break;
						}
					}
					row[columnId] = cell;
					row.widget = 'media_icons';
				}
				data.push(row);
			}
		}
	}
	return data;
}

export const media_icons: InfoWidgetDescriptor = {
	name: 'media_icons',
	path: '/oh/media_icons',
	computeData: computeMediaIcons,
};
