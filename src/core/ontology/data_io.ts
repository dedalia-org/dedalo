/**
 * ONTOLOGY DATA IO (PHP core/ontology/class.ontology_data_io.php — the five
 * EXPORT functions, in PHP order):
 *
 *   1. setOntologyIoPath      — resolve + create the versioned IO dir
 *                               <ONTOLOGY_DATA_IO_DIR>/<major>.<minor>
 *   2. updateOntologyInfo     — persist the installation metadata (version,
 *                               date, entity, host, active_ontologies) into
 *                               component ontology18 of dd0/1 (lg-nolan)
 *   3. exportOntologyInfo     — write that same value to <io>/ontology.json
 *   4. exportToFile /         — psql client-side `\copy … TO PROGRAM 'gzip…'`
 *      exportPrivateListsToFile  dumps of matrix_ontology (per TLD) and
 *                               matrix_dd (private lists) into <io>/*.copy.gz
 *   5. exportLlmMap           — write <io>/ontology_llm_map.json (built by
 *                               src/ai/mcp/tools/llm_map.ts, lazy import)
 *
 * Error semantics mirror PHP: soft failures return {ok:false, errors:[…]}
 * responses; a COPY export whose output file never appears THROWS (PHP throws
 * an Exception there by design — the tool-level caller catches and aborts).
 *
 * COMP-06 hardening (ported): tld validated /^[a-z]{2,}$/ (safeTld), the
 * derived section_tipo re-validated /^[a-zA-Z0-9_]+$/, and the output file
 * path confined under the IO dir BEFORE any interpolation into the psql
 * command — because `TO PROGRAM` runs a shell on the psql client side.
 *
 * The import/remote half of the PHP class (import_from_file,
 * import_private_lists_from_file, download_remote_ontology_file,
 * get_ontology_update_info, check_remote_server + the
 * backup::import_from_copy_file twin) lives in data_io_import.ts
 * (UPDATE_PROCESS Phase 2 — the former ledgered deferral is CLOSED; the
 * pipeline orchestrator is ontology_update.ts, WC-023).
 */

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { config } from '../../config/config.ts';
import { envSnapshot } from '../../config/env.ts';
import { libpqTransportArgs, resolvePgTransport } from '../../config/pg_transport.ts';
import { readString } from '../../config/readers.ts';
import { compareLocators, type Locator } from '../concepts/locator.ts';
import { readMatrixRecord } from '../db/matrix.ts';
import { MATRIX_COPY_COLUMNS } from '../db/matrix_write.ts';
import { sql } from '../db/postgres.ts';
import { saveComponentData } from '../section/record/save_component.ts';
import { DEDALO_VERSION, DEDALO_VERSION_MAJOR_MINOR } from '../update/version.ts';
import {
	normalizeOntologyDependencies,
	type OntologyDependency,
	storedDependenciesValue,
} from './ontology_dependencies.ts';
import {
	DATA_NOLAN,
	HIERARCHY_ACTIVE,
	HIERARCHY_TARGET_SECTION,
	HIERARCHY_TERM,
	HIERARCHY_TLD,
	HIERARCHY_TYPES_NAME,
	HIERARCHY_TYPES_SECTION,
	HIERARCHY_TYPOLOGY,
	ONTOLOGY_MAIN_SECTION,
	ONTOLOGY_PROPERTIES,
	SI_NO_YES,
	YES_NO_SECTION,
} from './ontology_tipos.ts';
import { getColumnNameByModel, getMatrixTableFromTipo, getModelByTipo } from './resolver.ts';

/** The dd0 main-section identity of the ontology metadata record (PHP dd1). */
const INFO_SECTION_TIPO = 'dd0';
const INFO_SECTION_ID = 1;

/**
 * The outcome every IO function returns — an INTERNAL narrative object, not a
 * wire envelope: the tool/widget callers aggregate `msg`/`errors` across many
 * TLDs and build the response themselves. `ok` is the discriminator (never
 * `result`: that name is the legacy wire body's, and this shape is not one).
 */
export interface OntologyIoResponse {
	ok: boolean;
	msg: string;
	errors: string[];
	[key: string]: unknown;
}

// ---------------------------------------------------------------------------
// 1. setOntologyIoPath
// ---------------------------------------------------------------------------

/**
 * Resolve the versioned IO directory (<base>/<major>.<minor>) and create it
 * when absent (PHP set_ontology_io_path). Returns false when the directory
 * cannot be created (PHP create_directory failure), never throws.
 * `baseDir` is a test seam; production callers use the config catalog key.
 */
/** Human-readable byte size (1 decimal for KB/MB). */
function humanSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Describe a written export file for the operator: its path RELATIVE to the configured
 * `ONTOLOGY_DATA_IO_DIR` base (so it reads e.g. `7.0/es.copy.gz` regardless of where the
 * base lives) and its on-disk size. `knownBytes` short-circuits the stat when the caller
 * already has the byte count (Bun.write returns it); the psql/gzip files are stat'd.
 * Returns `{ path, bytes, note }` where `note` is the ` (path, size)` message suffix.
 */
function describeWrittenFile(
	absPath: string,
	knownBytes?: number,
): { path: string; bytes: number; note: string } {
	const bytes =
		knownBytes !== undefined ? knownBytes : existsSync(absPath) ? statSync(absPath).size : 0;
	const path = relative(config.ops.ontologyDataIoDir, absPath) || absPath;
	return { path, bytes, note: ` → ${path} (${humanSize(bytes)})` };
}

export function setOntologyIoPath(baseDir: string = config.ops.ontologyDataIoDir): string | false {
	// Only major.minor feed the IO path (patch releases share one dir, PHP parity).
	const ioPath = join(baseDir, DEDALO_VERSION_MAJOR_MINOR);
	try {
		mkdirSync(ioPath, { recursive: true });
	} catch (error) {
		console.error(`[ontology_data_io] unable to create IO dir '${ioPath}':`, error);
		return false;
	}
	return ioPath;
}

// ---------------------------------------------------------------------------
// Active-ontologies census (shared by get_ontologies + updateOntologyInfo)
// ---------------------------------------------------------------------------

/** One census entry (PHP ontology::row_to_element, the exported subset). */
export interface OntologyCensusEntry {
	target_section_tipo: string;
	tld: string;
	name: string | null;
	/** Raw term-component items (PHP name_data = component get_data()). */
	name_data: unknown;
	typology_id: number | null;
	typology_name: string | null;
	/**
	 * The DECLARED dependencies (hierarchy60 "Dependencies", the row's
	 * `misc.hierarchy60[0].value`), normalized by THE shared normalizer
	 * (ontology_dependencies.ts normalizeOntologyDependencies — the same one the
	 * importer applies): `{tld, main, mandatory}` objects, `(tld, main)`
	 * deduplicated, invalid items dropped into the census `errors`. The key is
	 * PRESENT only when the row declares (a stored `[]` is declared: needs
	 * nothing); absent = NOT DECLARED
	 * (WC-2026-10-10-ontology-dependencies-hierarchy60).
	 */
	dependencies?: OntologyDependency[];
}

/** One matrix_ontology_main row as the census reads it. */
interface RegistryRow {
	section_id: number;
	string: Record<string, unknown[]> | null;
	relation: Record<string, unknown[]> | null;
	misc: Record<string, unknown> | null;
}

/** One `ontology.json` active_ontologies item (the export's wire shape). */
export interface ActiveOntologyInfo {
	tld: string;
	name: string | null;
	name_data: unknown;
	typology_id: number | null;
	typology_name: string | null;
	/** Present only when declared (see OntologyCensusEntry.dependencies). */
	dependencies?: OntologyDependency[];
}

/** app-lang value of a string component's items, with any-non-empty fallback. */
function pickLangValue(
	items: { lang?: string; value?: unknown }[] | undefined,
	lang: string,
): string {
	if (items === undefined) return '';
	const preferred = items.find((item) => item.lang === lang)?.value;
	if (preferred !== undefined && preferred !== null && preferred !== '') return String(preferred);
	for (const item of items) {
		if (item.value !== undefined && item.value !== null && item.value !== '')
			return String(item.value);
	}
	return '';
}

/** Resolve the display name of a typology record (hierarchy16 off hierarchy13/id). */
async function resolveTypologyName(typologyId: number, lang: string): Promise<string | null> {
	const table = await getMatrixTableFromTipo(HIERARCHY_TYPES_SECTION);
	if (table === null) return null;
	const record = await readMatrixRecord(table, HIERARCHY_TYPES_SECTION, typologyId);
	const items = (record?.columns.string as Record<string, unknown[]> | null)?.[
		HIERARCHY_TYPES_NAME
	] as { lang?: string; value?: unknown }[] | undefined;
	const value = pickLangValue(items, lang);
	return value === '' ? null : value;
}

/**
 * The declared dependencies of one registry row (`misc.hierarchy60[0].value`)
 * through THE shared normalizer; undefined when the row declares nothing (or
 * declares a non-list — warned). Every normalizer warning becomes a census
 * error line naming the row: invalid items are dropped, never fatal.
 */
function declaredDependencies(
	row: RegistryRow,
	ownTld: string,
	errors: string[],
): OntologyDependency[] | undefined {
	const warnings: string[] = [];
	const dependencies = normalizeOntologyDependencies(
		ownTld,
		storedDependenciesValue(row.misc),
		warnings,
	);
	for (const warning of warnings) {
		errors.push(`${ONTOLOGY_MAIN_SECTION}/${row.section_id}: ${warning}`);
	}
	return dependencies ?? undefined;
}

/** `entry` with `dependencies` attached only when declared (absent ≠ empty). */
function withDependencies<T extends object>(
	entry: T,
	dependencies: OntologyDependency[] | undefined,
): T & { dependencies?: OntologyDependency[] } {
	return dependencies === undefined ? entry : { ...entry, dependencies };
}

/**
 * Walk every matrix_ontology_main (ontology35) record and resolve the UI/
 * metadata fields. THE shared census: tool_ontology_parser get_ontologies
 * consumes it whole (PHP ontology::get_all_main_ontology_records walk), and
 * updateOntologyInfo consumes the `activeOnly` subset (PHP
 * ontology::get_active_elements — hierarchy4 locator → dd64/1 'yes').
 * Records missing target/tld are skipped NON-fatally into `errors`.
 * Each entry also carries its DECLARED dependencies when the row declares them
 * (`dependencies` — hierarchy60 in `misc`, see declaredDependencies).
 */
export async function getActiveOntologies(
	options: { activeOnly?: boolean } = {},
): Promise<{ ontologies: OntologyCensusEntry[]; errors: string[] }> {
	const activeOnly = options.activeOnly === true;
	const appLang = config.menu.applicationLang;
	const errors: string[] = [];

	const rows = (await sql.unsafe(
		`SELECT section_id, string, relation, misc FROM "matrix_ontology_main" WHERE section_tipo = $1 ORDER BY section_id ASC`,
		[ONTOLOGY_MAIN_SECTION],
	)) as RegistryRow[];

	const ontologies: OntologyCensusEntry[] = [];
	for (const row of rows) {
		const stringCol = row.string ?? {};
		const relationCol = row.relation ?? {};

		if (activeOnly) {
			// PHP get_active_elements filter: hierarchy4 first locator must point
			// at dd64/1 ('yes'). Locator equality goes through the ONE law
			// (compareLocators — PHP-loose section_id), never an inline compare.
			const activeLocator = (
				relationCol[HIERARCHY_ACTIVE] as
					| { section_tipo?: unknown; section_id?: unknown }[]
					| undefined
			)?.[0];
			const isActive =
				activeLocator !== undefined &&
				compareLocators(
					activeLocator as Locator,
					{ section_tipo: YES_NO_SECTION, section_id: SI_NO_YES } as Locator,
					['section_tipo', 'section_id'],
				);
			if (!isActive) continue;
		}

		const targetSectionTipo = pickLangValue(stringCol[HIERARCHY_TARGET_SECTION] as never, appLang);
		if (targetSectionTipo === '') {
			errors.push(
				`Skipped hierarchy without target section tipo: ${ONTOLOGY_MAIN_SECTION}, ${row.section_id}`,
			);
			continue;
		}
		const tld = pickLangValue(stringCol[HIERARCHY_TLD] as never, appLang);
		if (tld === '') {
			errors.push(`Skipped hierarchy without tld: ${ONTOLOGY_MAIN_SECTION}, ${row.section_id} `);
			continue;
		}
		const nameItems = stringCol[HIERARCHY_TERM] as { lang?: string; value?: unknown }[] | undefined;
		const nameValue = pickLangValue(nameItems, appLang);
		const typologyLocator = (
			relationCol[HIERARCHY_TYPOLOGY] as { section_id?: unknown }[] | undefined
		)?.[0];
		const typologyId =
			typologyLocator?.section_id !== undefined && typologyLocator.section_id !== null
				? Math.trunc(Number(typologyLocator.section_id))
				: null;
		const typologyName =
			typologyId !== null ? await resolveTypologyName(typologyId, appLang) : null;

		const dependencies = declaredDependencies(row, tld.toLowerCase(), errors);

		ontologies.push(
			withDependencies(
				{
					target_section_tipo: targetSectionTipo,
					tld,
					name: nameValue === '' ? null : nameValue,
					name_data: nameItems ?? null,
					typology_id: typologyId,
					typology_name: typologyName,
				},
				dependencies,
			),
		);
	}

	return { ontologies, errors };
}

/**
 * The census → `ontology.json` active_ontologies mapping (PURE): the TLD
 * lowercased, the five metadata fields, and `dependencies` copied ONLY when the
 * entry declares them (absent = not declared — the manifest wire contract,
 * WC-2026-10-10-ontology-dependencies-hierarchy60).
 */
export function activeOntologiesInfo(
	entries: readonly OntologyCensusEntry[],
): ActiveOntologyInfo[] {
	return entries.map((el) =>
		withDependencies(
			{
				tld: el.tld.toLowerCase(),
				name: el.name,
				name_data: el.name_data,
				typology_id: el.typology_id,
				typology_name: el.typology_name,
			},
			el.dependencies,
		),
	);
}

// ---------------------------------------------------------------------------
// 2. updateOntologyInfo
// ---------------------------------------------------------------------------

/** PHP dd_date::get_now_as_iso_timestamp (DateTime format 'c') in DEDALO_TIMEZONE. */
const isoFormatter = new Intl.DateTimeFormat('en-CA', {
	timeZone: config.timezone,
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
	hour: '2-digit',
	minute: '2-digit',
	second: '2-digit',
	hourCycle: 'h23',
	timeZoneName: 'longOffset',
});

function isoTimestampNow(now: Date = new Date()): string {
	const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
	for (const part of isoFormatter.formatToParts(now)) {
		parts[part.type] = part.value;
	}
	// 'GMT+02:00' → '+02:00'; bare 'GMT' (UTC) → '+00:00'.
	const rawOffset = parts.timeZoneName ?? 'GMT';
	const offset = rawOffset === 'GMT' ? '+00:00' : rawOffset.replace('GMT', '');
	return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

/**
 * Rebuild and persist the ontology metadata record — component ontology18 of
 * dd0/1, lang lg-nolan (PHP update_ontology_info). Every existing data item is
 * overwritten with the same fresh value (normally exactly one); the write goes
 * through saveComponentData (tx-wrapped, TM-audited — the save event fires the
 * cache hub, no extra invalidation wiring here).
 *
 * PHP always returns true (save errors are not surfaced); the TS port is
 * deliberately stricter — it returns the save's ok flag, so a failed metadata
 * write ABORTS the export instead of silently shipping a stale ontology.json.
 */
export async function updateOntologyInfo(userId: number): Promise<boolean> {
	const model = await getModelByTipo(ONTOLOGY_PROPERTIES);
	if (model === null) {
		console.error(`[ontology_data_io] unknown model for tipo '${ONTOLOGY_PROPERTIES}'`);
		return false;
	}
	const column = getColumnNameByModel(model);
	const table = await getMatrixTableFromTipo(INFO_SECTION_TIPO);
	if (column === null || table === null) {
		console.error('[ontology_data_io] unable to resolve column/table for ontology18@dd0');
		return false;
	}

	// existing data items (PHP get_data() ?? [new stdClass()])
	const record = await readMatrixRecord(table, INFO_SECTION_TIPO, INFO_SECTION_ID);
	const columnValue = record?.columns[column as keyof typeof record.columns] as Record<
		string,
		unknown
	> | null;
	const rawItems = columnValue?.[ONTOLOGY_PROPERTIES];
	const items: unknown[] = Array.isArray(rawItems) && rawItems.length > 0 ? rawItems : [{}];

	// active ontologies census (PHP ontology::get_active_elements subset)
	const census = await getActiveOntologies({ activeOnly: true });
	const activeOntologies = activeOntologiesInfo(census.ontologies);

	const value = {
		version: DEDALO_VERSION,
		date: isoTimestampNow(),
		entity_id: config.identity.entityId,
		entity: config.entity,
		entity_label: config.identity.entityLabel,
		// PHP DEDALO_HOST (public hostname). Call-time shadow key, PHP key name
		// (same posture as the sessions/diffusion readers — no config.* field yet).
		host: readString('DEDALO_HOST'),
		active_ontologies: activeOntologies,
	};

	const newItems = items.map((item) =>
		item !== null && typeof item === 'object'
			? { ...(item as Record<string, unknown>), value }
			: { value },
	);

	const saveResult = await saveComponentData({
		componentTipo: ONTOLOGY_PROPERTIES,
		sectionTipo: INFO_SECTION_TIPO,
		sectionId: INFO_SECTION_ID,
		lang: DATA_NOLAN,
		changedData: [{ action: 'set_data', value: newItems }],
		userId,
	});
	if (!saveResult.ok) {
		console.error(`[ontology_data_io] updateOntologyInfo save failed: ${saveResult.message}`);
	}
	return saveResult.ok;
}

// ---------------------------------------------------------------------------
// 3. exportOntologyInfo
// ---------------------------------------------------------------------------

/**
 * Read the ontology metadata component (ontology18, dd0/1) and write its value
 * as pretty JSON to <io>/ontology.json (PHP export_ontology_info; PHP's
 * JSON_PRETTY_PRINT|UNESCAPED_UNICODE|UNESCAPED_SLASHES ≈ JSON.stringify with
 * 4-space indent — JS never escapes unicode or slashes).
 */
export async function exportOntologyInfo(): Promise<OntologyIoResponse> {
	const response: OntologyIoResponse = {
		ok: false,
		msg: 'Error. Request failed',
		errors: [],
	};

	const model = await getModelByTipo(ONTOLOGY_PROPERTIES);
	const column = model !== null ? getColumnNameByModel(model) : null;
	const table = await getMatrixTableFromTipo(INFO_SECTION_TIPO);
	if (column === null || table === null) {
		response.msg = 'Error. Unable to resolve the ontology info component';
		response.errors.push('unable to resolve column/table for ontology18@dd0');
		return response;
	}
	const record = await readMatrixRecord(table, INFO_SECTION_TIPO, INFO_SECTION_ID);
	const columnValue = record?.columns[column as keyof typeof record.columns] as Record<
		string,
		unknown
	> | null;
	const rawItems = columnValue?.[ONTOLOGY_PROPERTIES];
	const data = Array.isArray(rawItems)
		? ((rawItems[0] as { value?: unknown } | undefined)?.value ?? null)
		: null;
	const dataString = JSON.stringify(data, null, 4);

	const ioPath = setOntologyIoPath();
	if (ioPath === false) {
		response.msg = `Error. Invalid directory: ${ioPath}`;
		response.errors.push(`Unable to create directory: ${ioPath}`);
		return response;
	}
	const pathFile = join(ioPath, 'ontology.json');

	let saved: number;
	try {
		saved = await Bun.write(pathFile, dataString);
	} catch (error) {
		response.msg = 'Error. Impossible to save data in ontology.json file';
		response.errors.push(
			`Impossible to save data in ontology.json file: ${(error as Error).message}`,
		);
		return response;
	}

	const written = describeWrittenFile(pathFile, saved);
	response.ok = true;
	response.msg = `OK. Ontology info${written.note}`;
	response.path = written.path;
	response.size = written.bytes;
	// debug (PHP parity fields)
	response.data = data;
	response.path_file = pathFile;
	response.saved = saved;
	return response;
}

// ---------------------------------------------------------------------------
// 4. exportToFile / exportPrivateListsToFile
// ---------------------------------------------------------------------------

/** PHP safe_tld(): 2+ lowercase ascii letters, nothing else (COMP-06). */
export function safeTld(tld: string): boolean {
	return /^[a-z]{2,}$/.test(tld);
}

/** COMP-06 defence-in-depth: bare-identifier section_tipo before interpolation. */
export function isSafeSectionTipo(sectionTipo: string): boolean {
	return /^[a-zA-Z0-9_]+$/.test(sectionTipo);
}

/**
 * The psql binary matching the server (mirrors area_maintenance/backup.ts
 * resolvePgDump: explicit DEDALO_PG_BIN_PATH first, then version-suffixed
 * Homebrew installs newest-first, then PATH).
 */
export function resolvePsql(): string {
	const declared = config.ops.pgBinPath;
	if (typeof declared === 'string' && declared !== '') {
		const candidate = join(declared, 'psql');
		if (existsSync(candidate)) return candidate;
	}
	for (const version of [18, 17, 16, 15]) {
		const candidate = `/opt/homebrew/opt/postgresql@${version}/bin/psql`;
		if (existsSync(candidate)) return candidate;
	}
	return 'psql';
}

/** host/port/user flags (PHP DBi::get_connection_string; password via PGPASSWORD). */
function psqlConnectionArgs(): string[] {
	// The shared transport rule (DB_SOCKET wins) — the route the pool takes.
	const args = libpqTransportArgs(resolvePgTransport(config.db));
	if (config.db.user) args.push('-U', String(config.db.user));
	return args;
}

/**
 * Run one client-side `\copy … TO PROGRAM 'gzip -c > <file> && sync'` through
 * psql (Bun.spawn — no shell of OUR making; psql itself shells out for
 * TO PROGRAM, which is why every interpolated identifier/path is validated
 * first). PGPASSWORD is threaded from config.db.password exactly like the
 * backup.ts pg_dump spawn (password-auth Postgres, S2-35 posture); the child
 * env comes from envSnapshot() (the sanctioned reader — no raw process.env).
 */
async function runCopyExport(
	copySelect: string,
	filePath: string,
): Promise<{ exitCode: number; stderr: string }> {
	const copyCommand = `\\copy (${copySelect}) TO PROGRAM 'gzip -c > ${filePath} && sync';`;
	const child = Bun.spawn(
		[resolvePsql(), config.db.database, ...psqlConnectionArgs(), '-c', copyCommand],
		{
			stdout: 'ignore',
			stderr: 'pipe',
			env: {
				...(envSnapshot() as Record<string, string>),
				...(config.db.password !== '' ? { PGPASSWORD: config.db.password } : {}),
			},
		},
	);
	const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
	return { exitCode, stderr: stderr.trim() };
}

/**
 * Confine + shell-safety gate on the output path BEFORE it is interpolated
 * into the single-quoted TO PROGRAM string (COMP-06): the resolved path must
 * live under the IO dir, and may not carry quote/whitespace/backslash bytes
 * (any of which would break out of the quoted gzip redirect).
 */
function confinedCopyPath(ioPath: string, fileName: string): string | null {
	const resolved = resolve(join(ioPath, fileName));
	if (!resolved.startsWith(resolve(ioPath) + sep)) return null;
	if (/['"\\\s]/.test(resolved)) return null;
	return resolved;
}

/**
 * Dump all matrix_ontology rows of one TLD into <io>/<tld>.copy.gz
 * (PHP export_to_file). Soft-fails on validation/dir errors; THROWS when the
 * output file was not created after the command ran (PHP throws there — the
 * tool caller's try/catch turns it into a full abort).
 */
export async function exportToFile(tld: string): Promise<OntologyIoResponse> {
	const response: OntologyIoResponse = {
		ok: false,
		msg: 'Error. Request failed',
		errors: [],
	};

	// COMP-06: reject anything that is not 2+ lowercase letters.
	if (!safeTld(tld)) {
		response.msg = `Error. Invalid tld: ${tld}`;
		response.errors.push(`Invalid tld: ${tld}`);
		return response;
	}

	const ioPath = setOntologyIoPath();
	if (ioPath === false) {
		response.msg = `Error. Invalid directory: ${ioPath}`;
		response.errors.push(`Unable to create directory: ${ioPath}`);
		return response;
	}
	const filePath = confinedCopyPath(ioPath, `${tld}.copy.gz`);
	if (filePath === null) {
		response.msg = 'Error. Unsafe export file path';
		response.errors.push('Export file path escapes the IO dir or carries shell metacharacters');
		return response;
	}

	// PHP ontology::map_tld_to_target_section_tipo: 'dd' → 'dd0'.
	const sectionTipo = `${tld}0`;
	// COMP-06 defence-in-depth before interpolating into the psql -c string.
	if (!isSafeSectionTipo(sectionTipo)) {
		response.msg = 'Error. Invalid section_tipo for ontology export';
		response.errors.push(`Invalid section_tipo: ${sectionTipo}`);
		return response;
	}

	const copySelect = `SELECT ${MATRIX_COPY_COLUMNS.join(', ')} FROM "matrix_ontology" WHERE section_tipo = '${sectionTipo}'`;
	const { exitCode, stderr } = await runCopyExport(copySelect, filePath);

	// (!) PHP parity: a missing output file THROWS (callers wrap in try/catch).
	if (!existsSync(filePath)) {
		throw new Error(
			`Error Processing Request. File ${filePath} not created!${stderr !== '' ? ` (psql exited ${exitCode}: ${stderr})` : ''}`,
		);
	}

	const written = describeWrittenFile(filePath);
	response.ok = true;
	response.msg = `OK. Exported ${sectionTipo}${written.note}`;
	response.path = written.path;
	response.size = written.bytes;
	response.command_result = stderr === '' ? null : stderr;
	response.debug = { file_path: filePath };
	return response;
}

/**
 * Dump the ENTIRE matrix_dd table (Dédalo private lists — no section_tipo
 * filter by design) into <io>/matrix_dd.copy.gz (PHP
 * export_private_lists_to_file). Same throw-on-missing-file semantics.
 */
export async function exportPrivateListsToFile(): Promise<OntologyIoResponse> {
	const response: OntologyIoResponse = {
		ok: false,
		msg: 'Error. Request failed',
		errors: [],
	};

	const ioPath = setOntologyIoPath();
	if (ioPath === false) {
		response.msg = `Error. Invalid directory: ${ioPath}`;
		response.errors.push(`Unable to create directory: ${ioPath}`);
		return response;
	}
	const filePath = confinedCopyPath(ioPath, 'matrix_dd.copy.gz');
	if (filePath === null) {
		response.msg = 'Error. Unsafe export file path';
		response.errors.push('Export file path escapes the IO dir or carries shell metacharacters');
		return response;
	}

	const copySelect = `SELECT ${MATRIX_COPY_COLUMNS.join(', ')} FROM "matrix_dd"`;
	const { exitCode, stderr } = await runCopyExport(copySelect, filePath);

	if (!existsSync(filePath)) {
		throw new Error(
			`Error Processing Request. File ${filePath} not created!${stderr !== '' ? ` (psql exited ${exitCode}: ${stderr})` : ''}`,
		);
	}

	const written = describeWrittenFile(filePath);
	response.ok = true;
	response.msg = `OK. Private lists (matrix_dd)${written.note}`;
	response.path = written.path;
	response.size = written.bytes;
	response.command_result = stderr === '' ? null : stderr;
	response.debug = { file_path: filePath };
	return response;
}

// ---------------------------------------------------------------------------
// 5. exportLlmMap
// ---------------------------------------------------------------------------

/**
 * Build the flat section→fields LLM map and write it to
 * <io>/ontology_llm_map.json (PHP export_llm_map). Per-section failures are
 * skipped-and-collected inside the builder (PHP catch-and-continue).
 */
export async function exportLlmMap(): Promise<OntologyIoResponse> {
	const response: OntologyIoResponse = {
		ok: false,
		msg: 'Error. Request failed',
		errors: [],
	};

	const ioPath = setOntologyIoPath();
	if (ioPath === false) {
		response.msg = 'Error. Unable to create/access IO directory';
		response.errors.push('io_dir_failed');
		return response;
	}
	const pathFile = join(ioPath, 'ontology_llm_map.json');

	// Lazy import per engineering/CONVENTIONS.md §2 rationale 2 (SANCTIONED BOUNDARY
	// SEAM core→ai): the map builder reuses the MCP discovery machinery
	// (src/ai/mcp/tools/), which must stay OUT of core's static import graph —
	// an install that never exports ontologies never loads the ai subsystem.
	const { buildLlmMap } = await import('../../ai/mcp/tools/llm_map.ts');

	let map: unknown[];
	let skipped: string[];
	try {
		({ map, skipped } = await buildLlmMap());
	} catch (error) {
		response.msg = 'Error. Unable to build the LLM map';
		response.errors.push((error as Error).message);
		return response;
	}

	let saved: number;
	try {
		saved = await Bun.write(pathFile, JSON.stringify(map, null, 4));
	} catch (error) {
		response.msg = 'Error. Unable to save ontology_llm_map.json';
		response.errors.push(`file_write_failed: ${(error as Error).message}`);
		return response;
	}

	const written = describeWrittenFile(pathFile, saved);
	response.ok = true;
	response.msg = `OK. LLM map: ${map.length} sections${
		skipped.length === 0 ? '' : ` (${skipped.length} skipped)`
	}${written.note}`;
	response.path = written.path;
	response.size = written.bytes;
	response.path_file = pathFile;
	response.saved = saved;
	response.section_count = map.length;
	response.skipped = skipped;
	return response;
}
