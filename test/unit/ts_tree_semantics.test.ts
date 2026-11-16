/**
 * Tree subsystem — subtle-semantics UNIT tests (plan Workstream A verify list).
 *
 * These cover the pure, DB-free semantics where a wrong port is silent and only
 * a differential would otherwise catch it: number formatting, the order-dataframe
 * id_key priority chain, the shared-$path SQO quirk, and the inline id_key
 * dataframe algebra that backs remove-order masking and sort skip-unchanged.
 * DB-backed semantics (auto-ref, first-locator, count null≠0, homogeneous
 * children, string section_id keys, zero-count suppression, root button perms,
 * diamond/cycle walk) are exercised by the live-PHP differentials.
 */
// Migrated to the generic `test` TLD 2026-08-20 (AGENTS.md hard rules). The one
// install section tipo became its phase-2 clone: every use is an in-memory locator
// key handed to the pure `pickOrderValueForParent`, which compares it as an opaque
// string and never resolves it — this file is DB-free by design.

import { describe, expect, it } from 'bun:test';
import {
	NUMBER_FORMAT_NONE,
	numberFormatOf,
} from '../../src/core/components/component_number/number_format.ts';
import {
	getInlineValueByIdKey,
	removeInlineByIdKey,
	updateInlineValueByIdKey,
} from '../../src/core/relations/dataframe.ts';
import {
	formatNumberValue,
	pickOrderValueForParent,
} from '../../src/core/ts_object/node_repository.ts';
import { getHierarchyTermsSqo } from '../../src/core/ts_object/search.ts';
import { isEmptyData } from '../../src/core/ts_object/ts_object.ts';

describe('formatNumberValue (component_number format law, v6 empty semantics — T1-40)', () => {
	const NONE = NUMBER_FORMAT_NONE;
	const INT = numberFormatOf({ type: 'int' }, 'test1');
	const FLOAT2 = numberFormatOf({ type: 'float', precision: 2 }, 'test1');
	it('null / empty string / false → null', () => {
		expect(formatNumberValue('', NONE)).toBeNull();
		expect(formatNumberValue(null, NONE)).toBeNull();
		expect(formatNumberValue(undefined, NONE)).toBeNull();
		expect(formatNumberValue(false, NONE)).toBeNull();
	});
	it("0 and '0' are the number 0 (v6; frozen v7 nulled '0')", () => {
		expect(formatNumberValue(0, NONE)).toBe(0);
		expect(formatNumberValue('0', NONE)).toBe(0);
		expect(formatNumberValue('0', INT)).toBe(0);
	});
	it('no type: the value as read, unrounded', () => {
		expect(formatNumberValue('3', NONE)).toBe(3);
		expect(formatNumberValue('3.5', NONE)).toBe(3.5);
		expect(formatNumberValue(1.23456, NONE)).toBe(1.23456);
		expect(formatNumberValue('abc', NONE)).toBeNull();
	});
	it("type 'int' truncates", () => {
		expect(formatNumberValue('7.9', INT)).toBe(7);
		expect(formatNumberValue(7.9, INT)).toBe(7);
	});
	it("type 'float' rounds half away from zero to precision (decimal, not toFixed)", () => {
		expect(formatNumberValue('1.23456', FLOAT2)).toBe(1.23);
		expect(formatNumberValue('2', FLOAT2)).toBe(2);
		expect(formatNumberValue(1.005, FLOAT2)).toBe(1.01);
	});
});

describe('pickOrderValueForParent (order dataframe id_key priority chain)', () => {
	const parentItems = [
		{ id: 42, section_tipo: 'test6813', section_id: '10' },
		{ id: 7, section_tipo: 'test6813', section_id: '99' },
	];

	it('1. id_key entry wins over everything else', () => {
		const order = [
			{ value: 'first', id_key: 7 }, // a DIFFERENT parent's entry
			{ value: 'correct', id_key: 42 }, // this parent's link id
		];
		expect(pickOrderValueForParent(order, parentItems, 'test6813', 10)).toBe('correct');
	});

	it('1b. REAL written shape pairs on item `id` (WC-015 — the reorder-reverts bug)', () => {
		// What update_value_by_id_key/addInlineValueByIdKey actually write: {id, value}.
		// dd15 regression shape: a stale entry from an old parent link (id 1) plus the
		// current parent-link pair (id 42). PHP returns 2 (first item); TS must pair.
		const order = [
			{ id: 1, value: 2 },
			{ id: 42, value: 6 },
		];
		expect(pickOrderValueForParent(order, parentItems, 'test6813', 10)).toBe(6);
	});

	it('1c. id-keyed entries are NOT "unkeyed": true unkeyed entry still wins step 3', () => {
		// parent link id 42 matches no entry; the {id:1} entry must not be
		// mistaken for a legacy unkeyed value.
		const order = [{ id: 1, value: 'stale' }, { value: 'unkeyed' }];
		expect(pickOrderValueForParent(order, parentItems, 'test6813', 10)).toBe('unkeyed');
	});

	it('1d. unresolvable parent link (no id on locator) falls back to first entry', () => {
		const bareParents = [{ section_tipo: 'test6813', section_id: '10' }]; // pre-migration: no id
		const order = [
			{ id: 1, value: 3 },
			{ id: 2, value: 6 },
		];
		expect(pickOrderValueForParent(order, bareParents, 'test6813', 10)).toBe(3);
	});

	it('2. section-coords entry when no id_key match', () => {
		const order = [
			{ value: 'legacy', section_tipo_key: 'test6813', section_id_key: 10 },
			{ value: 'other', id_key: 999 },
		];
		expect(pickOrderValueForParent(order, parentItems, 'test6813', 10)).toBe('legacy');
	});

	it('3. legacy unkeyed single value', () => {
		const order = [{ value: 'single' }];
		expect(pickOrderValueForParent(order, parentItems, 'test6813', 10)).toBe('single');
	});

	it('fallback: first entry when nothing resolves', () => {
		const order = [
			{ value: 'x', id_key: 111 },
			{ value: 'y', id_key: 222 },
		];
		// parent link id (42) has no matching id_key entry, no section-coords, no unkeyed
		expect(pickOrderValueForParent(order, parentItems, 'test6813', 10)).toBe('x');
	});

	it('empty order items → null', () => {
		expect(pickOrderValueForParent([], parentItems, 'test6813', 10)).toBeNull();
	});
});

describe('getHierarchyTermsSqo (shared-$path mutation quirk — parity, not "fixed")', () => {
	it('every OR group path.section_tipo equals the LAST node (shared object ref)', () => {
		const sqo = getHierarchyTermsSqo([
			{ value: [{ section_tipo: 'aa1', section_id: 5 }] },
			{ value: [{ section_tipo: 'bb2', section_id: 9 }] },
		]);
		const or = (
			sqo.filter as { $or: { $and: { q: unknown; path: { section_tipo?: string }[] }[] }[] }
		).$or;
		expect(or).toHaveLength(2);
		// The id-path object is a single shared reference mutated per iteration, so
		// BOTH groups serialize with the LAST node's section_tipo ('bb2').
		expect(or[0]?.$and[0]?.path[0]?.section_tipo).toBe('bb2');
		expect(or[1]?.$and[0]?.path[0]?.section_tipo).toBe('bb2');
		// The q (section_id) values are still per-node though.
		expect(or[0]?.$and[0]?.q).toBe(5);
		expect(or[1]?.$and[0]?.q).toBe(9);
		// section_tipo list collects both nodes; limit is the 100 safety cap.
		expect(sqo.section_tipo).toEqual(['aa1', 'bb2']);
		expect(sqo.limit).toBe(100);
	});
});

describe('inline id_key dataframe algebra (backs remove-order masking + sort skip)', () => {
	it('removeInlineByIdKey drops only the paired item (remove-order masking source)', () => {
		const items = [
			{ id: 3, value: 1 },
			{ id: 5, value: 2 },
		];
		expect(removeInlineByIdKey(items, 5)).toEqual([{ id: 3, value: 1 }]);
		// unresolved id_key → nothing removed (the no-op masking case)
		expect(removeInlineByIdKey(items, 99)).toEqual(items);
	});

	it('updateInlineValueByIdKey updates in place, else appends (sort write path)', () => {
		const items = [{ id: 3, value: 1 }];
		expect(updateInlineValueByIdKey(items, 8, 3)).toEqual([{ id: 3, value: 8 }]);
		expect(updateInlineValueByIdKey(items, 8, 9)).toEqual([
			{ id: 3, value: 1 },
			{ value: 8, id: 9 },
		]);
	});

	it('getInlineValueByIdKey reads the paired value (skip-unchanged comparison source)', () => {
		const items = [
			{ id: 3, value: 2 },
			{ id: 5, value: 4 },
		];
		// sort_children skips when (int)current === order; this read feeds that check.
		expect(getInlineValueByIdKey(items, 5)).toBe(4);
		expect(getInlineValueByIdKey(items, 99)).toBeNull();
	});
});

describe('isEmptyData — the icon empty-skip test (PHP is_empty + WC-029)', () => {
	// Verified against the PHP oracle (shared/core_functions.php is_empty):
	// these are the cases PHP itself calls empty, so the icon is suppressed.
	it('is PHP-faithful on scalars, pseudo-empty strings and nested arrays', () => {
		expect(isEmptyData([])).toBe(true);
		expect(isEmptyData([''])).toBe(true);
		expect(isEmptyData(['   '])).toBe(true);
		expect(isEmptyData(['<p></p>'])).toBe(true); // strip_tags + trim
		expect(isEmptyData([0])).toBe(true);
		expect(isEmptyData(['0'])).toBe(true);
		expect(isEmptyData([null])).toBe(true);
		expect(isEmptyData([[], {}])).toBe(true);

		expect(isEmptyData(['x'])).toBe(false);
		expect(isEmptyData([1])).toBe(false);
		expect(isEmptyData(['<p>text</p>'])).toBe(false);
	});

	// WC-029: PHP calls ANY object with ANY property non-empty, so a cleared
	// component keeps its {id, value:null} wrapper and its icon renders forever
	// (empty 'properties' still showing the ontology-tree 'P'). A wrapper is
	// judged by its VALUE; id/lang are pairing metadata, never content.
	it('judges a {id, lang, value} data item by its value alone (divergence)', () => {
		expect(isEmptyData([{ id: 1, value: null }])).toBe(true);
		expect(isEmptyData([{ id: 1, value: '' }])).toBe(true);
		expect(isEmptyData([{ id: 1, lang: 'lg-nolan', value: '  ' }])).toBe(true);
		expect(isEmptyData([{ id: 1, value: {} }])).toBe(true);

		expect(isEmptyData([{ id: 1, value: { css: 1 } }])).toBe(false);
		expect(isEmptyData([{ id: 1, value: 'dd' }])).toBe(false);
	});

	it('keeps a locator (no `value` key) non-empty when any property has content', () => {
		expect(isEmptyData([{ section_tipo: 'dd128', section_id: '-1', type: 'dd151' }])).toBe(false);
		expect(isEmptyData([{ section_tipo: '', section_id: null }])).toBe(true);
	});
});
