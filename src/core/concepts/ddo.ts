/**
 * DDO / DDO_MAP — the declarative resolution graph (spec §3.4).
 *
 * A ddo ("data-description object") describes how ONE component must be
 * resolved inside a response: which component (`tipo`), in which section
 * (`section_tipo`, where the literal string 'self' means "the current
 * section"), in which render `mode`, language, view, etc.
 *
 * A ddo_map is a FLAT ARRAY of ddos that encodes a TREE: each ddo's `parent`
 * holds the `tipo` of the ddo it hangs under, and the sentinel 'self' marks
 * direct children of the calling component/section. This is Dédalo's key
 * mechanism: a relation component carries, declaratively, the sub-components
 * to resolve in the RELATED section — to arbitrary depth — without any
 * per-relation code.
 *
 * PHP references:
 * - allowed client fields: class.request_config_object.php:683 (sanitize_client_ddo_map)
 * - tree walk: class.common.php:2295 (get_children_recursive) and :2454
 *   (`parent === $this->tipo` direct-children filter inside get_subdatum).
 *
 * SECURITY (spec §7.8): the schema below is ALSO the sanitization gate for
 * client-supplied ddo_maps. It is a strict field whitelist — `.strip()` (zod's
 * default for z.object) drops any key not listed, which is exactly the PHP
 * behavior of sanitize_client_ddo_map. Do NOT add server-only fields here.
 *
 * KEY WHITELIST vs VALUE TYPES (audit 2026-08 §7). PHP whitelists KEYS and
 * never types their values — only `limit`/`offset` are shape-checked
 * (class.request_config_object.php:723-729). TS additionally types every
 * value, which is a real improvement ONLY while each declared type is the type
 * the ontology actually authors: `rqoSchema` embeds this schema and server.ts
 * answers 400 "Invalid RQO" on a parse failure, so one wrong type does not
 * degrade a field — it kills every request carrying that ddo_map. `hover` was
 * typed `string` against 16 install-wide component_portal nodes (oh17 among
 * them) that author the BOOLEAN `true`. The types below are therefore derived
 * from the real dd_ontology corpus and RE-DERIVED mechanically on every run by
 * test/unit/ddo_schema_native.test.ts, which parses every ddo_map entry in
 * dd_ontology through this schema.
 */

import { z } from 'zod';
import {
	boundedIdentifier,
	boundedLabel,
	boundedLang,
	boundedShortName,
	SCALAR_BOUNDS,
} from './scalar_bounds.ts';

/** Sentinel meaning "the calling section/component" in section_tipo / parent. */
export const SELF_SENTINEL = 'self' as const;

/**
 * `limit` / `offset` — the ONLY two fields PHP shape-checks, and it DROPS the
 * key rather than rejecting the ddo: "pagination fields must be non-negative
 * integers (0 = all). Drop any other shape so a tampered value can't reach
 * pagination->limit" (class.request_config_object.php:723-729). They bound the
 * OUTPUT slice of an already permission-resolved component, so they are not a
 * permission boundary — but a negative or fractional value reaching
 * `pagination.limit` is nonsense the oracle never allowed through, and
 * docs/api/dd_object.md has always documented this exact rule.
 */
const paginationField = z.number().int().nonnegative().optional().catch(undefined);

/**
 * Client-allowed ddo fields — the display whitelist. Mirrors PHP
 * request_config_object::sanitize_client_ddo_map $allowed_fields.
 */
export const ddoSchema = z.object({
	/** Ontology typo discriminator, present in some ontology-authored ddos. */
	typo: boundedIdentifier().optional(),
	/** Component tipo to resolve (MANDATORY). */
	tipo: boundedIdentifier(),
	/** Target section tipo; 'self' = current section. Multi-target components
	 * (hierarchy_types portals) carry the full ARRAY of target tipos — the
	 * client echoes back the shape our own context responses ship. */
	section_tipo: z.union([boundedIdentifier(), z.array(boundedIdentifier())]).optional(),
	/** Explicit record id (rare; usually resolved at runtime). Ontology-authored
	 * tool/button ddos that name a section but NO record write an explicit null
	 * (rsc36/oh83 tool_transcription roles, numisdata672), and the client echoes
	 * it back — same client-null class as the SQO fields pinned by
	 * test/unit/sqo_client_nulls.test.ts. */
	section_id: z.union([z.number(), boundedIdentifier()]).nullable().optional(),
	/** Parent tipo in the ddo_map tree; 'self' = direct child of the caller. */
	parent: boundedIdentifier().optional(),
	/** Render mode: edit | list | search | ... */
	mode: boundedShortName().optional(),
	/** Language override ('lg-*'). */
	lang: boundedLang().optional(),
	/** Custom view name. The client sends null for columns with no explicit view
	 * (e.g. tool_time_machine's fixed_mode list columns), so null is accepted. */
	view: boundedShortName().nullable().optional(),
	/** UI label text. */
	label: boundedLabel().optional(),
	/** Glue for multi-value display, e.g. ' | '. */
	fields_separator: boundedLabel().optional(),
	/** Glue for record arrays, e.g. '<br>'. */
	records_separator: boundedLabel().optional(),
	/** Prepend the parent chain to the display value (thesaurus paths). */
	value_with_parents: z.boolean().optional(),
	/** Table column identifier (list mode). */
	column_id: boundedShortName().optional(),
	/** CSS width hint. */
	width: boundedShortName().optional(),
	/** Mosaic layout flag. */
	in_mosaic: z.boolean().optional(),
	/** Show this ddo's value as the row's TOOLTIP instead of a column (portal
	 * mosaic view). A FLAG, not text: every authoring node stores the boolean
	 * `true` and the client tests it strictly
	 * (`columns_map.filter(el => el.hover===true)`,
	 * client/dedalo/core/component_portal/js/view_mosaic_edit_portal.js:204). */
	hover: z.boolean().optional(),
	/** Pagination limit (0 = all). */
	limit: paginationField,
	/** Pagination offset. */
	offset: paginationField,
});

export type Ddo = z.infer<typeof ddoSchema>;

/**
 * A ddo_map: flat list, tree via `parent` links.
 *
 * PER-ENTRY, NOT ALL-OR-NOTHING (audit 2026-08 §7). PHP's sanitize_client_ddo_map
 * loops the map and `continue`s past an entry it cannot use, logging a WARNING —
 * it NEVER aborts the map, let alone the request. A plain `z.array(ddoSchema)`
 * does the opposite: one unusable entry fails the array, which fails `rqoSchema`,
 * which makes server.ts answer 400 for the whole RQO. The ontology itself
 * authors entries no ddo consumer can use — a bare `{}` (test188) and
 * tipo-less entries (numisdata1138/1139) — so the strict array turns authoring
 * noise into a dead screen.
 *
 * So: parse each entry, keep the ones that survive, and say out loud which ones
 * did not (the DEC-07 posture — narrow if you must, never in silence). A `tipo`
 * is still MANDATORY for an entry to survive: the whole resolution graph keys on
 * it (getDirectChildren/getDescendants), and PHP's own downstream
 * validate_requested_ddo resolves nothing for a tipo-less ddo anyway.
 *
 * This resilience is NOT a licence for type drift: it would have hidden the
 * `hover` mismatch. The mechanical guard against that is the ontology-wide
 * census in test/unit/ddo_schema_native.test.ts, which parses every authored
 * ddo through `ddoSchema` STRICTLY.
 */
/**
 * ONE ENTRY of a ddo_map: a real ddo, or a DESCRIPTION of why it could not be
 * used. Declared as a UNION rather than hidden behind `z.array(z.unknown())`
 * plus a transform, because a schema a caller can send bytes into must be
 * REACHABLE from the parse door's schema tree — that is what
 * `rqo_scalar_bound_tripwire` walks, and behind an opaque `z.unknown()` every
 * bound in `ddoSchema` could be deleted without a gate noticing.
 */
const ddoMapEntrySchema = z.union([ddoSchema, z.unknown().transform(describeUnusableEntry)]);

export const ddoMapSchema = z
	.array(ddoMapEntrySchema)
	.max(SCALAR_BOUNDS.ddoMapEntries)
	.transform(keepUsableDdoEntries);
export type DdoMap = z.infer<typeof ddoMapSchema>;

/** The marker an unusable entry carries out of the union branch. */
const UNUSABLE = Symbol.for('dedalo.ddo.unusable');

interface UnusableDdoEntry {
	[UNUSABLE]: true;
	tipo: unknown;
	why: string;
}

/** Second union branch: never fails, and says WHY the entry is unusable. */
function describeUnusableEntry(entry: unknown): UnusableDdoEntry {
	const parsed = ddoSchema.safeParse(entry);
	const why = parsed.success
		? 'unusable'
		: parsed.error.issues
				.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
				.join('; ');
	return { [UNUSABLE]: true, tipo: (entry as { tipo?: unknown } | null)?.tipo, why };
}

/**
 * Keep the entries that parsed, and SAY how many did not — with the saying
 * itself bounded (`SCALAR_BOUNDS.ddoMapWarnings`), because "one log line per bad
 * entry" is an amplifier a caller controls. The array's own `.max()` bounds the
 * work; this bounds the noise.
 */
function keepUsableDdoEntries(entries: readonly (Ddo | UnusableDdoEntry)[]): Ddo[] {
	const kept: Ddo[] = [];
	let dropped = 0;
	for (const entry of entries) {
		if ((entry as UnusableDdoEntry)[UNUSABLE] !== true) {
			kept.push(entry as Ddo);
			continue;
		}
		dropped += 1;
		if (dropped <= SCALAR_BOUNDS.ddoMapWarnings) {
			const unusable = entry as UnusableDdoEntry;
			console.warn(
				`[ddo] dropped unusable ddo_map entry (tipo ${JSON.stringify(unusable.tipo)}): ${unusable.why}`,
			);
		}
	}
	if (dropped > SCALAR_BOUNDS.ddoMapWarnings) {
		console.warn(
			`[ddo] dropped ${dropped} unusable ddo_map entries (${SCALAR_BOUNDS.ddoMapWarnings} shown)`,
		);
	}
	return kept;
}

/**
 * Sanitize a client-supplied ddo_map: whitelist fields (schema strips unknown
 * keys) and drop entries without a `tipo`. This is the §7.8 chokepoint.
 */
export function sanitizeClientDdoMap(untrustedDdoMap: unknown): DdoMap {
	const parsed = ddoMapSchema.safeParse(untrustedDdoMap);
	if (!parsed.success) {
		// Only a non-ARRAY reaches here (per-entry failures are dropped inside the
		// schema). Fail closed: resolve nothing rather than something unexpected.
		return [];
	}
	return parsed.data;
}

/**
 * Direct children of `parentTipo` in a ddo_map (the PHP :2454 filter).
 * `parentTipo` may be an actual tipo or the caller's tipo matching 'self'
 * entries already resolved upstream.
 */
export function getDirectChildren(ddoMap: readonly Ddo[], parentTipo: string): Ddo[] {
	return ddoMap.filter((ddo) => ddo.parent === parentTipo);
}

/**
 * All descendants of a ddo (children, grandchildren, …) preserving map order —
 * the PHP get_children_recursive closure (class.common.php:2295). Used when a
 * child component instance receives its NARROWED ddo_map (only its own
 * subtree) during subdatum resolution.
 */
export function getDescendants(ddoMap: readonly Ddo[], ofTipo: string): Ddo[] {
	const descendants: Ddo[] = [];
	for (const ddo of ddoMap) {
		if (ddo.parent === ofTipo) {
			descendants.push(ddo, ...getDescendants(ddoMap, ddo.tipo));
		}
	}
	return descendants;
}
