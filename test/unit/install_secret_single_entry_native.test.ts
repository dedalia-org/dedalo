/**
 * The secret entry rule with ONE entry (`confirm: false`, a resume's root
 * password): no second entry is asked, but the refusals and the policy still
 * apply, and the fresh-install default (`confirm` on) still asks twice.
 */
import { describe, expect, test } from 'bun:test';
import {
	newSecretEntry,
	type PasswordFeedback,
	secretEntryStep,
} from '../../src/core/install/prompter_contract.ts';
import type { Question } from '../../src/core/install/screen_model.ts';

const QUESTION = {
	id: 'secret.root_password',
	key: 'root_password',
	emptyAllowed: false,
} as unknown as Question;
const OPEN_FEEDBACK: PasswordFeedback = () => ({ errors: [], rules: [] }) as never;
const STRICT_FEEDBACK: PasswordFeedback = () => ({ errors: ['too short'], rules: [] }) as never;

describe('secret entry, one entry (confirm: false)', () => {
	test('a valid first entry is the value at once — no second entry', () => {
		const state = newSecretEntry();
		const step = secretEntryStep(state, 'Secret-Pass-1', QUESTION, OPEN_FEEDBACK, false);
		expect(step).toEqual({ kind: 'done', value: 'Secret-Pass-1' });
		expect(state.first).toBeNull();
	});

	test('a control character is still refused', () => {
		const step = secretEntryStep(newSecretEntry(), 'bad\nvalue', QUESTION, OPEN_FEEDBACK, false);
		expect(step.kind).toBe('refused');
	});

	test('an empty entry is still refused when the question does not allow it', () => {
		const step = secretEntryStep(newSecretEntry(), '', QUESTION, OPEN_FEEDBACK, false);
		expect(step.kind).toBe('refused');
	});

	test('the policy still applies to the one entry', () => {
		const step = secretEntryStep(newSecretEntry(), 'x', QUESTION, STRICT_FEEDBACK, false);
		expect(step.kind).toBe('policy');
	});
});

describe('secret entry, two entries (default — a fresh install)', () => {
	test('the first entry asks for the second, which must match', () => {
		const state = newSecretEntry();
		expect(secretEntryStep(state, 'Secret-Pass-1', QUESTION, OPEN_FEEDBACK).kind).toBe('again');
		expect(secretEntryStep(state, 'Secret-Pass-1', QUESTION, OPEN_FEEDBACK).kind).toBe('done');
	});

	test('a mismatch is refused, not accepted', () => {
		const state = newSecretEntry();
		secretEntryStep(state, 'Secret-Pass-1', QUESTION, OPEN_FEEDBACK);
		expect(secretEntryStep(state, 'Secret-Pass-2', QUESTION, OPEN_FEEDBACK).kind).toBe('mismatch');
	});
});
