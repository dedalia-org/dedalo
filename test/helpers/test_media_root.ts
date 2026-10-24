/**
 * THE ONE PLACE THE TEST MEDIA ROOT'S PATH IS DERIVED — the filesystem twin of
 * `test/helpers/test_database.ts`, shared by the three processes that must agree
 * about it: the `bun test` preload (`test/preload/test_media.ts`), the builder
 * (`scripts/test_db_setup.ts`, which SWEEPS and rebuilds it) and the client
 * suite's own server (`scripts/client_test_server.ts`).
 *
 * WHERE IT LIVES, AND WHY THERE.
 *
 *   <repo>/../private/test_media/<suite database name>/
 *
 * Three properties decide that path, in this order:
 *
 *  1. `../private/` IS ALREADY THE HOME OF PER-INSTALL, NON-SERVED, NON-REPO
 *     STATE — `.env`, the session store, `processes/`, `ts_state.json`. It is
 *     outside every web root by construction (the media-protection subsystem
 *     relies on exactly that for the auth store), outside the repo, and it is
 *     the directory an operator already knows is "this checkout's private
 *     scratch". A test media tree is precisely that kind of thing.
 *  2. KEYED BY THE SUITE DATABASE NAME, because the media tree and the database
 *     are ONE fixture: `files_info.file_path` rows in the database name files in
 *     the tree. Two checkouts, or one checkout with `DEDALO_TEST_DATABASE`
 *     pointed somewhere else, get two trees and never plant one corpus's files
 *     where the other's rows expect them. It is also the reason a rebuild of the
 *     database rebuilds the tree in the same command.
 *  3. IT CANNOT COLLIDE WITH THE INSTALLATION'S `MEDIA_PATH`. The install root is
 *     `<projectRoot>/media` by default and an operator-chosen absolute path
 *     otherwise; neither is ever inside `../private/test_media/`. {@link
 *     assertDistinctFromInstallMediaRoot} proves it rather than assuming it —
 *     the derivation is a convention, and a convention is what the
 *     `.dedalo_test_media` marker exists to stop us from trusting.
 *
 * WHAT THIS MODULE MAY IMPORT. `src/config/env.ts` only, exactly like its
 * database twin: it is loaded BEFORE the process is repointed, and pulling in
 * `src/config/config.ts` would freeze the media root (and the DB connection) at
 * the installation's values before the seam could be set.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { projectRoot, readEnv } from '../../src/config/env.ts';
import { testDatabaseName } from './test_database.ts';

/**
 * The marker file. THE ONE PLACE IN THE TREE THIS LITERAL IS REPEATED, and it is
 * repeated under protest: the canonical constant lives in
 * `src/core/media/test_media_root.ts`, which imports `src/config/config.ts` —
 * importing it HERE would freeze the config (media root and DB connection alike)
 * at the installation's values before the preload could repoint them, which is
 * the same reason `test/helpers/test_database.ts` does not re-export the database
 * guard. `test/unit/test_media_root_tripwire.test.ts` asserts the two literals are
 * identical, so the copy cannot drift.
 */
export const TEST_MEDIA_MARKER = '.dedalo_test_media';

/**
 * Plant a marker file ONCE: created exclusively (`wx`), an existing one left as it
 * is. No exists-then-write window — two processes declaring the same root race
 * on the create itself, and the loser simply finds the marker there.
 */
export function writeMarkerOnce(path: string, body: string): void {
	try {
		writeFileSync(path, body, { flag: 'wx' });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
	}
}

/** `<repo>/../private/test_media` — the parent of every suite's tree. */
export function testMediaBaseDir(): string {
	return resolve(projectRoot, '..', 'private', 'test_media');
}

/**
 * THE path: `<repo>/../private/test_media/<suite db>`. Pure — it neither creates
 * nor checks anything, so a caller can print it in a refusal.
 *
 * PASS `suiteDb` WHEN YOU KNOW IT. `testDatabaseName()` derives `<DB_NAME>_test`,
 * so it answers correctly only while `DB_NAME` still names the APPLICATION
 * database — after a repoint it would derive `<app>_test_test` and a second
 * caller on the other side of the repoint would disagree about where the tree is.
 * `scripts/test_db_setup.ts` and `scripts/client_test_server.ts` therefore pass
 * the name they already resolved; the `bun test` preload runs BEFORE the database
 * preload (bunfig.toml) precisely so the default is the right answer there.
 */
export function testMediaRootPath(suiteDb: string = testDatabaseName()): string {
	// The name reaches the filesystem as a directory segment. A database name is
	// operator-supplied (DEDALO_TEST_DATABASE), so it is sanitized, not trusted.
	const segment = suiteDb.replace(/[^A-Za-z0-9_.-]/g, '_');
	return join(testMediaBaseDir(), segment === '' ? 'dedalo_ts_test' : segment);
}

/**
 * The installation's media root as THIS process would resolve it before any
 * repoint — `MEDIA_PATH`, else the derived `<projectRoot>/media`. Duplicating
 * the derivation is not an option and reading `config.media.rootPath` is not
 * either (importing config here freezes it), so it reads the same two inputs the
 * catalog reads, and {@link assertDistinctFromInstallMediaRoot} is the only
 * consumer.
 */
function installMediaRoot(): string {
	const configured = readEnv('MEDIA_PATH');
	return resolve(
		configured !== undefined && configured !== '' ? configured : join(projectRoot, 'media'),
	);
}

/**
 * REFUSE a test root that is the installation's media root, or inside it, or
 * contains it. This is the check the whole file exists for: everything else is a
 * naming convention, and a naming convention is what let the suite write into a
 * live media tree in the first place.
 */
export function assertDistinctFromInstallMediaRoot(testRoot: string): string {
	const install = installMediaRoot();
	const root = resolve(testRoot);
	if (root === install || root.startsWith(install + sep) || install.startsWith(root + sep)) {
		throw new Error(
			`REFUSING to use '${root}' as the test media root: it is the installation's media root ('${install}'), or one contains the other. The suite must never write into the installation's media tree.`,
		);
	}
	return root;
}

/**
 * Create the test media root and PLANT ITS MARKER. Idempotent — the preload
 * calls it on every `bun test` run, so a developer who has never run
 * `test:db:setup` still gets a marked root instead of a refusal they have to
 * decode.
 *
 * It does NOT sweep: the corpus fixture and the media gates own their own files
 * and clean up after themselves, and a preload that emptied the tree would race
 * a parallel run. Sweeping is {@link rebuildTestMediaRoot}'s job, in the command
 * that rebuilds the database beside it.
 */
export function ensureTestMediaRoot(suiteDb?: string): string {
	const root = assertDistinctFromInstallMediaRoot(testMediaRootPath(suiteDb));
	mkdirSync(root, { recursive: true, mode: 0o775 });
	writeMarkerOnce(
		join(root, TEST_MEDIA_MARKER),
		[
			'This directory is a DÉDALO TEST MEDIA ROOT.',
			'',
			'Its presence is what every media-root door in the engine checks before it',
			'writes, when the process runs under DEDALO_TEST_MEDIA_ROOT',
			'(src/core/media/test_media_root.ts). Everything under this directory is',
			'disposable and is rebuilt by `bun run test:db:setup`.',
			'',
			"NEVER place this file in an installation's media root.",
			'',
		].join('\n'),
	);
	// Its job-registry sibling, declared in the same breath: under the seam the
	// job manager writes pfiles only into a marked dir and never plants the
	// marker itself (src/core/media/jobs.ts assertProcessesDirDeclared).
	markProcessesDir(testProcessesDirPath(root));
	return root;
}

/** Sweep and recreate the tree — `test:db:setup`, beside the database rebuild. */
export function rebuildTestMediaRoot(suiteDb?: string): string {
	const root = assertDistinctFromInstallMediaRoot(testMediaRootPath(suiteDb));
	rmSync(root, { recursive: true, force: true });
	return ensureTestMediaRoot(suiteDb);
}

/**
 * The suite's EXPORT ARTIFACTS root — tool_export's artifact store derives it
 * from the suite media root as its sibling `<root>.export_artifacts`
 * (tools/tool_export/server/artifact_store.ts defaultExportArtifactsRoot, which
 * tool_export_artifact_store_native pins equal to this).
 */
export function testExportArtifactsRootPath(mediaRoot: string): string {
	return `${resolve(mediaRoot)}.export_artifacts`;
}

/**
 * Sweep and recreate the suite's export artifacts root — `test:db:setup`,
 * beside the media tree it is derived from. It is marked
 * `.dedalo_test_export_artifacts` on creation (the store refuses an unmarked
 * root under the seam). A directory at that path WITHOUT the marker is never
 * swept: it did not come from the suite, and the refusal says so.
 */
export async function rebuildTestExportArtifactsRoot(mediaRoot: string): Promise<string> {
	// Lazy: the store module reads the engine config, which a caller of the
	// path helpers above (the preload) must not evaluate early.
	const { EXPORT_ARTIFACTS_DIR_MODE, EXPORT_ARTIFACTS_TEST_MARKER } = await import(
		'../../tools/tool_export/server/artifact_store.ts'
	);
	const dir = testExportArtifactsRootPath(mediaRoot);
	const marker = join(dir, EXPORT_ARTIFACTS_TEST_MARKER);
	if (existsSync(dir) && !existsSync(marker)) {
		throw new Error(
			`[test media] REFUSED to sweep '${dir}': it carries no '${EXPORT_ARTIFACTS_TEST_MARKER}' marker, so it is not the suite's export artifacts root. NOTHING WAS DELETED.`,
		);
	}
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true, mode: EXPORT_ARTIFACTS_DIR_MODE });
	writeFileSync(marker, 'suite export artifacts root — test:db:setup created this\n');
	return dir;
}

/**
 * The job-registry marker — repeated under the same protest as
 * {@link TEST_MEDIA_MARKER} (the canonical constant,
 * src/core/media/test_media_root.ts TEST_PROCESSES_MARKER, imports config);
 * test_media_root_tripwire asserts the two literals are identical.
 */
export const TEST_PROCESSES_MARKER = '.dedalo_test_processes';

/**
 * Declare a JOB-REGISTRY scratch dir (src/core/media/jobs.ts pfiles, the
 * DEDALO_MEDIA_PROCESSES_DIR a gate points at its own tree): plant its
 * `.dedalo_test_processes` marker (created if missing). Under the test seam
 * the job manager refuses every processes dir without it. Returns the dir, so
 * `process.env.DEDALO_MEDIA_PROCESSES_DIR = markProcessesDir(x)` is one step.
 */
export function markProcessesDir(dir: string): string {
	mkdirSync(dir, { recursive: true });
	writeMarkerOnce(
		join(dir, TEST_PROCESSES_MARKER),
		'scratch job-registry dir — a test gate created this\n',
	);
	return dir;
}

/**
 * The suite's JOB-REGISTRY directory — src/core/media/jobs.ts derives it under
 * the seam as the media root's sibling `<root>.processes`
 * (src/core/media/test_media_root.ts testProcessesDirFor; the tripwire pins the
 * two equal).
 */
export function testProcessesDirPath(mediaRoot: string): string {
	return `${resolve(mediaRoot)}.processes`;
}

/**
 * Sweep and recreate the suite's job-registry directory — `test:db:setup`,
 * beside the media tree it is derived from, re-marked
 * `.dedalo_test_processes`. A directory at that path WITHOUT the marker is never
 * swept: it did not come from the suite.
 */
export function rebuildTestProcessesDir(mediaRoot: string): string {
	const dir = testProcessesDirPath(mediaRoot);
	const marker = join(dir, TEST_PROCESSES_MARKER);
	if (existsSync(dir) && !existsSync(marker)) {
		throw new Error(
			`[test media] REFUSED to sweep '${dir}': it carries no '${TEST_PROCESSES_MARKER}' marker, so it is not the suite's job-registry directory. NOTHING WAS DELETED.`,
		);
	}
	rmSync(dir, { recursive: true, force: true });
	return markProcessesDir(dir);
}
