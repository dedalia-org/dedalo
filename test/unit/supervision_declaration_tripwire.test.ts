/**
 * TRIPWIRE — supervision is DECLARED by every runtime definition that restarts the
 * server, and by nothing else (installer unification C, 2026-10-08).
 *
 * A code update swaps the installation tree and EXITS; only a process that something
 * restarts may do that. The engine therefore reads ONE fact — `DEDALO_SUPERVISED=true`
 * in the PROCESS environment (src/core/update/supervision.ts) — and stopped guessing:
 * systemd's INVOCATION_ID / JOURNAL_STREAM are inherited by terminal shells that desktop
 * sessions run as systemd user units, so the guess read an unsupervised `bun run start`
 * as supervised (swap, exit, dead server). And `../private/.env` is read by every launch
 * method alike, so a value there is ignored. That leaves the declaration as the whole
 * contract, which this gate holds from both ends:
 *
 *   1. package.json — the scripts that respawn on RESTART_EXIT_CODE (inline loop, or a
 *      delegated TS supervisor importing it) are DERIVED, then EXECUTED through `sh -c`
 *      with a stub `bun` first on PATH that records the environment of every launch of
 *      src/server.ts: each recorded launch carries DEDALO_SUPERVISED=true. Plain `start`
 *      records a launch WITHOUT it (unsupervised by design), and no other script may
 *      launch the server unclassified.
 *   2. systemd — every unit (deploy/*.service, and every fenced block under docs/ and
 *      engineering/) whose ExecStart runs src/server.ts carries
 *      `Environment=DEDALO_SUPERVISED=true`. A block that writes a DROP-IN (heredoc into
 *      `<name>@<i>.service.d/`) is judged with EVERY drop-in its document writes for that
 *      unit, merged in file-name order over deploy/systemd/<name>@.service, as systemd
 *      runs it — never alone, and never without its template (fail closed). A block with
 *      no section header is report output quoting a unit, not a unit (see isUnitText).
 *   3. compose — every tracked compose file, parsed (Bun.YAML): each ENGINE service (its
 *      command reaches src/server.ts or a supervised script, or it builds the image and
 *      inherits a Dockerfile CMD that runs src/server.ts) sets DEDALO_SUPERVISED "true".
 *      dev_instance.sh only execs supervised scripts (honest limit: read, not executed —
 *      it needs a live database to get that far).
 *   4. the reader, in child processes with a controlled environment: the systemd markers
 *      alone are NOT supervision; a scratch private .env saying true is NOT supervision,
 *      and the refusal names the ignored file; the process value IS.
 *   5. the installer never writes the key, whatever an answer smuggles in, and the .env
 *      template it copies into ../private/ offers no line that would set it.
 *
 *   6. the terminal installer's instance unit (phase 4): deploy/systemd/dedalo-ts@.service
 *      MERGED with its rendered drop-in the way systemd merges them (the drop-in replaces
 *      ExecStart) runs the server and carries the declaration, on every OS row.
 *
 * Floors (3 scripts, 2 units, 3 compose services) keep a broken derivation from passing
 * vacuously. A new launcher of the server is classified here or this gate goes red.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { envSnapshot, parseEnvFile, projectRoot } from '../../src/config/env.ts';
import { stampOf } from '../../src/core/install/host/production/common.ts';
import { instanceDropins, renderTemplate } from '../../src/core/install/host/systemd/render.ts';
import { RESTART_EXIT_CODE } from '../../src/core/update/restart.ts';
import {
	type ComposeServiceShape,
	DEPLOY_DIR,
	isProductImageService,
	parseComposeFile,
	shippedComposeStacks,
	systemdUnitNames,
	trackedComposeFiles,
} from '../helpers/deploy_artifact_corpus.ts';
import { mergedUnit, productionPlanCtx, unitEnvironment } from '../helpers/install_host_scratch.ts';
import { proseMarkdownFiles } from '../helpers/prose_markdown_corpus.ts';

const SUPERVISION_KEY = 'DEDALO_SUPERVISED';
/** Every variable that could make a child read as supervised by inheritance. */
const INHERITED_SIGNALS = [SUPERVISION_KEY, 'INVOCATION_ID', 'JOURNAL_STREAM'];
const SERVER_ENTRY = 'src/server.ts';
/** The one launcher that is unsupervised BY DESIGN (nothing relaunches it). */
const UNSUPERVISED_SCRIPTS = new Set(['start']);
/**
 * Drill harnesses: they start throwaway server instances with an environment they
 * compose themselves (and declare there what each instance needs), never an
 * installation's server. Named, with the reason, so a new launcher cannot hide here.
 */
const HARNESS_SCRIPTS: Readonly<Record<string, string>> = {
	'test:update':
		'scripts/update_drill.ts — scratch master + installed tree under its own supervisor loop',
	'test:update:dev': 'scripts/update_drill.ts --dev — the same drill on the developer channel',
	'test:pubhost:engine':
		'scripts/publication_host_engine_drill.ts — scratch engine for the publication-host drill',
};

const scratchRoot = mkdtempSync(join(tmpdir(), 'dedalo_supervision_'));
afterAll(() => rmSync(scratchRoot, { recursive: true, force: true }));

/** A copied environment record with every inherited supervision signal removed. */
function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(envSnapshot())) {
		if (value !== undefined && !INHERITED_SIGNALS.includes(key)) env[key] = value;
	}
	return { ...env, ...extra };
}

const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as {
	scripts: Record<string, string>;
};

/** The TS file a script delegates to with `bun run scripts/x.ts`, if any. */
function delegatedFile(script: string): string | undefined {
	return /bun run (scripts\/[\w./-]+\.ts)/.exec(script)?.[1];
}

/** Does this script respawn the server on RESTART_EXIT_CODE (inline, or via a TS supervisor)? */
function respawnsOnRestart(script: string): boolean {
	if (new RegExp(`-eq ${RESTART_EXIT_CODE}\\b`).test(script)) return true;
	const file = delegatedFile(script);
	if (file === undefined) return false;
	const source = readFileSync(join(projectRoot, file), 'utf8');
	return /import \{[^}]*RESTART_EXIT_CODE[^}]*\} from '[^']*core\/update\/restart\.ts'/.test(
		source,
	);
}

const SUPERVISED_SCRIPTS = Object.entries(pkg.scripts)
	.filter(([, script]) => respawnsOnRestart(script))
	.map(([name]) => name)
	.sort();

/** Does this script launch the server itself, or via a delegated TS file that does? */
function launchesServer(script: string): boolean {
	if (script.includes(SERVER_ENTRY)) return true;
	const file = delegatedFile(script);
	return (
		file !== undefined &&
		readFileSync(join(projectRoot, file), 'utf8').includes(`'${SERVER_ENTRY}'`)
	);
}

// ---------------------------------------------------------------------------
// 1. package.json — executed, not read.
// ---------------------------------------------------------------------------

/**
 * A `bun` that records the env of every launch of src/server.ts (one line per launch:
 * the key's value, or `<unset>`) and exits 0 instead of serving; the CSS watcher `dev`
 * starts is replaced by a sleep its supervisor kills; anything else runs the real bun.
 */
function writeStubBun(dir: string): void {
	const stub = `#!/bin/sh
for a in "$@"; do
	case "$a" in
		*${SERVER_ENTRY}) printf '%s\\n' "\${${SUPERVISION_KEY}-<unset>}" >> "$SUPERVISION_RECORD"; exit 0 ;;
		*scripts/build_css.ts) exec sleep 30 ;;
	esac
done
exec "$SUPERVISION_REAL_BUN" "$@"
`;
	writeFileSync(join(dir, 'bun'), stub);
	chmodSync(join(dir, 'bun'), 0o755);
	// A `node` beside the stub, or the stub is BYPASSED on a host without Node (the CI
	// image, measured 2026-10-09): `bun run` then prepends its own /tmp/bun-node-<rev>/
	// shim dir — holding a `bun` AND a `node` — to the child's PATH, so dev.ts's
	// spawn of a bare `bun` reached the REAL bun and booted a real server (the 'dev' leg
	// hung to its timeout). With a `node` already on PATH, bun adds no shim dir. It is
	// the real binary, which behaves as Node when invoked under that name — as the
	// shim's own `node` link does.
	symlinkSync(process.execPath, join(dir, 'node'));
}

/** Run one package.json script through `sh -c` under the stub; the recorded launches. */
function recordedLaunches(name: string): {
	launches: string[];
	exitCode: number | null;
	stderr: string;
} {
	const dir = mkdtempSync(join(scratchRoot, 'stub_'));
	writeStubBun(dir);
	const record = join(dir, 'launches.txt');
	const base = cleanEnv();
	const child = Bun.spawnSync(['sh', '-c', pkg.scripts[name] as string], {
		cwd: projectRoot,
		env: {
			...base,
			PATH: `${dir}:${base.PATH ?? ''}`,
			SUPERVISION_RECORD: record,
			SUPERVISION_REAL_BUN: process.execPath,
		},
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 60_000,
	});
	const launches = existsSync(record)
		? readFileSync(record, 'utf8')
				.split('\n')
				.filter((l) => l !== '')
		: [];
	return { launches, exitCode: child.exitCode, stderr: child.stderr.toString() };
}

describe('package.json launchers declare supervision', () => {
	test('the supervised-script census is derived and floored', () => {
		// Floor: the three supervisors shipped on 2026-10-08. A derivation that stopped
		// matching would otherwise make every leg below vacuous.
		for (const name of ['dev', 'dev:server', 'start:supervised'])
			expect(SUPERVISED_SCRIPTS).toContain(name);
		expect(SUPERVISED_SCRIPTS.length).toBeGreaterThanOrEqual(3);
	});

	test('no script launches the server unclassified', () => {
		const unclassified = Object.entries(pkg.scripts)
			.filter(([, script]) => launchesServer(script))
			.map(([name]) => name)
			.filter(
				(name) =>
					!SUPERVISED_SCRIPTS.includes(name) &&
					!UNSUPERVISED_SCRIPTS.has(name) &&
					HARNESS_SCRIPTS[name] === undefined,
			);
		expect(unclassified).toEqual([]);
	});

	test('every named harness exemption is live (a stale one is red)', () => {
		for (const name of Object.keys(HARNESS_SCRIPTS)) {
			expect(pkg.scripts[name], name).toBeDefined();
			expect(launchesServer(pkg.scripts[name] as string), name).toBe(true);
		}
	});

	for (const name of SUPERVISED_SCRIPTS) {
		test(`'${name}' launches the server with ${SUPERVISION_KEY}=true (executed)`, () => {
			const run = recordedLaunches(name);
			expect(run.exitCode, run.stderr).toBe(0);
			expect(run.launches.length, `${name} never launched ${SERVER_ENTRY}`).toBeGreaterThanOrEqual(
				1,
			);
			expect(run.launches.every((value) => value === 'true')).toBe(true);
		});
	}

	test("plain 'start' is unsupervised: its launch carries no declaration", () => {
		const run = recordedLaunches('start');
		expect(run.exitCode, run.stderr).toBe(0);
		expect(run.launches).toEqual(['<unset>']);
	});
});

// ---------------------------------------------------------------------------
// 2. systemd units — deploy/*.service + every fenced block in the manuals.
// ---------------------------------------------------------------------------

/**
 * The lines systemd parses, read the way systemd reads them: a comment is a
 * WHOLE line starting with `#` or `;`, and there is no inline comment. A
 * documented `Environment=DEDALO_SUPERVISED=true    # why` hands systemd the
 * value `DEDALO_SUPERVISED=true    # why`, which it splits on whitespace into
 * `#`, `why`, … as further (invalid, logged) assignments — and an operator who
 * quotes the whole value to silence that gets `true # why`, which is not `true`,
 * so every code update is refused. Stripping inline `#` here once hid exactly
 * that template (docs/install/multi_instance.md, 2026-10-08).
 */
function unitLines(text: string): string[] {
	return text
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith(';'));
}

/** A unit systemd would run, judged: does it carry the declaration? */
interface ServerUnit {
	label: string;
	/** A drop-in judged merged with its deploy/systemd/ template (not on its own). */
	dropin: boolean;
	declared: boolean;
}

/**
 * A drop-in a manual block writes as a heredoc into `<unit>@<i>.service.d/`:
 * `render > "/etc/systemd/system/dedalo-ts@$I.service.d/10-x.conf" <<'EOF'` … `EOF`.
 * Captures the template prefix (`dedalo-ts`), the drop-in file name (`10-x.conf`)
 * and the heredoc body.
 */
const DROPIN_HEREDOC =
	/\/([\w-]+)@[^/\s"']*\.service\.d\/([^\s"']*)["']?\s*<<-?\s*['"]?(\w+)['"]?\n([\s\S]*?)\n\3(?=\n|$)/g;

function runsServer(lines: readonly string[]): boolean {
	return lines.some((line) => /^ExecStart=/.test(line) && line.includes(SERVER_ENTRY));
}

/**
 * A block is a UNIT TEXT when it carries a section header, and only then is it
 * judged by {@link runsServer}: systemd requires a section header in a unit AND in
 * a drop-in, so a block without one is not a file anyone can install — it is
 * REPORT output that quotes a unit. docs/install/bun_runtime.md shows both
 * (`systemctl cat | grep`, and `grep -n '^ExecStart'` of the drop-in), and judging
 * those as units accused the manuals of a unit nobody wrote.
 */
function isUnitText(text: string): boolean {
	return /^\[[A-Za-z][\w-]*\]/m.test(text);
}

/**
 * Every unit that starts the server, judged as systemd runs it. A standalone unit
 * text is judged alone. A DROP-IN (manual_install.md writes the instance unit's
 * ExecStart that way, 2026-10-12) is never a unit on its own: systemd merges EVERY
 * drop-in of the unit's `.d/` directory, in file-name order, over the template — so
 * all the drop-ins one document writes for `<name>@` are collected (a later write
 * of the same file name replaces the earlier one), sorted by file name and merged
 * over deploy/systemd/<name>@.service ONCE, with the same merge leg 6 uses. A
 * sibling drop-in that resets or overrides the declaration without an ExecStart of
 * its own is therefore red too; a template that is missing merges as empty (fail
 * closed: the drop-ins are judged alone).
 */
function serverUnits(): ServerUnit[] {
	const declaredAlone = (text: string): boolean =>
		unitLines(text).includes(`Environment=${SUPERVISION_KEY}=true`);
	const units: ServerUnit[] = [];
	for (const name of systemdUnitNames()) {
		const text = readFileSync(join(DEPLOY_DIR, name), 'utf8');
		if (runsServer(unitLines(text)))
			units.push({ label: `deploy/${name}`, dropin: false, declared: declaredAlone(text) });
	}
	for (const file of proseMarkdownFiles()) {
		const text = readFileSync(file, 'utf8');
		const doc = relative(projectRoot, file);
		// template name → drop-in file name → body (one `.d/` directory per document).
		const dropins = new Map<string, Map<string, string>>();
		let index = 0;
		for (const match of text.matchAll(/```[\w-]*\n([\s\S]*?)```/g)) {
			const label = `${doc} block ${++index}`;
			let rest = match[1] as string;
			for (const heredoc of rest.matchAll(DROPIN_HEREDOC)) {
				const template = heredoc[1] as string;
				const files = dropins.get(template) ?? new Map<string, string>();
				files.set(heredoc[2] as string, heredoc[4] as string);
				dropins.set(template, files);
			}
			rest = rest.replace(DROPIN_HEREDOC, '');
			if (isUnitText(rest) && runsServer(unitLines(rest)))
				units.push({ label, dropin: false, declared: declaredAlone(rest) });
		}
		for (const [name, files] of dropins) {
			const templatePath = join(projectRoot, 'deploy/systemd', `${name}@.service`);
			const template = existsSync(templatePath) ? readFileSync(templatePath, 'utf8') : '';
			const ordered = [...files.keys()].sort();
			const merged = mergedUnit(
				template,
				ordered.map((fileName) => files.get(fileName) as string),
			);
			const execs = merged.get('Service.ExecStart') ?? [];
			if (!execs.some((exec) => exec.includes(SERVER_ENTRY))) continue;
			units.push({
				label: `${doc} drop-ins ${ordered.join(', ')} over deploy/systemd/${name}@.service`,
				dropin: true,
				declared: unitEnvironment(merged).get(SUPERVISION_KEY) === 'true',
			});
		}
	}
	return units;
}

describe('systemd units declare supervision', () => {
	test('every unit whose ExecStart runs the server carries Environment=DEDALO_SUPERVISED=true', () => {
		const units = serverUnits();
		const labels = units.map((unit) => unit.label);
		// Floor: the reference unit. The manual no longer carries a hand-written
		// multi-instance template (2026-10-12): the installer renders the instance
		// units from deploy/systemd/, held by the next describe as systemd merges
		// them. A unit block the manual adds again is still walked and held here.
		expect(labels).toContain('deploy/dedalo-ts.service');
		expect(units.length).toBeGreaterThanOrEqual(1);
		// Floor: manual_install.md's instance drop-in (2026-10-12) is found and judged
		// merged — a heredoc pattern that stopped matching would judge it vacuously.
		expect(units.some((unit) => unit.dropin)).toBe(true);
		expect(units.filter((unit) => !unit.declared).map((unit) => unit.label)).toEqual([]);
	});
});

describe("the terminal installer's instance units declare supervision", () => {
	test('dedalo-ts@<i> — the template merged with its drop-in, as systemd does — runs the server, supervised', () => {
		// Phase 4 (2026-10-12): a production install runs deploy/systemd/dedalo-ts@.service
		// with a per-instance drop-in that REPLACES ExecStart (the pinned Bun). Neither file
		// alone is the unit systemd runs; the merge is.
		for (const os of ['ubuntu2604', 'debian13', 'el10'] as const) {
			const ctx = productionPlanCtx({ os, web: 'nginx', tls: 'letsencrypt' });
			const dropins = instanceDropins(ctx.paths, ctx.row, ctx.answers, stampOf(ctx))
				.filter((dropin) => dropin.path.includes(`/dedalo-ts@${ctx.paths.instance}.service.d/`))
				.map((dropin) => dropin.content);
			const unit = mergedUnit(renderTemplate('dedalo-ts@.service', ctx.row, ctx.source), dropins);
			const execs = unit.get('Service.ExecStart') ?? [];
			expect(execs.length, os).toBe(1);
			expect(execs[0], os).toContain(SERVER_ENTRY);
			expect(unitEnvironment(unit).get(SUPERVISION_KEY), os).toBe('true');
		}
	});
});

// ---------------------------------------------------------------------------
// 3. compose stacks — parsed, not grepped.
// ---------------------------------------------------------------------------

type ComposeService = ComposeServiceShape;

/** Does the Dockerfile's final CMD run the server? (the image an entrypoint-less product-image service runs) */
function dockerfileCmdRunsServer(): boolean {
	const cmds = readFileSync(join(projectRoot, 'Dockerfile'), 'utf8')
		.split('\n')
		.filter((line) => line.startsWith('CMD '));
	return cmds.at(-1)?.includes(SERVER_ENTRY) === true;
}

function asText(value: string | string[] | undefined): string {
	return Array.isArray(value) ? value.join(' ') : (value ?? '');
}

/** An ENGINE service: it ends up running src/server.ts. */
function isEngineService(service: ComposeService): boolean {
	const command = asText(service.command);
	if (command.includes(SERVER_ENTRY)) return true;
	if (
		SUPERVISED_SCRIPTS.some((name) =>
			new RegExp(`\\brun ${name.replace(':', '\\:')}(\\s|$)`).test(command),
		)
	) {
		return true;
	}
	// The PRODUCT IMAGE with its own CMD — by outcome (installer unification D2):
	// the stacks name a pinned `${DEDALO_IMAGE:-localhost/dedalo}:…` and no longer
	// `build: .`, so the old `build !== undefined` test would have found no engine.
	return isProductImageService(service) &&
		service.command === undefined &&
		service.entrypoint === undefined
		? dockerfileCmdRunsServer()
		: false;
}

/**
 * An OVERLAY's service as compose runs it. A file under deploy/ is always layered
 * over a root stack (`-f docker-compose.simple.yml -f deploy/…`), so a service it
 * only re-tags (`backup: image: …`) keeps the base's entrypoint: judged alone it
 * would look like an entrypoint-less engine. Merged over the root stack that
 * defines the same service — key by key, environment maps merged like compose.
 */
function asRun(file: string, name: string, service: ComposeService): ComposeService {
	if (!file.startsWith('deploy/')) return service;
	const base = shippedComposeStacks()
		.map((stack) => parseComposeFile(stack).services?.[name])
		.find((candidate) => candidate !== undefined);
	if (base === undefined) return service;
	const environment =
		!Array.isArray(base.environment) && !Array.isArray(service.environment)
			? { ...(base.environment ?? {}), ...(service.environment ?? {}) }
			: (service.environment ?? base.environment);
	return { ...base, ...service, environment };
}

function declaredValue(service: ComposeService): unknown {
	const env = service.environment;
	if (Array.isArray(env)) {
		const line = env.find((item) => item.startsWith(`${SUPERVISION_KEY}=`));
		return line?.slice(SUPERVISION_KEY.length + 1);
	}
	return env?.[SUPERVISION_KEY];
}

describe('compose stacks declare supervision', () => {
	test('every engine service in a tracked compose file sets DEDALO_SUPERVISED "true"', async () => {
		const files = trackedComposeFiles();
		const engines: string[] = [];
		const undeclared: string[] = [];
		for (const file of files) {
			// Interpolated as compose does (no operator env: the shipped defaults).
			const parsed = parseComposeFile(file);
			for (const [name, declared] of Object.entries(parsed.services ?? {})) {
				const service = asRun(file, name, declared);
				if (!isEngineService(service)) continue;
				engines.push(`${file}:${name}`);
				if (declaredValue(service) !== 'true') undeclared.push(`${file}:${name}`);
			}
		}
		// Floor: the production stack, the simple stack, the QNAP dev override.
		for (const id of [
			'docker-compose.yml:dedalo',
			'docker-compose.simple.yml:dedalo',
			'deploy/docker-compose.qnap-dev.yml:dedalo',
		]) {
			expect(engines).toContain(id);
		}
		expect(undeclared).toEqual([]);
	});

	test('dev_instance.sh only execs supervised scripts (read, not executed — it needs a live DB)', () => {
		const source = readFileSync(join(projectRoot, 'scripts/dev_instance.sh'), 'utf8');
		const targets = [...source.matchAll(/^\s*exec bun run (\S+)/gm)].map((m) => m[1] as string);
		expect(targets.length).toBeGreaterThanOrEqual(1);
		expect(targets.filter((t) => !SUPERVISED_SCRIPTS.includes(t))).toEqual([]);
		// It must not declare a second copy: the scripts carry it.
		expect(unitLines(source).some((line) => line.includes(SUPERVISION_KEY))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 4. the reader — child processes with a controlled environment.
// ---------------------------------------------------------------------------

interface ReaderVerdict {
	supervised: boolean;
	onlyPrivate: boolean;
	message: string;
}

/** Ask supervision.ts in a fresh process, with a scratch private dir holding `privateEnv`. */
function readerVerdict(processEnv: Record<string, string>, privateEnv: string): ReaderVerdict {
	const dir = mkdtempSync(join(scratchRoot, 'private_'));
	writeFileSync(join(dir, '.env'), privateEnv);
	const module = JSON.stringify(join(projectRoot, 'src/core/update/supervision.ts'));
	const child = Bun.spawnSync(
		[
			process.execPath,
			'-e',
			`import { isSupervised, supervisionDeclaredOnlyInPrivateEnv, supervisorRefusalMessage } from ${module};
console.log(JSON.stringify({ supervised: isSupervised(), onlyPrivate: supervisionDeclaredOnlyInPrivateEnv(), message: supervisorRefusalMessage() }));`,
		],
		// cwd is NOT the private dir: Bun auto-loads a `.env` from its cwd into the process
		// environment, which would turn the file's value into a process value here.
		{
			cwd: scratchRoot,
			env: cleanEnv({ ...processEnv, DEDALO_PRIVATE_DIR: dir }),
			stdout: 'pipe',
			stderr: 'pipe',
		},
	);
	expect(child.exitCode, child.stderr.toString()).toBe(0);
	return JSON.parse(child.stdout.toString().trim()) as ReaderVerdict;
}

describe('the supervision reader', () => {
	test("systemd's inherited markers alone are NOT supervision", () => {
		const verdict = readerVerdict({ INVOCATION_ID: 'a1b2c3', JOURNAL_STREAM: '8:12345' }, '');
		expect(verdict.supervised).toBe(false);
		expect(verdict.onlyPrivate).toBe(false);
		expect(verdict.message).not.toContain('IGNORED');
	});

	test('a private .env saying true is NOT supervision, and the refusal names the ignored file', () => {
		const verdict = readerVerdict({}, `${SUPERVISION_KEY}=true\n`);
		expect(verdict.supervised).toBe(false);
		expect(verdict.onlyPrivate).toBe(true);
		expect(verdict.message).toContain('../private/.env is IGNORED');
	});

	test('the process declaration IS supervision; anything but the literal true is not', () => {
		expect(readerVerdict({ [SUPERVISION_KEY]: 'true' }, '').supervised).toBe(true);
		for (const value of ['false', '1', 'yes', 'TRUE', '']) {
			expect(
				readerVerdict({ [SUPERVISION_KEY]: value }, `${SUPERVISION_KEY}=true\n`).supervised,
			).toBe(false);
		}
	});
});

// ---------------------------------------------------------------------------
// 5. the installer never writes the key.
// ---------------------------------------------------------------------------

describe('the installer never declares supervision', () => {
	test('persistConfig with smuggled supervision answers writes no such key', () => {
		const dir = join(scratchRoot, 'install_private');
		mkdirSync(dir, { recursive: true });
		const answers = {
			db_hostname: 'localhost',
			db_port: '5432',
			db_database: 'dedalo_zz_supervision',
			db_username: 'tester',
			entity: 'testent',
			[SUPERVISION_KEY]: 'true',
			supervised: true,
			dedalo_supervised: 'true',
		};
		const module = JSON.stringify(join(projectRoot, 'src/core/install/config_persist.ts'));
		const child = Bun.spawnSync(
			[
				process.execPath,
				'-e',
				`import { persistConfig } from ${module};
const result = await persistConfig(${JSON.stringify(answers)});
console.log(JSON.stringify({ ok: result.ok }));`,
			],
			{
				cwd: scratchRoot, // never the dir holding the written .env (Bun auto-loads a cwd .env)
				env: cleanEnv({
					DEDALO_INSTALL_PRIVATE_DIR: dir,
					DEDALO_TS_STATE_PATH: join(dir, 'state.json'),
				}),
				stdout: 'pipe',
				stderr: 'pipe',
			},
		);
		expect(child.exitCode, child.stderr.toString()).toBe(0);
		expect(JSON.parse(child.stdout.toString().trim())).toEqual({ ok: true });
		const written = readFileSync(join(dir, '.env'), 'utf8');
		expect(parseEnvFile(written).DB_NAME).toBe('dedalo_zz_supervision'); // it really wrote
		expect(Object.keys(parseEnvFile(written)).filter((key) => key.includes('SUPERVIS'))).toEqual(
			[],
		);
		expect(written).not.toContain(SUPERVISION_KEY);
	});

	// The installer copies install/sample.env into ../private/ as the operator's key
	// census. A `#DEDALO_SUPERVISED=` line there invites an uncomment into exactly the
	// file the engine ignores (every code update then refused). The key is still
	// documented (catalog processEnvironmentOnly): prose and example, no assignment.
	test('the shipped .env template documents the key but offers no line that would set it', () => {
		const template = readFileSync(join(projectRoot, 'install/sample.env'), 'utf8');
		expect(template).toContain(SUPERVISION_KEY); // floor: still documented
		// The template's own assignment grammar: `KEY=` live, `#KEY=` to uncomment. An
		// indented `#   …` line is example prose (render.ts exampleLines), not an offer.
		const assignable = template
			.split('\n')
			.filter((line) => /^#?[A-Z][A-Z0-9_]*=/.test(line))
			.map((line) => line.replace(/^#/, ''));
		expect(assignable.length).toBeGreaterThan(50); // floor: the census was really read
		expect(Object.keys(parseEnvFile(assignable.join('\n')))).not.toContain(SUPERVISION_KEY);
	});
});
