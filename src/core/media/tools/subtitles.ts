/**
 * SUBTITLES BUILDER — pure port of PHP shared/class.subtitles.php
 * (build_subtitles_text + its helper chain) producing a WEBVTT document from a
 * TC-tagged transcript. String → string; no I/O, no config, no request state.
 * Consumed by tool_transcription::build_subtitles_file (which handles the read,
 * the AV duration and the file write).
 *
 * PHP statics (subtitles::$maxCharLine / ::$charTime) become an explicit
 * SubtitleContext threaded through the helpers — module-level mutable state is
 * banned (module_state_tripwire).
 *
 * Ported faithfully INCLUDING PHP quirks (each marked at its site):
 *  - html_entity_decode is called with its return value DISCARDED (a PHP no-op)
 *    → not decoded here either;
 *  - str_replace('\n\n','\n') in the cue loop operates on the LITERAL
 *    backslash-n sequence (single-quoted PHP string), not on newlines;
 *  - TC2seg accepts full [TC_…_TC] tags because its value regex is unanchored
 *    (the PHP strpos guard has its arguments swapped and never fires).
 *
 * Documented divergences (guards against PHP fatals/hangs, not behavior):
 *  - a line chunk with no breakable space (mb_strrpos false / space at pos 0)
 *    would TypeError or loop forever in PHP; we take the whole chunk instead;
 *  - multi-byte ops use JS code-point semantics ([...str]) which match PHP
 *    mb_* for everything up to (and including) astral-plane characters.
 *
 * Unported PHP options (never reachable from build_subtitles_file, which sends
 * only sourceText/maxCharLine/total_ms): sourceText_unrestricted, type ('srt'
 * is dead — output is always WEBVTT), show_debug, advice_text_subtitles_title,
 * tc_in_secs/tc_out_secs (build_fragment).
 */

import { stripTagsExcept } from '../../resolve/html_text.ts';
import { secondsToTc, tcToSeconds } from '../../resolve/tr_marks.ts';

// ---------------------------------------------------------------------------
// context (PHP class statics)
// ---------------------------------------------------------------------------

interface SubtitleContext {
	/** Max chars per subtitle line (PHP subtitles::$maxCharLine, default 144). */
	maxCharLine: number;
	/** Global seconds-per-character (PHP subtitles::$charTime). */
	charTime: number;
}

// ---------------------------------------------------------------------------
// text cleaning (PHP clean_text_for_subtitles + TR::deleteMarks(deleteTC=false))
// ---------------------------------------------------------------------------

/**
 * TR::deleteMarks patterns for deleteTC=false — every mark family EXCEPT the
 * timecode tags (index, svg, draw, geo, page, person, note, reference, lang).
 * Twin of resolve/tr_marks.ts DELETE_PATTERNS (which is file-private and
 * includes TC); duplicated here rather than widening that module's surface.
 */
const NON_TC_MARK_PATTERNS: readonly RegExp[] = [
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

/**
 * PHP subtitles::clean_text_for_subtitles — strip html except <br><strong><em>,
 * normalize strong/em to b/i, unify nbsp to space, delete every non-TC mark.
 * (PHP calls html_entity_decode without using the result — preserved as no-op.)
 */
export function cleanTextForSubtitles(text: string): string {
	// strip_tags($string, '<br><strong><em>') — remove all other tags (linear:
	// the regex form is O(n²) on a run of unclosed `<`, CodeQL #7958).
	let out = stripTagsExcept(text, ['br', 'strong', 'em']);
	out = out.replaceAll('<br />', ' ');
	out = out.replaceAll('<strong>', '<b>').replaceAll('</strong>', '</b>');
	out = out.replaceAll('<em>', '<i>').replaceAll('</em>', '</i>');
	// unify spaces: '&nbsp;' + the UTF-8 non-break space (PHP "\xc2\xa0" and
	// the ~\x{00a0}~ regex both target U+00A0).
	out = out.replace(/&nbsp;| /g, ' ');
	for (const pattern of NON_TC_MARK_PATTERNS) {
		out = out.replace(pattern, '');
	}
	return out;
}

// ---------------------------------------------------------------------------
// small helpers (PHP text_lenght / trim_text / truncate_text / revise_tag_in_line)
// ---------------------------------------------------------------------------

/** PHP subtitles::text_lenght — mb_strlen (code points, not UTF-16 units). */
export function textLength(text: string): number {
	return [...text].length;
}

/** PHP subtitles::trim_text — strip ONE leading and ONE trailing \r|\n, then trim. */
export function trimText(text: string | null | undefined): string {
	if (text === null || text === undefined || text === '') return '';
	let out = text;
	const first = out.slice(0, 1);
	if (first === '\r' || first === '\n') out = out.slice(1);
	const last = out.slice(-1);
	if (last === '\r' || last === '\n') out = out.slice(0, -1);
	return out.trim();
}

/** PHP subtitles::truncate_text — multi-byte truncate at the last `brk` before `limit`. */
export function truncateText(text: string, limit: number, brk = ' ', pad = '...'): string {
	if (text === '') return '';
	// PHP: float limits round (45.5 → 46).
	const limitInt = Number.isInteger(limit) ? limit : Math.round(limit);
	if (textLength(text) <= limitInt) return text;
	const chars = [...text];
	const cutChars = chars.slice(0, limitInt);
	let cut = cutChars.join('');
	// Break on the last `brk` BEFORE the limit, code-point indexed (PHP
	// mb_strrpos). Both the search and the slice run on the code-point array so
	// an astral char (emoji) before the break can't skew the cut point — a
	// String.lastIndexOf here returns a UTF-16 index that mis-slices [...cut].
	const breakpoint = cutChars.lastIndexOf(brk);
	if (breakpoint !== -1) {
		cut = cutChars.slice(0, breakpoint).join('');
	}
	return cut + pad;
}

/** Count non-overlapping occurrences of `needle` (PHP substr_count). */
function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

/**
 * PHP subtitles::revise_tag_in_line — normalize a line's <b>/<i> tag pairing:
 * drop empty/adjacent pairs, then balance opens/closes by appending closers or
 * prepending openers.
 */
export function reviseTagInLine(line: string, tagName: string): string {
	const open = `<${tagName}>`;
	const close = `</${tagName}>`;
	let out = line;
	out = out.replaceAll(`${close}${open}`, '');
	out = out.replaceAll(`${close} ${open}`, ' ');
	out = out.replaceAll(`${open}${close}`, '');
	out = out.replaceAll(`${open} ${close}`, ' ');

	const openCount = countOccurrences(out, open);
	const closeCount = countOccurrences(out, close);
	if (openCount > closeCount) {
		out += close.repeat(openCount - closeCount);
	} else if (closeCount > openCount) {
		out = open.repeat(closeCount - openCount) + out;
	}
	return out;
}

// ---------------------------------------------------------------------------
// timing (PHP calculate_global_char_time)
// ---------------------------------------------------------------------------

/**
 * PHP subtitles::calculate_global_char_time — seconds each character "lasts":
 * total_ms / n_chars / 1000. Zero when either input is empty/zero.
 */
export function calculateGlobalCharTime(sourceText: string, totalMs: number | null): number {
	const nChar = textLength(sourceText);
	if (totalMs !== null && totalMs > 0 && nChar > 0) {
		return totalMs / nChar / 1000;
	}
	return 0;
}

// ---------------------------------------------------------------------------
// line building (PHP get_ar_lines + fragment_split)
// ---------------------------------------------------------------------------

/** PHP get_ar_lines tc splitter — modern [TC_h:m:s.mmm_TC] plus legacy no-ms tags. */
const TC_SPLIT_PATTERN =
	/(\[TC_[0-9]{1,2}:[0-9]{1,2}:[0-9]{1,2}\.[0-9]{1,3}_TC\]|\[TC_[0-9]{1,2}:[0-9]{1,2}:[0-9]{1,2}_TC\])/;

export interface SubtitleLine {
	text: string;
	/** Timecode VALUE like '00:00:03.000' (PHP ar_lines[n]['tcin']). */
	tcin: string;
}

/**
 * PHP subtitles::fragment_split — break one TC-delimited fragment into
 * maxCharLine-bounded lines, interpolating each line's tcin from the fragment's
 * own duration (chars × seconds-per-char), carrying <b>/<i> continuity across
 * lines. `tcin`/`tcout` are the surrounding FULL tags (or null at the edges).
 */
export function fragmentSplit(
	text: string,
	tcin: string | null,
	tcout: string | null,
	ctx: SubtitleContext,
): SubtitleLine[] {
	if (text === '') return [];

	let addB = '';
	let addI = '';
	let isLastLine = false;
	const lines: SubtitleLine[] = [];
	let refPos = 0;
	let offsetSecs = tcToSeconds(tcin ?? '');
	// DOS-02 (2026-07-28 audit): maxCharLine is UI/config-controlled. At <= 0 the
	// wrap loop below never advances refPos (spacePos collapses to 0) and pushes a
	// line every iteration → infinite loop, unbounded `lines`, process OOM. A
	// subtitle line is at least one character; clamp so the loop always advances.
	const maxCharLine = Math.max(1, Math.floor(Number(ctx.maxCharLine)) || 1);
	let charTime = ctx.charTime;

	// Per-fragment char time when both boundary tags exist (PHP optimization).
	if (tcin !== null && tcin !== '' && tcout !== null && tcout !== '') {
		const duration = tcToSeconds(tcout) - tcToSeconds(tcin);
		if (duration >= 0) {
			// text is non-empty here, so length >= 1 (no divide-by-zero).
			charTime = duration / textLength(text);
			if (charTime < 0) charTime = 0;
		}
		// duration < 0 (tcout before tcin): PHP logs and keeps the global charTime.
	}

	const chars = [...text];
	// Hard progress guard (belt-and-suspenders to the maxCharLine clamp): a wrap
	// can never produce more lines than there are characters, so this bounds the
	// loop regardless of any future edit that lets spacePos reach 0.
	const maxIterations = chars.length + 1;
	let iterations = 0;
	do {
		if (++iterations > maxIterations) break;
		const currentLine = chars.slice(refPos, refPos + maxCharLine);
		const lineLength = currentLine.length;

		let spacePos: number;
		if (lineLength < maxCharLine) {
			spacePos = lineLength;
			isLastLine = true;
		} else {
			spacePos = currentLine.lastIndexOf(' ');
			if (spacePos <= 0) {
				// Divergence (guard): PHP mb_strrpos returns false (or 0) here and
				// the original would TypeError / loop forever on an unbreakable
				// word — we take the whole chunk instead.
				spacePos = lineLength;
			}
		}

		let cut = chars
			.slice(refPos, refPos + spacePos)
			.join('')
			.trim();

		// carry-over of unclosed bold/italics from the previous line
		cut = addI + cut;
		cut = addB + cut;

		// bold continuity across lines
		if (countOccurrences(cut, '<b>') > countOccurrences(cut, '</b>')) {
			cut += '</b>';
			addB = '<b>';
		} else {
			addB = '';
		}
		// italic continuity across lines
		if (countOccurrences(cut, '<i>') > countOccurrences(cut, '</i>')) {
			cut += '</i>';
			addI = '<i>';
		} else {
			addI = '';
		}

		cut = reviseTagInLine(cut, 'b');
		cut = reviseTagInLine(cut, 'i');

		lines.push({ text: cut.trim(), tcin: secondsToTc(offsetSecs) });

		offsetSecs += spacePos * charTime;
		refPos += spacePos;
	} while (isLastLine === false);

	return lines;
}

/**
 * PHP subtitles::get_ar_lines — split the cleaned transcript on TC tags, pair
 * each text fragment with its surrounding tags, and flatten every fragment's
 * fragment_split lines into one ordered list.
 */
export function getArLines(text: string, ctx: SubtitleContext): SubtitleLine[] {
	// preg_split(..., PREG_SPLIT_NO_EMPTY | PREG_SPLIT_DELIM_CAPTURE)
	const fragments = text
		.split(TC_SPLIT_PATTERN)
		.filter((value) => value !== undefined && value !== '');

	const lines: SubtitleLine[] = [];
	for (let index = 0; index < fragments.length; index++) {
		const value = fragments[index] as string;
		if (TC_SPLIT_PATTERN.test(value)) continue; // a tc tag, not a text fragment
		const tcin = fragments[index - 1] ?? null;
		const tcout = fragments[index + 1] ?? null;
		lines.push(...fragmentSplit(value, tcin, tcout, ctx));
	}
	return lines;
}

// ---------------------------------------------------------------------------
// main (PHP build_subtitles_text)
// ---------------------------------------------------------------------------

export interface BuildSubtitlesOptions {
	/** The TC-tagged transcript (mandatory). */
	sourceText: string;
	/** Max chars per subtitle line (mandatory; PHP default 144). */
	maxCharLine: number;
	/** Total media duration in ms (null/0 → zero char time, all cues at their tags). */
	total_ms?: number | null;
}

export interface BuildSubtitlesResult {
	/** The WEBVTT document, or false on invalid input. */
	data: string | false;
	msg: string;
}

/** PHP empty() for the mandatory-vars check ('' / 0 / '0' / null / undefined / false). */
function phpEmpty(value: unknown): boolean {
	return (
		value === undefined ||
		value === null ||
		value === '' ||
		value === 0 ||
		value === '0' ||
		value === false
	);
}

/**
 * PHP subtitles::build_subtitles_text — the WEBVTT builder. Cleans the source,
 * computes the global char time, splits into timed lines, and emits numbered
 * cues (`n\ntcin --> tcout\ntext\n\n`), breaking any line longer than
 * maxCharLine/2 into two display lines. The last cue's tcout is its tcin + 5 s.
 */
export function buildSubtitlesText(options: BuildSubtitlesOptions): BuildSubtitlesResult {
	const response: BuildSubtitlesResult = {
		data: false,
		msg: 'Error. Request failed [build_subtitles_text]',
	};

	// Mandatory vars (PHP ar_mandatory loop — first failure returns).
	const mandatory: [string, unknown][] = [
		['sourceText', options.sourceText],
		['maxCharLine', options.maxCharLine],
	];
	for (const [name, value] of mandatory) {
		if (phpEmpty(value)) {
			response.msg += ` Unable build_subtitles_text. Var '${name}' is mandatory!`;
			return response;
		}
	}

	const maxCharLine = options.maxCharLine;
	const clean = cleanTextForSubtitles(options.sourceText);
	const ctx: SubtitleContext = {
		maxCharLine,
		charTime: calculateGlobalCharTime(clean, options.total_ms ?? null),
	};
	const arLines = getArLines(clean, ctx);

	let srt = '';
	let cueNumber = 1;
	for (let key = 0; key < arLines.length; key++) {
		const line = arLines[key] as SubtitleLine;
		const tcin = line.tcin; // like '00:00:03.000'

		let text = trimText(line.text);
		// force a line break after answers (PHP: '</b>' → "</b>\n")
		text = text.replaceAll('</b>', '</b>\n');
		// PHP quirk preserved: single-quoted '\n\n' is the LITERAL 2-char sequence.
		text = text.replaceAll('\\n\\n', '\\n');
		text = text.replaceAll('  ', ' ');
		text = text.trim();
		text = text.replace(/^(<\/?br>)|(<\/?br>)$/gi, '');

		let textFinal = text;

		// 2 LINES: break into two display lines when longer than half maxCharLine.
		if (textLength(text) > maxCharLine / 2) {
			const subText = truncateText(text, maxCharLine / 2, ' ', '');
			const subText2 = text.replaceAll(subText, '');
			textFinal = `${subText.trim()}\n${subText2.trim()}`;
		}

		// TC_OUT: the next line's tcin, or tcin + 5 s for the last line.
		const nextTcin = arLines[key + 1]?.tcin;
		const tcout =
			nextTcin !== undefined && nextTcin !== ''
				? nextTcin
				: secondsToTc(tcToSeconds(line.tcin) + 5);

		srt += `${cueNumber}\n`;
		srt += `${tcin} --> ${tcout}\n`;
		srt += `${textFinal}\n`;
		srt += '\n';
		cueNumber++;
	}

	response.data = `WEBVTT\n\n${srt}`;
	response.msg = 'OK. Request done [build_subtitles_text]';
	return response;
}
