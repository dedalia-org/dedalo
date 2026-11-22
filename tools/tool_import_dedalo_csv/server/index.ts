/**
 * tool_import_dedalo_csv server module (PHP tool_import_dedalo_csv).
 *
 * The tool is the API SURFACE; the import engine lives in core:
 *   - src/core/tools/import_csv.ts      — parse + plan (per-cell conform)
 *   - src/core/tools/import_conform.ts  — the per-model parsers (importConform facet)
 *   - src/core/tools/import_csv_execute.ts — apply the plan (one tx per row)
 *   - src/core/tools/import_wire.ts     — the typed report + progress contract
 *
 * Actions:
 *   get_section_components_list — the section's components for the column mapper.
 *   get_csv_files              — per-file column analysis + sample rows.
 *   delete_csv_file            — soft-delete a CSV in the per-user import dir.
 *   process_uploaded_file      — move a staged upload into the import dir.
 *   validate_import            — PREFLIGHT: check the column map + dry-run the
 *                                conform over a sample, before anything is written.
 *   import_files (background)  — the run. Publishes ImportProgressFrame ticks and
 *                                returns the per-file report batch.
 */

import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { config } from '../../../src/config/config.ts';
import { envSnapshot } from '../../../src/config/env.ts';
import { getImportAppendPolicy, isDerivedModel } from '../../../src/core/components/registry.ts';
import type { ImportAppendPolicy } from '../../../src/core/components/types.ts';
import { AUDIT_TIPOS, BULK_PROCESS_TIPOS } from '../../../src/core/concepts/section.ts';
import { withTransaction } from '../../../src/core/db/postgres.ts';
import { DedaloError, ok } from '../../../src/core/errors/index.ts';
import { sanitizeSegment } from '../../../src/core/media/ingest/add_file.ts';
import { assertTestMediaRoot } from '../../../src/core/media/test_media_root.ts';
import { resolveDataTipo } from '../../../src/core/ontology/alias.ts';
import { termByTipo } from '../../../src/core/ontology/labels.ts';
import { getModelByTipo, getTranslatableByTipo } from '../../../src/core/ontology/resolver.ts';
import { currentApplicationLang, currentDataLang } from '../../../src/core/resolve/request_lang.ts';
import { sectionInfoComponents } from '../../../src/core/resolve/section_elements_context.ts';
import { createSectionRecord } from '../../../src/core/section/record/create_record.ts';
import { saveComponentData } from '../../../src/core/section/record/save_component.ts';
import type { Principal } from '../../../src/core/security/permissions.ts';
import { withLiveBulkRun } from '../../../src/core/tools/bulk_run_registry.ts';
import {
	assertCsvStructure,
	CSV_INGEST_MAX_BYTES,
	type CsvAnalysis,
	type CsvColumn,
	type CsvParseResult,
	type ImportMode,
	planCsvImport,
} from '../../../src/core/tools/import_csv.ts';
import { executeCsvImport } from '../../../src/core/tools/import_csv_execute.ts';
import type {
	ImportFileReport,
	ImportProgressFrame,
	ImportRowIssue,
} from '../../../src/core/tools/import_wire.ts';
import {
	oversizedIngestSentence,
	readIngestTextFile,
} from '../../../src/core/tools/ingest_encoding.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	type ToolServerModule,
	toolRequestId,
} from '../../../src/core/tools/module.ts';

/**
 * A caller fault. `message` AND `publicMessage`: import_files is
 * backgroundRunnable, and the executor records the converter's wire sentence
 * on the job (background.ts `wireMessage`: this `publicMessage`, the code's
 * disclosure being public) — `message` is the log line only.
 */
function invalidRequest(message: string): DedaloError {
	return new DedaloError('request.invalid_options', { message, publicMessage: message });
}

/**
 * MEDIA_PATH unset. An OPERATOR fact (the import dir hangs off the media root),
 * not a caller one — registry English on the wire, the sentence in the log.
 */
function mediaRootMissing(): DedaloError {
	return new DedaloError('tool.dependency_unavailable', {
		coordinates: { tool: 'tool_import_dedalo_csv' },
		message: 'media root is not configured',
	});
}

/**
 * A fresh CSV worker that sees THIS process's environment. A Bun Worker started
 * without `env` gets the LAUNCH environment, not process.env as it stands now —
 * under `bun test` that is the environment before the suite preload pinned the
 * suite database, and the parser's import graph builds the matrix pool, which a
 * test process refuses to aim at the installation's database
 * (src/config/suite_database.ts). The server's own env (envSnapshot: process env
 * over ../private/.env) is the right one anyway.
 */
function newCsvWorker(): Worker {
	const env = Object.fromEntries(
		Object.entries(envSnapshot()).filter(
			(entry): entry is [string, string] => entry[1] !== undefined,
		),
	);
	return new Worker(new URL('./csv_worker.ts', import.meta.url).href, { env } as WorkerOptions);
}

/**
 * Parse CSV text OFF the serving event loop (audit S3-42): a fresh worker per
 * call (startup is milliseconds against multi-second parses; no idle thread
 * lingers) running the identical pure parser — see csv_worker.ts.
 */
function parseCsvOffLoop(text: string, delimiter?: string): Promise<CsvParseResult> {
	const worker = newCsvWorker();
	return new Promise<CsvParseResult>((resolvePromise, rejectPromise) => {
		worker.onmessage = (event: MessageEvent) => {
			const data = event.data as { result?: CsvParseResult; error?: string };
			if (data.error !== undefined) rejectPromise(new Error(data.error));
			else resolvePromise(data.result ?? { rows: [], unterminatedEnclosureRow: null });
		};
		worker.onerror = (event: ErrorEvent) => {
			rejectPromise(new Error(String(event.message ?? 'csv worker failed')));
		};
		worker.postMessage({ text, delimiter });
	}).finally(() => worker.terminate());
}

/**
 * Compute the get_csv_files summary OFF the serving event loop (audit S3-42): the
 * worker does the full parse AND the per-row malformed-JSON scan and returns only
 * the bounded summary — the full row set never crosses the thread boundary.
 */
function analyzeCsvOffLoop(text: string, delimiter?: string): Promise<CsvAnalysis | null> {
	const worker = newCsvWorker();
	return new Promise<CsvAnalysis | null>((resolvePromise, rejectPromise) => {
		worker.onmessage = (event: MessageEvent) => {
			const data = event.data as { analysis?: CsvAnalysis | null; error?: string };
			if (data.error !== undefined) rejectPromise(new Error(data.error));
			else resolvePromise(data.analysis ?? null);
		};
		worker.onerror = (event: ErrorEvent) => {
			rejectPromise(new Error(String(event.message ?? 'csv worker failed')));
		};
		worker.postMessage({ text, delimiter, analyze: true });
	}).finally(() => worker.terminate());
}

/** The per-user CSV import dir (PHP DEDALO_TOOL_IMPORT_DEDALO_CSV_FOLDER_PATH/<user>). */
function importDir(userId: number): string {
	const configured = config.media.rootPath;
	if (configured === null || configured === '') throw mediaRootMissing();
	// This door mkdirs and WRITES inside the media tree without going through
	// path.ts, so it asks the test-media guard itself (inert outside the seam).
	const root = assertTestMediaRoot(configured, 'tool_import_dedalo_csv.importDir');
	const dir = resolve(root, 'import/files', String(userId));
	const base = resolve(root, 'import/files');
	if (dir !== base && !dir.startsWith(base + sep)) {
		throw new DedaloError('internal.invariant', {
			message: 'import dir escapes the import root',
		});
	}
	mkdirSync(dir, { recursive: true, mode: 0o775 });
	return dir;
}

/** Confine a user-supplied file name inside the import dir (no traversal). */
function safeImportFile(dir: string, fileName: string): string {
	const target = resolve(dir, fileName);
	if (target !== dir && !target.startsWith(dir + sep)) throw invalidRequest('invalid file name');
	return target;
}

/**
 * All component tipos of a section (PHP get_ar_children_tipo_by_model_name_in_section
 * with recursive=true and **resolve_virtual=true**), not crossing child sections,
 * PLUS the common section-info components (dd196's children — PHP
 * get_section_components_list appended get_ar_children(DEDALO_SECTION_INFO_SECTION_GROUP)).
 *
 * (!) VIRTUAL SECTIONS. A virtual section has NO components of its own: its node's
 * relations[0].tipo points at the REAL section that owns them, minus the tipos its
 * exclude_elements child names. A plain subtree walk therefore returns an EMPTY list
 * for one — which is silent here, because the client renders an empty <select> and
 * simply auto-detects nothing (an empty array is truthy, so its `!ar_components`
 * error branch never fires). resolveVirtualEditScope is the canonical resolver the
 * rest of the engine already uses for exactly this (ontology/virtual_scope.ts).
 *
 * SECTION INFO (dd199/dd200/dd197/dd201 audit stamps, dd271, dd1223-5, dd1596).
 * Appended only when the section has components of its own and does not
 * suppress the group (dd542, dd15) — the buildSectionElementsContext rule, from
 * the same source (sectionInfoComponents). And only for a GLOBAL ADMIN: PHP
 * forces their permission for admins only, so every other principal's column on
 * them is refused per row at the write door (componentRefusal: IGNORED). This
 * list feeds the mapper AND the preflight, so a non-admin is never offered — nor
 * validated clean on — a column the door would then drop.
 */
async function sectionComponentTipos(
	sectionTipo: string,
	principal: Principal,
): Promise<{ tipo: string; model: string }[]> {
	const { getOrderedSubtree } = await import('../../../src/core/ontology/resolver.ts');
	const { resolveVirtualEditScope } = await import('../../../src/core/ontology/virtual_scope.ts');
	const { realTipo, excludeSet } = await resolveVirtualEditScope(sectionTipo);
	const nodes = await getOrderedSubtree(realTipo);
	const own = nodes
		.filter((node) => node.model?.startsWith('component_') === true)
		.filter((node) => !excludeSet.has(node.tipo))
		.map((node) => ({ tipo: node.tipo, model: node.model as string }));
	if (own.length === 0 || !principal.isGlobalAdmin) return own;
	// No de-duplication against `own`: a tipo has ONE parent, dd196's children
	// hang under dd196 (parent dd193, a `tools` node, never inside a section),
	// so no section subtree can contain them.
	return [...own, ...(await sectionInfoComponents(sectionTipo))];
}

/**
 * The audit tipos every section stamps (created/modified by/date). The engine
 * owns them — an import may REPLACE them (PHP parity: a re-import of an export
 * restores its stamps) but never APPEND to them: a record has one creation
 * date. Refused BY TIPO, because their models (date, select) say nothing about it.
 */
const AUDIT_TIPO_SET: ReadonlySet<string> = new Set(Object.values(AUDIT_TIPOS));

/**
 * Why an APPEND-mode column on (tipo, model) is refused, or null when it is
 * allowed. `model` MUST be the server-resolved model (getModelByTipo), never
 * the client's echo; `dataTipo` the tipo whose slot holds the data
 * (resolveDataTipo — the alias target for a component_alias). Refused: the section_id record key, the audit tipos, and
 * every model whose registry `importAppend` policy is `{refuse}` (media,
 * single-choice/opaque, derived). A model with no policy at all (not a
 * registered component) is refused with the registry's own sentence — loud,
 * never a silent replace.
 */
function appendRefusal(tipo: string, model: string, dataTipo: string = tipo): string | null {
	if (tipo === 'section_id' || model === 'component_section_id' || model === 'section_id') {
		return 'the section_id column is the record key; it cannot be appended to';
	}
	// BOTH tipos: a component_alias of an audit tipo stores into the audit
	// tipo's slot (resolveDataTipo), so it is that audit field.
	const audit = [tipo, dataTipo].find((candidate) => AUDIT_TIPO_SET.has(candidate));
	if (audit !== undefined) {
		return `'${audit}' is a record audit field (created/modified by/date); it cannot be appended to`;
	}
	let policy: ImportAppendPolicy;
	try {
		policy = getImportAppendPolicy(model);
	} catch (error) {
		return (error as Error).message;
	}
	return typeof policy === 'object' ? policy.refuse : null;
}

/**
 * Why a column on a DERIVED model is refused (any mode): the model's own
 * `importAppend` refusal, which names what to import instead.
 */
function derivedRefusal(model: string): string {
	const policy = getImportAppendPolicy(model);
	return typeof policy === 'object'
		? policy.refuse
		: `'${model}' is derived (computed, nothing stored) — it cannot be imported`;
}

/**
 * The model the import door judges a column on `tipo` by: getModelByTipo,
 * which hops a component_alias to its TARGET's model (resolveMappedColumns
 * reads exactly this). `listedModel` (the subtree node's own model) is the
 * fallback only when the resolver knows no model.
 */
async function doorModel(tipo: string, listedModel: string): Promise<string> {
	return (await getModelByTipo(tipo)) ?? listedModel;
}

/**
 * The component-list `import_append` field: the model's append policy
 * ('items' | 'geo_layer' | 'text_paragraphs'), or null when append is refused
 * for this component (the same verdict appendRefusal gives the import door,
 * so the mapper never offers a mode the server would refuse).
 */
async function wireAppendPolicy(
	tipo: string,
	listedModel: string,
): Promise<ImportAppendPolicy | null> {
	// An alias is listed under its own model; the door judges the TARGET's
	// model and data tipo (resolveMappedColumns), so the offer must too.
	const dataTipo = await resolveDataTipo(tipo);
	const model = await doorModel(tipo, listedModel);
	if (appendRefusal(tipo, model, dataTipo) !== null) return null;
	return getImportAppendPolicy(model);
}

/**
 * get_section_components_list: the section's components as
 * {label,value,model,import_append} for the CSV column-mapper dropdown, PLUS a
 * top-level `label` (the section term). `import_append` is the model's append
 * policy, or null when an append-mode column on it would be refused.
 *
 * DERIVED models (registry isDerivedModel: component_inverse, _relation_children,
 * _relation_index, _external — and an alias whose TARGET is one) are NOT
 * offered: the door refuses a column on them in EVERY mode (resolveMappedColumns
 * derivedRefusal), and the mapper never offers a column the door refuses
 * (user decision 2026-10-07). Membership (sectionComponentTipos) still holds
 * them, so a hand-crafted map onto one gets the precise derived refusal, not
 * "not a component of section".
 */
async function getSectionComponentsList(ctx: ToolActionContext): Promise<ToolResponse> {
	const sectionTipo = String(ctx.options.section_tipo ?? '');
	if (sectionTipo === '') throw invalidRequest('Missing section_tipo');
	const members = await sectionComponentTipos(sectionTipo, ctx.principal);
	const derived = await Promise.all(
		members.map(async (t) => isDerivedModel(await doorModel(t.tipo, t.model))),
	);
	const tipos = members.filter((_, index) => !derived[index]);
	const components = await Promise.all(
		tipos.map(async (t) => ({
			label: await termByTipo(t.tipo, currentApplicationLang()),
			value: t.tipo,
			model: t.model,
			import_append: await wireAppendPolicy(t.tipo, t.model),
		})),
	);
	const label = await termByTipo(sectionTipo, currentApplicationLang());
	return ok({ components, label }, { requestId: toolRequestId(ctx) });
}

/** One column of the CSV header → its component map ({tipo,label,model}) or null. */
async function resolveColumnMap(
	header: string,
): Promise<{ tipo: string; label: string; model: string } | null> {
	if (header === '') return null;
	if (header === 'section_id')
		return { tipo: 'section_id', label: 'Section ID', model: 'section_id' };
	// The lookup uses the BASE tipo (strip a date/relation suffix), but the returned
	// `tipo` keeps the full header so import matches the CSV column exactly (PHP parity).
	const base = header.includes('_') ? header.slice(0, header.indexOf('_')) : header;
	const model = await getModelByTipo(base);
	if (model === null) return null;
	const label = await termByTipo(base, currentApplicationLang());
	return { tipo: header, label, model };
}

/**
 * get_csv_files: list the user's CSVs, each with the column analysis the client
 * renders (PHP get_csv_files): name/dir, n_records/n_columns, file_info (header),
 * ar_columns_map (per-column {tipo,label,model}), sample_data (first DATA rows, no header) and
 * sample_data_errors (rows with malformed JSON cells). The parse + per-row scan
 * runs off the serving event loop (audit S3-42) and returns only the bounded
 * summary; only the ontology column-map lookup (header-sized) stays on-thread.
 */
async function getCsvFiles(ctx: ToolActionContext): Promise<ToolResponse> {
	const dir = importDir(ctx.userId);
	const filesInfo: Record<string, unknown>[] = [];
	const errors: string[] = [];
	// A conversion is NOT a read error (see the report contract in
	// import_csv_execute.ts): it travels in its own channel at every door.
	const notices: string[] = [];
	for (const name of readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.csv'))) {
		try {
			// DATA-09: decode DELIBERATELY (convert or refuse), never `Bun.file().text()`
			// — that is a fatal:false UTF-8 decode, and every byte it cannot read becomes
			// an irreversible U+FFFD in the preview the operator maps their columns from.
			// T1-S18: bounded in BYTES before a byte is buffered — the same ceiling as
			// validate_import / import_files, so what previews here will import.
			const decoded = await readIngestTextFile(resolve(dir, name), name, CSV_INGEST_MAX_BYTES);
			if (decoded.notice !== null) notices.push(decoded.notice);
			const analysis = await analyzeCsvOffLoop(decoded.text);
			if (analysis === null) {
				errors.push(`error reading file: ${name}`);
				filesInfo.push({ dir, name, read_error: `error reading file: ${name}` });
				continue;
			}
			const arColumnsMap = await Promise.all(analysis.header.map((cell) => resolveColumnMap(cell)));
			filesInfo.push({
				dir,
				name,
				n_records: analysis.n_records,
				n_columns: analysis.n_columns,
				file_info: analysis.header,
				ar_columns_map: arColumnsMap,
				sample_data: analysis.sample_data,
				sample_data_errors: analysis.sample_data_errors,
			});
		} catch (error) {
			// The read refusals (readIngestTextFile) are DedaloErrors carrying a vetted
			// public sentence (oversized, not text, damaged); anything else is a raw
			// filesystem message — LOGGED (it embeds absolute paths, SEC-17), never on
			// the wire: the operator reads a deliberate sentence.
			let sentence: string;
			if (error instanceof DedaloError && error.publicMessage !== undefined) {
				sentence = error.publicMessage;
			} else {
				console.warn(
					'[tool_import_dedalo_csv] get_csv_files: staged file could not be read:',
					name,
					(error as Error).message,
				);
				sentence = 'the file could not be read (the server log names the cause)';
			}
			errors.push(`Error on read file ${name}: ${sentence}`);
			// C51 (owner 2026-11-13): the file the panel cannot read is STILL LISTED, so
			// the operator can delete it from the panel — before, it was only in
			// `errors` and had no card, so no delete button: the staged file could not
			// be removed from the UI at all. The entry carries no column analysis;
			// `read_error` is the sentence and the client renders a delete-only card.
			// WC-2026-11-13-csv-staged-file-read-error-card.
			filesInfo.push({ dir, name, read_error: sentence });
		}
	}
	// `errors` is the per-file read problem list — payload, not a failed request
	// (one unreadable CSV must not hide the files that DID parse). `notices` is
	// the same shape for what we DID to a file we could read. A file in `errors`
	// is ALSO in `files`, as a `read_error` entry (C51).
	return ok({ files: filesInfo, errors, notices }, { requestId: toolRequestId(ctx) });
}

async function deleteCsvFile(ctx: ToolActionContext): Promise<ToolResponse> {
	const fileName = String(ctx.options.file_name ?? '');
	if (fileName === '') throw invalidRequest('Missing file_name');
	const dir = importDir(ctx.userId);
	const target = safeImportFile(dir, fileName);
	if (!existsSync(target) || !statSync(target).isFile()) {
		throw new DedaloError('tool.target_not_found', {
			coordinates: { tool: 'tool_import_dedalo_csv', file: fileName },
			message: 'This path does not correspond to a file. Ignored delete_csv_file',
		});
	}
	const deletedDir = resolve(dir, 'deleted');
	mkdirSync(deletedDir, { recursive: true, mode: 0o775 });
	renameSync(target, resolve(deletedDir, `${Date.now()}_${fileName}`));
	return ok({ deleted: fileName }, { requestId: toolRequestId(ctx) });
}

/**
 * T1-S18: refuse a staged CSV over the ingest ceiling BEFORE it enters the import
 * dir — early feedback in the upload panel. NOT the guard: files can reach the
 * import dir other ways, so the read door (readIngestTextFile) enforces the same
 * bound. The refused file stays staged (the staging sweep collects it).
 */
function assertStagedCsvSize(staged: string, fileName: string): void {
	const size = statSync(staged).size;
	if (size <= CSV_INGEST_MAX_BYTES) return;
	const sentence = oversizedIngestSentence(fileName, size, CSV_INGEST_MAX_BYTES);
	throw new DedaloError('media.too_large', { message: sentence, publicMessage: sentence });
}

async function processUploadedFile(ctx: ToolActionContext): Promise<ToolResponse> {
	const fileData = (ctx.options.file_data ?? {}) as {
		key_dir?: string;
		tmp_name?: string;
		file_name?: string;
	};
	const rawKeyDir = String(fileData.key_dir ?? '');
	const rawTmpName = String(fileData.tmp_name ?? '');
	if (rawTmpName === '') throw invalidRequest('Missing staged file (tmp_name)');
	// SEC (parity with PHP sanitize_key_dir): the staged source is REBUILT
	// server-side from the staging root + the CURRENT user id + sanitized
	// segments — never a client-supplied path. Without this, key_dir='../<uid>'
	// stays inside the shared staging root (so the root-confinement check below
	// passes) and lets one user claim another's staged upload. key_dir is
	// optional: empty means "no sub-dir", any non-empty value must sanitize.
	const keyDir = rawKeyDir === '' ? '' : sanitizeSegment(rawKeyDir);
	const tmpName = sanitizeSegment(rawTmpName);
	const fileName = String(fileData.file_name ?? tmpName);
	const configuredRoot = config.media.rootPath;
	if (configuredRoot === null) throw mediaRootMissing();
	const root = assertTestMediaRoot(configuredRoot, 'tool_import_dedalo_csv.stagedFile');
	const staged = resolve(root, config.media.upload.tmpSubdir, String(ctx.userId), keyDir, tmpName);
	const stagingBase = resolve(root, config.media.upload.tmpSubdir);
	if (!staged.startsWith(stagingBase + sep)) {
		throw new DedaloError('internal.invariant', {
			message: 'staged path escapes the upload root',
		});
	}
	if (!existsSync(staged)) {
		throw new DedaloError('tool.target_not_found', {
			coordinates: { tool: 'tool_import_dedalo_csv' },
			message: 'staged file not found',
		});
	}
	assertStagedCsvSize(staged, fileName);
	const dir = importDir(ctx.userId);
	renameSync(staged, safeImportFile(dir, fileName));
	return ok({ file_name: fileName }, { requestId: toolRequestId(ctx) });
}

/**
 * One entry of the client's `ar_columns_map` — INDEX-ALIGNED with the CSV header
 * (the mapper builds one per header cell). `tipo` is the header cell it was built
 * for; `map_to` is the component the user chose as the target (usually the same,
 * but the mapper lets them re-point a column); `checked` is the per-column import
 * switch; `decimal` is the number column's separator choice; `import_mode` is
 * the column's write mode ('replace' | 'append', absent = 'replace').
 */
interface CsvColumnMapEntry {
	tipo?: unknown;
	model?: unknown;
	checked?: unknown;
	map_to?: unknown;
	decimal?: unknown;
	import_mode?: unknown;
}

/**
 * One column's mode verdict, reported by validate_import (`columns[]`) so the
 * operator sees, per column, what the run will do — and which append the
 * server refuses — before anything is written.
 */
interface ColumnModeReport {
	index: number;
	column: string;
	tipo: string;
	model: string;
	mode: ImportMode;
	/** Why the append is refused (the whole file is refused with it), or null. */
	refused: string | null;
}

/** The resolved column plan + the per-column mode verdicts. */
interface ResolvedColumns {
	columns: (CsvColumn | null)[];
	modes: ColumnModeReport[];
	/** One sentence per refused append column; non-empty = the file is refused. */
	refusals: string[];
}

/**
 * Parse `import_mode` STRICTLY: absent (undefined/null) is 'replace'; anything
 * but 'replace' | 'append' refuses the WHOLE file — an unknown mode must never
 * be guessed (a typo of 'append' silently replacing would destroy data).
 */
function parseImportMode(entry: CsvColumnMapEntry, index: number, headerCell: string): ImportMode {
	const raw = entry.import_mode;
	if (raw === undefined || raw === null) return 'replace';
	if (raw === 'replace' || raw === 'append') return raw;
	throw invalidRequest(
		`Column ${index} ('${headerCell}'): unknown import_mode ${JSON.stringify(raw)} (expected 'replace' or 'append')`,
	);
}

/** One file of the client's import batch (options.files[]). */
interface CsvImportFile {
	file?: unknown;
	section_tipo?: unknown;
	ar_columns_map?: unknown;
	bulk_process_label?: unknown;
}

/** The section targets of an import batch — the 'section_list' gate reads these. */
function batchSectionTipos(options: Record<string, unknown>): unknown[] {
	const files = Array.isArray(options.files) ? (options.files as CsvImportFile[]) : [];
	return files.map((file) => file?.section_tipo);
}

/**
 * Resolve the user's column map against the CSV header into the plan's column
 * array. A null entry means "skip this column". The filters, in PHP's order:
 *   - the section_id column is the record KEY, never written as a component;
 *   - unchecked / unmapped columns were deselected in the UI;
 *   - a map entry whose `tipo` no longer equals the header cell at its index was
 *     built for a DIFFERENT csv layout — skip rather than write to the wrong
 *     component (this is why the map is matched positionally AND by name).
 *
 * import_mode (per column): parsed strictly on every entry (an unknown value
 * THROWS — the whole file is refused, before the caller creates its dd800
 * bulk-process record). An APPEND column is checked against the SERVER-resolved
 * model (appendRefusal); a column on a DERIVED model (isDerivedModel) is
 * refused in ANY mode; a refused column lands in `refusals`, and both callers
 * refuse the file on a non-empty list — import_files before any write,
 * validate_import in its report.
 */
async function resolveMappedColumns(
	header: readonly string[],
	columnsMap: readonly (CsvColumnMapEntry | null)[],
	errors: string[],
): Promise<ResolvedColumns> {
	const columns: (CsvColumn | null)[] = [];
	const modes: ColumnModeReport[] = [];
	const refusals: string[] = [];
	for (let i = 0; i < header.length; i++) {
		const entry = columnsMap[i] ?? null;
		const headerCell = header[i] ?? '';
		if (entry === null || typeof entry !== 'object') {
			columns.push(null);
			continue;
		}
		const mode = parseImportMode(entry, i, headerCell);
		// The record key: the planner reads it to match/create, never saves it.
		// It is an imported column like any other: it ALWAYS has its columns[]
		// entry (replace — the planner's key — or a refused append).
		if (entry.model === 'section_id' || entry.model === 'component_section_id') {
			const reason =
				mode === 'append' ? (appendRefusal('section_id', 'component_section_id') as string) : null;
			if (reason !== null) {
				refusals.push(`Column ${i} ('${headerCell}'): append refused — ${reason}`);
			}
			modes.push({
				index: i,
				column: headerCell,
				tipo: 'section_id',
				model: 'component_section_id',
				mode,
				refused: reason,
			});
			columns.push({
				tipo: 'section_id',
				model: 'component_section_id',
				columnName: headerCell,
				lang: 'lg-nolan',
			});
			continue;
		}
		const mapTo = typeof entry.map_to === 'string' ? entry.map_to : '';
		if (entry.checked !== true || mapTo === '') {
			columns.push(null);
			continue;
		}
		if (String(entry.tipo ?? '') !== headerCell) {
			errors.push(
				`Ignored column ${i} ('${headerCell}'): the column map was built for '${String(entry.tipo ?? '')}'`,
			);
			columns.push(null);
			continue;
		}
		const model = await getModelByTipo(mapTo);
		if (model === null) {
			errors.push(`Ignored column ${i} ('${headerCell}'): unknown target component '${mapTo}'`);
			columns.push(null);
			continue;
		}
		// columnName keeps the FULL header cell: the conform facets read its suffix
		// (tipo_dmy → the date order; tipo_<section_tipo> → the relation target).
		// tipo is the TARGET (map_to), which may differ from the header.
		// The append gate reads the SERVER-resolved model (above), never entry.model.
		// The data tipo (the alias TARGET for a component_alias): the audit
		// refusal must see through an alias, and the executor keys every
		// stored-data read, id allocation and frame pairing by it.
		const dataTipo = await resolveDataTipo(mapTo);
		// A DERIVED component (registry isDerivedModel) owns no stored value: a
		// column on it is refused in EVERY mode — a replace would write leftover
		// bytes no read serves (or, for component_relation_children, re-parent
		// records from a cell). Its append policy's reason says what to import
		// instead (user decision 2026-09-27: refuse, import the child's parent).
		const derived = isDerivedModel(model) ? derivedRefusal(model) : null;
		const refused = derived ?? (mode === 'append' ? appendRefusal(mapTo, model, dataTipo) : null);
		if (derived !== null) {
			refusals.push(`Column ${i} ('${headerCell}' → ${mapTo}, ${model}): refused — ${derived}`);
		} else if (refused !== null) {
			refusals.push(
				`Column ${i} ('${headerCell}' → ${mapTo}, ${model}): append refused — ${refused}`,
			);
		}
		modes.push({ index: i, column: headerCell, tipo: mapTo, model, mode, refused });
		const translatable = await getTranslatableByTipo(mapTo);
		columns.push({
			tipo: mapTo,
			model,
			...(dataTipo !== mapTo ? { dataTipo } : {}),
			columnName: headerCell,
			// THE REQUEST's data language (audit DATA-01), never the static
			// DEDALO_DATA_LANG: the write is lang-sliced, so the install default
			// REPLACED the operator's actual working language and an empty cell
			// CLEARED it. currentDataLang() is the SUBMITTER's inside the background
			// job this import runs in: the job manager pins the submit-time langs
			// around the worker (media/jobs.ts JobRunScope).
			lang: translatable ? currentDataLang() : 'lg-nolan',
			decimal: typeof entry.decimal === 'string' ? entry.decimal : undefined,
			mode,
		});
	}
	return { columns, modes, refusals };
}

/**
 * The dd800 record that owns this import run. Every save the run makes is
 * attributed to its id (its undo pair + visible TM row), so the whole import
 * can be reverted as ONE operation. Created BEFORE any data row is touched — a
 * failure here fails the file rather than importing unattributably — and ATOMIC:
 * the row, its file and its label are ONE transaction, so a refused label
 * leaves no orphan dd800 in the operator's Processes list (the twin of
 * import_execute's mint).
 */
async function createBulkProcessRecord(
	fileName: string,
	label: string,
	userId: number,
): Promise<number> {
	return await withTransaction(async () => {
		const bulkProcessId = await createSectionRecord(BULK_PROCESS_TIPOS.section, userId);
		for (const [tipo, value] of [
			[BULK_PROCESS_TIPOS.file, fileName],
			[BULK_PROCESS_TIPOS.label, label],
		] as const) {
			const outcome = await saveComponentData({
				componentTipo: tipo,
				sectionTipo: BULK_PROCESS_TIPOS.section,
				sectionId: bulkProcessId,
				lang: 'lg-nolan',
				changedData: [{ action: 'set_data', id: null, value: [{ value }] }],
				userId,
			});
			if (outcome.ok === false) {
				throw new DedaloError('record.save_failed', {
					message: `the dd800 run record was refused: ${outcome.message}`,
					coordinates: { section_tipo: BULK_PROCESS_TIPOS.section, tipo },
				});
			}
		}
		return bulkProcessId;
	});
}

/**
 * Read + parse one staged CSV, or throw with a caller-facing message.
 *
 * THE INGEST DOOR (DATA-04/DATA-09). Three things happen here and nowhere else:
 * the bytes are decoded deliberately (converted or refused, never substituted),
 * the parse result is checked for a shape we can trust (an unterminated
 * enclosure, a row that disagrees with the header), and only then do the rows
 * reach the planner. `notices` are the operator-facing facts about the read
 * itself — the caller folds them into the file's report.
 */
async function readCsvRows(
	userId: number,
	fileName: string,
): Promise<{ rows: string[][]; notices: string[] }> {
	const target = safeImportFile(importDir(userId), fileName);
	if (!existsSync(target)) {
		throw new DedaloError('tool.target_not_found', {
			coordinates: { tool: 'tool_import_dedalo_csv' },
			message: `File not found: ${fileName}`,
		});
	}
	// T1-S18: the ceiling holds HERE, before the read — this door parses the
	// whole file and clones every row back to this thread.
	const decoded = await readIngestTextFile(target, fileName, CSV_INGEST_MAX_BYTES);
	const parsed = await parseCsvOffLoop(decoded.text);
	assertCsvStructure(parsed, fileName);
	const rows = parsed.rows;
	if (rows[0] === undefined || rows.length < 2) throw invalidRequest('CSV has no data rows');
	return { rows, notices: decoded.notice === null ? [] : [decoded.notice] };
}

/** The component labels a progress tick may need, resolved ONCE per file. */
async function resolveColumnLabels(
	columns: readonly (CsvColumn | null)[],
): Promise<Map<string, string>> {
	const labels = new Map<string, string>();
	for (const column of columns) {
		if (column === null || column.model === 'component_section_id') continue;
		if (labels.has(column.tipo)) continue;
		labels.set(column.tipo, await termByTipo(column.tipo, currentApplicationLang()));
	}
	return labels;
}

/**
 * validate_import — the PREFLIGHT (PHP verify_csv_map, widened).
 *
 * PHP validated the column map only, and only at import time, throwing the file
 * away on the first bad tipo. This runs BEFORE any write and answers the two
 * questions the user actually has: is my mapping valid, and will my VALUES parse?
 * The conform is dry-run over a bounded sample of rows, so a 10k-row file with a
 * date column in the wrong order is caught in milliseconds instead of after a
 * 10k-row failed run.
 *
 * IT IS THE ONLY PREFLIGHT THE OPERATOR HAS, so everything the DOOR would refuse
 * or skip has to be visible HERE, or "validated clean" means nothing:
 *  - a STRUCTURAL refusal (a row whose width disagrees with the header, an
 *    unterminated enclosure) is raised by readCsvRows -> assertCsvStructure and
 *    lands in this file's `errors` through the catch below, with ok:false. It is
 *    the same refusal import_files makes, taken at the same door;
 *  - a row whose section_id cell is NOT A RECORD ID (DATA-22) is reported per
 *    row, because the import will SKIP that row: a file whose key column is
 *    unreadable used to validate clean and then import nothing.
 */
const VALIDATE_SAMPLE_ROWS = 20;

async function validateImport(ctx: ToolActionContext): Promise<ToolResponse> {
	const files = Array.isArray(ctx.options.files) ? (ctx.options.files as CsvImportFile[]) : [];
	if (files.length === 0) throw invalidRequest('Missing files');

	const result: Record<string, unknown>[] = [];
	for (const current of files) {
		const fileName = String(current.file ?? '');
		const sectionTipo = String(current.section_tipo ?? '');
		try {
			if (fileName === '' || sectionTipo === '')
				throw invalidRequest('Missing file or section_tipo');
			const { rows, notices } = await readCsvRows(ctx.userId, fileName);
			const header = rows[0] as string[];

			const errors: string[] = [];
			const columnsMap = Array.isArray(current.ar_columns_map)
				? (current.ar_columns_map as (CsvColumnMapEntry | null)[])
				: [];
			const { columns, modes, refusals } = await resolveMappedColumns(header, columnsMap, errors);
			// A refused append is a FILE refusal at import time — report it as one.
			errors.push(...refusals);

			// Every mapped target must be a component of THIS section (PHP verify_csv_map).
			const sectionTipos = new Set(
				(await sectionComponentTipos(sectionTipo, ctx.principal)).map((c) => c.tipo),
			);
			for (const column of columns) {
				if (column === null || column.model === 'component_section_id') continue;
				if (!sectionTipos.has(column.tipo)) {
					errors.push(
						`Column '${column.columnName}' maps to '${column.tipo}', which is not a component of section '${sectionTipo}'`,
					);
				}
			}

			const mapped = columns.filter(
				(column) => column !== null && column.model !== 'component_section_id',
			);
			if (mapped.length === 0) errors.push('No column is mapped for import');
			if (!columns.some((column) => column?.model === 'component_section_id')) {
				errors.push('The CSV has no section_id column — rows cannot be matched to records');
			}

			// Dry-run the conform over a sample: this is what catches a wrong date order
			// or a decimal separator, which no map check can see.
			const sample = rows.slice(1, 1 + VALIDATE_SAMPLE_ROWS);
			const plan = await planCsvImport(sample, columns, sectionTipo);
			const issues = plan.flatMap((record) =>
				record.columns.flatMap((column) =>
					column.conform.errors.map((error) => ({ ...error, row: record.row })),
				),
			);
			const sampleWarnings = plan.flatMap((record) =>
				record.columns.flatMap((column) =>
					column.conform.warnings.map((warning) => ({ ...warning, row: record.row })),
				),
			);
			// The KEY the planner could not read (DATA-22). The import SKIPS such a
			// row, so a preflight that ignores it validates a file that will write
			// nothing — the blindness this door existed to remove.
			const keyIssues: ImportRowIssue[] = plan
				.filter((record) => record.keyError !== null)
				.map((record) => ({
					section_id: 0,
					component_tipo: '',
					msg: `the row would be SKIPPED — ${record.keyError}`,
					data: null,
					row: record.row,
				}));

			const failed = [...issues, ...keyIssues];
			result.push({
				// The encoding notice is REPORTED, never a verdict: a file we converted
				// is importable, and the operator has to be told what we did with it —
				// blocking the run instead would only hide the conversion behind a retry.
				// It rides `notices`, not `errors`: those two words mean different
				// things to the panel and to a caller reading `ok`.
				ok: errors.length === 0 && failed.length === 0,
				file: fileName,
				section_tipo: sectionTipo,
				rows_total: rows.length - 1,
				rows_sampled: sample.length,
				errors,
				notices,
				failed,
				warnings: sampleWarnings,
				// Per imported column: its write mode and, for an append, the refusal.
				columns: modes,
			});
		} catch (error) {
			// EVERY door refusal arrives here — including the structural ones
			// (assertCsvStructure) and an undecodable upload — and each is reported
			// with its own sentence, which is the operator's repair instruction.
			result.push({
				ok: false,
				file: fileName,
				section_tipo: sectionTipo,
				errors: [(error as Error).message],
				notices: [],
				failed: [],
				warnings: [],
				columns: [],
			});
		}
	}
	// A validation REPORT is a successful answer whatever it says: `ready` is the
	// verdict, `files` the per-file detail the panel renders.
	const ready = result.every((file) => file.ok === true);
	return ok(
		{
			ready,
			files: result,
			summary: ready
				? 'OK. The import is ready to run'
				: 'The import has problems — see the report',
		},
		{ requestId: toolRequestId(ctx) },
	);
}

/**
 * import_files: the client posts a BATCH — options.files[] = {file, section_tipo,
 * ar_columns_map, bulk_process_label}. Each file carries its
 * own section target and column map, so the write gate is per file; it has already
 * run in the dispatcher ('section_list' spec below), i.e. BEFORE the background
 * fork, where a denial is still observable to the caller.
 *
 * Returns the per-file report batch and publishes ImportProgressFrame ticks while it
 * runs (ctx.publishProgress → the job's subscribers → the client's panel).
 */
async function importFiles(ctx: ToolActionContext): Promise<ToolResponse> {
	const files = Array.isArray(ctx.options.files) ? (ctx.options.files as CsvImportFile[]) : [];
	if (files.length === 0) throw invalidRequest('Missing files');
	// NO TIME-MACHINE OPT-OUT (decision D1, WC bulk-revert-undo-log). PHP's
	// `time_machine_save` flag is retired: every save of a run records its
	// BEFORE/AFTER undo pair and a visible after-row, because a run that left no
	// record of what it replaced could not be reverted exactly. A legacy caller
	// still sending the flag is not refused — the flag can only ask for LESS
	// history, and none is withheld — it is simply not read.
	const publish = ctx.publishProgress ?? ((): void => {});

	const report: ImportFileReport[] = [];
	for (const [index, current] of files.entries()) {
		const fileName = String(current.file ?? '');
		const sectionTipo = String(current.section_tipo ?? '');
		// The run's dd800 id once minted. The catch reports IT, never a blanket
		// null: a failure after the mint must name the run record it left behind
		// (revertable, in the Processes list), and a refusal before the mint
		// honestly answers null (gate C of csv_ingest_ceiling_native counts it).
		let bulkProcessId: number | null = null;
		try {
			if (fileName === '' || sectionTipo === '')
				throw invalidRequest('Missing file or section_tipo');

			publish({
				phase: 'reading',
				file: fileName,
				file_index: index + 1,
				files_total: files.length,
				row: 0,
				rows_total: 0,
				section_id: null,
				component_label: null,
				created: 0,
				updated: 0,
				failed: 0,
				warnings: 0,
			} satisfies ImportProgressFrame);

			const { rows, notices } = await readCsvRows(ctx.userId, fileName);
			const header = rows[0] as string[];

			// `errors` starts EMPTY: the read's notices ride the report's NOTICE
			// channel instead. The panel paints `errors` red, and an intended,
			// successful encoding conversion reported as a failure is a lie about a
			// good import — the report is still the only place the operator learns
			// of the conversion, just not in the colour of a refusal.
			const errors: string[] = [];
			const columnsMap = Array.isArray(current.ar_columns_map)
				? (current.ar_columns_map as (CsvColumnMapEntry | null)[])
				: [];
			const { columns, refusals } = await resolveMappedColumns(header, columnsMap, errors);
			// A refused APPEND refuses the whole file HERE — before the dd800 record
			// below exists, so a refusal leaves no trace. Never downgraded to replace.
			if (refusals.length > 0) throw invalidRequest(refusals.join('; '));
			if (!columns.some((column) => column !== null && column.model !== 'component_section_id')) {
				throw invalidRequest('No column is mapped for import');
			}

			bulkProcessId = await createBulkProcessRecord(
				fileName,
				String(current.bulk_process_label ?? fileName),
				ctx.userId,
			);
			const plan = await planCsvImport(rows.slice(1), columns, sectionTipo);
			const labels = await resolveColumnLabels(columns);
			// The run is held in the active-run registry while it writes: a revert
			// of it is refused until it ends (decision D5).
			const runId = bulkProcessId;
			const fileReport = await withLiveBulkRun(runId, () =>
				executeCsvImport({
					plan,
					sectionTipo,
					principal: ctx.principal,
					bulkProcessId: runId,
					errors,
					notices,
					progress: {
						file: fileName,
						fileIndex: index + 1,
						filesTotal: files.length,
						labels,
						publish,
					},
				}),
			);
			report.push(fileReport);
		} catch (error) {
			report.push({
				ok: false,
				file: fileName,
				section_tipo: sectionTipo,
				bulk_process_id: bulkProcessId,
				created: [],
				updated: [],
				failed: [],
				warnings: [],
				errors: [(error as Error).message],
				// A file refused at the door (unreadable bytes, a shape we cannot map)
				// never reached a read notice.
				notices: [],
				rows_total: 0,
				ms: 0,
			});
		}
	}

	const created = report.reduce((sum, file) => sum + file.created.length, 0);
	const updated = report.reduce((sum, file) => sum + file.updated.length, 0);
	const failed = report.reduce((sum, file) => sum + file.failed.length, 0);
	// Per-file failures are PAYLOAD (`files[].errors`): a batch where one file
	// failed still imported the others, and the panel renders the whole report.
	return ok(
		{
			files: report,
			summary: `Import done. Created ${created}, updated ${updated}, failed ${failed}.`,
			created,
			updated,
			failed,
		},
		{ requestId: toolRequestId(ctx) },
	);
}

export const tool: ToolServerModule = {
	name: 'tool_import_dedalo_csv',
	apiActions: {
		get_section_components_list: {
			permission: 'section',
			minLevel: 1,
			handler: getSectionComponentsList,
		},
		get_csv_files: {
			permission: null,
			gatedInHandler:
				"NOT AN AUTHORIZATION GATE — importDir(ctx.userId) confines the listing to the caller's OWN staging directory, rebuilt server-side from the authenticated user id, so there is no cross-user reach and no ontology target to gate on. No permission is checked; the CSV column map it returns resolves ontology labels for any header cell the file names.",
			handler: getCsvFiles,
		},
		delete_csv_file: {
			permission: null,
			gatedInHandler:
				"NOT AN AUTHORIZATION GATE — importDir(ctx.userId) + safeImportFile() rebuild the target path from the authenticated user id and a sanitized name, so the delete cannot leave the caller's own staging directory. Nothing else is checked; the file is the caller's own upload, not a record.",
			handler: deleteCsvFile,
		},
		process_uploaded_file: {
			permission: null,
			gatedInHandler:
				"NOT AN AUTHORIZATION GATE — sanitizeSegment() + the staging-root confinement rebuild BOTH ends from ctx.userId (parity with PHP sanitize_key_dir), so one user cannot claim another's staged upload; importDir(ctx.userId) is the destination. No permission is checked and none applies: no record is written. The write gate lives on import_files, where the section targets exist.",
			handler: processUploadedFile,
		},
		// The preflight READS the same targets the import writes, so it is gated at
		// READ level on every one of them — it must never become a way to probe a
		// section the caller cannot see.
		validate_import: {
			permission: 'section_list',
			minLevel: 1,
			sectionTipos: batchSectionTipos,
			handler: validateImport,
		},
		// The batch's targets ride inside options.files[], one section per file, so
		// the gate asserts WRITE on every one before the fork (SEC-024 §9.2).
		import_files: {
			permission: 'section_list',
			minLevel: 2,
			sectionTipos: batchSectionTipos,
			handler: importFiles,
		},
	},
	backgroundRunnable: ['import_files'],
	// A bulk import — operator work (PERF-11 lane declaration).
	backgroundLanes: { import_files: 'maintenance' },
};
