/**
 * DRIVING THE FULL-SCREEN INSTALLER BY KEYS (terminal installer phase 3,
 * 2026-10-12) — for the gates over src/core/install/ui/:
 *
 *  - `openRig`: the UI (ui/app.ts openTuiOn) on OpenTUI's TEST renderer
 *    (`@opentui/core/testing` createTestRenderer — a real CliRenderer with a
 *    mock terminal) and a FAKE process port (lifecycle.ts ProcessPort: its
 *    `exit` records the code, its signal listeners can be fired), so a gate
 *    never installs a handler that exits the test runner. Renderer
 *    `handler:error` / `render:error` events are recorded (a throw in a key
 *    handler is otherwise swallowed by the renderer).
 *  - `drivenPrompter`: the TUI prompter wrapped so that EVERY ask is answered
 *    by KEY PRESSES ONLY (mockInput) from a PlainScript — the same script the
 *    plain gates use (install_plain_script.ts scriptForPlan): it never calls a
 *    resolver. Before pressing, it cross-checks the FRAME against the widget's
 *    state (the question's label is drawn; the `❯` row is the cursor's option;
 *    a checklist row's box matches the selection), so a UI that draws one
 *    thing and answers another fails. `asked` is recorded exactly as
 *    scriptedInstallPrompter records it. An ask its keys did not resolve
 *    within ASK_TIMEOUT_MS fails loudly.
 *
 * Writes nothing, touches no database, spawns nothing.
 */

import { createTestRenderer, type TestRendererSetup } from '@opentui/core/testing';
import { sanitizeLine } from '../../src/core/install/display_text.ts';
import {
	entryRefusal,
	type InstallPrompter,
	type Nav,
	type PasswordFeedback,
	type ProbeView,
	type ResumeView,
	type ReviewView,
} from '../../src/core/install/prompter_contract.ts';
import type { Question } from '../../src/core/install/screen_model.ts';
import type { PendingView } from '../../src/core/install/tui_loader.ts';
import { type App, openTuiOn } from '../../src/core/install/ui/app.ts';
import type { ProcessPort } from '../../src/core/install/ui/lifecycle.ts';
import type { PlainScript } from '../../src/core/install/ui_plain/prompter.ts';

/** An ask whose keys did not resolve it in this long is a failure, not a hang. */
const ASK_TIMEOUT_MS = 4000;
/** A lone ESC is a key only once the parser's escape timeout passed. */
const ESC_SETTLE_MS = 40;
/** Bounded multi-select edits (a selection the keys cannot reach fails, it does not loop). */
const MULTI_STEPS = 200;

// ── the fake process ─────────────────────────────────────────────────────────

export interface FakePort extends ProcessPort {
	exits: number[];
	errs: string[];
	kills: string[];
	listeners: Map<string, ((...args: never[]) => void)[]>;
	fire(event: string, ...args: unknown[]): void;
}

export function fakePort(): FakePort {
	const listeners = new Map<string, ((...args: never[]) => void)[]>();
	const port: FakePort = {
		pid: process.pid,
		exits: [],
		errs: [],
		kills: [],
		listeners,
		on: (event, listener) => {
			listeners.set(event, [...(listeners.get(event) ?? []), listener]);
		},
		off: (event, listener) => {
			listeners.set(
				event,
				(listeners.get(event) ?? []).filter((item) => item !== listener),
			);
		},
		exit: (code) => {
			port.exits.push(code);
			return undefined as never;
		},
		kill: (_pid, signal) => {
			port.kills.push(signal);
		},
		writeErr: (text) => {
			port.errs.push(text);
		},
		cookStdin: () => undefined,
		fire: (event, ...args) => {
			for (const listener of [...(listeners.get(event) ?? [])])
				(listener as (...a: unknown[]) => void)(...args);
		},
	};
	return port;
}

// ── the rig ──────────────────────────────────────────────────────────────────

export type Front = ReturnType<typeof openTuiOn>;

export interface TuiRig {
	setup: TestRendererSetup;
	front: Front;
	app: App;
	port: FakePort;
	/** Renderer handler/render errors (a gate asserts none). */
	errors: unknown[];
	frame(): Promise<string>;
	dispose(): Promise<void>;
}

export async function openRig(
	options: { width?: number; height?: number; noColor?: boolean; captureConsole?: boolean } = {},
): Promise<TuiRig> {
	const setup = await createTestRenderer({
		width: options.width ?? 104,
		height: options.height ?? 30,
	});
	const port = fakePort();
	const front = openTuiOn(setup.renderer, {
		version: '7.0.0-test',
		noColor: options.noColor ?? false,
		port,
		captureConsole: options.captureConsole ?? false,
	});
	const errors: unknown[] = [];
	setup.renderer.on('handler:error', (event: unknown) => errors.push(event));
	setup.renderer.on('render:error', (event: unknown) => errors.push(event));
	return {
		setup,
		front,
		app: front.app,
		port,
		errors,
		frame: async () => {
			await setup.renderOnce();
			return setup.captureCharFrame();
		},
		dispose: async () => {
			front.dispose();
			await setup.dispose();
		},
	};
}

// ── keys ─────────────────────────────────────────────────────────────────────

export interface Keys {
	/** Called after EVERY key (the secrets gate captures a frame there). */
	afterKey?: () => Promise<void> | void;
	/**
	 * Before an ask's scripted keys: a gate presses its OWN keys for the `nth`
	 * ask of `id` — `handled` skips the scripted ones, `continue` runs them after.
	 */
	intercept?: (id: string, nth: number) => Promise<'handled' | 'continue'>;
}

/** One key, then the hook. */
async function press(keys: Keys, action: () => void | Promise<void>): Promise<void> {
	await action();
	await keys.afterKey?.();
}

export async function typeKeys(rig: TuiRig, keys: Keys, text: string): Promise<void> {
	for (const char of Array.from(text)) await press(keys, () => rig.setup.mockInput.pressKey(char));
}

export const enter = (rig: TuiRig, keys: Keys) =>
	press(keys, () => rig.setup.mockInput.pressEnter());

export const esc = (rig: TuiRig, keys: Keys) =>
	press(keys, async () => {
		rig.setup.mockInput.pressEscape();
		await Bun.sleep(ESC_SETTLE_MS);
	});

export const ctrl = (rig: TuiRig, keys: Keys, name: string) =>
	press(keys, () => rig.setup.mockInput.pressKey(name, { ctrl: true }));

export async function arrows(rig: TuiRig, keys: Keys, from: number, to: number): Promise<void> {
	const direction = to > from ? 'down' : 'up';
	for (let i = 0; i < Math.abs(to - from); i++)
		await press(keys, () => rig.setup.mockInput.pressArrow(direction));
}

/** Ctrl-Q, then y on the quit overlay. */
export async function quitKeys(rig: TuiRig, keys: Keys): Promise<void> {
	await ctrl(rig, keys, 'q');
	await press(keys, () => rig.setup.mockInput.pressKey('y'));
}

// ── the frame cross-checks ───────────────────────────────────────────────────

/** The live ask's description (fails when nothing is asked). */
export function pending(rig: TuiRig): PendingView {
	const view = rig.front.prompter.pending();
	if (view === null) throw new Error('driver: no ask is pending');
	return view;
}

/** The frame line that carries the `❯` pointer inside the pane (not the footer's). */
function pointerRow(frame: string): string {
	const rows = frame.split('\n').filter((row) => row.includes('❯'));
	if (rows.length !== 1) throw new Error(`driver: expected one ❯ row, frame has ${rows.length}`);
	return rows[0] as string;
}

/** The question's label is on screen (its first 12 columns: the label column cuts at 17). */
async function expectLabel(rig: TuiRig, label: string): Promise<void> {
	const frame = await rig.frame();
	const head = Array.from(sanitizeLine(label)).slice(0, 12).join('');
	if (!frame.includes(head)) throw new Error(`driver: label '${head}' not drawn:\n${frame}`);
}

/** The `❯` row shows the option the widget's cursor is on. */
async function expectPointerOn(rig: TuiRig, text: string): Promise<string> {
	const row = pointerRow(await rig.frame());
	const head = Array.from(sanitizeLine(text)).slice(0, 10).join('');
	if (!row.includes(head)) throw new Error(`driver: ❯ row '${row.trim()}' is not '${head}'`);
	return row;
}

// ── answering ────────────────────────────────────────────────────────────────

type Answer = string | readonly string[] | boolean | undefined;

/** `<back>` / `<quit>` as keys; true when it was one. */
async function navKeys(rig: TuiRig, keys: Keys, value: Answer): Promise<boolean> {
	if (value === '<back>') await esc(rig, keys);
	else if (value === '<quit>') await quitKeys(rig, keys);
	else return false;
	return true;
}

async function textKeys(rig: TuiRig, keys: Keys, question: Question, value: Answer): Promise<void> {
	await expectLabel(rig, question.label);
	if (await navKeys(rig, keys, value)) return;
	if (typeof value === 'string') {
		await ctrl(rig, keys, 'u');
		// '' typed means EMPTY (the plain script's '' answer): `-` empties an optional field.
		await typeKeys(rig, keys, value === '' && question.emptyAllowed === true ? '-' : value);
	}
	await enter(rig, keys);
}

function optionLabel(question: Question, value: string): string {
	const option = question.options?.find((item) => item.value === value);
	if (option === undefined) return value;
	if (option.label !== '') return option.label;
	return option.value === '' ? '(engine default)' : option.value;
}

async function choiceKeys(
	rig: TuiRig,
	keys: Keys,
	question: Question,
	value: Answer,
): Promise<void> {
	if (await navKeys(rig, keys, value)) return;
	const view = pending(rig);
	const options = view.options ?? [];
	await expectPointerOn(rig, optionLabel(question, options[view.cursor ?? 0] ?? ''));
	if (typeof value === 'string') {
		const index = options.indexOf(value);
		if (index < 0) throw new Error(`driver: '${value}' is not an option of ${question.id}`);
		await arrows(rig, keys, view.cursor ?? 0, index);
		await expectPointerOn(rig, optionLabel(question, value));
	}
	await enter(rig, keys);
}

/** The checklist row of `value` is on the pointer, its box matching the selection. */
async function expectRow(
	rig: TuiRig,
	value: string,
	ticked: boolean,
	locked: boolean,
): Promise<void> {
	const row = await expectPointerOn(rig, value);
	const box = locked ? '■' : ticked ? '◼' : '◻';
	if (!row.includes(box)) throw new Error(`driver: row '${row.trim()}' lacks ${box}`);
}

/** Toggle one option by keys: filter to it, move to it, Space, clear the filter. */
async function toggleByKeys(
	rig: TuiRig,
	keys: Keys,
	question: Question,
	value: string,
): Promise<void> {
	await typeKeys(rig, keys, value);
	const view = pending(rig);
	const index = (view.options ?? []).indexOf(value);
	if (index < 0) throw new Error(`driver: filter '${value}' does not show it`);
	await arrows(rig, keys, view.cursor ?? 0, index);
	const option = question.options?.find((item) => item.value === value);
	await expectRow(rig, value, (view.selected ?? []).includes(value), option?.locked === true);
	await press(keys, () => rig.setup.mockInput.pressKey(' '));
	await esc(rig, keys);
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
	a.length === b.length && a.every((item) => b.includes(item));

async function multiKeys(
	rig: TuiRig,
	keys: Keys,
	question: Question,
	value: Answer,
): Promise<void> {
	if (await navKeys(rig, keys, value)) return;
	if (Array.isArray(value)) {
		// A locked (core) row stays as it is: the script names the operator's ticks only.
		const locked = (question.options ?? []).filter((option) => option.locked).map((o) => o.value);
		const kept = (pending(rig).selected ?? []).filter((item) => locked.includes(item));
		const target = [...new Set([...kept, ...(value as readonly string[])])];
		await reachSelection(rig, keys, question, target);
		await reachOrder(
			rig,
			keys,
			question,
			target.filter((item) => !locked.includes(item)),
		);
	}
	await enter(rig, keys);
}

/** Toggle differing options until the selection IS `target` (an unreachable one fails). */
async function reachSelection(
	rig: TuiRig,
	keys: Keys,
	question: Question,
	target: readonly string[],
): Promise<void> {
	for (let step = 0; step < MULTI_STEPS; step++) {
		const selected = pending(rig).selected ?? [];
		if (sameSet(selected, target)) return;
		const differing = (question.options ?? [])
			.map((option) => option.value)
			.filter((item) => selected.includes(item) !== target.includes(item));
		let moved = false;
		for (const item of differing) {
			await toggleByKeys(rig, keys, question, item);
			if (!sameSet(pending(rig).selected ?? [], selected)) {
				moved = true;
				break;
			}
		}
		if (!moved) throw new Error(`driver: ${question.id} cannot reach [${target.join(',')}]`);
	}
	throw new Error(`driver: ${question.id} did not settle in ${MULTI_STEPS} steps`);
}

/**
 * The selection ORDER is part of an answer (the working languages are written in
 * it): an operator gets it by ticking in that order. From the first row out of
 * order, untick the rest and tick the target's rest in order.
 */
async function reachOrder(
	rig: TuiRig,
	keys: Keys,
	question: Question,
	target: readonly string[],
): Promise<void> {
	const free = (): string[] =>
		(pending(rig).selected ?? []).filter((item) => target.includes(item));
	const now = free();
	const from = now.findIndex((item, index) => item !== target[index]);
	if (from < 0) return;
	for (const item of now.slice(from).reverse()) await toggleByKeys(rig, keys, question, item);
	for (const item of target.slice(from)) {
		if (!(pending(rig).selected ?? []).includes(item))
			await toggleByKeys(rig, keys, question, item);
	}
	const reached = free();
	if (reached.join(',') !== target.join(','))
		throw new Error(
			`driver: ${question.id} order [${reached.join(',')}] is not [${target.join(',')}]`,
		);
}

async function secretKeys(
	rig: TuiRig,
	keys: Keys,
	question: Question,
	value: string,
	feedback: PasswordFeedback | undefined,
	confirm = true,
): Promise<void> {
	await expectLabel(rig, question.label);
	const refused =
		(value === '' && question.emptyAllowed !== true) ||
		(value !== '' && entryRefusal(value, question) !== null) ||
		(feedback !== undefined && value !== '' && feedback(value).errors.length > 0);
	// The scripted prompter ends the session on a refused secret: so does the operator here.
	if (refused) return quitKeys(rig, keys);
	await typeKeys(rig, keys, value);
	await enter(rig, keys);
	if (value === '' || !confirm) return;
	await typeKeys(rig, keys, value);
	await enter(rig, keys);
}

async function confirmKeys(
	rig: TuiRig,
	keys: Keys,
	question: Question,
	value: Answer,
): Promise<void> {
	await expectLabel(rig, question.label);
	if (await navKeys(rig, keys, value)) return;
	// y/n only SET the switch; Enter answers (campaign 3b N39).
	if (typeof value === 'boolean')
		await press(keys, () => rig.setup.mockInput.pressKey(value ? 'y' : 'n'));
	await enter(rig, keys);
}

async function acknowledgeKeys(
	rig: TuiRig,
	keys: Keys,
	question: Question,
	value: Answer,
): Promise<void> {
	if (await navKeys(rig, keys, value)) return;
	const yes = value === true || value === 'yes';
	if (question.id === 'review.install') {
		await expectLabel(rig, question.label);
		if (yes) await typeKeys(rig, keys, 'yes');
	} else if (yes) await press(keys, () => rig.setup.mockInput.pressKey(' '));
	await enter(rig, keys);
}

const PROBE_HOTKEY: Readonly<Record<string, string>> = {
	retry: 'r',
	edit: 'e',
	yes: 'y',
	quit: 'q',
};

async function probeKeys(rig: TuiRig, keys: Keys, view: ProbeView, value: Answer): Promise<void> {
	if (value === '<back>') return esc(rig, keys);
	const hotkey = PROBE_HOTKEY[String(value)];
	if (hotkey === undefined || !view.commands.includes(value as never))
		throw new Error(`driver: probe answer '${String(value)}' is not offered`);
	await press(keys, () => rig.setup.mockInput.pressKey(hotkey));
}

/** One Review command as keys: install / edit <n> / write <path> / quit. */
export async function reviewKeys(
	rig: TuiRig,
	keys: Keys,
	command: string | undefined,
): Promise<void> {
	const [word, ...rest] = (command ?? 'quit').split(' ');
	const argument = rest.join(' ');
	if (word === 'install') return enter(rig, keys);
	if (word === 'edit' || word === 'write') {
		await press(keys, () => rig.setup.mockInput.pressKey(word === 'edit' ? 'e' : 'w'));
		await typeKeys(rig, keys, argument);
		return enter(rig, keys);
	}
	if (word === 'quit') return quitKeys(rig, keys);
	throw new Error(`driver: review command '${command}' has no keys`);
}

async function resumeKeys(rig: TuiRig, keys: Keys, view: ResumeView, value: Answer): Promise<void> {
	const options = pending(rig).options ?? [];
	const target =
		value === 'abort' && view.canAbort ? 'abort' : value === 'resume' ? 'resume' : 'quit';
	await arrows(rig, keys, pending(rig).cursor ?? 0, options.indexOf(target));
	await enter(rig, keys);
}

// ── the driven prompter ──────────────────────────────────────────────────────

/** Settle an ask by its keys, or fail loudly. */
async function settled<T>(id: string, answer: Promise<T>, act: () => Promise<void>): Promise<T> {
	await act();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() => reject(new Error(`driver: the keys did not resolve the ask '${id}'`)),
			ASK_TIMEOUT_MS,
		);
	});
	try {
		return await Promise.race([answer, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * The TUI prompter of `rig`, answered from `script` by keys. `review` (the
 * Review commands) is consumed in order; `reviewHook` runs before each Review
 * is answered (a gate edits the script there, as the plain gates do).
 */
export function drivenPrompter(
	rig: TuiRig,
	script: PlainScript,
	keys: Keys = {},
	reviewHook?: (view: ReviewView) => void,
): InstallPrompter & { readonly asked: string[]; readonly reviews: ReviewView[] } {
	const real = rig.front.prompter;
	const asked: string[] = [];
	const reviews: ReviewView[] = [];
	const review = [...(script.review ?? [])];
	const counts = new Map<string, number>();
	const drive = <T>(id: string, promise: Promise<T>, act: () => Promise<void>): Promise<T> =>
		settled(id, promise, async () => {
			const nth = (counts.get(id) ?? 0) + 1;
			counts.set(id, nth);
			if ((await keys.intercept?.(id, nth)) === 'handled') return;
			await act();
		});
	const answer = (id: string): Answer => {
		asked.push(id);
		return script.answers[id] as Answer;
	};
	return {
		asked,
		reviews,
		interactive: true,
		view: (view) => real.view(view),
		screen: (screen) => {
			asked.push(`screen:${screen.id}`);
			real.screen(screen);
		},
		say: (lines) => real.say(lines),
		welcome: (view) => drive('welcome', real.welcome(view), () => enter(rig, keys)),
		resume: (view) => {
			const value = answer('resume');
			return drive('resume', real.resume(view), () => resumeKeys(rig, keys, view, value));
		},
		text: (question) => {
			const value = answer(question.id);
			return drive(question.id, real.text(question), () => textKeys(rig, keys, question, value));
		},
		choice: (question) => {
			const value = answer(question.id);
			return drive(question.id, real.choice(question), () =>
				choiceKeys(rig, keys, question, value),
			);
		},
		multi: (question) => {
			const value = answer(question.id);
			return drive(question.id, real.multi(question), () => multiKeys(rig, keys, question, value));
		},
		secret: (question, feedback, options) => {
			asked.push(question.id);
			const value = script.secrets?.[question.id] ?? '';
			return drive(question.id, real.secret(question, feedback, options), () =>
				secretKeys(rig, keys, question, value, feedback, options?.confirm ?? true),
			);
		},
		confirm: (question) => {
			const value = answer(question.id);
			return drive(question.id, real.confirm(question), () =>
				confirmKeys(rig, keys, question, value),
			);
		},
		acknowledge: (question) => {
			const value = answer(question.id);
			return drive(question.id, real.acknowledge(question), () =>
				acknowledgeKeys(rig, keys, question, value),
			);
		},
		probe: (view) => {
			const value = answer(`${view.screen.id}.probe_action`);
			return drive('probe', real.probe(view), () => probeKeys(rig, keys, view, value));
		},
		review: (view) => {
			asked.push(`screen:${view.screen.id}`);
			asked.push('review');
			reviews.push(view);
			reviewHook?.(view);
			const command = review.shift();
			return drive('review', real.review(view), () => reviewKeys(rig, keys, command));
		},
		showOnce: (lines) => real.showOnce(lines),
		stopReason: () => real.stopReason?.() ?? null,
	};
}

/** A Nav value as a string (for messages). */
export function navText(value: unknown): string {
	return typeof value === 'object' && value !== null ? (value as Nav).nav : String(value);
}
