/**
 * THE INTERACTIVE INSTALLER'S PROMPTER CONTRACT (terminal installer phase 3,
 * 2026-10-12) — what the ONE walker (install_session.ts) asks of a front end,
 * and the answer rules every front end shares. Two implementations: the plain
 * line mode (ui_plain/prompter.ts) and the full-screen UI (ui/prompter.ts).
 * Neither decides anything the model does not: the options, defaults, errors
 * and locks all come from the question (screen_model.ts).
 *
 * WHAT LIVES HERE (moved from ui_plain/prompter.ts, so the full-screen UI
 * never imports the plain mode):
 *  - the navigation answers (`back`, `quit`, and the full-screen UI's
 *    `field_back` — Shift-Tab: the previous question of the screen);
 *  - the shared answer rules: what an empty answer takes (suggested), when
 *    `-` empties a field, why a hidden entry is refused, a confirm's default,
 *    and THE secret entry flow (secretEntryStep: refused / policy / twice /
 *    three mismatches) — one rule set, two renderings;
 *  - the structured views the walker hands a prompter (ScreenView before every
 *    ask; Welcome, Resume, Probe and Review views) so a front end draws buttons
 *    and key bindings without parsing prompt text.
 *
 * Plain data and pure functions: no terminal, no config, no OpenTUI.
 */

import { hasIllegalControlCharacter, type InstallRoute } from './install_plan.ts';
import type { Question, ReviewLine, Screen, ScreenId } from './screen_model.ts';

// ── navigation ───────────────────────────────────────────────────────────────

/** A navigation answer: the previous screen, leave, or (full-screen) the previous question. */
export type Nav = { readonly nav: 'back' | 'quit' | 'field_back' };
export const BACK: Nav = Object.freeze({ nav: 'back' });
export const QUIT: Nav = Object.freeze({ nav: 'quit' });
/** Shift-Tab in the full-screen UI: ask the previous question of this screen (first one: BACK). */
export const FIELD_BACK: Nav = Object.freeze({ nav: 'field_back' });

export function isNav(value: unknown): value is Nav {
	return value === BACK || value === QUIT || value === FIELD_BACK;
}

/** `back` / `quit` typed as an answer (the plain mode's words). */
export function navOf(answer: string): Nav | null {
	const word = answer.trim().toLowerCase();
	return word === 'back' ? BACK : word === 'quit' ? QUIT : null;
}

// ── aborts ───────────────────────────────────────────────────────────────────

/** The operator aborted a question (Ctrl-C, Ctrl-D, SIGINT). */
export class Aborted extends Error {}

/** Three hidden entries that never matched: the session ends as REFUSED, not interrupted. */
export class EntriesNeverMatched extends Aborted {}

// ── the shared answer rules ──────────────────────────────────────────────────

/** The root password's live verdict (screen_model.ts passwordFeedback). */
export type PasswordFeedback = (password: string) => {
	rules: { id: string; text: string; ok: boolean }[];
	errors: string[];
};

/** Secrets: how many mismatching pairs before the question is aborted. */
export const SECRET_ATTEMPTS = 3;

/** A default as shown (a list joined by commas). */
export function shownDefault(value: unknown): string {
	if (value === null || value === undefined) return '';
	return Array.isArray(value) ? value.join(',') : String(value);
}

/**
 * What an empty answer takes: the current value (an edit re-asks with it) — or,
 * when the model refuses that value, the plan's default (never offer back an
 * answer that is refused).
 */
export function suggested(question: Question): string {
	return question.errors.length > 0
		? shownDefault(question.default)
		: shownDefault(question.value ?? question.default);
}

/** A typed text answer (no nav): empty takes `fallback`, `-` empties an optional field. */
export function textAnswerOf(answer: string, question: Question, fallback: string): string {
	if (answer === '-' && question.emptyAllowed === true) return '';
	return answer === '' ? fallback : answer;
}

/** Why one hidden entry is refused, or null. */
export function entryRefusal(entry: string, question: Question): string | null {
	if (hasIllegalControlCharacter(entry))
		return 'a line break or NUL cannot be part of it; type it again';
	return entry === '' && question.emptyAllowed !== true ? 'it cannot be empty; type it' : null;
}

/** A confirm's default: the current value (or the default when unanswered). */
export function confirmDefault(question: Question): boolean {
	return (question.value ?? question.default) === true;
}

// ── the secret entry flow ────────────────────────────────────────────────────

/** Between two hidden entries: the accepted first one, and the mismatches so far. */
export interface SecretEntryState {
	first: string | null;
	mismatches: number;
}

/** What one hidden entry did (the front end renders it; the rule is here). */
export type SecretStep =
	| { kind: 'refused'; message: string }
	| { kind: 'policy'; message: string }
	| { kind: 'again' }
	| { kind: 'mismatch'; message: string }
	| { kind: 'never_matched'; message: string }
	| { kind: 'done'; value: string };

export const SECRET_TEXT = Object.freeze({
	policy: 'the password does not meet the policy; type another',
	mismatch: 'the two entries differ; type it again',
	neverMatched: `the entries did not match ${SECRET_ATTEMPTS} times`,
});

export function newSecretEntry(): SecretEntryState {
	return { first: null, mismatches: 0 };
}

/**
 * How a secret is entered. `confirm` (the default) asks the entry twice — a new
 * password set on the fresh install, where a typo would lock the operator out.
 * `confirm: false` takes ONE entry: a password the install already holds (a
 * resume's root password), where the second entry only repeats what was typed.
 * The refusals and the policy apply either way.
 */
export interface SecretOptions {
	readonly confirm: boolean;
}

/** The FIRST entry: refused (control character, empty), held to the policy, '' accepted when allowed. */
function firstEntryStep(
	state: SecretEntryState,
	entry: string,
	question: Question,
	feedback: PasswordFeedback | undefined,
	confirm: boolean,
): SecretStep {
	const refusal = entryRefusal(entry, question);
	if (refusal !== null) return { kind: 'refused', message: refusal };
	if (feedback !== undefined && feedback(entry).errors.length > 0) {
		return { kind: 'policy', message: SECRET_TEXT.policy };
	}
	if (entry === '' || !confirm) return { kind: 'done', value: entry };
	state.first = entry;
	return { kind: 'again' };
}

/** The SECOND entry: equal = done; else a mismatch (SECRET_ATTEMPTS of them refuse). */
function secondEntryStep(state: SecretEntryState, entry: string, first: string): SecretStep {
	state.first = null;
	if (entry === first) return { kind: 'done', value: entry };
	state.mismatches += 1;
	return state.mismatches >= SECRET_ATTEMPTS
		? { kind: 'never_matched', message: SECRET_TEXT.neverMatched }
		: { kind: 'mismatch', message: SECRET_TEXT.mismatch };
}

/**
 * THE secret entry rule — one hidden entry applied: a first entry is refused
 * (CR/LF/NUL, empty when not allowed) or held to the policy (`feedback`, the
 * root password) or accepted ('' returns at once when allowed); the second
 * must equal it; SECRET_ATTEMPTS mismatching pairs end the question
 * (`never_matched`). The value is never part of a message.
 */
export function secretEntryStep(
	state: SecretEntryState,
	entry: string,
	question: Question,
	feedback: PasswordFeedback | undefined,
	confirm = true,
): SecretStep {
	return state.first === null
		? firstEntryStep(state, entry, question, feedback, confirm)
		: secondEntryStep(state, entry, state.first);
}

// ── the views ────────────────────────────────────────────────────────────────

/** One screen of the route, as a progress rail shows it. */
export interface RouteScreen {
	id: ScreenId;
	title: string;
	index: number;
	/** A placeholder (phase-4 host step): shown once, nothing to answer. */
	placeholder: boolean;
}

/**
 * What the walker is doing NOW — sent before every ask (and while a probe
 * runs): the screen as the model rebuilt it (current values, visibility,
 * errors), the route's screens, the ones shown so far, the question about to
 * be asked. The plain mode ignores it (its transcript is the questions).
 */
export interface ScreenView {
	screen: Screen;
	screens: readonly RouteScreen[];
	seen: readonly ScreenId[];
	/**
	 * The seen screens whose check FAILED and was not kept untested — the rail
	 * marks them failed, never done (campaign 3b N34). Absent: none.
	 */
	failed?: readonly ScreenId[];
	/** The question id about to be asked; null while probing or between questions. */
	focus: string | null;
	probing: boolean;
	route: InstallRoute | null;
}

export interface WelcomeView {
	version: string;
}

export interface ResumeView {
	database: string;
	outcome: string;
	canAbort: boolean;
}

export type ProbeCommand = 'retry' | 'edit' | 'yes' | 'quit';

/** A failed probe: its verdict lines and what the operator may do. */
export interface ProbeView {
	screen: Screen;
	lines: readonly string[];
	gate: NonNullable<Screen['probe']>['gate'];
	commands: readonly ProbeCommand[];
	/** The plain mode's prompt (the same words the commands are typed as). */
	prompt: string;
	/**
	 * A check that asks nothing (the System check): the screen `edit` goes
	 * back to — the one whose answers it checked (campaign 3e E1).
	 */
	editGoesTo?: string;
}

/** The Review: what the install will do, and what the operator may do with it. */
export interface ReviewView {
	screen: Screen;
	lines: readonly ReviewLine[];
	canInstall: boolean;
	/** The screens `edit <n>` re-asks. */
	editable: readonly { n: number; title: string }[];
	/** The equivalent command line (never a secret). */
	command: string;
	/** The plan's refusals (why install is not offered). */
	errors: readonly string[];
	/**
	 * A host route's commands, per host step, exactly as the run will execute
	 * them (phase 4: review equals run); [] on the developer route.
	 */
	hostCommands?: readonly { step: string; label: string; commands: readonly string[] }[];
}

// ── the prompter ─────────────────────────────────────────────────────────────

export interface InstallPrompter {
	/** A real terminal (or a script that plays one). */
	readonly interactive: boolean;
	/** The walker's state before an ask (full-screen: redraw; plain: nothing). */
	view(view: ScreenView): void;
	/** A screen's header, description, notices, placeholder and help (once per screen run). */
	screen(screen: Screen): void;
	say(lines: readonly string[]): void;
	/** The opening screen: null = begin, QUIT = leave before any question. */
	welcome(view: WelcomeView): Promise<Nav | null>;
	/** An unfinished install found on start. */
	resume(view: ResumeView): Promise<'resume' | 'abort' | Nav>;
	text(question: Question): Promise<string | Nav>;
	choice(question: Question): Promise<string | Nav>;
	multi(question: Question): Promise<string[] | Nav>;
	secret(
		question: Question,
		feedback?: PasswordFeedback,
		options?: SecretOptions,
	): Promise<string | Nav>;
	confirm(question: Question): Promise<boolean | Nav>;
	acknowledge(question: Question): Promise<boolean | Nav>;
	/** A failed probe's next step: one of `view.commands` (an unknown word is explained by the walker). */
	probe(view: ProbeView): Promise<string | Nav>;
	/** The Review's command: `install`, `edit <n>`, `write <path>`, `quit`. */
	review(view: ReviewView): Promise<string | Nav>;
	/** A generated secret, shown once — only on a terminal; answers whether it reached one. */
	showOnce(lines: readonly string[]): boolean;
	/**
	 * Why the prompter itself ended the session, when it did: `interrupted`
	 * (Ctrl-C, Ctrl-D, SIGINT) or `refused` (secret entries that never matched);
	 * null when every QUIT it answered was chosen.
	 */
	stopReason?(): 'interrupted' | 'refused' | null;
}
