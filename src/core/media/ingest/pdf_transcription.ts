/**
 * PDF TRANSCRIPTION — the text a PDF carries, written into the component_text_area
 * its component_pdf names in the ontology `relations` (T0-11; PHP
 * component_pdf::regenerate_component :1222-1340 → get_text_from_pdf :743).
 *
 * Restored, not invented: PHP filled the transcription (rsc37 → rsc38, rsc209 →
 * rsc210, rsc165 → rsc166) on every upload of an original and on every regenerate,
 * and the TS ingest built the derivatives only — so since the 2026-07-11 cutover
 * full-text search, RAG (`[page-n-N]` chunking) and diffusion of the transcription
 * field were fed empty. Peer of companion_writes.ts, same posture.
 *
 * TWO MODES (owner decisions 2026-11-11):
 *   - `overwrite` (D1 = c) — an upload of a new master, and the OCR job after it.
 *     The new master is a new statement about the document, so the text follows
 *     it; a non-empty slice it replaces is reported as a NOTICE (not an error:
 *     nothing failed) naming how much was replaced, and Time Machine keeps the
 *     previous version.
 *   - `fill_empty` (D2 = b) — the regenerate doors (tool_update_cache,
 *     tool_media_versions' sync_files). A repair sweep must never replace a
 *     curated transcription: an empty slice is filled, a non-empty one is KEPT.
 *     Never runs OCR. Its row lock waits a BOUNDED time (files_info_persist
 *     withPerRecordLockWait: request pool, perRecordLockWaitMs, no retry): a
 *     record a curator holds is `locked` for this run, never a stalled sweep.
 *
 * THE SOURCE IS EXPLICIT, per caller (`PdfTranscriptionInput.source`) — never
 * "whatever the default tier holds now": the upload reads the master it just
 * ingested (a failed web-copy rebuild must not make it transcribe the PREVIOUS
 * document's web copy), the OCR job reads its own output, the regenerate doors
 * read the default tier else the master (defaultTierOrMasterPdf).
 *
 * `stillCurrent` (the OCR job's fingerprint + abort check) is asked UNDER the
 * row lock, in the writing transaction: a re-upload whose own transcription
 * committed first then makes the stale job's write `superseded`, never a
 * silent overwrite of the newer text.
 *
 * DIVERGENCES FROM PHP (ledgered, WC pdf-transcription-restored):
 *   - the text is HTML-ESCAPED per page before it becomes paragraphs — PHP put
 *     raw pdftotext output into `<p>`, so `IMP CAES<A>R` (an epigraphic edition)
 *     became a tag that the save path's sanitizer then deleted (the P1-20 class,
 *     pdf_extract_symmetry_tripwire);
 *   - the page tag is the full form tool_pdf_extractor writes
 *     (`[page-n-N-K-data:[N]:data]`, media/pdf_page_tag.ts — ONE builder) with
 *     the stored `lib_data.offset` honoured (PHP's `first_page` was dead);
 *   - the extraction runs through a private temp file (pdf_extract.ts), never a
 *     `.txt` beside the PDF in the media tree.
 *
 * THE READ-DECIDE-WRITE IS LOCKED. The slice's emptiness (fill_empty) and the
 * replaced length (overwrite's notice) are read UNDER the row lock, in the
 * transaction that writes — a curator's text committed while pdftotext ran is
 * never mistaken for an empty slice and overwritten by a sweep. The slow work
 * (the extraction) runs BEFORE the lock.
 *
 * NON-FATAL BY CONSTRUCTION (process_uploaded_file.ts ordering law): every
 * function returns messages, never throws; any failure leaves the text_area
 * untouched. A refusal of the write door is a message too.
 */

import { existsSync } from 'node:fs';
import { NO_LANG } from '../../../config/data_langs.ts';
import { type MediaTypeSpec, mediaTypeOf } from '../../concepts/media.ts';
import { MATRIX_JSONB_COLUMNS, type MatrixJsonbColumn, readMatrixRecord } from '../../db/matrix.ts';
import { readMatrixKeyForUpdate } from '../../db/matrix_write.ts';
import { withTransaction } from '../../db/postgres.ts';
import { isDedaloError } from '../../errors/dedalo_error.ts';
import {
	effectiveSaveLang,
	getColumnNameByModel,
	getMatrixTableFromTipo,
	getModelByTipo,
	relatedTipoByExactModel,
} from '../../ontology/resolver.ts';
import { readComponentItems } from '../../resolve/component_data.ts';
import { stripTags } from '../../resolve/html_text.ts';
import { currentDataLang } from '../../resolve/request_lang.ts';
import { saveComponentData } from '../../section/record/save_component.ts';
import { escapeHtml } from '../../security/html_escape.ts';
import { resolvePrincipal } from '../../security/permissions.ts';
import { authorizeRecordAccess, type RecordGrant } from '../../security/write_door.ts';
import { PAGE_BREAK } from '../engine/pdf.ts';
import { buildMediaLocation, type MediaIdentity, type MediaPathOptions } from '../path.ts';
import { pdfPageTag, storedPdfPageOffset } from '../pdf_page_tag.ts';
import { resolveMasterSource } from '../processing.ts';
import { readStoredMediaItems } from '../tool_support.ts';
import { isLockTimeout, withPerRecordLockWait } from '../tools/files_info_persist.ts';
import { extractPdfFileText } from '../tools/pdf_extract.ts';

/** The write door name every transcription save is asked under. */
export const TRANSCRIPTION_DOOR = 'media_ingest.transcription';

/** overwrite = upload / OCR (D1 c); fill_empty = the regenerate doors (D2 b). */
export type TranscriptionMode = 'overwrite' | 'fill_empty';

export interface PdfTranscriptionInput {
	spec: MediaTypeSpec;
	identity: MediaIdentity;
	pathOpts: MediaPathOptions;
	/** The actor — the uploader / the sweep's principal. The save is TM-audited as them. */
	userId: number;
	mode: TranscriptionMode;
	/**
	 * The PDF file to read (header: THE SOURCE IS EXPLICIT). null, or a file that
	 * is not a `.pdf` (a doc/odt master), is `not_pdf`.
	 */
	source: string | null;
	/**
	 * Asked UNDER the row lock just before the save; false → `superseded`,
	 * nothing written. The OCR job's "is my master still the record's master".
	 */
	stillCurrent?: () => boolean;
	/** tool_update_cache's run id: the save joins its UNDO LOG (a bulk revert clears the fill). */
	bulkProcessId?: number | null;
}

/**
 *  - no_target: the pdf names no component_text_area (nothing asked, no message);
 *  - not_pdf:   the master is not a PDF (a doc/odt original) or there is none;
 *  - written:   the slice now holds the extraction;
 *  - kept:      fill_empty met a non-empty slice and left it;
 *  - no_text:   the PDF carries no text layer (one message, nothing written);
 *  - failed:    extraction / door / save failed (messages, nothing written);
 *  - locked:    fill_empty could not get the row lock within the per-record
 *               wait (a curator holds it) — nothing written, retry later;
 *  - superseded: `stillCurrent` answered false under the lock — nothing written.
 */
export type PdfTranscriptionStatus =
	| 'no_target'
	| 'not_pdf'
	| 'written'
	| 'kept'
	| 'no_text'
	| 'failed'
	| 'locked'
	| 'superseded';

export interface PdfTranscriptionOutcome {
	status: PdfTranscriptionStatus;
	/** The text_area written to (null when the pdf names none). */
	targetTipo: string | null;
	/** Failures — the ingest's `derivativeErrors` channel. */
	messages: string[];
	/** Non-failures the operator must see — the D1 replace notice. */
	notices: string[];
}

/**
 * The transcription HTML of a pdftotext extraction whose pages are separated by
 * form feeds — or null when the PDF carries no text (trimmed text ≤ 2 chars, the
 * PHP threshold). PURE, so the shape is gateable without a binary.
 *
 * Per physical page N: the page tag paragraph, then the page's text ESCAPED, its
 * line breaks as paragraph breaks (PHP `str_replace(["\r\n","\n\r","\n","\r"],
 * '</p><p>')`). pdftotext ENDS every page with a form feed, so the empty segment
 * after the last one is not a page.
 */
export function buildTranscriptionHtml(raw: string, offset: number): string | null {
	if (raw.split(PAGE_BREAK).join('').trim().length <= 2) return null;
	const pages = raw.split(PAGE_BREAK);
	if (pages.length > 1 && pages[pages.length - 1]?.trim() === '') pages.pop();
	return pages
		.map(
			(page, index) =>
				`${pdfPageTag(index + 1, offset)}<p>${escapeHtml(page).replace(/\r\n|\n\r|\n|\r/g, '</p><p>')}</p>`,
		)
		.join('');
}

/** The visible text of a stored text_area value: tags dropped, whitespace trimmed. */
function visibleText(value: unknown): string {
	if (typeof value !== 'string') return '';
	return stripTags(value)
		.replace(/&nbsp;/g, ' ')
		.trim();
}

/** How many visible characters the stored slice of `lang` holds (0 = empty). */
export function sliceVisibleLength(items: readonly unknown[], lang: string): number {
	let total = 0;
	for (const item of items) {
		if (item === null || typeof item !== 'object') continue;
		const entry = item as { lang?: unknown; value?: unknown };
		if (entry.lang !== lang) continue;
		total += visibleText(entry.value).length;
	}
	return total;
}

const outcome = (
	status: PdfTranscriptionStatus,
	targetTipo: string | null,
	messages: string[] = [],
	notices: string[] = [],
): PdfTranscriptionOutcome => ({ status, targetTipo, messages, notices });

/**
 * Transcribe the record's PDF into its related text_area. Never throws (see the
 * header); one message per failure, the text_area untouched on any of them.
 */
export async function transcribePdf(
	input: PdfTranscriptionInput,
): Promise<PdfTranscriptionOutcome> {
	const { identity } = input;
	let targetTipo: string | null = null;
	try {
		targetTipo = await relatedTipoByExactModel(identity.componentTipo, 'component_text_area');
		if (targetTipo === null) return outcome('no_target', null);
		return await transcribeInto(input, targetTipo);
	} catch (error) {
		const message = `transcription '${targetTipo ?? identity.componentTipo}': ${(error as Error).message} — nothing was written`;
		console.warn(`[pdf_transcription] ${message}`);
		return outcome('failed', targetTipo, [message]);
	}
}

async function transcribeInto(
	input: PdfTranscriptionInput,
	targetTipo: string,
): Promise<PdfTranscriptionOutcome> {
	const label = `transcription '${targetTipo}'`;
	const source = pdfSource(input);
	if (source === null) return outcome('not_pdf', targetTipo);
	const model = await getModelByTipo(targetTipo);
	if (model === null) {
		return outcome('failed', targetTipo, [`${label}: no such ontology node — nothing was written`]);
	}
	const saveLang = await effectiveSaveLang(targetTipo, model, currentDataLang());
	// fill_empty: a cheap UNLOCKED look first, so a sweep over thousands of curated
	// records does not run pdftotext on every one. The decision itself is re-taken
	// under the lock (writeLocked).
	if (await keptBeforeExtraction(input, targetTipo, model, saveLang)) {
		return outcome('kept', targetTipo);
	}
	const grant = await transcriptionGrant(input, targetTipo);
	if (typeof grant === 'string') return outcome('failed', targetTipo, [grant]);
	const html = await extractTranscription(input, source, label);
	if (typeof html !== 'string') return { ...html, targetTipo };
	return await writeLocked(input, grant, model, saveLang, html, label);
}

/** The caller's source when it is a REAL PDF (a doc/odt master is not transcribed — PHP). */
function pdfSource(input: PdfTranscriptionInput): string | null {
	return input.source?.toLowerCase().endsWith('.pdf') === true ? input.source : null;
}

/**
 * The regenerate doors' source: the DEFAULT tier (PHP get_media_filepath
 * (default_quality) — the tier the OCR job writes its text layer into), else the
 * stored master when it is a REAL PDF (PHP skipped doc/odt originals; the master
 * walk falls back to the allowlist, so the extension of what it resolved is the
 * answer). null = nothing to read.
 */
export function defaultTierOrMasterPdf(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	pathOpts: MediaPathOptions,
): string | null {
	const defaultFile = buildMediaLocation(
		spec,
		identity,
		spec.defaultQuality,
		'pdf',
		pathOpts,
	).absolutePath;
	if (existsSync(defaultFile)) return defaultFile;
	const master = resolveMasterSource(spec, identity, pathOpts, 'pdf');
	return master?.toLowerCase().endsWith('.pdf') ? master : null;
}

/** fill_empty's unlocked pre-check: true when the slice already holds text. */
async function keptBeforeExtraction(
	input: PdfTranscriptionInput,
	targetTipo: string,
	model: string,
	saveLang: string,
): Promise<boolean> {
	if (input.mode !== 'fill_empty') return false;
	return (await storedSliceLength(input.identity, targetTipo, model, saveLang)) > 0;
}

/** The transcription HTML of the caller's source PDF, or the outcome that stops it. */
async function extractTranscription(
	input: PdfTranscriptionInput,
	source: string,
	label: string,
): Promise<string | PdfTranscriptionOutcome> {
	const { identity } = input;
	let raw: string;
	try {
		raw = await extractPdfFileText(source, { method: 'text', keepPageBreaks: true });
	} catch (error) {
		return outcome('failed', null, [
			`${label}: the text could not be extracted (${(error as Error).message}) — nothing was written`,
		]);
	}
	const html = buildTranscriptionHtml(raw, await storedOffset(identity));
	if (html !== null) return html;
	const why = input.mode === 'overwrite' ? ' (OCR was not requested, or found no text)' : '';
	return outcome('no_text', null, [
		`${label}: the PDF has no text layer${why} — nothing was written`,
	]);
}

/** The visible length of the stored slice, read without a lock (the pre-check). */
async function storedSliceLength(
	identity: MediaIdentity,
	targetTipo: string,
	model: string,
	lang: string,
): Promise<number> {
	const table = await getMatrixTableFromTipo(identity.sectionTipo);
	if (table === null) return 0;
	const record = await readMatrixRecord(table, identity.sectionTipo, identity.sectionId);
	if (record === null) return 0;
	return sliceVisibleLength(readComponentItems(record, targetTipo, model) ?? [], lang);
}

/** The component_pdf's stored `lib_data.offset` (its own lang item, else the first), else 1. */
async function storedOffset(identity: MediaIdentity): Promise<number> {
	const items = await readStoredMediaItems(
		identity.sectionTipo,
		identity.sectionId,
		identity.componentTipo,
	);
	const item = items.find((entry) => (entry.lang ?? null) === identity.lang) ?? items[0];
	const libData = item?.lib_data as { offset?: unknown } | null | undefined;
	return storedPdfPageOffset(libData?.offset);
}

/** A save-door refusal carried out of the transaction, so it rolls back whole. */
class TranscriptionRefused extends Error {}

/**
 * THE LOCKED READ-DECIDE-WRITE (header): the row lock through the text_area's
 * key, the slice read AS IT STANDS UNDER THE LOCK, the mode's decision, the save
 * (tx + Time Machine) in the same transaction.
 */
/** What the locked transaction decided. */
type LockedDecision =
	| { kind: 'missing' }
	| { kind: 'kept' }
	| { kind: 'superseded' }
	| { kind: 'written'; replaced: number };

/** The everything-a-locked-write-needs bundle (keeps each step's signature short). */
interface LockedWrite {
	input: PdfTranscriptionInput;
	grant: RecordGrant;
	model: string;
	saveLang: string;
	html: string;
	table: string;
	column: MatrixJsonbColumn;
}

async function writeLocked(
	input: PdfTranscriptionInput,
	grant: RecordGrant,
	model: string,
	saveLang: string,
	html: string,
	label: string,
): Promise<PdfTranscriptionOutcome> {
	const table = await getMatrixTableFromTipo(grant.sectionTipo);
	const column = MATRIX_JSONB_COLUMNS.find((name) => name === getColumnNameByModel(model));
	if (table === null || column === undefined) {
		return outcome('failed', grant.componentTipo, [
			`${label}: '${model}' has no matrix storage here — nothing was written`,
		]);
	}
	const write: LockedWrite = { input, grant, model, saveLang, html, table, column };
	try {
		return decisionOutcome(await lockedTransaction(write), write, label);
	} catch (error) {
		if (isLockTimeout(error)) {
			return outcome('locked', grant.componentTipo, [
				`${label}: the record is locked by another session — nothing was written; retry later`,
			]);
		}
		return outcome('failed', grant.componentTipo, [
			`${label}: save failed (${(error as Error).message}) — nothing was written`,
		]);
	}
}

/**
 * The transaction the decision runs in. A SWEEP (fill_empty) runs in the
 * per-record lock-wait unit (files_info_persist withPerRecordLockWait — the
 * request pool, `SET LOCAL lock_timeout` = perRecordLockWaitMs, the unit
 * transformStoredMediaItems' sweeps use): a held record is `locked` for this run.
 * An upload / the OCR job keep the plain request transaction (their lane's own
 * statement ceiling).
 */
async function lockedTransaction(write: LockedWrite): Promise<LockedDecision> {
	if (write.input.mode !== 'fill_empty') return await withTransaction(() => decideUnderLock(write));
	return await withPerRecordLockWait(() => decideUnderLock(write));
}

/** The slice's visible length read UNDER the row lock, or null when the record is gone. */
async function lockedSliceLength(write: LockedWrite): Promise<number | null> {
	const { grant, table, column } = write;
	const locked = await readMatrixKeyForUpdate(
		table,
		grant.sectionTipo,
		grant.sectionId,
		column,
		grant.componentTipo,
	);
	if (locked === null) return null;
	const record = await readMatrixRecord(table, grant.sectionTipo, grant.sectionId);
	if (record === null) return null;
	return sliceVisibleLength(
		readComponentItems(record, grant.componentTipo, write.model) ?? [],
		write.saveLang,
	);
}

/** Inside the transaction: lock, re-read, decide, save (tx + Time Machine). */
async function decideUnderLock(write: LockedWrite): Promise<LockedDecision> {
	const replaced = await lockedSliceLength(write);
	const stop = decisionBeforeSave(write, replaced);
	if (stop !== null) return stop;
	const { grant, saveLang } = write;
	const saved = await saveComponentData({
		componentTipo: grant.componentTipo,
		sectionTipo: grant.sectionTipo,
		sectionId: grant.sectionId,
		lang: saveLang,
		changedData: [{ action: 'set_data', id: null, value: [{ value: write.html, lang: saveLang }] }],
		userId: grant.userId,
		bulkProcessId: write.input.bulkProcessId ?? null,
	});
	if (!saved.ok) throw new TranscriptionRefused(saved.message);
	return { kind: 'written', replaced: replaced ?? 0 };
}

/**
 * What the locked slice decides WITHOUT a save, or null = save: the row gone,
 * the caller no longer current (stillCurrent), or fill_empty meeting text.
 */
function decisionBeforeSave(write: LockedWrite, replaced: number | null): LockedDecision | null {
	if (replaced === null) return { kind: 'missing' };
	if (write.input.stillCurrent?.() === false) return { kind: 'superseded' };
	if (write.input.mode === 'fill_empty' && replaced > 0) return { kind: 'kept' };
	return null;
}

/** The outcome of a committed decision; D1 (c): a replaced non-empty slice is a NOTICE. */
function decisionOutcome(
	decided: LockedDecision,
	write: LockedWrite,
	label: string,
): PdfTranscriptionOutcome {
	const target = write.grant.componentTipo;
	if (decided.kind === 'missing') {
		return outcome('failed', target, [`${label}: the record is gone — nothing was written`]);
	}
	if (decided.kind === 'kept') return outcome('kept', target);
	if (decided.kind === 'superseded') {
		return outcome('superseded', target, [
			`${label}: superseded — the record's PDF changed while this ran; nothing was written`,
		]);
	}
	if (decided.replaced === 0) return outcome('written', target);
	return outcome(
		'written',
		target,
		[],
		[
			`${label}: replaced ${decided.replaced} chars of existing transcription (${write.saveLang}) — Time Machine keeps the previous version`,
		],
	);
}

/**
 * THE WRITE DOOR for the transcription (companion_writes.ts companionGrant's
 * rule): the ingest door authorized the MEDIA component; the text_area is another
 * component of the same record, asked of the door as the actor. A refusal is a
 * message, never a write.
 */
async function transcriptionGrant(
	input: PdfTranscriptionInput,
	targetTipo: string,
): Promise<RecordGrant | string> {
	const principal = await resolvePrincipal(input.userId);
	try {
		return await authorizeRecordAccess(
			principal,
			{
				section_tipo: input.identity.sectionTipo,
				component_tipo: targetTipo,
				section_id: input.identity.sectionId,
			},
			{ mode: 'write', level: 2, sectionFloor: 1, door: TRANSCRIPTION_DOOR },
		);
	} catch (error) {
		if (
			isDedaloError(error) &&
			(error.code.startsWith('perm.') || error.code === 'request.invalid')
		) {
			return `transcription '${targetTipo}': not writable by the actor (${error.code}) — nothing was written`;
		}
		throw error;
	}
}

export interface StoredPdfTranscriptionInput {
	componentTipo: string;
	sectionTipo: string;
	sectionId: number;
	/** The component_pdf's stored items (their `lang` completes the media identity). */
	items: readonly unknown[];
	pathOpts: MediaPathOptions;
	userId: number;
	bulkProcessId?: number | null;
}

/**
 * THE REGENERATE DOORS' ENTRY (tool_update_cache, tool_media_versions sync_files):
 * `fill_empty` (D2 = b) — an empty slice is filled, a curated one KEPT; never OCR.
 * The media identity is the stored item in the request's data lang, else the
 * language-neutral one (`lg-nolan` / no lang) — NEVER another language's PDF, whose text
 * would land in this lang's slice (one transcription slice per run, as PHP's one
 * regenerate per component). No such item → `not_pdf`. Source: the default tier,
 * else the master (defaultTierOrMasterPdf).
 */
/** A stored media item of no language: `lg-nolan`, or no lang at all (path.ts identity lang null). */
function isLanguageNeutral(lang: unknown): boolean {
	return lang === undefined || lang === null || lang === '' || lang === NO_LANG;
}

export async function transcribeStoredPdf(
	input: StoredPdfTranscriptionInput,
): Promise<PdfTranscriptionOutcome> {
	const spec = mediaTypeOf('component_pdf');
	const objects = input.items.filter(
		(item): item is Record<string, unknown> => item !== null && typeof item === 'object',
	);
	const dataLang = currentDataLang();
	const item =
		objects.find((entry) => entry.lang === dataLang) ??
		objects.find((entry) => isLanguageNeutral(entry.lang));
	if (spec === null || item === undefined) return outcome('not_pdf', null);
	const identity: MediaIdentity = {
		componentTipo: input.componentTipo,
		sectionTipo: input.sectionTipo,
		sectionId: input.sectionId,
		// The media identity's lang is null for a language-neutral PDF (path.ts:
		// only a translatable component's file names carry a lang suffix).
		lang: isLanguageNeutral(item.lang) ? null : (item.lang as string),
	};
	return await transcribePdf({
		spec,
		identity,
		pathOpts: input.pathOpts,
		userId: input.userId,
		mode: 'fill_empty',
		source: defaultTierOrMasterPdf(spec, identity, input.pathOpts),
		bulkProcessId: input.bulkProcessId ?? null,
	});
}
