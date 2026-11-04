/**
 * THE CLIENT SUITE'S NESTING SITUATION — a REAL caller for a nested `test80`.
 *
 * WHAT IT IS FOR. `test_nested_portal.js` (client suite, consistent paging —
 * owner decision (a) of the nested-ddo_map plan) builds a `test80` portal
 * NESTED under another component and checks that page 1, page 2 and a refresh
 * keep the columns its caller declared. A nested element's own reads name
 * their caller chain in `rqo.source.callers`, and the server VERIFIES that
 * chain against the ontology (src/core/relations/caller_chain.ts): every link
 * must be a data child the link above it declares. The canonical playground
 * has no component whose map declares `test80` children, so the suite could
 * only fake its ancestry — a chain the server refused (logging
 * `refused source.callers for "test80" @ "test3"`) and the paging leg rode the
 * client's sent `show` alone. This situation is the missing structure: with it,
 * the same leg runs under a chain the server ACCEPTS, and the suite proves the
 * chain itself resolves the injected columns (a read with the chain and no
 * `show` still carries them; the fake chain does not).
 *
 * THE STRUCTURE (a scratch TLD, never the vendored `test` ontology):
 *
 *   NESTING_SECTION_TIPO  section, stores in matrix_test (relation test24, as
 *                         test480 does) — holds no record: a chain names
 *                         elements, not rows
 *   NESTING_PORTAL_TIPO   component_portal of that section, targeting test3,
 *                         whose show declares
 *                           test80  (parent self, section self → test3)
 *                           test211 (parent test80, section test3)
 *                           test52  (parent test80, section test3)
 *                         — test80's OWN show is [test52], so `test211` is the
 *                         injected column a verified chain must bring.
 *   Nested ddos name `test3` explicitly: `section_tipo: 'self'` is valid only on
 *   a first-level ddo (WC-2026-11-04-ddo-self-first-level-only).
 *
 * WHY RUNNER-SCOPED, NOT SEEDED (the projects_fixture.ts reasoning). A section
 * and a portal are the nesting suite's situation, not the playground's shape:
 * seeding them would widen the ontology every unit and parity gate on this
 * database sees. scripts/client_test_runner.ts and scripts/client_test_serve.ts
 * install it before their server spawns (so the server reads the nodes cold —
 * an ontology write only clears THIS process's caches) and sweep it after.
 *
 * Writes through the situation door (ensureSituation / dropSituation): the
 * marker check, the engine's own dd_ontology upsert, a TLD-scoped teardown and
 * a residue count. Gate: test/unit/client_situations_native.test.ts.
 */

import { DedaloError } from '../errors/dedalo_error.ts';
import {
	dropSituation,
	ensureSituation,
	type Situation,
	situation,
} from './situations/situation.ts';

/** The scratch TLD this fixture owns (reserved `zz*` grammar). */
export const NESTING_TLD = 'zzcnp';
/** The section the nesting portal belongs to (the chain's root section). */
export const NESTING_SECTION_TIPO = `${NESTING_TLD}1`;
/** The outer portal whose map declares test80's children (the chain's root). */
export const NESTING_PORTAL_TIPO = `${NESTING_TLD}2`;

/** The playground tipos the outer map names (client test_nested_portal.js pins the same). */
const PLAYGROUND_SECTION = 'test3';
const NESTED_PORTAL = 'test80';
const INJECTED_NUMBER = 'test211';
const NESTED_TEXT = 'test52';

/** The situation descriptor — one place, so ensure and sweep cannot disagree. */
export function nestedPortalSituation(): Situation {
	return situation({
		tld: NESTING_TLD,
		name: 'client nested portal (verified caller chain)',
		nodes: [
			{
				tipo: NESTING_SECTION_TIPO,
				parent: 'dd14',
				model: 'section',
				term: { 'lg-eng': 'Nested portal host', 'lg-spa': 'Anfitrión de portal anidado' },
				relations: [{ tipo: 'test24' }],
				order_number: 1,
			},
			{
				tipo: NESTING_PORTAL_TIPO,
				parent: NESTING_SECTION_TIPO,
				model: 'component_portal',
				term: { 'lg-eng': 'Nesting portal', 'lg-spa': 'Portal anidador' },
				order_number: 1,
				properties: {
					source: {
						request_config: [
							{
								sqo: { section_tipo: [{ value: [PLAYGROUND_SECTION], source: 'section' }] },
								show: {
									ddo_map: [
										{ tipo: NESTED_PORTAL, parent: 'self', section_tipo: 'self' },
										{
											tipo: INJECTED_NUMBER,
											parent: NESTED_PORTAL,
											section_tipo: PLAYGROUND_SECTION,
										},
										{ tipo: NESTED_TEXT, parent: NESTED_PORTAL, section_tipo: PLAYGROUND_SECTION },
									],
								},
							},
						],
					},
				},
			},
		],
	});
}

/** Install the nesting situation (idempotent: a whole-row upsert per node). */
export async function ensureNestedPortalFixture(): Promise<void> {
	await ensureSituation(nestedPortalSituation());
}

/**
 * Sweep it. REFUSES (typed) when anything survives the teardown — a residue
 * would leave a scratch section and portal in the ontology every other tier
 * on this shared database reads.
 */
export async function removeNestedPortalFixture(): Promise<void> {
	const residue = await dropSituation(nestedPortalSituation());
	if (residue !== 0) {
		throw new DedaloError('internal.invariant', {
			message: `nested_portal_fixture: ${residue} row(s) of ${NESTING_TLD} survived the sweep`,
			coordinates: { tld: NESTING_TLD },
		});
	}
}
