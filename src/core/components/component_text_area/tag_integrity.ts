/**
 * TAG INTEGRITY — the edit-read repair of a transcription's index/draw tags
 * (PHP component_text_area::fix_broken_index_tags, run by
 * component_text_area_json on every EDIT item of a text_area declaring
 * `tags_index` / `tags_draw`; WC-2026-11-13-text-area-broken-tag-repair).
 *
 * Two defects surface as BLUE (state `d`) tags the user then places or deletes:
 *  1. an unpaired mark — a `[/index-…]` with no `[index-…]` of the same id gets
 *     a synthetic open tag right BEFORE it; an open tag with no close gets a
 *     synthetic close right AFTER it (label + data copied from the survivor);
 *  2. an orphan locator — an indexation (`tags_index` portal) whose `tag_id`
 *     has no mark in the text gets `[index-d-<id>--data::data][/index-d-<id>--data::data]`
 *     PREPENDED; a draw locator (`tags_draw`) with no `[draw-…]` mark gets
 *     `[draw-d-<id>-<id>:-data::data]` prepended. One prepend per id, so the
 *     last orphan ends up first (PHP order: draws, then index pairs, then text).
 *
 * Nothing is SAVED: the repaired text persists only if the user saves it.
 *
 * Deliberate divergences from PHP (all in the WC entry):
 *  - a synthetic partner is inserted at each MATCHED position, exactly once
 *    (PHP `str_replace`d the whole text inside the per-match loop, so a broken
 *    tag occurring twice got two partners each, and its bytes were also
 *    rewritten inside other tags' data payloads);
 *  - a locator `tag_id` must have the grammar's id shape (TAG_ID_SHAPE) — PHP
 *    concatenated whatever was stored into text the editor renders as HTML;
 *  - ids compare by numeric value, as PHP's loose `==` did on digit strings
 *    ('07' pairs with '7'); locator ids also DEDUPE by it (PHP's array_unique
 *    compared strings, so '07' and '7' prepended two pairs for one id);
 *  - the repair MESSAGE is not ported: PHP built it and the JSON controller
 *    discarded it (its labels were retired, WC-034).
 *
 * LINEAR SCANNER, NO TAIL REGEX. The PHP grammar's lazy `(.*?):data` tail is
 * quadratic on adversarial input when run over a whole text (measured with the
 * same JS regexes: 200 KB ≈ 1 s), and an edit read cannot cap its input the way
 * the list preview does (DOS-01). Here every head is found with indexOf, its id
 * and label are bounded by the grammar (≤ 6 digits, ≤ 22 label chars), and the
 * tail's FIRST `:data]` is a binary search over positions computed once —
 * O(n log n), with the regex's exact matching semantics (PCRE: `.` excludes
 * only `\n`; `[^-]` crosses lines; a failed tail falls back to the bare `]`;
 * successive matches of one family never overlap).
 *
 * Pure: no I/O, no module state.
 */

import { TAG_ID_SHAPE } from '../../resolve/tr_marks.ts';

/** The outcome of one repair; `text` is the INPUT reference when nothing changed. */
export interface TagRepair {
	text: string;
	/** Synthetic partners inserted next to an unpaired mark. */
	changedTags: number;
	/** Orphan-locator tags prepended (one per index pair / per draw tag). */
	addedTags: number;
}

/** One matched mark: its span and the grammar's captures. */
interface ParsedTag {
	start: number;
	end: number;
	id: string;
	label: string;
	data: string;
}

type TagFamily = 'indexIn' | 'indexOut' | 'draw';

/** The literal each family's matches start with. */
const FAMILY_HEAD: Record<TagFamily, string> = {
	indexIn: '[index-',
	indexOut: '[/index-',
	draw: '[draw-',
};

const DATA_OPEN = '-data:';
const DATA_CLOSE = ':data]';
const MAX_ID_DIGITS = 6;
const MAX_LABEL_CHARS = 22;

/** Sorted positions of the two tail delimiters, computed once per text. */
interface TailIndex {
	closes: number[];
	newlines: number[];
}

function positionsOf(text: string, needle: string): number[] {
	const positions: number[] = [];
	for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) {
		positions.push(at);
	}
	return positions;
}

/** The first element ≥ `from` of an ascending array, or -1. */
function firstAtOrAfter(sorted: readonly number[], from: number): number {
	let low = 0;
	let high = sorted.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if ((sorted[mid] as number) < from) low = mid + 1;
		else high = mid;
	}
	return low < sorted.length ? (sorted[low] as number) : -1;
}

/**
 * The lazy `(.*?):data\]` tail starting at `dataStart`: the FIRST `:data]` at
 * or after it, provided no `\n` comes first. Returns the data + the tag end.
 */
function resolveTail(
	text: string,
	dataStart: number,
	tails: TailIndex,
): { data: string; end: number } | null {
	const close = firstAtOrAfter(tails.closes, dataStart);
	if (close === -1) return null;
	const newline = firstAtOrAfter(tails.newlines, dataStart);
	if (newline !== -1 && newline < close) return null;
	return { data: text.slice(dataStart, close), end: close + DATA_CLOSE.length };
}

/**
 * `-([^-]{0,22})-data:` at `at`: the label is the maximal dash-free run (a
 * shorter one leaves a non-dash where `-data:` must start), ≤ 22 chars.
 */
function resolveLabel(text: string, at: number): { label: string; dataStart: number } | null {
	if (text[at] !== '-') return null;
	const labelEnd = labelRunEnd(text, at + 1);
	if (labelEnd - at - 1 > MAX_LABEL_CHARS || !text.startsWith(DATA_OPEN, labelEnd)) return null;
	return { label: text.slice(at + 1, labelEnd), dataStart: labelEnd + DATA_OPEN.length };
}

/** End of the dash-free run at `from`, scanning at most one char past the label cap. */
function labelRunEnd(text: string, from: number): number {
	let cursor = from;
	while (cursor < text.length && text[cursor] !== '-' && cursor - from <= MAX_LABEL_CHARS) {
		cursor++;
	}
	return cursor;
}

/** `([a-z])-([0-9]{1,6})` at `at`: the id (a maximal digit run of 1-6) and where it ends. */
function resolveStateAndId(text: string, at: number): { id: string; next: number } | null {
	if (!isStateLetter(text, at) || text[at + 1] !== '-') return null;
	const idStart = at + 2;
	const idEnd = digitRunEnd(text, idStart);
	const digits = idEnd - idStart;
	if (digits < 1 || digits > MAX_ID_DIGITS) return null;
	return { id: text.slice(idStart, idEnd), next: idEnd };
}

function isStateLetter(text: string, at: number): boolean {
	const code = text.charCodeAt(at);
	return code >= 97 && code <= 122;
}

/** End of the digit run at `from`, scanning at most one digit past the id cap. */
function digitRunEnd(text: string, from: number): number {
	let cursor = from;
	while (cursor - from <= MAX_ID_DIGITS && isDigit(text, cursor)) cursor++;
	return cursor;
}

function isDigit(text: string, at: number): boolean {
	const code = text.charCodeAt(at);
	return code >= 48 && code <= 57;
}

/** index tail: `(-label-data:(.*?):data)?\]` — the optional group first, then a bare `]`. */
function resolveIndexTail(
	text: string,
	at: number,
	tails: TailIndex,
): { label: string; data: string; end: number } | null {
	const labelled = resolveLabel(text, at);
	const tail = labelled === null ? null : resolveTail(text, labelled.dataStart, tails);
	if (labelled !== null && tail !== null) return { label: labelled.label, ...tail };
	return text[at] === ']' ? { label: '', data: '', end: at + 1 } : null;
}

/** draw tail: `(-label)?-data:(.*?):data\]` — the optional label first, then without it. */
function resolveDrawTail(
	text: string,
	at: number,
	tails: TailIndex,
): { label: string; data: string; end: number } | null {
	const labelled = resolveLabel(text, at);
	const tail = labelled === null ? null : resolveTail(text, labelled.dataStart, tails);
	if (labelled !== null && tail !== null) return { label: labelled.label, ...tail };
	if (!text.startsWith(DATA_OPEN, at)) return null;
	const bare = resolveTail(text, at + DATA_OPEN.length, tails);
	return bare === null ? null : { label: '', ...bare };
}

/** The family's mark starting at `start` (its head already matched), or null. */
function parseTagAt(
	text: string,
	start: number,
	family: TagFamily,
	tails: TailIndex,
): ParsedTag | null {
	const head = resolveStateAndId(text, start + FAMILY_HEAD[family].length);
	if (head === null) return null;
	const tail =
		family === 'draw'
			? resolveDrawTail(text, head.next, tails)
			: resolveIndexTail(text, head.next, tails);
	return tail === null ? null : { start, id: head.id, ...tail };
}

/** Every non-overlapping match of one family, left to right (preg_match_all). */
function scanFamily(text: string, family: TagFamily, tails: TailIndex): ParsedTag[] {
	const head = FAMILY_HEAD[family];
	const tags: ParsedTag[] = [];
	let from = 0;
	for (let start = text.indexOf(head); start !== -1; start = text.indexOf(head, from)) {
		const tag = parseTagAt(text, start, family, tails);
		if (tag !== null) tags.push(tag);
		from = tag === null ? start + 1 : tag.end;
	}
	return tags;
}

/** The comparison key of a tag id: its numeric value (PHP loose `==` on digit strings). */
function idKey(id: string): string {
	return String(Number.parseInt(id, 10));
}

/** PHP TR::build_tag for index marks (data `"` → `'`, "safe data for JSON"). */
export function buildIndexTag(
	direction: 'in' | 'out',
	state: string,
	id: string,
	label: string,
	data: string,
): string {
	const slash = direction === 'out' ? '/' : '';
	return `[${slash}index-${state}-${id}-${label}-data:${data.replaceAll('"', "'")}:data]`;
}

/** PHP TR::build_tag for draw marks. */
export function buildDrawTag(state: string, id: string, label: string, data: string): string {
	return `[draw-${state}-${id}-${label}-data:${data.replaceAll('"', "'")}:data]`;
}

/** Locator tag ids with the grammar's shape, deduped by numeric value, first spelling kept. */
function validLocatorIds(ids: readonly string[]): string[] {
	const seen = new Set<string>();
	const valid: string[] = [];
	for (const id of ids) {
		if (!TAG_ID_SHAPE.test(id) || seen.has(idKey(id))) continue;
		seen.add(idKey(id));
		valid.push(id);
	}
	return valid;
}

/** One synthetic partner: inserted at `at`; `order` breaks a position tie as PHP's loop order did. */
interface Insertion {
	at: number;
	order: number;
	tag: string;
}

/**
 * The synthetic partners of the unpaired marks. PHP repaired missing-IN first
 * (before each close) and missing-OUT second (after each open), on the text the
 * first loop had already grown — so at a shared position the synthetic CLOSE
 * (inserted right after an open) ends up first.
 */
function pairRepairs(ins: readonly ParsedTag[], outs: readonly ParsedTag[]): Insertion[] {
	const inKeys = new Set(ins.map((tag) => idKey(tag.id)));
	const outKeys = new Set(outs.map((tag) => idKey(tag.id)));
	const insertions: Insertion[] = [];
	for (const out of outs) {
		if (inKeys.has(idKey(out.id))) continue;
		insertions.push({
			at: out.start,
			order: 1,
			tag: buildIndexTag('in', 'd', out.id, out.label, out.data),
		});
	}
	for (const open of ins) {
		if (outKeys.has(idKey(open.id))) continue;
		insertions.push({
			at: open.end,
			order: 0,
			tag: buildIndexTag('out', 'd', open.id, open.label, open.data),
		});
	}
	return insertions.sort((a, b) => a.at - b.at || a.order - b.order);
}

function applyInsertions(text: string, insertions: readonly Insertion[]): string {
	let result = '';
	let cursor = 0;
	for (const insertion of insertions) {
		result += text.slice(cursor, insertion.at) + insertion.tag;
		cursor = insertion.at;
	}
	return result + text.slice(cursor);
}

/** The prefix of orphan tags: each new one goes IN FRONT of the previous (PHP prepend). */
function orphanPrefix(
	locatorIds: readonly string[],
	textIds: readonly string[],
	build: (id: string) => string,
): { prefix: string; count: number } {
	const present = new Set(textIds.map(idKey));
	let prefix = '';
	let count = 0;
	for (const id of validLocatorIds(locatorIds)) {
		if (present.has(idKey(id))) continue;
		prefix = build(id) + prefix;
		count++;
	}
	return { prefix, count };
}

const orphanIndexPair = (id: string): string =>
	buildIndexTag('in', 'd', id, '', '') + buildIndexTag('out', 'd', id, '', '');

const orphanDraw = (id: string): string => buildDrawTag('d', id, `${id}:`, '');

/**
 * Repair one stored transcription text against the tag ids of its host
 * record's `tags_index` / `tags_draw` locators (see the module doc).
 */
export function repairBrokenTags(
	rawText: string,
	indexTagIds: readonly string[],
	drawTagIds: readonly string[],
): TagRepair {
	const tails: TailIndex = {
		closes: positionsOf(rawText, DATA_CLOSE),
		newlines: positionsOf(rawText, '\n'),
	};
	const ins = scanFamily(rawText, 'indexIn', tails);
	const outs = scanFamily(rawText, 'indexOut', tails);
	const insertions = pairRepairs(ins, outs);
	const indexIds = [...ins, ...outs].map((tag) => tag.id);
	const index = orphanPrefix(indexTagIds, indexIds, orphanIndexPair);
	const drawIds =
		drawTagIds.length === 0 ? [] : scanFamily(rawText, 'draw', tails).map((tag) => tag.id);
	const draw = orphanPrefix(drawTagIds, drawIds, orphanDraw);
	if (insertions.length === 0 && index.count === 0 && draw.count === 0) {
		return { text: rawText, changedTags: 0, addedTags: 0 };
	}
	return {
		text: draw.prefix + index.prefix + applyInsertions(rawText, insertions),
		changedTags: insertions.length,
		addedTags: index.count + draw.count,
	};
}
