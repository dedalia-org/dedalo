/**
 * CSL-JSON — the Zotero export format tool_import_zotero reads (Zotero:
 * Export Library… → "CSL JSON"; PHP tool_import_zotero read it with
 * `json_decode(file_get_contents())`). PURE: no database, no ontology. The
 * mapping onto a section's components lives in zotero_map.ts; this module only
 * reads the file and turns each CSL variable into its stored value shape.
 *
 * A CSL-JSON export is an ARRAY of item objects, one per bibliographic record:
 *
 *   [{"id": "http://zotero.org/users/1/items/ABCD1234", "type": "book",
 *     "title": "…", "author": [{"family": "Smith", "given": "Jane"}],
 *     "issued": {"date-parts": [[2014, 12, 30]]}, "ISBN": "…", …}]
 *
 * VARIABLES ARE DISPATCHED BY THEIR CSL KIND (CSL 1.0.2 §Appendix IV), not by
 * the handful of names PHP special-cased: every NAME variable (author, editor,
 * translator, container-author …) is a list of names; every DATE variable
 * (issued, accessed, original-date …) is a date; everything else is a scalar.
 * PHP converted `author` and `issued`/`accessed` only, and wrote every other
 * name or date variable as the raw object.
 *
 * WC-2026-11-12-zotero-csl-json-import names every divergence from PHP.
 */

/** One CSL item, as decoded. */
export type CslItem = Record<string, unknown>;

/** The CSL name variables (CSL 1.0.2 Appendix IV, "Name Variables"). */
export const CSL_NAME_VARIABLES: ReadonlySet<string> = new Set([
	'author',
	'chair',
	'collection-editor',
	'compiler',
	'composer',
	'container-author',
	'contributor',
	'curator',
	'director',
	'editor',
	'editorial-director',
	'executive-producer',
	'guest',
	'host',
	'illustrator',
	'interviewer',
	'narrator',
	'organizer',
	'original-author',
	'performer',
	'producer',
	'recipient',
	'reviewed-author',
	'script-writer',
	'series-creator',
	'translator',
]);

/** The CSL date variables (CSL 1.0.2 Appendix IV, "Date Variables"). */
export const CSL_DATE_VARIABLES: ReadonlySet<string> = new Set([
	'accessed',
	'available-date',
	'event-date',
	'issued',
	'original-date',
	'submitted',
]);

/** The parsed export: its items, or why the file is not a CSL-JSON export. */
export type CslParse = { items: CslItem[]; error: null } | { items: []; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Read a CSL-JSON export. The top level must be an ARRAY whose every element is
 * an item OBJECT; anything else is not a Zotero CSL-JSON export and the whole
 * file is refused (one error line — PHP iterated whatever `json_decode` gave and
 * wrote nothing, or wrote the keys of a top-level object as records).
 */
export function parseCslJson(text: string): CslParse {
	let decoded: unknown;
	try {
		decoded = JSON.parse(text);
	} catch {
		return { items: [], error: 'not valid JSON — export the library again as "CSL JSON"' };
	}
	if (!Array.isArray(decoded)) {
		return {
			items: [],
			error:
				'not a CSL-JSON export: the top level must be a list of items (Zotero: Export → "CSL JSON")',
		};
	}
	const bad = decoded.findIndex((item) => !isPlainObject(item));
	if (bad !== -1) {
		return { items: [], error: `not a CSL-JSON export: item #${bad + 1} is not an object` };
	}
	return { items: decoded as CslItem[], error: null };
}

/** A per-value refusal (the field is not written; the stored value is untouched). */
export interface CslRefusal {
	refusal: string;
}

/** A scalar CSL value as text: a string, or a finite number as its digits. */
export function cslScalar(value: unknown): string | null {
	if (typeof value === 'string') return value;
	if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	return null;
}

/**
 * ONE CSL name as display text (PHP zotero_name_to_name): `literal` (an
 * institution), else "given family" — trimmed, so a name with one part does not
 * keep PHP's stray space. A name with neither is null (nothing to store).
 */
function cslName(name: unknown): string | null {
	if (!isPlainObject(name)) return null;
	const literal = namePart(name.literal);
	if (literal !== '') return literal;
	const full = `${namePart(name.given)} ${namePart(name.family)}`.trim();
	return full === '' ? null : full;
}

/** One name part as trimmed text ('' when absent or not a scalar). */
function namePart(value: unknown): string {
	return cslScalar(value)?.trim() ?? '';
}

/** A CSL name variable (a list of name objects) → one display text per name. */
export function cslNames(value: unknown): string[] | CslRefusal {
	if (!Array.isArray(value)) {
		return { refusal: 'a name variable must be a list of names' };
	}
	const names = value.map(cslName);
	if (names.some((name) => name === null)) {
		return { refusal: 'a name carries neither "literal" nor "given"/"family"' };
	}
	return names as string[];
}

/** A dd_date bound (component_date's stored `start` / `end`). */
export interface CslDdDate {
	year: number;
	month?: number;
	day?: number;
	hour?: number;
	minute?: number;
	second?: number;
}

/** A converted date: the stored item and, when part of the source was dropped, why. */
export interface CslDateOutcome {
	item: { start: CslDdDate; end?: CslDdDate };
	notices: string[];
}

/** An integer date part (CSL allows a number or its digit string). */
function datePart(value: unknown): number | null {
	const text = cslScalar(value);
	if (text === null || !/^-?\d+$/.test(text.trim())) return null;
	return Number.parseInt(text.trim(), 10);
}

/** `[year, month?, day?]` → a dd_date bound, or null when the year is not an integer. */
function boundOf(parts: unknown): CslDdDate | null {
	if (!Array.isArray(parts)) return null;
	const year = datePart(parts[0]);
	if (year === null) return null;
	const bound: CslDdDate = { year };
	const month = datePart(parts[1]);
	const day = datePart(parts[2]);
	if (month !== null) bound.month = month;
	if (day !== null) bound.day = day;
	return bound;
}

/** A clock time `H:MM` / `H:MM:SS` (Zotero's time-of-day re-use of `season`). */
const TIME = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

/**
 * `season` → the bound's time, ONLY when it is a clock time. A CSL season (1-4,
 * "Spring") is not a time of day: PHP's regex read "1" as hour 1. Answers the
 * notice when a season is dropped, else null.
 */
function applySeason(bound: CslDdDate, season: unknown): string | null {
	const text = cslScalar(season);
	if (text === null || text.trim() === '') return null;
	const match = TIME.exec(text.trim());
	if (match === null) return `the season '${text}' is not a time of day — it was not imported`;
	bound.hour = Number.parseInt(match[1] as string, 10);
	bound.minute = Number.parseInt(match[2] as string, 10);
	if (match[3] !== undefined) bound.second = Number.parseInt(match[3], 10);
	return null;
}

/** The `end` bound of a two-part `date-parts`, honoured only by a range component. */
function applyEnd(
	outcome: CslDateOutcome,
	parts: readonly unknown[],
	rangeAllowed: boolean,
): CslRefusal | null {
	if (parts.length < 2) return null;
	const end = boundOf(parts[1]);
	if (end === null) return { refusal: 'the date range end has no integer year' };
	if (rangeAllowed) outcome.item.end = end;
	else outcome.notices.push('the date range end was not imported — the target date is not a range');
	return null;
}

/**
 * A CSL date variable → component_date's stored item (PHP zotero_date_to_dd_date):
 * `date-parts[0]` is the start, `date-parts[1]` the end (kept only when the
 * target component is a RANGE date — `rangeAllowed`), `season` a time of day
 * when it is one. A bare number / digit string is a year.
 *
 * REFUSED instead of PHP's empty `{start:{}}`: a date with no `date-parts` (a
 * `raw` / `literal` text date — "circa 1900") or no integer year. PHP saved the
 * empty date, which CLEARED the stored value on a re-import.
 */
export function cslDate(value: unknown, rangeAllowed: boolean): CslDateOutcome | CslRefusal {
	const year = datePart(value);
	if (year !== null) return { item: { start: { year } }, notices: [] };
	if (!isPlainObject(value) || !Array.isArray(value['date-parts'])) return textDateRefusal(value);
	return datePartsDate(value, rangeAllowed);
}

/** A date without `date-parts`: refused, naming its text when it has one. */
function textDateRefusal(value: unknown): CslRefusal {
	const text = isPlainObject(value) ? cslScalar(value.raw ?? value.literal) : null;
	const named = text === null ? '' : `'${text}' `;
	return {
		refusal: `the date ${named}has no "date-parts" — a text date cannot be stored as a date`,
	};
}

/** A `date-parts` date: start, season-as-time, end. */
function datePartsDate(
	value: Record<string, unknown>,
	rangeAllowed: boolean,
): CslDateOutcome | CslRefusal {
	const parts = value['date-parts'] as unknown[];
	const start = boundOf(parts[0]);
	if (start === null) return { refusal: 'the date has no integer year in "date-parts"' };
	const outcome: CslDateOutcome = { item: { start }, notices: [] };
	const seasonNotice = applySeason(start, value.season);
	if (seasonNotice !== null) outcome.notices.push(seasonNotice);
	return applyEnd(outcome, parts, rangeAllowed) ?? outcome;
}

/**
 * The Zotero item KEY: the last path segment of the item's `id` URI
 * ("http://zotero.org/users/1/items/ABCD1234" → "ABCD1234"; PHP
 * `end(explode('/', $id))`). An id without '/' is its own key.
 */
export function cslZoteroKey(id: string): string {
	const trimmed = id.trim();
	return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

/**
 * A DOI as an IRI: the resolver prefix PHP stored (`https://www.doi.org/`, kept
 * for continuity with records it imported), unless the DOI is already a URL.
 */
export function cslDoiIri(doi: string): string {
	const trimmed = doi.trim();
	return /^https?:\/\//i.test(trimmed) ? trimmed : `https://www.doi.org/${trimmed}`;
}
