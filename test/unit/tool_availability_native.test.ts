/**
 * TOOL AVAILABILITY FAILS CLOSED — a tool whose server module exists but did
 * not load must be UNavailable, never "always available".
 *
 * The bug this gates: `toolIsAvailable` consulted the module's `isAvailable`
 * hook only when the loader held the module; a failed import (a missing npm
 * dependency — cheerio, 2026-10-07) dropped to the `return true` fallback, so a
 * section-scoped tool (the acquisition tools, gated to one section each) showed
 * in EVERY section's toolbar.
 *
 * Runs in a child process: the extra tool root comes from DEDALO_ADDITIONAL_TOOLS,
 * which the frozen config reads once at import. Fixtures are repo-owned
 * (test/fixtures/tool_roots/availability/) — a tmpdir root is refused by policy.
 * No DB: both decisions are taken before any registry/DB read.
 */

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const FIXTURE_ROOT = join(REPO_ROOT, 'test/fixtures/tool_roots/availability');

function probe(): Record<string, unknown> {
	const script = `
const loader = await import(${JSON.stringify(join(REPO_ROOT, 'src/core/tools/loader.ts'))});
const { toolIsAvailable } = await import(${JSON.stringify(join(REPO_ROOT, 'src/core/tools/registry.ts'))});
// The full availability context (T2-B5 O11-4, d9ced4da7f): the hook judges the
// element's REAL section (sectionTipo) and mode — for a section element both are its own.
const section = (tipo) => ({ calledClass: 'section', tipo, sectionTipo: tipo, mode: 'edit', isComponent: false, hasToolConfig: false });
console.log(JSON.stringify({
	failedRecorded: await loader.toolModuleFailedToLoad('tool_zz_load_fails'),
	healthyRecorded: await loader.toolModuleFailedToLoad('tool_zz_hook_gated'),
	failedAvailable: await toolIsAvailable('tool_zz_load_fails', section('test3')),
	hookIn: await toolIsAvailable('tool_zz_hook_gated', section('test3')),
	hookOut: await toolIsAvailable('tool_zz_hook_gated', section('test2')),
	noModule: await toolIsAvailable('tool_zz_no_module_on_disk', section('test3')),
}));
process.exit(0);`;
	const child = Bun.spawnSync([process.execPath, '-e', script], {
		cwd: REPO_ROOT,
		env: {
			...Bun.env,
			DEDALO_ADDITIONAL_TOOLS: JSON.stringify([{ path: FIXTURE_ROOT, url: '/zz_fixture_tools' }]),
		},
		stdout: 'pipe',
		stderr: 'pipe',
	});
	expect(child.exitCode, child.stderr.toString()).toBe(0);
	const lines = child.stdout.toString().trim().split('\n');
	return JSON.parse(lines[lines.length - 1] ?? '{}') as Record<string, unknown>;
}

describe('tool availability fails closed on a failed module load', () => {
	const out = probe();

	test('the loader records the failed load, and only that one', () => {
		expect(out.failedRecorded).toBe(true);
		expect(out.healthyRecorded).toBe(false);
	});

	test('a tool whose module failed to load is unavailable', () => {
		expect(out.failedAvailable).toBe(false);
	});

	test('a loaded module still owns the decision through its hook', () => {
		expect(out.hookIn).toBe(true);
		expect(out.hookOut).toBe(false);
	});

	test('a tool with no server module keeps the always-available fallback', () => {
		expect(out.noModule).toBe(true);
	});
});
