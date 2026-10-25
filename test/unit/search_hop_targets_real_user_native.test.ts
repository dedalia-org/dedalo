/**
 * THE SEARCH-HOP RULE WITH A REAL RESTRICTED USER — no injected grant
 * (WC-2026-10-01-search-hop-configured-targets; search/hop_scope.ts).
 *
 * search_hop_targets_native proves the rule with the scope's `componentGrant`
 * seam. This file proves it end to end through the REAL permission system: a
 * non-admin user (scope-binding fixture user A, own profile, own project) whose
 * grants are rows in the profile's misc.dd774, resolved by resolvePrincipal /
 * getPermissions, searched through the real assembler (buildSearchSql), with the
 * real record predicate (A's project) on the main section.
 *
 * Situation (built, swept): zzhr1 REAL section + zzhr2 text field; zzhr3 its
 * VIRTUAL twin (borrows zzhr2); zzhr4 a portal ON test3 targeting [REAL, VIRT]
 * and displaying zzhr2. Two test3 host records of A (A's project stamped), one
 * linking to a REAL record ('zzreal visible'), one to a VIRT record ('zzreal
 * secret'). A is granted test3 + the portal + REAL's field — NOT VIRT's.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import { sanitizeClientSqo } from '../../src/core/concepts/sqo.ts';
import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { buildSearchSql } from '../../src/core/search/sql_assembler.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { deleteSectionRecord } from '../../src/core/section/record/delete_record.ts';
import {
	clearPermissionsCache,
	clearPrincipalCache,
	clearUserProjectsCache,
	type Principal,
	resolvePrincipal,
} from '../../src/core/security/permissions.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import { SB_GRANTED_SECTION, scopeBindingSlot } from '../helpers/scope_binding_fixture.ts';

/** THIS file's slot for the scope-binding fixture (ids allocated at install). */
const sb = scopeBindingSlot();

const REAL = 'zzhr1';
const TEXT = 'zzhr2';
const VIRT = 'zzhr3';
const HOP = 'zzhr4';
const HOST = SB_GRANTED_SECTION; // test3 — carries a component_filter (test101)

const R1 = 900801; // REAL 'zzreal visible'
const V1 = 900802; // VIRT 'zzreal secret'

const shown = (value: string) => ({ string: { [TEXT]: [{ id: 1, lang: 'lg-nolan', value }] } });

const S = situation({
	name: 'search hop real user',
	tld: 'zzhr',
	nodes: [
		{ tipo: REAL, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
		{ tipo: TEXT, parent: REAL, model: 'component_input_text' },
		{
			tipo: VIRT,
			parent: 'test1',
			model: 'section',
			relations: [{ tipo: REAL }, { tipo: 'test24' }],
		},
		{
			tipo: HOP,
			parent: HOST,
			model: 'component_portal',
			properties: {
				source: {
					request_config: [
						{
							sqo: { section_tipo: [{ source: 'section', value: [REAL, VIRT] }] },
							show: { ddo_map: [{ tipo: TEXT, parent: 'self', section_tipo: 'self' }] },
						},
					],
				},
			},
		},
	],
	records: [
		{ section_tipo: REAL, section_id: R1, columns: shown('zzreal visible') },
		{ section_tipo: VIRT, section_id: V1, columns: shown('zzreal secret') },
	],
});

let hostToReal = 0;
let hostToVirt = 0;

const grant = (id: number, sectionTipo: string, tipo: string, value: number) => ({
	id,
	tipo,
	section_tipo: sectionTipo,
	value,
});

/** A's profile grants — the fixture's test3 rows plus the hop and the twins asked for. */
async function setGrantsOfA(twins: string[]): Promise<void> {
	const rows = [
		grant(1, HOST, HOST, 2),
		grant(2, HOST, 'test52', 2),
		grant(3, HOST, 'test101', 2),
		grant(4, HOST, HOP, 2),
		...twins.flatMap((twin, index) => [
			grant(10 + index * 2, twin, twin, 2),
			grant(11 + index * 2, twin, TEXT, 2),
		]),
	];
	await sql.unsafe(
		`UPDATE matrix_profiles SET misc = $1::text::jsonb WHERE section_tipo = 'dd234' AND section_id = $2`,
		[encodeForJsonb({ dd774: rows }), sb.profileA],
	);
	clearPrincipalCache();
	clearUserProjectsCache();
	clearPermissionsCache();
}

async function stampHost(hostId: number, targetSection: string, targetId: number): Promise<void> {
	await sql.unsafe(
		`UPDATE matrix_test SET relation = coalesce(relation, '{}'::jsonb) || $3::text::jsonb
		 WHERE section_tipo = $1 AND section_id = $2`,
		[
			HOST,
			hostId,
			encodeForJsonb({
				test101: [
					{
						id: 1,
						type: 'dd675',
						section_id: sb.projectOfA,
						section_tipo: config.features.filterSectionTipo,
						from_component_tipo: 'test101',
					},
				],
				[HOP]: [
					{
						id: 1,
						type: 'dd151',
						section_id: targetId,
						section_tipo: targetSection,
						from_component_tipo: HOP,
					},
				],
			}),
		],
	);
}

/** test3 host ids (of this file) whose HOP reaches a TEXT value containing `q`. */
async function hostsFor(principal: Principal, q: string): Promise<number[]> {
	const sqo = sanitizeClientSqo({
		section_tipo: [HOST],
		limit: 50,
		offset: 0,
		filter: {
			$and: [
				{
					q,
					path: [
						{ section_tipo: HOST, component_tipo: HOP },
						// what the client writes: section_tipo[0] of the multi-target ddo
						{ section_tipo: REAL, component_tipo: TEXT },
					],
				},
			],
		},
	} as never);
	const built = await buildSearchSql(sqo, { principal });
	const rows = (await sql.unsafe(built.sql, built.params as never[])) as { section_id: number }[];
	return rows
		.map((row) => Number(row.section_id))
		.filter((id) => id === hostToReal || id === hostToVirt)
		.sort();
}

describe.if(DB_READY)(
	'search hop rule — a REAL restricted user (profile grants, own project)',
	() => {
		let A: Principal;
		let root: Principal;

		beforeAll(async () => {
			await sb.install();
			await ensureSituation(S);
			hostToReal = await createSectionRecord(HOST, sb.userA);
			hostToVirt = await createSectionRecord(HOST, sb.userA);
			await stampHost(hostToReal, REAL, R1);
			await stampHost(hostToVirt, VIRT, V1);
			root = await resolvePrincipal(-1);
		});
		afterAll(async () => {
			try {
				if (hostToReal > 0) await deleteSectionRecord(HOST, hostToReal, -1);
				if (hostToVirt > 0) await deleteSectionRecord(HOST, hostToVirt, -1);
				await dropSituation(S);
			} finally {
				await sb.release();
			}
		});

		test('non-degeneracy: root reaches both twins through the hop', async () => {
			expect(await hostsFor(root, 'zzreal visible')).toEqual([hostToReal]);
			expect(await hostsFor(root, 'zzreal secret')).toEqual([hostToVirt]);
		});

		test('A granted on REAL only: reaches REAL, NOT the virtual twin (the leak, closed)', async () => {
			await setGrantsOfA([REAL]);
			A = await resolvePrincipal(sb.userA);
			expect(A.isGlobalAdmin).toBe(false);
			expect(await hostsFor(A, 'zzreal visible')).toEqual([hostToReal]);
			expect(await hostsFor(A, 'zzreal secret')).toEqual([]);
			// hit and miss on the hidden twin answer alike: a prefix probe learns nothing
			expect(await hostsFor(A, 'zzreal sec')).toEqual(await hostsFor(A, 'zzreal nomatch'));
		});

		test('A granted on both twins: reaches both', async () => {
			await setGrantsOfA([REAL, VIRT]);
			A = await resolvePrincipal(sb.userA);
			expect(await hostsFor(A, 'zzreal visible')).toHaveLength(1);
			expect(await hostsFor(A, 'zzreal secret')).toEqual([hostToVirt]);
		});

		test('A with no grant on either twin: the hop reaches nothing', async () => {
			await setGrantsOfA([]);
			A = await resolvePrincipal(sb.userA);
			expect(await hostsFor(A, 'zzreal visible')).toEqual([]);
			expect(await hostsFor(A, 'zzreal secret')).toEqual([]);
		});
	},
);
