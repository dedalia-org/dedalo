/**
 * PDF OCR — the upload's "OCR" checkbox, as a MEDIA JOB (T0-11; PHP
 * component_pdf::process_ocr_file :1003-1006, run from regenerate_component).
 *
 * WHAT IT DOES: `ocrmypdf` reads the master the upload JUST INGESTED (explicit,
 * never re-resolved) and writes a text-layered copy onto the DEFAULT (web) tier —
 * atomically (atomic.ts writeAtomically: a temp sibling, renamed into place only
 * when the run succeeded and is still current); the transcription is written in
 * `overwrite` mode from that TEMP before the rename (ingest/pdf_transcription.ts,
 * decision D1 = c), then the record's files_info is refreshed.
 *
 * DIVERGENCE FROM PHP, deliberate: PHP OCR'd the ORIGINAL IN PLACE (source ==
 * target = original quality) — the archival file was replaced by a PDF/A
 * re-encode. The engine never mutates the archival original
 * (ingest/process_uploaded_file.ts header), so the text layer lands on the tier
 * the viewer and the extraction read. Covers / thumb stay built from the master:
 * the pixels are the same.
 *
 * WHY A JOB, not inline in the upload request: ocrmypdf on a scanned book is
 * minutes; the job lane (`media`, jobs.ts) is what bounds how many run at once.
 * The spawn is deliberately NOT in the converter permit pool
 * (engine/admission.ts): a permit held for minutes would push every upload
 * thumbnail queued behind it past DEDALO_MEDIA_CONVERT_QUEUE_SECONDS into a 429
 * (magick_policy_tripwire names the exemption). Its wedge bound is an INACTIVITY
 * cap, not a total one — a 500-page scan is legitimate work.
 *
 * The job's identity (langs + principal) is the submitter's, pinned by the job
 * manager (JobRunScope) — so the transcription saves in the uploader's data lang,
 * as the uploader (userId travels explicitly for the TM actor).
 *
 * A STALE JOB WRITES NOTHING NEW. The job is minutes long, and the record may
 * move under it: a re-upload, a stop, a deleted record. So the master's FILE
 * IDENTITY (file_fingerprint.ts) is taken AT INGEST and handed to the submit, and the job re-asks "still
 * current" (record present, not aborted, same master — assertOcrCurrent, in that
 * order) before transcribing, UNDER the transcription's row lock (stillCurrent),
 * and once more right before the rename. A "no" before the text commits
 * discards everything (temp removed, text_area untouched); a "no" in the narrow
 * window AFTER the text committed discards the OCR'd file only, and the result
 * SAYS the text was saved. The job then reports `superseded` in its data (status
 * `done`), or ends `stopped`. The transcription reads the job's OWN output (the
 * temp), never "whatever the default tier holds now". One live OCR per target:
 * a new submit — and any new master upload of the component, PDF or not
 * (stopLiveOcr) — STOPS the previous one.
 *
 * WHAT A STOP DOES NOT REACH (jobs.ts header, stated): the ocrmypdf child.
 * runBinary has no abort hook, so a stopped job's child runs to its own end (or
 * its idle cap); the job then discards what it produced.
 */

import type { MediaTypeSpec } from '../concepts/media.ts';
import { readMatrixRecord } from '../db/matrix.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { getMatrixTableFromTipo } from '../ontology/resolver.ts';
import { writeAtomically } from './atomic.ts';
import { persistTranscodedFilesInfo } from './av_versions.ts';
import { requireTesseractModel } from './engine/ocr_langs.ts';
import { buildOcrArgv, ocrPathPrepend } from './engine/pdf.ts';
import { assertSpawnOk, runBinary } from './engine/spawn.ts';
import { fileFingerprint } from './file_fingerprint.ts';
import { type PdfTranscriptionOutcome, transcribePdf } from './ingest/pdf_transcription.ts';
import { type JobRecord, type JobTarget, jobTargetKey, mediaJobs } from './jobs.ts';
import { buildMediaLocation, type MediaIdentity, type MediaPathOptions } from './path.ts';

/** A minutes-long OCR pass may be silent for a while on one dense page — never this long. */
const OCR_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export interface PdfOcrRequest {
	spec: MediaTypeSpec;
	identity: MediaIdentity;
	pathOpts: MediaPathOptions;
	/** The uploader — the job's tray owner and the transcription's TM actor. */
	userId: number;
	/** A DÉDALO language (`lg-eng`); its Tesseract model comes from ocr_langs.ts. */
	ocrLang: string;
	/**
	 * The PDF master to OCR — EXPLICIT, the file the upload just ingested. Never
	 * re-resolved here: the master walk would answer an OLDER `.pdf` original
	 * still on disk when the new upload is a `.doc`, and OCR the wrong document.
	 */
	master: string;
	/**
	 * fileFingerprint(master) taken AT INGEST (the upload's own capture), never
	 * re-read at submit: the job can only ever OCR the file its upload ingested —
	 * a newer master landing before the submit makes it discard at its first check.
	 */
	masterFingerprint: string | null;
}

/** What the finished job reports (the job record's `data`). */
export interface PdfOcrJobResult {
	/** The OCR'd default-tier file, or null when the output was discarded. */
	ocr_file: string | null;
	/** Set when the output was discarded (header: A STALE JOB WRITES NOTHING). */
	superseded: string | null;
	persist_error: string | null;
	transcription: { status: string; messages: string[]; notices: string[] } | null;
}

/** Everything one run needs, fixed at submit. */
interface OcrRun {
	request: PdfOcrRequest;
	master: string;
	target: string;
	/** The master's file identity at submit (masterFingerprint). */
	fingerprint: string;
	signal: AbortSignal;
}

/**
 * The output of a run that is no longer the record's — the OCR'd file is
 * discarded, never renamed into place. `textSaved` = the transcription had
 * already COMMITTED when the run stopped being current (it stands, TM-audited).
 */
export class OcrDiscarded extends Error {
	constructor(
		message: string,
		readonly textSaved: PdfTranscriptionOutcome | null = null,
	) {
		super(message);
	}
}

/** What the currency check reads: the run's own facts, fixed at submit. */
export interface OcrCurrency {
	master: string;
	/** fileFingerprint(master) taken at ingest (PdfOcrRequest.masterFingerprint). */
	fingerprint: string;
	signal: AbortSignal;
}

/** Not aborted and the master unchanged — SYNCHRONOUS; also asked under the row lock. */
function isCurrent(run: OcrCurrency): boolean {
	return !run.signal.aborted && fileFingerprint(run.master) === run.fingerprint;
}

async function recordExists(identity: MediaIdentity): Promise<boolean> {
	const table = await getMatrixTableFromTipo(identity.sectionTipo);
	if (table === null) return false;
	return (await readMatrixRecord(table, identity.sectionTipo, identity.sectionId)) !== null;
}

/**
 * Throw OcrDiscarded unless the run is still the record's (header). THE ORDER IS
 * THE CONTRACT: the one AWAIT (the record read) comes FIRST, the abort and the
 * master's fingerprint are read SYNCHRONOUSLY after it — so a stop or a re-upload
 * landing during the record read is still seen, and the caller's next step (the
 * rename) follows with no await in between. Exported as the seam its gate drives.
 */
export async function assertOcrCurrent(
	run: OcrCurrency,
	recordPresent: () => Promise<boolean>,
): Promise<void> {
	const present = await recordPresent();
	if (run.signal.aborted) throw new OcrDiscarded('stopped — the OCR output was discarded');
	if (fileFingerprint(run.master) !== run.fingerprint) {
		throw new OcrDiscarded(
			"superseded — the record's PDF master changed while the OCR ran; the output was discarded",
		);
	}
	if (!present) {
		throw new OcrDiscarded('superseded — the record is gone; the OCR output was discarded');
	}
}

const assertCurrent = (run: OcrRun): Promise<void> =>
	assertOcrCurrent(run, () => recordExists(run.request.identity));

/**
 * The LAST check — SYNCHRONOUS, run by writeAtomically's `beforeRename`, so no
 * promise step sits between it and the rename: not aborted, same master. (The
 * record's presence needs an await, so it is asked before the transcription and
 * again under its row lock — a record deleted in the last instant still receives
 * the OCR'd file; its files_info write-back then finds no row.) After the text
 * committed, a "no" discards the OCR'd file only and SAYS the text was saved.
 * Exported as the seam its gate drives.
 */
export function assertCurrentBeforeRename(
	run: OcrCurrency,
	transcription: PdfTranscriptionOutcome | undefined,
): void {
	if (isCurrent(run)) return;
	const why = run.signal.aborted ? 'stopped' : "superseded — the record's PDF master changed";
	if (transcription?.status !== 'written') {
		throw new OcrDiscarded(`${why} — the OCR output was discarded`);
	}
	throw new OcrDiscarded(
		`${why} after the OCR text was SAVED — the transcription stands (Time Machine has the previous one); only the OCR'd web copy was discarded`,
		transcription,
	);
}

/**
 * OCR the master into the default tier, transcribing from the job's OWN output
 * before it is renamed into place. The ONE ocrmypdf spawn of the engine; reached
 * only from the job worker below (see the header for its bounds).
 */
async function ocrIntoDefaultTier(run: OcrRun): Promise<PdfTranscriptionOutcome> {
	const { request } = run;
	await assertCurrent(run);
	const produced: { transcription?: PdfTranscriptionOutcome } = {};
	await writeAtomically(
		run.target,
		async (temp) => {
			const result = await runBinary(buildOcrArgv(run.master, temp, request.ocrLang), {
				idleTimeoutMs: OCR_IDLE_TIMEOUT_MS,
				pathPrepend: ocrPathPrepend(),
			});
			assertSpawnOk(result, `OCR: ocrmypdf failed for ${run.master}`);
			await assertCurrent(run);
			produced.transcription = await transcribeOcrOutput(run, temp);
		},
		// The final check, synchronous, immediately before the rename.
		() => assertCurrentBeforeRename(run, produced.transcription),
	);
	if (produced.transcription === undefined) {
		throw new DedaloError('internal.invariant', {
			message: 'OCR: the atomic producer returned without a transcription outcome',
		});
	}
	return produced.transcription;
}

/** The overwrite transcription from the OCR temp, re-asked "still current" under the row lock. */
async function transcribeOcrOutput(run: OcrRun, temp: string): Promise<PdfTranscriptionOutcome> {
	const { spec, identity, pathOpts, userId } = run.request;
	const outcome = await transcribePdf({
		spec,
		identity,
		pathOpts,
		userId,
		mode: 'overwrite',
		source: temp,
		stillCurrent: () => isCurrent(run),
	});
	if (outcome.status === 'superseded') throw new OcrDiscarded(outcome.messages.join('; '));
	return outcome;
}

/** The master (the caller's, explicit) and the default-tier target, or the loud refusal. */
function resolveOcrFiles(request: PdfOcrRequest): { master: string; target: string } {
	const { spec, identity, pathOpts, master } = request;
	if (!master.toLowerCase().endsWith('.pdf')) {
		throw new DedaloError('media.operation_failed', {
			message: `OCR: the master ${master} is not a PDF`,
			publicMessage: 'OCR needs a PDF master.',
		});
	}
	const target = buildMediaLocation(
		spec,
		identity,
		spec.defaultQuality,
		'pdf',
		pathOpts,
	).absolutePath;
	if (target === master) {
		// The default tier IS the master on this ladder: OCR would rewrite the
		// archival file — the one thing this module exists not to do.
		throw new DedaloError('media.operation_failed', {
			message: `OCR refused: the default tier '${spec.defaultQuality}' resolves to the master ${master}`,
			publicMessage: 'OCR refused: the archival original is never rewritten.',
		});
	}
	return { master, target };
}

/**
 * STOP every live OCR job of this record's PDF: a newer master — a PDF or not —
 * supersedes it. Called by every master upload of a component_pdf (the ingest),
 * and by each submit.
 */
export function stopLiveOcr(spec: MediaTypeSpec, identity: MediaIdentity): void {
	stopLiveOcrFor(ocrJobTarget(spec, identity));
}

/** The job target of a record's OCR (the default tier it writes). */
function ocrJobTarget(spec: MediaTypeSpec, identity: MediaIdentity): JobTarget {
	return {
		section_tipo: identity.sectionTipo,
		section_id: identity.sectionId,
		component_tipo: identity.componentTipo,
		lang: identity.lang ?? null,
		quality: spec.defaultQuality,
		label: `${spec.defaultQuality} (OCR)`,
	};
}

function stopLiveOcrFor(target: JobTarget): void {
	const key = jobTargetKey(target);
	for (const job of mediaJobs.jobsForRecord(target.section_tipo, target.section_id)) {
		if (isLiveOcrOf(job, key)) mediaJobs.stop(job.id);
	}
}

/** A queued/running pdf_ocr job on the target `key`. */
function isLiveOcrOf(job: JobRecord, key: string): boolean {
	if (job.kind !== 'pdf_ocr' || job.target === undefined) return false;
	const live = job.status === 'queued' || job.status === 'running';
	return live && jobTargetKey(job.target) === key;
}

/** The finished job's result — the transcription must have LANDED, or it is a failure. */
function finishedResult(
	run: OcrRun,
	transcription: PdfTranscriptionOutcome,
	persistError: string | null,
): PdfOcrJobResult {
	if (transcription.status === 'failed' || transcription.status === 'no_text') {
		// The OCR'd tier is on disk, but the job's PURPOSE — the text — did not
		// land: an error frame in the uploader's tray, not a quiet 'done'.
		throw new DedaloError('media.operation_failed', {
			message: `OCR: ${transcription.messages.join('; ')}`,
			publicMessage: `OCR finished, but the transcription was not written: ${transcription.messages.join('; ')}`,
		});
	}
	return {
		ocr_file: run.target,
		superseded: null,
		persist_error: persistError,
		transcription: {
			status: transcription.status,
			messages: transcription.messages,
			notices: transcription.notices,
		},
	};
}

/** files_info follows the new tier; a failed write-back is reported, never fatal. */
async function persistOcrFilesInfo(request: PdfOcrRequest): Promise<string | null> {
	const { spec, identity, pathOpts } = request;
	try {
		await persistTranscodedFilesInfo(spec, identity, pathOpts);
		return null;
	} catch (error) {
		const message = (error as Error).message;
		console.error(
			`[media jobs] pdf_ocr ${identity.sectionTipo}/${identity.sectionId}/${identity.componentTipo}: files_info write-back failed: ${message}`,
		);
		return message;
	}
}

/** A discarded run's result — saying whether its text had already been saved. */
function discardedResult(discarded: OcrDiscarded): PdfOcrJobResult {
	const saved = discarded.textSaved;
	return {
		ocr_file: null,
		superseded: discarded.message,
		persist_error: null,
		transcription:
			saved === null
				? null
				: { status: saved.status, messages: saved.messages, notices: saved.notices },
	};
}

/** The job body: OCR + transcription, then the files_info write-back. */
async function runOcrJob(
	run: OcrRun,
	onProgress: (percent: number) => void,
): Promise<PdfOcrJobResult> {
	let transcription: PdfTranscriptionOutcome;
	try {
		transcription = await ocrIntoDefaultTier(run);
	} catch (error) {
		if (!(error instanceof OcrDiscarded)) throw error;
		return discardedResult(error);
	}
	onProgress(80);
	const persistError = await persistOcrFilesInfo(run.request);
	onProgress(100);
	return finishedResult(run, transcription, persistError);
}

/**
 * Submit the OCR job. Returns its id. Called by the upload door AFTER the
 * ingest's own files_info persist committed (the job writes files_info back too —
 * IngestResult.startOcr), never inline in the ingest. THROWS on a refusal (no
 * model, a master that is not a PDF or not readable): the caller turns it into a
 * message.
 */
export function submitPdfOcr(request: PdfOcrRequest): string {
	const { spec, identity } = request;
	// A language with no Tesseract model refuses HERE, at the submit, loudly — not
	// as a job that fails minutes later in somebody's tray.
	requireTesseractModel(request.ocrLang);
	const { master, target } = resolveOcrFiles(request);
	const fingerprint = request.masterFingerprint;
	if (fingerprint === null) {
		throw new DedaloError('media.file_not_found', {
			message: `OCR: the PDF master ${master} is not readable`,
			publicMessage: 'OCR: the record has no PDF master on this server',
		});
	}
	const jobTarget = ocrJobTarget(spec, identity);
	stopLiveOcrFor(jobTarget);
	const record = mediaJobs.submit(
		'pdf_ocr',
		async ({ onProgress, onData, signal }): Promise<PdfOcrJobResult> => {
			onData({ msg: 'OCR', is_running: true });
			return await runOcrJob({ request, master, target, fingerprint, signal }, onProgress);
		},
		{ lane: 'media', userId: request.userId, target: jobTarget },
	);
	return record.id;
}
