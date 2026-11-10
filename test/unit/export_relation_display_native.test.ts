/**
 * A RELATION COLUMN EXPORTS EXACTLY WHAT THE USER IS SHOWN FOR IT (owner
 * decision D4, 2026-11-09). Wire: WC-2026-11-09-export-relation-display.
 *
 * THE BUG (live). A restricted user opens a record whose portal lists rows of
 * a section OUTSIDE their projects (grant 0 on that section): the section read
 * embeds the rows' labels — a related component shows its targets' display.
 * tool_export of that same plain column THREW
 * `perm.export_column_out_of_scope`: the export walk applied the RECORD key to
 * every target the column displays (T0-1), so the export refused what the
 * screen already shows.
 *
 * THE LAW (frontier_scope.ts D4): a plain relation column's DISPLAY — what the
 * host record's section read embeds for it, for this principal — is not a
 * crossing for the record key. The display is the READ'S OWN ANSWER
 * (security/host_component_read.ts hostColumnDisplay: the host-component
 * get_data's admission + emission), never a second notion of it. Everything
 * beyond it keeps the full law: a declared path INTO the target, the parents
 * chain, the media walk.
 *
 * WHAT THIS FILE PROVES (persona: host read + relation read, target records
 * OUT of projects scope, grant 0 on the target sections):
 *   (a) the plain column exports, in every shape that renders the display
 *       (value, grid_value fan-out, WC-008 compact, break-down rows/columns),
 *       and its exported values EQUAL the values the section read embeds for
 *       that column — no hidden field, no record beyond the display;
 *   (b) a declared path INTO the target (a target field outside the display,
 *       and even one inside it) still THROWS by its column;
 *   (c) the parents chain checked still refuses an out-of-scope ancestor;
 *   (d) the global admin exports the same values (control);
 *   (e) a column the read does not display (grant 0 on it) has no display:
 *       Gate B refuses it before any walk (the read's refusal, matched).
 *
 * Plus the two halves of the display predicate, each the ONLY guard of its case:
 *   - a record the read DISPLAYS, read for a component it does NOT display (a
 *     host section that injects a NARROWER child set than the portal's own
 *     config) → refused by the column;
 *   - a record the read does NOT expand, in a section whose components it
 *     displays elsewhere (a nested list cell shows its FIRST target only) →
 *     refused by the column.
 *
 * THE SITUATION IS BUILT (`zzed`, dropped in afterAll, residue 0):
 *   zzed1  H (host)  zzed2 filter · zzed3 autocomplete REL_A → T [T_LABEL, T_REL]
 *                    zzed4 portal REL_P → T [T_LABEL, T_REL]   (WC-008 compact)
 *   zzed10 T         zzed11 filter · zzed12 T_LABEL · zzed13 T_HIDDEN (no config
 *                    the read uses names it) · zzed14 portal T_REL → U [U_LABEL]
 *                    (a nested LIST cell: the read shows its first target)
 *                    zzed15 relation_parent · zzed16 section_map (term T_LABEL)
 *   zzed20 U         zzed21 filter · zzed22 U_LABEL
 *   zzed30 HI        zzed31 filter · zzed32 autocomplete REL_I and zzed33 portal
 *                    REL_IP (WC-008 compact) → T, own config [T_LABEL, T_HIDDEN];
 *                    HI's map injects [REL_I, REL_IP] with [T_LABEL] under each
 * h#1 and hi#1 sit in MY project; every T and U record in the OTHER one.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { sql } from '../../src/core/db/postgres.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import { isRecordInScope } from '../../src/core/security/record_scope.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import type { ToolActionContext, ToolResponse } from '../../src/core/tools/module.ts';
import { clearTermCache } from '../../src/core/ts_object/term_resolver.ts';
import { openExportGrid } from '../../src/diffusion/export/index.ts';
import { toolExportGetExportGrid } from '../../tools/tool_export/server/tool_export.ts';
import { countActivityRows, sweepActivityRows } from '../helpers/activity_rows.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import {
	clearFrontierIdentityCaches,
	exportFrontierIdentity,
	type FrontierGrant,
} from '../helpers/export_frontier_identity.ts';
import {
	type HostReadItem,
	hostColumnDisplayedValues,
	hostSectionReadItems,
} from '../helpers/host_section_read.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

registerSessionCleanup();

const H = 'zzed1';
const H_FILTER = 'zzed2';
const REL_A = 'zzed3';
const REL_P = 'zzed4';
const REL_S = 'zzed5';
const REL_F = 'zzed6';
const REL_FP = 'zzed7';
const T = 'zzed10';
const T_FILTER = 'zzed11';
const T_LABEL = 'zzed12';
const T_HIDDEN = 'zzed13';
const T_REL = 'zzed14';
const T_PARENT = 'zzed15';
const T_MAP = 'zzed16';
const T_SELF = 'zzed17';
const T_FREL = 'zzed18';
const T_DF = 'zzed19';
const U = 'zzed20';
const U_FILTER = 'zzed21';
const U_LABEL = 'zzed22';
const HI = 'zzed30';
const HI_FILTER = 'zzed31';
const REL_I = 'zzed32';
const REL_IP = 'zzed33';
/** Injected columns whose OWN config reaches the hidden field through an ALIAS. */
const REL_IA = 'zzed34';
const REL_IAP = 'zzed35';
/** component_alias of T_HIDDEN: stores nothing under its own tipo (WC-020). */
const T_ALIAS = 'zzed41';

const LANG = 'lg-eng';
const REFUSAL = 'perm.export_column_out_of_scope';

const VALUE = {
	t1: 'zzed target one',
	t2: 'zzed target parent',
	u1: 'zzed deep one',
	u2: 'zzed deep two',
	hidden: 'zzed hidden kestrel sentinel',
	t3hidden: 'zzed three hidden',
	t4hidden: 'zzed four hidden',
};

const identity = exportFrontierIdentity('export_relation_display', 933700);

const term = (value: string) => ({ [LANG]: value });
const text = (tipo: string, value: string) => ({ [tipo]: [{ id: 1, lang: LANG, value }] });

/** An explicit request_config: target section + 'self'-parented child ddos. */
const requestConfig = (targetSection: string, ddoTipos: string[]) => ({
	source: {
		request_config: [
			{
				sqo: { section_tipo: [{ value: [targetSection], source: 'section' }] },
				show: {
					ddo_map: ddoTipos.map((tipo) => ({ tipo, parent: 'self', section_tipo: 'self' })),
				},
			},
		],
	},
});

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
const input = (tipo: string, parent: string, label: string) => ({
	tipo,
	parent,
	model: 'component_input_text',
	term: term(label),
	is_translatable: true,
});

/** A HI column whose OWN config is wider ([T_LABEL, T_HIDDEN]) than what HI injects. */
const injectedColumn = (
	tipo: string,
	model: string,
	label: string,
	order: number,
	children: string[] = [T_LABEL, T_HIDDEN],
) => ({
	tipo,
	parent: HI,
	model,
	term: term(label),
	order_number: order,
	properties: {
		source: {
			request_config: [
				{
					sqo: { section_tipo: [{ value: [T], source: 'section' }] },
					show: {
						ddo_map: children.map((child) => ({
							tipo: child,
							parent: 'self',
							section_tipo: T,
						})),
					},
				},
			],
		},
	},
});

const S = situation({
	name: 'export relation display',
	tld: 'zzed',
	nodes: [
		section(H, 'zz ed host'),
		filter(H_FILTER, H),
		{
			tipo: REL_A,
			parent: H,
			model: 'component_autocomplete',
			term: term('zz ed main'),
			properties: requestConfig(T, [T_LABEL, T_REL]),
		},
		{
			tipo: REL_P,
			parent: H,
			model: 'component_portal',
			term: term('zz ed compact'),
			properties: requestConfig(T, [T_LABEL, T_REL]),
		},
		{
			tipo: REL_S,
			parent: H,
			model: 'component_autocomplete',
			term: term('zz ed self'),
			properties: requestConfig(T, [T_LABEL, T_SELF]),
		},
		{
			tipo: REL_F,
			parent: H,
			model: 'component_autocomplete',
			term: term('zz ed framed'),
			properties: requestConfig(T, [T_LABEL, T_FREL]),
		},
		{
			tipo: REL_FP,
			parent: H,
			model: 'component_portal',
			term: term('zz ed framed compact'),
			properties: requestConfig(T, [T_LABEL, T_FREL]),
		},
		section(T, 'zz ed target'),
		filter(T_FILTER, T),
		input(T_LABEL, T, 'zz ed label'),
		input(T_HIDDEN, T, 'zz ed hidden'),
		{
			tipo: T_REL,
			parent: T,
			model: 'component_portal',
			term: term('zz ed deep'),
			properties: requestConfig(U, [U_LABEL]),
		},
		{
			// self-referencing: T → T showing only the hidden field (the
			// "displayed in one position, reached in another" probe)
			tipo: T_SELF,
			parent: T,
			model: 'component_portal',
			term: term('zz ed self deep'),
			properties: requestConfig(T, [T_HIDDEN]),
		},
		{
			tipo: T_FREL,
			parent: T,
			model: 'component_portal',
			term: term('zz ed framed deep'),
			properties: requestConfig(U, [U_LABEL, T_DF]),
		},
		{
			tipo: T_DF,
			parent: T_FREL,
			model: 'component_dataframe',
			order_number: 2,
			term: term('zz ed frame'),
			properties: requestConfig(U, [U_LABEL]),
		},
		{ tipo: T_PARENT, parent: T, model: 'component_relation_parent', term: term('zz ed parent') },
		{
			tipo: T_MAP,
			parent: T,
			model: 'section_map',
			term: term('zz ed map'),
			properties: { thesaurus: { term: T_LABEL, parent: T_PARENT } },
		},
		section(U, 'zz ed deep target'),
		filter(U_FILTER, U),
		input(U_LABEL, U, 'zz ed deep label'),
		{
			...section(HI, 'zz ed injecting host'),
			properties: {
				source: {
					request_config: [
						{
							sqo: { section_tipo: [{ source: 'self' }] },
							show: {
								ddo_map: [
									{ tipo: REL_I, parent: 'self', section_tipo: 'self' },
									{ tipo: T_LABEL, parent: REL_I, section_tipo: T },
									{ tipo: REL_IP, parent: 'self', section_tipo: 'self' },
									{ tipo: T_LABEL, parent: REL_IP, section_tipo: T },
									{ tipo: REL_IA, parent: 'self', section_tipo: 'self' },
									{ tipo: T_LABEL, parent: REL_IA, section_tipo: T },
									{ tipo: REL_IAP, parent: 'self', section_tipo: 'self' },
									{ tipo: T_LABEL, parent: REL_IAP, section_tipo: T },
								],
							},
						},
					],
				},
			},
		},
		filter(HI_FILTER, HI),
		injectedColumn(REL_I, 'component_autocomplete', 'zz ed injected', 1),
		injectedColumn(REL_IP, 'component_portal', 'zz ed injected compact', 2),
		injectedColumn(REL_IA, 'component_autocomplete', 'zz ed injected alias', 3, [T_LABEL, T_ALIAS]),
		injectedColumn(REL_IAP, 'component_portal', 'zz ed injected alias compact', 4, [
			T_LABEL,
			T_ALIAS,
		]),
		{
			tipo: T_ALIAS,
			parent: T,
			model: 'component_alias',
			term: term('zz ed alias'),
			properties: { alias_of: T_HIDDEN },
		},
	],
});

const relationLocator = (from: string, sectionTipo: string, sectionId: number, type = 'dd151') => ({
	id: 1,
	type,
	section_tipo: sectionTipo,
	section_id: sectionId,
	from_component_tipo: from,
});

/** Write one record (raw, into the disposable matrix_test) in `project`. */
async function writeRecord(
	sectionTipo: string,
	sectionId: number,
	filterTipo: string,
	project: number,
	string: Record<string, unknown>,
	relation: Record<string, unknown> = {},
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
			encodeForJsonb({ [filterTipo]: [identity.filterLocator(filterTipo, project)], ...relation }),
			encodeForJsonb(string),
			encodeForJsonb({ section_tipo: sectionTipo, section_id: sectionId }),
		],
	);
	clearTermCache(); // a raw write skips the engine's term-memo invalidation
}

/** How one test bends the base records (every flag off = the base situation). */
interface Variant {
	/** t#1's parent is t#2 — and the column lists t#2 too, so it is DISPLAYED. */
	linkParent?: boolean;
	/** t#1's displayed label is EMPTY. */
	emptyLabel?: boolean;
	/** t#1's nested list cell holds a SECOND target the read does not expand. */
	secondDeep?: boolean;
}

/**
 * The situation's records: h#1 and hi#1 mine; t#1, t#2, u#1, u#2 in the OTHER
 * project. Base: REL_A / REL_P / REL_I / REL_IP → [t#1]; t#1.T_REL → [u#1].
 */
async function writeRecords(variant: Variant = {}): Promise<void> {
	const targets = (from: string) =>
		variant.linkParent === true
			? [relationLocator(from, T, 1), { ...relationLocator(from, T, 2), id: 2 }]
			: [relationLocator(from, T, 1)];
	await writeRecord(
		H,
		1,
		H_FILTER,
		identity.myProject,
		{},
		{
			[REL_A]: targets(REL_A),
			[REL_P]: targets(REL_P),
		},
	);
	await writeRecord(
		HI,
		1,
		HI_FILTER,
		identity.myProject,
		{},
		{
			[REL_I]: [relationLocator(REL_I, T, 1)],
			[REL_IP]: [relationLocator(REL_IP, T, 1)],
			[REL_IA]: [relationLocator(REL_IA, T, 1)],
			[REL_IAP]: [relationLocator(REL_IAP, T, 1)],
		},
	);
	await writeRecord(
		T,
		1,
		T_FILTER,
		identity.otherProject,
		{
			...(variant.emptyLabel === true ? {} : text(T_LABEL, VALUE.t1)),
			...text(T_HIDDEN, VALUE.hidden),
		},
		{
			[T_REL]:
				variant.secondDeep === true
					? [relationLocator(T_REL, U, 1), { ...relationLocator(T_REL, U, 2), id: 2 }]
					: [relationLocator(T_REL, U, 1)],
			...(variant.linkParent === true
				? { [T_PARENT]: [relationLocator(T_PARENT, T, 2, 'dd47')] }
				: {}),
		},
	);
	await writeRecord(T, 2, T_FILTER, identity.otherProject, text(T_LABEL, VALUE.t2));
	await writeRecord(U, 1, U_FILTER, identity.otherProject, text(U_LABEL, VALUE.u1));
	await writeRecord(U, 2, U_FILTER, identity.otherProject, text(U_LABEL, VALUE.u2));
}

/** h#1 as the base writes it, plus `extra` relation columns. */
async function writeHost(extra: Record<string, unknown>): Promise<void> {
	await writeRecord(
		H,
		1,
		H_FILTER,
		identity.myProject,
		{},
		{
			[REL_A]: [relationLocator(REL_A, T, 1)],
			[REL_P]: [relationLocator(REL_P, T, 1)],
			...extra,
		},
	);
}

/**
 * "DISPLAYED IN ONE POSITION, REACHED IN ANOTHER" (REL_S → T [T_LABEL, T_SELF],
 * T_SELF → T [T_HIDDEN]): h#1.REL_S → [t#1, t#2]; t#1.T_SELF → [t#3];
 * t#2.T_SELF → [t#4] (+ t#1 SECOND when `leak`). The read shows t#1 with its
 * LABEL (top position) and T_HIDDEN only at t#3 / t#4 (each nested list
 * cell's first target) — never t#1's hidden field. With `leak`, the export
 * walk reaches t#1 again under t#2.T_SELF and would read T_HIDDEN there.
 */
async function writeSelfRecords(leak: boolean): Promise<void> {
	await writeRecords();
	await writeHost({
		[REL_S]: [relationLocator(REL_S, T, 1), { ...relationLocator(REL_S, T, 2), id: 2 }],
	});
	await writeRecord(
		T,
		1,
		T_FILTER,
		identity.otherProject,
		{ ...text(T_LABEL, VALUE.t1), ...text(T_HIDDEN, VALUE.hidden) },
		{ [T_SELF]: [relationLocator(T_SELF, T, 3)] },
	);
	await writeRecord(T, 2, T_FILTER, identity.otherProject, text(T_LABEL, VALUE.t2), {
		[T_SELF]: leak
			? [relationLocator(T_SELF, T, 4), { ...relationLocator(T_SELF, T, 1), id: 2 }]
			: [relationLocator(T_SELF, T, 4)],
	});
	await writeRecord(T, 3, T_FILTER, identity.otherProject, text(T_HIDDEN, VALUE.t3hidden));
	await writeRecord(T, 4, T_FILTER, identity.otherProject, text(T_HIDDEN, VALUE.t4hidden));
}

/**
 * A DATAFRAME SLOT ON A DISPLAY-ADMITTED OWNER (REL_F → T [T_LABEL, T_FREL],
 * T_FREL → U [U_LABEL, T_DF]): h#1.REL_F → [t#1]; t#1.T_FREL → [u#1]; the
 * frame T_DF lives on t#1 (the owner), paired to that locator, → u#2.
 */
async function writeFramedRecords(hiddenSlot = false): Promise<void> {
	await writeRecords();
	const framedTargets = (from: string) =>
		hiddenSlot
			? [relationLocator(from, T, 1), { ...relationLocator(from, T, 2), id: 2 }]
			: [relationLocator(from, T, 1)];
	await writeHost({ [REL_F]: framedTargets(REL_F), [REL_FP]: framedTargets(REL_FP) });
	await writeRecord(
		T,
		1,
		T_FILTER,
		identity.otherProject,
		{ ...text(T_LABEL, VALUE.t1), ...text(T_HIDDEN, VALUE.hidden) },
		{
			[T_FREL]: hiddenSlot
				? [relationLocator(T_FREL, U, 1), { ...relationLocator(T_FREL, U, 2), id: 2 }]
				: [relationLocator(T_FREL, U, 1)],
			[T_DF]: [
				{
					id: 1,
					type: 'dd490',
					id_key: hiddenSlot ? 2 : 1,
					section_tipo: U,
					section_id: hiddenSlot ? 1 : 2,
					from_component_tipo: T_DF,
					main_component_tipo: T_FREL,
				},
			],
		},
	);
	if (hiddenSlot) {
		await writeRecord(T, 2, T_FILTER, identity.otherProject, text(T_LABEL, VALUE.t2), {
			[T_FREL]: [relationLocator(T_FREL, U, 2)],
		});
	}
}

/** The persona: the host section + both relation columns. NOTHING on T or U. */
const SCOPED_GRANTS: FrontierGrant[] = [
	{ sectionTipo: H, tipo: H, level: 2 },
	{ sectionTipo: H, tipo: REL_A, level: 2 },
	{ sectionTipo: H, tipo: REL_P, level: 2 },
	{ sectionTipo: H, tipo: REL_S, level: 2 },
	{ sectionTipo: H, tipo: REL_F, level: 2 },
	{ sectionTipo: H, tipo: REL_FP, level: 2 },
	{ sectionTipo: HI, tipo: HI, level: 2 },
	{ sectionTipo: HI, tipo: REL_I, level: 2 },
	{ sectionTipo: HI, tipo: REL_IP, level: 2 },
	{ sectionTipo: HI, tipo: REL_IA, level: 2 },
	{ sectionTipo: HI, tipo: REL_IAP, level: 2 },
];

/** (b): Gate B must admit a path into T, so the target fields are granted — the WALK refuses. */
const PATH_GRANTS: FrontierGrant[] = [
	...SCOPED_GRANTS,
	{ sectionTipo: T, tipo: T_HIDDEN, level: 1 },
	{ sectionTipo: T, tipo: T_LABEL, level: 1 },
];

const ADMIN_GRANTS: FrontierGrant[] = [
	...[H, T, U, HI].map((tipo) => ({ sectionTipo: tipo, tipo, level: 3 })),
	...[H_FILTER, REL_A, REL_P, REL_S, REL_F, REL_FP].map((tipo) => ({
		sectionTipo: H,
		tipo,
		level: 3,
	})),
	...[HI_FILTER, REL_I, REL_IP, REL_IA, REL_IAP].map((tipo) => ({
		sectionTipo: HI,
		tipo,
		level: 3,
	})),
	...[T_FILTER, T_LABEL, T_HIDDEN, T_REL, T_PARENT, T_SELF, T_FREL, T_DF, T_ALIAS].map((tipo) => ({
		sectionTipo: T,
		tipo,
		level: 3,
	})),
	...[U_FILTER, U_LABEL].map((tipo) => ({ sectionTipo: U, tipo, level: 3 })),
];

// ── the section read (what the user is SHOWN) ────────────────────────────────

type Item = HostReadItem;

/** The edit section read of `host`#1, as the principal (the screen the bug started from). */
const sectionReadItems = (principal: Principal, host = H): Promise<Item[]> =>
	hostSectionReadItems(principal, host, 1, LANG, 'export-relation-display');

const displayedValues = (items: Item[], column: string, host = H): string[] =>
	hostColumnDisplayedValues(items, column, host, 1);

// ── the export ───────────────────────────────────────────────────────────────

type Shape = 'value' | 'fanout' | 'compact' | 'rows' | 'columns';

const contextOf = (options: Record<string, unknown>, principal: Principal): ToolActionContext =>
	({ principal, userId: principal.userId, options, background: false }) as ToolActionContext;

interface ExportCall {
	shape: Shape;
	path?: { section_tipo: string; component_tipo: string }[];
	withParents?: boolean;
	host?: string;
}

/** The plain column a shape exports (WC-008 compact = the portal). */
const columnOf = (shape: Shape): string => (shape === 'compact' ? REL_P : REL_A);
/** Its label, as perm.export_column_out_of_scope names it. */
const columnLabelOf = (shape: Shape): string =>
	shape === 'compact' ? 'zz ed compact' : 'zz ed main';

function exportOptions(call: ExportCall): Record<string, unknown> {
	const host = call.host ?? H;
	const path = call.path ?? [{ section_tipo: host, component_tipo: columnOf(call.shape) }];
	return {
		section_tipo: host,
		lang: LANG,
		data_format: call.shape === 'value' ? 'value' : 'grid_value',
		breakdown: call.shape === 'rows' || call.shape === 'columns' ? call.shape : 'default',
		fill_the_gaps: true,
		ar_ddo_to_export: [
			{ path, ...(call.withParents === true ? { value_with_parents: true } : {}) },
		],
		sqo: {
			section_tipo: [host],
			filter_by_locators: [{ section_tipo: host, section_id: 1 }],
			limit: 10,
			offset: 0,
		},
	};
}

async function exportAnswer(principal: Principal, call: ExportCall): Promise<string> {
	clearFrontierIdentityCaches();
	const options = exportOptions(call);
	try {
		const response: ToolResponse = await toolExportGetExportGrid(contextOf(options, principal));
		return `OK:${JSON.stringify(response.data)}`;
	} catch (error) {
		const code = (error as { code?: string }).code ?? 'unknown';
		const details = (error as { details?: unknown }).details;
		return `REFUSED:${code}:${JSON.stringify(details ?? null)}`;
	}
}

/**
 * The SAME export as the tool_export JOB opens it (export_job.ts): the grid
 * producer with `captureMedia: true` + `selectionAdmission: 'queue'` — every
 * real export captures media for the ZIP, so a display carve-out that is off
 * for capturing runs is off for every export the user can start. Answered in
 * exportAnswer's shape (`OK:{rows:[{c}]}`), so exportedValues reads both.
 */
async function jobAnswer(principal: Principal, call: ExportCall): Promise<string> {
	clearFrontierIdentityCaches();
	try {
		const opened = await openExportGrid(
			{ principal, options: exportOptions(call) as never, applicationLang: LANG },
			{ captureMedia: true, selectionAdmission: 'queue' },
		);
		const rows: { c?: unknown }[] = [];
		for await (const line of opened.lines) if (line.t === 'row') rows.push({ c: line.c });
		return `OK:${JSON.stringify({ rows })}`;
	} catch (error) {
		const code = (error as { code?: string }).code ?? 'unknown';
		const details = (error as { details?: unknown }).details;
		return `REFUSED:${code}:${JSON.stringify(details ?? null)}`;
	}
}

/**
 * The answer's DATA cells (the rows' `c` maps — never the column labels), each
 * split into its atomic values on the export's joins (' | ' records, ', '
 * fields).
 */
function exportedValues(answer: string): string[] {
	expect(answer.startsWith('OK:'), answer).toBe(true);
	const data = JSON.parse(answer.slice('OK:'.length)) as {
		rows?: { c?: Record<string, unknown> }[];
	};
	const out = new Set<string>();
	for (const row of data.rows ?? []) {
		for (const cell of Object.values(row.c ?? {})) {
			if (typeof cell !== 'string') continue;
			for (const part of cell.split(/ \| |, /)) if (part !== '') out.add(part);
		}
	}
	return [...out].sort();
}

const refusedBy = (column: string): string => `REFUSED:${REFUSAL}:${JSON.stringify({ column })}`;

const SHAPES: readonly Shape[] = ['value', 'fanout', 'compact', 'rows', 'columns'];

describe.if(DB_READY)('a relation column exports exactly its display (D4)', () => {
	beforeAll(async () => {
		await ensureSituation(S);
		await identity.install(SCOPED_GRANTS, ADMIN_GRANTS);
		await writeRecords();
	}, 120_000);

	afterAll(async () => {
		await identity.remove(true);
		expect(await dropSituation(S)).toBe(0);
		const tipos = S.nodes.map((node) => node.tipo);
		for (const tipo of tipos) await sweepActivityRows(tipo);
		let residue = 0;
		for (const tipo of tipos) residue += await countActivityRows(tipo);
		expect(residue).toBe(0);
	});

	test('the fixture is non-degenerate: the targets are OUT of scope and the read DISPLAYS them', async () => {
		await writeRecords();
		clearFrontierIdentityCaches();
		expect(await isRecordInScope(H, 1, identity.scoped)).toBe(true);
		expect(await isRecordInScope(T, 1, identity.scoped)).toBe(false);
		expect(await isRecordInScope(U, 1, identity.scoped)).toBe(false);
		const items = await sectionReadItems(identity.scoped);
		// depth 0 (the target's label) and depth 1 (its target's label) — never the hidden field
		expect(displayedValues(items, REL_A)).toEqual([VALUE.u1, VALUE.t1].sort());
		expect(displayedValues(items, REL_P)).toEqual([VALUE.u1, VALUE.t1].sort());
	});

	describe('(a) the plain column exports, and its cell EQUALS the read’s display', () => {
		for (const shape of SHAPES) {
			test(`${shape}: scoped OK, values == the section read's embedded values; admin equal (d)`, async () => {
				await writeRecords();
				const shown = displayedValues(await sectionReadItems(identity.scoped), columnOf(shape));
				expect(shown.length).toBeGreaterThan(0);
				const scoped = await exportAnswer(identity.scoped, { shape });
				expect(exportedValues(scoped)).toEqual(shown);
				expect(scoped).not.toContain(VALUE.hidden);
				// (d) the admin control: no frontier, the same column, the same values
				const admin = await exportAnswer(identity.admin, { shape });
				expect(exportedValues(admin)).toEqual(shown);
			});
		}

		// The LIVE shape (tool_export job, numisdata3 → numisdata30, user 1): the
		// job always captures media; the carve-out must hold there too.
		for (const shape of ['value', 'fanout', 'compact'] as const) {
			test(`${shape}: the JOB's capturing run exports the display too (== the read)`, async () => {
				await writeRecords();
				const shown = displayedValues(await sectionReadItems(identity.scoped), columnOf(shape));
				const scoped = await jobAnswer(identity.scoped, { shape });
				expect(exportedValues(scoped)).toEqual(shown);
				expect(scoped).not.toContain(VALUE.hidden);
				expect(exportedValues(await jobAnswer(identity.admin, { shape }))).toEqual(shown);
			});
		}

		test('the JOB keeps the full law beyond the display: a path into the target THROWS', async () => {
			await writeRecords();
			const path = [
				{ section_tipo: H, component_tipo: REL_A },
				{ section_tipo: T, component_tipo: T_LABEL },
			];
			await identity.setScopedGrants(PATH_GRANTS);
			try {
				expect(await jobAnswer(identity.scoped, { shape: 'value', path })).toBe(
					refusedBy('zz ed main > zz ed label'),
				);
			} finally {
				await identity.setScopedGrants(SCOPED_GRANTS);
			}
		});

		test('an EMPTY displayed field refuses nothing (the read shows an empty cell)', async () => {
			await writeRecords({ emptyLabel: true });
			const shown = displayedValues(await sectionReadItems(identity.scoped), REL_A);
			expect(shown).toEqual([VALUE.u1]);
			for (const shape of ['value', 'fanout'] as const) {
				expect(exportedValues(await exportAnswer(identity.scoped, { shape }))).toEqual(shown);
			}
		});
	});

	describe('(f) displayed in ONE position, reached in ANOTHER — the display is per RECORD', () => {
		const path = [{ section_tipo: H, component_tipo: REL_S }];
		for (const shape of ['value', 'fanout'] as const) {
			test(`${shape}: control — every reach is a displayed position: OK, == the read`, async () => {
				await writeSelfRecords(false);
				const shown = displayedValues(await sectionReadItems(identity.scoped), REL_S);
				expect(shown).toEqual([VALUE.t1, VALUE.t2, VALUE.t3hidden, VALUE.t4hidden].sort());
				const scoped = await exportAnswer(identity.scoped, { shape, path });
				expect(exportedValues(scoped)).toEqual(shown);
				expect(scoped).not.toContain(VALUE.hidden);
			});

			test(`${shape}: t#1 shown with its LABEL, reached for its HIDDEN field (shown only at its siblings) THROWS`, async () => {
				await writeSelfRecords(true);
				// the read shows t#1 (label) and T_HIDDEN (at t#3 / t#4) — never t#1's hidden field
				const shown = displayedValues(await sectionReadItems(identity.scoped), REL_S);
				expect(shown).toContain(VALUE.t1);
				expect(shown).toContain(VALUE.t3hidden);
				expect(shown).not.toContain(VALUE.hidden);
				expect(await exportAnswer(identity.scoped, { shape, path })).toBe(refusedBy('zz ed self'));
				const admin = await exportAnswer(identity.admin, { shape, path });
				expect(admin).toContain(VALUE.hidden);
			});
		}
	});

	describe('(g) frames on a display-admitted OWNER — the display is per frame ENTRY', () => {
		// compact = the WC-008 portal cell (relation_list's per-target values —
		// the only door in that shape; value/fanout also cross in the fan-out)
		for (const shape of ['value', 'fanout', 'compact'] as const) {
			const column = shape === 'compact' ? REL_FP : REL_F;
			const label = shape === 'compact' ? 'zz ed framed compact' : 'zz ed framed';
			const path = [{ section_tipo: H, component_tipo: column }];
			test(`${shape}: a frame the read shows at t#1 exports, == the read`, async () => {
				await writeFramedRecords();
				const shown = displayedValues(await sectionReadItems(identity.scoped), column);
				// t#1's label, its target u#1, and u#2 — reached ONLY as t#1's frame target
				expect(shown).toEqual([VALUE.t1, VALUE.u1, VALUE.u2].sort());
				expect(exportedValues(await exportAnswer(identity.scoped, { shape, path }))).toEqual(shown);
				expect(exportedValues(await exportAnswer(identity.admin, { shape, path }))).toEqual(shown);
			});

			test(`${shape}: a frame paired to a main item the nested cell does NOT show THROWS`, async () => {
				await writeFramedRecords(true);
				// every record is displayed somewhere (u#2 under t#2), but t#1's frame
				// for its SECOND item is not: the read emits t#1's slot without it
				const shown = displayedValues(await sectionReadItems(identity.scoped), column);
				expect(shown).toEqual([VALUE.t1, VALUE.t2, VALUE.u1, VALUE.u2].sort());
				expect(await exportAnswer(identity.scoped, { shape, path })).toBe(refusedBy(label));
				const admin = await exportAnswer(identity.admin, { shape, path });
				expect(admin.startsWith('OK:'), admin).toBe(true);
			});
		}
	});

	describe('(b) a declared path INTO the target keeps the full law', () => {
		beforeAll(() => identity.setScopedGrants(PATH_GRANTS));
		afterAll(() => identity.setScopedGrants(SCOPED_GRANTS));

		const INTO: { name: string; field: string; label: string }[] = [
			{ name: 'a target field OUTSIDE the display', field: T_HIDDEN, label: 'zz ed hidden' },
			{ name: 'a target field INSIDE the display', field: T_LABEL, label: 'zz ed label' },
		];
		for (const into of INTO) {
			for (const shape of ['value', 'fanout'] as const) {
				test(`${shape}: ${into.name} THROWS by its column; admin exports it`, async () => {
					await writeRecords();
					const path = [
						{ section_tipo: H, component_tipo: REL_A },
						{ section_tipo: T, component_tipo: into.field },
					];
					expect(await exportAnswer(identity.scoped, { shape, path })).toBe(
						refusedBy(`zz ed main > ${into.label}`),
					);
					const admin = await exportAnswer(identity.admin, { shape, path });
					expect(admin).toContain(into.field === T_HIDDEN ? VALUE.hidden : VALUE.t1);
				});
			}
		}
	});

	describe('(c) the parents chain keeps the full law — even for an ancestor the column displays', () => {
		for (const shape of ['value', 'fanout', 'compact'] as const) {
			test(`${shape}: scoped THROWS by the column; admin carries the chain`, async () => {
				await writeRecords({ linkParent: true });
				// the ancestor t#2 IS displayed (the column lists it) — the chain still refuses
				const shown = displayedValues(await sectionReadItems(identity.scoped), columnOf(shape));
				expect(shown).toContain(VALUE.t2);
				expect(exportedValues(await exportAnswer(identity.scoped, { shape }))).toEqual(shown);
				expect(await exportAnswer(identity.scoped, { shape, withParents: true })).toBe(
					refusedBy(columnLabelOf(shape)),
				);
				const admin = await exportAnswer(identity.admin, { shape, withParents: true });
				expect(admin.startsWith('OK:'), admin).toBe(true);
				expect(admin).toContain(VALUE.t2);
			});
		}
	});

	describe('beyond the display: each half of the predicate is the only guard of its case', () => {
		// A displayed record read for a component the read does NOT show: HI
		// injects [T_LABEL] under each column; their OWN config also names
		// T_HIDDEN. The section map's STEP 11 drops an injected line the persona
		// holds 0 on (the map then falls back to the column's own, wider config),
		// so the injected field is granted — the target RECORD stays out of scope.
		// Both walks: the fan-out (autocomplete, value + grid_value) and the
		// value cell (portal, WC-008 compact) — directly and through an alias.
		const INJECTED_CASES = [
			{ column: REL_I, label: 'zz ed injected', shapes: ['value', 'fanout'] as Shape[] },
			{ column: REL_IP, label: 'zz ed injected compact', shapes: ['compact'] as Shape[] },
			// the same read reached through a component_alias of the hidden field:
			// it stores NOTHING under its own tipo, so "holds no data" must ask
			// the value read's own door (the alias data key), not the alias slot
			{
				column: REL_IA,
				label: 'zz ed injected alias',
				shapes: ['value', 'fanout', 'rows', 'columns'] as Shape[],
			},
			{
				column: REL_IAP,
				label: 'zz ed injected alias compact',
				shapes: ['compact'] as Shape[],
			},
		];
		for (const injected of INJECTED_CASES) {
			test(`${injected.label}: a displayed record read for a component the read does NOT show → THROWS`, async () => {
				await writeRecords();
				const path = [{ section_tipo: HI, component_tipo: injected.column }];
				await identity.setScopedGrants([
					...SCOPED_GRANTS,
					{ sectionTipo: T, tipo: T_LABEL, level: 1 },
				]);
				try {
					const items = await sectionReadItems(identity.scoped, HI);
					expect(displayedValues(items, injected.column, HI)).toEqual([VALUE.t1]);
					for (const shape of injected.shapes) {
						expect(await exportAnswer(identity.scoped, { shape, host: HI, path })).toBe(
							refusedBy(injected.label),
						);
					}
				} finally {
					await identity.setScopedGrants(SCOPED_GRANTS);
				}
				// non-vacuity: the export's own config DOES reach the hidden field
				for (const shape of injected.shapes) {
					expect(await exportAnswer(identity.admin, { shape, host: HI, path })).toContain(
						VALUE.hidden,
					);
				}
			});
		}

		test('a record the read does NOT expand (a nested list cell’s second target) → THROWS by the column', async () => {
			await writeRecords({ secondDeep: true });
			const shown = displayedValues(await sectionReadItems(identity.scoped), REL_A);
			expect(shown).toEqual([VALUE.u1, VALUE.t1].sort());
			expect(shown).not.toContain(VALUE.u2);
			for (const shape of ['value', 'fanout'] as const) {
				expect(await exportAnswer(identity.scoped, { shape })).toBe(refusedBy('zz ed main'));
			}
			const admin = await exportAnswer(identity.admin, { shape: 'value' });
			expect(admin).toContain(VALUE.u2);
		});
	});

	test('(e) a column the read does not show (grant 0) has no display: refused before any walk', async () => {
		await writeRecords();
		await identity.setScopedGrants(SCOPED_GRANTS.filter((grant) => grant.tipo !== REL_A));
		try {
			const items = await sectionReadItems(identity.scoped);
			expect(items.some((item) => item.tipo === REL_A)).toBe(false);
			expect(await exportAnswer(identity.scoped, { shape: 'value' })).toStartWith(
				'REFUSED:perm.denied:',
			);
		} finally {
			await identity.setScopedGrants(SCOPED_GRANTS);
		}
	});
});
