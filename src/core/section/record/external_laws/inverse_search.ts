/**
 * LAW (c) — THE INVERSE-REFERENCE SEARCH (PHP set_data_external's default
 * path): the mirror := every record referencing the target through
 * `source.component_to_search` — OR any equivalent of the target reachable
 * through `source.data_from_field` (the D3 seed law) — limited to
 * `source.section_to_search`; kept entries in stored order, new references
 * appended with the next item ids.
 *
 * MOVED, NOT REWRITTEN (2026-10-30): the seed law (buildExternalSeed /
 * collectExternalSeed), the locked compute and the equivalence-class target
 * expansion are the code observers.ts carried, byte for byte in behaviour,
 * relocated behind the ExternalValueLaw interface so the kernel runs every
 * law the same way. The gates that pinned them (observer_seed_native,
 * observer_equivalence_native, observer_cascade_native) pin them here.
 *
 * This is the only law the >2000-reference freeze applies to (PHP :2087 —
 * the copy laws never had it) and the only one whose order is 'stored'.
 * `dependencies()` is `[]` (critique 11): its inputs are the declared edges.
 */

import { incrementCounter } from '../../../api/counters.ts';
import { sql } from '../../../db/postgres.ts';
import { getModelByTipo, getNode } from '../../../ontology/resolver.ts';
// type-only: erased at build, so no static relations↔section cycle is created
// (the VALUE import of relations/related.ts stays dynamic on the compute path).
import type { RelatedGraphIO } from '../../../relations/related.ts';
import type {
	CandidateScope,
	DesiredLocator,
	ExternalValueLaw,
	InverseSearchLaw,
	LawComputeContext,
	LawComputeResult,
	StoredLocator,
} from './types.ts';

/** One seed locator of the external-value related-mode search. */
export interface ExternalSeedLocator {
	section_tipo: string;
	section_id: number;
	from_component_tipo: string;
}

/**
 * THE VALUE LAW's SEED (D3, pure half) — PHP set_dato_external builds its
 * inverse-reference search over MORE than the target record (v6
 * class.component_relation_common.php:1996-2022): the seed is the target
 * itself PLUS every locator reachable through properties.source
 * .data_from_field (the "equivalents" of the target — e.g. numisdata77's
 * peer numisdata36, the dd621 equivalent-types relation), EVERY entry
 * re-stamped with from_component_tipo = component_to_search (PHP
 * $locator_dato->set_from_component_tipo($component_to_search) — the search
 * must match the REFERENCING component's locators, never the peer's own
 * stamp). Semantically: the mirror lists records referencing THIS record OR
 * ANY OF ITS EQUIVALENTS.
 *
 * PURE by design (the peer bags arrive resolved) so the law is hermetically
 * gated in observer_seed_native.test.ts. Divergences from PHP, both
 * result-neutral: malformed peer locators are DROPPED (PHP would seed an
 * unsearchable half-empty locator) with a counted log — never a silent
 * narrow; and the seed is DEDUPED on (section_tipo, section_id) — PHP sends
 * duplicates into an OR filter whose GROUP BY collapses them anyway, so
 * dedup only trims SQL clauses.
 */
export function buildExternalSeed(
	target: { section_tipo: string; section_id: number },
	componentToSearch: string,
	// a peer's own from_component_tipo may ride along — it is IGNORED (the
	// re-stamp below is the law).
	peerLocators: { section_tipo?: unknown; section_id?: unknown; from_component_tipo?: unknown }[],
	// THE DEFECT SINK (2026-08-06): every never-narrow escape below also
	// records itself HERE, per call, so the recompute that consumes this seed
	// knows ITS OWN seed was degraded. The process-wide counters alone cannot
	// answer "was THIS record's seed complete?", and since the grow-only
	// fail-safe was retired the answer decides whether a drop may persist.
	defects?: string[],
): ExternalSeedLocator[] {
	const seed: ExternalSeedLocator[] = [
		{
			section_tipo: target.section_tipo,
			section_id: target.section_id,
			from_component_tipo: componentToSearch,
		},
	];
	const seen = new Set<string>([`${target.section_tipo}|${target.section_id}`]);
	for (const peer of peerLocators) {
		const sectionId = Number(peer?.section_id);
		if (typeof peer?.section_tipo !== 'string' || !Number.isFinite(sectionId)) {
			console.error(
				'buildExternalSeed: malformed peer locator dropped (unsearchable — no section_tipo/section_id):',
				peer,
			);
			incrementCounter('observers_seed_malformed_peer_locator');
			defects?.push('malformed_peer_locator');
			continue;
		}
		const key = `${peer.section_tipo}|${sectionId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		seed.push({
			section_tipo: peer.section_tipo,
			section_id: sectionId,
			from_component_tipo: componentToSearch,
		});
	}
	return seed;
}

/**
 * Injection seam for collectExternalSeed: node-properties lookup + the
 * related-graph access, so the WIRED law (data_from_field walk → typeRel
 * switch → closure → re-stamp) is testable without a DB. Production callers
 * pass nothing and get the live ontology + matrix graph.
 */
export interface ExternalSeedIO {
	getNodeProperties(tipo: string): Promise<unknown>;
	/** The peer's resolved MODEL — PHP's get_dato_with_references dispatch is
	 * polymorphic (only component_relation_related computes the closure), so
	 * the seed law needs the model, not just the properties. */
	getNodeModel(tipo: string): Promise<string | null>;
	graph?: RelatedGraphIO;
}

/**
 * The seed of the external-value search for one (observer node, target
 * record) pair — the ASYNC half of the D3 law: resolve each data_from_field
 * peer's bag "with references" (PHP get_dato_with_references — stored bag ∪
 * the typeRel-gated closure, see relations/related.ts
 * getStoredWithReferences) at the TARGET record, then build the pure seed.
 *
 * MEASURED (2026-08-02, 19,908 numisdata3 records holding numisdata77,
 * against the v6-migrated stored bags = v6's correct answer):
 *   self only:                       7,430 exact / 318,122 locators lost
 *   self + peer stored bag (1 hop): 11,953 exact / 247,933 locators lost
 *   self + dd621 transitive closure: 19,885 exact /      13 locators lost
 * The closure IS the law; a one-hop read is wrong by a quarter-million
 * locators.
 */
export async function collectExternalSeed(
	source: { data_from_field?: unknown } | undefined,
	componentToSearch: string,
	targetSection: string,
	targetId: number,
	io?: ExternalSeedIO,
	/** See buildExternalSeed: the per-call record of every never-narrow escape
	 * hit while resolving this seed. A non-empty sink means the seed is known
	 * INCOMPLETE, which is what recomputeExternalRelation's degraded-seed
	 * refusal adjudicates on. */
	defects?: string[],
): Promise<ExternalSeedLocator[]> {
	const peerBag: SeedPeerLocator[] = [];
	const dataFromField = source?.data_from_field;
	if (Array.isArray(dataFromField)) {
		for (const peerTipo of dataFromField) {
			peerBag.push(...(await peerSeedBag(peerTipo, targetSection, targetId, io, defects)));
		}
	}
	return buildExternalSeed(
		{ section_tipo: targetSection, section_id: targetId },
		componentToSearch,
		peerBag,
		defects,
	);
}

/**
 * One peer locator of the seed. section_id is the canonical int for anything
 * the graph could canonicalize and the verbatim stored form otherwise
 * (WC-2026-08-10-section-id-int-canonical).
 */
type SeedPeerLocator = { section_tipo: string; section_id: number | string };

/** ONE data_from_field peer's bag "with references" at the target record. */
async function peerSeedBag(
	peerTipo: unknown,
	targetSection: string,
	targetId: number,
	io: ExternalSeedIO | undefined,
	defects: string[] | undefined,
): Promise<SeedPeerLocator[]> {
	if (typeof peerTipo !== 'string' || peerTipo === '') {
		// Never-narrow: a non-tipo entry cannot be walked — counted skip.
		console.error(
			`collectExternalSeed @ ${targetSection}/${targetId}: non-string data_from_field entry skipped:`,
			peerTipo,
		);
		incrementCounter('observers_seed_invalid_data_from_field');
		defects?.push('invalid_data_from_field');
		return [];
	}
	const { properties, model } = await peerNodeFacts(peerTipo, io);
	reportDegradedPeer(peerTipo, properties, model, `${targetSection}/${targetId}`, defects);
	const { getStoredWithReferences } = await import('../../../relations/related.ts');
	// PHP instantiates the peer with DEDALO_DATA_NOLAN → lang lg-nolan
	// (relation data is nolan; lang only keys the traversal's cycle cache).
	return getStoredWithReferences(
		peerTipo,
		targetSection,
		targetId,
		properties,
		model,
		'lg-nolan',
		io?.graph,
	);
}

/** A peer's node properties and resolved MODEL (the seam's, or the live ontology's). */
async function peerNodeFacts(
	peerTipo: string,
	io: ExternalSeedIO | undefined,
): Promise<{ properties: unknown; model: string | null }> {
	if (io !== undefined) {
		return {
			properties: await io.getNodeProperties(peerTipo),
			model: await io.getNodeModel(peerTipo),
		};
	}
	const node = await getNode(peerTipo);
	// getModelByTipo (not node.model): forced-model/alias resolution must
	// match what the engine would instantiate for the peer. Its alias
	// resolution needs the component registry's lookup registered —
	// server/test entrypoints preload it, standalone scripts (the
	// reconciler) do not, so load it here (dynamic: keeps the module
	// graph acyclic, the file's established pattern).
	await import('../../../components/registry.ts');
	return {
		properties: node?.properties ?? null,
		model: node === null ? null : await getModelByTipo(peerTipo),
	};
}

/**
 * The two ways a peer's closure half vanishes SILENTLY — reported loudly (log
 * + counter + the per-call defect sink). The walk still falls through to the
 * stored bag either way (the best law computable without the node).
 */
function reportDegradedPeer(
	peerTipo: string,
	properties: unknown,
	model: string | null,
	where: string,
	defects: string[] | undefined,
): void {
	if (properties === null && model === null) {
		// Never-narrow (review 2026-08-02): a declared peer whose ontology
		// node is MISSING (dropped/partial install) silently degrades the
		// seed to stored-bag-only — the measured 247,933-locator-loss shape.
		console.error(
			`collectExternalSeed @ ${where}: data_from_field peer '${peerTipo}' has NO ontology node — closure half skipped, seed degraded to the stored bag`,
		);
		incrementCounter('observers_seed_peer_node_missing');
		defects?.push(`peer_node_missing:${peerTipo}`);
		return;
	}
	if (
		model === 'component_relation_related' &&
		(properties === null || typeof properties !== 'object')
	) {
		// The SECOND way the closure half vanishes silently (review
		// 2026-08-06). getRelationTypeRel DEFAULTS to dd620 — "no references"
		// — for any properties it cannot read. A peer whose model IS
		// component_relation_related but whose node carries no readable
		// properties therefore computes stored-bag-only, exactly like a
		// missing node, while the missing-node branch above does NOT fire
		// (the model resolved fine).
		//
		// The distinction is load-bearing now that drops persist: a peer
		// legitimately declared dd620, or a peer of another model, is NOT
		// degraded — PHP's dispatch is polymorphic and stored-bag-only is the
		// correct law for both. A RELATED peer whose directionality we cannot
		// read is a different thing: an unanswerable law, and no drop may ride
		// on it.
		console.error(
			`collectExternalSeed @ ${where}: data_from_field peer '${peerTipo}' is component_relation_related but has NO readable properties — relation_type_rel defaulted to dd620, closure half skipped, seed degraded to the stored bag`,
		);
		incrementCounter('observers_seed_peer_config_unreadable');
		defects?.push(`peer_config_unreadable:${peerTipo}`);
	}
}

/**
 * Above this many targets, one save's equivalence-class expansion is reported
 * as degenerate (logged + counted) — but never refused: withholding the
 * recompute would re-create exactly the staleness the expansion exists to
 * remove. Measured classes on this install are ≤ 10 members.
 */
export const EQUIVALENCE_CLASS_WIDE = 50;

/** A dispatch target as the observable data carries it (the kept union of id forms). */
export interface ObservableTarget {
	section_tipo?: unknown;
	section_id?: unknown;
	[key: string]: unknown;
}

/**
 * EQUIVALENCE-CLASS EXPANSION (2026-08-06; moved from observers.ts). When the
 * observed component is one of the observer's own `data_from_field` peers, it
 * is not just a link — it defines the equivalence CLASS the value law
 * searches over (numisdata77's mirror lists records referencing this type OR
 * any of its equivalents). dd621 is TRANSITIVE, so one edge change
 * re-partitions a whole class: in A—B—C, adding or removing B—C also changes
 * A's class. The saved bag names only the direct endpoints, so A was never
 * visited — wrong in BOTH directions, not just on removal (the reported
 * 2-member case appeared to work on add purely because a 2-member class has
 * no third member).
 *
 * The complete affected set is closure(saved) ∪ ⋃ closure(removed):
 *  - removal: any node whose class changed is either still connected to the
 *    saved record, or its path to it crossed a removed edge — the prefix up
 *    to the FIRST removed edge lands in that edge's closure;
 *  - addition: closure(saved) is already the merged class and contains every
 *    closure(removed). Redundant, deduped, free.
 * One formula, no add/remove branching.
 *
 * APPENDS to `targets` in place (the dispatch's own list, like before) and
 * returns it; `where` labels the log line (`section_tipo/section_id` saved).
 */
export async function expandEquivalenceTargets(
	law: InverseSearchLaw,
	observedTipo: string,
	targets: ObservableTarget[],
	where: string,
): Promise<ObservableTarget[]> {
	const dataFromField = law.dataFromField;
	if (!Array.isArray(dataFromField) || !dataFromField.includes(observedTipo)) return targets;
	const walk = await equivalenceWalkOf(observedTipo);
	if (walk === null) return targets;
	const { getStoredWithReferences } = await import('../../../relations/related.ts');
	const seen = new Set(targets.map((entry) => `${entry.section_tipo}|${entry.section_id}`));
	// The roots are snapshotted: the loop appends to targets.
	for (const root of [...targets]) {
		// ONE walk per root, each with its OWN memo — getReferencesRecursive's
		// `expanded` cache is per-call by contract, and sharing it across roots
		// would suppress re-expansion and truncate later roots.
		const members = await getStoredWithReferences(
			observedTipo,
			String(root.section_tipo),
			root.section_id as SeedPeerLocator['section_id'],
			walk.properties,
			walk.model,
			'lg-nolan',
		);
		appendClassMembers(targets, seen, members);
	}
	reportWideClass(law, observedTipo, targets, where);
	return targets;
}

/**
 * The observed peer's walk inputs, or `null` when it computes no closure.
 * Mirrors getStoredWithReferences' own dispatch, so a dd620 or non-related
 * peer skips the walk entirely rather than computing an empty one — and an
 * edge with no data_from_field never gets here.
 */
async function equivalenceWalkOf(
	observedTipo: string,
): Promise<{ properties: unknown; model: string | null } | null> {
	const { getRelationTypeRel, RELATED_BIDIRECTIONAL, RELATED_MULTIDIRECTIONAL } = await import(
		'../../../relations/related.ts'
	);
	const observedNode = await getNode(observedTipo);
	const observedModel = await getModelByTipo(observedTipo);
	const properties = observedNode?.properties ?? null;
	const typeRel = getRelationTypeRel(properties);
	if (
		observedModel !== 'component_relation_related' ||
		(typeRel !== RELATED_BIDIRECTIONAL && typeRel !== RELATED_MULTIDIRECTIONAL)
	) {
		return null;
	}
	return { properties, model: observedModel };
}

/** Appends the class members not yet seen (in place; `seen` keys `section_tipo|section_id`). */
function appendClassMembers(
	targets: ObservableTarget[],
	seen: Set<string>,
	members: readonly SeedPeerLocator[],
): void {
	for (const member of members) {
		const key = `${member.section_tipo}|${member.section_id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		targets.push({ section_tipo: member.section_tipo, section_id: member.section_id });
	}
}

/**
 * Never a refusal — refusing would just re-create the staleness this
 * expansion exists to remove. The counter is the signal that a class has
 * degenerated and the ontology needs a look.
 */
function reportWideClass(
	law: InverseSearchLaw,
	observedTipo: string,
	targets: readonly ObservableTarget[],
	where: string,
): void {
	if (targets.length <= EQUIVALENCE_CLASS_WIDE) return;
	console.warn(
		`observer '${law.observerTipo}' ← '${observedTipo}': equivalence class expanded to ${targets.length} targets (> ${EQUIVALENCE_CLASS_WIDE}) at ${where} — proceeding (counted: observers_equivalence_class_wide)`,
	);
	incrementCounter('observers_equivalence_class_wide');
}

/**
 * The locked compute (moved from recomputeExternalRelation): read the bag and
 * its `_hi` index, build the D3 seed, run the uncapped related search.
 * Order = the PHP related-search default (section_tipo, section_id ASC — v6
 * class.search_related.php:189): multi-section scopes (e.g. tch33 spans
 * tch1+tch178) need the tipo tiebreak for a PHP-identical append order; the
 * pure-SQL mode avoids the 'table' branch's 9.7M-row probe. limit:false
 * ALWAYS (a capped write path destroys locators by omission —
 * WC-2026-08-02-observer-references-limit-not-honoured).
 */
async function computeInverseSearch(
	law: InverseSearchLaw,
	context: LawComputeContext,
): Promise<LawComputeResult> {
	const { targetSection, targetId, table, lock } = context;
	const rows = (await sql.unsafe(
		`SELECT relation->$3 AS bag, relation_search->$3 AS idx FROM "${table}" WHERE section_tipo = $1 AND section_id = $2${lock ? ' FOR UPDATE' : ''}`,
		[targetSection, targetId, law.observerTipo],
	)) as { bag: StoredLocator[] | null; idx: unknown }[];
	const base = {
		order: 'stored' as const,
		// The historical append type: law (c) always minted dd151 items.
		fallbackType: 'dd151',
		dropSelf: false,
		freeze: true,
	};
	if (rows.length === 0) {
		return {
			...base,
			exists: false,
			existing: [],
			storedIndex: null,
			desired: [],
			referenceCount: 0,
			defects: [],
		};
	}
	const existing = rows[0]?.bag ?? [];
	const storedIndex = rows[0]?.idx ?? null;
	const { findInverseReferences } = await import('../../../search/search_related.ts');
	const defects: string[] = [];
	const seed = await collectExternalSeed(
		{ data_from_field: law.dataFromField },
		law.componentToSearch,
		targetSection,
		targetId,
		undefined,
		defects,
	);
	const references = await findInverseReferences(seed, {
		sectionTipos: law.sectionToSearch as string[] | 'all',
		limit: false,
		order: 'section_tipo_section_id',
	});
	// The address only (a hit's `table` is not a locator key).
	const desired: DesiredLocator[] = references.map((row) => ({
		section_tipo: row.section_tipo,
		section_id: row.section_id,
	}));
	return {
		...base,
		exists: true,
		existing,
		storedIndex,
		desired,
		referenceCount: references.length,
		defects,
	};
}

/**
 * Referenced-target ids ∪ stored-mirror-holder ids for one tuple — the
 * reconciler's candidate set (moved from observer_reconcile.ts, unchanged).
 */
async function inverseSearchCandidateIds(
	law: InverseSearchLaw,
	scope: CandidateScope,
	hostTable: string,
	onlyId: number | null,
): Promise<number[]> {
	const params: (string | number)[] = [law.componentToSearch, scope.hostSection];
	let pointingFilter = '';
	if (law.sectionToSearch !== 'all' && Array.isArray(law.sectionToSearch)) {
		params.push(JSON.stringify(law.sectionToSearch));
		pointingFilter = ` AND section_tipo IN (SELECT jsonb_array_elements_text($${params.length}::text::jsonb))`;
	}
	const referenced = (await sql.unsafe(
		`SELECT DISTINCT target_section_id AS id FROM matrix_relation_index
		 WHERE from_component_tipo = $1 AND target_section_tipo = $2${pointingFilter}`,
		params,
	)) as { id: number }[];
	const holders = (await sql.unsafe(
		`SELECT section_id AS id FROM "${hostTable}" WHERE section_tipo = $1 AND relation ? $2`,
		[scope.hostSection, scope.observerTipo],
	)) as { id: number }[];
	const ids = new Set<number>();
	for (const row of [...referenced, ...holders]) ids.add(Number(row.id));
	if (onlyId !== null) {
		return ids.has(onlyId) ? [onlyId] : [];
	}
	return [...ids].sort((a, b) => a - b);
}

export const inverseSearchLaw: ExternalValueLaw<InverseSearchLaw> = Object.freeze({
	kind: 'inverse_search' as const,
	compute: computeInverseSearch,
	dependencies: () => [],
	pointer: () => undefined,
	candidateIds: inverseSearchCandidateIds,
});
