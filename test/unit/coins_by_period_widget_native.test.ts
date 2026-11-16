/**
 * get_coins_by_period widget — TS-NATIVE unit gate for the four pure seams of
 * src/core/components/component_info/widgets/numisdata/get_coins_by_period.ts.
 *
 * WHY THIS FILE EXISTS. The widget's only other gates are the two goldens in
 * info_widget_native.test.ts, and they assert almost nothing about this logic:
 * the test DB carries no test1026 chronology, so the "passing" one is a degenerate
 * all-'?' result (every coin falls to the catch-all) and the routing, the
 * parent roll-up and the array_filter wire shape are never exercised. These
 * cases are pure: no DB, no network, no fixtures.
 *
 * The four seams (extracted + rewired, no behaviour change except the two
 * cycle guards named below):
 *   routeCoinsToPeriods      — counts coins onto terms, returns the '?' total
 *   buildPeriodValue         — the PHP array_filter key-preservation wire shape
 *   expandHierarchyChildren  — DFS flatten + parent stamps (+ PATH-SCOPED guard)
 *   findParentWithModel      — upward model walk (+ call-scoped guard)
 *
 * BEHAVIOUR CHANGES pinned here (the only ones authorized for this item):
 *  1. expandHierarchyChildren's cycle guard. It is PATH-SCOPED on purpose —
 *     added before descending, DELETED on the way back. A term reachable from
 *     two roots (or from two disjoint branches) is LEGITIMATELY expanded
 *     twice; a traversal-global Set would silently de-duplicate a diamond and
 *     DROP REAL PERIODS. The diamond tests below are what stop the guard from
 *     regressing into a de-duplicator — they are not optional.
 *  2. findParentWithModel's call-scoped guard. A single upward walk cannot
 *     learn anything new from a term it already visited, so returning null on
 *     a loop is safe: under use_parent that null routes the coin to '?',
 *     exactly like a term with no matching-model ancestor.
 * Before both guards a curator-made loop in hierarchy49 / the parent chain was
 * an unbounded recursion (stack overflow, 500).
 *
 * LOCATOR LAW (T1-11, WC-2026-11-12-numisdata-widgets-locator-law). Every
 * locator match in this widget — coin period → term, tree child → row, parent
 * stamp → term — goes through concepts/locator.ts compareLocators: section_tipo
 * strict, section_id LOOSE (int 187 == "187"). Stored locators are INT since
 * WC-2026-08-10-section-id-int-canonical while legacy string ones survive
 * (unmigrated installs, TM, old backups), so a strict === made the widget
 * route EVERY coin to '?' on int data. The flag convention ("duplicated" set
 * when the first locator's section_id is 2) is the same loose compare
 * (isFlagSet, widget_common.ts). The use_parent model is the FIRST hierarchy27
 * locator (v6 semantics — resolveModelSectionId); the frozen PHP v7 is_object()
 * check never matched an array-stored model and is a regression, not a contract.
 */
// Migrated to the generic `test` TLD 2026-08-20 (AGENTS.md hard rule). Install tipos
// were replaced by their twins from src/core/test_data/test_tld_tipo_map.json; the
// seed-shipped ones (rsc/dd/hierarchy/ontology/lg) have no twin and stay, because they
// ship with every installation.

import { describe, expect, test } from 'bun:test';
import {
	buildPeriodValue,
	type CoinRow,
	expandHierarchyChildren,
	findParentWithModel,
	type HierarchyEntry,
	resolveModelSectionId,
	routeCoinsToPeriods,
	type ThesaurusRow,
} from '../../src/core/components/component_info/widgets/numisdata/get_coins_by_period.ts';

const WIDGET_SOURCE_PATH = `${import.meta.dir}/../../src/core/components/component_info/widgets/numisdata/get_coins_by_period.ts`;

const PERIOD_TIPO = 'test6669';
const DUPLICATED_TIPO = 'test6668';

/** One projected thesaurus term. section_id stays whatever the caller passes
 * (string vs number is load-bearing for the strict match). */
function entry(
	sectionId: unknown,
	extra: Partial<HierarchyEntry> = {},
	sectionTipo: unknown = 'test1026',
): HierarchyEntry {
	return {
		section_id: sectionId,
		section_tipo: sectionTipo,
		parent: null,
		label: `term ${String(sectionId)}`,
		count: null,
		model_section_id: 999,
		...extra,
	};
}

/** A coin with the given period locators and (optionally) a duplicated one. */
function coin(
	sectionId: number,
	periods: { section_tipo?: unknown; section_id?: unknown }[] | null,
	duplicated?: { section_id?: unknown }[],
): CoinRow {
	const relation: Record<string, unknown[]> = {};
	if (periods !== null) relation[PERIOD_TIPO] = periods;
	if (duplicated !== undefined) relation[DUPLICATED_TIPO] = duplicated;
	return { section_id: sectionId, relation };
}

/** A raw thesaurus row with hierarchy49 children. */
function tsRow(
	sectionId: unknown,
	children: unknown[] = [],
	sectionTipo = 'test1026',
): ThesaurusRow {
	return {
		section_id: sectionId,
		section_tipo: sectionTipo,
		relation: children.length > 0 ? { hierarchy49: children } : {},
	};
}

const loc = (sectionId: unknown, sectionTipo = 'test1026') => ({
	section_tipo: sectionTipo,
	section_id: sectionId,
});

describe('routeCoinsToPeriods — coin → term routing', () => {
	test('locator law: string AND number ids both match the term (compareLocators)', () => {
		// int is canonical (WC-2026-08-10), legacy strings survive — both count.
		for (const termId of ['187', 187]) {
			const terms = [entry(termId)];
			const empty = routeCoinsToPeriods(
				terms,
				[coin(1, [loc('187')]), coin(2, [loc(187)])],
				PERIOD_TIPO,
				DUPLICATED_TIPO,
				false,
				0,
			);
			expect(terms[0]?.count).toBe(2);
			expect(empty).toBeNull();
		}
	});

	test('locator law: section_tipo stays STRICT (same id, other section → "?")', () => {
		const terms = [entry(187)];
		const empty = routeCoinsToPeriods(
			terms,
			[coin(1, [loc(187, 'test1027')])],
			PERIOD_TIPO,
			DUPLICATED_TIPO,
			false,
			0,
		);
		expect(terms[0]?.count).toBeNull();
		expect(empty).toBe(1);
	});

	test('duplicated flag is the locator law: 2, "2" and "02" skip; "20" and 20 do not', () => {
		const terms = [entry(187)];
		const empty = routeCoinsToPeriods(
			terms,
			[
				coin(1, [loc(187)], [{ section_id: '2' }]),
				coin(2, [loc(187)], [{ section_id: 2 }]),
				coin(3, [loc(187)], [{ section_id: '02' }]),
				coin(4, [loc(187)], [{ section_id: '20' }]),
				coin(5, [loc(187)], [{ section_id: 20 }]),
				coin(6, [loc(187)], [{}]), // no section_id → not a flag
			],
			PERIOD_TIPO,
			DUPLICATED_TIPO,
			false,
			0,
		);
		expect(terms[0]?.count).toBe(3); // coins 4, 5 and 6 survive the skip
		expect(empty).toBeNull(); // skipped coins do NOT feed the catch-all
	});

	test('missing / empty / unmatched period each feed "?" → 3', () => {
		const terms = [entry('187')];
		const empty = routeCoinsToPeriods(
			terms,
			[
				coin(1, null), // no period key at all
				coin(2, []), // present but empty
				coin(3, [loc('999')]), // present, no matching term
			],
			PERIOD_TIPO,
			DUPLICATED_TIPO,
			false,
			0,
		);
		expect(empty).toBe(3);
		expect(terms[0]?.count).toBeNull();
	});

	test('two period locators on one coin → both terms count 1', () => {
		const terms = [entry('187'), entry('200')];
		const empty = routeCoinsToPeriods(
			terms,
			[coin(1, [loc('187'), loc('200')])],
			PERIOD_TIPO,
			DUPLICATED_TIPO,
			false,
			0,
		);
		expect(terms.map((el) => el.count)).toEqual([1, 1]);
		expect(empty).toBeNull();
	});

	test('use_parent: the child rolls up to the matching-model ancestor (int-cast)', () => {
		// model_section_id '5' (string) vs target 5 (number) — Number() on both.
		const ancestor = entry('10', { model_section_id: '5' });
		const child = entry('187', { parent: loc('10'), model_section_id: 42 });
		const terms = [ancestor, child];
		const empty = routeCoinsToPeriods(
			terms,
			[coin(1, [loc('187')])],
			PERIOD_TIPO,
			DUPLICATED_TIPO,
			true,
			5,
		);
		expect(ancestor.count).toBe(1);
		expect(child.count).toBeNull(); // the count lands on the ancestor, not the term
		expect(empty).toBeNull();
	});

	test('use_parent: no matching-model ancestor → "?"', () => {
		const ancestor = entry('10', { model_section_id: 77 });
		const child = entry('187', { parent: loc('10'), model_section_id: 42 });
		const terms = [ancestor, child];
		const empty = routeCoinsToPeriods(
			terms,
			[coin(1, [loc('187')])],
			PERIOD_TIPO,
			DUPLICATED_TIPO,
			true,
			5,
		);
		expect(empty).toBe(1);
		expect(terms.every((el) => el.count === null)).toBe(true);
	});
});

describe('buildPeriodValue — the PHP array_filter key-preservation wire shape', () => {
	test('contiguous survivors → ARRAY (sentinel appended)', () => {
		const terms = [entry('10', { count: 2 }), entry('20', { count: 1 }), entry('30')];
		const value = buildPeriodValue(terms, 4);
		expect(Array.isArray(value)).toBe(true);
		expect(value).toEqual([
			terms[0],
			terms[1],
			{ section_id: null, section_tipo: null, parent: null, label: '?', count: 4 },
		]);
	});

	test('contiguous survivors, no catch-all → ARRAY with no sentinel', () => {
		const terms = [entry('10', { count: 2 }), entry('20')];
		expect(buildPeriodValue(terms, null)).toEqual([terms[0]]);
	});

	test('NON-contiguous survivors → INDEX-KEYED OBJECT, sentinel at MAX INDEX + 1', () => {
		// The wire shape flips here. "Simplifying" buildPeriodValue to a plain
		// .filter() would emit an array and break the contract.
		const terms = [entry('10', { count: 3 }), entry('20'), entry('30', { count: 1 }), entry('40')];
		const value = buildPeriodValue(terms, 7) as Record<string, unknown>;
		expect(Array.isArray(value)).toBe(false);
		expect(Object.keys(value)).toEqual(['0', '2', '3']);
		expect(value['0']).toBe(terms[0] as unknown as never);
		expect(value['2']).toBe(terms[2] as unknown as never);
		// nextKey is MAX SURVIVING INDEX + 1 (2 + 1), NOT surviving.length (2).
		expect(value['3']).toEqual({
			section_id: null,
			section_tipo: null,
			parent: null,
			label: '?',
			count: 7,
		});
	});

	test('no survivors + sentinel → [sentinel] (empty survivors are "contiguous")', () => {
		const value = buildPeriodValue([entry('10'), entry('20')], 5);
		expect(value).toEqual([
			{ section_id: null, section_tipo: null, parent: null, label: '?', count: 5 },
		]);
	});

	test('no survivors, no sentinel → []', () => {
		expect(buildPeriodValue([entry('10')], null)).toEqual([]);
	});
});

describe('expandHierarchyChildren — DFS flatten + parent stamps', () => {
	test('depth-first order with DIRECT-parent stamps', () => {
		const rows = [
			tsRow('10', [loc('187'), loc('200')]),
			tsRow('187', [loc('900')]),
			tsRow('900'),
			tsRow('200'),
		];
		const out: ThesaurusRow[] = [];
		expandHierarchyChildren(rows, loc('10'), null, out);
		expect(out.map((el) => el.section_id)).toEqual(['10', '187', '900', '200']);
		expect(out.map((el) => el.parent?.section_id ?? null)).toEqual([null, '10', '187', '10']);
	});

	test('unknown locator → no-op; childless row → itself only', () => {
		const rows = [tsRow('10')];
		const missing: ThesaurusRow[] = [];
		expandHierarchyChildren(rows, loc('404'), null, missing);
		expect(missing).toEqual([]);

		const childless: ThesaurusRow[] = [];
		expandHierarchyChildren(rows, loc('10'), null, childless);
		expect(childless.map((el) => el.section_id)).toEqual(['10']);
	});

	test('a CYCLE terminates (10 → 187 → 10)', () => {
		const rows = [tsRow('10', [loc('187')]), tsRow('187', [loc('10')])];
		const out: ThesaurusRow[] = [];
		expandHierarchyChildren(rows, loc('10'), null, out);
		expect(out.map((el) => el.section_id)).toEqual(['10', '187']);
	});

	test('DIAMOND, two roots: test1026/187 is emitted TWICE (the guard is NOT a de-duplicator)', () => {
		const rows = [tsRow('A', [loc('187')]), tsRow('B', [loc('187')]), tsRow('187')];
		const out: ThesaurusRow[] = [];
		expandHierarchyChildren(rows, loc('A'), null, out);
		expandHierarchyChildren(rows, loc('B'), null, out);
		expect(out.map((el) => el.section_id)).toEqual(['A', '187', 'B', '187']);
	});

	test('DIAMOND inside ONE traversal: the path-scoped set is cleared on the way back', () => {
		// One top-level call ⇒ ONE shared `seen`. Only the delete-after-recurse
		// makes the second branch see 187 again. A traversal-global Set fails here.
		const rows = [
			tsRow('R', [loc('A'), loc('B')]),
			tsRow('A', [loc('187')]),
			tsRow('B', [loc('187')]),
			tsRow('187'),
		];
		const out: ThesaurusRow[] = [];
		expandHierarchyChildren(rows, loc('R'), null, out);
		expect(out.map((el) => el.section_id)).toEqual(['R', 'A', '187', 'B', '187']);
		// quirk: pinned, not fixed — the SAME row object is pushed twice and its
		// `parent` stamp is last-write-wins ('B' here, not 'A').
		expect(out[2]).toBe(out[4] as unknown as never);
		expect(out[4]?.parent?.section_id).toBe('B');
	});
});

describe('expandHierarchyChildren — locator law on the tree walk', () => {
	test('INT child locators over STRING rows (legacy) and INT rows (canonical) → full DFS', () => {
		const stringRows = [
			tsRow('10', [loc(187), loc(200)]),
			tsRow('187', [loc(900)]),
			tsRow('900'),
			tsRow('200'),
		];
		const intRows = [
			tsRow(10, [loc(187), loc('200')]),
			tsRow(187, [loc('900')]),
			tsRow(900),
			tsRow(200),
		];
		for (const rows of [stringRows, intRows]) {
			const out: ThesaurusRow[] = [];
			expandHierarchyChildren(rows, loc(10), null, out);
			expect(out.map((el) => Number(el.section_id))).toEqual([10, 187, 900, 200]);
			expect(out.map((el) => (el.parent ? Number(el.parent.section_id) : null))).toEqual([
				null,
				10,
				187,
				10,
			]);
		}
	});

	test('a mixed-type CYCLE still terminates (10 → "187" → 10)', () => {
		const rows = [tsRow(10, [loc('187')]), tsRow(187, [loc(10)])];
		const out: ThesaurusRow[] = [];
		expandHierarchyChildren(rows, loc(10), null, out);
		expect(out.map((el) => el.section_id)).toEqual([10, 187]);
	});
});

describe('findParentWithModel — upward model walk', () => {
	test('self-match short-circuits (the term itself is returned)', () => {
		const term = entry('187', { model_section_id: 5, parent: loc('10') });
		expect(findParentWithModel([term, entry('10')], term, 5)).toBe(term);
	});

	test('comparison is int-cast across string/number', () => {
		const term = entry('187', { model_section_id: '5' });
		expect(findParentWithModel([term], term, 5)).toBe(term);
		const numeric = entry('187', { model_section_id: 5 });
		expect(findParentWithModel([numeric], numeric, '5')).toBe(numeric);
	});

	test('multi-level walk finds the grandparent', () => {
		const grand = entry('1', { model_section_id: 5 });
		const mid = entry('10', { model_section_id: 42, parent: loc('1') });
		const leaf = entry('187', { model_section_id: 42, parent: loc('10') });
		expect(findParentWithModel([grand, mid, leaf], leaf, 5)).toBe(grand);
	});

	test('no match → null (root reached, and unknown parent locator)', () => {
		const root = entry('10', { model_section_id: 42 });
		const leaf = entry('187', { model_section_id: 42, parent: loc('10') });
		expect(findParentWithModel([root, leaf], leaf, 5)).toBeNull();

		const orphan = entry('187', { model_section_id: 42, parent: loc('404') });
		expect(findParentWithModel([orphan], orphan, 5)).toBeNull();
	});

	test('locator law: an INT parent stamp finds a STRING-id ancestor (and vice versa)', () => {
		const grand = entry('1', { model_section_id: 5 });
		const leaf = entry(187, { model_section_id: 42, parent: loc(1) });
		expect(findParentWithModel([grand, leaf], leaf, 5)).toBe(grand);
		const intGrand = entry(1, { model_section_id: 5 });
		const legacyLeaf = entry('187', { model_section_id: 42, parent: loc('1') });
		expect(findParentWithModel([intGrand, legacyLeaf], legacyLeaf, 5)).toBe(intGrand);
	});

	test('a CYCLE returns null (which routes those coins to "?")', () => {
		const a = entry('10', { model_section_id: 42, parent: loc('187') });
		const b = entry('187', { model_section_id: 42, parent: loc('10') });
		expect(findParentWithModel([a, b], a, 5)).toBeNull();
	});
});

describe('resolveModelSectionId — the use_parent model (v6: first hierarchy27 locator)', () => {
	test('array-stored model (the v7 relation shape) → its first locator section_id', () => {
		expect(resolveModelSectionId({ hierarchy27: [loc(1), loc(7)] }, 1)).toBe(1);
		expect(resolveModelSectionId({ hierarchy27: [loc('3')] }, 1)).toBe('3');
	});

	test('legacy non-array object model is still read', () => {
		expect(resolveModelSectionId({ hierarchy27: loc(4) as unknown as unknown[] }, 1)).toBe(4);
	});

	test('no model (absent / empty / null relation / non-locator) → target + 1 (never matches)', () => {
		expect(resolveModelSectionId({}, 1)).toBe(2);
		expect(resolveModelSectionId({ hierarchy27: [] }, '1')).toBe(2);
		expect(resolveModelSectionId(null, 1)).toBe(2);
		expect(resolveModelSectionId({ hierarchy27: ['x'] }, 1)).toBe(2);
	});

	test('chain: an array-stored model ancestor receives the rolled-up count', () => {
		const rows = [
			tsRow(10, [loc(187)]),
			{ ...tsRow(187), relation: { hierarchy27: [loc(9, 'test1027')] } },
		];
		rows[0] = {
			...rows[0],
			relation: { ...rows[0]?.relation, hierarchy27: [loc(1, 'test1027')] },
		} as ThesaurusRow;
		const ordered: ThesaurusRow[] = [];
		expandHierarchyChildren(rows as ThesaurusRow[], loc(10), null, ordered);
		const terms: HierarchyEntry[] = ordered.map((row) =>
			entry(row.section_id, {
				parent: row.parent ?? null,
				model_section_id: resolveModelSectionId(row.relation, 1),
			}),
		);
		const empty = routeCoinsToPeriods(
			terms,
			[coin(1, [loc('187')])],
			PERIOD_TIPO,
			DUPLICATED_TIPO,
			true,
			1,
		);
		expect(terms.map((el) => el.count)).toEqual([1, null]);
		expect(empty).toBeNull();
	});
});

describe('rewire proof — the inline copies are GONE from computeGetCoinsByPeriod', () => {
	test('the widget body calls the extractions and holds no second copy', async () => {
		const source = await Bun.file(WIDGET_SOURCE_PATH).text();
		const start = source.indexOf('async function computeGetCoinsByPeriod');
		const end = source.indexOf('/** A thesaurus row as loaded');
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		const body = source.slice(start, end);

		// (c) the call site is repointed…
		expect(body).toContain('routeCoinsToPeriods(');
		expect(body).toContain('buildPeriodValue(');
		// …and (b) the inline logic no longer lives there.
		expect(body).not.toContain('emptyPeriodCount = (emptyPeriodCount ?? 0) + 1');
		expect(body).not.toContain('isFlagSet(');
		expect(body).not.toContain('const surviving');
		expect(body).not.toContain('const contiguous');
		expect(body).not.toContain('const nextKey');

		// exactly ONE copy of each moved fragment in the whole file
		expect(source.split('const surviving').length - 1).toBe(1);
		expect(source.split('const contiguous').length - 1).toBe(1);
		expect(source.split('const nextKey').length - 1).toBe(1);
		// the flag + model rules live in ONE place each (outside the body)
		expect(source.split('isFlagSet(').length - 1).toBe(1);
		expect(body).toContain('resolveModelSectionId(');
		expect(body).not.toContain('isObjectModel');
	});
});
