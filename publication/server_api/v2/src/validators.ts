/**
 * The input contract: every value a client can send, and the only place it is decided
 * whether that value is acceptable.
 *
 * These schemas are the API's outer boundary. A route hands raw query params straight to
 * one of them and works with the parsed result afterwards, so anything a handler receives
 * has already been coerced to its real type and bounded. A ZodError thrown from here is
 * turned into a 400 problem+json with a per-field `errors` array by the error handler —
 * which is why no validator needs to build an error response itself.
 *
 * What is NOT decided here: SQL-identifier safety. `column`, `fields` and `sort` are plain
 * strings at this layer, and are checked against the identifier grammar (and against the
 * table's real columns) at the SQL boundary in db/query-builder.ts. That is deliberate —
 * identifier validation belongs at the one chokepoint that interpolates, not scattered
 * across every schema that happens to accept a column name.
 *
 * Bounds imported from constants.ts rather than written inline, so the documented limit and
 * the enforced limit are the same number.
 */

import { z } from 'zod';
import { DEFAULT_LIMIT, DEFAULT_OFFSET, MAX_LIMIT, DEFAULT_MAX_CHARACTERS, DEFAULT_MAX_OCCURRENCES, MAX_BATCH_QUERIES, DEFAULT_COLUMN } from './constants';

// A query string has no booleans — everything arrives as text — so the usual spellings are
// mapped by hand. Note that an empty value counts as FALSE, so a bare `?count` (which
// URLSearchParams reads as '') switches counting OFF, not on; it must be `?count=true`.
// Anything unrecognised falls through untouched and is rejected by z.boolean().
const queryBoolean = z.preprocess((val) => {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') {
    const lower = val.toLowerCase();
    if (lower === 'true' || lower === '1') return true;
    if (lower === 'false' || lower === '0' || val === '') return false;
  }
  return val;
}, z.boolean());

// Dédalo's own language codes (lg-eng, lg-spa) — not BCP-47, and not interchangeable with
// it. `lang` selects one row of the composite (section_id, lang) primary key, so a
// malformed code must fail loudly rather than quietly matching nothing.
const langSchema = z.string().regex(/^lg-[a-z]{2,5}$/, 'Expected lg-xx format');

/**
 * THE BOUNDED PARAMETERS — one object per client-supplied number or string that carries a
 * DoS bound, exported so that EVERY entry layer parses the SAME schema object.
 *
 * This is the fix for the shape of defect PUB-06: the caps used to live only in the
 * route-level schemas below, and mcp/tools.ts declared its own `z.number()` for the same
 * parameter — so the MCP door, which is enabled and unauthenticated by default, handed a
 * raw `limit` to SQL. A cap that one door can decline to import is not a bound.
 *
 * Identity, not spelling, is the contract: mcp/tools.ts imports these very objects (the
 * `.optional()`/`.describe()` wrappers below are built here too, so the tool shapes ARE
 * these objects), and the gate asserts object identity as well as behaviour. A second
 * copy of the same numbers elsewhere would satisfy a grep and defeat the invariant.
 *
 * Refusal, not clamping, is the answer at this layer — see the note on MAX_LIMIT in
 * constants.ts. The service layer clamps as well (db/query-builder.ts), so a caller that
 * never passes through a schema still cannot exceed the bound; refuse is the contract,
 * clamp is the floor beneath it.
 */

// limit=0 is allowed: count-only requests skip the data query
export const boundedLimit = z.coerce.number().int().min(0).max(MAX_LIMIT);
export const boundedOffset = z.coerce.number().int().min(0);
// A section_id is a positive integer key, never a float and never negative.
export const boundedSectionId = z.coerce.number().int().positive();
// The excerpt bounds: each term becomes a regex scan and each occurrence copies a window
// of text out of it, so the two multiply into response size and CPU.
export const boundedMaxCharacters = z.coerce.number().int().min(10).max(5000);
export const boundedMaxOccurrences = z.coerce.number().int().min(1).max(10);
// Free-text inputs: capped in LENGTH here, split into at most MAX_FRAGMENT_TERMS words
// downstream (utils/fragments.ts).
export const boundedQuery = z.string().min(1, 'q is required').max(512);
export const boundedTerms = z.string().min(1, 'terms is required').max(512);

const limitSchema = boundedLimit.default(DEFAULT_LIMIT);
const offsetSchema = boundedOffset.default(DEFAULT_OFFSET);

/**
 * The MCP shapes of the same objects. `registerTool` takes a raw shape of optional
 * validators rather than a z.object with defaults, so the optional/described wrappers are
 * built HERE, from the bounded schemas above, instead of being re-declared in the tool
 * module. `describe()` text is the only documentation an agent gets, so the cap is stated
 * in it: the JSON Schema advertised over MCP now carries the maximum as well.
 */
export const mcpBounded = {
  limit: boundedLimit.optional().describe(`Maximum number of results (default: ${DEFAULT_LIMIT}, max: ${MAX_LIMIT}; a larger value is refused)`),
  offset: boundedOffset.optional().describe('Number of results to skip (default: 0)'),
  section_id: boundedSectionId.describe('Record section_id (a positive integer)'),
  max_characters: boundedMaxCharacters.optional().describe(`Maximum characters per fragment (default: ${DEFAULT_MAX_CHARACTERS}, 10-5000)`),
  max_occurrences: boundedMaxOccurrences.optional().describe(`Maximum fragments per term (default: ${DEFAULT_MAX_OCCURRENCES}, 1-10)`),
  q: boundedQuery.describe('Search query (max 512 characters). Supports boolean operators (+, -, "", etc.)'),
  terms: boundedTerms.describe('Search terms to find in the text (max 512 characters)'),
} as const;

/**
 * The census the gate walks: every bounded parameter NAME, and the schema object that any
 * entry layer accepting it must parse. Exported as data so the gate can enumerate the
 * bounds from the code rather than from a hand-written list that could fall behind.
 */
export const BOUNDED_PARAMETERS = {
  limit: boundedLimit,
  offset: boundedOffset,
  section_id: boundedSectionId,
  max_characters: boundedMaxCharacters,
  max_occurrences: boundedMaxOccurrences,
  q: boundedQuery,
  terms: boundedTerms,
} as const;

export type BoundedParameterName = keyof typeof BOUNDED_PARAMETERS;

/**
 * The BACKSTOP under the schemas: the page bounds applied again, at the SQL boundary, by
 * code that no caller reaches around. The schemas above refuse (that is the contract a
 * client codes against); these clamp, so that a caller which never passed a schema — a new
 * service, an internal call, a future door — still cannot ask the database for an unbounded
 * page. Belt and braces, deliberately: the audit's finding was not "the number is wrong",
 * it was "the number lives at a layer a door can skip".
 */
export function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 0), MAX_LIMIT);
}

export function clampOffset(offset: number): number {
  if (!Number.isFinite(offset)) return DEFAULT_OFFSET;
  return Math.max(Math.trunc(offset), 0);
}

// Left as raw strings on purpose: both carry a JSON object ({"image":"image"}), whose shape
// is parsed and validated in services/resolve.service.ts, together with the recursion and
// fan-out bounds that only that layer can enforce.
const resolveParams = {
  resolve_relations: z.string().optional(),
  resolve_inverse_relations: z.string().optional(),
};

export const listRecordsQuerySchema = z.object({
  fields: z.string().optional(),
  sort: z.string().optional(),
  limit: limitSchema,
  offset: offsetSchema,
  lang: langSchema.optional(),
  count: queryBoolean.default(false),
  ...resolveParams,
});

export const getRecordQuerySchema = z.object({
  fields: z.string().optional(),
  lang: langSchema.optional(),
  ...resolveParams,
});

export const fulltextQuerySchema = z.object({
  q: boundedQuery,
  column: z.string().default(DEFAULT_COLUMN),
  lang: langSchema.optional(),
  limit: limitSchema,
  offset: offsetSchema,
  count: queryBoolean.default(false),
  ...resolveParams,
});

// The excerpt bounds (max_characters, max_occurrences) are capped as well as floored: each
// term becomes a regex scan and each occurrence copies a window of text out of it, so the
// two multiply into the response size and the CPU cost of one request. The term string is
// capped at 512 chars here and split into at most MAX_FRAGMENT_TERMS words downstream.
export const fragmentsQuerySchema = z.object({
  terms: boundedTerms,
  column: z.string().default(DEFAULT_COLUMN),
  lang: langSchema.optional(),
  max_characters: boundedMaxCharacters.default(DEFAULT_MAX_CHARACTERS),
  max_occurrences: boundedMaxOccurrences.default(DEFAULT_MAX_OCCURRENCES),
});

export const avFragmentsQuerySchema = z.object({
  terms: boundedTerms,
  lang: langSchema.optional(),
  max_characters: boundedMaxCharacters.default(DEFAULT_MAX_CHARACTERS),
  max_occurrences: boundedMaxOccurrences.default(DEFAULT_MAX_OCCURRENCES),
});

// A section_id from the path. Coerced because a path segment is text, and constrained to a
// positive integer so a non-numeric id is a 400 at the boundary rather than a value handed
// to the query layer.
export const recordIdSchema = boundedSectionId;

export type ListRecordsQuery = z.infer<typeof listRecordsQuerySchema>;
export type GetRecordQuery = z.infer<typeof getRecordQuerySchema>;
export type FulltextQuery = z.infer<typeof fulltextQuerySchema>;
export type FragmentsQuery = z.infer<typeof fragmentsQuerySchema>;
export type AvFragmentsQuery = z.infer<typeof avFragmentsQuerySchema>;

// tc_in/tc_out are media timecodes in SECONDS, so unlike every other numeric param here they
// are deliberately not .int() — a timecode is fractional ([tc-12.5-30.0], see
// TC_TAG_PATTERN). They are non-negative, since they index into a media file from its start.
export const avIndexationParamsSchema = z.object({
  section_id: boundedSectionId,
  section_tipo: z.string().optional(),
  component_tipo: z.string().optional(),
  tag_id: z.coerce.number().int().optional(),
  tc_in: z.coerce.number().min(0).optional(),
  tc_out: z.coerce.number().min(0).optional(),
});

export type AvIndexationParams = z.infer<typeof avIndexationParamsSchema>;

/**
 * One sub-query of a /batch envelope.
 *
 * `id` is the caller's own correlation handle: the response is an unordered array of results
 * carrying these ids back, which is how a client tells which answer belongs to which
 * question. `path` must be root-relative — it is re-entered against the internal routing
 * table (router.ts dispatch), not fetched — and services/batch.service.ts additionally
 * refuses a path with a query string (params go in `params`) and any non-data endpoint.
 *
 * `params` is restricted to scalars and arrays of scalars because it is rendered into a
 * query string: an array becomes a repeated key, and there is no encoding a nested object
 * could be given that the route schemas above would understand.
 */
const batchQuerySchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1).startsWith('/', 'path must start with "/"'),
  params: z.record(z.string(), z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.union([z.string(), z.number(), z.boolean()])),
  ])).optional(),
});

// Ids must be unique or the response is ambiguous — a client keying results by id would
// silently lose one. Rejecting the envelope is the only honest answer, so this is a refine
// on the whole batch rather than a per-query check. The size cap is what bounds the fan-out
// a single request can commission (see MAX_BATCH_QUERIES).
export const batchRequestSchema = z.object({
  queries: z.array(batchQuerySchema).min(1).max(MAX_BATCH_QUERIES),
}).refine(
  (data) => {
    const ids = data.queries.map(q => q.id);
    return new Set(ids).size === ids.length;
  },
  { message: 'Batch query IDs must be unique' },
);

export type BatchRequest = z.infer<typeof batchRequestSchema>;
export type BatchQuery = z.infer<typeof batchQuerySchema>;
