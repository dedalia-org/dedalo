/**
 * R3 (owner ruling 2026-11-22) — EXCLUDE_DIFFUSION_ELEMENTS, ported: a
 * tool_diffusion config key that (1) hides the excluded elements' panels from
 * `get_diffusion_info` and (2) REFUSES a publication to them at the `diffuse`
 * server door; the v6 define is MOVED into that key by the config migration.
 * Source: src/diffusion/api/excluded_elements.ts, info.ts, actions.ts;
 * src/core/tools/tool_config_move.ts; src/config/migration_map.ts TOOL_CONFIG.
 *
 * THE SITUATION IS BUILT: the generic zzdif diffusion domain (its own dd1190
 * domain, elements and the zzdif1 section — test/helpers/zzdif_diffusion_domain.ts,
 * torn down with a zero-residue assertion), a scratch Tools-configuration
 * record (test/helpers/tool_config_fixture.ts) for the list, and the
 * migration's own dd996 record, swept by its id. The publication that must WORK
 * runs in the runner's stub mode (no plan compile, no target write) and is
 * cancelled and settled before its row is purged.
 *
 * Legs:
 *   A. info: zzdif80 listed → its panel is absent; zzdif42 (not listed) stays.
 *      Control: with no list, both are present (floor).
 *   B. door: diffuse to zzdif80 refuses `diffusion.element_excluded` and queues
 *      nothing; diffuse to zzdif42 is queued.
 *   C. alias: an alias whose REAL element is listed is excluded — at the panel
 *      selection and at the door's resolution (pure, synthetic tree).
 *   D. a malformed list REFUSES (request.invalid_options) — never "nothing excluded".
 *   E. migration: a v6 config's define is planned as a TOOL_CONFIG move and the
 *      move lands where the reader reads (created / kept / written / empty).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { planToolConfigMoves, V6_MIGRATION } from '../../src/config/migration_map.ts';
import { extractDefines } from '../../src/config/php_defines.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import { type Principal, resolvePrincipal } from '../../src/core/security/permissions.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { resetConfigCache } from '../../src/core/tools/config.ts';
import { moveValueIntoToolConfig } from '../../src/core/tools/tool_config_move.ts';
import { diffuseAction } from '../../src/diffusion/api/actions.ts';
import {
	assertElementNotExcluded,
	EXCLUSION_KEY,
	EXCLUSION_TOOL,
	elementRealTipo,
	excludedDiffusionElements,
} from '../../src/diffusion/api/excluded_elements.ts';
import { buildDiffusionInfo, selectPublishablePanelNodes } from '../../src/diffusion/api/info.ts';
import {
	deleteJobsForTests,
	getJobByClientProcessId,
	getJobById,
	requestCancel,
} from '../../src/diffusion/jobs/queue.ts';
import { DIFFUSION_JOBS_TABLE } from '../../src/diffusion/jobs/schema.ts';
import type { VirtualTreeNode } from '../../src/diffusion/plan/virtual_tree.ts';
import { countActivityRows, sweepActivityRows } from '../helpers/activity_rows.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import { ensureDiffusionScratchTables } from '../helpers/diffusion_scratch_tables.ts';
import { withScratchToolConfig } from '../helpers/tool_config_fixture.ts';
import {
	dropZzdifDomain,
	ensureZzdifDomain,
	ZZDIF_DOMAIN_NAME,
	ZZDIF_ELEMENT,
	ZZDIF_FILE_ELEMENT,
	ZZDIF_SECTION,
} from '../helpers/zzdif_diffusion_domain.ts';

const EXCLUDED = ZZDIF_FILE_ELEMENT; // zzdif80
const INCLUDED = ZZDIF_ELEMENT; // zzdif42
const createdJobIds: string[] = [];

/** The element tipos owning the panels `get_diffusion_info` returns for zzdif1. */
async function panelElements(): Promise<string[]> {
	const info = await buildDiffusionInfo(ZZDIF_SECTION, ZZDIF_DOMAIN_NAME);
	return info.section_diffusion_nodes.flatMap((node) =>
		node.parents
			.filter((item) => item.model === 'diffusion_element')
			.slice(0, 1)
			.map((item) => item.tipo),
	);
}

/** dd996 records that name tool_diffusion (a census: beforeAll proves it starts empty). */
async function diffusionConfigRecords(): Promise<number[]> {
	const rows = (await sql`
		SELECT section_id FROM matrix_tools
		WHERE section_tipo = 'dd996' AND string->'dd1326' @> ${JSON.stringify([{ value: EXCLUSION_TOOL }])}::text::jsonb
		ORDER BY section_id`) as { section_id: number }[];
	return rows.map((row) => Number(row.section_id));
}

/**
 * The dd996 records THIS FILE wrote through the engine's doors (the migration's
 * own records, and the scratch fixture's id once a save audited it). Only these
 * are swept and only these are residue-asserted — never the whole dd996 section,
 * which is install-global state another gate (or a person) may own.
 */
const touchedConfigIds = new Set<number>();

/** Track `ids` as written by this file (swept and residue-asserted by id). */
function track(ids: readonly number[]): void {
	for (const id of ids) touchedConfigIds.add(id);
}

/** Sweep the tracked dd996 records, their TM and activity rows — by id, nothing else. */
async function sweepTrackedConfigRecords(): Promise<void> {
	await assertTestDatabase('diffusion_excluded_elements_native sweep');
	const ids = [...touchedConfigIds];
	for (const id of ids) {
		await sql`DELETE FROM matrix_time_machine WHERE section_tipo = 'dd996' AND section_id = ${id}`;
		await sql`DELETE FROM matrix_tools WHERE section_tipo = 'dd996' AND section_id = ${id}`;
	}
	await sweepActivityRows('dd996', ids);
	resetConfigCache();
}

/** TM rows left on the tracked dd996 records. */
async function trackedTimeMachineRows(): Promise<number> {
	const ids = [...touchedConfigIds];
	if (ids.length === 0) return 0;
	const rows = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM matrix_time_machine WHERE section_tipo = 'dd996' AND section_id = ANY(string_to_array($1, ',')::int[])`,
		[ids.join(',')],
	)) as { n: number }[];
	return rows[0]?.n ?? 0;
}

/** Jobs queued for `element` since `since` (the table, not a label another gate may reuse). */
async function jobsQueuedSince(element: string, since: Date): Promise<number> {
	const rows = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM "${DIFFUSION_JOBS_TABLE}" WHERE spec->>'diffusion_element_tipo' = $1 AND created_at >= $2`,
		[element, since],
	)) as { n: number }[];
	return rows[0]?.n ?? 0;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Wait until a cancelled job is terminal AND any runner it spawned has exited. */
async function settled(jobId: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const row = await getJobById(jobId);
		const terminal = row === null || (row.state !== 'queued' && row.state !== 'running');
		const claimed = row?.runner.host !== undefined;
		const pid = row?.runner.pid;
		if (terminal && (!claimed || (pid !== undefined && !alive(pid)))) return;
		if (Date.now() > deadline) throw new Error(`diffusion job ${jobId} did not settle`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

/** One `diffuse` request for zzdif1 → `element`, stub mode. Answers the thrown refusal or the queued job id. */
async function diffuse(
	principal: Principal,
	element: string,
): Promise<{ refused: unknown } | { jobId: string }> {
	const label = `process_diffusion_${principal.userId}_${element}_${ZZDIF_SECTION}`;
	let result: Awaited<ReturnType<typeof diffuseAction>>;
	try {
		result = await diffuseAction(
			{
				action: 'diffuse',
				dd_api: 'dd_diffusion_api',
				source: { section_tipo: ZZDIF_SECTION },
				sqo: { section_tipo: [ZZDIF_SECTION], limit: 1 },
				options: {
					type: 'sql',
					diffusion_element_tipo: element,
					total: 1,
					process_id: label,
					stub_run: true,
				},
			} as never,
			principal,
		);
	} catch (error) {
		return { refused: error };
	}
	void (result.stream as ReadableStream<Uint8Array>).cancel();
	const job = await getJobByClientProcessId(label, null);
	if (job === null) throw new Error(`diffuse queued no job for ${label}`);
	createdJobIds.push(job.job_id);
	await requestCancel(label, null);
	await settled(job.job_id);
	return { jobId: job.job_id };
}

/** A synthetic panel node under one element path item (alias or real). */
function panelNode(
	tipo: string,
	element: { tipo: string; model: string; realTipo: string | null },
): VirtualTreeNode {
	return {
		tipo,
		model: 'table',
		label: tipo,
		properties: null,
		realTipo: null,
		isAlias: false,
		parents: [
			{ tipo: element.tipo, model: element.model, label: null, realTipo: element.realTipo },
		],
		relatedSections: ['zzsec1'],
		childrenTipos: [],
	} as unknown as VirtualTreeNode;
}

describe.if(DB_READY)('R3 — EXCLUDE_DIFFUSION_ELEMENTS (tool_diffusion config)', () => {
	let root: Principal;

	beforeAll(async () => {
		await assertTestDatabase('diffusion_excluded_elements_native');
		await ensureZzdifDomain();
		await ensureDiffusionScratchTables();
		// A dd996 record already configuring tool_diffusion is someone else's
		// state: REFUSE, never delete it (the census below would also misread it).
		const preexisting = await diffusionConfigRecords();
		if (preexisting.length > 0) {
			throw new Error(
				`diffusion_excluded_elements_native: dd996 record(s) ${preexisting.join(', ')} already configure '${EXCLUSION_TOOL}' in the suite database — this gate would read and overwrite them. Remove them, then run again. Nothing was written.`,
			);
		}
		root = await resolvePrincipal(-1);
	});
	afterAll(async () => {
		await deleteJobsForTests(createdJobIds);
		await sweepTrackedConfigRecords();
		// Residue, BY ID: no record, TM row or activity row this file wrote.
		expect(await diffusionConfigRecords()).toHaveLength(0);
		expect(await trackedTimeMachineRows()).toBe(0);
		expect(await countActivityRows('dd996', [...touchedConfigIds])).toBe(0);
		expect(await dropZzdifDomain()).toBe(0);
	});

	test('floor: no list configured → no exclusion, and both elements panel for zzdif1', async () => {
		expect(await diffusionConfigRecords()).toHaveLength(0);
		expect((await excludedDiffusionElements()).size).toBe(0);
		const elements = await panelElements();
		expect(elements).toContain(EXCLUDED);
		expect(elements).toContain(INCLUDED);
	});

	test('A. info: the listed element has no panel; the other one stays', async () => {
		await withScratchToolConfig(EXCLUSION_TOOL, { [EXCLUSION_KEY]: [EXCLUDED] }, async () => {
			const elements = await panelElements();
			expect(elements).not.toContain(EXCLUDED);
			expect(elements).toContain(INCLUDED);
		});
	});

	test('A. the `{value}` option form is read too (install config shape)', async () => {
		await withScratchToolConfig(
			EXCLUSION_TOOL,
			{ [EXCLUSION_KEY]: { type: 'array', value: [EXCLUDED] } },
			async () => {
				expect([...(await excludedDiffusionElements())]).toEqual([EXCLUDED]);
			},
		);
	});

	test('B. door: diffuse to the listed element is REFUSED and queues nothing; the other is queued', async () => {
		await withScratchToolConfig(EXCLUSION_TOOL, { [EXCLUSION_KEY]: [EXCLUDED] }, async () => {
			const before = new Date();
			const refused = await diffuse(root, EXCLUDED);
			expect('refused' in refused).toBe(true);
			const error = (refused as { refused: unknown }).refused;
			expect(error).toBeInstanceOf(DedaloError);
			expect((error as DedaloError).code).toBe('diffusion.element_excluded');
			expect(await jobsQueuedSince(EXCLUDED, before)).toBe(0);

			const queued = await diffuse(root, INCLUDED);
			expect('jobId' in queued).toBe(true);
			// FLOOR: the count below DOES see a job this file queued.
			expect(await jobsQueuedSince(INCLUDED, before)).toBeGreaterThan(0);
		});
	});

	test('C. alias: an alias whose REAL element is listed is excluded (panel + door resolution)', () => {
		const excluded = new Set(['zzreal1']);
		const aliasPanel = panelNode('zztable1', {
			tipo: 'zzalias1',
			model: 'diffusion_element_alias',
			realTipo: 'zzreal1',
		});
		const otherPanel = panelNode('zztable2', {
			tipo: 'zzreal2',
			model: 'diffusion_element',
			realTipo: null,
		});
		const kept = selectPublishablePanelNodes([aliasPanel, otherPanel], 'zzsec1', excluded);
		expect(kept.map((node) => node.tipo)).toEqual(['zztable2']);

		const tree = {
			nodes: [
				{ ...aliasPanel, tipo: 'zzalias1', model: 'diffusion_element_alias', realTipo: 'zzreal1' },
				{ ...otherPanel, tipo: 'zzreal2', model: 'diffusion_element', realTipo: null },
			],
		};
		const realTipo = elementRealTipo(tree, 'zzalias1');
		expect(realTipo).toBe('zzreal1');
		expect(() => assertElementNotExcluded({ tipo: 'zzalias1', realTipo }, excluded)).toThrow(
			DedaloError,
		);
		expect(() =>
			assertElementNotExcluded(
				{ tipo: 'zzreal2', realTipo: elementRealTipo(tree, 'zzreal2') },
				excluded,
			),
		).not.toThrow();
	});

	test('D. a malformed list REFUSES — info and door both', async () => {
		for (const malformed of [EXCLUDED, [EXCLUDED, 7], [''], { tipo: EXCLUDED }]) {
			await withScratchToolConfig(EXCLUSION_TOOL, { [EXCLUSION_KEY]: malformed }, async () => {
				const label = JSON.stringify(malformed);
				const read = await excludedDiffusionElements().catch((error: unknown) => error);
				expect(read, label).toBeInstanceOf(DedaloError);
				expect((read as DedaloError).code, label).toBe('request.invalid_options');
				const info = await buildDiffusionInfo(ZZDIF_SECTION, ZZDIF_DOMAIN_NAME).catch(
					(error: unknown) => error,
				);
				expect(info, label).toBeInstanceOf(DedaloError);
				const door = await diffuse(root, INCLUDED);
				expect('refused' in door, label).toBe(true);
			});
		}
	});

	describe('E. the v6→v7 config migration MOVES the define', () => {
		const v6Config = (value: string) =>
			extractDefines([
				{
					path: 'config.php',
					content: `<?php\ndefine('EXCLUDE_DIFFUSION_ELEMENTS', ${value});\n`,
				},
			]).records;

		test('classified TOOL_CONFIG, and planned as a move into tool_diffusion', () => {
			expect(V6_MIGRATION.EXCLUDE_DIFFUSION_ELEMENTS?.cls).toBe('TOOL_CONFIG');
			const plan = planToolConfigMoves(v6Config(`['${EXCLUDED}']`));
			expect(plan.runtime).toEqual([]);
			expect(plan.moves).toEqual([
				{
					from: 'EXCLUDE_DIFFUSION_ELEMENTS',
					tool: EXCLUSION_TOOL,
					key: EXCLUSION_KEY,
					value: [EXCLUDED],
				},
			]);
		});

		test('no record → CREATED, and the reader (and the door) see it; a second run KEEPS it', async () => {
			const [move] = planToolConfigMoves(v6Config(`['${EXCLUDED}']`)).moves;
			if (move === undefined) throw new Error('no move planned');
			const apply = (value: unknown) =>
				moveValueIntoToolConfig({ toolName: move.tool, key: move.key, value, userId: -1 });
			try {
				expect(await apply(move.value)).toBe('created');
				// The only record naming the tool (beforeAll proved none existed): ours.
				const created = await diffusionConfigRecords();
				track(created);
				expect(created).toHaveLength(1);
				expect([...(await excludedDiffusionElements())]).toEqual([EXCLUDED]);
				expect(await panelElements()).not.toContain(EXCLUDED);
				// The tool config already holds a non-empty list: v6 read it first.
				expect(await apply(['zzdif999'])).toBe('kept');
				expect([...(await excludedDiffusionElements())]).toEqual([EXCLUDED]);
			} finally {
				await sweepTrackedConfigRecords();
			}
		});

		test('a record with an EMPTY list → WRITTEN into it (v6 fell back to the define)', async () => {
			await withScratchToolConfig(
				EXCLUSION_TOOL,
				{ other_option: 'kept', [EXCLUSION_KEY]: [] },
				async () => {
					expect(
						await moveValueIntoToolConfig({
							toolName: EXCLUSION_TOOL,
							key: EXCLUSION_KEY,
							value: [EXCLUDED],
							userId: -1,
						}),
					).toBe('written');
					expect([...(await excludedDiffusionElements())]).toEqual([EXCLUDED]);
					// The save audited the scratch record (TM + activity): tracked by its id.
					const written = await diffusionConfigRecords();
					track(written);
					expect(written).toHaveLength(1);
				},
			);
			await sweepTrackedConfigRecords();
		});

		test('an empty define moves nothing', async () => {
			const [move] = planToolConfigMoves(v6Config('[]')).moves;
			expect(move?.value).toEqual([]);
			expect(
				await moveValueIntoToolConfig({
					toolName: EXCLUSION_TOOL,
					key: EXCLUSION_KEY,
					value: move?.value,
					userId: -1,
				}),
			).toBe('empty');
			expect(await diffusionConfigRecords()).toHaveLength(0);
		});
	});
});
