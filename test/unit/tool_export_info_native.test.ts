/**
 * tool_export EXPORTS component_info — one column per declared widget output
 * (T1-2 / O13 OX6). Wire: WC-2026-11-12-info-live-publication-export.
 *
 * Before: component_info declared no flat family, so every value cell was a
 * ledgered null (`unresolved`), grid_value had one empty column, the
 * relation_list panel blank, and dedalo_raw shipped the STORED `misc` slot —
 * which the read never serves (WC-2026-09-03).
 *
 * THE CONTRACT pinned here (PHP component_info::get_export_value :778-823 —
 * get_data_parsed, every declared ipo output → one atom under
 * `sub_id: <output id>`):
 *   value       ONE column (the info term); the cell joins every output's
 *               LIVE value — never the stored misc value;
 *   grid_value  ONE column per declared output: key `<host>_<info>#<id>`;
 *   dedalo_raw  {"dedalo_data": <the live computed items>}, never the stored;
 *   panel       relation_list.ts resolveCellItems (the request-path flat
 *               reader) answers every output's value;
 *   context     the compute runs in the exported record's context (the
 *               test_info placeholder names the record);
 *   reserved    outputs whose ids are `parents` / `references` are info
 *               columns, not the WC-049 parents mirror nor the D4 references
 *               column (their values stay in the value cell);
 *   D4 safety   a displayed record read for its component_info the read does
 *               NOT show must not count as "holds no data" (its misc slot is
 *               empty by construction) → the export refuses by the column;
 *   parsed      the export ships the widget's get_data_parsed face (sum_dates:
 *               humanized text, never the raw DateInterval objects);
 *               widgetComputeDataParsed falls back to computeData.
 *
 * THE SITUATION IS BUILT (`zzxw`, dropped in afterAll, residue 0):
 *   zzxw1  W (host)   zzxw2 filter · zzxw3 W_LABEL input_text
 *                     zzxw4 INFO component_info: test_info over W_LABEL,
 *                     outputs [zz_value, parents, references]
 *                     zzxw5 W_PORTAL portal → DATES · zzxw6 SUM component_info:
 *                     sum_dates over W_PORTAL (DATE_IN/DATE_OUT)
 *   zzxw20 DATES      zzxw21 filter · zzxw22 DATE_IN · zzxw23 DATE_OUT (date)
 *   zzxw10 J host     zzxw11 filter · zzxw12 REL_J autocomplete → W, own
 *                     config [W_LABEL, INFO]; J's map injects [REL_J ⟶ W_LABEL]
 * Records (matrix_test): W#1 (mine) label 'zz xw one' + a PLANTED stale misc
 *   + W_PORTAL → DATES#1 (2020-01-01 → 2020-03-16);
 *   W#2 (mine) no label; W#5 (OTHER project) label 'zz xw five';
 *   J#1 (mine) REL_J → W#5 (the D4 probe).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
	getInfoWidget,
	widgetComputeDataParsed,
} from '../../src/core/components/component_info/widgets/registry.ts';
import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { resolveCellItems } from '../../src/core/resolve/relation_list.ts';
import { runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import { runWithRequestContext } from '../../src/core/security/request_context.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import type { ToolActionContext, ToolResponse } from '../../src/core/tools/module.ts';
import { clearTermCache } from '../../src/core/ts_object/term_resolver.ts';
import {
	type ExportSegment,
	type GridAtom,
	stripReferencesSegment,
} from '../../src/diffusion/export/atoms.ts';
import { joinExportAtoms } from '../../src/diffusion/export/join_atoms.ts';
import { toolExportGetExportGrid } from '../../tools/tool_export/server/tool_export.ts';
import { countActivityRows, sweepActivityRows } from '../helpers/activity_rows.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import {
	clearFrontierIdentityCaches,
	exportFrontierIdentity,
	type FrontierGrant,
} from '../helpers/export_frontier_identity.ts';
import { hostColumnDisplayedValues, hostSectionReadItems } from '../helpers/host_section_read.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

registerSessionCleanup();

const LANG = 'lg-eng';
const TABLE = 'matrix_test';
const REFUSAL = 'perm.export_column_out_of_scope';

const W = 'zzxw1';
const W_FILTER = 'zzxw2';
const W_LABEL = 'zzxw3';
const INFO = 'zzxw4';
const J = 'zzxw10';
const J_FILTER = 'zzxw11';
const REL_J = 'zzxw12';
const W_PORTAL = 'zzxw5';
const SUM = 'zzxw6';
const DATES = 'zzxw20';
const DATES_FILTER = 'zzxw21';
const DATE_IN = 'zzxw22';
const DATE_OUT = 'zzxw23';
const BIDI = 'zzxw7';

const TERM = {
	W: 'zz xw host',
	INFO: 'zz xw info',
	SUM: 'zz xw sum dates',
	REL_J: 'zz xw injected',
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
	name: 'tool_export component_info',
	tld: 'zzxw',
	nodes: [
		section(W, TERM.W),
		filter(W_FILTER, W),
		{
			tipo: W_LABEL,
			parent: W,
			model: 'component_input_text',
			term: term('zz xw label'),
			is_translatable: true,
		},
		{
			tipo: INFO,
			parent: W,
			model: 'component_info',
			term: term(TERM.INFO),
			properties: {
				widgets: [
					{
						widget_name: 'test_info',
						path: '/test/test_info',
						ipo: [
							{
								input: {
									type: 'component_data',
									source: [
										{ section_id: 'current', section_tipo: 'current', component_tipo: W_LABEL },
									],
								},
								output: [{ id: 'zz_value' }, { id: 'parents' }, { id: 'references' }],
								process: {},
							},
						],
					},
				],
			},
		},
		{
			tipo: W_PORTAL,
			parent: W,
			model: 'component_portal',
			term: term('zz xw spans'),
			properties: requestConfig(DATES, [DATE_IN]),
		},
		{
			// a widget WITH a get_data_parsed face: its raw items are
			// DateInterval objects, its parsed face the humanized text
			tipo: SUM,
			parent: W,
			model: 'component_info',
			term: term(TERM.SUM),
			properties: {
				widgets: [
					{
						widget_name: 'sum_dates',
						path: '/mdcat/sum_dates',
						ipo: [
							{
								input: [
									{ type: 'source', section_tipo: 'self', component_tipo: W_PORTAL },
									{ type: 'date_in', section_tipo: 'current', component_tipo: DATE_IN },
									{ type: 'date_out', section_tipo: 'current', component_tipo: DATE_OUT },
								],
								output: [{ id: 'sum_intervals' }],
							},
						],
					},
				],
			},
		},
		{
			// dd467 bidirectional: W#2 → W#1 makes W#2 a CALCULATED (D4
			// `#references`) relation of W#1, shown through INFO
			tipo: BIDI,
			parent: W,
			model: 'component_relation_related',
			term: term('zz xw related'),
			properties: {
				...requestConfig(W, [INFO]),
				config_relation: { relation_type: 'dd89', relation_type_rel: 'dd467' },
			},
		},
		section(DATES, 'zz xw dates'),
		filter(DATES_FILTER, DATES),
		{ tipo: DATE_IN, parent: DATES, model: 'component_date', term: term('zz xw date in') },
		{ tipo: DATE_OUT, parent: DATES, model: 'component_date', term: term('zz xw date out') },
		{
			...section(J, 'zz xw injecting host'),
			properties: {
				source: {
					request_config: [
						{
							sqo: { section_tipo: [{ source: 'self' }] },
							show: {
								ddo_map: [
									{ tipo: REL_J, parent: 'self', section_tipo: 'self' },
									{ tipo: W_LABEL, parent: REL_J, section_tipo: W },
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
			properties: requestConfig(W, [W_LABEL, INFO]),
		},
	],
});

const identity = exportFrontierIdentity('tool_export_info', 934700);

/** The persona: W + its label and info, J + REL_J. */
const SCOPED_GRANTS: FrontierGrant[] = [
	{ sectionTipo: W, tipo: W, level: 2 },
	{ sectionTipo: W, tipo: W_LABEL, level: 1 },
	{ sectionTipo: W, tipo: INFO, level: 1 },
	{ sectionTipo: J, tipo: J, level: 2 },
	{ sectionTipo: J, tipo: REL_J, level: 2 },
];

const ADMIN_GRANTS: FrontierGrant[] = S.nodes.flatMap((node) => {
	if (node.model === 'section') return [{ sectionTipo: node.tipo, tipo: node.tipo, level: 3 }];
	if (node.parent === null) throw new Error(`situation node ${node.tipo} has no parent section`);
	return [{ sectionTipo: node.parent, tipo: node.tipo, level: 3 }];
});

const STALE = 'zzSTALE';

async function writeRecord(
	sectionTipo: string,
	sectionId: number,
	filterTipo: string,
	project: number,
	relation: Record<string, unknown> = {},
	string: Record<string, unknown> = {},
	misc: Record<string, unknown> | null = null,
): Promise<void> {
	await sql.unsafe(`DELETE FROM ${TABLE} WHERE section_tipo = $1 AND section_id = $2`, [
		sectionTipo,
		sectionId,
	]);
	await sql.unsafe(
		`INSERT INTO ${TABLE} (section_tipo, section_id, relation, string, misc, data)
		 VALUES ($1, $2, $3::text::jsonb, $4::text::jsonb, $5::text::jsonb, $6::text::jsonb)`,
		[
			sectionTipo,
			sectionId,
			encodeForJsonb({ [filterTipo]: [identity.filterLocator(filterTipo, project)], ...relation }),
			encodeForJsonb(string),
			misc === null ? null : encodeForJsonb(misc),
			encodeForJsonb({ section_tipo: sectionTipo, section_id: sectionId }),
		],
	);
	clearTermCache();
}

const SECTIONS = [W, J, DATES];

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
	const label = (value: string) => ({ [W_LABEL]: [{ id: 1, lang: LANG, value }] });
	// PHP-era residue no engine door authors: planted raw, so the export can
	// prove it never ships it
	const staleMisc = {
		[INFO]: [{ widget: 'test_info', key: 0, id: 'zz_value', value: STALE }],
	};
	// W#1 spans D#1: 2020-01-01 → 2020-03-16 (sum_dates: 2 months 15 days)
	await writeRecord(
		W,
		1,
		W_FILTER,
		identity.myProject,
		{
			[W_PORTAL]: [
				{ id: 1, type: 'dd151', section_tipo: DATES, section_id: 1, from_component_tipo: W_PORTAL },
			],
		},
		label('zz xw one'),
		staleMisc,
	);
	await writeRecord(DATES, 1, DATES_FILTER, identity.myProject);
	await sql.unsafe(
		`UPDATE ${TABLE} SET date = $1::text::jsonb WHERE section_tipo = $2 AND section_id = 1`,
		[
			encodeForJsonb({
				[DATE_IN]: [{ id: 1, start: { year: 2020, month: 1, day: 1 } }],
				[DATE_OUT]: [{ id: 1, start: { year: 2020, month: 3, day: 16 } }],
			}),
			DATES,
		],
	);
	await writeRecord(W, 2, W_FILTER, identity.myProject, {
		[BIDI]: [{ id: 1, type: 'dd89', section_tipo: W, section_id: 1, from_component_tipo: BIDI }],
	});
	await writeRecord(W, 5, W_FILTER, identity.otherProject, {}, label('zz xw five'));
	await writeRecord(J, 1, J_FILTER, identity.myProject, {
		[REL_J]: [{ id: 1, type: 'dd151', section_tipo: W, section_id: 5, from_component_tipo: REL_J }],
	});
}

type Grid = { columns?: Record<string, unknown>[]; rows?: Record<string, unknown>[] };

const contextOf = (options: Record<string, unknown>, principal: Principal): ToolActionContext =>
	({ principal, userId: principal.userId, options, background: false }) as ToolActionContext;

function exportOptions(
	dataFormat: 'value' | 'grid_value' | 'dedalo_raw',
	ids: number[],
	path: { section_tipo: string; component_tipo: string }[] = [
		{ section_tipo: W, component_tipo: INFO },
	],
	host = W,
	ddo: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		section_tipo: host,
		model: 'section',
		lang: LANG,
		data_format: dataFormat,
		breakdown: 'default',
		fill_the_gaps: false,
		ar_ddo_to_export: [{ path, ...ddo }],
		sqo: {
			section_tipo: [host],
			limit: 10,
			offset: 0,
			filter_by_locators: ids.map((id) => ({ section_tipo: host, section_id: String(id) })),
		},
	};
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

async function gridOf(principal: Principal, options: Record<string, unknown>): Promise<Grid> {
	const answer = await answerOf(principal, options);
	expect(answer.startsWith('OK:'), answer).toBe(true);
	const grid = JSON.parse(answer.slice(3)) as Grid;
	expect(Array.isArray(grid.columns), 'the export answered no columns line').toBe(true);
	// floor: the export walked records (an empty selection would pass every case)
	expect((grid.rows ?? []).length).toBeGreaterThan(0);
	return grid;
}

/** The grid as `rec#sub → {column key → cell}`. */
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

const TOP = `${W}_${INFO}`;
const PLACEHOLDER = `test_info widget value for section ${W} - 2`;

describe.if(DB_READY)('tool_export exports component_info (live widget outputs)', () => {
	beforeAll(async () => {
		await assertTestDatabase('tool_export_info_native');
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

	test('value: one column, every output live (the stored misc never ships)', async () => {
		for (const persona of [identity.admin, identity.scoped]) {
			const grid = await gridOf(persona, exportOptions('value', [1, 2]));
			expect(keysOf(grid)).toEqual([TOP]);
			expect(grid.columns?.[0]?.label).toBe(TERM.INFO);
			const cells = cellsByKey(grid);
			// zz_value + parents + references — info outputs, NOT the WC-049
			// mirror nor the D4 references column — joined in the own cell
			expect(cells['1#0']).toEqual({ [TOP]: 'zz xw one, zz xw one, zz xw one' });
			expect(cells['2#0']).toEqual({
				[TOP]: `${PLACEHOLDER}, ${PLACEHOLDER}, ${PLACEHOLDER}`,
			});
			expect(JSON.stringify(grid)).not.toContain(STALE);
		}
	});

	test('grid_value: one column per declared output under its sub_id', async () => {
		const grid = await gridOf(identity.admin, exportOptions('grid_value', [1, 2]));
		// PHP key shape: the own segment's identity, then the output sub-segment's
		const value = `${TOP}.${TOP}#zz_value`;
		const parents = `${TOP}.${TOP}#parents`;
		const references = `${TOP}.${TOP}#references`;
		expect(keysOf(grid)).toEqual([parents, references, value]);
		expect(cellsByKey(grid)).toEqual({
			'1#0': { [value]: 'zz xw one', [parents]: 'zz xw one', [references]: 'zz xw one' },
			'2#0': { [value]: PLACEHOLDER, [parents]: PLACEHOLDER, [references]: PLACEHOLDER },
		});
		const labelOf = new Map((grid.columns ?? []).map((c) => [String(c.key), c.label]));
		expect(labelOf.get(value)).toBe(`${TERM.INFO} | zz_value`);
		expect(JSON.stringify(grid)).not.toContain(STALE);
	});

	test('dedalo_raw: the live computed items, never the stored slot', async () => {
		const grid = await gridOf(identity.admin, exportOptions('dedalo_raw', [1]));
		const cells = cellsByKey(grid);
		const raw = Object.values(cells['1#0'] ?? {}).find((cell) => cell.includes('dedalo_data'));
		expect(raw).toBeDefined();
		const parsed = JSON.parse(raw as string) as { dedalo_data: Record<string, unknown>[] };
		expect(parsed.dedalo_data.map((item) => [item.id, item.value])).toEqual([
			['zz_value', 'zz xw one'],
			['parents', 'zz xw one'],
			['references', 'zz xw one'],
		]);
		expect(raw).not.toContain(STALE);
	});

	test('panel: resolveCellItems answers every output value (request-path flat reader)', async () => {
		const unresolved: string[] = [];
		const items = await runWithRequestContext(
			{ principal: identity.admin, session: null, requestId: 'zzxw-panel', clientIp: '127.0.0.1' },
			() =>
				runWithRequestLangs({ applicationLang: LANG, dataLang: LANG }, () =>
					resolveCellItems(W, 1, INFO, LANG, unresolved),
				),
		);
		expect(items).toEqual(['zz xw one', 'zz xw one', 'zz xw one']);
		expect(unresolved).toEqual([]);
	});

	test('D4: a displayed record read for its component_info the read does NOT show → THROWS', async () => {
		const items = await hostSectionReadItems(identity.scoped, J, 1, LANG, 'zzxw-d4');
		expect(hostColumnDisplayedValues(items, REL_J, J, 1)).toEqual(['zz xw five']);
		const path = [{ section_tipo: J, component_tipo: REL_J }];
		for (const format of ['value', 'grid_value'] as const) {
			expect(await answerOf(identity.scoped, exportOptions(format, [1], path, J))).toBe(
				`REFUSED:${REFUSAL}:${JSON.stringify({ column: TERM.REL_J })}`,
			);
		}
		// non-vacuity: the column's own config DOES reach W#5's info value —
		// pinned BY ITS OUTPUTS, never by the bare string (W_LABEL, an item of
		// the same REL_J config, also answers 'zz xw five')
		const top = `${J}_${REL_J}`;
		const valueGrid = await gridOf(identity.admin, exportOptions('value', [1], path, J));
		// W_LABEL + the three info outputs, joined in the one column
		expect(cellsByKey(valueGrid)).toEqual({
			'1#0': { [top]: 'zz xw five, zz xw five, zz xw five, zz xw five' },
		});
		const grid = await gridOf(identity.admin, exportOptions('grid_value', [1], path, J));
		const info = `${top}.${W}_${INFO}.${W}_${INFO}`;
		expect(cellsByKey(grid)).toEqual({
			'1#0': {
				[`${top}.${W}_${W_LABEL}`]: 'zz xw five',
				[`${info}#zz_value`]: 'zz xw five',
				[`${info}#parents`]: 'zz xw five',
				[`${info}#references`]: 'zz xw five',
			},
		});
	});

	test('D4 #references: a calculated record shows its info outputs (an output named references stays an info column)', async () => {
		// W#2 stores BIDI → W#1, so W#2 is W#1's CALCULATED relation (dd467)
		const path = [{ section_tipo: W, component_tipo: BIDI }];
		const ddo = { value_with_references: true };
		const top = `${W}_${BIDI}`;
		const W2 = `test_info widget value for section ${W} - 2`;
		const value = cellsByKey(
			await gridOf(identity.admin, exportOptions('value', [1], path, W, ddo)),
		);
		expect(value).toEqual({ '1#0': { [`${top}#references`]: `${W2}, ${W2}, ${W2}` } });
		const grid = cellsByKey(
			await gridOf(identity.admin, exportOptions('grid_value', [1], path, W, ddo)),
		);
		const info = `${top}.${top}#references.${W}_${INFO}.${W}_${INFO}`;
		expect(grid).toEqual({
			'1#0': {
				[`${info}#zz_value`]: W2,
				[`${info}#parents`]: W2,
				[`${info}#references`]: W2,
			},
		});
	});

	test('parsed: the export ships the widget get_data_parsed face (sum_dates humanized)', async () => {
		const top = `${W}_${SUM}`;
		const path = [{ section_tipo: W, component_tipo: SUM }];
		for (const format of ['value', 'grid_value'] as const) {
			const cells = cellsByKey(await gridOf(identity.admin, exportOptions(format, [1], path)));
			const key = format === 'value' ? top : `${top}.${top}#sum_intervals`;
			expect(Object.keys(cells['1#0'] ?? {})).toEqual([key]);
			// D#1 2020-01-01 → 2020-03-16, humanized with the localized labels —
			// the raw face would ship the JSON-encoded DateInterval ({"y":0,…})
			expect(cells['1#0']?.[key]).toMatch(/^2 \S+ 15 \S+$/);
		}
	});

	test('widgetComputeDataParsed: the get_data_parsed face, else computeData', () => {
		const sumDates = getInfoWidget('sum_dates');
		const testInfo = getInfoWidget('test_info');
		if ('unported' in sumDates || 'unported' in testInfo) throw new Error('widgets unported');
		expect(widgetComputeDataParsed(sumDates)).toBe(sumDates.computeDataParsed as never);
		expect(widgetComputeDataParsed(testInfo)).toBe(testInfo.computeData);
	});
});

describe('#references strip keeps an info output named references (pure fold)', () => {
	const segment = (component: string, extra: Partial<ExportSegment> = {}): ExportSegment => ({
		section_tipo: W,
		component_tipo: component,
		model: null,
		item_index: null,
		section_id: null,
		...extra,
	});
	// a MULTI-valued output under an info segment with its own separator — the
	// only shape in which dropping the output segment changes the fold
	const infoSegment = segment(INFO, {
		model: 'component_info',
		item_index: 0,
		fields_separator: ' ; ',
	});
	const atomsUnder = (prefix: ExportSegment[]): GridAtom[] =>
		[
			['zz_value', 'a'],
			['zz_value', 'b'],
			['references', 'c'],
		].map(([sub, value]) => ({
			value: value as string,
			cellType: 'text',
			model: 'component_info',
			segments: [...prefix, infoSegment, segment(INFO, { sub_id: sub as string })],
		}));

	test('the #references fold equals the main cell fold', () => {
		const relation = segment(BIDI, { model: 'component_relation_related' });
		const main = joinExportAtoms(atomsUnder([relation]));
		expect(main).toBe('a, b ; c');
		const references = atomsUnder([relation, segment(BIDI, { sub_id: 'references' })]);
		expect(joinExportAtoms(references.map(stripReferencesSegment))).toBe(main);
	});
});
