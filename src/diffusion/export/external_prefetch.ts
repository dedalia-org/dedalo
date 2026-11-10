/**
 * THE EXPORT'S EXTERNAL SOURCES — batch prefetch of remote rows, and the
 * record of every cell an external source could not fully answer.
 *
 * Two halves, both run-scoped (one instance per export — grid.ts builds them
 * in openExportGridInScope, never at module scope):
 *
 * 1. PREFETCH (FIX 5, 2026-09-24). A component_external cell has no stored
 *    value: its record IS a remote record (engineering/EXTERNAL_SPEC.md §3).
 *    The walk resolves records one at a time, so each external cell used to
 *    fetch its remote row LIVE, in series — the value derivation's per-cell
 *    fallback (component_external/value.ts fetchOwnRow). A 20k-record
 *    bibliography export was 20k sequential round trips to Zenon.
 *
 *    Now, before each hydrate batch is walked, the batch's external TARGETS
 *    are collected from the plan and the batch's stored locators, fetched in
 *    ONE `fetchExternalRows` call (merged by record, field sets unioned,
 *    coalesced with any concurrent reader, served from the row cache when
 *    fresh, and parallel only up to DEDALO_EXTERNAL_MAX_CONCURRENCY at the
 *    transport door — no unbounded fan-out), and PARKED in the run's emission
 *    scratch (value.ts setPrefetchedExternalRows). A cell then derives from
 *    the parked row and issues no request.
 *
 *    WHAT IS PREDICTED (ExternalPrefetchPlan). Per exported field:
 *      - a LEAF component_external — targets = the records the declared path
 *        reaches at the leaf (the root record itself, or through any number
 *        of relation hops: rsc368 → zenon3);
 *      - a RELATION leaf whose own request_config children include
 *        component_external — targets = the leaf's stored locators (the
 *        rsc368 compact / fan-out cell, whose zenon3..zenon11 children read
 *        each locator target).
 *    Deeper fan-out (a relation child of a relation leaf, dataframe frames)
 *    is not predicted: those cells take the per-cell fallback, as before.
 *    Only targets the component BELONGS to are collected
 *    (value.ts externalComponentAppliesTo — a local rsc205 target of the
 *    mixed rsc368 portal is never sent to Zenon).
 *
 *    A WRONG PREDICTION CANNOT CHANGE A VALUE — AND COSTS NO REQUEST. The row
 *    layer requests every record with its SECTION's record field set
 *    (src/external/record_fields.ts: the id field + every field any of the
 *    section's component_external nodes maps), whatever fields this plan
 *    predicted, and each parked view names the fields it was requested with;
 *    value.ts serves a parked row only to a component whose fields it covers.
 *    So the prefetch, the per-cell fallback and a read's portal prepass all
 *    share ONE cache entry per record: an unpredicted cell is a cache hit, not
 *    a second GET (2026-09-24, WC-2026-09-24-external-record-field-set). The
 *    prefetch is an optimisation, never a precondition, and a prefetch failure
 *    is loud and non-fatal (every cell re-derives).
 *
 *    UNDER THE EXPORT FRONTIER (2026-09-24). The prefetch runs AHEAD of the
 *    walk, so it applies the walk's own crossing answer
 *    (resolver.ts exportCrossingAllowed) at every crossing the walk will make:
 *    a hop into a record, with the component the next step reads through it,
 *    and each target of a relation leaf. A crossing the frontier refuses is
 *    NOT followed: its record's locators are not read, and no remote id found
 *    behind it is sent to the service (the walk then reaches the same crossing
 *    and applies the refusal law itself). Otherwise the service would learn
 *    which remote records a record the caller cannot read cites, before the
 *    export aborts. The prefetch EMITS nothing: every value that reaches the
 *    file is still produced by the walk.
 *
 *    BOUNDED AGAINST A SICK SERVICE, AND STOPPABLE. fetchExternalRows starts
 *    the batch's records a few at a time, so each meets the breaker's CURRENT
 *    verdict (an opened circuit refuses the rest without a socket), and the
 *    export's Stop signal is passed in: no further record is started once it
 *    fires.
 *
 * 2. DEGRADATION LOG (FIX 4, 2026-09-24). An export is a deliverable: a Zenon
 *    column left blank because the service was down (or the breaker open)
 *    must not look like "this record has no author". Every degraded
 *    component_external cell the walk resolves is reported here
 *    (relation_list.ts CellValueResolveOptions.onExternalDegraded) and the
 *    export exposes a LIVE, BOUNDED summary: counts per (service, state), the
 *    number of exported records affected, and a capped sample of
 *    (record, component, remote id). tool_export copies it into the job
 *    manifest and serves it (list / preview / terminal frame); the protocol's
 *    'end' line carries it when present (so the NDJSON file and the
 *    get_export_grid stream carry the marker too — absent, both are
 *    byte-identical to before).
 *
 *    WHICH STATES ARE RECORDED (value.ts ExternalSourceState):
 *      incomplete — the file lacks a value (or part of one) it should hold:
 *        unavailable, timeout, circuit_open   (retryable: re-run later)
 *        disabled, misconfigured              (an operator must act)
 *        truncated  ('ok' with dropped values — the emission ceilings cut it)
 *      outdated   — stale: the value IS there, from the last good copy
 *        (a refresh failed); recorded, but the export is not incomplete.
 *      NOT recorded — not_found: the service ANSWERED that the record is not
 *        there (a real, definitive answer, like an empty stored field); and a
 *        foreign target (the column does not apply to that record). A record
 *        endpoint that answers 4xx for EVERY id is not an answer: past a streak
 *        it reads as `unavailable` (src/external/record_answers.ts) and is
 *        recorded like any unread source.
 *    `missing_cells` / `missing_records` count only the cells with NO value
 *    from the source (incomplete minus truncated), so the tool can say how many
 *    values could not be read without counting stale or cut ones.
 */

import {
	EXTERNAL_STATE_RETRYABLE,
	type ExternalSourceState,
	externalComponentAppliesTo,
	externalTransportDepsForRead,
	setPrefetchedExternalRows,
} from '../../core/components/component_external/value.ts';
import type { StoredSectionId } from '../../core/concepts/locator.ts';
import { canonicalizeStoredSectionId, isSectionId } from '../../core/concepts/section_id.ts';
import {
	getColumnNameByModel,
	getModelByTipo,
	getPropertiesByTipo,
} from '../../core/ontology/resolver.ts';
import type { EmissionContext } from '../../core/resolve/component_data.ts';
import type { ExternalCellDegradation } from '../../core/resolve/relation_list.ts';
import { resolveOwnConfigMap } from '../../core/section/list_definitions/section_list.ts';
import type { FieldPlan } from '../plan/types.ts';
import {
	type ExportAtomRun,
	exportCrossingAllowed,
	exportImplicitChildAllowed,
	loadExportRecord,
	prefetchExportRecords,
} from '../resolve/resolver.ts';

// ---------------------------------------------------------------------------
// 2. The degradation log
// ---------------------------------------------------------------------------

/** A recorded state: every non-answer ExternalSourceState, plus 'truncated'. */
export type ExportExternalDegradedState =
	| Exclude<ExternalSourceState, 'ok' | 'not_found'>
	| 'truncated';

/** The states that leave the file WITHOUT (part of) a value it should hold. */
const INCOMPLETE_STATES: ReadonlySet<ExportExternalDegradedState> = new Set([
	'unavailable',
	'timeout',
	'circuit_open',
	'disabled',
	'misconfigured',
	'truncated',
]);

/** The states whose cell holds NO value from the source (incomplete minus 'truncated'). */
const MISSING_STATES: ReadonlySet<ExportExternalDegradedState> = new Set([
	'unavailable',
	'timeout',
	'circuit_open',
	'disabled',
	'misconfigured',
]);

/** Sample entries kept at most (the counts are exact; the sample is an example). */
export const EXTERNAL_DEGRADATION_SAMPLE_LIMIT = 20;

/** One degraded cell, as the sample names it. */
export interface ExportExternalDegradedCell {
	/**
	 * The EXPORTED record (the row of the file) the cell belongs to — a matrix
	 * record ADDRESS (the export selects stored records; grid.ts types them
	 * `section_id: number`). The remote id lives in `remote_id`, verbatim.
	 */
	section_tipo: string;
	section_id: number;
	/** The component_external whose value degraded. */
	component_tipo: string;
	/** The remote record: its external section and its id, verbatim. */
	remote_section_tipo: string;
	remote_id: string;
	service: string;
	state: ExportExternalDegradedState;
}

/** The export's external-source summary (manifest / list / preview / 'end' line). */
export interface ExportExternalDegradation {
	/** Some cell lacks (part of) its value: the file is INCOMPLETE. */
	incomplete: boolean;
	/** Some incomplete cell's state is one a later re-run can plausibly fix. */
	retryable: boolean;
	/** Degraded cells: distinct (exported record, component, remote id). */
	cells: number;
	/** Exported records with at least one degraded cell. */
	records: number;
	/**
	 * Cells whose value is NOT in the file at all — the source could not be read
	 * (MISSING_STATES: every incomplete state but 'truncated'). A subset of
	 * `cells`: stale cells hold their last good value, truncated ones hold part.
	 */
	missing_cells: number;
	/** Exported records with at least one missing cell. */
	missing_records: number;
	/** Exact counts per (service, state), sorted. Bounded by services × states. */
	counts: { service: string; state: ExportExternalDegradedState; cells: number }[];
	/** The first degraded cells, at most `sample_limit`. */
	sample: ExportExternalDegradedCell[];
	sample_limit: number;
}

/** The run-scoped log (grid.ts wires `note` into the cell resolver). */
export interface ExternalDegradationLog {
	/** The walk moved on to this exported record (its cells follow). */
	beginRecord(sectionTipo: string, sectionId: number): void;
	/** One degraded cell of the current record. */
	note(event: ExternalCellDegradation): void;
	/** The summary so far, or null when nothing degraded. A detached copy. */
	snapshot(): ExportExternalDegradation | null;
}

/** The recorded state of a derivation status, or null when it is not recorded. */
export function degradedStateOf(state: ExternalSourceState): ExportExternalDegradedState | null {
	if (state === 'not_found') return null;
	// 'ok' carries a status only when values were DROPPED (the emission ceilings).
	if (state === 'ok') return 'truncated';
	return state;
}

export function createExternalDegradationLog(): ExternalDegradationLog {
	const counts = new Map<
		string,
		{ service: string; state: ExportExternalDegradedState; cells: number }
	>();
	const sample: ExportExternalDegradedCell[] = [];
	let cells = 0;
	let records = 0;
	let missingCells = 0;
	let missingRecords = 0;
	let current: { sectionTipo: string; sectionId: number } | null = null;
	let currentCounted = false;
	let currentMissingCounted = false;
	// Per-RECORD dedupe: the same cell may resolve twice for one record (a value
	// cell's label-chain derivation re-walks it) and the same remote record may
	// sit twice in one portal. Cleared at every record, so it is bounded by one
	// record's cells, never by the selection.
	let seenInRecord = new Set<string>();

	return {
		beginRecord(sectionTipo, sectionId) {
			current = { sectionTipo, sectionId };
			currentCounted = false;
			currentMissingCounted = false;
			seenInRecord = new Set();
		},
		note(event) {
			const state = degradedStateOf(event.status.state);
			if (state === null) return;
			const cellKey = `${event.componentTipo}\u0000${event.sectionTipo}\u0000${event.remoteId}`;
			if (seenInRecord.has(cellKey)) return;
			seenInRecord.add(cellKey);
			cells++;
			if (!currentCounted) {
				currentCounted = true;
				records++;
			}
			if (MISSING_STATES.has(state)) {
				missingCells++;
				if (!currentMissingCounted) {
					currentMissingCounted = true;
					missingRecords++;
				}
			}
			const service = event.status.service;
			const countKey = `${service}\u0000${state}`;
			const count = counts.get(countKey);
			if (count === undefined) counts.set(countKey, { service, state, cells: 1 });
			else count.cells++;
			// The sample names the EXPORTED record; a note before any beginRecord (no
			// caller does that) is counted but not sampled rather than attributed to
			// an invented address.
			if (current !== null && sample.length < EXTERNAL_DEGRADATION_SAMPLE_LIMIT) {
				sample.push({
					section_tipo: current.sectionTipo,
					section_id: current.sectionId,
					component_tipo: event.componentTipo,
					remote_section_tipo: event.sectionTipo,
					remote_id: event.remoteId,
					service,
					state,
				});
			}
		},
		snapshot() {
			if (cells === 0) return null;
			const sorted = [...counts.values()]
				.map((entry) => ({ ...entry }))
				.sort((a, b) =>
					a.service === b.service
						? a.state < b.state
							? -1
							: a.state > b.state
								? 1
								: 0
						: a.service < b.service
							? -1
							: 1,
				);
			const incompleteCounts = sorted.filter((entry) => INCOMPLETE_STATES.has(entry.state));
			return {
				incomplete: incompleteCounts.length > 0,
				retryable: incompleteCounts.some(
					(entry) => entry.state !== 'truncated' && EXTERNAL_STATE_RETRYABLE[entry.state],
				),
				cells,
				records,
				missing_cells: missingCells,
				missing_records: missingRecords,
				counts: sorted,
				sample: sample.map((entry) => ({ ...entry })),
				sample_limit: EXTERNAL_DEGRADATION_SAMPLE_LIMIT,
			};
		},
	};
}

// ---------------------------------------------------------------------------
// 1. The prefetch
// ---------------------------------------------------------------------------

/**
 * Remote targets collected per batch at most. A batch past it prefetches the
 * first targets and leaves the rest to the per-cell fallback (still correct,
 * just not batched) — the bound keeps one batch's parked rows, and the
 * fetchExternalRows promise set, finite whatever the portals hold.
 */
export const EXTERNAL_PREFETCH_MAX_TARGETS = 5000;

/** Records one prefetch hop level follows at most (same fallback rule). */
const MAX_HOP_OWNERS = 20_000;

/** What one exported field needs from external sources (plan-static). */
interface ExternalDemand {
	/** The section the field's path starts in (buildEntries applies it to those records only). */
	rootSection: string;
	/** Relation hops from the root record to the leaf's owner record. */
	hops: string[];
	/** A leaf component_external read at the leaf owner record. */
	leafExternal: string | null;
	/** A relation leaf whose stored targets carry these external children. */
	relationLeaf: string | null;
	externalChildren: string[];
	/**
	 * The externalChildren that came from the leaf's IMPLICIT map: each answers
	 * to the caller's grant at the target section (T0-1 / S03 — the walk drops
	 * an ungranted one, so the look-ahead must not ask the source for it).
	 */
	implicitChildren: ReadonlySet<string>;
}

/** The run's prediction: demands + the remote fields of every predicted component. */
export interface ExternalPrefetchPlan {
	demands: ExternalDemand[];
	/** component_external tipo → the remote fields its fields_map reads. */
	fieldsOf: ReadonlyMap<string, readonly string[]>;
}

/** The root section a field applies to (grid.ts buildEntries' guard, same reading). */
function rootSectionOf(field: FieldPlan): string {
	const first = (field.exportColumn?.path ?? [])[0] as { section_tipo?: unknown } | undefined;
	const declared = first?.section_tipo;
	return String(Array.isArray(declared) ? (declared[0] ?? '') : (declared ?? ''));
}

/** A component_external's remote fields, or [] (a malformed map degrades per cell). */
async function remoteFieldsOfComponent(componentTipo: string): Promise<string[]> {
	const api = await import('../../external/api/index.ts');
	const properties = (await getPropertiesByTipo(componentTipo)) as { fields_map?: unknown } | null;
	try {
		return api.remoteFieldsOf(api.parseFieldsMap(properties?.fields_map, { tipo: componentTipo }));
	} catch {
		return [];
	}
}

async function isExternalModel(tipo: string): Promise<boolean> {
	return (await getModelByTipo(tipo)) === 'component_external';
}

/**
 * The relation leaf's own-config children that are component_external — the
 * same child set relation_list.ts resolveRelationTargetValues and atoms.ts
 * fanOutRelation read (own request_config ddos parented to the component,
 * plus the implicit legacy relations).
 */
async function externalChildrenOf(
	relationTipo: string,
): Promise<{ tipos: string[]; implicit: Set<string> }> {
	const cell = await resolveOwnConfigMap(relationTipo);
	const out: string[] = [];
	const implicit = new Set<string>();
	for (const child of cell.rawDdos ?? []) {
		if (typeof child?.tipo !== 'string') continue;
		if (child.parent !== undefined && child.parent !== 'self' && child.parent !== relationTipo) {
			continue;
		}
		if ((await isExternalModel(child.tipo)) && !out.includes(child.tipo)) out.push(child.tipo);
	}
	for (const tipo of cell.implicitRelations ?? []) {
		if ((await isExternalModel(tipo)) && !out.includes(tipo)) {
			out.push(tipo);
			implicit.add(tipo);
		}
	}
	return { tipos: out, implicit };
}

/**
 * Compile the run's prediction from the export plan, ONCE per run. Empty
 * (nothing to prefetch) for a plan with no external column — the common case
 * costs one model lookup per field step.
 */
export async function planExternalPrefetch(
	fields: readonly FieldPlan[],
): Promise<ExternalPrefetchPlan> {
	const demands: ExternalDemand[] = [];
	const fieldsOf = new Map<string, readonly string[]>();
	const remember = async (tipo: string): Promise<boolean> => {
		if (!fieldsOf.has(tipo)) fieldsOf.set(tipo, await remoteFieldsOfComponent(tipo));
		return (fieldsOf.get(tipo) ?? []).length > 0;
	};
	for (const field of fields) {
		const chain = field.sourceChain.filter(
			(step): step is Extract<typeof step, { tipo: string; model: string }> =>
				step.kind === 'component' || step.kind === 'relation-hop',
		);
		const leaf = chain[chain.length - 1];
		if (leaf === undefined || leaf.tipo === '') continue;
		const hops = chain.slice(0, -1).map((step) => step.tipo);
		if (hops.includes('')) continue;
		const rootSection = rootSectionOf(field);
		const leafModel = (await getModelByTipo(leaf.tipo)) ?? leaf.model;
		if (leafModel === 'component_external') {
			if (await remember(leaf.tipo)) {
				demands.push({
					rootSection,
					hops,
					leafExternal: leaf.tipo,
					relationLeaf: null,
					externalChildren: [],
					implicitChildren: new Set(),
				});
			}
			continue;
		}
		// Only a relation leaf has config children to fan out through.
		if (getColumnNameByModel(leafModel) !== 'relation') continue;
		const children: string[] = [];
		const declared = await externalChildrenOf(leaf.tipo);
		for (const child of declared.tipos) {
			if (await remember(child)) children.push(child);
		}
		if (children.length > 0) {
			demands.push({
				rootSection,
				hops,
				leafExternal: null,
				relationLeaf: leaf.tipo,
				externalChildren: children,
				implicitChildren: declared.implicit,
			});
		}
	}
	return { demands, fieldsOf };
}

/**
 * A record the prefetch walks through. A hop's TARGET may be a matrix address
 * (canonical int) or an external remote id (verbatim string — '000065686' is
 * never Number()-ed): the stored-locator id type, StoredSectionId.
 */
interface Owner {
	sectionTipo: string;
	sectionId: StoredSectionId;
}

/** The raw stored 'relation' slice of one component of a loaded record. */
function relationBag(
	record: { columns: { relation?: unknown } } | null,
	tipo: string,
): { section_tipo?: unknown; section_id?: unknown }[] {
	const bag = (record?.columns.relation as Record<string, unknown[]> | null)?.[tipo];
	return Array.isArray(bag) ? (bag as { section_tipo?: unknown; section_id?: unknown }[]) : [];
}

/** Bulk-hydrate the owners' matrix records (address ids only) into the run cache. */
async function hydrateOwners(run: ExportAtomRun, owners: readonly Owner[]): Promise<void> {
	const bySection = new Map<string, number[]>();
	for (const owner of owners) {
		const address = canonicalizeStoredSectionId(owner.sectionId);
		if (!isSectionId(address)) continue;
		const ids = bySection.get(owner.sectionTipo);
		if (ids === undefined) bySection.set(owner.sectionTipo, [address]);
		else ids.push(address);
	}
	for (const [sectionTipo, ids] of bySection) await prefetchExportRecords(run, sectionTipo, ids);
}

/**
 * The owners' stored locators under `tipo`, as the next owners (deduped,
 * bounded) — only those the export frontier lets the walk cross into, reading
 * `nextComponent` through them (the walk's own crossing: resolver.ts
 * resolveRecordAtoms asserts the same (section, id, next step tipo)).
 */
async function followLocators(
	run: ExportAtomRun,
	owners: readonly Owner[],
	tipo: string,
	nextComponent: string | undefined,
): Promise<Owner[]> {
	await hydrateOwners(run, owners);
	const next: Owner[] = [];
	const seen = new Set<string>();
	for (const owner of owners) {
		const record = await loadExportRecord(run, owner.sectionTipo, owner.sectionId);
		for (const locator of relationBag(record, tipo)) {
			if (typeof locator?.section_tipo !== 'string' || locator.section_id === undefined) continue;
			if (locator.section_id === null) continue;
			// The canonical stored form: a matrix address becomes the int, an external
			// remote id stays VERBATIM ('000065686' — never Number()-ed).
			const sectionId = canonicalizeStoredSectionId(locator.section_id) as StoredSectionId;
			const key = `${locator.section_tipo}\u0000${String(sectionId)}`;
			if (seen.has(key)) continue;
			seen.add(key);
			if (!(await exportCrossingAllowed(run, locator.section_tipo, sectionId, nextComponent))) {
				continue;
			}
			next.push({ sectionTipo: locator.section_tipo, sectionId });
			if (next.length >= MAX_HOP_OWNERS) return next;
		}
	}
	return next;
}

/** One batch's collected targets: record key → (section, id), and the fields per section. */
class TargetSet {
	readonly targets = new Map<string, { sectionTipo: string; remoteId: string }>();
	readonly fieldsBySection = new Map<string, Set<string>>();

	get full(): boolean {
		return this.targets.size >= EXTERNAL_PREFETCH_MAX_TARGETS;
	}

	async add(
		componentTipo: string,
		sectionTipo: string,
		rawId: unknown,
		plan: ExternalPrefetchPlan,
		isExternalSection: (sectionTipo: string) => Promise<boolean>,
	): Promise<void> {
		if (rawId === null || rawId === undefined) return;
		const remoteId = String(rawId);
		// The derivation refuses these as misconfigured; never ask the service.
		if (remoteId === '' || remoteId.includes('|')) return;
		if ((await externalComponentAppliesTo(componentTipo, sectionTipo)) !== 'owner') return;
		// A section that names no service cannot be fetched (the cell says
		// 'misconfigured' on its own); asking would throw for the whole batch.
		if (!(await isExternalSection(sectionTipo))) return;
		const key = `${sectionTipo}|${remoteId}`;
		if (!this.targets.has(key)) {
			if (this.full) return;
			this.targets.set(key, { sectionTipo, remoteId });
		}
		let fields = this.fieldsBySection.get(sectionTipo);
		if (fields === undefined) {
			fields = new Set();
			this.fieldsBySection.set(sectionTipo, fields);
		}
		for (const field of plan.fieldsOf.get(componentTipo) ?? []) fields.add(field);
	}
}

/** The signal's state NOW (a call, so TS does not narrow it across awaits). */
function isAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

/** What one batch prefetch did (the gates read it; production ignores it). */
export interface ExternalPrefetchOutcome {
	/** Distinct remote records asked for (after the row cache/coalescing). */
	targets: number;
}

/**
 * Prefetch the remote rows of ONE hydrate batch and park them on `emission`
 * (replacing the previous batch's — the parked set stays one batch big).
 * NEVER THROWS: a failure is logged and the cells fall back to their own fetch.
 */
export async function prefetchExternalRowsForBatch(
	run: ExportAtomRun,
	plan: ExternalPrefetchPlan,
	/** The hydrate batch: exported (stored) records, by matrix address. */
	batch: readonly { section_tipo: string; section_id: number }[],
	dataLang: string,
	emission: EmissionContext,
	signal?: AbortSignal,
): Promise<ExternalPrefetchOutcome> {
	// Drop the previous batch's rows first: bounded, and never served to a
	// record of this batch under a coverage map that no longer describes them.
	setPrefetchedExternalRows(emission, new Map(), new Map());
	if (plan.demands.length === 0) return { targets: 0 };
	try {
		const api = await import('../../external/api/index.ts');
		const externalSections = new Map<string, boolean>();
		const isExternalSection = async (sectionTipo: string): Promise<boolean> => {
			let known = externalSections.get(sectionTipo);
			if (known === undefined) {
				// The ONE externality predicate (binding + an owned component_external).
				// The caller already proved ownership, so this is the binding half.
				known = await api.isExternalReferenceSection(sectionTipo);
				externalSections.set(sectionTipo, known);
			}
			return known;
		};
		const set = new TargetSet();
		for (const demand of plan.demands) {
			if (set.full || signal?.aborted === true) break;
			let owners: Owner[] = batch
				.filter((record) => record.section_tipo === demand.rootSection)
				.map((record) => ({ sectionTipo: record.section_tipo, sectionId: record.section_id }));
			// The component each hop's crossing reads through: the next hop, or the leaf.
			const leafTipo = demand.leafExternal ?? demand.relationLeaf ?? undefined;
			for (const [index, hop] of demand.hops.entries()) {
				// (read through a call: the signal flips while hops are awaited)
				if (owners.length === 0 || isAborted(signal)) break;
				owners = await followLocators(run, owners, hop, demand.hops[index + 1] ?? leafTipo);
			}
			if (owners.length === 0) continue;
			if (demand.leafExternal !== null) {
				for (const owner of owners) {
					await set.add(
						demand.leafExternal,
						owner.sectionTipo,
						owner.sectionId,
						plan,
						isExternalSection,
					);
				}
				continue;
			}
			if (demand.relationLeaf === null) continue;
			await hydrateOwners(run, owners);
			for (const owner of owners) {
				const record = await loadExportRecord(run, owner.sectionTipo, owner.sectionId);
				for (const locator of relationBag(record, demand.relationLeaf)) {
					if (typeof locator?.section_tipo !== 'string') continue;
					if (locator.section_id === undefined || locator.section_id === null) continue;
					// A relation LEAF's target is a crossing too (the walk asserts it with
					// no component): a target the caller may not reach is never asked for.
					const targetId = canonicalizeStoredSectionId(locator.section_id) as StoredSectionId;
					if (!(await exportCrossingAllowed(run, locator.section_tipo, targetId, undefined))) {
						continue;
					}
					for (const child of demand.externalChildren) {
						// An IMPLICIT child the walk will drop for this caller (D1) is
						// never asked of the remote source either.
						if (
							demand.implicitChildren.has(child) &&
							!(await exportImplicitChildAllowed(run, locator.section_tipo, child))
						) {
							continue;
						}
						await set.add(child, locator.section_tipo, locator.section_id, plan, isExternalSection);
					}
				}
			}
		}
		if (set.targets.size === 0 || signal?.aborted === true) return { targets: 0 };
		const targets = [...set.targets.values()].map((target) => ({
			sectionTipo: target.sectionTipo,
			remoteId: target.remoteId,
			remoteFields: [...(set.fieldsBySection.get(target.sectionTipo) ?? [])],
		}));
		const deps = externalTransportDepsForRead(emission);
		const views = await api.fetchExternalRows(targets, {
			dataLang,
			...(deps === undefined ? {} : { deps }),
			...(signal === undefined ? {} : { signal }),
		});
		setPrefetchedExternalRows(emission, views, set.fieldsBySection);
		return { targets: targets.length };
	} catch (error) {
		// Loud (CONVENTIONS §1) and non-fatal: every external cell of the batch
		// re-derives on its own through the per-cell fallback.
		console.error(
			'[diffusion/export] external prefetch failed; the batch falls back per cell',
			error,
		);
		setPrefetchedExternalRows(emission, new Map(), new Map());
		return { targets: 0 };
	}
}
