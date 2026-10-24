/**
 * TR mark patterns + timecode/char helpers (PHP shared/class.TR.php,
 * class.OptimizeTC.php) — the exact regexes the tags widget statistics run
 * over transcription text.
 *
 * Tag grammar (Dédalo transcription marks):
 *   [TC_HH:MM:SS.mmm_TC]                      timecode
 *   [index-<state>-<id>(-<label>-data:…:data)] index open  (state n|d|r)
 *   [/index-<state>-<id>…]                     index close
 *   [note-<state>-<id>(-<label>)?-data:…:data] annotation  (state a|b)
 */

import { DedaloError } from '../errors/dedalo_error.ts';
import { decodeHtmlSpecialChars, stripTags } from './html_text.ts';

/** [TC_…_TC] full-tag pattern; group 1 = full tag, group 2 = timecode value. */
export const TC_PATTERN = /\[TC_([0-9]{1,2}:[0-9]{1,2}:[0-9]{1,2}(\.[0-9]{1,3})?)_TC\]/g;

/** indexIn (open tag): groups 1 full, 2 'index', 3 state, 4 id (PHP capture 1-4). */
export const INDEX_IN_PATTERN =
	/(\[(index)-([a-z])-([0-9]{1,6})(-([^-]{0,22})-data:(.*?):data)?\])/g;

/** indexOut (close tag): same group layout as indexIn. */
export const INDEX_OUT_PATTERN =
	/(\[\/(index)-([a-z])-([0-9]{1,6})(-([^-]{0,22})-data:(.*?):data)?\])/g;

/**
 * Tag types deletable BY ID: the paired (open + close) mark families, which are
 * the ones PHP's id-targeted `get_mark_pattern` branches cover with a real UI
 * flow behind them (class.TR.php:52-89). Deliberately NOT the whole grammar —
 * a `markPatternById('note', …)` would strip a note's mark and orphan the note
 * RECORD, and no client asks for that (WC-077).
 */
export const ID_TARGETED_MARK_TYPES = ['index', 'reference'] as const;
export type IdTargetedMarkType = (typeof ID_TARGETED_MARK_TYPES)[number];

/** The id shape the grammar itself defines (RE_INDEX in tag_grammar.ts). */
const TAG_ID_SHAPE = /^[0-9]{1,6}$/;

/**
 * ONE tag's marks, open AND close, any state — the pattern PHP builds for
 * `delete_tag_from_text` (get_mark_pattern($type, standalone, $id, false),
 * class.TR.php:53-54).
 *
 * SECURITY: PHP interpolated `$id` into the regex source RAW. `tagId` here must
 * match the grammar's own numeric id shape and THROWS otherwise — one check
 * that is simultaneously the pattern-injection guard, the ReDoS guard, and the
 * grammar rule. Callers pass client input, so this must never be relaxed into
 * an escape-and-continue.
 */
export function markPatternById(type: IdTargetedMarkType, tagId: string): RegExp {
	if (!ID_TARGETED_MARK_TYPES.includes(type)) {
		throw new DedaloError('request.invalid', {
			message: `markPatternById: tag type '${type}' is not deletable by id`,
			publicMessage: `Only ${ID_TARGETED_MARK_TYPES.join('/')} marks can be deleted by id`,
			coordinates: { tag_type: String(type) },
		});
	}
	if (!TAG_ID_SHAPE.test(tagId)) {
		throw new DedaloError('request.invalid', {
			message: `markPatternById: tag_id '${tagId}' is not a valid tag id (1-6 digits)`,
			publicMessage: 'A tag id must be 1-6 digits',
		});
	}
	return new RegExp(`\\[\\/{0,1}${type}-[a-z]-${tagId}(-[^-]{0,22}-data:.*?:data)?\\]`, 'g');
}

/** index by STATE, open or close (PHP get_mark_pattern('index', true, false, false, state)). */
export function indexStatePattern(state: string): RegExp {
	return new RegExp(
		`\\[\\/{0,1}(index)-${state}-([0-9]{1,6})(-([^-]{0,22})-data:(.*?):data)?\\]`,
		'g',
	);
}

/**
 * note of ANY state, WITH its data payload (PHP get_mark_pattern('note',
 * standalone=true) — the pattern get_annotations scans with).
 * Groups: 1 'note', 2 state, 3 id, 5 label (optional), 6 the JSON payload
 * (PHP's `$matches[7]`, whose delimiting outer paren is a group there).
 */
export const NOTE_PATTERN = /\[(note)-([a-z])-([0-9]{1,6})(-([^-]{0,22}))?-data:(.*?):data\]/g;

/** note by STATE (PHP get_mark_pattern('note', false, false, false, state)). */
export function noteStatePattern(state: string): RegExp {
	return new RegExp(`(\\[(note)-(${state})-([0-9]{1,6})(-([^-]{0,22}))?-data:(.*?):data\\])`, 'g');
}

/** All standalone mark patterns deleteMarks strips before counting chars. */
const DELETE_PATTERNS: RegExp[] = [
	/\[TC_[0-9]{1,2}:[0-9]{1,2}:[0-9]{1,2}(\.[0-9]{1,3})?_TC\]/g,
	/\[\/{0,1}(index)-([a-z])-([0-9]{1,6})(-([^-]{0,22})-data:(.*?):data)?\]/g,
	/\[(svg)-([a-z])-([0-9]{1,6})(-([^-]{0,22}))?-data:(.*?):data\]/g,
	/\[(draw)-([a-z])-([0-9]{1,6})(-([^-]{0,22}))?-data:(.*?):data\]/g,
	/\[(geo)-([a-z])-([0-9]{1,6})(-([^-]{0,22}))?-data:(.*?):data\]/g,
	/\[(page)-([a-z])-([0-9]{1,6})(-([^-]{0,22})-data:(.*?):data)?\]/g,
	/\[(person)-([a-z])-([0-9]{0,6})-([^-]{0,22})-data:(.*?):data\]/g,
	/\[(note)-([a-z])-([0-9]{1,6})(-([^-]{0,22}))?-data:(.*?):data\]/g,
	/\[\/{0,1}(reference)-([a-z])-([0-9]{1,6})(-([^-]{0,22})-data:(.*?):data)?\]/g,
	/\[(lang)-([a-z])-([0-9]{1,6})(-([^-]{0,22}))?-data:(.*?):data\]/g,
];

/** PHP TC2seg: '00:01:25.627' → 85.627 (missing parts default 0). */
export function tcToSeconds(tc: string): number {
	const match = /([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2})(\.([0-9]{1,3}))?/.exec(tc);
	if (match === null) return 0;
	const hours = Number(match[1] ?? 0);
	const minutes = Number(match[2] ?? 0);
	const seconds = Number(match[3] ?? 0);
	const ms = match[5] ?? '0';
	return Number.parseFloat(`${hours * 3600 + minutes * 60 + seconds}.${ms}`);
}

/** PHP seg2tc: 322.342 → '00:05:22.342'. */
export function secondsToTc(seconds: number): string {
	let floor = Math.floor(seconds);
	const hours = floor >= 3600 ? Math.floor(floor / 3600) : 0;
	floor -= hours * 3600;
	const minutes = floor >= 60 ? Math.floor(floor / 60) : 0;
	floor -= minutes * 60;
	const ms = Math.round((seconds - Math.floor(seconds)) * 1000);
	const pad = (value: number, width: number) => String(value).padStart(width, '0');
	return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(floor, 2)}.${pad(ms, 3)}`;
}

/** PHP TR::get_chars_info: strip marks + html, decode entities, count. */
export function charsInfo(rawText: string): { total_chars: number; total_chars_no_spaces: number } {
	let clean = rawText.trim();
	for (const pattern of DELETE_PATTERNS) {
		clean = clean.replace(pattern, '');
	}
	// strip_tags, then htmlspecialchars_decode + &nbsp; → space — ONE pass, so a
	// literal `&amp;lt;` counts as `&lt;` (4 chars), not `<` (CodeQL #7935).
	clean = decodeHtmlSpecialChars(stripTags(clean), { nbsp: ' ' });
	const totalChars = [...clean].length;
	const noSpaces = [...clean.replace(/[ \n]/g, '').replace(/ /g, '')].length;
	return { total_chars: totalChars, total_chars_no_spaces: noSpaces };
}

function matchAll(pattern: RegExp, text: string): RegExpExecArray[] {
	const out: RegExpExecArray[] = [];
	pattern.lastIndex = 0;
	let match = pattern.exec(text);
	while (match !== null) {
		out.push(match);
		match = pattern.exec(text);
	}
	return out;
}

export interface TagStatistics {
	total_tc: number;
	ar_tc_wrong: string[];
	total_index: number;
	total_missing_tags: number;
	total_to_review_tags: number;
	total_private_notes: number;
	total_public_notes: number;
	total_chars: number;
	total_chars_no_spaces: number;
	total_real_chars: number;
}

/**
 * The tags-widget statistics of one transcription text (PHP tags::get_data
 * computation body). Output ids NOT computed by PHP (total_struct,
 * struct_total_missing_tags, struct_total_to_review_tags) resolve to null via
 * the ?? in the caller.
 */
export function tagStatistics(rawText: string): TagStatistics {
	// tc count + wrong-order detection
	const tcMatches = matchAll(TC_PATTERN, rawText);
	const totalTc = tcMatches.length;
	const arTcWrong: string[] = [];
	let previousSeconds: number | null = null;
	for (const match of tcMatches) {
		const value = match[1] ?? '';
		const seconds = tcToSeconds(value);
		if (previousSeconds !== null && seconds < previousSeconds) {
			arTcWrong.push(value);
		}
		previousSeconds = seconds;
	}

	// index tags. (!) PHP's standalone=false patterns are delimited by their
	// OUTER PARENTHESES (PHP preg accepts () as delimiters), so PHP group 2 is
	// the STATE LETTER and group 3 the numeric id — in these JS regexes (where
	// the outer paren IS a group) that is match[3] and match[4] respectively.
	const indexIn = matchAll(INDEX_IN_PATTERN, rawText);
	const indexOut = matchAll(INDEX_OUT_PATTERN, rawText);
	const inStates = indexIn.map((match) => match[3] ?? '');
	const outStates = indexOut.map((match) => match[3] ?? '');
	const inIds = indexIn.map((match) => match[4] ?? '');
	const outIds = indexOut.map((match) => match[4] ?? '');

	// "missing" pairs — PHP compares the STATE lists (its group [2]): an out
	// whose state never opens, an in whose state never closes.
	const missingIn = indexOut.filter((match) => !inStates.includes(match[3] ?? ''));
	const missingOut = indexIn.filter((match) => !outStates.includes(match[3] ?? ''));

	// distinct index ids across in+out (PHP $ckey=3 → the numeric id)
	const distinctIds = new Set([...inIds, ...outIds]);
	const totalIndex = distinctIds.size;

	// deleted (blue) tags: state 'd', open or close, distinct by id
	const deleted = new Set(matchAll(indexStatePattern('d'), rawText).map((match) => match[2] ?? ''));
	const totalMissingTags = missingIn.length + missingOut.length + deleted.size;

	// to-review (red) tags: distinct by capture 1 (PHP quirk: group [1] is the
	// literal 'index' for every match → at most ONE distinct entry)
	const toReview = new Set(
		matchAll(indexStatePattern('r'), rawText).map((match) => match[1] ?? ''),
	);
	const totalToReviewTags = toReview.size;

	// annotations
	const totalPrivateNotes = matchAll(noteStatePattern('a'), rawText).length;
	const totalPublicNotes = matchAll(noteStatePattern('b'), rawText).length;

	const chars = charsInfo(rawText);
	const totalRealChars = [...rawText].length;

	return {
		total_tc: totalTc,
		ar_tc_wrong: arTcWrong,
		total_index: totalIndex,
		total_missing_tags: totalMissingTags,
		total_to_review_tags: totalToReviewTags,
		total_private_notes: totalPrivateNotes,
		total_public_notes: totalPublicNotes,
		total_chars: chars.total_chars,
		total_chars_no_spaces: chars.total_chars_no_spaces,
		total_real_chars: totalRealChars,
	};
}
