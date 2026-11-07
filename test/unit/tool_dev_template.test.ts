/**
 * tool_dev_template — the EXEMPLAR, gated mechanically.
 *
 * This tool is not a feature: `scripts/create_tool.ts` COPIES it to scaffold every
 * new tool, and docs/development/tools/ cites it as the reference implementation.
 * So its correctness is STRUCTURAL — a drift here propagates into every future
 * tool. Per the project's "tripwire or delete" law this file turns the three
 * claims the exemplar makes into gates:
 *
 *  1. it demonstrates EVERY permission kind the contract declares — the union is
 *     PARSED out of src/core/tools/module.ts, so adding a sixth kind fails here
 *     until the exemplar shows it (with its required companion fields);
 *  2. its client half and its server half AGREE — every action the client posts
 *     through `tool_request` is a key of `apiActions` (before this gate the
 *     client called three actions that did not exist and answered
 *     `unauthorized_method`);
 *  3. it teaches THIS engine — no PHP-era vocabulary in a template that is
 *     copied verbatim (the PHP engine was decommissioned 2026-07-11).
 *
 * Plus the behavioural contract of the two seams a scaffolded tool most needs:
 * the `section_list` target extractor (fail-closed) and the background-only
 * `publishProgress` / `signal` pair.
 */
// Migrated to the generic `test` TLD 2026-08-19: the sectionTipos extractor is pure, so
// its targets are opaque tipos — they now name generic `test` sections.

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LIFECYCLE_KEYS } from '../../src/core/tools/module.ts';
import { tool } from '../../tools/tool_dev_template/server/index.ts';

const REPO_ROOT = resolve(import.meta.dir, '../..');
const TOOL_DIR = resolve(REPO_ROOT, 'tools/tool_dev_template');

/**
 * The permission union, read from the contract source itself. Parsing the type
 * is what makes this a tripwire rather than a duplicated list: the assertion can
 * never silently agree with a stale copy of the union.
 */
function contractPermissionKinds(): string[] {
	const source = readFileSync(resolve(REPO_ROOT, 'src/core/tools/module.ts'), 'utf8');
	const match = source.match(/\bpermission:\s*([^;]+);/);
	if (match === null) throw new Error('could not find the permission union in module.ts');
	const kinds = [...match[1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
	if (kinds.length === 0) throw new Error('the parsed permission union is empty');
	return kinds;
}

/** Every action name the client half posts through `tool_request`. */
function clientRequestedActions(): string[] {
	const jsDir = resolve(TOOL_DIR, 'js');
	const found = new Set<string>();
	for (const entry of readdirSync(jsDir)) {
		if (!entry.endsWith('.js')) continue;
		const source = readFileSync(resolve(jsDir, entry), 'utf8');
		const calls = /tool_request\(\s*\{[\s\S]{0,400}?action\s*:\s*'([^']+)'/g;
		for (const match of source.matchAll(calls)) {
			found.add(match[1]!);
		}
	}
	return [...found];
}

describe('tool_dev_template exemplar — contract coverage', () => {
	test('the module name matches its package directory', () => {
		expect(tool.name).toBe('tool_dev_template');
		expect(/^tool_[a-z0-9_]+$/.test(tool.name)).toBe(true);
	});

	test('EVERY permission kind the contract declares is demonstrated', () => {
		const declared = contractPermissionKinds();
		const demonstrated = new Set(
			Object.values(tool.apiActions).map((spec) => String(spec.permission)),
		);
		const missing = declared.filter((kind) => !demonstrated.has(kind));
		expect(
			missing,
			`tool_dev_template is the exemplar scripts/create_tool.ts copies: it must demonstrate every permission kind in ToolActionSpec. Missing: ${missing.join(', ')}`,
		).toEqual([]);
		// …plus the null-spec (handler-gated) action.
		expect(demonstrated.has('null')).toBe(true);
	});

	test("every 'section_list' action carries its REQUIRED sectionTipos extractor", () => {
		const batch = Object.entries(tool.apiActions).filter(
			([, spec]) => spec.permission === 'section_list',
		);
		expect(batch.length).toBeGreaterThan(0);
		for (const [name, spec] of batch) {
			expect(typeof spec.sectionTipos, `${name} must declare sectionTipos`).toBe('function');
		}
	});

	test("every 'targets' action carries its REQUIRED targets extractor", () => {
		const scoped = Object.entries(tool.apiActions).filter(
			([, spec]) => spec.permission === 'targets',
		);
		expect(scoped.length).toBeGreaterThan(0);
		for (const [name, spec] of scoped) {
			expect(typeof spec.targets, `${name} must declare targets`).toBe('function');
			// The exemplar's extractor derives the (sqo section × selected component)
			// pairs — the shape a scaffolded batch tool copies.
			expect(
				spec.targets!({
					sqo: { section_tipo: ['test3'] },
					components_selection: [{ tipo: 'test52' }],
				}),
			).toEqual([{ section_tipo: 'test3', tipo: 'test52' }]);
			expect(spec.targets!({})).toEqual([]);
		}
	});

	test('the exemplar demonstrates the read-only declaration: literal true, explicit minLevel 1, never background', () => {
		// `readOnly` is a claim the dispatcher acts on (no idempotency ledger, the
		// read-only request scope — tool_read_only_action_tripwire proves it holds), so
		// the exemplar every scaffolded tool is copied from must show its full shape.
		const declared = Object.entries(tool.apiActions).filter(([, spec]) => spec.readOnly === true);
		expect(declared.map(([name]) => name)).toEqual(['read_demo']);
		const [, spec] = declared[0] as [string, (typeof tool.apiActions)[string]];
		expect(spec.minLevel).toBe(1);
		expect(tool.backgroundRunnable ?? []).not.toContain('read_demo');
	});

	test('backgroundRunnable is a non-empty subset of apiActions', () => {
		const background = tool.backgroundRunnable ?? [];
		expect(background.length).toBeGreaterThan(0);
		const unknown = background.filter((name) => !Object.hasOwn(tool.apiActions, name));
		expect(unknown).toEqual([]);
	});

	test('the lifecycle hooks are present and never listed as actions', () => {
		expect(typeof tool.isAvailable).toBe('function');
		expect(typeof tool.onRegister).toBe('function');
		expect(typeof tool.onRemove).toBe('function');
		const leaked = LIFECYCLE_KEYS.filter((key) => Object.hasOwn(tool.apiActions, key));
		expect(leaked).toEqual([]);
	});

	test('every action spec is a permission + a function handler', () => {
		for (const [name, spec] of Object.entries(tool.apiActions)) {
			expect(typeof spec.handler, `${name}.handler`).toBe('function');
			expect(spec, `${name}.permission`).toHaveProperty('permission');
		}
	});
});

describe('tool_dev_template exemplar — client/server agreement', () => {
	test('every action the client posts exists in apiActions', () => {
		const requested = clientRequestedActions();
		expect(requested.length).toBeGreaterThan(0);
		const orphans = requested.filter((action) => !Object.hasOwn(tool.apiActions, action));
		expect(
			orphans,
			`the exemplar's client calls actions its server module does not expose (dispatch answers unauthorized_method): ${orphans.join(', ')}`,
		).toEqual([]);
	});

	test('the template teaches THIS engine — no PHP-era references', () => {
		const offenders: string[] = [];
		for (const dir of ['js', 'server'] as const) {
			const base = resolve(TOOL_DIR, dir);
			for (const entry of readdirSync(base)) {
				if (!/\.(js|ts)$/.test(entry)) continue;
				const source = readFileSync(resolve(base, entry), 'utf8');
				source.split('\n').forEach((line, index) => {
					if (/\bphp\b|\bPHP\b|API_ACTIONS|BACKGROUND_RUNNABLE/.test(line)) {
						offenders.push(`${dir}/${entry}:${index + 1}`);
					}
				});
			}
		}
		expect(offenders).toEqual([]);
	});
});

describe('tool_dev_template exemplar — the seams a scaffolded tool copies', () => {
	function context(options: Record<string, unknown>, extra: Record<string, unknown> = {}) {
		return {
			principal: { userId: 1, isGlobalAdmin: true, isDeveloper: true },
			userId: 1,
			options,
			background: false,
			...extra,
		} as Parameters<(typeof tool.apiActions)['status']['handler']>[0];
	}

	test('sectionTipos extracts every batch target and stays fail-closed on junk', () => {
		const extract = tool.apiActions.batch_demo?.sectionTipos;
		expect(typeof extract).toBe('function');
		expect(extract?.({ items: [{ section_tipo: 'test3' }, { section_tipo: 'test6099' }] })).toEqual(
			['test3', 'test6099'],
		);
		// No items → an EMPTY target list, which assertActionPermission denies.
		expect(extract?.({})).toEqual([]);
		expect(extract?.({ items: 'not-an-array' })).toEqual([]);
	});

	test('long_job publishes progress under the background executor', async () => {
		const frames: object[] = [];
		const response = await tool.apiActions.long_job!.handler(
			context({}, { background: true, publishProgress: (data: object) => frames.push(data) }),
		);
		expect(frames.length).toBeGreaterThan(0);
		expect(response.data).toMatchObject({ ran_in_background: true, aborted: false });
	});

	test('long_job runs foreground with no publishProgress (the seam is optional)', async () => {
		const response = await tool.apiActions.long_job!.handler(context({}));
		expect(response.data).toMatchObject({ started: true, ran_in_background: false });
	});

	test('long_job honours an aborted signal at the loop boundary', async () => {
		const controller = new AbortController();
		controller.abort();
		const response = await tool.apiActions.long_job!.handler(
			context({}, { background: true, signal: controller.signal }),
		);
		expect(response.data).toMatchObject({ aborted: true, steps_done: 0 });
	});

	test('the demo handlers return envelope v2 (ok/data), never a legacy body', async () => {
		for (const name of ['status', 'developer_demo'] as const) {
			const response = await tool.apiActions[name]!.handler(context({}));
			expect(response.ok, name).toBe(true);
			expect(response.data, name).toBeDefined();
			// The exemplar must not teach the retired shape.
			expect(response.msg, name).toBeUndefined();
		}
		const batch = await tool.apiActions.batch_demo!.handler(
			context({ items: [{ section_tipo: 'test3' }] }),
		);
		expect(batch.data).toEqual({ batch: 1, gated: true });
	});
});
