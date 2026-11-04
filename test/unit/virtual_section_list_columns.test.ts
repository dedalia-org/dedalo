/**
 * VIRTUAL SECTION list-column inheritance (PHP resolve_ar_related_list_section
 * step 2, trait.request_config_v5.php): a virtual section with NO section_list
 * child of its OWN inherits its REAL section's list columns — resolve the real
 * tipo (section::get_section_real_tipo_static) and read ITS section_list child.
 *
 * Regression guard: hierarchy/thesaurus-instance sections (testgeoa1 →
 * hierarchy20 — the synthetic activated hierarchy of src/core/test_data/
 * synthetic_hierarchy_fixture.ts; migrated off the real Spain hierarchy
 * 2026-08-25, the need being any registered virtual instance, never es-the-install's)
 * have zero ontology children, so the non-virtual section_list lookup finds
 * nothing. Before the fix `deriveSectionDdoMap` returned an EMPTY ddo_map and
 * the list view rendered only the built-in Id column. The columns are DERIVED
 * from the real section (not hard-coded) so the gate survives an admin
 * re-tuning the hierarchy section_list, but must never regress to empty.
 */
// Generic-TLD migration 2026-08-20 (AGENTS.md hard rule). The `rsc`/`oh` tipos this
// gate names are SEED-SHIPPED ontology — they exist on every installation, so they are
// generic already and stay. They are spelled through `seed()` so the census can tell an
// install BINDING from a seed reference, and so the intent is explicit at each site.

import { describe, expect, test } from 'bun:test';
import { sql } from '../../src/core/db/postgres.ts';
import { runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';
import { getSectionRealTipo } from '../../src/core/resolve/security_access_datalist.ts';
import { buildStructureContext } from '../../src/core/resolve/structure_context.ts';
import { deriveSectionDdoMap } from '../../src/core/section/read.ts';
import { SYNTHETIC_HIERARCHY_A_TLD } from '../../src/core/test_data/synthetic_hierarchy_constants.ts';

/** Seed-shipped tipo, spelled so the census sees a reference, not a binding. */
const seed = <T extends string, N extends number>(tld: T, id: N): `${T}${N}` => `${tld}${id}`;

/** The registered virtual hierarchy instance the inheritance is proven on. */
const INSTANCE = `${SYNTHETIC_HIERARCHY_A_TLD}1`;

// DB reachability probe: only a genuinely unreachable DB downgrades to SKIP.
let hasDb = false;
try {
	await sql`SELECT 1`;
	hasDb = true;
} catch {
	console.warn('[virtual_section_list_columns] DB unavailable — corpus drives SKIPPED');
}

const listColumns = (tipo: string): Promise<string[]> =>
	runWithRequestLangs({ applicationLang: 'lg-eng', dataLang: 'lg-eng' }, async () =>
		(await deriveSectionDdoMap(tipo, tipo, 'list')).map((ddo) => ddo.tipo),
	);

describe.if(hasDb)('virtual section list columns (PHP resolve_ar_related_list_section)', () => {
	test('a thesaurus instance inherits its real section hierarchy20 columns', async () => {
		// The synthetic terms section is a virtual section: its structure section
		// is hierarchy20 (activation registered it — missing here means the suite
		// fixture is unbuilt: bun run test:db:setup).
		const real = await getSectionRealTipo(INSTANCE);
		expect(real).toBe('hierarchy20');

		const virtualColumns = await listColumns(INSTANCE);
		const realColumns = await listColumns('hierarchy20');

		// The regression: an empty map is exactly the "no columns" bug.
		expect(virtualColumns.length).toBeGreaterThan(0);
		// Inheritance is byte-identical to the real section's own list columns.
		expect(virtualColumns).toEqual(realColumns);
	});

	test('inherited columns are the real section_list child relation_nodes', async () => {
		// hierarchy20's section_list child (hierarchy37) defines the columns; the
		// derived map must match its relation_nodes in order (implicit list build).
		const rows = (await sql`
			SELECT relations FROM dd_ontology
			WHERE parent = 'hierarchy20' AND model = 'section_list'
			ORDER BY order_number ASC LIMIT 1
		`) as { relations: { tipo?: unknown }[] | null }[];
		const expected = (rows[0]?.relations ?? [])
			.map((node) => node.tipo)
			.filter((tipo): tipo is string => typeof tipo === 'string');

		expect(expected.length).toBeGreaterThan(0);
		expect(await listColumns(INSTANCE)).toEqual(expected);
	});

	test('a real section with its OWN section_list is unaffected by the fallback', async () => {
		// hierarchy20 is a real section (get_section_real_tipo_static returns
		// itself); its columns resolve directly, never through the virtual hop.
		expect(await getSectionRealTipo('hierarchy20')).toBe('hierarchy20');
		expect((await listColumns('hierarchy20')).length).toBeGreaterThan(0);
	});
});

/**
 * COLUMNS_MAP FEED (PHP common::get_columns_map, class.common.php:4339-4374):
 * the map is read from the element's OWN properties, and PHP does its OWN
 * section_list lookup for list/tm — it NEVER sees resolve_source_properties'
 * output ("Site B"). Feeding it the Site-B swap instead leaked the
 * section_list_thesaurus child's `source.columns_map` into list_thesaurus mode:
 * rsc197's rsc1050 declares 2 columns (a: rsc85, b: rsc1051) while the row
 * ddo_map renders 3 cells, so the client's get_columns_map emitted one header
 * too few — the "Apellidos" column lost its header and every header after it
 * shifted left.
 */
describe.if(hasDb)(
	'columns_map feeds from the element OWN properties (PHP get_columns_map)',
	() => {
		test('a list_thesaurus exposes NO columns_map (its own properties declare none)', async () => {
			const entry = await runWithRequestLangs(
				{ applicationLang: 'lg-eng', dataLang: 'lg-eng' },
				async () =>
					buildStructureContext({
						configFrom: { source: 'own', reason: 'unit-test' },
						tipo: seed('rsc', 197),
						sectionTipo: seed('rsc', 197),
						mode: 'list_thesaurus',
						permissions: 2,
						lang: 'lg-eng',
					}),
			);
			// The section_list_thesaurus child DOES declare one — the point of the gate.
			const child = (await sql`
			SELECT properties FROM dd_ontology WHERE tipo = ${seed('rsc', 1050)}
		`) as { properties: { source?: { columns_map?: unknown[] } } | null }[];
			expect(child[0]?.properties?.source?.columns_map?.length).toBeGreaterThan(0);

			expect(entry).not.toBeNull();
			expect(entry?.columns_map).toEqual([]);
		});
	},
);
