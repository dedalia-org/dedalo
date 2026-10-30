/**
 * EXTERNAL-VALUE LAWS — the shared types (Step 0 of the external-law port,
 * 2026-10-30).
 *
 * An observer whose `properties.source.mode` is `external` stores a DERIVED
 * relation bag (its "mirror"). PHP computes that bag in set_data_external
 * (frozen class.component_relation_common.php:1764-1990), which is really
 * THREE different laws selected by the shape of `properties.source`:
 *
 *   (a) `set_observed_data`  — the bag is read from ANOTHER component of the
 *       SAME record: the locators of the tags inside a text (svg tags in a
 *       legend: test6380 ← test6263) or, with no `perform`, that component's
 *       own relation bag copied verbatim;
 *   (b) `source_overwrite`   — the bag is COPIED from the record the pointer
 *       component names (a catalog term's testcoincatalog1004 → the type, whose
 *       test6157 / test6105 become the term's 1013 / 1019);
 *   (c) the DEFAULT law      — every record referencing this one through
 *       `component_to_search` (or any of its `data_from_field` equivalents).
 *
 * Exactly ONE law applies to a node, decided by ONE closed classifier
 * (./classify.ts resolveExternalLaw). An ambiguous node is REFUSED, never run
 * under a fallback law: law (c) on a source_overwrite node is the measured
 * 118k-locator wipe (numisdata679/965) that kept these sub-laws disarmed.
 *
 * Every law answers the same four questions (ExternalValueLaw below): what the
 * bag should hold (`compute`), which components it reads beyond the declared
 * observe edges (`dependencies`), the pointer an inverse target lookup may
 * filter by (`pointer`), and which records the reconciler must visit
 * (`candidateIds`). The KERNEL (observers.ts recomputeExternalRelation) owns
 * everything after `compute`: the one merge (./merge.ts), the escapes, the
 * persist, the history and the hop.
 */

/**
 * One locator as READ from a stored relation bag — the kept union of the
 * legacy string ids and the canonical ints (WC-2026-08-10-section-id-int-canonical).
 * Mirror writes canonicalize on the way out; the read side stays tolerant.
 */
export interface StoredLocator {
	id?: number;
	type?: string;
	section_id?: number | string;
	section_tipo?: string;
	from_component_tipo?: string;
	[key: string]: unknown;
}

/**
 * One item a law WANTS in the mirror. Only the address is required; every
 * other key the law supplies (`type`, `component_tipo` of a tag locator, …)
 * is kept by the merge except `id` (the mirror owns its item ids) and
 * `from_component_tipo` (always the observer).
 */
export interface DesiredLocator {
	section_tipo: string;
	section_id: number | string;
	type?: string;
	[key: string]: unknown;
}

/** A record address (the target of a recompute, a dispatch target). */
export interface RecordAddress {
	section_tipo: string;
	section_id: number;
}

// ---------------------------------------------------------------------------
// The classified law (the union the classifier returns)
// ---------------------------------------------------------------------------

/** Law (c): the inverse-reference search, PHP's default set_data_external path. */
export interface InverseSearchLaw {
	readonly kind: 'inverse_search';
	readonly observerTipo: string;
	/** `source.component_to_search` (first entry when an array). */
	readonly componentToSearch: string;
	/** `source.section_to_search` verbatim (`'all'` when absent). */
	readonly sectionToSearch: readonly string[] | 'all';
	/** `source.data_from_field` verbatim (the D3 equivalence seed peers). */
	readonly dataFromField: unknown;
}

/** Sub-law (b): copy the pointed record's `dataFromField` bag. */
export interface SourceOverwriteLaw {
	readonly kind: 'source_overwrite';
	readonly observerTipo: string;
	/** The pointer: `source.component_to_search` (PHP reads its first locator). */
	readonly pointerTipo: string;
	/** `source.source_overwrite.data_from_field` — the copied component. */
	readonly dataFromField: string;
}

/** The closed set of `set_observed_data` functions (`'copy'` = no `perform`). */
export type ObservedDataFunction = 'get_locators_of_tags' | 'copy';

/** Sub-law (a): derive the bag from a component of the SAME record. */
export interface ObservedDataLaw {
	readonly kind: 'observed_data';
	readonly observerTipo: string;
	/** The first `set_observed_data` ddo's tipo (PHP returns after the first). */
	readonly ddoTipo: string;
	/**
	 * `get_locators_of_tags` = the locators inside the ddo text's tags;
	 * `copy` = the ddo's own relation bag verbatim (PHP's no-`perform` branch).
	 */
	readonly fn: ObservedDataFunction;
	/** Tag types to read (`get_locators_of_tags` only; `[]` for `copy`). */
	readonly tags: readonly string[];
}

/** A node no law may run on — refused wholesale, never a fallback law. */
export interface RefusedLaw {
	readonly kind: 'refused';
	readonly observerTipo: string;
	/** Stable machine reason (a WC-ledgered refusal names it). */
	readonly reason: ExternalLawRefusalReason;
	/** Human detail for the log line. */
	readonly detail: string;
	/**
	 * Counters the consumer increments, primary first. The historical names
	 * stay as aliases so dashboards built on them do not read "suddenly zero".
	 */
	readonly counters: readonly string[];
}

export type ExternalLawRefusalReason =
	/** The observer tipo has no ontology node at all. */
	| 'node_missing'
	/** `properties.source` absent, or not an object (oh55 string, oh90 number). */
	| 'source_not_object'
	/** Law (c) shape without a string `component_to_search`. */
	| 'component_to_search_missing'
	/** Both sub-laws declared (PHP would take set_observed_data first). */
	| 'both_sublaws'
	/** A sub-law next to a top-level `data_from_field` (law (c)'s seed key). */
	| 'sublaw_with_data_from_field'
	/** `set_observed_data` is not a non-empty array of `{tipo}` ddos. */
	| 'observed_data_malformed'
	/** `perform.function` outside the closed set. */
	| 'observed_data_function_unknown'
	/** A tag type outside the closed tag set, or a malformed tags list. */
	| 'observed_data_tags_invalid'
	/** `source_overwrite.data_from_field` is not a non-empty string. */
	| 'source_overwrite_malformed'
	/** `source_overwrite` with no pointer (PHP would fall through to law (c)). */
	| 'source_overwrite_without_component_to_search';

/** Every law that stores a value (everything but a refusal). */
export type StoredExternalLaw = InverseSearchLaw | SourceOverwriteLaw | ObservedDataLaw;

/** The classifier's answer for one node. */
export type ExternalLaw = StoredExternalLaw | RefusedLaw;

// ---------------------------------------------------------------------------
// The law interface
// ---------------------------------------------------------------------------

/** What the kernel hands a law's compute: the target and the lock posture. */
export interface LawComputeContext {
	targetSection: string;
	targetId: number;
	/** The target section's matrix table (resolved by the kernel). */
	table: string;
	/**
	 * `true` inside the kernel's write transaction: the target row is read
	 * FOR UPDATE and any source row FOR SHARE (lock order: target, then
	 * source — always). `false` = the lock-free dry run.
	 */
	lock: boolean;
}

/**
 * One compute's answer. The law reads the TARGET ROW itself (the mirror, its
 * `_hi` index and — for source_overwrite — the pointer, all under the same
 * lock), so the kernel never needs a second read of it.
 */
export interface LawComputeResult {
	/** False = the target record does not exist (the kernel no-ops). */
	exists: boolean;
	/** `relation[observerTipo]` as stored (`[]` when absent). */
	existing: StoredLocator[];
	/** `relation_search[observerTipo]` as stored (null when absent). */
	storedIndex: unknown;
	/** What the law wants the mirror to hold, in the law's order. */
	desired: DesiredLocator[];
	/**
	 * `'stored'` = kept entries in stored order, then appended (law (c) —
	 * "who references me" has no intrinsic order); `'desired'` = the law's
	 * order IS part of the value (the copy laws: "ordered coins", the order
	 * the tags were written in).
	 */
	order: MergeOrder;
	/** Item `type` for a desired item that carries none. */
	fallbackType: string;
	/** Drop desired items addressing the target record itself. */
	dropSelf: boolean;
	/** The size the >2000 freeze compares (law (c) only freezes). */
	referenceCount: number;
	/** Whether PHP's >2000-reference freeze applies to this law. */
	freeze: boolean;
	/**
	 * Never-narrow escapes hit while computing THIS record's value: non-empty =
	 * the desired set is known incomplete, so the kernel withholds its drops.
	 */
	defects: string[];
}

export type MergeOrder = 'stored' | 'desired';

/** A component a law READS beyond the declared observe edges (U3 pass 3). */
export interface LawDependency {
	/** The component whose saves must reach this observer. */
	observed: string;
	/** How the observer's targets are found from such a save. */
	resolver: 'inverse';
	/** The pointer the inverse lookup filters by (exact for source_overwrite). */
	via: string;
}

/** The reconciler's per-tuple scope (one observer at one host section). */
export interface CandidateScope {
	observerTipo: string;
	hostSection: string;
}

/** The four questions every stored law answers (see the header). */
export interface ExternalValueLaw<L extends StoredExternalLaw = StoredExternalLaw> {
	readonly kind: L['kind'];
	compute(law: L, context: LawComputeContext): Promise<LawComputeResult>;
	/** `[]` for law (c) and observed_data (critique 11): only source_overwrite reads a foreign record. */
	dependencies(law: L): readonly LawDependency[];
	/** The pointer an inverse target lookup filters by; undefined = unfiltered. */
	pointer(law: L): string | undefined;
	/** Records the reconciler visits for one tuple (sorted ascending; `onlyId` narrows). */
	candidateIds(
		law: L,
		scope: CandidateScope,
		hostTable: string,
		onlyId: number | null,
	): Promise<number[]>;
}
