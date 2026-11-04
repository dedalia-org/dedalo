/**
 * SECTION_SPEC §7.1 gate: the list-mode SOURCE-PROPERTIES swap
 * (PHP resolve_source_properties, trait.request_config_utils.php:264-309).
 *
 * For a section in list mode WITHOUT its own source.request_config, the context
 * is built from its section_list child's properties — so the list view gets the
 * section_list's column css (e.g. the object section's per-column widths), NOT
 * the section's own edit-form .list_body grid. Getting this wrong misaligns
 * every list column in the client (the diagonal-cascade bug). Byte-parity vs
 * the frozen PHP oracle for the section `css` field in list mode.
 */
// GENERIC-TLD MIGRATED 2026-08-20 (WC-2026-08-19-test-tld-replay).
// Every RQO is written in `test`-TLD terms (two cloned object sections plus a
// cloned manifest root) and the frozen PHP interactions are reached through
// `unmapRqo` (fixture lookup) + `adoptTipoIdMap` (the frozen bodies, read in
// test-TLD terms). The gate reads NO records — the css it compares is derived
// from the ontology alone — so it runs on any installation.

import { beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import {
	buildStructureContext,
	clearStructureContextCache,
} from '../../src/core/resolve/structure_context.ts';
import { adoptTipoIdMap, installTokensIn } from './normalize.ts';
import { hasPhpCredentials, PhpApiClient } from './php_client.ts';

/** A cloned object section whose section_list carries per-column widths. */
const OBJECT_SECTION = 'test6099';
/** The cloned mint thesaurus. */
const MINT_SECTION = 'testmint1';
/**
 * A cloned manifest root with NO section_list. PHP fataled building its
 * context (a `php_fault_not_reproduced` row in FROZEN_ERROR_BODIES), so the
 * frozen body carries no ontology token at all — hence `unclonedSeam: false`
 * and a rewrite floor of zero, which is the honest count for that body.
 */
const NO_LIST_SECTION = 'test6819';

const CASES: { tipo: string; unclonedSeam: boolean }[] = [
	{ tipo: OBJECT_SECTION, unclonedSeam: true },
	{ tipo: MINT_SECTION, unclonedSeam: true },
	{ tipo: NO_LIST_SECTION, unclonedSeam: false },
];

/**
 * The frozen list-mode `css` for `tipo`, plus the proof that the frozen body
 * reached here THROUGH the test-TLD replay seam.
 *
 * THE SEAM (WC-2026-08-19-test-tld-replay): the RQO is written in test-TLD
 * terms and `unmapRqo` turns it back into the frozen request; `adoptTipoIdMap`
 * then proves the answered body IS the install-term one — a non-zero rewrite
 * count is the anti-vacuity floor. The single token it cannot map is the
 * install AREA node ABOVE the cloned section (the closure that built the
 * `test` TLD stops at the SECTION root, so the section entry's
 * `parent_grouper` has no twin); it is asserted EXACTLY and asserted to BE
 * that field. The token is never SPELLED here: a test file that names an
 * install tipo binds it.
 *
 * THE `css` BLOCK IS COMPARED UN-ADOPTED, and that is the honest comparison:
 * the clone copies a section_list's `css` VERBATIM (its keys are style
 * SELECTORS, not addresses — the clone rewrote the sibling `ddo_map` and left
 * these alone), so the cloned ontology serves the very same selector strings
 * the frozen body carries. Rewriting one side would manufacture a difference
 * that exists nowhere. The fact is asserted rather than assumed: whatever
 * install tokens the selector block carries, BOTH sides must carry the same
 * ones (`installTokensIn` equality below) — so a TS regression that started
 * emitting a different selector set reddens this gate.
 */
async function phpSectionListCss(
	client: PhpApiClient,
	tipo: string,
	unclonedSeam: boolean,
): Promise<unknown> {
	const { body } = await client.call({
		action: 'get_element_context',
		dd_api: 'dd_core_api',
		source: { model: 'section', tipo, section_tipo: tipo, mode: 'list', lang: 'lg-spa' },
	} as unknown as Record<string, unknown>);
	const adopted = adoptTipoIdMap(body, 'section_list_css_differential');
	if (unclonedSeam) {
		expect(adopted.kind).toBe('install_tipo_left');
		expect(adopted.leftovers).toHaveLength(1);
		expect(adopted.rewrites.tipos).toBeGreaterThan(0);
		const adoptedEntry = (adopted.body.result as Record<string, unknown>[])[0] as {
			parent_grouper?: unknown;
		};
		expect(adoptedEntry?.parent_grouper).toBe(adopted.leftovers[0] as string);
	} else {
		expect(adopted.matched).toBe(true);
		expect(adopted.kind).toBe('adopted');
	}
	// A PHP fault body carries `result:false`, not an array — hence the guard.
	const result = body.result;
	const entry = (Array.isArray(result) ? result[0] : undefined) as { css?: unknown } | undefined;
	return entry?.css ?? null;
}

describe.if(hasPhpCredentials())('section_list css swap differential (SECTION_SPEC §7.1)', () => {
	let php: PhpApiClient;
	beforeAll(async () => {
		php = new PhpApiClient();
		await php.login(config.phpReference.username as string, config.phpReference.password as string);
	});

	for (const { tipo, unclonedSeam } of CASES) {
		test(`${tipo}: list-mode css comes from the section_list child (matches PHP)`, async () => {
			clearStructureContextCache();
			const phpCss = await phpSectionListCss(php, tipo, unclonedSeam);
			const tsEntry = await buildStructureContext({
				configFrom: { source: 'own', reason: 'unit-test' },
				tipo,
				sectionTipo: tipo,
				mode: 'list',
				lang: 'lg-spa',
				permissions: 3,
			});
			// null (TS "no css") and undefined/absent (PHP) are equivalent absence.
			const tsCss = tsEntry?.css ?? null;
			// The selector block is served from the same (cloned) ontology on both
			// sides — asserted, so a one-sided drift cannot hide (see the header).
			expect(installTokensIn(tsCss)).toEqual(installTokensIn(phpCss));
			expect(tsCss).toEqual(phpCss ?? null);
		});
	}

	test('the object section carries the section_list column-width css, not .list_body', async () => {
		clearStructureContextCache();
		const tsEntry = await buildStructureContext({
			configFrom: { source: 'own', reason: 'unit-test' },
			tipo: OBJECT_SECTION,
			sectionTipo: OBJECT_SECTION,
			mode: 'list',
			lang: 'lg-spa',
			permissions: 3,
		});
		const cssKeys = Object.keys((tsEntry?.css as Record<string, unknown>) ?? {});
		// COLUMN css (the section_list child's), never the section's own edit
		// grid. The exact selector is compared byte-for-byte by the case above;
		// naming it here would bind this file to an install tipo.
		expect(cssKeys.filter((key) => key.startsWith('.column_')).length).toBeGreaterThan(0);
		expect(cssKeys).not.toContain('.list_body');
	});
});
