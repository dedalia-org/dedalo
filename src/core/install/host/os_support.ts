/**
 * THE SUPPORTED OPERATING SYSTEMS (terminal installer phase 4, 2026-10-12) —
 * NEWEST RELEASES ONLY (owner): one row per (distribution, major release), and
 * a host that matches no row is REFUSED at the System check with this list. No
 * code path exists for an older release: when a newer release needs something
 * different, the row changes, never a branch beside it.
 *
 * MATCHING (critique A10): the EXACT `ID` and the exact `VERSION_ID` major —
 * never `ID_LIKE` (that would classify Fedora, CentOS Stream or Oracle Linux as
 * RHEL) and never a guessed codename.
 *
 * WHAT A ROW HOLDS: the package tool; the ABSOLUTE path of every binary the host
 * steps run (the runner never looks anything up on PATH — host/runner.ts); the
 * web server's user, service and layout; PostgreSQL 18's source, service and
 * binaries; the package names. Measured (publication/host_agent's container
 * captures, 2026-10-08): Ubuntu 26.04 ships nginx 1.28.3 and PostgreSQL 18;
 * Debian 13 nginx 1.26 and PostgreSQL 17 (18 from PGDG); EL 10 nginx 1.26, no
 * PostgreSQL 18 (PGDG), ImageMagick from EPEL, FFmpeg from RPM Fusion.
 *
 * PURE: data and parsers only.
 */

import { debianTesseractPackage, rhelTesseractPackage } from '../../media/engine/ocr_langs.ts';
import { hostRefuse } from './refuse.ts';

/** os-release(5) values this module reads. */
export interface OsRelease {
	readonly id: string;
	readonly versionId: string;
	readonly prettyName: string;
}

/** shell-like quoting of one os-release value. */
function unquote(raw: string): string {
	const value = raw.trim();
	const quoted = value.length >= 2 && /^(["']).*\1$/.test(value);
	return quoted ? value.slice(1, -1).replace(/\\([\\"$`])/g, '$1') : value;
}

/** os-release(5): `KEY=value` lines (ported from publication/host_agent — that tree is isolated). */
export function parseOsRelease(text: string): OsRelease {
	const values: Record<string, string> = {};
	for (const line of text.split('\n')) {
		const match = /^\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
		if (match) values[match[1] as string] = unquote(match[2] as string);
	}
	// Property reads, not lookups by a quoted name: these are os-release fields, not
	// configuration keys (the config census reads a call's leading key literal).
	return {
		id: (values.ID ?? '').toLowerCase(),
		versionId: values.VERSION_ID ?? '',
		prettyName: values.PRETTY_NAME ?? '',
	};
}

export type OsRowId = 'ubuntu2604' | 'debian13' | 'el10';
export type PackageTool = 'apt' | 'dnf';

/** The binaries a host step may run — every one an absolute path in each row. */
export type Binary =
	| 'apt-get'
	| 'dpkg-query'
	| 'dnf'
	| 'rpm'
	| 'crb'
	| 'systemctl'
	| 'useradd'
	| 'groupadd'
	| 'userdel'
	| 'groupdel'
	| 'usermod'
	| 'gpasswd'
	| 'getent'
	| 'runuser'
	/** `env HOME=…` after a runuser prefix: runuser resets HOME to the account's home. */
	| 'env'
	| 'id'
	| 'pgrep'
	| 'tar'
	| 'git'
	| 'curl'
	| 'ss'
	| 'nginx'
	| 'apachectl'
	/**
	 * Apache's `-v` / `-S` / `-M` speaker. NOT apachectl everywhere: EL 10's
	 * apachectl refuses both (`The "-M" option is not supported.`, exit 2) —
	 * httpd itself answers there; Debian's apache2ctl answers (it sources envvars).
	 */
	| 'apache-query'
	| 'a2ensite'
	| 'a2dissite'
	| 'certbot'
	| 'semanage'
	| 'semodule'
	| 'restorecon'
	| 'getenforce'
	/** A file's SELinux label (`stat -c %C`) — host_selinux's verify. */
	| 'stat'
	/** A process's SELinux label (`ps -o label=`) — host_first_boot's domain check. */
	| 'ps'
	| 'firewall-cmd'
	| 'ufw'
	| 'pg_lsclusters'
	| 'pg_setup'
	| 'uname'
	| 'unzip'
	| 'chown'
	| 'rm'
	| 'install'
	/** Byte comparison (diffutils — in every row's base packages): an identical runtime is not reinstalled. */
	| 'cmp'
	/** util-linux (runuser's package on every row): the engine child dies with the installer (C3-29). */
	| 'setpriv'
	/** What files of the service user remain before it is removed (C3-9). */
	| 'find'
	/** The generated salt read back from the instance's .env, as the instance (C3-18). */
	| 'grep'
	| 'test';

export interface OsRow {
	readonly id: OsRowId;
	readonly label: string;
	readonly tool: PackageTool;
	/** `ID` values that select the row, and the VERSION_ID major they need. */
	readonly ids: readonly string[];
	readonly versionMajor: string;
	/** Absolute paths; a binary the row's tool does not have is absent (binaryOf refuses it). */
	readonly binaries: Readonly<Partial<Record<Binary, string>>>;
	/** PostgreSQL 18's binary directory (DEDALO_PG_BIN_PATH, the backup's pg_dump). */
	readonly pgBinDir: string;
	readonly pgService: string;
	/** PostgreSQL 18 comes from PGDG (a repository this install may add). */
	readonly pgFromPgdg: boolean;
	readonly web: Readonly<Record<'nginx' | 'apache', WebFlavor>>;
	readonly packages: RowPackages;
	/** The certbot renewal timer the distribution's package ships. */
	readonly certbotTimer: string;
	/** SELinux applies (RHEL family). */
	readonly selinux: boolean;
}

export interface WebFlavor {
	readonly package: readonly string[];
	readonly service: string;
	readonly user: string;
	readonly binary: 'nginx' | 'apachectl';
	/** Where this instance's site file goes (`<i>` replaced). */
	readonly sitePath: string;
	/** Apache on Debian: enabled with a2ensite (our site only). */
	readonly enableWithA2ensite: boolean;
	readonly logDir: string;
	/**
	 * The `default_server` the PACKAGE itself installs (Debian/Ubuntu nginx:
	 * `sites-enabled/default` on 80) — a run that installs the web server tells
	 * it on the Review, before the package exists to be measured (campaign 3e E5).
	 */
	readonly packageDefault?: { readonly port: string; readonly file: string };
}

export interface RowPackages {
	/** Always (the media toolchain, PostgreSQL 18, the archive tools). */
	readonly base: readonly string[];
	readonly certbot: readonly string[];
	/** local_ca: what deploy/dedalo-tls-rotate.sh runs (the openssl CLI). */
	readonly localCa: readonly string[];
	/** Installed in a separate transaction whose failure only warns (EL: ocrmypdf — L28). */
	readonly optional: readonly string[];
	/** SELinux management (semanage). */
	readonly selinuxTools: readonly string[];
	/**
	 * The Tesseract language packs (T0-11 D3): one per working language plus
	 * `osd`, named by the ONE map (media/engine/ocr_langs.ts). `lane` follows
	 * ocrmypdf's — `base` where ocrmypdf is mandatory (apt), `optional` where it
	 * is (EL: a pack without ocrmypdf is no OCR, and its failure only warns).
	 */
	readonly ocrLangpacks: {
		readonly lane: 'base' | 'optional';
		readonly packageOf: (model: string) => string;
	};
}

const SHARED_BINARIES = {
	systemctl: '/usr/bin/systemctl',
	useradd: '/usr/sbin/useradd',
	groupadd: '/usr/sbin/groupadd',
	userdel: '/usr/sbin/userdel',
	groupdel: '/usr/sbin/groupdel',
	usermod: '/usr/sbin/usermod',
	gpasswd: '/usr/bin/gpasswd',
	getent: '/usr/bin/getent',
	runuser: '/usr/sbin/runuser',
	env: '/usr/bin/env',
	id: '/usr/bin/id',
	pgrep: '/usr/bin/pgrep',
	tar: '/usr/bin/tar',
	git: '/usr/bin/git',
	curl: '/usr/bin/curl',
	ss: '/usr/bin/ss',
	nginx: '/usr/sbin/nginx',
	apachectl: '/usr/sbin/apachectl',
	certbot: '/usr/bin/certbot',
	semanage: '/usr/sbin/semanage',
	semodule: '/usr/sbin/semodule',
	restorecon: '/usr/sbin/restorecon',
	getenforce: '/usr/sbin/getenforce',
	stat: '/usr/bin/stat',
	ps: '/usr/bin/ps',
	'firewall-cmd': '/usr/bin/firewall-cmd',
	ufw: '/usr/sbin/ufw',
	uname: '/usr/bin/uname',
	unzip: '/usr/bin/unzip',
	chown: '/usr/bin/chown',
	rm: '/usr/bin/rm',
	install: '/usr/bin/install',
	cmp: '/usr/bin/cmp',
	setpriv: '/usr/bin/setpriv',
	find: '/usr/bin/find',
	grep: '/usr/bin/grep',
	test: '/usr/bin/test',
} as const;

const APT_BINARIES = {
	...SHARED_BINARIES,
	'apt-get': '/usr/bin/apt-get',
	'dpkg-query': '/usr/bin/dpkg-query',
	'apache-query': '/usr/sbin/apache2ctl',
	a2ensite: '/usr/sbin/a2ensite',
	a2dissite: '/usr/sbin/a2dissite',
	pg_lsclusters: '/usr/bin/pg_lsclusters',
} as const;

const APT_PACKAGES: RowPackages = Object.freeze({
	base: Object.freeze([
		'git',
		'unzip',
		'gzip',
		'file',
		'ca-certificates',
		'curl',
		'rsync',
		'diffutils',
		'postgresql-18',
		'postgresql-client-18',
		'ffmpeg',
		'imagemagick',
		'poppler-utils',
		'ocrmypdf',
		'librsvg2-bin',
	]),
	certbot: Object.freeze(['certbot']),
	localCa: Object.freeze(['openssl']),
	optional: Object.freeze([]),
	selinuxTools: Object.freeze([]),
	ocrLangpacks: Object.freeze({ lane: 'base', packageOf: debianTesseractPackage }),
});

/** Debian-layout web servers (nginx conf.d; Apache sites-available + a2ensite). */
const APT_WEB: OsRow['web'] = Object.freeze({
	nginx: Object.freeze({
		package: Object.freeze(['nginx']),
		service: 'nginx',
		user: 'www-data',
		binary: 'nginx',
		sitePath: '/etc/nginx/conf.d/dedalo-<i>.conf',
		enableWithA2ensite: false,
		logDir: '/var/log/nginx',
		packageDefault: Object.freeze({ port: '80', file: '/etc/nginx/sites-enabled/default' }),
	}),
	apache: Object.freeze({
		package: Object.freeze(['apache2']),
		service: 'apache2',
		user: 'www-data',
		binary: 'apachectl',
		sitePath: '/etc/apache2/sites-available/dedalo-<i>.conf',
		enableWithA2ensite: true,
		logDir: '/var/log/apache2',
	}),
});

const PG18_APT = '/usr/lib/postgresql/18/bin';

export const OS_ROWS: readonly OsRow[] = Object.freeze([
	Object.freeze({
		id: 'ubuntu2604',
		label: 'Ubuntu 26.04 LTS',
		tool: 'apt',
		ids: Object.freeze(['ubuntu']),
		versionMajor: '26.04',
		binaries: Object.freeze(APT_BINARIES),
		pgBinDir: PG18_APT,
		pgService: 'postgresql.service',
		// 26.04 ships PostgreSQL 18 itself: no third-party repository (A10).
		pgFromPgdg: false,
		web: APT_WEB,
		packages: APT_PACKAGES,
		certbotTimer: 'certbot.timer',
		selinux: false,
	} satisfies OsRow),
	Object.freeze({
		id: 'debian13',
		label: 'Debian 13 (trixie)',
		tool: 'apt',
		ids: Object.freeze(['debian']),
		versionMajor: '13',
		binaries: Object.freeze(APT_BINARIES),
		pgBinDir: PG18_APT,
		pgService: 'postgresql.service',
		pgFromPgdg: true,
		web: APT_WEB,
		packages: APT_PACKAGES,
		certbotTimer: 'certbot.timer',
		selinux: false,
	} satisfies OsRow),
	Object.freeze({
		id: 'el10',
		label: 'RHEL / Rocky Linux / AlmaLinux 10',
		tool: 'dnf',
		ids: Object.freeze(['rhel', 'rocky', 'almalinux']),
		versionMajor: '10',
		binaries: Object.freeze({
			...SHARED_BINARIES,
			dnf: '/usr/bin/dnf',
			rpm: '/usr/bin/rpm',
			'apache-query': '/usr/sbin/httpd',
			crb: '/usr/bin/crb',
			pg_setup: '/usr/pgsql-18/bin/postgresql-18-setup',
		}),
		pgBinDir: '/usr/pgsql-18/bin',
		pgService: 'postgresql-18.service',
		pgFromPgdg: true,
		web: Object.freeze({
			nginx: Object.freeze({
				package: Object.freeze(['nginx']),
				service: 'nginx',
				user: 'nginx',
				binary: 'nginx',
				sitePath: '/etc/nginx/conf.d/dedalo-<i>.conf',
				enableWithA2ensite: false,
				logDir: '/var/log/nginx',
			}),
			apache: Object.freeze({
				package: Object.freeze(['httpd', 'mod_ssl', 'mod_http2']),
				service: 'httpd',
				user: 'apache',
				binary: 'apachectl',
				sitePath: '/etc/httpd/conf.d/dedalo-<i>.conf',
				enableWithA2ensite: false,
				logDir: '/var/log/httpd',
			}),
		}),
		packages: Object.freeze({
			base: Object.freeze([
				'git',
				'unzip',
				'gzip',
				'file',
				'ca-certificates',
				'curl',
				'tar',
				'rsync',
				'diffutils',
				'postgresql18-server',
				'postgresql18',
				'postgresql18-contrib',
				'ffmpeg',
				'ImageMagick',
				'poppler-utils',
				'librsvg2-tools',
			]),
			certbot: Object.freeze(['certbot']),
			localCa: Object.freeze(['openssl']),
			// Not in EPEL 10 at every point release (campaign 2 L28): warned, never fatal.
			optional: Object.freeze(['ocrmypdf']),
			selinuxTools: Object.freeze(['policycoreutils-python-utils']),
			ocrLangpacks: Object.freeze({ lane: 'optional', packageOf: rhelTesseractPackage }),
		}),
		certbotTimer: 'certbot-renew.timer',
		selinux: true,
	} satisfies OsRow),
]);

/** The absolute path of `name` on `row` — a binary the row does not have is a programming error. */
export function binaryOf(row: OsRow, name: Binary): string {
	const path = row.binaries[name];
	if (path === undefined) hostRefuse('install.step_failed', `host steps: ${row.id} has no ${name}`);
	return path as string;
}

/** The supported list, in words (the System check's refusal names it). */
export function supportedOsList(): string {
	return OS_ROWS.map((row) => row.label).join(', ');
}

/**
 * THE refusal of an unsupported system — host_preflight's, the System check's
 * row, the identity probe's and docs/install/troubleshooting.md's, word for
 * word (campaign 3 C3-61): the system named, the list, "(newest releases only)".
 */
export function unsupportedOsSentence(osName: string): string {
	return `${osName} is not supported — the production route supports ${supportedOsList()} (newest releases only)`;
}

/** The row of an os-release, or null (refused: not a supported system). */
export function osRowOf(os: OsRelease): OsRow | null {
	const major = os.versionId.split('.')[0] ?? '';
	return (
		OS_ROWS.find(
			(row) =>
				row.ids.includes(os.id) &&
				(row.versionMajor === os.versionId || row.versionMajor === major),
		) ?? null
	);
}

/** The row by id (a frozen fact names it). */
export function osRowById(id: OsRowId): OsRow {
	return OS_ROWS.find((row) => row.id === id) as OsRow;
}

/** THE nginx floor: `http2 on;` exists from 1.25.1 (campaign S1 #2) — no fallback form. */
export const NGINX_MIN_VERSION = '1.25.1';

/** `nginx -v`'s banner → its version, or null. */
export function nginxVersionOf(banner: string): string | null {
	return /nginx\/(\d+\.\d+\.\d+)/.exec(banner)?.[1] ?? null;
}

/** a >= b over dotted numeric versions. */
export function versionAtLeast(a: string, b: string): boolean {
	const left = a.split('.').map(Number);
	const right = b.split('.').map(Number);
	for (let index = 0; index < Math.max(left.length, right.length); index++) {
		const diff = (left[index] ?? 0) - (right[index] ?? 0);
		if (diff !== 0) return diff > 0;
	}
	return true;
}
