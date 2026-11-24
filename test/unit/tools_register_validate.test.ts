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
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
	applyActiveOverride,
	convertAuthoringToV7,
	detectFormat,
	listToolDirectories,
	missingServerWarning,
	type ToolRecord,
	validateOpenAs,
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

/**
 * THE OPEN-MODE LAW (`properties.open_as`). Server half: validateRegister
 * (via validateOpenAs) refuses a value outside modal|window|attach and an
 * 'attach' tool that is not show_in_component:true + show_in_inspector:false —
 * at importTools, the one registration door, for both register formats.
 * Client half (here, because no runtime door can see it): an 'attach' tool's
 * client class must define BOTH attach() and detach() — tool_common builds it
 * straight onto the live caller component and never calls render().
 * No master tool is 'attach' today, so the corpus walk alone would be vacuous:
 * the planted fixtures below prove each check bites, and the walk proves it
 * read every register.
 */
describe('open_as law', () => {
	const authoringBase = { name: 'tool_export', version: '1.0.0', label: { 'lg-eng': 'Export' } };
	const errorsFor = async (extra: Record<string, unknown>): Promise<string[]> => {
		const record = await convertAuthoringToV7({ ...authoringBase, ...extra });
		return validateRegister(record, 'tool_export');
	};

	test('absent, modal, window and a well-formed attach are valid', async () => {
		const verdicts = [
			await errorsFor({}),
			await errorsFor({ properties: null }),
			await errorsFor({ properties: { open_as: 'modal' } }),
			await errorsFor({ properties: { open_as: 'window', windowFeatures: {} } }),
			await errorsFor({
				properties: { open_as: 'attach' },
				show_in_component: true,
				show_in_inspector: false,
			}),
			await errorsFor({ properties: { open_as: 'attach' }, show_in_component: true }),
		];
		expect(verdicts).toHaveLength(6);
		for (const errors of verdicts) expect(errors).toEqual([]);
	});

	test('an unknown open_as is refused, naming the tool and the value', async () => {
		for (const bad of ['tab', 'popup', '', 7, null]) {
			const errors = await errorsFor({ properties: { open_as: bad } });
			expect(errors).toHaveLength(1);
			expect(errors[0]).toContain("Tool 'tool_export'");
			expect(errors[0]).toContain(JSON.stringify(bad));
		}
	});

	test("'attach' without show_in_component, or shown in the inspector, is refused", async () => {
		const noComponent = await errorsFor({ properties: { open_as: 'attach' } });
		expect(noComponent).toHaveLength(1);
		expect(noComponent[0]).toContain('show_in_component: true');

		const inInspector = await errorsFor({
			properties: { open_as: 'attach' },
			show_in_component: true,
			show_in_inspector: true,
		});
		expect(inInspector).toHaveLength(1);
		expect(inInspector[0]).toContain('show_in_inspector: false');

		const both = await errorsFor({ properties: { open_as: 'attach' }, show_in_inspector: true });
		expect(both).toHaveLength(2);
	});

	test('a column-keyed record (the seeded format) meets the same law', () => {
		const yes = (tipo: string) => [
			{ section_id: '1', section_tipo: 'dd64', from_component_tipo: tipo },
		];
		const no = (tipo: string) => [
			{ section_id: '2', section_tipo: 'dd64', from_component_tipo: tipo },
		];
		const record = (openAs: unknown, component: boolean, inspector: boolean): ToolRecord => ({
			data: {},
			string: {},
			relation: {
				dd1332: component ? yes('dd1332') : no('dd1332'),
				dd1331: inspector ? yes('dd1331') : no('dd1331'),
			},
			misc: { dd1335: [{ value: { open_as: openAs } }] },
		});
		expect(validateOpenAs(record('attach', true, false), 'tool_x')).toEqual([]);
		expect(validateOpenAs(record('window', false, true), 'tool_x')).toEqual([]);
		expect(validateOpenAs(record('tab', true, false), 'tool_x')).toHaveLength(1);
		expect(validateOpenAs(record('attach', false, false), 'tool_x')).toHaveLength(1);
		expect(validateOpenAs(record('attach', true, true), 'tool_x')).toHaveLength(1);
	});

	/** The open_as a register.json declares, whichever format it is in. */
	const declaredOpenAs = (raw: Record<string, unknown>): unknown => {
		const properties =
			detectFormat(raw) === 'authoring'
				? raw.properties
				: (raw as ToolRecord).misc?.dd1335?.[0]?.value;
		return properties !== null && typeof properties === 'object'
			? (properties as { open_as?: unknown }).open_as
			: undefined;
	};

	/** Client JS sources (path → text) under a tool's js/ directory, recursively. */
	const clientSources = (jsDir: string): Map<string, string> => {
		const sources = new Map<string, string>();
		if (!existsSync(jsDir)) return sources;
		for (const entry of readdirSync(jsDir, { recursive: true, encoding: 'utf8' })) {
			if (entry.endsWith('.js')) sources.set(entry, readFileSync(join(jsDir, entry), 'utf8'));
		}
		return sources;
	};

	/** The attach-contract methods an 'attach' tool's client fails to define. */
	const missingAttachMethods = (
		openAs: unknown,
		sources: ReadonlyMap<string, string>,
	): string[] => {
		if (openAs !== 'attach') return [];
		const all = [...sources.values()].join('\n');
		return ['attach', 'detach'].filter(
			(method) => !new RegExp(`\\.prototype\\.${method}\\s*=`).test(all),
		);
	};

	test('the client check bites (planted fixtures)', () => {
		const both = new Map([
			[
				'tool_fake.js',
				'tool_fake.prototype.attach = async function(){}\ntool_fake.prototype.detach = function(){}\n',
			],
		]);
		const onlyAttach = new Map([['tool_fake.js', 'tool_fake.prototype.attach = function(){}\n']]);
		const mentionsOnly = new Map([['tool_fake.js', '// attach() and detach() go here later\n']]);
		expect(missingAttachMethods('attach', both)).toEqual([]);
		expect(missingAttachMethods('attach', onlyAttach)).toEqual(['detach']);
		expect(missingAttachMethods('attach', mentionsOnly)).toEqual(['attach', 'detach']);
		expect(missingAttachMethods('attach', new Map())).toEqual(['attach', 'detach']);
		// Not an attach tool: nothing owed.
		expect(missingAttachMethods('modal', new Map())).toEqual([]);
		expect(
			missingAttachMethods(
				declaredOpenAs({ name: 'tool_fake', properties: { open_as: 'attach' } }),
				onlyAttach,
			),
		).toEqual(['detach']);
		expect(
			missingAttachMethods(
				declaredOpenAs({ misc: { dd1335: [{ value: { open_as: 'attach' } }] } }),
				new Map(),
			),
		).toEqual(['attach', 'detach']);
	});

	test('every repo tool declaring open_as attach defines attach() and detach() in its client', async () => {
		const toolDirs = readdirSync(TOOLS_ROOT).filter((name) => /^tool_[a-z0-9_]+$/.test(name));
		const violations: string[] = [];
		let walked = 0;
		const modes = new Set<unknown>();
		for (const name of toolDirs) {
			const raw = (await Bun.file(resolve(TOOLS_ROOT, name, 'register.json')).json()) as Record<
				string,
				unknown
			>;
			walked += 1;
			const openAs = declaredOpenAs(raw);
			modes.add(openAs);
			for (const method of missingAttachMethods(
				openAs,
				clientSources(resolve(TOOLS_ROOT, name, 'js')),
			)) {
				violations.push(`${name}: open_as 'attach' but its client defines no ${method}()`);
			}
		}
		// Anti-vacuity: the walk read every register, and the format-agnostic
		// reader actually extracts declared modes (the corpus has window + modal).
		expect(walked).toBe(toolDirs.length);
		expect(walked).toBeGreaterThan(30);
		expect(modes.has('window')).toBe(true);
		expect(modes.has('modal')).toBe(true);
		expect(violations).toEqual([]);
	});
});
