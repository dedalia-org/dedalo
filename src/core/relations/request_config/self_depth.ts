/**
 * LEVEL >= 2 'self' REFUSAL — owner decision (c) of the nested-ddo_map plan
 * (2026-11-03): `section_tipo: 'self'` is meaningful ONLY for a direct child of
 * the config owner.
 *
 * WHY. At the first level 'self' names the owner's TARGET sections: tch197
 * (portal → rsc1389) declaring `{tipo: rsc1399, parent: 'self', section_tipo:
 * 'self'}` means "rsc1399 in rsc1389". One level down there is no honest
 * reading left:
 *
 *   tch197 show.ddo_map:
 *     rsc1400 assigned user   parent self      section_tipo self     ← depth 1: rsc1389 ✓
 *       rsc85 name            parent rsc1400   section_tipo self     ← depth 2: ???
 *
 * PHP resolves the depth-2 'self' to tch197's targets (rsc1389) too; at
 * rsc1400's own targets (rsc197) that ddo then matches nothing and the name
 * DISAPPEARS. TS matched it as a wildcard and the name showed. Neither is a
 * definition anyone wrote on purpose, so the engine REFUSES it — the ddo is
 * skipped and a typed notice (`ontology.ddo_self_refused`) names the owner,
 * the ddo and its parent, so the definition can be corrected to an explicit
 * `section_tipo: "rsc197"` or a source array
 * `[{value:[1], source:"hierarchy_types"}]`.
 *
 * WHAT COUNTS AS 'self'. FOUR spellings, one sentinel:
 *
 *   'self'                                    the literal
 *   ['rsc197', 'self']                        a string inside an array
 *   [{source: 'self'}]                        a source-array self entry
 *   [{source: 'section', value: ['self']}]    'self' inside a SECTION-semantics
 *                                             entry's value (the shipped sqo
 *                                             grammar, e.g. rsc.copy ontology17)
 *
 * They are ONE sentinel because the resolver gives them ONE meaning at depth 1
 * (explicit.ts resolveDdoSectionTipo): all four name the owner's TARGET
 * sections — for tch197 a direct child's 'self', ['self'], [{source:'self'}] and
 * [{source:'section', value:['self']}] each resolve to ['rsc1389']. The same
 * ambiguity therefore hits all four at depth 2, and a refusal that only knew
 * some spellings would be a gate on a spelling (memory: "gates measure
 * outcomes"). A mixed entry splits: `{source:'section', value:['self','rsc197']}`
 * is the sentinel PLUS `{source:'section', value:['rsc197']}`.
 *
 * NOT the sentinel: a 'self' (or no value) inside a `section_model` entry. That
 * source has its own documented meaning — the MODEL TWIN of the caller's own
 * section (explicit.ts resolveSectionModelSource) — not "the targets"; its value
 * names caller sections to take the twin of. Likewise the other non-section
 * sources (hierarchy_types ids, field_value component tipos, …) never read a
 * value as a section, so a 'self' there is not a section reference at all.
 *
 * Gate: test/unit/ddo_section_tipo_source_array.test.ts (depth-1 equivalence)
 * beside test/unit/ddo_self_depth.test.ts (depth-2 refusal).
 *
 * PURE: no DB, no ALS. The callers (the per-element resolution and the
 * ontology check) decide what to do with the refusal — this module only
 * answers "is this ddo refused, and with which notice".
 */

import { SCALAR_BOUNDS } from '../../concepts/scalar_bounds.ts';
import { specOf } from '../../errors/registry.ts';
import type { ApiNotice } from '../../errors/schema.ts';

/** The code every refusal carries (registry: src/core/errors/registry.ts). */
export const DDO_SELF_REFUSED_CODE = 'ontology.ddo_self_refused' as const;

/** A ddo as far as the depth rule cares. */
export interface DepthDdo {
	readonly tipo: string;
	readonly parent?: unknown;
	readonly section_tipo?: unknown;
}

/**
 * The sqo `section_tipo` sources whose `value` is NOT a list of section tipos —
 * every one has its own case in explicit.ts resolveSqoSectionTipos. Any OTHER
 * source name ('section', the 'section_tipo' alias, an unknown name served by
 * PHP's default branch) reads its value as section tipos, so a 'self' there is
 * the sentinel. ONE list: explicit.ts builds its KNOWN_SQO_SOURCES from it
 * (this module cannot import explicit.ts — explicit.ts imports it).
 */
export const SQO_SOURCES_WITHOUT_SECTION_VALUE: ReadonlySet<string> = new Set([
	'self',
	'hierarchy_types',
	'section_model',
	'ontology_sections',
	'field_value',
	'hierarchy_terms',
]);

/** A source entry's value as a list — PHP `(array)$value`, as explicit.ts asSqoValueList. */
function entryValueList(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	return value === undefined || value === null || value === '' ? [] : [value];
}

/** One `section_tipo` entry split into its 'self' part and what is left. */
export interface SelfSplit {
	readonly namesSelf: boolean;
	/** The entry without its 'self'; `null` = nothing left. */
	readonly rest: unknown | null;
}

const SELF_ONLY: SelfSplit = { namesSelf: true, rest: null };

/** A source-array entry: a plain object (`{source, value}`), not a string or a list. */
function isSourceEntry(entry: unknown): entry is { source?: unknown; value?: unknown } {
	return entry !== null && typeof entry === 'object' && !Array.isArray(entry);
}

/**
 * Whether a source reads its `value` as section tipos (the 'section' branch,
 * its 'section_tipo' alias and PHP's default for any unknown name). A
 * source-less entry is no grammar at all — the resolver drops it.
 */
function readsValueAsSections(source: unknown): boolean {
	return (
		typeof source === 'string' && source !== '' && !SQO_SOURCES_WITHOUT_SECTION_VALUE.has(source)
	);
}

/** A section-semantics entry: its value's 'self' is the sentinel, the other tipos the rest. */
function splitSectionEntryValue(entry: { source?: unknown; value?: unknown }): SelfSplit {
	const values = entryValueList(entry.value);
	if (!values.includes('self')) return { namesSelf: false, rest: entry };
	const others = values.filter((tipo) => tipo !== 'self');
	return { namesSelf: true, rest: others.length === 0 ? null : { ...entry, value: others } };
}

/**
 * ONE entry of a `section_tipo` declaration, split into "does it spell 'self'"
 * and what is left of it once the 'self' is taken out (`null` = nothing left).
 *
 *   'self'                                      → self, rest null
 *   {source:'self'}                             → self, rest null
 *   {source:'section', value:['self']}          → self, rest null
 *   {source:'section', value:['self','rsc197']} → self, rest {source:'section', value:['rsc197']}
 *   'rsc197' / {source:'hierarchy_types', …}    → not self, rest = the entry itself
 *   {source:'section_model'} (no value)         → not self (its own meaning — module header)
 */
export function splitSelfSectionTipoEntry(entry: unknown): SelfSplit {
	if (entry === 'self') return SELF_ONLY;
	if (!isSourceEntry(entry)) return { namesSelf: false, rest: entry };
	if (entry.source === 'self') return SELF_ONLY;
	if (!readsValueAsSections(entry.source)) return { namesSelf: false, rest: entry };
	return splitSectionEntryValue(entry);
}

/** One entry of a `section_tipo` declaration that spells 'self' (module header, the four spellings). */
export function isSelfSectionTipoEntry(entry: unknown): boolean {
	return splitSelfSectionTipoEntry(entry).namesSelf;
}

/**
 * Whether a `section_tipo` value spells the 'self' sentinel in any of its
 * four forms (module header, WHAT COUNTS AS 'self').
 */
export function sectionTipoNamesSelf(sectionTipo: unknown): boolean {
	if (Array.isArray(sectionTipo)) return sectionTipo.some(isSelfSectionTipoEntry);
	return isSelfSectionTipoEntry(sectionTipo);
}

/**
 * The typed refusal for ONE ddo at a KNOWN depth relative to the config owner
 * (1 = direct child). `null` when the ddo is kept: depth 1 (first-level 'self'
 * is unchanged), or a section_tipo that is not 'self'.
 *
 * @param ownerTipo the element whose config holds the ddo_map (tch197)
 * @param ddo       the ddo being judged
 * @param depth     its depth below the owner (1 = parent is the owner / 'self')
 */
export function refuseDeepSelfSectionTipo(
	ownerTipo: string,
	ddo: DepthDdo,
	depth: number,
): ApiNotice | null {
	if (depth < 2) return null;
	if (!sectionTipoNamesSelf(ddo.section_tipo)) return null;
	const spec = specOf(DDO_SELF_REFUSED_CODE);
	return {
		code: DDO_SELF_REFUSED_CODE,
		label_key: spec.label_key,
		retryable: spec.retryable,
		details: {
			owner: printableTipo(ownerTipo),
			ddo: printableTipo(ddo.tipo),
			parent: typeof ddo.parent === 'string' ? printableTipo(ddo.parent) : '',
			depth,
			more: 0,
		},
	};
}

/** Longest tipo a notice echoes: the map may be client-sent (a 10 kB "tipo" is not echoed). */
const NOTICE_TIPO_MAX = 64;

/** A tipo as a notice carries it: capped at NOTICE_TIPO_MAX characters. */
function printableTipo(tipo: string): string {
	return tipo.length > NOTICE_TIPO_MAX ? `${tipo.slice(0, NOTICE_TIPO_MAX)}…` : tipo;
}

/**
 * The refusals as the notices a response may carry (partitionDeepSelfDdos):
 * one per DISTINCT (owner, ddo, parent) — a tipo declared twice under one
 * parent is one definition to correct, one toast — and at most
 * SCALAR_BOUNDS.ddoMapWarnings of them; the LAST shown notice's `more` counts
 * the distinct refusals left out (0 on the others), so nothing is hidden
 * silently AND the batch remainder is counted exactly once. `more` means "the
 * notices THIS notice stands for beyond itself" — the same meaning the
 * emission registry folds by (element_registry.ts addNotices: past its own
 * per-code bound, each folded notice adds 1 + its `more`), so two layers never
 * count one remainder twice.
 *
 *   2048 × {B<i> < A, self}  → 5 notices, more: 0, 0, 0, 0, 2043
 *   [{N<X, self}, {N<X, self}] → 1 notice, more: 0
 */
function boundedNotices(refusals: readonly ApiNotice[]): ApiNotice[] {
	const distinct = new Map<string, ApiNotice>();
	for (const notice of refusals) {
		const details = notice.details ?? {};
		const key = JSON.stringify([details.owner, details.ddo, details.parent]);
		if (!distinct.has(key)) distinct.set(key, notice);
	}
	const all = [...distinct.values()];
	const shown = all.slice(0, SCALAR_BOUNDS.ddoMapWarnings);
	const more = all.length - shown.length;
	const lastIndex = shown.length - 1;
	return shown.map((notice, index) => ({
		...notice,
		details: { ...notice.details, more: index === lastIndex ? more : 0 },
	}));
}

/**
 * Every ddo of ONE flat ddo_map with its depth below `ownerTipo`, refused or
 * kept. Depth is walked through the `parent` chain: a ddo whose parent is
 * 'self' or the owner is depth 1; otherwise one deeper than its parent's
 * depth. A parent named by several ddos (the same tipo declared twice) takes
 * its SHALLOWEST declaration. A ddo whose chain never reaches the owner (an
 * orphan, or a cycle) has no depth: it is KEPT here — it resolves nowhere
 * anyway, and refusing it would report a 'self' problem that is really a
 * broken chain. The children of a refused ddo stay in `kept` (they carry no
 * 'self' of their own to report); with their parent gone they hang under
 * nothing and resolve nowhere, which is the refusal's own consequence.
 *
 *   owner tch197, map [rsc1400<self (self), rsc85<rsc1400 (self)]
 *     → kept [rsc1400], notices [{owner:tch197, ddo:rsc85, parent:rsc1400, depth:2, more:0}]
 *
 * BOUNDED OUTPUT. Every refused ddo leaves `kept`, but the NOTICES are one
 * per distinct (owner, ddo, parent), at most SCALAR_BOUNDS.ddoMapWarnings, each
 * carrying `more` = the distinct refusals left out (boundedNotices), and every
 * tipo they echo is capped (printableTipo) — notices reach the page as toasts,
 * so a map of 2048 refused ddos is 5 toasts, never 2048:
 *
 *   owner P, map [A<self (rsc197), B1<A (self), …, B2047<A (self)]
 *     → kept [A], notices B1…B5 (depth 2), more 0 on B1…B4 and 2042 on B5 (the LAST shown)
 *
 * BOUNDED WALK. The map may be client-sent, so depth is computed level by level
 * (breadth-first, O(entries × depth)) — never by re-walking every declaration
 * of every ancestor, which is exponential on a map that declares each tipo twice
 * under the previous one. A cycle's back-edge (a → b → a) is recognized by the
 * shallowest chain of its parent already holding the ddo's own tipo.
 */
export function partitionDeepSelfDdos<D extends DepthDdo>(
	ownerTipo: string,
	ddoMap: readonly D[],
): { kept: D[]; notices: ApiNotice[] } {
	const depths = ddoMapDepths(ownerTipo, ddoMap);
	const kept: D[] = [];
	const refusals: ApiNotice[] = [];
	ddoMap.forEach((ddo, index) => {
		const depth = depths[index] ?? null;
		const notice = depth === null ? null : refuseDeepSelfSectionTipo(ownerTipo, ddo, depth);
		if (notice === null) kept.push(ddo);
		else refusals.push(notice);
	});
	// every refused ddo is skipped; the NOTICES are deduplicated and capped
	return { kept, notices: boundedNotices(refusals) };
}

/**
 * One level >= 2 'self' declaration as the ONTOLOGY CHECK reports it
 * (self_depth_check.ts): the raw ddo fields, unbounded and uncapped — the check
 * reads the installed ontology, not a client map, and an operator correcting
 * definitions needs every one of them, not five toasts.
 */
export interface DeepSelfFinding {
	readonly ddo: string;
	readonly parent: string;
	readonly depth: number;
}

/**
 * EVERY ddo of ONE flat ddo_map the engine refuses under decision (c) — the
 * same depth walk and the same 'self' sentinel as partitionDeepSelfDdos, so
 * the check lists exactly what a read would skip (one rule, two consumers).
 *
 *   owner tch197, map [rsc1400<self (self), rsc85<rsc1400 (self)]
 *     → [{ddo: rsc85, parent: rsc1400, depth: 2}]
 */
export function findDeepSelfDdos(
	ownerTipo: string,
	ddoMap: readonly DepthDdo[],
): DeepSelfFinding[] {
	const depths = ddoMapDepths(ownerTipo, ddoMap);
	const findings: DeepSelfFinding[] = [];
	ddoMap.forEach((ddo, index) => {
		const depth = depths[index] ?? null;
		if (depth === null || depth < 2 || !sectionTipoNamesSelf(ddo.section_tipo)) return;
		findings.push({
			ddo: ddo.tipo,
			parent: typeof ddo.parent === 'string' ? ddo.parent : '',
			depth,
		});
	});
	return findings;
}

/**
 * The depth of every ddo of ONE flat ddo_map below `ownerTipo` (1 = direct
 * child), `null` for a ddo whose chain never reaches the owner (an orphan, or
 * a cycle's back-edge). See partitionDeepSelfDdos for the rules and the
 * bounded, breadth-first walk.
 */
function ddoMapDepths(ownerTipo: string, ddoMap: readonly DepthDdo[]): (number | null)[] {
	const depths: (number | null)[] = ddoMap.map(() => null);
	// Shallowest depth of each tipo, and the parent tipo of that shallowest chain
	// (null at depth 1) — a forest, so walking it up always terminates.
	const shallowestDepth = new Map<string, number>();
	const shallowestParent = new Map<string, string | null>();
	const chainHolds = (fromTipo: string, tipo: string): boolean => {
		let current: string | null | undefined = fromTipo;
		while (current !== null && current !== undefined) {
			if (current === tipo) return true;
			current = shallowestParent.get(current);
		}
		return false;
	};
	const settle = (index: number, depth: number, parentTipo: string | null): void => {
		depths[index] = depth;
		const tipo = (ddoMap[index] as DepthDdo).tipo;
		if (!shallowestDepth.has(tipo)) {
			shallowestDepth.set(tipo, depth);
			shallowestParent.set(tipo, parentTipo);
		}
	};

	ddoMap.forEach((ddo, index) => {
		if (ddo.parent === 'self' || ddo.parent === ownerTipo) settle(index, 1, null);
	});
	for (let level = 1; ; level++) {
		const settledNow: [number, string][] = [];
		ddoMap.forEach((ddo, index) => {
			const parent = ddo.parent;
			if (depths[index] !== null || typeof parent !== 'string') return;
			if (shallowestDepth.get(parent) !== level) return;
			if (chainHolds(parent, ddo.tipo)) return; // the cycle's back-edge
			settledNow.push([index, parent]);
		});
		if (settledNow.length === 0) break;
		for (const [index, parent] of settledNow) settle(index, level + 1, parent);
	}
	return depths;
}
