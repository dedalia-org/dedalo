/**
 * MARC21 / ISO 2709 record parser (PHP tool_import_marc21 uses the bundled PEAR
 * File_MARC; this is a from-scratch port — no 3rd-party lib, per the project
 * mandate). Parses the transmission format into fields + subfields so the import
 * mapping (marc21_map config → component tipos) can consume them.
 *
 * ISO 2709 layout: a 24-byte leader (record length 0–4, base address of data
 * 12–16), a directory of 12-byte entries (tag[3] + length[4] + start[5]) ending
 * with a field terminator, then the variable fields. Control fields (<010) have
 * no indicators/subfields; data fields carry 2 indicators + subfields delimited
 * by the subfield separator, each starting with a 1-char code.
 */

import { DedaloError } from '../errors/index.ts';

const FIELD_TERMINATOR = 0x1e;
const SUBFIELD_DELIMITER = 0x1f;
const RECORD_TERMINATOR = 0x1d;

export interface MarcSubfield {
	code: string;
	value: string;
}

export interface MarcField {
	tag: string;
	/** Control fields (tag < '010') carry a raw value and no subfields. */
	value?: string;
	indicator1?: string;
	indicator2?: string;
	subfields?: MarcSubfield[];
}

export interface MarcRecord {
	leader: string;
	fields: MarcField[];
}

/** Split a raw MARC21 stream into individual record byte-strings (record terminator). */
export function splitMarcRecords(bytes: Uint8Array): Uint8Array[] {
	const records: Uint8Array[] = [];
	let start = 0;
	for (let i = 0; i < bytes.length; i++) {
		if (bytes[i] === RECORD_TERMINATOR) {
			records.push(bytes.subarray(start, i + 1));
			start = i + 1;
		}
	}
	if (start < bytes.length) records.push(bytes.subarray(start));
	return records.filter((r) => r.length > 24);
}

/**
 * The leader is ASCII by the standard; windows-1252 is the total single-byte
 * reading of it, so a corrupt leader still yields 24 characters to inspect
 * instead of throwing inside the decoder before we can say what is wrong.
 */
const leaderDecoder = new TextDecoder('windows-1252');
/** Record content: STRICT — an invalid sequence must be reported, never substituted. */
const unicodeDecoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Which character encoding a record DECLARES, from leader position 09
 * (MARC21 "character coding scheme"): 'a' = Unicode/UTF-8, blank = MARC-8.
 *
 * DATA-09 (2026-08-26 audit): this module decoded EVERY record as UTF-8 with
 * `fatal:false` and never read position 09. A MARC-8 record — what most library
 * systems still export — decodes clean in its ASCII range and turns every
 * diacritic into U+FFFD, so `Ripollès` was imported as `Ripoll<FFFD>s` with a
 * green report. MARC-8 is not a single-byte encoding (it has combining
 * sequences and G0/G1 charset escapes), so there is no honest conversion to
 * make here: a record that declares a non-Unicode scheme AND carries non-ASCII
 * bytes is REFUSED, by record, into the door's error list. Its ASCII-only
 * siblings import exactly as before — the refusal is the smallest one that
 * cannot corrupt a value.
 */
function decodeRecordBytes(bytes: Uint8Array, leader: string): (part: Uint8Array) => string {
	const unicode = leader[9] === 'a';
	if (!unicode) {
		for (const byte of bytes) {
			if (byte >= 0x80) {
				throw new DedaloError('request.invalid_data', {
					message: `MARC record declares a non-Unicode character coding scheme (leader position 09 is '${leader[9] === ' ' ? 'blank, i.e. MARC-8' : leader[9]}') and carries non-ASCII bytes. Convert the file to UTF-8 (MARC-8 → Unicode) and import it again; nothing was read from this record.`,
					publicMessage:
						'MARC record is not UTF-8 (leader position 09 does not declare Unicode) and carries non-ASCII bytes. Convert the file to UTF-8 and import it again.',
				});
			}
		}
	}
	return (part: Uint8Array): string => {
		try {
			return unicodeDecoder.decode(part);
		} catch {
			throw new DedaloError('request.invalid_data', {
				message:
					'MARC record declares Unicode but is not valid UTF-8. Nothing was read from this record.',
				publicMessage:
					'MARC record declares Unicode but is not valid UTF-8. Nothing was read from this record.',
			});
		}
	};
}

/** Parse one ISO 2709 record into its leader + fields. Throws on a malformed record. */
export function parseMarcRecord(bytes: Uint8Array): MarcRecord {
	if (bytes.length < 24) {
		throw new DedaloError('request.invalid_data', {
			message: 'MARC record shorter than the 24-byte leader',
		});
	}
	const leader = leaderDecoder.decode(bytes.subarray(0, 24));
	const decode = decodeRecordBytes(bytes, leader);
	const baseAddress = Number.parseInt(leader.slice(12, 17), 10);
	if (!Number.isFinite(baseAddress) || baseAddress <= 24 || baseAddress > bytes.length) {
		throw new DedaloError('request.invalid_data', {
			message: 'MARC leader has an invalid base address of data',
		});
	}

	// Directory: 24 .. baseAddress-1, 12 bytes per entry, ends at a field terminator.
	const directoryBytes = bytes.subarray(24, baseAddress - 1);
	const fields: MarcField[] = [];
	for (let offset = 0; offset + 12 <= directoryBytes.length; offset += 12) {
		// The directory is structural ASCII (tag + two numbers); read it with the
		// total single-byte decoder so a corrupt entry is SKIPPED below, not thrown.
		const entry = leaderDecoder.decode(directoryBytes.subarray(offset, offset + 12));
		const tag = entry.slice(0, 3);
		const length = Number.parseInt(entry.slice(3, 7), 10);
		const startPos = Number.parseInt(entry.slice(7, 12), 10);
		if (!/^\d{3}$/.test(tag) || !Number.isFinite(length) || !Number.isFinite(startPos)) continue;

		const from = baseAddress + startPos;
		const to = from + length;
		if (to > bytes.length) continue;
		// Drop the trailing field terminator.
		let fieldBytes = bytes.subarray(from, to);
		if (fieldBytes.length > 0 && fieldBytes[fieldBytes.length - 1] === FIELD_TERMINATOR) {
			fieldBytes = fieldBytes.subarray(0, fieldBytes.length - 1);
		}
		fields.push(parseField(tag, fieldBytes, decode));
	}
	return { leader, fields };
}

function parseField(
	tag: string,
	bytes: Uint8Array,
	decode: (part: Uint8Array) => string,
): MarcField {
	// Control fields (00X) have no indicators or subfields.
	if (tag < '010') {
		return { tag, value: decode(bytes) };
	}
	const indicator1 = bytes.length > 0 ? decode(bytes.subarray(0, 1)) : ' ';
	const indicator2 = bytes.length > 1 ? decode(bytes.subarray(1, 2)) : ' ';
	const subfields: MarcSubfield[] = [];
	// Subfields start after the 2 indicators; each begins with the delimiter + code.
	const body = bytes.subarray(2);
	let start = 0;
	// Find each delimiter, split into (code, value) chunks.
	const chunks: Uint8Array[] = [];
	for (let i = 0; i < body.length; i++) {
		if (body[i] === SUBFIELD_DELIMITER) {
			if (i > start) chunks.push(body.subarray(start, i));
			start = i + 1;
		}
	}
	if (start < body.length) chunks.push(body.subarray(start));
	for (const chunk of chunks) {
		if (chunk.length === 0) continue;
		const code = decode(chunk.subarray(0, 1));
		const value = decode(chunk.subarray(1));
		subfields.push({ code, value });
	}
	return { tag, indicator1, indicator2, subfields };
}

/**
 * A field/subfield spec — what `field_to_section_id.value` and every map entry
 * carry (PHP `$element_vars`, read by get_value / get_field).
 *
 * `field` is ONE tag unless `field_multiple` is set, in which case it may also
 * be a list of tags: every occurrence of every listed tag contributes, joined
 * by `row_separator` (PHP get_value :1069). Without `field_multiple` only the
 * FIRST occurrence of the tag is read (PHP `$record->getField()`), exactly as
 * the config grammar the master ontology ships was written against.
 */
export interface MarcValueSpec {
	field: string | readonly string[];
	field_multiple?: boolean;
	/** Joins the occurrences of a `field_multiple` / `occurrences:'all'` spec (PHP default '. '). */
	row_separator?: string;
	/**
	 * Without `field_multiple` a tag is read at its FIRST occurrence (PHP
	 * get_value). `'all'` (owner C17, opt-in) reads EVERY occurrence of the ONE
	 * tag, the non-empty ones joined by `row_separator` — a repeated 700 as one
	 * value without listing several tags. Never beside `marc21_conditional`
	 * (which names one occurrence by definition; the parser refuses the pair).
	 */
	occurrences?: 'all';
	/** Subfield code; omit to join ALL subfields with subfield_separator. */
	subfield?: string;
	subfield_separator?: string;
	/**
	 * Guard: the FIRST occurrence whose guard subfield equals `value` supplies the
	 * spec's subfield (PHP extract_conditional_value). When no occurrence passes
	 * the value is '' — NOTHING is written (owner C16). PHP fell back to the
	 * unconditional first occurrence, i.e. imported ANOTHER library's copy data
	 * (a 945 holdings line of a different `$j`) as if it were this one's.
	 */
	marc21_conditional?: { subfield: string; value: string };
}

/**
 * A marc21_map entry (PHP config->map[]): which MARC field/subfield → which
 * component, and the per-entry value transforms (PHP transform_marc21_value).
 */
export interface MarcMapEntry extends MarcValueSpec {
	component_tipo: string;
	/**
	 * The `name:'id'` entry — the record's control number. Its value is written
	 * TRIMMED ONLY, never punctuation-stripped: it is the same identifier the code
	 * lookup searches for (trimmed only, `applyMarcMap` below), and a stored code
	 * that differs from the searched one by a trailing '.' would duplicate the
	 * record on every re-import.
	 */
	is_id?: boolean;
	/** Keep the first run of digits of the value, as an integer (PHP :643). */
	partial_left_content?: number;
	/** `'year'`: the value becomes a component_date `{start:{year}}` (PHP :655). */
	date_format?: 'year';
	/** Code → stored data (locators), e.g. `{"spa":[{section_tipo,section_id}]}` (PHP :668). */
	dd_data_map?: Readonly<Record<string, readonly unknown[]>>;
	/** Companion writes `{component tipo: data}` made when this entry yields a value (PHP :882). */
	dd_action?: Readonly<Record<string, readonly unknown[]>>;
}

/** The tags a spec reads, in config order. */
function specTags(spec: MarcValueSpec): readonly string[] {
	return typeof spec.field === 'string' ? [spec.field] : spec.field;
}

/**
 * The text of ONE field occurrence (PHP get_field :1131): the named subfield's
 * FIRST value ('' when absent), or every subfield joined; trimmed.
 *
 * A CONTROL field (00X, no subfields) answers its raw value — an extension:
 * PHP read '' there because File_MARC control fields carry no `subfields`.
 * Kept deliberately (WC-2026-11-12-marc21-config-map-and-transforms): `001`
 * is the record's own control number and the obvious thing to map.
 */
function fieldText(field: MarcField, spec: MarcValueSpec): string {
	if (field.value !== undefined) return field.value.trim();
	const subfields = field.subfields ?? [];
	if (spec.subfield !== undefined) {
		return (subfields.find((s) => s.code === spec.subfield)?.value ?? '').trim();
	}
	return subfields
		.map((s) => s.value)
		.join(spec.subfield_separator ?? ' ')
		.trim();
}

/** Every occurrence of `tags` (in tag order), the non-empty texts joined by `row_separator`. */
function joinedOccurrences(
	record: MarcRecord,
	spec: MarcValueSpec,
	tags: readonly string[],
): string {
	const parts: string[] = [];
	for (const tag of tags) {
		for (const field of record.fields) {
			if (field.tag !== tag) continue;
			const text = fieldText(field, spec);
			if (text !== '') parts.push(text);
		}
	}
	return parts.join(spec.row_separator ?? '. ');
}

/**
 * PHP get_value (:1069): the first occurrence of the tag, or — with
 * `field_multiple` — every occurrence of every listed tag, the non-empty ones
 * joined by `row_separator`. `occurrences:'all'` (C17) is the same join over
 * the ONE tag of a spec without `field_multiple`.
 */
function unconditionalValue(record: MarcRecord, spec: MarcValueSpec): string {
	if (spec.field_multiple === true) return joinedOccurrences(record, spec, specTags(spec));
	const tag = specTags(spec)[0] as string;
	if (spec.occurrences === 'all') return joinedOccurrences(record, spec, [tag]);
	const first = record.fields.find((f) => f.tag === tag);
	return first === undefined ? '' : fieldText(first, spec);
}

/**
 * PHP extract_conditional_value (:561): the FIRST occurrence whose guard
 * subfield equals the expected value supplies the spec's subfield (''
 * when that occurrence lacks it). `null` = no occurrence passed the guard.
 */
function conditionalValue(
	record: MarcRecord,
	spec: MarcValueSpec,
	guard: { subfield: string; value: string },
): string | null {
	for (const field of record.fields) {
		if (field.tag !== specTags(spec)[0]) continue;
		const guardValue = field.subfields?.find((s) => s.code === guard.subfield)?.value;
		if (guardValue === guard.value) return fieldText(field, spec);
	}
	return null;
}

/**
 * The value a spec reads from a record (PHP extract_marc21_value :505 +
 * get_value + get_field): ONE trimmed string, '' when absent. A guarded spec
 * whose guard no occurrence passes is '' (owner C16) — the PHP `?? get_value`
 * fallback is deliberately NOT ported (WC-2026-11-12-marc21-config-map-and-transforms,
 * addendum 2026-11-13).
 */
export function extractMarcValue(record: MarcRecord, spec: MarcValueSpec): string {
	const guard = spec.marc21_conditional;
	if (guard === undefined) return unconditionalValue(record, spec);
	return conditionalValue(record, spec, guard) ?? '';
}

/**
 * What a map entry's transforms made of the extracted text:
 *  - `literal` — TEXT for the component, conformed as text and never parsed as
 *    a CSV/JSON cell (a MARC '[1987]' is a bracketed inferred date, not JSON);
 *  - `structured` — stored data as JSON (a dd_date, the dd_data_map locators);
 *  - `refused` — the transform could not produce a value; the field is reported
 *    and NOT written (no silent narrowing).
 */
export type MarcTransformed =
	| { kind: 'literal'; text: string }
	| { kind: 'structured'; json: string }
	| { kind: 'refused'; reason: string };

/** PHP `(int)$string`: the leading integer, 0 when there is none. */
function leadingInt(text: string): number {
	const match = /^\s*[+-]?\d+/.exec(text);
	return match === null ? 0 : Number.parseInt(match[0], 10);
}

/** PHP partial_left_content (:643): the first run of digits as an int, 0 when none. */
function firstDigits(text: string): string {
	const match = /\d+/.exec(text);
	return String(match === null ? 0 : Number.parseInt(match[0], 10));
}

/** `date_format:'year'` (PHP :655): a year > 0 or a refusal (PHP stored an empty date). */
function yearDate(text: string): MarcTransformed {
	const year = leadingInt(text);
	if (year <= 0) return { kind: 'refused', reason: `no year in '${text}'` };
	return { kind: 'structured', json: JSON.stringify([{ start: { year } }]) };
}

/** `dd_data_map` (PHP :668): the mapped data, or a refusal on a miss (PHP wrote the raw code). */
function mappedData(
	text: string,
	map: Readonly<Record<string, readonly unknown[]>>,
): MarcTransformed {
	if (!Object.hasOwn(map, text)) {
		return { kind: 'refused', reason: `no dd_data_map entry for '${text}'` };
	}
	return { kind: 'structured', json: JSON.stringify(map[text]) };
}

/**
 * PHP transform_marc21_value (:610), in its order: trim; strip trailing
 * ` \t,:.` (never on the `id` entry); partial_left_content; date_format;
 * dd_data_map. `raw` is the extracted, already-trimmed text.
 */
export function transformMarcValue(raw: string, entry: MarcMapEntry): MarcTransformed {
	let text = entry.is_id === true ? raw.trim() : raw.trim().replace(/[ \t,:.]+$/, '');
	if (entry.partial_left_content !== undefined) text = firstDigits(text);
	if (entry.date_format === 'year') return yearDate(text);
	if (entry.dd_data_map !== undefined) return mappedData(text, entry.dd_data_map);
	return { kind: 'literal', text };
}

/** One component's values for a mapped record — structurally the executor's `MappedField`. */
export interface MarcMappedField {
	component_tipo: string;
	values: string[];
	/** The values are TEXT: conform them as text, never as a JSON cell. */
	literal?: boolean;
	/** A transform refusal: reported by the executor, never written. */
	refusal?: string;
}

type MarcYield = Exclude<MarcTransformed, { kind: 'refused' }>;

/** The entry's own field: literal TEXT, or structured JSON. */
function ownField(entry: MarcMapEntry, transformed: MarcYield): MarcMappedField {
	return transformed.kind === 'literal'
		? { component_tipo: entry.component_tipo, values: [transformed.text], literal: true }
		: { component_tipo: entry.component_tipo, values: [transformed.json] };
}

/** PHP `!empty($value)`: an empty text, a structured clear ('[]', a dd_data_map 'und') yielded nothing. */
function yieldedValue(transformed: MarcYield): boolean {
	return transformed.kind === 'literal' ? transformed.text !== '' : transformed.json !== '[]';
}

/** The entry's dd_action companions (none when it declares none). */
function companionFields(entry: MarcMapEntry): MarcMappedField[] {
	if (entry.dd_action === undefined) return [];
	return Object.entries(entry.dd_action).map(([tipo, data]) => ({
		component_tipo: tipo,
		values: [JSON.stringify(data)],
	}));
}

/** The fields one map entry contributes: its own value, then its dd_action companions. */
function entryFields(raw: string, entry: MarcMapEntry): MarcMappedField[] {
	const transformed = transformMarcValue(raw, entry);
	if (transformed.kind === 'refused') {
		return [{ component_tipo: entry.component_tipo, values: [raw], refusal: transformed.reason }];
	}
	// A text the strip emptied (264$a ':', 020$a '.') yields NOTHING: no field
	// (an empty literal would CLEAR the component, defeating "last non-empty
	// wins" for a tipo bound twice) and no dd_action companion.
	if (transformed.kind === 'literal' && transformed.text === '') return [];
	const own = ownField(entry, transformed);
	return yieldedValue(transformed) ? [own, ...companionFields(entry)] : [own];
}

/**
 * The rows a record maps to: the identifier the record CARRIES, plus the
 * per-component values.
 */
export interface MarcMappedRecord {
	/**
	 * The `field_to_section_id` value, trimmed but otherwise VERBATIM — a library
	 * control number ('.b12345678', 'ocm12345678', '42'). It is NOT an address:
	 * the tool door resolves it against the section's code component
	 * (src/core/tools/import_code_lookup.ts, `resolveMappedCodes`).
	 *
	 * Null when the config names no id field, or this record's id field is absent
	 * or blank — both mean "this record names no identifier", which the door
	 * reads as "create".
	 */
	code: string | null;
	/**
	 * In MAP ORDER, companions right after their entry — the executor saves them
	 * sequentially, so a tipo bound by two entries (020/022 → one standard-number
	 * component) keeps the LAST non-empty one, as PHP's sequential saves did.
	 */
	fields: MarcMappedField[];
}

/** `907` / `907$a` — how a refusal names the field it read the identifier from. */
export function marcSpecLabel(spec: MarcValueSpec): string {
	const tags = specTags(spec).join('|');
	return spec.subfield === undefined ? tags : `${tags}$${spec.subfield}`;
}

/**
 * Apply a marc21_map to a parsed record → the per-component values + the
 * identifier the record carries (PHP process_marc21_field_mappings, plus the
 * READ half of resolve_target_section). Pure over the record + map: it reaches
 * no database, and therefore decides NO record address.
 *
 * DATA-08, CLOSED HERE AND AT THE DOOR (2026-08-30): AN IMPORTED EXTERNAL
 * IDENTIFIER IS NOT A RECORD ADDRESS. This function used to read the id cell
 * with a record-id grammar and hand the number back as `sectionId`, which the
 * tool passed to the shared executor as the record to write. A MARC control
 * number of '42' therefore wrote onto record 42 of the target section —
 * whatever curated record already lived there — and when no such row existed,
 * `saveComponentData`'s upsert branch (save_component.ts :1064, PHP set_dato
 * parity) MINTED one at that meaningless id. Both outcomes were reported as
 * success. There was no existence check and no code lookup anywhere in the run.
 *
 * The frozen tool never did this: `resolve_target_section`
 * (class.tool_import_marc21.php :393-419) SEARCHED the value as a code
 * (`get_section_id_from_code` :1202 — an SQO `=<code>` over the component the
 * `id` map entry's ddo_map names) and created a record when the search found
 * none. The identifier was an identifier at both ends; only the port turned it
 * into an address.
 *
 * So the value now travels as `code` and the ADDRESS DECISION LIVES AT THE
 * DOOR, where the database is reachable — this module stays the leaf ISO 2709
 * parser whose only dependency is the error registry (an edge to the search
 * layer would make `parseMarc` unloadable whenever an unrelated config module
 * fails to parse; measured 2026-08-27).
 *
 * WITH THE ADDRESS GONE, SO IS THE ID GRAMMAR. `parseRecordIdCell` lived here
 * only to decide that address, and the DATA-22 refusal beside it ('12abc' →
 * record 12, the truncation corner) existed only because a cast happened at
 * all: nothing here casts any more, so both are deleted rather than kept
 * unused. The digits grammar remains at the CSV door
 * (src/core/tools/import_csv.ts `parseRecordIdCell`), where the `section_id`
 * COLUMN genuinely is a Dédalo address — that door is unchanged.
 */
export function applyMarcMap(
	record: MarcRecord,
	map: readonly MarcMapEntry[],
	fieldToSectionId?: MarcValueSpec,
): MarcMappedRecord {
	let code: string | null = null;
	if (fieldToSectionId !== undefined) {
		// Whitespace is the transmission format's padding (MARC pads its fixed
		// fields), never part of the identifier.
		const raw = extractMarcValue(record, fieldToSectionId).trim();
		if (raw !== '') code = raw;
	}
	const fields: MarcMappedField[] = [];
	for (const entry of map) {
		const raw = extractMarcValue(record, entry);
		// '' only is empty: '0' is a value (PHP empty() also skipped '0' — divergence, WC).
		if (raw !== '') fields.push(...entryFields(raw, entry));
	}
	return { code, fields };
}

/** Parse a full MARC21 stream into records (skips malformed ones, collecting errors). */
export function parseMarc(bytes: Uint8Array): { records: MarcRecord[]; errors: string[] } {
	const records: MarcRecord[] = [];
	const errors: string[] = [];
	for (const [index, raw] of splitMarcRecords(bytes).entries()) {
		try {
			records.push(parseMarcRecord(raw));
		} catch (error) {
			errors.push(`record ${index}: ${(error as Error).message}`);
		}
	}
	return { records, errors };
}
