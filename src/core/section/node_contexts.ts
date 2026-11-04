/**
 * CONTEXT FROM NODES — the context half of a read, serialised from the SAME
 * element nodes its data half was emitted from (relations/element_node.ts
 * resolveElement, relations/element_registry.ts).
 *
 * PHP keeps ONE request_config object per element instance and serialises the
 * element's context from it (class.common.php :1668-1672) while its own
 * get_subdatum reads the same object for the data (:2280) — data and context
 * cannot disagree. Every TS context door now does the same: each emitted data
 * item is BOUND to the node it projects (element_registry.ts bindItem —
 * section/read.ts emitDdoData, relation_core.ts expandPortal /
 * emitDataframeItem), and its context entry is built from that node
 * (structure_context.ts buildStructureContext `configFrom: {source:
 * 'emission', node}`) — never rebuilt from the element's own ontology map.
 * That is the whole tch197 fix: rsc1400 under tch197 ships show.ddo_map
 * [rsc86, rsc85] because its data did.
 *
 * ORDER AND DEDUP (PHP get_subdatum :2779-2786): entries are added in emission
 * order — an element, then its subcontexts — and deduplicated first-wins by
 * context_key (`tipo_section_tipo_mode`) when the node projections (effective
 * config + governing view / parent_grouper / properties) are IDENTICAL.
 *
 * PER OCCURRENCE (owner decision (b), 2026-11-03 — diverges from PHP): when the
 * SAME context_key occurs under different parents with DIFFERENT effective
 * configs (tch197 → rsc1400 showing [rsc86, rsc85] and a second portal P2 →
 * rsc1400 showing [rsc85]), PHP's first-wins would make P2's cells borrow
 * tch197's columns. Here each distinct config ships its OWN entry, and both
 * the entries and the data items of those occurrences carry `caller_chain`:
 *
 *   context: {tipo: rsc1400, section_tipo: rsc197, mode: list, caller_chain: 'tch197', request_config: [… rsc86, rsc85]}
 *            {tipo: rsc1400, section_tipo: rsc197, mode: list, caller_chain: 'P2',     request_config: [… rsc85]}
 *   data:    {tipo: rsc1400, …, caller_chain: 'tch197'} / {tipo: rsc1400, …, caller_chain: 'P2'}
 *
 * The chain is the ancestor TIPO path from the read's top level down to the
 * element's parent, joined by '>' (`''` for a top-level element). The split is
 * PER PARENT OCCURRENCE only: two different configs under the SAME chain — a
 * record-dependent config (an sqo fixed_filter expanded per owning record,
 * own_config.ts ownConfigDependsOnRecord) on every row under one parent, or on
 * every row of a top-level column — dedupe first-wins exactly as PHP (the
 * first row's config), so a chain names exactly one entry. NOTHING is stamped
 * when a key has one entry — the wire is unchanged for every read without a
 * conflict. The client (section_record.js, W5) matches a cell to its entry by
 * (tipo, section_tipo, mode, caller_chain) when the key is stamped; every item
 * of a stamped key carries the chain of the entry its context deduped into.
 * Once a key is split, EVERY parent chain of it names its own entry: a chain
 * whose config was identical to another chain's (deduped into it) gets a copy
 * of that entry stamped with its own chain (NodeContextSet.absorb — W5 review
 * 2026-11-03), so a cell never has to borrow another parent's entry.
 *
 * Every door finally reorders its entries into element-tree order
 * (NodeContextSet.orderByTraversal — PHP's order on a single-row read; on a
 * multi-row read PHP's is row-major, a documented divergence there): the
 * section door's column pass adds every column before the derived pass adds
 * their undeclared subcontexts.
 */

import { nodeListPageLimit } from '../relations/element_node.ts';
import type { ElementNode, ElementNodeRegistry } from '../relations/element_registry.ts';
import { selectLocalConfigItem } from '../relations/request_config/engine_select.ts';
import type { DataItem } from '../resolve/component_data.ts';
import {
	buildStructureContext,
	type ContextConfigSource,
	contextKey,
	type StructureContextEntry,
} from '../resolve/structure_context.ts';

/** JSON with object keys sorted at every level (a fingerprint, never parsed back). */
function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
	if (value !== null && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, entry]) => entry !== undefined)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
		return `{${entries.map(([name, entry]) => `${JSON.stringify(name)}:${stableJson(entry)}`).join(',')}}`;
	}
	return JSON.stringify(value) ?? 'null';
}

/** Set `key` only when absent (first-wins index). */
function setFirst(map: Map<string, number>, key: string, index: number): void {
	if (!map.has(key)) map.set(key, index);
}

/** One context occurrence under a context_key: its entry, its config fingerprint, its chain. */
interface Occurrence {
	readonly entry: StructureContextEntry;
	/** null = an entry with no node (an `own` door): matches every config (first-wins). */
	readonly fingerprint: string | null;
	readonly chain: string;
}

/** A parent chain whose node deduped into another chain's occurrence (NodeContextSet.absorb). */
interface AbsorbedChain {
	readonly chain: string;
	readonly into: Occurrence;
	readonly orderNode: ElementNode | null;
	/**
	 * The absorbed node's DIRECT parent tipo (the chain's last segment; the
	 * read's root tipo for a top-level occurrence) — the copy's own `parent`.
	 * Undefined when the parent node is unknown (the copy keeps the entry's).
	 */
	readonly parentTipo: string | undefined;
}

/**
 * The stamped COPY of an absorbed chain's entry (NodeContextSet.absorb): the
 * absorbing entry's config, its own chain — and ITS OWN direct parent, never
 * the absorbing entry's (WC-2026-11-04-caller-chain-per-occurrence): `parent`
 * stays truthful on every stamped entry, equal to the chain's last segment.
 */
function absorbedCopy({ chain, into, parentTipo }: AbsorbedChain): StructureContextEntry {
	const copy = structuredClone(into.entry);
	copy.caller_chain = chain;
	if (parentTipo !== undefined) copy.parent = parentTipo;
	return copy;
}

/**
 * The context array of ONE response under construction: emission-ordered
 * entries, first-wins dedup by context_key for identical configs AND for every
 * occurrence under the same parent chain, one entry per parent occurrence whose
 * config differs (module header).
 */
export class NodeContextSet {
	readonly entries: StructureContextEntry[];
	readonly #byKey = new Map<string, Occurrence[]>();
	readonly #fingerprints = new WeakMap<ElementNode, string>();
	/** Chains deduped by identical config into another chain's occurrence, per key (absorb). */
	readonly #absorbed = new Map<string, AbsorbedChain[]>();
	/** The node an entry is placed by in PHP traversal order (orderByTraversal). */
	readonly #orderNodes = new WeakMap<StructureContextEntry, ElementNode>();
	readonly #registry: ElementNodeRegistry;

	constructor(registry: ElementNodeRegistry, entries: StructureContextEntry[] = []) {
		this.#registry = registry;
		this.entries = entries;
		for (const entry of entries) {
			this.#record(entry, null, '');
			// a source-owned entry (dd15 column) placed by the node its cells came
			// from: its derived subcontexts follow it (orderByTraversal)
			const placement = registry.placementOfContext(entry);
			if (placement !== undefined) this.#orderNodes.set(entry, placement);
		}
	}

	/**
	 * A node's context fingerprint (memoised per node): EVERYTHING the context
	 * entry projects from the node — its effective config AND the governing
	 * per-occurrence fields buildStructureContext stamps from it (view,
	 * parent_grouper, properties — structure_context.ts applyGoverningFields /
	 * governingOwnProperties — and the INSTANCE lang: the governing ddo's
	 * `lang` is the context lang buildItemEntry stamps from its item). Two
	 * parents listing the same element with the same children but a different
	 * governing view or lang are two contexts; identical projections still
	 * dedupe to one.
	 */
	fingerprintOf(node: ElementNode): string {
		let fingerprint = this.#fingerprints.get(node);
		if (fingerprint === undefined) {
			fingerprint = stableJson({
				config: node.effectiveConfig,
				view: node.view,
				parent_grouper: node.parent_grouper,
				properties: node.properties,
				lang: node.lang,
			});
			this.#fingerprints.set(node, fingerprint);
		}
		return fingerprint;
	}

	/** A node's parent-occurrence chain (module header): its ancestor tipos joined by '>'. */
	chainOf(node: ElementNode): string {
		return this.#registry.ancestorTipos(node).join('>');
	}

	/**
	 * The occurrence `node` would dedupe into under `key`, if any (before
	 * building): an `own` entry (null fingerprint) absorbs everything; then the
	 * occurrence of the SAME parent chain — owner decision (b) splits per PARENT
	 * occurrence only, so a record-dependent config (an sqo fixed_filter
	 * expanded per owning record) keeps PHP's first-wins under one parent
	 * instead of one entry per row (a chain absorbed into another occurrence
	 * counts as that occurrence: ABSORBED CHAINS, absorb()); then an identical
	 * config under another chain.
	 */
	covered(key: string, node: ElementNode | null): Occurrence | undefined {
		const occurrences = this.#byKey.get(key);
		if (occurrences === undefined) return undefined;
		if (node === null) return occurrences[0];
		const own = occurrences.find((occurrence) => occurrence.fingerprint === null);
		if (own !== undefined) return own;
		const chain = this.chainOf(node);
		const fingerprint = this.fingerprintOf(node);
		return (
			occurrences.find((occurrence) => occurrence.chain === chain) ??
			this.#absorbed.get(key)?.find((absorbed) => absorbed.chain === chain)?.into ??
			occurrences.find((occurrence) => occurrence.fingerprint === fingerprint)
		);
	}

	/** Whether any entry holds `key` (first-wins callers that never vary per occurrence). */
	hasKey(key: string): boolean {
		return this.#byKey.has(key);
	}

	/**
	 * Dedupe `node` into an existing occurrence of `key` when covered() finds
	 * one (true), else false (the caller builds and add()s its entry).
	 *
	 * ABSORBED CHAINS (W5 review 2026-11-03). An IDENTICAL config under ANOTHER
	 * parent chain dedupes too — but once the key is split, every chain the
	 * client resolves a cell by must name its own entry, or the cell of the
	 * absorbed chain finds no entry of its path and borrows another parent's:
	 *
	 *   rsc1400 under Z (config B), under X (config A), under Y (config A again)
	 *   → entries 'Z' and 'X' only; Y's cells (path ['Y']) match neither
	 *
	 * So an absorbed chain is remembered, and materialised as a COPY of the
	 * entry it deduped into, stamped with its own chain and its own direct
	 * `parent`, as soon as the key is split (now, or when the split comes later). The data items of that chain
	 * then carry their own chain too (stampItems → covered → the copy).
	 */
	absorb(key: string, node: ElementNode | null, orderNode: ElementNode | null = node): boolean {
		const into = this.covered(key, node);
		if (into === undefined) return false;
		if (node === null || into.fingerprint === null) return true;
		const chain = this.chainOf(node);
		if (into.chain !== chain) {
			const parentTipo =
				node.parentKey === null ? undefined : this.#registry.nodeByKey(node.parentKey)?.tipo;
			this.#rememberAbsorbed(key, { chain, into, orderNode, parentTipo });
		}
		return true;
	}

	/** Remember one absorbed chain of `key` (once), materialised at once when the key is already split. */
	#rememberAbsorbed(key: string, absorbedChain: AbsorbedChain): void {
		const absorbed = this.#absorbed.get(key) ?? [];
		if (!absorbed.some((entry) => entry.chain === absorbedChain.chain)) {
			absorbed.push(absorbedChain);
			this.#absorbed.set(key, absorbed);
		}
		if ((this.#byKey.get(key)?.length ?? 0) >= 2) this.#materialiseAbsorbed(key);
	}

	/**
	 * Add a built entry. Returns false when it deduped into an existing one
	 * (absorb). `orderNode` places the entry in traversal order when its config
	 * came from no node (an `own` derived item still has the node it was bound to).
	 */
	add(
		entry: StructureContextEntry,
		node: ElementNode | null,
		orderNode: ElementNode | null = node,
	): boolean {
		const key = contextKey(entry);
		if (this.absorb(key, node, orderNode)) return false;
		const occurrences = this.#byKey.get(key);
		const chain = node === null ? '' : this.chainOf(node);
		if (occurrences !== undefined) stampSplitKey(occurrences, entry, chain);
		this.entries.push(entry);
		if (orderNode !== null) this.#orderNodes.set(entry, orderNode);
		this.#record(entry, node, chain);
		if (occurrences !== undefined) this.#materialiseAbsorbed(key);
		return true;
	}

	/** Every pending absorbed chain of a SPLIT key as its own stamped entry (absorb). */
	#materialiseAbsorbed(key: string): void {
		const absorbed = this.#absorbed.get(key);
		const occurrences = this.#byKey.get(key);
		if (absorbed === undefined || occurrences === undefined) return;
		this.#absorbed.delete(key);
		for (const absorbedChain of absorbed) {
			const { chain, into, orderNode } = absorbedChain;
			if (occurrences.some((occurrence) => occurrence.chain === chain)) continue;
			const copy = absorbedCopy(absorbedChain);
			this.entries.push(copy);
			if (orderNode !== null) this.#orderNodes.set(copy, orderNode);
			occurrences.push({ entry: copy, fingerprint: into.fingerprint, chain });
		}
	}

	/** Push an entry PHP-style (first-wins by key, no node — the `own` doors). */
	addOwn(entry: StructureContextEntry): boolean {
		return this.add(entry, null);
	}

	/**
	 * Stamp `caller_chain` on every data item whose context_key was split per
	 * occurrence (module header): the item takes the chain of the occurrence its
	 * context DEDUPED INTO — the very covered() decision appendItemContexts made
	 * for it (its config source by itemConfigSource; an `own`-sourced item binds
	 * to the first occurrence, as its dedup did). Items of an unsplit key are left
	 * untouched.
	 */
	stampItems(items: readonly unknown[]): void {
		for (const raw of items) {
			const item = raw as DataItem & { caller_chain?: string };
			const chain = this.#chainOfItem(item);
			if (chain !== undefined) item.caller_chain = chain;
		}
	}

	/** The chain of the split occurrence an item's context deduped into, or undefined. */
	#chainOfItem(item: DataItem): string | undefined {
		if (typeof item?.tipo !== 'string' || typeof item.mode !== 'string') return undefined;
		const key = contextKey({
			tipo: item.tipo,
			section_tipo: String(item.section_tipo),
			mode: item.mode,
		});
		const occurrences = this.#byKey.get(key);
		if (occurrences === undefined || occurrences.length < 2) return undefined;
		const configFrom = itemConfigSource(this.#registry.nodeOfItem(item), item);
		return this.covered(key, nodeOf(configFrom))?.chain;
	}

	/**
	 * Reorder the entries into ELEMENT-TREE order (an element's context, then its
	 * subcontexts, then the next element): every entry is moved right after the
	 * entry of its nearest ancestor (by node, by the ancestor's context_key, else
	 * — a top-level element — by its tipo + mode), keeping the relative order of
	 * siblings and of entries with no ancestor entry (the section entry, its
	 * columns, groupers). Every door calls it: the section door's column pass
	 * adds every column before the derived pass adds their undeclared
	 * subcontexts, and the get_data family (buildGetDataContext) sees a literal's
	 * frame items before the literal's own item (emitDdoData emits frames first,
	 * as PHP data does).
	 *
	 * DELIBERATE DIVERGENCE from PHP's order on MULTI-ROW reads
	 * (WC-2026-11-04-context-traversal-order): PHP get_subdatum loops locators
	 * outside, ddos inside (:2365/:2394), and its first-wins merge (:2779-2786) appends in that ROW-MAJOR order — a
	 * subcontext first seen in row 2 (column A empty in row 1) lands after column
	 * B and B's row-1 subcontexts. Here it lands right under A. The two orders
	 * agree on every single-row read; the set of entries is identical either way,
	 * and the client binds a cell to its context by key (tipo, section_tipo,
	 * mode[, caller_chain]), never by position. The tree order is the one a
	 * reader of the wire can predict without knowing which row filled what.
	 */
	orderByTraversal(): void {
		const entries = this.entries;
		const children = new Map<number, number[]>();
		const roots: number[] = [];
		const parentIndexOf = this.#parentIndexer();
		for (let index = 0; index < entries.length; index += 1) {
			const parent = parentIndexOf(index);
			if (parent === null) {
				roots.push(index);
				continue;
			}
			const siblings = children.get(parent) ?? [];
			siblings.push(index);
			children.set(parent, siblings);
		}
		const ordered: StructureContextEntry[] = [];
		const visited = new Set<number>();
		const visit = (index: number): void => {
			if (visited.has(index)) return;
			visited.add(index);
			ordered.push(entries[index] as StructureContextEntry);
			for (const child of children.get(index) ?? []) visit(child);
		};
		for (const root of roots) visit(root);
		// Defensive: an entry only reachable through a cycle keeps its place at the end.
		for (let index = 0; index < entries.length; index += 1) visit(index);
		entries.splice(0, entries.length, ...ordered);
	}

	/** The index of an entry's nearest ancestor entry, or null (orderByTraversal). */
	#parentIndexer(): (index: number) => number | null {
		const entries = this.entries;
		const byNodeKey = new Map<string, number>();
		const byContextKey = new Map<string, number>();
		// a TOP-LEVEL element's entry by tipo + mode: a column resolved once per
		// row (a TM row's config owner is that row's subject section) is one
		// entry, whichever row's node a subcontext descends from
		const byTopLevel = new Map<string, number>();
		entries.forEach((entry, index) => {
			const node = this.#orderNodes.get(entry);
			setFirst(byContextKey, contextKey(entry), index);
			if (node === undefined) return;
			setFirst(byNodeKey, node.key, index);
			const topKey = this.#topLevelKey(node);
			if (topKey !== null) setFirst(byTopLevel, topKey, index);
		});
		/** The entry standing for an ancestor node: by its node, its context_key, else (top level) its tipo. */
		const entryIndexOf = (ancestor: ElementNode): number | undefined => {
			const topKey = this.#topLevelKey(ancestor);
			return (
				byNodeKey.get(ancestor.key) ??
				byContextKey.get(
					contextKey({
						tipo: ancestor.tipo,
						section_tipo: ancestor.section_tipo,
						mode: ancestor.mode,
					}),
				) ??
				(topKey === null ? undefined : byTopLevel.get(topKey))
			);
		};
		return (index) => {
			const node = this.#orderNodes.get(entries[index] as StructureContextEntry);
			for (const ancestor of this.#ancestorsOf(node)) {
				const found = entryIndexOf(ancestor);
				if (found !== undefined && found !== index) return found;
			}
			return null;
		};
	}

	/**
	 * A node's element ancestors, nearest first (never the read's root map).
	 * Bounded by construction (each hop is one level up); the bound only guards
	 * against a malformed hand-built node.
	 */
	#ancestorsOf(node: ElementNode | undefined): ElementNode[] {
		const ancestors: ElementNode[] = [];
		let parentKey = node?.parentKey ?? null;
		while (parentKey !== null && ancestors.length < 64) {
			const parent = this.#registry.nodeByKey(parentKey);
			if (parent === undefined || parent.configSource === 'root') break;
			ancestors.push(parent);
			parentKey = parent.parentKey;
		}
		return ancestors;
	}

	/** A TOP-LEVEL element's `tipo|mode` (its parent is the read's root map), else null. */
	#topLevelKey(node: ElementNode): string | null {
		if (node.parentKey === null) return null;
		const parent = this.#registry.nodeByKey(node.parentKey);
		return parent?.configSource === 'root' ? `${node.tipo}|${node.mode}` : null;
	}

	#record(entry: StructureContextEntry, node: ElementNode | null, chain: string): void {
		const key = contextKey(entry);
		const occurrences = this.#byKey.get(key) ?? [];
		occurrences.push({
			entry,
			fingerprint: node === null ? null : this.fingerprintOf(node),
			chain,
		});
		this.#byKey.set(key, occurrences);
	}
}

/**
 * A LIST entry's page size, made to say what its cell paged by. A list cell
 * pages by nodeListPageLimit (the governing limit, else the local item's
 * show.sqo_config.limit ?? sqo.limit — element_node.ts), while the client
 * paginator reads the local item's sqo.limit FIRST: a config declaring both
 * keys with different values would page the cell at one size and the
 * paginator at the other. Only that disagreement is rewritten (a config with
 * no sqo.limit already falls back to the same sqo_config.limit), immutably —
 * the entry's request_config is the node's own array.
 */
export function withListPageLimit(entry: StructureContextEntry, node: ElementNode | null): void {
	const pageLimit = listPageLimitOf(entry, node);
	if (pageLimit === null) return;
	const items = entry.request_config as { sqo?: { limit?: unknown } }[];
	const local = selectLocalConfigItem(items as { api_engine?: string }[]) as {
		sqo?: { limit?: unknown };
	} | null;
	const declared = local?.sqo?.limit;
	if (local === null || declared === undefined || declared === pageLimit) return;
	entry.request_config = items.map((item) =>
		item === local ? { ...item, sqo: { ...item.sqo, limit: pageLimit } } : item,
	) as StructureContextEntry['request_config'];
}

/** The page size a LIST entry's cell paged by (nodeListPageLimit), else null (not a list entry from a node). */
function listPageLimitOf(entry: StructureContextEntry, node: ElementNode | null): number | null {
	if (node === null || entry.mode !== 'list' || !Array.isArray(entry.request_config)) return null;
	return nodeListPageLimit(node);
}

/**
 * The config source of a DERIVED item's context: its node, unless the node
 * cannot stand for the item's context (OWN_CONTEXT_REASONS): a one-level
 * expansion (its slots were emptied for the data path only), an item whose
 * mode was re-stamped after emission, or — defensively — an item no emitter
 * bound.
 */
export function itemConfigSource(
	node: ElementNode | undefined,
	item: { mode?: unknown },
): ContextConfigSource {
	if (node === undefined) return { source: 'own', reason: 'item-without-node' };
	if (node.oneLevel) return { source: 'own', reason: 'one-level-expansion' };
	if (node.mode !== item.mode) return { source: 'own', reason: 'item-mode-restamped' };
	return { source: 'emission', node };
}

/** What a door supplies for its DERIVED (subdatum) item contexts. */
export interface DerivedItemContextOptions {
	/** The door's own items (the read target's own component item): no derived entry. */
	readonly isOwnItem: (item: DataItem) => boolean;
	/** An item with no creating component is parented to this tipo. */
	readonly fallbackParent: (item: DataItem) => string;
	/** The item's stamped permission level (the door's subdatum inheritance rule). */
	readonly permissionsOf: (item: DataItem, parentTipo: string) => Promise<number>;
	/**
	 * The sort-join prepend (PHP get_order_path from_component/from_section) for
	 * a subdatum, or undefined (the get_data door stamps none).
	 */
	readonly orderPathFrom?: (
		parentTipo: string,
	) => { componentTipo: string; sectionTipo: string } | undefined;
	/** WC-079: a temporal clone ships no component toolbar. */
	readonly isTemporal?: boolean;
}

/** The node a config source stands for (null: an `own` door). */
function nodeOf(configFrom: ContextConfigSource): ElementNode | null {
	return configFrom.source === 'emission' ? configFrom.node : null;
}

/** Whether `item` gets a DERIVED context entry at all (not a shell, ddinfo or the door's own item). */
function isDerivedItem(item: DataItem, options: DerivedItemContextOptions): boolean {
	if ((item as { typo?: unknown }).typo === 'sections' || item.tipo === 'ddinfo') return false;
	return !options.isOwnItem(item);
}

/** The defensive `item-without-node` fallback is logged: every emitter binds today. */
function warnUnbound(item: DataItem, configFrom: ContextConfigSource): void {
	if (configFrom.source === 'own' && configFrom.reason === 'item-without-node') {
		console.warn(
			`[section/node_contexts] item '${String(item.tipo)}' @ '${String(item.section_tipo)}' has no element node — context built from its own config`,
		);
	}
}

/** Build ONE derived item's entry from its config source (parented to its creating component). */
async function buildItemEntry(
	item: DataItem,
	configFrom: ContextConfigSource,
	options: DerivedItemContextOptions,
): Promise<StructureContextEntry | null> {
	const parentTipo = String(item.from_component_tipo ?? options.fallbackParent(item));
	const orderPathFrom = options.orderPathFrom?.(parentTipo);
	return buildStructureContext({
		tipo: String(item.tipo),
		sectionTipo: String(item.section_tipo),
		mode: String(item.mode),
		lang: String(item.lang),
		// The emitted item lang IS the child's instance lang (emitDdoData,
		// elementLang) — its context must agree with it.
		requestedLang: String(item.lang),
		permissions: await options.permissionsOf(item, parentTipo),
		parent: parentTipo,
		view: nodeOf(configFrom)?.view ?? null,
		configFrom,
		...(orderPathFrom !== undefined ? { orderPathFrom } : {}),
		...(options.isTemporal === true ? { isTemporal: true } : {}),
	});
}

/**
 * One context entry per DERIVED item (the children the emission actually
 * resolved — per-locator section grouping included), in emission order, each
 * built from the node its item was bound to and parented to its creating
 * component (from_component_tipo). Deduplicated through `contexts` (module
 * header: first-wins for identical configs, per occurrence otherwise).
 */
export async function appendItemContexts(
	contexts: NodeContextSet,
	items: readonly DataItem[],
	nodes: ElementNodeRegistry,
	options: DerivedItemContextOptions,
): Promise<void> {
	for (const item of items) {
		if (isDerivedItem(item, options)) await appendItemContext(contexts, item, nodes, options);
	}
}

/** ONE derived item's context entry (appendItemContexts), unless it dedupes. */
async function appendItemContext(
	contexts: NodeContextSet,
	item: DataItem,
	nodes: ElementNodeRegistry,
	options: DerivedItemContextOptions,
): Promise<void> {
	const boundNode = nodes.nodeOfItem(item);
	const configFrom = itemConfigSource(boundNode, item);
	const node = nodeOf(configFrom);
	const key = contextKey({
		tipo: String(item.tipo),
		section_tipo: String(item.section_tipo),
		mode: String(item.mode),
	});
	// Skip the (costly) build when the entry would dedupe anyway (absorb also
	// remembers an identical config under another parent chain).
	if (contexts.absorb(key, node, boundNode ?? null)) return;
	warnUnbound(item, configFrom);
	const entry = await buildItemEntry(item, configFrom, options);
	if (entry === null) return;
	withListPageLimit(entry, node);
	contexts.add(entry, node, boundNode ?? null);
}

/**
 * A SECOND parent occurrence with a distinct config under one key
 * (NodeContextSet.add): every occurrence of the key becomes distinguishable —
 * the earlier ones retro-stamped with their chain, the new entry with its own.
 */
function stampSplitKey(
	occurrences: readonly { entry: StructureContextEntry; chain: string }[],
	entry: StructureContextEntry,
	chain: string,
): void {
	for (const occurrence of occurrences) occurrence.entry.caller_chain = occurrence.chain;
	entry.caller_chain = chain;
}
