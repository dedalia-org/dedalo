/**
 * Tool loader: real packages load, and the contract is enforced. The scan runs
 * against the real repo tools/ root, so we assert on the packages we migrated
 * (tool_export, tool_time_machine) and exercise the validator directly for the
 * failure modes (bad export, name mismatch, lifecycle hook in apiActions).
 */
// Migrated to the generic `test` TLD 2026-08-19: the isAvailable probe only needs an
// opaque section tipo, so it names `test3` (the generic test section) instead of an
// install's.

import { describe, expect, test } from 'bun:test';
import { getLoadedTool, loadToolModules } from '../../src/core/tools/loader.ts';

describe('tool loader', () => {
	test('loads the migrated tool packages from the primary root', async () => {
		const registry = await loadToolModules();
		expect(registry.has('tool_export')).toBe(true);
		expect(registry.has('tool_time_machine')).toBe(true);
	});

	test('a loaded tool exposes its apiActions and provenance', async () => {
		const loaded = await getLoadedTool('tool_export');
		expect(loaded).toBeDefined();
		expect(loaded?.module.name).toBe('tool_export');
		expect(typeof loaded?.module.apiActions.get_export_grid?.handler).toBe('function');
		expect(loaded?.rootIndex).toBe(0);
	});

	test('tool_time_machine ships an isAvailable hook (moved from the core fallback)', async () => {
		const loaded = await getLoadedTool('tool_time_machine');
		const isAvailable = loaded?.module.isAvailable;
		expect(typeof isAvailable).toBe('function');
		expect(
			isAvailable?.({
				callerModel: 'component_relation_children',
				tipo: 'test3',
				sectionTipo: 'test3',
				isComponent: true,
				mode: 'edit',
				hasToolConfig: false,
			}),
		).toBe(false);
		expect(
			isAvailable?.({
				callerModel: 'section',
				tipo: 'test3',
				sectionTipo: 'test3',
				isComponent: false,
				mode: 'list',
				hasToolConfig: false,
			}),
		).toBe(true);
	});

	test('the tool_dev_template exemplar loads with the full contract', async () => {
		const loaded = await getLoadedTool('tool_dev_template');
		expect(loaded).toBeDefined();
		const module = loaded?.module;
		// All four permission kinds + the null-spec action are demonstrated.
		expect(module?.apiActions.status?.permission).toBe(null);
		expect(module?.apiActions.read_demo?.permission).toBe('tipo');
		expect(module?.apiActions.write_demo?.permission).toBe('record');
		expect(module?.apiActions.long_job?.permission).toBe('section');
		// The second allowlist + lifecycle hooks are present.
		expect(module?.backgroundRunnable).toContain('long_job');
		expect(typeof module?.isAvailable).toBe('function');
		expect(typeof module?.onRegister).toBe('function');
	});

	test('an unregistered tool resolves to undefined', async () => {
		expect(await getLoadedTool('tool_not_here')).toBeUndefined();
	});
});
