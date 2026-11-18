/**
 * staged_upload — a file the client staged through core's upload door, read by
 * the action it was staged for. Never a client path: two sanitized names under
 * the caller's own staging dir, rebuilt from the authenticated user id (the
 * pattern of `tool_import_dedalo_csv`'s `processUploadedFile`).
 */

import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { DedaloError } from '../../../src/core/errors/index.ts';
import { sanitizeSegment } from '../../../src/core/media/ingest/add_file.ts';
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
