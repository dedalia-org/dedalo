/**
 * A SEARCH HOP REACHES ONLY ITS COMPONENT'S CONFIGURED TARGETS THE CALLER MAY
 * READ (search/hop_scope.ts, WC-2026-10-01-search-hop-configured-targets).
 *
 * THE LEAK THIS CLOSES. A hop joins the record each stored locator names; the
 * path step DECLARES one section, and the frontier keys (component grant,
 * record predicate) were evaluated for that declared section only. Two sections
 * sharing a table and a component — a REAL section and its VIRTUAL twin — could
 * be read through each other: granted the text field on REAL, not on VIRT, a
 * caller declared REAL and matched VIRT's values (prefix oracle, sideways).
 *
 * Situation (built, swept): zzhq1 REAL section + zzhq2 text field; zzhq3 VIRTUAL
 * section of zzhq1 (borrows zzhq2); zzhq4 HOST section whose portal zzhq5
 * targets [REAL, VIRT] and displays zzhq2; zzhq6 OTHER section (same table,
 * also has a zzhq2-keyed value) that the portal does NOT target. All in
 * matrix_test. The principal's component grant is INJECTED (the scope's
 * `componentGrant` seam), so the gate exercises exactly the hop rule.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../../src/core/db/postgres.ts';
import { buildJoinChain, conformFilter } from '../../src/core/search/conform.ts';
import { planDeepFilters } from '../../src/core/search/deep_path.ts';
import { ParamsCollector } from '../../src/core/search/params.ts';
import { renderConformedFilter } from '../../src/core/search/sql_assembler.ts';
import {
	currentFrontierRefusals,
	type SqlFrontierScope,
} from '../../src/core/security/frontier_scope.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import { runWithRequestContext } from '../../src/core/security/request_context.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { DB_READY } from '../helpers/db_ready.ts';

const REAL = 'zzhq1';
const TEXT = 'zzhq2';
const VIRT = 'zzhq3';
const HOST = 'zzhq4';
const PORTAL = 'zzhq5';
const OTHER = 'zzhq6';
/** A `self`-targeting portal on REAL (VIRT borrows it): its target is whichever section holds the record. */
const SELF_HOP = 'zzhq7';
/** T1-16: the relation leaf's step component (a portal on REAL, VIRT borrows it). */
const RELF = 'zzhq8';
/** T1-16: a second relation component on REAL (VIRT borrows it) — the one hidden on VIRT. */
const HIDDENREL = 'zzhq9';

const R1 = 900701; // REAL, 'zzleak visible'
const V1 = 900702; // VIRT, 'zzleak secret'
const O1 = 900703; // OTHER (not a target), 'zzleak stray'
const H_REAL = 900711; // → R1
const H_VIRT = 900712; // → V1
const H_OTHER = 900713; // → O1 (a locator outside the configured targets)
const HOSTS = [H_REAL, H_VIRT, H_OTHER];
const R2 = 900704; // REAL, SELF_HOP → R1
const V2 = 900705; // VIRT, SELF_HOP → V1
const R3 = 900706; // REAL, HIDDENREL → (REAL, R1)
const V3 = 900707; // VIRT, HIDDENREL → (REAL, R1)
const MISS_ID = 900709; // never inserted: the miss probe's target
const H_R3 = 900714; // → R3
const H_V3 = 900715; // → V3
const LEAF_HOSTS = [H_R3, H_V3];

const shown = (value: string) => ({
	string: { [TEXT]: [{ id: 1, lang: 'lg-nolan', value }] },
});
const link = (sectionTipo: string, sectionId: number) => ({
	relation: {
		[PORTAL]: [
			{
				id: 1,
				type: 'dd151',
				section_id: sectionId,
				section_tipo: sectionTipo,
				from_component_tipo: PORTAL,
			},
		],
	},
});

const selfLink = (sectionTipo: string, sectionId: number) => ({
	relation: {
		[SELF_HOP]: [
			{
				id: 1,
				type: 'dd151',
				section_id: sectionId,
				section_tipo: sectionTipo,
				from_component_tipo: SELF_HOP,
			},
		],
	},
});

const hiddenLink = (sectionTipo: string, sectionId: number) => ({
	relation: {
		[HIDDENREL]: [
			{
				id: 1,
				type: 'dd151',
				section_id: sectionId,
				section_tipo: sectionTipo,
				from_component_tipo: HIDDENREL,
			},
		],
	},
});

const S = situation({
	name: 'search hop configured targets',
	tld: 'zzhq',
	nodes: [
		{ tipo: REAL, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
		{ tipo: TEXT, parent: REAL, model: 'component_input_text' },
		// VIRTUAL: its relations name a node whose model is section (REAL).
		{
			tipo: VIRT,
			parent: 'test1',
			model: 'section',
			relations: [{ tipo: REAL }, { tipo: 'test24' }],
		},
		{ tipo: HOST, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
		{
			tipo: PORTAL,
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
		{ tipo: OTHER, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
		{
			tipo: SELF_HOP,
			parent: REAL,
			model: 'component_portal',
			properties: {
				source: {
					request_config: [
						{
							sqo: { section_tipo: [{ source: 'self' }] },
							show: { ddo_map: [{ tipo: TEXT, parent: 'self', section_tipo: 'self' }] },
						},
					],
				},
			},
		},
		{ tipo: RELF, parent: REAL, model: 'component_portal' },
		{ tipo: HIDDENREL, parent: REAL, model: 'component_portal' },
	],
	records: [
		{ section_tipo: REAL, section_id: R1, columns: shown('zzleak visible') },
		{ section_tipo: VIRT, section_id: V1, columns: shown('zzleak secret') },
		{ section_tipo: OTHER, section_id: O1, columns: shown('zzleak stray') },
		{ section_tipo: HOST, section_id: H_REAL, columns: link(REAL, R1) },
		{ section_tipo: HOST, section_id: H_VIRT, columns: link(VIRT, V1) },
		{ section_tipo: HOST, section_id: H_OTHER, columns: link(OTHER, O1) },
		{ section_tipo: REAL, section_id: R2, columns: selfLink(REAL, R1) },
		{ section_tipo: VIRT, section_id: V2, columns: selfLink(VIRT, V1) },
		{ section_tipo: REAL, section_id: R3, columns: hiddenLink(REAL, R1) },
		{ section_tipo: VIRT, section_id: V3, columns: hiddenLink(REAL, R1) },
		{ section_tipo: HOST, section_id: H_R3, columns: link(REAL, R3) },
		{ section_tipo: HOST, section_id: H_V3, columns: link(VIRT, V3) },
	],
});

const USER: Principal = { userId: 900799, isGlobalAdmin: false, isDeveloper: false };

/** A scope whose component grant is exactly `granted` ([section, component] pairs). */
function scopeFor(principal: Principal | undefined, granted: [string, string][]): SqlFrontierScope {
	return {
		...(principal === undefined ? {} : { principal }),
		surface: 'search',
		door: 'search.path',
		// none → firstHopSources falls back to the declared first step
		mainSectionTipos: [],
		componentGrant: async (_principal, sectionTipo, componentTipo) =>
			granted.some(([s, c]) => s === sectionTipo && c === componentTipo) ? 2 : 0,
		recordPredicate: async () => '',
	};
}

/** The HOST records whose hop (declared step `stepSection`) reaches a TEXT value matching `value`. */
async function hostsMatching(
	scope: SqlFrontierScope,
	stepSection: string,
	value: string,
): Promise<{ ids: number[]; acl: string }> {
	const chain = await buildJoinChain(
		[
			{ section_tipo: HOST, component_tipo: PORTAL },
			{ section_tipo: stepSection, component_tipo: TEXT },
		],
		'h',
		scope,
	);
	const hop = chain.hops[0];
	if (hop === undefined) throw new Error('no hop');
	const rows = (await sql.unsafe(
		`SELECT h.section_id FROM matrix_test AS h WHERE h.section_tipo = '${HOST}' AND EXISTS (` +
			`SELECT 1 FROM ${hop.join} WHERE ${hop.alias}.string->'${TEXT}' @> $1::text::jsonb)`,
		[JSON.stringify([{ value }])],
	)) as { section_id: number }[];
	const ids = rows
		.map((row) => Number(row.section_id))
		.filter((id) => HOSTS.includes(id))
		.sort();
	return { ids, acl: hop.acl };
}

describe.if(DB_READY)('search hop: configured targets the caller may read', () => {
	beforeAll(async () => {
		await ensureSituation(S);
	});
	afterAll(async () => {
		expect(await dropSituation(S)).toBe(0);
	});

	test('granted on REAL only: declaring REAL no longer reads the VIRTUAL twin', async () => {
		const scope = scopeFor(USER, [[REAL, TEXT]]);
		expect((await hostsMatching(scope, REAL, 'zzleak secret')).ids).toEqual([]);
		// non-degeneracy: the granted twin is still reached
		const visible = await hostsMatching(scope, REAL, 'zzleak visible');
		expect(visible.ids).toEqual([H_REAL]);
		expect(visible.ids).toHaveLength(1); // floor: the probe reaches rows at all
		expect(visible.acl).toContain(`section_tipo IN ('${REAL}')`);
		expect(visible.acl).not.toContain(VIRT);
	});

	test('granted on both twins: both reached, one IN list', async () => {
		const scope = scopeFor(USER, [
			[REAL, TEXT],
			[VIRT, TEXT],
		]);
		expect((await hostsMatching(scope, REAL, 'zzleak secret')).ids).toEqual([H_VIRT]);
		const { acl } = await hostsMatching(scope, REAL, 'zzleak visible');
		expect(acl).toMatch(
			new RegExp(`section_tipo IN \\('(${REAL}|${VIRT})', '(${REAL}|${VIRT})'\\)`),
		);
	});

	test('a locator outside the configured targets matches nothing, admins included (option A)', async () => {
		const admin: Principal = { userId: 900798, isGlobalAdmin: true, isDeveloper: false };
		const scope = scopeFor(admin, [
			[REAL, TEXT],
			[VIRT, TEXT],
			[OTHER, TEXT],
		]);
		expect((await hostsMatching(scope, REAL, 'zzleak stray')).ids).toEqual([]);
		// non-degeneracy: both configured targets are reached
		expect((await hostsMatching(scope, REAL, 'zzleak visible')).ids).toEqual([H_REAL]);
		expect((await hostsMatching(scope, REAL, 'zzleak secret')).ids).toEqual([H_VIRT]);
	});

	test('no readable target: the hop matches nothing', async () => {
		const scope = scopeFor(USER, []);
		const { ids, acl } = await hostsMatching(scope, REAL, 'zzleak visible');
		expect(ids).toEqual([]);
		expect(acl).toBe('FALSE');
	});

	test('a multi-section search through a self-targeting hop keeps EVERY section (targets per source)', async () => {
		// The client declares the step as section_tipo[0] (REAL); the search spans
		// REAL and VIRT. Resolving the hop's targets from REAL alone admitted REAL
		// only and dropped every VIRT record — for admins too.
		const admin: Principal = { userId: 900798, isGlobalAdmin: true, isDeveloper: false };
		const scope: SqlFrontierScope = {
			...scopeFor(admin, [
				[REAL, TEXT],
				[VIRT, TEXT],
			]),
			mainSectionTipos: [REAL, VIRT],
		};
		const chain = await buildJoinChain(
			[
				{ section_tipo: REAL, component_tipo: SELF_HOP },
				{ section_tipo: REAL, component_tipo: TEXT },
			],
			'm',
			scope,
		);
		const hop = chain.hops[0];
		if (hop === undefined) throw new Error('no hop');
		const reach = async (value: string) =>
			(
				(await sql.unsafe(
					`SELECT m.section_id FROM matrix_test AS m WHERE m.section_tipo IN ('${REAL}', '${VIRT}') AND EXISTS (` +
						`SELECT 1 FROM ${hop.join} WHERE ${hop.alias}.string->'${TEXT}' @> $1::text::jsonb)`,
					[JSON.stringify([{ value }])],
				)) as { section_id: number }[]
			)
				.map((row) => Number(row.section_id))
				.filter((id) => id === R2 || id === V2);
		expect(await reach('zzleak visible')).toEqual([R2]);
		expect(await reach('zzleak secret')).toEqual([V2]);
		expect(hop.acl).toContain(VIRT);
	});

	test('an internal search (no principal) is unchanged: every locator followed', async () => {
		const scope = scopeFor(undefined, []);
		const visible = await hostsMatching(scope, REAL, 'zzleak visible');
		expect(visible.acl).toBe('');
		expect(visible.ids).toEqual([H_REAL]);
		expect((await hostsMatching(scope, REAL, 'zzleak secret')).ids).toEqual([H_VIRT]);
		expect((await hostsMatching(scope, REAL, 'zzleak stray')).ids).toEqual([H_OTHER]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// T1-16 — a multi-hop RELATION leaf's from_component_tipo is keyed per section
// the last hop ADMITS (the sections its rows can belong to), never per the
// client's declared step section. The hop admits REAL and VIRT when the step
// component (RELF) is granted on both; the leaf's from_component_tipo
// (HIDDENREL) is a DIFFERENT component, granted on REAL only — so VIRT's
// HIDDENREL links must not answer the probe.
// ─────────────────────────────────────────────────────────────────────────────

/** A principal-bearing scope searching HOST (the root step's PORTAL granted) + `granted`. */
function leafScope(
	principal: Principal | undefined,
	granted: [string, string][],
): SqlFrontierScope {
	return {
		...scopeFor(principal, [[HOST, PORTAL], ...granted]),
		mainSectionTipos: [HOST],
	};
}

/** The relation leaf through PORTAL, the step declared as `declared`. */
const relationLeaf = (declared: string, q: Record<string, unknown>) => ({
	format: 'relation',
	q,
	path: [
		{ section_tipo: HOST, component_tipo: PORTAL },
		{ section_tipo: declared, component_tipo: RELF },
	],
});

/** The leaf HOSTS a filter keeps — conformed, planned and rendered the way the assembler does. */
async function leafHosts(
	scope: SqlFrontierScope,
	filter: Record<string, unknown>,
): Promise<number[]> {
	const conformed = await conformFilter(filter, 'h', 'matrix_test', scope);
	const planned = await planDeepFilters(conformed, ['matrix_test'], {});
	const params = new ParamsCollector();
	const where = renderConformedFilter(planned, params);
	const rows = (await sql.unsafe(
		`SELECT h.section_id FROM matrix_test AS h WHERE h.section_tipo = '${HOST}'` +
			(where === '' ? '' : ` AND (${where})`),
		params.toArray() as never[],
	)) as { section_id: number }[];
	return rows
		.map((row) => Number(row.section_id))
		.filter((id) => LEAF_HOSTS.includes(id))
		.sort();
}

const HIT = { section_tipo: REAL, section_id: R1 };
const MISS = { section_tipo: REAL, section_id: MISS_ID };
/** RELF on both twins (the hop admits both); HIDDENREL on REAL only. */
const HIDDEN_ON_VIRT: [string, string][] = [
	[REAL, RELF],
	[REAL, HIDDENREL],
	[REAL, SELF_HOP],
	[REAL, TEXT],
	[VIRT, RELF],
];

describe.if(DB_READY)(
	'relation leaf from_component_tipo keyed per ADMITTED section (T1-16)',
	() => {
		beforeAll(async () => {
			await ensureSituation(S);
		});
		afterAll(async () => {
			expect(await dropSituation(S)).toBe(0);
		});

		test('CONTROL: granted everything on both twins, the hit reaches both, the miss none', async () => {
			const scope = leafScope(USER, [
				...HIDDEN_ON_VIRT,
				[VIRT, HIDDENREL],
				[VIRT, SELF_HOP],
				[VIRT, TEXT],
			]);
			const explicit = { ...HIT, from_component_tipo: HIDDENREL };
			expect(await leafHosts(scope, { $and: [relationLeaf(REAL, explicit)] })).toEqual([
				H_R3,
				H_V3,
			]);
			expect(
				await leafHosts(scope, {
					$and: [relationLeaf(REAL, { ...MISS, from_component_tipo: HIDDENREL })],
				}),
			).toEqual([]);
		});

		test('explicit hidden from_component_tipo: VIRT rows refused, loudly', async () => {
			const scope = leafScope(USER, HIDDEN_ON_VIRT);
			await runWithRequestContext(
				{ session: null, requestId: 't1-16-loud', clientIp: '', principal: USER },
				async () => {
					const hit = await leafHosts(scope, {
						$and: [relationLeaf(REAL, { ...HIT, from_component_tipo: HIDDENREL })],
					});
					expect(hit).toEqual([H_R3]);
					expect(currentFrontierRefusals()).toContainEqual(
						expect.objectContaining({
							sectionTipo: VIRT,
							componentTipo: HIDDENREL,
							key: 'component',
						}),
					);
				},
			);
			expect(
				await leafHosts(scope, {
					$and: [relationLeaf(REAL, { ...MISS, from_component_tipo: HIDDENREL })],
				}),
			).toEqual([]);
		});

		test('absent from_component_tipo: "any" minus what VIRT hides', async () => {
			const scope = leafScope(USER, HIDDEN_ON_VIRT);
			expect(await leafHosts(scope, { $and: [relationLeaf(REAL, HIT)] })).toEqual([H_R3]);
			expect(await leafHosts(scope, { $and: [relationLeaf(REAL, MISS)] })).toEqual([]);
		});

		test('$not (forward shell): hit and miss answer alike on the VIRT host', async () => {
			const scope = leafScope(USER, HIDDEN_ON_VIRT);
			const negated = async (q: Record<string, unknown>) =>
				(
					await leafHosts(scope, {
						$and: [{ $not: [relationLeaf(REAL, { ...q, from_component_tipo: HIDDENREL })] }],
					})
				).includes(H_V3);
			expect(await negated(HIT)).toBe(await negated(MISS));
		});

		test('SPOOFED declaration (a non-target granting everything) keys nothing it cannot reach', async () => {
			// OTHER is not a configured target: the hop admits VIRT only (RELF there).
			const scope = leafScope(USER, [
				[OTHER, RELF],
				[OTHER, HIDDENREL],
				[VIRT, RELF],
			]);
			const probe = (q: Record<string, unknown>) =>
				leafHosts(scope, {
					$and: [relationLeaf(OTHER, { ...q, from_component_tipo: HIDDENREL })],
				});
			expect(await probe(HIT)).toEqual([]);
			expect(await probe(MISS)).toEqual([]);
		});

		test('internal search (no principal): unchanged, every locator answers', async () => {
			const scope = scopeFor(undefined, []);
			expect(
				await leafHosts(scope, {
					$and: [relationLeaf(REAL, { ...HIT, from_component_tipo: HIDDENREL })],
				}),
			).toEqual([H_R3, H_V3]);
		});
	},
);
