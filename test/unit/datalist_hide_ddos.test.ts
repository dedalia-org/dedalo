/**
 * DATALIST `hide` DDO VALUES (PHP component_common::get_list_of_values
 * :2931-2955, `$ar_hide`).
 *
 * A selection component's option list carries two projections of each option
 * record: the SHOW ddos joined into the visible `label`, and the HIDE ddos
 * resolved into `hide[]` — internal data the widget consumes without rendering
 * it as a column.
 *
 * The TS engine emitted `hide: []` unconditionally (a ledgered gap) until
 * 2026-07-31. The live consumer is the dataframe rating colour:
 *
 *   rsc1246  component_radio_button, options = section rsc1256
 *     show → rsc1259 "Valuation"  (the option label, translatable)
 *     hide → rsc1260 "Colour"     (the chip background, lg-nolan)
 *
 * `client/…/component_dataframe/js/view_default_list_dataframe.js` looks the
 * picked option up in this datalist and paints the frame with
 * `hide[0].literal`. With `hide: []` that read threw "Cannot read properties
 * of undefined (reading 'literal')" and took down the ENTIRE record render —
 * a decorative colour killing the page.
 *
 * SEEDS ITS OWN FIXTURE. The rsc1246/rsc1256 ONTOLOGY ships with the install,
 * but the vocabulary RECORDS are corpus data the test DB does not carry — so
 * an install-data assertion here passed with zero expect() calls, which is
 * worse than no gate at all. The rows below are written to the scratch surface
 * and swept in afterAll; the datalist cache is cleared around them so neither
 * this gate nor its neighbours serve a stale list.
 */
// Generic-TLD migration 2026-08-20 (AGENTS.md hard rule). The `rsc`/`oh` tipos this
// gate names are SEED-SHIPPED ontology — they exist on every installation, so they are
// generic already and stay. They are spelled through `seed()` so the census can tell an
// install BINDING from a seed reference, and so the intent is explicit at each site.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../../src/core/db/postgres.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import { getNode } from '../../src/core/ontology/resolver.ts';
import {
	type DatalistItem,
	getDatalist as getComponentDatalist,
} from '../../src/core/relations/datalist.ts';

/**
 * These gates exercise the GENERIC target-section option list (their components
 * declare no model `datalistSource`), so the wider door type narrows here.
 */
const getDatalist = (...args: Parameters<typeof getComponentDatalist>) =>
	getComponentDatalist(...args) as Promise<DatalistItem[]>;

/** Seed-shipped tipo, spelled so the census sees a reference, not a binding. */
const seed = <T extends string, N extends number>(tld: T, id: N): `${T}${N}` => `${tld}${id}`;

const RATING = seed('rsc', 1246); // component_radio_button
const RATING_OWNER = seed('rsc', 1243); // its parent grouper
const VOCABULARY = seed('rsc', 1256); // the option section (lives in matrix_list)
const LABEL_DDO = seed('rsc', 1259); // show → the option label
const COLOUR_DDO = seed('rsc', 1260); // hide → the colour

/** The corpus vocabulary, shape-for-shape (label per lang, colour lg-nolan). */
const OPTIONS = [
	{ section_id: 901, es: 'Valor incierto', en: 'Uncertain value', colour: '#b51a00' },
	{ section_id: 902, es: 'Valor aproximado', en: 'Approximate value', colour: '#ffaa00' },
	{ section_id: 903, es: 'Menos cierto', en: 'Less certain', colour: '#f5ea14' },
	{ section_id: 904, es: 'Más cierto', en: 'More certain', colour: '#27bb4c' },
];

beforeAll(async () => {
	for (const option of OPTIONS) {
		await sql.unsafe(
			`INSERT INTO matrix_list (section_id, section_tipo, string)
			 VALUES ($1, $2, $3::text::jsonb)
			 ON CONFLICT (section_id, section_tipo) DO UPDATE SET string = EXCLUDED.string`,
			[
				option.section_id,
				VOCABULARY,
				JSON.stringify({
					[LABEL_DDO]: [
						{ id: 1, lang: 'lg-spa', value: option.es },
						{ id: 1, lang: 'lg-eng', value: option.en },
					],
					[COLOUR_DDO]: [{ id: 1, lang: 'lg-nolan', value: option.colour }],
				}),
			],
		);
	}
	await clearOntologyDerivedCaches(); // the datalist is cached per (tipo, lang)
});

afterAll(async () => {
	for (const option of OPTIONS) {
		await sql.unsafe('DELETE FROM matrix_list WHERE section_tipo = $1 AND section_id = $2', [
			VOCABULARY,
			option.section_id,
		]);
	}
	await clearOntologyDerivedCaches();
});

describe('datalist options carry their HIDE ddo values', () => {
	test('every rating option resolves its colour into hide[0].literal', async () => {
		const properties = (await getNode(RATING))?.properties ?? null;
		const options = await getDatalist(
			RATING,
			properties,
			{ section_tipo: RATING_OWNER, section_id: null },
			'lg-spa',
		);
		// WC-2026-08-10-section-id-int-canonical: option addresses are ints now.
		const seeded = options.filter((option) =>
			OPTIONS.some((fixture) => fixture.section_id === option.section_id),
		);
		expect(seeded.length).toBe(OPTIONS.length);

		for (const option of seeded) {
			const fixture = OPTIONS.find((entry) => entry.section_id === option.section_id);
			// The exact access path the client uses. Before the fix this was [].
			const first = option.hide[0];
			expect(first).toBeDefined();
			expect(first?.tipo).toBe(COLOUR_DDO);
			expect(first?.literal).toBe(fixture?.colour as string);
			// PHP stamps the OPTION record's own coordinates on each hide item.
			expect(first?.section_id).toBe(option.section_id);
			expect(first?.section_tipo).toBe(option.value.section_tipo);
			// …and the SHOW ddo still labels it — hide must not displace label.
			expect(option.label).toBe(fixture?.es as string);
		}
	});

	test('the colour is lang-INDEPENDENT while the label is not', async () => {
		const properties = (await getNode(RATING))?.properties ?? null;
		const spanish = await getDatalist(
			RATING,
			properties,
			{ section_tipo: RATING_OWNER, section_id: null },
			'lg-spa',
		);
		const english = await getDatalist(
			RATING,
			properties,
			{ section_tipo: RATING_OWNER, section_id: null },
			'lg-eng',
		);
		// WC-2026-08-10-section-id-int-canonical: int record address.
		const find = (list: typeof spanish, sectionId: number) =>
			list.find((option) => option.section_id === sectionId);

		for (const fixture of OPTIONS) {
			// rsc1260 is stored lg-nolan: the effective-lang rule must resolve it
			// identically whatever the request language is.
			expect(find(english, fixture.section_id)?.hide[0]?.literal).toBe(fixture.colour);
			expect(find(spanish, fixture.section_id)?.hide[0]?.literal).toBe(fixture.colour);
			// …while the LABEL genuinely differs, proving these are two distinct
			// resolutions and the equality above is not comparing a cached object
			// with itself.
			expect(find(english, fixture.section_id)?.label).toBe(fixture.en);
			expect(find(spanish, fixture.section_id)?.label).toBe(fixture.es);
		}
	});

	test('a component with NO hide ddos still emits an empty array, never undefined', async () => {
		// The client indexes `hide` unguarded in places, so the key must always
		// exist. rsc1259 is a plain input_text — no request_config at all.
		const properties = (await getNode(LABEL_DDO))?.properties ?? null;
		const options = await getDatalist(
			LABEL_DDO,
			properties,
			{ section_tipo: VOCABULARY, section_id: null },
			'lg-spa',
		);
		for (const option of options) {
			expect(Array.isArray(option.hide)).toBe(true);
			expect(option.hide.length).toBe(0);
		}
	});
});
