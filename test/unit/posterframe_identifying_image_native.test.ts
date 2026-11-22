/**
 * tool_posterframe — identifying-image lookup in VIRTUAL EDIT SCOPE + the
 * create target from request_config (T1-12 / OX7).
 *
 * PHP (class.tool_posterframe.php): the lookup walks
 * `get_ar_children_tipo_by_model_name_in_section($section_tipo,
 * ['component_portal'], true, resolve_virtual=true)` — for a virtual section the
 * REAL section's subtree minus its FIRST exclude_elements subtrees (an excluded
 * grouper drops its children); a virtual's own children are never part of it.
 * The create target is `get_ar_target_section_tipo()` of the portal in mode
 * 'edit' — the request_config sqo.section_tipo — never the ontology relations.
 *
 * Before T1-12 the TS lookup walked the hit's OWN subtree, so every record of a
 * virtual section (tch1, rsc197, …) silently lost its identifying-image option,
 * and the create read the target from the relations, so a portal declaring its
 * target only in request_config (isad66) refused `tool.unsupported_target`.
 *
 * SITUATION `zzpf` (matrix_test; dropped with residue 0, activity rows swept):
 *   zzpf8   target section (zzpf9 component_image)
 *   zzpf20  AV section (zzpf21 component_av) — §AV_ID
 *   zzpf1   REAL: grouper zzpf2 ⊃ portal zzpf3 (→zzpf8, identifying_image zzpf9),
 *           grouper zzpf5 ⊃ portal zzpf4 (same), portal zzpf6 (→zzpf20, the
 *           references), portal zzpf13 (NO relations; target only in
 *           request_config → zzpf8; identifying_image zzpf9)
 *   zzpf10  VIRTUAL of zzpf1, no children
 *   zzpf11  VIRTUAL, exclude_elements → [zzpf2] (the GROUPER, not the portal)
 *   zzpf12  VIRTUAL, exclude_elements → [zzpf2, zzpf5]
 *   zzpf14  VIRTUAL with an OWN identifying portal zzpf15 (never part of scope)
 * One record per hit section, each pointing its zzpf6 at the AV record, plus a
 * SECOND zzpf1 record (§SECOND_HIT_ID) so one section answers two hits — the
 * per-section memo is only observable with more hits than distinct sections.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../src/config/config.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { resolveMagick } from '../../src/core/media/engine/imagemagick.ts';
import { runBinary } from '../../src/core/media/engine/spawn.ts';
import { buildMediaLocation } from '../../src/core/media/path.ts';
import { resolveMediaToolContext } from '../../src/core/media/tool_support.ts';
import { termByTipo } from '../../src/core/ontology/labels.ts';
import * as virtualScope from '../../src/core/ontology/virtual_scope.ts';
import { type Principal, resolvePrincipal } from '../../src/core/security/permissions.ts';
import {
	dropSituation,
	ensureSituation,
	residueOf,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import type { ToolActionContext } from '../../src/core/tools/module.ts';
import { sweepActivityRows } from '../helpers/activity_rows.ts';
import { mustGet } from '../helpers/assert.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import { refusalOf } from '../helpers/refusal.ts';
import { inSplitLane, laneLabel, SPLIT_LANES } from '../helpers/split_request_langs.ts';

const HAVE_FFMPEG = existsSync(config.media.binaries.ffmpeg);
const HAVE_BOTH = HAVE_FFMPEG && existsSync(resolveMagick());

const AV_ID = 1;
const HIT_ID = 7;
/** A second hit in zzpf1: hits (6) > distinct sections (5). */
const SECOND_HIT_ID = 8;
const HIT_SECTIONS = ['zzpf1', 'zzpf10', 'zzpf11', 'zzpf12', 'zzpf14'] as const;
const avLocator = { type: 'dd151', section_tipo: 'zzpf20', section_id: AV_ID };

const identifying = (target: string | null) => ({
	identifying_image: 'zzpf9',
	...(target === null
		? {}
		: {
				source: {
					request_config: [{ sqo: { section_tipo: [{ source: 'section', value: [target] }] } }],
				},
			}),
});
const term = (text: string) => ({ 'lg-spa': text, 'lg-eng': text });

const s = situation({
	tld: 'zzpf',
	name: 'posterframe identifying image',
	nodes: [
		{
			tipo: 'zzpf8',
			parent: 'test1',
			model: 'section',
			term: term('Imágenes'),
			relations: [{ tipo: 'test24' }],
		},
		{ tipo: 'zzpf9', parent: 'zzpf8', model: 'component_image', term: term('Imagen') },
		{
			tipo: 'zzpf20',
			parent: 'test1',
			model: 'section',
			term: term('Audiovisual'),
			relations: [{ tipo: 'test24' }],
		},
		{ tipo: 'zzpf21', parent: 'zzpf20', model: 'component_av', term: term('Vídeo') },

		{
			tipo: 'zzpf1',
			parent: 'test1',
			model: 'section',
			// Named per language: the T2-OX7-1b case reads the label in two langs.
			term: { 'lg-spa': 'Real', 'lg-eng': 'Real section' },
			relations: [{ tipo: 'test24' }],
		},
		{
			tipo: 'zzpf2',
			parent: 'zzpf1',
			model: 'section_group',
			order_number: 1,
			term: term('Grupo A'),
		},
		{
			tipo: 'zzpf3',
			parent: 'zzpf2',
			model: 'component_portal',
			order_number: 1,
			term: term('Portal A'),
			relations: [{ tipo: 'zzpf8' }],
			properties: identifying(null),
		},
		{
			tipo: 'zzpf5',
			parent: 'zzpf1',
			model: 'section_group',
			order_number: 2,
			term: term('Grupo B'),
		},
		{
			tipo: 'zzpf4',
			parent: 'zzpf5',
			model: 'component_portal',
			order_number: 1,
			term: term('Portal B'),
			relations: [{ tipo: 'zzpf8' }],
			properties: identifying(null),
		},
		{
			tipo: 'zzpf6',
			parent: 'zzpf1',
			model: 'component_portal',
			order_number: 3,
			term: term('Audiovisuales'),
			relations: [{ tipo: 'zzpf20' }],
		},
		{
			tipo: 'zzpf13',
			parent: 'zzpf1',
			model: 'component_portal',
			order_number: 4,
			term: term('Portal configurado'),
			properties: identifying('zzpf8'),
		},

		{
			tipo: 'zzpf10',
			parent: 'test1',
			model: 'section',
			term: term('Virtual'),
			relations: [{ tipo: 'zzpf1' }],
		},
		{
			tipo: 'zzpf11',
			parent: 'test1',
			model: 'section',
			term: term('Virtual sin A'),
			relations: [{ tipo: 'zzpf1' }],
		},
		{
			tipo: 'zzpf16',
			parent: 'zzpf11',
			model: 'exclude_elements',
			term: term('excluir'),
			relations: [{ tipo: 'zzpf2' }],
		},
		{
			tipo: 'zzpf12',
			parent: 'test1',
			model: 'section',
			term: term('Virtual sin A ni B'),
			relations: [{ tipo: 'zzpf1' }],
		},
		{
			tipo: 'zzpf17',
			parent: 'zzpf12',
			model: 'exclude_elements',
			term: term('excluir'),
			relations: [{ tipo: 'zzpf2' }, { tipo: 'zzpf5' }],
		},
		{
			tipo: 'zzpf14',
			parent: 'test1',
			model: 'section',
			term: term('Virtual propio'),
			relations: [{ tipo: 'zzpf1' }],
		},
		{
			tipo: 'zzpf15',
			parent: 'zzpf14',
			model: 'component_portal',
			term: term('Portal propio'),
			relations: [{ tipo: 'zzpf8' }],
			properties: identifying(null),
		},
	],
	records: [
		{ section_tipo: 'zzpf20', section_id: AV_ID, columns: { data: {} } },
		...HIT_SECTIONS.map((section_tipo) => ({
			section_tipo,
			section_id: HIT_ID,
			columns: { relation: { zzpf6: [{ ...avLocator, from_component_tipo: 'zzpf6' }] } },
		})),
		{
			section_tipo: 'zzpf1',
			section_id: SECOND_HIT_ID,
			columns: { relation: { zzpf6: [{ ...avLocator, from_component_tipo: 'zzpf6' }] } },
		},
	],
});

let root: Principal;

/** Every file under the suite media root whose name carries the situation's tld. */
function scratchMediaFiles(dir: string | null = config.media.rootPath): string[] {
	if (dir === null || !existsSync(dir)) return [];
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const abs = join(dir, name);
		if (statSync(abs).isDirectory()) out.push(...scratchMediaFiles(abs));
		else if (name.startsWith('zzpf')) out.push(abs);
	}
	return out;
}

beforeAll(async () => {
	if (!DB_READY) return;
	await dropSituation(s);
	await ensureSituation(s);
	root = await resolvePrincipal(-1);
});

afterAll(async () => {
	if (!DB_READY) return;
	for (const file of scratchMediaFiles()) rmSync(file, { force: true });
	for (const tipo of s.sectionTipos) await sweepActivityRows(tipo);
	expect(await dropSituation(s)).toBe(0);
	expect(await residueOf(s)).toBe(0);
	expect(scratchMediaFiles()).toEqual([]);
});

async function handler(action: string): Promise<(ctx: ToolActionContext) => Promise<unknown>> {
	const loaded = await getLoadedTool('tool_posterframe');
	return mustGet(loaded?.module.apiActions[action], `tool_posterframe.${action}`).handler;
}

function ctx(options: Record<string, unknown>): ToolActionContext {
	return { principal: root, userId: root.userId, options, background: false };
}

type Descriptor = Record<string, unknown>;

async function identifyingImages(): Promise<Descriptor[]> {
	const run = await handler('get_ar_identifying_image');
	const body = (await run(ctx({ section_tipo: 'zzpf20', section_id: AV_ID }))) as {
		data?: Descriptor[];
	};
	return mustGet(body.data, 'get_ar_identifying_image data');
}

async function descriptorOf(sectionTipo: string): Promise<Descriptor | undefined> {
	return (await identifyingImages()).find((d) => d.section_tipo === sectionTipo);
}

async function portalLocators(
	sectionTipo: string,
	portal: string,
): Promise<{ section_tipo: string; section_id: number }[]> {
	const rows = (await sql.unsafe(
		`SELECT relation->$3 AS locs FROM matrix_test WHERE section_tipo = $1 AND section_id = $2`,
		[sectionTipo, HIT_ID, portal],
	)) as { locs: { section_tipo: string; section_id: number }[] | null }[];
	return rows[0]?.locs ?? [];
}

async function createFrom(item: Descriptor): Promise<unknown> {
	const run = await handler('create_identifying_image');
	return run(
		ctx({
			section_tipo: 'zzpf20',
			section_id: AV_ID,
			component_tipo: 'zzpf21',
			current_time: '00:00:00',
			item_value: item,
		}),
	);
}

/** Make the AV master the handler will read (only when ffmpeg is present). */
async function makeAv(): Promise<void> {
	const av = await resolveMediaToolContext({
		tipo: 'zzpf21',
		section_tipo: 'zzpf20',
		section_id: AV_ID,
	});
	const abs = buildMediaLocation(
		av.spec,
		av.identity,
		av.spec.defaultQuality,
		'mp4',
		av.pathOpts,
	).absolutePath;
	mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
	await runBinary(
		[
			config.media.binaries.ffmpeg,
			'-y',
			'-f',
			'lavfi',
			'-i',
			'testsrc=size=320x240:duration=1',
			abs,
		],
		{ nice: false },
	);
}

describe.if(DB_READY)('tool_posterframe identifying image — virtual edit scope (T1-12)', () => {
	test('control: a REAL section hit names its first identifying portal', async () => {
		expect(await descriptorOf('zzpf1')).toEqual({
			section_id: HIT_ID,
			section_tipo: 'zzpf1',
			component_portal: 'zzpf3',
			component_image: 'zzpf9',
			label: await termByTipo('zzpf1', config.menu.applicationLang),
		});
	});

	test('T2-OX7-1b: the descriptor label speaks the REQUEST application lang', async () => {
		// FLOOR: zzpf1 is named differently per lang, or both readings coincide.
		expect(await termByTipo('zzpf1', 'lg-eng')).not.toBe(await termByTipo('zzpf1', 'lg-spa'));
		// SPLIT lanes (data ≠ application, swapped — review M1): a label read in
		// the DATA lang is red in both.
		for (const lane of SPLIT_LANES) {
			const descriptor = await inSplitLane(lane, () => descriptorOf('zzpf1'));
			expect(descriptor?.label, laneLabel(lane)).toBe(
				await termByTipo('zzpf1', lane.applicationLang),
			);
		}
	});

	test('a VIRTUAL hit inherits the real portal; the descriptor keeps the virtual tipo + label', async () => {
		const label = await termByTipo('zzpf10', config.menu.applicationLang);
		expect(label).not.toBe(await termByTipo('zzpf1', config.menu.applicationLang));
		expect(await descriptorOf('zzpf10')).toEqual({
			section_id: HIT_ID,
			section_tipo: 'zzpf10',
			component_portal: 'zzpf3',
			component_image: 'zzpf9',
			label,
		});
	});

	test("an excluded GROUPER drops its subtree's portal (next in order wins)", async () => {
		expect((await descriptorOf('zzpf11'))?.component_portal).toBe('zzpf4');
	});

	test('both groupers excluded → the request_config-only portal', async () => {
		expect((await descriptorOf('zzpf12'))?.component_portal).toBe('zzpf13');
	});

	test("a virtual's OWN child portal is never part of its scope (PHP resolve_virtual)", async () => {
		expect((await descriptorOf('zzpf14'))?.component_portal).toBe('zzpf3');
	});

	test('one scope walk per distinct hit section, not per hit', async () => {
		const spy = spyOn(virtualScope, 'editScopeComponents');
		try {
			const run = await handler('get_ar_identifying_image');
			const body = (await run(ctx({ section_tipo: 'zzpf20', section_id: AV_ID }))) as {
				data: Descriptor[];
			};
			// Non-vacuity: more hits than sections, so a per-hit walk would differ.
			expect(body.data.length).toBe(HIT_SECTIONS.length + 1);
			expect(body.data.filter((d) => d.section_tipo === 'zzpf1').map((d) => d.section_id)).toEqual([
				HIT_ID,
				SECOND_HIT_ID,
			]);
			const walked = spy.mock.calls.map((call) => call[0]);
			expect(walked.length).toBe(HIT_SECTIONS.length);
			expect(new Set(walked).size).toBe(walked.length);
		} finally {
			spy.mockRestore();
		}
	});

	test('create on a request_config-only portal targets its configured section', async () => {
		const item = {
			section_tipo: 'zzpf1',
			section_id: HIT_ID,
			component_portal: 'zzpf13',
			component_image: 'zzpf9',
		};
		if (HAVE_FFMPEG) await makeAv();
		const before = await portalLocators('zzpf1', 'zzpf13');
		if (HAVE_BOTH) {
			const body = (await createFrom(item)) as {
				data: { section_id: number; files_info: unknown[] };
			};
			expect(body.data.section_id).toBeGreaterThan(0);
			expect(body.data.files_info.length).toBeGreaterThan(0);
		} else {
			// No frame tooling: the create still reaches the portal save (the
			// target resolved) and fails at the media step — never at the target.
			const refusal = await refusalOf(createFrom(item) as Promise<unknown>);
			expect(refusal.code).not.toBe('tool.unsupported_target');
		}
		const after = await portalLocators('zzpf1', 'zzpf13');
		expect(after.length).toBe(before.length + 1);
		expect(after.at(-1)?.section_tipo).toBe('zzpf8');
	});

	test('round-trip: a virtual hit descriptor posted verbatim creates on the virtual host', async () => {
		const descriptor = mustGet(await descriptorOf('zzpf10'), 'zzpf10 descriptor');
		const { label: _label, ...item } = descriptor;
		if (HAVE_FFMPEG) await makeAv();
		const before = await portalLocators('zzpf10', 'zzpf3');
		if (HAVE_BOTH) {
			const body = (await createFrom(item)) as { data: { section_id: number } };
			expect(body.data.section_id).toBeGreaterThan(0);
		} else {
			const refusal = await refusalOf(createFrom(item) as Promise<unknown>);
			expect(refusal.code).not.toBe('tool.unsupported_target');
		}
		const after = await portalLocators('zzpf10', 'zzpf3');
		expect(after.length).toBe(before.length + 1);
		expect(after.at(-1)?.section_tipo).toBe('zzpf8');
	});
});
