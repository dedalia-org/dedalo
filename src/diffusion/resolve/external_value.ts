/**
 * component_external PUBLICATION VALUE — the Zenon terminal of the chain walk
 * (T1-42 / O09, WC-2026-11-12-diffusion-external-chain).
 *
 * PHP routes component_external as a TERMINAL (it is not in
 * component_relation_common::get_components_with_relations) and instantiates
 * it WITHOUT checking the record exists (diffusion_chain_processor::
 * resolve_ddo_value) → component_common::get_diffusion_data →
 * component_external::get_data() → load_data_from_remote(): one lang-neutral
 * item per remote entry. The TS twin derives through the one core door
 * (components/component_external/value.ts deriveExternalValue — ownership,
 * fields_map, the facade, never throws).
 *
 * Three pieces, all run-scoped (RunContext slice — no module state):
 *   - `externalPublicationAtoms` — the terminal: one scalar atom per entry. An
 *     EMPTY derivation that carries a missing-value state is reported through
 *     `env.report` (the resolver turns it into the record's run error line —
 *     the loud per-field channel), never thrown: a merge field keeps its local
 *     atoms. Values + a status (stale / truncated) publish the values.
 *   - `externalPlaceholderApplies` — whether a hop's locator to a record with
 *     NO matrix row (a Zenon id, by construction) is still walked: yes when an
 *     applicable child derives its value remotely and the component is not
 *     FOREIGN to that section (the read path's law, relations/relation_core.ts
 *     resolvePortalTarget — record absence + an owned derived child).
 *   - `prefetchHopExternalRows` — one facade call per hop for every owned
 *     target, parked on the run's emission, so N Zenon locators of a record
 *     are one bounded-concurrency fan-out, not N serial fetches.
 *
 * The fetch lang is the run's (the plan's main lang, else the configured
 * default data lang — the same law as component_info, info_value.ts): a run's
 * output never depends on who triggered it nor on a detached job's ambient lang.
 */

import {
	deriveExternalValue,
	type ExternalSourceState,
	externalComponentAppliesTo,
	externalTransportDepsForRead,
	setPrefetchedExternalRows,
} from '../../core/components/component_external/value.ts';
import { getFlatValueFamily } from '../../core/components/registry.ts';
import type { MatrixRecord } from '../../core/db/matrix.ts';
import type { EmissionContext } from '../../core/resolve/component_data.ts';
import type { MetaValueIR } from '../parsers/types.ts';
import type { ResolveStep } from '../plan/types.ts';
import { metaFrom, type ValueProvenance } from './default_value.ts';

/** One component_external that published no value from its source. */
export interface ExternalPublicationDegradation {
	/** The component_external whose value is missing. */
	tipo: string;
	/** The remote record: its (external) section and its id, verbatim. */
	sectionTipo: string;
	remoteId: string;
	state: ExternalSourceState;
}

/** What the external terminal needs from the run (RunContext slice). */
export interface ExternalPublicationEnv {
	/** The run's fetch lang (plan main lang ?? configured default data lang). */
	lang: string;
	/** The run's emission (prefetched rows parked per hop). */
	emission: EmissionContext;
	/** Record a missing value (resolver → the record's run error line). */
	report(degradation: ExternalPublicationDegradation): void;
}

/**
 * The states whose cell holds NO value from the source — the export's
 * MISSING_STATES law (export/external_prefetch.ts). `not_found` is the
 * source's own answer (the remote record is gone), not a failure to read it.
 */
const MISSING_STATES: ReadonlySet<ExternalSourceState> = new Set([
	'unavailable',
	'timeout',
	'circuit_open',
	'disabled',
	'misconfigured',
]);

/** A chain step the external terminal owns: a component_external read with no ddo fn. */
export function isExternalTerminal(step: ResolveStep): boolean {
	return (
		step.kind === 'component' &&
		step.fn === undefined &&
		getFlatValueFamily(step.model) === 'external'
	);
}

/** The terminal: one lang-neutral scalar atom per derived entry. */
export async function externalPublicationAtoms(
	env: ExternalPublicationEnv,
	record: Pick<MatrixRecord, 'section_tipo' | 'section_id'>,
	componentTipo: string,
	provenance: ValueProvenance,
): Promise<MetaValueIR[]> {
	// The host row's section_id IS the remote id, verbatim (a padded Zenon id
	// stays a string; a local row's numeric address is its own id).
	const remoteId = String(record.section_id);
	const derived = await deriveExternalValue(componentTipo, record.section_tipo, remoteId, {
		emission: env.emission,
		dataLang: env.lang,
	});
	const state = derived.source_status?.state;
	if (derived.entries.length === 0 && state !== undefined && MISSING_STATES.has(state)) {
		env.report({ tipo: componentTipo, sectionTipo: record.section_tipo, remoteId, state });
	}
	const meta = metaFrom(provenance);
	return derived.entries.map((entry) => ({ kind: 'scalar', value: entry, lang: null, meta }));
}

/**
 * Whether a locator whose target has NO matrix row is walked on an
 * identity-only placeholder: some applicable child is an external terminal
 * whose component is not FOREIGN to the target section. Otherwise the record
 * is gone and contributes nothing (PHP reads empty components).
 */
export async function externalPlaceholderApplies(
	children: readonly ResolveStep[],
	targetSectionTipo: string,
): Promise<boolean> {
	for (const child of children) {
		if (!isExternalTerminal(child) || child.kind !== 'component') continue;
		if (child.sectionTipo !== '' && child.sectionTipo !== targetSectionTipo) continue;
		if ((await externalComponentAppliesTo(child.tipo, targetSectionTipo)) !== 'foreign') {
			return true;
		}
	}
	return false;
}

/**
 * Prefetch the remote rows a hop's external children will read, ONE facade
 * call for the hop (bounded concurrency, row cache + coalescing underneath),
 * and park them on the run's emission — REPLACING the previous hop's, so the
 * parked set stays one hop big. A row a nested hop displaced is re-served by
 * the row cache. NEVER THROWS: a failure is logged and every cell falls back
 * to its own fetch.
 */
export async function prefetchHopExternalRows(
	env: ExternalPublicationEnv,
	children: readonly ResolveStep[],
	locators: readonly { section_tipo?: unknown; section_id?: unknown }[],
): Promise<void> {
	const externalChildren = children.filter(isExternalTerminal);
	if (externalChildren.length === 0 || locators.length === 0) return;
	try {
		const api = await import('../../external/api/index.ts');
		const externalSections = new Map<string, boolean>();
		const targets = new Map<string, { sectionTipo: string; remoteId: string }>();
		for (const locator of locators) {
			const sectionTipo = locator.section_tipo;
			if (typeof sectionTipo !== 'string' || sectionTipo === '') continue;
			if (locator.section_id === undefined || locator.section_id === null) continue;
			const remoteId = String(locator.section_id);
			// The derivation refuses an id carrying the view-key separator.
			if (remoteId === '' || remoteId.includes('|')) continue;
			if (!(await ownedByAnyChild(externalChildren, sectionTipo))) continue;
			let external = externalSections.get(sectionTipo);
			if (external === undefined) {
				external = await api.isExternalReferenceSection(sectionTipo);
				externalSections.set(sectionTipo, external);
			}
			if (!external) continue;
			targets.set(api.externalRowViewKey(sectionTipo, remoteId), { sectionTipo, remoteId });
		}
		if (targets.size === 0) return;
		const deps = externalTransportDepsForRead(env.emission);
		// remoteFields []: the facade requests each record with its SECTION's
		// whole record field set (external/record_fields.ts) and the views say so.
		const views = await api.fetchExternalRows(
			[...targets.values()].map((target) => ({ ...target, remoteFields: [] })),
			{ dataLang: env.lang, ...(deps === undefined ? {} : { deps }) },
		);
		setPrefetchedExternalRows(env.emission, views);
	} catch (error) {
		// Non-fatal: each cell derives on its own, and a cell that cannot is
		// reported per record (externalPublicationAtoms → the run error line). A
		// CLASSIFIED failure (an ExternalServiceError: blocked host, bad config…)
		// is already logged by the subsystem; an unclassified one is loud here
		// (CONVENTIONS §1).
		if ((error as { kind?: unknown } | null)?.kind === undefined) {
			console.error(
				'[diffusion/resolve] external hop prefetch failed; cells fetch per cell',
				error,
			);
		}
		setPrefetchedExternalRows(env.emission, new Map());
	}
}

async function ownedByAnyChild(
	externalChildren: readonly ResolveStep[],
	sectionTipo: string,
): Promise<boolean> {
	for (const child of externalChildren) {
		if (child.kind !== 'component') continue;
		if (child.sectionTipo !== '' && child.sectionTipo !== sectionTipo) continue;
		if ((await externalComponentAppliesTo(child.tipo, sectionTipo)) === 'owner') return true;
	}
	return false;
}
