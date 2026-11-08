/**
 * A CHOICE (terminal installer phase 3, 2026-10-12) — radio rows in the
 * approved mockup's look: `❯` on the cursor, `◉` on the current value, the
 * option's description under it. The cursor starts on what plain mode's Enter
 * would take (`suggested`) — '' too, when '' IS an option (the engine-default
 * media access mode) — else on the model's `start` (nothing chosen yet: the
 * route, on the plan's default route). ↑↓ PgUp PgDn Home End move, Enter or
 * Tab choose.
 */

import { sanitizeLine } from '../../display_text.ts';
import { markWords } from '../../multi_select.ts';
import { BACK, FIELD_BACK, type Nav, suggested } from '../../prompter_contract.ts';
import type { Option, Question } from '../../screen_model.ts';
import { type Line, seg } from '../styled.ts';
import { cursorDelta, moveCursor } from '../view_state.ts';
import type { DrawContext, KeyHint, Widget } from '../widget.ts';
import {
	badgedRow,
	descriptionLines,
	errorLines,
	labelSeg,
	onRole,
	pointer,
	wrapped,
} from './field_parts.ts';

const CHOICE_KEYS: readonly KeyHint[] = [
	['↑↓', 'move'],
	['enter', 'choose'],
	['shift+tab', 'previous'],
	['esc', 'back'],
	['F1', 'help'],
	['ctrl+q', 'quit'],
];

/** An option's label ('' = the engine default's own words). */
function optionLabel(option: Option): string {
	if (option.label !== '') return option.label;
	return option.value === '' ? '(engine default)' : option.value;
}

/** One option's rows: the radio line (badge right), its description indented. */
function optionLines(option: Option, current: boolean, focused: boolean, width: number): Line[] {
	const left: Line = [
		pointer(focused),
		seg(current ? '◉ ' : '○ ', onRole(current, 'accent', 'faint')),
		seg(sanitizeLine(optionLabel(option)), onRole(focused, 'text', 'muted'), { bold: focused }),
	];
	const description = wrapped(option.description, width, 'faint', '    ').filter(
		(line) => (line[0]?.text ?? '').trim() !== '',
	);
	return [badgedRow(left, markWords(option), 'faint', focused, width), ...description];
}

/**
 * Where the cursor starts: on the current value, else on the model's `start`
 * (nothing chosen yet — the route), else on the first option.
 */
function startCursor(options: readonly Option[], current: string, start?: string): number {
	const at = (value: string | undefined): number =>
		options.findIndex((option) => option.value === value);
	const onCurrent = at(current);
	return onCurrent >= 0 ? onCurrent : Math.max(0, at(start));
}

export function choiceField(question: Question, done: (answer: string | Nav) => void): Widget {
	const options = question.options ?? [];
	const current = suggested(question);
	let cursor = startCursor(options, current, question.start);
	const choose = (): void => {
		const option = options[cursor];
		if (option !== undefined) done(option.value);
	};
	const NAV: Readonly<Record<string, () => void>> = {
		enter: choose,
		tab: choose,
		'shift-tab': () => done(FIELD_BACK),
		esc: () => done(BACK),
	};
	return {
		id: question.id,
		kind: 'choice',
		editing: false,
		placement: 'field',
		title: question.label,
		label: question.label,
		description: question.description,
		lines: (ctx: DrawContext) => {
			// The model's refusal of the answer just given, under the label: without it a
			// refused option re-asks with the cursor back on the default and NO word why
			// (campaign C4: Build on a development checkout snapped back to Custom).
			const head = [
				...descriptionLines(question, ctx.width, ctx.layout.descLines),
				[labelSeg(question.label, 'accent')],
				...errorLines(question, ctx.width),
			];
			const rows: Line[] = [];
			let focus = head.length;
			options.forEach((option, index) => {
				if (index === cursor) focus = head.length + rows.length;
				rows.push(...optionLines(option, option.value === current, index === cursor, ctx.width));
			});
			return { lines: [...head, ...rows], focus };
		},
		keys: () => CHOICE_KEYS,
		onKey: (name: string) => {
			const nav = NAV[name];
			if (nav !== undefined) return nav();
			const delta = cursorDelta(name, 5);
			if (delta !== null) cursor = moveCursor(cursor, delta, options.length);
		},
		pending: () => ({
			id: question.id,
			kind: 'choice',
			options: options.map((option) => option.value),
			selected: [current],
			cursor,
		}),
	};
}
