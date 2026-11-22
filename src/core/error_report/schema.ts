/**
 * Payload schema for the error-report flow (WC-019; transport per
 * WC-2026-11-19-error-report-email-transport).
 *
 * - `reportSubmissionSchema` validates what the BROWSER submitted
 *   (tools/tool_error_report/server) before the server stamps identity;
 * - `ReportWire` is the stamped report that is stored locally and mailed as
 *   report.json (`reportWireSchema` is its canonical shape).
 *
 * Shape rules (security design, 2026-07-10):
 * - `.strict()` everywhere: unknown fields are REJECTED, not stripped;
 * - every string is length-clamped; `section_tipo` passes the REWRITE_SPEC §7.6
 *   identifier chokepoint shape before it may ever reach SQL or logs;
 * - the whole serialized payload is capped (REPORT_MAX_SERIALIZED_BYTES) — the
 *   global body cap (256 MiB) is far too large for this endpoint.
 *
 * Explicitly NEVER part of the schema: csrf_token, username, db name, engine
 * versions, filesystem paths, raw query strings (see the tool's client JS —
 * the payload is allowlist-CONSTRUCTED, never spread from page_globals).
 */

import { z } from 'zod';

/** REWRITE_SPEC §7.6 identifier chokepoint shape (is_valid_tipo). */
const TIPO_PATTERN = /^[a-z]+[0-9]+$/;

/** Hard cap on the serialized options payload at both ends (bytes). */
export const REPORT_MAX_SERIALIZED_BYTES = 256 * 1024;

/** Max captured-error entries per report (matches the client buffer bound). */
export const REPORT_MAX_JS_ERRORS = 50;

/**
 * Max length of the optional screenshot data URL (bytes ≈ chars, ASCII). The
 * client compresses to a ~150 KiB base64 budget; this is the hard ceiling a
 * single field may reach before the whole-payload cap (REPORT_MAX_SERIALIZED_
 * BYTES) even applies. Kept below the payload cap so description + a few errors
 * always fit alongside it.
 */
export const REPORT_MAX_SCREENSHOT_CHARS = 200 * 1024;

/**
 * The screenshot is an INLINE base64 data URL only — a raster image the browser
 * re-encoded from the admin's chosen file. It is NEVER a fetchable URL: the
 * `data:image/...;base64,` shape is enforced here so no field can smuggle an
 * http(s)/file reference the server might resolve (no SSRF surface).
 */
const SCREENSHOT_DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** One captured entry of the client buffer (window.dedalo_js_errors). */
const jsErrorSchema = z
	.object({
		type: z.enum(['error', 'unhandledrejection', 'console']),
		msg: z.string().max(2000).nullable(),
		source: z.string().max(1024).nullable(),
		line: z.number().int().nullable(),
		col: z.number().int().nullable(),
		stack: z.string().max(6000).nullable(),
		time: z.string().max(40).nullable(),
		count: z.number().int().min(1).max(1_000_000),
	})
	.strict();

/**
 * Informational browser snapshot. Stored inside the `context` jsonb, never
 * trusted and never used for identity — the servers stamp their own.
 */
const clientGlobalsSchema = z
	.object({
		user_id: z.number().int().nullable(),
		dedalo_version: z.string().max(128).nullable(),
		application_lang: z.string().max(128).nullable(),
		data_lang: z.string().max(128).nullable(),
	})
	.strict();

/** What the BROWSER may legitimately supply (only client-observable context). */
export const reportSubmissionSchema = z
	.object({
		description: z.string().min(1).max(8000),
		page_url: z.string().max(2048).nullable(),
		section_tipo: z.string().regex(TIPO_PATTERN).max(64).nullable(),
		section_id: z.string().max(64).nullable(),
		user_agent: z.string().max(512).nullable(),
		js_errors: z.array(jsErrorSchema).max(REPORT_MAX_JS_ERRORS),
		client_globals: clientGlobalsSchema.nullable(),
		// Optional admin-attached screenshot (inline data URL; see the pattern).
		// `.optional()` too: a sender on an older client omits the key entirely,
		// and the master must still accept its report (cross-version wire).
		screenshot: z
			.string()
			.max(REPORT_MAX_SCREENSHOT_CHARS)
			.regex(SCREENSHOT_DATA_URL)
			.nullable()
			.optional(),
	})
	.strict();

export type ReportSubmission = z.infer<typeof reportSubmissionSchema>;

/**
 * The stamped report: the submission plus the fields send_report stamps
 * server-side (identity, version, langs, time). Stored and mailed as-is.
 */
export const reportWireSchema = reportSubmissionSchema
	.extend({
		user_id: z.number().int().nullable(),
		entity: z.string().max(128).nullable(),
		entity_label: z.string().max(128).nullable(),
		dedalo_version: z.string().max(128).nullable(),
		langs: z
			.object({
				application: z.string().max(128).nullable(),
				data: z.string().max(128).nullable(),
			})
			.strict()
			.nullable(),
		sent_at: z.string().max(40).nullable(),
		report_version: z.literal(1),
	})
	.strict();

export type ReportWire = z.infer<typeof reportWireSchema>;

/** True when the serialized payload exceeds the endpoint cap. */
export function reportPayloadTooLarge(payload: unknown): boolean {
	try {
		return JSON.stringify(payload).length > REPORT_MAX_SERIALIZED_BYTES;
	} catch {
		// Unserializable (circular/bigint) input never passes the schema anyway;
		// treat it as oversized so the caller refuses early.
		return true;
	}
}
