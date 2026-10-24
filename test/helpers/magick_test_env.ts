/**
 * THE ENV A TEST'S OWN ImageMagick SPAWN CARRIES — the engine's, never the host's.
 *
 * The engine points every ImageMagick process it starts at the SHIPPED policy
 * (`magickPolicyEnv()`, src/core/media/engine/binaries.ts → MAGICK_CONFIGURE_PATH).
 * A test that builds its fixture with a bare `magick` instead runs under whatever
 * policy the HOST installed — Debian's own `policy.xml` in the CI image, Homebrew's
 * on a Mac — so the same test measures two different ImageMagicks, and a red on
 * one host is a fact about that host's package, not about the engine. The CI image
 * deliberately does NOT install the shipped policy system-wide (ci/Dockerfile: its
 * build context is that one file); the engine's spawns never needed it to.
 *
 * So a test spawn passes this env, exactly as the engine does. Gate:
 * `magick_policy_tripwire` — every ImageMagick spawn under test/ carries
 * MAGICK_CONFIGURE_PATH (directly, or through this helper / magickPolicyEnv).
 *
 * The pixel-cache spill (MAGICK_TMPDIR, required by magickPolicyEnv) goes to a
 * per-process PRIVATE directory under the OS temp dir (scratch_dir.ts): a test fixture is a few hundred
 * pixels and never spills, and the OS temp dir is the suite's scratch, not an
 * installation's database volume.
 */

import { magickPolicyEnv } from '../../src/core/media/engine/binaries.ts';
import { scratchDir } from './scratch_dir.ts';

/** One private spill dir per process (scratch_dir.ts: mkdtemp, 0700), made on first use. */
let spillDir: string | undefined;

export function magickTestEnv(): Record<string, string> {
	spillDir ??= scratchDir('test_magick_spill');
	return magickPolicyEnv(spillDir);
}
