/**
 * tool_export.get_export_grid — the SQO section gate (PHP tool_export
 * ::get_export_grid runs assert_section_permission(section_tipo, 1) AND
 * assert_section_array_permission($sqo->section_tipo, 1)).
 *
 * The declarative module gate covers only `options.section_tipo`. The SQO
 * carries its OWN section list, supplied by the same caller, and the assembler's
 * principal scoping is the per-record PROJECTS filter (dd170) — a different
 * boundary from the dd774 section grant. So without the handler assertion, a
 * caller who passes the first gate on a section they can read could name a
 * section they cannot read inside `sqo.section_tipo` and export it.
 *
 * The background artifact job (build_export_artifact, export_job.ts) runs the
 * same producer, so it runs the SAME gate — asserted here too, and it refuses
 * before any job directory exists.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Principal } from '../../src/core/security/permissions.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import type { ToolActionContext } from '../../src/core/tools/module.ts';
import { openArtifactStore } from '../../tools/tool_export/server/artifact_store.ts';
import { toolExportBuildArtifact } from '../../tools/tool_export/server/export_job.ts';
import { toolExportGetExportGrid } from '../../tools/tool_export/server/tool_export.ts';
import { mustGet } from '../helpers/assert.ts';
import { refusalOf } from '../helpers/refusal.ts';

const SUPERUSER: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };
const NO_ACCESS: Principal = { userId: 999999, isGlobalAdmin: false, isDeveloper: false };

const contextOf = (
	options: Record<string, unknown>,
	principal: Principal = SUPERUSER,
): ToolActionContext =>
	({
		principal,
		userId: principal.userId,
		options,
		background: false,
	}) as ToolActionContext;

const baseOptions = (sqo: Record<string, unknown> | undefined): Record<string, unknown> => ({
	section_tipo: 'test3',
	lang: 'lg-spa',
	data_format: 'value',
	breakdown: 'default',
	ar_ddo_to_export: [
		{ path: [{ section_tipo: 'test3', component_tipo: 'test52', name: 'test52' }] },
	],
	...(sqo === undefined ? {} : { sqo }),
});

/** Every action of the module and the lane each background one runs on. */
const ACTIONS = [
	'build_export_artifact',
	'build_export_file',
	'components_with_parent',
	'components_with_references',
	'delete_export_job',
	'get_export_grid',
	'get_export_preview',
	'list_export_jobs',
];
const BACKGROUND_LANES = {
	build_export_artifact: 'export',
	build_export_file: 'export_file',
} as const;

describe('tool_export module surface', () => {
	// CONTRACT EDIT (tool_export at scale): the module gained the server-built
	// export — two BACKGROUND actions on the 'export' lane and two reads of the
	// caller's own jobs; then (2026-09-24) the owner's delete_export_job,
	// foreground; then (2026-11-11, T0-9 D4) components_with_references, the
	// ontology-only references-checkbox gate. What this pin still guards: every action is READ-gated
	// on the section (none may widen to a write level or a null gate), and
	// get_export_grid stays the synchronous stream — never backgroundable.
	test('every action is READ-gated on the section', async () => {
		const loaded = await getLoadedTool('tool_export');
		const actions = loaded?.module.apiActions ?? {};
		expect(Object.keys(actions).sort()).toEqual(ACTIONS);
		for (const name of ACTIONS) {
			const spec = mustGet(actions[name], name);
			expect(spec.permission).toBe('section');
			expect(spec.minLevel).toBe(1);
		}
	});

	test('only the two job actions run in the background, on the export lane', async () => {
		const loaded = await getLoadedTool('tool_export');
		expect([...(loaded?.module.backgroundRunnable ?? [])].sort()).toEqual(
			Object.keys(BACKGROUND_LANES).sort(),
		);
		expect(loaded?.module.backgroundLanes).toEqual(BACKGROUND_LANES);
		// The stream is never a background job (it answers the request itself).
		expect(loaded?.module.backgroundRunnable).not.toContain('get_export_grid');
	});
});

describe('build_export_artifact — the same sqo section gate, before anything is written', () => {
	/** The caller's job directories under the (suite-derived) default export root. */
	const ownerJobs = (userId: number): string[] => {
		const dir = join(openArtifactStore().root, String(userId));
		return existsSync(dir) ? readdirSync(dir).sort() : [];
	};

	test('an sqo naming a section the caller cannot read is refused', async () => {
		const before = ownerJobs(NO_ACCESS.userId);
		const refusal = await refusalOf(
			toolExportBuildArtifact({
				...contextOf(baseOptions({ section_tipo: ['test3'], limit: 1, offset: 0 }), NO_ACCESS),
				background: true,
			}),
		);
		expect(refusal.code).toBe('perm.denied');
		// Refused BEFORE the job exists: no job directory was created.
		expect(ownerJobs(NO_ACCESS.userId)).toEqual(before);
	});

	test('a non-string sqo section entry is refused (fail closed)', async () => {
		const before = ownerJobs(SUPERUSER.userId);
		const refusal = await refusalOf(
			toolExportBuildArtifact({
				...contextOf(baseOptions({ section_tipo: [{ evil: true }], limit: 1, offset: 0 })),
				background: true,
			}),
		);
		expect(refusal.code).toBe('perm.denied');
		expect(ownerJobs(SUPERUSER.userId)).toEqual(before);
	});

	test('a foreground call is refused (the export lane is the concurrency budget)', async () => {
		const refusal = await refusalOf(
			toolExportBuildArtifact(contextOf(baseOptions({ section_tipo: ['test3'] }))),
		);
		expect(refusal.code).toBe('request.invalid_options');
	});
});

describe('get_export_grid — sqo section targets are gated', () => {
	test('an sqo naming a section the caller cannot read is refused', async () => {
		const refusal = await refusalOf(
			toolExportGetExportGrid(
				contextOf(
					baseOptions({ section_tipo: ['test3'], limit: 1, offset: 0 }),
					// A principal with no grants at all: dd774 read on 'test3' is 0.
					NO_ACCESS,
				),
			),
		);
		expect(refusal.code).toBe('perm.denied');
	});

	test('a non-string sqo section entry is refused (fail closed)', async () => {
		const refusal = await refusalOf(
			toolExportGetExportGrid(
				contextOf(baseOptions({ section_tipo: [{ evil: true }], limit: 1, offset: 0 })),
			),
		);
		expect(refusal.code).toBe('perm.denied');
	});

	test('an authorized caller still gets the grid (the gate is not a blanket deny)', async () => {
		const response = await toolExportGetExportGrid(
			contextOf(baseOptions({ section_tipo: ['test3'], limit: 0, offset: 0 })),
		);
		expect(response.ok).toBe(true);
		const grid = response.data as { columns?: unknown[]; rows?: unknown[] };
		expect(Array.isArray(grid.columns)).toBe(true);
		expect((grid.columns ?? []).length).toBeGreaterThan(0);
	});

	test('no sqo at all keeps working (the engine defaults to options.section_tipo)', async () => {
		const response = await toolExportGetExportGrid(contextOf(baseOptions(undefined)));
		expect(response.ok).toBe(true);
	});
});
