/**
 * tool_import_zotero server module (PHP tool_import_zotero::import_files, T1-7).
 * import_files reads each staged Zotero CSL-JSON export (src/core/tools/csl_json.ts),
 * maps every item through the SERVER's field map (src/core/tools/zotero_map.ts),
 * resolves each item to a record by its Zotero key, and writes the batch through
 * the shared mapped-import executor (import_execute.ts — one dd800 run, one
 * transaction per record, the write door per field). After the records commit,
 * an item's `archive` PDF (staged in the same upload) goes into the record's
 * component_pdf and its cover into the identifying component_image.
 *
 * STAGED-FILE WIRE (PHP :167-193): the client posts `key_dir` ONCE at the TOP
 * LEVEL of options and each `files_data[]` entry carries only the
 * service_dropzone descriptor `{name, tmp_name, …}`. The staged path is rebuilt
 * as `<staging root>/<ctx.userId>/<sanitized key_dir>/<staged name>` — never
 * from a client-supplied directory — and re-confined under the user's staging
 * dir. The batch's `.json` entries are the exports; the other entries are the
 * attachments an item's `archive` names.
 *
 * CONFIG IS SERVER-SIDE (PHP tool_common::get_config): `map`, `main`,
 * `typology`, `standard_type` come from the Tools configuration (dd996), else
 * the register default (dd1633), per key (`getToolConfig`). The client-posted
 * `tool_config` is read for its `ddo_map` ONLY (the Values form); a posted map
 * is ignored — a client-chosen map would let any level-2 caller pick which
 * components a file writes.
 *
 * IDENTITY: an item is matched by its Zotero KEY (the `id` URI's last segment)
 * in the code component the map's `id` entry names, or by the full URI stored
 * there (PHP's `*\/<key>` suffix leg, made exact); none ⇒ the record is created.
 * The `field_to_section_id` variable (default `call-number`), which PHP used as
 * the record's section_id, is NOT applied pending an owner decision (D1) — each
 * item carrying it reports so.
 *
 * Divergences from PHP, each deliberate: WC-2026-11-12-zotero-csl-json-import.
 */

import { copyFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import { getComponentModel } from '../../../src/core/components/registry.ts';
import {
	DedaloError,
	isDedaloError,
	logError,
	ok,
	toDedaloError,
} from '../../../src/core/errors/index.ts';
import { stagingDir } from '../../../src/core/media/ingest/add_file.ts';
import { processUploadedFile } from '../../../src/core/media/ingest/process_uploaded_file.ts';
import { resolveStagedName } from '../../../src/core/media/ingest/staged_files.ts';
import { buildMediaIdentifier, buildMediaLocation } from '../../../src/core/media/path.ts';
import { resolveMediaToolContext } from '../../../src/core/media/tool_support.ts';
import {
	nameKeysForQuality,
	persistUploadedMedia,
} from '../../../src/core/media/tools/files_info_persist.ts';
import { getEffectivePropertiesByTipo } from '../../../src/core/ontology/alias.ts';
import { getModelByTipo } from '../../../src/core/ontology/resolver.ts';
import { authorizeRecordAccess } from '../../../src/core/security/write_door.ts';
import { getToolConfig } from '../../../src/core/tools/config.ts';
import { parseCslJson } from '../../../src/core/tools/csl_json.ts';
import { resolveMappedCodes } from '../../../src/core/tools/import_code_lookup.ts';
import { VALUE_PROPERTY_MODELS } from '../../../src/core/tools/import_data.ts';
import {
	type ImportReport,
	importMappedRecords,
	type MappedField,
	type MappedRecord,
	type RecordResult,
} from '../../../src/core/tools/import_execute.ts';
import {
	type FormDdo,
	formValueFields,
	type TempDataEntry,
} from '../../../src/core/tools/import_form_values.ts';
import { readIngestTextFile } from '../../../src/core/tools/ingest_encoding.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	type ToolServerModule,
	toolRequestId,
	type WriteTarget,
} from '../../../src/core/tools/module.ts';
import {
	assertConfigSection,
	mapCslItem,
	readZoteroConfig,
	type TargetKind,
	type ZoteroConfig,
	type ZoteroMappedRecord,
} from '../../../src/core/tools/zotero_map.ts';

/** The tool's name — its config key in dd996 / dd1324. */
const TOOL_NAME = 'tool_import_zotero';

/** The door name the write door and the refusals carry. */
const DOOR = `${TOOL_NAME}.import_files`;

/**
 * A caller fault. `message` AND `publicMessage`: import_files is
 * backgroundRunnable, and the executor records the converter's wire sentence
 * on the job (background.ts `wireMessage`) — `message` is the log line only.
 */
function invalidRequest(message: string): DedaloError {
	return new DedaloError('request.invalid_options', { message, publicMessage: message });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** One `files_data` entry as the client posts it. */
interface FileEntry {
	name?: string;
	tmp_name?: string | null;
}

/** The display name: the client URI-encodes it; a bare '%' is not an escape. */
function displayName(entry: FileEntry): string {
	const raw = String(entry.name ?? '');
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}

/** The client `tool_config.ddo_map` (the Values form's fields) — the only client config read. */
function clientDdoMap(toolConfig: unknown): FormDdo[] {
	const ddoMap = isPlainObject(toolConfig) ? toolConfig.ddo_map : undefined;
	return Array.isArray(ddoMap) ? (ddoMap as FormDdo[]) : [];
}

/**
 * Resolve ONE staged file inside the user's staging dir (the server-assigned
 * `tmp_name` first, the legacy derivation otherwise — which throws rather than
 * guess), re-confined: null when it would land outside `dir`.
 */
function resolveStagedFile(dir: string, name: string, tmpName: string | null): string | null {
	const target = resolve(dir, resolveStagedName(dir, name, tmpName));
	return target.startsWith(dir + sep) ? target : null;
}

/** A staged file: its path, or the per-file error line. */
function stagedPath(dir: string, name: string, tmpName: string | null): string | { error: string } {
	let staged: string | null;
	try {
		staged = resolveStagedFile(dir, name, tmpName);
	} catch (error) {
		return { error: `${name}: ${(error as Error).message}` };
	}
	if (staged === null) return { error: `${name}: invalid file name` };
	if (!existsSync(staged)) return { error: `${name}: staged file not found` };
	return staged;
}

// ---------------------------------------------------------------------------
// TARGET KINDS — how each mapped component stores a value (zotero_map.ts)
// ---------------------------------------------------------------------------

/** component_date: the mode decides whether a range end can be kept. */
async function dateKind(tipo: string): Promise<TargetKind> {
	const properties = (await getEffectivePropertiesByTipo(tipo)) as { date_mode?: unknown } | null;
	const mode = properties?.date_mode;
	if (mode === 'range') return 'date_range';
	return mode === undefined || mode === null || mode === '' || mode === 'date' ? 'date' : 'other';
}

/** One component's kind, from its model. */
async function kindOfTipo(tipo: string): Promise<TargetKind> {
	const model = await getModelByTipo(tipo);
	if (model === null) return 'other';
	if (model === 'component_iri') return 'iri';
	if (model === 'component_date') return dateKind(tipo);
	return descriptorKind(model);
}

/** A non-date, non-iri model's kind, from its descriptor. */
function descriptorKind(model: string): TargetKind {
	const descriptor = getComponentModel(model);
	if (descriptor?.column === 'relation') return 'relation';
	if (descriptor?.render === 'html') return 'html';
	return VALUE_PROPERTY_MODELS.has(model) ? 'text' : 'other';
}

/** Every config target's kind (map entries + main.field_standard_number). */
async function targetKinds(cfg: ZoteroConfig): Promise<Map<string, TargetKind>> {
	const tipos = new Set(cfg.entries.map((entry) => entry.tipo));
	if (cfg.standardNumberTipo !== undefined) tipos.add(cfg.standardNumberTipo);
	const kinds = new Map<string, TargetKind>();
	for (const tipo of tipos) kinds.set(tipo, await kindOfTipo(tipo));
	return kinds;
}

// ---------------------------------------------------------------------------
// READ — the staged exports → mapped items
// ---------------------------------------------------------------------------

/** What reading the batch's exports produced. */
interface ReadBatch {
	mapped: ZoteroMappedRecord[];
	errors: string[];
	notices: string[];
	/** The exports read (consumed after the run — PHP unlink :680). */
	consumed: string[];
	names: string[];
}

/** Read + map ONE staged export into `batch`. */
async function readExport(
	staged: string,
	name: string,
	cfg: ZoteroConfig,
	kindOf: ReadonlyMap<string, TargetKind>,
	batch: ReadBatch,
): Promise<void> {
	let text: string;
	try {
		const decoded = await readIngestTextFile(staged, name);
		text = decoded.text;
		if (decoded.notice !== null) batch.notices.push(decoded.notice);
	} catch (error) {
		// The decoder's refusal is a DedaloError with a public sentence; anything
		// else is an engine fault and is not laundered into a report line.
		if (!isDedaloError(error)) throw error;
		batch.errors.push(`${name}: ${error.publicMessage ?? error.code}`);
		return;
	}
	const parsed = parseCslJson(text);
	if (parsed.error !== null) {
		batch.errors.push(`${name}: ${parsed.error}`);
		return;
	}
	batch.mapped.push(...parsed.items.map((item) => mapCslItem(item, cfg, { kindOf })));
	batch.consumed.push(staged);
	batch.names.push(name);
}

/** Every `.json` entry of the batch, read and mapped (PHP: the batch filtered to .json). */
async function readBatch(
	filesData: readonly FileEntry[],
	dir: string,
	cfg: ZoteroConfig,
	kindOf: ReadonlyMap<string, TargetKind>,
): Promise<ReadBatch> {
	const batch: ReadBatch = { mapped: [], errors: [], notices: [], consumed: [], names: [] };
	for (const entry of filesData) {
		const name = displayName(entry);
		if (!name.toLowerCase().endsWith('.json')) continue;
		const staged = stagedPath(dir, name, entry.tmp_name ?? null);
		if (typeof staged !== 'string') batch.errors.push(staged.error);
		else await readExport(staged, name, cfg, kindOf, batch);
	}
	return batch;
}

/** The run's notices: the per-item ones (named by the item's key) and the unmapped variables, once. */
function runNotices(batch: ReadBatch): string[] {
	const notices = [...batch.notices];
	const unmapped = new Set<string>();
	for (const [index, record] of batch.mapped.entries()) {
		const who = record.code ?? `item #${index + 1}`;
		notices.push(...record.notices.map((notice) => `${who}: ${notice}`));
		for (const name of record.unmapped) unmapped.add(name);
	}
	if (unmapped.size > 0) {
		notices.push(
			`Not in the Zotero map, so not imported: ${[...unmapped].sort().join(', ')}. Add a map entry in the Tools configuration to import them.`,
		);
	}
	return notices;
}

// ---------------------------------------------------------------------------
// ATTACHMENTS — after the records commit (files never roll back)
// ---------------------------------------------------------------------------

/** Where one record's attachments go, and who imports them. */
interface AttachmentScope {
	ctx: ToolActionContext;
	cfg: ZoteroConfig;
	sectionTipo: string;
	dir: string;
	keyDir: string;
	filesData: readonly FileEntry[];
}

/** The write door for one media component of a committed record. */
async function authorizeMedia(
	scope: AttachmentScope,
	sectionId: number,
	tipo: string,
): Promise<void> {
	await authorizeRecordAccess(
		scope.ctx.principal,
		{ section_tipo: scope.sectionTipo, component_tipo: tipo, section_id: sectionId },
		{ mode: 'write', level: 2, sectionFloor: 1, door: DOOR },
	);
}

/** A media component's resolved ingest context (identity, spec, paths). */
type MediaContext = Awaited<ReturnType<typeof resolveMediaToolContext>>;

/** The write door passed, the component resolved: what an ingest needs. */
async function prepareIngest(
	scope: AttachmentScope,
	sectionId: number,
	tipo: string,
): Promise<MediaContext> {
	await authorizeMedia(scope, sectionId, tipo);
	return resolveMediaToolContext({
		component_tipo: tipo,
		section_tipo: scope.sectionTipo,
		section_id: sectionId,
	});
}

/** What one ingest left for the report: its non-fatal failures and its notices. */
interface IngestOutcome {
	warnings: string[];
	notices: string[];
}

/**
 * Ingest one staged file into a prepared media component of a committed record —
 * the disk half (processUploadedFile) AND the record half (persistUploadedMedia),
 * like every upload door. Answers the non-fatal derivative failures and the
 * notices (a non-PDF original, a replaced transcription).
 */
async function ingestPrepared(
	scope: AttachmentScope,
	media: MediaContext,
	tmpName: string,
	originalFileName: string,
): Promise<IngestOutcome> {
	const extension = (tmpName.split('.').pop() ?? '').toLowerCase();
	const result = await processUploadedFile({
		spec: media.spec,
		identity: media.identity,
		pathOpts: media.pathOpts,
		userId: scope.ctx.userId,
		keyDir: scope.keyDir,
		tmpName,
		extension,
		originalFileName,
	});
	await persistUploadedMedia({
		sectionTipo: media.identity.sectionTipo,
		sectionId: media.identity.sectionId,
		componentTipo: media.identity.componentTipo,
		lang: media.identity.lang,
		filesInfo: result.filesInfo,
		originalFileName: originalFileName || result.originalFileName,
		originalNormalizedName: `${buildMediaIdentifier(media.identity)}.${result.extension}`,
		nameKeys: nameKeysForQuality(media.spec, undefined),
	});
	result.startTranscode?.();
	return { warnings: result.derivativeErrors, notices: result.notices };
}

/** Where the PDF's rendered cover lives (the first cover extension), or null when the type has none. */
function pdfCoverPath(media: MediaContext): string | null {
	const extension = media.spec.coverExtensions[0];
	if (extension === undefined) return null;
	return buildMediaLocation(
		media.spec,
		media.identity,
		media.spec.defaultQuality,
		extension,
		media.pathOpts,
	).absolutePath;
}

/**
 * The cover file's on-disk identity (inode, size, ns mtime/ctime), or null when
 * there is none. A PROBE: the catch is the answer ("no file").
 */
function fileStamp(path: string | null): string | null {
	if (path === null) return null;
	try {
		const stat = statSync(path, { bigint: true });
		return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
	} catch {
		return null;
	}
}

/**
 * The cover THIS ingest rendered, or null. A cover file that merely EXISTS is not
 * enough: a re-import whose new archive could not be rendered (no Ghostscript,
 * the page ceiling, a corrupt page) or is not a PDF rendition (.doc/.odt — no
 * rebuild at all) leaves the PREVIOUS document's cover in place, and taking it
 * would make an old picture the record's identifying image. So the file must be
 * new or changed against its stamp taken before the ingest.
 */
function coverBuiltByIngest(coverPath: string | null, before: string | null): string | null {
	const after = fileStamp(coverPath);
	return after !== null && after !== before ? coverPath : null;
}

/**
 * One attachment failure as its report line — and in the server log, typed
 * (CONVENTIONS §1: the attachments run after the records COMMITTED, best effort
 * per record like PHP's per-file import; the line is the defined degraded
 * result). A caller-facing refusal names its public sentence; anything else is
 * an engine fault: logged as one (internal.unexpected, errors_total) and the
 * line says so and names the request, never a generic "could not be imported".
 */
function attachmentFailure(scope: AttachmentScope, label: string, error: unknown): string {
	const requestId = toolRequestId(scope.ctx);
	const typed = toDedaloError(error);
	logError(typed, { subsystem: TOOL_NAME, ...(requestId === '' ? {} : { requestId }) });
	if (isDedaloError(error) && error.publicMessage !== undefined) {
		return `${label}: not imported — ${error.publicMessage}`;
	}
	if (isDedaloError(error) && typed.code !== 'internal.unexpected') {
		return `${label}: not imported — ${error.code}`;
	}
	const ref = requestId === '' ? '' : ` (request ${requestId})`;
	return `${label}: not imported — an internal error occurred; the server log names it${ref}`;
}

/**
 * The PDF's cover into main.identifying_image (PHP create_image + add_file):
 * the cover the pdf ingest just rendered, copied into the staging dir and
 * ingested like an upload. Answers the report lines. ITS OWN FAILURE IS ITS OWN
 * LINE: the PDF is already persisted when this runs, so a refused or failed
 * cover must never read as the PDF 'not imported'.
 */
async function importCover(
	scope: AttachmentScope,
	sectionId: number,
	cover: string | null,
	archive: string,
): Promise<string[]> {
	const imageTipo = scope.cfg.imageTipo;
	if (imageTipo === undefined) return [];
	if (cover === null) {
		return [
			`${archive}: no cover image — this import rendered none, so the record's identifying image is unchanged`,
		];
	}
	const tmpName = `zotero_cover_${sectionId}.${cover.split('.').pop()}`;
	const staged = resolve(scope.dir, tmpName);
	let copied = false;
	try {
		const media = await prepareIngest(scope, sectionId, imageTipo);
		copyFileSync(cover, staged);
		copied = true;
		const { warnings } = await ingestPrepared(scope, media, tmpName, `${archive} cover`);
		return warnings.map((warning) => `${archive} cover: imported, but ${warning}`);
	} catch (error) {
		return [attachmentFailure(scope, `${archive} cover`, error)];
	} finally {
		// The ingest moves the staged copy; a failed one leaves it behind. Only OUR
		// copy is removed — a path the copy never wrote is not this run's.
		if (copied) rmSync(staged, { force: true });
	}
}

/** One record's `archive` PDF (+ its cover), as report lines. */
async function importArchive(
	scope: AttachmentScope,
	sectionId: number,
	archive: string,
): Promise<string[]> {
	const pdfTipo = scope.cfg.pdfTipo;
	if (pdfTipo === undefined) {
		return [`${archive}: not imported — the Zotero config 'main' names no 'pdf' component`];
	}
	const entry = scope.filesData.find((file) => displayName(file) === archive);
	if (entry === undefined) {
		return [`${archive}: not imported — the file was not uploaded with the export`];
	}
	const staged = stagedPath(scope.dir, archive, entry.tmp_name ?? null);
	if (typeof staged !== 'string') return [`${staged.error} — not imported`];
	let cover: string | null;
	let pdf: IngestOutcome;
	try {
		const media = await prepareIngest(scope, sectionId, pdfTipo);
		const coverPath = pdfCoverPath(media);
		const before = fileStamp(coverPath);
		pdf = await ingestPrepared(scope, media, basename(staged), archive);
		cover = coverBuiltByIngest(coverPath, before);
	} catch (error) {
		return [attachmentFailure(scope, archive, error)];
	}
	const lines = [
		...pdf.warnings.map((warning) => `${archive}: imported, but ${warning}`),
		...pdf.notices.map((notice) => `${archive}: imported — ${notice}`),
	];
	return [...lines, ...(await importCover(scope, sectionId, cover, archive))];
}

/** Every committed record's attachments. A failure is that record's report line, never the run's. */
async function importAttachments(
	scope: AttachmentScope,
	mapped: readonly ZoteroMappedRecord[],
	results: readonly RecordResult[],
): Promise<string[]> {
	const lines: string[] = [];
	for (const { index, sectionId } of results) {
		const archive = mapped[index]?.archive ?? null;
		if (archive === null) continue;
		lines.push(
			...(sectionId === null
				? [`${archive}: not imported — its record was not written`]
				: await importArchive(scope, sectionId, archive)),
		);
	}
	return lines;
}

// ---------------------------------------------------------------------------
// THE ACTION
// ---------------------------------------------------------------------------

/** The Values form APPLIED after each record's mapped fields (a form value wins). */
function withFormValues(
	records: readonly MappedRecord[],
	formFields: readonly MappedField[],
): MappedRecord[] {
	if (formFields.length === 0) return [...records];
	return records.map((record) => ({ ...record, fields: [...record.fields, ...formFields] }));
}

/** CONSUME the staging form (WC-079) — only after a run that wrote something. Best effort. */
async function clearForm(userId: number): Promise<void> {
	try {
		const { clearTemporalScratch } = await import(
			'../../../src/core/section/record/temporal_store.ts'
		);
		await clearTemporalScratch(userId, TOOL_NAME);
	} catch (error) {
		console.warn(`[${TOOL_NAME}] scratch clear failed:`, (error as Error).message);
	}
}

/** The staged config + Values form, validated before anything is read. */
async function prepareRun(ctx: ToolActionContext, sectionTipo: string) {
	const cfg = readZoteroConfig(await getToolConfig(TOOL_NAME));
	assertConfigSection(cfg, sectionTipo);
	const o = ctx.options;
	const formFields = formValueFields(
		clientDdoMap(o.tool_config),
		(Array.isArray(o.components_temp_data) ? o.components_temp_data : []) as TempDataEntry[],
		sectionTipo,
		DOOR,
	);
	return { cfg, formFields, kindOf: await targetKinds(cfg) };
}

async function importFiles(ctx: ToolActionContext): Promise<ToolResponse> {
	const { sectionTipo, filesData, keyDir } = requestOf(ctx.options);
	const { cfg, formFields, kindOf } = await prepareRun(ctx, sectionTipo);
	// key_dir is TOP-LEVEL and server-sanitized; the dir is rebuilt from the
	// CURRENT user id, so no payload can reach another user's staged uploads.
	const dir = stagingDir(ctx.userId, keyDir);

	const batch = await readBatch(filesData, dir, cfg, kindOf);
	// The identifiers become addresses HERE, once, before anything is written.
	const resolved = await resolveMappedCodes(
		batch.mapped.map((record) => ({
			code: record.code,
			altCodes: record.url === null ? [] : [record.url],
			fields: record.fields,
			links: record.links,
		})),
		sectionTipo,
		cfg.idTarget,
		ctx.principal,
		'Zotero item key',
	);
	const report = await importMappedRecords(
		withFormValues(resolved, formFields),
		sectionTipo,
		ctx.principal,
		{
			bulkLabel: 'Zotero import',
			sourceFile: batch.names.join(', '),
		},
	);
	const attachments = await importAttachments(
		{ ctx, cfg, sectionTipo, dir, keyDir, filesData },
		batch.mapped,
		report.records,
	);
	for (const staged of batch.consumed) rmSync(staged, { force: true });
	if (report.created + report.updated > 0) await clearForm(ctx.userId);
	// A per-file or per-field failure never fails the batch: every list is PAYLOAD,
	// and the client renders each one (render_tool_import_zotero.js).
	return ok(reportPayload(report, batch, attachments), { requestId: toolRequestId(ctx) });
}

/** The request's own options, or the refusal of an empty one. */
function requestOf(o: Record<string, unknown>): {
	sectionTipo: string;
	filesData: FileEntry[];
	keyDir: string;
} {
	const sectionTipo = String(o.section_tipo ?? '');
	const filesData = (Array.isArray(o.files_data) ? o.files_data : []) as FileEntry[];
	if (sectionTipo === '' || filesData.length === 0) {
		throw invalidRequest('Missing section_tipo or files_data');
	}
	return { sectionTipo, filesData, keyDir: String(o.key_dir ?? '') };
}

/** The run's report — the wire payload (WC-2026-11-12-zotero-csl-json-import). */
function reportPayload(
	report: ImportReport,
	batch: ReadBatch,
	attachments: string[],
): Record<string, unknown> {
	const failedCount = report.failed.length > 0 ? `, ${report.failed.length} failed` : '';
	return {
		summary: `Zotero import done. Created ${report.created}, updated ${report.updated}${failedCount}.`,
		created: report.created,
		updated: report.updated,
		failed: report.failed,
		errors: batch.errors,
		notices: runNotices(batch),
		attachments,
		bulk_process_id: report.bulkProcessId,
	};
}

/**
 * The WRITE TARGETS a Zotero import can name BEFORE it runs — what the
 * 'targets' gate authorizes (audit CARRY-08 / TOOLS-04): the caller pair, plus
 * every `input_component` row of the client `tool_config.ddo_map` (the Values
 * form, written into each imported record).
 *
 * The FIELD MAP's components are not here: the map is the server's (dd996 /
 * dd1633), read by the handler at run time — this extractor is pure over the
 * options and may not read the database (module.ts `targets`). They are
 * RE-AUTHORIZED IN THE HANDLER: the shared executor asks the write door for
 * every mapped field of every record, a link create asks it for the linked
 * section and its name component (import_link.ts), and an attachment asks it
 * for the media component of its committed record. The map's own sections are
 * pinned to the import section before any read (`assertConfigSection`), and a
 * Values field of another section is refused before any write.
 */
export function importZoteroTargets(options: Record<string, unknown>): WriteTarget[] {
	const formTargets = clientDdoMap(options.tool_config)
		.filter((ddo) => ddo?.role === 'input_component')
		.map((ddo) => ({ section_tipo: ddo.section_tipo, tipo: ddo.tipo }));
	return [{ section_tipo: options.section_tipo, tipo: options.tipo }, ...formTargets];
}

export const tool: ToolServerModule = {
	name: TOOL_NAME,
	apiActions: {
		import_files: {
			permission: 'targets',
			minLevel: 2,
			targets: importZoteroTargets,
			handler: importFiles,
		},
	},
	backgroundRunnable: ['import_files'],
	// A bulk import — operator work (PERF-11 lane declaration).
	backgroundLanes: { import_files: 'maintenance' },
};
