/**
 * THE INSTALL FOLDER, THE SERVICE USER AND THE SERVICE GROUP OF A PRODUCTION
 * INSTALL (owner decisions 2026-10-12; src/core/install/host/production/
 * {identity_rules,account_facts,instances,identity}.ts, layout.ts pathsFor,
 * execute.ts effectiveArgv) — run through the REAL executor on a marked
 * scratch root with the RECORDING runner (test/helpers/install_host_scratch.ts:
 * its fake account table answers `getent passwd/group` and `id -G/-Gn`;
 * nothing executes — no useradd, no chown, no rm ever runs here).
 *
 * WHAT IS MEASURED (outcomes — the argv the run logged, the scratch tree's
 * stat and bytes, the record the run froze — never spellings):
 *  (a) DEFAULTS: a new system account ded_<i> with its own group; every
 *      command as the service user runs `runuser -u <u> -g <g> --`.
 *  (b) A NEW ACCOUNT OF THE OPERATOR'S NAMING (`site_a`, a typed group of its
 *      own `webgrp` created by groupadd) in a folder below missing parents:
 *      the parents ROOT's 0755, the folder the user's 0750; a FAILED install's
 *      --abort removes the user AND the group it created.
 *  (c) AN EXISTING HOSTING ACCOUNT (`drill.example.org`, login shell, its
 *      primary group) USED AS IS: no useradd/groupadd/userdel/groupdel in the
 *      run OR the abort; its home's stat and its other files byte-equal after
 *      both; the folder is made BY the user (its parent is the user's); the
 *      Review TELLS the login shell and the web user joining its primary
 *      group; the engine child's database role is the account (critique B3).
 *  (d) ROOT NEVER WORKS BY PATH INSIDE THE FOLDER (critique B1): over every
 *      layout, no command the Review lists for root, and no argv the run
 *      logged outside `runuser`, names a path strictly inside the install
 *      folder.
 *  (e) ONE USER, ONE GROUP, ONE FOLDER PER INSTANCE: another instance's user,
 *      group, the same folder, a folder inside it or containing it — through
 *      EACH of the four discovery sources (the registry, a stamped drop-in, a
 *      live run record, a hand-installed unit) — refused at host_preflight with
 *      the exact sentence naming the source, nothing on the host changed, no
 *      record of anything created; an ABORTED run record is no clash; a
 *      stamped drop-in without User= is refused with its path; a hand-installed
 *      unit without Group= is its User='s primary group (unresolvable: refused
 *      with its path) and is another install even when named like this one.
 *  (f) THE FOLDER: a root-owned parent is never changed; an empty foreign
 *      folder under root's parents is ADOPTED and handed back by --abort (a
 *      mount point); the user's own non-empty folder is used as it is (mode
 *      and content unchanged); refused — another account's non-empty folder,
 *      a folder holding an install's remains, a go+w folder, an empty foreign
 *      folder under a user-owned parent, an ancestor of another account, a
 *      symlinked path, an unsearchable ancestor, an empty OS directory of root
 *      (/var/mail), another account's empty folder, a package's account; a
 *      typed backup dir that exists inside the user's folder (never re-moded).
 *  (g) THE ACCOUNT RULES (the one verdict, pure, every sentence exact): uid 0,
 *      a system uid, `nobody`, a privileged supplementary group (by gid and by
 *      name; `users` harmless), gid 0, a system group, the web server's own
 *      group, a defaulted leftover group, a dotted name to be CREATED, a folder
 *      inside a served site root, a package's account or group, membership of
 *      another instance's group — and the notices (login shell, primary
 *      group — by the resulting group, typed or defaulted —, other members). Wired: uid 0 and a leftover group refused at
 *      the scratch host's System check too.
 *  (i) BETWEEN THE SYSTEM CHECK AND THE RUN: an account a package creates
 *      meanwhile is refused at host_identity, never recorded or removed; an
 *      fcontext rule defined before the install is neither added nor deleted.
 *  (h) THE FROZEN DIGEST HOLDS THE RESOLVED GROUP (critique B2): a resume of
 *      an install killed after host_preflight is accepted for a typed group
 *      and for an existing account's primary group (it would be refused as
 *      "not the commands this install showed" otherwise).
 *
 *  (j) THE NAME OF AN INSTALLED INSTANCE (campaign 3d C3d-F1): its registry
 *      entry or stamped drop-in → ONE refusal naming the instance and the file,
 *      never its account as "an earlier install's leftover" to userdel; nor
 *      another instance's account typed as the service user.
 *
 * The 0555 root-owned parent the owner named cannot be planted here (the
 * scratch root is written by a non-root process): scripts/install_host_drill.ts
 * --layout custom measures it on a real host.
 *
 * DB-FREE, network-free (the hermetic tier runs it).
 */

import { afterAll, describe, expect, test } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { HostCommand, HostPlanCtx } from '../../src/core/install/host/contract.ts';
import { hostFs } from '../../src/core/install/host/fs.ts';
import { hostTable } from '../../src/core/install/host/host_table.ts';
import { pathsFor } from '../../src/core/install/host/layout.ts';
import { osRowById } from '../../src/core/install/host/os_support.ts';
import {
	type AccountFacts,
	type PathFact,
	pendingAccountFacts,
} from '../../src/core/install/host/production/account_facts.ts';
import { engineAnswers } from '../../src/core/install/host/production/engine_delegate.ts';
import {
	type IdentityInput,
	identityVerdict,
	instanceTakenSentence,
} from '../../src/core/install/host/production/identity_rules.ts';
import { otherInstances } from '../../src/core/install/host/production/instances.ts';
import type { RecordedResponse } from '../../src/core/install/host/runner.ts';
import { identityLines } from '../../src/core/install/identity_verdict.ts';
import {
	buildInstallPlan,
	type HostStepId,
	normalizeInstallAnswers,
} from '../../src/core/install/install_plan.ts';
import { readPlanFile, readStateFile } from '../../src/core/install/run_files_core.ts';
import {
	asService,
	asServiceHome,
	asServiceHomeDying,
	BUN_PIN,
	changesHost,
	DEFAULT_IDENTITY,
	DIES_WITH_PARENT,
	freshRequest,
	HOST_VARIANTS,
	type HostVariant,
	hostFiles,
	hostResponses,
	INSTANCE,
	laterRequest,
	loggedCommands,
	mintCertificate,
	plantOwned,
	productionPlan,
	productionRaw,
	REPO_ROOT,
	ROOT_PASSWORD,
	runHost,
	SCRATCH_DIR,
	type ScratchHost,
	type ScratchIdentity,
	SERVER_NAME,
	sourceFiles,
} from '../helpers/install_host_scratch.ts';

const scratchBase = mkdtempSync(join(tmpdir(), 'dedalo_install_host_identity_'));
afterAll(() => rmSync(scratchBase, { recursive: true, force: true }));

const CERT = mintCertificate(SERVER_NAME);
const RUN_DIR = `/var/lib/dedalo-install/${INSTANCE}`;
const DB = `dedalo_${INSTANCE}`;
const UBUNTU = HOST_VARIANTS[0] as HostVariant; // ubuntu2604 + nginx + letsencrypt
const EL = HOST_VARIANTS.find(
	(variant) => variant.os === 'el10' && variant.web === 'nginx' && variant.tls === 'files',
) as HostVariant;

/** A new account of the operator's naming, a typed group of its own, a folder below missing parents. */
const SITE_A: ScratchIdentity = Object.freeze({
	user: 'site_a',
	group: 'webgrp',
	dir: '/srv/apps/a/dedalo',
	uid: 998,
	gid: 997,
	shell: '/usr/sbin/nologin',
	existing: false,
});
const SITE_A_ANSWERS = { install_dir: SITE_A.dir, service_user: 'site_a', service_group: 'webgrp' };

/** An existing hosting account (login shell, its own primary group), used as it is. */
const HOSTING: ScratchIdentity = Object.freeze({
	user: 'drill.example.org',
	group: 'drill.example.org',
	dir: '/home/drill.example.org/dedalo',
	home: '/home/drill.example.org',
	uid: 1500,
	gid: 1500,
	shell: '/bin/bash',
	existing: true,
});
const HOSTING_ANSWERS = { install_dir: HOSTING.dir, service_user: HOSTING.user };

/** The hosting account's home and its own files (never touched by the installer). */
const HOSTING_DECOYS: readonly [string, string][] = [
	['/home/drill.example.org/notes.txt', 'the account owner’s notes\n'],
	['/home/drill.example.org/.ssh/authorized_keys', 'ssh-ed25519 AAAA drill\n'],
];

// ── planting ─────────────────────────────────────────────────────────────────

interface Owned {
	owner: string;
	group: string;
	mode: number;
	content?: string;
}

interface PlantSpec {
	identity?: ScratchIdentity;
	files?: ReadonlyMap<string, string>;
	owned?: readonly [string, Owned][];
	responses?: readonly RecordedResponse[];
	/** Symbolic links to plant: [link host path, target (relative)]. */
	links?: readonly [string, string][];
}

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

/** A planted scratch host of `variant`. */
function scratchHost(variant: HostVariant, spec: PlantSpec = {}): ScratchHost {
	counter += 1;
	const base = join(scratchBase, `h${counter}`);
	const root = join(base, 'root');
	const source = join(base, 'source');
	plant(root, hostFiles(variant, CERT));
	plant(source, sourceFiles());
	plant(root, spec.files ?? new Map());
	for (const [path, owned] of spec.owned ?? []) plantOwned(root, path, owned);
	for (const [link, target] of spec.links ?? []) symlinkSync(target, join(root, link));
	mkdirSync(join(root, SCRATCH_DIR), { recursive: true });
	writeFileSync(
		join(root, SCRATCH_DIR, 'responses.json'),
		JSON.stringify([
			...(spec.responses ?? []),
			...hostResponses(variant, spec.identity ?? DEFAULT_IDENTITY),
		]),
	);
	return { root, source };
}

/** The hosting account's home, planted with its own files (owner 1500, 0750). */
function hostingOwned(): [string, Owned][] {
	const own = { owner: HOSTING.user, group: HOSTING.group };
	return [
		['/home/drill.example.org', { ...own, mode: 0o750 }],
		...HOSTING_DECOYS.map(([path, content]): [string, Owned] => [
			path,
			{ ...own, mode: 0o600, content },
		]),
	];
}

/** A host path's stat as the scratch HostFs reports it (owner from the sidecar). */
function statOf(host: ScratchHost, path: string) {
	const stat = hostFs(host.root, join(host.root, SCRATCH_DIR, 'owners.json')).stat(path);
	return stat === null ? null : { owner: stat.owner, group: stat.group, mode: stat.mode };
}

/** A host file's bytes (null: absent). */
function bytesOf(host: ScratchHost, path: string): string | null {
	try {
		return readFileSync(join(host.root, path), 'utf8');
	} catch {
		return null;
	}
}

/** The engine child failing its run (a failed install: an abort is then a FULL one). */
function engineFails(identity: ScratchIdentity): RecordedResponse[] {
	const child = `${asServiceHome(identity)} /opt/dedalo/bun/${BUN_PIN}/bun run ${identity.dir}/dedalo/scripts/install.ts`;
	const dying = `${asServiceHomeDying(identity)} /opt/dedalo/bun/${BUN_PIN}/bun run ${identity.dir}/dedalo/scripts/install.ts`;
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

/** A fresh run of `extra` on a planted host. */
async function freshOn(variant: HostVariant, spec: PlantSpec, extra: Record<string, unknown>) {
	const host = scratchHost(variant, spec);
	const { plan, planFile } = productionPlan(variant, extra);
	const { outcome, transcript } = await runHost(host, freshRequest(planFile));
	return { host, plan, outcome, transcript };
}

/** The host-changing commands a run logged. */
function changed(host: ScratchHost): string[] {
	return loggedCommands(host.root).filter(changesHost);
}

/** The plan context the run FROZE (its plan file + the preflight's facts, the group resolved). */
function frozenContext(host: ScratchHost): HostPlanCtx {
	const dir = join(host.root, RUN_DIR);
	const plan = readPlanFile(dir);
	const facts = readStateFile(dir)?.preflight.host?.facts;
	if (plan === null || facts === undefined || facts.os === null) throw new Error('no frozen run');
	const answers = normalizeInstallAnswers(plan.answers as Record<string, unknown>).answers;
	return {
		plan,
		answers,
		facts,
		row: osRowById(facts.os),
		paths: pathsFor(answers, BUN_PIN, facts),
		source: host.source,
	};
}

/** Every command the Review lists for the frozen plan. */
function reviewCommands(ctx: HostPlanCtx): HostCommand[] {
	const table = hostTable(() => ({ ...ctx, bunPin: BUN_PIN }));
	return (ctx.plan.steps as HostStepId[]).flatMap((step) => table[step].commands(ctx));
}

/** Strictly inside `dir` (component-wise). */
function strictlyInside(path: string, dir: string): boolean {
	return path.startsWith(`${dir}/`);
}

/** The paths a ROOT command names (mkdir/write path, or an exec word). */
function rootPaths(command: HostCommand): string[] {
	if (command.kind === 'exec') return command.as === 'instance' ? [] : [...command.argv];
	if (command.kind === 'mkdir') return command.as === 'instance' ? [] : [command.path];
	return 'path' in command && typeof command.path === 'string' ? [command.path] : [];
}

/** Critique B1: what root would touch BY PATH inside the install folder (Review + run log). */
function rootInsideFolder(host: ScratchHost): string[] {
	const ctx = frozenContext(host);
	const dir = ctx.paths.instanceDir;
	const reviewed = reviewCommands(ctx)
		.flatMap(rootPaths)
		.filter((word) => strictlyInside(word, dir))
		.map((word) => `Review: ${word}`);
	const ran = loggedCommands(host.root)
		.filter((line) => !line.replace(`${DIES_WITH_PARENT} `, '').startsWith('/usr/sbin/runuser -u '))
		.filter((line) => line.split(' ').some((word) => strictlyInside(word, dir)))
		.map((line) => `run: ${line}`);
	return [...reviewed, ...ran];
}

// ── (a) defaults ─────────────────────────────────────────────────────────────

describe('(a) the defaults: a new system account ded_<i> with its own group', () => {
	test('useradd --system --user-group, the folder /home/ded_<i>; every service command is `runuser -u ded_<i> -g ded_<i> --`', async () => {
		const { host, outcome } = await freshOn(UBUNTU, {}, {});
		expect(outcome.message).toBeNull();
		expect(outcome.result).toBe('complete');
		const log = loggedCommands(host.root);
		expect(log).toContain(
			`/usr/sbin/useradd --system --user-group --home-dir /home/ded_${INSTANCE} --no-create-home --shell /usr/sbin/nologin ded_${INSTANCE}`,
		);
		const asUser = log.filter((line) => line.startsWith(`/usr/sbin/runuser -u ded_${INSTANCE} `));
		expect(asUser.length).toBeGreaterThan(10);
		expect(asUser.filter((line) => !line.startsWith(`${asService()} `))).toEqual([]);
		expect(log.some((line) => line.startsWith('/usr/sbin/groupadd'))).toBe(false);
		expect(statOf(host, `/home/ded_${INSTANCE}`)).toEqual({
			owner: `ded_${INSTANCE}`,
			group: `ded_${INSTANCE}`,
			mode: 0o750,
		});
		expect(rootInsideFolder(host)).toEqual([]);
	});
});

// ── (b) a new account of the operator's naming ───────────────────────────────

describe("(b) a new account of the operator's naming, a typed group of its own, missing parents", () => {
	test('groupadd + useradd --gid; the parents root 0755, the folder site_a:webgrp 0750; --abort removes the user AND the group', async () => {
		const { host, plan, outcome } = await freshOn(
			UBUNTU,
			{ identity: SITE_A, responses: engineFails(SITE_A) },
			SITE_A_ANSWERS,
		);
		expect(outcome.failedStep).toBe('host_engine');
		const log = loggedCommands(host.root);
		expect(log).toContain('/usr/sbin/groupadd --system webgrp');
		expect(log).toContain(
			'/usr/sbin/useradd --system --gid webgrp --no-user-group --home-dir /srv/apps/a/dedalo --no-create-home --shell /usr/sbin/nologin site_a',
		);
		for (const parent of ['/srv/apps', '/srv/apps/a'])
			expect(statOf(host, parent), parent).toEqual({ owner: 'root', group: 'root', mode: 0o755 });
		expect(statOf(host, SITE_A.dir)).toEqual({ owner: 'site_a', group: 'webgrp', mode: 0o750 });
		expect(log.filter((line) => line.startsWith('/usr/sbin/runuser -u site_a ')).length).toBe(
			log.filter((line) => line.startsWith(`${asService(SITE_A)} `)).length,
		);
		expect(rootInsideFolder(host)).toEqual([]);
		const created = readStateFile(join(host.root, RUN_DIR))?.created.host;
		expect({ user: created?.user, group: created?.group, how: created?.install_dir?.how }).toEqual({
			user: 'site_a',
			group: 'webgrp',
			how: 'root',
		});
		const before = log.length;
		const aborted = await runHost(host, laterRequest('abort', plan, DB));
		expect(aborted.outcome.result).toBe('aborted');
		const undo = loggedCommands(host.root).slice(before);
		expect(undo).toContain('/usr/sbin/userdel site_a');
		expect(undo).toContain('/usr/sbin/groupdel webgrp');
		// The folder's content goes AS THE USER, only paths inside it; root removes nothing there.
		const removals = undo.filter((line) => /\/usr\/bin\/rm /.test(line));
		for (const line of removals.filter((item) => item.includes(SITE_A.dir)))
			expect(line.startsWith(`${asService(SITE_A)} /usr/bin/rm `), line).toBe(true);
		expect(
			undo.some((line) =>
				line.startsWith(`${asService(SITE_A)} /usr/bin/rm -rf -- ${SITE_A.dir}/`),
			),
		).toBe(true);
	});
});

// ── (c) an existing hosting account ──────────────────────────────────────────

/** The hosting account's world, as it stands (its home's stat, its files' bytes). */
function hostingWorld(host: ScratchHost): unknown {
	return {
		home: statOf(host, '/home/drill.example.org'),
		files: HOSTING_DECOYS.map(([path]) => [path, bytesOf(host, path), statOf(host, path)]),
	};
}

describe('(c) an EXISTING hosting account is used as it is — never created, changed or deleted', () => {
	test('run + abort: no useradd/groupadd/userdel/groupdel; its home and files byte-equal; the folder made BY the account', async () => {
		const host = scratchHost(UBUNTU, {
			identity: HOSTING,
			owned: hostingOwned(),
			responses: engineFails(HOSTING),
		});
		const world = hostingWorld(host);
		const { plan, planFile } = productionPlan(UBUNTU, HOSTING_ANSWERS);
		const fresh = await runHost(host, freshRequest(planFile));
		expect(fresh.outcome.failedStep).toBe('host_engine');
		expect(statOf(host, HOSTING.dir)).toEqual({
			owner: HOSTING.user,
			group: HOSTING.group,
			mode: 0o750,
		});
		expect(loggedCommands(host.root)).toContain(
			`${asService(HOSTING)} /usr/bin/install -d -m 0750 ${HOSTING.dir}`,
		);
		// Every Bun the account runs gets the FOLDER as HOME on argv (runuser resets
		// HOME to the account's own home, which would then collect Bun's caches).
		const bunRuns = loggedCommands(host.root).filter(
			(line) => line.startsWith(`${asService(HOSTING)} `) && line.includes('/bun '),
		);
		expect(bunRuns.length).toBeGreaterThanOrEqual(2);
		expect(bunRuns.filter((line) => !line.startsWith(`${asServiceHome(HOSTING)} `))).toEqual([]);
		expect(rootInsideFolder(host)).toEqual([]);
		// Told, never refused: the login shell; the web user joining the account's primary group.
		const told = fresh.transcript.told.join('\n');
		expect(told).toContain(
			'account drill.example.org has a login shell (/bin/bash): whoever logs in as it can change the code the service runs',
		);
		expect(told).toContain(
			`joins drill.example.org, the primary group of drill.example.org: it can then read whatever that group can read — a group of its own is recommended (--service-group ded_${INSTANCE})`,
		);
		const created = readStateFile(join(host.root, RUN_DIR))?.created.host;
		expect({ user: created?.user, group: created?.group }).toEqual({ user: null, group: null });
		const aborted = await runHost(host, laterRequest('abort', plan, DB));
		expect(aborted.outcome.result).toBe('aborted');
		const log = loggedCommands(host.root);
		expect(log.filter((line) => /\/(useradd|groupadd|userdel|groupdel) /.test(line))).toEqual([]);
		expect(aborted.transcript.lines.join('\n')).toContain(
			'user drill.example.org USED AS IS — never removed by the installer',
		);
		expect(hostingWorld(host)).toEqual(world);
		// Root removes nothing under the account's home; the user's own removal stays inside the folder.
		expect(log.filter((line) => /^\/usr\/bin\/rm .*\/home\//.test(line))).toEqual([]);
		for (const line of log.filter((item) => item.startsWith(`${asService(HOSTING)} /usr/bin/rm `)))
			expect(
				line
					.split(' ')
					.filter((word) => word.startsWith('/home/'))
					.every((word) => strictlyInside(word, HOSTING.dir) || word === HOSTING.dir),
				line,
			).toBe(true);
	});

	test('the engine child is handed the account as its database role (critique B3), and its plan accepts it', () => {
		// Whatever the plan record carries (here: a record without the derived role), the
		// child receives the NORMALIZED role — it never re-derives ded_<i> (it has no
		// service_user: host-only).
		const { plan, planFile } = productionPlan(UBUNTU, HOSTING_ANSWERS);
		expect(plan.errors).toEqual([]);
		const { db_username: _derived, ...recorded } = planFile.answers as Record<string, unknown>;
		const ctx = {
			plan: { ...planFile, answers: recorded },
			answers: plan.answers,
			row: osRowById('ubuntu2604'),
		} as unknown as HostPlanCtx;
		const child = engineAnswers(ctx);
		expect(child.db_username).toBe(HOSTING.user);
		expect('service_user' in child || 'install_dir' in child || 'service_group' in child).toBe(
			false,
		);
		const childPlan = buildInstallPlan(child as Record<string, unknown>, {
			rootPassword: ROOT_PASSWORD,
			requireRootPassword: true,
		});
		expect(childPlan.errors).toEqual([]);
		expect(childPlan.answers.db_username).toBe(HOSTING.user);
	});

	test('EL 10: the folder subtrees labelled by ESCAPED specs, relabelled AS the account; neither its home nor /home relabelled', async () => {
		const { host, outcome } = await freshOn(
			EL,
			{ identity: HOSTING, owned: hostingOwned() },
			HOSTING_ANSWERS,
		);
		expect(outcome.result).toBe('complete');
		const log = loggedCommands(host.root);
		const specs = log
			.filter((line) => line.startsWith('/usr/sbin/semanage fcontext -a -t var_lib_t '))
			.map((line) => line.split(' ').at(-1) as string);
		expect(specs).toEqual([
			'/home/drill\\.example\\.org/dedalo',
			'/home/drill\\.example\\.org/dedalo/dedalo(/.*)?',
			'/home/drill\\.example\\.org/dedalo/private(/.*)?',
			'/home/drill\\.example\\.org/dedalo/backups(/.*)?',
		]);
		// Read the way the policy reads them: anchored regexes.
		const matches = (path: string) => specs.some((spec) => new RegExp(`^(?:${spec})$`).test(path));
		expect(matches('/home/drill.example.org/dedalo/private/.env')).toBe(true);
		expect(matches('/home/drill.example.org/dedalo/dedalo/src/server.ts')).toBe(true);
		expect(matches('/home/drillXexample.org/dedalo/private/.env')).toBe(false);
		expect(matches('/home/drill.example.org/.ssh/authorized_keys')).toBe(false);
		expect(matches('/home/drill.example.org')).toBe(false);
		const relabels = log.filter((line) => line.includes('/usr/sbin/restorecon '));
		const inFolder = relabels.filter((line) => line.includes(HOSTING.dir));
		expect(inFolder.length).toBe(4);
		for (const line of inFolder)
			expect(line.startsWith(`${asService(HOSTING)} /usr/sbin/restorecon `), line).toBe(true);
		expect(relabels.filter((line) => / \/home(\/drill\.example\.org)?$/.test(line))).toEqual([]);
	});
});

// ── (e) one user, one group, one folder per instance ─────────────────────────

/** Another instance's account and folders, as one source records them. */
interface OtherRecord {
	user: string;
	group: string;
	dir: string;
}

/** The four discovery sources: the files that record `other`, and the path the sentence names. */
const SOURCES: readonly {
	name: string;
	files: (other: OtherRecord) => Map<string, string>;
	source: string;
}[] = Object.freeze([
	{
		name: 'the host registry',
		source: '/var/lib/dedalo-install/instances/other.json',
		files: (other: OtherRecord) =>
			new Map([
				[
					'/var/lib/dedalo-install/instances/other.json',
					`${JSON.stringify({ instance: 'other', user: other.user, group: other.group, install_dir: other.dir, backup_dir: `${other.dir}/backups` })}\n`,
				],
			]),
	},
	{
		name: 'a stamped drop-in',
		source: '/etc/systemd/system/dedalo-ts@other.service.d/10-dedalo-install.conf',
		files: (other: OtherRecord) =>
			new Map([
				[
					'/etc/systemd/system/dedalo-ts@other.service.d/10-dedalo-install.conf',
					`# dedalo-install other 0123456789abcdef\n[Service]\nUser=${other.user}\nGroup=${other.group}\nWorkingDirectory=${other.dir}/dedalo\n`,
				],
			]),
	},
	{
		name: 'a live host run record',
		source: '/var/lib/dedalo-install/other/install.state.json',
		files: (other: OtherRecord) =>
			new Map([
				[
					'/var/lib/dedalo-install/other/install.plan.json',
					`${JSON.stringify({ answers: { route: 'production', instance: 'other', install_dir: other.dir, service_user: other.user } })}\n`,
				],
				[
					'/var/lib/dedalo-install/other/install.state.json',
					`${JSON.stringify({ outcome: 'in_progress', preflight: { host: { facts: { account: { groupName: other.group } } } } })}\n`,
				],
			]),
	},
	{
		name: 'a hand-installed unit',
		source: '/etc/systemd/system/dedalo-other.service',
		files: (other: OtherRecord) =>
			new Map([
				[
					'/etc/systemd/system/dedalo-other.service',
					`[Service]\nUser=${other.user}\nGroup=${other.group}\nWorkingDirectory=${other.dir}/dedalo\n`,
				],
			]),
	},
]);

/** The clash kinds: another instance's record, and the sentence it draws (`source` filled in). */
const CLASHES: readonly {
	name: string;
	other: OtherRecord;
	sentence: (source: string, instance: string) => string;
}[] = Object.freeze([
	{
		name: 'the same service user',
		other: { user: `ded_${INSTANCE}`, group: 'othergrp', dir: '/srv/other' },
		sentence: (source: string, j: string) =>
			`service user ded_${INSTANCE} is already the service user of instance ${j} (${source}) — one user per instance: choose another --service-user`,
	},
	{
		name: 'the same service group',
		other: { user: 'ded_other', group: `ded_${INSTANCE}`, dir: '/srv/other' },
		sentence: (source: string, j: string) =>
			`service group ded_${INSTANCE} is already the service group of instance ${j} (${source}) — one group per instance: choose another --service-group`,
	},
	{
		name: 'the same folder',
		other: { user: 'ded_other', group: 'ded_other', dir: `/home/ded_${INSTANCE}` },
		sentence: (_source: string, j: string) =>
			`install folder /home/ded_${INSTANCE} overlaps instance ${j}'s folder /home/ded_${INSTANCE} (the same folder) — choose a folder of its own`,
	},
	{
		name: 'a folder inside it',
		other: { user: 'ded_other', group: 'ded_other', dir: `/home/ded_${INSTANCE}/nested` },
		sentence: (_source: string, j: string) =>
			`install folder /home/ded_${INSTANCE} overlaps instance ${j}'s folder /home/ded_${INSTANCE}/nested (contains it) — choose a folder of its own`,
	},
	{
		name: 'a folder containing it',
		other: { user: 'ded_other', group: 'ded_other', dir: '/home' },
		sentence: (_source: string, j: string) =>
			`install folder /home/ded_${INSTANCE} overlaps instance ${j}'s folder /home (inside it) — choose a folder of its own`,
	},
]);

/** The instance name a source records (a hand-installed unit is named by its file). */
function instanceOf(sourceName: string): string {
	return sourceName === 'a hand-installed unit' ? 'dedalo-other' : 'other';
}

describe('(e) one user, one group, one folder per instance — every discovery source', () => {
	test(`${SOURCES.length} sources × ${CLASHES.length} clashes: refused at host_preflight by the exact sentence; nothing changed, nothing recorded as created`, async () => {
		let refused = 0;
		for (const source of SOURCES) {
			for (const clash of CLASHES) {
				const files = source.files(clash.other);
				const { host, outcome } = await freshOn(UBUNTU, { files }, {});
				const label = `${source.name} / ${clash.name}`;
				expect(outcome.result, label).toBe('refused'); // C3-23: refused before any record
				expect(outcome.failedStep, label).toBeNull();
				expect(outcome.message ?? '', label).toContain(
					clash.sentence(source.source, instanceOf(source.name)),
				);
				expect(changed(host), label).toEqual([]);
				for (const [path, content] of files) expect(bytesOf(host, path), label).toBe(content);
				const created = readStateFile(join(host.root, RUN_DIR))?.created.host;
				expect([created?.user ?? null, created?.group ?? null, created?.dirs ?? []], label).toEqual(
					[null, null, []],
				);
				refused += 1;
			}
		}
		expect(refused).toBe(SOURCES.length * CLASHES.length);
	});

	test('an ABORTED run record is no clash; a stamped drop-in without User= is refused with its path', async () => {
		const aborted = new Map([
			[
				'/var/lib/dedalo-install/other/install.plan.json',
				`${JSON.stringify({ answers: { route: 'production', instance: 'other', install_dir: `/home/ded_${INSTANCE}`, service_user: `ded_${INSTANCE}` } })}\n`,
			],
			[
				'/var/lib/dedalo-install/other/install.state.json',
				`${JSON.stringify({ outcome: 'aborted' })}\n`,
			],
		]);
		const fine = await freshOn(UBUNTU, { files: aborted }, {});
		expect(fine.outcome.message).toBeNull();
		expect(fine.outcome.result).toBe('complete');
		const stamped = '/etc/systemd/system/dedalo-ts@other.service.d/10-dedalo-install.conf';
		const unknown = await freshOn(
			UBUNTU,
			{
				files: new Map([
					[stamped, '# dedalo-install other 0123456789abcdef\n[Service]\nUMask=0007\n'],
				]),
			},
			{},
		);
		expect(unknown.outcome.result).toBe('refused'); // C3-23: refused before any record
		expect(unknown.outcome.failedStep).toBeNull();
		expect(unknown.outcome.message).toContain(
			`${stamped} names instance other but sets no User= — the installer cannot tell which account it runs as (one user per instance): give it its User= or remove it`,
		);
		expect(changed(unknown.host)).toEqual([]);
	});

	test('a hand-installed unit with no Group= is its User=’s PRIMARY group; unresolvable → refused with its path', async () => {
		const unit = '/etc/systemd/system/dedalo.service';
		const files = new Map([
			[unit, '[Service]\nUser=legacy\nWorkingDirectory=/opt/legacy/master_dedalo\n'],
		]);
		const resolved = await freshOn(
			UBUNTU,
			{
				files,
				identity: { ...DEFAULT_IDENTITY, group: 'shared', gid: 1300, groupExisting: true },
				responses: [
					{
						match: '/usr/bin/getent passwd legacy',
						stdout: 'legacy:x:1301:1300::/home/legacy:/bin/bash\n',
					},
					{ match: '/usr/bin/getent group 1300', stdout: 'shared:x:1300:\n' },
					{ match: '/usr/bin/getent group shared', stdout: 'shared:x:1300:\n' },
				],
			},
			{ service_group: 'shared' },
		);
		expect(resolved.outcome.result).toBe('refused'); // C3-23: refused before any record
		expect(resolved.outcome.failedStep).toBeNull();
		expect(resolved.outcome.message).toContain(
			`service group shared is already the service group of instance dedalo (${unit}) — one group per instance: choose another --service-group`,
		);
		expect(changed(resolved.host)).toEqual([]);
		const ghost = await freshOn(
			UBUNTU,
			{
				files: new Map([
					[unit, '[Service]\nUser=ghost\nWorkingDirectory=/opt/ghost/master_dedalo\n'],
				]),
			},
			{},
		);
		expect(ghost.outcome.result).toBe('refused'); // C3-23: refused before any record
		expect(ghost.outcome.failedStep).toBeNull();
		expect(ghost.outcome.message).toContain(
			`${unit} names instance dedalo but runs as User=ghost, whose primary group cannot be resolved — the installer cannot tell which group it runs as (one group per instance): give it its Group= or remove it`,
		);
	});

	test('a hand-installed unit named like THIS instance is still another install (only the installer’s own records are self)', () => {
		const root = join(scratchBase, 'self_named_unit');
		plant(
			root,
			new Map([
				[
					'/etc/systemd/system/dedalo.service',
					'[Service]\nUser=legacy\nGroup=legacy\nWorkingDirectory=/opt/legacy/x\n',
				],
				[
					'/var/lib/dedalo-install/instances/dedalo.json',
					`${JSON.stringify({ instance: 'dedalo', user: 'ded_dedalo', group: 'ded_dedalo', install_dir: '/home/ded_dedalo' })}\n`,
				],
			]),
		);
		expect(
			otherInstances(hostFs(root), 'dedalo').map((record) => [record.user, record.source]),
		).toEqual([['legacy', '/etc/systemd/system/dedalo.service']]);
	});

	test('the discovery table: every source read, this instance itself never a record', () => {
		const root = join(scratchBase, 'discovery');
		const other = { user: 'u_other', group: 'g_other', dir: '/srv/other' };
		for (const source of SOURCES) plant(root, source.files(other));
		plant(
			root,
			new Map([
				[
					`/var/lib/dedalo-install/instances/${INSTANCE}.json`,
					`${JSON.stringify({ instance: INSTANCE, user: 'self', group: 'self', install_dir: '/srv/self' })}\n`,
				],
			]),
		);
		const records = otherInstances(hostFs(root), INSTANCE).map((record) => ({
			instance: record.instance,
			user: record.user,
			group: record.group,
			installDir: record.installDir,
			source: record.source,
		}));
		expect(records.length).toBeGreaterThanOrEqual(SOURCES.length);
		expect(records).toEqual(
			SOURCES.map((source) => ({
				instance: instanceOf(source.name),
				user: other.user,
				group: other.group,
				installDir: other.dir,
				source: source.source,
			})),
		);
	});
});

// ── campaign 3d C3d-F1: the name of an INSTALLED instance ─────────────────────

describe('C3d-F1: a fresh install under the name of an installed instance', () => {
	/** The live instance THIS name already is: its account (system uid), its folder with its tree. */
	const LIVE: PlantSpec = {
		responses: [
			{
				match: `/usr/bin/getent passwd ded_${INSTANCE}`,
				stdout: `ded_${INSTANCE}:x:999:999::/home/ded_${INSTANCE}:/usr/sbin/nologin\n`,
			},
			{
				match: `/usr/bin/getent group ded_${INSTANCE}`,
				stdout: `ded_${INSTANCE}:x:999:www-data\n`,
			},
		],
		files: new Map([[`/home/ded_${INSTANCE}/dedalo/`, '']]),
	};
	const REGISTRY = `/var/lib/dedalo-install/instances/${INSTANCE}.json`;
	const DROPIN = `/etc/systemd/system/dedalo-ts@${INSTANCE}.service.d/10-dedalo-install.conf`;
	const RECORDS: readonly [string, string, string][] = [
		[
			'its registry entry',
			REGISTRY,
			`${JSON.stringify({ instance: INSTANCE, user: `ded_${INSTANCE}`, group: `ded_${INSTANCE}`, install_dir: `/home/ded_${INSTANCE}` })}\n`,
		],
		[
			'its stamped drop-in',
			DROPIN,
			`# dedalo-install ${INSTANCE} 0123456789abcdef\n[Service]\nUser=ded_${INSTANCE}\nGroup=ded_${INSTANCE}\nWorkingDirectory=/home/ded_${INSTANCE}/dedalo\n`,
		],
	];

	for (const [name, path, text] of RECORDS) {
		test(`${name}: ONE refusal naming the instance and the file — never "a leftover" to userdel; nothing changed`, async () => {
			const files = new Map([...(LIVE.files ?? []), [path, text]]);
			const { host, outcome } = await freshOn(UBUNTU, { ...LIVE, files }, {});
			expect(outcome.result).toBe('refused');
			expect(outcome.failedStep).toBeNull();
			const message = outcome.message ?? '';
			// The ONE refusal — not its unit, drop-in, site, database and account listed back.
			expect(message).toBe(instanceTakenSentence(INSTANCE, [path]));
			for (const advice of ['userdel', 'leftover', 'already holds', 'already enabled'])
				expect(message, advice).not.toContain(advice);
			expect(changed(host)).toEqual([]);
		});
	}

	test('a COMPLETE install of the name: a fresh run is told it is installed — never "resume it or undo it"', async () => {
		const { host, outcome } = await freshOn(UBUNTU, {}, {});
		expect(outcome.result).toBe('complete');
		const again = await runHost(host, freshRequest(productionPlan(UBUNTU, {}).planFile));
		expect(again.outcome.result).toBe('refused');
		const message = again.outcome.message ?? '';
		// The record's path as this run reads it (the scratch root's prefix, on a host none).
		expect(message).toMatch(
			new RegExp(
				`^instance ${INSTANCE} is already installed on this host \\(\\S*${RUN_DIR}/install\\.state\\.json\\)`,
			),
		);
		expect(message).not.toContain('--resume');
		expect(message).not.toContain('--abort');
	});

	test('CONTROL: the same account and folder with NO instance record — the leftover advice stands', async () => {
		const { outcome } = await freshOn(UBUNTU, LIVE, {});
		expect(outcome.result).toBe('refused');
		expect(outcome.message).toContain('an earlier install');
		expect(outcome.message).not.toContain('is already installed on this host');
	});

	test('the Identity check says the same: the verdict over the taken name is that one sentence', () => {
		const taken = [
			{
				instance: INSTANCE,
				user: `ded_${INSTANCE}`,
				group: `ded_${INSTANCE}`,
				installDir: `/home/ded_${INSTANCE}`,
				backupDir: null,
				source: REGISTRY,
				unknown: null,
			},
		];
		const live = input(
			{},
			{
				user: user(`ded_${INSTANCE}`, 999, 999, '/usr/sbin/nologin'),
				group: { name: `ded_${INSTANCE}`, gid: 999, members: ['www-data'] },
			},
		);
		expect(identityVerdict({ ...live, taken }).problems).toEqual([
			instanceTakenSentence(INSTANCE, [REGISTRY]),
		]);
		// CONTROL: without the record it is judged as an account — the leftover sentence.
		expect(identityVerdict(live).problems.join('\n')).toContain('userdel');
	});

	test("ANOTHER instance's system account typed as the service user: its clash, never the leftover advice", () => {
		const other = {
			instance: 'prado',
			user: 'ded_prado',
			group: 'ded_prado',
			installDir: '/home/ded_prado',
			backupDir: null,
			source: '/var/lib/dedalo-install/instances/prado.json',
			unknown: null,
		};
		const typed = input(
			{ service_user: 'ded_prado', install_dir: '/srv/museo' },
			{
				user: user('ded_prado', 998, 998, '/usr/sbin/nologin'),
				group: { name: 'ded_prado', gid: 998, members: [] },
				groupName: 'ded_prado',
			},
		);
		const problems = identityVerdict({ ...typed, instances: [other] }).problems.join('\n');
		expect(problems).toContain('is already the service user of instance prado');
		expect(problems).not.toContain('userdel');
		// CONTROL: no instance names it — a leftover system account, the advice given.
		expect(identityVerdict(typed).problems.join('\n')).toContain('userdel');
	});
});

// ── (f) the install folder ───────────────────────────────────────────────────

/** A System check refusal of `extra` on a planted host: its sentence; nothing changed. */
async function refusal(spec: PlantSpec, extra: Record<string, unknown>): Promise<string> {
	const { host, outcome } = await freshOn(UBUNTU, spec, extra);
	expect(outcome.result).toBe('refused'); // C3-23: refused before any record
	expect(outcome.failedStep).toBeNull();
	expect(changed(host)).toEqual([]);
	return outcome.message ?? '';
}

const ROOT_0755 = { owner: 'root', group: 'root', mode: 0o755 } as const;
const CUSTOM_DIR = { install_dir: '/srv/apps/a/dedalo' };

describe('(f) the install folder: created, adopted, used as it is — or refused', () => {
	test("a root-owned parent is never changed; the folder is created the default user's 0750", async () => {
		const host = scratchHost(UBUNTU, {
			identity: defaultAt(CUSTOM_DIR.install_dir),
			owned: [['/srv/apps/a', ROOT_0755]],
		});
		const parent = statOf(host, '/srv/apps/a');
		const { planFile } = productionPlan(UBUNTU, CUSTOM_DIR);
		const run = await runHost(host, freshRequest(planFile));
		expect(run.outcome.result).toBe('complete');
		expect(statOf(host, '/srv/apps/a')).toEqual(parent);
		expect(statOf(host, '/srv/apps/a/dedalo')).toEqual({
			owner: `ded_${INSTANCE}`,
			group: `ded_${INSTANCE}`,
			mode: 0o750,
		});
		expect(rootInsideFolder(host)).toEqual([]);
	});

	test('an EMPTY foreign folder under root-owned parents (a mount point) is ADOPTED, and --abort hands it back', async () => {
		const host = scratchHost(UBUNTU, {
			owned: [
				['/srv/apps/a', ROOT_0755],
				['/srv/apps/a/dedalo', ROOT_0755],
			],
			identity: defaultAt(CUSTOM_DIR.install_dir),
			responses: engineFails(defaultAt(CUSTOM_DIR.install_dir)),
		});
		const { plan, planFile } = productionPlan(UBUNTU, CUSTOM_DIR);
		const fresh = await runHost(host, freshRequest(planFile));
		expect(fresh.outcome.failedStep).toBe('host_engine');
		expect(statOf(host, '/srv/apps/a/dedalo')).toEqual({
			owner: `ded_${INSTANCE}`,
			group: `ded_${INSTANCE}`,
			mode: 0o750,
		});
		const created = readStateFile(join(host.root, RUN_DIR))?.created.host;
		expect(created?.install_dir).toEqual({
			path: '/srv/apps/a/dedalo',
			how: 'adopted',
			owner: 'root',
			group: 'root',
			mode: 0o755,
		});
		const aborted = await runHost(host, laterRequest('abort', plan, DB));
		expect(aborted.outcome.result).toBe('aborted');
		expect(statOf(host, '/srv/apps/a/dedalo')).toEqual(ROOT_0755);
	});

	test("the user's own NON-EMPTY folder is used as it is: mode and content unchanged, never in a mkdir", async () => {
		const own = { owner: HOSTING.user, group: HOSTING.group };
		const host = scratchHost(UBUNTU, {
			identity: HOSTING,
			owned: [
				...hostingOwned(),
				[HOSTING.dir, { ...own, mode: 0o710 }],
				[`${HOSTING.dir}/README.site`, { ...own, mode: 0o644, content: 'the site’s own file\n' }],
			],
		});
		const { planFile } = productionPlan(UBUNTU, HOSTING_ANSWERS);
		const run = await runHost(host, freshRequest(planFile));
		expect(run.outcome.result).toBe('complete');
		expect(statOf(host, HOSTING.dir)).toEqual({ ...own, mode: 0o710 });
		expect(bytesOf(host, `${HOSTING.dir}/README.site`)).toBe('the site’s own file\n');
		const mkdirs = reviewCommands(frozenContext(host)).filter(
			(command) => command.kind === 'mkdir' && command.path === HOSTING.dir,
		);
		expect(mkdirs).toEqual([]);
	});

	test("a typed backup dir that EXISTS inside the user's own folder is refused, never re-moded", async () => {
		const own = { owner: HOSTING.user, group: HOSTING.group };
		const www = `${HOSTING.dir}/www`;
		const host = scratchHost(UBUNTU, {
			identity: HOSTING,
			owned: [
				...hostingOwned(),
				[HOSTING.dir, { ...own, mode: 0o755 }],
				[www, { ...own, mode: 0o755 }],
				[`${www}/index.html`, { ...own, mode: 0o644, content: 'site\n' }],
			],
		});
		const { planFile } = productionPlan(UBUNTU, { ...HOSTING_ANSWERS, backup_dir: www });
		const run = await runHost(host, freshRequest(planFile));
		expect(run.outcome.result).toBe('refused'); // C3-23: refused before any record
		expect(run.outcome.failedStep).toBeNull();
		expect(run.outcome.message).toContain(
			`${www} already exists — the installer creates the instance's directories itself and never takes over an existing one (remove it or choose another path)`,
		);
		expect(changed(host)).toEqual([]);
		expect(statOf(host, www)).toEqual({ ...own, mode: 0o755 });
		expect(bytesOf(host, `${www}/index.html`)).toBe('site\n');
	});

	const refusals: readonly {
		name: string;
		spec: () => PlantSpec;
		extra: Record<string, unknown>;
		sentence: string;
	}[] = [
		{
			name: "another account's non-empty folder",
			spec: () => ({
				owned: [
					['/srv/apps/a', ROOT_0755],
					['/srv/apps/a/dedalo/readme.txt', { ...ROOT_0755, mode: 0o644, content: 'x\n' }],
				],
			}),
			extra: CUSTOM_DIR,
			sentence: `install folder /srv/apps/a/dedalo is not empty and is not owned by ded_${INSTANCE} — the installer uses an existing folder as it is only when it is empty, or already owned by the service user`,
		},
		{
			name: "a folder holding an install's remains (private/)",
			spec: () => ({
				identity: HOSTING,
				owned: [
					...hostingOwned(),
					[HOSTING.dir, { owner: HOSTING.user, group: HOSTING.group, mode: 0o750 }],
					[`${HOSTING.dir}/private`, { owner: HOSTING.user, group: HOSTING.group, mode: 0o700 }],
				],
			}),
			extra: HOSTING_ANSWERS,
			sentence: `install folder ${HOSTING.dir} already holds private — an install (or its remains) is there; the installer never takes one over (remove it or choose another folder)`,
		},
		{
			name: 'a folder writable by group or others',
			spec: () => ({
				identity: HOSTING,
				owned: [
					...hostingOwned(),
					[HOSTING.dir, { owner: HOSTING.user, group: HOSTING.group, mode: 0o770 }],
				],
			}),
			extra: HOSTING_ANSWERS,
			sentence: `install folder ${HOSTING.dir} is writable by group or others (mode 0770) — another account could replace the code the service runs; chmod go-w it first`,
		},
		{
			name: 'an empty foreign folder under a parent the user owns',
			spec: () => ({
				identity: HOSTING,
				owned: [...hostingOwned(), [HOSTING.dir, ROOT_0755]],
			}),
			extra: HOSTING_ANSWERS,
			sentence: `install folder ${HOSTING.dir} is empty but not owned by ${HOSTING.user}, and one of its parents is not root's — chown it to ${HOSTING.user} first`,
		},
		{
			name: 'an ancestor of another account',
			spec: () => ({ owned: [['/srv/apps', { owner: 'mallory', group: 'mallory', mode: 0o755 }]] }),
			extra: CUSTOM_DIR,
			sentence: `/srv/apps (a parent of the install folder) is writable by an account other than root or ded_${INSTANCE} — it could replace the install folder; fix its owner or mode first`,
		},
		{
			name: 'an ancestor others may write',
			spec: () => ({ owned: [['/srv/apps', { ...ROOT_0755, mode: 0o777 }]] }),
			extra: CUSTOM_DIR,
			sentence: `/srv/apps (a parent of the install folder) is writable by an account other than root or ded_${INSTANCE} — it could replace the install folder; fix its owner or mode first`,
		},
		{
			name: 'a symlinked path',
			spec: () => ({ owned: [['/srv/real', ROOT_0755]], links: [['/srv/link', 'real']] }),
			extra: { install_dir: '/srv/link/dedalo' },
			sentence:
				'install folder path /srv/link/dedalo passes through the symbolic link /srv/link — give the real path',
		},
		{
			name: 'an ancestor the user cannot search',
			spec: () => ({ owned: [['/srv/apps', { ...ROOT_0755, mode: 0o700 }]] }),
			extra: CUSTOM_DIR,
			sentence: `/srv/apps is not searchable by ded_${INSTANCE} — the service could not reach its own folder`,
		},
		{
			name: 'an EMPTY OS directory of root (/var/mail, root:mail 02775) is never adopted',
			spec: () => ({
				owned: [
					['/var', ROOT_0755],
					['/var/mail', { owner: 'root', group: 'mail', mode: 0o2775 }],
				],
			}),
			extra: { install_dir: '/var/mail' },
			sentence: `install folder /var/mail is an existing directory of root outside /home, /srv, /data, /mnt, /media — the installer adopts an empty folder only there (an OS directory such as /var/mail is never taken over): chown it to ded_${INSTANCE} first, or choose a folder that does not exist yet`,
		},
		{
			name: "another account's EMPTY folder is never adopted",
			spec: () => ({
				owned: [
					['/srv/apps/a', ROOT_0755],
					['/srv/apps/a/dedalo', { owner: 'mallory', group: 'mallory', mode: 0o755 }],
				],
			}),
			extra: CUSTOM_DIR,
			sentence: `install folder /srv/apps/a/dedalo is empty but owned by mallory, another account — the installer never takes over another account's folder: chown it to ded_${INSTANCE} first, or choose another folder`,
		},
		{
			name: 'a service user that is a package account (postgres)',
			spec: () => ({}),
			extra: { install_dir: '/home/pgx/dedalo', service_user: 'postgres' },
			sentence:
				"service user postgres is an account of the installer's packages (PostgreSQL or the web server) — refused: the service runs as an account of its own",
		},
		{
			name: 'an existing account with uid 0',
			spec: () => ({ identity: { ...HOSTING, user: 'toor', group: 'root', uid: 0, gid: 0 } }),
			extra: { install_dir: '/srv/toor/dedalo', service_user: 'toor' },
			sentence: 'service user toor (uid 0) is refused — the service never runs as root',
		},
		{
			name: 'a defaulted group left over by an earlier install',
			spec: () => ({
				responses: [
					{ match: `/usr/bin/getent group ded_${INSTANCE}`, stdout: `ded_${INSTANCE}:x:1200:\n` },
				],
			}),
			extra: {},
			sentence: `group ded_${INSTANCE} already exists but user ded_${INSTANCE} does not — the installer never creates a user into a leftover group by default: remove the group, or use it as is with --service-group ded_${INSTANCE}`,
		},
	];

	for (const item of refusals) {
		test(`refused at the System check: ${item.name}`, async () => {
			expect(await refusal(item.spec(), item.extra)).toContain(item.sentence);
		});
	}
});

/** The default account, in another folder (the engine child runs in its tree). */
function defaultAt(dir: string): ScratchIdentity {
	return { ...DEFAULT_IDENTITY, dir };
}

// ── (g) the account rules, pure ──────────────────────────────────────────────

/** A path fact. */
function fact(path: string, over: Partial<PathFact> = {}): PathFact {
	return {
		path,
		exists: true,
		isDirectory: true,
		isSymlink: false,
		owner: 'root',
		group: 'root',
		mode: 0o755,
		...over,
	};
}

/** The verdict input of `extra` over `account` (a missing folder under root's /home by default). */
function input(
	extra: Record<string, unknown>,
	account: Partial<AccountFacts>,
	sites: IdentityInput['sites'] = [],
): IdentityInput {
	const answers = normalizeInstallAnswers(productionRaw(UBUNTU, extra)).answers;
	const base = pendingAccountFacts();
	return {
		answers,
		account: {
			...base,
			groupName: answers.service_group || answers.service_user,
			folder: {
				...fact(answers.install_dir, {
					exists: false,
					isDirectory: false,
					owner: '',
					group: '',
					mode: 0,
				}),
				entries: [],
			},
			ancestors: [fact('/home'), fact('/')],
			...account,
		},
		instances: [],
		webUser: 'www-data',
		sites,
	};
}

/** An existing account's passwd entry. */
function user(name: string, uid: number, gid: number, shell = '/bin/bash') {
	return { name, uid, gid, home: `/home/${name}`, shell, primaryGroup: name };
}

const SITE = { install_dir: '/home/site/dedalo', service_user: 'site' };
const SITE_GROUP = { name: 'site', gid: 1600, members: [] };

describe('(g) the account rules — one verdict, every sentence exact', () => {
	const cases: readonly {
		name: string;
		input: () => IdentityInput;
		problem: string | null;
		told?: string;
	}[] = [
		{
			name: 'a system uid',
			input: () =>
				input(SITE, { user: user('site', 500, 1600), group: SITE_GROUP, groupName: 'site' }),
			problem:
				"account site is a system account (uid 500) — the installer uses only a regular account as it is (uid 1000-60000); a system account it did not create in this run is never reused (an earlier install's leftover: remove it with userdel, or choose another name)",
		},
		{
			name: 'nobody (uid above UID_MAX)',
			input: () =>
				input(
					{ install_dir: '/srv/nobody/dedalo', service_user: 'nobody' },
					{
						user: user('nobody', 65534, 65534),
						group: { name: 'nogroup', gid: 65534, members: [] },
						groupName: 'nogroup',
					},
				),
			problem: 'account nobody is a system account (uid 65534)',
		},
		{
			name: 'a privileged supplementary group by gid (adm)',
			input: () =>
				input(SITE, {
					user: user('site', 1600, 1600),
					group: SITE_GROUP,
					groupName: 'site',
					memberOf: [
						{ name: 'site', gid: 1600 },
						{ name: 'adm', gid: 4 },
					],
				}),
			problem:
				"account site is a member of adm (gid 4) — the service would hold that group's rights; choose an account without it",
		},
		{
			name: 'a privileged supplementary group by name (docker)',
			input: () =>
				input(SITE, {
					user: user('site', 1600, 1600),
					group: SITE_GROUP,
					groupName: 'site',
					memberOf: [
						{ name: 'site', gid: 1600 },
						{ name: 'docker', gid: 1999 },
					],
				}),
			problem: 'account site is a member of docker (gid 1999)',
		},
		{
			name: 'the harmless `users` group (gid 100) is no refusal',
			input: () =>
				input(SITE, {
					user: user('site', 1600, 1600),
					group: SITE_GROUP,
					groupName: 'site',
					memberOf: [
						{ name: 'site', gid: 1600 },
						{ name: 'users', gid: 100 },
					],
				}),
			problem: null,
		},
		{
			name: 'gid 0',
			input: () =>
				input(
					{ ...SITE, service_group: 'wheelish' },
					{
						user: user('site', 1600, 1600),
						group: { name: 'wheelish', gid: 0, members: [] },
						groupName: 'wheelish',
					},
				),
			problem: 'service group wheelish is gid 0 — refused',
		},
		{
			name: 'a system group',
			input: () =>
				input(
					{ ...SITE, service_group: 'adm' },
					{
						user: user('site', 1600, 1600),
						group: { name: 'adm', gid: 4, members: [] },
						groupName: 'adm',
					},
				),
			problem:
				'group adm is a system group (gid 4) — the web server joins the service group, so only a regular group (gid 1000-60000) or one the installer creates is accepted',
		},
		{
			name: "the web server's own group",
			input: () => input({ ...SITE, service_group: 'www-data' }, { groupName: 'www-data' }),
			problem: "group www-data is the web server's own group — refused",
		},
		{
			name: "a package's account as the service user (absent now: host_packages would create it)",
			input: () => input({ install_dir: '/srv/pg/dedalo', service_user: 'postgres' }, {}),
			problem:
				"service user postgres is an account of the installer's packages (PostgreSQL or the web server) — refused: the service runs as an account of its own",
		},
		{
			name: "a package's group as the service group",
			input: () => input({ ...SITE, service_group: 'nginx' }, { groupName: 'nginx' }),
			problem:
				"group nginx is a group of the installer's packages (PostgreSQL or the web server) — refused: the service group is one of its own",
		},
		{
			name: 'a dotted account to be CREATED',
			input: () =>
				input({ install_dir: '/srv/x/dedalo', service_user: 'my.site' }, { groupName: 'my.site' }),
			problem:
				"the installer creates only names matching ^[a-z_][a-z0-9_-]*$ (useradd's default NAME_REGEX): my.site does not exist on this host — create the account yourself or choose another name",
		},
		{
			name: 'a folder inside a directory a web site serves',
			input: () =>
				input(
					{ install_dir: '/var/www/site/dedalo' },
					{ ancestors: [fact('/var/www/site'), fact('/var/www'), fact('/var'), fact('/')] },
					[
						{
							file: '/etc/nginx/sites-enabled/site.conf',
							roots: ['/var/www/site'],
						} as IdentityInput['sites'][number],
					],
				),
			problem:
				'install folder /var/www/site/dedalo is inside /var/www/site, which /etc/nginx/sites-enabled/site.conf serves to the web — choose a folder outside every site root',
		},
		{
			name: 'a group with other members is TOLD, not refused',
			input: () =>
				input(SITE, {
					user: user('site', 1600, 1600, '/usr/sbin/nologin'),
					group: { name: 'site', gid: 1600, members: ['backupper'] },
					groupName: 'site',
					primaryUsers: ['legacy'],
				}),
			problem: null,
			told: "group site has other members (backupper, legacy): they can read the instance's files",
		},
	];

	for (const item of cases) {
		test(item.name, () => {
			const verdict = identityVerdict(item.input());
			if (item.problem === null) expect(verdict.problems).toEqual([]);
			else expect(verdict.problems.join('\n')).toContain(item.problem);
			if (item.told !== undefined) expect(verdict.told).toContain(item.told);
		});
	}

	test('the Review lines say CREATED vs USED AS IS from the verdict (never a front end’s own words)', () => {
		const fresh = input({}, {});
		const created = identityLines(fresh.answers, identityVerdict(fresh));
		expect(created.map((line) => `${line.label}: ${line.value}`)).toEqual([
			`install folder: /home/ded_${INSTANCE} — CREATED (ded_${INSTANCE}:ded_${INSTANCE} 0750; parent /home unchanged)`,
			`service user: ded_${INSTANCE} — CREATED (system account, no login shell)`,
			`service group: ded_${INSTANCE} — CREATED`,
			`database user: ded_${INSTANCE} (peer: the service user)`,
		]);
		const hosting = input(SITE, {
			user: user('site', 1600, 1600),
			group: SITE_GROUP,
			groupName: 'site',
			ancestors: [
				fact('/home/site', { owner: 'site', group: 'site', mode: 0o750 }),
				fact('/home'),
				fact('/'),
			],
		});
		const used = identityLines(hosting.answers, identityVerdict(hosting)).map(
			(line) => `${line.label}: ${line.value}`,
		);
		expect(used.slice(0, 4)).toEqual([
			'install folder: /home/site/dedalo — CREATED (site:site 0750, by site; parent /home/site unchanged)',
			'service user: site — USED AS IS (uid 1600; never created or deleted by the installer)',
			'service group: site — USED AS IS (primary group of site)',
			'database user: site (peer: the service user)',
		]);
		expect(used.filter((line) => line.startsWith('note: ')).length).toBe(2);
	});

	test("an account that is a MEMBER of another instance's group is refused (one group per instance)", () => {
		const base = input(
			{ install_dir: '/home/bob/dedalo', service_user: 'bob' },
			{
				user: user('bob', 1002, 1002),
				group: { name: 'bob', gid: 1002, members: [] },
				groupName: 'bob',
				memberOf: [
					{ name: 'bob', gid: 1002 },
					{ name: 'ded_a', gid: 1001 },
				],
				ancestors: [
					fact('/home/bob', { owner: 'bob', group: 'bob', mode: 0o750 }),
					fact('/home'),
					fact('/'),
				],
			},
		);
		const other = {
			instance: 'a',
			user: 'ded_a',
			group: 'ded_a',
			installDir: '/home/ded_a',
			backupDir: '/home/ded_a/backups',
			source: '/var/lib/dedalo-install/instances/a.json',
			unknown: null,
		};
		expect(identityVerdict({ ...base, instances: [other] }).problems).toEqual([
			"account bob is a member of ded_a, the service group of instance a (/var/lib/dedalo-install/instances/a.json) — one group per instance: the service would hold that instance's group; choose an account without it",
		]);
		expect(identityVerdict(base).problems).toEqual([]);
	});

	test("campaign 3 R4: another instance's user AND folder, read from THREE files — exactly 2 clauses, every file named once (C3-35)", () => {
		const r4 = { install_dir: '/home/my_domain.org/dedalo', service_user: 'my_domain.org' };
		const base = input(r4, {
			user: user('my_domain.org', 1001, 1001),
			group: { name: 'ded_museo2', gid: 1700, members: [] },
			groupName: 'ded_museo2',
			folder: {
				...fact('/home/my_domain.org/dedalo', {
					owner: 'my_domain.org',
					group: 'my_domain.org',
					mode: 0o750,
				}),
				entries: ['dedalo', 'private', 'backups'],
			},
			ancestors: [
				fact('/home/my_domain.org', {
					owner: 'my_domain.org',
					group: 'my_domain.org',
					mode: 0o750,
				}),
				fact('/home'),
				fact('/'),
			],
		});
		const sources = [
			'/var/lib/dedalo-install/instances/museo1.json',
			'/etc/systemd/system/dedalo-ts@museo1.service.d/10-dedalo-install.conf',
			'/var/lib/dedalo-install/museo1/install.state.json',
		];
		const records = sources.map((source) => ({
			instance: 'museo1',
			user: 'my_domain.org',
			group: 'my_domain.org',
			installDir: '/home/my_domain.org/dedalo',
			backupDir: source.endsWith('.conf') ? null : '/home/my_domain.org/dedalo/backups',
			source,
			unknown: null,
		}));
		const problems = identityVerdict({ ...base, instances: records }).problems;
		expect(problems).toEqual([
			`service user my_domain.org is already the service user of instance museo1 (${sources.join(', ')}) — one user per instance: choose another --service-user`,
			`install folder /home/my_domain.org/dedalo overlaps instance museo1's folder /home/my_domain.org/dedalo (the same folder) — choose a folder of its own`,
		]);
		// A TYPED backup folder elsewhere that overlaps theirs is its own mistake: still said.
		const typed = identityVerdict({
			...input({ ...r4, backup_dir: '/srv/b' }, base.account),
			instances: [{ ...(records[0] as (typeof records)[number]), backupDir: '/srv/b' }],
		}).problems;
		expect(typed).toContain(
			"backup folder /srv/b overlaps instance museo1's folder /srv/b (the same folder) — choose a folder of its own",
		);
	});

	test('the primary-group notice depends on the RESULTING group, not on how it was entered', () => {
		const facts = {
			user: user('site', 1600, 1600),
			group: SITE_GROUP,
			groupName: 'site',
		};
		const defaulted = identityVerdict(input(SITE, facts));
		const typed = identityVerdict(input({ ...SITE, service_group: 'site' }, facts));
		const notice = `the web server user www-data joins site, the primary group of site: it can then read whatever that group can read — a group of its own is recommended (--service-group ded_${INSTANCE})`;
		expect(defaulted.told).toContain(notice);
		expect(typed.told).toEqual(defaulted.told);
		expect(typed.group).toEqual(defaulted.group);
		expect(typed.group.primaryOf).toBe('site');
	});

	test('wired: the scratch System check refuses a system uid of the TYPED name (not only the pure verdict)', async () => {
		const message = await refusal(
			{ identity: { ...HOSTING, user: 'svc', group: 'svc', uid: 450, gid: 450, existing: true } },
			{ install_dir: '/srv/svc/dedalo', service_user: 'svc' },
		);
		expect(message).toContain('account svc is a system account (uid 450)');
	});
});

// ── (i) what appears or pre-exists between the System check and the run ─────

describe('(i) an account that appears after the System check, an fcontext that pre-exists — never the install’s own', () => {
	test('an account absent at the System check but created by a package before host_identity: refused, never recorded, never removed', async () => {
		const appx: ScratchIdentity = {
			...DEFAULT_IDENTITY,
			user: 'appx',
			group: 'appx',
			dir: '/home/appx/dedalo',
			uid: 1026,
			gid: 1026,
			existing: false,
		};
		const dnf = '/usr/bin/dnf install -y git';
		const host = scratchHost(EL, {
			identity: appx,
			responses: [
				{
					match: '/usr/bin/getent passwd appx',
					after: dnf,
					stdout: 'appx:x:1026:1026::/var/lib/appx:/bin/bash\n',
				},
				{ match: '/usr/bin/getent group appx', after: dnf, stdout: 'appx:x:1026:\n' },
				{ match: '/usr/bin/getent group 1026', after: dnf, stdout: 'appx:x:1026:\n' },
			],
		});
		const { plan, planFile } = productionPlan(EL, { install_dir: appx.dir, service_user: 'appx' });
		const run = await runHost(host, freshRequest(planFile));
		expect(run.outcome.failedStep).toBe('host_identity');
		expect(run.outcome.message).toContain(
			'group appx did not exist at the System check but exists now (another package or account created it since) — the installer never takes it for its own: --abort, then choose another --service-user',
		);
		const created = readStateFile(join(host.root, RUN_DIR))?.created.host;
		expect([created?.user ?? null, created?.group ?? null]).toEqual([null, null]);
		expect(loggedCommands(host.root).filter((line) => /useradd|groupadd/.test(line))).toEqual([]);
		const before = loggedCommands(host.root).length;
		await runHost(host, laterRequest('abort', plan, DB));
		expect(
			loggedCommands(host.root)
				.slice(before)
				.filter((line) => /userdel|groupdel/.test(line)),
		).toEqual([]);
	});

	test('an fcontext rule the operator defined before the install is neither added nor deleted by --abort', async () => {
		const spec = `/home/ded_${INSTANCE}/backups(/.*)?`;
		const host = scratchHost(EL, {
			responses: [
				{
					match: '/usr/sbin/semanage fcontext -l -C',
					until: '/usr/sbin/semanage fcontext -a',
					stdout: `${spec}    all files    system_u:object_r:var_lib_t:s0\n`,
				},
			],
		});
		const { plan, planFile } = productionPlan(EL, {});
		expect((await runHost(host, freshRequest(planFile))).outcome.result).toBe('complete');
		const ran = loggedCommands(host.root).filter((line) =>
			line.startsWith('/usr/sbin/semanage fcontext -a'),
		);
		expect(ran.length).toBeGreaterThan(0);
		expect(ran.filter((line) => line.endsWith(` ${spec}`))).toEqual([]);
		const recorded = readStateFile(join(host.root, RUN_DIR))?.created.host?.selinux_fcontexts ?? [];
		expect(recorded).toEqual(ran.map((line) => line.split(' ').at(-1) ?? ''));
		const before = loggedCommands(host.root).length;
		expect((await runHost(host, laterRequest('abort', plan, DB))).outcome.result).toBe('aborted');
		const deleted = loggedCommands(host.root)
			.slice(before)
			.filter((line) => line.startsWith('/usr/sbin/semanage fcontext -d'));
		expect(deleted.map((line) => line.split(' ').at(-1))).toEqual(recorded);
		expect(deleted.filter((line) => line.endsWith(` ${spec}`))).toEqual([]);
	});
});

// ── (h) the frozen digest holds the resolved group ───────────────────────────

describe('(h) a resume after a later step failed is accepted — the frozen digest holds the RESOLVED group (critique B2)', () => {
	/** An existing account whose primary group is NOT named like it (a panel's shared group). */
	const PANEL: ScratchIdentity = Object.freeze({ ...HOSTING, group: 'psacln', gid: 1501 });
	const layouts: readonly {
		name: string;
		spec: () => PlantSpec;
		extra: Record<string, unknown>;
		group: string;
	}[] = [
		{
			name: 'a typed group of its own',
			spec: () => ({ identity: SITE_A }),
			extra: SITE_A_ANSWERS,
			group: 'webgrp',
		},
		{
			name: "an existing account's primary group (named apart from it)",
			spec: () => ({ identity: PANEL, owned: hostingOwned() }),
			extra: HOSTING_ANSWERS,
			group: 'psacln',
		},
	];
	for (const layout of layouts) {
		test(layout.name, async () => {
			// The package lists fail ONCE (after host_preflight froze the digest), then answer.
			const flaky: RecordedResponse[] = [
				{ match: '/usr/bin/apt-get update', afterCount: 1 },
				{ match: '/usr/bin/apt-get update', exit: 100, stderr: 'mirror unreachable' },
			];
			const host = scratchHost(UBUNTU, { ...layout.spec(), responses: flaky });
			const { plan, planFile } = productionPlan(UBUNTU, layout.extra);
			const first = await runHost(host, freshRequest(planFile));
			expect(first.outcome.failedStep).toBe('host_packages');
			expect(frozenContext(host).paths.group).toBe(layout.group);
			const again = await runHost(host, laterRequest('resume', plan));
			expect(again.outcome.message).toBeNull();
			expect(again.outcome.result).toBe('complete');
			expect(
				loggedCommands(host.root).some((line) => line.includes(` -g ${layout.group} -- `)),
			).toBe(true);
		});
	}
});

// The suite's bound: every scratch path above lives under this gate's own mkdtemp root.
test('the scratch base is this gate’s own mkdtemp root', () => {
	expect(statSync(scratchBase).isDirectory()).toBe(true);
	expect(scratchBase.startsWith(tmpdir())).toBe(true);
	expect(REPO_ROOT.length).toBeGreaterThan(1);
});

describe('C4: the install folder must be reachable WITH THE SERVICE GROUP ALONE (runuser -g)', () => {
	// The install-time steps run `runuser -u <user> -g <service group>`: with -g runuser
	// sets that ONE group (measured on Ubuntu 26.04, 2026-11-08). A parent reachable only
	// through the account's OTHER group passed this check, then the engine could not enter.
	const searchProblem =
		'/home/site is not searchable by site — the service could not reach its own folder';
	const siteAccount = (parent: PathFact, memberOf: { name: string; gid: number }[]) =>
		input(SITE, {
			user: user('site', 1600, 1600),
			group: SITE_GROUP,
			groupName: 'site',
			memberOf,
			ancestors: [parent, fact('/home'), fact('/')],
		});
	const verdictOf = (parent: PathFact, memberOf: { name: string; gid: number }[] = []) =>
		identityVerdict(siteAccount(parent, memberOf)).problems;

	test("a parent open only to the account's OTHER group (staff, 0750) is refused", () => {
		const parent = fact('/home/site', { group: 'staff', mode: 0o750 });
		expect(
			verdictOf(parent, [
				{ name: 'site', gid: 1600 },
				{ name: 'staff', gid: 1700 },
			]),
		).toContain(searchProblem);
	});

	test('CONTROL: the same parent owned by the SERVICE group is reachable', () => {
		const parent = fact('/home/site', { group: 'site', mode: 0o750 });
		expect(verdictOf(parent)).not.toContain(searchProblem);
	});

	test("the owner's bits rule for the owner (0601: others may enter, the owner may not)", () => {
		const parent = fact('/home/site', { owner: 'site', group: 'site', mode: 0o601 });
		expect(verdictOf(parent)).toContain(searchProblem);
	});

	test('the GROUP class beats others (root:site 0705: the service group may not enter)', () => {
		const parent = fact('/home/site', { group: 'site', mode: 0o705 });
		expect(verdictOf(parent)).toContain(searchProblem);
	});

	test('a non-local (LDAP) owner reads as its number: the user-owned parent is matched by uid', () => {
		const parent = fact('/home/site', { owner: '1600', group: '1600', mode: 0o700 });
		const problems = verdictOf(parent);
		expect(problems).not.toContain(searchProblem);
		expect(problems.join('\n')).not.toContain('writable by an account other than root');
	});
});
