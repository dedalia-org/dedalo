/**
 * The pieces every field widget draws (terminal installer phase 3,
 * 2026-10-12): the label column, the value box with its caret, a question's
 * description (wrapped), its errors and hint, and the footer hints a field
 * shares. Every model string is sanitized here before it becomes a segment.
 */

import { sanitizeLine, wrap } from '../../display_text.ts';
import type { Question } from '../../screen_model.ts';
import type { Role } from '../palette.ts';
import { cutText, type Line, seg, selectedLine, spread, widthOf } from '../styled.ts';
import type { KeyHint } from '../widget.ts';

export const LABEL_WIDTH = 18;

/** The value box's width at a pane width. */
export function boxWidth(paneWidth: number): number {
	return Math.max(8, Math.min(34, paneWidth - LABEL_WIDTH - 4));
}

/** The label column (muted, padded, cut). */
export function labelSeg(label: string, role: Role = 'muted'): Line[number] {
	const text = cutText(sanitizeLine(label), LABEL_WIDTH - 1);
	return seg(`${text}${' '.repeat(Math.max(0, LABEL_WIDTH - widthOf(text)))}`, role);
}

/**
 * A focused value box: the visible tail of `text` (so the caret stays in
 * view), the caret `▏` at `caret`, padded on the selection background — in
 * `role` (`faint` for a default not yet typed over).
 */
export function valueBox(text: string, caret: number, width: number, role: Role = 'text'): Line {
	const chars = Array.from(text);
	// The box is ` ` + `room` cells of text + the caret cell. With the caret at
	// the END, `room` characters fit before it (campaign C4 S4: one fewer dropped
	// the leading `/` of a 32-character default that fitted exactly); with text
	// after it, one cell stays for that text's `…`, or the row overflows.
	const room = width - 2;
	const start = Math.max(0, caret - (caret < chars.length ? room - 1 : room));
	const before = chars.slice(start, caret).join('');
	const after = cutText(chars.slice(caret).join(''), Math.max(0, room - widthOf(before)));
	const fill = Math.max(0, room - widthOf(before) - widthOf(after));
	return [
		seg(` ${before}`, role, { sel: true }),
		seg('▏', 'accent', { sel: true }),
		seg(`${after}${' '.repeat(fill)}`, role, { sel: true }),
	];
}

/** `text` wrapped to `width` as lines of one role (sanitized). */
export function wrapped(text: string, width: number, role: Role, indent = ''): Line[] {
	return wrap(sanitizeLine(text), Math.max(10, width - indent.length)).map((line) => [
		seg(`${indent}${line}`, role),
	]);
}

/** A question's description, at most `max` lines (the rest is in the help overlay). */
export function descriptionLines(question: Question, width: number, max: number): Line[] {
	const lines = wrapped(question.description, width, 'muted');
	if (lines.length <= max) return lines;
	const kept = lines.slice(0, max);
	const last = kept[max - 1] as Line;
	kept[max - 1] = [
		seg(cutText(`${last[0]?.text ?? ''} …`, width - 8), 'muted'),
		seg('  F1 more', 'faint'),
	];
	return kept;
}

/** The model's errors (once answered) and its hint, under a field. */
export function errorLines(question: Question, width: number): Line[] {
	const errors = question.answered ? question.errors : [];
	return [
		...errors.flatMap((error) => wrapped(`✗ ${error}`, width, 'err', '  ')),
		...(question.hint === undefined ? [] : wrapped(question.hint, width, 'faint', '  ')),
	];
}

/** The hints every field shows (priority order: the footer keeps the first ones that fit). */
export const FIELD_KEYS: readonly KeyHint[] = [
	['enter', 'continue'],
	['shift+tab', 'previous'],
	['esc', 'back'],
	['F1', 'help'],
	['ctrl+q', 'quit'],
];

/** The row pointer: `❯ ` on the focused row. */
export function pointer(focused: boolean): Line[number] {
	return seg(focused ? '❯ ' : '  ', 'accent');
}

/** A row with a badge right-aligned (none when empty), on the selection when focused. */
export function badgedRow(
	left: Line,
	badge: string,
	role: Role,
	focused: boolean,
	width: number,
): Line {
	const clean = sanitizeLine(badge);
	const line = spread(left, clean === '' ? [] : [seg(clean, role)], width);
	return focused ? selectedLine(line, width) : line;
}

/** What a selected / unselected thing reads in. */
export function onRole(on: boolean, onRole: Role, offRole: Role): Role {
	return on ? onRole : offRole;
}
