/**
 * tool_media_versions handlers — thin wrappers over the media versions core.
 * Each resolves the media context from the request options, runs the operation,
 * and returns the response shape the copied PHP client expects.
 *
 * Response contract (the client reads these verbatim — it is byte-identical to
 * PHP's tool_media_versions.js):
 *  - get_files_info: `result` IS the files_info array (client does
 *    `Array.isArray(response.result) ? response.result : []`). NOT a boolean.
 *  - every other action: `result` is a boolean success flag (the render layer
 *    checks `result===true` / `response.result===true`).
 * files_info is always re-scanned live after a mutation (PHP parity) and the
 * stored cache is written back so a subsequent read is immediately consistent.
 */

import { DedaloError, ok } from '../../../src/core/errors/index.ts';
import {
	type FileInfoEntry,
	type ScanContext,
	scanContextFromItem,
} from '../../../src/core/media/files_info.ts';
import { transcribeStoredPdf } from '../../../src/core/media/ingest/pdf_transcription.ts';
import { buildMediaIdentifier, type MediaIdentity } from '../../../src/core/media/path.ts';
import { regenerateMissingDerivatives } from '../../../src/core/media/repair.ts';
import {
	type MediaToolContext,
	resolveMediaToolContext,
} from '../../../src/core/media/tool_support.ts';
import {
	assertRecordPresent,
	type FilesInfoReconcileResult,
	reconcileStoredFilesInfo,
	repairStoredFilesInfo,
} from '../../../src/core/media/tools/files_info_persist.ts';
import {
	buildVersionCore,
	conformHeadersCore,
	deleteAndResyncCore,
	getFilesInfoCore,
	rotateVersionCore,
} from '../../../src/core/media/tools/versions.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	toolRequestId,
} from '../../../src/core/tools/module.ts';

/** A required option the media action cannot proceed without. */
function missingOption(message: string): DedaloError {
	return new DedaloError('request.invalid_options', { message, publicMessage: message });
}

/**
 * Build the files_info ScanContext from the stored media item for the operated
 * lang (external_source + the original/modified normalized-name twins). Without
 * it, external media never resolves and the raw-original twin is missing — PHP
 * always feeds these from the component's data[0].
 */
function scanContext(mediaContext: MediaToolContext): ScanContext {
	const { items, identity } = mediaContext;
	const item = items.find((entry) => (entry.lang ?? null) === identity.lang) ?? items[0];
	return scanContextFromItem(item);
}

/**
 * Options of a media write-back. `resetDrawing` is set ONLY by the DELETE that
 * removed the record's last media file: the drawing belonged to the deleted
 * picture and is cleared in the same locked write (audited in the Time Machine).
 */
interface WriteBackOptions {
	resetDrawing?: boolean;
	/** The acting user — the Time Machine row's author on a drawing reset. */
	userId?: number;
}

/**
 * Refresh the stored files_info cache after a synchronous mutating op (R1 tail).
 * reconcileStoredFilesInfo NEVER mints: a mutation of files the component does
 * not claim must not create a stored value — only the operator's explicit
 * sync_files repair may (see syncFiles).
 *
 * A vanished record throws (assertRecordPresent) rather than passing silently.
 * The throw travels to the dispatch chokepoint, which converts it into the
 * refusal envelope — so the operator learns the record is gone instead of being
 * told an op landed on nothing.
 */
async function writeBack(
	mediaContext: MediaToolContext,
	freshFilesInfo: FileInfoEntry[],
	options: WriteBackOptions = {},
): Promise<FilesInfoReconcileResult> {
	const { identity } = mediaContext;
	return assertRecordPresent(
		await reconcileStoredFilesInfo(
			{
				sectionTipo: identity.sectionTipo,
				sectionId: identity.sectionId,
				componentTipo: identity.componentTipo,
				lang: identity.lang,
				freshFilesInfo,
			},
			options.resetDrawing === true ? { resetDrawing: true, auditUserId: options.userId } : {},
		),
		identity,
	);
}

/**
 * get_files_info: re-scan and return the current files_info AS `result` (the
 * client contract — result must be the array, not a boolean).
 *
 * `files_info_db` rides along: what the RECORD stores right now, for the same
 * lang, read in the same breath as the disk scan. The panel compares the two to
 * decide whether to raise "files info data is unsync", and it used to take the
 * DB side from the component's CACHED data — a snapshot from when the tool was
 * opened, which no refresh re-reads. So every delete/build raised a false alarm
 * that a page reload made disappear: the two sides of one comparison came from
 * two different moments. This costs nothing — resolveMediaToolContext already
 * loaded the stored items.
 */
export async function getFilesInfo(ctx: ToolActionContext): Promise<ToolResponse> {
	const mediaContext = await resolveMediaToolContext(ctx.options);
	const { spec, identity, pathOpts, items } = mediaContext;
	const filesInfo = getFilesInfoCore(spec, identity, pathOpts, scanContext(mediaContext));
	const item = items.find((entry) => (entry.lang ?? null) === identity.lang) ?? items[0];
	const stored = (item as { files_info?: unknown } | undefined)?.files_info;
	return ok(
		{
			files_info: filesInfo,
			// [] is the honest answer when the component stores nothing: the panel
			// SHOULD warn then, and Regenerate is the documented repair.
			files_info_db: Array.isArray(stored) ? stored : [],
		},
		{ requestId: toolRequestId(ctx) },
	);
}

/**
 * Append a media activity row — 'DELETE FILE' (dd42 code 12) or 'NEW VERSION'
 * (code 16). PHP logs these from the component classes (component_av :1071 /
 * :1223, component_image :1436, component_media_common :1404 / :3069); the TS
 * equivalent of that seam is the tool action, which is where the identity and
 * the client host both exist.
 *
 * `id` is the media identifier (the file's base name) — the v7 analogue of
 * PHP's $this->get_id() for a media component. `parent` is the section_id,
 * matching PHP's key name.
 */
async function logMediaActivity(
	ctx: ToolActionContext,
	what: 'DELETE FILE' | 'NEW VERSION',
	identity: MediaIdentity,
	payload: Record<string, unknown>,
): Promise<void> {
	const { logActivity, hostFromClientIp } = await import(
		'../../../src/core/api/handlers/activity_log.ts'
	);
	await logActivity({
		what,
		tipo: identity.componentTipo,
		userId: ctx.userId,
		host: hostFromClientIp(ctx.clientIp),
		data: {
			...payload,
			tipo: identity.componentTipo,
			parent: String(identity.sectionId),
			id: buildMediaIdentifier(identity),
		},
	});
}

/**
 * build_version: build one quality derivative (av async → job id).
 *
 * `target_extension` (optional) builds EXACTLY ONE file — that tier in that
 * container — for recovering a single alternate twin without re-encoding the
 * tier's own file (and with it any rotation the operator applied). Omitted, the
 * tier is built COMPLETE: its normalized file plus every configured twin.
 *
 * `extension` IS GONE, with no alias (2026-08-07). It looked like a target and
 * was threaded in as the SOURCE selector, so an API caller sending
 * `extension:'avif'` got a jpg built from whichever master that extension
 * happened to resolve — a silent wrong answer. The client never sent it
 * (tool_media_versions.js build_version posts tipo/section/quality/async only),
 * so nothing in the repo loses a capability; a caller that did send it now gets
 * the documented `target_extension` instead of a lie.
 */
export async function buildVersion(ctx: ToolActionContext): Promise<ToolResponse> {
	const mediaContext = await resolveMediaToolContext(ctx.options);
	const { spec, identity, pathOpts } = mediaContext;
	const quality = String(ctx.options.quality ?? spec.defaultQuality);
	const targetExtension =
		typeof ctx.options.target_extension === 'string' ? ctx.options.target_extension : null;
	// The SOURCE selector is not the caller's to choose: it is the raw master
	// extension, resolved from the disk (resolveMaster walks the allowlist).
	const built = await buildVersionCore(
		spec,
		identity,
		pathOpts,
		quality,
		null,
		targetExtension,
		ctx.userId,
	);
	const freshFilesInfo = getFilesInfoCore(spec, identity, pathOpts, scanContext(mediaContext));
	// Persist only for synchronous builds; av transcodes finish in a background
	// job and refresh files_info when the next read/save re-scans.
	if (built.jobId === null) await writeBack(mediaContext, freshFilesInfo);
	await logMediaActivity(ctx, 'NEW VERSION', identity, {
		msg: `Built version. Generated ${spec.model} file`,
		quality,
		source_quality: String(ctx.options.source_quality ?? spec.defaultQuality),
		target_quality: quality,
		...(targetExtension === null ? {} : { target_extension: targetExtension }),
	});
	// The tier BUILT — a twin this host cannot encode is not a failed build, so
	// the envelope stays ok:true and the refusal travels in the PAYLOAD
	// (`summary` + `errors`); throwing here would tell the operator nothing was
	// produced when the tier and its jpg were.
	return ok(
		{
			summary:
				built.errors.length === 0
					? 'ok'
					: `Version built, but not every configured format could be written: ${built.errors.join('; ')}`,
			errors: built.errors,
			built: built.built,
			files_info: freshFilesInfo,
		},
		{ requestId: toolRequestId(ctx), extend: { job_id: built.jobId } },
	);
}

/**
 * sync_files: reconcile the stored files_info against the filesystem (PHP
 * regenerate_component) — re-scan and persist the fresh index; the refreshed
 * index and any per-file rebuild failure come back as the payload.
 */
export async function syncFiles(ctx: ToolActionContext): Promise<ToolResponse> {
	const mediaContext = await resolveMediaToolContext(ctx.options);
	const { spec, identity, pathOpts } = mediaContext;

	// IT REGENERATES BEFORE IT RE-INDEXES — which is what the button has always
	// said and what it never did.
	//
	// The panel's control is labelled "Regenerate files", its tooltip promises
	// "re-create alternatives and thumb", and it ships a "Delete normalized
	// files" checkbox whose value the client dutifully sends as
	// `regenerate_options`. The handler read NONE of it: it re-scanned the disk
	// and persisted the result, so on a record whose derivatives were missing —
	// the exact case the unsync warning appears for — the operator pressed
	// Regenerate, was told "Success", and nothing was built. A control that
	// reports success for work it did not do is worse than a missing control.
	//
	// `regenerateMissingDerivatives` is the same pass tool_update_cache runs
	// (repair.ts): build what is MISSING, never re-encode what is there, with
	// every model's thumb going through the shared handler. Its failures are
	// VALUES — a host that cannot encode one format must not cost the operator
	// the whole repair — and they travel to the panel below.
	const options = (ctx.options.regenerate_options ?? {}) as {
		delete_normalized_files?: unknown;
	};
	const item =
		mediaContext.items.find((entry) => (entry.lang ?? null) === identity.lang) ??
		mediaContext.items[0];
	const originalName = (item as { original_normalized_name?: unknown } | undefined)
		?.original_normalized_name;
	//
	// THE REBUILD MAY NOT COST THE RE-INDEX. Re-indexing is the operation the
	// operator asked for — it is what repairs a record whose files sit on disk
	// while its media key is NULL — and rebuilding is best-effort on top of it.
	// A pass that throws (no master on this box, a binary this host lacks) must
	// therefore become a VALUE here, not a failed request: with an unguarded
	// await, a record with nothing to rebuild FROM answered `result:false` and
	// its index was never repaired. Same doctrine as the twins and the covers,
	// applied to the whole pass.
	let rebuildErrors: string[] = [];
	try {
		rebuildErrors = await regenerateMissingDerivatives(spec.model, spec, identity, pathOpts, {
			// The raw upload extension behind a normalized name (the '.tif' behind a
			// '.jpg'), so the pass resolves the right master — same cue repair.ts uses.
			rawExtension:
				typeof originalName === 'string' ? (originalName.split('.').pop() ?? null) : null,
			deleteNormalized: options.delete_normalized_files === true,
			bulkProcessId: null,
		});
	} catch (error) {
		rebuildErrors = [(error as Error).message];
	}

	const freshFilesInfo = getFilesInfoCore(spec, identity, pathOpts, scanContext(mediaContext));

	// repairStoredFilesInfo: this is the ONE path that may MINT a stored item —
	// a separately-named entry point, not a flag, so no other caller can reach
	// the mint by flipping a boolean. PHP
	// parity, not a new policy. update_component_data_files_info (:3748) minted
	// `{files_info}` from scratch on every save whenever the component's data
	// was empty and the scan found files, with no original_* keys because it
	// knew nothing about provenance. That is exactly the state a persist-less
	// ingest leaves behind: the files sit in image/original + image/1.5MB +
	// image/thumb while the matrix `media` key is NULL, so the widget reports
	// `files_info_db: []` against N disk entries and the record renders
	// nothing. Every OTHER caller uses reconcileStoredFilesInfo, which never
	// mints — a passive scan must not resurrect media someone removed.
	//
	// The emptiness test lives INSIDE the reconcile, under the row lock: a
	// decision taken from the request's snapshot could mint a second item over
	// an upload that committed while the disk scan ran.
	// S2-02 fail-loud: assertRecordPresent throws when the record is gone
	// (deleted mid-flight, or a section with no matrix table) — answering
	// "Success" there tells the operator a repair landed that never did. That
	// state is 'missing', NOT 'noop': a guard on the affected count alone could
	// never see it, because "nothing needed doing" also writes no row.
	const outcome = assertRecordPresent(
		await repairStoredFilesInfo({
			sectionTipo: identity.sectionTipo,
			sectionId: identity.sectionId,
			componentTipo: identity.componentTipo,
			lang: identity.lang,
			freshFilesInfo,
		}),
		identity,
	);
	// THE PDF TRANSCRIPTION (T0-11, decision D2 = b): AFTER the file pass and the
	// re-index (outside its row lock — the text_area save is its own locked
	// transaction), FILL ONLY IF EMPTY. A curated transcription is never replaced
	// by a "Regenerate files" click; no OCR from here. Its failure is a value
	// beside the success, like a rebuild failure.
	const transcription =
		spec.model === 'component_pdf'
			? await transcribeStoredPdf({
					componentTipo: identity.componentTipo,
					sectionTipo: identity.sectionTipo,
					sectionId: identity.sectionId,
					items: mediaContext.items,
					pathOpts,
					userId: ctx.userId,
				})
			: null;
	// A transcription failure travels on the rebuild-failure channel the panel reads.
	// `locked` (a curator held the text_area past the per-record wait) too: nothing
	// was written, and the panel must say so.
	if (transcription?.status === 'failed' || transcription?.status === 'locked') {
		rebuildErrors.push(...transcription.messages);
	}
	const transcriptionNote =
		transcription?.status === 'written'
			? ' — the empty transcription was filled from the PDF text'
			: transcription?.status === 'kept'
				? ' — the transcription was kept (not empty — never overwritten)'
				: '';
	// A derivative that could not be rebuilt is reported BESIDE the success: the
	// re-index really did happen, and telling the operator the whole thing failed
	// would be as wrong as the old silence.
	const note = `${transcriptionNote}${
		rebuildErrors.length === 0
			? ''
			: ` — but ${rebuildErrors.length} file(s) could NOT be rebuilt: ${rebuildErrors.join('; ')}`
	}`;
	return ok(
		{
			summary:
				outcome.action === 'created'
					? `Success. Recorded ${freshFilesInfo.length} file(s) the component had no stored value for.${note}`
					: // 'refreshed' / 'noop': the record exists and now matches the disk.
						`Success. Request done${note}`,
			errors: rebuildErrors,
			files_info: freshFilesInfo,
			transcription: transcription?.status ?? null,
		},
		{ requestId: toolRequestId(ctx) },
	);
}

/**
 * A delete landed, but the follow-up rebuild did not. The delete is NOT undone
 * and `result` stays true — it really happened — so the failure has to travel in
 * the two fields the panel actually reads. `errors` alone was unreachable:
 * render_tool_media_versions.js prints `msg` only when `result===false`, and
 * tool_media_versions.js delete_quality resolves `response.result` and discards
 * the rest of the envelope, so a stale ladder would have been reported to
 * nobody. It is also logged, because the operator's next action depends on it.
 */
function withRebuildFailure(message: string, errors: string[]): string {
	if (errors.length === 0) return message;
	console.error(
		`[tool_media_versions] delete succeeded, tier rebuild failed: ${errors.join('; ')}`,
	);
	return `${message} — WARNING: the derived tiers could NOT be rebuilt from the remaining master and may still show the deleted one: ${errors.join('; ')}`;
}

/**
 * MORE FILES LEFT THE TIER THAN THE OPERATOR NAMED, and they must be told.
 *
 * An alternate-extension twin is a COMPANION of its tier's normalized file
 * (processing.ts buildAlternateVersions): deleting that file takes the twin with
 * it, because a twin left behind is indexed, openable, and — once the jpg is gone
 * — the FIRST entry `files_info` reports for that quality, so every reader that
 * picks a tier by quality alone would serve it. Leaving that unsaid would make one
 * click remove a file the operator never mentioned. Same channel as
 * withRebuildFailure and for the same measured reason: `msg` is what the panel
 * shows, `errors` is what a non-browser caller reads.
 */
function withRetiredTwins(message: string, retired: string[]): string {
	if (retired.length === 0) return message;
	return `${message} — the accompanying alternate version(s) went with it (moved to the deleted folder, recoverable): ${retired.join(', ')}`;
}

/** delete_quality: soft-delete EVERY extension of one quality tier. */
export async function deleteQuality(ctx: ToolActionContext): Promise<ToolResponse> {
	const mediaContext = await resolveMediaToolContext(ctx.options);
	const { spec, identity, pathOpts } = mediaContext;
	const quality = String(ctx.options.quality ?? '');
	if (quality === '') throw missingOption('delete_quality: missing quality');
	// delete → rebuild-if-the-master-changed → re-scan, as ONE core call: the
	// order is the invariant (a scan taken before the rebuild persists tiers
	// that still depict the deleted master) and it is gated there.
	const outcome = await deleteAndResyncCore(
		spec,
		identity,
		pathOpts,
		quality,
		null,
		scanContext(mediaContext),
	);
	await writeBack(mediaContext, outcome.filesInfo, {
		resetDrawing: outcome.noMediaFilesLeft,
		userId: ctx.userId,
	});
	await logMediaActivity(ctx, 'DELETE FILE', identity, {
		msg: 'Deleted media file (file is renamed and moved to delete folder)',
		quality,
	});
	return ok(
		{
			summary: withRetiredTwins(
				withRebuildFailure(`File deleted successfully. ${quality}`, outcome.errors),
				outcome.retired,
			),
			errors: outcome.errors,
			moved: outcome.moved,
			retired: outcome.retired,
			files_info: outcome.filesInfo,
		},
		{ requestId: toolRequestId(ctx) },
	);
}

/** delete_version: soft-delete one quality×extension file (thumb passes its extension). */
export async function deleteVersion(ctx: ToolActionContext): Promise<ToolResponse> {
	const mediaContext = await resolveMediaToolContext(ctx.options);
	const { spec, identity, pathOpts } = mediaContext;
	const quality = String(ctx.options.quality ?? '');
	if (quality === '') throw missingOption('delete_version: missing quality');
	const extension = String(ctx.options.extension ?? spec.defaultExtension);
	// See deleteQuality. Removing ONE extension of a master that still holds
	// another leaves the same file as master, so the rebuild is skipped.
	const outcome = await deleteAndResyncCore(
		spec,
		identity,
		pathOpts,
		quality,
		extension,
		scanContext(mediaContext),
	);
	await writeBack(mediaContext, outcome.filesInfo, {
		resetDrawing: outcome.noMediaFilesLeft,
		userId: ctx.userId,
	});
	await logMediaActivity(ctx, 'DELETE FILE', identity, {
		msg: 'Deleted media file (file is renamed and moved to delete folder)',
		quality,
		extension,
	});
	return ok(
		{
			summary: withRetiredTwins(
				withRebuildFailure('OK file delete successfully', outcome.errors),
				outcome.retired,
			),
			errors: outcome.errors,
			moved: outcome.moved,
			retired: outcome.retired,
			files_info: outcome.filesInfo,
		},
		{ requestId: toolRequestId(ctx) },
	);
}

/** conform_headers: remux an av container's headers (component_av only). */
export async function conformHeaders(ctx: ToolActionContext): Promise<ToolResponse> {
	const mediaContext = await resolveMediaToolContext(ctx.options);
	const { spec, identity, pathOpts } = mediaContext;
	const quality = String(ctx.options.quality ?? '');
	if (quality === '') throw missingOption('conform_headers: missing quality');
	const extension = typeof ctx.options.extension === 'string' ? ctx.options.extension : null;
	await conformHeadersCore(spec, identity, pathOpts, quality, extension);
	const freshFilesInfo = getFilesInfoCore(spec, identity, pathOpts, scanContext(mediaContext));
	await writeBack(mediaContext, freshFilesInfo);
	// PHP logs a remux as NEW VERSION too (component_av :1291) — the container
	// really is rewritten, so the audit trail treats it as a new file version.
	await logMediaActivity(ctx, 'NEW VERSION', identity, {
		msg: 'conform_header av file',
		quality,
	});
	return ok(
		{ summary: 'Rebuilding av file headers', errors: [], files_info: freshFilesInfo },
		{ requestId: toolRequestId(ctx) },
	);
}

/** rotate: rotate one quality tier in place (component_image only). */
export async function rotate(ctx: ToolActionContext): Promise<ToolResponse> {
	const mediaContext = await resolveMediaToolContext(ctx.options);
	const { spec, identity, pathOpts } = mediaContext;
	const quality = String(ctx.options.quality ?? '');
	if (quality === '') throw missingOption('rotate: missing quality');
	if (ctx.options.degrees === undefined || ctx.options.degrees === null) {
		throw missingOption('rotate: missing degrees');
	}
	const degrees = Number(ctx.options.degrees);
	if (Number.isNaN(degrees)) throw missingOption('rotate: invalid degrees');
	const outcome = await rotateVersionCore(
		spec,
		identity,
		pathOpts,
		quality,
		degrees,
		scanContext(mediaContext),
	);
	const freshFilesInfo = getFilesInfoCore(spec, identity, pathOpts, scanContext(mediaContext));
	await writeBack(mediaContext, freshFilesInfo);
	// A rotation that produced nothing IS a failed action (unlike a missing
	// twin above): the operator asked for one file to change and none did.
	if (!outcome.ok) {
		throw new DedaloError('tool.action_failed', {
			coordinates: { tool: 'tool_media_versions', quality, degrees },
			message: `Error on rotate file: ${outcome.errors.join('; ')}`,
		});
	}
	return ok(
		{ summary: 'Success. Request done.', errors: outcome.errors, files_info: freshFilesInfo },
		{ requestId: toolRequestId(ctx) },
	);
}
