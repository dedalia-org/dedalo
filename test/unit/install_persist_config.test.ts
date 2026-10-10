/**
 * P2 gate — persist_config + check_directories (DEC-19).
 *
 * DEDALO_INSTALL_PRIVATE_DIR redirects the installer's writes to a scratch dir
 * so the live ../private/.env is never touched. Asserts: the .env carries the
 * catalog's canonical key names (never a PHP_KEY_ALIASES spelling), is chmod 600, backs up an existing file on overwrite, `generated`
 * carries only NEW secrets, and the state flips to 'configured'.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PHP_KEY_ALIASES, parseEnvFile, seedProcessEnv } from '../../src/config/env.ts';
import { isDedaloError } from '../../src/core/errors/index.ts';
import { persistConfig } from '../../src/core/install/config_persist.ts';
import { checkDirectories } from '../../src/core/install/directories.ts';
import {
	OFFICIAL_CODE_SERVER,
	OFFICIAL_ONTOLOGY_SERVER,
} from '../../src/core/install/install_plan.ts';
import {
	closeOntologyChoice,
	vendoredOntologyCatalog,
} from '../../src/core/install/ontology_choice.ts';
import { CORE_ONTOLOGY_TLDS } from '../../src/core/ontology/core_tlds.ts';
import { getServerState, setServerState } from '../../src/core/resolve/server_state.ts';
import { markMediaRoot } from '../helpers/media_scratch_root.ts';

const scratch = mkdtempSync(join(tmpdir(), 'dedalo_install_p2_'));

beforeEach(() => {
	process.env.DEDALO_INSTALL_PRIVATE_DIR = scratch;
});
afterEach(() => {
	delete process.env.DEDALO_INSTALL_PRIVATE_DIR;
	setServerState({ install_status: undefined, information: undefined, info_key: undefined });
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const BASE_CFG = {
	db_hostname: 'localhost',
	db_port: '5432',
	db_database: 'dedalo_test_db',
	db_username: 'tester',
	db_password: 'secret pass',
	entity: 'testent',
	entity_label: 'Test Entity',
	information: 'fingerprint',
	info_key: 'k123',
	timezone: 'Europe/Madrid',
	locale: 'es-ES',
};

describe('persist_config (P2)', () => {
	test('writes canonical key names, 0600, and generates the salt', async () => {
		const result = await persistConfig({ ...BASE_CFG });
		expect(result.ok).toBe(true);
		expect(result.generated.DEDALO_SALT_STRING).toMatch(/^[0-9a-f]{64}$/);

		const envPath = join(scratch, '.env');
		const parsed = parseEnvFile(readFileSync(envPath, 'utf8'));
		expect(parsed.DB_NAME).toBe('dedalo_test_db');
		expect(parsed.DB_USER).toBe('tester');
		expect(parsed.DB_PASSWORD).toBe('secret pass');
		expect(parsed.DB_HOST).toBe('localhost');
		expect(parsed.DB_PORT).toBe('5432');
		expect(parsed.ENTITY).toBe('testent');
		expect(parsed.DEDALO_ENTITY_LABEL).toBe('Test Entity');
		// No fallback spelling of any written key: the alias is for a .env carried
		// over from PHP, never a second name the installer emits.
		const aliasSpellings = new Set(Object.values(PHP_KEY_ALIASES));
		expect(Object.keys(parsed).filter((key) => aliasSpellings.has(key))).toEqual([]);
		expect(parsed.DEDALO_SALT_STRING).toBe(result.generated.DEDALO_SALT_STRING);

		// 0600 perms (owner-only).
		expect(statSync(envPath).mode & 0o777).toBe(0o600);

		// State moved to 'configured' with the fingerprints.
		const state = getServerState();
		expect(state.install_status).toBe('configured');
		expect(state.information).toBe('fingerprint');
		expect(state.info_key).toBe('k123');
	});

	test('an existing .env is backed up, and an existing salt is PRESERVED (not regenerated)', async () => {
		const envPath = join(scratch, '.env');
		writeFileSync(envPath, 'DEDALO_SALT_STRING=deadbeef\nOLD=1\n');
		const result = await persistConfig({ ...BASE_CFG });
		expect(result.ok).toBe(true);
		// Salt preserved → NOT in `generated`.
		expect(result.generated.DEDALO_SALT_STRING).toBeUndefined();
		const parsed = parseEnvFile(readFileSync(envPath, 'utf8'));
		expect(parsed.DEDALO_SALT_STRING).toBe('deadbeef');
		// A timestamped backup of the prior file exists.
		const { readdirSync } = await import('node:fs');
		expect(readdirSync(scratch).some((n) => n.startsWith('.env.bak.'))).toBe(true);
	});

	test('a re-run over a .env in the legacy alias spelling drops the legacy line (one value, one name)', async () => {
		const envPath = join(scratch, '.env');
		writeFileSync(
			envPath,
			[
				'DEDALO_DATABASE_CONN=old_db',
				'DEDALO_HOSTNAME_CONN=old_host',
				'DEDALO_USERNAME_CONN=old_user',
				'DEDALO_PASSWORD_CONN=old_pw',
				'DEDALO_DB_PORT_CONN=5433',
				'DEDALO_ENTITY=old_entity',
				'DEDALO_PROJECTS_DEFAULT_LANGS=["lg-cat"]',
				'DEDALO_APPLICATION_LANG=lg-cat',
				'DEDALO_DATA_LANG=lg-cat',
				'DEDALO_SALT_STRING=deadbeef',
				'OPERATOR_KEPT=1',
				'',
			].join('\n'),
		);
		const result = await persistConfig({ ...BASE_CFG });
		expect(result.ok).toBe(true);
		const body = readFileSync(envPath, 'utf8');
		const parsed = parseEnvFile(body);
		// The canonical spelling carries the run's answer...
		expect(parsed.DB_NAME).toBe('dedalo_test_db');
		expect(parsed.DB_HOST).toBe('localhost');
		expect(parsed.ENTITY).toBe('testent');
		// ...and NO legacy alias line survives as a stale second copy.
		const aliasSpellings = new Set(Object.values(PHP_KEY_ALIASES));
		expect(Object.keys(parsed).filter((key) => aliasSpellings.has(key))).toEqual([]);
		// Every canonical key the run owns is assigned exactly once.
		for (const key of ['DB_NAME', 'DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_PORT', 'ENTITY']) {
			const assignments = body.split('\n').filter((line) => line.startsWith(`${key}=`)).length;
			expect(assignments, `${key} must be assigned exactly once`).toBe(1);
		}
		// Keys the run does not own are still carried over verbatim.
		expect(parsed.OPERATOR_KEPT).toBe('1');
		expect(parsed.DEDALO_SALT_STRING).toBe('deadbeef');
	});

	test('diffusion enabled → diffusion keys + internal token written', async () => {
		const result = await persistConfig({
			...BASE_CFG,
			diffusion: true,
			mysql_hostname: 'localhost',
			mysql_port: '3306',
			mysql_database: 'web_dedalo',
			mysql_username: 'diff',
			mysql_password: 'dpw',
		});
		expect(result.ok).toBe(true);
		// OPS-04: the dead internal token is no longer minted (the control plane
		// that used it was removed) — it must NOT appear in the generated secrets
		// nor in the written .env.
		expect(result.generated.DEDALO_DIFFUSION_INTERNAL_TOKEN).toBeUndefined();
		const parsed = parseEnvFile(readFileSync(join(scratch, '.env'), 'utf8'));
		expect(parsed.DEDALO_DIFFUSION_INTERNAL_TOKEN).toBeUndefined();
		expect(parsed.DEDALO_DIFFUSION_NATIVE).toBe('true');
		expect(parsed.DEDALO_DIFFUSION_DB_USER).toBe('diff');
		expect(parsed.DEDALO_DIFFUSION_DB_NAME).toBe('web_dedalo');
	});

	test('mailer enabled → the DEDALO_SMTP_* keys are written from the posted form', async () => {
		const result = await persistConfig({
			...BASE_CFG,
			mailer: true,
			smtp_host: 'smtp.example.org',
			smtp_port: '465',
			smtp_secure: 'ssl',
			smtp_user: 'dedalo@example.org',
			smtp_pass: 'mail pw',
			smtp_from: 'noreply@example.org',
			smtp_from_name: 'Dédalo',
		});
		expect(result.ok).toBe(true);
		const parsed = parseEnvFile(readFileSync(join(scratch, '.env'), 'utf8'));
		expect(parsed.DEDALO_SMTP_HOST).toBe('smtp.example.org');
		expect(parsed.DEDALO_SMTP_PORT).toBe('465');
		expect(parsed.DEDALO_SMTP_SECURE).toBe('ssl');
		expect(parsed.DEDALO_SMTP_USER).toBe('dedalo@example.org');
		expect(parsed.DEDALO_SMTP_PASS).toBe('mail pw');
		expect(parsed.DEDALO_SMTP_FROM).toBe('noreply@example.org');
		expect(parsed.DEDALO_SMTP_FROM_NAME).toBe('Dédalo');
	});

	test('mailer disabled/absent → no SMTP keys written', async () => {
		// Own scratch: the shared one may already carry SMTP keys from the enabled
		// test, and the never-delete invariant would (correctly) preserve them.
		const scratch2 = mkdtempSync(join(tmpdir(), 'dedalo_install_p2_mailoff_'));
		process.env.DEDALO_INSTALL_PRIVATE_DIR = scratch2;
		try {
			const result = await persistConfig({ ...BASE_CFG, smtp_host: 'smtp.example.org' });
			expect(result.ok).toBe(true);
			const parsed = parseEnvFile(readFileSync(join(scratch2, '.env'), 'utf8'));
			// The smtp_* form fields are ignored without the explicit mailer:true flag.
			expect(parsed.DEDALO_SMTP_HOST).toBeUndefined();
			expect(parsed.DEDALO_SMTP_PORT).toBeUndefined();
		} finally {
			process.env.DEDALO_INSTALL_PRIVATE_DIR = scratch;
			rmSync(scratch2, { recursive: true, force: true });
		}
	});

	test('previously-written SMTP keys survive a mailer-less re-save (never-delete)', async () => {
		const envPath = join(scratch, '.env');
		writeFileSync(
			envPath,
			[
				'DEDALO_SALT_STRING=deadbeef',
				'DEDALO_SMTP_HOST=smtp.old.org',
				'DEDALO_SMTP_USER=old',
				'',
			].join('\n'),
		);
		const result = await persistConfig({ ...BASE_CFG });
		expect(result.ok).toBe(true);
		const parsed = parseEnvFile(readFileSync(envPath, 'utf8'));
		expect(parsed.DEDALO_SMTP_HOST).toBe('smtp.old.org');
		expect(parsed.DEDALO_SMTP_USER).toBe('old');
	});

	/**
	 * The 2026-07-12 data loss, mechanically. The wizard invites a re-save (a page
	 * reload walks the config steps again from an EMPTY cfg), and persist_config
	 * rebuilds .env from the posted form — so on the second save every key the form
	 * did not carry was DELETED. It ate all 8 DEDALO_DIFFUSION_* keys twice, taking
	 * the generated DEDALO_DIFFUSION_INTERNAL_TOKEN (shown once, then unrecoverable)
	 * with them, plus operator-appended keys, which is what ../private/.env is FOR
	 * (append-only, documented keys).
	 *
	 * Omission is not consent: a key the form does not manage must survive verbatim.
	 */
	test('never deletes a key by omission — unmanaged keys survive a re-save verbatim', async () => {
		const envPath = join(scratch, '.env');
		// A configured install: diffusion set up, plus keys only an operator writes.
		writeFileSync(
			envPath,
			[
				'DEDALO_SALT_STRING=deadbeef',
				'DEDALO_DIFFUSION_NATIVE=true',
				'DEDALO_DIFFUSION_DB_USER=diffuser',
				'DEDALO_DIFFUSION_DB_NAME=web_default',
				'DEDALO_DIFFUSION_INTERNAL_TOKEN=tok_shown_once',
				'MEDIA_DEV_ROUTE_ENABLED=true',
				'DB_POOL_MAX=17',
				'',
			].join('\n'),
		);

		// Re-save from a FRESH wizard page: no diffusion fields, no operator keys.
		const result = await persistConfig({ ...BASE_CFG });
		expect(result.ok).toBe(true);

		const parsed = parseEnvFile(readFileSync(envPath, 'utf8'));

		// The diffusion block survives — token included. This is the bug that bit.
		expect(parsed.DEDALO_DIFFUSION_NATIVE).toBe('true');
		expect(parsed.DEDALO_DIFFUSION_DB_USER).toBe('diffuser');
		expect(parsed.DEDALO_DIFFUSION_DB_NAME).toBe('web_default');
		expect(parsed.DEDALO_DIFFUSION_INTERNAL_TOKEN).toBe('tok_shown_once');

		// Operator-appended keys survive too.
		expect(parsed.MEDIA_DEV_ROUTE_ENABLED).toBe('true');
		expect(parsed.DB_POOL_MAX).toBe('17');

		// ...while the keys the form DOES own are still updated from the form,
		// exactly once (a preserved copy must not shadow the new value).
		expect(parsed.ENTITY).toBe('testent');
		expect(parsed.DB_NAME).toBe('dedalo_test_db');
		expect(parsed.DEDALO_SALT_STRING).toBe('deadbeef'); // preserved, not regenerated
		const body = readFileSync(envPath, 'utf8');
		for (const key of ['ENTITY', 'DEDALO_SALT_STRING', 'DEDALO_DIFFUSION_DB_USER']) {
			const assignments = body
				.split('\n')
				.filter((line) => line.trim().startsWith(`${key}=`)).length;
			expect(assignments, `${key} must be assigned exactly once`).toBe(1);
		}
	});

	test('serving keys written when provided (--media-path / --socket / --media-access-mode)', async () => {
		const scratch2 = mkdtempSync(join(tmpdir(), 'dedalo_install_p2_serving_'));
		process.env.DEDALO_INSTALL_PRIVATE_DIR = scratch2;
		try {
			const result = await persistConfig({
				...BASE_CFG,
				media_path: '/srv/dedalo/media',
				unix_socket: '/run/dedalo/dedalo_ts.sock',
				media_access_mode: 'publication',
			});
			expect(result.ok).toBe(true);
			const parsed = parseEnvFile(readFileSync(join(scratch2, '.env'), 'utf8'));
			expect(parsed.MEDIA_PATH).toBe('/srv/dedalo/media');
			expect(parsed.SERVER_UNIX_SOCKET).toBe('/run/dedalo/dedalo_ts.sock');
			expect(parsed.DEDALO_MEDIA_ACCESS_MODE).toBe('publication');
		} finally {
			process.env.DEDALO_INSTALL_PRIVATE_DIR = scratch;
			rmSync(scratch2, { recursive: true, force: true });
		}
	});

	test('serving keys omitted → not written, and a prior value is preserved (never-delete)', async () => {
		const scratch2 = mkdtempSync(join(tmpdir(), 'dedalo_install_p2_serving_off_'));
		process.env.DEDALO_INSTALL_PRIVATE_DIR = scratch2;
		try {
			// A prior install set the socket; a re-save carries no serving flags.
			writeFileSync(
				join(scratch2, '.env'),
				['DEDALO_SALT_STRING=deadbeef', 'SERVER_UNIX_SOCKET=/run/dedalo/dedalo_ts.sock', ''].join(
					'\n',
				),
			);
			const result = await persistConfig({ ...BASE_CFG });
			expect(result.ok).toBe(true);
			const parsed = parseEnvFile(readFileSync(join(scratch2, '.env'), 'utf8'));
			// Preserved verbatim — an empty flag must not clobber it.
			expect(parsed.SERVER_UNIX_SOCKET).toBe('/run/dedalo/dedalo_ts.sock');
			// A serving key never set stays absent (no empty assignment written).
			expect(parsed.MEDIA_PATH).toBeUndefined();
			expect(parsed.DEDALO_MEDIA_ACCESS_MODE).toBeUndefined();
		} finally {
			process.env.DEDALO_INSTALL_PRIVATE_DIR = scratch;
			rmSync(scratch2, { recursive: true, force: true });
		}
	});

	/**
	 * `create:true` also provisions the MEDIA TREE (install/media_tree.ts), so this
	 * test MUST redirect the media root: without `mediaRoot`, it mkdirs into the
	 * live configured media root — which it did, on a real machine, before the seam
	 * existed. A unit test never touches a live surface, filesystem included.
	 *
	 * It also makes the assertion honest: `result` folded in the writability of the
	 * whole real media tree, so this test would have gone red on any box whose media
	 * root belongs to the web-server user.
	 */
	test('check_directories creates + verifies the private tree (never the live media root)', () => {
		// DECLARE the scratch media root: checkDirectories mkdirs it, and a media-root
		// door refuses an undeclared one under the test-media seam
		// (src/core/media/test_media_root.ts).
		const mediaRoot = markMediaRoot(mkdtempSync(join(tmpdir(), 'dedalo_install_p2_media_')));
		try {
			const r = checkDirectories({ create: true, mediaRoot });
			expect(r.ok).toBe(true);
			const priv = r.dirs.find((d) => d.label === 'Private config');
			expect(priv?.exists).toBe(true);
			expect(priv?.writable).toBe(true);
			// The media rows point at the scratch root, never at config.media.rootPath.
			expect(r.dirs.find((d) => d.label === 'Media')?.path).toBe(mediaRoot);
			expect(r.mediaTree?.root).toBe(mediaRoot);
		} finally {
			rmSync(mediaRoot, { recursive: true, force: true });
		}
	});

	test('writes the four MANDATORY lang keys; JSON keys round-trip through parseEnvFile', async () => {
		// The picked set drives both the map and the code list.
		const result = await persistConfig({
			...BASE_CFG,
			langs: ['lg-eng', 'lg-spa'],
			app_lang_default: 'lg-eng',
			data_lang_default: 'lg-spa',
		});
		expect(result.ok).toBe(true);
		const parsed = parseEnvFile(readFileSync(join(scratch, '.env'), 'utf8'));

		// The two JSON-shaped keys must parse back EXACTLY (the raw-write contract:
		// envQuote'd JSON would break here because parseEnvFile does not unescape).
		expect(JSON.parse(parsed.DEDALO_APPLICATION_LANGS as string)).toEqual({
			'lg-eng': 'English',
			'lg-spa': 'Castellano',
		});
		expect(JSON.parse(parsed.PROJECTS_DEFAULT_LANGS as string)).toEqual(['lg-eng', 'lg-spa']);

		// The scalar mandatory keys + the coherent APPLICATION_LANG/DATA_LANG mirror.
		expect(parsed.DEDALO_APPLICATION_LANGS_DEFAULT).toBe('lg-eng');
		expect(parsed.DEDALO_DATA_LANG_DEFAULT).toBe('lg-spa');
		expect(parsed.APPLICATION_LANG).toBe('lg-eng');
		expect(parsed.DATA_LANG).toBe('lg-spa');
		expect(parsed.DEDALO_STRUCTURE_LANG).toBe('lg-spa');
	});

	test('no langs posted → defaults to lg-eng + lg-spa (still bootable)', async () => {
		const result = await persistConfig({ ...BASE_CFG });
		expect(result.ok).toBe(true);
		const parsed = parseEnvFile(readFileSync(join(scratch, '.env'), 'utf8'));
		const map = JSON.parse(parsed.DEDALO_APPLICATION_LANGS as string) as Record<string, string>;
		expect(Object.keys(map)).toEqual(['lg-eng', 'lg-spa']);
		expect(map['lg-eng']).toBe('English');
		expect(JSON.parse(parsed.PROJECTS_DEFAULT_LANGS as string)).toEqual(['lg-eng', 'lg-spa']);
		expect(parsed.DEDALO_APPLICATION_LANGS_DEFAULT).toBe('lg-eng');
		expect(parsed.DEDALO_DATA_LANG_DEFAULT).toBe('lg-eng');
	});

	test('REFUSES an unusable lang selection — no .env written', async () => {
		const scratch2 = mkdtempSync(join(tmpdir(), 'dedalo_install_p2_langfail_'));
		process.env.DEDALO_INSTALL_PRIVATE_DIR = scratch2;
		try {
			// default ∉ the selected set → refuse. P1 sweep: a refusal is a THROWN
			// registered code, never a `result:false` body.
			const error = await persistConfig({
				...BASE_CFG,
				langs: ['lg-eng'],
				app_lang_default: 'lg-spa',
			}).then(
				() => null,
				(caught: unknown) => caught,
			);
			expect(isDedaloError(error)).toBe(true);
			expect((error as { code: string }).code).toBe('install.invalid_input');
			expect((error as Error).message).toContain('Install answers invalid: languages:');
			// nothing written
			const { existsSync } = await import('node:fs');
			expect(existsSync(join(scratch2, '.env'))).toBe(false);
		} finally {
			process.env.DEDALO_INSTALL_PRIVATE_DIR = scratch;
			rmSync(scratch2, { recursive: true, force: true });
		}
	});

	/**
	 * UPDATE SERVERS (installer unification A3, 2026-10-08). No installer used to
	 * write ONTOLOGY_SERVERS / CODE_SERVERS, so every fresh install's update
	 * panels answered "No master servers are configured". The official master is
	 * the default; `[]` (air-gapped) only on an explicit answer; a list the
	 * operator already has survives a non-air-gapped re-save.
	 */
	async function persistInOwnScratch(
		name: string,
		answers: Record<string, unknown>,
		prior?: string,
	): Promise<{ body: string; parsed: Record<string, string> }> {
		const own = mkdtempSync(join(tmpdir(), `dedalo_install_p2_${name}_`));
		seedProcessEnv({ DEDALO_INSTALL_PRIVATE_DIR: own });
		try {
			if (prior !== undefined) writeFileSync(join(own, '.env'), prior);
			const result = await persistConfig(answers);
			expect(result.ok).toBe(true);
			const body = readFileSync(join(own, '.env'), 'utf8');
			return { body, parsed: parseEnvFile(body) };
		} finally {
			seedProcessEnv({ DEDALO_INSTALL_PRIVATE_DIR: scratch });
			rmSync(own, { recursive: true, force: true });
		}
	}

	test('update servers: absent answer → the official master for ontology AND code', async () => {
		const { parsed } = await persistInOwnScratch('servers_default', { ...BASE_CFG });
		expect(JSON.parse(parsed.ONTOLOGY_SERVERS as string)).toEqual([OFFICIAL_ONTOLOGY_SERVER]);
		expect(JSON.parse(parsed.CODE_SERVERS as string)).toEqual([OFFICIAL_CODE_SERVER]);
	});

	test('update servers: update_servers:false (air-gapped) → both [] — even over a prior list', async () => {
		const prior =
			'DEDALO_SALT_STRING=deadbeef\nONTOLOGY_SERVERS=[{"name":"m","url":"https://m.example.org/","code":"c"}]\n';
		const { parsed } = await persistInOwnScratch(
			'servers_none',
			{ ...BASE_CFG, update_servers: false },
			prior,
		);
		// Floor: the written .env parsed into real keys (the prior's salt survived) — an
		// empty parse would make the two empty lists below vacuous.
		expect(Object.keys(parsed).length).toBeGreaterThan(2);
		expect(parsed.DEDALO_SALT_STRING).toBe('deadbeef');
		expect(JSON.parse(parsed.ONTOLOGY_SERVERS as string)).toEqual([]);
		expect(JSON.parse(parsed.CODE_SERVERS as string)).toEqual([]);
	});

	test('update servers: a prior custom list survives an official re-save verbatim, once', async () => {
		const mirror =
			'CODE_SERVERS=[{"name":"Mirror","url":"https://mirror.example.org/dedalo/core/api/v1/json/","code":"m"}]';
		const { body, parsed } = await persistInOwnScratch(
			'servers_mirror',
			{ ...BASE_CFG, update_servers: true },
			`DEDALO_SALT_STRING=deadbeef\n${mirror}\n`,
		);
		expect(body.split('\n').filter((line) => line.startsWith('CODE_SERVERS='))).toEqual([mirror]);
		expect(JSON.parse(parsed.ONTOLOGY_SERVERS as string)).toEqual([OFFICIAL_ONTOLOGY_SERVER]);
	});

	/**
	 * DOMAIN ONTOLOGIES (installer unification A4, 2026-10-09): ACTIVE_ONTOLOGY_TLDS
	 * is an OWNED key — core + the install order, rewritten on every save (a prior
	 * hand-written list is replaced, never carried as "Preserved") — and the step's
	 * answer names what will be staged.
	 */
	test('ontologies: the default writes core + oh, owned, and the answer names the install', async () => {
		const own = mkdtempSync(join(tmpdir(), 'dedalo_install_p2_ontologies_'));
		seedProcessEnv({ DEDALO_INSTALL_PRIVATE_DIR: own });
		try {
			writeFileSync(
				join(own, '.env'),
				'DEDALO_SALT_STRING=deadbeef\nACTIVE_ONTOLOGY_TLDS=dd,zzstale\n',
			);
			const result = await persistConfig({ ...BASE_CFG });
			expect(result.ontology_install).toEqual(['oh']);
			expect(result.active_ontology_tlds).toEqual([...CORE_ONTOLOGY_TLDS, 'oh']);
			// The vendored oh's declaration is the vendored ontology.json entry's:
			// declared → no warning; absent (a release predating hierarchy60) → the
			// not-declared warning, oh installed alone — never an error.
			expect(result.warnings).toEqual(
				closeOntologyChoice(['oh'], vendoredOntologyCatalog()).warnings,
			);
			expect(result.hierarchy_dependencies).toEqual([]);
			const body = readFileSync(join(own, '.env'), 'utf8');
			const lines = body.split('\n').filter((line) => line.startsWith('ACTIVE_ONTOLOGY_TLDS='));
			expect(lines).toEqual([
				`ACTIVE_ONTOLOGY_TLDS=${JSON.stringify([...CORE_ONTOLOGY_TLDS, 'oh'])}`,
			]);
			expect(JSON.parse(parseEnvFile(body).ACTIVE_ONTOLOGY_TLDS as string)).toEqual(
				result.active_ontology_tlds,
			);
		} finally {
			seedProcessEnv({ DEDALO_INSTALL_PRIVATE_DIR: scratch });
			rmSync(own, { recursive: true, force: true });
		}
	});

	test('ontologies: none REFUSES — no .env written', async () => {
		const own = mkdtempSync(join(tmpdir(), 'dedalo_install_p2_ontologies_none_'));
		seedProcessEnv({ DEDALO_INSTALL_PRIVATE_DIR: own });
		try {
			const error = await persistConfig({ ...BASE_CFG, ontologies: [] }).then(
				() => null,
				(caught: unknown) => caught,
			);
			expect(isDedaloError(error)).toBe(true);
			expect((error as Error).message).toContain(
				'at least one domain ontology is required (the default is oh)',
			);
			const { existsSync } = await import('node:fs');
			expect(existsSync(join(own, '.env'))).toBe(false);
		} finally {
			seedProcessEnv({ DEDALO_INSTALL_PRIVATE_DIR: scratch });
			rmSync(own, { recursive: true, force: true });
		}
	});

	test('update servers: an unknown choice REFUSES — no .env written', async () => {
		const own = mkdtempSync(join(tmpdir(), 'dedalo_install_p2_servers_bad_'));
		seedProcessEnv({ DEDALO_INSTALL_PRIVATE_DIR: own });
		try {
			const error = await persistConfig({ ...BASE_CFG, update_servers: 'mirror' }).then(
				() => null,
				(caught: unknown) => caught,
			);
			expect(isDedaloError(error)).toBe(true);
			expect((error as Error).message).toContain('update_servers must be official|none');
			const { existsSync } = await import('node:fs');
			expect(existsSync(join(own, '.env'))).toBe(false);
		} finally {
			seedProcessEnv({ DEDALO_INSTALL_PRIVATE_DIR: scratch });
			rmSync(own, { recursive: true, force: true });
		}
	});
});
