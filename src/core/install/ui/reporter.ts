/**
 * THE RUN, ON SCREEN (terminal installer phase 3, 2026-10-12) — the
 * RunReporter scripts/install.ts drives once the walker returned `install`
 * (or `resume` / `abort`): the Install screen from the executor's step events,
 * the log lines into the ring (the `l` view — sanitized and, the executor's
 * redaction wrapping the capture, redacted), the generated secret into the
 * shown-once box, then the Done card (a key closes it). Lines the executor
 * prints after an interrupt also go to the exit notice: they are what the
 * operator must read once the terminal is back (the resume hint).
 */

import { sanitizeLine } from '../display_text.ts';
import { interactiveSuggestion } from '../install_plan.ts';
import type { RunReporter } from '../run_events.ts';
import { servedLines, todoLines } from '../ui_plain/reporter.ts';
import type { App } from './app.ts';
import type { DoneModel } from './screens/done.ts';
import { applyStepEvent } from './screens/install.ts';

type ShowDone = (model: DoneModel, code: number, lines: readonly string[]) => Promise<never>;

/** How often the Install screen redraws while a step runs (its time counts up). */
export const RUN_TICK_MS = 1000;

export function tuiReporter(app: App, showDone: ShowDone): RunReporter {
	let interrupted = false;
	// The live clock of the running step (campaign C4 S4): a redraw a second until the run ends.
	let ticker: ReturnType<typeof setInterval> | null = null;
	const tick = (): void => {
		if (ticker !== null) return;
		ticker = setInterval(() => {
			// Only a running step's clock moves: nothing to redraw otherwise.
			if (app.run.outcome === null && app.run.steps.some((row) => row.status === 'running'))
				app.draw();
		}, RUN_TICK_MS);
		ticker.unref?.();
	};
	const stopTick = (): void => {
		if (ticker !== null) clearInterval(ticker);
		ticker = null;
	};
	const line = (text: string): void => {
		app.log.push(text);
		const last = sanitizeLine(text).trim();
		if (last !== '') app.run.lastLog = last;
		if (interrupted) app.life.notice([text]);
		app.draw();
	};
	const enterRun = (): void => {
		app.widget = null;
		app.cancel = null;
		app.life.phase('run');
		tick();
	};
	return {
		io: {
			log: line,
			warn: line,
			showOnce: (lines) => {
				app.run.shownOnce = [...app.run.shownOnce, ...lines];
				app.draw();
				return true;
			},
			step: (event) => {
				if (event.phase === 'interrupted') interrupted = true;
				applyStepEvent(app.run, event);
				app.draw();
			},
			signals: (armed) => app.life.armed(armed),
			interrupted: () => {
				interrupted = true;
				stopTick();
			},
		},
		prepare: () => {
			enterRun();
			app.draw();
		},
		begin: (steps) => {
			enterRun();
			app.run.steps = steps.map((step) => ({
				id: step.id,
				label: step.label,
				status: 'pending',
				elapsedMs: null,
				warnings: [],
				message: null,
			}));
			app.draw();
		},
		announce: (announcement) => {
			// An interactive run: the advice names the screens, never CLI flags (C3-64).
			app.run.announcement = {
				...announcement,
				suggestions: announcement.suggestions.map(interactiveSuggestion),
			};
			app.draw();
		},
		finish: async (outcome, context) => {
			stopTick();
			app.run.outcome = outcome;
			app.run.preparing = false;
			await showDone(
				{
					kind: 'run',
					outcome,
					mode: context.mode,
					rootVerified: context.rootVerified,
					shownOnce: app.run.shownOnce,
					ending: context.ending,
				},
				outcome.exitCode,
				// Left on the main screen after the UI closes: the To-do too (campaign 3c D5).
				// …and the developer route's served block: the URL must outlive the UI (TODO-053).
				outcome.exitCode === 0
					? [...servedLines(context.ending), ...todoLines(context.ending)]
					: [...outcome.hint],
			);
		},
	};
}
