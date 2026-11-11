/**
 * PROCESS_UPLOADED_FILE — the ingest orchestrator (PHP tool_upload::
 * process_uploaded_file → component process_uploaded_file → regenerate_component).
 *
 * Moves the staged upload into its target tier (add_file), builds the
 * derivatives per type (image/pdf/svg/3d synchronously; av transcode via the job
 * manager), and returns the freshly-scanned files_info. No master is mutated on
 * THIS path — an upload only ever adds one; derivatives are atomic. (The one
 * deliberate master mutation in the engine is tool_image_rotation, which rotates
 * the RETOUCHED master in place on purpose — see tools/rotation.ts. The archival
 * original is never mutated anywhere.)
 *
 * TWO MASTERS (2026-08-07): the target tier is either a MASTER — the archival
 * original, or, for an image, the human-retouched one — or a real derivative
 * tier, and the two take different branches. See isMasterTier below and
 * MediaTypeSpec.masterQualities for the domain model.
 *
 * ORDERING LAW (2026-08-04): the derivative pass is NON-FATAL and reports
 * through IngestResult.derivativeErrors, because it runs AFTER add_file has
 * irreversibly moved the staged upload. Only the pre-move assertions and the
 * move itself may abort an ingest — see IngestResult.derivativeErrors.
 */

import { existsSync } from 'node:fs';
import {
	assertAllowedExtension,
	assertIngestableQuality,
	assertNormalizedExtensionForTier,
	hasPosterframe,
	type MediaTypeSpec,
	mediaTypeOf,
} from '../../concepts/media.ts';
import { DedaloError } from '../../errors/dedalo_error.ts';
import { currentDataLang } from '../../resolve/request_lang.ts';
// The av encoder lives in ../av_versions.ts — ONE encoder for ingest and for the
// media-versions tool's per-quality build (see that module's header).
import { submitAvTranscode } from '../av_versions.ts';
import { fileFingerprint, stillSameFile } from '../file_fingerprint.ts';
import { moveToDeleted } from '../file_ops.ts';
import { type FileInfoEntry, scanContextFromItem, scanFilesInfo } from '../files_info.ts';
import { completeMediaPathOptions } from '../ontology_path.ts';
import {
	buildMediaIdentifier,
	buildMediaLocation,
	type MediaIdentity,
	type MediaPathOptions,
	mediaThumbLocation,
	posterframeLocation,
} from '../path.ts';
import { stopLiveOcr, submitPdfOcr } from '../pdf_ocr.ts';
import {
	buildMasterNormalizedCopy,
	noteOutrankingMaster,
	regenerate3d,
	regenerateImage,
	regeneratePdf,
	regenerateSvg,
	resolveMasterSource,
} from '../processing.ts';
import { regenerateMissingDerivatives } from '../repair.ts';
import { readStoredMediaItems } from '../tool_support.ts';
import { type AddFileInput, addFile, stagingDir } from './add_file.ts';
import { writeMediaCompanions } from './companion_writes.ts';
import { fireMediaIngestEvent } from './ingest_event.ts';
import { type PdfTranscriptionOutcome, transcribePdf } from './pdf_transcription.ts';
import { forgetStagedDisplayName, readStagedDisplayName } from './staged_name_record.ts';

export interface IngestInput extends Omit<AddFileInput, 'spec'> {
	spec: MediaTypeSpec;
	/**
	 * The upload's processing options (tool_upload `process_options`, validated
	 * there — T0-11). Only a component_pdf MASTER upload reads them: `ocr` hands
	 * back the OCR job (pdf_ocr.ts) in `ocrLang` (a Dédalo `lg-xxx`; absent → the
	 * request's data lang) when the ingested master is a `.pdf` — a non-PDF master
	 * gets a notice and no job. Every other caller passes nothing: OCR off.
	 */
	processOptions?: IngestProcessOptions;
}

/** See IngestInput.processOptions. */
export interface IngestProcessOptions {
	ocr?: boolean;
	ocrLang?: string;
}

/**
 * Whether the target tier is a MASTER (`spec.masterQualities` — see that field:
 * an image has TWO, the archival original and the human-retouched one). It
 * selects WHICH regenerate runs, never whether one runs at all:
 *
 * - a master tier → the ingest builders, which re-encode UNCONDITIONALLY, from
 *   whichever master now outranks the others. A new master is a new statement
 *   about what this record looks like, so every derived tier — the web quality,
 *   the thumb, the SVG envelope, and any higher tier already on disk — is
 *   rebuilt to depict it. That is the same treatment a fresh original has always
 *   had; before 2026-08-07 the RETOUCHED tier did not get it, so uploading a
 *   retouch onto a record that already had tiers changed nothing visible;
 * - any other tier → `regenerateMissingDerivatives` (v6 regenerate_component
 *   parity): the default quality only when ABSENT — so the file the operator
 *   just placed is never overwritten — the image thumb ALWAYS, rebuilt from the
 *   default-quality file, and the SVG envelope created-or-path-fixed. Correct
 *   for a real derivative tier: a file parked in '6MB' IS that tier, nothing
 *   derives from it.
 *
 * PHP called regenerate_component either way; skipping it for a derivative
 * tier would leave the thumb showing the PREVIOUS image while the web tier
 * serves the new one, and persist a files_info recording exactly that mismatch.
 */
export function isMasterTier(spec: MediaTypeSpec, quality: string | undefined): boolean {
	return quality === undefined || spec.masterQualities.includes(quality);
}

/**
 * Whether this upload replaces the ARCHIVAL tier's stored name cue — a DIFFERENT
 * question from isMasterTier, and the reason the two are not one boolean.
 *
 * Only the original tier's own cue is replaced, by what was just stored. A
 * RETOUCH is a master (it re-encodes the derived tiers) but it must answer NO
 * here: stamping `original_normalized_name` with the retouch's name loses the raw
 * original from the index, and taking the original's branch also DISCARDS the
 * record's stored cues (`external_source`, the two normalized-name twins), which
 * describe files the retouch did not replace.
 *
 * EXPORTED so the disagreement is gateable as a fact rather than as a shape.
 * NOT GATED end to end, and deliberately said out loud: the discarded-cues half
 * is only observable on a component that actually STORES cues, which needs the
 * stored-item read stubbed — and `mock.module` on `tool_support.ts` is not
 * reliable here, because bun runs test files in one process in a
 * non-deterministic order and another file's config mock clobbers it (measured:
 * green alone, red in the suite, in BOTH file orders). A DB-backed gate on a
 * scratch record is the durable fix.
 */
export function replacesArchivalCue(spec: MediaTypeSpec, quality: string | undefined): boolean {
	return quality === undefined || quality === spec.originalQuality;
}

export interface IngestResult {
	/**
	 * The STORED original's file name + extension — the deterministic media
	 * identifier ('rsc35_rsc167_12.mp4'), i.e. PHP's `ready.full_file_name`.
	 * Despite the name it is NOT what the record's `original_file_name` key should
	 * hold; that is {@link humanFileName}.
	 */
	originalFileName: string;
	/**
	 * The name the CURATOR uploaded ('María Piñón entrevista.mp4') — PHP's
	 * `ready.original_file_name`. This is the value the record's provenance keys
	 * and the `target_filename` companion field must carry. Persisting the staged
	 * name instead is the audit's "upload loses the human filename".
	 */
	humanFileName: string;
	extension: string;
	/** Fresh files_info after derivative generation. */
	filesInfo: FileInfoEntry[];
	/**
	 * Every NON-FATAL post-move failure, one message per failing pass: the
	 * derivative builds AND (since 2026-08-09) the ontology-declared companion
	 * writes (`properties.target_filename` / `target_duration` — companion_writes.ts).
	 * The key keeps its name because it is the channel every caller already
	 * surfaces, and both classes share the one property that defines it: the file
	 * has landed and is indexed, but something the ontology asked for around it did
	 * not happen.
	 *
	 * EMPTY on success —
	 * a non-empty array means the ORIGINAL landed and is indexed, but one or more
	 * derived tiers (thumb / web quality / SVG envelope / an alternate-extension
	 * twin) are missing. The twin entries name their config key, because "this
	 * host cannot encode what DEDALO_IMAGE_ALTERNATIVE_EXTENSIONS asks for" is an
	 * operator decision, not a bug report.
	 *
	 * Why these are NOT thrown (2026-08-04): by the time the derivative pass runs,
	 * `addFile` has already moved the staged upload IRREVERSIBLY into the original
	 * tier. A throw past that point unwinds the caller before it can persist
	 * files_info, so the record ends up created, portal-linked, with the original
	 * on disk and `matrix.media` NULL — the file exists but no record knows it,
	 * the staged source is consumed, and the import cannot be retried. That was
	 * the measured state of records 440866/440867.
	 *
	 * v6 behaved the same way on purpose: component_image::create_thumb returned
	 * false and logged; it never aborted an ingest. The asymmetry is the point —
	 * a missing tier is rebuildable at any time (tool_media_versions, repair.ts,
	 * regenerateMissingDerivatives), a lost index is not.
	 *
	 * Callers MUST surface these (they are real failures, not noise); every
	 * consumer routes them into the channel it already has. See
	 * tools/tool_import_files, tools/tool_upload and src/ai/mcp/tools/media.ts.
	 */
	derivativeErrors: string[];
	/**
	 * NON-failures the operator must still see (T0-11 decision D1 = c): today the
	 * PDF transcription's "replaced N chars of existing transcription" — the
	 * upload did what it should, and it overwrote curated text Time Machine
	 * keeps. A sibling of `derivativeErrors`, not part of it: a replacement is not
	 * an error, and a tool that renders the two alike tells the curator something
	 * failed when nothing did.
	 */
	notices: string[];
	/**
	 * For a `.pdf` master uploaded with `processOptions.ocr`: START the OCR job of
	 * THAT file (pdf_ocr.ts; throws on a refusal). DEFERRED for startTranscode's reason — the job writes
	 * files_info back onto the record, so the caller starts it AFTER its own
	 * persist commits. null otherwise.
	 */
	startOcr: (() => string) | null;
	/**
	 * For av: START the transcode. DEFERRED on purpose — the job writes its
	 * finished files_info back onto the record, so it must not be racing the
	 * caller's own persist of the ingest-time scan. Call it AFTER that persist
	 * commits and the ordering is an invariant instead of a probability. null for
	 * every other type (and for an av upload that needs no transcode).
	 */
	startTranscode: (() => string) | null;
}

/**
 * Ingest a staged upload for a media component. Synchronous derivative types
 * return complete files_info; av returns a DEFERRED `startTranscode` plus
 * files_info for whatever exists so far (the client polls the job; the job
 * writes the finished index back onto the record itself — see submitAvTranscode,
 * and IngestResult.startTranscode for why the caller starts it).
 *
 * `input.quality` (the client's custom_target_quality / tool_upload's quality)
 * chooses the target tier. A MASTER tier re-encodes the derived tiers from the
 * best master; any other tier parks the upload and builds only what is missing
 * around it — see isMasterTier.
 */
/**
 * RETIRE the posterframe and the thumb that depict a master this record no longer
 * holds — the invalidation half of the thumb rule (thumb.ts), for the two models
 * whose thumb does not come from the delivered file.
 *
 * Both go to `deleted/` (never unlink): on a partial-media box, and on a mistaken
 * re-upload, those bytes are one move away. Returns non-fatal messages only —
 * failing to retire must never fail an upload that already landed.
 */
function retireStalePosterframeAndThumb(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	pathOpts: MediaPathOptions,
): string[] {
	if (!hasPosterframe(spec.model)) return [];
	try {
		const poster = posterframeLocation(spec, identity, pathOpts);
		if (poster !== null && existsSync(poster.absolutePath)) {
			moveToDeleted(poster.absolutePath, { mediaRoot: pathOpts.mediaRoot });
		}
		const thumb = mediaThumbLocation(spec, identity, pathOpts);
		if (thumb !== null && existsSync(thumb.absolutePath)) {
			moveToDeleted(thumb.absolutePath, { mediaRoot: pathOpts.mediaRoot });
		}
		return [];
	} catch (error) {
		return [
			`retiring the previous posterframe/thumb of ${buildMediaIdentifier(identity)}: ${(error as Error).message}`,
		];
	}
}

/**
 * THE NORMALIZED MASTER COPY of the tier this upload landed in —
 * `<id>.<defaultExtension>` beside the raw (Original law; see
 * buildMasterNormalizedCopy). It must be written by the INGEST, not by
 * regenerateImage: only the ingest knows the tier that received the file and
 * the extension it arrived with, and a build driven from "whichever master
 * resolves" would let a leftover raw in another tier become this tier's
 * picture.
 *
 * The target is the tier just written (a `.tif` into 'modified' gets its copy
 * in 'modified'). Non-fatal like every other post-move step — the raw landed
 * and is indexed either way — so a failure joins `derivativeErrors`.
 */
async function noteMasterCopy(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	pathOpts: MediaPathOptions,
	quality: string | null | undefined,
	rawExtension: string | null,
	derivativeErrors: string[],
): Promise<void> {
	const targetQuality = quality ?? spec.originalQuality;
	try {
		await buildMasterNormalizedCopy(spec, identity, targetQuality, pathOpts, {
			rawExtension,
			rebuild: true,
		});
	} catch (error) {
		derivativeErrors.push(`${targetQuality}.${spec.defaultExtension}: ${(error as Error).message}`);
	}
}

/** What the PDF text pass of one ingest produced (see transcribeUploadedPdf). */
interface UploadedPdfText {
	errors: string[];
	notices: string[];
	startOcr: (() => string) | null;
}

/**
 * The PDF text of a new PDF MASTER (T0-11): ALWAYS transcribed now, in
 * `overwrite` mode (D1 = c), from the master JUST INGESTED (`masterFile` — never
 * the default tier, which a failed rebuild may leave holding the previous
 * document). With `processOptions.ocr` the OCR job is handed back too; it
 * overwrites again when it finishes (pdf_ocr.ts). Non-fatal: failures are values.
 */
async function transcribeUploadedPdf(
	input: IngestInput,
	pathOpts: MediaPathOptions,
	isMaster: boolean,
	masterFile: string,
): Promise<UploadedPdfText> {
	const { spec, identity, userId } = input;
	// A PDF MASTER only: a file parked in a derivative tier says nothing new.
	if (spec.model !== 'component_pdf' || !isMaster) {
		return { errors: [], notices: [], startOcr: null };
	}
	// The master's identity AS INGESTED, captured once: the transcription's
	// staleness check and the OCR job (submitPdfOcr) both bind to it.
	const fingerprint = fileFingerprint(masterFile);
	const transcription = await transcribePdf({
		spec,
		identity,
		pathOpts,
		userId,
		mode: 'overwrite',
		source: masterFile,
		// Bound to the master AS INGESTED, before the extraction: a second upload
		// landing meanwhile makes this (older) text `superseded`, never last-wins.
		stillCurrent: stillSameFile(masterFile, fingerprint),
	});
	if (input.processOptions?.ocr !== true) return { ...uploadText(transcription), startOcr: null };
	return ocrHandoff(input, pathOpts, { file: masterFile, fingerprint }, transcription);
}

/**
 * The transcription outcome on the upload's two channels: a `superseded` text (a
 * newer upload of this record landed while it was extracted) is a NOTICE —
 * nothing failed, the newer master's text is the one that stands.
 */
function uploadText(transcription: PdfTranscriptionOutcome): Omit<UploadedPdfText, 'startOcr'> {
	if (transcription.status === 'superseded') {
		return { errors: [], notices: [...transcription.notices, ...transcription.messages] };
	}
	return { errors: transcription.messages, notices: transcription.notices };
}

/**
 * The OCR the upload asked for: handed back unstarted with the JUST-INGESTED
 * master (never re-resolved — pdf_ocr.ts PdfOcrRequest.master), or, for a master
 * that is not a PDF, a notice and no job.
 */
function ocrHandoff(
	input: IngestInput,
	pathOpts: MediaPathOptions,
	master: { file: string; fingerprint: string | null },
	transcription: PdfTranscriptionOutcome,
): UploadedPdfText {
	const refused = ocrRefusal(master.file, transcription);
	if (refused !== null) {
		const text = uploadText(transcription);
		return { errors: text.errors, notices: [...text.notices, refused], startOcr: null };
	}
	const { spec, identity, userId } = input;
	// The lang is read NOW (the request's), not inside the deferred call.
	const ocrLang = input.processOptions?.ocrLang ?? currentDataLang();
	return {
		...ocrPendingText(transcription),
		startOcr: (): string =>
			submitPdfOcr({
				spec,
				identity,
				pathOpts,
				userId,
				ocrLang,
				master: master.file,
				masterFingerprint: master.fingerprint,
			}),
	};
}

/**
 * Why no OCR is handed back for this upload, or null: a master that is not a
 * PDF, or one a NEWER upload already replaced (its transcription came back
 * `superseded`) — starting it would OCR the newer upload's file and stop that
 * upload's own job. Exported as the seam its gate drives (the superseded race is
 * not reproducible on demand).
 */
export function ocrRefusal(
	masterFile: string,
	transcription: PdfTranscriptionOutcome,
): string | null {
	if (!masterFile.toLowerCase().endsWith('.pdf')) {
		return 'OCR needs a PDF master — the uploaded file is not a PDF, no OCR was started';
	}
	if (transcription.status === 'superseded') {
		return 'OCR not started — a newer upload of this record replaced the master meanwhile (its own OCR request stands)';
	}
	return null;
}

/**
 * A NEW MASTER of a component_pdf — a PDF or not — supersedes any OCR still
 * running on the old one: stopped BEFORE the move, so a job on the old file
 * cannot pass its final check in the window the move and the derivative builds
 * open (a `.doc` over a `.pdf` leaves the old PDF on disk, so the job's own
 * fingerprint check would never see that change).
 */
function supersedeLiveOcr(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	quality: string | undefined,
): void {
	if (spec.model === 'component_pdf' && isMasterTier(spec, quality)) stopLiveOcr(spec, identity);
}

/**
 * The upload's text outcome while an OCR is pending, said honestly: an image-only
 * master's "no text layer" is not a failure then (the OCR is what writes it), and
 * text written now is announced as provisional.
 */
function ocrPendingText(transcription: PdfTranscriptionOutcome): Omit<UploadedPdfText, 'startOcr'> {
	const target = transcription.targetTipo ?? 'transcription';
	if (transcription.status === 'no_text') {
		return {
			errors: [],
			notices: [
				`transcription '${target}': no text layer yet — the OCR job writes it when it finishes`,
			],
		};
	}
	if (transcription.status !== 'written') return uploadText(transcription);
	return {
		errors: [],
		notices: [
			...transcription.notices,
			`transcription '${target}': written from the uploaded PDF's own text layer — the OCR job replaces it when it finishes`,
		],
	};
}

export async function processUploadedFile(input: IngestInput): Promise<IngestResult> {
	const { spec, identity } = input;
	// RECORD-SCOPED PATH OPTIONS. `properties.additional_path` names a sibling
	// component whose value ON THIS RECORD is the bucket folder, so the options a
	// caller resolved from (component, section) alone cannot carry it. Completing
	// them here — before add_file computes a single path — is what makes the
	// ingest write where PHP wrote; a caller that already resolved the record form
	// stays authoritative (completeMediaPathOptions never overrides).
	const pathOpts = await completeMediaPathOptions(identity, input.pathOpts);
	// '' is "unset", not a tier: the client sends an empty selector value, and
	// tool_upload / tool_import_files must not disagree about what it means. One
	// normalisation for every entry point.
	const quality = input.quality === undefined || input.quality === '' ? undefined : input.quality;
	// Refuse an impossible target BEFORE the file is moved — a rejected upload
	// must leave the staging dir and the media tree exactly as they were. Both
	// rules live beside assertValidQuality (concepts/media.ts) so their carve-out
	// lists cannot drift from that one's: a DERIVED tier is unscannable, and a
	// non-normalized extension in a derivative tier is shadowed by the tier's
	// canonical file.
	if (quality !== undefined) {
		assertIngestableQuality(spec, quality);
		assertNormalizedExtensionForTier(spec, quality, assertAllowedExtension(spec, input.extension));
	}
	// THE CURATOR'S FILE NAME, recovered from the SERVER (staged_name_record.ts).
	//
	// This is the line that makes the human-filename restoration reach production.
	// The receiver knows the display name; the ingest is a LATER request and is
	// handed only `tmp_name`, the sanitized staged segment. Relaying the name
	// through the client would have required all three ingest callers (tool_upload,
	// tool_import_files, the MCP media tool) to forward it, and none of them did —
	// so the first attempt, wired only at the transport, recorded the staged name
	// exactly as before. Read BEFORE add_file: the move is what consumes the staged
	// file, and the record is dropped with it.
	const stagingRoot = stagingDir(input.userId, input.keyDir, pathOpts.mediaRoot);
	const recordedFileName = readStagedDisplayName(stagingRoot, input.tmpName);
	supersedeLiveOcr(spec, identity, quality);
	const added = addFile({ ...input, pathOpts, quality, recordedFileName });
	// The staged file is gone (add_file renamed it into the media tree), so its
	// name record describes nothing. Dropped here rather than by the sweeper so an
	// ingested file leaves no residue at all.
	forgetStagedDisplayName(stagingRoot, input.tmpName);
	// TWO DIFFERENT QUESTIONS, deliberately not one boolean:
	//  - isMaster decides whether the derived tiers are re-encoded from this file
	//    (any master does that — original OR retouched);
	//  - isOriginal decides which stored name cue this upload replaces, and that
	//    is the ARCHIVAL tier's cue alone. A retouch must not overwrite
	//    original_normalized_name (it would lose the raw original from the index);
	//    its own twin is stamped by the caller through nameKeysForQuality.
	const isMaster = isMasterTier(spec, quality);
	const isOriginal = replacesArchivalCue(spec, quality);

	let startTranscode: (() => string) | null = null;
	// NON-FATAL FROM HERE ON. The catch covers EXACTLY the derivative pass, and
	// nothing else: everything above it either runs BEFORE the move
	// (assertIngestableQuality / assertNormalizedExtensionForTier) or IS the move
	// (addFile), and those must stay fatal — a refused upload has to leave the
	// staging dir and the media tree untouched. Everything below it (the
	// files_info scan, the ingest event, the av submit) is what turns the moved
	// file into an INDEXED file, and is precisely what a derivative throw used to
	// skip. See IngestResult.derivativeErrors for the full rationale.
	const derivativeErrors: string[] = [];
	try {
		if (isMaster) {
			// THE SURPRISE, SAID OUT LOUD: the retouched master outranks the original
			// as the derivative source for as long as it exists, so ingesting a fresh
			// ORIGINAL onto a record that already carries a retouch rebuilds the derived
			// tiers FROM THE RETOUCH — the new scan lands in the archive and is indexed,
			// but the visible image does not change. That is the intended domain rule
			// (v6 get_image_source), and it is exactly the kind of thing an operator
			// cannot deduce from a successful upload, so it names the record.
			//
			// The EFFECTIVE target is what the notice compares against, not the raw
			// `quality`: an unset selector normalises to `undefined` here, and
			// comparing a tier name to `undefined` fired the line on EVERY ordinary
			// upload — claiming 'original' outranked 'original' — which is exactly
			// the noise that would bury the one case it exists for.
			noteOutrankingMaster(spec, identity, pathOpts, quality ?? spec.originalQuality, 'uploaded');
			switch (spec.model) {
				case 'component_image': {
					// THE TWIN CHANNEL (2026-08-07). regenerateImage builds the configured
					// alternate-extension twins, and a twin failure is NON-FATAL there by
					// design — a host with no AVIF delegate must still get its jpg ladder.
					// So its `errors` MUST be threaded here: `derivativeErrors` is otherwise
					// populated at exactly ONE site (the catch below), and without this line
					// a box that cannot write the configured format would report every
					// upload as a complete success while that format was silently never
					// produced — the exact "config read, never honoured" defect this
					// subsystem exists to end.
					const outcome = await regenerateImage(spec, identity, pathOpts, added.extension);
					derivativeErrors.push(...outcome.errors);
					// THE NORMALIZED MASTER COPY — written HERE because only the ingest
					// knows the tier that received the file (see noteMasterCopy).
					await noteMasterCopy(
						spec,
						identity,
						pathOpts,
						quality,
						added.extension,
						derivativeErrors,
					);
					break;
				}
				case 'component_pdf':
					// Same channel as the image twins above: a cover format this host
					// cannot encode is non-fatal, and without this line the upload would
					// be reported as a complete success while the configured cover was
					// never written.
					derivativeErrors.push(...(await regeneratePdf(spec, identity, pathOpts)).errors);
					break;
				case 'component_svg':
					// Same channel again: the web copy landed, but a host with no SVG
					// rasterizer cannot build the thumb, and an upload reported as a
					// complete success would leave the operator hunting for a thumbnail
					// nothing is going to write.
					derivativeErrors.push(...(await regenerateSvg(spec, identity, pathOpts)).errors);
					break;
				case 'component_3d':
					await regenerate3d(spec, identity, pathOpts, added.extension);
					// A NEW MESH MAKES THE OLD PICTURE A LIE. The posterframe and the
					// thumb depict the model that was just replaced, and nothing here can
					// re-render a mesh — so both are RETIRED to deleted/ rather than left
					// serving. The browser normally captures a new posterframe seconds
					// later (component_3d.upload_handler); until it does, the record shows
					// its placeholder, which is the honest state.
					derivativeErrors.push(...retireStalePosterframeAndThumb(spec, identity, pathOpts));
					break;
				// component_av: submitted LAST, below — see the barrier note there.
			}
		} else {
			// A real DERIVATIVE tier: build only what is MISSING around the file just
			// placed (see isMasterTier). regenerateMissingDerivatives has no
			// component_av branch — av derivatives are an async transcode — so the av
			// case is handled with the submit below.
			// Its NON-FATAL failures (a twin this host cannot encode) come back as
			// values, and are threaded for the same reason as the master branch above.
			derivativeErrors.push(
				...(await regenerateMissingDerivatives(spec.model, spec, identity, pathOpts, {
					rawExtension: added.extension,
					deleteNormalized: false,
					bulkProcessId: null,
				})),
			);
		}
	} catch (error) {
		// Never swallowed: logged here for the operator's server log AND returned
		// so the calling tool can put it in front of the user (the scan below
		// records which tiers actually exist, so the record stays honest about it).
		const message = (error as Error).message;
		derivativeErrors.push(message);
		console.warn(
			`[process_uploaded_file] derivative build failed for ${spec.model} ${identity.componentTipo}_${identity.sectionTipo}_${identity.sectionId}: ${message}`,
		);
	}

	// THE ONTOLOGY-DECLARED COMPANION WRITES (properties.target_filename /
	// target_duration — companion_writes.ts). Run here, after the derivative pass
	// and before the index is written, because that is where PHP ran them and
	// because the duration is measured from the file add_file has just placed.
	//
	// Same non-fatal posture and same channel as the derivative failures above:
	// past the move, nothing may abort the ingest, and a companion the ontology
	// asked for and did not get is a real failure that has to reach the operator
	// rather than being logged into the void.
	derivativeErrors.push(
		...(await writeMediaCompanions({
			componentTipo: identity.componentTipo,
			sectionTipo: identity.sectionTipo,
			sectionId: identity.sectionId,
			userId: input.userId,
			originalFileName: added.humanFileName,
			mediaFilePath: added.originalFilePath,
		})),
	);

	// THE PDF TRANSCRIPTION (T0-11; PHP regenerate_component → get_text_from_pdf).
	// A new PDF MASTER is a new statement about the document, so its text is
	// written into the related text_area — OVERWRITING (decision D1 = c; a
	// non-empty slice it replaced comes back as a NOTICE, Time Machine keeps the
	// previous version). Master tier only, as PHP (original quality only); a file
	// parked in a derivative tier says nothing new about the document's text.
	//
	// With OCR requested the text is STILL written now (from the master just
	// ingested), and the OCR job (pdf_ocr.ts, started by the caller after its
	// persist) overwrites it when it finishes — so a failed or stopped OCR never
	// leaves the previous document's text standing.
	//
	// Non-fatal like every pass past the move: failures join derivativeErrors.
	const pdfText = await transcribeUploadedPdf(input, pathOpts, isMaster, added.originalFilePath);
	derivativeErrors.push(...pdfText.errors);
	const { notices, startOcr } = pdfText;

	// The stored cues (external_source, the original/modified normalized-name
	// twins) still describe this component — an upload into any other tier does
	// not invalidate them, and dropping them loses the raw-original twin from the
	// index. Only the ORIGINAL tier's own cue is replaced, by what was just
	// stored; scanContextFromItem is the one reader of the other two. A RETOUCH
	// takes this branch too (isOriginal, not isMaster): it must keep the stored
	// original_normalized_name intact.
	const storedCues = scanContextFromItem(
		isOriginal
			? undefined
			: ((await readStoredMediaItems(
					identity.sectionTipo,
					identity.sectionId,
					identity.componentTipo,
				).then((items) => items.find((entry) => (entry.lang ?? null) === identity.lang))) ??
					undefined),
	);
	const filesInfo = scanFilesInfo(spec, identity, pathOpts, {
		...storedCues,
		...(isOriginal
			? {
					originalNormalizedName: `${identity.componentTipo}_${identity.sectionTipo}_${identity.sectionId}.${added.extension}`,
				}
			: {}),
	});

	// The single chokepoint every upload route passes through (tool_upload, the
	// batch importer, the MCP media tool), so one notification covers them all.
	// Fired AFTER the derivatives exist, because a listener's whole job is to
	// read them. Best-effort by construction — see ingest_event.ts.
	//
	// For av the transcode has not even been submitted yet (only the original is
	// on disk); a listener that needs the derivatives must poll `jobId`.
	await fireMediaIngestEvent({
		componentTipo: identity.componentTipo,
		sectionTipo: identity.sectionTipo,
		sectionId: identity.sectionId,
		model: spec.model,
	});

	// The transcode is handed back UNSTARTED. It writes its finished files_info
	// onto the record, and the caller writes the ingest-time scan onto the same
	// jsonb key moments from now — whichever lands second wins the whole key, so
	// "the encode is slower than a DB round-trip" is not good enough. The caller
	// starts it after its own persist commits.
	//
	// A NON-master av upload transcodes too — the build-only-what-is-missing
	// rule the other types get from regenerateMissingDerivatives, which has no av
	// branch (PHP ran regenerate_component for an av upload into any tier). Two
	// conditions, both load-bearing: the default tier must be ABSENT (never
	// re-encode over a derivative that exists), and an ORIGINAL must be on this
	// box — a transcode derives from the original, so without one the job would
	// only fail with 'AV original not found'. A file parked in a quality tier IS
	// that tier; nothing derives FROM it.
	if (spec.model === 'component_av') {
		const defaultFile = buildMediaLocation(
			spec,
			identity,
			spec.defaultQuality,
			spec.defaultExtension,
			pathOpts,
		).absolutePath;
		// av has ONE master (its originalQuality) — no av ladder carries a retouched
		// tier — so isMaster and isOriginal coincide here. isMaster is the honest
		// question: "did this upload land in a tier things derive FROM?".
		const canDerive =
			isMaster || resolveMasterSource(spec, identity, pathOpts, added.extension) !== null;
		if (canDerive && (isMaster || !existsSync(defaultFile))) {
			// userId travels so the transcode appears in ITS OWN uploader's activity
			// tray — an unowned job would be invisible to the person who started it.
			startTranscode = (): string =>
				submitAvTranscode(spec, identity, pathOpts, added.extension, input.userId);
		}
		// THE PICTURE, NOW — not when the transcode finishes and not when an operator
		// remembers. A new master makes the old posterframe a picture of a video this
		// record no longer holds, and a fresh av record had NO picture at all: the
		// transcode job writes tiers only, so every new av landed in every list as the
		// grey placeholder until someone opened tool_posterframe. PHP did not wait
		// either — component_av::create_thumb minted a posterframe on demand
		// (class.component_av.php:581). Retire the stale pair, then rebuild: the mint
		// is one ffmpeg frame off the file that is already on disk, so it costs the
		// upload milliseconds and does not depend on the transcode at all.
		if (isMaster) {
			derivativeErrors.push(...retireStalePosterframeAndThumb(spec, identity, pathOpts));
			try {
				const { rebuildThumb } = await import('../thumb.ts');
				await rebuildThumb({ spec, identity, pathOpts });
			} catch (error) {
				// Audio-only, or a source ffmpeg cannot read a frame from: the upload
				// stands, the record is honestly pictureless, and the reason travels.
				derivativeErrors.push(
					`posterframe of ${buildMediaIdentifier(identity)}: ${(error as Error).message}`,
				);
			}
		}
	}

	return {
		originalFileName: added.fileName,
		humanFileName: added.humanFileName,
		extension: added.extension,
		filesInfo,
		derivativeErrors,
		notices,
		startOcr,
		startTranscode,
	};
}

/** Resolve a media spec from a model name (convenience for callers). */
export function requireMediaSpec(model: string): MediaTypeSpec {
	const spec = mediaTypeOf(model);
	if (spec === null) {
		throw new DedaloError('request.invalid_model', {
			message: `Not a media model: ${model}`,
			coordinates: { model },
		});
	}
	return spec;
}
