/**
 * CAMPAIGN 3c — THE INSTALL FLOW AND ITS WORDS (the flow-text package of the
 * 2026-10-14 fix pass). Each block is an OUTCOME the VM runs measured wrong:
 *
 *  D2  what the run's preflight refuses is said BEFORE `yes` — the Review lists
 *      it as an error and does not offer install; measured again at the typed
 *      `yes` (the session stays on the Review, every answer kept); a refusal
 *      after the run started keeps the answers in a file + the command; an
 *      image version not the installer's is refused at the Image field; a
 *      published port already held is a stack preflight refusal.
 *  D3  every completing host run's To-do names the salt's read command — also
 *      when an earlier run showed it.
 *  D4  a gate made stale by a later screen is re-checked right after THAT
 *      screen, not before the Review.
 *  D5  the full-screen Done card (and the main screen after it) carries the
 *      To-do; the plain closing block too.
 *  D11 an engine child's interrupt is a sub-line, never a second ✖.
 *  D18 `back` from a failed check and forward again runs it again, rows once.
 *  D19 a word the failed check does not offer gets one plain sentence.
 *  D20 an ok row says its result once.
 *  D21 a plain `quit` prints the closing line the full screen prints.
 *  D22 a short System check is carried whole to the next screen.
 *  D10 the Review's [stack_image] line of a local build says how long.
 *  D23 the trial Review points at the Trial page, not Docker's.
 *
 * CAMPAIGN 3d (the VM re-test of this pass, 2026-10-14):
 *  C3d-F1 the System check (right after the name) fails an instance name an
 *         installed instance holds, naming its file; the session hands it the name.
 *  C3d-F2 `install` on a refused Review measures again — clear, it goes on to
 *         the yes; the words name that path ("install again (it checks first)",
 *         the CA refusal's "check again"), never "run this again".
 *  C3d-F3 the refused Review's key bar and action line say "check again",
 *         never "enter install".
 *
 * CAMPAIGN 3e (the second VM re-test, 2026-10-14):
 *  E1 a failed check that asks nothing (the System check): `edit` goes back to
 *     the screen whose answers it checked, and every word says so.
 *  E2 the re-check of a refused Review: its running line is gone once a
 *     question waits — never frozen under the yes — and its end is said.
 *
 * DB-free, network-free; one PTY run of the real plain installer (D21).
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { interruptLine } from '../../src/core/install/executor.ts';
import { keptAnswersLines, withKeptAnswers } from '../../src/core/install/front_end.ts';
import type { HostCtx } from '../../src/core/install/host/contract.ts';
import { host_engine } from '../../src/core/install/host/production/engine_delegate.ts';
import { instanceTakenSentence } from '../../src/core/install/host/production/identity_rules.ts';
import { stack_engine } from '../../src/core/install/host/stack/engine_delegate.ts';
import { pendingStackFacts } from '../../src/core/install/host/stack/facts.ts';
import { imageLabel } from '../../src/core/install/host/stack/image.ts';
import { BUILD_DURATION } from '../../src/core/install/host/stack/layout.ts';
import { portProblems } from '../../src/core/install/host/stack/preflight.ts';
import type { InitTestResult } from '../../src/core/install/init_test.ts';
import { buildInstallPlan, type InstallPlan } from '../../src/core/install/install_plan.ts';
import { runInteractiveInstall } from '../../src/core/install/install_session.ts';
import { passedDetail, systemCheckRows } from '../../src/core/install/probes.ts';
import type { ProbeView, ReviewView } from '../../src/core/install/prompter_contract.ts';
import { BACK, QUIT } from '../../src/core/install/prompter_contract.ts';
import { buildScreens, type Screen } from '../../src/core/install/screen_model.ts';
import { DONE_TEXT, NOTICE_TEXT } from '../../src/core/install/screen_text.ts';
import type { App } from '../../src/core/install/ui/app.ts';
import { carriedOver, isProgressLine, tuiPrompter } from '../../src/core/install/ui/prompter.ts';
import { doneCard } from '../../src/core/install/ui/screens/done.ts';
import { probePage } from '../../src/core/install/ui/screens/pages.ts';
import { reviewPage } from '../../src/core/install/ui/screens/review.ts';
import type { DrawContext } from '../../src/core/install/ui/widget.ts';
import { scriptedInstallPrompter } from '../../src/core/install/ui_plain/prompter.ts';
import { plainReporter } from '../../src/core/install/ui_plain/reporter.ts';
import { DEDALO_VERSION, DEDALO_NEXT_DEV_TRIPLE } from '../../src/core/update/version.ts';
import { allCases, splitCase } from '../helpers/install_parity_cases.ts';
import {
	fakeProbes,
	GOOD_ROOT_PASSWORD,
	modelInput,
	scriptForPlan,
	thesaurusOffer,
} from '../helpers/install_plain_script.ts';

const scratchRoot = mkdtempSync(join(tmpdir(), 'dedalo_install_flow_3c_'));
afterAll(() => rmSync(scratchRoot, { recursive: true, force: true }));

const ROOT = join(import.meta.dir, '..', '..');
const CASES = allCases(join(scratchRoot, 'unused_source'));

/** A route case's flags plan and the script that walks it to the Review (its commands given). */
function walked(name: string, review: readonly string[]) {
	const answerCase = CASES.find((item) => item.name === name);
	if (answerCase === undefined) throw new Error(`no case '${name}'`);
	const { raw, plain } = splitCase(answerCase.argv);
	const flags = buildInstallPlan(raw);
	expect(flags.errors, name).toEqual([]);
	const script = scriptForPlan(
		flags,
		Object.keys(plain),
		{ root_password: GOOD_ROOT_PASSWORD },
		review,
	);
	return { flags, script };
}

/** The session over a scripted prompter, with the run's preflight answering `refusals(call)`. */
async function session(
	name: string,
	review: readonly string[],
	refusals?: (call: number) => string[],
	prompter = scriptedInstallPrompter(walked(name, review).script),
) {
	let calls = 0;
	const result = await runInteractiveInstall({
		prompter,
		probes: fakeProbes(),
		priorEnv: {},
		thesauri: thesaurusOffer(),
		host: {},
		givenSecrets: {},
		unfinished: null,
		...(refusals === undefined
			? {}
			: {
					preflightRefusals: async (_plan: InstallPlan) => {
						calls += 1;
						return refusals(calls);
					},
				}),
	});
	return { result, prompter, calls: () => calls };
}

const HELD = 'port 443 is already in use by python3 — the stack publishes it';

describe('D2: what the run would refuse is said before yes, and a refusal keeps the answers', () => {
	test('the Review lists the refusal as an error and does not offer install', async () => {
		const { result, prompter } = await session('route docker', ['install', 'quit'], () => [HELD]);
		expect(result.kind).toBe('quit');
		expect(prompter.said).toContain(`error: ${HELD}`);
		// `install` there checks again (campaign 3d C3d-F2) — still refused, it says so.
		expect(prompter.said).toContain(NOTICE_TEXT.stillRefused);
		// CONTROL: nothing refused — the same walk installs.
		const clean = await session('route docker', ['install'], () => []);
		expect(clean.result.kind).toBe('install');
		expect(clean.prompter.said).not.toContain(`error: ${HELD}`);
	});

	test('refused at the typed yes: the session stays on the Review with every answer, then installs them', async () => {
		// Clean at the Review, refused at the yes, clean again at the second install.
		const { result, prompter, calls } = await session(
			'route docker',
			['install', 'install'],
			(call) => (call === 2 ? [HELD] : []),
		);
		expect(calls()).toBeGreaterThanOrEqual(3);
		expect(prompter.said).toContain(NOTICE_TEXT.refusedAtYes);
		expect(prompter.said).toContain(`  error: ${HELD}`);
		expect(result.kind).toBe('install');
		// The answers handed back are the walked ones — nothing was asked again.
		const control = await session('route docker', ['install'], () => []);
		const rawOf = (ended: typeof result): unknown => (ended.kind === 'install' ? ended.raw : null);
		expect(rawOf(result)).toEqual(rawOf(control.result));
		expect(rawOf(control.result)).not.toBeNull();
		expect(prompter.asked.filter((id) => id === 'image.image_source').length).toBe(1);
	});

	test('a refusal after the run started: the answers kept in a file and the command printed', async () => {
		const plan = buildInstallPlan({
			route: 'docker',
			entity: 'museo',
			server_name: 'x.example.org',
		});
		const written: string[] = [];
		const lines = keptAnswersLines(
			plan.answers,
			'/home/op/dedalo-install-answers.json',
			() => 'unused',
			(path) => {
				written.push(path);
				return null;
			},
		);
		expect(written).toEqual(['/home/op/dedalo-install-answers.json']);
		expect(lines.join('\n')).toContain(
			'sh install.sh --answers /home/op/dedalo-install-answers.json',
		);
		// A file that cannot be written: the answers as the equivalent command line.
		const fallback = keptAnswersLines(
			plan.answers,
			'/x',
			() => 'sh install.sh --route=docker …',
			() => 'refused',
		);
		expect(fallback.join('\n')).toContain('sh install.sh --route=docker …');
		// Only a REFUSED outcome (nothing changed) carries them.
		const keep = async () => ['KEPT'];
		const refusedHint: string[] = [];
		expect((await withKeptAnswers({ result: 'refused', hint: refusedHint }, keep)).hint).toEqual([
			'KEPT',
		]);
		expect((await withKeptAnswers({ result: 'failed', hint: ['h'] }, keep)).hint).toEqual(['h']);
	});

	test('an image version not the installer’s is refused at the Image field', () => {
		const raw = {
			route: 'docker',
			entity: 'museo',
			server_name: 'x.example.org',
			tls_mode: 'local_ca',
		};
		const bad = buildInstallPlan({ ...raw, image_source: 'build', image_version: '9.9.9' });
		expect(bad.errors.join('\n')).toContain("image version 9.9.9 is not this installer's");
		const field = buildScreens(
			modelInput({ ...raw, image_source: 'build', image_version: '9.9.9' }),
		)
			.flatMap((screen) => screen.questions)
			.find((question) => question.key === 'image_version');
		expect(field?.errors.join('\n')).toContain('9.9.9');
		// CONTROL: empty and the -dev tag pass.
		for (const version of ['', `${DEDALO_NEXT_DEV_TRIPLE.join('.')}-dev`]) {
			expect(buildInstallPlan({ ...raw, image_version: version }).errors, version).toEqual([]);
		}
	});

	test('a published port already held is a stack preflight refusal (the trial publishes HTTP only)', () => {
		const answers = (route: string) =>
			buildInstallPlan({ route, entity: 'museo', server_name: 'x.example.org' }).answers;
		const held = { ...pendingStackFacts(), listening: [{ port: '443', process: 'python3' }] };
		expect(portProblems(answers('docker'), held).join('\n')).toContain(
			'port 443 is already in use by python3',
		);
		expect(portProblems(answers('trial'), held)).toEqual([]);
		// Not measurable (no ss): nothing claimed.
		expect(portProblems(answers('docker'), { ...pendingStackFacts(), listening: null })).toEqual(
			[],
		);
	});
});

describe('D3: every completing host run names the salt’s read command', () => {
	test('stack and production: an earlier run showed it — the To-do still names the command', async () => {
		const stack = (await stack_engine.afterComplete?.({
			answers: { route: 'docker' },
			created: { salt_shown: true },
		} as unknown as HostCtx)) as string[];
		expect(stack.join('\n')).toContain(
			'run --rm --no-deps dedalo grep ^DEDALO_SALT_STRING= /private/.env',
		);
		const production = (await host_engine.afterComplete?.({
			paths: { privateDir: '/home/ded_museo/private' },
			created: { salt_shown: true },
		} as unknown as HostCtx)) as string[];
		expect(production.join('\n')).toContain(
			'sudo grep ^DEDALO_SALT_STRING= /home/ded_museo/private/.env',
		);
	});
});

describe('D4: a gate made stale by a later answer is re-checked right after that screen', () => {
	test('the Identity re-check comes before the Services screen, not after the Administrator', async () => {
		const { script } = walked('route production + instance (derived names as shown)', ['quit']);
		script.answers['web_tls.web_server'] = 'apache';
		const base = scriptedInstallPrompter(script);
		const events: string[] = [];
		const prompter = {
			...base,
			screen: (screen: Parameters<typeof base.screen>[0]) => {
				events.push(`screen:${screen.id}`);
				base.screen(screen);
			},
			say: (lines: readonly string[]) => {
				events.push(...lines);
				base.say(lines);
			},
		};
		await session('route production + instance (derived names as shown)', ['quit'], undefined, {
			...prompter,
			asked: base.asked,
			shown: base.shown,
			said: base.said,
		});
		const recheck = events.indexOf(
			"the answers changed what 'Identity' checked (Web server): checking again",
		);
		expect(recheck).toBeGreaterThan(events.indexOf('screen:web_tls'));
		expect(recheck).toBeLessThan(events.indexOf('screen:services'));
	});
});

describe('D5: the closing To-do on every front end', () => {
	const ending = {
		route: 'production' as const,
		instance: 'museo',
		keptLive: false,
		told: ['firewall: ufw allow 80,443/tcp'],
	};
	const outcome = {
		exitCode: 0,
		result: 'complete' as const,
		message: null,
		failedStep: null,
		hint: [],
	};

	test('the full-screen Done card lists it', () => {
		const card = doneCard(
			{ kind: 'run', outcome, mode: 'fresh', rootVerified: true, shownOnce: [], ending },
			100,
		);
		const below = card.below.map((line) => line.map((part) => part.text).join('')).join('\n');
		expect(below).toContain(DONE_TEXT.todoHeading);
		expect(below).toContain('ufw allow 80,443/tcp');
	});

	test('the plain closing block lists it', async () => {
		const logged: string[] = [];
		const sinks = { log: (l: string) => logged.push(l), warn: () => {}, error: () => {} };
		await plainReporter({ sinks, terminal: { isTTY: false, write: () => true } }).finish(outcome, {
			mode: 'fresh',
			rootVerified: true,
			ending,
		});
		expect(logged).toContain(DONE_TEXT.todoHeading);
		expect(logged).toContain('  • firewall: ufw allow 80,443/tcp');
	});
});

describe('the words (D10, D11, D19, D20, D22, D23)', () => {
	test('D11: an engine child’s interrupt is a sub-line; the run’s own is the one ✖ block', () => {
		const child = interruptLine('SIGTERM', 'set_root_pw', true);
		expect(child).not.toContain('✖');
		expect(child.startsWith('\n')).toBe(false);
		expect(child).toContain('[set_root_pw]');
		expect(interruptLine('SIGINT', 'host_engine', false)).toContain(
			'✖ install interrupted (SIGINT) at step [host_engine]',
		);
	});

	test('D19: a word a failed check does not offer gets one plain sentence', async () => {
		const { script } = walked('route trial', ['quit']);
		const base = scriptedInstallPrompter(script);
		let asks = 0;
		const prompter = {
			...base,
			probe: async (view: Parameters<typeof base.probe>[0]) => {
				base.said.push(...view.lines);
				asks += 1;
				return asks === 1 ? 'retry' : 'quit';
			},
		};
		const probes = fakeProbes();
		probes.system = async () => ({
			ok: false,
			detail: 'one check failed',
			rows: [{ state: 'fail', label: 'Operating system', detail: 'Zz OS', fixable: false }],
		});
		await runInteractiveInstall({
			prompter,
			probes,
			priorEnv: {},
			thesauri: thesaurusOffer(),
			host: {},
			givenSecrets: {},
			unfinished: null,
		});
		expect(base.said).toContain(
			"'retry' is not offered here — type quit, or back to choose another route",
		);
	});

	test('D20: an ok row says its result once', () => {
		expect(passedDetail('Bun', `Bun runtime ${Bun.version} — OK`)).toBe(`runtime ${Bun.version}`);
		expect(passedDetail('Install seed', 'Install database seed present — OK')).toBe('present');
		expect(passedDetail('Private directory', 'Private config directory is writable — OK')).toBe(
			'writable',
		);
	});

	test('D22: a short check is carried whole to the next screen; a long one keeps what matters', () => {
		const previous = { id: 'system', title: 'System check' } as Parameters<typeof carriedOver>[1];
		const next = { id: 'image', title: 'Image' } as Parameters<typeof carriedOver>[2];
		const short = [
			'ok  Docker  daemon answers',
			'ok  Compose  Docker Compose 5.6.0',
			'System ready.',
		];
		expect(carriedOver(short, previous, next)).toEqual(['System check:', ...short]);
		const long = [
			...Array.from({ length: 12 }, (_, i) => `ok  row ${i}`),
			'warn: Firewall  x',
			'System ready (1 warning).',
		];
		expect(carriedOver(long, previous, next)).toEqual([
			'System check:',
			'warn: Firewall  x',
			'System ready (1 warning).',
		]);
	});

	test('D10: the Review’s [stack_image] line of a local build says how long', () => {
		const answers = buildInstallPlan({
			route: 'trial',
			entity: 'museo',
			image_source: 'build',
		}).answers;
		expect(imageLabel(answers)).toContain(BUILD_DURATION);
		expect(imageLabel({ ...answers, image_source: 'official' })).not.toContain(BUILD_DURATION);
	});

	test('D23: the trial Review points at the Trial page', () => {
		const review = buildScreens(modelInput({ route: 'trial' })).find((s) => s.id === 'review');
		const texts = (review?.notices ?? []).map((notice) => notice.text).join('\n');
		expect(texts).toContain("Trial page's firewall warning");
		expect(texts).not.toContain('see Docker install');
	});
});

describe('D18: back from a failed check and forward again runs it again, its rows once', () => {
	test('the check runs on each visit, says checking, and its rows are printed once per visit', async () => {
		const { script } = walked('route trial', ['quit']);
		const base = scriptedInstallPrompter(script);
		let asks = 0;
		const prompter = {
			...base,
			probe: async (view: Parameters<typeof base.probe>[0]) => {
				base.said.push(...view.lines);
				asks += 1;
				return asks === 1 ? BACK : QUIT;
			},
		};
		const probes = fakeProbes({ fail: ['system'] });
		await runInteractiveInstall({
			prompter,
			probes,
			priorEnv: {},
			thesauri: thesaurusOffer(),
			host: {},
			givenSecrets: {},
			unfinished: null,
		});
		expect(asks).toBe(2);
		expect(probes.calls.filter((call) => call.probe === 'system').length).toBe(2);
		expect(base.said.filter((line) => line === 'checking: System check…').length).toBe(2);
		expect(base.said.filter((line) => line.includes('Bun  fake')).length).toBe(2);
	});
});

describe('D21: a plain quit prints the closing line', () => {
	test('the real installer in plain mode: quit at the first question → "nothing was installed", exit 0', async () => {
		const dir = mkdtempSync(join(scratchRoot, 'plain_'));
		let text = '';
		const decoder = new TextDecoder();
		const proc = Bun.spawn([process.execPath, 'run', 'scripts/install.ts', '--plain'], {
			cwd: ROOT,
			env: {
				...Bun.env,
				TERM: 'xterm-256color',
				DEDALO_INSTALL_PRIVATE_DIR: join(dir, 'private'),
				DEDALO_TS_STATE_PATH: join(dir, 'private', 'ts_state.json'),
			},
			terminal: {
				cols: 100,
				rows: 30,
				data: (_terminal: unknown, chunk: Uint8Array) => {
					text += decoder.decode(chunk, { stream: true });
				},
			},
		});
		const until = Date.now() + 30000;
		while (!/Install type/.test(text) && Date.now() < until) await Bun.sleep(25);
		expect(text).toContain('Install type');
		await Bun.sleep(150);
		(proc as unknown as { terminal: { write(data: string): void } }).terminal.write('quit\r');
		const code = await proc.exited;
		await Bun.sleep(50);
		expect(code).toBe(0);
		expect(text.slice(text.lastIndexOf('quit'))).toContain('nothing was installed');
	}, 60000);
});

// ── campaign 3d (2026-10-14 VM re-test) ──────────────────────────────────────

describe('C3d-F1: the System check says an installed instance holds the name, right after it', () => {
	const INIT: InitTestResult = {
		result: true,
		errors: [],
		msg: [],
		psql: { state: 'missing', path: 'psql' },
	};
	const rows = (instance: { name: string; taken: string | null } | undefined) =>
		systemCheckRows(INIT, null, 'production', {
			host: { osRelease: '', euid: 0, ...(instance === undefined ? {} : { instance }) },
		}).filter((row) => row.label === 'Instance');

	test('taken: a FAILED row naming the instance and its file (fixable — another name passes)', () => {
		const sentence = instanceTakenSentence('museo', [
			'/var/lib/dedalo-install/instances/museo.json',
		]);
		const [taken] = rows({ name: 'museo', taken: sentence });
		expect(taken?.state).toBe('fail');
		expect(taken?.detail).toContain(sentence);
		expect(taken?.fixable).not.toBe(false);
		// CONTROL: a free name is an ok row; no name measured, no row.
		expect(rows({ name: 'prado', taken: null })[0]?.state).toBe('ok');
		expect(rows(undefined)).toEqual([]);
	});

	test('the session hands the System check the answered instance name (and re-checks when it changes)', async () => {
		const seen: (string | undefined)[] = [];
		const { script } = walked('route production + instance (derived names as shown)', ['quit']);
		const probes = fakeProbes();
		const fake = probes.system;
		probes.system = async (route, instance) => {
			seen.push(instance);
			return fake(route);
		};
		await runInteractiveInstall({
			prompter: scriptedInstallPrompter(script),
			probes,
			priorEnv: {},
			thesauri: thesaurusOffer(),
			host: {},
			givenSecrets: {},
			unfinished: null,
		});
		const instance = String(script.answers['route.instance'] ?? '');
		expect(instance).not.toBe('');
		expect(seen).toContain(instance);
	});
});

describe('C3d-F2: install on a refused Review checks again; the words say how', () => {
	test('refused at the Review, cause fixed: `install` re-checks and goes on to the yes — no edit round trip', async () => {
		// Refused when the Review is drawn, clear when install is pressed (and at the yes).
		const { result, prompter, calls } = await session('route docker', ['install'], (call) =>
			call === 1 ? [HELD] : [],
		);
		expect(prompter.said).toContain(`error: ${HELD}`);
		expect(prompter.said).toContain(NOTICE_TEXT.recheckReview);
		expect(prompter.said).not.toContain(NOTICE_TEXT.stillRefused);
		expect(result.kind).toBe('install');
		expect(calls()).toBe(3); // the Review, the re-check, the typed yes
		// Nothing was asked again: the walk's answers, as a clean one installs them.
		const control = await session('route docker', ['install'], () => []);
		const rawOf = (ended: typeof result): unknown => (ended.kind === 'install' ? ended.raw : null);
		expect(rawOf(result)).toEqual(rawOf(control.result));
	});

	test('still refused: the re-check says so and the Review stays, measured once per press', async () => {
		const { result, prompter, calls } = await session(
			'route docker',
			['install', 'install', 'quit'],
			() => [HELD],
		);
		expect(result.kind).toBe('quit');
		expect(prompter.said.filter((line) => line === NOTICE_TEXT.stillRefused).length).toBe(2);
		expect(calls()).toBe(3); // the Review, then one re-check per install (shown, not re-measured)
	});

	test('the words are the recovery path: "install again (it checks first)" (the CA refusal: install_host_steps_native)', () => {
		expect(NOTICE_TEXT.refusedAtYes).toContain('install again (it checks first)');
	});
});

/** The Review page's pinned action line, as text. */
function pinnedText(page: ReturnType<typeof reviewPage>): string {
	const ctx = { width: 120, layout: { paneHeight: 30 }, palette: {} } as unknown as DrawContext;
	return (page.lines(ctx).pinned ?? [])
		.map((line) => line.map((part) => part.text).join(''))
		.join('\n');
}

describe('C3d-F3: the refused Review never says "enter install"', () => {
	const view = (canInstall: boolean): ReviewView => ({
		screen: buildScreens(
			modelInput({ route: 'docker', entity: 'museo', server_name: 'x.example.org' }),
		).at(-1) as Screen,
		lines: [],
		canInstall,
		editable: [],
		command: '',
		errors: canInstall ? [] : [HELD],
	});

	test('refused: enter is "check again" in the key bar and the action line, and it asks the walker', () => {
		const answered: unknown[] = [];
		const page = reviewPage(view(false), (answer) => answered.push(answer));
		const keys = page.keys();
		expect(keys[0]).toEqual(['enter', 'check again']);
		expect(keys.some(([, words]) => words === 'install')).toBe(false);
		const pinned = pinnedText(page);
		expect(pinned).toContain('install is not offered here');
		expect(pinned).toContain('enter check again');
		page.onKey('enter');
		expect(answered).toEqual(['install']);
		// CONTROL: offered — enter installs.
		const offered = reviewPage(view(true), () => {});
		expect(offered.keys()[0]).toEqual(['enter', 'install']);
		expect(pinnedText(offered)).toContain('Install');
	});
});

// ── campaign 3e (2026-10-14 VM re-test) ──────────────────────────────────────

describe('E1: `edit` on the System check goes back to Install type, and says so', () => {
	test('both UIs: the prompt and the button name Install type; edit walks back to it (never only re-runs the check)', async () => {
		const { script } = walked('route trial', ['quit']);
		const base = scriptedInstallPrompter(script);
		const views: ProbeView[] = [];
		const prompter = {
			...base,
			probe: async (view: ProbeView) => {
				views.push(view);
				base.asked.push(`probe:${view.screen.id}`);
				return views.length === 1 ? 'edit' : QUIT;
			},
		};
		await runInteractiveInstall({
			prompter,
			probes: fakeProbes({ fail: ['system'] }),
			priorEnv: {},
			thesauri: thesaurusOffer(),
			host: {},
			givenSecrets: {},
			unfinished: null,
		});
		const [first] = views;
		expect(first?.screen.id).toBe('system');
		expect(first?.editGoesTo).toBe('Install type');
		expect(first?.prompt).toContain('edit (back to Install type)');
		// `edit` went BACK: Install type is shown again before the check runs again.
		const at = base.asked.indexOf('probe:system');
		expect(base.asked.slice(at)).toContain('screen:route');
		// The full screen's button and key bar say the same.
		const page = probePage(first as ProbeView, () => {});
		const ctx = { width: 120, layout: { paneHeight: 30 }, palette: {} } as unknown as DrawContext;
		const text = page
			.lines(ctx)
			.lines.map((line) => line.map((part) => part.text).join(''))
			.join('\n');
		expect(text).toContain('Back to Install type');
		expect(text).not.toContain("Ask this screen's questions again");
		expect(
			page
				.keys()
				.map(([, words]) => words)
				.join(' '),
		).toContain('edit (back to Install type)');
	});

	test('CONTROL: a failed check on a screen with questions keeps `edit` = ask them again', async () => {
		const { script } = walked('route production + instance (derived names as shown)', ['quit']);
		const base = scriptedInstallPrompter(script);
		const views: ProbeView[] = [];
		const prompter = {
			...base,
			probe: async (view: ProbeView) => {
				views.push(view);
				return QUIT;
			},
		};
		await runInteractiveInstall({
			prompter,
			probes: fakeProbes({ fail: ['identity'] }),
			priorEnv: {},
			thesauri: thesaurusOffer(),
			host: {},
			givenSecrets: {},
			unfinished: null,
		});
		expect(views[0]?.screen.id).toBe('identity');
		expect(views[0]?.editGoesTo).toBeUndefined();
		expect(views[0]?.prompt).toContain('retry, edit, or');
	});
});

describe('E2: the refused Review re-check leaves no frozen running line', () => {
	test('cleared: the running line is a progress line, and the result is said in both UIs', async () => {
		expect(isProgressLine(NOTICE_TEXT.recheckReview)).toBe(true);
		const { prompter, result } = await session('route docker', ['install'], (call) =>
			call === 1 ? [HELD] : [],
		);
		expect(result.kind).toBe('install');
		const at = prompter.said.indexOf(NOTICE_TEXT.recheckReview);
		expect(at).toBeGreaterThanOrEqual(0);
		expect(prompter.said.slice(at + 1)).toContain(NOTICE_TEXT.recheckOffered);
		// CONTROL: still refused says so, never "offered".
		const refused = await session('route docker', ['install', 'quit'], () => [HELD]);
		expect(refused.prompter.said).toContain(NOTICE_TEXT.stillRefused);
		expect(refused.prompter.said).not.toContain(NOTICE_TEXT.recheckOffered);
	});

	test('full screen: a question put on screen drops the running line said before it (the yes prompt)', () => {
		const app = {
			said: [] as string[],
			view: null,
			widget: null,
			overlay: null,
			cancel: null,
			stopped: null,
			run: { shownOnce: [] },
			draw: () => {},
		} as unknown as App;
		const tui = tuiPrompter(app);
		tui.say([NOTICE_TEXT.recheckReview, NOTICE_TEXT.recheckOffered]);
		const question = buildScreens(modelInput({ route: 'docker', entity: 'museo' }))
			.flatMap((screen) => screen.questions)
			.find((item) => item.kind === 'text');
		void tui.text(question as NonNullable<typeof question>);
		expect(app.said).toEqual([NOTICE_TEXT.recheckOffered]);
		app.cancel?.(null);
	});
});
