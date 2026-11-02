/**
 * THE ONE MIRROR MERGE — pure gate (section/record/external_laws/merge.ts).
 *
 * 'stored' order is law (c)'s merge, MOVED from observers.ts mirrorAdditions:
 * it must stay byte-identical (kept entries verbatim in stored order,
 * duplicates included; additions appended with the next ids in the exact
 * historical key order). 'desired' order is the copy laws': the law's order
 * is the value, the mirror owns its item ids (a type switch never inherits the
 * source's ids), every desired key but id/from_component_tipo survives
 * (critique 2), and an item equal to its stored twin up to key order is
 * re-emitted VERBATIM — the property that keeps a no-drift recompute from
 * writing a TM row every time (jsonb normalizes key order on read).
 */

import { describe, expect, test } from 'bun:test';
import {
	mergeMirror,
	nextObserverItemId,
} from '../../src/core/section/record/external_laws/merge.ts';
import type { StoredLocator } from '../../src/core/section/record/external_laws/types.ts';

const OBS = 'zzxmmobs1';
const opts = { fallbackType: 'dd151' };

describe('nextObserverItemId', () => {
	test('max finite id + 1; malformed ids never NaN-poison it', () => {
		expect(nextObserverItemId([])).toBe(1);
		expect(nextObserverItemId([{ id: 3 }, { id: 'x' }, { id: 7 }, {}])).toBe(8);
		expect(nextObserverItemId([{ id: Number.NaN }, { id: null }])).toBe(1);
	});
});

describe("mergeMirror 'stored' (law (c), byte-identical)", () => {
	const existing: StoredLocator[] = [
		{ id: 1, type: 'dd151', section_id: 10, section_tipo: 'zzxmma1', from_component_tipo: OBS },
		{ id: 2, type: 'dd151', section_id: '11', section_tipo: 'zzxmma1', from_component_tipo: OBS },
		{ id: 4, type: 'dd151', section_id: 12, section_tipo: 'zzxmma1', from_component_tipo: OBS },
	];

	test('kept verbatim in stored order (string ids match their int), additions appended with next ids', () => {
		const result = mergeMirror(
			existing,
			[
				{ section_tipo: 'zzxmma1', section_id: 13 },
				{ section_tipo: 'zzxmma1', section_id: 11 },
				{ section_tipo: 'zzxmma1', section_id: 10 },
				{ section_tipo: 'zzxmma1', section_id: 13 },
			],
			OBS,
			'stored',
			opts,
		);
		expect(result.kept[0]).toBe(existing[0] as StoredLocator);
		expect(result.kept[1]).toBe(existing[1] as StoredLocator);
		expect(JSON.stringify(result.merged)).toBe(
			JSON.stringify([
				existing[0],
				existing[1],
				{ id: 5, type: 'dd151', section_id: 13, section_tipo: 'zzxmma1', from_component_tipo: OBS },
			]),
		);
		expect(result.additions).toHaveLength(1);
	});

	test('stored duplicates are both kept (the historical law), never re-added', () => {
		const duplicated: StoredLocator[] = [
			{ id: 1, section_id: 10, section_tipo: 'zzxmma1' },
			{ id: 2, section_id: 10, section_tipo: 'zzxmma1' },
		];
		const result = mergeMirror(
			duplicated,
			[{ section_tipo: 'zzxmma1', section_id: 10 }],
			OBS,
			'stored',
			opts,
		);
		expect(result.merged).toEqual(duplicated);
		expect(result.additions).toEqual([]);
	});

	test('a stored entry no longer desired is dropped; a non-convertible remote id survives verbatim', () => {
		const result = mergeMirror(
			existing,
			[{ section_tipo: 'zzxmmext1', section_id: 'ext-7' }],
			OBS,
			'stored',
			opts,
		);
		expect(result.kept).toEqual([]);
		expect(result.merged).toEqual([
			{
				id: 5,
				type: 'dd151',
				section_id: 'ext-7',
				section_tipo: 'zzxmmext1',
				from_component_tipo: OBS,
			},
		]);
	});

	test('self-references are kept unless dropSelf is set (law (c) never dropped them)', () => {
		const self = { section_tipo: 'zzxmma1', section_id: 99 };
		expect(mergeMirror([], [self], OBS, 'stored', opts).merged).toHaveLength(1);
		expect(mergeMirror([], [self], OBS, 'stored', { ...opts, dropSelf: self }).merged).toEqual([]);
	});
});

describe("mergeMirror 'desired' (the copy laws)", () => {
	test('the desired order is the value; kept ids stay; new ids pass the stored max', () => {
		const existing: StoredLocator[] = [
			{ id: 1, type: 'dd151', section_id: 10, section_tipo: 'zzxmmc1', from_component_tipo: OBS },
			{ id: 6, type: 'dd151', section_id: 11, section_tipo: 'zzxmmc1', from_component_tipo: OBS },
		];
		const result = mergeMirror(
			existing,
			[
				{ section_tipo: 'zzxmmc1', section_id: 12, type: 'dd151' },
				{ section_tipo: 'zzxmmc1', section_id: 11, type: 'dd151' },
				{ section_tipo: 'zzxmmc1', section_id: 10, type: 'dd151' },
			],
			OBS,
			'desired',
			opts,
		);
		expect(result.merged.map((item) => [item.section_id, item.id])).toEqual([
			[12, 7],
			[11, 6],
			[10, 1],
		]);
		expect(result.kept.map((item) => item.id)).toEqual([6, 1]);
		expect(result.additions.map((item) => item.id)).toEqual([7]);
	});

	test("the source's id and from_component_tipo are replaced; every other key survives (critique 2)", () => {
		const result = mergeMirror(
			[],
			[
				{
					id: 41,
					type: 'dd151',
					section_id: '86',
					section_tipo: 'zzxmmsym1',
					component_tipo: 'zzxmmimg1',
					from_component_tipo: 'zzxmmsource1',
				},
			],
			OBS,
			'desired',
			opts,
		);
		expect(JSON.stringify(result.merged)).toBe(
			JSON.stringify([
				{
					id: 1,
					type: 'dd151',
					section_id: 86,
					section_tipo: 'zzxmmsym1',
					component_tipo: 'zzxmmimg1',
					from_component_tipo: OBS,
				},
			]),
		);
	});

	test('a kept item equal up to key order is re-emitted VERBATIM (no-drift stays no-drift)', () => {
		// jsonb hands keys back in its own order — never the order we built.
		const stored: StoredLocator = {
			id: 3,
			type: 'dd151',
			section_id: 86,
			section_tipo: 'zzxmmsym1',
			component_tipo: 'zzxmmimg1',
			from_component_tipo: OBS,
		};
		const reordered: StoredLocator = {
			from_component_tipo: OBS,
			section_tipo: 'zzxmmsym1',
			component_tipo: 'zzxmmimg1',
			id: 3,
			type: 'dd151',
			section_id: 86,
		};
		for (const existingItem of [stored, reordered]) {
			const result = mergeMirror(
				[existingItem],
				[
					{
						section_tipo: 'zzxmmsym1',
						section_id: '86',
						component_tipo: 'zzxmmimg1',
						type: 'dd151',
						id: 99,
					},
				],
				OBS,
				'desired',
				opts,
			);
			expect(result.merged[0]).toBe(existingItem);
			expect(JSON.stringify(result.merged)).toBe(JSON.stringify([existingItem]));
		}
	});

	test('a kept item that differs is rebuilt with its stored id (legacy string id → canonical int)', () => {
		const stored: StoredLocator = {
			id: 3,
			type: 'dd151',
			section_id: '86',
			section_tipo: 'zzxmmsym1',
			from_component_tipo: OBS,
		};
		const result = mergeMirror(
			[stored],
			[{ section_tipo: 'zzxmmsym1', section_id: '86' }],
			OBS,
			'desired',
			opts,
		);
		expect(result.merged[0]).not.toBe(stored);
		expect(result.merged).toEqual([
			{ id: 3, type: 'dd151', section_id: 86, section_tipo: 'zzxmmsym1', from_component_tipo: OBS },
		]);
		expect(result.kept).toHaveLength(1);
	});

	test('type switch A→B: every B item gets a fresh id past A — no stale id survives', () => {
		const typeA: StoredLocator[] = [
			{ id: 1, type: 'dd151', section_id: 1, section_tipo: 'zzxmmc1', from_component_tipo: OBS },
			{ id: 2, type: 'dd151', section_id: 2, section_tipo: 'zzxmmc1', from_component_tipo: OBS },
		];
		const result = mergeMirror(
			typeA,
			[
				{ id: 1, section_tipo: 'zzxmmc1', section_id: 8 },
				{ id: 2, section_tipo: 'zzxmmc1', section_id: 9 },
			],
			OBS,
			'desired',
			opts,
		);
		expect(result.merged.map((item) => item.id)).toEqual([3, 4]);
		expect(result.kept).toEqual([]);
	});

	test('type falls back per item; desired duplicates and self are dropped; malformed items skipped', () => {
		const self = { section_tipo: 'zzxmmterm1', section_id: 5 };
		const result = mergeMirror(
			[],
			[
				{ section_tipo: 'zzxmmc1', section_id: 1, type: 'dd96' },
				{ section_tipo: 'zzxmmc1', section_id: 2 },
				{ section_tipo: 'zzxmmc1', section_id: '1' },
				{ section_tipo: 'zzxmmterm1', section_id: 5 },
				{ section_tipo: '', section_id: 3 },
				{ section_tipo: 'zzxmmc1' } as unknown as { section_tipo: string; section_id: number },
				null as unknown as { section_tipo: string; section_id: number },
			],
			OBS,
			'desired',
			{ fallbackType: 'dd675', dropSelf: self },
		);
		expect(result.merged.map((item) => [item.section_id, item.type])).toEqual([
			[1, 'dd96'],
			[2, 'dd675'],
		]);
	});

	test('a stored duplicate id is never handed out twice (ids pair frames)', () => {
		const existing: StoredLocator[] = [
			{ id: 4, section_id: 1, section_tipo: 'zzxmmc1' },
			{ id: 4, section_id: 2, section_tipo: 'zzxmmc1' },
		];
		const result = mergeMirror(
			existing,
			[
				{ section_tipo: 'zzxmmc1', section_id: 1 },
				{ section_tipo: 'zzxmmc1', section_id: 2 },
			],
			OBS,
			'desired',
			opts,
		);
		expect(result.merged.map((item) => item.id)).toEqual([4, 5]);
	});

	test('inputs are never mutated', () => {
		const existing: StoredLocator[] = [{ id: 1, section_id: 1, section_tipo: 'zzxmmc1' }];
		const desired = [
			{ section_tipo: 'zzxmmc1', section_id: '2', id: 9, from_component_tipo: 'zzxmmsrc1' },
		];
		const before = JSON.stringify([existing, desired]);
		mergeMirror(existing, desired, OBS, 'desired', opts);
		mergeMirror(existing, desired, OBS, 'stored', opts);
		expect(JSON.stringify([existing, desired])).toBe(before);
	});
});
