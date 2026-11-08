/**
 * THE FULL-SCREEN INSTALLER'S FRAMES (terminal installer phase 3, 2026-10-12;
 * `src/core/install/ui/`) — the approved mockup's layout, measured on the
 * frames OpenTUI's test renderer draws at the three sizes the UI supports
 * (104×30 the mockup's, 96×27, 80×24 the minimum):
 *
 *  - the LOGO: Welcome and Done at ≥ 30 rows draw 16 consecutive half-block
 *    rows; below 30 rows none, and the header carries the `▟▙ Dédalo
 *    installer` mark instead;
 *  - the HEADER holds the route chip (ROUTE_TEXT's label);
 *  - the RAIL: exactly one `›` (the current screen), `✓` per walked screen,
 *    `·` per pending one, the titles the MODEL's screens of the route in
 *    SCREEN_ORDER (whole, or cut with `…`) then Install and Done; compact
 *    (marks and numbers) below 96 columns;
 *  - NOTHING OVERFLOWS: the pane's right border is `│` on every pane row, the
 *    footer's hints are whole (never cut), every visible question's label is
 *    drawn whole;
 *  - the CHECKLIST: a filter leaves only the matching rows; the dependency
 *    words (`also installs`, `recommended by`), `declined` and `Empty — you
 *    fill it` are drawn;
 *  - the INSTALL screen: ✓ / ◐ / ✗ rows with the elapsed time right-aligned
 *    (`12.3s`) at 80 columns; a failed run's Done card shows the message and
 *    the resume hint;
 *  - the RESUME screen offers resume / abort / quit (abort only when it can);
 *  - NO_COLOR draws at most two foreground colours (Welcome and logo included);
 *  - a RESIZE below 80×24 draws the too-small notice and leaves the question
 *    pending; back to 104×30 the question is drawn again.
 *
 * DB-free; nothing written.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REVIEW_TODO_BLOCK } from '../../src/core/install/display_text.ts';
import { hostReview } from '../../src/core/install/host/host_table.ts';
import { REVIEW_TODO_STEP } from '../../src/core/install/host/review.ts';
import { type InstallRoute, normalizeInstallAnswers } from '../../src/core/install/install_plan.ts';
import { resolveOntologyCatalog } from '../../src/core/install/ontology_catalog.ts';
import type { ReviewView, ScreenView } from '../../src/core/install/prompter_contract.ts';
import {
	buildScreens,
	passwordFeedback,
	type Question,
	RECOMMENDED_ROUTE,
	SCREEN_ORDER,
	type Screen,
} from '../../src/core/install/screen_model.ts';
import { ACKNOWLEDGE_TEXT, ROUTE_TEXT } from '../../src/core/install/screen_text.ts';
import { reviewPage } from '../../src/core/install/ui/screens/review.ts';
import { hostCommandLines } from '../../src/core/install/ui_plain/prompter.ts';
import { localOntologySource } from '../helpers/install_answer_cases.ts';
import {
	HOST_VARIANTS,
	productionPlanCtx,
	productionRaw,
} from '../helpers/install_host_scratch.ts';
import { modelInput, thesaurusOffer } from '../helpers/install_plain_script.ts';
import { openRig, type TuiRig } from '../helpers/install_tui_driver.ts';

/** The engine-only ending (these runs are engine runs). */
const ENGINE_ENDING = { route: 'engine', instance: '', keptLive: false } as const;

const scratchRoot = mkdtempSync(join(tmpdir(), 'dedalo_install_tui_frames_'));

/** The local ontology source, written into THIS gate's mkdtemp (the helper only returns bytes). */
function writeSource(dir: string, files = localOntologySource()): string {
	mkdirSync(dir, { recursive: true });
	for (const [name, bytes] of files) writeFileSync(join(dir, name), bytes);
	return dir;
}

afterAll(() => rmSync(scratchRoot, { recursive: true, force: true }));
const SOURCE_DIR = writeSource(join(scratchRoot, 'ontology_source'));
const LOCAL = await resolveOntologyCatalog(
	{ kind: 'local', path: SOURCE_DIR },
	{ allowedServers: [] },
);
afterAll(() => LOCAL.cleanup());

const SIZES = [
	[104, 30],
	[96, 27],
	[80, 24],
] as const;

/** The model's screens of `route` (the local fixture catalog: zzsma, zzsmb). */
function screensOf(route: InstallRoute, raw: Record<string, unknown> = {}): Screen[] {
	return buildScreens(
		modelInput(
			{ route, ontology_source: SOURCE_DIR, ontologies: 'zzsma', ...raw },
			{
				catalogs: {
					ontology: { catalog: LOCAL.catalog, ok: true, detail: '' },
					thesauri: thesaurusOffer(),
				},
			},
		),
	);
}

/** The walker's view at screen `id` (every screen before it walked). */
function viewAt(route: InstallRoute, id: string, raw: Record<string, unknown> = {}): ScreenView {
	const screens = screensOf(route, raw);
	const at = screens.findIndex((screen) => screen.id === id);
	return {
		screen: screens[at] as Screen,
		screens: screens.map((screen) => ({
			id: screen.id,
			title: screen.title,
			index: screen.index,
			placeholder: screen.placeholder !== undefined,
		})),
		seen: screens.slice(0, at).map((screen) => screen.id),
		focus: null,
		probing: false,
		route,
	};
}

const question = (view: ScreenView, id: string): Question =>
	view.screen.questions.find((item) => item.id === id) as Question;

const rowsOf = (frame: string): string[] => frame.split('\n');
/** The logo's cells: half blocks and full blocks (two lit pixels). */
const LOGO_CELLS = /[▀▄█]/;
/** The card's logo column (the card border, its padding, 30 columns of logo). */
const logoColumn = (row: string): string => Array.from(row).slice(3, 36).join('');

/** The longest run of consecutive rows holding a logo cell in the logo column. */
function logoRun(frame: string): number {
	let best = 0;
	let run = 0;
	for (const row of rowsOf(frame)) {
		run = LOGO_CELLS.test(logoColumn(row)) ? run + 1 : 0;
		best = Math.max(best, run);
	}
	return best;
}

/** The pane's rows: from its top border (`╭`… `╮` right of the rail) to its bottom. */
function paneRows(frame: string): { rows: string[][]; right: number } {
	const rows = rowsOf(frame).map((row) => Array.from(row));
	const top = rows.findIndex((row) => row.lastIndexOf('╮') > row.indexOf('╮'));
	const topRow = rows[top] as string[];
	const right = topRow.lastIndexOf('╮');
	const bottom = rows.findIndex((row, index) => index > top && row[right] === '╯');
	return { rows: rows.slice(top + 1, bottom), right };
}

/** Every structural check of a framed (rail + pane) screen. */
function expectFramed(frame: string, cols: number, rail: 'full' | 'compact'): void {
	const { rows, right } = paneRows(frame);
	expect(rows.length).toBeGreaterThan(10);
	for (const row of rows) expect(row[right], row.join('')).toBe('│');
	// The rail: one current mark.
	expect(frame.split('›').length - 1).toBe(1);
	const footer =
		rowsOf(frame)
			.filter((row) => row.trim() !== '')
			.at(-1) ?? '';
	expect(footer.includes('…'), footer).toBe(false);
	expect(footer.trim().length).toBeGreaterThan(5);
	expect(Array.from(rowsOf(frame)[0] ?? '').length).toBe(cols);
	if (rail === 'compact') expect(frame).not.toContain(' steps ');
	else expect(frame).toContain(' steps ');
}

async function withRig(
	size: readonly [number, number],
	work: (rig: TuiRig) => Promise<void>,
	options: { noColor?: boolean } = {},
): Promise<void> {
	const rig = await openRig({ width: size[0], height: size[1], noColor: options.noColor ?? false });
	try {
		await work(rig);
		expect(rig.errors).toEqual([]);
	} finally {
		try {
			await rig.dispose();
		} catch {
			// a Done screen's close already destroyed the renderer
		}
	}
}

// ── the logo ─────────────────────────────────────────────────────────────────

describe('the logo: Welcome and Done at 30 rows, the header mark below (a)', () => {
	for (const size of SIZES) {
		test(`Welcome at ${size[0]}×${size[1]}`, async () => {
			await withRig(size, async (rig) => {
				void rig.front.prompter.welcome({ version: '7.0.0-test' });
				const frame = await rig.frame();
				expect(frame).toContain('Welcome to Dédalo');
				if (size[1] >= 30) expect(logoRun(frame)).toBeGreaterThanOrEqual(16);
				else {
					expect(logoRun(frame)).toBe(0);
					expect(frame).toContain('▟▙ Dédalo installer');
				}
			});
		});
	}

	for (const size of [SIZES[0], SIZES[2]] as const) {
		test(`Done at ${size[0]}×${size[1]}`, async () => {
			await withRig(size, async (rig) => {
				rig.front.reporter.begin?.([{ id: 'test_db_connection', label: 'Database reachable' }]);
				void rig.front.reporter.finish(
					{ exitCode: 0, result: 'complete', message: null, failedStep: null, hint: [] },
					{ mode: 'fresh', rootVerified: true, ending: ENGINE_ENDING },
				);
				const frame = await rig.frame();
				expect(frame).toContain('Dédalo is installed');
				expect(frame).toContain('Maintenance');
				if (size[1] >= 30) expect(logoRun(frame)).toBeGreaterThanOrEqual(16);
				else {
					expect(logoRun(frame)).toBe(0);
					expect(frame).toContain('▟▙ Dédalo installer');
				}
			});
		});
	}
});

// ── header, rail, overflow ───────────────────────────────────────────────────

describe('the frame: header chip, rail, no overflow (b)', () => {
	for (const size of SIZES) {
		test(`production Database screen at ${size[0]}×${size[1]}`, async () => {
			await withRig(size, async (rig) => {
				const view = viewAt('production', 'database', { instance: 'prado' });
				rig.front.prompter.view(view);
				void rig.front.prompter.text(question(view, 'database.db_database'));
				const frame = await rig.frame();
				const full = size[0] >= 96;
				expectFramed(frame, size[0], full ? 'full' : 'compact');
				expect(rowsOf(frame)[0]).toContain(ROUTE_TEXT.production.label);
				expect(rowsOf(frame)[0]).toContain('▟▙');
				// The rail: walked ✓, pending ·, the model's titles in SCREEN_ORDER.
				const order = SCREEN_ORDER.production;
				expect(view.screens.map((screen) => screen.id)).toEqual([...order]);
				const at = order.indexOf('database');
				const railRows = rowsOf(frame).filter((row) => /[✓›·–] {1,2}\d/.test(row));
				expect(railRows.length).toBe(order.length + 2);
				railRows.forEach((row, index) => {
					const mark = /([✓›·–]) {1,2}\d/.exec(row)?.[1];
					if (index < at) expect(mark, row).toBe('✓');
					else if (index === at) expect(mark, row).toBe('›');
					else expect(mark, row).toBe('·');
					if (!full) return;
					const title =
						index < order.length
							? (view.screens[index]?.title ?? '')
							: (['Install', 'Done'][index - order.length] ?? '');
					const drawn = (/[✓›·–] {1,2}\d+ (.+?)\s*│/.exec(row)?.[1] ?? '').trim();
					expect(
						drawn === title || (drawn.endsWith('…') && title.startsWith(drawn.slice(0, -1))),
						`${drawn} ~ ${title}`,
					).toBe(true);
				});
				// Every visible question's label, whole.
				for (const item of view.screen.questions)
					expect(frame, item.label).toContain(item.label.slice(0, 17));
			});
		});
	}
});

// ── the checklist ────────────────────────────────────────────────────────────

describe('the checklist: filter, marks, declined, Empty (c)', () => {
	test('ontologies filtered to zzsm; dependency words; zzsmb declined', async () => {
		await withRig(SIZES[0], async (rig) => {
			const view = viewAt('developer', 'ontologies');
			rig.front.prompter.view(view);
			const multi = question(view, 'ontologies.ontologies');
			void rig.front.prompter.multi(multi);
			await rig.setup.mockInput.typeText('zzsm');
			let frame = await rig.frame();
			const rows = rowsOf(frame).filter((row) => /[◻◼■] \S/.test(row));
			expect(rows.length).toBe(2);
			expect(rows.every((row) => row.includes('zzsm'))).toBe(true);
			expect(frame).toContain('also installs zzsmb');
			expect(frame).toContain('recommended by zzsma');
			// Untick zzsmb: declined.
			rig.setup.mockInput.pressArrow('down');
			rig.setup.mockInput.pressKey(' ');
			frame = await rig.frame();
			expect(rowsOf(frame).find((row) => row.includes('◻ zzsmb'))).toContain('declined');
			expectFramed(frame, 104, 'full');
		});
	});

	test('thesauri: an Empty thesaurus says so', async () => {
		await withRig(SIZES[0], async (rig) => {
			const view = viewAt('developer', 'thesauri');
			rig.front.prompter.view(view);
			void rig.front.prompter.multi(question(view, 'thesauri.hierarchies'));
			await rig.setup.mockInput.typeText('htoponymy');
			expect(await rig.frame()).toContain('Empty — you fill it');
		});
	});
});

// ── the run ──────────────────────────────────────────────────────────────────

describe('the Install screen and a failed Done card at 80 columns (d)', () => {
	test('✓ ◐ ✗ rows with elapsed times; the failure message and hint', async () => {
		await withRig(SIZES[2], async (rig) => {
			const reporter = rig.front.reporter;
			const steps = [
				['test_db_connection', 'Database reachable'],
				['persist_config', 'Write the configuration (.env) of this install'],
				['install_db_from_default_file', 'Restore the core seed'],
				['install_ontologies', 'Install the ontologies'],
			] as const;
			reporter.begin?.(steps.map(([id, label]) => ({ id, label })));
			const event = (
				step: (typeof steps)[number],
				phase: 'start' | 'done' | 'failed',
				elapsedMs: number | null,
				message?: string,
			) =>
				reporter.io.step?.({
					step: step[0],
					label: step[1],
					phase,
					elapsedMs,
					...(message === undefined ? {} : { message }),
				});
			event(steps[0], 'start', null);
			event(steps[0], 'done', 12345);
			event(steps[1], 'start', null);
			event(steps[1], 'done', 800);
			event(steps[2], 'start', null);
			let frame = await rig.frame();
			expect(frame).toContain('✓ Database reachable');
			expect(frame).toContain('◐ Restore the core seed');
			const stepRows = rowsOf(frame)
				.map((row) => row.replace(/\s*│\s*$/, ''))
				.filter((row) => /[✓◐✗·] \S/.test(row) && /\d+(\.\d)?s$/.test(row));
			// The two finished rows AND the running one (its time counts up — campaign C4 S4).
			expect(stepRows.length).toBe(3);
			expect(stepRows.some((row) => row.endsWith('12.3s'))).toBe(true);
			expect(stepRows.some((row) => row.endsWith('0.8s'))).toBe(true);
			expectFramed(frame, 80, 'compact');
			event(steps[2], 'failed', 300, 'pg_restore exited 1: role "x" does not exist');
			frame = await rig.frame();
			expect(frame).toContain('✗ Restore the core seed');
			void reporter.finish(
				{
					exitCode: 1,
					result: 'failed',
					message: 'pg_restore exited 1: role "x" does not exist',
					failedStep: 'install_db_from_default_file',
					hint: ['resume: bun run scripts/install.ts --resume'],
				},
				{ mode: 'fresh', rootVerified: false, ending: ENGINE_ENDING },
			);
			frame = await rig.frame();
			expect(frame).toContain('The install stopped');
			expect(frame).toContain('pg_restore exited 1');
			expect(frame).toContain('--resume');
		});
	});
});

// ── the Review's host commands (phase 4) ─────────────────────────────────────

describe("the Review shows every host step's exact commands (h)", () => {
	test('production: each step and its commands, in the full-screen Review and the plain one', async () => {
		const ctx = productionPlanCtx(HOST_VARIANTS[0] as (typeof HOST_VARIANTS)[number]);
		const blocks = hostReview(ctx);
		expect(blocks.length).toBe(ctx.plan.steps.length);
		const screens = screensOf(
			'production',
			productionRaw(HOST_VARIANTS[0] as (typeof HOST_VARIANTS)[number]),
		);
		const view: ReviewView = {
			screen: screens.at(-1) as Screen,
			lines: [{ label: 'Route', value: 'production' }],
			canInstall: true,
			editable: [{ n: 1, title: 'Install type' }],
			command: 'bun run scripts/install.ts --route production --instance demo',
			errors: [],
			hostCommands: blocks,
		};
		// Plain: every step's header and every command, verbatim.
		const plain = hostCommandLines(view);
		for (const block of blocks) {
			expect(plain).toContain(`[${block.step}] ${block.label}`);
			for (const command of block.commands) expect(plain).toContain(`    $ ${command}`);
		}
		// Full screen: a tall terminal shows the first steps' commands (the page scrolls for the rest).
		await withRig([110, 120], async (rig) => {
			void rig.front.prompter.review(view);
			const frame = await rig.frame();
			expect(frame).toContain('[host_preflight]');
			expect(frame).toContain('[host_packages]');
			expect(frame).toContain('$ /usr/bin/apt-get');
		});
	});
});

// ── resume ───────────────────────────────────────────────────────────────────

describe('the Resume screen (e)', () => {
	for (const canAbort of [true, false]) {
		test(`resume / ${canAbort ? 'abort / ' : ''}quit`, async () => {
			await withRig(SIZES[0], async (rig) => {
				void rig.front.prompter.resume({ database: 'dedalo_prado', outcome: 'failed', canAbort });
				const frame = await rig.frame();
				expect(frame).toContain("database 'dedalo_prado' was interrupted");
				expect(frame).toContain('Resume the install');
				expect(frame.includes('Abort it')).toBe(canAbort);
				expect(rig.front.prompter.pending()?.options).toEqual(
					canAbort ? ['resume', 'abort', 'quit'] : ['resume', 'quit'],
				);
			});
		});
	}
});

// ── NO_COLOR ─────────────────────────────────────────────────────────────────

/** The distinct foreground colours of a frame's spans. */
function foregrounds(rig: TuiRig): Set<string> {
	const colours = new Set<string>();
	for (const line of rig.setup.captureSpans().lines)
		for (const span of line.spans)
			if (span.text.trim() !== '') colours.add(JSON.stringify(span.fg));
	return colours;
}

describe('NO_COLOR: at most two foreground colours (f)', () => {
	test('the Welcome with the logo, and a question screen', async () => {
		await withRig(
			SIZES[0],
			async (rig) => {
				void rig.front.prompter.welcome({ version: '7.0.0-test' });
				await rig.frame();
				expect(logoRun(await rig.frame())).toBeGreaterThanOrEqual(16);
				expect(foregrounds(rig).size).toBeLessThanOrEqual(2);
				rig.setup.mockInput.pressEnter();
				const view = viewAt('developer', 'database');
				rig.front.prompter.view(view);
				void rig.front.prompter.text(question(view, 'database.db_database'));
				await rig.frame();
				expect(foregrounds(rig).size).toBeLessThanOrEqual(2);
			},
			{ noColor: true },
		);
	});

	test('CONTROL: with colour the same Welcome draws more than two', async () => {
		await withRig(SIZES[0], async (rig) => {
			void rig.front.prompter.welcome({ version: '7.0.0-test' });
			await rig.frame();
			expect(foregrounds(rig).size).toBeGreaterThan(2);
		});
	});
});

// ── resize ───────────────────────────────────────────────────────────────────

describe('a resize below the minimum (g)', () => {
	test('70×20: the notice, the question still pending; 104×30: drawn again', async () => {
		await withRig(SIZES[0], async (rig) => {
			const view = viewAt('developer', 'database');
			rig.front.prompter.view(view);
			let answered = false;
			void rig.front.prompter.text(question(view, 'database.db_database')).then(() => {
				answered = true;
			});
			rig.setup.resize(70, 20);
			let frame = await rig.frame();
			expect(frame).toContain('needs at least 80×24');
			expect(rig.front.prompter.pending()?.id).toBe('database.db_database');
			// Keys while only the notice is drawn answer nothing (never typed blind).
			rig.setup.mockInput.pressKey('x');
			rig.setup.mockInput.pressEnter();
			await rig.frame();
			expect(answered).toBe(false);
			expect(rig.front.prompter.pending()?.id).toBe('database.db_database');
			rig.setup.resize(104, 30);
			frame = await rig.frame();
			expect(frame).not.toContain('needs at least 80×24');
			expect(frame).toContain(question(view, 'database.db_database').label.slice(0, 17));
			expectFramed(frame, 104, 'full');
		});
	});
});

// ── the exits and the run's edges ────────────────────────────────────────────

const flushAsync = async (): Promise<void> => {
	for (let i = 0; i < 5; i++) await Bun.sleep(5);
};

describe('every message reaches the operator (h)', () => {
	test("a secret asked after the run began is drawn (a resume's missing password)", async () => {
		await withRig(SIZES[0], async (rig) => {
			rig.front.reporter.prepare?.();
			void rig.front.prompter.secret(
				{
					id: 'secret.root_password',
					key: 'root_password',
					sets: [],
					kind: 'secret',
					label: 'Administrator password',
					description: 'never echoed',
					value: null,
					default: '',
					answered: false,
					required: true,
					errors: [],
				},
				undefined,
			);
			expect(rig.front.prompter.pending()?.id).toBe('secret.root_password');
			const frame = await rig.frame();
			expect(frame).toContain('Administrator pass');
		});
	});

	test('what the session says while a page waits is drawn (a refused write on the Review)', async () => {
		await withRig(SIZES[0], async (rig) => {
			const screens = screensOf('docker');
			const review = screens.find((screen) => screen.id === 'review') as Screen;
			void rig.front.prompter.review({
				screen: review,
				lines: [],
				canInstall: false,
				editable: [],
				command: 'bun run scripts/install.ts --route docker',
				errors: [],
			});
			let frame = await rig.frame();
			expect(frame).not.toContain('cannot write /nope');
			rig.front.prompter.say(['cannot write /nope/x.json: no such directory']);
			frame = await rig.frame();
			expect(frame).toContain('cannot write /nope/x.json');
		});
	});

	test('the quit overlay over an unfinished install says it is KEPT', async () => {
		await withRig(SIZES[0], async (rig) => {
			void rig.front.prompter.resume({
				database: 'dedalo_prado',
				outcome: 'failed',
				canAbort: true,
			});
			rig.setup.mockInput.pressKey('q', { ctrl: true });
			const frame = await rig.frame();
			expect(frame).toContain('unfinished install is kept');
			expect(frame).not.toContain('Nothing has been installed');
		});
	});

	test('CONTROL: the quit overlay of a fresh walk says nothing was installed', async () => {
		await withRig(SIZES[0], async (rig) => {
			const view = viewAt('developer', 'database');
			rig.front.prompter.view(view);
			void rig.front.prompter.text(question(view, 'database.db_database'));
			rig.setup.mockInput.pressKey('q', { ctrl: true });
			const frame = await rig.frame();
			expect(frame).toContain('Nothing has been installed');
		});
	});

	test('Ctrl-C on a FAILED Done card: exit 1 (not 130), the summary and resume hint printed', async () => {
		await withRig(SIZES[0], async (rig) => {
			rig.front.reporter.begin?.([
				{ id: 'install_db_from_default_file', label: 'Restore the core seed' },
			]);
			void rig.front.reporter.finish(
				{
					exitCode: 1,
					result: 'failed',
					message: 'pg_restore exited 1',
					failedStep: 'install_db_from_default_file',
					hint: ['resume: bun run scripts/install.ts --resume'],
				},
				{ mode: 'fresh', rootVerified: false, ending: ENGINE_ENDING },
			);
			await rig.frame();
			rig.setup.mockInput.pressKey('c', { ctrl: true });
			await flushAsync();
			await Bun.sleep(50);
			expect(rig.port.exits).toEqual([1]);
			const printed = rig.port.errs.join('');
			expect(printed).toContain('install failed at step [install_db_from_default_file]');
			expect(printed).toContain('--resume');
		});
	});

	test('a SIGTERM on a complete Done card: exit 0 with the summary', async () => {
		await withRig(SIZES[0], async (rig) => {
			void rig.front.reporter.finish(
				{ exitCode: 0, result: 'complete', message: null, failedStep: null, hint: [] },
				{ mode: 'fresh', rootVerified: true, ending: ENGINE_ENDING },
			);
			await rig.frame();
			rig.port.fire('SIGTERM');
			await flushAsync();
			await Bun.sleep(50);
			expect(rig.port.exits).toEqual([0]);
			expect(rig.port.errs.join('')).toContain('✔');
		});
	});

	test('the salt shown during a run that then FAILED is on the failed card', async () => {
		await withRig(SIZES[0], async (rig) => {
			rig.front.reporter.begin?.([
				{ id: 'install_db_from_default_file', label: 'Restore the core seed' },
			]);
			rig.front.reporter.io.showOnce?.(['salt: s3cr3t-salt-value']);
			void rig.front.reporter.finish(
				{
					exitCode: 1,
					result: 'failed',
					message: 'state write failed',
					failedStep: null,
					hint: [],
				},
				{ mode: 'fresh', rootVerified: false, ending: ENGINE_ENDING },
			);
			const frame = await rig.frame();
			expect(frame).toContain('The install stopped');
			expect(frame).toContain('s3cr3t-salt-value');
		});
	});

	test('an interrupt outside any step: its lines reach the restored screen', async () => {
		await withRig(SIZES[0], async (rig) => {
			const io = rig.front.reporter.io;
			rig.front.reporter.prepare?.();
			io.warn('before the interrupt: log only');
			io.interrupted?.('SIGINT');
			io.warn('✖ install interrupted (SIGINT)');
			io.warn('resume: bun run scripts/install.ts --resume');
			void rig.front.close(130);
			await flushAsync();
			await Bun.sleep(50);
			const printed = rig.port.errs.join('');
			expect(printed).toContain('install interrupted (SIGINT)');
			expect(printed).toContain('--resume');
			expect(printed).not.toContain('before the interrupt');
		});
	});
});

describe('a UI whose first draw throws gives everything back (i)', () => {
	test('console methods and process listeners restored; the error rethrown', async () => {
		const { createTestRenderer } = await import('@opentui/core/testing');
		const { openTuiOn } = await import('../../src/core/install/ui/app.ts');
		const { fakePort } = await import('../helpers/install_tui_driver.ts');
		const setup = await createTestRenderer({ width: 104, height: 30 });
		const port = fakePort();
		const before = { log: console.log, warn: console.warn, error: console.error };
		const add = setup.renderer.root.add.bind(setup.renderer.root);
		setup.renderer.root.add = () => {
			throw new Error('draw boom');
		};
		try {
			expect(() =>
				openTuiOn(setup.renderer, { version: '7.0.0-test', noColor: false, port }),
			).toThrow('draw boom');
			expect({ log: console.log, warn: console.warn, error: console.error }).toEqual(before);
			const left = [...port.listeners.entries()].filter(([, list]) => list.length > 0);
			expect(left.map(([event]) => event)).toEqual([]);
			// CONTROL: a UI that opens holds them.
			setup.renderer.root.add = add;
			const opened = openTuiOn(setup.renderer, { version: '7.0.0-test', noColor: false, port });
			expect(console.log).not.toBe(before.log);
			expect([...port.listeners.values()].some((list) => list.length > 0)).toBe(true);
			opened.dispose();
			expect(console.log).toBe(before.log);
		} finally {
			setup.renderer.root.add = add;
			await setup.dispose();
		}
	});
});

// ── campaign 3 (P5): what the full screen draws matches what it takes ────────

describe('campaign 3: the full screen says what its controls do (C3-26, C3-47, C3-48, C3-49, C3-58)', () => {
	test('C3-26: an acknowledgement draws its how-to and takes a TYPED yes (as plain mode does), or Space', async () => {
		for (const how of ['typed', 'space', 'none'] as const) {
			await withRig(SIZES[0], async (rig) => {
				const view = viewAt('trial', 'route', { route: 'trial' });
				rig.front.prompter.view(view);
				const answer = rig.front.prompter.acknowledge(
					question(view, 'route.trial_no_media_protection'),
				);
				const frame = await rig.frame();
				expect(frame).toContain(ACKNOWLEDGE_TEXT.tick);
				// the how-to line, whole or wrapped: its first words are drawn
				expect(frame).toContain(ACKNOWLEDGE_TEXT.full.slice(0, 30));
				expect(rig.front.prompter.pending()?.kind).toBe('acknowledge');
				if (how === 'typed') await rig.setup.mockInput.typeText('yes');
				if (how === 'space') rig.setup.mockInput.pressKey(' ');
				if (how !== 'none') {
					expect(rig.front.prompter.pending()?.selected).toEqual(['yes']);
					expect(await rig.frame()).toContain('◼ ');
				}
				rig.setup.mockInput.pressEnter();
				expect(await answer, how).toBe(how !== 'none');
			});
		}
	});

	test('C3-47: a pre-filled default is REPLACED by the first typed key, kept by Enter, edited by Backspace', async () => {
		await withRig(SIZES[0], async (rig) => {
			const view = viewAt('trial', 'identity', { route: 'trial', entity: 'museo' });
			rig.front.prompter.view(view);
			const label = question(view, 'identity.entity_label');
			expect(label.default).toBe('museo');
			let answer = rig.front.prompter.text(label);
			await rig.setup.mockInput.typeText('Museo de prueba');
			rig.setup.mockInput.pressEnter();
			expect(await answer).toBe('Museo de prueba');
			// Enter alone keeps the default (plain mode's empty answer).
			answer = rig.front.prompter.text(label);
			await rig.frame();
			rig.setup.mockInput.pressEnter();
			expect(await answer).toBe('museo');
			// An editing key edits the default instead of replacing it.
			answer = rig.front.prompter.text(label);
			await rig.frame();
			rig.setup.mockInput.pressBackspace();
			await rig.setup.mockInput.typeText('X');
			rig.setup.mockInput.pressEnter();
			expect(await answer).toBe('museX');
		});
	});

	test('C3-58 / 3b N13: the route cursor rests on the RECOMMENDED route; the empty password field breaks no rule yet', async () => {
		await withRig(SIZES[0], async (rig) => {
			// Nothing chosen yet (no route in the answers).
			const screens = buildScreens(modelInput({}));
			const view: ScreenView = {
				screen: screens[0] as Screen,
				screens: screens.map((screen) => ({
					id: screen.id,
					title: screen.title,
					index: screen.index,
					placeholder: false,
				})),
				seen: [],
				focus: null,
				probing: false,
				route: null,
			};
			rig.front.prompter.view(view);
			void rig.front.prompter.choice(question(view, 'route.route'));
			await rig.frame();
			const pending = rig.front.prompter.pending();
			// Production, the recommended route — never the plan's Developer fallback (N13).
			expect(pending?.options?.[pending.cursor ?? -1]).toBe(RECOMMENDED_ROUTE);
			expect(RECOMMENDED_ROUTE).toBe('production');
			expect(ROUTE_TEXT[RECOMMENDED_ROUTE].badge).toContain('recommended');
			expect(normalizeInstallAnswers({}).answers.route).not.toBe(RECOMMENDED_ROUTE);
		});
		await withRig(SIZES[0], async (rig) => {
			const view = viewAt('developer', 'administrator');
			rig.front.prompter.view(view);
			void rig.front.prompter.secret(
				question(view, 'administrator.root_password'),
				passwordFeedback,
			);
			let frame = await rig.frame();
			const ruleRows = (text: string) =>
				rowsOf(text).filter((row) =>
					passwordFeedback('').rules.some((rule) => row.includes(rule.text.slice(0, 12))),
				);
			expect(ruleRows(frame).length).toBeGreaterThan(0);
			expect(ruleRows(frame).filter((row) => row.includes('✗'))).toEqual([]);
			// CONTROL: once typed, a broken rule is drawn ✗.
			await rig.setup.mockInput.typeText('a');
			frame = await rig.frame();
			expect(ruleRows(frame).some((row) => row.includes('✗'))).toBe(true);
		});
	});

	test('C3-58: the header of an unfinished install never says "nothing installed yet"', async () => {
		await withRig(SIZES[0], async (rig) => {
			void rig.front.prompter.resume({
				database: 'dedalo_dev',
				outcome: 'in_progress',
				canAbort: true,
			});
			const header = rowsOf(await rig.frame())[0] ?? '';
			expect(header).not.toContain('nothing installed yet');
			expect(header).toContain('an unfinished install is recorded');
		});
		// CONTROL: a fresh walk's header.
		await withRig(SIZES[0], async (rig) => {
			const view = viewAt('developer', 'database');
			rig.front.prompter.view(view);
			void rig.front.prompter.text(question(view, 'database.db_database'));
			expect(rowsOf(await rig.frame())[0]).toContain('nothing installed yet');
		});
	});

	test('C3-49 / 3b N18: a passed check carried onto the next screen keeps its warnings and verdict in view, headed by its screen', async () => {
		await withRig(SIZES[0], async (rig) => {
			rig.front.prompter.view(viewAt('production', 'system', { instance: 'mus' }));
			// A production check: the firewall WARNING comes early, a dozen ok rows after it.
			rig.front.prompter.say([
				'ok  Operating system  Ubuntu 26.04',
				'ok  Privilege  root',
				'warn: Firewall  ufw does not allow port 80 and 443 — sudo ufw allow 80,443/tcp',
				...Array.from({ length: 12 }, (_, index) => `ok  Row${index}  fine`),
				'System ready (1 warning).',
			]);
			const view = viewAt('production', 'identity', { instance: 'mus' });
			rig.front.prompter.view(view);
			void rig.front.prompter.text(question(view, 'identity.entity'));
			const rows = rowsOf(await rig.frame());
			const head = rows.findIndex((row) => row.includes('System check:'));
			const firewall = rows.findIndex((row) => row.includes('Firewall  ufw does not allow'));
			expect(head).toBeGreaterThan(-1);
			expect(firewall).toBe(head + 1);
			// Drawn with the screen's own mark, never the plain word (N36).
			expect(rows[firewall]).toContain('! Firewall');
			expect(rows[firewall]).not.toContain('warn:');
			expect(rows.some((row) => row.includes('System ready (1 warning).'))).toBe(true);
			// The ok rows stay on the check's own screen.
			expect(rows.some((row) => row.includes('Row11'))).toBe(false);
		});
	});

	test('3b N34: a screen whose check failed is drawn ✗ on the rail, and the check screen is current', async () => {
		await withRig(SIZES[0], async (rig) => {
			const base = viewAt('production', 'route', { instance: 'mus' });
			const system = base.screens.find((screen) => screen.id === 'system');
			rig.front.prompter.view({ ...base, seen: ['route', 'system'], failed: ['system'] });
			void rig.front.prompter.choice(question(base, 'route.route'));
			const rail =
				rowsOf(await rig.frame()).find((row) => row.includes(system?.title ?? '?')) ?? '';
			expect(rail).toContain('✗');
			expect(rail).not.toContain('✓');
		});
	});

	test('3b N35, N36: a failed check page names each hotkey’s own command, its rows drawn with ✗', async () => {
		await withRig(SIZES[0], async (rig) => {
			const view = viewAt('production', 'system', { instance: 'mus' });
			void rig.front.prompter.probe({
				screen: view.screen,
				lines: [
					'error: Operating system  Zz OS 1 is not supported',
					'This system cannot run this route.',
				],
				gate: 'must_pass',
				commands: ['quit'],
				prompt: 'quit, or back to choose another route',
			});
			const frame = await rig.frame();
			expect(frame).toContain('✗ Operating system');
			expect(frame).not.toContain('error: Operating system');
			const footer = rowsOf(frame).find((row) => row.includes('esc')) ?? '';
			expect(footer).not.toContain('q quit, or back');
			expect(footer).toContain('back to choose another route');
		});
	});

	test('3b N39: on a yes/no switch, y/n only choose — Enter answers', async () => {
		await withRig(SIZES[0], async (rig) => {
			const view = viewAt('developer', 'publication');
			rig.front.prompter.view(view);
			let settled = false;
			const answer = rig.front.prompter.confirm(question(view, 'publication.diffusion'));
			void answer.then(() => {
				settled = true;
			});
			await rig.frame();
			rig.setup.mockInput.pressKey('n');
			await rig.frame();
			expect(settled).toBe(false);
			expect(rig.front.prompter.pending()?.selected).toEqual(['no']);
			rig.setup.mockInput.pressKey('y');
			await rig.frame();
			expect(rig.front.prompter.pending()?.selected).toEqual(['yes']);
			rig.setup.mockInput.pressEnter();
			expect(await answer).toBe(true);
		});
	});

	test('the Review’s TO DO block is sentences to act on, never dressed as `$ <command>`', async () => {
		expect(REVIEW_TODO_BLOCK).toBe(REVIEW_TODO_STEP);
		const screens = screensOf(
			'production',
			productionRaw(HOST_VARIANTS[0] as (typeof HOST_VARIANTS)[number]),
		);
		const todo = 'open ports 80 and 443: sudo ufw allow 80,443/tcp';
		const view: ReviewView = {
			screen: screens.at(-1) as Screen,
			lines: [{ label: 'Route', value: 'production' }],
			canInstall: true,
			editable: [{ n: 1, title: 'Install type' }],
			command: 'sudo sh install.sh --route=production --instance=demo',
			errors: [],
			hostCommands: [
				{ step: REVIEW_TODO_STEP, label: 'TO DO YOURSELF', commands: [todo] },
				{ step: 'host_packages', label: 'packages', commands: ['/usr/bin/apt-get update'] },
			],
		};
		const plain = hostCommandLines(view);
		expect(plain).toContain(`    ${todo}`);
		expect(plain).not.toContain(`    $ ${todo}`);
		expect(plain).toContain('    $ /usr/bin/apt-get update');
		await withRig([110, 40], async (rig) => {
			void rig.front.prompter.review(view);
			const frame = await rig.frame();
			expect(frame).toContain('open ports 80 and 443');
			expect(frame).not.toContain('$ open ports');
			expect(frame).toContain('$ /usr/bin/apt-get update');
		});
	});

	test('C3-48: a fresh TLS & address screen draws no refusal before anything is typed', async () => {
		await withRig(SIZES[0], async (rig) => {
			const view = viewAt('docker', 'tls_address', { route: 'docker' });
			rig.front.prompter.view(view);
			void rig.front.prompter.text(question(view, 'tls_address.server_name'));
			const frame = await rig.frame();
			expect(frame).not.toContain('requires server_name');
			expect(frame).not.toContain('✗');
		});
	});
});

describe('campaign 3b: the Review says what `w` does (N29)', () => {
	test('`w` writes the answers AND ends the session: its key says so', () => {
		const screens = screensOf('trial');
		const view: ReviewView = {
			screen: screens.at(-1) as Screen,
			lines: [{ label: 'Route', value: 'trial' }],
			canInstall: true,
			editable: [],
			command: 'sh install.sh --route trial',
			errors: [],
			hostCommands: [],
		};
		const keys = reviewPage(view, () => undefined).keys();
		expect(keys).toContainEqual(['w', 'write answers and quit']);
	});
});
