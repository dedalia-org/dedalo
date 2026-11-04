/**
 * RQO — Request Query Object (spec §3.2). The API request contract.
 *
 * Every client call to the Dédalo API is an RQO: which api class (`dd_api`)
 * and `action` to run, on which target (`source`), optionally with a search
 * (`sqo`) and with `show` / `search` / `choose` blocks whose ddo_maps say
 * which components to resolve and how deep (via ddo `parent` chaining — the
 * heart of the RQO, spec §3.4).
 *
 * PHP references:
 * - canonical keys: class.request_query_object.php:360 ($direct_keys)
 * - entry/dispatch:  core/api/v1/json/index.php → dd_manager::sanitize_client_rqo
 *                    → dd_manager::manage_request → <dd_api>::<action>($rqo)
 *
 * WIRE-CONTRACT NOTE: the user has authorized modernizing the wire contract
 * (the client call layer adapts at the seam). We keep the RQO's conceptual
 * shape and field names — they are the shared vocabulary with the ontology and
 * the copied client — and reserve renames/restructures for deliberate,
 * documented seam decisions, not incidental drift.
 */

import { z } from 'zod';
import { ddoMapSchema } from './ddo.ts';
import {
	boundedIdentifier,
	boundedLabel,
	boundedLang,
	boundedOptionsBag,
	boundedShortName,
} from './scalar_bounds.ts';
import { wireSqoSchema } from './sqo.ts';

/**
 * The request target: what model/record/mode the action operates on.
 * PHP: rqo->source built client-side, validated server-side per action.
 */
export const rqoSourceSchema = z
	.object({
		/** Model name, e.g. 'section', 'component_input_text'. The real client
		 * sends explicit null on some save paths (component_text_area
		 * add_component_history_note builds its Code-save source with
		 * model:null); the server resolves the model from `tipo` (PHP parity —
		 * dd_core_api resolves via get_model_by_tipo when absent). */
		model: boundedIdentifier().nullish(),
		/** Ontology tipo of the element to resolve. */
		tipo: boundedIdentifier().optional(),
		/** Section the element lives in. */
		section_tipo: boundedIdentifier().optional(),
		/** Record id (string or number in the wild). */
		section_id: z.union([z.number(), boundedIdentifier()]).nullable().optional(),
		/** Render mode: edit | list | search | tm | ... */
		mode: boundedShortName().optional(),
		/** Request language ('lg-*'). */
		lang: boundedLang().optional(),
		/** Sub-action discriminator used by some api methods (e.g. read → 'search').
		 * The real client sends explicit null when unset (browser E2E). */
		action: boundedIdentifier().nullish(),
		/** Custom view name. */
		view: boundedShortName().nullable().optional(),
		/**
		 * Element properties OVERRIDE (PHP dd_core_api read :2305-2308,
		 * `$element->set_properties($properties)`): the client ships the
		 * instance's declared properties with its reads (common.js
		 * create_source — TOOL components carry their ddo_map entry's
		 * properties this way) and the server must build config/data from
		 * THEM, not the ontology node (epigraphy coins portal: the override's
		 * sqo_config.limit 1 beats the ontology's 9). Nullish-tolerant like PHP
		 * (`?? null`) — an explicit null is NOT an override.
		 */
		properties: z.record(boundedIdentifier(), z.unknown()).nullish(),
		/**
		 * Time Machine read overrides (PHP dd_core_api :2372-2383,
		 * `$element->matrix_id` / `$element->data_source`): when `data_source` is
		 * 'tm' the component loads its value from the `matrix_time_machine` row
		 * identified by `matrix_id` instead of the live record — the
		 * tool_time_machine preview pane. Both must be present to take effect.
		 */
		matrix_id: z.union([z.number(), boundedIdentifier()]).nullish(),
		data_source: boundedShortName().nullish(),
		/**
		 * TEMPORAL instance (WC-059): a tool's throwaway editable clone — the
		 * propagate tool's value widget, service_tmp_section's staging form, the
		 * component_text_area draw/reference pickers. It ADDRESSES NO RECORD: the
		 * `section_id` it carries is a client-side sentinel (1), never an address.
		 * The save door routes it to `resolveTemporalSave` (resolve + echo, no
		 * write) and the read door resolves context with an empty value — unless the
		 * source ALSO carries `temporal_scope` (WC-079), which grafts the caller's
		 * own scratch row instead. The record-lifecycle doors refuse it either way.
		 * See core/section/record/temporal.ts.
		 *
		 * Declared — not left to `.passthrough()` — because that is exactly how it
		 * went unread for a whole engine generation while the client kept sending
		 * it, and `section_id: 1` landed on real records.
		 */
		is_temporal: z.boolean().nullish(),
		/**
		 * TEMPORAL SCRATCH scope (WC-079): names the OWNING TOOL of a temporal
		 * instance whose values must survive a reload, and is therefore also the
		 * lifetime holder — the tool that clears them once they are consumed.
		 *
		 * SEPARATE from `is_temporal` on purpose. That flag answers "does this
		 * address a record?"; this one answers "should this persist?". They are
		 * different questions with very different blast radii: of the five temporal
		 * producers only service_tmp_section wants persistence, and the other four
		 * would be CORRUPTED or pointlessly served by it —
		 * tool_propagate_component_data seeds its clone from the open record and then
		 * bulk-writes across a search result set; the component_text_area draw and
		 * reference pickers are transient, so a restored value is a stale locator
		 * stamped into a tag; and view_graph_solved_section builds its instance for
		 * the CONTEXT only and never saves. Conflating the two flags is how one
		 * producer's need becomes five producers' bug.
		 *
		 * A plain string, validated at the accessor (temporal_store.ts
		 * temporalScratchAddress) rather than as a z.enum: a stale client sending an
		 * unknown scope must degrade to today's no-persistence behaviour, not 400
		 * every save in the form.
		 */
		temporal_scope: z.string().max(64).nullish(),
		/**
		 * DATAFRAME PAIRING context (PHP source.caller_dataframe): which item of
		 * which main component the frame instance extends. The client sends it on
		 * EVERY component_dataframe request — read and save alike (common.js
		 * create_source :1184-94) — sourcing `id_key` from the last read echo.
		 *
		 * Declared rather than left to `.passthrough()` for the reason the
		 * `is_temporal` note above spells out: it rode through undeclared, only
		 * the SAVE door ever cast it out of the bag, and the READ door silently
		 * ignored it — so get_data served every frame in the slot regardless of
		 * which main item was open, and handed the client back an item with no
		 * `id_key` to echo. Nullish-tolerant: a caller without a pairing (search
		 * mode, maintenance) is legitimate and degrades to the unpaired read.
		 */
		caller_dataframe: z
			.object({
				main_component_tipo: boundedIdentifier().nullish(),
				section_tipo: boundedIdentifier().nullish(),
				section_id: z.union([z.number(), boundedIdentifier()]).nullish(),
				id_key: z.union([z.number(), boundedIdentifier()]).nullish(),
			})
			.passthrough()
			.nullish(),
		/**
		 * TIME MACHINE SURFACE (WC-2026-08-14-tm-scope-server-owned): WHICH dd15
		 * block the caller is rendering — the inspector's record-history panel, its
		 * component-history panel, or (unset) the full-width tool list.
		 *
		 * It names a SURFACE, never a column set: the server maps the name onto
		 * columns, and an unrecognised value falls back to the SQO-derived scope
		 * rather than 400-ing. So this cannot be used to widen a list, to reach
		 * another section's history, or to add a column — the properties that made
		 * the old client-built ddo_map not a permission boundary at all.
		 *
		 * Declared rather than left to `.passthrough()` for the same reason the two
		 * notes above give: a key that rides through undeclared is a key no door
		 * agrees about.
		 */
		tm_surface: z.string().max(64).nullish(),
		/**
		 * THE CALLER CHAIN of a nested element's own read (nested-ddo_map plan
		 * W4, 2026-11-03): the element's caller instances, outermost first, each
		 * `{tipo, section_tipo}` (+ `mode` on the first) — e.g. a page-2 get_data
		 * of tch197's rsc1400 cell names `[{tipo:'tch197', section_tipo:'tch1',
		 * mode:'edit'}]`. A CLAIM, never trusted: relations/caller_chain.ts
		 * re-derives every link from the ontology and the actor's grant on the
		 * outermost element, and a refused chain is simply ignored (the read
		 * resolves the element as a top-level read). NOT validated here, on
		 * purpose — the verifier owns the shape (an array of 1..MAX_DDO_DEPTH
		 * links, checked by length BEFORE any link is walked, so it cannot be an
		 * amplifier), and EVERY malformed chain — a non-array, an over-long list
		 * included — degrades to "no chain" instead of 400-ing the read
		 * (WC-2026-11-04-rqo-source-callers).
		 */
		callers: z.unknown().optional(),
		/**
		 * BUILD OPTIONS (PHP `$this->build_options`, set from `source.build_options`
		 * by the component json controllers) — per-request switches on HOW an
		 * element is built, never WHAT it addresses.
		 *
		 * - `get_data_external` — the portal's "update external data" button
		 *   (component_portal buttons.js): recompute the requested component's
		 *   external mirror (properties.source.mode 'external') BEFORE it is read.
		 *   Honoured by ONE reader, section/record/external_refresh.ts
		 *   maybeRefreshExternal, for a top-level component get_data only. STRICT
		 *   `=== true`. The v6 spelling `get_dato_external` is NOT honoured: it is
		 *   counted (`rqo_deprecated_get_dato_external`) and ignored — it rides the
		 *   passthrough below, undeclared on purpose so no door can read it.
		 * - `terms_are_model` — the area_thesaurus / area_ontology model view
		 *   (area/read.ts, area/tree.ts).
		 *
		 * Declared rather than left to `.passthrough()` for the reason the notes
		 * above give: a key that rides through undeclared is a key no door agrees
		 * about. Passthrough INSIDE, so a stale client's unknown option degrades to
		 * "ignored" rather than a 400 on every read.
		 */
		build_options: z
			.object({
				get_data_external: z.boolean().nullish(),
				terms_are_model: z.boolean().nullish(),
			})
			.passthrough()
			.nullish(),
	})
	.passthrough();
export type RqoSource = z.infer<typeof rqoSourceSchema>;

/**
 * THE single reader of `source.caller_dataframe` (mirrors
 * `isTemporalSource` below): returns the pairing ONLY when it is complete
 * enough to scope a read or a write — a main component AND an item id.
 *
 * Everything else is a caller WITHOUT a pairing, which is legitimate (search
 * mode, the maintenance widgets) and must degrade to the unpaired path rather
 * than throw or, worse, pair against a partial context.
 */
export function callerDataframePairing(
	source: RqoSource | undefined,
): { main_component_tipo: string; id_key: number } | null {
	return dataframePairingOf(source?.caller_dataframe);
}

/**
 * THE pairing validity rule, shared by every door (read, save, merge).
 *
 * It exists as one function because it started as three: the read accepted any
 * finite id_key, the save demanded >= 1, and the merge accepted anything
 * non-null. That disagreement was a hole, not a nuance — `id_key: 0` or a
 * null `main_component_tipo` (which the client sends as
 * `self.caller?.tipo || null` whenever the caller instance is not threaded)
 * passed one gate and failed another, so a frame could be written through the
 * UNPAIRED path and land in exactly the unreadable shape this whole change set
 * exists to prevent.
 *
 * Item ids are 1-based and server-minted, so a valid pairing is an integer
 * >= 1 plus a non-empty main component tipo. `id_key` is returned as a NUMBER:
 * every consumer wants it numeric, and normalizing here means no caller has to
 * remember to (a string "abc" used to reach Math.trunc(Number(...)) and write
 * NaN, which the jsonb encoder then threw on, aborting the transaction).
 */
export function dataframePairingOf(
	caller: { main_component_tipo?: unknown; id_key?: unknown } | null | undefined,
): { main_component_tipo: string; id_key: number } | null {
	if (caller === null || caller === undefined) return null;
	const mainComponentTipo = caller.main_component_tipo;
	if (typeof mainComponentTipo !== 'string' || mainComponentTipo === '') return null;
	const idKey = caller.id_key;
	if (idKey === null || idKey === undefined || idKey === '') return null;
	const numericIdKey = Number(idKey);
	if (!Number.isInteger(numericIdKey) || numericIdKey < 1) return null;
	return { main_component_tipo: mainComponentTipo, id_key: numericIdKey };
}

/**
 * THE single reader of `source.is_temporal` (the invariant
 * test/unit/temporal_instance_tripwire.test.ts asserts). Every door calls this
 * predicate rather than touching the wire field, so the concept cannot acquire a
 * second, subtly different definition.
 *
 * It lives HERE, beside the field declaration, rather than in
 * core/section/record/temporal.ts (which owns the BEHAVIOUR) because this module
 * is a leaf: `section/read.ts` needs the predicate, and temporal.ts reaches back
 * into read.ts, so a predicate defined there would close a static import cycle
 * (import_scc_tripwire).
 *
 * STRICT `=== true`: a string 'false' or a stray 0 must not open the
 * non-persisting path, and an absent flag is an ordinary record request.
 */
export function isTemporalSource(source: RqoSource | undefined | null): boolean {
	return (source as { is_temporal?: unknown } | undefined | null)?.is_temporal === true;
}

/**
 * A show/search/choose block: a ddo_map plus optional per-block SQO tweaks.
 * PHP: request_config 'show'/'search'/'choose' objects.
 */
export const rqoDdoBlockSchema = z
	.object({
		ddo_map: ddoMapSchema.optional(),
		sqo_config: z.record(boundedIdentifier(), z.unknown()).optional(),
	})
	.passthrough();

/**
 * The RQO. Field set mirrors PHP request_query_object::$direct_keys — the
 * canonical wire vocabulary.
 */
export const rqoSchema = z
	.object({
		/** Optional request identifier (client correlation). */
		id: z.union([boundedLabel(), z.number()]).optional(),
		/** Resolution engine; 'dedalo' unless an external engine is configured. */
		api_engine: boundedIdentifier().optional(),
		/** API class to dispatch to, e.g. 'dd_core_api'. Allowlisted (§7.1). */
		dd_api: boundedIdentifier().optional(),
		/** Action (method) to run, e.g. 'read', 'save', 'search'. Allowlisted (§7.1). */
		action: boundedIdentifier(),
		source: rqoSourceSchema.optional(),
		/** Search query for read/search actions. Sanitized at the boundary (§7.5). */
		sqo: wireSqoSchema.optional(),
		show: rqoDdoBlockSchema.optional(),
		search: rqoDdoBlockSchema.optional(),
		choose: rqoDdoBlockSchema.optional(),
		/** Payload for write actions (save/delete/...). Shape is action-specific. */
		data: z.unknown().optional(),
		/**
		 * THE IDEMPOTENCY KEY (WC-2026-08-28-idempotency-key; CLI-01 / P0-10).
		 *
		 * An opaque, client-minted token naming ONE LOGICAL OPERATION. The browser
		 * transport re-sends a POST after its own client-side abort, and the engine
		 * has no `request.signal` handling — the aborted attempt runs to completion
		 * and COMMITS — so without this the resend was a SECOND operation: one click
		 * on "New record" on a throttled link minted up to five blank records.
		 * `api/dispatch.ts` is the ONE reader (the idempotency gate): the first
		 * request under a key executes, a concurrent twin awaits its answer, and a
		 * later twin is served the STORED answer instead of executing again.
		 *
		 * The GRAMMAR is enforced HERE rather than at the gate, so a malformed key is
		 * one uniform `request.invalid_rqo` at the parse door for every caller,
		 * authenticated or not — never a field that is silently ignored on some paths
		 * (the `prevent_lock` failure mode below, in miniature). 16-128 URL-safe
		 * characters admits a v4 UUID and the transport's hex fallback, and refuses
		 * a key short enough to collide across users by accident.
		 *
		 * OPTIONAL, and it must stay optional: a caller that sends none simply gets
		 * today's behaviour (execute, no ledger). It is the RETRYING transport that
		 * owes the stamp, not every client author.
		 */
		idempotency_key: z
			.string()
			// The regex quantifier already bounds this to 128 characters; the
			// explicit `.max` states it DECLARATIVELY so the schema census
			// (test/unit/rqo_scalar_bound_tripwire.test.ts) can read it as a bound
			// rather than having to interpret a regular expression.
			.max(128)
			.regex(/^[A-Za-z0-9_-]{16,128}$/)
			.optional(),
		/**
		 * INERT, AND MECHANICALLY HELD INERT — a retired PHP fossil, not a feature.
		 *
		 * In PHP this gated `session_write_close()` before long queries: a
		 * PHP-session-runtime concern with no Bun equivalent (Bun sessions are not
		 * file-locked). 51 client files (114 occurrences, measured 2026-08-28) and ONE MCP READ tool
		 * (src/ai/mcp/tools/records_read.ts) still SEND it; it is
		 * declared here only so those requests do not become `request.invalid_rqo`
		 * the day someone tightens the schema.
		 *
		 * It is NOT a concurrency control and never was — the name misleads, which is
		 * why it is now gated rather than merely documented:
		 * `test/unit/client_idempotency_tripwire.test.ts` asserts this declaration is
		 * the ONLY mention of `prevent_lock` in `src/` and `tools/`, so the field can
		 * never quietly acquire behaviour behind its own docblock. Request-level
		 * de-duplication is `idempotency_key` above; the component EDIT locks are
		 * `section/locks.ts`, a different thing again.
		 *
		 * REMOVAL CONDITION: when no shipped client sends it, delete the declaration
		 * and the gate leg together.
		 */
		prevent_lock: z.boolean().optional(),
		/** Action-specific options bag (file uploads, etc.). May carry a nested sqo. */
		options: boundedOptionsBag().optional(),
		/** Pretty-print the JSON response (dev aid). */
		pretty_print: z.boolean().optional(),
		/**
		 * CSRF token carried IN THE BODY, for the one transport that cannot set
		 * a header: navigator.sendBeacon on beforeunload (page.js lock release).
		 * server.ts uses it only as a FALLBACK when X-Dedalo-Csrf-Token is absent.
		 * NULLABLE on purpose: the beacon emits `csrf_token: page_globals.csrf_token
		 * || null`, so a bootstrap-window unload sends an explicit null. Before this
		 * key was declared, `.passthrough()` absorbed it; a bare `z.string()` would
		 * turn that beacon into a 400 `request.invalid_rqo` — a WORSE failure than
		 * the csrf refusal this fallback exists to cure.
		 */
		csrf_token: boundedLabel().nullable().optional(),
	})
	.passthrough();

export type Rqo = z.infer<typeof rqoSchema>;

export type { ApiEnvelope as ApiResponse } from '../errors/schema.ts';
/**
 * The API response envelope — envelope v2 (engineering/ERRORS_SPEC.md §3),
 * re-exported from the errors subsystem so registry totality (`error.code =
 * z.enum(ERROR_CODES)`) reaches every consumer that validates a LIVE response,
 * the parity harness included.
 */
export { apiEnvelopeSchema as apiResponseSchema } from '../errors/schema.ts';

/**
 * The FROZEN PHP-era body shape (`{result, msg, errors}`), kept ONLY to
 * schema-check the frozen oracle fixture store (test/parity/replay.test.ts,
 * engineering/ORACLE_HARVEST.md) — a store that can never be re-harvested and
 * still carries the PHP envelope. Never used for a live TS response.
 */
export const legacyApiResponseSchema = z
	.object({
		result: z.unknown(),
		msg: z.union([z.string(), z.array(z.string())]).optional(),
		error: z.unknown().optional(),
		errors: z.array(z.unknown()).optional(),
	})
	.passthrough();
