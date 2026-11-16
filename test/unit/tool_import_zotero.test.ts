/**
 * R2 gate: tool_import_zotero — the ACTION SURFACE, the server-config refusal
 * and the staged-file confinement. The import semantics (CSL-JSON through the
 * server map, T1-7) are gated end to end in tool_import_zotero_native.test.ts
 * and the reader/mapper in csl_json.test.ts.
 *
 * What IS gated here: the wire it shares with tool_import_marc21 — `key_dir`
 * arrives ONCE at the TOP LEVEL and must be server-sanitized, because the
 * pre-audit code interpolated it raw, so `key_dir:'../<other uid>'` still
 * satisfied the staging-root prefix check and let one user's import consume
 * another user's staged upload — and the refusal of a run without a SERVER map.
 */

import { describe, expect, test } from 'bun:test';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import type { ToolResponse } from '../../src/core/tools/module.ts';
import { mustGet } from '../helpers/assert.ts';
import { refusalOf } from '../helpers/refusal.ts';
import { withScratchToolConfig } from '../helpers/tool_config_fixture.ts';

const SCRATCH_USER = 987663;

/** What render_tool_import_zotero posts: the ontology tool_config (ddo_map only). */
const CLIENT_TOOL_CONFIG = { ddo_map: [] };

/** A minimal SERVER config (dd996) over test3 — every key, so no register default leaks in. */
const SERVER_CONFIG = {
	main: [],
	typology: [],
	standard_type: [],
	map: [
		{ name: 'id', ddo_map: [{ tipo: 'test162', section_tipo: 'test3' }] },
		{ name: 'title', ddo_map: [{ tipo: 'test52', section_tipo: 'test3' }] },
	],
};

async function runImport(options: Record<string, unknown>): Promise<ToolResponse> {
	const loaded = await getLoadedTool('tool_import_zotero');
	return mustGet(loaded!.module.apiActions.import_files, 'import_files').handler({
		principal: await resolvePrincipal(-1),
		userId: SCRATCH_USER,
		background: false,
		options,
	});
}

describe('tool_import_zotero module', () => {
	test('loads with import_files only, gated WRITE and backgroundRunnable', async () => {
		const loaded = await getLoadedTool('tool_import_zotero');
		expect(loaded).not.toBeNull();
		const actions = loaded!.module.apiActions;
		expect(Object.keys(actions)).toEqual(['import_files']);
		expect(mustGet(actions.import_files, 'import_files').minLevel).toBe(2);
		expect(loaded!.module.backgroundRunnable).toEqual(['import_files']);
	});

	test('a SERVER config with no map refuses the batch, naming where the map lives', async () => {
		// A client-posted map is ignored: only the Tools configuration counts.
		const refusal = await withScratchToolConfig('tool_import_zotero', { map: [] }, () =>
			refusalOf(
				runImport({
					section_tipo: 'test3',
					tool_config: { ddo_map: [], map: SERVER_CONFIG.map },
					files_data: [{ name: 'zotero.json' }],
					key_dir: 'zotero_scratch',
				}),
			),
		);
		expect(refusal.code).toBe('request.invalid_options');
		expect(refusal.publicMessage).toContain("Zotero config 'map'");
		expect(refusal.publicMessage).toContain('dd996');
	});

	test('a traversing key_dir is REFUSED (never reaches another users staging dir)', async () => {
		// stagingDir still refuses with an UNTYPED engine throw (add_file.ts is a
		// different sweep); it reaches the chokepoint as internal.unexpected.
		await withScratchToolConfig('tool_import_zotero', SERVER_CONFIG, async () => {
			await expect(
				runImport({
					section_tipo: 'test3',
					tool_config: CLIENT_TOOL_CONFIG,
					files_data: [{ name: 'zotero.json' }],
					key_dir: `../${SCRATCH_USER}/zotero_scratch`,
				}),
			).rejects.toThrow(/Unsafe path segment/);
		});
	});

	test('non-.json entries are skipped and a missing export is a per-file error', async () => {
		const res = await withScratchToolConfig('tool_import_zotero', SERVER_CONFIG, () =>
			runImport({
				section_tipo: 'test3',
				tool_config: CLIENT_TOOL_CONFIG,
				// PHP filters the dropzone batch to .json; the .pdf is an attachment.
				files_data: [{ name: 'attachment.pdf' }, { name: 'absent.json' }],
				key_dir: 'zotero_scratch',
			}),
		);
		expect(res.ok).toBe(true);
		expect((res.data as { errors: string[] }).errors).toEqual([
			'absent.json: staged file not found',
		]);
	});

	test('an empty batch is refused before any filesystem work', async () => {
		const refusal = await refusalOf(runImport({ section_tipo: 'test3', files_data: [] }));
		expect(refusal.code).toBe('request.invalid_options');
		expect(refusal.publicMessage).toContain('Missing section_tipo or files_data');
	});
});
