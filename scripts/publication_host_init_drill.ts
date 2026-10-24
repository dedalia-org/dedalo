#!/usr/bin/env bun
/**
 * THE `provision init` DRILLS — the guided install (engineering/PUBLICATION_HOST_SPEC.md §9,
 * §9.11) end to end on a REAL host: real accounts, real systemd, real polkit, a real
 * PHP-FPM and web-server reload, a real `kill -9` mid-change. Both are local-only
 * (engineering/CI.md, *Local-only drills of the guided install*; the reasons are rows of
 * test/unit/tier_wiring_tripwire.test.ts LOCAL_ONLY_SCRIPTS).
 *
 *   bun run test:pubhost:init       Debian: a disposable PRIVILEGED container with systemd as
 *                                   PID 1, on the CI image's Debian trixie base (its digest is
 *                                   read from ci/Dockerfile), with apache2, nginx, php-fpm and
 *                                   polkitd. Needs a Docker daemon that may start --privileged.
 *   … --in-place (Debian)           Debian: run AS ROOT ON a disposable Debian/Ubuntu VM (systemd at
 *                                   boot, AppArmor enforcing on a real kernel; the container never
 *                                   enforces it). Same marker refusal as EL; the in-place-only legs
 *                                   (no-apparmor-denial) join the plan.
 *   bun run test:pubhost:init:el    EL: `--family el --in-place`, run AS ROOT ON a disposable
 *                                   RHEL/Rocky/Alma 9 or 10 VM with SELinux enforcing. Refuses unless
 *                                   /etc/dedalo_init_drill_host exists and getenforce says
 *                                   Enforcing, so it can never run on a real install.
 *
 * WHAT IT NEVER DOES: import an init module. The guided install is driven ONLY as a child —
 * `sh <source>/publication/host_agent/deploy/install.sh …` and the provisioner CLI — so the
 * drill proves the shipped entry point, and test/unit/tool_lossless_writeback_tripwire's
 * host-agent-package class is untouched. Facts the drill needs from the agent package (the
 * EL ratchet's input list, the S9 rules of a declaration) come from a CHILD `bun -e`.
 *
 * Flags:
 *   --family debian|el     default debian
 *   --in-place             run on THIS host (EL: required; Debian: a disposable Debian/Ubuntu VM
 *                          instead of docker — the only Debian run under a real AppArmor kernel;
 *                          same marker refusal as EL)
 *   --record               EL, after a green run: write the EL drill record (engineering/)
 *   --capture <dir>        in place: keep the raw discovery outputs (the typed fixtures' replacements)
 *   --media-nfs <src>      EL: the NFS export the network-media leg mounts (`host:/export`)
 *   --skip <leg>           skip one leg BY NAME (repeatable); the record lists every skipped leg,
 *                          and a record with a skipped required leg is refused; a name that
 *                          matches no leg of this run is refused (exit 2) — a typo never
 *                          silently runs the leg it meant to skip, nor reads as a skip
 *   --keep                 leave the container (Debian) for inspection
 *   --plan                 print the legs and exit 0, touching nothing
 *
 * Exit: 0 every leg green · 1 a leg red · 2 the drill cannot run here (no docker, not root,
 * no marker, not enforcing, a --skip naming no leg) — RED, never a skip · 3 INCOMPLETE: no leg
 * red, but a REQUIRED leg was skipped — never 'OK' over a property nobody measured.
 *
 * THE PROMPT TABLE (`PROMPTS`) is the one place that knows how init's terminal asks: the
 * source-digest confirmation, `Apply these N changes? [y/N]`, a decision's typed option, the
 * hidden secrets asked twice. The secret steps run through a pty (`script -qec`), as the
 * spec requires; the pre-created-API-files variant runs without one (`--yes`).
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { escapeRegExp } from '../test/helpers/regex_escape.ts';

export const REPO_ROOT = resolve(import.meta.dir, '..');
export const AGENT_DIR = join(REPO_ROOT, 'publication/host_agent');
const INSTALL_SH_REL = 'publication/host_agent/deploy/install.sh';
/** Created BY HAND on a drill VM; the EL drill refuses any host without it. */
export const DRILL_HOST_MARKER = '/etc/dedalo_init_drill_host';
/** The EL drill record, written only by `--record` after a green run. */
export const EL_DRILL_RECORD = join(REPO_ROOT, 'engineering/el_drill_record.json');
const TAG = '[init_drill]';

/* ── arguments ─────────────────────────────────────────────────────────────────────── */

export interface DrillArgs {
	readonly family: 'debian' | 'el';
	readonly inPlace: boolean;
	readonly record: boolean;
	readonly capture: string | null;
	readonly mediaNfs: string | null;
	readonly skip: readonly string[];
	readonly keep: boolean;
	readonly plan: boolean;
}

export function parseDrillArgs(argv: readonly string[]): DrillArgs | { readonly error: string } {
	let family: 'debian' | 'el' = 'debian';
	let inPlace = false;
	let record = false;
	let capture: string | null = null;
	let mediaNfs: string | null = null;
	const skip: string[] = [];
	let keep = false;
	let plan = false;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const value = (): string | null => {
			const next = argv[i + 1];
			if (next === undefined || next.startsWith('--')) return null;
			i += 1;
			return next;
		};
		if (arg === '--family') {
			const v = value();
			if (v !== 'debian' && v !== 'el') return { error: '--family is debian or el' };
			family = v;
		} else if (arg === '--in-place') inPlace = true;
		else if (arg === '--record') record = true;
		else if (arg === '--keep') keep = true;
		else if (arg === '--plan') plan = true;
		else if (arg === '--capture') {
			capture = value();
			if (capture === null || !capture.startsWith('/'))
				return { error: '--capture needs an absolute directory' };
		} else if (arg === '--media-nfs') {
			mediaNfs = value();
			if (mediaNfs === null || !/^[A-Za-z0-9.-]+:\/[A-Za-z0-9._/-]*$/.test(mediaNfs))
				return { error: '--media-nfs needs host:/export' };
		} else if (arg === '--skip') {
			const v = value();
			if (v === null) return { error: '--skip needs a leg name' };
			skip.push(v);
		} else return { error: `unknown argument '${arg}'` };
	}
	if (family === 'el' && !inPlace)
		return { error: 'the EL drill runs ON the VM: --family el --in-place' };
	if (capture !== null && !inPlace)
		return { error: "--capture keeps a real host's discovery outputs: --in-place only" };
	if (record && family !== 'el')
		return { error: '--record writes the EL drill record: --family el only' };
	return { family, inPlace, record, capture, mediaNfs, skip, keep, plan };
}

/* ── processes ─────────────────────────────────────────────────────────────────────── */

export interface Done {
	readonly code: number;
	readonly out: string;
	readonly err: string;
}

/** One child, async (the mock HTTPS mirror and the pty runs live beside it). */
export async function spawnText(
	argv: readonly string[],
	opts: { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number } = {},
): Promise<Done> {
	const child = Bun.spawn([...argv], {
		cwd: opts.cwd ?? REPO_ROOT,
		env: opts.env ?? {
			PATH: process.env.PATH ?? '/usr/bin:/bin',
			HOME: process.env.HOME ?? '/root',
		},
		stdin: opts.stdin === undefined ? 'ignore' : new Blob([opts.stdin]),
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 600_000);
	const [out, err, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	clearTimeout(timer);
	return { code, out, err };
}

/** Where the drill's commands run: inside the container (docker exec) or on this host. */
export interface Runner {
	readonly where: string;
	sh(script: string, opts?: { stdin?: string; timeoutMs?: number }): Promise<Done>;
	/** argv to start a long-lived interactive child (the pty runs) with stdin piped. */
	interactive(script: string): string[];
}

export function dockerRunner(container: string): Runner {
	return {
		where: `container ${container}`,
		sh: (script, opts = {}) =>
			spawnText(['docker', 'exec', '-i', container, 'sh', '-c', script], {
				stdin: opts.stdin,
				timeoutMs: opts.timeoutMs,
			}),
		interactive: (script) => ['docker', 'exec', '-i', container, 'sh', '-c', script],
	};
}

export function localRunner(): Runner {
	return {
		where: 'this host',
		sh: (script, opts = {}) =>
			spawnText(['sh', '-c', script], {
				stdin: opts.stdin,
				timeoutMs: opts.timeoutMs,
				env: {
					PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
					HOME: '/root',
					LC_ALL: 'C',
				},
			}),
		interactive: (script) => ['sh', '-c', script],
	};
}

/**
 * The tar the drill packs the source with: on macOS, bsdtar stores extended attributes as `._<name>`
 * AppleDouble entries, which land in the target's checkout as files of their own — the source
 * digest the drill confirms (computed over the checkout) then differs from the one install.sh
 * computes over its staged copy of the manifest, and every non-terminal run is refused. GNU tar
 * ignores the variable.
 */
const TAR_ENV: Record<string, string> = {
	PATH: process.env.PATH ?? '/usr/bin:/bin',
	HOME: process.env.HOME ?? '/tmp',
	COPYFILE_DISABLE: '1',
};

/** Single-quote one shell word (every value the drill passes is its own constant or a path it made). */
export function q(word: string): string {
	return `'${word.replace(/'/g, `'\\''`)}'`;
}

/* ── the pty and the prompt table ──────────────────────────────────────────────────── */

export interface PromptRule {
	readonly name: string;
	readonly pattern: RegExp;
	/** What to type (a newline is appended); null = the prompt is unexpected → red. */
	readonly answer: (match: RegExpMatchArray, secrets: DrillSecrets) => string | null;
}

export interface DrillSecrets {
	readonly dbPassword: string;
	readonly apiWebUserCode: string;
}

/** The drill's answers to the visible prompts that have no default. */
const DRILL_VISIBLE: Readonly<Record<string, string>> = Object.freeze({
	'v1 database user': 'drill_v1',
	'v2 database user': 'drill_v2',
	'v2 database names (comma list)': 'drill_web',
	'v1 database name': 'drill_web',
	'v1 API entity': 'drill',
});

/**
 * HOW INIT ASKS (spec §1.2 TTY). The only place the drill knows it; adjust it with init/tty.ts.
 * Order matters: the first matching rule answers.
 */
const PROMPT_RULES: PromptRule[] = [
	{
		name: 'source digest',
		pattern: /will run as root\. Continue\? \[y\/N\]\s*$/,
		answer: () => 'y',
	},
	{ name: 'apply changes', pattern: /Apply these \d+ changes\? \[y\/N\]\s*$/, answer: () => 'y' },
	// Once a kit install converged (init/run.ts offerKitRemoval): the kit install.sh was given.
	{
		name: 'remove the kit',
		pattern: /Remove the kit \S+ you gave install\.sh \(a re-run needs no kit\)\? \[y\/N\]\s*$/,
		answer: () => 'y',
	},
	{
		name: 'database password',
		pattern: /(database )?password[^\n]*:\s*$/i,
		answer: (_m, s) => s.dbPassword,
	},
	{
		name: 'API_WEB_USER_CODE',
		pattern: /API_WEB_USER_CODE[^\n]*:\s*$/,
		answer: (_m, s) => s.apiWebUserCode,
	},
	// A decision: the default is shown and must be typed (spec §1.2) — init/tty.ts prints
	// `choose a | b (default a — type it): `.
	{
		name: 'decision (typed default)',
		pattern: /^choose [^\n]*\(default ([a-z0-9_-]+) — type it\):\s*$/m,
		answer: (m) => m[1] ?? null,
	},
	// The visible values with NO default (init/run.ts SECRET_PROMPTS): the drill's own (no database is reached).
	{
		name: 'visible value (no default)',
		pattern:
			/(v[12] database user|v2 database names \(comma list\)|v1 database name|v1 API entity): $/,
		answer: (m) => DRILL_VISIBLE[m[1] as string] ?? null,
	},
	// A visible value with its default in brackets: type the default. An EMPTY default (`[]`, the v2
	// socket prompt on a host without a local MariaDB socket: TCP) is answered with Enter.
	{
		name: 'visible value (default)',
		pattern: /\[([^\]\n]{0,200})\]:\s*$/,
		answer: (m) => m[1] ?? null,
	},
];
export const PROMPTS: readonly PromptRule[] = Object.freeze(PROMPT_RULES);

/**
 * Drives `script -qec <command>` (a pty: the hidden-input steps need one) through PROMPTS.
 * Returns the exit code and the transcript; a prompt no rule answers within `idleMs` is red.
 */
export async function drivePty(
	runner: Runner,
	command: string,
	secrets: DrillSecrets,
	opts: { idleMs?: number; timeoutMs?: number } = {},
): Promise<{ code: number; transcript: string; answered: string[] }> {
	const child = Bun.spawn(runner.interactive(`script -qec ${q(command)} /dev/null`), {
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const decoder = new TextDecoder();
	let transcript = '';
	let pending = '';
	const answered: string[] = [];
	let lastData = Date.now();
	const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
	const idle = opts.idleMs ?? 30_000;
	const deadline = Date.now() + (opts.timeoutMs ?? 1_200_000);
	const pump = (async () => {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) return;
			const text = decoder.decode(chunk.value);
			transcript += text;
			pending += text;
			lastData = Date.now();
			for (const rule of PROMPTS) {
				const match = pending.match(rule.pattern);
				if (match === null) continue;
				const answer = rule.answer(match, secrets);
				if (answer === null) break;
				answered.push(rule.name);
				pending = '';
				child.stdin.write(`${answer}\n`);
				break;
			}
		}
	})();
	const watchdog = setInterval(() => {
		if (Date.now() > deadline || (Date.now() - lastData > idle && /[:?\]]\s*$/.test(pending)))
			child.kill('SIGKILL');
	}, 1_000);
	const code = await child.exited;
	clearInterval(watchdog);
	await pump.catch(() => undefined);
	// The secrets never stay in the transcript the drill prints (hidden input has no echo; a defect would).
	for (const secret of [secrets.dbPassword, secrets.apiWebUserCode])
		transcript = transcript.split(secret).join('[SECRET LEAKED]');
	return { code, transcript, answered };
}

/* ── the source, the Bun mirror ────────────────────────────────────────────────────── */

/** The source's closed layout, read from install.sh's own SOURCE_MANIFEST line (held equal to the TS one by its gate). */
export function sourceManifest(): { path: string; kind: 'file' | 'tree' }[] {
	const text = readFileSync(join(REPO_ROOT, INSTALL_SH_REL), 'utf8');
	const line = text.match(/^SOURCE_MANIFEST='([^']+)'$/m)?.[1];
	if (line === undefined) throw new Error(`${INSTALL_SH_REL}: no SOURCE_MANIFEST line`);
	return line.split(' ').map((entry) => {
		const [path = '', kind = ''] = entry.split(':');
		if (kind !== 'file' && kind !== 'tree') throw new Error(`SOURCE_MANIFEST entry '${entry}'`);
		return { path, kind };
	});
}

/** A scratch copy of the source with production node_modules (installed here: the agent's deps are pure JS). */
export async function stageSource(scratch: string): Promise<string> {
	const dir = join(scratch, 'source');
	for (const entry of sourceManifest()) {
		const from = join(REPO_ROOT, entry.path);
		const to = join(dir, entry.path);
		mkdirSync(dirname(to), { recursive: true });
		const args =
			entry.kind === 'tree'
				? [
						'rsync',
						'-a',
						'--delete',
						'--exclude',
						'.test-tmp',
						'--exclude',
						'node_modules',
						`${from}/`,
						`${to}/`,
					]
				: ['cp', '-p', from, to];
		const done = await spawnText(args);
		if (done.code !== 0) throw new Error(`staging ${entry.path}: ${done.err}`);
	}
	const install = await spawnText(
		[process.execPath, 'install', '--frozen-lockfile', '--production'],
		{
			cwd: join(dir, 'publication/host_agent'),
			env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' },
		},
	);
	if (install.code !== 0)
		throw new Error(`bun install --production in the staged source: ${install.err}`);
	return dir;
}

/** `.bun-sha256` → {pin, hashes by asset}. */
export function shaTable(): { pin: string; hashes: Record<string, string> } {
	const lines = readFileSync(join(REPO_ROOT, '.bun-sha256'), 'utf8').split('\n');
	const pin = lines[0]?.match(/^# bun-v(\d+\.\d+\.\d+)$/)?.[1];
	if (pin === undefined) throw new Error('.bun-sha256: no "# bun-v<pin>" first line');
	const hashes: Record<string, string> = {};
	for (const line of lines) {
		const m = line.match(/^([0-9a-f]{64}) {2}(bun-linux-[a-z0-9-]+)\.zip$/);
		if (m) hashes[m[2] as string] = m[1] as string;
	}
	return { pin, hashes };
}

/** The asset install.sh picks for a machine (the same rule as its pick_asset). */
export function assetFor(unameM: string, avx2: boolean): string {
	if (unameM === 'x86_64') return avx2 ? 'bun-linux-x64' : 'bun-linux-x64-baseline';
	if (unameM === 'aarch64' || unameM === 'arm64') return 'bun-linux-aarch64';
	throw new Error(`no Bun asset for ${unameM}`);
}

/** The real Bun archive, downloaded HERE and checked against the committed table before any use. */
export async function fetchVerifiedBun(
	asset: string,
	into: string,
): Promise<{ zip: string; sums: string }> {
	const { pin, hashes } = shaTable();
	const want = hashes[asset];
	if (want === undefined) throw new Error(`.bun-sha256 names no ${asset}.zip`);
	const response = await fetch(
		`https://github.com/oven-sh/bun/releases/download/bun-v${pin}/${asset}.zip`,
		{ redirect: 'follow' },
	);
	if (!response.ok) throw new Error(`Bun ${pin} ${asset}: HTTP ${response.status}`);
	const bytes = new Uint8Array(await response.arrayBuffer());
	const got = createHash('sha256').update(bytes).digest('hex');
	if (got !== want) throw new Error(`Bun ${asset}.zip sha256 ${got} is not .bun-sha256's ${want}`);
	const dir = join(into, `bun-v${pin}`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${asset}.zip`), bytes);
	// The mirror's SHASUMS256.txt carries the table's own lines (= the signed payload's): the cross-check agrees.
	const sums = Object.entries(hashes)
		.map(([name, sha]) => `${sha}  ${name}.zip`)
		.join('\n');
	writeFileSync(join(dir, 'SHASUMS256.txt'), `${sums}\n`);
	return { zip: join(dir, `${asset}.zip`), sums: join(dir, 'SHASUMS256.txt') };
}

/* ── the systemd directive probe (the systemd-analyze leg) ─────────────────────────── */

/** One directive a rendered unit carries: its section, its key, the rendered line itself. */
export interface DirectiveForm {
	readonly section: string;
	readonly key: string;
	readonly line: string;
}

/** What systemd-analyze prints for a directive this systemd does not know or cannot parse. */
export const DIRECTIVE_REFUSED = /Unknown (key|lvalue|section)|Failed to parse/i;

/** The probe's exit-status line (`directiveProbeScript` appends it): systemd-analyze's own status. */
const PROBE_STATUS = /^rc=(\d+)$/m;

/**
 * One probe of a scratch unit: `systemd-analyze verify`, its OWN exit status kept on a last
 * `rc=N` line (never swallowed by the `rm` after it), then the scratch removed.
 */
export function directiveProbeScript(path: string): string {
	return `systemd-analyze verify ${path} 2>&1; echo "rc=$?"; rm -f ${path}`;
}

/**
 * What one probe said: `refused` (systemd named the directive unknown / unparseable),
 * `accepted` (it verified: status 0, no refusal), or `unrun` — no status line, or a non-zero
 * status without a refusal: the probe itself did not run (systemd-analyze missing, the scratch
 * unwritable, a crash). `unrun` is never counted as accepted.
 */
export function directiveProbeVerdict(out: string): 'accepted' | 'refused' | 'unrun' {
	if (DIRECTIVE_REFUSED.test(out)) return 'refused';
	const status = PROBE_STATUS.exec(out);
	return status !== null && status[1] === '0' ? 'accepted' : 'unrun';
}

/** The probe's output with its status line removed (what systemd-analyze itself printed). */
export function directiveProbeOutput(out: string): string {
	return out.replace(PROBE_STATUS, '').trim();
}

/** The positive control: a directive no systemd knows. The probe MUST call it refused. */
export const BOGUS_DIRECTIVE: DirectiveForm = {
	section: 'Service',
	key: 'DdNoSuchKey',
	line: 'DdNoSuchKey=1',
};

/** The bare scaffold (its own `Type=` line): the probe MUST verify it clean — status 0, silent. */
export const SCAFFOLD_DIRECTIVE: DirectiveForm = {
	section: 'Service',
	key: 'Type',
	line: 'Type=oneshot',
};

/**
 * Every `Key=value` directive of the rendered unit bodies, ONCE per (section, key) — the first
 * rendering wins — in first-seen order. Comments and blank lines are not directives.
 */
export function renderedDirectiveForms(bodies: readonly string[]): DirectiveForm[] {
	const forms: DirectiveForm[] = [];
	const seen = new Set<string>();
	for (const body of bodies) {
		let section = '';
		for (const raw of body.split('\n')) {
			const line = raw.trim();
			if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
			const header = /^\[([A-Za-z]+)\]$/.exec(line);
			if (header !== null) {
				section = header[1] as string;
				continue;
			}
			const directive = /^([A-Za-z][A-Za-z0-9]*)=/.exec(line);
			if (directive === null || section === '') continue;
			const key = directive[1] as string;
			if (seen.has(`${section}/${key}`)) continue;
			seen.add(`${section}/${key}`);
			forms.push({ section, key, line });
		}
	}
	return forms;
}

/**
 * A minimal oneshot unit carrying `form`'s rendered line in its section — replacing the
 * scaffold's own line for the same key, so the probe never holds a key twice.
 */
export function directiveProbeUnit(form: DirectiveForm): string {
	const sections = new Map<string, string[]>([
		['Unit', ['Description=dd floor probe']],
		['Service', ['Type=oneshot', 'ExecStart=/bin/true']],
	]);
	const lines = (sections.get(form.section) ?? []).filter(
		(line) => !line.startsWith(`${form.key}=`),
	);
	sections.set(form.section, [...lines, form.line]);
	return `${[...sections].map(([name, body]) => `[${name}]\n${body.join('\n')}\n`).join('')}`;
}

/* ── the EL drill record (the ratchet's input) ─────────────────────────────────────── */

/** What one host's run measured (spec §9.11): the facts are the host's, never another major's. */
export interface ElMeasured {
	readonly booleans: Readonly<
		Record<string, { readonly needed_for: string; readonly denied_without: boolean }>
	>;
	/** Per systemd version: every `[Section] Key=` the rendered units carry, each probed alone and accepted. */
	readonly supported_directives: Readonly<Record<string, readonly string[]>>;
	readonly home_traverse_type: string | null;
	/** The home layout's v2 tree type, measured (stat): one v2 type on every layout (2026-10-09). */
	readonly home_v2_type: string | null;
	readonly system_default_readable: boolean | null;
	readonly v1_php_floor: string | null;
	readonly nginx_floor: string | null;
}

/**
 * One EL VM's recorded run. Each host carries its OWN run — the commit it ran on, when, what it
 * measured, which legs passed — so recording EL 10 never rewrites what EL 9 measured (its PHP,
 * its systemd's directives) nor claims EL 9 ran on EL 10's commit.
 */
export interface ElHost {
	readonly os: 'el9' | 'el10';
	readonly id: string;
	readonly version: string;
	readonly kernel: string;
	readonly selinux: 'enforcing';
	readonly sha: string;
	readonly at: string;
	readonly measured: ElMeasured;
	readonly legs: readonly string[];
	readonly skipped: readonly string[];
}

/** The record: ONE inputs digest every host was measured against, one entry per EL major. */
export interface ElDrillRecord {
	readonly inputs_digest: string;
	readonly hosts: readonly ElHost[];
}

/**
 * THE INPUTS DIGEST — over the EL-relevant sources (`EL_DRILL_INPUTS`, agent-package
 * relative): sha256 of `<path>\0<sha256 of its bytes>\n` lines in byte order of the path.
 * The ratchet recomputes it with THIS function; a changed input makes it differ.
 */
export function elDrillInputsDigest(agentDir: string, inputs: readonly string[]): string {
	const lines = [...inputs].sort().map(
		(path) =>
			`${path}\0${createHash('sha256')
				.update(readFileSync(join(agentDir, path)))
				.digest('hex')}\n`,
	);
	return createHash('sha256').update(lines.join('')).digest('hex');
}

/** The input list, from the agent package in a CHILD (the drill imports no agent module). */
export async function elDrillInputs(): Promise<string[]> {
	const probe = `const m = await import(${JSON.stringify(join(AGENT_DIR, 'src/provision/selinux.ts'))}); console.log(JSON.stringify(m.EL_DRILL_INPUTS ?? null));`;
	const done = await spawnText([process.execPath, '-e', probe], { cwd: AGENT_DIR });
	const list = done.code === 0 ? (JSON.parse(done.out.trim()) as unknown) : null;
	if (
		!Array.isArray(list) ||
		list.length === 0 ||
		!list.every((p) => typeof p === 'string' && !p.startsWith('/') && !p.includes('..'))
	) {
		throw new Error(
			'publication/host_agent/src/provision/selinux.ts exports no EL_DRILL_INPUTS (relative paths): the record has no inputs',
		);
	}
	return list as string[];
}

/**
 * One VM's run into the record. Same inputs digest: the run's host is added, or replaces the
 * entry of its own EL major — every other host's entry is kept byte for byte. Another digest: a
 * fresh record holding only this run — an EL input changed, so every host must be measured again.
 */
export function mergeRecord(existing: ElDrillRecord | null, run: ElDrillRecord): ElDrillRecord {
	if (existing === null || existing.inputs_digest !== run.inputs_digest) return run;
	const ran = new Set(run.hosts.map((h) => h.os));
	return {
		inputs_digest: run.inputs_digest,
		hosts: [...existing.hosts.filter((h) => !ran.has(h.os)), ...run.hosts].sort((a, b) =>
			a.os.localeCompare(b.os),
		),
	};
}

/* ── legs ──────────────────────────────────────────────────────────────────────────── */

export const INSTANCE = 'drill_museum';
export const DOMAIN = 'museum.test';
export const SECOND_INSTANCE = 'drill_second';
export const SECOND_DOMAIN = 'second.test';
export const NGINX_INSTANCE = 'drill_nginx';
/**
 * Its site user is the domain's first label (makeSite): never `nginx`, the account EL's nginx package
 * creates (an existing user is reused, and its home is not the site's).
 */
export const NGINX_DOMAIN = 'ngxsite.test';
/** The v2-only site (no v1 block in its draft): the recommended shape for a new site, no PHP anywhere. */
export const V2_ONLY_INSTANCE = 'drill_v2only';
export const V2_ONLY_DOMAIN = 'v2only.test';
/** The site installed FROM A KIT (`bun run hostagent:pack` here, `install.sh --kit` there). */
export const KIT_INSTANCE = 'drill_kit';
export const KIT_DOMAIN = 'kit.test';
/** The SYSTEM-layout site (EL): its v2 tree is typed by the provisioner's own SELinux policy module. */
export const SYSTEM_INSTANCE = 'drill_system';
export const SYSTEM_DOMAIN = 'sysl.test';
/** The policy module and its one type (publication/host_agent/src/provision/selinux_module.ts). */
const SELINUX_MODULE = 'dedalo_publication_host';
const SELINUX_MODULE_SOURCE = `/var/lib/dedalo_publication_host/_host/${SELINUX_MODULE}.cil`;
const V2_TREE_TYPE = 'dedalo_publication_v2_t';
/** system-layout-v2's httpd control file: the one AVC denial the drill causes on purpose (no-avc skips it). */
export const SELINUX_CONTROL_FILE = 'dd_selinux_control.txt';
/** Its own directory and URL: granted by its own Apache file, so only the file's label differs between the two requests. */
export const SELINUX_CONTROL_DIR = '/srv/dd_selinux_control';
export const SELINUX_CONTROL_URL = '/dd_selinux_control';
export const SELINUX_CONTROL_CONF = '/etc/httpd/conf.d/dd_selinux_control.conf';

/**
 * The control's Apache file: an Alias and a `<Directory>` that GRANTS it (EL's httpd.conf denies
 * every directory it does not name — measured: a file under a vhost's DocumentRoot in a home answered
 * 403 AH01630 "client denied by server configuration", which is Apache, not SELinux).
 */
export function selinuxControlConf(): string {
	return [
		'# init drill (system-layout-v2): the SELinux control; removed by the leg',
		`Alias ${SELINUX_CONTROL_URL} ${SELINUX_CONTROL_DIR}`,
		`<Directory ${SELINUX_CONTROL_DIR}>`,
		'    Require all granted',
		'    Options None',
		'    AllowOverride None',
		'</Directory>',
		'',
	].join('\n');
}

/**
 * An AVC line about the control file: `name="<file>"` (an open/read) or `path="<dir>/<file>"` (a
 * getattr — measured, RHEL 9.8: httpd's stat is denied first, and that record names the path).
 */
export function controlNamed(line: string): boolean {
	return (
		line.includes(`name="${SELINUX_CONTROL_FILE}"`) ||
		line.includes(`path="${SELINUX_CONTROL_DIR}/${SELINUX_CONTROL_FILE}"`)
	);
}

/**
 * The control's verdict, or null when it measured SELinux alone: the SAME file, the same grant, answered
 * 200 with its bytes as httpd_sys_content_t (else the control proves nothing), then 403 once it carries
 * the module's type, with an AVC denial of httpd_t on that type naming the file, and Apache's error log
 * naming no authz refusal for it (AH01630/AH01797: the 403 would be Apache's, not SELinux's).
 */
export function selinuxControlVerdict(observed: {
	readonly baseline: { readonly status: number; readonly body: string };
	readonly refused: { readonly status: number };
	readonly avc: string;
	readonly errorLog: string;
	readonly type: string;
}): string | null {
	const { baseline, refused, avc, errorLog, type } = observed;
	if (baseline.status !== 200 || !baseline.body.includes('dd-control')) {
		return `the control file as httpd_sys_content_t answered ${baseline.status}: the control proves nothing`;
	}
	if (refused.status !== 403) return `httpd read a ${type} file: ${refused.status}`;
	if (
		errorLog
			.split('\n')
			.some((line) => /AH01630|AH01797/.test(line) && line.includes(SELINUX_CONTROL_FILE))
	) {
		return `the 403 for the ${type} control is Apache's authorization, not SELinux:\n${errorLog.slice(-1000)}`;
	}
	const denied = avc
		.split('\n')
		.some(
			(line) =>
				/denied/.test(line) &&
				controlNamed(line) &&
				line.includes(':httpd_t:') &&
				line.includes(`:${type}:`),
		);
	return denied
		? null
		: `no AVC denial of httpd_t on ${type} for the control:\n${avc.slice(-2000)}`;
}

/**
 * THE relay probe's own denial: the v2 proxy's connect refused with httpd_can_network_relay off — a
 * `name_connect` on a `tcp_socket`, by the Apache worker (`comm="httpd"`) in `httpd_t`. php-fpm runs in
 * httpd_t too (its comm names it), and a connect of any other process or class is not the probe's: no
 * such line is excused by no-avc, nor counts as the relay OFF measurement. (The drill does not hold the
 * instance's v2 port, so `dest=` is not pinned.)
 */
export function relayProbeDenial(line: string): boolean {
	return (
		/\{ name_connect \}/.test(line) &&
		/ tclass=tcp_socket\b/.test(line) &&
		/ comm="httpd" /.test(line) &&
		/ scontext=\S*:httpd_t:/.test(line)
	);
}

/** Counts of one probe window's AVC records (`ausearch -m AVC` raw lines): every denial, and the relay probe's own. */
export function countProbeDenials(window: string): { avcs: number; relay: number } {
	const denied = window.split('\n').filter((line) => /denied/.test(line));
	return { avcs: denied.length, relay: denied.filter(relayProbeDenial).length };
}

/**
 * One boolean probe: its HTTP status, the AVC denials its own window logged (any), and how many of
 * them are the relay probe's own (relayProbeDenial) — the relay OFF floor counts only those.
 */
export interface BooleanProbe {
	readonly status: number;
	readonly avcs: number;
	readonly relay: number;
}

/**
 * booleans-measured's verdict for one boolean, or null when it measured what its `what` says: ON, the
 * probe logs no AVC (and the v1 probe answers 200); OFF, httpd_can_network_relay's proxy probe MUST log
 * one — a relay probe that logs none with the boolean off measured nothing (its window read nothing, or
 * the boolean does not gate the proxy), and recording that as `denied_without: false` would call an
 * unmeasured property green.
 */
export function booleanProbeVerdict(
	name: string,
	probe: string,
	on: BooleanProbe,
	off: BooleanProbe,
): string | null {
	if (on.avcs !== 0) return `${name} on: ${probe} still logged ${on.avcs} AVC denial(s)`;
	if (name === 'httpd_enable_homedirs' && on.status !== 200) {
		return `${name} on: the v1 probe answered ${on.status} (run v1-handler-probe first)`;
	}
	if (name === 'httpd_can_network_relay' && off.relay === 0) {
		return `${name} off: ${probe} logged no name_connect denial of the httpd worker (${off.avcs} other AVC line(s)) — the probe's window read nothing, or the boolean no longer gates the v2 proxy: the measurement proves nothing`;
	}
	return null;
}

/** booleans-measured's span on the TARGET's clock (epoch seconds, `date +%s` there), both ends inclusive. */
export interface BooleansWindow {
	readonly from: number;
	readonly to: number;
}

/** The audit record's own time (`msg=audit(<epoch>.<ms>:<serial>)`, ausearch's raw form), whole seconds; null when absent. */
export function auditSeconds(line: string): number | null {
	const match = /msg=audit\((\d+)(?:\.\d+)?:\d+\)/.exec(line);
	return match === null ? null : Number(match[1]);
}

/**
 * no-avc's verdict over the `ausearch -m AVC,USER_AVC -ts <drill start>` window, or null when clean.
 * The window is FLOORED on the one denial the drill causes on purpose (system-layout-v2's control,
 * `controlDenied` = that leg measured it): a window that does not hold even that read nothing — a wrong
 * -ts, the wrong day, a dead auditd — and a clean read of nothing is no measurement.
 * The booleans leg's relay probe causes the other one (relayProbeDenial: the httpd worker's
 * `name_connect` on a tcp_socket in httpd_t, the boolean off): such a line is excused ONLY when it is
 * that denial AND its own audit time falls inside that leg's span (`booleans`, recorded by
 * the leg on the target's clock). A name_connect anywhere else in the drill — or with no span recorded,
 * or no readable time — is a denial the drill did not ask for, and is reported.
 */
export function noAvcVerdict(
	window: string,
	controlDenied: boolean,
	booleans: BooleansWindow | null,
): string | null {
	if (!controlDenied) {
		return 'system-layout-v2 did not measure its control denial in this drill: the window has no floor, so a clean read would prove nothing (run system-layout-v2)';
	}
	const avcLines = window.split('\n').filter((line) => /avc:/.test(line));
	if (!avcLines.some(controlNamed)) {
		return `the window read nothing: not even system-layout-v2's control denial is in it\n${window.slice(-1000)}`;
	}
	const inBooleans = (line: string): boolean => {
		const at = auditSeconds(line);
		return booleans !== null && at !== null && at >= booleans.from && at <= booleans.to;
	};
	const foreign = avcLines.filter(
		(line) => !controlNamed(line) && !(relayProbeDenial(line) && inBooleans(line)),
	);
	return foreign.length === 0
		? null
		: `AVC denials during the drill:\n${foreign.slice(0, 20).join('\n')}`;
}

/**
 * no-apparmor-denial's verdict on the AUDIT half (auditd running: the kernel's denials go to its log,
 * not the journal), or null when that half measured. Its own floor, never borrowed from the journal's:
 * `floor` is `ausearch -m SERVICE_START,SERVICE_STOP -ts <drill start>` and must name a unit of ours
 * (the drill starts and restarts them) — a window that holds not even those read nothing (a wrong -ts,
 * a dead log). `denials` is `ausearch -m AVC,USER_AVC` over the same -ts: exit 0 (records — the caller
 * reads the apparmor="DENIED" lines), or exit 1 saying `<no matches>`; anything else is a failed read,
 * never a clean one.
 */
export function auditHalfVerdict(
	floor: Pick<Done, 'code' | 'out'>,
	denials: Pick<Done, 'code' | 'out'>,
): string | null {
	if (floor.code !== 0 || !/unit=dedalo-publication-host-/.test(floor.out)) {
		return `the audit log since the drill started holds no SERVICE_START/STOP of our units (exit ${floor.code}): its window read nothing, so a clean AVC read would prove nothing\n${floor.out.slice(-600)}`;
	}
	if (denials.code === 0 || (denials.code === 1 && /<no matches>/.test(denials.out))) return null;
	return `ausearch -m AVC,USER_AVC failed (exit ${denials.code}): the audit half was not read\n${denials.out.slice(-600)}`;
}

interface Ctx {
	readonly args: DrillArgs;
	readonly runner: Runner;
	readonly scratch: string;
	/** The source as the target sees it. */
	readonly source: string;
	readonly mirror: string;
	readonly secrets: DrillSecrets;
	readonly facts: Record<string, unknown>;
	/** The drill's start on the TARGET's clock, `YYYY-MM-DD HH:MM:SS` (journalctl --since). */
	readonly startedAt: string;
	/** The same instant in the target's `%x %T` (ausearch -ts: a date in its locale, then a time). */
	readonly auditStartedAt: string;
}

/**
 * The drill's start as the TARGET's clock reads it — never this machine's (another timezone, another
 * day, a skewed clock would move every "since the drill started" window): `date +'%F %T|%x %T'`
 * there, both forms of one instant.
 */
export function parseTargetStart(out: string): { startedAt: string; auditStartedAt: string } {
	const [startedAt = '', auditStartedAt = ''] = out.trim().split('|');
	if (
		!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(startedAt) ||
		!/^\S+ \d{2}:\d{2}:\d{2}$/.test(auditStartedAt)
	) {
		throw new Error(`the target's clock answered '${out.trim()}', not '<%F %T>|<%x %T>'`);
	}
	return { startedAt, auditStartedAt };
}

interface Leg {
	readonly name: string;
	readonly family: 'both' | 'debian' | 'el';
	/** A record that skipped it is refused (spec §9: the measurement the ratchet rests on). */
	readonly required: boolean;
	/** Only a real host can answer it (a container shares its daemon's kernel): run in place only. */
	readonly inPlaceOnly?: true;
	readonly what: string;
	run(ctx: Ctx): Promise<void>;
}

class LegFailure extends Error {}

function check(cond: boolean, message: string): void {
	if (!cond) throw new LegFailure(message);
}

async function must(ctx: Ctx, script: string, what: string, timeoutMs?: number): Promise<string> {
	const done = await ctx.runner.sh(script, timeoutMs === undefined ? {} : { timeoutMs });
	check(done.code === 0, `${what}: exit ${done.code}\n${done.out}${done.err}`);
	return done.out;
}

const installSh = (ctx: Ctx, instance: string, flags: string): string =>
	`sh ${q(join(ctx.source, INSTALL_SH_REL))} ${instance} ${flags}`;
const rerunSh = (instance: string, home: string, flags: string): string =>
	`sh ${q(`${home}/host_agent/deploy/install.sh`)} ${instance} ${flags}`;

/**
 * The drill's draft. The legs judge the v1+v2 shape (the v1 pool, the v1 config typed on the pty),
 * so `apis: 'v1_and_v2'` is said; `{ apis: undefined }` drops it — a draft without the v1 block is
 * a v2-only site.
 */
function draftFor(instance: string, domain: string, extra: Record<string, unknown> = {}): string {
	return `${JSON.stringify({ instance, layout: 'home', apis: 'v1_and_v2', site: { domain }, media: { mode: 'none' }, ...extra }, null, 2)}\n`;
}

async function putRootFile(ctx: Ctx, path: string, body: string, mode = '0600'): Promise<void> {
	const done = await ctx.runner.sh(
		`install -d -m 0755 ${q(dirname(path))} && cat > ${q(path)} && chown root:root ${q(path)} && chmod ${mode} ${q(path)}`,
		{ stdin: body },
	);
	check(done.code === 0, `write ${path}: ${done.err}`);
}

/** The source digest install.sh will show (its own tree_digest, run in its library mode). */
async function sourceDigest(ctx: Ctx): Promise<string> {
	const out = await must(
		ctx,
		`set -- --lib; . ${q(join(ctx.source, INSTALL_SH_REL))}; resolve_sha256; tree_digest ${q(ctx.source)}`,
		'tree_digest',
	);
	const digest = out.trim().split('\n').at(-1) ?? '';
	check(/^[0-9a-f]{64}$/.test(digest), `tree_digest printed '${digest}'`);
	return digest;
}

/** Copies one local file to `remote` on the target (bytes through docker exec's stdin, or cp in place). */
async function copyIn(ctx: Ctx, local: string, remote: string): Promise<void> {
	const where = ctx.runner.where.startsWith('container ')
		? ctx.runner.where.slice('container '.length)
		: null;
	const done =
		where === null
			? await spawnText(['cp', local, remote])
			: await spawnText([
					'sh',
					'-c',
					`docker exec -i ${where} sh -c ${q(`cat > ${q(remote)}`)} < ${q(local)}`,
				]);
	check(done.code === 0, `copy ${local} → ${remote}: ${done.err}`);
}

/** The work host's half of the kit: the REAL packer (a real production `bun install`), here. */
async function packKit(ctx: Ctx, draftBody: string): Promise<{ kit: string; sha256: string }> {
	const draftPath = join(ctx.scratch, 'kit.draft.json');
	writeFileSync(draftPath, draftBody);
	const kit = join(ctx.scratch, 'dedalo_publication_host_kit.tar.gz');
	const done = await spawnText(
		[
			process.execPath,
			'run',
			join(REPO_ROOT, 'scripts/publication_host_pack.ts'),
			'--draft',
			draftPath,
			'--out',
			kit,
		],
		{ timeoutMs: 600_000 },
	);
	check(done.code === 0, `hostagent:pack exited ${done.code}: ${done.err}${done.out}`);
	const sha256 = done.out.match(/^sha256 ([0-9a-f]{64})$/m)?.[1];
	check(sha256 !== undefined, `hostagent:pack printed no sha256:\n${done.out}`);
	const actual = createHash('sha256').update(readFileSync(kit)).digest('hex');
	check(actual === sha256, `the kit's sha256 is ${actual}, the packer printed ${sha256}`);
	return { kit, sha256: sha256 as string };
}

/** Every record of one instance's journal, in order. */
async function journalRecords(
	ctx: Ctx,
	instance: string,
): Promise<{ run: string; item: string; phase: string }[]> {
	const text = await must(
		ctx,
		`cat /var/lib/dedalo_publication_host_init/${instance}/journal.jsonl`,
		'read the journal',
	);
	return text
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { run: string; item: string; phase: string });
}

async function healthOverSocket(ctx: Ctx, instance: string): Promise<void> {
	const out = await must(
		ctx,
		`curl -fsS --unix-socket /run/dedalo_publication_host/${instance}/agent.sock http://localhost/publication/host_agent/health`,
		`${instance}: GET /health over its socket`,
	);
	check(
		/"status":"ok"/.test(out) && /"instance_fingerprint":"[0-9a-f]{64}"/.test(out),
		`${instance}: /health answered ${out}`,
	);
}

/** The vhost sha8 compare names an item by (spec §4.3: sha256(realpath\0port\0serverName)). */
export function vhostSha8(realpath: string, port: number, serverName: string): string {
	return createHash('sha256')
		.update(`${realpath}\0${port}\0${serverName}`)
		.digest('hex')
		.slice(0, 8);
}

/** Every item id a report prints (`--decide` takes them). */
export function itemIds(report: string): string[] {
	return [
		...new Set(
			[
				...report.matchAll(
					/\b((?:host|selinux|account|home|bun|code|declaration|provision|api_config|web|verify|pair|init)\.[a-z0-9_.-]+[a-z0-9])\b/g,
				),
			].map((m) => m[1] as string),
		),
	];
}

/**
 * The site's log directory, as the operator's existing site has it and init's `web.logs` expects it
 * (owner decision 1(c): OUTSIDE the home, the distribution's log directory per site — Ubuntu 26.04's
 * apache2.service runs with ProtectHome=read-only, so a log under /home fails the unit's start).
 */
export function siteLogDir(
	family: 'debian' | 'el',
	server: 'apache' | 'nginx',
	domain: string,
): string {
	if (server === 'nginx') return `/var/log/nginx/${domain}`;
	return family === 'el' ? `/var/log/httpd/${domain}` : `/var/log/apache2/${domain}`;
}

const APACHE_VHOST = (domain: string, home: string, logs: string, eol = '\n') =>
	[
		'<VirtualHost *:443>',
		`    ServerName ${domain}`,
		`    DocumentRoot ${home}/httpdocs`,
		`    ErrorLog ${logs}/error.log`,
		`    CustomLog ${logs}/access.log combined`,
		'    SSLEngine on',
		`    SSLCertificateFile /etc/ssl/drill/${domain}.pem`,
		`    SSLCertificateKeyFile /etc/ssl/drill/${domain}.key`,
		'</VirtualHost>',
		'',
	].join(eol);

async function makeSite(ctx: Ctx, domain: string, server: 'apache' | 'nginx'): Promise<void> {
	const home = `/home/${domain}`;
	const user = domain.split('.')[0] ?? 'site';
	const el = ctx.args.family === 'el';
	const logs = siteLogDir(ctx.args.family, server, domain);
	const confDir =
		server === 'apache'
			? el
				? '/etc/httpd/conf.d'
				: '/etc/apache2/sites-available'
			: el
				? '/etc/nginx/conf.d'
				: '/etc/nginx/sites-available';
	await must(
		ctx,
		[
			`id ${user} >/dev/null 2>&1 || useradd --create-home --home-dir ${home} --shell /bin/sh ${user}`,
			// A reused account must be the site's (a package account of that name is not).
			`test "$(getent passwd ${user} | cut -d: -f6)" = ${home}`,
			// The widening home.root must report: 0700 is what useradd gives on Debian 13 and EL (and
			// adduser on Debian 12, whose useradd gives 0755; Ubuntu's gives 0750) — measured.
			`chmod 0700 ${home}`,
			`install -d -o ${user} -m 0755 ${home}/httpdocs`,
			`install -d -m 0755 ${logs}`,
			`echo ok > ${home}/httpdocs/index.html`,
			'install -d -m 0755 /etc/ssl/drill',
			`openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=${domain} -keyout /etc/ssl/drill/${domain}.key -out /etc/ssl/drill/${domain}.pem 2>/dev/null`,
		].join(' && '),
		`site ${domain}`,
	);
	const file = server === 'apache' ? `${confDir}/${domain}-ssl.conf` : `${confDir}/${domain}.conf`;
	const body =
		server === 'apache'
			? APACHE_VHOST(domain, home, logs)
			: [
					'server {',
					'    listen 443 ssl;',
					`    server_name ${domain};`,
					`    root ${home}/httpdocs;`,
					`    access_log ${logs}/access.log;`,
					`    error_log ${logs}/error.log;`,
					`    ssl_certificate /etc/ssl/drill/${domain}.pem;`,
					`    ssl_certificate_key /etc/ssl/drill/${domain}.key;`,
					'}',
					'',
				].join('\n');
	await putRootFile(ctx, file, body, '0644');
	if (!el) {
		await must(
			ctx,
			server === 'apache'
				? `a2enmod -q ssl && a2ensite -q ${domain}-ssl && apache2ctl -t && systemctl reload apache2`
				: `ln -sf ${file} /etc/nginx/sites-enabled/${domain}.conf && nginx -t && systemctl reload nginx`,
			`enable ${domain}`,
		);
	}
}

async function webCheck(
	ctx: Ctx,
	domain: string,
	path: string,
): Promise<{ status: number; body: string }> {
	const done = await ctx.runner.sh(
		`curl -sk --resolve ${domain}:443:127.0.0.1 -o /tmp/dd_body -w '%{http_code}' https://${domain}${path}; echo; cat /tmp/dd_body`,
	);
	const [status = '0', ...rest] = done.out.split('\n');
	return { status: Number(status), body: rest.join('\n') };
}

/** A fresh guided install of one instance through the pty, every prompt answered by PROMPTS. */
async function guidedInstall(
	ctx: Ctx,
	instance: string,
	domain: string,
	extraFlags = '',
	draft: string = draftFor(instance, domain),
): Promise<string> {
	await putRootFile(ctx, `/root/${instance}.draft.json`, draft);
	const digest = await sourceDigest(ctx);
	const run = await drivePty(
		ctx.runner,
		installSh(
			ctx,
			instance,
			`--source ${q(ctx.source)} --draft /root/${instance}.draft.json --mirror ${ctx.mirror} --source-digest ${digest} -- --no-pair ${extraFlags}`,
		),
		ctx.secrets,
	);
	check(
		!run.transcript.includes('[SECRET LEAKED]'),
		`${instance}: a typed secret appeared on the terminal`,
	);
	check(
		run.code === 0,
		`${instance}: guided install exited ${run.code}; answered ${run.answered.join(', ')}\n${run.transcript.slice(-4000)}`,
	);
	check(
		run.answered.includes('apply changes'),
		`${instance}: init never asked to apply its changes`,
	);
	return run.transcript;
}

export const LEGS: readonly Leg[] = Object.freeze([
	{
		name: 'fresh-converge',
		family: 'both',
		required: true,
		what: 'install.sh with --source through the local https mirror: accounts, the root-owned home, Bun verified, the code, the declaration, apply (v1 pool, web include), the vhost reference, the API files typed on a pty, a real FPM and web reload, B4',
		async run(ctx) {
			await makeSite(ctx, DOMAIN, 'apache');
			const transcript = await guidedInstall(ctx, INSTANCE, DOMAIN);
			check(/widen|0700/.test(transcript), 'home.root did not state the widening of a 0700 home');
			const home = `/home/${DOMAIN}`;
			check(
				(await must(ctx, `stat -c '%U:%G %a' ${home}`, 'stat home')).trim() === 'root:root 755',
				'the home is not root:root 0755',
			);
			// The site logs: outside the home, root's, rotated by our stamped file (logrotate parses it).
			const logs = siteLogDir(ctx.args.family, 'apache', DOMAIN);
			check(
				(await must(ctx, `stat -c '%U:%G %a' ${logs}`, 'stat the site log dir')).trim() ===
					'root:root 755',
				`${logs} is not root:root 0755`,
			);
			await must(
				ctx,
				`head -n1 /etc/logrotate.d/dedalo_${INSTANCE}_web | grep -q '^# dedalo-provision: ${INSTANCE} logrotate ' && logrotate -d /etc/logrotate.d/dedalo_${INSTANCE}_web 2>&1`,
				'the stamped logrotate file parses (logrotate -d)',
			);
			for (const account of [`${INSTANCE}_agent`, `${INSTANCE}_v1`, `${INSTANCE}_v2`])
				await must(ctx, `getent passwd ${account}`, `account ${account}`);
			await must(ctx, 'getent group dedalo_pubhost', 'the dedalo_pubhost group');
			await must(
				ctx,
				`systemctl is-active dedalo-publication-host-${INSTANCE}`,
				'the agent is active',
			);
			await healthOverSocket(ctx, INSTANCE);
			const dump = await must(
				ctx,
				ctx.args.family === 'el'
					? 'httpd -t -D DUMP_INCLUDES 2>&1'
					: 'apache2ctl -t -D DUMP_INCLUDES 2>&1',
				'DUMP_INCLUDES',
			);
			check(
				dump.includes(`/etc/dedalo_publication_host/${INSTANCE}/web.apache.conf`),
				'the web server does not load the web include',
			);
			await must(
				ctx,
				`ls /etc/php*/*/fpm/pool.d/dedalo_${INSTANCE}_v1.conf /etc/php-fpm.d/dedalo_${INSTANCE}_v1.conf /etc/opt/remi/php*/php-fpm.d/dedalo_${INSTANCE}_v1.conf 2>/dev/null | head -n1 | grep -q .`,
				'the v1 pool file',
			);
			const meta = await must(
				ctx,
				`stat -c '%U:%G %a' ${home}/dedalo/publication_api/v2/shared/v2.env ${home}/dedalo/publication_api/v1/shared/server_config_api.php`,
				'API files',
			);
			check(meta.split('\n')[0] === `root:${INSTANCE}_v2 640`, `v2.env metadata ${meta}`);
			check(
				meta.split('\n')[1]?.startsWith(`${INSTANCE}_v1:`) === true &&
					meta.split('\n')[1]?.endsWith(' 400') === true,
				`v1 config metadata ${meta}`,
			);
			const journal = await must(
				ctx,
				`cat /var/lib/dedalo_publication_host_init/${INSTANCE}/journal.jsonl`,
				'journal',
			);
			check(
				!journal.includes(ctx.secrets.dbPassword) && !journal.includes(ctx.secrets.apiWebUserCode),
				'a secret reached the journal',
			);
		},
	},
	{
		name: 'rerun-all-right',
		family: 'both',
		required: true,
		what: 're-run mode (no --source): every item already right, zero mutations',
		async run(ctx) {
			// A run with nothing to change journals nothing: judge only the records THIS run appended.
			const before = (await journalRecords(ctx, INSTANCE)).length;
			const done = await ctx.runner.sh(
				`${rerunSh(INSTANCE, `/home/${DOMAIN}`, '-- --yes --no-pair')} </dev/null`,
			);
			check(done.code === 0, `the all-right re-run exited ${done.code}\n${done.out}${done.err}`);
			const changed = (await journalRecords(ctx, INSTANCE))
				.slice(before)
				.filter((p) => p.phase === 'done');
			check(changed.length === 0, `the re-run changed ${changed.map((p) => p.item).join(', ')}`);
		},
	},
	{
		name: 'configtest-rollback',
		family: 'both',
		required: true,
		what: 'a vhost edit whose configtest fails is restored byte for byte, the web server stays up, FAILED (4); repaired, the next run converges',
		async run(ctx) {
			const el = ctx.args.family === 'el';
			const vhost = el
				? `/etc/httpd/conf.d/${DOMAIN}-ssl.conf`
				: `/etc/apache2/sites-available/${DOMAIN}-ssl.conf`;
			// Detach: the next run must edit the vhost again.
			await putRootFile(
				ctx,
				vhost,
				APACHE_VHOST(DOMAIN, `/home/${DOMAIN}`, siteLogDir(ctx.args.family, 'apache', DOMAIN)),
				'0644',
			);
			const before = (await must(ctx, `sha256sum ${vhost}`, 'sha')).split(' ')[0];
			// Broken only once the vhost references the instance's include: the media-rules file that
			// include loads (absent until the first push). A file the web server loads anyway would break
			// init's own discovery (`-S`) as well, and no web.vhost item would exist to act on.
			const broken = `/home/${DOMAIN}/dedalo/rules/dedalo_media_publication.apache.conf`;
			await putRootFile(ctx, broken, 'ThisIsNotADirective on\n', '0644');
			let vhostId = '';
			try {
				const report = (
					await ctx.runner.sh(
						`${rerunSh(INSTANCE, `/home/${DOMAIN}`, '-- --dry-run --no-pair')} </dev/null`,
					)
				).out;
				const ids = itemIds(report).filter((id) => id.startsWith('web.vhost.'));
				check(ids.length === 1, `expected one web.vhost item, saw ${ids.join(', ')}`);
				vhostId = ids[0] as string;
				const done = await ctx.runner.sh(
					`${rerunSh(INSTANCE, `/home/${DOMAIN}`, `-- --yes --no-pair --decide ${vhostId}=act`)} </dev/null`,
				);
				check(done.code === 4, `a failing configtest must end FAILED (4), got ${done.code}`);
				check(
					(await must(ctx, `sha256sum ${vhost}`, 'sha')).split(' ')[0] === before,
					'the vhost was not restored',
				);
				await must(
					ctx,
					`systemctl is-active ${el ? 'httpd' : 'apache2'}`,
					'the web server stayed up',
				);
			} finally {
				// Never leave the web server broken for the legs after this one.
				await ctx.runner.sh(`rm -f ${broken}`);
			}
			const again = await ctx.runner.sh(
				`${rerunSh(INSTANCE, `/home/${DOMAIN}`, `-- --yes --no-pair --decide ${vhostId}=act`)} </dev/null`,
			);
			check(again.code === 0, `the repaired run exited ${again.code}`);
		},
	},
	{
		name: 'kill-resume',
		family: 'both',
		required: true,
		what: 'kill -9 of init right after a begin: without --resume REFUSED naming the item; with it, converged',
		async run(ctx) {
			const el = ctx.args.family === 'el';
			const vhost = el
				? `/etc/httpd/conf.d/${DOMAIN}-ssl.conf`
				: `/etc/apache2/sites-available/${DOMAIN}-ssl.conf`;
			await putRootFile(
				ctx,
				vhost,
				APACHE_VHOST(DOMAIN, `/home/${DOMAIN}`, siteLogDir(ctx.args.family, 'apache', DOMAIN)),
				'0644',
			);
			const report = (
				await ctx.runner.sh(
					`${rerunSh(INSTANCE, `/home/${DOMAIN}`, '-- --dry-run --no-pair')} </dev/null`,
				)
			).out;
			const id = itemIds(report).find((i) => i.startsWith('web.vhost.'));
			check(id !== undefined, 'no web.vhost item to interrupt');
			const journal = `/var/lib/dedalo_publication_host_init/${INSTANCE}/journal.jsonl`;
			// Start init, wait for the item's begin record, kill -9 the whole process group.
			await must(
				ctx,
				`( setsid ${rerunSh(INSTANCE, `/home/${DOMAIN}`, `-- --yes --no-pair --decide ${id}=act`)} </dev/null >/tmp/dd_kill.log 2>&1 & echo $! > /tmp/dd_kill.pid ); ` +
					`for i in $(seq 1 600); do tail -n1 ${journal} | grep -q '"item":"${id}","phase":"begin"' && break; sleep 0.05; done; ` +
					'kill -9 -- -$(cat /tmp/dd_kill.pid) 2>/dev/null || kill -9 $(cat /tmp/dd_kill.pid)',
				'interrupt init mid-item',
			);
			const refused = await ctx.runner.sh(
				`${rerunSh(INSTANCE, `/home/${DOMAIN}`, '-- --yes --no-pair')} </dev/null`,
			);
			check(
				refused.code === 3,
				`an unfinished run without --resume must be REFUSED (3), got ${refused.code}`,
			);
			check(
				`${refused.out}${refused.err}`.includes(id as string),
				'the refusal does not name the unfinished item',
			);
			const resumed = await ctx.runner.sh(
				`${rerunSh(INSTANCE, `/home/${DOMAIN}`, `-- --yes --no-pair --resume --decide ${id}=act`)} </dev/null`,
			);
			check(resumed.code === 0, `--resume exited ${resumed.code}\n${resumed.out}${resumed.err}`);
			const apache = await must(
				ctx,
				el ? 'apachectl -t 2>&1' : 'apache2ctl -t 2>&1',
				'configtest after resume',
			);
			check(apache.includes('Syntax OK'), 'the web server configuration is broken after resume');
		},
	},
	{
		name: 'precreated-api-files',
		family: 'both',
		required: true,
		what: 'a second instance whose two API files exist with the right metadata: no terminal, --yes converges (the right-metadata path), and siblings share the host group',
		async run(ctx) {
			await makeSite(ctx, SECOND_DOMAIN, 'apache');
			// The files' metadata only exists after apply: run once to create the tree (no TTY → REFUSED on the secrets).
			await putRootFile(
				ctx,
				`/root/${SECOND_INSTANCE}.draft.json`,
				draftFor(SECOND_INSTANCE, SECOND_DOMAIN),
			);
			const digest = await sourceDigest(ctx);
			const vhostId = `web.vhost.${vhostSha8(ctx.args.family === 'el' ? `/etc/httpd/conf.d/${SECOND_DOMAIN}-ssl.conf` : `/etc/apache2/sites-available/${SECOND_DOMAIN}-ssl.conf`, 443, SECOND_DOMAIN)}`;
			const first = await ctx.runner.sh(
				`${installSh(ctx, SECOND_INSTANCE, `--source ${q(ctx.source)} --draft /root/${SECOND_INSTANCE}.draft.json --mirror ${ctx.mirror} --source-digest ${digest} -- --yes --no-pair --decide ${vhostId}=act`)} </dev/null`,
			);
			check(
				first.code === 3,
				`without a terminal the secret items must stay open (REFUSED 3), got ${first.code}`,
			);
			const home = `/home/${SECOND_DOMAIN}/dedalo/publication_api`;
			check(
				(await ctx.runner.sh(`test -d ${home}/v2/shared`)).code === 0,
				`the no-terminal run applied nothing (no ${home}/v2/shared):\n${first.out.slice(-3000)}${first.err.slice(-2000)}`,
			);
			await must(
				ctx,
				[
					`install -o root -g ${SECOND_INSTANCE}_v2 -m 0640 ${q(join(ctx.source, 'publication/server_api/v2/.env.example'))} ${home}/v2/shared/v2.env`,
					`install -o ${SECOND_INSTANCE}_v1 -m 0400 ${q(join(ctx.source, 'publication/server_api/v1/config_api/sample.server_config_api.php'))} ${home}/v1/shared/server_config_api.php`,
				].join(' && '),
				'pre-create the API files',
			);
			// Source mode again: rerun.env (re-run mode's input) is written only by a run that ENDED
			// right (init.keep_ref is always last), and the first run ended REFUSED on the secrets.
			const second = await ctx.runner.sh(
				`${installSh(ctx, SECOND_INSTANCE, `--source ${q(ctx.source)} --draft /root/${SECOND_INSTANCE}.draft.json --mirror ${ctx.mirror} --source-digest ${digest} -- --yes --no-pair --decide ${vhostId}=act`)} </dev/null`,
			);
			check(
				second.code === 0,
				`the right-metadata run exited ${second.code}\n${second.out}${second.err}`,
			);
			await healthOverSocket(ctx, SECOND_INSTANCE);
			await healthOverSocket(ctx, INSTANCE);
		},
	},
	{
		name: 'v2-only-site',
		family: 'both',
		required: true,
		what: 'a draft without the v1 block: no PHP discovered, asked or provisioned (no v1 account, pool, tree, handler, PHP_BIN); the agent serves v2 only (status served_apis) and refuses a v1 release api_not_served',
		async run(ctx) {
			await makeSite(ctx, V2_ONLY_DOMAIN, 'apache');
			const transcript = await guidedInstall(
				ctx,
				V2_ONLY_INSTANCE,
				V2_ONLY_DOMAIN,
				'',
				draftFor(V2_ONLY_INSTANCE, V2_ONLY_DOMAIN, { apis: undefined }),
			);
			for (const item of [
				'host.fpm_install',
				'host.fpm_cli',
				'declaration.v1_user',
				'account.v1_user',
				'api_config.v1_config',
				'api_config.v1_db_transport',
			])
				check(!transcript.includes(`[${item}]`), `a v2-only run printed the PHP item ${item}`);
			check(
				transcript.includes('v2 only: no PHP anywhere'),
				'declaration.apis did not say v2 only',
			);
			const home = `/home/${V2_ONLY_DOMAIN}`;
			const conf = `/etc/dedalo_publication_host/${V2_ONLY_INSTANCE}`;
			check(
				(await ctx.runner.sh(`getent passwd ${V2_ONLY_INSTANCE}_v1`)).code !== 0,
				'a v1 account was created for a v2-only site',
			);
			await must(ctx, `getent passwd ${V2_ONLY_INSTANCE}_v2`, 'the v2 account');
			check(
				(await ctx.runner.sh(`test -e ${home}/dedalo/publication_api/v1`)).code !== 0,
				'a v1 tree exists on a v2-only site',
			);
			check(
				(
					await ctx.runner.sh(
						`ls /etc/php*/*/fpm/pool.d/dedalo_${V2_ONLY_INSTANCE}_v1.conf /etc/php-fpm.d/dedalo_${V2_ONLY_INSTANCE}_v1.conf /etc/opt/remi/php*/php-fpm.d/dedalo_${V2_ONLY_INSTANCE}_v1.conf /etc/logrotate.d/dedalo_${V2_ONLY_INSTANCE}_v1 /var/lib/dedalo_publication_host/${V2_ONLY_INSTANCE} 2>/dev/null | grep -q .`,
					)
				).code !== 0,
				'a v1 pool, v1 log rotation or v1 pool directory exists on a v2-only site',
			);
			const declared = await must(
				ctx,
				`cat /etc/dedalo_publication_host/${V2_ONLY_INSTANCE}.json`,
				'the declaration',
			);
			check(
				!/"v1"|php_bin|"fpm"/.test(declared) && declared.includes('"os_family"'),
				`the declaration is not v2-only:\n${declared}`,
			);
			check(
				!(await must(ctx, `cat ${conf}/agent.env`, 'agent.env')).includes('PHP_BIN'),
				'agent.env carries PHP_BIN',
			);
			const include = await must(ctx, `cat ${conf}/web.apache.conf`, 'the web include');
			check(
				!/^Alias |SetHandler|fcgi/m.test(include) && include.includes('ProxyPass'),
				`the web include is not v2-only:\n${include}`,
			);
			await must(
				ctx,
				`stat -c '%U:%G %a' ${home}/dedalo/publication_api/v2/shared/v2.env`,
				'v2.env',
			);
			await healthOverSocket(ctx, V2_ONLY_INSTANCE);
			const curl = (path: string, extra = '') =>
				`curl -s -o /tmp/dd_v2only -w '%{http_code}' --unix-socket /run/dedalo_publication_host/${V2_ONLY_INSTANCE}/agent.sock ` +
				`-H "Authorization: Bearer $(cat ${conf}/credentials/SERVICE_TOKEN)" ${extra} http://localhost/publication/host_agent${path}; echo; cat /tmp/dd_v2only`;
			const status = (await must(ctx, curl('/v1/status'), 'GET /v1/status')).split('\n');
			check(
				status[0] === '200' && /"served_apis":\["v2"\]/.test(status.slice(1).join('\n')),
				`status: ${status.join(' ')}`,
			);
			const refused = (
				await must(
					ctx,
					curl(
						'/v1/releases/v1',
						`-X POST -H 'Content-Type: application/gzip' -H 'X-Dedalo-Actor: init_drill' -H 'X-Release-Id: 7.0.0_aaaaaaa' -H 'X-Bundle-Sha256: ${'a'.repeat(64)}' --data-binary x`,
					),
					'POST /v1/releases/v1',
				)
			).split('\n');
			check(
				refused[0] === '422' && refused.slice(1).join('\n').includes('"reason":"api_not_served"'),
				`a v1 install answered ${refused.join(' ')}`,
			);
		},
	},
	{
		name: 'kit-install',
		family: 'both',
		required: true,
		what: 'the guided path on two machines: `hostagent:pack` builds ONE kit here (real production install, v2-only draft), the target gets only that file; a kit whose sha256 differs from --kit-sha256 is refused before tar runs; `tar -xzf kit install.sh` + `sh install.sh --kit --kit-sha256` verifies the MANIFEST and converges; the installed agent has no tests and no dev dependencies',
		async run(ctx) {
			await makeSite(ctx, KIT_DOMAIN, 'apache');
			const { kit, sha256 } = await packKit(
				ctx,
				draftFor(KIT_INSTANCE, KIT_DOMAIN, { apis: undefined }),
			);
			const dir = '/root/kit';
			await must(ctx, `rm -rf ${dir} && install -d -m 0700 ${dir}`, 'the kit directory');
			await copyIn(ctx, kit, `${dir}/kit.tar.gz`);
			const seen = await must(ctx, `sha256sum ${dir}/kit.tar.gz`, 'sha256sum the kit');
			check(seen.startsWith(sha256), `the copied kit's sha256 is ${seen.trim()}, not ${sha256}`);
			await must(
				ctx,
				`cd ${dir} && tar -xzf kit.tar.gz install.sh`,
				'extract install.sh from the kit',
			);
			// A kit that is not the one the work host printed: refused before tar reads it, nothing staged.
			await must(
				ctx,
				`cp ${dir}/kit.tar.gz ${dir}/bad.tar.gz && printf x >> ${dir}/bad.tar.gz`,
				'make an altered kit',
			);
			const bad = await ctx.runner.sh(
				`sh ${dir}/install.sh ${KIT_INSTANCE} --kit ${dir}/bad.tar.gz --kit-sha256 ${sha256} --mirror ${ctx.mirror} -- --no-pair </dev/null`,
			);
			check(
				bad.code === 3 && bad.err.includes(`not the --kit-sha256 ${sha256}`),
				`an altered kit was not refused by its sha256: exit ${bad.code}\n${bad.out}${bad.err}`,
			);
			check(
				(
					await ctx.runner.sh(
						`test -e /var/lib/dedalo_publication_host_init/${KIT_INSTANCE}/stage/kit`,
					)
				).code !== 0,
				'the altered kit was extracted',
			);
			// --kit with --draft is refused: the kit carries its draft.
			const both = await ctx.runner.sh(
				`sh ${dir}/install.sh ${KIT_INSTANCE} --kit ${dir}/kit.tar.gz --draft /etc/hostname </dev/null`,
			);
			check(
				both.code === 3 && both.err.includes('--kit carries its draft'),
				`--kit --draft: exit ${both.code} ${both.err}`,
			);
			const run = await drivePty(
				ctx.runner,
				`sh ${dir}/install.sh ${KIT_INSTANCE} --kit ${dir}/kit.tar.gz --kit-sha256 ${sha256} --mirror ${ctx.mirror} -- --no-pair`,
				ctx.secrets,
			);
			check(!run.transcript.includes('[SECRET LEAKED]'), 'a typed secret appeared on the terminal');
			check(
				run.code === 0,
				`install from the kit exited ${run.code}; answered ${run.answered.join(', ')}\n${run.transcript.slice(-4000)}`,
			);
			check(
				run.transcript.includes(`sha256 ${sha256}, MANIFEST verified`),
				'install.sh did not report the verified MANIFEST',
			);
			check(
				!run.answered.includes('source digest'),
				'a kit install asked the source-digest question (the kit sha256 is the consent)',
			);
			// Converged: the kit it was given is offered for removal and removed — only that file
			// (the altered copy beside it is not the one install.sh verified).
			check(
				run.answered.includes('remove the kit'),
				'a converged kit install did not offer to remove its kit',
			);
			check(
				(await ctx.runner.sh(`test -e ${dir}/kit.tar.gz`)).code !== 0,
				'the kit is still there after the operator confirmed its removal',
			);
			await must(
				ctx,
				`test -f ${dir}/bad.tar.gz && test -f ${dir}/install.sh`,
				'the files the kit removal must not touch',
			);
			const home = `/home/${KIT_DOMAIN}`;
			await must(
				ctx,
				`test -f ${home}/host_agent/node_modules/zod/package.json`,
				'the production dependency',
			);
			for (const absent of [
				'tests',
				'node_modules/typescript',
				'node_modules/@types',
				'.env.test',
				'deploy/examples',
			])
				check(
					(await ctx.runner.sh(`test -e ${home}/host_agent/${absent}`)).code !== 0,
					`the kit-installed agent carries ${absent}`,
				);
			check(
				(
					await ctx.runner.sh(
						`test -e /var/lib/dedalo_publication_host_init/${KIT_INSTANCE}/kept/sample.server_config_api.php`,
					)
				).code !== 0,
				'a v2-only kit kept a v1 sample',
			);
			await healthOverSocket(ctx, KIT_INSTANCE);
			// The re-run needs no kit: rerun.env names the installed Bun and agent.
			const rerun = await ctx.runner.sh(
				`${rerunSh(KIT_INSTANCE, home, '-- --yes --no-pair')} </dev/null`,
			);
			check(
				rerun.code === 0,
				`re-run without the kit exited ${rerun.code}\n${rerun.out.slice(-2000)}${rerun.err}`,
			);
		},
	},
	{
		name: 'nginx-host-map',
		family: 'both',
		required: true,
		what: 'nginx with conf.d in http{}: the provisioned map include, the map pushed as rules.map through a mock engine, rendered by the root renderer (one contribution: byte-identical to buildNginxMap()), loaded by nginx',
		async run(ctx) {
			const el = ctx.args.family === 'el';
			await must(
				ctx,
				`systemctl stop ${el ? 'httpd' : 'apache2'} && systemctl disable ${el ? 'httpd' : 'apache2'} && systemctl enable --now nginx`,
				'switch to nginx',
			);
			await makeSite(ctx, NGINX_DOMAIN, 'nginx');
			await guidedInstall(ctx, NGINX_INSTANCE, NGINX_DOMAIN);
			await must(
				ctx,
				"grep -q '^# dedalo-provision: _host nginx_map_include ' /etc/nginx/conf.d/dedalo_media_map.conf",
				'the _host-stamped map include',
			);
			const map = await engineMap();
			const pushed = await pushMap(ctx, NGINX_INSTANCE, map);
			check(pushed.status === 200, `rules.map answered ${pushed.status}: ${pushed.body}`);
			const answer = JSON.parse(pushed.body) as {
				hash?: string;
				host_hash?: string;
				contributions?: number;
				reloaded?: boolean;
			};
			check(
				answer.hash === map.hash && answer.host_hash === map.hash && answer.contributions === 1,
				`rules.map answer ${pushed.body}`,
			);
			const live = await must(
				ctx,
				'cat /var/lib/dedalo_publication_host/_host/nginx_map/dedalo_media_map.nginx.conf',
				'the live map',
			);
			check(
				live.trimEnd() === map.text.trimEnd(),
				'one contribution: the live map is not byte-identical to buildNginxMap()',
			);
			const dumped = await must(ctx, 'nginx -T 2>/dev/null', 'nginx -T');
			check(dumped.includes('$dedalo_auth_key'), 'nginx does not load the map');
			const result = JSON.parse(
				await must(
					ctx,
					'cat /var/lib/dedalo_publication_host/_host/nginx_map/result.json',
					'result.json',
				),
			) as { outcome?: string };
			check(result.outcome !== undefined, 'the root renderer wrote no result.json');
		},
	},
	{
		name: 'hand-map-migration',
		family: 'both',
		required: true,
		what: "a guide-style hand-placed map with loaded media includes → init's web.nginx_manual_map act converges in ONE configtest + reload, the hand map removed, the live map seeded",
		async run(ctx) {
			const map = await engineMap();
			// Undo the provisioned map to model a guide-installed host: the hand map in conf.d.
			await must(
				ctx,
				'rm -f /etc/nginx/conf.d/dedalo_media_map.conf && rm -rf /var/lib/dedalo_publication_host/_host/nginx_map/dedalo_media_map.nginx.conf',
				'remove the provisioned map',
			);
			await putRootFile(
				ctx,
				'/etc/nginx/conf.d/dedalo_hand_map.conf',
				`${map.text.trimEnd()}\n`,
				'0644',
			);
			await must(ctx, 'nginx -t 2>&1 && systemctl reload nginx', 'the hand map loads');
			const report = (
				await ctx.runner.sh(
					`${rerunSh(NGINX_INSTANCE, `/home/${NGINX_DOMAIN}`, '-- --dry-run --no-pair')} </dev/null`,
				)
			).out;
			const id = itemIds(report).find((i) => i.startsWith('web.nginx_manual_map.'));
			check(id !== undefined, `no web.nginx_manual_map item for the hand map\n${report}`);
			const done = await ctx.runner.sh(
				`${rerunSh(NGINX_INSTANCE, `/home/${NGINX_DOMAIN}`, `-- --yes --no-pair --decide ${id}=act`)} </dev/null`,
			);
			check(done.code === 0, `the migration exited ${done.code}\n${done.out}${done.err}`);
			check(
				(await ctx.runner.sh('test -e /etc/nginx/conf.d/dedalo_hand_map.conf')).code !== 0,
				'the hand map is still there',
			);
			await must(
				ctx,
				'test -f /var/lib/dedalo_publication_host/_host/nginx_map/contrib/_seed.json',
				'the seed contribution',
			);
			await must(ctx, 'nginx -t 2>&1', 'one valid configuration after the migration');
			const pushed = await pushMap(ctx, NGINX_INSTANCE, map);
			check(pushed.status === 200, `the first real push after the seed answered ${pushed.status}`);
			check(
				(
					await ctx.runner.sh(
						'test -e /var/lib/dedalo_publication_host/_host/nginx_map/contrib/_seed.json',
					)
				).code !== 0,
				'the seed was not swept by the first real push',
			);
		},
	},
	{
		name: 'mixed-version-map',
		family: 'both',
		required: true,
		what: "an older instance's apply never downgrades the root renderer; a newer-grammar contribution under an older renderer is refused loudly (map_contribution_newer), the live map left as it is",
		async run(ctx) {
			const dir = '/var/lib/dedalo_publication_host/_host';
			const version = JSON.parse(
				await must(ctx, `cat ${dir}/map_renderer/VERSION`, 'renderer VERSION'),
			) as { grammar: number; digest: string };
			// Pretend a newer instance installed a newer renderer: apply of THIS (older) one must keep it.
			await putRootFile(
				ctx,
				`${dir}/map_renderer/VERSION`,
				`${JSON.stringify({ ...version, grammar: version.grammar + 1 })}\n`,
				'0644',
			);
			await must(
				ctx,
				`cd /home/${NGINX_DOMAIN}/host_agent && /home/${NGINX_DOMAIN}/.bun/bin/bun --no-env-file --no-install run src/provision/cli.ts apply ${NGINX_INSTANCE}`,
				'apply of the older instance',
			);
			const kept = JSON.parse(
				await must(ctx, `cat ${dir}/map_renderer/VERSION`, 'renderer VERSION'),
			) as { grammar: number };
			check(kept.grammar === version.grammar + 1, 'an older apply downgraded the root renderer');
			await putRootFile(ctx, `${dir}/map_renderer/VERSION`, `${JSON.stringify(version)}\n`, '0644');
			// A contribution of a grammar this renderer does not know, as an agent identities.json NAMES:
			// only nginx `conf_d` instances are there, so the nginx instance's own file is replaced (and
			// put back after). The second instance is apache: its file would be refused `undeclared`
			// before its grammar is ever read.
			const own = `${dir}/nginx_map/contrib/${NGINX_INSTANCE}.json`;
			const before = await must(
				ctx,
				`sha256sum ${dir}/nginx_map/dedalo_media_map.nginx.conf`,
				'sha',
			);
			const contrib = JSON.stringify({
				v: 1,
				grammar: version.grammar + 1,
				instance: NGINX_INSTANCE,
				hash: 'f'.repeat(64),
				envelope: 'x',
				pinsId: 'future',
			});
			await must(
				ctx,
				// Written beside it and renamed over it, as the agent writes its own (rules/map.ts): root may not
				// open the agent's existing file O_CREAT in the sticky, group-writable contrib/ where
				// fs.protected_regular is on (Ubuntu's default 2, measured on 24.04 — EACCES even for root).
				`cp -p ${own} /root/dd_contrib.bak && printf '%s' ${q(contrib)} > ${own}.dd && chown ${NGINX_INSTANCE}_agent:dedalo_pubhost ${own}.dd && chmod 0640 ${own}.dd && mv -f ${own}.dd ${own}`,
				'plant a newer contribution',
			);
			await ctx.runner.sh('systemctl start dedalo-pubhost-map.service');
			const result = await must(ctx, `cat ${dir}/nginx_map/result.json`, 'result.json');
			check(
				result.includes('map_contribution_newer'),
				`the newer contribution was not refused loudly: ${result}`,
			);
			check(
				(await must(ctx, `sha256sum ${dir}/nginx_map/dedalo_media_map.nginx.conf`, 'sha')) ===
					before,
				'the live map changed under a refused render',
			);
			await must(
				ctx,
				`cp -p /root/dd_contrib.bak ${own}.dd && mv -f ${own}.dd ${own}`,
				'put the real contribution back',
			);
		},
	},
	{
		name: 'agent-root-grant',
		family: 'both',
		required: true,
		what: "the agent's ONE root grant through the host's real sudo (sudo-rs where /usr/bin/sudo is it): `visudo -c` accepts the rendered rules; as each agent user `sudo -n <WEB_CONFIGTEST_BIN> -t` runs and any other argv is refused; a rules.apply over the running nginx instance's socket runs that configtest FROM THE AGENT'S OWN UNIT (its sandbox) and the polkit reload, and the host's auth log names the agent's configtest",
		async run(ctx) {
			const flavor = (await ctx.runner.sh('readlink -f /usr/bin/sudo')).out.trim();
			ctx.facts.sudo_realpath = flavor;
			await must(ctx, 'visudo -c', 'visudo -c over the whole policy, the rendered grants included');
			for (const instance of [INSTANCE, NGINX_INSTANCE]) {
				const env = await must(
					ctx,
					`cat /etc/dedalo_publication_host/${instance}/agent.env`,
					`${instance}: agent.env`,
				);
				const bin = env.match(/^WEB_CONFIGTEST_BIN="?([^"\n]+)"?$/m)?.[1];
				check(bin !== undefined, `${instance}: agent.env names no WEB_CONFIGTEST_BIN`);
				const user = `${instance}_agent`;
				const allowed = await ctx.runner.sh(
					`runuser -u ${user} -- /usr/bin/sudo -n ${q(bin as string)} -t`,
				);
				check(
					allowed.code === 0,
					`${instance}: as ${user}, sudo -n ${bin} -t exited ${allowed.code} (${flavor}):\n${allowed.out}${allowed.err}`,
				);
				// A command WITH arguments matches only those arguments: another argv is no grant.
				for (const other of [`${bin} -T`, `${bin}`, '/usr/bin/id']) {
					const refused = await ctx.runner.sh(`runuser -u ${user} -- /usr/bin/sudo -n ${other}`);
					check(
						refused.code !== 0,
						`${instance}: as ${user}, sudo -n ${other} was ALLOWED (${flavor})`,
					);
				}
			}
			// THE AGENT'S OWN PATH (publication/host_agent/src/exec.ts webConfigtest): its unit's sandbox decides whether a
			// setuid sudo may run at all. A stamped comment-only include passes the directive allowlist
			// with no media root; the drill's own push, never an engine's.
			const since = (await must(ctx, "date '+%Y-%m-%d %H:%M:%S'", 'date')).trim();
			const hash = createHash('sha256').update('init_drill agent-root-grant').digest('hex');
			const body = JSON.stringify({ server: 'nginx', hash, text: `# config-hash: ${hash}\n` });
			const done = await ctx.runner.sh(
				`curl -s -o /tmp/dd_rules -w '%{http_code}' --unix-socket /run/dedalo_publication_host/${NGINX_INSTANCE}/agent.sock ` +
					`-H "Authorization: Bearer $(cat /etc/dedalo_publication_host/${NGINX_INSTANCE}/credentials/SERVICE_TOKEN)" ` +
					`-H 'Content-Type: application/json' -H 'X-Dedalo-Actor: init_drill' --data-binary @- http://localhost/publication/host_agent/v1/rules/apply; echo; cat /tmp/dd_rules; rm -f /tmp/dd_rules`,
				{ stdin: body },
			);
			const [status = '0', ...rest] = done.out.split('\n');
			check(status.trim() === '200', `rules.apply answered ${status}: ${rest.join('\n')}`);
			const answer = JSON.parse(rest.join('\n')) as { hash?: string; reloaded?: boolean };
			check(
				answer.hash === hash && answer.reloaded === true,
				`rules.apply answer ${rest.join('\n')}`,
			);
			const auth = await must(
				ctx,
				`journalctl --no-pager --since ${q(since)} 2>&1; cat /var/log/secure /var/log/auth.log 2>/dev/null; true`,
				'the auth log since the push',
			);
			check(
				// The agent's unit runs in its home's host_agent/ (a runuser above runs elsewhere).
				new RegExp(
					`${NGINX_INSTANCE}_agent : .*PWD=/home/${escapeRegExp(NGINX_DOMAIN)}/host_agent ; .*COMMAND=/usr/sbin/nginx -t`,
				).test(auth),
				`no sudo line names ${NGINX_INSTANCE}_agent running /usr/sbin/nginx -t since ${since}: the configtest did not go through sudo`,
			);
			console.log(
				`${TAG}      sudo: ${flavor}; the agent's configtest ran through it from its unit`,
			);
		},
	},
	// ── EL only ──
	{
		name: 'selinux-labels',
		family: 'el',
		required: true,
		what: `every S9 rule registered (semanage fcontext -l -C), the v2 port typed http_port_t, restorecon -n -v empty on every target; the HOME layout's v2 tree (v2.env included) is ${V2_TREE_TYPE}, the policy module ${SELINUX_MODULE} installed (one v2 type on every layout)`,
		async run(ctx) {
			const local = await must(ctx, 'semanage fcontext -l -C', 'semanage fcontext -l -C');
			const rules = await s9Rules(INSTANCE);
			// One v2 type on every layout (owner decision 2026-10-09): the home layout's v2 tree too.
			const v2Rule = rules.find(
				(rule) => rule.path === `/home/${DOMAIN}/dedalo/publication_api/v2`,
			);
			check(
				v2Rule?.type === V2_TREE_TYPE && v2Rule.recursive,
				`the home layout's v2 rule is ${JSON.stringify(v2Rule)}, not ${V2_TREE_TYPE}`,
			);
			const listed = await must(
				ctx,
				`semodule --list-modules=full | awk '$2 == "${SELINUX_MODULE}"'`,
				'semodule --list-modules=full',
			);
			check(
				/^400 dedalo_publication_host\s+cil\s*$/.test(listed.trim()),
				`the home-layout install did not install the module: '${listed.trim()}'`,
			);
			const v2Home = `/home/${DOMAIN}/dedalo/publication_api/v2`;
			const v2Labels = await must(
				ctx,
				`stat -c '%C %n' ${q(v2Home)} ${q(`${v2Home}/shared`)} ${q(`${v2Home}/shared/v2.env`)}`,
				'the home v2 tree labels',
			);
			for (const line of v2Labels.trim().split('\n'))
				check(line.split(':')[2] === V2_TREE_TYPE, `not ${V2_TREE_TYPE}: ${line}`);
			ctx.facts.home_v2_type = v2Labels.trim().split('\n')[0]?.split(':')[2] ?? null;
			for (const rule of rules)
				check(
					local.includes(rule.spec) && local.includes(rule.type),
					`the S9 rule ${rule.spec} ${rule.type} is not registered`,
				);
			const pending = await must(
				ctx,
				`restorecon -n -v -R ${rules
					.filter((r) => r.recursive)
					.map((r) => q(r.path))
					.join(' ')} 2>&1; restorecon -n -v ${rules
					.filter((r) => !r.recursive)
					.map((r) => q(r.path))
					.join(' ')} 2>&1`,
				'restorecon -n',
			);
			check(pending.trim() === '', `restorecon would still relabel:\n${pending}`);
			ctx.facts.home_traverse_type =
				(await must(ctx, `stat -c '%C' /home/${DOMAIN}`, 'home label')).trim().split(':')[2] ??
				null;
		},
	},
	{
		name: 'v1-handler-probe',
		family: 'el',
		required: true,
		what: "a probe .php and a probe .phtml under the v1 release answer v1.user and fpm-fcgi through httpd: the include's <If> handler beats conf.d/php.conf's (this VM's EL major) — and under mod_php when it is loaded",
		async run(ctx) {
			const root = `/home/${DOMAIN}/dedalo/publication_api/v1`;
			// The PROCESS's user: get_current_user()/getmyuid() name the script file's OWNER (root here),
			// posix_geteuid() needs php-process (not installed by default on EL) and open_basedir hides
			// /proc — so the probe creates a file in the pool's own sys_temp_dir and reports its owner.
			const probe =
				"<?php $f = tempnam(sys_get_temp_dir(), 'dd'); $u = fileowner($f); unlink($f); echo $u . '|' . php_sapi_name();";
			const v1Uid = (await must(ctx, `id -u ${INSTANCE}_v1`, 'the v1 uid')).trim();
			await must(
				ctx,
				`systemctl disable --now nginx; systemctl enable --now httpd`,
				'back to httpd',
			);
			await must(
				ctx,
				`install -d ${root}/releases/0.0.0_drill00 && printf '%s' ${q(probe)} > ${root}/releases/0.0.0_drill00/probe.php && cp ${root}/releases/0.0.0_drill00/probe.php ${root}/releases/0.0.0_drill00/probe.phtml && ln -sfn releases/0.0.0_drill00 ${root}/current && restorecon -R ${root}`,
				'a probe release',
			);
			for (const file of ['probe.php', 'probe.phtml']) {
				const got = await webCheck(ctx, DOMAIN, `/dedalo/publication/server_api/v1/${file}`);
				check(
					got.status === 200 && got.body.trim() === `${v1Uid}|fpm-fcgi`,
					`${file} answered ${got.status} '${got.body.trim()}'`,
				);
			}
			ctx.facts.php_conf_if = (
				await ctx.runner.sh("grep -c '<If' /etc/httpd/conf.d/php.conf")
			).out.trim();
			const modules = await must(ctx, 'httpd -M 2>&1', 'httpd -M');
			ctx.facts.mod_php = /php\d?_module/.test(modules);
			const phpVersion = (
				await must(ctx, `php -r 'echo PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION;'`, 'php version')
			).trim();
			const lint = await ctx.runner.sh(
				`find ${q(join(ctx.source, 'publication/server_api/v1'))} -name '*.php' -exec php -l {} + >/dev/null 2>&1`,
			);
			if (lint.code === 0) ctx.facts.v1_php_floor = phpVersion;
		},
	},
	{
		name: 'home-login-and-logs',
		family: 'el',
		required: true,
		what: 'the site user still logs in over sshd into its relabelled, root-owned home; httpd writes the site log outside it (/var/log/httpd/<domain>)',
		async run(ctx) {
			const user = DOMAIN.split('.')[0] ?? 'museum';
			await must(
				ctx,
				`install -d -m 0700 /root/.dd_ssh && rm -f /root/.dd_ssh/k* && ssh-keygen -q -t ed25519 -N '' -f /root/.dd_ssh/k && install -d -o ${user} -m 0700 /home/${DOMAIN}/.ssh && install -o ${user} -m 0600 /root/.dd_ssh/k.pub /home/${DOMAIN}/.ssh/authorized_keys && restorecon -R /home/${DOMAIN}/.ssh`,
				'a key for the site user',
			);
			await must(
				ctx,
				`ssh -i /root/.dd_ssh/k -o BatchMode=yes -o StrictHostKeyChecking=no ${user}@127.0.0.1 true`,
				'sshd login of the site user',
			);
			const pending = await must(
				ctx,
				`restorecon -n -v /home/${DOMAIN} 2>&1`,
				'restorecon -n on the home',
			);
			check(pending.trim() === '', `the home would be relabelled: ${pending}`);
			const before = Number(
				(
					await must(
						ctx,
						`stat -c %s ${siteLogDir('el', 'apache', DOMAIN)}/access.log 2>/dev/null || echo 0`,
						'log size',
					)
				).trim(),
			);
			await webCheck(ctx, DOMAIN, '/');
			const after = Number(
				(
					await must(ctx, `stat -c %s ${siteLogDir('el', 'apache', DOMAIN)}/access.log`, 'log size')
				).trim(),
			);
			check(after > before, `httpd did not write ${siteLogDir('el', 'apache', DOMAIN)}/access.log`);
		},
	},
	{
		name: 'network-media',
		family: 'el',
		required: true,
		what: 'an NFS media mount with the printed context= option is served by httpd (no httpd_use_nfs)',
		async run(ctx) {
			check(
				ctx.args.mediaNfs !== null,
				'give --media-nfs host:/export (or --skip network-media; the record then names it skipped)',
			);
			await must(
				ctx,
				`install -d /mnt/dd_media && mount -t nfs4 -o ro,context="system_u:object_r:httpd_sys_content_t:s0" ${q(ctx.args.mediaNfs as string)} /mnt/dd_media`,
				'mount the media with context=',
			);
			const bool = (await must(ctx, 'getsebool httpd_use_nfs', 'getsebool')).trim();
			check(bool.endsWith('off'), 'httpd_use_nfs is on: the leg would not prove the mount option');
			const label = (await must(ctx, "stat -c '%C' /mnt/dd_media", 'label')).trim();
			check(label.includes('httpd_sys_content_t'), `the mount is labelled ${label}`);
		},
	},
	{
		name: 'fapolicyd',
		family: 'el',
		required: true,
		what: "fapolicyd started (integrity = sha256, allow_filesystem_mark = 1) on the converged host (`dnf install fapolicyd` beforehand; the leg starts it, and stops it after): the provisioner already trusted the instance while fapolicyd was installed but stopped (its stamped trust.d file names bun_bin and the agent's tree; its trust oneshot and polkit grant are rendered); a copy of that Bun at an untrusted path is DENIED to the agent (the control) while bun_bin runs for the agent and v2 accounts; with the trust file moved aside the restarted agent stays down and install.sh's pre-hand-over gate refuses the Bun; init's re-run reports host.fapolicyd, host.fapolicyd_integrity and host.fapolicyd_mounts right and converges; then two minimal v2 releases (their entry a %languages type, text/x-java) are PUSHED through the agent (its trust oneshot trusts each before the scratch boot), v2 answers its /health on each, a rollback answers too; an untrusted copy of the entry is denied to the v2 account, and the trusted entry with one byte changed in place is denied to it (in a namespaced unit and directly) until the byte is put back, when v2 answers again",
		async run(ctx) {
			check(
				(await ctx.runner.sh('rpm -q fapolicyd')).code === 0,
				'fapolicyd is not installed on this VM (dnf install fapolicyd; the leg starts and stops it itself)',
			);
			const unit = await instanceUnits(INSTANCE);
			const home = `/home/${DOMAIN}`;
			const trustFile = `/etc/fapolicyd/trust.d/dedalo_${INSTANCE}`;
			const trustUnit = `dedalo-pubhost-trust-${INSTANCE}.service`;
			const socket = `/run/dedalo_publication_host/${INSTANCE}/agent.sock`;
			const conf = '/etc/fapolicyd/fapolicyd.conf';
			const runsAs = async (user: string, bin: string): Promise<boolean> =>
				(await ctx.runner.sh(`runuser -u ${user} -- ${q(bin)} --version`)).code === 0;
			const untilRuns = (user: string, bin: string, ok: boolean, what: string) =>
				must(
					ctx,
					`for i in $(seq 1 120); do runuser -u ${user} -- ${q(bin)} --version >/dev/null 2>&1; r=$?; [ ${ok ? '$r -eq 0' : '$r -ne 0'} ] && exit 0; sleep 0.5; done; exit 1`,
					what,
					90_000,
				);
			// 1. Converged while fapolicyd was installed but stopped: the trust is already provisioned.
			const trusted = await must(
				ctx,
				`cat ${trustFile}`,
				`the provisioned trust file ${trustFile}`,
			);
			check(
				trusted.startsWith(`# dedalo-provision: ${INSTANCE} fapolicyd_trust `),
				`${trustFile} does not carry our stamp:\n${trusted.slice(0, 300)}`,
			);
			const lines = trusted.split('\n').filter((line) => line.startsWith('/'));
			check(
				lines.some((line) => line.startsWith(`${unit.bunBin} `)) &&
					lines.some((line) => line.startsWith(`${unit.agentDir}/src/index.ts `)),
				`${trustFile} does not trust bun_bin and the agent's tree (${lines.length} lines)`,
			);
			await must(ctx, `systemctl cat ${trustUnit} >/dev/null`, `the rendered ${trustUnit}`);
			await must(
				ctx,
				`grep -q '"${trustUnit}" && verb === "start"' /etc/polkit-1/rules.d/60-dedalo-publication-host-${INSTANCE}.rules`,
				'the polkit start grant of the trust unit',
			);
			const original = await must(ctx, `cat ${conf}`, 'read fapolicyd.conf');
			// Written BEFORE fapolicyd starts: the drill's own Bun is not trusted, so a child of it could not read its TypeScript after.
			const r1 = await miniV2Release(ctx, 'r1');
			const r2 = await miniV2Release(ctx, 'r2');
			const probe = '/usr/local/libexec/dd_fapolicyd_probe';
			const copy = '/usr/local/libexec/dd_untrusted_bun';
			try {
				// 2. integrity = sha256 and allow_filesystem_mark = 1 (init's two recommendations: without the
				//    mark fapolicyd never sees what a sandboxed unit opens — measured), then start fapolicyd and
				//    wait until it enforces (`active` comes before the daemon has loaded its trust database).
				await must(
					ctx,
					`sed -i -E 's/^[[:space:]]*integrity[[:space:]]*=.*/integrity = sha256/; s/^[[:space:]]*allow_filesystem_mark[[:space:]]*=.*/allow_filesystem_mark = 1/' ${conf} && grep -q '^integrity = sha256' ${conf} && grep -q '^allow_filesystem_mark = 1' ${conf}`,
					'set integrity = sha256 and allow_filesystem_mark = 1',
				);
				await must(
					ctx,
					`install -D -m 0755 /usr/bin/true ${probe} && systemctl enable --now fapolicyd && for i in $(seq 1 240); do runuser -u nobody -- ${probe} 2>/dev/null || exit 0; sleep 0.5; done; echo 'fapolicyd never denied the untrusted probe'; exit 1`,
					'start fapolicyd (enforcing)',
					180_000,
				);
				// 3. The control: the same Bun at a path nobody trusted is denied to the agent; bun_bin is not.
				await must(
					ctx,
					`install -m 0755 ${q(unit.bunBin)} ${copy}`,
					'an untrusted copy of the Bun',
				);
				check(
					!(await runsAs(`${INSTANCE}_agent`, copy)),
					`an untrusted copy of ${unit.bunBin} runs as ${INSTANCE}_agent: fapolicyd does not enforce, the leg proves nothing`,
				);
				await untilRuns(
					`${INSTANCE}_agent`,
					unit.bunBin,
					true,
					`the provisioned trust makes ${unit.bunBin} runnable by ${INSTANCE}_agent`,
				);
				check(
					await runsAs(`${INSTANCE}_v2`, unit.bunBin),
					`the provisioned trust does not make ${unit.bunBin} runnable by ${INSTANCE}_v2`,
				);
				// 4. Without its trust file the instance's units do not run: the agent restarted then stays down
				//    (the trust file, not luck, is what lets the sandboxed agent run) — and install.sh's
				//    pre-hand-over gate (before any unit exists root must read the code) refuses the installed
				//    Bun with the line that trusts it.
				await must(
					ctx,
					`mv ${trustFile} /root/dd_trust.aside && fapolicyd-cli --update`,
					'move the trust aside',
				);
				await untilRuns(
					`${INSTANCE}_agent`,
					unit.bunBin,
					false,
					`${unit.bunBin} is denied without its trust`,
				);
				await ctx.runner.sh(`systemctl restart ${unit.agent}`, { timeoutMs: 60_000 });
				const down = await ctx.runner.sh(
					`for i in $(seq 1 10); do curl -fsS --max-time 2 --unix-socket ${socket} http://localhost/publication/host_agent/health >/dev/null 2>&1 && exit 1; sleep 0.5; done; exit 0`,
					{ timeoutMs: 60_000 },
				);
				check(
					down.code === 0,
					`the agent answers /health without its trust file: fapolicyd does not check the sandboxed unit (allow_filesystem_mark?)`,
				);
				const gated = await ctx.runner.sh(
					`${rerunSh(INSTANCE, home, '-- --dry-run --no-pair')} </dev/null`,
				);
				check(
					gated.code === 3 &&
						gated.err.includes(`fapolicyd denies ${unit.bunBin} the code it runs`),
					`install.sh did not refuse the untrusted Bun: exit ${gated.code}\n${gated.out.slice(-1500)}${gated.err.slice(-1500)}`,
				);
				await must(
					ctx,
					`mv /root/dd_trust.aside ${trustFile} && fapolicyd-cli --update`,
					'restore the trust',
				);
				await untilRuns(
					`${INSTANCE}_agent`,
					unit.bunBin,
					true,
					`${unit.bunBin} runs again with its trust`,
				);
				// 5. The agent under fapolicyd, and init's re-run: both items right, nothing to run by hand.
				await must(
					ctx,
					`systemctl reset-failed ${unit.agent}; systemctl restart ${unit.agent}`,
					'restart the agent under fapolicyd',
					120_000,
				);
				await must(
					ctx,
					`for i in $(seq 1 60); do curl -fsS --max-time 5 --unix-socket ${socket} http://localhost/publication/host_agent/health >/dev/null 2>&1 && exit 0; sleep 0.5; done; exit 1`,
					'the agent answers under fapolicyd',
				);
				await healthOverSocket(ctx, INSTANCE);
				const rerun = await ctx.runner.sh(
					`${rerunSh(INSTANCE, home, '-- --yes --no-pair')} </dev/null`,
					{ timeoutMs: 600_000 },
				);
				check(
					rerun.code === 0,
					`the re-run under fapolicyd exited ${rerun.code}\n${rerun.out.slice(-3000)}${rerun.err}`,
				);
				const report = rerun.out;
				check(
					report.includes('trust is automatic: provision apply writes'),
					`init's host.fapolicyd does not say the trust is automatic:\n${report.slice(-3000)}`,
				);
				check(
					report.includes(
						'integrity = sha256: a trusted file changed after it was trusted is denied',
					),
					`host.fapolicyd_integrity is not right under integrity = sha256:\n${report.slice(-3000)}`,
				);
				check(
					report.includes(
						'allow_filesystem_mark = 1: fapolicyd checks what the sandboxed services open too',
					),
					`host.fapolicyd_mounts is not right under allow_filesystem_mark = 1:\n${report.slice(-3000)}`,
				);
				// 6. Two v2 releases PUSHED through the agent, then a rollback: each trusted before it ran.
				const healthUrl = (
					await must(
						ctx,
						`sed -n 's/^V2_HEALTH_URL="\\(.*\\)"$/\\1/p' /etc/dedalo_publication_host/${INSTANCE}/agent.env`,
						'V2_HEALTH_URL',
					)
				).trim();
				check(/^http:\/\/127\.0\.0\.1:\d+\//.test(healthUrl), `V2_HEALTH_URL is '${healthUrl}'`);
				const v2Answers = async (marker: string): Promise<void> => {
					await must(
						ctx,
						`for i in $(seq 1 60); do curl -fsS --max-time 5 ${q(healthUrl)} 2>/dev/null | grep -q '"release":"${marker}"' && exit 0; sleep 0.5; done; curl -sS --max-time 5 ${q(healthUrl)}; journalctl -u ${unit.v2Unit} -n 5 --no-pager 2>/dev/null; exit 1`,
						`v2 answers its /health as ${marker}`,
					);
				};
				const posted1 = await agentPost(
					ctx,
					socket,
					INSTANCE,
					'/publication/host_agent/v1/releases/v2',
					r1,
				);
				check(
					posted1.status === 200,
					`release.install ${r1.id} answered ${posted1.status}: ${posted1.body}`,
				);
				await v2Answers('r1');
				const record = JSON.parse(
					await must(
						ctx,
						`cat /etc/dedalo_publication_host/${INSTANCE}/fapolicyd_trust.json`,
						'the trust record',
					),
				) as { outcome: string; releases: string[] };
				check(
					['applied', 'unchanged'].includes(record.outcome) &&
						record.releases.includes(`v2:${r1.id}`),
					`the trust record after ${r1.id}: ${JSON.stringify(record)}`,
				);
				check(
					(await must(ctx, `cat ${trustFile}`, 'the trust file')).includes(
						`/publication_api/v2/releases/${r1.id}/src/index.ts `,
					),
					`${trustFile} does not trust ${r1.id}`,
				);
				const posted2 = await agentPost(
					ctx,
					socket,
					INSTANCE,
					'/publication/host_agent/v1/releases/v2',
					r2,
				);
				check(
					posted2.status === 200,
					`release.install ${r2.id} answered ${posted2.status}: ${posted2.body}`,
				);
				await v2Answers('r2');
				const rolled = await agentPost(
					ctx,
					socket,
					INSTANCE,
					'/publication/host_agent/v1/releases/v2/rollback',
					null,
				);
				check(
					rolled.status === 200 && rolled.body.includes(`"to":"${r1.id}"`),
					`release.rollback answered ${rolled.status}: ${rolled.body}`,
				);
				await v2Answers('r1');
				// 7. What fapolicyd gates: the release entry is a %languages type, and the same type outside the
				//    trust set is DENIED to the v2 account — so v2 ran above only because the oneshot trusted it.
				const entry = `${unit.stateRoot}/publication_api/v2/releases/${r1.id}/src/index.ts`;
				const ftype = (
					await must(ctx, `fapolicyd-cli --ftype ${q(entry)}`, "the release entry's file type")
				).trim();
				check(
					/^(text\/x-java|application\/javascript|text\/javascript)$/.test(ftype),
					`the release entry is typed '${ftype}', not one of fapolicyd's %languages: the leg would prove nothing`,
				);
				const control = '/var/tmp/dd_fapolicyd_control';
				const ran = await ctx.runner.sh(
					`rm -rf ${control} && install -d -m 0755 ${control} && install -m 0644 ${q(entry)} ${control}/index.ts && cd /var/tmp && timeout 5 runuser -u ${INSTANCE}_v2 -- env PORT=0 ${q(unit.bunBin)} ${control}/index.ts; r=$?; rm -rf ${control}; exit $r`,
					{ timeoutMs: 30_000 },
				);
				check(
					ran.code !== 0 && ran.code !== 124,
					`an untrusted copy of the release entry ran as ${INSTANCE}_v2 (exit ${ran.code}): fapolicyd does not gate the v2 account`,
				);
				// 8. integrity = sha256: one byte of the trusted entry changed IN PLACE (same size, same inode,
				//    still valid TypeScript) is denied to the v2 account — in a namespaced transient unit, as
				//    v2's own units run, and directly — until the byte is put back. v2 itself is stopped
				//    first: a start fapolicyd denies makes Bun fall back to `bun run`, whose node shim links in
				//    the unit's PrivateTmp systemd may not unlink (an AVC per denied start, measured).
				const flip = (from: string, to: string) =>
					`off=$(grep -bo "pad = '${from}" ${q(entry)} | head -n1 | cut -d: -f1) && [ -n "$off" ] && printf '${to}' | dd of=${q(entry)} bs=1 seek=$((off + 7)) conv=notrunc 2>/dev/null && grep -q "pad = '${to}${from.slice(1)}'" ${q(entry)}`;
				await must(ctx, `systemctl stop ${unit.v2Unit}`, 'stop v2 before the change');
				await must(
					ctx,
					flip('aaaaaaaa', 'b'),
					'change one byte of the trusted release entry in place',
				);
				const asV2 = (how: string) =>
					how === 'unit'
						? `rm -rf /tmp/bun-node-*; systemd-run --wait -q -p User=${INSTANCE}_v2 -p ProtectHome=read-only -p ProtectSystem=strict -p WorkingDirectory=/var/tmp -p RuntimeMaxSec=5 /usr/bin/env PORT=0 ${q(unit.bunBin)} ${q(entry)}; r=$?; rm -rf /tmp/bun-node-*; exit $r`
						: `cd /var/tmp && timeout 5 runuser -u ${INSTANCE}_v2 -- env PORT=0 ${q(unit.bunBin)} ${q(entry)}; r=$?; rm -rf /tmp/bun-node-*; exit $r`;
				const inUnit = await ctx.runner.sh(asV2('unit'), { timeoutMs: 60_000 });
				const direct = await ctx.runner.sh(asV2('direct'), { timeoutMs: 30_000 });
				ctx.facts.fapolicyd_changed_entry = { unit: inUnit.code, direct: direct.code };
				// A server that is ALLOWED keeps running: the transient unit then ends at RuntimeMaxSec (non-zero too),
				// so the unit's verdict is its journal's EPERM; runuser's is a fast non-zero exit (124 = it ran).
				check(
					direct.code !== 0 && direct.code !== 124,
					`the changed entry ran as ${INSTANCE}_v2 (exit ${direct.code}): integrity = sha256 did not deny it`,
				);
				check(
					(
						await ctx.runner.sh(
							`journalctl --since '-30 s' --no-pager | grep -F 'EPERM reading "${entry}"' | grep -q .`,
						)
					).code === 0,
					`no EPERM for the changed entry in the namespaced unit's journal (exit ${inUnit.code}): fapolicyd did not deny it there`,
				);
				await must(ctx, flip('baaaaaaa', 'a'), 'put the byte back in place');
				await must(
					ctx,
					`systemctl reset-failed ${unit.v2Unit}; systemctl start ${unit.v2Unit}`,
					'start v2 on the restored entry',
					60_000,
				);
				await v2Answers('r1');
				ctx.facts.fapolicyd = true;
			} finally {
				// The legs after this one judge SELinux, not fapolicyd: leave the host as it was found —
				// v2 stopped too (no release ran before this leg; a v2 that answers lets httpd reuse a pooled
				// backend connection and hides booleans-measured's proxy denial).
				await ctx.runner.sh(`systemctl stop ${unit.v2Unit}`, { timeoutMs: 60_000 });
				await ctx.runner.sh(
					`[ -e /root/dd_trust.aside ] && mv /root/dd_trust.aside ${trustFile}; rm -f ${probe} ${copy}; cat > ${conf} <<'DD_CONF_EOF'\n${original.replace(/\n$/, '')}\nDD_CONF_EOF\nsystemctl disable --now fapolicyd; systemctl reset-failed ${unit.agent} ${unit.v2Unit}; systemctl restart ${unit.agent}`,
					{ timeoutMs: 120_000 },
				);
			}
		},
	},
	{
		name: 'home-v2-migration',
		family: 'el',
		required: true,
		what: `a home-layout install an earlier provisioner typed data_home_t (its v2 rule and selinux.state record data_home_t, the tree relabelled so — the footprint the code before 2026-10-09 left) is RE-TYPED by init's re-run: the rule is ${V2_TREE_TYPE}, the whole tree (v2.env, the current link, the pushed release) relabelled, restorecon -n empty, selinux.state records the new type, a second re-run changes nothing, v2 restarts and answers its /health; no AVC since the leg started`,
		async run(ctx) {
			const unit = await instanceUnits(INSTANCE);
			const home = `/home/${DOMAIN}`;
			const v2 = `${unit.stateRoot}/publication_api/v2`;
			const spec = `${escapeRegExp(v2)}(/.*)?`;
			const stateFile = `/etc/dedalo_publication_host/${INSTANCE}/selinux.state`;
			const paths = [v2, `${v2}/shared`, `${v2}/shared/v2.env`, `${v2}/current`];
			const typesOf = async (): Promise<string[]> =>
				(await must(ctx, `stat -c '%C' ${paths.map(q).join(' ')}`, 'the v2 tree labels'))
					.trim()
					.split('\n')
					.map((line) => line.split(':')[2] ?? '');
			check(
				(await ctx.runner.sh(`test -L ${q(`${v2}/current`)}`)).code === 0,
				`${v2}/current is not a link: the leg runs after fapolicyd, which leaves r1 current`,
			);
			const since = (await must(ctx, 'sleep 1.1; date +%T', 'the leg start')).trim();
			const healthUrl = (
				await must(
					ctx,
					`sed -n 's/^V2_HEALTH_URL="\\(.*\\)"$/\\1/p' /etc/dedalo_publication_host/${INSTANCE}/agent.env`,
					'V2_HEALTH_URL',
				)
			).trim();
			check(/^http:\/\/127\.0\.0\.1:\d+\//.test(healthUrl), `V2_HEALTH_URL is '${healthUrl}'`);
			try {
				// 1. The legacy footprint: rule, history and labels as the code before 2026-10-09 left them.
				await must(ctx, `systemctl stop ${unit.v2Unit}`, 'stop v2');
				await must(
					ctx,
					`semanage fcontext -m -t data_home_t ${q(spec)} && grep -q '"${V2_TREE_TYPE}"' ${stateFile} && sed -i 's/"${V2_TREE_TYPE}"/"data_home_t"/' ${stateFile} && restorecon -R ${q(v2)}`,
					'the legacy data_home_t footprint',
				);
				const legacy = await typesOf();
				check(
					legacy.every((type) => type === 'data_home_t'),
					`the legacy footprint is not data_home_t: ${legacy.join(', ')}`,
				);
				// 2. init's re-run re-types it (one import: -d data_home_t, -a the module's type) and relabels.
				const rerun = await ctx.runner.sh(
					`${rerunSh(INSTANCE, home, '-- --yes --no-pair')} </dev/null`,
					{ timeoutMs: 600_000 },
				);
				check(
					rerun.code === 0,
					`the migration re-run exited ${rerun.code}\n${rerun.out.slice(-3000)}${rerun.err}`,
				);
				const rule = (
					await must(ctx, `semanage fcontext -l -C | grep -F -- ${q(`${spec} `)}`, 'the v2 rule')
				).trim();
				check(
					rule.includes(`:${V2_TREE_TYPE}:`) && !rule.includes('data_home_t'),
					`the v2 rule after the re-run: '${rule}'`,
				);
				const after = await typesOf();
				check(
					after.every((type) => type === V2_TREE_TYPE),
					`the v2 tree after the re-run: ${after.join(', ')}`,
				);
				const entry = (
					await must(
						ctx,
						`stat -c '%C' ${q(`${v2}/current/src/index.ts`)}`,
						'the release entry label',
					)
				).trim();
				check(entry.split(':')[2] === V2_TREE_TYPE, `the current release is ${entry}`);
				const pending = await must(
					ctx,
					`restorecon -n -v -R ${q(v2)} 2>&1`,
					'restorecon -n on the v2 tree',
				);
				check(pending.trim() === '', `restorecon would still relabel the v2 tree:\n${pending}`);
				const history = await must(ctx, `cat ${stateFile}`, 'selinux.state');
				check(
					!history.includes('data_home_t') && history.includes(`"${V2_TREE_TYPE}"`),
					`selinux.state after the re-run:\n${history}`,
				);
				// 3. Idempotent: a second re-run changes nothing.
				const before = (await journalRecords(ctx, INSTANCE)).length;
				const again = await ctx.runner.sh(
					`${rerunSh(INSTANCE, home, '-- --yes --no-pair')} </dev/null`,
					{ timeoutMs: 600_000 },
				);
				check(
					again.code === 0,
					`the second re-run exited ${again.code}\n${again.out.slice(-3000)}${again.err}`,
				);
				const changed = (await journalRecords(ctx, INSTANCE))
					.slice(before)
					.filter((p) => p.phase === 'done');
				check(
					changed.length === 0,
					`the second re-run changed ${changed.map((p) => p.item).join(', ')}`,
				);
				// 4. v2 restarts on the re-typed tree (systemd reads v2.env and the links) and answers.
				await must(
					ctx,
					`systemctl reset-failed ${unit.v2Unit}; systemctl restart ${unit.v2Unit}`,
					'restart v2',
					60_000,
				);
				await must(
					ctx,
					`for i in $(seq 1 60); do curl -fsS --max-time 5 ${q(healthUrl)} 2>/dev/null | grep -q '"release":"r1"' && exit 0; sleep 0.5; done; curl -sS --max-time 5 ${q(healthUrl)}; journalctl -u ${unit.v2Unit} -n 10 --no-pager 2>/dev/null; exit 1`,
					'v2 answers its /health on the re-typed tree',
				);
				const avc = await ctx.runner.sh(`sleep 1; ausearch -m AVC,USER_AVC -ts ${since} 2>&1`);
				const denied = avc.out.split('\n').filter((line) => /avc:/.test(line));
				check(
					denied.length === 0,
					`AVC denials during the migration:\n${denied.slice(0, 20).join('\n')}`,
				);
				ctx.facts.home_v2_migration = { from: 'data_home_t', to: V2_TREE_TYPE };
			} finally {
				// As fapolicyd leaves it: v2 stopped (booleans-measured must not reuse a pooled backend).
				await ctx.runner.sh(`systemctl stop ${unit.v2Unit}`, { timeoutMs: 60_000 });
			}
		},
	},
	{
		name: 'system-layout-v2',
		family: 'el',
		required: true,
		what: `a v2-only site in the SYSTEM layout (/srv + /opt): init lists selinux.v2_policy and the policy module ${SELINUX_MODULE} (host-wide: the first home-layout install already installed it) is ours, CIL at priority 400, extracted byte for byte equal to its stamped source; the v2 tree (v2.env included) is ${V2_TREE_TYPE}; sesearch: init_t may read it, httpd_t may not; a minimal v2 release PUSHED through the agent starts and answers /health; no AVC since the leg started; the control: one world-readable file in the web root answers 200 as httpd_sys_content_t and is DENIED to httpd (an AVC naming ${V2_TREE_TYPE}) once it carries ${V2_TREE_TYPE}; a re-run reports selinux.v2_policy right`,
		async run(ctx) {
			check(
				(await ctx.runner.sh('command -v sesearch')).code === 0,
				'sesearch is not installed on this VM (dnf install setools-console): the leg reads the loaded policy with it',
			);
			const since = (await must(ctx, 'sleep 1.1; date +%T', 'the leg start')).trim();
			await makeSite(ctx, SYSTEM_DOMAIN, 'apache');
			const draft = draftFor(SYSTEM_INSTANCE, SYSTEM_DOMAIN, { apis: undefined, layout: 'system' });
			const transcript = await guidedInstall(ctx, SYSTEM_INSTANCE, SYSTEM_DOMAIN, '', draft);
			check(
				transcript.includes('selinux.v2_policy'),
				`init did not list selinux.v2_policy for a system-layout site:\n${transcript.slice(-3000)}`,
			);
			const unit = await instanceUnits(SYSTEM_INSTANCE);
			check(
				unit.stateRoot.startsWith('/srv/') && unit.agentDir.startsWith('/opt/'),
				`${SYSTEM_INSTANCE} is not in the system layout: state ${unit.stateRoot}, agent ${unit.agentDir}`,
			);
			// 1. The module: ours, CIL at 400, the store holds exactly the stamped source.
			const listed = await must(
				ctx,
				`semodule --list-modules=full | awk '$2 == "${SELINUX_MODULE}"'`,
				'semodule --list-modules=full',
			);
			check(
				/^400 dedalo_publication_host\s+cil\s*$/.test(listed.trim()),
				`the module rows: '${listed.trim()}'`,
			);
			const source = await must(
				ctx,
				`stat -c '%U:%G %a' ${SELINUX_MODULE_SOURCE} && head -n1 ${SELINUX_MODULE_SOURCE}`,
				'the module source',
			);
			check(
				/^root:root 644\n; dedalo-provision: _host selinux_module [0-9a-f]{64}\n$/.test(source),
				`the module source is not root:root 0644 with our stamp:\n${source}`,
			);
			await must(
				ctx,
				`d=$(mktemp -d) && cd "$d" && semodule -X 400 -E ${SELINUX_MODULE} 2>/dev/null && cmp ${SELINUX_MODULE}.cil ${SELINUX_MODULE_SOURCE}; r=$?; cd / && rm -rf "$d"; exit $r`,
				'the installed module is the stamped source, byte for byte',
			);
			// 2. The v2 tree carries the module's type (the env file systemd reads included).
			const v2 = `${unit.stateRoot}/publication_api/v2`;
			const labels = await must(
				ctx,
				`stat -c '%C %n' ${q(v2)} ${q(`${v2}/shared`)} ${q(`${v2}/shared/v2.env`)}`,
				'the v2 tree labels',
			);
			for (const line of labels.trim().split('\n'))
				check(line.split(':')[2] === V2_TREE_TYPE, `not ${V2_TREE_TYPE}: ${line}`);
			const pending = await must(
				ctx,
				`restorecon -n -v -R ${q(v2)} 2>&1`,
				'restorecon -n on the v2 tree',
			);
			check(pending.trim() === '', `restorecon would still relabel the v2 tree:\n${pending}`);
			// 3. The policy: systemd may read it, httpd may not (sesearch -A answers no rule for httpd_t).
			// Why the module exists: the system layout's default type under /srv (var_t) is not readable to systemd.
			const defaultType =
				(
					await must(
						ctx,
						`matchpathcon -n ${q(`${v2}.dd_default_probe`)}`,
						'the default type under /srv',
					)
				)
					.trim()
					.split(':')[2] ?? '';
			check(
				defaultType !== '' && defaultType !== V2_TREE_TYPE,
				`the default type beside the v2 tree is '${defaultType}'`,
			);
			const defaultRead = await must(
				ctx,
				`sesearch -A -s init_t -t ${defaultType} -c file -p read`,
				`sesearch init_t ${defaultType}`,
			);
			ctx.facts.system_default_readable = defaultRead.trim() !== '';
			const initRead = await must(
				ctx,
				`sesearch -A -s init_t -t ${V2_TREE_TYPE} -c file -p read`,
				'sesearch init_t',
			);
			check(
				initRead.includes(`allow init_t ${V2_TREE_TYPE}:file`),
				`init_t may not read ${V2_TREE_TYPE}:\n${initRead}`,
			);
			for (const cls of ['file', 'lnk_file'])
				check(
					(
						await must(
							ctx,
							`sesearch -A -s httpd_t -t ${V2_TREE_TYPE} -c ${cls} -p read`,
							`sesearch httpd_t ${cls}`,
						)
					).trim() === '',
					`a rule lets httpd_t read ${V2_TREE_TYPE} ${cls}`,
				);
			// 4. A v2 release pushed through the agent starts (systemd reads v2.env and the links) and answers.
			const socket = `/run/dedalo_publication_host/${SYSTEM_INSTANCE}/agent.sock`;
			await healthOverSocket(ctx, SYSTEM_INSTANCE);
			const healthUrl = (
				await must(
					ctx,
					`sed -n 's/^V2_HEALTH_URL="\\(.*\\)"$/\\1/p' /etc/dedalo_publication_host/${SYSTEM_INSTANCE}/agent.env`,
					'V2_HEALTH_URL',
				)
			).trim();
			check(/^http:\/\/127\.0\.0\.1:\d+\//.test(healthUrl), `V2_HEALTH_URL is '${healthUrl}'`);
			const release = await miniV2Release(ctx, 'sys1');
			try {
				const posted = await agentPost(
					ctx,
					socket,
					SYSTEM_INSTANCE,
					'/publication/host_agent/v1/releases/v2',
					release,
				);
				check(
					posted.status === 200,
					`release.install ${release.id} answered ${posted.status}: ${posted.body}`,
				);
				await must(
					ctx,
					`for i in $(seq 1 60); do curl -fsS --max-time 5 ${q(healthUrl)} 2>/dev/null | grep -q '"release":"sys1"' && exit 0; sleep 0.5; done; curl -sS --max-time 5 ${q(healthUrl)}; journalctl -u ${unit.v2Unit} -n 10 --no-pager 2>/dev/null; exit 1`,
					'v2 answers its /health in the system layout',
				);
				const current = (
					await must(
						ctx,
						`stat -c '%C' ${q(`${v2}/releases/${release.id}/src/index.ts`)}`,
						'the release label',
					)
				).trim();
				check(
					current.split(':')[2] === V2_TREE_TYPE,
					`the pushed release is ${current}, not ${V2_TREE_TYPE} (it must inherit the tree's type)`,
				);
				// 5. No denial since the leg started (the control below is the one on purpose).
				const avc = await ctx.runner.sh(`sleep 1; ausearch -m AVC,USER_AVC -ts ${since} 2>&1`);
				const denied = avc.out.split('\n').filter((line) => /avc:/.test(line));
				check(
					denied.length === 0,
					`AVC denials during the system-layout install and push:\n${denied.slice(0, 20).join('\n')}`,
				);
			} finally {
				// Leave the host as the next legs expect it: no v2 of this instance answering.
				await ctx.runner.sh(`systemctl stop ${unit.v2Unit}`, { timeoutMs: 60_000 });
			}
			// 6. The control: the SAME world-readable file under its own granted Alias, served as
			//    httpd_sys_content_t, then denied once it carries the module's type — only the label changes.
			const control = `${SELINUX_CONTROL_DIR}/${SELINUX_CONTROL_FILE}`;
			const errorLog = '/var/log/httpd/error_log';
			try {
				await putRootFile(ctx, SELINUX_CONTROL_CONF, selinuxControlConf(), '0644');
				await must(
					ctx,
					`install -d -m 0755 ${SELINUX_CONTROL_DIR} && echo dd-control > ${control} && chmod 0644 ${control} && chcon -t httpd_sys_content_t ${SELINUX_CONTROL_DIR} ${control} && restorecon ${SELINUX_CONTROL_CONF} && apachectl -t 2>&1 && systemctl reload httpd`,
					'the control file and its Alias',
				);
				const fetch = async (): Promise<{ status: number; body: string }> => {
					const done = await ctx.runner.sh(
						`curl -s -o /tmp/dd_ctl -w '%{http_code}' http://127.0.0.1${SELINUX_CONTROL_URL}/${SELINUX_CONTROL_FILE}; echo; cat /tmp/dd_ctl; rm -f /tmp/dd_ctl`,
					);
					const [status = '0', ...rest] = done.out.split('\n');
					return { status: Number(status), body: rest.join('\n') };
				};
				const baseline = await fetch();
				const from = (await must(ctx, 'sleep 1.1; date +%T', 'the control start')).trim();
				const logFrom =
					Number(
						(await must(ctx, `wc -l < ${errorLog} 2>/dev/null || echo 0`, 'error_log size')).trim(),
					) || 0;
				await must(ctx, `chcon -t ${V2_TREE_TYPE} ${control}`, `label the control ${V2_TREE_TYPE}`);
				const refused = await fetch();
				const avc = await must(
					ctx,
					`sleep 1; ausearch -m AVC -ts ${from} 2>/dev/null || true`,
					'the control AVC',
				);
				const log = await must(
					ctx,
					`tail -n +${logFrom + 1} ${errorLog} 2>/dev/null || true`,
					'the httpd error log',
				);
				const verdict = selinuxControlVerdict({
					baseline,
					refused,
					avc,
					errorLog: log,
					type: V2_TREE_TYPE,
				});
				check(
					verdict === null,
					`${verdict}\n(httpd error log since the control:\n${log.slice(-1500)})`,
				);
				// no-avc's floor: the one denial the drill caused on purpose, measured.
				ctx.facts.selinux_control_denied = true;
			} finally {
				await ctx.runner.sh(
					`rm -rf ${SELINUX_CONTROL_DIR} ${SELINUX_CONTROL_CONF} && apachectl -t >/dev/null 2>&1 && systemctl reload httpd`,
				);
			}
			// 7. A re-run with nothing to change: the policy item is right.
			const rerun = await ctx.runner.sh(
				`sh ${q(`${unit.agentDir}/deploy/install.sh`)} ${SYSTEM_INSTANCE} -- --yes --no-pair </dev/null`,
				{ timeoutMs: 600_000 },
			);
			check(
				rerun.code === 0,
				`the system-layout re-run exited ${rerun.code}\n${rerun.out.slice(-3000)}${rerun.err}`,
			);
			check(
				rerun.out.includes(`the policy module ${SELINUX_MODULE} is installed and current`),
				`the re-run does not report selinux.v2_policy right:\n${rerun.out.slice(-3000)}`,
			);
			ctx.facts.system_layout_v2 = { module: `${SELINUX_MODULE} 400 cil`, v2_type: V2_TREE_TYPE };
		},
	},
	{
		name: 'systemd-analyze',
		family: 'el',
		required: true,
		what: 'systemd-analyze verify prints NO warning naming a rendered unit; every directive the rendered units carry is probed alone against this systemd, and the ones it accepts are recorded per systemd version',
		async run(ctx) {
			const units = (await must(ctx, `ls /etc/systemd/system/dedalo-*.service`, 'rendered units'))
				.trim()
				.split('\n');
			const verify = await ctx.runner.sh(`systemd-analyze verify ${units.map(q).join(' ')} 2>&1`);
			check(
				verify.code === 0,
				`systemd-analyze verify of the rendered units exited ${verify.code}:\n${verify.out}${verify.err}`,
			);
			const named = verify.out
				.split('\n')
				.filter((line) => units.some((u) => line.includes(u.split('/').at(-1) as string)));
			check(
				named.length === 0,
				`systemd-analyze verify warns about a rendered unit:\n${named.join('\n')}`,
			);
			const version = (
				await must(ctx, 'systemctl --version | head -n1', 'systemctl --version')
			).trim();
			const bodies: string[] = [];
			for (const unit of units) bodies.push(await must(ctx, `cat ${q(unit)}`, `the unit ${unit}`));
			const forms = renderedDirectiveForms(bodies);
			check(forms.length > 0, `nothing to measure: the rendered units carry no directive`);
			const scratch = `/run/systemd/system/dd-floor-probe.service`;
			const probe = async (form: DirectiveForm): Promise<string> => {
				await putRootFile(ctx, scratch, directiveProbeUnit(form), '0644');
				return (await ctx.runner.sh(directiveProbeScript(scratch))).out;
			};
			// The probe is proven BEFORE it measures: it must call a bogus directive refused and
			// the bare scaffold clean — else "accepted" would only mean "the probe did not run".
			const bogus = await probe(BOGUS_DIRECTIVE);
			check(
				directiveProbeVerdict(bogus) === 'refused',
				`the directive probe did not refuse a directive no systemd knows (${BOGUS_DIRECTIVE.line}):\n${bogus}`,
			);
			const bare = await probe(SCAFFOLD_DIRECTIVE);
			check(
				directiveProbeVerdict(bare) === 'accepted' && directiveProbeOutput(bare) === '',
				`the directive probe's bare scaffold does not verify clean (status 0, no output):\n${bare}`,
			);
			const supported: string[] = [];
			const unrun: string[] = [];
			for (const form of forms) {
				const out = await probe(form);
				const verdict = directiveProbeVerdict(out);
				if (verdict === 'accepted') supported.push(`[${form.section}] ${form.key}=`);
				else if (verdict === 'unrun') unrun.push(`[${form.section}] ${form.key}=: ${out.trim()}`);
			}
			check(unrun.length === 0, `the directive probe did not run for:\n${unrun.join('\n')}`);
			// The rendered units verified clean, so every directive they carry must probe as accepted:
			// a refused one means the probe, not the unit, is wrong — never a silent short list.
			check(
				supported.length === forms.length,
				`the probe refused directives the rendered units verified with: ${forms
					.map((f) => `[${f.section}] ${f.key}=`)
					.filter((f) => !supported.includes(f))
					.join(', ')}`,
			);
			ctx.facts.supported_directives = { [version]: supported };
		},
	},
	{
		name: 'booleans-measured',
		family: 'el',
		required: true,
		what: "the booleans the default install rests on, measured ON then OFF, each probe's AVCs counted from its own start: httpd_can_network_relay (the v2 proxy: off → an AVC, on → none) and httpd_enable_homedirs (the v1 probe under the home through the H rule: on → 200 without an AVC, off → still 200); restored after",
		async run(ctx) {
			const measured: Record<string, { needed_for: string; denied_without: boolean }> = {};
			// The span no-avc excuses this leg's relay denial in: the target's clock, epoch seconds.
			const start = (await must(ctx, 'date +%s', 'the booleans window start')).trim();
			check(
				/^\d+$/.test(start),
				`the booleans window start: the target's clock answered '${start}'`,
			);
			const from = Number(start);
			/** One probe: its status and the AVC denials logged from its own start (whole seconds: a pause first). */
			const probeOnce = async (path: string): Promise<BooleanProbe> => {
				const since = (await must(ctx, 'sleep 1.1; date +%T', 'the probe start')).trim();
				const got = await webCheck(ctx, DOMAIN, path);
				const avc = await ctx.runner.sh(
					`sleep 1; ausearch -m AVC -ts ${since} 2>/dev/null || true`,
				);
				return { status: got.status, ...countProbeDenials(avc.out) };
			};
			// The v1 probe is v1-handler-probe's (a .php under the home's v1 release).
			try {
				for (const [name, needed, probe] of [
					['httpd_can_network_relay', 'the v2 proxy', '/dedalo/publication/server_api/v2/'],
					[
						'httpd_enable_homedirs',
						'home traversal (the H rule replaces it)',
						'/dedalo/publication/server_api/v1/probe.php',
					],
				] as const) {
					const before = (await must(ctx, `getsebool ${name}`, 'getsebool')).trim().endsWith('on');
					try {
						await must(ctx, `setsebool ${name} on`, `${name} on`);
						const on = await probeOnce(probe);
						await must(ctx, `setsebool ${name} off`, `${name} off`);
						const off = await probeOnce(probe);
						const verdict = booleanProbeVerdict(name, probe, on, off);
						check(verdict === null, verdict ?? '');
						measured[name] = {
							needed_for: needed,
							denied_without:
								(name === 'httpd_can_network_relay' ? off.relay : off.avcs) > 0 ||
								off.status !== on.status,
						};
					} finally {
						await ctx.runner.sh(`setsebool ${name} ${before ? 'on' : 'off'}`);
					}
				}
			} finally {
				// Recorded even when the leg fails (its denials happened inside this span either way), and
				// never thrown from here (the leg's own failure stays the one reported). No readable end =
				// no span: no-avc then excuses no name_connect at all.
				const end = (await ctx.runner.sh('date +%s')).out.trim();
				if (/^\d+$/.test(end)) {
					ctx.facts.booleans_window = { from, to: Number(end) } satisfies BooleansWindow;
				}
			}
			ctx.facts.booleans = measured;
		},
	},
	{
		name: 'no-avc',
		family: 'el',
		required: true,
		what: "ausearch -m AVC,USER_AVC since the drill started (the target's clock) finds nothing but system-layout-v2's control file and the booleans leg's relay denial (the httpd worker's name_connect on a tcp_socket in httpd_t) INSIDE that leg's span (its audit time) — and finds that control's denial: a window that holds not even it read nothing",
		async run(ctx) {
			const out = await ctx.runner.sh(`ausearch -m AVC,USER_AVC -ts ${ctx.auditStartedAt} 2>&1`);
			const verdict = noAvcVerdict(
				out.out,
				ctx.facts.selinux_control_denied === true,
				(ctx.facts.booleans_window as BooleansWindow | undefined) ?? null,
			);
			check(verdict === null, verdict ?? '');
		},
	},
	// ── Debian, in place only ──
	{
		name: 'no-apparmor-denial',
		family: 'debian',
		required: true,
		inPlaceOnly: true,
		what: 'AppArmor enabled on the VM\'s kernel; the journal since the drill started (floored on our units) — and, with auditd running, the audit log (floored on its own SERVICE_START/STOP of our units, a failed read is red) — holds no apparmor="DENIED" line; which of the processes the layout runs (web servers, FPM, polkitd, the agents, v2) are confined is measured',
		async run(ctx) {
			check(
				(await ctx.runner.sh('cat /sys/module/apparmor/parameters/enabled')).out.trim() === 'Y',
				'AppArmor is not enabled on this kernel: the leg would prove nothing',
			);
			// The kernel's (mediation of files, sockets, capabilities) and dbus's (USER_AVC) denials both
			// reach the journal; with auditd RUNNING the kernel's go to its log instead — so each half is
			// read on its own and floored on its own (a silenced audit read once rode the journal's floor).
			const journal = await must(
				ctx,
				`journalctl --no-pager -o short-iso --since ${q(ctx.startedAt)} 2>&1`,
				'the journal since the start',
			);
			// Not vacuous: the drill's own reloads and restarts are in that window.
			check(
				/dedalo-publication-host-/.test(journal),
				`the journal since ${ctx.startedAt} names no unit of ours: the window read nothing`,
			);
			let log = journal;
			const auditd =
				(await ctx.runner.sh('systemctl is-active auditd 2>/dev/null')).out.trim() === 'active';
			if (auditd) {
				const floor = await ctx.runner.sh(
					`ausearch -m SERVICE_START,SERVICE_STOP -ts ${ctx.auditStartedAt} 2>&1`,
				);
				const denials = await ctx.runner.sh(
					`ausearch -m AVC,USER_AVC -ts ${ctx.auditStartedAt} 2>&1`,
				);
				const verdict = auditHalfVerdict(floor, denials);
				check(verdict === null, verdict ?? '');
				log += `\n${denials.out}`;
			}
			ctx.facts.apparmor_denials_read = auditd ? 'journal+auditd' : 'journal';
			const denied = log.split('\n').filter((line) => /apparmor="DENIED"/.test(line));
			check(
				denied.length === 0,
				`AppArmor denials during the drill:\n${denied.slice(0, 20).join('\n')}`,
			);
			const confined = await must(
				ctx,
				"ps -eo label=,comm= | awk '$1 != \"unconfined\" {print}' | grep -E 'apache2|nginx|php-fpm|polkitd|bun|sudo' || true",
				'the confined processes',
			);
			ctx.facts.apparmor_confined = confined.trim().split('\n').filter(Boolean);
			console.log(
				`${TAG}      apparmor: ${(ctx.facts.apparmor_confined as string[]).length === 0 ? "none of the layout's processes is confined" : (ctx.facts.apparmor_confined as string[]).join('; ')}`,
			);
		},
	},
]);

/** The S9 rules of an instance's final declaration, from the agent package in a CHILD. */
async function s9Rules(
	instance: string,
): Promise<{ spec: string; type: string; path: string; recursive: boolean }[]> {
	const probe = [
		`const { parseDeclaration } = await import(${JSON.stringify(join(AGENT_DIR, 'src/provision/schema.ts'))});`,
		`const { selinuxRules } = await import(${JSON.stringify(join(AGENT_DIR, 'src/provision/selinux.ts'))});`,
		`const path = '/etc/dedalo_publication_host/${instance}.json';`,
		// parseDeclaration returns { declaration, layout } (the layout derived from it).
		'const { layout } = parseDeclaration(JSON.parse(await Bun.file(path).text()), path);',
		'console.log(JSON.stringify(selinuxRules(layout)));',
	].join('\n');
	const done = await spawnText([process.execPath, '-e', probe], { cwd: AGENT_DIR });
	if (done.code !== 0) throw new LegFailure(`computing the S9 rules: ${done.err}`);
	return JSON.parse(done.out) as { spec: string; type: string; path: string; recursive: boolean }[];
}

/** One instance's agent unit, Bun and agent tree, from its declaration through the agent package in a CHILD. */
async function instanceUnits(
	instance: string,
): Promise<{ agent: string; bunBin: string; agentDir: string; v2Unit: string; stateRoot: string }> {
	const probe = [
		`const { parseDeclaration } = await import(${JSON.stringify(join(AGENT_DIR, 'src/provision/schema.ts'))});`,
		`const path = '/etc/dedalo_publication_host/${instance}.json';`,
		'const { layout } = parseDeclaration(JSON.parse(await Bun.file(path).text()), path);',
		'console.log(JSON.stringify({ agent: layout.agentUnitName, bunBin: layout.bunBin, agentDir: layout.agentDir, v2Unit: layout.v2.unit, stateRoot: layout.state.root }));',
	].join('\n');
	const done = await spawnText([process.execPath, '-e', probe], { cwd: AGENT_DIR });
	if (done.code !== 0) throw new LegFailure(`reading ${instance}'s declaration: ${done.err}`);
	return JSON.parse(done.out) as {
		agent: string;
		bunBin: string;
		agentDir: string;
		v2Unit: string;
		stateRoot: string;
	};
}

/** One minimal Publication API v2 release the agent accepts (a bundle written in a file on the target). */
interface MiniRelease {
	readonly id: string;
	readonly sha256: string;
	readonly file: string;
}

/**
 * A v2 release the agent ACCEPTS, minimal: `node_modules/` (the agent's D6 check), a package.json
 * and `src/index.ts` — a Bun server on v2's own HOST/PORT whose `/health` answers 200 with the
 * `marker` (also in a DRILL_RELEASE file, so two releases differ in more than their entry); the
 * entry is a %languages type for fapolicyd (text/x-java). Written by THE engine bundle writer in a CHILD (the drill imports
 * no engine module), into the scratch directory the target sees; its id is `<version>_<digest7>` (D9).
 */
async function miniV2Release(ctx: Ctx, marker: string): Promise<MiniRelease> {
	const file = join(ctx.scratch, `mini_v2_${marker}.tar.gz`);
	// An `import` and an exported class: libmagic types it text/x-java, one of fapolicyd's %languages
	// (measured: a one-line script is text/plain, which fapolicyd never gates — the leg would prove
	// nothing). `pad` is the byte the tamper step changes and restores in place.
	const server = [
		"import { serve } from 'bun';",
		'',
		'export class Release {',
		`\tstatic readonly marker = '${marker}';`,
		"\tstatic readonly pad = 'aaaaaaaa';",
		'}',
		'',
		'serve({',
		"\thostname: process.env.HOST ?? '127.0.0.1',",
		'\tport: Number(process.env.PORT),',
		"\tfetch: (req) => (new URL(req.url).pathname.endsWith('/health') ? Response.json({ status: 'ok', release: Release.marker, pad: Release.pad }) : new Response('not found', { status: 404 })),",
		'});',
		'',
	].join('\n');
	const entries = [
		{ path: 'DRILL_RELEASE', type: 'file', mode: 0o644, text: `${marker}\n` },
		{ path: 'node_modules', type: 'dir', mode: 0o755 },
		{
			path: 'package.json',
			type: 'file',
			mode: 0o644,
			text: '{"name":"dedalo-publication-api-v2","version":"2.1.0","type":"module"}\n',
		},
		{ path: 'src', type: 'dir', mode: 0o755 },
		{ path: 'src/index.ts', type: 'file', mode: 0o644, text: server },
	];
	const probe = [
		`const { compareBundlePaths, writeBundle } = await import(${JSON.stringify(join(REPO_ROOT, 'src/core/publication_host/bundle_writer.ts'))});`,
		`const raw = ${JSON.stringify(entries)};`,
		'const entries = raw.map((e) => (e.type === "file" ? { path: e.path, type: e.type, mode: e.mode, data: new TextEncoder().encode(e.text) } : { path: e.path, type: e.type, mode: e.mode })).sort((a, b) => compareBundlePaths(a.path, b.path));',
		'const out = await writeBundle((async function* () { yield* entries; })());',
		'const bytes = new Uint8Array(await new Response(out.stream).arrayBuffer());',
		`await Bun.write(${JSON.stringify(file)}, bytes);`,
		"console.log(new Bun.CryptoHasher('sha256').update(bytes).digest('hex'));",
	].join('\n');
	const done = await spawnText([process.execPath, '-e', probe], { cwd: REPO_ROOT });
	if (done.code !== 0) throw new LegFailure(`writing the minimal v2 release: ${done.err}`);
	const sha256 = done.out.trim();
	check(/^[0-9a-f]{64}$/.test(sha256), `the bundle writer printed '${sha256}'`);
	return { id: `2.1.0_${sha256.slice(0, 7)}`, sha256, file };
}

/** POST to the agent over its unix socket as the engine would (bearer from the root-only credential). */
async function agentPost(
	ctx: Ctx,
	socket: string,
	instance: string,
	path: string,
	release: MiniRelease | null,
): Promise<{ status: number; body: string }> {
	const token = `/etc/dedalo_publication_host/${instance}/credentials/SERVICE_TOKEN`;
	const headers = [
		'-H "Authorization: Bearer $(cat ' + token + ')"',
		"-H 'X-Dedalo-Actor: init_drill'",
		...(release === null
			? []
			: [
					"-H 'Content-Type: application/gzip'",
					`-H 'X-Release-Id: ${release.id}'`,
					`-H 'X-Bundle-Sha256: ${release.sha256}'`,
					`--data-binary @${q(release.file)}`,
				]),
	].join(' ');
	const done = await ctx.runner.sh(
		`curl -sS --max-time 240 -o /root/dd_agent_answer -w '%{http_code}' --unix-socket ${q(socket)} -X POST ${headers} http://localhost${path}; echo; cat /root/dd_agent_answer; rm -f /root/dd_agent_answer`,
		{ timeoutMs: 300_000 },
	);
	const [status = '0', ...rest] = done.out.split('\n');
	return { status: Number(status.trim()), body: rest.join('\n').trim() };
}

/** buildNginxMap() and its hash, from the ENGINE in a child (the drill imports no engine module). */
async function engineMap(): Promise<{ text: string; hash: string }> {
	const probe = `const m = await import(${JSON.stringify(join(REPO_ROOT, 'src/core/media/protection.ts'))}); console.log(JSON.stringify({ text: m.buildNginxMap(), hash: m.nginxMapConfigHash() }));`;
	const done = await spawnText([process.execPath, '-e', probe], {
		env: { ...(process.env as Record<string, string>) },
	});
	if (done.code !== 0) throw new LegFailure(`the engine's buildNginxMap(): ${done.err}`);
	return JSON.parse(done.out.trim().split('\n').at(-1) ?? '{}') as { text: string; hash: string };
}

/** The mock engine's push: POST /v1/rules/map over the agent's socket with its bearer (read as root). */
async function pushMap(
	ctx: Ctx,
	instance: string,
	map: { text: string; hash: string },
): Promise<{ status: number; body: string }> {
	const body = JSON.stringify({ text: map.text, hash: map.hash, actor: 'init_drill' });
	const done = await ctx.runner.sh(
		`curl -s -o /tmp/dd_map -w '%{http_code}' --unix-socket /run/dedalo_publication_host/${instance}/agent.sock ` +
			`-H "Authorization: Bearer $(cat /etc/dedalo_publication_host/${instance}/credentials/SERVICE_TOKEN)" ` +
			`-H 'Content-Type: application/json' -H 'X-Dedalo-Actor: init_drill' --data-binary @- http://localhost/publication/host_agent/v1/rules/map; echo; cat /tmp/dd_map`,
		{ stdin: body },
	);
	const [status = '0', ...rest] = done.out.split('\n');
	return { status: Number(status), body: rest.join('\n') };
}

/* ── --capture: the raw discovery outputs (the typed EL fixtures' replacements) ──────── */

/** The constants discovery runs its commands with, from the agent package in a CHILD (exec_contract.ts). */
async function discoveryConstants(): Promise<{
	units: string[];
	props: string[];
	booleans: string[];
}> {
	const probe = `const m = await import(${JSON.stringify(join(AGENT_DIR, 'src/provision/exec_contract.ts'))}); console.log(JSON.stringify({ units: m.CANDIDATE_UNIT_PATTERNS, props: m.UNIT_SHOW_PROPERTIES, booleans: m.SELINUX_BOOLEANS }));`;
	const done = await spawnText([process.execPath, '-e', probe], { cwd: AGENT_DIR });
	if (done.code !== 0) throw new Error(`exec_contract.ts constants: ${done.err}`);
	return JSON.parse(done.out) as { units: string[]; props: string[]; booleans: string[] };
}

/** The host a capture reads: an EL major (its unit-list file is named after it), or a Debian family host and its PHP. */
export type CaptureHost =
	| { readonly family: 'el'; readonly major: string }
	| { readonly family: 'debian'; readonly php: string | null };

/**
 * One captured file per discovery read, named after the typed fixture it replaces (typed/<topic>/…)
 * or the captured case's file name (captured/<case>/…): the argv init's exec door runs
 * (publication/host_agent/src/exec.ts initExec/provisionExec), the files it reads. A non-zero exit and any stderr are kept
 * beside the command's stdout (`<file>.exit`, `<file>.stderr`).
 */
export function captureCommands(
	c: {
		readonly units: readonly string[];
		readonly props: readonly string[];
		readonly booleans: readonly string[];
	},
	host: CaptureHost,
): readonly (readonly [string, string])[] {
	const show = (unit: string) =>
		`systemctl show ${unit}.service ${c.props.map((p) => `-p ${p}`).join(' ')}`;
	const home = `/home/${DOMAIN}`;
	const common: (readonly [string, string])[] = [
		['os-release', 'cat /etc/os-release'],
		['kernel_osrelease', 'cat /proc/sys/kernel/osrelease'],
		['cpuinfo.txt', 'cat /proc/cpuinfo'],
		['mountinfo.txt', 'cat /proc/self/mountinfo'],
		['proc_net_tcp.txt', 'cat /proc/net/tcp'],
		['proc_net_tcp6.txt', 'cat /proc/net/tcp6'],
		['attr_current', 'cat /proc/self/attr/current'],
		['systemctl_version.txt', 'systemctl --version'],
		[
			`list_units_${host.family === 'el' ? `el${host.major}` : 'debian'}.txt`,
			`systemctl list-units --all --plain --no-legend --no-pager ${c.units.join(' ')}`,
		],
		['show_dedalo_ts.txt', show('dedalo-ts')],
		['show_nginx.txt', show('nginx')],
		['pkaction_version.txt', 'pkaction --version'],
		['nginx_T.txt', 'nginx -T'],
		['nginx_v.txt', 'nginx -v'],
		['php_version.txt', "php -n -r 'echo PHP_VERSION;'"],
		['getent_passwd.txt', 'getent passwd'],
		['getent_group.txt', 'getent group'],
		['nsswitch.conf', 'cat /etc/nsswitch.conf'],
		['shells', 'cat /etc/shells'],
		['sudoers', 'cat /etc/sudoers'],
		[
			'polkit_rules_d.txt',
			"stat -c '%U:%G %a %n' /etc/polkit-1 /etc/polkit-1/rules.d /usr/share/polkit-1/rules.d",
		],
	];
	if (host.family === 'debian') {
		const php = host.php ?? 'none';
		return [
			...common,
			['show_web_default.txt', show('apache2')],
			['show_fpm.txt', show(`php${php}-fpm`)],
			['show_polkit.txt', show('polkit')],
			['apache_S.txt', 'apache2ctl -S'],
			['apache_M.txt', 'apache2ctl -M'],
			['apache_includes.txt', 'apache2ctl -t -D DUMP_INCLUDES'],
			['apache_v.txt', 'apache2ctl -v'],
			['apache_php_fpm.conf', `cat /etc/apache2/conf-available/php${php}-fpm.conf`],
			['fpm_tt.txt', `/usr/sbin/php-fpm${php} -tt`],
			['ls_etc_php.txt', 'ls -1 /etc/php'],
			['ls_pool_d.txt', `ls -1 /etc/php/${php}/fpm/pool.d`],
			// AppArmor (no typed fixture yet: what this host confines, its userns restriction).
			['apparmor_enabled', 'cat /sys/module/apparmor/parameters/enabled'],
			['aa_status.txt', 'aa-status'],
			['apparmor_restrict_userns', 'cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns'],
			['ps_labels.txt', 'ps -eo label=,user=,comm='],
		];
	}
	return [
		...common,
		['getenforce.txt', 'getenforce'],
		['selinux_config', 'cat /etc/selinux/config'],
		['getsebool.txt', c.booleans.map((b) => `getsebool ${b}`).join('; ')],
		['semanage_fcontext_l_C.txt', 'semanage fcontext -l -C -n'],
		['semanage_port_l_C.txt', 'semanage port -l -C -n'],
		['semanage_port_l.txt', 'semanage port -l -n'],
		[
			'stat_labels.txt',
			`stat -c '%C %n' -- /home ${home} ${home}/dedalo ${home}/dedalo/publication_api ${home}/dedalo/publication_api/v1 ${home}/host_agent ${home}/.bun/bin/bun /var/log/httpd/${DOMAIN} /run/php-fpm /mnt/dd_media`,
		],
		['restorecon_n.txt', `restorecon -R -n -v -- ${home}/dedalo; restorecon -n -v -- ${home}`],
		['show_web_default.txt', show('httpd')],
		['show_fpm.txt', show('php-fpm')],
		['show_polkit.txt', show('polkit')],
		['show_fapolicyd.txt', show('fapolicyd')],
		['apache_S.txt', '/usr/sbin/httpd -S'],
		['apache_M.txt', '/usr/sbin/httpd -M'],
		['apache_includes.txt', '/usr/sbin/httpd -t -D DUMP_INCLUDES'],
		['apache_v.txt', '/usr/sbin/httpd -v'],
		['php.conf', 'cat /etc/httpd/conf.d/php.conf'],
		['fpm_tt.txt', '/usr/sbin/php-fpm -tt'],
		['ls_php_fpm_d.txt', 'ls -1 /etc/php-fpm.d'],
		[
			'selinux_tools.txt',
			'ls -l /usr/sbin/semanage /usr/sbin/restorecon /usr/sbin/getsebool /usr/sbin/setfiles',
		],
	];
}

async function captureDiscovery(ctx: Ctx, dir: string): Promise<number> {
	const release = (await ctx.runner.sh('. /etc/os-release; echo "$ID $VERSION_ID"')).out.trim();
	const host: CaptureHost =
		ctx.args.family === 'el'
			? { family: 'el', major: release.split(' ')[1]?.split('.')[0] ?? '' }
			: {
					family: 'debian',
					php: (await ctx.runner.sh('ls -1 /etc/php | sort -V | tail -n1')).out.trim() || null,
				};
	const commands = captureCommands(await discoveryConstants(), host);
	for (const [file, command] of commands) {
		const done = await ctx.runner.sh(command, { timeoutMs: 120_000 });
		writeFileSync(join(dir, file), done.out);
		if (done.code !== 0) writeFileSync(join(dir, `${file}.exit`), `${done.code}\n`);
		if (done.err.trim() !== '') writeFileSync(join(dir, `${file}.stderr`), done.err);
	}
	const caseJson =
		ctx.args.family === 'el'
			? {
					typed: false,
					captured: `the EL init drill on ${release} (SELinux enforcing), ${new Date().toISOString()}, after the legs: a real VM (systemd PID 1, an SELinux kernel) with the drill's instances installed`,
					limits:
						"one VM and the drill's own sites; the NFS media mount is the network-media leg's",
				}
			: {
					typed: false,
					captured: `the in-place Debian init drill on ${release} (AppArmor enabled), ${new Date().toISOString()}, after the legs: a real VM (systemd PID 1, an AppArmor kernel) with the drill's instances installed`,
					limits:
						"one VM and the drill's own sites; captured after the nginx legs: nginx serving, apache2 stopped and disabled (still listed loaded)",
				};
	writeFileSync(join(dir, 'case.json'), `${JSON.stringify(caseJson, null, 2)}\n`);
	return commands.length;
}

/* ── the two worlds ────────────────────────────────────────────────────────────────── */

/** The CI image's base (ci/Dockerfile FROM), so the drill's Debian is the CI image's Debian. */
export function ciBaseImage(): string {
	const from = readFileSync(join(REPO_ROOT, 'ci/Dockerfile'), 'utf8').match(
		/^FROM (debian:trixie-slim@sha256:[0-9a-f]{64})$/m,
	)?.[1];
	if (from === undefined)
		throw new Error('ci/Dockerfile: no digest-pinned debian:trixie-slim FROM line');
	return from;
}

export function drillDockerfile(): string {
	return [
		`FROM ${ciBaseImage()}`,
		'ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8',
		'RUN set -eux; apt-get update; apt-get install -y --no-install-recommends \\',
		'      systemd systemd-sysv dbus polkitd sudo apache2 nginx php-fpm php-cli \\',
		'      curl unzip e2fsprogs logrotate ca-certificates openssl procps util-linux passwd coreutils findutils; \\',
		'    systemctl disable nginx; systemctl mask getty@tty1.service; \\',
		'    rm -rf /var/lib/apt/lists/*',
		'STOPSIGNAL SIGRTMIN+3',
		'CMD ["/sbin/init"]',
		'',
	].join('\n');
}

async function debianWorld(
	args: DrillArgs,
	scratch: string,
): Promise<{ runner: Runner; source: string; mirror: string; stop: () => Promise<void> }> {
	const docker = await spawnText(['docker', 'version', '--format', '{{.Server.Version}}']);
	if (docker.code !== 0)
		throw new CannotRun(
			`no Docker daemon (${docker.err.trim()}): the Debian drill needs one that may start --privileged containers`,
		);
	const dockerfileDir = join(scratch, 'image');
	mkdirSync(dockerfileDir, { recursive: true });
	writeFileSync(join(dockerfileDir, 'Dockerfile'), drillDockerfile());
	const tag = `dedalo-init-drill:${createHash('sha256').update(drillDockerfile()).digest('hex').slice(0, 12)}`;
	const built = await spawnText(['docker', 'build', '-q', '-t', tag, dockerfileDir], {
		timeoutMs: 1_800_000,
	});
	if (built.code !== 0) throw new Error(`docker build: ${built.err}`);
	const name = `dd-init-drill-${randomBytes(4).toString('hex')}`;
	const started = await spawnText([
		'docker',
		'run',
		'-d',
		'--privileged',
		'--cgroupns=host',
		'-v',
		'/sys/fs/cgroup:/sys/fs/cgroup:rw',
		'--tmpfs',
		'/run',
		'--tmpfs',
		'/run/lock',
		'--name',
		name,
		'--hostname',
		'pubhost',
		tag,
	]);
	if (started.code !== 0)
		throw new CannotRun(`docker run --privileged refused: ${started.err.trim()}`);
	const runner = dockerRunner(name);
	const stop = async () => {
		if (!args.keep) await spawnText(['docker', 'rm', '-f', name]);
		else console.log(`${TAG} kept container ${name}`);
	};
	await runner.sh(
		'for i in $(seq 1 120); do s=$(systemctl is-system-running 2>/dev/null); [ "$s" = running ] || [ "$s" = degraded ] && exit 0; sleep 0.5; done; exit 1',
	);
	// On a real host systemd (PID 1) makes / a SHARED mount at boot; Docker hands the container a
	// private one. systemd 257 (Debian 13) builds a unit's LoadCredential= directory in a helper's
	// own mount namespace and MOVES it into /run/credentials/<unit>: under a private / the move never
	// reaches the service, so the agent finds no SERVICE_TOKEN (measured: an empty
	// /run/credentials/<unit>; systemd 259, Ubuntu 26.04, mounts it differently and is unaffected).
	// The host the drill models has / shared.
	const shared = await runner.sh('mount --make-rshared /');
	if (shared.code !== 0) throw new Error(`mount --make-rshared /: ${shared.err}`);
	// The source, as a non-root work user owns it (the warning's case: init must still run it as root only after consent).
	const local = await stageSource(scratch);
	await runner.sh(
		'useradd --create-home --shell /bin/sh dedalo || true; install -d -o dedalo -m 0755 /opt/dedalo',
	);
	const tar = await spawnText(['tar', '-C', local, '-cf', join(scratch, 'source.tar'), '.'], {
		env: TAR_ENV,
	});
	if (tar.code !== 0) throw new Error(`tar the source: ${tar.err}`);
	const copied = await spawnText([
		'sh',
		'-c',
		`docker exec -i ${name} sh -c 'install -d -o dedalo /opt/dedalo/master_dedalo && tar -C /opt/dedalo/master_dedalo -xf - && chown -R dedalo /opt/dedalo/master_dedalo' < ${q(join(scratch, 'source.tar'))}`,
	]);
	if (copied.code !== 0) throw new Error(`copy the source in: ${copied.err}`);
	await startWorkUnit(runner);
	const mirror = await startMirror(runner, scratch);
	return { runner, source: '/opt/dedalo/master_dedalo', mirror, stop };
}

/**
 * THE WORK ENGINE OF THE ONE-MACHINE HOST. A unix listener pairs with a Dédalo work engine on the
 * same machine, and init takes `engine_group` from its unit (the socket is 0660 with that group);
 * it never invents one. A host without a `dedalo-ts` unit and a draft without `engine_group` is
 * therefore BLOCKED by design (`declaration.fields` + `declaration.work_unit`) — the drill models
 * the one-machine host, so it runs a stand-in engine unit as the work user `dedalo` that owns the
 * source checkout: init discovers it exactly as it discovers a real one (systemctl list-units/show).
 * The legs pass `--no-pair`, so nothing is ever sent to it.
 */
export const WORK_UNIT_FILE = [
	'[Unit]',
	'Description=Dédalo work engine (init drill stand-in: discovery only, never paired)',
	'',
	'[Service]',
	'User=dedalo',
	'Group=dedalo',
	'WorkingDirectory=/opt/dedalo/master_dedalo',
	'ExecStart=/bin/sleep infinity',
	'',
	'[Install]',
	'WantedBy=multi-user.target',
	'',
].join('\n');

async function startWorkUnit(runner: Runner): Promise<void> {
	const done = await runner.sh(
		'cat > /etc/systemd/system/dedalo-ts.service && systemctl daemon-reload && systemctl enable --now dedalo-ts.service',
		{ stdin: WORK_UNIT_FILE },
	);
	if (done.code !== 0) throw new Error(`the stand-in work engine unit: ${done.err}${done.out}`);
}

/** The mirror's command line as a `pkill -f` pattern ([o]: never the `sh -c` that runs the pkill). */
const MIRROR_PROCESS = '[o]penssl s_server -quiet -accept 8443';

/** A local https mirror (openssl s_server -WWW) serving the verified Bun archive; its CA trusted by the target. */
async function startMirror(runner: Runner, scratch: string): Promise<string> {
	const arch = (await runner.sh('uname -m')).out.trim();
	const avx2 = (await runner.sh('grep -qw avx2 /proc/cpuinfo')).code === 0;
	const files = join(scratch, 'mirror');
	await fetchVerifiedBun(assetFor(arch, avx2), files);
	const tar = await spawnText(['tar', '-C', files, '-cf', join(scratch, 'mirror.tar'), '.'], {
		env: TAR_ENV,
	});
	if (tar.code !== 0) throw new Error(`tar the mirror: ${tar.err}`);
	const where = runner.where.startsWith('container ')
		? runner.where.slice('container '.length)
		: null;
	const load =
		where === null
			? await spawnText([
					'sh',
					'-c',
					`install -d /var/tmp/dd_mirror && tar -C /var/tmp/dd_mirror -xf ${q(join(scratch, 'mirror.tar'))}`,
				])
			: await spawnText([
					'sh',
					'-c',
					`docker exec -i ${where} sh -c 'install -d /var/tmp/dd_mirror && tar -C /var/tmp/dd_mirror -xf -' < ${q(join(scratch, 'mirror.tar'))}`,
				]);
	if (load.code !== 0) throw new Error(`load the mirror: ${load.err}`);
	const trust =
		(await runner.sh('test -d /etc/pki/ca-trust/source/anchors')).code === 0
			? 'cp /var/tmp/dd_mirror_ca.pem /etc/pki/ca-trust/source/anchors/dd_mirror.pem && update-ca-trust'
			: 'cp /var/tmp/dd_mirror_ca.pem /usr/local/share/ca-certificates/dd_mirror.crt && update-ca-certificates >/dev/null';
	// A mirror an earlier in-place run left would answer with the OLD certificate: stop it first — in a
	// shell of its own (the script below names the s_server command line, pkill -f would match it).
	await runner.sh(`pkill -f ${q(MIRROR_PROCESS)} || true`);
	const started = await runner.sh(
		[
			'cd /var/tmp',
			"grep -q 'mirror.drill' /etc/hosts || echo '127.0.0.1 mirror.drill' >> /etc/hosts",
			'openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=dd-mirror-ca -keyout dd_mirror_ca.key -out dd_mirror_ca.pem 2>/dev/null',
			'openssl req -newkey rsa:2048 -nodes -subj /CN=mirror.drill -keyout dd_mirror.key -out dd_mirror.csr 2>/dev/null',
			"printf 'subjectAltName=DNS:mirror.drill\\n' > dd_mirror.ext",
			'openssl x509 -req -in dd_mirror.csr -CA dd_mirror_ca.pem -CAkey dd_mirror_ca.key -CAcreateserial -days 2 -extfile dd_mirror.ext -out dd_mirror.pem 2>/dev/null',
			trust,
			'cd /var/tmp/dd_mirror && (setsid openssl s_server -quiet -accept 8443 -cert ../dd_mirror.pem -key ../dd_mirror.key -WWW </dev/null >/dev/null 2>&1 &)',
			'for i in $(seq 1 50); do curl -fsS -o /dev/null https://mirror.drill:8443/bun-v$(ls /var/tmp/dd_mirror | sed -n "s/^bun-v//p" | head -n1)/SHASUMS256.txt && exit 0; sleep 0.2; done; exit 1',
		].join(' && '),
	);
	if (started.code !== 0)
		throw new Error(`the https mirror did not answer: ${started.err}${started.out}`);
	return 'https://mirror.drill:8443';
}

class CannotRun extends Error {}

/**
 * THE IN-PLACE WORLD — the drill runs AS ROOT ON a disposable VM (EL: always; Debian: `--in-place`,
 * a real Debian/Ubuntu VM instead of the container — the only Debian run with a real kernel's
 * AppArmor, systemd PID 1 at boot and a real `/`). Refuses unless DRILL_HOST_MARKER exists (created
 * by hand on the VM, so the drill can never run on a real install) and `hostCheck` accepts the host.
 */
async function inPlaceWorld(
	args: DrillArgs,
	scratch: string,
	hostCheck: (runner: Runner, release: string) => Promise<void>,
): Promise<{ runner: Runner; source: string; mirror: string; stop: () => Promise<void> }> {
	const family = args.family === 'el' ? 'EL' : 'Debian';
	if (process.platform !== 'linux')
		throw new CannotRun(`the in-place ${family} drill runs ON the VM`);
	if (process.getuid?.() !== 0)
		throw new CannotRun(`run the in-place ${family} drill as root on the drill VM`);
	if (!existsSync(DRILL_HOST_MARKER))
		throw new CannotRun(
			`${DRILL_HOST_MARKER} does not exist: this is not a drill VM (create it by hand on a disposable VM only)`,
		);
	const runner = localRunner();
	await hostCheck(runner, readFileSync('/etc/os-release', 'utf8'));
	const local = await stageSource(scratch);
	await runner.sh(
		'useradd --create-home --shell /bin/sh dedalo 2>/dev/null; install -d -o dedalo -m 0755 /opt/dedalo',
	);
	const copied = await runner.sh(
		`rm -rf /opt/dedalo/master_dedalo && cp -a ${q(local)} /opt/dedalo/master_dedalo && chown -R dedalo /opt/dedalo/master_dedalo`,
	);
	if (copied.code !== 0) throw new Error(`stage the source: ${copied.err}`);
	if (args.capture !== null) mkdirSync(args.capture, { recursive: true });
	await startWorkUnit(runner);
	const mirror = await startMirror(runner, scratch);
	// In place, nothing else ends the mirror: a re-run on the same VM starts its own.
	const stop = async (): Promise<void> => {
		await runner.sh(`pkill -f ${q(MIRROR_PROCESS)} || true`);
	};
	return { runner, source: '/opt/dedalo/master_dedalo', mirror, stop };
}

function elWorld(
	args: DrillArgs,
	scratch: string,
): Promise<{ runner: Runner; source: string; mirror: string; stop: () => Promise<void> }> {
	return inPlaceWorld(args, scratch, async (runner, release) => {
		const mode = (await runner.sh('getenforce')).out.trim();
		if (mode !== 'Enforcing')
			throw new CannotRun(`getenforce says '${mode}': the EL drill needs SELinux enforcing`);
		if (
			!/^ID="?(rhel|rocky|almalinux)"?$/m.test(release) ||
			!/^VERSION_ID="?(9|10)(\.\d+)?"?$/m.test(release)
		) {
			throw new CannotRun('the EL drill needs RHEL, Rocky or Alma 9 or 10');
		}
	});
}

/** A Debian-family VM: Debian or Ubuntu by its os-release, the packages the container image carries. */
export function debianInPlaceRefusal(release: string): string | null {
	if (!/^ID="?(debian|ubuntu)"?$/m.test(release))
		return 'the in-place Debian drill needs a Debian or Ubuntu VM (os-release ID debian|ubuntu)';
	return null;
}

function debianInPlaceWorld(
	args: DrillArgs,
	scratch: string,
): Promise<{ runner: Runner; source: string; mirror: string; stop: () => Promise<void> }> {
	return inPlaceWorld(args, scratch, async (runner, release) => {
		const refusal = debianInPlaceRefusal(release);
		if (refusal !== null) throw new CannotRun(refusal);
		const missing = await runner.sh(
			'for b in apache2ctl nginx pkaction sudo script logrotate rsync curl unzip openssl chattr; do command -v $b >/dev/null || echo $b; done; ' +
				'ls /usr/sbin/php-fpm* >/dev/null 2>&1 || echo php-fpm',
		);
		const absent = missing.out.trim();
		if (absent !== '')
			throw new CannotRun(
				`the drill VM lacks ${absent.split('\n').join(', ')} (apt-get install apache2 nginx php-fpm php-cli polkitd sudo logrotate e2fsprogs rsync curl unzip openssl)`,
			);
	});
}

/* ── main ──────────────────────────────────────────────────────────────────────────── */

export function legsFor(args: DrillArgs): Leg[] {
	return LEGS.filter(
		(leg) =>
			(leg.family === 'both' || leg.family === args.family) && (args.inPlace || !leg.inPlaceOnly),
	);
}

async function writeRecord(ctx: Ctx, passed: string[], skipped: string[]): Promise<void> {
	const required = legsFor(ctx.args)
		.filter((l) => l.required)
		.map((l) => l.name);
	const missing = required.filter((name) => !passed.includes(name) && !skipped.includes(name));
	if (missing.length > 0)
		throw new Error(`--record after a run that did not pass ${missing.join(', ')}`);
	const release = (await ctx.runner.sh('. /etc/os-release; echo "$ID $VERSION_ID"')).out
		.trim()
		.split(' ');
	const os = release[1]?.split('.')[0] === '10' ? 'el10' : 'el9';
	const inputs = await elDrillInputs();
	const sha = (await spawnText(['git', 'rev-parse', 'HEAD'])).out.trim();
	const kernel = (await ctx.runner.sh('uname -r')).out.trim();
	const run: ElDrillRecord = {
		inputs_digest: elDrillInputsDigest(AGENT_DIR, inputs),
		hosts: [
			{
				os,
				id: release[0] ?? '',
				version: release[1] ?? '',
				kernel,
				selinux: 'enforcing',
				sha,
				at: new Date().toISOString(),
				measured: {
					booleans: (ctx.facts.booleans as ElMeasured['booleans']) ?? {},
					supported_directives:
						(ctx.facts.supported_directives as ElMeasured['supported_directives']) ?? {},
					home_traverse_type: (ctx.facts.home_traverse_type as string | null) ?? null,
					home_v2_type: (ctx.facts.home_v2_type as string | null) ?? null,
					system_default_readable: (ctx.facts.system_default_readable as boolean | null) ?? null,
					v1_php_floor: (ctx.facts.v1_php_floor as string | null) ?? null,
					nginx_floor: null,
				},
				legs: passed.sort(),
				skipped: skipped.sort(),
			},
		],
	};
	if (skipped.some((name) => required.includes(name))) {
		throw new Error(
			`--record refuses a run that skipped a required leg (${skipped.join(', ')}): the ratchet would rest on an unmeasured property`,
		);
	}
	const existing = existsSync(EL_DRILL_RECORD)
		? (JSON.parse(readFileSync(EL_DRILL_RECORD, 'utf8')) as ElDrillRecord)
		: null;
	writeFileSync(EL_DRILL_RECORD, `${JSON.stringify(mergeRecord(existing, run), null, '\t')}\n`);
	console.log(
		`${TAG} recorded ${relative(REPO_ROOT, EL_DRILL_RECORD)} (${os}, inputs ${run.inputs_digest.slice(0, 12)})`,
	);
}

export async function main(argv: readonly string[]): Promise<number> {
	const args = parseDrillArgs(argv);
	if ('error' in args) {
		console.error(`${TAG} ${args.error}`);
		return 2;
	}
	const legs = legsFor(args);
	const unknown = unknownSkips(args.skip, legs);
	if (unknown.length > 0) {
		console.error(
			`${TAG} --skip names no leg of this run: ${unknown.join(', ')} (the legs: bun run scripts/publication_host_init_drill.ts --plan …)`,
		);
		return 2;
	}
	if (args.plan) {
		for (const leg of legs)
			console.log(`${leg.name}${leg.required ? '' : ' (optional)'} [${leg.family}] — ${leg.what}`);
		return 0;
	}
	const scratch = mkdtempSync(
		join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'dd-init-drill-'),
	);
	let world: Awaited<ReturnType<typeof debianWorld>> | null = null;
	const passed: string[] = [];
	const failed: string[] = [];
	const skipped = legs.filter((l) => args.skip.includes(l.name)).map((l) => l.name);
	try {
		try {
			world =
				args.family === 'el'
					? await elWorld(args, scratch)
					: args.inPlace
						? await debianInPlaceWorld(args, scratch)
						: await debianWorld(args, scratch);
		} catch (error) {
			if (error instanceof CannotRun) {
				console.error(`${TAG} RED — cannot run here: ${error.message}`);
				return 2;
			}
			throw error;
		}
		const ctx: Ctx = {
			args,
			runner: world.runner,
			scratch,
			source: world.source,
			mirror: world.mirror,
			secrets: {
				dbPassword: `Db-${randomBytes(9).toString('base64url')}`,
				apiWebUserCode: `Code-${randomBytes(9).toString('base64url')}`,
			},
			facts: {},
			...parseTargetStart((await world.runner.sh("date +'%F %T|%x %T'")).out),
		};
		for (const leg of legs) {
			if (skipped.includes(leg.name)) {
				console.log(`${TAG} SKIP ${leg.name} (--skip)`);
				continue;
			}
			const t0 = Date.now();
			try {
				await leg.run(ctx);
				passed.push(leg.name);
				console.log(`${TAG} ok   ${leg.name} (${Math.round((Date.now() - t0) / 1000)} s)`);
			} catch (error) {
				failed.push(leg.name);
				console.log(`${TAG} RED  ${leg.name}: ${(error as Error).message}`);
			}
		}
		if (args.capture !== null) {
			const files = await captureDiscovery(ctx, args.capture);
			console.log(`${TAG} captured ${files} discovery outputs into ${args.capture}`);
		}
		if (failed.length === 0 && args.record) await writeRecord(ctx, passed, skipped);
	} finally {
		await world?.stop();
		rmSync(scratch, { recursive: true, force: true });
	}
	const verdict = drillVerdict({ failed, skipped, legs });
	console.log(
		`${TAG} ${verdict.word} on ${args.family}: ${passed.length} green, ${failed.length} red, ${skipped.length} skipped`,
	);
	return verdict.code;
}

/** The --skip names that match no leg of this run: refused, so a typo is never a silent no-op. */
export function unknownSkips(
	skip: readonly string[],
	legs: readonly Pick<Leg, 'name'>[],
): string[] {
	return skip.filter((name) => !legs.some((leg) => leg.name === name));
}

/**
 * The run's verdict: RED (1) when a leg failed; INCOMPLETE (3) when none failed but a REQUIRED
 * leg was skipped — a property nobody measured is never reported 'OK'; else OK (0).
 */
export function drillVerdict(input: {
	failed: readonly string[];
	skipped: readonly string[];
	legs: readonly Pick<Leg, 'name' | 'required'>[];
}): { code: 0 | 1 | 3; word: string } {
	if (input.failed.length > 0) return { code: 1, word: `RED (${input.failed.join(', ')})` };
	const skippedRequired = input.legs
		.filter((leg) => leg.required && input.skipped.includes(leg.name))
		.map((leg) => leg.name);
	if (skippedRequired.length > 0) {
		return { code: 3, word: `INCOMPLETE (required leg(s) skipped: ${skippedRequired.join(', ')})` };
	}
	return { code: 0, word: 'OK' };
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
