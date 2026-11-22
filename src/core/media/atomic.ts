/**
 * ATOMIC MEDIA WRITER — the ONE way a derivative reaches its final path.
 *
 * Every media producer writes to a unique temp sibling and renames it into place,
 * so a concurrent reader (the web server, a diffusion export, a coexisting
 * process) never sees a partial derivative. That discipline existed as loose
 * copy-paste in `processing.ts`; it lives here as one function because the
 * failure path is what actually matters:
 *
 *   an ImageMagick run that meets a multi-image source writes `<stem>-0.jpg`,
 *   `<stem>-1.jpg`, … instead of the bare temp. The rename then throws ENOENT
 *   and the split files STAY. On 2026-08-04 that left six orphaned
 *   `…tmp.…-N.jpg` files in a live thumb directory with nothing to clean them.
 *
 * So the `finally` here removes the temp AND sweeps `<tempStem>-N<ext>`. The
 * sweep is bounded by the temp's UNIQUE stem, which is what makes it
 * concurrency-safe: it can only ever match files this call produced.
 *
 * WHY A SYNC TWIN EXISTS: its ONE caller is
 * `ingest/staged_name_record.ts`, which stages a record of the uploader's own
 * FILE NAME — a fixed-size string of a few dozen bytes, best-effort, beside a
 * file that has already been moved. Its cost does not scale with a media file,
 * so it cannot stall the event loop the way a whole-file copy does.
 *
 * IT IS NOT A GENERAL ESCAPE HATCH, and it used to be defended as one:
 * `processing.ts::copyToQuality` used it to copy WHOLE MEDIA FILES, arguing that
 * `regenerate3d` was called unawaited from `ingest/process_uploaded_file.ts` and
 * that returning a promise would make a copy failure an unhandled rejection.
 * The concern was real; the remedy was backwards. A floating promise is fixed by
 * awaiting it (or handling it explicitly) at the call site — never by blocking
 * the single event loop of the whole install for the length of a copy. Every one
 * of those call sites already sat inside an async function with a try/catch, so
 * the copy path is now async end to end. Anything whose byte count scales with a
 * file or a subprocess belongs in `writeAtomically`
 * (gate: `test/unit/sync_io_on_request_path_tripwire.test.ts`).
 */

import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { sweepSequenceSiblings } from './engine/imagemagick.ts';
import { assertJobHold } from './job_scope.ts';

/**
 * A unique temp path in the same dir as `target` (atomic-rename staging). The
 * temp name MUST keep the target's extension: ImageMagick/ffmpeg infer the
 * OUTPUT FORMAT from the filename extension, so a temp like `x.jpg.tmp.123`
 * would make ImageMagick fall back to the SOURCE format (e.g. write TIFF bytes
 * into a `.jpg` file — which browsers can't display). Insert the uniqueness
 * BEFORE the extension: `<stem>.tmp.<pid>.<uuid>.<ext>`.
 *
 * The uniqueness suffix is `process.pid` + `crypto.randomUUID()`: the previous
 * `performance.now()` can repeat inside a single millisecond, so two concurrent
 * derivatives of the same target could collide on the same temp — and then each
 * would sweep the other's split siblings.
 */
export function tempSibling(target: string): string {
	const slash = target.lastIndexOf('/');
	const dir = target.slice(0, slash);
	const name = target.slice(slash + 1);
	const dot = name.lastIndexOf('.');
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const ext = dot > 0 ? name.slice(dot) : ''; // includes the leading dot
	const unique = `${process.pid}.${crypto.randomUUID()}`;
	return `${dir}/${stem}.tmp.${unique}${ext}`;
}

/** Ensure the parent dir of `absolutePath` exists. */
export function ensureDir(absolutePath: string): void {
	const dir = dirname(absolutePath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o775 });
}

/**
 * Produce `target` atomically: the producer writes to a temp sibling, which is
 * renamed into place only on success. Returns `target`.
 *
 * Whatever the producer did — success, throw, or the sequence split described in
 * the header — nothing is left behind in the destination directory.
 *
 * `beforeRename` (optional, SYNCHRONOUS by type): a last veto run after the
 * producer and immediately before the rename, with no promise step between the
 * two — a long producer's "is my output still wanted" check (pdf_ocr.ts). A
 * throw discards the temp like a producer throw.
 */
export async function writeAtomically(
	target: string,
	produce: (temp: string) => Promise<void>,
	beforeRename?: () => void,
): Promise<string> {
	ensureDir(target);
	const temp = tempSibling(target);
	try {
		await produce(temp);
		beforeRename?.();
		// A job that LOST its component hold (another instance reclaimed it) must
		// not publish: checked at the last moment before the one publication step
		// (job_scope.ts assertJobHold — a no-op outside a held job).
		assertJobHold();
		renameSync(temp, target);
		return target;
	} finally {
		cleanTemp(temp);
	}
}

/**
 * Synchronous twin of `writeAtomically`, for a FIXED-SIZE payload only (see the
 * header): the one caller is `ingest/staged_name_record.ts`, which writes the
 * uploader's display name as a short string. Never use it for bytes that scale
 * with a media file or a subprocess — that blocks the event loop.
 */
export function writeAtomicallySync(target: string, produce: (temp: string) => void): string {
	ensureDir(target);
	const temp = tempSibling(target);
	try {
		produce(temp);
		renameSync(temp, target);
		return target;
	} finally {
		cleanTemp(temp);
	}
}

/**
 * Run `use` with a temp sibling of `target` that is ALWAYS removed afterwards —
 * for a producer that needs an INTERMEDIATE file rather than a staged final one.
 *
 * The one caller today is the SVG thumb: librsvg renders the vector to a
 * full-resolution PNG, and the ImageMagick thumb recipe reduces THAT (see
 * processing.ts buildThumbVersion). The intermediate is not a version of the
 * record and must never survive the call.
 *
 * IT LIVES HERE BECAUSE TEMP LIFECYCLE DOES. `processing.ts` may not call
 * `rmSync` at all — `media_alternate_versions_tripwire` forbids a hard delete in
 * every twin-producing module, since a file leaving a tier must MOVE into
 * `deleted/` (the No-hard-delete law). That rule cannot distinguish "removes a
 * record's file" from "removes its own scratch", so the scratch is removed where
 * the exemption already holds and is already justified — beside the temp sweep it
 * is the twin of.
 *
 * `extension` carries the leading dot (e.g. '.png'): every media binary infers
 * its output FORMAT from the filename, so the intermediate's extension is a
 * parameter, not the target's.
 */
export async function withTempSibling<T>(
	target: string,
	extension: string,
	use: (temp: string) => Promise<T>,
): Promise<T> {
	ensureDir(target);
	const temp = tempSibling(`${target}${extension}`);
	try {
		return await use(temp);
	} finally {
		cleanTemp(temp);
	}
}

/**
 * Remove the temp and any `<tempStem>-N<ext>` siblings a sequence-emitting
 * producer left. After a successful rename the temp is already gone, so the
 * `rmSync` is a no-op (`force: true`) and the sweep finds nothing — the cost of
 * the happy path is one failed unlink and one directory read.
 */
function cleanTemp(temp: string): void {
	rmSync(temp, { force: true });
	const swept = sweepSequenceSiblings(temp);
	if (swept.length > 0) {
		// Reaching here means the producer emitted a SEQUENCE instead of one file.
		// The write has already failed loudly (runMagickTo throws on it); this line
		// records that the debris was collected, so an orphan in a media dir is
		// again evidence of a bug rather than the normal state of affairs.
		console.warn(
			`media atomic write swept ${swept.length} sequence sibling(s) of ${temp}: ${swept.join(', ')}`,
		);
	}
}
