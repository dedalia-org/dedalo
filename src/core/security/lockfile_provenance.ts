/**
 * THE LOCKFILE PROVENANCE LAW — one predicate, two consumers: the repo's own lockfiles
 * (test/unit/dependency_integrity_tripwire.test.ts) and every `bun.lock` a publication
 * bundle or kit installs from (publication_host/api_bundles.ts assertRegistryLockfile).
 * Two copies of a law drift; this is the one copy.
 *
 * A registry tuple is `["<name>@<exact version>", "", <metadata>, "<integrity>"]`.
 * Every other resolution bun writes — a URL, git, `file:`/`link:`, a workspace member, a
 * local tarball (`dep@../x.tgz`, which bun normalises `file:x.tgz` to) — carries
 * something other than an exact version after the name, so the rule is POSITIVE: the
 * spec must BE an exact semver in the default-registry slot, never "not one of the bad prefixes" (a deny-list let the
 * local-tarball spelling through). Pure: no I/O, no throw.
 */

/** Exact semver — the only spec a registry resolution carries in `bun.lock`. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Integrity bun records for a registry tarball. */
const INTEGRITY = /^sha(512|256)-/;

export type LockTupleProblem = 'malformed' | 'non_registry' | 'no_integrity';

/** The problems of one `packages` tuple ([] = registry-resolved and integrity-pinned). */
export function lockTupleProblems(tuple: unknown): LockTupleProblem[] {
	if (!Array.isArray(tuple) || typeof tuple[0] !== 'string') return ['malformed'];
	const problems: LockTupleProblem[] = [];
	if (!isRegistryResolution(tuple)) problems.push('non_registry');
	if (!hasIntegrity(tuple)) problems.push('no_integrity');
	return problems;
}

/**
 * The spec after the name. Splits on the FIRST '@' after index 0 (a scope's own '@'):
 * a spec may itself hold one (`x@https://user@host/x.tgz`), which a last-'@' split hides.
 */
function specOf(resolution: string): string {
	const at = resolution.indexOf('@', 1);
	return at <= 0 ? '' : resolution.slice(at + 1);
}

/**
 * A registry resolution: an exact version after the name AND bun's default-registry slot
 * (`""`). The spec alone is not enough — a local tarball NAMED like a version
 * (`file:1.2.3-x.tgz` → `b@1.2.3-x.tgz`) reads as semver with a prerelease, but bun
 * writes every non-registry tuple with an object in slot 1. Pinning the slot to `""`
 * also refuses a tuple fetched from another registry URL.
 */
function isRegistryResolution(tuple: readonly unknown[]): boolean {
	return tuple[1] === '' && EXACT_VERSION.test(specOf(tuple[0] as string));
}

/** The tuple's last element is a registry integrity hash. */
function hasIntegrity(tuple: readonly unknown[]): boolean {
	const integrity = tuple[tuple.length - 1];
	return typeof integrity === 'string' && INTEGRITY.test(integrity);
}

/**
 * `bun.lock`'s `packages` map, parsed as the JSONC it is (Bun.JSONC — a comma-stripping
 * regex would also rewrite string contents). A lockfile that does not parse, or whose
 * `packages` is missing or not an object, is an error, never an empty census: "no
 * packages key" read as `{}` would make every check over it pass vacuously.
 */
export function parseLockPackages(
	text: string,
): { packages: Record<string, unknown> } | { error: string } {
	let parsed: unknown;
	try {
		parsed = Bun.JSONC.parse(text);
	} catch {
		// A fixed sentence, never the parser's text (SEC-18): this rides a refusal payload.
		// A committed lockfile that does not parse reproduces locally with `bun install`.
		return { error: 'does not parse as JSONC' };
	}
	const packages = (parsed as { packages?: unknown } | null)?.packages;
	if (packages === null || typeof packages !== 'object' || Array.isArray(packages)) {
		return { error: 'has no `packages` object' };
	}
	return { packages: packages as Record<string, unknown> };
}
