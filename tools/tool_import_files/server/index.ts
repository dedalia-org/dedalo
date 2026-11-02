/**
 * tool_import_files server module (PHP tool_import_files) — import MEDIA files,
 * matching each to records by the filename stored in a target_filename component.
 *
 * get_media_section_match_from_souce: walk a SOURCE record's relation locators to
 *   the target section, match by stored filename basename (relation-driven).
 * get_media_section_match: free-name match via an SQO filter on the
 *   target_filename component path (sanitizeClientSqo + buildSearchSql — the
 *   PHP :1490 search), confirmed by the exact basename comparison.
 * file_processor: run a REGISTERED named processor on a staged file (SEC-053 →
 *   allowlist: only registered names run. crop_50 — the numisdata coin-split
 *   splitter — is the first ported entry, registered at module load below; the
 *   per-file import_files flow is what consumes a splitter's outputs).
 * import_files (backgroundRunnable): media import across all name-modes —
 *   default (create) / enumerate (filename numeric prefix → section_id) / named
 *   (base_name grouping) / match + match_freename (matcher-driven, with the
 *   multi-target copy loop) — plus the tool_config.ddo_map role writes
 *   (setComponentsData) and the component_option PORTAL chain (create the media
 *   record through the portal and link it, PHP :1108-1267).
 *
 * DDO-map roles (PHP set_components_data :1592):
 *   target_component — the media component that receives the file (no data write);
 *   target_filename  — original filename into a text component, ONLY when empty;
 *   target_date      — EXIF/container/PDF capture date of the staged file
 *                      (media/file_date.ts getMediaFileDate), ONLY when empty;
 *                      no readable date keeps PHP's skip-when-empty path;
 *   input_component  — import-form values from components_temp_data. The wire
 *                      key is `entries` (WC-001), NOT `value`. Translatable
 *                      components are written per-lang from the entries the
 *                      client ships (each carries its own `lang`), since a
 *                      save call writes exactly ONE lang slice — PHP instead
 *                      copied all langs out of a temp-session component;
 *   component_option — import routing (the portal), never a data write.
 *
 * All component writes go through saveComponentData (tx-wrapped, TM-audited);
 * the portal link reuses the add_new_element relation hook (relations/save.ts).
 */

import { copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { MediaTypeSpec } from '../../../src/core/concepts/media.ts';
import { sanitizeClientSqo } from '../../../src/core/concepts/sqo.ts';
import { readMatrixRecord } from '../../../src/core/db/matrix.ts';
import { withTransaction } from '../../../src/core/db/postgres.ts';
import { DedaloError, ok } from '../../../src/core/errors/index.ts';
import { getMediaFileDate, withDedaloTime } from '../../../src/core/media/file_date.ts';
import { sanitizeSegment, stagingDir } from '../../../src/core/media/ingest/add_file.ts';
import {
	processUploadedFile,
	requireMediaSpec,
} from '../../../src/core/media/ingest/process_uploaded_file.ts';
import { resolveStagedName } from '../../../src/core/media/ingest/staged_files.ts';
import { resolveMediaToolContext } from '../../../src/core/media/tool_support.ts';
import { cropCoinPair } from '../../../src/core/media/tools/crop_coin_pair.ts';
import {
	getColumnNameByModel,
	getMatrixTableFromTipo,
	getModelByTipo,
	getNode,
	getTranslatableByTipo,
} from '../../../src/core/ontology/resolver.ts';
import { buildRequestConfigForElement } from '../../../src/core/relations/request_config/build.ts';
import { extractSqoSectionTipos } from '../../../src/core/relations/request_config/explicit.ts';
import { readComponentItems } from '../../../src/core/resolve/component_data.ts';
import { currentDataLang } from '../../../src/core/resolve/request_lang.ts';
import { runSearch } from '../../../src/core/search/search_statement.ts';
import { buildSearchSql } from '../../../src/core/search/sql_assembler.ts';
import {
	bornInCurrentTransaction,
	createSectionRecord,
} from '../../../src/core/section/record/create_record.ts';
import { saveComponentData } from '../../../src/core/section/record/save_component.ts';
import { getPermissions, type Principal } from '../../../src/core/security/permissions.ts';
import { assertRecordWriteTarget } from '../../../src/core/security/record_scope.ts';
import {
	authorizeRecordAccess,
	authorizeSectionTarget,
} from '../../../src/core/security/write_door.ts';
import {
	basenamesMatch,
	type FileProcessorOutput,
	fileBasename,
	getFileProcessor,
	registerFileProcessor,
} from '../../../src/core/tools/import_files_match.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	type ToolServerModule,
	toolRequestId,
	type WriteTarget,
} from '../../../src/core/tools/module.ts';
import { parseFilename } from './filename_grammar.ts';

// Registered at module load — the tool loader imports this module once, so
// this runs exactly once per process. Keeps the SEC-053 allowlist model
// intact (getFileProcessor still refuses anything not explicitly registered
// here) while giving crop_50 a real implementation instead of the previous
// permanently-empty registry.
registerFileProcessor('crop_50', cropCoinPair);

/**
 * A caller fault. `message` AND `publicMessage`: import_files is
 * backgroundRunnable, and the executor records the converter's wire sentence
 * on the job (background.ts `wireMessage`: this `publicMessage`, the code's
 * disclosure being public) — `message` is the log line only.
 */
function invalidRequest(message: string): DedaloError {
	return new DedaloError('request.invalid_options', { message, publicMessage: message });
}

/** A role write the save layer refused. The engine sentence stays log-only. */
function saveRefused(message: string, tipo: string): DedaloError {
	return new DedaloError('record.save_failed', {
		coordinates: { tool: 'tool_import_files', tipo },
		message,
	});
}

/** A locator as READ from a stored `relation` jsonb bag. The union is stored-
 * legacy passthrough: an install not yet swept by
 * scripts/migrate_section_id_locators.ts still holds the PHP string form
 * (WC-2026-08-10-section-id-int-canonical) — narrows at contraction. */
interface Locator {
	section_tipo?: string;
	section_id?: number | string;
}

/** One tool_config.ddo_map entry (PHP ontology tool configuration properties). */
export interface DdoMapEntry {
	role?: string;
	tipo?: string;
	section_tipo?: string;
	/** Portal ddos may pin the target section explicitly (PHP :1214). */
	target_section_tipo?: string;
	/** target_filename: store only the parsed base_name (PHP :1661). */
	only_basename?: boolean;
	model?: string;
	label?: string;
}

/**
 * One components_temp_data entry (the import-form component payload).
 *
 * The client pushes each tmp-section instance's `data` verbatim
 * (service_tmp_section.get_components_data). Under WC-001 the engine emits
 * component values as `entries` (resolve/component_data.ts buildDataItem), so
 * `entries` is the LIVE key; `value` is kept only as the PHP-era fallback for
 * any caller still shipping the old shape. Reading `value` alone silently
 * dropped every Values field the operator typed.
 */
export interface TempDataEntry {
	tipo?: string;
	section_tipo?: string;
	entries?: unknown;
	value?: unknown;
}

/** Raw stored items of one component on one record (empty when none). */
async function readStoredItems(
	sectionTipo: string,
	sectionId: number,
	componentTipo: string,
): Promise<unknown[]> {
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === null) return [];
	const record = await readMatrixRecord(table, sectionTipo, sectionId);
	if (record === null) return [];
	const model = await getModelByTipo(componentTipo);
	if (model === null) return [];
	return readComponentItems(record, componentTipo, model) ?? [];
}

/** Read the first stored value of a (filename) component on a record. */
async function readFilenameValue(
	sectionTipo: string,
	sectionId: number,
	componentTipo: string,
): Promise<string> {
	const items = await readStoredItems(sectionTipo, sectionId, componentTipo);
	const first = items[0];
	if (first === null || first === undefined) return '';
	return typeof first === 'object'
		? String((first as { value?: unknown }).value ?? '')
		: String(first);
}

/**
 * Relation-driven match (PHP get_media_section_match_from_souce :1391): walk
 * the SOURCE record's relation locators to the target section and compare the
 * stored filename basenames against the uploaded name.
 */
async function matchFromSource(
	sectionTipo: string,
	sectionId: number,
	targetSectionTipo: string,
	fullName: string,
	filenameTipo: string,
): Promise<(number | string)[]> {
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === null) {
		throw new DedaloError('request.invalid_tipo', {
			message: 'no matrix table for source section',
			coordinates: { section_tipo: sectionTipo },
		});
	}
	const record = await readMatrixRecord(table, sectionTipo, sectionId);
	const relationColumn = (record?.columns.relation ?? {}) as Record<string, Locator[]>;

	const matches: (number | string)[] = [];
	for (const locators of Object.values(relationColumn)) {
		for (const locator of locators) {
			if (locator.section_tipo !== targetSectionTipo || locator.section_id == null) continue;
			const value = await readFilenameValue(
				targetSectionTipo,
				Number(locator.section_id),
				filenameTipo,
			);
			if (basenamesMatch(value, fullName)) matches.push(locator.section_id);
		}
	}
	return matches;
}

/**
 * Basenames the string builder's begins-with branch treats literally: leading
 * alphanumeric (no '!'/'='/'-'/'*'/quote operator prefixes), then characters
 * that are regex-inert or only BROADEN the anchored match ('.' = any-char).
 * Anything else falls back to the not-empty prefilter — still sound, because
 * basenamesMatch() below is the authoritative comparison either way.
 */
const SQL_SAFE_BASENAME = /^[A-Za-z0-9][A-Za-z0-9 ._,-]*$/;

/**
 * Free-name match (PHP get_media_section_match :1490): an SQO with a `$and`
 * filter on the target_filename component path, run through the search
 * subsystem (sanitizeClientSqo → buildSearchSql — identifier gating + the
 * per-model string builder), then confirmed with the exact extension-stripped
 * basename comparison. One indexed query instead of the previous
 * read-every-record scan; the RESULT SET is identical to that scan:
 *
 * - the SQL stage is a SOUND overapproximation of basename equality — plain
 *   basenames ride a begins-with anchor (`'<basename>*'`: any stored value
 *   whose extension-stripped basename equals the uploaded one starts with
 *   it), basenames with search-operator/regex characters use the not-empty
 *   filter (`'*'`);
 * - basenamesMatch() applies the exact semantics to the candidates in memory
 *   (first stored item, any lang — readFilenameValue's contract).
 *
 * Deliberately NOT PHP's q shape: PHP searches contains-'<basename>.' where
 * the '.' rides into the regex as any-char, so PHP both over-matches
 * ('my_image' hits 'my_image2.jpg') and misses extension-less stored values.
 * The TS matcher keeps the exact comparison this module has always shipped.
 */
async function matchFreeName(
	fullName: string,
	filenameTipo: string,
	targetSectionTipo: string,
): Promise<number[]> {
	const basename = fileBasename(fullName);
	const q = SQL_SAFE_BASENAME.test(basename) ? `${basename}*` : '*';
	// The inputs are client-supplied (tool options / ontology config), so the
	// SQO takes the full untrusted-gate path (PHP sanitize_client_sqo parity).
	const sqo = sanitizeClientSqo({
		section_tipo: [targetSectionTipo],
		filter: {
			$and: [{ q, path: [{ section_tipo: targetSectionTipo, component_tipo: filenameTipo }] }],
		},
		limit: 1,
	});
	// Server-side override AFTER the gate: the matcher must see every candidate
	// (PHP sqo->set_limit(0) = no limit; the clamp is for untrusted listings).
	sqo.limit = 'all';
	// No principal → the projects filter is skipped, matching PHP's explicit
	// skip_projects_filter(true) (imports match records across projects).
	const query = await buildSearchSql(sqo);
	const rows = (await runSearch(query)) as ({
		section_id: number;
	} & Record<string, unknown>)[];

	// Confirm candidates with the EXACT comparison on the first stored item —
	// the rows already carry the component's data column, so no per-record read.
	const model = await getModelByTipo(filenameTipo);
	const column = model !== null ? getColumnNameByModel(model) : null;
	if (column === null) return [];
	const matches: number[] = [];
	for (const row of rows) {
		const payload = row[column] as Record<string, unknown> | null | undefined;
		const rawItems = payload?.[filenameTipo];
		// readComponentItems' coercion + null/'' hole filter (same read contract).
		const items = (Array.isArray(rawItems) ? rawItems : rawItems == null ? [] : [rawItems]).filter(
			(item) => item !== null && item !== '',
		);
		const first = items[0];
		if (first === null || first === undefined) continue;
		const value =
			typeof first === 'object'
				? String((first as { value?: unknown }).value ?? '')
				: String(first);
		if (basenamesMatch(value, fullName)) matches.push(Number(row.section_id));
	}
	return matches;
}

/**
 * The permission targets of the two MATCHER actions (the 'targets' gate, at
 * level 1 — both are reads).
 *
 * Both read records — the SOURCE record and, more importantly, the TARGET
 * section's stored filename values (`target_filename.tipo`, the component the
 * match scans) — and neither posts a top-level `section_tipo` in the shape its
 * handler understands. A plain 'section' spec therefore (a) missed the target
 * section entirely on `..._from_souce`, so the section whose data is actually
 * read was ungated, and (b) denied `get_media_section_match` outright
 * ("invalid section target"), because that handler only ever receives
 * `target_filename.section_tipo`. The targets name the PAIR the handler reads
 * (target section × filename component) and the source record's scope.
 *
 * NOTE the action name `get_media_section_match_from_souce` keeps PHP's typo:
 * it is the literal API_ACTIONS entry of the oracle
 * (class.tool_import_files.php :74) and therefore a WIRE fact, not a slip.
 */
export function matchFromSourceTargets(options: Record<string, unknown>): WriteTarget[] {
	const targetFilename = (options.target_filename ?? {}) as { tipo?: unknown };
	const sourceId = Number(options.section_id ?? 0);
	return [
		{
			section_tipo: options.section_tipo,
			...(Number.isInteger(sourceId) && sourceId > 0 ? { section_id: sourceId } : {}),
		},
		...(options.target_section_tipo === undefined
			? []
			: [{ section_tipo: options.target_section_tipo, tipo: targetFilename.tipo }]),
	];
}

export function matchFreeNameTargets(options: Record<string, unknown>): WriteTarget[] {
	const targetFilename = (options.target_filename ?? {}) as {
		section_tipo?: unknown;
		tipo?: unknown;
	};
	return targetFilename.section_tipo === undefined
		? []
		: [{ section_tipo: targetFilename.section_tipo, tipo: targetFilename.tipo }];
}

/** get_media_section_match_from_souce: relation-driven match (PHP parity). */
async function getMediaSectionMatchFromSource(ctx: ToolActionContext): Promise<ToolResponse> {
	const o = ctx.options;
	const sectionTipo = String(o.section_tipo ?? '');
	const sectionId = Number(o.section_id);
	const targetSectionTipo = String(o.target_section_tipo ?? '');
	const fullName = String(o.full_name ?? '');
	const targetFilename = (o.target_filename ?? {}) as { tipo?: string };
	const filenameTipo = String(targetFilename.tipo ?? '');
	if (
		sectionTipo === '' ||
		!Number.isInteger(sectionId) ||
		targetSectionTipo === '' ||
		filenameTipo === ''
	) {
		throw invalidRequest('Missing required parameters');
	}
	const matches = await matchFromSource(
		sectionTipo,
		sectionId,
		targetSectionTipo,
		fullName,
		filenameTipo,
	);
	return ok(matches, { requestId: toolRequestId(ctx) });
}

/** get_media_section_match: free-name match by scanning the target section. */
async function getMediaSectionMatch(ctx: ToolActionContext): Promise<ToolResponse> {
	const o = ctx.options;
	const fullName = String(o.full_name ?? '');
	const targetFilename = (o.target_filename ?? {}) as { tipo?: string; section_tipo?: string };
	const filenameTipo = String(targetFilename.tipo ?? '');
	const targetSectionTipo = String(targetFilename.section_tipo ?? '');
	if (fullName === '' || filenameTipo === '' || targetSectionTipo === '') {
		throw invalidRequest('Missing required parameters');
	}
	const matches = await matchFreeName(fullName, filenameTipo, targetSectionTipo);
	return ok(matches, { requestId: toolRequestId(ctx) });
}

/**
 * Best-effort removal of the files a splitter processor just staged, used when
 * the standalone `file_processor` action refuses an output-producing processor
 * (see `fileProcessor`). The action cannot ingest `outputs` — the import_files
 * per-file loop is the only consumer — so without removal the refusal would
 * leave records-less files behind in the caller's staging dir. Anything we
 * cannot remove is left for the staging sweeper; the refusal is the point.
 */
function removeStagedProcessorOutputs(
	options: Record<string, unknown>,
	outputs: FileProcessorOutput[],
): void {
	const userId = Number(options.user_id);
	const keyDir = String(options.key_dir ?? '');
	if (!Number.isInteger(userId) || keyDir === '') return;
	try {
		const dir = stagingDir(userId, keyDir);
		for (const output of outputs) {
			rmSync(join(dir, sanitizeSegment(output.tmpName)), { force: true });
		}
	} catch {
		// A staging dir/file we could not reach is the sweeper's job, not this
		// refusal's.
	}
}

/** file_processor: run a REGISTERED named processor (SEC-053 allowlist — crop_50 is the first ported entry, registered at module load). */
async function fileProcessor(ctx: ToolActionContext): Promise<ToolResponse> {
	const name = String(ctx.options.file_processor ?? '');
	const processor = getFileProcessor(name);
	if (processor === null) {
		// SEC-053 collapse: only registered names run, so any unregistered
		// request fails closed rather than executing arbitrary code.
		throw new DedaloError('tool.unsupported_target', {
			publicMessage: `file_processor '${name}' is not a registered processor`,
			coordinates: { file_processor: name },
		});
	}
	// The processor answers with its own internal outcome object; a false one is a
	// failed operation, not a body.
	const outcome = await processor(ctx.options);
	if (!outcome.ok) {
		throw new DedaloError('tool.action_failed', {
			coordinates: { tool: 'tool_import_files', file_processor: name },
			message: outcome.message,
		});
	}
	// A processor that SPLITS one upload into several new files (crop_50) reports
	// them as `outputs` — staged files only the import_files per-file loop consumes.
	// This standalone action has no destination-resolution/portal machinery to
	// ingest them, so an `ok:true` here would silently report a split that left
	// nothing behind but two records-less staged files. Refuse, after removing
	// what the processor just produced.
	if (outcome.outputs !== undefined && outcome.outputs.length > 0) {
		removeStagedProcessorOutputs(ctx.options, outcome.outputs);
		throw new DedaloError('tool.unsupported_target', {
			publicMessage:
				`file_processor '${name}' splits one upload into output files; run it through the ` +
				'import_files per-file processor flow, not the file_processor action',
			coordinates: { file_processor: name, output_count: outcome.outputs.length },
		});
	}
	return ok(outcome.ok, { requestId: toolRequestId(ctx) });
}

/**
 * Destination routing (PHP set_components_data :1635): a ddo living in the
 * CALLER's section writes to the calling record; anything else writes to the
 * freshly created/matched target media record.
 *
 * `callerSectionId` is NULLABLE because a request need not carry one (the
 * record-less list-button flows, and match/match_freename, which matches BY
 * FILENAME and needs no open record). A caller-section ddo in that state has no
 * destination at all, and `Number(… ?? 0)` used to invent one: record 0, a
 * structurally valid address nothing downstream rejected, so the role write
 * landed on an unaddressable orphan. Refused here instead — at the ONE place
 * that knows the write needs the caller record.
 */
export function destinationSectionIdFor(
	ddoSectionTipo: string,
	callerSectionTipo: string,
	callerSectionId: number | null,
	targetSectionId: number,
): number {
	if (ddoSectionTipo !== callerSectionTipo) return targetSectionId;
	if (callerSectionId === null) {
		throw invalidRequest(
			`a ddo_map entry in the caller section '${callerSectionTipo}' writes to the CALLING record, but no caller section_id was provided`,
		);
	}
	return callerSectionId;
}

/**
 * target_filename value (PHP :1661): the full original name, or — with
 * only_basename — the parsed descriptive base_name segment ('portrait' from
 * '73-portrait-A.jpg').
 */
export function filenameValueFor(currentFileName: string, onlyBasename: boolean): string {
	if (!onlyBasename) return currentFileName;
	return parseFilename(currentFileName).base_name ?? '';
}

/** '<stem>_<sectionId>.<ext>' (PHP :993-996 multi-section copy naming). */
function suffixName(name: string, sectionId: number): string {
	const dot = name.lastIndexOf('.');
	if (dot <= 0) return `${name}_${sectionId}`;
	return `${name.slice(0, dot)}_${sectionId}.${name.slice(dot + 1)}`;
}

export interface MultiMatchCopyStep {
	targetSectionId: number;
	/** The staged file to ingest — a suffixed copy except for the last target. */
	tmpName: string;
	/** The filename recorded on the target (PHP current_file_name :1036). */
	fileName: string;
	/** True = this ingest consumes the ORIGINAL staged file (no copy made). */
	isLast: boolean;
}

/**
 * Multi-match copy plan (PHP :974-1041): when one staged file matches several
 * target records, every target except the LAST gets a '<stem>_<id>.<ext>' copy
 * (so the original survives for the next iteration); the last target consumes
 * the original staged file.
 */
export function buildMultiMatchCopyPlan(
	matches: number[],
	fileName: string,
	tmpName: string,
): MultiMatchCopyStep[] {
	return matches.map((targetSectionId, index) => {
		const isLast = index === matches.length - 1;
		if (isLast) return { targetSectionId, tmpName, fileName, isLast };
		return {
			targetSectionId,
			tmpName: suffixName(tmpName, targetSectionId),
			fileName: suffixName(fileName, targetSectionId),
			isLast,
		};
	});
}

export interface SetComponentsDataOptions {
	ddoMap: DdoMapEntry[];
	/**
	 * Caller section tipo/id (the record the tool was opened from). `sectionId`
	 * is `null` when the request carries no open record — legal for the modes
	 * that need none; refused by `destinationSectionIdFor` the moment a
	 * caller-section role write actually needs it.
	 */
	sectionTipo: string;
	sectionId: number | null;
	/**
	 * The TARGET record's section — the one section besides the caller's a
	 * role write may land in (the media record: the caller section itself in
	 * section_resource mode, the matcher's target section, or the portal
	 * target). A write-role ddo living anywhere else is REFUSED: its
	 * destination id would be a record of a third section that merely shares
	 * the target's number.
	 */
	targetSectionTipo: string;
	/** The created/matched target media record id. */
	targetSectionId: number;
	/** Decoded filename recorded by the target_filename role. */
	currentFileName: string;
	/**
	 * Absolute path of the ORIGINAL staged source file — the target_date role
	 * reads its capture date from here (PHP file_data['file_path'], always the
	 * tmp-dir original). Null/consumed paths skip the date write (PHP's
	 * empty-tool-output path — in match mode the LAST target's original has
	 * already been moved by the ingest, exactly as in PHP).
	 */
	mediaFilePath: string | null;
	/** The media component model (component_image/av/pdf) driving the date reader. */
	targetComponentModel: string;
	componentsTempData: TempDataEntry[];
	userId: number;
	/**
	 * The actor. Every role write is scope-checked against it (record_scope.ts
	 * assertRecordWriteTarget — the save door's own rule) BEFORE the save: the
	 * destination record is resolved at run time (a filename prefix, a matcher
	 * hit, a freshly created row), so no declarative gate could have named it.
	 */
	principal: Principal;
	/**
	 * The request data language for translatable role writes (PHP DEDALO_DATA_LANG).
	 * Threaded EXPLICITLY (captured by importFiles at its entry) rather than read
	 * from currentDataLang() at each leaf: explicit is the testable form. Under the
	 * background executor the ambient value importFiles reads IS the submitter's —
	 * the job manager pins the submit-time langs around the worker (media/jobs.ts
	 * JobRunScope; engineering/REQUEST_ISOLATION.md rule 3) — but a leaf read
	 * would still backstop to the installation default in any scope-less caller.
	 */
	dataLang: string;
}

/**
 * PHP tool_import_files::set_components_data (:1592) — iterate the ddo_map and
 * persist the import-related role data into the target/caller records. Every
 * write goes through saveComponentData (tx + TM audit).
 */
export async function setComponentsData(options: SetComponentsDataOptions): Promise<void> {
	const {
		ddoMap,
		sectionTipo,
		sectionId,
		targetSectionTipo,
		targetSectionId,
		currentFileName,
		mediaFilePath,
		targetComponentModel,
		componentsTempData,
		userId,
		principal,
		dataLang,
	} = options;

	// Index components_temp_data by [tipo][section_tipo] (PHP :1610).
	const indexedTempData = new Map<string, TempDataEntry>();
	for (const item of componentsTempData) {
		if (item?.tipo && item?.section_tipo) {
			indexedTempData.set(`${item.tipo}\0${item.section_tipo}`, item);
		}
	}

	for (const ddo of ddoMap) {
		const role = ddo.role ?? '';
		// component_option drives import routing; target_component receives the
		// media file itself — neither is a role data write (PHP :1624 + default).
		if (role !== 'target_filename' && role !== 'target_date' && role !== 'input_component') {
			continue;
		}
		const tipo = String(ddo.tipo ?? '');
		const ddoSectionTipo = String(ddo.section_tipo ?? '');
		if (tipo === '' || ddoSectionTipo === '') continue;
		// The destination is EITHER the caller record OR the target record —
		// there is no third: an id resolved in the target section addresses
		// nothing in any other section, so a ddo declared there would write a
		// record of a third section that happens to share the number (audit
		// CARRY-08, the record axis). Refused per file, never silently routed.
		if (ddoSectionTipo !== sectionTipo && ddoSectionTipo !== targetSectionTipo) {
			throw invalidRequest(
				`ddo_map '${ddo.role}' entry '${tipo}' lives in '${ddoSectionTipo}', which is neither the caller section '${sectionTipo}' nor the target section '${targetSectionTipo}'`,
			);
		}

		const translatable = await getTranslatableByTipo(tipo);
		// PHP :1630: translatable → DEDALO_DATA_LANG (threaded by importFiles from
		// request scope — see SetComponentsDataOptions.dataLang), else lg-nolan.
		const lang = translatable ? dataLang : 'lg-nolan';
		const destinationSectionId = destinationSectionIdFor(
			ddoSectionTipo,
			sectionTipo,
			sectionId,
			targetSectionId,
		);
		// THE WRITE DOOR, at the write (closure Step 3 req 10): the declarative
		// 'targets' gate proved the (section, component) PAIR with no record named;
		// the record it lands in is only known here, so the door is asked for the
		// whole triple — grammar, section floor, the dd128-aware pair (the
		// own-record downgrade needs the record), the write scope. Its grant
		// addresses the save.
		const grant = await authorizeRecordAccess(
			principal,
			{ section_tipo: ddoSectionTipo, component_tipo: tipo, section_id: destinationSectionId },
			{ mode: 'write', level: 2, sectionFloor: 1, door: `tool_import_files.import_files.${role}` },
		);

		switch (role) {
			case 'target_filename': {
				// Fill ONLY when the component is currently empty (PHP :1653-1654) —
				// re-importing never overwrites a manually edited value. The check is
				// across ALL langs (readComponentItems raw items): more conservative
				// than PHP's instance-lang get_data, same protective intent.
				const existing = await readStoredItems(ddoSectionTipo, destinationSectionId, tipo);
				if (existing.length > 0) break;
				const value = filenameValueFor(currentFileName, ddo.only_basename === true);
				const save = await saveComponentData({
					componentTipo: grant.componentTipo,
					sectionTipo: grant.sectionTipo,
					sectionId: grant.sectionId,
					lang,
					changedData: [{ action: 'set_data', id: null, value: [{ value, lang }] }],
					userId,
				});
				if (!save.ok) {
					throw saveRefused(`target_filename save failed on '${tipo}': ${save.message}`, tipo);
				}
				break;
			}

			case 'target_date': {
				// PHP (:1674-1688 + get_media_file_date :421): extract the staged
				// file's EXIF/container/PDF capture date and fill the component ONLY
				// when it is currently empty; no readable date SILENTLY SKIPS.
				const existing = await readStoredItems(ddoSectionTipo, destinationSectionId, tipo);
				if (existing.length > 0) break;
				const mediaDate =
					mediaFilePath === null
						? null
						: await getMediaFileDate(mediaFilePath, targetComponentModel);
				if (mediaDate === null) break; // PHP skip-when-empty
				// Persisted shape (PHP :1683-1686 + component_date::save add_time):
				// one data element {start: dd_date} with the server-computed 'time'.
				const save = await saveComponentData({
					componentTipo: grant.componentTipo,
					sectionTipo: grant.sectionTipo,
					sectionId: grant.sectionId,
					lang,
					changedData: [
						{ action: 'set_data', id: null, value: [{ start: withDedaloTime(mediaDate) }] },
					],
					userId,
				});
				if (!save.ok) {
					throw saveRefused(`target_date save failed on '${tipo}': ${save.message}`, tipo);
				}
				break;
			}

			case 'input_component': {
				// The client ships the full component payload in components_temp_data;
				// extract the value and save it (PHP :1698-1705). WC-001: the engine's
				// wire key is `entries` — `value` is the PHP-era fallback only.
				const temp = indexedTempData.get(`${tipo}\0${ddoSectionTipo}`);
				const rawValue = temp?.entries ?? temp?.value;
				// PHP !empty guard; null/'' holes are dropped (never persist [null]).
				const rawItems = Array.isArray(rawValue)
					? rawValue.filter((entry) => entry !== null && entry !== '')
					: rawValue === null || rawValue === undefined || rawValue === ''
						? []
						: [rawValue];
				if (rawItems.length === 0) break;
				// PHP set_data auto-assigns the instance lang to lang-less items —
				// stamp the component lang here so the stored dato matches.
				const items = rawItems.map((entry) =>
					entry !== null && typeof entry === 'object' && (entry as { lang?: string }).lang == null
						? { ...(entry as Record<string, unknown>), lang }
						: entry,
				);
				// TRANSLATABLE components are stored as per-language SLICES:
				// applySaveComponentData writes exactly ONE lang per call (its
				// effectiveLang). PHP reached all languages by copying a
				// session-backed temp component; the TS client instead ships every
				// entry it holds, each already carrying its own `lang`. So group by
				// lang and issue one save per group — which reaches the same
				// languages the operator actually filled in, without a temp-session
				// twin. This used to THROW (and a pre-flight check refused the whole
				// batch), making the tool unusable with any translatable field on the
				// import form — the shipped configuration.
				// Non-translatable components ignore lang entirely (they are stored
				// under 'lg-nolan'), so the single group below is the previous path.
				const groups = new Map<string, unknown[]>();
				for (const entry of items) {
					const entryLang =
						translatable && entry !== null && typeof entry === 'object'
							? ((entry as { lang?: string }).lang ?? lang)
							: lang;
					const bucket = groups.get(entryLang);
					if (bucket === undefined) groups.set(entryLang, [entry]);
					else bucket.push(entry);
				}
				for (const [groupLang, groupItems] of groups) {
					const save = await saveComponentData({
						componentTipo: grant.componentTipo,
						sectionTipo: grant.sectionTipo,
						sectionId: grant.sectionId,
						lang: groupLang,
						changedData: [{ action: 'set_data', id: null, value: groupItems }],
						userId,
					});
					if (!save.ok) {
						throw saveRefused(`input_component save failed on '${tipo}': ${save.message}`, tipo);
					}
				}
				break;
			}
		}
	}
}

/**
 * The portal's first target section tipo (PHP get_ar_target_section_tipo()[0],
 * :1214): resolved from the portal's request_config sqo targets.
 */
async function portalTargetSectionTipo(
	portalTipo: string,
	portalSectionTipo: string,
): Promise<string | null> {
	const node = await getNode(portalTipo);
	const config = await buildRequestConfigForElement(node?.properties ?? null, {
		ownerTipo: portalTipo,
		ownerSectionTipo: portalSectionTipo,
		mode: 'list',
		ownerIsSection: false,
	});
	for (const item of config) {
		const tipos = extractSqoSectionTipos(item);
		const first = tipos[0];
		if (first !== undefined && first !== '') return first;
	}
	return null;
}

interface ImportFileData {
	name?: string;
	tmp_name?: string;
	extension?: string;
	key_dir?: string;
	/** Pre-matched target address, echoed back by the CLIENT from a matcher
	 * response. Union kept: this RQO-body door still accepts the legacy numeric
	 * STRING form (coerced at each use) until the contraction release —
	 * WC-2026-08-10-section-id-int-canonical. */
	section_id?: number | string;
	/** The component_option ddo tipo chosen per file in the UI (portal routing). */
	component_option?: string;
	/** Per-file named-processor selection (SEC-053 allowlist — crop_50 is registered at module load). */
	file_processor?: string;
}

/**
 * import_files: media import across all name-modes (PHP import_files :764).
 * The target record per file is resolved by import_file_name_mode — 'enumerate'
 * uses the filename's numeric prefix as the section_id (record created when
 * missing), 'named' groups files by base_name into one record, 'default'
 * creates a fresh record; 'match'/'match_freename' resolve target(s) via the
 * matchers (multi-target copy loop: every target but the last gets a staged
 * COPY; the last consumes the original). With a tool_config.ddo_map:
 * import_mode 'section'/'default' runs the component_option PORTAL chain
 * (create the media record through the portal + link it, PHP :1108-1267),
 * 'section_resource' targets the resolved record itself; after each ingest the
 * ddo_map role writes run (setComponentsData). Without a ddo_map the module
 * keeps its pre-ddo_map contract: options.tipo is the media component on the
 * caller's section.
 */
async function importFiles(ctx: ToolActionContext): Promise<ToolResponse> {
	const o = ctx.options;
	const toolConfig = (o.tool_config ?? {}) as {
		import_mode?: string;
		import_file_name_mode?: string | null;
		ddo_map?: DdoMapEntry[];
		/** file_processor_properties on the wire (PHP naming) — processor descriptors + custom_arguments. */
		file_processor?: unknown[];
	};
	const importMode = String(toolConfig.import_mode ?? 'default');
	const nameMode = String(toolConfig.import_file_name_mode ?? 'default');
	const ddoMap = Array.isArray(toolConfig.ddo_map) ? toolConfig.ddo_map : [];
	const sectionTipo = String(o.section_tipo ?? '');
	const componentTipo = String(o.tipo ?? '');
	// NEVER `?? 0`: 0 is a real, structurally-valid section_id elsewhere in this
	// engine (concepts/section_id.ts), so silently defaulting a MISSING id to 0
	// does not fail loud — it addresses whatever record happens to sit at 0 (or,
	// worse, materializes a fresh one there). But ABSENT is legitimate here too:
	// a caller with no open record at all (the section-LIST "Add images" button
	// — `numisdata256`'s `button_import`) sends no section_id on purpose, because
	// its whole job is to CREATE a fresh record per file, same as `enumerate`/
	// `named`/the plain-default branch below already do. So this stays a
	// distinct three-state value (real id / absent / garbage) rather than a
	// boolean gate — `callerSectionId` is `null` for "no caller record", and
	// each call site below decides for itself whether that is fine (creating a
	// fresh destination) or a real error (writing onto "the calling record",
	// which requires one to exist).
	const rawCallerSectionId = o.section_id;
	const callerSectionIdIsAbsent =
		rawCallerSectionId === null || rawCallerSectionId === undefined || rawCallerSectionId === '';
	if (!callerSectionIdIsAbsent && !Number.isSafeInteger(Number(rawCallerSectionId))) {
		throw invalidRequest(
			`Invalid section_id (caller record address): ${JSON.stringify(rawCallerSectionId)}`,
		);
	}
	const callerSectionId: number | null = callerSectionIdIsAbsent
		? null
		: Number(rawCallerSectionId);
	const componentsTempData = (o.components_temp_data ?? []) as TempDataEntry[];
	const optionsKeyDir = String(o.key_dir ?? '');
	// The Quality selector's choice (render_tool_import_files.js :989). PHP
	// set_quality()'d the component with it before add_file; undefined ⇒ the
	// component's original tier. add_file validates it against the ladder.
	const customTargetQuality =
		typeof o.custom_target_quality === 'string' && o.custom_target_quality !== ''
			? o.custom_target_quality
			: undefined;
	const filesData = (o.files_data ?? []) as ImportFileData[];
	if (sectionTipo === '' || componentTipo === '' || filesData.length === 0) {
		throw invalidRequest('Missing section_tipo, tipo or files_data');
	}

	// Target media component: ddo_map role 'target_component' (PHP :818-827);
	// without a ddo_map, options.tipo is the media component (module contract).
	const targetDdoComponent = ddoMap.find((ddo) => ddo.role === 'target_component') ?? null;
	if (ddoMap.length > 0 && targetDdoComponent === null) {
		throw invalidRequest(
			'Invalid target_component. Role "target_component" is not defined in Ontology tool configuration properties.',
		);
	}
	const targetComponentTipo = String(targetDdoComponent?.tipo ?? componentTipo);
	const targetComponentModel = await getModelByTipo(targetComponentTipo);
	let spec: MediaTypeSpec;
	try {
		spec = requireMediaSpec(targetComponentModel ?? '');
	} catch (error) {
		throw new DedaloError('tool.unsupported_target', {
			cause: error,
			publicMessage: `'${targetComponentTipo}' is not a media component`,
			coordinates: { tipo: targetComponentTipo, model: targetComponentModel ?? '' },
		});
	}

	// (No pre-flight refusal of translatable input_components: the
	// setComponentsData input_component branch now saves them per-lang from the
	// client payload. The old check rejected the ENTIRE batch before touching a
	// single file, which made the tool unusable with the shipped import form.)

	// Capture the request data language NOW, while still in request scope, and
	// thread it into every setComponentsData call (Rule 6) — the translatable
	// role writes must not read the ALS from a leaf on the background path.
	const dataLang = currentDataLang();

	// THE RECORD HALF OF THE GATE, IN-HANDLER (audit CARRY-08, record axis). The
	// declarative 'targets' gate (importFilesTargets) authorizes every
	// (section, component) pair the request names and the records it names
	// EXPLICITLY (files_data[].section_id, the caller record). But this handler
	// binds most of its destination records at RUN TIME — a filename's numeric
	// prefix in enumerate mode, a matcher hit in the match modes, a row created
	// a moment ago — and a request that could not spell a record id was never
	// scope-checked for it. So every record this run writes into passes the
	// save door's own rule (record_scope.ts assertRecordWriteTarget: a positive
	// id, inside the caller's scope; global admins unscoped) at the point it is
	// bound, BEFORE the first write into it. Memoized per run: one probe per
	// distinct record, not one per write.
	//
	// A record BORN IN THIS RUN (a fresh create, the portal's add_new_element)
	// is admitted without the probe, as the framework's own create rule admits a
	// create (security.ts scopeIfRecordTargeted: no prior record, no scope to
	// check — the section write grant is the whole authorization). Its
	// reachability afterwards is the birth defaults' business
	// (record_defaults.ts), not this handler's.
	const writableRecords = new Set<string>();
	const recordKey = (recordSectionTipo: string, recordSectionId: number): string =>
		`${recordSectionTipo}/${recordSectionId}`;
	const bornRecords = new Set<string>();
	const bornInThisRun = (recordSectionTipo: string, recordSectionId: number): void => {
		writableRecords.add(recordKey(recordSectionTipo, recordSectionId));
		bornRecords.add(recordKey(recordSectionTipo, recordSectionId));
	};
	const assertWritableRecord = async (
		recordSectionTipo: string,
		recordSectionId: number,
	): Promise<void> => {
		const key = recordKey(recordSectionTipo, recordSectionId);
		if (writableRecords.has(key)) return;
		await assertRecordWriteTarget(
			recordSectionTipo,
			recordSectionId,
			ctx.principal,
			'tool_import_files.import_files',
		);
		writableRecords.add(key);
	};
	// THE WRITE DOOR PER COMPONENT (closure Step 3 req 10). assertWritableRecord
	// proves the RECORD (scope) at its binding point; the component this run
	// writes INTO that record — the media component, the portal that links the
	// new media record — is asked of the door as a triple: section floor, the
	// dd128-aware pair (the own-record downgrade needs the record), the scope. A
	// record born in this run has no prior state to scope: its pair is asked as
	// a section target (the create rule). Memoized per (record, component).
	const writableComponents = new Set<string>();
	const assertWritableComponent = async (
		recordSectionTipo: string,
		recordSectionId: number,
		componentTipo: string,
	): Promise<void> => {
		const key = `${recordKey(recordSectionTipo, recordSectionId)}/${componentTipo}`;
		if (writableComponents.has(key)) return;
		const door = 'tool_import_files.import_files';
		if (bornRecords.has(recordKey(recordSectionTipo, recordSectionId))) {
			await authorizeSectionTarget(
				ctx.principal,
				{ section_tipo: recordSectionTipo, tipo: componentTipo },
				{ level: 2, door },
			);
		} else {
			await authorizeRecordAccess(
				ctx.principal,
				{
					section_tipo: recordSectionTipo,
					component_tipo: componentTipo,
					section_id: recordSectionId,
				},
				{ mode: 'write', level: 2, sectionFloor: 1, door },
			);
		}
		writableComponents.add(key);
	};

	const namedGroups = new Map<string, number>();
	// `imported` = total RECORDS created (a file_processor can turn one upload
	// into several — crop_50: 1 photo -> 2 portal-CHILD records on ONE host
	// record). `filesProcessed` = how many of `filesData` actually produced
	// something, which is what "N of TOTAL" in the summary must count — using
	// `imported` there read as "Imported 2 of 1", nonsensical for a single split
	// upload. Both are reported; they only diverge when a processor's output
	// count isn't 1:1.
	let imported = 0;
	let filesProcessed = 0;
	const errors: string[] = [];

	/**
	 * Move one staged file into a target record's media component, AND record it
	 * on the record.
	 *
	 * (!) BOTH HALVES ARE REQUIRED. `processUploadedFile` only touches the DISK —
	 * add_file + derivatives + a files_info SCAN which it returns. Writing that
	 * scan onto the record is a separate call, and this importer used to skip it:
	 * the files landed in image/original, image/1.5MB and image/thumb while the
	 * matrix `media` key stayed NULL, so the record did not know its own files.
	 * tool_media_versions reported exactly that — `files_info_db: []` against
	 * three disk entries — and unlike component_av (re-scanned on every emit)
	 * an image has no read-time rescue, so the loss was permanent.
	 * PHP did persist here: process_uploaded_file → regenerate_component →
	 * update_component_data_files_info + save.
	 *
	 * The persist lives INSIDE this closure so both call sites — the multi-match
	 * copy loop and the default single-target path — are covered by construction.
	 */
	const ingest = async (
		targetSectionTipo: string,
		targetSectionId: number,
		keyDir: string,
		tmpName: string,
		extension: string,
		originalFileName: string,
	): Promise<void> => {
		// The media write lands on THIS record's media component: prove the record
		// writable (memoized — usually already done at the binding point) and the
		// component through the write door (req 10).
		await assertWritableRecord(targetSectionTipo, targetSectionId);
		await assertWritableComponent(targetSectionTipo, targetSectionId, targetComponentTipo);
		// The context is RE-RESOLVED per call (stored items read fresh), so importing
		// several files into the SAME record accumulates instead of each one clobbering
		// the last.
		const { identity, pathOpts } = await resolveMediaToolContext({
			component_tipo: targetComponentTipo,
			section_tipo: targetSectionTipo,
			section_id: targetSectionId,
		});
		const result = await processUploadedFile({
			spec,
			identity,
			pathOpts,
			userId: ctx.userId,
			keyDir,
			tmpName,
			extension,
			quality: customTargetQuality,
		});
		const { persistUploadedMedia, nameKeysForQuality } = await import(
			'../../../src/core/media/tools/files_info_persist.ts'
		);
		const { buildMediaIdentifier } = await import('../../../src/core/media/path.ts');
		await persistUploadedMedia({
			sectionTipo: identity.sectionTipo,
			sectionId: identity.sectionId,
			componentTipo: identity.componentTipo,
			lang: identity.lang,
			filesInfo: result.filesInfo,
			// The name the operator recognises. NOTE it is not always human-readable:
			// a dropzone row restored from the server listing carries the SANITIZED
			// staged name, because that is what the listing reports.
			originalFileName: originalFileName || result.originalFileName,
			originalNormalizedName: `${buildMediaIdentifier(identity)}.${result.extension}`,
			// Provenance follows the tier the file landed in (PHP :778) — an import
			// into a non-original tier records no original_*/modified_* names.
			nameKeys: nameKeysForQuality(spec, customTargetQuality),
		});
		// A derivative failure is NOT an import failure: the original landed and
		// is now indexed by the persist above, so the file counts as imported and
		// the missing tiers can be rebuilt (tool_media_versions / repair). Report
		// it per file so the operator knows a tier is missing.
		//
		// Reported through the EXISTING `errors[]` — the ONE channel the panel
		// reads: render_tool_import_files.js:605-609 renders
		// `sse_response.data.errors` and nothing else, so a `warnings` field
		// would be dropped on the floor and the failure would be silent.
		for (const message of result.derivativeErrors) {
			errors.push(
				`${originalFileName || result.originalFileName}: imported, but a derivative could not be built — ${message}`,
			);
		}
		// AFTER the persist commits: an av transcode writes its own files_info
		// back, and must not race the write above (IngestResult.startTranscode).
		result.startTranscode?.();
	};

	/**
	 * Resolve the HOST record id for one staged file — enumerate / named /
	 * default name-mode, PHP :916-1070 — WITHOUT the portal chain or ingest.
	 * Split out so the file_processor branch can resolve a real host BEFORE
	 * calling the processor (crop_50 needs a real record to add its two portal
	 * children onto — see `importIntoPortal`), sharing the exact same
	 * enumerate/named/create-fresh logic the ordinary per-file path uses, rather
	 * than a second, drifting copy of it.
	 *
	 * Returns `null` when the file should be skipped (already pushed its own
	 * error) — either an incompatible mode combination, or `import_mode:
	 * 'default'` with no caller record to attach to (that mode's whole contract
	 * is "the CALLING record's own portal", PHP's `else` branch at :1141 — there
	 * is no fresh-record fallback for it, unlike every other mode here).
	 */
	const resolveHostSectionIdRaw = async (
		resolvedFileName: string,
		sectionIdHint: number | string | null | undefined,
	): Promise<number | null> => {
		if (
			ddoMap.length > 0 &&
			nameMode === 'enumerate' &&
			importMode !== 'section' &&
			importMode !== 'section_resource'
		) {
			// PHP :916-926: enumerate needs a section import mode.
			errors.push(
				`${resolvedFileName}: Incompatible import mode: '${importMode}' with import_file_name_mode: 'enumerate'. Ignored action`,
			);
			return null;
		}

		const parsedForResolve = parseFilename(resolvedFileName);
		if (ddoMap.length > 0 && importMode === 'default') {
			// PHP 'default' import_mode (:1132-1141): files go into the portal
			// on the CALLING record — no record is created per name mode, so a
			// missing caller here is a real error, not "create one instead".
			if (callerSectionId === null) {
				errors.push(
					`${resolvedFileName}: import_mode 'default' targets the calling record's own portal, but no caller section_id was provided`,
				);
				return null;
			}
			return callerSectionId;
		}
		if (sectionIdHint != null) {
			return Number(sectionIdHint); // pre-matched
		}
		if (nameMode === 'enumerate' && parsedForResolve.section_id) {
			// PHP :1060-1070: the numeric prefix is the explicit section_id;
			// create_record() returns the existing id without duplicating.
			// An EXISTING row is somebody's record and gets the scope probe in the
			// wrapper below; a row this call creates is born in this run.
			//
			// BORN = THE CREATE'S OWN ANSWER, never a prior existence read
			// (refuter-surviving, closure Step 3 — the 286fc181f9 race class). A
			// read-then-create leaves a window: a concurrent create takes the free
			// id, this conflict-tolerant insert is a no-op, and the record is
			// SOMEONE ELSE'S — yet an empty read would admit it as born, skipping
			// the scope probe and asking its components only the create rule. So
			// the create runs in its own transaction and the row's xmin decides
			// (bornInCurrentTransaction), asked before anything else writes it.
			const explicitId = Number(parsedForResolve.section_id);
			const born = await withTransaction(async () => {
				await createSectionRecord(sectionTipo, ctx.userId, new Date(), explicitId, {
					conflictTolerant: true,
				});
				// Non-null here: the create above refuses a section with no matrix table.
				const table = await getMatrixTableFromTipo(sectionTipo);
				return table !== null && (await bornInCurrentTransaction(table, sectionTipo, explicitId));
			});
			if (born) bornInThisRun(sectionTipo, explicitId);
			return explicitId;
		}
		if (nameMode === 'named') {
			const key = parsedForResolve.base_name || parsedForResolve.section_id || resolvedFileName;
			const existing = namedGroups.get(key);
			if (existing !== undefined) return existing;
			const created = await createSectionRecord(sectionTipo, ctx.userId);
			namedGroups.set(key, created);
			bornInThisRun(sectionTipo, created);
			return created;
		}
		// Plain default: a brand-new record per file — this is the branch the
		// section-LIST "Add images" button rides (import_mode 'section', no
		// name_mode, no caller record at all: each upload becomes its own record).
		const fresh = await createSectionRecord(sectionTipo, ctx.userId);
		bornInThisRun(sectionTipo, fresh);
		return fresh;
	};

	/**
	 * The host record, PROVEN WRITABLE (audit CARRY-08, the record axis). The
	 * resolution above binds the record at RUN TIME — a filename's numeric
	 * prefix, a named group, the caller's own record — so no declarative gate
	 * could have named it; every consumer of this id writes into it next (the
	 * portal link, the role writes, the media itself), which is why the probe
	 * lives here, once, rather than at each call site. A row born in this run is
	 * admitted without the probe (the create rule is the whole authorization);
	 * `assertWritableRecord` memoizes, so repeats cost nothing.
	 */
	const resolveHostSectionId = async (
		resolvedFileName: string,
		sectionIdHint: number | string | null | undefined,
	): Promise<number | null> => {
		const hostSectionId = await resolveHostSectionIdRaw(resolvedFileName, sectionIdHint);
		if (hostSectionId === null) return null;
		await assertWritableRecord(sectionTipo, hostSectionId);
		return hostSectionId;
	};

	/**
	 * Resolve the destination record for ONE staged file (enumerate / named /
	 * default name-mode + the component_option portal chain), apply the ddo_map
	 * role writes, and ingest — the body every non-matcher file goes through.
	 *
	 * Factored out of the main loop so a `file_processor` that SPLITS one upload
	 * into several files (crop_50: one photo -> obverse + reverse) can run this
	 * once per output, exactly as if each output had been uploaded directly —
	 * without duplicating the portal/record-creation logic a second time.
	 *
	 * `sectionIdHint`/`componentOption` are the ORIGINAL file entry's
	 * `section_id`/`component_option` (pre-matched routing), reused unchanged for
	 * every output of a processor-split file — the routing choice was made once,
	 * by the operator, for the upload as a whole.
	 */
	const importResolvedFile = async (
		resolvedFileName: string,
		resolvedTmpName: string,
		resolvedExtension: string,
		resolvedKeyDir: string,
		sectionIdHint: number | string | null | undefined,
		componentOption: string | undefined,
	): Promise<'imported' | 'skipped'> => {
		const resolvedSectionId = await resolveHostSectionId(resolvedFileName, sectionIdHint);
		if (resolvedSectionId === null) return 'skipped';

		// ── media destination: portal chain vs the record itself ─────────
		let targetSectionTipo = sectionTipo;
		let targetSectionId = resolvedSectionId;
		if (ddoMap.length > 0 && importMode !== 'section_resource') {
			// PORTAL-LINKING chain (PHP :1108-1251): the component_option ddo
			// is the portal that receives the new media record's locator.
			let portalDdo: DdoMapEntry;
			if (importMode === 'section') {
				const optionTipo = String(componentOption ?? '');
				const found = ddoMap.find(
					(ddo) => ddo.role === 'component_option' && ddo.tipo === optionTipo,
				);
				if (found === undefined) {
					// PHP :1113-1122 skips the file. (TS checks BEFORE creating the
					// destination record, so a config error leaves no orphan row —
					// deliberate ordering improvement over PHP.)
					errors.push(
						`${resolvedFileName}: empty target_ddo for role "component_option" and tipo "${optionTipo}"`,
					);
					return 'skipped';
				}
				// 'self' placeholder substitution (PHP :1128-1130).
				portalDdo = found.section_tipo === 'self' ? { ...found, section_tipo: sectionTipo } : found;
			} else {
				// PHP 'default' import_mode: the CALLING component is the portal.
				portalDdo = { tipo: componentTipo, section_tipo: sectionTipo };
			}
			const portalTipo = String(portalDdo.tipo ?? '');
			const portalSectionTipo = String(portalDdo.section_tipo ?? '');
			// The portal receives the locator ON THE RESOLVED RECORD, whose id is
			// an address in the caller's section only — a component_option ddo
			// declared in another section would write a record of THAT section
			// at the same number. Refused per file (a configuration error).
			if (portalSectionTipo !== sectionTipo) {
				errors.push(
					`${resolvedFileName}: component_option '${portalTipo}' lives in '${portalSectionTipo}', not in the caller section '${sectionTipo}'`,
				);
				return 'skipped';
			}
			const portalTarget =
				portalDdo.target_section_tipo ??
				(await portalTargetSectionTipo(portalTipo, portalSectionTipo));
			if (portalTarget == null || portalTarget === '') {
				throw new DedaloError('tool.unsupported_target', {
					coordinates: { tool: 'tool_import_files', tipo: portalTipo },
					message: `cannot resolve the portal target section for '${portalTipo}' (no target_section_tipo and no resolvable request_config)`,
				});
			}
			// The ontology-resolved target is the one section the declarative
			// gate could not see (importFilesTargets) — authorize it HERE, before
			// the record is created in it. Runs on the declared form too: cheap
			// (cached), and it keeps the handler honest if the extractor drifts.
			await assertPortalTargetWritable(ctx.principal, portalTarget, targetComponentTipo);
			// The portal on the HOST record is written (the new locator): asked of the
			// write door for that triple (req 10).
			await assertWritableComponent(portalSectionTipo, resolvedSectionId, portalTipo);
			// Create + link the media record through the portal — the
			// add_new_element relation hook (relations/save.ts) inside the
			// tx-wrapped, TM-audited saveComponentData (PHP :1217-1232).
			const save = await saveComponentData({
				componentTipo: portalTipo,
				sectionTipo: portalSectionTipo,
				sectionId: resolvedSectionId,
				lang: 'lg-nolan',
				changedData: [{ action: 'add_new_element', id: null, value: portalTarget }],
				userId: ctx.userId,
			});
			const created = (save as { ok: boolean; created_section_id?: number }).created_section_id;
			if (!save.ok || created == null) {
				// PHP :1220-1227 aborts the whole batch on portal-create failure.
				throw new DedaloError('record.save_failed', {
					coordinates: { tool: 'tool_import_files', section_tipo: targetSectionTipo },
					message: `Error on create portal children: ${save.message}`,
				});
			}
			targetSectionTipo = portalTarget;
			targetSectionId = created;
			bornInThisRun(targetSectionTipo, targetSectionId);
		}

		// Role writes BEFORE the media move (PHP order :1254-1285) — the
		// staged file is still in place for the target_date capture read.
		if (ddoMap.length > 0) {
			await setComponentsData({
				ddoMap,
				sectionTipo,
				sectionId: resolvedSectionId,
				targetSectionTipo,
				targetSectionId,
				currentFileName: resolvedFileName,
				mediaFilePath: join(
					stagingDir(ctx.userId, resolvedKeyDir),
					sanitizeSegment(resolvedTmpName),
				),
				targetComponentModel: targetComponentModel ?? '',
				componentsTempData,
				userId: ctx.userId,
				principal: ctx.principal,
				dataLang,
			});
		}
		await ingest(
			targetSectionTipo,
			targetSectionId,
			resolvedKeyDir,
			resolvedTmpName,
			resolvedExtension,
			resolvedFileName,
		);
		return 'imported';
	};

	/**
	 * Add ONE staged file as a new child through a SPECIFIC portal, on a HOST
	 * record — never a fresh top-level record of its own. This is the exact PHP
	 * crop_50 behaviour (:139-171): `component_portal->add_new_element` called
	 * with a real `section_id`, once per `custom_arguments` destination — which
	 * is why "splitting a photo" reads as filling two portals on ONE record: two
	 * new portal-CHILD records, never new top-level rows.
	 *
	 * `hostSectionId` is NOT always the caller's own `section_id` — resolved by
	 * `resolveHostSectionId` before this is called: opening an existing record's
	 * own Other-images field uses that record directly, but the section-LIST
	 * "Add images" button (no caller record at all) creates a FRESH host per
	 * photo first, same as an ordinary import would, then both crop outputs
	 * attach to that new record. Passing `callerSectionId` straight through here
	 * — the earlier version of this function — is what produced an unaddressable
	 * `section_id: 0` record: a portal write with no real host to write onto.
	 *
	 * ROLE-WRITE SOURCING (PHP crop_50 parity): `sourceFileName`/`sourceFilePath`
	 * are the ORIGINAL upload's name and staged path, not the output file's —
	 * PHP fed `$file_name`/`$file_data` into set_components_data for every crop
	 * child (crop_50.php :255-272), so the target_filename role records the name
	 * the OPERATOR uploaded (which is what the matchers match on) and the
	 * target_date role reads the capture date from the original bytes. The crop
	 * output's own name (`resolvedFileName`) is used ONLY for the media file's
	 * recorded human name, exactly like PHP's set_media_file `name`.
	 *
	 * Deliberately NOT `importResolvedFile`: that function's whole job is
	 * choosing/creating a DESTINATION record (enumerate/named/default,
	 * component_option) — a decision this path never makes, because the
	 * processor already named the exact portal. Bending that function to
	 * skip its own logic would be more surprising than a small, direct twin.
	 */
	const importIntoPortal = async (
		resolvedFileName: string,
		resolvedTmpName: string,
		resolvedExtension: string,
		resolvedKeyDir: string,
		portalComponentTipo: string,
		hostSectionId: number,
		sourceFileName: string,
		sourceFilePath: string,
	): Promise<'imported' | 'skipped'> => {
		const portalTarget = await portalTargetSectionTipo(portalComponentTipo, sectionTipo);
		if (portalTarget == null || portalTarget === '') {
			throw new DedaloError('tool.unsupported_target', {
				coordinates: { tool: 'tool_import_files', tipo: portalComponentTipo },
				message: `cannot resolve the portal target section for '${portalComponentTipo}' (no resolvable request_config)`,
			});
		}
		// Same in-handler authorization as the ordinary portal chain: this target
		// section is resolved from the ontology at run time — and here the portal
		// is named by the PROCESSOR (crop_50's custom_arguments), which the
		// declarative extractor sees even less of. Authorize before creating.
		await assertPortalTargetWritable(ctx.principal, portalTarget, targetComponentTipo);
		// The processor's portal on the HOST record — the write door's triple (req 10).
		await assertWritableComponent(sectionTipo, hostSectionId, portalComponentTipo);
		const save = await saveComponentData({
			componentTipo: portalComponentTipo,
			sectionTipo,
			sectionId: hostSectionId,
			lang: 'lg-nolan',
			changedData: [{ action: 'add_new_element', id: null, value: portalTarget }],
			userId: ctx.userId,
		});
		const created = (save as { ok: boolean; created_section_id?: number }).created_section_id;
		if (!save.ok || created == null) {
			throw new DedaloError('record.save_failed', {
				coordinates: { tool: 'tool_import_files', section_tipo: portalComponentTipo },
				message: `Error on create portal children: ${save.message}`,
			});
		}

		bornInThisRun(portalTarget, created);

		if (ddoMap.length > 0) {
			await setComponentsData({
				ddoMap,
				sectionTipo,
				sectionId: hostSectionId,
				targetSectionTipo: portalTarget,
				targetSectionId: created,
				currentFileName: sourceFileName,
				mediaFilePath: sourceFilePath,
				targetComponentModel: targetComponentModel ?? '',
				componentsTempData,
				userId: ctx.userId,
				principal: ctx.principal,
				dataLang,
			});
		}
		await ingest(
			portalTarget,
			created,
			resolvedKeyDir,
			resolvedTmpName,
			resolvedExtension,
			resolvedFileName,
		);
		return 'imported';
	};

	// Live progress + cooperative cancellation. `import_files` runs under the
	// background executor (backgroundRunnable below), which supplies both
	// publishProgress and signal; a direct call has neither, so both are
	// optional here. Frame keys are the ones the client's compound_msg reads
	// verbatim (render_tool_import_files.js:597-620) — msg / counter / total /
	// total_ms / current_time / errors. `current_time` is the PER-FILE ms: the
	// panel averages it over a rolling window to estimate time remaining, so
	// it must be one file's cost, NOT the elapsed total.
	const publish = ctx.publishProgress;
	const totalFiles = filesData.length;
	const runStartedAt = Date.now();
	let counter = 0;

	for (const file of filesData) {
		// Cancellation is checked at the loop boundary: a file is imported whole
		// or not at all, so an abort never leaves a half-ingested record behind.
		if (ctx.signal?.aborted) {
			errors.push(`Import cancelled after ${counter} of ${totalFiles} files`);
			break;
		}
		const fileStartedAt = Date.now();
		counter++;
		// The client's display name arrives URI-encoded (tool_import_files.js
		// applies encodeURI; PHP applied rawurldecode here). Decode defensively:
		// a name containing a bare '%' is not a valid escape sequence and must
		// survive untouched. Declared OUTSIDE the try so the `finally` progress
		// frame and the error message can both name the file.
		const rawName = String(file.name ?? '');
		let fileName: string;
		try {
			fileName = decodeURIComponent(rawName);
		} catch {
			fileName = rawName;
		}
		try {
			const keyDir = String(file.key_dir ?? optionsKeyDir);
			// The STAGED name is not the client name: it is SERVER-ASSIGNED
			// (upload.ts claimStagedName). Anything outside [A-Za-z0-9_.-] became
			// '_', so 'DSC 001.jpg' / 'María.jpg' / 'photo (1).jpg' are on disk
			// under a different name — and two names that sanitize alike are kept
			// apart with a '-1', '-2' … suffix, which no transform can reproduce.
			// service_dropzone echoes the server's tmp_name back into files_data;
			// resolveStagedName takes it when present and falls back to the legacy
			// transform otherwise, REFUSING (throwing, reported as this file's
			// error) rather than guessing when suffixed candidates exist.
			const tmpName = resolveStagedName(
				stagingDir(ctx.userId, keyDir),
				fileName,
				typeof file.tmp_name === 'string' ? file.tmp_name : null,
			);
			const parsed = parseFilename(fileName);
			// Extension resolution. parseFilename implements the PHP IMPORT-NAME
			// grammar, whose extension group is `[a-zA-Z]{3,4}` — ALPHA ONLY. That
			// grammar exists to split section_id / base_name / letter for the
			// matching modes; it is NOT a media-extension parser, and using it as
			// the only source made every digit-bearing extension resolve to '' —
			// so .mp4, .mp3, .jp2, .3gp and .m4v (the dominant AV formats) each
			// died with 'Invalid media extension (empty)'.
			// Order: the server-staged extension (authoritative — the receiver
			// sniffed the magic bytes against it), then the grammar, then a plain
			// last-dot split as the honest fallback.
			const lastDot = fileName.lastIndexOf('.');
			const plainExtension = lastDot > 0 ? fileName.slice(lastDot + 1).toLowerCase() : '';
			const extension = String(file.extension ?? parsed.extension ?? plainExtension ?? '');

			// Per-file named-processor selection (SEC-053: allowlist, only a
			// REGISTERED name runs). A processor that splits one upload into
			// several files (crop_50) reports them as `outputs`. An output that
			// names its own `portalComponentTipo` (crop_50 does, from
			// custom_arguments) is added through THAT portal on the calling
			// record via `importIntoPortal` — no new top-level record. An output
			// with no portal tipo falls back to `importResolvedFile`, the
			// ordinary enumerate/named/default + component_option path, for a
			// future processor that transforms a file without also choosing its
			// destination.
			if (file.file_processor) {
				const processorName = String(file.file_processor);
				const processor = getFileProcessor(processorName);
				if (processor === null) {
					errors.push(
						`${fileName}: file_processor '${processorName}' is not a registered processor`,
					);
					continue;
				}
				// Resolve a REAL host record BEFORE running the processor — the same
				// enumerate/named/create-fresh resolution an ordinary file goes
				// through. crop_50's two outputs need somewhere real to attach their
				// portals; using the raw, possibly-absent `callerSectionId` here is
				// what produced an unaddressable `section_id: 0` record when this
				// tool was launched with no caller record at all (the section-LIST
				// "Add images" button).
				const hostSectionId = await resolveHostSectionId(fileName, file.section_id);
				if (hostSectionId === null) continue; // resolveHostSectionId already logged why
				const outcome = await processor({
					file_name: fileName,
					file_path: join(stagingDir(ctx.userId, keyDir), sanitizeSegment(tmpName)),
					user_id: ctx.userId,
					key_dir: keyDir,
					section_tipo: sectionTipo,
					section_id: hostSectionId,
					tool_config: toolConfig,
					// PHP naming (options->file_processor_properties): the button's OWN
					// tool_config.file_processor array, carrying this processor's
					// custom_arguments — a SEPARATE field from tool_config on the wire,
					// kept that way here too rather than folded into tool_config.
					file_processor_properties: toolConfig.file_processor ?? [],
					custom_target_quality: customTargetQuality ?? null,
					components_temp_data: componentsTempData,
				});
				if (!outcome.ok || outcome.outputs === undefined || outcome.outputs.length === 0) {
					errors.push(
						`${fileName}: ${outcome.message || `file_processor '${processorName}' produced no output`}`,
					);
					continue;
				}
				let producedAny = false;
				for (const output of outcome.outputs) {
					const result =
						output.portalComponentTipo !== undefined
							? await importIntoPortal(
									output.fileName,
									output.tmpName,
									extension,
									keyDir,
									output.portalComponentTipo,
									hostSectionId,
									// Role writes read the ORIGINAL upload (PHP crop_50
									// parity): target_filename records the operator's name,
									// target_date reads the source bytes' capture date.
									fileName,
									join(stagingDir(ctx.userId, keyDir), sanitizeSegment(tmpName)),
								)
							: await importResolvedFile(
									output.fileName,
									output.tmpName,
									extension,
									keyDir,
									hostSectionId,
									file.component_option,
								);
					if (result === 'imported') {
						imported += 1;
						producedAny = true;
					}
				}
				if (producedAny) {
					filesProcessed += 1;
				} else {
					errors.push(
						`${fileName}: file_processor '${processorName}' produced no importable output`,
					);
				}
				continue;
			}

			// ── match / match_freename: matcher-driven multi-target copy loop
			// (PHP :934-1051) ───────────────────────────────────────────────
			if (
				targetDdoComponent !== null &&
				(importMode === 'section' || importMode === 'section_resource') &&
				(nameMode === 'match' || nameMode === 'match_freename')
			) {
				// NO caller-record guard here. Matching resolves its target BY
				// FILENAME, so the mode runs without an open record — and the
				// record-scope probe on every hit below is what must speak first,
				// before any write and before any other complaint (a caller the
				// operator cannot reach is a refusal, not a configuration note).
				// A caller-section role write with no caller record is refused where
				// it is actually attempted: destinationSectionIdFor.
				const targetSectionTipo = String(targetDdoComponent.section_tipo ?? '');
				const targetFilenameDdo = ddoMap.find(
					(ddo) => ddo.role === 'target_filename' && ddo.section_tipo === targetSectionTipo,
				);
				const filenameTipo = String(targetFilenameDdo?.tipo ?? '');
				let matches: number[];
				if (file.section_id != null) {
					// Pre-matched by the client via the matcher actions.
					matches = [Number(file.section_id)];
				} else if (nameMode === 'match') {
					matches = (
						await matchFromSource(
							sectionTipo,
							Number(parsed.section_id),
							targetSectionTipo,
							fileName,
							filenameTipo,
						)
					).map(Number);
				} else {
					matches = await matchFreeName(fileName, filenameTipo, targetSectionTipo);
				}

				// Every matched record is proven writable BEFORE the first copy or
				// ingest: a file is imported whole or not at all, so one out-of-scope
				// match refuses the whole file rather than half its targets.
				// (matchFreeName deliberately searches ACROSS projects, exactly as
				// PHP; this is where the caller's scope is imposed on its hits.)
				for (const matchedId of matches) {
					await assertWritableRecord(targetSectionTipo, matchedId);
				}

				const plan = buildMultiMatchCopyPlan(matches, fileName, tmpName);
				for (const step of plan) {
					if (!step.isLast) {
						// Copy the staged file so the original survives for the next
						// target (PHP :991-1008); the LAST ingest consumes the original.
						const dir = stagingDir(ctx.userId, keyDir);
						copyFileSync(
							join(dir, sanitizeSegment(tmpName)),
							join(dir, sanitizeSegment(step.tmpName)),
						);
					}
					await ingest(
						targetSectionTipo,
						step.targetSectionId,
						keyDir,
						step.tmpName,
						extension,
						fileName,
					);
					await setComponentsData({
						ddoMap,
						sectionTipo,
						sectionId: callerSectionId,
						targetSectionTipo,
						targetSectionId: step.targetSectionId,
						currentFileName: step.fileName,
						// PHP file_data['file_path'] stays the ORIGINAL staged file for
						// every target; on the LAST step the ingest above has already
						// consumed it → the date read skips (PHP-identical ordering).
						mediaFilePath: join(stagingDir(ctx.userId, keyDir), sanitizeSegment(tmpName)),
						targetComponentModel: targetComponentModel ?? '',
						componentsTempData,
						userId: ctx.userId,
						principal: ctx.principal,
						dataLang,
					});
				}
				// A zero-match file ingests nothing (plan is empty): report it as a
				// per-file note instead of silently counting a no-op as imported.
				if (plan.length === 0) {
					errors.push(`${fileName}: no target record matched`);
				} else {
					imported += 1;
					filesProcessed += 1;
				}
				continue;
			}

			// ── enumerate / named / default: resolve the destination record,
			// portal chain, role writes and ingest ──────────────────────────
			const result = await importResolvedFile(
				fileName,
				tmpName,
				extension,
				keyDir,
				file.section_id,
				file.component_option,
			);
			if (result === 'imported') {
				imported += 1;
				filesProcessed += 1;
			}
		} catch (error) {
			errors.push(`${file.name}: ${(error as Error).message}`);
		} finally {
			// Publish AFTER the file settles (in `finally`, so a failed file still
			// advances the counter — otherwise the bar stalls on the first error).
			// `errors` is sent every frame so the panel can list them as they
			// happen instead of only at the terminal frame.
			publish?.({
				msg: `Importing ${fileName}`,
				counter,
				total: totalFiles,
				total_ms: Date.now() - runStartedAt,
				current_time: Date.now() - fileStartedAt,
				file: fileName,
				errors,
			});
		}
	}
	// CONSUME the staging form (WC-079). The "Values" the operator typed have
	// now been written into real records, so the scratch rows must go or the
	// NEXT batch silently inherits this run's metadata.
	//
	// Server-side, on the code path that actually consumed them — not a client
	// hook. That is what makes it survive a closed tab, and what gives
	// tool_import_marc21 / tool_import_zotero the same behaviour without either
	// of them growing an on_done handler they never had.
	//
	// Best effort, and only when something was ACTUALLY imported. `ok:true` is
	// not success here — this handler answers it for a run where every single
	// file failed (each per-file error is collected into `errors` and the loop
	// carries on), so clearing on it would wipe the form after a run that wrote
	// nothing and leave the operator retyping it.
	if (imported > 0) {
		try {
			const { clearTemporalScratch } = await import(
				'../../../src/core/section/record/temporal_store.ts'
			);
			await clearTemporalScratch(ctx.userId, 'tool_import_files');
		} catch (error) {
			console.warn('[tool_import_files] scratch clear failed:', (error as Error).message);
		}
	}
	// The record-count aside only appears when it would say something the "N of
	// TOTAL" phrase doesn't already: a 1:1 run (the overwhelming common case)
	// never shows "(1 record created)" noise, but a crop_50 run reads "Imported
	// 1 of 1 (1 record created)" -> "(2 records created)", not "Imported 2 of 1".
	const recordCountNote =
		imported !== filesProcessed ? ` (${imported} record${imported === 1 ? '' : 's'} created)` : '';
	// Per-file failures are PAYLOAD: the batch never aborts on one file.
	return ok(
		{
			summary: `OK. Imported ${filesProcessed} of ${filesData.length} (${nameMode} mode)${recordCountNote}${errors.length > 0 ? ' with errors' : ''}.`,
			errors,
			imported,
		},
		{ requestId: toolRequestId(ctx) },
	);
}

/** The ddo_map roles whose handling WRITES a component (setComponentsData +
 * the media ingest + the portal chain). `component_option` is the portal that
 * receives the add_new_element; `target_component` receives the file. */
const DDO_WRITE_ROLES: ReadonlySet<string> = new Set([
	'target_filename',
	'target_date',
	'input_component',
	'target_component',
	'component_option',
]);

/**
 * The WRITE TARGETS of an import_files request — what the 'targets' gate
 * authorizes (audit CARRY-08 / TOOLS-04). The handler writes into the sections
 * and components the CLIENT-SUPPLIED `tool_config.ddo_map` names (the role
 * writes of setComponentsData, the media component that receives the file, the
 * portal that receives the new locator and the section that portal creates
 * into), plus the caller pair and — when a file arrives pre-matched — the
 * matched record itself. A gate declared on `(options.section_tipo,
 * options.tipo)` alone authorized the caller's component and left every
 * ddo_map destination ungated. Read off the SAME keys the handler reads;
 * `'self'` is the caller section, exactly as the portal chain substitutes it.
 *
 * What cannot be named here, and is therefore authorized IN-HANDLER at the
 * point it is bound: a `component_option` portal with no `target_section_tipo`
 * resolves its target section from the ontology at run time
 * (portalTargetSectionTipo → assertPortalTargetWritable), and the RECORDS the
 * run writes into are mostly resolved at run time too — a filename's numeric
 * prefix (enumerate), a matcher hit (match / match_freename), a row created a
 * moment ago — so every one of them passes the save door's record-scope rule
 * (assertRecordWriteTarget) before the first write into it (importFiles
 * assertWritableRecord + setComponentsData). This extractor proves the PAIRS
 * and the EXPLICIT records; the handler proves the rest.
 */
export function importFilesTargets(options: Record<string, unknown>): WriteTarget[] {
	const callerSection = options.section_tipo;
	const callerId = Number(options.section_id ?? 0);
	const targets: WriteTarget[] = [
		{
			section_tipo: callerSection,
			tipo: options.tipo,
			...(Number.isInteger(callerId) && callerId > 0 ? { section_id: callerId } : {}),
		},
	];
	const toolConfig = (options.tool_config ?? {}) as {
		import_mode?: unknown;
		import_file_name_mode?: unknown;
		ddo_map?: unknown;
	};
	const ddoMap = (Array.isArray(toolConfig.ddo_map) ? toolConfig.ddo_map : []) as DdoMapEntry[];
	const sectionOf = (ddo: DdoMapEntry): unknown =>
		ddo.section_tipo === 'self' ? callerSection : ddo.section_tipo;
	for (const ddo of ddoMap) {
		if (ddo === null || typeof ddo !== 'object' || !DDO_WRITE_ROLES.has(String(ddo.role ?? ''))) {
			continue;
		}
		targets.push({ section_tipo: sectionOf(ddo), tipo: ddo.tipo });
		if (ddo.role === 'component_option' && ddo.target_section_tipo !== undefined) {
			targets.push({ section_tipo: ddo.target_section_tipo });
		}
	}
	// Pre-matched files (the matcher responses echoed back): in the match modes
	// the record lives in the target_component's section, otherwise it is the
	// caller section's record the handler resolves (importFiles' mode logic).
	const targetDdo = ddoMap.find((ddo) => ddo?.role === 'target_component');
	const importMode = String(toolConfig.import_mode ?? 'default');
	const nameMode = String(toolConfig.import_file_name_mode ?? 'default');
	const matchMode =
		targetDdo !== undefined &&
		(importMode === 'section' || importMode === 'section_resource') &&
		(nameMode === 'match' || nameMode === 'match_freename');
	const filesData = Array.isArray(options.files_data) ? options.files_data : [];
	for (const file of filesData as { section_id?: unknown }[]) {
		if (file?.section_id == null) continue;
		targets.push(
			matchMode
				? { section_tipo: sectionOf(targetDdo), tipo: targetDdo.tipo, section_id: file.section_id }
				: { section_tipo: callerSection, section_id: file.section_id },
		);
	}
	return targets;
}

/**
 * The run-time half of the import_files gate: a `component_option` portal
 * without `target_section_tipo` resolves its target section from the ontology,
 * so the declarative extractor above cannot name it. Before the handler
 * creates a record there (the portal's add_new_element) and ingests the file
 * into `targetComponentTipo` on it, the caller must hold write on that section
 * AND on the pair — the same two checks the 'targets' gate would have run.
 */
export async function assertPortalTargetWritable(
	principal: Principal,
	targetSectionTipo: string,
	targetComponentTipo: string,
): Promise<void> {
	const sectionLevel = await getPermissions(principal, targetSectionTipo, targetSectionTipo);
	const pairLevel = await getPermissions(principal, targetSectionTipo, targetComponentTipo);
	if (sectionLevel < 2 || pairLevel < 2) {
		throw new DedaloError('perm.denied', {
			coordinates: { section_tipo: targetSectionTipo, tipo: targetComponentTipo, required: 2 },
			message: `import_files: no write grant on the portal target ${targetSectionTipo}/${targetComponentTipo}`,
		});
	}
}

export const tool: ToolServerModule = {
	name: 'tool_import_files',
	apiActions: {
		// Both matchers READ record data out of the TARGET section, which rides
		// inside the payload — so the gate is declared over the payload targets.
		get_media_section_match_from_souce: {
			permission: 'targets',
			minLevel: 1,
			targets: matchFromSourceTargets,
			handler: getMediaSectionMatchFromSource,
		},
		get_media_section_match: {
			permission: 'targets',
			minLevel: 1,
			targets: matchFreeNameTargets,
			handler: getMediaSectionMatch,
		},
		file_processor: { permission: 'section', minLevel: 2, handler: fileProcessor },
		// The write targets ride in the client's tool_config.ddo_map — the gate
		// is declared over THEM (importFilesTargets), not over the caller pair.
		import_files: {
			permission: 'targets',
			minLevel: 2,
			targets: importFilesTargets,
			handler: importFiles,
		},
	},
	backgroundRunnable: ['import_files'],
	// A bulk MEDIA import: it builds derivatives, so it spends the media budget
	// (PERF-11 lane declaration).
	backgroundLanes: { import_files: 'media' },
};
