/**
 * OPERATOR-PROCEDURE tripwire (DEC-12: every documented invariant has one).
 *
 * A page in `docs/management/` is not prose about the system — it is the thing an operator
 * types into a root shell on a museum's machine. So it has exactly one failure mode worth
 * gating: IT NAMES SOMETHING THAT DOES NOT EXIST.
 *
 * WHY IT EXISTS. Until 2026-08-30 `docs/management/site_builder.md` told an operator to
 * install the site-builder daemon by copying files (`install.sh`, a shipped systemd unit, a
 * hand-written vhost) that had been DELETED when the provisioner replaced them, and the
 * cookbook beside it configured the daemon through four environment keys the daemon does
 * not read (`PREPROD_ROOT`, `PROD_ROOT`, `PREPROD_BASE_URL`, `PROD_BASE_URL`) and told the
 * operator to give a site a custom domain by hand-writing a virtual host — which is now a
 * declared field. Following that page end to end produced a NON-WORKING INSTALL, and every
 * gate in the repo was green the whole time: no test read the manual, and the manual read no
 * code.
 *
 * The same silence covered `engineering/PRODUCTION.md` §6, which names the backup SET. A
 * store named there and copied by nothing is a store discovered missing at restore time,
 * which is the worst moment there is.
 *
 * SIX LEGS, each in both directions where a direction exists:
 *
 *   A. Every `provision <verb>` an operator page names is a verb the CLI HAS — and every
 *      verb the CLI has appears in `docs/management/site_builder.md`, so a new one cannot
 *      ship undocumented.
 *   B. Every flag written next to a `provision` command is a real option, AND is one that
 *      that verb accepts. `provision apply --purge-published` used to be accepted and
 *      silently ignored; a doc that teaches it is the same defect one layer up.
 *   C. Every repo script and deploy artifact an operator page names is on disk.
 *   D. Every daemon environment key an operator page names is one the daemon READS
 *      (`publication/site_builder/src/config.ts`) or an engine catalog key. This is the leg
 *      that catches the four dead root keys without anybody maintaining a list of them.
 *   E. The backup set of `PRODUCTION.md` §6 equals what `deploy/dedalo-backup.service`
 *      copies: every documented store's token appears in the unit, every ExecStart carries a
 *      documented store's token, and the counts agree with the prose.
 *   G. Every declaration a page shows an operator is PARSED by the real schema and DERIVED
 *      by the real layout — including the `--declare` fragment, merged over an inference the
 *      way `adopt` merges it. A copy-paste block that does not parse is the most expensive
 *      kind of wrong: the operator finds out with root, on a museum's host, from a refusal
 *      naming a field they did not choose.
 *   F. BEHAVIOURAL: `deploy/dedalo-site-builder-backup.sh` is RUN over a synthetic host and
 *      must copy the instance marker, both release stores and the served symlink AS a
 *      symlink — and must exit non-zero when a source it was told about is absent. A backup
 *      script that has never been run is a hypothesis, not a backup.
 *
 * WHY THE SCANS ONLY READ CODE CONTEXTS. Every extraction below runs over fenced blocks and
 * inline code spans, never over prose. A sentence may legitimately contain the word
 * "provision" followed by anything at all; a command must be a command.
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXIT, OPTIONAL_FLAGS, VERBS } from '../../publication/site_builder/src/provision/cli.ts';
import { derive } from '../../publication/site_builder/src/provision/layout.ts';
import { parseManifest } from '../../publication/site_builder/src/provision/schema.ts';
import { CONFIG_CATALOG } from '../../src/config/catalog/index.ts';
// The alias rule ITSELF, not a copy of it: leg H holds the backup scripts' own
// fallback table equal to the one the engine's readEnv applies.
import { PHP_KEY_ALIASES } from '../../src/config/env.ts';
import {
	backupStores,
	instanceDropins,
	siteBuilderBackupUnit,
} from '../../src/core/install/host/systemd/render.ts';
import { buildInstallPlan } from '../../src/core/install/install_plan.ts';
import { systemdUnitNames } from '../helpers/deploy_artifact_corpus.ts';
import {
	mergedUnit,
	productionPlanCtx,
	systemdWords,
	unitEnvironment,
} from '../helpers/install_host_scratch.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');

const read = (relative: string): string => readFileSync(join(REPO_ROOT, relative), 'utf8');

/**
 * The pages this gate holds to the code. The management page is the OPERATOR'S, and is the
 * one whose commands must be complete; the others are scanned because they carry commands
 * and keys too, and a stale command is a stale command wherever it sits.
 */
const OPERATOR_PAGE = 'docs/management/site_builder.md';
const SCANNED_PAGES: readonly string[] = [
	OPERATOR_PAGE,
	'docs/management/site_builder_cookbook.md',
	'docs/development/site_builder_internals.md',
	'docs/tools/using_sitebuilder.md',
	'engineering/SITE_BUILDER_INSTANCES.md',
];

/* ─────────────────────────────────────────────────────────────────────────────
 * Extraction — code contexts only
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * Every fenced block body and inline code span in a markdown document, concatenated.
 *
 * BACKSLASH CONTINUATIONS ARE JOINED FIRST. A shell command wrapped over three lines is one
 * command, and reading it line by line was measured to hide `--from` from the very
 * `provision adopt` example that carries it — the gate would then have demanded a flag the
 * page already documents.
 */
function codeText(markdown: string): string {
	const parts: string[] = [];
	for (const match of markdown.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm))
		parts.push(match[1] as string);
	for (const match of markdown.matchAll(/`([^`\n]+)`/g)) parts.push(match[1] as string);
	return parts.join('\n').replace(/\\\n\s*/g, ' ');
}

/** One `provision …` invocation: its verb (null when it is a placeholder) and its flags. */
interface Invocation {
	readonly page: string;
	readonly line: string;
	readonly verb: string | null;
	readonly flags: readonly string[];
}

/**
 * Every `provision …` command line in a page's code contexts.
 *
 * The verb is the first token after `provision` that is not an option. `<verb>` is the
 * documented placeholder in the usage line and is deliberately allowed — the same string
 * `--help` prints.
 */
function invocations(page: string, markdown: string): Invocation[] {
	const found: Invocation[] = [];
	for (const line of codeText(markdown).split('\n')) {
		const at = line.indexOf('provision ');
		if (at === -1) continue;
		// `provisioner`, `provision_x` and friends are words, not the command.
		if (at > 0 && /[A-Za-z0-9_/.-]/.test(line[at - 1] as string)) continue;
		const rest = line
			.slice(at + 'provision '.length)
			.replace(/\\$/, '')
			.trim();
		if (rest === '') continue;
		const tokens = rest.split(/\s+/);
		const first = tokens[0] as string;
		const verb = first.startsWith('-') ? null : first === '<verb>' ? null : first;
		found.push({
			page,
			line: line.trim(),
			verb,
			flags: tokens
				.filter((token) => token.startsWith('-'))
				.map((token) => token.split('=')[0] as string),
		});
	}
	return found;
}

/** The universal options, spelled as the CLI's own tables spell them. */
const UNIVERSAL_OPTIONS = ['--instance', '--all', '--config-dir', '--help', '-h'] as const;

/** camelCase optional flag → its command-line spelling. Asserted against cli.ts below. */
const spellingOf = (flag: string): string =>
	`--${flag.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

/* ─────────────────────────────────────────────────────────────────────────────
 * A + B — the commands
 * ───────────────────────────────────────────────────────────────────────────── */

describe('the provision commands an operator page names are commands that exist', () => {
	const allInvocations = SCANNED_PAGES.flatMap((page) => invocations(page, read(page)));

	test('the flag-spelling derivation is the CLI’s own, not this gate’s guess', () => {
		// This gate derives `--purge-published` from `purgePublished`. If cli.ts ever spells
		// one differently, leg B would be checking against a spelling nothing accepts — so
		// the derivation is pinned against the source that owns it.
		const source = read('publication/site_builder/src/provision/cli.ts');
		for (const flag of OPTIONAL_FLAGS) {
			expect({ flag, line: `${flag}: '${spellingOf(flag)}'` }).toEqual({
				flag,
				line: source.includes(`${flag}: '${spellingOf(flag)}'`)
					? `${flag}: '${spellingOf(flag)}'`
					: `MISSING from cli.ts FLAG_SPELLING`,
			});
		}
	});

	test('anti-vacuity: the scan actually found commands to check', () => {
		// A regex that stops matching would otherwise make every assertion below pass
		// having read nothing. Measured when written: 14 invocations across 5 pages.
		expect(allInvocations.length).toBeGreaterThanOrEqual(10);
	});

	test('every verb named in a doc exists in the CLI', () => {
		const offenders = allInvocations
			.filter((invocation) => invocation.verb !== null && !(invocation.verb in VERBS))
			.map(
				(invocation) =>
					`${invocation.page}: “${invocation.line}” — '${invocation.verb}' is not a verb`,
			);
		expect(
			offenders,
			`A management page names a provisioner verb that does not exist. The verbs are: ` +
				`${Object.keys(VERBS).join(', ')}. An operator does not discover this from the page; ` +
				'they discover it from a refusal on a museum’s host.\n  ' +
				offenders.join('\n  '),
		).toEqual([]);
	});

	test('every verb the CLI has appears in the operator page', () => {
		const documented = new Set(
			invocations(OPERATOR_PAGE, read(OPERATOR_PAGE)).flatMap((i) =>
				i.verb === null ? [] : [i.verb],
			),
		);
		const missing = Object.keys(VERBS).filter((verb) => !documented.has(verb));
		expect(
			missing,
			`${OPERATOR_PAGE} does not show these verbs being run: ${missing.join(', ')}. A verb ` +
				'that ships without a documented procedure is a verb an operator will improvise ' +
				'around, on a live host, with root.',
		).toEqual([]);
	});

	test('every flag written next to a provision command is one that verb accepts', () => {
		const offenders: string[] = [];
		for (const invocation of allInvocations) {
			for (const flag of invocation.flags) {
				if ((UNIVERSAL_OPTIONS as readonly string[]).includes(flag)) continue;
				const owner = OPTIONAL_FLAGS.find((candidate) => spellingOf(candidate) === flag);
				if (owner === undefined) {
					offenders.push(`${invocation.page}: “${invocation.line}” — ${flag} is not an option`);
					continue;
				}
				if (invocation.verb === null) continue;
				const spec = VERBS[invocation.verb];
				if (spec && !spec.flags.includes(owner)) {
					offenders.push(
						`${invocation.page}: “${invocation.line}” — '${invocation.verb}' does not accept ${flag}`,
					);
				}
			}
		}
		expect(
			offenders,
			'A flag a verb does not accept is REFUSED by the CLI by name — so a page teaching it ' +
				'sends an operator to type a command that was never going to run.\n  ' +
				offenders.join('\n  '),
		).toEqual([]);
	});

	test("every verb's required flags are shown at least once where that verb is documented", () => {
		const offenders: string[] = [];
		for (const [verb, spec] of Object.entries(VERBS)) {
			for (const required of spec.requires ?? []) {
				const shown = invocations(OPERATOR_PAGE, read(OPERATOR_PAGE)).some(
					(invocation) =>
						invocation.verb === verb && invocation.flags.includes(spellingOf(required)),
				);
				if (!shown)
					offenders.push(
						`${verb} needs ${spellingOf(required)}, and no example in ${OPERATOR_PAGE} passes it`,
					);
			}
		}
		expect(offenders).toEqual([]);
	});
});

/* ─────────────────────────────────────────────────────────────────────────────
 * B2 — the exit codes
 * ───────────────────────────────────────────────────────────────────────────── */

describe('the exit-code table an operator page prints is the CLI’s own closed set', () => {
	/**
	 * The one part of this page a MACHINE reads. An operator's monitoring job branches on
	 * these numbers — `check` exiting 1 is the assertion that a fleet is converged — so a
	 * table that drifts from `EXIT` is a nightly job that reports the wrong thing forever,
	 * silently, which is the failure mode this whole file exists to end. It was ungated.
	 */
	const TABLE_ROW = /^\|\s*`?(\d+)`?\s*\|\s*(.+?)\s*\|$/gm;

	function documentedCodes(): { code: number; meaning: string }[] {
		const page = read(OPERATOR_PAGE);
		const from = page.indexOf('| Code | Meaning |');
		expect(from, `${OPERATOR_PAGE} no longer carries an exit-code table.`).toBeGreaterThan(-1);
		const to = page.indexOf('\n## ', from);
		const section = page.slice(from, to === -1 ? undefined : to);
		return [...section.matchAll(TABLE_ROW)].map((match) => ({
			code: Number(match[1]),
			meaning: match[2] as string,
		}));
	}

	test('every code the CLI can return is documented, and every documented code is one it returns', () => {
		const documented = documentedCodes().map((row) => row.code);
		expect(documented.length).toBeGreaterThan(0);
		// BOTH directions. A code the CLI returns and the page omits is a number an operator
		// meets for the first time in a failing cron job; a code the page promises and no path
		// returns is a promise to a script that will never be kept — which is exactly why the
		// old `UNSUPPORTED` code was deleted rather than kept as documentation.
		expect(documented.sort((a, b) => a - b)).toEqual(
			[...new Set(Object.values(EXIT))].sort((a, b) => a - b),
		);
	});

	test('the numbers carry the meanings the CLI gives them', () => {
		const byCode = new Map(documentedCodes().map((row) => [row.code, row.meaning.toLowerCase()]));
		// Only the two that a script actually branches on are pinned to their sense: OK is the
		// absence of trouble, and DRIFT is the assertion `check --all` exists to make.
		expect(byCode.get(EXIT.OK)).toContain('nothing to do');
		expect(byCode.get(EXIT.DRIFT)).toContain('drifted');
		expect(byCode.get(EXIT.DRIFT)).toContain('check');
		expect(byCode.get(EXIT.REFUSED)).toContain('refused');
		expect(byCode.get(EXIT.FAILED)).toContain('failed');
	});
});

/* ─────────────────────────────────────────────────────────────────────────────
 * C — the files a procedure names
 * ───────────────────────────────────────────────────────────────────────────── */

describe('every repo artifact an operator page names is on disk', () => {
	/** Repo-relative paths worth resolving: our own scripts, and the deploy artifacts. */
	const PATH_PATTERN =
		/\b(?:scripts\/[A-Za-z0-9_/.-]+\.ts|deploy\/[A-Za-z0-9_.-]+|publication\/site_builder\/src\/[A-Za-z0-9_/.-]+\.ts)\b/g;

	/**
	 * A path in these pages is relative EITHER to the repo root or to the daemon's package —
	 * `deploy/examples/` is the daemon's, `deploy/dedalo-backup.service` is the repo's — so
	 * both roots are tried. Resolving against one only was measured to report six real files
	 * as missing.
	 */
	const ROOTS = ['', 'publication/site_builder'] as const;
	const resolves = (path: string): boolean =>
		ROOTS.some((root) => existsSync(join(REPO_ROOT, root, path)));

	/**
	 * The DOCS pages only. `engineering/SITE_BUILDER_INSTANCES.md` deliberately names files
	 * that must NOT exist — §4's retirement law lists the six hand-written artifacts the
	 * renderers replaced, and its own gate asserts they stay deleted. A page whose subject is
	 * an absence cannot be held to a presence.
	 */
	const PAGES = SCANNED_PAGES.filter((page) => page.startsWith('docs/'));

	test('anti-vacuity: the scan found paths to resolve', () => {
		const all = PAGES.flatMap((page) => [...codeText(read(page)).matchAll(PATH_PATTERN)]);
		expect(all.length).toBeGreaterThanOrEqual(5);
	});

	test('each one resolves', () => {
		const offenders: string[] = [];
		for (const page of PAGES) {
			for (const match of codeText(read(page)).matchAll(PATH_PATTERN)) {
				const path = match[0] as string;
				// A brace-expansion listing (`src/provision/{plan,apply}.ts`) is a summary, not
				// a path; the pattern cannot produce one, but a `*` glob can be written.
				if (path.includes('*')) continue;
				if (!resolves(path)) offenders.push(`${page}: ${path}`);
			}
		}
		expect(
			offenders,
			'A management page names a repo file that does not exist. That is how the retired ' +
				'installer survived in the manual for weeks after it was deleted.\n  ' +
				offenders.join('\n  '),
		).toEqual([]);
	});
});

/* ─────────────────────────────────────────────────────────────────────────────
 * D — the environment keys
 * ───────────────────────────────────────────────────────────────────────────── */

describe('every daemon environment key an operator page names is one the daemon reads', () => {
	/** The daemon's own schema is the census: `  KEY: z.…` in its config module. */
	function daemonKeys(): Set<string> {
		const source = read('publication/site_builder/src/config.ts');
		// `: z.…` is not the only shape — the four roots are declared `: absolutePath,` — and
		// matching only the zod form was measured to drop SITES_ROOT, AGENT_HOME, AUDIT_DIR,
		// WEBSPACE_BASE and SITE_TABLE_FILE from the census, which would have reported five
		// real keys as dead.
		const keys = [...source.matchAll(/^ {2}([A-Z][A-Z0-9_]+):\s/gm)].map((m) => m[1] as string);
		if (keys.length < 20)
			throw new Error(
				'publication/site_builder/src/config.ts: the key grammar changed and this census is scanning nothing',
			);
		return new Set(keys);
	}

	/**
	 * Names that are legitimately UPPER_SNAKE in these pages and are NOT daemon keys. Each
	 * carries its reason, and the set is asserted LIVE below: an entry nothing uses any more
	 * is as much a lie as a missing one.
	 */
	const NOT_A_DAEMON_KEY: Readonly<Record<string, string>> = Object.freeze({
		OPENAI_API_KEY:
			"a THIRD-PARTY variable, forwarded to the OpenCode child inside OPENCODE_ENV's contents; the daemon never reads it",
		OPENAI_BASE_URL: 'the same — the endpoint a local model answers on, forwarded, not read',
		CREDENTIALS_DIRECTORY:
			"systemd's own variable, set by the unit's LoadCredential=; the daemon reads FROM it and does not declare it",
		TOKEN:
			'one of the four words of the credential-law pattern (KEY|TOKEN|SECRET|PASSWORD), quoted as a word',
		SECRET: 'the same pattern, quoted as a word',
		PASSWORD: 'the same pattern, quoted as a word',
		DEDALO_SITE_BUILDER_:
			'the engine key PREFIX, written with a trailing wildcard to mean all of them',
		CSRF: 'a protocol term in the request-model diagram, not a key',
		HTTP: 'a protocol name, not a key',
		PREPROD_PASSWORD:
			'a credential FILE name this repo chose, referenced by PATH from the declaration; it is never an environment key',
		PREPROD_ROOT:
			'RETIRED, and named on purpose: the adoption page has to tell an operator which keys their pre-instance .env carries. Held to the assignment rule below — history may be described, never assigned.',
		PROD_ROOT: 'the same retired pair, and the same rule',
		O_NOFOLLOW:
			"the POSIX open(2) FLAG the daemon's shared writer passes on every descriptor, named in the internals page; it is a kernel constant, never an environment key",
		AGENTS: 'the agent brief file AGENTS.md, named in a workspace listing',
		CLAUDE: 'the symlink CLAUDE.md beside it, named in the same listing',
		HOME: "the POSIX home-directory variable, named in the internals page as one an agent run's environment never carries from the daemon and the egress shim refuses in a spec (the unit fixes it); never a daemon or engine config key",
		DEDALO_:
			'the engine key PREFIX with a trailing wildcard (`DEDALO_*`), naming every engine key the egress shim refuses in a spec',
		// S3-HOME: the five CHILD environment keys the turn unit fixes (agent_identity.ts
		// turnHomeEnvironment), named in the internals page as keys the shim refuses in a spec.
		XDG_CONFIG_HOME:
			"a CHILD environment key the turn unit fixes (root's read-only `.config`, S3-HOME); the shim refuses it in a spec — never a daemon config key",
		XDG_DATA_HOME: "the same — a child key the turn unit fixes, under the turn HOME's `state/`",
		XDG_STATE_HOME: "the same — a child key the turn unit fixes, under the turn HOME's `state/`",
		XDG_CACHE_HOME: "the same — a child key the turn unit fixes, under the turn HOME's `state/`",
		CLAUDE_CONFIG_DIR:
			"the same — a child key the turn unit fixes (the CLI's own state, under `state/claude`)",
		// LEAD-1c: the opencode PLANT restriction, CHILD environment keys every opencode turn
		// carries (src/drivers/opencode_argv.ts) and OPENCODE_ENV may not name.
		OPENCODE_CONFIG_CONTENT:
			"a CHILD environment key of the opencode restriction (the daemon's whole opencode configuration as JSON); OPENCODE_ENV is refused naming it — never a daemon config key",
		OPENCODE_DISABLE_PROJECT_CONFIG: 'the same — a child key of the opencode restriction',
		OPENCODE_PURE: 'the same — a child key of the opencode restriction',
		OPENCODE_DISABLE_CLAUDE_CODE: 'the same — a child key of the opencode restriction',
		OPENCODE_DISABLE_EXTERNAL_SKILLS: 'the same — a child key of the opencode restriction',
		OPENCODE_PERMISSION:
			"the same — a child key of the opencode restriction (the daemon's permission block, in the one key that overrides a configuration's)",
		OPENCODE_DB:
			'a CHILD environment key every opencode turn carries (opencode_argv.ts OPENCODE_DB_KEY: the database the daemon states and reads for a console account); OPENCODE_ENV is refused naming it — never a daemon config key',
		// LEAD-1c: the two stated opencode CREDENTIALS an operator may put in OPENCODE_ENV (its
		// allowlist, opencode_argv.ts isOpencodeCredentialKey) — child keys, never daemon config.
		OPENCODE_API_KEY:
			'a CHILD environment key: an opencode credential OPENCODE_ENV may carry (its allowlist) — never a daemon config key',
		OPENCODE_AUTH_CONTENT:
			"the same — opencode's own credential store, inline, an allowlisted OPENCODE_ENV key",
		// 2026-10-21: Claude Code's off-plan traffic switches, CHILD environment keys every
		// claude_code turn carries in every confinement mode (claude_code.ts CLAUDE_TRAFFIC_SWITCHES).
		DISABLE_AUTOUPDATER:
			"a CHILD environment key every Claude Code turn carries (the CLI's auto-updater off, claude_code.ts CLAUDE_TRAFFIC_SWITCHES) — never a daemon config key",
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:
			"the same — the CLI's non-essential traffic (telemetry, error reporting) off, a child key of every Claude Code turn",
	});

	/**
	 * The DOCS pages only. `engineering/SITE_BUILDER_INSTANCES.md` is a specification and its
	 * code spans are full of TypeScript identifiers (`INSTANCE_PATTERN`, `USER_PREFIX`,
	 * `SLUG_PATTERN`); it also names the four DELETED root keys precisely to record that they
	 * are deleted. Its agreement with the code is gated by the daemon's own
	 * `tests/provision.test.ts`, which evaluates its accessors and its mode matrix directly.
	 */
	const PAGES = SCANNED_PAGES.filter((page) => page.startsWith('docs/'));

	test('anti-vacuity: the scan found keys to check', () => {
		const seen = PAGES.flatMap((page) => [
			...codeText(read(page)).matchAll(/\b[A-Z][A-Z0-9_]{3,}_?\b/g),
		]);
		expect(seen.length).toBeGreaterThanOrEqual(20);
	});

	test('each named key is a daemon key, an engine catalog key, or a reason-stamped exception', () => {
		const daemon = daemonKeys();
		const engine = new Set(Object.keys(CONFIG_CATALOG));
		const offenders: string[] = [];
		const usedExceptions = new Set<string>();

		for (const page of PAGES) {
			for (const match of codeText(read(page)).matchAll(/\b[A-Z][A-Z0-9_]{3,}_?\b/g)) {
				const token = match[0] as string;
				if (daemon.has(token) || engine.has(token)) continue;
				if (token in NOT_A_DAEMON_KEY) {
					usedExceptions.add(token);
					continue;
				}
				offenders.push(`${page}: ${token}`);
			}
		}

		expect(
			offenders,
			'An operator page names an environment key nothing reads. The four that produced a ' +
				'non-working install were PREPROD_ROOT, PROD_ROOT, PREPROD_BASE_URL and ' +
				'PROD_BASE_URL — configuration the daemon had never heard of, in a copy-paste ' +
				'block. Either the key is real (add it to the daemon or the catalog) or the page ' +
				'is wrong.\n  ' +
				offenders.join('\n  '),
		).toEqual([]);

		// LIVE in the other direction: an exception nobody needs is a stale claim.
		expect([...usedExceptions].sort()).toEqual(Object.keys(NOT_A_DAEMON_KEY).sort());
	});

	test('a retired root key may be DESCRIBED but never assigned', () => {
		// The two exceptions above are what let the adoption page name the keys a museum's
		// pre-instance .env actually carries. They are not a licence for the defect this leg
		// was written for: PREPROD_ROOT=/var/lib/… in a copy-paste block is configuration the
		// daemon has never heard of, and it produced a non-working install. Describing is a
		// mention; instructing is an ASSIGNMENT, and only the assignment is refused.
		const RETIRED_KEYS = ['PREPROD_ROOT', 'PROD_ROOT', 'PREPROD_BASE_URL', 'PROD_BASE_URL'];
		const offenders: string[] = [];
		for (const page of SCANNED_PAGES) {
			for (const key of RETIRED_KEYS) {
				const assignment = new RegExp(`\\b${key}\\s*=`);
				for (const [index, line] of read(page).split('\n').entries()) {
					if (assignment.test(line)) offenders.push(`${page}:${index + 1}: ${line.trim()}`);
				}
			}
		}
		expect(
			offenders,
			'A page ASSIGNS a root key the daemon does not read. Those four keys are what made ' +
				'the manual produce a non-working install.\n  ' +
				offenders.join('\n  '),
		).toEqual([]);
		// Anti-vacuity: the rule must still see the shape it forbids.
		expect(/\bPREPROD_ROOT\s*=/.test('PREPROD_ROOT=/var/lib/dedalo_sites/preprod')).toBe(true);
	});

	test('the retired procedure stays retired', () => {
		// The dead ACTS, not a dead filename. The key census above covers the dead env keys;
		// this covers the two instructions that made the page produce a non-working install:
		// run the deleted installer, and hand-copy a unit or a vhost into a system
		// directory. The unit's OLD NAME is deliberately not banned — `provision adopt`
		// defaults `--unit` to it, so a correct page has to be able to say it.
		const MANAGEMENT_PAGES = [
			'docs/management/site_builder.md',
			'docs/management/site_builder_cookbook.md',
		];
		const RETIRED_ACTS: readonly { readonly pattern: RegExp; readonly why: string }[] = [
			{
				pattern: /\binstall\.sh\b/,
				why: 'the retired installer, deleted when the provisioner replaced it',
			},
			{
				pattern: /\b(?:cp|install|ln)\b[^\n]*\/etc\/(?:systemd|nginx|apache2)\b/,
				why: 'hand-copying a unit or a vhost into a system directory — every one of those files is now GENERATED from the declaration, and a copied one is drift on the next run',
			},
		];
		const offenders: string[] = [];
		for (const page of MANAGEMENT_PAGES) {
			const text = read(page);
			for (const act of RETIRED_ACTS) {
				const hit = text.match(act.pattern);
				if (hit) offenders.push(`${page}: “${hit[0]}” — ${act.why}`);
			}
		}
		expect(offenders).toEqual([]);

		// Anti-vacuity: both patterns must still SEE a violation when one is present.
		const controls = [
			'sudo ./install.sh --instance x',
			'sudo cp deploy/dedalo-site-builder.service /etc/systemd/system/',
			'sudo install -m 0644 nginx/site.conf /etc/nginx/sites-available/x.conf',
		];
		for (const control of controls) {
			expect({ control, caught: RETIRED_ACTS.some((act) => act.pattern.test(control)) }).toEqual({
				control,
				caught: true,
			});
		}
	});
});

/* ─────────────────────────────────────────────────────────────────────────────
 * E — the backup set
 * ───────────────────────────────────────────────────────────────────────────── */

describe('the backup set PRODUCTION.md §6 names is the one the nightly unit copies', () => {
	// Two reference units since 2026-10-12: the set (DEDALO_USER) and store 5 (root),
	// its own unit so no root line runs beside the set's EnvironmentFile.
	const MAIN_UNIT = 'deploy/dedalo-backup.service';
	const ROOT_STORE_UNIT = 'deploy/dedalo-backup-site-builder.service';
	const UNITS = [MAIN_UNIT, ROOT_STORE_UNIT];
	const UNIT = UNITS.join(' + ');
	const readUnits = (): string => UNITS.map((unit) => read(unit)).join('\n');

	/** §6, from its heading to the next `## `. */
	function backupSection(): string {
		const doc = read('engineering/PRODUCTION.md');
		const from = doc.indexOf('## 6. Backups');
		expect(from).toBeGreaterThan(-1);
		const to = doc.indexOf('\n## ', from + 1);
		return doc.slice(from, to === -1 ? undefined : to);
	}

	/** The rows of §6's store table: `| n | name | \`token\` |`. */
	function documentedStores(): { number: string; store: string; token: string }[] {
		return [...backupSection().matchAll(/^\|\s*(\d+)\s*\|\s*(.+?)\s*\|\s*`([^`]+)`\s*\|$/gm)].map(
			(m) => ({
				number: m[1] as string,
				store: m[2] as string,
				token: m[3] as string,
			}),
		);
	}

	/** Every ExecStart line of the units, commented-out ones included. */
	function execStarts(unit?: string): string[] {
		return (unit === undefined ? readUnits() : read(unit))
			.split('\n')
			.filter((line) => /^#?ExecStart=/.test(line.trim()));
	}

	test('the table is parseable, and its numbering is 1..n', () => {
		const stores = documentedStores();
		expect(stores.length).toBeGreaterThanOrEqual(5);
		expect(stores.map((s) => s.number)).toEqual(stores.map((_, index) => String(index + 1)));
	});

	test('the prose count equals the number of stores', () => {
		const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
		const stores = documentedStores();
		const expected = `backup set is ${WORDS[stores.length]} stores`;
		expect(
			backupSection().includes(expected),
			`engineering/PRODUCTION.md §6 lists ${stores.length} stores but does not say "${expected}". ` +
				'The sentence and the list are the same claim.',
		).toBe(true);
		// And the numbered narrative list has one item per row. Only the list BEFORE the
		// first subsection: §6.1's restore order is also a numbered list, and counting it
		// too would make the two claims impossible to keep equal.
		const storeList = backupSection().split('\n### ')[0] as string;
		const items = [...storeList.matchAll(/^\d+\. \*\*/gm)];
		expect(items.length).toBe(stores.length);
	});

	test('every documented store is actually copied by the unit', () => {
		const unit = readUnits();
		const offenders = documentedStores()
			.filter((store) => !unit.includes(store.token))
			.map(
				(store) =>
					`store ${store.number} (${store.store}): nothing in ${UNIT} contains \`${store.token}\``,
			);
		expect(
			offenders,
			'A store documented in the backup set and copied by nothing is a store discovered ' +
				'missing at restore time.\n  ' +
				offenders.join('\n  '),
		).toEqual([]);
	});

	test('the unit DECLARES which stores it promises, and the list equals its ACTIVE steps', () => {
		// P0-13, second hole (2026-08-31). The step runner's aggregate iterates the
		// status files that EXIST, so a step whose ExecStart never ran at all is
		// invisible: a run that copied three stores of five reports "every store
		// succeeded". The runner's `any -eq 0` guard only catches a run where
		// NOTHING recorded, never a partial one. The fix needs the unit to say
		// which stores it promised — and that declaration is worthless if it can
		// drift from the ExecStart lines, so it is held equal here.
		for (const UNIT of UNITS) {
			const unit = read(UNIT);
			// Read the way SYSTEMD reads it (its word split of Environment=, quotes removed) —
			// never the source spelling: an unquoted list is split and truncated (campaign 2 L8).
			const declared = unitEnvironment(mergedUnit(unit, [])).get('DEDALO_BACKUP_EXPECTED_STORES');
			// Positive control: the L8 spelling reads as ONE store under this reading.
			expect(
				unitEnvironment(
					mergedUnit('[Service]\nEnvironment=DEDALO_BACKUP_EXPECTED_STORES=matrix_db media\n', []),
				).get('DEDALO_BACKUP_EXPECTED_STORES'),
			).toBe('matrix_db');
			expect(
				declared,
				`${UNIT} declares no Environment=DEDALO_BACKUP_EXPECTED_STORES. Without it the ` +
					'aggregate cannot tell a store that SUCCEEDED from one that never ran.',
			).toBeDefined();
			const promised = (declared ?? '').trim().split(/\s+/).filter(Boolean).sort();

			// The store name is the token right after `run` (or `run --last`).
			const active = execStarts(UNIT)
				.filter((line) => !line.trim().startsWith('#'))
				.map((line) => /dedalo-backup-step\.sh\s+run\s+(?:--last\s+)?([a-z0-9_]+)/.exec(line)?.[1])
				.filter((name): name is string => name !== undefined)
				.sort();
			expect(active.length).toBeGreaterThan(0); // anti-vacuity

			expect(
				promised,
				`${UNIT}: DEDALO_BACKUP_EXPECTED_STORES must name every ACTIVE step and nothing ` +
					'else. A promised store with no step never runs and now fails the unit (correct); ' +
					'an active step missing from the list is invisible to the aggregate (the defect). ' +
					`declared=[${promised.join(' ')}] active=[${active.join(' ')}]`,
			).toEqual(active);
			// Exactly one aggregate per unit: each unit's verdict is reported once.
			expect(
				execStarts(UNIT).filter(
					(line) => !line.trim().startsWith('#') && line.includes(' --last '),
				),
				`${UNIT}: exactly one ExecStart carries --last`,
			).toHaveLength(1);
		}
		// The set pulls the root store in, so the one timer still runs all five.
		expect(mergedUnit(read(MAIN_UNIT), []).get('Unit.Wants') ?? []).toContain(
			'dedalo-backup-site-builder.service',
		);
	});

	test('the compose stack SHOWS the engine the backups it takes', () => {
		// A backup the panel cannot see is a backup the operator does not have.
		// The compose `backup` service writes its dumps into the `backups` volume,
		// but the engine's default backup directory is <privateDir>/backups/db — a
		// DIFFERENT path. Unwired, the stack took real nightly dumps while the
		// maintenance panel reported none, and the code-updater's `backupRequire`
		// precondition then REFUSED an update on the strength of that.
		const compose = read('docker-compose.yml');

		// Where the backup service actually writes its DB dumps.
		const writesTo = /dedalo-db-backup\.sh[^\n]*--dir\s+(\S+)/.exec(compose)?.[1];
		expect(writesTo, 'no compose db-backup --dir found').toBeDefined();

		// Where the engine is told to look.
		const readsFrom = /^\s*DEDALO_BACKUP_DIR:\s*(\S+)\s*$/m.exec(compose)?.[1];
		expect(
			readsFrom,
			'docker-compose.yml sets no DEDALO_BACKUP_DIR for the engine, so it looks in ' +
				'<privateDir>/backups/db while the backup service writes elsewhere — real ' +
				'backups, and a panel that reports none.',
		).toBeDefined();
		expect(readsFrom).toBe(writesTo);

		// ...and the engine's service must MOUNT the volume that path lives on,
		// or the directory is simply absent inside its container.
		const mountRoot = (readsFrom ?? '').split('/').filter(Boolean)[0];
		const appService = compose.slice(0, compose.indexOf('  backup:'));
		expect(
			new RegExp(`-\\s*[a-z_]+:/${mountRoot}\\b`).test(appService),
			`the engine service does not mount anything at /${mountRoot}, so ${readsFrom} ` +
				'does not exist in its container.',
		).toBe(true);

		// The compose loop declares its stores too (same rule as the systemd unit).
		expect(compose).toContain('DEDALO_BACKUP_EXPECTED_STORES=');
	});

	test('the step runner FAILS a run whose expected store never recorded', () => {
		// The behavioural half: the declaration must actually be enforced.
		const runner = read('deploy/dedalo-backup-step.sh');
		expect(runner).toContain('DEDALO_BACKUP_EXPECTED_STORES');
		expect(runner).toContain('MISSING (never ran)');
		// ...and an older unit that predates the variable is WARNED, not silently
		// treated as complete.
		expect(runner).toContain('cannot tell a store that SUCCEEDED from one that never ran');
	});

	test('every ExecStart in the unit is a documented store', () => {
		const tokens = documentedStores().map((store) => store.token);
		const offenders = execStarts().filter((line) => !tokens.some((token) => line.includes(token)));
		expect(
			offenders,
			`${UNIT} copies something engineering/PRODUCTION.md §6 does not list. An undocumented ` +
				'backup step is one nobody knows how to restore.\n  ' +
				offenders.join('\n  '),
		).toEqual([]);
		expect(execStarts().length).toBe(documentedStores().length);
	});

	test("the installer's per-instance backup set (deploy/systemd/dedalo-backup@ + its drop-in) is the documented one", () => {
		// Terminal installer phase 4: a production install gets its stores from the
		// rendered drop-in (src/core/install/host/systemd/render.ts), not this unit. Its
		// stores are the SAME steps, by name — never a store §6 does not document.
		const named = execStarts()
			.map((line) => /dedalo-backup-step\.sh\s+run\s+(?:--last\s+)?([a-z0-9_]+)/.exec(line)?.[1])
			.filter((name): name is string => name !== undefined);
		expect(named.length).toBe(documentedStores().length);
		for (const siteBuilder of [false, true]) {
			const ctx = productionPlanCtx(
				{ os: 'debian13', web: 'nginx', tls: 'letsencrypt' },
				REPO_ROOT,
				{
					backup_site_builder: siteBuilder,
				},
			);
			const stores = backupStores(ctx.paths, ctx.row).map((line) => line.store);
			// The root-run site-builder store is its own unit (never beside the instance's .env).
			const rootStore = instanceDropins(ctx.paths, ctx.row, ctx.answers, 'stamp')
				.map((dropin) => dropin.content)
				.join('\n')
				.includes(`Wants=${siteBuilderBackupUnit(ctx.paths.instance)}`)
				? ['site_builder']
				: [];
			const all = [...stores, ...rootStore];
			expect(all.filter((store) => !named.includes(store))).toEqual([]);
			for (const required of ['matrix_db', 'media', 'private']) expect(stores).toContain(required);
			expect(stores.includes('site_builder')).toBe(false);
			expect(all.includes('site_builder')).toBe(siteBuilder);
		}
	});

	test('§6 states a restore order and a reconciliation rule', () => {
		const section = backupSection();
		for (const required of ['Restore order', 'reconciliation rule']) {
			expect({ required, present: section.includes(required) }).toEqual({
				required,
				present: true,
			});
		}
		// The reconciliation rule is the one `src/provision/verify.ts` runs, and it must name
		// the field it compares against — a rule that says "check the symlink" without saying
		// what it must agree with is not a rule.
		expect(section).toContain('published.release');
	});

	test('the site-builder store’s copier exists, is executable, and derives its paths', () => {
		const script = 'deploy/dedalo-site-builder-backup.sh';
		expect(existsSync(join(REPO_ROOT, script))).toBe(true);
		expect(lstatSync(join(REPO_ROOT, script)).mode & 0o111).toBeGreaterThan(0);
		// EXECUTABLE lines only. The header explains at length which artifacts the script
		// reads, so a whole-file substring check passes on a script whose CODE no longer
		// reads them — measured: renaming the one live `SITES_ROOT` left this green.
		const code = read(script)
			.split('\n')
			.filter((line) => !/^\s*#/.test(line))
			.join('\n');
		// It must read the instance's own generated artifacts rather than carry a list of
		// roots — the second-derivation defect, whose failure direction here is a museum's
		// data quietly outside the backup.
		for (const derived of ['SITES_ROOT', 'AUDIT_DIR', 'sites.json', 'instance.json']) {
			expect({ derived, present: code.includes(derived) }).toEqual({ derived, present: true });
		}
	});
});

/* ─────────────────────────────────────────────────────────────────────────────
 * G — the declarations a page hands an operator
 * ───────────────────────────────────────────────────────────────────────────── */

describe('every declaration an operator page shows actually parses', () => {
	const PAGES = ['docs/management/site_builder.md', 'docs/management/site_builder_cookbook.md'];

	interface Block {
		readonly index: number;
		readonly value: Record<string, unknown>;
	}

	/**
	 * Every fenced ```json block of a page, in the form it CLAIMS to be.
	 *
	 * A page shows two shapes and both must be checked: a whole document (starts with `{`)
	 * and an EXCERPT of one (`"sites": [ … ], "serving": { … }`, which is how the
	 * custom-domain section shows two fields without reprinting a 40-line declaration). An
	 * excerpt is wrapped in braces so it is parsed as what it is, rather than skipped for not
	 * being a document — skipping it is how a mistyped field name in the block an operator is
	 * most likely to copy would go unnoticed.
	 */
	function jsonBlocks(page: string): Block[] {
		const blocks: Block[] = [];
		for (const [index, match] of [...read(page).matchAll(/^```json\n([\s\S]*?)^```/gm)].entries()) {
			const body = (match[1] as string).trim();
			const text = body.startsWith('{') ? body : `{${body.replace(/,\s*$/, '')}}`;
			try {
				blocks.push({ index, value: JSON.parse(text) as Record<string, unknown> });
			} catch (error) {
				throw new Error(
					`${page}: the JSON block at index ${index} is not valid JSON — ${(error as Error).message}. ` +
						'An operator copies these blocks verbatim.',
				);
			}
		}
		return blocks;
	}

	/** A WHOLE declaration names the instance; everything else is an excerpt of one. */
	const declaresAnInstance = (block: Block): boolean => 'instance' in block.value;

	/** The merge `adopt` performs: deep, and the overlay wins at every leaf. */
	function merge(
		base: Record<string, unknown>,
		over: Record<string, unknown>,
	): Record<string, unknown> {
		const out: Record<string, unknown> = { ...base };
		for (const [key, value] of Object.entries(over)) {
			const existing = out[key];
			const bothObjects =
				existing !== null &&
				typeof existing === 'object' &&
				!Array.isArray(existing) &&
				value !== null &&
				typeof value === 'object' &&
				!Array.isArray(value);
			out[key] = bothObjects
				? merge(existing as Record<string, unknown>, value as Record<string, unknown>)
				: value;
		}
		return out;
	}

	/**
	 * What `adopt` infers from a pre-instance install, in the shape it infers it — the base a
	 * documented `--declare` fragment is merged over. Nothing here is invented: these are the
	 * fields `inferManifest` fills from the `.env`, the unit and each site's own manifest, and
	 * the three a pre-instance install cannot record are absent, which is why the fragment
	 * exists at all.
	 */
	const INFERRED_FROM_A_PRE_INSTANCE_HOST: Record<string, unknown> = {
		instance: 'museum-a',
		publication_api: { url: 'http://127.0.0.1:3100/publication/server_api/v2' },
		// Read off the installed unit's WorkingDirectory=/ExecStart=, which is why the
		// documented fragment does not have to carry them — and why this base does.
		engine: {
			checkout_dir: '/opt/dedalo/master_dedalo',
			bun_bin: '/opt/dedalo/.bun/bin/bun',
		},
		identity: { user: 'dedalo-sites', group: 'dedalo-sites' },
		roots: {
			workspaces: '/var/lib/dedalo_sites/workspaces',
			home: '/var/lib/dedalo_sites/home',
			audit: '/var/log/dedalo_sites',
		},
		webspace_base: '/home/www',
		sites: [
			{
				slug: 'coleccion',
				domain: 'www.museum-a.example',
				webspace: '/home/www/www.museum-a.example',
			},
		],
		serving: { preprod: { enabled: true, auth: { mode: 'none', users: [] } } },
		agent: { driver: 'claude_code', bins: { claude_code: '/usr/local/bin/claude' } },
	};

	test('anti-vacuity: there are declarations and excerpts to parse', () => {
		const blocks = PAGES.flatMap((page) => jsonBlocks(page));
		expect(blocks.filter(declaresAnInstance).length).toBeGreaterThanOrEqual(2);
		expect(blocks.length).toBeGreaterThanOrEqual(4);
	});

	test('every whole declaration parses and derives', () => {
		for (const page of PAGES) {
			for (const block of jsonBlocks(page).filter(declaresAnInstance)) {
				// `parseManifest` throws an InstanceManifestError naming every bad field;
				// `derive` is what turns it into paths, so a block that parses but cannot be
				// derived is still a block an operator cannot use.
				const layout = derive(
					parseManifest(block.value, { source: `${page} block ${block.index}` }),
				);
				expect({ page, index: block.index, ok: layout.instance.length > 0 }).toEqual({
					page,
					index: block.index,
					ok: true,
				});
			}
		}
	});

	test("every excerpt's field names are the schema's, merged over that page's own declaration", () => {
		for (const page of PAGES) {
			const blocks = jsonBlocks(page);
			const base = blocks.find(declaresAnInstance);
			expect({ page, hasDeclaration: base !== undefined }).toEqual({ page, hasDeclaration: true });
			for (const block of blocks.filter((candidate) => !declaresAnInstance(candidate))) {
				// An excerpt is shown as a CHANGE to the declaration above it, so that is how
				// it is checked: merged in, it must still be a declaration. A misspelt
				// `webspaces` or `alias` is refused here rather than on a museum's host.
				const merged = merge((base as Block).value, block.value);
				const layout = derive(parseManifest(merged, { source: `${page} excerpt ${block.index}` }));
				expect({ page, index: block.index, ok: layout.sites.length > 0 }).toEqual({
					page,
					index: block.index,
					ok: true,
				});
			}
		}
	});

	test('the --declare fragment merges over an inference and is accepted', () => {
		// The adopt fragment is the one excerpt whose base is NOT the page's own declaration
		// but an inference from a live host, so it gets its own case. It is identified by the
		// field only it supplies.
		const fragments = jsonBlocks('docs/management/site_builder.md').filter(
			(block) => !declaresAnInstance(block) && 'engine' in block.value,
		);
		expect(
			fragments.length,
			'docs/management/site_builder.md no longer shows an adopt --declare fragment. Adoption ' +
				'REFUSES without one, so a page documenting adopt without it documents a refusal.',
		).toBe(1);

		const merged = merge(INFERRED_FROM_A_PRE_INSTANCE_HOST, (fragments[0] as Block).value);
		const manifest = parseManifest(merged, { source: 'the documented --declare fragment' });
		const layout = derive(manifest);

		// It supplies exactly the three things a pre-instance host cannot record …
		expect(manifest.serving.prod.tls.mode).not.toBe(undefined);
		// … while the two the unit DOES record survive the merge, which is what makes the
		// page's "the fragment does not need them" claim true.
		expect(manifest.engine.checkout_dir).toBe('/opt/dedalo/master_dedalo');
		expect(manifest.engine.bun_bin).toBe('/opt/dedalo/.bun/bin/bun');
		expect(layout.identity.engineGroup.length).toBeGreaterThan(0);
		expect(layout.identity.webGroup.length).toBeGreaterThan(0);
		// … and leaves the inference's own findings intact, which a shallow merge would not.
		expect(manifest.serving.preprod.enabled).toBe(true);
		expect(layout.identity.adopted).toBe(true);
		expect(layout.identity.user).toBe('dedalo-sites');
	});
});

/* ─────────────────────────────────────────────────────────────────────────────
 * F — the copier, RUN
 * ───────────────────────────────────────────────────────────────────────────── */

describe('the site-builder backup script actually copies what it claims to', () => {
	const SCRIPT = join(REPO_ROOT, 'deploy', 'dedalo-site-builder-backup.sh');

	/**
	 * A synthetic host: one declared instance, N sites, one published release each.
	 *
	 * `sites` are given as (slug, webspace) so a caller can build the case that matters —
	 * two sites of ONE museum whose webspaces share a basename.
	 */
	function buildHost(
		root: string,
		sites: readonly { slug: string; webspace: string }[] = [
			{ slug: 'coleccion', webspace: join(root, 'srv', 'www', 'www.museum-t.example') },
		],
	): { configDir: string; dest: string } {
		const configDir = join(root, 'etc', 'instances');
		const instanceDir = join(configDir, 'museum-t');
		const workspaces = join(root, 'var', 'workspaces');
		const audit = join(root, 'srv', 'audit');

		mkdirSync(join(instanceDir, 'secrets'), { recursive: true });
		mkdirSync(workspaces, { recursive: true });
		mkdirSync(audit, { recursive: true });

		writeFileSync(join(instanceDir, 'instance.json'), '{}\n');
		writeFileSync(join(instanceDir, 'secrets', 'SERVICE_TOKEN'), 'not-a-real-token\n');
		chmodSync(join(instanceDir, 'secrets', 'SERVICE_TOKEN'), 0o600);
		writeFileSync(join(instanceDir, 'env'), `AUDIT_DIR="${audit}"\nSITES_ROOT="${workspaces}"\n`);
		writeFileSync(
			join(instanceDir, 'sites.json'),
			`// dedalo-provision: museum-t sites 0\n{\n  "sites": [\n${sites
				.map(
					(site) =>
						`    {\n      "slug": "${site.slug}",\n      "webspace": "${site.webspace}"\n    }`,
				)
				.join(',\n')}\n  ]\n}\n`,
		);
		// The marker §5 requires in every root, and the release each site serves.
		writeFileSync(join(workspaces, '.dedalo_site_instance'), 'museum-t\n');
		writeFileSync(join(audit, 'audit.jsonl'), '{}\n');

		for (const site of sites) {
			mkdirSync(join(site.webspace, '.releases', 'web', 'r1'), { recursive: true });
			mkdirSync(join(site.webspace, '.releases', 'pre', 'r2'), { recursive: true });
			mkdirSync(join(workspaces, site.slug), { recursive: true });
			writeFileSync(join(workspaces, site.slug, 'site.json'), '{"published":{"release":"r1"}}\n');
			// The BYTES differ per site, which is the whole point of the collision case: two
			// identical files would pass an overwrite.
			writeFileSync(
				join(site.webspace, '.releases', 'web', 'r1', 'index.html'),
				`live ${site.slug}\n`,
			);
			// Two sites may legitimately be DECLARED onto one webspace — that is the case the
			// refusal below exists for — so the link is planted once.
			if (!existsSync(join(site.webspace, 'web'))) {
				symlinkSync(join('.releases', 'web', 'r1'), join(site.webspace, 'web'));
			}
		}

		return { configDir, dest: join(root, 'backup') };
	}

	/** Where the script puts one webspace: its own source path, minus the leading slash. */
	const backupOf = (dest: string, webspace: string): string =>
		join(dest, 'museum-t', 'webspaces', webspace.replace(/^\//, ''));

	test('it copies the markers, both release stores and the served symlink AS a symlink', () => {
		const root = mkdtempSync(join(tmpdir(), 'dedalo-opcmd-backup-'));
		try {
			const { configDir, dest } = buildHost(root);
			const run = spawnSync('sh', [SCRIPT, dest, configDir], { encoding: 'utf8' });
			expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: '' });

			const instance = join(dest, 'museum-t');
			const webspace = backupOf(dest, join(root, 'srv', 'www', 'www.museum-t.example'));

			// The declaration and its credentials.
			expect(existsSync(join(instance, 'config', 'instance.json'))).toBe(true);
			expect(existsSync(join(instance, 'config', 'secrets', 'SERVICE_TOKEN'))).toBe(true);
			// The workspaces root, INCLUDING the marker — a restore that drops dotfiles
			// produces a root the provisioner refuses.
			expect(existsSync(join(instance, 'workspaces', '.dedalo_site_instance'))).toBe(true);
			expect(existsSync(join(instance, 'workspaces', 'coleccion', 'site.json'))).toBe(true);
			// BOTH release stores.
			expect(existsSync(join(webspace, '.releases', 'web', 'r1', 'index.html'))).toBe(true);
			expect(existsSync(join(webspace, '.releases', 'pre', 'r2'))).toBe(true);
			// The served link, as a LINK: which release is live lives in a symlink and
			// nowhere else, and a copy that dereferenced it would lose that fact.
			expect(lstatSync(join(webspace, 'web')).isSymbolicLink()).toBe(true);
			expect(readlinkSync(join(webspace, 'web'))).toBe(join('.releases', 'web', 'r1'));
			// The audit trail.
			expect(existsSync(join(instance, 'audit', 'audit.jsonl'))).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('two sites of one museum whose webspaces SHARE A BASENAME both survive', () => {
		// THE COLLISION. `sites[].webspace` is a free path, so two sites of one instance may
		// legitimately end in the same directory name. The destination used to be
		// `webspaces/$(basename …)`, so both landed on one path: rsync copied the first and
		// then copied the second over it — one museum's published bytes silently replaced by
		// another of its sites', with the script reporting success and exiting 0.
		const root = mkdtempSync(join(tmpdir(), 'dedalo-opcmd-backup-collision-'));
		try {
			const one = join(root, 'srv', 'srvA', 'site');
			const two = join(root, 'srv', 'srvB', 'site');
			const { configDir, dest } = buildHost(root, [
				{ slug: 'one', webspace: one },
				{ slug: 'two', webspace: two },
			]);
			const run = spawnSync('sh', [SCRIPT, dest, configDir], { encoding: 'utf8' });
			expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: '' });

			// BOTH, each with its own bytes. Same-named directories, two destinations.
			expect(
				readFileSync(join(backupOf(dest, one), '.releases', 'web', 'r1', 'index.html'), 'utf8'),
			).toBe('live one\n');
			expect(
				readFileSync(join(backupOf(dest, two), '.releases', 'web', 'r1', 'index.html'), 'utf8'),
			).toBe('live two\n');
			// And the served link is still a link on both sides.
			expect(lstatSync(join(backupOf(dest, one), 'web')).isSymbolicLink()).toBe(true);
			expect(lstatSync(join(backupOf(dest, two), 'web')).isSymbolicLink()).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('a destination named twice is REFUSED and non-zero — never overwritten', () => {
		// The guard behind the naming: a site table that names one webspace twice would still
		// map onto one destination, and overwriting there is a museum's bytes lost inside a
		// backup that says it succeeded.
		const root = mkdtempSync(join(tmpdir(), 'dedalo-opcmd-backup-twice-'));
		try {
			const shared = join(root, 'srv', 'www', 'shared.example');
			const { configDir, dest } = buildHost(root, [
				{ slug: 'one', webspace: shared },
				{ slug: 'two', webspace: shared },
			]);
			const run = spawnSync('sh', [SCRIPT, dest, configDir], { encoding: 'utf8' });
			expect(run.status).not.toBe(0);
			expect(run.stderr).toContain('twice');
			expect(run.stderr).toContain('NOT backed up');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('a source it was told about but cannot find is LOUD and non-zero', () => {
		const root = mkdtempSync(join(tmpdir(), 'dedalo-opcmd-backup-missing-'));
		try {
			const { configDir, dest } = buildHost(root);
			rmSync(join(root, 'srv', 'audit'), { recursive: true, force: true });
			const run = spawnSync('sh', [SCRIPT, dest, configDir], { encoding: 'utf8' });
			expect(run.status).not.toBe(0);
			expect(run.stderr).toContain('NOT backed up');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

/* ─────────────────────────────────────────────────────────────────────────────
 * H — the nightly backup unit: the keys it reads, the failure it reports, and
 *     the two copiers, RUN
 * ───────────────────────────────────────────────────────────────────────────── */

/* ─────────────────────────────────────────────────────────────────────────────
 * E2 — no shipped reference unit runs as root on anything DEDALO_USER can write
 *
 * The installer-rendered units were fixed for this (install_host_render_tripwire
 * (c)); the single-instance units under deploy/ carried the same escalation until
 * 2026-10-12: store 5 ran as root (`+`) beside an EnvironmentFile DEDALO_USER
 * writes (systemd applies it to `+` lines too — LD_PRELOAD/PATH ran as root), from
 * scripts in the app tree DEDALO_USER owns, into a state dir and destination
 * DEDALO_USER owns; the backup alarm ran as root from the app tree; the rollback
 * unit ran as root moving the app tree and the backup the instance-written
 * sentinel names, its backup root read from DEDALO_USER's .env (the installer's
 * rollback@ unit had been rebuilt; this one had not). A root line may name a
 * DEDALO_USER tree only through a script in ROOT_READS_ONLY (named, with why), and
 * a backup-root-resolving script run as root must pin --backup-root. Judged on the
 * EFFECTIVE unit (systemd's merge, continuation lines joined), every unit shipped.
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * A host layout BY ROLE (2026-10-12, owner decision): the trees DEDALO_USER owns —
 * on a rendered unit, everything under the INSTANCE DIR — and the root-owned dir a
 * root-run script must come from. The shipped units name both only through the
 * INSTANCE_DIR / ROOT_BIN_DIR placeholders, so the rules are judged on RENDERS of
 * real layouts (MANUAL_LAYOUTS), never on one spelling.
 */
interface RoleLayout {
	userWritable: RegExp;
	rootScriptDir: string;
}
/** The pre-2026-10-12 single-instance layout — only the positive controls below use it. */
const LEGACY_LAYOUT: RoleLayout = {
	userWritable: /^\/opt\/dedalo\/(master_dedalo|private|backups)(\/|$)/,
	rootScriptDir: '/opt/dedalo/bin/',
};
/** The worked layouts docs/install/manual_install.md renders the units for (+ the installer's shape). */
const MANUAL_LAYOUTS = [
	{ user: 'dedalo', instanceDir: '/opt/dedalo/app', rootBinDir: '/opt/dedalo/bin' },
	{
		user: 'my_domain',
		instanceDir: '/home/my_domain.org/dedalo',
		rootBinDir: '/usr/local/lib/dedalo/my_domain.org/bin',
	},
	{
		user: 'ded_prado',
		instanceDir: '/home/ded_prado',
		rootBinDir: '/opt/dedalo/instances/prado/bin',
	},
] as const;
type ManualLayout = (typeof MANUAL_LAYOUTS)[number];
/** The placeholders the shipped units carry — the render substitutes each WHOLE word. */
const UNIT_PLACEHOLDERS = ['DEDALO_USER', 'INSTANCE_DIR', 'ROOT_BIN_DIR'] as const;

/** A shipped unit rendered for a layout — the doc's `sed -e 's|\<NAME\>|value|g'`, word for word. */
function renderManualUnit(text: string, layout: ManualLayout): string {
	const values: Record<(typeof UNIT_PLACEHOLDERS)[number], string> = {
		DEDALO_USER: layout.user,
		INSTANCE_DIR: layout.instanceDir,
		ROOT_BIN_DIR: layout.rootBinDir,
	};
	return UNIT_PLACEHOLDERS.reduce(
		(out, name) =>
			out.replace(new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`, 'g'), values[name]),
		text,
	);
}

/** The role layout a render of `layout` is judged against. */
function roleLayoutOf(layout: ManualLayout): RoleLayout {
	const escaped = layout.instanceDir.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
	return { userWritable: new RegExp(`^${escaped}(/|$)`), rootScriptDir: `${layout.rootBinDir}/` };
}

/** A root-owned system binary a root line may run directly (systemctl). */
const SYSTEM_BINARY = /^\/usr\/s?bin\/[a-z][a-z0-9_.-]*$/;

/** The command lines of a unit and whether each runs as root (no User=, or a `+` prefix). */
function rootLines(text: string): { unit: Map<string, string[]>; root: string[] } {
	const unit = mergedUnit(text.replace(/\\\n\s*/g, ' '), []);
	const unitIsRoot = unit.get('Service.User') === undefined;
	const lines = [...unit.entries()]
		.filter(([key]) => /^Service\.Exec(Start|Stop|Reload|Condition)/.test(key))
		.flatMap(([, values]) => values);
	return { unit, root: lines.filter((line) => unitIsRoot || /^[-@:!]*\+/.test(line)) };
}

/**
 * Root-run scripts that only READ a tree DEDALO_USER owns — named, with why. Every
 * other root line naming such a tree is one root ACTS on (moves, writes, resolves
 * paths from), which is the escalation this gate exists for.
 */
const ROOT_READS_ONLY: Readonly<Record<string, string>> = Object.freeze({
	'dedalo-ts-watchdog.sh':
		'reads the update sentinel to choose a remedy; its only actions are systemctl on fixed units',
});
/** Root-run scripts that resolve their backup root from <private>/.env unless --backup-root pins it. */
const RESOLVES_BACKUP_ROOT = ['dedalo-code-rollback.sh', 'dedalo-ts-watchdog.sh'];

/** The trees DEDALO_USER owns that a root line's arguments name (`--flag=<path>` included). */
function userTreesNamed(words: readonly string[], layout: RoleLayout): string[] {
	return words
		.slice(1)
		.map((word) => word.replace(/^--?[a-z][a-z0-9-]*=/, ''))
		.filter((word) => layout.userWritable.test(word));
}

/** Why a unit's root lines can run what DEDALO_USER controls, or []. */
function rootUnitProblems(
	name: string,
	text: string,
	layout: RoleLayout = LEGACY_LAYOUT,
): string[] {
	const USER_WRITABLE = layout.userWritable;
	const ROOT_SCRIPT_DIR = layout.rootScriptDir;
	const { unit, root } = rootLines(text);
	if (root.length === 0) return [];
	const problems: string[] = [];
	if ((unit.get('Service.EnvironmentFile') ?? []).length > 0)
		problems.push(`${name}: a root line beside an EnvironmentFile (it applies to root lines too)`);
	for (const line of root) {
		const words = systemdWords(line.replace(/^[-@:!+]+/, ''));
		const executable = words[0] ?? '';
		if (!executable.startsWith(ROOT_SCRIPT_DIR) && !SYSTEM_BINARY.test(executable))
			problems.push(`${name}: root runs ${executable}, not a ${ROOT_SCRIPT_DIR} copy`);
		for (const word of words.filter((token) => token.endsWith('.sh')))
			if (!word.startsWith(ROOT_SCRIPT_DIR))
				problems.push(`${name}: root runs the script ${word}, not a ${ROOT_SCRIPT_DIR} copy`);
		// OUTCOME, whatever the bin dir is called: root never executes a file the instance owns.
		for (const word of new Set([executable, ...words.filter((token) => token.endsWith('.sh'))]))
			if (USER_WRITABLE.test(word))
				problems.push(`${name}: root executes ${word}, inside a tree DEDALO_USER owns`);
		const script = executable.slice(executable.lastIndexOf('/') + 1);
		// A backup step's destination is its last word: root writes there.
		if (script === 'dedalo-backup-step.sh' && USER_WRITABLE.test(words.at(-1) ?? ''))
			problems.push(
				`${name}: root writes the backup into ${words.at(-1)}, a tree DEDALO_USER owns`,
			);
		else if (ROOT_READS_ONLY[script] === undefined)
			for (const tree of userTreesNamed(words, layout))
				problems.push(`${name}: root runs ${script} on ${tree}, a tree DEDALO_USER owns`);
		if (RESOLVES_BACKUP_ROOT.includes(script) && !words.includes('--backup-root'))
			problems.push(
				`${name}: root runs ${script} without --backup-root — it resolves the root from a .env DEDALO_USER writes`,
			);
	}
	const stateDir = unitEnvironment(unit).get('DEDALO_BACKUP_STATE_DIR');
	if (stateDir !== undefined && USER_WRITABLE.test(stateDir))
		problems.push(`${name}: root writes its verdict into ${stateDir}, a tree DEDALO_USER owns`);
	return problems;
}

describe('no reference unit runs as root on anything DEDALO_USER can write (E2)', () => {
	for (const layout of MANUAL_LAYOUTS) {
		test(`every shipped unit under deploy/, rendered for INSTANCE_DIR=${layout.instanceDir} ROOT_BIN_DIR=${layout.rootBinDir}`, () => {
			const units = systemdUnitNames();
			expect(units.length).toBeGreaterThan(5);
			// the layout itself obeys the rule: root's dir is not inside the instance dir
			expect(roleLayoutOf(layout).userWritable.test(layout.rootBinDir)).toBe(false);
			const rendered = units.map((name) => ({
				name,
				text: renderManualUnit(read(`deploy/${name}`), layout),
			}));
			const problems = rendered.flatMap(({ name, text }) =>
				rootUnitProblems(name, text, roleLayoutOf(layout)),
			);
			const rooted = rendered.flatMap(({ text }) => rootLines(text).root);
			// rollback's restart, watchdog, restart, the site-builder store: root lines exist, so the rule bites.
			expect(rooted.length).toBeGreaterThanOrEqual(4);
			expect(problems).toEqual([]);
		});
	}

	test('the units name a layout ONLY through the placeholders: no host path is spelled in an active line', () => {
		// Rule 3 of the role-based layout: one set of units serves any instance dir and
		// any root bin dir. An active line spelling /opt/dedalo, /home/… or /srv/… would
		// serve one layout and silently mean the wrong directory on every other.
		const offenders: string[] = [];
		let placeholders = 0;
		for (const name of systemdUnitNames()) {
			for (const [index, line] of read(`deploy/${name}`).split('\n').entries()) {
				if (/^\s*(#|;|$)/.test(line)) continue;
				placeholders += (line.match(/\b(INSTANCE_DIR|ROOT_BIN_DIR)\b/g) ?? []).length;
				if (/(^|[\s=])\/(opt|home|srv)\//.test(line))
					offenders.push(`${name}:${index + 1}: ${line.trim()}`);
			}
		}
		expect(placeholders).toBeGreaterThanOrEqual(10);
		expect(offenders).toEqual([]);
		// positive control: the pre-2026-10-12 spelling is caught by that reading
		expect(/(^|[\s=])\/(opt|home|srv)\//.test('WorkingDirectory=/opt/dedalo/master_dedalo')).toBe(
			true,
		);
	});

	test('positive control: a render that puts ROOT_BIN_DIR inside the instance dir is caught', () => {
		// The bin dir check alone would pass it (the scripts ARE in the bin dir); the
		// outcome check is what catches root executing a file the instance can replace.
		const inside = {
			user: 'x',
			instanceDir: '/home/x',
			rootBinDir: '/home/x/bin',
		} as unknown as ManualLayout;
		expect(roleLayoutOf(inside).userWritable.test(inside.rootBinDir)).toBe(true);
		const problems = systemdUnitNames().flatMap((name) =>
			rootUnitProblems(
				name,
				renderManualUnit(read(`deploy/${name}`), inside),
				roleLayoutOf(inside),
			),
		);
		expect(problems).toContain(
			'dedalo-ts-watchdog.service: root executes /home/x/bin/dedalo-ts-watchdog.sh, inside a tree DEDALO_USER owns',
		);
		expect(problems).toContain(
			'dedalo-backup-site-builder.service: root executes /home/x/bin/dedalo-backup-step.sh, inside a tree DEDALO_USER owns',
		);
	});

	test('positive control: the store-5 line as it shipped before 2026-10-12 is caught', () => {
		const before = [
			'[Service]',
			'Type=oneshot',
			'User=DEDALO_USER',
			'EnvironmentFile=/opt/dedalo/private/.env',
			'Environment=DEDALO_BACKUP_STATE_DIR=/opt/dedalo/backups',
			'ExecStart=-/opt/dedalo/master_dedalo/deploy/dedalo-backup-step.sh run private /opt/dedalo/master_dedalo/deploy/dedalo-tree-backup.sh --dest /opt/dedalo/backups/private',
			'ExecStart=+/opt/dedalo/master_dedalo/deploy/dedalo-backup-step.sh run --last site_builder /opt/dedalo/master_dedalo/deploy/dedalo-site-builder-backup.sh /opt/dedalo/backups/site_builder',
			'',
		].join('\n');
		expect(rootUnitProblems('before', before)).toEqual([
			'before: a root line beside an EnvironmentFile (it applies to root lines too)',
			'before: root runs /opt/dedalo/master_dedalo/deploy/dedalo-backup-step.sh, not a /opt/dedalo/bin/ copy',
			'before: root runs the script /opt/dedalo/master_dedalo/deploy/dedalo-backup-step.sh, not a /opt/dedalo/bin/ copy',
			'before: root runs the script /opt/dedalo/master_dedalo/deploy/dedalo-site-builder-backup.sh, not a /opt/dedalo/bin/ copy',
			'before: root executes /opt/dedalo/master_dedalo/deploy/dedalo-backup-step.sh, inside a tree DEDALO_USER owns',
			'before: root executes /opt/dedalo/master_dedalo/deploy/dedalo-site-builder-backup.sh, inside a tree DEDALO_USER owns',
			'before: root writes the backup into /opt/dedalo/backups/site_builder, a tree DEDALO_USER owns',
			'before: root writes its verdict into /opt/dedalo/backups, a tree DEDALO_USER owns',
		]);
		// …and the alarm as it shipped (root, no User=, from the app tree).
		const alarm =
			'[Service]\nType=oneshot\nEnvironment=DEDALO_BACKUP_STATE_DIR=/opt/dedalo/backups\nExecStart=/opt/dedalo/master_dedalo/deploy/dedalo-backup-alert.sh %i\n';
		expect(rootUnitProblems('alarm', alarm)).toEqual([
			'alarm: root runs /opt/dedalo/master_dedalo/deploy/dedalo-backup-alert.sh, not a /opt/dedalo/bin/ copy',
			'alarm: root runs the script /opt/dedalo/master_dedalo/deploy/dedalo-backup-alert.sh, not a /opt/dedalo/bin/ copy',
			'alarm: root executes /opt/dedalo/master_dedalo/deploy/dedalo-backup-alert.sh, inside a tree DEDALO_USER owns',
			'alarm: root writes its verdict into /opt/dedalo/backups, a tree DEDALO_USER owns',
		]);
	});

	test('positive control: the rollback and watchdog units as they shipped before 2026-10-12 are caught', () => {
		// Root (no User=) moving the app tree and the backup named in the sentinel the
		// service user writes, its backup root resolved from the service user's .env.
		const rollback = [
			'[Service]',
			'Type=oneshot',
			'ExecStart=/opt/dedalo/bin/dedalo-code-rollback.sh \\',
			'    --app-dir /opt/dedalo/master_dedalo \\',
			'    --service dedalo-ts \\',
			'    --socket /run/dedalo/dedalo_ts.sock',
			'',
		].join('\n');
		expect(rootUnitProblems('rollback', rollback)).toEqual([
			'rollback: root runs dedalo-code-rollback.sh on /opt/dedalo/master_dedalo, a tree DEDALO_USER owns',
			'rollback: root runs dedalo-code-rollback.sh without --backup-root — it resolves the root from a .env DEDALO_USER writes',
		]);
		// The same with --app-dir=… spelling: still caught.
		expect(
			rootUnitProblems(
				'eq',
				'[Service]\nExecStart=/opt/dedalo/bin/dedalo-code-rollback.sh --app-dir=/opt/dedalo/master_dedalo --backup-root=/opt/dedalo/backups/code\n',
			),
		).toEqual([
			'eq: root runs dedalo-code-rollback.sh on /opt/dedalo/master_dedalo, a tree DEDALO_USER owns',
			'eq: root runs dedalo-code-rollback.sh on /opt/dedalo/backups/code, a tree DEDALO_USER owns',
			'eq: root runs dedalo-code-rollback.sh without --backup-root — it resolves the root from a .env DEDALO_USER writes',
		]);
		// The watchdog only reads (ROOT_READS_ONLY), but an unpinned backup root is still its .env's.
		const watchdog =
			'[Service]\nType=oneshot\nExecStart=/opt/dedalo/bin/dedalo-ts-watchdog.sh --socket /run/dedalo/dedalo_ts.sock --app-dir /opt/dedalo/master_dedalo --service dedalo-ts.service --grace 900\n';
		expect(rootUnitProblems('watchdog', watchdog)).toEqual([
			'watchdog: root runs dedalo-ts-watchdog.sh without --backup-root — it resolves the root from a .env DEDALO_USER writes',
		]);
		// The shipped rollback unit: the file work as DEDALO_USER, only the fixed restart as root.
		const shipped = rootLines(
			renderManualUnit(read('deploy/dedalo-ts-rollback.service'), MANUAL_LAYOUTS[0]),
		).root;
		expect(shipped.length).toBe(2);
		for (const line of shipped) expect(line).toMatch(/^\+\/usr\/bin\/systemctl /);
	});
});

/**
 * WHY (P0-13, 2026-08-30). Every link of the recovery chain failed SILENTLY, and
 * every one of them failed in this tree, which no gate read:
 *
 *   - `deploy/dedalo-backup.service` read $DB_PASSWORD/$DB_HOST/$DB_USER/$DB_NAME
 *     and $MEDIA_PATH — spellings the install wizard NEVER WRITES (it writes the
 *     PHP-catalog names: src/core/install/config_persist.ts). On a wizard-installed
 *     host those five expanded to empty strings.
 *   - `Type=oneshot` with four plain ExecStart lines stops at the first failure, so
 *     a database that was down at 03:30 meant the media originals, ../private/ and
 *     every museum's site-builder instance were not copied either.
 *   - There was no `OnFailure=` and no notification anywhere in deploy/.
 *   - The dump was never read back, so a truncated artifact counted as a fresh
 *     backup for the code updater's own refusal gate.
 *
 * These legs are the mechanical half of that repair. The alias table is checked
 * against `PHP_KEY_ALIASES` ITSELF (imported, not copied), the installer's written
 * keys are PARSED out of the persister, and the two new copiers are RUN — a backup
 * script that has never been run is a hypothesis, not a backup.
 */
describe('the nightly backup unit reads keys that exist and reports the failures it has', () => {
	const UNIT = 'deploy/dedalo-backup.service';
	const STEP = 'deploy/dedalo-backup-step.sh';
	const DB_SCRIPT = 'deploy/dedalo-db-backup.sh';
	const TREE_SCRIPT = 'deploy/dedalo-tree-backup.sh';

	/** Every ExecStart line of the unit that is NOT commented out. */
	function activeExecStarts(): string[] {
		return read(UNIT)
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line.startsWith('ExecStart='));
	}

	/** Every `--<something>-key <KEY>` pair written in the unit. */
	function keyArguments(): { flag: string; key: string }[] {
		return [...read(UNIT).matchAll(/--([a-z-]+)-key\s+([A-Z][A-Z0-9_]*)/g)].map((m) => ({
			flag: m[1] as string,
			key: m[2] as string,
		}));
	}

	/**
	 * The `alias_of()` case arms of one script: `KEY) echo ALIAS ;;`. It is the
	 * script's copy of the env.ts fallback rule, and the point of parsing it is that
	 * a copy which drifts is exactly the defect this leg exists for.
	 */
	function scriptAliases(relative: string): Record<string, string> {
		const body = read(relative);
		const from = body.indexOf('alias_of()');
		expect(
			from,
			`${relative}: no alias_of() — the TS-native → PHP-alias fallback is what makes the unit work on a wizard-installed host`,
		).toBeGreaterThan(-1);
		const scope = body.slice(from, body.indexOf('\n}', from));
		const table: Record<string, string> = {};
		for (const m of scope.matchAll(/^\s*([A-Z][A-Z0-9_]*)\)\s*echo\s+([A-Z][A-Z0-9_]*)\s*;;/gm)) {
			table[m[1] as string] = m[2] as string;
		}
		return table;
	}

	/**
	 * The keys `persistConfig` WRITES into ../private/.env — the install plan's own
	 * key list with every optional block on (installer unification A1, 2026-10-08:
	 * every installer writes the .env from `install_plan.ts`), never listed here.
	 * This is the census the old unit contradicted.
	 */
	function installerWrittenKeys(): Set<string> {
		const plan = buildInstallPlan(
			{
				db_database: 'x',
				db_username: 'u',
				entity: 'e',
				diffusion: true,
				mailer: true,
				smtp_host: 'h',
				media_path: '/m',
				unix_socket: '/s',
				media_access_mode: 'publication',
			},
			{ salt: 's' },
		);
		const keys = new Set(plan.envKeys);
		expect(keys.size, 'install_plan.ts: no written keys — this leg went blind').toBeGreaterThan(5);
		return keys;
	}

	test('every alias the backup scripts carry is the one src/config/env.ts resolves', () => {
		for (const script of [DB_SCRIPT, TREE_SCRIPT]) {
			const table = scriptAliases(script);
			expect(
				Object.keys(table).length,
				`${script}: alias_of() has no entries — nothing would fall back to the installer's spelling`,
			).toBeGreaterThan(0);
			for (const [native, alias] of Object.entries(table)) {
				expect(
					{ script, native, alias },
					`${script} maps ${native} → ${alias}; src/config/env.ts maps it to ${PHP_KEY_ALIASES[native] ?? '(nothing)'}. The backup must read the key the way the engine does, or it dumps the wrong thing or nothing at all.`,
				).toEqual({ script, native, alias: PHP_KEY_ALIASES[native] as string });
			}
		}
	});

	test('every key the unit names is a real config key, and one the install can produce', () => {
		const catalog = new Set(Object.keys(CONFIG_CATALOG));
		const aliasNames = new Set(Object.values(PHP_KEY_ALIASES));
		const written = installerWrittenKeys();
		const dbAliases = scriptAliases(DB_SCRIPT);
		const treeAliases = scriptAliases(TREE_SCRIPT);

		const offenders: string[] = [];
		for (const { flag, key } of keyArguments()) {
			const known = catalog.has(key) || aliasNames.has(key) || key in PHP_KEY_ALIASES;
			if (!known) {
				offenders.push(`--${flag}-key ${key}: not a catalog key, not a PHP alias`);
				continue;
			}
			// THE DEFECT THIS LEG IS NAMED AFTER. When a key HAS a PHP alias, the alias
			// is the spelling the install wizard writes and the bare key is the one it
			// does not — so reading the bare key alone resolves to empty on every
			// wizard-installed host. Being a documented catalog key is NOT enough to
			// escape this (DB_PASSWORD is one, and was exactly the key that failed):
			// the script must carry the fallback.
			const expectedAlias = PHP_KEY_ALIASES[key];
			const mapped = (dbAliases[key] ?? treeAliases[key]) as string | undefined;
			if (expectedAlias !== undefined) {
				if (mapped !== expectedAlias) {
					offenders.push(
						`--${flag}-key ${key}: the install wizard writes ${expectedAlias}, not ${key}, and no backup script maps one to the other (it maps ${mapped ?? 'nothing'})`,
					);
				}
				continue;
			}
			// No alias: the key is its own spelling everywhere, so it only has to be a
			// key the engine documents or the installer writes.
			if (!catalog.has(key) && !written.has(key)) {
				offenders.push(`--${flag}-key ${key}: no catalog entry and the installer never writes it`);
			}
		}
		expect(
			offenders,
			'A backup unit that reads a key nothing sets dumps as the wrong role, from the wrong host, into a file named after nothing — and says it worked.\n  ' +
				offenders.join('\n  '),
		).toEqual([]);
	});

	test('one store failing cannot silence the others, and the run still reports failure', () => {
		const active = activeExecStarts();
		expect(active.length).toBeGreaterThanOrEqual(2);
		const last = active[active.length - 1] as string;
		// The aggregator: it runs after its own store and turns "any store failed" into
		// the unit's exit status. Without it, `-` on every line would make the unit
		// always succeed — the papered-over failure that is worse than the outage.
		expect(
			last.includes('--last'),
			`${UNIT}: the last ExecStart must carry --last, or nothing ever reports the run's verdict:\n  ${last}`,
		).toBe(true);
		const notTolerant = active
			.slice(0, -1)
			.filter((line) => !line.startsWith('ExecStart=-') && !line.startsWith('ExecStart=+-'));
		expect(
			notTolerant,
			`${UNIT}: a Type=oneshot unit stops at the first failing ExecStart, so every step before the last must be '-'-prefixed or one store's failure cancels the rest.\n  ` +
				notTolerant.join('\n  '),
		).toEqual([]);
		// And every step goes through the runner that records it: a step that bypasses it
		// is a store whose outcome the aggregate verdict cannot see.
		const unrecorded = active.filter((line) => !line.includes('dedalo-backup-step.sh'));
		expect(
			unrecorded,
			`${UNIT}: these steps record no status\n  ${unrecorded.join('\n  ')}`,
		).toEqual([]);
	});

	test('the unit names a failure alarm, and the alarm exists', () => {
		const unit = read(UNIT);
		const onFailure = unit.match(/^OnFailure=(\S+)$/m);
		expect(
			onFailure,
			`${UNIT}: no OnFailure=. A backup that fails silently every night is worse than no backup, because it is believed.`,
		).not.toBeNull();
		// `%n` is the failed unit's name; the target is a template unit, so the file on
		// disk is the part before the '@'.
		const target = (onFailure?.[1] as string).replace(/@.*$/, '@.service');
		expect(existsSync(join(REPO_ROOT, 'deploy', target))).toBe(true);
		const alarm = read(`deploy/${target}`);
		const script = alarm.match(/ExecStart=(\S+)/)?.[1] as string;
		expect(existsSync(join(REPO_ROOT, 'deploy', script.split('/').pop() as string))).toBe(true);
	});

	test('the media store keeps generations and states its retention rule', () => {
		const tree = read(TREE_SCRIPT);
		// EXECUTABLE lines only. The header explains --link-dest at length, so a
		// whole-file substring check stays green on a script whose CODE stopped
		// linking generations — measured: replacing the live flag left this green.
		const code = tree
			.split('\n')
			.filter((line) => !/^\s*#/.test(line))
			.join('\n');
		// --link-dest is what makes N generations affordable; KEEP is the rule. A
		// single mirrored generation propagates a mass deletion into the only copy of
		// the media originals within a day.
		expect(code).toContain('--link-dest');
		expect(tree).toMatch(/RETENTION RULE/);
		expect(code).toMatch(/KEEP=\d+/);
		// And the unit must not have gone back to mirroring the media root in place.
		const unit = read(UNIT);
		expect(unit).not.toMatch(/^ExecStart=[^#\n]*rsync/m);
	});

	test('a dump that cannot be read back never becomes a *.backup file', () => {
		const root = mkdtempSync(join(tmpdir(), 'dedalo-opcmd-db-backup-'));
		try {
			const bin = join(root, 'bin');
			const dir = join(root, 'db');
			mkdirSync(bin, { recursive: true });
			// A pg_dump that "succeeds" and leaves a file — the truncated-dump case: the
			// bytes are there, they are just not a whole archive.
			writeFileSync(
				join(bin, 'pg_dump'),
				'#!/bin/sh\nfor a in "$@"; do case "$a" in --file=*) f=${a#--file=};; esac; done\nprintf half > "$f"\nexit 0\n',
			);
			writeFileSync(
				join(bin, 'pg_restore_bad'),
				'#!/bin/sh\necho "unexpected end of file" >&2\nexit 1\n',
			);
			writeFileSync(join(bin, 'pg_restore_ok'), '#!/bin/sh\nexit 0\n');
			for (const name of ['pg_dump', 'pg_restore_bad', 'pg_restore_ok']) {
				chmodSync(join(bin, name), 0o755);
			}

			const run = (restore: string) =>
				spawnSync(
					'sh',
					[
						join(REPO_ROOT, DB_SCRIPT),
						'--dir',
						dir,
						'--db',
						'scratch_museum',
						'--pg-dump',
						join(bin, 'pg_dump'),
						'--pg-restore',
						join(bin, restore),
					],
					{ encoding: 'utf8' },
				);

			const bad = run('pg_restore_bad');
			expect(bad.status).not.toBe(0);
			// NOTHING under the final suffix, and no leftovers either: a half dump under
			// a backup's name is what makes the update panel say "ready to update".
			expect(readdirSync(dir)).toEqual([]);

			const good = run('pg_restore_ok');
			expect({ status: good.status, stderr: good.stderr }).toEqual({ status: 0, stderr: '' });
			const files = readdirSync(dir);
			expect(files.length).toBe(1);
			// The suffix newestBackupMtimeMs() scans (core/area_maintenance/backup.ts).
			expect(files[0]).toMatch(/\.custom\.backup$/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("an orphaned .part is ADOPTED by a full read, never deleted (the engine's rule)", () => {
		// OPS-2 review: the nightly `find … -exec rm` deleted every day-old part in
		// the directory — including the ENGINE's orphans, whose pg_dump outlived a
		// server restart and may have finished a complete restore point.
		const root = mkdtempSync(join(tmpdir(), 'dedalo-opcmd-db-orphans-'));
		try {
			const bin = join(root, 'bin');
			const dir = join(root, 'db');
			mkdirSync(bin, { recursive: true });
			mkdirSync(dir, { recursive: true });
			// A pg_restore that tells the TWO reads apart, the way the real one does:
			// `--list` accepts any header-shaped file (GOOD… or HALF… — a 60% cut lists
			// perfectly), the FULL read (`--file=`) accepts only bytes that end with the
			// complete marker. A fake that answered both the same could not tell a
			// TOC-only adoption from the full read (review: that mutation stayed green).
			const reads = join(root, 'reads.log');
			writeFileSync(
				join(bin, 'pg_restore'),
				[
					'#!/bin/sh',
					'for a in "$@"; do f="$a"; done',
					`printf '%s %s\\n' "$1" "$f" >> '${reads}'`,
					// HOST-BOUND failures of the full read (the bytes are fine): an I/O
					// error on the backup storage, and a read killed from outside.
					'case "$1:$(head -c 4 "$f")" in',
					'  --file=*:EIOF) echo "pg_restore: error: could not read from input file: Input/output error" >&2; exit 1 ;;',
					'  --file=*:KILL) kill -9 $$ ;;',
					'esac',
					'case "$(head -c 4 "$f")" in GOOD|HALF|EIOF|KILL) ;; *) echo "pg_restore: error: did not find magic string in file header" >&2; exit 1 ;; esac',
					'case "$1" in --list) exit 0 ;; esac',
					'case "$(tail -c 3 "$f")" in END) exit 0 ;; *) echo "pg_restore: error: could not read from input file: end of file" >&2; exit 1 ;; esac',
					'',
				].join('\n'),
			);
			writeFileSync(
				join(bin, 'pg_dump'),
				'#!/bin/sh\nfor a in "$@"; do case "$a" in --file=*) f=${a#--file=};; esac; done\nprintf GOODdumpEND > "$f"\nexit 0\n',
			);
			for (const name of ['pg_dump', 'pg_restore']) chmodSync(join(bin, name), 0o755);
			const finalName = (tag: string) =>
				join(dir, `2026-01-0${tag}_000000.zz.postgresql_timer.custom.backup`);
			const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3_600_000);
			const plant = (tag: string, bytes: string, aged: boolean) => {
				const part = `${finalName(tag)}.part`;
				writeFileSync(part, bytes);
				if (aged) utimesSync(part, threeDaysAgo, threeDaysAgo);
				return part;
			};
			const complete = plant('1', 'GOOD a finished orphan END', true);
			// Passes --list, fails the full read: what a dump cut at 60% looks like.
			const listsButCut = plant('2', 'HALF a dump that died', true);
			const young = plant('3', 'GOOD maybe still being written END', false);
			// A complete orphan whose final name is already taken by other bytes.
			const nameTaken = plant('4', 'GOOD a second finished orphan END', true);
			writeFileSync(finalName('4'), 'an operator copy that must survive');
			// An EMPTY aged part: maybe a pg_dump still queued behind a table lock.
			const empty = plant('5', '', true);
			// A disproved orphan whose `.orphaned` name is already taken (an earlier
			// kept-aside dump): both sets of bytes survive, the new one at `.orphaned.1`.
			const asideTaken = plant('6', 'HALF a second dump that died', true);
			writeFileSync(`${finalName('6')}.orphaned`, 'HALF an earlier dump kept aside');
			// UNDECIDED orphans (OPS-1 review, third round): complete dumps whose read
			// failed for a reason that is NOT the bytes. The engine leaves such a part
			// for the next pass; moving it to `.orphaned` took a complete dump out of
			// the backup set for good (no door reads that name again).
			const ioError = plant('7', 'EIOF a complete dump on a flaky disk END', true);
			const killedRead = plant('8', 'KILL a complete dump, read OOM-killed END', true);

			const run = spawnSync(
				'sh',
				[
					join(REPO_ROOT, DB_SCRIPT),
					'--dir',
					dir,
					'--db',
					'scratch_museum',
					'--pg-dump',
					join(bin, 'pg_dump'),
					'--pg-restore',
					join(bin, 'pg_restore'),
				],
				{ encoding: 'utf8' },
			);
			expect({ status: run.status, stderr: run.stderr.includes('NOT a restore point') }).toEqual({
				status: 0,
				stderr: true,
			});
			// The complete orphan got its final name.
			expect(existsSync(complete)).toBe(false);
			expect(readFileSync(finalName('1'), 'utf8')).toBe('GOOD a finished orphan END');
			// The cut one was asked the FULL read — and never got a backup name.
			expect(readFileSync(reads, 'utf8')).toContain(`--file=/dev/null ${listsButCut}`);
			expect(existsSync(finalName('2'))).toBe(false);
			expect(existsSync(listsButCut)).toBe(false);
			expect(readFileSync(`${finalName('2')}.orphaned`, 'utf8')).toBe('HALF a dump that died');
			// The taken name is untouched; the orphan's bytes are kept aside.
			expect(readFileSync(finalName('4'), 'utf8')).toBe('an operator copy that must survive');
			expect(existsSync(nameTaken)).toBe(false);
			expect(readFileSync(`${finalName('4')}.orphaned`, 'utf8')).toBe(
				'GOOD a second finished orphan END',
			);
			// The young part and the empty one are not touched.
			expect(readFileSync(young, 'utf8')).toBe('GOOD maybe still being written END');
			expect(existsSync(empty)).toBe(true);
			expect(statSync(empty).size).toBe(0);
			// A taken `.orphaned` is never overwritten: the next free number is used.
			expect(existsSync(asideTaken)).toBe(false);
			expect(readFileSync(`${finalName('6')}.orphaned`, 'utf8')).toBe(
				'HALF an earlier dump kept aside',
			);
			expect(readFileSync(`${finalName('6')}.orphaned.1`, 'utf8')).toBe(
				'HALF a second dump that died',
			);
			// Undecided: asked the full read, then LEFT IN PLACE — no `.orphaned`, no name.
			for (const [tag, part] of [
				['7', ioError],
				['8', killedRead],
			] as const) {
				expect(readFileSync(reads, 'utf8')).toContain(`--file=/dev/null ${part}`);
				expect(existsSync(part)).toBe(true);
				expect(existsSync(`${finalName(tag)}.orphaned`)).toBe(false);
				expect(existsSync(finalName(tag))).toBe(false);
			}
			expect(run.stderr).toContain(`left ${ioError} in place`);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('the step runner runs every store and still fails the run', () => {
		const root = mkdtempSync(join(tmpdir(), 'dedalo-opcmd-backup-step-'));
		try {
			mkdirSync(root, { recursive: true });
			const env = {
				...process.env,
				DEDALO_BACKUP_STATUS_DIR: join(root, 'status'),
				DEDALO_BACKUP_STATE_DIR: join(root, 'state'),
			};
			const step = join(REPO_ROOT, STEP);
			const witness = join(root, 'second_store_ran');

			const failing = spawnSync('sh', [step, 'run', 'store_one', 'sh', '-c', 'exit 3'], {
				encoding: 'utf8',
				env,
			});
			expect(failing.status).toBe(3);

			// THE POINT: the second store runs even though the first one failed.
			const second = spawnSync('sh', [step, 'run', 'store_two', 'sh', '-c', `: > ${witness}`], {
				encoding: 'utf8',
				env,
			});
			expect(second.status).toBe(0);
			expect(existsSync(witness)).toBe(true);

			// AND THE OTHER POINT: the run's verdict is still failure, in the exit status
			// and on disk, so OnFailure= fires and the operator has something to find.
			const last = spawnSync('sh', [step, 'run', '--last', 'store_three', 'true'], {
				encoding: 'utf8',
				env,
			});
			expect(last.status).not.toBe(0);
			expect(existsSync(join(root, 'state', 'BACKUP_FAILED'))).toBe(true);
			expect(readFileSync(join(root, 'state', 'BACKUP_FAILED'), 'utf8')).toContain('store_one');

			// A clean run clears the marker: an alarm that is only ever raised is ignored
			// exactly like a stuck one.
			rmSync(join(root, 'status'), { recursive: true, force: true });
			const clean = spawnSync('sh', [step, 'run', '--last', 'store_one', 'true'], {
				encoding: 'utf8',
				env,
			});
			expect(clean.status).toBe(0);
			expect(existsSync(join(root, 'state', 'BACKUP_FAILED'))).toBe(false);
			expect(existsSync(join(root, 'state', 'LAST_OK'))).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('a deletion in the source does not reach the previous generation', () => {
		const root = mkdtempSync(join(tmpdir(), 'dedalo-opcmd-tree-backup-'));
		try {
			const source = join(root, 'media');
			const dest = join(root, 'backup');
			mkdirSync(source, { recursive: true });
			writeFileSync(join(source, 'irreplaceable.tif'), 'the only copy\n');
			writeFileSync(join(source, 'other.tif'), 'x\n');

			const script = join(REPO_ROOT, TREE_SCRIPT);
			const run = (keep: string) =>
				spawnSync(
					'sh',
					[script, '--dest', dest, '--label', 'media', '--source', source, '--keep', keep],
					{
						encoding: 'utf8',
					},
				);

			expect(run('2').status).toBe(0);
			const first = readdirSync(dest).filter((name) => /^\d{4}-/.test(name));
			expect(first.length).toBe(1);

			// The mass-deletion case, in miniature.
			rmSync(join(source, 'irreplaceable.tif'));
			// The generation name is a per-second timestamp; without the wait the second
			// run would land in the same second and refuse (correctly) rather than test
			// what this is about.
			spawnSync('sh', ['-c', 'sleep 1.1']);
			expect(run('2').status).toBe(0);

			const generations = readdirSync(dest)
				.filter((name) => /^\d{4}-/.test(name))
				.sort();
			expect(generations.length).toBe(2);
			// Yesterday still has the file today lost. This is the whole reason
			// generations exist, and what `rsync -a --delete` into one directory removed.
			expect(existsSync(join(dest, generations[0] as string, 'irreplaceable.tif'))).toBe(true);
			expect(existsSync(join(dest, generations[1] as string, 'irreplaceable.tif'))).toBe(false);
			expect(readlinkSync(join(dest, 'latest'))).toBe(generations[1] as string);

			// Retention removes only beyond --keep, and only whole generations.
			spawnSync('sh', ['-c', 'sleep 1.1']);
			expect(run('2').status).toBe(0);
			const kept = readdirSync(dest)
				.filter((name) => /^\d{4}-/.test(name))
				.sort();
			expect(kept.length).toBe(2);
			expect(kept).not.toContain(generations[0] as string);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('an unresolvable media root REFUSES rather than backing up a guess', () => {
		const root = mkdtempSync(join(tmpdir(), 'dedalo-opcmd-tree-refuse-'));
		try {
			mkdirSync(root, { recursive: true });
			// MEDIA_PATH unset and no alias: the engine's own default is one of two
			// paths (src/config/catalog/media.ts legacyAwareDefaultDir), and guessing the
			// wrong one backs up an empty directory while reporting success.
			const env = { ...process.env };
			env.MEDIA_PATH = '';
			env.DEDALO_MEDIA_PATH = '';
			const run = spawnSync(
				'sh',
				[
					join(REPO_ROOT, TREE_SCRIPT),
					'--dest',
					join(root, 'backup'),
					'--label',
					'media',
					'--source-key',
					'MEDIA_PATH',
				],
				{ encoding: 'utf8', env },
			);
			expect(run.status).not.toBe(0);
			expect(run.stderr).toContain('MEDIA_PATH');
			expect(existsSync(join(root, 'backup'))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
