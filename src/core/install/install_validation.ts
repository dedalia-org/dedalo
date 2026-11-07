/**
 * PLAN-TIME VALIDATION — every refusal an install's ANSWERS can earn, raised by
 * the plan BEFORE anything is written (terminal installer, phase 1, 2026-10-11).
 *
 * WHY. Until this module an invalid answer was found by the step that first
 * used it: a weak root password at set_root_pw — AFTER the .env, the seed
 * restore and the ontology import; an entity `1x` only by the (since retired)
 * browser wizard's client-side check (the CLI accepted it); a port `x` by the server boot. A
 * failure that late leaves a half-built install for an input the plan could
 * have refused. So every rule that needs nothing but the answers lives HERE and
 * runs inside buildInstallPlan (install_plan.ts) — the CLI argv, an answers file
 * (`--answers`) and the screens all reach the SAME checks through
 * normalizeInstallAnswers, and refuse with the SAME sentence.
 *
 * What stays OUTSIDE: anything that needs the machine (is the database empty,
 * does it exist — db_restore.ts inspectTargetDatabase, run by the executor
 * before any write) and the step doors' own refusals, which stay as defence in
 * depth (root_pw.ts still refuses a weak password; pg_exec.ts still refuses an
 * option-shaped connection field).
 *
 * PURE AND CONFIG-FREE: imports only src/config/pg_transport.ts and the client
 * password policy module (the bytes the browser checklist and the server
 * refusal both run — core/security/password_policy.ts wraps the same function
 * but pulls in the error registry, so it is not imported here) — plus the
 * installer's release identity (installer_identity.ts: a process constant read
 * once from this tree's build stamp), which decides the image answers — and
 * the engine's own public-reach rule (src/core/resolve/public_reach_rule.ts,
 * over the guard's CONFIG-FREE half, security/address_verdict.ts — never
 * ssrf_guard.ts itself, whose config readers would freeze the run at import:
 * no_install_surface_tripwire (c)), so the public address the installer
 * accepts is the one the engine will use.
 *
 * TAGGED (phase 2, 2026-10-12): every refusal is a {@link FieldError} — the
 * sentence AND the answer key it is about. The plan's `errors` carry the
 * sentences unchanged; its `fieldErrors` carry the tags, which the terminal
 * screen model (screen_model.ts) uses to show each sentence on its question.
 * Gates: test/unit/install_validation_upfront_tripwire.test.ts,
 * test/unit/install_screen_model_tripwire.test.ts.
 */

import { isIP } from 'node:net';
import { dirname, isAbsolute } from 'node:path';
import { check_password } from '../../../client/dedalo/core/component_password/js/password_policy.js';
import { PATHS_KEYS } from '../../config/catalog/paths.ts';
import { liveProcessEnv } from '../../config/env.ts';
import { connFieldProblem, pgSocketProblem } from '../../config/pg_transport.ts';
import { unixSocketLengthProblem } from '../../config/unix_socket.ts';
import { identifiableOrigin, isBareOrigin } from '../resolve/public_reach_rule.ts';
import { DEV_TLS_MODES, type DevListenerPlan } from './dev_listener.ts';
import { ENTITY_PATTERN } from './entity_name.ts';
import {
	acceptedImageVersions,
	devHasNoImageMessage,
	imageRefusalMessage,
} from './host/stack/layout.ts';
import type { InstallAnswers } from './install_plan.ts';
import { imageSourceRefusedFor, installerIdentity } from './installer_identity.ts';

/**
 * The INSTANCE name of a production install (multi-instance hosts —
 * docs/install/multi_instance.md): it must be valid inside the DEFAULT service
 * user name (`ded_` + the name: 32 characters at most, so 28 here), a systemd
 * instance (`dedalo-ts@<i>`), a path segment and a PostgreSQL identifier
 * (`dedalo_<i>`) — hence lowercase.
 */
export const INSTANCE_PATTERN = /^[a-z][a-z0-9_]{0,27}$/;

/**
 * The media access modes DEDALO_MEDIA_ACCESS_MODE reads ('' = not written).
 * `off` and `0` are accepted aliases of `false`; a front end OFFERS only
 * {@link MEDIA_ACCESS_MODE_OPTIONS}.
 */
export const MEDIA_ACCESS_MODES: readonly string[] = Object.freeze([
	'',
	'private',
	'publication',
	'false',
	'off',
	'0',
]);

/** The canonical media access modes a front end offers ('' = the engine default). */
export const MEDIA_ACCESS_MODE_OPTIONS: readonly string[] = Object.freeze([
	'',
	'private',
	'publication',
	'false',
]);

/** SMTP encryption: STARTTLS, implicit TLS, plain (core/mailer/mailer.ts maps the same three). */
export const SMTP_SECURE_MODES: readonly string[] = Object.freeze(['tls', 'ssl', 'none']);

/** One answer refusal, TAGGED with the answer key it is about (a front end shows it there). */
export interface FieldError {
	readonly key: string;
	readonly message: string;
}

type Problems = FieldError[];

const problem = (key: string, message: string): FieldError => ({ key, message });

/** The required answers: empty → "<key> is required". */
function requiredErrors(a: InstallAnswers, problems: Problems): void {
	const keys = peerRole(a)
		? (['db_database', 'entity'] as const)
		: (['db_database', 'db_username', 'entity'] as const);
	for (const key of keys) {
		if (a[key] === '') problems.push(problem(key, `${key} is required`));
	}
	// An empty host would persist a DISABLED mailer — refuse the contradiction.
	if (a.mailer && a.smtp_host === '')
		problems.push(problem('smtp_host', 'mailer requires smtp_host'));
	diffusionRequiredErrors(a, problems);
}

/**
 * Diffusion writes as a named MariaDB user. (Its database has a plan default —
 * `web_dedalo`, `web_<instance>` on production — so it is never missing.)
 */
function diffusionRequiredErrors(a: InstallAnswers, problems: Problems): void {
	if (!a.diffusion) return;
	if (a.mysql_username === '') {
		problems.push(problem('mysql_username', 'diffusion requires mysql_username'));
	}
}

/** A TCP port: digits only, 1-65535. */
function portError(name: string, value: string): string | null {
	const port = Number(value);
	return /^\d+$/.test(value) && port >= 1 && port <= 65535
		? null
		: `${name} '${value}' must be an integer 1-65535`;
}

/** The ports that will be written: the database's, and the services' that are on. */
function portErrors(a: InstallAnswers, problems: Problems): void {
	const ports: [string, string][] = [['db_port', a.db_port]];
	if (a.diffusion) ports.push(['mysql_port', a.mysql_port]);
	if (a.mailer) ports.push(['smtp_port', a.smtp_port]);
	for (const [name, value] of ports) {
		const message = portError(name, value);
		if (message !== null) problems.push(problem(name, message));
	}
}

/**
 * The connection fields a pg/mysql client spawn will carry: no option shape, no
 * control character (pg_transport.ts connFieldProblem — the rule pg_exec.ts
 * enforces again at the spawn).
 */
function connectionErrors(a: InstallAnswers, problems: Problems): void {
	const fields: [string, string][] = [
		['db_hostname', a.db_hostname],
		['db_database', a.db_database],
		['db_username', a.db_username],
		['mysql_hostname', a.mysql_hostname],
		['mysql_database', a.mysql_database],
		['mysql_username', a.mysql_username],
	];
	for (const [name, value] of fields) {
		const message = connFieldProblem(name, value);
		if (message !== null) problems.push(problem(name, message));
	}
	// A relative socket would refuse the boot (config.ts) — refuse it here first.
	const socketProblem = pgSocketProblem(a.db_socket);
	if (socketProblem !== null) problems.push(problem('db_socket', `db_socket: ${socketProblem}`));
}

/** Paths the server resolves from any cwd must be absolute ('' = not given). */
function pathErrors(a: InstallAnswers, problems: Problems): void {
	const paths: [string, string][] = [
		['media_path', a.media_path],
		['unix_socket', a.unix_socket],
	];
	if (a.diffusion) paths.push(['mysql_socket', a.mysql_socket]);
	for (const [name, value] of paths) {
		if (value !== '' && !isAbsolute(value)) {
			problems.push(problem(name, `${name} must be an absolute path`));
		}
	}
	socketLengthErrors(a.unix_socket, problems);
}

/** The OS binds no longer socket path: the server would fail at its first boot. */
function socketLengthErrors(unixSocket: string, problems: Problems): void {
	const socketLength = unixSocket === '' ? null : unixSocketLengthProblem(unixSocket);
	if (socketLength !== null) problems.push(problem('unix_socket', `unix_socket ${socketLength}`));
}

/** Does `timeZone` name an IANA zone this runtime knows? */
export function validTimeZone(timeZone: string): boolean {
	try {
		new Intl.DateTimeFormat('en', { timeZone });
		return true;
	} catch {
		return false;
	}
}

/** Is `locale` a well-formed BCP 47 tag? */
export function validLocale(locale: string): boolean {
	try {
		Intl.getCanonicalLocales(locale);
		return true;
	} catch {
		return false;
	}
}

// ── the host's own time zone and locale (install campaign 3, C3-21) ──────────
//
// The identity defaults were Europe/Madrid / es-ES on every machine — a UTC
// server with LANG=en_US.UTF-8 was offered a Spanish locale it never asked for,
// and a headless or unvisited Identity screen took it silently. The defaults are
// now THIS machine's, read when the answers are normalized; unusable values fall
// back to UTC / en-US, never to one institution's settings.

/** Used when the host offers no valid time zone. */
export const FALLBACK_TIMEZONE = 'UTC';
/** Used when the host offers no usable locale (unset, `C`, `POSIX`). */
export const FALLBACK_LOCALE = 'en-US';

/** POSIX names that carry no language (`C`, `POSIX`, nothing). */
const NO_LANGUAGE: ReadonlySet<string> = new Set(['', 'C', 'POSIX']);

/** The language part of a POSIX locale name: `en_US.UTF-8` / `de_DE@euro` → `en_US` / `de_DE`. */
function posixBase(value: string | undefined): string {
	return (value ?? '').split(/[.@]/)[0]?.trim() ?? '';
}

/** A POSIX locale name (`en_US.UTF-8`, `de_DE@euro`) as a BCP 47 tag, or null. */
export function localeFromPosix(value: string | undefined): string | null {
	const base = posixBase(value);
	if (NO_LANGUAGE.has(base)) return null;
	const tag = base.replaceAll('_', '-');
	return validLocale(tag) ? (Intl.getCanonicalLocales(tag)[0] ?? null) : null;
}

/** `TZ` (a leading `:` dropped) when it names a zone, else the runtime's own zone, else UTC. */
function hostTimeZone(tz: string | undefined, runtimeZone: string | undefined): string {
	const named = (tz ?? '').replace(/^:/, '').trim();
	if (named !== '' && validTimeZone(named)) return named;
	return runtimeZone !== undefined && validTimeZone(runtimeZone) ? runtimeZone : FALLBACK_TIMEZONE;
}

/**
 * This machine's time zone and locale: `TZ` or the runtime's zone; `LC_ALL`,
 * else `LANG` (POSIX precedence: a set LC_ALL decides, `C` included).
 */
export function hostLocaleDefaults(
	env: Readonly<Record<string, string | undefined>> = liveProcessEnv(),
	runtimeZone: string | undefined = Intl.DateTimeFormat().resolvedOptions().timeZone,
): { timezone: string; locale: string } {
	const posix = (env.LC_ALL ?? '') !== '' ? env.LC_ALL : env.LANG;
	return {
		timezone: hostTimeZone(env.TZ, runtimeZone),
		locale: localeFromPosix(posix) ?? FALLBACK_LOCALE,
	};
}

/** The entity name's shape. */
function entityErrors(a: InstallAnswers, problems: Problems): void {
	if (a.entity !== '' && !ENTITY_PATTERN.test(a.entity)) {
		problems.push(
			problem(
				'entity',
				`entity '${a.entity}' must start with a letter and contain only letters, digits and _`,
			),
		);
	}
}

/** The closed-vocabulary answers (SMTP encryption, media access mode). */
function vocabularyErrors(a: InstallAnswers, problems: Problems): void {
	if (a.mailer && !SMTP_SECURE_MODES.includes(a.smtp_secure.toLowerCase())) {
		problems.push(problem('smtp_secure', 'smtp_secure must be tls|ssl|none'));
	}
	if (!MEDIA_ACCESS_MODES.includes(a.media_access_mode)) {
		problems.push(
			problem(
				'media_access_mode',
				'media_access_mode must be private|publication|false (or empty)',
			),
		);
	}
}

/** The time zone and locale the runtime must understand. */
function localeErrors(a: InstallAnswers, problems: Problems): void {
	if (!validTimeZone(a.timezone)) {
		problems.push(problem('timezone', `timezone '${a.timezone}' is not a valid IANA time zone`));
	}
	if (!validLocale(a.locale)) {
		problems.push(problem('locale', `locale '${a.locale}' is not a valid BCP 47 tag`));
	}
}

/**
 * The install fingerprint values. Never .env values (they go to ts_state.json),
 * so the plan's env-line check (install_plan.ts controlCharacterErrors) does not
 * see them.
 */
function fingerprintErrors(a: InstallAnswers, problems: Problems): void {
	for (const key of ['information', 'info_key'] as const) {
		if (/[\r\n\0]/.test(a[key])) {
			problems.push(problem(key, `${key} contains an illegal control character`));
		}
	}
}

/**
 * The route and the instance (terminal installer phase 2, 2026-10-12): a
 * PRODUCTION install is a named instance (multi_instance.md — its own user,
 * database, media and socket derive from the name), so it requires one; any
 * other route has no instance, and one given there is refused rather than
 * silently ignored. (An unknown route is refused by the plan's parser.)
 */
function routeErrors(a: InstallAnswers, problems: Problems): void {
	const production = a.route === 'production';
	if (!production) offProductionIdentityErrors(a, problems);
	if (production && a.instance === '') {
		problems.push(
			problem('instance', 'the production route requires instance (e.g. --instance prado)'),
		);
	} else if (!production && a.instance !== '') {
		problems.push(
			problem(
				'instance',
				`instance is only meaningful on the production route (route is ${a.route})`,
			),
		);
	}
	instanceShapeErrors(a, problems);
}

/** The production-only identity answers (install folder, service account) given on another route. */
function offProductionIdentityErrors(a: InstallAnswers, problems: Problems): void {
	for (const key of IDENTITY_KEYS) {
		if (a[key] !== '') {
			problems.push(
				problem(key, `${key} is only meaningful on the production route (route is ${a.route})`),
			);
		}
	}
}

/** The instance name's shape (INSTANCE_PATTERN). */
function instanceShapeErrors(a: InstallAnswers, problems: Problems): void {
	if (a.instance === '' || INSTANCE_PATTERN.test(a.instance)) return;
	problems.push(
		problem(
			'instance',
			`instance '${a.instance}' must start with a lowercase letter and contain only a-z, 0-9 and _ (28 characters at most)`,
		),
	);
}

// ── the host-step answers (phase 4, 2026-10-12) ─────────────────────────────

/**
 * The TLS modes each route takes (trial has none: it is the evaluation stack).
 * local_ca on production (owner decision 2026-10-16): an install that runs on
 * an isolated intranet with no public name — Let's Encrypt cannot reach it,
 * and `files` would leave the operator making certificates by hand.
 */
const ROUTE_TLS: Readonly<Record<string, readonly string[]>> = Object.freeze({
	production: ['letsencrypt', 'local_ca', 'files'],
	docker: ['letsencrypt', 'local_ca', 'files'],
	trial: ['none'],
});

/** A DNS name with at least two labels, letters/digits/hyphens (no IP, no localhost). */
const FQDN_PATTERN =
	/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** One address the operator's browser reaches — what certbot issues for and the site serves. */
function serverNameErrors(a: InstallAnswers, problems: Problems): void {
	if (a.server_name === '') {
		problems.push(
			problem(
				'server_name',
				`the ${a.route} route requires server_name (the public address, e.g. --server-name dedalo.example.org)`,
			),
		);
		return;
	}
	if (!FQDN_PATTERN.test(a.server_name)) {
		problems.push(
			problem(
				'server_name',
				`server_name '${a.server_name}' must be a fully qualified domain name (not localhost, not an IP address)`,
			),
		);
	}
}

/** The two public ports: valid, and distinct. */
function webPortErrors(a: InstallAnswers, problems: Problems): void {
	for (const [name, value] of [
		['http_port', a.http_port],
		['https_port', a.https_port],
	] as const) {
		const message = portError(name, value);
		if (message !== null) problems.push(problem(name, message));
	}
	if (a.http_port === a.https_port) {
		problems.push(problem('https_port', 'http_port and https_port must differ'));
	}
}

/** The certificate the route takes, and what that mode needs. */
function tlsErrors(a: InstallAnswers, problems: Problems): void {
	const allowed = ROUTE_TLS[a.route] ?? [];
	if (!allowed.includes(a.tls_mode)) {
		problems.push(
			problem('tls_mode', `tls_mode must be ${allowed.join('|')} on the ${a.route} route`),
		);
		return;
	}
	if (a.tls_mode === 'letsencrypt') letsEncryptErrors(a, problems);
	if (a.tls_mode === 'files') tlsFileErrors(a, problems);
	extraNameErrors(a, problems);
	if (a.tls_mode === 'local_ca') nestedNameErrors(a, problems);
}

/**
 * The local CA certifies each of its DNS names EXACTLY: the generator writes
 * `excluded;DNS:.<name>` beside each permitted name, so nothing BELOW a name
 * verifies (deploy/dedalo-tls-rotate.sh header, EXACT NAMES — a stolen issuing
 * key must not mint `mail.museo.lan` because the list holds `museo.lan`). A
 * name under another listed name — localhost included, which every leaf
 * carries — would then be refused by its own authority; the generator refuses
 * the list, so it is refused here first, before anything is installed.
 */
function nestedNameErrors(a: InstallAnswers, problems: Problems): void {
	const extras = a.tls_extra_names === '' ? [] : a.tls_extra_names.split(',');
	const names = [a.server_name, ...extras].filter((name) => !IPV4_PATTERN.test(name));
	for (const lower of names) {
		const upper = [...names, 'localhost'].find((name) => lower.endsWith(`.${name}`));
		if (upper === undefined) continue;
		problems.push(
			problem(
				lower === a.server_name ? 'server_name' : 'tls_extra_names',
				`${lower} lies under ${upper}: the local CA certifies each name exactly, never the names below it — give staff names that are not inside one another`,
			),
		);
	}
}

/** A dotted IPv4 address, every octet 0-255 (no leading zeros: one spelling per address). */
const IPV4_PATTERN = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * The local CA's extra addresses: each a name shaped like server_name or an
 * IPv4 address — the generator constrains the authority to exactly this list,
 * so a malformed entry is refused here, before anything is issued. IPv6 is
 * refused (the authority's IP constraint is written per family; the generator
 * refuses it too). A loopback address and the server name itself are already
 * in every certificate. Only meaningful with local_ca: Let's Encrypt and the
 * institution's files name what their issuer certified.
 */
function extraNameErrors(a: InstallAnswers, problems: Problems): void {
	if (a.tls_extra_names === '') return;
	if (a.tls_mode !== 'local_ca') {
		problems.push(
			problem(
				'tls_extra_names',
				`tls_extra_names is only meaningful with tls_mode local_ca (tls_mode is ${a.tls_mode})`,
			),
		);
		return;
	}
	for (const name of a.tls_extra_names.split(',')) {
		const message = extraNameError(name, a.server_name);
		if (message !== null) problems.push(problem('tls_extra_names', message));
	}
}

/** One extra address's refusal, or null. */
function extraNameError(name: string, serverName: string): string | null {
	if (name === serverName) return `tls_extra_names: ${name} is already the server_name`;
	if (name.includes(':'))
		return `tls_extra_names: ${name} — IPv6 addresses are not supported for the local CA (use a name or an IPv4 address)`;
	if (IPV4_PATTERN.test(name)) {
		// An IPv4 address is served on BOTH routes: the docker stack's one site is the
		// address's default; on a native host the installer's catch-all picks this
		// instance's certificate for a CLAIMED address (host/web/catch_all.ts) — that
		// the address is this host's and no other instance's is the System check's
		// (host/production/address_claims.ts), not the answers'.
		return name.startsWith('127.')
			? `tls_extra_names: ${name} is a loopback address (127.0.0.1 is in every certificate already)`
			: null;
	}
	return FQDN_PATTERN.test(name)
		? null
		: `tls_extra_names: '${name}' must be a fully qualified domain name or an IPv4 address`;
}

/** Let's Encrypt: an address for expiry notices, and the HTTP-01 challenge on port 80. */
function letsEncryptErrors(a: InstallAnswers, problems: Problems): void {
	if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.letsencrypt_email)) {
		problems.push(
			problem(
				'letsencrypt_email',
				"Let's Encrypt requires letsencrypt_email (an address for expiry notices)",
			),
		);
	}
	if (a.http_port !== '80') {
		problems.push(
			problem(
				'http_port',
				"Let's Encrypt validates over port 80: http_port must be 80 (or use tls_mode files)",
			),
		);
	}
}

/** The institution's own certificate: two absolute paths. */
function tlsFileErrors(a: InstallAnswers, problems: Problems): void {
	for (const key of ['tls_cert_path', 'tls_key_path'] as const) {
		if (!isAbsolute(a[key])) {
			problems.push(problem(key, `tls_mode files requires ${key} (an absolute path)`));
		}
	}
}

/** The production-only answers: the web server, the database mode, the backup directory. */
function productionHostErrors(a: InstallAnswers, problems: Problems): void {
	if (!['', 'nginx', 'apache'].includes(a.web_server)) {
		problems.push(
			problem('web_server', 'web_server must be nginx|apache (or empty: the one the host has)'),
		);
	}
	if (!['create', 'existing'].includes(a.db_mode)) {
		problems.push(problem('db_mode', 'db_mode must be create|existing'));
	}
	backupDirErrors(a, problems);
	mediaRootErrors(a, problems);
	installDirErrors(a, problems);
	serviceNameErrors(a, problems);
	peerRoleErrors(a, problems);
	for (const key of ['install_dir', 'backup_dir'] as const) reservedOverlapErrors(a, key, problems);
}

// ── the install folder and the service account (owner decisions 2026-10-12) ──

/** The production-only identity answers. */
const IDENTITY_KEYS = ['install_dir', 'service_user', 'service_group'] as const;

/**
 * A Linux user/group name the installer accepts: useradd's default NAME_REGEX
 * (`^[a-z_][a-z0-9_-]*[$]?$`) plus `.` — an EXISTING hosting account is often
 * named after its domain (my_domain.org). Creating a dotted name is refused on
 * the host (identity_rules.ts): useradd's own default regex would refuse it.
 */
export const SERVICE_NAME_PATTERN = /^[a-z_][a-z0-9_.-]*\$?$/;

/** The longest Linux user/group name (useradd's default). */
export const SERVICE_NAME_MAX = 32;

/** Locations (and everything under them) no install folder may be. */
const SYSTEM_TREES: readonly string[] = Object.freeze([
	'/etc',
	'/usr',
	'/bin',
	'/sbin',
	'/lib',
	'/lib64',
	'/boot',
	'/dev',
	'/proc',
	'/sys',
	'/run',
	'/var/run',
	'/tmp',
	'/var/tmp',
	'/root',
]);

/** Shared roots no install folder may BE (a folder under them is fine). */
const SHARED_ROOTS: readonly string[] = Object.freeze([
	'/home',
	'/srv',
	'/opt',
	'/var',
	'/var/lib',
	'/var/www',
]);

/** Is `path` `dir` itself or inside it (component-wise: /home/a is not inside /home/ab)? */
export function sameOrInside(path: string, dir: string): boolean {
	return path === dir || path.startsWith(dir === '/' ? '/' : `${dir}/`);
}

/** Do two paths overlap (the same, one inside the other)? */
export function pathsOverlap(a: string, b: string): boolean {
	return sameOrInside(a, b) || sameOrInside(b, a);
}

/** Every segment plain: letters, digits, '.', '_', '-'. */
const PLAIN_SEGMENTS = /^(\/[A-Za-z0-9._-]+)+$/;

/** An absolute path, normalized (no trailing /, no empty, . or .. segment), two levels at least. */
function normalizedDeep(path: string): boolean {
	const segments = path.split('/').slice(1);
	return segments.length >= 2 && segments.every((segment) => !['', '.', '..'].includes(segment));
}

/** The example folder of the sentences (the instance's default one). */
function exampleDir(a: InstallAnswers): string {
	return `/home/ded_${INSTANCE_PATTERN.test(a.instance) ? a.instance : '<instance>'}`;
}

/** The install folder's shape: absolute, normalized, plain segments, not a system location. */
function installDirErrors(a: InstallAnswers, problems: Problems): void {
	const value = a.install_dir;
	const sentence = installDirShape(value, a);
	if (sentence !== null) problems.push(problem('install_dir', sentence));
}

/** The first refusal of the install folder's shape, or null. */
function installDirShape(value: string, a: InstallAnswers): string | null {
	if (!isAbsolute(value)) return 'install_dir must be an absolute path';
	if (!normalizedDeep(value)) {
		return `install_dir '${value}' must be a normalized absolute path of at least two levels (e.g. ${exampleDir(a)} or /home/my_domain.org/dedalo) — no trailing /, no . or .. segments`;
	}
	if (!PLAIN_SEGMENTS.test(value)) {
		return `install_dir '${value}' may contain only letters, digits, '.', '_' and '-' in each segment`;
	}
	const system =
		SYSTEM_TREES.find((tree) => sameOrInside(value, tree)) ??
		SHARED_ROOTS.find((root) => value === root);
	return system === undefined
		? null
		: `install_dir '${value}' is a system location (${system}) — choose a folder of its own, e.g. ${exampleDir(a)}`;
}

/**
 * The backup folder's shape: absolute and NORMALIZED with plain segments, as
 * the install folder — every overlap check (another instance's folders, the
 * reserved places) compares paths component-wise, so `//x`, `/a/../b` or a
 * trailing `/` would slip past them.
 */
function backupDirErrors(a: InstallAnswers, problems: Problems): void {
	const value = a.backup_dir;
	if (!isAbsolute(value)) {
		problems.push(problem('backup_dir', 'backup_dir must be an absolute path'));
		return;
	}
	if (normalizedDeep(value) && PLAIN_SEGMENTS.test(value)) return;
	problems.push(
		problem(
			'backup_dir',
			`backup_dir '${value}' must be a normalized absolute path of at least two levels with plain segments (letters, digits, '.', '_', '-') — no trailing /, no empty, . or .. segments`,
		),
	);
}

/**
 * The places the installer keeps ROOT-OWNED or serves to the WEB: no install
 * folder or backup folder may overlap one (the whole shared roots, so a
 * folder at /srv/dedalo/foo never blocks a future instance named foo).
 */
function reservedPlaces(a: InstallAnswers): string[] {
	const places = [
		'/opt/dedalo',
		'/var/lib/dedalo-install',
		'/var/backups/dedalo-site-builder',
		'/srv/dedalo',
	];
	if (isAbsolute(a.media_path)) places.push(dirname(dirname(a.media_path)));
	if (isAbsolute(a.unix_socket)) places.push(dirname(a.unix_socket));
	return places;
}

/** `key`'s folder overlapping a reserved place. */
function reservedOverlapErrors(
	a: InstallAnswers,
	key: 'install_dir' | 'backup_dir',
	problems: Problems,
): void {
	const value = a[key];
	if (!isAbsolute(value)) return;
	const place = reservedPlaces(a).find((item) => pathsOverlap(value, item));
	if (place === undefined) return;
	problems.push(
		problem(
			key,
			`${key} '${value}' overlaps ${place}, which the installer keeps root-owned or serves to the web — choose a folder outside it`,
		),
	);
}

/** One account name's refusal (`kind`: user or group), or null. */
function serviceNameProblem(kind: 'user' | 'group', value: string): string | null {
	if (value === 'root') return `service_${kind} root is refused — the service never runs as root`;
	if (SERVICE_NAME_PATTERN.test(value) && value.length <= SERVICE_NAME_MAX) return null;
	return `service_${kind} '${value}' is not a valid Linux ${kind} name (a-z or _ first, then a-z, 0-9, _, -, . — 32 characters at most)`;
}

/** The service user (required) and group ('' = the user's own group). */
function serviceNameErrors(a: InstallAnswers, problems: Problems): void {
	const user =
		a.service_user === ''
			? 'service_user is required (the account the instance runs as)'
			: serviceNameProblem('user', a.service_user);
	if (user !== null) problems.push(problem('service_user', user));
	const group = a.service_group === '' ? null : serviceNameProblem('group', a.service_group);
	if (group !== null) problems.push(problem('service_group', group));
}

/**
 * Is the database role the SERVICE USER's (a created production database —
 * PEER)? Then it is never asked: its emptiness is service_user's refusal.
 */
function peerRole(a: InstallAnswers): boolean {
	return a.route === 'production' && !a.engine_only && a.db_mode === 'create';
}

/** A created database's role IS the service user (PEER: OS user ↔ role of the same name). */
function peerRoleErrors(a: InstallAnswers, problems: Problems): void {
	if (!peerRole(a) || a.db_username === a.service_user) return;
	problems.push(
		problem(
			'db_username',
			`with db_mode create the database role is the service user (PostgreSQL peer authentication maps the OS user to the role of the same name): db_username '${a.db_username}' must be '${a.service_user}' — omit --db-user`,
		),
	);
}

/**
 * THE ROOT RULE (deploy/nginx.conf; src/config/catalog/media.ts): the site's
 * `root` + `/dedalo/<DEDALO_MEDIA_DIR>` must BE MEDIA_PATH. The engine builds
 * every media URL under `/dedalo/<DEDALO_MEDIA_DIR>/`, and the installer keeps
 * that name at its default (`media`), so MEDIA_PATH must end in
 * `/dedalo/media` — any other path has no root that serves it (a
 * `/…/dedalo/files` would resolve every URL to a `…/dedalo/media` that does
 * not exist: install_host_render_tripwire (d)).
 */
function mediaRootErrors(a: InstallAnswers, problems: Problems): void {
	if (a.media_path !== '' && !/^\/.+\/dedalo\/media$/.test(a.media_path)) {
		problems.push(
			problem(
				'media_path',
				`media_path '${a.media_path}' must end in /dedalo/media (the web root rule: root + /dedalo/<DEDALO_MEDIA_DIR> == MEDIA_PATH, and the installer keeps DEDALO_MEDIA_DIR=media)`,
			),
		);
	}
}

/** The docker/trial-only answers: where the image comes from. */
function stackHostErrors(a: InstallAnswers, problems: Problems): void {
	imageSourceFormErrors(a, problems);
	imageSourceIdentityErrors(a, problems);
	imageVersionErrors(a, problems);
}

/** The image source's own shape: one of the three, and a custom one names its repository. */
function imageSourceFormErrors(a: InstallAnswers, problems: Problems): void {
	if (!['official', 'custom', 'build'].includes(a.image_source)) {
		problems.push(problem('image_source', 'image_source must be official|custom|build'));
	}
	if (a.image_source === 'custom' && a.image_repository === '') {
		problems.push(problem('image_repository', 'image_source custom requires image_repository'));
	}
}

/** The image tag: a development build may not run the nightly tag, and only an accepted tag passes. */
function imageVersionErrors(a: InstallAnswers, problems: Problems): void {
	// An empty image_version on a development build derives the nightly tag `X.Y.Z-dev`
	// (layout.ts imageVersionOf): no Docker install may run it (VERSIONING_SPEC S3). Said
	// here, on the Image screen, whatever the source — the run's preflight refuses it too.
	if (a.image_version === '' && installerIdentity().kind === 'dev') {
		problems.push(problem('image_version', devHasNoImageMessage()));
	}
	// The run's preflight refuses any other tag (stack/preflight.ts imageProblems): said on
	// the Image screen itself, never first after `yes` (campaign 3c D2: `9.9.9` passed the
	// field and the Review, every answer lost at the refusal).
	if (a.image_version !== '' && !acceptedImageVersions().includes(a.image_version)) {
		problems.push(
			problem(
				'image_version',
				imageRefusalMessage(
					a.image_version,
					"leave it empty: the engine steps run inside the image with this installer's request format",
				),
			),
		);
	}
}

/**
 * A development build (untagged) is no image: Official and Build are refused from
 * the identity itself, on the Image screen — the Review never asks a registry for it (Q6).
 */
function imageSourceIdentityErrors(a: InstallAnswers, problems: Problems): void {
	const refused = imageSourceRefusedFor(a.image_source);
	if (refused !== null) problems.push(problem('image_source', refused));
}

// ── the developer route's development listener (DEV_ROUTE_SERVE §1.1–1.2) ────

/** The listener answers only the developer route reads (dev_listener.ts). */
const DEV_LISTENER_KEYS = ['dev_port', 'dev_host'] as const;

/**
 * The development listener: a port and an address the server can bind, and a
 * TLS mode a checkout has (no Let's Encrypt: no public name). '' = the plan
 * decides (the prior .env's, else the defaults). On any other route the answers
 * are refused rather than silently ignored: they would write nothing.
 */
function devListenerErrors(a: InstallAnswers, problems: Problems): void {
	if (a.route !== 'developer' || a.engine_only) {
		offDeveloperListenerErrors(a, problems);
		return;
	}
	devPortErrors(a, problems);
	devHostErrors(a, problems);
	devTlsErrors(a, problems);
}

/** The developer listener's answers given on another route (they would write nothing). */
function offDeveloperListenerErrors(a: InstallAnswers, problems: Problems): void {
	for (const key of DEV_LISTENER_KEYS) {
		if (a[key] === '') continue;
		problems.push(
			problem(key, `${key} is only meaningful on the developer route (route is ${a.route})`),
		);
	}
}

/** The development port, when given: 1-65535. */
function devPortErrors(a: InstallAnswers, problems: Problems): void {
	const message = a.dev_port === '' ? null : portError('dev_port', a.dev_port);
	if (message !== null) problems.push(problem('dev_port', message));
}

/** A development address the server can bind: localhost or an IP literal. */
function isDevHost(value: string): boolean {
	return value === 'localhost' || isIP(value) !== 0;
}

const DEV_HOST_RULE =
	'must be 127.0.0.1 (this machine), 0.0.0.0 (the local network) or one IP address of this machine';

/** The development address, when given: localhost or an IP literal (what the server binds). */
function devHostErrors(a: InstallAnswers, problems: Problems): void {
	if (a.dev_host === '' || isDevHost(a.dev_host)) return;
	problems.push(problem('dev_host', `dev_host '${a.dev_host}' ${DEV_HOST_RULE}`));
}

/**
 * The listener values the plan KEPT from the prior .env (PRESERVE), held to the
 * SAME rules as an answer: an unanswered re-run over `SERVER_TCP_PORT=abc`
 * would otherwise reach the port probe with NaN (an untyped bind error) or
 * write a .env whose `bun run dev` cannot boot. Tagged with the answer that
 * replaces the value, so the screen attaches the refusal where it is fixed.
 * The socket too, kept OR derived from the entity (unansweredSocketProblems).
 */
export function keptDevListenerProblems(
	listener: Pick<DevListenerPlan, 'port' | 'host' | 'kept' | 'socket' | 'socketSource'> | null,
): FieldError[] {
	if (listener === null) return [];
	const problems: Problems = [];
	if (listener.kept.includes('SERVER_TCP_PORT') && portError('p', listener.port) !== null) {
		problems.push(
			problem(
				'dev_port',
				`SERVER_TCP_PORT '${listener.port}' kept from your .env must be an integer 1-65535 — answer dev_port (--dev-port) to replace it`,
			),
		);
	}
	if (listener.kept.includes('SERVER_TCP_HOST') && !isDevHost(listener.host)) {
		problems.push(
			problem(
				'dev_host',
				`SERVER_TCP_HOST '${listener.host}' kept from your .env ${DEV_HOST_RULE} — answer dev_host (--dev-host) to replace it`,
			),
		);
	}
	problems.push(...unansweredSocketProblems(listener));
	return problems;
}

/**
 * The developer socket the operator did NOT type (an answer is refused by
 * pathErrors): one kept from the .env must be absolute, and a kept or derived
 * one bindable — a long entity makes a derived path the OS refuses.
 */
function unansweredSocketProblems(
	listener: Pick<DevListenerPlan, 'socket' | 'socketSource'>,
): FieldError[] {
	if (listener.socketSource === 'answered') return [];
	const origin =
		listener.socketSource === 'kept' ? 'kept from your .env' : 'derived from the entity';
	const replace = 'answer unix_socket (--socket) to replace it';
	if (listener.socketSource === 'kept' && !isAbsolute(listener.socket)) {
		return [
			problem(
				'unix_socket',
				`SERVER_UNIX_SOCKET '${listener.socket}' ${origin} must be an absolute path — ${replace}`,
			),
		];
	}
	const length = unixSocketLengthProblem(listener.socket);
	return length === null
		? []
		: [
				problem(
					'unix_socket',
					`SERVER_UNIX_SOCKET '${listener.socket}' ${origin} ${length} — ${replace}`,
				),
			];
}

/** The developer listener's TLS mode, and what `files` needs. */
function devTlsErrors(a: InstallAnswers, problems: Problems): void {
	if (a.tls_mode !== '' && !(DEV_TLS_MODES as readonly string[]).includes(a.tls_mode)) {
		problems.push(
			problem('tls_mode', `tls_mode must be ${DEV_TLS_MODES.join('|')} on the developer route`),
		);
		return;
	}
	if (a.tls_mode === 'files') tlsFileErrors(a, problems);
}

// ── the public address (DEDALO_HOST + DEDALO_PROTOCOL, 2026-11-07) ──────────

/**
 * The public-address answer that means "this installation has none" (a private
 * or intranet install): nothing is written, and the engine identifies itself to
 * providers with the shared identity. '' (not given) writes nothing either.
 */
export const NO_PUBLIC_HOST = 'none';

/** The default protocol of a public address (DEDALO_PROTOCOL beside DEDALO_HOST): HTTPS. */
export const DEFAULT_PUBLIC_PROTOCOL = 'https://';

/**
 * The protocol the ENGINE reads when DEDALO_PROTOCOL is unset — the catalog's own
 * default (read from the entry, never restated): a prior .env holding DEDALO_HOST
 * and no DEDALO_PROTOCOL is served as this, so a re-run must neither offer nor
 * silently write another one.
 */
export const ENGINE_DEFAULT_PROTOCOL: string = PATHS_KEYS.DEDALO_PROTOCOL.default;

/** The protocols a public address takes (DEDALO_PROTOCOL's spelling: scheme + `://`). */
export const PUBLIC_PROTOCOLS: readonly string[] = Object.freeze([
	DEFAULT_PUBLIC_PROTOCOL,
	'http://',
]);

/**
 * A public-host ANSWER's own character shape: a host name or IPv4 (letters, digits,
 * `.`, `-`, `_`), or a bracketed IPv6 literal, then an optional numeric port —
 * lowercase (the plan lowercases it). URL parsing reads more as an origin (`host:` with
 * an empty port, a non-ASCII host, a `$`); this pattern refuses those, and
 * {@link canonicalHostOf} then refuses every spelling URL parsing would REWRITE
 * (`134744072`, `127.1`, `:0443`, a default port) — the value goes into the .env as
 * typed, so it must already be the canonical host the engine reads.
 */
const PUBLIC_HOST_ANSWER = /^(?:[a-z0-9._-]+|\[[0-9a-f:.]+\])(?::[0-9]{1,5})?$/;

/** A public-host answer, canonical: trimmed and lowercased ('' when absent). */
export function canonicalPublicHost(value: unknown): string {
	return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * The canonical host (`URL.host`: host + a non-default port) `protocol` + `host`
 * parses to — what the engine reads that address as; null when it does not parse.
 * A trailing dot is kept by URL parsing but names the same host, so it is dropped
 * here (the canonical spelling to type has none).
 */
export function canonicalHostOf(protocol: string, host: string): string | null {
	const url = URL.parse(`${protocol}${host}`);
	if (url === null) return null;
	return url.hostname.endsWith('.') ? url.host.replace(/\.(?=:|$)/, '') : url.host;
}

/**
 * What a public-host answer is, in the ENGINE's terms (`public_reach_rule.ts`):
 * `none` ('' or 'none'), `malformed` (not a bare http(s) origin the engine could
 * send), `non_canonical` (an origin, but not spelled as the engine reads it — e.g.
 * `127.1`, `example.org:443` over https), `unreachable` (canonical, but no outside
 * machine reaches it — the engine would fall back to the shared identity) or
 * `reachable` (the engine uses it).
 */
export type PublicHostVerdict =
	| 'none'
	| 'malformed'
	| 'non_canonical'
	| 'unreachable'
	| 'reachable';

export function publicHostVerdict(host: string, protocol: string): PublicHostVerdict {
	if (host === '' || host === NO_PUBLIC_HOST) return 'none';
	const candidate = `${protocol}${host}`;
	if (!PUBLIC_HOST_ANSWER.test(host) || !isBareOrigin(candidate)) return 'malformed';
	return givenHostVerdict(host, protocol, candidate);
}

/** A well-formed host's verdict: spelled as the engine reads it, then reachable or not. */
function givenHostVerdict(host: string, protocol: string, candidate: string): PublicHostVerdict {
	if (canonicalHostOf(protocol, host) !== host) return 'non_canonical';
	return identifiableOrigin(candidate) === null ? 'unreachable' : 'reachable';
}

/** The refusal of each verdict that refuses (an unreachable one only when not kept). */
const PUBLIC_HOST_REFUSALS: Readonly<
	Partial<Record<PublicHostVerdict, (a: InstallAnswers) => string | null>>
> = Object.freeze({
	malformed: (a: InstallAnswers) =>
		`public_host ${JSON.stringify(a.public_host)} must be a bare host name or address with an optional port (e.g. museum.example.org or museum.example.org:8443 — no scheme, credentials, path, query or spaces), or none`,
	non_canonical: (a: InstallAnswers) =>
		`public_host ${JSON.stringify(a.public_host)} is not written the way the engine reads it: type ${JSON.stringify(canonicalHostOf(a.public_protocol, a.public_host))} (no default port, no leading zeros, a dotted IPv4, no trailing dot)`,
	unreachable: (a: InstallAnswers) =>
		a.public_host_keep_private
			? null
			: `public_host ${JSON.stringify(a.public_host)} is not reachable from outside (a loopback or private address, or an intranet name): with it the engine would identify itself to map and geo providers with the shared identity, exactly as with none — answer none, or keep it anyway (--public-host-keep-private)`,
});

/**
 * The verdicts a route refuses. Developer and trial: every refusing one. Production
 * and docker DERIVE the address (the plan refuses an explicit one that differs); what
 * reaches here there is either that derived value or — the delegated engine child,
 * which has no server_name — the host's derived answer AS GIVEN, so its SHAPE is held
 * again (a hand-run `--engine-only --public-host 'evil\'` writes nothing), while an
 * unreachable one is the derived intranet address and is written (waived).
 */
function refusedVerdicts(a: InstallAnswers): readonly PublicHostVerdict[] {
	const derived = a.route === 'production' || a.route === 'docker';
	return derived ? ['malformed', 'non_canonical'] : ['malformed', 'non_canonical', 'unreachable'];
}

/** The public address. The protocol first: without a valid one the address cannot be judged. */
function publicAddressErrors(a: InstallAnswers, problems: Problems): void {
	if (!PUBLIC_PROTOCOLS.includes(a.public_protocol)) {
		problems.push(
			problem(
				'public_protocol',
				`public_protocol ${JSON.stringify(a.public_protocol)} must be ${PUBLIC_PROTOCOLS.join(' or ')}`,
			),
		);
		return;
	}
	const verdict = publicHostVerdict(a.public_host, a.public_protocol);
	if (!refusedVerdicts(a).includes(verdict)) return;
	const message = PUBLIC_HOST_REFUSALS[verdict]?.(a);
	if (message !== null && message !== undefined) problems.push(problem('public_host', message));
}

/** The answers that make the host steps (production, docker) — skipped for the engine child (A14). */
function hostErrors(a: InstallAnswers, problems: Problems): void {
	if (a.engine_only || a.route === 'developer') return;
	if (a.route !== 'trial') serverNameErrors(a, problems);
	webPortErrors(a, problems);
	tlsErrors(a, problems);
	if (a.route === 'production') productionHostErrors(a, problems);
	else stackHostErrors(a, problems);
}

/**
 * Every answer-only refusal, each TAGGED with the answer it is about — the ONE
 * rule set: the plan's `errors` carry the sentences, its `fieldErrors` the tags
 * the screen model attaches them by (no front end validates anything itself).
 */
export function answerProblems(a: InstallAnswers): FieldError[] {
	const problems: Problems = [];
	routeErrors(a, problems);
	requiredErrors(a, problems);
	connectionErrors(a, problems);
	portErrors(a, problems);
	pathErrors(a, problems);
	entityErrors(a, problems);
	vocabularyErrors(a, problems);
	localeErrors(a, problems);
	fingerprintErrors(a, problems);
	devListenerErrors(a, problems);
	hostErrors(a, problems);
	publicAddressErrors(a, problems);
	return problems;
}

/**
 * Every answer-only refusal, appended to `errors` (the plan's — each one
 * blocks). `notes` is the plan's notes list, for a rule that only informs.
 */
export function validateAnswers(a: InstallAnswers, _notes: string[], errors: string[]): void {
	errors.push(...answerProblems(a).map((item) => item.message));
}

/**
 * The root password's refusals. It is a PLAN INPUT of its own, never an answer
 * (an answers file never carries it): `required` when the run
 * will set it (a fresh terminal install); a supplied one is always held to THE
 * password policy — the same function set_root_pw refuses with (root_pw.ts).
 */
export function rootPasswordErrors(password: string | undefined, required: boolean): string[] {
	if (password === undefined || password === '') {
		return required
			? [
					'root password is required (DEDALO_INSTALL_ROOT_PASSWORD, --secrets-stdin or --root-password)',
				]
			: [];
	}
	const failed = check_password(password).failed;
	return failed === null ? [] : [`root password does not meet the password policy (${failed})`];
}
