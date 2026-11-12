/**
 * append_merge — the PURE CSV-import append merge (plan §4, §7 first bullet).
 *
 * No database: the relation insert law is injected, so these cases pin what
 * the merge itself owns — stored items kept byte-for-byte (by reference),
 * stored duplicates never collapsed, no-lang items surviving, per-family
 * literal equality (date `time` ignored, period items compared), geolocation layer renumbering over
 * mixed/string ids, and the text_area tag refusal + paragraph dedup. The
 * engine wiring (lock, allocation, TM) is gated natively elsewhere.
 */

import { describe, expect, test } from 'bun:test';
import {
	type AppendItem,
	type AppendMergeInput,
	containsDedaloTag,
	isEmptyLiteralItem,
	literalDuplicateIds,
	literalEqualityFamilyOf,
	mergeAppend,
	mergeGeoLayers,
	paragraphFragment,
	type RelationAppendValidator,
	resolveAppendedIdMap,
} from '../../src/core/section/record/append_merge.ts';

const TIPO = 'test999';

function input(overrides: Partial<AppendMergeInput>): AppendMergeInput {
	return {
		policy: 'items',
		family: 'string',
		stored: [],
		incoming: [],
		lang: 'lg-spa',
		langSliced: false,
		componentTipo: TIPO,
		...overrides,
	};
}

/**
 * A stand-in for validateRelationInsert: normalizes (type, from_component_tipo,
 * int section_id) and drops a duplicate over section_id|section_tipo|type|tag_id.
 * Records every call so the test can assert what the merge handed it.
 */
function fakeLaw(
	calls: { raw: AppendItem; existing: readonly unknown[] }[],
): RelationAppendValidator {
	return async (raw, existing) => {
		calls.push({ raw, existing });
		const value: AppendItem = {
			...raw,
			type: raw.type ?? 'dd151',
			from_component_tipo: TIPO,
			section_id: Number(raw.section_id),
		};
		const key = (item: unknown) => {
			const it = item as AppendItem;
			return [it.section_id, it.section_tipo, it.type, it.tag_id ?? ''].map(String).join('|');
		};
		const match = existing.find((item) => key(item) === key(value));
		return match === undefined ? { value } : { value: null, code: 'duplicate', duplicateOf: match };
	};
}

describe('relations (items)', () => {
	const storedA = {
		id: 1,
		type: 'dd151',
		section_id: 1,
		section_tipo: 'test3',
		from_component_tipo: TIPO,
	};
	// a stored DUPLICATE of A (legacy data): must survive untouched
	const storedA2 = {
		id: 2,
		type: 'dd151',
		section_id: '1',
		section_tipo: 'test3',
		from_component_tipo: TIPO,
	};

	test('stored locators are kept byte-identical and stored duplicates are not collapsed', async () => {
		const stored = [storedA, storedA2];
		const snapshot = structuredClone(stored);
		const calls: { raw: AppendItem; existing: readonly unknown[] }[] = [];
		const result = await mergeAppend(
			input({
				family: 'relation',
				stored,
				incoming: [{ id: 7, section_id: 2, section_tipo: 'test3', paginated_key: 0 }],
				validateRelation: fakeLaw(calls),
			}),
		);
		expect(result.items.length).toBe(3);
		expect(result.items[0]).toBe(storedA);
		expect(result.items[1]).toBe(storedA2);
		expect(stored).toEqual(snapshot);
		expect(result.items[2]).toMatchObject({ section_id: 2, section_tipo: 'test3', type: 'dd151' });
		expect((result.items[2] as AppendItem).id).toBeUndefined();
		// id + paginated_key stripped before the law; existing = stored (+ accepted)
		expect(calls[0]?.raw).toEqual({ section_id: 2, section_tipo: 'test3' });
		expect(calls[0]?.existing).toEqual(stored);
		expect(result.skipped).toEqual([]);
	});

	test('a duplicate of a stored locator is skipped and maps to the EXISTING id', async () => {
		const calls: { raw: AppendItem; existing: readonly unknown[] }[] = [];
		const result = await mergeAppend(
			input({
				family: 'relation',
				stored: [storedA],
				incoming: [
					{ id: 10, section_id: '1', section_tipo: 'test3' },
					{ id: 11, section_id: 5, section_tipo: 'test3' },
					{ id: 12, section_id: 5, section_tipo: 'test3' },
				],
				validateRelation: fakeLaw(calls),
			}),
		);
		expect(result.items.length).toBe(2);
		expect(result.skipped).toEqual([
			{ index: 0, reason: 'duplicate' },
			{ index: 2, reason: 'duplicate' },
		]);
		// the third call saw stored + the accepted second locator
		expect(calls[2]?.existing.length).toBe(2);
		// allocation stamps new items in place, then the map resolves
		(result.items[1] as AppendItem).id = 44;
		const map = resolveAppendedIdMap(result.idMapPlan);
		expect(map.get('10')).toBe(1);
		expect(map.get('11')).toBe(44);
		expect(map.get('12')).toBe(44);
	});

	test('a drop the law makes for another reason (bad form) pairs with nothing', async () => {
		const law: RelationAppendValidator = async () => ({ value: null, code: 'bad_form' });
		const result = await mergeAppend(
			input({
				family: 'relation',
				stored: [storedA],
				incoming: [{ id: 3, section_tipo: 'test3' }, 'scalar'],
				validateRelation: law,
			}),
		);
		expect(result.items).toEqual([storedA]);
		expect(result.skipped).toEqual([
			{ index: 0, reason: 'dropped' },
			{ index: 1, reason: 'dropped' },
		]);
		expect(result.idMapPlan).toEqual([]);
	});

	test('a duplicate pairs with the item the LAW matched, never a re-derived key', async () => {
		// two stored locators to the same record differing only in type (legacy
		// mixed-type slot); the law (which fills `type`) matched the SECOND
		const typedA = { ...storedA, id: 7, type: 'dd96' };
		const result = await mergeAppend(
			input({
				family: 'relation',
				stored: [storedA, typedA],
				incoming: [{ id: 30, section_id: 1, section_tipo: 'test3' }],
				validateRelation: async () => ({ value: null, code: 'duplicate', duplicateOf: typedA }),
			}),
		);
		expect(result.skipped).toEqual([{ index: 0, reason: 'duplicate' }]);
		expect(resolveAppendedIdMap(result.idMapPlan).get('30')).toBe(7);
	});

	test('a non-duplicate drop never becomes a duplicate, even when an address matches', async () => {
		const result = await mergeAppend(
			input({
				family: 'relation',
				stored: [storedA],
				incoming: [{ id: 31, section_id: 1, section_tipo: 'test3' }],
				validateRelation: async () => ({ value: null, code: 'autoreference' }),
			}),
		);
		expect(result.skipped).toEqual([{ index: 0, reason: 'dropped' }]);
		expect(result.idMapPlan).toEqual([]);
	});

	test('a duplicate of an ID-LESS stored locator resolves by reference after allocation', async () => {
		const legacy = {
			type: 'dd151',
			section_id: 5,
			section_tipo: 'test3',
			from_component_tipo: TIPO,
		};
		const result = await mergeAppend(
			input({
				family: 'relation',
				stored: [legacy],
				incoming: [{ id: 32, section_id: 5, section_tipo: 'test3' }],
				validateRelation: async () => ({ value: null, code: 'duplicate', duplicateOf: legacy }),
			}),
		);
		expect(result.items[0]).toBe(legacy);
		// the engine's allocation loop stamps the stored object in place
		(legacy as AppendItem).id = 88;
		expect(resolveAppendedIdMap(result.idMapPlan).get('32')).toBe(88);
	});

	test('a dataframe frame duplicate pairs with the frame the law matched', async () => {
		const frame = {
			id: 9,
			type: 'dd490',
			section_id: 4,
			section_tipo: 'test3',
			from_component_tipo: TIPO,
			main_component_tipo: 'test52',
			id_key: 1,
		};
		const result = await mergeAppend(
			input({
				family: 'relation',
				stored: [frame],
				incoming: [
					{
						id: 20,
						type: 'dd490',
						section_id: 4,
						section_tipo: 'test3',
						from_component_tipo: TIPO,
						main_component_tipo: 'test52',
						id_key: 1,
					},
				],
				validateRelation: async () => ({ value: null, code: 'duplicate', duplicateOf: frame }),
			}),
		);
		expect(result.skipped).toEqual([{ index: 0, reason: 'duplicate' }]);
		expect(resolveAppendedIdMap(result.idMapPlan).get('20')).toBe(9);
	});

	test('a constraint refusal thrown by the law propagates (the row rolls back)', async () => {
		const law: RelationAppendValidator = async () => {
			throw new Error('selection_limit');
		};
		await expect(
			mergeAppend(
				input({
					family: 'relation',
					stored: [],
					incoming: [{ section_id: 1, section_tipo: 'test3' }],
					validateRelation: law,
				}),
			),
		).rejects.toThrow('selection_limit');
	});

	test('a relation append without the injected law is an invariant breach', async () => {
		await expect(mergeAppend(input({ family: 'relation', incoming: [{}] }))).rejects.toThrow(
			/without the insert-law validator/,
		);
	});
});

describe('literals (items)', () => {
	test('an EMPTY entry is skipped as empty — never appended, never deduplicated', async () => {
		const stored = [{ id: 1, lang: 'lg-spa', value: 'kept' }];
		const result = await mergeAppend(
			input({
				langSliced: true,
				stored,
				incoming: [{ value: '' }, { value: null }, {}, { value: 'x' }],
			}),
		);
		expect(result.items).toEqual([...stored, { lang: 'lg-spa', value: 'x' }]);
		expect(result.skipped).toEqual([
			{ index: 0, reason: 'empty' },
			{ index: 1, reason: 'empty' },
			{ index: 2, reason: 'empty' },
		]);
	});

	test("isEmptyLiteralItem reads each family's identity fields", () => {
		expect(isEmptyLiteralItem({ value: '' }, 'string')).toBe(true);
		expect(isEmptyLiteralItem({ value: 0 }, 'number')).toBe(false);
		expect(isEmptyLiteralItem({ value: null }, 'number')).toBe(true);
		// iri (T0-12 / D5): blank iri AND blank deprecated title — a label is the
		// frame's, never item identity, so a label_id alone does not make an item.
		expect(isEmptyLiteralItem({ iri: '', title: null }, 'iri')).toBe(true);
		expect(isEmptyLiteralItem({ iri: '', label_id: 3 }, 'iri')).toBe(true);
		expect(isEmptyLiteralItem({ iri: '', title: 'T' }, 'iri')).toBe(false);
		expect(isEmptyLiteralItem({ iri: 'https://example.org/a' }, 'iri')).toBe(false);
		expect(isEmptyLiteralItem({ id: 4, lang: 'lg-spa' }, 'date')).toBe(true);
		expect(isEmptyLiteralItem({ start: { year: 2000 } }, 'date')).toBe(false);
		expect(isEmptyLiteralItem('not an item', 'string')).toBe(false);
	});

	test('a duplicate of an ID-LESS stored item resolves by reference after allocation', async () => {
		const legacy: AppendItem = { value: 'a', lang: 'lg-spa' };
		const result = await mergeAppend(
			input({ langSliced: true, stored: [legacy], incoming: [{ id: 7, value: 'a' }] }),
		);
		expect(result.items).toEqual([legacy]);
		expect(result.skipped).toEqual([{ index: 0, reason: 'duplicate' }]);
		legacy.id = 3; // the engine's allocation loop stamps the stored object
		expect(resolveAppendedIdMap(result.idMapPlan).get('7')).toBe(3);
	});

	test('items with no lang and other-lang items survive; dedup only inside the lang slice', async () => {
		const noLang = { id: 1, value: 'orphan' };
		const eng = { id: 2, lang: 'lg-eng', value: 'same' };
		const spa = { id: 2, lang: 'lg-spa', value: 'mismo' };
		const stored = [noLang, eng, spa];
		const result = await mergeAppend(
			input({
				langSliced: true,
				stored,
				incoming: [
					{ id: 50, value: 'same' }, // exists only in lg-eng → NEW in lg-spa
					{ id: 51, value: 'mismo' }, // duplicate in lg-spa
				],
				preallocatedIds: [3],
			}),
		);
		expect(result.items[0]).toBe(noLang);
		expect(result.items[1]).toBe(eng);
		expect(result.items[2]).toBe(spa);
		expect(result.items[3]).toEqual({ id: 3, lang: 'lg-spa', value: 'same' });
		expect(result.items.length).toBe(4);
		expect(result.skipped).toEqual([{ index: 1, reason: 'duplicate' }]);
		const map = resolveAppendedIdMap(result.idMapPlan);
		expect(map.get('50')).toBe(3);
		expect(map.get('51')).toBe(2);
	});

	test('a file id is stripped (never persisted) when nothing was pre-allocated', async () => {
		const result = await mergeAppend(input({ incoming: [{ id: 99, value: 'x' }] }));
		expect(result.items).toEqual([{ value: 'x' }]);
		expect(() => resolveAppendedIdMap(result.idMapPlan)).toThrow(/before id allocation/);
	});

	test('a value repeated inside the incoming cell lands once', async () => {
		const result = await mergeAppend(input({ incoming: [{ value: 'a' }, { value: 'a' }] }));
		expect(result.items).toEqual([{ value: 'a' }]);
		expect(result.skipped).toEqual([{ index: 1, reason: 'duplicate' }]);
	});

	test('date equality ignores the engine-computed time', async () => {
		const stored = [{ id: 1, start: { year: 1999, month: 1, day: 1, time: 64249459200 } }];
		const result = await mergeAppend(
			input({
				family: 'date',
				stored,
				incoming: [
					{ start: { day: 1, month: 1, year: 1999 } },
					{ start: { year: 1999, month: 1, day: 2 } },
				],
			}),
		);
		expect(result.skipped).toEqual([{ index: 0, reason: 'duplicate' }]);
		expect(result.items.length).toBe(2);
		expect(result.items[0]).toBe(stored[0]);
	});

	test('date: a flat time-mode item with a stored TOP-LEVEL time is a duplicate', async () => {
		const stored = [{ id: 1, hour: 10, minute: 5, time: 36300 }];
		const result = await mergeAppend(
			input({ family: 'date', stored, incoming: [{ hour: 10, minute: 5 }] }),
		);
		expect(result.skipped).toEqual([{ index: 0, reason: 'duplicate' }]);
		expect(result.items).toEqual([stored[0]]);
		expect(result.items[0]).toBe(stored[0]);
		const langStored = [{ ...stored[0], lang: 'lg-nolan' }];
		expect(literalDuplicateIds(langStored, { hour: 10, minute: 5 }, 'date', 'lg-nolan')).toEqual([
			1,
		]);
	});

	test('date: a range with a different end is not a duplicate', async () => {
		const stored = [{ id: 1, start: { year: 2000, time: 1 }, end: { year: 2001, time: 2 } }];
		const result = await mergeAppend(
			input({ family: 'date', stored, incoming: [{ start: { year: 2000 }, end: { year: 2002 } }] }),
		);
		expect(result.items.length).toBe(2);
	});

	test('date: period-mode items compare their period (no start/end is not "equal")', async () => {
		const stored = [{ id: 1, period: { year: 5 } }];
		const result = await mergeAppend(
			input({
				family: 'date',
				stored,
				incoming: [{ period: { year: 10 } }, { period: { year: 5 } }],
			}),
		);
		expect(result.skipped).toEqual([{ index: 1, reason: 'duplicate' }]);
		expect(result.items).toEqual([stored[0], { period: { year: 10 } }]);
		expect(result.items[0]).toBe(stored[0]);
		const langStored = [{ id: 1, lang: 'lg-nolan', period: { year: 5 } }];
		expect(literalDuplicateIds(langStored, { period: { year: 10 } }, 'date', 'lg-nolan')).toEqual(
			[],
		);
		expect(literalDuplicateIds(langStored, { period: { year: 5 } }, 'date', 'lg-nolan')).toEqual([
			1,
		]);
	});

	test('date: a period is not a duplicate of an edge-only item, nor the reverse', async () => {
		const result = await mergeAppend(
			input({
				family: 'date',
				stored: [{ id: 1, start: { year: 2000 } }],
				incoming: [{ start: { year: 2000 }, period: { year: 3 } }],
			}),
		);
		expect(result.skipped).toEqual([]);
		expect(result.items.length).toBe(2);
	});

	test('number compares numerically; iri compares the iri ONLY (D3: the label is the frame)', async () => {
		const numbers = await mergeAppend(
			input({
				family: 'number',
				stored: [{ id: 1, value: 5 }],
				incoming: [{ value: '5.0' }, { value: 6 }],
			}),
		);
		expect(numbers.skipped).toEqual([{ index: 0, reason: 'duplicate' }]);
		expect(numbers.items.length).toBe(2);

		const iris = await mergeAppend(
			input({
				family: 'iri',
				stored: [{ id: 1, iri: 'https://example.org/a', title: 'old' }],
				incoming: [
					{ iri: 'https://example.org/a' },
					// a different deprecated title is still the same item (D3, stated)
					{ iri: 'https://example.org/a', title: 'new' },
					{ iri: 'https://example.org/b' },
				],
			}),
		);
		expect(iris.skipped).toEqual([
			{ index: 0, reason: 'duplicate' },
			{ index: 1, reason: 'duplicate' },
		]);
		expect(iris.items.length).toBe(2);
	});

	test('iri: two TITLE-ONLY items (blank iris) are told apart by their title (D3 + D5)', async () => {
		const stored = [{ id: 1, lang: 'lg-nolan', title: 'A' }];
		// a different title is a different item — never a silent "duplicate"
		expect(literalDuplicateIds(stored, { title: 'B' }, 'iri', 'lg-nolan')).toEqual([]);
		expect(literalDuplicateIds(stored, { title: 'A' }, 'iri', 'lg-nolan')).toEqual([1]);
		// an iri item never matches a title-only one, whatever the titles
		expect(
			literalDuplicateIds(stored, { iri: 'https://example.org/a', title: 'A' }, 'iri', 'lg-nolan'),
		).toEqual([]);
		const merged = await mergeAppend(
			input({ family: 'iri', stored, incoming: [{ title: 'B' }, { title: 'A' }] }),
		);
		expect(merged.skipped).toEqual([{ index: 1, reason: 'duplicate' }]);
		expect(merged.items.length).toBe(2);
	});

	test('literalEqualityFamilyOf maps the special families and defaults to value', () => {
		expect(literalEqualityFamilyOf('component_date')).toBe('date');
		expect(literalEqualityFamilyOf('component_iri')).toBe('iri');
		expect(literalEqualityFamilyOf('component_number')).toBe('number');
		expect(literalEqualityFamilyOf('component_input_text')).toBe('string');
	});
});

describe('geolocation (geo_layer)', () => {
	const pointFeature = (layerId: unknown, lon: number, lat: number) => ({
		type: 'Feature',
		properties: { layer_id: layerId },
		geometry: { type: 'Point', coordinates: [lon, lat] },
	});

	test('nothing stored: the conformed item is stored as is', async () => {
		const incoming = [{ lat: 1, lon: 2, zoom: 16, alt: 0 }];
		const result = await mergeAppend(input({ policy: 'geo_layer', incoming }));
		expect(result.items).toEqual(incoming);
	});

	test('several stored items + string layer ids: fresh id above every numeric id, stored kept', () => {
		const host = {
			id: 3,
			lat: 28.7,
			lon: -17.8,
			zoom: 17,
			alt: 16,
			lib_data: [
				{
					layer_id: '3',
					layer_data: { type: 'FeatureCollection', features: [pointFeature(7, 1, 1)] },
				},
				{ layer_id: 'raster', layer_data: { type: 'FeatureCollection', features: [] } },
			],
		};
		const second = {
			id: 4,
			lat: 1,
			lon: 1,
			lib_data: [{ layer_id: 5, layer_data: { type: 'FeatureCollection', features: [] } }],
		};
		const stored = [host, second];
		const snapshot = structuredClone(stored);
		const incomingLayer = {
			layer_id: 1,
			layer_data: {
				type: 'FeatureCollection',
				features: [pointFeature(1, 9, 9), pointFeature(1, 8, 8)],
			},
		};
		const incoming = [{ lat: 9, lon: 9, lib_data: [incomingLayer] }];
		const incomingSnapshot = structuredClone(incoming);

		const result = mergeGeoLayers(stored, incoming);
		expect(stored).toEqual(snapshot);
		expect(incoming).toEqual(incomingSnapshot);
		expect(result.items[1]).toBe(second);
		const merged = result.items[0] as typeof host;
		expect(merged).not.toBe(host);
		// centre + framing untouched, stored layers by reference
		expect([merged.lat, merged.lon, merged.zoom, merged.alt]).toEqual([28.7, -17.8, 17, 16]);
		expect(merged.lib_data[0]).toBe(host.lib_data[0]);
		expect(merged.lib_data[1]).toBe(host.lib_data[1]);
		// max(3, 7, 5) + 1 = 8, features remapped, name layer_8
		const added = merged.lib_data[2] as unknown as {
			layer_id: number;
			user_layer_name: string;
			layer_data: { features: { properties: { layer_id: unknown } }[] };
		};
		expect(added.layer_id).toBe(8);
		expect(added.user_layer_name).toBe('layer_8');
		expect(added.layer_data.features.map((f) => f.properties.layer_id)).toEqual([8, 8]);
		expect(merged.lib_data.length).toBe(3);
	});

	test('a flat point becomes a Point layer; the stored centre never moves', () => {
		const host = { id: 1, lat: 40, lon: -3, zoom: 16, alt: 0 };
		const result = mergeGeoLayers([host], [{ lat: 41.5, lon: 2.25, zoom: 16, alt: 0 }]);
		const merged = result.items[0] as AppendItem;
		expect([merged.lat, merged.lon]).toEqual([40, -3]);
		expect(merged.lib_data).toEqual([
			{
				layer_id: 1,
				user_layer_name: 'layer_1',
				layer_data: { type: 'FeatureCollection', features: [pointFeature(1, 2.25, 41.5)] },
			},
		]);
	});

	test('re-importing a flat point stored as a bare centre is a no-op (no duplicate centre layer)', () => {
		const flat = { lat: 40, lon: -3, zoom: 16, alt: 0 };
		const first = mergeGeoLayers([], [flat]);
		expect(first.items).toEqual([flat]);
		const stored = [{ id: 1, ...flat }];
		const again = mergeGeoLayers(stored, [flat]);
		expect(again.items[0]).toBe(stored[0]);
		expect(again.skipped).toEqual([{ index: 0, reason: 'duplicate' }]);
		// a DIFFERENT point is still added
		const other = mergeGeoLayers(stored, [{ lat: 41, lon: -3 }]);
		expect((other.items[0] as AppendItem).lib_data).toHaveLength(1);
	});

	test('nothing stored: later incoming items fold into the FIRST as layers (single-value model)', () => {
		const first = { lat: 1, lon: 2 };
		const result = mergeGeoLayers([], [first, { lat: 3, lon: 4 }, { lat: 1, lon: 2 }]);
		expect(result.items).toEqual([
			{
				lat: 1,
				lon: 2,
				lib_data: [
					{
						layer_id: 1,
						user_layer_name: 'layer_1',
						layer_data: { type: 'FeatureCollection', features: [pointFeature(1, 4, 3)] },
					},
				],
			},
		]);
		// the host's own centre is known: a repeat of it is a duplicate, not a layer
		expect(result.skipped).toEqual([{ index: 2, reason: 'duplicate' }]);
		expect(first).toEqual({ lat: 1, lon: 2 });
		// a single incoming item is stored as is
		expect(mergeGeoLayers([], [first]).items[0]).toBe(first);
	});

	test('re-importing the same layer (conformed as layer 1, stored as layer 2) changes nothing', () => {
		const host = {
			id: 1,
			lat: 40,
			lon: -3,
			lib_data: [
				{
					layer_id: 1,
					layer_data: { type: 'FeatureCollection', features: [pointFeature(1, 0, 0)] },
				},
				{
					layer_id: 2,
					user_layer_name: 'layer_2',
					layer_data: { type: 'FeatureCollection', features: [pointFeature(2, 5, 6)] },
				},
			],
		};
		const stored = [host];
		const result = mergeGeoLayers(stored, [
			{
				lat: 6,
				lon: 5,
				lib_data: [
					{
						layer_id: 1,
						layer_data: { type: 'FeatureCollection', features: [pointFeature(1, 5, 6)] },
					},
				],
			},
			{ lat: 6, lon: 5 },
		]);
		expect(result.items[0]).toBe(host);
		expect(result.skipped).toEqual([
			{ index: 0, reason: 'duplicate' },
			{ index: 1, reason: 'duplicate' },
		]);
	});
});

describe('text_area (text_paragraphs)', () => {
	test('per lang: stored + <p>imported</p>; other langs and the stored object untouched', async () => {
		const spa = { id: 1, lang: 'lg-spa', value: '<p>uno</p>' };
		const eng = { id: 1, lang: 'lg-eng', value: '<p>one</p>' };
		const stored = [eng, spa];
		const snapshot = structuredClone(stored);
		const result = await mergeAppend(
			input({
				policy: 'text_paragraphs',
				langSliced: true,
				stored,
				incoming: [{ id: 6, value: 'dos' }],
			}),
		);
		expect(stored).toEqual(snapshot);
		expect(result.items[0]).toBe(eng);
		expect(result.items[1]).toEqual({ id: 1, lang: 'lg-spa', value: '<p>uno</p><p>dos</p>' });
		expect(resolveAppendedIdMap(result.idMapPlan).get('6')).toBe(1);
	});

	test('a duplicate of an ID-LESS stored text item resolves by reference after allocation', async () => {
		const legacy: AppendItem = { lang: 'lg-spa', value: '<p>uno</p>' };
		const result = await mergeAppend(
			input({
				policy: 'text_paragraphs',
				langSliced: true,
				stored: [legacy],
				incoming: [{ id: 7, value: 'uno' }],
			}),
		);
		expect(result.items[0]).toBe(legacy);
		expect(result.skipped).toEqual([{ index: 0, reason: 'duplicate' }]);
		legacy.id = 55; // the allocation loop stamps the stored object
		expect(resolveAppendedIdMap(result.idMapPlan).get('7')).toBe(55);
	});

	test('a paragraph already present is skipped (re-import changes nothing)', async () => {
		const spa = { id: 1, lang: 'lg-spa', value: '<p>uno</p><p>dos</p>' };
		const result = await mergeAppend(
			input({
				policy: 'text_paragraphs',
				langSliced: true,
				stored: [spa],
				incoming: [{ value: 'dos' }],
			}),
		);
		expect(result.items[0]).toBe(spa);
		expect(result.skipped).toEqual([{ index: 0, reason: 'duplicate' }]);
	});

	test('no stored item in the lang: a new item, and a second paragraph extends that same object', async () => {
		const eng = { id: 1, lang: 'lg-eng', value: '<p>one</p>' };
		const result = await mergeAppend(
			input({
				policy: 'text_paragraphs',
				langSliced: true,
				stored: [eng],
				incoming: [
					{ id: 30, value: 'a' },
					{ id: 31, value: '<p>b</p>' },
				],
			}),
		);
		expect(result.items.length).toBe(2);
		const created = result.items[1] as AppendItem;
		expect(created).toEqual({ lang: 'lg-spa', value: '<p>a</p><p>b</p>' });
		created.id = 12;
		const map = resolveAppendedIdMap(result.idMapPlan);
		expect(map.get('30')).toBe(12);
		expect(map.get('31')).toBe(12);
	});

	test.each([
		['[index-n-1-label-data::data]x[/index-n-1-label-data::data]'],
		['[TC_00:00:08.512_TC] text'],
		['[geo-n-10-10-data::data]'],
		["[person-a-1-JavNa-data:{'section_tipo':'test3'}:data]"],
		['[reference-n-1-ref-data::data]x'],
		['<img id="[index-n-1-]" src="x" class="index" data-type="indexIn">'],
	])('a value carrying a Dédalo tag is refused: %s', async (value) => {
		expect(containsDedaloTag(value)).toBe(true);
		await expect(
			mergeAppend(input({ policy: 'text_paragraphs', langSliced: true, incoming: [{ value }] })),
		).rejects.toThrow(/Dédalo tags/);
	});

	test('plain text with brackets is not a tag', () => {
		expect(containsDedaloTag('see [1] and [note] and <p>x</p>')).toBe(false);
	});

	test('paragraphFragment wraps once', () => {
		expect(paragraphFragment(' a ')).toBe('<p>a</p>');
		expect(paragraphFragment('<p class="x">a</p>')).toBe('<p class="x">a</p>');
	});
});

describe('refuse policy (engine backstop)', () => {
	test('a refusing model throws with its reason', async () => {
		await expect(
			mergeAppend(
				input({ policy: { refuse: 'media: files are not appended' }, incoming: [{ value: 'x' }] }),
			),
		).rejects.toThrow(/refuses append \(media: files are not appended\)/);
	});
});

describe('ids of a new translation (lang-sliced literals)', () => {
	const spaStored = { id: 1, lang: 'lg-spa', value: '<p>a</p>' };

	test('text_area: a first translation takes the sibling language id', async () => {
		const positions: number[] = [];
		const result = await mergeAppend(
			input({
				policy: 'text_paragraphs',
				langSliced: true,
				lang: 'lg-eng',
				stored: [spaStored],
				incoming: [{ value: 'b' }],
				siblingIdAt: (position) => {
					positions.push(position);
					return position === 0 ? 1 : null;
				},
			}),
		);
		expect(positions).toEqual([0]);
		expect(result.items[0]).toBe(spaStored);
		expect(result.items[1]).toEqual({ id: 1, lang: 'lg-eng', value: '<p>b</p>' });
	});

	test('input_text: the sibling id at the slice position, never one the slice already holds', async () => {
		const stored = [
			{ id: 1, lang: 'lg-spa', value: 'uno' },
			{ id: 2, lang: 'lg-spa', value: 'dos' },
			{ id: 2, lang: 'lg-eng', value: 'two' },
		];
		// eng position 1 → spa position 1 is id 2, which eng already holds
		const result = await mergeAppend(
			input({
				langSliced: true,
				lang: 'lg-eng',
				stored,
				incoming: [{ value: 'one' }],
				siblingIdAt: (position) => (position === 1 ? 2 : null),
			}),
		);
		const added = result.items[3] as AppendItem;
		expect(added).toEqual({ lang: 'lg-eng', value: 'one' }); // id-less: the engine allocates
	});

	test('a pre-allocated id wins over the sibling id', async () => {
		const result = await mergeAppend(
			input({
				langSliced: true,
				lang: 'lg-eng',
				stored: [spaStored],
				incoming: [{ value: 'b' }],
				preallocatedIds: [7],
				siblingIdAt: () => 1,
			}),
		);
		expect((result.items[1] as AppendItem).id).toBe(7);
	});

	test('a sibling id reserved for another incoming position is not taken', async () => {
		const result = await mergeAppend(
			input({
				langSliced: true,
				lang: 'lg-eng',
				stored: [],
				incoming: [{ value: 'x' }, { value: 'y' }],
				preallocatedIds: [undefined, 4],
				siblingIdAt: () => 4,
			}),
		);
		expect((result.items[0] as AppendItem).id).toBeUndefined();
		expect((result.items[1] as AppendItem).id).toBe(4);
	});

	test('a pre-allocated id the slice already holds is refused loudly', async () => {
		await expect(
			mergeAppend(
				input({
					langSliced: true,
					lang: 'lg-eng',
					stored: [{ id: 3, lang: 'lg-eng', value: 'one' }],
					incoming: [{ value: 'one (rev)' }],
					preallocatedIds: [3],
				}),
			),
		).rejects.toThrow(/already holds an item 3 in lg-eng/);
	});

	test('literalDuplicateIds: the stored ids an entry duplicates, in its own slice only', () => {
		const stored = [
			{ id: 5, lang: 'lg-spa', value: 'dos' },
			{ id: 6, lang: 'lg-eng', value: 'dos' },
			{ lang: 'lg-spa', value: 'dos' },
		];
		expect(literalDuplicateIds(stored, { value: 'dos' }, 'string', 'lg-spa')).toEqual([5]);
		expect(literalDuplicateIds(stored, { value: 'tres' }, 'string', 'lg-spa')).toEqual([]);
	});
});
