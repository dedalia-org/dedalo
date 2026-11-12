/**
 * component_info PUBLICATION VALUE — the LIVE widget compute (T1-2 / O09,
 * WC-2026-11-12-info-live-publication-export).
 *
 * PHP component_info::get_diffusion_data (class.component_info.php:880-896)
 * publishes `$this->get_data()` — what the widgets compute for this record
 * NOW (async widgets skipped, :156-158) — one diffusion item per widget
 * output, the value being the WHOLE `{widget, key, id|widget_id, value}`
 * object, language-neutral (DEDALO_DATA_NOLAN). It overrides
 * component_common::get_diffusion_data, so a ddo `fn` on an info component
 * never runs (the resolver routes info here BEFORE the fn door).
 *
 * The stored `misc` slot is NEVER published (WC-2026-09-03 — the read never
 * serves it; defaultPublicationValue refuses the model outright). Until this
 * module the resolver read that slot and unwrapped each entry to its bare
 * scalar, so every `parser_info::widget` column published NULL.
 *
 * Identity: the run principal (DIFF-01 — ResolveOptions.principal) passed
 * EXPLICITLY, never captured from ALS at module level; absent (a system run)
 * → the widgets' superuser fallback (WidgetContext.userId undefined). Lang:
 * the plan's main lang scoped through runWithRequestLangs (PHP
 * DEDALO_DATA_LANG of the publishing request).
 *
 * Cost: one compute per (record, info component) per run — the run-scoped
 * bounded memo (RunContext.infoItemsCache) serves every further field over
 * the same component (numisdata786/787/968/969 all read numisdata595).
 * `diffusion_info_widget_compute` counts the real computes.
 */

import { incrementCounter } from '../../core/api/counters.ts';
import { computeInfoWidgets } from '../../core/components/component_info/widgets/registry.ts';
import {
	normalizeWidgetEntryKeys,
	type WidgetItem,
} from '../../core/components/component_info/widgets/widget_common.ts';
import type { MatrixRecord } from '../../core/db/matrix.ts';
import { runWithRequestLangs } from '../../core/resolve/request_lang.ts';
import type { Principal } from '../../core/security/permissions.ts';
import type { MetaValueIR } from '../parsers/types.ts';
import { metaFrom, type ValueProvenance } from './default_value.ts';

/** What the info branch needs from the run (RunContext slice — no import cycle). */
export interface InfoPublicationEnv {
	/** The plan's main lang (the compute's data + application lang). */
	lang: string;
	/** The run principal (DIFF-01); undefined = system run. */
	principal: Principal | undefined;
	/** Read / write the run-scoped bounded memo (RunContext.infoItemsCache via
	 * resolver.ts get/setBoundedRunMemo), keyed `${section_tipo}|${section_id}|${tipo}`. */
	readMemo(key: string): unknown[] | null | undefined;
	writeMemo(key: string, items: unknown[] | null): void;
}

/** The live, key-normalized (WC-026) items of one info component on one record. */
export async function liveInfoItems(
	env: InfoPublicationEnv,
	record: Pick<MatrixRecord, 'section_tipo' | 'section_id'>,
	componentTipo: string,
): Promise<unknown[] | null> {
	const key = `${record.section_tipo}|${record.section_id}|${componentTipo}`;
	const cached = env.readMemo(key);
	if (cached !== undefined) return cached;
	incrementCounter('diffusion_info_widget_compute');
	const computed: WidgetItem[] | null = await runWithRequestLangs(
		{ applicationLang: env.lang, dataLang: env.lang },
		() =>
			computeInfoWidgets(componentTipo, {
				sectionTipo: record.section_tipo,
				sectionId: record.section_id,
				// PHP instances the component in the diffusion request's mode; the
				// one widget that reads mode (oh/descriptors) only branches on 'list'.
				mode: 'diffusion',
				lang: env.lang,
				userId: env.principal?.userId,
				isAdmin: env.principal?.isGlobalAdmin,
			}),
	);
	const items = computed === null ? null : normalizeWidgetEntryKeys(computed);
	env.writeMemo(key, items);
	return items;
}

/**
 * The publication atoms of one component_info: ONE language-neutral json atom
 * per computed item, its value the whole item object (parser_info::widget
 * matches `widget` + `id|widget_id` on it). No widgets / nothing computed →
 * no atom. An unported or unregistered widget THROWS (never-narrow), which
 * the resolver records as the field's error.
 */
export async function infoPublicationAtoms(
	env: InfoPublicationEnv,
	record: Pick<MatrixRecord, 'section_tipo' | 'section_id'>,
	componentTipo: string,
	provenance: ValueProvenance,
): Promise<MetaValueIR[]> {
	const items = (await liveInfoItems(env, record, componentTipo)) ?? [];
	const meta = metaFrom(provenance);
	return items.map((item) => ({ kind: 'json', value: item, lang: null, meta }) as MetaValueIR);
}
