/**
 * THE UNITS A PRODUCTION INSTANCE RUNS UNDER (terminal installer phase 4,
 * 2026-10-12) — rendered, never hand-copied:
 *
 *  - the TEMPLATES (deploy/systemd/*@*): shared by every instance on the host,
 *    `%i` = the instance; only OS-row values are substituted (`@@PG_SERVICE@@`).
 *    Written when absent or byte-equal, REFUSED when a different file holds the
 *    name (another installer's, an operator's edit) — never overwritten;
 *  - the per-instance DROP-INS (`<unit>@<i>.service.d/10-dedalo-install.conf`),
 *    stamped `# dedalo-install <i> <answers digest>`: the SERVICE USER and
 *    GROUP, the INSTALL FOLDER (WorkingDirectory=, HOME, the EnvironmentFile,
 *    the rollback/watchdog app dir and code backup root — owner decisions
 *    2026-10-12: both are answers, so no template names them), the pinned
 *    root-owned runtime, the client publish dir, the backup store lines and
 *    their state. The templates whose command needs one of these are
 *    FAIL-CLOSED (`ExecStart=/bin/false`, no User=): without its drop-in a
 *    template runs nothing.
 *
 * EVERY Environment= VALUE IS QUOTED (quote.ts — campaign 2 L8) and the
 * expected store list is DERIVED from the store lines it is written beside, so
 * the two cannot disagree. Every ExecStart a root-run unit executes lives
 * outside the instance's tree (F2).
 *
 * NO ROOT LINE BESIDE THE INSTANCE'S .env: the backup set's EnvironmentFile is
 * the instance user's to write, and systemd applies it to every ExecStart — a
 * `+` (root) line there would run as root with the instance's LD_PRELOAD/PATH.
 * The one root store (site_builder) is its own unit
 * (dedalo-backup-site-builder@, pulled in by a Wants= in the set's drop-in).
 *
 * PURE: (paths, row, answers, source text) → file texts.
 */

import { dirname } from 'node:path';
import type { InstallAnswers } from '../../install_plan.ts';
import { LOCAL_PG_SOCKET_DIR } from '../../install_plan.ts';
import type { InstancePaths } from '../layout.ts';
import type { OsRow } from '../os_support.ts';
import { systemdEnvironment, systemdQuoted } from '../quote.ts';
import { sourceText } from '../source.ts';

/** The template files, as deploy/systemd/ ships them and /etc/systemd/system/ receives them. */
export const UNIT_TEMPLATES = [
	'dedalo-ts@.service',
	'dedalo-ts-restart@.service',
	'dedalo-ts-rollback@.service',
	'dedalo-ts-watchdog@.service',
	'dedalo-ts-watchdog@.timer',
	'dedalo-backup@.service',
	'dedalo-backup@.timer',
	'dedalo-backup-alert@.service',
	'dedalo-backup-site-builder@.service',
	'dedalo-tls-renew@.service',
	'dedalo-tls-renew@.timer',
] as const;

/** The root-run site-builder store's verdict and destination (root-owned, outside the instance's home). */
export function siteBuilderBackupPaths(instance: string): { stateDir: string; dest: string } {
	return {
		stateDir: `/var/lib/dedalo-install/backup/${instance}`,
		dest: `/var/backups/dedalo-site-builder/${instance}`,
	};
}

/** The unit of the root-run site-builder store. */
export function siteBuilderBackupUnit(instance: string): string {
	return `dedalo-backup-site-builder@${instance}.service`;
}

export type UnitTemplate = (typeof UNIT_TEMPLATES)[number];

export const SYSTEMD_DIR = '/etc/systemd/system';

/** The scripts root-run units execute — copied into the instance's root-owned bin dir. */
export const ROOT_RUN_SCRIPTS = [
	'dedalo-backup-step.sh',
	'dedalo-db-backup.sh',
	'dedalo-tree-backup.sh',
	'dedalo-site-builder-backup.sh',
	'dedalo-backup-alert.sh',
	'dedalo-ts-watchdog.sh',
	'dedalo-code-rollback.sh',
	'dedalo-media-rules.sh',
	// The ONE local-CA generator (issue, renew, rotate) — the renewal unit runs this copy.
	'dedalo-tls-rotate.sh',
] as const;

/** One template rendered for a row. */
export function renderTemplate(name: UnitTemplate, row: OsRow, source: string): string {
	return sourceText(`deploy/systemd/${name}`, source).replace(/@@PG_SERVICE@@/g, row.pgService);
}

/** The stamp every drop-in starts with (the clash scan tells ours from a stranger's). */
export function dropinStamp(instance: string, digest: string): string {
	return `# dedalo-install ${instance} ${digest.replace(/^sha256:/, '').slice(0, 16)}`;
}

/** A drop-in's path for `unit@<i>.<kind>`. */
export function dropinPath(unit: string, instance: string): string {
	const at = unit.indexOf('@');
	return `${SYSTEMD_DIR}/${unit.slice(0, at + 1)}${instance}${unit.slice(at + 1)}.d/10-dedalo-install.conf`;
}

/** The service account lines every instance-run unit's drop-in carries. */
function accountLines(paths: InstancePaths): string[] {
	return [`User=${paths.user}`, `Group=${paths.group}`];
}

/** Is `path` equal to `root` or below it? (`/` covers everything.) */
export function pathUnderRoot(path: string, root: string): boolean {
	if (root === '/') return true;
	return path === root || path.startsWith(`${root}/`);
}

/**
 * THE WRITABLE ROOTS of an instance (owner ruling C32, 2026-11-13 — the
 * template runs `ProtectSystem=strict`, so every other path is read-only to the
 * engine): the install folder (the tree, ../private — sessions, the state file,
 * export artifacts, the ontology IO dir —, backups/code), the backup units'
 * dir, the web root (MEDIA_PATH lives under it — THE ROOT RULE) and the client
 * publish dir, the socket dir (systemd's RuntimeDirectory is writable by its own
 * rule; listed so a socket answered elsewhere is covered), the PostgreSQL socket
 * dir (a unix connect works on a read-only mount; listed so a DB_SOCKET under a
 * protected path is covered — and visible), and the temp dirs (uploads staging,
 * PDF extraction, RAG scratch). Derived ONCE here: the drop-in's ReadWritePaths=
 * lines, the JSON manifest beside it and the engine's boot check all read this
 * list. A root under another listed root is dropped; order = this order.
 */
export function writableRoots(paths: InstancePaths, answers: InstallAnswers): string[] {
	const pgSocketDir =
		typeof answers.db_socket === 'string' && answers.db_socket !== ''
			? answers.db_socket
			: LOCAL_PG_SOCKET_DIR;
	const candidates = [
		paths.instanceDir,
		paths.backupDir,
		paths.webRoot,
		paths.clientPublish,
		paths.socketDir,
		pgSocketDir,
		'/tmp',
		'/var/tmp',
	].map((root) => (root.length > 1 ? root.replace(/\/+$/, '') : root));
	const roots: string[] = [];
	for (const root of candidates) {
		if (root === '' || roots.some((kept) => pathUnderRoot(root, kept))) continue;
		roots.push(root);
	}
	// a later, broader root swallows the earlier narrower ones (dedupe both ways)
	return roots.filter(
		(root, i) => !roots.some((other, j) => j !== i && other !== root && pathUnderRoot(root, other)),
	);
}

/** The manifest the installer writes beside the server drop-in (the engine's boot check reads it). */
export const WRITABLE_ROOTS_MANIFEST = 'dedalo-writable-roots.json';

/** The manifest's path for an instance (in the server unit's drop-in dir; systemd reads only `.conf` there). */
export function writableRootsManifestPath(instance: string): string {
	return `${dirname(dropinPath('dedalo-ts@.service', instance))}/${WRITABLE_ROOTS_MANIFEST}`;
}

/**
 * The ROOT command that re-renders this instance's units from its frozen plan
 * (scripts/ops/host_units_refresh.ts → host/production/units_refresh.ts): the
 * pinned root-owned runtime, the instance's own tree. Named by the manifest,
 * by the engine's boot refusal and by the update run's post-verify offer.
 */
export function unitsRefreshCommand(
	paths: Pick<InstancePaths, 'bun' | 'tree' | 'instance'>,
): string {
	return `sudo ${paths.bun} run ${paths.tree}/scripts/ops/host_units_refresh.ts --instance ${paths.instance}`;
}

/** The manifest's JSON (format 1): the instance, the stamp, the roots, the re-render command. */
export function writableRootsManifest(
	paths: InstancePaths,
	answers: InstallAnswers,
	stamp: string,
): string {
	return `${JSON.stringify(
		{
			format: 1,
			instance: paths.instance,
			stamp: stamp.replace(/^# dedalo-install \S+ /, ''),
			read_write_paths: writableRoots(paths, answers),
			refresh: unitsRefreshCommand(paths),
		},
		null,
		'\t',
	)}\n`;
}

/**
 * The server's drop-in: the service account, the install folder, the pinned
 * runtime, the client publish dir, the WRITABLE ROOTS (one quoted
 * ReadWritePaths= line each — L8) and the manifest the engine checks them from.
 */
export function serverDropin(paths: InstancePaths, answers: InstallAnswers, stamp: string): string {
	return [
		stamp,
		'[Service]',
		...accountLines(paths),
		`WorkingDirectory=${paths.tree}`,
		systemdEnvironment({ key: 'HOME', value: paths.instanceDir }),
		'ExecStart=',
		`ExecStart=${paths.bun} run src/server.ts`,
		systemdEnvironment({ key: 'DEDALO_CLIENT_PUBLISH_DIR', value: paths.clientPublish }),
		...writableRoots(paths, answers).map((root) => `ReadWritePaths=${systemdQuoted(root)}`),
		systemdEnvironment({
			key: 'DEDALO_WRITABLE_ROOTS_MANIFEST',
			value: writableRootsManifestPath(paths.instance),
		}),
		'',
	].join('\n');
}

/** One backup store line (`run` / `run --last`), every script from the root-owned bin dir. */
interface StoreLine {
	store: string;
	/** `-` = result ignored (every line but the last); all run as the instance user. */
	prefix: '-' | '';
	args: string[];
}

/** The store lines the INSTANCE's set runs (matrix_db, media, private) — as the instance user. */
export function backupStores(paths: InstancePaths, row: OsRow): StoreLine[] {
	const bin = paths.binDir;
	const stores: StoreLine[] = [
		{
			store: 'matrix_db',
			prefix: '-',
			args: [
				`${bin}/dedalo-db-backup.sh`,
				...['--label', 'timer', '--dir-key', 'DEDALO_BACKUP_DIR', '--dir', `${paths.backupDir}/db`],
				...['--db-key', 'DB_NAME', '--host-key', 'DB_HOST', '--port-key', 'DB_PORT'],
				...['--user-key', 'DB_USER', '--password-key', 'DB_PASSWORD', '--socket-key', 'DB_SOCKET'],
				...['--pg-dump', `${row.pgBinDir}/pg_dump`, '--pg-restore', `${row.pgBinDir}/pg_restore`],
			],
		},
		{
			store: 'media',
			prefix: '-',
			args: [
				`${bin}/dedalo-tree-backup.sh`,
				...['--label', 'media', '--source-key', 'MEDIA_PATH', '--dest', `${paths.backupDir}/media`],
				...['--keep', '14'],
			],
		},
		{
			store: 'private',
			prefix: '-',
			args: [
				`${bin}/dedalo-tree-backup.sh`,
				...['--label', 'private', '--source', `${paths.privateDir}/`],
				...['--dest', `${paths.backupDir}/private`, '--keep', '14'],
				...['--exclude', 'backups', '--exclude', '/export_artifacts'],
			],
		},
	];
	// answers.backup_site_builder adds the ROOT store in its own unit (siteBuilderBackupUnit).
	return stores;
}

/** The stores the unit EXPECTS — derived from the lines, never listed twice. */
export function expectedStores(stores: readonly StoreLine[]): string {
	return stores.map((line) => line.store).join(' ');
}

/** One store's ExecStart line (the LAST one runs `run --last`, the aggregate verdict). */
function storeExec(paths: InstancePaths, line: StoreLine, last: boolean): string {
	const prefix = last && line.prefix === '-' ? '' : line.prefix;
	const verb = last ? ['run', '--last'] : ['run'];
	return `ExecStart=${prefix}${[`${paths.binDir}/dedalo-backup-step.sh`, ...verb, line.store, ...line.args].join(' ')}`;
}

/** The backup unit's drop-in: the store lines, the state dir, the expected list. */
export function backupDropin(
	paths: InstancePaths,
	row: OsRow,
	answers: InstallAnswers,
	stamp: string,
): string {
	const stores = backupStores(paths, row);
	return [
		stamp,
		...(answers.backup_site_builder
			? ['[Unit]', `Wants=${siteBuilderBackupUnit(paths.instance)}`]
			: []),
		'[Service]',
		...accountLines(paths),
		'EnvironmentFile=',
		`EnvironmentFile=${paths.privateDir}/.env`,
		systemdEnvironment({ key: 'DEDALO_BACKUP_STATE_DIR', value: paths.backupStateDir }),
		systemdEnvironment({ key: 'DEDALO_BACKUP_EXPECTED_STORES', value: expectedStores(stores) }),
		'ExecStart=',
		...stores.map((line, index) => storeExec(paths, line, index === stores.length - 1)),
		'',
	].join('\n');
}

/** The alert unit's drop-in: the service account, its command, the same state dir the backup writes. */
export function alertDropin(paths: InstancePaths, stamp: string): string {
	return [
		stamp,
		'[Service]',
		...accountLines(paths),
		systemdEnvironment({ key: 'DEDALO_BACKUP_STATE_DIR', value: paths.backupStateDir }),
		'ExecStart=',
		`ExecStart=${paths.binDir}/dedalo-backup-alert.sh dedalo-backup@${paths.instance}.service`,
		'',
	].join('\n');
}

/** The pinned tree and code backup root a rollback acts on (never resolved from the .env). */
function rollbackPaths(paths: InstancePaths): string[] {
	return ['--app-dir', paths.tree, '--backup-root', paths.codeBackupRoot];
}

/** The rollback unit's drop-in: the service account and its pinned condition and command. */
export function rollbackDropin(paths: InstancePaths, stamp: string): string {
	const script = `${paths.binDir}/dedalo-code-rollback.sh`;
	return [
		stamp,
		'[Service]',
		...accountLines(paths),
		'ExecCondition=',
		`ExecCondition=${[script, '--check', ...rollbackPaths(paths)].join(' ')}`,
		'ExecStart=',
		`ExecStart=${[script, '--no-restart', ...rollbackPaths(paths), '--service', `dedalo-ts@${paths.instance}`, '--socket', paths.socket].join(' ')}`,
		'',
	].join('\n');
}

/** The watchdog unit's drop-in (it runs as root): its pinned command. */
export function watchdogDropin(paths: InstancePaths, stamp: string): string {
	const i = paths.instance;
	return [
		stamp,
		'[Service]',
		'ExecStart=',
		`ExecStart=${[
			`${paths.binDir}/dedalo-ts-watchdog.sh`,
			...['--socket', paths.socket],
			...rollbackPaths(paths),
			...['--service', `dedalo-ts@${i}.service`, '--grace', '900'],
			...['--restart-unit', `dedalo-ts-restart@${i}.service`],
			...['--rollback-unit', `dedalo-ts-rollback@${i}.service`],
		].join(' ')}`,
		'',
	].join('\n');
}

/** The local-CA renewal unit of an instance. */
export function tlsRenewUnit(instance: string, kind: 'service' | 'timer'): string {
	return `dedalo-tls-renew@${instance}.${kind}`;
}

/**
 * The local-CA renewal unit's drop-in (it runs as root): the root-owned
 * generator, the instance's certificate directory and the HOST web server's
 * unit to reload — all pinned here, none read from the instance (F2). Written
 * by host_tls, on local_ca only. `service` is the row's web unit (nginx,
 * apache2, httpd) — the generator's own allowlist; `keyGroup` the group
 * that reads the site key (null: root-only).
 */
export function tlsRenewDropin(
	paths: InstancePaths,
	service: string,
	stamp: string,
	keyGroup: string | null = null,
): string {
	return [
		stamp,
		'[Service]',
		'ExecStart=',
		`ExecStart=${[
			`${paths.binDir}/dedalo-tls-rotate.sh`,
			...['--mode', 'renew', '--dir', paths.tlsDir],
			...['--reload', 'systemd', '--unit', service],
			// A claimed IP address on nginx: the renewed key stays readable by the web
			// server's workers (production/address_claims.ts keyGroup).
			...(keyGroup === null ? [] : ['--key-group', keyGroup]),
		].join(' ')}`,
		'',
	].join('\n');
}

/** The files written BESIDE the drop-ins (not units: systemd reads only `.conf` there) — the writable-roots manifest. */
export function instanceManifests(
	paths: InstancePaths,
	answers: InstallAnswers,
	stamp: string,
): { path: string; content: string }[] {
	return [
		{
			path: writableRootsManifestPath(paths.instance),
			content: writableRootsManifest(paths, answers, stamp),
		},
	];
}

/** Every drop-in of the instance: path → text. */
export function instanceDropins(
	paths: InstancePaths,
	row: OsRow,
	answers: InstallAnswers,
	stamp: string,
): { path: string; content: string }[] {
	return [
		{
			path: dropinPath('dedalo-ts@.service', paths.instance),
			content: serverDropin(paths, answers, stamp),
		},
		{
			path: dropinPath('dedalo-backup@.service', paths.instance),
			content: backupDropin(paths, row, answers, stamp),
		},
		{
			path: dropinPath('dedalo-backup-alert@.service', paths.instance),
			content: alertDropin(paths, stamp),
		},
		{
			path: dropinPath('dedalo-ts-rollback@.service', paths.instance),
			content: rollbackDropin(paths, stamp),
		},
		{
			path: dropinPath('dedalo-ts-watchdog@.service', paths.instance),
			content: watchdogDropin(paths, stamp),
		},
	];
}
