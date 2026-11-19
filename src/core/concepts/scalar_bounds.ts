/**
 * SCALAR BOUNDS — the ONE declaration of how long a wire scalar may be, and how
 * big the untyped `options` bag may get, at the SINGLE parse door every API
 * request passes through (`server.ts` → `rqoSchema.safeParse`).
 *
 * THE DEFECT THIS CLOSES (audit 2026-08-26 SEC-21, S2, measured). Nothing in the
 * request contract bounded a string. The login handler reads
 * `String(options.username ?? '')`, the body ceiling is 256 MiB and the shipped
 * nginx configs allow `client_max_body_size 300m`, so ONE UNAUTHENTICATED login
 * POST carrying a 32 MiB username measured 67,109,061 bytes durably written to
 * `matrix_activity` in 3.16 s — inside the database `pg_dump` copies on every
 * backup. A volume defect at an unauthenticated door is a recovery defect.
 *
 * WHY HERE AND NOT AT THE HANDLER. A per-handler clamp is a rule each new door
 * must remember; a bound in the schema is a rule the parse door enforces for
 * every caller, authenticated or not, BEFORE any handler, any log line and any
 * INSERT. An oversize scalar is therefore one uniform `request.invalid_rqo`
 * (WC-2026-09-05-preauth-intake-bounds) — REFUSED, never truncated: silently
 * storing a shortened version of what the caller sent is a lie in an audit trail.
 *
 * THE NUMBERS ARE NAMED, NOT SPRINKLED. `test/unit/rqo_scalar_bound_tripwire.test.ts`
 * walks the parsed schema tree and demands every string leaf carry a maximum; it
 * reads the declarations, so raising a ceiling is an edit here and nowhere else.
 */

import { z } from 'zod';

/**
 * The named ceilings, in characters (bytes for `optionsBytes`).
 *
 * Sized from what the vocabulary IS, not from what a caller might like:
 * an ontology tipo is `<tld><digits>` (the longest shipped is well under 32),
 * a lang is `lg-xxx`, a mode/view/action is a program identifier. `label` and
 * `freeText` are the two fields that legitimately carry human prose on the
 * REQUEST side (a ddo label, a separator, an api id), so they get room.
 */
export const SCALAR_BOUNDS = {
	/** Ontology tipos, component/section names, api class + action names, models. */
	identifier: 128,
	/** Language codes ('lg-spa'). */
	lang: 32,
	/** Render mode / view / column-id / width — program vocabulary. */
	shortName: 128,
	/** Client-authored correlation ids, csrf tokens, human labels, separators. */
	label: 1024,
	/** Anything else a request scalar may legitimately carry. */
	freeText: 4096,
	/** Keys in the untyped `options` bag. */
	optionsKeys: 512,
	/**
	 * Serialized ceiling of the whole `options` bag. Deliberately 2× the
	 * error report's own `REPORT_MAX_SERIALIZED_BYTES` (256 KiB, and `send_report`
	 * arrives through this very bag), and ~500× below the body ceiling.
	 * Record CONTENT does not travel here — it travels in `rqo.data`, which stays
	 * unbounded because a heritage record legitimately is large.
	 */
	optionsBytes: 512 * 1024,
	/**
	 * Entries in ONE client-supplied `ddo_map`.
	 *
	 * A ddo_map names the components to resolve for one block; the largest
	 * authored maps in the shipped ontology are in the low hundreds. It was
	 * `z.array(z.unknown())` with no ceiling and a `console.warn` per DROPPED
	 * entry, so one in-bounds body amplified into unbounded log lines — the SEC-21
	 * class again, in the log rather than in the database.
	 */
	ddoMapEntries: 2048,
	/** Dropped-entry warnings emitted for ONE ddo_map before they are summarized. */
	ddoMapWarnings: 5,
} as const;

/** An ontology tipo / component / section / model / api / action name. */
export const boundedIdentifier = (): z.ZodString => z.string().max(SCALAR_BOUNDS.identifier);
/** A language code. */
export const boundedLang = (): z.ZodString => z.string().max(SCALAR_BOUNDS.lang);
/** A mode / view / column id / width — program vocabulary, not prose. */
export const boundedShortName = (): z.ZodString => z.string().max(SCALAR_BOUNDS.shortName);
/** A label, separator, correlation id or token. */
export const boundedLabel = (): z.ZodString => z.string().max(SCALAR_BOUNDS.label);
/** Any other request-side scalar. */
export const boundedFreeText = (): z.ZodString => z.string().max(SCALAR_BOUNDS.freeText);

/**
 * Serialized size of a parsed JSON value, ACCUMULATED WITH AN EARLY BAIL.
 *
 * `JSON.stringify(value).length` would re-serialize the whole 256 MiB body just
 * to discover it is too big — the exact cost the bound exists to refuse. This
 * walk adds each string's `.length` in O(1) and stops the moment the budget is
 * spent, so the check costs the budget, not the input.
 *
 * Approximate by design (it counts characters and structural glue, not exact
 * JSON escaping): a ceiling is a ceiling, not an accounting statement.
 */
export function serializedSizeExceeds(value: unknown, limit: number): boolean {
	let budget = limit;
	const stack: unknown[] = [value];
	while (stack.length > 0) {
		budget -= chargeOne(stack.pop(), stack);
		if (budget < 0) return true;
	}
	return false;
}

/**
 * The cost of ONE node, pushing its children onto `stack`. Split out of the loop
 * above — and split again below — so each piece stays one decision: the loop
 * owns the budget, these own the shapes.
 */
function chargeOne(current: unknown, stack: unknown[]): number {
	const scalar = scalarCost(current);
	return scalar ?? containerCost(current as object, stack);
}

/**
 * Cost of a leaf, or null when the value is a container. A JSON leaf's own
 * bytes: a string is what it is, everything else is a small constant — the walk
 * is a CEILING check, not an accounting statement.
 */
function scalarCost(value: unknown): number | null {
	if (typeof value === 'string') return value.length + 2;
	if (value === null || value === undefined) return 4;
	if (typeof value === 'object') return null;
	return 8;
}

/** Cost of a container's own glue; its children go on the stack. */
function containerCost(value: object, stack: unknown[]): number {
	if (Array.isArray(value)) {
		for (const item of value) stack.push(item);
		return value.length + 2;
	}
	let cost = 0;
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		cost += key.length + 4;
		stack.push(item);
	}
	return cost;
}

/**
 * PER-KEY BUDGETS: the keys of `options` whose OWNING HANDLER declares its own,
 * larger, measured ceiling.
 *
 * WHY THIS EXISTS. A single flat ceiling on the whole bag is a bound that can be
 * SMALLER than the behaviour the engine ships: `options.images[].data_base64` is
 * the only inbound door for assistant/MCP image attachments, and its handler
 * (`src/core/api/handlers/dd_mcp_api.ts`) deliberately accepts up to 8 images,
 * 7,000,000 base64 chars each and 21,000,000 in total — a single ~750 KB
 * photograph would have been refused at the parse door by the 512 KiB bag
 * ceiling and object identification by photo would simply have been dead. The
 * SAME hole existed one door further on and was missed once: `options.image`
 * (SINGULAR) is `dd_identify_api`'s only inbound photograph, capped there at
 * 8 MiB decoded, and every realistic photograph was `request.invalid_rqo`
 * until it earned its budget below.
 *
 * THE LAW: a door's bound may never be tighter than what a handler declares it
 * accepts. So the bag ceiling applies to the UNDECLARED remainder — the open
 * space where the next SEC-21 lives — and each declared key is charged against
 * its own budget, sized ABOVE its handler's own cap (which still runs, and is
 * still the tighter, semantic check: media type, per-image length, entry count).
 * Adding a key here is therefore a deliberate, reasoned widening of ONE key, not
 * of the bag.
 *
 * Gate: `test/unit/rqo_scalar_bound_tripwire.test.ts` asserts every budget is
 * >= the handler constant it exists for, so raising the handler cap without
 * raising the budget is RED rather than a silent refusal in production.
 */
export const OPTIONS_KEY_BUDGETS: Readonly<Record<string, { bytes: number; reason: string }>> = {
	images: {
		bytes: 24 * 1024 * 1024,
		reason:
			'assistant/MCP image attachments; dd_mcp_api caps them at IMAGES_MAX (8) x IMAGE_MAX_BASE64_CHARS (7,000,000) and IMAGES_MAX_TOTAL_BASE64_CHARS (21,000,000) — this budget sits just above that total, with room for the JSON glue',
	},
	image: {
		bytes: 12 * 1024 * 1024,
		reason:
			'object identification by photograph; dd_identify_api caps ONE image at MAX_IMAGE_BYTES (8 MiB) decoded, i.e. MAX_IMAGE_BASE64_CHARS (~11,185,432) on the wire — this budget sits just above that, with room for a data: prefix and the JSON glue',
	},
	history: {
		bytes: 1024 * 1024,
		reason:
			'assistant/MCP conversation history; dd_mcp_api caps it at HISTORY_MAX_ENTRIES (64) and HISTORY_MAX_BYTES (262,144) of text — this budget sits above that with room for the per-entry glue',
	},
};

/** The serialized ceiling that applies to one key of `options`. */
export function optionsKeyBudget(key: string): number {
	return OPTIONS_KEY_BUDGETS[key]?.bytes ?? SCALAR_BOUNDS.optionsBytes;
}

/**
 * The `options` bag: still untyped by necessity (every api class reads its own
 * action-specific keys out of it), but no longer UNBOUNDED — bounded key names,
 * a key count, a per-key budget for the keys a handler has declared, and a
 * serialized ceiling on everything else together.
 *
 * This is the bound that actually stops SEC-21: `options.username` has no
 * declaration to carry a `.max()`, and inventing one here would only move the
 * hole to the next undeclared key.
 */
export function boundedOptionsBag(): z.ZodType<Record<string, unknown>> {
	return z
		.record(boundedIdentifier(), z.unknown())
		.superRefine((bag: Record<string, unknown>, ctx: z.RefinementCtx) => {
			const message = optionsBagViolation(bag);
			if (message !== null) ctx.addIssue({ code: 'custom', message });
		});
}

/** The first ceiling `bag` breaks, or null. Split out so each piece is one decision. */
function optionsBagViolation(bag: Record<string, unknown>): string | null {
	if (Object.keys(bag).length > SCALAR_BOUNDS.optionsKeys) return 'options: too many keys';
	const remainder: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(bag)) {
		const declared = OPTIONS_KEY_BUDGETS[key];
		if (declared === undefined) {
			remainder[key] = value;
			continue;
		}
		if (serializedSizeExceeds(value, declared.bytes)) return `options.${key}: payload too large`;
	}
	if (serializedSizeExceeds(remainder, SCALAR_BOUNDS.optionsBytes)) {
		return 'options: payload too large';
	}
	return null;
}
