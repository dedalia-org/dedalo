/**
 * THE INSTALLER'S PUBLIC HOST — black-box gate over the installer's answer
 * `public_host` / `public_protocol` / `public_host_keep_private` and the two
 * .env keys it decides (DEDALO_HOST, DEDALO_PROTOCOL). Written from the
 * CONTRACT, never from the implementation: every assertion is an OUTCOME — the
 * written .env bytes, the normalized answers, the plan's errors keyed
 * `public_host` / `public_protocol`, the plan file a resume replays.
 *
 * THE CONTRACT:
 *  - answers: `public_host` ('' not given | 'none' | host[:port], lowercased and
 *    trimmed), `public_protocol` ('https://' | 'http://', absent → 'https://',
 *    anything else a field error on 'public_protocol'), `public_host_keep_private`
 *    (bool, default false). All PLAIN (they ride the plan file);
 *  - CLI `--public-host`, `--public-protocol`, `--public-host-keep-private`; an
 *    answers file uses the answer key names;
 *  - developer and trial ASK it (default: the prior .env's DEDALO_HOST/PROTOCOL,
 *    else 'none'); the keep-private follow-up only for a well-formed host no
 *    outside machine reaches;
 *  - production and docker do NOT ask it: the host is DERIVED (server_name, plus
 *    `:port` when https_port is not 443; protocol https://), written even when
 *    unreachable; an explicit public_host that differs (compared canonically) or
 *    is 'none' refuses, as does a protocol other than https://; with no
 *    server_name (an engine child) a malformed / non-canonical host still refuses;
 *  - every refusal happens BEFORE any write: a malformed value (not a bare
 *    http(s) origin), a NON-CANONICAL one (not spelled as the engine's URL parser
 *    reads it — refused naming the canonical spelling, keep-private or not) or a
 *    private/unreachable one without keep-private → field
 *    error 'public_host' and NOTHING written (the private refusal names the
 *    shared identity the engine falls back to);
 *  - keep-private consent is about one host: re-answering the host voids it;
 *  - .env: a host writes DEDALO_HOST + DEDALO_PROTOCOL (the protocol only when it
 *    differs from the effective prior: the prior literal, else the engine default
 *    beside a prior host); 'none'/'' writes neither; an owned key is recognised
 *    whatever whitespace surrounds it;
 *    a prior DEDALO_HOST equal to the answer survives BYTE FOR BYTE, and with
 *    '' / 'none' the prior line survives untouched;
 *  - THE ENGINE RULE: the installer accepts exactly what the engine will use —
 *    an accepted public host ⇒ `identifiableOrigin(protocol + host) !== null`, a
 *    host refused as private ⇒ `=== null` (src/core/resolve/public_reach_rule.ts);
 *  - flags ≡ answers file ≡ the interactive plain prompter ≡ a --resume replay.
 *
 * DOORS DRIVEN: normalizeInstallAnswers / buildInstallPlan (the one plan),
 * answersFromCliArgs, answersFromAnswersFile, persistConfig (the real .env
 * writer, into a SCRATCH private dir via DEDALO_INSTALL_PRIVATE_DIR — the live
 * ../private/.env is never touched), runInteractiveInstall under the scripted
 * prompter, buildScreens (what each route asks), buildPlanFile +
 * writePlanFile/readPlanFile (the resume record). No database, no network.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnvFile } from '../../src/config/env.ts';
import { persistConfig } from '../../src/core/install/config_persist.ts';
import type { FrontEndResult } from '../../src/core/install/front_end.ts';
import {
	ANSWERS_FILE_SCHEMA,
	answersFromAnswersFile,
	answersFromCliArgs,
	buildInstallPlan,
	cliArgsOf,
	type InstallPlan,
	normalizeInstallAnswers,
	PLAIN_ANSWER_KEYS,
	SECRET_ANSWER_KEYS,
} from '../../src/core/install/install_plan.ts';
import { runInteractiveInstall } from '../../src/core/install/install_session.ts';
import {
	buildPlanFile,
	planHash,
	readPlanFile,
	writePlanFile,
} from '../../src/core/install/run_files_core.ts';
import {
	applyAnswer,
	buildScreens,
	type Question,
	reviewLines,
} from '../../src/core/install/screen_model.ts';
import { scriptedInstallPrompter } from '../../src/core/install/ui_plain/prompter.ts';
import {
	identifiableOrigin,
	isReachableFromOutside,
} from '../../src/core/resolve/public_reach_rule.ts';
import { getServerState, setServerState } from '../../src/core/resolve/server_state.ts';
import { BASE_ARGV, BASE_RECORD } from '../helpers/install_answer_cases.ts';
import { splitCase } from '../helpers/install_parity_cases.ts';
import {
	fakeProbes,
	GOOD_ROOT_PASSWORD,
	modelInput,
	scriptForPlan,
	thesaurusOffer,
} from '../helpers/install_plain_script.ts';
import { PINNED_IDENTITY, pinInstallerIdentity } from '../helpers/installer_identity.ts';

// The docker/trial image decisions follow the installer's release kind: pin a stable one.
pinInstallerIdentity(PINNED_IDENTITY.stable);

const scratchRoot = mkdtempSync(join(tmpdir(), 'dedalo_install_public_host_'));
afterAll(() => rmSync(scratchRoot, { recursive: true, force: true }));

let privateDir = '';
const priorStatus = getServerState().install_status;
beforeEach(() => {
	privateDir = mkdtempSync(join(scratchRoot, 'private_'));
	process.env.DEDALO_INSTALL_PRIVATE_DIR = privateDir;
});
afterEach(() => {
	delete process.env.DEDALO_INSTALL_PRIVATE_DIR;
	setServerState({ install_status: priorStatus, information: undefined, info_key: undefined });
});

// ── the host table ───────────────────────────────────────────────────────────

/** Well-formed and reachable from outside: accepted, written, used by the engine. */
const PUBLIC_HOSTS: readonly string[] = Object.freeze([
	'museum.example.org',
	'dedalo.museo-nacional.es',
	'collections.example.com:8443',
	'archive.example.net:8080',
	// A public IPv4 literal: a bare origin the engine identifies — so the installer accepts it.
	'1.1.1.1',
]);

/** Well-formed but no outside machine reaches it: refused unless kept private. */
const PRIVATE_HOSTS: readonly string[] = Object.freeze([
	'localhost',
	'localhost:3500',
	'127.0.0.1',
	'10.0.0.5',
	'192.168.1.20',
	'intranet-srv01',
	'museo.local',
	'dedalo.internal',
	'archive.lan',
	'dedalo.test',
]);

/** Not a bare http(s) origin at all: refused, whatever keep-private says. */
const MALFORMED_HOSTS: readonly { name: string; value: string }[] = Object.freeze([
	{ name: 'credentials', value: 'user:pw@museum.example.org' },
	{ name: 'path', value: 'museum.example.org/dedalo' },
	{ name: 'query', value: 'museum.example.org?x=1' },
	{ name: 'fragment', value: 'museum.example.org#top' },
	{ name: 'inner whitespace', value: 'museum example.org' },
	{ name: 'inner tab', value: 'museum\texample.org' },
	{ name: 'LF', value: 'museum.example.org\nDEDALO_BINARY_BASE=/tmp/evil' },
	{ name: 'CR/LF', value: 'museum.example.org\r\nX=1' },
	{ name: 'control char', value: 'muse\x01um.example.org' },
	{ name: 'NUL', value: 'museum.example.org\0' },
	{ name: 'DEL', value: 'museum\x7f.example.org' },
	{ name: 'non-ASCII', value: 'muséum.example.org' },
	{ name: '> 100 chars', value: `${'a'.repeat(60)}.${'b'.repeat(40)}.org` },
	{ name: 'port out of range', value: 'museum.example.org:99999' },
	{ name: 'port not numeric', value: 'museum.example.org:abc' },
	{ name: 'empty port', value: 'museum.example.org:' },
]);

/** Values that would break out of a .env line: refused, never written. */
const INJECTION_HOSTS: readonly string[] = Object.freeze([
	'museum.example.org\nDEDALO_HOST=evil.example.org',
	'museum"example.org',
	'museum.example.org"\nX="1',
	'museum.example.org$HOME',
	'$(id).example.org',
	'museum.example.org#DEDALO_X=1',
	'museum=example.org',
	'DEDALO_HOST=evil.example.org',
]);

// ── helpers ──────────────────────────────────────────────────────────────────

/** The developer-route record (BASE_RECORD: the shared parity base) plus `extra`. */
function devRecord(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { ...BASE_RECORD, route: 'developer', ...extra };
}

/** The refusals the plan tags with `key`. */
function fieldErrorsOf(plan: InstallPlan, key: string): string[] {
	return plan.fieldErrors.filter((item) => item.key === key).map((item) => item.message);
}

/** The .env path of THIS test's scratch private dir. */
function envPath(): string {
	return join(privateDir, '.env');
}

/** The written .env text (asserting it exists). */
function writtenEnv(): string {
	expect(existsSync(envPath()), 'the .env was written').toBe(true);
	return readFileSync(envPath(), 'utf8');
}

/** The lines of `body` that assign `key`. */
function linesOf(body: string, key: string): string[] {
	return body.split('\n').filter((line) => line.startsWith(`${key}=`));
}

/** The DEDALO_HOST / DEDALO_PROTOCOL lines — the bytes this answer owns. */
function publicLines(body: string): string[] {
	return [...linesOf(body, 'DEDALO_HOST'), ...linesOf(body, 'DEDALO_PROTOCOL')];
}

/** The plan's .env entry value for `key` (production/docker: the env the plan renders). */
function planEnvValue(plan: InstallPlan, key: string): string | undefined {
	return plan.env.flatMap((section) => section.entries).find((entry) => entry.key === key)?.value;
}

/** persistConfig must REFUSE `raw` and leave the private dir's .env as it was (absent or same bytes). */
async function expectRefusedWritingNothing(raw: Record<string, unknown>, label: string) {
	const before = existsSync(envPath()) ? readFileSync(envPath()) : null;
	let refused = false;
	try {
		await persistConfig(raw);
	} catch {
		refused = true;
	}
	expect(refused, `${label}: persistConfig refused`).toBe(true);
	if (before === null) {
		expect(existsSync(envPath()), `${label}: no .env written`).toBe(false);
	} else {
		expect(readFileSync(envPath()).equals(before), `${label}: the .env is untouched`).toBe(true);
	}
}

/** The three answer keys this gate is about, as normalized. */
function publicAnswers(answers: InstallPlan['answers']): Record<string, unknown> {
	const record = answers as unknown as Record<string, unknown>;
	return {
		public_host: record.public_host,
		public_protocol: record.public_protocol,
		public_host_keep_private: record.public_host_keep_private,
	};
}

/** The plain keys of a record (an answers file may not carry a secret). */
function plainOf(record: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(record).filter(
			([key]) => !(SECRET_ANSWER_KEYS as readonly string[]).includes(key),
		),
	);
}

function secretsOf(record: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(record).filter(([key]) =>
			(SECRET_ANSWER_KEYS as readonly string[]).includes(key),
		),
	);
}

/** Every question the screens over `raw` (and `priorEnv`) ask, flattened. */
function questionsOver(
	raw: Record<string, unknown>,
	priorEnv: Record<string, string> = {},
): Question[] {
	return buildScreens(modelInput(raw, { priorEnv })).flatMap((screen) => screen.questions);
}

/** How a scripted prompter answers the keep-private follow-up "yes". */
function keepPrivateYes(question: Question): string | boolean {
	if (question.kind === 'confirm') return true;
	const options = question.options ?? [];
	const keep = options.find((option) => /keep|yes|true|private/i.test(option.value));
	return keep?.value ?? 'yes';
}

/** Run the plain interactive install under a script; the result. */
async function runPlain(
	script: Parameters<typeof scriptedInstallPrompter>[0],
	priorEnv: Record<string, string> = {},
): Promise<{ result: FrontEndResult; asked: string[] }> {
	const prompter = scriptedInstallPrompter(script);
	const result = await runInteractiveInstall({
		prompter,
		probes: fakeProbes({ catalog: null }),
		priorEnv,
		thesauri: thesaurusOffer(),
		host: {},
		givenSecrets: {},
		unfinished: null,
	});
	return { result, asked: prompter.asked };
}

/** The raw answers (+ the answer secrets) a plain run handed back. */
function plainRaw(result: FrontEndResult): Record<string, unknown> {
	if (result.kind !== 'install') throw new Error(`plain run ended '${result.kind}', not install`);
	const { root_password: _root, ...answerSecrets } = result.secrets;
	return { ...result.raw, ...answerSecrets };
}

/** The developer base as argv (the CLI's way). */
const DEV_ARGV: readonly string[] = Object.freeze(['--route', 'developer', ...BASE_ARGV]);

/** The identity answers a docker/production route needs (no database fields). */
const IDENTITY_ARGV: readonly string[] = Object.freeze([
	'--entity',
	'parity',
	'--entity-label',
	'Parity Museum',
	'--timezone',
	'Europe/Madrid',
	'--locale',
	'es-ES',
	'--langs',
	'lg-spa,lg-eng',
	'--app-lang',
	'lg-spa',
	'--data-lang',
	'lg-eng',
]);

function productionRaw(extra: string[] = []): Record<string, unknown> {
	const parsed = answersFromCliArgs([
		'--route',
		'production',
		'--instance',
		'prado',
		'--server-name',
		'prado.example.org',
		'--letsencrypt-email',
		'ops@example.org',
		...IDENTITY_ARGV,
		...extra,
	]);
	expect(parsed.errors).toEqual([]);
	return parsed.raw;
}

function dockerRaw(extra: string[] = []): Record<string, unknown> {
	const parsed = answersFromCliArgs([
		'--route',
		'docker',
		'--server-name',
		'prado.example.org',
		'--letsencrypt-email',
		'ops@example.org',
		...IDENTITY_ARGV,
		'--image-source',
		'custom',
		'--image-repository',
		'registry.example.org/dedalo',
		...extra,
	]);
	expect(parsed.errors).toEqual([]);
	return parsed.raw;
}

// ── normalization ────────────────────────────────────────────────────────────

describe('public host — the answers', () => {
	test('defaults: public_host "" (not given), public_protocol https://, keep-private false', () => {
		const { answers, fieldErrors } = normalizeInstallAnswers(devRecord());
		expect(publicAnswers(answers)).toEqual({
			public_host: '',
			public_protocol: 'https://',
			public_host_keep_private: false,
		});
		expect(fieldErrors.filter((item) => item.key.startsWith('public_'))).toEqual([]);
	});

	test('public_host is trimmed and lowercased; http:// is kept', () => {
		const { answers } = normalizeInstallAnswers(
			devRecord({ public_host: '  Museum.Example.ORG:8443 ', public_protocol: 'http://' }),
		);
		expect(publicAnswers(answers)).toEqual({
			public_host: 'museum.example.org:8443',
			public_protocol: 'http://',
			public_host_keep_private: false,
		});
	});

	test("an unknown protocol is a field error on 'public_protocol' (and refuses before any write)", async () => {
		for (const protocol of ['ftp://', 'https', 'http:', 'https:///', 'javascript:']) {
			const plan = buildInstallPlan(
				devRecord({ public_host: 'museum.example.org', public_protocol: protocol }),
			);
			expect(fieldErrorsOf(plan, 'public_protocol').length, protocol).toBeGreaterThan(0);
			expect(plan.errors.length, protocol).toBeGreaterThan(0);
		}
		await expectRefusedWritingNothing(
			devRecord({ public_host: 'museum.example.org', public_protocol: 'ftp://' }),
			'ftp://',
		);
	});

	test('the three keys are PLAIN answers (they ride the plan file, never the secrets)', () => {
		for (const key of ['public_host', 'public_protocol', 'public_host_keep_private']) {
			expect(PLAIN_ANSWER_KEYS as readonly string[], key).toContain(key);
			expect(SECRET_ANSWER_KEYS as readonly string[], key).not.toContain(key);
		}
	});
});

// ── the host table: accepted ⇔ the engine uses it ───────────────────────────

describe('public host — the table, against the engine rule', () => {
	test('the table is not vacuous and is right in the ENGINE’s own terms', () => {
		expect(PUBLIC_HOSTS.length).toBeGreaterThanOrEqual(5);
		expect(PRIVATE_HOSTS.length).toBeGreaterThanOrEqual(10);
		for (const host of PUBLIC_HOSTS) {
			expect(isReachableFromOutside(host.split(':')[0] as string), host).toBe(true);
		}
		for (const host of PRIVATE_HOSTS) {
			expect(isReachableFromOutside(host.split(':')[0] as string), host).toBe(false);
		}
	});

	for (const host of PUBLIC_HOSTS) {
		for (const protocol of ['https://', 'http://']) {
			test(`accepted: ${protocol}${host} → written, and the engine identifies the written origin`, async () => {
				const raw = devRecord({ public_host: host, public_protocol: protocol });
				const plan = buildInstallPlan(raw);
				expect(fieldErrorsOf(plan, 'public_host')).toEqual([]);
				expect(plan.errors).toEqual([]);
				await persistConfig(raw);
				const env = parseEnvFile(writtenEnv());
				expect(env.DEDALO_HOST).toBe(host);
				expect(env.DEDALO_PROTOCOL).toBe(protocol);
				expect(identifiableOrigin(`${env.DEDALO_PROTOCOL}${env.DEDALO_HOST}`)).not.toBeNull();
			});
		}
	}

	for (const host of PRIVATE_HOSTS) {
		test(`private: ${host} without keep-private → refused on 'public_host' (shared identity), nothing written`, async () => {
			const raw = devRecord({ public_host: host });
			const plan = buildInstallPlan(raw);
			const errors = fieldErrorsOf(plan, 'public_host');
			expect(errors.length).toBeGreaterThan(0);
			expect(errors.join(' ')).toMatch(/shared/i);
			expect(errors.join(' ')).toMatch(/identit/i);
			// The engine agrees it would not use it.
			expect(identifiableOrigin(`https://${host}`)).toBeNull();
			await expectRefusedWritingNothing(raw, host);
		});

		test(`private: ${host} WITH keep-private → accepted and written; the engine still falls back`, async () => {
			const raw = devRecord({ public_host: host, public_host_keep_private: true });
			const plan = buildInstallPlan(raw);
			expect(fieldErrorsOf(plan, 'public_host')).toEqual([]);
			expect(plan.errors).toEqual([]);
			await persistConfig(raw);
			const env = parseEnvFile(writtenEnv());
			expect(env.DEDALO_HOST).toBe(host);
			expect(env.DEDALO_PROTOCOL).toBe('https://');
			expect(identifiableOrigin(`${env.DEDALO_PROTOCOL}${env.DEDALO_HOST}`)).toBeNull();
		});
	}

	for (const { name, value } of MALFORMED_HOSTS) {
		test(`malformed (${name}) → refused on 'public_host', even with keep-private; nothing written`, async () => {
			for (const keep of [false, true]) {
				const raw = devRecord({ public_host: value, public_host_keep_private: keep });
				const plan = buildInstallPlan(raw);
				expect(fieldErrorsOf(plan, 'public_host').length, `keep=${keep}`).toBeGreaterThan(0);
				await expectRefusedWritingNothing(raw, `${name} keep=${keep}`);
			}
		});
	}

	test('injection: no value carrying \\n " $ # = ever reaches the .env', async () => {
		writeFileSync(envPath(), 'DEDALO_SALT_STRING=deadbeef\n');
		const before = readFileSync(envPath());
		for (const value of INJECTION_HOSTS) {
			for (const keep of [false, true]) {
				const raw = devRecord({ public_host: value, public_host_keep_private: keep });
				expect(
					fieldErrorsOf(buildInstallPlan(raw), 'public_host').length,
					JSON.stringify(value),
				).toBeGreaterThan(0);
				await expectRefusedWritingNothing(raw, JSON.stringify(value));
			}
		}
		expect(readFileSync(envPath()).equals(before)).toBe(true);
		// And through the CLI's own parsing: refused the same.
		for (const value of INJECTION_HOSTS) {
			const parsed = answersFromCliArgs([...DEV_ARGV, '--public-host', value]);
			const plan = buildInstallPlan(parsed.raw);
			expect(
				parsed.errors.length + fieldErrorsOf(plan, 'public_host').length,
				JSON.stringify(value),
			).toBeGreaterThan(0);
		}
	});
});

// ── .env ownership: written, not written, preserved ─────────────────────────

describe('public host — what the .env keeps', () => {
	for (const answer of ['', 'none']) {
		test(`'${answer}' with no prior .env → neither DEDALO_HOST nor DEDALO_PROTOCOL written`, async () => {
			await persistConfig(devRecord({ public_host: answer }));
			const body = writtenEnv();
			expect(publicLines(body)).toEqual([]);
			const env = parseEnvFile(body);
			expect(env.DEDALO_HOST).toBeUndefined();
			expect(env.DEDALO_PROTOCOL).toBeUndefined();
		});

		test(`'${answer}' over a prior DEDALO_HOST → the prior lines survive byte for byte, once`, async () => {
			const hostLine = 'DEDALO_HOST="kept.example.org"';
			const protocolLine = 'DEDALO_PROTOCOL="http://"';
			writeFileSync(envPath(), `DEDALO_SALT_STRING=deadbeef\n${hostLine}\n${protocolLine}\n`);
			await persistConfig(devRecord({ public_host: answer }));
			const body = writtenEnv();
			expect(linesOf(body, 'DEDALO_HOST')).toEqual([hostLine]);
			expect(linesOf(body, 'DEDALO_PROTOCOL')).toEqual([protocolLine]);
		});
	}

	test('a prior DEDALO_HOST EQUAL to the answer survives byte for byte (not re-rendered)', async () => {
		// The quoted spelling is one the writer would not produce for this value — a
		// rewrite would show.
		const hostLine = 'DEDALO_HOST="museum.example.org"';
		writeFileSync(
			envPath(),
			`DEDALO_SALT_STRING=deadbeef\n${hostLine}\nDEDALO_PROTOCOL="https://"\n`,
		);
		await persistConfig(devRecord({ public_host: 'museum.example.org' }));
		const body = writtenEnv();
		expect(linesOf(body, 'DEDALO_HOST')).toEqual([hostLine]);
		const env = parseEnvFile(body);
		expect(env.DEDALO_HOST).toBe('museum.example.org');
		expect(env.DEDALO_PROTOCOL).toBe('https://');
		expect(linesOf(body, 'DEDALO_PROTOCOL').length).toBe(1);
	});

	test('a prior DEDALO_HOST DIFFERENT from the answer is replaced: one line, the new value', async () => {
		writeFileSync(
			envPath(),
			'DEDALO_SALT_STRING=deadbeef\nDEDALO_HOST="old.example.org"\nDEDALO_PROTOCOL="http://"\n',
		);
		await persistConfig(devRecord({ public_host: 'new.example.org' }));
		const body = writtenEnv();
		expect(linesOf(body, 'DEDALO_HOST').length).toBe(1);
		expect(linesOf(body, 'DEDALO_PROTOCOL').length).toBe(1);
		const env = parseEnvFile(body);
		expect(env.DEDALO_HOST).toBe('new.example.org');
		expect(env.DEDALO_PROTOCOL).toBe('https://');
		expect(body).not.toContain('old.example.org');
	});

	test('a refused answer over a prior .env leaves it byte for byte', async () => {
		writeFileSync(envPath(), 'DEDALO_SALT_STRING=deadbeef\nDEDALO_HOST="kept.example.org"\n');
		await expectRefusedWritingNothing(devRecord({ public_host: 'intranet-srv01' }), 'private');
		await expectRefusedWritingNothing(devRecord({ public_host: 'a/b' }), 'malformed');
	});
});

// ── routes: who asks, who derives ────────────────────────────────────────────

describe('public host — the routes', () => {
	test('developer and trial ASK it; production and docker do not', () => {
		for (const route of ['developer', 'trial']) {
			const asked = questionsOver({ route }).filter((q) => q.key === 'public_host');
			expect(asked.length, route).toBeGreaterThan(0);
		}
		const production = questionsOver({ route: 'production', instance: 'zzpub' });
		const docker = questionsOver({ route: 'docker' });
		for (const [route, questions] of [
			['production', production],
			['docker', docker],
		] as const) {
			expect(questions.length, `${route} screens are not empty`).toBeGreaterThan(5);
			expect(
				questions.filter((q) => q.key === 'public_host' || q.key === 'public_protocol'),
				route,
			).toEqual([]);
		}
	});

	test("the asked default is the prior .env's DEDALO_HOST/PROTOCOL, else 'none'", () => {
		for (const route of ['developer', 'trial']) {
			const bare = questionsOver({ route }).find((q) => q.key === 'public_host');
			expect(bare?.default, route).toBe('none');
			const prior = { DEDALO_HOST: 'museum.example.org', DEDALO_PROTOCOL: 'http://' };
			const withPrior = questionsOver({ route }, prior);
			expect(withPrior.find((q) => q.key === 'public_host')?.default, route).toBe(
				'museum.example.org',
			);
			// The protocol is asked beside a GIVEN host: the prior literal is its default.
			const beside = questionsOver({ route, public_host: 'museum.example.org' }, prior);
			const protocol = beside.find((q) => q.key === 'public_protocol');
			expect(protocol, `${route}: the protocol is asked beside a host`).toBeDefined();
			expect(protocol?.default, route).toBe('http://');
		}
	});

	test('the keep-private follow-up is offered only for a well-formed unreachable host', () => {
		const follow = (host: string) =>
			questionsOver({ route: 'developer', public_host: host }).filter(
				(q) => q.key === 'public_host_keep_private',
			);
		expect(follow('intranet-srv01').length).toBeGreaterThan(0);
		expect(follow('museo.local').length).toBeGreaterThan(0);
		// The follow-up offers BOTH ways out: keep it, or answer none.
		const options = follow('intranet-srv01').flatMap((q) => (q.options ?? []).map((o) => o.value));
		expect(options).toContain('keep');
		expect(options).toContain('none');
		expect(follow('museum.example.org')).toEqual([]);
		expect(follow('none')).toEqual([]);
		expect(follow('user:pw@museum.example.org')).toEqual([]);
	});

	test('production: derived from server_name (443 → bare host), protocol https://', () => {
		const plan = buildInstallPlan(productionRaw());
		expect(plan.errors).toEqual([]);
		expect(planEnvValue(plan, 'DEDALO_HOST')).toBe('prado.example.org');
		expect(planEnvValue(plan, 'DEDALO_PROTOCOL')).toBe('https://');
	});

	test('production: a non-443 https port joins the derived host', () => {
		const plan = buildInstallPlan(productionRaw(['--https-port', '8443']));
		expect(plan.errors).toEqual([]);
		expect(planEnvValue(plan, 'DEDALO_HOST')).toBe('prado.example.org:8443');
		expect(planEnvValue(plan, 'DEDALO_PROTOCOL')).toBe('https://');
		expect(identifiableOrigin('https://prado.example.org:8443')).not.toBeNull();
	});

	test('docker: derived from server_name the same way', () => {
		const plan = buildInstallPlan(dockerRaw());
		expect(plan.errors).toEqual([]);
		expect(planEnvValue(plan, 'DEDALO_HOST')).toBe('prado.example.org');
		expect(planEnvValue(plan, 'DEDALO_PROTOCOL')).toBe('https://');
		const ported = buildInstallPlan(dockerRaw(['--https-port', '9443']));
		expect(ported.errors).toEqual([]);
		expect(planEnvValue(ported, 'DEDALO_HOST')).toBe('prado.example.org:9443');
	});

	test('production: the derived host is written even when no outside machine reaches it', () => {
		const plan = buildInstallPlan(
			productionRaw(['--server-name', 'dedalo.museo.local', '--tls', 'local_ca']),
		);
		expect(plan.errors).toEqual([]);
		expect(fieldErrorsOf(plan, 'public_host')).toEqual([]);
		expect(planEnvValue(plan, 'DEDALO_HOST')).toBe('dedalo.museo.local');
		expect(identifiableOrigin('https://dedalo.museo.local')).toBeNull();
	});

	test("production/docker: an explicit public_host that DIFFERS (or 'none') refuses on 'public_host'; equal (any spelling) and '' do not", () => {
		for (const [route, of] of [
			['production', productionRaw],
			['docker', dockerRaw],
		] as const) {
			const differs = buildInstallPlan({ ...of(), public_host: 'other.example.org' });
			expect(fieldErrorsOf(differs, 'public_host').length, route).toBeGreaterThan(0);
			// 'none' is not an answer here: the site's own address IS the public one. Refused
			// loudly, naming why — never silently overridden by the derived host.
			const none = buildInstallPlan({ ...of(), public_host: 'none' });
			const noneErrors = fieldErrorsOf(none, 'public_host');
			expect(noneErrors.length, `${route} 'none'`).toBeGreaterThan(0);
			expect(noneErrors.join(' '), route).toMatch(/none is not an answer/);
			expect(noneErrors.join(' '), route).toContain('prado.example.org');
			// Equal is compared CANONICALLY: the default port spelled out names the same address.
			for (const same of ['prado.example.org', 'prado.example.org:443', '']) {
				const plan = buildInstallPlan({ ...of(), public_host: same });
				expect(fieldErrorsOf(plan, 'public_host'), `${route} '${same}'`).toEqual([]);
				expect(plan.errors, `${route} '${same}'`).toEqual([]);
			}
			const viaFlag = answersFromCliArgs([
				'--route',
				route,
				'--server-name',
				'prado.example.org',
				'--public-host',
				'other.example.org',
			]);
			expect(viaFlag.raw.public_host, route).toBe('other.example.org');
			expect(fieldErrorsOf(buildInstallPlan(viaFlag.raw), 'public_host').length).toBeGreaterThan(0);
		}
	});
});

// ── equivalence: flags ≡ answers file ≡ plain prompter ≡ resume ─────────────

interface Intent {
	name: string;
	argv: string[];
	record: Record<string, unknown>;
}

const INTENTS: readonly Intent[] = [
	{
		name: 'public host with port, http',
		argv: ['--public-host', 'collections.example.com:8443', '--public-protocol', 'http://'],
		record: { public_host: 'collections.example.com:8443', public_protocol: 'http://' },
	},
	{
		name: 'public host, protocol defaulted',
		argv: ['--public-host', 'museum.example.org'],
		record: { public_host: 'museum.example.org' },
	},
	{
		name: 'intranet host kept private',
		argv: ['--public-host', 'intranet-srv01', '--public-host-keep-private'],
		record: { public_host: 'intranet-srv01', public_host_keep_private: true },
	},
	{
		name: 'none',
		argv: ['--public-host', 'none'],
		record: { public_host: 'none' },
	},
];

/** persistConfig `raw` into a FRESH scratch private dir; the written body. */
async function persistFresh(raw: Record<string, unknown>): Promise<string> {
	privateDir = mkdtempSync(join(scratchRoot, 'private_'));
	process.env.DEDALO_INSTALL_PRIVATE_DIR = privateDir;
	setServerState({ install_status: priorStatus });
	await persistConfig(raw);
	return writtenEnv();
}

describe('public host — one intent, every front end', () => {
	for (const intent of INTENTS) {
		test(`${intent.name}: flags ≡ answers file ≡ plain prompter ≡ resume (answers and .env bytes)`, async () => {
			// FLAGS.
			const cli = answersFromCliArgs([...DEV_ARGV, ...intent.argv]);
			expect(cli.errors).toEqual([]);
			const flagsPlan = buildInstallPlan(cli.raw);
			expect(flagsPlan.errors).toEqual([]);
			const expected = publicAnswers(flagsPlan.answers);
			expect(expected.public_host).toBe(intent.record.public_host);

			// ANSWERS FILE (its key names = the answer keys; secrets apart).
			const record = devRecord(intent.record);
			const file = answersFromAnswersFile(
				JSON.parse(
					JSON.stringify({ schema: ANSWERS_FILE_SCHEMA, answers: plainOf(record) }),
				) as unknown,
			);
			expect(file.errors).toEqual([]);
			const fileRaw = { ...file.raw, ...secretsOf(record) };
			const filePlan = buildInstallPlan(fileRaw);
			expect(filePlan.errors).toEqual([]);
			expect(publicAnswers(filePlan.answers)).toEqual(expected);

			// PLAIN PROMPTER (scripted input at the questions the screen model asks).
			const { plain, secrets } = splitCase([...DEV_ARGV, ...intent.argv]);
			const script = scriptForPlan(flagsPlan, Object.keys(plain), {
				...secrets,
				root_password: GOOD_ROOT_PASSWORD,
			});
			const answers: Record<string, string | readonly string[] | boolean> = {
				...script.answers,
			};
			for (const question of questionsOver({
				route: 'developer',
				public_host: intent.record.public_host,
			})) {
				if (question.key === 'public_host')
					answers[question.id] = String(intent.record.public_host);
				if (question.key === 'public_protocol') {
					answers[question.id] = String(intent.record.public_protocol ?? 'https://');
				}
				if (question.key === 'public_host_keep_private' && intent.record.public_host_keep_private) {
					answers[question.id] = keepPrivateYes(question);
				}
			}
			const { result, asked } = await runPlain({ ...script, answers });
			expect(
				asked.some((id) =>
					questionsOver({ route: 'developer' }).some((q) => q.key === 'public_host' && q.id === id),
				),
				'the developer route asked the public host',
			).toBe(true);
			const promptedRaw = plainRaw(result);
			const promptedPlan = buildInstallPlan(promptedRaw);
			expect(promptedPlan.errors).toEqual([]);
			expect(publicAnswers(promptedPlan.answers)).toEqual(expected);

			// RESUME: the plan file holds the answers; a replay writes the same .env.
			const planFile = buildPlanFile(flagsPlan, { db_password: String(BASE_RECORD.db_password) });
			const runDir = mkdtempSync(join(scratchRoot, 'run_'));
			writePlanFile(planFile, runDir);
			const saved = readPlanFile(runDir);
			expect(saved).not.toBeNull();
			expect(planHash(saved as typeof planFile)).toBe(planFile.plan_hash);
			expect(publicAnswers(saved?.answers as InstallPlan['answers'])).toEqual(expected);
			const resumeRaw = {
				...(saved?.answers as Record<string, unknown>),
				db_password: BASE_RECORD.db_password,
			};

			// THE .env BYTES these keys own: identical across the four.
			const bodies = {
				flags: await persistFresh(cli.raw),
				file: await persistFresh(fileRaw),
				prompted: await persistFresh(promptedRaw),
				resume: await persistFresh(resumeRaw),
			};
			const lines = publicLines(bodies.flags);
			if (intent.record.public_host === 'none') {
				expect(lines).toEqual([]);
			} else {
				expect(linesOf(bodies.flags, 'DEDALO_HOST').length).toBe(1);
				expect(parseEnvFile(bodies.flags).DEDALO_HOST).toBe(String(intent.record.public_host));
				expect(parseEnvFile(bodies.flags).DEDALO_PROTOCOL).toBe(
					String(intent.record.public_protocol ?? 'https://'),
				);
			}
			expect(publicLines(bodies.file)).toEqual(lines);
			expect(publicLines(bodies.prompted)).toEqual(lines);
			expect(publicLines(bodies.resume)).toEqual(lines);
		});
	}

	test('plain prompter, no answer typed: the prior DEDALO_HOST/PROTOCOL is taken', async () => {
		const cli = answersFromCliArgs(DEV_ARGV);
		const flagsPlan = buildInstallPlan(cli.raw);
		const { plain, secrets } = splitCase(DEV_ARGV);
		const script = scriptForPlan(flagsPlan, Object.keys(plain), {
			...secrets,
			root_password: GOOD_ROOT_PASSWORD,
		});
		const prior = { DEDALO_HOST: 'museum.example.org', DEDALO_PROTOCOL: 'http://' };
		const { result } = await runPlain(script, prior);
		const answers = buildInstallPlan(plainRaw(result), { priorEnv: prior }).answers;
		expect(publicAnswers(answers)).toEqual({
			public_host: 'museum.example.org',
			public_protocol: 'http://',
			public_host_keep_private: false,
		});
		// …and no prior: 'none'.
		const bare = await runPlain(script);
		expect(publicAnswers(buildInstallPlan(plainRaw(bare.result)).answers).public_host).toBe('none');
	});

	test('plain prompter: a malformed or private (not kept) host never comes back as an install answer', async () => {
		const cli = answersFromCliArgs(DEV_ARGV);
		const flagsPlan = buildInstallPlan(cli.raw);
		const { plain, secrets } = splitCase(DEV_ARGV);
		const base = scriptForPlan(flagsPlan, Object.keys(plain), {
			...secrets,
			root_password: GOOD_ROOT_PASSWORD,
		});
		const hostQuestions = questionsOver({ route: 'developer' }).filter(
			(q) => q.key === 'public_host',
		);
		expect(hostQuestions.length).toBeGreaterThan(0);
		// The exact outcome of each: a malformed host is re-asked until the script gives up
		// (no install); a private one whose follow-up is answered 'none' installs with none.
		const OUTCOMES: readonly {
			value: string;
			kind: FrontEndResult['kind'];
			host: string | null;
		}[] = [
			{ value: 'user:pw@museum.example.org', kind: 'quit', host: null },
			{ value: 'intranet-srv01', kind: 'install', host: 'none' },
			{ value: 'museum.example.org$X', kind: 'quit', host: null },
		];
		for (const { value, kind, host } of OUTCOMES) {
			const answers: Record<string, string | readonly string[] | boolean> = { ...base.answers };
			for (const question of hostQuestions) answers[question.id] = value;
			// The keep-private follow-up, if offered, is answered "none".
			for (const question of questionsOver({ route: 'developer', public_host: value })) {
				if (question.key === 'public_host_keep_private') {
					answers[question.id] = question.kind === 'confirm' ? false : 'none';
				}
			}
			const { result } = await runPlain({ ...base, answers });
			const handedBack =
				result.kind === 'install'
					? publicAnswers(buildInstallPlan(plainRaw(result)).answers).public_host
					: null;
			expect(result.kind, JSON.stringify(value)).toBe(kind);
			expect(handedBack, JSON.stringify(value)).toBe(host);
		}
	});
});

// ── the reviewed defects: one gate each ──────────────────────────────────────

/** The canonical spelling each non-canonical host must be refused naming. */
const NON_CANONICAL_HOSTS: readonly { value: string; protocol: string; canonical: string }[] =
	Object.freeze([
		{ value: '134744072', protocol: 'https://', canonical: '8.8.8.8' },
		{ value: '1.2.3', protocol: 'https://', canonical: '1.2.0.3' },
		{ value: '[::ffff:8.8.8.8]', protocol: 'https://', canonical: '[::ffff:808:808]' },
		{ value: 'example.org:0443', protocol: 'https://', canonical: 'example.org' },
		{ value: 'example.org:443', protocol: 'https://', canonical: 'example.org' },
		{ value: 'example.org:80', protocol: 'http://', canonical: 'example.org' },
		{ value: 'example.org:080', protocol: 'https://', canonical: 'example.org:80' },
		{ value: 'example.org.', protocol: 'https://', canonical: 'example.org' },
		// Loopback in disguise — refused even WITH keep-private (the keep is for a
		// canonical host, never a spelling the engine reads differently).
		{ value: '127.1', protocol: 'https://', canonical: '127.0.0.1' },
		{ value: '2130706433', protocol: 'https://', canonical: '127.0.0.1' },
		{ value: '0x7f.1', protocol: 'https://', canonical: '127.0.0.1' },
	]);

/** Every line of `body` assigning `key`, whatever whitespace surrounds the key. */
function assignmentsOf(body: string, key: string): string[] {
	return body.split('\n').filter((line) => new RegExp(`^\\s*${key}\\s*=`).test(line));
}

describe('public host — reviewed defects', () => {
	test('non-canonical: refused on public_host (keep or not) naming the canonical spelling; nothing written', async () => {
		expect(NON_CANONICAL_HOSTS.length).toBeGreaterThanOrEqual(11);
		for (const { value, protocol, canonical } of NON_CANONICAL_HOSTS) {
			for (const keep of [false, true]) {
				const raw = devRecord({
					public_host: value,
					public_protocol: protocol,
					public_host_keep_private: keep,
				});
				const errors = fieldErrorsOf(buildInstallPlan(raw), 'public_host');
				expect(errors.length, `${value} keep=${keep}`).toBeGreaterThan(0);
				expect(errors.join(' '), value).toContain(JSON.stringify(canonical));
				await expectRefusedWritingNothing(raw, `${value} keep=${keep}`);
			}
			// …and the canonical spelling it names IS what the engine would read.
			expect(new URL(`${protocol}${value}`).host.replace(/\.$/, ''), value).toBe(canonical);
		}
		// A canonical public literal is still accepted; canonical localhost with keep too.
		expect(
			fieldErrorsOf(buildInstallPlan(devRecord({ public_host: '1.1.1.1' })), 'public_host'),
		).toEqual([]);
		expect(
			fieldErrorsOf(
				buildInstallPlan(devRecord({ public_host: 'localhost', public_host_keep_private: true })),
				'public_host',
			),
		).toEqual([]);
	});

	test('production: a derived https_port spelled 0443 is the default port — no port in DEDALO_HOST', () => {
		const plan = buildInstallPlan(productionRaw(['--https-port', '0443']));
		expect(fieldErrorsOf(plan, 'public_host')).toEqual([]);
		expect(planEnvValue(plan, 'DEDALO_HOST')).toBe('prado.example.org');
	});

	test("production/docker: public_protocol other than https:// is a field error on 'public_protocol'; https:// is not", () => {
		for (const [route, of] of [
			['production', productionRaw],
			['docker', dockerRaw],
		] as const) {
			const http = buildInstallPlan({ ...of(), public_protocol: 'http://' });
			expect(fieldErrorsOf(http, 'public_protocol').length, route).toBeGreaterThan(0);
			const https = buildInstallPlan({ ...of(), public_protocol: 'https://' });
			expect(fieldErrorsOf(https, 'public_protocol'), route).toEqual([]);
			expect(https.errors, route).toEqual([]);
		}
	});

	test('production (engine child, no server_name): a malformed public_host still refuses; nothing written', async () => {
		for (const value of ['a/b@c', 'evil\\']) {
			const parsed = answersFromCliArgs([
				'--route',
				'production',
				'--engine-only',
				'--public-host',
				value,
			]);
			const errors =
				parsed.errors.length + fieldErrorsOf(buildInstallPlan(parsed.raw), 'public_host').length;
			expect(errors, JSON.stringify(value)).toBeGreaterThan(0);
			await expectRefusedWritingNothing(parsed.raw, JSON.stringify(value));
		}
	});

	test('the plan file of a derived route carries no --public-host/--public-protocol and round-trips', () => {
		for (const [route, of] of [
			['production', productionRaw],
			['docker', dockerRaw],
		] as const) {
			const plan = buildInstallPlan(of(['--https-port', '8443']));
			expect(plan.errors, route).toEqual([]);
			const argv = cliArgsOf(plan.answers);
			expect(argv, route).not.toContain('--public-host');
			expect(argv, route).not.toContain('--public-protocol');
			const again = answersFromCliArgs(argv);
			expect(again.errors, route).toEqual([]);
			const replayed = buildInstallPlan(again.raw);
			expect(fieldErrorsOf(replayed, 'public_host'), route).toEqual([]);
			expect(fieldErrorsOf(replayed, 'public_protocol'), route).toEqual([]);
			expect(planEnvValue(replayed, 'DEDALO_HOST'), route).toBe('prado.example.org:8443');
			expect(planEnvValue(replayed, 'DEDALO_PROTOCOL'), route).toBe('https://');
		}
	});

	test('keep-private consent is about ONE host: re-answering the host voids it and re-asks', () => {
		const ask = (raw: Record<string, unknown>, key: string) =>
			questionsOver(raw).find((q) => q.key === key);
		let raw: Record<string, unknown> = { route: 'developer' };
		const host = ask(raw, 'public_host') as Question;
		raw = applyAnswer(raw, host, 'intranet-a');
		const keep = ask(raw, 'public_host_keep_private');
		expect(keep, 'the follow-up is asked for intranet-a').toBeDefined();
		raw = applyAnswer(raw, keep as Question, 'keep');
		expect(raw.public_host_keep_private).toBe(true);
		expect(fieldErrorsOf(buildInstallPlan(devRecord(raw)), 'public_host')).toEqual([]);
		// The user goes back and types another unreachable host.
		raw = applyAnswer(raw, ask(raw, 'public_host') as Question, '10.0.0.9');
		expect(raw.public_host).toBe('10.0.0.9');
		expect(raw.public_host_keep_private).toBeUndefined();
		expect(ask(raw, 'public_host_keep_private'), 'asked again').toBeDefined();
		expect(fieldErrorsOf(buildInstallPlan(devRecord(raw)), 'public_host').length).toBeGreaterThan(
			0,
		);
	});

	test("prior DEDALO_HOST without DEDALO_PROTOCOL: the default protocol is the engine's (http://) and accepting it writes no protocol line", async () => {
		const prior = { DEDALO_HOST: 'museum.example.org' };
		const protocol = questionsOver(
			{ route: 'developer', public_host: 'museum.example.org' },
			prior,
		).find((q) => q.key === 'public_protocol');
		expect(protocol?.default).toBe('http://');
		const priorBody = 'DEDALO_SALT_STRING=deadbeef\nDEDALO_HOST=museum.example.org\n';
		writeFileSync(envPath(), priorBody);
		await persistConfig(
			devRecord({ public_host: 'museum.example.org', public_protocol: 'http://' }),
		);
		const kept = writtenEnv();
		expect(assignmentsOf(kept, 'DEDALO_PROTOCOL'), 'no flip: no protocol line').toEqual([]);
		expect(assignmentsOf(kept, 'DEDALO_HOST')).toEqual(['DEDALO_HOST=museum.example.org']);
		// Choosing https:// over it IS a change: written.
		writeFileSync(envPath(), priorBody);
		await persistConfig(
			devRecord({ public_host: 'museum.example.org', public_protocol: 'https://' }),
		);
		expect(parseEnvFile(writtenEnv()).DEDALO_PROTOCOL).toBe('https://');
	});

	test('a prior line whose KEY carries whitespace is still the owned key: replaced, never duplicated', async () => {
		await persistConfig(devRecord({ public_host: 'new.example.org' }));
		const fresh = parseEnvFile(writtenEnv());
		const owned = Object.keys(fresh);
		expect(owned).toContain('DEDALO_HOST');
		expect(owned.length).toBeGreaterThan(5);
		// Every owned key re-spelled with whitespace around it (values kept valid — the
		// writer keeps some prior values); DEDALO_HOST carries a stale one.
		const spaced = owned.map((key) =>
			key === 'DEDALO_HOST'
				? ' DEDALO_HOST =old.example.org'
				: ` ${key} =${JSON.stringify(fresh[key])}`,
		);
		writeFileSync(envPath(), `${spaced.join('\n')}\n`);
		await persistConfig(devRecord({ public_host: 'new.example.org' }));
		const body = writtenEnv();
		for (const key of owned) expect(assignmentsOf(body, key).length, key).toBe(1);
		expect(parseEnvFile(body).DEDALO_HOST).toBe('new.example.org');
		expect(body).not.toContain('old.example.org');
	});

	test('the Review names the public address outcome in plain words', () => {
		const lineOf = (raw: Record<string, unknown>, priorEnv: Record<string, string> = {}) => {
			const plan = buildInstallPlan(devRecord(raw), { priorEnv });
			return reviewLines(plan, modelInput(devRecord(raw), { priorEnv })).find(
				(line) => line.label === 'public address',
			)?.value;
		};
		expect(lineOf({ public_host: 'museum.example.org' })).toBe(
			'https://museum.example.org (contact identity)',
		);
		expect(lineOf({ public_host: 'intranet-srv01', public_host_keep_private: true })).toBe(
			'https://intranet-srv01 — kept, shared identity (not reachable from outside)',
		);
		expect(lineOf({ public_host: 'none' })).toBe('none — shared identity');
		expect(lineOf({ public_host: 'none' }, { DEDALO_HOST: 'kept.example.org' })).toBe(
			'kept from existing .env',
		);
	});
});
