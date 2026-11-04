/**
 * THE PER-EMISSION ELEMENT NODE REGISTRY — one resolved node per element
 * occurrence, scoped to ONE EmissionContext (resolve/component_data.ts).
 *
 * WHY A NODE. PHP keeps exactly ONE request_config object per element instance:
 * built in `build_request_config`, injected in place by the parent's
 * `get_subdatum` (class.common.php:2603-2681), and read by BOTH the element's
 * own subdatum (its data) and its emitted context. Data and context therefore
 * cannot disagree about which children an element has. The TS engine decided
 * the two apart (three own-config builds, contexts rebuilt from item arrays) —
 * which is how tch197's rsc1400 rendered name | surname while its data said
 * surname | name. The node is the TS form of that one object: the element's
 * EFFECTIVE config plus the governing ddo's per-occurrence fields, resolved
 * ONCE (relations/element_node.ts resolveElement) and read by every consumer.
 *
 * SCOPE: one registry per EmissionContext, NEVER module state
 * (module_state_tripwire; engineering/REQUEST_ISOLATION.md). A Time Machine
 * FORK of an emission (read_tm.ts graftRowFrameState / the whole-row cell
 * bound) shares the registry BY REFERENCE — a fork only re-binds the
 * as-of bound, it is the same response.
 *
 * KEYED PER PARENT OCCURRENCE (owner decision (b), 2026-11-03): a node's key
 * chains its parent node's key, so the same tipo under two different parents
 * (tch197 → rsc1400 and a second portal P2 → rsc1400) is TWO nodes with two
 * configs — never PHP's first-wins collapse. The context serialiser (W3) reads
 * them per occurrence.
 *
 * LEAF MODULE: type-only imports, so EmissionContext can hold one without
 * pulling the relations graph into resolve/ (import_scc_tripwire).
 */

import type { ApiNotice } from '../errors/schema.ts';
import type {
	ConfigSlot,
	DdoMapOrigin,
	InjectableConfigItem,
} from './request_config/caller_injection.ts';

/** Where a node's effective config came from. */
export type ElementConfigSource =
	/** Stage 1: the rqo targeted this element and carried a show (request_config/from_rqo.ts). */
	| 'rqo'
	/** The element's own config (the ONE base resolver, request_config/own_config.ts), possibly injected. */
	| 'own'
	/** No own config of its own: the caller's children ARE the config (see resolveElement). */
	| 'caller'
	/** The pseudo node standing for a read's ROOT map (a section's ddo_map, a TM column map). */
	| 'root';

/**
 * ONE element occurrence, resolved. Every field is the GOVERNING value — what
 * the element is under THIS parent, not what its ontology says in isolation.
 */
export interface ElementNode {
	/** Registry key: the parent's key + this occurrence (see the module header). */
	readonly key: string;
	/** The parent node's key; null for a root. */
	readonly parentKey: string | null;
	readonly tipo: string;
	/** The section the element's config resolves against (its owner section). */
	readonly section_tipo: string;
	/** The element's render mode under this parent. */
	readonly mode: string;
	/** The governing ddo's view, or null (the context applies the structural fallback). */
	readonly view: string | null;
	/** The element's instance lang (resolver.ts elementLang). */
	readonly lang: string;
	// NO `permissions` field (W4, owner decision (d)). A node's level is never
	// a value the governing ddo DECLARES: PHP get_subdatum never reads
	// `$ddo->permissions` — the ddo key is an OUTPUT the builder stamps
	// (trait.request_config_ddo.php:358 resolve_ddo_fields_map,
	// request_config/explicit.ts) — and a client-sent show ddo may carry any
	// number. The PHP-computed level (own grant + the get_subdatum raise/cap,
	// class.common.php:2564-2575) lives ONLY in section/node_permissions.ts
	// (NodePermissionLevels.levelOf, keyed by node); every door and context
	// reads it there.
	/** The governing ddo's page size (a positive integer), or null = the config's own. */
	readonly limit: number | null;
	/** The governing ddo's parent_grouper, or null. */
	readonly parent_grouper: string | null;
	/** The governing ddo's `properties` (merged into context properties only — PHP :2758-2770), or null. */
	readonly properties: Readonly<Record<string, unknown>> | null;
	/** THE config: data children and (W3) the emitted context both read this. */
	readonly effectiveConfig: readonly InjectableConfigItem[];
	readonly configSource: ElementConfigSource;
	/**
	 * True when at least one slot (show / search / choose / hide) of the base
	 * config was replaced by caller children. INFORMATIONAL — never read it as
	 * "the data children came from the caller": a search-only caller replaces
	 * search and leaves show + hide the element's own (plan E3). That question is
	 * `dataChildrenInjected`.
	 */
	readonly injected: boolean;
	/** The slots the caller replaced, in CONFIG_SLOTS order (empty = nothing injected). */
	readonly injectedSlots: readonly ConfigSlot[];
	/**
	 * True when a DATA slot (show or hide — what `children` is built from) was
	 * replaced by caller children. Every consumer that asks "are these children
	 * the element's own?" reads this, never `injected`: the thesaurus-table
	 * ddinfo branch, the frame's own-vs-caller children, the child-map origin.
	 */
	readonly dataChildrenInjected: boolean;
	/**
	 * Whose map this node's CHILDREN came from — the code a fan-out refusal
	 * carries when a grandchild's children are collected from this node
	 * (caller_injection.ts, BOUNDED WALK).
	 */
	readonly childOrigin: DdoMapOrigin;
	/** The direct children the data path expands (show + hide of effectiveConfig, flattened). */
	readonly children: readonly Readonly<Record<string, unknown>>[];
	/**
	 * True for a ONE-LEVEL expansion (element_node.ts ResolveElementInput
	 * useOwnConfig false — relation_index related_list children, component_filter
	 * outside list/edit/search): its own slots were EMPTIED so the data path does
	 * not expand its own children. That emptying is a data-side device, not the
	 * element's definition, so the context door keeps the element's own config
	 * for it (structure_context.ts OWN_CONTEXT_REASONS 'one-level-expansion').
	 */
	readonly oneLevel: boolean;
}

/**
 * The resolution scope a NESTED emission carries down: the parent element's
 * node (whose effective config supplies the caller children) and the
 * record-occurrence PATH from the read's root to here (owner decision (e) — a
 * record cycle A → B → A stops at the repeat on THIS path).
 */
export interface EmitScope {
	readonly parentNode: ElementNode;
	/** `${section_tipo}|${section_id}|${tipo}` of every relation element expanded on the way down. */
	readonly path: readonly string[];
}

/** Most distinct notices of ONE code a response carries (the W1 bound, SCALAR_BOUNDS.ddoMapWarnings). */
const NOTICES_PER_CODE = 5;

/** The dedup identity of a notice: its code + its details WITHOUT the `more` counter. */
function noticeIdentity(notice: ApiNotice): string {
	const { more: _more, ...rest } = notice.details ?? {};
	const entries = Object.entries(rest).sort(([left], [right]) => (left < right ? -1 : 1));
	return `${notice.code}|${JSON.stringify(entries)}`;
}

/** A notice's own `more` counter (0 when absent or not a number). */
function moreOf(notice: ApiNotice): number {
	const more = notice.details?.more;
	return typeof more === 'number' && Number.isFinite(more) ? more : 0;
}

/**
 * The registry itself. Class fields only — a fresh instance per emission (see
 * the module header); nothing here is process-wide.
 */
export class ElementNodeRegistry {
	/** Builds in flight or done, by key (a promise, so two concurrent asks build once). */
	readonly #byKey = new Map<string, Promise<ElementNode>>();
	/** Resolved nodes, in resolution order (the PHP traversal order W3 serialises in). */
	readonly #resolved: ElementNode[] = [];
	/** Root pseudo nodes, by the identity of the map they stand for. */
	readonly #roots = new WeakMap<object, ElementNode>();
	#rootCount = 0;
	/** Root pseudo nodes of EMPTY maps, by their stable identity (emptyRootFor). */
	readonly #emptyRoots = new Map<string, ElementNode>();
	/**
	 * EVERY root pseudo node, by its key, in creation order — so a top-level
	 * node's `parentKey` resolves (nodeByKey) to the root standing for its
	 * caller (root.tipo = the caller tipo a context entry's `parent` needs).
	 */
	readonly #rootsByKey = new Map<string, ElementNode>();
	/** Distinct notices, by identity, in arrival order; per-code overflow folds into `more`. */
	readonly #notices = new Map<string, ApiNotice>();
	readonly #perCode = new Map<string, string[]>();
	/**
	 * Identities already FOLDED into a kept notice's `more` (addNotices): a
	 * repeat of an overflowed notice is the same notice again, never one more
	 * skipped item — without this set it passed the kept-notice dedup and
	 * inflated `more` on every arrival.
	 */
	readonly #overflowed = new Set<string>();

	/**
	 * Which node each emitted DATA ITEM is a projection of (bindItem): the item
	 * of an element occurrence → that occurrence's node. The context serialiser
	 * (section/node_contexts.ts) reads it, so a child's context is built from
	 * exactly the node its data came from. A WeakMap: the items belong to the
	 * response, the registry never keeps one alive.
	 */
	readonly #nodeOfItem = new WeakMap<object, ElementNode>();

	/**
	 * The node a SOURCE-OWNED context entry stands for in traversal order
	 * (placeContext): a door that builds its entries itself (the dd15 TM
	 * source, read_tm.ts buildTmContext) keys a column under ANOTHER section
	 * than its node's (dd15 vs the subject section), so the context set cannot
	 * find the column by its node's context_key — the door names it here.
	 */
	readonly #placementOfContext = new WeakMap<object, ElementNode>();

	/**
	 * Whose map a ROOT is (decides a fan-out refusal's code). The section read
	 * sets it from the rqo ('client' when the request carried its show map);
	 * every other producer derives its root map server-side.
	 */
	rootOrigin: DdoMapOrigin = 'ontology';

	/**
	 * The read's TARGETED element node (setTarget): what a get_data door
	 * resolved for the element its rqo names — stage 1 when the rqo carried a
	 * show, the governing page size, the `source.properties` override — BEFORE
	 * emitting it. null = no door pinned one.
	 */
	#target: ElementNode | null = null;

	/**
	 * Pin the read's TARGETED element node. A TOP-LEVEL emission of that element
	 * (relations/element_node.ts resolveEmittedElement with no scope, same tipo,
	 * owner section and mode) answers THIS node instead of resolving the own
	 * config under the root map — so every get_data producer (a literal and its
	 * frames, the select/filter family, relation_index's own-config portal
	 * expansion) emits its data from the very node its main context entry is
	 * serialised from (section/read.ts buildGetDataContext `mainNode`), not only
	 * the portal producer that hands its node to expandPortal directly.
	 */
	setTarget(node: ElementNode): void {
		this.#target = node;
	}

	/**
	 * The read's VERIFIED caller node for its targeted element
	 * (relations/caller_chain.ts — `rqo.source.callers`), built once per
	 * emission: every get_data door that resolves the target in this registry
	 * resolves it under the same caller. null = no chain, or a refused one.
	 */
	#callerParent: Promise<ElementNode | null> | undefined;

	/** The verified caller node, built once (see #callerParent). */
	callerParent(build: () => Promise<ElementNode | null>): Promise<ElementNode | null> {
		this.#callerParent ??= build();
		return this.#callerParent;
	}

	/** The pinned target node when it IS `tipo` @ `sectionTipo` in `mode`, else undefined. */
	targetFor(tipo: string, sectionTipo: string, mode: string): ElementNode | undefined {
		const target = this.#target;
		if (target === null) return undefined;
		return target.tipo === tipo && target.section_tipo === sectionTipo && target.mode === mode
			? target
			: undefined;
	}

	/**
	 * The node under `key`, building it once. A failed build is forgotten (the
	 * next ask retries) and its error propagates — never a cached rejection.
	 */
	memo(key: string, build: () => Promise<ElementNode>): Promise<ElementNode> {
		const existing = this.#byKey.get(key);
		if (existing !== undefined) return existing;
		const pending = build().then(
			(node) => {
				this.#resolved.push(node);
				return node;
			},
			(error: unknown) => {
				this.#byKey.delete(key);
				throw error;
			},
		);
		this.#byKey.set(key, pending);
		return pending;
	}

	/** The ROOT pseudo node for `map` (built once per map object). */
	rootFor(map: object, build: (key: string) => ElementNode): ElementNode {
		const existing = this.#roots.get(map);
		if (existing !== undefined) return existing;
		this.#rootCount += 1;
		const node = build(`root#${this.#rootCount}`);
		this.#roots.set(map, node);
		this.#rootsByKey.set(node.key, node);
		return node;
	}

	/**
	 * The ROOT pseudo node of an EMPTY caller map, by its STABLE identity
	 * (caller tipo, section, mode) — not by object identity. Emitters with no
	 * scope (relation_index related_list children, a top-level read's
	 * scopeless hops) hand a fresh `[]` per emitted cell; keyed by object, every cell
	 * would mint a new root and a new node for the SAME element, the memo would
	 * never hit, and `nodes()` would collect one copy per cell. An empty map
	 * names no children, so every such root of one caller is the same root.
	 */
	emptyRootFor(identity: string, build: (key: string) => ElementNode): ElementNode {
		const existing = this.#emptyRoots.get(identity);
		if (existing !== undefined) return existing;
		const node = build(`root:${identity}`);
		this.#emptyRoots.set(identity, node);
		this.#rootsByKey.set(node.key, node);
		return node;
	}

	/** Every resolved element node, in resolution order. */
	nodes(): readonly ElementNode[] {
		return this.#resolved;
	}

	/** Every ROOT pseudo node (configSource 'root'), in creation order. */
	rootNodes(): readonly ElementNode[] {
		return [...this.#rootsByKey.values()];
	}

	/**
	 * The node under `key` — a resolved element node OR a root pseudo node, so
	 * `nodeByKey(node.parentKey)` answers for every node, top-level included.
	 */
	nodeByKey(key: string): ElementNode | undefined {
		return this.#rootsByKey.get(key) ?? this.#resolved.find((node) => node.key === key);
	}

	/**
	 * Bind an emitted data item to the node it projects. FIRST BIND WINS: the
	 * emitter that knows the exact occurrence (expandPortal's own item, a
	 * dataframe's frame item) binds first, and the generic per-ddo pass
	 * (section/read.ts emitDdoData) only binds what is still unbound.
	 */
	bindItem(item: object, node: ElementNode): void {
		if (!this.#nodeOfItem.has(item)) this.#nodeOfItem.set(item, node);
	}

	/** Whether an item is already bound to a node. */
	isItemBound(item: object): boolean {
		return this.#nodeOfItem.has(item);
	}

	/** The node an emitted item projects, or undefined (an item no element emitted: ddinfo, a shell). */
	nodeOfItem(item: object): ElementNode | undefined {
		return this.#nodeOfItem.get(item);
	}

	/** Name the node a source-owned context entry is placed by (#placementOfContext). */
	placeContext(entry: object, node: ElementNode): void {
		this.#placementOfContext.set(entry, node);
	}

	/** The node a source-owned context entry was placed by, or undefined. */
	placementOfContext(entry: object): ElementNode | undefined {
		return this.#placementOfContext.get(entry);
	}

	/**
	 * The FIRST resolved node (resolution order — PHP's first-wins) of `tipo`
	 * under the parent `parentKey`, owned by `sectionTipo`, in `mode`.
	 */
	findChild(
		parentKey: string | null,
		tipo: string,
		sectionTipo: string,
		mode: string,
	): ElementNode | undefined {
		return this.#resolved.find(
			(node) =>
				node.parentKey === parentKey &&
				node.tipo === tipo &&
				node.section_tipo === sectionTipo &&
				node.mode === mode,
		);
	}

	/**
	 * The ancestor TIPO chain of a node: its parent element's tipo, that one's
	 * parent's, … up to (not including) the read's root map, outermost first —
	 * e.g. `['tch197']` for rsc1400 under tch197, `['tch197', 'rsc1400']` for
	 * rsc86 under it. The per-occurrence context key (owner decision (b)) is
	 * built from it (section/node_contexts.ts NodeContextSet).
	 */
	ancestorTipos(node: ElementNode): string[] {
		const chain: string[] = [];
		let parentKey = node.parentKey;
		// Bounded by construction (every hop is a resolved node one level up); the
		// guard only protects against a malformed hand-built node.
		for (let hops = 0; parentKey !== null && hops < 64; hops += 1) {
			const parent = this.nodeByKey(parentKey);
			if (parent === undefined || parent.configSource === 'root') break;
			chain.unshift(parent.tipo);
			parentKey = parent.parentKey;
		}
		return chain;
	}

	/**
	 * Record notices for the response. Deduplicated by (code, details minus
	 * `more`) and bounded PER CODE: past NOTICES_PER_CODE distinct notices of
	 * one code, each further one (and whatever its own `more` already counted)
	 * is added to the `more` of the last kept notice of that code — nothing is
	 * hidden silently, and a pathological read is still a handful of toasts.
	 */
	addNotices(notices: readonly ApiNotice[]): void {
		for (const notice of notices) {
			const identity = noticeIdentity(notice);
			if (this.#notices.has(identity) || this.#overflowed.has(identity)) continue;
			const kept = this.#perCode.get(notice.code) ?? [];
			if (kept.length < NOTICES_PER_CODE) {
				this.#notices.set(identity, notice);
				kept.push(identity);
				this.#perCode.set(notice.code, kept);
				continue;
			}
			this.#overflowed.add(identity);
			const lastIdentity = kept[kept.length - 1] as string;
			const last = this.#notices.get(lastIdentity) as ApiNotice;
			this.#notices.set(lastIdentity, {
				...last,
				details: { ...last.details, more: moreOf(last) + 1 + moreOf(notice) },
			});
		}
	}

	/** The notices this emission owes its response (undefined-free, possibly empty). */
	notices(): ApiNotice[] {
		return [...this.#notices.values()];
	}

	/**
	 * The same notices as an envelope option: undefined when there are none, so
	 * the converter (errors/convert.ts ok) emits no `notices` key at all.
	 */
	responseNotices(): ApiNotice[] | undefined {
		return this.#notices.size === 0 ? undefined : this.notices();
	}
}
