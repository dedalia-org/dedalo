/**
 * The publication-host operator page (docs/install/publication_host.md) states what
 * `provision check` and `release.install` actually enforce: an operator who follows it
 * must not meet a refusal the page never warned about.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT } from '../../publication/host_agent/src/provision/cli';
import {
	APACHE_MODULES,
	SELINUX_BOOLEANS,
	SELINUX_READ_ONLY_BOOLEANS,
} from '../../publication/host_agent/src/provision/exec_contract';
import { INIT_FLAGS } from '../../publication/host_agent/src/provision/init/args';
import { DEFAULTS, draftServesV1 } from '../../publication/host_agent/src/provision/init/draft';
import { parseDraft } from '../../publication/host_agent/src/provision/init/draft_schema';
import { OS_SUPPORT } from '../../publication/host_agent/src/provision/init/parse/os';
import { rerunCommand } from '../../publication/host_agent/src/provision/init/run';
import type { HostDeclaration } from '../../publication/host_agent/src/provision/layout';
import {
	BUN_KERNEL_FLOOR,
	derive,
	FORBIDDEN_V1_USERS,
	fpmLayout,
	HOME_ROOT_MODE,
	INSTANCE_PATTERN,
	LISTEN_HOST_PATTERN,
	layoutPaths,
	listenHostProblem,
	NGINX_MAP_INCLUDE_PATH,
	PUBHOST_GROUP,
	SYSTEM_LAYOUT,
	SYSTEMD_FLOOR,
	V1_PHP_FLOOR,
	webLogBase,
} from '../../publication/host_agent/src/provision/layout';
import { INIT_BASE, LOCK_WAIT_MS } from '../../publication/host_agent/src/provision/lock';
import { AGENT_TREE_WALK_CAP } from '../../publication/host_agent/src/provision/plan';
import { fpmPoolBody } from '../../publication/host_agent/src/provision/render/fpm_pool';
import {
	apacheWebInclude,
	PHP_HANDLER_PATTERN,
} from '../../publication/host_agent/src/provision/render/web_include';
import { selinuxRules } from '../../publication/host_agent/src/provision/selinux';
import {
	selinuxModulePath,
	V2_TREE_TYPE,
} from '../../publication/host_agent/src/provision/selinux_module';

const repoRoot = join(import.meta.dir, '..', '..');
const page = readFileSync(join(repoRoot, 'docs/install/publication_host.md'), 'utf8');
const example = JSON.parse(
	readFileSync(
		join(repoRoot, 'publication/host_agent/deploy/examples/instance.example.json'),
		'utf8',
	),
) as { listen: { host: string; port: number } };

/**
 * A changelog fragment's text wherever it lives: changes/unreleased/ until a release is
 * cut, then changes/<version>/ (`bun run changelog release` MOVES it) — a gate that names
 * the unreleased path goes red at every release cut.
 */
function fragmentText(name: string): string {
	const changes = join(repoRoot, 'changes');
	const found = readdirSync(changes, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(changes, entry.name, name))
		.filter((path) => existsSync(path));
	expect(found, `exactly one changes/*/${name}`).toHaveLength(1);
	return readFileSync(found[0] as string, 'utf8');
}

/** The page between two headings (the end heading excluded). */
function section(start: string, end: string): string {
	const from = page.indexOf(start);
	const to = page.indexOf(end, from + 1);
	if (from < 0 || to < 0) throw new Error(`no section ${start} … ${end}`);
	return page.slice(from, to);
}

function stepTwoDeclaration(): HostDeclaration {
	const block = page.match(/### 2\. Declare the instance[\s\S]*?```json\n([\s\S]*?)\n```/);
	if (!block?.[1]) throw new Error('step 2 has no json declaration');
	return JSON.parse(block[1]) as HostDeclaration;
}

/** The fenced block of `lang` that follows `marker`. */
function fenceAfter(marker: string, lang: string): string {
	const at = page.indexOf(marker);
	if (at < 0) throw new Error(`no ${marker}`);
	const open = page.indexOf(`\`\`\`${lang}\n`, at);
	const close = page.indexOf('\n```', open + 4 + lang.length);
	return page.slice(open + 4 + lang.length, close + 1);
}

/** Markdown table rows (first cell, every cell) of a section. */
function rows(text: string): string[][] {
	return text
		.split('\n')
		.filter((line) => line.startsWith('| ') && !line.startsWith('| ---'))
		.map((line) => line.slice(2, -2).split(' | '));
}

const GUIDED = section('## Guided install (`provision init`)', '\n## Install\n');

describe('publication host operator page', () => {
	test('every agent URL names an IPv4 literal the schema accepts (the cert SAN), never a hostname', () => {
		const hosts = [...page.matchAll(/https:\/\/([^/:\s]+):(\d+)\/publication\/host_agent/g)];
		expect(hosts.length).toBeGreaterThan(0);
		for (const [, host, port] of hosts) {
			expect(LISTEN_HOST_PATTERN.test(host!), `${host} is not a listen.host`).toBe(true);
			expect(`${host}:${port}`).toBe(`${example.listen.host}:${example.listen.port}`);
		}
	});

	test('every bracketed IPv6 agent URL names a listen.host the agent grammar accepts, as written (2026-11-25)', () => {
		// The IPv4 scan above cannot see `https://[fd00:20::2]:8471/…` (its host class stops at the
		// first ':'), so the IPv6 example step 7 shows would go unchecked without this one. The
		// page writes the bracketed form a URL needs; the grammar judges the bare literal inside,
		// canonical spelling included — the doc must show what `listen.host` accepts.
		const hosts = [...page.matchAll(/https:\/\/\[([^\]\s]+)\]:(\d+)\/publication\/host_agent/g)];
		expect(hosts.length, 'step 7 shows the IPv6 health request').toBeGreaterThan(0);
		for (const [, host, port] of hosts) {
			expect(listenHostProblem(host), `${host} is not a listen.host`).toBeNull();
			expect(Number(port)).toBe(example.listen.port);
		}
		// Positive control: the same scan refuses a link-local example (zone-id-only, §2.2 of the spec).
		expect(listenHostProblem('fe80::2')).not.toBeNull();
	});

	test('step 3 says listen.host is an IPv4 address literal, no hostname, no wildcard', () => {
		expect(page).toMatch(/private IPv4\s+address/);
		expect(page).toMatch(/no hostname, no\s+wildcard/);
	});

	test('step 1 states the code-trust preconditions plan.ts refuses on', () => {
		expect(page).toMatch(/every parent directory/);
		expect(page).toMatch(/not a symbolic link/);
		expect(page).toContain('.test-tmp/');
		expect(page).toMatch(/a test scratch tree/);
	});

	test('step 2 declares BEFORE step 3 creates the accounts, and its declaration derives (one and two machines)', () => {
		expect(page.indexOf('### 2. Declare the instance')).toBeGreaterThan(0);
		expect(page.indexOf('### 3. Create the accounts')).toBeGreaterThan(
			page.indexOf('### 2. Declare the instance'),
		);
		const declared = stepTwoDeclaration();
		// Same keys as the committed one-machine example (derive() reads, the schema refuses unknown keys).
		const committed = JSON.parse(
			readFileSync(
				join(
					repoRoot,
					'publication/host_agent/deploy/examples/instance.single_machine.example.json',
				),
				'utf8',
			),
		) as Record<string, unknown>;
		// The manual path declares the optional `site` (decision A: apply writes the v1 pool and
		// the web include); every other key is the committed one-machine example's.
		expect(Object.keys(declared).sort()).toEqual([...Object.keys(committed), 'site'].sort());
		const one = derive(declared);
		const { engine_group: _socketOnly, ...rest } = declared;
		derive({ ...rest, listen: { kind: 'tls', host: '10.20.0.2', port: 8471 } });
		// Step 3's commands name exactly the accounts the declaration does, and the host group.
		const step3 = section('### 3. Create the accounts', '### 4. Provision');
		expect(step3).toContain(`--user-group ${one.identity.agentUser}`);
		expect(step3).toContain(`--user-group ${one.v1?.user}`);
		expect(step3).toContain(`groupadd --system ${one.identity.v2Group}`);
		expect(step3).toContain(`-g ${one.identity.v2Group} ${one.identity.v2User}`);
		expect(step3).toContain(`groupadd --system ${PUBHOST_GROUP}`);
		// v1 runs its own pool (decision A): never the web server's or a catch-all account.
		expect(FORBIDDEN_V1_USERS).not.toContain(one.v1?.user);
		expect(one.v1?.user).toBe(DEFAULTS.v1User(one.instance));
		for (const user of FORBIDDEN_V1_USERS) expect(page).toContain(`\`${user}\``);
	});

	test('the shared API configuration step exists, with its refusal in troubleshooting', () => {
		expect(page).toMatch(/### \d+\. Create the API configuration files/);
		expect(page).toContain('publication_api/v2/shared/v2.env');
		expect(page).toMatch(/\| an API install is refused: `shared_config_missing` \|/);
	});

	test('the engine bundle step is marked two machines only (a socket listener issues none)', () => {
		expect(page).toMatch(
			/### \d+\. Carry the engine bundle to the work system \(two machines only\)/,
		);
	});

	test('step 3 does not claim the agent calls Bun (no named command runs BUN_BIN)', () => {
		expect(page).not.toMatch(/runtimes the agent calls/);
	});

	test('an unreachable agent is never told its withdrawn files already 404 (marker may remain)', () => {
		// media_copy_apply.ts records the pending marker BEFORE `media.mark false`; an
		// unreachable agent keeps its marker, so its gate still serves the files.
		const rows = page
			.split('\n')
			.filter((line) => line.startsWith('| a pending deletion turns red'));
		const unreachable = rows.find((line) => /could not be reached/.test(line));
		expect(unreachable).toBeDefined();
		expect(unreachable).toMatch(/STILL BE PUBLIC/);
		expect(unreachable).not.toMatch(/already answers "not found"/);
		expect(page).toMatch(
			/cannot be reached the marker stays, and the files are \*\*still public\*\*/,
		);
		const fragment = fragmentText('publication-host-lockstep-copy-probe.md');
		expect(fragment).not.toMatch(/"not found" at once/);
	});

	test('the public check states the probe.ts verdict order: failure beats unknown', () => {
		expect(page).toMatch(/even when the other file could not be checked/);
		const spec = readFileSync(join(repoRoot, 'engineering/PUBLICATION_HOST_SPEC.md'), 'utf8');
		expect(spec).toMatch(
			/is `failed` \(red\), with both statuses recorded,\s+even when the other side is `unknown`/,
		);
	});

	test('the API push is promised after a CODE update/restore only; a database restore sends nothing', () => {
		// post_restore.ts runs publication_apis DRY; only boot_confirm (a code sentinel) pushes.
		const fragment = fragmentText('publication-host-lockstep-copy-probe.md');
		for (const text of [page, fragment]) {
			expect(text).not.toMatch(/after every restore/i);
			expect(text).not.toMatch(/every code update or restore/i);
			expect(text).toMatch(/code update or code restore/);
			expect(text).toMatch(/database restore does not change the code/i);
		}
	});

	test('the agent_dir walk cap the page quotes IS plan.ts AGENT_TREE_WALK_CAP; the README names the constant', () => {
		// The operator sizes agent_dir by this number: a cap change must move the page with it.
		const quoted = [...page.matchAll(/(?:stops at|more than) (\d[\d,]*) entries/g)].map(([, n]) =>
			Number(n!.replaceAll(',', '')),
		);
		expect(quoted.length).toBeGreaterThanOrEqual(2);
		for (const n of quoted) expect(n).toBe(AGENT_TREE_WALK_CAP);
		const readme = readFileSync(join(repoRoot, 'publication/host_agent/README.md'), 'utf8');
		expect(readme).toContain('`AGENT_TREE_WALK_CAP`');
		expect(readme).not.toMatch(/\d{4,} entries/);
	});
});

describe('the guided install (provision init) states what the code does', () => {
	test('the section exists BEFORE the manual install, with its RHEL subsection', () => {
		expect(page.indexOf('## Guided install (`provision init`) {#guided-install}')).toBeGreaterThan(
			0,
		);
		expect(page.indexOf('## Guided install')).toBeLessThan(page.indexOf('### 0. Prepare the site'));
		expect(GUIDED).toContain('### RHEL, Rocky and Alma (9 and 10) {#rhel-rocky-and-alma}');
		expect(GUIDED).toContain('Whoever can write the source can become root');
	});

	test('the flag table IS INIT_FLAGS (order and value placeholders); --declaration is said to be refused', () => {
		const spelled = INIT_FLAGS.map((f) => (f.value === null ? f.flag : `${f.flag} ${f.value}`));
		const initRows = rows(
			section('| `provision init` flag | Meaning |', 'Pass them after `--`'),
		).slice(1);
		const table = initRows.map((cells) => (cells[0] ?? '').replace(/`/g, ''));
		expect(table).toEqual(spelled);
		// The hand-over flags install.sh passes are said to be its own.
		for (const f of INIT_FLAGS.filter((x) =>
			['--source', '--source-digest-confirmed', '--bun-archive', '--bun-sums'].includes(x.flag),
		)) {
			const row = initRows.find((cells) => (cells[0] ?? '').startsWith(`\`${f.flag} `));
			expect(row?.[1]).toContain('`install.sh` passes');
		}
		expect(GUIDED).toContain('`--declaration` is refused');
	});

	test('the exit-code table names cli.ts EXIT 0..5, busy for check only', () => {
		const exit = rows(
			section('| Exit code | Meaning |\n| --- | --- |\n| 0 | done', '| `provision init` flag'),
		);
		expect(exit.slice(1).map((cells) => Number(cells[0]))).toEqual(Object.values(EXIT).sort());
		expect(exit.find((cells) => cells[0] === String(EXIT.BUSY))?.[1]).toMatch(
			/^`provision check` only/,
		);
	});

	test('the lock waits and the init base the page quotes are lock.ts constants', () => {
		expect(GUIDED).toContain(`${INIT_BASE}/museum_org/`);
		const flat = GUIDED.replace(/\s+/g, ' ');
		expect(flat).toContain(`waits ${LOCK_WAIT_MS.instance / 1000} seconds, then is refused`);
		expect(flat).toContain(
			`waits ${LOCK_WAIT_MS.instance / 1000} seconds, then ends with exit ${EXIT.BUSY}`,
		);
	});

	test('the draft example is a draft parseDraft accepts; the proposed defaults are draft.ts DEFAULTS', () => {
		const block = section('### The draft', '### The report and its lists').match(
			/```json\n([\s\S]*?)\n```/,
		);
		if (!block?.[1]) throw new Error('the draft section has no json');
		const draft = parseDraft(JSON.parse(block[1]), 'the guide');
		expect(INSTANCE_PATTERN.test(draft.instance)).toBe(true);
		// The first draft is the recommended v2-only one; the second asks for v1 too.
		const drafts = [
			...section('### The draft', '### The report and its lists').matchAll(
				/```json\n([\s\S]*?)\n```/g,
			),
		].map((m) => parseDraft(JSON.parse(m[1] ?? ''), 'the guide'));
		expect(drafts.map((d) => draftServesV1(d))).toEqual([false, true]);
		for (const name of [DEFAULTS.agentUser, DEFAULTS.v1User, DEFAULTS.v2User, DEFAULTS.v2Unit]) {
			expect(GUIDED).toContain(`\`${name(draft.instance)}\``);
		}
		expect(GUIDED).toContain(`on port ${DEFAULTS.v2Port}`);
	});

	test('the two layouts are layout.ts layoutPaths; the home command uses HOME_ROOT_MODE', () => {
		const home = layoutPaths('home', 'museum_org', '/home/museum.org');
		const system = layoutPaths('system', 'museum_org', null);
		const table = rows(
			section('| | `home` (the default) | `system` (the alternative) |', 'Root runs the Bun'),
		);
		const cell = (label: string, column: 1 | 2) =>
			table.find((cells) => cells[0] === label)?.[column];
		expect(cell('state root', 1)).toBe(`\`${home.state_root}\``);
		expect(cell('agent code', 1)).toBe(`\`${home.agent_dir}\``);
		expect(cell("the site's Bun", 1)).toBe(`\`${home.bun_bin}\``);
		// Owner decision 1(c): the site's web logs are OUTSIDE the home (layout.ts webLogBase), never a home path.
		const logs = cell("the site's web server logs", 1) ?? '';
		expect(logs.startsWith(`\`${join(webLogBase('apache', 'debian'), 'museum.org')}\``)).toBe(true);
		expect(logs).toContain(`\`${webLogBase('apache', 'el')}/…\``);
		expect(logs).toContain(`\`${webLogBase('nginx', 'debian')}/…\``);
		expect(logs).not.toContain('/home/');
		expect(cell('state root', 2)).toBe(`\`${system.state_root}\``);
		expect(cell('agent code', 2)).toBe(`\`${system.agent_dir}\``);
		expect(cell("the site's Bun", 2)).toBe(`\`${system.bun_bin}\``);
		const mode = `0${HOME_ROOT_MODE.toString(8)}`;
		expect(GUIDED).toContain(`chown root:root /home/museum.org && chmod ${mode} /home/museum.org`);
		expect(GUIDED.replace(/\s+/g, ' ')).toContain(`with \`${mode}\`, every local account`);
	});

	test('the RHEL FPM table is layout.ts fpmLayout for AppStream and Remi', () => {
		const table = rows(
			section(
				'| | AppStream (`el`, 8.2) | Remi (`remi`, 8.3) |',
				"EL's `/etc/httpd/conf.d/php.conf`",
			),
		);
		const el = fpmLayout('museum_org', 'el', '8.2', 'apache');
		const remi = fpmLayout('museum_org', 'remi', '8.3', 'apache');
		const cell = (label: string, column: 1 | 2) =>
			table.find((cells) => cells[0] === label)?.[column];
		expect([cell('pool file', 1), cell('service', 1), cell('socket', 1)]).toEqual(
			[el.poolFile, el.unit, el.listen].map((v) => `\`${v}\``),
		);
		expect([cell('pool file', 2), cell('service', 2), cell('socket', 2)]).toEqual(
			[remi.poolFile, remi.unit, remi.listen].map((v) => `\`${v}\``),
		);
		expect(GUIDED.replace(/\s+/g, ' ')).toContain(`below the v1 floor of ${V1_PHP_FLOOR}`);
	});

	test('the SELinux table is selinux.ts selinuxRules, row for row (path, -f, type)', () => {
		const declared = stepTwoDeclaration();
		const layout = derive({
			...declared,
			web: { server: 'nginx', unit: 'nginx', nginx_map: 'conf_d' },
			media: { mode: 'copy', root: '/srv/dedalo/media' },
		});
		const rules = selinuxRules(layout);
		const table = rows(section('| Path | `-f` | Type | Why |', '`-f d` is the directory alone'))
			.slice(1)
			.map((cells) =>
				cells
					.slice(0, 3)
					.map((cell) => cell.replace(/`/g, ''))
					.join(' '),
			);
		expect(table).toEqual(rules.map((rule) => `${rule.path} ${rule.fileType} ${rule.type}`));
		// One v2 type on every layout: the module's own table names its type, its rule, and the v2
		// tree of BOTH layouts (the home one is the table above's own row).
		const homeV2 = rules.find((rule) => rule.row === 'S/publication_api/v2');
		expect(homeV2?.type).toBe(V2_TREE_TYPE);
		const system = derive({
			...declared,
			state_root: `${SYSTEM_LAYOUT.stateBase}/${declared.instance}`,
			agent_dir: SYSTEM_LAYOUT.agentDir,
			bun_bin: SYSTEM_LAYOUT.bunBin,
		});
		const v2 = selinuxRules(system).find((rule) => rule.row === 'S/publication_api/v2');
		expect(v2?.type).toBe(V2_TREE_TYPE);
		const moduleRow =
			GUIDED.split('\n').find((line) =>
				line.startsWith(`| \`${V2_TREE_TYPE}\`, the rule \`-f ${v2?.fileType}\` on the v2 tree (`),
			) ?? '';
		expect(moduleRow).toContain(`\`${homeV2?.path}\``);
		expect(moduleRow).toContain(`\`${v2?.path}\``);
		expect(GUIDED).toContain(`\`${selinuxModulePath(system)}\``);
	});

	test('the booleans init may ask for are SELINUX_BOOLEANS minus the read-only one, which is named as read only', () => {
		const table = rows(
			section(
				'| Boolean | When init asks | What it lets httpd do |',
				'`httpd_graceful_shutdown` is read',
			),
		)
			.slice(1)
			.flatMap((cells) => [...(cells[0] ?? '').matchAll(/`([a-z_]+)`/g)].map((m) => m[1]));
		const writable = SELINUX_BOOLEANS.filter((b) => !SELINUX_READ_ONLY_BOOLEANS.includes(b));
		expect(new Set(table)).toEqual(new Set(writable));
		for (const b of SELINUX_READ_ONLY_BOOLEANS)
			expect(GUIDED.replace(/\s+/g, ' ')).toContain(`\`${b}\` is read, never changed`);
	});

	test('the supported family is OS_SUPPORT (EL 9 and 10, never 8); EL 8 is refused with the systemd and kernel floors', () => {
		const el = OS_SUPPORT.filter((row) => row.family === 'el').map((row) => row.version);
		expect(el).toEqual(['9', '10']);
		const flat = GUIDED.replace(/\s+/g, ' ');
		expect(flat).toContain(`RHEL, Rocky and Alma ${el.join(' and ')}.`);
		expect(flat).toContain('**EL 8 is not supported.**');
		expect(flat).toContain(`the units need systemd ${SYSTEMD_FLOOR}`);
		expect(flat).toContain(`Bun documents kernel ${BUN_KERNEL_FLOOR} or newer`);
	});

	test('the decision kinds, the vhost blockers and the re-run command are quoted as the code prints them (2026-11-25)', () => {
		// Spelling-level on purpose: an operator searches the page for the line the terminal shows,
		// so each quoted line must still exist in the module that prints it. The class RULE itself is
		// gated in publication/host_agent/tests/init_decision_class.test.ts.
		const source = (path: string) =>
			readFileSync(join(repoRoot, 'publication/host_agent/src/provision/init', path), 'utf8');
		const tty = source('tty.ts');
		const run = source('run.ts');
		const draft = source('draft.ts');
		// The whole page: the guided-install section AND its troubleshooting rows quote these lines.
		const flat = page.replace(/\s+/g, ' ');
		const quoted: [string, string, string][] = [
			['— type it)', tty, 'tty.ts typed prompt'],
			['— Enter takes it)', tty, 'tty.ts ordinary prompt'],
			[
				'this decision changes your files or the whole host: Enter takes nothing',
				tty,
				'tty.ts enterRefusedLine',
			],
			['auto: the only option —', run, 'run.ts auto line'],
			['need your action before anything is done', run, 'run.ts blocking needs-action refusal'],
			[
				'only redirects claim it: the vhost they send to (the TLS one) is missing',
				draft,
				'draft.ts chooseVhost',
			],
			['different vhosts claiming ServerName', draft, 'draft.ts crowded'],
		];
		for (const [text, code, where] of quoted) {
			expect(flat, `the page quotes ${where}`).toContain(text);
			expect(code, `${where} still prints it`).toContain(text);
		}
		// The re-run command the page shows is rerunCommand's, for the page's own example names.
		expect(flat).toContain(
			`\`${rerunCommand('museum_org', '/home/museum.org/host_agent', true)}\``.replace(/\s+/g, ' '),
		);
	});
});

describe('the manual path follows decision A (the v1 pool) and the host map (Q1)', () => {
	const layout = derive(stepTwoDeclaration());

	test('step 9 shows the web include EXACTLY as render/web_include.ts writes it for step 2', () => {
		expect(fenceAfter('**What the include holds**', 'apache')).toBe(
			`${apacheWebInclude(layout).trimEnd()}\n`,
		);
		expect(apacheWebInclude(layout)).toContain(`<FilesMatch "${PHP_HANDLER_PATTERN}">`);
		expect(apacheWebInclude(layout)).toContain('<If "-f %{REQUEST_FILENAME}">');
	});

	test('step 9 shows the v1 pool EXACTLY as render/fpm_pool.ts writes it, at its derived path', () => {
		expect(fenceAfter('**The v1 pool** that `apply` wrote', 'ini')).toBe(
			`${fpmPoolBody(layout).trimEnd()}\n`,
		);
		expect(page).toContain(
			`**The v1 pool** that \`apply\` wrote, \`${layout.site?.v1?.fpm.poolFile}\``,
		);
	});

	test('step 9 references the include by its derived path, and enables exactly APACHE_MODULES', () => {
		const step9 = section("### 9. Map the APIs into the site's virtual host", '### 10. First use');
		expect(step9).toContain(`IncludeOptional ${layout.instanceDir}/web.apache.conf`);
		const a2enmod = step9.match(/^a2enmod (.+)$/m)?.[1]?.split(' ') ?? [];
		expect(new Set(a2enmod)).toEqual(new Set(APACHE_MODULES));
		expect(step9).toContain(NGINX_MAP_INCLUDE_PATH);
	});

	test('the v2-only declaration (the recommended shape) derives with no v1, and its include is EXACTLY the v2 proxy', () => {
		const v2Only = JSON.parse(fenceAfter('**A v2-only declaration**', 'json')) as HostDeclaration;
		const { v1: _v1, php_bin: _php, site, ...rest } = stepTwoDeclaration();
		const { site: v2Site, ...v2Rest } = v2Only;
		// The same declaration as step 2, minus the three v1 keys, plus site.os_family.
		expect(v2Rest).toEqual(rest);
		expect(v2Site).toEqual({ domain: site?.domain ?? '(no site)', os_family: 'debian' });
		const derived = derive(v2Only);
		expect(derived.v1).toBeNull();
		expect(derived.servedApis).toEqual(['v2']);
		expect(fenceAfter('**On a v2-only site the include holds**', 'apache')).toBe(
			`${apacheWebInclude(derived).trimEnd()}\n`,
		);
		expect(apacheWebInclude(derived)).not.toContain('SetHandler');
	});

	test('sentences that became false are gone', () => {
		expect(page).not.toContain('The provisioner never creates accounts');
		expect(page).not.toMatch(/kept\. `apply` never reloads the web server\./);
		expect(page).not.toContain('The one-time `http{}` map\n  include stays manual');
		expect(page).not.toContain('gpg --verify SHASUMS256.txt.asc SHASUMS256.txt');
		expect(page).not.toMatch(/runs the site's PHP-FPM pool, and so the v1 API/);
	});
});

describe('every page that describes the hand-placed nginx map says when NOT to place it (spec §10)', () => {
	const flat = (path: string) => readFileSync(join(repoRoot, path), 'utf8').replace(/\s+/g, ' ');
	test.each([
		'docs/core/system/media_protection.md',
		'docs/administration/configuration/media_protection.md',
		'docs/install/troubleshooting.md',
		'docs/install/reverse_proxy.md',
	])('%s', (path) => {
		expect(flat(path)).toContain(
			'On a publication host provisioned with `provision init`, the `http{}` map is pushed by **Apply media rules** into the host-wide include and must not be placed by hand',
		);
	});

	test('engineering/MEDIA_PROTECTION.md, with the root renderer in its renderer list', () => {
		const text = flat('engineering/MEDIA_PROTECTION.md');
		expect(text).toContain(
			'on a publication host provisioned with `provision init`, the http{} map is pushed by apply_rules into the host-wide include and must not be placed by hand',
		);
		expect(text).toContain('`publication/host_agent/src/rules/host_map_main.ts`');
		expect(text).toContain(NGINX_MAP_INCLUDE_PATH);
	});
});
