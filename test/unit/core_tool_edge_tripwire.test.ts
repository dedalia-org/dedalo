/**
 * CORE → TOOL EDGE CENSUS (DEC-12, 2026-09-24) — src/ never names a specific
 * tool, except through ledgered, shrink-only edges.
 *
 * A tool is a plug-in: it lives under `tools/tool_<name>/`, may be absent from
 * an installation's roots, and reaches the engine through ONE contract — the
 * `ToolServerModule` the loader discovers (src/core/tools/loader.ts). Actions,
 * lanes, availability, HTTP routes (`httpRoutes`) and boot timers (`onBoot`)
 * are all registered through it. An import from src/ into a tool's files
 * bypasses that: the engine then depends on one tool by path, loads it whether
 * or not it is installed, and the next tool that wants a route or a boot hook
 * copies the pattern. That is the S3-02 erosion `boundary_seam_tripwire`
 * prevents for diffusion; this gate does the same for tools.
 *
 * TWO ROUTES, TWO CENSUSES — both DERIVED over every non-test `.ts` under src/
 * (comments stripped):
 *
 * 1. IMPORT EDGES — static imports, `export … from`, and dynamic `import()`
 *    specifiers; each is RESOLVED against the importing file, and one that
 *    lands under `tools/tool_*` is an edge. Every edge must be in
 *    `LEDGERED_EDGES` with a reason.
 * 2. NAMES IN CODE — an import census alone lets `if (tool === 'tool_export')`
 *    through: no edge, same coupling (a tool-specific branch in the engine).
 *    So every occurrence of a tool NAME (a `tools/tool_<name>/` directory of
 *    this checkout, matched as a whole identifier-word) in code or in a string
 *    / template literal is counted per (file, tool). The count must EQUAL
 *    `LEDGERED_NAMES` — a new file, a new tool, or one more occurrence is red
 *    (register the behaviour through the ToolServerModule contract instead);
 *    fewer is red too, so the ledger is lowered in the same change (shrink-only
 *    by construction: a lowered number never has a reason to rise again).
 *    Scope, stated: only the names of tools PRESENT under `tools/` are known;
 *    a name built at runtime (`'tool_' + x`) is not a name and is not counted.
 *
 * A stale entry in either ledger is red.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { engineSourceFiles } from '../helpers/engine_source_corpus.ts';
import { stripComments } from '../helpers/strip_comments.ts';
import { TOOLS_DIR, toolDirectoryNames } from '../helpers/tool_directory_corpus.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');

/** file (repo-relative) → the tool files it imports (repo-relative). Shrink-only. */
const LEDGERED_EDGES: Record<string, { targets: readonly string[]; reason: string }> = {
	'src/core/tools/transcription_asr.ts': {
		targets: ['tools/tool_transcription/transcribers/lib/paragraphs.js'],
		reason:
			'The shared ASR engine renders segments with the SAME paragraph builder the browser transcriber uses (one implementation of the text_area HTML both paths write). Clears when that pure helper moves under src/ and the tool imports it from there.',
	},
};

/**
 * (file → tool name → exact occurrence count) of tool names in src/ CODE and
 * string literals (comments stripped). Shrink-only: lower a count in the same
 * change that removes an occurrence; never raise one — route the behaviour
 * through the ToolServerModule contract instead.
 */
const LEDGERED_NAMES: Record<string, { names: Readonly<Record<string, number>>; reason: string }> =
	{
		'src/core/ai/model_catalog.ts': {
			names: { tool_transcription: 1 },
			reason:
				'The AI model catalog keys the ASR model list by the owning tool name (`const TOOL`) — a registry key, not a branch. Clears when the tool contributes its models through its ToolServerModule.',
		},
		'src/ai/capabilities.ts': {
			names: { tool_assistant: 1, tool_identify: 1 },
			reason:
				'The AI capability map names the two AI tools whose visibility the deployment flags gate (CAPABILITY_GATED_TOOLS): a tool-name key into a hide rule, applied once by getUserTools. A real name-keyed coupling, ADDED 2026-10-29 with owner-visible reason (WC-2026-10-29-ai-capabilities-page-globals). Clears when the ToolServerModule contract can declare its own capability gate and the tools stop being named here.',
		},
		'src/core/api/handlers/dd_mcp_api.ts': {
			names: { tool_assistant: 1 },
			reason:
				'The agent HTTP door (closure Step 3, SEC-3) asks the caller’s profile for THE tool this API class serves: dd_mcp_api IS tool_assistant’s server half (the tool has no ToolServerModule of its own), so its grant is named where its door is. A real name-keyed coupling, ADDED 2026-09-30 with owner-visible reason (WC-2026-09-30-agent-tool-grant). Clears when tool_assistant gets a ToolServerModule whose actions are these and the dispatch asks the grant by construction.',
		},
		'src/core/api/handlers/dd_identify_api.ts': {
			names: { tool_identify: 1 },
			reason:
				'The vision spend (closure Step 3, TOOLS-4 grant half) asks the caller’s profile for THE tool this API class serves: dd_identify_api IS tool_identify’s server half (the tool has no ToolServerModule of its own), so its grant is named where its door is (`VISION_SPEND_TOOL`). A real name-keyed coupling, ADDED 2026-10-01 with owner-visible reason (WC-2026-10-01-identify-vision-grant). Clears when tool_identify gets a ToolServerModule whose actions are these and the dispatch asks the grant by construction.',
		},
		'src/core/resolve/environment.ts': {
			names: { tool_error_report: 1 },
			reason:
				'page_globals.tool_error_report_granted asks the ONE grant door (isToolGranted) for THE tool behind the client error-report launcher tab, which page shell code renders before any tool loads. A real name-keyed coupling, ADDED 2026-10-21 with owner-visible reason (WC-2026-10-21-error-report-granted). Clears when the ToolServerModule contract can contribute page_globals keys and the tool publishes its own grant flag.',
		},
		'src/ai/rag/api.ts': {
			names: { tool_rag: 1 },
			reason:
				'The generative RAG spend (closure Step 3, TOOLS-4 budget half) asks the caller’s profile for THE tool that opens the generative answer (`GENERATIVE_RAG_TOOL`): dd_rag_api is the server half of tool_rag (which has no ToolServerModule of its own; retrieval stays ungranted core search), so its grant is named where its door is. A real name-keyed coupling, ADDED 2026-10-01 with owner-visible reason (WC-2026-10-01-ai-spend-budget). Clears when tool_rag gets a ToolServerModule whose actions are these and the dispatch asks the grant by construction.',
		},
		'src/core/db/matrix_index_policy.ts': {
			names: { tool_time_machine: 1 },
			reason:
				'Prose in an index-policy `reason` string naming the reader (bulk_revert) that justifies the index; no behaviour keys on it.',
		},
		'src/core/install/media_tree.ts': {
			names: { tool_export: 2, tool_transcription: 4 },
			reason:
				'Prose in media-folder `reason`/`consumer` strings and one warning: they name the tool that writes into the folder the installer provisions. Descriptive only; no branch.',
		},
		'src/core/media/ontology_path.ts': {
			names: { tool_upload: 1, tool_import_files: 1 },
			reason:
				'Prose in a migration-ledger `reason` string naming the ingest callers; no behaviour keys on it.',
		},
		'src/core/ontology/property_census.ts': {
			names: { tool_numisdata_order_coins: 1 },
			reason:
				'Prose in a property-census `reason` string naming the v6 flag owner; no behaviour keys on it.',
		},
		'src/core/section/indexation_grid.ts': {
			names: { tool_indexation: 1, tool_transcription: 1 },
			reason:
				'The indexation grid asks for the element tool contexts of the two tools its buttons open (elementToolContext by name). A real name-keyed coupling. Clears when the grid reads its button tools from the ontology/tool registry instead of naming them.',
		},
		'src/core/tools/picker_wiring.ts': {
			names: { tool_indexation: 1, tool_cataloging: 1 },
			reason:
				'The picker-wiring table keys two tools’ source/linker roles by name. A real name-keyed coupling. Clears when a ToolServerModule declares its own picker wiring.',
		},
		'src/core/tools/registry.ts': {
			names: { tool_diffusion: 1 },
			reason:
				'Availability special case: tool_diffusion is offered only when a diffusion domain resolves (`if (name === …)`). A real name branch. Clears when availability moves to the tool module’s `isAvailable`.',
		},
		'src/core/tools/transcription_asr.ts': {
			names: { tool_transcription: 3 },
			reason:
				'The shared ASR engine: one import path (the ledgered edge above) and two log prefixes naming the tool the job belongs to. Clears with the edge.',
		},
		'src/diffusion/export/atoms.ts': {
			names: { tool_export: 1 },
			reason: 'Error-message prefix of the export fan-out depth guard; descriptive, no branch.',
		},
		'src/diffusion/export/compile_columns.ts': {
			names: { tool_export: 2 },
			reason:
				'The export column compiler stamps its synthetic diffusion element as the tool_export files service (elementTipo prefix, serviceName). Engine export IS the tool’s backend; clears when the caller passes its own service identity in.',
		},
		'src/diffusion/export/grid.ts': {
			names: { tool_export: 10 },
			reason:
				'Gate coordinates (`door`, `coordinates.tool`) and message prefixes on the export grid’s read-grant refusals. Clears when the calling door is passed in by the tool instead of hard-coded here.',
		},
	};

/** Tool names of this checkout: the registered tools-directory lister. */
function toolNames(): string[] {
	return toolDirectoryNames();
}

/** tool name → occurrences in a source text's code and literals (comments stripped). */
function namesIn(source: string, known: ReadonlySet<string>): Record<string, number> {
	const out: Record<string, number> = {};
	for (const match of stripComments(source).matchAll(
		/(?<![A-Za-z0-9_$])tool_[a-z0-9_]+(?![A-Za-z0-9_$])/g,
	)) {
		const name = match[0];
		if (known.has(name)) out[name] = (out[name] ?? 0) + 1;
	}
	return out;
}

/** file (repo-relative) → tool name → count, derived. */
function nameCensus(
	files: readonly string[],
	known: ReadonlySet<string>,
): Map<string, Record<string, number>> {
	const census = new Map<string, Record<string, number>>();
	for (const file of files) {
		const found = namesIn(readFileSync(file, 'utf8'), known);
		if (Object.keys(found).length > 0) census.set(relative(REPO_ROOT, file), found);
	}
	return census;
}

/** Every non-test .ts under src/ — the registered engine-source lister, absolute. */
function srcFiles(): string[] {
	return engineSourceFiles().filter((file) => !file.endsWith('.test.ts'));
}

/** Every module specifier in a source text: static, re-export, and dynamic. */
function specifiersOf(source: string): string[] {
	const code = stripComments(source);
	const out: string[] = [];
	for (const pattern of [
		/\bimport\s+(?:type\s+)?(?:[\w*{}\s,]+?\s+from\s+)?['"]([^'"]+)['"]/g,
		/\bexport\s+(?:type\s+)?[\w*{}\s,]+?\s+from\s+['"]([^'"]+)['"]/g,
		/\bimport\s*\(\s*['"`]([^'"`]+)['"`]/g,
	]) {
		for (const match of code.matchAll(pattern)) out.push(match[1] as string);
	}
	return out;
}

/** The src/→tools/tool_* edges, derived. */
function toolEdges(files: readonly string[]): Map<string, string[]> {
	const edges = new Map<string, string[]>();
	for (const file of files) {
		for (const specifier of specifiersOf(readFileSync(file, 'utf8'))) {
			if (!specifier.startsWith('.')) continue;
			const target = resolve(dirname(file), specifier);
			if (!target.startsWith(TOOLS_DIR + sep)) continue;
			const rel = relative(REPO_ROOT, target);
			if (!/^tools\/tool_[a-z0-9_]+\//.test(rel)) continue;
			const from = relative(REPO_ROOT, file);
			edges.set(from, [...(edges.get(from) ?? []), rel].sort());
		}
	}
	return edges;
}

describe('core → tool edges are ledgered and shrink-only', () => {
	const scanned = srcFiles();
	const edges = toolEdges(scanned);

	test('the walk covers src/ (non-vacuity floor)', () => {
		expect(scanned.length).toBeGreaterThan(600);
	});

	test('the specifier scan sees all three import shapes (positive control)', () => {
		const planted = [
			"import { a } from '../../tools/tool_x/server/a.ts';",
			"export { b } from '../../tools/tool_x/server/b.ts';",
			"const c = await import('../../tools/tool_x/server/c.ts');",
			"import type { D } from '../../tools/tool_x/server/d.ts';",
		].join('\n');
		expect(specifiersOf(planted)).toEqual([
			'../../tools/tool_x/server/a.ts',
			'../../tools/tool_x/server/d.ts',
			'../../tools/tool_x/server/b.ts',
			'../../tools/tool_x/server/c.ts',
		]);
		// a comment naming a tool is prose, not an edge
		expect(specifiersOf("// import('../../tools/tool_x/server/e.ts')")).toEqual([]);
	});

	test('the scan finds the ledgered edge (anti-vacuity)', () => {
		expect(edges.get('src/core/tools/transcription_asr.ts')).toEqual([
			'tools/tool_transcription/transcribers/lib/paragraphs.js',
		]);
	});

	test('every edge is ledgered', () => {
		const unledgered: string[] = [];
		for (const [from, targets] of edges) {
			const allowed = LEDGERED_EDGES[from]?.targets ?? [];
			for (const target of targets) {
				if (!allowed.includes(target)) unledgered.push(`${from} → ${target}`);
			}
		}
		expect(
			unledgered,
			'src/ imports a specific tool. Register it through the ToolServerModule contract instead (apiActions, httpRoutes, onBoot — src/core/tools/module.ts); the engine must not name a tool by path',
		).toEqual([]);
	});

	test('no ledger entry is stale (shrink-only)', () => {
		const stale: string[] = [];
		for (const [from, entry] of Object.entries(LEDGERED_EDGES)) {
			for (const target of entry.targets) {
				if (!(edges.get(from) ?? []).includes(target)) stale.push(`${from} → ${target}`);
			}
			expect(entry.reason.length, `${from}: the reason says why`).toBeGreaterThan(40);
		}
		expect(stale, 'Delete the entry — a dead ledger line widens the law silently').toEqual([]);
	});
});

describe('tool names in src/ code are ledgered and shrink-only', () => {
	const known = new Set(toolNames());
	const census = nameCensus(srcFiles(), known);

	test('the tool-name set is derived from tools/ (non-vacuity floor)', () => {
		expect(known.size).toBeGreaterThan(25);
		expect(known.has('tool_export')).toBe(true);
	});

	test('the name scan counts code and literals, not comments or longer identifiers (positive control)', () => {
		const planted = [
			"if (tool === 'tool_x') run();",
			'const t = `tool_x:${a}`;',
			'const tool_x_helper = 1; // tool_x in prose',
			'/* tool_x */ const other = tool_xy;',
			'const route = { tool_x: 1 };',
		].join('\n');
		expect(namesIn(planted, new Set(['tool_x', 'tool_xy']))).toEqual({ tool_x: 3, tool_xy: 1 });
	});

	test('the scan finds a ledgered name branch (anti-vacuity)', () => {
		expect(census.get('src/core/tools/registry.ts')).toEqual({ tool_diffusion: 1 });
	});

	test('every tool name in src/ code matches the ledger exactly', () => {
		const drift: string[] = [];
		const files = new Set([...census.keys(), ...Object.keys(LEDGERED_NAMES)]);
		for (const file of [...files].sort()) {
			const found = census.get(file) ?? {};
			const allowed = LEDGERED_NAMES[file]?.names ?? {};
			for (const name of new Set([...Object.keys(found), ...Object.keys(allowed)])) {
				const have = found[name] ?? 0;
				const ledgered = allowed[name] ?? 0;
				if (have > ledgered)
					drift.push(`${file}: ${name} ×${have} > ledgered ${ledgered} (NEW coupling)`);
				else if (have < ledgered)
					drift.push(`${file}: ${name} ×${have} < ledgered ${ledgered} (lower the ledger)`);
			}
		}
		expect(
			drift,
			'src/ names a specific tool. A tool-specific branch, route or key belongs in the tool, registered through the ToolServerModule contract (src/core/tools/module.ts); shrink the ledger when an occurrence goes',
		).toEqual([]);
	});

	test('every name-ledger entry says why', () => {
		for (const [file, entry] of Object.entries(LEDGERED_NAMES)) {
			expect(entry.reason.length, `${file}: the reason says why`).toBeGreaterThan(40);
		}
	});
});
