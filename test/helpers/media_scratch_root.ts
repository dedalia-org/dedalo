/**
 * SCRATCH MEDIA ROOTS FOR GATES — a temp directory that has DECLARED itself one.
 *
 * A media gate builds its situation in a throwaway directory and hands it to a
 * media door as `mediaRoot`. Under the test-media seam every such door asks the
 * directory for a `.dedalo_test_media` marker before it writes
 * (src/core/media/test_media_root.ts), so a scratch root has to carry one.
 *
 * THAT IS NOT BUREAUCRACY, IT IS THE POINT. The refusal cannot ask "is this path
 * under /tmp?" — a path is a claim, and the class of accident being prevented is
 * precisely a root that LOOKS disposable and is not (a symlinked tree, a
 * `join(…, mediaDirFromConfig)` that resolved to the installation's, an env the
 * gate forgot to override). One declaration per scratch root is what makes the
 * guard total, and going through this helper is what makes the declaration
 * automatic rather than remembered.
 *
 * Use `scratchMediaRoot()` to create one, `markMediaRoot()` when the gate
 * already has a directory (a subdirectory of its own scratch tree, say).
 */

import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EXPORT_ARTIFACTS_TEST_MARKER } from '../../tools/tool_export/server/artifact_store.ts';
import { scratchDir } from './scratch_dir.ts';
import { TEST_MEDIA_MARKER, writeMarkerOnce } from './test_media_root.ts';

/** Plant the marker in an existing directory (created if missing). Returns it. */
export function markMediaRoot(dir: string): string {
	mkdirSync(dir, { recursive: true });
	writeMarkerOnce(join(dir, TEST_MEDIA_MARKER), 'scratch media root — a test gate created this\n');
	return dir;
}

/** A fresh, MARKED, private scratch media root under the OS temp dir (scratch_dir.ts). */
export function scratchMediaRoot(label = 'media_scratch'): string {
	return markMediaRoot(scratchDir(label));
}

/**
 * Empty a scratch root and re-declare it — the shape a gate that resets between
 * cases needs, because `rmSync(root, {recursive:true})` takes the marker with it.
 */
export function resetMediaRoot(dir: string): string {
	rmSync(dir, { recursive: true, force: true });
	return markMediaRoot(dir);
}

/**
 * Declare an EXPORT ARTIFACTS scratch root (tool_export's store,
 * tools/tool_export/server/artifact_store.ts): plant its
 * `.dedalo_test_export_artifacts` marker (created if missing). Under the test
 * seam the store refuses every root without it — the same law as a media root.
 */
export function markExportArtifactsRoot(dir: string): string {
	mkdirSync(dir, { recursive: true });
	writeMarkerOnce(
		join(dir, EXPORT_ARTIFACTS_TEST_MARKER),
		'scratch export artifacts root — a test gate created this\n',
	);
	return dir;
}

/**
 * Declare a JOB-REGISTRY scratch dir (src/core/media/jobs.ts pfiles) — defined
 * in the config-free helper so a gate that must not evaluate the engine's
 * config (one that spawns a server child) can import it directly; re-exported
 * here beside its siblings.
 */
export { markProcessesDir } from './test_media_root.ts';
