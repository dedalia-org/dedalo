/**
 * INSTALL FULL-SCREEN PARITY TRIPWIRE — the OpenTUI installer (src/core/install/
 * ui/, terminal installer phase 3, 2026-10-12) is the SAME session as the
 * plain line mode (install_session.ts, the ONE walker), answered by KEYS: for
 * every case the plain mode can express, the answers it hands back decide
 * EXACTLY the plan the CLI flags, the answers file and the plain mode decide.
 *
 * WHY. The full-screen UI holds no install knowledge — if a widget answered
 * differently from what it drew (the wrong option under the cursor, a tick
 * lost on a filter, a typed value trimmed, a declined dependency dropped), the
 * operator would install something the Review never showed, while every other
 * front end agreed.
 *
 * WHAT IS MEASURED (outcomes, not spellings):
 *  (a) THE MATRIX (test/helpers/install_parity_cases.ts — the plain gate's own
 *      list, same NOT_PLAIN exclusions): runInteractiveInstall with the TUI
 *      prompter on OpenTUI's test renderer, every ask answered by KEY PRESSES
 *      from the same scriptForPlan script (test/helpers/install_tui_driver.ts:
 *      it never calls a resolver, and it cross-checks the frame against the
 *      widget before pressing) → decided(tui) ≡ decided(flags) ≡
 *      decided(plain scripted); the secrets handed back are the case's; the
 *      TUI was asked EXACTLY what the plain mode was asked (same order).
 *  (b) POSITIVE CONTROL: one wrong choice typed on purpose (a cursor moved one
 *      row) decides a DIFFERENT plan — the comparison is not vacuous.
 *  (c) docker / trial: Enter on the Review INSTALLS the walked plan (phase 4:
 *      their host steps run here; the root password asked, the stack's
 *      database password never); `w <path>` still writes an answers file that
 *      decides the walked plan.
 *  (d) an EDIT from the Review (languages changed, mail turned off) installs
 *      the edited plan and drops the disabled service's password.
 *  (e) Shift-Tab (FIELD_BACK) on the second Database field re-asks the first;
 *      after the first is CHANGED the second is asked again, and the result
 *      carries the changed value.
 *  (f) the checklist's closure by keys: Space on a core row draws its lock
 *      reason and changes nothing; ticking zzsma ticks its declared zzsmb;
 *      unticking zzsmb draws `declined`; the walk then decides the flags'
 *      `--ontologies zzsma,oh --decline-dependencies zzsmb:…` plan.
 *  (g) the Resume screen by keys: resume ≡ plain; abort with a wrong database
 *      name re-asks it (the refusal drawn), the right one + the password abort.
 *
 * DB-FREE, network-free (the only non-vendored source is a local fixture in a
 * mkdtemp dir, removed in afterAll); nothing is spawned, nothing installed.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FrontEndResult, writeAnswersFile } from '../../src/core/install/front_end.ts';
import {
	answersFromAnswersFile,
	buildInstallPlan,
	type InstallPlan,
} from '../../src/core/install/install_plan.ts';
import {
	type InteractiveDeps,
	runInteractiveInstall,
} from '../../src/core/install/install_session.ts';
import { lockReason } from '../../src/core/install/multi_select.ts';
import { resolveOntologyCatalog } from '../../src/core/install/ontology_catalog.ts';
import type { OntologyCatalog } from '../../src/core/install/ontology_choice.ts';
import type { InstallPrompter, ReviewView } from '../../src/core/install/prompter_contract.ts';
import { buildScreens } from '../../src/core/install/screen_model.ts';
import { railLines } from '../../src/core/install/ui/screens/question.ts';
import {
	type PlainScript,
	scriptedInstallPrompter,
} from '../../src/core/install/ui_plain/prompter.ts';
import { decided, localOntologySource } from '../helpers/install_answer_cases.ts';
import {
	allCases,
	NOT_PLAIN,
	type ParityCase,
	splitCase,
} from '../helpers/install_parity_cases.ts';
import {
	fakeProbes,
	GOOD_ROOT_PASSWORD,
	modelInput,
	scriptForPlan,
	thesaurusOffer,
} from '../helpers/install_plain_script.ts';
import {
	arrows,
	drivenPrompter,
	enter,
	esc,
	type Keys,
	openRig,
	pending,
	type TuiRig,
	typeKeys,
} from '../helpers/install_tui_driver.ts';
import { PINNED_IDENTITY, pinInstallerIdentity } from '../helpers/installer_identity.ts';

// The installer's release identity is the checkout's: a dev checkout names no image,
// so these cases are written for a STABLE installer (test/helpers/installer_identity.ts).
pinInstallerIdentity(PINNED_IDENTITY.stable);

const scratchRoot = mkdtempSync(join(tmpdir(), 'dedalo_install_tui_parity_'));

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
const LOCAL_CATALOG: OntologyCatalog = LOCAL.catalog;

const ALL_CASES: ParityCase[] = allCases(SOURCE_DIR);
const PARITY_CASES = ALL_CASES.filter((item) => NOT_PLAIN[item.name] === undefined);

const planOf = (raw: Readonly<Record<string, unknown>>, local: boolean): InstallPlan =>
	buildInstallPlan(raw, local ? { ontologyCatalog: LOCAL_CATALOG } : {});

/** The plan an install result decides (its raw answers + the secrets it collected). */
function resultPlan(result: FrontEndResult, local: boolean): InstallPlan {
	if (result.kind !== 'install') throw new Error(`run ended '${result.kind}', not install`);
	const { root_password: _root, ...answerSecrets } = result.secrets;
	return planOf({ ...result.raw, ...answerSecrets }, local);
}

type Writer = InteractiveDeps['writeAnswers'];

function depsOf(prompter: InstallPrompter, local: boolean, writeAnswers?: Writer): InteractiveDeps {
	return {
		prompter,
		probes: fakeProbes({ catalog: local ? LOCAL_CATALOG : null }),
		priorEnv: {},
		thesauri: thesaurusOffer(),
		host: {},
		givenSecrets: {},
		unfinished: null,
		...(writeAnswers === undefined ? {} : { writeAnswers }),
	};
}

/** The TUI, driven by keys from `script`. */
async function runTui(
	script: PlainScript,
	local: boolean,
	options: { writeAnswers?: Writer; keys?: Keys; reviewHook?: (view: ReviewView) => void } = {},
): Promise<{ result: FrontEndResult; asked: string[]; rig: TuiRig }> {
	const rig = await openRig();
	try {
		const prompter = drivenPrompter(rig, script, options.keys ?? {}, options.reviewHook);
		const result = await runInteractiveInstall(depsOf(prompter, local, options.writeAnswers));
		expect(rig.errors).toEqual([]);
		return { result, asked: prompter.asked, rig };
	} finally {
		await rig.dispose();
	}
}

/** The plain mode under the same script. */
async function runPlain(script: PlainScript, local: boolean, writeAnswers?: Writer) {
	const prompter = scriptedInstallPrompter(script);
	const result = await runInteractiveInstall(depsOf(prompter, local, writeAnswers));
	return { result, asked: prompter.asked };
}

/** A case's script (as the plain gate builds it). */
function caseScript(answerCase: ParityCase, review?: readonly string[]) {
	const { raw, plain, secrets } = splitCase(answerCase.argv);
	const flags = planOf(raw, answerCase.local);
	expect(flags.errors, answerCase.name).toEqual([]);
	// Phase 4: every route installs from the Review (docker/trial run their host steps here).
	const script = scriptForPlan(
		flags,
		Object.keys(plain),
		{ ...secrets, root_password: GOOD_ROOT_PASSWORD },
		review ?? ['install'],
	);
	return { raw, plain, secrets, flags, script };
}

const findCase = (name: string): ParityCase => {
	const found = ALL_CASES.find((item) => item.name === name);
	if (found === undefined) throw new Error(`no case '${name}'`);
	return found;
};

// ── (a) the matrix ───────────────────────────────────────────────────────────

describe('full-screen ≡ plain ≡ flags ≡ answers file (a)', () => {
	test("the matrix is the plain gate's, executing", () => {
		expect(PARITY_CASES.length).toBeGreaterThanOrEqual(13);
		const routes = new Set(
			PARITY_CASES.map((item) => planOf(splitCase(item.argv).raw, item.local).answers.route),
		);
		expect([...routes].sort()).toEqual(['developer', 'docker', 'production', 'trial']);
	});

	for (const answerCase of PARITY_CASES) {
		test(answerCase.name, async () => {
			const { secrets, flags, script } = caseScript(answerCase);
			const tui = await runTui(script, answerCase.local);
			const plain = await runPlain(script, answerCase.local);
			expect(decided(resultPlan(tui.result, answerCase.local))).toEqual(decided(flags));
			expect(decided(resultPlan(tui.result, answerCase.local))).toEqual(
				decided(resultPlan(plain.result, answerCase.local)),
			);
			expect(tui.result.kind === 'install' ? tui.result.secrets : null).toEqual({
				...secrets,
				root_password: GOOD_ROOT_PASSWORD,
			});
			// The same walk: every screen and question the plain mode was asked, in order.
			expect(tui.asked).toEqual(plain.asked);
			expect(tui.asked.length).toBeGreaterThan(10);
		});
	}
});

// ── (b) positive control ─────────────────────────────────────────────────────

describe('a wrong key decides a different plan (b)', () => {
	test('the application language moved one row: the plan differs', async () => {
		const { flags, script } = caseScript(findCase('base (every default)'));
		const keys: Keys = {
			intercept: async (id) => {
				if (id !== 'languages.app_lang_default') return 'continue';
				const view = pending(tuiRig);
				const options = view.options ?? [];
				const cursor = view.cursor ?? 0;
				await arrows(tuiRig, {}, cursor, cursor + 1 < options.length ? cursor + 1 : cursor - 1);
				await enter(tuiRig, {});
				return 'handled';
			},
		};
		let tuiRig = undefined as unknown as TuiRig;
		const rig = await openRig();
		tuiRig = rig;
		try {
			const prompter = drivenPrompter(rig, script, keys);
			const result = await runInteractiveInstall(depsOf(prompter, false));
			expect(prompter.asked).toContain('languages.app_lang_default');
			expect(decided(resultPlan(result, false))).not.toEqual(decided(flags));
			expect(resultPlan(result, false).answers.app_lang_default).not.toBe(
				flags.answers.app_lang_default,
			);
		} finally {
			await rig.dispose();
		}
	});
});

// ── (c) docker / trial ───────────────────────────────────────────────────────

describe('docker and trial: Enter installs; w still writes (c)', () => {
	for (const route of ['docker', 'trial'] as const) {
		test(`${route}: Enter on the Review installs the walked plan (root password asked, the stack's database password never)`, async () => {
			const { flags, script } = caseScript(findCase(`route ${route}`));
			const { result, asked } = await runTui(script, false);
			expect(result.kind).toBe('install');
			expect(decided(resultPlan(result, false))).toEqual(decided(flags));
			expect(asked.some((id) => id.endsWith('.root_password'))).toBe(true);
			expect(asked.filter((id) => id.endsWith('.db_password'))).toEqual([]);
			expect(result.kind === 'install' ? result.secrets : null).toEqual({
				root_password: GOOD_ROOT_PASSWORD,
			});
		});

		test(`${route}: w <path> writes an answers file that decides the walked plan`, async () => {
			const path = join(mkdtempSync(join(scratchRoot, `${route}_`)), 'answers.json');
			const { flags, script } = caseScript(findCase(`route ${route}`), [`write ${path}`]);
			const rig = await openRig();
			try {
				const prompter = drivenPrompter(rig, script, {});
				const result = await runInteractiveInstall(depsOf(prompter, false, writeAnswersFile));
				expect(rig.errors).toEqual([]);
				expect(result).toEqual({ kind: 'written', path });
				expect(prompter.reviews.every((view) => view.canInstall)).toBe(true);
				const file = answersFromAnswersFile(JSON.parse(readFileSync(path, 'utf8')) as unknown);
				expect(file.errors).toEqual([]);
				expect(decided(planOf(file.raw, false))).toEqual(decided(flags));
			} finally {
				await rig.dispose();
			}
		});
	}
});

// ── (d) an edit from the Review ──────────────────────────────────────────────

describe('an edit from the Review installs the edited plan (d)', () => {
	test('change the languages and turn mail off: the plan of the edited answers', async () => {
		const answerCase = findCase('+mailer');
		const screens = buildScreens(modelInput({ route: 'developer' }));
		const indexOf = (id: string): number =>
			(screens.find((screen) => screen.id === id)?.index ?? 0) as number;
		const {
			raw,
			flags: original,
			script,
		} = caseScript(answerCase, [
			`edit ${indexOf('languages')}`,
			`edit ${indexOf('mail')}`,
			'install',
		]);
		let edited = false;
		const { result } = await runTui(script, false, {
			// The FIRST Review edits the answers; a later Review (after the edit) leaves them.
			reviewHook: () => {
				if (!edited) {
					edited = true;
					script.answers['languages.langs'] = ['lg-eng', 'lg-fra'];
					script.answers['languages.app_lang_default'] = 'lg-fra';
					script.answers['languages.data_lang_default'] = 'lg-eng';
					script.answers['mail.mailer'] = false;
				}
			},
		});
		const expected = planOf(
			{
				...raw,
				langs: 'lg-eng,lg-fra',
				app_lang_default: 'lg-fra',
				data_lang_default: 'lg-eng',
				mailer: false,
				smtp_host: undefined,
				smtp_port: undefined,
				smtp_secure: undefined,
				smtp_user: undefined,
				smtp_pass: undefined,
				smtp_from: undefined,
				smtp_from_name: undefined,
			},
			false,
		);
		expect(expected.errors).toEqual([]);
		const fromTui = resultPlan(result, false);
		expect(decided(fromTui)).toEqual(decided(expected));
		expect(decided(fromTui)).not.toEqual(decided(original));
		expect(result.kind === 'install' ? result.secrets.smtp_pass : 'x').toBeUndefined();
	});
});

// ── (d2) a quit at the mail probe's recipient ────────────────────────────────

describe("a quit at the mail check's test recipient ends the walk (d2)", () => {
	test('<quit> at mail.test_recipient: quit in both modes, the mail probe never runs', async () => {
		const { script } = caseScript(findCase('+mailer'));
		script.answers['mail.test_recipient'] = '<quit>';
		const tuiProbes = fakeProbes();
		const rig = await openRig();
		let tui: { result: FrontEndResult; asked: string[] };
		try {
			const prompter = drivenPrompter(rig, script, {});
			const result = await runInteractiveInstall({
				...depsOf(prompter, false),
				probes: tuiProbes,
			});
			expect(rig.errors).toEqual([]);
			tui = { result, asked: prompter.asked };
		} finally {
			await rig.dispose();
		}
		const plainProbes = fakeProbes();
		const plainPrompter = scriptedInstallPrompter(script);
		const plain = await runInteractiveInstall({
			...depsOf(plainPrompter, false),
			probes: plainProbes,
		});
		for (const [run, probes, asked] of [
			[tui.result, tuiProbes, tui.asked],
			[plain, plainProbes, plainPrompter.asked],
		] as const) {
			expect(run).toEqual({ kind: 'quit', reason: 'operator' });
			expect(probes.calls.map((call) => call.probe)).not.toContain('mailer');
			// Non-vacuity: the walk reached the recipient ask, and went no further.
			expect(asked.at(-1)).toBe('mail.test_recipient');
		}
	});
});

// ── (e) Shift-Tab ────────────────────────────────────────────────────────────

describe('Shift-Tab asks the previous question of the screen (e)', () => {
	test('back from the second Database field, the first changed, the second asked again', async () => {
		const answerCase = findCase('base (every default)');
		const { raw, script } = caseScript(answerCase);
		const FIRST = 'database.db_hostname';
		const SECOND = 'database.db_port';
		const CHANGED = 'db.changed.example';
		let rigRef = undefined as unknown as TuiRig;
		const keys: Keys = {
			intercept: async (id, nth) => {
				if (id === SECOND && nth === 1) {
					await typeKeys(rigRef, {}, '');
					rigRef.setup.mockInput.pressTab({ shift: true });
					return 'handled';
				}
				if (id === FIRST && nth === 2) {
					// The re-asked first field: drawn with its answer, changed by keys.
					expect(pending(rigRef).value).toBe(String(raw.db_hostname ?? 'localhost'));
					rigRef.setup.mockInput.pressKey('u', { ctrl: true });
					await typeKeys(rigRef, {}, CHANGED);
					await enter(rigRef, {});
					return 'handled';
				}
				return 'continue';
			},
		};
		const rig = await openRig();
		rigRef = rig;
		try {
			const prompter = drivenPrompter(rig, script, keys);
			const result = await runInteractiveInstall(depsOf(prompter, false));
			expect(rig.errors).toEqual([]);
			const database = prompter.asked.filter((id) => id === FIRST || id === SECOND);
			expect(database.slice(0, 4)).toEqual([FIRST, SECOND, FIRST, SECOND]);
			expect(resultPlan(result, false).answers.db_hostname).toBe(CHANGED);
			// Everything else decided as the case.
			expect(decided(resultPlan(result, false))).toEqual(
				decided(planOf({ ...raw, db_hostname: CHANGED }, false)),
			);
		} finally {
			await rig.dispose();
		}
	});

	test('Shift-Tab on the FIRST question of a screen is back (the previous screen)', async () => {
		const { script } = caseScript(findCase('base (every default)'));
		let rigRef = undefined as unknown as TuiRig;
		const keys: Keys = {
			intercept: async (id, nth) => {
				if (id !== 'database.db_hostname' || nth !== 1) return 'continue';
				rigRef.setup.mockInput.pressTab({ shift: true });
				return 'handled';
			},
		};
		const rig = await openRig();
		rigRef = rig;
		try {
			const prompter = drivenPrompter(rig, script, keys);
			await runInteractiveInstall(depsOf(prompter, false));
			const firstDb = prompter.asked.indexOf('database.db_hostname');
			// The previous screen was shown again before the Database questions resumed.
			expect(prompter.asked.slice(firstDb + 1, firstDb + 2)[0]).not.toBe('database.db_port');
			expect(prompter.asked.filter((id) => id === 'database.db_hostname').length).toBe(2);
		} finally {
			await rig.dispose();
		}
	});
});

// ── (f) the checklist's closure, by keys ─────────────────────────────────────

describe('the checklist: locks, declared ticks and declines by keys (f)', () => {
	test('core lock reason drawn; zzsma ticks zzsmb; zzsmb unticked = declined; the flags plan', async () => {
		const answerCase = findCase('air-gapped + a local source (an optional dependency declined)');
		const { flags, script } = caseScript(answerCase);
		let rigRef = undefined as unknown as TuiRig;
		let checked = false;
		const toggleRow = async (value: string): Promise<string> => {
			await typeKeys(rigRef, {}, value);
			const view = pending(rigRef);
			await arrows(rigRef, {}, view.cursor ?? 0, (view.options ?? []).indexOf(value));
			rigRef.setup.mockInput.pressKey(' ');
			const frame = await rigRef.frame();
			await esc(rigRef, {});
			return frame;
		};
		const keys: Keys = {
			intercept: async (id) => {
				if (id !== 'ontologies.ontologies') return 'continue';
				const question = rigRef.app.view?.screen.questions.find((item) => item.id === id);
				const core = question?.options?.find((option) => option.value === 'dd');
				expect(core?.locked).toBe(true);
				const before = pending(rigRef).selected ?? [];
				// A core row: its reason drawn, the selection unchanged.
				const lockedFrame = await toggleRow('dd');
				expect(lockedFrame).toContain(lockReason(core as NonNullable<typeof core>));
				expect(pending(rigRef).selected).toEqual(before);
				// Start from zzsma unticked (and zzsmb with it), then tick zzsma alone.
				if ((pending(rigRef).selected ?? []).includes('zzsma')) await toggleRow('zzsma');
				if ((pending(rigRef).selected ?? []).includes('zzsmb')) await toggleRow('zzsmb');
				await toggleRow('zzsma');
				expect(pending(rigRef).selected).toContain('zzsmb');
				// Untick the optional dependency: drawn as declined.
				const declinedFrame = await toggleRow('zzsmb');
				expect(pending(rigRef).selected).not.toContain('zzsmb');
				const row = declinedFrame.split('\n').find((line) => line.includes('◻ zzsmb')) ?? '';
				expect(row).toContain('declined');
				checked = true;
				return 'continue';
			},
		};
		const rig = await openRig();
		rigRef = rig;
		try {
			const prompter = drivenPrompter(rig, script, keys);
			const result = await runInteractiveInstall(depsOf(prompter, true));
			expect(rig.errors).toEqual([]);
			expect(checked).toBe(true);
			expect(decided(resultPlan(result, true))).toEqual(decided(flags));
		} finally {
			await rig.dispose();
		}
	});
});

// ── (g) an unfinished install: the Resume screen ─────────────────────────────

describe('the Resume screen: resume, and abort with the name typed back (g)', () => {
	const unfinished = {
		database: 'dedalo_prado',
		outcome: 'failed',
		canAbort: true,
		needsDbPassword: true,
	};

	async function startWith(script: PlainScript, keys: Keys = {}) {
		const rig = await openRig();
		try {
			const prompter = drivenPrompter(rig, script, keys);
			const result = await runInteractiveInstall({
				...depsOf(prompter, false),
				unfinished,
			});
			expect(rig.errors).toEqual([]);
			return { result, asked: prompter.asked };
		} finally {
			await rig.dispose();
		}
	}

	test('resume by keys: the session resumes, the same asks as plain', async () => {
		const script: PlainScript = { answers: { resume: 'resume' } };
		const tui = await startWith(script);
		expect(tui.result).toEqual({ kind: 'resume' });
		const plain = await runInteractiveInstall({
			...depsOf(scriptedInstallPrompter(script), false),
			unfinished,
		});
		expect(plain).toEqual(tui.result);
	});

	test('abort by keys: a wrong name is refused on screen and asked again; the right one + the password abort', async () => {
		let rigRef = undefined as unknown as TuiRig;
		const script: PlainScript = {
			answers: { resume: 'abort', 'resume.confirm_database': 'dedalo_prado' },
			secrets: { 'resume.db_password': 'Zz-Abort-Db-1' },
		};
		const rig = await openRig();
		rigRef = rig;
		try {
			const keys: Keys = {
				intercept: async (id, nth) => {
					if (id !== 'resume.confirm_database') return 'continue';
					if (nth === 2) {
						// Asked again, the refusal drawn with it.
						expect(await rigRef.frame()).toContain("type the database name 'dedalo_prado' exactly");
						return 'continue';
					}
					await typeKeys(rigRef, {}, 'dedalo_wrong');
					await enter(rigRef, {});
					return 'handled';
				},
			};
			const prompter = drivenPrompter(rig, script, keys);
			const result = await runInteractiveInstall({ ...depsOf(prompter, false), unfinished });
			expect(rig.errors).toEqual([]);
			expect(result).toEqual({
				kind: 'abort',
				confirmDatabase: 'dedalo_prado',
				secrets: { db_password: 'Zz-Abort-Db-1' },
			});
			expect(prompter.asked).toEqual([
				'resume',
				'resume.confirm_database',
				'resume.confirm_database',
				'resume.db_password',
			]);
		} finally {
			await rig.dispose();
		}
	});
});

// ── campaign 3 C3-66: one step count ─────────────────────────────────────────

describe('plain and full screen count the SAME steps (C3-66)', () => {
	test('per route: plain "Step i of N" ≡ the rail’s rows (the screens + Install and Done)', () => {
		for (const route of ['production', 'docker', 'trial', 'developer'] as const) {
			const screens = buildScreens(modelInput({ route }));
			const plain = scriptedInstallPrompter({ answers: {} });
			for (const screen of screens) plain.screen(screen);
			const totals = new Set(
				plain.said
					.map((line) => /^Step \d+ of (\d+):/.exec(line)?.[1])
					.filter((total): total is string => total !== undefined),
			);
			expect([...totals], route).toHaveLength(1);
			const view = {
				screen: screens[0] as (typeof screens)[number],
				screens: screens.map((screen) => ({
					id: screen.id,
					title: screen.title,
					index: screen.index,
					placeholder: false,
				})),
				seen: [],
				focus: null,
				probing: false,
				route,
			};
			const rail = railLines(view, 'route', {}, true);
			expect(Number([...totals][0]), route).toBe(rail.length);
		}
	});
});
