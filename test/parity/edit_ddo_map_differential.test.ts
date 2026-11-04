/**
 * Phase 4/7 gate: the SECTION EDIT-mode ddo_map — the flat list the client
 * renders the edit FORM BODY from (PHP resolve_ar_related_edit 'section' +
 * build_legacy_ddo_map): every component/grouper descendant (recursive walk,
 * component_dataframe excluded), parent = the section, mode 'edit', view from
 * own properties or the legacy resolve_view default.
 *
 * Asserts the TS section edit context carries a request_config whose show
 * ddo_map equals live PHP EXACTLY — same ddos, same ORDER, same
 * tipo/model/parent/mode/view per entry.
 */
// GENERIC-TLD MIGRATED 2026-08-20 (WC-2026-08-19-test-tld-replay).
// The RQO is written in `test`-TLD terms (the cloned mint thesaurus) and the
// frozen PHP interaction is reached through `unmapRqo` (fixture lookup) +
// `adoptTipoIdMap` (the frozen body, read in test-TLD terms). The gate reads
// no records — it compares the edit ddo_map the ontology alone determines.

import { beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import { buildStructureContext } from '../../src/core/resolve/structure_context.ts';
import { adoptTipoIdMap, installTokensIn } from './normalize.ts';
import { hasPhpCredentials, PhpApiClient } from './php_client.ts';

/** The cloned mint thesaurus (the install's numis-mint terms section twin). */
const SECTION = 'testmint1';

type Ddoish = { tipo: string; model: string; parent: string; mode: string; view?: string | null };

function keyOf(ddo: Ddoish): string {
	return `${ddo.tipo}|${ddo.model}|${ddo.parent}|${ddo.mode}|${ddo.view ?? ''}`;
}

describe.if(hasPhpCredentials())('section EDIT ddo_map differential (edit form body gate)', () => {
	let phpKeys: string[];
	let tsKeys: string[];
	/** The section entry's parent on each side (the uncloned seam, asserted). */
	let frozenParentGrouper: unknown;
	let frozenUnclonedToken: string | undefined;
	let tsParentGrouper: unknown;

	beforeAll(async () => {
		const client = new PhpApiClient();
		await client.login(
			config.phpReference.username as string,
			config.phpReference.password as string,
		);
		const { body } = await client.call({
			action: 'get_element_context',
			dd_api: 'dd_core_api',
			source: {
				model: 'section',
				tipo: SECTION,
				section_tipo: SECTION,
				mode: 'edit',
				lang: 'lg-spa',
			},
		} as unknown as Record<string, unknown>);
		// WC-2026-08-19-test-tld-replay: the frozen install-term body, read in
		// test-TLD terms. The non-zero tipo count is the anti-vacuity floor — a
		// body that needed no rewrite would not be the migrated one.
		//
		// THE ONE TOKEN THE CLONE HAS NO TWIN FOR: the install AREA node ABOVE
		// the cloned section — the closure that built the `test` TLD stops at the
		// SECTION root, so the section entry's `parent_grouper` cannot be mapped.
		// It is asserted EXACTLY (kind + a single leftover), asserted to live
		// ONLY in that field, and BOTH sides of it are asserted below rather than
		// compared. The token is never SPELLED here: a test file that names an
		// install tipo binds it. What this gate compares (the ddo_map) is
		// asserted to carry no install token at all.
		const adopted = adoptTipoIdMap(body, 'edit_ddo_map_differential');
		expect(adopted.kind).toBe('install_tipo_left');
		expect(adopted.leftovers).toHaveLength(1);
		expect(adopted.rewrites.tipos).toBeGreaterThan(0);
		frozenUnclonedToken = adopted.leftovers[0];
		const phpEntry = (adopted.body.result as Record<string, unknown>[])[0] as {
			parent_grouper?: unknown;
			request_config?: { show?: { ddo_map?: Ddoish[] } }[];
		};
		frozenParentGrouper = phpEntry?.parent_grouper ?? null;
		const phpDdoMap = phpEntry?.request_config?.[0]?.show?.ddo_map ?? [];
		expect(installTokensIn(phpDdoMap)).toEqual([]);
		phpKeys = phpDdoMap.map(keyOf);

		const tsEntry = await buildStructureContext({
			configFrom: { source: 'own', reason: 'unit-test' },
			tipo: SECTION,
			sectionTipo: SECTION,
			mode: 'edit',
			lang: 'lg-spa',
			permissions: 3,
		});
		const tsConfig = tsEntry?.request_config as { show?: { ddo_map?: Ddoish[] } }[] | undefined;
		tsKeys = (tsConfig?.[0]?.show?.ddo_map ?? []).map(keyOf);
		tsParentGrouper = (tsEntry as unknown as { parent_grouper?: unknown })?.parent_grouper ?? null;
	});

	test('the section entry parent is each ontology own area (the uncloned seam)', () => {
		// The frozen body names the INSTALL area; the clone root is parented by
		// its own TLD root. Both are asserted, so the seam cannot hide a wrong
		// value on either side.
		expect(frozenParentGrouper).toBe(frozenUnclonedToken);
		expect(typeof tsParentGrouper).toBe('string');
		expect(String(tsParentGrouper).startsWith('test')).toBe(true);
	});

	test('the edit form tree matches PHP exactly (ddos, order, view)', () => {
		expect(tsKeys.length).toBeGreaterThan(20); // the full section edit form
		expect(tsKeys).toEqual(phpKeys);
	});
});
