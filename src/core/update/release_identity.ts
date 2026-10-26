/**
 * RELEASE IDENTITY — what the program CALLS ITSELF, derived from the git tag
 * (owner decision 2026-10-15, finding C3i-F1).
 *
 * Two identities, never confused:
 *  - the DATA version (`version.ts` DEDALO_VERSION_TRIPLE / DEDALO_VERSION) —
 *    what compares, migrates, names a code-server directory, crosses to an
 *    older peer. It is the last data-changing release, which may lag the code.
 *  - the RELEASE identity (this module): the bare triple for an exact stable
 *    tag, `X.Y.Z-(alpha|beta|rc).N` for an exact prerelease tag, `X.Y.Z-dev`
 *    for anything untagged (the triple is version.ts DEDALO_NEXT_DEV_TRIPLE,
 *    the release the tree is building toward). A build at tag `v7.0.0-beta.6`
 *    calls itself `7.0.0-beta.6` while its data stays `7.0.0`.
 *
 * Dev identity order (owner decision 2026-10-25): a dev identity sorts ABOVE
 * every alpha/beta/rc of its triple and BELOW the stable of that triple, so
 * `7.0.0 < 7.0.1-alpha.1 < 7.0.1-beta.1 < 7.0.1-rc.1 < 7.0.1-dev < 7.0.1 < 7.0.2`.
 *
 * PURE LEAF: no fs, no spawn, no config — the evidence (the expanded
 * `build_info.txt` describe field, or a checkout's `git describe`) is READ by
 * build_stamp.ts and handed in. That is what lets scripts/lib/change_log.ts
 * import the one grammar and the one comparator without starting a git
 * process, and what lets a gate drive every rule from a fixture.
 */

import type { InstallChannel } from './install_stamp.ts';

/** The prerelease labels a release tag may carry, in semver precedence order (owner Q9). */
export const PRERELEASE_LABELS = Object.freeze(['alpha', 'beta', 'rc'] as const);

export type PrereleaseLabel = (typeof PRERELEASE_LABELS)[number];

/**
 * THE release-version grammar, shared by the resolver, the changelog
 * (`changes/<version>/`) and — later — the code server's tag list: a canonical
 * triple (no leading zeros, so `v7.0.01` can never name a second `7.0.1`),
 * optionally `-alpha.N` / `-beta.N` / `-rc.N`. No `-dev` suffix: a dev build is
 * never a release (its identity is `X.Y.Z-dev`, DEV_VERSION_RE, and no tag can name it).
 */
export const RELEASE_VERSION_RE =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?$/;

/**
 * A dev identity: the triple plus `-dev` (owner Q2 — the commit stays in DEDALO_BUILD_SHA).
 * The same spelling as the dev ARCHIVE name (`<X.Y.Z>-dev.zip`), so an identity
 * and the file that carries it read alike.
 */
const DEV_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-dev$/;

/**
 * Oldest git whose `export-subst` expands `%(describe:match=…,abbrev=…)`.
 * An older git leaves the placeholder literally in the archive; the resolver
 * reads that as "no tag evidence" and says a dev identity — never a release — with a
 * notice naming this minimum. Building a release ARCHIVE with one is refused
 * outright (gitDescribeSupportFault: code_build.ts, scripts/ci/image_release.ts).
 *
 * VERIFIED 2026-10-15 against git's own sources, not memory:
 *  - Documentation/RelNotes/2.32.0: `"git log --format='...'" learned
 *    "%(describe)" placeholder.` — and Documentation/pretty-formats.txt at
 *    v2.32.0 lists exactly two options, `match=<pattern>` and `exclude=<pattern>`;
 *  - Documentation/pretty-formats.txt at v2.34.0: still only match/exclude;
 *  - Documentation/RelNotes/2.35.0: `The "git log --format=%(describe)"
 *    placeholder has been extended to allow passing selected command-line
 *    options to the underlying "git describe" command.` — and pretty-formats.txt
 *    at v2.35.0 adds `tags[=<bool-value>]` and `abbrev=<number>`.
 * The placeholder uses `abbrev=40` (byte-stable archives), so 2.35 it is.
 */
export const MIN_GIT_FOR_DESCRIBE = '2.35';

/**
 * Why `git --version` output (`git version 2.39.5 (Apple Git-154)`) names a
 * git too old to stamp the release tag into an archive, or null when it is
 * new enough. Output that names no version is a fault too (fail closed): a
 * release built by an unknown git may ship calling itself a dev build.
 */
export function gitDescribeSupportFault(versionOutput: string): string | null {
	const found = /git version (\d+)\.(\d+)/.exec(versionOutput);
	if (found === null)
		return `the git version could not be read, so it cannot be shown to expand %(describe) (git ${MIN_GIT_FOR_DESCRIBE} or newer is required)`;
	const [minMajor, minMinor] = MIN_GIT_FOR_DESCRIBE.split('.').map(Number) as [number, number];
	const major = Number(found[1]);
	const minor = Number(found[2]);
	if (major > minMajor || (major === minMajor && minor >= minMinor)) return null;
	return `git ${major}.${minor} cannot expand %(describe:match=…,abbrev=…) — the archive would not carry its release tag and would call itself a dev build; git ${MIN_GIT_FOR_DESCRIBE} or newer is required`;
}

export type ReleaseKind = 'stable' | 'prerelease' | 'dev';

export interface ReleaseIdentity {
	/** The string the program calls itself: `X.Y.Z`, `X.Y.Z-beta.N` or `X.Y.Z-dev`. */
	version: string;
	kind: ReleaseKind;
	/**
	 * The triple this identity names: the tag's own triple for a release, the
	 * declared next triple (version.ts DEDALO_NEXT_DEV_TRIPLE) for a dev identity.
	 * It is NOT always the DATA triple (version.ts DEDALO_VERSION_TRIPLE).
	 */
	triple: readonly [number, number, number];
	/** The exact git tag the identity was read from; null when none applied. */
	tag: string | null;
	/**
	 * Why the evidence was NOT believed, for the one boot log line (rule 3):
	 * a tag naming another version, a git too old to expand the describe
	 * field, a checkout whose git could not answer. Null when nothing is odd —
	 * an untagged commit is normal and says nothing.
	 */
	notice: string | null;
}

/** A parsed identity: the triple, the prerelease (if any), the dev flag. */
export interface ParsedReleaseVersion {
	triple: readonly [number, number, number];
	prerelease: { label: PrereleaseLabel; number: number } | null;
	dev: boolean;
}

/** Parse a release identity (`X.Y.Z`, `X.Y.Z-rc.N`, `X.Y.Z-dev`); null when it is none of them. */
export function parseReleaseVersion(version: string): ParsedReleaseVersion | null {
	const dev = DEV_VERSION_RE.exec(version);
	if (dev !== null) {
		return { triple: tripleOf(dev), prerelease: null, dev: true };
	}
	const match = RELEASE_VERSION_RE.exec(version);
	if (match === null) return null;
	const label = match[4] as PrereleaseLabel | undefined;
	return {
		triple: tripleOf(match),
		prerelease: label === undefined ? null : { label, number: Number(match[5]) },
		dev: false,
	};
}

function tripleOf(match: RegExpExecArray): [number, number, number] {
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * The version an EXACT release tag names (`v7.0.0-beta.6` → `7.0.0-beta.6`),
 * or null when the string is not one: a describe that walked past a tag
 * (`v7.0.0-beta.6-3-g2915808635`), a foreign suffix (`v7.0.0-pre.1`), a
 * non-canonical number, an empty answer.
 */
export function releaseVersionOfTag(tag: string): string | null {
	if (!tag.startsWith('v')) return null;
	const version = tag.slice(1);
	return RELEASE_VERSION_RE.test(version) ? version : null;
}

/**
 * Semver §11 precedence between two identities: -1 / 0 / 1.
 * `7.0.0-alpha.1 < 7.0.0-beta.5 < 7.0.0-beta.6 < 7.0.0-rc.1 < 7.0.0 < 7.0.1`,
 * and with a dev identity in the same triple:
 * `7.0.1-alpha.1 < 7.0.1-beta.1 < 7.0.1-rc.1 < 7.0.1-dev < 7.0.1 < 7.0.2`.
 *
 * A `-dev` identity is NOT its bare triple: it sorts above every prerelease of
 * its triple and strictly below that triple's stable release (comparePrereleases
 * ranks dev explicitly; a null prerelease is the stable release, never a
 * label index). Throws on a string that is no
 * identity at all: a silent order for garbage is how a downgrade gets waved
 * through.
 *
 * Identity-to-identity questions ONLY. The data walk (matrix_updates, the
 * update catalog) stays on triples (`version.ts` compareVersionArrays).
 */
export function compareReleaseIdentities(a: string, b: string): number {
	const x = requireParsed(a);
	const y = requireParsed(b);
	const byTriple = compareTriples(x.triple, y.triple);
	return byTriple !== 0 ? byTriple : comparePrereleases(x, y);
}

function compareTriples(x: readonly number[], y: readonly number[]): number {
	for (let i = 0; i < 3; i++) {
		const d = (x[i] as number) - (y[i] as number);
		if (d !== 0) return Math.sign(d);
	}
	return 0;
}

/**
 * Precedence rank inside one triple: each prerelease label by its position in
 * PRERELEASE_LABELS, then the dev identity, then the stable release (no
 * prerelease). Dev and stable are EXPLICIT ranks, never a missing label: a dev
 * identity carries prerelease null, so reading it as "the release" would tie it
 * with the stable of its triple — the exact bug this order replaces.
 */
const DEV_PRECEDENCE_RANK = PRERELEASE_LABELS.length;
const STABLE_PRECEDENCE_RANK = PRERELEASE_LABELS.length + 1;

function precedenceRankOf(parsed: ParsedReleaseVersion): number {
	if (parsed.dev) return DEV_PRECEDENCE_RANK;
	if (parsed.prerelease === null) return STABLE_PRECEDENCE_RANK;
	return PRERELEASE_LABELS.indexOf(parsed.prerelease.label);
}

/** Same triple: rank first (alpha < beta < rc < dev < stable), then the number within one label. */
function comparePrereleases(x: ParsedReleaseVersion, y: ParsedReleaseVersion): number {
	const byRank = precedenceRankOf(x) - precedenceRankOf(y);
	if (byRank !== 0) return Math.sign(byRank);
	return Math.sign((x.prerelease?.number ?? 0) - (y.prerelease?.number ?? 0));
}

function requireParsed(version: string): ParsedReleaseVersion {
	const parsed = parseReleaseVersion(version);
	if (parsed === null) {
		// A RangeError, not a registered DedaloError: this module is a pure LEAF that
		// scripts/lib/change_log.ts (and its scratch-copy gate) loads alone. Every caller
		// hands in an identity this module made or validated; a silent order for
		// garbage is how a downgrade gets waved through.
		throw new RangeError(`not a release identity: '${version}'`);
	}
	return parsed;
}

/**
 * The container image tag an identity is published / built under. Every
 * identity is its own tag: a stable or prerelease identity (`7.0.0`,
 * `7.0.0-beta.6` — never a floating `7.0.0` for a beta) and a dev identity
 * (`7.0.1-dev`, the same spelling the image grammar uses).
 */
export function imageTagOf(version: string): string {
	requireParsed(version); // throws on a string that is no identity
	return version;
}

/**
 * The identity an image tag names — the inverse of imageTagOf: every tag the
 * image grammar accepts (`X.Y.Z`, `X.Y.Z-(alpha|beta|rc).N`, `X.Y.Z-dev`) is
 * its own identity; anything else → null. Two tags order as their identities
 * do: deploy/dedalo-image-lib.sh DEDALO_VERSION_RE / dedalo_version_cmp are
 * held to it by test/unit/release_identity_shell_parity.test.ts.
 */
export function identityOfImageTag(tag: string): string | null {
	if (DEV_VERSION_RE.test(tag) || RELEASE_VERSION_RE.test(tag)) return tag;
	return null;
}

/** Parsed provenance: null build ⇒ no expanded stamp (a checkout, or malformed). */
export interface BuildInfo {
	/** Commit sha of the archive, or null on a checkout. */
	sha: string | null;
	/** Commit ISO date of the archive, or null on a checkout. */
	build: string | null;
	/**
	 * The expanded describe field: the tag (`v7.0.0-beta.6`), a past-the-tag
	 * describe, or `''` (git found no `v*` tag). null when the stamp has no
	 * such field — a checkout's placeholder, or a LEGACY archive.
	 */
	describe: string | null;
	/**
	 * True for an archive expanded from the pre-2026-10-15 two-field
	 * placeholder (`<sha> <date>`): its identity keeps the old channel rule
	 * (release_identity.ts rule 4).
	 */
	legacy: boolean;
}

const NO_BUILD_INFO: BuildInfo = Object.freeze({
	sha: null,
	build: null,
	describe: null,
	legacy: false,
});

const SHA = '[0-9a-f]{7,64}';
const ISO_DATE = '\\d{4}-\\d{2}-\\d{2}T[0-9:.+\\-Z]+';
const LEGACY_STAMP_RE = new RegExp(`^(${SHA}) (${ISO_DATE})$`);
/**
 * The describe field may be EMPTY: git expands `%(describe…)` to nothing when
 * no `v*` tag is reachable, leaving `<sha> <date> ` with its separating space.
 * That trailing space is what tells an untagged three-field stamp from a
 * legacy two-field one, so the line is never right-trimmed before matching.
 */
const DESCRIBED_STAMP_RE = new RegExp(`^(${SHA}) (${ISO_DATE}) (\\S*)$`);

/**
 * Parse build_info.txt content (a string — reading the file is build_stamp.ts's
 * job; scripts/ci/image_release.ts parses the stamp of an archive it built). The unexpanded `$Format:` placeholder, an
 * empty/missing file, or ANY malformed content → dev values (never a throw:
 * a broken stamp must not take the server down). Two fields (legacy) and
 * three fields are both accepted.
 */
export function parseBuildInfo(content: string): BuildInfo {
	// Only the line terminator is removed: see DESCRIBED_STAMP_RE.
	const line = (content.replace(/^\s+/, '').split(/\r?\n/)[0] ?? '').replace(/\r$/, '');
	if (line === '' || line.startsWith('$Format:')) return NO_BUILD_INFO;
	const described = DESCRIBED_STAMP_RE.exec(line);
	if (described !== null) {
		return Object.freeze({
			sha: described[1] as string,
			build: described[2] as string,
			describe: described[3] as string,
			legacy: false,
		});
	}
	const legacy = LEGACY_STAMP_RE.exec(line);
	if (legacy === null) return NO_BUILD_INFO;
	return Object.freeze({
		sha: legacy[1] as string,
		build: legacy[2] as string,
		describe: null,
		legacy: true,
	});
}

/** The evidence the resolver decides from — every fs/git read happens in build_stamp.ts. */
export interface ReleaseEvidence {
	/** version.ts DEDALO_VERSION_TRIPLE of the running tree (the DATA triple: an exact tag must name it). */
	triple: readonly [number, number, number];
	/**
	 * version.ts DEDALO_NEXT_DEV_TRIPLE: the triple an UNTAGGED tree names its
	 * dev identity with. Resolved here — the one place that decides it — so no
	 * caller can pass a different triple for the same tree.
	 */
	nextDevTriple: readonly [number, number, number];
	/**
	 * The `git describe --exact-match --match 'v[0-9]*'` answer for the tree:
	 * the expanded third field of build_info.txt (an archive), or the bounded
	 * checkout reader's stdout. `''` = git answered "no exact tag". null = there
	 * is NO describe evidence at all (a legacy stamp, an unexpanded placeholder
	 * with no git to ask, a git that could not run).
	 */
	describe: string | null;
	provenance: {
		/**
		 * `legacy`: an archive expanded by the pre-2026-10-15 two-field
		 * placeholder (`<sha> <date>`, no describe). `other`: anything else.
		 */
		stamp: 'legacy' | 'other';
		/** The channel the tree was installed from (install_stamp.json), null when unstamped. */
		channel: InstallChannel | null;
	};
}

/**
 * Resolve the release identity, in this order (design §2.2):
 *  1. exact stable tag `vX.Y.Z` whose triple = version.ts → `X.Y.Z` (stable);
 *  2. exact prerelease tag `vX.Y.Z-(alpha|beta|rc).N`, triple equal → that (prerelease);
 *  3. anything else with describe evidence — untagged, past a tag, a tag naming
 *     ANOTHER triple (with a notice), an old git's unexpanded field — → `X.Y.Z-dev`,
 *     with X.Y.Z = evidence.nextDevTriple (the release being built toward);
 *  4. a LEGACY two-field stamp keeps the pre-identity rule: bare on a master /
 *     unstamped install, `-dev` on a dev-channel install;
 *  5. the channel never overrides a TAG (owner Q5): a dev-channel archive of an
 *     exactly tagged commit IS that release's bytes, so it calls itself by the
 *     tag (posture stays channel-driven — status.ts enginePosture).
 * No evidence at all (an unexpanded placeholder with no git) → `-dev`.
 */
export function resolveReleaseIdentity(evidence: ReleaseEvidence): ReleaseIdentity {
	const { triple, nextDevTriple, describe, provenance } = evidence;
	const data = triple.join('.');
	if (describe === null) {
		return provenance.stamp === 'legacy' && provenance.channel !== 'dev'
			? freezeIdentity({ version: data, kind: 'stable', triple, tag: null, notice: null })
			: devIdentity(nextDevTriple, null);
	}
	const tagged = releaseVersionOfTag(describe);
	if (tagged !== null) return taggedIdentity(triple, nextDevTriple, describe, tagged);
	if (describe.startsWith('%(')) {
		return devIdentity(
			nextDevTriple,
			`the build stamp's describe field was never expanded (git older than ${MIN_GIT_FOR_DESCRIBE} built this archive) — the release tag cannot be read; calling it ${nextDevTriple.join('.')}-dev`,
		);
	}
	return devIdentity(nextDevTriple, null);
}

/** `X.Y.Z-dev`: no release names this tree (rule 3). */
function devIdentity(
	nextDevTriple: readonly [number, number, number],
	notice: string | null,
): ReleaseIdentity {
	return freezeIdentity({
		version: `${nextDevTriple.join('.')}-dev`,
		kind: 'dev',
		triple: nextDevTriple,
		tag: null,
		notice,
	});
}

/**
 * Rules 1/2: an exact release tag names its OWN release (owner decision,
 * 2026-10-26). A code-only patch tag keeps the data version of its minor, so
 * the tag's triple may be above DATA — it is still that release. Only a tag
 * BELOW the data triple is refused (a tree cannot be an older release than the
 * data it runs on) and falls back to the dev identity.
 */
function taggedIdentity(
	triple: readonly [number, number, number],
	nextDevTriple: readonly [number, number, number],
	describe: string,
	tagged: string,
): ReleaseIdentity {
	const parsed = requireParsed(tagged);
	if (compareTriples(parsed.triple, triple) < 0) {
		return devIdentity(
			nextDevTriple,
			`the tag ${describe} names ${tagged}, below the data version ${triple.join('.')} — the tree cannot be an older release than its data; calling it ${nextDevTriple.join('.')}-dev`,
		);
	}
	const kind: ReleaseKind = parsed.prerelease === null ? 'stable' : 'prerelease';
	return freezeIdentity({ version: tagged, kind, triple: parsed.triple, tag: describe, notice: null });
}

function freezeIdentity(identity: ReleaseIdentity): ReleaseIdentity {
	const [major, minor, patch] = identity.triple;
	return Object.freeze({ ...identity, triple: Object.freeze([major, minor, patch] as const) });
}
