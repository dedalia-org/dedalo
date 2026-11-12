/**
 * host_packages — THE PACKAGES OF A PRODUCTION INSTANCE (terminal installer
 * phase 4, 2026-10-12): PostgreSQL 18 (server, client, contrib), the media
 * toolchain (ffmpeg, ImageMagick, poppler, librsvg, ocrmypdf), the archive
 * tools, the web server when it is missing, certbot for Let's Encrypt (never
 * for a local CA: no ACME client on a host that cannot be reached — openssl,
 * which deploy/dedalo-tls-rotate.sh runs, instead),
 * semanage on the RHEL family — only what the frozen facts say is MISSING, so
 * a host that has them all runs no package command.
 *
 * OCR LANGUAGES (T0-11 D3): one Tesseract language pack per WORKING language
 * (the answers' `langs`, written as PROJECTS_DEFAULT_LANGS) plus `osd`, named
 * by the ONE map the OCR door reads (media/engine/ocr_langs.ts), in ocrmypdf's
 * lane (row.packages.ocrLangpacks). A working language Tesseract has no model
 * for is TOLD (Review to-do + run warning) — never fatal, never guessed.
 *
 * REPOSITORIES: PostgreSQL 18 from PGDG where the release does not ship it
 * (Debian 13, EL 10 — Ubuntu 26.04 ships it: no third-party repository, A10);
 * EL adds EPEL (ImageMagick, certbot), CRB, RPM Fusion free (ffmpeg). Each is
 * shown on the Review with its exact command, like a package.
 *
 * UNDO (critique B4, owner question Q3): packages AND repositories are shared
 * host state — recorded and TOLD on --abort, never removed (a repository
 * removed under its packages would leave them without security updates).
 */

import { TESSERACT_OSD_MODEL, tesseractModelFor } from '../../../media/engine/ocr_langs.ts';
import { normalizeInstallAnswers } from '../../install_plan.ts';
import { deriveLangConfig } from '../../lang_catalog.ts';
import type { PlanFile } from '../../run_files_core.ts';
import type { ExecCommand, HostCtx, HostPlanCtx, HostStepDefinition } from '../contract.ts';
import { executeCommands, runExec } from '../execute.ts';
import { packageFacts } from '../facts.ts';
import { exec, probeOk, ran, remember, systemctl, verdictOf, webFlavor } from './common.ts';

/** The working languages this install configures (absent answer → the default set). */
function workingLangs(ctx: HostPlanCtx): string[] {
	return deriveLangConfig({ langs: ctx.answers.langs }).projectsDefaultLangs;
}

/**
 * The OCR models a set of working languages needs (+ osd, once each), and the
 * languages Tesseract has no model for. Pure over the codes: every language the
 * install catalog offers has a model today (gate: install_host_ocr_langpacks_native),
 * so `unmapped` guards a catalog that grows one Tesseract cannot read.
 */
export function ocrModelPlanFor(langs: readonly string[]): {
	models: string[];
	unmapped: string[];
} {
	const models: string[] = [];
	const unmapped: string[] = [];
	for (const lang of langs) {
		const model = tesseractModelFor(lang);
		if (model === null) unmapped.push(lang);
		else if (!models.includes(model)) models.push(model);
	}
	return { models: [...models, TESSERACT_OSD_MODEL], unmapped };
}

/** ocrModelPlanFor over this install's working languages. */
export function ocrModelPlan(ctx: HostPlanCtx): { models: string[]; unmapped: string[] } {
	return ocrModelPlanFor(workingLangs(ctx));
}

/** The Tesseract language packages of this row for the working languages. */
export function ocrLangPackages(ctx: HostPlanCtx): string[] {
	return ocrModelPlan(ctx).models.map((model) => ctx.row.packages.ocrLangpacks.packageOf(model));
}

/** The told line for working languages OCR cannot read (none when every one has a model). */
export function ocrLangsToldFor(unmapped: readonly string[]): string[] {
	return unmapped.length === 0
		? []
		: [
				`OCR of PDFs: no Tesseract language model exists for ${unmapped.join(', ')} — uploads in ${unmapped.length === 1 ? 'that language' : 'those languages'} are not offered OCR (text extraction still works)`,
			];
}

/** ocrLangsToldFor over this install's working languages (Review to-do + run warning). */
export function ocrLangsTold(ctx: HostPlanCtx): string[] {
	return ocrLangsToldFor(ocrModelPlan(ctx).unmapped);
}

/** The packages of the warn-only optional lane (EL: ocrmypdf and its language packs — optionalTransactions). */
export function optionalPackages(ctx: HostPlanCtx): string[] {
	const { packages } = ctx.row;
	return [
		...packages.optional,
		...(packages.ocrLangpacks.lane === 'optional' ? ocrLangPackages(ctx) : []),
	];
}

/** The packages this instance needs on this row. */
export function desiredPackages(ctx: HostPlanCtx): string[] {
	const { row, answers } = ctx;
	return [
		...row.packages.base,
		...(row.packages.ocrLangpacks.lane === 'base' ? ocrLangPackages(ctx) : []),
		...webFlavor(ctx).package,
		...(answers.tls_mode === 'letsencrypt' ? row.packages.certbot : []),
		...(answers.tls_mode === 'local_ca' ? row.packages.localCa : []),
		...(row.selinux ? row.packages.selinuxTools : []),
	];
}

/** The ones the frozen facts did not find. */
export function missingPackages(ctx: HostPlanCtx): string[] {
	return desiredPackages(ctx).filter((name) => !ctx.facts.packages.includes(name));
}

/** A repository this install adds: its marker package (or file) and its command. */
interface RepoSpec {
	name: string;
	present: (ctx: HostPlanCtx) => boolean;
	commands: (ctx: HostPlanCtx) => ExecCommand[];
}

const EL_RPMS = {
	epel: 'https://dl.fedoraproject.org/pub/epel/epel-release-latest-10.noarch.rpm',
	rpmfusion: 'https://mirrors.rpmfusion.org/free/el/rpmfusion-free-release-10.noarch.rpm',
	pgdg: (arch: string) =>
		`https://download.postgresql.org/pub/repos/yum/reporpms/EL-10-${arch}/pgdg-redhat-repo-latest.noarch.rpm`,
};

/** dnf install of one repository rpm. */
function dnfRepo(ctx: HostPlanCtx, url: string, label: string): ExecCommand {
	return exec(ctx, 'dnf', ['install', '-y', url], label, { timeoutMs: 15 * 60_000 });
}

const REPOS: readonly RepoSpec[] = [
	{
		name: 'pgdg (apt.postgresql.org)',
		present: (ctx) =>
			ctx.row.tool !== 'apt' || !ctx.row.pgFromPgdg || ctx.facts.packages.includes('postgresql-18'),
		commands: (ctx) => [
			exec(
				ctx,
				'apt-get',
				['install', '-y', '--no-install-recommends', 'postgresql-common'],
				'install postgresql-common (the PGDG setup script)',
				{ env: { DEBIAN_FRONTEND: 'noninteractive' } },
			),
			{
				kind: 'exec',
				argv: ['/usr/share/postgresql-common/pgdg/apt.postgresql.org.sh', '-y'],
				as: 'root',
				label: 'add the PostgreSQL (PGDG) apt repository',
				mutates: true,
			},
		],
	},
	{
		name: 'epel',
		present: (ctx) => ctx.row.tool !== 'dnf' || ctx.facts.packages.includes('epel-release'),
		commands: (ctx) => [
			dnfRepo(ctx, EL_RPMS.epel, 'add the EPEL repository (ImageMagick, certbot)'),
			exec(ctx, 'crb', ['enable'], 'enable the CodeReady Builder repository (EPEL dependencies)'),
		],
	},
	{
		name: 'rpmfusion-free',
		present: (ctx) =>
			ctx.row.tool !== 'dnf' || ctx.facts.packages.includes('rpmfusion-free-release'),
		commands: (ctx) => [
			dnfRepo(ctx, EL_RPMS.rpmfusion, 'add the RPM Fusion free repository (ffmpeg)'),
		],
	},
	{
		name: 'pgdg (download.postgresql.org)',
		present: (ctx) => ctx.row.tool !== 'dnf' || ctx.facts.packages.includes('pgdg-redhat-repo'),
		commands: (ctx) => [
			dnfRepo(ctx, EL_RPMS.pgdg(ctx.facts.arch), 'add the PostgreSQL (PGDG) repository'),
		],
	},
];

/** The repositories this run adds (by name). */
export function addedRepos(ctx: HostPlanCtx): string[] {
	return missingPackages(ctx).length === 0
		? []
		: REPOS.filter((repo) => !repo.present(ctx)).map((repo) => repo.name);
}

/** `apt-get update` (a fresh host — or a container image — has no package lists yet). */
function aptRefresh(ctx: HostPlanCtx, label: string): ExecCommand {
	return exec(ctx, 'apt-get', ['update'], label, { env: { DEBIAN_FRONTEND: 'noninteractive' } });
}

/**
 * apt: the package lists FIRST — before a repository's setup package is
 * installed (`postgresql-common` is not locatable on a host whose lists were
 * never fetched: measured, the Debian 13 drill).
 */
function refreshCommands(ctx: HostPlanCtx, missing: readonly string[]): ExecCommand[] {
	return ctx.row.tool === 'apt' && missing.length > 0
		? [aptRefresh(ctx, 'refresh the package lists')]
		: [];
}

/** The package transaction(s) of the row's tool (apt: the lists again when a repository was added). */
function installCommands(
	ctx: HostPlanCtx,
	missing: readonly string[],
	reposAdded: boolean,
): ExecCommand[] {
	if (ctx.row.tool === 'apt') {
		return [
			...(reposAdded ? [aptRefresh(ctx, 'refresh the package lists (the added repository)')] : []),
			exec(
				ctx,
				'apt-get',
				['install', '-y', '--no-install-recommends', ...missing],
				`install ${missing.length} package(s)`,
				{
					env: { DEBIAN_FRONTEND: 'noninteractive' },
					timeoutMs: 45 * 60_000,
				},
			),
		];
	}
	return [
		exec(ctx, 'dnf', ['install', '-y', ...missing], `install ${missing.length} package(s)`, {
			timeoutMs: 45 * 60_000,
		}),
	];
}

/** EL: initialize PostgreSQL 18 when this host has no cluster yet (peer locally, scram over TCP). */
function initdbCommands(ctx: HostPlanCtx): ExecCommand[] {
	if (ctx.row.tool !== 'dnf' || ctx.facts.pgInitialized) return [];
	return [
		exec(ctx, 'pg_setup', ['initdb'], 'initialize the PostgreSQL 18 cluster', {
			env: { PGSETUP_INITDB_OPTIONS: '--auth-local=peer --auth-host=scram-sha-256' },
			unless: exec(
				ctx,
				'test',
				['-e', '/var/lib/pgsql/18/data/PG_VERSION'],
				'cluster initialized',
				{
					mutates: false,
				},
			),
		}),
	];
}

/** Start what this run installed (PostgreSQL always; the web server when it was missing). */
function serviceCommands(ctx: HostPlanCtx): ExecCommand[] {
	const web = ctx.facts.web.installed ? [] : [webFlavor(ctx).service];
	return [
		systemctl(
			ctx,
			'enable',
			['--now', ctx.row.pgService, ...web],
			`enable and start PostgreSQL 18${web.length > 0 ? ` and ${web[0]}` : ''}`,
		),
	];
}

/** Every command (none when nothing is missing and PostgreSQL already runs). */
export function packageCommands(ctx: HostPlanCtx): ExecCommand[] {
	const missing = missingPackages(ctx);
	const repos = REPOS.filter((repo) => missing.length > 0 && !repo.present(ctx)).flatMap((repo) =>
		repo.commands(ctx),
	);
	const install = missing.length === 0 ? [] : installCommands(ctx, missing, repos.length > 0);
	const start =
		missing.length === 0 && ctx.facts.pgRunning
			? []
			: [...initdbCommands(ctx), ...serviceCommands(ctx)];
	return [...refreshCommands(ctx, missing), ...repos, ...install, ...start];
}

/** One warn-only optional transaction: what it installs and what its failure costs. */
interface OptionalTransaction {
	packages: string[];
	command: ExecCommand;
	/** The warning when it fails (the run continues — L28). */
	warning: string;
}

/**
 * EL's optional packages, each failure only warns (L28) — in SEPARATE
 * transactions: ocrmypdf (+ the row's other optional packages) in one, then ONE
 * PER LANGUAGE PACK. dnf refuses a whole transaction when one name has no match,
 * so a single transaction let one missing langpack (a language EPEL does not
 * package) silently cost ocrmypdf itself — OCR off for every language.
 */
export function optionalTransactions(ctx: HostPlanCtx): OptionalTransaction[] {
	const missing = (names: readonly string[]) =>
		names.filter((name) => !ctx.facts.packages.includes(name));
	const { packages } = ctx.row;
	const groups: { packages: string[]; warning: string }[] = [
		{
			packages: missing(packages.optional),
			warning: `${packages.optional.join(', ')} could not be installed — OCR of PDFs stays off until it is`,
		},
		...missing(packages.ocrLangpacks.lane === 'optional' ? ocrLangPackages(ctx) : []).map(
			(name) => ({
				packages: [name],
				warning: `${name} could not be installed — OCR in that language stays off until it is (the other languages are unaffected)`,
			}),
		),
	];
	return groups
		.filter((group) => group.packages.length > 0)
		.map((group) => ({
			...group,
			command: exec(
				ctx,
				'dnf',
				['install', '-y', ...group.packages],
				`install ${group.packages.join(', ')} (optional — a failure only warns)`,
				{ okExit: [0, 1] },
			),
		}));
}

async function runPackages(ctx: HostCtx) {
	await executeCommands(packageCommands(ctx), ctx);
	const warnings: string[] = [];
	for (const optional of optionalTransactions(ctx)) {
		const result = await runExec(optional.command, ctx);
		if (result !== null && result.exitCode !== 0) warnings.push(optional.warning);
	}
	warnings.push(...ocrLangsTold(ctx));
	return ran(`${missingPackages(ctx).length} package(s) installed`, { warnings });
}

/**
 * The step's headline: what desiredPackages installs for THIS plan — certbot
 * only with Let's Encrypt (campaign 3f U26: an institution certificate's
 * Review named certbot over an apt command without it).
 */
export function packagesLabel(plan: PlanFile): string {
	const { answers } = normalizeInstallAnswers(plan.answers as Record<string, unknown>);
	const tool: Readonly<Record<string, string>> = {
		letsencrypt: ', certbot',
		local_ca: ', openssl',
	};
	return `packages: PostgreSQL 18, the media toolchain, the web server${tool[answers.tls_mode] ?? ''}`;
}

export const host_packages: HostStepDefinition = {
	id: 'host_packages',
	privilege: 'root',
	kind: 'action',
	needs: [],
	label: packagesLabel,
	commands: (ctx) => [
		...packageCommands(ctx),
		...optionalTransactions(ctx).map((optional) => optional.command),
	],
	verify: async (ctx) => {
		const installed = await packageFacts(ctx.runner, ctx.row);
		const missing = desiredPackages(ctx).filter((name) => !installed.includes(name));
		const running = await probeOk(
			ctx,
			exec(ctx, 'systemctl', ['is-active', ctx.row.pgService], 'PostgreSQL running', {
				mutates: false,
			}),
		);
		return verdictOf(
			[
				[missing.length === 0, `packages missing: ${missing.join(', ')}`],
				[running, `${ctx.row.pgService} is not running`],
			],
			'every package installed, PostgreSQL running',
		);
	},
	run: runPackages,
	intent: (ctx) => {
		for (const name of missingPackages(ctx)) remember(ctx.created.packages, name);
		for (const name of addedRepos(ctx)) remember(ctx.created.repos, name);
	},
	undo: async (ctx) => {
		const kept = await keptOnHost(ctx);
		return kept.length === 0
			? 'no package was added'
			: `kept (shared host state, never removed): ${kept.join(', ')}`;
	},
};

/** The apt sources file the PGDG setup script writes (either spelling, by its version). */
const PGDG_APT_SOURCES = [
	'/etc/apt/sources.list.d/pgdg.list',
	'/etc/apt/sources.list.d/pgdg.sources',
] as const;

/**
 * What the abort KEEPS, MEASURED now (campaign 3b N17): the intent recorded
 * the PLANNED set before apt ran, so an abort of a run interrupted during
 * `apt-get update` said "kept: apache2" of a package never installed. Only the
 * planned packages the host has now, and the planned repositories whose marker
 * (their release package, or PGDG's apt sources file) is there now.
 */
async function keptOnHost(ctx: HostCtx): Promise<string[]> {
	if (ctx.created.repos.length === 0 && ctx.created.packages.length === 0) return [];
	const installed = await packageFacts(ctx.runner, ctx.row);
	const measured: HostPlanCtx = { ...ctx, facts: { ...ctx.facts, packages: installed } };
	const repoThere = (name: string): boolean => {
		const spec = REPOS.find((repo) => repo.name === name);
		if (spec === undefined || spec.present(measured)) return true;
		return name.startsWith('pgdg (apt') && PGDG_APT_SOURCES.some((path) => ctx.fs.exists(path));
	};
	return [
		...ctx.created.repos.filter(repoThere),
		...ctx.created.packages.filter((name) => installed.includes(name)),
	];
}
