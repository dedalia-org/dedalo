/**
 * READ tools — search a section, read one record, describe an ontology node.
 *
 * PURE async functions: every handler takes an explicit `Principal` and runs
 * the SAME engine paths (buildSearchSql, readSection) with the SAME
 * projects/permissions gating that the human API applies (REWRITE_SPEC §8:
 * "respecting the same ACL as human access"). There is no privilege
 * escalation seam here — an LLM acting as a restricted user sees exactly what
 * that user would see through the web client, no more. Keeping the logic here
 * (not in the transport) is what makes the ACL guarantee unit-testable
 * directly (mcp_tools.test.ts) rather than only through a live MCP session.
 */

import { z } from 'zod';
import type { Rqo } from '../../../core/concepts/rqo.ts';
import type { SqoFilterNode } from '../../../core/concepts/sqo.ts';
import type { ApiNotice } from '../../../core/errors/schema.ts';
import { getModelByTipo } from '../../../core/ontology/resolver.ts';
import { assertValidTipo } from '../../../core/search/identifier_gate.ts';
import { runSearch } from '../../../core/search/search_statement.ts';
import { buildSearchSql } from '../../../core/search/sql_assembler.ts';
import { readSection } from '../../../core/section/read.ts';
import type { Principal } from '../../../core/security/permissions.ts';
import { authorizeComponentRead } from '../../../core/security/read_door.ts';
import { defineTool, type ToolSpec } from '../tool_spec.ts';

/** The default page size an MCP search returns when the caller omits `limit`. */
const DEFAULT_SEARCH_LIMIT = 20;
/** Hard ceiling on an MCP search page (mirrors the client SQO clamp intent). */
const MAX_SEARCH_LIMIT = 100;

/** One record hit from a section search — the locator the LLM can then read. */
export interface SectionSearchHit {
	section_tipo: string;
	section_id: number;
}

export interface SectionSearchResult {
	section_tipo: string;
	/** Total records the principal may see (projects-filtered), not just this page. */
	total: number;
	limit: number;
	offset: number;
	hits: SectionSearchHit[];
}

/** An optional single-component filter for an MCP search (one SQO leaf clause). */
export interface McpSearchFilter {
	/** The component to match on (e.g. an input_text tipo). */
	component_tipo: string;
	/** The query value — the SQO `q` grammar applies (`==exact`, `*`, `!*`, substring). */
	query: string;
	/** Language for the matched value (default lg-eng). */
	lang?: string;
}

/**
 * Search a section for records the principal is allowed to see, optionally
 * matching one component value. Runs the real SQO→SQL assembler with the
 * caller's `Principal`, so the per-record projects filter (§7.4) applies exactly
 * as it would for a human search: a non-admin without the record's project never
 * receives the hit, and `total` reflects the gated count, never the raw table
 * count. When `filter` is given it becomes one `$and` leaf, resolved by the same
 * per-component builders the web search uses (so the LLM cannot express anything
 * a human search could not).
 */
export async function searchSectionRecords(
	principal: Principal,
	input: {
		section_tipo: string;
		limit?: number;
		offset?: number;
		filter?: McpSearchFilter;
	},
): Promise<SectionSearchResult> {
	const sectionTipo = assertValidTipo(input.section_tipo, 'mcp.search.section_tipo');
	// THE SECTION READ GRANT FIRST (closure Step 3, SEC-1): the assembler's
	// principal applies the PROJECTS filter only — a record key. The human read's
	// Gate B refuses a section the profile holds 0 on; this door must too, before
	// a count or a page can say anything about it.
	await authorizeComponentRead(
		{ principal, door: 'mcp.dedalo_search_section' },
		{ sectionTipo, componentTipo: sectionTipo },
	);
	const limit = clampLimit(input.limit);
	const offset = input.offset !== undefined && input.offset > 0 ? Math.floor(input.offset) : 0;

	// Optional single-component filter → one SQO `$and` leaf (validated tipo).
	let filter: SqoFilterNode | undefined;
	if (input.filter !== undefined) {
		const componentTipo = assertValidTipo(
			input.filter.component_tipo,
			'mcp.search.filter.component_tipo',
		);
		filter = {
			$and: [
				{
					q: input.filter.query,
					path: [{ section_tipo: sectionTipo, component_tipo: componentTipo }],
					lang: input.filter.lang ?? 'lg-eng',
				},
			],
		};
	}

	// Gated count first (full_count mirrors the PHP count action).
	const countQuery = await buildSearchSql(
		{ section_tipo: [sectionTipo], full_count: true, filter },
		{ principal },
	);
	const countRows = (await runSearch(countQuery)) as { full_count: number | string }[];
	const total = countRows.reduce((sum, row) => sum + Number(row.full_count), 0);

	// Page of locators.
	const pageQuery = await buildSearchSql(
		{ section_tipo: [sectionTipo], limit, offset, filter },
		{ principal },
	);
	// matrix.section_id is an INT column, so the row carries the address typed
	// (WC-2026-08-10-section-id-int-canonical). `full_count` above stays
	// union-typed: count(*) is bigint and the driver hands it back as text.
	const rows = (await runSearch(pageQuery)) as { section_id: number; section_tipo: string }[];

	return {
		section_tipo: sectionTipo,
		total,
		limit,
		offset,
		hits: rows.map((row) => ({
			section_tipo: row.section_tipo,
			section_id: Number(row.section_id),
		})),
	};
}

/**
 * Read one record's resolved context + data in the requested language, as the
 * principal. Internally this is a `readSection` over a `filter_by_locators` SQO
 * pinned to the single record — the same path the web client uses to open a
 * record — so component resolution, permission stamping and (for non-admins)
 * the projects filter all apply. A record the principal may not see resolves to
 * empty `data`, never an error that would confirm the record exists.
 *
 * THE SECTION GRANT FIRST (P1-3 / SEC-11's shape, 2026-09-03): `readSection`
 * gates each ddo on the component key but the SECTION read grant lives in the
 * HTTP handler (dd_core_api Gate B), which this tool bypasses — a principal
 * granted components of a section but not the section itself received the
 * record identity + those components here while the record page refused. The
 * read door's one-typed-question law applies: the caller named one section,
 * "no" is `perm.denied` (the section is not a record, so nothing about the
 * record's existence is disclosed).
 */
export async function readSectionRecord(
	principal: Principal,
	input: { section_tipo: string; section_id: number; lang?: string; mode?: string },
): Promise<{ context: unknown[]; data: unknown[]; notices?: ApiNotice[] }> {
	const sectionTipo = assertValidTipo(input.section_tipo, 'mcp.read.section_tipo');
	const sectionId = Math.floor(input.section_id);
	await authorizeComponentRead(
		{ principal, door: 'mcp.dedalo_read_record' },
		{ sectionTipo, componentTipo: sectionTipo },
	);
	const lang = input.lang ?? 'lg-eng';
	const mode = input.mode === 'edit' ? 'edit' : 'list';

	const rqo: Rqo = {
		action: 'read',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		source: {
			model: 'section',
			tipo: sectionTipo,
			section_tipo: sectionTipo,
			mode,
			lang,
			action: 'list',
		},
		sqo: {
			section_tipo: [sectionTipo],
			filter_by_locators: [{ section_tipo: sectionTipo, section_id: sectionId }],
			limit: 1,
		},
	} as unknown as Rqo;

	const result = await readSection(rqo, principal);
	// The emission's notices (a stopped record cycle, a depth-bound stop, a
	// refused level >= 2 'self' ddo — section/read.ts ReadResult.notices) ride
	// the tool result exactly as read_facade.ts lifts them onto the HTTP
	// envelope: a shortened subtree is never silent for the assistant either.
	// (agent/egress.ts gateAgentToolResult walks them too — their section_tipo
	// details are classified like any other section in the result.)
	return {
		context: result.context,
		data: result.data as unknown[],
		...(result.notices !== undefined && result.notices.length > 0
			? { notices: result.notices }
			: {}),
	};
}

/**
 * Describe an ontology node: its runtime model and whether it is a section.
 * Read-only ontology introspection so an LLM can discover what a `tipo` is
 * before searching or reading it. No record data is touched, so no per-record
 * ACL applies — but the tool still validates the identifier at the chokepoint.
 */
export async function describeOntologyNode(
	_principal: Principal,
	input: { tipo: string },
): Promise<{ tipo: string; model: string | null }> {
	const tipo = assertValidTipo(input.tipo, 'mcp.describe.tipo');
	const model = await getModelByTipo(tipo);
	return { tipo, model };
}

function clampLimit(requested: number | undefined): number {
	if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
		return DEFAULT_SEARCH_LIMIT;
	}
	return Math.min(Math.floor(requested), MAX_SEARCH_LIMIT);
}

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

const READ_ANNOTATIONS = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
} as const;

export const RECORDS_READ_SPECS: ToolSpec[] = [
	defineTool({
		name: 'dedalo_search_section',
		title: 'Search a section',
		description:
			'Simple single-filter section search: a page of record locators ' +
			'{section_tipo, section_id} plus the projects-filtered total. For ' +
			'AND/OR filters, labels, multi-hop paths or ordering use ' +
			'dedalo_search_records instead. Open a hit with dedalo_read_record.',
		tier: 'primitive',
		write: false,
		annotations: { ...READ_ANNOTATIONS },
		inputShape: {
			section_tipo: z
				.string()
				.describe('The section ontology tipo, e.g. "oh1" (lowercase letters then digits).'),
			limit: z.number().optional().describe('Page size (default 20, max 100).'),
			offset: z.number().optional().describe('Records to skip for pagination (default 0).'),
			filter: z
				.object({
					component_tipo: z
						.string()
						.describe('The component tipo to match on, e.g. "oh23" (a text component).'),
					query: z
						.string()
						.describe(
							'Value to match. Grammar: "==exact" for equality, "*" not-empty, ' +
								'"!*" empty, otherwise a case-insensitive substring match.',
						),
					lang: z.string().optional().describe('Language tag for the value (default "lg-eng").'),
				})
				.optional()
				.describe('Optional single-component value filter.'),
		},
		handler: searchSectionRecords,
	}),
	defineTool({
		name: 'dedalo_read_record',
		title: 'Read a record',
		description:
			'Read one Dédalo record as the configured user: resolved component ' +
			'context + data in the requested language. Records the user may not ' +
			'access return empty data (existence is never confirmed).',
		tier: 'primitive',
		write: false,
		annotations: { ...READ_ANNOTATIONS },
		inputShape: {
			section_tipo: z.string().describe('The record section ontology tipo, e.g. "oh1".'),
			section_id: z.number().describe('The record id within that section.'),
			lang: z.string().optional().describe('Language tag, e.g. "lg-eng" (default) or "lg-spa".'),
			mode: z
				.enum(['list', 'edit'])
				.optional()
				.describe('"list" (default, read-only labels) or "edit" (full component values).'),
		},
		handler: readSectionRecord,
	}),
	defineTool({
		name: 'dedalo_describe_node',
		title: 'Describe an ontology node',
		description:
			'Describe an ontology node: its runtime model (e.g. "section", ' +
			'"component_input_text"). Use it to learn what a tipo is before ' +
			'searching or reading it.',
		tier: 'primitive',
		write: false,
		annotations: { ...READ_ANNOTATIONS },
		inputShape: {
			tipo: z.string().describe('The ontology tipo to describe, e.g. "oh1" or "oh23".'),
		},
		handler: describeOntologyNode,
	}),
];
