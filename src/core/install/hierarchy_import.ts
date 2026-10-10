/**
 * install_hierarchies — the wizard's hierarchy step. For each selected OPTIONAL TLD: look
 * up its entry in the vendored thesaurus manifest (hierarchy.json, hierarchy_meta.ts —
 * WC-2026-10-10-hierarchy-json-manifest), import the data files the entry lists
 * (`<tld>1.copy.gz` terms, `<tld>2.copy.gz` models) into matrix_hierarchy, re-consolidate
 * the counter, then ACTIVATE it (./hierarchy_activate.ts — the registry row is created from
 * the entry).
 *
 * VERIFIED BEFORE WRITTEN. Every listed data file must exist in the vendored dir AND its
 * bytes must hash to the entry's `sha256` before anything of the tld is written; a missing
 * file or a mismatch is a loud refusal for that tld (its own error line), never a partial
 * import. Only the LISTED files are imported — a file on disk the entry does not list is
 * not this release's data. An entry with NO data files is an EMPTY thesaurus by design:
 * no import, activation only (and a reset is refused — there is nothing to reset from).
 * A tld the manifest does not list is refused (nothing imported).
 *
 * ACTIVATABLE BEFORE IMPORTED (2026-10-10 review). The entry was exported by
 * ANOTHER installation, so what it references must resolve HERE before a term
 * is copied: hierarchy_activate.ts `activationBlocker` (the lg1 language
 * record, the hierarchy13 typology record, a real section that is a `section`)
 * runs FIRST. It used to run after the `\copy` had committed: a refused entry
 * left thousands of unreachable terms, and every later run saw them and
 * answered "already installed — skipped", ok, never activating.
 *
 * THE CHOSEN THESAURI'S OWN DECLARATIONS. A hierarchy.json entry carries its
 * registry row's hierarchy60, and the hierarchy60 law binds whoever declares:
 * before the batch runs, the selection is checked against the chosen entries'
 * declared dependencies, transitively (hierarchy_dependencies.ts
 * withThesaurusDependencies → ontology_choice.ts closeThesaurusChoice — the rule
 * the CLI plan applies too). A THESAURUS dependency never blocks (owner
 * decision 2026-10-10): the batch is exactly the selection — the front ends
 * pre-tick the declared thesauri — and a MANDATORY one left out (declined, or
 * with no entry) is a warning in the batch message (strongly recommended,
 * installable later from Maintenance › Install hierarchies). Only a declared
 * MANDATORY ONTOLOGY this installation lacks (the ontology law) refuses the
 * WHOLE batch before anything is written. ONE door: the wizard step, the CLI
 * and the add_hierarchy widget all come through here.
 *
 * ALREADY IMPORTED CONVERGES. A tld whose LISTED sections already hold its
 * rows is not re-copied (the raw `\copy` is insert-only) but is still
 * ACTIVATED (idempotent) — a run interrupted between import and activation is
 * finished by the next one, never reported as installed while unreachable.
 * The probe covers every section the entry lists (an entry may list only its
 * `<tld>2` models). A listed section that holds ONLY the General Term root an
 * activation minted (an empty thesaurus activated before the release shipped
 * its data) is not "installed": the terms are available but cannot be copied
 * additively — refused with its own line naming Reset, never a silent skip.
 *
 * A CORE tld (hierarchy_meta.ts CORE_HIERARCHIES — `lg`) is NEVER imported: its terms ship
 * in the seed, in their own table, and the seed restore already activates it. Asked for
 * here it is re-activated only (idempotent), and a reset is refused. History: the importer
 * used to take `lg` too and FORCED its `lg1` rows into matrix_hierarchy — `lg1` is a core
 * section whose table is matrix_langs, so those 21,705 rows landed where nothing reads
 * them (measured 2026-10-08: activation alone makes the hierarchy usable with zero lg rows
 * in matrix_hierarchy). The vendored `lg1.copy.gz` is deleted.
 *
 * The import forces the target table to `matrix_hierarchy` regardless of the file's own
 * section_tipo, and uses `\copy … FROM STDIN` through psql (the sanctioned subprocess
 * pattern).
 *
 * Login-gated (the router checks the session): a fresh install reaches this only after the
 * in-wizard root login. Selecting no optional hierarchy is valid (the seed already carries
 * the core ontology, and Languages is already active).
 *
 * IMPORT IS HALF THE JOB. The `.copy.gz` only lands term rows; on their own they are
 * unreachable — `<tld>1` is not a section the engine knows until its ONTOLOGY exists, and
 * the hierarchy1 registry record is not flagged ACTIVE, so the thesaurus tree is empty and
 * every portal that resolves its targets from the active hierarchies gets nothing. That was
 * the shipped behaviour until 2026-07-14: 69,889 `es1` terms in the database and not one
 * of them reachable. An import that succeeds but whose activation fails is now reported as
 * a FAILURE for that tld — a hierarchy the operator ticked but cannot use is not an install
 * that worked.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { config } from '../../config/config.ts';
import { MATRIX_COPY_COLUMNS } from '../db/matrix_write.ts';
import { safeTld } from '../ontology/data_io.ts';
import { type HierarchyDataFile, sha256Hex } from '../ontology/hierarchy_manifest_format.ts';
import {
	activateCoreHierarchy,
	activateHierarchy,
	activationBlocker,
} from './hierarchy_activate.ts';
import { withThesaurusDependencies } from './hierarchy_dependencies.ts';
import {
	CORE_HIERARCHIES,
	type HierarchyMeta,
	hierarchyMetaByTld,
	isCoreHierarchyTld,
} from './hierarchy_meta.ts';
import { HIERARCHY_IMPORT_DIR } from './paths.ts';
import { connFromConfig, type DbConnDescriptor, type PsqlRunResult, runPsql } from './pg_exec.ts';

const HIERARCHY_TABLE = 'matrix_hierarchy';

export interface HierarchyImportResponse {
	tld: string;
	/** Per-tld REPORT flag (the batch's data), never an envelope. */
	ok: boolean;
	msg: string;
	/** True when the tld was already installed and left untouched (skip mode). */
	skipped?: boolean;
}

/**
 * A BATCH REPORT, not a refusal. The import runs per tld and answers what
 * happened to each one; the router serves it as `ok(<ok>, {extend:{msg, errors,
 * responses}})` so the wizard keeps reading `result`/`msg`/`errors` through the
 * compat mirror and still gets the per-tld sentences (a thrown refusal would
 * replace `errors` with the single failure code and lose them).
 */
export interface InstallHierarchiesResult {
	ok: boolean;
	msg: string;
	errors: string[];
	responses: HierarchyImportResponse[];
}

/** How to treat a tld whose rows are already in matrix_hierarchy. */
export interface InstallHierarchiesOptions {
	/**
	 * false (default): an already-installed tld is SKIPPED (non-destructive — the raw
	 * `\copy` is insert-only and would violate the PK). true: DELETE the tld's existing
	 * rows first, then re-copy from the vendored seed — the PHP replace behavior. This is
	 * destructive (discards any operator edits/additions to that hierarchy's terms) and is
	 * only reached through the explicit, confirmed "Reset to seed" widget action.
	 */
	replace?: boolean;
	/**
	 * The vendored hierarchy dir — the manifest AND the data files are read from
	 * it. Default HIERARCHY_IMPORT_DIR (the release's); a gate passes its own
	 * scratch dir (a manifest it built) — never a production code path.
	 */
	importDir?: string;
}

/**
 * The counter realignment after a raw COPY: for EVERY imported section_tipo of
 * this tld (e.g. es1, es2), raise the counter to the section's high-water mark
 * — MAX(section_id) over live rows AND over the surviving time-machine rows of
 * deleted ones — so the next insert allocates a genuinely fresh id. `tld` is
 * safeTld-validated before this runs, so the anchored regex literal is safe to
 * embed.
 */
function consolidateCounterSql(tld: string): string {
	// The seeded value is the HIGH-WATER MARK, not MAX(live section_id): a row
	// this CREATES would otherwise restart inside the ids of records deleted
	// before the re-import, and matrix_time_machine outlives those records
	// (P0-14; same floor as src/core/db/matrix_write.ts counterFloorExpression).
	return `INSERT INTO matrix_counter (tipo, value)
		SELECT live.section_tipo,
		       GREATEST(live.max_id, COALESCE((
		         SELECT MAX(tm.section_id) FROM matrix_time_machine tm
		          WHERE tm.section_tipo = live.section_tipo), 0))
		  FROM (SELECT section_tipo, MAX(section_id) AS max_id
		          FROM ${HIERARCHY_TABLE} WHERE section_tipo ~ '^${tld}[0-9]+$'
		         GROUP BY section_tipo) live
		ON CONFLICT (tipo) DO UPDATE
		  SET value = GREATEST(matrix_counter.value, EXCLUDED.value);`;
}

/**
 * The row count of each LISTED section (`<tld>1` / `<tld>2`, from the data
 * file names) in matrix_hierarchy — 0 for a section with none. The names are
 * the format's own `<tld>1|2.copy.gz` (the reader pinned them to the entry's
 * safeTld-valid tld), so the quoted literals are safe. A probe failure answers
 * null → the caller falls through to the normal copy, whose own error is
 * reported honestly.
 */
async function listedSectionCounts(
	conn: DbConnDescriptor,
	sections: readonly string[],
): Promise<Map<string, number> | null> {
	const list = sections.map((tipo) => `'${tipo}'`).join(', ');
	const res = await runPsql(conn, [
		'-tAF',
		'\t',
		'-c',
		`SELECT section_tipo, count(*) FROM ${HIERARCHY_TABLE} WHERE section_tipo IN (${list}) GROUP BY section_tipo`,
	]).catch(() => null);
	if (res === null || res.exitCode !== 0) return null;
	const counts = new Map(sections.map((tipo) => [tipo, 0]));
	for (const line of res.stdout.split('\n')) {
		const [tipo, count] = line.split('\t');
		if (tipo !== undefined && counts.has(tipo)) counts.set(tipo, Number(count));
	}
	return counts;
}

/** What is already in matrix_hierarchy of the sections a tld's data files fill. */
export type ListedSectionsState =
	/** None of the listed sections has a row: copy. */
	| { kind: 'absent' }
	/** The data is there (at least one listed section populated, none root-only): skip the copy. */
	| { kind: 'imported' }
	/** A listed section holds only a minted root while its file carries more: Reset is the way. */
	| { kind: 'root_only'; sections: string[] };

/**
 * PURE: classify the listed sections (`counts` — rows now; `dataRows` — rows
 * in each verified file). A section with at most ONE row whose file carries
 * more is ROOT-ONLY: the General Term root an empty activation mints
 * (hierarchy_state.ts ensureRootTerm), not this release's data. A file of one
 * row is indistinguishable from its own root, so it counts as imported.
 */
export function classifyListedSections(
	counts: ReadonlyMap<string, number>,
	dataRows: ReadonlyMap<string, number>,
): ListedSectionsState {
	const present = [...counts].filter(([, count]) => count > 0);
	if (present.length === 0) return { kind: 'absent' };
	const rootOnly = present
		.filter(([section, count]) => holdsOnlyARoot(count, dataRows.get(section) ?? 0))
		.map(([section]) => section);
	return rootOnly.length > 0 ? { kind: 'root_only', sections: rootOnly } : { kind: 'imported' };
}

/** A section of `count` rows whose file carries `fileRows`: only a minted root (see above)? */
function holdsOnlyARoot(count: number, fileRows: number): boolean {
	return count <= 1 && fileRows > 1;
}

/** The data rows of one COPY text (one per line; a last line without its newline counts). */
function copyRowCount(text: Uint8Array): number {
	let rows = 0;
	for (const byte of text) if (byte === 0x0a) rows++;
	return text.length > 0 && text[text.length - 1] !== 0x0a ? rows + 1 : rows;
}

/** The section tipo a listed data file fills (`es1.copy.gz` → `es1`). */
function listedSection(file: string): string {
	return file.replace(/\.copy\.gz$/, '');
}

/**
 * One LISTED data file: read, its bytes checked against the manifest's sha256,
 * then decompressed — its COPY text, or the problem that kept it unread. The
 * digest is checked BEFORE decompression and before anything is written.
 */
function readSeedFile(
	importDir: string,
	listed: HierarchyDataFile,
): { text: Uint8Array } | { problem: string } {
	const fileName = listed.file;
	const path = join(importDir, fileName);
	if (!existsSync(path)) {
		return {
			problem: `missing data file ${fileName} (listed in hierarchy.json) — nothing imported`,
		};
	}
	let bytes: Uint8Array;
	try {
		bytes = readFileSync(path);
	} catch (error) {
		console.error(`[install:hierarchy_import] read failed: ${fileName}`, error);
		return { problem: `read failed (${fileName}) — see the server log; nothing imported` };
	}
	if (sha256Hex(bytes) !== listed.sha256) {
		return {
			problem: `checksum mismatch for ${fileName}: its sha256 is not the one hierarchy.json lists — nothing imported`,
		};
	}
	try {
		return { text: gunzipSync(bytes) };
	} catch (error) {
		// The raw zlib/fs text names absolute paths (SEC-17): it goes to the server log;
		// the report carries a deliberate sentence naming the file.
		console.error(`[install:hierarchy_import] read/decompress failed: ${fileName}`, error);
		return {
			problem: `decompress failed (${fileName}): the file could not be read as a gzip archive — see the server log`,
		};
	}
}

/** `\copy … FROM STDIN` of one COPY text, inline in a psql script (its data ends at `\.`). */
function inlineCopy(text: Uint8Array): Buffer[] {
	const copyCmd = `\\copy ${HIERARCHY_TABLE} (${MATRIX_COPY_COLUMNS.join(', ')}) FROM STDIN\n`;
	const endsWithNewline = text.length === 0 || text[text.length - 1] === 0x0a;
	// COPY text format escapes every backslash in the data, so no data line can
	// be the bare `\.` terminator.
	return [
		Buffer.from(copyCmd),
		Buffer.from(text),
		Buffer.from(endsWithNewline ? '\\.\n' : '\n\\.\n'),
	];
}

/**
 * The IMPORT half of one tld (no activation) — ONE ATOMIC UNIT (OPS-6/PERF-11
 * review): every write of the tld runs in ONE psql session under
 * `--single-transaction` + `ON_ERROR_STOP`, so it applies whole or not at all:
 *   (replace) the scoped DELETE of every `<tld>N` section (the PHP pre-delete,
 *   backup::import_from_copy_file — destructive by design, the caller confirmed
 *   it), the `\copy` of each LISTED data file (`dataFiles` — the manifest
 *   entry's, terms then models; at least one) and the counter realignment.
 * Each used to be its own psql call: a terms file that failed to load left the
 * hierarchy DELETED (operator edits and additions gone, the seed not restored),
 * a failed models file and a failed counter were ignored and the tld reported
 * imported. Every listed file is read, CHECKSUM-VERIFIED against the manifest
 * and decompressed BEFORE anything is sent (a missing file or a mismatch:
 * nothing written).
 * Without `replace`, a tld whose LISTED sections already hold its rows is
 * skipped (the raw `\copy` is insert-only), and one whose listed section holds
 * only a minted root is refused naming Reset (classifyListedSections). Table
 * FORCED to matrix_hierarchy (PHP parity), explicit column order. Gate:
 * test/unit/hierarchy_import_atomic_native.test.ts.
 */
export async function importHierarchyRows(
	conn: DbConnDescriptor,
	tld: string,
	options: {
		/** The manifest entry's data files (verified here); [] is refused — nothing to import. */
		dataFiles: readonly HierarchyDataFile[];
		replace?: boolean;
		importDir?: string;
	},
): Promise<ImportOutcome> {
	const replace = options.replace === true;
	const seeds = readSeedFiles(options.importDir ?? HIERARCHY_IMPORT_DIR, options.dataFiles);
	if ('problem' in seeds) return importRefused(seeds.problem);
	const present = replace ? null : await presentRowsOutcome(conn, seeds);
	if (present !== null) return present;
	const res = await runImportUnit(conn, tld, replace, seeds);
	return res.exitCode === 0
		? { ok: true, msg: 'copied' }
		: importRefused(failedImportMessage(replace, res));
}

/** What importing one tld's rows answered (an internal outcome — the batch report reads it). */
type ImportOutcome = { ok: boolean; msg: string; skipped?: boolean };

/** The one refusal shape of {@link importHierarchyRows}: nothing of the tld was written. */
function importRefused(msg: string): ImportOutcome {
	return { ok: false, msg };
}

/**
 * Without `replace`: the outcome when the LISTED sections already hold rows —
 * skipped (the data is there) or refused naming Reset (only a minted root,
 * classifyListedSections) — or null when there is nothing there: copy.
 */
async function presentRowsOutcome(
	conn: DbConnDescriptor,
	seeds: SeedFiles,
): Promise<ImportOutcome | null> {
	const counts = await listedSectionCounts(conn, [...seeds.dataRows.keys()]);
	if (counts === null) return null;
	const state = classifyListedSections(counts, seeds.dataRows);
	if (state.kind === 'imported') {
		return { ok: true, msg: 'already installed — import skipped', skipped: true };
	}
	if (state.kind === 'absent') return null;
	return importRefused(
		`data available, not imported: ${state.sections.join(', ')} hold(s) only the root an earlier activation created (it was installed as an empty thesaurus) — use "Reset to seed" to import its terms; nothing imported`,
	);
}

/**
 * THE WRITE: the tld's whole import as ONE psql session, one transaction —
 * (reset) the scoped DELETE, the terms and models `\copy`, the counter. A
 * failing statement stops the script (ON_ERROR_STOP) and rolls all of it back.
 */
function runImportUnit(
	conn: DbConnDescriptor,
	tld: string,
	replace: boolean,
	seeds: SeedFiles,
): Promise<PsqlRunResult> {
	const reset = replace
		? [Buffer.from(`DELETE FROM ${HIERARCHY_TABLE} WHERE section_tipo ~ '^${tld}[0-9]+$';\n`)]
		: [];
	const script = Buffer.concat([
		...reset,
		...seeds.texts.flatMap((text) => inlineCopy(text)),
		Buffer.from(`${consolidateCounterSql(tld)}\n`),
	]);
	return runPsql(conn, ['-v', 'ON_ERROR_STOP=1', '--single-transaction', '--quiet', '-f', '-'], {
		stdin: script,
	});
}

/** The decompressed, verified data files of a tld, in COPY order (terms, then models). */
interface SeedFiles {
	texts: Uint8Array[];
	/** The data rows each file carries, by the section it fills. */
	dataRows: Map<string, number>;
}

/**
 * Every listed data file of a tld — verified and decompressed — terms
 * (`<tld>1`) before models (`<tld>2`), or the FIRST problem that kept one
 * unread (then nothing is written). The format reader already pinned each
 * name to the entry's own `<tld>1|2.copy.gz`.
 */
function readSeedFiles(
	importDir: string,
	dataFiles: readonly HierarchyDataFile[],
): SeedFiles | { problem: string } {
	if (dataFiles.length === 0) return { problem: 'no data files listed — nothing to import' };
	const ordered = [...dataFiles].sort((a, b) => a.file.localeCompare(b.file));
	const texts: Uint8Array[] = [];
	const dataRows = new Map<string, number>();
	for (const listed of ordered) {
		const read = readSeedFile(importDir, listed);
		if ('problem' in read) return read;
		texts.push(read.text);
		dataRows.set(listedSection(listed.file), copyRowCount(read.text));
	}
	return { texts, dataRows };
}

/** A failed import unit rolled back whole: nothing of the tld changed. */
function failedImportMessage(replace: boolean, res: PsqlRunResult): string {
	const step = replace ? 'reset failed — nothing changed' : 'import failed — nothing imported';
	return `${step}: ${res.stderr || `psql exited ${res.exitCode}`}`;
}

/**
 * One tld's line in the batch report: its response + the findings it contributes to the
 * batch `errors[]`. Findings are UNPREFIXED sentences — the batch loop tags each with its
 * tld in ONE place (installHierarchies), so no outcome builds a wire list by hand.
 */
interface TldOutcome {
	response: HierarchyImportResponse;
	findings: readonly string[];
}

/** A failed tld: the response says `msg`; the batch gets `findings` (default: the msg). */
function failedTld(tld: string, msg: string, findings: readonly string[] = [msg]): TldOutcome {
	return { response: { tld, ok: false, msg }, findings };
}

/**
 * A CORE tld asked for by name: activation only (never an import, never a reset).
 * The engine-owns-target refusal still applies — activation writes through the pool.
 */
async function coreHierarchyOutcome(
	tld: string,
	replace: boolean,
	engineOwnsTarget: boolean,
	userId: number,
): Promise<TldOutcome> {
	if (replace)
		return failedTld(tld, 'core hierarchy — cannot be reset (its terms ship in the seed)');
	if (!engineOwnsTarget) {
		return failedTld(
			tld,
			`core hierarchy — NOT activated: the engine writes to '${config.db.database}'`,
		);
	}
	const core = CORE_HIERARCHIES.find((item) => item.tld === tld);
	if (core === undefined) return failedTld(tld, 'not a core hierarchy');
	const activation = await activateCoreHierarchy(core, userId);
	if (!activation.ok) {
		return failedTld(tld, `core hierarchy — activation failed: ${activation.errors.join('; ')}`);
	}
	const msg = 'core hierarchy — activated (its terms ship in the seed; never imported)';
	return { response: { tld, ok: true, msg }, findings: [] };
}

/**
 * ACTIVATION of a tld (installer_hierarchy_manager::activate_hierarchy): create its
 * registry row from the manifest entry when it has none, flag it active and provision
 * its ontology, so it is usable at the first login.
 */
async function activateEntry(
	meta: HierarchyMeta,
	done: string,
	userId: number,
	skipped = false,
): Promise<TldOutcome> {
	const activation = await activateHierarchy(meta, userId);
	if (!activation.ok) {
		return failedTld(
			meta.tld,
			`${done}, activation failed: ${activation.errors.join('; ')}`,
			activation.errors,
		);
	}
	const response: HierarchyImportResponse = {
		tld: meta.tld,
		ok: true,
		msg: `${done} and activated`,
	};
	return { response: skipped ? { ...response, skipped } : response, findings: [] };
}

/** The refusal of an activation whose target is not the engine's database. */
function foreignTarget(tld: string, connection: DbConnDescriptor, done: string): TldOutcome {
	return failedTld(
		tld,
		`${done} into '${connection.database}', NOT activated: the engine writes to '${config.db.database}'`,
		[
			`activation skipped — the import target '${connection.database}' is not the engine's database ('${config.db.database}')`,
		],
	);
}

/**
 * An EMPTY thesaurus by design (its entry lists no data files): nothing to
 * import — activation only. A reset is refused: there is no data to reset from.
 */
async function emptyHierarchyOutcome(
	meta: HierarchyMeta,
	connection: DbConnDescriptor,
	replace: boolean,
	engineOwnsTarget: boolean,
	userId: number,
): Promise<TldOutcome> {
	if (replace) {
		return failedTld(
			meta.tld,
			'empty thesaurus by design (hierarchy.json lists no data files) — nothing to reset from',
		);
	}
	if (!engineOwnsTarget)
		return foreignTarget(meta.tld, connection, 'empty thesaurus (nothing imported)');
	return activateEntry(meta, 'empty thesaurus (no data files — nothing imported)', userId);
}

/** A tld WITH data files: the verified import (or skip / reset), then activation. */
async function importedHierarchyOutcome(
	meta: HierarchyMeta,
	connection: DbConnDescriptor,
	options: { replace: boolean; importDir: string },
	engineOwnsTarget: boolean,
	userId: number,
): Promise<TldOutcome> {
	const { tld } = meta;
	const imported = await importHierarchyRows(connection, tld, {
		replace: options.replace,
		importDir: options.importDir,
		dataFiles: meta.data_files,
	});
	if (!imported.ok) return failedTld(tld, imported.msg);
	const skipped = imported.skipped === true;
	// The engine's writes land in the CONFIGURED database. When the import target is a
	// different one, activating would write into the wrong DB — refuse, loudly (a skip
	// there stays a plain skip: nothing of ours to converge).
	if (!engineOwnsTarget) {
		if (skipped) return { response: { tld, ok: true, msg: imported.msg, skipped }, findings: [] };
		return foreignTarget(tld, connection, 'imported');
	}
	// An already-imported tld CONVERGES (see the header): activation is idempotent.
	if (skipped) return activateEntry(meta, imported.msg, userId, true);
	return activateEntry(meta, options.replace ? 'reset' : 'imported', userId);
}

/** An OPTIONAL tld: its manifest entry, then (empty → activation only | import + activate). */
async function optionalHierarchyOutcome(
	connection: DbConnDescriptor,
	tld: string,
	options: { replace: boolean; importDir: string },
	engineOwnsTarget: boolean,
	userId: number,
): Promise<TldOutcome> {
	const meta = hierarchyMetaByTld(tld, options.importDir);
	if (meta === null) {
		return failedTld(tld, 'not listed in hierarchy.json — nothing imported, not activated');
	}
	// THE PREFLIGHT (see the header): what the entry references must resolve HERE before
	// anything of the tld is written. Against the engine's own database only — a foreign
	// target is refused activation anyway, and this check reads the engine pool.
	if (engineOwnsTarget) {
		const blocker = await activationBlocker(meta);
		if (blocker !== null) return failedTld(tld, `${blocker}; nothing imported`);
	}
	if (meta.data_files.length === 0) {
		return emptyHierarchyOutcome(meta, connection, options.replace, engineOwnsTarget, userId);
	}
	return importedHierarchyOutcome(meta, connection, options, engineOwnsTarget, userId);
}

/** The batch sentence the wizard shows. */
function batchMessage(
	tldCount: number,
	responses: readonly HierarchyImportResponse[],
	errorCount: number,
	replace: boolean,
): string {
	if (tldCount === 0) return 'No optional hierarchies selected — Languages (lg) is always active';
	if (errorCount > 0) return `${errorCount} hierarchy(ies) failed`;
	const imported = responses.filter((r) => r.ok && !r.skipped).length;
	const skipped = responses.filter((r) => r.skipped).length;
	const msg = `${replace ? 'Reset' : 'Imported'} ${imported} hierarchy(ies)`;
	return skipped > 0 ? `${msg}, skipped ${skipped} already installed` : msg;
}

/**
 * Import + ACTIVATE the selected hierarchies. `conn` defaults to config.db.
 *
 * TWO WRITE CHANNELS, ONE DATABASE. The import is a `\copy` through psql into `conn`;
 * the activation writes through the ENGINE (its connection pool), which is bound to the
 * CONFIGURED database and cannot be pointed elsewhere. They agree only while `conn` names
 * that same database — which the wizard always does (it passes no conn at all). A caller
 * that hands us a DIFFERENT database (a scratch DB in a test) would import there and
 * activate HERE: half the work in each. That is not a scenario we can serve, so we refuse
 * to activate and say so, rather than silently writing a hierarchy into the wrong database.
 */
/*
 * COVERAGE-EXEMPT (coverage plan §5.2; reason registered in
 * engineering/crap_coverage_exempt.json): a ONE-SHOT install procedure that
 * MUTATES THE MACHINE — config files, a database restore, root credentials, a
 * 126 MB hierarchy import, or a process restart. Blocked by DANGER, not by
 * fixture: the hermetic logic in the same subsystem (deriveLangConfig,
 * installIpAllowed, resolvePgBinary, the hierarchy_meta readers) IS gated
 * (test/unit/tier1_install_native.test.ts).
 */
export async function installHierarchies(
	tlds: string[],
	conn?: DbConnDescriptor,
	userId = -1,
	options: InstallHierarchiesOptions = {},
): Promise<InstallHierarchiesResult> {
	const connection = conn ?? connFromConfig();
	const run: BatchRun = {
		connection,
		replace: options.replace === true,
		importDir: options.importDir ?? HIERARCHY_IMPORT_DIR,
		engineOwnsTarget: connection.database === config.db.database,
		userId,
	};
	const selection = closedSelection(tlds, run);
	const responses: HierarchyImportResponse[] = [];
	const errors: string[] = [...selection.refusals];
	for (const tld of selection.batch) {
		const outcome = await tldOutcome(tld, run);
		responses.push(outcome.response);
		errors.push(...outcome.findings.map((error) => `${tld}: ${error}`));
	}
	const msg =
		selection.refusals.length > 0
			? 'Nothing installed: a selected thesaurus declares an ontology this installation does not have'
			: withNotes(
					batchMessage(selection.batch.length, responses, errors.length, run.replace),
					selection.notes,
				);
	return { ok: errors.length === 0, msg, errors, responses };
}

/** What every tld of one batch shares. */
interface BatchRun {
	connection: DbConnDescriptor;
	replace: boolean;
	importDir: string;
	engineOwnsTarget: boolean;
	userId: number;
}

/**
 * THE CHOSEN THESAURI'S OWN DECLARATIONS (see the header): the batch an install
 * runs, checked against them before anything is written — the batch is the
 * selection (nothing added; a mandatory thesaurus left out is a warning note),
 * a declared mandatory ONTOLOGY this installation lacks REFUSES it whole
 * (`refusals`, empty `batch`). A reset re-seeds exactly what was selected (it
 * installs nothing new).
 */
function closedSelection(
	tlds: string[],
	run: BatchRun,
): { batch: string[]; notes: string[]; refusals: string[] } {
	if (run.replace) return { batch: tlds, notes: [], refusals: [] };
	const closure = withThesaurusDependencies(tlds, { dir: run.importDir });
	if (closure.errors.length > 0) return { batch: [], notes: [], refusals: closure.errors };
	return {
		batch: closure.hierarchies,
		notes: [...closure.notes, ...closure.warnings],
		refusals: [],
	};
}

/** One tld of the batch: refused (invalid), core (activation only) or optional. */
async function tldOutcome(tld: string, run: BatchRun): Promise<TldOutcome> {
	if (!safeTld(tld)) return failedTld(tld, 'invalid tld');
	if (isCoreHierarchyTld(tld)) {
		return coreHierarchyOutcome(tld, run.replace, run.engineOwnsTarget, run.userId);
	}
	return optionalHierarchyOutcome(
		run.connection,
		tld,
		{ replace: run.replace, importDir: run.importDir },
		run.engineOwnsTarget,
		run.userId,
	);
}

/** `msg (note; note)` — or `msg` alone. */
function withNotes(msg: string, notes: readonly string[]): string {
	return notes.length > 0 ? `${msg} (${notes.join('; ')})` : msg;
}
