/**
 * export_hierarchy widget — thesaurus registry sync, the psql dump of an
 * EXPLICIT list of active hierarchy sections, and the `hierarchy.json`
 * manifest (WC-2026-10-10-hierarchy-json-manifest), all into the engine's own
 * hierarchy import directory.
 *
 * WHERE THE FILES GO (2026-08-19). PHP took the destination from an operator
 * constant, `EXPORT_HIERARCHY_PATH`, which was never carried into the TS engine.
 * It is not a choice: the only useful destination is the directory the IMPORT
 * half already reads (`install/import/hierarchy` — HIERARCHY_IMPORT_DIR), so a
 * file exported here is immediately offered by the add_hierarchy panel and the
 * install wizard. It is therefore a FIXED, repo-root-derived constant, not a
 * config key — the same treatment every other v6 `*_PATH` constant got
 * (config/migration_map.ts DERIVED_PATH). The widget serves it to the client as
 * `export_hierarchy_path`; without that value the panel renders its
 * "define the constant" dead-end instead of the export form.
 */

import { existsSync, statSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { MATRIX_COPY_COLUMNS } from '../../db/matrix_write.ts';
import { sql } from '../../db/postgres.ts';
import { isCoreHierarchyTld } from '../../install/hierarchy_meta.ts';
import { HIERARCHY_IMPORT_DIR } from '../../install/paths.ts';
import { connFromConfig, type DbConnDescriptor, runPsql } from '../../install/pg_exec.ts';
import { buildHierarchyManifest } from '../../ontology/hierarchy_census.ts';
import {
	HIERARCHY_MANIFEST_FILE,
	type HierarchyManifest,
	hierarchyDataFileNames,
	serializeHierarchyManifest,
} from '../../ontology/hierarchy_manifest_format.ts';
import { HIERARCHY_MAIN_SECTION } from '../../ontology/ontology_tipos.ts';
import { composeContains, locatorJsonVariants } from '../../search/containment.ts';
import type { WidgetModule, WidgetResponse } from './support.ts';

/** The web path the download route (server.ts serveHierarchyExportFile) answers. */
export const HIERARCHY_EXPORT_URL_PREFIX = '/dedalo/install/import/hierarchy/';

/**
 * One row of the hierarchy REGISTRY (`hierarchy1`) that is currently ACTIVE —
 * `relation->'hierarchy4'` carrying the dd64/1 "yes" locator.
 *
 * `active_ts` is the 'active in thesaurus' flag (hierarchy125), `target` the
 * hierarchy's target section tipo (hierarchy53), `model` its model section tipo
 * (hierarchy58) and `tld` its hierarchy6. Both consumers of this list want a
 * subset of the same columns, which is exactly why it is ONE function: the sync
 * action reconciles `active_ts` per row, the export action admits only the
 * `target`/`model` tipos of these rows. Two copies of this query would be two chances to lose the
 * dual-typed section_id probe below.
 */
export interface ActiveHierarchyRow {
	section_id: number;
	active_ts: string | null;
	target: string | null;
	/** hierarchy58 — the target MODEL section tipo (`<tld>2`), when the row names one. */
	model: string | null;
	/** hierarchy6 — the row's TLD as stored (the seed stores it uppercase). */
	tld: string | null;
}

/**
 * The ACTIVE hierarchy registry rows (PHP hierarchy::get_active_elements).
 *
 * The dd64/1 locator is matched in BOTH typed section_id forms
 * (WC-2026-08-10-section-id-int-canonical): jsonb `@>` is type-strict and stored
 * locators are string-form until the int sweep, int-form after — a single-form
 * literal silently loses half the rows during the expand window and forever on
 * an old-backup restore. `active_ts` reads through `->>`, which renders either
 * stored type as text, so its '1' comparison is type-agnostic.
 */
export async function activeHierarchyRows(): Promise<ActiveHierarchyRow[]> {
	const queryParams: string[] = [];
	const activeClause = composeContains(
		`relation->'hierarchy4'`,
		[locatorJsonVariants({ section_id: 1, section_tipo: 'dd64' }).map((json) => `[${json}]`)],
		(payload) => {
			queryParams.push(payload);
			return `$${queryParams.length}`;
		},
	);
	return (await sql.unsafe(
		`SELECT section_id,
		        relation->'hierarchy125'->0->>'section_id' AS active_ts,
		        COALESCE(data->'hierarchy53', string->'hierarchy53')->0->>'value' AS target,
		        COALESCE(data->'hierarchy58', string->'hierarchy58')->0->>'value' AS model,
		        COALESCE(data->'hierarchy6', string->'hierarchy6')->0->>'value' AS tld
		 FROM matrix_hierarchy_main
		 WHERE section_tipo = 'hierarchy1'
		   AND ${activeClause}
		 ORDER BY section_id`,
		queryParams,
	)) as ActiveHierarchyRow[];
}

/**
 * The PURE per-row decision of the registry sync: does THIS active hierarchy
 * registry row get deactivated?
 *
 * Two skips, both load-bearing:
 *  - `active_ts === '1'` — the registry already agrees with the thesaurus, so
 *    writing again would be a needless component save plus a time-machine row
 *    per already-synced hierarchy.
 *  - `target === 'rsc197'` — the 'People' hierarchy is EXEMPT (PHP
 *    hierarchy::sync_hierarchy_active_status). Drop this arm and pressing the
 *    button deactivates People on every install.
 *
 * `active_ts` arrives from `->>`, i.e. text or NULL: the comparison is against
 * the STRING '1', never a number and never truthiness.
 */
export function shouldDeactivate(row: {
	active_ts: string | null;
	target: string | null;
}): boolean {
	if (row.active_ts === '1') return false; // in sync
	if (row.target === 'rsc197') return false; // 'People' hierarchy exempt
	return true;
}

/**
 * Deactivate every ACTIVE hierarchy (hierarchy1 hierarchy4 = dd64/1) whose
 * 'active in thesaurus' flag (hierarchy125) is NOT yes — the registry follows
 * the thesaurus (PHP hierarchy::sync_hierarchy_active_status). The 'People'
 * hierarchy (target rsc197) is exempted. Writes go through the standard
 * component save path (TM row + modification metadata included).
 */
/*
 * COVERAGE-EXEMPT (coverage plan §5.2; reason registered in
 * engineering/crap_coverage_exempt.json): the read below is the whole-registry
 * reconcile BY DESIGN — no `section_id` is bound — so no scratch-scoped
 * invocation exists: one call would deactivate every out-of-sync hierarchy in
 * the suite database and write a TM row for each. The DECISION it drives is
 * gated as `shouldDeactivate()`
 * (test/unit/export_hierarchy_deactivate_native.test.ts); the write path is
 * `saveComponentData`, gated elsewhere.
 */
async function exportHierarchySyncActiveStatus(): Promise<WidgetResponse> {
	const rows = await activeHierarchyRows();

	let errorCount = 0;
	const { saveComponentData } = await import('../../section/record/save_component.ts');
	for (const row of rows) {
		if (!shouldDeactivate(row)) continue;
		const outcome = await saveComponentData({
			componentTipo: 'hierarchy4',
			sectionTipo: 'hierarchy1',
			sectionId: Number(row.section_id),
			lang: 'lg-nolan',
			userId: -1,
			changedData: [
				{
					action: 'set_data',
					id: null,
					// NUMERICAL_MATRIX_VALUE_NO — the full locator shape the
					// component save persists for the radio_button. section_id is
					// minted as an INT: that is the canonical stored form
					// (WC-2026-08-10-section-id-int-canonical), not a string.
					value: [
						{
							id: 1,
							type: 'dd151',
							section_id: 2,
							section_tipo: 'dd64',
							from_component_tipo: 'hierarchy4',
						},
					],
				},
			],
		});
		if (!outcome.ok) errorCount++;
	}
	return { data: errorCount === 0 };
}

// ---------------------------------------------------------------------------
// EXPORT — pure decisions first, so each is reachable without touching psql.
//
// AN EXPLICIT LIST ONLY (WC-2026-10-10-hierarchy-json-manifest). The PHP-era
// `'*'` (every active hierarchy) and `'all'` (the whole matrix_hierarchy table
// into one timestamped file) scopes are GONE: what a master ships is a choice
// made per hierarchy, `'*'` dumped every active thesaurus whether or not it was
// meant to be vendored, and the `all_…` file was read by no importer at all.
// Each requested tipo must be the thesaurus (hierarchy53) or model
// (hierarchy58) section of an ACTIVE hierarchy1 row — anything else is its own
// error line and writes nothing.
//
// THE CORE `lg` IS NEVER EXPORTED. Its terms live in matrix_langs and ship in
// the install seed (install/db/seed/matrix_langs.copy.gz); the installer
// imports dumps into matrix_hierarchy, so an `lg1.copy.gz` would only be noise
// there. lg keeps its own path entirely; this module never reads matrix_langs.
// ---------------------------------------------------------------------------

/**
 * PHP `safe_tipo()`: a SECTION tipo is 2+ lowercase ascii letters followed by
 * digits, and nothing else. Deliberately STRICTER than the engine-wide
 * `isSafeSectionTipo` (`[a-zA-Z0-9_]+`): this value is inlined into a psql
 * `\copy` argument — where psql performs NO variable interpolation, so a bind
 * parameter is impossible — AND it becomes the exported file's basename, which
 * the download route must be able to allowlist with the same shape.
 */
export function safeExportTipo(sectionTipo: string): boolean {
	return /^[a-z]{2,}[0-9]+$/.test(sectionTipo);
}

/**
 * The ONE table a dump is read from: the installer's import forces the same
 * table (hierarchy_import.ts), so export and import agree by construction.
 */
export const HIERARCHY_EXPORT_TABLE = 'matrix_hierarchy';

/** The TLD namespace of a (safeExportTipo-valid) section tipo: `es1` → `es`, `lg2` → `lg`. */
export function tipoTld(sectionTipo: string): string {
	return sectionTipo.replace(/[0-9]+$/, '');
}

/** What the operator asked to export: an explicit section tipo list. */
export type ExportScope = string[];

/**
 * Parse the panel's single free-text input: a comma-separated section tipo
 * list. Empty entries are dropped here; INVALID ones are NOT — they must
 * survive to the plan so each gets its own error line rather than vanishing
 * silently (a retired `'*'` / `'all'` included: it earns a line saying so).
 */
export function parseExportScope(raw: unknown): ExportScope {
	const text = typeof raw === 'string' ? raw.trim() : '';
	return text
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry !== '');
}

/**
 * The single psql meta-command that produces one file.
 *
 * `\copy … TO PROGRAM 'gzip -c > <file> && sync'` streams the result set
 * straight through gzip to its final name in ONE pass: no intermediate
 * uncompressed file to clean up, and `sync` flushes it before psql returns, so
 * the existence probe that follows is meaningful. `\copy` (backslash) is
 * psql's CLIENT-side meta-command — not SQL `COPY` — so gzip runs on THIS host
 * and the file lands here even when Postgres is remote.
 */
export function exportCopyCommand(
	table: string,
	where: string,
	order: string,
	outFile: string,
): string {
	const columns = MATRIX_COPY_COLUMNS.join(',');
	return (
		`\\copy (SELECT ${columns} FROM ${table} WHERE ${where} ORDER BY ${order})` +
		` TO PROGRAM 'gzip -c > ${outFile} && sync'`
	);
}

/** The copy-pasteable re-import command the panel prints under the file list. */
export function importHint(): string {
	const columns = MATRIX_COPY_COLUMNS.join(',');
	return (
		`SECTION_TIPO='us1' ; gunzip -c \${SECTION_TIPO}.copy.gz` +
		` | psql dedalo_myentity -U mydbuser -h localhost` +
		` -c "\\copy ${HIERARCHY_EXPORT_TABLE}(${columns}) from STDIN"`
	);
}

/** One produced file, as the client's `render_export_response` reads it. */
export interface ExportedFile {
	section_tipo: string;
	table: string;
	file_name: string;
	bytes: number | null;
	url: string;
}

/**
 * Why the destination cannot be used, or null when it can.
 *
 * A SENTENCE-OR-NULL, deliberately not an `{ok, error}` pair: an internal
 * outcome shape must not spell the wire envelope (error_taxonomy_tripwire B1).
 * The caller turns this into one error line of a batch report.
 *
 * The single-quote screen is not paranoia about the operator: the path is
 * inlined into a psql-quoted shell command (`TO PROGRAM '…'`), so a repo
 * checked out under a directory whose name contains `'` would break OUT of that
 * quoting. It cannot be escaped away inside a nested quoting context, so it is
 * refused loudly instead of silently producing a broken command.
 */
export function exportDirRefusal(dir: string): string | null {
	if (/['\r\n\0]/.test(dir)) {
		return `the hierarchy export directory path cannot be used in a shell command: ${dir}`;
	}
	if (!existsSync(dir)) {
		return `hierarchy export directory does not exist: ${dir}`;
	}
	try {
		// A write probe by CREATION would litter; the psql child is the real
		// writer and reports its own failure, so this is the cheap precondition.
		if (!statSync(dir).isDirectory()) {
			return `hierarchy export destination is not a directory: ${dir}`;
		}
	} catch (error) {
		return `hierarchy export directory unreadable: ${(error as Error).message}`;
	}
	return null;
}

/** The injectable edge: production always takes the configured connection. */
export interface ExportHierarchyDeps {
	conn?: DbConnDescriptor;
	/** Destination directory; defaults to the fixed HIERARCHY_IMPORT_DIR. */
	outDir?: string;
	/** Clock for hierarchy.json's envelope `date`. */
	now?: Date;
}

/** One file to produce: everything the psql command needs, decided up front. */
export interface ExportEntry {
	sectionTipo: string;
	table: string;
	where: string;
	order: string;
	fileName: string;
}

/** The entry for one requested section tipo (caller has validated the tipo). */
export function listEntry(sectionTipo: string): ExportEntry {
	return {
		sectionTipo,
		table: HIERARCHY_EXPORT_TABLE,
		where: `section_tipo = '${sectionTipo}'`,
		order: 'section_id ASC',
		fileName: `${sectionTipo}.copy.gz`,
	};
}

/**
 * The tipos an export may name: the hierarchy53 (thesaurus) and hierarchy58
 * (model) section of every ACTIVE registry row, each mapped to that row's
 * lowercased hierarchy6 TLD (PURE — the rows come from activeHierarchyRows).
 */
export function exportableTipos(
	rows: readonly Pick<ActiveHierarchyRow, 'target' | 'model' | 'tld'>[],
): Map<string, string> {
	const exportable = new Map<string, string>();
	for (const row of rows) {
		const tld = (row.tld ?? '').trim().toLowerCase();
		for (const tipo of [row.target, row.model]) {
			if (typeof tipo === 'string' && tipo !== '') exportable.set(tipo, tld);
		}
	}
	return exportable;
}

/** The PHP-era scopes this export no longer accepts (WC-2026-10-10). */
const RETIRED_SCOPES: ReadonlySet<string> = new Set(['*', 'all']);

/**
 * Is this tipo a CORE hierarchy's section? Checked BOTH by the tipo's own TLD
 * namespace (`lg2`, which no row may name) and by the TLD of the active row
 * that names it — so neither a renamed target nor a missing row lets lg out.
 */
function isCoreTipo(sectionTipo: string, exportable: ReadonlyMap<string, string>): boolean {
	return (
		isCoreHierarchyTld(tipoTld(sectionTipo)) ||
		isCoreHierarchyTld(exportable.get(sectionTipo) ?? '')
	);
}

/** Why ONE requested tipo is refused, or null when it may be dumped. */
export function exportTipoRefusal(
	sectionTipo: string,
	exportable: ReadonlyMap<string, string>,
): string | null {
	if (RETIRED_SCOPES.has(sectionTipo)) {
		return `Ignored '${sectionTipo}': the export takes an explicit list of section tipos, e.g. es1,fr1`;
	}
	if (!safeExportTipo(sectionTipo)) {
		return `Ignored invalid section tipo: ${sectionTipo} . Use section tipos, e.g. es1,fr1`;
	}
	if (isCoreTipo(sectionTipo, exportable)) {
		return `Refused ${sectionTipo}: a CORE hierarchy (lg) is never exported — its terms live in matrix_langs and ship in the install seed`;
	}
	const tld = exportable.get(sectionTipo);
	if (tld === undefined) {
		return `Refused ${sectionTipo}: not the thesaurus (hierarchy53) or model (hierarchy58) section of an active hierarchy`;
	}
	// hierarchy.json carries ONLY `<tld>1|2.copy.gz` (the format's data-file names, which
	// the census digests and the installer imports): a dump of any other section — a row
	// whose hierarchy53 names `rsc197`, `mht72`… — would be a file no entry ever lists.
	if (!hierarchyDataFileNames(tld).includes(`${sectionTipo}.copy.gz`)) {
		return `Refused ${sectionTipo}: only a hierarchy's own ${tld}1 / ${tld}2 sections can be vendored (hierarchy.json lists no other data file)`;
	}
	return null;
}

/**
 * Split a requested tipo list into the entries to dump and the refusal lines.
 *
 * Pure, and separate from the run for one reason: an invalid tipo must produce
 * an error LINE, never abort the batch. Deciding that here means the runner has
 * no "is this allowed" arm left to get wrong. A tipo listed twice is dumped
 * once (it is the same file).
 */
export function planListEntries(
	tipos: readonly string[],
	exportable: ReadonlyMap<string, string>,
): { entries: ExportEntry[]; errors: string[] } {
	const entries: ExportEntry[] = [];
	const errors: string[] = [];
	for (const sectionTipo of new Set(tipos)) {
		const refusal = exportTipoRefusal(sectionTipo, exportable);
		if (refusal === null) entries.push(listEntry(sectionTipo));
		else errors.push(refusal);
	}
	if (tipos.length === 0) {
		errors.push('No section tipo requested. List section tipos, e.g. es1,fr1');
	}
	return { entries, errors };
}

/** Turn a parsed scope into the files to produce plus the refusals it earned. */
async function planEntries(
	scope: ExportScope,
): Promise<{ entries: ExportEntry[]; errors: string[] }> {
	return planListEntries(scope, exportableTipos(await activeHierarchyRows()));
}

/** Dump ONE entry to its file. Returns the record, or the error sentence. */
async function exportOne(
	conn: DbConnDescriptor,
	outDir: string,
	entry: ExportEntry,
): Promise<{ file: ExportedFile } | { error: string }> {
	const outFile = join(outDir, entry.fileName);
	const command = exportCopyCommand(entry.table, entry.where, entry.order, outFile);
	const run = await runPsql(conn, ['-v', 'ON_ERROR_STOP=1', '-c', command]);
	// The file probe is the real verdict: `\copy … TO PROGRAM` reports the psql
	// side, not gzip's, so a nonzero exit and a produced file are both possible.
	// psql's own words ride along when there is nothing to show.
	if (!existsSync(outFile)) {
		const detail = run.stderr !== '' ? ` (${run.stderr})` : '';
		return { error: `Export failed for section_tipo: ${entry.sectionTipo}${detail}` };
	}
	return {
		file: {
			section_tipo: entry.sectionTipo,
			table: entry.table,
			file_name: entry.fileName,
			bytes: fileBytes(outFile),
			url: HIERARCHY_EXPORT_URL_PREFIX + entry.fileName,
		},
	};
}

/** Size of a produced file, or null when it cannot be stat'ed (never a throw). */
function fileBytes(path: string): number | null {
	try {
		return statSync(path).size;
	} catch {
		return null;
	}
}

/**
 * Assemble the panel response. `data` is true when at least one file landed;
 * `files` and `import_hint` are top-level extension keys the client reads by
 * name (render_export_response).
 */
function exportResponse(files: ExportedFile[], errors: string[]): WidgetResponse {
	const exported = files.length > 0;
	return {
		data: exported,
		msg: exported
			? `OK. ${files.length} hierarchy file(s) exported. Export hierarchy.json again so its checksums cover them`
			: 'Error. No hierarchy files were exported',
		...(errors.length > 0 ? { errors } : {}),
		extend: { files, import_hint: importHint() },
	};
}

/**
 * Fill the injectable edges with their production defaults.
 *
 * Kept OUT of `exportHierarchy` (the same reason ontology_update.ts keeps
 * `resolveUpdateDeps` separate): three `??` fallbacks are three branches the
 * seam would otherwise add to the function that actually runs psql, and the
 * complexity budget belongs to the real work.
 */
function resolveExportDeps(deps: ExportHierarchyDeps): {
	conn: DbConnDescriptor;
	outDir: string;
	now: Date;
} {
	return {
		conn: deps.conn ?? connFromConfig(),
		outDir: deps.outDir ?? HIERARCHY_IMPORT_DIR,
		now: deps.now ?? new Date(),
	};
}

/**
 * Dump hierarchy sections to gzip-compressed psql COPY files (PHP
 * hierarchy::export_hierarchy, list scope only).
 *
 * A per-entry failure is an ERROR LINE, never a thrown refusal: the panel runs
 * over a list, and one bad tipo must not discard the files the others produced.
 */
export async function exportHierarchy(
	options: Record<string, unknown>,
	deps: ExportHierarchyDeps = {},
): Promise<WidgetResponse> {
	const { conn, outDir } = resolveExportDeps(deps);
	const refusal = exportDirRefusal(outDir);
	if (refusal !== null) return exportResponse([], [refusal]);

	const { entries, errors } = await planEntries(parseExportScope(options.section_tipo));

	const files: ExportedFile[] = [];
	for (const entry of entries) {
		const result = await exportOne(conn, outDir, entry);
		if ('error' in result) errors.push(result.error);
		else files.push(result.file);
	}
	return exportResponse(files, errors);
}

// ---------------------------------------------------------------------------
// hierarchy.json — the thesaurus manifest (WC-2026-10-10-hierarchy-json-manifest).
//
// The census (ontology/hierarchy_census.ts) reads every ACTIVE hierarchy1 row
// and digests the `<tld>1|2.copy.gz` files present in the export directory AT
// THIS MOMENT; the result is validated by the format's own reader before it is
// written. So the order an operator follows is: export the data files first,
// then hierarchy.json — a dump written after it is not covered by its
// checksums, and the installer refuses a mismatch.
// ---------------------------------------------------------------------------

/**
 * Write `text` to `target` ATOMICALLY: a sibling temp file, then a rename. The
 * installer reads this file; a half-written manifest would refuse every
 * install until re-exported.
 */
async function writeAtomically(target: string, text: string): Promise<number> {
	const temp = `${target}.${process.pid}.tmp`;
	try {
		const bytes = await Bun.write(temp, text);
		await rename(temp, target);
		return bytes;
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
}

/** The non-core entries that list no data file: activated EMPTY at install time. */
function emptyThesauri(manifest: HierarchyManifest): string[] {
	return manifest.active_hierarchies
		.filter((entry) => entry.data_files.length === 0 && !isCoreHierarchyTld(entry.tld))
		.map((entry) => entry.tld);
}

/**
 * Assemble the hierarchy.json panel response. `files` reuses the data export's
 * file record (the client renders both through render_export_response);
 * `active_hierarchies`, `data_files` and `empty_hierarchies` are the counts and
 * names an operator checks before vendoring the file. Census errors (rows
 * skipped or degraded) ride as `errors` — the file is still written, without
 * those rows, and the panel shows why each is missing.
 */
function manifestResponse(
	written: { manifest: HierarchyManifest; bytes: number } | null,
	errors: string[],
): WidgetResponse {
	if (written === null) {
		return { data: false, msg: `Error. ${HIERARCHY_MANIFEST_FILE} was not written`, errors };
	}
	const { manifest, bytes } = written;
	const dataFiles = manifest.active_hierarchies.reduce(
		(sum, entry) => sum + entry.data_files.length,
		0,
	);
	return {
		data: true,
		msg: `OK. ${HIERARCHY_MANIFEST_FILE} written: ${manifest.active_hierarchies.length} active hierarchies, ${dataFiles} data file(s)`,
		...(errors.length > 0 ? { errors } : {}),
		extend: {
			files: [
				{
					section_tipo: HIERARCHY_MAIN_SECTION,
					table: 'matrix_hierarchy_main',
					file_name: HIERARCHY_MANIFEST_FILE,
					bytes,
					url: HIERARCHY_EXPORT_URL_PREFIX + HIERARCHY_MANIFEST_FILE,
				},
			],
			active_hierarchies: manifest.active_hierarchies.length,
			data_files: dataFiles,
			empty_hierarchies: emptyThesauri(manifest),
		},
	};
}

/**
 * Export `hierarchy.json` into the hierarchy directory: the census of the
 * active registry plus the digests of the data files present now. A census
 * bug (an output its own reader refuses) THROWS `install.manifest_invalid`
 * rather than writing a file the installer would refuse.
 */
export async function exportHierarchyJson(deps: ExportHierarchyDeps = {}): Promise<WidgetResponse> {
	const { outDir, now } = resolveExportDeps(deps);
	const refusal = exportDirRefusal(outDir);
	if (refusal !== null) return manifestResponse(null, [refusal]);
	const { manifest, errors } = await buildHierarchyManifest({ dataDir: outDir, now });
	const bytes = await writeAtomically(
		join(outDir, HIERARCHY_MANIFEST_FILE),
		serializeHierarchyManifest(manifest),
	);
	return manifestResponse({ manifest, bytes }, errors);
}

/**
 * The panel value the client render reads (`value.export_hierarchy_path`).
 *
 * A getValue must EXIST whatever this widget can do: without one the panel
 * refuses to load (maintenance.widget_unavailable) and even the sync form
 * becomes unreachable (paired with the client binding in 2f7bd86370). The
 * client render treats a falsy path as "exporting not enabled" and shows only
 * the sync form.
 *
 * It reports the real directory because export IS implemented on this engine
 * now (ported natively in d22c7279c9): the action no longer writes into the
 * PHP tree, so it is no longer engineDenied and the path is not null.
 */
async function exportHierarchyGetValue(): Promise<WidgetResponse> {
	return { data: { export_hierarchy_path: HIERARCHY_IMPORT_DIR } };
}

export const widget: WidgetModule = {
	// An export walks every term of every chosen hierarchy: maintenance (PERF-11).
	// export_hierarchy_json is registry-sized (one row per hierarchy) — bounded.
	unboundedActions: ['export_hierarchy'],
	getValue: exportHierarchyGetValue,
	spec: {
		id: 'export_hierarchy',
		category: 'data',
		class: 'success width_100',
		label: { kind: 'label', key: 'export_hierarchy' },
	},
	apiActions: {
		sync_hierarchy_active_status: exportHierarchySyncActiveStatus,
		export_hierarchy: (options) => exportHierarchy(options),
		export_hierarchy_json: () => exportHierarchyJson(),
	},
};
