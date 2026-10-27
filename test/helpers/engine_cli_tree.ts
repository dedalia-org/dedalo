/**
 * An ENGINE TREE that calls itself a chosen release identity — for the gates
 * that run the image-update channel CLI (scripts/ops/image_update_channel.ts
 * `check-target`) as the host does, a real `bun` process.
 *
 * WHY NOT THE CHECKOUT'S OWN CLI. Since the identity walk (RELEASE_IDENTITY
 * design step 9c) the CLI starts from what its tree CALLS ITSELF
 * (build_stamp.ts RELEASE_IDENTITY): `X.Y.Z-dev` on a branch, the tag's
 * identity on a release commit — and the full gate runs on that release commit
 * before a tag is pushed. A verdict read from the checkout's CLI would change
 * with where the suite happens to run. So the gate builds the engine it means:
 * a scratch copy of the engine sources whose build_info.txt is EXPANDED the way
 * `git archive` expands it (`<sha> <date> <describe>`) and whose version.ts
 * declares the identity's own triple — exactly an archive of that release (a dev identity pins the NEXT triple it is named after), read
 * by the real resolver (no seam, no flag the production CLI would carry).
 *
 * Writes only under the caller's scratch directory.
 */

import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILD_INFO_PATH } from '../../src/core/update/build_stamp.ts';
import { parseReleaseVersion } from '../../src/core/update/release_identity.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');

/** What the CLI's import closure reads besides its own sources. */
const ENGINE_FILES = ['src', join('scripts', 'ops'), join('engineering', 'image_registries.json')];

/**
 * Build the tree under `scratchDir` and return the path of ITS check-target CLI.
 * `identity` is `X.Y.Z`, `X.Y.Z-beta.N` (an exact tag) or `X.Y.Z-dev` (an
 * untagged archive: git expands the describe field to nothing).
 */
export function engineCliAt(scratchDir: string, identity: string): string {
	const parsed = parseReleaseVersion(identity);
	if (parsed === null) throw new Error(`engineCliAt: '${identity}' is no release identity`);
	mkdirSync(scratchDir, { recursive: true });
	for (const path of ENGINE_FILES) {
		cpSync(join(REPO_ROOT, path), join(scratchDir, path), { recursive: true });
	}
	// A dev identity is named after the NEXT triple (version.ts DEDALO_NEXT_DEV_TRIPLE,
	// release_identity.ts): pinning the data triple instead would make the engine
	// call itself by the wrong identity. A tagged identity IS its data triple.
	const pinned = parsed.dev ? 'DEDALO_NEXT_DEV_TRIPLE' : 'DEDALO_VERSION_TRIPLE';
	pinTriple(join(scratchDir, 'src', 'core', 'update', 'version.ts'), pinned, parsed.triple);
	const describe = parsed.dev ? '' : `v${identity}`;
	writeFileSync(
		join(scratchDir, BUILD_INFO_PATH),
		`${'c'.repeat(40)} 2026-10-18T00:00:00+00:00 ${describe}\n`,
	);
	return join(scratchDir, 'scripts', 'ops', 'image_update_channel.ts');
}

/**
 * Re-pin the copied version.ts to `triple`, keeping the rest of the module
 * (its other exports are imported by the closure). Refuses when the pin's
 * shape moved: a silent no-op would leave the engine at the checkout's triple.
 */
function pinTriple(path: string, constant: string, triple: readonly number[]): void {
	const source = readFileSync(path, 'utf8');
	const pin = new RegExp(`(${constant}[^=]*=\\s*Object\\.freeze\\(\\[)[^\\]]*(\\])`);
	if (!pin.test(source))
		throw new Error(`engineCliAt: the triple pin ${constant} of ${path} changed shape`);
	writeFileSync(path, source.replace(pin, `$1${triple.join(', ')}$2`));
}
