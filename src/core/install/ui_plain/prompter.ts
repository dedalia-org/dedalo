/**
 * THE PLAIN MODE'S PROMPTER (terminal installer phase 2, 2026-10-12) — how ONE
 * model question (screen_model.ts Question) is asked on a line terminal. It
 * asks; it never decides: the options, the default, the errors and the locks
 * all come from the question, and the answer goes back through the model's
 * applyAnswer (install_session.ts — the ONE walker; ui/prompter.ts is the
 * full-screen twin of this prompter).
 *
 * THE LINE CONTRACT (installer_reference.md §Plain mode):
 *  - every answer may be `back` (the previous screen) or `quit`; Ctrl-C /
 *    Ctrl-D quit too;
 *  - text/choice: an EMPTY answer takes the shown default — unlike the host
 *    agent's prompter this was copied from (tty.ts: "the default is shown, never
 *    taken"), because every default here is the plan's own and the Review shows
 *    them all again before anything runs; `-` empties an optional field;
 *  - confirm (an on/off toggle): `[y/N]` / `[Y/n]` by the default;
 *  - acknowledge (trial, no thesaurus, a probe override, the install itself):
 *    the word `yes` must be TYPED;
 *  - multi: numbered options in their groups, a page of 20 lines; `3`, `3-7`,
 *    `3 5 9` toggle; a code (`es`) toggles it; `/word` filters, `/` clears;
 *    `list` shows all; `more` pages; enter or `next` finishes; a locked option
 *    says why instead of toggling;
 *  - secret: hidden, entered TWICE, three mismatches abort; an empty entry
 *    re-asks unless the question allows it; a CR/LF/NUL is refused (the .env
 *    line rule); with `feedback` (the root password) each policy rule is
 *    printed as `ok`/`missing` after the first entry and it is re-asked until
 *    the policy passes — never the value. Words, not glyphs (screen readers).
 *
 * Every string printed passes sanitizeLine (no ESC byte ever leaves the plain
 * mode). The prompt SINK is chosen by the caller (front_end.ts selectFrontEnd):
 * stdout, or stderr / /dev/tty when stdout is redirected.
 */

import { reviewCommandText } from '../display_text.ts';
import {
	filtered,
	MULTI_PAGE,
	type MultiOutcome,
	type MultiState,
	markWords,
	multiCommand,
	multiResult,
	multiState,
} from '../multi_select.ts';
import {
	Aborted,
	BACK,
	confirmDefault,
	EntriesNeverMatched,
	entryRefusal,
	FIELD_BACK,
	type InstallPrompter,
	isNav,
	type Nav,
	navOf,
	newSecretEntry,
	type PasswordFeedback,
	QUIT,
	type ResumeView,
	type ReviewView,
	SECRET_ATTEMPTS,
	SECRET_TEXT,
	type SecretStep,
	secretEntryStep,
	suggested,
	textAnswerOf,
} from '../prompter_contract.ts';
import { type Option, type Question, type Screen, stepTotal } from '../screen_model.ts';
import { ACKNOWLEDGE_TEXT } from '../screen_text.ts';
import { showOnceOn } from './reporter.ts';
import { RawReader, readLine, sanitizeLine, type TtyStreams, wrap, wrapWidth } from './terminal.ts';

// The contract and the multi-select moved to UI-neutral modules (phase 3):
// re-exported so the plain mode's callers keep one import.
export {
	BACK,
	FIELD_BACK,
	type InstallPrompter,
	isNav,
	MULTI_PAGE,
	type MultiState,
	markWords,
	multiCommand,
	multiResult,
	multiState,
	type Nav,
	type PasswordFeedback,
	QUIT,
	SECRET_ATTEMPTS,
};

/** One option row: `[x]   3  es  Spain  (ships terms)`. */
function optionRow(number: number, option: Option, selected: boolean): string {
	const marks = markWords(option);
	const box = selected ? '[x]' : '[ ]';
	const tail = `${marks === '' ? '' : `  (${marks})`}${option.locked ? ' locked' : ''}`;
	return `  ${box} ${String(number).padStart(3)}  ${option.value}  ${option.label}${tail}`;
}

/** The rows of a page, each group introduced by its header line. */
function groupedRows(
	slice: readonly { number: number; option: Option }[],
	selected: ReadonlySet<string>,
): string[] {
	const lines: string[] = [];
	let group: string | null = null;
	for (const { number, option } of slice) {
		if (option.group !== group && (option.group ?? '') !== '') lines.push(` ${option.group}`);
		group = option.group;
		lines.push(optionRow(number, option, selected.has(option.value)));
	}
	return lines;
}

/** The status line under a page. */
function statusLine(state: MultiState, shown: number): string {
	const filter =
		state.filter === '' ? '' : ` · filter '${state.filter}' (${shown} shown, / clears)`;
	return `  ${state.selected.size} selected${filter}`;
}

/** The lines of one page of the multi-select (or of every option, `all`). */
export function pageLines(state: MultiState, all: boolean): string[] {
	const rows = filtered(state);
	const start = all ? 0 : state.page * MULTI_PAGE;
	const slice = all ? rows : rows.slice(start, start + MULTI_PAGE);
	const rest = rows.length - (start + slice.length);
	return [
		...groupedRows(slice, state.selected),
		...(rest > 0
			? [`  ... ${rest} more: 'more' for the next page, 'list' for all, /word to filter`]
			: []),
		statusLine(state, rows.length),
	];
}

// ── the terminal prompter ────────────────────────────────────────────────────

/** What every question body uses: the sanitized writer and the readers. */
interface Io {
	write(text: string): void;
	say(lines: readonly string[]): void;
	visible(reader: RawReader): Promise<string>;
	hidden(reader: RawReader): Promise<string>;
}

/** The question's description, and — once answered — its errors and hint. */
function intro(io: Io, question: Question): void {
	io.say([`${question.label}: ${question.description}`]);
	// An unanswered question's errors are the plan's verdict on its DEFAULT (a
	// required field with none): shown only once the operator answered —
	// the walker (install_session.ts) prints them on a re-ask.
	if (question.answered) io.say(question.errors.map((error) => `  error: ${error}`));
	if (question.hint !== undefined) io.say([`  ${question.hint}`]);
}

/** A text answer: empty takes the suggestion, `-` empties an optional field. */
function textAnswer(answer: string, question: Question, fallback: string): string | Nav {
	return navOf(answer) ?? textAnswerOf(answer, question, fallback);
}

async function askText(io: Io, reader: RawReader, question: Question): Promise<string | Nav> {
	intro(io, question);
	const fallback = suggested(question);
	const bracket = fallback === '' ? '' : ` [${fallback}]`;
	const clear = question.emptyAllowed === true && fallback !== '' ? ", '-' empties it" : '';
	io.write(`${question.label}${bracket}${clear}: `);
	return textAnswer((await io.visible(reader)).trim(), question, fallback);
}

/** The option an answer names: its number or its value; undefined when none. */
function pickOption(options: readonly Option[], answer: string): Option | undefined {
	const byNumber = /^\d+$/.test(answer) ? options[Number(answer) - 1] : undefined;
	return byNumber ?? options.find((option) => option.value.toLowerCase() === answer.toLowerCase());
}

/** One option line of a choice. */
function choiceLine(option: Option, index: number, current: string): string {
	const label = option.label === '' ? option.value : option.label;
	const mark = option.value === current ? ' (current)' : '';
	const description = option.description === '' ? '' : ` — ${option.description}`;
	return `  ${index + 1}  ${label}${mark}${description}`;
}

/** A choice answer: a nav, the current value on empty, the named option, or undefined (ask again). */
function choiceAnswer(
	answer: string,
	options: readonly Option[],
	current: string,
): string | Nav | undefined {
	const nav = navOf(answer);
	if (nav !== null) return nav;
	// Enter takes the current value — '' too when it IS an option (media_access_mode's engine default).
	if (answer === '')
		return current !== '' || options.some((option) => option.value === '') ? current : undefined;
	return pickOption(options, answer)?.value;
}

/** The `[current]` bracket of a choice prompt: the option's label when it names one. */
function choiceBracket(options: readonly Option[], current: string): string {
	const option = options.find((item) => item.value === current);
	const shown = option === undefined ? current : option.label === '' ? option.value : option.label;
	return shown === '' ? '' : ` [${shown}]`;
}

async function askChoice(io: Io, reader: RawReader, question: Question): Promise<string | Nav> {
	intro(io, question);
	const options = question.options ?? [];
	const current = suggested(question);
	io.say(options.map((option, index) => choiceLine(option, index, current)));
	for (;;) {
		io.write(`${question.label}${choiceBracket(options, current)}: `);
		const answer = (await io.visible(reader)).trim();
		const picked = choiceAnswer(answer, options, current);
		if (picked !== undefined) return picked;
		io.write(`'${answer}' is not one of the options: type its number\n`);
	}
}

async function askMulti(io: Io, reader: RawReader, question: Question): Promise<string[] | Nav> {
	intro(io, question);
	const state = multiState(question);
	let outcome: MultiOutcome = 'show';
	for (;;) {
		if (outcome !== 'continue') io.say(pageLines(state, outcome === 'show_all'));
		io.write('toggle numbers or a code, /word filters, enter = done: ');
		outcome = multiCommand(state, await io.visible(reader), (line) => io.say([line]));
		if (isNav(outcome)) return outcome;
		if (outcome === 'done') return multiResult(state);
	}
}

/** The policy's rule list after a first entry (never the value). */
function policyRules(io: Io, entry: string, feedback: PasswordFeedback | undefined): void {
	for (const rule of feedback?.(entry).rules ?? [])
		io.write(`  ${rule.ok ? 'ok     ' : 'missing'}  ${rule.text}\n`);
}

/** The hidden prompt: the first entry, or the repeat. */
function secretPrompt(question: Question, first: boolean): string {
	return `${question.label}${first ? '' : ' again'} (hidden): `;
}

/** The policy's rules follow a FIRST entry that was not refused. */
function rulesShown(first: boolean, step: SecretStep): boolean {
	return first && step.kind !== 'refused';
}

/** How the plain mode shows one step of the secret entry flow (prompter_contract.ts secretEntryStep). */
function showSecretStep(io: Io, step: SecretStep): void {
	if (step.kind === 'never_matched') io.write(`${SECRET_TEXT.mismatch}\n`);
	if ('message' in step) io.write(`${step.message}\n`);
}

async function askSecret(
	io: Io,
	reader: RawReader,
	question: Question,
	feedback: PasswordFeedback | undefined,
	confirm: boolean,
): Promise<string> {
	intro(io, question);
	const state = newSecretEntry();
	for (;;) {
		const first = state.first === null;
		io.write(secretPrompt(question, first));
		const entry = await io.hidden(reader);
		const step = secretEntryStep(state, entry, question, feedback, confirm);
		if (rulesShown(first, step)) policyRules(io, entry, feedback);
		showSecretStep(io, step);
		if (step.kind === 'done') return step.value;
		if (step.kind === 'never_matched') throw new EntriesNeverMatched();
	}
}

/** The words a confirm takes. */
const YES_NO: Readonly<Record<string, boolean>> = Object.freeze({
	y: true,
	yes: true,
	n: false,
	no: false,
});

async function askConfirm(io: Io, reader: RawReader, question: Question): Promise<boolean | Nav> {
	intro(io, question);
	const fallback = confirmDefault(question);
	for (;;) {
		io.write(`${question.label} ${fallback ? '[Y/n]' : '[y/N]'}: `);
		const answer = (await io.visible(reader)).trim().toLowerCase();
		const nav = navOf(answer);
		if (nav !== null) return nav;
		const word = answer === '' ? fallback : YES_NO[answer];
		if (word !== undefined) return word;
		io.write('answer y or n\n');
	}
}

async function askAcknowledge(
	io: Io,
	reader: RawReader,
	question: Question,
): Promise<boolean | Nav> {
	intro(io, question);
	io.write(ACKNOWLEDGE_TEXT.plain);
	const answer = (await io.visible(reader)).trim();
	return navOf(answer) ?? answer === 'yes';
}

/** A screen's header block. */
function screenLines(screen: Screen): string[] {
	return [
		'',
		`Step ${screen.index} of ${stepTotal(screen)}: ${screen.title}`,
		screen.description,
		...screen.notices.map(
			(notice) => `${notice.level === 'info' ? '' : `${notice.level}: `}${notice.text}`,
		),
		...(screen.placeholder === undefined ? [] : [`manual step: ${screen.placeholder.manual}`]),
		...screen.help.map((link) => `help: ${link.label} — ${link.url}`),
	];
}

/** The plain mode's opening line. */
const PLAIN_BANNER = 'Dédalo installer (plain mode) — type back or quit at any question.';

/** The interrupted-install line a Resume shows. */
function resumeLine(view: ResumeView): string {
	return `An install into database '${view.database}' was interrupted (${view.outcome}).`;
}

/** What the Resume prompt offers. */
function resumePrompt(view: ResumeView): string {
	return view.canAbort ? 'resume it, abort it, or quit' : 'resume it, or quit';
}

/** A Resume answer: resume, abort (when offered), else quit. */
function resumeAnswer(word: unknown, view: ResumeView): 'resume' | 'abort' | Nav {
	if (word === 'resume') return 'resume';
	return word === 'abort' && view.canAbort ? 'abort' : QUIT;
}

/** The Review as the plain mode prints it: the padded lines, then the commands. */
/** A host route's commands, per step, exactly as they will run (review equals run). */
export function hostCommandLines(view: ReviewView): string[] {
	return (view.hostCommands ?? []).flatMap((block) => [
		`[${block.step}] ${block.label}`,
		...(block.commands.length === 0 ? ['    (checks only — no command changes the host)'] : []),
		...block.commands.map((command) => `    ${reviewCommandText(block.step, command)}`),
	]);
}

/**
 * The Review's refusals its screen notices do not already carry (the plan's
 * errors are notices): the route refusal and what the run's system check
 * would refuse (campaign 3c D2) — said BEFORE `install`, never after it.
 */
export function reviewErrorLines(view: ReviewView): string[] {
	const noticed = new Set(view.screen.notices.map((notice) => notice.text));
	return view.errors.filter((error) => !noticed.has(error)).map((error) => `error: ${error}`);
}

function reviewTextLines(view: ReviewView): string[] {
	const numbered = view.editable.map((item) => `${item.n} ${item.title}`).join(', ');
	return [
		...reviewErrorLines(view),
		...view.lines.map((line) => `${line.label.padEnd(14)} ${line.value}`),
		...hostCommandLines(view),
		// Refused, `install` checks again (campaign 3d C3d-F2) — said so, never offered as install.
		`commands: ${view.canInstall ? 'install' : 'install (checks again — not offered now)'}, edit <n> (${numbered}), write <path> (writes the answers and quits), quit`,
	];
}

/** The sanitized, wrapped writer over the prompt sink. */
function ioOf(streams: TtyStreams, width: number): Io {
	const write = (text: string): void => {
		streams.output.write(sanitizeLine(text));
	};
	return {
		write,
		say: (lines) => {
			for (const line of lines) {
				for (const wrapped of wrap(sanitizeLine(line), width, '    ')) write(`${wrapped}\n`);
			}
		},
		visible: (reader) => readLine(reader, streams.output, true),
		hidden: (reader) => readLine(reader, streams.output, false),
	};
}

/**
 * The production prompter over `streams` (stdin + the chosen prompt sink).
 * Interactive when stdin is a TTY that can enter raw mode; the sink need not be
 * stdout (prompts carry no secret).
 */
export function ttyInstallPrompter(
	streams: TtyStreams,
	options: { columns?: number } = {},
): InstallPrompter {
	const interactive =
		streams.input.isTTY === true && typeof streams.input.setRawMode === 'function';
	const io = ioOf(streams, wrapWidth(options.columns));
	let stopped: 'interrupted' | 'refused' | null = null;
	/** One question in raw mode; Ctrl-C/Ctrl-D (or three secret mismatches) quit. */
	const ask = async <T>(body: (reader: RawReader) => Promise<T>): Promise<T | Nav> => {
		if (!interactive) return QUIT;
		const reader = new RawReader(streams);
		reader.open();
		try {
			return await body(reader);
		} catch (error) {
			if (!(error instanceof Aborted)) throw error;
			stopped = error instanceof EntriesNeverMatched ? 'refused' : 'interrupted';
			if (stopped === 'interrupted') io.write('aborted by operator\n');
			return QUIT;
		} finally {
			reader.close();
		}
	};
	/** One free line: a word (or back/quit). */
	const word = (prompt: string): Promise<string | Nav> =>
		ask(async (reader) => {
			io.write(`${prompt}: `);
			const answer = (await io.visible(reader)).trim();
			return navOf(answer) ?? answer;
		});
	return {
		interactive,
		screen: (screen) => io.say(screenLines(screen)),
		say: io.say,
		text: (question) => ask((reader) => askText(io, reader, question)),
		choice: (question) => ask((reader) => askChoice(io, reader, question)),
		multi: (question) => ask((reader) => askMulti(io, reader, question)),
		secret: (question, feedback, options) =>
			ask((reader) => askSecret(io, reader, question, feedback, options?.confirm ?? true)),
		confirm: (question) => ask((reader) => askConfirm(io, reader, question)),
		acknowledge: (question) => ask((reader) => askAcknowledge(io, reader, question)),
		view: () => undefined,
		welcome: async () => {
			io.say([PLAIN_BANNER]);
			return null;
		},
		resume: async (view) => {
			io.say([resumeLine(view)]);
			return resumeAnswer(await word(resumePrompt(view)), view);
		},
		probe: (view) => {
			io.say(view.lines);
			return word(view.prompt);
		},
		review: (view) => {
			io.say([...screenLines(view.screen), ...reviewTextLines(view)]);
			return word('review');
		},
		showOnce: (lines) => showOnceOn(streams.output, lines),
		stopReason: () => stopped,
	};
}

// ── the scripted prompter ────────────────────────────────────────────────────

export interface PlainScript {
	/** question id (or a line id) → the answer as typed: text/choice string, multi list, confirm boolean. */
	readonly answers: Readonly<Record<string, string | readonly string[] | boolean>>;
	/** secret question id → the value. */
	readonly secrets?: Readonly<Record<string, string>>;
	/** The Review's commands, in order (`quit` once exhausted). */
	readonly review?: readonly string[];
	readonly interactive?: boolean;
}

/** A scripted `<back>` / `<quit>`. */
function scriptedNav(value: unknown): Nav | null {
	return value === '<back>' ? BACK : value === '<quit>' ? QUIT : null;
}

/** A scripted secret: '' or a refused value (control character, policy) ends the session. */
function scriptedSecret(
	value: string,
	question: Question,
	feedback: PasswordFeedback | undefined,
): string | Nav {
	if (entryRefusal(value, question) !== null) return QUIT;
	return feedback !== undefined && feedback(value).errors.length > 0 ? QUIT : value;
}

/**
 * A prompter that answers from `script`, recording every question it was asked
 * (`asked`: question ids, `screen:<id>` per screen shown), every line said
 * (`said`) and every one-time display (`shown`). An unlisted text/choice/
 * multi/confirm takes the default; an unlisted secret is '' (refused — QUIT —
 * when the question does not allow it); an unlisted acknowledgement is
 * declined. `<back>` / `<quit>` script nav.
 */
export function scriptedInstallPrompter(script: PlainScript): InstallPrompter & {
	readonly asked: string[];
	readonly shown: string[];
	readonly said: string[];
} {
	const asked: string[] = [];
	const shown: string[] = [];
	const said: string[] = [];
	const review = [...(script.review ?? [])];
	const interactive = script.interactive ?? true;
	const scripted = (id: string): string | readonly string[] | boolean | undefined => {
		asked.push(id);
		return script.answers[id];
	};
	/** A text/choice answer: scripted, else the suggestion. */
	const textOf = (question: Question): string | Nav => {
		const value = scripted(question.id);
		return scriptedNav(value) ?? (typeof value === 'string' ? value : suggested(question));
	};
	return {
		asked,
		shown,
		said,
		interactive,
		screen: (screen) => {
			asked.push(`screen:${screen.id}`);
			said.push(...screenLines(screen));
		},
		say: (lines) => {
			said.push(...lines);
		},
		text: async (question) => textOf(question),
		choice: async (question) => textOf(question),
		multi: async (question) => {
			const value = scripted(question.id);
			const nav = scriptedNav(value);
			if (nav !== null) return nav;
			return Array.isArray(value) ? [...value] : multiResult(multiState(question));
		},
		secret: async (question, feedback) => {
			asked.push(question.id);
			return scriptedSecret(script.secrets?.[question.id] ?? '', question, feedback);
		},
		confirm: async (question) => {
			const value = scripted(question.id);
			const nav = scriptedNav(value);
			if (nav !== null) return nav;
			return typeof value === 'boolean' ? value : confirmDefault(question);
		},
		acknowledge: async (question) => {
			const value = scripted(question.id);
			return scriptedNav(value) ?? (value === true || value === 'yes');
		},
		view: () => undefined,
		welcome: async () => {
			said.push(PLAIN_BANNER);
			return null;
		},
		resume: async (view) => {
			said.push(resumeLine(view));
			return resumeAnswer(scripted('resume'), view);
		},
		probe: async (view) => {
			said.push(...view.lines);
			const value = scripted(`${view.screen.id}.probe_action`);
			return scriptedNav(value) ?? (typeof value === 'string' ? value : '');
		},
		review: async (view) => {
			asked.push(`screen:${view.screen.id}`);
			said.push(...screenLines(view.screen), ...reviewTextLines(view));
			asked.push('review');
			return review.shift() ?? 'quit';
		},
		showOnce: (lines) => {
			if (interactive) shown.push(...lines);
			return interactive;
		},
	};
}
