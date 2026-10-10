/**
 * install.sh must RUN on every host its guide sends people to — not just on a
 * GNU/Linux box with Docker's root directory on the local filesystem.
 *
 * THE DEFECT (2026-07-27 → 2026-10-08). The disk pre-flight read
 * `df -BG --output=avail "$docker_root"` inside a `$(…)` assignment under
 * `set -euo pipefail`. Where that df fails — BSD df on macOS, or a DockerRootDir
 * that lives inside a VM (Docker Desktop on macOS and WSL, a remote DOCKER_HOST) —
 * the failed assignment exited the whole script with code 64, silently, right
 * after the banner. The quickstart tells macOS users to run exactly this script.
 *
 * WHAT THIS GATE DOES: it lifts the real `docker_free_gib` function out of
 * install.sh and runs it under the script's own shell options, against a path that
 * does not exist (the VM case) and one that does. It is a behaviour gate, not a
 * text match — plus one ratchet on the GNU-only df flags that caused it.
 *
 * THE ANSWERS REACH THE SHARED PLAN (2026-10-08, installer unification A1/A3/A7).
 * install.sh's headless questions are turned into installer flags by one block.
 * The gate lifts that block and the `confirm_yes` helper out of the script, runs
 * them under `set -euo pipefail` with the operator's answers, and feeds the argv
 * they produce through the installer's own parser (`answersFromCliArgs` +
 * `buildInstallPlan`, src/core/install/install_plan.ts): "default" must reach the
 * shared default (no flag), "none" must reach an empty thesaurus list, and
 * declining the update server must reach an air-gapped plan — with no parse error.
 *
 * THE ONTOLOGIES (2026-10-09, A4). The Ontologies answer joins the same block:
 * "default" passes no flag and reaches the shared default (oh, vendored — no
 * catalog to resolve, air-gapped or not); an explicit list reaches `--ontologies`
 * and, against a stand-in server catalog, a plan whose ACTIVE_ONTOLOGY_TLDS carries
 * it. The question's own loop is lifted and driven too: an air-gapped install is
 * asked again until it names only the built-in ontology, so the installer never
 * receives a choice it must refuse.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	answersFromCliArgs,
	buildInstallPlan,
	normalizeInstallAnswers,
	OFFICIAL_ONTOLOGY_SERVER,
	ontologySourceFor,
	TOPONYMY_SUGGESTION,
} from '../../src/core/install/install_plan.ts';
import {
	DEFAULT_DOMAIN_ONTOLOGIES,
	mergeOntologyCatalogs,
	type OntologyCatalog,
	ontologyCatalogNeeded,
	vendoredOntologyCatalog,
} from '../../src/core/install/ontology_choice.ts';
import { CORE_ONTOLOGY_TLDS } from '../../src/core/ontology/core_tlds.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const INSTALL_SH = readFileSync(join(REPO_ROOT, 'install.sh'), 'utf8');

/** The `docker_free_gib` function, verbatim from install.sh. */
function probeFunction(): string {
	const match = INSTALL_SH.match(/^docker_free_gib\(\) \{\n[\s\S]*?\n\}$/m);
	expect(
		match,
		'install.sh: no `docker_free_gib() { … }` function — the disk probe moved or was inlined',
	).not.toBeNull();
	return (match as RegExpMatchArray)[0];
}

/** Run `free_gib="$(docker_free_gib <path>)"` exactly as install.sh does. */
function runProbe(path: string): { exitCode: number; stdout: string } {
	const script = `set -euo pipefail\n${probeFunction()}\nfree_gib="$(docker_free_gib "$1")"\necho "survived:[$free_gib]"`;
	const run = Bun.spawnSync(['bash', '-c', script, 'probe', path]);
	return { exitCode: run.exitCode ?? -1, stdout: new TextDecoder().decode(run.stdout).trim() };
}

describe('install.sh disk pre-flight is portable and never fatal', () => {
	test('a Docker root that is not on this filesystem skips the check instead of killing the script', () => {
		const result = runProbe('/nonexistent/dedalo/docker-root-in-a-vm');
		expect(result.exitCode, 'the probe killed the script under set -euo pipefail').toBe(0);
		expect(result.stdout).toBe('survived:[]');
	});

	test('a real path yields a whole number of GiB', () => {
		const result = runProbe(REPO_ROOT);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toMatch(/^survived:\[\d+\]$/);
	});

	test('install.sh uses the probe, and no GNU-only df flags anywhere', () => {
		expect(INSTALL_SH).toMatch(/^free_gib="\$\(docker_free_gib "\$docker_root"\)"$/m);
		for (const [index, line] of INSTALL_SH.split('\n').entries()) {
			if (/^\s*#/.test(line)) continue;
			expect(
				/\bdf\b[^\n|]*(-B|--output|--block-size)/.test(line),
				`install.sh:${index + 1} uses a GNU-only df flag — BSD df (macOS) rejects it: ${line.trim()}`,
			).toBe(false);
		}
	});
});

/** A top-level `name() { … }` function, verbatim from install.sh. */
function liftFunction(name: string): string {
	const match = INSTALL_SH.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}$`, 'm'));
	expect(match, `install.sh: no \`${name}() { … }\` function`).not.toBeNull();
	return (match as RegExpMatchArray)[0];
}

/** The block that turns the answers into installer flags, verbatim. */
function argsBlock(): string {
	const match = INSTALL_SH.match(
		/^install_args=\($[\s\S]*?^if \[ "\$USE_UPDATE_SERVERS" = 'false' \]; then install_args\+=\(--no-update-servers\); fi$/m,
	);
	expect(
		match,
		'install.sh: the install_args block (ending with the --no-update-servers append) moved',
	).not.toBeNull();
	return (match as RegExpMatchArray)[0];
}

interface Answers {
	LANGS: string;
	HIERARCHIES: string;
	USE_UPDATE_SERVERS: 'true' | 'false';
	ONTOLOGIES: string;
}

/** Run the lifted block with these answers; return the argv it builds (NUL-separated, exact). */
function buildArgs(answers: Answers): string[] {
	const script = [
		'set -euo pipefail',
		'DB_PASSWORD=pw ENTITY=museo ENTITY_LABEL=Museo LOCALE=es-ES TIMEZONE=Europe/Madrid',
		`LANGS="$1" HIERARCHIES="$2" USE_UPDATE_SERVERS="$3" ONTOLOGIES="$4"`,
		'APP_LANG="${LANGS%%,*}"',
		argsBlock(),
		`printf '%s\\0' "\${install_args[@]}"`,
	].join('\n');
	const run = Bun.spawnSync([
		'bash',
		'-c',
		script,
		'args',
		answers.LANGS,
		answers.HIERARCHIES,
		answers.USE_UPDATE_SERVERS,
		answers.ONTOLOGIES,
	]);
	expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
	const argv = new TextDecoder().decode(run.stdout).split('\0').slice(0, -1);
	// Corpus floor: the fixed flags (password, entity, label, locale, timezone…)
	// always arrive, so an empty argv means the lifted block ran blind.
	expect(argv.length, 'the lifted install_args block emitted no flags').toBeGreaterThan(5);
	return argv;
}

/** `confirm_yes` / `confirm` under the script's shell options, with `reply` typed. */
function ask(helper: 'confirm' | 'confirm_yes', reply: string): number {
	const script = `set -euo pipefail\n${liftFunction(helper)}\nif ${helper} 'Question?'; then exit 0; else exit 1; fi`;
	const run = Bun.spawnSync(['bash', '-c', script], {
		stdin: new TextEncoder().encode(`${reply}\n`),
	});
	return run.exitCode ?? -1;
}

describe('install.sh answers reach the shared install plan', () => {
	test('confirm_yes: Enter and yes accept, only n/no decline (any case); confirm keeps No as default', () => {
		for (const reply of ['', 'y', 'Y', 'yes', 'YES'])
			expect(ask('confirm_yes', reply), `confirm_yes '${reply}'`).toBe(0);
		for (const reply of ['n', 'N', 'no', 'No'])
			expect(ask('confirm_yes', reply), `confirm_yes '${reply}'`).toBe(1);
		expect(ask('confirm', '')).toBe(1);
		expect(ask('confirm', 'Yes')).toBe(0);
	});

	test('all defaults: no language or thesaurus flag, official update servers, NO default thesaurus (a toponymy suggestion instead)', () => {
		const argv = buildArgs({
			LANGS: 'default',
			HIERARCHIES: 'default',
			USE_UPDATE_SERVERS: 'true',
			ONTOLOGIES: 'default',
		});
		for (const flag of [
			'--langs',
			'--app-lang',
			'--data-lang',
			'--hierarchies',
			'--ontologies',
			'--no-update-servers',
		]) {
			expect(argv, `${flag} must be omitted for the default`).not.toContain(flag);
		}
		const invocation = answersFromCliArgs(argv);
		const plan = buildInstallPlan(invocation.raw);
		expect([...invocation.errors, ...plan.errors]).toEqual([]);
		expect(plan.answers.update_servers).toBe('official');
		// 2026-10-10: the default selects nothing beyond the declared dependencies
		// (the vendored oh declares none) — and no toponymy is ever pre-selected:
		// the plan SUGGESTS one instead.
		expect(plan.hierarchies).toHaveLength(0);
		expect([...plan.suggestions]).toEqual([TOPONYMY_SUGGESTION]);
		expect(plan.answers.langs).toBeUndefined();
		// the shared ontology default (oh, vendored): nothing to fetch, ACTIVE = core + it
		expect([...plan.ontologies]).toEqual([...DEFAULT_DOMAIN_ONTOLOGIES]);
		expect(plan.ontologyRequest?.items.map((item) => item.tld)).toEqual([
			...DEFAULT_DOMAIN_ONTOLOGIES,
		]);
		expect([...plan.activeOntologyTlds]).toEqual([
			...CORE_ONTOLOGY_TLDS,
			...DEFAULT_DOMAIN_ONTOLOGIES,
		]);
		const servers = plan.env
			.flatMap((section) => section.entries)
			.find((entry) => entry.key === 'ONTOLOGY_SERVERS');
		expect(servers && JSON.parse(servers.value)).toEqual([OFFICIAL_ONTOLOGY_SERVER]);
	});

	test('explicit answers: languages, "none" thesauri and the air-gapped opt-out all arrive', () => {
		const argv = buildArgs({
			LANGS: 'lg-spa,lg-eng',
			HIERARCHIES: 'none',
			USE_UPDATE_SERVERS: 'false',
			ONTOLOGIES: 'default',
		});
		const invocation = answersFromCliArgs(argv);
		const plan = buildInstallPlan(invocation.raw);
		expect([...invocation.errors, ...plan.errors]).toEqual([]);
		// air-gapped + the default ontology: the vendored oh, no catalog needed
		expect(plan.ontologySource).toEqual({ kind: 'none' });
		expect(plan.ontologyRequest?.items.map((item) => item.tld)).toEqual([
			...DEFAULT_DOMAIN_ONTOLOGIES,
		]);
		expect([...plan.hierarchies]).toEqual([]);
		expect(plan.answers.update_servers).toBe('none');
		expect(plan.answers.langs).toEqual(['lg-spa', 'lg-eng']);
		expect(plan.answers.app_lang_default).toBe('lg-spa');
		const entries = plan.env.flatMap((section) => section.entries);
		for (const key of ['ONTOLOGY_SERVERS', 'CODE_SERVERS']) {
			expect(entries.find((entry) => entry.key === key)?.value, key).toBe('[]');
		}
	});

	// `ask VAR …` OVERWRITES VAR with its literal default on Enter, so a second
	// prompt for the same answer silently discards the first one (a duplicated
	// `ask LOCALE` after the Updates block, 2026-10-08, turned `fr-FR` back into
	// es-ES). No question may be asked twice.
	test('no answer is asked twice (a repeat prompt would overwrite the first answer)', () => {
		const asked = new Map<string, number[]>();
		for (const [index, line] of INSTALL_SH.split('\n').entries()) {
			const match = line.match(/^\s*ask(?:_secret)?\s+([A-Z_][A-Z0-9_]*)\s/);
			const name = match?.[1];
			if (name !== undefined) asked.set(name, [...(asked.get(name) ?? []), index + 1]);
		}
		// Corpus floor: the terminal questions exist, so an empty map means the scan ran blind.
		expect(asked.has('LOCALE') && asked.has('ROOT_PASSWORD'), 'no ask lines found').toBe(true);
		const repeated = [...asked].filter(([, lines]) => lines.length > 1);
		expect(repeated, 'install.sh asks these answers more than once (lines)').toEqual([]);
	});

	test('an explicit thesaurus list is passed through', () => {
		const argv = buildArgs({
			LANGS: 'default',
			HIERARCHIES: 'es',
			USE_UPDATE_SERVERS: 'true',
			ONTOLOGIES: 'default',
		});
		expect(argv.slice(argv.indexOf('--hierarchies'), argv.indexOf('--hierarchies') + 2)).toEqual([
			'--hierarchies',
			'es',
		]);
		const plan = buildInstallPlan(answersFromCliArgs(argv).raw);
		expect(plan.errors).toEqual([]);
		expect([...plan.hierarchies]).toEqual(['es']);
	});
});

/**
 * A stand-in SERVER catalog entry (no network: the plan is handed the catalog a
 * front end would have resolved). `zzsh` is a generic test TLD, never a real
 * domain ontology; it declares only core dependencies.
 */
function standInServerCatalog(tld: string): OntologyCatalog {
	return {
		source: { kind: 'server', server: { ...OFFICIAL_ONTOLOGY_SERVER } },
		entries: [
			{
				tld,
				name: `Stand-in | ${tld}`,
				name_data: null,
				typology_id: null,
				typology_name: null,
				dependencies: [
					{ tld: CORE_ONTOLOGY_TLDS[0] as string, main: 'ontology35', mandatory: true },
				],
				origin: 'server',
				file: `https://stand-in.invalid/${tld}.copy.gz`,
			},
		],
		matrixDd: null,
		warnings: [],
	};
}

/** The Ontologies question loop, verbatim from install.sh. */
function ontologiesLoop(): string {
	const match = INSTALL_SH.match(/^while true; do\n\task ONTOLOGIES [\s\S]*?\n^done$/m);
	expect(match, 'install.sh: the `while true; do ask ONTOLOGIES … done` loop moved').not.toBeNull();
	return (match as RegExpMatchArray)[0];
}

/** Run the lifted loop with these typed replies; return the accepted answer + the times asked. */
function askOntologies(
	useUpdateServers: 'true' | 'false',
	replies: string[],
): { answer: string; warnings: number } {
	const script = [
		'set -euo pipefail',
		liftFunction('ask'),
		`warn() { printf 'W:%s\\n' "$*" >&2; }`,
		`USE_UPDATE_SERVERS="$1"`,
		ontologiesLoop(),
		`printf '%s' "$ONTOLOGIES"`,
	].join('\n');
	const run = Bun.spawnSync(['bash', '-c', script, 'ontologies', useUpdateServers], {
		stdin: new TextEncoder().encode(replies.map((reply) => `${reply}\n`).join('')),
	});
	const stderr = new TextDecoder().decode(run.stderr);
	expect(run.exitCode, stderr).toBe(0);
	return {
		answer: new TextDecoder().decode(run.stdout),
		warnings: stderr.split('\n').filter((line) => line.startsWith('W:')).length,
	};
}

describe('install.sh ontologies question reaches the shared install plan', () => {
	test('an explicit list is passed as --ontologies and parsed without error', () => {
		const tld = 'zzsh';
		const argv = buildArgs({
			LANGS: 'default',
			HIERARCHIES: 'default',
			USE_UPDATE_SERVERS: 'true',
			ONTOLOGIES: `oh,${tld}`,
		});
		const at = argv.indexOf('--ontologies');
		expect(argv.slice(at, at + 2)).toEqual(['--ontologies', `oh,${tld}`]);
		const invocation = answersFromCliArgs(argv);
		expect(invocation.errors).toEqual([]);
		const normalized = normalizeInstallAnswers(invocation.raw);
		expect(normalized.errors).toEqual([]);
		expect(normalized.answers.ontologies).toEqual(['oh', tld]);
		// a non-vendored TLD needs the configured server's catalog …
		const source = ontologySourceFor(normalized.answers, {});
		expect(source.kind).toBe('server');
		expect(ontologyCatalogNeeded(normalized.answers.ontologies, source)).toBe(true);
		// … and, handed one, the plan installs it after oh and writes it into ACTIVE
		const plan = buildInstallPlan(invocation.raw, {
			ontologyCatalog: mergeOntologyCatalogs(standInServerCatalog(tld), vendoredOntologyCatalog()),
		});
		expect(plan.errors).toEqual([]);
		expect(plan.ontologyRequest?.items.map((item) => item.tld)).toEqual(['oh', tld]);
		expect([...plan.activeOntologyTlds]).toEqual([...CORE_ONTOLOGY_TLDS, 'oh', tld]);
	});

	test('with the update server, the first answer is taken as typed', () => {
		expect(askOntologies('true', ['oh,tch'])).toEqual({ answer: 'oh,tch', warnings: 0 });
		expect(askOntologies('true', [''])).toEqual({ answer: 'default', warnings: 0 });
	});

	test('air-gapped: a non-built-in answer is asked again until only the built-in one is named', () => {
		const result = askOntologies('false', ['tch', 'oh,tch', 'oh']);
		expect(result.answer).toBe('oh');
		expect(result.warnings, 'one warning pair per refused answer').toBe(4);
		expect(askOntologies('false', [''])).toEqual({ answer: 'default', warnings: 0 });
		// what the loop lets through is a plan the installer accepts air-gapped
		for (const answer of ['default', 'oh']) {
			const argv = buildArgs({
				LANGS: 'default',
				HIERARCHIES: 'default',
				USE_UPDATE_SERVERS: 'false',
				ONTOLOGIES: answer,
			});
			const plan = buildInstallPlan(answersFromCliArgs(argv).raw);
			expect(plan.errors, answer).toEqual([]);
			expect(
				plan.ontologyRequest?.items.map((item) => item.tld),
				answer,
			).toEqual(['oh']);
		}
	});
});
