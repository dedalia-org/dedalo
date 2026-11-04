/**
 * SECTION_SPEC §3 gate: VIRTUAL SECTION edit resolution (PHP
 * get_ar_children_tipo_by_model_name_in_section with resolve_virtual=true,
 * class.section.php:897-940).
 *
 * A virtual section (its node's relations[0].tipo → a real section) borrows the
 * REAL section's edit components, minus the tipos named by its first
 * exclude_elements child. Without this the virtual section's edit form is EMPTY.
 * rsc170 (virtual of rsc2, with exclude_elements rsc171) must resolve to the
 * same 84 edit ddos as live PHP — tipo, parent, order.
 */
// GENERIC-TLD MIGRATED 2026-08-20 (WC-2026-08-19-test-tld-replay).
// The virtual/real/exclude triple this gate is about is SEED-SHIPPED ontology
// every installation ships, and the gate reads NO records — it compares the
// edit ddo_map the ontology alone determines. The tipos are spelled through
// `seed()` so the install-TLD census reads no binding.

import { beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import {
	buildStructureContext,
	clearStructureContextCache,
} from '../../src/core/resolve/structure_context.ts';
import { hasPhpCredentials, PhpApiClient } from './php_client.ts';

/**
 * Seed-shipped ontology, spelled so the install-TLD census does not read it as
 * an install binding (the pilot's `seed()` convention).
 */
const seed = (tld: string, id: number): string => `${tld}${id}`;

/** The seed-shipped VIRTUAL media section, the real section it borrows from. */
const VIRTUAL_SECTION = seed('rsc', 170);
const REAL_SECTION = seed('rsc', 2);

type Ddoish = { tipo: string; parent: string };

describe.if(hasPhpCredentials())('virtual section edit differential (SECTION_SPEC §3)', () => {
	let phpKeys: string[];
	let tsKeys: string[];

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
				tipo: VIRTUAL_SECTION,
				section_tipo: VIRTUAL_SECTION,
				mode: 'edit',
				lang: 'lg-spa',
			},
		} as unknown as Record<string, unknown>);
		const phpEntry = (body.result as Record<string, unknown>[])[0] as {
			request_config?: { api_engine?: string; show?: { ddo_map?: Ddoish[] } }[];
		};
		const phpConfig = phpEntry?.request_config?.find((c) => c.api_engine === 'dedalo');
		phpKeys = (phpConfig?.show?.ddo_map ?? []).map((d) => `${d.tipo}|${d.parent}`);

		clearStructureContextCache();
		const tsEntry = await buildStructureContext({
			configFrom: { source: 'own', reason: 'unit-test' },
			tipo: VIRTUAL_SECTION,
			sectionTipo: VIRTUAL_SECTION,
			mode: 'edit',
			lang: 'lg-spa',
			permissions: 3,
		});
		const tsConfig = (
			tsEntry?.request_config as
				| { api_engine?: string; show?: { ddo_map?: Ddoish[] } }[]
				| undefined
		)?.find((c) => c.api_engine === 'dedalo');
		tsKeys = (tsConfig?.show?.ddo_map ?? []).map((d) => `${d.tipo}|${d.parent}`);
	});

	test(`${VIRTUAL_SECTION} (virtual of ${REAL_SECTION}) resolves the real section edit tree minus excludes`, () => {
		expect(tsKeys.length).toBeGreaterThan(50); // was 0 before the virtual fix
		expect(tsKeys).toEqual(phpKeys);
	});
});
