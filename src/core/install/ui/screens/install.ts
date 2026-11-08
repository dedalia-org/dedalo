/**
 * THE INSTALL SCREEN (terminal installer phase 3, 2026-10-12) — the run as the
 * executor tells it (run_events.ts StepEvent): one row per planned step with
 * its state (· pending, ◐ running, ✓ done, ↷ verified from an earlier run, ✗
 * failed, ↺ undone) and its elapsed time in a fixed right-hand slot (it fits
 * 80 columns), the step's warnings under it, the running step's latest log
 * line, the failure's message and resume hint, the plan's notes — and `l`, the
 * whole (sanitized, redacted) log. The step list comes from scripts/install.ts
 * (RunReporter.begin): this screen knows no step table.
 */

import { sanitizeLine } from '../../display_text.ts';
import type { RunAnnouncement, RunOutcomeView, StepEvent } from '../../run_events.ts';
import { DONE_TEXT } from '../../screen_text.ts';
import type { PaneModel } from '../frame.ts';
import type { Role } from '../palette.ts';
import { type Line, seg, spread } from '../styled.ts';
import { wrapped } from '../widgets/field_parts.ts';
import { BLANK } from '../widgets/notices.ts';

export type StepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed' | 'undone';

export interface StepRow {
	id: string;
	label: string;
	status: StepStatus;
	elapsedMs: number | null;
	/** When the RUNNING step started (ms epoch): its time counts up live (campaign C4 S4). */
	startedAt?: number;
	warnings: string[];
	message: string | null;
}

/** The run as the Install screen draws it. */
export interface RunView {
	preparing: boolean;
	steps: StepRow[];
	announcement: RunAnnouncement | null;
	/** The latest log line (shown under the running step). */
	lastLog: string | null;
	/** The generated secret lines (shown once, in the accent box, from when they arrive). */
	shownOnce: readonly string[];
	outcome: RunOutcomeView | null;
	showLog: boolean;
}

export function newRunView(): RunView {
	return {
		preparing: true,
		steps: [],
		announcement: null,
		lastLog: null,
		shownOnce: [],
		outcome: null,
		showLog: false,
	};
}

/** What each event phase makes of a row. */
const PHASE_STATUS: Readonly<Record<StepEvent['phase'], StepStatus>> = Object.freeze({
	start: 'running',
	skipped: 'skipped',
	adopted: 'skipped',
	done: 'done',
	failed: 'failed',
	interrupted: 'failed',
	undo: 'undone',
});

/** One event applied (an unknown step — an abort's undo — joins the list). */
export function applyStepEvent(run: RunView, event: StepEvent, now: number = Date.now()): void {
	run.preparing = false;
	let row = run.steps.find((item) => item.id === event.step);
	if (row === undefined) {
		row = {
			id: event.step,
			label: event.label,
			status: 'pending',
			elapsedMs: null,
			warnings: [],
			message: null,
		};
		run.steps.push(row);
	}
	row.status = PHASE_STATUS[event.phase];
	row.startedAt = row.status === 'running' ? now : undefined;
	row.elapsedMs = event.elapsedMs ?? row.elapsedMs;
	row.warnings = [...(event.warnings ?? row.warnings)].map(sanitizeLine);
	row.message = event.message === undefined ? row.message : sanitizeLine(event.message);
}

const MARK: Readonly<Record<StepStatus, [string, Role]>> = Object.freeze({
	pending: ['·', 'faint'],
	running: ['◐', 'accent'],
	done: ['✓', 'ok'],
	skipped: ['↷', 'ok'],
	failed: ['✗', 'err'],
	undone: ['↺', 'warn'],
});

/** `12.3s` / `2m 05s` in a 7-column slot. */
export function elapsedText(ms: number | null): string {
	if (ms === null) return ''.padStart(7);
	const seconds = ms / 1000;
	const text =
		seconds < 60
			? `${seconds.toFixed(1)}s`
			: `${Math.floor(seconds / 60)}m ${String(Math.floor(seconds % 60)).padStart(2, '0')}s`;
	return text.padStart(7);
}

/**
 * The time a row shows: a running step's counts up from its start (campaign
 * C4 S4: ten minutes of `host_packages` on a slow host read as a hang), a
 * finished one's is the executor's measure.
 */
function shownElapsed(row: StepRow, now: number): number | null {
	return row.status === 'running' && row.startedAt !== undefined
		? Math.max(0, now - row.startedAt)
		: row.elapsedMs;
}

/** A step row and what hangs under it. */
function stepLines(row: StepRow, lastLog: string | null, width: number, now: number): Line[] {
	const [glyph, role] = MARK[row.status];
	const labelRole: Role = row.status === 'pending' ? 'faint' : 'text';
	const line = spread(
		[
			seg(`${glyph} `, role),
			seg(sanitizeLine(row.label), labelRole, { bold: row.status === 'running' }),
		],
		[seg(elapsedText(shownElapsed(row, now)), 'muted')],
		width,
	);
	const running =
		row.status === 'running' && lastLog !== null
			? wrapped(lastLog.trim(), width, 'faint', '    ')
			: [];
	const warned = row.warnings.flatMap((warning) => wrapped(`! ${warning}`, width, 'warn', '    '));
	return [line, ...running.slice(0, 2), ...warned];
}

/** The plan's notes, warnings and suggestions above the steps. */
function announcementLines(announcement: RunAnnouncement | null, width: number): Line[] {
	if (announcement === null) return [];
	return [
		[seg(sanitizeLine(announcement.title), 'accent', { bold: true })],
		...announcement.notes.flatMap((note) => wrapped(`note: ${note}`, width, 'muted')),
		...announcement.warnings.flatMap((warning) => wrapped(`! ${warning}`, width, 'warn')),
		...announcement.suggestions.flatMap((item) => wrapped(`suggestion: ${item}`, width, 'info')),
		BLANK,
	];
}

/** The generated secret, shown once. */
export function shownOnceLines(lines: readonly string[], width: number): Line[] {
	if (lines.length === 0) return [];
	return [
		BLANK,
		[seg('! shown ONCE — copy it now; it is not printed again', 'warn', { bold: true })],
		...lines.flatMap((line) => wrapped(line.trim(), width, 'accent', '  ')),
	];
}

/** The failure panel: the message, the resume hint. */
function failureLines(outcome: RunOutcomeView | null, width: number): Line[] {
	if (outcome === null || outcome.exitCode === 0) return [];
	return [
		BLANK,
		...wrapped(`✗ ${DONE_TEXT.failure(outcome)}`, width, 'err'),
		...outcome.hint.flatMap((line) => wrapped(line, width, 'muted')),
	];
}

/** The whole log (`l`), newest at the bottom. */
function logPane(log: readonly string[], width: number): PaneModel {
	const lines = log.map((line) => [seg(cutWidth(line, width), 'muted')] as Line);
	return { title: 'Install — log', lines, focus: Math.max(0, lines.length - 1) };
}

/** The step rows, and the row to keep in view (the running or failed one). */
function stepRows(
	run: RunView,
	width: number,
	offset: number,
	now: number,
): { lines: Line[]; focus: number } {
	const lines: Line[] = [];
	let focus = offset;
	for (const row of run.steps) {
		if (row.status === 'running' || row.status === 'failed') focus = offset + lines.length;
		lines.push(...stepLines(row, run.lastLog, width, now));
	}
	return { lines, focus };
}

const PREPARING: Line = [seg('◐ preparing the install (catalog, environment)…', 'accent')];

/** The Install pane (or the whole log, `l`). */
export function installPane(
	run: RunView,
	log: readonly string[],
	width: number,
	now: number = Date.now(),
): PaneModel {
	if (run.showLog) return logPane(log, width);
	const head = [
		...announcementLines(run.announcement, width),
		...(run.preparing ? [PREPARING] : []),
	];
	const rows = stepRows(run, width, head.length, now);
	const tail = [...failureLines(run.outcome, width), ...shownOnceLines(run.shownOnce, width)];
	const lines = [...head, ...rows.lines, ...tail];
	// A failure or a shown-once secret is what must be read: keep the end in view.
	return { title: 'Installing', lines, focus: tail.length > 0 ? lines.length - 1 : rows.focus };
}

function cutWidth(line: string, width: number): string {
	return Array.from(line).slice(0, width).join('');
}

/** The header's status: where the run is. */
export function runStatus(run: RunView): Line {
	const done = run.steps.filter(
		(row) => row.status !== 'pending' && row.status !== 'running',
	).length;
	if (run.outcome !== null) {
		return run.outcome.exitCode === 0
			? [seg('● ', 'ok'), seg('finished', 'muted')]
			: [seg('● ', 'err'), seg('stopped', 'muted')];
	}
	return [
		seg('◐ ', 'accent'),
		seg(
			run.preparing
				? 'preparing'
				: `step ${Math.min(done + 1, run.steps.length)} of ${run.steps.length}`,
			'muted',
		),
	];
}
