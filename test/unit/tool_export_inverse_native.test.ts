/**
 * tool_export EXPORTS component_inverse (T0-9 follow-up, 2026-11-11).
 * Wire: WC-2026-11-11-export-inverse-callers.
 *
 * component_inverse is DERIVED (descriptor `derived`): its value is the host
 * record's BACKLINKS — every locator, held by any relation component of any
 * record, that points at it (component_inverse/emit.ts resolveInverseEntries).
 * Before this, its export column shipped blank: the model declared no flat
 * family, so every value cell resolved to a ledgered null, and dedalo_raw read
 * its empty `misc` slot.
 *
 * THE CONTRACT pinned here (every expected cell written out in full):
 *   value       ONE column per top component (`H_INV`); the cell is the PHP
 *               join — the caller ids of one pair joined ', ', the pairs joined
 *               by the default fields separator — NEVER a positional zip of
 *               unrelated callers across pairs (no ' | ' records split: the
 *               value walk sets no item_index on the caller-pair segment).
 *   grid_value  ONE column per CALLER PAIR (from_section_tipo,
 *               from_component_tipo): key `H_INV.<caller sec>_<caller comp>`,
 *               label '<inverse term> | <caller component term>', ar_labels
 *               [host section, inverse, caller section, caller component];
 *               'default' and 'rows' put one caller per row (the n-th caller
 *               of every pair, section_id ASC), 'columns' one per '|n' column.
 *               (Deliberate divergence: PHP put every caller in one cell.)
 *   dedalo_raw  ONE column; the cell is {"dedalo_data": <the backlink
 *               entries — the stored locator + from_section_tipo +
 *               from_section_id>}, exactly the edit view's entries for the
 *               same principal; no cell when nothing points here. The other
 *               derived relations (component_relation_children /
 *               component_relation_index) export their COMPUTED locators raw,
 *               not null.
 *   authz       a non-admin principal gets only the callers it may read —
 *               section read grant + projects boundary
 *               (scopeInverseReferenceHits, the edit view's policy); the
 *               global admin gets them all (control).
 *   malformed   a backlink with no from_component_tipo is never a value.
 *   empty       a host with no backlinks exports no atom (empty cells).
 *   re-check    a FINISHED export (job → artifact store) re-asks the SECTION read
 *               grant of every caller section it disclosed (manifest
 *               `frontier_grants` pair (section, section) — atoms.ts
 *               recordInverseCallerGrants): revoking it closes the export.
 *   panel       the request-path flat reader (relation_list.ts resolveCellItems
 *               'inverse' branch, ALS principal) — an inverse column of the
 *               pointing section's relation_list in the relation_list panel —
 *               drops the callers the viewer may not read.
 *   D4 safety   (resolver.ts holdsNoData — not exported, reached through the
 *               display carve-out): a displayed record read for its
 *               component_inverse the read does NOT show must NOT count as
 *               "holds no data" (its `misc` slot is always empty) → the export
 *               refuses by the column; the admin control exports the caller.
 *
 * THE SITUATION IS BUILT (`zzxi`, dropped in afterAll, residue 0):
 *   zzxi1  H (host)   zzxi2 filter · zzxi3 INV component_inverse · zzxi4 H_LABEL
 *                     zzxi5 HP relation_parent · zzxi6 HC relation_children
 *                     zzxi7 HIX relation_index · zzxi8 H_IPTR portal (dd96)
 *                     zzxi9 H_RL relation_list → [INV]
 *   zzxi10 A caller   zzxi11 filter · zzxi12 PA portal → H
 *   zzxi20 B caller   zzxi21 filter · zzxi22 PB autocomplete → H
 *   zzxi30 X secret   zzxi31 filter · zzxi32 PX portal → H   (NO grant on X)
 *   zzxi40 J host     zzxi41 filter · zzxi42 REL_J autocomplete → H, own config
 *                     [H_LABEL, INV]; J's map injects [REL_J ⟶ H_LABEL] only
 * Records (matrix_test):
 *   H#1 (mine) ← A#11, A#12 (pair A, two callers), A#13 (MALFORMED: no
 *       from_component_tipo), B#21 (mine), B#22 (OTHER project), X#31 (mine,
 *       ungranted section)
 *   H#2 (mine) ← nothing
 *   H#3 (mine) HP → H#4 (dd47), H_IPTR → H#4 (dd96): H#4's children / index
 *       H#3 ← A#16 (mine), B#23 (OTHER project), X#33 (mine, ungranted section)
 *   H#6 (OTHER project) HP → H#4, H_IPTR → H#4: the out-of-scope child/pointer
 *   H#5 (OTHER project) ← A#15; J#1 (mine) REL_J → H#5  (the D4 probe)
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type InverseEntry,
	resolveInverseEntries,
} from '../../src/core/components/component_inverse/emit.ts';
import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { isDedaloError } from '../../src/core/errors/index.ts';
import {
	buildRelationList,
	clearFieldsSeparatorCache,
} from '../../src/core/resolve/relation_list.ts';
import { runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';
import { getPermissions, type Principal } from '../../src/core/security/permissions.ts';
import { isRecordInScope } from '../../src/core/security/record_scope.ts';
import { runWithRequestContext } from '../../src/core/security/request_context.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import type { ToolActionContext, ToolResponse } from '../../src/core/tools/module.ts';
import { clearTermCache } from '../../src/core/ts_object/term_resolver.ts';
import { exportRecordScope } from '../../tools/tool_export/server/access.ts';
import {
	type ArtifactStore,
	openArtifactStore,
} from '../../tools/tool_export/server/artifact_store.ts';
import { runExportArtifact } from '../../tools/tool_export/server/export_job.ts';
import { readExportPreview } from '../../tools/tool_export/server/preview.ts';
import { toolExportGetExportGrid } from '../../tools/tool_export/server/tool_export.ts';
import { countActivityRows, sweepActivityRows } from '../helpers/activity_rows.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import {
	clearFrontierIdentityCaches,
	exportFrontierIdentity,
	type FrontierGrant,
} from '../helpers/export_frontier_identity.ts';
import { hostColumnDisplayedValues, hostSectionReadItems } from '../helpers/host_section_read.ts';
import { markExportArtifactsRoot } from '../helpers/media_scratch_root.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

registerSessionCleanup();

const LANG = 'lg-eng';
const TABLE = 'matrix_test';
const REFUSAL = 'perm.export_column_out_of_scope';

const H = 'zzxi1';
const H_FILTER = 'zzxi2';
const INV = 'zzxi3';
const H_LABEL = 'zzxi4';
const HP = 'zzxi5';
const HC = 'zzxi6';
const HIX = 'zzxi7';
const H_IPTR = 'zzxi8';
const H_RL = 'zzxi9';
const A = 'zzxi10';
const A_FILTER = 'zzxi11';
const PA = 'zzxi12';
const B = 'zzxi20';
const B_FILTER = 'zzxi21';
const PB = 'zzxi22';
const X = 'zzxi30';
const X_FILTER = 'zzxi31';
const PX = 'zzxi32';
const J = 'zzxi40';
const J_FILTER = 'zzxi41';
const REL_J = 'zzxi42';

const TERM = {
	H: 'zz xi host',
	INV: 'zz xi used by',
	A: 'zz xi caller a',
	PA: 'zz xi a link',
	B: 'zz xi caller b',
	PB: 'zz xi b link',
	X: 'zz xi secret',
	PX: 'zz xi x link',
	REL_J: 'zz xi injected',
};

const term = (value: string) => ({ [LANG]: value });
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
const requestConfig = (target: string, children: string[]) => ({
	source: {
		request_config: [
			{
				sqo: { section_tipo: [{ value: [target], source: 'section' }] },
				show: {
					ddo_map: children.map((tipo) => ({ tipo, parent: 'self', section_tipo: target })),
				},
			},
		],
	},
});

const S = situation({
	name: 'tool_export component_inverse',
	tld: 'zzxi',
	nodes: [
		section(H, TERM.H),
		filter(H_FILTER, H),
		{ tipo: INV, parent: H, model: 'component_inverse', term: term(TERM.INV) },
		{
			tipo: H_LABEL,
			parent: H,
			model: 'component_input_text',
			term: term('zz xi label'),
			is_translatable: true,
		},
		{
			tipo: HP,
			parent: H,
			model: 'component_relation_parent',
			term: term('zz xi parent'),
			properties: requestConfig(H, [H_LABEL]),
		},
		{
			tipo: HC,
			parent: H,
			model: 'component_relation_children',
			term: term('zz xi children'),
			properties: requestConfig(H, [H_LABEL]),
		},
		{
			tipo: HIX,
			parent: H,
			model: 'component_relation_index',
			term: term('zz xi index'),
			properties: requestConfig(H, [H_LABEL]),
		},
		{
			tipo: H_IPTR,
			parent: H,
			model: 'component_portal',
			term: term('zz xi index pointer'),
			properties: requestConfig(H, [H_LABEL]),
		},
		{
			tipo: H_RL,
			parent: H,
			model: 'relation_list',
			term: term('zz xi relation list'),
			relations: [{ tipo: INV }],
		},
		section(A, TERM.A),
		filter(A_FILTER, A),
		{
			tipo: PA,
			parent: A,
			model: 'component_portal',
			term: term(TERM.PA),
			properties: requestConfig(H, [H_LABEL]),
		},
		section(B, TERM.B),
		filter(B_FILTER, B),
		{
			tipo: PB,
			parent: B,
			model: 'component_autocomplete',
			term: term(TERM.PB),
			properties: requestConfig(H, [H_LABEL]),
		},
		section(X, TERM.X),
		filter(X_FILTER, X),
		{
			tipo: PX,
			parent: X,
			model: 'component_portal',
			term: term(TERM.PX),
			properties: requestConfig(H, [H_LABEL]),
		},
		{
			...section(J, 'zz xi injecting host'),
			properties: {
				source: {
					request_config: [
						{
							sqo: { section_tipo: [{ source: 'self' }] },
							show: {
								ddo_map: [
									{ tipo: REL_J, parent: 'self', section_tipo: 'self' },
									{ tipo: H_LABEL, parent: REL_J, section_tipo: H },
								],
							},
						},
					],
				},
			},
		},
		filter(J_FILTER, J),
		{
			tipo: REL_J,
			parent: J,
			model: 'component_autocomplete',
			term: term(TERM.REL_J),
			properties: requestConfig(H, [H_LABEL, INV]),
		},
	],
});

const identity = exportFrontierIdentity('tool_export_inverse', 934300);

/** The persona: H + its inverse / children / index columns, read on A and B; NOTHING on X. */
const SCOPED_GRANTS: FrontierGrant[] = [
	{ sectionTipo: H, tipo: H, level: 2 },
	{ sectionTipo: H, tipo: INV, level: 2 },
	{ sectionTipo: H, tipo: H_LABEL, level: 1 },
	{ sectionTipo: H, tipo: HC, level: 1 },
	{ sectionTipo: H, tipo: HIX, level: 1 },
	{ sectionTipo: A, tipo: A, level: 1 },
	{ sectionTipo: A, tipo: PA, level: 1 },
	{ sectionTipo: B, tipo: B, level: 1 },
	{ sectionTipo: B, tipo: PB, level: 1 },
	{ sectionTipo: J, tipo: J, level: 2 },
	{ sectionTipo: J, tipo: REL_J, level: 2 },
];

/** The admin: level 3 on every section and component of the situation. */
const ADMIN_GRANTS: FrontierGrant[] = S.nodes.flatMap((node) => {
	if (node.model === 'section') return [{ sectionTipo: node.tipo, tipo: node.tipo, level: 3 }];
	if (node.parent === null) throw new Error(`situation node ${node.tipo} has no parent section`);
	return [{ sectionTipo: node.parent, tipo: node.tipo, level: 3 }];
});

const locator = (
	from: string | undefined,
	sectionTipo: string,
	sectionId: number,
	type = 'dd151',
) => ({
	id: 1,
	type,
	section_tipo: sectionTipo,
	section_id: sectionId,
	...(from === undefined ? {} : { from_component_tipo: from }),
});

async function writeRecord(
	sectionTipo: string,
	sectionId: number,
	filterTipo: string,
	project: number,
	relation: Record<string, unknown> = {},
	string: Record<string, unknown> = {},
): Promise<void> {
	await sql.unsafe(`DELETE FROM ${TABLE} WHERE section_tipo = $1 AND section_id = $2`, [
		sectionTipo,
		sectionId,
	]);
	await sql.unsafe(
		`INSERT INTO ${TABLE} (section_tipo, section_id, relation, string, data)
		 VALUES ($1, $2, $3::text::jsonb, $4::text::jsonb, $5::text::jsonb)`,
		[
			sectionTipo,
			sectionId,
			encodeForJsonb({ [filterTipo]: [identity.filterLocator(filterTipo, project)], ...relation }),
			encodeForJsonb(string),
			encodeForJsonb({ section_tipo: sectionTipo, section_id: sectionId }),
		],
	);
	clearTermCache();
}

const SECTIONS = [H, A, B, X, J];

async function sweepRecords(): Promise<number> {
	let removed = 0;
	for (const tipo of SECTIONS) {
		const rows = (await sql.unsafe(
			`DELETE FROM ${TABLE} WHERE section_tipo = $1 RETURNING section_id`,
			[tipo],
		)) as unknown[];
		removed += rows.length;
	}
	return removed;
}

async function writeRecords(): Promise<void> {
	const mine = identity.myProject;
	const other = identity.otherProject;
	const label = (value: string) => ({ [H_LABEL]: [{ id: 1, lang: LANG, value }] });
	await writeRecord(H, 1, H_FILTER, mine, {}, label('zz xi one'));
	await writeRecord(H, 2, H_FILTER, mine, {}, label('zz xi two'));
	await writeRecord(
		H,
		3,
		H_FILTER,
		mine,
		{ [HP]: [locator(HP, H, 4, 'dd47')], [H_IPTR]: [locator(H_IPTR, H, 4, 'dd96')] },
		label('zz xi three'),
	);
	await writeRecord(H, 4, H_FILTER, mine, {}, label('zz xi four'));
	await writeRecord(H, 5, H_FILTER, other, {}, label('zz xi five'));
	await writeRecord(
		H,
		6,
		H_FILTER,
		other,
		{ [HP]: [locator(HP, H, 4, 'dd47')], [H_IPTR]: [locator(H_IPTR, H, 4, 'dd96')] },
		label('zz xi six'),
	);
	await writeRecord(A, 11, A_FILTER, mine, { [PA]: [locator(PA, H, 1)] });
	await writeRecord(A, 12, A_FILTER, mine, { [PA]: [locator(PA, H, 1)] });
	// MALFORMED: a backlink to H#1 whose locator names no from_component_tipo
	await writeRecord(A, 13, A_FILTER, mine, { [PA]: [locator(undefined, H, 1)] });
	await writeRecord(A, 15, A_FILTER, mine, { [PA]: [locator(PA, H, 5)] });
	await writeRecord(A, 16, A_FILTER, mine, { [PA]: [locator(PA, H, 3)] });
	await writeRecord(B, 21, B_FILTER, mine, { [PB]: [locator(PB, H, 1)] });
	await writeRecord(B, 22, B_FILTER, other, { [PB]: [locator(PB, H, 1)] });
	await writeRecord(B, 23, B_FILTER, other, { [PB]: [locator(PB, H, 3)] });
	await writeRecord(X, 31, X_FILTER, mine, { [PX]: [locator(PX, H, 1)] });
	await writeRecord(X, 33, X_FILTER, mine, { [PX]: [locator(PX, H, 3)] });
	await writeRecord(J, 1, J_FILTER, mine, { [REL_J]: [locator(REL_J, H, 5)] });
}

// ── the export ───────────────────────────────────────────────────────────────

type Grid = {
	columns?: Record<string, unknown>[];
	rows?: Record<string, unknown>[];
};

const contextOf = (options: Record<string, unknown>, principal: Principal): ToolActionContext =>
	({ principal, userId: principal.userId, options, background: false }) as ToolActionContext;

function exportOptions(
	dataFormat: 'value' | 'grid_value' | 'dedalo_raw',
	breakdown: 'default' | 'rows' | 'columns',
	ids: number[],
	path: { section_tipo: string; component_tipo: string }[] = [
		{ section_tipo: H, component_tipo: INV },
	],
	host = H,
): Record<string, unknown> {
	return {
		section_tipo: host,
		model: 'section',
		lang: LANG,
		data_format: dataFormat,
		breakdown,
		fill_the_gaps: false,
		ar_ddo_to_export: [{ path }],
		sqo: {
			section_tipo: [host],
			limit: 10,
			offset: 0,
			filter_by_locators: ids.map((id) => ({ section_tipo: host, section_id: String(id) })),
		},
	};
}

async function gridOf(principal: Principal, options: Record<string, unknown>): Promise<Grid> {
	clearFrontierIdentityCaches();
	const response: ToolResponse = await toolExportGetExportGrid(contextOf(options, principal));
	const grid = (response.data ?? {}) as Grid;
	expect(Array.isArray(grid.columns), 'the export answered no columns line').toBe(true);
	return grid;
}

async function answerOf(principal: Principal, options: Record<string, unknown>): Promise<string> {
	clearFrontierIdentityCaches();
	try {
		const response: ToolResponse = await toolExportGetExportGrid(contextOf(options, principal));
		return `OK:${JSON.stringify(response.data)}`;
	} catch (error) {
		const code = (error as { code?: string }).code ?? 'unknown';
		const details = (error as { details?: unknown }).details;
		return `REFUSED:${code}:${JSON.stringify(details ?? null)}`;
	}
}

/** The grid as `rec#sub → {column key → cell}` — sorted, exact, key-addressed. */
function cellsByKey(grid: Grid): Record<string, Record<string, string>> {
	const keyOf = new Map<string, string>();
	for (const column of grid.columns ?? []) keyOf.set(String(column.i), String(column.key));
	const out: Record<string, Record<string, string>> = {};
	for (const row of grid.rows ?? []) {
		const cells: Record<string, string> = {};
		for (const [ordinal, cell] of Object.entries((row.c ?? {}) as Record<string, unknown>)) {
			const key = keyOf.get(ordinal);
			expect(key, `cell under unknown column ordinal ${ordinal}`).toBeDefined();
			cells[key as string] = String(cell);
		}
		out[`${String(row.rec)}#${String(row.sub ?? 0)}`] = cells;
	}
	return out;
}

const keysOf = (grid: Grid): string[] => (grid.columns ?? []).map((c) => String(c.key)).sort();

const TOP = `${H}_${INV}`;
const PAIR_A = `${TOP}.${A}_${PA}`;
const PAIR_B = `${TOP}.${B}_${PB}`;
const PAIR_X = `${TOP}.${X}_${PX}`;

/** What each principal must see of H#1's callers (section_id ASC within a pair). */
const VISIBLE = {
	admin: { [PAIR_A]: ['11', '12'], [PAIR_B]: ['21', '22'], [PAIR_X]: ['31'] },
	scoped: { [PAIR_A]: ['11', '12'], [PAIR_B]: ['21'] },
} as const;
type Persona = keyof typeof VISIBLE;
const principalOf = (persona: Persona): Principal =>
	persona === 'admin' ? identity.admin : identity.scoped;

/** grid_value 'default' / 'rows': row n carries the n-th caller of every pair. */
function expectedRowsGrid(persona: Persona): Record<string, Record<string, string>> {
	const pairs = VISIBLE[persona] as Record<string, readonly string[]>;
	const height = Math.max(...Object.values(pairs).map((ids) => ids.length));
	const out: Record<string, Record<string, string>> = {};
	for (let sub = 0; sub < height; sub++) {
		const cells: Record<string, string> = {};
		for (const [key, ids] of Object.entries(pairs)) {
			if (ids[sub] !== undefined) cells[key] = ids[sub] as string;
		}
		out[`1#${sub}`] = cells;
	}
	return out;
}

/** grid_value 'columns': caller n > 0 of a pair moves to the '|n' column. */
function expectedColumnsGrid(persona: Persona): Record<string, string> {
	const pairs = VISIBLE[persona] as Record<string, readonly string[]>;
	const cells: Record<string, string> = {};
	for (const [key, ids] of Object.entries(pairs)) {
		ids.forEach((id, index) => {
			cells[index === 0 ? key : `${key}|${index}`] = id;
		});
	}
	return cells;
}

/** The value cell: the PHP join — ids of a pair ', ', pairs by the default ', '. */
function expectedValueCell(persona: Persona): string {
	return Object.values(VISIBLE[persona] as Record<string, readonly string[]>)
		.flat()
		.join(', ');
}

/** The edit view's entries of `sectionId`, as `principal` (the raw cell's law). */
const editViewEntries = (principal: Principal, sectionId: number): Promise<InverseEntry[]> =>
	runWithRequestContext(
		{ principal, session: null, requestId: 'zzxi-entries', clientIp: '127.0.0.1' },
		() => resolveInverseEntries(H, sectionId),
	);

describe.if(DB_READY)('tool_export exports component_inverse (callers)', () => {
	beforeAll(async () => {
		await assertTestDatabase('tool_export_inverse_native');
		await ensureSituation(S);
		await identity.install(SCOPED_GRANTS, ADMIN_GRANTS);
		await sweepRecords();
		await writeRecords();
	}, 120_000);

	afterAll(async () => {
		await sweepRecords();
		await identity.remove(true);
		expect(await dropSituation(S)).toBe(0);
		for (const node of S.nodes) await sweepActivityRows(node.tipo);
		let residue = 0;
		for (const node of S.nodes) residue += await countActivityRows(node.tipo);
		const rows = (await sql.unsafe(
			`SELECT count(*)::int AS n FROM ${TABLE} WHERE section_tipo = ANY($1)`,
			[SECTIONS],
		)) as { n: number }[];
		residue += rows[0]?.n ?? 0;
		expect(residue).toBe(0);
	});

	test('the fixture is non-degenerate: scope, grants and the raw backlinks are what the cases assume', async () => {
		clearFrontierIdentityCaches();
		expect(await isRecordInScope(H, 1, identity.scoped)).toBe(true);
		expect(await isRecordInScope(B, 21, identity.scoped)).toBe(true);
		expect(await isRecordInScope(B, 22, identity.scoped)).toBe(false);
		expect(await isRecordInScope(H, 5, identity.scoped)).toBe(false);
		// the engine SEES every backlink of H#1, the malformed one included
		const all = await editViewEntries(identity.admin, 1);
		const owners = all.map((e) => `${e.from_section_tipo}#${e.from_section_id}`).sort();
		expect(owners).toEqual(
			[`${A}#11`, `${A}#12`, `${A}#13`, `${B}#21`, `${B}#22`, `${X}#31`].sort(),
		);
		const malformed = all.find((e) => e.from_section_id === 13);
		expect(malformed?.from_component_tipo).toBeUndefined();
		// the scoped edit view drops the ungranted section and the other project
		const scoped = await editViewEntries(identity.scoped, 1);
		expect(scoped.map((e) => `${e.from_section_tipo}#${e.from_section_id}`).sort()).toEqual(
			[`${A}#11`, `${A}#12`, `${A}#13`, `${B}#21`].sort(),
		);
		expect(await editViewEntries(identity.admin, 2)).toEqual([]);
	});

	describe('value format: one column, the PHP join, no positional zip across pairs', () => {
		for (const persona of ['admin', 'scoped'] as const) {
			test(`${persona}: H#1 → '${expectedValueCell(persona)}', H#2 → empty`, async () => {
				const grid = await gridOf(principalOf(persona), exportOptions('value', 'default', [1, 2]));
				expect(keysOf(grid)).toEqual([TOP]);
				// the DECLARED path label: the inverse component's own term (no per-pair header)
				expect(grid.columns?.[0]?.label).toBe(TERM.INV);
				const cells = cellsByKey(grid);
				expect(cells['1#0']).toEqual({ [TOP]: expectedValueCell(persona) });
				// pair A has 2 callers, pair B 1 (scoped) / 2 — never a ' | ' records split
				expect(cells['1#0']?.[TOP]).not.toContain(' | ');
				expect(Object.keys(cells).filter((key) => key.startsWith('1#'))).toEqual(['1#0']);
				expect(cells['2#0'] ?? {}).toEqual({});
			});
		}
	});

	describe('grid_value: one column per caller pair', () => {
		for (const persona of ['admin', 'scoped'] as const) {
			for (const breakdown of ['default', 'rows'] as const) {
				test(`${persona} '${breakdown}': one row per caller, n-th caller of each pair on row n`, async () => {
					const grid = await gridOf(
						principalOf(persona),
						exportOptions('grid_value', breakdown, [1]),
					);
					expect(keysOf(grid)).toEqual(Object.keys(VISIBLE[persona]).sort());
					expect(cellsByKey(grid)).toEqual(expectedRowsGrid(persona));
				});
			}

			test(`${persona} 'columns': caller n > 0 of a pair in the '|n' column, one row`, async () => {
				const grid = await gridOf(
					principalOf(persona),
					exportOptions('grid_value', 'columns', [1]),
				);
				const expected = expectedColumnsGrid(persona);
				expect(keysOf(grid)).toEqual(Object.keys(expected).sort());
				expect(cellsByKey(grid)).toEqual({ '1#0': expected });
			});
		}

		test('headers: label = inverse | caller component; ar_labels carry the caller SECTION', async () => {
			const grid = await gridOf(identity.admin, exportOptions('grid_value', 'default', [1]));
			const byKey = new Map((grid.columns ?? []).map((c) => [String(c.key), c]));
			const header = (key: string) => ({
				label: byKey.get(key)?.label,
				ar_labels: byKey.get(key)?.ar_labels,
			});
			expect(header(PAIR_A)).toEqual({
				label: `${TERM.INV} | ${TERM.PA}`,
				ar_labels: [TERM.H, TERM.INV, TERM.A, TERM.PA],
			});
			expect(header(PAIR_B)).toEqual({
				label: `${TERM.INV} | ${TERM.PB}`,
				ar_labels: [TERM.H, TERM.INV, TERM.B, TERM.PB],
			});
		});

		test('scoped: no trace of the ungranted section nor the other-project caller', async () => {
			for (const breakdown of ['default', 'rows', 'columns'] as const) {
				const answer = await answerOf(identity.scoped, exportOptions('grid_value', breakdown, [1]));
				expect(answer.startsWith('OK:'), answer).toBe(true);
				expect(answer).not.toContain(X);
				expect(answer).not.toContain(TERM.X);
				expect(answer).not.toContain('"22"');
			}
		});

		test('a host with no backlinks exports no column and no cell', async () => {
			const grid = await gridOf(identity.admin, exportOptions('grid_value', 'default', [2]));
			expect(keysOf(grid).filter((key) => key.startsWith(`${TOP}.`))).toEqual([]);
			const cells = cellsByKey(grid);
			for (const row of Object.values(cells)) expect(row).toEqual({});
		});

		test('the MALFORMED backlink (no from_component_tipo) is never a value', async () => {
			for (const persona of ['admin', 'scoped'] as const) {
				for (const [format, breakdown] of [
					['value', 'default'],
					['grid_value', 'default'],
					['grid_value', 'columns'],
				] as const) {
					const grid = await gridOf(principalOf(persona), exportOptions(format, breakdown, [1]));
					const values = Object.values(cellsByKey(grid)).flatMap((row) =>
						Object.values(row).flatMap((cell) => cell.split(/, | \| /)),
					);
					expect(values.length).toBeGreaterThan(0);
					expect(values).not.toContain('13');
				}
			}
		});
	});

	describe('dedalo_raw: {"dedalo_data": <the edit view’s backlink entries>}', () => {
		for (const persona of ['admin', 'scoped'] as const) {
			test(`${persona}: the cell is exactly the edit view's entries; H#2 has no cell`, async () => {
				const principal = principalOf(persona);
				const grid = await gridOf(principal, exportOptions('dedalo_raw', 'default', [1, 2]));
				expect(keysOf(grid)).toEqual([TOP]);
				const column = (grid.columns ?? []).find((c) => c.key === TOP);
				expect(column?.label).toBe(INV); // dedalo_raw headers are raw tipos
				const cells = cellsByKey(grid);
				const raw = cells['1#0']?.[TOP];
				expect(raw, 'H#1 raw cell').toBeDefined();
				const parsed = JSON.parse(raw as string) as { dedalo_data: InverseEntry[] };
				expect(Object.keys(parsed)).toEqual(['dedalo_data']);
				const expected = await editViewEntries(principal, 1);
				expect(expected.length).toBeGreaterThanOrEqual(persona === 'admin' ? 6 : 4);
				expect(parsed.dedalo_data).toEqual(expected);
				const owners = parsed.dedalo_data.map((e) => `${e.from_section_tipo}#${e.from_section_id}`);
				if (persona === 'scoped') {
					expect(owners).not.toContain(`${X}#31`);
					expect(owners).not.toContain(`${B}#22`);
				} else {
					expect(owners).toContain(`${X}#31`);
					expect(owners).toContain(`${B}#22`);
				}
				expect(cells['2#0']?.[TOP] ?? null).toBeNull();
			});
		}

		for (const [tipo, model] of [
			[HC, 'component_relation_children'],
			[HIX, 'component_relation_index'],
		] as const) {
			test(`${model}: exports its COMPUTED locators raw — the exact set, the same for every persona, the edit view's`, async () => {
				const key = `${H}_${tipo}`;
				const rawOf = async (principal: Principal) => {
					const grid = await gridOf(
						principal,
						exportOptions(
							'dedalo_raw',
							'default',
							[4],
							[{ section_tipo: H, component_tipo: tipo }],
						),
					);
					expect(keysOf(grid)).toEqual([key]);
					const raw = cellsByKey(grid)['4#0']?.[key];
					expect(raw, `${model} raw cell of H#4`).toBeDefined();
					return JSON.parse(raw as string);
				};
				const admin = await rawOf(identity.admin);
				const scoped = await rawOf(identity.scoped);
				// EXACT: H#3 (mine) and H#6 (OTHER project) — the computed set is never
				// narrowed per principal (children: getChildren; index: every pointer,
				// owner rule 2026-11-11), so the scoped persona gets the admin's set…
				const expected =
					model === 'component_relation_children'
						? [3, 6].map((id) => ({
								section_tipo: H,
								section_id: id,
								from_component_tipo: HC,
								type: 'dd48',
							}))
						: [3, 6].map((id) => ({
								type: 'dd96',
								section_tipo: H,
								section_id: id,
								from_component_top_tipo: H_IPTR,
							}));
				expect(admin).toEqual({ dedalo_data: expected });
				expect(scoped).toEqual({ dedalo_data: expected });
				// …and it is exactly what the scoped EDIT view lists for the component
				// (the same entries, its pagination key aside) — the fan-out walks the
				// same locator source (componentLocators), so value/grid_value reach
				// the same two records.
				const items = await hostSectionReadItems(identity.scoped, H, 4, LANG, 'zzxi-raw-edit');
				const edit = items.filter((item) => item.tipo === tipo);
				expect(edit.length).toBe(1);
				const editEntries = ((edit[0]?.entries ?? []) as Record<string, unknown>[]).map(
					({ paginated_key: _key, ...entry }) => entry,
				);
				expect(editEntries).toEqual(expected);
			});
		}
	});

	/**
	 * THE RE-CHECK (access.ts exportStillReadable): a FINISHED export is re-asked
	 * on every later read — the declaration, the record-scope fingerprint and the
	 * runtime grants the walk recorded (manifest `frontier_grants`). The caller
	 * ids (and, in grid_value, the caller section's name) the export holds were
	 * admitted on the caller SECTION's read grant (scopeInverseReferenceHits LEG
	 * 1), a section the declaration never names — so that grant must be in the
	 * recorded set (atoms.ts recordInverseCallerGrants, pair (section, section)),
	 * or a user who lost read on B after exporting still downloads B's ids.
	 */
	describe('re-check: a finished export re-asks every caller section it disclosed', () => {
		const scratchDirs: string[] = [];
		afterAll(() => {
			for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
		});
		const scratchStore = (): ArtifactStore => {
			const dir = mkdtempSync(join(tmpdir(), 'dedalo_export_inverse_'));
			scratchDirs.push(dir);
			return openArtifactStore({
				root: markExportArtifactsRoot(join(dir, 'artifacts')),
				quotaBytes: 0,
				ttlHours: 24,
			});
		};
		/** The artifact's read door (preview → resolveOwnedJob → exportStillReadable). */
		const previewDoor = (store: ArtifactStore, jobId: string): Promise<string> => {
			clearFrontierIdentityCaches();
			return readExportPreview({
				store,
				principal: identity.scoped,
				userId: identity.scoped.userId,
				sectionTipo: H,
				jobId,
				page: 0,
				pageSize: 10,
			}).then(
				(preview) => `open:${JSON.stringify(preview)}`,
				(error) => (isDedaloError(error) ? error.code : String(error)),
			);
		};
		const WITHOUT_B = SCOPED_GRANTS.filter(
			(grant) => !(grant.sectionTipo === B && grant.tipo === B),
		);

		for (const format of ['value', 'grid_value', 'dedalo_raw'] as const) {
			test(`${format}: revoking the read grant on a disclosed caller section (B) closes the export`, async () => {
				const store = scratchStore();
				clearFrontierIdentityCaches();
				try {
					const summary = await runExportArtifact({
						store,
						principal: identity.scoped,
						userId: identity.scoped.userId,
						options: exportOptions(format, 'default', [1]),
						applicationLang: LANG,
					});
					const manifest = await store.readManifest(
						store.jobRef(identity.scoped.userId, summary.job_id),
					);
					expect(manifest.status).toBe('ended');
					// recorded: every DISTINCT disclosed caller section, never the dropped X
					const callerGrants = (manifest.frontier_grants ?? []).filter(
						(grant) => grant.section_tipo === grant.component_tipo,
					);
					expect(callerGrants).toEqual([
						{ section_tipo: A, component_tipo: A },
						{ section_tipo: B, component_tipo: B },
					]);
					// non-vacuous: the file really holds B's caller (21) and it opens
					const before = await previewDoor(store, summary.job_id);
					expect(before.startsWith('open:'), before).toBe(true);
					expect(before).toContain(format === 'dedalo_raw' ? B : '21');
					expect(before).not.toContain(X);

					// Revoke ONLY B's section grant: the declaration (H, INV), the
					// record scope and B's component grant all stay.
					await identity.setScopedGrants(WITHOUT_B);
					expect(await getPermissions(identity.scoped, H, INV)).toBeGreaterThanOrEqual(1);
					expect(await getPermissions(identity.scoped, B, PB)).toBeGreaterThanOrEqual(1);
					expect(await getPermissions(identity.scoped, B, B)).toBe(0);
					expect(await exportRecordScope(identity.scoped)).toBe(manifest.record_scope);
					expect(await previewDoor(store, summary.job_id)).toBe('export.artifact_not_found');

					// Control: the grant back, the door opens again — it was that grant.
					await identity.setScopedGrants(SCOPED_GRANTS);
					expect((await previewDoor(store, summary.job_id)).startsWith('open:')).toBe(true);
				} finally {
					await identity.setScopedGrants(SCOPED_GRANTS);
				}
			});
		}
	});

	/**
	 * THE REQUEST-PATH FLAT READER (relation_list.ts resolveCellItems, 'inverse'
	 * branch — the relation_list panel, the related_search payload, related
	 * labels): no explicit principal, the ALS one. The export never reaches it
	 * (atoms.ts emitPlainAtom routes the inverse family to emitInverseAtoms
	 * first), so it is gated here at a real door: the panel of H#4 lists the
	 * records pointing at it (H#3; H#6 is outside the persona's projects) with
	 * H's relation_list column INV — H#3's own callers.
	 */
	describe('relation_list panel: an inverse column carries only the callers the viewer may read', () => {
		const panel = (principal: Principal) => {
			clearFieldsSeparatorCache();
			clearFrontierIdentityCaches();
			return runWithRequestContext(
				{ principal, session: null, requestId: 'zzxi-panel', clientIp: '' },
				() =>
					runWithRequestLangs({ applicationLang: LANG, dataLang: LANG }, () =>
						buildRelationList(H, 4, { principal, lang: LANG }),
					),
			);
		};
		const invCells = (result: Awaited<ReturnType<typeof panel>>) =>
			Object.fromEntries(
				result.data
					.filter((entry) => entry.section_tipo === H && entry.component_tipo === INV)
					.map((entry) => [String(entry.section_id), entry.value ?? null]),
			);

		test('admin: every caller of H#3 (non-vacuity), both pointing rows', async () => {
			expect(invCells(await panel(identity.admin))).toEqual({ '3': '16 | 23 | 33', '6': null });
		});

		test('scoped: B#23 (other project) and X#33 (ungranted section) are absent', async () => {
			const result = await panel(identity.scoped);
			expect(invCells(result)).toEqual({ '3': '16' });
			const text = JSON.stringify(result);
			expect(text).not.toContain('23');
			expect(text).not.toContain('33');
		});
	});

	/**
	 * D4 SAFETY (resolver.ts holdsNoData, reached through displayAdmits — the
	 * helper is not exported). J#1's REL_J lists H#5 (OTHER project); J's map
	 * injects REL_J with [H_LABEL] only, while REL_J's own config reads
	 * [H_LABEL, INV]. The export walk reaches H#5 for INV, which the read never
	 * displayed: its `misc` slot is empty BY DEFINITION (derived), so "holds no
	 * data" must be false and the record key refuses — by the column.
	 */
	test('D4: a displayed record read for its component_inverse the read does NOT show → THROWS', async () => {
		const items = await hostSectionReadItems(identity.scoped, J, 1, LANG, 'zzxi-d4');
		expect(hostColumnDisplayedValues(items, REL_J, J, 1)).toEqual(['zz xi five']);
		const path = [{ section_tipo: J, component_tipo: REL_J }];
		for (const format of ['value', 'grid_value'] as const) {
			expect(await answerOf(identity.scoped, exportOptions(format, 'default', [1], path, J))).toBe(
				`REFUSED:${REFUSAL}:${JSON.stringify({ column: TERM.REL_J })}`,
			);
		}
		// non-vacuity: the column's own config DOES reach H#5's caller (A#15)
		for (const format of ['value', 'grid_value'] as const) {
			const answer = await answerOf(identity.admin, exportOptions(format, 'default', [1], path, J));
			expect(answer.startsWith('OK:'), answer).toBe(true);
			const values = Object.values(cellsByKey(JSON.parse(answer.slice(3)) as Grid)).flatMap((row) =>
				Object.values(row).flatMap((cell) => cell.split(/, | \| /)),
			);
			expect(values).toContain('15');
		}
	});
});
