/**
 * SQO — Search Query Object (spec §3.3).
 *
 * The SQO is Dédalo's pure-data query abstraction (Mango/CouchDB-inspired)
 * over the PostgreSQL JSONB matrix tables. Clients and server code build SQOs;
 * the search engine compiles them to SQL in two phases:
 *   1. conform/parse — per-component builders turn each filter leaf into an
 *      SQL fragment + bound params (Phase 3 of the plan; lives in core/search/).
 *   2. SQL build     — FROM → SELECT → ORDER → WHERE → projects-filter, in
 *      that load-bearing order.
 *
 * PHP references: core/common/class.search_query_object.php (shape + sanitize
 * gate at :834), core/search/class.search.php (engine + conform_filter gate).
 *
 * SECURITY (spec §7.5): `sanitizeClientSqo` below is the API-boundary gate for
 * every untrusted SQO. It strips server-only keys recursively, clamps
 * limit/offset/total, and forces `parsed=false` so the component conform
 * pipeline can never be skipped. Identifier validation (tipos/langs/columns,
 * §7.6) happens later, at the single conform chokepoint in the search engine —
 * the two gates are deliberately separate layers.
 */

import { z } from 'zod';
import { config } from '../../config/config.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { specOf } from '../errors/registry.ts';
import type { ApiNotice } from '../errors/schema.ts';
import {
	boundedFreeText,
	boundedIdentifier,
	boundedLang,
	boundedShortName,
} from './scalar_bounds.ts';

/** Max rows an untrusted (client) SQO may request. PHP: DEDALO_SEARCH_CLIENT_MAX_LIMIT. */
export const CLIENT_MAX_LIMIT = config.features.searchClientMaxLimit;

/** Max filter_by_locators pins an untrusted SQO may carry (hardening, 2026-07-22). */
export const CLIENT_MAX_LOCATOR_PINS = 1000;

/**
 * Keys that only server code may set. Pre-built SQL would bypass the conform
 * pipeline; the ACL flags would bypass the projects filter. Mirrors PHP
 * search_query_object::sanitize_client_sqo $server_only_keys.
 */
export const SERVER_ONLY_SQO_KEYS: readonly string[] = [
	'sentence',
	'params',
	'column_sql',
	'table',
	'table_alias',
	'skip_projects_filter',
	'skip_duplicated',
	'include_negative',
];

/** One step of a filter path: which component of which section to match on. */
export const sqoPathStepSchema = z
	.object({
		section_tipo: boundedIdentifier().optional(),
		component_tipo: boundedIdentifier().optional(),
		name: boundedFreeText().optional(), // human label, ontology-authored; ignored by SQL build
		// ORDER paths only: name an exact DB column to sort by (id/section_id/…),
		// as an alternative to `component_tipo` (a component value). `component_tipo`
		// wins when both are present. Validated against VALID_DATA_COLUMNS at SQL
		// build (buildOrderClauses); NOT a server-only key, so it survives sanitize.
		column: boundedIdentifier().optional(),
	})
	.passthrough();
export type SqoPathStep = z.infer<typeof sqoPathStepSchema>;

/**
 * A filter LEAF: one comparison. `q` is the value; `path` locates the
 * component whose data is compared. The remaining fields tune how the
 * per-component builder generates SQL (operator, jsonpath format, language,
 * word-splitting, unaccent…).
 */
export const sqoFilterLeafSchema = z
	.object({
		q: z.unknown().optional(),
		// The REAL client sends explicit null for an unset operator (verified in
		// the browser E2E); accept + treat as absent (see conform.ts `?? null`).
		q_operator: boundedShortName().nullish(),
		path: z.array(sqoPathStepSchema).optional(),
		format: boundedShortName().optional(), // direct | array_elements | typeof | column | in_column | relation | function (deprecated)
		use_function: boundedIdentifier().optional(), // DEPRECATED (format:'function' only): legacy flat-variant name, e.g. relations_flat_fct_st_si — wire vocabulary, no DB function exists
		q_split: z.boolean().optional(),
		unaccent: z.boolean().optional(),
		type: boundedShortName().optional(), // jsonb | string
		lang: boundedLang().optional(),
	})
	.passthrough();
export type SqoFilterLeaf = z.infer<typeof sqoFilterLeafSchema>;

/**
 * A filter NODE: `$and` / `$or` over leaves and nested nodes, to any depth.
 * (Recursive type — zod needs the explicit lazy definition.)
 */
export type SqoFilterNode =
	| { $and: (SqoFilterNode | SqoFilterLeaf)[] }
	| { $or: (SqoFilterNode | SqoFilterLeaf)[] };

export const sqoFilterNodeSchema: z.ZodType<SqoFilterNode> = z.lazy(() =>
	z.union([
		z.object({ $and: z.array(z.union([sqoFilterNodeSchema, sqoFilterLeafSchema])) }),
		z.object({ $or: z.array(z.union([sqoFilterNodeSchema, sqoFilterLeafSchema])) }),
	]),
);

/** An order clause: direction + component path. */
export const sqoOrderSchema = z
	.object({
		direction: z.enum(['ASC', 'DESC']).optional(),
		path: z.array(sqoPathStepSchema).optional(),
	})
	.passthrough();

/** Locator-shaped record pin used by filter_by_locators. */
export const sqoLocatorPinSchema = z
	.object({
		section_tipo: boundedIdentifier(),
		section_id: z.union([z.number(), boundedIdentifier()]),
	})
	.passthrough();

/**
 * The SQO itself. `.passthrough()` keeps not-yet-modeled fields visible in
 * fixtures (helps Phase 3), but note sanitizeClientSqo strips the dangerous
 * ones explicitly and recursively.
 */
export const sqoSchema = z
	.object({
		/** Optional identifier, e.g. 'oh1_list'. */
		id: boundedIdentifier().nullish(),
		/** MANDATORY target section(s). Single string accepted, normalized to array. */
		section_tipo: z.union([boundedIdentifier(), z.array(boundedIdentifier())]),
		/** Which matrix table model to target: edit | list | tm | related. */
		mode: boundedShortName().nullish(),
		filter: sqoFilterNodeSchema.optional().nullable(),
		select: z.array(sqoPathStepSchema).nullish(),
		// The REAL client sends explicit nulls for unset limit/offset (verified in
		// the browser E2E); accept + treat as absent ('all' allowed server-side only).
		limit: z.union([z.number(), boundedShortName()]).nullish(),
		offset: z.number().nullish(),
		total: z.number().nullable().optional(),
		full_count: z.boolean().nullish(),
		order: z.union([z.array(sqoOrderSchema), z.literal(false)]).nullish(),
		// The REAL client sends explicit null when no locator pin is set (verified
		// in the browser E2E); accept + treat as absent (sql_assembler guards with
		// Array.isArray before use).
		filter_by_locators: z.array(sqoLocatorPinSchema).nullish(),
		filter_by_locators_op: z.enum(['OR', 'AND']).nullish(),
		allow_sub_select_by_id: z.boolean().nullish(),
		children_recursive: z.boolean().nullish(),
		remove_distinct: z.boolean().nullish(),
		breakdown: z.boolean().nullish(),
		/** Lifecycle flag: whether the conform pipeline has run. Forced false at the gate. */
		parsed: z.boolean().nullish(),
		/**
		 * A portal get_data's TEMPORARY display order (portal order model,
		 * WC-2026-10-31-portal-order-model): the column header click on a
		 * `sort_by_column` column. The server orders the portal's FULL locator
		 * list by this one column before paginating (relations/order_locators.ts
		 * assertViewOrder — the column gate: offered, and readable by the request
		 * principal, checked whatever the record holds); never written,
		 * `paginated_key` stays the stored index. Shape-validated HERE, at the
		 * wire, so a malformed one is refused before any door sees it; ignored by
		 * every non-portal read.
		 */
		view_order: z
			.object({
				tipo: boundedIdentifier(),
				// one wire spelling, the sqo `order` clause's (absent or null view_order = none)
				direction: z.enum(['ASC', 'DESC']),
			})
			.strict()
			.nullish(),
	})
	.passthrough();

export type Sqo = z.infer<typeof sqoSchema>;

/** A page value the client SENT (not undefined, not null). */
function isPresent(value: unknown): boolean {
	return value !== undefined && value !== null;
}

/** The section a log line names for an SQO (its first section_tipo). */
function sqoScopeLabel(sectionTipo: string | string[]): string {
	return Array.isArray(sectionTipo) ? (sectionTipo[0] ?? '?') : sectionTipo;
}

/**
 * The page window AS THE CLIENT SENT IT, kept on a wire-parsed SQO under a
 * NON-ENUMERABLE symbol (never serialized, never spread, invisible to
 * equality): the wire bounds the window (wireSqoSchema) before any door sees
 * it, and a door that owes a visible truncation (`search.page_clamped`) must
 * still be able to say what was asked. Read it through `requestedPage`.
 */
const WIRE_REQUESTED_PAGE: unique symbol = Symbol('dedalo.sqo.wire_requested_page');

/**
 * The client's page as sent: the wire-recorded original when the SQO came
 * through wireSqoSchema, else the SQO's own limit/offset (a server-built or
 * test-built RQO that never crossed the wire). Feeding it to clampClientPage
 * is idempotent with the wire clamp — the same raw values, the same clamp —
 * so the door's `bounded` verdict is true whichever side bounded first.
 */
export function requestedPage(sqo: unknown): { limit: unknown; offset: unknown } {
	if (sqo === null || typeof sqo !== 'object') return { limit: undefined, offset: undefined };
	const recorded = (sqo as { [WIRE_REQUESTED_PAGE]?: { limit: unknown; offset: unknown } })[
		WIRE_REQUESTED_PAGE
	];
	if (recorded !== undefined) return recorded;
	const own = sqo as { limit?: unknown; offset?: unknown };
	return { limit: own.limit, offset: own.offset };
}

/**
 * THE WIRE SQO (READ-4 Leg W): `sqoSchema` plus the ONE page bound, applied at
 * the parse door every HTTP body crosses (rqo.ts → server.ts), so a door that
 * forgets to clamp still receives a bounded window. A PRESENT limit comes out
 * an integer in [1, CLIENT_MAX_LIMIT] (clampClientLimit), a present offset an
 * integer in [0, MAX_SAFE_INTEGER] (clampClientOffset). `null` and absent are
 * KEPT as they arrived — `mergeSessionSqo` keys on own-property presence and
 * the read-mode defaults on "absent" — and no key is ever added. The output
 * type stays `Sqo`. Server-internal SQOs never pass here (they may use 'all').
 */
export const wireSqoSchema = sqoSchema.transform((sqo): Sqo => {
	const scope = sqoScopeLabel(sqo.section_tipo);
	const bounded: Sqo = { ...sqo };
	if (isPresent(sqo.limit)) bounded.limit = clampClientLimit(sqo.limit, scope);
	if (isPresent(sqo.offset)) bounded.offset = clampClientOffset(sqo.offset, scope);
	Object.defineProperty(bounded, WIRE_REQUESTED_PAGE, {
		value: { limit: sqo.limit, offset: sqo.offset },
		enumerable: false,
	});
	return bounded;
});

/**
 * Bounds on an untrusted client SQO's filter tree (L7): a pathologically nested
 * or huge $and/$or tree would otherwise drive unbudgeted recursion (stack /
 * SQL-assembler blowup) bounded only by the request body size. Generous ceilings
 * — real queries nest a handful of levels and carry far fewer nodes.
 */
const MAX_SQO_DEPTH = 64;
const MAX_SQO_NODES = 10_000;

/**
 * THE `referenced_by` NESTING BOUND (WC-2026-10-30-search-referenced-by-leaf):
 * how many `referenced_by` leaves may stand inside one another ("relationships
 * of relationships" opened from an already-opened window). A top-level leaf is
 * depth 1; depth MAX+1 is refused with `request.invalid_options`. Each level is
 * one more scoped row-set subquery, so the bound keeps the statement a size the
 * planner handles; MAX_SQO_DEPTH / MAX_SQO_NODES still bound the whole object.
 */
export const MAX_REFERENCED_BY_DEPTH = 4;

/**
 * THE `referenced_by` LEAF'S SOURCE SET — strict, no passthrough. The source is
 * the WHOLE found set of `section_tipo` under `filter` / `filter_by_locators`,
 * by definition: `limit`, `offset` and `order` (and every other SQO key) are
 * refused, never silently dropped. `from_component_tipo` optionally narrows
 * the indexed locators to the ones a given component of the source owns.
 * `filter_by_locators_op` accepts only 'OR' — the one shape the assembler
 * renders pins in (an 'AND' over distinct pins would be refused, not narrowed).
 */
export const referencedBySourceSchema = z
	.object({
		section_tipo: z.array(boundedIdentifier()).min(1),
		filter: sqoFilterNodeSchema.nullish(),
		filter_by_locators: z.array(sqoLocatorPinSchema).max(CLIENT_MAX_LOCATOR_PINS).nullish(),
		filter_by_locators_op: z.literal('OR').nullish(),
		from_component_tipo: boundedIdentifier().optional(),
	})
	.strict();
export type ReferencedBySource = z.infer<typeof referencedBySourceSchema>;

/** The leaf itself: exactly `{ referenced_by: <source> }` — no q, no path. */
const referencedByLeafSchema = z.object({ referenced_by: z.unknown() }).strict();

/** Does this filter item name a `referenced_by` leaf (whatever its validity)? */
export function isReferencedByLeaf(item: unknown): item is { referenced_by: unknown } {
	return (
		item !== null &&
		typeof item === 'object' &&
		!Array.isArray(item) &&
		Object.hasOwn(item, 'referenced_by')
	);
}

/** The refusal of a malformed leaf — loud, typed, never a silent widening. */
function invalidReferencedBy(reason: string): never {
	throw new DedaloError('request.invalid_options', {
		message: `sqo: invalid referenced_by leaf — ${reason}`,
		publicMessage: `Invalid referenced_by filter: ${reason}`,
	});
}

/** The first zod issue as a short, caller-safe sentence. */
function firstIssue(error: z.ZodError): string {
	const issue = error.issues[0];
	if (issue === undefined) return 'malformed';
	const where = issue.path.length > 0 ? issue.path.join('.') : 'source';
	return `${where}: ${issue.message}`.slice(0, 200);
}

/**
 * Parse ONE `referenced_by` leaf strictly → its source set. Throws
 * `request.invalid_options` on any deviation (extra keys beside
 * `referenced_by`, a missing/empty `section_tipo`, a limit/offset/order, an
 * unknown key). Does NOT recurse into the source filter (see
 * {@link assertReferencedByTree}).
 */
export function parseReferencedByLeaf(item: unknown): ReferencedBySource {
	const leaf = referencedByLeafSchema.safeParse(item);
	if (!leaf.success) invalidReferencedBy('the leaf holds only the referenced_by key');
	return parseReferencedBySource(leaf.data.referenced_by);
}

/** Parse a bare source set (the relation_targets door's input) strictly. */
export function parseReferencedBySource(raw: unknown): ReferencedBySource {
	// A found set that EXPANDS to recursive children (the search panel's
	// 'Children' checkbox) is not a source set this leaf can express: the scoped
	// row set has no descendant pre-pass. Named, never just "unknown key" — the
	// alternative (dropping the flag) would silently narrow the set to the
	// matched terms while the caller's list shows their descendants too.
	if (
		raw !== null &&
		typeof raw === 'object' &&
		((raw as Record<string, unknown>).children_recursive === true ||
			Object.hasOwn(raw, 'fixed_children_filter'))
	) {
		invalidReferencedBy(
			'a found set that includes recursive children (children_recursive) cannot be a relationships source',
		);
	}
	const source = referencedBySourceSchema.safeParse(raw);
	if (!source.success) invalidReferencedBy(firstIssue(source.error));
	return source.data;
}

/** The items of a filter array, or the children of a boolean node ([] for a leaf). */
function filterNodeChildren(node: object): unknown[] {
	if (Array.isArray(node)) return node;
	for (const key of ['$and', '$or', '$not', '$nand', '$nor']) {
		const items = (node as Record<string, unknown>)[key];
		if (Array.isArray(items)) return items;
	}
	return [];
}

/**
 * Validate every `referenced_by` leaf of a filter tree (strict schema) and the
 * NESTING BOUND: `depth` is the number of leaves already enclosing `filter`
 * (0 for a main SQO's filter). Throws `request.invalid_options`.
 */
export function assertReferencedByTree(filter: unknown, depth = 0): void {
	if (filter === null || typeof filter !== 'object') return;
	if (isReferencedByLeaf(filter)) {
		assertReferencedByLeafAt(filter, depth + 1);
		return;
	}
	for (const item of filterNodeChildren(filter)) assertReferencedByTree(item, depth);
}

/** One leaf at its nesting depth: the bound, the schema, then its own source filter. */
function assertReferencedByLeafAt(leaf: unknown, depth: number): void {
	if (depth > MAX_REFERENCED_BY_DEPTH) {
		invalidReferencedBy(`nested deeper than the maximum of ${MAX_REFERENCED_BY_DEPTH}`);
	}
	const source = parseReferencedByLeaf(leaf);
	assertReferencedByTree(source.filter, depth);
}

/**
 * THE relation_targets DOOR'S GATE for an untrusted source set: the same
 * server-only strip (recursive, ceilinged) as {@link sanitizeClientSqo}, then
 * the strict schema and the nesting bound over its filter (the source itself
 * counts as depth 1, exactly as when it rides a leaf).
 */
export function sanitizeClientReferencedBySource(untrusted: unknown): ReferencedBySource {
	const stripped = stripServerOnlyKeysRecursive(untrusted, 0, { nodes: 0 });
	const source = parseReferencedBySource(stripped);
	assertReferencedByTree(source.filter, 1);
	return source;
}

/**
 * Recursively delete server-only keys from a plain JSON value. Mirrors PHP
 * strip_keys_recursive: nested filter clauses may hide smuggled SQL. Also
 * enforces the depth/node ceilings (L7), throwing on an abusive tree — the
 * dispatch catch turns that into a fail-closed error, not a crash.
 */
function stripServerOnlyKeysRecursive(
	value: unknown,
	depth: number,
	counter: { nodes: number },
): unknown {
	if (depth > MAX_SQO_DEPTH) {
		throw new DedaloError('search.invalid_sqo', {
			message: `sqo: filter nesting exceeds the maximum depth (${MAX_SQO_DEPTH})`,
			publicMessage: `The search filter is nested deeper than the maximum of ${MAX_SQO_DEPTH}`,
		});
	}
	counter.nodes += 1;
	if (counter.nodes > MAX_SQO_NODES) {
		throw new DedaloError('search.invalid_sqo', {
			message: `sqo: filter exceeds the maximum node count (${MAX_SQO_NODES})`,
			publicMessage: `The search filter holds more than the maximum of ${MAX_SQO_NODES} nodes`,
		});
	}
	if (Array.isArray(value)) {
		return value.map((entry) => stripServerOnlyKeysRecursive(entry, depth + 1, counter));
	}
	if (value !== null && typeof value === 'object') {
		const cleaned: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			// Case-INSENSITIVE strip (INJ-03): the server-only keys are lowercase,
			// but a smuggled `TABLE`/`COLUMN_SQL` must not survive on the off chance
			// a future consumer reads a key case-insensitively. Inert today, cheap
			// defense-in-depth.
			if (SERVER_ONLY_SQO_KEYS.includes(key.toLowerCase())) {
				continue;
			}
			cleaned[key] = stripServerOnlyKeysRecursive(entry, depth + 1, counter);
		}
		return cleaned;
	}
	return value;
}

/**
 * THE client limit clamp (DEC-07, audit P2-31 / CLI-29 / CLI-30). Every limit an
 * untrusted client sends — an SQO `limit`, the tree children door's
 * `pagination.limit` — goes through here and comes out a positive integer no
 * larger than CLIENT_MAX_LIMIT:
 *
 * - 0, negative, 'all', non-numeric, > ceiling → CLIENT_MAX_LIMIT (an EXPLICIT
 *   ask beyond the ceiling gets a loud server-log line: the response is
 *   truncated and a completeness consumer must be able to see that);
 * - an absent limit (undefined/null) → CLIENT_MAX_LIMIT silently (the shape
 *   default; callers that want another default resolve it BEFORE calling).
 *
 * The client mirrors the bound (client/dedalo/core/common/js/sqo_limit.js reads
 * `page_globals.dedalo_search_client_max_limit`) so it never sends 0 at all;
 * this is the server's own refusal to treat 0 as "unbounded", whatever arrives.
 *
 * @param rawLimit the client value, any type
 * @param scope a label for the log line (the section_tipo, or the door)
 */
/** The client's raw limit as an integer: a number truncated, anything else parsed. */
function parsedClientLimit(rawLimit: unknown): number {
	return typeof rawLimit === 'number'
		? Math.trunc(rawLimit)
		: Number.parseInt(String(rawLimit ?? ''), 10);
}

export function clampClientLimit(rawLimit: unknown, scope: string): number {
	const limit = parsedClientLimit(rawLimit);
	if (Number.isFinite(limit) && limit > 0 && limit <= CLIENT_MAX_LIMIT) {
		return limit;
	}
	if (rawLimit !== undefined && rawLimit !== null) {
		console.warn(
			`[sqo] client limit ${JSON.stringify(rawLimit)} (section_tipo ${scope}) clamped to CLIENT_MAX_LIMIT=${CLIENT_MAX_LIMIT} — response may be truncated (DEC-07)`,
		);
	}
	return CLIENT_MAX_LIMIT;
}

/**
 * THE client offset clamp (READ-4) — the offset half of the ONE page bound.
 * Whatever arrives comes out an integer in [0, Number.MAX_SAFE_INTEGER]:
 *
 * - absent (undefined/null), NaN, non-numeric → 0 (page 1);
 * - a finite value → truncated, floored at 0 (INJ-06: a negative offset is
 *   meaningless and never reaches the assembler raw);
 * - a value past MAX_SAFE_INTEGER (`1e21`, `Infinity`) → MAX_SAFE_INTEGER, which
 *   is past the end of any table — an EMPTY page, never `OFFSET 1e+21` (a raw
 *   Postgres 500). Loud: the caller asked for something no page can name.
 */
export function clampClientOffset(rawOffset: unknown, scope: string): number {
	if (!isPresent(rawOffset)) return 0;
	const offset = Number(rawOffset);
	if (Number.isNaN(offset)) {
		console.warn(
			`[sqo] client offset ${JSON.stringify(rawOffset)} (section_tipo ${scope}) is not a number — served from 0`,
		);
		return 0;
	}
	if (offset > Number.MAX_SAFE_INTEGER) {
		console.warn(
			`[sqo] client offset ${String(rawOffset)} (section_tipo ${scope}) is past any page — clamped to MAX_SAFE_INTEGER (an empty page)`,
		);
		return Number.MAX_SAFE_INTEGER;
	}
	return Math.max(0, Math.trunc(offset));
}

/**
 * How a client page was bounded: `'requested'` — served as sent;
 * `'defaulted'` — the limit was absent and the door's default applied;
 * `'clamped'` — a value the client SENT (limit or offset) was changed.
 */
export type ClientPageBound = 'requested' | 'defaulted' | 'clamped';

/** A bounded client page — what a door hands the sink. */
export interface ClientPage {
	limit: number;
	offset: number;
	bounded: ClientPageBound;
}

/**
 * THE client page primitive (READ-4): every door that pages a CLIENT window
 * resolves it here, so no door can mean "all" by an absent limit or pass an
 * offset raw. The limit goes through clampClientLimit (still exactly one
 * clamp — an absent limit takes `doorDefault` first, itself clamped), the
 * offset through clampClientOffset.
 *
 * `bounded` tells the door whether it owes the caller a visible truncation
 * (`search.page_clamped`, pageClampedNotice): a door whose absent limit used
 * to mean "all" owes it for `'defaulted'` too.
 */
export function clampClientPage(
	rawLimit: unknown,
	rawOffset: unknown,
	scope: string,
	doorDefault: number = CLIENT_MAX_LIMIT,
): ClientPage {
	const limitSent = isPresent(rawLimit);
	const limit = clampClientLimit(limitSent ? rawLimit : doorDefault, scope);
	const offset = clampClientOffset(rawOffset, scope);
	const changed = sentAndChanged(rawLimit, limit) || sentAndChanged(rawOffset, offset);
	const bounded: ClientPageBound = changed ? 'clamped' : limitSent ? 'requested' : 'defaulted';
	return { limit, offset, bounded };
}

/**
 * The offset of the first row PAST a client page — what a door probes to learn
 * whether its default cut something — or `null` when that offset lies past
 * MAX_SAFE_INTEGER: no row can exist there (and the sink refuses an unnameable
 * window), so "nothing past" is the answer without a probe. clampClientOffset
 * passes offsets up to MAX_SAFE_INTEGER through, so `offset + limit` CAN
 * overflow on a page the clamp itself produced.
 */
export function offsetPastPage(page: ClientPage): number | null {
	const past = page.offset + page.limit;
	return past > Number.MAX_SAFE_INTEGER ? null : past;
}

/** A value the client sent that the clamp did not serve as sent. */
function sentAndChanged(raw: unknown, applied: number): boolean {
	return isPresent(raw) && Number(raw) !== applied;
}

/** A raw page value as the notice names it (`absent` for undefined/null). */
function pageValueLabel(value: unknown): string {
	if (!isPresent(value)) return 'absent';
	return typeof value === 'string' ? value.slice(0, 32) : String(value);
}

/**
 * The `search.page_clamped` notice for a page that was not served as sent —
 * a NON-FATAL coded fact on an ok envelope (ERRORS_SPEC §3): the answer is one
 * bounded page, so a consumer that wants the rest pages through it. Details:
 * `door` (which door bounded it), `requested` (`limit L, offset O` as sent),
 * `applied` (the window served).
 */
export function pageClampedNotice(
	door: string,
	rawLimit: unknown,
	rawOffset: unknown,
	page: ClientPage,
): ApiNotice {
	const spec = specOf('search.page_clamped');
	return {
		code: 'search.page_clamped',
		label_key: spec.label_key,
		retryable: spec.retryable,
		details: {
			door,
			requested: `limit ${pageValueLabel(rawLimit)}, offset ${pageValueLabel(rawOffset)}`,
			applied: `limit ${page.limit}, offset ${page.offset}`,
		},
	};
}

/**
 * §7.5 SECURITY GATE — scrub an untrusted client SQO before it may enter the
 * search pipeline. PHP: search_query_object::sanitize_client_sqo (:834).
 *
 * - strips SQL fragments and ACL flags, recursively
 * - clamps limit to CLIENT_MAX_LIMIT ('all'/non-positive/out-of-range → ceiling)
 * - coerces offset/total to integers
 * - forces parsed=false so component conform can never be skipped
 *
 * Server-internal code builds SQOs directly and does NOT pass through here
 * (it may legitimately use limit 'all' or skip_projects_filter).
 */
export function sanitizeClientSqo(untrustedSqo: Record<string, unknown>): Sqo {
	const stripped = stripServerOnlyKeysRecursive(untrustedSqo, 0, { nodes: 0 }) as Record<
		string,
		unknown
	>;

	// limit: clamp to the client ceiling (the ONE clamp — the tree children door
	// applies the same function to its pagination.limit, ts_api.ts).
	stripped.limit = clampClientLimit(
		stripped.limit,
		typeof stripped.section_tipo === 'string' ? stripped.section_tipo : '?',
	);

	// offset: the ONE offset clamp (READ-4) — integer in [0, MAX_SAFE_INTEGER];
	// a negative offset (INJ-06) is 0, one past any page (1e21) an empty page,
	// never a raw `OFFSET 1e+21` reaching the assembler.
	stripped.offset = clampClientOffset(
		stripped.offset,
		typeof stripped.section_tipo === 'string' ? stripped.section_tipo : '?',
	);
	// total: integer coercion.
	if (stripped.total !== undefined && stripped.total !== null) {
		stripped.total = Math.trunc(Number(stripped.total)) || 0;
	}

	// filter_by_locators: HARDENING cap (2026-07-22, semantic-search pins). The
	// node-count ceiling already bounds pins at ≈3.3k (each pin ≈ 3 counted
	// nodes); this explicit clamp keeps the OR-legs and the locator_position
	// ranking array a size the planner handles comfortably. Clamp, not reject —
	// but LOUDLY (DEC-07 precedent above): a silently truncated pin set silently
	// drops result rows.
	if (Array.isArray(stripped.filter_by_locators)) {
		const pins = stripped.filter_by_locators as unknown[];
		if (pins.length > CLIENT_MAX_LOCATOR_PINS) {
			const sectionTipo = typeof stripped.section_tipo === 'string' ? stripped.section_tipo : '?';
			console.warn(
				`[sqo] client filter_by_locators length ${pins.length} (section_tipo ${sectionTipo}) clamped to CLIENT_MAX_LOCATOR_PINS=${CLIENT_MAX_LOCATOR_PINS} — result set truncated (DEC-07)`,
			);
			stripped.filter_by_locators = pins.slice(0, CLIENT_MAX_LOCATOR_PINS);
		}
	}

	// referenced_by leaves: strict shape + nesting bound, refused here at the
	// client gate (server-only keys inside a nested source were already
	// stripped above — the strip is recursive over the whole object). The
	// conform stage re-asserts both for server-built SQOs.
	assertReferencedByTree(stripped.filter);

	// lifecycle: force re-parse
	stripped.parsed = false;

	return sqoSchema.parse(stripped);
}

/**
 * Session-SQO navigation merge (PHP dd_core_api :2159-2199, "received case").
 * Fills each navigation property the client did NOT send from the session's
 * stored SQO for the section. This is the read-back half of the session
 * navigation contract (readSectionRows persists, section context echoes as
 * `sqo_session`): it is how a secondary window opened plain (page/?tipo=X)
 * inherits the filter a dummy build stored (client open_records_in_window),
 * and how tools re-enter the user's navigation.
 *
 * PHP semantics mirrored exactly: `!property_exists(client)` — an explicit
 * null FROM THE CLIENT keeps the property and blocks the merge (that is why a
 * first-load `limit: null` still resolves the config default, not the stored
 * one) — and `isset(session)` — a null IN THE SESSION is skipped. Values are
 * deep-cloned so the caller can never mutate the session store through the
 * merged SQO. Mutates and returns `clientSqo`.
 */
const SESSION_SQO_MERGE_KEYS = [
	'filter',
	'order',
	'limit',
	'offset',
	'filter_by_locators',
	'children_recursive',
] as const;

export function mergeSessionSqo(
	clientSqo: Record<string, unknown>,
	storedSqo: unknown,
): Record<string, unknown> {
	if (storedSqo === null || typeof storedSqo !== 'object' || Array.isArray(storedSqo)) {
		return clientSqo;
	}
	const stored = storedSqo as Record<string, unknown>;
	for (const key of SESSION_SQO_MERGE_KEYS) {
		if (!Object.hasOwn(clientSqo, key) && stored[key] !== undefined && stored[key] !== null) {
			clientSqo[key] = structuredClone(stored[key]);
		}
	}
	return clientSqo;
}

/** Normalize section_tipo to the array form the engine works with. */
export function getSectionTipos(sqo: Sqo): string[] {
	return Array.isArray(sqo.section_tipo) ? sqo.section_tipo : [sqo.section_tipo];
}
