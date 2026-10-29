/**
 * THE SCRATCH HOST OF THE HOST-STEP GATES (terminal installer phase 4,
 * 2026-10-12) — everything a gate needs to run the PRODUCTION host steps
 * (src/core/install/host/) end to end without a machine: a fake host's files
 * (os-release, passwd, the cached Bun zip, the institution's certificate), a
 * fake SOURCE tree (the real deploy/ templates and scripts, a .bun-sha256 that
 * vouches for the fake zip), and the RECORDING RUNNER's response table — what
 * apt/dnf, systemctl, psql, certbot, curl… answer on that host, each command's
 * effect visible to the verifies that follow it (`after` / `creates`).
 *
 * Variants: every supported OS row × nginx|apache × letsencrypt|files
 * (os_support.ts). The responses are the REAL commands' argv prefixes: a step
 * that changes what it runs stops matching and its verify goes red, which is
 * the point.
 *
 * WRITES NOTHING (the test_db_marker law: helpers return bytes, gates write):
 * every function answers paths → contents; the gate plants them in its own
 * mkdtemp root (marked `.dedalo_install_scratch`, host/scratch.ts) and removes
 * it. The certificate is minted IN MEMORY by the openssl CLI (key and
 * certificate on stdout — no file).
 *
 * Users: install_host_steps_native, install_host_resume_drill,
 * install_host_render_tripwire, install_host_privilege_tripwire,
 * install_host_selinux_native, install_stack_steps_native.
 */

import { afterAll } from 'bun:test';
import { createHash } from 'node:crypto';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { HostPlanCtx } from '../../src/core/install/host/contract.ts';
import { type HostFacts, pendingFacts } from '../../src/core/install/host/facts.ts';
import { hostFs } from '../../src/core/install/host/fs.ts';
import {
	executeHostInstall,
	type HostExecutorOutcome,
	type HostExecutorRequest,
} from '../../src/core/install/host/host_executor.ts';
import { instancePaths } from '../../src/core/install/host/layout.ts';
import { OS_ROWS, type OsRowId, osRowById } from '../../src/core/install/host/os_support.ts';
import { fcontextEscape } from '../../src/core/install/host/production/selinux.ts';
import {
	type CommandRunner,
	type RecordedRequest,
	type RecordedResponse,
	scratchRunner,
} from '../../src/core/install/host/runner.ts';
import { pendingStackFacts, type StackFacts } from '../../src/core/install/host/stack/facts.ts';
import { IMAGE_BUILDER } from '../../src/core/install/host/stack/image.ts';
import { stackPlanFacts } from '../../src/core/install/host/stack/preflight.ts';
import { ROOT_RUN_SCRIPTS } from '../../src/core/install/host/systemd/render.ts';
import { buildInstallPlan, type InstallPlan } from '../../src/core/install/install_plan.ts';
import type { RunIo } from '../../src/core/install/run_events.ts';
import { buildPlanFile, type PlanFile, type Secrets } from '../../src/core/install/run_files.ts';

export const REPO_ROOT = join(import.meta.dir, '..', '..');

// The scratch parents are made by mkdir, so their mode follows the developer's umask,
// and the ancestor guard refuses a group- or world-writable parent (identity_rules
// ancestorRule). A umask of 002 (common on Linux hosts) refused every host gate on the
// VM: the gates measure the code, not the shell, so the umask is pinned for this file.
const previousUmask = process.umask(0o022);
afterAll(() => {
	process.umask(previousUmask);
});

/** The marker a scratch root must carry (host/scratch.ts SCRATCH_MARKER). */
export const SCRATCH_DIR = '.dedalo_install_scratch';

/**
 * Plant a directory (or file) on a scratch root with an OWNER and a mode: the
 * owner goes to the root's owners sidecar (`<marker>/owners.json` — how a
 * scratch HostFs reports owners; host/fs.ts), the mode to the real path.
 */
export function plantOwned(
	root: string,
	path: string,
	owner: { owner: string; group: string; mode: number; content?: string },
): void {
	const real = join(root, path);
	if (owner.content === undefined) mkdirSync(real, { recursive: true });
	else {
		mkdirSync(dirname(real), { recursive: true });
		writeFileSync(real, owner.content);
	}
	chmodSync(real, owner.mode);
	mkdirSync(join(root, SCRATCH_DIR), { recursive: true });
	const file = join(root, SCRATCH_DIR, 'owners.json');
	const book = existsSync(file)
		? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>)
		: {};
	book[path] = `${owner.owner}:${owner.group}`;
	writeFileSync(file, `${JSON.stringify(book, null, '\t')}\n`, { mode: 0o600 });
}

/** The instance every scratch production install creates. */
export const INSTANCE = 'demo';
export const SERVER_NAME = 'demo.example.org';
export const ROOT_PASSWORD = 'Mosaic-Kestrel-Harbor-47';
export const SECRETS: Secrets = Object.freeze({ root_password: ROOT_PASSWORD });

/**
 * The service account and install folder a scratch host answers for (owner
 * decisions 2026-10-12). `existing` = the account is on the host BEFORE the
 * install (a hosting account used as it is: `getent` answers it from the
 * start, never removed); otherwise it answers only between `useradd` and
 * `userdel` (the installer creates it). The ONE fake account table the host
 * gates share (install_host_identity_native, the steps/resume/selinux gates).
 */
export interface ScratchIdentity {
	user: string;
	group: string;
	dir: string;
	uid: number;
	gid: number;
	shell: string;
	existing: boolean;
	/** The group is on the host before the install (default: `existing`). */
	groupExisting?: boolean;
	/** The account's home in passwd (default: the install folder). */
	home?: string;
	/** The existing account's supplementary groups (`id -G` beyond its own). */
	extraGroups?: readonly { name: string; gid: number }[];
}

/** The default layout: a new system account ded_<i> in /home/ded_<i>. */
export const DEFAULT_IDENTITY: ScratchIdentity = Object.freeze({
	user: `ded_${INSTANCE}`,
	group: `ded_${INSTANCE}`,
	dir: `/home/ded_${INSTANCE}`,
	uid: 999,
	gid: 999,
	shell: '/usr/sbin/nologin',
	existing: false,
});

/** `runuser` as the service account (execute.ts effectiveArgv's prefix). */
export function asService(identity: ScratchIdentity = DEFAULT_IDENTITY): string {
	return `/usr/sbin/runuser -u ${identity.user} -g ${identity.group} --`;
}

/** `runuser` as the service account, HOME set on argv (a command with `env.HOME`: runuser resets it). */
export function asServiceHome(identity: ScratchIdentity = DEFAULT_IDENTITY): string {
	return `${asService(identity)} /usr/bin/env HOME=${identity.dir}`;
}

/** `setpriv --pdeathsig KILL --` (execute.ts deathPrefix — campaign 3 C3-29). */
export const DIES_WITH_PARENT = '/usr/bin/setpriv --pdeathsig KILL --';

/** asServiceHome for a command that dies with the installer: the death prefix at both ends of runuser. */
export function asServiceHomeDying(identity: ScratchIdentity = DEFAULT_IDENTITY): string {
	return `${DIES_WITH_PARENT} ${asService(identity)} ${DIES_WITH_PARENT} /usr/bin/env HOME=${identity.dir}`;
}

/** The bytes of the fake Bun zip (the fake .bun-sha256 vouches for exactly these). */
export const FAKE_BUN_ZIP = 'fake bun zip bytes — never executed\n';

/** The Bun pin of THIS checkout (the fake source repeats it). */
export const BUN_PIN = readFileSync(join(REPO_ROOT, '.bun-version'), 'utf8').trim();

export type WebKind = 'nginx' | 'apache';
export type TlsKind = 'letsencrypt' | 'files' | 'local_ca';

export interface HostVariant {
	os: OsRowId;
	web: WebKind;
	tls: TlsKind;
}

/** Every production variant the gates run: OS row × web server × certificate. */
export const HOST_VARIANTS: readonly HostVariant[] = Object.freeze(
	OS_ROWS.flatMap((row) =>
		(['nginx', 'apache'] as const).flatMap((web) =>
			(['letsencrypt', 'files'] as const).map((tls) => ({ os: row.id, web, tls })),
		),
	),
);

/**
 * The LOCAL-CA variants (owner decision 2026-10-16: local_ca on production):
 * every supported row × nginx|apache. Kept beside HOST_VARIANTS, not in it —
 * the matrix gates count that one; the local-CA gates run these.
 */
export const LOCAL_CA_VARIANTS: readonly HostVariant[] = Object.freeze(
	OS_ROWS.flatMap((row) =>
		(['nginx', 'apache'] as const).map((web) => ({ os: row.id, web, tls: 'local_ca' as const })),
	),
);

/**
 * The extra addresses a scratch local-CA install names: two LAN names. Names
 * only, so these variants keep the catch-all without claims; the claimed IPv4
 * addresses (owner 2026-10-16) have their own gate:
 * test/unit/install_host_ip_claims_native.test.ts.
 */
export const LOCAL_CA_EXTRA_NAMES = 'demo.lan,archivo.museo.lan';

/** The certificate answers of a variant. */
function tlsRaw(variant: HostVariant): Record<string, unknown> {
	if (variant.tls === 'letsencrypt') return { letsencrypt_email: 'ops@example.org' };
	if (variant.tls === 'local_ca')
		return { tls_mode: 'local_ca', tls_extra_names: LOCAL_CA_EXTRA_NAMES };
	return { tls_mode: 'files', tls_cert_path: CERT_PATHS.cert, tls_key_path: CERT_PATHS.key };
}

export function variantName(variant: HostVariant): string {
	return `${variant.os} + ${variant.web} + ${variant.tls}`;
}

/** The institution's certificate files' paths (files mode). */
export const CERT_PATHS = Object.freeze({
	cert: '/etc/ssl/demo/fullchain.pem',
	key: '/etc/ssl/demo/privkey.pem',
});

const OS_RELEASE: Readonly<Record<OsRowId, string>> = Object.freeze({
	ubuntu2604: 'ID=ubuntu\nVERSION_ID="26.04"\nPRETTY_NAME="Ubuntu 26.04 LTS"\n',
	debian13: 'ID=debian\nVERSION_ID="13"\nPRETTY_NAME="Debian GNU/Linux 13 (trixie)"\n',
	el10: 'ID="almalinux"\nID_LIKE="rhel centos fedora"\nVERSION_ID="10.1"\nPRETTY_NAME="AlmaLinux 10.1"\n',
});

/** An os-release of a system NO row supports (the refusal's input). */
export const UNSUPPORTED_OS_RELEASE =
	'ID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04.3 LTS"\n';

// ── the plan ─────────────────────────────────────────────────────────────────

/** The production answers of a variant (instance `demo`). */
export function productionRaw(
	variant: HostVariant,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		route: 'production',
		instance: INSTANCE,
		entity: 'demo',
		server_name: SERVER_NAME,
		web_server: variant.web,
		langs: ['lg-eng'],
		app_lang_default: 'lg-eng',
		data_lang_default: 'lg-eng',
		hierarchies: [],
		...tlsRaw(variant),
		...extra,
	};
}

/** The validated plan and its plan file (the root password supplied, like a fresh run). */
export function productionPlan(
	variant: HostVariant,
	extra: Record<string, unknown> = {},
): { plan: InstallPlan; planFile: PlanFile } {
	const plan = buildInstallPlan(productionRaw(variant, extra), {
		rootPassword: ROOT_PASSWORD,
		requireRootPassword: true,
	});
	if (plan.errors.length > 0) throw new Error(`scratch plan refused: ${plan.errors.join('; ')}`);
	return { plan, planFile: buildPlanFile(plan, SECRETS) };
}

// ── the fake source tree ─────────────────────────────────────────────────────

/**
 * The installer's systemd unit templates on disk (deploy/systemd/), sorted —
 * the ONE walk of that tree the host-step gates share (census_derivation_tripwire
 * SHARED_LISTERS: a gate imports this, never chooses the root itself).
 */
export function systemdTemplateNames(): string[] {
	return readdirSync(join(REPO_ROOT, 'deploy/systemd')).sort();
}

/**
 * Every FILE under the CALLER's own scratch root (a mkdtemp host the gate
 * built — never a repo directory), absolute, sorted. The one recursive listing
 * of a scratch host the gates share instead of each walking its own.
 */
export function scratchFilePaths(root: string): string[] {
	return readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name))
		.sort();
}

/** The fake source tree: the REAL templates and root-run scripts, a table vouching for the fake zip. */
export function sourceFiles(): Map<string, string> {
	const files = new Map<string, string>();
	for (const name of systemdTemplateNames()) {
		files.set(
			`deploy/systemd/${name}`,
			readFileSync(join(REPO_ROOT, 'deploy/systemd', name), 'utf8'),
		);
	}
	files.set(
		'deploy/selinux/dedalo_engine.cil.tpl',
		readFileSync(join(REPO_ROOT, 'deploy/selinux/dedalo_engine.cil.tpl'), 'utf8'),
	);
	for (const name of ROOT_RUN_SCRIPTS) {
		files.set(`deploy/${name}`, readFileSync(join(REPO_ROOT, 'deploy', name), 'utf8'));
	}
	const sha = createHash('sha256').update(FAKE_BUN_ZIP).digest('hex');
	files.set('.bun-version', `${BUN_PIN}\n`);
	files.set(
		'.bun-sha256',
		[
			`# bun-v${BUN_PIN}`,
			`# signed-by: ${'F'.repeat(40)}`,
			...['bun-linux-aarch64', 'bun-linux-x64-baseline', 'bun-linux-x64'].map(
				(asset) => `${sha}  ${asset}.zip`,
			),
			'',
		].join('\n'),
	);
	return files;
}

// ── the fake host ────────────────────────────────────────────────────────────

/** Paths ending in `/` are directories; everything else a file with its content. */
export type HostFiles = Map<string, string>;

/** The certificate and key, minted in memory by the openssl CLI (nothing on disk). */
export function mintCertificate(
	commonName: string,
	days = 60,
	extraNames: readonly string[] = [],
): { cert: string; key: string } {
	const openssl = Bun.which('openssl');
	if (openssl === null) throw new Error('openssl is not on PATH (the CI image ships it)');
	const run = Bun.spawnSync(
		[
			openssl,
			'req',
			'-x509',
			'-newkey',
			'ec',
			'-pkeyopt',
			'ec_paramgen_curve:P-256',
			'-nodes',
			'-keyout',
			'-',
			'-out',
			'-',
			'-subj',
			`/CN=${commonName}`,
			'-addext',
			// The extra names (a local CA leaf's other addresses): DNS, or IP for a dotted quad.
			`subjectAltName=${[commonName, ...extraNames]
				.map((name) => (/^\d+(\.\d+){3}$/.test(name) ? `IP:${name}` : `DNS:${name}`))
				.join(',')}`,
			'-days',
			String(days),
		],
		{ stdout: 'pipe', stderr: 'pipe' },
	);
	if (run.exitCode !== 0) throw new Error(`openssl failed: ${run.stderr.toString()}`);
	const text = run.stdout.toString();
	const key = /-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----\n/.exec(text)?.[0];
	const cert = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----\n/.exec(text)?.[0];
	if (key === undefined || cert === undefined) throw new Error('openssl printed no key/cert');
	return { cert, key };
}

/** The targeted policy's path equivalences on EL 10 (measured, almalinux:10 — `/var/run /run`: campaign 3 C3-3). */
export const EL10_SUBS_DIST_PATH = '/etc/selinux/targeted/contexts/files/file_contexts.subs_dist';
export const EL10_SUBS_DIST = '/var/run /run\n/var/lock /run/lock\n';

/** The system CA bundle curl reads on a row (tls_trust.ts SYSTEM_CA_BUNDLES). */
export function systemCaBundle(os: OsRowId): string {
	return os === 'el10'
		? '/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem'
		: '/etc/ssl/certs/ca-certificates.crt';
}

/** The asset the scratch CPU (x86_64 with AVX2) selects. */
export const SCRATCH_ASSET = 'bun-linux-x64.zip';

/**
 * A supported, EMPTY host of `variant` (nothing of Dédalo on it): its os-release,
 * accounts, CPU, systemd, the bootstrap's verified Bun zip, SELinux on EL, and
 * (files mode) the institution's certificate.
 */
export function hostFiles(
	variant: HostVariant,
	certificate: { cert: string; key: string } | null = null,
): HostFiles {
	const files: HostFiles = new Map([
		['/etc/os-release', OS_RELEASE[variant.os]],
		[
			'/etc/passwd',
			'root:x:0:0:root:/root:/bin/bash\npostgres:x:120:120::/var/lib/postgresql:/bin/sh\n',
		],
		['/etc/group', 'root:x:0:\npostgres:x:120:\n'],
		['/proc/cpuinfo', 'processor : 0\nflags : fpu sse sse2 avx avx2\n'],
		['/run/systemd/system/', ''],
		[`/var/lib/dedalo-install/bun/${BUN_PIN}/${SCRATCH_ASSET}`, FAKE_BUN_ZIP],
	]);
	if (variant.os === 'el10') {
		files.set('/usr/sbin/getenforce', '');
		files.set(EL10_SUBS_DIST_PATH, EL10_SUBS_DIST);
	}
	if (variant.tls === 'files' && certificate !== null) {
		files.set(CERT_PATHS.cert, certificate.cert);
		files.set(CERT_PATHS.key, certificate.key);
		// The host TRUSTS the institution's chain (its CA in the system bundle — campaign 3 C3-13).
		files.set(systemCaBundle(variant.os), certificate.cert);
	}
	return files;
}

// ── what the host's commands answer ──────────────────────────────────────────

/** The packages the row installs (all of them answer `installed` after the transaction). */
function installedAfter(variant: HostVariant): RecordedResponse[] {
	const row = osRowById(variant.os);
	const web = row.web[variant.web].package;
	const names = [
		...row.packages.base,
		...web,
		...row.packages.certbot,
		...row.packages.localCa,
		...row.packages.selinuxTools,
		...row.packages.optional,
	];
	if (row.tool === 'apt') {
		return [
			{
				match: '/usr/bin/dpkg-query -W',
				after: '/usr/bin/apt-get install -y --no-install-recommends git',
				stdout: names.map((name) => `${name} ii `).join('\n'),
			},
			{ match: '/usr/bin/dpkg-query -W', stdout: '' },
		];
	}
	return [
		{ match: '/usr/bin/rpm -qa', after: '/usr/bin/dnf install -y git', stdout: names.join('\n') },
		{ match: '/usr/bin/rpm -qa', stdout: '' },
		{
			match: '/usr/bin/test -e /var/lib/pgsql/18/data/PG_VERSION',
			after: '/usr/pgsql-18/bin/postgresql-18-setup initdb',
		},
		{ match: '/usr/bin/test -e /var/lib/pgsql/18/data/PG_VERSION', exit: 1 },
	];
}

/** The modules a configured Apache lists (`-M`). */
export const APACHE_MODULES_LISTING = ['ssl', 'headers', 'http2', 'rewrite', 'proxy', 'proxy_http']
	.map((name) => ` ${name}_module (shared)`)
	.join('\n');

/**
 * The answers of the web server once it is installed. Apache is asked through
 * the row's query binary — EL 10's apachectl REFUSES `-M`/`-S` (measured on
 * almalinux:10), so it answers exactly that here; Debian's a2ensite refuses a
 * site whose file is not written yet (measured on debian:13).
 */
function webAnswers(variant: HostVariant, identity: ScratchIdentity): RecordedResponse[] {
	const row = osRowById(variant.os);
	const user = row.web[variant.web].user;
	const site = row.web.apache.sitePath.replace('<i>', INSTANCE);
	const rules = `/etc/nginx/dedalo/${INSTANCE}`;
	return [
		{
			match: '/usr/sbin/apachectl -M',
			exit: 2,
			stderr: 'apachectl: The "-M" option is not supported.',
		},
		{ match: `${row.binaries['apache-query']} -M`, stdout: APACHE_MODULES_LISTING },
		{ match: `/usr/sbin/a2ensite dedalo-${INSTANCE}`, whenPath: site },
		{
			match: `/usr/sbin/a2ensite dedalo-${INSTANCE}`,
			exit: 1,
			stderr: `ERROR: Site dedalo-${INSTANCE} does not exist!`,
		},
		{
			match: `/opt/dedalo/instances/${INSTANCE}/bin/dedalo-media-rules.sh --source`,
			creates: [
				{ path: `${rules}/media_protection.conf`, content: '# validated copy\n' },
				{ path: `${rules}/media_protection_map.conf`, content: '# config-hash: scratch\n' },
			],
		},
		...groupAnswers(identity, user),
	];
}

/** `getent group` of the service group: the web user a member once usermod ran. */
function groupAnswers(identity: ScratchIdentity, webUser: string): RecordedResponse[] {
	const { group, gid } = identity;
	const exact = `/usr/bin/getent group ${group}`;
	const there = identity.groupExisting ?? identity.existing;
	const creator =
		group === identity.user && !identity.existing ? '/usr/sbin/useradd' : '/usr/sbin/groupadd';
	const created = there ? {} : { after: creator };
	return [
		{ match: exact, after: '/usr/sbin/usermod -aG', stdout: `${group}:x:${gid}:${webUser}\n` },
		{ match: exact, ...created, stdout: `${group}:x:${gid}:\n` },
		{ match: exact, exit: 2 },
	];
}

/** The account's passwd line. */
function passwdLine(identity: ScratchIdentity): string {
	const { user, uid, gid, shell } = identity;
	return `${user}:x:${uid}:${gid}::${identity.home ?? identity.dir}:${shell}\n`;
}

/** `getent passwd` / `id` of the service user (see ScratchIdentity). */
function accountAnswers(identity: ScratchIdentity): RecordedResponse[] {
	const line = passwdLine(identity);
	const { user, group, gid } = identity;
	const lifetime = identity.existing
		? {}
		: { after: '/usr/sbin/useradd', until: '/usr/sbin/userdel' };
	const extra = identity.extraGroups ?? [];
	return [
		{ match: `/usr/bin/getent passwd ${user}`, ...lifetime, stdout: line },
		{ match: `/usr/bin/getent passwd ${user}`, exit: 2 },
		{ match: `/usr/bin/getent group ${gid}`, ...lifetime, stdout: `${group}:x:${gid}:\n` },
		{
			match: `/usr/bin/id -Gn ${user}`,
			stdout: `${[group, ...extra.map((g) => g.name)].join(' ')}\n`,
		},
		{ match: `/usr/bin/id -G ${user}`, stdout: `${[gid, ...extra.map((g) => g.gid)].join(' ')}\n` },
	];
}

/** The pinned runtime's host path (layout.ts). */
const BUN_PATH = `/opt/dedalo/bun/${BUN_PIN}/bun`;

/** SELinux on EL: the local rules and the module, once added. */
function selinuxAnswers(variant: HostVariant, identity: ScratchIdentity): RecordedResponse[] {
	if (variant.os !== 'el10') return [];
	const specs = [
		`/run/dedalo-${INSTANCE}(/.*)?`,
		`/srv/dedalo/${INSTANCE}(/.*)?`,
		...(variant.tls === 'letsencrypt' ? [`/var/lib/dedalo-install/acme/${INSTANCE}(/.*)?`] : []),
		...(variant.tls === 'local_ca' ? [`${fcontextEscape(LOCAL_CA_DIR)}(/.*)?`] : []),
		fcontextEscape(identity.dir),
		...['dedalo', 'private', 'backups'].map(
			(name) => `${fcontextEscape(`${identity.dir}/${name}`)}(/.*)?`,
		),
	];
	return [
		{ match: '/usr/sbin/getenforce', stdout: 'Enforcing\n' },
		{
			match: '/usr/sbin/semanage fcontext -l -C',
			after: '/usr/sbin/semanage fcontext -a',
			until: '/usr/sbin/semanage fcontext -d',
			stdout: specs.map((spec) => `${spec}  all files  system_u:object_r:x:s0`).join('\n'),
		},
		{ match: '/usr/sbin/semanage fcontext -l -C', stdout: '' },
		{
			match: '/usr/sbin/semodule -l',
			after: '/usr/sbin/semodule -X 400 -i',
			until: '/usr/sbin/semodule -X 400 -r',
			stdout: 'dedalo_engine\n',
		},
		{ match: '/usr/sbin/semodule -l', stdout: '' },
		// The runtime's label: the directory's type until the loaded module's filecon is applied.
		{
			match: `/usr/bin/stat -c %C ${BUN_PATH}`,
			after: `/usr/sbin/restorecon -F ${BUN_PATH}`,
			stdout: 'system_u:object_r:dedalo_engine_exec_t:s0\n',
		},
		{ match: `/usr/bin/stat -c %C ${BUN_PATH}`, stdout: 'system_u:object_r:usr_t:s0\n' },
		// The started engine: in its own domain once systemd ran the relabelled runtime.
		{
			match: `/usr/bin/systemctl show -p MainPID --value dedalo-ts@${INSTANCE}.service`,
			after: `/usr/bin/systemctl start dedalo-ts@${INSTANCE}.service`,
			stdout: '4242\n',
		},
		{
			match: '/usr/bin/ps -o label= -p 4242',
			after: `/usr/sbin/restorecon -F ${BUN_PATH}`,
			stdout: 'system_u:system_r:dedalo_engine_t:s0\n',
		},
		{
			match: '/usr/bin/ps -o label= -p 4242',
			stdout: 'system_u:system_r:unconfined_service_t:s0\n',
		},
	];
}

/** PostgreSQL: the facts' counts, the "exists" probes, peer reach, the extensions. */
function databaseAnswers(variant: HostVariant, identity: ScratchIdentity): RecordedResponse[] {
	const pg = osRowById(variant.os).pgBinDir;
	const psql = `${pg}/psql -X -q -A -t -v ON_ERROR_STOP=1 -h /var/run/postgresql -p 5432`;
	return [
		{ match: `/usr/sbin/runuser -u postgres -- ${pg}/psql -XAtq`, stdout: '0 0\n' },
		{
			// The instance reaches its database by peer once the role and the database were
			// CREATED (psql's CREATE travels on stdin: the bare `-d postgres` argv, exactly).
			match: `${asService(identity)} ${psql} -d dedalo_${INSTANCE} -c SELECT 1`,
			afterExact: `/usr/sbin/runuser -u postgres -- ${psql} -d postgres`,
			stdout: '1\n',
		},
		{
			match: `${asService(identity)} ${psql} -d dedalo_${INSTANCE} -c SELECT 1`,
			exit: 2,
			stderr: 'FATAL: role does not exist',
		},
		{
			match: `/usr/sbin/runuser -u postgres -- ${psql} -d postgres -c SELECT count(*) FROM pg_available_extensions`,
			stdout: '3\n',
		},
		// PUBLIC's reach: revoked once the database was made (the REVOKE travels on stdin too).
		{
			match: `/usr/sbin/runuser -u postgres -- ${psql} -d postgres -c SELECT has_database_privilege('public'`,
			afterExact: `/usr/sbin/runuser -u postgres -- ${psql} -d postgres`,
			stdout: 'f\n',
		},
		{
			match: `/usr/sbin/runuser -u postgres -- ${psql} -d postgres -c SELECT has_database_privilege('public'`,
			stdout: 't\n',
		},
		{
			match: `/usr/sbin/runuser -u postgres -- ${psql} -d postgres -c SELECT 1 / count(*)`,
			exit: 1,
		},
		{
			match: `/usr/sbin/runuser -u postgres -- ${psql} -d dedalo_${INSTANCE} -c SELECT count(*)`,
			stdout: '0\n',
		},
	];
}

/** The engine child (as the instance user): its record, its run, its migrations. */
function engineAnswers(identity: ScratchIdentity): RecordedResponse[] {
	const bun = `/opt/dedalo/bun/${BUN_PIN}/bun`;
	const child = `${asServiceHome(identity)} ${bun} run ${identity.dir}/dedalo/scripts/install.ts`;
	const dying = `${asServiceHomeDying(identity)} ${bun} run ${identity.dir}/dedalo/scripts/install.ts`;
	return [
		{
			match: `${child} --status --json`,
			after: `${dying} --request-stdin`,
			until: `${dying} --abort`,
			stdout:
				'{"exists":true,"outcome":"complete","failed_step":null,"needs":[],"salt_generated":true,"running":null}\n',
		},
		{
			match: `${child} --status --json`,
			stdout: '{"exists":false,"outcome":null,"failed_step":null}\n',
		},
		// The salt read back as the instance (C3-18): what the end of the run shows once.
		{
			match: `${asService(identity)} /usr/bin/grep -m 1 ^DEDALO_SALT_STRING= ${identity.dir}/private/.env`,
			stdout: 'DEDALO_SALT_STRING=scratch-salt-value\n',
		},
		{
			match: `${dying} --request-stdin`,
			stdout: [
				'{"event":"log","line":"engine steps: seed, ontologies, root"}',
				'{"event":"show_once","lines":["  generated DEDALO_SALT_STRING = scratch-salt-value"]}',
				'',
			].join('\n'),
		},
		{
			match: `${asServiceHome(identity)} ${bun} run scripts/ops/boot_status.ts --json`,
			stdout: '{"applied":13,"pending":[]}\n',
		},
		{ match: `${bun} --version`, after: '/usr/bin/install -D -m 0755', stdout: `${BUN_PIN}\n` },
		{ match: `${bun} --version`, exit: 127 },
	];
}

/** The release extracted, its dependencies installed. */
function runtimeAnswers(identity: ScratchIdentity): RecordedResponse[] {
	const tree = `${identity.dir}/dedalo`;
	return [
		{
			match: `${asService(identity)} /usr/bin/tar -xf`,
			creates: [`${tree}/package.json`, `${tree}/scripts/`],
		},
		{
			match: `${asServiceHome(identity)} /opt/dedalo/bun/${BUN_PIN}/bun install`,
			creates: [`${tree}/node_modules/`],
		},
		{ match: `/usr/bin/test -s /var/lib/dedalo-install/bun/${BUN_PIN}/` },
		// No runtime at the pin yet (cmp: 2 = a file is missing) — a host where another
		// instance runs the same pin answers 0 (identical: not reinstalled).
		{ match: '/usr/bin/cmp -s', exit: 2 },
	];
}

/** Let's Encrypt: the certificate exists once certbot ran. */
function certbotAnswers(): RecordedResponse[] {
	const live = `/etc/letsencrypt/live/dedalo-${INSTANCE}/fullchain.pem`;
	return [
		{ match: `/usr/bin/test -s ${live}`, after: '/usr/bin/certbot certonly' },
		{ match: `/usr/bin/test -s ${live}`, exit: 1 },
		{ match: '/usr/bin/certbot certonly', creates: [{ path: live, content: 'issued\n' }] },
	];
}

/** The local CA's certificate directory of the scratch instance (layout.ts tlsDir). */
export const LOCAL_CA_DIR = `/opt/dedalo/instances/${INSTANCE}/tls`;

/** The scratch authority every local-CA run "issues" (a real certificate: its fingerprint is told). */
let scratchAuthority: { cert: string; key: string } | null = null;
export function localCaScratchAuthority(): { cert: string; key: string } {
	scratchAuthority ??= mintCertificate('Dedalo local CA scratch', 3650);
	return scratchAuthority;
}

/**
 * The local CA: what the generator leaves (deploy/dedalo-tls-rotate.sh — its
 * real behaviour is tls_local_ca_native's and install_host_local_ca_native's:
 * here only its files, keys 0600), the issue probe, the renewal timer enabled.
 */
function localCaAnswers(variant: HostVariant): RecordedResponse[] {
	if (variant.tls !== 'local_ca') return [];
	const generator = `/opt/dedalo/instances/${INSTANCE}/bin/dedalo-tls-rotate.sh --mode local-ca`;
	const authority = localCaScratchAuthority();
	const timer = `dedalo-tls-renew@${INSTANCE}.timer`;
	return [
		{
			match: `/usr/bin/test -s ${LOCAL_CA_DIR}/fullchain.pem -a -s ${LOCAL_CA_DIR}/dedalo-local-ca.pem`,
			after: generator,
		},
		{
			match: `/usr/bin/test -s ${LOCAL_CA_DIR}/fullchain.pem -a -s ${LOCAL_CA_DIR}/dedalo-local-ca.pem`,
			exit: 1,
		},
		{
			match: generator,
			creates: [
				{ path: `${LOCAL_CA_DIR}/dedalo-local-ca.pem`, content: authority.cert, mode: 0o644 },
				{ path: `${LOCAL_CA_DIR}/dedalo-issuing-ca.pem`, content: authority.cert, mode: 0o644 },
				{ path: `${LOCAL_CA_DIR}/dedalo-issuing-ca.key`, content: authority.key, mode: 0o600 },
				{ path: `${LOCAL_CA_DIR}/fullchain.pem`, content: authority.cert, mode: 0o644 },
				{ path: `${LOCAL_CA_DIR}/privkey.pem`, content: authority.key, mode: 0o600 },
				{
					path: `${LOCAL_CA_DIR}/dedalo-local-ca.names`,
					content: `${[SERVER_NAME, ...LOCAL_CA_EXTRA_NAMES.split(',')].join('\n')}\n`,
					mode: 0o644,
				},
			],
		},
		{
			match: `/usr/bin/systemctl is-enabled ${timer}`,
			after: `/usr/bin/systemctl enable --now ${timer}`,
			until: `/usr/bin/systemctl disable --now ${timer}`,
		},
		{ match: `/usr/bin/systemctl is-enabled ${timer}`, exit: 1 },
		// The public probe trusts the install's own authority (its file — never the system store).
		{
			match: `/usr/bin/curl -sS -o /dev/null -w %{http_code} --max-time 20 --resolve ${SERVER_NAME}:443:127.0.0.1 --cacert ${LOCAL_CA_DIR}/dedalo-local-ca.pem https://${SERVER_NAME}/health`,
			stdout: '200',
		},
	];
}

/** `systemctl show` of the start stamps: a unit systemd ran / never ran (campaign 3c D1). */
export const UNIT_RAN =
	'ExecMainStartTimestampMonotonic=8123456789\nActiveEnterTimestampMonotonic=8123456790\n';
export const UNIT_NEVER_RAN =
	'ExecMainStartTimestampMonotonic=0\nActiveEnterTimestampMonotonic=0\n';

/** The first boot, the public probes, the first backup. */
function serviceAnswers(identity: ScratchIdentity): RecordedResponse[] {
	const unit = `dedalo-backup@${INSTANCE}.service`;
	return [
		{
			// The engine answers on its socket once its unit was started (and until it is stopped).
			match: '/usr/bin/curl -s -o /dev/null -w %{http_code} --max-time 10 --unix-socket',
			after: `/usr/bin/systemctl start dedalo-ts@${INSTANCE}.service`,
			until: `/usr/bin/systemctl stop dedalo-ts@${INSTANCE}.service`,
			stdout: '200',
		},
		{
			match: '/usr/bin/curl -s -o /dev/null -w %{http_code} --max-time 10 --unix-socket',
			exit: 7,
			stdout: '000',
		},
		// systemd's start stamps: set once the unit ran (a stop keeps them — campaign 3c D1).
		{
			match: `/usr/bin/systemctl show -p ExecMainStartTimestampMonotonic -p ActiveEnterTimestampMonotonic dedalo-ts@${INSTANCE}.service`,
			after: `/usr/bin/systemctl start dedalo-ts@${INSTANCE}.service`,
			stdout: UNIT_RAN,
		},
		{
			match: `/usr/bin/systemctl show -p ExecMainStartTimestampMonotonic -p ActiveEnterTimestampMonotonic dedalo-ts@${INSTANCE}.service`,
			stdout: UNIT_NEVER_RAN,
		},
		{
			match: `/usr/bin/systemctl is-active dedalo-ts-watchdog@${INSTANCE}.timer`,
			after: `/usr/bin/systemctl enable --now dedalo-ts-watchdog@${INSTANCE}.timer`,
			until: `/usr/bin/systemctl disable --now dedalo-ts-watchdog@${INSTANCE}.timer`,
		},
		{ match: `/usr/bin/systemctl is-active dedalo-ts-watchdog@${INSTANCE}.timer`, exit: 3 },
		{
			match: '/usr/bin/curl -sS -o /dev/null -w %{http_code} --max-time 20 --resolve',
			stdout: '404',
		},
		{
			match: `/usr/bin/systemctl start --wait ${unit}`,
			creates: [
				{
					path: `${identity.dir}/backups/state/LAST_OK`,
					content:
						'scratch every store succeeded\n  matrix_db: exit 0\n  media: exit 0\n  private: exit 0\n',
				},
			],
		},
		{
			match: `/usr/bin/systemctl show -p Environment ${unit}`,
			stdout: `Environment=DEDALO_SUPERVISED=true "DEDALO_BACKUP_STATE_DIR=${identity.dir}/backups/state" "DEDALO_BACKUP_EXPECTED_STORES=matrix_db media private"\n`,
		},
	];
}

/**
 * The responses of a supported, empty host of `variant`. First match wins:
 * the specific answers come first; the `/health` probe through the public
 * address answers 200 before the catch-all curl answers 404 (the media gate).
 */
export function hostResponses(
	variant: HostVariant,
	identity: ScratchIdentity = DEFAULT_IDENTITY,
): RecordedResponse[] {
	return [
		{ match: '/usr/bin/id -u', stdout: '0\n' },
		{ match: '/usr/bin/uname -m', stdout: 'x86_64\n' },
		{ match: '/usr/bin/systemctl is-active firewalld', exit: 3 },
		{ match: '/usr/bin/pgrep', exit: 1 },
		...accountAnswers(identity),
		...installedAfter(variant),
		...webAnswers(variant, identity),
		...selinuxAnswers(variant, identity),
		...databaseAnswers(variant, identity),
		...engineAnswers(identity),
		...runtimeAnswers(identity),
		...certbotAnswers(),
		...localCaAnswers(variant),
		{
			match: `/usr/bin/curl -sS -o /dev/null -w %{http_code} --max-time 20 --resolve ${SERVER_NAME}:443:127.0.0.1 https://${SERVER_NAME}/health`,
			stdout: '200',
		},
		...serviceAnswers(identity),
		// The local account scan (the accounts whose primary group is the service group).
		{
			match: '/usr/bin/getent passwd',
			stdout: `root:x:0:0:root:/root:/bin/bash\n${identity.existing ? passwdLine(identity) : ''}`,
		},
	];
}

// ── the pure plan context of a docker / trial plan (the census gates) ────────

/** The stack facts of a scratch operator (docker and cosign present, a big disk). */
export function scratchStackFacts(home = '/home/operator'): StackFacts {
	return {
		...pendingStackFacts(),
		docker: '/usr/bin/docker',
		composeVersion: '2.39.1',
		daemon: true,
		dockerRoot: '/var/lib/docker',
		freeGib: 200,
		cosign: '/usr/local/bin/cosign',
		user: 'operator',
		group: 'operator',
		uid: 1000,
		home,
	};
}

/** A docker/trial plan's PURE context (what every stack command is computed from). */
export function stackPlanCtx(
	raw: Record<string, unknown>,
	source: string = REPO_ROOT,
): HostPlanCtx {
	const plan = buildInstallPlan(raw, { rootPassword: ROOT_PASSWORD, requireRootPassword: true });
	if (plan.errors.length > 0)
		throw new Error(`scratch stack plan refused: ${plan.errors.join('; ')}`);
	// The run's own derivation (sourceIsGit picks stack_image's builder — campaign 3b N1).
	const facts: HostFacts = stackPlanFacts(scratchStackFacts(), source);
	return {
		plan: buildPlanFile(plan, SECRETS),
		answers: plan.answers,
		facts,
		row: OS_ROWS[0] as (typeof OS_ROWS)[number],
		paths: instancePaths(plan.answers, BUN_PIN),
		source,
	};
}

// ── driving the executor over a planted scratch root ─────────────────────────

/** A planted scratch host: its root (marked), the fake source, what the run printed. */
export interface ScratchHost {
	root: string;
	source: string;
}

/** The transcript of one run (the io the executor writes to). */
export interface RunTranscript {
	lines: string[];
	told: string[];
	shown: string[];
}

/** An io that keeps every line (and the one-time display apart). */
export function transcriptIo(transcript: RunTranscript, terminal = true): RunIo {
	return {
		log: (line) => transcript.lines.push(line),
		warn: (line) => transcript.lines.push(line),
		// `terminal: false`: the output is redirected — a one-time line reaches no terminal.
		showOnce: (lines) => {
			if (terminal) transcript.shown.push(...lines);
			return terminal;
		},
		tell: (lines) => transcript.told.push(...lines),
	};
}

/**
 * One executor run over the scratch host — a FRESH runner per run (it reads the
 * earlier runs' log, like a new process) and the root's owners sidecar.
 */
export async function runHost(
	host: ScratchHost,
	request: HostExecutorRequest,
	options: {
		now?: () => number;
		terminal?: boolean;
		/** Wrap the scratch runner (a gate that acts when a command runs — a Ctrl-C at the engine child). */
		wrapRunner?: (runner: CommandRunner) => CommandRunner;
		/** The transcript to write into (a gate reads it even when the run never returns). */
		transcript?: RunTranscript;
	} = {},
): Promise<{ outcome: HostExecutorOutcome; transcript: RunTranscript }> {
	const marker = join(host.root, SCRATCH_DIR);
	const transcript: RunTranscript = options.transcript ?? { lines: [], told: [], shown: [] };
	const io = transcriptIo(transcript, options.terminal ?? true);
	const runner = scratchRunner(marker);
	const outcome = await executeHostInstall(request, io, {
		runner: options.wrapRunner === undefined ? runner : options.wrapRunner(runner),
		fs: hostFs(host.root, join(marker, 'owners.json')),
		source: host.source,
		skipPrivilegeCheck: true,
		sleep: async () => {},
		now: options.now ?? (() => Date.now()),
	});
	return { outcome, transcript };
}

/** Every command the scratch runner logged so far, joined (`argv.join(' ')`), in order. */
export function loggedCommands(root: string): string[] {
	const log = join(root, SCRATCH_DIR, 'argv.log');
	if (!existsSync(log)) return [];
	return readFileSync(log, 'utf8')
		.split('\n')
		.filter((line) => line !== '')
		.map((line) => (JSON.parse(line) as RecordedRequest).argv.join(' '));
}

/** The logged requests themselves (argv, cwd, env, whether stdin was fed). */
export function loggedRequests(root: string): RecordedRequest[] {
	const log = join(root, SCRATCH_DIR, 'argv.log');
	if (!existsSync(log)) return [];
	return readFileSync(log, 'utf8')
		.split('\n')
		.filter((line) => line !== '')
		.map((line) => JSON.parse(line) as RecordedRequest);
}

/** The fresh request of a variant's plan. */
export function freshRequest(planFile: PlanFile): HostExecutorRequest {
	return { mode: 'fresh', execute: true, planFile, secrets: { ...SECRETS } };
}

/** A resume / abort request of a variant's answers. */
export function laterRequest(
	mode: 'resume' | 'abort',
	plan: InstallPlan,
	confirmDatabase?: string,
): HostExecutorRequest {
	return {
		mode,
		execute: true,
		givenAnswers: plan.answers,
		givenKeys: [],
		secrets: { ...SECRETS },
		...(confirmDatabase === undefined ? {} : { confirmDatabase }),
	};
}

/** A production variant's PURE plan context (facts: the row and the web server, nothing measured). */
export function productionPlanCtx(
	variant: HostVariant,
	source: string = REPO_ROOT,
	extra: Record<string, unknown> = {},
): HostPlanCtx {
	const { plan, planFile } = productionPlan(variant, extra);
	const pending = pendingFacts();
	const facts: HostFacts = {
		...pending,
		os: variant.os,
		web: { ...pending.web, kind: variant.web },
	};
	return {
		plan: planFile,
		answers: plan.answers,
		facts,
		row: osRowById(variant.os),
		paths: instancePaths(plan.answers, BUN_PIN),
		source,
	};
}

// ── systemd units, read the way systemd reads them (the render gates) ────────

/** One parsed assignment of a unit file: its section, key and raw value. */
export interface UnitAssignment {
	section: string;
	key: string;
	value: string;
}

/** A unit file's assignments (comments are WHOLE lines starting `#` or `;`; no inline comments). */
export function unitAssignments(text: string): UnitAssignment[] {
	const out: UnitAssignment[] = [];
	let section = '';
	for (const raw of text.split('\n')) {
		const line = raw.trim();
		if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
		const header = /^\[(.+)\]$/.exec(line);
		if (header) {
			section = header[1] as string;
			continue;
		}
		const at = line.indexOf('=');
		if (at > 0) out.push({ section, key: line.slice(0, at), value: line.slice(at + 1) });
	}
	return out;
}

/** The KEYS whose empty assignment RESETS the list (systemd: ExecStart=, Environment=…). */
const LIST_KEYS: ReadonlySet<string> = new Set([
	'ExecStart',
	'Environment',
	'EnvironmentFile',
	'ExecCondition',
	'ExecStartPre',
	'ExecStartPost',
	'Wants',
]);

/**
 * The EFFECTIVE unit: the template, then each drop-in in order — a list key's
 * empty assignment resets it (systemd's rule), any other key's last value wins.
 * What `systemctl cat` shows, as systemd applies it.
 */
export function mergedUnit(template: string, dropins: readonly string[]): Map<string, string[]> {
	const merged = new Map<string, string[]>();
	for (const text of [template, ...dropins]) {
		for (const { section, key, value } of unitAssignments(text)) {
			const name = `${section}.${key}`;
			if (!LIST_KEYS.has(key)) merged.set(name, [value]);
			else if (value === '') merged.set(name, []);
			else merged.set(name, [...(merged.get(name) ?? []), value]);
		}
	}
	return merged;
}

/**
 * systemd's word split of an Environment= value: whitespace-separated, each
 * word optionally "double" or 'single' quoted (the quotes removed, a quoted
 * word keeps its spaces) — `"A=b c" D=e` is two assignments.
 */
export function systemdWords(value: string): string[] {
	const words: string[] = [];
	const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
	for (const match of value.matchAll(pattern)) {
		words.push((match[1] ?? match[2] ?? match[3] ?? '').replace(/\\(.)/g, '$1'));
	}
	return words;
}

/** The effective environment of a merged unit (KEY → value). */
export function unitEnvironment(merged: ReadonlyMap<string, string[]>): Map<string, string> {
	const env = new Map<string, string>();
	for (const value of merged.get('Service.Environment') ?? []) {
		for (const word of systemdWords(value)) {
			const at = word.indexOf('=');
			if (at > 0) env.set(word.slice(0, at), word.slice(at + 1));
		}
	}
	return env;
}

// ── the docker / trial operator's machine ────────────────────────────────────

export const DOCKER = '/usr/bin/docker';
export const COSIGN = '/usr/local/bin/cosign';
/** The digest the scratch registry answers for every pulled image. */
export const IMAGE_DIGEST = `sha256:${'d'.repeat(64)}`;

/** The operator's machine: an account, docker, cosign (absent when asked), `ss` (only when asked). */
export function stackHostFiles(
	options: { docker?: boolean; cosign?: boolean; ss?: boolean } = {},
): HostFiles {
	const files: HostFiles = new Map([
		[
			'/etc/passwd',
			'root:x:0:0:root:/root:/bin/bash\noperator:x:1000:1000::/home/operator:/bin/bash\n',
		],
		['/etc/group', 'root:x:0:\noperator:x:1000:\n'],
	]);
	if (options.docker !== false) files.set(DOCKER, '');
	if (options.cosign !== false) files.set(COSIGN, '');
	if (options.ss === true) files.set('/usr/bin/ss', '');
	return files;
}

/** `docker compose -f <stack> -f compose.override.yaml --env-file .dedalo.env` of a route. */
export function composePrefix(route: 'docker' | 'trial'): string {
	const stack = route === 'trial' ? 'docker-compose.simple.yml' : 'docker-compose.yml';
	return `${DOCKER} compose -f ${stack} -f compose.override.yaml --env-file .dedalo.env`;
}

/** The PortBindings nginx's container declares on a route (trial: HTTP only). */
export function nginxPorts(route: 'docker' | 'trial'): Record<string, unknown[]> {
	const http = { '80/tcp': [{ HostIp: '', HostPort: '80' }] };
	return route === 'trial' ? http : { ...http, '443/tcp': [{ HostIp: '', HostPort: '443' }] };
}

/**
 * What the operator's docker, cosign and curl answer: Compose v2, a daemon, a
 * big disk, an UNRELATED `dedalo_unrelated` volume (an abort must never take
 * it), the pulled image's label `version` and its ONE digest, the engine child
 * (its record complete once its request ran), the stack's health.
 */
export function stackResponses(
	route: 'docker' | 'trial',
	version: string,
	repository: string,
	serverName = 'dedalo.example.org',
): RecordedResponse[] {
	const compose = composePrefix(route);
	const child = `${compose} run --rm --name dedalo-install-engine -T dedalo bun run scripts/install.ts`;
	const status = `${compose} run --rm -T --no-deps dedalo bun run scripts/install.ts --status --json`;
	const health =
		route === 'trial'
			? 'http://127.0.0.1/health'
			: `--resolve ${serverName}:443:127.0.0.1 https://${serverName}/health`;
	return [
		{ match: '/usr/bin/id -un', stdout: 'operator\n' },
		{ match: '/usr/bin/id -gn', stdout: 'operator\n' },
		{ match: '/usr/bin/id -u', stdout: '1000\n' },
		{ match: `${DOCKER} compose version --short`, stdout: '2.39.1\n' },
		{ match: `${DOCKER} info --format`, stdout: '/var/lib/docker\n' },
		{
			match: '/bin/df -Pk /var/lib/docker',
			stdout:
				'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 104857600 1 52428800 1% /\n',
		},
		{ match: `${DOCKER} volume ls --format`, stdout: 'dedalo_unrelated\n' },
		{
			match: `${DOCKER} image inspect --format {{.Id}}`,
			after: `${DOCKER} pull`,
			stdout: 'sha256:abc\n',
		},
		{
			match: `${DOCKER} image inspect --format {{.Id}}`,
			after: `${DOCKER} build`,
			stdout: 'sha256:abc\n',
		},
		// a checkout's build: the shared builder (campaign 3b N1)
		{
			match: `${DOCKER} image inspect --format {{.Id}}`,
			after: `/bin/bash ${join(REPO_ROOT, IMAGE_BUILDER)}`,
			stdout: 'sha256:abc\n',
		},
		{ match: `${DOCKER} image inspect --format {{.Id}}`, exit: 1 },
		{ match: `${DOCKER} image inspect --format {{index .Config.Labels`, stdout: `${version}\n` },
		{
			match: `${DOCKER} image inspect --format {{range .RepoDigests}}`,
			stdout: `${repository}@${IMAGE_DIGEST}\n`,
		},
		{ match: `${COSIGN} verify` },
		{
			match: `${DOCKER} run --rm -v dedalo_letsencrypt:/etc/letsencrypt:ro --entrypoint test`,
			after: `${DOCKER} run --rm -p`,
		},
		{
			match: `${DOCKER} run --rm -v dedalo_letsencrypt:/etc/letsencrypt:ro --entrypoint test`,
			exit: 1,
		},
		{ match: `${compose} exec -T postgres pg_isready`, after: `${compose} up -d postgres` },
		{ match: `${compose} exec -T postgres pg_isready`, exit: 1 },
		{
			match: status,
			after: `${child} --request-stdin`,
			until: `${child} --abort`,
			stdout:
				'{"exists":true,"outcome":"complete","failed_step":null,"needs":[],"salt_generated":true,"running":null}\n',
		},
		// The salt read back in the engine container (C3-18).
		{
			match: `${compose} exec -T dedalo grep -m 1 ^DEDALO_SALT_STRING= /private/.env`,
			stdout: 'DEDALO_SALT_STRING=scratch-stack-salt\n',
		},
		{ match: status, stdout: '{"exists":false,"outcome":null,"failed_step":null}\n' },
		{
			match: `${child} --request-stdin`,
			stdout: [
				'{"event":"log","line":"engine steps inside the container"}',
				'{"event":"show_once","lines":["  generated DEDALO_SALT_STRING = scratch-stack-salt"]}',
				'',
			].join('\n'),
		},
		{ match: `${compose} exec -T dedalo curl`, after: `${compose} up -d dedalo`, stdout: '200' },
		{ match: `${compose} exec -T dedalo curl`, stdout: '000' },
		{ match: `${compose} ps --services --status running`, stdout: 'postgres\ndedalo\nnginx\n' },
		// The containers each start created (an abort names only these — campaign 3e E4).
		{
			match: `${compose} ps --all --services`,
			afterExact: `${compose} up -d`,
			stdout: 'postgres\ndedalo\nnginx\nbackup\ncertbot\n',
		},
		{
			match: `${compose} ps --all --services`,
			after: `${compose} up -d dedalo`,
			stdout: 'postgres\ndedalo\n',
		},
		{
			match: `${compose} ps --all --services`,
			after: `${compose} up -d postgres`,
			stdout: 'postgres\n',
		},
		// stack_up: nginx settled — its container, running and not restarting (C3-8).
		{ match: `${compose} ps -q nginx`, stdout: 'scratch-nginx-id\n' },
		// …publishing every port it declares (campaign 3b N2).
		{
			match: `${DOCKER} inspect --format {{json .HostConfig.PortBindings}}`,
			stdout: `${JSON.stringify(nginxPorts(route))}\n`,
		},
		{
			match: `${DOCKER} port scratch-nginx-id`,
			stdout: Object.keys(nginxPorts(route))
				.map((port) => `${port} -> 0.0.0.0:${port.split('/')[0]}\n`)
				.join(''),
		},
		{
			match: `${DOCKER} inspect --format {{.State.Status}} {{.RestartCount}}`,
			stdout: 'running 0\n',
		},
		{
			match: `/usr/bin/curl -sS -o /dev/null -w %{http_code} --max-time 20 ${health}`,
			stdout: '200',
		},
		{ match: '/usr/bin/curl -sS', stdout: '404' },
	];
}

/**
 * The commands a production run may log WITHOUT changing the host: the
 * read-only probes (facts, verifies, `unless` checks, the public probes). A
 * logged command that matches none of these changed something — the gates hold
 * every such command to the Review's list.
 */
export const READ_ONLY_PROBES: readonly RegExp[] = Object.freeze([
	/^\/usr\/bin\/id -u$/,
	/^\/usr\/bin\/uname -m$/,
	/^\/usr\/bin\/dpkg-query -W /,
	/^\/usr\/bin\/rpm -qa /,
	/^\/usr\/bin\/systemctl (is-active|is-enabled|show -p|list-unit-files) /,
	/^\/usr\/bin\/getent (passwd|group)( |$)/,
	/^\/usr\/bin\/id -Gn? /,
	/^\/usr\/sbin\/runuser -u postgres -- \S+\/psql -XAtq /,
	/^\/usr\/sbin\/runuser -u \S+ (-g \S+ )?-- \S+\/psql -X -q -A -t -v ON_ERROR_STOP=1 .* -c SELECT /,
	/^\/usr\/bin\/ss -ltnpH$/,
	/^\/usr\/sbin\/(nginx -[vTt]|apachectl configtest|apache2ctl -[vSM]|httpd -[vSM])$/,
	/^\/usr\/bin\/curl -s(S)? -o \/dev\/null -w %\{http_code\} /,
	/^\/usr\/bin\/test -[sez] /,
	/^\/usr\/sbin\/semanage fcontext -l -C$/,
	/^\/usr\/sbin\/(semodule -l|getenforce)$/,
	/^\/usr\/bin\/stat -c %C /,
	/^\/usr\/bin\/ps -o label= -p \d+$/,
	/^\/usr\/bin\/pgrep /,
	/^\/usr\/sbin\/runuser -u \S+ (-g \S+ )?-- (\/usr\/bin\/env HOME=\S+ )?\S+\/bun run \S+install\.ts --status --json$/,
	/^\/usr\/sbin\/runuser -u \S+ (-g \S+ )?-- (\/usr\/bin\/env HOME=\S+ )?\S+\/bun run scripts\/ops\/boot_status\.ts --json$/,
	/^\/opt\/dedalo\/bun\/[\d.]+\/bun --version$/,
	/^\/usr\/bin\/firewall-cmd (--get-default-zone|--zone=\S+ --list-(services|ports))$/,
	/^\/usr\/bin\/cmp -s /,
	/^\/usr\/sbin\/ufw status$/,
	/^\/usr\/bin\/find .* -user \S+ -print -quit$/,
	/^\/usr\/sbin\/runuser -u \S+ (-g \S+ )?-- \/usr\/bin\/grep -m 1 \^DEDALO_SALT_STRING= /,
	/^\/usr\/bin\/pg_lsclusters --no-header$/,
]);

/** Is a logged command a host CHANGE (not a read-only probe)? */
export function changesHost(line: string): boolean {
	return !READ_ONLY_PROBES.some((pattern) => pattern.test(line));
}
