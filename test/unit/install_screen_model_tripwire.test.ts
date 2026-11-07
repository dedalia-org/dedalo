/**
 * INSTALL SCREEN-MODEL TRIPWIRE — the terminal installer's screen model
 * (src/core/install/screen_model.ts, phase 2, 2026-10-12) asks EVERY answer,
 * in the owner's order, with the PLAN's defaults and the PLAN's refusals, and
 * maps what the operator ticks to exactly the answers the flags would give.
 *
 * WHY. The retired browser wizard drifted from the CLI because it carried its
 * own defaults, rules and mappings (install_plan_parity_tripwire's history). The
 * screen model is a UI over the same plan; it must not become the next copy.
 *
 * WHAT IS MEASURED (outcomes, never spellings):
 *  (a) COMPLETENESS, PER ROUTE (A8): with every conditional question on, the
 *      keys a route's screens ask ∪ its ROUTE_FIXED keys ∪ FLAGS_ONLY are
 *      exactly INSTALL_ANSWER_KEYS ∪ the secret keys — nothing unreachable
 *      silently, nothing both asked and declared fixed; every fixed/flags-only
 *      entry is a real key with a reason; every question key is a real key.
 *  (b) ORDER: each route's screens are SCREEN_ORDER's, and the production and
 *      docker lists are the owner's step lists.
 *  (c) DEFAULTS ARE THE PLAN'S: every unanswered question's default equals the
 *      plan's normalization of the answers (the languages: deriveLangConfig),
 *      on every route — the instance-derived production names included
 *      (phase 4: the PEER role ded_<i> owns dedalo_<i>, MEDIA_PATH obeys the
 *      root rule; the trial stack's DELEGATED engine answers derive the stack
 *      constants) — with an explicit
 *      exemption table (route: chosen; timezone/locale: the host's suggestion,
 *      itself measured).
 *  (d) ONE RULE SET: a planted bad answer per validator rule, applied through
 *      applyAnswer, puts the plan's own sentence on the question that asks the
 *      key, and that sentence is in the plan's errors; every fieldErrors
 *      message is an error. B1: over every route and a walk of reachable
 *      answers (route switches included), no fieldError ever sits on a key no
 *      visible question asks; a route change drops the hidden answers.
 *  (e) L31: a declared toponymy DEFINITION (htoponymy, no data files) never
 *      counts as "a toponymy is selected" — the suggestion and the screen's
 *      notice stay; a country toponymy suppresses both; the fixture ontology
 *      (zzsma, declaring htoponymy) pre-ticks it AND keeps the suggestion;
 *      the example code the notice quotes is a real country toponymy the
 *      multi-select matcher toggles (B6).
 *  (f) MAPPING: ticks → applyAnswer → plan ≡ the equivalent --ontologies /
 *      --hierarchies / --decline-dependencies argv (decided equality); B8's
 *      cases (a transitive untick, a re-tick after a decline, a stale decline,
 *      a pre-existing bare token) through mapSelection/applyAnswer.
 *  (g) CONFINEMENT: the server's import closure (the SAME walker as
 *      sync_io_on_request_path_tripwire) reaches into src/core/install but
 *      never the screen model, its text, the front-end contract, the probe
 *      modules or the plain UI.
 *  (+) no secret ever enters the raw answers (A12); the ontology notes have one
 *      text each (A9); the official update-server option shows the URL the
 *      install will configure (a preserved mirror included).
 *
 * DB-FREE, network-free; the only filesystem writes are a local fixture
 * ontology source in a mkdtemp dir, removed in afterAll.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { offeredHierarchies, TOPONYMY_TYPOLOGY_ID } from '../../src/core/install/hierarchy_meta.ts';
import type { HostPlanCtx } from '../../src/core/install/host/contract.ts';
import { engineSecretKeys } from '../../src/core/install/host/contract.ts';
import type { IdentityVerdict } from '../../src/core/install/host/production/identity_rules.ts';
import { stackEngineAnswers } from '../../src/core/install/host/stack/engine_delegate.ts';
import {
	answersFromCliArgs,
	buildInstallPlan,
	HOST_ONLY_ANSWER_KEYS,
	INSTALL_ANSWER_KEYS,
	INSTALL_ROUTES,
	type InstallPlan,
	type InstallRoute,
	normalizeInstallAnswers,
	routeDefaults,
	TOPONYMY_SUGGESTION,
	toponymyMissing,
} from '../../src/core/install/install_plan.ts';
import { deriveLangConfig } from '../../src/core/install/lang_catalog.ts';
import { resolveOntologyCatalog } from '../../src/core/install/ontology_catalog.ts';
import {
	ONTOLOGY_NOTE_LABELS,
	type OntologyCatalog,
} from '../../src/core/install/ontology_choice.ts';
import { buildPlanFile, SECRET_KEYS } from '../../src/core/install/run_files.ts';
import {
	applyAnswer,
	buildScreens,
	FLAGS_ONLY_ANSWER_KEYS,
	mapSelection,
	type Option,
	type Question,
	ROUTE_FIXED,
	reviewLines,
	SCREEN_ORDER,
	type Screen,
	type ScreenId,
	type ScreenModelInput,
	visibleKeys,
} from '../../src/core/install/screen_model.ts';
import {
	NOTICE_TEXT,
	ONTOLOGY_NOTE_TEXT,
	QUESTION_TEXT,
} from '../../src/core/install/screen_text.ts';
import { multiCommand, multiResult, multiState } from '../../src/core/install/ui_plain/prompter.ts';
import {
	DEFAULT_ONTOLOGIES,
	decided,
	declaredThesauri,
	localOntologySource,
} from '../helpers/install_answer_cases.ts';
import { MAXIMAL_RAW, modelInput } from '../helpers/install_plain_script.ts';
import { PINNED_IDENTITY, pinInstallerIdentity } from '../helpers/installer_identity.ts';
import { directImports, REPO_ROOT, reachableModules } from '../helpers/request_path_closure.ts';
import { writePathSourceFiles } from '../helpers/write_path_corpus.ts';

// The installer's release identity is the checkout's: a dev checkout names no image,
// so these cases are written for a STABLE installer (test/helpers/installer_identity.ts).
pinInstallerIdentity(PINNED_IDENTITY.stable);

const scratchRoot = mkdtempSync(join(tmpdir(), 'dedalo_install_screen_model_'));

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

const SECRET_SET: ReadonlySet<string> = new Set(SECRET_KEYS);
const ANSWER_SET: ReadonlySet<string> = new Set(INSTALL_ANSWER_KEYS);

/** Every conditional question ON for `route` (production: its instance). */
function maximalRaw(route: InstallRoute): Record<string, unknown> {
	const { instance: _instance, ...rest } = MAXIMAL_RAW;
	return route === 'production' ? { ...MAXIMAL_RAW } : { ...rest, route };
}

/**
 * The maximal answers of `route` AND their mutually exclusive alternatives
 * (phase 4: the certificate paths are asked under `tls_mode files`, the Let's
 * Encrypt contact under `letsencrypt`, the extra addresses under `local_ca`;
 * the image repository for a custom image)
 * — one walk cannot turn both on, the union of the walks must.
 */
function maximalRaws(route: InstallRoute): Record<string, unknown>[] {
	const base = maximalRaw(route);
	// A created database's role IS the service user (never asked); an existing one's is.
	// The local CA's extra addresses are asked under `tls_mode local_ca` only (2026-10-16).
	if (route === 'production')
		return [
			base,
			{ ...base, tls_mode: 'files' },
			{ ...base, tls_mode: 'local_ca' },
			{ ...base, db_mode: 'existing' },
		];
	if (route === 'docker')
		return [
			base,
			{ ...base, tls_mode: 'files', image_source: 'custom' },
			{ ...base, tls_mode: 'local_ca' },
		];
	// The public address's protocol is asked once a host is given, its keep-or-none
	// follow-up only for a well-formed host no outside machine reaches (an intranet name).
	const intranetHost = { ...base, public_host: 'dedalo.lan' };
	if (route === 'trial') return [base, { ...base, image_source: 'custom' }, intranetHost];
	// The developer listener's own certificate files are asked under `tls_mode files` only.
	return [base, { ...base, tls_mode: 'files' }, intranetHost];
}

/** The keys the maximal walks of `route` ask, together. */
function routeAskedKeys(route: InstallRoute): Set<string> {
	const keys = new Set<string>();
	for (const raw of maximalRaws(route)) {
		for (const key of askedKeys(buildScreens(modelInput(raw)))) keys.add(key);
	}
	return keys;
}

const questionsOf = (screens: readonly Screen[]): Question[] =>
	screens.flatMap((screen) => screen.questions);

/** The keys the screens ask (a question's key ∪ the keys its answer also sets). */
function askedKeys(screens: readonly Screen[]): Set<string> {
	const keys = new Set<string>();
	for (const question of questionsOf(screens)) {
		if (question.key !== null) keys.add(question.key);
		for (const key of question.sets) keys.add(key);
	}
	return keys;
}

const withLocal = (raw: Record<string, unknown>): ScreenModelInput =>
	modelInput(raw, {
		catalogs: {
			ontology: { catalog: LOCAL_CATALOG, ok: true, detail: '' },
			thesauri: modelInput({}).catalogs.thesauri,
		},
	});

const planOf = (raw: Readonly<Record<string, unknown>>, local = false): InstallPlan =>
	buildInstallPlan(raw, local ? { ontologyCatalog: LOCAL_CATALOG } : {});

/** The question that asks `key` on the screens of `input`. */
function questionFor(input: ScreenModelInput, key: string): Question | undefined {
	return questionsOf(buildScreens(input)).find(
		(question) => question.key === key || question.sets.includes(key as never),
	);
}

// ── (a) completeness ─────────────────────────────────────────────────────────

describe('screen model — every answer is asked, or fixed with a reason (a)', () => {
	test('FLAGS_ONLY keys are real answers with a reason', () => {
		expect(Object.keys(FLAGS_ONLY_ANSWER_KEYS).length).toBeGreaterThan(0);
		for (const [key, reason] of Object.entries(FLAGS_ONLY_ANSWER_KEYS)) {
			expect(ANSWER_SET.has(key), key).toBe(true);
			expect(reason.trim().length, key).toBeGreaterThan(20);
		}
	});

	for (const route of INSTALL_ROUTES) {
		test(`${route}: asked ∪ ROUTE_FIXED ∪ FLAGS_ONLY = every answer + every secret; disjoint`, () => {
			const screens = maximalRaws(route).flatMap((raw) => buildScreens(modelInput(raw)));
			const asked = routeAskedKeys(route);
			const fixed = ROUTE_FIXED[route];
			for (const [key, reason] of Object.entries(fixed)) {
				expect(ANSWER_SET.has(key) || SECRET_SET.has(key), key).toBe(true);
				expect(reason.trim().length, key).toBeGreaterThan(20);
				expect(asked.has(key), `${key} is ROUTE_FIXED on ${route} yet asked`).toBe(false);
			}
			for (const key of Object.keys(FLAGS_ONLY_ANSWER_KEYS))
				expect(asked.has(key), key).toBe(false);
			const covered = new Set([
				...asked,
				...Object.keys(fixed),
				...Object.keys(FLAGS_ONLY_ANSWER_KEYS),
			]);
			expect([...covered].sort()).toEqual(
				[...new Set([...INSTALL_ANSWER_KEYS, ...SECRET_KEYS])].sort(),
			);
			// Every question names a real key (or none: an acknowledgement).
			for (const question of questionsOf(screens)) {
				if (question.key !== null) {
					expect(ANSWER_SET.has(question.key) || SECRET_SET.has(question.key), question.id).toBe(
						true,
					);
				}
				expect(question.id, question.id).toMatch(/^[a-z_]+\.[a-z_]+$/);
			}
		});
	}

	test('the root password is asked on every route (all install here); the union of all routes asks every non-flags-only answer', () => {
		const union = new Set<string>();
		for (const route of INSTALL_ROUTES) {
			const asked = routeAskedKeys(route);
			for (const key of asked) union.add(key);
			// Phase 4: every route installs from here — the root password is always asked.
			expect(asked.has('root_password'), route).toBe(true);
		}
		const expected = [...INSTALL_ANSWER_KEYS, ...SECRET_KEYS].filter(
			(key) => FLAGS_ONLY_ANSWER_KEYS[key] === undefined,
		);
		expect([...union].sort()).toEqual([...new Set(expected)].sort());
	});
});

// ── (b) order ────────────────────────────────────────────────────────────────

/** The owner's step lists (the approved mockup): production; docker swaps the host parts. */
const OWNER_PRODUCTION: ScreenId[] = [
	'route',
	'system',
	// Owner decision 2026-10-12: identity before the database (its role is the service user).
	'identity',
	'database',
	'web_tls',
	'services',
	'ontologies',
	'thesauri',
	'languages',
	'publication',
	'mail',
	'administrator',
	'review',
];
const OWNER_DOCKER: ScreenId[] = [
	'route',
	'system',
	'image',
	'tls_address',
	'containers',
	...OWNER_PRODUCTION.filter(
		(id) => !['route', 'system', 'database', 'web_tls', 'services'].includes(id),
	),
];

describe('screen model — the order (b)', () => {
	test("production and docker are the owner's step lists; trial is docker minus the TLS choices", () => {
		expect(SCREEN_ORDER.production).toEqual(OWNER_PRODUCTION);
		expect(SCREEN_ORDER.docker).toEqual(OWNER_DOCKER);
		expect(SCREEN_ORDER.trial).toEqual(OWNER_DOCKER.filter((id) => id !== 'tls_address'));
		// The developer's development server follows the identity (DEV_ROUTE_SERVE §1.1).
		expect(SCREEN_ORDER.developer).toEqual(
			(
				[
					'route',
					'system',
					'database',
					'identity',
					'dev_server',
					...OWNER_PRODUCTION.slice(4),
				] as ScreenId[]
			).filter((id) => id !== 'web_tls' && id !== 'services'),
		);
	});

	for (const route of INSTALL_ROUTES) {
		test(`${route}: the built screens are SCREEN_ORDER, numbered 1..n`, () => {
			const screens = buildScreens(modelInput(maximalRaw(route)));
			expect(screens.map((screen) => screen.id)).toEqual([...SCREEN_ORDER[route]]);
			expect(screens.map((screen) => screen.index)).toEqual(screens.map((_s, index) => index + 1));
			for (const screen of screens) expect(screen.count).toBe(screens.length);
		});
	}

	test('before a route is chosen: the production list, the route question required with NO default', () => {
		const screens = buildScreens(modelInput({}));
		expect(screens.map((screen) => screen.id)).toEqual([...SCREEN_ORDER.production]);
		const route = screens[0]?.questions[0];
		expect(route?.id).toBe('route.route');
		expect(route?.required).toBe(true);
		expect(route?.default).toBeNull();
		expect(route?.options?.map((option) => option.value)).toEqual([...INSTALL_ROUTES]);
	});
});

// ── (c) defaults are the plan's ──────────────────────────────────────────────

/** The defaults that are NOT the plain read-back — each with why (and measured below). */
const DEFAULT_EXEMPTIONS: Readonly<Record<string, string>> = {
	route: 'chosen, never defaulted (no route = developer only for a headless run)',
	timezone: "the host's own time zone when the validator accepts it (D3), else the plan's",
	locale: "the host's own locale when the validator accepts it (D3), else the plan's",
	langs: 'the language derivation (deriveLangConfig) — the plan leaves the answer absent',
	app_lang_default: 'the language derivation over the ticked set',
	data_lang_default: 'the language derivation over the ticked set',
	// The developer listener (DEV_ROUTE_SERVE §1.1): its answers stay '' ("the plan
	// decides") so a re-run keeps the .env's own value — the question shows what that is.
	dev_port:
		"the developer listener's port in effect: the prior .env's SERVER_TCP_PORT, else 3500 (D3)",
	dev_host:
		"the developer listener's address in effect: the prior .env's SERVER_TCP_HOST, else 127.0.0.1",
	tls_mode:
		"developer only: the prior .env's pair kept (''), else local_ca (D1); every other route the plain read-back",
	unix_socket:
		"developer only: the prior .env's SERVER_UNIX_SOCKET, else the entity's /tmp/dedalo_ts_<entity>.sock; every other route the plain read-back",
	// The public address (developer, trial): a suggestion that becomes the answer once accepted.
	public_host: "the prior .env's DEDALO_HOST, else none (the plan's '' writes nothing either)",
	public_protocol: "the prior .env's DEDALO_PROTOCOL beside its DEDALO_HOST, else https://",
	public_host_keep_private:
		"the unreachable host's follow-up offers the safe answer, none (keep it is chosen)",
};

describe('screen model — every default is the plan’s (c)', () => {
	for (const route of INSTALL_ROUTES) {
		test(`${route}: every unanswered question's default = normalizeInstallAnswers(answers without it)`, () => {
			const raw = maximalRaw(route);
			let checked = 0;
			for (const question of questionsOf(buildScreens(modelInput(raw)))) {
				const key = question.key;
				if (key === null || SECRET_SET.has(key) || question.answered) continue;
				if (DEFAULT_EXEMPTIONS[key] !== undefined) continue;
				const { [key]: _drop, ...without } = raw;
				expect(question.default, `${route} ${question.id}`).toEqual(
					normalizeInstallAnswers(without).answers[key as keyof InstallPlan['answers']],
				);
				checked += 1;
			}
			expect(checked, 'anti-vacuity').toBeGreaterThan(15);
		});
	}

	test('the exemptions are exactly these keys, each measured', () => {
		const lang = deriveLangConfig({});
		const input = modelInput({ route: 'developer' });
		expect(questionFor(input, 'langs')?.default).toEqual(lang.projectsDefaultLangs);
		expect(questionFor(input, 'app_lang_default')?.default).toBe(lang.applicationLangsDefault);
		expect(questionFor(input, 'data_lang_default')?.default).toBe(lang.dataLangDefault);
		// No host suggestion: the plan's own.
		const plain = normalizeInstallAnswers({}).answers;
		expect(questionFor(input, 'timezone')?.default).toBe(plain.timezone);
		expect(questionFor(input, 'locale')?.default).toBe(plain.locale);
		// A valid host suggestion wins; an invalid one never does.
		const host = modelInput(
			{ route: 'developer' },
			{ host: { timezone: 'Asia/Kathmandu', locale: 'ne-NP' } },
		);
		expect(questionFor(host, 'timezone')?.default).toBe('Asia/Kathmandu');
		expect(questionFor(host, 'locale')?.default).toBe('ne-NP');
		const bad = modelInput(
			{ route: 'developer' },
			{ host: { timezone: 'Mars/Base', locale: '!!' } },
		);
		expect(questionFor(bad, 'timezone')?.default).toBe(plain.timezone);
		expect(questionFor(bad, 'locale')?.default).toBe(plain.locale);
		expect(questionFor(input, 'route')?.default).toBeNull();
		expect(Object.keys(DEFAULT_EXEMPTIONS).sort()).toEqual(
			[
				'app_lang_default',
				'data_lang_default',
				'dev_host',
				'dev_port',
				'langs',
				'locale',
				'public_host',
				'public_host_keep_private',
				'public_protocol',
				'route',
				'timezone',
				'tls_mode',
				'unix_socket',
			].sort(),
		);
		// The public address: none / https:// on a fresh machine, the prior .env's on a re-run,
		// and the unreachable host's follow-up offers none.
		expect(questionFor(input, 'public_host')?.default).toBe('none');
		const priorPublic = modelInput(
			{ route: 'developer', public_host: 'museum.example.org' },
			{ priorEnv: { DEDALO_HOST: 'museum.example.org', DEDALO_PROTOCOL: 'http://' } },
		);
		expect(questionFor(priorPublic, 'public_host')?.default).toBe('museum.example.org');
		expect(questionFor(priorPublic, 'public_protocol')?.default).toBe('http://');
		const intranet = modelInput({ route: 'developer', public_host: 'dedalo.lan' });
		expect(questionFor(intranet, 'public_protocol')?.default).toBe('https://');
		expect(questionFor(intranet, 'public_host_keep_private')?.default).toBe('none');
		// The developer listener: the route defaults on a fresh machine (D1, D3) …
		expect(questionFor(input, 'dev_port')?.default).toBe('3500');
		expect(questionFor(input, 'dev_host')?.default).toBe('127.0.0.1');
		expect(questionFor(input, 'tls_mode')?.default).toBe('local_ca');
		// The socket: the engine default with no entity, the entity's own with one.
		expect(questionFor(input, 'unix_socket')?.default).toBe('/tmp/dedalo_ts.sock');
		const named = modelInput({ route: 'developer', entity: 'Test' });
		expect(questionFor(named, 'unix_socket')?.default).toBe('/tmp/dedalo_ts_test.sock');
		expect(questionFor(named, 'unix_socket')?.value).toBe('/tmp/dedalo_ts_test.sock');
		expect(
			questionFor(
				modelInput(
					{ route: 'developer', entity: 'test' },
					{ priorEnv: { SERVER_UNIX_SOCKET: '/run/me/d.sock' } },
				),
				'unix_socket',
			)?.default,
		).toBe('/run/me/d.sock');
		// … what the prior .env already holds on a re-run (PRESERVE) …
		const rerun = modelInput(
			{ route: 'developer' },
			{
				priorEnv: {
					SERVER_TCP_PORT: '3600',
					SERVER_TCP_HOST: '0.0.0.0',
					SERVER_TCP_TLS_CERT_FILE: '/k/fullchain.pem',
					SERVER_TCP_TLS_KEY_FILE: '/k/privkey.pem',
				},
			},
		);
		expect(questionFor(rerun, 'dev_port')?.default).toBe('3600');
		expect(questionFor(rerun, 'dev_host')?.default).toBe('0.0.0.0');
		const keep = questionFor(rerun, 'tls_mode');
		expect(keep?.default).toBe('');
		expect(keep?.options?.map((option) => option.value)).toEqual(['', 'local_ca', 'none', 'files']);
		// … and every other route's tls_mode is still the plain read-back.
		for (const route of ['production', 'docker'] as const) {
			const raw = maximalRaw(route);
			const { tls_mode: _drop, ...without } = raw;
			expect(questionFor(modelInput(raw), 'tls_mode')?.default, route).toBe(
				normalizeInstallAnswers(without).answers.tls_mode,
			);
		}
		// … and production's socket (the services screen) is still the plain read-back.
		const { unix_socket: _socket, ...noSocket } = maximalRaw('production');
		expect(questionFor(modelInput(noSocket), 'unix_socket')?.default).toBe(
			normalizeInstallAnswers(noSocket).answers.unix_socket,
		);
	});

	test('production: the names derive from the instance (the peer role ded_<i>, the root-rule media path); docker/trial: the stack constants', () => {
		const production = modelInput({ ...MAXIMAL_RAW, instance: 'prado' });
		const existing = modelInput({ ...MAXIMAL_RAW, instance: 'prado', db_mode: 'existing' });
		const derived = routeDefaults('production', 'prado');
		for (const key of [
			'db_database',
			'media_path',
			'unix_socket',
			'mysql_database',
			'install_dir',
			'service_user',
			'backup_dir',
		] as const) {
			expect(questionFor(production, key)?.default, key).toBe(derived[key]);
		}
		expect(questionFor(existing, 'db_username')?.default).toBe(derived.db_username);
		expect(derived.db_database).toBe('dedalo_prado');
		// Owner decisions 2026-10-12: the folder and the account default to the instance's own;
		// the PEER role of a created database is the service user.
		expect(derived.install_dir).toBe('/home/ded_prado');
		expect(derived.service_user).toBe('ded_prado');
		expect(derived.backup_dir).toBe('/home/ded_prado/backups');
		expect(derived.db_username).toBe('ded_prado');
		expect(questionFor(production, 'service_group')?.default).toBe('');
		expect(derived.db_socket).toBe('/var/run/postgresql');
		// THE ROOT RULE: root (/srv/dedalo/prado) + /dedalo/media == MEDIA_PATH (critique B1).
		expect(derived.media_path).toBe('/srv/dedalo/prado/dedalo/media');
		// The instance changes → the defaults follow (nothing was stored for them).
		const renamed = modelInput({ ...MAXIMAL_RAW, instance: 'goya' });
		expect(questionFor(renamed, 'db_database')?.default).toBe('dedalo_goya');
		for (const route of ['docker', 'trial'] as const) {
			const plan = normalizeInstallAnswers({ route }).answers;
			expect(plan.db_hostname, route).toBe(routeDefaults(route, '').db_hostname);
			expect(plan.media_path, route).toBe(routeDefaults(route, '').media_path);
		}
	});

	test("the trial stack's DELEGATED engine answers decide exactly what --route trial derives (the container's own plan)", () => {
		// Phase 4: install.sh is a bootstrap; the docker/trial host steps hand the engine
		// child (inside the container) its answers on stdin — stackEngineAnswers.
		const trial = buildInstallPlan({ route: 'trial', entity: 'trial_museum' });
		expect(trial.errors).toEqual([]);
		const delegated = stackEngineAnswers({
			plan: buildPlanFile(trial, {}),
		} as unknown as HostPlanCtx);
		expect(delegated.engine_only).toBe(true);
		expect(delegated.route).toBe('trial');
		for (const key of HOST_ONLY_ANSWER_KEYS) expect(key in delegated, key).toBe(false);
		const child = buildInstallPlan(delegated as Record<string, unknown>);
		expect(child.errors).toEqual([]);
		const derived = routeDefaults('trial', '');
		for (const key of [
			'db_hostname',
			'db_database',
			'db_username',
			'media_path',
			'unix_socket',
		] as const) {
			expect(child.answers[key], key).toBe(derived[key]);
		}
		// The child runs the ENGINE steps only (the host steps are this process's).
		expect(
			child.steps.every((step) => !step.startsWith('stack_') && !step.startsWith('host_')),
		).toBe(true);
	});

	test('accepting a shown default leaves the key ABSENT (a derived default keeps following)', () => {
		let raw: Record<string, unknown> = { route: 'production', instance: 'prado' };
		const db = questionFor(modelInput(raw), 'db_database') as Question;
		raw = applyAnswer(raw, db, db.default);
		expect(Object.hasOwn(raw, 'db_database')).toBe(false);
		const instance = questionFor(modelInput(raw), 'instance') as Question;
		raw = applyAnswer(raw, instance, 'goya');
		expect(normalizeInstallAnswers(raw).answers.db_database).toBe('dedalo_goya');
	});
});

// ── (c2) the install folder and the service account (owner decisions 2026-10-12) ──

/** A verdict fixture: an existing hosting account, its primary group, a login shell. */
function hostingVerdict(): IdentityVerdict {
	return {
		problems: [],
		told: [
			'account my_domain.org has a login shell (/bin/bash): whoever logs in as it can change the code the service runs',
			'the web server user www-data joins psacln, the primary group of my_domain.org: it can then read whatever that group can read — a group of its own is recommended (--service-group ded_prado)',
			"group psacln has other members (other.org): they can read the instance's files",
		],
		user: { name: 'my_domain.org', create: false, uid: 10001, shell: '/bin/bash' },
		group: { name: 'psacln', create: false, withUser: false, primaryOf: 'my_domain.org' },
		folder: { kind: 'create', by: 'user', ancestors: [] },
		parent: '/home/my_domain.org',
	};
}

describe('screen model — the install folder and the service account (c2)', () => {
	const HOSTING_RAW = {
		...MAXIMAL_RAW,
		instance: 'prado',
		install_dir: '/home/my_domain.org/dedalo',
		service_user: 'my_domain.org',
	};

	test('production: the identity screen asks install_dir, service_user, service_group FIRST, behind the identity probe', () => {
		const screens = buildScreens(modelInput({ ...MAXIMAL_RAW, instance: 'prado' }));
		const identity = screens.find((screen) => screen.id === 'identity');
		expect(identity?.questions.slice(0, 3).map((question) => question.key)).toEqual([
			'install_dir',
			'service_user',
			'service_group',
		]);
		expect(identity?.probe).toEqual({ id: 'identity', gate: 'must_pass' });
		const order = screens.map((screen) => screen.id);
		expect(order.indexOf('identity')).toBeLessThan(order.indexOf('database'));
	});

	test('the level-2 defaults follow the level-1 ANSWERS: backups inside the folder, the role = the service user', () => {
		const existing = modelInput({ ...HOSTING_RAW, db_mode: 'existing' });
		expect(questionFor(existing, 'backup_dir')?.default).toBe('/home/my_domain.org/dedalo/backups');
		expect(questionFor(existing, 'db_username')?.default).toBe('my_domain.org');
		// An explicit backup dir wins.
		const explicit = modelInput({ ...HOSTING_RAW, backup_dir: '/srv/backups/prado' });
		expect(questionFor(explicit, 'backup_dir')?.answered).toBe(true);
		expect(planOf({ ...HOSTING_RAW, backup_dir: '/srv/backups/prado' }).answers.backup_dir).toBe(
			'/srv/backups/prado',
		);
	});

	test('a created database never asks its role (peer: the service user); an existing one does', () => {
		expect(questionFor(modelInput({ ...MAXIMAL_RAW, instance: 'prado' }), 'db_username')).toBe(
			undefined,
		);
		expect(
			questionFor(
				modelInput({ ...MAXIMAL_RAW, instance: 'prado', db_mode: 'existing' }),
				'db_username',
			),
		).toBeDefined();
	});

	for (const route of ['developer', 'docker', 'trial'] as const) {
		test(`${route}: the three keys are not asked, each ROUTE_FIXED with its reason`, () => {
			const asked = routeAskedKeys(route);
			for (const key of ['install_dir', 'service_user', 'service_group']) {
				expect(asked.has(key), key).toBe(false);
				expect(ROUTE_FIXED[route][key], key).toBe(
					'only a production install has an install folder and service account of its own',
				);
			}
		});
	}

	test("the service group's hint comes from the probe and is never written as an answer", () => {
		const verdict = hostingVerdict();
		const input = modelInput(HOSTING_RAW, {
			probes: { identity: { ok: true, detail: 'measured', identity: verdict } },
		});
		const group = questionFor(input, 'service_group');
		expect(group?.hint).toBe('primary group of my_domain.org: psacln');
		expect(group?.default).toBe('');
		expect(planOf(HOSTING_RAW).answers.service_group).toBe('');
	});

	test('the Review says what is CREATED and what is USED AS IS, and every notice of the verdict', () => {
		const input = modelInput(HOSTING_RAW, {
			probes: { identity: { ok: true, detail: 'measured', identity: hostingVerdict() } },
		});
		const lines = reviewLines(planOf(HOSTING_RAW), input).map((line) => line.value);
		expect(lines).toContain(
			'/home/my_domain.org/dedalo — CREATED (my_domain.org:psacln 0750, by my_domain.org; parent /home/my_domain.org unchanged)',
		);
		expect(lines).toContain(
			'my_domain.org — USED AS IS (uid 10001; never created or deleted by the installer)',
		);
		expect(lines).toContain('psacln — USED AS IS (primary group of my_domain.org)');
		expect(lines).toContain('my_domain.org (peer: the service user)');
		for (const told of hostingVerdict().told) expect(lines).toContain(told);
		// Without a verdict (a headless plan), the run's System check decides — said so.
		const headless = reviewLines(planOf(HOSTING_RAW), modelInput(HOSTING_RAW)).map(
			(line) => line.value,
		);
		expect(headless).toContain(
			'/home/my_domain.org/dedalo — created or used as is — decided by the System check of the run',
		);
	});
});

// ── (d) one rule set ─────────────────────────────────────────────────────────

interface Planted {
	name: string;
	/** The answers before the bad one (the screen state it is typed on). */
	base: Record<string, unknown>;
	key: string;
	value: unknown;
}

const PLANTED: readonly Planted[] = [
	{ name: 'entity 1x', base: { route: 'developer' }, key: 'entity', value: '1x' },
	{ name: 'db_port x', base: { route: 'developer' }, key: 'db_port', value: 'x' },
	{ name: 'relative db_socket', base: { route: 'developer' }, key: 'db_socket', value: 'tmp/pg' },
	{ name: 'timezone Mars/X', base: { route: 'developer' }, key: 'timezone', value: 'Mars/X' },
	{ name: 'locale !!', base: { route: 'developer' }, key: 'locale', value: '!!' },
	{
		name: 'smtp_secure x',
		base: { route: 'developer', mailer: true, smtp_host: 'smtp.example.org' },
		key: 'smtp_secure',
		value: 'x',
	},
	{ name: 'smtp_port 0', base: { route: 'developer', mailer: true }, key: 'smtp_port', value: '0' },
	{
		name: 'mysql_port x',
		base: { route: 'developer', diffusion: true },
		key: 'mysql_port',
		value: 'x',
	},
	{
		name: 'media mode x',
		base: { route: 'production', instance: 'prado' },
		key: 'media_access_mode',
		value: 'x',
	},
	{
		name: 'relative media_path',
		base: { route: 'production', instance: 'prado' },
		key: 'media_path',
		value: 'm',
	},
	{
		name: 'production without an instance',
		base: { route: 'production', instance: 'prado' },
		key: 'instance',
		value: '',
	},
	{
		name: 'a malformed instance',
		base: { route: 'production' },
		key: 'instance',
		value: 'Prado-1',
	},
	{
		name: 'information with a newline',
		base: { route: 'developer' },
		key: 'information',
		value: 'a\nb',
	},
	{
		name: 'db_database shaped like an option',
		base: { route: 'developer' },
		key: 'db_database',
		value: '-cfoo',
	},
	{
		name: 'diffusion without a user',
		base: { route: 'developer', diffusion: true },
		key: 'mysql_username',
		value: '',
	},
	{ name: 'an empty language set', base: { route: 'developer' }, key: 'langs', value: [] },
	{
		name: 'app lang outside the set (B2: on ITS question, not langs)',
		base: { route: 'developer', langs: ['lg-eng'] },
		key: 'app_lang_default',
		value: 'lg-spa',
	},
	{ name: 'no domain ontology', base: { route: 'developer' }, key: 'ontologies', value: [] },
];

describe('screen model — one rule set: the plan’s sentences on the right question (d)', () => {
	for (const planted of PLANTED) {
		test(planted.name, () => {
			const before = questionFor(modelInput(planted.base), planted.key);
			expect(before, `${planted.key} is asked on that screen state`).toBeDefined();
			const raw = applyAnswer(planted.base, before as Question, planted.value);
			const plan = planOf(raw);
			const after = questionFor(modelInput(raw), planted.key) as Question;
			const mine = plan.fieldErrors.filter(
				(item) => item.key === planted.key || after.sets.includes(item.key as never),
			);
			expect(mine.length, `the plan tags a refusal on ${planted.key}`).toBeGreaterThan(0);
			for (const item of mine) {
				expect(after.errors, planted.name).toContain(item.message);
				expect(plan.errors, planted.name).toContain(item.message);
			}
			// The question shows ONLY the plan's sentences.
			for (const message of after.errors) {
				expect(plan.fieldErrors.map((item) => item.message)).toContain(message);
			}
		});
	}

	test('an unknown thesaurus in an answers file lands on the thesauri question', () => {
		const raw = { route: 'developer', hierarchies: ['zzsmx'] };
		const message = "unknown hierarchy 'zzsmx' (no entry in hierarchy.json)";
		expect(planOf(raw).errors).toContain(message);
		expect(questionFor(modelInput(raw), 'hierarchies')?.errors).toContain(message);
	});

	test('every fieldErrors message is a plan error (byte-identical)', () => {
		for (const planted of PLANTED) {
			const plan = planOf({ ...planted.base, [planted.key]: planted.value });
			for (const item of plan.fieldErrors)
				expect(plan.errors, planted.name).toContain(item.message);
		}
	});

	test('B1: no fieldError ever sits on a key no visible question asks — over every route and a walk of reachable answers', () => {
		let states = 0;
		for (const route of INSTALL_ROUTES) {
			for (const planted of PLANTED) {
				// The bad answer typed on its screen, then the route changed to `route`.
				const first = questionFor(modelInput(planted.base), planted.key) as Question;
				let raw = applyAnswer(planted.base, first, planted.value);
				const routeQuestion = questionFor(modelInput(raw), 'route') as Question;
				raw = applyAnswer(raw, routeQuestion, route);
				const visible = askedKeys(buildScreens(modelInput(raw)));
				for (const item of planOf(raw).fieldErrors) {
					expect(visible.has(item.key), `${planted.name} → ${route}: ${item.key}`).toBe(true);
				}
				states += 1;
			}
		}
		expect(states).toBe(INSTALL_ROUTES.length * PLANTED.length);
	});

	test('B1: a production instance, then the developer route — the instance answer is dropped, no hidden error remains', () => {
		let raw: Record<string, unknown> = {};
		raw = applyAnswer(raw, questionFor(modelInput(raw), 'route') as Question, 'production');
		raw = applyAnswer(raw, questionFor(modelInput(raw), 'instance') as Question, 'prado');
		raw = applyAnswer(raw, questionFor(modelInput(raw), 'media_path') as Question, '/data/m');
		expect(raw.instance).toBe('prado');
		raw = applyAnswer(raw, questionFor(modelInput(raw), 'route') as Question, 'developer');
		expect(Object.hasOwn(raw, 'instance')).toBe(false);
		expect(Object.hasOwn(raw, 'media_path')).toBe(false);
		expect(planOf(raw).fieldErrors.filter((item) => item.key === 'instance')).toEqual([]);
		expect(visibleKeys(raw).has('instance')).toBe(false);
	});

	test('a service turned off drops its answers (nobody can see them, nothing writes them)', () => {
		let raw: Record<string, unknown> = { route: 'developer' };
		raw = applyAnswer(raw, questionFor(modelInput(raw), 'mailer') as Question, true);
		raw = applyAnswer(
			raw,
			questionFor(modelInput(raw), 'smtp_host') as Question,
			'smtp.example.org',
		);
		raw = applyAnswer(raw, questionFor(modelInput(raw), 'mailer') as Question, false);
		expect(Object.hasOwn(raw, 'smtp_host')).toBe(false);
		expect(planOf(raw).envKeys).not.toContain('DEDALO_SMTP_HOST');
	});
});

// ── (e) L31: the toponymy DEFINITION is not a toponymy ───────────────────────

/** Clean developer answers over the local fixture source (air-gapped: no server). */
const FIXTURE_BASE = {
	route: 'developer',
	db_database: 'd',
	db_username: 'u',
	entity: 'e',
	update_servers: 'none',
	ontology_source: '',
};
const FIXTURE_ARGV = [
	'--route',
	'developer',
	'--db-name',
	'd',
	'--db-user',
	'u',
	'--entity',
	'e',
	'--no-update-servers',
];

describe('screen model — L31: htoponymy never suppresses the own-country suggestion (e)', () => {
	const toponymyNotice = NOTICE_TEXT.toponymy(NOTICE_TEXT.toponymyExample);
	const thesauriNotices = (input: ScreenModelInput): string[] =>
		(buildScreens(input).find((screen) => screen.id === 'thesauri')?.notices ?? []).map(
			(notice) => notice.text,
		);
	const offer = offeredHierarchies();
	const countries = offer.filter(
		(meta) => meta.typology_id === TOPONYMY_TYPOLOGY_ID && meta.data_files.length > 0,
	);
	const definitions = offer.filter(
		(meta) => meta.typology_id === TOPONYMY_TYPOLOGY_ID && meta.data_files.length === 0,
	);

	test('anti-vacuity: the offer has country toponymies with data AND a definition without', () => {
		expect(countries.length).toBeGreaterThan(0);
		expect(definitions.map((meta) => meta.tld)).toContain('htoponymy');
	});

	test("hierarchies ['htoponymy']: the suggestion AND the screen's notice stay", () => {
		const raw = { route: 'developer', hierarchies: ['htoponymy'] };
		const plan = planOf(raw);
		expect(plan.hierarchies).toContain('htoponymy');
		expect(plan.suggestions).toEqual([TOPONYMY_SUGGESTION]);
		expect(toponymyMissing(plan.hierarchies, [])).toBe(true);
		expect(thesauriNotices(modelInput(raw))).toContain(toponymyNotice);
	});

	test("hierarchies ['ad'] (a country): no suggestion, no notice", () => {
		const raw = { route: 'developer', hierarchies: ['ad'] };
		expect(planOf(raw).suggestions).toEqual([]);
		expect(thesauriNotices(modelInput(raw))).not.toContain(toponymyNotice);
	});

	test('an ontology DECLARING htoponymy (zzsma): pre-ticked by the plan, the suggestion kept', () => {
		const raw = { ...FIXTURE_BASE, ontology_source: SOURCE_DIR, ontologies: ['zzsma'] };
		const plan = planOf(raw, true);
		expect(plan.errors).toEqual([]);
		expect(plan.hierarchies).toContain('htoponymy');
		expect(plan.suggestions).toEqual([TOPONYMY_SUGGESTION]);
		const thesauri = questionFor(withLocal(raw), 'hierarchies') as Question;
		const option = thesauri.options?.find((item) => item.value === 'htoponymy');
		expect(option?.selected).toBe(true);
		expect(option?.external).toBe(true);
		expect(option?.marks.some((mark) => mark.kind === 'needed_by')).toBe(true);
		expect(option?.marks.some((mark) => mark.kind === 'empty')).toBe(true);
		expect(thesauriNotices(withLocal(raw))).toContain(toponymyNotice);
	});

	test('B6: the example code the notice quotes is a real country toponymy, and typing it toggles it', () => {
		const example = NOTICE_TEXT.toponymyExample;
		expect(countries.map((meta) => meta.tld)).toContain(example);
		const thesauri = questionFor(modelInput({ route: 'developer' }), 'hierarchies') as Question;
		const state = multiState(thesauri);
		expect(state.selected.has(example)).toBe(false);
		multiCommand(state, example, () => undefined);
		expect(multiResult(state)).toContain(example);
		const raw = applyAnswer({ route: 'developer' }, thesauri, multiResult(state));
		expect(planOf(raw).hierarchies).toContain(example);
		expect(planOf(raw).suggestions).toEqual([]);
	});
});

// ── (f) ticks map to the flags' answers ──────────────────────────────────────

/** The plan of an argv over the local fixture catalog. */
function argvPlan(argv: readonly string[]): InstallPlan {
	const invocation = answersFromCliArgs(argv);
	expect(invocation.errors, argv.join(' ')).toEqual([]);
	return planOf(invocation.raw, true);
}

/** Apply `ticks` to the question asking `key` on the local-fixture screens. */
function tick(raw: Record<string, unknown>, key: string, ticks: string[]): Record<string, unknown> {
	return applyAnswer(raw, questionFor(withLocal(raw), key) as Question, ticks);
}

describe('screen model — ticks decide what the equivalent flags decide (f)', () => {
	const base = { ...FIXTURE_BASE, ontology_source: SOURCE_DIR };
	const baseArgv = [...FIXTURE_ARGV, '--ontology-source', SOURCE_DIR];

	test('ontologies: tick zzsma (its optional zzsmb pre-ticked) ≡ --ontologies zzsma,oh', () => {
		const raw = tick(base, 'ontologies', ['zzsma', 'zzsmb', 'oh']);
		expect(decided(planOf(raw, true))).toEqual(
			decided(argvPlan([...baseArgv, '--ontologies', 'zzsma,oh'])),
		);
	});

	test('explicit roots: re-answering the thesauri unchanged over flags that NAME a declared one keeps their plan', () => {
		const declared = declaredThesauri(DEFAULT_ONTOLOGIES).install;
		const last = declared.at(-1) as string;
		for (const argv of [
			['--hierarchies', `fr,${last}`],
			['--hierarchies', `${last},fr`, '--decline-dependencies', `${last}:hierarchy1`],
		]) {
			const invocation = answersFromCliArgs([...FIXTURE_ARGV, ...argv]);
			expect(invocation.errors).toEqual([]);
			const before = planOf(invocation.raw);
			const thesauri = questionFor(modelInput(invocation.raw), 'hierarchies') as Question;
			const after = applyAnswer(invocation.raw, thesauri, thesauri.value);
			expect(decided(planOf(after)), argv.join(' ')).toEqual(decided(before));
			// Anti-vacuity: the named one is really declared, and really first-class in the order.
			expect(before.hierarchies.indexOf(last)).toBeLessThan(before.hierarchies.length - 1);
		}
	});

	test('the ONE keystroke an operator types: `zzsma` (after the default oh) ≡ --ontologies oh,zzsma; then `zzsmb` ≡ its decline', () => {
		const ontologies = questionFor(withLocal(base), 'ontologies') as Question;
		const state = multiState(ontologies);
		expect(state.selected.has('zzsmb')).toBe(false);
		multiCommand(state, 'zzsma', () => undefined);
		const ticked = applyAnswer(base, ontologies, multiResult(state));
		expect(decided(planOf(ticked, true))).toEqual(
			decided(argvPlan([...baseArgv, '--ontologies', 'oh,zzsma'])),
		);
		multiCommand(state, 'zzsmb', () => undefined);
		const declined = applyAnswer(base, ontologies, multiResult(state));
		expect(decided(planOf(declined, true))).toEqual(
			decided(
				argvPlan([
					...baseArgv,
					'--ontologies',
					'oh,zzsma',
					'--decline-dependencies',
					'zzsmb:ontology35',
				]),
			),
		);
	});

	test('ontologies: untick the optional dependency ≡ --decline-dependencies zzsmb:ontology35', () => {
		const raw = tick(base, 'ontologies', ['zzsma', 'oh']);
		const plan = planOf(raw, true);
		expect(plan.activeOntologyTlds).not.toContain('zzsmb');
		expect(decided(plan)).toEqual(
			decided(
				argvPlan([
					...baseArgv,
					'--ontologies',
					'zzsma,oh',
					'--decline-dependencies',
					'zzsmb:ontology35',
				]),
			),
		);
	});

	test('thesauri: tick fr, untick the declared htoponymy ≡ --hierarchies fr --decline-dependencies htoponymy:hierarchy1', () => {
		let raw = tick(base, 'ontologies', ['zzsma', 'zzsmb', 'oh']);
		const offered = questionFor(withLocal(raw), 'hierarchies') as Question;
		const ticks = (offered.options ?? [])
			.filter((option) => option.selected && option.value !== 'htoponymy')
			.map((option) => option.value);
		raw = tick(raw, 'hierarchies', [...ticks, 'fr']);
		expect(decided(planOf(raw, true))).toEqual(
			decided(
				argvPlan([
					...baseArgv,
					'--ontologies',
					'zzsma,oh',
					'--hierarchies',
					'fr',
					'--decline-dependencies',
					'htoponymy:hierarchy1',
				]),
			),
		);
		// Re-tick it: the decline is gone again (B8 — classified against the NEW selection).
		raw = tick(raw, 'hierarchies', [...ticks, 'fr', 'htoponymy']);
		expect(decided(planOf(raw, true))).toEqual(
			decided(argvPlan([...baseArgv, '--ontologies', 'zzsma,oh', '--hierarchies', 'fr'])),
		);
	});

	test('a stale decline (its declarer unticked) is dropped; a bare token is narrowed, never lost', () => {
		// zzsmb declined while zzsma ticked, then zzsma unticked: the decline has no declarer.
		let raw = tick(base, 'ontologies', ['zzsma', 'oh']);
		expect(raw.declined_dependencies).toEqual(['zzsmb:ontology35']);
		raw = tick(raw, 'ontologies', ['oh']);
		expect(raw.declined_dependencies).toBeUndefined();
		// A bare token (both mains) from an answers file: the thesaurus question re-decides
		// ITS half and keeps the ontology half.
		const bare = { ...base, ontologies: ['zzsma', 'oh'], declined_dependencies: ['zzsmb'] };
		const before = planOf(bare, true);
		expect(before.activeOntologyTlds).not.toContain('zzsmb');
		const thesauri = questionFor(withLocal(bare), 'hierarchies') as Question;
		const same = applyAnswer(bare, thesauri, thesauri.value);
		expect(same.declined_dependencies).toEqual(['zzsmb:ontology35']);
		expect(decided(planOf(same, true))).toEqual(decided(before));
	});

	test('B8 over a declaring thesaurus (mapSelection): a transitive untick keeps the still-ticked dependency', () => {
		const option = (value: string, declares: string[] = []): Option => ({
			value,
			label: value,
			description: '',
			group: null,
			selected: false,
			locked: false,
			marks: [],
			declares: declares.map((tld) => ({ tld, mandatory: false })),
			external: false,
		});
		const options = [option('zzsma', ['zzsmb']), option('zzsmb')];
		expect(mapSelection(new Set(['zzsma', 'zzsmb']), options)).toEqual({
			roots: ['zzsma'],
			declined: [],
		});
		// Untick the declarer, keep its dependency ticked: the dependency becomes a ROOT.
		expect(mapSelection(new Set(['zzsmb']), options)).toEqual({ roots: ['zzsmb'], declined: [] });
		// Untick the dependency: declined.
		expect(mapSelection(new Set(['zzsma']), options)).toEqual({
			roots: ['zzsma'],
			declined: ['zzsmb'],
		});
		// Nothing ticked: nothing declined (no declarer left).
		expect(mapSelection(new Set(), options)).toEqual({ roots: [], declined: [] });
		// Roots keep TICK order (the answer's order is the install order).
		expect(
			mapSelection(new Set(['zzsmb', 'zzsma']), [option('zzsma'), option('zzsmb')]).roots,
		).toEqual(['zzsmb', 'zzsma']);
	});

	test('the language order typed is the order written (DEDALO_PROJECTS_DEFAULT_LANGS)', () => {
		const raw = tick({ route: 'developer' }, 'langs', ['lg-spa', 'lg-eng']);
		expect(planOf(raw).langConfig.projectsDefaultLangs).toEqual(['lg-spa', 'lg-eng']);
		// The prompter keeps the order too: the current value first, then each new tick.
		const question = questionFor(modelInput(raw), 'langs') as Question;
		const state = multiState(question);
		multiCommand(state, 'lg-fra', () => undefined);
		expect(multiResult(state)).toEqual(['lg-spa', 'lg-eng', 'lg-fra']);
	});
});

// ── (+) secrets, notes, the update-server URL ────────────────────────────────

describe('screen model — secrets never enter the answers; texts are complete (+)', () => {
	test('A12: applying ANY secret question never writes a secret key or value into the raw answers', () => {
		let secrets = 0;
		for (const route of INSTALL_ROUTES) {
			for (const question of questionsOf(buildScreens(modelInput(maximalRaw(route))))) {
				if (question.kind !== 'secret') continue;
				const raw = applyAnswer(maximalRaw(route), question, 'Zz-Secret-Value-91');
				expect(
					Object.keys(raw).filter((key) => SECRET_SET.has(key)),
					question.id,
				).toEqual([]);
				expect(JSON.stringify(raw), question.id).not.toContain('Zz-Secret-Value-91');
				secrets += 1;
			}
		}
		expect(secrets).toBeGreaterThanOrEqual(8);
		// Even a secret KEY asked as a plain question is refused.
		const forged = {
			...(questionFor(modelInput(maximalRaw('developer')), 'entity') as Question),
			key: 'db_password' as const,
		};
		expect(applyAnswer({}, forged, 'Zz-Secret-Value-91')).toEqual({});
	});

	test('A9: one text per ontology note key; the official option shows the URL the install will write', () => {
		expect(Object.keys(ONTOLOGY_NOTE_TEXT).sort()).toEqual(
			Object.keys(ONTOLOGY_NOTE_LABELS).sort(),
		);
		const mirror = 'https://mirror.example.org/dedalo/core/api/v1/json/';
		const input = modelInput(
			{ route: 'developer' },
			{
				priorEnv: {
					ONTOLOGY_SERVERS: JSON.stringify([{ name: 'Mirror', url: mirror, code: 'm1' }]),
				},
			},
		);
		const official = questionFor(input, 'update_servers')?.options?.find(
			(option) => option.value === 'official',
		);
		expect(`${official?.label} ${official?.description}`).toContain(mirror);
	});
});

// ── (g) confinement ──────────────────────────────────────────────────────────

/**
 * The terminal installer's UI SIDE, DERIVED (never a hand list): over the
 * engine corpus (the registered write-path lister), every module whose own
 * import closure reaches the screen model (the model itself, the front-end
 * contract, the probe child and its probes, the probe client, the plain UI),
 * then — to a fixed point — every module imported ONLY by UI-side modules (the
 * screen text). The server's closure must hold none of them.
 */
function uiSide(corpus: readonly string[]): Set<string> {
	const model = join(REPO_ROOT, 'src/core/install/screen_model.ts');
	const absolute = corpus.map((file) => join(REPO_ROOT, file));
	const importers = new Map<string, Set<string>>();
	for (const file of absolute) {
		for (const target of directImports(file)) {
			const set = importers.get(target) ?? new Set<string>();
			set.add(file);
			importers.set(target, set);
		}
	}
	const ui = new Set(absolute.filter((file) => reachableModules(true, [file]).includes(model)));
	for (let grew = true; grew; ) {
		grew = false;
		for (const file of absolute) {
			const from = importers.get(file);
			if (ui.has(file) || from === undefined || from.size === 0) continue;
			if ([...from].every((importer) => ui.has(importer))) {
				ui.add(file);
				grew = true;
			}
		}
	}
	return new Set([...ui].map((file) => file.slice(REPO_ROOT.length + 1)));
}

describe('screen model — off the request path (g)', () => {
	const reachable = reachableModules().map((file) => file.slice(REPO_ROOT.length + 1));
	const corpus = writePathSourceFiles().filter((file) => file.startsWith('src/'));
	const ui = uiSide(corpus);

	test('the closure is real: large, and it DOES reach into src/core/install (Maintenance › Import hierarchies)', () => {
		expect(corpus.length).toBeGreaterThan(500);
		expect(reachable.length).toBeGreaterThan(500);
		expect(reachable).toContain('src/core/install/hierarchy_import.ts');
		// The retired wizard router is gone (WC-2026-10-12-install-surface-removed), and
		// with it the plan's only path onto the request path.
		expect(existsSync(join(REPO_ROOT, 'src/core/install/engine.ts'))).toBe(false);
		expect(reachable).not.toContain('src/core/install/install_plan.ts');
	});

	test('the derived UI side holds the model, its text, the front-end contract, the probes and the plain UI', () => {
		expect(ui.size).toBeGreaterThan(8);
		for (const file of [
			'src/core/install/screen_model.ts',
			'src/core/install/screen_text.ts',
			'src/core/install/front_end.ts',
			'src/core/install/probes.ts',
			'src/core/install/install_probe.ts',
			'src/core/install/install_probe_client.ts',
			'src/core/install/install_session.ts',
			'src/core/install/prompter_contract.ts',
			'src/core/install/multi_select.ts',
			'src/core/install/tui_loader.ts',
			'src/core/install/ui/app.ts',
			'src/core/install/ui_plain/prompter.ts',
			'src/core/install/ui_plain/terminal.ts',
		]) {
			expect(ui.has(file), file).toBe(true);
		}
		// …and NOT the plan or its validation (shared with the CLI and the executor): the derivation discriminates.
		expect(ui.has('src/core/install/install_plan.ts')).toBe(false);
		expect(ui.has('src/core/install/install_validation.ts')).toBe(false);
	});

	test('no UI-side module is reachable from dispatch or server', () => {
		expect(reachable.filter((file) => ui.has(file))).toEqual([]);
	});
});

// ── campaign 3 (P5): what each route's screens ask and say ───────────────────

describe('campaign 3: the screens ask what the route uses, in its own words', () => {
	const questions = (raw: Record<string, unknown>): Question[] =>
		buildScreens(modelInput(raw)).flatMap((screen) => screen.questions);
	const screenOf = (raw: Record<string, unknown>, id: ScreenId): Screen =>
		buildScreens(modelInput(raw)).find((screen) => screen.id === id) as Screen;

	test('C3-22: the trial asks no HTTPS port, and its HTTP port is plain HTTP — never "redirects"', () => {
		const trial = questions({ route: 'trial' });
		expect(trial.filter((item) => item.key === 'https_port')).toEqual([]);
		expect(ROUTE_FIXED.trial.https_port).toBeDefined();
		const http = trial.find((item) => item.key === 'http_port') as Question;
		expect(http.description).toBe(NOTICE_TEXT.trialHttpPort);
		expect(http.description).not.toContain('redirect');
		// CONTROL: docker asks both, and says it redirects.
		const docker = questions({ route: 'docker' });
		expect(docker.filter((item) => item.key === 'https_port').length).toBe(1);
		expect(docker.find((item) => item.key === 'http_port')?.description).toContain('redirects');
	});

	test('C3-66: a CREATED production database asks no connection — an existing one asks it all', () => {
		const CONNECTION = ['db_hostname', 'db_port', 'db_socket', 'db_username', 'db_password'];
		const asked = (raw: Record<string, unknown>) =>
			questions(raw)
				.map((item) => item.key as string)
				.filter((key) => CONNECTION.includes(key));
		expect(asked({ route: 'production', instance: 'prado' })).toEqual([]);
		expect(asked({ route: 'production', instance: 'prado', db_mode: 'create' })).toEqual([]);
		expect(asked({ route: 'production', instance: 'prado', db_mode: 'existing' }).sort()).toEqual(
			[...CONNECTION].sort(),
		);
		expect(asked({ route: 'developer' }).sort()).toEqual([...CONNECTION].sort());
		// The database NAME stays asked either way.
		expect(
			questions({ route: 'production', instance: 'prado' }).some(
				(item) => item.key === 'db_database',
			),
		).toBe(true);
	});

	test('C3-33 / C3-26: the trial acknowledgement is evaluation-only, and no description says how to accept', () => {
		const ack = questions({ route: 'trial' }).find(
			(item) => item.id === 'route.trial_no_media_protection',
		) as Question;
		expect(ack.description).toContain('For an evaluation only: never put real records in it');
		expect(ack.description).not.toContain('public collection');
		// How to accept is the FRONT END's line (ACKNOWLEDGE_TEXT), never the model's.
		const acks = [
			'route.trial_no_media_protection',
			'thesauri.none_selected',
			'publication.probe_override',
			'mail.probe_override',
		];
		for (const id of acks) {
			expect(QUESTION_TEXT[id]?.description, id).toBeDefined();
			expect(QUESTION_TEXT[id]?.description, id).not.toMatch(/type yes/i);
		}
	});

	test('C3-48: the docker certificate is COPIED in (its own words); the docker/trial Review never carries the production boilerplate', () => {
		const docker = questions({ route: 'docker', tls_mode: 'files' });
		expect(docker.find((item) => item.key === 'tls_cert_path')?.description).toContain(
			'deploy/certs',
		);
		expect(
			questions({ route: 'production', instance: 'prado', tls_mode: 'files' }).find(
				(item) => item.key === 'tls_cert_path',
			)?.description,
		).toContain('used where it is');
		// The Image screen's question never repeats the screen's own description.
		const image = screenOf({ route: 'trial' }, 'image');
		expect(image.questions.map((item) => item.description)).not.toContain(image.description);
		for (const [route, words] of [
			['docker', NOTICE_TEXT.stackCommands],
			['trial', NOTICE_TEXT.trialCommands],
		] as const) {
			const texts = screenOf({ route }, 'review').notices.map((notice) => notice.text);
			expect(texts, route).toContain(words);
			expect(texts, route).not.toContain(NOTICE_TEXT.hostCommands);
		}
		expect(
			screenOf({ route: 'production', instance: 'prado' }, 'review').notices.map(
				(notice) => notice.text,
			),
		).toContain(NOTICE_TEXT.hostCommands);
	});

	test('C3-48: the engine child is handed only the secrets the plan uses', () => {
		const keys = (raw: Record<string, unknown>) => engineSecretKeys(buildInstallPlan(raw).answers);
		expect(keys({ route: 'trial', entity: 'mus' })).toEqual(['root_password', 'db_password']);
		expect(
			keys({
				route: 'trial',
				entity: 'mus',
				diffusion: true,
				mysql_username: 'u',
				mailer: true,
				smtp_host: 'smtp.mus.org',
			}),
		).toEqual(['root_password', 'db_password', 'mysql_password', 'smtp_pass']);
		// A created production database is peer-only: no password exists to hand over.
		expect(keys({ route: 'production', instance: 'prado', entity: 'mus' })).toEqual([
			'root_password',
		]);
		expect(
			keys({ route: 'production', instance: 'prado', entity: 'mus', db_mode: 'existing' }),
		).toEqual(['root_password', 'db_password']);
	});

	test('C3-58 / 3b N13: the route cursor starts on the RECOMMENDED route — never an answer', () => {
		const route = questions({}).find((item) => item.id === 'route.route') as Question;
		// Production (index.md, production.md: the recommended route) — never the plan's
		// Developer fallback, which Enter on a sudo server run picked.
		expect(route.start).toBe('production');
		const start = route.options?.find((option) => option.value === route.start);
		expect(start?.label).toContain('recommended');
		expect(normalizeInstallAnswers({}).answers.route).toBe('developer');
		expect(route.value).toBeNull();
		expect(route.default).toBeNull();
	});
});
