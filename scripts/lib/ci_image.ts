/**
 * THE CI IMAGE PIN — one digest for every place a tier runs.
 *
 * `ci/image.json` names the published build of ci/Dockerfile that the gates run in:
 * GitHub's hermetic/db/instance jobs (`container:`), GitLab's hermetic job (`image:`)
 * and `ci:local --docker` (which pulls it by digest). A verdict is then a property of
 * the commit, not of which runner or Mac judged it — the reason the image exists
 * (ci/README.md). Until 2026-09-26 only ci:local used the image, and a LOCAL build of
 * it at that: GitHub ran bare ubuntu-latest, GitLab bare oven/bun as root, so a local
 * green predicted neither.
 *
 * YAML cannot read this file, so the digest is also written literally into each
 * workflow; `test/unit/ci_workflow_tripwire.test.ts` holds every literal equal to it and
 * its fingerprint equal to this checkout's. `bun run ci:image:pin` (scripts/ci_image_pin.ts)
 * is the updater: it resolves the digest ci-image.yml published for the current
 * fingerprint and rewrites the lock and every literal in one step.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CiImageLock {
	image: string;
	digest: string;
	fingerprint: string;
}

export const CI_IMAGE_LOCK = join('ci', 'image.json');

/**
 * The repository ci-image.yml publishes to and the ONLY name `bun run ci:image:pin`
 * writes (lock + every literal). The repo moved renderpci/dedalo → dedalia-org/dedalo
 * on 2026-10-09; a user-owned GHCR package does not move with a repository.
 */
export const CI_IMAGE_NAME = 'ghcr.io/dedalia-org/dedalo-ci';

/**
 * TRANSITION ONLY — the pre-transfer package, still accepted as a pin until the first
 * `ci-image.yml` publish under dedalia-org has been pinned (engineering/CI.md "Moving
 * the CI image repository"). It is accepted, never written: the pin tool always
 * writes CI_IMAGE_NAME. `ci_workflow_tripwire` rule 1b goes RED the moment no pin
 * names it any more — then set this to null (and delete the old package): the
 * removal is mechanical because nothing else spells the old name.
 */
// Move DONE 2026-10-10: the pin names dedalia-org. `as` keeps the union type, so the
// readers below stay compiled for the next repository move (a literal null narrows).
export const CI_IMAGE_LEGACY = null as { name: string; reason: string } | null;

/** Every name a pin may carry: the publishing repository, plus the legacy one while it lives. */
export const CI_IMAGE_ACCEPTED_NAMES: readonly string[] = [
	CI_IMAGE_NAME,
	...(CI_IMAGE_LEGACY === null ? [] : [CI_IMAGE_LEGACY.name]),
];

/** `ghcr.io/<owner>/dedalo-ci` → the registry-relative repository (`<owner>/dedalo-ci`). */
export const CI_IMAGE_REPOSITORY = CI_IMAGE_NAME.replace(/^ghcr\.io\//, '');

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Regex SOURCE of any accepted image name (no capture group). */
export const CI_IMAGE_NAME_PATTERN = `(?:${CI_IMAGE_ACCEPTED_NAMES.map(escapeRegExp).join('|')})`;

/** The files that reference the image by digest (the literals the lock must equal). */
export const CI_IMAGE_REFERENCES = [
	'.github/workflows/ci.yml',
	'.github/workflows/db.yml',
	'.gitlab-ci.yml',
] as const;

/**
 * `<accepted name>@sha256:<64 hex>` anywhere in a file: group 1 = the name, group 2 =
 * the digest.
 */
export const CI_IMAGE_REF = new RegExp(`(${CI_IMAGE_NAME_PATTERN})@(sha256:[0-9a-f]{64})`, 'g');

/** sha256(ci/Dockerfile ++ .bun-version) — the image's definition (ci/README.md). */
export function ciImageFingerprint(repoRoot: string): string {
	const hasher = new Bun.CryptoHasher('sha256');
	hasher.update(readFileSync(join(repoRoot, 'ci', 'Dockerfile')));
	hasher.update(readFileSync(join(repoRoot, '.bun-version')));
	return hasher.digest('hex');
}

export function readCiImageLock(repoRoot: string): CiImageLock {
	const lock = JSON.parse(readFileSync(join(repoRoot, CI_IMAGE_LOCK), 'utf8')) as CiImageLock;
	if (
		!CI_IMAGE_ACCEPTED_NAMES.includes(lock.image) ||
		!/^sha256:[0-9a-f]{64}$/.test(lock.digest) ||
		!/^[0-9a-f]{64}$/.test(lock.fingerprint)
	) {
		throw new Error(
			`${CI_IMAGE_LOCK}: expected {image: ${CI_IMAGE_ACCEPTED_NAMES.map((n) => `"${n}"`).join(' | ')}, digest: "sha256:<64 hex>", fingerprint: "<64 hex>"}`,
		);
	}
	return lock;
}

/** `<image>@<digest>` — how every consumer names the locked build. */
export function lockedImageRef(lock: CiImageLock): string {
	return `${lock.image}@${lock.digest}`;
}
