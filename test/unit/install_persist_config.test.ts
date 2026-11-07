/**
 * P2 gate — persist_config + check_directories (DEC-19).
 *
 * DEDALO_INSTALL_PRIVATE_DIR redirects the installer's writes to a scratch dir
 * so the live ../private/.env is never touched. Asserts: the .env carries the
 * catalog's canonical key names (never a PHP_KEY_ALIASES spelling), is chmod 600, backs up an existing file on overwrite, `generated`
 * carries only NEW secrets, and the state flips to 'terminal_installing'.
 *
 * `terminal_installing` is the ONLY status persistConfig writes (2026-10-12, the
 * browser wizard and its `configured` status removed —
 * WC-2026-10-12-install-surface-removed): a server started over it REFUSES to boot
 * (src/config/install_state.ts) until the installer seals the install — a crashed
 * run is resumed from the terminal, never finished by whoever reaches the port, and
 * no boot work runs over a half-built database. And a rewrite keeps the prior file
 * byte for byte in a fresh `.env.bak.*` (copied, then the new file is renamed over
 * it) and leaves no staged tmp behind.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PHP_KEY_ALIASES, parseEnvFile, seedProcessEnv } from '../../src/config/env.ts';
import { isDedaloError } from '../../src/core/errors/index.ts';
import { persistConfig } from '../../src/core/install/config_persist.ts';
import { checkDirectories } from '../../src/core/install/directories.ts';
import {
	buildInstallPlan,
	normalizeInstallAnswers,
	OFFICIAL_CODE_SERVER,
	OFFICIAL_ONTOLOGY_SERVER,
} from '../../src/core/install/install_plan.ts';
import {
	FALLBACK_LOCALE,
	FALLBACK_TIMEZONE,
	hostLocaleDefaults,
	localeFromPosix,
} from '../../src/core/install/install_validation.ts';
import {
	closeOntologyChoice,
	collectHierarchyDependencies,
	declarersOf,
	hierarchyDependencyPlan,
	vendoredCoreDeclarers,
	vendoredOntologyCatalog,
} from '../../src/core/install/ontology_choice.ts';
import { directoriesNeedingAttention } from '../../src/core/install/steps.ts';
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

		// State moved to 'terminal_installing' with the fingerprints.
		const state = getServerState();
		expect(state.install_status).toBe('terminal_installing');
		expect(state.information).toBe('fingerprint');
		expect(state.info_key).toBe('k123');
	});

	test("persistConfig writes ONLY 'terminal_installing' — over a sealed state too (a re-run reopens it)", async () => {
		setServerState({ install_status: 'sealed' });
		await persistConfig({ ...BASE_CFG });
		expect(getServerState().install_status).toBe('terminal_installing');
	});

	test('a rewrite backs up the prior .env byte for byte and leaves no staged tmp', async () => {
		const envPath = join(scratch, '.env');
		writeFileSync(envPath, 'DEDALO_SALT_STRING=feedface\nKEEP_ME=1\n');
		const prior = readFileSync(envPath, 'utf8');
		const { readdirSync } = await import('node:fs');
		const backupsBefore = readdirSync(scratch).filter((name) => name.startsWith('.env.bak.'));
		await persistConfig({ ...BASE_CFG });
		const fresh = readdirSync(scratch).filter(
			(name) => name.startsWith('.env.bak.') && !backupsBefore.includes(name),
		);
		expect(fresh.length).toBe(1);
		expect(readFileSync(join(scratch, fresh[0] as string), 'utf8')).toBe(prior);
		expect(parseEnvFile(readFileSync(envPath, 'utf8')).KEEP_ME).toBe('1');
		// No staged tmp is left behind.
		expect(readdirSync(scratch).filter((name) => name.startsWith('.env.tmp'))).toEqual([]);
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
	 * The 2026-07-12 data loss, mechanically. A re-run of the installer (then: a
	 * browser-wizard page reload walking the config steps again from an EMPTY cfg)
	 * rebuilds .env from the answers — so on the second save every key the answers
	 * did not carry was DELETED. It ate all 8 DEDALO_DIFFUSION_* keys twice, taking
	 * the generated DEDALO_DIFFUSION_INTERNAL_TOKEN (shown once, then unrecoverable)
	 * with them, plus operator-appended keys, which is what ../private/.env is FOR
	 * (append-only, documented keys).
	 *
	 * Omission is not consent: a key the answers do not manage must survive verbatim.
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

		// Re-run with FRESH answers: no diffusion fields, no operator keys.
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
			// The thesauri the plan pre-ticks: what the release DECLARES — the core
			// TLDs' (every plan) then oh's — the vendored (installable) ones, derived
			// through the production functions, never a hand-typed list.
			const { dependencies } = collectHierarchyDependencies([
				...vendoredCoreDeclarers(),
				...declarersOf(['oh'], vendoredOntologyCatalog()),
			]);
			const installable = hierarchyDependencyPlan(dependencies).install;
			expect(installable.length, 'the release declares thesauri').toBeGreaterThan(0);
			expect(result.hierarchy_dependencies).toEqual(
				dependencies.filter((item) => installable.includes(item.tld)),
			);
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

// ── install campaign 3 (developer route, package P4) ─────────────────────────

describe('campaign 3: what a fresh install writes', () => {
	test('C3-60: the written .env carries no PHP-era wording', async () => {
		await persistConfig({ ...BASE_CFG });
		const body = readFileSync(join(scratch, '.env'), 'utf8');
		expect(body).toContain('DEDALO_SALT_STRING=');
		expect(body).not.toMatch(/PHP|coexistence/i);
	});

	test('C3-44: a production --engine-only plan writes DEDALO_MEDIA_ACCESS_MODE=publication, as the host route does', () => {
		const raw = { route: 'production', instance: 'museo', entity: 'museo', root_password: 'x' };
		for (const engineOnly of [true, false]) {
			const plan = buildInstallPlan({ ...raw, engine_only: engineOnly }, { salt: 's' });
			const entries = plan.env.flatMap((section) => section.entries);
			expect(entries.find((item) => item.key === 'DEDALO_MEDIA_ACCESS_MODE')?.value).toBe(
				'publication',
			);
		}
		// An explicit choice still wins; the developer route still writes nothing.
		const chosen = normalizeInstallAnswers({ ...raw, media_access_mode: 'private' }).answers;
		expect(chosen.media_access_mode).toBe('private');
		expect(normalizeInstallAnswers({ route: 'developer' }).answers.media_access_mode).toBe('');
	});

	describe("C3-21: the identity defaults are the host's", () => {
		test('TZ=Etc/UTC, LANG=en_US.UTF-8 → Etc/UTC / en-US (never Europe/Madrid / es-ES)', () => {
			expect(hostLocaleDefaults({ TZ: 'Etc/UTC', LANG: 'en_US.UTF-8' }, 'Europe/Madrid')).toEqual({
				timezone: 'Etc/UTC',
				locale: 'en-US',
			});
		});

		test('LC_ALL wins over LANG; C/POSIX/unset fall back to en-US; a bad zone to UTC', () => {
			expect(hostLocaleDefaults({ LC_ALL: 'de_DE@euro', LANG: 'en_US.UTF-8' }, 'UTC').locale).toBe(
				'de-DE',
			);
			expect(hostLocaleDefaults({ LC_ALL: 'C', LANG: 'fr_FR.UTF-8' }, 'UTC').locale).toBe(
				FALLBACK_LOCALE,
			);
			expect(hostLocaleDefaults({}, 'Not/AZone').timezone).toBe(FALLBACK_TIMEZONE);
			expect(hostLocaleDefaults({ TZ: ':America/Lima' }, 'UTC').timezone).toBe('America/Lima');
			expect(localeFromPosix('POSIX')).toBeNull();
			expect(localeFromPosix('pt_BR.utf8')).toBe('pt-BR');
		});

		test("the plan defaults to THIS process's host values, and a given answer wins", () => {
			const host = hostLocaleDefaults();
			const plain = normalizeInstallAnswers({ route: 'developer' }).answers;
			expect({ timezone: plain.timezone, locale: plain.locale }).toEqual(host);
			const given = normalizeInstallAnswers({
				route: 'developer',
				timezone: 'Asia/Tokyo',
				locale: 'ja-JP',
			}).answers;
			expect({ timezone: given.timezone, locale: given.locale }).toEqual({
				timezone: 'Asia/Tokyo',
				locale: 'ja-JP',
			});
		});

		test('a run under TZ=Etc/UTC LANG=en_US.UTF-8 normalizes to Etc/UTC / en-US', () => {
			const run = Bun.spawnSync(
				[
					process.execPath,
					'-e',
					"const { normalizeInstallAnswers } = await import('./src/core/install/install_plan.ts'); const a = normalizeInstallAnswers({ route: 'developer' }).answers; console.log(a.timezone + ' ' + a.locale);",
				],
				{
					cwd: join(import.meta.dir, '../..'),
					env: { PATH: process.env.PATH ?? '', TZ: 'Etc/UTC', LANG: 'en_US.UTF-8', LC_ALL: '' },
				},
			);
			expect(new TextDecoder().decode(run.stdout).trim().split('\n').at(-1)).toBe('Etc/UTC en-US');
		});
	});
});

// ── campaign 3b N4 / C3-55: the engine checks the backup dir the .env records ──

/**
 * THE DIRECTORY THE ENGINE CHECKS IS THE DIRECTORY THE .env RECORDS
 * (campaign 3b N4 / C3-55; src/core/install/install_plan.ts cliBootEnv +
 * backupDbDir, src/core/install/directories.ts, steps.ts check_directories).
 *
 * config.ts freezes at import, so a FRESH `--engine-only --backup-dir X` run
 * (manual_install.md host_engine) used to boot with no DEDALO_BACKUP_DIR: its
 * check_directories checked and CREATED `<private>/backups/db`, while
 * persist_config wrote `DEDALO_BACKUP_DIR=X/db` — and the `--resume`, booted
 * from that .env, found `X/db` missing and stopped ("recorded done but its
 * outcome is missing … something changed it outside the installer").
 *
 * OUTCOME, in a child booted exactly as scripts/install.ts boots
 * (seedProcessEnv(cliBootEnv(plan)) before the first config import), against a
 * scratch private dir and a MARKED scratch media root: the create pass makes
 * `X/db` — the .env's DEDALO_BACKUP_DIR byte for byte — and leaves no
 * `<private>/backups/db`; the preflight's recorded paths (installDirectoryPaths,
 * what --abort removes) name the same. The production defaults derive the
 * backup dir even without the flag, so the defaulted case is gated too. Plus
 * the verify's sentence names the directory instead of a generic line.
 */

const REPO = resolve(import.meta.dir, '../..');
const dirsScratch = mkdtempSync(join(tmpdir(), 'dedalo_engine_only_dirs_'));
afterAll(() => rmSync(dirsScratch, { recursive: true, force: true }));

/** The child: boot as scripts/install.ts does, then the create pass; prints {paths, dirs}. */
const CHILD = `
const R = ${JSON.stringify(REPO)};
const answers = JSON.parse(process.env.ZZ_ANSWERS);
const { buildInstallPlan, cliBootEnv } = await import(R + '/src/core/install/install_plan.ts');
const { seedProcessEnv } = await import(R + '/src/config/env.ts');
seedProcessEnv(cliBootEnv(buildInstallPlan(answers, { salt: 's' })));
const d = await import(R + '/src/core/install/directories.ts');
const report = d.checkDirectories({ create: true, mediaRoot: answers.media_path });
console.log(JSON.stringify({ paths: d.installDirectoryPaths(), dirs: report.dirs }));
`;

interface ChildReport {
	paths: string[];
	dirs: { label: string; path: string; exists: boolean; writable: boolean }[];
}

function runChild(answers: Record<string, unknown>, privateDir: string): ChildReport {
	const env = Object.fromEntries(
		Object.entries(Bun.env).filter(
			([key, value]) =>
				value !== undefined &&
				!['DEDALO_BACKUP_DIR', 'MEDIA_PATH', 'ENTITY'].includes(key) &&
				!key.startsWith('DEDALO_INSTALL_'),
		),
	) as Record<string, string>;
	const proc = Bun.spawnSync([process.execPath, '-e', CHILD], {
		cwd: REPO,
		env: { ...env, DEDALO_INSTALL_PRIVATE_DIR: privateDir, ZZ_ANSWERS: JSON.stringify(answers) },
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const out = proc.stdout.toString().trim().split('\n').pop() ?? '';
	expect(proc.exitCode, proc.stderr.toString()).toBe(0);
	return JSON.parse(out) as ChildReport;
}

/** The .env's DEDALO_BACKUP_DIR as the plan writes it. */
function envBackupDir(answers: Record<string, unknown>): string {
	const plan = buildInstallPlan(answers, { salt: 's' });
	const entry = plan.env
		.flatMap((section) => section.entries)
		.find((e) => e.key === 'DEDALO_BACKUP_DIR');
	return entry?.value ?? '';
}

function engineOnly(
	name: string,
	extra: Record<string, unknown>,
): {
	answers: Record<string, unknown>;
	privateDir: string;
} {
	const base = join(dirsScratch, name);
	return {
		privateDir: join(base, 'private'),
		answers: {
			route: 'production',
			instance: 'zzbackup',
			entity: 'zzbackup',
			engine_only: true,
			media_path: markMediaRoot(join(base, 'media')),
			...extra,
		},
	};
}

describe('--engine-only: the backup dir the engine checks is the one the .env records (N4)', () => {
	test('--backup-dir X: the create pass makes X/db, never <private>/backups/db', () => {
		const backup = join(dirsScratch, 'given', 'backups');
		const { answers, privateDir } = engineOnly('given', { backup_dir: backup });
		const recorded = envBackupDir(answers);
		expect(recorded).toBe(join(backup, 'db'));
		const report = runChild(answers, privateDir);
		const row = report.dirs.find((dir) => dir.label === 'Backups');
		expect(row).toEqual({ label: 'Backups', path: recorded, exists: true, writable: true });
		expect(existsSync(recorded)).toBe(true);
		expect(existsSync(join(privateDir, 'backups', 'db'))).toBe(false);
		// what the preflight records as missing (and --abort removes) is the same dir
		expect(report.paths).toContain(recorded);
		expect(report.paths).not.toContain(join(privateDir, 'backups', 'db'));
	});

	test('the production default backup dir (no flag) is the one checked too', () => {
		const dir = join(dirsScratch, 'defaulted', 'home');
		const { answers, privateDir } = engineOnly('defaulted', { install_dir: dir });
		const recorded = envBackupDir(answers);
		expect(recorded).toBe(join(dir, 'backups', 'db'));
		const report = runChild(answers, privateDir);
		expect(report.dirs.find((row) => row.label === 'Backups')?.path).toBe(recorded);
		expect(existsSync(join(privateDir, 'backups', 'db'))).toBe(false);
	});

	test("check_directories' verify names the directory that needs attention", () => {
		expect(
			directoriesNeedingAttention([
				{ label: 'Private config', path: '/p', exists: true, writable: true },
				{ label: 'Backups', path: '/b/db', exists: false, writable: false },
				{ label: 'Media', path: '/m', exists: true, writable: false },
			]),
		).toBe('Backups /b/db (missing), Media /m (not writable)');
	});
});

/**
 * B14 AT THE DOOR (2026-11-07). persistConfig writes `.env` into installPrivateDir() and the
 * install status into statePath(). A script that redirected ONLY the first (a review probe
 * run with plain `bun`, outside the test preload that sets DEDALO_TS_STATE_PATH) marked the
 * LIVE installation `terminal_installing` and its server refused to boot. Driven in a CHILD
 * whose engine private dir is a scratch dir too, so a regression writes there, never live.
 */
describe('persist_config refuses a state file outside its private dir (B14)', () => {
	const root = mkdtempSync(join(tmpdir(), 'dedalo_install_b14_'));
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	/** The install_status a private dir's state file records (undefined: none, or no file). */
	function installStatusIn(dir: string): string | undefined {
		const path = join(dir, 'ts_state.json');
		if (!existsSync(path)) return undefined;
		return (JSON.parse(readFileSync(path, 'utf8')) as { install_status?: string }).install_status;
	}

	/** Run persistConfig in a child with the two private dirs given and NO state-path override. */
	function persistInChild(
		enginePrivate: string,
		installPrivate: string,
	): { refused: string | null } {
		// A MINIMAL environment: what an operator's shell gives a fresh box, never this test
		// process's suite keys (DB_NAME and friends would make config demand the rest).
		const env: Record<string, string> = {
			PATH: process.env.PATH ?? '',
			HOME: process.env.HOME ?? '',
			TMPDIR: process.env.TMPDIR ?? tmpdir(),
			DEDALO_PRIVATE_DIR: enginePrivate,
			DEDALO_INSTALL_PRIVATE_DIR: installPrivate,
		};
		const script = `
			const { persistConfig } = await import(${JSON.stringify(resolve('src/core/install/config_persist.ts'))});
			try { await persistConfig(${JSON.stringify(BASE_CFG)}); console.log(JSON.stringify({ refused: null })); }
			catch (error) { console.log(JSON.stringify({ refused: String(error?.message ?? error) })); }`;
		const child = Bun.spawnSync(['bun', '-e', script], { env, cwd: resolve('.') });
		const out = child.stdout.toString().trim().split('\n').at(-1) ?? '';
		expect({
			exit: child.exitCode,
			stderr: child.exitCode === 0 ? '' : child.stderr.toString(),
		}).toEqual({
			exit: 0,
			stderr: '',
		});
		return JSON.parse(out) as { refused: string | null };
	}

	test('install dir redirected alone → refused, and NOTHING is written in either dir', () => {
		const engine = mkdtempSync(join(root, 'engine_'));
		const install = mkdtempSync(join(root, 'install_'));
		const { refused } = persistInChild(engine, install);
		expect(refused).toContain('is not in the install');
		// Importing the engine may record its path census there (legacy_dir_fallback); the
		// install status is what must NOT appear.
		expect(installStatusIn(engine)).toBeUndefined();
		expect(existsSync(join(install, '.env'))).toBe(false);
	});

	test('control: one private dir for both → .env and the terminal_installing state land there', () => {
		const both = mkdtempSync(join(root, 'both_'));
		const { refused } = persistInChild(both, both);
		expect(refused).toBeNull();
		expect(existsSync(join(both, '.env'))).toBe(true);
		expect(installStatusIn(both)).toBe('terminal_installing');
	});
});
