/**
 * TEXT_AREA INLINE-TAG GRAMMAR
 *
 * A `component_text_area` value is HTML that embeds Dédalo bracket-tags. The
 * copied client (client/dedalo/core/common/js/tr.js `add_tag_img_on_the_fly` +
 * component_text_area.js `build_view_tag_obj`) turns each tag into an
 *   <img src="../../core/component_text_area/tag/?id=[TAG]">
 * where the `?id=` value is the SHORT form the client builds — the in-text
 * `-data:…:data` payload is stripped from the `src` (except the `svg`/`{…}`
 * locator case, whose `src` IS the JSON payload). This module parses that
 * `?id=` value into a typed shape the SVG renderer (tag_render.ts) and the
 * endpoint (tag_endpoint.ts) consume.
 *
 * The authority for the syntax is the PHP endpoint's per-type dispatch in
 * v7_php_frozen/master_dedalo/core/component_text_area/tag/index.php and the client twin
 * tr.js `get_mark_pattern`. Our regexes accept BOTH the short form (what the
 * endpoint receives) and the full in-text form (optional `-data:…:data`) so the
 * same parser can be tested directly against the stored-markup corpus.
 *
 * Per-type DISPLAY text follows the (quirky but faithful) PHP endpoint choice:
 *   - tc            → the timecode value
 *   - index/geo/page→ the NUMERIC id (the indexation/counter number)
 *   - person/lang   → the label (URL-decoded)
 *   - note          → the numeric id
 * Reproducing PHP's exact per-type label pick keeps the rendered badges reading
 * the same as today for existing records.
 *
 * SECURITY: no field is ever interpolated anywhere but XML text content, and the
 * renderer XML-escapes it (SEC-028 parity with the client `esc()` closure). The
 * `safeDecodeTagId` step reproduces SEC-027 (JSON-aware xss decode).
 *
 * (!) This module PARSES marker bytes, it never writes them: the stored in-text
 * markers keep their historical string section_id spelling. Only the parsed-out
 * value is canonicalized (WC-2026-08-10-section-id-int-canonical).
 */

import type { StoredSectionId } from '../../concepts/locator.ts';
import { canonicalizeStoredSectionId } from '../../concepts/section_id.ts';
import { stripTags } from '../../resolve/html_text.ts';

/** Fixed <img> widths the client requests per type (tr.js). Height is always 15. */
export const TAG_WIDTHS = {
	tc: 82,
	index: 34,
	geo: 38,
	page: 38,
	person: 72,
	note: 22,
	lang: 50,
} as const;

/** Sprite (PNG-in-PHP, SVG-here) tag types — everything except draw and locator. */
export type SpriteTagType = keyof typeof TAG_WIDTHS;

/** A deterministic badge: pure function of its id, immutable-cacheable. */
export interface SpriteTag {
	readonly kind: 'sprite';
	readonly type: SpriteTagType;
	/** index closing tag `[/index-…]` (renders slightly differently). */
	readonly out: boolean;
	/** Single-letter state: n=new, r=reviewed, d=deleted, a/b=person role. */
	readonly state: string;
	/** The text drawn inside the badge (already resolved per PHP semantics). */
	readonly display: string;
	/** Fixed badge width in px (viewBox width; matches the client <img> width). */
	readonly width: number;
}

/** A `draw` annotation tag — PHP emits an inline SVG pill; so do we. */
export interface DrawTag {
	readonly kind: 'draw';
	readonly state: string;
	readonly display: string;
}

/** A `{…}`/`svg` locator tag — resolves a referenced component's file (live data, ACL-gated). */
export interface LocatorTag {
	readonly kind: 'locator';
	readonly section_tipo: string;
	/**
	 * Canonical record address (WC-2026-08-10-section-id-int-canonical). The
	 * in-text marker this was parsed OUT of still spells the id as a string —
	 * those bytes are untouched — but the parsed value is canonicalized here so
	 * no consumer has to re-guess. A non-address value (padded/opaque remote id)
	 * survives verbatim and the endpoint fails it closed, as it always did.
	 */
	readonly section_id: StoredSectionId;
	readonly component_tipo: string;
}

/** Unrecognised / malformed id — the endpoint fails closed (404). */
export interface InvalidTag {
	readonly kind: 'invalid';
}

export type ParsedTag = SpriteTag | DrawTag | LocatorTag | InvalidTag;

/**
 * SEC-027: JSON-aware sanitisation, mirroring the intent of PHP `tag_safe_xss`.
 * A valid JSON object/array is a legitimate locator payload and passes through
 * unchanged; anything else has any complete HTML tag stripped as defence in
 * depth. We check parse SUCCESS AND object/array-ness (not truthiness) so
 * valid-but-falsy JSON ("null", "0", '""') is still treated as plain text,
 * exactly like the PHP `json_last_error()` gate.
 *
 * NOTE we deliberately do NOT HTML-entity-encode here: the only sink for tag
 * text is SVG XML content, which the renderer XML-escapes exactly once
 * (tag_render.ts). Encoding here as well would double-encode ('&' → '&amp;amp;').
 */
export function safeDecodeTagId(raw: string): string {
	if (raw.length === 0) return raw;
	try {
		// PHP normalises the HTML-escaped/single quotes to double quotes before decoding.
		const jsonCandidate = raw.replace(/&#0?39;|'/g, '"');
		const decoded = JSON.parse(jsonCandidate);
		if (decoded !== null && typeof decoded === 'object') {
			// Structured locator payload — leave untouched.
			return raw;
		}
	} catch {
		// not JSON — fall through to sanitisation
	}
	// Strip any complete HTML tag; the renderer owns XML-escaping of what remains.
	// Linear: the regex form `/<[^>]*>/g` is O(n²) on a run of unclosed `<`
	// (CodeQL #7958) and this input is unauthenticated (html_text.ts).
	return stripTags(raw);
}

/** URL-decode a per-type label the way PHP does (guarded — a bad `%` is left as-is). */
function decodeLabel(value: string | undefined): string {
	if (value === undefined || value === '') return '';
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

// Per-type anchored patterns. Each accepts an OPTIONAL trailing `-data:…:data`
// payload so the full in-text markup parses as well as the short `?id=` form.
const RE_TC = /^\[TC_([0-9]{1,2}:[0-9]{1,2}:[0-9]{1,2}(?:\.[0-9]{1,3})?)_TC\]$/;
const RE_INDEX = /^\[(\/?)index-([a-z])-([0-9]{1,6})(?:-([^-]{0,22}))?(?:-data:.*:data)?\]$/;
const RE_GEO = /^\[geo-([a-z])-([0-9]{1,6})(?:-([^-]{0,22}))?(?:-data:.*:data)?\]$/;
const RE_PAGE = /^\[page-([a-z])-([0-9]{1,6})(?:-([^-]{0,22}))?(?:-data:.*:data)?\]$/;
const RE_PERSON = /^\[person-([a-z])-([0-9]{0,6})-([^-]{0,22})(?:-data:.*:data)?\]$/;
const RE_NOTE = /^\[note-([a-z])-([0-9]{1,6})(?:-([^-]{0,22}))?(?:-data:.*:data)?\]$/;
const RE_LANG = /^\[lang-([a-z])-([0-9]{1,6})-([^-]{0,22})(?:-data:.*:data)?\]$/;
const RE_DRAW = /^\[draw-([a-z])-([0-9]{1,6})(?:-([^-]{0,22}))?(?:-data:.*:data)?\]$/;

/**
 * Parse a decoded `?id=` value into a typed tag. Returns `{kind:'invalid'}` for
 * anything unrecognised so the endpoint can fail closed. `raw` must already have
 * been through `safeDecodeTagId` + URL-decoding by the caller.
 */
/**
 * A marker locator's section_id as a scalar, canonicalized — or null when it
 * is not a scalar at all (fail closed rather than String()-ing an object into
 * '[object …]').
 */
function scalarSectionIdOf(locator: Record<string, unknown>): StoredSectionId | null {
	const raw = locator.section_id;
	if (typeof raw !== 'string' && typeof raw !== 'number') return null;
	return canonicalizeStoredSectionId(raw) as StoredSectionId;
}

export function parseTagId(raw: string): ParsedTag {
	const text = raw.trim();
	if (text === '') return { kind: 'invalid' };

	// Locator: a JSON object payload `{ "section_tipo", "section_id", "component_tipo" }`.
	// Covers the PHP `{`-prefixed branch and the `svg` tag (whose src IS the payload).
	if (text.startsWith('{')) {
		try {
			const normalised = text.replace(/&#0?39;|'/g, '"');
			const locator = JSON.parse(normalised) as Record<string, unknown>;
			const section_tipo = String(locator.section_tipo ?? '');
			const component_tipo = String(locator.component_tipo ?? '');
			// The marker payload spells the id as a string; canonicalize the
			// PARSED value (never the marker bytes) so the address leaves this
			// grammar in the one form the rest of the engine speaks.
			const section_id = scalarSectionIdOf(locator);
			if (section_id === null) return { kind: 'invalid' };
			if (section_tipo === '' || section_id === '') return { kind: 'invalid' };
			return { kind: 'locator', section_tipo, section_id, component_tipo };
		} catch {
			return { kind: 'invalid' };
		}
	}

	// TC — display the timecode value itself.
	const tc = RE_TC.exec(text);
	if (tc) {
		return {
			kind: 'sprite',
			type: 'tc',
			out: false,
			state: 'n',
			display: tc[1] ?? '',
			width: TAG_WIDTHS.tc,
		};
	}

	// INDEX — display the numeric id; leading `/` marks the closing (out) tag.
	const index = RE_INDEX.exec(text);
	if (index) {
		return {
			kind: 'sprite',
			type: 'index',
			out: index[1] === '/',
			state: index[2] ?? 'n',
			display: index[3] ?? '',
			width: TAG_WIDTHS.index,
		};
	}

	// DRAW — inline SVG pill; display the label.
	const draw = RE_DRAW.exec(text);
	if (draw) {
		return { kind: 'draw', state: draw[1] ?? 'n', display: decodeLabel(draw[3]) };
	}

	// GEO — display the numeric id (PHP explodes and takes the id part).
	const geo = RE_GEO.exec(text);
	if (geo) {
		return {
			kind: 'sprite',
			type: 'geo',
			out: false,
			state: geo[1] ?? 'n',
			display: geo[2] ?? '',
			width: TAG_WIDTHS.geo,
		};
	}

	// PAGE — display the numeric id.
	const page = RE_PAGE.exec(text);
	if (page) {
		return {
			kind: 'sprite',
			type: 'page',
			out: false,
			state: page[1] ?? 'n',
			display: page[2] ?? '',
			width: TAG_WIDTHS.page,
		};
	}

	// PERSON — display the label (initials); fall back to '...'. States clamp to a/b.
	const person = RE_PERSON.exec(text);
	if (person) {
		const label = decodeLabel(person[3]) || '...';
		const state = person[1] === 'a' || person[1] === 'b' ? person[1] : 'a';
		return {
			kind: 'sprite',
			type: 'person',
			out: false,
			state,
			display: label,
			width: TAG_WIDTHS.person,
		};
	}

	// NOTE — display the numeric id.
	const note = RE_NOTE.exec(text);
	if (note) {
		return {
			kind: 'sprite',
			type: 'note',
			out: false,
			state: note[1] ?? 'n',
			display: note[2] ?? '',
			width: TAG_WIDTHS.note,
		};
	}

	// LANG — display the label (language name).
	const lang = RE_LANG.exec(text);
	if (lang) {
		return {
			kind: 'sprite',
			type: 'lang',
			out: false,
			state: lang[1] ?? 'n',
			display: decodeLabel(lang[3]),
			width: TAG_WIDTHS.lang,
		};
	}

	return { kind: 'invalid' };
}
