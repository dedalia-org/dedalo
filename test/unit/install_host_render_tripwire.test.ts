/**
 * WHAT THE PRODUCTION HOST STEPS RENDER IS RIGHT, READ THE WAY ITS READER READS
 * IT (terminal installer phase 4, 2026-10-12; src/core/install/host/systemd/
 * render.ts, deploy/systemd/*@*, host/web/{nginx,apache}.ts, host/layout.ts).
 *
 * Every assertion is on the RENDERED bytes of real plans (every supported OS
 * row; nginx and Apache; Let's Encrypt and the institution's files), parsed —
 * never on the source spelling:
 *
 *  (a) THE EFFECTIVE UNITS: template + the instance's drop-in, merged with
 *      systemd's own rules (a list key's empty assignment resets it — what
 *      `systemctl cat` applies). Every Environment= value survives systemd's word
 *      split INTACT (campaign 2 L8: an unquoted `…STORES=matrix_db media private`
 *      silently became `matrix_db`), and the expected store list EQUALS the
 *      stores the active ExecStart lines back up (site builder on and off); the
 *      last store line runs `run --last`; the server runs the pinned root-owned
 *      Bun on the server entry and declares supervision. No `@@` placeholder
 *      survives a render.
 *  (b) THE WATCHDOG IS ARMED ONLY BY ITS STEP (campaign 2 L7): the instance
 *      template neither Wants= nor Also= the watchdog, and the watchdog timer
 *      waits (`OnActiveSec`) before its first check.
 *  (c) NOTHING ROOT RUNS IS THE INSTANCE'S (F2): every ExecStart a unit runs AS
 *      ROOT (no User=, or a `+` line) executes a file outside the instance's
 *      home and tree — the root-owned bin dir the runtime step fills, or a
 *      system binary — and every script it names is one the step copies there.
 *      THE INSTANCE-DIR RULE (2026-10-12): the code tree's parent is the instance
 *      user's home, its parent is never the install's, root's dirs sit outside
 *      it, and the rollback/watchdog name exactly the tree and the backup root
 *      the engine's swap renames within (engineering/PRODUCTION.md §2.2).
 *  (f) THE ACCOUNT AND THE FOLDER ARE THE DROP-INS' (owner decisions
 *      2026-10-12): no template, on any OS row, spells `/home/ded_`, `ded_%i`
 *      or `/run/dedalo-%i`, nor sets User=/Group=/WorkingDirectory=/
 *      EnvironmentFile=; an instance template WITHOUT its drop-in runs
 *      `/bin/false` (fail-closed, never as root); a custom layout's drop-ins
 *      carry exactly its user, group, folder, .env, HOME and the rollback/
 *      watchdog paths. (c) runs over the default AND a custom layout.
 *  (h) THE ENGINE UNIT'S SANDBOX BASELINE (T1-26 / S15): the EFFECTIVE instance
 *      server unit (every OS row) and deploy/dedalo-ts.service carry the
 *      path-independent systemd sandbox (SANDBOX_BASELINE) and none of the
 *      deliberately excluded keys (SANDBOX_EXCLUDED); positive controls.
 *  (e) THE ENGINE'S MEDIA RULES REACH ROOT'S NGINX ONLY AS VALIDATED COPIES
 *      (deploy/dedalo-media-rules.sh, EXECUTED): every rule file the engine
 *      generates (protection.ts, every mode) is accepted and copied byte-equal;
 *      a file carrying anything else — include, a log path, a server block,
 *      a marker probe outside the instance's store, a map handing out a path,
 *      a second capture, an unterminated quote, a symlink — refuses the whole
 *      copy and installs nothing.
 *  (d) TWO INSTANCES SHARE NO NGINX NAME (upstream, rate-limit zone, log files),
 *      every nginx `location` that sets its own add_header carries the whole
 *      security set (L5/L55), `server_tokens off` (L76), and THE ROOT RULE: for
 *      every MEDIA_PATH the plan ACCEPTS, the URL the engine builds
 *      (`/dedalo/<DEDALO_MEDIA_DIR>/…`, default `media`) resolves to MEDIA_PATH
 *      through nginx's `root` and through Apache's media Alias.
 *
 * DB-FREE, pure renders (the hermetic tier runs it).
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CONFIG_CATALOG } from '../../src/config/catalog/index.ts';
import {
	parseWritableRootsManifest,
	type WritableRootsManifest,
	writableRootsViolations,
} from '../../src/config/writable_roots.ts';
import type { HostCommand, HostPlanCtx } from '../../src/core/install/host/contract.ts';
import { sha256Text } from '../../src/core/install/host/fs.ts';
import { OS_ROWS } from '../../src/core/install/host/os_support.ts';
import { stampOf } from '../../src/core/install/host/production/common.ts';
import { instanceDirs } from '../../src/core/install/host/production/identity.ts';
import {
	catchAllTold,
	certificatePaths,
	keptPorts,
	siteCommands,
	siteText,
} from '../../src/core/install/host/production/web.ts';
import { stackServiceImage } from '../../src/core/install/host/stack/images.ts';
import {
	backupStores,
	instanceDropins,
	instanceManifests,
	pathUnderRoot,
	ROOT_RUN_SCRIPTS,
	renderTemplate,
	SYSTEMD_DIR,
	siteBuilderBackupUnit,
	UNIT_TEMPLATES,
	type UnitTemplate,
	unitsRefreshCommand,
	writableRoots,
	writableRootsManifestPath,
} from '../../src/core/install/host/systemd/render.ts';
import {
	isShippedDigest,
	parseShippedDigests,
	readShippedDigests,
	SHIPPED_DIGESTS_FILE,
} from '../../src/core/install/host/systemd/shipped_digests.ts';
import { CATCH_ALL_STAMP, catchAllPath } from '../../src/core/install/host/web/catch_all.ts';
import { nginxSites } from '../../src/core/install/host/web/clash.ts';
import { SECURITY_HEADERS } from '../../src/core/install/host/web/site.ts';
import { buildInstallPlan } from '../../src/core/install/install_plan.ts';
import { buildNginxConf, buildNginxMap } from '../../src/core/media/protection.ts';
import {
	HOST_VARIANTS,
	type HostVariant,
	mergedUnit,
	productionPlanCtx,
	productionRaw,
	REPO_ROOT,
	ROOT_PASSWORD,
	systemdTemplateNames,
	systemdWords,
	unitAssignments,
	unitEnvironment,
	variantName,
} from '../helpers/install_host_scratch.ts';
import { escapeRegExp } from '../helpers/regex_escape.ts';

/** The effective unit of `template` for the instance of `ctx` (its drop-in, when it has one). */
function effective(ctx: HostPlanCtx, template: UnitTemplate): Map<string, string[]> {
	const dropins = instanceDropins(ctx.paths, ctx.row, ctx.answers, stampOf(ctx))
		.filter((dropin) =>
			dropin.path.includes(`/${template.replace('@', `@${ctx.paths.instance}`)}.d/`),
		)
		.map((dropin) => dropin.content);
	return mergedUnit(renderTemplate(template, ctx.row, ctx.source), dropins);
}

/** The store each active backup ExecStart line backs up (`dedalo-backup-step.sh run[ --last] <store> …`). */
function backedUpStores(lines: readonly string[]): string[] {
	return lines.map((line) => {
		const words = line.replace(/^[-+]/, '').split(/\s+/);
		const at = words.indexOf('run');
		return words[at + 1] === '--last' ? (words[at + 2] as string) : (words[at + 1] as string);
	});
}

const NGINX_LE = HOST_VARIANTS[0] as HostVariant;

/**
 * The two layouts (c) and (f) render (owner decisions 2026-10-12): the default
 * (ded_<i> in /home/ded_<i>) and a hosting account's folder — a dotted EXISTING
 * account, a typed group of its own, a folder below the account's home.
 */
const LAYOUTS: readonly { name: string; extra: Record<string, unknown> }[] = Object.freeze([
	{ name: 'default layout', extra: {} },
	{
		name: 'custom layout',
		extra: {
			install_dir: '/home/drill.example.org/dedalo',
			service_user: 'drill.example.org',
			service_group: 'drillgrp',
		},
	},
]);

// ── (a) the effective units ──────────────────────────────────────────────────

describe('the effective units (template + drop-in, as systemd merges them) (a)', () => {
	for (const row of OS_ROWS) {
		for (const siteBuilder of [false, true]) {
			test(`${row.id}, site builder ${siteBuilder ? 'on' : 'off'}: every Environment= intact; expected stores = the stores backed up`, () => {
				const ctx = productionPlanCtx({ os: row.id, web: 'nginx', tls: 'letsencrypt' }, REPO_ROOT, {
					backup_site_builder: siteBuilder,
				});
				const backup = effective(ctx, 'dedalo-backup@.service');
				// Every Environment= word is one KEY=value: nothing split off a value.
				for (const value of backup.get('Service.Environment') ?? []) {
					for (const word of systemdWords(value)) expect(word, value).toMatch(/^[A-Z_][A-Z0-9_]*=/);
				}
				const env = unitEnvironment(backup);
				const execs = backup.get('Service.ExecStart') ?? [];
				expect(execs.some((line) => line === '/bin/false')).toBe(false);
				const stores = backedUpStores(execs);
				expect(stores).toEqual(backupStores(ctx.paths, ctx.row).map((line) => line.store));
				expect(env.get('DEDALO_BACKUP_EXPECTED_STORES')?.split(' ')).toEqual(stores);
				// The ROOT store never rides the instance's set (its .env is the instance's).
				expect(stores.includes('site_builder')).toBe(false);
				expect(backup.get('Unit.Wants') ?? []).toEqual(
					siteBuilder ? [siteBuilderBackupUnit(ctx.paths.instance)] : [],
				);
				if (siteBuilder) {
					const root = effective(ctx, 'dedalo-backup-site-builder@.service');
					const rootExecs = root.get('Service.ExecStart') ?? [];
					expect(backedUpStores(rootExecs)).toEqual(['site_builder']);
					expect(unitEnvironment(root).get('DEDALO_BACKUP_EXPECTED_STORES')).toBe('site_builder');
					expect(root.get('Service.EnvironmentFile') ?? []).toEqual([]);
					expect(root.get('Service.User') ?? []).toEqual([]);
				}
				expect(env.get('DEDALO_BACKUP_STATE_DIR')).toBe(`${ctx.paths.backupDir}/state`);
				// Only the LAST line gives the aggregate verdict.
				expect(execs.map((line) => line.includes(' run --last '))).toEqual(
					execs.map((_line, index) => index === execs.length - 1),
				);
				// The database store dumps with the row's PostgreSQL 18 client (B5).
				expect(execs.find((line) => line.includes(' matrix_db '))).toContain(
					`--pg-dump ${row.pgBinDir}/pg_dump`,
				);
			});
		}

		test(`${row.id}: the server unit runs the pinned root-owned Bun on the server entry, supervised, after ${row.pgService}`, () => {
			const ctx = productionPlanCtx({ os: row.id, web: 'nginx', tls: 'letsencrypt' });
			const server = effective(ctx, 'dedalo-ts@.service');
			expect(server.get('Service.ExecStart')).toEqual([`${ctx.paths.bun} run src/server.ts`]);
			expect(ctx.paths.bun.startsWith('/opt/dedalo/bun/')).toBe(true);
			const env = unitEnvironment(server);
			expect(env.get('DEDALO_SUPERVISED')).toBe('true');
			expect(env.get('DEDALO_CLIENT_PUBLISH_DIR')).toBe(ctx.paths.clientPublish);
			expect(server.get('Unit.After')?.[0]).toContain(row.pgService);
		});

		test(`${row.id}: no @@ placeholder survives any template's render`, () => {
			for (const name of UNIT_TEMPLATES)
				expect(renderTemplate(name, row, REPO_ROOT), name).not.toContain('@@');
		});
	}

	test('positive control: the L8 spelling (an unquoted list) is caught by this reading', () => {
		const l8 = mergedUnit(
			'[Service]\nEnvironment=DEDALO_BACKUP_EXPECTED_STORES=matrix_db media private\n',
			[],
		);
		expect(unitEnvironment(l8).get('DEDALO_BACKUP_EXPECTED_STORES')).toBe('matrix_db');
		expect(
			systemdWords('DEDALO_BACKUP_EXPECTED_STORES=matrix_db media private').filter(
				(word) => !/^[A-Z_]+=/.test(word),
			),
		).toEqual(['media', 'private']);
		// …and an empty assignment resets a list, the way a drop-in replaces ExecStart.
		expect(
			mergedUnit('[Service]\nExecStart=/bin/false\n', [
				'[Service]\nExecStart=\nExecStart=/x\n',
			]).get('Service.ExecStart'),
		).toEqual(['/x']);
	});
});

// ── (b) the watchdog ─────────────────────────────────────────────────────────

describe('the watchdog is armed only by its step (b)', () => {
	test('the instance template neither Wants= nor Also= the watchdog; the timer waits before its first check', () => {
		const row = OS_ROWS[0] as (typeof OS_ROWS)[number];
		const server = unitAssignments(renderTemplate('dedalo-ts@.service', row, REPO_ROOT));
		expect(
			server.filter(
				(item) =>
					['Wants', 'Also', 'Requires', 'BindsTo'].includes(item.key) &&
					/watchdog/.test(item.value),
			),
		).toEqual([]);
		const timer = unitAssignments(renderTemplate('dedalo-ts-watchdog@.timer', row, REPO_ROOT));
		const onActive = timer.find((item) => item.section === 'Timer' && item.key === 'OnActiveSec');
		expect(Number(onActive?.value)).toBeGreaterThanOrEqual(60);
	});
});

// ── (c) root runs nothing the instance owns ──────────────────────────────────

describe('nothing a unit runs as root is a file the instance user can replace (c)', () => {
	for (const layout of LAYOUTS)
		test(`${layout.name}: every root-run ExecStart is outside the instance tree; every script it names is copied root-owned`, () => {
			const ctx = productionPlanCtx(NGINX_LE, REPO_ROOT, {
				backup_site_builder: true,
				...layout.extra,
			});
			const rootRun: string[] = [];
			for (const name of UNIT_TEMPLATES.filter((unit) => unit.endsWith('.service'))) {
				const unit = effective(ctx, name);
				const user = unit.get('Service.User')?.[0];
				for (const line of unit.get('Service.ExecStart') ?? []) {
					if (user === undefined || line.startsWith('+'))
						rootRun.push(line.replace(/^[-+]/, '').replace(/%i/g, ctx.paths.instance));
				}
			}
			// The floor: the watchdog, the site-builder store run as root.
			expect(rootRun.length).toBeGreaterThanOrEqual(2);
			const binaries = rootRun.map((line) => line.split(/\s+/)[0] as string);
			expect(
				binaries.filter(
					(path) => path.startsWith(ctx.paths.instanceDir) || path.startsWith('/home/'),
				),
			).toEqual([]);
			const scripts = binaries.filter((path) => path.endsWith('.sh'));
			for (const path of scripts) {
				expect(path.startsWith(`${ctx.paths.binDir}/`), path).toBe(true);
				expect(ROOT_RUN_SCRIPTS as readonly string[]).toContain(
					path.slice(ctx.paths.binDir.length + 1),
				);
			}
			expect(scripts.length).toBeGreaterThanOrEqual(2);
		});

	for (const layout of LAYOUTS)
		test(`${layout.name}: no root-run line reads anything the instance writes: no EnvironmentFile under the instance, every backup root pinned`, () => {
			for (const siteBuilder of [false, true]) {
				const ctx = productionPlanCtx(NGINX_LE, REPO_ROOT, {
					backup_site_builder: siteBuilder,
					...layout.extra,
				});
				for (const name of UNIT_TEMPLATES.filter((unit) => unit.endsWith('.service'))) {
					const unit = effective(ctx, name);
					const user = unit.get('Service.User')?.[0];
					const files = (unit.get('Service.EnvironmentFile') ?? []).map((file) =>
						file.replace(/^-/, '').replace(/%i/g, ctx.paths.instance),
					);
					const instanceFiles = files.filter(
						(file) => file.startsWith(`${ctx.paths.instanceDir}/`) || file.startsWith('/home/'),
					);
					for (const key of ['ExecStart', 'ExecStartPre', 'ExecStartPost', 'ExecCondition']) {
						for (const line of unit.get(`Service.${key}`) ?? []) {
							const root = user === undefined || /^[-@]*[+!]/.test(line);
							// systemd applies EnvironmentFile to EVERY Exec line, a `+` one included.
							expect({ name, line, instanceFiles: root ? instanceFiles : [] }).toEqual({
								name,
								line,
								instanceFiles: [],
							});
							// A root-run script that reads a backup root is GIVEN it: never resolved from .env.
							if (root && /dedalo-(ts-watchdog|code-rollback)\.sh/.test(line)) {
								expect(line, name).toContain(`--backup-root ${ctx.paths.codeBackupRoot}`);
							}
						}
					}
				}
			}
		});

	for (const layout of LAYOUTS)
		test(`${layout.name}: THE INSTANCE-DIR RULE: the code tree, its backup root and every path the swap renames are inside the instance user's dir; root's dirs are outside it`, () => {
			// (2026-10-12, owner decision; engineering/PRODUCTION.md §2.2.) The in-app code
			// update renames the tree within its PARENT and into <parent>/backups/code
			// (code_update.ts unwritableSwapDirs) — so that parent must be the instance
			// user's, and the rollback units must name exactly those paths.
			const ctx = productionPlanCtx(NGINX_LE, REPO_ROOT, layout.extra);
			const dirs = instanceDirs(ctx);
			const ownerOf = (path: string) => dirs.find((spec) => spec.path === path)?.owner;
			const instanceDir = dirname(ctx.paths.tree);
			expect(instanceDir).toBe(ctx.paths.instanceDir);
			expect(instanceDir).toBe(
				String(layout.extra.install_dir ?? `/home/ded_${ctx.paths.instance}`),
			);
			expect(ownerOf(instanceDir)).toBe(ctx.paths.user);
			// the instance dir's parent is never created or owned by the install (root's /home)
			expect(dirs.some((spec) => spec.path === dirname(instanceDir))).toBe(false);
			// root's things: root-owned, outside the instance dir
			for (const rootDir of [ctx.paths.binDir, dirname(ctx.paths.bunDir)]) {
				expect(ownerOf(rootDir), rootDir).toBe('root');
				expect(rootDir.startsWith(`${instanceDir}/`), rootDir).toBe(false);
			}
			// the engine's default code-backup root (the installer writes no DEDALO_BACKUP_PATH)
			const engineBackupRoot = join(instanceDir, 'backups', 'code');
			let named = 0;
			for (const name of ['dedalo-ts-rollback@.service', 'dedalo-ts-watchdog@.service'] as const) {
				const unit = effective(ctx, name);
				for (const key of ['ExecCondition', 'ExecStart']) {
					for (const raw of unit.get(`Service.${key}`) ?? []) {
						const words = systemdWords(raw.replace(/%i/g, ctx.paths.instance));
						const flag = (f: string) => words[words.indexOf(f) + 1];
						if (!words.includes('--app-dir')) continue;
						named += 1;
						expect({ name, appDir: flag('--app-dir'), backupRoot: flag('--backup-root') }).toEqual({
							name,
							appDir: ctx.paths.tree,
							backupRoot: engineBackupRoot,
						});
					}
				}
			}
			expect(named).toBe(3);
		});

	test('positive control: a `+` store line beside the instance .env is caught by that reading', () => {
		const merged = mergedUnit(
			'[Service]\nUser=ded_%i\nEnvironmentFile=/home/ded_%i/private/.env\nExecStart=+/opt/x.sh\n',
			[],
		);
		const line = merged.get('Service.ExecStart')?.[0] ?? '';
		expect(/^[-@]*[+!]/.test(line)).toBe(true);
		expect(merged.get('Service.EnvironmentFile')?.[0]?.startsWith('/home/')).toBe(true);
	});
});

// ── (f) the service account and the install folder ───────────────────────────

/** The instance units the drop-ins must complete (each needs the account or a path). */
const INSTANCE_UNITS = [
	'dedalo-ts@.service',
	'dedalo-backup@.service',
	'dedalo-backup-alert@.service',
	'dedalo-ts-rollback@.service',
	'dedalo-ts-watchdog@.service',
] as const satisfies readonly UnitTemplate[];

/** The words after `flag` in an Exec line. */
function flagOf(line: string, flag: string): string | undefined {
	const words = systemdWords(line);
	const at = words.indexOf(flag);
	return at < 0 ? undefined : words[at + 1];
}

describe("the account and the folder are the drop-ins'; the templates name none and fail closed (f)", () => {
	test('every template, every OS row: no /home/ded_, ded_%i or /run/dedalo-%i; no User=, Group=, WorkingDirectory= or EnvironmentFile=', () => {
		let rendered = 0;
		for (const row of OS_ROWS) {
			for (const name of UNIT_TEMPLATES) {
				const text = renderTemplate(name, row, REPO_ROOT);
				rendered += 1;
				expect(text, name).not.toMatch(/\/home\/ded_|ded_%i|\/run\/dedalo-%i/);
				const keys = unitAssignments(text)
					.filter((item) => item.section === 'Service')
					.map((item) => item.key);
				expect(
					keys.filter((key) =>
						['User', 'Group', 'WorkingDirectory', 'EnvironmentFile'].includes(key),
					),
					name,
				).toEqual([]);
			}
		}
		expect(rendered).toBe(OS_ROWS.length * UNIT_TEMPLATES.length);
	});

	test('without its drop-in an instance template runs NOTHING (ExecStart=/bin/false, the rollback ExecCondition too) — never as root', () => {
		const row = OS_ROWS[0] as (typeof OS_ROWS)[number];
		for (const name of INSTANCE_UNITS) {
			const bare = mergedUnit(renderTemplate(name, row, REPO_ROOT), []);
			expect(bare.get('Service.ExecStart'), name).toEqual(['/bin/false']);
			expect(bare.get('Service.User') ?? [], name).toEqual([]);
		}
		const rollback = mergedUnit(renderTemplate('dedalo-ts-rollback@.service', row, REPO_ROOT), []);
		expect(rollback.get('Service.ExecCondition')).toEqual(['/bin/false']);
	});

	test("custom layout: the drop-ins carry exactly the operator's user, group, folder, .env, HOME, --app-dir, --backup-root and --socket", () => {
		const custom = LAYOUTS[1] as (typeof LAYOUTS)[number];
		const dir = String(custom.extra.install_dir);
		const ctx = productionPlanCtx(NGINX_LE, REPO_ROOT, custom.extra);
		const account = { user: ['drill.example.org'], group: ['drillgrp'] };
		const server = effective(ctx, 'dedalo-ts@.service');
		expect({
			user: server.get('Service.User'),
			group: server.get('Service.Group'),
			cwd: server.get('Service.WorkingDirectory'),
			home: unitEnvironment(server).get('HOME'),
		}).toEqual({ ...account, cwd: [`${dir}/dedalo`], home: dir });
		const backup = effective(ctx, 'dedalo-backup@.service');
		expect({
			user: backup.get('Service.User'),
			group: backup.get('Service.Group'),
			env: backup.get('Service.EnvironmentFile'),
		}).toEqual({ ...account, env: [`${dir}/private/.env`] });
		const alert = effective(ctx, 'dedalo-backup-alert@.service');
		expect({ user: alert.get('Service.User'), group: alert.get('Service.Group') }).toEqual(account);
		const rollback = effective(ctx, 'dedalo-ts-rollback@.service');
		expect({ user: rollback.get('Service.User'), group: rollback.get('Service.Group') }).toEqual(
			account,
		);
		const lines = [
			...(rollback.get('Service.ExecCondition') ?? []),
			...(rollback.get('Service.ExecStart') ?? []),
			...(effective(ctx, 'dedalo-ts-watchdog@.service').get('Service.ExecStart') ?? []),
		];
		expect(lines.length).toBe(3);
		for (const line of lines) {
			expect(flagOf(line, '--app-dir'), line).toBe(`${dir}/dedalo`);
			expect(flagOf(line, '--backup-root'), line).toBe(`${dir}/backups/code`);
		}
		const socketed = lines.filter((line) => line.includes('--socket'));
		expect(socketed.length).toBe(2);
		for (const line of socketed)
			expect(flagOf(line, '--socket'), line).toBe(ctx.answers.unix_socket);
		// Nothing of the default layout leaks into the custom one.
		for (const dropin of instanceDropins(ctx.paths, ctx.row, ctx.answers, stampOf(ctx)))
			expect(dropin.content, dropin.path).not.toMatch(/ded_|\/home\/ded_/);
	});
});

// ── (d) the web site files ───────────────────────────────────────────────────

/** The direct directives of each nginx `location … {` block (nested blocks apart). */
function nginxLocations(text: string): { header: string; directives: string[] }[] {
	const out: { header: string; directives: string[] }[] = [];
	const stack: { header: string; directives: string[] }[] = [];
	for (const raw of text.split('\n')) {
		const line = raw.trim();
		const opens = /^location\s+(.+?)\s*\{(.*)$/.exec(line);
		if (opens) {
			const block = { header: opens[1] as string, directives: [] as string[] };
			const rest = (opens[2] as string).trim();
			if (rest.endsWith('}')) {
				block.directives.push(rest.slice(0, -1).trim());
				out.push(block);
				continue;
			}
			stack.push(block);
			out.push(block);
			continue;
		}
		if (line === '}') stack.pop();
		else if (line !== '') stack.at(-1)?.directives.push(line);
	}
	return out;
}

describe('the site files (d)', () => {
	const nginx = HOST_VARIANTS.filter((variant) => variant.web === 'nginx');

	test('two instances on one host share no nginx name: upstream, rate-limit zone, log files', () => {
		const names = (instance: string) => {
			const ctx = productionPlanCtx(NGINX_LE, REPO_ROOT, {
				instance,
				server_name: `${instance}.example.org`,
			});
			const text = siteText(ctx, certificatePaths(ctx));
			return new Set([
				...[...text.matchAll(/upstream\s+(\S+)/g)].map((m) => `upstream ${m[1]}`),
				...[...text.matchAll(/zone=([\w-]+)/g)].map((m) => `zone ${m[1]}`),
				...[...text.matchAll(/_log\s+(\S+)/g)].map((m) => `log ${m[1]}`),
			]);
		};
		const prado = names('prado');
		const goya = names('goya');
		expect(prado.size).toBeGreaterThanOrEqual(4);
		expect([...prado].filter((name) => goya.has(name))).toEqual([]);
	});

	for (const variant of nginx) {
		test(`${variantName(variant)}: every location with its own add_header carries the whole security set; server_tokens off`, () => {
			const ctx = productionPlanCtx(variant);
			const text = siteText(ctx, certificatePaths(ctx));
			const locations = nginxLocations(text);
			const withHeaders = locations.filter((block) =>
				block.directives.some((line) => line.startsWith('add_header ')),
			);
			expect(withHeaders.length).toBeGreaterThanOrEqual(2);
			for (const block of withHeaders) {
				for (const [name] of SECURITY_HEADERS) {
					expect(
						block.directives.some((line) => line.startsWith(`add_header ${name} `)),
						`${block.header}: ${name}`,
					).toBe(true);
				}
			}
			expect((text.match(/^\s*server_tokens off;$/gm) ?? []).length).toBe(2);
		});
	}

	test('positive control: a location that sets one header and drops the others is caught', () => {
		const blocks = nginxLocations('location /x/ {\n\tadd_header Cache-Control "no-cache";\n}\n');
		expect(
			blocks[0]?.directives.some((line) => line.startsWith('add_header X-Frame-Options')),
		).toBe(false);
	});

	const MEDIA_DIR = String(CONFIG_CATALOG.DEDALO_MEDIA_DIR?.default ?? '');

	test('THE ROOT RULE, for every MEDIA_PATH the plan accepts: the engine URL resolves to MEDIA_PATH (nginx root, Apache Alias)', () => {
		expect(MEDIA_DIR).toBe('media');
		const candidates = [
			'',
			'/data/demo/dedalo/media',
			'/srv/museo/web/dedalo/media',
			'/data/demo/dedalo/files',
			'/srv/dedalo/demo/media',
		];
		let accepted = 0;
		for (const media of candidates) {
			const extra = media === '' ? {} : { media_path: media };
			const plan = buildInstallPlan(
				{ ...productionRaw(NGINX_LE), ...extra },
				{ rootPassword: ROOT_PASSWORD, requireRootPassword: true },
			);
			if (plan.errors.length > 0) {
				expect(plan.errors.length, media).toBe(1);
				expect(plan.errors[0], media).toStartWith(`media_path '${media}'`);
				continue;
			}
			accepted += 1;
			const url = `/dedalo/${MEDIA_DIR}/image/thumb/x_test3_1.jpg`;
			const file = `${plan.answers.media_path}/image/thumb/x_test3_1.jpg`;
			for (const web of ['nginx', 'apache'] as const) {
				const ctx = productionPlanCtx({ ...NGINX_LE, web }, REPO_ROOT, extra);
				const text = siteText(ctx, certificatePaths(ctx));
				// nginx: the HTTPS server's root (the last `root` — the first is the ACME root).
				const root = [...text.matchAll(/^\s*root (\S+);$/gm)].at(-1)?.[1];
				const alias = /^\s*Alias \/dedalo\/(\S+) (\S+)$/m.exec(text);
				const resolved =
					web === 'nginx'
						? `${root}${url}`
						: alias?.[1] === MEDIA_DIR
							? url.replace(`/dedalo/${MEDIA_DIR}`, alias[2] as string)
							: `no Alias for /dedalo/${MEDIA_DIR}`;
				expect(resolved, `${web} ${media || '(default)'}`).toBe(file);
			}
		}
		expect(accepted).toBeGreaterThanOrEqual(3);
	});
});

// The repository's own templates are what the step writes (the source tree the root process reads).
test('the templates the step renders are the repository files (deploy/systemd/*@*)', () => {
	// Every template on disk is one the step renders: a new unit file that no step
	// installs (or a rendered one deleted from the tree) is red here.
	const onDisk = systemdTemplateNames();
	expect(onDisk.length).toBeGreaterThan(8);
	expect(onDisk).toEqual([...UNIT_TEMPLATES].sort());
	const row = OS_ROWS[2] as (typeof OS_ROWS)[number];
	for (const name of UNIT_TEMPLATES) {
		const source = readFileSync(join(REPO_ROOT, 'deploy/systemd', name), 'utf8');
		expect(renderTemplate(name, row, REPO_ROOT)).toBe(
			source.replace(/@@PG_SERVICE@@/g, row.pgService),
		);
	}
});

// ── (h) the engine unit's sandbox baseline (T1-26 / S15) ──────────────────────

/**
 * The path-independent systemd sandbox every engine unit carries — the single-instance
 * deploy/dedalo-ts.service and the instance template (whose comments give each line's
 * reason). The EFFECTIVE value is measured (template + drop-in, as systemd merges):
 * a drop-in that resets or widens a line is red here.
 */
const SANDBOX_BASELINE: Readonly<Record<string, string>> = Object.freeze({
	NoNewPrivileges: 'yes',
	CapabilityBoundingSet: '',
	RestrictSUIDSGID: 'yes',
	LockPersonality: 'yes',
	RestrictRealtime: 'yes',
	RestrictNamespaces: 'yes',
	ProtectKernelTunables: 'yes',
	ProtectKernelModules: 'yes',
	ProtectKernelLogs: 'yes',
	ProtectControlGroups: 'yes',
	ProtectClock: 'yes',
	ProtectHostname: 'yes',
	PrivateDevices: 'yes',
	ProtectProc: 'invisible',
	SystemCallArchitectures: 'native',
	RestrictAddressFamilies: 'AF_UNIX AF_INET AF_INET6 AF_NETLINK',
	// the file system is read-only except the drop-in's ReadWritePaths (owner C32, 2026-11-13)
	ProtectSystem: 'strict',
});

/**
 * Deliberately ABSENT, each for a measured engine need (the unit's comment says which):
 * JSC's JIT (MemoryDenyWriteExecute), /proc/cpuinfo (ProcSubset), runners surviving a
 * restart in the temp dir (PrivateTmp), an instance under /home (ProtectHome); the
 * read-only / inaccessible path lists (the engine's roots are OPENED, never narrowed
 * further — a narrowing list would be a second policy the manifest does not know).
 */
const SANDBOX_EXCLUDED: readonly string[] = Object.freeze([
	'MemoryDenyWriteExecute',
	'ProcSubset',
	'PrivateTmp',
	'ProtectHome',
	'ReadOnlyPaths',
	'InaccessiblePaths',
]);

/** The sandbox verdict of a merged unit: missing/different baseline lines and excluded keys present. */
function sandboxFaults(unit: ReadonlyMap<string, string[]>): string[] {
	const faults: string[] = [];
	for (const [key, expected] of Object.entries(SANDBOX_BASELINE)) {
		const values = unit.get(`Service.${key}`);
		if (values === undefined || values.length !== 1 || values[0] !== expected) {
			faults.push(`${key}=${expected} (found ${JSON.stringify(values ?? null)})`);
		}
	}
	for (const key of SANDBOX_EXCLUDED) {
		if (unit.has(`Service.${key}`)) faults.push(`${key} must not be set`);
	}
	return faults;
}

describe("the engine unit's sandbox baseline (h)", () => {
	for (const row of OS_ROWS) {
		test(`${row.id}: the EFFECTIVE instance server unit (template + drop-in) carries the baseline, nothing excluded`, () => {
			const ctx = productionPlanCtx({ os: row.id, web: 'nginx', tls: 'letsencrypt' });
			expect(sandboxFaults(effective(ctx, 'dedalo-ts@.service'))).toEqual([]);
		});
	}

	test('the single-instance deploy/dedalo-ts.service carries the same baseline, nothing excluded', () => {
		const single = readFileSync(join(REPO_ROOT, 'deploy/dedalo-ts.service'), 'utf8');
		expect(sandboxFaults(mergedUnit(single, []))).toEqual([]);
	});

	test('positive controls: a dropped line, a widening drop-in, an excluded key — each caught', () => {
		const single = readFileSync(join(REPO_ROOT, 'deploy/dedalo-ts.service'), 'utf8');
		expect(sandboxFaults(mergedUnit(single.replace(/^NoNewPrivileges=yes\n/m, ''), []))).toEqual([
			'NoNewPrivileges=yes (found null)',
		]);
		expect(sandboxFaults(mergedUnit(single, ['[Service]\nProtectSystem=full\n']))).toEqual([
			'ProtectSystem=strict (found ["full"])',
		]);
		expect(
			sandboxFaults(
				mergedUnit(single, ['[Service]\nCapabilityBoundingSet=CAP_NET_BIND_SERVICE\n']),
			),
		).toEqual(['CapabilityBoundingSet= (found ["CAP_NET_BIND_SERVICE"])']);
		expect(sandboxFaults(mergedUnit(single, ['[Service]\nMemoryDenyWriteExecute=yes\n']))).toEqual([
			'MemoryDenyWriteExecute must not be set',
		]);
	});
});

// ── (i) the writable roots under ProtectSystem=strict (owner C32, 2026-11-13) ──

/**
 * The EFFECTIVE server unit's ReadWritePaths= (systemd's word split applied — each
 * root is QUOTED, L8) must cover every path the install answers make the engine
 * write: the install folder (tree, private, backups/code), the backup dir, MEDIA_PATH,
 * the client publish dir, the socket dir, the PostgreSQL socket dir, the temp dirs;
 * the manifest beside the drop-in carries the SAME list and names the re-render
 * command with the instance; the engine's own judge (config/writable_roots.ts) agrees.
 */
describe('the writable roots: ReadWritePaths= covers every answered path; the manifest is the same list (i)', () => {
	for (const layout of LAYOUTS) {
		for (const row of OS_ROWS) {
			test(`${layout.name}, ${row.id}: every answered path lies under a listed, quoted root; manifest = the list; the engine agrees`, () => {
				const ctx = productionPlanCtx(
					{ os: row.id, web: 'nginx', tls: 'letsencrypt' },
					REPO_ROOT,
					layout.extra,
				);
				const unit = effective(ctx, 'dedalo-ts@.service');
				const lines = unit.get('Service.ReadWritePaths') ?? [];
				expect(lines.length).toBeGreaterThanOrEqual(5);
				// each assignment is ONE quoted root (L8: a space in a folder name survives)
				for (const line of lines) expect(line, line).toMatch(/^"[^"]+"$/);
				const roots = lines.flatMap((line) => systemdWords(line));
				expect(roots).toEqual(writableRoots(ctx.paths, ctx.answers));
				const { paths, answers } = ctx;
				const pgSocket = answers.db_socket === '' ? '/var/run/postgresql' : answers.db_socket;
				const written = [
					paths.tree,
					paths.privateDir,
					paths.codeBackupRoot,
					paths.backupDir,
					paths.media,
					paths.clientPublish,
					paths.socketDir,
					pgSocket,
					'/tmp',
					'/var/tmp',
				];
				const uncovered = written.filter(
					(path) => !roots.some((root) => pathUnderRoot(path, root)),
				);
				expect(uncovered).toEqual([]);
				// no root under another (the list is minimal), none relative, none the whole tree
				for (const root of roots) {
					expect(root.startsWith('/')).toBe(true);
					expect(root).not.toBe('/');
					expect(roots.filter((other) => other !== root && pathUnderRoot(root, other))).toEqual([]);
				}
				// the manifest beside the drop-in: the same list, the instance, the re-render command
				const manifests = instanceManifests(paths, answers, stampOf(ctx));
				expect(manifests.map((m) => m.path)).toEqual([writableRootsManifestPath(paths.instance)]);
				expect(
					manifests[0]?.path.startsWith(`${SYSTEMD_DIR}/dedalo-ts@${paths.instance}.service.d/`),
				).toBe(true);
				expect(manifests[0]?.path.endsWith('.conf')).toBe(false);
				const parsed = parseWritableRootsManifest(manifests[0]?.content ?? '');
				expect(typeof parsed).toBe('object');
				const manifest = parsed as WritableRootsManifest;
				expect(manifest.read_write_paths).toEqual(roots);
				expect(manifest.instance).toBe(paths.instance);
				expect(manifest.refresh).toBe(unitsRefreshCommand(paths));
				expect(manifest.refresh).toContain(`--instance ${paths.instance}`);
				expect(
					manifest.refresh.startsWith(
						`sudo ${paths.bun} run ${paths.tree}/scripts/ops/host_units_refresh.ts`,
					),
				).toBe(true);
				// the drop-in names the manifest for the engine
				expect(unitEnvironment(unit).get('DEDALO_WRITABLE_ROOTS_MANIFEST')).toBe(
					manifests[0]?.path,
				);
				// the engine's judge: every written path passes; a path outside is named
				expect(
					writableRootsViolations(
						manifest.read_write_paths,
						written.map((path) => ({ label: 'x', path })),
					),
				).toEqual([]);
				expect(
					writableRootsViolations(manifest.read_write_paths, [
						{ label: 'MEDIA_PATH', path: '/data/elsewhere/dedalo/media' },
					]),
				).toEqual(['MEDIA_PATH /data/elsewhere/dedalo/media']);
			});
		}
	}

	test('positive controls: an unquoted root is caught by the quoting rule; a DB_SOCKET elsewhere is listed; a sibling prefix is not "under"', () => {
		expect(/^"[^"]+"$/.test('/home/ded_x')).toBe(false);
		const ctx = productionPlanCtx(NGINX_LE, REPO_ROOT, { db_socket: '/data/pg/sock' });
		expect(writableRoots(ctx.paths, ctx.answers)).toContain('/data/pg/sock');
		expect(writableRoots(ctx.paths, ctx.answers)).not.toContain('/var/run/postgresql');
		expect(pathUnderRoot('/home/ded_x2', '/home/ded_x')).toBe(false);
		expect(pathUnderRoot('/home/ded_x/dedalo', '/home/ded_x')).toBe(true);
		expect(pathUnderRoot('/anything', '/')).toBe(true);
		// a root under another listed root is dropped (the backup dir under the install folder)
		const nested = productionPlanCtx(NGINX_LE, REPO_ROOT, {
			backup_dir: `${ctx.answers.install_dir}/backups`,
		});
		const roots = writableRoots(nested.paths, nested.answers);
		expect(roots.filter((root) => root.startsWith(nested.paths.instanceDir))).toEqual([
			nested.paths.instanceDir,
		]);
	});
});

// ── (j) the shipped-template digest ledger (owner C33, 2026-11-13) ───────────

/**
 * deploy/systemd/shipped_digests.json remembers every render a release shipped,
 * so the installer upgrades its own earlier templates and still refuses a
 * stranger's. The law it must keep: EVERY TEMPLATE EDIT ADDS A DIGEST AND
 * REMOVES NONE — this tree's render (every OS row) and the committed HEAD's
 * render of every template are in it, and every digest HEAD's ledger holds is
 * still there.
 */
describe('the shipped-template digest ledger: append-only, current render and HEAD render present (j)', () => {
	const git = (...args: string[]): string => {
		const run = Bun.spawnSync(['git', '-C', REPO_ROOT, ...args]);
		if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString()}`);
		return run.stdout.toString();
	};
	const digestOf = (text: string) => sha256Text(text);

	test('the ledger parses, names exactly the templates, and holds the sha256 of EVERY current render (template × OS row)', () => {
		const ledger = readShippedDigests(REPO_ROOT);
		expect(Object.keys(ledger.templates).sort()).toEqual([...UNIT_TEMPLATES].sort());
		const missing: string[] = [];
		for (const name of UNIT_TEMPLATES) {
			for (const row of OS_ROWS) {
				const digest = digestOf(renderTemplate(name, row, REPO_ROOT));
				if (!isShippedDigest(ledger, name, digest)) missing.push(`${name} (${row.id}) ${digest}`);
			}
		}
		// RED when a template is edited and the ledger not: the edit must add its new digest
		// (bun run scripts/shipped_digests_update.ts appends exactly these)
		expect(missing, 'run: bun run scripts/shipped_digests_update.ts').toEqual([]);
		// no digest twice, every list non-empty
		for (const [name, digests] of Object.entries(ledger.templates)) {
			expect(digests.length, name).toBeGreaterThan(0);
			expect(new Set(digests).size, name).toBe(digests.length);
		}
	});

	test("the committed HEAD's render of every template is in the ledger (the OLD digest survives the edit), and HEAD's ledger is a subset of this one (append-only)", () => {
		const ledger = readShippedDigests(REPO_ROOT);
		const missing: string[] = [];
		for (const name of UNIT_TEMPLATES) {
			const committed = git('show', `HEAD:deploy/systemd/${name}`);
			for (const row of OS_ROWS) {
				const digest = digestOf(committed.replace(/@@PG_SERVICE@@/g, row.pgService));
				if (!isShippedDigest(ledger, name, digest)) missing.push(`${name} (${row.id}) ${digest}`);
			}
		}
		expect(missing).toEqual([]);
		// HEAD's ledger (the first commit of the ledger has none to compare with: empty)
		const inHead = Bun.spawnSync([
			'git',
			'-C',
			REPO_ROOT,
			'cat-file',
			'-e',
			`HEAD:${SHIPPED_DIGESTS_FILE}`,
		]);
		const head =
			inHead.exitCode === 0
				? parseShippedDigests(git('show', `HEAD:${SHIPPED_DIGESTS_FILE}`))
				: { format: 1, templates: {} };
		if (typeof head === 'string') throw new Error(`HEAD's ledger: ${head}`);
		const dropped: string[] = [];
		for (const [name, digests] of Object.entries(head.templates)) {
			for (const digest of digests) {
				if (!(ledger.templates[name] ?? []).includes(digest)) dropped.push(`${name} ${digest}`);
			}
		}
		expect(dropped).toEqual([]);
	});

	test('positive controls: a digest no release shipped is not shipped; a malformed ledger is refused by its reason', () => {
		const ledger = readShippedDigests(REPO_ROOT);
		expect(isShippedDigest(ledger, 'dedalo-ts@.service', 'f'.repeat(64))).toBe(false);
		expect(
			isShippedDigest(ledger, 'dedalo-ts@.service', digestOf('[Service]\nExecStart=/x\n')),
		).toBe(false);
		expect(parseShippedDigests('{ not json')).toBe('not JSON');
		expect(parseShippedDigests('[]')).toBe('format undefined, expected 1');
		expect(parseShippedDigests('{"format":2,"templates":{}}')).toBe('format 2, expected 1');
		expect(parseShippedDigests('{"format":1}')).toBe('no templates map');
		expect(parseShippedDigests('{"format":1,"templates":{"a@.service":["xyz"]}}')).toBe(
			'a@.service: not a list of sha256 hex digests',
		);
		expect(
			typeof parseShippedDigests(readFileSync(join(REPO_ROOT, SHIPPED_DIGESTS_FILE), 'utf8')),
		).toBe('object');
	});
});

// ── (e) the media rules, copied validated (deploy/dedalo-media-rules.sh) ─────

describe("the engine's media rules reach root's nginx only as validated copies (e)", () => {
	const SCRIPT = join(REPO_ROOT, 'deploy/dedalo-media-rules.sh');
	const SERVER = 'dedalo_media_protection.nginx.conf';
	const MAP = 'dedalo_media_protection_map.nginx.conf';
	const base = mkdtempSync(join(tmpdir(), 'dedalo_media_rules_'));
	// The generated rules name the configured media root; the copy is validated against it.
	const generated = (mode: 'off' | 'private' | 'publication') =>
		buildNginxConf(mode, mode === 'publication' ? ['1.5MB', 'thumb', 'original'] : []);
	const root = /if \(!?-f (\S+)\/\.publication\//.exec(generated('private'))?.[1] ?? '';

	/** A scratch source dir (the media root's two files) and a destination; answers the run. */
	function copy(server: string, map: string, link = false) {
		const dir = mkdtempSync(join(base, 'case_'));
		const dest = join(dir, 'dest');
		const source = join(dir, 'source');
		mkdirSync(source);
		writeFileSync(join(dir, 'server.real'), server);
		if (link) symlinkSync(join(dir, 'server.real'), join(source, SERVER));
		else writeFileSync(join(source, SERVER), server);
		writeFileSync(join(source, MAP), map);
		const run = Bun.spawnSync(['sh', SCRIPT, '--source', source, '--dest', dest], {
			env: { PATH: '/usr/bin:/bin', TMPDIR: dir },
			stdout: 'pipe',
			stderr: 'pipe',
		});
		return { code: run.exitCode, err: run.stderr.toString(), dest, source };
	}
	const forSource = (text: string, source: string) => text.split(root).join(source);

	test('the generated root is known (the marker probes name it)', () => {
		expect(root.startsWith('/')).toBe(true);
	});

	for (const mode of ['off', 'private', 'publication'] as const) {
		test(`every rule file the engine generates is accepted, copied byte-equal — mode ${mode}`, () => {
			const dir = mkdtempSync(join(base, 'ok_'));
			const source = join(dir, 'source');
			mkdirSync(source);
			const server = forSource(generated(mode), source);
			writeFileSync(join(source, SERVER), server);
			writeFileSync(join(source, MAP), buildNginxMap());
			const dest = join(dir, 'dest');
			const run = Bun.spawnSync(['sh', SCRIPT, '--source', source, '--dest', dest], {
				env: { PATH: '/usr/bin:/bin', TMPDIR: dir },
				stdout: 'pipe',
				stderr: 'pipe',
			});
			expect(run.exitCode, run.stderr.toString()).toBe(0);
			expect(readFileSync(join(dest, 'media_protection.conf'), 'utf8')).toBe(server);
			expect(readFileSync(join(dest, 'media_protection_map.conf'), 'utf8')).toBe(buildNginxMap());
		});
	}

	const SERVER_ATTACKS: [string, string][] = [
		['an include', 'include /etc/nginx/secrets.conf;'],
		['a log written as root', 'access_log /etc/ld.so.preload;'],
		['a log format', "log_format x '$request';"],
		['a second statement after a whitelisted one', 'add_header X "a" always; include /x;'],
		['a server block', 'server { listen 80; server_name other.example.org; }'],
		['an alias', 'location /x { alias /etc/; }'],
		[
			'a marker probe outside this instance',
			'if (-f /srv/dedalo/other/.publication/auth/$x) { set $dd_pass 1; }',
		],
		['an unterminated quote', 'add_header X "open'],
	];
	for (const [name, line] of SERVER_ATTACKS) {
		test(`server scope refused, nothing installed: ${name}`, () => {
			const dir = mkdtempSync(join(base, 'bad_'));
			const source = join(dir, 'source');
			mkdirSync(source);
			writeFileSync(join(source, SERVER), `${forSource(generated('private'), source)}${line}\n`);
			writeFileSync(join(source, MAP), buildNginxMap());
			const dest = join(dir, 'dest');
			const run = Bun.spawnSync(['sh', SCRIPT, '--source', source, '--dest', dest], {
				env: { PATH: '/usr/bin:/bin', TMPDIR: dir },
				stdout: 'pipe',
				stderr: 'pipe',
			});
			expect(run.exitCode).toBe(1);
			expect(run.stderr.toString()).toContain('REFUSED');
			expect(existsSync(join(dest, 'media_protection.conf'))).toBe(false);
		});
	}

	const MAP_ATTACKS: [string, string][] = [
		['a capture handed to the auth key (a path)', '"~^(?<h>.*)$"  $h;'],
		['a value that is a path', 'default "../../srv/dedalo/other/x";'],
		['another map variable', 'map $uri $dedalo_other {'],
	];
	for (const [name, line] of MAP_ATTACKS) {
		test(`map refused, nothing installed: ${name}`, () => {
			const result = copy('', `${buildNginxMap()}${line}\n`);
			expect(result.code).toBe(1);
			expect(existsSync(join(result.dest, 'media_protection_map.conf'))).toBe(false);
		});
	}

	test('a generated file that is a symbolic link: refused', () => {
		const result = copy('# x\n', buildNginxMap(), true);
		expect(result.code).toBe(1);
		expect(result.err).toContain('is a symbolic link');
	});

	afterAll(() => rmSync(base, { recursive: true, force: true }));
});

// ── (g) an unknown name reaches no instance (campaign 3 C3-30) ──────────────

/** The plan context of `variant` with the web facts `web` (a second instance, an operator's default…). */
function withWeb(
	variant: HostVariant,
	web: Partial<HostPlanCtx['facts']['web']>,
	extra: Record<string, unknown> = {},
): HostPlanCtx {
	const ctx = productionPlanCtx(variant, REPO_ROOT, extra);
	return { ...ctx, facts: { ...ctx.facts, web: { ...ctx.facts.web, ...web } } };
}

/** The catch-all writes among the site step's commands. */
function catchAllWrites(ctx: HostPlanCtx): HostCommand[] {
	const path = catchAllPath(ctx.row.web.nginx);
	return siteCommands(ctx).filter((command) => command.kind === 'write' && command.path === path);
}

/** nginx server blocks of a text. */
function nginxBlocks(text: string): string[] {
	return text.split(/^server \{$/m).slice(1);
}

/** Is a Docker image present here (the real-server checks run only then)? */
function imageReady(image: string): boolean {
	return spawnSync('docker', ['image', 'inspect', image], { timeout: 20_000 }).status === 0;
}

describe('nginx: the host-wide catch-all (g — campaign 3 C3-30)', () => {
	const NGINX = HOST_VARIANTS.filter((variant) => variant.web === 'nginx');

	for (const variant of NGINX) {
		test(`${variantName(variant)}: the FIRST instance writes it — 80 and 443, serving nothing, the default by ORDER only`, () => {
			const ctx = productionPlanCtx(variant);
			const writes = catchAllWrites(ctx);
			expect(writes).toHaveLength(1);
			const text = (writes[0] as { content: string }).content;
			expect(text.startsWith(`${CATCH_ALL_STAMP}\n`)).toBe(true);
			const blocks = nginxBlocks(text);
			expect(blocks).toHaveLength(2);
			expect(blocks[0]).toMatch(/listen 80;[\s\S]*listen \[::\]:80;[\s\S]*return 444;/);
			expect(blocks[1]).toMatch(/listen 443 ssl;[\s\S]*ssl_reject_handshake on;/);
			// Never `default_server`: an operator's (Debian's own, installed WITH nginx, after the
			// System check) would make nginx -t refuse two defaults on one port (the Debian drill).
			expect(blocks.join('')).not.toContain('default_server');
			// The default by ORDER: it sorts before every instance's site in the same directory.
			expect(
				(writes[0] as { path: string }).path < ctx.row.web.nginx.sitePath.replace('<i>', 'a'),
			).toBe(true);
			for (const block of blocks)
				expect(block).not.toMatch(/proxy_pass|root |alias |ssl_certificate/);
		});

		test(`${variantName(variant)}: a SECOND instance (the catch-all is the installer's already) does not duplicate it`, () => {
			expect(catchAllWrites(withWeb(variant, { catchAll: 'ours' }))).toEqual([]);
			expect(catchAllWrites(productionPlanCtx(variant))).toHaveLength(1);
		});
	}

	test('Apache never gets a catch-all file (its vhosts guard their own name — below)', () => {
		const apache = HOST_VARIANTS.filter((variant) => variant.web === 'apache');
		expect(apache.length).toBeGreaterThan(0);
		for (const variant of apache) {
			const ctx = productionPlanCtx(variant);
			const path = catchAllPath(ctx.row.web.apache);
			expect(siteCommands(ctx).filter((c) => c.kind === 'write' && c.path === path)).toEqual([]);
		}
	});

	test("a file the installer did not write at the catch-all's path: never overwritten, said so", () => {
		const ctx = withWeb(NGINX_LE, { catchAll: 'foreign' });
		expect(catchAllWrites(ctx)).toEqual([]);
		expect(catchAllTold(ctx).join('\n')).toContain('is not the installer');
	});

	test("an operator's default_server on 80 stays the default — said so; the catch-all never clashes with it", () => {
		const dump =
			'# configuration file /etc/nginx/sites-enabled/default:\nserver {\n\tlisten 80 default_server;\n\tlisten [::]:80 default_server;\n\troot /var/www/html;\n}\n';
		const sites = nginxSites(dump);
		expect(sites[0]?.defaults).toEqual(['80']);
		const ctx = withWeb(NGINX_LE, {
			defaults: sites.flatMap((site) =>
				(site.defaults ?? []).map((port) => ({ port, file: site.file })),
			),
		});
		const text = (catchAllWrites(ctx)[0] as { content: string }).content;
		expect(nginxBlocks(text)).toHaveLength(2);
		expect(catchAllTold(ctx).join('\n')).toContain(
			'port 80: the default site stays yours (/etc/nginx/sites-enabled/default, default_server)',
		);
		// The installer's own catch-all is never taken for an operator's default.
		expect(
			keptPorts(
				withWeb(NGINX_LE, {
					defaults: [{ port: '80', file: '/etc/nginx/conf.d/dedalo-00-default.conf' }],
				}),
			),
		).toEqual([]);
	});

	test('an instance on other ports: no catch-all (it covers the standard ports only)', () => {
		const files = HOST_VARIANTS.find((v) => v.web === 'nginx' && v.tls === 'files') as HostVariant;
		expect(
			catchAllWrites(
				productionPlanCtx(files, REPO_ROOT, { http_port: '8080', https_port: '8443' }),
			),
		).toEqual([]);
		expect(catchAllWrites(productionPlanCtx(files))).toHaveLength(1);
	});

	/** The full stack's own pinned nginx (T1-17: the stack file is the one spelling). */
	const NGINX_IMAGE = stackServiceImage(REPO_ROOT, 'docker-compose.yml', 'nginx');
	/** Run nginx in `image` over `files` (conf.d), then `requests` (one wget each); answers stdout. */
	function realNginx(files: Record<string, string>, requests: Record<string, string>): string {
		const dir = mkdtempSync(join(tmpdir(), 'dedalo_catch_all_'));
		try {
			for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
			const script = [
				'nginx -t 2>&1 || exit 9',
				'nginx',
				'sleep 1',
				...Object.entries(requests).map(
					([tag, host]) =>
						`echo "${tag}[$(wget -qO- --header "Host: ${host}" http://127.0.0.1/ 2>&1; echo "exit=$?")]"`,
				),
			].join('\n');
			return spawnSync(
				'docker',
				['run', '--rm', '-v', `${dir}:/etc/nginx/conf.d:ro`, NGINX_IMAGE, 'sh', '-c', script],
				{ encoding: 'utf8', timeout: 120_000 },
			).stdout;
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}
	test.skipIf(!imageReady(NGINX_IMAGE))(
		`real nginx (${NGINX_IMAGE}): an unknown name is refused, the site's name answers; an operator's default_server stays the default and passes nginx -t (skipped without Docker or the image)`,
		() => {
			const ctx = productionPlanCtx(NGINX_LE);
			const catchAll = (catchAllWrites(ctx)[0] as { content: string }).content;
			// The image's own default.conf is replaced by the mount: our file and one site.
			const site = `server {\n\tlisten 80;\n\tlisten [::]:80;\n\tserver_name ${ctx.answers.server_name};\n\treturn 200 "instance\\n";\n}\n`;
			const alone = realNginx(
				{ 'dedalo-00-default.conf': catchAll, [`dedalo-${ctx.paths.instance}.conf`]: site },
				{ KNOWN: ctx.answers.server_name, UNKNOWN: 'museo.unknown.example' },
			);
			expect(alone).toContain('test is successful');
			expect(alone).toContain('KNOWN[instance');
			expect(alone).not.toMatch(/UNKNOWN\[instance/);
			expect(alone).toMatch(/UNKNOWN\[[^\]]*exit=[1-9]/);
			// Debian's own default site (default_server on 80), loaded AFTER ours: no clash, it stays.
			const operator =
				'server {\n\tlisten 80 default_server;\n\tlisten [::]:80 default_server;\n\treturn 200 "operator\\n";\n}\n';
			const beside = realNginx(
				{
					'dedalo-00-default.conf': catchAll,
					[`dedalo-${ctx.paths.instance}.conf`]: site,
					'zz-operator-default.conf': operator,
				},
				{ KNOWN: ctx.answers.server_name, UNKNOWN: 'museo.unknown.example' },
			);
			expect(beside).toContain('test is successful');
			expect(beside).toContain('KNOWN[instance');
			expect(beside).toContain('UNKNOWN[operator');
		},
		200_000,
	);
});

describe('Apache: every vhost refuses any Host but its own (g — campaign 3 C3-30)', () => {
	for (const variant of HOST_VARIANTS.filter((v) => v.web === 'apache')) {
		test(`${variantName(variant)}: both vhosts guard the name (421) before anything else rewrites or proxies`, () => {
			const ctx = productionPlanCtx(variant);
			const text = siteText(ctx, certificatePaths(ctx));
			const name = escapeRegExp(ctx.answers.server_name);
			for (const port of [ctx.answers.http_port, ctx.answers.https_port]) {
				const vhost = text.slice(text.indexOf(`<VirtualHost *:${port}>`));
				const body = vhost.slice(0, vhost.indexOf('</VirtualHost>'));
				const guard = body.indexOf(`RewriteCond %{HTTP_HOST} !^${name}(:${port})?$ [NC]`);
				expect(guard, `port ${port}`).toBeGreaterThan(-1);
				expect(body.slice(guard)).toMatch(/^RewriteCond [^\n]*\n\tRewriteRule \^ - \[R=421,L\]/);
				expect(body.indexOf('RewriteEngine On')).toBeLessThan(guard);
				// Nothing is proxied or redirected before the guard.
				for (const before of ['ProxyPass ', 'RewriteRule ^ https://']) {
					const at = body.indexOf(before);
					if (at !== -1) expect(at, `${before} on ${port}`).toBeGreaterThan(guard);
				}
			}
		});
	}

	const HTTPD_IMAGE = 'httpd:2.4-alpine';
	test.skipIf(!imageReady(HTTPD_IMAGE))(
		`real Apache (${HTTPD_IMAGE}): the site's own name is redirected, any other Host gets 421 (skipped without Docker or the image)`,
		() => {
			const dir = mkdtempSync(join(tmpdir(), 'dedalo_apache_guard_'));
			try {
				const variant = HOST_VARIANTS.find(
					(v) => v.web === 'apache' && v.tls === 'letsencrypt',
				) as HostVariant;
				const ctx = productionPlanCtx(variant);
				// Stage 1 (the plain-HTTP vhost): no certificate, no proxy module needed.
				const site = siteText(ctx, null).replace(/\/var\/lib\/dedalo-install\/acme\/\w+/g, '/tmp');
				writeFileSync(join(dir, 'site.conf'), site);
				const script = [
					"sed -i 's|^#LoadModule rewrite_module|LoadModule rewrite_module|' /usr/local/apache2/conf/httpd.conf",
					'mkdir -p /var/www/empty',
					'echo "Include /site/site.conf" >> /usr/local/apache2/conf/httpd.conf',
					'httpd -t 2>&1 || exit 9',
					'httpd -k start; sleep 1',
					// One raw request each (busybox: no curl): the status line only.
					`printf 'GET /x HTTP/1.1\\r\\nHost: ${ctx.answers.server_name}\\r\\nConnection: close\\r\\n\\r\\n' | nc 127.0.0.1 80 | head -1 | sed 's/^/KNOWN[/; s/ [A-Za-z].*$/]/'`,
					"printf 'GET /x HTTP/1.1\\r\\nHost: museo.unknown.example\\r\\nConnection: close\\r\\n\\r\\n' | nc 127.0.0.1 80 | head -1 | sed 's/^/UNKNOWN[/; s/ [A-Za-z].*$/]/'",
				].join('\n');
				const run = spawnSync(
					'docker',
					['run', '--rm', '-v', `${dir}:/site:ro`, HTTPD_IMAGE, 'sh', '-c', script],
					{ encoding: 'utf8', timeout: 120_000 },
				);
				expect(run.stdout).toContain('Syntax OK');
				expect(run.stdout).toContain('KNOWN[HTTP/1.1 301]');
				expect(run.stdout).toContain('UNKNOWN[HTTP/1.1 421]');
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		150_000,
	);
});
