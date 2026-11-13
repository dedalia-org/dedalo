/**
 * SELINUX ON THE RHEL FAMILY: THE CONTEXTS, THE ONE POLICY RULE, AND WHOSE
 * MODULE IT IS (terminal installer phase 4, 2026-10-12; src/core/install/host/
 * production/selinux.ts, deploy/selinux/dedalo_engine.cil.tpl).
 *
 * Run through the real executor on a scratch EL 10 host (recording runner,
 * SELinux enforcing — test/helpers/install_host_scratch.ts):
 *
 *  (a) THE FILE CONTEXTS: the socket directory in the spelling the HOST'S
 *      policy accepts — its file_contexts.subs_dist/.subs equivalences map a
 *      path onto their TARGET side (`/var/run /run` on EL 10: /run/dedalo-<i>;
 *      the other side is refused by `semanage fcontext -a` — campaign 3 C3-3;
 *      an EL 9-style `/run /var/run` gives the /var/run spelling), verify
 *      accepting either spelling — as httpd_var_run_t, the instance's /srv tree (media AND the published
 *      client — critique B13: nothing the web server reads lives under /home)
 *      and the ACME webroot (Let's Encrypt only) as httpd_sys_content_t; each
 *      relabelled with restorecon; the install folder's own subtrees
 *      (dedalo/, private/, backups/ — owner decisions 2026-10-12) as var_lib_t,
 *      relabelled AS THE SERVICE USER, the folder itself (non-recursive) only
 *      when this install created it; root relabels nothing inside the folder.
 *  (b) THE MODULE, judged by what it GRANTS (its statements parsed, comments
 *      out): the web server reaches the engine and NOTHING ELSE — no
 *      statement names unconfined_service_t; every unix_stream_socket
 *      connectto rule is httpd_t → a domain this module declares; that domain
 *      is entered from init_t through exactly one typetransition on the
 *      module's exec type, which the one filecon gives to EXACTLY the pinned
 *      runtime every variant's dedalo-ts@ ExecStart runs (no shell, no script,
 *      no other bun). Positive control: the earlier one-rule module
 *      (httpd_t → unconfined_service_t) fails. Stamped, written 0600 root,
 *      loaded with `semodule -X 400 -i`, THEN the runtime relabelled
 *      (`restorecon -F`); no home-directory rule, no boolean (`setsebool` is
 *      never run). host_selinux verifies the runtime's label; host_first_boot
 *      refuses an engine that runs in any other domain (read from the
 *      process). Compiled against the EL 10 targeted policy store
 *      (`semodule -n -i`, almalinux:10, 2026-10-12) — never loaded into a
 *      kernel here.
 *  (c) A FOREIGN MODULE of the same name (loaded, but not the bytes this
 *      installer writes) is REFUSED, never replaced.
 *  (d) REFCOUNTED UNDO: --abort removes this instance's contexts — only the
 *      claimed ones the host DEFINES (a claim is saved BEFORE `semanage -a`
 *      runs, so a refused add leaves a claim --abort must not delete); the module
 *      only when this install loaded it AND no other instance on the host
 *      still uses it (the host registry).
 *  (e) Off the RHEL family (and with SELinux disabled) the step runs nothing.
 *
 * DB-FREE, network-free (the hermetic tier runs it).
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseSubs } from '../../src/core/install/host/facts.ts';
import { hostFs } from '../../src/core/install/host/fs.ts';
import {
	canonicalSpelling,
	fcontextRules,
} from '../../src/core/install/host/production/selinux.ts';
import type { RecordedResponse } from '../../src/core/install/host/runner.ts';
import { serverDropin } from '../../src/core/install/host/systemd/render.ts';
import {
	asService,
	BUN_PIN,
	EL10_SUBS_DIST,
	freshRequest,
	HOST_VARIANTS,
	type HostVariant,
	hostFiles,
	hostResponses,
	INSTANCE,
	laterRequest,
	loggedCommands,
	mintCertificate,
	productionPlan,
	productionPlanCtx,
	REPO_ROOT,
	runHost,
	SCRATCH_DIR,
	type ScratchHost,
	SERVER_NAME,
	sourceFiles,
	variantName,
} from '../helpers/install_host_scratch.ts';

const scratchBase = mkdtempSync(join(tmpdir(), 'dedalo_install_host_selinux_'));
afterAll(() => rmSync(scratchBase, { recursive: true, force: true }));

const CERT = mintCertificate(SERVER_NAME);
const MODULE = '/var/lib/dedalo-install/selinux/dedalo_engine.cil';
const TEMPLATE = readFileSync(join(REPO_ROOT, 'deploy/selinux/dedalo_engine.cil.tpl'), 'utf8');
const OURS = TEMPLATE.replace('@@STAMP@@', 'dedalo-install');
const HOME_DIR = `/home/ded_${INSTANCE}`;
const FAKE_RUNTIME = "not a runtime — the scratch host's stand-in\n";

const EL = (tls: 'letsencrypt' | 'files', web: 'nginx' | 'apache' = 'nginx') =>
	HOST_VARIANTS.find(
		(variant) => variant.os === 'el10' && variant.web === web && variant.tls === tls,
	) as HostVariant;

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

function scratchHost(
	variant: HostVariant,
	options: { files?: ReadonlyMap<string, string>; responses?: readonly RecordedResponse[] } = {},
): ScratchHost {
	counter += 1;
	const base = join(scratchBase, `h${counter}`);
	const root = join(base, 'root');
	const source = join(base, 'source');
	plant(root, hostFiles(variant, CERT));
	plant(source, sourceFiles());
	plant(root, options.files ?? new Map());
	mkdirSync(join(root, SCRATCH_DIR), { recursive: true });
	writeFileSync(
		join(root, SCRATCH_DIR, 'responses.json'),
		JSON.stringify([...(options.responses ?? []), ...hostResponses(variant)]),
	);
	return { root, source };
}

/** The SELinux commands a run logged (semanage, restorecon, semodule, setsebool). */
function selinuxLog(host: ScratchHost, from = 0): string[] {
	return loggedCommands(host.root)
		.slice(from)
		.filter((line) => /\/(semanage|restorecon|semodule|setsebool) /.test(line))
		.filter((line) => !/ -l( -C)?$/.test(line));
}

/** Another instance on the host that uses the module (the registry entry). */
function otherInstance(selinuxModule: boolean): Map<string, string> {
	return new Map([
		[
			'/var/lib/dedalo-install/instances/other.json',
			`${JSON.stringify({ instance: 'other', bun_pin: BUN_PIN, templates: false, selinux_module: selinuxModule, nginx_map_owner: false, media: '/srv/dedalo/other/dedalo/media' }, null, '\t')}\n`,
		],
	]);
}

describe('SELinux contexts and the one policy rule (a, b)', () => {
	for (const variant of [EL('letsencrypt'), EL('files', 'apache')]) {
		test(`${variantName(variant)}: the contexts, the relabel, the stamped module — the install folder's subtrees var_lib_t relabelled AS THE SERVICE USER, no boolean`, async () => {
			const host = scratchHost(variant);
			const { planFile } = productionPlan(variant);
			expect((await runHost(host, freshRequest(planFile))).outcome.result).toBe('complete');
			const acme = variant.tls === 'letsencrypt';
			expect(selinuxLog(host)).toEqual([
				`/usr/sbin/semanage fcontext -a -t httpd_var_run_t /run/dedalo-${INSTANCE}(/.*)?`,
				`/usr/sbin/semanage fcontext -a -t httpd_sys_content_t /srv/dedalo/${INSTANCE}(/.*)?`,
				...(acme
					? [
							`/usr/sbin/semanage fcontext -a -t httpd_sys_content_t /var/lib/dedalo-install/acme/${INSTANCE}(/.*)?`,
						]
					: []),
				`/usr/sbin/semanage fcontext -a -t var_lib_t ${HOME_DIR}`,
				`/usr/sbin/semanage fcontext -a -t var_lib_t ${HOME_DIR}/dedalo(/.*)?`,
				`/usr/sbin/semanage fcontext -a -t var_lib_t ${HOME_DIR}/private(/.*)?`,
				`/usr/sbin/semanage fcontext -a -t var_lib_t ${HOME_DIR}/backups(/.*)?`,
				`/usr/sbin/restorecon -RF /srv/dedalo/${INSTANCE}`,
				...(acme ? [`/usr/sbin/restorecon -RF /var/lib/dedalo-install/acme/${INSTANCE}`] : []),
				// The folder this install created (root's, under root's /home): itself only.
				`/usr/sbin/restorecon -F ${HOME_DIR}`,
				`${asService()} /usr/sbin/restorecon -RF ${HOME_DIR}/dedalo`,
				`${asService()} /usr/sbin/restorecon -RF ${HOME_DIR}/private`,
				`${asService()} /usr/sbin/restorecon -RF ${HOME_DIR}/backups`,
				`/usr/sbin/semodule -X 400 -i ${MODULE}`,
				`/usr/sbin/restorecon -F /opt/dedalo/bun/${BUN_PIN}/bun`,
			]);
			const fs = hostFs(host.root, join(host.root, SCRATCH_DIR, 'owners.json'));
			expect(fs.readText(MODULE)).toBe(OURS);
			expect(fs.stat(MODULE)?.mode).toBe(0o600);
			expect(fs.stat(MODULE)?.owner).toBe('root');
			expect(OURS).toContain('; stamp: dedalo-install');
			expect(OURS).not.toContain('@@');
			// No boolean; ROOT relabels nothing inside the folder (only the folder itself), and
			// nothing relabels /home or the account's other files.
			expect(loggedCommands(host.root).filter((line) => /setsebool/.test(line))).toEqual([]);
			expect(
				loggedCommands(host.root).filter((line) =>
					/^\/usr\/sbin\/restorecon -R?F \/home\/ded_[^/ ]+\//.test(line),
				),
			).toEqual([]);
			expect(
				loggedCommands(host.root).filter((line) => /restorecon .*\/home\/?$/.test(line)),
			).toEqual([]);
		});
	}
});

// ── (b) what the module GRANTS ───────────────────────────────────────────────

type Sexp = string | Sexp[];

/** The module's statements: top-level s-expressions, comments (`;` to end of line) out. */
function statements(cil: string): Sexp[] {
	const tokens =
		cil
			.split('\n')
			.map((line) => line.replace(/;.*$/, ''))
			.join('\n')
			.match(/"[^"]*"|[()]|[^\s()]+/g) ?? [];
	const stack: Sexp[][] = [[]];
	for (const token of tokens) {
		if (token === '(') stack.push([]);
		else if (token === ')') {
			const done = stack.pop() as Sexp[];
			(stack.at(-1) as Sexp[]).push(done);
		} else (stack.at(-1) as Sexp[]).push(token.replace(/^"(.*)"$/, '$1'));
	}
	return stack[0] as Sexp[];
}

function atoms(node: Sexp): string[] {
	return typeof node === 'string' ? [node] : node.flatMap(atoms);
}

/** Every `allow` statement, wherever it sits (a booleanif body included). */
function allows(node: Sexp): Sexp[][] {
	if (typeof node === 'string') return [];
	return [...(node[0] === 'allow' ? [node] : []), ...node.flatMap(allows)];
}

/** The engine runtime paths a filecon regex must NOT label (anything else that runs). */
const NOT_THE_ENGINE = (bunDir: string, binDir: string, tree: string): string[] => [
	'/usr/bin/bash',
	'/usr/bin/bun',
	`${binDir}/dedalo-backup-step.sh`,
	`${tree}/node_modules/.bin/bun`,
	`${bunDir}/bunx`,
	`${bunDir}/bun.bak`,
];

/**
 * Why a module does not reach the engine and only the engine, or [] —
 * evaluated for every production variant's real layout and ExecStart.
 */
function moduleProblems(cil: string): string[] {
	const problems: string[] = [];
	const all = statements(cil);
	const declared = new Set(
		all.flatMap((node) => (Array.isArray(node) && node[0] === 'type' ? [node[1] as string] : [])),
	);
	if (all.some((node) => atoms(node).includes('unconfined_service_t')))
		problems.push('a statement names unconfined_service_t (every service in that domain)');
	const connects = all
		.flatMap(allows)
		.filter(
			(rule) => atoms(rule).includes('unix_stream_socket') && atoms(rule).includes('connectto'),
		);
	if (connects.length === 0) problems.push('no unix_stream_socket connectto rule');
	for (const rule of connects) {
		const [, source, target] = rule as string[];
		if (source !== 'httpd_t') problems.push(`connectto from ${source}, not httpd_t`);
		if (!declared.has(target as string))
			problems.push(`connectto to ${target}, a type this module does not declare`);
	}
	const transitions = all.filter(
		(node): node is string[] =>
			Array.isArray(node) &&
			node[0] === 'typetransition' &&
			node[1] === 'init_t' &&
			node[3] === 'process',
	);
	if (transitions.length !== 1) {
		problems.push(`${transitions.length} init_t process typetransitions, not exactly one`);
		return problems;
	}
	const [, , execType, , domain] = transitions[0] as string[];
	for (const rule of connects)
		if (rule[2] !== domain)
			problems.push(`connectto to ${rule[2]}, not the engine domain ${domain}`);
	if (!declared.has(domain as string) || !declared.has(execType as string))
		problems.push(
			`the transition ${execType} → ${domain} names a type the module does not declare`,
		);
	const filecons = all.filter(
		(node): node is Sexp[] => Array.isArray(node) && node[0] === 'filecon',
	);
	if (filecons.length !== 1 || !atoms(filecons[0] as Sexp).includes(execType as string)) {
		problems.push(`not exactly one filecon giving ${execType}`);
		return problems;
	}
	const pattern = new RegExp(`^${(filecons[0] as string[])[1]}$`);
	for (const variant of HOST_VARIANTS) {
		const { paths, answers } = productionPlanCtx(variant);
		const execStart = serverDropin(paths, answers, '#')
			.split('\n')
			.filter((line) => line.startsWith('ExecStart='))
			.at(-1);
		if (!execStart?.startsWith(`ExecStart=${paths.bun} `))
			problems.push(`${variantName(variant)}: dedalo-ts@ does not run ${paths.bun}`);
		if (!pattern.test(paths.bun))
			problems.push(`${variantName(variant)}: the filecon does not label ${paths.bun}`);
		for (const other of NOT_THE_ENGINE(paths.bunDir, paths.binDir, paths.tree))
			if (pattern.test(other)) problems.push(`the filecon also labels ${other}`);
	}
	return problems;
}

describe("the socket rule in the spelling the host's policy accepts (a — campaign 3 C3-3)", () => {
	const EL9_STYLE = '/run /var/run\n';
	test('EL 10 (`/var/run /run`): /run/…; an EL 9-style policy (`/run /var/run`): /var/run/…; no equivalence: as written', () => {
		expect(canonicalSpelling('/run/dedalo-x', parseSubs(EL10_SUBS_DIST))).toBe('/run/dedalo-x');
		expect(canonicalSpelling('/var/run/dedalo-x', parseSubs(EL10_SUBS_DIST))).toBe('/run/dedalo-x');
		expect(canonicalSpelling('/run/dedalo-x', parseSubs(EL9_STYLE))).toBe('/var/run/dedalo-x');
		expect(canonicalSpelling('/run/dedalo-x', [])).toBe('/run/dedalo-x');
		// A path that only SHARES a prefix string is not under the alias.
		expect(canonicalSpelling('/var/runner/x', parseSubs(EL10_SUBS_DIST))).toBe('/var/runner/x');
	});

	test('the plan: the socket spec follows the FACTS — /run/ on EL 10, the target side elsewhere', () => {
		const base = productionPlanCtx(EL('files'));
		const spec = (subs: string, socketDir = base.paths.socketDir) =>
			fcontextRules({
				...base,
				facts: { ...base.facts, selinux: 'enforcing', selinuxSubs: parseSubs(subs) },
				paths: { ...base.paths, socketDir },
			})[0]?.spec;
		expect(spec(EL10_SUBS_DIST)).toBe(`/run/dedalo-${INSTANCE}(/.*)?`);
		expect(spec(EL10_SUBS_DIST, `/var/run/dedalo-${INSTANCE}`)).toBe(
			`/run/dedalo-${INSTANCE}(/.*)?`,
		);
		expect(spec(EL9_STYLE)).toBe(`/var/run/dedalo-${INSTANCE}(/.*)?`);
	});

	test('a rule an operator wrote in the other spelling: verify accepts it, the run adds no second one', async () => {
		const variant = EL('files');
		const other = `/var/run/dedalo-${INSTANCE}(/.*)?  all files  system_u:object_r:httpd_var_run_t:s0`;
		const host = scratchHost(variant, {
			responses: [
				{
					match: '/usr/sbin/semanage fcontext -l -C',
					after: '/usr/sbin/semanage fcontext -a',
					stdout: [
						other,
						...[`/srv/dedalo/${INSTANCE}(/.*)?`, HOME_DIR].map((x) => `${x}  all files  x`),
						...['dedalo', 'private', 'backups'].map(
							(name) => `${HOME_DIR}/${name}(/.*)?  all files  x`,
						),
					].join('\n'),
				},
				{ match: '/usr/sbin/semanage fcontext -l -C', stdout: other },
			],
		});
		const { planFile } = productionPlan(variant);
		const { outcome } = await runHost(host, freshRequest(planFile));
		expect(outcome.result).toBe('complete');
		expect(selinuxLog(host).filter((line) => line.includes('httpd_var_run_t'))).toEqual([]);
	});

	test('a refused add (the claim saved before it): --abort deletes no rule the host never defined', async () => {
		const variant = EL('letsencrypt');
		const host = scratchHost(variant, {
			responses: [
				{
					match: '/usr/sbin/semanage fcontext -a -t httpd_var_run_t',
					exit: 1,
					stderr: "ValueError: File spec conflicts with equivalency rule '/var/run /run'",
				},
				{ match: '/usr/sbin/semanage fcontext -l -C', stdout: '' },
			],
		});
		const { plan, planFile } = productionPlan(variant);
		const first = await runHost(host, freshRequest(planFile));
		expect(first.outcome.failedStep).toBe('host_selinux');
		// The claim WAS saved (kill-safety) — the abort must still delete nothing.
		const state = JSON.parse(
			readFileSync(
				join(host.root, `/var/lib/dedalo-install/${INSTANCE}/install.state.json`),
				'utf8',
			),
		) as { created: { host: { selinux_fcontexts: string[] } } };
		expect(state.created.host.selinux_fcontexts.length).toBe(7);
		const before = loggedCommands(host.root).length;
		// The instance never started (host_first_boot not reached): the abort is a FULL one
		// (C3-11), so it asks the database name back.
		const db = String(plan.answers.db_database);
		expect((await runHost(host, laterRequest('abort', plan, db))).outcome.result).toBe('aborted');
		expect(selinuxLog(host, before).filter((line) => line.includes('fcontext -d'))).toEqual([]);
	});
});

describe('the module reaches the engine and only the engine (b)', () => {
	test("the source tree the step reads holds the module (the scratch host's planted files)", () => {
		const planted = sourceFiles();
		expect(planted.size).toBeGreaterThan(9);
		expect(planted.get('deploy/selinux/dedalo_engine.cil.tpl')).toBe(TEMPLATE);
	});

	test('the shipped module: no problem', () => {
		expect(statements(OURS).length).toBeGreaterThan(20);
		expect(moduleProblems(OURS)).toEqual([]);
	});

	test('positive control: the earlier module (httpd_t → unconfined_service_t) is caught', () => {
		const broad =
			'; stamp: x\n(allow httpd_t unconfined_service_t (unix_stream_socket (connectto)))\n';
		const problems = moduleProblems(broad);
		expect(problems).toContain(
			'a statement names unconfined_service_t (every service in that domain)',
		);
		expect(problems).toContain(
			'connectto to unconfined_service_t, a type this module does not declare',
		);
		// …and a domain of its own whose filecon also labels a shell is caught too.
		const wide = OURS.replace(
			'"/opt/dedalo/bun/[^/]+/bun"',
			'"/(opt/dedalo/bun/[^/]+/bun|usr/bin/bash)"',
		);
		expect(wide).not.toBe(OURS);
		expect([...new Set(moduleProblems(wide))]).toEqual(['the filecon also labels /usr/bin/bash']);
	});

	test('the runtime left unlabelled: host_selinux verify refuses it', async () => {
		const variant = EL('files');
		const host = scratchHost(variant, {
			responses: [
				{
					match: `/usr/bin/stat -c %C /opt/dedalo/bun/${BUN_PIN}/bun`,
					stdout: 'system_u:object_r:usr_t:s0\n',
				},
			],
		});
		const { planFile } = productionPlan(variant);
		const { outcome } = await runHost(host, freshRequest(planFile));
		expect(outcome.failedStep).toBe('host_selinux');
		expect(outcome.message).toContain('is not labelled dedalo_engine_exec_t');
	});

	test('the engine started in any other domain: host_first_boot refuses (read from the process)', async () => {
		const variant = EL('letsencrypt');
		const host = scratchHost(variant, {
			responses: [
				{
					match: '/usr/bin/ps -o label= -p 4242',
					stdout: 'system_u:system_r:unconfined_service_t:s0\n',
				},
			],
		});
		const { planFile } = productionPlan(variant);
		const { outcome } = await runHost(host, freshRequest(planFile));
		expect(outcome.failedStep).toBe('host_first_boot');
		expect(outcome.message).toContain(
			'runs as system_u:system_r:unconfined_service_t:s0, not dedalo_engine_t',
		);
	});
});

describe('a foreign module of the same name is refused (c)', () => {
	test('dedalo_engine loaded, but not the bytes this installer writes: refused, never replaced', async () => {
		const variant = EL('letsencrypt');
		const foreign = '(allow httpd_t user_home_t (dir (read)))\n';
		const host = scratchHost(variant, {
			files: new Map([[MODULE, foreign]]),
			responses: [{ match: '/usr/sbin/semodule -l', stdout: 'dedalo_engine\n' }],
		});
		const { planFile } = productionPlan(variant);
		const { outcome } = await runHost(host, freshRequest(planFile));
		expect(outcome.failedStep).toBe('host_selinux');
		expect(outcome.message).toContain(
			'an SELinux module named dedalo_engine is loaded that this installer did not write',
		);
		expect(selinuxLog(host).filter((line) => line.includes('semodule -X 400 -i'))).toEqual([]);
		expect(readFileSync(join(host.root, MODULE), 'utf8')).toBe(foreign);
	});
});

describe('refcounted undo (d)', () => {
	test('this install loaded the module and is alone: --abort removes its contexts AND the module', async () => {
		const variant = EL('letsencrypt');
		const host = scratchHost(variant);
		const { plan, planFile } = productionPlan(variant);
		expect((await runHost(host, freshRequest(planFile))).outcome.result).toBe('complete');
		// The runtime on disk (the recording runner's `install` writes no file).
		plant(host.root, new Map([[`/opt/dedalo/bun/${BUN_PIN}/bun`, FAKE_RUNTIME]]));
		const before = loggedCommands(host.root).length;
		expect((await runHost(host, laterRequest('abort', plan))).outcome.result).toBe('aborted');
		const undone = selinuxLog(host, before);
		expect(undone.filter((line) => line.includes('fcontext -d')).length).toBe(7);
		expect(undone).toContain('/usr/sbin/semodule -X 400 -r dedalo_engine');
		// The runtime's label named the unloaded type: relabelled to its default.
		expect(undone).toContain(`/usr/sbin/restorecon -F /opt/dedalo/bun/${BUN_PIN}/bun`);
		expect(() => readFileSync(join(host.root, MODULE))).toThrow();
	});

	test("another instance came to use the module since: --abort removes only this instance's contexts", async () => {
		const variant = EL('letsencrypt');
		const host = scratchHost(variant);
		const { plan, planFile } = productionPlan(variant);
		expect((await runHost(host, freshRequest(planFile))).outcome.result).toBe('complete');
		plant(host.root, otherInstance(true));
		const before = loggedCommands(host.root).length;
		expect((await runHost(host, laterRequest('abort', plan))).outcome.result).toBe('aborted');
		const undone = selinuxLog(host, before);
		expect(undone.filter((line) => line.includes('fcontext -d')).length).toBe(7);
		expect(undone.filter((line) => line.includes('semodule -X 400 -r'))).toEqual([]);
		expect(readFileSync(join(host.root, MODULE), 'utf8')).toBe(OURS);
	});

	test('the module was there before this install (another instance loaded it): never removed by this one', async () => {
		const variant = EL('files');
		const host = scratchHost(variant, {
			files: new Map([...otherInstance(true), [MODULE, OURS]]),
			responses: [{ match: '/usr/sbin/semodule -l', stdout: 'dedalo_engine\n' }],
		});
		const { plan, planFile } = productionPlan(variant);
		expect((await runHost(host, freshRequest(planFile))).outcome.result).toBe('complete');
		const before = loggedCommands(host.root).length;
		plant(host.root, otherInstance(false));
		expect((await runHost(host, laterRequest('abort', plan))).outcome.result).toBe('aborted');
		expect(selinuxLog(host, before).filter((line) => line.includes('semodule -X 400 -r'))).toEqual(
			[],
		);
		expect(readFileSync(join(host.root, MODULE), 'utf8')).toBe(OURS);
	});
});

describe('off the RHEL family, or with SELinux disabled, nothing runs (e)', () => {
	test('Debian: no SELinux command at all', async () => {
		const variant = HOST_VARIANTS.find((item) => item.os === 'debian13') as HostVariant;
		const host = scratchHost(variant);
		const { planFile } = productionPlan(variant);
		expect((await runHost(host, freshRequest(planFile))).outcome.result).toBe('complete');
		expect(selinuxLog(host)).toEqual([]);
	});

	test('EL with SELinux disabled: no SELinux command at all', async () => {
		const variant = EL('files');
		const host = scratchHost(variant, {
			responses: [{ match: '/usr/sbin/getenforce', stdout: 'Disabled\n' }],
		});
		const { planFile } = productionPlan(variant);
		expect((await runHost(host, freshRequest(planFile))).outcome.result).toBe('complete');
		expect(selinuxLog(host)).toEqual([]);
	});
});
