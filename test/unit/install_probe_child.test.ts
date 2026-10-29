/**
 * THE INSTALLER'S PROBE CHILD (src/core/install/install_probe.ts; terminal
 * installer phase 2, 2026-10-12), SPAWNED the way the interactive front end
 * spawns it (install_probe_client.ts): one JSON request on stdin, one JSON line
 * on stdout.
 *
 *  - `identity` (owner decisions 2026-10-12): off production its sentence;
 *    on production, through the SCRATCH SEAM (DEDALO_INSTALL_HOST_ROOT — its
 *    os-release, its fake account table: never this machine's), the verdict
 *    host_preflight would freeze — an existing hosting account used as it is
 *    (told its login shell), an install's remains refused by its sentence;
 *  - `system`: the rows, the engine version, the seed path; on docker/trial
 *    only the HOST's rows (no psql / PostgreSQL / ImageMagick / FFmpeg — B4: a
 *    Docker host has none, and a must-pass gate must not block on them);
 *  - `db` against a socket directory that does not exist: ok:false, no throw;
 *  - `mailer` with no host: ok:false;
 *  - `media`: a writable scratch path can be created; a relative one refused;
 *  - `catalog` over a LOCAL fixture source: the offered entries, the extracted
 *    copy cleaned up;
 *  - an unknown probe / a malformed request exit 2;
 *  - stdout never echoes a secret of the request (sentinels in every secret
 *    field, a probe failure that would quote one included).
 * Plus the pure part of the System check (systemCheckRows): an init failure no
 * row names still FAILS (never dropped past the gate). And the ENVIRONMENT a
 * probe child gets: a process LAUNCHED with DEDALO_INSTALL_ROOT_PASSWORD that
 * removed it (unsetProcessEnv, as scripts/install.ts does) spawns its probe
 * children through the real client spawn WITHOUT it — with the control that
 * Bun's default spawn env would still carry it (the trap is real).
 *
 * DB-FREE: the only database probe aims at a socket directory that does not
 * exist. The children get a scratch private dir; nothing is written outside the
 * mkdtemp dirs this file removes.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
	INSTALLER_IDENTITY_SEAM,
	installerVersionLabel,
} from '../../src/core/install/installer_identity.ts';
import { SEED_DUMP_PATH } from '../../src/core/install/paths.ts';
import type { PsqlProbe } from '../../src/core/install/pg_bin.ts';
import { systemCheckRows } from '../../src/core/install/probes.ts';
import {
	DEDALO_DATA_VERSION,
	DEDALO_NEXT_RELEASE,
	formatVersion,
} from '../../src/core/update/version.ts';
import { localOntologySource } from '../helpers/install_answer_cases.ts';
import {
	HOST_VARIANTS,
	type HostVariant,
	hostFiles,
	hostResponses,
	plantOwned,
	SCRATCH_DIR,
	type ScratchIdentity,
} from '../helpers/install_host_scratch.ts';

const ROOT = resolve(import.meta.dir, '../..');
const CHILD = join(ROOT, 'src/core/install/install_probe.ts');
const scratchRoot = mkdtempSync(join(tmpdir(), 'dedalo_install_probe_child_'));

/** The local ontology source, written into THIS gate's mkdtemp (the helper only returns bytes). */
function writeSource(dir: string, files = localOntologySource()): string {
	mkdirSync(dir, { recursive: true });
	for (const [name, bytes] of files) writeFileSync(join(dir, name), bytes);
	return dir;
}

afterAll(() => rmSync(scratchRoot, { recursive: true, force: true }));
const PRIVATE = mkdtempSync(join(scratchRoot, 'private_'));

const SENTINELS = {
	db_password: 'Zz-DbSentinel-4417',
	mysql_password: 'Zz-MySentinel-5528',
	smtp_pass: 'Zz-SmtpSentinel-6639',
};

/** Spawn the child with one stdin text; answers its exit code and the parsed line. */
function child(
	stdin: string,
	env: Record<string, string> = {},
): {
	exitCode: number;
	stdout: string;
	answer: Record<string, unknown>;
} {
	const proc = Bun.spawnSync([process.execPath, 'run', CHILD], {
		cwd: ROOT,
		env: { ...Bun.env, DEDALO_INSTALL_PRIVATE_DIR: PRIVATE, ...env },
		stdin: Buffer.from(stdin),
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const stdout = proc.stdout.toString();
	const lines = stdout.trim().split('\n');
	expect(lines.length, `exactly one stdout line: ${stdout}`).toBe(1);
	return { exitCode: proc.exitCode, stdout, answer: JSON.parse(lines[0] as string) };
}

const request = (
	probe: string,
	answers: Record<string, unknown> = {},
	extra: Record<string, unknown> = {},
) => JSON.stringify({ probe, answers, secrets: SENTINELS, ...extra });

function expectNoSentinel(text: string): void {
	for (const value of Object.values(SENTINELS)) expect(text.includes(value), value).toBe(false);
}

/** An existing hosting account (login shell), used as it is. */
const HOSTING: ScratchIdentity = {
	user: 'drill.example.org',
	group: 'drill.example.org',
	dir: '/home/drill.example.org/dedalo',
	home: '/home/drill.example.org',
	uid: 1500,
	gid: 1500,
	shell: '/bin/bash',
	existing: true,
};

/** A marked scratch EL 10 host holding the hosting account's home (`extra`: more owned paths). */
function scratchIdentityHost(name: string, extra: readonly string[] = []): string {
	const root = join(scratchRoot, name);
	const variant = HOST_VARIANTS.find((item) => item.os === 'el10') as HostVariant;
	for (const [path, content] of hostFiles(variant)) {
		const real = join(root, path);
		if (path.endsWith('/')) mkdirSync(real, { recursive: true });
		else {
			mkdirSync(join(real, '..'), { recursive: true });
			writeFileSync(real, content);
		}
	}
	const own = { owner: HOSTING.user, group: HOSTING.group };
	plantOwned(root, '/home/drill.example.org', { ...own, mode: 0o750 });
	for (const path of extra) plantOwned(root, path, { ...own, mode: 0o750 });
	mkdirSync(join(root, SCRATCH_DIR), { recursive: true });
	writeFileSync(
		join(root, SCRATCH_DIR, 'responses.json'),
		JSON.stringify(hostResponses(variant, HOSTING)),
	);
	return root;
}

const PRODUCTION_ANSWERS = {
	route: 'production',
	instance: 'prado',
	entity: 'probe',
	install_dir: HOSTING.dir,
	service_user: HOSTING.user,
};

describe('probe child — identity (the install folder and the service account)', () => {
	test('off production: its sentence, no verdict', () => {
		const { exitCode, answer } = child(request('identity', { route: 'developer' }));
		expect(exitCode).toBe(0);
		expect(answer.ok).toBe(true);
		expect(answer.detail).toBe(
			'only a production install has an install folder and service account of its own',
		);
		expect(answer.identity).toBeUndefined();
	}, 60000);

	test('production, scratch seam: an existing hosting account is USED AS IS and its login shell told', () => {
		const root = scratchIdentityHost('identity_ok');
		const { exitCode, stdout, answer } = child(request('identity', PRODUCTION_ANSWERS), {
			DEDALO_INSTALL_HOST_ROOT: root,
		});
		expect(exitCode).toBe(0);
		expect(answer.ok).toBe(true);
		const verdict = answer.identity as {
			problems: string[];
			told: string[];
			user: { create: boolean; uid: number };
			folder: { kind: string; by?: string };
		};
		expect(verdict.problems).toEqual([]);
		expect({ create: verdict.user.create, uid: verdict.user.uid }).toEqual({
			create: false,
			uid: 1500,
		});
		expect(verdict.folder).toEqual({
			kind: 'create',
			by: 'user',
			ancestors: [],
		} as typeof verdict.folder);
		expect(verdict.told).toContain(
			'account drill.example.org has a login shell (/bin/bash): whoever logs in as it can change the code the service runs',
		);
		expectNoSentinel(stdout);
	}, 60000);

	test("production, scratch seam: an install's remains in the folder → ok:false with the sentence", () => {
		const root = scratchIdentityHost('identity_remains', [HOSTING.dir, `${HOSTING.dir}/dedalo`]);
		const { exitCode, answer } = child(request('identity', PRODUCTION_ANSWERS), {
			DEDALO_INSTALL_HOST_ROOT: root,
		});
		expect(exitCode).toBe(0);
		expect(answer.ok).toBe(false);
		expect(answer.detail).toContain(
			`install folder ${HOSTING.dir} already holds dedalo — an install (or its remains) is there; the installer never takes one over (remove it or choose another folder)`,
		);
	}, 60000);
});

describe('probe child — system', () => {
	test('developer: rows, the engine version, the seed path', () => {
		const { exitCode, stdout, answer } = child(request('system', { route: 'developer' }));
		expect(exitCode).toBe(0);
		expect(typeof answer.ok).toBe('boolean');
		// the installer's release identity (installer_identity.ts), never the bare data version
		expect(answer.version).toBe(installerVersionLabel());
		expect(answer.seedPath).toBe(SEED_DUMP_PATH);
		const labels = (answer.rows as { label: string; state: string }[]).map((row) => row.label);
		for (const label of ['Bun', 'Private directory', 'Platform', 'ImageMagick', 'FFmpeg']) {
			expect(labels, label).toContain(label);
		}
		expectNoSentinel(stdout);
	}, 60000);

	// Release identity (design §2.4): the System check names WHICH release this installer is,
	// its kind said — a beta and the stable release share the data version `7.0.0` (C3i-F1).
	test('the System check names the release identity and its kind (stable, prerelease, development build)', () => {
		for (const [pinned, shown] of [
			[formatVersion(DEDALO_DATA_VERSION), formatVersion(DEDALO_DATA_VERSION)],
			[
				`${formatVersion(DEDALO_DATA_VERSION)}-beta.7`,
				`${formatVersion(DEDALO_DATA_VERSION)}-beta.7 (prerelease)`,
			],
			[
				`${DEDALO_NEXT_RELEASE.join('.')}-dev`,
				`${DEDALO_NEXT_RELEASE.join('.')}-dev (development build)`,
			],
		] as const) {
			const { answer } = child(request('system', { route: 'trial' }), {
				[INSTALLER_IDENTITY_SEAM]: pinned,
			});
			expect({ pinned, version: answer.version }).toEqual({ pinned, version: shown });
		}
	}, 120000);

	test('docker / trial: only the host rows (no psql, PostgreSQL, ImageMagick, FFmpeg)', () => {
		for (const route of ['docker', 'trial']) {
			const { answer } = child(request('system', { route }));
			const labels = (answer.rows as { label: string }[]).map((row) => row.label);
			expect(labels, route).toContain('Bun');
			for (const absent of [
				'PostgreSQL client',
				'PostgreSQL version',
				'ImageMagick',
				'FFmpeg',
				'Install seed',
			]) {
				expect(labels, `${route}: ${absent}`).not.toContain(absent);
			}
		}
	}, 60000);
});

describe('probe child — connections answer, never throw', () => {
	test('db: a socket directory that does not exist → ok:false; no secret echoed', () => {
		const { exitCode, stdout, answer } = child(
			request('db', {
				db_socket: join(scratchRoot, 'no_such_socket_dir'),
				db_database: 'zz_probe_absent',
				db_username: 'zz_probe_role',
				entity: 'probe',
			}),
		);
		expect(exitCode).toBe(0);
		expect(answer.ok).toBe(false);
		expect(String(answer.detail).length).toBeGreaterThan(0);
		expectNoSentinel(stdout);
	}, 60000);

	test('mailer: no host → ok:false; no secret echoed', () => {
		const { exitCode, stdout, answer } = child(request('mailer', { mailer: true, smtp_host: '' }));
		expect(exitCode).toBe(0);
		expect(answer.ok).toBe(false);
		expectNoSentinel(stdout);
	}, 60000);

	test('media: a creatable scratch path passes; a relative one is refused', () => {
		const creatable = child(
			request('media', { route: 'developer', media_path: join(scratchRoot, 'm', 'n') }),
		);
		expect(creatable.answer.ok).toBe(true);
		const relative = child(request('media', { route: 'developer', media_path: 'media/here' }));
		expect(relative.answer.ok).toBe(false);
	}, 60000);

	test('catalog: a LOCAL fixture source is offered (the parent never resolves it itself)', () => {
		const source = writeSource(join(scratchRoot, 'source'));
		const { exitCode, answer } = child(
			request('catalog', { update_servers: 'none', ontology_source: source }, { prior_env: {} }),
		);
		expect(exitCode).toBe(0);
		expect(answer.ok).toBe(true);
		const entries = (answer.catalog as { entries: { tld: string }[] }).entries.map(
			(entry) => entry.tld,
		);
		expect(entries).toContain('zzsma');
		expect(entries).toContain('zzsmb');
	}, 60000);
});

describe('probe child — refusals', () => {
	test('an unknown probe and a malformed request exit 2 (the request is never echoed)', () => {
		const unknown = child(request('format_disk'));
		expect(unknown.exitCode).toBe(2);
		expect(unknown.answer.ok).toBe(false);
		expectNoSentinel(unknown.stdout);
		const malformed = child(`not json ${SENTINELS.db_password}`);
		expect(malformed.exitCode).toBe(2);
		expectNoSentinel(malformed.stdout);
	}, 60000);
});

describe('the System check rows (pure)', () => {
	const MISSING: PsqlProbe = { state: 'missing', path: 'psql' };
	const init = (msg: string[], errors: string[], psql: PsqlProbe = MISSING) => ({
		result: errors.length === 0,
		msg,
		errors,
		psql,
	});

	test('an init failure is a FAIL row — one no row names included (never dropped past the gate)', () => {
		const rows = systemCheckRows(
			init(
				['Bun runtime 1.4 — OK'],
				['PostgreSQL client (psql) not found', 'Zz a future check failed'],
			),
			null,
			'developer',
		);
		// The psql line is the routed row's (built from the typed probe), never an unnamed "Check".
		expect(rows.filter((row) => row.state === 'fail').map((row) => row.label)).toEqual([
			'Check',
			'PostgreSQL client',
		]);
		expect(rows.find((row) => row.label === 'Check')?.detail).toBe('Zz a future check failed');
	});

	test('docker: a missing psql is not this host’s failure', () => {
		const rows = systemCheckRows(
			init(['Bun runtime 1.4 — OK'], ['PostgreSQL client (psql) not found']),
			null,
			'docker',
		);
		expect(rows.filter((row) => row.state === 'fail')).toEqual([]);
	});
});

describe('probe child — the environment it inherits', () => {
	test('a removed DEDALO_INSTALL_* secret reaches no probe child (Bun default env would leak it)', () => {
		const sentinel = 'Zz-RootSentinel-7740';
		const dir = mkdtempSync(join(scratchRoot, 'env_'));
		// The client spawns [execPath, 'run', <child>] in `cwd`: with execPath /bin/sh and a
		// script named `run` in cwd, the "child" is a reporter of its own environment. Like
		// the real probe child it reads its whole request first: a reporter that exits
		// unread races the client's stdin write (EPIPE under load — measured 2/40 at load
		// ~400) and would measure THAT, not the environment. The early exit has its own leg below.
		writeFileSync(
			join(dir, 'run'),
			'cat >/dev/null\nprintf \'{"ok":true,"detail":"%s"}\\n\' "${DEDALO_INSTALL_ROOT_PASSWORD-absent}"\n',
		);
		const driver = join(dir, 'driver.ts');
		writeFileSync(
			driver,
			[
				`import { unsetProcessEnv } from ${JSON.stringify(join(ROOT, 'src/config/env.ts'))};`,
				`import { childProbes } from ${JSON.stringify(join(ROOT, 'src/core/install/install_probe_client.ts'))};`,
				"unsetProcessEnv(['DEDALO_INSTALL_ROOT_PASSWORD']);",
				`const probes = childProbes({ execPath: '/bin/sh', cwd: ${JSON.stringify(dir)} });`,
				'const client = (await probes.media({})).detail;',
				`const control = Bun.spawnSync(['/bin/sh', 'run'], { cwd: ${JSON.stringify(dir)}, stdin: 'ignore' }).stdout.toString();`,
				'console.log(JSON.stringify({ client, control }));',
			].join('\n'),
		);
		const proc = Bun.spawnSync([process.execPath, 'run', driver], {
			cwd: ROOT,
			env: { ...Bun.env, DEDALO_INSTALL_ROOT_PASSWORD: sentinel },
			stdout: 'pipe',
			stderr: 'pipe',
		});
		expect(proc.exitCode, proc.stderr.toString()).toBe(0);
		const out = JSON.parse(proc.stdout.toString().trim().split('\n').at(-1) as string);
		// Anti-vacuity: the launch environ DID carry it, and Bun's default spawn still passes it.
		expect(out.control).toContain(sentinel);
		expect(out.client).toBe('absent');
	}, 60000);

	test('a child that closes its stdin WITHOUT reading its request is a failed probe, never a crash (EPIPE) — even when it answers ok', () => {
		const dir = mkdtempSync(join(scratchRoot, 'unread_'));
		// Closes its stdin unread, stays alive, then answers ok. Alive matters: Bun DROPS a
		// write to a child it has already reaped (write() → true, measured Bun 1.4.3), so
		// only a live child with a closed read end makes the pipe error observable. The
		// 8 MiB request is more than any pipe buffer (Linux pipe-max-size 1 MiB): whether
		// the close lands before the write or during it, the write meets EPIPE — the
		// shape that crashed the driver (2/40 under load ~400 on a reporter that exited unread).
		writeFileSync(
			join(dir, 'run'),
			'exec 0<&-\nsleep 3\nprintf \'{"ok":true,"detail":"unread"}\\n\'\n',
		);
		const driver = join(dir, 'driver.ts');
		writeFileSync(
			driver,
			[
				`import { childProbes } from ${JSON.stringify(join(ROOT, 'src/core/install/install_probe_client.ts'))};`,
				`const probes = childProbes({ execPath: '/bin/sh', cwd: ${JSON.stringify(dir)} });`,
				"const outcome = await probes.media({ pad: 'x'.repeat(8 << 20) });",
				'await Bun.sleep(50);', // a late rejection of the stdin flush would kill the driver here
				'console.log(JSON.stringify({ ok: outcome.ok, detail: outcome.detail }));',
			].join('\n'),
		);
		const proc = Bun.spawnSync([process.execPath, 'run', driver], {
			cwd: ROOT,
			env: { ...Bun.env },
			stdout: 'pipe',
			stderr: 'pipe',
		});
		expect(proc.exitCode, proc.stderr.toString()).toBe(0);
		const out = JSON.parse(proc.stdout.toString().trim().split('\n').at(-1) as string);
		// An answer to a request the child never read answers nothing: fail closed.
		expect(out.ok).toBe(false);
		expect(out.detail).toMatch(/^the media probe did not read its request/);
	}, 60000);
});

describe('a probe writes no server state (campaign 3 C3-20)', () => {
	/**
	 * An operator's environment: no suite seam, no configured database (the
	 * suite's preload sets both) — only what a shell has, and the private dir.
	 */
	function operatorEnv(privateDir: string): Record<string, string> {
		const kept = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'USER'];
		const env: Record<string, string> = {};
		for (const key of kept) if (Bun.env[key] !== undefined) env[key] = Bun.env[key] as string;
		return { ...env, DEDALO_PRIVATE_DIR: privateDir, DEDALO_INSTALL_PRIVATE_DIR: privateDir };
	}

	test('a System check through the real client leaves an empty parent EMPTY (no ../private, no ts_state.json, no session store)', () => {
		const parent = mkdtempSync(join(scratchRoot, 'c320_'));
		const privateDir = join(parent, 'private');
		const driver = join(scratchRoot, 'c320_driver.ts');
		writeFileSync(
			driver,
			[
				`import { childProbes } from ${JSON.stringify(join(ROOT, 'src/core/install/install_probe_client.ts'))};`,
				`const probes = childProbes({ execPath: process.execPath, cwd: ${JSON.stringify(ROOT)} });`,
				"const outcome = await probes.system('docker');",
				'console.log(JSON.stringify({ ok: outcome.ok, rows: (outcome.rows ?? []).length }));',
			].join('\n'),
		);
		const proc = Bun.spawnSync([process.execPath, 'run', driver], {
			cwd: ROOT,
			env: operatorEnv(privateDir),
			stdout: 'pipe',
			stderr: 'pipe',
		});
		expect(proc.exitCode, proc.stderr.toString()).toBe(0);
		const out = JSON.parse(proc.stdout.toString().trim().split('\n').at(-1) as string);
		expect(out.rows).toBeGreaterThan(2); // anti-vacuity: the check ran
		expect(readdirSync(parent)).toEqual([]);
	}, 60000);

	test('control: the bare probe child, without the client, DOES write the state file there (the trap is real)', () => {
		const parent = mkdtempSync(join(scratchRoot, 'c320_control_'));
		const privateDir = join(parent, 'private');
		const proc = Bun.spawnSync([process.execPath, 'run', CHILD], {
			cwd: ROOT,
			env: operatorEnv(privateDir),
			stdin: Buffer.from(
				JSON.stringify({ probe: 'system', answers: { route: 'docker' }, secrets: {} }),
			),
			stdout: 'pipe',
			stderr: 'pipe',
		});
		expect(proc.exitCode).toBe(0);
		expect(readdirSync(privateDir)).toContain('ts_state.json');
	}, 60000);
});
