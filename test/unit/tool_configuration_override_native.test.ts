/**
 * T1-43 / O11 — the TOOL CONFIGURATION OVERRIDE (PHP
 * tool_common::get_tool_configuration) reaches every element tool stamp.
 *
 * A tool's config (Tools configuration dd996/dd999, or the register default
 * dd1324/dd1633) may carry `properties.tool_config: [{tipo, section_tipo,
 * ddo_map}]`. For the element (tipo, section_tipo) it names, that ddo_map
 * REPLACES the ontology's `properties.tool_config.<tool>.ddo_map` — on the
 * component/area toolbar, the section toolbar, the section buttons and the
 * indexation grid's tool cells (that last one is gated in
 * indexation_grid_av_native). Precedence (owner ruling 2026-11-11): Tools
 * configuration → register default → ontology. The override never makes a tool
 * APPLY to an element; on a section BUTTON an override alone does carry the tool
 * (PHP-exact).
 *
 * RED on 38f6a4c422: the override was never read — every case below saw the
 * ontology config (or none).
 *
 * Situation: the suite's own test TLD (test3 playground: test52 input_text;
 * test6022 / test6032 portal declaring tool_import_files; test6099 / test6415
 * button_trigger declaring tool_cataloging) + scratch config rows written by
 * test/helpers/tool_config_fixture.ts (marked suite DB only, swept after).
 * WC-2026-11-12-tool-configuration-override.
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { buildStructureContext } from '../../src/core/resolve/structure_context.ts';
import { buildSectionButtons } from '../../src/core/section/buttons.ts';
import { getToolConfigurationOverride, resetConfigCache } from '../../src/core/tools/config.ts';
import { resolveElementToolConfig } from '../../src/core/tools/section_tool_context.ts';
import {
	installScratchRegisterDefault,
	installScratchToolConfig,
	overwriteScratchToolConfigUncached,
} from '../helpers/tool_config_fixture.ts';

type Tool = {
	name: string;
	tool_config?: { ddo_map?: Record<string, unknown>[] } & Record<string, unknown>;
};

const teardowns: (() => Promise<void>)[] = [];
afterEach(async () => {
	while (teardowns.length > 0) await teardowns.pop()?.();
});

async function installOverride(
	layer: 'install' | 'register',
	toolName: string,
	entries: unknown,
): Promise<void> {
	const config = { properties: { tool_config: entries } };
	teardowns.push(
		layer === 'install'
			? await installScratchToolConfig(toolName, config)
			: await installScratchRegisterDefault(toolName, config),
	);
}

async function context(tipo: string, sectionTipo: string, mode = 'edit') {
	const entry = await buildStructureContext({
		configFrom: { source: 'own', reason: 'unit-test' },
		tipo,
		sectionTipo,
		mode,
		lang: 'lg-nolan',
		permissions: 3,
		addRequestConfig: true,
	});
	expect(entry).not.toBeNull();
	return entry as NonNullable<typeof entry>;
}

function toolOf(tools: unknown, name: string): Tool | undefined {
	return (tools as Tool[]).find((tool) => tool.name === name);
}

function propertiesToolConfig(properties: unknown): Record<string, unknown> {
	return ((properties as { tool_config?: Record<string, unknown> } | null)?.tool_config ??
		{}) as Record<string, unknown>;
}

describe('component toolbar', () => {
	test('override-only: the tool carries the override ddo_map, self resolved and enriched; properties untouched', async () => {
		await installOverride('install', 'tool_time_machine', [
			{
				tipo: 'test52',
				section_tipo: 'test3',
				ddo_map: [{ tipo: 'self', section_tipo: 'self', role: 'main' }],
			},
		]);
		const entry = await context('test52', 'test3');
		const tool = toolOf(entry.tools, 'tool_time_machine');
		expect(tool).toBeDefined();
		const [ddo] = tool?.tool_config?.ddo_map ?? [];
		expect(ddo).toMatchObject({
			tipo: 'test52',
			section_tipo: 'test3',
			role: 'main',
			model: 'component_input_text',
		});
		expect(typeof ddo?.label).toBe('string');
		// A config created from an override alone is a fresh object (PHP): it
		// never lands in the element's properties.
		expect(propertiesToolConfig(entry.properties).tool_time_machine).toBeUndefined();
	});

	test('ontology + override: the override ddo_map replaces the ontology one and is written back', async () => {
		const before = await context('test6032', 'test6022');
		const ontologyMap = toolOf(before.tools, 'tool_import_files')?.tool_config?.ddo_map ?? [];
		expect(ontologyMap.length).toBeGreaterThan(1); // the ontology declares a multi-entry map
		await installOverride('install', 'tool_import_files', [
			{
				tipo: 'test6032',
				section_tipo: 'test6022',
				ddo_map: [{ tipo: 'test52', section_tipo: 'test3', role: 'input_component' }],
			},
		]);
		const entry = await context('test6032', 'test6022');
		const map = toolOf(entry.tools, 'tool_import_files')?.tool_config?.ddo_map ?? [];
		expect(map).toHaveLength(1);
		expect(map[0]).toMatchObject({
			tipo: 'test52',
			role: 'input_component',
			model: 'component_input_text',
		});
		// PHP mutates the shared properties object when the ontology defined it.
		const written = propertiesToolConfig(entry.properties).tool_import_files as Tool['tool_config'];
		expect(written?.ddo_map).toEqual(map);
	});

	test('precedence: Tools configuration → register default → ontology (none)', async () => {
		const entries = (role: string) => [
			{
				tipo: 'test52',
				section_tipo: 'test3',
				ddo_map: [{ tipo: 'test52', section_tipo: 'test3', role }],
			},
		];
		const roleSeen = async () =>
			toolOf((await context('test52', 'test3')).tools, 'tool_time_machine')?.tool_config
				?.ddo_map?.[0]?.role;
		const register = await installScratchRegisterDefault('tool_time_machine', {
			properties: { tool_config: entries('register') },
		});
		teardowns.push(register);
		const install = await installScratchToolConfig('tool_time_machine', {
			properties: { tool_config: entries('install') },
		});
		expect(await roleSeen()).toBe('install');
		await install();
		expect(await roleSeen()).toBe('register');
		await register();
		teardowns.length = 0;
		expect(
			toolOf((await context('test52', 'test3')).tools, 'tool_time_machine')?.tool_config,
		).toBeUndefined();
	});

	test('per entry: a Tools configuration without a matching entry falls through to the register default', async () => {
		await installOverride('register', 'tool_time_machine', [
			{
				tipo: 'test52',
				section_tipo: 'test3',
				ddo_map: [{ tipo: 'test52', section_tipo: 'test3', role: 'register' }],
			},
		]);
		await installOverride('install', 'tool_time_machine', [
			{
				tipo: 'test80',
				section_tipo: 'test3',
				ddo_map: [{ tipo: 'test80', section_tipo: 'test3', role: 'install' }],
			},
		]);
		const tool = toolOf((await context('test52', 'test3')).tools, 'tool_time_machine');
		expect(tool?.tool_config?.ddo_map?.[0]?.role).toBe('register');
	});

	test('a non-matching (tipo, section_tipo) leaves the element as the ontology made it', async () => {
		const baseline = await context('test6032', 'test6022');
		await installOverride('install', 'tool_import_files', [
			{
				tipo: 'test6032',
				section_tipo: 'test3',
				ddo_map: [{ tipo: 'test52', section_tipo: 'test3' }],
			},
		]);
		const entry = await context('test6032', 'test6022');
		expect(entry.tools).toEqual(baseline.tools);
	});

	test('an override never makes a tool APPLY to an element', async () => {
		const before = await context('test52', 'test3');
		expect(toolOf(before.tools, 'tool_import_files')).toBeUndefined();
		await installOverride('install', 'tool_import_files', [
			{
				tipo: 'test52',
				section_tipo: 'test3',
				ddo_map: [{ tipo: 'test52', section_tipo: 'test3' }],
			},
		]);
		expect(toolOf((await context('test52', 'test3')).tools, 'tool_import_files')).toBeUndefined();
	});

	test('a malformed override is skipped LOUDLY — the context still builds', async () => {
		const errors = spyOn(console, 'error');
		try {
			await installOverride('install', 'tool_time_machine', [
				{ tipo: 'test52', section_tipo: 'test3', ddo_map: 'not-a-map' },
			]);
			const tool = toolOf((await context('test52', 'test3')).tools, 'tool_time_machine');
			expect(tool).toBeDefined();
			expect(tool?.tool_config).toBeUndefined();
			const lines = errors.mock.calls.map((call) => String(call[0]));
			expect(
				lines.some((line) => line.includes('tool_time_machine') && line.includes('ddo_map')),
			).toBe(true);
		} finally {
			errors.mockRestore();
		}
	});
	// T1-43 review: isOverrideEntry checked only that ddo_map was an array; a
	// null item reached enrichToolConfig (`entry.tipo` on null) and killed the
	// whole context build — install-editable data made a dead screen.
	test('an override whose ddo_map holds a non-object item is skipped LOUDLY — the context still builds', async () => {
		const errors = spyOn(console, 'error');
		try {
			await installOverride('install', 'tool_time_machine', [
				{ tipo: 'test52', section_tipo: 'test3', ddo_map: [null] },
				{ tipo: 'test52', section_tipo: 'test3', ddo_map: [{ tipo: 'test52' }, 'not-an-item'] },
			]);
			const tool = toolOf((await context('test52', 'test3')).tools, 'tool_time_machine');
			expect(tool).toBeDefined();
			expect(tool?.tool_config).toBeUndefined();
			const lines = errors.mock.calls.map((call) => String(call[0]));
			expect(
				lines.filter((line) => line.includes('tool_time_machine') && line.includes('ddo_map')),
			).toHaveLength(2);
		} finally {
			errors.mockRestore();
		}
	});

	test('a skipped malformed entry lets a later well-formed entry for the same element apply', async () => {
		const errors = spyOn(console, 'error');
		try {
			await installOverride('install', 'tool_time_machine', [
				{ tipo: 'test52', section_tipo: 'test3', ddo_map: [null] },
				{
					tipo: 'test52',
					section_tipo: 'test3',
					ddo_map: [{ tipo: 'test52', section_tipo: 'test3', role: 'second' }],
				},
			]);
			const tool = toolOf((await context('test52', 'test3')).tools, 'tool_time_machine');
			expect(tool?.tool_config?.ddo_map?.[0]?.role).toBe('second');
		} finally {
			errors.mockRestore();
		}
	});
});

describe('cache generation', () => {
	// T1-43 review: an index build that began before an invalidation must not
	// store what it read — else a dd996 edit is masked until an unrelated reset.
	test('a build spanning resetConfigCache() never stores its pre-reset read', async () => {
		await installOverride('install', 'tool_time_machine', [
			{
				tipo: 'test52',
				section_tipo: 'test3',
				ddo_map: [{ tipo: 'test52', section_tipo: 'test3', role: 'before' }],
			},
		]);
		resetConfigCache(); // every cache cold: the build below reads the DB
		const inFlight = getToolConfigurationOverride('tool_time_machine', 'test52', 'test3');
		resetConfigCache(); // the invalidation lands while the build is awaiting
		expect((await inFlight)?.[0]).toMatchObject({ role: 'before' });
		// The record changes WITHOUT a further reset: only a cache that did NOT
		// store the spanning build's read can see it.
		await overwriteScratchToolConfigUncached('tool_time_machine', {
			properties: {
				tool_config: [
					{
						tipo: 'test52',
						section_tipo: 'test3',
						ddo_map: [{ tipo: 'test52', section_tipo: 'test3', role: 'after' }],
					},
				],
			},
		});
		const fresh = await getToolConfigurationOverride('tool_time_machine', 'test52', 'test3');
		expect(fresh?.[0]).toMatchObject({ role: 'after' });
	});
});

describe('section toolbar', () => {
	test('a section tool carries the override for (section, section)', async () => {
		await installOverride('install', 'tool_export', [
			{
				tipo: 'test3',
				section_tipo: 'test3',
				ddo_map: [{ tipo: 'test52', section_tipo: 'test3', role: 'column' }],
			},
		]);
		const entry = await context('test3', 'test3', 'list');
		const tool = toolOf(entry.tools, 'tool_export');
		expect(tool).toBeDefined();
		expect(tool?.tool_config?.ddo_map?.[0]).toMatchObject({ tipo: 'test52', role: 'column' });
	});
});

describe('section buttons', () => {
	const triggerOf = async () => {
		const buttons = await buildSectionButtons('test6099', 3);
		const button = buttons.find((entry) => entry.tipo === 'test6415') as
			| { properties?: unknown; tools?: unknown[] }
			| undefined;
		expect(button).toBeDefined();
		return button as { properties?: unknown; tools?: unknown[] };
	};

	test('the override replaces the ontology ddo_map of the declared tool, written back into the button', async () => {
		await installOverride('install', 'tool_cataloging', [
			{
				tipo: 'test6415',
				section_tipo: 'test6099',
				ddo_map: [{ tipo: 'self', section_tipo: 'self', role: 'section_to_cataloging' }],
			},
		]);
		const button = await triggerOf();
		const map = toolOf(button.tools, 'tool_cataloging')?.tool_config?.ddo_map ?? [];
		expect(map).toHaveLength(1);
		// 'self' on a button resolves to its SECTION (PHP passes $this->tipo).
		expect(map[0]).toMatchObject({
			tipo: 'test6099',
			section_tipo: 'test6099',
			role: 'section_to_cataloging',
		});
		expect(
			(propertiesToolConfig(button.properties).tool_cataloging as Tool['tool_config'])?.ddo_map,
		).toEqual(map);
	});

	test('an override alone makes the button carry that tool (PHP-exact), not its properties', async () => {
		expect(toolOf((await triggerOf()).tools, 'tool_qr')).toBeUndefined();
		await installOverride('install', 'tool_qr', [
			{
				tipo: 'test6415',
				section_tipo: 'test6099',
				ddo_map: [{ tipo: 'test52', section_tipo: 'test3' }],
			},
		]);
		const button = await triggerOf();
		expect(toolOf(button.tools, 'tool_qr')?.tool_config?.ddo_map?.[0]).toMatchObject({
			tipo: 'test52',
		});
		expect(propertiesToolConfig(button.properties).tool_qr).toBeUndefined();
	});
});

describe('resolveElementToolConfig', () => {
	test('only the ddo_map is replaced — every other ontology key stays, the input is not mutated', async () => {
		await installOverride('install', 'tool_time_machine', [
			{
				tipo: 'test52',
				section_tipo: 'test3',
				ddo_map: [{ tipo: 'test52', section_tipo: 'test3' }],
			},
		]);
		const ontology = { ddo_map: [{ tipo: 'test80', section_tipo: 'test3' }], keep_me: { a: 1 } };
		const snapshot = structuredClone(ontology);
		const { enriched, fromOntology } = await resolveElementToolConfig(
			'tool_time_machine',
			ontology,
			'test52',
			'test3',
		);
		expect(fromOntology).toBe(true);
		expect(enriched?.keep_me).toEqual({ a: 1 });
		expect((enriched?.ddo_map as { tipo: string }[]).map((ddo) => ddo.tipo)).toEqual(['test52']);
		expect(ontology).toEqual(snapshot);
	});
});
