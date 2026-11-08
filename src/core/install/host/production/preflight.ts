/**
 * host_preflight — THE SYSTEM CHECK OF A PRODUCTION RUN (terminal installer
 * phase 4, 2026-10-12). Measures the host (facts.ts) and REFUSES, before any
 * change, everything the later steps would trip on:
 *
 *  - an unsupported system (the sentence lists the supported ones — newest
 *    releases only), no systemd, no root;
 *  - an instance ALREADY INSTALLED under this name (its registry entry or
 *    stamped drop-in): that one refusal, naming the files (campaign 3d C3d-F1);
 *  - nginx older than 1.25.1 (`http2 on;` — no fallback form);
 *  - the SERVICE ACCOUNT and the INSTALL FOLDER (identity_rules.ts — the same
 *    verdict the identity probe showed): root/system accounts and groups, an
 *    account holding a privileged group, another instance's user, group or
 *    folder (one per instance), a folder that is not the user's and not
 *    empty, a symlinked or foreign-writable path, a folder a web site serves;
 *  - a CLASH under this instance's names: the database or the role (a created
 *    database), a dedalo-ts@<i> unit or drop-in, the site file, the socket,
 *    the server name (and a local CA's extra addresses) on our ports in
 *    another site file, an IPv4 address it claims (address_claims.ts: this
 *    host's, no other instance's, the catch-all able to serve it), the instance's ports
 *    held by any program but the chosen web server, the OTHER web server
 *    installed beside a chosen one this run would install (campaign 3b N3);
 *  - PostgreSQL: another major's cluster on the database port (critique B5 —
 *    a second cluster would be created beside it on another port, and the
 *    engine and pg_dump would disagree about which one holds the database);
 *  - the institution's certificate files (address, expiry, key) — and that
 *    this host trusts their chain (host_public_probe verifies it with this
 *    host's curl: campaign 3 C3-13); a local CA's directory holding an
 *    authority made for other addresses;
 *  - a local `--ontology-source` the service user cannot read (the engine
 *    steps stage it as that user — ontology_source_access.ts).
 *
 * Then FREEZES the facts and the digest of every step's commands in the state
 * file (state_types.ts): what the rest of the run, and any resume, executes.
 * The firewall is TOLD (never changed): a verdict for the instance's ports,
 * with the exact command when they are closed (firewall.ts — campaign 3
 * C3-6); so are the Apache modules to enable (C3-34). It creates nothing, so
 * it has no undo; done once, a resume skips it (the frozen facts stand).
 */

import type { HostCtx, HostPlanCtx, HostRunResult, HostStepDefinition } from '../contract.ts';
import { gatherHostFacts, type HostFacts } from '../facts.ts';
import { type FirewallVerdict, firewallVerdict } from '../firewall.ts';
import type { HostFs } from '../fs.ts';
import { bunPinOfPaths, pathsFor } from '../layout.ts';
import {
	binaryOf,
	NGINX_MIN_VERSION,
	osRowById,
	unsupportedOsSentence,
	versionAtLeast,
} from '../os_support.ts';
import { hostRefuse } from '../refuse.ts';
import {
	apacheModuleCommand,
	missingApacheModules,
	REQUIRED_APACHE_MODULES,
} from '../web/apache.ts';
import { httpNameClash, instanceHttpNames, serverNameClash } from '../web/clash.ts';
import { siteNames } from '../web/site.ts';
import { claimProblems } from './address_claims.ts';
import { ran, sitePath, webFlavor } from './common.ts';
import { identityOf, instanceDirs, ownedDirs } from './identity.ts';
import { instanceTakenSentence } from './identity_rules.ts';
import { ontologySourceAccessProblems } from './ontology_source_access.ts';
import { foreignAuthority, institutionCertVerdict } from './tls.ts';

/** Refuse with every problem, joined (the operator fixes them all in one pass). */
function refuseAll(problems: readonly string[]): void {
	if (problems.length > 0) hostRefuse('install.state_conflict', problems.join('; '));
}

/** The refusal of a production run without root (also what --plan, run as a normal user, leaves out). */
export const ROOT_REQUIRED_SENTENCE = 'the production route must run as root: sudo sh install.sh …';

/** The system itself: supported, systemd, root. */
function systemProblems(facts: HostFacts): string[] {
	if (facts.os === null) {
		return [unsupportedOsSentence(facts.osName)];
	}
	return [
		...(facts.systemd
			? []
			: [
					'systemd is not running (/run/systemd/system is absent) — the instance runs as systemd units',
				]),
		...(facts.euid === 0 ? [] : [ROOT_REQUIRED_SENTENCE]),
	];
}

/** The web server's configuration probes and its version floor. */
function webProblems(facts: HostFacts): string[] {
	const probes = facts.web.probeFailures.map(
		(line) =>
			`${line} — the installer cannot see the web server's sites; fix its configuration first`,
	);
	const version = facts.web.version;
	if (facts.web.kind !== 'nginx' || version === null) return probes;
	return versionAtLeast(version, NGINX_MIN_VERSION)
		? probes
		: [
				...probes,
				`nginx ${version} is older than ${NGINX_MIN_VERSION} (it rejects \`http2 on;\`) — upgrade nginx first`,
			];
}

/** What already exists under this instance's names (units, site, socket). */
function nameProblems(ctx: HostPlanCtx): string[] {
	const { facts, paths } = ctx;
	const unit = `dedalo-ts@${paths.instance}.service`;
	return [
		...(facts.units.some((item) => item.name === unit && item.state === 'enabled')
			? [`${unit} is already enabled`]
			: []),
		...(facts.dropinExists ? [`${unit} already has drop-ins (/etc/systemd/system/${unit}.d)`] : []),
		...(facts.siteFile.exists ? [`${sitePath(ctx)} already exists`] : []),
		...(facts.socketExists
			? [`the socket ${paths.socket} already exists (another server is listening there)`]
			: []),
	];
}

/** The database side: names taken, another cluster on the port. */
function databaseProblems(ctx: HostPlanCtx): string[] {
	const { facts, answers } = ctx;
	if (answers.db_mode !== 'create') return [];
	const other = facts.pgClusters.find(
		(cluster) =>
			cluster.version !== '18' && (cluster.port === answers.db_port || cluster.port === ''),
	);
	return [
		...(facts.dbExists === true
			? [`database ${answers.db_database} already exists (--db-mode existing uses it as it is)`]
			: []),
		...(facts.roleExists === true
			? [`role ${answers.db_username} already exists (--db-mode existing uses it as it is)`]
			: []),
		...(other === undefined
			? []
			: [
					`PostgreSQL ${other.version} already runs on this host${other.port === '' ? '' : ` on port ${other.port}`} — this install creates the database on PostgreSQL 18; stop that cluster or use --db-mode existing`,
				]),
	];
}

/** The processes each web server listens as (Debian's apache2, the RHEL family's httpd). */
const WEB_PROCESSES: Readonly<Record<'nginx' | 'apache', readonly string[]>> = Object.freeze({
	nginx: ['nginx'],
	apache: ['apache2', 'httpd'],
});

/**
 * ANOTHER WEB SERVER on this host (campaign 3b N3): the instance's ports held
 * by any program that is not the chosen web server (another web server — a
 * neighbouring instance's nginx when Apache is chosen, or the reverse — a
 * proxy, a container), and the OTHER web server installed while the chosen
 * one is not: the run would install a second web server that cannot bind the
 * same ports. Refused before any change, naming the program; never "the one
 * already installed" chosen for the operator behind their answer.
 */
export function webServerClash(ctx: HostPlanCtx, fs: Pick<HostFs, 'exists'>): string[] {
	const { facts, answers, row } = ctx;
	const kind = facts.web.kind;
	const other = kind === 'nginx' ? 'apache' : 'nginx';
	const ports = [answers.http_port, answers.https_port];
	const holders = facts.ports.filter(
		(item) => ports.includes(item.port) && !WEB_PROCESSES[kind].includes(item.process),
	);
	const otherInstalled =
		!facts.web.installed && fs.exists(binaryOf(row, other === 'nginx' ? 'nginx' : 'apachectl'));
	return [
		...[...new Set(holders.map((item) => item.port))].map(
			(port) =>
				`port ${port} is held by ${holders.find((item) => item.port === port)?.process} — this install configures ${kind}, which must listen there: stop that program, or choose the web server that holds the port`,
		),
		...(otherInstalled
			? [
					`${other} is installed on this host and this run would install ${kind} beside it (both listen on ports ${ports.join('/')}): choose ${other}, the one already installed, or remove ${other} first`,
				]
			: []),
	];
}

/** The web side: the address served elsewhere on our ports, a port held by another program. */
function addressProblems(ctx: HostPlanCtx): string[] {
	const { facts, answers } = ctx;
	const ports = [answers.http_port, answers.https_port];
	// Every address the site answers to (a local CA's extra ones included).
	const clashes = siteNames(answers).flatMap((name) => {
		const clash = serverNameClash(facts.web.sites, name, ports, sitePath(ctx));
		return clash === null
			? []
			: [`${name} is already served on port ${ports.join('/')} by ${clash.file}`];
	});
	const named = httpNameClash(
		facts.web.httpNames,
		instanceHttpNames(ctx.paths.instance),
		sitePath(ctx),
	);
	return [
		...clashes,
		...(named === null
			? []
			: [
					`nginx name ${named.name} is already defined in ${named.file} — the site of instance ${ctx.paths.instance} defines it (upstream/zone names are global to nginx): choose another instance name`,
				]),
	];
}

/**
 * The directories: an INSTANCE directory that already exists is someone
 * else's (the answers may point at /var/www, /srv, /etc…) — refused, never
 * handed to the instance user; a shared root one must be a root-owned
 * directory others can traverse (it is used as it is, never re-moded).
 */
function dirProblems(ctx: HostCtx): string[] {
	const owned = ownedDirs(ctx);
	const taken = owned.filter((path) => ctx.fs.exists(path));
	// Only the SHARED root directories: the install folder and its parents are the verdict's.
	const shared = instanceDirs(ctx)
		.filter((spec) => spec.owner === 'root' && !owned.includes(spec.path))
		.filter((spec) => {
			const stat = ctx.fs.stat(spec.path);
			return (
				stat !== null && !(stat.isDirectory && stat.owner === 'root' && (stat.mode & 0o001) !== 0)
			);
		});
	return [
		...taken.map(
			(path) =>
				`${path} already exists — the installer creates the instance's directories itself and never takes over an existing one (remove it or choose another path)`,
		),
		...shared.map(
			(spec) =>
				`${spec.path} exists but is not a root-owned directory others can traverse — the installer never changes it`,
		),
	];
}

/**
 * The institution's own certificate, checked before use; a local CA's
 * directory that already holds an authority for OTHER addresses (host_tls
 * would refuse it after the install is half built — said here first).
 */
function tlsProblems(ctx: HostCtx): { problems: string[]; warnings: string[] } {
	const { answers } = ctx;
	if (answers.tls_mode === 'local_ca') {
		const foreign = foreignAuthority(ctx);
		return { problems: foreign === null ? [] : [foreign], warnings: [] };
	}
	if (answers.tls_mode !== 'files') return { problems: [], warnings: [] };
	const verdict = institutionCertVerdict(ctx, ctx.fs, ctx.now());
	return {
		problems: verdict.problems.map((problem) => `${answers.tls_cert_path}: ${problem}`),
		warnings: verdict.warnings,
	};
}

/** The firewall's verdict for the instance's two ports (campaign 3 C3-6 — told, never changed). */
export function webFirewall(ctx: HostPlanCtx): FirewallVerdict {
	return firewallVerdict(ctx.facts.firewall, [ctx.answers.http_port, ctx.answers.https_port]);
}

/** The modules the site needs that this Apache will lack (installed: measured; to be installed: the layout's). */
function pendingApacheModules(ctx: HostPlanCtx): string[] {
	const { web } = ctx.facts;
	if (web.kind !== 'apache' || web.probeFailures.length > 0) return [];
	if (web.installed) return missingApacheModules(web.apacheModules);
	return webFlavor(ctx).enableWithA2ensite ? [...REQUIRED_APACHE_MODULES] : [];
}

/**
 * Apache's modules, said BEFORE the install (campaign 3 C3-34 — they were
 * discovered ten minutes in, at the web step): an installed Apache lacking
 * some, or the Apache this run INSTALLS on the Debian layout (its package
 * enables none of them; the RHEL family's httpd, mod_ssl and mod_http2 load
 * them all). Enabling stays the administrator's (owner): told, never done.
 */
export function apacheModulesTodo(ctx: HostPlanCtx): string[] {
	const { web } = ctx.facts;
	const missing = pendingApacheModules(ctx);
	if (missing.length === 0) return [];
	const command = apacheModuleCommand(missing, webFlavor(ctx).enableWithA2ensite);
	return [
		web.installed
			? `Apache lacks the modules ${missing.join(', ')} — enable them yourself before the install (the installer never does; the run stops at the web step until they are): ${command}`
			: `this run installs Apache, whose package enables none of ${missing.join(', ')}: the run stops at the web step until you enable them — ${command}, then --resume (or install apache2 and enable them before you start)`,
	];
}

/** What the operator must do THEMSELVES (the Review's to-do; told, never done). */
export function operatorTodo(ctx: HostPlanCtx): string[] {
	const firewall = webFirewall(ctx);
	return [...(firewall.state === 'closed' ? [firewall.line] : []), ...apacheModulesTodo(ctx)];
}

/** Every refusal of a supported system's facts. */
function hostProblems(ctx: HostPlanCtx): string[] {
	return [
		...webProblems(ctx.facts),
		...identityOf(ctx).problems,
		...nameProblems(ctx),
		...databaseProblems(ctx),
		...addressProblems(ctx),
		...claimProblems(ctx),
	];
}

/**
 * The facts of the live host, measured now. The plan context the steps' command
 * lists are computed from is rebuilt by the executor from the frozen copy.
 */
export async function measure(ctx: HostCtx): Promise<HostFacts> {
	return gatherHostFacts(ctx.runner, ctx.fs, ctx.answers, ctx.paths, osRowById, ctx.source);
}

/** What the measured host says: its facts, the plan context over them (null: the system itself is refused), the refusals. */
interface PreflightVerdict {
	facts: HostFacts;
	planCtx: HostPlanCtx | null;
	/** Every refusal, each sentence once (two checks may name one path — campaign 3 C3-23). */
	problems: string[];
	warnings: string[];
}

/** Measure the host and judge it — read-only: nothing is written, nothing recorded. */
async function evaluate(ctx: HostCtx): Promise<PreflightVerdict> {
	const facts = await measure(ctx);
	const system = systemProblems(facts);
	if (system.length > 0) return { facts, planCtx: null, problems: system, warnings: [] };
	// An installed instance holds the name: that ONE refusal — never its unit, site, socket,
	// database and account listed back as if they were in the way (campaign 3d C3d-F1).
	const taken = facts.taken ?? [];
	if (taken.length > 0) {
		const problem = instanceTakenSentence(
			ctx.paths.instance,
			taken.map((record) => record.source),
		);
		return { facts, planCtx: null, problems: [problem], warnings: [] };
	}
	const planCtx: HostPlanCtx = {
		...ctx,
		facts,
		row: osRowById(facts.os as NonNullable<HostFacts['os']>),
		// The service group is the measured account's (critique B2).
		paths: pathsFor(ctx.answers, bunPinOfPaths(ctx.paths), facts),
	};
	const tls = tlsProblems({ ...ctx, ...planCtx });
	const problems = [
		...hostProblems(planCtx),
		...webServerClash(planCtx, ctx.fs),
		...dirProblems({ ...ctx, ...planCtx }),
		...ontologySourceAccessProblems({ ...ctx, ...planCtx }),
		...tls.problems,
	];
	return { facts, planCtx, problems: [...new Set(problems)], warnings: tls.warnings };
}

/**
 * The preflight's refusals, measured now and recorded NOWHERE (campaign 3
 * C3-23/C3-25): what a fresh run checks BEFORE it writes its record — a
 * refused host is left exactly as it was, with no resume or abort to offer —
 * and what `--plan` reports.
 */
export async function preflightRefusals(ctx: HostCtx): Promise<string[]> {
	return (await evaluate(ctx)).problems;
}

/** The preflight's own run: measure, refuse, freeze. */
async function runPreflight(
	ctx: HostCtx,
	digest: (facts: HostFacts) => Record<string, string>,
): Promise<HostRunResult> {
	const verdict = await evaluate(ctx);
	refuseAll(verdict.problems);
	const { facts } = verdict;
	const planCtx = verdict.planCtx as HostPlanCtx;
	ctx.state.preflight.host = { facts, commands_digest: digest(facts) };
	const firewall = firewallReport(planCtx);
	return ran(
		`${facts.osName}, ${facts.web.kind}${facts.web.version === null ? ' (to be installed)' : ` ${facts.web.version}`}${firewall.said}`,
		{
			warnings: verdict.warnings,
			told: [...firewall.told, ...apacheModulesTodo(planCtx), ...identityOf(planCtx).told],
		},
	);
}

/**
 * The firewall's verdict, told only when there is something to do (campaign
 * 3c D16: "ufw (active) allows port 80 and 443" sat under To do): closed or
 * unreadable → the closing To-do; otherwise said once on the step's own line.
 */
export function firewallReport(ctx: HostPlanCtx): { told: string[]; said: string } {
	const verdict = webFirewall(ctx);
	const line = `firewall (checked, not changed): ${verdict.line}`;
	return verdict.state === 'closed' || verdict.state === 'unknown'
		? { told: [line], said: '' }
		: { told: [], said: `; ${line}` };
}

/**
 * The step. `digest` is the host table's: every step's command list for the
 * frozen facts (passed in, so this module does not import the table).
 */
export function preflightStep(
	digest: (facts: HostFacts) => Record<string, string>,
): HostStepDefinition {
	return {
		id: 'host_preflight',
		privilege: 'root',
		kind: 'probe',
		needs: [],
		label: () =>
			'system check: supported OS, root, web server, names free, PostgreSQL, certificate',
		commands: () => [],
		run: (ctx) => runPreflight(ctx, digest),
		refusals: preflightRefusals,
	};
}
