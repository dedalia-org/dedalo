/**
 * PICKER CONSTRAINT — the ONE resolver behind the thesaurus picker's
 * affordances AND behind the relation write chokepoint that persists a pick.
 *
 * WHY IT IS ONE MODULE. The picker asks two questions and the save asks the
 * same two: "which sections may this caller link into" and "how many more may
 * it hold". Answered twice, the two answers drift and the UI offers what the
 * write refuses (or, worse, the reverse). So the read path (the area picker
 * read, which decides what the tree renders) and the write path
 * (`relations/save.ts validateRelationInsert`) both call the functions here —
 * the affordance and the persistence answer are literally the same value.
 * Nothing the request carries feeds them: the caller ddo names itself and the
 * server derives the rest (picker plan §1.2 — a client-declared cap or target
 * set is a second authority that can be forged or go stale).
 *
 * WHAT IT DOES NOT DO (picker plan §1.8, the table). The caller's
 * request_config contributes EXACTLY ONE fact: which section(s) the picker
 * opens. It does NOT bound the tree (a thesaurus is browsed, not paged — no
 * `sqo_config.limit` is read here), it does NOT render the tree (the caller's
 * `ddo_map` governs how a LINKED value is displayed back in the caller, and is
 * never pushed into the picker), and it does NOT decide selectability. The
 * only count that exists is the caller's own `properties.data_limit`.
 *
 * PER-TERM SELECTABILITY IS THE TERM'S OWN ANSWER (picker plan §1.9) — see
 * {@link isTermSelectable}: relation mode means the thesaurus itself declares,
 * term by term, what may be linked. That rule is `ts_object.isIndexable` and is
 * NOT reimplemented here.
 */

import { asSectionId, canonicalizeStoredSectionId } from '../concepts/section_id.ts';
import type { DataframePairing } from '../concepts/subdatum.ts';
import { memoizedReadMatrixRecord } from '../db/record_memo.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { createOntologyCache } from '../ontology/cache_factory.ts';
import {
	getColumnNameByModel,
	getMatrixTableFromTipo,
	getModelByTipo,
	getNode,
	getNodesWithProperty,
} from '../ontology/resolver.ts';
import { getSectionRealTipo } from '../resolve/security_access_datalist.ts';
import { listEffectiveToolConfigurationOverrides, toolConfigGeneration } from '../tools/config.ts';
import { TOOL_PICKER_WIRING } from '../tools/picker_wiring.ts';
import { isIndexable } from '../ts_object/ts_object.ts';
import { getElementTargetSectionTipos } from './request_config/build.ts';

/**
 * The resolved constraint for ONE picker caller.
 *
 * Field names are the wire names the picker read emits and the client's
 * `attach_picker` consumes — snake_case like every other context field, not
 * the camelCase of internal TS.
 */
export interface PickerConstraint {
	/**
	 * The caller's resolved `properties.data_limit`: how many locators this
	 * component may hold in total. `null` = ABSENT = uncapped. A literal `0`
	 * is a real answer ("none may be linked") and is returned as `0`.
	 */
	selection_limit: number | null;
	/**
	 * `selection_limit - (locators the caller already holds)`, or `null` when
	 * uncapped. This — never `selection_limit` — is what a picker session may
	 * add. May be NEGATIVE (a component that already exceeds a limit tightened
	 * after the fact); deliberately not clamped, because "over capacity by 2"
	 * is information an operator needs and `<= 0` is the one test consumers
	 * make anyway.
	 */
	remaining: number | null;
	/**
	 * The sections this caller may link into, REAL-resolved (see
	 * {@link isTargetAllowed} for the comparison law). Empty = the caller
	 * declares no target at all; that is not "nothing is allowed", it is "no
	 * target constraint exists" — the write path's declared exemption.
	 */
	targets: string[];
}

/**
 * The mode the target set is resolved in — ONE constant, because the read path
 * and the write path must ask the identical question.
 *
 * 'search' is `getElementTargetSectionTipos`' own documented default (PHP
 * get_section_elements_context instantiates every element in search mode). For
 * a COMPONENT owner it is also indistinguishable from 'edit': the section_list
 * source substitution only fires in list/tm/list_thesaurus
 * (`request_config/build.ts buildStrategyRequestConfig`), and nothing else in
 * the explicit/implicit builders reads the mode while resolving
 * `sqo.section_tipo`. The write path has no mode to offer, so pinning it here
 * is what keeps the two call sites from diverging.
 */
const TARGET_RESOLUTION_MODE = 'search';

/**
 * Resolve the picker constraint for a caller ddo.
 *
 * `callerSectionId` is the record the caller component sits on — the picker's
 * capacity is a property of THAT record's stored value, not of the component
 * in the abstract. Accepts the URL-shaped string the picker request carries and
 * canonicalizes it (`concepts/section_id.ts`); anything that is not a record
 * address throws rather than silently counting zero locators and handing back a
 * too-generous `remaining`.
 *
 * `pairing` is the CAP SCOPE for a dataframe caller: `data_limit` on a frame
 * slot is declared per MAIN ITEM, so `held` (and therefore `remaining`) counts
 * the frames of THAT item, not the whole slot. Null = an ordinary relation
 * component, whose scope is the slot. See {@link inCapScope}.
 */
export async function resolvePickerConstraint(
	callerTipo: string,
	callerSectionTipo: string,
	callerSectionId: number | string,
	pairing: DataframePairing | null = null,
): Promise<PickerConstraint> {
	const sectionId = asSectionId(canonicalizeStoredSectionId(callerSectionId));

	const selectionLimit = await resolveSelectionLimit(callerTipo);
	const held = await countHeldLocators(callerTipo, callerSectionTipo, sectionId, pairing);
	const targets = await resolveCallerTargets(callerTipo, callerSectionTipo);

	return {
		selection_limit: selectionLimit,
		remaining: selectionLimit === null ? null : selectionLimit - held,
		targets,
	};
}

/**
 * The caller's `properties.data_limit`, or null when absent.
 *
 * SOURCE. The ontology node's own top-level properties — which IS what the
 * client reads: in edit mode `context.properties` is a sanitized deep clone of
 * exactly this object (`resolve/structure_context.ts resolveEmittedPropertiesAndCss`),
 * and `component_portal.js data_limit_reached` reads
 * `self.context.properties.data_limit` off it. Same bytes, one meaning.
 *
 * TWO DELIBERATE DIVERGENCES FROM THE CLIENT GUARD, both stated in the picker
 * plan §1.8:
 *   - the client's `if (data_limit && …)` treats a literal `0` as "no limit"
 *     (JS truthiness). Here `0` means "none may be linked" and is honoured;
 *     ABSENT is the uncapped case, and the two are different facts.
 *   - the client counts only the entries on the loaded page ("a soft
 *     client-side cap", its own comment). This counts the stored array.
 *
 * A PRESENT-BUT-UNUSABLE value THROWS (CONVENTIONS §1 fail-loud: a contract
 * violation naming the module and the input). Degrading to "uncapped" would
 * turn an ontology typo into a silently unlimited component on the write path;
 * degrading to `0` would lock a live component out of editing. Neither is an
 * answer, so there is no third behaviour to pick between — the operator fixes
 * the node.
 */
async function resolveSelectionLimit(callerTipo: string): Promise<number | null> {
	const properties = (await getNode(callerTipo))?.properties as
		| { data_limit?: unknown }
		| null
		| undefined;
	const declared = properties?.data_limit;
	if (declared === undefined || declared === null) return null;
	if (typeof declared !== 'number' || !Number.isInteger(declared) || declared < 0) {
		throw new DedaloError('area.picker_caller_invalid', {
			message:
				`[relations/picker_constraint] node '${callerTipo}' declares an unusable ` +
				`properties.data_limit (${JSON.stringify(declared)}). It must be a JSON number: a ` +
				'non-negative integer, or absent for no limit.',
			publicMessage: 'The picker caller declares an unusable data_limit',
			coordinates: { tipo: callerTipo },
		});
	}
	return declared;
}

/**
 * How many locators the caller already holds on this record.
 *
 * REUSES the engine's one way of reading a component's relation entries —
 * `getMatrixTableFromTipo` → `readMatrixRecord` → `columns[<column>][<tipo>]`,
 * the same three steps `ts_object.isIndexable`, `relations/save.ts` (its
 * `existingItems`) and `section/record/delete_record.ts` take. No new query,
 * and in particular the SAME array the write path dedups against, so
 * `remaining` and the insert refusal count identically.
 *
 * The column comes from the model (`getColumnNameByModel`) rather than a
 * hardcoded 'relation' — and a caller whose model does not store in the
 * relation column is an UNCOVERED path, not a zero: it throws naming the node
 * and its model. Only relation-family components reach the picker (the read
 * path grants picker mode on model + view), so this can only fire on a wiring
 * mistake, and a wiring mistake must not answer "capacity: unlimited".
 *
 * A record that does not exist yet (a new, unsaved caller record) holds
 * nothing — 0, which is an answer, not a missing one.
 *
 * Counted IN THE CAP SCOPE ({@link inCapScope}): the whole slot for a relation
 * component, the main item's frames for a dataframe pairing — the same filter
 * the write path applies to the count it compares against, so `held` and
 * `resulting` can never be measured in different units.
 */
async function countHeldLocators(
	callerTipo: string,
	callerSectionTipo: string,
	sectionId: number,
	pairing: DataframePairing | null,
): Promise<number> {
	const model = await getModelByTipo(callerTipo);
	const column = model === null ? null : getColumnNameByModel(model);
	if (column !== 'relation') {
		throw new DedaloError('area.picker_caller_invalid', {
			message:
				`[relations/picker_constraint] node '${callerTipo}' (model '${String(model)}') does not ` +
				`store in the relation column (resolved column: ${String(column)}), so it holds no ` +
				'locators to count. Only relation-family components carry a picker constraint.',
			publicMessage: 'Only relation-family components carry a picker constraint',
			coordinates: { tipo: callerTipo, model: String(model) },
		});
	}
	const table = await getMatrixTableFromTipo(callerSectionTipo);
	if (table === null) {
		throw new DedaloError('area.picker_caller_invalid', {
			message:
				`[relations/picker_constraint] section '${callerSectionTipo}' resolves to no matrix ` +
				`table, so the locators held by '${callerTipo}' cannot be counted.`,
			publicMessage: "The picker caller's section holds no records",
			coordinates: { tipo: callerTipo, section_tipo: callerSectionTipo },
		});
	}
	const record = await memoizedReadMatrixRecord(table, callerSectionTipo, sectionId);
	const items = (record?.columns.relation as Record<string, unknown[]> | null)?.[callerTipo];
	return Array.isArray(items) ? inCapScope(items, pairing).length : 0;
}

/**
 * THE CAP SCOPE — the ONE filter that decides which stored entries a
 * `data_limit` counts.
 *
 * `data_limit` on an ordinary relation component bounds the SLOT: every entry
 * counts. On a dataframe it is declared per MAIN ITEM — one slot tipo stores
 * the frames of every item of the main component on the record
 * (`relations/dataframe.ts filterCallerEntries` is the read twin) — so only
 * the entries paired to THIS main item (`main_component_tipo` + `id_key`,
 * String()-compared like `dataframeEntriesEqual`) count. Counting the slot
 * would make a `data_limit:1` frame slot accept the first item's frame and
 * refuse every sibling's (or, on the `held` side, let one item grow past its
 * cap behind its siblings' frames). Exported so the resolver's `held` and the
 * write path's `resulting` are the same predicate by construction.
 */
export function inCapScope(items: readonly unknown[], pairing: DataframePairing | null): unknown[] {
	if (pairing === null) return [...items];
	return items.filter((item) => {
		if (item === null || typeof item !== 'object') return false;
		const entry = item as Record<string, unknown>;
		return (
			String(entry.main_component_tipo) === String(pairing.mainComponentTipo) &&
			String(entry.id_key) === String(pairing.idKey)
		);
	});
}

/**
 * The caller's target sections, REAL-resolved and deduped.
 *
 * ONE ACCESSOR, NOT A RE-DERIVATION. `getElementTargetSectionTipos`
 * (`request_config/build.ts`) is the resolved accessor — it builds the caller's
 * request_config through the ordinary seam (explicit/implicit + the
 * model-default targetSource) and projects the sqo targets with
 * `extractSqoSectionTipos`. It is the SAME projection `structure_context.ts`
 * uses to emit `context.target_sections`, so the picker's target set and the
 * target list the client already receives cannot disagree.
 *
 * ON "the MAIN sqo" (picker plan §1.3/§1.8 phrasing): every config item the
 * builders produce is typed 'main' unless the ontology says otherwise
 * (`explicit.ts` defaults `type` to 'main'; `implicit.ts` hardcodes it), and a
 * handful of live nodes declare their ONLY config as `type: "internal"`.
 * Filtering to 'main' would resolve those to zero targets and hand the write
 * path the no-target exemption — i.e. it would REMOVE a constraint. The
 * accessor's every-config projection is therefore what is used, and it is also
 * the one that matches `context.target_sections`.
 *
 * VIRTUAL RESOLUTION. Each tipo goes through `getSectionRealTipo`, so a
 * declared virtual target (rsc170 → rsc2) and a real one name the same thing.
 * The returned set is the REAL side of the comparison; the other side must be
 * resolved too — see {@link isTargetAllowed}.
 *
 * Deduping is safe HERE and only here: this is a membership set, not the
 * `target_sections` wire list (which mirrors PHP's cross-config concatenation
 * verbatim and must keep its repeats).
 *
 * EXPORTED for the one write path that must ask BEFORE it writes:
 * tool_import_rdf checks every link its plan would make against exactly this
 * set (and {@link isTargetAllowed}), so an ontology mapping a section the
 * component does not target is skipped with the reason instead of reaching the
 * insert door's off_target refusal. One resolution, never a second copy.
 */
export async function resolveCallerTargets(
	callerTipo: string,
	callerSectionTipo: string,
): Promise<string[]> {
	const declared = await getElementTargetSectionTipos(
		callerTipo,
		callerSectionTipo,
		TARGET_RESOLUTION_MODE,
	);
	// Keep the DECLARED tipos, deduped — do NOT collapse them to their real
	// sections here. EVERY thesaurus is a virtual section over the same real
	// node (`es1`, `ad1`, `fr1` … all real-resolve to `hierarchy20`), so
	// real-resolving the declared side makes a caller that names ONE thesaurus
	// indistinguishable from one that names all ~150 — i.e. the target
	// constraint becomes vacuous, which is the opposite of its purpose.
	// The virtual/real reconciliation belongs in the COMPARISON, asymmetrically
	// (see {@link isTargetAllowed}), never in the stored set.
	const targets = [...new Set(declared)];
	// THE SECOND DECLARATION CHANNEL. A tool may wire a picker source into this
	// caller that its own request_config never names — see
	// {@link toolDeclaredTargets}. Unioned only into a NON-EMPTY set: an empty
	// one is the "no target constraint" exemption (isTargetAllowed), and growing
	// it from nothing would turn an unconstrained caller into a constrained one
	// — a refusal invented by this function, not declared by anybody.
	if (targets.length === 0) return targets;
	for (const target of await toolDeclaredTargets(callerTipo)) {
		if (!targets.includes(target)) targets.push(target);
	}
	return targets;
}

/**
 * The sections a TOOL declares as picker sources for this caller.
 *
 * WHY THIS EXISTS. `request_config` is not the only place the ontology says
 * "these records may be linked into that component". A tool's
 * `properties.tool_config.<tool>.ddo_map` wires a set of ddos into one working
 * surface, and some of those entries are SECTIONS the operator picks from,
 * published into a sibling entry that is a relation component. tool_indexation
 * is the live case: its map pairs `indexing_component` (rsc860, the portal that
 * stores the links) with `people_section` (rsc197, a plain section browsed as a
 * thesaurus list), and `tool_indexation.js` assigns
 * `people_section.linker = indexing_component`. Nothing in rsc860's own
 * request_config — hierarchies, from `source: 'hierarchy_types'` — names
 * rsc197, so gate 1 of the write door refused a link the tool exists to make
 * (`off_target`), while the client offered the affordance from the tool_config
 * it had rendered. Two authorities declared what may be linked and only one was
 * enforced; this reads the other one, from the SAME ontology bytes the client
 * was handed, so the affordance and the persistence stay one answer.
 *
 * PAIRED BY ROLE, NEVER BY CROSS-PRODUCT. The pair comes from
 * `tools/picker_wiring.ts` — the mirror of the tool's own single JS assignment,
 * married to it by `tool_picker_wiring_tripwire`. Within one `ddo_map`, for
 * each declared `{sourceRole, linkerRole}`:
 *   - the SOURCE entry must carry that role, resolve to a SECTION, and name a
 *     literal `section_tipo` (a 'self' sentinel is the host section, not a
 *     picker source, and there is no runtime context here to resolve it). The
 *     model is read from the ontology, never from the entry: the stored ddo_map
 *     carries no `model` key at all — `enrichToolConfig` stamps it for the wire
 *     from exactly this lookup;
 *   - the LINKER entry must carry that role AND be of the PORTAL family
 *     ({@link LINKER_MODELS}) — the components whose stored value IS a browsed
 *     record link. `getModelByTipo` canonicalizes the family
 *     (component_autocomplete / _hi → component_portal).
 *
 * WHY NOT "every section in the map to every relation component in it". That
 * cross-product was the first shape of this function and it over-granted twice
 * over on the live map: to `references_component` (rsc1368, a display list no
 * pick ever reaches) and — before the family narrowing — to the status checkbox
 * and select (rsc437/rsc439), whose values come from their own option lists. A
 * ddo_map wires a whole working surface; only one pair of it is a link
 * declaration, and widening a WRITE gate on a guess about the rest is the class
 * of write gate 1 exists to refuse. The role check makes the grant exactly as
 * wide as the tool's behaviour, and the tripwire is what keeps that true.
 *
 * NOT A GRANT. This widens the TARGET gate only. Gates 2-4 (the read grant on
 * the linked section, selectability, the cap) run unchanged on every locator
 * arriving this way.
 */
async function toolDeclaredTargets(callerTipo: string): Promise<string[]> {
	return (await toolDeclaredTargetIndex()).get(callerTipo) ?? [];
}

/**
 * The tool-declared target index, built once per ontology generation AND per
 * tool-config generation (its two sources — see toolDeclaredTargetIndex).
 *
 * The scan itself is a by-PROPERTY read (`getNodesWithProperty`, the canonical
 * home for what the per-tipo cache cannot serve); the DERIVED index is what is
 * memoized here, through the factory — so every dd_ontology write clears it and
 * an edited tool_config takes effect on the next resolve, never after a
 * restart. One entry keyed by the whole index, the observer-registry shape.
 */
const toolDeclaredTargetsCache = createOntologyCache<
	'index',
	{ generation: number; index: Map<string, string[]> }
>();

/**
 * The models a tool-declared picker source may widen — the PORTAL family, whose
 * stored value IS a browsed record link. Canonical models only
 * (`getModelByTipo` has already applied the replacement map), and deliberately
 * a list rather than a column test: see {@link toolDeclaredTargets}.
 */
const LINKER_MODELS: ReadonlySet<string> = new Set(['component_portal']);

/** One ddo_map entry, resolved: what the index needs and nothing else. */
interface DdoMapEntry {
	role: string | null;
	tipo: string;
	model: string | null;
	sectionTipo: string | null;
}

/**
 * A ddo_map field that is a LITERAL address — a string that is not the 'self'
 * sentinel. 'self' names the host element/section, which this index has no
 * runtime context to resolve, so it is not an address here.
 */
function literalAddress(value: unknown): string | null {
	if (typeof value !== 'string' || value === 'self') return null;
	return value;
}

/** One ddo_map entry resolved, or null when it addresses nothing usable. */
async function resolveDdoMapEntry(raw: unknown): Promise<DdoMapEntry | null> {
	if (raw === null || typeof raw !== 'object') return null;
	const entry = raw as Record<string, unknown>;
	const tipo = literalAddress(entry.tipo);
	if (tipo === null) return null;
	return {
		role: typeof entry.role === 'string' ? entry.role : null,
		tipo,
		model: await getModelByTipo(tipo),
		sectionTipo: literalAddress(entry.section_tipo),
	};
}

/** The addressable entries of one ddo_map, each resolved ONCE. */
async function resolveDdoMapEntries(ddoMap: readonly unknown[]): Promise<DdoMapEntry[]> {
	const entries: DdoMapEntry[] = [];
	for (const raw of ddoMap) {
		const entry = await resolveDdoMapEntry(raw);
		if (entry !== null) entries.push(entry);
	}
	return entries;
}

/** The section this pair's source role names, or null when the map has none. */
function pairSourceSection(entries: readonly DdoMapEntry[], sourceRole: string): string | null {
	const source = entries.find(
		(entry) => entry.role === sourceRole && entry.model === 'section' && entry.sectionTipo !== null,
	);
	return source?.sectionTipo ?? null;
}

/** The component this pair's linker role names, or null when it is not one. */
function pairLinkerTipo(entries: readonly DdoMapEntry[], linkerRole: string): string | null {
	const linker = entries.find(
		(entry) => entry.role === linkerRole && entry.model !== null && LINKER_MODELS.has(entry.model),
	);
	return linker?.tipo ?? null;
}

/** Fold one tool's ddo_map into the index, one declared pair at a time. */
async function indexToolConfig(
	index: Map<string, string[]>,
	toolName: string,
	rawConfig: unknown,
): Promise<void> {
	// A tool that declares no picker link contributes nothing — the ordinary
	// case, and the safe one.
	const wiring = TOOL_PICKER_WIRING[toolName];
	if (wiring === undefined) return;
	const ddoMap = (rawConfig as { ddo_map?: unknown } | null)?.ddo_map;
	if (!Array.isArray(ddoMap)) return;

	const entries = await resolveDdoMapEntries(ddoMap);
	for (const pair of wiring) {
		addPairToIndex(
			index,
			pairLinkerTipo(entries, pair.linkerRole),
			pairSourceSection(entries, pair.sourceRole),
		);
	}
}

/**
 * Record one resolved pair. A pair whose map supplies only one half — the tool
 * is configured on this element without its picker, the ordinary partial
 * install — adds nothing.
 */
function addPairToIndex(
	index: Map<string, string[]>,
	linkerTipo: string | null,
	sectionTipo: string | null,
): void {
	if (linkerTipo === null || sectionTipo === null) return;
	const merged = index.get(linkerTipo) ?? [];
	if (!merged.includes(sectionTipo)) merged.push(sectionTipo);
	index.set(linkerTipo, merged);
}

/**
 * THE TWO DECLARATION SOURCES of the index. The ontology's
 * `properties.tool_config` bags, and — owner C36 2026-11-13
 * (WC-2026-11-12-tool-configuration-override addendum) — the tool-configuration
 * OVERRIDES (Tools configuration dd996 / register default dd1324
 * `properties.tool_config[]`, `tools/config.ts`): an override's ddo_map is what
 * the element's tool stamp hands the client, so a picker section it pairs into
 * a linker role is OFFERED in the UI; the write door reads the same bytes and
 * accepts it. Before, such a pick was offered and refused `off_target` — two
 * authorities, one enforced. Paired by ROLE through the same wiring table, so
 * an override widens the TARGET gate exactly as an ontology bag would and
 * nothing else (gates 2-4 unchanged).
 */
async function toolDeclaredTargetIndex(): Promise<Map<string, string[]>> {
	const generation = toolConfigGeneration();
	const cached = toolDeclaredTargetsCache.get('index');
	// Rebuilt when EITHER source moved: a dd_ontology write clears the ontology
	// cache; a dd996 / dd1324 write bumps the tool-config generation stamped here.
	if (cached !== undefined && cached.generation === generation) return cached.index;

	const index = new Map<string, string[]>();
	await indexOntologyToolConfigs(index);
	await indexOverrideToolConfigs(index);

	toolDeclaredTargetsCache.set('index', { generation, index });
	return index;
}

/** Source 1: every ontology node's `properties.tool_config` bag, tool by tool. */
async function indexOntologyToolConfigs(index: Map<string, string[]>): Promise<void> {
	for (const node of await getNodesWithProperty('tool_config')) {
		const bag = node.properties.tool_config;
		if (bag === null || typeof bag !== 'object') continue;
		for (const [toolName, rawConfig] of Object.entries(bag as Record<string, unknown>)) {
			await indexToolConfig(index, toolName, rawConfig);
		}
	}
}

/** Source 2: the EFFECTIVE tool-configuration override entries (tools/config.ts). */
async function indexOverrideToolConfigs(index: Map<string, string[]>): Promise<void> {
	for (const override of await listEffectiveToolConfigurationOverrides()) {
		await indexToolConfig(index, override.toolName, { ddo_map: override.ddoMap });
	}
}

/**
 * Is `sectionTipo` one of the caller's targets? THE comparison law for
 * {@link PickerConstraint.targets}, exported so the read path and the write
 * path cannot each write their own — resolving only one side is the bug this
 * function exists to prevent (a virtual section compared against a real target
 * silently refuses a legitimate link, and vice-versa).
 *
 * An EMPTY target set answers `true`: the caller declares no target, so no
 * target constraint applies (the declared exemption, picker plan §2.1). That is
 * a stated rule, not a fallthrough — a caller WITH targets and a section
 * outside them is refused.
 *
 * THE MATCH IS ASYMMETRIC, and deliberately so. A declared target matches an
 * incoming section when they are the same node, or when EITHER ONE is the
 * other's real section. It must never compare real-against-real: every
 * thesaurus is a virtual section over `hierarchy20`, so real-vs-real answers
 * `true` for any thesaurus against any other and the constraint stops
 * constraining. Asymmetric keeps both directions of the legitimate case
 * (`rsc170` declared / `rsc2` linked, and the reverse) while still refusing
 * `es1` declared / `ad1` linked.
 */
export async function isTargetAllowed(
	targets: readonly string[],
	sectionTipo: string,
): Promise<boolean> {
	if (targets.length === 0) return true;
	if (targets.includes(sectionTipo)) return true;
	const incomingReal = await getSectionRealTipo(sectionTipo);
	for (const target of targets) {
		// either side may be the virtual one; never resolve both.
		if (target === incomingReal) return true;
		if ((await getSectionRealTipo(target)) === sectionTipo) return true;
	}
	return false;
}

/**
 * May this TERM be linked? The relation-mode selectability rule, and the whole
 * of it (picker plan §1.9).
 *
 * A THIN DELEGATION to `ts_object.isIndexable` — the rule is already
 * implemented, already the one tool_indexation relies on, and reimplementing it
 * would fork the picker's affordance from the indexation tool's. What this
 * wrapper adds is the NAME: in relation mode "indexable" means "the thesaurus
 * declares this term linkable", answered per node, by the term's own record —
 * `hierarchy*`/`ontology*` tipos are structural and never selectable; otherwise
 * the section's `section_map.thesaurus.is_indexable` names a component tipo and
 * the flag is read from that component on the term's own record.
 *
 * Consequences the callers must honour, stated here because this is the one
 * place the rule is named: a non-selectable term stays VISIBLE and NAVIGABLE
 * (structural levels are how one reaches a leaf) but carries no link
 * affordance; and because a rendered affordance is not an authorization, the
 * write path calls this again before persisting.
 */
export async function isTermSelectable(sectionTipo: string, sectionId: number): Promise<boolean> {
	return isIndexable(sectionTipo, sectionId);
}
