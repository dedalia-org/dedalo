/**
 * NodeContextSet (section/node_contexts.ts) — the dedup / per-occurrence /
 * order rules of a response's context array, on hand-built element nodes (no
 * DB): the end-to-end doors are gated by nested_ddo_data_native.test.ts.
 *
 *  - PER PARENT OCCURRENCE ONLY (owner decision (b)): two DIFFERENT configs of
 *    one context_key under the SAME parent chain dedupe first-wins (PHP — a
 *    record-dependent config, e.g. an sqo fixed_filter expanded per owning
 *    record, must not mint one context per row); under DIFFERENT chains they
 *    split, and every occurrence is stamped with its `caller_chain`. Identical
 *    configs under different chains stay ONE unstamped entry.
 *  - STAMPING AGREES WITH DEDUP: an item takes the chain of the occurrence its
 *    context deduped into — an `own`-sourced item (a one-level node) the FIRST
 *    occurrence, exactly what covered(key, null) chose for it.
 *  - PHP TRAVERSAL ORDER (orderByTraversal): an element's subcontexts follow it,
 *    before the next column; entries with no ancestor keep their order.
 */

import { describe, expect, test } from 'bun:test';
import {
	type ElementNode,
	ElementNodeRegistry,
} from '../../src/core/relations/element_registry.ts';
import type { StructureContextEntry } from '../../src/core/resolve/structure_context.ts';
import { NodeContextSet } from '../../src/core/section/node_contexts.ts';

/** A hand-built node (only the fields NodeContextSet reads matter). */
function node(fields: Partial<ElementNode> & { key: string; tipo: string }): ElementNode {
	return {
		parentKey: null,
		section_tipo: 'zzncs1',
		mode: 'list',
		view: null,
		lang: 'lg-nolan',
		limit: null,
		parent_grouper: null,
		properties: null,
		effectiveConfig: [],
		configSource: 'own',
		injected: false,
		injectedSlots: [],
		dataChildrenInjected: false,
		childOrigin: 'ontology',
		children: [],
		oneLevel: false,
		...fields,
	} as ElementNode;
}

/** A config whose show names `tipos` (what the fingerprint hashes). */
const config = (...tipos: string[]) =>
	[
		{ api_engine: 'dedalo', type: 'main', show: { ddo_map: tipos.map((tipo) => ({ tipo })) } },
	] as never;

/** A bare context entry for `n`. */
const entryOf = (n: ElementNode): StructureContextEntry =>
	({ tipo: n.tipo, section_tipo: n.section_tipo, mode: n.mode }) as StructureContextEntry;

/** A data item of `n` (bound to it in `registry`). */
function itemOf(registry: ElementNodeRegistry, n: ElementNode): Record<string, unknown> {
	const item = { tipo: n.tipo, section_tipo: n.section_tipo, mode: n.mode };
	registry.bindItem(item, n);
	return item;
}

/** A registry with a root, two parents P1 / P2 under it, and the extra nodes `build` registers. */
async function scene() {
	const registry = new ElementNodeRegistry();
	const root = registry.rootFor([], (key) =>
		node({ key, tipo: 'zzncs1', configSource: 'root', section_tipo: 'zzncs1' }),
	);
	const add = (n: ElementNode) => registry.memo(n.key, async () => n);
	const p1 = await add(node({ key: 'p1', parentKey: root.key, tipo: 'zzncs2' }));
	const p2 = await add(node({ key: 'p2', parentKey: root.key, tipo: 'zzncs3' }));
	return { registry, root, add, p1, p2 };
}

describe('NodeContextSet', () => {
	test('a different config under the SAME parent chain dedupes first-wins (no per-record split)', async () => {
		const { registry, add } = await scene();
		const row1 = await add(
			node({ key: 'nm#1', parentKey: 'p1', tipo: 'zzncs4', effectiveConfig: config('a') }),
		);
		const row2 = await add(
			node({ key: 'nm#2', parentKey: 'p1', tipo: 'zzncs4', effectiveConfig: config('b') }),
		);
		const contexts = new NodeContextSet(registry);
		expect(contexts.add(entryOf(row1), row1)).toBe(true);
		expect(contexts.add(entryOf(row2), row2)).toBe(false);
		expect(contexts.entries).toHaveLength(1);
		expect(contexts.entries[0]?.caller_chain).toBeUndefined();
		const items = [itemOf(registry, row1), itemOf(registry, row2)];
		contexts.stampItems(items);
		expect(items.some((item) => item.caller_chain !== undefined)).toBe(false);
	});

	test('different configs under DIFFERENT parents split; items take their own chain', async () => {
		const { registry, add } = await scene();
		const underP1 = await add(
			node({ key: 'nm@p1', parentKey: 'p1', tipo: 'zzncs4', effectiveConfig: config('b') }),
		);
		const underP2 = await add(
			node({ key: 'nm@p2', parentKey: 'p2', tipo: 'zzncs4', effectiveConfig: config('a', 'b') }),
		);
		const contexts = new NodeContextSet(registry);
		expect(contexts.add(entryOf(underP1), underP1)).toBe(true);
		expect(contexts.add(entryOf(underP2), underP2)).toBe(true);
		expect(contexts.entries.map((entry) => entry.caller_chain)).toEqual(['zzncs2', 'zzncs3']);
		const items = [itemOf(registry, underP2), itemOf(registry, underP1)];
		contexts.stampItems(items);
		expect(items.map((item) => item.caller_chain)).toEqual(['zzncs3', 'zzncs2']);
	});

	test('identical configs under different parents: ONE entry, nothing stamped', async () => {
		const { registry, add } = await scene();
		const underP1 = await add(
			node({ key: 'nm@p1', parentKey: 'p1', tipo: 'zzncs4', effectiveConfig: config('a') }),
		);
		const underP2 = await add(
			node({ key: 'nm@p2', parentKey: 'p2', tipo: 'zzncs4', effectiveConfig: config('a') }),
		);
		const contexts = new NodeContextSet(registry);
		contexts.add(entryOf(underP1), underP1);
		expect(contexts.add(entryOf(underP2), underP2)).toBe(false);
		expect(contexts.entries).toHaveLength(1);
		const items = [itemOf(registry, underP1), itemOf(registry, underP2)];
		contexts.stampItems(items);
		expect(items.some((item) => item.caller_chain !== undefined)).toBe(false);
	});

	test('an own-sourced item of a split key is stamped with the occurrence its dedup chose', async () => {
		const { registry, add } = await scene();
		const underP1 = await add(
			node({ key: 'nm@p1', parentKey: 'p1', tipo: 'zzncs4', effectiveConfig: config('b') }),
		);
		const underP2 = await add(
			node({ key: 'nm@p2', parentKey: 'p2', tipo: 'zzncs4', effectiveConfig: config('a', 'b') }),
		);
		// A ONE-LEVEL node under P2: its context is `own` (itemConfigSource), so
		// covered(key, null) dedupes it into the FIRST occurrence — its stamp too.
		const oneLevel = await add(
			node({
				key: 'nm@p2!1',
				parentKey: 'p2',
				tipo: 'zzncs4',
				effectiveConfig: config(),
				oneLevel: true,
			}),
		);
		const contexts = new NodeContextSet(registry);
		contexts.add(entryOf(underP1), underP1);
		contexts.add(entryOf(underP2), underP2);
		const item = itemOf(registry, oneLevel);
		contexts.stampItems([item]);
		expect(item.caller_chain).toBe('zzncs2');
	});

	// ABSORBED CHAINS (W5 review 2026-11-03): a third parent whose config equals
	// the second's deduped into it and got NO entry of its own, so its cells
	// (path [P3]) matched no stamped chain and borrowed the first entry's config.
	// Once the key is split, every chain names its own entry — whichever came
	// first, the split or the absorption.
	for (const order of ['split first', 'absorbed first'] as const) {
		test(`a split key gives an absorbed chain its own stamped copy (${order})`, async () => {
			const { registry, root, add } = await scene();
			await add(node({ key: 'p3', parentKey: root.key, tipo: 'zzncs5' }));
			const underP1 = await add(
				node({ key: 'nm@p1', parentKey: 'p1', tipo: 'zzncs4', effectiveConfig: config('b') }),
			);
			const underP2 = await add(
				node({ key: 'nm@p2', parentKey: 'p2', tipo: 'zzncs4', effectiveConfig: config('a') }),
			);
			const underP3 = await add(
				node({ key: 'nm@p3', parentKey: 'p3', tipo: 'zzncs4', effectiveConfig: config('a') }),
			);
			const contexts = new NodeContextSet(registry);
			const sequence =
				order === 'split first' ? [underP1, underP2, underP3] : [underP2, underP3, underP1];
			const parentOf = new Map<ElementNode, string>([
				[underP1, 'zzncs2'],
				[underP2, 'zzncs3'],
				[underP3, 'zzncs5'],
			]);
			for (const occurrence of sequence) {
				contexts.add(
					{
						...entryOf(occurrence),
						label: occurrence.key,
						parent: parentOf.get(occurrence) ?? null,
					},
					occurrence,
				);
			}
			const byChain = new Map(contexts.entries.map((entry) => [entry.caller_chain, entry]));
			expect([...byChain.keys()].sort()).toEqual(['zzncs2', 'zzncs3', 'zzncs5']);
			// the copy carries the config it deduped into (P2's), never P1's …
			expect(byChain.get('zzncs5')?.label).toBe('nm@p2');
			// … and its OWN direct parent (the chain's last segment), never P2's
			// (WC-2026-11-04-caller-chain-per-occurrence): every stamped entry's
			// `parent` agrees with its chain.
			for (const [chain, entry] of byChain) {
				expect(entry.parent).toBe(String(chain).split('>').at(-1) ?? null);
			}
			const items = [itemOf(registry, underP3), itemOf(registry, underP1)];
			contexts.stampItems(items);
			expect(items.map((item) => item.caller_chain)).toEqual(['zzncs5', 'zzncs2']);
		});
	}

	test("orderByTraversal: a column's subcontexts follow it, before the next column", async () => {
		const { registry, root, add, p1 } = await scene();
		const other = await add(node({ key: 'x', parentKey: root.key, tipo: 'zzncs5' }));
		const nested = await add(
			node({ key: 'nm', parentKey: 'p1', tipo: 'zzncs4', section_tipo: 'zzncs6' }),
		);
		const leaf = await add(
			node({ key: 'a', parentKey: 'nm', tipo: 'zzncs7', section_tipo: 'zzncs8' }),
		);
		const section = {
			tipo: 'zzncs1',
			section_tipo: 'zzncs1',
			mode: 'list',
		} as StructureContextEntry;
		const contexts = new NodeContextSet(registry);
		contexts.addOwn(section);
		// The column pass (every column), then the derived pass (their subcontexts).
		contexts.add(entryOf(p1), p1);
		contexts.add(entryOf(other), other);
		contexts.add(entryOf(nested), nested);
		// An own-config derived entry is placed by the node its item was bound to.
		contexts.add(entryOf(leaf), null, leaf);
		contexts.orderByTraversal();
		expect(contexts.entries.map((entry) => entry.tipo)).toEqual([
			'zzncs1',
			'zzncs2',
			'zzncs4',
			'zzncs7',
			'zzncs5',
		]);
	});
});
