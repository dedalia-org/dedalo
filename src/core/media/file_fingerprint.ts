/**
 * The FILE IDENTITY of a media file — inode + size + mtime — for a long-running
 * reader that must know, before it writes what it derived, whether the file it
 * read is still the record's (T0-11: the OCR job, and the upload's transcription
 * racing a second upload). A re-upload renames a new file into place, which
 * changes the inode even when size and mtime collide.
 *
 * null = the file is gone or unreadable (never equal to a taken fingerprint).
 */

import { statSync } from 'node:fs';

export function fileFingerprint(path: string): string | null {
	try {
		const stat = statSync(path);
		return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
	} catch {
		return null;
	}
}

/**
 * A `stillCurrent` check bound to `path` as fingerprinted by `taken` (default:
 * NOW): true while the file is still that one. A file unreadable now is never current.
 */
export function stillSameFile(
	path: string,
	taken: string | null = fileFingerprint(path),
): () => boolean {
	return () => taken !== null && fileFingerprint(path) === taken;
}
