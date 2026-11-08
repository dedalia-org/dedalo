/**
 * THE INTERACTIVE INSTALLER'S PROBES (phase 2, 2026-10-12) — what the screens
 * check while the operator answers: the System check, the database, the media
 * directory, the publication MariaDB, the SMTP relay (with a real test mail),
 * the ontology catalog of the chosen source.
 *
 * RUNS IN THE PROBE CHILD ONLY (install_probe.ts): most of these reach modules
 * that import the engine configuration (pg_bin → config; the diffusion facade;
 * the ontology manifest fetch), and config freezes at import — the front end's
 * own process must stay config-free until the run starts (scripts/install.ts
 * seeds the install's environment first). So every config-touching import here
 * is DYNAMIC, made after the child seeded a neutral boot environment.
 *
 * Each probe answers a PROBE OUTCOME (`{ok, detail}` — an internal shape, never
 * the wire envelope's failure spelling) and never throws for an
 * unreachable server — that is the answer to the question. Every function takes
 * the PLAIN answers so far plus the one secret it needs.
 */

import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { CatalogProbeResult } from './front_end.ts';
import { type FirewallFacts, firewallVerdict } from './host/firewall.ts';
import { osRowOf, parseOsRelease, unsupportedOsSentence } from './host/os_support.ts';
import type { StackFacts } from './host/stack/facts.ts';
import { STACK_MACHINE_CHECKS, STACK_MIN_FREE_GIB } from './host/stack/preflight.ts';
import type { InitTestResult } from './init_test.ts';
import {
	type InstallRoute,
	normalizeInstallAnswers,
	ontologyServersFor,
	ontologySourceFor,
} from './install_plan.ts';
import { probeFailureSentence } from './install_probe_failure.ts';
import { INSTANCE_PATTERN } from './install_validation.ts';
import type { OntologyCatalog } from './ontology_choice.ts';
import type { PsqlProbe } from './pg_bin.ts';
import { FIREWALL_ROW_LABEL, type ProbeOutcome, type SystemCheckRow } from './screen_model.ts';
import type { InstallServerInfo } from './server_info.ts';

type Answers = Readonly<Record<string, unknown>>;

// ── the System check ─────────────────────────────────────────────────────────

/**
 * The init_test line's subject (its sentences are init_test's — read, never
 * rewritten). `routed`: the row is built from the TYPED answer instead
 * (psqlRow — route-aware); its line is still matched so it never reads as an
 * unnamed failure.
 */
const INIT_ROWS: readonly { label: string; match: RegExp; hostOnly: boolean; routed?: true }[] = [
	{ label: 'Bun', match: /\bBun\b/, hostOnly: false },
	{ label: 'Install seed', match: /seed/i, hostOnly: true },
	{ label: 'Private directory', match: /Private config/i, hostOnly: false },
	{ label: 'PostgreSQL client', match: /psql|PostgreSQL client/i, hostOnly: true, routed: true },
];

/**
 * On PRODUCTION the host steps provide what init_test checks on THIS process's
 * tree (critique A17): the instance's private dir is created at
 * <install folder>/private, the media tools come with the packages. Those rows
 * read so. (The PostgreSQL client row is psqlRow's — route-aware on its own.)
 */
const PRODUCTION_PROVIDED: Readonly<Record<string, string>> = Object.freeze({
	'Private directory': 'created by the installer in the install folder (private/)',
	ImageMagick: 'installed by the installer (packages)',
	FFmpeg: 'installed by the installer (packages)',
});

/** The PostgreSQL major the production route installs (os_support.ts packages, host_preflight). */
const PRODUCTION_PG_MAJOR = '18';

/** A production row a host step provides becomes an ok row saying so. */
function productionRow(row: SystemCheckRow): SystemCheckRow {
	const provided = PRODUCTION_PROVIDED[row.label];
	return provided === undefined || row.state === 'ok'
		? row
		: { state: 'ok', label: row.label, detail: provided };
}

/** The Operating system row (a supported row, else the refusal sentence). */
function osRow(osRelease: string): SystemCheckRow {
	const release = parseOsRelease(osRelease);
	const row = osRowOf(release);
	if (row !== null) return { state: 'ok', label: 'Operating system', detail: row.label };
	const name = release.prettyName || release.id || 'this system';
	// No fix on this machine changes its OS: the check offers quit, never retry (C3-61).
	return {
		state: 'fail',
		label: 'Operating system',
		detail: unsupportedOsSentence(name),
		fixable: false,
	};
}

/**
 * The firewall row (campaign 3 C3-6): a WARNING, never a failure — the
 * installer checks and tells, the firewall is the administrator's. Read for
 * the default ports (80, 443): the ports are asked later; host_preflight
 * judges the ones chosen.
 */
export function firewallRow(facts: FirewallFacts): SystemCheckRow {
	const verdict = firewallVerdict(facts, ['80', '443']);
	const warn = verdict.state === 'closed' || verdict.state === 'unknown';
	return { state: warn ? 'warn' : 'ok', label: FIREWALL_ROW_LABEL, detail: verdict.line };
}

/** The production route's own rows: a supported OS, root (the sudo form when not), the firewall. */
function productionHostRows(host: HostMeasures): SystemCheckRow[] {
	return [
		osRow(host.osRelease),
		host.euid === 0
			? { state: 'ok', label: 'Privilege', detail: 'root' }
			: {
					state: 'fail',
					label: 'Privilege',
					detail: 'the production route runs as root: sudo sh install.sh (same arguments)',
				},
		...(host.firewall === null || host.firewall === undefined ? [] : [firewallRow(host.firewall)]),
		...(host.instance === undefined ? [] : [instanceRow(host.instance)]),
	];
}

/** The instance name's row: free, or the installed instance that holds it (C3d-F1). */
function instanceRow(instance: NonNullable<HostMeasures['instance']>): SystemCheckRow {
	return instance.taken === null
		? { state: 'ok', label: 'Instance', detail: `${instance.name}: no instance of that name here` }
		: {
				state: 'fail',
				label: 'Instance',
				detail: `${instance.taken} (go back to Install type)`,
			};
}

/** A Docker/trial host runs the engine in a container: only Bun and the private dir are its rows. */
function onHost(route: InstallRoute): boolean {
	return route !== 'docker' && route !== 'trial';
}

/**
 * A failed check no INIT_ROWS entry names (one init_test adds later) still
 * FAILS — never dropped, or the must_pass gate would let it through.
 */
function unnamedFailures(init: InitTestResult): SystemCheckRow[] {
	return init.errors
		.filter((line) => !INIT_ROWS.some((spec) => spec.match.test(line)))
		.map((line) => ({ state: 'fail' as const, label: 'Check', detail: line }));
}

/** init_test's lines as rows: a `msg` line passes, an `errors` line fails. */
function initRows(init: InitTestResult, route: InstallRoute): SystemCheckRow[] {
	const rows = INIT_ROWS.filter((spec) => !spec.routed && (onHost(route) || !spec.hostOnly))
		.map((spec) => initRow(init, spec))
		.filter((row): row is SystemCheckRow => row !== null);
	return [...rows, ...unnamedFailures(init)];
}

/** One spec's row: its failed line (a FAIL), else its passed line, else none. */
function initRow(init: InitTestResult, spec: (typeof INIT_ROWS)[number]): SystemCheckRow | null {
	const failed = init.errors.find((line) => spec.match.test(line));
	if (failed !== undefined) return { state: 'fail', label: spec.label, detail: failed };
	const passed = init.msg.find((line) => spec.match.test(line));
	return passed === undefined
		? null
		: { state: 'ok', label: spec.label, detail: passedDetail(spec.label, passed) };
}

/**
 * A passed init_test line as an ok row's detail: the row already says `ok`
 * and its label, so neither is said again (campaign 3c D20: `ok  Bun  Bun
 * runtime 1.4.2 — OK`) — `ok  Bun  runtime 1.4.2`, `ok  Install seed
 * present`, `ok  Private directory  writable`.
 */
export function passedDetail(label: string, line: string): string {
	const detail = line.replace(/\s+—\s+OK$/, '');
	const words = PASSED_WORDS[label];
	return words === undefined ? detail : words(detail);
}

/** The words an ok row keeps of its init_test line (the label is the row's). */
const PASSED_WORDS: Readonly<Record<string, (detail: string) => string>> = Object.freeze({
	Bun: (detail: string) => detail.replace(/^Bun\s+/, ''),
	'Install seed': () => 'present',
	'Private directory': () => 'writable',
});

/** The major of a `psql --version` line ("psql (PostgreSQL) 16.4" → '16'), or null. */
export function psqlMajorOf(version: string): string | null {
	return /PostgreSQL\)?\s+(\d+)/.exec(version)?.[1] ?? null;
}

/** Production: the installer installs PostgreSQL 18; a psql here is told, never a blocker. */
function productionPsqlRow(psql: PsqlProbe): SystemCheckRow {
	const label = 'PostgreSQL client';
	if (psql.state === 'missing') {
		return {
			state: 'ok',
			label,
			detail: `not installed yet — the installer installs PostgreSQL ${PRODUCTION_PG_MAJOR} (packages)`,
		};
	}
	if (psql.state === 'unusable') {
		return {
			state: 'warn',
			label,
			detail: `${psql.path} does not run (${psql.reason}) — the installer installs PostgreSQL ${PRODUCTION_PG_MAJOR} (packages); fix or remove that binary`,
		};
	}
	const major = psqlMajorOf(psql.version);
	return major === PRODUCTION_PG_MAJOR
		? { state: 'ok', label, detail: psql.version }
		: {
				state: 'warn',
				label,
				detail: `${psql.version} — the installer installs PostgreSQL ${PRODUCTION_PG_MAJOR}; a cluster of another major on the database port is refused at the run's system check (--db-mode create), unless --db-mode existing`,
			};
}

/** Developer: the install goes into an EXISTING PostgreSQL, so its client is required. */
function developerPsqlRow(psql: PsqlProbe): SystemCheckRow {
	const label = 'PostgreSQL client';
	const fix =
		'the developer route installs into an existing PostgreSQL and needs its client: install it (Debian/Ubuntu: apt install postgresql-client; RHEL: dnf install postgresql; macOS: brew install postgresql@18) or set DEDALO_PG_BIN_PATH to its bin directory, then re-check';
	if (psql.state === 'found') return { state: 'ok', label, detail: psql.version };
	return {
		state: 'fail',
		label,
		detail:
			psql.state === 'missing'
				? `psql not found — ${fix}`
				: `${psql.path} does not run (${psql.reason}) — ${fix}`,
	};
}

/**
 * The PostgreSQL client row, route-aware (campaign 3, 2026-10-13): production
 * installs PostgreSQL itself (absent is fine); docker/trial run the engine in a
 * container (no row: a host psql is never theirs); developer requires it.
 */
export function psqlRow(psql: PsqlProbe, route: InstallRoute): SystemCheckRow | null {
	if (!onHost(route)) return null;
	return route === 'production' ? productionPsqlRow(psql) : developerPsqlRow(psql);
}

/**
 * The docker/trial machine as rows — Docker, Compose, the disk (docs/install/
 * docker.md promises them) — over the facts stack_preflight measures and with
 * ITS sentences (host/stack/preflight.ts STACK_MACHINE_CHECKS): the run's
 * refusal, shown before the run.
 */
export function stackRows(facts: StackFacts): SystemCheckRow[] {
	const checks = STACK_MACHINE_CHECKS;
	const operator = checks.operator(facts);
	return [
		checkRow(
			'Docker',
			checks.docker(facts) ?? checks.daemon(facts),
			`${facts.docker} — the daemon answers`,
		),
		checkRow('Compose', checks.compose(facts), `Docker Compose ${facts.composeVersion}`),
		diskRow(facts),
		...(operator === null ? [] : [checkRow('Operator', operator, '')]),
		cosignRow(facts),
	];
}

/**
 * cosign: a warning, not a failure. Only the official image needs it (the run
 * refuses that case at Review, host/stack/preflight.ts); a build or a custom
 * image does not.
 */
function cosignRow(facts: StackFacts): SystemCheckRow {
	return facts.cosign === null
		? {
				state: 'warn',
				label: 'cosign',
				detail: 'not installed — the official image signature cannot be checked without it',
			}
		: { state: 'ok', label: 'cosign', detail: facts.cosign };
}

/** A check's row: its failure sentence, or ok with `passed`. */
function checkRow(label: string, problem: string | null, passed: string): SystemCheckRow {
	return problem === null
		? { state: 'ok', label, detail: passed }
		: { state: 'fail', label, detail: problem };
}

/** The disk row: the preflight's floor; a root that cannot be measured is a warning (the run skips it). */
function diskRow(facts: StackFacts): SystemCheckRow {
	if (facts.freeGib === null) {
		return {
			state: 'warn',
			label: 'Disk',
			detail: `not measurable under Docker's root — the install needs about ${STACK_MIN_FREE_GIB} GiB free there`,
		};
	}
	return checkRow(
		'Disk',
		STACK_MACHINE_CHECKS.disk(facts),
		`${facts.freeGib} GiB free under ${facts.dockerRoot}`,
	);
}

/** One diagnostics fact: ok when known, a warning (with why it matters) when not. */
function fact(label: string, value: string | null, missing = 'unknown'): SystemCheckRow {
	return value === null
		? { state: 'warn', label, detail: missing }
		: { state: 'ok', label, detail: value };
}

/** A capability the runtime ships: its words when present, else null. */
function builtIn(present: boolean, words: string): string | null {
	return present ? words : null;
}

/** The diagnostics as rows (host routes only): facts, and a warning for a missing media tool. */
function infoRows(info: InstallServerInfo): SystemCheckRow[] {
	return [
		fact('Platform', info.platform),
		fact('Memory', info.ram),
		fact('Processor', info.cpu_mhz, 'no processor is listed (os.cpus() is empty)'),
		fact('Disk', info.disk_free_space),
		fact('ImageMagick', info.imagemagick, 'missing — images are not processed without it'),
		fact('FFmpeg', info.ffmpeg, 'missing — audio and video are not processed without it'),
		fact('cURL', builtIn(info.curl, 'built in (fetch)'), 'missing'),
		fact('OpenSSL', builtIn(info.openssl, 'built in (WebCrypto)'), 'missing'),
	];
}

/** The production host as the System check measures it. */
export interface HostMeasures {
	osRelease: string;
	euid: number;
	/** null: not measured (an unsupported system, or another route). */
	firewall?: FirewallFacts | null;
	/**
	 * The instance name answered on Install type and, when an instance is
	 * ALREADY INSTALLED under it, the refusal naming its files (campaign 3d
	 * C3d-F1 — said here, right after the name, never as an account "leftover"
	 * at the Identity check). Absent/'' : no name to check.
	 */
	instance?: { name: string; taken: string | null };
}

/** What the System check measured besides init_test: the host (production), the stack (docker/trial). */
export interface SystemMeasures {
	host?: HostMeasures | null;
	stack?: StackFacts | null;
}

/**
 * The System-check rows (pure): init_test's checks (a failure is a FAIL row —
 * the gate), the route-aware PostgreSQL client row, and, on a host route, the
 * diagnostics; on docker/trial the stack's own rows (Docker, Compose, the
 * disk). On docker/trial the engine runs in a container, so psql, the seed,
 * PostgreSQL, ImageMagick and FFmpeg are not this host's.
 */
export function systemCheckRows(
	init: InitTestResult,
	info: InstallServerInfo | null,
	route: InstallRoute,
	measures: SystemMeasures = {},
): SystemCheckRow[] {
	const rows = [
		...initRows(init, route),
		...measuredRows(init, info, route, measures.stack ?? null),
	];
	return route === 'production' ? productionRows(rows, measures.host ?? null) : rows;
}

/** The route's measured rows: psql + diagnostics on a host route, the stack's on docker/trial. */
function measuredRows(
	init: InitTestResult,
	info: InstallServerInfo | null,
	route: InstallRoute,
	stack: StackFacts | null,
): SystemCheckRow[] {
	if (!onHost(route)) return stack === null ? [] : stackRows(stack);
	const psql = psqlRow(init.psql, route);
	return [...(psql === null ? [] : [psql]), ...(info === null ? [] : infoRows(info))];
}

/** Production: its own rows first (OS, root), then every row a host step provides read as provided. */
function productionRows(
	rows: readonly SystemCheckRow[],
	host: HostMeasures | null,
): SystemCheckRow[] {
	return [...productionHostRows(host ?? { osRelease: '', euid: -1 }), ...rows.map(productionRow)];
}

/** This machine's os-release text ('' when unreadable). */
function osReleaseText(): string {
	try {
		return readFileSync('/etc/os-release', 'utf8');
	} catch {
		return '';
	}
}

/** The docker/trial stack facts, measured through the Review's machine (the scratch seam's when armed). */
async function measureStack(): Promise<StackFacts> {
	const { reviewMachine } = await import('./host/review.ts');
	const { gatherStackFacts } = await import('./host/stack/facts.ts');
	const { runner, fs } = reviewMachine();
	return gatherStackFacts(runner, fs);
}

/** The System check's inputs that probe THIS machine — injectable so a gate fixes them. */
export interface SystemCheckSeams {
	/** The psql probe (default pg_bin.ts probePsql: config dir, Homebrew, the live PATH). */
	psql?: () => PsqlProbe;
	/** The docker/trial stack facts (default: measured — measureStack). */
	stack?: () => Promise<StackFacts>;
	/** The production host's firewall (default: measured — measureFirewall). */
	firewall?: (osRelease: string) => Promise<FirewallFacts | null>;
	/** An installed instance holding the name: its refusal, or null (default: measured — measureTaken). */
	taken?: (instance: string) => Promise<string | null>;
}

/**
 * The System check. Its verdict is the ROWS': `ok` only when no row failed
 * (the screen never says "System ready." beside a failure — screen_model.ts
 * systemNotices).
 */
export async function systemCheck(
	route: InstallRoute,
	seams: SystemCheckSeams = {},
	instance = '',
): Promise<ProbeOutcome> {
	const { runInitTest } = await import('./init_test.ts');
	const { probePsql } = await import('./pg_bin.ts');
	const { SEED_DUMP_PATH } = await import('./paths.ts');
	// The installer's release identity, its kind said (`7.0.0-beta.7 (prerelease)`) — never the
	// bare data version, which a beta shares with the stable release (C3i-F1).
	const { installerVersionLabel } = await import('./installer_identity.ts');
	const rows = systemCheckRows(
		runInitTest((seams.psql ?? probePsql)()),
		await hostInfo(route),
		route,
		await systemMeasures(route, seams, instance),
	);
	const failed = rows.filter((row) => row.state === 'fail').length;
	return {
		ok: failed === 0,
		detail: failed === 0 ? 'system ready' : `${failed} check(s) failed`,
		rows,
		version: installerVersionLabel(),
		seedPath: SEED_DUMP_PATH,
	};
}

/** The diagnostics grid (host routes only: a docker/trial host's are the container's). */
async function hostInfo(route: InstallRoute): Promise<InstallServerInfo | null> {
	if (!onHost(route)) return null;
	const { buildInstallServerInfo } = await import('./server_info.ts');
	return buildInstallServerInfo();
}

/** The firewall of a supported production host, measured through the Review's machine. */
async function measureFirewall(osRelease: string): Promise<FirewallFacts | null> {
	const row = osRowOf(parseOsRelease(osRelease));
	if (row === null) return null;
	const { reviewMachine } = await import('./host/review.ts');
	const { firewallFacts } = await import('./host/facts.ts');
	const { runner, fs } = reviewMachine();
	return firewallFacts(runner, fs, row);
}

/** The production host's firewall (another route: not measured). */
async function routeFirewall(
	route: InstallRoute,
	osRelease: string,
	seams: SystemCheckSeams,
): Promise<FirewallFacts | null> {
	if (route !== 'production') return null;
	return (seams.firewall ?? measureFirewall)(osRelease);
}

/** An installed instance named `instance` on this host: its refusal, or null (the Review's machine). */
async function measureTaken(instance: string): Promise<string | null> {
	const { reviewMachine } = await import('./host/review.ts');
	const { sameNameRecords } = await import('./host/production/instances.ts');
	const { instanceTakenSentence } = await import('./host/production/identity_rules.ts');
	const records = sameNameRecords(reviewMachine().fs, instance);
	return records.length === 0
		? null
		: instanceTakenSentence(
				instance,
				records.map((record) => record.source),
			);
}

/** The production instance name's measure (no name, or an invalid one: not measured). */
async function routeInstance(
	route: InstallRoute,
	instance: string,
	seams: SystemCheckSeams,
): Promise<HostMeasures['instance']> {
	if (route !== 'production' || !INSTANCE_PATTERN.test(instance)) return undefined;
	return { name: instance, taken: await (seams.taken ?? measureTaken)(instance) };
}

/** The host facts (production's rows read them) and, on docker/trial, the measured stack. */
async function systemMeasures(
	route: InstallRoute,
	seams: SystemCheckSeams,
	instance: string,
): Promise<SystemMeasures> {
	const osRelease = osReleaseText();
	const named = await routeInstance(route, instance, seams);
	return {
		host: {
			osRelease,
			euid: process.geteuid?.() ?? -1,
			firewall: await routeFirewall(route, osRelease, seams),
			...(named === undefined ? {} : { instance: named }),
		},
		stack: onHost(route) ? null : await (seams.stack ?? measureStack)(),
	};
}

// ── the install folder and the service account (production) ──────────────────

/**
 * The identity verdict of the answers against THIS host (owner decisions
 * 2026-10-12): the same rules host_preflight applies and freezes
 * (host/production/identity_rules.ts), read-only — the account, the folder,
 * the other instances, the web sites' roots. Only the production route has
 * one; an unsupported system answers its own sentence (the System check's).
 */
export async function identityProbe(answers: Answers): Promise<ProbeOutcome> {
	const normalized = normalizeInstallAnswers(answers).answers;
	if (normalized.route !== 'production') {
		return {
			ok: true,
			detail: 'only a production install has an install folder and service account of its own',
		};
	}
	const { hostOsRelease, measureIdentity } = await import('./host/production/identity_probe.ts');
	const release = parseOsRelease(hostOsRelease());
	const row = osRowOf(release);
	if (row === null) {
		return {
			ok: false,
			detail: unsupportedOsSentence(release.prettyName || release.id || 'this system'),
		};
	}
	const verdict = await measureIdentity(normalized, row);
	return {
		ok: verdict.problems.length === 0,
		detail:
			verdict.problems.length === 0
				? `${normalized.install_dir} · ${normalized.service_user}`
				: verdict.problems.join('; '),
		identity: verdict,
	};
}

// ── connections ──────────────────────────────────────────────────────────────

/** The answers as the probe doors read them (normalized: the plan's defaults applied). */
function posted(answers: Answers, secret: Record<string, string>): Record<string, unknown> {
	return { ...normalizeInstallAnswers(answers).answers, ...secret };
}

/**
 * A psql OLDER than the server it installs into (campaign 3 C3-49: psql 16
 * against PostgreSQL 18 read "ok") — the backups' pg_dump refuses a newer
 * server. The words, or null (same or newer, or either side unknown).
 */
export function clientServerWarning(
	psqlVersion: string | null,
	serverVersionNum: string | null,
): string | null {
	const client = psqlVersion === null ? null : psqlMajorOf(psqlVersion);
	const num = (serverVersionNum ?? '').trim();
	if (client === null || !/^\d{5,}$/.test(num)) return null;
	const server = Math.floor(Number(num) / 10000);
	if (Number(client) >= server) return null;
	return `warning: psql ${client} is older than the server (PostgreSQL ${server}) — the backups' pg_dump refuses a newer server: install the PostgreSQL ${server} client, or set DEDALO_PG_BIN_PATH to its bin directory`;
}

/** The database probe's inputs that reach THIS machine — injectable so a gate fixes them. */
export interface DatabaseProbeSeams {
	/** The connection report (default: db_probe.ts testDbConnection). */
	connect?: (posted: Record<string, unknown>) => Promise<{
		can_connect: boolean;
		db_exists: boolean;
		msg: string;
	}>;
	/** The server's `server_version_num`, or null (default: one psql query). */
	serverVersion?: (posted: Record<string, unknown>) => Promise<string | null>;
	/** This machine's psql `--version` line, or null (default: pg_bin.ts probePsql). */
	psqlVersion?: () => Promise<string | null>;
}

/** The server's `server_version_num` over the posted connection, or null. */
async function serverVersionOf(postedAnswers: Record<string, unknown>): Promise<string | null> {
	const { runPsqlScript } = await import('./pg_exec.ts');
	const { pgConnFromOptions } = await import('./db_probe_plan.ts');
	try {
		const result = await runPsqlScript(
			pgConnFromOptions(postedAnswers),
			'SHOW server_version_num',
			{
				flags: ['-tA'],
			},
		);
		return result.exitCode === 0 ? result.stdout : null;
	} catch {
		return null;
	}
}

/** This machine's psql version line, or null. */
async function localPsqlVersion(): Promise<string | null> {
	const { probePsql } = await import('./pg_bin.ts');
	const psql = probePsql();
	return psql.state === 'found' ? psql.version : null;
}

/** The developer route's client-vs-server warning, as a suffix of the probe's sentence. */
async function developerClientSuffix(
	postedAnswers: Record<string, unknown>,
	seams: DatabaseProbeSeams,
): Promise<string> {
	const warning = clientServerWarning(
		await (seams.psqlVersion ?? localPsqlVersion)(),
		await (seams.serverVersion ?? serverVersionOf)(postedAnswers),
	);
	return warning === null ? '' : ` — ${warning}`;
}

/** ok = the role reaches the database AND it exists (the executor refuses anything else). */
export async function databaseProbe(
	answers: Answers,
	dbPassword: string,
	seams: DatabaseProbeSeams = {},
): Promise<ProbeOutcome> {
	const normalized = normalizeInstallAnswers(answers).answers;
	if (normalized.route === 'production' && normalized.db_mode === 'create') {
		return {
			ok: true,
			detail: `${normalized.db_database} will be created by the installer (host_database)`,
		};
	}
	return connectionProbe(normalized.route, posted(answers, { db_password: dbPassword }), seams);
}

/** The connection's report — on the developer route with the client-vs-server warning. */
async function connectionProbe(
	route: InstallRoute,
	postedAnswers: Record<string, unknown>,
	seams: DatabaseProbeSeams,
): Promise<ProbeOutcome> {
	const connect = seams.connect ?? (await import('./db_probe.ts')).testDbConnection;
	const result = await connect(postedAnswers);
	const ok = result.can_connect && result.db_exists;
	const suffix =
		ok && route === 'developer' ? await developerClientSuffix(postedAnswers, seams) : '';
	return { ok, detail: `${result.msg}${suffix}` };
}

export async function diffusionProbe(
	answers: Answers,
	mysqlPassword: string,
): Promise<ProbeOutcome> {
	const { testDiffusionConnection } = await import('./db_probe.ts');
	const result = await testDiffusionConnection(posted(answers, { mysql_password: mysqlPassword }));
	return { ok: result.ok, detail: result.msg };
}

/** The SMTP handshake, then — with `sendTo` — one real test mail (mailer_probe.ts). */
export async function mailerProbe(
	answers: Answers,
	smtpPass: string,
	sendTo?: string,
): Promise<ProbeOutcome> {
	const { testMailerConnection } = await import('./mailer_probe.ts');
	const result = await testMailerConnection(posted(answers, { smtp_pass: smtpPass }), sendTo);
	return { ok: result.ok, detail: result.msg };
}

// ── the media directory ──────────────────────────────────────────────────────

/** The nearest existing ancestor of `path` (itself when it exists). */
function nearestExisting(path: string): string | null {
	let probe = resolve(path);
	while (!existsSync(probe)) {
		const parent = dirname(probe);
		if (parent === probe) return null;
		probe = parent;
	}
	return probe;
}

/** Production: the host steps create the media directory (host_identity) — its shape is checked. */
function productionMediaProbe(answers: { media_path: string; service_user: string }): ProbeOutcome {
	if (!isAbsolute(answers.media_path)) {
		return { ok: false, detail: `${answers.media_path || '(empty)'} is not an absolute path` };
	}
	return {
		ok: true,
		detail: `${answers.media_path} will be created by the installer (host_identity), owned by ${answers.service_user}`,
	};
}

/**
 * Can THIS user create (or write) the media directory? The nearest existing
 * ancestor must be writable — the check the pre-flight runs on the
 * private dir (init_test.ts). On production the host steps create it as root
 * (phase 4), so only its shape is checked there.
 */
export async function mediaProbe(answers: Answers): Promise<ProbeOutcome> {
	const normalized = normalizeInstallAnswers(answers).answers;
	if (normalized.route === 'production') return productionMediaProbe(normalized);
	return writableMediaProbe(normalized.media_path);
}

/** A media path THIS user must create or write (every route but production). */
function writableMediaProbe(path: string): ProbeOutcome {
	if (path === '') return { ok: true, detail: 'not written — the engine default media root' };
	if (!isAbsolute(path)) return { ok: false, detail: `${path} is not an absolute path` };
	const existing = nearestExisting(path);
	if (existing === null) return { ok: false, detail: `no existing ancestor of ${path}` };
	try {
		accessSync(existing, constants.W_OK);
	} catch {
		return {
			ok: false,
			detail: `${existing} is not writable by this user — create ${path} owned by the instance user first`,
		};
	}
	return {
		ok: true,
		detail:
			existing === resolve(path) ? `${path} exists and is writable` : `${path} can be created`,
	};
}

// ── the ontology catalog ─────────────────────────────────────────────────────

/** A catalog safe to hand to the parent: its source without the server access code. */
function displayCatalog(catalog: OntologyCatalog): OntologyCatalog {
	const source = catalog.source;
	return {
		...catalog,
		source:
			source.kind === 'server'
				? { kind: 'server', server: { ...source.server, code: '' } }
				: source,
	};
}

/**
 * The catalog the answers' source offers (ontology_catalog.ts — THE resolver;
 * a local archive is extracted and removed again before returning). For the
 * screens and the Review's PREVIEW only: the run re-resolves in its own process
 * and refuses when it decides otherwise (front_end.ts reviewedDecisionsRefusal).
 */
export async function catalogProbe(
	answers: Answers,
	priorEnv: Readonly<Record<string, string>>,
): Promise<CatalogProbeResult> {
	const { resolveOntologyCatalog } = await import('./ontology_catalog.ts');
	const { ontologySourceLabel } = await import('./ontology_choice.ts');
	const normalized = normalizeInstallAnswers(answers).answers;
	const source = ontologySourceFor(normalized, priorEnv);
	try {
		const resolved = await resolveOntologyCatalog(source, {
			allowedServers: ontologyServersFor(normalized, priorEnv),
		});
		resolved.cleanup();
		return {
			ok: true,
			detail: `ontologies offered by ${ontologySourceLabel(source)}`,
			catalog: displayCatalog(resolved.catalog),
		};
	} catch (error) {
		return {
			ok: false,
			detail: probeFailureSentence('catalog', error),
			catalog: null,
		};
	}
}
