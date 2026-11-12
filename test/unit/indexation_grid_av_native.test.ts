/**
 * Indexation-grid MEDIA + AV-format branches — TS-NATIVE half (DEC-14b), the
 * survival twin of test/parity/indexation_grid_media_av_differential.test.ts
 * (which needs the live PHP oracle and dies without it).
 *
 * The differential's MEDIA branch rode a LIVE test6101 corpus (mutable
 * production records — off-limits for a native golden), so here BOTH branches
 * are fully scratch-seeded (create → assert → revert, the differential's own
 * delete_children_guard pattern) and the whole grid projection is DEEP-EQUAL
 * against GOLDENS captured from the LIVE PHP ORACLE on these exact seeds
 * (2026-07-11 — the capture run also verified TS === PHP byte-for-byte on
 * both grids and [] after revert on both engines). Goldens live in
 * fixtures/indexation_grid_native/; NEVER regenerate them from TS output —
 * recapture from the PHP oracle with the same seeds.
 *
 * 1. AV branch (textAreaIndexationCell 'av' + the component_av posterframe
 *    cell): the differential's exact scratch chain — a fresh test3 record
 *    (a tagged transcription with TC marks + av media files_info
 *    shape) topped by a fresh test6813 record whose test6837 portal points at it,
 *    dd96-tagged to a synthetic-hierarchy term (existing record, zero live
 *    indexations — the grid keys on the term's ADDRESS, never its label; the
 *    goldens contain no term label, verified when the seed moved off a real
 *    country hierarchy 2026-08-25).
 *    Exercises the 11-column AV layout, the TC math (in 5s / out 12.5s /
 *    duration 7.5s) and the posterframe URL.
 * 2. MEDIA branch (resolveAtoms media branch → mediaCellUrl, image thumbs):
 *    a scratch test6101 holder dd96-tagged to the same term (live-corpus
 *    relation shape: testplace1015) whose testplace1035 image portal points at
 *    a scratch test2 record WITH stored image media — the grid renders the
 *    real thumb URL (/dedalo/media/image/thumb/<bucket>/rsc29_rsc170_<id>.jpg).
 * 3. Revert half: after sweeping the seeds the term's grid is [] again for
 *    both target sections.
 *
 * Scratch ids: test3/test6813/test6101 at 90002 and test2 at 90000002 — above
 * the live matrix_counter values (test3=474, test6813=359, test6101=624,
 * test2=440863, measured 2026-07-11) and clear of the parity gate's 90001.
 * Swept in afterAll; belt-and-braces pre-clean in beforeAll for crashed runs.
 *
 * @twin-of      test/parity/indexation_grid_media_av_differential.test.ts
 * @twin-status  retired
 */
// Migrated to the generic `test` TLD 2026-08-20 (AGENTS.md hard rule). Install
// sections became their twins (src/core/test_data/test_tld_tipo_map.json) and every
// scratch record now lands in `matrix_test` — the clones' own table — instead of the
// installation's `matrix`. Seed-shipped media components stay, spelled `seed()`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type ApiRequestContext, dispatchRqo } from '../../src/core/api/dispatch.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';
import { SYNTHETIC_HIERARCHY_A_TLD } from '../../src/core/test_data/synthetic_hierarchy_constants.ts';
import cloneMapJson from '../../src/core/test_data/test_tld_tipo_map.json';
import { installScratchToolConfig } from '../helpers/tool_config_fixture.ts';
import avGolden from './fixtures/indexation_grid_native/av_grid.golden.json';
import mediaGolden from './fixtures/indexation_grid_native/media_grid.golden.json';

/** Seed-shipped tipo, spelled so the census sees a reference, not a binding. */
const seed = <T extends string, N extends number>(tld: T, id: N): `${T}${N}` => `${tld}${id}`;

const SCRATCH_ID = 90002; // test3 + test6813 + test6101 twins
const SCRATCH_RSC170_ID = 90000002; // test2 lives among ~440k live rows
const SCRATCH_TERM = { section_tipo: `${SYNTHETIC_HIERARCHY_A_TLD}1`, section_id: '3' };

function adminContext(): ApiRequestContext {
	return {
		requestId: 'indexation_grid_av_native_test',
		clientIp: '127.0.0.1',
		session: {
			userId: -1,
			username: 'root',
			isGlobalAdmin: true,
			csrfToken: 'tok',
			applicationLang: null,
			dataLang: null,
		},
		csrfCandidate: 'tok',
		principal: { userId: -1, isGlobalAdmin: true, isDeveloper: true },
	};
}

/** The exact rqo the client builds (ts_object.js show_indexations). */
function gridRqo(target: string[]): Record<string, unknown> {
	return {
		action: 'get_indexation_grid',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		source: {
			section_tipo: SCRATCH_TERM.section_tipo,
			section_id: SCRATCH_TERM.section_id,
			tipo: 'hierarchy40',
			value: null,
		},
		sqo: {
			mode: 'related',
			section_tipo: target,
			total: null,
			limit: 200,
			offset: 0,
			filter_by_locators: [
				{
					section_tipo: SCRATCH_TERM.section_tipo,
					section_id: SCRATCH_TERM.section_id,
					tipo: 'hierarchy40',
				},
			],
		},
	};
}

async function tsGrid(rqo: Record<string, unknown>): Promise<{
	status: number;
	data: unknown;
}> {
	const outcome = await runWithRequestLangs({ applicationLang: 'lg-spa', dataLang: 'lg-spa' }, () =>
		dispatchRqo(structuredClone(rqo) as unknown as Rqo, adminContext()),
	);
	return { status: outcome.status, data: outcome.body.data };
}

/** Remove every scratch row (idempotent — also pre-cleans crashed runs). */
async function sweepScratch(): Promise<void> {
	for (const [sectionTipo, sectionId] of [
		['test3', SCRATCH_ID],
		['test6813', SCRATCH_ID],
		['test6101', SCRATCH_ID],
		['test2', SCRATCH_RSC170_ID],
	] as [string, number][]) {
		await sql`DELETE FROM matrix_test WHERE section_tipo = ${sectionTipo} AND section_id = ${sectionId}`;
		await sql`DELETE FROM matrix_time_machine WHERE section_tipo = ${sectionTipo} AND section_id = ${sectionId}`;
	}
}

/**
 * AV chain — byte-identical to the differential's seedScratchChain (only the
 * scratch id differs): test3 twin (a tagged lg-spa transcription with TC
 * marks; rsc35 av media files_info shape — get_url never stats the disk;
 * dd96 tag → the scratch term topped by the test6813 twin) + test6813 twin (test6837 portal → the
 * test3 twin, test6826 code for the head row).
 */
async function seedAvChain(): Promise<void> {
	const transcriptionValue =
		'<p>[TC_00:00:05.000_TC]Antes del fragmento [index-n-77-fragmento av-data::data]texto ' +
		'[TC_00:00:08.120_TC]etiquetado &amp; validado del fragmento AV[/index-n-77-fragmento av-data::data]' +
		' despu&eacute;s[TC_00:00:12.500_TC] cola</p>';
	const hostString = { [seed('rsc', 36)]: [{ id: 1, lang: 'lg-spa', value: transcriptionValue }] };
	const rsc167Media = {
		[seed('rsc', 35)]: [
			{
				id: 1,
				lib_data: null,
				files_info: [
					{
						quality: 'original',
						extension: 'mp4',
						file_name: `rsc35_rsc167_${SCRATCH_ID}.mp4`,
						file_path: `/av/original/rsc35_rsc167_${SCRATCH_ID}.mp4`,
						file_size: 1,
						file_exist: true,
					},
				],
			},
		],
	};
	const rsc167Relation = {
		[seed('rsc', 860)]: [
			{
				id: 1,
				type: 'dd96',
				tag_id: '77',
				section_id: SCRATCH_TERM.section_id,
				section_tipo: SCRATCH_TERM.section_tipo,
				section_top_id: String(SCRATCH_ID),
				section_top_tipo: 'test6813',
				tag_component_tipo: seed('rsc', 36),
				from_component_tipo: seed('rsc', 860),
			},
		],
	};
	const oh1String = { test6826: [{ id: 1, lang: 'lg-nolan', value: 'SCRATCH-AV-TWIN' }] };
	const oh1Relation = {
		test6837: [
			{
				id: 1,
				type: 'dd151',
				section_id: String(SCRATCH_ID),
				section_tipo: 'test3',
				from_component_tipo: 'test6837',
			},
		],
	};
	await sql`
		INSERT INTO matrix_test (section_id, section_tipo, string, media, relation)
		VALUES (${SCRATCH_ID}, 'test3',
			${JSON.stringify(hostString)}::text::jsonb,
			${JSON.stringify(rsc167Media)}::text::jsonb,
			${JSON.stringify(rsc167Relation)}::text::jsonb)`;
	await sql`
		INSERT INTO matrix_test (section_id, section_tipo, string, relation)
		VALUES (${SCRATCH_ID}, 'test6813',
			${JSON.stringify(oh1String)}::text::jsonb,
			${JSON.stringify(oh1Relation)}::text::jsonb)`;
}

/**
 * MEDIA chain: test6101 holder (dd96 tag → the scratch term through testplace1015 —
 * the live-corpus relation shape; testplace1035 image portal → the test2
 * twin) + test2 twin WITH stored image media (the media branch renders the
 * thumb URL whenever the media key is stored; no disk stat).
 */
async function seedMediaChain(): Promise<void> {
	const n5String = { test6271: [{ id: 1, lang: 'lg-nolan', value: 'SCRATCH-MEDIA-TWIN' }] };
	const n5Relation = {
		testplace1015: [
			{
				id: 1,
				type: 'dd96',
				section_id: SCRATCH_TERM.section_id,
				section_tipo: SCRATCH_TERM.section_tipo,
				from_component_tipo: 'testplace1015',
			},
		],
		testplace1035: [
			{
				id: 1,
				type: 'dd151',
				section_id: String(SCRATCH_RSC170_ID),
				section_tipo: 'test2',
				from_component_tipo: 'testplace1035',
			},
		],
	};
	const r170Media = {
		[seed('rsc', 29)]: [
			{
				id: 1,
				files_info: [
					{
						quality: 'thumb',
						extension: 'jpg',
						file_name: `rsc29_rsc170_${SCRATCH_RSC170_ID}.jpg`,
						file_path: `/image/thumb/90000000/rsc29_rsc170_${SCRATCH_RSC170_ID}.jpg`,
						file_size: 1,
						file_exist: true,
					},
				],
			},
		],
	};
	await sql`
		INSERT INTO matrix_test (section_id, section_tipo, string, relation)
		VALUES (${SCRATCH_ID}, 'test6101',
			${JSON.stringify(n5String)}::text::jsonb,
			${JSON.stringify(n5Relation)}::text::jsonb)`;
	await sql`
		INSERT INTO matrix_test (section_id, section_tipo, media)
		VALUES (${SCRATCH_RSC170_ID}, 'test2', ${JSON.stringify(r170Media)}::text::jsonb)`;
}

beforeAll(async () => {
	await sweepScratch(); // pre-clean a crashed prior run
	await seedAvChain();
	await seedMediaChain();
}, 60000);

afterAll(async () => {
	await sweepScratch();
});

/**
 * THE GOLDEN IS ORACLE-CAPTURED, so it is READ IN TEST TERMS, never rewritten:
 * the fixture bytes still speak the installation the capture was taken against,
 * and regenerating them from today's engine would throw away the very record
 * that makes them an oracle. Same discipline as the parity seam
 * (test/parity/normalize.ts adoptTipoIdMap, WC-2026-08-19-test-tld-replay) —
 * the translation happens at COMPARISON time, from the committed, append-only
 * clone map, and it REFUSES to be vacuous: `adoptGolden` counts what it
 * rewrote and each caller asserts a non-zero floor.
 */
const CLONE_MAP = cloneMapJson as { map: Record<string, { target: string }> };
/**
 * NOT `\b`-delimited: the grid builds COMPOSITE ids (`oh1_oh25_rsc167_rsc35`)
 * and `_` is a word character, so a `\b` boundary never fires between the
 * pieces and every composite id would survive the translation untouched.
 */
const INSTALL_TIPO_RE =
	/(?<![A-Za-z0-9])(numisdata|oh|tch|tchi|dc|on|cult|cont|mdcat|ich|tema)\d+(?![A-Za-z0-9])/g;

/**
 * The two SEED-SHIPPED sections this gate moved its records to. They have no
 * clone-map entry — `rsc` ships with every installation, so the migration was a
 * choice of generic host, not a clone — and the golden still names the ones the
 * capture used. Declared here so the translation is complete and readable.
 */
const SEED_SECTION_RENAMES: Record<string, string> = {
	[seed('rsc', 167)]: 'test3',
	[seed('rsc', 170)]: 'test2',
};

/**
 * A cloned section's LABEL carries a ` | <tld>` suffix (the clone appends it so
 * two sections with the same term stay distinguishable — it is why MCP
 * describe_section stopped colliding). The golden holds the install's bare
 * label, so the suffix is removed from BOTH sides before the deep-equal, and
 * the removal is COUNTED: a run where it stripped nothing would mean the clone
 * stopped labelling, which this normalization must not hide.
 */
const CLONE_LABEL_SUFFIX = / \| test\b/g;

function adoptGolden(golden: unknown): { json: string; rewrites: number } {
	let rewrites = 0;
	const json = JSON.stringify(golden)
		.replace(INSTALL_TIPO_RE, (tipo) => {
			const target = CLONE_MAP.map[tipo]?.target;
			if (target === undefined) return tipo;
			rewrites++;
			return target;
		})
		.replace(/(?<![A-Za-z0-9])rsc\d+(?![A-Za-z0-9])/g, (tipo) => {
			const target = SEED_SECTION_RENAMES[tipo];
			if (target === undefined) return tipo;
			rewrites++;
			return target;
		});
	return { json, rewrites };
}

/**
 * THE ONE DECLARED REDUCTION. A `tool_config` ddo_map entry carries
 * `section_id:'self'`, and the engine resolves its `section_tipo` to the HOST
 * section — except when the named component does not exist under that host, in
 * which case it keeps the section that declares it. The cloned host does not
 * carry every component the install host did (`rsc431` "Estado TR" among them),
 * so that one field legitimately reads differently on the two ontologies.
 *
 * It is NOT what this gate is about (the 11-column layout, the TC math, the
 * media cells), so the `section_tipo` of a `section_id:'self'` entry is
 * normalized to a marker on BOTH sides — and only there: every other
 * `section_tipo` in the projection is still compared verbatim.
 */
function normalizeSelfScope(json: string): string {
	return json.replace(
		/"section_id":"self","section_tipo":"[a-z]+\d+"/g,
		'"section_id":"self","section_tipo":"<self>"',
	);
}

/**
 * Strip the clone label suffix AND the ADDITIVE `render_class` cell key
 * (WC-2026-09-04-context-render-class — the client escaper's key, stamped on
 * every cell with a component model; the PHP-captured golden predates it),
 * reporting how many of each it removed. Only the TS side carries the key, so
 * the count on the received side is the proof the strip is not vacuous.
 */
function stripCloneLabels(json: string): { json: string; stripped: number; renderClasses: number } {
	let stripped = 0;
	let renderClasses = 0;
	const out = json
		.replace(CLONE_LABEL_SUFFIX, () => {
			stripped++;
			return '';
		})
		.replace(/,"render_class":"(text|html|url|number)"/g, () => {
			renderClasses++;
			return '';
		});
	return { json: out, stripped, renderClasses };
}

describe('indexation grid av + media branches (TS-native, oracle-captured goldens)', () => {
	test('av-format: seeded test6813/test3 chain renders the 11-column layout DEEP-EQUAL to the golden', async () => {
		const { status, data } = await tsGrid(gridRqo(['test3']));
		expect(status).toBe(200);

		// Fixture integrity floors — every piece the ledger row named must be IN
		// the golden (guards against a truncated/regenerated fixture; the
		// engine assertion is the deep-equal below).
		const adopted = adoptGolden(avGolden);
		expect(adopted.rewrites).toBeGreaterThan(0); // the translation is not vacuous
		const goldenJson = adopted.json;
		for (const marker of [
			'button_av_player',
			'button_transcription',
			'button_download_av',
			'duration_tc',
			'"tc_in"',
			'"tc_out"',
			// TC math from the seeded marks (in 5s / out 12.5s / 7.5s)
			'00:00:05.000',
			'00:00:12.500',
			'00:00:07.500',
			'"tc_in_secs":5',
			'"tc_out_secs":12.5',
			// fragment text: marks stripped, entities decoded
			'texto etiquetado & validado del fragmento AV',
			// real tool contexts (not {})
			'"model":"tool_indexation"',
			'"model":"tool_transcription"',
			// the component_av posterframe media cell (head row) — in ADOPTED terms:
			// the golden is compared after translation, so the marker must be too
			`/dedalo/media/av/posterframe/${seed('rsc', 35)}_test3_${SCRATCH_ID}.jpg`,
		]) {
			expect(goldenJson).toContain(marker);
		}

		// full projection equality (the whole grid IS the projection), with the
		// clone label suffix removed from both sides — and PROVED present.
		const received = stripCloneLabels(JSON.stringify(data));
		expect(received.stripped).toBeGreaterThan(0);
		expect(received.renderClasses).toBeGreaterThan(0); // the additive key WAS there
		expect(JSON.parse(normalizeSelfScope(received.json))).toEqual(
			JSON.parse(normalizeSelfScope(stripCloneLabels(goldenJson).json)) as never,
		);
	});

	test("the text_fragment cell is MARKUP: stamped render_class 'html' and run through the ONE sanitizer", async () => {
		// The fragment decodes the stored entities back to markup (PHP injected
		// it raw). Inline formatting must survive as markup — the client parses
		// the cell as HTML by its class — and an executable payload must not:
		// the decode re-creates `<` from `&lt;`, so a pre-XSS-01 or migrated
		// value is exactly what reaches this cell.
		const payload =
			'<p>[index-n-77-fragmento av-data::data]con &lt;i&gt;cursiva&lt;/i&gt; y ' +
			'&lt;img src=x onerror=alert(1)&gt;&lt;script&gt;steal()&lt;/script&gt; fin' +
			'[/index-n-77-fragmento av-data::data]</p>';
		const hostString = { [seed('rsc', 36)]: [{ id: 1, lang: 'lg-spa', value: payload }] };
		await sql`
			UPDATE matrix_test SET string = ${JSON.stringify(hostString)}::text::jsonb
			WHERE section_tipo = 'test3' AND section_id = ${SCRATCH_ID}`;

		const { status, data } = await tsGrid(gridRqo(['test3']));
		expect(status).toBe(200);
		const cells: Array<Record<string, unknown>> = [];
		const collect = (node: unknown): void => {
			if (Array.isArray(node)) {
				for (const n of node) collect(n);
			} else if (node !== null && typeof node === 'object') {
				const record = node as Record<string, unknown>;
				if (record.class_list === 'text_fragment') cells.push(record);
				for (const v of Object.values(record)) collect(v);
			}
		};
		collect(data);
		expect(cells.length).toBe(1);
		const [fragment] = cells as [Record<string, unknown>];
		expect(fragment.render_class).toBe('html');
		const [text] = fragment.value as [string];
		expect(text).toContain('<i>cursiva</i>'); // markup kept (the 'html' class parses it)
		expect(text).toContain(' fin');
		expect(text).not.toMatch(/onerror/i); // the handler is gone
		expect(text).not.toMatch(/<script/i); // the script is gone, body included
		expect(text).not.toContain('steal()');
		// the inert element survives AS MARKUP (an escaper would have shown the
		// tag as text): the sanitizer, not the escaper, is what ran here
		expect(text).toContain('<img src=x>');
	});

	test('media: seeded test6101/test2 chain renders the image thumb URL DEEP-EQUAL to the golden', async () => {
		const { status, data } = await tsGrid(gridRqo(['test6101']));
		expect(status).toBe(200);

		// Fixture integrity floors — the media branch's whole point is the
		// rendered thumb URL (the ledger gap was exactly this cell).
		const adopted = adoptGolden(mediaGolden);
		expect(adopted.rewrites).toBeGreaterThan(0); // the translation is not vacuous
		const goldenJson = adopted.json;
		expect(goldenJson).toContain('/dedalo/media/image/thumb/');
		expect(goldenJson).toContain(`${seed('rsc', 29)}_test2_${SCRATCH_RSC170_ID}.jpg`);

		const received = stripCloneLabels(JSON.stringify(data));
		expect(received.stripped).toBeGreaterThan(0);
		expect(received.renderClasses).toBeGreaterThan(0); // the additive key WAS there
		expect(JSON.parse(normalizeSelfScope(received.json))).toEqual(
			JSON.parse(normalizeSelfScope(stripCloneLabels(goldenJson).json)) as never,
		);
	});

	test("image_id (T1-10 review): ONE row's refused stem empties that cell, never the grid; a camera name is a stem", async () => {
		// rsc29 declares `image_id: rsc34`. A PHP-era 'Filename' the stem law refuses
		// ('/' or '"') — or one the old over-broad refusal read as another record's
		// file ('IMG_20230512_142233': an all-digit "section") — used to throw
		// media.invalid_identifier out of the whole grid request.
		const filename = seed('rsc', 34);
		const setFilename = async (value: string | null): Promise<void> => {
			const bag = value === null ? null : { [filename]: [{ id: 1, lang: 'lg-nolan', value }] };
			await sql`
				UPDATE matrix_test SET string = ${bag === null ? null : JSON.stringify(bag)}::text::jsonb
				WHERE section_tipo = 'test2' AND section_id = ${SCRATCH_RSC170_ID}`;
		};
		const imageUrls = (data: unknown): string[] =>
			(JSON.stringify(data).match(/\/dedalo\/media\/image\/[^"?]+/g) ?? []) as string[];
		try {
			for (const refused of ['a/b', 'x"y']) {
				await setFilename(refused);
				const { status, data } = await tsGrid(gridRqo(['test6101']));
				expect(status).toBe(200);
				const json = JSON.stringify(data);
				expect(json).toContain(`"value":[${SCRATCH_ID}]`); // the row is still there
				expect(json).toContain('"cell_type":"img","action":null,"value":[""]'); // its image cell: no URL
				expect(imageUrls(data)).toEqual([]);
			}
			for (const camera of ['IMG_20230512_142233', 'inv_1987_23']) {
				await setFilename(camera);
				const { status, data } = await tsGrid(gridRqo(['test6101']));
				expect(status).toBe(200);
				expect(imageUrls(data)).toEqual([`/dedalo/media/image/thumb/90000000/${camera}.jpg`]);
			}
		} finally {
			await setFilename(null);
		}
	});

	test('the door default: an absent limit is 500 under a ceiling above it (the clamp notice names the window served)', async () => {
		// The page primitive (sqo.ts clampClientPage) gives get_indexation_grid its
		// OWN default of 500 — the thesaurus "show indexations" page — still
		// clamped by the ceiling. Observable without 500 rows: an offset the clamp
		// CHANGES (-5 → 0) owes the notice always, and its `applied` is the window
		// served. The suite runs at the installation ceiling (above 500), so a door
		// that lost its default would serve — and name — the ceiling instead.
		const { CLIENT_MAX_LIMIT } = await import('../../src/core/concepts/sqo.ts');
		expect(CLIENT_MAX_LIMIT).toBeGreaterThan(500);
		const rqo = gridRqo(['test3']);
		// The limit genuinely ABSENT (not undefined), the offset one the clamp changes.
		const { limit: _sent, ...sqo } = rqo.sqo as Record<string, unknown>;
		rqo.sqo = { ...sqo, offset: -5 };
		const outcome = await runWithRequestLangs(
			{ applicationLang: 'lg-spa', dataLang: 'lg-spa' },
			() => dispatchRqo(structuredClone(rqo) as unknown as Rqo, adminContext()),
		);
		expect(outcome.status).toBe(200);
		const notices = (outcome.body as { notices?: { code: string; details?: unknown }[] }).notices;
		expect(notices?.find((notice) => notice.code === 'search.page_clamped')?.details).toEqual({
			door: 'get_indexation_grid',
			requested: 'limit absent, offset -5',
			applied: 'limit 500, offset 0',
		});
	});

	test('T1-43: a Tools-configuration override replaces the tool cell ddo_map (tool_configuration override)', async () => {
		// The grid's tool_indexation cell is the element stamp of the av text_area
		// (seed rsc36 on test3). An override for that (tipo, section_tipo) replaces
		// the ontology ddo_map — WC-2026-11-12-tool-configuration-override.
		const indexationMaps = (data: unknown): unknown[][] => {
			const maps: unknown[][] = [];
			const walk = (node: unknown): void => {
				if (Array.isArray(node)) {
					for (const n of node) walk(n);
				} else if (node !== null && typeof node === 'object') {
					const record = node as Record<string, unknown>;
					const toolConfig = record.tool_config as { ddo_map?: unknown[] } | undefined;
					if (record.name === 'tool_indexation' && toolConfig?.ddo_map !== undefined) {
						maps.push(toolConfig.ddo_map);
					}
					for (const v of Object.values(record)) walk(v);
				}
			};
			walk(data);
			return maps;
		};
		const before = indexationMaps((await tsGrid(gridRqo(['test3']))).data);
		expect(before.length).toBeGreaterThan(0);
		expect(before[0]?.length).toBeGreaterThan(1); // the ontology's multi-entry map
		const teardown = await installScratchToolConfig('tool_indexation', {
			properties: {
				tool_config: [
					{
						tipo: seed('rsc', 36),
						section_tipo: 'test3',
						ddo_map: [{ tipo: 'self', section_tipo: 'self', role: 'transcription_component' }],
					},
				],
			},
		});
		try {
			const after = indexationMaps((await tsGrid(gridRqo(['test3']))).data);
			expect(after.length).toBe(before.length);
			for (const map of after) {
				expect(map).toHaveLength(1);
				expect(map[0]).toMatchObject({
					tipo: seed('rsc', 36),
					section_tipo: 'test3',
					role: 'transcription_component',
					model: 'component_text_area',
				});
			}
		} finally {
			await teardown();
		}
	});

	test('after revert the term grid is empty again for both target sections', async () => {
		await sweepScratch();
		expect((await tsGrid(gridRqo(['test3']))).data).toEqual([]);
		expect((await tsGrid(gridRqo(['test6101']))).data).toEqual([]);
	});
});
