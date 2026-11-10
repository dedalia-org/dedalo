/**
 * IMPLICIT LABEL COLUMNS ANSWER TO THE CALLER'S GRANTS (T0-1 / S03, 2026-11-09).
 * Wire: WC-2026-11-09-export-frontier-fanout, WC-2026-11-09-implicit-children-frontier-predicate.
 *
 * A relation with NO request_config (the legacy "implicit" map: its ontology
 * `relations` name the target section and the label components) is shown to
 * each user through `filterAuthorizedRelated` (implicit.ts, PHP
 * filter_authorized_related): the edit form drops every label component the
 * user holds no grant on. The EXPORT read the same children through
 * `resolveOwnConfigMap` — principal-free and unfiltered — so a field hidden in
 * the form left the system in the export.
 *
 * Owner decision D1 (2026-11-09): an ungranted IMPLICIT child is DROPPED from
 * the export WITH A NOTICE (PHP parity — it is the relation's display as this
 * user is shown it, not a runtime crossing), never thrown. One predicate
 * decides it for both paths: frontier_scope.ts frontierAllowedComponents.
 *
 * WHAT THIS FILE PROVES, per family (value, grid_value fan-out, WC-008
 * compact, and an implicit relation NESTED under an explicit fan-out):
 *   - the scoped export SUCCEEDS, carries the granted label (L1) and NEITHER
 *     sentinel of the ungranted one (L2) — and the two sentinel runs are
 *     byte-identical;
 *   - the narrowing is LOUD: the opened grid's frontierRefusals names
 *     (L section, L2, component);
 *   - non-vacuity: the global admin exports L2 — differently per sentinel.
 * Plus the widget half of the ONE predicate: a non-admin's component_filter
 * implicit config now carries the project name (dd153.dd156, a globally
 * visible section) — the over-refusal frontier_class_native's census ledgered.
 *
 * THE SITUATION IS BUILT (`zzxl`, dropped in afterAll, residue 0):
 *   zzxl1  A  zzxl2 filter
 *             zzxl3 component_select S    (implicit: relations [zzxl10, zzxl12, zzxl13])
 *             zzxl4 component_portal Q    (implicit, same relations — WC-008 compact)
 *             zzxl5 component_autocomplete P (explicit → zzxl20 [zzxl21, zzxl22])
 *   zzxl10 L  zzxl11 filter · zzxl12 L1 (granted) · zzxl13 L2 (NOT granted)
 *   zzxl20 B  zzxl23 filter · zzxl21 label · zzxl22 component_select S2 (implicit → L)
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { buildImplicitComponentListConfig } from '../../src/core/relations/request_config/implicit.ts';
import type { FrontierRefusal } from '../../src/core/security/frontier_scope.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import { runWithRequestContext } from '../../src/core/security/request_context.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import type { ToolActionContext } from '../../src/core/tools/module.ts';
import { openExportGrid } from '../../src/diffusion/export/index.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import { exportFrontierIdentity, type FrontierGrant } from '../helpers/export_frontier_identity.ts';

const A = 'zzxl1';
const A_FILTER = 'zzxl2';
const S_SELECT = 'zzxl3';
const Q = 'zzxl4';
const P = 'zzxl5';
const L = 'zzxl10';
const L_FILTER = 'zzxl11';
const L1 = 'zzxl12';
const L2 = 'zzxl13';
const B = 'zzxl20';
const B_LABEL = 'zzxl21';
const S2 = 'zzxl22';
const B_FILTER = 'zzxl23';

const LANG = 'lg-eng';
const SENTINEL_ALPHA = 'zzxl alpha kestrel manuscript';
const SENTINEL_BRAVO = 'zzxl bravo obsidian reliquary';
const GRANTED_VALUE = 'zzxl granted label';
const B_VALUE = 'zzxl b label';

const identity = exportFrontierIdentity('export_leaf_label_grant', 933600);

const term = (value: string) => ({ [LANG]: value });
const text = (tipo: string, value: string) => ({ [tipo]: [{ id: 1, lang: LANG, value }] });
const section = (tipo: string, label: string) => ({
	tipo,
	parent: 'test1',
	model: 'section',
	term: term(label),
	relations: [{ tipo: 'test24' }],
});
const filter = (tipo: string, parent: string) => ({
	tipo,
	parent,
	model: 'component_filter',
	term: term(`${tipo} projects`),
});
const input = (tipo: string, parent: string) => ({
	tipo,
	parent,
	model: 'component_input_text',
	term: term(`${tipo} label`),
	is_translatable: true,
});
/** The IMPLICIT map: no properties, the relations name target section + labels. */
const implicitRelation = (tipo: string, parent: string, model: string, label: string) => ({
	tipo,
	parent,
	model,
	term: term(label),
	relations: [{ tipo: L }, { tipo: L1 }, { tipo: L2 }],
});

const S = situation({
	name: 'export implicit label grants',
	tld: 'zzxl',
	nodes: [
		section(A, 'zz label root'),
		filter(A_FILTER, A),
		implicitRelation(S_SELECT, A, 'component_select', 'zz label select'),
		implicitRelation(Q, A, 'component_portal', 'zz label compact'),
		{
			tipo: P,
			parent: A,
			model: 'component_autocomplete',
			term: term('zz label nested'),
			properties: {
				source: {
					request_config: [
						{
							sqo: { section_tipo: [{ value: [B], source: 'section' }] },
							show: {
								ddo_map: [B_LABEL, S2].map((tipo) => ({
									tipo,
									parent: 'self',
									section_tipo: 'self',
								})),
							},
						},
					],
				},
			},
		},
		section(L, 'zz label target'),
		filter(L_FILTER, L),
		input(L1, L),
		input(L2, L),
		section(B, 'zz label b'),
		filter(B_FILTER, B),
		input(B_LABEL, B),
		implicitRelation(S2, B, 'component_select', 'zz label nested select'),
	],
});

const locatorTo = (from: string, sectionTipo: string, sectionId: number) => ({
	id: 1,
	type: 'dd151',
	section_tipo: sectionTipo,
	section_id: sectionId,
	from_component_tipo: from,
});

async function writeRow(
	sectionTipo: string,
	sectionId: number,
	relation: Record<string, unknown>,
	strings: Record<string, unknown>,
): Promise<void> {
	await sql.unsafe('DELETE FROM matrix_test WHERE section_tipo = $1 AND section_id = $2', [
		sectionTipo,
		sectionId,
	]);
	await sql.unsafe(
		`INSERT INTO matrix_test (section_tipo, section_id, relation, string, data)
		 VALUES ($1, $2, $3::text::jsonb, $4::text::jsonb, $5::text::jsonb)`,
		[
			sectionTipo,
			sectionId,
			encodeForJsonb(relation),
			encodeForJsonb(strings),
			encodeForJsonb({ section_tipo: sectionTipo, section_id: sectionId }),
		],
	);
}

/** The ungranted label carries the sentinel; everything sits in MY project. */
async function writeSituation(sentinel: string): Promise<void> {
	const mine = (filterTipo: string) => ({
		[filterTipo]: [identity.filterLocator(filterTipo, identity.myProject)],
	});
	await writeRow(
		A,
		1,
		{
			...mine(A_FILTER),
			[S_SELECT]: [locatorTo(S_SELECT, L, 1)],
			[Q]: [locatorTo(Q, L, 1)],
			[P]: [locatorTo(P, B, 1)],
		},
		{},
	);
	await writeRow(B, 1, { ...mine(B_FILTER), [S2]: [locatorTo(S2, L, 1)] }, text(B_LABEL, B_VALUE));
	await writeRow(L, 1, mine(L_FILTER), { ...text(L1, GRANTED_VALUE), ...text(L2, sentinel) });
}

type Family = 'value' | 'fanout' | 'compact' | 'nested-value' | 'nested-fanout';

const leafOf = (family: Family): string =>
	family === 'compact' ? Q : family.startsWith('nested') ? P : S_SELECT;

/** The export answer + the frontier log the opened grid kept. */
interface ExportOnce {
	answer: string;
	refusals: readonly FrontierRefusal[];
	/** `section/component` pairs the manifest's `frontier_grants` would re-ask. */
	grants: readonly string[];
}

async function exportOnce(principal: Principal, family: Family): Promise<ExportOnce> {
	const options = {
		section_tipo: A,
		lang: LANG,
		data_format: family === 'value' || family === 'nested-value' ? 'value' : 'grid_value',
		breakdown: 'default',
		ar_ddo_to_export: [{ path: [{ section_tipo: A, component_tipo: leafOf(family) }] }],
		sqo: {
			section_tipo: [A],
			filter_by_locators: [{ section_tipo: A, section_id: 1 }],
			limit: 10,
			offset: 0,
		},
	};
	try {
		const opened = await openExportGrid(
			{
				principal,
				options: options as ToolActionContext['options'],
				applicationLang: LANG,
			},
			{},
		);
		const lines: unknown[] = [];
		for await (const line of opened.lines) lines.push(line);
		return {
			answer: `OK:${JSON.stringify(lines)}`,
			refusals: opened.frontierRefusals,
			grants: [...opened.frontierGrants.values()].map(
				(grant) => `${grant.section_tipo}/${grant.component_tipo}`,
			),
		};
	} catch (error) {
		return {
			answer: `REFUSED:${(error as { code?: string }).code ?? 'unknown'}`,
			refusals: [],
			grants: [],
		};
	}
}

const SCOPED_GRANTS: FrontierGrant[] = [
	{ sectionTipo: A, tipo: A, level: 2 },
	{ sectionTipo: A, tipo: S_SELECT, level: 2 },
	{ sectionTipo: A, tipo: Q, level: 2 },
	{ sectionTipo: A, tipo: P, level: 2 },
	{ sectionTipo: L, tipo: L1, level: 1 }, // L1 granted, L2 NOT
];

const ADMIN_GRANTS: FrontierGrant[] = S.nodes
	.filter((node) => node.model !== 'section')
	.map((node) => ({ sectionTipo: node.parent as string, tipo: node.tipo, level: 3 }))
	.concat(S.sectionTipos.map((tipo) => ({ sectionTipo: tipo, tipo, level: 3 })));

describe.if(DB_READY)('implicit label columns answer to the caller grants (T0-1 / S03)', () => {
	beforeAll(async () => {
		await ensureSituation(S);
		await identity.install(SCOPED_GRANTS, ADMIN_GRANTS);
	}, 120_000);

	afterAll(async () => {
		await identity.remove(true);
		expect(await dropSituation(S)).toBe(0);
	});

	for (const family of ['value', 'fanout', 'compact', 'nested-value', 'nested-fanout'] as const) {
		test(`${family}: the ungranted implicit label is DROPPED with a notice; the granted one exports`, async () => {
			const scoped: ExportOnce[] = [];
			const admin: string[] = [];
			for (const sentinel of [SENTINEL_ALPHA, SENTINEL_BRAVO]) {
				await writeSituation(sentinel);
				scoped.push(await exportOnce(identity.scoped, family));
				admin.push((await exportOnce(identity.admin, family)).answer);
			}
			const [adminAlpha, adminBravo] = admin as [string, string];
			// non-vacuity: the admin export carries the ungranted label
			expect(adminAlpha).toContain(SENTINEL_ALPHA);
			expect(adminBravo).toContain(SENTINEL_BRAVO);

			const [alpha, bravo] = scoped as [ExportOnce, ExportOnce];
			// D1: not a throw — the export completes with the granted label …
			expect(alpha.answer.startsWith('OK:'), alpha.answer).toBe(true);
			expect(alpha.answer).toContain(GRANTED_VALUE);
			// … without the ungranted one, identically for both sentinels …
			expect(alpha.answer).not.toContain('alpha');
			expect(bravo.answer).not.toContain('bravo');
			expect(bravo.answer).toBe(alpha.answer);
			// … and LOUD: the narrowing is in the export's frontier log.
			expect(
				alpha.refusals.some(
					(refusal) =>
						refusal.sectionTipo === L &&
						refusal.componentTipo === L2 &&
						refusal.key === 'component',
				),
				JSON.stringify(alpha.refusals),
			).toBe(true);
			// the re-check list (WC-2026-09-24 frontier_grants): the ALLOWED implicit
			// pair is recorded so a later revocation closes the finished export; the
			// refused one is not; a FLOORED explicit child (D3) never is — the strict
			// re-check would lock the owner out of their own export.
			expect(alpha.grants, JSON.stringify(alpha.grants)).toContain(`${L}/${L1}`);
			expect(alpha.grants).not.toContain(`${L}/${L2}`);
			expect(alpha.grants).not.toContain(`${B}/${B_LABEL}`);
			expect(alpha.grants).not.toContain(`${B}/${S2}`);
		});
	}

	test('the WIDGET half of the one predicate: a non-admin component_filter shows the project name', async () => {
		const config = await runWithRequestContext(
			{ principal: identity.scoped, session: null, requestId: 'zzxl-widget', clientIp: '' },
			() =>
				buildImplicitComponentListConfig(A_FILTER, {
					ownerTipo: A_FILTER,
					ownerSectionTipo: A,
					mode: 'list',
					ownerIsSection: false,
				}),
		);
		const tipos = (config[0]?.show?.ddo_map ?? []).map((ddo) => ddo.tipo);
		// dd153 is globally visible (frontier_scope.ts frontierSectionIsGloballyVisible):
		// the frontier key exempts it, so the widget no longer over-refuses it.
		expect(tipos).toEqual(['dd156']);
	});
});
