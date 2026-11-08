/**
 * THE PRODUCTION HOST STEPS, RUN END TO END ON A SCRATCH HOST (terminal
 * installer phase 4, 2026-10-12; src/core/install/host/ — the production table
 * host_table.ts, the executor host_executor.ts over the ONE step loop).
 *
 * Every host step runs for real — the executor, the step loop, the state file,
 * every step's run/verify/undo — against a SCRATCH ROOT (host/fs.ts under a
 * marked mkdtemp dir) with the RECORDING RUNNER (host/runner.ts: nothing is
 * executed; each argv is logged and answered from the scratch host's response
 * table, test/helpers/install_host_scratch.ts). Nothing touches this machine:
 * no package manager, systemctl, useradd, certbot or web-server reload runs.
 *
 * WHAT IS MEASURED (outcomes, never spellings), for EVERY supported OS row ×
 * nginx|apache × Let's Encrypt|the institution's files:
 *  (a) REVIEW EQUALS RUN: every command the run executed that CHANGES the host
 *      is one the Review listed (the run's own frozen plan context through
 *      hostReview), in the Review's order — a listed command is absent only
 *      when its `unless` probe said it was already done (or the web user was
 *      already in the instance group); every other logged command is a
 *      read-only probe. And the Review the operator SAW before the run
 *      (reviewHostCommands, through the scratch seam) is the run's list.
 *  (b) WHAT LANDED: every file the Review writes holds its rendered bytes at
 *      its mode and owner, every directory its mode and owner (the owners
 *      sidecar of the scratch root).
 *  (c) IDEMPOTENT: a second run of a complete install runs no command that
 *      changes the host (only verifies) and answers `already_complete`.
 *  (d) NO SECRET LEAVES: the root password is in no logged argv, no file under
 *      the scratch root and no transcript line; the engine child received it
 *      on stdin (the log records only that there WAS a stdin).
 *  (e) ABORT UNDOES ONLY WHAT THIS INSTALL CREATED: pre-existing decoys (another
 *      site's file, another instance's registry entry, the shared templates and
 *      Bun it uses) survive byte-equal; a COMPLETE install is never taken apart
 *      (only the host steps after the engine are undone); a failed one drops
 *      its database only with --confirm-database, removes the user and the
 *      directories it created, and TELLS the packages it kept.
 *  (f) REFUSALS, each with its sentence, before anything changes: an
 *      unsupported OS (the sentence lists the supported rows), no root (the
 *      sudo command), nginx older than 1.25.1, an Apache module missing (the
 *      enabling command TOLD — the run stops, a resume continues once it is
 *      enabled), every name clash (user, database, role, unit, drop-ins, site
 *      file, socket, the address served by another site, a port held, another
 *      PostgreSQL major on the port), a foreign template unit, and the
 *      institution's certificate expired, for another address or with another key.
 *  (g) THE LOCAL CA ON PRODUCTION (owner decision 2026-10-16), every row ×
 *      nginx|apache: the same (a)–(c) end to end; the ONE generator run from
 *      its root-owned copy with every address as a --host, no certbot, no
 *      challenge site; the renewal drop-in and timer; the public probe trusting
 *      the install's own authority; Done telling its file and fingerprint; an
 *      abort removing exactly the timer, the drop-in and the directory this
 *      install made — never an authority that was there before; an authority
 *      for OTHER addresses refused on the System check.
 *
 * DB-FREE and network-free (the hermetic tier runs it): the certificate is
 * minted in memory by the openssl CLI (absent = RED, never a skip).
 */

import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { X509Certificate } from 'node:crypto';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { NOT_INSTALLED_EXIT_CODE } from '../../src/config/install_state.ts';
import type {
	HostCommand,
	HostPlanCtx,
	MkdirCommand,
} from '../../src/core/install/host/contract.ts';
import { effectiveArgv, instanceMkdirExec } from '../../src/core/install/host/execute.ts';
import { hostFs } from '../../src/core/install/host/fs.ts';
import {
	type HostExecutorOptions,
	hostPlanRefusals,
	hostResumeSecrets,
} from '../../src/core/install/host/host_executor.ts';
import { hostReview, hostTable } from '../../src/core/install/host/host_table.ts';
import { instancePaths } from '../../src/core/install/host/layout.ts';
import { osRowById, supportedOsList } from '../../src/core/install/host/os_support.ts';
import { databaseCommands } from '../../src/core/install/host/production/database.ts';
import {
	abortRequest,
	engineAnswers,
} from '../../src/core/install/host/production/engine_delegate.ts';
import {
	REFUSED_BOOT_EXIT,
	unitEverRan,
} from '../../src/core/install/host/production/first_boot.ts';
import { host_packages } from '../../src/core/install/host/production/packages.ts';
import { certificatePaths, siteText } from '../../src/core/install/host/production/web.ts';
import {
	EXISTS_NOT_CREATED,
	REVIEW_TODO_STEP,
	reviewHostCommands,
	reviewTodo,
} from '../../src/core/install/host/review.ts';
import {
	type CommandRunner,
	type RecordedResponse,
	scratchRunner,
} from '../../src/core/install/host/runner.ts';
import { stackFileOf } from '../../src/core/install/host/stack/layout.ts';
import { renderTemplate, UNIT_TEMPLATES } from '../../src/core/install/host/systemd/render.ts';
import { chainTrustVerdict } from '../../src/core/install/host/tls_trust.ts';
import {
	ANSWERS_FILE_SCHEMA,
	buildInstallPlan,
	type HostStepId,
	type InstallAnswers,
	normalizeInstallAnswers,
} from '../../src/core/install/install_plan.ts';
import { MEDIA_DIR_MODE } from '../../src/core/install/media_tree.ts';
import { resolveOntologyCatalog } from '../../src/core/install/ontology_catalog.ts';
import type { RunEnding } from '../../src/core/install/run_events.ts';
import {
	readPlanFile,
	readStateFile,
	runConfirmed,
	writeStateFile,
} from '../../src/core/install/run_files_core.ts';
import { ALREADY_COMPLETE_LINE } from '../../src/core/install/step_loop.ts';
import { doneSummary } from '../../src/core/install/ui/screens/done.ts';
import {
	asService,
	asServiceHomeDying,
	BUN_PIN,
	CERT_PATHS,
	freshRequest,
	HOST_VARIANTS,
	type HostVariant,
	hostFiles,
	hostResponses,
	INSTANCE,
	LOCAL_CA_DIR,
	LOCAL_CA_EXTRA_NAMES,
	LOCAL_CA_VARIANTS,
	laterRequest,
	localCaScratchAuthority,
	loggedCommands,
	loggedRequests,
	mintCertificate,
	productionPlan,
	productionPlanCtx,
	productionRaw,
	READ_ONLY_PROBES,
	REPO_ROOT,
	ROOT_PASSWORD,
	runHost,
	SCRATCH_DIR,
	type ScratchHost,
	SERVER_NAME,
	scratchFilePaths,
	sourceFiles,
	systemCaBundle,
	UNIT_NEVER_RAN,
	UNIT_RAN,
	UNSUPPORTED_OS_RELEASE,
	variantName,
} from '../helpers/install_host_scratch.ts';

const scratchBase = mkdtempSync(join(tmpdir(), 'dedalo_install_host_steps_'));
afterAll(() => rmSync(scratchBase, { recursive: true, force: true }));

const CERT = mintCertificate(SERVER_NAME);
const RUN_DIR = `/var/lib/dedalo-install/${INSTANCE}`;
const DB = `dedalo_${INSTANCE}`;

// ── planting (this gate writes; the helper only answers bytes) ───────────────

/** Write `files` under `base` (a path ending in `/` is a directory). */
function plant(base: string, files: ReadonlyMap<string, string>): void {
	for (const [path, content] of files) {
		const real = join(base, path);
		if (path.endsWith('/')) {
			mkdirSync(real, { recursive: true });
			continue;
		}
		mkdirSync(dirname(real), { recursive: true });
		writeFileSync(real, content);
	}
}

let counter = 0;

interface PlantOptions {
	/** Extra host files (decoys, a planted binary, a foreign unit…). */
	files?: ReadonlyMap<string, string>;
	/** Responses placed BEFORE the scratch host's (first match wins). */
	responses?: readonly RecordedResponse[];
	/** Replace the os-release. */
	osRelease?: string;
	/** Modes to set on planted host paths, after planting (owner stays root). */
	modes?: readonly [string, number][];
}

/** A planted scratch host of `variant`. */
function scratchHost(variant: HostVariant, options: PlantOptions = {}): ScratchHost {
	counter += 1;
	const base = join(scratchBase, `h${counter}`);
	const root = join(base, 'root');
	const source = join(base, 'source');
	plant(root, hostFiles(variant, CERT));
	plant(source, sourceFiles());
	if (options.osRelease !== undefined)
		plant(root, new Map([['/etc/os-release', options.osRelease]]));
	plant(root, options.files ?? new Map());
	for (const [path, mode] of options.modes ?? []) chmodSync(join(root, path), mode);
	mkdirSync(join(root, SCRATCH_DIR), { recursive: true });
	writeFileSync(
		join(root, SCRATCH_DIR, 'responses.json'),
		JSON.stringify([...(options.responses ?? []), ...hostResponses(variant)]),
	);
	return { root, source };
}

/** Replace the responses of a planted host (an operator fixed something between runs). */
function replaceResponses(
	host: ScratchHost,
	variant: HostVariant,
	first: readonly RecordedResponse[],
): void {
	writeFileSync(
		join(host.root, SCRATCH_DIR, 'responses.json'),
		JSON.stringify([...first, ...hostResponses(variant)]),
	);
}

// ── the run's own Review (its frozen plan context) ───────────────────────────

/** The plan context the run froze (the plan file + the preflight's facts). */
function frozenContext(host: ScratchHost): HostPlanCtx {
	const dir = join(host.root, RUN_DIR);
	const plan = readPlanFile(dir);
	const state = readStateFile(dir);
	const facts = state?.preflight.host?.facts;
	if (plan === null || facts === undefined || facts.os === null) throw new Error('no frozen run');
	const answers = normalizeInstallAnswers(plan.answers as Record<string, unknown>).answers;
	return {
		plan,
		answers,
		facts,
		row: osRowById(facts.os),
		paths: instancePaths(answers, BUN_PIN),
		source: host.source,
	};
}

/** Every host command of the plan, per step (the Review's list, as objects). */
function reviewCommands(ctx: HostPlanCtx): { step: HostStepId; command: HostCommand }[] {
	const table = hostTable(() => ({ ...ctx, bunPin: BUN_PIN }));
	return (ctx.plan.steps as HostStepId[]).flatMap((step) =>
		table[step].commands(ctx).map((command) => ({ step, command })),
	);
}

/** An exec command as the runner logs it. */
function logged(ctx: HostPlanCtx, command: HostCommand & { kind: 'exec' }): string {
	return effectiveArgv(command, ctx.row, ctx.paths).join(' ');
}

/** The commands a run may log without the Review listing them: READ-ONLY probes only. */
const READ_ONLY = READ_ONLY_PROBES;

/** The Review's mutating execs, in order, with what may excuse their absence from a run. */
function mutatingReview(ctx: HostPlanCtx): { line: string; skippable: boolean }[] {
	return reviewCommands(ctx)
		.map(({ command }) =>
			command.kind === 'mkdir' && command.as === 'instance'
				? instanceMkdirExec(command, ctx.row)
				: command,
		)
		.filter((command): command is HostCommand & { kind: 'exec' } => command.kind === 'exec')
		.filter((command) => command.mutates)
		.map((command) => ({
			line: logged(ctx, command),
			// An `unless` probe said "already done"; the web user already in the group.
			skippable: command.unless !== undefined || command.argv.includes('-aG'),
		}));
}

/** Walk the Review's mutating list against the run's mutating log: in order, nothing extra. */
function reviewEqualsRun(ctx: HostPlanCtx, log: readonly string[]): string[] {
	const review = mutatingReview(ctx);
	const reviewed = new Set(review.map((item) => item.line));
	const problems = log
		.filter((line) => !reviewed.has(line) && !READ_ONLY.some((pattern) => pattern.test(line)))
		.map((line) => `not on the Review, not a read-only probe: ${line}`);
	const ran = log.filter((line) => reviewed.has(line));
	let at = 0;
	for (const item of review) {
		if (ran[at] === item.line) at += 1;
		else if (!item.skippable) problems.push(`on the Review, not run (in order): ${item.line}`);
	}
	if (at < ran.length) problems.push(`run out of the Review's order: ${ran.slice(at).join(' | ')}`);
	return problems;
}

/** Every file and directory the Review writes, at its last write's bytes, mode and owner. */
function landedProblems(host: ScratchHost, ctx: HostPlanCtx): string[] {
	const fs = hostFs(host.root, join(host.root, SCRATCH_DIR, 'owners.json'));
	const last = new Map<string, HostCommand>();
	for (const { command } of reviewCommands(ctx)) {
		if (command.kind === 'write' || command.kind === 'mkdir') last.set(command.path, command);
	}
	const problems: string[] = [];
	for (const [path, command] of last) {
		const stat = fs.stat(path);
		if (command.kind === 'write' && fs.readText(path) !== command.content)
			problems.push(`${path}: not its render`);
		if (command.kind !== 'write' && command.kind !== 'mkdir') continue;
		if (stat?.mode !== command.mode)
			problems.push(`${path}: mode ${stat?.mode.toString(8)}, not ${command.mode.toString(8)}`);
		if (stat?.owner !== command.owner || stat.group !== command.group)
			problems.push(
				`${path}: owner ${stat?.owner}:${stat?.group}, not ${command.owner}:${command.group}`,
			);
	}
	return problems;
}

/** Every file under `dir` (recursive), as text. */
function allFiles(dir: string): { path: string; text: string }[] {
	return scratchFilePaths(dir).map((path) => ({ path, text: readFileSync(path, 'utf8') }));
}

/** Mutating log lines (anything that is not a read-only probe). */
function mutatingLog(log: readonly string[]): string[] {
	return log.filter((line) => !READ_ONLY.some((pattern) => pattern.test(line)));
}

// ── (a)–(d) every variant ────────────────────────────────────────────────────

describe('every production variant runs end to end: Review ≡ run, files landed, idempotent, no secret (a–d)', () => {
	test('the matrix is every supported row × nginx|apache × letsencrypt|files', () => {
		expect(HOST_VARIANTS.length).toBe(12);
		expect(new Set(HOST_VARIANTS.map((variant) => variant.os))).toEqual(
			new Set(['ubuntu2604', 'debian13', 'el10']),
		);
	});

	for (const variant of HOST_VARIANTS) {
		test(variantName(variant), async () => {
			const host = scratchHost(variant);
			const { plan, planFile } = productionPlan(variant);
			const first = await runHost(host, freshRequest(planFile));
			expect(first.outcome.message).toBeNull();
			expect(first.outcome.result).toBe('complete');
			const ctx = frozenContext(host);
			const log = loggedCommands(host.root);
			// (a) Review equals run.
			expect(reviewEqualsRun(ctx, log)).toEqual([]);
			expect(mutatingReview(ctx).length).toBeGreaterThan(20);
			// (b) what landed.
			expect(landedProblems(host, ctx)).toEqual([]);
			// The firewall is checked, never changed: said on the preflight's line, and told
			// (the closing To-do) only when there is something to do — campaign 3c D16.
			expect(first.transcript.lines.join('\n')).toContain('firewall (checked, not changed)');
			expect(
				first.outcome.told.some((line) => line.startsWith('firewall (checked, not changed)')),
			).toBe(false);
			expect(
				log.some((line) => /firewall-cmd --(add|remove)|ufw (allow|deny|enable)/.test(line)),
			).toBe(false);
			// (d) no secret: argv, files, transcript; the engine child got it on stdin.
			const leaks = [
				...log.filter((line) => line.includes(ROOT_PASSWORD)),
				...allFiles(host.root)
					.filter((file) => file.text.includes(ROOT_PASSWORD))
					.map((file) => file.path),
				...first.transcript.lines.filter((line) => line.includes(ROOT_PASSWORD)),
			];
			expect(leaks).toEqual([]);
			const child = loggedRequests(host.root).find((entry) =>
				entry.argv.includes('--request-stdin'),
			);
			expect(child?.stdin).toBe(true);
			// It dies with the installer (C3-29): `setpriv --pdeathsig KILL` outside runuser (runuser
			// dies with us) AND inside it (the child dies with runuser, which forks it).
			expect(child?.argv.slice(0, 14)).toEqual([
				'/usr/bin/setpriv',
				'--pdeathsig',
				'KILL',
				'--',
				'/usr/sbin/runuser',
				'-u',
				`ded_${INSTANCE}`,
				'-g',
				`ded_${INSTANCE}`,
				'--',
				'/usr/bin/setpriv',
				'--pdeathsig',
				'KILL',
				'--',
			]);
			// The salt went to the one-time display, never to the transcript.
			expect(first.transcript.shown.join('\n')).toContain('scratch-salt-value');
			expect(first.transcript.lines.join('\n')).not.toContain('scratch-salt-value');
			// (c) idempotent.
			const second = await runHost(host, laterRequest('resume', plan));
			expect(second.outcome.result).toBe('already_complete');
			// The host executor says it too (campaign 3b N7: only the engine did).
			expect(second.transcript.lines).toContain(ALREADY_COMPLETE_LINE);
			expect(mutatingLog(loggedCommands(host.root).slice(log.length))).toEqual([]);
		});
	}
});

describe("host_packages' headline names exactly what its commands install (campaign 3f U26)", () => {
	for (const variant of HOST_VARIANTS) {
		test(variantName(variant), () => {
			// A bare host (pending facts: nothing installed): the commands install every desired package.
			const ctx = productionPlanCtx(variant);
			const argv = host_packages
				.commands(ctx)
				.flatMap((command) => (command.kind === 'exec' ? command.argv : []));
			const installsCertbot = argv.includes('certbot');
			expect(installsCertbot).toBe(variant.tls === 'letsencrypt');
			expect(host_packages.label(ctx.plan).includes('certbot')).toBe(installsCertbot);
		});
	}
});

// ── (a) the Review the operator saw ─────────────────────────────────────────

describe('the Review shown before the run lists the commands the run executes (a)', () => {
	for (const variant of [HOST_VARIANTS[0], HOST_VARIANTS.at(-1)] as HostVariant[]) {
		test(`${variantName(variant)}: reviewHostCommands (before) ≡ the run's frozen list (after)`, async () => {
			const host = scratchHost(variant);
			// The Review reads this checkout (a git one): so does the run here.
			mkdirSync(join(host.source, '.git'));
			const { plan, planFile } = productionPlan(variant);
			const previous = process.env.DEDALO_INSTALL_HOST_ROOT;
			process.env.DEDALO_INSTALL_HOST_ROOT = host.root;
			let shown: Awaited<ReturnType<typeof reviewHostCommands>>;
			try {
				shown = await reviewHostCommands(plan);
			} finally {
				if (previous === undefined) delete process.env.DEDALO_INSTALL_HOST_ROOT;
				else process.env.DEDALO_INSTALL_HOST_ROOT = previous;
			}
			// The Review's own probes are read-only.
			expect(mutatingLog(loggedCommands(host.root))).toEqual([]);
			const before = loggedCommands(host.root).length;
			expect((await runHost(host, freshRequest(planFile))).outcome.result).toBe('complete');
			expect(loggedCommands(host.root).length).toBeGreaterThan(before);
			// The exact TEXT: every Review line equals the run's — the checkout the Review
			// read its templates from (this repo) and the run's (the scratch source) aside.
			// The Review's "exists: not created" marker on a mkdir line is display, not a command (N26).
			const normalize = (line: string) =>
				line
					.replace(EXISTS_NOT_CREATED, '')
					.split(host.source)
					.join('<source>')
					.split(REPO_ROOT)
					.join('<source>');
			const run = hostReview(frozenContext(host));
			// The to-do block runs nothing (review.ts): every OTHER block is a step's list.
			const steps = shown.filter((block) => block.step !== REVIEW_TODO_STEP);
			expect(run.map((block): string => block.step)).toEqual(
				steps.map((block): string => block.step),
			);
			for (const block of steps) {
				const ran = run.find((item) => item.step === block.step)?.commands ?? [];
				expect(ran.map(normalize), block.step).toEqual(block.commands.map(normalize));
			}
		});
	}
});

// ── (e) abort ────────────────────────────────────────────────────────────────

const UBUNTU_NGINX_LE = HOST_VARIANTS[0] as HostVariant;
const DEBIAN_APACHE_LE = HOST_VARIANTS.find(
	(variant) =>
		variant.os === 'debian13' && variant.web === 'apache' && variant.tls === 'letsencrypt',
) as HostVariant;

/** Another instance on the same host, and another site: what an abort must never touch. */
function decoys(variant: HostVariant): Map<string, string> {
	const row = osRowById(variant.os);
	const files = new Map<string, string>([
		[
			'/etc/nginx/conf.d/museum-shop.conf',
			'server {\n\tlisten 443 ssl;\n\tserver_name shop.example.org;\n}\n',
		],
		[
			'/var/lib/dedalo-install/instances/other.json',
			`${JSON.stringify({ instance: 'other', bun_pin: BUN_PIN, templates: true, selinux_module: false, nginx_map_owner: false, media: '/srv/dedalo/other/dedalo/media' }, null, '\t')}\n`,
		],
		[`/opt/dedalo/bun/${BUN_PIN}/bun`, 'the runtime instance other runs\n'],
		['/srv/dedalo/other/dedalo/media/image/original/x_test3_1.jpg', 'a heritage image\n'],
	]);
	// The shared templates other already installed: byte-equal to this release's.
	for (const name of UNIT_TEMPLATES)
		files.set(`/etc/systemd/system/${name}`, renderTemplate(name, row, REPO_ROOT));
	return files;
}

/** Each decoy still holds its bytes. */
function decoysIntact(host: ScratchHost, files: ReadonlyMap<string, string>): string[] {
	return [...files]
		.filter(([path, text]) => {
			try {
				return readFileSync(join(host.root, path), 'utf8') !== text;
			} catch {
				return true;
			}
		})
		.map(([path]) => path);
}

/** The logged runs of `argv` that were fed a stdin (psql's CREATE/DROP travel there). */
function stdinRuns(host: ScratchHost, argv: string): number {
	return loggedRequests(host.root).filter((entry) => entry.stdin && entry.argv.join(' ') === argv)
		.length;
}

describe('abort undoes only what this install created (e)', () => {
	test('a COMPLETE install: only the host steps after the engine are undone; the instance and every decoy survive', async () => {
		const files = decoys(UBUNTU_NGINX_LE);
		const host = scratchHost(UBUNTU_NGINX_LE, { files });
		const { plan, planFile } = productionPlan(UBUNTU_NGINX_LE);
		expect((await runHost(host, freshRequest(planFile))).outcome.result).toBe('complete');
		const site = join(host.root, `/etc/nginx/conf.d/dedalo-${INSTANCE}.conf`);
		expect(statSync(site).isFile()).toBe(true);
		const before = loggedCommands(host.root).length;
		const abort = await runHost(host, laterRequest('abort', plan));
		expect(abort.outcome.result).toBe('aborted');
		expect(abort.outcome.keptLive).toBe(true);
		const undoing = abort.transcript.lines.find((line) => line.startsWith('→ undoing:')) ?? '';
		expect(undoing.replace('→ undoing: ', '').split(', ')).toEqual([
			'host_backup_verify',
			'host_web_site',
			'host_tls',
			'host_web_http',
			'host_watchdog',
			'host_first_boot',
			'host_selinux',
			'host_units',
		]);
		const undone = loggedCommands(host.root).slice(before);
		// The instance stays: no user removed, no engine abort, the database untouched.
		expect(undone.filter((line) => /userdel|groupdel|--abort/.test(line))).toEqual([]);
		expect(decoysIntact(host, files)).toEqual([]);
		// What it created after the engine is gone: our site file and drop-ins.
		expect(() => statSync(site)).toThrow();
		expect(() =>
			statSync(
				join(
					host.root,
					`/etc/systemd/system/dedalo-ts@${INSTANCE}.service.d/10-dedalo-install.conf`,
				),
			),
		).toThrow();
		// The record stays (a --resume puts the undone steps back).
		expect(readStateFile(join(host.root, RUN_DIR))?.outcome).toBe('in_progress');
	});

	test('a FAILED install: no database dropped without --confirm-database; with it, the database, the user and the empty directories go, the packages are told kept', async () => {
		const files = decoys(UBUNTU_NGINX_LE);
		const pg = osRowById('ubuntu2604').pgBinDir;
		const bun = `/opt/dedalo/bun/${BUN_PIN}/bun`;
		const child = `/usr/sbin/runuser -u ded_${INSTANCE} -g ded_${INSTANCE} -- /usr/bin/env HOME=/home/ded_${INSTANCE} ${bun} run /home/ded_${INSTANCE}/dedalo/scripts/install.ts`;
		// The run and the abort die with the installer (C3-29): the death prefix at both ends.
		const dying = `${asServiceHomeDying()} ${bun} run /home/ded_${INSTANCE}/dedalo/scripts/install.ts`;
		const host = scratchHost(UBUNTU_NGINX_LE, {
			files,
			responses: [
				{ match: `${dying} --request-stdin`, exit: 9, stderr: 'the seed restore failed' },
				{
					match: `${child} --status --json`,
					after: `${dying} --request-stdin`,
					until: `${dying} --abort`,
					stdout:
						'{"exists":true,"outcome":"in_progress","failed_step":"install_db_from_default_file"}\n',
				},
			],
		});
		const { plan, planFile } = productionPlan(UBUNTU_NGINX_LE);
		const fresh = await runHost(host, freshRequest(planFile));
		expect(fresh.outcome.result).toBe('failed');
		expect(fresh.outcome.failedStep).toBe('host_engine');
		const psql = `/usr/sbin/runuser -u postgres -- ${pg}/psql -X -q -A -t -v ON_ERROR_STOP=1 -h /var/run/postgresql -p 5432 -d postgres`;
		expect(stdinRuns(host, psql)).toBe(3); // CREATE ROLE, CREATE DATABASE, REVOKE … FROM PUBLIC
		// Without the database name typed back: refused, nothing dropped.
		const beforeRefusal = loggedCommands(host.root).length;
		const refused = await runHost(host, laterRequest('abort', plan));
		expect(refused.outcome.result).not.toBe('aborted');
		expect(refused.outcome.message).toContain(`--confirm-database ${DB}`);
		expect(stdinRuns(host, psql)).toBe(3);
		// Checked BEFORE anything is undone: no engine --abort (it would reset the database on
		// the operator's behalf), no user removed, no step undone — the install is whole.
		const duringRefusal = loggedCommands(host.root).slice(beforeRefusal);
		expect(duringRefusal.filter((line) => /--abort|userdel|groupdel|rm -rf/.test(line))).toEqual(
			[],
		);
		expect(refused.transcript.lines.some((line) => line.startsWith('→ undoing:'))).toBe(false);
		// With it: dropped (DROP DATABASE, DROP ROLE), the user removed, empty dirs gone.
		const aborted = await runHost(host, laterRequest('abort', plan, DB));
		expect(aborted.outcome.message).toBeNull();
		expect(aborted.outcome.result).toBe('aborted');
		expect(stdinRuns(host, psql)).toBe(5);
		expect(aborted.outcome.keptLive).toBe(false);
		const log = loggedCommands(host.root);
		expect(log).toContain(`/usr/sbin/userdel ded_${INSTANCE}`);
		// What the user left in the shared temp dirs goes first, AS the user (campaign 3c
		// D12: Bun's /tmp/bun-node-<hash>/ and .<hash>-0.hm outlived the account as files of
		// a bare uid — the real-host proof is the drill's /tmp tmpfs + `find -nouser` leg).
		const sweep = log.indexOf(
			`${asService()} /usr/bin/find /tmp /var/tmp -xdev -mindepth 1 -maxdepth 1 -user ded_${INSTANCE} -exec rm -rf -- {} +`,
		);
		expect(sweep).toBeGreaterThan(-1);
		expect(sweep).toBeLessThan(log.indexOf(`/usr/sbin/userdel ded_${INSTANCE}`));
		// The folder this install created goes with the user (no file left to a reusable uid):
		// emptied BY THE SERVICE USER (root never works by path inside a tree another account
		// controls — critique B1), then removed; never filled by useradd's skeleton.
		expect(log).toContain(
			`/usr/sbin/runuser -u ded_${INSTANCE} -g ded_${INSTANCE} -- /usr/bin/rm -rf -- /home/ded_${INSTANCE}/backups /home/ded_${INSTANCE}/dedalo /home/ded_${INSTANCE}/private`,
		);
		expect(log.filter((line) => /^\/usr\/bin\/rm .*\/home\//.test(line))).toEqual([]);
		expect(log.some((line) => line.includes('useradd') && line.includes('--create-home'))).toBe(
			false,
		);
		const install = loggedRequests(host.root).find((entry) =>
			entry.argv.join(' ').includes(`/bun install --frozen-lockfile`),
		);
		expect(install?.env.BUN_INSTALL_CACHE_DIR?.startsWith(`/home/ded_${INSTANCE}/dedalo/`)).toBe(
			true,
		);
		// Bun's temporary files in the tree too (campaign 3c D12): a /tmp on another
		// filesystem got a `.<hash>-0.hm` of the service user, orphaned by --abort's userdel
		// (the real-host proof: the drill's /tmp tmpfs + `find -nouser` leg).
		expect(install?.env.TMPDIR).toBe(`/home/ded_${INSTANCE}/dedalo`);
		// No lifecycle scripts (TODO-063): any script run leaves Bun's `.<hash>-<pid>.node-gyp`
		// shim dir in TMPDIR — here, the tree.
		expect(install?.argv).toContain('--ignore-scripts');
		expect(log).toContain(
			`/usr/sbin/runuser -u ded_${INSTANCE} -g ded_${INSTANCE} -- /usr/bin/rm -rf /home/ded_${INSTANCE}/dedalo/.bun-install-cache`,
		);
		expect(
			log.filter((line) => line.startsWith(`${dying} --abort --confirm-database ${DB}`)).length,
		).toBe(1);
		for (const dir of [
			`/srv/dedalo/${INSTANCE}/dedalo/media`,
			`/home/ded_${INSTANCE}/private`,
			`/opt/dedalo/instances/${INSTANCE}/bin`,
		])
			expect(() => statSync(join(host.root, dir)), dir).toThrow();
		expect(decoysIntact(host, files)).toEqual([]);
		expect(aborted.transcript.lines.join('\n')).toContain(
			'kept (shared host state, never removed)',
		);
		// No record is left (a fresh install may start again).
		expect(readPlanFile(join(host.root, RUN_DIR))).toBeNull();
	});
});

describe('an abort keeps only the packages the host HAS (campaign 3b N17)', () => {
	test('interrupted during `apt-get update`: the abort names no package as kept — none was installed', async () => {
		const { host, plan, outcome } = await freshOn(DEBIAN_APACHE_LE, {
			responses: [{ match: '/usr/bin/apt-get update', exit: 100, stderr: 'E: network down' }],
		});
		expect(outcome.failedStep).toBe('host_packages');
		// Before the engine steps: no salt was generated, the ✖ hint says nothing of one (campaign 3e E3).
		expect(outcome.hint.join('\n')).not.toContain('DEDALO_SALT_STRING');
		const aborted = await runHost(host, laterRequest('abort', plan, DB));
		expect(aborted.outcome.result).toBe('aborted');
		const text = aborted.transcript.lines.join('\n');
		expect(text).not.toContain('apache2');
		expect(text).toContain('no package was added');
	});
});

// ── (f) refusals ─────────────────────────────────────────────────────────────

/** A fresh run of `variant` on a planted host; answers the outcome and whether anything changed. */
async function freshOn(
	variant: HostVariant,
	options: PlantOptions = {},
	extra: Record<string, unknown> = {},
	now?: () => number,
) {
	const host = scratchHost(variant, options);
	const { plan, planFile } = productionPlan(variant, extra);
	const run = await runHost(host, freshRequest(planFile), now === undefined ? {} : { now });
	return { host, plan, outcome: run.outcome, changed: mutatingLog(loggedCommands(host.root)) };
}

/** A System check refusal: refused or failed AT host_preflight, nothing changed on the host. */
async function preflightRefusal(
	variant: HostVariant,
	options: PlantOptions,
	extra: Record<string, unknown> = {},
	now?: () => number,
): Promise<string> {
	const { host, outcome, changed } = await freshOn(variant, options, extra, now);
	// A refused host keeps NOTHING of the attempt (campaign 3 C3-23): refused before the
	// record exists — no run dir, no state, no resume or abort to offer.
	expect(outcome.result).toBe('refused');
	expect(outcome.failedStep).toBeNull();
	expect(outcome.hint).toEqual([]);
	expect(() => statSync(join(host.root, RUN_DIR))).toThrow();
	expect(changed).toEqual([]);
	return outcome.message ?? '';
}

const NGINX_PRESENT = new Map([['/usr/sbin/nginx', '']]);

describe('refusals, each before anything changes (f)', () => {
	test('an unsupported OS: the sentence names it and lists every supported row (newest releases only)', async () => {
		const message = await preflightRefusal(UBUNTU_NGINX_LE, { osRelease: UNSUPPORTED_OS_RELEASE });
		expect(message).toContain('Ubuntu 24.04.3 LTS is not supported');
		expect(message).toContain(supportedOsList());
		expect(supportedOsList()).toBe(
			'Ubuntu 26.04 LTS, Debian 13 (trixie), RHEL / Rocky Linux / AlmaLinux 10',
		);
	});

	test('not root: refused with the sudo command (the preflight measures the effective uid)', async () => {
		const message = await preflightRefusal(UBUNTU_NGINX_LE, {
			responses: [{ match: '/usr/bin/id -u', stdout: '1000\n' }],
		});
		expect(message).toContain('the production route must run as root: sudo sh install.sh');
	});

	test('not root, before the preflight: the executor refuses before writing its record', async () => {
		const host = scratchHost(UBUNTU_NGINX_LE);
		const { planFile } = productionPlan(UBUNTU_NGINX_LE);
		expect(process.geteuid?.()).not.toBe(0);
		const { executeHostInstall } = await import('../../src/core/install/host/host_executor.ts');
		const { scratchRunner } = await import('../../src/core/install/host/runner.ts');
		const marker = join(host.root, SCRATCH_DIR);
		const outcome = await executeHostInstall(
			freshRequest(planFile),
			{ log: () => {}, warn: () => {} },
			{
				runner: scratchRunner(marker),
				fs: hostFs(host.root, join(marker, 'owners.json')),
				source: host.source,
			},
		);
		expect(outcome.result).toBe('refused');
		// Linux: the sudo form; any other system: the production route is Linux-only.
		expect(outcome.message).toContain(
			process.platform === 'linux' ? 'sudo sh install.sh' : 'use the docker or trial route',
		);
		expect(() => statSync(join(host.root, RUN_DIR))).toThrow();
		expect(loggedCommands(host.root)).toEqual([]);
	});

	test('nginx older than 1.25.1 (`http2 on;`): refused with the minimum, no fallback form', async () => {
		const message = await preflightRefusal(UBUNTU_NGINX_LE, {
			files: NGINX_PRESENT,
			responses: [{ match: '/usr/sbin/nginx -v', stderr: 'nginx version: nginx/1.24.0\n' }],
		});
		expect(message).toContain('nginx 1.24.0 is older than 1.25.1');
	});

	test('nginx 1.26 on the host is accepted (the version floor is not vacuous)', async () => {
		const { outcome } = await freshOn(UBUNTU_NGINX_LE, {
			files: NGINX_PRESENT,
			responses: [{ match: '/usr/sbin/nginx -v', stderr: 'nginx version: nginx/1.26.3\n' }],
		});
		expect(outcome.result).toBe('complete');
	});

	test('an Apache module missing: the enabling command is TOLD, never run; a resume continues once it is enabled', async () => {
		const { host, plan, outcome } = await freshOn(DEBIAN_APACHE_LE, {
			responses: [
				{
					match: '/usr/sbin/apache2ctl -M',
					stdout:
						' ssl_module (shared)\n headers_module (shared)\n http2_module (shared)\n rewrite_module (shared)\n proxy_module (shared)\n',
				},
			],
		});
		expect(outcome.failedStep).toBe('host_web_http');
		expect(outcome.message).toContain('a2enmod proxy_http && systemctl restart apache2');
		expect(loggedCommands(host.root).filter((line) => line.includes('a2enmod'))).toEqual([]);
		replaceResponses(host, DEBIAN_APACHE_LE, []);
		expect((await runHost(host, laterRequest('resume', plan))).outcome.result).toBe('complete');
	});

	const clashes: {
		name: string;
		options: PlantOptions;
		extra?: Record<string, unknown>;
		variant?: HostVariant;
		sentence: string;
	}[] = [
		{
			// An existing REGULAR account is used as it is (install_host_identity_native); a
			// SYSTEM account of the default name is an earlier install's leftover — never reused.
			name: 'the default service user exists as a system account (a leftover)',
			options: {
				responses: [
					{
						match: `/usr/bin/getent passwd ded_${INSTANCE}`,
						stdout: `ded_${INSTANCE}:x:998:998::/home/ded_${INSTANCE}:/usr/sbin/nologin\n`,
					},
				],
			},
			sentence: `account ded_${INSTANCE} is a system account (uid 998)`,
		},
		{
			name: 'the database exists',
			options: {
				responses: [
					{
						match: '/usr/sbin/runuser -u postgres -- /usr/lib/postgresql/18/bin/psql -XAtq',
						stdout: '1 0\n',
					},
				],
			},
			sentence: `database ${DB} already exists`,
		},
		{
			name: 'the role exists',
			options: {
				responses: [
					{
						match: '/usr/sbin/runuser -u postgres -- /usr/lib/postgresql/18/bin/psql -XAtq',
						stdout: '0 1\n',
					},
				],
			},
			sentence: `role ded_${INSTANCE} already exists`,
		},
		{
			name: 'the server unit is enabled',
			options: {
				responses: [
					{
						match: '/usr/bin/systemctl list-unit-files',
						stdout: `dedalo-ts@${INSTANCE}.service enabled enabled\n`,
					},
				],
			},
			sentence: `dedalo-ts@${INSTANCE}.service is already enabled`,
		},
		{
			name: 'the server unit has drop-ins',
			options: { files: new Map([[`/etc/systemd/system/dedalo-ts@${INSTANCE}.service.d/`, '']]) },
			sentence: 'already has drop-ins',
		},
		{
			name: 'the site file exists',
			options: { files: new Map([[`/etc/nginx/conf.d/dedalo-${INSTANCE}.conf`, 'server {}\n']]) },
			sentence: `/etc/nginx/conf.d/dedalo-${INSTANCE}.conf already exists`,
		},
		{
			name: 'the socket exists',
			options: { files: new Map([[`/run/dedalo-${INSTANCE}/dedalo_ts.sock`, '']]) },
			sentence: `the socket /run/dedalo-${INSTANCE}/dedalo_ts.sock already exists`,
		},
		{
			name: 'another site serves the address on our ports',
			options: {
				files: NGINX_PRESENT,
				responses: [
					{ match: '/usr/sbin/nginx -v', stderr: 'nginx version: nginx/1.26.3\n' },
					{
						match: '/usr/sbin/nginx -T',
						stdout: `# configuration file /etc/nginx/sites-enabled/museum.conf:\nserver {\n\tlisten 443 ssl;\n\tserver_name ${SERVER_NAME};\n}\n`,
					},
				],
			},
			sentence: `${SERVER_NAME} is already served on port 80/443 by /etc/nginx/sites-enabled/museum.conf`,
		},
		{
			name: 'a non-standard port held by another program',
			variant: HOST_VARIANTS.find(
				(variant) =>
					variant.os === 'ubuntu2604' && variant.web === 'nginx' && variant.tls === 'files',
			) as HostVariant,
			extra: { https_port: '8443' },
			options: {
				responses: [
					{
						match: '/usr/bin/ss -ltnpH',
						stdout: 'LISTEN 0 511 0.0.0.0:8443 0.0.0.0:* users:(("node",pid=812,fd=21))\n',
					},
				],
			},
			sentence: 'port 8443 is held by node',
		},
		{
			name: 'another PostgreSQL major on the database port (a second cluster would be made beside it)',
			variant: HOST_VARIANTS.find(
				(variant) =>
					variant.os === 'debian13' && variant.web === 'nginx' && variant.tls === 'letsencrypt',
			) as HostVariant,
			options: {
				files: new Map([['/usr/bin/pg_lsclusters', '']]),
				responses: [
					{
						match: '/usr/bin/pg_lsclusters --no-header',
						stdout:
							'16  main    5432 online postgres /var/lib/postgresql/16/main /var/log/postgresql/postgresql-16-main.log\n',
					},
				],
			},
			sentence: 'PostgreSQL 16 already runs on this host on port 5432',
		},
		{
			name: "another file defines the site's nginx upstream (global names: nginx -t would fail host-wide)",
			options: {
				files: NGINX_PRESENT,
				responses: [
					{ match: '/usr/sbin/nginx -v', stderr: 'nginx version: nginx/1.26.3\n' },
					{
						match: '/usr/sbin/nginx -T',
						stdout: `# configuration file /etc/nginx/conf.d/legacy.conf:\nupstream dedalo_${INSTANCE} { server 127.0.0.1:9; }\n`,
					},
				],
			},
			sentence: `nginx name dedalo_${INSTANCE} is already defined in /etc/nginx/conf.d/legacy.conf`,
		},
		{
			name: 'the web server configuration dump fails (an unread dump is no evidence of no clash)',
			options: {
				files: NGINX_PRESENT,
				responses: [
					{ match: '/usr/sbin/nginx -v', stderr: 'nginx version: nginx/1.26.3\n' },
					{ match: '/usr/sbin/nginx -T', exit: 1, stderr: 'nginx: [emerg] unknown directive' },
				],
			},
			sentence: '`nginx -T` (the configuration dump) failed (exit 1)',
		},
		{
			name: "EL Apache's site listing fails (`httpd -S`)",
			variant: HOST_VARIANTS.find(
				(variant) => variant.os === 'el10' && variant.web === 'apache' && variant.tls === 'files',
			) as HostVariant,
			options: {
				files: new Map([['/usr/sbin/apachectl', '']]),
				responses: [
					{ match: '/usr/sbin/httpd -v', stdout: 'Server version: Apache/2.4.63 (AlmaLinux)\n' },
					{ match: '/usr/sbin/httpd -S', exit: 1, stderr: 'AH00526: Syntax error' },
				],
			},
			sentence: '`/usr/sbin/httpd -S` failed (exit 1)',
		},
		{
			name: 'an instance directory already exists (never taken over: the answers may point at /var/www, /srv…)',
			options: { files: new Map([[`/srv/dedalo/${INSTANCE}/`, '']]) },
			sentence: `/srv/dedalo/${INSTANCE} already exists`,
		},
		{
			name: 'a media path whose web root is a foreign directory (/var/www)',
			extra: { media_path: '/var/www/dedalo/media' },
			options: { files: new Map([['/var/www/html/index.html', 'the default site\n']]) },
			sentence: '/var/www already exists',
		},
	];

	for (const clash of clashes) {
		test(`a clash — ${clash.name}: refused at the System check`, async () => {
			const message = await preflightRefusal(
				clash.variant ?? UBUNTU_NGINX_LE,
				clash.options,
				clash.extra ?? {},
			);
			expect(message).toContain(clash.sentence);
		});
	}

	// campaign 3b N3: Apache chosen on a host where a neighbouring instance's nginx serves
	// 80/443 passed the System check and planned `apt-get install apache2` — and the mirror.
	const listening = (process: string): string =>
		['80', '443']
			.map((port) => `LISTEN 0 511 0.0.0.0:${port} 0.0.0.0:* users:(("${process}",pid=812,fd=6))\n`)
			.join('');
	const NGINX_RUNNING = [
		{ match: '/usr/sbin/nginx -v', stderr: 'nginx version: nginx/1.26.3\n' },
		{ match: '/usr/sbin/nginx -T', stdout: '' },
		{ match: '/usr/bin/ss -ltnpH', stdout: listening('nginx') },
	];

	test('another web server: Apache chosen where nginx is installed and holds 80/443 — refused, naming nginx (N3)', async () => {
		const message = await preflightRefusal(DEBIAN_APACHE_LE, {
			files: NGINX_PRESENT,
			responses: NGINX_RUNNING,
		});
		expect(message).toContain('port 80 is held by nginx — this install configures apache');
		expect(message).toContain('port 443 is held by nginx');
		expect(message).toContain(
			'nginx is installed on this host and this run would install apache beside it',
		);
	});

	test('the mirror: nginx chosen where Apache is installed and holds 80/443 — refused, naming apache2 (N3)', async () => {
		const message = await preflightRefusal(UBUNTU_NGINX_LE, {
			files: new Map([['/usr/sbin/apachectl', '']]),
			responses: [{ match: '/usr/bin/ss -ltnpH', stdout: listening('apache2') }],
		});
		expect(message).toContain('port 80 is held by apache2 — this install configures nginx');
		expect(message).toContain(
			'apache is installed on this host and this run would install nginx beside it',
		);
	});

	test('control: nginx chosen, installed and holding 80/443 (another instance) is not refused (N3)', async () => {
		const { outcome } = await freshOn(UBUNTU_NGINX_LE, {
			files: NGINX_PRESENT,
			responses: NGINX_RUNNING,
		});
		expect(outcome.message ?? '').not.toContain('is held by');
		expect(outcome.result).toBe('complete');
	});

	test('the Review says it BEFORE `yes`: the other web server is on its to-do list (N3)', async () => {
		const { todo } = await todoOn(DEBIAN_APACHE_LE, {
			files: NGINX_PRESENT,
			responses: NGINX_RUNNING,
		});
		expect(todo.join('\n')).toContain('port 80 is held by nginx — this install configures apache');
		const clean = await todoOn(UBUNTU_NGINX_LE, { files: NGINX_PRESENT, responses: NGINX_RUNNING });
		expect(clean.todo.join('\n')).not.toContain('is held by');
	});

	test('a foreign template unit (another installer, an edited copy): refused, never overwritten', async () => {
		const foreign = '[Service]\nExecStart=/usr/local/bin/someone-else\n';
		const { host, outcome } = await freshOn(UBUNTU_NGINX_LE, {
			files: new Map([['/etc/systemd/system/dedalo-ts@.service', foreign]]),
		});
		expect(outcome.failedStep).toBe('host_units');
		expect(outcome.message).toContain('already exist(s) with other content');
		expect(readFileSync(join(host.root, '/etc/systemd/system/dedalo-ts@.service'), 'utf8')).toBe(
			foreign,
		);
	});

	const FILES_VARIANT = HOST_VARIANTS.find(
		(variant) => variant.os === 'ubuntu2604' && variant.web === 'nginx' && variant.tls === 'files',
	) as HostVariant;

	test("the institution's certificate EXPIRED: refused at the System check", async () => {
		const later = Date.now() + 400 * 24 * 3600 * 1000;
		const message = await preflightRefusal(FILES_VARIANT, {}, {}, () => later);
		expect(message).toContain(`${CERT_PATHS.cert}: the certificate expired on`);
	});

	test("the institution's certificate names ANOTHER address: refused", async () => {
		const other = mintCertificate('other.example.org');
		const message = await preflightRefusal(FILES_VARIANT, {
			files: new Map([
				[CERT_PATHS.cert, other.cert],
				[CERT_PATHS.key, other.key],
			]),
		});
		expect(message).toContain(`the certificate does not name ${SERVER_NAME}`);
	});

	test("the institution's key belongs to ANOTHER certificate: refused", async () => {
		const stranger = mintCertificate(SERVER_NAME);
		const message = await preflightRefusal(FILES_VARIANT, {
			files: new Map([[CERT_PATHS.key, stranger.key]]),
		});
		expect(message).toContain('the key does not belong to the certificate');
	});

	test("the institution's chain is NOT TRUSTED by this host: refused at the System check, naming the issuer (campaign 3 C3-13)", async () => {
		const unrelated = mintCertificate('some-other-ca.example.org');
		const message = await preflightRefusal(FILES_VARIANT, {
			files: new Map([[systemCaBundle(FILES_VARIANT.os), unrelated.cert]]),
		});
		expect(message).toContain(
			`${CERT_PATHS.cert}: its chain ends at CN=${SERVER_NAME}, which this machine does not trust`,
		);
		expect(message).toContain('update-ca-certificates');
	});

	test("the institution's VALID certificate passes (the refusals above are not vacuous)", async () => {
		const { outcome } = await freshOn(FILES_VARIANT);
		expect(outcome.result).toBe('complete');
	});
});

// ── the directory modes (the DIR_MODE_REGISTER's rule, for the host steps) ───

describe('every directory a production install creates has a deliberate mode (b)', () => {
	test("the instance's data is never world-readable; MEDIA_PATH at the media tree's mode; root's dirs are root's", () => {
		for (const variant of HOST_VARIANTS) {
			const ctx = productionPlanCtx(variant);
			const dirs = reviewCommands(ctx)
				.map(({ command }) => command)
				.filter((command): command is MkdirCommand => command.kind === 'mkdir');
			expect(dirs.length).toBeGreaterThan(15);
			for (const dir of dirs) {
				// Nothing world-writable, ever; nothing of the instance world-readable.
				expect(dir.mode & 0o002, dir.path).toBe(0);
				if (dir.owner === ctx.paths.user) expect(dir.mode & 0o007, dir.path).toBe(0);
				// A world-searchable dir is root's (the /opt runtime, the shared parents).
				if (dir.mode & 0o001) expect(`${dir.owner}:${dir.group}`, dir.path).toBe('root:root');
			}
			const mode = (path: string) => dirs.find((dir) => dir.path === path)?.mode;
			expect(mode(ctx.paths.media)).toBe(MEDIA_DIR_MODE);
			expect(mode(ctx.paths.privateDir)).toBe(0o700);
			expect(mode(ctx.paths.instanceDir)).toBe(0o750);
			expect(mode(ctx.paths.binDir)).toBe(0o755);
		}
	});
});

// ── the package lists come first (measured: the Debian 13 drill) ────────────

describe('apt: the package lists are fetched before anything is installed (a fresh host has none)', () => {
	test('every apt row: `apt-get update` precedes the first `apt-get install` (a repository setup package included)', () => {
		for (const variant of HOST_VARIANTS.filter((item) => osRowById(item.os).tool === 'apt')) {
			const ctx = productionPlanCtx(variant);
			const apt = reviewCommands(ctx)
				.map(({ command }) => command)
				.filter((command): command is HostCommand & { kind: 'exec' } => command.kind === 'exec')
				.map((command) => command.argv.join(' '))
				.filter((line) => line.startsWith('/usr/bin/apt-get '));
			expect(apt[0], variantName(variant)).toBe('/usr/bin/apt-get update');
			// Debian 13 adds PGDG: its lists are fetched again before the transaction.
			if (variant.os === 'debian13') {
				const install = apt.findIndex((line) => line.includes(' postgresql-18'));
				expect(apt[install - 1], variantName(variant)).toBe('/usr/bin/apt-get update');
			}
		}
	});
});

// ── the 2026-10-12 review: the web steps, the probes, the abort's own guarantees ──

const PG = osRowById('ubuntu2604').pgBinDir;
const PSQL_POSTGRES = `/usr/sbin/runuser -u postgres -- ${PG}/psql -X -q -A -t -v ON_ERROR_STOP=1 -h /var/run/postgresql -p 5432 -d postgres`;
const PUBLIC_HEALTH = `/usr/bin/curl -sS -o /dev/null -w %{http_code} --max-time 20 --resolve ${SERVER_NAME}:443:127.0.0.1 https://${SERVER_NAME}/health`;
const RULE_COPY = `/etc/nginx/dedalo/${INSTANCE}/media_protection.conf`;

/** The engine child failing its run (an abort is then a FULL one: nothing live). */
function engineFails(): RecordedResponse[] {
	const bun = `/opt/dedalo/bun/${BUN_PIN}/bun`;
	const child = `/usr/sbin/runuser -u ded_${INSTANCE} -g ded_${INSTANCE} -- /usr/bin/env HOME=/home/ded_${INSTANCE} ${bun} run /home/ded_${INSTANCE}/dedalo/scripts/install.ts`;
	const dying = `${asServiceHomeDying()} ${bun} run /home/ded_${INSTANCE}/dedalo/scripts/install.ts`;
	return [
		{ match: `${dying} --request-stdin`, exit: 9, stderr: 'the seed restore failed' },
		{
			match: `${child} --status --json`,
			after: `${dying} --request-stdin`,
			until: `${dying} --abort`,
			stdout:
				'{"exists":true,"outcome":"in_progress","failed_step":"install_db_from_default_file"}\n',
		},
	];
}

describe('the web steps never leave the host half-configured (review)', () => {
	test('a failed configuration test at host_web_site: the site goes back to stage 1; an abort removes every web file and the group membership', async () => {
		const { host, plan, outcome } = await freshOn(UBUNTU_NGINX_LE, {
			responses: [
				{
					match: '/usr/sbin/nginx -t',
					whenPath: RULE_COPY,
					exit: 1,
					stderr: `nginx: [emerg] duplicate upstream "dedalo_${INSTANCE}"`,
				},
			],
		});
		expect(outcome.failedStep).toBe('host_web_site');
		const ctx = frozenContext(host);
		const site = `/etc/nginx/conf.d/dedalo-${INSTANCE}.conf`;
		// The host's nginx is left with the configuration it accepted (stage 1), never the refused one.
		expect(readFileSync(join(host.root, site), 'utf8')).toBe(siteText(ctx, null));
		const abort = await runHost(host, laterRequest('abort', plan));
		expect(abort.outcome.message).toBeNull();
		expect(abort.outcome.result).toBe('aborted');
		for (const path of [
			site,
			RULE_COPY,
			`/etc/nginx/dedalo/${INSTANCE}/media_protection_map.conf`,
			`/etc/nginx/dedalo/${INSTANCE}`,
		])
			expect(() => statSync(join(host.root, path)), path).toThrow();
		expect(loggedCommands(host.root)).toContain(`/usr/bin/gpasswd -d www-data ded_${INSTANCE}`);
	});

	test("Apache: a failed module listing is refused as what it is — never read as 'modules missing'", async () => {
		const { outcome } = await freshOn(DEBIAN_APACHE_LE, {
			responses: [{ match: '/usr/sbin/apache2ctl -M', exit: 1, stderr: 'AH00526: Syntax error' }],
		});
		expect(outcome.failedStep).toBe('host_web_http');
		expect(outcome.message).toContain("listing Apache's modules failed");
		expect(outcome.message).not.toContain('lacks the modules');
	});

	test('the site includes only ROOT-OWNED copies of the media rules, never a file under MEDIA_PATH', () => {
		const ctx = productionPlanCtx(UBUNTU_NGINX_LE);
		const includes = [
			...siteText(ctx, certificatePaths(ctx)).matchAll(/^\s*include\s+(\S+);/gm),
		].map((m) => m[1] as string);
		expect(includes).toEqual([RULE_COPY]);
		expect(includes.filter((path) => path.startsWith(ctx.paths.media))).toEqual([]);
		const apache = productionPlanCtx(DEBIAN_APACHE_LE);
		const vhost = siteText(apache, certificatePaths(apache));
		expect(vhost).not.toMatch(/AllowOverride\s+All/);
		// Merged after every .htaccess: the instance's file can never switch CGI on.
		expect(vhost).toMatch(
			/<Location "\/dedalo\/media\/">\s*Options -Indexes -ExecCGI\s*<\/Location>/,
		);
	});
});

describe('the public address is polled while the reload settles (review)', () => {
	test('it answers on the 4th probe: the install completes', async () => {
		const { host, outcome } = await freshOn(UBUNTU_NGINX_LE, {
			responses: [
				{ match: PUBLIC_HEALTH, afterCount: 3, stdout: '200' },
				{ match: PUBLIC_HEALTH, stdout: '000' },
			],
		});
		expect(outcome.message).toBeNull();
		expect(outcome.result).toBe('complete');
		expect(loggedCommands(host.root).filter((line) => line === PUBLIC_HEALTH).length).toBe(4);
	});

	test('it never answers: refused after the bound, the probe file removed', async () => {
		let clock = Date.now();
		const { host, outcome } = await freshOn(
			UBUNTU_NGINX_LE,
			{ responses: [{ match: PUBLIC_HEALTH, stdout: '000' }] },
			{},
			() => {
				clock += 5_000;
				return clock;
			},
		);
		expect(outcome.failedStep).toBe('host_public_probe');
		expect(outcome.message).toContain('/health through the public address: expected 200, got 000');
		const log = loggedCommands(host.root);
		expect(log.filter((line) => line === PUBLIC_HEALTH).length).toBeGreaterThan(3);
		// The probe file: written and removed by the instance user, never by root through a path.
		const probe = `/srv/dedalo/${INSTANCE}/dedalo/media/image/thumb/dd_install_probe_dd0_0.jpg`;
		expect(log).toContain(
			`/usr/sbin/runuser -u ded_${INSTANCE} -g ded_${INSTANCE} -- /usr/bin/install -D -m 0640 /dev/null ${probe}`,
		);
		expect(log).toContain(
			`/usr/sbin/runuser -u ded_${INSTANCE} -g ded_${INSTANCE} -- /usr/bin/rm -f ${probe}`,
		);
	});
});

/** The Review the operator sees for `variant` on a planted host (the scratch seam armed). */
async function reviewOn(host: ScratchHost, plan: ReturnType<typeof productionPlan>['plan']) {
	const previous = process.env.DEDALO_INSTALL_HOST_ROOT;
	process.env.DEDALO_INSTALL_HOST_ROOT = host.root;
	try {
		return await reviewHostCommands(plan);
	} finally {
		if (previous === undefined) delete process.env.DEDALO_INSTALL_HOST_ROOT;
		else process.env.DEDALO_INSTALL_HOST_ROOT = previous;
	}
}

/** The package default-site note of a run that installs nginx (campaign 3e E5 — its own gate). */
const PLANNED_DEFAULT =
	/^port 80: the default site stays yours \(\/etc\/nginx\/sites-enabled\/default,/;

/**
 * The Review's to-do lines ([] when it has no to-do block) — `todo` without the
 * nginx package's default-site note (asserted by the E5 gate: `allTodo`).
 */
async function todoOn(
	variant: HostVariant,
	options: PlantOptions,
	extra: Record<string, unknown> = {},
) {
	const host = scratchHost(variant, options);
	const { plan } = productionPlan(variant, extra);
	const blocks = await reviewOn(host, plan);
	const allTodo = blocks.find((block) => block.step === REVIEW_TODO_STEP)?.commands ?? [];
	return {
		host,
		blocks,
		allTodo,
		todo: allTodo.filter((line) => !PLANNED_DEFAULT.test(line)),
	};
}

const FIREWALLD = (services: string, ports = ''): RecordedResponse[] => [
	{ match: '/usr/bin/systemctl is-active firewalld', stdout: 'active\n' },
	{ match: '/usr/bin/firewall-cmd --get-default-zone', stdout: 'public\n' },
	{ match: '/usr/bin/firewall-cmd --zone=public --list-services', stdout: `${services}\n` },
	{ match: '/usr/bin/firewall-cmd --zone=public --list-ports', stdout: `${ports}\n` },
];

const UFW = (rules: string): { files: Map<string, string>; responses: RecordedResponse[] } => ({
	files: new Map([['/usr/sbin/ufw', '']]),
	responses: [
		{
			match: '/usr/sbin/ufw status',
			stdout: `Status: active\n\nTo                         Action      From\n--                         ------      ----\n22/tcp                     ALLOW       Anywhere\n${rules}`,
		},
	],
});

describe('what the operator must do is on the Review BEFORE the install (campaign 3)', () => {
	const OPEN_80_443 =
		'firewall-cmd --permanent --add-service=http --add-service=https && firewall-cmd --reload';

	test('firewalld without http/https: the Review to-do and the run tell the exact command (C3-6)', async () => {
		const { todo } = await todoOn(UBUNTU_NGINX_LE, {
			responses: FIREWALLD('cockpit dhcpv6-client ssh'),
		});
		expect(todo.join('\n')).toContain(OPEN_80_443);
		expect(todo.join('\n')).toContain(
			'firewalld (default zone public) does not allow port 80 and 443',
		);
		const { outcome } = await freshOn(UBUNTU_NGINX_LE, {
			responses: FIREWALLD('cockpit dhcpv6-client ssh'),
		});
		expect(outcome.result).toBe('complete');
		// The closing To-do carries it (told — never run).
		expect(outcome.told.join('\n')).toContain(OPEN_80_443);
	});

	test('firewalld with http and https (or the ports): no to-do, the run says they are allowed', async () => {
		for (const [services, ports] of [
			['ssh http https', ''],
			['ssh', '80/tcp 443/tcp'],
			['ssh http', '400-500/tcp'],
		] as const) {
			const { todo } = await todoOn(UBUNTU_NGINX_LE, { responses: FIREWALLD(services, ports) });
			expect(todo, `${services} | ${ports}`).toEqual([]);
		}
		// Nothing to do: said once on the preflight's own line, never under To do (campaign 3c D16).
		const host = scratchHost(UBUNTU_NGINX_LE, { responses: FIREWALLD('ssh http https') });
		const { planFile } = productionPlan(UBUNTU_NGINX_LE);
		const { outcome, transcript } = await runHost(host, freshRequest(planFile));
		expect(outcome.result).toBe('complete');
		expect(transcript.lines.join('\n')).toContain(
			'firewall (checked, not changed): firewalld (default zone public) allows port 80 and 443',
		);
		expect(outcome.told.join('\n')).not.toContain('firewall');
	});

	test('ufw active and allowing 80/443: not under To do; ufw closed: told with its command (campaign 3c D16)', async () => {
		const open = UFW('80,443/tcp                 ALLOW       Anywhere\n');
		const allowed = await runHost(
			scratchHost(UBUNTU_NGINX_LE, open),
			freshRequest(productionPlan(UBUNTU_NGINX_LE).planFile),
		);
		expect(allowed.outcome.result).toBe('complete');
		expect(allowed.outcome.told.join('\n')).not.toContain('firewall');
		expect(allowed.transcript.lines.join('\n')).toContain('ufw (active) allows port 80 and 443');
		// CONTROL: closed — the closing To-do carries the command.
		const closed = await runHost(
			scratchHost(UBUNTU_NGINX_LE, UFW('')),
			freshRequest(productionPlan(UBUNTU_NGINX_LE).planFile),
		);
		expect(closed.outcome.result).toBe('complete');
		expect(closed.outcome.told.join('\n')).toContain('ufw allow 80,443/tcp');
	});

	test('only https missing: only https is opened', async () => {
		const { todo } = await todoOn(UBUNTU_NGINX_LE, { responses: FIREWALLD('ssh http') });
		expect(todo.join('\n')).toContain(
			'firewall-cmd --permanent --add-service=https && firewall-cmd --reload',
		);
		expect(todo.join('\n')).not.toContain('--add-service=http ');
	});

	test('ufw active without 80/443: `ufw allow 80,443/tcp`; with a web profile or the ports: nothing to do', async () => {
		const closed = await todoOn(UBUNTU_NGINX_LE, UFW(''));
		expect(closed.todo.join('\n')).toContain('ufw allow 80,443/tcp');
		for (const rules of [
			'Nginx Full                 ALLOW       Anywhere\n',
			'80,443/tcp                 ALLOW       Anywhere\n80,443/tcp (v6)            ALLOW       Anywhere (v6)\n',
			'80/tcp                     ALLOW       Anywhere\n443                        ALLOW       Anywhere\n',
		]) {
			expect((await todoOn(UBUNTU_NGINX_LE, UFW(rules))).todo, rules).toEqual([]);
		}
		// A DENY rule opens nothing.
		const denied = await todoOn(
			UBUNTU_NGINX_LE,
			UFW('80,443/tcp                 DENY        Anywhere\n'),
		);
		expect(denied.todo.join('\n')).toContain('ufw allow 80,443/tcp');
	});

	test('Debian, Apache chosen and not installed yet: the a2enmod line is on the Review and told by the preflight (C3-34)', async () => {
		const command =
			'a2enmod ssl headers http2 rewrite proxy proxy_http && systemctl restart apache2';
		const { todo } = await todoOn(DEBIAN_APACHE_LE, {});
		expect(todo.join('\n')).toContain(command);
		expect(todo.join('\n')).toContain('this run installs Apache');
		const { outcome } = await freshOn(DEBIAN_APACHE_LE);
		expect(outcome.told.join('\n')).toContain(command);
		// The RHEL family's httpd + mod_ssl + mod_http2 load them all: nothing to do.
		const el = HOST_VARIANTS.find((v) => v.os === 'el10' && v.web === 'apache') as HostVariant;
		expect((await todoOn(el, {})).todo).toEqual([]);
		// nginx: never.
		expect((await todoOn(UBUNTU_NGINX_LE, {})).todo).toEqual([]);
	});

	test("the institution's certificate expires in 10 days: the warning is on the Review and in the System check (C3-56)", async () => {
		const FILES = HOST_VARIANTS.find(
			(v) => v.os === 'ubuntu2604' && v.web === 'nginx' && v.tls === 'files',
		) as HostVariant;
		const soon = mintCertificate(SERVER_NAME, 10);
		const files = new Map([
			[CERT_PATHS.cert, soon.cert],
			[CERT_PATHS.key, soon.key],
			[systemCaBundle(FILES.os), soon.cert],
		]);
		const { todo } = await todoOn(FILES, { files });
		expect(todo.join('\n')).toMatch(
			/certificate \/etc\/ssl\/demo\/fullchain\.pem: the certificate expires on \S+ \(under 30 days\)/,
		);
		const host = scratchHost(FILES, { files });
		const { planFile } = productionPlan(FILES);
		const { outcome, transcript } = await runHost(host, freshRequest(planFile));
		expect(outcome.result).toBe('complete');
		expect(transcript.lines.join('\n')).toContain('(under 30 days)');
		// A certificate with a year left: nothing on the Review.
		expect((await todoOn(FILES, {})).todo).toEqual([]);
	});

	test('a second instance of the same pin: the byte-identical runtime is NOT reinstalled (C3-57)', async () => {
		const bun = `/opt/dedalo/bun/${BUN_PIN}/bun`;
		const identical = await freshOn(UBUNTU_NGINX_LE, {
			responses: [
				{ match: '/usr/bin/cmp -s', exit: 0 },
				{ match: `${bun} --version`, stdout: `${BUN_PIN}\n` },
			],
		});
		expect(identical.outcome.result).toBe('complete');
		const log = loggedCommands(identical.host.root);
		expect(log).toContain(
			`/usr/bin/cmp -s /var/lib/dedalo-install/bun/${BUN_PIN}/extract/bun-linux-x64/bun ${bun}`,
		);
		expect(log.filter((line) => line.startsWith('/usr/bin/install -D -m 0755'))).toEqual([]);
		// A different (or absent) runtime IS installed — the skip is not vacuous.
		const fresh = await freshOn(UBUNTU_NGINX_LE);
		expect(
			loggedCommands(fresh.host.root).filter((line) =>
				line.startsWith('/usr/bin/install -D -m 0755'),
			),
		).toHaveLength(1);
	});

	test('a second instance: the shared directories that exist are marked "exists, not created" (C3-57)', async () => {
		const host = scratchHost(UBUNTU_NGINX_LE, {
			files: new Map([
				['/srv/dedalo/', ''],
				['/opt/dedalo/', ''],
			]),
		});
		const { plan } = productionPlan(UBUNTU_NGINX_LE);
		const blocks = await reviewOn(host, plan);
		const labels = blocks.map((block) => block.label).join('\n');
		expect(labels).toContain('exists, not created: ');
		expect(labels).toMatch(/exists, not created: [^\n]*\/srv\/dedalo(,|$)/m);
		const fresh = await reviewOn(scratchHost(UBUNTU_NGINX_LE), plan);
		// A fresh host: only what really exists there (the bootstrap's Bun cache) is marked.
		expect(fresh.map((block) => block.label).join('\n')).not.toMatch(
			/exists, not created: [^\n]*\/(srv|opt)\/dedalo(,|$)/m,
		);
		// campaign 3b N26: the mkdir line of an existing directory says so ITSELF — never a
		// header "exists" above a bare `mkdir` of the same path.
		const lines = (review: typeof blocks): string[] => review.flatMap((block) => block.commands);
		const bare = (review: typeof blocks, path: string): string[] =>
			lines(review).filter(
				(line) => line.startsWith(`mkdir ${path} (`) && !line.endsWith(EXISTS_NOT_CREATED),
			);
		expect(lines(blocks).filter((line) => line.startsWith('mkdir /srv/dedalo (')).length).toBe(1);
		expect(bare(blocks, '/srv/dedalo')).toEqual([]);
		expect(bare(blocks, '/opt/dedalo')).toEqual([]);
		// …and the bootstrap's Bun cache on a fresh host (the measured N26 case)
		const cache = `/var/lib/dedalo-install/bun/${BUN_PIN}`;
		expect(lines(fresh).some((line) => line.startsWith(`mkdir ${cache} (`))).toBe(true);
		expect(bare(fresh, cache)).toEqual([]);
		// a directory that does not exist keeps its plain mkdir line (not vacuous)
		expect(bare(fresh, '/srv/dedalo')).toHaveLength(1);
	});
});

describe("the instance's database is its role's alone (campaign 3 C3-62)", () => {
	test('PUBLIC loses CONNECT and TEMPORARY right after CREATE DATABASE; the role keeps them', () => {
		const ctx = productionPlanCtx(UBUNTU_NGINX_LE);
		const stdin = databaseCommands(ctx).map((command) =>
			command.stdin !== undefined && 'text' in command.stdin ? command.stdin.text : '',
		);
		const create = stdin.findIndex((text) => text.startsWith('CREATE DATABASE'));
		expect(create).toBeGreaterThan(-1);
		expect(stdin[create + 1]).toBe(
			`REVOKE CONNECT, TEMPORARY ON DATABASE "dedalo_${INSTANCE}" FROM PUBLIC;\nGRANT CONNECT, TEMPORARY ON DATABASE "dedalo_${INSTANCE}" TO "ded_${INSTANCE}";\n`,
		);
		// --db-mode existing: nothing is created, nothing revoked.
		expect(
			databaseCommands(productionPlanCtx(UBUNTU_NGINX_LE, REPO_ROOT, { db_mode: 'existing' })),
		).toEqual([]);
	});

	test('PUBLIC can still connect: host_database does not verify', async () => {
		const { outcome } = await freshOn(UBUNTU_NGINX_LE, {
			responses: [
				{
					match:
						'/usr/sbin/runuser -u postgres -- /usr/lib/postgresql/18/bin/psql -X -q -A -t -v ON_ERROR_STOP=1 -h /var/run/postgresql -p 5432 -d postgres -c SELECT has_database_privilege(',
					stdout: 't\n',
				},
			],
		});
		expect(outcome.failedStep).toBe('host_database');
		expect(outcome.message).toContain(`PUBLIC may still connect to dedalo_${INSTANCE}`);
	});
});

describe('the release from a CHECKOUT the operator owns (campaign 3 C3-7)', () => {
	/** A fresh run whose source is a git checkout (the operator's clone). */
	async function fromCheckout(responses: RecordedResponse[] = []) {
		const host = scratchHost(UBUNTU_NGINX_LE, { responses });
		mkdirSync(join(host.source, '.git'));
		const { planFile } = productionPlan(UBUNTU_NGINX_LE);
		return { host, outcome: (await runHost(host, freshRequest(planFile))).outcome };
	}

	test('git archive names THAT checkout safe for this one command (never the global config), fsmonitor off', async () => {
		const { host, outcome } = await fromCheckout();
		expect(outcome.result).toBe('complete');
		const archive = loggedCommands(host.root).filter((line) => line.includes(' archive '));
		expect(archive).toEqual([
			`/usr/bin/git -c safe.directory=${host.source} -c core.fsmonitor=false -C ${host.source} archive --format=tar -o /var/lib/dedalo-install/release-${INSTANCE}/release.tar HEAD`,
		]);
		expect(loggedCommands(host.root).filter((line) => line.includes('--global'))).toEqual([]);
	});

	test("the release is extracted without re-moding the 0750 tree (the archive's `./` entry: --no-overwrite-dir)", async () => {
		// A release tree (not a checkout) is archived with its `./` entry, whose mode GNU tar
		// would otherwise give the existing 0750 tree (campaign 3, the hand-install runs).
		const { host, outcome } = await freshOn(UBUNTU_NGINX_LE);
		expect(outcome.result).toBe('complete');
		const extract = loggedCommands(host.root).filter((line) => line.includes('/usr/bin/tar -xf'));
		expect(extract).toHaveLength(1);
		expect(extract[0]).toContain(' --no-overwrite-dir');
	});

	test("a git refusal shows git's `fatal:` line, not only its trailing hint", async () => {
		const { outcome } = await fromCheckout([
			{
				match: '/usr/bin/git ',
				exit: 128,
				stderr: [
					"fatal: detected dubious ownership in repository at '/home/op/dedalo'",
					'To add an exception for this directory, call:',
					'',
					'\tgit config --global --add safe.directory /home/op/dedalo',
				].join('\n'),
			},
		]);
		expect(outcome.failedStep).toBe('host_runtime');
		expect(outcome.message).toContain(
			"archive the source tree (HEAD) failed (exit 128): fatal: detected dubious ownership in repository at '/home/op/dedalo' … git config --global --add safe.directory /home/op/dedalo",
		);
	});
});

describe('a failed public probe says WHY (campaign 3 C3-13)', () => {
	test('curl exit 60 (the chain is not trusted by this host): the sentence names it and how to trust the CA', async () => {
		let clock = Date.now();
		const { outcome } = await freshOn(
			UBUNTU_NGINX_LE,
			{
				responses: [
					{
						match: PUBLIC_HEALTH,
						exit: 60,
						stdout: '000',
						stderr:
							'curl: (60) SSL certificate problem: self-signed certificate in certificate chain',
					},
				],
			},
			{},
			() => {
				clock += 5_000;
				return clock;
			},
		);
		expect(outcome.failedStep).toBe('host_public_probe');
		expect(outcome.message).toContain(
			'expected 200, got 000 — the certificate chain is not trusted by this host',
		);
		expect(outcome.message).toContain('update-ca-certificates');
		expect(outcome.message).toContain('update-ca-trust');
		expect(outcome.message).toContain('(curl: (60) SSL certificate problem');
	});

	test("a failed configuration test quotes nginx's [emerg] line, not only its closing `test failed`", async () => {
		const { outcome } = await freshOn(UBUNTU_NGINX_LE, {
			responses: [
				{
					match: '/usr/sbin/nginx -t',
					exit: 1,
					stderr: [
						'nginx: [emerg] a duplicate default server for 0.0.0.0:80 in /etc/nginx/sites-enabled/default:22',
						'nginx: configuration file /etc/nginx/nginx.conf test failed',
					].join('\n'),
				},
			],
		});
		expect(outcome.message).toContain(
			'test the nginx configuration failed (exit 1): nginx: [emerg] a duplicate default server for 0.0.0.0:80 in /etc/nginx/sites-enabled/default:22 … nginx: configuration file /etc/nginx/nginx.conf test failed',
		);
	});

	test('curl exit 7 (nothing listens): the web server is named, not a TLS problem', async () => {
		let clock = Date.now();
		const { outcome } = await freshOn(
			UBUNTU_NGINX_LE,
			{ responses: [{ match: PUBLIC_HEALTH, exit: 7, stdout: '000' }] },
			{},
			() => {
				clock += 5_000;
				return clock;
			},
		);
		expect(outcome.message).toContain('nothing answers on that port (is nginx running?');
		expect(outcome.message).not.toContain('not trusted');
	});
});

describe("a Let's Encrypt STAGING install completes (the probe cannot verify a test chain)", () => {
	const STAGING_HEALTH = `/usr/bin/curl -sS -o /dev/null -w %{http_code} --max-time 20 --resolve ${SERVER_NAME}:443:127.0.0.1 --insecure https://${SERVER_NAME}/health`;

	test('staging: every public probe skips chain verification, the install completes and says so', async () => {
		const { host, outcome } = await freshOn(
			UBUNTU_NGINX_LE,
			{ responses: [{ match: STAGING_HEALTH, stdout: '200' }] },
			{ letsencrypt_staging: true },
		);
		expect(outcome.message).toBeNull();
		expect(outcome.result).toBe('complete');
		const probes = loggedCommands(host.root).filter((line) =>
			line.includes('--max-time 20 --resolve'),
		);
		expect(probes.length).toBeGreaterThanOrEqual(3);
		for (const line of probes) expect(line).toContain(' --insecure ');
	});

	test('a real certificate: no probe ever skips chain verification', async () => {
		const { host, outcome } = await freshOn(UBUNTU_NGINX_LE);
		expect(outcome.result).toBe('complete');
		const probes = loggedCommands(host.root).filter((line) =>
			line.includes('--max-time 20 --resolve'),
		);
		expect(probes.length).toBeGreaterThanOrEqual(3);
		for (const line of probes) expect(line).not.toContain('--insecure');
	});
});

describe('a unit that REFUSED to boot stops the first-boot wait at once (phase 5)', () => {
	const SOCKET_HEALTH = '/usr/bin/curl -s -o /dev/null -w %{http_code} --max-time 10 --unix-socket';
	const show = (property: string) =>
		`/usr/bin/systemctl show -p ${property} --value dedalo-ts@${INSTANCE}.service`;

	test('the refusal exit is the engine one (not imported by the root-run step — held equal here)', () => {
		expect(REFUSED_BOOT_EXIT).toBe(NOT_INSTALLED_EXIT_CODE);
	});

	test('exit 78 (`failed`, never restarted): refused on the first poll, naming the unit and the journal', async () => {
		let clock = Date.now();
		const { host, outcome } = await freshOn(
			UBUNTU_NGINX_LE,
			{
				responses: [
					{ match: SOCKET_HEALTH, exit: 7, stdout: '000' },
					{ match: show('Result'), stdout: 'exit-code\n' },
					{ match: show('ExecMainStatus'), stdout: '78\n' },
				],
			},
			{},
			() => {
				clock += 5_000;
				return clock;
			},
		);
		expect(outcome.failedStep).toBe('host_first_boot');
		// Past the engine steps (campaign 3e E3): the ✖ hint names the salt's read command, never the value.
		const hint = outcome.hint.join('\n');
		expect(hint).toContain('(DEDALO_SALT_STRING)');
		expect(hint).toContain('read it with: sudo grep ^DEDALO_SALT_STRING=');
		expect(hint).not.toContain('scratch-salt-value');
		expect(outcome.message).toContain(`dedalo-ts@${INSTANCE}.service refused to boot (exit 78`);
		expect(outcome.message).toContain(`journalctl -u dedalo-ts@${INSTANCE}.service`);
		// One poll, not the whole bound.
		expect(loggedCommands(host.root).filter((line) => line.startsWith(SOCKET_HEALTH)).length).toBe(
			1,
		);
	});

	test('another failure exit is NOT read as a refusal: the wait runs to its bound (the check is not vacuous)', async () => {
		let clock = Date.now();
		const { host, outcome } = await freshOn(
			UBUNTU_NGINX_LE,
			{
				responses: [
					{ match: SOCKET_HEALTH, exit: 7, stdout: '000' },
					{ match: show('Result'), stdout: 'exit-code\n' },
					{ match: show('ExecMainStatus'), stdout: '1\n' },
				],
			},
			{},
			() => {
				clock += 60_000;
				return clock;
			},
		);
		expect(outcome.failedStep).toBe('host_first_boot');
		expect(outcome.message).not.toContain('refused to boot');
		expect(outcome.message).toContain('not reached after');
		expect(
			loggedCommands(host.root).filter((line) => line.startsWith(SOCKET_HEALTH)).length,
		).toBeGreaterThan(1);
	});
});

describe('an abort undoes only what it measured as created (review)', () => {
	test('PostgreSQL unknowable at the System check: the existing role is measured before the CREATE and never dropped', async () => {
		const { host, plan, outcome } = await freshOn(UBUNTU_NGINX_LE, {
			responses: [
				{ match: `/usr/sbin/runuser -u postgres -- ${PG}/psql -XAtq`, stdout: '' },
				{ match: `${PSQL_POSTGRES} -c SELECT 1 / count(*) FROM pg_roles`, stdout: '1\n' },
				...engineFails(),
			],
		});
		expect(outcome.failedStep).toBe('host_engine');
		const state = readStateFile(join(host.root, RUN_DIR));
		expect(state?.preflight.host?.facts.roleExists).toBeNull();
		expect(state?.created.host?.pg_role).toBe(false);
		expect(state?.created.host?.pg_database).toBe(true);
		expect(stdinRuns(host, PSQL_POSTGRES)).toBe(2); // CREATE DATABASE (+ its REVOKE) only
		const aborted = await runHost(host, laterRequest('abort', plan, DB));
		expect(aborted.outcome.result).toBe('aborted');
		expect(stdinRuns(host, PSQL_POSTGRES)).toBe(3); // + DROP DATABASE — never DROP ROLE
		expect(aborted.transcript.lines.join('\n')).toContain(`dropped ${DB}`);
		expect(aborted.transcript.lines.join('\n')).not.toContain(`ded_${INSTANCE} and`);
	});

	test('PostgreSQL not answering whether the role exists: refused, nothing created', async () => {
		const { outcome } = await freshOn(UBUNTU_NGINX_LE, {
			responses: [
				{ match: `/usr/sbin/runuser -u postgres -- ${PG}/psql -XAtq`, stdout: '' },
				{ match: `${PSQL_POSTGRES} -c SELECT 1 / count(*) FROM pg_roles`, exit: 2 },
			],
		});
		expect(outcome.failedStep).toBe('host_database');
		expect(outcome.message).toContain('PostgreSQL did not answer whether');
	});

	test("templates an earlier (aborted) instance wrote: the last instance's abort removes them — the registry decides, not the writer", async () => {
		const row = osRowById(UBUNTU_NGINX_LE.os);
		const templates = new Map(
			UNIT_TEMPLATES.map((name) => [
				`/etc/systemd/system/${name}`,
				renderTemplate(name, row, REPO_ROOT),
			]),
		);
		const host = scratchHost(UBUNTU_NGINX_LE, { files: templates });
		const { plan, planFile } = productionPlan(UBUNTU_NGINX_LE);
		expect((await runHost(host, freshRequest(planFile))).outcome.result).toBe('complete');
		expect(readStateFile(join(host.root, RUN_DIR))?.created.host?.units).toEqual([]);
		const abort = await runHost(host, laterRequest('abort', plan));
		expect(abort.outcome.result).toBe('aborted');
		for (const path of templates.keys())
			expect(() => statSync(join(host.root, path)), path).toThrow();
	});
});

describe('Done says what the route did (review)', () => {
	const outcome = (result: 'complete' | 'aborted') => ({
		exitCode: 0,
		result,
		message: null,
		failedStep: null,
		hint: [],
	});
	const summary = (
		route: RunEnding['route'],
		result: 'complete' | 'aborted',
		keptLive = false,
		undone: readonly string[] = [],
	) =>
		doneSummary({
			kind: 'run',
			outcome: outcome(result),
			mode: result === 'aborted' ? 'abort' : 'fresh',
			rootVerified: false,
			shownOnce: [],
			ending: { route, instance: INSTANCE, keptLive, undone },
		});

	test('production: the instance unit is already running — never the single-instance unit hint', () => {
		const text = summary('production', 'complete');
		expect(text).toContain(`dedalo-ts@${INSTANCE} is running under systemd`);
		expect(text).not.toContain('systemctl enable --now dedalo-ts');
	});

	test('docker and trial: the stack is up; the engine-only run keeps its supervisor sentence', () => {
		for (const route of ['docker', 'trial'] as const) {
			expect(summary(route, 'complete')).toContain('The stack is up under Docker');
			expect(summary(route, 'complete')).not.toContain('systemctl enable --now dedalo-ts');
			// The compose command the operator copies carries the stack's THREE files
			// (without them compose resolves its built-in defaults, not this install's).
			const stack = stackFileOf({ route } as InstallAnswers);
			expect(summary(route, 'complete')).toContain(
				`docker compose -f ${stack} -f compose.override.yaml --env-file .dedalo.env ps`,
			);
		}
		// The developer route: its own launchers, never the manual host's unit as the path.
		expect(summary('engine', 'complete')).toContain('bun run start:supervised');
		expect(summary('engine', 'complete')).toContain('docs/install/dev_quickstart.md');
		expect(summary('engine', 'complete')).not.toContain('systemctl enable --now dedalo-ts');
	});

	test('a host abort says what it ACTUALLY undid (C3-50), in the route’s words (C3-52) — or that the live instance was kept', () => {
		const undone = ['host_database', 'host_identity'];
		expect(summary('production', 'aborted', false, undone)).toContain('2 steps undone');
		expect(summary('production', 'aborted', false, undone)).toContain('installed packages');
		expect(summary('production', 'aborted', false, undone)).not.toContain(
			'the database itself is kept',
		);
		expect(summary('docker', 'aborted', false, ['stack_database'])).toContain('1 step undone');
		expect(summary('docker', 'aborted', false, ['stack_database'])).toContain('images are kept');
		// Nothing undone: never the "removed: its site, units, user…" sentence.
		const nothing = summary('production', 'aborted');
		expect(nothing).toContain('nothing was undone');
		expect(nothing).not.toMatch(/removed: its site|steps? undone/);
		// A live instance: kept, in the route's words — never the production account on docker.
		expect(summary('production', 'aborted', true, ['host_units'])).toContain(
			'its user, database and code are kept',
		);
		expect(summary('trial', 'aborted', true, ['stack_up'])).toContain(
			'its containers and volumes (the database) are kept',
		);
		expect(summary('trial', 'aborted', true, ['stack_up'])).not.toContain('its user');
		expect(summary('production', 'aborted', true)).toContain('nothing was undone');
	});

	test('an --engine-only run (the by-hand host procedure) ends with the systemd pointer only (C3-54)', () => {
		const text = summary('engine_only', 'complete');
		expect(text).toContain('manual_install.md#manual-host_units');
		expect(text).not.toContain('bun run dev');
		expect(summary('engine', 'complete')).toContain('bun run dev');
	});
});

// ── campaign 3 (2026-10-13): abort / resume / undo semantics and the engine child ──

const ENGINE_BUN = `/opt/dedalo/bun/${BUN_PIN}/bun`;
const ENGINE_STATUS = `/usr/sbin/runuser -u ded_${INSTANCE} -g ded_${INSTANCE} -- /usr/bin/env HOME=/home/ded_${INSTANCE} ${ENGINE_BUN} run /home/ded_${INSTANCE}/dedalo/scripts/install.ts --status --json`;
const ENGINE_DYING = `${asServiceHomeDying()} ${ENGINE_BUN} run /home/ded_${INSTANCE}/dedalo/scripts/install.ts`;
const ENABLE_UNIT = `/usr/bin/systemctl enable dedalo-ts@${INSTANCE}.service`;

/** The executor seams of a scratch host (what runHost passes), for the exported entry points. */
function hostOptions(host: ScratchHost): HostExecutorOptions {
	const marker = join(host.root, SCRATCH_DIR);
	return {
		runner: scratchRunner(marker),
		fs: hostFs(host.root, join(marker, 'owners.json')),
		source: host.source,
		skipPrivilegeCheck: true,
		sleep: async () => {},
	};
}

describe('an instance is LIVE once it could have served — before that, --abort removes it whole (C3-11)', () => {
	test('a failure after the engine sealed but before the first start: the hint offers the full undo; the abort takes the engine install apart too (attested unserved) and leaves no user, database or record', async () => {
		const { host, plan, outcome } = await freshOn(UBUNTU_NGINX_LE, {
			responses: [{ match: ENABLE_UNIT, exit: 1, stderr: 'Failed to enable unit' }],
		});
		expect(outcome.failedStep).toBe('host_units');
		// The hint is true to what --abort will do: the full undo, the database named.
		expect(outcome.hint.join('\n')).toContain(`--abort --confirm-database ${DB}`);
		expect(outcome.hint.join('\n')).toContain('deletes the database this install created');
		const aborted = await runHost(host, laterRequest('abort', plan, DB));
		expect(aborted.outcome.message).toBeNull();
		expect(aborted.outcome.result).toBe('aborted');
		expect(aborted.outcome.keptLive).toBe(false);
		expect(aborted.outcome.undone).toContain('host_engine');
		expect(aborted.outcome.undone).toContain('host_identity');
		const log = loggedCommands(host.root);
		// The engine child's own --abort, its events as JSON lines (no sentence of its own leaks).
		expect(log).toContain(
			`${ENGINE_DYING} --abort --confirm-database ${DB} --request-stdin --events-jsonl`,
		);
		expect(log).toContain(`/usr/sbin/userdel ded_${INSTANCE}`);
		expect(readPlanFile(join(host.root, RUN_DIR))).toBeNull();
		expect(existsSync(join(host.root, `/var/lib/dedalo-install/instances/${INSTANCE}.json`))).toBe(
			false,
		);
	});

	test("the engine child's abort request attests UNSERVED only while the instance never started", () => {
		expect(abortRequest({ db_database: DB }, false)).toEqual({
			schema: 'dedalo.install.request/1',
			answers: { db_database: DB },
			unserved: true,
		});
		expect(abortRequest({ db_database: DB }, true)).not.toHaveProperty('unserved');
	});

	test('a failure AFTER the first start: the hint says the abort only partly undoes and keeps the instance', async () => {
		const { outcome } = await freshOn(UBUNTU_NGINX_LE, {
			responses: [
				{
					match: '/usr/sbin/nginx -t',
					whenPath: RULE_COPY,
					exit: 1,
					stderr: `nginx: [emerg] duplicate upstream "dedalo_${INSTANCE}"`,
				},
			],
		});
		expect(outcome.failedStep).toBe('host_web_site');
		const hint = outcome.hint.join('\n');
		expect(hint).toContain('Or partly undo it');
		expect(hint).toContain('the instance has served: its user, database and code are kept');
		expect(hint).not.toContain('--confirm-database');
	});
});

/**
 * SERVED IS MEASURED (campaign 3c D1): the VM run's SIGINT landed 7 ms into
 * host_first_boot — the start issued, the unit never ran (no journal, no
 * ActiveEnterTimestamp) — and the hint and --abort kept user, database and
 * code as "served". The start fails here the same way: issued, never taken.
 */
describe('served = the unit ran or the engine answered, never "the start was issued" (campaign 3c D1)', () => {
	const START = `/usr/bin/systemctl start dedalo-ts@${INSTANCE}.service`;
	const SHOW = `/usr/bin/systemctl show -p ExecMainStartTimestampMonotonic -p ActiveEnterTimestampMonotonic dedalo-ts@${INSTANCE}.service`;
	const SOCKET_HEALTH = '/usr/bin/curl -s -o /dev/null -w %{http_code} --max-time 10 --unix-socket';
	const startTaken = (ran: boolean): RecordedResponse[] => [
		{ match: START, exit: 1, stderr: `Job for dedalo-ts@${INSTANCE}.service canceled.` },
		{ match: SOCKET_HEALTH, exit: 7, stdout: '000' },
		{ match: SHOW, stdout: ran ? UNIT_RAN : UNIT_NEVER_RAN },
	];

	test('the start issued, the unit never ran: the hint offers the full undo, and --abort removes the instance whole', async () => {
		const { host, plan, outcome } = await freshOn(UBUNTU_NGINX_LE, {
			responses: startTaken(false),
		});
		expect(outcome.failedStep).toBe('host_first_boot');
		expect(outcome.hint.join('\n')).toContain(`--abort --confirm-database ${DB}`);
		expect(outcome.hint.join('\n')).not.toContain('has served');
		const aborted = await runHost(host, laterRequest('abort', plan, DB));
		expect(aborted.outcome.message).toBeNull();
		expect(aborted.outcome.keptLive).toBe(false);
		expect(aborted.outcome.undone).toContain('host_engine');
		expect(aborted.outcome.undone).toContain('host_identity');
		expect(aborted.transcript.lines.join('\n')).not.toContain('has served');
		expect(loggedCommands(host.root)).toContain(`/usr/sbin/userdel ded_${INSTANCE}`);
		expect(readPlanFile(join(host.root, RUN_DIR))).toBeNull();
	});

	test('CONTROL — the start "failed" but systemd ran the unit: served, measured; the abort keeps the instance', async () => {
		const { host, plan, outcome } = await freshOn(UBUNTU_NGINX_LE, {
			responses: startTaken(true),
		});
		expect(outcome.failedStep).toBe('host_first_boot');
		expect(outcome.hint.join('\n')).toContain(
			'the instance has served: its user, database and code are kept',
		);
		const aborted = await runHost(host, laterRequest('abort', plan, DB));
		expect(aborted.outcome.keptLive).toBe(true);
		expect(aborted.outcome.undone).not.toContain('host_engine');
		expect(loggedCommands(host.root)).not.toContain(`/usr/sbin/userdel ded_${INSTANCE}`);
		// Measured once, recorded: the record says served from now on.
		expect(readStateFile(join(host.root, RUN_DIR))?.created.host?.served).toBe(true);
	});

	test("systemd's start stamps: zero = never ran, non-zero = ran, unreadable = unknown (kept as served)", () => {
		expect(unitEverRan(UNIT_NEVER_RAN)).toBe(false);
		expect(unitEverRan(UNIT_RAN)).toBe(true);
		expect(
			unitEverRan('ExecMainStartTimestampMonotonic=0\nActiveEnterTimestampMonotonic=77\n'),
		).toBe(true);
		expect(unitEverRan('')).toBeNull();
	});
});

describe('the Review refuses Apache beside a running nginx BEFORE `yes` (campaign 3c D2)', () => {
	test('hostPlanRefusals — what the Review asks before it offers install — names the clash; nginx chosen: nothing', async () => {
		const listening = ['80', '443']
			.map((port) => `LISTEN 0 511 0.0.0.0:${port} 0.0.0.0:* users:(("nginx",pid=812,fd=6))\n`)
			.join('');
		const running = {
			files: NGINX_PRESENT,
			responses: [
				{ match: '/usr/sbin/nginx -v', stderr: 'nginx version: nginx/1.26.3\n' },
				{ match: '/usr/sbin/nginx -T', stdout: '' },
				{ match: '/usr/bin/ss -ltnpH', stdout: listening },
			],
		};
		const apache = await hostPlanRefusals(
			productionPlan(DEBIAN_APACHE_LE).planFile,
			hostOptions(scratchHost(DEBIAN_APACHE_LE, running)),
		);
		const errors = apache.errors.join('\n');
		expect(errors).toContain('port 80 is held by nginx — this install configures apache');
		expect(errors).toContain(
			'nginx is installed on this host and this run would install apache beside it',
		);
		const debianNginx = HOST_VARIANTS.find(
			(v) => v.os === DEBIAN_APACHE_LE.os && v.web === 'nginx' && v.tls === DEBIAN_APACHE_LE.tls,
		) as HostVariant;
		const nginx = await hostPlanRefusals(
			productionPlan(debianNginx).planFile,
			hostOptions(scratchHost(debianNginx, running)),
		);
		expect(nginx.errors.join('\n')).not.toContain('is held by');
		expect(nginx.errors.join('\n')).not.toContain('beside it');
	});
});

describe('a local ontology source the service user cannot read is refused before `yes` (campaign C4 RHEL10 F1)', () => {
	// The plan reads the catalog for real (as root would); the System check judges the
	// SCRATCH host's copy of the same absolute path — planted, its home moded per case.
	const release = join(REPO_ROOT, 'install/import/ontology/7.0');
	const realHome = join(mkdtempSync(join(tmpdir(), 'dedalo_onto_src_')), 'home', 'op');
	const source = join(realHome, '7.0');
	mkdirSync(source, { recursive: true });
	const manifest = readFileSync(join(release, 'ontology.json'), 'utf8');
	writeFileSync(join(source, 'ontology.json'), manifest);
	const files = new Map([
		[`${source}/ontology.json`, manifest],
		[`${source}/oh.copy.gz`, ''],
	]);
	const refusals = async (homeMode: number) =>
		(
			await hostPlanRefusals(
				productionPlan(
					UBUNTU_NGINX_LE,
					{ ontology_source: source },
					(
						await resolveOntologyCatalog({ kind: 'local', path: source }, { allowedServers: [] })
					).catalog,
				).planFile,
				hostOptions(scratchHost(UBUNTU_NGINX_LE, { files, modes: [[realHome, homeMode]] })),
			)
		).errors.join('\n');

	test('behind a 0700 home (root-owned here): the System check names the directory and the service user', async () => {
		expect(await refusals(0o700)).toContain(
			`--ontology-source ${source}: ${realHome} (root:root, mode 700) is not traversable by ded_${INSTANCE}`,
		);
	});

	test('positive control: the same tree with a traversable home is not refused', async () => {
		expect(await refusals(0o711)).not.toContain('--ontology-source');
	});
});

describe('the service user is never removed while it still owns something (C3-9)', () => {
	test('the empty web tree is pruned AS THE USER before userdel; a file of the user left behind KEEPS the user (no tree owned by a bare uid)', async () => {
		const pruned = (log: readonly string[]) =>
			log.findIndex(
				(line) =>
					line.startsWith(`${asService()} /usr/bin/find /srv/dedalo/${INSTANCE}`) &&
					line.endsWith('-type d -empty -delete'),
			);
		// Clean: pruned, then removed.
		const clean = await freshOn(UBUNTU_NGINX_LE, { responses: engineFails() });
		await runHost(clean.host, laterRequest('abort', clean.plan, DB));
		const cleanLog = loggedCommands(clean.host.root);
		const userdel = cleanLog.indexOf(`/usr/sbin/userdel ded_${INSTANCE}`);
		expect(pruned(cleanLog)).toBeGreaterThan(-1);
		expect(userdel).toBeGreaterThan(pruned(cleanLog));
		// A file of the user remains: the user is KEPT, and the sentence names the file.
		const left = `/srv/dedalo/${INSTANCE}/dedalo/media/image/original/x.jpg`;
		const kept = await freshOn(UBUNTU_NGINX_LE, { responses: engineFails() });
		// The file the engine child left in its media tree (the tree is not empty: it stays).
		mkdirSync(dirname(join(kept.host.root, left)), { recursive: true });
		writeFileSync(join(kept.host.root, left), 'a heritage image\n');
		replaceResponses(kept.host, UBUNTU_NGINX_LE, [
			...engineFails(),
			{
				match: `/usr/bin/find /home/ded_${INSTANCE} /srv/dedalo/${INSTANCE}`,
				stdout: `${left}\n`,
			},
		]);
		const aborted = await runHost(kept.host, laterRequest('abort', kept.plan, DB));
		expect(aborted.outcome.result).toBe('aborted');
		expect(
			loggedCommands(kept.host.root).some((line) => line.startsWith('/usr/sbin/userdel')),
		).toBe(false);
		expect(aborted.transcript.lines.join('\n')).toContain(
			`user ded_${INSTANCE} KEPT: it still owns ${left}`,
		);
	});
});

describe('the HOST owns the one-time salt display (C3-18)', () => {
	test('no terminal on the run that completes: not shown, never logged, the read-back command said; the next run that has one shows it ONCE', async () => {
		const host = scratchHost(UBUNTU_NGINX_LE);
		const { plan, planFile } = productionPlan(UBUNTU_NGINX_LE);
		const first = await runHost(host, freshRequest(planFile), { terminal: false });
		expect(first.outcome.result).toBe('complete');
		expect(first.transcript.shown).toEqual([]);
		expect(first.transcript.lines.join('\n')).not.toContain('scratch-salt-value');
		expect(first.transcript.lines.join('\n')).toContain(
			`read it with: sudo grep ^DEDALO_SALT_STRING= /home/ded_${INSTANCE}/private/.env`,
		);
		expect(readStateFile(join(host.root, RUN_DIR))?.created.host?.salt_shown).toBe(false);
		// A resume on a terminal (the install is complete: nothing runs) shows it, once.
		const second = await runHost(host, laterRequest('resume', plan));
		expect(second.transcript.shown.join('\n')).toContain('DEDALO_SALT_STRING = scratch-salt-value');
		expect(second.transcript.lines.join('\n')).not.toContain('scratch-salt-value');
		expect(readStateFile(join(host.root, RUN_DIR))?.created.host?.salt_shown).toBe(true);
		const third = await runHost(host, laterRequest('resume', plan));
		expect(third.transcript.shown).toEqual([]);
	});

	test('a resume that ADOPTS an engine which finished as an orphan shows the salt once', async () => {
		const host = scratchHost(UBUNTU_NGINX_LE);
		const { plan, planFile } = productionPlan(UBUNTU_NGINX_LE);
		expect((await runHost(host, freshRequest(planFile), { terminal: false })).outcome.result).toBe(
			'complete',
		);
		// The parent died while its child went on and sealed (C3-29's orphan): host_engine running.
		const runDir = join(host.root, RUN_DIR);
		const state = readStateFile(runDir) as NonNullable<ReturnType<typeof readStateFile>>;
		(state.steps.host_engine as { status: string }).status = 'running';
		state.outcome = 'in_progress';
		writeStateFile(state, runDir);
		const resumed = await runHost(host, laterRequest('resume', plan));
		expect(resumed.outcome.result).toBe('complete');
		expect(resumed.transcript.lines.join('\n')).toContain('verified (completed in an earlier run)');
		expect(
			resumed.transcript.shown.filter((line) => line.includes('scratch-salt-value')),
		).toHaveLength(1);
	});
});

describe('a --resume asks only the secrets a remaining step still needs (C3-51)', () => {
	test('an engine child that already set the root password needs it no more; one without a record needs it', async () => {
		const host = scratchHost(UBUNTU_NGINX_LE);
		const { plan, planFile } = productionPlan(UBUNTU_NGINX_LE);
		await runHost(host, freshRequest(planFile));
		const runDir = join(host.root, RUN_DIR);
		const state = readStateFile(runDir) as NonNullable<ReturnType<typeof readStateFile>>;
		(state.steps.host_engine as { status: string }).status = 'running';
		writeStateFile(state, runDir);
		const options = hostOptions(host);
		// The child's record is complete (the scratch status after its run): nothing to ask.
		expect(await hostResumeSecrets(plan.answers, options)).toEqual([]);
		// A child with no record: every secret the engine step takes (the root password always).
		replaceResponses(host, UBUNTU_NGINX_LE, [
			{ match: ENGINE_STATUS, stdout: '{"exists":false,"outcome":null,"failed_step":null}\n' },
		]);
		expect(await hostResumeSecrets(plan.answers, options)).toContain('root_password');
		// A child that still needs it says so.
		replaceResponses(host, UBUNTU_NGINX_LE, [
			{
				match: ENGINE_STATUS,
				stdout:
					'{"exists":true,"outcome":"in_progress","failed_step":null,"needs":["root_password"]}\n',
			},
		]);
		expect(await hostResumeSecrets(plan.answers, options)).toEqual(['root_password']);
	});
});

describe('the engine child dies with the installer; a resume never races one still working (C3-29)', () => {
	test('a child of an earlier run that still holds its install lock: the resume refuses, naming its pid — and starts no second child', async () => {
		const { host, plan } = await freshOn(UBUNTU_NGINX_LE, { responses: engineFails() });
		replaceResponses(host, UBUNTU_NGINX_LE, [
			{
				match: ENGINE_STATUS,
				stdout:
					'{"exists":true,"outcome":"in_progress","failed_step":null,"needs":[],"running":{"pid":4242,"started_at":"2026-10-13T10:00:00Z"}}\n',
			},
		]);
		const before = loggedCommands(host.root).length;
		const resumed = await runHost(host, laterRequest('resume', plan));
		expect(resumed.outcome.result).toBe('failed');
		expect(resumed.outcome.message).toContain('still running (pid 4242');
		expect(
			loggedCommands(host.root)
				.slice(before)
				.filter((line) => line.startsWith(`${ENGINE_DYING} --request-stdin`)),
		).toEqual([]);
	});
});

describe("the engine child's own refusal reaches the host's ✖ block (campaign 3e F4, production)", () => {
	test('run and abort quote the child’s outcome sentence (never "see above" over nothing); a crash quotes its stderr', async () => {
		const said = `a seed restore into '${DB}' is still running (backend pid 124)`;
		const outcome = `{"event":"outcome","exitCode":1,"result":"refused","message":"${said}","failedStep":null,"hint":[]}\n`;
		const {
			host,
			plan,
			outcome: crashed,
		} = await freshOn(UBUNTU_NGINX_LE, {
			responses: engineFails(),
		});
		// engineFails: exit 9 with only a stderr line — the reason, quoted.
		expect(crashed.message).toContain(
			'the engine steps failed: the seed restore failed — their record is in',
		);
		replaceResponses(host, UBUNTU_NGINX_LE, [
			{ match: `${ENGINE_DYING} --request-stdin`, exit: 1, stdout: outcome },
			{ match: `${ENGINE_DYING} --abort`, exit: 1, stdout: outcome },
			{
				match: ENGINE_STATUS,
				stdout:
					'{"exists":true,"outcome":"in_progress","failed_step":"install_db_from_default_file","needs":[]}\n',
			},
		]);
		const resumed = await runHost(host, laterRequest('resume', plan));
		expect(resumed.outcome.message).toContain(`the engine steps failed: ${said} — their record`);
		const aborted = await runHost(host, laterRequest('abort', plan, DB));
		expect(aborted.outcome.result).not.toBe('aborted');
		expect(aborted.outcome.message).toContain(
			`the engine child refused its --abort: ${said} — nothing before it was undone (exit 1)`,
		);
		for (const message of [resumed, aborted].map((r) => r.outcome.message ?? ''))
			expect(message).not.toContain('see above');
	});
});

describe('a signal-killed engine child is named killed; runuser chatter is never the reason (campaign 3f F1, production)', () => {
	test('exit 137 with runuser\'s "Session terminated" stderr: killed by SIGKILL', async () => {
		const bun = `/opt/dedalo/bun/${BUN_PIN}/bun`;
		const dying = `${asServiceHomeDying()} ${bun} run /home/ded_${INSTANCE}/dedalo/scripts/install.ts`;
		const { outcome } = await freshOn(UBUNTU_NGINX_LE, {
			responses: [
				{
					match: `${dying} --request-stdin`,
					exit: 137,
					stderr: 'Session terminated, killing shell... ...killed.\n',
				},
				...engineFails(),
			],
		});
		expect(outcome.message).toContain(
			'the engine steps failed: the engine child was killed by SIGKILL — out of memory, or a kill — their record is in',
		);
		expect(outcome.message).not.toContain('Session terminated');
	});
});

describe("the engine child's last words while it stops are INSIDE the ✖ block (campaign 3f F2, production)", () => {
	test('a line the child prints AFTER the signal: waited for, kept, printed after the ✖ header — once', async () => {
		const host = scratchHost(UBUNTU_NGINX_LE);
		const { planFile } = productionPlan(UBUNTU_NGINX_LE);
		const ended = "  ended the seed restore's database session (backend pid 42800)";
		const child = `${ENGINE_DYING} --request-stdin`;
		// Ctrl-C reaches the process group: the child gets it and SPEAKS LATER (its own stop), then exits 130.
		const wrapRunner = (inner: CommandRunner): CommandRunner => ({
			run: async (request) => {
				if (!request.argv.join(' ').startsWith(child)) return inner.run(request);
				process.emit('SIGINT');
				await new Promise((done) => setTimeout(done, 0));
				request.onStdoutLine?.(JSON.stringify({ event: 'log', line: ended }));
				return { exitCode: 130, stdout: '', stderr: '', timedOut: false };
			},
		});
		const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => {
			throw new Error(`exit ${code}`);
		}) as never);
		const transcript = { lines: [] as string[], told: [] as string[], shown: [] as string[] };
		try {
			await runHost(host, freshRequest(planFile), { wrapRunner, transcript });
		} catch {
			// the mocked exit
		} finally {
			exit.mockRestore();
		}
		const lines = transcript.lines;
		const block = lines.findIndex((line) => line.includes('✖ install interrupted (SIGINT)'));
		expect(block).toBeGreaterThan(-1);
		const at = lines.findIndex((line) => line.includes(ended.trim()));
		expect(at).toBeGreaterThan(block);
		expect(lines.filter((line) => line.includes(ended.trim())).length).toBe(1);
		expect(at).toBeLessThan(lines.findIndex((line) => line.startsWith('  Progress saved:')));
	});
});

describe('the run record says an install was confirmed to execute (C3-63)', () => {
	test('--execute or the Review’s yes → execute: true; a headless run without --execute → false', async () => {
		expect(runConfirmed(false, true)).toBe(true);
		expect(runConfirmed(true, false)).toBe(true);
		expect(runConfirmed(false, false)).toBe(false);
		const host = scratchHost(UBUNTU_NGINX_LE);
		const { planFile } = productionPlan(UBUNTU_NGINX_LE);
		await runHost(host, { ...freshRequest(planFile), execute: runConfirmed(false, true) });
		expect(readStateFile(join(host.root, RUN_DIR))?.runs[0]?.execute).toBe(true);
	});
});

describe('--plan --route production runs the System check’s read-only measurements (C3-25)', () => {
	test('an unsupported OS: errors name it; a supported host: none', async () => {
		const refused = scratchHost(UBUNTU_NGINX_LE, { osRelease: UNSUPPORTED_OS_RELEASE });
		const { planFile } = productionPlan(UBUNTU_NGINX_LE);
		const bad = await hostPlanRefusals(planFile, hostOptions(refused));
		expect(bad.errors.join('; ')).toContain('Ubuntu 24.04.3 LTS is not supported');
		const good = await hostPlanRefusals(planFile, hostOptions(scratchHost(UBUNTU_NGINX_LE)));
		expect(good.errors).toEqual([]);
		// Nothing written: --plan measures, never records.
		expect(existsSync(join(refused.root, RUN_DIR))).toBe(false);
	});

	test('measured as a normal user: the root refusal becomes a warning, the rest stays', async () => {
		const host = scratchHost(UBUNTU_NGINX_LE, {
			responses: [{ match: '/usr/bin/id -u', stdout: '1000\n' }],
		});
		const { planFile } = productionPlan(UBUNTU_NGINX_LE);
		const verdict = await hostPlanRefusals(planFile, hostOptions(host));
		expect(verdict.errors).toEqual([]);
		expect(verdict.warnings.join('\n')).toContain('run --plan with sudo');
	});
});

describe('THE CLI: `--plan --route production` reports the host refusals and exits 1 (C3-25)', () => {
	test('scripts/install.ts --plan on an unsupported OS (the scratch seam): errors name it, exit 1; a supported host: exit 0', () => {
		const plan = (osRelease?: string) => {
			const host = scratchHost(UBUNTU_NGINX_LE, osRelease === undefined ? {} : { osRelease });
			const dir = mkdtempSync(join(scratchBase, 'plan_cli_'));
			const answers = join(dir, 'answers.json');
			writeFileSync(
				answers,
				JSON.stringify({ schema: ANSWERS_FILE_SCHEMA, answers: productionRaw(UBUNTU_NGINX_LE) }),
			);
			const proc = Bun.spawnSync(
				[
					process.execPath,
					'run',
					join(REPO_ROOT, 'scripts/install.ts'),
					'--plan',
					'--answers',
					answers,
				],
				{
					cwd: REPO_ROOT,
					env: {
						...Bun.env,
						DEDALO_INSTALL_PRIVATE_DIR: mkdtempSync(join(dir, 'private_')),
						DEDALO_INSTALL_HOST_ROOT: host.root,
					} as Record<string, string>,
					stdout: 'pipe',
					stderr: 'pipe',
				},
			);
			const line = proc.stdout.toString().trim().split('\n').at(-1) ?? '{}';
			return { exitCode: proc.exitCode, errors: (JSON.parse(line) as { errors: string[] }).errors };
		};
		const refused = plan(UNSUPPORTED_OS_RELEASE);
		expect(refused.errors.join('; ')).toContain('Ubuntu 24.04.3 LTS is not supported');
		expect(refused.exitCode).toBe(1);
		const supported = plan();
		expect(supported.errors).toEqual([]);
		expect(supported.exitCode).toBe(0);
	}, 120_000);
});

describe('the engine checks the backup directory the units write to (C3-55)', () => {
	test("the engine child runs with DEDALO_BACKUP_DIR = <backup dir>/db — the units' --dir — never a second one under private/", async () => {
		const host = scratchHost(UBUNTU_NGINX_LE);
		const { planFile } = productionPlan(UBUNTU_NGINX_LE);
		expect((await runHost(host, freshRequest(planFile))).outcome.result).toBe('complete');
		const ctx = frozenContext(host);
		const child = loggedRequests(host.root).find((entry) => entry.argv.includes('--request-stdin'));
		expect(child?.env.DEDALO_BACKUP_DIR).toBe(`${ctx.paths.backupDir}/db`);
		// The same directory the backup unit's drop-in hands its dump step.
		const dropin = readFileSync(
			join(
				host.root,
				`/etc/systemd/system/dedalo-backup@${INSTANCE}.service.d/10-dedalo-install.conf`,
			),
			'utf8',
		);
		expect(dropin).toContain(`--dir ${ctx.paths.backupDir}/db`);
	});

	test('the instance .env pins DEDALO_BACKUP_DIR to that same directory, so the RUNNING server uses it too', () => {
		// A backup dir of the operator's own (the default would also be what the child derives).
		const ctx = productionPlanCtx(UBUNTU_NGINX_LE, REPO_ROOT, {
			backup_dir: '/data/zz_backups/museo',
		});
		expect(ctx.paths.backupDir).toBe('/data/zz_backups/museo');
		// What the engine child is handed, planned as the child plans it.
		const child = buildInstallPlan(
			{ ...(engineAnswers(ctx) as Record<string, unknown>), root_password: ROOT_PASSWORD },
			{ salt: 's' },
		);
		expect(child.errors).toEqual([]);
		const written = child.env.flatMap((section) => section.entries);
		expect(written.find((item) => item.key === 'DEDALO_BACKUP_DIR')?.value).toBe(
			`${ctx.paths.backupDir}/db`,
		);
		// The developer route has no backup units: it writes no such key.
		const developer = buildInstallPlan({ route: 'developer', entity: 'mus', root_password: 'x' });
		expect(
			developer.env
				.flatMap((section) => section.entries)
				.some((item) => item.key === 'DEDALO_BACKUP_DIR'),
		).toBe(false);
	});
});

describe("the closing To-do of a run completed by --resume lists every step's (campaign 3b N19)", () => {
	test("the firewall line host_preflight told in the FIRST run is in the resume's closing To-do", async () => {
		const open =
			'firewall-cmd --permanent --add-service=http --add-service=https && firewall-cmd --reload';
		const closed = FIREWALLD('cockpit dhcpv6-client ssh');
		const { host, plan, outcome } = await freshOn(UBUNTU_NGINX_LE, {
			responses: [...closed, ...engineFails()],
		});
		expect(outcome.failedStep).toBe('host_engine');
		// The operator fixed the cause; the firewall is still closed.
		replaceResponses(host, UBUNTU_NGINX_LE, closed);
		const resumed = await runHost(host, laterRequest('resume', plan));
		expect(resumed.outcome.result).toBe('complete');
		// host_preflight ran in the first run only — its told line still closes this one.
		expect(resumed.outcome.told.join('\n')).toContain(open);
		expect(resumed.transcript.told.join('\n')).toContain(open);
		// Each line once.
		expect(new Set(resumed.outcome.told).size).toBe(resumed.outcome.told.length);
	});
});

describe('a resume that re-ran earlier steps probes the public address again (campaign 3b N6, production)', () => {
	test('complete → abort (live: the web steps undone) → resume: host_public_probe runs again, never "nothing to re-check"', async () => {
		const host = scratchHost(UBUNTU_NGINX_LE);
		const { plan, planFile } = productionPlan(UBUNTU_NGINX_LE);
		expect((await runHost(host, freshRequest(planFile))).outcome.result).toBe('complete');
		expect((await runHost(host, laterRequest('abort', plan))).outcome.keptLive).toBe(true);
		const probes = (): number =>
			loggedCommands(host.root).filter((line) => line === PUBLIC_HEALTH).length;
		const before = probes();
		// The scratch world after the resume starts the services again (its `until`s are sticky).
		replaceResponses(host, UBUNTU_NGINX_LE, [
			{
				match: '/usr/bin/curl -s -o /dev/null -w %{http_code} --max-time 10 --unix-socket',
				stdout: '200',
			},
			{ match: `/usr/bin/systemctl is-active dedalo-ts-watchdog@${INSTANCE}.timer` },
		]);
		const resumed = await runHost(host, laterRequest('resume', plan));
		expect(resumed.outcome.message).toBeNull();
		expect(resumed.outcome.result).toBe('complete');
		expect(probes()).toBeGreaterThan(before);
		const said = resumed.transcript.lines.join('\n');
		expect(said).toContain('a step before it ran again in this run — checked again');
		// CONTROL: a resume that ran nothing re-runs no probe (already complete).
		const idle = probes();
		const again = await runHost(host, laterRequest('resume', plan));
		expect(again.outcome.result).toBe('already_complete');
		expect(probes()).toBe(idle);
	});
});

describe('a run that INSTALLS nginx tells the default site its package wrote (campaign 3d C3d-F2)', () => {
	/** Debian/Ubuntu's nginx package: sites-enabled/default, `default_server` on 80 (after host_packages). */
	const PACKAGE_DEFAULT: RecordedResponse = {
		match: '/usr/sbin/nginx -T',
		after: '/usr/bin/apt-get install -y --no-install-recommends git',
		stdout:
			'# configuration file /etc/nginx/sites-enabled/default:\nserver {\n\tlisten 80 default_server;\n\tlisten [::]:80 default_server;\n\troot /var/www/html;\n}\n',
	};
	const NOTE =
		'port 80: the default site stays yours (/etc/nginx/sites-enabled/default, default_server)';

	test('nginx absent at the System check: the first instance still gets the port-80 note', async () => {
		const host = scratchHost(UBUNTU_NGINX_LE, { responses: [PACKAGE_DEFAULT] });
		const { outcome } = await runHost(host, freshRequest(productionPlan(UBUNTU_NGINX_LE).planFile));
		expect(outcome.result).toBe('complete');
		expect(outcome.told.join('\n')).toContain(NOTE);
		// Measured, never changed: the dump is a read-only probe of the run.
		expect(loggedCommands(host.root)).toContain('/usr/sbin/nginx -T');
		// CONTROL: a package that wrote no default site — no note.
		const bare = await runHost(
			scratchHost(UBUNTU_NGINX_LE),
			freshRequest(productionPlan(UBUNTU_NGINX_LE).planFile),
		);
		expect(bare.outcome.result).toBe('complete');
		expect(bare.outcome.told.join('\n')).not.toContain('the default site stays yours');
	});

	test('campaign 3e E5: the Review (measured, as the installer computes it) carries the note on a host without nginx', async () => {
		const { allTodo } = await todoOn(UBUNTU_NGINX_LE, {});
		expect(allTodo.join('\n')).toContain(NOTE);
		expect(allTodo.filter((line) => PLANNED_DEFAULT.test(line)).length).toBe(1);
	});

	test('campaign 3e E5: the Review says it BEFORE yes when the run installs nginx (Debian/Ubuntu package)', () => {
		const fs = { readText: () => null, exists: () => false };
		const now = Date.now();
		const planned = productionPlanCtx(UBUNTU_NGINX_LE);
		expect(planned.facts.web.installed).toBe(false);
		expect(reviewTodo(planned, fs, now).join('\n')).toContain(NOTE);
		// CONTROL: nginx already installed — host_web_site measures it, the Review predicts nothing.
		const present = {
			...planned,
			facts: { ...planned.facts, web: { ...planned.facts.web, installed: true } },
		};
		expect(reviewTodo(present, fs, now).join('\n')).not.toContain('the default site stays yours');
		// CONTROL: the RHEL family's nginx package declares no default_server.
		const el = HOST_VARIANTS.find((item) => item.os === 'el10' && item.web === 'nginx');
		expect(el).toBeDefined();
		const elTodo = reviewTodo(productionPlanCtx(el as HostVariant), fs, now);
		expect(elTodo.join('\n')).not.toContain('the default site stays yours');
	});
});

describe('the untrusted-chain refusal names the real recovery path (campaign 3d C3d-F2)', () => {
	test('"check again" (the Review re-checks on install), never "run this again"', () => {
		const chain = mintCertificate('x.example.org').cert;
		const untrusted = chainTrustVerdict(chain, [mintCertificate('y.example.org').cert]).problem;
		expect(untrusted).toContain('which this machine does not trust');
		expect(untrusted).not.toContain('run this again');
		expect(untrusted).toContain('then check again (on the Review: install, which checks first');
		// CONTROL: the chain in the trust store is no problem.
		expect(chainTrustVerdict(chain, [chain]).problem).toBeNull();
	});
});

// ── (g) the local CA on production (owner decision 2026-10-16) ───────────────

describe('the local CA on production: end to end on every row × web server (g)', () => {
	const GENERATOR = `/opt/dedalo/instances/${INSTANCE}/bin/dedalo-tls-rotate.sh`;
	const TIMER = `dedalo-tls-renew@${INSTANCE}.timer`;
	const DROPIN = `/etc/systemd/system/dedalo-tls-renew@${INSTANCE}.service.d/10-dedalo-install.conf`;
	const NAMES = [SERVER_NAME, ...LOCAL_CA_EXTRA_NAMES.split(',')];

	test('the matrix: every supported row × nginx|apache', () => {
		expect(LOCAL_CA_VARIANTS.length).toBe(6);
		expect(new Set(LOCAL_CA_VARIANTS.map((variant) => variant.os))).toEqual(
			new Set(['ubuntu2604', 'debian13', 'el10']),
		);
	});

	for (const variant of LOCAL_CA_VARIANTS) {
		test(`${variantName(variant)}: Review ≡ run, files landed, the generator, the timer, the trust told, idempotent`, async () => {
			const host = scratchHost(variant);
			const { plan, planFile } = productionPlan(variant);
			expect(plan.steps).not.toContain('host_web_http');
			const first = await runHost(host, freshRequest(planFile));
			expect(first.outcome.message).toBeNull();
			expect(first.outcome.result).toBe('complete');
			const ctx = frozenContext(host);
			const log = loggedCommands(host.root);
			expect(reviewEqualsRun(ctx, log)).toEqual([]);
			expect(landedProblems(host, ctx)).toEqual([]);
			// The ONE generator, from its root-owned copy, every address a --host (the subject first).
			expect(log.filter((line) => line.includes('dedalo-tls-rotate.sh'))).toEqual([
				[
					GENERATOR,
					'--mode local-ca',
					...NAMES.map((name) => `--host ${name}`),
					`--dir ${LOCAL_CA_DIR} --no-reload --quiet`,
				].join(' '),
			]);
			// No ACME anywhere: no certbot command, no certbot package, no challenge root.
			expect(log.filter((line) => /certbot|acme/.test(line))).toEqual([]);
			expect(existsSync(join(host.root, `/var/lib/dedalo-install/acme/${INSTANCE}`))).toBe(false);
			// The renewal: the drop-in pins the root-owned generator, this directory, the host web server.
			const service = osRowById(variant.os).web[variant.web].service;
			expect(readFileSync(join(host.root, DROPIN), 'utf8')).toContain(
				`ExecStart=${GENERATOR} --mode renew --dir ${LOCAL_CA_DIR} --reload systemd --unit ${service}\n`,
			);
			expect(log).toContain(`/usr/bin/systemctl enable --now ${TIMER}`);
			// EL: the certificate directory is relabelled cert_t after the generator wrote it.
			const relabel = log.indexOf(`/usr/sbin/restorecon -RF ${LOCAL_CA_DIR}`);
			expect(relabel >= 0).toBe(variant.os === 'el10');
			if (relabel >= 0)
				expect(relabel).toBeGreaterThan(
					log.indexOf(log.find((l) => l.startsWith(GENERATOR)) ?? ''),
				);
			// The site names the local CA's files and every address.
			const site = readFileSync(join(host.root, sitePathOf(variant)), 'utf8');
			expect(site).toContain(`${LOCAL_CA_DIR}/fullchain.pem`);
			expect(site).toContain(`${LOCAL_CA_DIR}/privkey.pem`);
			for (const name of NAMES) expect(site).toContain(name);
			// The public probe verified the chain against the install's OWN authority.
			expect(
				log.some(
					(line) =>
						line.includes('/health') &&
						line.includes(`--cacert ${LOCAL_CA_DIR}/dedalo-local-ca.pem`),
				),
			).toBe(true);
			expect(log.some((line) => line.includes('--insecure'))).toBe(false);
			// Done: where the authority is, its fingerprint, how to trust it, the curl check.
			const told = first.outcome.told.join('\n');
			const fingerprint = new X509Certificate(localCaScratchAuthority().cert).fingerprint256;
			expect(told).toContain(
				`${LOCAL_CA_DIR}/dedalo-local-ca.pem — SHA-256 fingerprint ${fingerprint}`,
			);
			for (const how of [
				'Windows',
				'macOS',
				'update-ca-certificates',
				'update-ca-trust',
				'Firefox',
				// Windows opens no .pem as a certificate (no Install button): a .crt copy, or certutil.
				'save it as dedalo-local-ca.crt',
				'certutil -addstore -f Root dedalo-local-ca.pem',
				// Firefox imports with website trust OFF unless the box is ticked.
				"tick 'Trust this CA to identify websites'",
			])
				expect(told).toContain(how);
			expect(told).toContain(`curl --cacert dedalo-local-ca.pem https://${SERVER_NAME}/health`);
			// Idempotent.
			const second = await runHost(host, laterRequest('resume', plan));
			expect(second.outcome.result).toBe('already_complete');
			expect(mutatingLog(loggedCommands(host.root).slice(log.length))).toEqual([]);
		});
	}

	test('abort removes exactly what the local CA made: the timer, its drop-in, the directory', async () => {
		const variant = LOCAL_CA_VARIANTS[0] as HostVariant;
		const host = scratchHost(variant);
		const { plan, planFile } = productionPlan(variant);
		expect((await runHost(host, freshRequest(planFile))).outcome.result).toBe('complete');
		const before = loggedCommands(host.root).length;
		const abort = await runHost(host, laterRequest('abort', plan));
		expect(abort.outcome.result).toBe('aborted');
		const undone = loggedCommands(host.root).slice(before);
		expect(undone).toContain(`/usr/bin/systemctl disable --now ${TIMER}`);
		expect(undone).toContain(`/usr/bin/rm -rf ${LOCAL_CA_DIR}`);
		// (The recording runner executes no `rm`: the logged command is the outcome; the
		// drop-in is removed through the HostFs, measured on the scratch root.)
		expect(existsSync(join(host.root, DROPIN))).toBe(false);
		// Nothing else under the instance's root-owned dir (the bin dir is host_runtime's).
		expect(
			undone.filter((line) => line.includes('rm -rf') && line.includes('/opt/dedalo/instances/')),
		).toEqual([`/usr/bin/rm -rf ${LOCAL_CA_DIR}`]);
	});

	test('an authority that was there BEFORE (same addresses) is used as it is, and an abort keeps it', async () => {
		const variant = LOCAL_CA_VARIANTS[0] as HostVariant;
		const authority = localCaScratchAuthority();
		const files = new Map([
			[`${LOCAL_CA_DIR}/dedalo-local-ca.pem`, authority.cert],
			[`${LOCAL_CA_DIR}/fullchain.pem`, authority.cert],
			[`${LOCAL_CA_DIR}/dedalo-local-ca.names`, `${NAMES.join('\n')}\n`],
		]);
		const host = scratchHost(variant, {
			files,
			responses: [
				// The authority is there from the start: the issue is skipped.
				{
					match: `/usr/bin/test -s ${LOCAL_CA_DIR}/fullchain.pem -a -s ${LOCAL_CA_DIR}/dedalo-local-ca.pem`,
				},
			],
		});
		writeFileSync(join(host.root, LOCAL_CA_DIR, 'privkey.pem'), authority.key, { mode: 0o600 });
		const { plan, planFile } = productionPlan(variant);
		expect((await runHost(host, freshRequest(planFile))).outcome.result).toBe('complete');
		expect(loggedCommands(host.root).some((line) => line.startsWith(GENERATOR))).toBe(false);
		await runHost(host, laterRequest('abort', plan));
		expect(readFileSync(join(host.root, LOCAL_CA_DIR, 'dedalo-local-ca.pem'), 'utf8')).toBe(
			authority.cert,
		);
	});

	test('an authority made for OTHER addresses is refused on the System check, before anything changes', async () => {
		const variant = LOCAL_CA_VARIANTS[0] as HostVariant;
		const authority = localCaScratchAuthority();
		const host = scratchHost(variant, {
			files: new Map([
				[`${LOCAL_CA_DIR}/dedalo-local-ca.pem`, authority.cert],
				[`${LOCAL_CA_DIR}/dedalo-local-ca.names`, 'old.example.org\n'],
			]),
		});
		const { planFile } = productionPlan(variant);
		const run = await runHost(host, freshRequest(planFile));
		expect(run.outcome.result).not.toBe('complete');
		expect(run.outcome.message ?? '').toContain(
			`${LOCAL_CA_DIR} already holds a local certificate authority for old.example.org`,
		);
		expect(mutatingLog(loggedCommands(host.root))).toEqual([]);
	});

	test('a pre-2026-10-16 authority (unconstrained, no names list) is refused on the System check — never adopted silently', async () => {
		const variant = LOCAL_CA_VARIANTS[0] as HostVariant;
		const authority = localCaScratchAuthority();
		// What a copied docker deploy/certs of that era holds: the single-tier root and its
		// key, the leaf — a certificate that even names every address. Refused all the same.
		const host = scratchHost(variant, {
			files: new Map([
				[`${LOCAL_CA_DIR}/dedalo-local-ca.pem`, authority.cert],
				[`${LOCAL_CA_DIR}/fullchain.pem`, authority.cert],
			]),
		});
		writeFileSync(join(host.root, LOCAL_CA_DIR, 'dedalo-local-ca.key'), authority.key, {
			mode: 0o600,
		});
		const { planFile } = productionPlan(variant);
		const run = await runHost(host, freshRequest(planFile));
		expect(run.outcome.result).not.toBe('complete');
		expect(run.outcome.message ?? '').toContain(
			`${LOCAL_CA_DIR} already holds a local certificate authority made before 2026-10-16 — UNCONSTRAINED`,
		);
		expect(run.outcome.message ?? '').toContain(
			`${GENERATOR} --mode local-ca --dir ${LOCAL_CA_DIR}`,
		);
		expect(mutatingLog(loggedCommands(host.root))).toEqual([]);
		expect(loggedCommands(host.root).some((line) => line.startsWith(GENERATOR))).toBe(false);
	});
});

/** The site file of a variant's instance. */
function sitePathOf(variant: HostVariant): string {
	return osRowById(variant.os).web[variant.web].sitePath.replace('<i>', INSTANCE);
}
