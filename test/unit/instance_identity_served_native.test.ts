/**
 * THE INSTALLATION COLOUR WHERE IT IS SERVED (WC-2026-11-09-instance-identity):
 * buildPageGlobals must carry `dedalo_instance_color` + `dedalo_entity_label`
 * UNCONDITIONALLY — pre-auth too, or the login page (tab favicon, title) goes
 * unmarked — with the configured values. The parity differential also sees the
 * keys, but only on a box with PHP credentials; this is the native gate.
 *
 * Needs the suite database (buildPageGlobals resolves the project langs).
 */

import { describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import { buildPageGlobals } from '../../src/core/resolve/environment.ts';

describe('installation colour in page_globals', () => {
	test('both keys served pre-auth, with the configured values', async () => {
		const globals = await buildPageGlobals(null, null);
		expect('dedalo_instance_color' in globals).toBe(true);
		expect('dedalo_entity_label' in globals).toBe(true);
		expect(globals.dedalo_instance_color).toBe(config.identity.instanceColor);
		expect(globals.dedalo_entity_label).toBe(config.identity.entityLabel);
	});

	test('the colour is null (feature off) or a #rrggbb — nothing else reaches page CSS', async () => {
		const color = (await buildPageGlobals(null, null)).dedalo_instance_color;
		expect(color === null || /^#[0-9a-f]{6}$/.test(String(color))).toBe(true);
	});
});
