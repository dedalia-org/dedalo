/**
 * THE ASYNC TWIN of the durability kernel (core/files/durable.ts) — the same
 * publication shape (temp sibling → fsync → rename → directory fsync), on
 * node:fs/promises, for writers the SERVER reaches whose payload must not block
 * the one event loop: the master's ontology export files (data_io.ts, U-21) and
 * the code-update sentinel (update/code_update.ts, update/boot_confirm.ts, U-19).
 *
 * It shares the kernel's two definitions instead of copying them: the temp-name
 * grammar (temp_path.ts tempPathFor — so the sweepers recognize a leftover) and
 * "this filesystem has no directory fsync" (durable.ts directoryFsyncUnsupported).
 * A reader sees the old bytes or the new, never a torn file; after it resolves
 * the new bytes and their name survive a power cut.
 */

import { open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { directoryFsyncUnsupported } from './durable.ts';
import { tempPathFor } from './temp_path.ts';

/**
 * fsync one path. A directory's fsync makes a rename in it durable; a
 * filesystem without that guarantee is said loudly by the kernel's predicate,
 * never a failed write.
 */
export async function syncPathAsync(path: string, directory: boolean): Promise<void> {
	const handle = await open(path, 'r');
	try {
		await handle.sync();
	} catch (error) {
		if (!directory || !directoryFsyncUnsupported(path, error)) throw error;
	} finally {
		await handle.close();
	}
}

/** Publish an already-written temp sibling over `target`: fsync it, rename it, fsync the directory. */
export async function publishTempAsync(temp: string, target: string): Promise<void> {
	await syncPathAsync(temp, false);
	await rename(temp, target);
	await syncPathAsync(dirname(target), true);
}

/**
 * Atomically and durably replace `target` with `text`. On any failure the
 * previous `target` is untouched and no temp is left behind. Returns the byte
 * count written. `mode` applies to a newly created file (default 0644).
 */
export async function writeTextFileDurablyAsync(
	target: string,
	text: string,
	options: { mode?: number } = {},
): Promise<number> {
	const temp = tempPathFor(target);
	try {
		const bytes = Buffer.from(text, 'utf8');
		// 'wx' refuses a name that exists: what it refuses is not ours to remove.
		const handle = await open(temp, 'wx', options.mode ?? 0o644);
		try {
			await handle.writeFile(bytes);
		} finally {
			await handle.close();
		}
		await publishTempAsync(temp, target);
		return bytes.length;
	} finally {
		await rm(temp, { force: true });
	}
}
