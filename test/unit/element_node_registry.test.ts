/**
 * The per-emission ELEMENT NODE REGISTRY and the pure halves of
 * resolveElement (relations/element_registry.ts, relations/element_node.ts).
 * Every resolution here runs with `useOwnConfig: false`, an explicit model and
 * `zzu*` tipos no ontology holds, so the own config resolves to nothing and
 * the caller's children decide. The OWN-config halves — own vs injected vs
 * stage 1, per-slot replacement, a one-level expansion's own page size, the
 * list-mode fallback, the governing limit on a real read, the record-cycle and
 * depth-bound notices — run against a real scratch ontology in
 * nested_ddo_data_native.test.ts.
 *
 * Pinned here:
 *   - the registry is per EmissionContext, never module state; a Time Machine
 *     fork (EmissionContext.fork — read_tm.ts's only way to fork) SHARES it,
 *     and the items, by reference;
 *   - memo builds once, forgets a failed build (no cached rejection);
 *   - an EMPTY caller map is one root per (caller, section, mode), whatever
 *     array object carries it (one node per element, not per emitted cell);
 *   - node keys are per PARENT occurrence (owner decision (b)) and per governing
 *     fields + lang: the same tipo under two parents, or with another view /
 *     lang, is another node;
 *   - an element with no config takes the caller's DEDALO children as its
 *     config (PHP's v5 fallback item) — never a non-dedalo engine's;
 *   - the governing ddo's limit lands on sqo.limit ONLY (PHP's instance
 *     pagination; a declared show.sqo_config.limit is left as declared — that
 *     half, and nodeListPageLimit reading the governing limit first, is pinned
 *     on a real own config in nested_ddo_data_native (c) node);
 *   - mode 'solved' resolves no data children;
 *   - the root pseudo node refuses level >= 2 'self' ddos with a notice;
 *   - notices dedup by (code, details minus `more`) and fold past 5 per code,
 *     a REPEAT of an already-folded notice never inflates `more` again, and a
 *     self_depth batch's remainder is counted once across both layers;
 *   - directDataChildren takes show AND hide, 'self' resolved to the element;
 *   - every ROOT is reachable by key (a top-level node's parentKey resolves to
 *     the root standing for its caller), and a CLIENT root map's origin rides
 *     down every caller-supplied level (the code a fan-out / depth refusal
 *     carries); the config lang splits a key only where it differs;
 *   - a portal's own config is owned by the ROW's section (configOwnerOf) at
 *     every level — never the ddo's declared first section (PHP
 *     `$current_locator->section_tipo`).
 */

import { describe, expect, test } from 'bun:test';
import type { Ddo } from '../../src/core/concepts/ddo.ts';
import type { EmitRow } from '../../src/core/concepts/emit_row.ts';
import type { ApiNotice } from '../../src/core/errors/schema.ts';
import {
	DEPTH_BOUND_CODE,
	depthBoundNotice,
	directDataChildren,
	nodeListPageLimit,
	occurrenceKey,
	RECORD_CYCLE_CODE,
	recordCycleNotice,
	resolveElement,
	rootNodeFor,
} from '../../src/core/relations/element_node.ts';
import {
	type ElementNode,
	ElementNodeRegistry,
} from '../../src/core/relations/element_registry.ts';
import { ownConfigSectionTipo } from '../../src/core/relations/models/portal.ts';
import { partitionDeepSelfDdos } from '../../src/core/relations/request_config/self_depth.ts';
import { EmissionContext } from '../../src/core/resolve/component_data.ts';

/** A caller-only resolution: no ontology read (explicit model, no own config). */
function resolveCallerOnly(
	registry: ElementNodeRegistry,
	parentNode: ElementNode,
	ddo: Record<string, unknown>,
	mode = 'list',
): Promise<ElementNode> {
	return resolveElement({
		ddo: ddo as unknown as Ddo,
		parentNode,
		ownerSectionTipo: 'zzu1',
		mode,
		lang: 'lg-nolan',
		registry,
		model: 'component_portal',
		useOwnConfig: false,
	});
}

/** The root of a two-level caller map: P (self) → B, C. */
function twoLevelRoot(registry: ElementNodeRegistry, map?: Ddo[]): ElementNode {
	const ddoMap =
		map ??
		([
			{ tipo: 'zzu2', parent: 'self', section_tipo: 'zzu1' },
			{ tipo: 'zzu4', parent: 'zzu2', section_tipo: 'zzu3' },
			{ tipo: 'zzu5', parent: 'zzu2', section_tipo: 'zzu3' },
		] as unknown as Ddo[]);
	return rootNodeFor(registry, 'zzu1', 'zzu1', 'list', ddoMap);
}

const tipos = (ddos: readonly Record<string, unknown>[]): unknown[] => ddos.map((d) => d.tipo);

describe('ElementNodeRegistry scope', () => {
	test('one registry per EmissionContext; a TM fork shares it by reference', () => {
		const first = new EmissionContext([]);
		const second = new EmissionContext([]);
		expect(first.nodes).toBeInstanceOf(ElementNodeRegistry);
		expect(second.nodes).not.toBe(first.nodes);
		const fork = first.fork(null);
		expect(fork).not.toBe(first);
		expect(fork.nodes).toBe(first.nodes);
		expect(fork.items).toBe(first.items);
	});

	test('an empty caller map is ONE root per (caller, section, mode), whatever array carries it', () => {
		const registry = new ElementNodeRegistry();
		const one = rootNodeFor(registry, 'zzu1', 'zzu1', 'list', []);
		expect(rootNodeFor(registry, 'zzu1', 'zzu1', 'list', [])).toBe(one);
		expect(rootNodeFor(registry, 'zzu1', 'zzu1', 'edit', [])).not.toBe(one);
		expect(rootNodeFor(registry, 'zzu2', 'zzu1', 'list', [])).not.toBe(one);
		expect(one.children).toEqual([]);
	});

	test('memo builds once; a failed build is forgotten, not cached', async () => {
		const registry = new ElementNodeRegistry();
		const root = twoLevelRoot(registry);
		let builds = 0;
		const build = async (): Promise<ElementNode> => {
			builds += 1;
			return { ...root, key: 'k' };
		};
		const [a, b] = await Promise.all([registry.memo('k', build), registry.memo('k', build)]);
		expect(builds).toBe(1);
		expect(a).toBe(b);
		expect(registry.nodeByKey('k')).toBe(a);

		let attempts = 0;
		const failing = async (): Promise<ElementNode> => {
			attempts += 1;
			if (attempts === 1) throw new Error('boom');
			return { ...root, key: 'f' };
		};
		await expect(registry.memo('f', failing)).rejects.toThrow('boom');
		const retried = await registry.memo('f', failing);
		expect(attempts).toBe(2);
		expect(retried.key).toBe('f');
	});

	test('rootFor builds one root per map object', () => {
		const registry = new ElementNodeRegistry();
		const map = [{ tipo: 'zzu2', parent: 'self' }] as unknown as Ddo[];
		const one = rootNodeFor(registry, 'zzu1', 'zzu1', 'list', map);
		expect(rootNodeFor(registry, 'zzu1', 'zzu1', 'list', map)).toBe(one);
		const other = rootNodeFor(registry, 'zzu1', 'zzu1', 'list', [...map]);
		expect(other).not.toBe(one);
		expect(other.key).not.toBe(one.key);
		expect(one.configSource).toBe('root');
		expect(tipos(one.children)).toEqual(['zzu2']);
	});
});

describe('resolveElement (caller-only, no ontology)', () => {
	test('an element with no own config takes its caller children, in caller order', async () => {
		const registry = new ElementNodeRegistry();
		const node = await resolveCallerOnly(registry, twoLevelRoot(registry), {
			tipo: 'zzu2',
			section_tipo: 'zzu1',
		});
		expect(node.configSource).toBe('caller');
		expect(node.injected).toBe(true);
		expect(node.children).toHaveLength(2);
		expect(tipos(node.children)).toEqual(['zzu4', 'zzu5']);
		expect(node.children.every((child) => child.parent === 'zzu2')).toBe(true);
	});

	test("only the caller's DEDALO children become a config-less element's config", async () => {
		const registry = new ElementNodeRegistry();
		const parent: ElementNode = {
			...twoLevelRoot(registry),
			key: 'two-engine-parent',
			effectiveConfig: [
				{
					api_engine: 'zenon',
					type: 'main',
					show: { ddo_map: [{ tipo: 'zzu6', parent: 'zzu2', section_tipo: 'zzu3' }] },
				},
				{
					api_engine: 'dedalo',
					type: 'main',
					show: { ddo_map: [{ tipo: 'zzu4', parent: 'zzu2', section_tipo: 'zzu3' }] },
				},
			] as never,
		};
		const node = await resolveCallerOnly(registry, parent, { tipo: 'zzu2', section_tipo: 'zzu1' });
		expect(node.effectiveConfig).toHaveLength(1);
		expect(node.effectiveConfig[0]?.api_engine).toBe('dedalo');
		expect(tipos(node.children)).toEqual(['zzu4']);
		// A caller naming only non-dedalo children leaves it childless.
		const zenonOnly: ElementNode = {
			...parent,
			key: 'zenon-parent',
			effectiveConfig: [parent.effectiveConfig[0]] as never,
		};
		const bare = await resolveCallerOnly(registry, zenonOnly, {
			tipo: 'zzu2',
			section_tipo: 'zzu1',
		});
		expect(bare.effectiveConfig).toEqual([]);
		expect(bare.children).toEqual([]);
	});

	test('the governing limit lands on sqo.limit (only) and is the list page', async () => {
		const registry = new ElementNodeRegistry();
		const node = await resolveCallerOnly(registry, twoLevelRoot(registry), {
			tipo: 'zzu2',
			section_tipo: 'zzu1',
			limit: 3,
		});
		expect(node.limit).toBe(3);
		expect(node.effectiveConfig).toHaveLength(1);
		expect((node.effectiveConfig[0]?.sqo as { limit?: unknown }).limit).toBe(3);
		// Never synthesised onto a show.sqo_config the config does not declare.
		expect(
			(node.effectiveConfig[0]?.show as { sqo_config?: unknown } | null | undefined)?.sqo_config,
		).toBeUndefined();
		expect(nodeListPageLimit(node)).toBe(3);
		// A non-positive / non-integer limit governs nothing.
		const ignored = await resolveCallerOnly(registry, twoLevelRoot(registry), {
			tipo: 'zzu2',
			section_tipo: 'zzu1',
			limit: 0,
		});
		expect(ignored.limit).toBeNull();
		expect(nodeListPageLimit(ignored)).toBeNull();
	});

	test('keys are per parent occurrence: same tipo under two parents is two nodes', async () => {
		const registry = new ElementNodeRegistry();
		const rootA = twoLevelRoot(registry);
		const rootB = twoLevelRoot(registry, [
			{ tipo: 'zzu2', parent: 'self', section_tipo: 'zzu1' },
			{ tipo: 'zzu6', parent: 'zzu2', section_tipo: 'zzu3' },
		] as unknown as Ddo[]);
		const underA = await resolveCallerOnly(registry, rootA, { tipo: 'zzu2', section_tipo: 'zzu1' });
		const underB = await resolveCallerOnly(registry, rootB, { tipo: 'zzu2', section_tipo: 'zzu1' });
		expect(underA.key).not.toBe(underB.key);
		expect(underA.parentKey).toBe(rootA.key);
		expect(underB.parentKey).toBe(rootB.key);
		expect(tipos(underA.children)).toEqual(['zzu4', 'zzu5']);
		expect(tipos(underB.children)).toEqual(['zzu6']);
		// Same parent, same ddo: memoised.
		const again = await resolveCallerOnly(registry, rootA, { tipo: 'zzu2', section_tipo: 'zzu1' });
		expect(again).toBe(underA);
		expect(registry.nodes()).toHaveLength(2);
	});

	test('keys carry lang and the governing fields: another view or lang is another node', async () => {
		const registry = new ElementNodeRegistry();
		const root = twoLevelRoot(registry);
		const plain = await resolveCallerOnly(registry, root, { tipo: 'zzu2', section_tipo: 'zzu1' });
		const mini = await resolveCallerOnly(registry, root, {
			tipo: 'zzu2',
			section_tipo: 'zzu1',
			view: 'mini',
		});
		expect(mini).not.toBe(plain);
		expect(mini.view).toBe('mini');
		expect(plain.view).toBeNull();
		const otherLang = await resolveElement({
			ddo: { tipo: 'zzu2', section_tipo: 'zzu1' } as unknown as Ddo,
			parentNode: root,
			ownerSectionTipo: 'zzu1',
			mode: 'list',
			lang: 'lg-spa',
			registry,
			model: 'component_portal',
			useOwnConfig: false,
		});
		expect(otherLang).not.toBe(plain);
		expect(otherLang.lang).toBe('lg-spa');
		// Same fields in another key order: the same node.
		const a = await resolveCallerOnly(registry, root, {
			tipo: 'zzu2',
			section_tipo: 'zzu1',
			properties: { a: 1, b: 2 },
		});
		const b = await resolveCallerOnly(registry, root, {
			tipo: 'zzu2',
			section_tipo: 'zzu1',
			properties: { b: 2, a: 1 },
		});
		expect(b).toBe(a);
	});

	test('a grandchild collects its children through its parent node', async () => {
		const registry = new ElementNodeRegistry();
		const root = twoLevelRoot(registry, [
			{ tipo: 'zzu2', parent: 'self', section_tipo: 'zzu1' },
			{ tipo: 'zzu4', parent: 'zzu2', section_tipo: 'zzu3' },
			{ tipo: 'zzu7', parent: 'zzu4', section_tipo: 'zzu8' },
		] as unknown as Ddo[]);
		const mid = await resolveCallerOnly(registry, root, { tipo: 'zzu2', section_tipo: 'zzu1' });
		const leaf = await resolveCallerOnly(registry, mid, { tipo: 'zzu4', section_tipo: 'zzu3' });
		expect(tipos(leaf.children)).toEqual(['zzu7']);
		expect(leaf.key.startsWith(`${mid.key}>`)).toBe(true);
	});

	test("mode 'solved' resolves no data children", async () => {
		const registry = new ElementNodeRegistry();
		const node = await resolveCallerOnly(
			registry,
			twoLevelRoot(registry),
			{ tipo: 'zzu2', section_tipo: 'zzu1' },
			'solved',
		);
		expect(node.effectiveConfig.length).toBeGreaterThan(0);
		expect(node.children).toEqual([]);
	});

	test('governing ddo fields ride the node — a declared permissions does not', async () => {
		const registry = new ElementNodeRegistry();
		const node = await resolveCallerOnly(registry, twoLevelRoot(registry), {
			tipo: 'zzu2',
			section_tipo: 'zzu1',
			view: 'mini',
			parent_grouper: 'zzu9',
			permissions: 1,
			properties: { css: {} },
		});
		expect(node.view).toBe('mini');
		expect(node.parent_grouper).toBe('zzu9');
		// W4 (d): the level is computed (section/node_permissions.ts), never a
		// declared (client-settable) ddo number — PHP get_subdatum never reads it.
		expect('permissions' in node).toBe(false);
		expect(node.properties).toEqual({ css: {} });
	});
});

describe('roots and child-map origin', () => {
	test("a top-level node's parentKey resolves to its ROOT (nodeByKey), whose tipo is the caller", async () => {
		const registry = new ElementNodeRegistry();
		const root = twoLevelRoot(registry);
		const empty = rootNodeFor(registry, 'zzu9', 'zzu1', 'edit', []);
		const top = await resolveCallerOnly(registry, root, { tipo: 'zzu2', section_tipo: 'zzu1' });
		expect(registry.nodeByKey(top.parentKey as string)).toBe(root);
		expect(registry.nodeByKey(top.parentKey as string)?.tipo).toBe('zzu1');
		expect(registry.nodeByKey(empty.key)).toBe(empty);
		expect(registry.rootNodes()).toEqual([root, empty]);
		// Roots are not element nodes: nodes() lists only resolved elements.
		expect(registry.nodes()).toEqual([top]);
	});

	test("a CLIENT root map's origin rides down every caller-supplied level", async () => {
		const registry = new ElementNodeRegistry();
		registry.rootOrigin = 'client';
		const root = twoLevelRoot(registry, [
			{ tipo: 'zzu2', parent: 'self', section_tipo: 'zzu1' },
			{ tipo: 'zzu4', parent: 'zzu2', section_tipo: 'zzu3' },
			{ tipo: 'zzu7', parent: 'zzu4', section_tipo: 'zzu8' },
		] as unknown as Ddo[]);
		expect(root.childOrigin).toBe('client');
		const mid = await resolveCallerOnly(registry, root, { tipo: 'zzu2', section_tipo: 'zzu1' });
		const leaf = await resolveCallerOnly(registry, mid, { tipo: 'zzu4', section_tipo: 'zzu3' });
		expect(mid.childOrigin).toBe('client');
		expect(leaf.childOrigin).toBe('client');
	});

	test('a derived (ontology) root map stays ontology-owned all the way down', async () => {
		const registry = new ElementNodeRegistry();
		const root = twoLevelRoot(registry);
		const mid = await resolveCallerOnly(registry, root, { tipo: 'zzu2', section_tipo: 'zzu1' });
		expect(root.childOrigin).toBe('ontology');
		expect(mid.childOrigin).toBe('ontology');
	});

	test('the config lang splits the key only where it differs from the instance lang', async () => {
		const registry = new ElementNodeRegistry();
		const root = twoLevelRoot(registry);
		const resolveIn = (configLang?: string) =>
			resolveElement({
				ddo: { tipo: 'zzu2', section_tipo: 'zzu1' } as unknown as Ddo,
				parentNode: root,
				ownerSectionTipo: 'zzu1',
				mode: 'list',
				lang: 'lg-nolan',
				...(configLang !== undefined ? { configLang } : {}),
				registry,
				model: 'component_portal',
				useOwnConfig: false,
			});
		const plain = await resolveIn();
		expect(await resolveIn('lg-nolan')).toBe(plain);
		const spa = await resolveIn('lg-spa');
		expect(spa).not.toBe(plain);
		// node.lang stays the INSTANCE lang; only the own build follows configLang.
		expect(spa.lang).toBe('lg-nolan');
	});
});

describe('root map deep-self refusal', () => {
	test("a level >= 2 'self' ddo is refused with a notice; the rest stands", () => {
		const registry = new ElementNodeRegistry();
		const root = rootNodeFor(registry, 'zzu1', 'zzu1', 'list', [
			{ tipo: 'zzu2', parent: 'self', section_tipo: 'zzu1' },
			{ tipo: 'zzu4', parent: 'zzu2', section_tipo: 'zzu3' },
			{ tipo: 'zzu5', parent: 'zzu4', section_tipo: 'self' },
		] as unknown as Ddo[]);
		const map = (root.effectiveConfig[0]?.show?.ddo_map ?? []) as Record<string, unknown>[];
		expect(tipos(map)).toEqual(['zzu2', 'zzu4']);
		const notices = registry.notices();
		expect(notices.length).toBeGreaterThan(0);
		expect(notices[0]?.code).toBe('ontology.ddo_self_refused');
	});
});

describe('notices', () => {
	const notice = (tipo: string, more = 0): ApiNotice => ({
		code: RECORD_CYCLE_CODE,
		label_key: 'error_relation_record_cycle_stopped',
		retryable: false,
		details: { tipo, section_tipo: 'zzu1', section_id: '1', depth: 1, more },
	});

	test('dedup by (code, details minus more)', () => {
		const registry = new ElementNodeRegistry();
		registry.addNotices([notice('a'), notice('a', 4), notice('b')]);
		expect(registry.notices()).toHaveLength(2);
	});

	test('past 5 distinct per code, the overflow folds into the last kept `more`', () => {
		const registry = new ElementNodeRegistry();
		registry.addNotices(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((t) => notice(t)));
		registry.addNotices([notice('h', 2)]);
		const kept = registry.notices();
		expect(kept).toHaveLength(5);
		// f, g (1 each) + h (1 + its own 2) = 5
		expect(kept[4]?.details?.more).toBe(5);
		expect(kept[0]?.details?.more).toBe(0);
	});

	test('a repeat of an already-folded notice is not counted again', () => {
		const registry = new ElementNodeRegistry();
		registry.addNotices(['a', 'b', 'c', 'd', 'e', 'f'].map((t) => notice(t)));
		expect(registry.notices()[4]?.details?.more).toBe(1);
		// f again (the same owner resolved under N parent occurrences pushes the
		// same notice N times), with and without its own `more`: still 1.
		registry.addNotices([notice('f'), notice('f'), notice('f', 3)]);
		const kept = registry.notices();
		expect(kept).toHaveLength(5);
		expect(kept[4]?.details?.more).toBe(1);
		// A NEW distinct notice still folds.
		registry.addNotices([notice('g')]);
		expect(registry.notices()[4]?.details?.more).toBe(2);
	});

	test('two self_depth batches of 7 into one registry: 5 kept, the hidden count is exact (9)', () => {
		// Each owner refuses 7 distinct ddos at level 2 → 5 notices per batch, the
		// batch remainder (2) on the last one only. Folded together the registry
		// must count every hidden refusal exactly once: 10 + 4 - 5 = 9.
		const batch = (owner: string) => {
			const map: { tipo: string; parent: string; section_tipo: string }[] = [
				{ tipo: 'A', parent: 'self', section_tipo: 'zzu3' },
			];
			for (let index = 1; index <= 7; index++) {
				map.push({ tipo: `B${index}`, parent: 'A', section_tipo: 'self' });
			}
			return partitionDeepSelfDdos(owner, map).notices;
		};
		const registry = new ElementNodeRegistry();
		registry.addNotices(batch('P1'));
		registry.addNotices(batch('P2'));
		const kept = registry.notices();
		expect(kept).toHaveLength(5);
		const hidden = kept.reduce((sum, entry) => sum + Number(entry.details?.more ?? 0), 0);
		expect(hidden).toBe(9);
	});

	test('recordCycleNotice is the registered code with capped fields', async () => {
		const long = 'x'.repeat(200);
		const built = await recordCycleNotice({ section_tipo: long, section_id: 7 }, 'zzu2', 3);
		expect(built.code).toBe(RECORD_CYCLE_CODE);
		expect(built.label_key).toBe('error_relation_record_cycle_stopped');
		expect(String(built.details?.section_tipo).length).toBeLessThanOrEqual(65);
		expect(built.details?.section_id).toBe('7');
		expect(built.details?.depth).toBe(3);
		expect(occurrenceKey({ section_tipo: 'zzu1', section_id: 7 }, 'zzu2')).toBe('zzu1|7|zzu2');
	});
});

describe('depth-bound notice', () => {
	test('depthBoundNotice is the registered code with capped fields', async () => {
		const built = await depthBoundNotice(
			{ section_tipo: 'zzu1', section_id: 7 },
			'z'.repeat(99),
			12,
		);
		expect(built.code).toBe(DEPTH_BOUND_CODE);
		expect(built.label_key).toBe('error_relation_depth_bound_stopped');
		expect(String(built.details?.tipo).length).toBeLessThanOrEqual(65);
		expect(built.details?.depth).toBe(12);
	});
});

describe('ownConfigSectionTipo (models/portal.ts)', () => {
	test("every element is owned by the ROW's section, never the ddo's declared first", () => {
		// A multi-section read hands ONE column ddo (section_tipo [zzu3, zzu8]
		// reduced to its first) to every row: an fr1-like row is owned by itself.
		expect(ownConfigSectionTipo({ section_tipo: 'zzu8', section_id: 4 })).toBe('zzu8');
		expect(ownConfigSectionTipo({ section_tipo: 'zzu1', section_id: 1 })).toBe('zzu1');
	});
	test('a host row (dd15) is owned by the record it stands for', () => {
		const hostRow: EmitRow = {
			section_tipo: 'dd15',
			section_id: 9,
			config_owner: { section_tipo: 'zzu5', section_id: 2 },
		};
		expect(ownConfigSectionTipo(hostRow)).toBe('zzu5');
	});
});

describe('directDataChildren', () => {
	test('show AND hide, flattened; self resolved; grandchildren excluded', () => {
		const children = directDataChildren('zzu2', [
			{
				api_engine: 'dedalo',
				show: {
					ddo_map: [
						{ tipo: 'zzu4', parent: 'self', section_tipo: 'zzu3' },
						{ tipo: 'zzu7', parent: 'zzu4', section_tipo: 'zzu8' },
					],
				},
				hide: { ddo_map: [{ tipo: 'zzu5', parent: 'zzu2', section_tipo: 'zzu3' }] },
			},
		]);
		expect(children).toHaveLength(2);
		expect(tipos(children)).toEqual(['zzu4', 'zzu5']);
		expect(children.every((child) => child.parent === 'zzu2')).toBe(true);
	});
});
