/**
 * COMPONENT_INVERSE EMISSION — a list read computes the record's backlinks.
 *
 * Reported on the cataloguing tool (numisdata672): the "used" drag marker
 * never lit, because the dd1596 component_inverse item of every row came back
 * `entries: []`. The model owns no stored value (descriptor `derived`) and had
 * no emit hook, so the generic literal path read its empty `misc` slot. PHP
 * (component_inverse::get_data → section_record::get_inverse_references →
 * search_related::get_referenced_locators) computes it live: one entry per
 * referencing LOCATOR, the stored locator stamped with `from_section_tipo` and
 * `from_section_id` (PHP: a string; TS: an INT, WC-2026-08-10-section-id-int-canonical).
 * `render_column_drag` reads exactly that shape
 * (`entries[].from_section_tipo`).
 *
 * The contract pinned here, over a situation this file BUILDS on the generic
 * `test` TLD (no install TLD, AGENTS.md 2026-08-19):
 *   - a referenced target emits ONE entry per referencing locator (an owner
 *     pointing from two components contributes two), each carrying
 *     from_section_tipo / from_section_id (int) / from_component_tipo and
 *     the target's own coordinates;
 *   - an unreferenced target still emits its item, with `entries: []`
 *     (WC-001 — never null, never missing).
 *
 * Situation built here (one TLD, dropped in afterAll with residue asserted 0):
 *   zzinv1  section (relations test24)           targets §900901 (referenced), §900902 (not)
 *     zzinv2  component_inverse                  the computed backlinks
 *   zzinv3  section (relations test24)           owners §900911, §900912
 *     zzinv4  component_portal → zzinv1
 *     zzinv5  component_portal → zzinv1
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolveInverseEntries } from '../../src/core/components/component_inverse/emit.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { readSectionRows } from '../../src/core/section/read.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import { runWithRequestContext } from '../../src/core/security/request_context.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';

const TARGET = 'zzinv1';
const INVERSE = 'zzinv2';
const OWNER = 'zzinv3';
const PORTAL_A = 'zzinv4';
const PORTAL_B = 'zzinv5';

const REFERENCED_ID = 900901;
const UNREFERENCED_ID = 900902;
/** Owner 1 points from PORTAL_A only; owner 2 from both portals. */
const OWNER_ONE_ID = 900911;
const OWNER_TWO_ID = 900912;
/** A user id no matrix_users record holds: no profile, so no section read grant. */
const NO_PROFILE_USER_ID = 900999;

function locator(sectionId: number, fromTipo: string): Record<string, unknown> {
	return {
		section_id: sectionId,
		section_tipo: TARGET,
		type: 'dd151',
		from_component_tipo: fromTipo,
	};
}

const S = situation({
	name: 'component_inverse emission',
	tld: 'zzinv',
	nodes: [
		{
			tipo: TARGET,
			parent: 'test1',
			model: 'section',
			term: { 'lg-eng': 'Inverse target section' },
			relations: [{ tipo: 'test24' }],
		},
		{ tipo: INVERSE, parent: TARGET, model: 'component_inverse' },
		{
			tipo: OWNER,
			parent: 'test1',
			model: 'section',
			term: { 'lg-eng': 'Inverse owner section' },
			relations: [{ tipo: 'test24' }],
		},
		{ tipo: PORTAL_A, parent: OWNER, model: 'component_portal' },
		{ tipo: PORTAL_B, parent: OWNER, model: 'component_portal' },
	],
	records: [
		{ section_tipo: TARGET, section_id: REFERENCED_ID, columns: {} },
		{ section_tipo: TARGET, section_id: UNREFERENCED_ID, columns: {} },
		{
			section_tipo: OWNER,
			section_id: OWNER_ONE_ID,
			columns: { relation: { [PORTAL_A]: [locator(REFERENCED_ID, PORTAL_A)] } },
		},
		{
			section_tipo: OWNER,
			section_id: OWNER_TWO_ID,
			columns: {
				relation: {
					[PORTAL_A]: [locator(REFERENCED_ID, PORTAL_A)],
					[PORTAL_B]: [locator(REFERENCED_ID, PORTAL_B)],
				},
			},
		},
	],
});

/** The section LIST read the cataloguing mosaic issues: a ddo_map holding the inverse column. */
function readRqo(): Rqo {
	return {
		action: 'read',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		source: {
			model: 'section',
			tipo: TARGET,
			section_tipo: TARGET,
			mode: 'list',
			lang: 'lg-eng',
			action: 'search',
		},
		sqo: {
			section_tipo: [TARGET],
			filter_by_locators: [
				{ section_tipo: TARGET, section_id: REFERENCED_ID },
				{ section_tipo: TARGET, section_id: UNREFERENCED_ID },
			],
			limit: 2,
			offset: 0,
		},
		show: {
			ddo_map: [{ tipo: INVERSE, section_tipo: 'self', parent: 'self', mode: 'list' }],
		},
	} as unknown as Rqo;
}

beforeAll(async () => {
	await ensureSituation(S);
});

afterAll(async () => {
	expect(await dropSituation(S)).toBe(0);
});

describe('component_inverse — a list read emits the computed backlinks per row', () => {
	test('referenced row: one entry per referencing locator, stamped from_*', async () => {
		const items = (await readSectionRows(readRqo())) as unknown as Record<string, unknown>[];
		const inverse = items.filter((item) => item.tipo === INVERSE);
		// Non-vacuity floor: both rows emitted their inverse item.
		expect(inverse.length).toBe(2);

		const referenced = inverse.find((item) => item.section_id === REFERENCED_ID);
		expect(referenced).toBeDefined();
		expect(referenced?.section_tipo).toBe(TARGET);
		expect(referenced?.lang).toBe('lg-nolan');
		const entries = referenced?.entries as Record<string, unknown>[];
		expect(Array.isArray(entries)).toBe(true);

		// The shape render_column_drag reads (and PHP's get_referenced_locators):
		// the stored locator + the owner's coordinates, from_section_id an INT (the int-canonical
		// law: every record address on the app API; PHP carried a string).
		const triples = entries
			.map(
				(entry) =>
					`${entry.from_section_tipo}|${entry.from_section_id}|${entry.from_component_tipo}`,
			)
			.sort();
		expect(triples).toEqual(
			[
				`${OWNER}|${OWNER_ONE_ID}|${PORTAL_A}`,
				`${OWNER}|${OWNER_TWO_ID}|${PORTAL_A}`,
				`${OWNER}|${OWNER_TWO_ID}|${PORTAL_B}`,
			].sort(),
		);
		for (const entry of entries) {
			expect(Number.isSafeInteger(entry.from_section_id)).toBe(true);
			expect(entry.section_tipo).toBe(TARGET);
			expect(Number(entry.section_id)).toBe(REFERENCED_ID);
		}
	});

	test('unreferenced row: the item still emits, with entries: []', async () => {
		const items = (await readSectionRows(readRqo())) as unknown as Record<string, unknown>[];
		// Non-vacuity floor: the read emitted the inverse item of BOTH rows, so an
		// empty `entries` below is the computed answer, not a read that saw nothing.
		expect(items.filter((item) => item.tipo === INVERSE)).toHaveLength(2);
		const unreferenced = items.find(
			(item) => item.tipo === INVERSE && item.section_id === UNREFERENCED_ID,
		);
		expect(unreferenced).toBeDefined();
		expect(unreferenced?.entries).toEqual([]);
	});

	// AUTHZ-05: the backlinks go back to the requester, so an owner the requester
	// may not read is NOT named. Both identities ask about the SAME referenced
	// record; only the read grant differs (a global admin vs a user with no profile).
	test('backlinks are scoped to the requester: owners the caller cannot read are not named', async () => {
		const asPrincipal = (principal: Principal) =>
			runWithRequestContext(
				{ principal, session: null, requestId: 'zzinv-scope', clientIp: '127.0.0.1' },
				() => resolveInverseEntries(TARGET, REFERENCED_ID),
			);
		const admin = await asPrincipal({ userId: -1, isGlobalAdmin: true, isDeveloper: false });
		const stranger = await asPrincipal({
			userId: NO_PROFILE_USER_ID,
			isGlobalAdmin: false,
			isDeveloper: false,
		});
		expect({ admin: admin.length, stranger: stranger.length }).toEqual({ admin: 3, stranger: 0 });
	});
});
