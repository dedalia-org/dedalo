/**
 * THE RUNNING STEP'S TIME COUNTS UP (install campaign C4, U26x86 F7): on an
 * emulated host `host_packages` ran ten minutes with one static line — no
 * way to tell progress from a hang. The Install screen now shows a running
 * step's time since its start (redrawn every RUN_TICK_MS), and a finished
 * step keeps the executor's measure. Measured on the drawn pane.
 */

import { describe, expect, test } from 'bun:test';
import type { StepEvent } from '../../src/core/install/run_events.ts';
import { RUN_TICK_MS } from '../../src/core/install/ui/reporter.ts';
import {
	applyStepEvent,
	installPane,
	newRunView,
} from '../../src/core/install/ui/screens/install.ts';

const text = (pane: ReturnType<typeof installPane>): string =>
	pane.lines.map((line) => line.map((segment) => segment.text).join('')).join('\n');

const event = (phase: StepEvent['phase'], elapsedMs?: number): StepEvent =>
	({ step: 'host_packages', label: 'packages', phase, elapsedMs }) as StepEvent;

describe('the Install screen clock', () => {
	test('a running step shows the time since it started, live', () => {
		const run = newRunView();
		applyStepEvent(run, event('start'), 1_000);
		expect(text(installPane(run, [], 80, 1_000 + 125_000))).toContain('2m 05s');
		expect(text(installPane(run, [], 80, 1_000 + 3_500))).toContain('3.5s');
		expect(RUN_TICK_MS).toBeLessThanOrEqual(1_000);
	});

	test("a finished step shows the executor's measure, never the wall clock", () => {
		const run = newRunView();
		applyStepEvent(run, event('start'), 1_000);
		applyStepEvent(run, event('done', 42_000), 50_000);
		expect(run.steps[0]?.startedAt).toBeUndefined();
		const drawn = text(installPane(run, [], 80, 999_999));
		expect(drawn).toContain('42.0s');
	});
});
