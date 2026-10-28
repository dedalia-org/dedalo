/**
 * FEATURE CRAWL TRIPWIRE (DEC-12) — the hermetic half of `bun run test:crawl`
 * (scripts/feature_crawl.ts, the browser half).
 *
 *  1. TOOL OPERATION TOTALITY: every tracked `tools/tool_*` directory is in
 *     exactly one of TOOL_OPERATED / TOOL_OPERATION_PENDING / grant-only; no
 *     stale name; each pending reason substantive; each piece of evidence
 *     resolves (a written journey, or a client suite that makes a request).
 *  2. JOURNEYS: written and pending are disjoint, reasons substantive, every
 *     journey names at least one persona.
 *  3. BASELINE SHAPE: every KNOWN_FAILING id is `<persona>:<tipo>:<mode>:<check>`
 *     with a reason.
 *  4. PERSONA CONTRAST (suite DB): the editor persona is not an admin, holds
 *     edit / read-only / no grant where the crawl expects it, and is out of
 *     scope for the other project's record — so the crawl's oracle can never
 *     go green at admin-vs-admin.
 *  5. ONE SUITE RUN AT A TIME (test/helpers/suite_run_lock.ts): the lock refuses a
 *     live holder, reclaims a dead one's, lets the holder's children through, and
 *     every runner that reseeds the suite fixtures takes it.
 *  6. COVERAGE FLOORS (engineering/crawl_inventory.json): the record carries its rule
 *     and real floors; a shortfall is named, and banking never lowers a floor.
 *  7. PAGE POSTURE BUDGET (engineering/crawl_posture_budget.json): per-rule page
 *     counts; a new rule or an overrun is red, banking only lowers.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackedRepoFiles } from '../helpers/css_reference_corpus.ts';
import {
	bankCrawlInventory,
	bankPostureBudget,
	CRAWL_INVENTORY_PATH,
	CRAWL_INVENTORY_RULE,
	CRAWL_POSTURE_PATH,
	CRAWL_POSTURE_RULE,
	type CrawlInventory,
	type CrawlPostureBudget,
	crawlCoverageShortfalls,
	INTERMITTENT,
	KNOWN_FAILING,
	postureOverruns,
} from '../helpers/feature_crawl_ratchet.ts';
import { JOURNEYS, JOURNEYS_PENDING } from '../helpers/journey_cases.ts';
import { acquireSuiteRunLock, suiteRunLockPath } from '../helpers/suite_run_lock.ts';
import { isGrantOnlyTool } from '../helpers/tool_directory_corpus.ts';
import { TOOL_OPERATED, TOOL_OPERATION_PENDING } from '../helpers/tool_operation_cases.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const CLIENT_SUITES = join(REPO_ROOT, 'client/dedalo/test/client/js');

describe('tool operation coverage', () => {
	const toolDirs = [
		...new Set(
			trackedRepoFiles()
				.map((file) => file.match(/^tools\/(tool_[^/]+)\//)?.[1])
				.filter((name): name is string => name !== undefined),
		),
	].sort();

	test('census floor (anti-vacuity)', () => {
		expect(toolDirs.length).toBeGreaterThan(30);
	});

	test('every tool is in exactly one list, no stale names', () => {
		const operated = Object.keys(TOOL_OPERATED);
		const pending = Object.keys(TOOL_OPERATION_PENDING);
		const grantOnly = toolDirs.filter(isGrantOnlyTool);
		expect(operated.filter((n) => pending.includes(n))).toEqual([]);
		expect([...operated, ...pending].filter((n) => grantOnly.includes(n))).toEqual([]);
		expect([...operated, ...pending, ...grantOnly].sort()).toEqual(toolDirs);
	});

	test('pending reasons are substantive', () => {
		for (const [name, reason] of Object.entries(TOOL_OPERATION_PENDING))
			expect(`${name}: ${reason.trim().length >= 8}`).toBe(`${name}: true`);
	});

	test('evidence resolves', () => {
		for (const [name, evidence] of Object.entries(TOOL_OPERATED)) {
			const [kind, ref] = evidence.split(':') as [string, string];
			if (kind === 'journey') {
				expect(`${name}: ${ref in JOURNEYS}`).toBe(`${name}: true`);
			} else {
				expect(kind).toBe('client');
				const file = join(CLIENT_SUITES, ref);
				expect(`${name}: ${existsSync(file)}`).toBe(`${name}: true`);
				// a suite that never asks the server anything proves wiring, not operation
				expect(
					`${name}: ${/tool_request|data_manager\.request|api\(|fetch\(/.test(readFileSync(file, 'utf8'))}`,
				).toBe(`${name}: true`);
			}
		}
	});
});

describe('journeys', () => {
	test('written and pending are disjoint; reasons substantive', () => {
		expect(Object.keys(JOURNEYS).filter((n) => n in JOURNEYS_PENDING)).toEqual([]);
		for (const [name, reason] of Object.entries(JOURNEYS_PENDING))
			expect(`${name}: ${reason.trim().length >= 8}`).toBe(`${name}: true`);
		expect(Object.keys(JOURNEYS).length).toBeGreaterThan(0);
	});

	test('every journey names a persona', () => {
		for (const [name, j] of Object.entries(JOURNEYS))
			expect(`${name}: ${j.personas.length > 0}`).toBe(`${name}: true`);
	});
});

describe('crawl baseline', () => {
	test('KNOWN_FAILING ids are well-formed and reasoned', () => {
		for (const [id, reason] of [...KNOWN_FAILING, ...INTERMITTENT]) {
			expect(id).toMatch(/^(root|admin|editor):[^:]+:[^:]+:.+$/);
			expect(`${id}: ${reason.trim().length >= 8}`).toBe(`${id}: true`);
		}
	});

	test('an id is either KNOWN_FAILING or INTERMITTENT, never both', () => {
		expect([...INTERMITTENT.keys()].filter((id) => KNOWN_FAILING.has(id))).toEqual([]);
	});
});

describe('crawl personas (suite DB)', () => {
	let fixture: typeof import('../helpers/crawl_persona_fixture.ts');
	beforeAll(async () => {
		await import('../../src/core/components/registry.ts');
		fixture = await import('../helpers/crawl_persona_fixture.ts');
		await fixture.installCrawlPersonaFixture();
	});
	afterAll(async () => {
		await fixture.removeCrawlPersonaFixture();
	});

	test('editor: not admin, edit / read-only / hidden / denied, project-scoped', async () => {
		const { resolvePrincipal, getPermissions } = await import(
			'../../src/core/security/permissions.ts'
		);
		const { principalCanAccessRecord } = await import('../../src/core/security/record_scope.ts');
		const editor = await resolvePrincipal(fixture.CRAWL_EDITOR_USER_ID);
		const admin = await resolvePrincipal(fixture.CRAWL_ADMIN_USER_ID);
		const s = fixture.CRAWL_EDIT_SECTION;
		expect(editor.isGlobalAdmin).toBe(false);
		expect(admin.isGlobalAdmin).toBe(true);
		expect(await getPermissions(editor, s, fixture.CRAWL_TEXT_COMPONENT)).toBe(2);
		expect(await getPermissions(editor, s, fixture.CRAWL_READONLY_COMPONENT)).toBe(1);
		expect(await getPermissions(editor, s, fixture.CRAWL_HIDDEN_COMPONENT)).toBe(0);
		expect(
			await getPermissions(editor, fixture.CRAWL_DENIED_SECTION, fixture.CRAWL_DENIED_SECTION),
		).toBe(0);
		expect(await principalCanAccessRecord(s, fixture.CRAWL_RECORD_IN_A, editor)).toBe(true);
		expect(await principalCanAccessRecord(s, fixture.CRAWL_RECORD_IN_B, editor)).toBe(false);
		expect(await principalCanAccessRecord(s, fixture.CRAWL_RECORD_IN_B, admin)).toBe(true);
	});
});

describe('one suite run at a time — the suite run lock', () => {
	const TOKEN = 'DEDALO_SUITE_RUN_LOCK';
	let dir = '';
	let savedToken: string | undefined;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'suite_lock_'));
		savedToken = process.env[TOKEN]; // this very process holds the REAL lock (preload)
	});
	afterAll(() => {
		if (savedToken === undefined) delete process.env[TOKEN];
		else process.env[TOKEN] = savedToken;
		rmSync(dir, { recursive: true, force: true });
	});
	const plant = (db: string, pid: number) =>
		writeFileSync(
			suiteRunLockPath(db, dir),
			JSON.stringify({ pid, holder: 'lock holder', started: 'then' }),
		);

	test('free → taken; a second taker in another live process is refused, naming the holder', () => {
		const release = acquireSuiteRunLock('lockfree', 'lock test', { dir });
		expect(existsSync(suiteRunLockPath('lockfree', dir))).toBe(true);
		release();
		expect(existsSync(suiteRunLockPath('lockfree', dir))).toBe(false);
		plant('lockheld', process.ppid); // a live process that is not us
		delete process.env[TOKEN];
		expect(() => acquireSuiteRunLock('lockheld', 'lock test', { dir })).toThrow(
			/REFUSED.*lock holder/,
		);
	});

	test("a dead holder's lock is reclaimed; the holder's own children pass", () => {
		plant('lockstale', 2 ** 22 + 12345); // above macOS/Linux default pid_max: never alive
		acquireSuiteRunLock('lockstale', 'lock test', { dir })();
		plant('locknested', process.ppid);
		process.env[TOKEN] = `${suiteRunLockPath('locknested', dir)}#${process.ppid}`;
		expect(() => acquireSuiteRunLock('locknested', 'lock test', { dir })).not.toThrow();
		expect(JSON.parse(readFileSync(suiteRunLockPath('locknested', dir), 'utf8')).pid).toBe(
			process.ppid,
		);
	});

	test('every runner that reseeds the suite fixtures takes the lock', () => {
		for (const file of [
			'test/preload/canonical_test3.ts',
			'scripts/client_test_runner.ts',
			'scripts/feature_crawl.ts',
			'scripts/tool_viewport_check.ts',
			'scripts/client_test_serve.ts',
			'scripts/test_db_setup.ts',
		])
			expect(readFileSync(join(import.meta.dir, '../..', file), 'utf8')).toMatch(
				/acquireSuiteRunLock\(/,
			);
	});
});

describe('coverage floors — engineering/crawl_inventory.json', () => {
	const record = JSON.parse(
		readFileSync(join(import.meta.dir, '../..', CRAWL_INVENTORY_PATH), 'utf8'),
	) as CrawlInventory;

	test('the record carries its rule and real floors (three personas, every menu branch)', () => {
		expect(Object.keys(record).sort()).toEqual(['check_floor', 'page_floor', 'rule']);
		expect(record.rule).toBe(CRAWL_INVENTORY_RULE);
		expect(Number.isInteger(record.page_floor)).toBe(true);
		expect(Number.isInteger(record.check_floor)).toBe(true);
		expect(record.page_floor).toBeGreaterThan(500);
		expect(record.check_floor).toBeGreaterThan(record.page_floor);
	});

	test('a run below a floor is named; one at or above is not', () => {
		const floor = { rule: CRAWL_INVENTORY_RULE, page_floor: 10, check_floor: 100 };
		expect(crawlCoverageShortfalls(floor, { pages: 9, checks: 99 })).toHaveLength(2);
		expect(crawlCoverageShortfalls(floor, { pages: 10, checks: 100 })).toHaveLength(0);
	});

	test('banking raises a floor to the observed count less the slack, and never lowers one', () => {
		const floor = { rule: 'old', page_floor: 10, check_floor: 100 };
		expect(bankCrawlInventory(floor, { pages: 1000, checks: 90 })).toEqual({
			rule: CRAWL_INVENTORY_RULE,
			page_floor: 980,
			check_floor: 100,
		});
	});
});

describe('page posture budget — engineering/crawl_posture_budget.json', () => {
	test('the record carries its rule and only positive per-rule budgets', () => {
		const record = JSON.parse(
			readFileSync(join(import.meta.dir, '../..', CRAWL_POSTURE_PATH), 'utf8'),
		) as CrawlPostureBudget;
		expect(record.rule).toBe(CRAWL_POSTURE_RULE);
		const entries = Object.entries(record.budgets);
		expect(entries.length).toBeGreaterThan(0);
		for (const [key, pages] of entries) {
			expect(key).toMatch(/^(a11y:[a-z0-9-]+|keyboard|phone_overflow)$/);
			expect(Number.isInteger(pages) && pages > 0).toBe(true);
		}
	});

	test('an unbudgeted rule and an overrun are red; within budget is not', () => {
		const budget = { rule: CRAWL_POSTURE_RULE, budgets: { 'a11y:image-alt': 3 } };
		expect(postureOverruns(budget, { 'a11y:image-alt': 3 })).toHaveLength(0);
		expect(postureOverruns(budget, { 'a11y:image-alt': 4, keyboard: 1 })).toEqual([
			'a11y:image-alt: 4 pages, the budget is 3',
			'keyboard: 1 pages, a rule with no budget',
		]);
	});

	test('banking lowers a budget, drops a cleared rule, and never raises one', () => {
		const budget = { rule: 'old', budgets: { 'a11y:image-alt': 3, keyboard: 2 } };
		expect(bankPostureBudget(budget, { 'a11y:image-alt': 5, phone_overflow: 9 })).toEqual({
			rule: CRAWL_POSTURE_RULE,
			budgets: { 'a11y:image-alt': 3 },
		});
	});
});
