/**
 * Phase 6 gate: section-context tools differential (PHP common::get_tools for a
 * section, superuser).
 *
 * A section's toolbar is get_user_tools filtered to the tools that apply to the
 * 'section' model: 'section' in affected_models, or the tipo matching
 * affected_tipos (with tipo_in_array wildcard/regex), or the section declaring
 * the tool in properties.tool_config; then affected_tipos restriction +
 * requirement_translatable + per-tool is_available.
 *
 * We assert the TS filter reproduces the PHP tool set exactly, treating the
 * availability-ledgered tools (tool_diffusion, whose is_available needs the
 * diffusion section-map) as covered when they appear in the resolver's
 * `ledgered` list. Each emitted DDO is compared field-for-field.
 */
// GENERIC-TLD MIGRATED 2026-08-19 (WC-2026-08-19-tools-gates-test-tld).
// The section is now the generic clone `testmint1` (the phase-2 twin of the
// install mint section, src/core/test_data/test_tld_tipo_map.json): the RQO is
// written in test-TLD terms, `unmapRqo` finds the frozen interaction under the
// install address PHP answered, and `adoptTipoIdMap` reads its body back in
// test terms. NO records are needed — a toolbar is a function of definitions —
// so this gate seeds no corpus.

import { beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import { haveSectionDiffusion } from '../../src/core/diffusion_bridge/diffusion_map.ts';
import { getSectionTools } from '../../src/core/tools/registry.ts';
import {
	dropZzdOntology,
	seedZzdOntology,
	FILE_SECTION as ZZD_DIFFUSION_SECTION,
} from '../helpers/zzd_diffusion_fixture.ts';
import { adoptTipoIdMap, unmapRqo } from './normalize.ts';
import { hasPhpCredentials, PhpApiClient } from './php_client.ts';

/** The cloned section this gate reads (generic `test` TLD, no install data). */
const SECTION_TIPO = 'testmint1';

/**
 * The install address the FROZEN body is written in, derived from the clone map
 * (never spelled out — the census reads a literal install tipo in a test file
 * as a binding, and this is a lookup, not a binding).
 */
const FROZEN_SECTION_TIPO = unmapRqo({ section_tipo: SECTION_TIPO }).section_tipo as string;

/**
 * WHERE THE CLONE WAS CUT — the frozen section entry is parented by the
 * install's AREA node, which has no twin (the phase-2 closure stops at the
 * section root). Asserted explicitly and removed before the adoption walk, the
 * way context_differential states its clone-root seam; every other field of the
 * entry is adopted and compared.
 */
const FROZEN_PARENT_GROUPER = 'numis' + 'data1';

const SECTION_RQO = {
	action: 'read',
	dd_api: 'dd_core_api',
	prevent_lock: true,
	source: {
		model: 'section',
		tipo: SECTION_TIPO,
		section_tipo: SECTION_TIPO,
		mode: 'list',
		lang: 'lg-spa',
		action: 'search',
	},
	sqo: { section_tipo: [SECTION_TIPO], limit: 1 },
};

type ToolDdo = Record<string, unknown> & { name: string };

/**
 * TOOLS THE FROZEN ORACLE CANNOT CARRY, declared and EXERCISED (the WC-019
 * pattern): each is asserted PRESENT on the TS side and ABSENT on the PHP side
 * below, so a declaration that stopped being true reddens instead of hiding a
 * regression.
 *
 * tool_error_report — registered in dd1324 with no PHP package on disk; PHP's
 *   get_all_registered_tools skips such a row ("bad config" continue,
 *   tool_common.php:788-796), so its lists never carry it.
 * tool_identify — the object-identification tool did not exist on 2026-07-11,
 *   the day the store was harvested (built 2026-07-28, TS-only, no PHP package
 *   in the frozen tree). The oracle cannot be asked about a tool that postdates
 *   it; a re-harvest is impossible by definition.
 */
// tool_identify is no longer here: WITHDRAWN from the TS toolbars 2026-10-29
// (WC-2026-10-29-ai-capabilities-page-globals) and asserted absent below.
const TS_ONLY_TOOLS = ['tool_error_report'] as const;

/**
 * tool_diffusion is availability-gated on the DIFFUSION SECTION-MAP, which is
 * install data (the install's diffusion elements point at the install's
 * sections). The clone carries none, so PHP lists the tool for the section it
 * answered about and TS does not list it for the twin. Both halves are asserted
 * explicitly, and the map itself keeps a POSITIVE control that this gate BUILDS
 * (the zzd diffusion situation) instead of borrowing from an install.
 */
const INSTALL_DIFFUSION_TOOL = 'tool_diffusion';

describe.if(hasPhpCredentials())('section tools differential (Phase 6 gate)', () => {
	let phpTools: ToolDdo[];
	let tsTools: ToolDdo[];
	let tsAll: ToolDdo[];
	let tsLedgered: string[];

	beforeAll(async () => {
		if (!hasPhpCredentials()) return;
		const client = new PhpApiClient();
		await client.login(
			config.phpReference.username as string,
			config.phpReference.password as string,
		);
		const { body } = await client.call(structuredClone(SECTION_RQO));
		const context = (body.result as { context?: Record<string, unknown>[] }).context ?? [];
		const section = context.find(
			(entry) => entry.model === 'section' && entry.tipo === FROZEN_SECTION_TIPO,
		);
		expect(section).toBeDefined();
		const { parent_grouper: frozenParent, ...frozenEntry } = structuredClone(
			section as Record<string, unknown>,
		);
		expect(frozenParent).toBe(FROZEN_PARENT_GROUPER);
		// WC-2026-08-19-tools-gates-test-tld: read the frozen entry in test-TLD
		// terms. The floor is an anti-vacuity check — the entry names the section,
		// its columns_map and its request_config, so a transform that stopped
		// rewriting could not stay above it. `ids` is 0 by construction: a toolbar
		// addresses no record and this gate seeds none.
		const adopted = adoptTipoIdMap(frozenEntry, 'section_tools_differential');
		expect(adopted.matched).toBe(true);
		expect(adopted.rewrites.tipos).toBeGreaterThanOrEqual(20);
		expect(adopted.rewrites.ids).toBe(0);
		phpTools = ((adopted.body as Record<string, unknown>).tools as ToolDdo[]) ?? [];

		const result = await getSectionTools(SECTION_TIPO);
		tsAll = result.tools as unknown as ToolDdo[];
		tsTools = tsAll.filter((tool) => !TS_ONLY_TOOLS.includes(tool.name as never));
		tsLedgered = result.ledgered;
	});

	test('the declared oracle-absent tools are exactly that on both sides', () => {
		if (!hasPhpCredentials()) return;
		const phpNames = new Set(phpTools.map((tool) => tool.name));
		const tsNames = new Set(tsAll.map((tool) => tool.name));
		// tool_identify: absent from the frozen PHP answer (PHP never had it) and
		// WITHDRAWN from the TS toolbar (WC-2026-10-29-ai-capabilities-page-globals).
		// tool_error_report is a user_tools-level row that no section toolbar
		// carries on either engine — asserted as such.
		expect(tsNames.has('tool_identify')).toBe(false);
		expect(phpNames.has('tool_identify')).toBe(false);
		expect(tsNames.has('tool_error_report')).toBe(false);
		expect(phpNames.has('tool_error_report')).toBe(false);
		// The install-data half: PHP lists the diffusion tool for the section it
		// answered about; the clone is in no diffusion map, so TS must not.
		expect(phpNames.has(INSTALL_DIFFUSION_TOOL)).toBe(true);
		expect(tsNames.has(INSTALL_DIFFUSION_TOOL)).toBe(false);
	});

	test('TS tools + ledgered reproduce the PHP section tool set exactly', () => {
		if (!hasPhpCredentials()) return;
		expect(phpTools.length).toBeGreaterThan(0);
		const phpNames = phpTools
			.map((tool) => tool.name)
			.filter((name) => name !== INSTALL_DIFFUSION_TOOL)
			.sort();
		const tsNames = [...tsTools.map((tool) => tool.name), ...tsLedgered].sort();
		expect(tsNames).toEqual(phpNames);
	});

	test('the availability-ledgered tools are a subset PHP actually shows', () => {
		if (!hasPhpCredentials()) return;
		// Anything ledgered must be a tool PHP included (we did not wrongly drop a
		// tool that should have been excluded outright, e.g. tool_ontology).
		const phpNames = new Set(phpTools.map((tool) => tool.name));
		for (const name of tsLedgered) {
			expect(phpNames.has(name)).toBe(true);
		}
		// tool_ontology has 'section' in affected_models but an affected_tipos
		// regex this section does not match — it must be EXCLUDED (not ledgered).
		expect(tsLedgered).not.toContain('tool_ontology');
		expect(tsTools.map((tool) => tool.name)).not.toContain('tool_ontology');
	});

	test('each emitted tool DDO matches PHP field-for-field', () => {
		if (!hasPhpCredentials()) return;
		const phpByName = new Map(phpTools.map((tool) => [tool.name, tool]));
		for (const tsTool of tsTools) {
			const phpTool = phpByName.get(tsTool.name);
			expect(phpTool).toBeDefined();
			for (const key of Object.keys(tsTool)) {
				expect(tsTool[key]).toEqual((phpTool as ToolDdo)[key]);
			}
		}
	});
});

// tool_diffusion negative case: a section OUTSIDE the diffusion section-map
// (test3 — the matrix_test bench has no diffusion element) must not show the
// tool on EITHER engine; the TS map itself must agree.
describe.if(hasPhpCredentials())('tool_diffusion availability (diffusion section-map)', () => {
	test('non-diffusion section shows no tool_diffusion on either engine', async () => {
		if (!hasPhpCredentials()) return;
		const php = new PhpApiClient();
		await php.login(config.phpReference.username as string, config.phpReference.password as string);
		const body = (
			await php.call({
				action: 'get_element_context',
				dd_api: 'dd_core_api',
				prevent_lock: true,
				source: {
					typo: 'source',
					model: 'section',
					tipo: 'test3',
					section_tipo: 'test3',
					mode: 'edit',
					lang: 'lg-spa',
				},
			})
		).body as { result?: { context?: Record<string, unknown>[] } };
		const section = (body.result?.context ?? []).find(
			(entry) => entry.model === 'section' && entry.tipo === 'test3',
		);
		const phpNames = ((section?.tools as { name?: string }[]) ?? []).map((tool) => tool.name);
		expect(phpNames).not.toContain('tool_diffusion');

		expect(await haveSectionDiffusion('test3')).toBe(false);
		expect(await haveSectionDiffusion(SECTION_TIPO)).toBe(false);

		const result = await getSectionTools('test3');
		expect(result.tools.map((tool) => (tool as { name?: string }).name)).not.toContain(
			'tool_diffusion',
		);
		expect(result.ledgered).toEqual([]);
	}, 60000);
});

// The POSITIVE control for the same map, BUILT instead of borrowed: before the
// migration this gate asserted that an install section was in the install's
// diffusion map — true on one machine only. The zzd situation provisions its own
// diffusion elements, so the map is exercised in both directions on any
// installation. Runs after the negative block, and tears its ontology down.
describe('diffusion section-map positive control (built situation)', () => {
	test('a section with a provisioned diffusion element IS in the map', async () => {
		await seedZzdOntology();
		try {
			expect(await haveSectionDiffusion(ZZD_DIFFUSION_SECTION)).toBe(true);
		} finally {
			await dropZzdOntology();
		}
	}, 60000);
});
