/**
 * staged_upload — a file the client staged through core's upload door, read by
 * the action it was staged for. Never a client path: two sanitized names under
 * the caller's own staging dir, rebuilt from the authenticated user id (the
 * pattern of `tool_import_dedalo_csv`'s `processUploadedFile`). A payload too
 * big for a request's `options` (core caps them at 512 KiB, `scalar_bounds.ts`)
 * travels this way: the map capture, an object's GeoJSON; so does the user's
 * vector file.
 */

import { existsSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { DedaloError } from '../../../src/core/errors/index.ts';
import { sanitizeSegment, stagingDir } from '../../../src/core/media/ingest/add_file.ts';
import { deleteStagedFile, listStagedFiles } from '../../../src/core/media/ingest/staged_files.ts';
import type { ToolActionContext } from '../../../src/core/tools/module.ts';
import {
	MAP_IMAGE_KEY_DIR,
	OBJECT_GEOJSON_KEY_DIR,
	VECTOR_UPLOAD_KEY_DIR,
} from '../js/upload_formats.js';
import { uploadStagingBase } from './gdal.ts';
import { invalidOptions } from './reasons.ts';
import { readUtf8File } from './utf8_file.ts';

/** The staged file's absolute path; `door` names the caller to the media-root guard. */
function resolveStagedUpload(
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

/** A payload this old was left by a request that never reached its handler (the
 * network dropped after the upload): a live action takes seconds to minutes. */
export const ORPHAN_UPLOAD_AGE_MS = 60 * 60 * 1000;

/** The key_dirs whose stale files `claimStagedUpload` sweeps before each claim. */
const CONSUMED_KEY_DIRS: readonly string[] = [
	MAP_IMAGE_KEY_DIR,
	OBJECT_GEOJSON_KEY_DIR,
	VECTOR_UPLOAD_KEY_DIR,
];

/**
 * Deletes the caller's own completed files under `keyDir` older than
 * `ORPHAN_UPLOAD_AGE_MS`: core collects abandoned transfers, never a completed file.
 */
function sweepOrphanUploads(userId: number, keyDir: string): void {
	const now = Date.now();
	const dir = stagingDir(userId, keyDir);
	for (const file of listStagedFiles(userId, keyDir)) {
		let modified: number;
		try {
			modified = statSync(resolve(dir, file.name)).mtimeMs;
		} catch {
			continue; // raced with another download's delete: already gone
		}
		if (now - modified > ORPHAN_UPLOAD_AGE_MS) {
			deleteStagedFile(userId, keyDir, file.name);
		}
	}
}

/** A staged payload claimed by its action: `release` deletes it. */
export interface ClaimedUpload {
	path: string;
	release: () => void;
}

/**
 * The file `options.file_data` names, for an action that reads `keyDir`. Pinned
 * to it, because the action deletes what it read: no other staged file of the
 * caller may be named here. The caller's orphans in every consumed key_dir go
 * first, so one left by any action is collected by the next of any kind.
 */
export function claimStagedUpload(
	ctx: ToolActionContext,
	keyDir: string,
	door: string,
): ClaimedUpload {
	const fileData = (ctx.options.file_data ?? {}) as { key_dir?: unknown; tmp_name?: unknown };
	if (fileData.key_dir !== keyDir) {
		throw invalidOptions(`The payload must be staged under '${keyDir}'`);
	}
	for (const consumed of CONSUMED_KEY_DIRS) sweepOrphanUploads(ctx.userId, consumed);
	const tmpName = String(fileData.tmp_name ?? '');
	const path = resolveStagedUpload(ctx.userId, keyDir, tmpName, door);
	return { path, release: () => deleteStagedFile(ctx.userId, keyDir, tmpName) };
}

/**
 * The largest staged JSON read whole into this one process. One object of the
 * map: a 10 MB shapefile upload (`vector_upload.ts`) converts to a few tens of MB
 * at most, and core's own upload ceiling (2 GiB by default) is no bound for it.
 */
export const MAX_STAGED_JSON_BYTES = 64 * 1024 * 1024;

/** A staged JSON payload, read and released before it is parsed. */
export async function takeStagedJson(
	ctx: ToolActionContext,
	keyDir: string,
	door: string,
): Promise<unknown> {
	const claimed = claimStagedUpload(ctx, keyDir, door);
	let text: string;
	try {
		const size = statSync(claimed.path).size;
		if (size > MAX_STAGED_JSON_BYTES) {
			throw invalidOptions(
				`The staged payload (${size} bytes) exceeds the ${MAX_STAGED_JSON_BYTES}-byte limit`,
			);
		}
		// the tool's own client staged it with JSON.stringify: UTF-8, or damaged in transit
		const decoded = await readUtf8File(claimed.path);
		if (decoded === null) throw invalidOptions('The staged payload is not UTF-8');
		text = decoded;
	} finally {
		claimed.release();
	}
	try {
		return JSON.parse(text);
	} catch (error) {
		throw invalidOptions('The staged payload is not JSON', undefined, error);
	}
}
