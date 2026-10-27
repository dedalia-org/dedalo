/**
 * A SECRET QUESTION (terminal installer phase 3, 2026-10-12) — typed twice,
 * shown as `•` only. The value lives ONLY in this closure: it is never set on
 * a renderable, an input or an edit buffer (the frame holds dots), and the
 * entry rules are THE shared ones (prompter_contract.ts secretEntryStep): a
 * refused entry, the policy, three mismatching pairs (the session ends as
 * `refused` — `onRefused`). With `feedback` (the root password) the policy's
 * rules are listed live, ✓/✗ — never the value.
 */

import {
	BACK,
	FIELD_BACK,
	type Nav,
	newSecretEntry,
	type PasswordFeedback,
	QUIT,
	type SecretStep,
	secretEntryStep,
} from '../../prompter_contract.ts';
import type { Question } from '../../screen_model.ts';
import { type Line, seg } from '../styled.ts';
import { editKey, editOf, type FieldEdit, pasteInto } from '../view_state.ts';
import type { DrawContext, Widget } from '../widget.ts';
import { boxWidth, descriptionLines, FIELD_KEYS, labelSeg, valueBox } from './field_parts.ts';

/** What the field says after an entry (the step's own words; `again` asks to repeat). */
function stepMessage(step: SecretStep): string | null {
	if (step.kind === 'again') return 'type it again to confirm';
	return 'message' in step ? step.message : null;
}

/**
 * The policy's rules for the text typed so far (first entry only). Before the
 * first key they are listed NEUTRAL (`·`): an empty field has broken no rule
 * yet (campaign 3 C3-58 — never `✗ Does not contain …` on an untouched field).
 */
function ruleLines(feedback: PasswordFeedback | undefined, typed: string): Line[] {
	if (feedback === undefined) return [];
	return feedback(typed).rules.map((rule) => [
		ruleMark(typed, rule.ok),
		seg(rule.text, ruleRole(typed, rule.ok)),
	]);
}

/** A rule's mark: neutral before anything is typed, then ✓ / ✗. */
function ruleMark(typed: string, ok: boolean): Line[number] {
	if (typed === '') return seg('  · ', 'faint');
	return ok ? seg('  ✓ ', 'ok') : seg('  ✗ ', 'err');
}

/** A rule's text role: muted when untouched or kept, plain while still broken. */
function ruleRole(typed: string, ok: boolean): 'muted' | 'text' {
	return typed === '' || ok ? 'muted' : 'text';
}

export function secretField(
	question: Question,
	feedback: PasswordFeedback | undefined,
	done: (answer: string | Nav) => void,
	onRefused: () => void,
	confirm = true,
): Widget {
	const state = newSecretEntry();
	let edit: FieldEdit = editOf('');
	let message: string | null = null;
	const typed = (): string => edit.chars.join('');
	const enter = (): void => {
		const step = secretEntryStep(state, typed(), question, feedback, confirm);
		edit = editOf('');
		message = stepMessage(step);
		if (step.kind === 'done') done(step.value);
		if (step.kind === 'never_matched') {
			onRefused();
			done(QUIT);
		}
	};
	const NAV: Readonly<Record<string, () => void>> = {
		enter,
		tab: enter,
		'shift-tab': () => done(FIELD_BACK),
		esc: () => done(BACK),
	};
	return {
		id: question.id,
		kind: 'secret',
		editing: true,
		placement: 'field',
		title: question.label,
		label: question.label,
		description: question.description,
		lines: (ctx: DrawContext) => {
			const description = descriptionLines(question, ctx.width, ctx.layout.descLines);
			const label = state.first === null ? question.label : `${question.label} again`;
			const dots = '•'.repeat(edit.chars.length);
			const row = [labelSeg(label, 'accent'), ...valueBox(dots, edit.caret, boxWidth(ctx.width))];
			const rules = state.first === null ? ruleLines(feedback, typed()) : [];
			const said = message === null ? [] : [[seg(`  ${message}`, 'warn')]];
			return { lines: [...description, row, ...rules, ...said], focus: description.length };
		},
		keys: () => FIELD_KEYS,
		onKey: (name: string) => {
			const nav = NAV[name];
			if (nav !== undefined) return nav();
			edit = editKey(edit, name) ?? edit;
		},
		onPaste: (text: string) => {
			edit = pasteInto(edit, text);
		},
		pending: () => ({
			id: question.id,
			kind: 'secret',
			phase: state.first === null ? 'first' : 'again',
		}),
	};
}
