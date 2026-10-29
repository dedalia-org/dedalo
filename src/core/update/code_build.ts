/**
 * Server-side release BUILD (UPDATE_PROCESS Phase 4 — PHP update_code::
 * build_version_from_git_master). Archives a git ref of the code-server's
 * checkout into a `<version>.zip` release with the `dedalo_code/` prefix the
 * installer expects, under DEDALO_CODE_FILES_DIR/<major>/<major.minor>/ — or a
 * prerelease `<X.Y.Z-beta.N>.zip` beside it (RELEASE_IDENTITY_DESIGN §2.8).
 *
 * A TAG BUILD IS A RELEASE, AND A RELEASE IS FIXED BYTES (owner Q1):
 *  - IMMUTABLE: an identity already published (`.zip` + `.sha256`) is never
 *    rebuilt — a digest a consumer verified, or a bug report quoted, must keep
 *    naming the same bytes. The archive is written beside its final name and
 *    claimed with a no-overwrite link, so two racing builds cannot both win;
 *  - SELF-NAMING: the archive's own expanded build_info.txt is read back; an
 *    archive whose stamp does not name the tag — so an installed engine would
 *    not call itself the release (a LIGHTWEIGHT tag: `%(describe)` ignores
 *    those) — is refused before it is published.
 *
 * SECURITY: only runs when IS_A_CODE_SERVER is set + the ownership gate is
 * open. The one injection surface is the ref/branch name — validated against
 * a strict git-ref allowlist and passed as a Bun.spawn argv element (never a
 * shell). Output paths are confined under the code-files dir. A sha256 of the
 * archive is emitted next to it (`<file>.sha256`) so the download side can
 * verify integrity — the checksum PHP never produced (WC-024).
 */

import { createHash } from 'node:crypto';
import { existsSync, linkSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { config } from '../../config/config.ts';
import { envSnapshot } from '../../config/env.ts';
import { DedaloError, ok } from '../errors/index.ts';
import type { ApiEnvelope } from '../errors/schema.ts';
import { currentRequestContext } from '../security/request_context.ts';
import {
	BUILD_INFO_TREE_PATH,
	DEV_REF,
	isSafeGitRef,
	parseDeclaredReleaseTriple,
	placeholderNamesItsTag,
	planCodeBuild,
	prereleaseTagAbove,
	qualifiedReleaseTag,
	type ReleaseTagKind,
	releaseTagIdentity,
	releaseTagsNewestFirst,
	releaseTagVersion,
	VERSION_TS_PATH,
} from './code_build_plan.ts';
import { ensureCodeFilesDir } from './code_files_dir.ts';
import { refuseUpdate } from './refuse.ts';
import {
	gitDescribeSupportFault,
	MIN_GIT_FOR_DESCRIBE,
	parseBuildInfo,
	releaseVersionOfTag,
} from './release_identity.ts';

/** The channel a build is asked for (the serve_code panel's buttons). */
export type CodeBuildChannel = 'master' | 'prerelease' | 'dev';

/** build_info.txt inside a release archive (`--prefix=dedalo_code/` + the tree path). */
const ARCHIVED_BUILD_INFO = `dedalo_code/${BUILD_INFO_TREE_PATH}`;

/**
 * The build's answer IS the wire body (the update_code widget returns it
 * verbatim), so it is ENVELOPE v2: `data` is the built release
 * ({file_path, sha256}) and `msg` rides as an extension key, the way the
 * maintenance client reads it. Every refusal THROWS (./refuse.ts).
 */
export type CodeBuildResponse = ApiEnvelope;

/** The current RQO's id (the widget dispatcher opens the scope), or '' outside a request. */
function currentRequestId(): string {
	return currentRequestContext()?.requestId ?? '';
}

/**
 * The version a git REF declares, read straight out of the object store
 * (`git show <ref>:src/core/update/version.ts`) — never the working tree, and
 * never the running process. Null when the ref or the file cannot be read.
 */
async function declaredVersionOfRef(
	gitDir: string | undefined,
	ref: string,
): Promise<string | null> {
	if (gitDir === undefined || gitDir === '') return null;
	if (!isSafeGitRef(ref)) return null;
	const source = await gitShow(gitDir, `${ref}:${VERSION_TS_PATH}`);
	return source === null ? null : parseDeclaredReleaseTriple(source);
}

/** The next dev triple a ref declares, or null when it cannot be read. */
async function declaredNextDevOfRef(
	gitDir: string | undefined,
	ref: string,
): Promise<string | undefined> {
	if (gitDir === undefined || gitDir === '' || !isSafeGitRef(ref)) return undefined;
	const source = await gitShow(gitDir, `${ref}:${VERSION_TS_PATH}`);
	return source === null ? undefined : (parseDeclaredReleaseTriple(source) ?? undefined);
}

/**
 * The release tags (the shared grammar, `v7.0.0`, `v7.0.0-beta.6`) that point AT
 * the commit `ref` names — lightweight and annotated alike — or null when git
 * cannot answer (fail closed: no answer is no evidence the commit is untagged).
 */
async function releaseTagsAtRef(gitDir: string, ref: string): Promise<string[] | null> {
	const child = Bun.spawn(['git', '-C', gitDir, 'tag', '--points-at', ref, '--list', 'v*'], {
		stdout: 'pipe',
		stderr: 'ignore',
		env: envSnapshot() as Record<string, string>,
	});
	const [exitCode, listing] = await Promise.all([child.exited, new Response(child.stdout).text()]);
	if (exitCode !== 0) return null;
	return listing
		.split('\n')
		.map((line) => line.trim())
		.filter((tag) => releaseVersionOfTag(tag) !== null);
}

/**
 * A DEVELOPER build (channel `dev`, or a branch ref) names a NIGHTLY, and a
 * nightly is an UNTAGGED commit (VERSIONING_SPEC D3, option a): a commit that
 * carries a release or beta tag is that release, named by its tag. Refused
 * here — before the planner, the release dir or any archive — with the tag
 * named, however the ref was given (an explicit tag ref on the dev channel
 * included). A tag ref on the release/prerelease channels is never a nightly
 * and passes untouched.
 */
async function refuseUnlessNightlyCommit(
	gitDir: string,
	ref: string,
	devChannel: boolean,
): Promise<void> {
	if (!devChannel && releaseTagIdentity(ref) !== null) return;
	// a ref that names no commit has no tags to read: git archive refuses it with
	// its own sentence (the bad-ref contract), before any byte is written
	if (!(await gitSucceeds(gitDir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]))) return;
	const tags = await releaseTagsAtRef(gitDir, ref);
	if (tags === null) {
		const sentence = `Error. Could not read the tags of '${ref}', so it cannot be shown to be an untagged nightly. Nothing was built.`;
		throw new DedaloError('update.refused', { message: sentence, publicMessage: sentence });
	}
	if (tags.length === 0) return;
	const named = tags.join(', ');
	const sentence = `Error. '${ref}' is the tagged commit ${named}: a tagged commit is a release or beta, named by its tag, never a nightly (VERSIONING_SPEC D3). Build ${named} instead, or build an untagged commit.`;
	throw new DedaloError('update.refused', {
		message: `code build: ${ref} carries the tag(s) ${named} — refusing a developer build of a tagged commit`,
		publicMessage: sentence,
	});
}

/** `git show <object>` from the object store, or null when it cannot be read. */
async function gitShow(gitDir: string, object: string): Promise<string | null> {
	const child = Bun.spawn(['git', '-C', gitDir, 'show', object], {
		stdout: 'pipe',
		stderr: 'ignore',
		env: envSnapshot() as Record<string, string>,
	});
	const [exitCode, text] = await Promise.all([child.exited, new Response(child.stdout).text()]);
	return exitCode === 0 ? text : null;
}

/** Does `git -C <gitDir> <args>` succeed? (async: this runs on the request path) */
async function gitSucceeds(gitDir: string, args: string[]): Promise<boolean> {
	const child = Bun.spawn(['git', '-C', gitDir, ...args], {
		stdout: 'ignore',
		stderr: 'ignore',
		env: envSnapshot() as Record<string, string>,
	});
	return (await child.exited) === 0;
}

/** The planner's config slice, from the live config. */
function buildConfig() {
	return {
		isCodeServer: config.update.isCodeServer,
		codeServerGitDir: config.update.codeServerGitDir,
		codeFilesDir: config.update.codeFilesDir,
	};
}

/**
 * THE PLANNER'S FIRST GATES, BEFORE ANY REF IS RESOLVED. Resolving a ref asks
 * git about tags, and those refusals ("no release tag") must never pre-empt the
 * wire-contract order (code server → dirs → …): a non-code-server is told it is
 * not one, not that it has no tag. The planner itself answers — with a
 * placeholder version/ref that pass their own gates — so the order has ONE
 * definition.
 */
function refuseUnlessBuildable(): void {
	const plan = planCodeBuild({ version: '0.0.0', ref: DEV_REF }, buildConfig());
	if (plan.ok !== true) {
		throw new DedaloError('update.refused', {
			message: `${plan.msg} (${plan.error})`,
			publicMessage: plan.msg,
		});
	}
}

/** The operator sentence for "there is no release to publish". */
function noReleaseTagSentence(asked: string | null): string {
	return asked === null
		? 'Error. No release tag (vX.Y.Z) of this engine in the build checkout: a release is built from a stable tag (a prerelease tag is built with Build prerelease). Until one exists, use a developer build; otherwise tag the release commit (and fetch tags) before publishing.'
		: `Error. No release tag ${asked} in the build checkout. Tag the release commit (and fetch tags) before publishing.`;
}

/** The operator sentence for "there is no prerelease to publish". */
const NO_PRERELEASE_SENTENCE =
	'Error. No prerelease to build: a prerelease is built from the newest vX.Y.Z-(alpha|beta|rc).N tag of this engine that sorts ABOVE the newest release tag and whose tree carries the release-identity stamp, and the build checkout has none (a beta a stable release has superseded, or one cut before the stamp, is never built). Tag the prerelease commit (annotated, and fetch tags) before publishing.';

/** Every tag of the build checkout (short names), or [] when git cannot answer. */
async function listTags(gitDir: string | undefined): Promise<string[]> {
	if (gitDir === undefined || gitDir === '') return [];
	const child = Bun.spawn(['git', '-C', gitDir, 'tag', '--list', 'v*'], {
		stdout: 'pipe',
		stderr: 'ignore',
		env: envSnapshot() as Record<string, string>,
	});
	const [exitCode, listing] = await Promise.all([child.exited, new Response(child.stdout).text()]);
	return exitCode === 0 ? listing.split('\n').filter((line) => line.trim() !== '') : [];
}

/**
 * WHICH REF a build archives — resolved HERE, on the server, never taken as a
 * branch name from the client (the hardcoded 'v7' of the old dev button refused
 * on every server that did not carry that branch).
 *
 * - explicit `ref` (API callers, the drills): used as given, except that a bare
 *   release tag `vX.Y.Z` is qualified to `refs/tags/vX.Y.Z` so a same-named
 *   branch can never be archived in its place;
 * - `channel: 'dev'`: the tip of {@link DEV_REF};
 * - `channel: 'prerelease'`: the newest prerelease tag of this engine ABOVE
 *   the newest stable one (code_build_plan.ts prereleaseTagAbove), or the
 *   refusal — never an asked `version` (a triple names no single prerelease);
 * - `channel: 'master'` (the release channel, the default): the version's own
 *   tag when a `version` is asked (refused when that tag does not exist),
 *   otherwise the newest PUBLISHABLE release tag (code_build_plan.ts
 *   newestPublishableTag — stable, and a tree of this engine).
 */
async function resolveBuildRefOrRefuse(options: {
	version?: string;
	ref?: string;
	channel?: CodeBuildChannel;
}): Promise<string> {
	if (options.ref !== undefined) return qualifiedIfReleaseTag(options.ref);
	if (options.channel === 'dev') return DEV_REF;
	// refuseUnlessBuildable() ran first: the git dir is configured
	const gitDir = config.update.codeServerGitDir as string;
	if (options.channel === 'prerelease') return newestPrereleaseTagOrRefuse(gitDir);
	const asked = options.version === undefined ? null : releaseTagVersion(`v${options.version}`);
	return asked === null ? newestTagOrRefuse(gitDir) : askedTagOrRefuse(gitDir, asked);
}

/** An explicit ref, a bare release tag (stable or prerelease) qualified so a same-named branch never wins. */
function qualifiedIfReleaseTag(ref: string): string {
	const tagged = releaseTagIdentity(ref);
	return tagged === null ? ref : qualifiedReleaseTag(tagged);
}

/**
 * The ASKED version's tag — which must exist: otherwise the build would
 * provision the release dir and die in `git archive` with nothing naming the cause.
 */
async function askedTagOrRefuse(gitDir: string, version: string): Promise<string> {
	const tagRef = qualifiedReleaseTag(version);
	if (await gitSucceeds(gitDir, ['rev-parse', '--verify', '--quiet', `${tagRef}^{commit}`])) {
		return tagRef;
	}
	const sentence = noReleaseTagSentence(`v${version}`);
	throw new DedaloError('update.refused', { message: sentence, publicMessage: sentence });
}

/**
 * The newest PUBLISHABLE tag (the rule of code_build_plan.ts
 * newestPublishableTag: stable, and a tree of this engine — never a PHP-era
 * `v6.x`), or the no-release refusal.
 */
async function newestTagOrRefuse(gitDir: string): Promise<string> {
	const tag = await newestEngineTag(gitDir, await listTags(gitDir), 'stable');
	if (tag !== null) return `refs/tags/${tag}`;
	const sentence = noReleaseTagSentence(null);
	throw new DedaloError('update.refused', { message: sentence, publicMessage: sentence });
}

/**
 * The newest tag of `kind` whose tree is this engine (it carries
 * {@link VERSION_TS_PATH}), or null — code_build_plan.ts newestPublishableTag's
 * rule, asked of the object store one tag at a time and stopping at the first.
 */
async function newestEngineTag(
	gitDir: string,
	tags: readonly string[],
	kind: Exclude<ReleaseTagKind, 'any'>,
): Promise<string | null> {
	for (const tag of releaseTagsNewestFirst(tags, kind)) {
		if (!(await gitSucceeds(gitDir, ['cat-file', '-e', `refs/tags/${tag}:${VERSION_TS_PATH}`]))) {
			continue;
		}
		// A prerelease from a tree that predates the release-identity stamp could
		// only be refused at the read-back — so it is not a candidate at all, and
		// the panel (status.ts) never offers it (placeholderNamesItsTag).
		if (kind === 'prerelease' && !(await treeNamesItsTag(gitDir, tag))) continue;
		return tag;
	}
	return null;
}

/** Does `tag`'s committed build_info.txt carry the describe field (its archive can name itself)? */
async function treeNamesItsTag(gitDir: string, tag: string): Promise<boolean> {
	return placeholderNamesItsTag(
		(await gitShow(gitDir, `refs/tags/${tag}:${BUILD_INFO_TREE_PATH}`)) ?? '',
	);
}

/**
 * The prerelease the *Build prerelease* action builds: the newest prerelease
 * tag of this engine, when it sorts above the newest stable one — or the
 * refusal (code_build_plan.ts prereleaseTagAbove).
 */
async function newestPrereleaseTagOrRefuse(gitDir: string): Promise<string> {
	const tags = await listTags(gitDir);
	const tag = prereleaseTagAbove(
		await newestEngineTag(gitDir, tags, 'prerelease'),
		await newestEngineTag(gitDir, tags, 'stable'),
	);
	if (tag !== null) return `refs/tags/${tag}`;
	throw new DedaloError('update.refused', {
		message: NO_PRERELEASE_SENTENCE,
		publicMessage: NO_PRERELEASE_SENTENCE,
	});
}

/**
 * The version THIS release will be named after: the one the ref's own
 * `version.ts` declares. A caller-supplied `version` that disagrees is a
 * refusal, not an override — a release must be named after its own bytes — and
 * a ref whose version cannot be read at all cannot be named either.
 */
async function resolveReleaseVersionOrRefuse(
	ref: string,
	asked: string | undefined,
): Promise<string> {
	const declared = await declaredVersionOfRef(config.update.codeServerGitDir, ref);
	if (declared !== null && asked !== undefined && asked !== declared) {
		const sentence = `Error. The ref '${ref}' declares version ${declared}, but the build asked for ${asked} — a release must be named after its own bytes.`;
		throw new DedaloError('update.refused', { message: sentence, publicMessage: sentence });
	}
	const version = declared ?? asked;
	if (version === undefined) {
		const sentence = `Error. Could not read ${VERSION_TS_PATH} at ref '${ref}', so the release's own version is unknown and it cannot be named.`;
		throw new DedaloError('update.refused', { message: sentence, publicMessage: sentence });
	}
	return version;
}

/**
 * Refuse a build whose git cannot stamp the release tag into the archive.
 * build_info.txt's `%(describe:match=…,abbrev=…)` needs git >= MIN_GIT_FOR_DESCRIBE
 * (release_identity.ts, where the version is sourced): an older git leaves the
 * placeholder unexpanded, and every installation of that zip would call itself
 * `X.Y.Z.dev` instead of the release it is. Asked before anything is written.
 */
async function refuseUnlessGitStampsTags(gitDir: string): Promise<void> {
	const child = Bun.spawn(['git', '-C', gitDir, '--version'], {
		stdout: 'pipe',
		stderr: 'ignore',
		env: envSnapshot() as Record<string, string>,
	});
	const [exitCode, answer] = await Promise.all([child.exited, new Response(child.stdout).text()]);
	const fault = gitDescribeSupportFault(exitCode === 0 ? answer : '');
	if (fault === null) return;
	// The parsed fault goes to the LOG side; the wire gets the operator sentence.
	throw new DedaloError('update.refused', {
		message: `code build: ${fault}`,
		publicMessage: `Error. The code server's git is older than ${MIN_GIT_FOR_DESCRIBE}: its archive would not carry the release tag, so the release would call itself a developer build. Upgrade git on the code server, then build again.`,
	});
}

/** `git archive` into `filePath`, or a refusal. A zero-byte artifact is a failure. */
async function runGitArchiveOrRefuse(gitDir: string, ref: string, filePath: string): Promise<void> {
	// -C <gitDir> selects the repo; argv array, no shell.
	const child = Bun.spawn(
		['git', '-C', gitDir, 'archive', '--format=zip', '--prefix=dedalo_code/', '-o', filePath, ref],
		{
			stdout: 'ignore',
			stderr: 'pipe',
			env: envSnapshot() as Record<string, string>,
		},
	);
	const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
	if (exitCode === 0 && existsSync(filePath) && statSync(filePath).size > 0) return;
	// The git stderr is a LOG-side detail (paths, refs) — it stays out of the
	// wire sentence and travels on the thrown error's `message`.
	throw new DedaloError('update.failed', {
		message: `git archive failed: ${stderr.trim() || 'git archive produced no output'}`,
		publicMessage: 'Error. git archive failed',
	});
}

/** Is a release identity already PUBLISHED at `filePath` (its archive AND its sidecar)? */
function isPublished(filePath: string): boolean {
	return existsSync(filePath) && existsSync(`${filePath}.sha256`);
}

/** The immutability refusal, worded once for the pre-check and the race. */
function immutableRefusal(identity: string, filePath: string): DedaloError {
	const sentence = `Error. Release ${identity} is already published (${basename(filePath)} and its .sha256): a published release is immutable and is never rebuilt. To publish different bytes, tag a new release (the next prerelease or patch).`;
	return new DedaloError('update.refused', {
		message: `code build: ${filePath} exists — refusing to overwrite a published release`,
		publicMessage: sentence,
	});
}

/**
 * The archive's `build_info.txt`, as `unzip -p` prints it ('' when the
 * archive has none — that resolves to `.dev` and is refused like any other
 * mismatch, never skipped).
 */
async function archivedBuildInfo(zipPath: string): Promise<string> {
	const child = Bun.spawn(['unzip', '-p', zipPath, ARCHIVED_BUILD_INFO], {
		stdout: 'pipe',
		stderr: 'ignore',
		env: envSnapshot() as Record<string, string>,
	});
	const [exitCode, text] = await Promise.all([child.exited, new Response(child.stdout).text()]);
	return exitCode === 0 ? text : '';
}

/**
 * Refuse a tag build whose ARCHIVE would not call itself the tag, read back
 * from the bytes about to be published. The usual cause is a LIGHTWEIGHT tag:
 * `%(describe)` sees only annotated tags, so its archive expands to the
 * previous release (or nothing) and an installed engine calls it `X.Y.Z.dev`.
 *
 * WHY NOT resolveReleaseIdentity: this module is a DATA-version consumer
 * (release_identity_separation_tripwire) — it never asks the identity
 * resolver anything. It does not need to: for a tag build the planner has
 * already proved the tag's triple is the bytes' own version.ts, and on that
 * premise the resolver names the archive after the tag EXACTLY WHEN the
 * expanded describe field IS that tag (resolver rules 1/2; a legacy stamp, an
 * unexpanded placeholder, a past-the-tag describe all say `.dev`). So the
 * check is the stamp's own field against the tag. That the resolver agrees
 * with this verdict on a real archive is gated in code_build_native (GATE 13).
 */
async function refuseUnlessArchiveIsIdentity(zipPath: string, identity: string): Promise<void> {
	const stamp = parseBuildInfo(await archivedBuildInfo(zipPath));
	if (stamp.describe === `v${identity}`) return;
	throw new DedaloError('update.refused', {
		message: `code build: the archive of v${identity} carries ${stampDiagnosis(stamp)}`,
		publicMessage: `Error. The archive of tag v${identity} would not call itself ${identity}: ${archiveRefusalReason(stamp, identity)} Nothing was published.`,
	});
}

/** The stamp evidence, for the log line. */
function stampDiagnosis(stamp: ReturnType<typeof parseBuildInfo>): string {
	if (stamp.legacy) return 'a legacy two-field stamp (no describe field)';
	if (stamp.describe === null) return 'no expanded release stamp';
	return `the stamp describe '${stamp.describe || 'no release tag'}'`;
}

/**
 * WHY the archive does not name the tag — each cause has its own remedy, and
 * the ANNOTATED advice is only true of an expanded describe naming something
 * else: a tree that predates the describe field cannot be fixed by re-tagging.
 */
function archiveRefusalReason(stamp: ReturnType<typeof parseBuildInfo>, identity: string): string {
	if (stamp.legacy) {
		return `tag v${identity} predates the release-identity stamp (its build_info.txt has no describe field), so its archive cannot name itself; prereleases are published from the first tag cut after the stamp landed.`;
	}
	if (stamp.describe === null) {
		return `its build_info.txt was not expanded (the tree lacks the release stamp or its export-subst rule in .gitattributes).`;
	}
	return `its release stamp names ${stamp.describe || 'no release tag'}. A release tag must be ANNOTATED (git tag -a — an archive's release stamp ignores lightweight tags), and the build checkout must hold the tags.`;
}

/**
 * PUBLISH the finished archive under its final name. A tag build CLAIMS the
 * name with `link` — which fails when the name exists — so a published
 * identity is never overwritten, not even by a build racing this one. An
 * archive that was ALREADY there without its sidecar when this build started
 * (`orphan`: an interrupted build) was never installable — a consumer refuses
 * a release with no digest — and is replaced; one that appeared since is a
 * racing build's, and refuses this one. A developer build replaces its
 * `-dev.zip` (the channel tracks a branch tip). Exported for the race gate
 * (code_build_native): two sequential builds never reach the link — the
 * pre-check refuses the second — so only a direct call can prove the claim.
 */
export function publishArchive(
	staged: string,
	filePath: string,
	identity: string | null,
	orphan: boolean,
): void {
	if (identity === null) {
		renameSync(staged, filePath);
		return;
	}
	if (orphan) rmSync(filePath, { force: true });
	try {
		linkSync(staged, filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST')
			throw immutableRefusal(identity, filePath);
		throw error;
	}
}

/**
 * Provision the release directory, or refuse the build.
 *
 * THE SAME provisioner as the boot pass (code_files_dir.ts): the version
 * levels a build mints must not be looser than the root they sit in, and a
 * bare `mkdirSync(mode)` is umask-dependent. It never throws — the refusal
 * here is the build's, so the operator sentence stays the wire's.
 * `error` is a CREATION failure only — a refused chmod (`modeForced:false`)
 * leaves a usable directory and must NOT refuse a build that would
 * otherwise publish (a release dir on a CIFS/exFAT mount answers EPERM to
 * every chmod).
 */
function provisionReleaseDirOrRefuse(targetDir: string): void {
	const dirReport = ensureCodeFilesDir(targetDir);
	if (dirReport.error !== null || !dirReport.isDirectory) {
		refuseUpdate(
			'update.failed',
			'Error. Unable to create the release directory',
			dirReport.error ?? new Error(`${targetDir} exists but is not a directory`),
		);
	}
}

/**
 * `git archive --format=zip --prefix=dedalo_code/ <ref>` of the code-server
 * checkout into the release path. The ref comes from resolveBuildRefOrRefuse
 * (release channel = a `vX.Y.Z` tag, prerelease = a `vX.Y.Z-beta.N` tag, dev
 * channel = `master`); the version from that ref's own version.ts (`version`,
 * when given, is a claim checked against it).
 */
export async function buildVersionFromGit(options: {
	version?: string;
	ref?: string;
	channel?: CodeBuildChannel;
}): Promise<CodeBuildResponse> {
	// THE BYTES NAME THE RELEASE. Resolve the version the REF declares before
	// planning, so the artifact can never be named after the running process
	// (see parseDeclaredReleaseTriple). An explicit caller `version` is now a claim to
	// be CHECKED, not the source of the name.
	refuseUnlessBuildable();
	const ref = await resolveBuildRefOrRefuse(options);
	const version = await resolveReleaseVersionOrRefuse(ref, options.version);
	// A developer build is a nightly: refused when its commit carries a release tag.
	await refuseUnlessNightlyCommit(
		config.update.codeServerGitDir as string,
		ref,
		options.channel === 'dev',
	);
	// All refusal gates (code-server flag → dirs → version → ref → confinement)
	// and the release path live in the pure planner. The ref goes in EXPLICITLY:
	// the channel (and so the file name) is read off the ref by releaseFileName,
	// and it must be the very ref `git archive` below packages.
	const devVersion = await declaredNextDevOfRef(config.update.codeServerGitDir, ref);
	const plan = planCodeBuild({ version, ref, devVersion }, buildConfig());
	if (plan.ok !== true) {
		// `plan.msg` is the operator sentence; `plan.error` the machine detail —
		// the latter goes to the LOG side only (`message`), never to the wire.
		throw new DedaloError('update.refused', {
			message: `${plan.msg} (${plan.error})`,
			publicMessage: plan.msg,
		});
	}
	const { gitDir, targetDir, filePath, identity } = plan;
	await refuseUnlessGitStampsTags(gitDir);
	// IMMUTABLE: asked before anything is provisioned or archived.
	if (identity !== null && isPublished(filePath)) throw immutableRefusal(identity, filePath);
	const orphan = identity !== null && existsSync(filePath);
	provisionReleaseDirOrRefuse(targetDir);

	// Archived BESIDE the final name (same directory = same filesystem, so the
	// publish below is an atomic link/rename), never into it: until the bytes
	// have said who they are, nothing a consumer can fetch has changed. The
	// staging name ends in `.partial`, outside the archive grammar
	// (code_manifest.ts releaseArchiveNameOf), so it is never listed or served.
	const staged = `${filePath}.${process.pid}.${Date.now()}.partial`;
	let digest: string;
	try {
		await runGitArchiveOrRefuse(gitDir, ref, staged);
		if (identity !== null) await refuseUnlessArchiveIsIdentity(staged, identity);
		digest = createHash('sha256').update(readFileSync(staged)).digest('hex');
		publishArchive(staged, filePath, identity, orphan);
	} finally {
		rmSync(staged, { force: true });
	}

	// sha256 sidecar (WC-024 — the integrity guarantee PHP never emitted).
	// The sidecar line names the plan's ACTUAL artifact: the planner emits
	// `<v>-dev.zip` for every non-tag ref, so composing the name from
	// `versionString` alone would sign a dev build under the published name.
	// Written whole, then renamed into place: a reader never sees half a digest.
	const archiveName = basename(filePath);
	await Bun.write(`${filePath}.sha256.partial`, `${digest}  ${archiveName}\n`);
	renameSync(`${filePath}.sha256.partial`, `${filePath}.sha256`);

	return ok(
		{ file_path: filePath, sha256: digest },
		{
			requestId: currentRequestId(),
			extend: {
				msg: `OK. Built release ${archiveName} (${statSync(filePath).size} bytes)`,
				// PHP parity: the maintenance client reads both at the top level.
				file_path: filePath,
				sha256: digest,
			},
		},
	);
}
