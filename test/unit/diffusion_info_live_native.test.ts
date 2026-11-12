/**
 * component_info PUBLISHES ITS LIVE WIDGET VALUE (T1-2 / O09 O13 OX6).
 * Wire: WC-2026-11-12-info-live-publication-export (+ the WC-2026-09-03
 * addendum: the stored `misc` slot is never published either).
 *
 * THE DEFECT THIS PINS. The diffusion component step read every non-relation
 * model through defaultPublicationValue → readComponentItems, i.e. the STORED
 * slice. For component_info that is the `misc` column — which the read never
 * serves (WC-2026-09-03) — and the generic branch then unwrapped each stored
 * `{widget,id,value}` entry to its bare scalar, so `parser_info::widget`
 * (which matches on `widget` + `id|widget_id`) matched NOTHING: every
 * parser_info::widget column published NULL on every record, whatever misc
 * held. PHP component_info::get_diffusion_data publishes `get_data()` — the
 * LIVE widget compute — one item per widget output, value = the whole item.
 *
 * THE CONTRACT pinned here:
 *   live      the published value is what the widget computes for THIS record
 *             now (test212 → test_info reads test52 of the current record);
 *   stale     a stored misc value (PHP-era residue, planted raw — no engine
 *             door authors it) is NEVER published;
 *   compute   the placeholder value proves the compute ran with the record's
 *             own section context (no test52 on the record);
 *   memo      two fields over the same info component compute ONCE per record
 *             per run (`diffusion_info_widget_compute`);
 *   refusal   defaultPublicationValue refuses component_info outright
 *             (internal.invariant) — no caller may publish the stored slice.
 *
 * WHY THIS FAILS ON THE OLD BEHAVIOUR: cases 1-4 publish NULL on HEAD (the
 * unwrapped scalars never match the parser), case 5 returned atoms.
 *
 * Scratch: matrix_test / test3, own id subrange 931300-931399, fail-loud
 * empty-before / clean-after (matrix_test + matrix_time_machine).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { getCounters } from '../../src/core/api/counters.ts';
import { type MatrixRecord, readMatrixRecord } from '../../src/core/db/matrix.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { isDedaloError } from '../../src/core/errors/index.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import type { FieldPlan, PublicationPlan } from '../../src/diffusion/plan/types.ts';
import { defaultPublicationValue } from '../../src/diffusion/resolve/default_value.ts';
import type { ResolvedBatch } from '../../src/diffusion/resolve/resolver.ts';
import { resolvePublication } from '../../src/diffusion/resolve/resolver.ts';
import { DB_READY } from '../helpers/db_ready.ts';

const SECTION_TIPO = 'test3';
const ID_MIN = 931300;
const ID_MAX = 931399;
const R_STALE = 931301; // test52 + a planted stale misc value
const R_FRESH = 931302; // test52, no misc
const R_EMPTY = 931303; // no test52: the widget's placeholder
const INFO = 'test212';
const RUN_STARTED_AT = 1_754_900_000;
const COUNTER = 'diffusion_info_widget_compute';

const PUB_YES = {
	id: 1,
	type: 'dd151',
	section_id: '1',
	section_tipo: 'dd64',
	from_component_tipo: 'test92',
};

async function cleanScratch(): Promise<void> {
	await sql`DELETE FROM matrix_test
	          WHERE section_tipo = ${SECTION_TIPO} AND section_id BETWEEN ${ID_MIN} AND ${ID_MAX}`;
	await sql`DELETE FROM matrix_time_machine
	          WHERE section_tipo = ${SECTION_TIPO} AND section_id BETWEEN ${ID_MIN} AND ${ID_MAX}`;
}

async function scratchResidue(): Promise<number> {
	const [m] = (await sql`SELECT count(*)::int AS n FROM matrix_test
		WHERE section_tipo = ${SECTION_TIPO} AND section_id BETWEEN ${ID_MIN} AND ${ID_MAX}`) as {
		n: number;
	}[];
	const [tm] = (await sql`SELECT count(*)::int AS n FROM matrix_time_machine
		WHERE section_tipo = ${SECTION_TIPO} AND section_id BETWEEN ${ID_MIN} AND ${ID_MAX}`) as {
		n: number;
	}[];
	return (m?.n ?? 0) + (tm?.n ?? 0);
}

async function seedRecord(
	sectionId: number,
	text: string | null,
	misc: Record<string, unknown> | null,
): Promise<void> {
	const stringColumn = text === null ? {} : { test52: [{ id: 1, lang: 'lg-eng', value: text }] };
	await sql.unsafe(
		`INSERT INTO matrix_test (section_tipo, section_id, relation, string, misc)
		 VALUES ($1, $2, $3::text::jsonb, $4::text::jsonb, $5::text::jsonb)`,
		[
			SECTION_TIPO,
			sectionId,
			JSON.stringify({ test92: [PUB_YES] }),
			JSON.stringify(stringColumn),
			misc === null ? null : JSON.stringify(misc),
		],
	);
}

/** One parser_info::widget field selecting `select` of the test_info widget. */
function infoField(id: string, select: string): FieldPlan {
	return {
		id,
		columnName: id,
		sourceChain: [
			{ kind: 'component', tipo: INFO, model: 'component_info', sectionTipo: SECTION_TIPO },
		],
		transform: [
			{
				fn: 'parser_info::widget',
				options: { widget_name: ['test_info'], select: [select], keys: [0] },
			},
		],
		column: { fieldModel: 'field_text' },
		policy: {},
	} as FieldPlan;
}

function planOf(fields: FieldPlan[]): PublicationPlan {
	return {
		planId: 'test-info-live',
		elementTipo: 'test_element',
		format: 'sql',
		serviceName: null,
		target: { kind: 'table', database: 'scratch_unused' },
		sections: [
			{
				sectionTipo: SECTION_TIPO,
				tableName: 'scratch_unused',
				tableTipo: 'test_table_node',
				fields,
			},
		],
		recursion: { maxLevels: 0 },
		langPolicy: { langs: ['lg-eng'], mainLang: 'lg-eng' },
		warnings: [],
	};
}

async function publish(plan: PublicationPlan, ids: number[]): Promise<ResolvedBatch[]> {
	const batches: ResolvedBatch[] = [];
	for await (const batch of resolvePublication(plan, {
		sectionTipo: SECTION_TIPO,
		runStartedAt: RUN_STARTED_AT,
		sqo: {
			section_tipo: SECTION_TIPO,
			filter_by_locators: ids.map((id) => ({ section_tipo: SECTION_TIPO, section_id: String(id) })),
		},
		maxLevels: 0,
	})) {
		batches.push(batch);
	}
	return batches;
}

/** section_id → {column → value} of the published rows (one lang). */
function columnsById(batches: ResolvedBatch[]): Record<string, Record<string, string | null>> {
	const out: Record<string, Record<string, string | null>> = {};
	// floor: the run published rows (an empty selection would pass every case)
	expect(batches.flatMap((batch) => batch.rows).length).toBeGreaterThan(0);
	for (const batch of batches) {
		expect(batch.errors).toEqual([]);
		for (const row of batch.rows) out[String(row.sectionId)] = row.columns;
	}
	return out;
}

describe.if(DB_READY)('diffusion publishes component_info from the LIVE widget compute', () => {
	beforeAll(async () => {
		await assertTestDatabase('diffusion_info_live_native');
		const nodes = (await sql`
			SELECT tipo, model FROM dd_ontology WHERE tipo IN ('test212', 'test52', 'test92')
		`) as { tipo: string; model: string }[];
		const modelOf = new Map(nodes.map((node) => [node.tipo, node.model]));
		for (const [tipo, model] of [
			['test212', 'component_info'],
			['test52', 'component_input_text'],
			['test92', 'component_publication'],
		] as const) {
			if (modelOf.get(tipo) !== model) {
				throw new Error(`fixture ontology drifted: ${tipo} should be ${model}`);
			}
		}
		const residue = await scratchResidue();
		if (residue > 0) throw new Error(`scratch surface not empty before seeding: ${residue}`);
		await seedRecord(R_STALE, 'zzinfo live', {
			[INFO]: [{ widget: 'test_info', key: 0, id: 'test_value', value: 'zzSTALE' }],
		});
		await seedRecord(R_FRESH, 'zzinfo fresh', null);
		await seedRecord(R_EMPTY, null, null);
	});

	afterAll(async () => {
		await cleanScratch();
		expect(await scratchResidue()).toBe(0);
	});

	test('a stored misc value is never published; the live compute is', async () => {
		const columns = columnsById(await publish(planOf([infoField('val', 'test_value')]), [R_STALE]));
		expect(columns[String(R_STALE)]?.val).toBe('zzinfo live');
		expect(JSON.stringify(columns)).not.toContain('zzSTALE');
	});

	test('a record with no misc publishes its live value', async () => {
		const columns = columnsById(await publish(planOf([infoField('val', 'test_value')]), [R_FRESH]));
		expect(columns[String(R_FRESH)]?.val).toBe('zzinfo fresh');
	});

	test('the compute runs in the record context (widget placeholder when test52 is empty)', async () => {
		const columns = columnsById(await publish(planOf([infoField('val', 'test_value')]), [R_EMPTY]));
		expect(columns[String(R_EMPTY)]?.val).toBe(
			`test_info widget value for section ${SECTION_TIPO} - ${R_EMPTY}`,
		);
	});

	test('two fields over one info component: both published, ONE compute per record', async () => {
		const before = getCounters()[COUNTER] ?? 0;
		const columns = columnsById(
			await publish(planOf([infoField('val', 'test_value'), infoField('lab', 'test_label')]), [
				R_STALE,
				R_FRESH,
			]),
		);
		expect(columns[String(R_STALE)]).toEqual({ val: 'zzinfo live', lab: 'zzinfo live' });
		expect(columns[String(R_FRESH)]).toEqual({ val: 'zzinfo fresh', lab: 'zzinfo fresh' });
		expect((getCounters()[COUNTER] ?? 0) - before).toBe(2);
	});

	test('defaultPublicationValue refuses component_info (the stored slice is never published)', async () => {
		const record = await readMatrixRecord('matrix_test', SECTION_TIPO, R_STALE);
		expect(record?.columns.misc).toBeDefined(); // the stale slot IS there to publish
		let caught: unknown = null;
		try {
			defaultPublicationValue(record as MatrixRecord, INFO, 'component_info', { tipo: INFO });
		} catch (error) {
			caught = error;
		}
		expect(isDedaloError(caught)).toBe(true);
		expect((caught as { code?: string }).code).toBe('internal.invariant');
	});
});
