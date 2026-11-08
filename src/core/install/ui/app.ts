/**
 * THE FULL-SCREEN INSTALLER (terminal installer phase 3, 2026-10-12) — the
 * OpenTUI front end of the ONE interactive session (install_session.ts). It
 * holds NO install knowledge: what it asks, in which order, with which options,
 * defaults and errors comes from the walker's views (prompter_contract.ts);
 * what it answers is the plain mode's answer; the run it draws is the
 * executor's events. The approved mockup's look: palette.ts, frame.ts,
 * logo.ts.
 *
 * openTui creates the renderer on the real terminal — mouse OFF (the
 * terminal's own selection copies the Done screen's secret), the kitty
 * keyboard protocol OFF (the legacy encodings carry every key used: Shift-Tab,
 * Ctrl-U/W/D/Q, F1), no signal or Ctrl-C handling of its own, no console
 * overlay — and owns it until close: a failure after the renderer exists
 * destroys it and AWAITS its restore before rethrowing, so the plain-mode
 * fallback (tui_loader.ts) never shares the terminal with a live renderer.
 * openTuiOn is the same UI on a given renderer (the gates' test renderer)
 * with an injected process (lifecycle.ts ProcessPort).
 */

import { type CliRenderer, createCliRenderer, type KeyEvent, type PasteEvent } from '@opentui/core';
import { sanitizeLine } from '../display_text.ts';
import type { ScreenView } from '../prompter_contract.ts';
import { ROUTE_TEXT } from '../screen_text.ts';
import type { TuiFrontEnd, TuiOptions } from '../tui_loader.ts';
import { captureConsole, type LogRing, logRing } from './console_capture.ts';
import { drawModel, type FrameModel, headerLine } from './frame.ts';
import { type Lifecycle, lifecycle, type ProcessPort } from './lifecycle.ts';
import { type Palette, paletteFor } from './palette.ts';
import { CARRIED_WHOLE, isProgressLine, tuiPrompter } from './prompter.ts';
import { tuiReporter } from './reporter.ts';
import { type DoneModel, doneCard, doneSummary } from './screens/done.ts';
import { installPane, newRunView, type RunView, runStatus } from './screens/install.ts';
import { welcomeLines } from './screens/pages.ts';
import { questionPane, type RailState, railLines } from './screens/question.ts';
import { type Line, seg } from './styled.ts';
import { keyName, type Layout, layoutFor } from './view_state.ts';
import type { KeyHint, Widget } from './widget.ts';
import { wrapped } from './widgets/field_parts.ts';
import { BLANK, saidLines } from './widgets/notices.ts';

/** The UI's state (one per open UI — never module state). */
export interface App {
	readonly renderer: CliRenderer;
	readonly palette: Palette;
	readonly version: string;
	readonly life: Lifecycle;
	readonly log: LogRing;
	view: ScreenView | null;
	said: string[];
	widget: Widget | null;
	run: RunView;
	done: DoneModel | null;
	overlay: 'help' | 'quit' | null;
	stopped: 'interrupted' | 'refused' | null;
	/** An unfinished install exists (the Resume screen was shown): a quit keeps it. */
	unfinished: boolean;
	/** The pending ask's QUIT (an interrupt, a confirmed quit); null when nothing is asked. */
	cancel: ((reason: 'interrupted' | null) => void) | null;
	/** Resolves the Done screen's wait. */
	dismiss: (() => void) | null;
	draw(): void;
	layout(): Layout;
}

export interface OpenOptions {
	version: string;
	noColor: boolean;
	port: ProcessPort;
	/** Route the console into the log ring (default true). */
	captureConsole?: boolean;
}

/** The said lines kept on screen (the newest): a short check carried whole, with its title line. */
const SAID_KEPT = CARRIED_WHOLE + 1;

/** The header's route chip. */
function routeChip(view: ScreenView | null): string {
	const route = view?.route ?? null;
	return route === null ? 'choose' : ROUTE_TEXT[route].label;
}

/**
 * The header's status: where the install stands — read from the state, never
 * assumed: an unfinished install found on start (the Resume screen) has run
 * steps already (campaign 3 C3-58: never "nothing installed yet" after the
 * seed committed).
 */
function status(app: App): Line {
	const ran = app.life.phase() !== 'walk' && app.done?.kind !== 'written';
	if (ran) return runStatus(app.run);
	return app.unfinished
		? [seg('● ', 'warn'), seg('an unfinished install is recorded', 'muted')]
		: [seg('● ', 'ok'), seg('nothing installed yet', 'muted')];
}

/** The run states on the rail. */
function runStates(app: App): Record<string, RailState> {
	const phase = app.life.phase();
	if (phase === 'walk') return {};
	if (phase === 'run') return { Install: 'current' };
	return { Install: 'done', Done: 'current' };
}

/** Which rail row is current. */
function railCurrent(app: App): string {
	if (app.life.phase() !== 'walk') return '';
	return app.view?.screen.id ?? 'route';
}

function header(app: App): Line {
	return headerLine(app.version, routeChip(app.view), status(app), app.layout().cols - 2);
}

function rail(app: App): Line[] {
	return railLines(app.view, railCurrent(app), runStates(app), app.layout().rail === 'full');
}

/** The help overlay: the asking widget's words, the screen's links, the keys. */
function helpModel(app: App, width: number): FrameModel {
	const widget = app.widget;
	const lines: Line[] = [
		[seg(sanitizeLine(widget?.label ?? 'Help'), 'accent', { bold: true })],
		...wrapped(widget?.description ?? '', width, 'text'),
		[seg('')],
		...(app.view?.screen.help ?? []).flatMap((link) =>
			wrapped(`${link.label} — ${link.url}`, width, 'info'),
		),
		[seg('')],
		...(widget?.keys() ?? []).map(
			([key, label]) => [seg(key.padEnd(12), 'text', { bold: true }), seg(label, 'muted')] as Line,
		),
		[
			seg('ctrl+c'.padEnd(12), 'text', { bold: true }),
			seg('stop the installer (exit 130)', 'muted'),
		],
	];
	return frameOf(app, { title: 'Help', lines, focus: 0 }, [['esc', 'close help']]);
}

/** What a quit leaves behind: an unfinished install (a Resume was offered, or the run began) is KEPT. */
function quitConsequence(app: App): string {
	return app.unfinished || app.life.phase() !== 'walk'
		? 'The unfinished install is kept. Run the installer again to resume or abort it.'
		: 'Nothing has been installed. Run it again to start over.';
}

function quitModel(app: App, width: number): FrameModel {
	const lines: Line[] = [
		[seg('Quit the installer?', 'warn', { bold: true })],
		...wrapped(quitConsequence(app), width, 'muted'),
		[seg('')],
		[
			seg('y', 'text', { bold: true }),
			seg(' / enter  quit      ', 'muted'),
			seg('n', 'text', { bold: true }),
			seg(' / esc  stay', 'muted'),
		],
	];
	return frameOf(app, { title: 'Quit', lines, focus: 0 }, [
		['y', 'quit'],
		['n', 'stay'],
	]);
}

function frameOf(
	app: App,
	pane: { title: string; lines: Line[]; focus: number; pinned?: Line[] },
	footer: readonly KeyHint[],
): FrameModel {
	return { kind: 'frame', header: header(app), rail: rail(app), pane, footer };
}

const RUN_KEYS: readonly KeyHint[] = [
	['l', 'full log'],
	['ctrl+c', 'stop · resume later'],
];

const DONE_KEYS: readonly KeyHint[] = [['enter', 'close']];

/** The said lines a page keeps pinned (the newest). */
const PAGE_SAID_KEPT = 3;

/**
 * A whole-pane widget (resume, probe, review). What the session SAID since the
 * last answer (a refused `w <path>`, `no screen N`, a recheck notice) is pinned
 * under it — the plain mode prints those lines; a page never drops them.
 */
function pageModel(app: App, widget: Widget, width: number): FrameModel {
	const drawn = widget.lines({ width, layout: app.layout(), palette: app.palette });
	const said = app.said.filter((line) => !isProgressLine(line)).slice(-PAGE_SAID_KEPT);
	const spoken = said.length === 0 ? [] : [BLANK, ...saidLines(said, width)];
	const pinned = [...spoken, ...(drawn.pinned ?? [])];
	return frameOf(
		app,
		{ title: widget.title, ...drawn, ...(pinned.length === 0 ? {} : { pinned }) },
		widget.keys(),
	);
}

/** The model for the current state, in order of precedence. */
function modelOf(app: App): FrameModel {
	const layout = app.layout();
	const width = layout.paneWidth;
	if (layout.tooSmall) return smallModel(layout);
	if (app.overlay === 'quit') return quitModel(app, width);
	if (app.overlay === 'help') return helpModel(app, width);
	if (app.done !== null)
		return {
			kind: 'card',
			header: header(app),
			card: doneCard(app.done, cardWidth(layout)),
			footer: DONE_KEYS,
		};
	return walkOrRunModel(app, layout);
}

function walkOrRunModel(app: App, layout: Layout): FrameModel {
	const widget = app.widget;
	if (widget?.kind === 'welcome') return welcomeModel(app, layout, widget);
	// A pending field (a resume's missing secret) is drawn whatever the phase: never typed blind.
	if (app.life.phase() !== 'walk' && widget?.placement !== 'field')
		return frameOf(app, installPane(app.run, app.log.lines(), layout.paneWidth), RUN_KEYS);
	if (widget?.placement === 'page') return pageModel(app, widget, layout.paneWidth);
	const ctx = { width: layout.paneWidth, layout, palette: app.palette };
	return frameOf(
		app,
		questionPane(app.view, widget, app.said.slice(-SAID_KEPT), ctx),
		widget?.keys() ?? [],
	);
}

function cardWidth(layout: Layout): number {
	return Math.max(10, layout.cols - 8 - (layout.logo ? 33 : 0));
}

function welcomeModel(app: App, layout: Layout, widget: Widget): FrameModel {
	const view = { version: app.version };
	return {
		kind: 'card',
		header: header(app),
		card: {
			title: 'Dédalo installer',
			tone: 'accent',
			info: welcomeLines(view, cardWidth(layout)),
			below: [],
		},
		footer: widget.keys(),
	};
}

function smallModel(layout: Layout): FrameModel {
	return {
		kind: 'small',
		lines: [
			[seg('▟▙ Dédalo installer', 'accent')],
			[
				seg(
					`The terminal is ${layout.cols}×${layout.rows}; the installer needs at least 80×24.`,
					'warn',
				),
			],
			[seg('Enlarge the window (or run again with --plain).', 'muted')],
		],
	};
}

// ── keys ─────────────────────────────────────────────────────────────────────

/** The quit overlay's keys. */
function quitKey(app: App, name: string): void {
	if (name === 'char:y' || name === 'enter') {
		app.overlay = null;
		app.cancel?.(null);
		return;
	}
	if (name === 'char:n' || name === 'esc') app.overlay = null;
}

function overlayKey(app: App, name: string): void {
	if (app.overlay === 'quit') {
		quitKey(app, name);
		return;
	}
	if (['esc', 'enter', 'f1', 'char:q', 'char:?'].includes(name)) app.overlay = null;
}

/** The asking widget that takes the global keys (not the Welcome: its q is its own). */
function framed(app: App): Widget | null {
	return app.widget !== null && app.widget.kind !== 'welcome' ? app.widget : null;
}

const openHelp = (app: App): void => {
	app.overlay = 'help';
};

/** The keys handled before the widget sees them (the first rule that applies runs). */
const GLOBAL_KEYS: readonly { applies(app: App, name: string): boolean; run(app: App): void }[] = [
	{
		applies: (app, name) => name === 'ctrl-q' && app.cancel !== null && framed(app) !== null,
		run: (app) => {
			app.overlay = 'quit';
		},
	},
	{ applies: (app, name) => name === 'f1' && framed(app) !== null, run: openHelp },
	{ applies: (app, name) => name === 'char:?' && framed(app)?.editing === false, run: openHelp },
	{
		applies: (app, name) => name === 'ctrl-d' && app.widget?.placement === 'field',
		run: (app) => app.life.ctrlC(),
	},
];

/** Keys before the widget sees them: true = handled. */
function globalKey(app: App, name: string): boolean {
	const rule = GLOBAL_KEYS.find((item) => item.applies(app, name));
	rule?.run(app);
	return rule !== undefined;
}

/** Keys while the run or the Done screen is shown. */
function runKey(app: App, name: string): void {
	if (app.done !== null && ['enter', 'char:q', 'esc', 'ctrl-q'].includes(name)) app.dismiss?.();
	else if (name === 'char:l') app.run.showLog = !app.run.showLog;
}

export function onKey(
	app: App,
	key: Pick<KeyEvent, 'name' | 'ctrl' | 'meta' | 'shift' | 'sequence'>,
): void {
	const name = keyName(key);
	if (name === 'ctrl-c') {
		app.life.ctrlC();
		return;
	}
	// Only the notice is drawn: no key answers a question the operator cannot see.
	if (app.layout().tooSmall) {
		app.draw();
		return;
	}
	if (app.overlay !== null) overlayKey(app, name);
	else if (globalKey(app, name)) {
		// handled
	} else if (app.widget !== null) app.widget.onKey(name);
	else runKey(app, name);
	app.draw();
}

// ── open ─────────────────────────────────────────────────────────────────────

/** The real process as the lifecycle's port. */
function processPort(stdin: NodeJS.ReadStream): ProcessPort {
	return {
		pid: process.pid,
		on: (event, listener) => process.on(event, listener as never),
		off: (event, listener) => process.off(event, listener as never),
		exit: (code) => process.exit(code),
		kill: (pid, signal) => process.kill(pid, signal as NodeJS.Signals),
		writeErr: (text) => {
			process.stderr.write(text);
		},
		cookStdin: () => {
			if (stdin.isTTY === true && stdin.isRaw) stdin.setRawMode(false);
		},
	};
}

/**
 * The UI on a terminal: the renderer created here, owned until close. A
 * failure after it exists destroys it and awaits its restore before the error
 * reaches the loader (which falls back to the plain mode).
 */
export async function openTui(options: TuiOptions): Promise<TuiFrontEnd> {
	const renderer = await createCliRenderer({
		stdin: options.stdin,
		stdout: options.stdout,
		exitOnCtrlC: false,
		exitSignals: [],
		useMouse: false,
		openConsoleOnError: false,
		consoleMode: 'disabled',
		screenMode: 'alternate-screen',
		clearOnShutdown: true,
		useKittyKeyboard: null,
		autoFocus: false,
		...(options.noColor ? {} : { backgroundColor: paletteFor(false).bg }),
	});
	try {
		return openTuiOn(renderer, {
			version: options.version,
			noColor: options.noColor,
			port: processPort(options.stdin),
		});
	} catch (error) {
		renderer.destroy();
		await renderer.closed;
		throw error;
	}
}

/** Build the App over a renderer (no terminal of its own: the gates' seam). */
function appOn(renderer: CliRenderer, options: OpenOptions, log: LogRing): App {
	const app: App = {
		renderer,
		palette: paletteFor(options.noColor),
		version: options.version,
		log,
		view: null,
		said: [],
		widget: null,
		run: newRunView(),
		done: null,
		overlay: null,
		stopped: null,
		unfinished: false,
		cancel: null,
		dismiss: null,
		// A destroyed renderer draws nothing (a timer's redraw may land after the UI closed).
		draw: () => {
			if (!renderer.isDestroyed) drawModel(renderer, app.palette, app.layout(), modelOf(app));
		},
		layout: () => layoutFor(renderer.width, renderer.height),
		life: lifecycle(options.port, {
			isDestroyed: () => renderer.isDestroyed,
			destroy: () => renderer.destroy(),
			closed: () => renderer.closed,
			cancelAsk: () => {
				if (app.cancel === null) return false;
				app.cancel('interrupted');
				return true;
			},
		}),
	};
	return app;
}

/** Show the Done card and wait for a key; then close with `code`. */
function showDone(
	app: App,
	model: DoneModel,
	code: number,
	lines: readonly string[],
): Promise<never> {
	app.done = model;
	app.widget = null;
	// Queued now: a signal on the card exits with `code` and prints them too.
	app.life.final(code, [doneSummary(model), ...lines]);
	app.draw();
	return new Promise<void>((resolve) => {
		app.dismiss = resolve;
	}).then(() => app.life.close(code));
}

/** THE UI over `renderer` (see the header). */
export function openTuiOn(
	renderer: CliRenderer,
	options: OpenOptions,
): TuiFrontEnd & { app: App; dispose(): void } {
	const log = logRing();
	const app = appOn(renderer, options, log);
	const restoreConsole = options.captureConsole === false ? () => undefined : captureConsole(log);
	app.life.onClose(restoreConsole);
	const onKeypress = (key: KeyEvent): void => onKey(app, key);
	const onPaste = (event: PasteEvent): void => {
		if (!app.layout().tooSmall) app.widget?.onPaste?.(new TextDecoder().decode(event.bytes));
		app.draw();
	};
	const onResize = (): void => app.draw();
	renderer.keyInput.on('keypress', onKeypress);
	renderer.keyInput.on('paste', onPaste);
	renderer.on('resize', onResize);
	const dispose = (): void => {
		renderer.keyInput.off('keypress', onKeypress);
		renderer.keyInput.off('paste', onPaste);
		renderer.off('resize', onResize);
		app.life.dispose();
		restoreConsole();
	};
	try {
		app.draw();
	} catch (error) {
		// The plain-mode fallback gets the console and the process handlers back.
		dispose();
		throw error;
	}
	return {
		app,
		prompter: tuiPrompter(app),
		reporter: tuiReporter(app, (model, code, lines) => showDone(app, model, code, lines)),
		restoreSync: () => {
			if (!renderer.isDestroyed) renderer.destroy();
		},
		exitNow: (code, lines) => app.life.exitNow(code, lines),
		close: (code, lines) => app.life.close(code, lines),
		written: (path) =>
			showDone(
				app,
				{
					kind: 'written',
					path,
					trial: app.view?.route === 'trial',
					route: app.view?.route ?? 'developer',
				},
				0,
				[],
			),
		onClose: (hook) => app.life.onClose(hook),
		dispose,
	};
}
