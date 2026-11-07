/**
 * The SAVE GATE of component_geolocation's sibling keys (src/core/geo/entry_gate.ts)
 * — the pure half; the database half is geo_sources_legend_save_native.test.ts.
 * WC-2026-11-06-geolocation-map-sources-legend.
 *
 * What is pinned:
 *  - source ids are SERVER-ISSUED from the item counter: a new source is numbered;
 *    a stored id is kept; an id the component does not store is replaced by a
 *    fresh one (the only way "never reused" can hold for a value that arrives
 *    from an undo, a copy or a re-import); the same stored id twice is a copy;
 *  - OWNERSHIP: the gate writes nothing it was given and returns its own copies —
 *    the caller's value objects are shared across records by the bulk doors, so a
 *    gate that settled ids in place would leak one record's numbers into the next;
 *  - one VALUE carries a bounded map definition (every entry together), because the
 *    per-entry caps alone leave an N-entry value unbounded;
 *  - validation judges what CHANGED: a stored source sent back byte-identical is
 *    trusted (a record saved before a rule tightened stays editable), a modified
 *    one is judged against today's rules;
 *  - one normal form: `sources` null / `[]` and a legend that says nothing are
 *    removed as keys;
 *  - a refusal is `request.invalid_data` with log-only coordinates, and its
 *    message never carries the offending value;
 *  - the `itemGate` descriptor facet: declared by component_geolocation, resolved
 *    through the registry, and placed only on a monovalue `geo`-column model.
 *
 * Pure: no database, no scratch surface. The counter is a closure.
 */

import { describe, expect, test } from 'bun:test';
import { adjudicate } from '../../scripts/repair_geolocation_studio_default.ts';
import {
	allComponentModels,
	getComponentModel,
	getItemGate,
} from '../../src/core/components/registry.ts';
import { canonicalJson } from '../../src/core/concepts/canonical_json.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import { gateGeoEntries, storedSourceIds, VALUE_LIMITS } from '../../src/core/geo/entry_gate.ts';
import { hasEntrySiblings, validateEntrySiblings } from '../../src/core/geo/entry_siblings.ts';
import { carriesMapDefinition } from '../../src/core/geo/geo_entry_keys.ts';
import {
	isEmptyLegend,
	LEGEND_LIMITS,
	LEGEND_TEXT_CHARS_MAX,
	validateMapLegend,
} from '../../src/core/geo/map_legend.ts';
import { MAP_SOURCE_LIMITS } from '../../src/core/geo/map_source.ts';
import { pngUri } from '../helpers/geo_icon_fixture.ts';

const COORDINATES = { tipo: 'test100', section_tipo: 'test3', section_id: 1 };
const src = (over: Record<string, unknown> = {}) => ({
	type: 'xyz',
	url: 'https://tiles.example.org/{z}/{x}/{y}.png',
	params: {},
	attribution: 'Example Org',
	...over,
});

type Entry = Record<string, unknown>;

/** The `id` of a source the gate has numbered (the fixtures are untyped objects). */
const idOf = (source: unknown): number => (source as { id: number }).id;

/** The listed sources of a gated entry. */
const sourcesOf = (entry: unknown): Entry[] =>
	((entry as Entry | undefined)?.sources as Entry[]) ?? [];

/** The source ids of a gated entry, in order. */
const idsIn = (entry: unknown): number[] => sourcesOf(entry).map(idOf);

/** A counter that continues from `from` (the component's current item counter). */
function counter(from: number): { mint: () => Promise<number>; issued: number[] } {
	const issued: number[] = [];
	let next = from;
	return {
		issued,
		mint: async () => {
			next += 1;
			issued.push(next);
			return next;
		},
	};
}

interface Gated {
	/** What the gate returned: the value the save continues with. */
	out: Entry[];
	/** The numbers it took from the counter, in order. */
	issued: number[];
}

/** Run the gate; its RESULT is what the save keeps (the inputs are never written). */
async function gated(items: readonly unknown[], stored: unknown[], from = 10): Promise<Gated> {
	const { mint, issued } = counter(from);
	const out = (await gateGeoEntries(items, stored, mint, COORDINATES)) as Entry[];
	return { out, issued };
}

async function gate(items: unknown[], stored: unknown[], from = 10): Promise<number[]> {
	return (await gated(items, stored, from)).issued;
}

async function refusal(items: unknown[], stored: unknown[] = []): Promise<DedaloError> {
	try {
		await gate(items, stored);
	} catch (error) {
		return error as DedaloError;
	}
	throw new Error('the gate did not refuse');
}

describe('source ids are server-issued', () => {
	test('a new source is numbered from the counter, in value order', async () => {
		const entry = {
			id: 1,
			lat: 41,
			lon: 2,
			sources: [src(), src({ url: 'https://b.example.org/{z}/{x}/{y}' })],
		};
		const { out, issued } = await gated([entry], [], 10);
		expect(issued.length).toBeGreaterThan(0);
		expect(issued).toEqual([11, 12]);
		expect(idsIn(out[0])).toEqual([11, 12]);
	});

	test('the id is the first key of the stored object', async () => {
		const { out } = await gated([{ sources: [src()] }], []);
		expect(Object.keys(sourcesOf(out[0])[0] as object)[0]).toBe('id');
	});

	test('a stored id is KEPT, whether the source is resent unchanged or edited', async () => {
		const stored = [{ id: 1, sources: [src({ id: 4 }), src({ id: 5, attribution: 'old' })] }];
		const resent = {
			id: 1,
			sources: [src({ id: 4 }), src({ id: 5, attribution: 'edited' }), src()],
		};
		const { out, issued } = await gated([resent], stored, 5);
		expect(issued).toEqual([6]);
		expect(idsIn(out[0])).toEqual([4, 5, 6]);
		expect(sourcesOf(out[0])[1]?.attribution).toBe('edited');
	});

	test('an id the component does not store is NEVER honoured: it is replaced by a fresh one', async () => {
		// 3 was a source once and was deleted; the counter has moved on to 9.
		const stored = [{ id: 1, sources: [src({ id: 8 })] }];
		const resurrect = { id: 1, sources: [src({ id: 8 }), src({ id: 3 })] };
		const { out, issued } = await gated([resurrect], stored, 9);
		expect(issued).toEqual([10]);
		const ids = idsIn(out[0]);
		expect(ids).toEqual([8, 10]);
		expect(ids).not.toContain(3);
	});

	test('a client cannot name a future id either (no id above the counter is accepted)', async () => {
		const { out, issued } = await gated([{ sources: [src({ id: 9999 })] }], [], 3);
		expect(issued).toEqual([4]);
		expect(idsIn(out[0])).toEqual([4]);
	});

	test('the same stored id twice in a value: the first holds it, the second is a COPY and is numbered', async () => {
		// a duplicated row in a UI, or two entries of a propagated value: not an error
		const stored = [{ id: 1, sources: [src({ id: 4 })] }];
		const value = { id: 1, sources: [src({ id: 4 }), src({ id: 4, attribution: 'copy' })] };
		const { out, issued } = await gated([value], stored, 9);
		expect(issued).toEqual([10]);
		expect(idsIn(out[0])).toEqual([4, 10]);
		expect(sourcesOf(out[0])[1]?.attribution).toBe('copy');
	});

	test('a stored id named by two ENTRIES of one value: the first entry holds it, the second is numbered', async () => {
		const stored = [{ id: 1, sources: [src({ id: 4 })] }];
		const entries = [
			{ id: 1, sources: [src({ id: 4 })] },
			{ id: 2, sources: [src({ id: 4, attribution: 'foreign' })] },
		];
		const { out, issued } = await gated(entries, stored, 9);
		expect(issued).toEqual([10]);
		expect(out.map(idsIn)).toEqual([[4], [10]]);
	});

	test('two sources naming ONE stored id are resolved by POSITION: the one listed first holds the number', async () => {
		// The honest limit of the ordering law: an explicit id outranks a content match wherever
		// the two sit (below), but when two sources name the SAME stored id, position decides.
		// [genuine, foreign] and [foreign, genuine] therefore differ in who keeps number 4 —
		// the WC says so, and this pins it.
		const stored = [{ id: 1, sources: [src({ id: 4, attribution: 'GENUINE' })] }];
		const foreign = src({
			id: 4,
			attribution: 'FOREIGN',
			url: 'https://foreign.example.org/{z}/{x}/{y}',
		});
		const genuine = src({ id: 4, attribution: 'GENUINE' });
		const first = await gated([{ id: 1, sources: [genuine, foreign] }], stored, 10);
		expect(first.out[0]?.sources).toEqual([{ ...genuine }, { ...foreign, id: 11 }]);
		const second = await gated([{ id: 1, sources: [foreign, genuine] }], stored, 10);
		expect(second.out[0]?.sources).toEqual([{ ...foreign }, { ...genuine, id: 11 }]);
	});

	test('a propagated "add" (stored entry + a foreign one) with COLLIDING small ids is saved, not refused', async () => {
		// tool_propagate_component_data "add" sends [stored entry, foreign entry]; ids are
		// per-record numbers, so the foreign 2 and 3 meet the stored 2
		const stored = [{ id: 1, sources: [src({ id: 2, attribution: 'target own' })] }];
		const value = [
			structuredClone(stored[0]),
			{
				id: 1,
				sources: [
					src({ id: 2, attribution: 'FOREIGN A', url: 'https://a.example.org/{z}/{x}/{y}' }),
					src({ id: 3, attribution: 'FOREIGN B', url: 'https://b.example.org/{z}/{x}/{y}' }),
				],
			},
		];
		const { out, issued } = await gated(value, stored, 3);
		expect(issued).toEqual([4, 5]);
		// the stored entry keeps its source; the foreign entry's sources are copies, never 2
		expect(idsIn(out[0])).toEqual([2]);
		expect(idsIn(out[1])).toEqual([4, 5]);
		expect(sourcesOf(out[1]).map((source) => source.attribution)).toEqual([
			'FOREIGN A',
			'FOREIGN B',
		]);
	});

	test('ids are unique across a value even when the caller sends colliding fresh ones', async () => {
		// 77 twice in ONE entry, 77 again in the next, 78 beside it: none is stored, all are new
		const entries = [
			{ id: 1, sources: [src({ id: 77 }), src({ id: 77, attribution: 'b' })] },
			{ id: 2, sources: [src({ id: 77, attribution: 'c' }), src({ id: 78, attribution: 'd' })] },
		];
		const { out } = await gated(entries, [], 20);
		const all = out.flatMap(idsIn);
		expect(new Set(all).size).toBe(all.length);
		expect(all).toEqual([21, 22, 23, 24]);
	});

	test('storedSourceIds lists what a component stores (for the counter raise)', () => {
		expect(
			storedSourceIds([
				{ id: 1, sources: [src({ id: 7 }), src({ id: 9 }), src(), { id: 'x' }, { id: 0 }] },
				{ id: 2 },
				'junk',
				null,
			]).sort(),
		).toEqual([7, 9]);
	});
});

describe('OWNERSHIP: the gate writes nothing it was given', () => {
	/** A value that exercises every write the gate makes: numbering, adoption, normal form. */
	const messy = (): Entry[] => [
		{
			lat: 41,
			lon: 2,
			sources: [src(), src({ id: 4, attribution: 'edit' }), src({ id: 4, attribution: 'copy' })],
			legend: { title: ' T ', groups: [] },
		},
		{ lat: 1, lon: 2, sources: null, legend: {} },
		{ id: 7, sources: [] },
		{ sources: [src({ url: 'https://other.example.org/{z}/{x}/{y}' })] },
	];
	const STORED = (): Entry[] => [
		{ id: 1, lat: 41, lon: 2, sources: [src({ id: 4, attribution: 'old' })] },
		{ id: 2, lat: 1, lon: 2 },
	];

	test('the items and the stored items come back byte-identical to what went in', async () => {
		const items = messy();
		const stored = STORED();
		const itemsBefore = structuredClone(items);
		const storedBefore = structuredClone(stored);
		const { out, issued } = await gated(items, stored, 20);
		expect(issued.length).toBeGreaterThan(0); // the control: the gate DID work on this value
		expect(items).toEqual(itemsBefore);
		expect(stored).toEqual(storedBefore);
		expect(canonicalJson(out)).not.toBe(canonicalJson(itemsBefore));
	});

	test('what it returns is its own: a new array of new entries, whatever the caller holds', async () => {
		const items = messy();
		const { out } = await gated(items, [], 20);
		expect(out).not.toBe(items);
		for (const [index, entry] of items.entries()) {
			expect(out[index]).not.toBe(entry);
			// the sibling keys are deep copies: the gate's result shares no object with the caller's
			expect(out[index]?.sources).not.toBe(entry.sources);
		}
		const passthrough = ['junk', null, 5];
		const mixed = await gated([...passthrough, { sources: [src()] }], [], 20);
		expect(mixed.out.slice(0, 3) as unknown[]).toEqual(passthrough);
	});

	test('ONE value object gated against two records equals gating a fresh clone against each', async () => {
		// the bulk door (tool_propagate_component_data) hands the SAME value to every target.
		// Record 2 already stores its own source 1 (U); the shared source S is id-less.
		const S = src({ url: 'https://s.example.org/{z}/{x}/{y}.png', attribution: 'S' });
		const shared = [{ lat: 1, lon: 2, sources: [S] }];
		const record1: unknown[] = [];
		const record2 = [{ id: 2, sources: [src({ id: 1, attribution: 'U' })] }];

		const viaShared1 = await gated(shared, record1, 0);
		const viaShared2 = await gated(shared, record2, 2);
		const control = await gated(structuredClone(shared), record2, 2);

		// record 1 numbered S (it took 1) — and the shared object did not hear about it
		expect(idsIn(viaShared1.out[0])).toEqual([1]);
		expect(S).not.toHaveProperty('id');
		// record 2 sees an id-less S, exactly as the fresh clone does: a NEW number, never U's 1
		expect(viaShared2.out).toEqual(control.out);
		expect(viaShared2.issued).toEqual(control.issued);
		expect(idsIn(viaShared2.out[0])).toEqual([3]);
	});

	test('a re-run of a propagated value is idempotent: the stored copy keeps its number', async () => {
		// record 2 holds S under 7 (an earlier run numbered it); the shared S is still id-less
		const S = src({ url: 'https://s.example.org/{z}/{x}/{y}.png', attribution: 'S' });
		const shared = [{ lat: 1, lon: 2, sources: [S] }];
		await gated(shared, [], 0); // an earlier target consumed the shared object
		const record2 = [{ id: 2, lat: 1, lon: 2, sources: [{ ...S, id: 7 }] }];
		const rerun = await gated(shared, record2, 7);
		expect(rerun.issued).toEqual([]);
		expect(idsIn(rerun.out[0])).toEqual([7]);
		expect(rerun.out[0]?.id).toBe(2);
	});

	test('items that share their entries with the stored items do not corrupt the baseline', async () => {
		// a save that changed nothing hands the stored objects back as the items; the stored
		// value holds a duplicated source id (a bypass door wrote it)
		const dup = {
			id: 1,
			sources: [src({ id: 3, attribution: 'a' }), src({ id: 3, attribution: 'b' })],
		};
		const stored = [dup];
		const before = structuredClone(stored);
		const { out } = await gated([dup], stored, 100);
		expect(stored).toEqual(before);
		expect(dup.sources.map(idOf)).toEqual([3, 3]);
		// the second holder of 3 is a copy: numbered in the RESULT only
		expect(idsIn(out[0])).toEqual([3, 101]);
	});
});

describe('one VALUE carries a bounded map definition', () => {
	const entryWith = (n: number, tag: string): Entry => ({
		sources: Array.from({ length: n }, (_, i) =>
			src({ url: `https://${tag}-${i}.example.org/{z}/{x}/{y}.png` }),
		),
	});

	test('the value cap is four entries of the per-entry cap', () => {
		expect(VALUE_LIMITS.maxSources).toBe(4 * MAP_SOURCE_LIMITS.maxSources);
	});

	test('exactly the cap passes: four full entries (the control for the refusals below)', async () => {
		const full = MAP_SOURCE_LIMITS.maxSources;
		const items = [
			entryWith(full, 'a'),
			entryWith(full, 'b'),
			entryWith(full, 'c'),
			entryWith(full, 'd'),
		];
		const { out, issued } = await gated(items, [], 0);
		expect(issued).toHaveLength(VALUE_LIMITS.maxSources);
		expect(out.flatMap(idsIn)).toHaveLength(VALUE_LIMITS.maxSources);
	});

	test('one source over the cap is refused, with counts and no values, before anything is minted', async () => {
		const full = MAP_SOURCE_LIMITS.maxSources;
		const items = [
			entryWith(full, 'a'),
			entryWith(full, 'b'),
			entryWith(full, 'c'),
			entryWith(full, 'd'),
			entryWith(1, 'e'),
		];
		const { mint, issued } = counter(0);
		let caught: unknown = null;
		try {
			await gateGeoEntries(items, [], mint, COORDINATES);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(DedaloError);
		expect((caught as DedaloError).code).toBe('request.invalid_data');
		expect((caught as DedaloError).message).toMatch(/sources: 97 in one value, more than 96/);
		expect((caught as DedaloError).message).not.toContain('example.org');
		expect(issued).toEqual([]);
	});

	test('thirty entries of twenty-four sources each (a 16 MB value) are refused', async () => {
		const items = Array.from({ length: 30 }, (_, index) =>
			entryWith(MAP_SOURCE_LIMITS.maxSources, `e${index}`),
		);
		expect((await refusal(items)).message).toMatch(/in one value/);
	});

	test('the icons of a value are bounded as well: a legend per entry cannot add up past the cap', async () => {
		// one icon of ~53 KB; four of them are a legend (213 KB, under the 256 KiB legend cap)
		const icon = pngUri(16, 16, 40_000);
		const legend = () => ({
			title: 'T',
			groups: [
				{ name: 'g', symbols: Array.from({ length: 4 }, (_, i) => ({ label: `s${i}`, icon })) },
			],
		});
		const four = Array.from({ length: 4 }, () => ({ legend: legend() }));
		expect((await gated(four, [], 0)).out).toHaveLength(4);
		const five = Array.from({ length: 5 }, () => ({ legend: legend() }));
		expect((await refusal(five)).message).toMatch(/legend: icons of \d+ characters in one value/);
	});

	/** A TEXT-ONLY legend at every text cap (no icon): the most text one valid legend carries. */
	const fullTextLegend = (tag: string) => ({
		title: tag.padEnd(LEGEND_LIMITS.maxTitle, 't'),
		groups: Array.from({ length: LEGEND_LIMITS.maxGroups }, (_, g) => ({
			name: `${tag}${g}`.padEnd(LEGEND_LIMITS.maxName, 'n'),
			symbols: Array.from({ length: LEGEND_LIMITS.maxSymbolsPerGroup }, (_, i) => ({
				label: `${tag}${g}.${i}`.padEnd(LEGEND_LIMITS.maxLabel, 'l'),
			})),
		})),
	});

	test('the legend budget is four legends, and four legends’ worth of text, of the per-legend caps', () => {
		expect(LEGEND_TEXT_CHARS_MAX).toBe(208_200);
		expect(VALUE_LIMITS.maxLegends).toBe(4);
		expect(VALUE_LIMITS.maxLegendTextChars).toBe(4 * LEGEND_TEXT_CHARS_MAX);
		// the fixture IS a valid legend at the text ceiling, not a refusal of its own
		const one = validateMapLegend(fullTextLegend('a'), 'legend');
		expect(one.ok).toBe(true);
	});

	test('four full TEXT-ONLY legends pass (the control); one character more is refused by the text budget', async () => {
		const four = ['a', 'b', 'c', 'd'].map((tag) => ({ legend: fullTextLegend(tag) }));
		expect((await gated(four, [], 0)).out).toHaveLength(4);
		const longer = { ...fullTextLegend('d'), title: 'x'.repeat(LEGEND_LIMITS.maxTitle + 1) };
		const over = [...four.slice(0, 3), { legend: longer }];
		expect((await refusal(over)).message).toMatch(
			/legend: text of 832801 characters in one value, more than 832800/,
		);
	});

	test('a fifth legend is refused by COUNT, however small, before anything is minted', async () => {
		const five = ['a', 'b', 'c', 'd', 'small'].map((title) => ({ legend: { title } }));
		const { mint, issued } = counter(0);
		let caught: unknown = null;
		try {
			await gateGeoEntries(five, [], mint, COORDINATES);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(DedaloError);
		expect((caught as DedaloError).code).toBe('request.invalid_data');
		expect((caught as DedaloError).message).toMatch(/legend: 5 legends in one value, more than 4/);
		expect((caught as DedaloError).message, 'counts, never the values').not.toContain('small');
		expect(issued).toEqual([]);
	});

	test('a legend that says nothing is not counted: four legends plus any number of empty ones pass', async () => {
		const four = ['a', 'b', 'c', 'd'].map((tag) => ({ legend: { title: tag } }));
		const empties = Array.from({ length: 8 }, (_, index) =>
			index % 2 === 0 ? { legend: null } : { legend: { title: '', groups: [] } },
		);
		expect((await gated([...four, ...empties], [], 0)).out).toHaveLength(12);
	});

	test('legend TEXT is counted across the value, as listed: past four legends’ worth it is refused, whatever the count', async () => {
		// two entries whose groups run far past the per-legend caps (refused on their own too) — the
		// budget refuses them first, by size, before a single one is compared or validated
		const oversized = (tag: string) => ({
			title: tag,
			groups: Array.from({ length: 40 }, (_, g) => ({
				name: `${tag}${g}`,
				symbols: Array.from({ length: 64 }, (_, i) => ({ label: `${i}`.padEnd(200, 'x') })),
			})),
		});
		const error = await refusal([{ legend: oversized('a') }, { legend: oversized('b') }]);
		expect(error.code).toBe('request.invalid_data');
		expect(error.message).toMatch(/legend: text of \d+ characters in one value, more than 832800/);
	});

	test('the budget counts what is LISTED, before any normalization can shrink it', async () => {
		// 97 listed sources, of which 96 are byte-equal duplicates that the gate could have numbered:
		// the cap is on the work, so the listing is what it counts
		const same = src();
		const items = [{ sources: Array.from({ length: 24 }, () => ({ ...same })) }];
		for (let index = 0; index < 4; index += 1)
			items.push({ sources: Array.from({ length: 24 }, () => ({ ...same })) });
		expect((await refusal(items)).message).toMatch(/sources: 120 in one value/);
	});
});

describe('an unchanged re-import is a no-op: ids are adopted by content', () => {
	const STORED = [
		{
			id: 1,
			lat: 41,
			lon: 2,
			zoom: 12,
			alt: 0,
			sources: [src({ id: 2 }), src({ id: 3, url: 'https://b.example.org/{z}/{x}/{y}' })],
		},
	];
	/** The same cell as a CSV/JSON file writes it: no ids anywhere. */
	const idLess = () => ({
		lat: 41,
		lon: 2,
		zoom: 12,
		alt: 0,
		sources: [src(), src({ url: 'https://b.example.org/{z}/{x}/{y}' })],
	});

	test('id-less sources equal to stored ones take the stored ids; nothing is minted', async () => {
		const { out, issued } = await gated([idLess()], structuredClone(STORED), 3);
		expect(issued).toEqual([]);
		expect(idsIn(out[0])).toEqual([2, 3]);
	});

	test('and so does the ENTRY: it takes the stored entry id, the whole cell is byte-equal to the stored one', async () => {
		const { out } = await gated([idLess()], structuredClone(STORED), 3);
		expect(out[0]?.id).toBe(1);
		expect(canonicalJson(out[0])).toBe(canonicalJson(STORED[0]));
	});

	test('a source equal to a stored one apart from the normal form (defaults, padding) still adopts', async () => {
		const stored = [
			{
				id: 1,
				sources: [
					{
						id: 6,
						type: 'wms',
						url: 'https://wms.example.org/service',
						params: {
							version: '1.3.0',
							layers: 'base',
							styles: '',
							format: 'image/png',
							transparent: false,
							crs: 'EPSG:3857',
						},
						attribution: 'WMS',
					},
				],
			},
		];
		const cell = {
			sources: [
				{
					type: 'wms',
					url: 'https://wms.example.org/service',
					// `styles` and `transparent` left to their defaults, a padded attribution
					params: { version: '1.3.0', layers: 'base', format: 'image/png', crs: 'EPSG:3857' },
					attribution: '  WMS  ',
				},
			],
		};
		const { out, issued } = await gated([cell], stored, 6);
		expect(issued).toEqual([]);
		expect(idsIn(out[0])).toEqual([6]);
	});

	test('an explicit id outranks a content match wherever the two sit in the value', async () => {
		// the id-less A comes FIRST but stored 2 is named explicitly by the second element
		const stored = [{ id: 1, sources: [src({ id: 2 })] }];
		const cell = { id: 1, sources: [src(), src({ id: 2 })] };
		const { out, issued } = await gated([cell], stored, 2);
		expect(issued).toEqual([3]);
		expect(idsIn(out[0])).toEqual([3, 2]);
	});

	test('a stored source is adopted ONCE: a second identical id-less source is a new one', async () => {
		const stored = [{ id: 1, sources: [src({ id: 2 })] }];
		const cell = { id: 1, sources: [src(), src()] };
		const { out, issued } = await gated([cell], stored, 2);
		expect(issued).toEqual([3]);
		expect(idsIn(out[0])).toEqual([2, 3]);
	});

	test('two stored twins are adopted in stored order', async () => {
		const stored = [{ id: 1, sources: [src({ id: 2 }), src({ id: 3 })] }];
		const cell = { id: 1, sources: [src(), src()] };
		const { out, issued } = await gated([cell], stored, 3);
		expect(issued).toEqual([]);
		expect(idsIn(out[0])).toEqual([2, 3]);
	});

	test('a DELETED id is never adopted: content equal to nothing stored is new', async () => {
		// 2 was deleted (the component stores 3 only); the cell brings 2's content back
		const stored = [{ id: 1, sources: [src({ id: 3, url: 'https://b.example.org/{z}/{x}/{y}' })] }];
		const cell = { id: 1, sources: [src({ id: 2 })] };
		const { out, issued } = await gated([cell], stored, 3);
		expect(issued).toEqual([4]);
		expect(idsIn(out[0])).toEqual([4]);
	});

	test("a foreign id with a stored source's content adopts that stored id (a propagated re-run is idempotent)", async () => {
		// first run numbered the copy 12; the second run still carries the foreign 7
		const stored = [{ id: 1, sources: [src({ id: 12 })] }];
		const cell = { id: 1, sources: [src({ id: 7 })] };
		const { out, issued } = await gated([cell], stored, 12);
		expect(issued).toEqual([]);
		expect(idsIn(out[0])).toEqual([12]);
	});

	test('an EDITED id-less source is new, and the entry is not adopted over it', async () => {
		const cell = idLess() as { sources: Record<string, unknown>[] } & Record<string, unknown>;
		(cell.sources[0] as Record<string, unknown>).attribution = 'edited';
		const { out, issued } = await gated([cell], structuredClone(STORED), 3);
		expect(issued).toEqual([4]);
		expect(idsIn(out[0])).toEqual([4, 3]);
		// a source differs, so the entry is NOT the stored one: no id to adopt (the save's
		// safety net stamps it)
		expect(out[0]?.id).toBeUndefined();
	});

	test('a trusted legacy source as written is adopted without being re-judged', async () => {
		const asWritten = src({ url: 'http://127.0.0.1/{z}/{x}/{y}.png' });
		const stored = [{ id: 1, sources: [{ id: 2, ...asWritten }] }];
		const { out, issued } = await gated([{ id: 1, sources: [asWritten] }], stored, 2);
		expect(issued).toEqual([]);
		expect(idsIn(out[0])).toEqual([2]);
	});

	test('the entry is adopted by POSITION and never over a caller-named id', async () => {
		const stored = [{ id: 1, lat: 1, lon: 2 }];
		const named = await gated([{ id: 9, lat: 1, lon: 2 }], stored);
		expect(named.out[0]?.id).toBe(9);
		const bare = await gated([{ lat: 1, lon: 2 }], stored);
		expect(bare.out[0]?.id).toBe(1);
		// not at another position
		const second = await gated(
			[
				{ lat: 5, lon: 6 },
				{ lat: 1, lon: 2 },
			],
			stored,
		);
		expect(second.out[1]?.id).toBeUndefined();
	});
});

describe('validation judges what changed', () => {
	const LEGACY = src({ id: 2, url: 'http://127.0.0.1/{z}/{x}/{y}.png' });

	test('a stored source sent back byte-identical is trusted, key order aside', async () => {
		const reordered = {
			attribution: LEGACY.attribution,
			params: LEGACY.params,
			url: LEGACY.url,
			type: LEGACY.type,
			id: 2,
		};
		const { out } = await gated([{ id: 1, sources: [reordered] }], [{ id: 1, sources: [LEGACY] }]);
		// kept as sent (the legacy url survives untouched), not re-judged and not rewritten
		expect(sourcesOf(out[0])[0]).toEqual(reordered);
	});

	test("the same source EDITED is judged against today's rules", async () => {
		const error = await refusal(
			[{ id: 1, sources: [{ ...LEGACY, attribution: 'edited' }] }],
			[{ id: 1, sources: [LEGACY] }],
		);
		expect(error.code).toBe('request.invalid_data');
		expect(error.message).toMatch(/sources\[0\]\.url/);
	});

	test('a NEW invalid source is refused with its path, the value never quoted', async () => {
		const secret = 'tok_SECRET_77';
		const error = await refusal([
			{ sources: [src(), src({ url: `http://127.0.0.1/{z}/{x}/{y}?key=${secret}` })] },
		]);
		expect(error).toBeInstanceOf(DedaloError);
		expect(error.code).toBe('request.invalid_data');
		expect(error.message).toMatch(/sources\[1\]\.url/);
		expect(error.message).not.toContain(secret);
		// log-only identifiers ride on `coordinates`, never on the wire `details`
		expect(error.coordinates).toEqual(COORDINATES);
		expect(error.details).toBeUndefined();
	});

	test('a legend equal to the stored one is trusted; an edited one is judged', async () => {
		const legacy = { title: 'T', groups: [{ name: 'g', symbols: [{ label: '<img src=x>' }] }] };
		const { out } = await gated(
			[{ id: 1, legend: structuredClone(legacy) }],
			[{ id: 1, legend: legacy }],
		);
		expect(out[0]?.legend).toEqual(legacy);

		const edited = { id: 1, legend: { ...legacy, title: 'T2' } };
		expect((await refusal([edited], [{ id: 1, legend: legacy }])).code).toBe(
			'request.invalid_data',
		);
	});

	test('a refusal in any entry refuses the value (nothing half-validated)', async () => {
		const error = await refusal([{ sources: [src()] }, { legend: { groups: 'nope' } }]);
		expect(error.message).toMatch(/legend\.groups/);
	});
});

describe('one normal form', () => {
	test('null / [] sources and a legend that says nothing are removed as keys', async () => {
		const a = { id: 1, lat: 1, lon: 2, sources: null, legend: null };
		const b = { id: 1, lat: 1, lon: 2, sources: [], legend: { title: '', groups: [] } };
		const c = { id: 1, lat: 1, lon: 2, legend: {} };
		const { out } = await gated([a, b, c], []);
		for (const entry of out) {
			expect(Object.keys(entry).sort()).toEqual(['id', 'lat', 'lon']);
		}
	});

	test('a valid legend is stored normalized', async () => {
		const entry = {
			id: 1,
			legend: { title: ' T ', groups: [{ name: ' g ', symbols: [{ label: ' l ' }] }] },
		};
		const { out } = await gated([entry], []);
		expect(out[0]?.legend).toEqual({
			title: 'T',
			groups: [{ name: 'g', symbols: [{ label: 'l' }] }],
		});
	});

	test('everything that is not a sibling key is left exactly as it was', async () => {
		const entry: Record<string, unknown> = {
			id: 1,
			lat: '41.5',
			lon: 2.25,
			zoom: 9,
			alt: 3,
			lib_data: [{ layer_id: 1, layer_data: { type: 'FeatureCollection', features: [] } }],
			future_key: { anything: true },
			sources: [src()],
		};
		const { sources: _before, ...others } = structuredClone(entry);
		const { out } = await gated([entry], []);
		const { sources: _after, ...rest } = out[0] as Entry;
		expect(rest).toEqual(others);
	});

	test('non-object items are skipped, not judged', async () => {
		const { issued } = await gated(['junk', null, 5, { sources: [src()] }], []);
		expect(issued).toEqual([11]);
	});

	test('an item with neither key costs no mint and no change', async () => {
		const entry = { id: 1, lat: 1, lon: 2 };
		const { out, issued } = await gated([entry], []);
		expect(issued).toEqual([]);
		expect(out).toEqual([{ id: 1, lat: 1, lon: 2 }]);
	});
});

describe('the shape check used by the import conform', () => {
	test('absence is the empty state', () => {
		for (const entry of [
			{},
			{ sources: null },
			{ sources: [] },
			{ legend: null },
			{ legend: { groups: [] } },
		]) {
			const result = validateEntrySiblings(entry);
			expect(result.ok && result.value).toEqual({});
			expect(result.ok && hasEntrySiblings(result.value)).toBe(false);
		}
	});

	test('valid siblings come back normalized; ids are kept (the save gate decides)', () => {
		const result = validateEntrySiblings({
			sources: [src({ id: 5, attribution: ' x ' })],
			legend: { title: 'T' },
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.sources?.[0]?.id).toBe(5);
		expect(result.value.sources?.[0]?.attribution).toBe('x');
		expect(result.value.legend).toEqual({ title: 'T', groups: [] });
		expect(hasEntrySiblings(result.value)).toBe(true);
	});

	test('a bad sibling is refused with its path', () => {
		const result = validateEntrySiblings({ sources: [src({ type: 'tms' })] });
		expect(result.ok).toBe(false);
		expect(!result.ok && result.reason).toMatch(/^sources\[0\]\.type/);
	});
});

describe('the itemGate descriptor facet', () => {
	test('component_geolocation declares it and the registry resolves it', () => {
		expect(getComponentModel('component_geolocation')?.itemGate).toBe('geo_entry');
		expect(getItemGate('component_geolocation')).toBe('geo_entry');
	});

	test('a model with no gate resolves to undefined', () => {
		expect(getItemGate('component_input_text')).toBeUndefined();
		expect(getItemGate('component_portal')).toBeUndefined();
		expect(getItemGate('not_a_model')).toBeUndefined();
	});

	test("placement: 'geo_entry' only on a MONOVALUE model that stores in the `geo` column", () => {
		const declaring = allComponentModels().filter((model) => model.itemGate !== undefined);
		expect(declaring.map((model) => model.model)).toEqual(['component_geolocation']);
		for (const model of declaring) {
			expect(model.column).toBe('geo');
			// The save continues with the array the gate RETURNS. A monovalue model's insert
			// REPLACES (the full-array write); a multivalue one could take the atomic-append
			// path, which writes the caller's own insert values and would skip the gate's output.
			expect(model.monovalue, `${model.model} must be monovalue`).toBe(true);
		}
	});
});

describe('the other whole-value writer: the studio-default repair', () => {
	// The factory view the v6 client wrote on save (isStudioDefault, geo_coordinate.ts).
	const FACTORY = { lat: 39.462571, lon: -0.376295, zoom: 16, alt: 16 };

	test('a map definition is content the operator wrote: carriesMapDefinition', () => {
		expect(carriesMapDefinition({ sources: [src({ id: 1 })] })).toBe(true);
		expect(carriesMapDefinition({ legend: { title: 'T', groups: [] } })).toBe(true);
		expect(carriesMapDefinition({ legend: { groups: [{ name: 'g', symbols: [] }] } })).toBe(true);
		for (const none of [{}, { sources: [] }, { sources: null }, { legend: null }, { legend: {} }]) {
			expect(carriesMapDefinition(none), JSON.stringify(none)).toBe(false);
		}
	});

	test('PRESENCE, not type: a value the gate would refuse is still content a repair must not delete', () => {
		// these shapes can reach the column through the doors that bypass the gate (Time Machine
		// restore, bulk revert, archive restore); none is "nothing"
		for (const something of [
			{ sources: 'x' },
			{ sources: {} },
			{ sources: { a: 1 } },
			{ sources: 5 },
			{ sources: 0 },
			{ sources: false },
			{ sources: [null] },
			{ legend: 'x' },
			{ legend: '' },
			{ legend: [] },
			{ legend: [1] },
			{ legend: 0 },
			{ legend: false },
			{ legend: true },
		]) {
			expect(carriesMapDefinition(something), JSON.stringify(something)).toBe(true);
		}
	});

	test("the repair's emptiness rule IS the gate's: an empty legend carries nothing, an unreadable one something", () => {
		// what the gate stores as "no legend" (isEmptyLegend) carries no definition either
		for (const empty of [
			{},
			{ title: '', groups: [] },
			{ title: '   ' },
			{ groups: [] },
			{ groups: null },
		]) {
			expect(carriesMapDefinition({ legend: empty }), JSON.stringify(empty)).toBe(false);
			const validated = validateMapLegend(empty, 'legend');
			expect(validated.ok && isEmptyLegend(validated.value), JSON.stringify(empty)).toBe(true);
		}
		// malformed or foreign content is never called empty: a repair must not delete what it cannot read
		for (const something of [
			{ groups: 'nope' },
			{ title: 5 },
			{ other: 1 },
			{ title: '', extra: [] },
		]) {
			expect(carriesMapDefinition({ legend: something }), JSON.stringify(something)).toBe(true);
		}
	});

	test('a default-view item that carries sources/legend is NOT default-only and is never cleared', () => {
		// the control: the bare factory item IS cleared (so the guard below is not vacuous)
		expect(adjudicate([{ id: 1, ...FACTORY }])).toEqual({ verdict: 'CLEAR' });

		expect(adjudicate([{ id: 1, ...FACTORY, sources: [src({ id: 2 })] }])).toBeNull();
		expect(adjudicate([{ id: 1, ...FACTORY, legend: { title: 'T', groups: [] } }])).toBeNull();
		// the gate's own normal form for "none" carries nothing: still a fabrication
		expect(adjudicate([{ id: 1, ...FACTORY, sources: [] }])).toEqual({ verdict: 'CLEAR' });
		expect(adjudicate([{ id: 1, ...FACTORY, legend: { title: '', groups: [] } }])).toEqual({
			verdict: 'CLEAR',
		});
		expect(adjudicate([{ id: 1, ...FACTORY, legend: {} }])).toEqual({ verdict: 'CLEAR' });
		// an unreadable legend, or a sources/legend of the wrong TYPE, is something: held back, never cleared
		expect(adjudicate([{ id: 1, ...FACTORY, legend: { groups: 'nope' } }])).toBeNull();
		expect(adjudicate([{ id: 1, ...FACTORY, sources: 'x' }])).toBeNull();
		expect(adjudicate([{ id: 1, ...FACTORY, sources: { a: 1 } }])).toBeNull();
		expect(adjudicate([{ id: 1, ...FACTORY, legend: 'x' }])).toBeNull();
		expect(adjudicate([{ id: 1, ...FACTORY, legend: [1] }])).toBeNull();
	});
});
