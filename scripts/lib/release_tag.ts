/**
 * release_tag.ts — THE check a release tag must pass before it is published
 * (RELEASE_IDENTITY gate 11). ONE implementation, two doors:
 *   - the pre-push hook (scripts/hooks/pre-push), for every `refs/tags/v*` a push
 *     lands — through `bun run push:release-tag <tag> <commit>`;
 *   - image-release.yml's `plan` (scripts/ci/image_release.ts releasePlanFor),
 *     which imports releaseTagFault — the half no `--no-verify` reaches.
 *
 * A tag `v<identity>` (the shared grammar, release_identity.ts) names a release
 * only when ITS OWN COMMIT says so:
 *   1. the commit's version.ts declares the tag's data triple — a tag whose tree
 *      is another version would publish bytes under the wrong name;
 *   2. the commit carries `changes/<identity>/release.json` naming exactly this
 *      version and ending at this tag — the release was CUT (`bun run changelog
 *      release <identity>`) before it was tagged, so the release notes every
 *      update panel shows exist. The FILE's full grammar is change_log_tripwire's
 *      (scripts/lib/change_log.ts parseRelease), run by the full gate a release
 *      commit must pass; this check reads only the two keys that bind it to the
 *      tag. It does not import the changelog module: that module also WALKS
 *      changes/, and a check over git objects must not carry a working-tree walk
 *      into every gate that imports it (census_derivation_tripwire).
 *   3. the commit's `install/update/catalog.json` holds the release's triple —
 *      a release with no catalog entry is never advertised by any master (the
 *      update audit's release-cut finding, 2026-10-29: the U-06 class);
 *   4. the commit's install seed (`install/db/dedalo_install.manifest.json`) was
 *      compiled for the commit's own data version — a fresh install of the
 *      release starts on the schema and data version the release declares. The
 *      seed's FRESHNESS against its sources is install_seed_manifest_tripwire,
 *      in the full gate a held tag's commit must pass; this binds it to the tag.
 * Everything is read from the git object store at the tag's commit, never from
 * the working tree: what is checked is what is published.
 *
 * THE PUSH DOOR ALSO HOLDS THE TAG OBJECT (owner Q7, design gate 18): a release
 * tag must be ANNOTATED. A lightweight tag is invisible to build_info.txt's
 * `%(describe)` (it sees annotated tags only), so its archive — the code
 * server's zip, the release image — would call itself `X.Y.Z.dev`, not the
 * release. The code server and the image plan refuse such an archive after the
 * fact; the push refuses the tag before it exists anywhere else.
 *
 *   bun run scripts/lib/release_tag.ts check <tag> <commit> <object>
 *
 * (`<object>` = what the pushed ref names: the tag object of an annotated tag,
 * the commit itself of a lightweight one.)
 *
 * A LIBRARY with a CLI, not a CI stage: no hosted chain runs it by name (the image
 * pipeline imports it), so it lives in scripts/lib/ (tier_wiring_tripwire rule I).
 *     exit 0: a HELD release tag that passes — the hook then demands a FULL
 *             green for its commit, stable and prerelease alike (a prerelease
 *             IS a release, owner Q1);
 *     exit 3: nothing to hold — a tag that is no release identity
 *             (v6.0.0.beta.1), or one published before the rule (below
 *             FIRST_CUT_RELEASE — see there): it passes, and needs no gate;
 *     exit 1: refused, with the sentence; exit 2: a malformed call.
 */

import {
	parseDeclaredDataTriple,
	parseDeclaredReleaseTriple,
	VERSION_TS_PATH,
} from '../../src/core/update/code_build_plan.ts';
import {
	compareReleaseIdentities,
	parseReleaseVersion,
	releaseVersionOfTag,
} from '../../src/core/update/release_identity.ts';

/** What the check reads from git, injectable so the rules are testable on fixtures. */
export interface ReleaseTagGit {
	/** The bytes of `path` at commit `rev`, or null when the commit has no such file. */
	fileAt(rev: string, path: string): string | null;
}

/** The exit code that says "a v* name with nothing to hold" (see the header). */
export const NOTHING_TO_HOLD = 3;

/**
 * Why a pushed release tag OBJECT may not be published, or null: it must be an
 * annotated tag (`git cat-file -t` says `tag`). `objectType` null = git could
 * not say — refused too (fail closed: an unreadable object is no evidence).
 */
export function lightweightTagFault(tag: string, objectType: string | null): string | null {
	if (objectType === 'tag') return null;
	return `tag ${tag} is ${objectType === null ? 'an object git cannot read' : `a LIGHTWEIGHT tag (it names a ${objectType})`} — a release tag must be annotated (git tag -a ${tag} -m '…' <commit>): build_info.txt's %(describe) sees annotated tags only, so the release's archive and image would call themselves a developer build. Delete it (git tag -d ${tag}) and tag again with -a`;
}

/**
 * The first release cut and tagged under this rule. Every identity BELOW it was
 * published before the rule existed and cannot meet it at its own commit: v4–v6
 * and v7.0.0-alpha.1..beta.1 carry no version.ts, beta.2..4 were cut AFTER their
 * tag, beta.5 was never cut. Those tags are immutable history, yet a push still
 * carries them (`git push --tags` to a new mirror or a re-created lane remote,
 * `--mirror`), and refusing them would leave `--no-verify` — which skips every
 * gate — as the only way through. So the PUSH door passes them, saying so.
 *
 * A floor, not a list: a tag below it named today would be a new tag in the past
 * of the release line, which the image pipeline and the updater's forward-only
 * order refuse anyway. releaseTagFault itself stays strict — the image-release
 * plan never publishes a pre-rule tag.
 */
export const FIRST_CUT_RELEASE = '7.0.0-beta.6';

/** True when `identity` predates the rule (sorts below FIRST_CUT_RELEASE). */
export function predatesReleaseCutRule(identity: string): boolean {
	return compareReleaseIdentities(identity, FIRST_CUT_RELEASE) < 0;
}

/** The changelog snapshot a release identity must carry (changes/README.md "Cutting a release"). */
export function releaseNotesPath(identity: string): string {
	return `changes/${identity}/release.json`;
}

/**
 * Why tag `tag` (a bare name, `v7.0.1` / `v7.0.1-beta.2`) on commit `commit`
 * may NOT be published, or null when it may. A name outside the release grammar
 * is refused here too — the caller decides which tags are release tags.
 */
export function releaseTagFault(tag: string, commit: string, git: ReleaseTagGit): string | null {
	const identity = releaseVersionOfTag(tag);
	const parsed = identity === null ? null : parseReleaseVersion(identity);
	if (identity === null || parsed === null)
		return `'${tag}' is not a release tag v<X.Y.Z>[-(alpha|beta|rc).N]`;
	const triple = parsed.triple.join('.');
	const versionTs = git.fileAt(commit, VERSION_TS_PATH);
	const declared = versionTs === null ? null : parseDeclaredReleaseTriple(versionTs);
	if (declared !== triple)
		return `tag ${tag} names version ${triple}, but ${VERSION_TS_PATH} at ${commit} declares ${declared ?? 'nothing'} — bump the version (or tag the commit that declares it)`;
	const notesPath = releaseNotesPath(identity);
	const notes = git.fileAt(commit, notesPath);
	const cut = `cut the release first (bun run changelog release ${identity}), commit it, and tag THAT commit`;
	if (notes === null) return `tag ${tag}: ${commit} carries no ${notesPath} — ${cut}`;
	const release = cutOf(notes);
	if (release === null)
		return `tag ${tag}: ${notesPath} at ${commit} is not a JSON object — ${cut}`;
	if (release.version !== identity || release.to !== tag)
		return `tag ${tag}: ${notesPath} at ${commit} is the cut of ${String(release.version)} up to ${String(release.to)}, not of ${identity} up to ${tag} — ${cut}`;
	return (
		catalogFault(tag, triple, commit, git, versionTs as string) ??
		seedFault(tag, commit, versionTs as string, git)
	);
}

/** The release catalog a release tag's commit must hold its triple in (rule 3). */
export const RELEASE_CATALOG_PATH = 'install/update/catalog.json';

/** The install-seed manifest a release tag's commit must have compiled (rule 4). */
export const SEED_MANIFEST_PATH = 'install/db/dedalo_install.manifest.json';

/** Rule 3: the commit's catalog has an entry for the tag's triple. */
function catalogFault(
	tag: string,
	triple: string,
	commit: string,
	git: ReleaseTagGit,
	versionTs: string,
): string | null {
	// The line start is the walk's BASE, never a key (catalog_file.ts refuses one):
	// its releases (v7.0.0-beta.N, v7.0.0) ride the seed, not a catalog rung.
	if (triple === parseDeclaredLineStart(versionTs)) return null;
	const releases = jsonObjectOf(git.fileAt(commit, RELEASE_CATALOG_PATH))?.releases;
	const listed =
		typeof releases === 'object' && releases !== null && Object.hasOwn(releases, triple);
	return listed
		? null
		: `tag ${tag}: ${RELEASE_CATALOG_PATH} at ${commit} has no '${triple}' release — no master would ever advertise it; add the release to the catalog (engineering/RELEASE.md step 2), commit, and tag THAT commit`;
}

/** The data line start a commit's version.ts declares (`DATA_LINE_START`), or null. */
function parseDeclaredLineStart(versionTs: string): string | null {
	const matched =
		/DATA_LINE_START\b[^=]*=\s*Object\.freeze\(\[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(versionTs);
	return matched === null ? null : `${matched[1]}.${matched[2]}.${matched[3]}`;
}

/** Rule 4: the commit's seed was compiled for the commit's own data version. */
function seedFault(
	tag: string,
	commit: string,
	versionTs: string,
	git: ReleaseTagGit,
): string | null {
	const data = parseDeclaredDataTriple(versionTs);
	const seeded = jsonObjectOf(git.fileAt(commit, SEED_MANIFEST_PATH))?.engine_version;
	return seeded === data
		? null
		: `tag ${tag}: ${SEED_MANIFEST_PATH} at ${commit} was compiled for data version ${String(seeded ?? 'nothing')}, but the commit declares ${data ?? 'nothing'} — run bun run seed:build, commit seed + manifest, and tag THAT commit`;
}

/** A JSON object's keys, or null when `text` is absent or no JSON object. */
function jsonObjectOf(text: string | null): Record<string, unknown> | null {
	if (text === null) return null;
	try {
		const value: unknown = JSON.parse(text);
		return typeof value === 'object' && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/** The two keys of a release.json that bind it to a tag, or null when it is no JSON object. */
function cutOf(text: string): { version: unknown; to: unknown } | null {
	try {
		const value: unknown = JSON.parse(text);
		if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
		const { version, to } = value as Record<string, unknown>;
		return { version, to };
	} catch {
		return null;
	}
}

/** `git cat-file -t <object>` in `cwd` (`tag`, `commit`, …), or null when git cannot answer. */
export function gitObjectType(cwd: string, object: string): string | null {
	const typed = Bun.spawnSync(['git', 'cat-file', '-t', object], {
		cwd,
		stdout: 'pipe',
		stderr: 'ignore',
	});
	return typed.exitCode === 0 ? typed.stdout.toString().trim() : null;
}

/** The real lookups: `git show <rev>:<path>` in `cwd`. */
export function gitShowLookups(cwd: string): ReleaseTagGit {
	return {
		fileAt: (rev, path) => {
			const shown = Bun.spawnSync(['git', 'show', `${rev}:${path}`], {
				cwd,
				stdout: 'pipe',
				stderr: 'ignore',
			});
			return shown.exitCode === 0 ? shown.stdout.toString() : null;
		},
	};
}

/** The CLI: `check <tag> <commit> <object>`. Returns the process exit code. */
export function main(argv: readonly string[], cwd: string = process.cwd()): number {
	const [verb, tag, commit, object] = argv;
	if (
		verb !== 'check' ||
		tag === undefined ||
		commit === undefined ||
		object === undefined ||
		argv.length !== 4
	) {
		console.error('usage: bun run scripts/lib/release_tag.ts check <tag> <commit> <object>');
		return 2;
	}
	const identity = releaseVersionOfTag(tag);
	if (identity === null) {
		console.log(`release-tag: ${tag} is not a release identity tag — nothing to hold`);
		return NOTHING_TO_HOLD;
	}
	if (predatesReleaseCutRule(identity)) {
		console.log(
			`release-tag: ${tag} predates the cut rule (first cut release v${FIRST_CUT_RELEASE}) — published history, not held`,
		);
		return NOTHING_TO_HOLD;
	}
	const fault =
		lightweightTagFault(tag, gitObjectType(cwd, object)) ??
		releaseTagFault(tag, commit, gitShowLookups(cwd));
	if (fault !== null) {
		console.error(`release-tag: REFUSED — ${fault}`);
		return 1;
	}
	console.log(
		`release-tag: ${tag} at ${commit} — annotated, and version.ts and the changelog cut agree`,
	);
	return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
