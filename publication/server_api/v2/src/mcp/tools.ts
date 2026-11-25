/**
 * The nine MCP tools — the same read-only API, shaped for an AI agent instead of a URL.
 *
 * Every tool is a thin adapter over the SAME services the REST routes call. Nothing here
 * queries a database: the security model (DB_NAMES allowlist, identifier validation, bound
 * parameters) holds because this layer cannot bypass the layer that enforces them. There
 * is no write tool, and there is no place to add one.
 *
 * The DoS BOUNDS used to be claimed here on the same grounds, and that claim was false
 * (audit 2026-08-26, PUB-06): MAX_LIMIT lived in validators.ts, which is the HTTP
 * boundary — the layer MCP does not go through — and every bounded parameter below was a
 * bare `z.number()` handed straight to SQL. The bounds now live in ONE place both doors
 * import (validators.ts `mcpBounded` / `BOUNDED_PARAMETERS`): the objects in the
 * inputSchemas below ARE the objects the REST schemas parse, so the two doors cannot
 * drift, and `parseToolArgs` runs them before any handler body. Never re-declare a bound
 * here — a local copy would satisfy a reader and defeat the invariant.
 *
 * What changes for an agent is the SHAPE of a request. The REST surface is a URL DSL —
 * `filter[code][like]=OH-%`, brackets, percent-encoding, pipe-separated `in` lists — which
 * a model must assemble as a string and can silently get wrong. The tools take structured
 * arguments instead: `filters` is an array of `{field, op, value}` objects that a schema
 * can describe and a client can validate before the call is ever made. `toConditions`
 * translates that back into the internal filter model, which is the same one the URL parser
 * produces — so both surfaces meet at `FilterCondition` and cannot drift apart.
 *
 * The `describe()` text on every parameter is not decoration: it is the ONLY documentation
 * the agent gets. Defaults, valid operators and the accepted `lang` form are spelled out
 * there because the JSON Schema derived from these zod shapes is literally what the model
 * reads before choosing arguments.
 */

import { z } from 'zod';
import { dbNames } from '../config';
import { assertKnownDb } from '../db/pool';
import { listRecords, getRecord } from '../services/records.service';
import { fulltextSearch, textFragments, avFragments } from '../services/search.service';
import { listTables, getTable } from '../services/schema.service';
import { getAvIndexationFragment } from '../services/av-indexation.service';
import { parseSort } from '../utils/query-params';
import type { FilterCondition } from '../utils/query-params';
import { ValidationError } from '../errors';
import { DEFAULT_TABLE, DEFAULT_COLUMN, DEFAULT_LIMIT, DEFAULT_MAX_CHARACTERS, DEFAULT_MAX_OCCURRENCES, VALID_OPERATORS_HINT } from '../constants';
import { mcpBounded } from '../validators';

/**
 * A tool as this module defines it, before the MCP SDK sees it.
 *
 * `inputSchema` is a RAW SHAPE (a map of zod validators), not a `z.object` — that is what
 * `McpServer.registerTool` expects, and it derives the JSON Schema advertised to the client
 * from it. `handler` takes loose `Record<string, unknown>` args because MCP arguments
 * arrive as JSON-RPC params: each handler narrows them itself, and anything it gets wrong
 * is caught by the service-level validation underneath.
 *
 * The `description` and the per-field `describe()` calls are the agent-facing contract.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;
}

// MCP answers in CONTENT BLOCKS, not JSON bodies, so a result is a JSON string inside a
// text block — pretty-printed because a model reads it. Note what this costs: the REST
// envelope's `pagination` and `meta` are not here, only the service payload.
function textContent(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

// A failed tool call must come back as a READABLE RESULT, not a protocol error: an agent
// that is told "Unknown column: titel" can fix its own call and retry, whereas a transport
// exception just ends the conversation. This is why there is no RFC 9457 problem body on
// this surface — a model does not need a machine-readable error type, it needs a sentence.
function errorContent(error: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}` }] };
}

const dbParam = z.string().optional().describe(`Database name (default: ${dbNames[0]}). Use list_databases to discover available databases.`);

const filtersParam = z.array(z.object({
  field: z.string().describe('Column name'),
  op: z.string().optional().describe(`Operator (default: eq). Valid: ${VALID_OPERATORS_HINT}`),
  value: z.string().optional().describe('Comparison value. For in/not_in: pipe-separated values (e.g. "1|2|3"). Omit for is_null/is_not_null.'),
})).optional().describe('Filter conditions, combined with AND');

/**
 * `db` is optional on every tool: an agent should be able to ask a useful question without
 * first discovering that databases exist, so it defaults to the first configured one. It is
 * still put through `assertKnownDb`, so the DB_NAMES allowlist governs MCP exactly as it
 * governs HTTP — an unknown name is a 404-shaped error, never an attempted connection.
 */
function resolveDb(args: Record<string, unknown>): string {
  const db = (args.db as string | undefined) ?? dbNames[0];
  return assertKnownDb(db);
}

/**
 * The structured-filter counterpart of the URL parser (utils/query-params
 * `parseFilterParams`), producing the identical `FilterCondition[]`. Same three cases,
 * because they are properties of the operators and not of the syntax: `is_null` /
 * `is_not_null` take NO value, `in` / `not_in` take a pipe-separated list, everything else
 * takes exactly one.
 *
 * The operator is not validated here — an unknown one is rejected downstream by
 * `buildWhere`'s switch, which is the single place that decides what SQL an operator maps
 * to, and therefore the only place that can honestly say which operators exist.
 */
function toConditions(filters: unknown): FilterCondition[] {
  if (!filters) return [];
  // A model that has ignored the schema and sent the REST string DSL lands here; say so,
  // rather than letting `.map` fail on a string.
  if (!Array.isArray(filters)) {
    throw new ValidationError('filters must be an array of {field, op?, value?} objects');
  }

  return filters.map((raw) => {
    const { field, op = 'eq', value } = raw as { field: string; op?: string; value?: string };
    const operator = op.toLowerCase();

    if (operator === 'is_null' || operator === 'is_not_null') {
      return { field, operator, values: [] };
    }
    if (value === undefined) {
      throw new ValidationError(`Filter on "${field}" with operator "${operator}" requires a value`);
    }
    if (operator === 'in' || operator === 'not_in') {
      const values = String(value).split('|').map(v => v.trim()).filter(v => v !== '');
      if (values.length === 0) {
        throw new ValidationError(`Filter on "${field}" requires at least one pipe-separated value`);
      }
      return { field, operator, values };
    }
    return { field, operator, values: [String(value)] };
  });
}

// `fields` stays the REST comma-separated string rather than becoming an array: it is the
// one place the tools mirror the URL form deliberately, so that a `fields` value copied
// from a URL, a batch `params` object or a tool call means the same thing everywhere.
function parseFieldList(fields: unknown): string[] | undefined {
  if (typeof fields !== 'string' || !fields) return undefined;
  const list = fields.split(',').map(f => f.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

/**
 * The nine tools, in the order an agent naturally needs them: discover the databases,
 * introspect a schema, then query — structured (`search_records`, `get_record`,
 * `count_records`), by relevance (`fulltext_search`), or down to a passage
 * (`get_text_fragment`, `get_av_fragment`, `get_av_indexation_fragment`).
 *
 * Each handler's job is only to map loose JSON-RPC arguments onto a service call and apply
 * the documented defaults. Keep it that way: logic that lives here is logic the REST
 * surface does not get, and the two surfaces are meant to answer identically.
 */
export const tools: ToolDefinition[] = [
  {
    name: 'list_databases',
    description: 'List the public databases exposed by this API. Each database contains its own set of published tables.',
    inputSchema: {},
    handler: async () => textContent({ databases: dbNames }),
  },
  {
    name: 'get_schema',
    description: 'Introspect a database schema. Returns available tables, their columns and types, and row counts. Use this to understand the data structure before querying.',
    inputSchema: {
      db: dbParam,
      table: z.string().optional().describe('Specific table to inspect (optional, returns all tables if omitted)'),
    },
    handler: async (args) => {
      const db = resolveDb(args);
      if (args.table) {
        return textContent(await getTable(db, args.table as string));
      }
      return textContent(await listTables(db));
    },
  },
  {
    name: 'search_records',
    description: 'Search and query records from any published table. Supports structured filters, pagination, sorting, field selection, and relation resolution. Use this to retrieve structured data from the Dédalo publication database.',
    inputSchema: {
      db: dbParam,
      table: z.string().describe('Target table name (e.g., interview, ts_themes, publications)'),
      fields: z.string().optional().describe('Comma-separated list of fields to return'),
      filters: filtersParam,
      sort: z.string().optional().describe('Sort fields, comma-separated; prefix with "-" for descending (e.g., "title,-section_id")'),
      limit: mcpBounded.limit,
      offset: mcpBounded.offset,
      lang: z.string().optional().describe('Language filter (e.g., lg-eng, lg-spa)'),
      count: z.boolean().optional().describe('When true, also return the total count of matching rows'),
      resolve_relations: z.string().optional().describe('JSON object mapping column names to target tables for forward relation resolution (e.g., {"image":"image","informant":"informant"}). Supports dot notation for deep resolution (e.g., {"eventos.documentos":"image"}). Use "auto" for link columns.'),
      resolve_inverse_relations: z.string().optional().describe('Resolve inverse relations (dd_relations column). Pass "true" to auto-load mapping from publication_schema, or a JSON object like {"rsc170":"images"}'),
    },
    handler: async (args) => {
      const db = resolveDb(args);
      const { rows, total } = await listRecords(db, args.table as string, {
        fields: parseFieldList(args.fields),
        conditions: toConditions(args.filters),
        order: args.sort ? parseSort(args.sort as string) : [],
        limit: (args.limit ?? DEFAULT_LIMIT) as number,
        offset: (args.offset ?? 0) as number,
        lang: args.lang as string | undefined,
        withTotal: (args.count ?? false) as boolean,
        resolve_relations: args.resolve_relations as string | undefined,
        resolve_inverse_relations: args.resolve_inverse_relations as string | undefined,
      });
      return textContent({ data: rows, ...(total !== undefined ? { total } : {}) });
    },
  },
  {
    name: 'get_record',
    description: 'Get a single record by section_id. Records can have one row per language; without lang all language variants are returned.',
    inputSchema: {
      db: dbParam,
      table: z.string().describe('Target table name'),
      section_id: mcpBounded.section_id,
      lang: z.string().optional().describe('Language variant to return (e.g., lg-eng)'),
      fields: z.string().optional().describe('Comma-separated list of fields to return'),
      resolve_relations: z.string().optional().describe('JSON object mapping column names to target tables for forward relation resolution'),
      resolve_inverse_relations: z.string().optional().describe('Resolve inverse relations. "true" for auto-load, or JSON mapping like {"rsc170":"images"}'),
    },
    handler: async (args) => {
      const db = resolveDb(args);
      const { rows, languages, hasLang } = await getRecord(db, args.table as string, args.section_id as number, {
        fields: parseFieldList(args.fields),
        lang: args.lang as string | undefined,
        resolve_relations: args.resolve_relations as string | undefined,
        resolve_inverse_relations: args.resolve_inverse_relations as string | undefined,
      });
      return textContent({ data: rows, ...(hasLang ? { languages } : {}) });
    },
  },
  {
    name: 'count_records',
    description: 'Count records matching structured filters without fetching data. Also supports fulltext counting with the q parameter.',
    inputSchema: {
      db: dbParam,
      table: z.string().describe('Target table name'),
      filters: filtersParam,
      lang: z.string().optional().describe('Language filter (e.g., lg-eng, lg-spa)'),
      q: mcpBounded.q.optional().describe('Fulltext search query to count matching rows instead of filters (max 512 characters)'),
      column: z.string().optional().describe(`Column for fulltext count (default: ${DEFAULT_COLUMN})`),
    },
    // Counting is not a third query path: it is the ordinary search with `limit: 0`, which
    // both services read as "skip the data query, run only the COUNT". `q` and `filters`
    // are alternatives, not combinable — a fulltext count wins, and any filters passed
    // alongside it are silently ignored (`fulltextSearch` has no filter model).
    handler: async (args) => {
      const db = resolveDb(args);
      if (args.q) {
        const { total } = await fulltextSearch(db, args.table as string, {
          q: args.q as string,
          column: (args.column ?? DEFAULT_COLUMN) as string,
          lang: args.lang as string | undefined,
          limit: 0,
          offset: 0,
          withTotal: true,
        });
        return textContent({ total });
      }
      const { total } = await listRecords(db, args.table as string, {
        conditions: toConditions(args.filters),
        lang: args.lang as string | undefined,
        limit: 0,
        offset: 0,
        withTotal: true,
      });
      return textContent({ total });
    },
  },
  {
    name: 'fulltext_search',
    description: 'Perform full-text search using MariaDB FULLTEXT indexing. Returns results with relevance scores and highlighted text fragments.',
    inputSchema: {
      db: dbParam,
      table: z.string().describe('Target table name'),
      q: mcpBounded.q,
      column: z.string().optional().describe(`Column to search in (default: ${DEFAULT_COLUMN})`),
      lang: z.string().optional().describe('Language filter (e.g., lg-eng, lg-spa); without it a hit is returned once per language'),
      limit: mcpBounded.limit,
      offset: mcpBounded.offset,
      count: z.boolean().optional().describe('When true, also return the total count of matching rows'),
      resolve_relations: z.string().optional().describe('JSON object mapping column names to target tables for forward relation resolution'),
      resolve_inverse_relations: z.string().optional().describe('Resolve inverse relations. "true" for auto-load, or JSON mapping like {"rsc170":"images"}'),
    },
    handler: async (args) => {
      const db = resolveDb(args);
      const { rows, total } = await fulltextSearch(db, args.table as string, {
        q: args.q as string,
        column: (args.column ?? DEFAULT_COLUMN) as string,
        lang: args.lang as string | undefined,
        limit: (args.limit ?? DEFAULT_LIMIT) as number,
        offset: (args.offset ?? 0) as number,
        withTotal: (args.count ?? false) as boolean,
        resolve_relations: args.resolve_relations as string | undefined,
        resolve_inverse_relations: args.resolve_inverse_relations as string | undefined,
      });
      return textContent({ data: rows, ...(total !== undefined ? { total } : {}) });
    },
  },
  {
    name: 'get_text_fragment',
    description: 'Extract text fragments from large publication texts (books, thesis, etc.). Returns excerpts with page references and highlighted matches.',
    inputSchema: {
      db: dbParam,
      table: z.string().describe('Table containing the text (e.g., publications)'),
      section_id: mcpBounded.section_id,
      terms: mcpBounded.terms,
      column: z.string().optional().describe(`Column containing the text (default: ${DEFAULT_COLUMN})`),
      lang: z.string().optional().describe('Language variant to read (e.g., lg-eng)'),
      max_characters: mcpBounded.max_characters,
      max_occurrences: mcpBounded.max_occurrences,
    },
    handler: async (args) => {
      const db = resolveDb(args);
      const fragments = await textFragments(db, args.table as string, args.section_id as number, {
        terms: args.terms as string,
        column: (args.column ?? DEFAULT_COLUMN) as string,
        lang: args.lang as string | undefined,
        max_characters: (args.max_characters ?? DEFAULT_MAX_CHARACTERS) as number,
        max_occurrences: (args.max_occurrences ?? DEFAULT_MAX_OCCURRENCES) as number,
      });
      return textContent({ data: fragments });
    },
  },
  {
    name: 'get_av_fragment',
    description: 'Extract audiovisual interview fragments. Returns transcription excerpts with video timecodes, media URLs, and speaker information.',
    inputSchema: {
      db: dbParam,
      table: z.string().optional().describe(`Table name (default: ${DEFAULT_TABLE})`),
      section_id: mcpBounded.section_id,
      terms: mcpBounded.terms,
      lang: z.string().optional().describe('Language variant to read (e.g., lg-eng)'),
      max_characters: mcpBounded.max_characters,
      max_occurrences: mcpBounded.max_occurrences,
    },
    // The only tool with a default TABLE: the AV path is tied to the interview shape
    // anyway (see the AV_* config), so making an agent name the table would be ceremony.
    handler: async (args) => {
      const db = resolveDb(args);
      const fragments = await avFragments(db, (args.table as string) || DEFAULT_TABLE, args.section_id as number, {
        terms: args.terms as string,
        lang: args.lang as string | undefined,
        max_characters: (args.max_characters ?? DEFAULT_MAX_CHARACTERS) as number,
        max_occurrences: (args.max_occurrences ?? DEFAULT_MAX_OCCURRENCES) as number,
      });
      return textContent({ data: fragments });
    },
  },
  {
    name: 'get_av_indexation_fragment',
    description: 'Resolve an indexation locator (from thesaurus) to an audiovisual fragment. Returns video clip with timecodes, transcription, and associated thesaurus terms.',
    inputSchema: {
      db: dbParam,
      section_id: mcpBounded.section_id,
      section_tipo: z.string().optional().describe('Section type identifier'),
      component_tipo: z.string().optional().describe('Component type identifier'),
      tag_id: z.number().optional().describe('Tag ID from indexation'),
      tc_in: z.number().optional().describe('Timecode in (seconds)'),
      tc_out: z.number().optional().describe('Timecode out (seconds)'),
    },
    handler: async (args) => {
      const db = resolveDb(args);
      const result = await getAvIndexationFragment(db, {
        section_id: args.section_id as number,
        section_tipo: args.section_tipo as string | undefined,
        component_tipo: args.component_tipo as string | undefined,
        tag_id: args.tag_id as number | undefined,
        tc_in: args.tc_in as number | undefined,
        tc_out: args.tc_out as number | undefined,
      });
      return textContent({ data: result });
    },
  },
];

export const toolsByName = new Map(tools.map(t => [t.name, t]));

/**
 * The ONE way a tool is invoked — by the MCP transport (server.ts registers this) and
 * by the tests alike. It exists so a failing tool answers with an error *result* the
 * agent can read and act on, rather than a protocol-level exception.
 */
export async function handleToolCall(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const tool = toolsByName.get(name);
  if (!tool) {
    return errorContent(new Error(`Unknown tool: ${name}`));
  }

  try {
    return await tool.handler(parseToolArgs(tool, args));
  } catch (error) {
    return errorContent(error);
  }
}

/**
 * Parse a tool's arguments against ITS OWN declared shape, before the handler body runs.
 *
 * The MCP SDK validates the shape too, on the transport path — but only there. This
 * module also exposes `handleToolCall` as the ONE invocation path (server.ts and the tests
 * both go through it), and a bound that only holds when a particular transport is in front
 * of it is exactly the layering mistake PUB-06 was. Parsing here makes the schema
 * unbypassable: whatever calls a tool, an over-cap `limit` is refused before a query is
 * built, and a coercible value ("100") arrives at the handler as the number it means.
 *
 * Unknown keys are dropped rather than rejected — an agent that adds a stray argument
 * should get its answer, not a lecture; every argument a handler READS is declared here,
 * so nothing that matters is lost.
 */
function parseToolArgs(tool: ToolDefinition, args: Record<string, unknown>): Record<string, unknown> {
  const parsed = z.object(tool.inputSchema).safeParse(args ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map(issue => `${issue.path.join('.') || '(argument)'}: ${issue.message}`)
      .join('; ');
    throw new ValidationError(`Invalid arguments for ${tool.name} — ${detail}`);
  }
  return parsed.data as Record<string, unknown>;
}
