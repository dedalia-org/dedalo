/**
 * A MULTI-TARGET RELATION IS PICKABLE PER REAL-SECTION FAMILY (2026-11-11).
 * Wire: WC-2026-11-11-section-elements-target-groups.
 *
 * The fields picker (render_common.js render_components_list, shared by
 * tool_export and search) drilled a relation into `target_section_tipo[0]`
 * ONLY. tch199 points to every toponymy (es1, fr1, … — virtual siblings of
 * hierarchy20) AND to tchi1 (a real section with its own components): the
 * picker opened España and no tchi1 field could ever be exported.
 *
 * The picker now offers every target, grouped by REAL section. That grouping
 * rests on two server facts this file pins:
 *
 *   G1 get_section_elements_context stamps `target_section_groups` on a
 *      multi-target relation — virtual siblings in ONE family under their real
 *      section, a real target its own family, relation target order, members
 *      the principal may not read omitted (a picker hint, never a grant);
 *      a single-target relation carries no groups.
 *   G2 the export walk follows every locator BY COMPONENT TIPO whatever
 *      section the declared step names (resolver.ts resolveRecordAtoms), so
 *      ONE column picked through the family's first member exports the
 *      sibling's values too — and a target outside the family (no such tipo)
 *      contributes nothing. That is what makes one choice per family correct.
 *   G3 the other family's field, declared through its own section, exports.
 *
 * SITUATION (built, torn down): scratch TLD `zzmtf`.
 *   zzmtf1  A (root)    zzmtf2 portal P → [V1, V2, O]
 *   zzmtf10 R (real)    zzmtf11 term (input_text)
 *   zzmtf20 V1 → R      (virtual: relations [matrix_test, R])
 *   zzmtf30 V2 → R
 *   zzmtf40 O (real)    zzmtf41 name (input_text)
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
	buildSectionElementsContext,
	groupTargetSections,
} from '../../src/core/resolve/section_elements_context.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import type { ToolActionContext, ToolResponse } from '../../src/core/tools/module.ts';
import { toolExportGetExportGrid } from '../../tools/tool_export/server/tool_export.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import { exportFrontierIdentity, type FrontierGrant } from '../helpers/export_frontier_identity.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

const A = 'zzmtf1';
const P = 'zzmtf2';
const R = 'zzmtf10';
const R_TERM = 'zzmtf11';
const V1 = 'zzmtf20';
const V2 = 'zzmtf30';
const O = 'zzmtf40';
const O_NAME = 'zzmtf41';
/** One project component_filter per real section: the non-admin's record key. */
const A_FILTER = 'zzmtf3';
const R_FILTER = 'zzmtf12';
const O_FILTER = 'zzmtf42';
/** test24 — the matrix_test table node every scratch section names. */
const MATRIX_TEST = 'test24';

const LANG = 'lg-eng';
const VALUE_V1 = 'zzmtf alpha toponym';
const VALUE_V2 = 'zzmtf bravo toponym';
const VALUE_O = 'zzmtf charlie immovable';

registerSessionCleanup();

/** A scoped (non-admin) user + a global admin, own projects and profiles. */
const identity = exportFrontierIdentity('export_multi_target_family', 934500);
const mine = (filterTipo: string) => ({
	[filterTipo]: [identity.filterLocator(filterTipo, identity.myProject)],
});
const filter = (tipo: string, parent: string) => ({
	tipo,
	parent,
	model: 'component_filter',
	term: term(`${tipo} projects`),
});

const term = (value: string) => ({ [LANG]: value });
const text = (tipo: string, value: string) => ({ [tipo]: [{ id: 1, lang: LANG, value }] });
const locator = (sectionTipo: string, sectionId: number, id: number) => ({
	id,
	type: 'dd151',
	section_tipo: sectionTipo,
	section_id: sectionId,
	from_component_tipo: P,
});

const S = situation({
	name: 'export multi-target family',
	tld: 'zzmtf',
	nodes: [
		{ tipo: A, parent: 'test1', model: 'section', term: term('zz mt root') },
		filter(A_FILTER, A),
		{
			tipo: P,
			parent: A,
			model: 'component_portal',
			term: term('zz mt place'),
			properties: {
				source: {
					request_config: [
						{
							sqo: { section_tipo: [{ value: [V1, V2, O], source: 'section' }] },
							show: {
								ddo_map: [
									{ tipo: R_TERM, parent: 'self', section_tipo: 'self' },
									{ tipo: O_NAME, parent: 'self', section_tipo: 'self' },
								],
							},
						},
					],
				},
			},
		},
		{ tipo: R, parent: 'test1', model: 'section', term: term('zz mt thesaurus') },
		filter(R_FILTER, R),
		{
			tipo: R_TERM,
			parent: R,
			model: 'component_input_text',
			term: term('zz mt term'),
			is_translatable: true,
		},
		{
			tipo: V1,
			parent: 'test1',
			model: 'section',
			term: term('zz mt spain'),
			relations: [{ tipo: MATRIX_TEST }, { tipo: R }],
		},
		{
			tipo: V2,
			parent: 'test1',
			model: 'section',
			term: term('zz mt france'),
			relations: [{ tipo: MATRIX_TEST }, { tipo: R }],
		},
		{ tipo: O, parent: 'test1', model: 'section', term: term('zz mt immovables') },
		filter(O_FILTER, O),
		{
			tipo: O_NAME,
			parent: O,
			model: 'component_input_text',
			term: term('zz mt name'),
			is_translatable: true,
		},
	],
	records: [
		{
			section_tipo: A,
			section_id: 1,
			columns: {
				relation: {
					...mine(A_FILTER),
					[P]: [locator(V1, 1, 1), locator(V2, 1, 2), locator(O, 1, 3)],
				},
			},
		},
		{
			section_tipo: V1,
			section_id: 1,
			columns: { relation: mine(R_FILTER), string: text(R_TERM, VALUE_V1) },
		},
		{
			section_tipo: V2,
			section_id: 1,
			columns: { relation: mine(R_FILTER), string: text(R_TERM, VALUE_V2) },
		},
		{
			section_tipo: O,
			section_id: 1,
			columns: { relation: mine(O_FILTER), string: text(O_NAME, VALUE_O) },
		},
	],
});

const ADMIN: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };
/** A logged user with no profile: reads nothing. */
const NOBODY: Principal = { userId: 999_999_001, isGlobalAdmin: false, isDeveloper: false };

const portalEntry = async (principal: Principal) => {
	const contexts = await buildSectionElementsContext(principal, {
		ar_section_tipo: A,
		ar_components_exclude: ['component_password'],
	});
	return contexts.find((entry) => entry.tipo === P) as Record<string, unknown> | undefined;
};

const exportOf = async (
	path: { section_tipo: string; component_tipo: string }[],
	principal: Principal = ADMIN,
): Promise<string> => {
	const options = {
		section_tipo: A,
		lang: LANG,
		data_format: 'grid_value',
		breakdown: 'default',
		ar_ddo_to_export: [{ path }],
		sqo: {
			section_tipo: [A],
			filter_by_locators: [{ section_tipo: A, section_id: 1 }],
			limit: 10,
			offset: 0,
		},
	};
	const context = {
		principal,
		userId: principal.userId,
		options,
		background: false,
	} as unknown as ToolActionContext;
	try {
		const response: ToolResponse = await toolExportGetExportGrid(context);
		return `OK:${JSON.stringify(response.data)}`;
	} catch (error) {
		return `REFUSED:${(error as { code?: string }).code ?? 'unknown'}`;
	}
};

/**
 * The scoped profile: every section, the portal, and each target section's
 * OWN component — grants are per (section, component), so a virtual sibling
 * is granted the real section's component under its own tipo (es1/hierarchy25).
 */
const SCOPED_GRANTS: FrontierGrant[] = [
	{ sectionTipo: A, tipo: A, level: 2 },
	{ sectionTipo: A, tipo: P, level: 2 },
	{ sectionTipo: V1, tipo: V1, level: 1 },
	{ sectionTipo: V1, tipo: R_TERM, level: 1 },
	{ sectionTipo: V2, tipo: V2, level: 1 },
	{ sectionTipo: V2, tipo: R_TERM, level: 1 },
	{ sectionTipo: O, tipo: O, level: 1 },
	{ sectionTipo: O, tipo: O_NAME, level: 1 },
];
const ADMIN_GRANTS: FrontierGrant[] = SCOPED_GRANTS.map((grant) => ({ ...grant, level: 3 }));

describe.skipIf(!DB_READY)('multi-target relation: one picker family per real section', () => {
	beforeAll(async () => {
		await ensureSituation(S);
		await identity.install(SCOPED_GRANTS, ADMIN_GRANTS);
	}, 120_000);
	afterAll(async () => {
		await identity.remove(true);
		expect(await dropSituation(S)).toBe(0);
	});

	test('G1 the portal context groups its targets by real section, in target order', async () => {
		const entry = await portalEntry(ADMIN);
		expect(entry).toBeDefined();
		expect(entry?.target_section_tipo).toEqual([V1, V2, O]);
		const groups = entry?.target_section_groups as {
			tipo: string;
			label: string | null;
			members: { tipo: string; label: string | null }[];
		}[];
		expect(groups.map((group) => [group.tipo, group.members.map((member) => member.tipo)])).toEqual(
			[
				[R, [V1, V2]],
				[O, [O]],
			],
		);
		expect(groups[0]?.label).toBe('zz mt thesaurus');
		expect(groups[0]?.members.map((member) => member.label)).toEqual([
			'zz mt spain',
			'zz mt france',
		]);
	});

	test('G1 a target the principal cannot read is not offered', async () => {
		// non-vacuous: the same call for the admin offers every target
		// the floor: the admin's census of the same targets is NOT empty (both
		// families, every member), so the empty answer below is the grant, not a
		// census that read nothing
		const adminGroups = await groupTargetSections(ADMIN, [V1, V2, O]);
		expect(adminGroups.flatMap((group) => group.members).length).toBeGreaterThan(2);
		expect(adminGroups.length).toBe(2);
		expect(await groupTargetSections(NOBODY, [V1, V2, O])).toEqual([]);
	});

	test('G1 duplicate targets are offered once', async () => {
		const groups = await groupTargetSections(ADMIN, [V1, V1, V2]);
		expect(groups.map((group) => group.members.map((member) => member.tipo))).toEqual([[V1, V2]]);
	});

	test('G1 a single-target relation carries no groups', async () => {
		const contexts = await buildSectionElementsContext(ADMIN, { ar_section_tipo: A });
		for (const entry of contexts) {
			const targets = entry.target_section_tipo;
			if (Array.isArray(targets) && targets.length === 1) {
				expect(entry.target_section_groups).toBeUndefined();
			}
		}
	});

	test('G2 a field picked through the family first member exports every sibling', async () => {
		const answer = await exportOf([
			{ section_tipo: A, component_tipo: P },
			{ section_tipo: V1, component_tipo: R_TERM },
		]);
		expect(answer).toContain(VALUE_V1);
		expect(answer).toContain(VALUE_V2);
		// the other family has no such component: it contributes nothing
		expect(answer).not.toContain(VALUE_O);
	});

	test('G3 the other family field, declared through its own section, exports', async () => {
		const answer = await exportOf([
			{ section_tipo: A, component_tipo: P },
			{ section_tipo: O, component_tipo: O_NAME },
		]);
		expect(answer).toContain(VALUE_O);
		expect(answer).not.toContain(VALUE_V1);
		expect(answer).not.toContain(VALUE_V2);
	});

	test('G4 a NON-ADMIN exports the family column across a mixed relation', async () => {
		// The family column crosses the O locator too; O holds no R_TERM, so it
		// is not a crossing of R_TERM — a scoped caller has no `O/R_TERM` grant
		// (none can exist) and the frontier must not refuse the whole export.
		const answer = await exportOf(
			[
				{ section_tipo: A, component_tipo: P },
				{ section_tipo: V1, component_tipo: R_TERM },
			],
			identity.scoped,
		);
		expect(answer.startsWith('OK:')).toBe(true);
		expect(answer).toContain(VALUE_V1);
		expect(answer).toContain(VALUE_V2);
		expect(answer).not.toContain(VALUE_O);
	});

	test('G4 a NON-ADMIN exports the other family column across the same relation', async () => {
		const answer = await exportOf(
			[
				{ section_tipo: A, component_tipo: P },
				{ section_tipo: O, component_tipo: O_NAME },
			],
			identity.scoped,
		);
		expect(answer.startsWith('OK:')).toBe(true);
		expect(answer).toContain(VALUE_O);
		expect(answer).not.toContain(VALUE_V1);
	});

	test('G5 an in-family member WITHOUT the component grant still refuses (fail closed)', async () => {
		// V2 carries R_TERM, so crossing it IS a read of R_TERM: the missing
		// grant keeps the export's existing refusal — the family skip must not
		// turn a denied read into a silent hole.
		await identity.setScopedGrants(
			SCOPED_GRANTS.filter((grant) => !(grant.sectionTipo === V2 && grant.tipo === R_TERM)),
		);
		try {
			const answer = await exportOf(
				[
					{ section_tipo: A, component_tipo: P },
					{ section_tipo: V1, component_tipo: R_TERM },
				],
				identity.scoped,
			);
			expect(answer.startsWith('REFUSED:')).toBe(true);
			expect(answer).not.toContain(VALUE_V2);
		} finally {
			await identity.setScopedGrants(SCOPED_GRANTS);
		}
	});
});
