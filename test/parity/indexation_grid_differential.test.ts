/**
 * get_indexation_grid differential — TS engine (src/core/section/
 * indexation_grid.ts) vs live PHP dd_core_api::get_indexation_grid (:2845 →
 * indexation_grid::build_indexation_grid). The thesaurus "show indexations"
 * grid: ts_object.js show_indexations → dd_grid view 'indexation'.
 *
 * The corpus exercises every indexation_list config shape the clone carries:
 * the rsc205 publications config (head+row, image/date/portal-with-children/
 * select_lang cells + pdf-format text_area custom columns), test6101
 * (section_id cells, leaf portals, default-request-config recursion),
 * testimmovable1 (thesaurus records with portal+image sub-ddo), rsc167 tag_id
 * locators grouped under a section_top, a MISSING config (rsc420 → group
 * skipped), a section with no config at all (testmint1 → empty grid),
 * multi-section grids and pagination. The whole grid JSON must be DEEP-EQUAL
 * to the oracle's.
 */
// GENERIC-TLD MIGRATED 2026-08-19 (WC-2026-08-19-test-tld-replay-search-group).
// Every term and every target section is addressed in `test`-TLD terms; the
// frozen PHP interaction is reached through `unmapRqo` and its grid is read
// back through `adoptTipoIdMap`. `rsc167`/`rsc205`/`rsc420` are SEED-SHIPPED
// ontology (every installation has them) and are spelled through `seed()`.
// STILL RED — and NOT for a TLD reason: see the CASES note below.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import { type ApiRequestContext, dispatchRqo } from '../../src/core/api/dispatch.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { CATEGORY_STATUS, specOf } from '../../src/core/errors/registry.ts';
import { runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';
import { dropTestCorpus, ensureTestCorpus } from '../../src/core/test_data/test_corpus/ensure.ts';
import {
	adoptErrorEnvelopeV2,
	adoptTipoIdMap,
	normalizeSectionIdTypes,
	stripRenderClass,
} from './normalize.ts';
import { hasPhpCredentials, PhpApiClient } from './php_client.ts';

/** A SEED-SHIPPED tipo, spelled out of the install-TLD census's token grammar. */
const seed = (tld: string, id: number): string => `${tld}${id}`;

/** Every section a grid below reads — this gate owns whatever the corpus holds. */
const CORPUS_SECTIONS = [
	seed('rsc', 205),
	seed('rsc', 167),
	'test6101',
	'testimmovable1',
	'testterr1',
	'test1026',
] as const;

function adminContext(): ApiRequestContext {
	return {
		requestId: 'test',
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
function gridRqo(
	termTipo: string,
	termId: string,
	target: string[],
	limit = 200,
	offset = 0,
): Record<string, unknown> {
	return {
		action: 'get_indexation_grid',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		source: { section_tipo: termTipo, section_id: termId, tipo: 'hierarchy40', value: null },
		sqo: {
			mode: 'related',
			section_tipo: target,
			total: null,
			limit,
			offset,
			filter_by_locators: [{ section_tipo: termTipo, section_id: termId, tipo: 'hierarchy40' }],
		},
	};
}

async function tsGrid(rqo: Record<string, unknown>): Promise<{
	status: number;
	body: Record<string, unknown>;
}> {
	// PHP resolves labels/data in the install langs; pin the same request langs.
	const outcome = await runWithRequestLangs({ applicationLang: 'lg-spa', dataLang: 'lg-spa' }, () =>
		dispatchRqo(rqo as unknown as Rqo, adminContext()),
	);
	return { status: outcome.status, body: outcome.body };
}

describe.if(hasPhpCredentials())('get_indexation_grid differential', () => {
	let client: PhpApiClient;

	beforeAll(async () => {
		await ensureTestCorpus([...CORPUS_SECTIONS]);
		client = new PhpApiClient();
		await client.login(
			config.phpReference.username as string,
			config.phpReference.password as string,
		);
	});

	afterAll(async () => {
		expect(await dropTestCorpus([...CORPUS_SECTIONS])).toBe(0);
	});

	// [term_tipo, term_id, target_sections, limit?, offset?] — the terms and
	// records the frozen interactions were harvested against, addressed by their
	// clones.
	//
	// KNOWN RED, and not for a TLD reason: `derive_test_corpus.ts` reconstructed
	// NO record for this gate (no corpus record lists `indexation_grid_differential`
	// among its gates, and the grid's own projections land in refused.json under
	// `list_projection_not_storable` / `never_revealed`). A grid is a function of
	// the dd96 INDEX EDGES between a term and the indexed records, and the corpus
	// holds neither the term records (testcont1/test1023/test2822/test2819 have no
	// corpus file at all) nor those edges — so the cases below compare a populated
	// frozen grid with an empty one. What they need is a corpus derive that
	// materializes indexation edges; nothing in this file can supply it.
	const CASES: [string, string, string[], number?, number?][] = [
		// publications config (rsc897): head+row, portal-with-children, pdf text_area
		['testcont1', '10', [seed('rsc', 205)]],
		// coin-type config (numisdata247): section_id cells, leaf portals
		['test1026', '65', ['test6101']],
		// numisdata6 declares NO indexation_list → whole grid empty
		['testterr1', '140', ['testmint1']],
		// tag_id locators on rsc167 grouped under section_top oh1 (oh6 config)
		['test1023', '1', [seed('rsc', 167)]],
		['test2822', '1024', [seed('rsc', 167)]],
		// TWO section groups in one grid (rsc205 + tchi1's tchi92 config with
		// default-request-config portal recursion)
		['testcont1', '38', [seed('rsc', 205), 'testimmovable1']],
		// rsc420 has no indexation_list → its group is skipped, rsc205 renders
		['test2819', '47', [seed('rsc', 205), seed('rsc', 420)]],
		// pagination: cont1_31 has 8 hits → limit 3 offset 2
		['testcont1', '31', [seed('rsc', 205), 'testimmovable1'], 3, 2],
	];

	for (const [termTipo, termId, target, limit, offset] of CASES) {
		test(`grid for ${termTipo}_${termId} (${target.join('+')}${limit !== undefined ? `, limit ${limit} offset ${offset}` : ''}) is DEEP-EQUAL to PHP`, async () => {
			const rqo = gridRqo(termTipo, termId, target, limit ?? 200, offset ?? 0);
			const [ts, php] = [await tsGrid(rqo), await client.call(rqo)];
			expect(ts.status).toBe(200);
			// The frozen grid is install-term; read it in the `test` terms the RQO
			// is written in. `matched` is the totality assertion — an unmapped
			// install token would make the deep-equal below meaningless.
			const adopted = adoptTipoIdMap(php.body.result, 'indexation_grid_differential');
			expect(adopted.matched, adopted.detail ?? '').toBe(true);
			// Rewrite floor (WC-2026-08-19-test-tld-replay), conditional by
			// construction: `matched === true` already proves every install token
			// was rewritten, so a zero here is legitimate ONLY when the frozen
			// body carried no install token at all (the empty-grid case
			// testterr1_140 and the seed-only case test2819_47 — measured
			// 2026-08-23). Any case whose adoption DID rewrite must keep doing
			// so, or the translation went vacuous.
			const tokenFree = ['testterr1_140', 'test2819_47'].includes(`${termTipo}_${termId}`);
			if (!tokenFree) expect(adopted.rewrites.tipos).toBeGreaterThan(0);
			// WC-2026-09-04-context-render-class: every grid cell with a component
			// model carries the ADDITIVE `render_class` the frozen PHP grid predates.
			// Stripped before the deep-equal — and COUNTED: a case whose TS grid
			// renders any cell must have carried the key (section-level cells hold
			// no model and no class), so the strip can never quietly cover a grid
			// that stopped stamping.
			const cells = JSON.stringify(ts.body.data).split('"cell_type"').length - 1;
			const stripped = stripRenderClass(ts.body.data);
			if (cells > 0)
				expect(stripped, 'render_class stamped on the rendered component cells').toBeGreaterThan(0);
			// WC-2026-08-10-section-id-int-canonical: address keys compared by VALUE on BOTH sides (fixtures keep the PHP-era numeric strings).
			// WC-2026-10-29-posterframe-url-version: TS media cells carry `?v=<mtime ms>-<size>`
			// when the file exists; the PHP store has the bare path — compare without it.
			const unversioned = JSON.parse(JSON.stringify(ts.body.data).replace(/\?v=\d+-\d+(?=")/g, ''));
			expect(normalizeSectionIdTypes(unversioned)).toEqual(
				normalizeSectionIdTypes(adopted.body) as never,
			);
		});
	}

	test('the gate is not vacuous: the rich case resolves real values', async () => {
		const ts = await tsGrid(gridRqo('testcont1', '10', [seed('rsc', 205)]));
		const json = JSON.stringify(ts.body.data);
		// real record values, not just structure
		expect(json).toContain('Ercávica celtibérica');
		expect(json).toContain('component_portal');
		expect(json).toContain('record_link');
		expect(json).toContain(`caption section ${seed('rsc', 205)}`);
	});

	test('empty/invalid source → the SAME refusal, restated as envelope v2 (request.invalid_source, 400)', async () => {
		const rqo = {
			action: 'get_indexation_grid',
			dd_api: 'dd_core_api',
			prevent_lock: true,
			source: { section_tipo: 'testcont1' }, // tipo + section_id missing
			sqo: {},
		};
		const ts = await tsGrid(rqo);
		const php = await client.call(rqo);
		// The frozen PHP body is projected through the parity reconciler
		// (FROZEN_ERROR_BODIES → registry code); TS answers the registry status
		// (envelope v2: ok:false ⇒ status ∉ 2xx — ERRORS_SPEC §3).
		const adopted = adoptErrorEnvelopeV2(php.body);
		expect(adopted.matched).toBe(true);
		expect(adopted.kind).toBe('error');
		expect(ts.status).toBe(CATEGORY_STATUS[specOf('request.invalid_source').category]);
		expect(ts.body.ok).toBe(false);
		expect((ts.body.error as { code: string }).code).toBe(
			(adopted.projection as { error: { code: string } }).error.code,
		);
	});

	test('no-permission answers the registered perm.denied (403, white-box)', async () => {
		// PHP permission_exception → dd_manager:458 'permissions_denied' at 200;
		// envelope v2 restates it as the registered `perm.denied` at the registry
		// status (the client's error policy keys on the code, not on a falsy result).
		const nonAdmin: ApiRequestContext = {
			requestId: 'test',
			clientIp: '127.0.0.1',
			session: {
				userId: 999999,
				username: 'nobody',
				isGlobalAdmin: false,
				csrfToken: 'tok',
				applicationLang: null,
				dataLang: null,
			},
			csrfCandidate: 'tok',
			principal: { userId: 999999, isGlobalAdmin: false, isDeveloper: false },
		};
		const outcome = await runWithRequestLangs(
			{ applicationLang: 'lg-spa', dataLang: 'lg-spa' },
			() => dispatchRqo(gridRqo('testcont1', '10', [seed('rsc', 205)]) as unknown as Rqo, nonAdmin),
		);
		expect(outcome.status).toBe(CATEGORY_STATUS[specOf('perm.denied').category]);
		expect(outcome.body.ok).toBe(false);
		expect((outcome.body.error as { code: string }).code).toBe('perm.denied');
	});
});
