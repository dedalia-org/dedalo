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
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedRepoFiles } from '../helpers/css_reference_corpus.ts';
import { INTERMITTENT, KNOWN_FAILING } from '../helpers/feature_crawl_ratchet.ts';
import { JOURNEYS, JOURNEYS_PENDING } from '../helpers/journey_cases.ts';
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
