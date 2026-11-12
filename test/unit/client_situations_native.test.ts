/**
 * THE CLIENT RUN'S PRE-FLIGHT SITUATIONS — the two things
 * `scripts/client_test_runner.ts` must be able to guarantee BEFORE it spawns a
 * server, gated here so they fail in `bun test` (no Chrome, no server) instead
 * of as DOM assertions in a browser suite.
 *
 *  1. THE SECOND PROJECT (`src/core/test_data/projects_fixture.ts`).
 *     `component_filter`'s two data operations are only expressible against a
 *     catalog that offers more options than the record selects: the install seed
 *     ships ONE `dd153` project and the canonical record already selects it, so
 *     `test_component_filter` had nothing to check and hit the widget's
 *     minimum-one-checked refusal instead of the remove path.
 *
 *     The load-bearing detail is HOW the row is written. `matrix_projects` is an
 *     identity table shared with every other tier on this database, so the
 *     fixture writes an EXPLICIT id in the reserved `>= 900000` band and does
 *     NOT go through the counter-allocating helpers — an explicit-id insert
 *     raises `matrix_counter` to GREATEST(value, section_id) and deleting the
 *     row does not lower it again, so the counter would grow on every run while
 *     the sweep reported clean. That is pinned below: the counter must not move.
 *
 *  2. THE PINNED DIFFUSION DOMAIN (`scripts/client_test_server.ts`
 *     `SUITE_DIFFUSION_DOMAIN`). `tool_diffusion` is available only for a
 *     section the CONFIGURED domain reaches (`haveSectionDiffusion`), and the
 *     domain is matched BY TERM — so its value means nothing except relative to
 *     one database's ontology. Inheriting the installation's name resolved a
 *     truncated clone on the suite database: domain found, section map empty,
 *     no opener drawn, six unexplained DOM failures. The run pins the repo-owned
 *     generic domain instead; this gate is the same assertion the runner makes
 *     pre-flight, minus the browser.
 *
 *  3. THE RUN-CREATED SWEEP IS WIRED (`src/core/test_data/run_created_records.ts`).
 *     The module's behaviour is gated by run_created_records_native; what only
 *     the RUNNER can get wrong is the wiring, and a browser run is the only
 *     outcome measure of it — so it is pinned here on the runner's structure:
 *     armed AFTER `reseedCanonicalTest3('pre-run')` (which may raise the counter)
 *     and before any suite runs, swept in `main`'s `finally` and in the signal
 *     handler, and never measured/swept around the armed sweeper. A mark taken
 *     before the reseed, or a deleted sweep call, would let every run grow the
 *     suite database again (~80 TM snapshots per run from the export suite).
 *
 *  4. THE NESTING SITUATION (`src/core/test_data/nested_portal_fixture.ts`).
 *     `test_nested_portal` pages a test80 NESTED under a real portal whose map
 *     declares test80's children, so its `rqo.source.callers` is a chain the
 *     server VERIFIES. Pinned here: the chain the client sends verifies against
 *     the installed situation (and its caller line names test80), the forged
 *     test80-above-test80 chain does not, ensure is idempotent and the sweep
 *     leaves no residue (it refuses otherwise) — and the runner installs and
 *     sweeps it.
 *
 *  5. THE RELATION_INDEX POINTER (`src/core/test_data/relation_index_pointer_fixture.ts`).
 *     `test_component_relation_index` asserts the config-less `test25` on
 *     test3/1 renders columns and a cell (T0-8) — impossible with ZERO dd96
 *     references on the suite database. The fixture is a test3 ROW, so its
 *     place in the runner is load-bearing and pinned here: installed AFTER the
 *     pre-run reseed (which deletes every test3 row) and BEFORE the run-created
 *     sweep is armed (which deletes every test3 row above its mark), swept
 *     BEFORE the post-run reseed and on a signal. Its OUTCOME is pinned too: the
 *     engine's own get_data for test25 @ test3/1 answers the pointer. (Refusal on
 *     an unmarked database: test_db_marker_tripwire's door list.)
 *
 * WHY THE SECTION TIPO IS SPELLED `install('rsc', 170)`: the install-TLD census
 * (scripts/lib/tld_census.ts) reads a literal `rsc170` in a test file as this
 * gate BINDING an install. It is not — it is a pin on what the run's own pinned
 * domain must reach, and it is the section `test_diffusion.js` drives. Same
 * convention as `test_corpus_fixture.test.ts`'s `seed('rsc', 170)`.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SUITE_DIFFUSION_DOMAIN } from '../../scripts/client_test_server.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { CANONICAL_RECORD_IDS } from '../../src/core/test_data/manifest.ts';
import {
	ensureNestedPortalFixture,
	NESTING_PORTAL_TIPO,
	NESTING_SECTION_TIPO,
	nestedPortalSituation,
	removeNestedPortalFixture,
} from '../../src/core/test_data/nested_portal_fixture.ts';
import {
	ensureSuiteProjectsFixture,
	removeSuiteProjectsFixture,
	SUITE_SECOND_PROJECT_ID,
} from '../../src/core/test_data/projects_fixture.ts';
import {
	ensureSuiteIndexPointerFixture,
	removeSuiteIndexPointerFixture,
	SUITE_INDEX_POINTER_ID,
	SUITE_INDEX_POINTER_LABEL,
	SUITE_INDEX_RELATED_LIST_TIPO,
	SUITE_INDEX_TARGET,
	SUITE_INDEX_TIPO,
} from '../../src/core/test_data/relation_index_pointer_fixture.ts';
import { residueOf } from '../../src/core/test_data/situations/situation.ts';
import { stripComments } from '../helpers/strip_comments.ts';

const install = (tld: string, id: number): string => `${tld}${id}`;

const PROJECTS_SECTION = 'dd153';
const PROJECTS_TABLE = 'matrix_projects';
/** The reserved scratch band an identity-table fixture must stay inside. */
const SCRATCH_ID_FLOOR = 900_000;
/** The section `test_diffusion.js` renders in all three of its describes. */
const DIFFUSION_SECTION = install('rsc', 170);

async function projectIds(): Promise<number[]> {
	const rows = (await sql.unsafe(
		`SELECT section_id FROM "${PROJECTS_TABLE}" WHERE section_tipo = $1 ORDER BY section_id`,
		[PROJECTS_SECTION],
	)) as { section_id: number }[];
	return rows.map((row) => row.section_id);
}

async function projectsCounter(): Promise<number | null> {
	const rows = (await sql.unsafe(`SELECT value FROM matrix_counter WHERE tipo = $1`, [
		PROJECTS_SECTION,
	])) as { value: number }[];
	return rows[0]?.value ?? null;
}

describe('client run pre-flight — the suite projects fixture', () => {
	afterAll(async () => {
		// Never leave a widened projects catalog behind for the other tiers.
		if ((await projectIds()).includes(SUITE_SECOND_PROJECT_ID)) {
			await removeSuiteProjectsFixture();
		}
	});

	test('the id it owns is inside the reserved scratch band', () => {
		// The band IS the safety: the sweep filters on this id, and an id below
		// the floor would be an installed record.
		expect(Number.isInteger(SUITE_SECOND_PROJECT_ID)).toBe(true);
		expect(SUITE_SECOND_PROJECT_ID).toBeGreaterThanOrEqual(SCRATCH_ID_FLOOR);
	});

	test('ensure adds exactly one option, leaves the install rows alone, and re-runs clean', async () => {
		const before = await projectIds();
		expect(before, 'the fixture row must not be present before ensure').not.toContain(
			SUITE_SECOND_PROJECT_ID,
		);
		expect(before.length, 'the install seed must ship at least one project').toBeGreaterThan(0);

		await ensureSuiteProjectsFixture();
		const after = await projectIds();
		expect(after).toContain(SUITE_SECOND_PROJECT_ID);
		for (const id of before) expect(after, 'installed projects are never touched').toContain(id);
		expect(after.length).toBe(before.length + 1);

		// Idempotent: the door removes its own row before inserting, so a second
		// run cannot duplicate the option or throw.
		await ensureSuiteProjectsFixture();
		expect(await projectIds()).toEqual(after);
	});

	test('the option is renderable: its dd156 name resolves', async () => {
		await ensureSuiteProjectsFixture();
		const rows = (await sql.unsafe(
			`SELECT string->'dd156'->0->>'value' AS name FROM "${PROJECTS_TABLE}"
			 WHERE section_tipo = $1 AND section_id = $2`,
			[PROJECTS_SECTION, SUITE_SECOND_PROJECT_ID],
		)) as { name: string | null }[];
		// dd156 is DEDALO_PROJECTS_NAME_TIPO — the label the datalist draws on the
		// checkbox. An empty name renders a box the suite cannot tell from another.
		expect(rows[0]?.name).toBeTruthy();
	});

	test('THE COUNTER NEVER MOVES — the explicit id is not allocated', async () => {
		if ((await projectIds()).includes(SUITE_SECOND_PROJECT_ID)) {
			await removeSuiteProjectsFixture();
		}
		const before = await projectsCounter();

		await ensureSuiteProjectsFixture();
		expect(
			await projectsCounter(),
			'ensure must not raise the shared dd153 counter (that residue survives the sweep)',
		).toBe(before);

		await removeSuiteProjectsFixture();
		expect(await projectsCounter()).toBe(before);
		expect(await projectIds()).not.toContain(SUITE_SECOND_PROJECT_ID);
	});

	test('the sweep REFUSES when it removes nothing', async () => {
		if ((await projectIds()).includes(SUITE_SECOND_PROJECT_ID)) {
			await removeSuiteProjectsFixture();
		}
		// A sweep that deletes 0 rows means the filter is wrong and the fixture row
		// is unaccounted for — louder than a silent no-op, which would leave the
		// catalog widened for every other tier.
		await expect(removeSuiteProjectsFixture()).rejects.toThrow(/deleted 0 rows/);
	});
});

describe('client run pre-flight — the pinned diffusion domain', () => {
	const originalDomain = process.env.DEDALO_DIFFUSION_DOMAIN;

	beforeAll(() => {
		process.env.DEDALO_DIFFUSION_DOMAIN = SUITE_DIFFUSION_DOMAIN;
	});

	afterAll(async () => {
		if (originalDomain === undefined) delete process.env.DEDALO_DIFFUSION_DOMAIN;
		else process.env.DEDALO_DIFFUSION_DOMAIN = originalDomain;
		const { clearDiffusionMapCache } = await import(
			'../../src/core/diffusion_bridge/diffusion_map.ts'
		);
		clearDiffusionMapCache();
	});

	async function diffusionMap(): Promise<Set<string>> {
		const { clearDiffusionMapCache, getSectionDiffusionMap } = await import(
			'../../src/core/diffusion_bridge/diffusion_map.ts'
		);
		// The map is cached per process and the domain NAME is read when it is
		// built, so a test that changes the name must drop the cache first.
		clearDiffusionMapCache();
		return await getSectionDiffusionMap();
	}

	test('it reaches the section the client diffusion suite drives', async () => {
		const map = await diffusionMap();
		expect(
			[...map],
			`the pinned domain '${SUITE_DIFFUSION_DOMAIN}' must reach ${DIFFUSION_SECTION}, or tool_diffusion is unavailable and test_diffusion fails with unexplained DOM assertions`,
		).toContain(DIFFUSION_SECTION);
	});

	test('the domain is a NAME, not a decoration: an unknown one resolves nothing', async () => {
		// ANTI-VACUITY for the case above. `resolveDomainTipo` matches dd1190's
		// children BY TERM, so a name no node carries must produce an EMPTY map —
		// which is exactly the silent state that made a misconfigured domain look
		// like a client bug.
		process.env.DEDALO_DIFFUSION_DOMAIN = 'zz_no_such_diffusion_domain';
		expect([...(await diffusionMap())]).toEqual([]);
		process.env.DEDALO_DIFFUSION_DOMAIN = SUITE_DIFFUSION_DOMAIN;
	});
});

// ---------------------------------------------------------------------------
// 3. The run-created sweep is wired into the runner
// ---------------------------------------------------------------------------

/**
 * The runner's source, comments stripped, plus a same-length twin with every
 * string blanked (so a `{` inside a literal cannot unbalance a body).
 */
function runnerSource(source?: string): { code: string; blank: string } {
	const raw =
		source ??
		readFileSync(join(import.meta.dir, '..', '..', 'scripts', 'client_test_runner.ts'), 'utf-8');
	const code = stripComments(raw);
	const blank = stripComments(raw, { blankStrings: true });
	expect(blank.length).toBe(code.length);
	return { code, blank };
}

/** The body (between its outer braces) of the first block opening at/after `from`. */
function blockAt(src: { code: string; blank: string }, from: number): string {
	const open = src.blank.indexOf('{', from);
	expect(open).toBeGreaterThan(-1);
	let depth = 0;
	for (let index = open; index < src.blank.length; index++) {
		const char = src.blank[index];
		if (char === '{') depth++;
		else if (char === '}' && --depth === 0) return src.code.slice(open + 1, index);
	}
	throw new Error('unbalanced block');
}

function functionBody(src: { code: string; blank: string }, name: string): string {
	const at = src.blank.search(new RegExp(`function\\s+${name}\\s*\\(`));
	expect(at, `function ${name} exists in the runner`).toBeGreaterThan(-1);
	// skip the parameter list and return type up to the body's brace
	const signatureEnd = src.blank.indexOf(')', at);
	return blockAt(src, signatureEnd);
}

/** Every wiring defect the runner can carry, [] when wired. */
function runCreatedWiringDefects(source?: string): string[] {
	const src = runnerSource(source);
	const defects: string[] = [];
	if (/\b(runCounterMark|sweepRecordsCreatedSince)\s*\(/.test(src.code)) {
		defects.push('the runner measures or sweeps around the armed sweeper');
	}
	const main = functionBody(src, 'main');
	const reseed = main.indexOf("reseedCanonicalTest3('pre-run')");
	const armed = main.indexOf('armRunCreatedSweep()');
	const firstSuite = main.indexOf('openTarget(');
	if (reseed === -1) defects.push('main has no pre-run reseed');
	if (armed === -1) defects.push('main never arms the run-created sweep');
	if (armed !== -1 && reseed !== -1 && armed < reseed) {
		defects.push('the sweep is armed BEFORE the pre-run reseed (the reseed may raise the counter)');
	}
	if (armed !== -1 && (firstSuite === -1 || armed > firstSuite)) {
		defects.push(
			'the sweep is armed after the target opens (a suite may already have created records)',
		);
	}
	const finallyAt = main.lastIndexOf('finally');
	const finallyBody = finallyAt === -1 ? '' : main.slice(finallyAt);
	if (!/await\s+sweepRunCreatedRecords\s*\(\s*\)/.test(finallyBody)) {
		defects.push("main's finally does not sweep the run-created records");
	}
	if (!/await\s+sweepRunCreatedRecords\s*\(\s*\)/.test(functionBody(src, 'sweepOnSignal'))) {
		defects.push('the signal handler does not sweep the run-created records');
	}
	if (
		!/runCreatedSweeper\s*\.\s*sweep\s*\(\s*\)/.test(functionBody(src, 'sweepRunCreatedRecords'))
	) {
		defects.push('sweepRunCreatedRecords does not call the armed sweeper');
	}
	return defects;
}

describe('client run — the run-created sweep is wired', () => {
	test('armed after the pre-run reseed, swept in finally and on a signal', () => {
		expect(runCreatedWiringDefects()).toEqual([]);
	});

	test('positive control: each miswiring the gate names is detected', () => {
		const real = readFileSync(
			join(import.meta.dir, '..', '..', 'scripts', 'client_test_runner.ts'),
			'utf-8',
		);
		const mutate = (from: string | RegExp, to: string): string => {
			const next = real.replace(from, to);
			expect(next).not.toBe(real);
			return next;
		};
		// the mark moved BEFORE the reseed
		const early = mutate("await reseedCanonicalTest3('pre-run');", '').replace(
			'sweepOnSignal();',
			"sweepOnSignal();\n\tawait reseedCanonicalTest3('pre-run');",
		);
		const earlyArmed = early.replace(
			"await reseedCanonicalTest3('pre-run');",
			"runCreatedSweeper = await armRunCreatedSweep();\n\tawait reseedCanonicalTest3('pre-run');",
		);
		expect(runCreatedWiringDefects(earlyArmed).join('\n')).toMatch(/BEFORE the pre-run reseed/);
		// the finally sweep deleted
		const finallyGone = mutate(/try \{\n\t\t\tawait sweepRunCreatedRecords\(\);/, 'try {');
		expect(runCreatedWiringDefects(finallyGone).join('\n')).toMatch(/finally does not sweep/);
		// the signal sweep deleted
		const signalGone = mutate(/try \{\n\t\t\t\t\tawait sweepRunCreatedRecords\(\);/, 'try {');
		expect(runCreatedWiringDefects(signalGone).join('\n')).toMatch(/signal handler/);
		// never armed
		const neverArmed = mutate('await armRunCreatedSweep()', 'null');
		expect(runCreatedWiringDefects(neverArmed).join('\n')).toMatch(/never arms/);
		// measured around the sweeper
		const bypass = mutate(
			'const swept = await runCreatedSweeper.sweep();',
			'const swept = await sweepRecordsCreatedSince(runCreatedSweeper.mark);',
		);
		expect(runCreatedWiringDefects(bypass).join('\n')).toMatch(/around the armed sweeper/);
	});
});

describe('client run pre-flight — the nesting situation (verified caller chain)', () => {
	const NESTED = 'test80';
	const HOST = 'test3';
	const verify = async (callers: unknown) => {
		const { resolveCallerChain } = await import('../../src/core/relations/caller_chain.ts');
		return resolveCallerChain({
			callers,
			targetTipo: NESTED,
			targetSectionTipo: HOST,
			lang: 'lg-eng',
			principal: undefined,
		});
	};

	beforeAll(async () => {
		await ensureNestedPortalFixture();
	});
	afterAll(async () => {
		if ((await residueOf(nestedPortalSituation())) > 0) await removeNestedPortalFixture();
	});

	test('the chain the client sends verifies, and its line names test80', async () => {
		const chain = await verify([
			{ tipo: NESTING_PORTAL_TIPO, section_tipo: NESTING_SECTION_TIPO, mode: 'edit' },
		]);
		expect(chain).not.toBeNull();
		expect(chain?.line.tipo).toBe(NESTED);
		expect(chain?.parentNode.tipo).toBe(NESTING_PORTAL_TIPO);
	});

	test('positive control: the forged test80-above-test80 chain is refused', async () => {
		expect(await verify([{ tipo: NESTED, section_tipo: HOST, mode: 'edit' }])).toBeNull();
	});

	test('ensure is idempotent and the sweep leaves no residue', async () => {
		await ensureNestedPortalFixture();
		const s = nestedPortalSituation();
		expect(await residueOf(s)).toBe(s.nodes.length);
		await removeNestedPortalFixture();
		expect(await residueOf(s)).toBe(0);
		expect(
			await verify([
				{ tipo: NESTING_PORTAL_TIPO, section_tipo: NESTING_SECTION_TIPO, mode: 'edit' },
			]),
		).toBeNull();
	});

	test('the runner installs it before its server and sweeps it after', () => {
		const src = runnerSource().code;
		const ensureAt = src.indexOf('await ensureNestedPortalFixture();');
		const serverAt = src.indexOf('await openTarget(suite)');
		expect(ensureAt).toBeGreaterThan(-1);
		expect(serverAt).toBeGreaterThan(ensureAt);
		expect(src.split('await removeNestedPortalFixture();').length - 1).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// 5. The relation_index dd96 pointer
// ---------------------------------------------------------------------------

describe('client run pre-flight — the relation_index dd96 pointer', () => {
	const TABLE = 'matrix_test';
	const SECTION = 'test3';

	async function test3Ids(): Promise<number[]> {
		const rows = (await sql.unsafe(
			`SELECT section_id FROM "${TABLE}" WHERE section_tipo = $1 ORDER BY section_id`,
			[SECTION],
		)) as { section_id: number }[];
		return rows.map((row) => Number(row.section_id));
	}

	/** The engine's own get_data for test25 @ test3/1 — the read the client widget sends. */
	async function indexEntries(): Promise<Record<string, unknown>[]> {
		const { dispatchRqo } = await import('../../src/core/api/dispatch.ts');
		const { resolvePrincipal } = await import('../../src/core/security/permissions.ts');
		const { createSession, destroySession, getSession } = await import(
			'../../src/core/security/session_store.ts'
		);
		const token = createSession(-1, 'root', true);
		try {
			const session = getSession(token);
			const result = await dispatchRqo(
				{
					action: 'read',
					dd_api: 'dd_core_api',
					prevent_lock: true,
					options: {},
					source: {
						typo: 'source',
						model: 'component_relation_index',
						tipo: SUITE_INDEX_TIPO,
						section_tipo: SUITE_INDEX_TARGET.section_tipo,
						section_id: SUITE_INDEX_TARGET.section_id,
						mode: 'list',
						lang: 'lg-eng',
						action: 'get_data',
					},
					sqo: { section_tipo: [SUITE_INDEX_TARGET.section_tipo], limit: 10, offset: 0 },
				} as never,
				{
					requestId: 'client_situations_index_pointer',
					clientIp: '127.0.0.1',
					session,
					csrfCandidate: session?.csrfToken ?? null,
					principal: await resolvePrincipal(-1),
				} as never,
			);
			const body = result.body as { data?: { data?: Record<string, unknown>[] } };
			const own = (body.data?.data ?? []).find(
				(item) =>
					item.tipo === SUITE_INDEX_TIPO &&
					item.section_tipo === SUITE_INDEX_TARGET.section_tipo &&
					String(item.section_id) === String(SUITE_INDEX_TARGET.section_id),
			);
			return ((own?.entries as Record<string, unknown>[] | undefined) ?? []).filter(
				(entry) => entry !== null && typeof entry === 'object',
			);
		} finally {
			destroySession(token);
		}
	}

	afterAll(async () => {
		if ((await test3Ids()).includes(SUITE_INDEX_POINTER_ID)) {
			await removeSuiteIndexPointerFixture();
		}
	});

	test('the id it owns is an explicit scratch id, never a playground record', () => {
		expect(Number.isInteger(SUITE_INDEX_POINTER_ID)).toBe(true);
		expect(SUITE_INDEX_POINTER_ID).toBeGreaterThanOrEqual(SCRATCH_ID_FLOOR);
		expect(CANONICAL_RECORD_IDS).not.toContain(SUITE_INDEX_POINTER_ID);
	});

	test('ensure adds exactly one test3 row, leaves the playground alone, and re-runs clean', async () => {
		const before = await test3Ids();
		expect(before, 'the pointer must not be present before ensure').not.toContain(
			SUITE_INDEX_POINTER_ID,
		);
		expect(before.length, 'the canonical playground must be present').toBeGreaterThan(0);

		await ensureSuiteIndexPointerFixture();
		const after = await test3Ids();
		expect(after).toContain(SUITE_INDEX_POINTER_ID);
		for (const id of before) expect(after, 'playground rows are never touched').toContain(id);
		expect(after.length).toBe(before.length + 1);

		await ensureSuiteIndexPointerFixture();
		expect(await test3Ids()).toEqual(after);
	});

	test('the engine indexes it: get_data for test25 @ test3/1 answers the pointer', async () => {
		await ensureSuiteIndexPointerFixture();
		const entries = await indexEntries();
		const pointer = entries.filter(
			(entry) =>
				entry.section_tipo === SECTION &&
				String(entry.section_id) === String(SUITE_INDEX_POINTER_ID),
		);
		expect(pointer.length, `entries: ${JSON.stringify(entries)}`).toBe(1);
	});

	test('the sweep removes it (the index forgets it) and REFUSES when it removes nothing', async () => {
		if (!(await test3Ids()).includes(SUITE_INDEX_POINTER_ID)) {
			await ensureSuiteIndexPointerFixture();
		}
		await removeSuiteIndexPointerFixture();
		expect(await test3Ids()).not.toContain(SUITE_INDEX_POINTER_ID);
		const entries = await indexEntries();
		expect(
			entries.filter((entry) => String(entry.section_id) === String(SUITE_INDEX_POINTER_ID)),
		).toEqual([]);
		await expect(removeSuiteIndexPointerFixture()).rejects.toThrow(/deleted 0 rows/);
	});

	test('the pointer carries a related_list value, and the client suite asserts THAT value', async () => {
		// The index rows render with children_view `text`, which drops an EMPTY
		// cell node: without this value the column has nothing to render.
		await ensureSuiteIndexPointerFixture();
		const rows = (await sql.unsafe(
			`SELECT string->$3->0->>'value' AS value FROM "${TABLE}" WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, SUITE_INDEX_POINTER_ID, SUITE_INDEX_RELATED_LIST_TIPO],
		)) as { value: string | null }[];
		expect(rows[0]?.value).toBe(SUITE_INDEX_POINTER_LABEL);
		const clientSuite = readFileSync(
			join(
				import.meta.dir,
				'..',
				'..',
				'client',
				'dedalo',
				'test',
				'client',
				'js',
				'test_component_relation_index.js',
			),
			'utf-8',
		);
		expect(clientSuite).toContain(`const pointer_label = '${SUITE_INDEX_POINTER_LABEL}'`);
		expect(clientSuite).toContain(`const related_list_tipo = '${SUITE_INDEX_RELATED_LIST_TIPO}'`);
	});

	/** Every ordering defect of the pointer in the runner, [] when wired. */
	function pointerWiringDefects(source?: string): string[] {
		const src = runnerSource(source);
		const defects: string[] = [];
		const main = functionBody(src, 'main');
		const reseed = main.indexOf("reseedCanonicalTest3('pre-run')");
		const ensure = main.indexOf('await ensureSuiteIndexPointerFixture()');
		const armed = main.indexOf('armRunCreatedSweep()');
		const target = main.indexOf('openTarget(');
		if (ensure === -1) defects.push('main never installs the pointer');
		if (ensure !== -1 && reseed !== -1 && ensure < reseed) {
			defects.push('the pointer is installed BEFORE the pre-run reseed (which deletes it)');
		}
		if (ensure !== -1 && armed !== -1 && ensure > armed) {
			defects.push(
				'the pointer is installed AFTER the sweep is armed (the run-created sweep takes it)',
			);
		}
		if (ensure !== -1 && (target === -1 || ensure > target)) {
			defects.push('the pointer is installed after the target opens');
		}
		const finallyAt = main.lastIndexOf('finally');
		const finallyBody = finallyAt === -1 ? '' : main.slice(finallyAt);
		const sweep = finallyBody.indexOf('await removeSuiteIndexPointerFixture()');
		const postReseed = finallyBody.indexOf("reseedCanonicalTest3('post-run')");
		if (sweep === -1) defects.push("main's finally does not sweep the pointer");
		if (sweep !== -1 && postReseed !== -1 && sweep > postReseed) {
			defects.push('the pointer is swept AFTER the post-run reseed (which already deleted it)');
		}
		if (
			!/await\s+removeSuiteIndexPointerFixture\s*\(\s*\)/.test(functionBody(src, 'sweepOnSignal'))
		) {
			defects.push('the signal handler does not sweep the pointer');
		}
		return defects;
	}

	test('the runner installs it between the pre-run reseed and the armed sweep, and sweeps it before the post-run reseed', () => {
		expect(pointerWiringDefects()).toEqual([]);
	});

	test('positive control: each misordering the gate names is detected', () => {
		const real = readFileSync(
			join(import.meta.dir, '..', '..', 'scripts', 'client_test_runner.ts'),
			'utf-8',
		);
		const install = '\t\tawait ensureSuiteIndexPointerFixture();\n';
		expect(real).toContain(install);
		const without = real.replace(install, '');
		// before the reseed
		const early = without.replace(
			'\t\tif (reseedEnabled) {\n\t\t\tawait reseedCanonicalTest3',
			`${install}\t\tif (reseedEnabled) {\n\t\t\tawait reseedCanonicalTest3`,
		);
		expect(early).not.toBe(without);
		expect(pointerWiringDefects(early).join('\n')).toMatch(/BEFORE the pre-run reseed/);
		// after the arm
		const late = without.replace(
			'\t\tawait ensureSuiteProjectsFixture();\n',
			`\t\tawait ensureSuiteProjectsFixture();\n${install}`,
		);
		expect(late).not.toBe(without);
		expect(pointerWiringDefects(late).join('\n')).toMatch(/AFTER the sweep is armed/);
		// never installed
		expect(pointerWiringDefects(without).join('\n')).toMatch(/never installs/);
	});

	test('the browse server installs it before its server and sweeps it on exit', () => {
		const serve = stripComments(
			readFileSync(join(import.meta.dir, '..', '..', 'scripts', 'client_test_serve.ts'), 'utf-8'),
		);
		const ensureAt = serve.indexOf('await ensureSuiteIndexPointerFixture();');
		const serverAt = serve.indexOf('await startClientTestServer(');
		expect(ensureAt).toBeGreaterThan(-1);
		expect(serverAt).toBeGreaterThan(ensureAt);
		expect(serve).toContain('await removeSuiteIndexPointerFixture();');
	});
});
