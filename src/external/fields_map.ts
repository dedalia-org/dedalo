/**
 * PAYLOAD SHAPING — remote answer → the values a component emits.
 *
 * This module owns everything between "JSON came back" and "these are the
 * strings": how a payload is unwrapped into rows, which row IS the requested
 * record, how a fields_map path reaches into a row, how a named format renders
 * a value, and the two emission ceilings. The per-service adapters override any
 * of it; the DEFAULTS here are the general case, and the general case is the
 * point — a second service must be mappable by a cataloguer editing fields_map,
 * with no engine edit.
 *
 * Three v6 defects are closed here by construction:
 *
 *  1. BLIND FIRST ROW. v6 reduced the record array and could not distinguish a
 *     multi-hit response from a single hit. `defaultPickRow` matches on the id
 *     and returns null otherwise — a non-matching multi-row answer is
 *     `not_found`, not "whatever came first".
 *  2. RAW VALUES ON THE WIRE. With no `format` declared, v6 handed the client
 *     whatever the service sent, arrays and objects included. Everything here
 *     ends as a STRING, or is refused and REPORTED.
 *  3. FLAT KEYS ONLY. v6 read `$row_data->{$name}` — one top-level key. The
 *     default extractor resolves a dotted/indexed PATH (`labels.en.value`,
 *     `items[0].body.value`), of which the flat key is the degenerate case.
 *
 * DIVERGENCE FROM THE ORACLE, deliberate: v6/frozen-v7 folded the fields_map
 * with `array_reduce`, so with several `local:'dato'` rows the LAST resolvable
 * one silently won. Here every resolvable `dato` row contributes, in
 * declaration order. Both agree on every node in this installation (each
 * component_external declares exactly one `dato` row); the divergence needs an
 * engineering/wire_contract/ entry the day this is wired into section reads.
 */

import { htmlTags } from '../core/resolve/html_text.ts';
import type { ExternalEntriesResult, ExternalRowView } from './api/types.ts';
import type {
	ExternalFormat,
	ExternalServiceModel,
	FieldsMapEntry,
	FormattedValue,
	RemoteIdShape,
	RemoteRow,
	ResponseMap,
} from './descriptor_types.ts';
import { ExternalServiceError } from './errors.ts';
import { externalSettings } from './settings.ts';

// ---------------------------------------------------------------------------
// Path extraction (the default `extract`)
// ---------------------------------------------------------------------------

/**
 * Resolve a dotted/indexed path against a decoded payload:
 *   `title`               → row.title
 *   `labels.en.value`     → row.labels.en.value
 *   `items[0].body.value` → row.items[0].body.value
 *
 * Returns `undefined` for any missing or non-traversable step — an absent
 * remote field is a MISSING VALUE, never an error (v6 logged and continued;
 * mapRowToEntries reports the shortfall through source_status).
 */
export function resolveRemotePath(row: RemoteRow, remotePath: string): unknown {
	if (remotePath.length === 0) return undefined;
	// Normalize `a[0].b` to `a.0.b` so one split handles both spellings.
	const steps = remotePath.replace(/\[(\d+)\]/g, '.$1').split('.');
	let current: unknown = row;
	for (const step of steps) {
		if (step.length === 0) return undefined;
		if (current === null || current === undefined) return undefined;
		if (Array.isArray(current)) {
			if (!/^\d+$/.test(step)) return undefined;
			current = current[Number(step)];
			continue;
		}
		if (typeof current !== 'object') return undefined;
		current = (current as Record<string, unknown>)[step];
	}
	return current;
}

// ---------------------------------------------------------------------------
// Row unwrapping / picking (the default `unwrapRows` / `pickRow`)
// ---------------------------------------------------------------------------

/** The response_map local name every service uses for its row array. */
const ROWS_LOCAL_KEY = 'ar_records';
/** The payload key used when response_map does not name one. */
const ROWS_FALLBACK_KEY = 'records';

/** The remote key a response_map binds to a local name, or null. */
export function remoteKeyFor(responseMap: ResponseMap, localName: string): string | null {
	return responseMap.find((pair) => pair.local === localName)?.remote ?? null;
}

/**
 * Default payload → rows. The row array is wherever response_map's
 * `ar_records` points (the ontology's own indirection), falling back to
 * `records`. A payload that is itself an array IS the row array; a payload
 * whose row slot is a single object is a one-row answer.
 */
export function defaultUnwrapRows(
	payload: unknown,
	responseMap: ResponseMap,
): readonly RemoteRow[] {
	if (Array.isArray(payload)) return payload.filter(isRemoteRow);
	if (payload === null || typeof payload !== 'object') return [];
	const key = remoteKeyFor(responseMap, ROWS_LOCAL_KEY) ?? ROWS_FALLBACK_KEY;
	const slot = resolveRemotePath(payload as RemoteRow, key);
	if (Array.isArray(slot)) return slot.filter(isRemoteRow);
	if (isRemoteRow(slot)) return [slot];
	return [];
}

function isRemoteRow(value: unknown): value is RemoteRow {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Default row selection: the row whose ENCODED id equals the requested one.
 * Never a blind first element — see the header, defect (1). A single-row answer
 * still has to match: a service that answers a different record than the one
 * asked for is a protocol failure wearing a success suit.
 */
export function defaultPickRow(
	model: ExternalServiceModel,
	rows: readonly RemoteRow[],
	remoteId: string,
): RemoteRow | null {
	const idPath = model.remoteIdPath ?? 'id';
	const extract = model.extract ?? resolveRemotePath;
	for (const row of rows) {
		const raw = extract(row, idPath);
		if (raw === null || raw === undefined) continue;
		// String(): a service may send the id as a number; the STORAGE form is
		// authoritative and the codec is what decides equality.
		let encoded: string;
		try {
			encoded = encodeRemoteIdWith(model, String(raw));
		} catch {
			continue; // a row carrying an id this service's shape refuses is not our row
		}
		if (encoded === remoteId) return row;
	}
	return null;
}

// ---------------------------------------------------------------------------
// The remote-id codec (the LOCATOR contract)
// ---------------------------------------------------------------------------

/** Shape validation. `numeric_string` keeps its leading zeros — never Number(). */
function assertIdShape(model: ExternalServiceModel, id: string): void {
	const shape: RemoteIdShape = model.remoteIdShape;
	const ok =
		shape === 'numeric_string'
			? /^[0-9]+$/.test(id)
			: // opaque_token: locator-safe only — no separators the locator/cache-key
				// grammars use, no whitespace, no control characters.
				/^[A-Za-z0-9._:-]+$/.test(id);
	if (!ok) {
		throw new ExternalServiceError({
			service: model.service,
			kind: 'bad_config',
			remoteId: id,
			detail: `remote id does not match declared shape '${shape}'`,
		});
	}
}

/** Storage form → wire form (adapter override, else validated identity). */
export function encodeRemoteIdWith(model: ExternalServiceModel, rawId: string): string {
	assertIdShape(model, rawId);
	return model.encodeRemoteId ? model.encodeRemoteId(rawId) : rawId;
}

/** Wire form → storage form. Must round-trip with `encodeRemoteIdWith`. */
export function decodeRemoteIdWith(model: ExternalServiceModel, token: string): string {
	const decoded = model.decodeRemoteId ? model.decodeRemoteId(token) : token;
	assertIdShape(model, decoded);
	return decoded;
}

// ---------------------------------------------------------------------------
// fields_map parsing
// ---------------------------------------------------------------------------

/**
 * Parse a node's `properties.fields_map`. Throws `bad_config` on anything that
 * is not a list of `{local, remote, format?}` strings — a malformed mapping is
 * a cataloguing error an operator must see, not an empty component.
 */
export function parseFieldsMap(raw: unknown, context: { tipo: string }): FieldsMapEntry[] {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) {
		throw new ExternalServiceError({
			service: 'unknown',
			kind: 'bad_config',
			detail: `fields_map of ${context.tipo} is not an array`,
		});
	}
	return raw.map((item, index) => {
		if (typeof item !== 'object' || item === null) {
			throw new ExternalServiceError({
				service: 'unknown',
				kind: 'bad_config',
				detail: `fields_map[${index}] of ${context.tipo} is not an object`,
			});
		}
		const record = item as Record<string, unknown>;
		const local = record.local;
		const remote = record.remote;
		const format = record.format;
		if (typeof local !== 'string' || typeof remote !== 'string' || remote.length === 0) {
			throw new ExternalServiceError({
				service: 'unknown',
				kind: 'bad_config',
				detail: `fields_map[${index}] of ${context.tipo} needs string local + non-empty remote`,
			});
		}
		if (format !== undefined && typeof format !== 'string') {
			throw new ExternalServiceError({
				service: 'unknown',
				kind: 'bad_config',
				detail: `fields_map[${index}] of ${context.tipo} has a non-string format`,
			});
		}
		return format === undefined ? { local, remote } : { local, remote, format };
	});
}

/** The remote FIELD a path reads — its head (`labels.en.value` → `labels`, `items[0]` → `items`). */
export function remoteFieldHead(remotePath: string): string {
	return (remotePath.replace(/\[(\d+)\]/g, '.$1').split('.')[0] ?? '').trim();
}

/**
 * The remote FIELD NAMES a fields_map needs — the head of each path, because a
 * service selects whole fields (`field[]=authors`), not paths inside them.
 * Deduped, order preserved: it is part of the request AND of the cache key.
 */
export function remoteFieldsOf(entries: readonly FieldsMapEntry[]): string[] {
	const seen = new Set<string>();
	const fields: string[] = [];
	for (const entry of entries) {
		if (entry.local !== 'dato') continue;
		const head = remoteFieldHead(entry.remote);
		if (head.length === 0 || seen.has(head)) continue;
		seen.add(head);
		fields.push(head);
	}
	return fields;
}

/**
 * The remote field names of `fields` the adapter REFUSES (`acceptsRemoteField`;
 * absent = accepts every name). Order preserved. Empty = all accepted.
 */
export function refusedRemoteFields(
	model: ExternalServiceModel,
	fields: Iterable<string>,
): string[] {
	const accepts = model.acceptsRemoteField;
	if (accepts === undefined) return [];
	const refused: string[] = [];
	for (const field of fields) if (!accepts(field)) refused.push(field);
	return refused;
}

// ---------------------------------------------------------------------------
// Markup sanitizing
// ---------------------------------------------------------------------------

/**
 * The tags a `markup` value may keep. NO attributes survive at all — not even
 * `class` — so there is no href/src/style/on* surface to reason about. Anything
 * unlisted is dropped and its TEXT kept (dropping the text would silently lose
 * a cataloguer's data).
 */
const ALLOWED_MARKUP_TAGS: ReadonlySet<string> = new Set([
	'b',
	'i',
	'em',
	'strong',
	'sub',
	'sup',
	'br',
	'p',
	'ul',
	'ol',
	'li',
]);

/** Elements whose CONTENT is executable/styling, not text — removed wholesale. */
const RAW_CONTENT_OPENER = /<(script|style|iframe|object|embed|svg|math)\b/iy;

/** A tag the re-emitter considers: `<name…>` / `</name…>` up to the first `>`. */
const MARKUP_TAG_OPENER = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b/y;

/**
 * Drop every raw-content element (opener through its own `</name\s*>`) and every
 * `<!-- … -->` comment. Same output as
 * `raw.replace(/<(script|…)\b[\s\S]*?<\/\1\s*>/gi, '').replace(/<!--[\s\S]*?-->/g, '')`,
 * in linear time: those lazy forms rescan to the end of a REMOTE value for every
 * unclosed `<script` / `<!--` (O(n²), the CodeQL #7958 shape). Once an element
 * has no closer after some point, no later opener of that name has one either,
 * so each name is searched for at most once past its last closer.
 */
function dropRawContent(raw: string): string {
	let out = '';
	let from = 0;
	const unclosedFrom = new Map<string, number>();
	let open = raw.indexOf('<');
	while (open !== -1) {
		RAW_CONTENT_OPENER.lastIndex = open;
		const opener = RAW_CONTENT_OPENER.exec(raw);
		const name = opener?.[1]?.toLowerCase();
		if (opener === null || name === undefined || open >= (unclosedFrom.get(name) ?? Infinity)) {
			open = raw.indexOf('<', open + 1);
			continue;
		}
		const closer = new RegExp(`<\\/${name}\\s*>`, 'gi');
		closer.lastIndex = open + opener[0].length;
		const closed = closer.exec(raw);
		if (closed === null) {
			unclosedFrom.set(name, open);
			open = raw.indexOf('<', open + 1);
			continue;
		}
		out += raw.slice(from, open);
		from = closed.index + closed[0].length;
		open = raw.indexOf('<', from);
	}
	const kept = out + raw.slice(from);
	let text = '';
	let cursor = 0;
	let comment = kept.indexOf('<!--');
	while (comment !== -1) {
		const end = kept.indexOf('-->', comment + 4);
		if (end === -1) break;
		text += kept.slice(cursor, comment);
		cursor = end + 3;
		comment = kept.indexOf('<!--', cursor);
	}
	return text + kept.slice(cursor);
}

function escapeText(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/**
 * Strict server-side allowlist sanitizer for a `markup` value.
 *
 * The v7 client says the server sanitises
 * (client/dedalo/core/component_external/js/view_default_edit_component_external.js);
 * today nothing did. This is that sanitiser: text is escaped, listed tags are
 * re-emitted BARE, everything else disappears. It is deliberately a re-emitter
 * rather than a stripper — a stripper leaves whatever it failed to recognise.
 */
export function sanitizeMarkup(raw: string): string {
	const withoutRawElements = dropRawContent(raw);
	let output = '';
	let cursor = 0;
	// Linear tag walk (html_text): `/<\/?(name)\b[^>]*>/g` is O(n²) on a remote
	// value holding a run of unclosed `<a` (CodeQL #7958 shape).
	for (const match of htmlTags(withoutRawElements, MARKUP_TAG_OPENER)) {
		output += escapeText(withoutRawElements.slice(cursor, match.index));
		cursor = match.index + match.tag.length;
		const tag = (match.opener[1] ?? '').toLowerCase();
		if (!ALLOWED_MARKUP_TAGS.has(tag)) continue; // drop the tag, keep the text around it
		output += match.tag.startsWith('</') ? `</${tag}>` : `<${tag}>`;
	}
	output += escapeText(withoutRawElements.slice(cursor));
	return output;
}

// ---------------------------------------------------------------------------
// Row → entries
// ---------------------------------------------------------------------------

/** A value with no `format`: string-ish scalars pass, arrays fan out, objects are refused. */
function coerceUnformatted(raw: unknown, into: FormattedValue[]): number {
	if (typeof raw === 'string') {
		into.push({ text: raw, kind: 'text' });
		return 0;
	}
	if (typeof raw === 'number' || typeof raw === 'boolean') {
		into.push({ text: String(raw), kind: 'text' });
		return 0;
	}
	if (Array.isArray(raw)) {
		let refused = 0;
		for (const item of raw) refused += coerceUnformatted(item, into);
		return refused;
	}
	// Objects (and null/undefined reaching here) have no canonical text form.
	return 1;
}

/**
 * Apply the two emission ceilings. Length is a REFUSAL, not a trim (the
 * catalog doc is explicit: a silently shortened title is a wrong title that
 * looks like a real one); count is a cut, and both are reported.
 */
export function normalizeEntries(values: readonly FormattedValue[]): {
	entries: string[];
	/** Parallel to `entries` — the kind SURVIVES normalisation (see mapRowToEntries). */
	kinds: FormattedValue['kind'][];
	droppedOverLength: number;
	droppedOverCount: number;
} {
	const settings = externalSettings();
	const maxChars = settings.maxEntryChars;
	const maxEntries = settings.maxEntries;
	const rendered: string[] = [];
	const kinds: FormattedValue['kind'][] = [];
	let droppedOverLength = 0;
	for (const value of values) {
		const text = value.kind === 'markup' ? sanitizeMarkup(value.text) : value.text;
		if (text.length > maxChars) {
			droppedOverLength++;
			continue;
		}
		rendered.push(text);
		kinds.push(value.kind);
	}
	const droppedOverCount = Math.max(0, rendered.length - maxEntries);
	return {
		entries: rendered.slice(0, maxEntries),
		kinds: kinds.slice(0, maxEntries),
		droppedOverLength,
		droppedOverCount,
	};
}

/**
 * THE emission function: one remote row + one component's fields_map → the
 * strings that component shows, plus the provenance the client needs to mark
 * them (stale, unavailable, truncated).
 */
export function mapRowToEntries(
	model: ExternalServiceModel,
	rowView: ExternalRowView,
	fieldsMap: readonly FieldsMapEntry[],
): ExternalEntriesResult {
	if (rowView.row === null) {
		const status = { status: rowView.status } as const;
		return {
			entries: [],
			source_status: rowView.reason === undefined ? status : { ...status, reason: rowView.reason },
		};
	}
	const extract = model.extract ?? resolveRemotePath;
	const values: FormattedValue[] = [];
	let droppedUnrenderable = 0;
	for (const entry of fieldsMap) {
		if (entry.local !== 'dato') continue; // only 'dato' rows carry a component value
		const raw = extract(rowView.row, entry.remote);
		if (raw === null || raw === undefined) continue; // absent remote field = missing value
		if (entry.format === undefined) {
			droppedUnrenderable += coerceUnformatted(raw, values);
			continue;
		}
		const format: ExternalFormat | undefined = model.formats?.[entry.format];
		if (format === undefined) {
			// Loud: a fields_map naming a format the adapter does not implement is
			// a cataloguing error. Silently emitting the raw value is how v6 put
			// arrays on the wire.
			throw new ExternalServiceError({
				service: model.service,
				kind: 'bad_config',
				sectionTipo: rowView.sectionTipo,
				remoteId: rowView.remoteId,
				detail: `fields_map declares format '${entry.format}', which service '${model.service}' does not implement`,
			});
		}
		// A FORMAT MAY REFUSE TOO. Its refusals join the unformatted path's counter
		// rather than inventing a second convention; a value whose every item was
		// refused contributes NOTHING (an empty entry would read as "the service
		// holds an empty value", which is a different, false statement).
		const formatted = format(raw);
		const formatRefused = formatted.refused ?? 0;
		droppedUnrenderable += formatRefused;
		if (formatRefused > 0 && formatted.text === '') continue;
		values.push(formatted);
	}
	const { entries, kinds, droppedOverLength, droppedOverCount } = normalizeEntries(values);
	// THE KIND REACHES THE WIRE, and only when it is load-bearing.
	//
	// The client renders an entry with textContent — an entry is third-party
	// text, and parsing it as HTML is a stored-XSS surface no sanitiser on the
	// far side can be trusted to have closed. `markup` is the one exception:
	// sanitizeMarkup above already reduced it to bare allowlisted tags, so it is
	// safe to parse AND meaningless not to (a formatted citation would otherwise
	// render its own tags as visible text). The client cannot tell the two apart
	// from the string, so it is told.
	//
	// Emitted only when SOME entry is markup — no adapter formats markup today,
	// so the field is absent on every live read and the happy path stays
	// byte-identical to what it emitted before this key existed.
	const entriesKind = kinds.some((kind) => kind === 'markup') ? { entries_kind: kinds } : {};
	const degraded =
		rowView.status !== 'ok' ||
		droppedUnrenderable > 0 ||
		droppedOverLength > 0 ||
		droppedOverCount > 0;
	if (!degraded) return { entries, ...entriesKind };
	return {
		entries,
		...entriesKind,
		source_status: {
			status: rowView.status,
			...(rowView.reason === undefined ? {} : { reason: rowView.reason }),
			...(droppedOverCount > 0 ? { dropped_over_count: droppedOverCount } : {}),
			...(droppedOverLength > 0 ? { dropped_over_length: droppedOverLength } : {}),
			...(droppedUnrenderable > 0 ? { dropped_unrenderable: droppedUnrenderable } : {}),
		},
	};
}
