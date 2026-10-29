/**
 * INSTALL VALIDATION UP FRONT TRIPWIRE — every refusal an install's ANSWERS can
 * earn is raised by the PLAN, before anything is written, and the three front
 * ends refuse identically (terminal installer phase 1, 2026-10-11;
 * src/core/install/install_validation.ts).
 *
 * WHY. Until the validation moved into the plan, an invalid answer was found by
 * the step that first used it: a weak root password at set_root_pw — AFTER the
 * .env, the seed restore and the ontology import (a half-built install for an
 * input the plan could have refused); an entity `1x` only by the old browser
 * wizard's client-side check, the CLI accepting it; a port `x` only when the server
 * booted.
 *
 * WHAT IS MEASURED (outcomes, never source spellings):
 *  (a) ONE table of bad answers. Each row's refusal appears in the plan's
 *      `errors` IDENTICALLY through the three ways answers arrive — the CLI argv
 *      (the flag of each key DERIVED from INSTALL_CLI_FLAGS, never re-typed), an
 *      answers file (`answersFromAnswersFile`, the `--answers` envelope) and the
 *      answers record (the plan's own input shape) — and the base answers the table perturbs
 *      are themselves clean on all three (anti-vacuity). Since phase 4 the table
 *      holds the HOST-STEP answers too (server name, ports, TLS mode per route,
 *      certificate paths, web server, database mode, backup dir, the media root
 *      rule, the image source): a host step never meets an answer the plan let by.
 *  (b) The root password is a PLAN INPUT (an answers record and an answers file never
 *      carry it): every rule of THE policy (client password_policy.js
 *      PASSWORD_RULES, iterated — a new rule without a row is red) refuses
 *      through the plan; a fresh run REQUIRES one, `--plan` only checks a
 *      supplied one; and the plan's refusal agrees with the server's own
 *      (`passwordPolicyFailure`, the function set_root_pw refuses with) over a
 *      corpus — two callers of one rule, held to one verdict.
 *  (c) The REAL CLI, spawned for an install (not `--plan`) with a scratch
 *      private dir and a scratch server-state path: each refusal row exits 1
 *      with its sentence on stderr and leaves the scratch dir EMPTY — no .env, no
 *      `install/` (plan, state, lock, staging), no ts_state.json. The target
 *      database name is one that does not exist, so a regression that let a bad
 *      answer through would be refused LATER with a different sentence (the
 *      database preflight) — the sentence assertion is what reddens.
 *
 * DB-FREE by construction (the hermetic tier runs it): nothing here connects to
 * Postgres. The database half — a refused install leaves the TARGET database
 * at zero objects; a non-empty or missing database is refused before any write
 * — needs a server and is test/unit/install_resume_drill.test.ts's
 * (`preflight refusals` describe).
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PASSWORD_RULES } from '../../client/dedalo/core/component_password/js/password_policy.js';
import {
	ANSWERS_FILE_SCHEMA,
	answersFromAnswersFile,
	answersFromCliArgs,
	buildInstallPlan,
	INSTALL_CLI_FLAGS,
	SECRET_ANSWER_KEYS,
} from '../../src/core/install/install_plan.ts';
import { rootPasswordErrors } from '../../src/core/install/install_validation.ts';
import { passwordPolicyFailure } from '../../src/core/security/password_policy.ts';
import { PINNED_IDENTITY, pinInstallerIdentity } from '../helpers/installer_identity.ts';

// The installer's release identity is the checkout's: a dev checkout names no image,
// so these cases are written for a STABLE installer (test/helpers/installer_identity.ts).
pinInstallerIdentity(PINNED_IDENTITY.stable);

const ROOT = resolve(import.meta.dir, '../..');
const CLI = join(ROOT, 'scripts/install.ts');
const scratchRoot = mkdtempSync(join(tmpdir(), 'dedalo_install_upfront_'));
afterAll(() => rmSync(scratchRoot, { recursive: true, force: true }));

/** A database that never exists: a regression past the plan is refused LATER, differently. */
const ABSENT_DB = `dedalo_upfront_absent_${process.pid}`;
/** A password every policy rule accepts. */
const GOOD_ROOT_PASSWORD = 'Mosaic-Kestrel-Harbor-47';

/** Clean base answers, as a record (no secret: a trust connection). */
const BASE: Readonly<Record<string, unknown>> = Object.freeze({
	db_database: ABSENT_DB,
	db_username: 'upfront_user',
	db_hostname: 'localhost',
	db_port: '5432',
	entity: 'upfront',
	entity_label: 'Upfront Museum',
	timezone: 'Europe/Madrid',
	locale: 'es-ES',
	langs: ['lg-spa', 'lg-eng'],
	app_lang_default: 'lg-spa',
	data_lang_default: 'lg-eng',
	hierarchies: [],
});

const FLAG_OF: ReadonlyMap<string, { flag: string; kind: 'value' | 'bool' }> = new Map(
	INSTALL_CLI_FLAGS.filter((spec) => spec.key !== null).map((spec) => [
		spec.key as string,
		{ flag: spec.flag, kind: spec.kind },
	]),
);

/** The record-shape answers typed the CLI's way — each key's flag read from the flag table. */
function argvOf(answers: Readonly<Record<string, unknown>>): string[] {
	const argv: string[] = [];
	for (const [key, value] of Object.entries(answers)) {
		const spec = FLAG_OF.get(key);
		if (spec === undefined) throw new Error(`no CLI flag sets '${key}'`);
		if (spec.kind === 'bool') {
			// Only the positive bool flags are used by this table (--diffusion, --mailer).
			if (value === true) argv.push(spec.flag);
			continue;
		}
		argv.push(
			spec.flag,
			Array.isArray(value) ? (value.length === 0 ? 'none' : value.join(',')) : String(value),
		);
	}
	return argv;
}

/** The plan errors of `answers` through each front end. */
function errorsThreeWays(answers: Readonly<Record<string, unknown>>): {
	argv: readonly string[];
	file: readonly string[];
	record: readonly string[];
} {
	const invocation = answersFromCliArgs(argvOf(answers));
	expect(invocation.errors, 'the argv itself parses').toEqual([]);
	const file = answersFromAnswersFile({ schema: ANSWERS_FILE_SCHEMA, answers });
	expect(file.errors, 'the answers file itself parses').toEqual([]);
	return {
		argv: buildInstallPlan(invocation.raw).errors,
		file: buildInstallPlan(file.raw).errors,
		record: buildInstallPlan(answers).errors,
	};
}

interface BadRow {
	name: string;
	/** Overrides applied to BASE. */
	answers: Record<string, unknown>;
	/** The plan error the row must earn (exact). */
	error: string;
}

const MAILER = {
	mailer: true,
	smtp_host: 'smtp.example.org',
	smtp_port: '587',
	smtp_secure: 'tls',
};
const DIFFUSION = {
	diffusion: true,
	mysql_hostname: 'localhost',
	mysql_port: '3306',
	mysql_database: 'web_upfront',
	mysql_username: 'web_user',
};

/**
 * A clean production instance (the host steps' answers included — phase 4).
 * Its service user is BASE's database role: a created database's role IS the
 * service user (peer — owner decisions 2026-10-12).
 */
const PRODUCTION = {
	route: 'production',
	instance: 'prado',
	server_name: 'prado.example.org',
	letsencrypt_email: 'ops@example.org',
	service_user: 'upfront_user',
};

/** The shape sentence of an install folder that is not a normalized deep absolute path. */
const backupNotNormalized = (value: string): string =>
	`backup_dir '${value}' must be a normalized absolute path of at least two levels with plain segments (letters, digits, '.', '_', '-') — no trailing /, no empty, . or .. segments`;

const notNormalized = (value: string): string =>
	`install_dir '${value}' must be a normalized absolute path of at least two levels (e.g. /home/ded_prado or /home/my_domain.org/dedalo) — no trailing /, no . or .. segments`;

/** The refusal of a folder overlapping a place the installer keeps root-owned or serves. */
const overlaps = (key: string, value: string, place: string): string =>
	`${key} '${value}' overlaps ${place}, which the installer keeps root-owned or serves to the web — choose a folder outside it`;

/** The refusal of an account name. */
const badName = (kind: 'user' | 'group', value: string): string =>
	`service_${kind} '${value}' is not a valid Linux ${kind} name (a-z or _ first, then a-z, 0-9, _, -, . — 32 characters at most)`;
/** The institution's own certificate files (paths only: the plan checks their shape). */
const CERT_FILES = {
	tls_cert_path: '/etc/ssl/prado/fullchain.pem',
	tls_key_path: '/etc/ssl/prado/privkey.pem',
};

const BAD_ROWS: readonly BadRow[] = [
	{
		name: 'entity starting with a digit',
		answers: { entity: '1x' },
		error: "entity '1x' must start with a letter and contain only letters, digits and _",
	},
	{
		name: 'entity with a hyphen',
		answers: { entity: 'a-b' },
		error: "entity 'a-b' must start with a letter and contain only letters, digits and _",
	},
	{ name: 'entity empty', answers: { entity: '' }, error: 'entity is required' },
	{ name: 'db_port 0', answers: { db_port: '0' }, error: "db_port '0' must be an integer 1-65535" },
	{
		name: 'db_port 70000',
		answers: { db_port: '70000' },
		error: "db_port '70000' must be an integer 1-65535",
	},
	{ name: 'db_port x', answers: { db_port: 'x' }, error: "db_port 'x' must be an integer 1-65535" },
	{
		name: 'smtp_port out of range (mailer on)',
		answers: { ...MAILER, smtp_port: '99999' },
		error: "smtp_port '99999' must be an integer 1-65535",
	},
	{
		name: 'mysql_port not a number (diffusion on)',
		answers: { ...DIFFUSION, mysql_port: 'abc' },
		error: "mysql_port 'abc' must be an integer 1-65535",
	},
	{
		name: 'smtp_secure starttls',
		answers: { ...MAILER, smtp_secure: 'starttls' },
		error: 'smtp_secure must be tls|ssl|none',
	},
	{ name: 'mailer without host', answers: { mailer: true }, error: 'mailer requires smtp_host' },
	{
		name: 'media_access_mode typo',
		answers: { media_access_mode: 'privat' },
		error: 'media_access_mode must be private|publication|false (or empty)',
	},
	{
		name: 'timezone unknown',
		answers: { timezone: 'Mars/Base' },
		error: "timezone 'Mars/Base' is not a valid IANA time zone",
	},
	{
		name: 'locale with an underscore',
		answers: { locale: 'es_ES' },
		error: "locale 'es_ES' is not a valid BCP 47 tag",
	},
	{
		name: 'relative media_path',
		answers: { media_path: 'media/here' },
		error: 'media_path must be an absolute path',
	},
	{
		name: 'relative unix_socket',
		answers: { unix_socket: 'run/dedalo.sock' },
		error: 'unix_socket must be an absolute path',
	},
	{
		name: 'diffusion without mysql_username',
		answers: { ...DIFFUSION, mysql_username: '' },
		error: 'diffusion requires mysql_username',
	},
	{
		name: 'db_database shaped like an option',
		answers: { db_database: '-cfoo' },
		error: 'db_database: looks like a command-line option',
	},
	{
		name: 'db_username with a newline',
		answers: { db_username: 'user\nx' },
		error: 'db_username: contains an illegal control character',
	},
	{
		name: 'information with a newline',
		answers: { information: 'line one\nline two' },
		error: 'information contains an illegal control character',
	},
	{
		name: 'info_key with a NUL',
		answers: { info_key: 'k\0' },
		error: 'info_key contains an illegal control character',
	},
	// The ROUTE and the INSTANCE (terminal installer phase 2, 2026-10-12).
	{
		name: 'an unknown route',
		answers: { route: 'cloud' },
		error: 'route must be production|docker|trial|developer',
	},
	{
		name: 'production without an instance',
		answers: { route: 'production' },
		error: 'the production route requires instance (e.g. --instance prado)',
	},
	{
		name: 'an instance on the developer route (the default)',
		answers: { instance: 'prado' },
		error: 'instance is only meaningful on the production route (route is developer)',
	},
	{
		name: 'an instance on the docker route',
		answers: { route: 'docker', instance: 'prado' },
		error: 'instance is only meaningful on the production route (route is docker)',
	},
	{
		name: 'a malformed instance',
		answers: { route: 'production', instance: 'Prado-1' },
		error:
			"instance 'Prado-1' must start with a lowercase letter and contain only a-z, 0-9 and _ (28 characters at most)",
	},
	{
		name: 'an instance too long for the unix user ded_<instance>',
		answers: { route: 'production', instance: `p${'x'.repeat(28)}` },
		error: `instance 'p${'x'.repeat(28)}' must start with a lowercase letter and contain only a-z, 0-9 and _ (28 characters at most)`,
	},
	// THE HOST-STEP ANSWERS (terminal installer phase 4, 2026-10-12): every refusal a
	// production or docker host step could raise for an answer is the PLAN's.
	{
		name: 'production without a server name',
		answers: { ...PRODUCTION, server_name: '' },
		error:
			'the production route requires server_name (the public address, e.g. --server-name dedalo.example.org)',
	},
	{
		name: 'a server name that is an IP address',
		answers: { ...PRODUCTION, server_name: '192.0.2.10' },
		error:
			"server_name '192.0.2.10' must be a fully qualified domain name (not localhost, not an IP address)",
	},
	{
		name: 'a server name that is localhost',
		answers: { ...PRODUCTION, server_name: 'localhost' },
		error:
			"server_name 'localhost' must be a fully qualified domain name (not localhost, not an IP address)",
	},
	{
		name: "Let's Encrypt without an address for expiry notices",
		answers: { ...PRODUCTION, letsencrypt_email: '' },
		error: "Let's Encrypt requires letsencrypt_email (an address for expiry notices)",
	},
	{
		name: "Let's Encrypt with the challenge port moved off 80",
		answers: { ...PRODUCTION, http_port: '8080' },
		error: "Let's Encrypt validates over port 80: http_port must be 80 (or use tls_mode files)",
	},
	{
		name: 'the same port for HTTP and HTTPS',
		answers: { ...PRODUCTION, tls_mode: 'files', ...CERT_FILES, http_port: '443' },
		error: 'http_port and https_port must differ',
	},
	{
		name: 'an https port out of range',
		answers: { ...PRODUCTION, https_port: '0' },
		error: "https_port '0' must be an integer 1-65535",
	},
	// A local CA on production (owner decision 2026-10-16 — it was refused there before).
	{
		name: 'an unknown certificate mode on production',
		answers: { ...PRODUCTION, tls_mode: 'self_signed' },
		error: 'tls_mode must be letsencrypt|local_ca|files on the production route',
	},
	{
		name: "a local CA's extra address that is not an address",
		answers: { ...PRODUCTION, tls_mode: 'local_ca', tls_extra_names: 'dedalo.lan,no_such_name' },
		error:
			"tls_extra_names: 'no_such_name' must be a fully qualified domain name or an IPv4 address",
	},
	{
		name: "a local CA's extra address that is IPv6",
		answers: { ...PRODUCTION, tls_mode: 'local_ca', tls_extra_names: 'fd00::20' },
		error:
			'tls_extra_names: fd00::20 — IPv6 addresses are not supported for the local CA (use a name or an IPv4 address)',
	},
	{
		name: "a local CA's extra IPv4 address out of range",
		answers: { ...PRODUCTION, tls_mode: 'local_ca', tls_extra_names: '192.168.1.300' },
		error:
			"tls_extra_names: '192.168.1.300' must be a fully qualified domain name or an IPv4 address",
	},
	{
		name: "a local CA's extra address that is loopback",
		answers: { ...PRODUCTION, tls_mode: 'local_ca', tls_extra_names: '127.0.0.2' },
		error:
			'tls_extra_names: 127.0.0.2 is a loopback address (127.0.0.1 is in every certificate already)',
	},
	{
		// The authority excludes every name BELOW each listed name (exact names).
		name: "a local CA's extra address under the server name",
		answers: { ...PRODUCTION, tls_mode: 'local_ca', tls_extra_names: 'archivo.prado.example.org' },
		error:
			'archivo.prado.example.org lies under prado.example.org: the local CA certifies each name exactly, never the names below it — give staff names that are not inside one another',
	},
	{
		name: "a local CA's server name under an extra address",
		answers: { ...PRODUCTION, tls_mode: 'local_ca', tls_extra_names: 'example.org' },
		error:
			'prado.example.org lies under example.org: the local CA certifies each name exactly, never the names below it — give staff names that are not inside one another',
	},
	{
		name: "a local CA's server name under localhost",
		answers: { ...PRODUCTION, tls_mode: 'local_ca', server_name: 'dedalo.localhost' },
		error:
			'dedalo.localhost lies under localhost: the local CA certifies each name exactly, never the names below it — give staff names that are not inside one another',
	},
	{
		name: 'extra addresses with a certificate that cannot name them',
		answers: { ...PRODUCTION, tls_extra_names: '192.168.1.20' },
		error: 'tls_extra_names is only meaningful with tls_mode local_ca (tls_mode is letsencrypt)',
	},
	{
		name: "the institution's files without the key",
		answers: { ...PRODUCTION, tls_mode: 'files', tls_cert_path: CERT_FILES.tls_cert_path },
		error: 'tls_mode files requires tls_key_path (an absolute path)',
	},
	{
		name: "the institution's files at a relative path",
		answers: { ...PRODUCTION, tls_mode: 'files', ...CERT_FILES, tls_cert_path: 'certs/full.pem' },
		error: 'tls_mode files requires tls_cert_path (an absolute path)',
	},
	{
		name: 'an unknown web server',
		answers: { ...PRODUCTION, web_server: 'caddy' },
		error: 'web_server must be nginx|apache (or empty: the one the host has)',
	},
	{
		name: 'an unknown database mode',
		answers: { ...PRODUCTION, db_mode: 'adopt' },
		error: 'db_mode must be create|existing',
	},
	{
		name: 'a relative backup directory',
		answers: { ...PRODUCTION, backup_dir: 'backups' },
		error: 'backup_dir must be an absolute path',
	},
	// A non-normalized backup folder would slip past every component-wise overlap check.
	{
		name: 'a backup directory with a doubled leading /',
		answers: { ...PRODUCTION, backup_dir: '//home/ded_other/backups' },
		error: backupNotNormalized('//home/ded_other/backups'),
	},
	{
		name: 'a backup directory with a .. segment',
		answers: { ...PRODUCTION, backup_dir: '/home/ded_y/../ded_other/backups' },
		error: backupNotNormalized('/home/ded_y/../ded_other/backups'),
	},
	{
		name: 'a backup directory with an empty segment',
		answers: { ...PRODUCTION, backup_dir: '/srv//dedalo/x' },
		error: backupNotNormalized('/srv//dedalo/x'),
	},
	{
		name: 'a backup directory with a trailing /',
		answers: { ...PRODUCTION, backup_dir: '/srv/backups/prado/' },
		error: backupNotNormalized('/srv/backups/prado/'),
	},
	{
		name: 'a production MEDIA_PATH whose URL directory is not the engine media dir (the root rule)',
		answers: { ...PRODUCTION, media_path: '/data/prado/dedalo/files' },
		error:
			"media_path '/data/prado/dedalo/files' must end in /dedalo/media (the web root rule: root + /dedalo/<DEDALO_MEDIA_DIR> == MEDIA_PATH, and the installer keeps DEDALO_MEDIA_DIR=media)",
	},
	{
		name: 'a production MEDIA_PATH no web root can serve (the root rule)',
		answers: { ...PRODUCTION, media_path: '/srv/dedalo/prado/media' },
		error:
			"media_path '/srv/dedalo/prado/media' must end in /dedalo/media (the web root rule: root + /dedalo/<DEDALO_MEDIA_DIR> == MEDIA_PATH, and the installer keeps DEDALO_MEDIA_DIR=media)",
	},
	// ── the install folder and the service account (owner decisions 2026-10-12) ──
	{
		name: 'a relative install folder',
		answers: { ...PRODUCTION, install_dir: 'dedalo' },
		error: 'install_dir must be an absolute path',
	},
	{
		name: 'an install folder with a trailing /',
		answers: { ...PRODUCTION, install_dir: '/home/site/' },
		error: notNormalized('/home/site/'),
	},
	{
		name: 'an install folder one level deep',
		answers: { ...PRODUCTION, install_dir: '/dedalo' },
		error: notNormalized('/dedalo'),
	},
	{
		name: 'an install folder with a .. segment',
		answers: { ...PRODUCTION, install_dir: '/home/../etc/dedalo' },
		error: notNormalized('/home/../etc/dedalo'),
	},
	{
		name: 'an install folder with a space',
		answers: { ...PRODUCTION, install_dir: '/home/my site/dedalo' },
		error:
			"install_dir '/home/my site/dedalo' may contain only letters, digits, '.', '_' and '-' in each segment",
	},
	{
		name: 'an install folder in a system tree',
		answers: { ...PRODUCTION, install_dir: '/etc/dedalo' },
		error:
			"install_dir '/etc/dedalo' is a system location (/etc) — choose a folder of its own, e.g. /home/ded_prado",
	},
	{
		name: 'an install folder that IS a shared root',
		answers: { ...PRODUCTION, install_dir: '/var/www' },
		error:
			"install_dir '/var/www' is a system location (/var/www) — choose a folder of its own, e.g. /home/ded_prado",
	},
	{
		name: 'an install folder under /srv/dedalo (every instance’s web roots)',
		answers: { ...PRODUCTION, install_dir: '/srv/dedalo/x' },
		error: overlaps('install_dir', '/srv/dedalo/x', '/srv/dedalo'),
	},
	{
		name: 'an install folder under the root-owned runtime tree',
		answers: { ...PRODUCTION, install_dir: '/opt/dedalo/prado' },
		error: overlaps('install_dir', '/opt/dedalo/prado', '/opt/dedalo'),
	},
	{
		name: 'a backup folder under the install state root',
		answers: { ...PRODUCTION, backup_dir: '/var/lib/dedalo-install/prado' },
		error: overlaps('backup_dir', '/var/lib/dedalo-install/prado', '/var/lib/dedalo-install'),
	},
	{
		name: "an install folder containing MEDIA_PATH's web root",
		answers: {
			...PRODUCTION,
			media_path: '/data/web/prado/dedalo/media',
			install_dir: '/data/web',
		},
		error: overlaps('install_dir', '/data/web', '/data/web/prado'),
	},
	{
		name: 'a service user name Linux refuses',
		answers: { ...PRODUCTION, service_user: 'Bad.User', db_username: 'Bad.User' },
		error: badName('user', 'Bad.User'),
	},
	{
		name: 'a service user name of 33 characters',
		answers: { ...PRODUCTION, service_user: 'a'.repeat(33), db_username: 'a'.repeat(33) },
		error: badName('user', 'a'.repeat(33)),
	},
	{
		name: 'a service group name Linux refuses',
		answers: { ...PRODUCTION, service_group: '9grp' },
		error: badName('group', '9grp'),
	},
	{
		name: 'the service user root',
		answers: { ...PRODUCTION, service_user: 'root', db_username: 'root' },
		error: 'service_user root is refused — the service never runs as root',
	},
	{
		name: 'the service group root',
		answers: { ...PRODUCTION, service_group: 'root' },
		error: 'service_group root is refused — the service never runs as root',
	},
	{
		name: 'a created database whose role is not the service user (peer)',
		answers: { ...PRODUCTION, db_username: 'someone_else' },
		error:
			"with db_mode create the database role is the service user (PostgreSQL peer authentication maps the OS user to the role of the same name): db_username 'someone_else' must be 'upfront_user' — omit --db-user",
	},
	{
		name: 'an install folder off production',
		answers: { install_dir: '/home/x/dedalo' },
		error: 'install_dir is only meaningful on the production route (route is developer)',
	},
	{
		name: 'a service user off production',
		answers: { route: 'trial', service_user: 'x' },
		error: 'service_user is only meaningful on the production route (route is trial)',
	},
	{
		name: 'a service group off production',
		answers: {
			route: 'docker',
			server_name: 'd.example.org',
			letsencrypt_email: 'ops@example.org',
			service_group: 'x',
		},
		error: 'service_group is only meaningful on the production route (route is docker)',
	},
	{
		name: 'docker without a server name',
		answers: { route: 'docker', letsencrypt_email: 'ops@example.org' },
		error:
			'the docker route requires server_name (the public address, e.g. --server-name dedalo.example.org)',
	},
	{
		name: 'a certificate on the trial route',
		answers: { route: 'trial', tls_mode: 'letsencrypt' },
		error: 'tls_mode must be none on the trial route',
	},
	{
		name: 'an unknown image source',
		answers: { route: 'trial', image_source: 'mirror' },
		error: 'image_source must be official|custom|build',
	},
	{
		name: 'a custom image without its repository',
		answers: { route: 'trial', image_source: 'custom' },
		error: 'image_source custom requires image_repository',
	},
];

/** A row whose refusal comes from the language derivation (its sentence is that module's). */
const LANG_ROW = {
	name: 'application language outside the chosen languages',
	answers: { langs: ['lg-spa', 'lg-eng'], app_lang_default: 'lg-fra' },
	prefix: 'languages: ',
};

// ── (a) one table, three front ends ──────────────────────────────────────────

describe('install validation — every bad answer refused by the plan, identically on three front ends (a)', () => {
	test('the base answers are CLEAN through all three (the table perturbs a valid install)', () => {
		const clean = errorsThreeWays(BASE);
		expect(clean).toEqual({ argv: [], file: [], record: [] });
	});

	for (const row of BAD_ROWS) {
		test(`${row.name}: '${row.error}' on argv ≡ answers file ≡ record`, () => {
			const seen = errorsThreeWays({ ...BASE, ...row.answers });
			expect(seen.argv).toContain(row.error);
			expect(seen.file).toEqual(seen.argv);
			expect(seen.record).toEqual(seen.argv);
		});
	}

	// D7 (2026-10-12): the publication database has a plan default, so diffusion
	// without one is NOT refused (the old "diffusion requires mysql_database" rule
	// is gone) — the default is written instead, the instance's on production.
	test('diffusion without mysql_database is CLEAN on all three: the plan default is used', () => {
		const answers = { ...BASE, ...DIFFUSION, mysql_database: '' };
		expect(errorsThreeWays(answers)).toEqual({ argv: [], file: [], record: [] });
		expect(buildInstallPlan(answers).answers.mysql_database).toBe('web_dedalo');
		const production = buildInstallPlan({ ...answers, ...PRODUCTION });
		expect(production.errors).toEqual([]);
		expect(production.answers.mysql_database).toBe('web_prado');
	});

	test("a local CA's extra names AND IPv4 addresses are CLEAN on all three, on production and docker (owner 2026-10-16: whether an IP is this host's and no other instance's is the System check's — address_claims.ts)", () => {
		expect(
			errorsThreeWays({
				...BASE,
				...PRODUCTION,
				tls_mode: 'local_ca',
				tls_extra_names: 'dedalo.lan,archivo.museo.lan,192.168.1.20',
			}),
		).toEqual({ argv: [], file: [], record: [] });
		expect(
			errorsThreeWays({
				...BASE,
				route: 'docker',
				server_name: 'd.example.org',
				tls_mode: 'local_ca',
				tls_extra_names: 'dedalo.lan,192.168.1.20',
			}),
		).toEqual({ argv: [], file: [], record: [] });
	});

	test('a valid production instance is CLEAN on all three (the route rows are not vacuous)', () => {
		expect(errorsThreeWays({ ...BASE, ...PRODUCTION })).toEqual({
			argv: [],
			file: [],
			record: [],
		});
	});

	test('the level-2 defaults follow the level-1 answers; an explicit backup dir wins; the engine child keeps its role', () => {
		const hosting: Record<string, unknown> = {
			...BASE,
			...PRODUCTION,
			install_dir: '/home/drill.example.org/dedalo',
		};
		const { db_username: _role, ...withoutRole } = hosting;
		const derived = buildInstallPlan({ ...withoutRole, service_user: 'drill.example.org' });
		expect(derived.errors).toEqual([]);
		expect(derived.answers.backup_dir).toBe('/home/drill.example.org/dedalo/backups');
		expect(derived.answers.db_username).toBe('drill.example.org');
		const explicit = buildInstallPlan({ ...hosting, backup_dir: '/srv/backups/prado' });
		expect(explicit.errors).toEqual([]);
		expect(explicit.answers.backup_dir).toBe('/srv/backups/prado');
		// The engine child (no service_user — host-only) is handed the normalized role as is.
		const child = buildInstallPlan({
			...BASE,
			route: 'production',
			instance: 'prado',
			engine_only: true,
			db_username: 'drill.example.org',
		});
		expect(child.errors).toEqual([]);
		expect(child.answers.db_username).toBe('drill.example.org');
	});

	test(`${LANG_ROW.name}: a 'languages:' refusal on argv ≡ answers file ≡ record`, () => {
		const seen = errorsThreeWays({ ...BASE, ...LANG_ROW.answers });
		expect(seen.argv.some((error) => error.startsWith(LANG_ROW.prefix))).toBe(true);
		expect(seen.file).toEqual(seen.argv);
		expect(seen.record).toEqual(seen.argv);
	});
});

// ── (b) the root password, a plan input ──────────────────────────────────────

/** One password breaking each rule FIRST (the rule ids are the policy's own). */
const WEAK_BY_RULE: Readonly<Record<string, string>> = {
	length: 'Ab1-x',
	lower: 'KESTREL-HARBOR-47',
	upper: 'kestrel-harbor-47',
	digit: 'Kestrel-Harbor-Mosaic',
	banned_chars: 'Kestrel&Harbor-47',
	banned_words: 'Kestrel-Password-47',
	sequence: 'Kestrel-Harbor-6789',
};

describe('install validation — the root password is held to THE policy by the plan (b)', () => {
	test('every rule of the policy has a refusing row (a new rule without one is red)', () => {
		const ids = PASSWORD_RULES.map((rule) => rule.id);
		expect(ids.length).toBeGreaterThanOrEqual(5);
		expect(Object.keys(WEAK_BY_RULE).sort()).toEqual([...ids].sort());
	});

	for (const [rule, password] of Object.entries(WEAK_BY_RULE)) {
		test(`a password breaking '${rule}' is a plan error, run or --plan alike`, () => {
			const expected = `root password does not meet the password policy (${rule})`;
			for (const requireRootPassword of [true, false]) {
				const plan = buildInstallPlan(BASE, { rootPassword: password, requireRootPassword });
				expect(plan.errors).toContain(expected);
				expect(plan.rootPasswordErrors).toEqual([expected]);
			}
		});
	}

	test('a run REQUIRES one; --plan (not required) does not; a good one passes both', () => {
		const required =
			'root password is required (DEDALO_INSTALL_ROOT_PASSWORD, --secrets-stdin or --root-password)';
		expect(buildInstallPlan(BASE, { requireRootPassword: true }).errors).toContain(required);
		expect(buildInstallPlan(BASE, { requireRootPassword: false }).errors).toEqual([]);
		expect(
			buildInstallPlan(BASE, { rootPassword: GOOD_ROOT_PASSWORD, requireRootPassword: true })
				.errors,
		).toEqual([]);
	});

	test("the plan's verdict equals the server's own refusal (passwordPolicyFailure) over a corpus", () => {
		const corpus = [
			...Object.values(WEAK_BY_RULE),
			GOOD_ROOT_PASSWORD,
			'Ñandú-Çedilla-Ωmega-9',
			'Zz9-zz9-ZZ9-zz9',
			'x'.repeat(65),
			`Aa1-${'x'.repeat(60)}`,
			'Clave-Segura-27',
			'Abcd-Harbor-27',
		];
		let refused = 0;
		for (const password of corpus) {
			const failure = passwordPolicyFailure(password);
			const errors = rootPasswordErrors(password, true);
			if (failure === null) expect(errors, password).toEqual([]);
			else {
				refused += 1;
				expect(errors, password).toEqual([
					`root password does not meet the password policy (${failure})`,
				]);
			}
		}
		// Both verdicts are exercised (anti-vacuity).
		expect(refused).toBeGreaterThan(5);
		expect(refused).toBeLessThan(corpus.length);
	});
});

// ── (c) the real CLI writes nothing for a refused answer ─────────────────────

interface SpawnedRun {
	exitCode: number;
	stdout: string;
	stderr: string;
	privateDir: string;
}

/**
 * The real CLI, spawned for an INSTALL (not --plan): a fresh scratch private dir,
 * the server state and the session store inside it; the root password through
 * the environment (the supported channel) unless the row overrides it.
 */
function spawnInstall(
	argv: readonly string[],
	options: { rootPassword?: string | null; stdin?: string } = {},
): SpawnedRun {
	const privateDir = mkdtempSync(join(scratchRoot, 'private_'));
	const password = options.rootPassword === undefined ? GOOD_ROOT_PASSWORD : options.rootPassword;
	// An undefined value REMOVES the key (no inherited fault seam, no inherited password).
	const env = Object.fromEntries(
		Object.entries({
			...Bun.env,
			DEDALO_INSTALL_PRIVATE_DIR: privateDir,
			DEDALO_TS_STATE_PATH: join(privateDir, 'ts_state.json'),
			DEDALO_SESSION_DB_PATH: join(privateDir, 'sessions.sqlite'),
			DEDALO_INSTALL_ROOT_PASSWORD: password ?? undefined,
			DEDALO_INSTALL_FAULT: undefined,
		}).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
	const proc = Bun.spawnSync([process.execPath, 'run', CLI, ...argv], {
		cwd: ROOT,
		env,
		stdin: options.stdin === undefined ? 'ignore' : Buffer.from(options.stdin),
		stdout: 'pipe',
		stderr: 'pipe',
	});
	return {
		exitCode: proc.exitCode,
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
		privateDir,
	};
}

/** The run refused with `sentence` and left its private dir EMPTY. */
function expectRefusedClean(run: SpawnedRun, sentence: string): void {
	expect(run.exitCode, run.stdout + run.stderr).toBe(1);
	expect(run.stderr).toContain(sentence);
	// Nothing written: no .env, no install/ (plan, state, lock, staging), no ts_state.json.
	expectNothingWritten(run.privateDir);
}

/**
 * "Nothing was written" into the scratch private dir this test made: rmdir
 * succeeds ONLY on an empty directory — the proof without enumerating it.
 */
function expectNothingWritten(dir: string): void {
	let code: string | null = null;
	try {
		rmdirSync(dir);
	} catch (error) {
		code = (error as NodeJS.ErrnoException).code ?? 'unknown';
	}
	expect(code, `${dir} must be empty (nothing written)`).toBeNull();
}

/** An answers file (the `--answers` envelope) in the scratch root. */
function answersFile(answers: Record<string, unknown>): string {
	const path = join(mkdtempSync(join(scratchRoot, 'answers_')), 'answers.json');
	writeFileSync(path, JSON.stringify({ schema: ANSWERS_FILE_SCHEMA, answers }));
	return path;
}

describe('install validation — the spawned CLI refuses before writing anything (c)', () => {
	test('control: valid answers get PAST the plan (refused by the database preflight instead)', () => {
		// Anti-vacuity: what makes the rows below meaningful is that a clean plan
		// reaches the machine checks, which refuse with a DIFFERENT sentence.
		const run = spawnInstall(argvOf(BASE));
		expect(run.exitCode).toBe(1);
		// It reached the executor's machine checks (printed only after the plan passed).
		expect(run.stdout).toContain('→ pre-flight checks');
		expect(run.stderr).not.toContain('must start with a letter');
		expect(run.stderr).not.toContain('password policy');
		expectNothingWritten(run.privateDir);
	}, 60000);

	test('a weak root password', () => {
		expectRefusedClean(
			spawnInstall(argvOf(BASE), { rootPassword: WEAK_BY_RULE.sequence }),
			'root password does not meet the password policy (sequence)',
		);
	}, 60000);

	test('no root password at all', () => {
		expectRefusedClean(
			spawnInstall(argvOf(BASE), { rootPassword: null }),
			'root password is required',
		);
	}, 60000);

	for (const row of BAD_ROWS.filter((candidate) =>
		[
			'entity starting with a digit',
			'db_port 70000',
			'information with a newline',
			'db_database shaped like an option',
			'timezone unknown',
		].includes(candidate.name),
	)) {
		test(row.name, () => {
			const run = spawnInstall(argvOf({ ...BASE, ...row.answers }));
			expectRefusedClean(run, row.error);
			expect(run.stdout).not.toContain('→ pre-flight checks');
		}, 60000);
	}

	test('a language default outside the chosen languages', () => {
		expectRefusedClean(spawnInstall(argvOf({ ...BASE, ...LANG_ROW.answers })), LANG_ROW.prefix);
	}, 60000);

	test('the same refusal through --answers <file>', () => {
		const file = answersFile({ ...BASE, entity: '1x' });
		expectRefusedClean(
			spawnInstall(['--answers', file]),
			"entity '1x' must start with a letter and contain only letters, digits and _",
		);
	}, 60000);

	test('an answers file carrying a SECRET is refused (each secret key), nothing written', () => {
		expect(SECRET_ANSWER_KEYS.length).toBeGreaterThanOrEqual(3);
		for (const key of SECRET_ANSWER_KEYS) {
			const run = spawnInstall([
				'--answers',
				answersFile({ ...BASE, [key]: 'SENTINEL-in-file-91' }),
			]);
			expectRefusedClean(run, `answers file: '${key}' is a secret and is not accepted in a file`);
			expect(run.stdout + run.stderr).not.toContain('SENTINEL-in-file-91');
		}
	}, 120000);

	test('a key set by both the answers file and a flag is refused (no silent precedence)', () => {
		const file = answersFile({ ...BASE });
		expectRefusedClean(
			spawnInstall(['--answers', file, '--entity', 'other']),
			'entity is set by both --answers and --entity',
		);
	}, 60000);

	test('--secrets-stdin with an unknown key is refused, nothing written', () => {
		expectRefusedClean(
			spawnInstall([...argvOf(BASE), '--secrets-stdin'], {
				stdin: JSON.stringify({ root_password: GOOD_ROOT_PASSWORD, api_token: 'x' }),
			}),
			"--secrets-stdin: unknown key 'api_token'",
		);
	}, 60000);
});
