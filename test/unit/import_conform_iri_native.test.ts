/**
 * component_iri IMPORT CONFORM gate — `conformIri` + `conformIriRecord`
 * (`src/core/tools/import_conform.ts`).
 *
 * T0-12: a LABEL never lands on the item. Conform returns the clean item and,
 * beside it, a typed intent (`derivedFrames`: slot dd560, the item's position,
 * the dd1706 record id or label text) that the executor resolves and writes as
 * the item's dd560 frame inside the row transaction. A label with no iri (and
 * no deprecated title) is refused. The write half is gated by
 * `import_iri_label_native.test.ts`.
 *
 * WHY THIS FILE EXISTS: this parser is DATA-CORRUPTION class. A wrong conform
 * does not error — it quietly writes the wrong thing into every affected cell
 * of a whole import, and nothing downstream can tell the difference by
 * inspection. `import_conform.test.ts` gates exactly three json cases; the
 * lang-keyed branch, the ENTIRE plain-string branch, every `conformIriRecord`
 * arm (including the SECOND-FIELD overwrite — the only place
 * `fields_separator` is load-bearing) and the `javascript:` refusal were dark.
 *
 * Scratch surface: dd_ontology tipo `test9761` ONLY (the configured-separator
 * node), pre-cleaned in beforeAll and swept in afterAll with a fail-loud
 * 0-row check. No matrix row is written; everything else here is pure.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../../src/core/db/postgres.ts';
import { clearOntologyCaches } from '../../src/core/ontology/resolver.ts';
import { conformImportData, type IriLabelIntent } from '../../src/core/tools/import_data.ts';

/** A flat-cell label intent at `item`. */
function intent(
	item: number,
	target: IriLabelIntent['target'],
	lang: string | null = null,
): IriLabelIntent {
	return { slot: 'dd560', lang, item, target };
}

/** The scratch component_iri node carrying NON-default separators. */
const CONFIGURED_TIPO = 'test9761';

function conform(importValue: string, componentTipo = 't1') {
	return conformImportData({
		model: 'component_iri',
		importValue,
		columnName: componentTipo,
		sectionTipo: 'test3',
		sectionId: 7,
		componentTipo,
		lang: 'lg-nolan',
		wrapped: false,
	});
}

async function sweepScratch(expectRows: boolean): Promise<void> {
	const deleted = (await sql`
		DELETE FROM dd_ontology WHERE tipo = ${CONFIGURED_TIPO} RETURNING tipo
	`) as { tipo: string }[];
	if (expectRows && deleted.length === 0) {
		throw new Error(`scratch sweep deleted 0 rows for ${CONFIGURED_TIPO} — the node vanished`);
	}
	clearOntologyCaches();
}

beforeAll(async () => {
	await sweepScratch(false); // crashed-run belt and braces
	await sql.unsafe(
		`INSERT INTO dd_ontology (id, tipo, parent, model, tld, properties, is_translatable, term)
		 VALUES ((SELECT COALESCE(MAX(id), 0) + 1 FROM dd_ontology), $1, 'test3', 'component_iri', 'test', $2::text::jsonb, false, $3::text::jsonb)`,
		[
			CONFIGURED_TIPO,
			JSON.stringify({ records_separator: ';;', fields_separator: '::' }),
			JSON.stringify({ 'lg-spa': CONFIGURED_TIPO }),
		],
	);
	clearOntologyCaches();
});

afterAll(async () => {
	await sweepScratch(true);
});

describe('conformIriRecord — the per-record arms', () => {
	test('protocol-first: the whole record IS the iri', async () => {
		// Corruption prevented: a bare iri cell silently arriving as a label id.
		const out = await conform('https://a.test/1');
		expect(out.errors).toHaveLength(0);
		expect(out.result).toEqual([{ iri: 'https://a.test/1' }]);
	});

	test('an all-digits label token becomes an INT record-id INTENT, never a key of the item', async () => {
		// Corruption prevented: the stray `label_id` key on the stored item (T0-12),
		// or a dd1706 label id stored as a STRING (or as an iri).
		const out = await conform('273418, https://a.test/coin');
		expect(out.errors).toHaveLength(0);
		expect(out.result).toEqual([{ iri: 'https://a.test/coin' }]);
		expect(out.derivedFrames).toEqual([intent(0, { section_id: 273418 })]);
	});

	test('a TEXT label becomes a find-or-create INTENT (no write at conform time)', async () => {
		const out = await conform('nomisma, https://a.test/coin');
		expect(out.errors).toHaveLength(0);
		expect(out.result).toEqual([{ iri: 'https://a.test/coin' }]);
		expect(out.derivedFrames).toEqual([intent(0, { label: 'nomisma' })]);
	});

	test('a record with a label and NO iri is REFUSED — a label needs an iri', async () => {
		const out = await conform('nomisma, not-a-url');
		expect(out.result).toBeNull();
		expect(out.errors[0]?.msg).toContain('a label needs an iri');
	});

	test('an unlabelled cell carries no intent at all', async () => {
		const out = await conform('https://a.test/1');
		expect(out.derivedFrames).toBeUndefined();
	});

	test('an EMPTY record inside a multi-record cell fails the whole cell', async () => {
		// Corruption prevented: a trailing separator silently contributing an
		// empty {} record to the stored dato.
		const out = await conform('https://a.test/1 | ');
		expect(out.result).toBeNull();
		expect(out.errors[0]?.msg).toContain('IGNORED: malformed data');
	});

	test('THE SECOND-FIELD ARM: a protocol in field 2 OVERWRITES the iri from field 1', async () => {
		// Corruption prevented: this is the ONLY place fields_separator changes
		// the stored value. Dropping the arm keeps the FIRST url and discards the
		// real target iri of every two-url record in the import.
		const out = await conform('https://label.test/x, https://a.test/real');
		expect(out.errors).toHaveLength(0);
		expect(out.result).toEqual([{ iri: 'https://a.test/real' }]);
	});

	test('a THIRD field is ignored — only fields[0] and fields[1] are read', async () => {
		const out = await conform('12, https://a.test/real, https://a.test/ignored');
		expect(out.result).toEqual([{ iri: 'https://a.test/real' }]);
		expect(out.derivedFrames).toEqual([intent(0, { section_id: 12 })]);
	});

	/**
	 * Human CSV carries stray whitespace around the separator. Without the
	 * per-field trim, '42 ' stops matching /^[0-9]+$/ and the record falls into
	 * the TEXT-label arm — the whole column is refused on a cell that is
	 * perfectly well formed. This is the case that makes the trim load-bearing.
	 */
	test('each field is TRIMMED — a padded label id is still an INT, not a text label', async () => {
		const out = await conform('42 ,  https://a.test/pad ');
		expect(out.errors).toHaveLength(0);
		expect(out.result).toEqual([{ iri: 'https://a.test/pad' }]);
		expect(out.derivedFrames).toEqual([intent(0, { section_id: 42 })]);
	});
});

describe('the plain-string branch — the DEFAULT separators are the human CSV contract', () => {
	test("' | ' splits records and ', ' splits fields — exact count and each record", async () => {
		// Corruption prevented: a default-separator drift makes a five-value column
		// parse as ONE garbage record for every human-authored CSV ever imported.
		const out = await conform(
			'https://a.test/1 | 42, https://a.test/2 | https://l.test/3, https://a.test/3',
		);
		expect(out.errors).toHaveLength(0);
		expect(out.result).toHaveLength(3);
		expect(out.result).toEqual([
			{ iri: 'https://a.test/1' },
			{ iri: 'https://a.test/2' },
			{ iri: 'https://a.test/3' },
		]);
		// the intent indexes the item it labels; a url in field 1 is no label
		expect(out.derivedFrames).toEqual([intent(1, { section_id: 42 })]);
	});

	test('a cell with neither separator nor protocol is REFUSED', async () => {
		const out = await conform('just some text');
		expect(out.result).toBeNull();
		expect(out.errors[0]?.msg).toBe('IGNORED: malformed data just some text');
	});

	test('an empty cell is a CLEAR (null result), not an error', async () => {
		const out = await conform('');
		expect(out.errors).toHaveLength(0);
		expect(out.result).toBeNull();
	});

	test('a plain-bracket string is refused BEFORE the protocol check', async () => {
		// Corruption prevented: dropping the isPlainBracketString guard stores a
		// half-serialized json fragment as a live iri (the `"]` tail and all),
		// because the protocol check alone is happy with it.
		const out = await conform('https://a.test/1"]');
		expect(out.result).toBeNull();
		expect(out.errors[0]?.msg).toContain('IGNORED: malformed data');
	});

	test("the default field separator is ', ' — a bare comma does NOT split fields", async () => {
		// Corruption prevented: loosening the default to ',' makes every cell that
		// merely CONTAINS a comma parse as a label+iri pair, so the label half of
		// a plain text cell is silently reinterpreted.
		const out = await conform('42,https://a.test/2');
		expect(out.result).toBeNull();
		expect(out.errors[0]?.msg).toBe('IGNORED: malformed data 42,https://a.test/2');
	});
});

describe('the protocol allowlist — http/https ONLY', () => {
	test('javascript: is REFUSED', async () => {
		// Corruption prevented: widening hasProtocol to "any scheme" stores
		// `javascript:alert(1)` as a LIVE LINK in a field published to public
		// sites. The generic "no protocol ⇒ refusal" case passes under a widened
		// check; this one does not.
		const out = await conform('javascript:alert(1)');
		expect(out.result).toBeNull();
		expect(out.errors[0]?.msg).toContain('IGNORED: malformed data');
	});

	test('a javascript: URI hiding in the SECOND field is not adopted as the iri', async () => {
		// The javascript: token must NOT become item.iri — and the label alone is
		// no item (T0-12): the cell is refused.
		const out = await conform('42, javascript:alert(1)');
		expect(out.result).toBeNull();
		expect(out.errors[0]?.msg).toContain('a label needs an iri');
	});

	test('file:// and ftp:// are refused too', async () => {
		expect((await conform('file:///etc/passwd')).result).toBeNull();
		expect((await conform('ftp://a.test/1')).result).toBeNull();
	});

	test('a json iri with a non-http scheme is refused', async () => {
		const out = await conform('[{"iri":"javascript:alert(1)"}]');
		expect(out.result).toBeNull();
		expect(out.errors[0]?.msg).toContain('IGNORED: malformed data');
	});
});

describe('the LANG-KEYED json branch — the most common real CSV shape', () => {
	test('per-lang ARRAY and per-lang SCALAR both normalize to a list', async () => {
		const out = await conform(
			'{"lg-eng":[{"iri":"https://a.test/1"}],"lg-spa":{"iri":"https://a.test/2"}}',
		);
		expect(out.errors).toHaveLength(0);
		expect(out.result).toEqual({
			'lg-eng': [{ iri: 'https://a.test/1' }],
			'lg-spa': [{ iri: 'https://a.test/2' }],
		});
	});

	test('a lang-keyed iri is TRIMMED, its sibling keys survive, its label_id becomes an intent', async () => {
		const out = await conform('{"lg-eng":[{"iri":" https://a.test/1 ","label_id":9,"title":"T"}]}');
		expect(out.result).toEqual({ 'lg-eng': [{ iri: 'https://a.test/1', title: 'T' }] });
		expect(out.derivedFrames).toEqual([intent(0, { section_id: 9 }, 'lg-eng')]);
	});

	test('a lang-keyed STRING item goes through conformIriRecord', async () => {
		const out = await conform('{"lg-eng":["https://a.test/2", "42, https://a.test/3"]}');
		expect(out.result).toEqual({
			'lg-eng': [{ iri: 'https://a.test/2' }, { iri: 'https://a.test/3' }],
		});
		expect(out.derivedFrames).toEqual([intent(1, { section_id: 42 }, 'lg-eng')]);
	});

	test('a non-string iri is REFUSED with the type message', async () => {
		const out = await conform('{"lg-eng":[{"iri":42}]}');
		expect(out.result).toBeNull();
		expect(out.errors[0]?.msg).toContain('iri must be a string');
	});

	test('a lang-keyed iri WITHOUT a protocol is refused', async () => {
		const out = await conform('{"lg-eng":[{"iri":"a.test/1"}]}');
		expect(out.result).toBeNull();
		expect(out.errors[0]?.msg).toContain('IGNORED: malformed data');
	});
});

describe('the flat json branch — the arms the existing gate does not reach', () => {
	test('a label-ONLY object (no iri, no title) is REFUSED', async () => {
		// Corruption prevented: the old arm stored `{label_id:5}` — a literal item
		// with no iri carrying a key no reader reads.
		const out = await conform('[{"label_id":5}]');
		expect(out.result).toBeNull();
		expect(out.errors[0]?.msg).toContain('a label needs an iri');
	});

	test('a title-only labelled object is kept (deprecated title, D5) with its intent', async () => {
		const out = await conform('[{"label_id":"5","title":"T"}]');
		expect(out.errors).toHaveLength(0);
		expect(out.result).toEqual([{ title: 'T' }]);
		expect(out.derivedFrames).toEqual([intent(0, { section_id: 5 })]);
	});

	test('a label_id that is not a record id is REFUSED, never stored', async () => {
		const out = await conform('[{"iri":"https://a.test/1","label_id":"nomisma"}]');
		expect(out.result).toBeNull();
		expect(out.errors[0]?.msg).toContain('is not a label record id');
	});

	test('a non-string iri in the flat branch is refused', async () => {
		const out = await conform('[{"iri":42}]');
		expect(out.result).toBeNull();
		expect(out.errors[0]?.msg).toContain('iri must be a string');
	});

	test('a json array of SCALARS yields nothing → "object without iri data"', async () => {
		const out = await conform('[42, true]');
		expect(out.result).toBeNull();
		expect(out.errors[0]?.msg).toBe('IGNORED: object without iri data [42, true]');
	});

	/**
	 * A json array may hold STRING records, which go through conformIriRecord
	 * exactly like a plain cell. Losing that arm does not error at the record —
	 * the array conforms to nothing and the cell is refused as "object without
	 * iri data": silent whole-column loss on a valid import.
	 */
	test('a json array of STRING records goes through conformIriRecord', async () => {
		const out = await conform('["42, https://a.test/s1", "https://a.test/s2"]');
		expect(out.errors).toHaveLength(0);
		expect(out.result).toEqual([{ iri: 'https://a.test/s1' }, { iri: 'https://a.test/s2' }]);
		expect(out.derivedFrames).toEqual([intent(0, { section_id: 42 })]);
	});
});

/**
 * T2-IMP-2 — ONE whitelist conformer for a json iri ITEM, both branches. An item
 * is `iri` (an http(s) string, trimmed), `id` (a positive integer), `title`,
 * `lang` (strings) — the stored item shape, so a raw export re-imports — plus
 * `label_id`, split off as the dd560 intent. Before: every other key was kept
 * verbatim on the stored item, a flat iri kept its padding, and `{}` stored an
 * empty item.
 */
describe('the json iri ITEM whitelist (T2-IMP-2)', () => {
	test('an UNKNOWN key refuses the cell, naming the key — flat and lang-keyed', async () => {
		// Corruption prevented: `{"iri":…,"url":…}` storing a key no reader reads,
		// forever, on every row of the import.
		const flat = await conform('[{"iri":"https://a.test/1","url":"https://a.test/2"}]');
		expect(flat.result).toBeNull();
		expect(flat.errors[0]?.msg).toContain('unknown key "url"');
		const keyed = await conform('{"lg-eng":[{"iri":"https://a.test/1","note":"x"}]}');
		expect(keyed.result).toBeNull();
		expect(keyed.errors[0]?.msg).toContain('unknown key "note"');
	});

	test('a FLAT json iri is TRIMMED like the lang-keyed one', async () => {
		const out = await conform('[{"iri":"  https://a.test/pad\\t"}]');
		expect(out.errors).toHaveLength(0);
		expect(out.result).toEqual([{ iri: 'https://a.test/pad' }]);
	});

	test('an EMPTY object `{}` is refused (no iri and no title), never stored as [{}]', async () => {
		for (const cell of ['{}', '[{}]', '{"lg-eng":[{}]}']) {
			const out = await conform(cell);
			expect(out.result).toBeNull();
			expect(out.errors[0]?.msg).toContain('needs an iri or a title');
		}
	});

	test('the stored item shape round-trips: iri, id, title, lang kept as given', async () => {
		// A raw export of component_iri (samples/data.json shape) must re-import.
		const out = await conform(
			'[{"id":2,"iri":"https://a.test/1","lang":"lg-eng","title":"T"},{"id":3,"title":"Only title"}]',
		);
		expect(out.errors).toHaveLength(0);
		expect(out.result).toEqual([
			{ id: 2, iri: 'https://a.test/1', lang: 'lg-eng', title: 'T' },
			{ id: 3, title: 'Only title' },
		]);
	});

	test('a whitelisted key of the wrong TYPE is refused (id not a positive integer, title/lang not strings)', async () => {
		for (const cell of [
			'[{"iri":"https://a.test/1","id":"2"}]',
			'[{"iri":"https://a.test/1","id":0}]',
			'[{"iri":"https://a.test/1","title":5}]',
			'{"lg-eng":[{"iri":"https://a.test/1","lang":["lg-eng"]}]}',
		]) {
			const out = await conform(cell);
			expect(out.result).toBeNull();
			expect(out.errors[0]?.msg).toContain('IGNORED: malformed data');
		}
	});
});

describe('the ONTOLOGY-CONFIGURED separators bind — not the defaults', () => {
	test('records_separator/fields_separator from properties drive the split', async () => {
		// Corruption prevented: ignoring the configured separators parses a
		// correctly-authored cell of a configured component as one garbage record.
		const out = await conform('https://a.test/1;;700::https://a.test/2', CONFIGURED_TIPO);
		expect(out.errors).toHaveLength(0);
		expect(out.result).toEqual([{ iri: 'https://a.test/1' }, { iri: 'https://a.test/2' }]);
		expect(out.derivedFrames).toEqual([intent(1, { section_id: 700 })]);
	});

	test('the DEFAULT separators are inert on a configured component', async () => {
		// The whole cell is one record, one field: proof the ontology value —
		// not ' | ' / ', ' — is what split it.
		const out = await conform('https://a.test/1 | https://a.test/2', CONFIGURED_TIPO);
		expect(out.result).toEqual([{ iri: 'https://a.test/1 | https://a.test/2' }]);
	});
});
