/**
 * staged_upload — a file the client staged through core's upload door, read by
 * the action it was staged for. Never a client path: two sanitized names under
 * the caller's own staging dir, rebuilt from the authenticated user id (the
 * pattern of `tool_import_dedalo_csv`'s `processUploadedFile`).
 */

import { existsSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { DedaloError } from '../../../src/core/errors/index.ts';
import { sanitizeSegment, stagingDir } from '../../../src/core/media/ingest/add_file.ts';
import { deleteStagedFile, listStagedFiles } from '../../../src/core/media/ingest/staged_files.ts';
import { uploadStagingBase } from './gdal.ts';
import { invalidOptions } from './reasons.ts';

/** The staged file's absolute path; `door` names the caller to the media-root guard. */
export function resolveStagedUpload(
	userId: number,
	rawKeyDir: string,
	rawTmpName: string,
	door: string,
): string {
	if (rawTmpName === '') throw invalidOptions('Missing staged file (tmp_name)');
	const keyDir = rawKeyDir === '' ? '' : sanitizeSegment(rawKeyDir);
	const tmpName = sanitizeSegment(rawTmpName);
	const userStaging = join(uploadStagingBase(door), String(userId));
	const staged = join(userStaging, keyDir, tmpName);
	// the caller's own dir, not the staging base: a sibling user's dir is under the base too
	if (!staged.startsWith(userStaging + sep)) {
		throw new DedaloError('internal.invariant', {
			message: "staged path escapes the caller's upload dir",
		});
	}
	if (!existsSync(staged)) {
		throw new DedaloError('tool.target_not_found', {
			coordinates: { tool: 'tool_uca_maps' },
			message: 'staged file not found',
		});
	}
	return staged;
}

/** A capture this old was left by a request that never reached its handler (the
 * network dropped after the upload): a live download takes seconds to minutes. */
export const ORPHAN_CAPTURE_AGE_MS = 60 * 60 * 1000;

/**
 * Deletes the caller's own completed files under `keyDir` older than
 * `ORPHAN_CAPTURE_AGE_MS`. Only for a key_dir whose one reader deletes what it
 * reads: core collects abandoned transfers, never a completed file.
 */
export function sweepOrphanCaptures(userId: number, keyDir: string): void {
	const now = Date.now();
	const dir = stagingDir(userId, keyDir);
	for (const file of listStagedFiles(userId, keyDir)) {
		let modified: number;
		try {
			modified = statSync(resolve(dir, file.name)).mtimeMs;
		} catch {
			continue; // raced with another download's delete: already gone
		}
		if (now - modified > ORPHAN_CAPTURE_AGE_MS) {
			deleteStagedFile(userId, keyDir, file.name);
		}
	}
}
