/**
 * SECTION_SPEC §8 gate: grouper CONTEXT entries in an edit-mode section read.
 *
 * Groupers (section_group/section_group_div/section_tab/tab) organize the edit
 * form's components in the client DOM. The edit ddo_map order is already gated
 * (edit_ddo_map_differential); this gate pins the emitted CONTEXT entries for
 * the groupers — tipo/model/label/parent_grouper — and that each component
 * carries parent_grouper = its ontology grouper, so the client can nest.
 */
// GENERIC-TLD MIGRATED 2026-08-20 (WC-2026-08-19-test-tld-replay).
// The RQOs are written in `test`-TLD terms (two cloned object sections) and
// the frozen PHP interactions are reached through `unmapRqo` (fixture lookup)
// + `adoptTipoIdMap` (the frozen bodies, read in test-TLD terms). The gate is
// ontology-driven — it compares the GROUPER entries of the edit context and
// reads no record, so it runs on any installation.

import { describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { GROUPER_MODELS } from '../../src/core/concepts/section.ts';
import { readSection } from '../../src/core/section/read.ts';
import { adoptTipoIdMap, installTokensIn } from './normalize.ts';
import { hasPhpCredentials, PhpApiClient } from './php_client.ts';

/** Two cloned object sections: 6+1 and 10 groupers respectively. */
/**
 * Each section with the EXACT number of unmappable tokens its frozen body
 * carries. A cap, not a floor: `toContain(parent_grouper)` alone let ANY new
 * unmapped surface ride along unnoticed (review 2026-08-20), which is precisely
 * the drift the seam exists to surface. The tokens themselves are never spelled
 * — a test file that names an install tipo binds it — so the bound is a count,
 * and the compared grouper keys are separately asserted to carry none of them.
 *   test6099: the install AREA above the clone cut (1).
 *   test6100: that area only (1). It was 3 — plus two COMPONENT entries the
 *             clone did not carry — until the 2026-10-28 regeneration cloned
 *             them (WC-2026-10-28-parity-definition-drift).
 */
const SECTIONS: readonly { tipo: string; leftovers: number }[] = [
	{ tipo: 'test6099', leftovers: 1 },
	{ tipo: 'test6100', leftovers: 1 },
];

function editRqo(sectionTipo: string): Rqo {
	return {
		action: 'read',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		source: {
			model: 'section',
			tipo: sectionTipo,
			section_tipo: sectionTipo,
			mode: 'edit',
			lang: 'lg-spa',
			action: 'search',
		},
		sqo: { section_tipo: [sectionTipo], limit: 1, offset: 0 },
	} as unknown as Rqo;
}

function isGrouper(entry: Record<string, unknown>): boolean {
	return GROUPER_MODELS.includes(entry.model as string);
}

function grouperKey(entry: Record<string, unknown>): string {
	// `type` is load-bearing: the client nests components into a grouper only
	// when the grouper entry's type === 'grouper' (view_default_edit_section_record).
	return `${entry.tipo}|${entry.model}|${entry.type}|${entry.label ?? ''}|${entry.parent_grouper ?? ''}`;
}

describe.if(hasPhpCredentials())('grouper context differential (SECTION_SPEC §8)', () => {
	for (const { tipo: section, leftovers: expectedLeftovers } of SECTIONS) {
		test(`${section}: every PHP grouper context entry is emitted by TS with matching fields`, async () => {
			const client = new PhpApiClient();
			await client.login(
				config.phpReference.username as string,
				config.phpReference.password as string,
			);
			const rqo = editRqo(section);
			const { body } = await client.call(
				structuredClone(rqo) as unknown as Record<string, unknown>,
			);
			// WC-2026-08-19-test-tld-replay: the frozen install-term body, read in
			// test-TLD terms. Non-zero rewrite counts are the anti-vacuity floor.
			//
			// TOKENS THE CLONE HAS NO TWIN FOR — never SPELLED here (a test file
			// that names an install tipo binds it), and proved harmless instead:
			//   - the install AREA node ABOVE the cloned section (the closure that
			//     built the `test` TLD stops at the SECTION root, so the section
			//     entry's `parent_grouper` cannot be mapped) — asserted to BE that
			//     field, on both sides;
			//   - (until 2026-10-28, two further COMPONENT entries on the second
			//     section; the regeneration cloned them.) The compared GROUPER keys
			//     are still asserted to carry no install token at all, on both sides.
			const adopted = adoptTipoIdMap(body, 'grouper_context_differential');
			expect(adopted.kind).toBe('install_tipo_left');
			expect(adopted.rewrites.tipos).toBeGreaterThan(0);
			expect(adopted.rewrites.ids).toBeGreaterThan(0);
			const phpContext = (adopted.body.result as { context: Record<string, unknown>[] }).context;
			// The section entry's parent IS one of the leftovers, and the clone's
			// own root is a `test` node — both sides of the seam, stated.
			const frozenParentGrouper = phpContext[0]?.parent_grouper;
			expect(adopted.leftovers).toContain(frozenParentGrouper as string);
			// BOUNDED, not merely "contains": without a cap on the leftover set a
			// NEW unmapped surface appearing in this frozen body would ride along
			// unnoticed (review 2026-08-20). The declared reduction is the area
			// chain above the clone cut, and every leftover must belong to it.
			// BOUNDED: exactly the declared reduction, no more.
			expect(adopted.leftovers.length).toBe(expectedLeftovers);
			const tsContext = (await readSection(rqo)).context as unknown as Record<string, unknown>[];
			expect(String(tsContext[0]?.parent_grouper).startsWith('test')).toBe(true);
			const phpGroupers = phpContext.filter(isGrouper).map(grouperKey).sort();
			const tsGroupers = tsContext.filter(isGrouper).map(grouperKey).sort();
			// What this gate compares carries no install token on either side.
			expect(installTokensIn(phpGroupers)).toEqual([]);
			expect(installTokensIn(tsGroupers)).toEqual([]);
			expect(phpGroupers.length).toBeGreaterThan(0);
			expect(tsGroupers).toEqual(phpGroupers);
		});
	}
});
