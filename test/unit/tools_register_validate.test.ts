/**
 * Registration validation: format detection, the full tools/ corpus
 * validates (the TS analogue of PHP's v6-corpus guard), and the authoring→v7
 * conversion produces a record that passes validateRegister.
 *
 * The corpus census is a SET law, not a count. Every tool directory is
 * declared in exactly ONE of two lists, and each list names only directories
 * that exist:
 *   - SEEDED: the 34 PHP-seeded column-keyed registers. FROZEN since the
 *     cutover — the PHP seeder is gone, so this list can only shrink (a tool
 *     retired) and never grows.
 *   - TS_AUTHORED: tools AUTHORED in the authoring format, which must
 *     convert+validate. A new tool adds ONE line here.
 * A tool that declares neither, or the wrong one, fails by NAME; a deleted
 * tool fails by NAME. The former hard count ("there are 38") caught nothing
 * the set does not, and made every two tool contributions conflict on a
 * number neither author could know (PR #114 vs tool_rag, 2026-10-01).
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
	applyActiveOverride,
	convertAuthoringToV7,
	detectFormat,
	listToolDirectories,
	missingServerWarning,
	validateRegister,
} from '../../src/core/tools/register.ts';
import { isGrantOnlyTool } from '../helpers/tool_directory_corpus.ts';

const TOOLS_ROOT = resolve(import.meta.dir, '../../tools');

describe('detectFormat', () => {
	test('classifies the register.json shapes', () => {
		expect(detectFormat({ components: [] })).toBe('v6');
		expect(detectFormat({ name: 'tool_x', version: '1.0.0' })).toBe('authoring');
		expect(detectFormat({ string: {}, relation: {}, data: {} })).toBe('column');
		expect(detectFormat(null)).toBe('invalid');
		expect(detectFormat(42)).toBe('invalid');
	});
});

describe('seeded register.json corpus', () => {
	const toolDirs = readdirSync(TOOLS_ROOT).filter((name) => /^tool_[a-z0-9_]+$/.test(name));

	/** PHP-seeded column-keyed registers. FROZEN: shrink-only, never grows
	 * (no seeder exists since the cutover). Sorted. */
	const SEEDED = new Set([
		'tool_assistant',
		'tool_cataloging',
		'tool_dd_label',
		'tool_dev_template',
		'tool_diffusion',
		'tool_export',
		'tool_hierarchy',
		'tool_image_rotation',
		'tool_import_dedalo_csv',
		'tool_import_files',
		'tool_import_marc21',
		'tool_import_rdf',
		'tool_import_zotero',
		'tool_indexation',
		'tool_lang',
		'tool_lang_multi',
		'tool_media_versions',
		'tool_numisdata_epigraphy',
		'tool_numisdata_order_coins',
		'tool_ontology',
		'tool_ontology_parser',
		'tool_pdf_extractor',
		'tool_posterframe',
		'tool_print',
		'tool_propagate_component_data',
		'tool_qr',
		'tool_subtitles',
		'tool_tc',
		'tool_time_machine',
		'tool_tr_print',
		'tool_transcription',
		'tool_update_cache',
		'tool_upload',
		'tool_user_admin',
	]);

	/** TS-authored tools (never PHP-seeded): register.json in the authoring
	 * format, converted at registration (WC-019 precedent). A new tool adds its
	 * name here. Sorted, one per line, so parallel additions merge by union. */
	const TS_AUTHORED = new Set([
		'tool_bibliography_acquisition',
		'tool_error_report',
		'tool_identify',
		'tool_numisdata_acquisition',
		'tool_rag',
		'tool_sitebuilder',
		'tool_uca_maps',
	]);

	test('every tool directory is declared in exactly one list', () => {
		const undeclared = toolDirs.filter((name) => !SEEDED.has(name) && !TS_AUTHORED.has(name));
		const both = toolDirs.filter((name) => SEEDED.has(name) && TS_AUTHORED.has(name));
		expect(
			undeclared,
			'tool directories in NEITHER list — a new tool adds its name to TS_AUTHORED (SEEDED is frozen):',
		).toEqual([]);
		expect(both, 'tool directories declared in BOTH lists:').toEqual([]);
	});

	test('every declared tool has a directory (a deleted tool is named, not miscounted)', () => {
		const present = new Set(toolDirs);
		const missing = [...SEEDED, ...TS_AUTHORED].filter((name) => !present.has(name));
		expect(
			missing,
			'declared tools with no directory under tools/ — remove the line with the tool:',
		).toEqual([]);
	});

	for (const name of toolDirs) {
		test(`${name}: validates as a ${TS_AUTHORED.has(name) ? 'convertible authoring' : 'column-keyed'} record`, async () => {
			const raw = await Bun.file(resolve(TOOLS_ROOT, name, 'register.json')).json();
			if (TS_AUTHORED.has(name)) {
				expect(detectFormat(raw)).toBe('authoring');
				const converted = await convertAuthoringToV7(raw);
				// registration fills the empty `data` column post-conversion
				// (register.ts registration path) — mirror it before validating.
				if (converted.data === undefined) converted.data = {};
				expect(validateRegister(converted, name)).toEqual([]);
				return;
			}
			expect(detectFormat(raw)).toBe('column');
			const errors = validateRegister(raw, name);
			expect(errors).toEqual([]);
		});
	}
});

describe('authoring → v7 conversion', () => {
	test('a minimal authoring file converts to a valid record', async () => {
		const authoring = {
			name: 'tool_export',
			version: '1.0.0',
			label: { 'lg-eng': 'Export' },
			properties: { open_as: 'modal' },
		};
		const record = await convertAuthoringToV7(authoring);
		// name === basename must hold for the record to validate.
		expect(validateRegister(record, 'tool_export')).toEqual([]);
		// active defaults to true → dd1354 locator targets dd64/1.
		expect(record.relation?.dd1354?.[0]?.section_id).toBe('1');
	});

	test('a bad tool name is rejected by the authoring schema', async () => {
		await expect(
			convertAuthoringToV7({ name: 'BadName', version: '1.0.0', label: { 'lg-eng': 'x' } }),
		).rejects.toThrow();
	});

	test('applyActiveOverride outranks the file declaration and stays valid (WC-057)', async () => {
		const authoring = {
			name: 'tool_export',
			version: '1.0.0',
			label: { 'lg-eng': 'Export' },
			active: true,
		};
		const record = await convertAuthoringToV7(authoring);
		expect(record.relation?.dd1354?.[0]?.section_id).toBe('1');

		// The admin unchecked it: dd64/2 (no), and the record must still validate —
		// the override runs BEFORE validateRegister in importTools.
		applyActiveOverride(record, false);
		expect(record.relation?.dd1354?.[0]?.section_id).toBe('2');
		expect(record.relation?.dd1354).toHaveLength(1);
		expect(validateRegister(record, 'tool_export')).toEqual([]);

		// …and back on, idempotently (no locator accumulation).
		applyActiveOverride(record, true);
		expect(record.relation?.dd1354?.[0]?.section_id).toBe('1');
		expect(record.relation?.dd1354).toHaveLength(1);
	});

	test('applyActiveOverride creates the relation column when the record lacks one', () => {
		const record = {};
		applyActiveOverride(record, false);
		expect(
			(record as { relation?: Record<string, { section_id?: string }[]> }).relation?.dd1354?.[0]
				?.section_id,
		).toBe('2');
	});

	test('validateRegister rejects a name that mismatches the directory', () => {
		const record = {
			data: {},
			string: {
				dd1326: [{ lang: 'lg-nolan', value: 'tool_a' }],
				dd1327: [{ value: '1.0.0' }],
				dd799: [{ value: 'A' }],
			},
			relation: {},
			misc: {},
		};
		const errors = validateRegister(record, 'tool_b');
		expect(errors.some((e) => e.includes('does not match its directory'))).toBe(true);
	});
});

/**
 * THE GRANT-ONLY LAW (2026-10-01, TOOLS-4 — first instance `tool_rag`, the
 * generative RAG answer). A grant-only tool is a registry row that exists to be
 * GRANTED in the profile editor and ASKED by an engine door; it is never opened.
 * The UI gates exempt it by its own declaration (tool_directory_corpus.isGrantOnlyTool),
 * so the declaration must be TRUE: no client, no stylesheet, no server module,
 * no place it shows, never handed to every profile. That an engine door ASKS
 * for it is an outcome, not a spelling: ai_spend_budget_native drives `ask`
 * with the granted / ungranted pair (refused before any provider call, served
 * when granted).
 */
describe('grant-only tools', () => {
	const toolDirs = readdirSync(TOOLS_ROOT).filter((name) => /^tool_[a-z0-9_]+$/.test(name));
	const grantOnly = toolDirs.filter(isGrantOnlyTool);

	test('the class is non-empty (anti-vacuity: tool_rag)', () => {
		expect(grantOnly).toContain('tool_rag');
	});

	for (const name of grantOnly) {
		test(`${name}: ships no client, stylesheet or server module`, () => {
			const surfaces = ['js', 'css', 'server'].filter((dir) =>
				existsSync(resolve(TOOLS_ROOT, name, dir)),
			);
			expect(surfaces).toEqual([]);
		});

		test(`${name}: shows nowhere and is never handed to every profile`, async () => {
			const raw = (await Bun.file(resolve(TOOLS_ROOT, name, 'register.json')).json()) as {
				affected_models?: unknown[];
				affected_tipos?: unknown[];
				show_in_inspector?: boolean;
				show_in_component?: boolean;
				always_active?: boolean;
			};
			expect({
				affected_models: raw.affected_models ?? [],
				affected_tipos: raw.affected_tipos ?? [],
				show_in_inspector: raw.show_in_inspector ?? false,
				show_in_component: raw.show_in_component ?? false,
				always_active: raw.always_active ?? false,
			}).toEqual({
				affected_models: [],
				affected_tipos: [],
				show_in_inspector: false,
				show_in_component: false,
				always_active: false,
			});
		});
	}
});

describe('the "no server module" warning is earned only by a client that calls the server (campaign 3 C3-19)', () => {
	test('over the repo tools: no warning for a tool whose client never calls tool_request — a clean install prints none', async () => {
		const { getLoadedTool } = await import('../../src/core/tools/loader.ts');
		const warned: string[] = [];
		let serverless = 0;
		for (const { name, dir } of listToolDirectories()) {
			const hasServer = (await getLoadedTool(name)) !== undefined;
			if (!hasServer) serverless += 1;
			if ((await missingServerWarning(dir, hasServer)) !== null) warned.push(name);
		}
		// Anti-vacuity: client-only tools exist (13 at campaign 3), and none of them warns.
		expect(serverless).toBeGreaterThan(5);
		expect(warned).toEqual([]);
	});

	test('a tool whose client CALLS tool_request without a server module still warns', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'dedalo_tool_fixture_'));
		try {
			mkdirSync(join(dir, 'js', 'view'), { recursive: true });
			writeFileSync(
				join(dir, 'js', 'view', 'render_tool_fixture.js'),
				"const answer = await self.tool_request({ action: 'go' })\n",
			);
			expect(await missingServerWarning(dir, false)).toContain('tool_request');
			// With its server module: nothing to say.
			expect(await missingServerWarning(dir, true)).toBeNull();
			// A client that never calls it: nothing to say either.
			writeFileSync(join(dir, 'js', 'view', 'render_tool_fixture.js'), 'export const x = 1\n');
			expect(await missingServerWarning(dir, false)).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
