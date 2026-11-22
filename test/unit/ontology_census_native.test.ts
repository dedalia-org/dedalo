/**
 * getActiveOntologies — the shared active-ontologies census
 * (src/core/ontology/data_io.ts:169).
 *
 * THE census that tool_ontology_parser `get_ontologies` serves whole and that
 * `updateOntologyInfo` persists (as `active_ontologies`) into the installation
 * metadata record. Zero coverage before this file: the tool gate stubs the whole
 * IO surface, so every branch below ran only in production.
 *
 * Scratch surface (THIS FILE OWNS IT): `matrix_ontology_main` rows with
 * `section_tipo = 'ontology35'` and `section_id` in 990001..990099. Nothing else
 * is written — the typology fixture is a READ of the real `hierarchy13`/4 record.
 *
 * MEMBERSHIP, NEVER EXCLUSIVITY: the test database holds ~158 real `ontology35`
 * rows, so `toContain` / `not.toContain` is the only honest shape; "only zzta"
 * would fail on correct code.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { getActiveOntologies } from '../../src/core/ontology/data_io.ts';
import { inSplitLane, laneLabel, SPLIT_LANES } from '../helpers/split_request_langs.ts';

const SECTION = 'ontology35';
const TABLE = 'matrix_ontology_main';
const ID_FLOOR = 990000;

/** A real `hierarchy13` typology record (matrix_dd) — read-only fixture. */
const TYPOLOGY_ID = 4;
const TYPOLOGY_NAME_SPA = 'Semánticas';

type Items = { id?: number; lang?: string; value?: unknown }[];
type Loc = { id?: number; type?: string; section_tipo?: string; section_id?: unknown };

/** A `lg-nolan` single-item string component (the shape tld/target really use). */
function nolan(value: string): Items {
	return [{ id: 1, lang: 'lg-nolan', value }];
}

async function seed(
	sectionId: number,
	stringCol: Record<string, Items>,
	relationCol: Record<string, Loc[]> = {},
): Promise<void> {
	await sql.unsafe(
		`INSERT INTO "${TABLE}" (section_id, section_tipo, string, relation)
		 VALUES ($1, $2, $3::text::jsonb, $4::text::jsonb)`,
		[sectionId, SECTION, JSON.stringify(stringCol), JSON.stringify(relationCol)],
	);
}

async function scratchCount(): Promise<number> {
	const rows = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM "${TABLE}" WHERE section_tipo = $1 AND section_id >= $2`,
		[SECTION, ID_FLOOR],
	)) as { n: number }[];
	return rows[0]?.n ?? 0;
}

async function tmCount(): Promise<number> {
	const rows = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM matrix_time_machine
		  WHERE section_tipo = $1 AND section_id::text::int >= $2`,
		[SECTION, ID_FLOOR],
	)) as { n: number }[];
	return rows[0]?.n ?? 0;
}

/** The active si/no locator, `dd64`/1. `sectionId` is the loose-compare seam. */
function activeLocator(sectionId: unknown): Loc {
	return { id: 1, type: 'dd151', section_tipo: 'dd64', section_id: sectionId };
}

let censusAll: Awaited<ReturnType<typeof getActiveOntologies>>;
let censusActive: Awaited<ReturnType<typeof getActiveOntologies>>;
const tld = (c: typeof censusAll) => c.ontologies.map((o) => o.tld);
const byTld = (c: typeof censusAll, t: string) => c.ontologies.find((o) => o.tld === t);

beforeAll(async () => {
	// Fail loud, never skip: a missing DB / drifted fixture must redden this file.
	expect(await scratchCount()).toBe(0);

	// The typology fixture is a REAL record — assert it before depending on it.
	const typology = (await sql.unsafe(
		`SELECT string FROM matrix_dd WHERE section_tipo = 'hierarchy13' AND section_id = $1`,
		[TYPOLOGY_ID],
	)) as { string: Record<string, Items> | null }[];
	const spa = typology[0]?.string?.hierarchy16?.find((i) => i.lang === 'lg-spa')?.value;
	expect(spa).toBe(TYPOLOGY_NAME_SPA);

	// The app lang the census resolves through must differ from the fallback-case
	// lang, or the `pickLangValue` preference branch proves nothing.
	expect(config.menu.applicationLang).toBe('lg-spa');

	// --- active filter (hierarchy4) ---
	// 990001 active, 990002 points at 'no' (dd64/2), 990003 has no flag at all.
	await seed(
		990001,
		{ hierarchy53: nolan('zzta1'), hierarchy6: nolan('zzta') },
		{ hierarchy4: [activeLocator(1)] },
	);
	await seed(
		990002,
		{ hierarchy53: nolan('zztb1'), hierarchy6: nolan('zztb') },
		{ hierarchy4: [activeLocator(2)] },
	);
	await seed(990003, { hierarchy53: nolan('zztc1'), hierarchy6: nolan('zztc') });

	// --- skip branches ---
	await seed(990004, { hierarchy6: nolan('zzte') }); // no target section tipo
	await seed(990005, { hierarchy53: nolan('zztf1') }); // no tld

	// --- loose locator compare: section_id is the STRING '1' (legacy installs) ---
	await seed(
		990006,
		{ hierarchy53: nolan('zztd1'), hierarchy6: nolan('zztd') },
		{ hierarchy4: [activeLocator('1')] },
	);

	// --- name resolution ---
	await seed(990007, {
		hierarchy53: nolan('zztg1'),
		hierarchy6: nolan('zztg'),
		hierarchy5: [{ id: 1, lang: 'lg-eng', value: 'Zed Thesaurus' }], // app lang absent
	});
	await seed(990008, {
		hierarchy53: nolan('zzth1'),
		hierarchy6: nolan('zzth'),
		hierarchy5: [
			{ id: 1, lang: 'lg-spa', value: '' },
			{ id: 1, lang: 'lg-eng', value: null },
		],
	});
	await seed(990009, { hierarchy53: nolan('zzti1'), hierarchy6: nolan('zzti') }); // no term
	await seed(990010, {
		hierarchy53: nolan('zztj1'),
		hierarchy6: nolan('zztj'),
		hierarchy5: [
			{ id: 1, lang: 'lg-eng', value: 'Name in English' },
			{ id: 1, lang: 'lg-spa', value: 'Nombre en castellano' },
		],
	});

	// --- typology (hierarchy9 → hierarchy13) ---
	await seed(
		990011,
		{ hierarchy53: nolan('zztk1'), hierarchy6: nolan('zztk') },
		{ hierarchy9: [{ id: 1, type: 'dd151', section_tipo: 'hierarchy13', section_id: '4' }] },
	);
	await seed(
		990012,
		{ hierarchy53: nolan('zztl1'), hierarchy6: nolan('zztl') },
		{ hierarchy9: [{ id: 1, type: 'dd151', section_tipo: 'hierarchy13', section_id: 9990001 }] },
	);
	await seed(990013, { hierarchy53: nolan('zztm1'), hierarchy6: nolan('zztm') }); // no typology

	expect(await scratchCount()).toBe(13);

	censusAll = await getActiveOntologies();
	censusActive = await getActiveOntologies({ activeOnly: true });
});

afterAll(async () => {
	await sql.unsafe(`DELETE FROM "${TABLE}" WHERE section_tipo = $1 AND section_id >= $2`, [
		SECTION,
		ID_FLOOR,
	]);
	await sql.unsafe(
		`DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id::text::int >= $2`,
		[SECTION, ID_FLOOR],
	);
	// Fail loud if the sweep did not reach zero — a leftover scratch row poisons
	// every later census run in the shared test DB.
	expect(await scratchCount()).toBe(0);
	expect(await tmCount()).toBe(0);
});

describe('getActiveOntologies — active filter', () => {
	test('the default census carries every seeded hierarchy, active or not', () => {
		const tlds = tld(censusAll);
		expect(tlds).toContain('zzta');
		expect(tlds).toContain('zztb');
		expect(tlds).toContain('zztc');
	});

	test('activeOnly keeps dd64/1 and drops dd64/2 and the flagless row', () => {
		const tlds = tld(censusActive);
		expect(tlds).toContain('zzta');
		expect(tlds).not.toContain('zztb');
		expect(tlds).not.toContain('zztc');
	});

	test('a STRING section_id in the active locator still counts as active', () => {
		// THE case of this file. hierarchy4 = [{dd64, section_id:'1'}] is what a
		// legacy install actually stores; replacing compareLocators with `===`
		// (or dropping the loose section_id rule) empties the census there.
		expect(tld(censusActive)).toContain('zztd');
		expect(tld(censusAll)).toContain('zztd');
	});

	test('rows come back in section_id order', () => {
		const tlds = tld(censusAll);
		const ours = tlds.filter((t) => t.startsWith('zzt'));
		expect(ours).toEqual([
			'zzta',
			'zztb',
			'zztc',
			'zztd',
			'zztg',
			'zzth',
			'zzti',
			'zztj',
			'zztk',
			'zztl',
			'zztm',
		]);
	});
});

describe('getActiveOntologies — non-fatal skips', () => {
	test('a row without a target section tipo is skipped into errors, byte-exact', () => {
		expect(censusAll.errors).toContain(
			'Skipped hierarchy without target section tipo: ontology35, 990004',
		);
		expect(tld(censusAll)).not.toContain('zzte');
	});

	test('a row without a tld is skipped into errors — note the TRAILING SPACE', () => {
		// PHP byte parity: this message really does end in a space.
		expect(censusAll.errors).toContain('Skipped hierarchy without tld: ontology35, 990005 ');
		expect(censusAll.ontologies.map((o) => o.target_section_tipo)).not.toContain('zztf1');
	});

	test('a skip is non-fatal — the rows after it are still censused', () => {
		expect(tld(censusAll)).toContain('zztd');
	});
});

describe('getActiveOntologies — name resolution', () => {
	test('falls back to any non-empty lang when the app lang is absent', () => {
		expect(byTld(censusAll, 'zztg')?.name).toBe('Zed Thesaurus');
	});

	test('prefers the application lang over the others', () => {
		expect(byTld(censusAll, 'zztj')?.name).toBe('Nombre en castellano');
	});

	test('T2-OX7-1b: the picked name follows the REQUEST application lang', async () => {
		// Two request scopes → the row's two stored names; the install default
		// answered both requests the Spanish one. The lanes are SPLIT (data ≠
		// application, swapped — review M1): a pick following the DATA lang is
		// red in both.
		const stored: Readonly<Record<string, string>> = {
			'lg-eng': 'Name in English',
			'lg-spa': 'Nombre en castellano',
		};
		for (const lane of SPLIT_LANES) {
			const census = await inSplitLane(lane, () => getActiveOntologies());
			expect(byTld(census, 'zztj')?.name, laneLabel(lane)).toBe(
				stored[lane.applicationLang] as string,
			);
		}
	});

	test('all-empty values give name null (not the empty string)', () => {
		const entry = byTld(censusAll, 'zzth');
		expect(entry?.name).toBeNull();
		// name_data stays the RAW component items — only `name` is normalized.
		expect(entry?.name_data).toEqual([
			{ id: 1, lang: 'lg-spa', value: '' },
			{ id: 1, lang: 'lg-eng', value: null },
		]);
	});

	test('a missing term component gives name null and name_data null', () => {
		const entry = byTld(censusAll, 'zzti');
		expect(entry?.name).toBeNull();
		expect(entry?.name_data).toBeNull();
	});

	test('the target section tipo is carried verbatim', () => {
		expect(byTld(censusAll, 'zzta')?.target_section_tipo).toBe('zzta1');
	});
});

describe('getActiveOntologies — typology', () => {
	test('a string locator section_id resolves to a NUMBER id and the record name', () => {
		const entry = byTld(censusAll, 'zztk');
		expect(entry?.typology_id).toBe(TYPOLOGY_ID);
		expect(entry?.typology_name).toBe(TYPOLOGY_NAME_SPA);
	});

	test('an unresolvable typology keeps the id and yields a null name', () => {
		const entry = byTld(censusAll, 'zztl');
		expect(entry?.typology_id).toBe(9990001);
		expect(entry?.typology_name).toBeNull();
	});

	test('no typology component gives both fields null', () => {
		const entry = byTld(censusAll, 'zztm');
		expect(entry?.typology_id).toBeNull();
		expect(entry?.typology_name).toBeNull();
	});
});

describe('getActiveOntologies — the real corpus', () => {
	test('the census is not degenerate: the real dd hierarchy is present and active', () => {
		// Guards against a "returns [] on everything" regression that membership
		// assertions over scratch rows alone could not distinguish from a filter bug.
		expect(censusAll.ontologies.length).toBeGreaterThan(13);
		expect(tld(censusAll)).toContain('dd');
		expect(byTld(censusAll, 'dd')?.target_section_tipo).toBe('dd0');
	});
});
