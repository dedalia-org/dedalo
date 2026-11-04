/**
 * SECTION_SPEC §7.1 gate: the component EDIT-css LIST strip + the portal
 * section_list swap + strip (PHP build_structure_context_core remove_edit_css,
 * class.common.php:1801-1846).
 *
 * Component css add-ons in ontology properties are EDIT-oriented (grid-row/
 * grid-column wrapper placement). PHP nulls a plain component's css in list
 * mode — without the strip the edit grid rules bleed into every list row.
 * component_portal follows the SECTION rule instead: in list mode its css is
 * swapped to its section_list child's (the strip applies only when no child
 * exists). tm mode keeps the element's OWN css — the swap/strip is list-only.
 * Byte-parity vs live PHP for the `css` context field in list vs edit modes.
 */
// GENERIC-TLD MIGRATED 2026-08-19 (WC-2026-08-19-test-tld-replay).
// Every fixture is named in `test`-TLD terms (or is SEED-SHIPPED `dd`
// ontology); `unmapRqo` finds the frozen install-term interaction and
// `adoptTipoIdMap` reads its body back in test terms — which matters here more
// than anywhere else, because an authored css block is KEYED BY A SELECTOR
// BUILT FROM A TIPO (`.column_test6157`), so the map has to walk keys, not just
// values. This gate reads STRUCTURE ONLY, so it needs no records.

import { beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import {
	buildStructureContext,
	clearStructureContextCache,
} from '../../src/core/resolve/structure_context.ts';
import { adoptTipoIdMap } from './normalize.ts';
import { hasPhpCredentials, PhpApiClient } from './php_client.ts';

/** A SEED-SHIPPED tipo, spelled out of the install-TLD census's token grammar. */
const seed = (tld: string, id: number): string => `${tld}${id}`;

/** Plain components carrying authored edit css (probe-verified 2026-07-10). */
const COMPONENTS = [
	{ tipo: 'test6317', model: 'component_input_text', section: 'test6099' },
	{ tipo: 'test6807', model: 'component_select', section: 'test6099' },
	{ tipo: 'testmint1002', model: 'component_input_text', section: 'testmint1' },
	{ tipo: 'testmint1003', model: 'component_text_area', section: 'testmint1' },
];
/**
 * Portals with authored css AND a section_list child (whose css is null here —
 * the swap, not the leak, is what makes list css null for these).
 *
 * ── MEASURED 2026-08-19: the two cloned cases are RED, and it is FIXTURE DRIFT,
 * not an engine defect ──
 * The frozen store was harvested 2026-07-11; the generic ontology
 * (`src/core/test_data/test_tld_ontology.json`) was cut from the install
 * 2026-08-19. Between those two dates the install RE-AUTHORED these portals'
 * css from the v6 shape (`.portal_table_wraper` / `.wrap_component`, values
 * nested under `style`/`mixin`) to the v7 one (`.wrapper_component`, flat
 * grid properties). Both engines are correct about the ontology they read —
 * they simply read ontology from two different instants, and a re-harvest is
 * impossible by definition (engineering/ORACLE_HARVEST.md).
 * Closing this means re-cutting the clone from the harvest-instant snapshot,
 * or retiring these two fixtures with the frozen store — a decision about
 * SHARED artifacts, not about this gate. The seed-shipped `dd` case above
 * exercises the same swap branch and is green.
 */
const PORTALS_WITH_CHILD = [
	{ tipo: seed('dd', 1404), model: 'component_portal', section: seed('dd', 1100) },
	{ tipo: 'test2938', model: 'component_portal', section: 'test2931' },
	{ tipo: 'test2939', model: 'component_portal', section: 'test2931' },
];
/**
 * Portals with authored css and NO section_list child (the strip branch).
 *
 * ONE FIXTURE LOST TO THE CLONE SET (2026-08-19): the second case here was a
 * portal of the install's web-content section, and the phase-2 closure twinned
 * that SECTION but not the portal — `src/core/test_data/test_tld_tipo_map.json`
 * has no entry for it, flat or section-scoped, so it cannot be named in test
 * terms at all. It was ALREADY RED before this migration (the suite database
 * holds no install ontology, so TS answered `null` where PHP answered the
 * authored `.wrapper_component` block). The branch it exercised — a child-less
 * portal keeping its edit css and stripping to null in list — is still covered
 * by the fixture above, on a different install's ontology. Restore it by adding
 * the missing clone-map entry, not by naming the install tipo here.
 */
const PORTALS_WITHOUT_CHILD = [
	{ tipo: 'test6837', model: 'component_portal', section: 'test6813' },
];
/** The get_view fallback edge (PHP :4464-4506): mosaic portals whose view lives
 * on the PORTAL node while their section_list child has none — list-mode view
 * must fall back to the portal's OWN properties.view, NOT the swapped child's
 * absence (16 live cases; regression melts the mosaic render to default). */
const VIEW_EDGE_PORTALS = [
	{ tipo: 'test6829', model: 'component_portal', section: 'test6813', view: 'mosaic' },
	{
		tipo: 'testheritagecatalog1029',
		model: 'component_portal',
		section: 'testheritagecatalog1',
		view: 'mosaic',
	},
];

async function phpElementEntry(
	client: PhpApiClient,
	fixture: { tipo: string; model: string; section: string },
	mode: string,
): Promise<{ css?: unknown; view?: unknown }> {
	const { body } = await client.call({
		action: 'get_element_context',
		dd_api: 'dd_core_api',
		source: {
			model: fixture.model,
			tipo: fixture.tipo,
			section_tipo: fixture.section,
			mode,
			lang: 'lg-spa',
		},
	} as unknown as Record<string, unknown>);
	const entry = ((body.result as Record<string, unknown>[])[0] ?? {}) as Record<string, unknown>;
	// The install AREA node above a cloned section rides in `parent_grouper` and
	// has no twin (the closure cut at the section root). It is outside every
	// field this gate reads (css, view) — removed BEFORE the walk so the
	// leftover scan can still refuse anything else. Its PRESENCE is asserted
	// first: a strip that silently stops matching anything is an exemption that
	// has gone stale, and it would take the leftover scan's teeth with it
	// (review 2026-08-20).
	expect(typeof entry.parent_grouper).toBe('string');
	// biome-ignore lint/performance/noDelete: the key must be GONE, not undefined — the leftover scan below walks own keys.
	delete entry.parent_grouper;
	// WC-2026-08-19-test-tld-replay: the frozen install-term entry read back in
	// test terms — css blocks are KEYED by tipo-built selectors, so the walk has
	// to rewrite keys as well as values.
	const adopted = adoptTipoIdMap(entry, 'component_list_css_strip_differential');
	expect({ matched: adopted.matched, leftovers: adopted.leftovers }).toEqual({
		matched: true,
		leftovers: [],
	});
	return adopted.body as { css?: unknown; view?: unknown };
}

async function phpElementCss(
	client: PhpApiClient,
	fixture: { tipo: string; model: string; section: string },
	mode: string,
): Promise<unknown> {
	return (await phpElementEntry(client, fixture, mode)).css ?? null;
}

async function tsElementEntry(
	fixture: { tipo: string; model: string; section: string },
	mode: string,
): Promise<{ css?: unknown; view?: unknown } | null> {
	clearStructureContextCache();
	return await buildStructureContext({
		configFrom: { source: 'own', reason: 'unit-test' },
		tipo: fixture.tipo,
		sectionTipo: fixture.section,
		mode,
		lang: 'lg-spa',
		permissions: 3,
	});
}

async function tsElementCss(
	fixture: { tipo: string; model: string; section: string },
	mode: string,
): Promise<unknown> {
	return (await tsElementEntry(fixture, mode))?.css ?? null;
}

describe.if(hasPhpCredentials())(
	'component list css strip differential (SECTION_SPEC §7.1, PHP :1801-1846)',
	() => {
		let php: PhpApiClient;
		beforeAll(async () => {
			php = new PhpApiClient();
			await php.login(
				config.phpReference.username as string,
				config.phpReference.password as string,
			);
		});

		for (const fixture of COMPONENTS) {
			test(`${fixture.tipo}: edit css matches PHP and is NON-null (fixture floor)`, async () => {
				const phpCss = await phpElementCss(php, fixture, 'edit');
				// Non-triviality floor: the fixture must still carry authored css,
				// or the list rows below pass vacuously (null == null).
				expect(phpCss).not.toBeNull();
				expect(await tsElementCss(fixture, 'edit')).toEqual(phpCss);
			});

			test(`${fixture.tipo}: list css is STRIPPED on both engines`, async () => {
				const phpCss = await phpElementCss(php, fixture, 'list');
				expect(phpCss).toBeNull();
				expect(await tsElementCss(fixture, 'list')).toBeNull();
			});
		}

		for (const fixture of PORTALS_WITH_CHILD) {
			test(`${fixture.tipo}: portal list css = section_list child's (swap), edit css own`, async () => {
				const phpEdit = await phpElementCss(php, fixture, 'edit');
				expect(phpEdit).not.toBeNull();
				expect(await tsElementCss(fixture, 'edit')).toEqual(phpEdit);
				const phpList = await phpElementCss(php, fixture, 'list');
				expect(await tsElementCss(fixture, 'list')).toEqual(phpList ?? null);
				// The child carries no css in this install: the swap must emit the
				// CHILD's null, never the portal's own edit css.
				expect(phpList ?? null).toBeNull();
			});
		}

		for (const fixture of PORTALS_WITHOUT_CHILD) {
			test(`${fixture.tipo}: child-less portal strips to null in list, keeps edit css`, async () => {
				const phpEdit = await phpElementCss(php, fixture, 'edit');
				expect(phpEdit).not.toBeNull();
				expect(await tsElementCss(fixture, 'edit')).toEqual(phpEdit);
				expect(await phpElementCss(php, fixture, 'list')).toBeNull();
				expect(await tsElementCss(fixture, 'list')).toBeNull();
			});
		}

		for (const fixture of VIEW_EDGE_PORTALS) {
			test(`${fixture.tipo}: list-mode view falls back to the portal's OWN '${fixture.view}'`, async () => {
				const phpEntry = await phpElementEntry(php, fixture, 'list');
				const tsEntry = await tsElementEntry(fixture, 'list');
				expect(tsEntry?.view ?? null).toEqual(phpEntry.view ?? null);
				// The oracle-independent floor: the authored mosaic view survives.
				expect(phpEntry.view ?? null).toBe(fixture.view);
			});
		}

		test('the type section in tm mode emits its OWN css (swap/strip is list-only)', async () => {
			const fixture = { tipo: 'test6099', model: 'section', section: 'test6099' };
			const phpCss = await phpElementCss(php, fixture, 'tm');
			expect(await tsElementCss(fixture, 'tm')).toEqual(phpCss ?? null);
			// Own edit-form grid, NOT the section_list child's column css (the
			// selector is built from the column component's tipo — test6157, the
			// clone of the install component the swap would have leaked).
			const keys = Object.keys((phpCss as Record<string, unknown>) ?? {});
			expect(keys).toContain('.list_body');
			expect(keys).not.toContain('.column_test6157');
		});
	},
);
