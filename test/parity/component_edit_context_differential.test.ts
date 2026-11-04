/**
 * Component EDIT-context extras gate: the per-model context fields the client's
 * edit view requires but a bare structure-context omits — surfaced by the rsc170
 * (virtual media section) edit form, which crashed without them.
 *
 * - Media components (PHP component_<media>_json default branch): context.features
 *   with the quality ladder + upload whitelist. The client reads
 *   context.features.quality/ar_quality to render the quality picker.
 * - Relation components (PHP component_<relation>_json set_target_sections):
 *   context.target_sections = [{tipo,label}] for the "go to target" buttons.
 *
 * Byte-parity vs live PHP on the structural fields. The media EXTENSION lists
 * (allowed_extensions / alternative_extensions) are install-config specific
 * (this install customizes DEDALO_IMAGE_EXTENSIONS_SUPPORTED) and are LEDGERED —
 * the TS media features use the PHP sample-config defaults.
 */
// GENERIC-TLD MIGRATED 2026-08-20 (WC-2026-08-19-test-tld-replay).
// Nothing install-bound is left: every tipo this gate names is SEED-SHIPPED
// ontology (`rsc`), which every installation ships, and the gate reads no
// RECORDS at all — it compares the per-model context extras the ontology
// alone determines. The tipos are spelled through `seed()` so the install-TLD
// census reads no binding.

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

/** The seed-shipped virtual media section, its image and its check_box. */
const SECTION = seed('rsc', 170);
const IMAGE = seed('rsc', 29);
const CHECK_BOX = seed('rsc', 156);

describe.if(hasPhpCredentials())('component edit-context extras differential', () => {
	let php: PhpApiClient;
	beforeAll(async () => {
		php = new PhpApiClient();
		await php.login(config.phpReference.username as string, config.phpReference.password as string);
	});

	async function phpCtx(model: string, tipo: string, st: string): Promise<Record<string, unknown>> {
		const { body } = await php.call({
			action: 'get_element_context',
			dd_api: 'dd_core_api',
			source: { model, tipo, section_tipo: st, mode: 'edit', lang: 'lg-spa' },
		} as unknown as Record<string, unknown>);
		return (body.result as Record<string, unknown>[])[0] as Record<string, unknown>;
	}

	test(`media component features: quality ladder matches PHP (${IMAGE} image)`, async () => {
		const php_ = (await phpCtx('component_image', IMAGE, SECTION)).features as Record<
			string,
			unknown
		>;
		clearStructureContextCache();
		const ts = (
			(await buildStructureContext({
				configFrom: { source: 'own', reason: 'unit-test' },
				tipo: IMAGE,
				sectionTipo: SECTION,
				mode: 'edit',
				lang: 'lg-spa',
				permissions: 3,
			})) as { features?: Record<string, unknown> }
		).features as Record<string, unknown>;
		expect(ts).toBeDefined();
		// Structural fields (install-independent).
		expect(ts.ar_quality).toEqual(php_.ar_quality);
		expect(ts.default_quality).toEqual(php_.default_quality);
		expect(ts.quality).toEqual(php_.quality);
		expect(ts.default_target_quality).toEqual(php_.default_target_quality);
		expect(ts.key_dir).toEqual(php_.key_dir);
		expect(ts.extension).toEqual(php_.extension);
	});

	test(`relation component target_sections match PHP (${CHECK_BOX} check_box)`, async () => {
		const php_ = (await phpCtx('component_check_box', CHECK_BOX, SECTION)).target_sections;
		clearStructureContextCache();
		const ts = (
			(await buildStructureContext({
				configFrom: { source: 'own', reason: 'unit-test' },
				tipo: CHECK_BOX,
				sectionTipo: SECTION,
				mode: 'edit',
				lang: 'lg-spa',
				permissions: 3,
			})) as { target_sections?: unknown }
		).target_sections;
		expect(ts).toEqual(php_);
	});
});
