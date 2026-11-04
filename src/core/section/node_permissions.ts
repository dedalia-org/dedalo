/**
 * SUBDATUM PERMISSION LEVELS FROM THE ELEMENT NODE CHAIN — owner decision (d),
 * "exact PHP" (nested-ddo_map plan §9d, W4 2026-11-03).
 *
 * THE PHP PATH, complete (frozen tree, file:line):
 *
 *   1. BUILD TIME — what reaches an element's config at all:
 *      - a SECTION caller drops every ddo of its map the user holds 0 on
 *        (trait.request_config_ddo.php:146-152 STEP 11 → check_ddo_permissions
 *        :381-392 — guarded on `$context->model === 'section'`). Every ddo of
 *        the map is judged, nested lines included (process_ddo_map :50-64);
 *      - a config-LESS element (v5 fallback, any caller model) keeps only the
 *        related tipos the user holds > 0 on against its target section
 *        (trait.request_config_v5.php:123-127 STEP 5 → filter_authorized_related
 *        :574-586) — the TM 'Who' column dd578 → dd132 case;
 *      - a COMPONENT's declared request_config (v6) is NEVER permission-gated
 *        at build time.
 *      The TS builders mirror all three (request_config/explicit.ts step 11,
 *      implicit.ts filterAuthorizedRelated; the section read's data gate and
 *      column pass for client maps).
 *
 *   2. INHERITANCE — what level a surviving child is stamped with
 *      (class.common.php:2564-2571, inside get_subdatum's per-ddo loop, only
 *      when the CALLER is a component — `$is_component_caller`, :2356):
 *
 *        own = child->get_component_permissions()
 *        own < 1                       → 1   (read, whatever the target grant)
 *        caller->permissions === 1 &&
 *          own > 1                     → 1   (a read-only caller caps)
 *
 *      `caller->permissions` is the CALLER INSTANCE's level — ITS OWN raised /
 *      capped value when it is itself a subdatum child (set_permissions writes
 *      the instance field get_component_permissions returns, class.common.php
 *      :689-692, class.component_common.php:3455-3459). So the cap travels the
 *      chain: under a read-only portal R, a child C (own 0 → 1) caps C's own
 *      children too, even where their own grant is 2.
 *
 *   `child->get_component_permissions()` is the child INSTANCE's level:
 *   resolve_component_read_permission(section, tipo, ITS section_id, ITS mode)
 *   (class.component_common.php:3455-3483, :3512-3612) — the generic matrix
 *   level plus the per-instance special cases. The TS twin is
 *   resolveComponentContextPermission (security/permissions.ts), which the
 *   doors pass as `ownLevelOf` WITH the item's section_id and the node's mode:
 *   it carries the search-mode grants and the dd128 OWN-USER-RECORD cases
 *   (full name / email / password / image → 2 on the viewer's own row; the
 *   guarded fields → 1). KNOWN DIVERGENCES, ledgered in
 *   WC-2026-11-04-subdatum-own-level-residual-divergences (the twin does not
 *   carry them on ANY door today): the TM-notes section
 *   (PHP → 1, the note's creator → 2), the IRI dataframe dd560 (PHP → 2) and
 *   the dd15 tm-mode floor beyond getPermissions' own. A NODE-level stamp (a
 *   context entry, the caller level a child inherits from) has no single
 *   row, so it is asked with no section_id — the matrix level — where PHP
 *   used the first instance's row (merge_unique_context first-wins).
 *
 * WHAT THIS MODULE COMPUTES: step 2 over the emission's NODE chain
 * (relations/element_registry.ts — each node knows its parent occurrence), so
 * every nested element is judged against its IMMEDIATE caller's computed
 * level, exactly as PHP's instance chain does. Injected children (a caller's
 * map naming the element's children) and own-config children follow the SAME
 * path: the node does not care who supplied the line, only which element
 * occurrence called it. The door supplies the TOP of the chain — the level of
 * an element whose caller is the read root itself (a section read's column:
 * its own matrix level; a component get_data's main element: its context
 * level) — and the own level of a nested element.
 *
 * Replaced (W4): the section door judged a nested item against the FIRST
 * context entry of its parent TIPO (first-wins across occurrences, owner
 * decision (b) made that ambiguous), the get_data door capped EVERY depth by
 * the MAIN element's level (a level-2 grandchild under a read-only child kept
 * 2), and the section column pass stamped a NESTED declared column with its
 * own level, uncapped by its read-only parent column.
 *
 * SCOPE: one instance per door call (a fresh memo; never module state —
 * module_state_tripwire). The memo is keyed by node key: a node is one element
 * occurrence of ONE emission, judged for ONE principal.
 */

import type { ElementNode, ElementNodeRegistry } from '../relations/element_registry.ts';
import { inheritSubdatumPermission } from '../security/permissions.ts';

/** What a door supplies (module header). */
export interface NodeLevelPolicy {
	/**
	 * Whether `node`'s caller is the read itself (its level is the door's own
	 * stamp, never inherited): a section read's column, a get_data's main
	 * element. A node whose parent is a ROOT pseudo node (or has no parent at
	 * all) is always top — the policy may add more (the get_data main node,
	 * whose parent may be a verified caller chain).
	 */
	readonly isTop?: (node: ElementNode) => boolean;
	/** The level of a TOP node (the door's stamp for it). */
	readonly topLevelOf: (node: ElementNode) => Promise<number>;
	/**
	 * The OWN level of a nested element at a section, before inheritance — PHP
	 * child->get_component_permissions(): asked with the instance's row
	 * (`sectionId`, null for a node-level stamp) and mode (module header).
	 */
	readonly ownLevelOf: (
		sectionTipo: string,
		tipo: string,
		sectionId: string | number | null,
		mode: string,
	) => Promise<number>;
	/**
	 * Whether the subdatum RAISE (own < 1 → 1) applies to a nested element at
	 * (section, tipo). Absent = always (PHP). A read a WRITER SCOPE opened
	 * (owner decision (h), security/writer_chain_scope.ts) bounds the raise to
	 * the writer component's column pairs: a nested element outside them — a
	 * scoped relation column's OWN-config child on a third section — keeps its
	 * own grant, so the scope never serves a section it did not open
	 * (WC-2026-11-04-writer-chain-scoped-search).
	 */
	readonly raises?: (sectionTipo: string, tipo: string) => boolean;
}

/**
 * The PHP level of every element occurrence of one emission (module header).
 */
export class NodePermissionLevels {
	readonly #registry: ElementNodeRegistry;
	readonly #policy: NodeLevelPolicy;
	/** Levels by node key (built once per occurrence; a failed build is retried). */
	readonly #memo = new Map<string, Promise<number>>();

	constructor(registry: ElementNodeRegistry, policy: NodeLevelPolicy) {
		this.#registry = registry;
		this.#policy = policy;
	}

	/** The parent ELEMENT node of `node` (undefined for a top-level occurrence). */
	#parentElementOf(node: ElementNode): ElementNode | undefined {
		if (node.parentKey === null) return undefined;
		const parent = this.#registry.nodeByKey(node.parentKey);
		return parent === undefined || parent.configSource === 'root' ? undefined : parent;
	}

	/** Whether `node` is judged by the door's own stamp (NodeLevelPolicy.isTop). */
	isTop(node: ElementNode): boolean {
		return this.#parentElementOf(node) === undefined || this.#policy.isTop?.(node) === true;
	}

	/**
	 * The level `node` is stamped with: the door's top level, else its own level
	 * inherited from its IMMEDIATE caller's computed level (PHP :2564-2571).
	 */
	levelOf(node: ElementNode): Promise<number> {
		const known = this.#memo.get(node.key);
		if (known !== undefined) return known;
		const pending = this.#compute(node).catch((error: unknown) => {
			this.#memo.delete(node.key);
			throw error;
		});
		this.#memo.set(node.key, pending);
		return pending;
	}

	async #compute(node: ElementNode): Promise<number> {
		if (this.isTop(node)) return this.#policy.topLevelOf(node);
		const parent = this.#parentElementOf(node) as ElementNode;
		const own = await this.#policy.ownLevelOf(node.section_tipo, node.tipo, null, node.mode);
		return this.#inherit(own, await this.levelOf(parent), node.section_tipo, node.tipo);
	}

	/** PHP :2564-2571 inheritance, the raise bounded by NodeLevelPolicy.raises. */
	#inherit(own: number, callerLevel: number, sectionTipo: string, tipo: string): number {
		if (own < 1 && this.#policy.raises?.(sectionTipo, tipo) === false) return 0;
		return inheritSubdatumPermission(own, callerLevel);
	}

	/**
	 * The level of ONE emitted item of `node`, judged at the ITEM's section (a
	 * multi-target child's item sits at its locator's section): its own level
	 * inherited from the node's caller. A top node's item takes the door's
	 * stamp. undefined = the node chain cannot judge it (no node) — the door's
	 * fallback rule applies. `itemSectionId` is the item's own row (PHP builds
	 * the child instance with the locator's section_id), so the per-instance
	 * cases of the own level apply (module header); null when unknown.
	 */
	async itemLevel(
		node: ElementNode | undefined,
		itemSectionTipo: string,
		itemTipo: string,
		itemSectionId: string | number | null = null,
	): Promise<number | undefined> {
		if (node === undefined) return undefined;
		if (this.isTop(node)) return this.#policy.topLevelOf(node);
		const parent = this.#parentElementOf(node) as ElementNode;
		const own = await this.#policy.ownLevelOf(itemSectionTipo, itemTipo, itemSectionId, node.mode);
		return this.#inherit(own, await this.levelOf(parent), itemSectionTipo, itemTipo);
	}
}
