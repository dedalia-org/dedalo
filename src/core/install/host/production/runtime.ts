/**
 * host_runtime — THE INSTANCE'S RUNTIME, CODE AND ROOT-RUN SCRIPTS (terminal
 * installer phase 4, 2026-10-12):
 *
 *  - BUN at the repo pin (.bun-version), ROOT-OWNED in /opt/dedalo/bun/<pin>/
 *    (installed only when the binary there is not byte-identical — `cmp`,
 *    the `unless` probe: a second instance never replaces the inode the first
 *    one runs; campaign 3 C3-57)
 *    (owner question Q4; F2: the unit runs it as the instance, but the instance
 *    must never be able to replace what it runs). Taken ONLY from a zip whose
 *    sha256 equals the committed .bun-sha256 row of this host's asset — the
 *    bootstrap's verified cache, else downloaded here and checked in
 *    TypeScript before anything is extracted (critique B8: never a copy of the
 *    operator's own `bun` binary, whose bytes nothing vouches for). Shared by
 *    every instance of the same pin (refcounted, registry.ts).
 *  - THE RELEASE in place: the source tree's HEAD (git archive) — or the tree
 *    itself when it is a verified release, not a checkout — archived by root.
 *    A checkout is usually the operator's own (cloned as the user who ran
 *    sudo), which git refuses to root as "dubious ownership" (campaign 3
 *    C3-7): the archive names THAT checkout as safe.directory for this one
 *    command (`-c`, never the global config) and turns core.fsmonitor off.
 *    That grants nothing new: root is already running this installer's
 *    TypeScript FROM the same checkout, so whoever controls its .git/config
 *    controls root's run anyway; fsmonitor (the one config hook git would
 *    execute) is off regardless. `--format=tar` runs no tar filter command.
 *    Archived
 *    into a root-owned hand-over dir (root:<service group> 0750, OUTSIDE the
 *    install folder), then extracted BY THE SERVICE USER into
 *    <install folder>/dedalo, and `bun install --frozen-lockfile --production --ignore-scripts`
 *    run AS the service user (the updater's own command). Root never extracts,
 *    chowns or removes by path inside the install folder (critique B1: an
 *    existing account may run processes that could swap a path under it).
 *  - THE ROOT-RUN SCRIPTS (backup, watchdog, rollback, alert) copied to
 *    /opt/dedalo/instances/<i>/bin, root:root 0755 (F2). An update of the
 *    instance's code does not refresh them (it runs as the instance): a later
 *    installer run does — told on Done (critique A8).
 */

import type {
	ExecCommand,
	HostCommand,
	HostCtx,
	HostPlanCtx,
	HostStepDefinition,
} from '../contract.ts';
import { executeCommands } from '../execute.ts';
import { hostRefuse } from '../refuse.ts';
import { dropEntry, otherEntries, updateEntry } from '../registry.ts';
import { bunAssetHashes, sourceText } from '../source.ts';
import { ROOT_RUN_SCRIPTS } from '../systemd/render.ts';
import { exec, probe, probeText, ran, remember, verdictOf } from './common.ts';

/** The Bun asset of this host (AVX2 → the regular x64 build, else baseline; arm64). */
export function bunAsset(ctx: HostPlanCtx): string {
	if (ctx.facts.arch === 'aarch64') return 'bun-linux-aarch64.zip';
	return ctx.facts.avx2 ? 'bun-linux-x64.zip' : 'bun-linux-x64-baseline.zip';
}

/** The bootstrap's cache of verified Bun zips for a pin (install.sh writes it, this step reuses it). */
export function bunCacheDir(pin: string): string {
	return `/var/lib/dedalo-install/bun/${pin}`;
}

function cacheDir(ctx: HostPlanCtx): string {
	return bunCacheDir(pinOf(ctx));
}

function pinOf(ctx: HostPlanCtx): string {
	return ctx.paths.bunDir.slice(ctx.paths.bunDir.lastIndexOf('/') + 1);
}

/** Fetch the zip into the cache (skipped when it is there — its hash is checked either way). */
function bunFetch(ctx: HostPlanCtx): HostCommand[] {
	const asset = bunAsset(ctx);
	const zip = `${cacheDir(ctx)}/${asset}`;
	return [
		{
			kind: 'mkdir',
			path: cacheDir(ctx),
			mode: 0o700,
			owner: 'root',
			group: 'root',
			label: 'the Bun download cache',
		},
		exec(
			ctx,
			'curl',
			[
				'-fsSL',
				'--proto',
				'=https',
				'--tlsv1.2',
				'-o',
				zip,
				`https://github.com/oven-sh/bun/releases/download/bun-v${pinOf(ctx)}/${asset}`,
			],
			`download Bun ${pinOf(ctx)} (${asset})`,
			{
				unless: probe(ctx, 'test', ['-s', zip], 'the verified zip is cached'),
				timeoutMs: 10 * 60_000,
			},
		),
	];
}

/** Extract the VERIFIED zip and install the binary root-owned 0755. */
function bunInstall(ctx: HostPlanCtx): HostCommand[] {
	const asset = bunAsset(ctx);
	const staging = `${cacheDir(ctx)}/extract`;
	const unpacked = `${staging}/${asset.replace(/\.zip$/, '')}/bun`;
	return [
		exec(
			ctx,
			'unzip',
			['-o', '-q', `${cacheDir(ctx)}/${asset}`, '-d', staging],
			'unpack the verified Bun zip',
		),
		exec(
			ctx,
			'install',
			['-D', '-m', '0755', '-o', 'root', '-g', 'root', unpacked, ctx.paths.bun],
			`install the runtime at ${ctx.paths.bun} (root-owned)`,
			{
				// Another instance of the same pin runs it: byte-identical, it is used as
				// it is — never replaced under a running instance (campaign 3 C3-57).
				unless: probe(
					ctx,
					'cmp',
					['-s', unpacked, ctx.paths.bun],
					'the runtime in place is byte-identical',
				),
			},
		),
		exec(ctx, 'rm', ['-rf', staging], 'remove the unpacked copy'),
	];
}

/** The release archive's transient path (the root-owned hand-over dir the service group reads). */
function releaseTar(ctx: HostPlanCtx): string {
	return `${ctx.paths.releaseDir}/release.tar`;
}

/** Archive the source: its git HEAD, or the verified release tree as it is. */
function releaseArchive(ctx: HostPlanCtx): ExecCommand {
	if (ctx.facts.sourceIsGit) {
		return exec(
			ctx,
			'git',
			[
				'-c',
				`safe.directory=${ctx.source}`,
				'-c',
				'core.fsmonitor=false',
				'-C',
				ctx.source,
				'archive',
				'--format=tar',
				'-o',
				releaseTar(ctx),
				'HEAD',
			],
			'archive the source tree (HEAD)',
		);
	}
	return exec(
		ctx,
		'tar',
		['-C', ctx.source, '--exclude=./node_modules', '--exclude=./.git', '-cf', releaseTar(ctx), '.'],
		'archive the verified release tree',
	);
}

/**
 * The package cache of the dependency install: inside the release tree and
 * removed right after — never `~/.bun` in the instance's home, which would
 * outlive an --abort with the account's uid (critique A6).
 */
function installCache(ctx: HostPlanCtx): string {
	return `${ctx.paths.tree}/.bun-install-cache`;
}

/** The release in place: archived by root, extracted and installed BY THE SERVICE USER. */
function releaseCommands(ctx: HostPlanCtx): HostCommand[] {
	const { paths } = ctx;
	return [
		{
			kind: 'mkdir',
			path: paths.releaseDir,
			mode: 0o750,
			owner: 'root',
			group: paths.group,
			label: 'the release hand-over dir (root-owned; the service group reads it)',
		},
		releaseArchive(ctx),
		{
			kind: 'mkdir',
			path: paths.tree,
			mode: 0o750,
			owner: paths.user,
			group: paths.group,
			label: 'the release tree',
			as: 'instance',
		},
		exec(
			ctx,
			'tar',
			// --no-overwrite-dir: the archive's own `./` entry would re-mode the 0750 tree
			// to the source's 0755 (campaign 3, the hand-install runs R6/R7).
			['-xf', releaseTar(ctx), '-C', paths.tree, '--no-same-owner', '--no-overwrite-dir'],
			`extract the release into ${paths.tree} (as the service user)`,
			{ as: 'instance' },
		),
		exec(ctx, 'rm', ['-rf', paths.releaseDir], 'remove the archive and its hand-over dir'),
		{
			kind: 'exec',
			argv: [paths.bun, 'install', '--frozen-lockfile', '--production', '--ignore-scripts'],
			as: 'instance',
			label:
				'install the dependencies (as the service user; the package cache and its temporary files inside the tree, the cache removed next)',
			mutates: true,
			cwd: paths.tree,
			// TMPDIR in the tree (campaign 3c D12): with /tmp on another filesystem than the
			// cache, Bun leaves a `/tmp/.<hash>-0.hm` of the service user there — an orphan
			// of a removed uid once --abort deletes the account (`find / -nouser`).
			env: {
				HOME: paths.instanceDir,
				BUN_INSTALL_CACHE_DIR: installCache(ctx),
				TMPDIR: paths.tree,
			},
			timeoutMs: 20 * 60_000,
		},
		exec(ctx, 'rm', ['-rf', installCache(ctx)], 'remove the package cache (as the service user)', {
			as: 'instance',
		}),
	];
}

/** The root-run scripts, root:root 0755 in the instance's bin dir. */
export function scriptWrites(ctx: HostPlanCtx): HostCommand[] {
	return ROOT_RUN_SCRIPTS.map((name) => ({
		kind: 'write',
		path: `${ctx.paths.binDir}/${name}`,
		mode: 0o755,
		owner: 'root',
		group: 'root',
		content: sourceText(`deploy/${name}`, ctx.source),
		label: `root-run script ${name}`,
	}));
}

export function runtimeCommands(ctx: HostPlanCtx): HostCommand[] {
	return [...bunFetch(ctx), ...bunInstall(ctx), ...releaseCommands(ctx), ...scriptWrites(ctx)];
}

/** The zip must hash to its committed .bun-sha256 row — checked BEFORE it is extracted. */
function assertVerifiedZip(ctx: HostCtx): void {
	const { assets, pin } = bunAssetHashes(ctx.source);
	const asset = bunAsset(ctx);
	const expected = assets.get(asset);
	const actual = ctx.fs.sha256(`${cacheDir(ctx)}/${asset}`);
	if (pin !== pinOf(ctx) || expected === undefined || actual !== expected) {
		ctx.fs.remove(`${cacheDir(ctx)}/${asset}`);
		hostRefuse(
			'install.step_failed',
			`the Bun zip ${asset} does not match .bun-sha256 (pin ${pinOf(ctx)}) — removed; nothing was extracted`,
		);
	}
}

async function runRuntime(ctx: HostCtx) {
	await executeCommands(bunFetch(ctx), ctx);
	assertVerifiedZip(ctx);
	await executeCommands([...bunInstall(ctx), ...releaseCommands(ctx), ...scriptWrites(ctx)], ctx);
	updateEntry(ctx.fs, ctx.paths, { bun_pin: pinOf(ctx) });
	return ran(`Bun ${pinOf(ctx)} at ${ctx.paths.bun}; release at ${ctx.paths.tree}`, {
		told: [
			`the root-run scripts in ${ctx.paths.binDir} are copies, root-owned: an in-app code update does not refresh them — a release that changes deploy/*.sh says what to do in its release notes`,
		],
	});
}

/** The scripts in place, byte-equal to the source. */
function scriptChecks(ctx: HostCtx): [boolean, string][] {
	return scriptWrites(ctx).map((command) => {
		const write = command as Extract<HostCommand, { kind: 'write' }>;
		return [
			ctx.fs.readText(write.path) === write.content,
			`${write.path} differs from the release`,
		];
	});
}

/** Remove `path` recursively (a tree this install created) — as root, outside the install folder only. */
async function removeTree(ctx: HostCtx, path: string, label: string): Promise<void> {
	await executeCommands([exec(ctx, 'rm', ['-rf', path], label)], ctx);
}

/** Remove the release tree AS THE SERVICE USER (inside the install folder: never root by path). */
async function removeRelease(ctx: HostCtx): Promise<void> {
	await executeCommands(
		[
			exec(ctx, 'rm', ['-rf', ctx.paths.tree], 'remove the release tree (as the service user)', {
				as: 'instance',
				okExit: [0, 1],
			}),
		],
		ctx,
	);
}

/** Undo Bun: only when this install created it and no other instance runs the same pin. */
async function undoBun(ctx: HostCtx): Promise<string> {
	if (!ctx.created.bun_dir) return '';
	if (otherEntries(ctx.fs, ctx.paths).some((entry) => entry.bun_pin === pinOf(ctx))) {
		return '; Bun kept (another instance uses it)';
	}
	await removeTree(ctx, ctx.paths.bunDir, `remove ${ctx.paths.bunDir}`);
	return '; Bun removed';
}

/** Undo: the scripts, the release, Bun (refcounted), the registry entry. */
async function undoRuntime(ctx: HostCtx): Promise<string> {
	for (const path of ctx.created.scripts) ctx.fs.remove(path);
	if (ctx.created.release_dir) await removeRelease(ctx);
	if (ctx.fs.exists(ctx.paths.releaseDir)) {
		await removeTree(ctx, ctx.paths.releaseDir, 'remove the release hand-over dir');
	}
	const bun = await undoBun(ctx);
	dropEntry(ctx.fs, ctx.paths);
	return `scripts and release removed${bun}`;
}

export const host_runtime: HostStepDefinition = {
	id: 'host_runtime',
	privilege: 'root',
	kind: 'action',
	needs: [],
	label: () => 'runtime (Bun at the pin, root-owned), the release in place, the root-run scripts',
	commands: runtimeCommands,
	verify: async (ctx) => {
		const version = (
			await probeText(ctx, {
				kind: 'exec',
				argv: [ctx.paths.bun, '--version'],
				as: 'root',
				label: 'Bun version',
				mutates: false,
			})
		).trim();
		return verdictOf(
			[
				[
					version === pinOf(ctx),
					`${ctx.paths.bun} is not Bun ${pinOf(ctx)} (${version || 'absent'})`,
				],
				[ctx.fs.exists(`${ctx.paths.tree}/package.json`), `${ctx.paths.tree} holds no release`],
				[ctx.fs.exists(`${ctx.paths.tree}/node_modules`), 'the dependencies are not installed'],
				...scriptChecks(ctx),
			],
			`Bun ${pinOf(ctx)}, release and scripts in place`,
		);
	},
	run: runRuntime,
	intent: (ctx) => {
		ctx.created.bun_dir ||= !ctx.fs.exists(ctx.paths.bunDir);
		ctx.created.release_dir = true;
		for (const write of scriptWrites(ctx))
			if (write.kind === 'write') remember(ctx.created.scripts, write.path);
	},
	undo: undoRuntime,
};
