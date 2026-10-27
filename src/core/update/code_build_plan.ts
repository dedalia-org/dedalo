/**
 * PURE planning half of the server-side release build (see `code_build.ts`).
 * Every gate that can refuse a build BEFORE any filesystem or git side effect
 * lives here, in the order the wire contract fixes: code-server flag → dirs →
 * version → ref → path confinement. Moving a gate changes the error a caller
 * sees, so the order is part of the contract, not an implementation detail.
 *
 * Leaf module: imports only the version parser and the pure release-identity
 * grammar — no config, no fs, no spawn.
 */

import { join, resolve, sep } from 'node:path';
import {
	compareReleaseIdentities,
	parseReleaseVersion,
	releaseVersionOfTag,
} from './release_identity.ts';
import { parseVersionString } from './version.ts';

/**
 * The version triple a tree's `src/core/update/version.ts` DECLARES ('7.0.1'),
 * or null when the source does not carry one.
 *
 * THE RELEASE'S NAME MUST COME FROM ITS BYTES. Until 2026-08-24 the build took
 * the artifact's version from the RUNNING MASTER PROCESS (`DEDALO_VERSION`)
 * while the bytes came from an independently chosen git ref, and nothing
 * compared the two — so `<v>.zip` could hold a tree that is not version v. The
 * reachable trigger is not an exotic one: bump the version on `master`, forget
 * to restart the master, and the panel keeps naming artifacts after the OLD
 * version. That is how a 7.0.0 master, asked to publish, produced a `7.0.0.zip`
 * that `assertLinearUpgrade` refuses as a same-version install — a release
 * nobody can install, built by pressing the button that exists to publish.
 *
 * Whitespace- and linebreak-insensitive: the committed source spreads the
 * triple over three lines, a probe's bump writes it on one.
 */
export function parseDeclaredTriple(versionTsSource: string): string | null {
	const matched = /Object\.freeze\(\[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,?\s*\]\)/.exec(
		versionTsSource,
	);
	return matched === null ? null : `${matched[1]}.${matched[2]}.${matched[3]}`;
}

/**
 * The NEXT dev triple a ref declares (version.ts DEDALO_NEXT_DEV_TRIPLE): the
 * release an untagged build precedes. It names the developer ARCHIVE
 * (`<next>-dev.zip`), the identity the built tree calls itself — NOT the data
 * triple, which the untagged build shares with the last released data version.
 */
export function parseDeclaredNextDevTriple(versionTsSource: string): string | null {
	const matched =
		/DEDALO_NEXT_DEV_TRIPLE[\s\S]*?Object\.freeze\(\[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,?\s*\]\)/.exec(
			versionTsSource,
		);
	return matched === null ? null : `${matched[1]}.${matched[2]}.${matched[3]}`;
}

/** Where the declared triple lives inside any Dédalo tree. */
export const VERSION_TS_PATH = 'src/core/update/version.ts';

/**
 * Where the release stamp's placeholder lives inside any Dédalo tree — the
 * value of build_stamp.ts BUILD_INFO_PATH, restated here because this planner
 * is pure and build_stamp.ts reads the running tree on import (equality gated
 * in code_build_native).
 */
export const BUILD_INFO_TREE_PATH = 'src/core/update/build_info.txt';

/**
 * Can a tag's archive NAME ITSELF? True when the tree's committed
 * build_info.txt placeholder (as `git show <tag>:<path>` prints it) carries the
 * `%(describe…)` field. The pre-2026-10-15 two-field placeholder
 * (`$Format:%H %cI$` — every prerelease tag cut before the stamp, v7.0.0-beta.6
 * included) expands to a stamp an installed engine reads as `X.Y.Z.dev`, so a
 * prerelease from such a tree is never offered as buildable (design §2.8.5).
 */
export function placeholderNamesItsTag(placeholder: string): boolean {
	return /%\(describe[:)]/.test(placeholder.split(/\r?\n/)[0] ?? '');
}

/**
 * A safe git ref: refs/heads/… or a plain branch/tag name. No shell metachars,
 * and — CMD-05 (2026-07-28 audit) — NO leading `-`: the ref is the last argv
 * element of `git archive … -o <file> <ref>`, so a `-`-leading value like
 * `--output=/evil` would be parsed by git as an OPTION (output redirect), not a
 * ref. Git itself forbids refs starting with `-`, so this only rejects attacks.
 *
 * NOTE (by design): a traversal-shaped ref such as `refs/heads/../../x` PASSES
 * this allowlist. That is intentional and safe — the ref is only ever handed to
 * `git archive` as a ref to resolve, NEVER joined into a path. The output path
 * is built solely from the validated version triple and confined below. Do not
 * "harden" the regex against `..`: it would reject legitimate refs and buys
 * nothing.
 */
const GIT_REF_RE = /^[A-Za-z0-9._/][A-Za-z0-9._/-]{0,199}$/;

/**
 * The ONE ref allowlist. Exported because `code_build.ts` must validate a ref
 * BEFORE the pre-plan `git show <ref>:…` read that derives the release's
 * version — a second copy of the regex there would be exactly the duplication
 * the "refusal gates are GONE from code_build.ts" gate exists to prevent.
 */
export function isSafeGitRef(ref: string): boolean {
	return GIT_REF_RE.test(ref);
}

/**
 * THE CHANNELS' REFS (policy 2026-09-29; prerelease publication 2026-10-15,
 * RELEASE_IDENTITY_DESIGN §2.8 — owner Q1: a prerelease tag IS a release).
 *
 * - RELEASE (`master` channel on the wire, `<v>.zip`, advertised): a STABLE
 *   RELEASE TAG `vX.Y.Z` — a version that was cut and tagged in git, never a
 *   moving branch tip. Only a tag whose tree IS this engine is publishable
 *   (see {@link newestPublishableTag}) — the PHP-era `v6.x` tags live in the
 *   same repository and must never surface as a v7 release.
 * - PRERELEASE (`<X.Y.Z-beta.N>.zip`): a canonical prerelease tag
 *   `vX.Y.Z-(alpha|beta|rc).N`, built exactly like a release (immutable,
 *   sha-verified, its archive calling itself the tag) — the newest one ABOVE
 *   the newest stable release ({@link prereleaseTagAbove}); a beta a stable
 *   release has already superseded is never built.
 * - DEVELOPER (`dev` channel, `<v>-dev.zip`, advertised only on request): the
 *   tip of branch `master` — the latest integrated code, before its release.
 *
 * Until 2026-09-29 the release channel was the tip of `master` and the dev
 * channel whatever other branch the code server had checked out (`v7`), which
 * made "released" mean "whatever master held when someone pressed the button".
 * The wire token `master` for the release channel is kept: installed consumers
 * already send it (`get_code_update_info` `options.channel`).
 */
export const DEV_REF = 'master';

/**
 * The release IDENTITY a release-tag ref names — `7.0.1` for `v7.0.1` /
 * `refs/tags/v7.0.1`, `7.0.1-beta.2` for `v7.0.1-beta.2` — or null when the
 * ref is not one. THE shared grammar (release_identity.ts RELEASE_VERSION_RE:
 * canonical numbers, `alpha|beta|rc` only): `v07.0.2` would normalise to
 * `7.0.2` and be re-qualified as a `refs/tags/v7.0.2` that does not exist, so
 * a non-canonical name is no release tag at all. `refs/heads/v7.0.1` is a
 * branch, never a tag.
 */
export function releaseTagIdentity(ref: string): string | null {
	const name = ref.startsWith('refs/tags/') ? ref.slice('refs/tags/'.length) : ref;
	return releaseVersionOfTag(name);
}

/**
 * The version a STABLE release-tag ref names ('7.0.1'), or null — for a
 * prerelease tag too: the RELEASE channel (`<v>.zip`, the image pipeline's
 * stable plan) only ever publishes a stable tag. For a tag of either kind use
 * {@link releaseTagIdentity}.
 */
export function releaseTagVersion(ref: string): string | null {
	const identity = releaseTagIdentity(ref);
	return identity !== null && parseReleaseVersion(identity)?.prerelease === null ? identity : null;
}

/** The DATA triple ('7.0.1') a release tag of either kind names, or null. */
function releaseTagTriple(ref: string): string | null {
	const identity = releaseTagIdentity(ref);
	return identity === null ? null : (parseReleaseVersion(identity)?.triple.join('.') ?? null);
}

/**
 * The fully-qualified ref of a release tag (a stable or prerelease identity) —
 * a branch that happens to be named `v7.0.1` never resolves in its place.
 */
export function qualifiedReleaseTag(identity: string): string {
	return `refs/tags/v${identity}`;
}

/** Which release tags a listing asks for. */
export type ReleaseTagKind = 'stable' | 'prerelease' | 'any';

/**
 * The release tags among `tags` (short names, as `git tag --list` prints
 * them), NEWEST FIRST by semver precedence (release_identity.ts
 * compareReleaseIdentities: `7.0.0-beta.6 < 7.0.0-rc.1 < 7.0.0 < 7.0.1`) —
 * never by lexical order, where `v7.10.0` sorts before `v7.9.0` and
 * `v7.0.0-beta.10` before `v7.0.0-beta.9`. `kind` narrows the list to stable
 * or prerelease tags; a name outside the shared grammar is never listed.
 */
export function releaseTagsNewestFirst(
	tags: readonly string[],
	kind: ReleaseTagKind = 'any',
): string[] {
	const found: { tag: string; identity: string }[] = [];
	for (const raw of tags) {
		const tag = raw.trim();
		const identity = releaseTagIdentity(tag);
		if (identity === null) continue;
		const prerelease = parseReleaseVersion(identity)?.prerelease !== null;
		if (kind === 'any' || (kind === 'prerelease') === prerelease) found.push({ tag, identity });
	}
	return found
		.sort((a, b) => compareReleaseIdentities(b.identity, a.identity))
		.map((entry) => entry.tag);
}

/**
 * The newest PUBLISHABLE tag of `kind` (stable by default): the newest one
 * whose tree is this engine — it carries {@link VERSION_TS_PATH}
 * (`isEngineTree`, asked of the object store by the caller). Null when there
 * is none.
 *
 * WHY THE TREE AND NOT A VERSION FLOOR: the repository also holds the PHP
 * engine's history, `v6.9.7` included — the newest stable tag of this repo
 * while v7 is still in beta. A hard-coded "major >= 7" would have to move with
 * every major; the tree answers the real question (is this a release of THIS
 * engine?) and a PHP tree has no `version.ts` by construction.
 */
export function newestPublishableTag(
	tags: readonly string[],
	isEngineTree: (tag: string) => boolean,
	kind: Exclude<ReleaseTagKind, 'any'> = 'stable',
): string | null {
	for (const tag of releaseTagsNewestFirst(tags, kind)) {
		if (isEngineTree(tag)) return tag;
	}
	return null;
}

/**
 * The prerelease tag the *Build prerelease* action builds: `prerelease` (the
 * newest publishable prerelease tag) when it sorts ABOVE `stable` (the newest
 * publishable stable tag), else null. A beta below the newest release —
 * `v7.0.1-beta.2` once `v7.0.1` exists, or a `v7.0.0-rc.N` after `v7.0.1` —
 * is superseded history: building it would publish an archive no consumer is
 * ever walked to, so the action refuses instead (design §2.8 item 1).
 */
export function prereleaseTagAbove(
	prerelease: string | null,
	stable: string | null,
): string | null {
	const pre = prereleaseIdentityOf(prerelease);
	if (pre === null) return null;
	const top = stable === null ? null : releaseTagIdentity(stable);
	return top === null || compareReleaseIdentities(pre, top) > 0 ? prerelease : null;
}

/** The identity a PRERELEASE tag names, or null (no tag, a stable tag, no release tag at all). */
function prereleaseIdentityOf(tag: string | null): string | null {
	const identity = tag === null ? null : releaseTagIdentity(tag);
	return (parseReleaseVersion(identity ?? '')?.prerelease ?? null) !== null ? identity : null;
}

/** Config slice the planner needs (the `config.update` shape). */
export interface CodeBuildConfig {
	isCodeServer: boolean;
	codeServerGitDir: string | undefined;
	codeFilesDir: string | undefined;
}

/** Either everything the build step needs, or the refusal to report verbatim. */
export type CodeBuildPlan =
	| {
			ok: true;
			gitDir: string;
			ref: string;
			versionString: string;
			/**
			 * The release identity a TAG build's archive must call itself (the
			 * tag's: `7.0.1`, `7.0.1-beta.2`) — the build reads it back out of
			 * the archive and refuses a disagreement (code_build.ts). Null for a
			 * developer build: a branch tip names no release.
			 */
			identity: string | null;
			targetDir: string;
			filePath: string;
	  }
	| { ok: false; msg: string; error: string };

/**
 * `''` IS UNSET (readEnv returns an empty value verbatim, and config stores it
 * raw). Treating it as configured made `join('', '7', '7.0')` a RELATIVE path,
 * so a build mkdir'd its release tree under the process cwd — inside the very
 * code tree the updater renames away. Same rule as the boot provisioner
 * (code_files_dir.ts).
 */
function resolveCodeBuildDirs(cfg: CodeBuildConfig): { gitDir: string; filesDir: string } | null {
	const gitDir = cfg.codeServerGitDir;
	const filesDir = cfg.codeFilesDir;
	if (gitDir === undefined || gitDir === '' || filesDir === undefined || filesDir === '')
		return null;
	return { gitDir, filesDir };
}

/**
 * A release version is exactly three NON-NEGATIVE INTEGERS. Load-bearing
 * beyond validation: the path confinement below derives its safety from this
 * guard, because it proves every interpolated path segment is `[0-9]+`.
 */
function isReleaseVersionTriple(triple: number[]): boolean {
	return triple.length === 3 && triple.every((n) => Number.isInteger(n) && n >= 0);
}

/** A refusal: `msg` is the operator sentence, `error` the machine detail. */
function refused(msg: string, error: string): CodeBuildPlan {
	return { ok: false, msg, error };
}

/** The first two gates (code server → dirs): the configured dirs, or the refusal. */
function configGateOf(cfg: CodeBuildConfig): { gitDir: string; filesDir: string } | CodeBuildPlan {
	if (cfg.isCodeServer !== true) {
		return refused('Error. This instance is not a code server', 'not a code server');
	}
	return (
		resolveCodeBuildDirs(cfg) ??
		refused(
			'Error. Define DEDALO_CODE_SERVER_GIT_DIR and DEDALO_CODE_FILES_DIR to build releases',
			'code build dirs unconfigured',
		)
	);
}

/**
 * The ref gates (allowlist → tag/version agreement), or null when the ref passes.
 *
 * A RELEASE TAG NAMES ITS VERSION TWICE — in the tag and in its own version.ts
 * — and the two must agree: `v7.0.2` cut on a commit still declaring 7.0.1
 * would publish a `7.0.1.zip` under a tag nobody will look for, or (named after
 * the tag) a `7.0.2.zip` whose tree reports 7.0.1. A PRERELEASE tag names its
 * DATA triple the same way (`v7.0.2-beta.1` → 7.0.2) and is held to it alike.
 */
function refRefusalOf(ref: string, versionString: string): CodeBuildPlan | null {
	if (!GIT_REF_RE.test(ref)) return refused('Error. Invalid git ref', `invalid ref: ${ref}`);
	const tagged = releaseTagTriple(ref);
	if (tagged === null || tagged === versionString) return null;
	return refused(
		`Error. Tag '${ref}' names version ${tagged}, but its version.ts declares ${versionString}`,
		`tag/version mismatch: ${ref} vs ${versionString}`,
	);
}

/**
 * Decide whether a release build may run and where its artifact goes.
 * Pure: no I/O, no mutation of the inputs. Gate order (the wire contract):
 * code server → dirs → version → ref → tag/version → confinement.
 */
export function planCodeBuild(
	options: { version: string; ref?: string; devVersion?: string },
	cfg: CodeBuildConfig,
): CodeBuildPlan {
	const dirs = configGateOf(cfg);
	if ('ok' in dirs) return dirs;
	const { gitDir, filesDir } = dirs;
	const triple = parseVersionString(options.version);
	if (!isReleaseVersionTriple(triple)) {
		return refused('Error. Invalid version number', `invalid version: ${options.version}`);
	}
	const versionString = triple.join('.');
	// No ref: the version's own release tag — "build release 7.0.1" means its tag.
	const ref = options.ref ?? qualifiedReleaseTag(versionString);
	const refRefusal = refRefusalOf(ref, versionString);
	if (refRefusal !== null) return refRefusal;
	const identity = releaseTagIdentity(ref);
	const archiveTriple = archiveTripleOf(triple, identity, options.devVersion);
	const targetDir = join(
		filesDir,
		String(archiveTriple[0]),
		`${archiveTriple[0]}.${archiveTriple[1]}`,
	);
	const filePath = join(targetDir, releaseFileName(archiveTriple.join('.'), identity));
	// LEDGERED UNREACHABLE BRANCH — reason: the version guard above proves the
	// triple is three NON-NEGATIVE INTEGERS, so every DIRECTORY segment
	// interpolated here is `[0-9]+`; the file name is the triple plus `-dev`, or
	// an identity that matched RELEASE_VERSION_RE (`[0-9]+` + `.` + an optional
	// `-(alpha|beta|rc).[0-9]+` — no separator, no `..`). No traversal or
	// absolute segment can be constructed and `filePath` is always under
	// `filesDir`. Kept as a defence-in-depth backstop
	// in case the version guard is ever loosened; deliberately NOT covered by a
	// test (no input can reach it).
	if (!resolve(filePath).startsWith(`${resolve(filesDir)}${sep}`)) {
		return refused('Error. Unconfined release path', 'unconfined release path');
	}
	return { ok: true, gitDir, ref, versionString, identity, targetDir, filePath };
}

/**
 * The triple an archive is named after: a tag names its own release; an untagged
 * (developer) build is named after the NEXT release it precedes (`devVersion`,
 * the ref's DEDALO_NEXT_DEV_TRIPLE), falling back to the data triple when the
 * ref declares none.
 */
function archiveTripleOf(
	triple: readonly number[],
	identity: string | null,
	devVersion: string | undefined,
): number[] {
	if (identity !== null || devVersion === undefined) return [...triple];
	return parseVersionString(devVersion);
}

/**
 * THE CHANNEL IS IN THE FILE NAME (computed after every refusal gate — the
 * gate order in planCodeBuild is the wire contract). Only a RELEASE TAG build
 * claims an identity name — `<X.Y.Z>.zip` for a stable tag (what
 * code_manifest.ts advertises), `<X.Y.Z-beta.N>.zip` for a prerelease tag
 * (RELEASE_IDENTITY_DESIGN §2.8 item 1), both under `<X>/<X.Y>/`. Any other
 * ref — `master` included, which is the developer channel — gets the fixed
 * `-dev` suffix, so a branch build can never OVERWRITE a release of the same
 * version. Dev zips are advertised only to a consumer that asked for them on a
 * master that opted in (code_manifest.ts). No ref bytes reach the path: the
 * identity is the shared grammar's (canonical numbers, a closed label set).
 */
function releaseFileName(versionString: string, identity: string | null): string {
	return identity !== null ? `${identity}.zip` : `${versionString}-dev.zip`;
}
