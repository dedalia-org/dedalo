/**
 * `provision init` writes the Publication API v2's `v2.env` (engineering/PUBLICATION_HOST_SPEC.md
 * §9; spec §5.8): publication/host_agent/src/provision/init/api_config.ts `renderV2Env` fills
 * the REAL template (publication/server_api/v2/.env.example) by one-line replacements, every
 * value single-quoted. The agent package may not import v2 (two deployables), so this ROOT gate
 * proves the round trip the agent's own test cannot: the rendered file, loaded as an env file by
 * a CHILD Bun, boots v2's OWN config module (`src/config.ts`: its zod schema, its cross-field
 * refine, its DB_NAMES allowlist) and reads back exactly the typed values — including a password
 * full of punctuation an env loader could cut.
 *
 * MEASURED 2026-10-08 (Bun 1.4.2): Bun's env-file loader EXPANDS `$NAME` even inside SINGLE
 * quotes (`DB_PASSWORD='p@ss$HOME…'` boots as `p@ss/var/folders/…`). systemd's EnvironmentFile=
 * (how the v2 unit reads v2.env) does not expand, but a v2 started by hand with the same file
 * (`bun --env-file`, a copied `.env`) gets another password than the one typed. Single quoting
 * is therefore not the `$` defence the spec's quoting row assumes: the last test below requires
 * the secret grammar to refuse `$`.
 *
 * The child's environment is EMPTY but PATH/HOME, so nothing the test process holds can stand
 * in for a key the file failed to carry. RED — never skipped — when v2's dependencies are
 * absent: the tier that runs this gate installs them (scripts/ci/db_tier.sh,
 * `bun install --frozen-lockfile --cwd publication/server_api/v2`).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEnvFile } from '../../publication/host_agent/src/env_file.ts';
import {
	ApiConfigRefused,
	renderV2Env,
	type V2Values,
	verifyV2RoundTrip,
} from '../../publication/host_agent/src/provision/init/api_config.ts';

const ROOT = resolve(import.meta.dir, '../..');
const V2 = join(ROOT, 'publication/server_api/v2');
const TEMPLATE = readFileSync(join(V2, '.env.example'), 'utf8');
const scratch = mkdtempSync(join(tmpdir(), 'dedalo-v2env-'));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** v2's config, booted in a child Bun from `envFile` alone; the keys init sets, as v2 parsed them. */
async function bootV2Config(envFile: string): Promise<{ code: number; out: string; err: string }> {
	const probe = [
		`const m = await import(${JSON.stringify(join(V2, 'src/config.ts'))});`,
		'const c = m.config;',
		'console.log(JSON.stringify({ DB_HOST: c.DB_HOST, DB_PORT: c.DB_PORT, DB_SOCKET: c.DB_SOCKET, DB_USER: c.DB_USER,',
		'  DB_PASSWORD: c.DB_PASSWORD, DB_NAMES: m.dbNames, DEPLOYMENT_MODE: c.DEPLOYMENT_MODE }));',
	].join('\n');
	const child = Bun.spawn([process.execPath, `--env-file=${envFile}`, '-e', probe], {
		cwd: V2,
		env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: scratch },
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [out, err, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { code, out, err };
}

function render(values: V2Values, name: string): { path: string; text: string } {
	const text = renderV2Env(TEMPLATE, values);
	verifyV2RoundTrip(text, values, parseEnvFile);
	const path = join(scratch, name);
	writeFileSync(path, text, { mode: 0o600 });
	return { path, text };
}

describe('a v2.env init renders boots v2 config with exactly the typed values', () => {
	test("v2's dependencies are installed (this gate is red, not skipped, without them)", () => {
		expect(existsSync(join(V2, 'node_modules', 'zod', 'package.json'))).toBe(true);
	});

	test('the TCP transport, a hard password, two databases, behind Apache', async () => {
		const values: V2Values = {
			host: 'db.internal',
			port: '3307',
			socket: null,
			user: 'web_ro',
			password: 'p@ss!x%y&z=1;~`^*()[]{}<>|?/,.:',
			dbNames: ['web_museum', 'web_archive'],
			deploymentMode: 'apache',
		};
		const { path, text } = render(values, 'tcp.env');
		// Every other template line is kept byte for byte.
		const untouched = (s: string) =>
			s
				.split('\n')
				.filter(
					(line) =>
						!/^(DB_HOST|DB_PORT|DB_SOCKET|DB_USER|DB_PASSWORD|DB_NAMES|DEPLOYMENT_MODE)=/.test(
							line,
						),
				);
		expect(untouched(text)).toEqual(untouched(TEMPLATE));
		const booted = await bootV2Config(path);
		expect(booted.code, booted.err).toBe(0);
		expect(JSON.parse(booted.out)).toEqual({
			DB_HOST: 'db.internal',
			DB_PORT: 3307,
			DB_SOCKET: '',
			DB_USER: 'web_ro',
			DB_PASSWORD: values.password,
			DB_NAMES: ['web_museum', 'web_archive'],
			DEPLOYMENT_MODE: 'apache',
		});
	});

	test('the socket transport, behind nginx', async () => {
		const values: V2Values = {
			host: 'localhost',
			port: '3306',
			socket: '/run/mysqld/mysqld.sock',
			user: 'web_ro',
			password: 'abcdefgh12345678',
			dbNames: ['web_museum'],
			deploymentMode: 'nginx',
		};
		const booted = await bootV2Config(render(values, 'socket.env').path);
		expect(booted.code, booted.err).toBe(0);
		const config = JSON.parse(booted.out) as Record<string, unknown>;
		expect([config.DB_SOCKET, config.DEPLOYMENT_MODE, config.DB_NAMES]).toEqual([
			'/run/mysqld/mysqld.sock',
			'nginx',
			['web_museum'],
		]);
	});

	test('a password with letters outside ASCII (ñ, ç, ü, €, a CJK and an emoji) boots back byte-exact', async () => {
		const values: V2Values = {
			host: '127.0.0.1',
			port: '3306',
			socket: null,
			user: 'web_ro',
			password: 'Contraseña#ç-ü+€_漢字!🔑',
			dbNames: ['web_museum'],
			deploymentMode: 'apache',
		};
		const booted = await bootV2Config(render(values, 'utf8.env').path);
		expect(booted.code, booted.err).toBe(0);
		expect((JSON.parse(booted.out) as Record<string, unknown>).DB_PASSWORD).toBe(values.password);
	});

	test('anti-vacuity: a file without the keys does NOT read back the typed values (v2 falls back to its defaults)', async () => {
		const path = join(scratch, 'empty.env');
		writeFileSync(path, '# nothing\n', { mode: 0o600 });
		const booted = await bootV2Config(path);
		expect(booted.code, booted.err).toBe(0);
		expect((JSON.parse(booted.out) as Record<string, unknown>).DB_USER).toBe('readonly_user');
	});

	test('a value the grammar refuses is never rendered (a quote in the password)', () => {
		expect(() =>
			renderV2Env(TEMPLATE, {
				host: 'localhost',
				port: '3306',
				socket: null,
				user: 'web_ro',
				password: "it's-a-password",
				dbNames: ['web_museum'],
				deploymentMode: 'apache',
			}),
		).toThrow(ApiConfigRefused);
	});

	test("'$' in a secret is refused: Bun's env-file loader expands it even inside single quotes", async () => {
		// The measurement the requirement rests on: a `$`-bearing value written the way
		// renderV2Env writes it does NOT read back through Bun's loader.
		const path = join(scratch, 'dollar.env');
		writeFileSync(path, "DB_PASSWORD='abc$HOME'\nDB_NAMES='web'\n", { mode: 0o600 });
		const booted = await bootV2Config(path);
		expect(booted.code, booted.err).toBe(0);
		expect((JSON.parse(booted.out) as Record<string, unknown>).DB_PASSWORD).not.toBe('abc$HOME');
		// So the grammar must refuse it before anything is rendered.
		expect(() =>
			renderV2Env(TEMPLATE, {
				host: 'localhost',
				port: '3306',
				socket: null,
				user: 'web_ro',
				password: 'abc$HOME12345',
				dbNames: ['web_museum'],
				deploymentMode: 'apache',
			}),
		).toThrow(ApiConfigRefused);
	});
});
