/**
 * deploy_env_contract_tripwire — A SHIPPED UNIT MAY ONLY READ VARIABLES THAT
 * EXIST ON A REAL HOST (P0-13, 2026-08-30).
 *
 * THE DEFECT THIS CLOSES, measured. `deploy/dedalo-backup.service` shipped with
 *
 *     ExecStart=… pg_dump -h $DB_HOST -U $DB_USER -d $DB_NAME …
 *
 * under `EnvironmentFile=/opt/dedalo/private/.env`. The install wizard does not
 * write those names: `src/core/install/config_persist.ts` writes the
 * PHP-catalog spellings (`DEDALO_HOSTNAME_CONN`, `DEDALO_USERNAME_CONN`,
 * `DEDALO_DATABASE_CONN`, `DEDALO_PASSWORD_CONN`), and `MEDIA_PATH` only when
 * the CLI installer was given `--media-path`. systemd expands an unset variable
 * to the EMPTY STRING, so on a wizard-installed host the nightly backup ran as
 * the wrong role against the wrong server and produced nothing — while the
 * maintenance panel, which only asks whether a file exists and is non-empty,
 * reported a fresh restore point and let the operator authorise a code update
 * on the strength of it. A museum may hold ONE copy of its catalogue.
 *
 * The `DB_*` names are not imaginary: they ARE real keys of the typed config
 * catalog (`src/config/catalog/db.ts`), which is exactly why the mistake was
 * invisible to a reader. `src/config/env.ts::PHP_KEY_ALIASES` resolves the two
 * spellings onto each other — but that resolution lives in the TS ENGINE. No
 * part of it exists inside systemd or /bin/sh, so what a shipped unit gets is
 * the literal name and nothing else. That gap is what the two rules below
 * separate.
 *
 * 2026-10-09: the installer now writes the CANONICAL spellings (DB_NAME, …).
 * That does not make `$DB_HOST` safe in a unit: a `.env` written by an earlier
 * installer, or carried over from PHP, still holds only the alias spelling. So
 * R1 counts NO alias-bearing name (either side of PHP_KEY_ALIASES) as provided —
 * a unit that needs one passes the key NAME to dedalo-db-backup.sh, which
 * resolves both spellings with the engine's precedence.
 *
 * NO GATE HELD THIS CONTRACT before P0-13, and none read `deploy/` as a TREE.
 * The nearest neighbour, `test/unit/operator_commands_tripwire.test.ts`, reads
 * exactly two of the eighteen files by name (leg E: the backup unit's store
 * tokens against PRODUCTION.md §6; leg F: the site-builder backup script's
 * behaviour), and leg H — added the same day as this file — checks the `--*-key`
 * ARGUMENTS the rebuilt unit now passes. None of them looks at `$VAR`
 * expansions, and nothing at all looked at the other sixteen files.
 *
 * ── WHAT IS ASSERTED ────────────────────────────────────────────────────────
 *
 *  A. THE EXTRACTOR ITSELF, against a synthetic sample, in BOTH directions —
 *     it must find the reference forms and it must NOT find the non-references
 *     (a local assignment, `$1`, `$@`, a command substitution, a comment). A
 *     scanner that finds nothing would make every leg below vacuously green.
 *  B. ANTI-VACUITY FLOORS on the real scan: how many files, how many raw
 *     references, how many distinct externally-sourced names.
 *  C. RULE R1 — a name a file reads with NO shell default anywhere in that file
 *     must be one the INSTALLER WRITES, or one a shipped unit sets with its own
 *     `Environment=` line. Catalog membership is deliberately NOT enough here:
 *     that is precisely the `$DB_HOST` defect. Positive control: the historical
 *     ExecStart line is replayed as a fixture and must be reported as five
 *     violations, while its correct form is accepted.
 *  D. RULE R2 — EVERY reference, defaulted ones included, must additionally be
 *     a documented key (the typed catalog or the runtime bootstrap keys) or an
 *     exemption. `${FOO:-/some/path}` cannot expand to a surprise empty string,
 *     so a documented-but-not-installer-written key is legitimate there; an
 *     UNDOCUMENTED name still has to be declared here with a reason.
 *  E. THE EXEMPTION LIST is small, reason-bearing, and STALE-FREE: an exempt
 *     name that `deploy/` no longer references fails, which is what makes the
 *     list shrink-only in practice.
 *  F. THE PROVIDED SETS ARE REAL — each derivation is checked against a key it
 *     must contain, so a parser that silently returns {} (renamed file, changed
 *     literal style) fails LOUDLY instead of turning C and D into a rubber
 *     stamp by making everything a violation… or, worse, by making the census
 *     look complete.
 *  G. MEDIA RETENTION IS MECHANICAL (S-7 / LIFE-05). A `--delete` mirror is
 *     ONE generation: a deletion in the media originals reached the only media
 *     backup at the next nightly run, so the store PRODUCTION.md §6 calls "the
 *     source of truth every derivative rebuilds from" had no recovery point.
 *     TOTAL over deploy/** and the compose stacks: every rsync that deletes
 *     must build a `--link-dest` generation under a stated retention (`--keep`
 *     / `KEEP`), and every `dedalo-tree-backup.sh` invocation must carry
 *     `--keep` (the script refuses without it, but a unit that forgot it is a
 *     backup that fails every night). Positive control: the historical
 *     `rsync -a --delete $MEDIA_PATH/ /backup/media/` line. ENUMERATED,
 *     reason-bearing, shrink-only exemption for the one mirror that is not yet
 *     a generation store (site-builder, store 5).
 *
 * ── CENSUS: TOTAL over deploy/, DERIVED on both sides ───────────────────────
 *
 * The referenced side is read off every `*.sh`, `*.service` and `*.timer` in
 * `deploy/` (listed with readdirSync — never enumerated here). The provided
 * side is the install plan's key list (`install_plan.ts`, every option on), imported from `CONFIG_CATALOG` and
 * `RUNTIME_PATH_BOOTSTRAP_KEYS`, and read off the units' own `Environment=`
 * lines. Nothing on either side is typed out by hand.
 *
 * ── HONEST LIMITS (things this gate does NOT prove) ─────────────────────────
 *
 *  1. IT IS A STATIC READ. It proves a name is written SOMEWHERE by the
 *     installer, not that it holds a usable value, that the backup runs, that
 *     the dump restores, or that systemd parses the unit. Nothing here was run
 *     under systemd (this repo is developed on macOS).
 *  2. CONDITIONAL WRITES COUNT AS WRITES. `MEDIA_PATH` and
 *     `SERVER_UNIX_SOCKET` are written by the install plan only when the CLI
 *     installer received the flag; the all-options plan cannot see that condition. The
 *     tree's only consumer of `MEDIA_PATH` today resolves it itself and refuses
 *     loudly when unset (`deploy/dedalo-tree-backup.sh`), so the gap is covered
 *     by the script, not by this file.
 *  3. IT DOES NOT READ `--*-key` ARGUMENTS. `dedalo-backup.service` passes key
 *     NAMES as argv (`--db-key DB_NAME`) and `dedalo-db-backup.sh` resolves
 *     them in shell with the engine's TS-name-then-PHP-alias precedence. Those
 *     are not `$VAR` expansions and are held by leg H of
 *     `test/unit/operator_commands_tripwire.test.ts`, not here.
 *  4. FULL-LINE COMMENTS ARE SKIPPED, deliberately: `dedalo-backup.service`'s
 *     header quotes `$DB_PASSWORD` while explaining this very defect, and a
 *     scanner that read comments would go red on the fix. Mid-line comments are
 *     NOT stripped (a `#` inside a shell string cannot be told from a comment
 *     without a parser), so a reference in a trailing comment is still counted
 *     — over-reporting, which is the safe direction.
 *  5. ASSIGNMENT MASKING IS ORDER-BLIND. A name assigned anywhere in a file is
 *     treated as local to it. A script that read a variable from the
 *     environment BEFORE assigning it would be missed.
 *  6. SCOPE IS `deploy/` UNITS AND SHELL SCRIPTS. `deploy/*.conf` (nginx's
 *     `$host`, `$request_uri` are web-server variables, not environment) and
 *     the compose stacks are out of scope; a compose `environment:` block is a
 *     different contract with a different provider.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CONFIG_CATALOG } from '../../src/config/catalog/index.ts';
import { PHP_KEY_ALIASES } from '../../src/config/env.ts';
import { buildInstallPlan } from '../../src/core/install/install_plan.ts';
import { RUNTIME_PATH_BOOTSTRAP_KEYS } from '../../src/core/install/runtime_paths.ts';

const ROOT = resolve(import.meta.dir, '../..');
const DEPLOY = join(ROOT, 'deploy');

/**
 * Variables that legitimately come from somewhere other than the installer or
 * the config catalog. ENUMERATED, SHRINK-ONLY, one reason each — and leg E
 * refuses a stale entry, so removing the last reference removes the exemption.
 */
const EXTERNAL_VARIABLES: ReadonlyMap<string, string> = new Map([
	[
		'HOME',
		'deploy.sh sends `\\$HOME/.bun/bin/bun` to the far side of an ssh command — escaped, so it is expanded by the REMOTE login shell as the deploy user, not by this host and not from ../private/.env',
	],
	[
		'TMPDIR',
		'POSIX environment, read by dedalo-tls-rotate.sh as `${TMPDIR:-/tmp}` for a mktemp -d staging directory that lives for one run',
	],
	[
		'RUNTIME_DIRECTORY',
		"systemd sets it from the unit's own `RuntimeDirectory=` (dedalo-backup.service declares one); it is the per-run status directory systemd creates and removes, so no installer could write it — the script falls back to /run/dedalo-backup when it is absent",
	],
	[
		'DEDALO_BACKUP_STATUS_DIR',
		'Override knob for the same per-run status directory, so the backup step runner can be exercised outside systemd (its behavioural gates do exactly that). It is not an engine config key — nothing in src/ reads it — and it is read as `${…:-}` behind the RUNTIME_DIRECTORY fallback',
	],
	[
		'DEDALO_BACKUP_MAILTO',
		'Deliberately NOT a .env key: ../private/.env is append-only/documented-keys-only, and the failure alarm must still work when the engine cannot start. Set with `systemctl edit` on dedalo-backup-alert@.service, whose commented Environment= line documents it. Read as `${…:-}`, so unset simply means the optional local-mail channel is off',
	],
]);

// ── the extractor ──────────────────────────────────────────────────────────

interface Reference {
	readonly name: string;
	readonly file: string;
	readonly line: number;
	/** `${NAME:-…}` / `:=` / `:?` — a form that cannot silently expand to empty. */
	readonly defaulted: boolean;
}

interface ScanResult {
	readonly references: readonly Reference[];
	/** Names the file assigns itself, i.e. NOT read from the environment. */
	readonly assigned: ReadonlySet<string>;
	/** `Environment=NAME=` names a systemd unit provides to what it starts. */
	readonly provides: ReadonlySet<string>;
}

/**
 * `$NAME`, `${NAME…}` and `${#NAME}`. The `{`-form's next character decides
 * whether the read carries a default: `:-`, `:=`, `:?` (and their `:`-less
 * spellings) cannot produce a silent empty string; `}`, `#`, `%`, `/` can.
 */
const REFERENCE_RE = /\$(\{#?)?([A-Za-z_][A-Za-z0-9_]*)([^}]?)/g;

/** Shell assignments, `for NAME in`, `read [-flags] NAME`. */
const ASSIGN_RE =
	/(?:^|[\s;&|(){}]|\b(?:local|export|readonly|declare|typeset)\s+)([A-Za-z_][A-Za-z0-9_]*)\s*=/g;
const FOR_RE = /\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\b/g;
const READ_RE = /\bread\s+(?:-\w+\s+)*([A-Za-z_][A-Za-z0-9_]*)/g;
/** A systemd unit setting a variable for the process it starts. */
const UNIT_ENV_RE = /^\s*Environment=["']?([A-Za-z_][A-Za-z0-9_]*)=/;

/**
 * The line with its SINGLE-quoted spans blanked: the shell never expands `$name`
 * inside `'…'`, so a Go template (`'{{range $platform, …}}'`) is not a reference.
 * Double quotes and unquoted text stay as they are (`"$HOME"` still expands). A
 * quote opened inside double quotes is literal and changes nothing.
 */
function unsingleQuoted(line: string): string {
	let out = '';
	let single = false;
	let double = false;
	for (const ch of line) {
		if (!single && ch === '"') double = !double;
		if (!double && ch === "'") single = !single;
		out += single && ch !== "'" ? ' ' : ch;
	}
	return out;
}

function scan(text: string, file: string, isUnit: boolean): ScanResult {
	const references: Reference[] = [];
	const assigned = new Set<string>();
	const provides = new Set<string>();
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as string;
		// See honest limit 4: a full-line comment is not code.
		if (/^\s*#/.test(line)) continue;
		if (isUnit) {
			const env = UNIT_ENV_RE.exec(line);
			if (env) provides.add(env[1] as string);
		} else {
			for (const m of line.matchAll(ASSIGN_RE)) assigned.add(m[1] as string);
			for (const m of line.matchAll(FOR_RE)) assigned.add(m[1] as string);
			for (const m of line.matchAll(READ_RE)) assigned.add(m[1] as string);
		}
		for (const m of unsingleQuoted(line).matchAll(REFERENCE_RE)) {
			const braced = m[1] !== undefined;
			const name = m[2] as string;
			const after = m[3] ?? '';
			const defaulted = braced && /^[:\-=?+]/.test(after);
			references.push({ name, file, line: i + 1, defaulted });
		}
	}
	return { references, assigned, provides };
}

/** `*.sh`, `*.service`, `*.timer` under deploy/ — LISTED, never enumerated. */
const DEPLOY_FILES = readdirSync(DEPLOY)
	.filter((f) => /\.(sh|service|timer)$/.test(f))
	.sort();

const SCANS = DEPLOY_FILES.map((f) => ({
	file: f,
	isUnit: /\.(service|timer)$/.test(f),
	...scan(readFileSync(join(DEPLOY, f), 'utf8'), f, /\.(service|timer)$/.test(f)),
}));

/** Every reference whose name the SAME file does not assign itself. */
const EXTERNAL_REFERENCES: readonly Reference[] = SCANS.flatMap((s) =>
	s.references.filter((r) => !s.assigned.has(r.name)),
);

// ── the provided sets ──────────────────────────────────────────────────────

/**
 * Keys the installers actually write into ../private/.env — an OUTCOME, not a
 * source spelling: since 2026-10-08 (installer unification A1) every installer
 * writes the .env from the one plan module, so the set is the plan's own key
 * list with every optional block switched on (diffusion, mailer, media path,
 * socket, access mode, update servers).
 */
function installerWrittenKeys(): ReadonlySet<string> {
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
	return new Set(plan.envKeys);
}

const INSTALLER_WRITTEN = installerWrittenKeys();
const UNIT_PROVIDED = new Set(SCANS.flatMap((s) => [...s.provides]));
const CATALOG_KEYS = new Set(Object.keys(CONFIG_CATALOG));
const BOOTSTRAP_KEYS = new Set(RUNTIME_PATH_BOOTSTRAP_KEYS);

/**
 * Names with two spellings (PHP_KEY_ALIASES, either side). A real host's .env
 * may carry EITHER one — the current installer writes the canonical name, an
 * earlier installer or a PHP-era .env the alias — so neither is "definitely set".
 */
const ALIAS_BEARING = new Set([...Object.keys(PHP_KEY_ALIASES), ...Object.values(PHP_KEY_ALIASES)]);

/** R1's providers: something on a real host definitely sets the name. */
function providedOnHost(name: string): boolean {
	return (INSTALLER_WRITTEN.has(name) && !ALIAS_BEARING.has(name)) || UNIT_PROVIDED.has(name);
}
/** R2's providers: the above, plus names an operator is DOCUMENTED to set. */
function documented(name: string): boolean {
	return providedOnHost(name) || CATALOG_KEYS.has(name) || BOOTSTRAP_KEYS.has(name);
}

/**
 * R1 violations in a scanned file's references: a name read with no default
 * ANYWHERE in that file (`[ -n "${X:-}" ]` before a bare `$X` is a sound and
 * used idiom, so one defaulted read makes the whole file's reads guarded).
 */
function unguardedUnprovided(scanned: {
	references: readonly Reference[];
	assigned: ReadonlySet<string>;
}): string[] {
	const guarded = new Set(scanned.references.filter((r) => r.defaulted).map((r) => r.name));
	const bad = new Set<string>();
	for (const r of scanned.references) {
		if (scanned.assigned.has(r.name)) continue;
		if (guarded.has(r.name)) continue;
		if (EXTERNAL_VARIABLES.has(r.name)) continue;
		if (!providedOnHost(r.name)) bad.add(r.name);
	}
	return [...bad].sort();
}

// ── leg G: retention over deploy/** + the compose stacks ───────────────────

/**
 * Every file under deploy/ (recursively) plus docker-compose*.yml at the root
 * — LISTED, never enumerated. Wider than DEPLOY_FILES on purpose: a compose
 * stack's backup loop is a copy of the systemd job in another syntax, and a
 * mirror hiding in a .tpl or a .ts helper would still be a mirror.
 */
function walk(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		return entry.isDirectory() ? walk(path) : [path];
	});
}
const RETENTION_FILES: readonly string[] = [
	...walk(DEPLOY),
	...readdirSync(ROOT)
		.filter((f) => /^docker-compose.*\.ya?ml$/.test(f))
		.map((f) => join(ROOT, f)),
]
	.map((p) => p.slice(ROOT.length + 1))
	.sort();

/**
 * Logical lines: comments dropped, backslash continuations joined — a compose
 * `command:` spreads one invocation over several physical lines.
 */
function logicalLines(text: string): string[] {
	const out: string[] = [];
	let carry = '';
	for (const raw of text.split('\n')) {
		const line = carry + raw;
		if (/\\\s*$/.test(line)) {
			carry = `${line.replace(/\\\s*$/, '')} `;
			continue;
		}
		carry = '';
		if (/^\s*#/.test(line)) continue;
		out.push(line);
	}
	return out;
}

interface RetentionScan {
	/** rsync invocations that delete (on the line, or via the file's `set --` assembly). */
	readonly deletingRsyncs: readonly { line: string; at: number }[];
	/** dedalo-tree-backup.sh invocations (logical lines). */
	readonly treeBackups: readonly { line: string; at: number }[];
	/** Does the file build --link-dest generations under a stated retention? */
	readonly generational: boolean;
}

function scanRetention(text: string): RetentionScan {
	const lines = logicalLines(text);
	const assemblesDelete = lines.some((l) => /\bset\s+--.*--delete\b/.test(l));
	const deletingRsyncs: { line: string; at: number }[] = [];
	const treeBackups: { line: string; at: number }[] = [];
	lines.forEach((line, i) => {
		// `rsync` as a command, not the word in a message or a `command -v` probe.
		if (/(^|[\s=;|&(`/])rsync\s+(?!>)/.test(line) && !/command -v rsync|echo|fail "/.test(line)) {
			if (/--delete\b/.test(line) || assemblesDelete) deletingRsyncs.push({ line, at: i + 1 });
		}
		if (
			/dedalo-tree-backup\.sh/.test(line) &&
			!/^\s*(ExecStart=)?[^ ]*dedalo-tree-backup\.sh\s*$/.test(line) &&
			!/\bcp\b|\bchmod\b|\binstall\b/.test(line)
		) {
			treeBackups.push({ line, at: i + 1 });
		}
	});
	// On CODE lines only: dedalo-tree-backup.sh's header explains --link-dest at
	// length, and a scanner reading comments would call a script that lost the
	// flag generational on the strength of its own documentation.
	const code = lines.join('\n');
	const generational = /--link-dest/.test(code) && (/--keep\b/.test(code) || /\bKEEP\b/.test(code));
	return { deletingRsyncs, treeBackups, generational };
}

/** A deleting rsync in a file that is NOT a generation store. */
function bareMirrors(scanned: RetentionScan): number[] {
	return scanned.generational ? [] : scanned.deletingRsyncs.map((r) => r.at);
}
/** A tree-backup invocation without `--keep`. */
function keeplessTreeBackups(scanned: RetentionScan): number[] {
	return scanned.treeBackups.filter((t) => !/--keep\b/.test(t.line)).map((t) => t.at);
}

/**
 * The mirrors that are NOT yet generation stores. ENUMERATED, one reason
 * each, SHRINK-ONLY: leg G refuses a stale entry and caps the size.
 */
const BARE_MIRROR_EXEMPTIONS: ReadonlyMap<string, string> = new Map([
	[
		'deploy/dedalo-site-builder-backup.sh',
		"store 5 (site-builder instances) copies each instance's config/workspaces/webspaces/audit as ONE mirror at a fixed layout that test/unit/operator_commands_tripwire.test.ts leg F pins path by path; turning it into dated --link-dest generations changes that layout and is a named follow-up of S-7 (LIFE-05 closed stores 3 and 4). Until then a deleted site reaches the only copy at the next nightly run — an operator wanting generations wraps the DEST in a filesystem snapshot",
	],
]);

const RETENTION_SCANS = RETENTION_FILES.map((file) => ({
	file,
	...scanRetention(readFileSync(join(ROOT, file), 'utf8')),
}));

// ── legs ───────────────────────────────────────────────────────────────────

describe('deploy_env_contract_tripwire', () => {
	test('A. the extractor finds the reference forms — and nothing that is not one', () => {
		const sample = [
			'# a comment mentioning $COMMENT_ONLY must not count (honest limit 4)',
			'LOCAL_ONE="value"',
			'echo "$LOCAL_ONE $BARE ${BRACED} ${WITH_DEFAULT:-x} ${TRIMMED%/} ${#COUNTED}"',
			'printf "%s" "$1" "$@" "$(date)" "$$"',
			'for LOOP_VAR in a b; do echo "$LOOP_VAR"; done',
		].join('\n');
		const s = scan(sample, 'sample.sh', false);
		const names = s.references.map((r) => r.name);

		expect(names).toContain('BARE');
		expect(names).toContain('BRACED');
		expect(names).toContain('WITH_DEFAULT');
		expect(names).toContain('TRIMMED');
		expect(names).toContain('COUNTED');
		// The negative half: a scanner that matched these would be over-eager.
		expect(names).not.toContain('COMMENT_ONLY');
		expect(names).not.toContain('date');

		// Only the `:-` form is a guarded read.
		const defaulted = s.references.filter((r) => r.defaulted).map((r) => r.name);
		expect(defaulted).toEqual(['WITH_DEFAULT']);

		// Locally assigned names are not environment reads.
		expect(s.assigned.has('LOCAL_ONE')).toBe(true);
		expect(s.assigned.has('LOOP_VAR')).toBe(true);
		expect(s.assigned.has('BARE')).toBe(false);

		// A unit's Environment= line PROVIDES a name to what it starts.
		const unit = scan(
			[
				'[Service]',
				'Environment=PROVIDED_BY_UNIT=/opt/x',
				'ExecStart=/bin/x $PROVIDED_BY_UNIT',
			].join('\n'),
			'sample.service',
			true,
		);
		expect([...unit.provides]).toEqual(['PROVIDED_BY_UNIT']);
		expect(unit.references.map((r) => r.name)).toEqual(['PROVIDED_BY_UNIT']);
	});

	test('B. the scan is not empty — floors on files, references and external names', () => {
		// MEASURED 2026-08-30: 18 files (10 shell scripts, 6 .service, 2 .timer),
		// 573 raw references over 138 distinct names, of which 8 are read from the
		// environment rather than assigned locally. The floors sit below those so
		// ordinary edits do not trip them, and far above zero so an extractor that
		// stopped matching cannot pass.
		expect(DEPLOY_FILES.length).toBeGreaterThanOrEqual(15);
		expect(DEPLOY_FILES.filter((f) => f.endsWith('.sh')).length).toBeGreaterThanOrEqual(8);
		expect(DEPLOY_FILES.filter((f) => f.endsWith('.service')).length).toBeGreaterThanOrEqual(4);
		expect(SCANS.flatMap((s) => s.references).length).toBeGreaterThanOrEqual(300);
		expect(new Set(EXTERNAL_REFERENCES.map((r) => r.name)).size).toBeGreaterThanOrEqual(6);
	});

	test('C. R1 — an undefaulted read must be installer-written or unit-provided', () => {
		const offenders = SCANS.flatMap((s) => unguardedUnprovided(s).map((n) => `${s.file}: $${n}`));
		expect(offenders).toEqual([]);
	});

	test('C. R1 positive control — the historical ExecStart is caught, the fixed one is not', () => {
		// The line deploy/dedalo-backup.service shipped before P0-13. Every one of
		// these five names expanded to the empty string on a wizard-installed host
		// of the time — and still does on any .env carrying only the alias
		// spelling, which is why an alias-bearing name is never "provided".
		const broken = scan(
			[
				'[Service]',
				'EnvironmentFile=/opt/dedalo/private/.env',
				'ExecStart=/usr/bin/pg_dump -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -Fc -f /backup/db.backup',
				'ExecStart=/usr/bin/rsync -a --delete $MEDIA_PATH/ /backup/media/',
			].join('\n'),
			'broken.service',
			true,
		);
		expect(unguardedUnprovided(broken)).toEqual([
			'DB_HOST',
			'DB_NAME',
			'DB_PORT',
			'DB_USER',
			'MEDIA_PATH',
		]);
		// The installer DOES write these canonical names now — the rule still
		// refuses them, because a host's .env may hold only DEDALO_MEDIA_PATH /
		// DEDALO_*_CONN. Writing the canonical name is not proof of presence.
		expect(INSTALLER_WRITTEN.has('MEDIA_PATH')).toBe(true);
		expect(INSTALLER_WRITTEN.has('DB_HOST')).toBe(true);

		// The fixed form: the key NAMES go to the resolver as argv (both spellings
		// resolved in shell), and a single-spelling installer-written variable is
		// still accepted — otherwise the rule would just be "no variables at all".
		const fixed = scan(
			[
				'[Service]',
				'ExecStart=/opt/dedalo/deploy/dedalo-db-backup.sh --db-key DB_NAME --host-key DB_HOST --user-key DB_USER',
				'ExecStartPost=/usr/bin/test -S $SERVER_UNIX_SOCKET',
			].join('\n'),
			'fixed.service',
			true,
		);
		expect(unguardedUnprovided(fixed)).toEqual([]);
	});

	test('D. R2 — every reference is documented somewhere or exempted with a reason', () => {
		const undeclared = new Map<string, string>();
		for (const r of EXTERNAL_REFERENCES) {
			if (documented(r.name) || EXTERNAL_VARIABLES.has(r.name)) continue;
			if (!undeclared.has(r.name)) undeclared.set(r.name, `${r.file}:${r.line}`);
		}
		expect([...undeclared].map(([n, at]) => `$${n} (${at})`)).toEqual([]);
	});

	test('E. the exemption list is reasoned and stale-free', () => {
		const referenced = new Set(EXTERNAL_REFERENCES.map((r) => r.name));
		const stale = [...EXTERNAL_VARIABLES.keys()].filter((n) => !referenced.has(n));
		// An exemption nothing reads any more is a licence left lying around;
		// removing the reference must remove the entry, which is what keeps this
		// list shrink-only.
		expect(stale).toEqual([]);
		for (const [name, reason] of EXTERNAL_VARIABLES) {
			expect(reason.length, `${name} needs a substantive reason`).toBeGreaterThan(60);
		}
		// Small, and it stays small: raise this only with the entry, never ahead of it.
		expect(EXTERNAL_VARIABLES.size).toBeLessThanOrEqual(6);
	});

	test('F. the provided sets really parsed something', () => {
		// A parser that returns {} would make legs C/D fail loudly rather than
		// silently — but a parser that returns everything would not. Pin both the
		// floor and a key each source MUST and MUST NOT carry.
		expect(INSTALLER_WRITTEN.size).toBeGreaterThanOrEqual(30);
		// The installer writes the canonical spelling and never the alias one; and
		// because PHP_KEY_ALIASES does not exist inside systemd, both spellings stay
		// alias-bearing (never "provided" to a raw `$VAR` read).
		expect(INSTALLER_WRITTEN.has('DB_PASSWORD')).toBe(true);
		expect(INSTALLER_WRITTEN.has('DEDALO_PASSWORD_CONN')).toBe(false);
		expect(ALIAS_BEARING.has('DB_PASSWORD')).toBe(true);
		expect(ALIAS_BEARING.has('DEDALO_PASSWORD_CONN')).toBe(true);
		expect(INSTALLER_WRITTEN.has('SERVER_UNIX_SOCKET')).toBe(true);
		expect(ALIAS_BEARING.has('SERVER_UNIX_SOCKET')).toBe(false);
		expect(CATALOG_KEYS.has('DB_PASSWORD')).toBe(true);
		expect(CATALOG_KEYS.size).toBeGreaterThanOrEqual(100);
		expect(BOOTSTRAP_KEYS.has('DEDALO_PRIVATE_DIR')).toBe(true);
		expect(UNIT_PROVIDED.has('DEDALO_BACKUP_STATE_DIR')).toBe(true);
	});

	test('G. the retention scan is not empty — floors on files, deleting rsyncs and tree-backup invocations', () => {
		// MEASURED 2026-09-03: 23 files under deploy/ + 2 compose stacks; 2
		// deleting rsync sites (the tree-backup script's generation build and the
		// site-builder mirror); 6 tree-backup invocations (2 in the systemd unit,
		// 2 per compose stack).
		expect(RETENTION_FILES.length).toBeGreaterThanOrEqual(20);
		expect(RETENTION_FILES.filter((f) => /^docker-compose/.test(f)).length).toBeGreaterThanOrEqual(
			2,
		);
		expect(RETENTION_SCANS.flatMap((s) => s.deletingRsyncs).length).toBeGreaterThanOrEqual(2);
		expect(RETENTION_SCANS.flatMap((s) => s.treeBackups).length).toBeGreaterThanOrEqual(5);
		expect(RETENTION_SCANS.filter((s) => s.generational).map((s) => s.file)).toEqual([
			'deploy/dedalo-tree-backup.sh',
		]);
	});

	test('G. a deleting rsync builds a --link-dest generation under a retention, or is an enumerated exemption', () => {
		const offenders = RETENTION_SCANS.flatMap((s) =>
			BARE_MIRROR_EXEMPTIONS.has(s.file) ? [] : bareMirrors(s).map((at) => `${s.file}:${at}`),
		);
		expect(offenders).toEqual([]);
	});

	test('G. every dedalo-tree-backup.sh invocation states its retention (--keep)', () => {
		const offenders = RETENTION_SCANS.flatMap((s) =>
			keeplessTreeBackups(s).map((at) => `${s.file}:${at}`),
		);
		expect(offenders).toEqual([]);
	});

	test('G. positive control — the historical --delete mirror is a bare mirror, the generation build is not', () => {
		// The media step deploy/dedalo-backup.service shipped before LIFE-05.
		const historical = scanRetention(
			[
				'[Service]',
				'ExecStart=/usr/bin/rsync -a --delete $MEDIA_PATH/ /backup/media/',
				'ExecStart=/usr/bin/dedalo-tree-backup.sh --label media --source-key MEDIA_PATH --dest /backup/media',
			].join('\n'),
		);
		expect(bareMirrors(historical)).toEqual([2]);
		expect(keeplessTreeBackups(historical)).toEqual([3]);
		// The generation shape: --delete assembled by `set --`, --link-dest, KEEP —
		// and a continuation-split compose invocation that DOES carry --keep.
		const generational = scanRetention(
			[
				'KEEP=14',
				'set -- --archive --delete --delete-excluded',
				'set -- "$@" --link-dest="$DEST/$previous"',
				'rsync "$@" "$SOURCE/" "$WORK/"',
				'"$$D/dedalo-tree-backup.sh" --label media --source-key MEDIA_PATH \\',
				'  --dest /backups/media --keep "$$DEDALO_BACKUP_KEEP"',
				'# rsync -a --delete in a comment is not a mirror',
				'command -v rsync >/dev/null || fail "rsync is not installed"',
			].join('\n'),
		);
		expect(generational.deletingRsyncs.map((r) => r.at)).toEqual([4]);
		expect(generational.treeBackups.length).toBe(1);
		expect(bareMirrors(generational)).toEqual([]);
		expect(keeplessTreeBackups(generational)).toEqual([]);
	});

	test('G. the bare-mirror exemption list is reasoned, stale-free and small', () => {
		for (const [file, reason] of BARE_MIRROR_EXEMPTIONS) {
			const scanned = RETENTION_SCANS.find((s) => s.file === file);
			// An exemption for a file that no longer mirrors is a licence left lying around.
			expect(scanned !== undefined && bareMirrors(scanned).length > 0, `${file} is stale`).toBe(
				true,
			);
			expect(reason.length, `${file} needs a substantive reason`).toBeGreaterThan(80);
		}
		expect(BARE_MIRROR_EXEMPTIONS.size).toBeLessThanOrEqual(1);
	});
});
