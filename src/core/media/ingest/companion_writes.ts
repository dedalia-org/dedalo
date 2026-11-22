/**
 * INGEST COMPANION WRITES — the ontology-declared fields an upload fills on the
 * record beside the media itself (PHP component_image::process_uploaded_file
 * :802-830, component_av :1188-1236, component_pdf :382-399).
 *
 * Two properties, both naming a SIBLING component on the same record:
 *
 *   • `properties.target_filename` — the human file name the curator uploaded,
 *     written into a visible field (`rsc398` "Original filename"). It is the only
 *     place the archive keeps `IMG_3007.jpg` / `María Piñón entrevista.mp4`; the
 *     file on disk is renamed to the deterministic media identifier, so without
 *     this write the provenance of the byte stream is simply lost.
 *   • `properties.target_duration` — the AV duration as a Dédalo time code
 *     (`rsc54`). The oral-history media-icons widget reads it directly; unwritten,
 *     every TS-ingested interview showed `00:00:00.000` forever.
 *
 * GENERIC BY PROPERTY, NOT BY MODEL. PHP implemented these three times (image,
 * av, pdf — and pdf's copy carries a set_data() shape bug), and never at all for
 * svg/3d, which is an accident of where somebody stopped copying rather than a
 * rule: the PROPERTY is the declaration of intent, so any media component that
 * declares one gets it honoured here. That is capability restored, not invented —
 * an ontology may already carry `target_filename` on an svg component and PHP
 * would silently have ignored it.
 *
 * AUTHORIZED PER COMPANION (closure Step 3 req 10): each sibling is asked of the
 * write door as the uploader before it is written (companionGrant) — the ingest
 * door authorized only the media component.
 *
 * NEVER A FABRICATED DURATION (T2-WID-3, FYI-5 / C52). A file whose duration
 * cannot be measured writes NOTHING to the duration target (and says so): PHP
 * stored `00:00:00.000`, which every later reader took for a measurement. The
 * same measurement is the media-icons widget's READ-ONLY fallback when no
 * duration is stored (measureStoredMediaDuration — a read never writes), and
 * tool_update_cache's regenerate re-runs the duration companion as the repair
 * door (rewriteDurationCompanion).
 *
 * NON-FATAL BY CONSTRUCTION. Every function here returns messages instead of
 * throwing: it runs AFTER `addFile` has irreversibly moved the staged upload, and
 * the ordering law of the ingest (see IngestResult.derivativeErrors) is that
 * nothing past the move may abort the ingest and leave a file on disk that no
 * record knows about. The messages are surfaced by the calling tool.
 */

import { existsSync, statSync } from 'node:fs';
import { mediaTypeOf } from '../../concepts/media.ts';
import { isDedaloError } from '../../errors/dedalo_error.ts';
import { getModelByTipo, getNode, getTranslatableByTipo } from '../../ontology/resolver.ts';
import { currentDataLang } from '../../resolve/request_lang.ts';
import { secondsToTc } from '../../resolve/tr_marks.ts';
import { saveComponentData } from '../../section/record/save_component.ts';
import { resolvePrincipal } from '../../security/permissions.ts';
import { authorizeRecordAccess, type RecordGrant } from '../../security/write_door.ts';
import { probeFormat } from '../engine/ffmpeg.ts';
import { resolveMediaPathOptions } from '../ontology_path.ts';
import { absoluteFromRelative, buildMediaLocation } from '../path.ts';

/** The sibling components an upload writes to, or null where none is declared. */
export interface MediaCompanionTargets {
	/** properties.target_filename — receives the human upload name. */
	filenameTipo: string | null;
	/** properties.target_duration — receives the media duration as a time code. */
	durationTipo: string | null;
}

/**
 * Extract the companion targets from a component's ontology `properties`. PURE,
 * so the property contract is gateable without a database.
 *
 * A non-string (or empty) value is NOT a target: the property must name a tipo,
 * and a truthy-but-unusable value would otherwise become a save addressed to
 * `undefined`.
 */
export function readCompanionTargets(
	properties: Record<string, unknown> | null | undefined,
): MediaCompanionTargets {
	const read = (key: string): string | null => {
		const value = properties?.[key];
		return typeof value === 'string' && value !== '' ? value : null;
	};
	return { filenameTipo: read('target_filename'), durationTipo: read('target_duration') };
}

/** The companion targets declared by a media component's ontology node. */
export async function resolveMediaCompanionTargets(
	componentTipo: string,
): Promise<MediaCompanionTargets> {
	const node = await getNode(componentTipo);
	return readCompanionTargets((node?.properties ?? null) as Record<string, unknown> | null);
}

export interface CompanionWriteInput {
	/** The media component whose properties declare the targets. */
	componentTipo: string;
	sectionTipo: string;
	sectionId: number;
	/** The acting user (the saves are TM-audited like any other write). */
	userId: number;
	/** The human file name as uploaded, e.g. 'María Piñón entrevista.mp4'. */
	originalFileName: string;
	/** Absolute path of the file just stored — the duration is measured from IT. */
	mediaFilePath: string;
	/**
	 * The dd800 run this write belongs to (tool_update_cache's regenerate): the
	 * save joins that run's undo log, so a bulk revert puts the BEFORE value back.
	 */
	bulkProcessId?: number | null;
}

/**
 * Perform the declared companion writes for one ingest. Returns one message per
 * problem; an empty array means everything the ontology asked for was written (or
 * nothing was asked for).
 */
export async function writeMediaCompanions(input: CompanionWriteInput): Promise<string[]> {
	const targets = await resolveMediaCompanionTargets(input.componentTipo);
	const messages: string[] = [];
	if (targets.filenameTipo !== null) {
		messages.push(...(await writeFilename(input, targets.filenameTipo)));
	}
	if (targets.durationTipo !== null) {
		messages.push(...(await writeDuration(input, targets.durationTipo)));
	}
	return messages;
}

/**
 * Write the human upload name into the target_filename component.
 *
 * OVERWRITES on purpose (PHP set_data + save, unconditional): the field states
 * which file the record's media came from, so a re-upload must restate it. That
 * is the opposite of tool_import_files' `target_filename` role, which fills only
 * when EMPTY — there the value is matching input the operator may have curated,
 * here it is provenance of the byte stream that has just been replaced.
 *
 * lg-nolan, because PHP instantiates the target with DEDALO_DATA_NOLAN whatever
 * the component's own translatable flag says (component_image :812, component_av
 * :1198). Every target in the shipped ontology is non-translatable, so the two
 * readings coincide; the oracle's choice is kept rather than improved on.
 */
async function writeFilename(input: CompanionWriteInput, targetTipo: string): Promise<string[]> {
	const value = input.originalFileName.trim();
	if (value === '') {
		return [
			`target_filename '${targetTipo}': the upload carried no file name, nothing was written`,
		];
	}
	return await saveCompanionValue(input, targetTipo, value, 'target_filename');
}

/**
 * Write the media duration as a Dédalo time code into the target_duration
 * component (PHP get_duration → OptimizeTC::seg2tc, e.g. '00:05:20.125').
 *
 * The duration is read from the file that was just stored — PHP measures
 * `get_duration($quality)` on the uploaded tier, not on a derivative that does
 * not exist yet at this point in the ingest.
 *
 * A file with no readable duration writes NOTHING and reports it (T2-WID-3,
 * FYI-5): PHP stored `00:00:00.000` — a fabricated measurement (C52) that every
 * reader, the media-icons widget first, then showed as the interview's length.
 */
async function writeDuration(input: CompanionWriteInput, targetTipo: string): Promise<string[]> {
	const measured = await measureDuration(input.mediaFilePath);
	if (typeof measured === 'string') {
		return [`target_duration '${targetTipo}': ${measured} — nothing was written`];
	}
	return await saveCompanionValue(input, targetTipo, secondsToTc(measured), 'target_duration');
}

/**
 * The duration of a media file in seconds, or the sentence saying why there is
 * none (a probe failure, or a file reporting no positive duration). READ-ONLY.
 */
async function measureDuration(filePath: string): Promise<number | string> {
	try {
		const format = (await probeFormat(filePath)) as { format?: { duration?: unknown } } | null;
		const raw = Number(format?.format?.duration ?? 0);
		return Number.isFinite(raw) && raw > 0 ? raw : `${filePath} reports no duration`;
	} catch (error) {
		return `the duration of ${filePath} could not be probed (${(error as Error).message})`;
	}
}

/** A stored media record's component, addressed for a duration measurement. */
export interface StoredMediaTarget {
	/** The media component (its model must be a media model). */
	componentTipo: string;
	sectionTipo: string;
	sectionId: number;
	/** The component's stored items (files_info locates the file first), when at hand. */
	items?: readonly unknown[];
}

/** A files_info entry as this module reads it. */
interface FilesInfoEntry {
	quality?: unknown;
	file_exist?: unknown;
	file_path?: unknown;
	external?: unknown;
}

/** Whether a files_info entry names a LOCAL file of `quality` that exists. */
function isLocalEntryOf(candidate: FilesInfoEntry | null, quality: string): boolean {
	return (
		candidate !== null &&
		candidate.quality === quality &&
		candidate.file_exist === true &&
		candidate.external !== true &&
		typeof candidate.file_path === 'string'
	);
}

/** The stored files_info's existing file of `quality`, or null (READ-ONLY). */
function locateFromFilesInfo(
	items: readonly unknown[] | undefined,
	quality: string,
	mediaRoot: string | undefined,
): string | null {
	const filesInfo = (items?.[0] as { files_info?: unknown } | undefined)?.files_info;
	if (!Array.isArray(filesInfo)) return null;
	const entry = (filesInfo as (FilesInfoEntry | null)[]).find((candidate) =>
		isLocalEntryOf(candidate, quality),
	);
	if (entry == null) return null;
	try {
		const absolute = absoluteFromRelative(entry.file_path as string, mediaRoot);
		return existsSync(absolute) ? absolute : null;
	} catch {
		return null; // a stored path outside the media root locates nothing; the grammar decides
	}
}

/**
 * The absolute path of a stored media record's DEFAULT-QUALITY file, or null
 * when none is on this server (PHP component_av::get_duration's file). The
 * stored files_info entry locates it first, the deterministic grammar location
 * is the fallback. READ-ONLY: nothing is created, nothing written.
 */
export async function locateDefaultQualityFile(target: StoredMediaTarget): Promise<string | null> {
	const model = await getModelByTipo(target.componentTipo);
	const spec = model === null ? null : mediaTypeOf(model);
	if (spec === null) return null;
	const pathOpts = await resolveMediaPathOptions(
		target.componentTipo,
		target.sectionTipo,
		target.sectionId,
	);
	const stored = locateFromFilesInfo(target.items, spec.defaultQuality, pathOpts.mediaRoot);
	if (stored !== null) return stored;
	const lang = (await getTranslatableByTipo(target.componentTipo)) ? currentDataLang() : null;
	const location = buildMediaLocation(
		spec,
		{
			componentTipo: target.componentTipo,
			sectionTipo: target.sectionTipo,
			sectionId: target.sectionId,
			lang,
		},
		spec.defaultQuality,
		spec.defaultExtension,
		pathOpts,
	);
	return existsSync(location.absolutePath) ? location.absolutePath : null;
}

/**
 * READ-PATH PROBE MEMO (T2-B4 review L1). The media-icons widget measures a
 * tape with no stored duration on EVERY read (a read never writes), so a list
 * of N interviews × k tapes spawned N·k ffprobes per page, forever, until a
 * regenerate stored the values. A measurement is a fact about the FILE'S BYTES:
 * keyed by absolute path + mtime + size, a replaced file is a new key (never a
 * stale answer), and request identity cannot land in it (the widget's own read
 * posture decides who sees the cell; this only spares the re-probe). The
 * in-flight promise is shared, so concurrent reads of one file probe once.
 * Lifecycle: bounded to MEASURED_DURATION_MEMO_MAX entries (oldest evicted),
 * inconclusive probes dropped, process restart otherwise.
 */
const MEASURED_DURATION_MEMO_MAX = 1024;
const measuredDurationByFile = new Map<string, Promise<string | null>>();

/**
 * The MEASURED duration of a stored media record as a Dédalo time code, or null
 * when it is unknown (no file on this server, or none readable). READ-ONLY — the
 * media-icons widget's fallback when no duration is stored (T2-WID-3): a read
 * never writes, and never fabricates `00:00:00.000`.
 */
export async function measureStoredMediaDuration(
	target: StoredMediaTarget,
): Promise<string | null> {
	const file = await locateDefaultQualityFile(target);
	if (file === null) return null;
	const stamp = fileStampOf(file);
	if (stamp === null) return null; // gone between the locate and the stat
	const known = measuredDurationByFile.get(stamp);
	if (known !== undefined) return await known;
	const pending = measureDuration(file).then((measured) =>
		typeof measured === 'string' ? null : secondsToTc(measured),
	);
	rememberMeasurement(stamp, pending);
	const result = await pending;
	// An inconclusive probe (a timeout under load, an unreadable file) is not a
	// fact about the bytes: it is not remembered, the next read probes again.
	if (result === null) measuredDurationByFile.delete(stamp);
	return result;
}

/** A file's memo key — absolute path + mtime + size — or null when it cannot be stat'ed. */
function fileStampOf(file: string): string | null {
	try {
		const stats = statSync(file);
		return `${file}\0${stats.mtimeMs}\0${stats.size}`;
	} catch {
		return null;
	}
}

/** Remember a (pending) measurement, evicting the oldest past the bound. */
function rememberMeasurement(stamp: string, pending: Promise<string | null>): void {
	measuredDurationByFile.set(stamp, pending);
	if (measuredDurationByFile.size <= MEASURED_DURATION_MEMO_MAX) return;
	const oldest = measuredDurationByFile.keys().next().value;
	if (oldest !== undefined) measuredDurationByFile.delete(oldest);
}

/**
 * RE-RUN the duration companion of a stored media record (T2-WID-3 — the
 * repair door tool_update_cache's regenerate takes): measure its default-quality
 * file and write the time code into the component's declared target_duration,
 * through the write door as `userId`. Messages, never a throw (the module's
 * posture); an empty array = written, or nothing declared. No file on this
 * server = nothing to measure: nothing written, nothing reported (the files_info
 * refresh already states the absence).
 */
export async function rewriteDurationCompanion(
	target: StoredMediaTarget & { userId: number; bulkProcessId?: number | null },
): Promise<string[]> {
	const { durationTipo } = await resolveMediaCompanionTargets(target.componentTipo);
	if (durationTipo === null) return [];
	const file = await locateDefaultQualityFile(target);
	if (file === null) return [];
	return await writeDuration(
		{
			componentTipo: target.componentTipo,
			sectionTipo: target.sectionTipo,
			sectionId: target.sectionId,
			userId: target.userId,
			originalFileName: '',
			mediaFilePath: file,
			bulkProcessId: target.bulkProcessId ?? null,
		},
		durationTipo,
	);
}

/**
 * The ONE write door of this module: a flat single-value save through
 * `saveComponentData` (transaction + Time Machine audit), refusing loudly-in-a-
 * message when the target is not a component that can hold one.
 */
async function saveCompanionValue(
	input: CompanionWriteInput,
	targetTipo: string,
	value: string,
	role: string,
): Promise<string[]> {
	const model = await getModelByTipo(targetTipo);
	if (model === null) {
		return [`${role} '${targetTipo}': no such ontology node — nothing was written`];
	}
	try {
		const grant = await companionGrant(input, targetTipo, role);
		if (typeof grant === 'string') return [grant];
		const result = await saveComponentData({
			componentTipo: grant.componentTipo,
			sectionTipo: grant.sectionTipo,
			sectionId: grant.sectionId,
			lang: 'lg-nolan',
			changedData: [{ action: 'set_data', id: null, value: [{ value, lang: 'lg-nolan' }] }],
			userId: grant.userId,
			bulkProcessId: input.bulkProcessId ?? null,
		});
		return result.ok ? [] : [`${role} '${targetTipo}' save failed: ${result.message}`];
	} catch (error) {
		return [`${role} '${targetTipo}' save failed: ${(error as Error).message}`];
	}
}

/**
 * THE WRITE DOOR for a companion (closure Step 3 req 10). The ingest door
 * authorized the MEDIA component; a companion is ANOTHER component of the same
 * record — the ontology names it, the uploader writes it — so it is asked of the
 * door as the uploader: grammar, section floor 1, the dd128-aware pair (a media
 * component whose `target_filename` pointed at a dd128 field could otherwise
 * write a user-manager's own dd1725), the write scope. A refusal is a MESSAGE
 * (non-fatal, past the move — the module's posture), never a write.
 */
async function companionGrant(
	input: CompanionWriteInput,
	targetTipo: string,
	role: string,
): Promise<RecordGrant | string> {
	const principal = await resolvePrincipal(input.userId);
	try {
		return await authorizeRecordAccess(
			principal,
			{ section_tipo: input.sectionTipo, component_tipo: targetTipo, section_id: input.sectionId },
			{ mode: 'write', level: 2, sectionFloor: 1, door: `media_ingest.${role}` },
		);
	} catch (error) {
		if (
			isDedaloError(error) &&
			(error.code.startsWith('perm.') || error.code === 'request.invalid')
		) {
			return `${role} '${targetTipo}': not writable by the uploader (${error.code}) — nothing was written`;
		}
		throw error;
	}
}
