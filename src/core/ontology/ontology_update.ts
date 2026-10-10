/**
 * Ontology UPDATE orchestrator (UPDATE_PROCESS Phase 2) — the TS twin of PHP
 * widgets/update_ontology::update_ontology(). Options come from the
 * byte-identical client: `{server, files, info}` — the CLIENT fetched the
 * manifest from the selected master and built the file list (matrix_dd
 * prepended); this engine validates, stages, and imports.
 *
 * PHP step order preserved: download per file → per-TLD import branch
 * (matrix_dd = whole-table private lists; others = add_main_section +
 * create_dd_ontology_root + scoped import + counter) → dd_ontology reindex
 * per TLD → schema snapshot → optimize tables → cache purge → schema-changes
 * file (hard-fail on write error) → root_info read-back.
 *
 * STRICTER THAN PHP (WC-023): the selected server is RE-RESOLVED from the
 * config catalog (never trusted from the client); everything is staged and
 * validated BEFORE the first destructive statement; a per-table recovery
 * snapshot is taken before import and AUTO-RESTORED on failure; each file's
 * DELETE+COPY is one transaction. PHP's per-file partial success
 * (ok:true with errors) is replaced by all-or-nothing semantics.
 * TS-N/A steps (PHP session wipe, static JS lang-file regen, backend
 * activity row): the TS engine has no static session caches or generated
 * lang files — UI labels are repo catalogs (WC-033) and in-process caches
 * are purged via clearOntologyDerivedCaches; the activity row is not
 * ported (ledgered).
 *
 * THE SHARED LOWER LAYER (2026-10-09, installer unification A4):
 * `importStagedOntologyFiles` is Phases B + C + the dd_ontology re-derive,
 * extracted so the installer's ontology door (src/core/install/ontology_install.ts)
 * imports through the SAME routine the update panel does — never a copy. It never
 * resolves a target, downloads, or runs the panel's tail; both callers hold the
 * one single-flight latch (claimOntologyImportLatch / releaseOntologyImportLatch)
 * around it.
 *
 * GATE: `test/unit/ontology_update_shell_native.test.ts` drives the real
 * orchestrator through the `UpdateOntologyDeps` seam over the scratch TLD
 * `zzd` — target refusal, the single-flight latch (refused AND released), the
 * Phase-B abort, the Phase-C auto-restore + D7 message, and the success tail
 * (schema-changes CONTENT, counter consolidation).
 *
 * COVERAGE-EXEMPT (`updateOntology`, arms only), deliberately and permanently:
 *   - the real remote-download arm of Phase A — a gate never makes a network
 *     fetch; the local fixture server IS the configured origin instead.
 *   - the `engineOwnsInstall()` refusal — collapsed to `true` at the
 *     2026-07-11 cutover, so its false arm is unreachable.
 *   - `optimizeTables`' own REINDEX/VACUUM outcome: it is executed by the gate
 *     (skipping it would prove a configuration nobody ships) but its errors are
 *     non-fatal and unasserted.
 */

import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { config } from '../../config/config.ts';
import { privateDir } from '../../config/env.ts';
import {
	readDdOntologyRow,
	searchDdOntology,
	validateDdOntologyIdentifierConstraints,
} from '../db/dd_ontology.ts';
import { MATRIX_COPY_COLUMNS } from '../db/matrix_write.ts';
import { connFromConfig, type DbConnDescriptor, runPsql } from '../install/pg_exec.ts';
import { engineOwnsInstall } from '../update/ownership.ts';
import { clearOntologyDerivedCaches } from './cache_invalidation.ts';
import { isSafeSectionTipo, setOntologyIoPath } from './data_io.ts';
import {
	assertTlsVerificationOn,
	confinedPath,
	consolidateSectionCounter,
	importFromCopyFile,
	MAX_MANIFEST_FILES,
	normalizeOntologyTld,
	type OntologyIoResponse,
} from './data_io_import.ts';
import { reportMissingDependencies } from './dependency_report.ts';
import { termByTipo } from './labels.ts';
import {
	type OntologyUpdateCatalog,
	resolveUpdateTarget,
	type StagedFile,
	stageOntologyFiles,
} from './ontology_update_target.ts';
import {
	createDdOntologyRootNode,
	setRecordsInDdOntology,
	syncMainSectionFromDefinition,
} from './ontology_write.ts';
import { getOrderedSubtree } from './resolver.ts';
import { LOCAL_ONTOLOGY_SECTION } from './tld.ts';

const DEDALO_ROOT_TIPO = 'dd1';

/**
 * Whether a staged file's records project into dd_ontology nodes. Not
 * matrix_dd, and not override records (parser.ts): nothing to derive.
 */
function derivesNodes(file: StagedFile): boolean {
	return file.tld !== 'matrix_dd' && file.sectionTipo !== LOCAL_ONTOLOGY_SECTION;
}
const OPTIMIZE_TABLES = ['dd_ontology', 'matrix_ontology', 'matrix_ontology_main', 'matrix_dd'];

/**
 * section tipo → recursive descendant tipos (PHP
 * hierarchy::get_simple_schema_of_sections). Built on the ONE consolidated
 * ontology walk (resolver getOrderedSubtree, crossSections — the T3 ratchet
 * rule); sections with no children map to [].
 */
async function getSimpleSchemaOfSections(): Promise<Record<string, string[]>> {
	const sections = await searchDdOntology({ model: 'section' }, true);
	const schema: Record<string, string[]> = {};
	for (const sectionTipo of sections) {
		const subtree = await getOrderedSubtree(sectionTipo, { crossSections: true });
		schema[sectionTipo] = subtree.map((node) => node.tipo).sort();
	}
	return schema;
}

/** What importOntologyPackage did; `fatal` names the step that must be rolled back. */
export interface OntologyPackageImport {
	messages: string[];
	errors: string[];
	/** null = imported; 'import' = the COPY failed; 'normalize' = ONT-TLD failed. */
	fatal: 'import' | 'normalize' | null;
}

/**
 * ONE staged ontology package into matrix_ontology — the per-file body of the
 * update (and of the install seed compiler, install/seed_build.ts, which applies
 * the vendored release packages through this same door so a fresh install's
 * ontology is exactly what an updated client holds). PHP order: registry record
 * + dd_ontology root node BEFORE the row import (they are not covered by the
 * update's snapshots — the caller reports them as provisioned). Never rolls back
 * itself: a non-null `fatal` is the caller's cue to restore.
 */
export async function importOntologyPackage(
	file: StagedFile,
	userId: number,
	conn: DbConnDescriptor,
	options: {
		provision?: boolean;
		/** Called once the registry record + root node exist (before the row import). */
		onProvisioned?: () => void;
	} = {},
): Promise<OntologyPackageImport> {
	const outcome: OntologyPackageImport = { messages: [], errors: [], fatal: null };
	// `provision: false` — the rows only: the registry record and root node need
	// an ontology that can resolve its own sections (ontology35's matrix table is
	// read from dd_ontology), which an EMPTY database does not have yet. The seed
	// compiler bootstraps with a rows-only pass + derive, then runs this door in
	// full on top, exactly as a client update does.
	if (options.provision !== false) {
		// absent typology (null) → both read the registry / default themselves.
		// `dependencies` (hierarchy60): null/absent = the definition declares nothing —
		// the row keeps its local value; [] = declared, needs nothing.
		const fileItem = {
			tld: file.tld,
			section_tipo: file.sectionTipo,
			typology_id: file.typologyId,
			name_data: file.nameData,
			dependencies: file.dependencies,
		} as Parameters<typeof syncMainSectionFromDefinition>[0];
		// The IMPORT door of the registry-row law (ontology_write.ts).
		await syncMainSectionFromDefinition(fileItem, userId);
		await createDdOntologyRootNode(fileItem, userId);
		options.onProvisioned?.();
	}
	const imported = await importFromCopyFile({
		sectionTipo: file.sectionTipo,
		filePath: file.stagedPath,
		matrixTable: 'matrix_ontology',
		conn,
	});
	outcome.messages.push(imported.msg);
	if (imported.ok !== true) {
		outcome.errors.push(...imported.errors);
		outcome.fatal = 'import';
		return outcome;
	}
	// ONT-TLD: the staged file carries whatever ontology7 it was EXPORTED
	// with, while sectionTipo comes from the target tld — a tld renamed
	// upstream would otherwise land a whole ontology in the OLD namespace.
	// See data_io_import.normalizeOntologyTld. (The restore path is
	// deliberately NOT normalized: a rollback restores, it does not fix.)
	const rewritten = await normalizeOntologyTld(file.sectionTipo, conn);
	if (rewritten === null) {
		// FATAL and ROLLED BACK by the caller, exactly like a failed import.
		// Continuing would run the dd_ontology re-derive over rows that still
		// declare the export's tld — projecting the whole ontology into the OLD
		// namespace and finishing `ok: true`.
		outcome.errors.push(`ontology7 normalization failed for ${file.sectionTipo}`);
		outcome.fatal = 'normalize';
		return outcome;
	}
	if (rewritten > 0) {
		outcome.messages.push(`${file.sectionTipo}: rewrote ontology7 on ${rewritten} row(s)`);
	}
	if (!(await consolidateSectionCounter(file.sectionTipo, 'matrix_ontology', conn))) {
		outcome.errors.push(`counter consolidation failed for ${file.sectionTipo}`);
	}
	return outcome;
}

/**
 * The dd_ontology re-derive of every imported package that projects nodes
 * (not matrix_dd, not override records). wholeSection: this IS the deliberate
 * full-TLD re-derive after an ontology-file import — not a request-driven batch
 * (WC-043).
 */
export async function deriveOntologyPackages(
	staged: readonly StagedFile[],
	userId: number,
): Promise<{ messages: string[]; errors: string[] }> {
	const result = { messages: [] as string[], errors: [] as string[] };
	for (const file of staged) {
		if (!derivesNodes(file)) continue;
		const rebuilt = await setRecordsInDdOntology({
			sectionTipo: file.sectionTipo,
			wholeSection: true,
			userId,
		});
		result.messages.push(rebuilt.msg);
		if (rebuilt.ok !== true) result.errors.push(...rebuilt.errors);
	}
	return result;
}

/** Client options (PHP $options): the selected server + the built file list. */
export const updateOntologyOptionsSchema = z.object({
	server: z.object({ name: z.string(), url: z.string().url(), code: z.string() }),
	files: z
		.array(
			z.object({
				tld: z.string().regex(/^(?:[a-z]{2,}|matrix_dd)$/),
				section_tipo: z
					.string()
					.regex(/^[a-zA-Z0-9_]+$/)
					.optional(),
				url: z.string().url(),
				typology_id: z.union([z.number(), z.string()]).nullish(),
				name_data: z.unknown().nullish(),
				// The manifest's declared dependencies ({tld, main, mandatory} objects),
				// forwarded verbatim (absent = not declared); normalized by the stager,
				// persisted on the registry record (hierarchy60).
				dependencies: z.unknown().optional(),
			}),
		)
		.min(1)
		.max(MAX_MANIFEST_FILES),
	info: z.unknown().nullish(),
});
export type UpdateOntologyOptions = z.infer<typeof updateOntologyOptionsSchema>;

/**
 * Single-flight latch — two concurrent runs must never interleave DELETEs. ONE
 * flag for every door that imports ontology files (the update panel and the
 * installer): claimed and released through the two functions below.
 */
let updateInFlight = false;

/** Claim the ontology-import latch: false when an import is already running. */
export function claimOntologyImportLatch(): boolean {
	if (updateInFlight) return false;
	updateInFlight = true;
	return true;
}

/** Release the ontology-import latch (always — in the claimer's `finally`). */
export function releaseOntologyImportLatch(): void {
	updateInFlight = false;
}

/**
 * PHP hierarchy::save_simple_schema_file — additions-only diff of the section
 * schema, written under <private>/backups/ontology/changes/. Only a
 * FILESYSTEM failure fails (the diff itself always succeeds, PHP parity).
 */
export function saveSimpleSchemaFile(
	oldSchema: Record<string, string[]>,
	newSchema: Record<string, string[]>,
	dirPath: string = join(privateDir, 'backups', 'ontology', 'changes'),
): { ok: boolean; msg: string; errors: string[]; filepath?: string } {
	const changes: { tipo: string; children_added: string[] }[] = [];
	for (const [tipo, children] of Object.entries(newSchema)) {
		const before = new Set(oldSchema[tipo] ?? []);
		const added = children.filter((child) => !before.has(child));
		if (added.length > 0) changes.push({ tipo, children_added: added });
	}
	const stamp = new Date().toISOString().slice(0, 19).replace('T', '_').replaceAll(':', '-');
	const name = `simple_schema_changes_${stamp}.json`;
	try {
		mkdirSync(dirPath, { recursive: true, mode: 0o750 });
	} catch {
		return {
			ok: false,
			msg: `Error on read or create directory. Permission denied (${dirPath})`,
			errors: [`unable to create ${dirPath}`],
		};
	}
	const filepath = join(dirPath, name);
	try {
		writeFileSync(filepath, JSON.stringify(changes));
	} catch {
		return {
			ok: false,
			msg: `Error on read or create file of simple schema changes. Permission denied (${filepath})`,
			errors: [`unable to write ${filepath}`],
		};
	}
	return { ok: true, msg: 'OK. Request successfully processed', errors: [], filepath };
}

/** Snapshot one table's rows (whole or tipo-scoped) to a plain `.copy` file. */
export async function snapshotTableRows(
	table: 'matrix_ontology' | 'matrix_dd',
	sectionTipo: string | null,
	outFile: string,
	conn: DbConnDescriptor,
): Promise<boolean> {
	// psql performs NO variable interpolation inside \copy arguments (documented,
	// all versions), so the tipo is validated and inlined directly — mirroring
	// data_io.ts exportToFile. A `:'tipo'` here reaches the server literally and
	// fails with "syntax error at or near :".
	if (sectionTipo !== null && !isSafeSectionTipo(sectionTipo)) return false;
	const columns = MATRIX_COPY_COLUMNS.map((column) => `"${column}"`).join(',');
	const where = sectionTipo === null ? '' : ` WHERE section_tipo = '${sectionTipo}'`;
	const copy = `\\copy (SELECT ${columns} FROM "${table}"${where} ORDER BY section_id ASC) TO '${outFile}'`;
	const run = await runPsql(conn, ['-v', 'ON_ERROR_STOP=1', '-c', copy]);
	return run.exitCode === 0;
}

/** REINDEX + VACUUM ANALYZE each table (PHP db_tasks::optimize_tables). Non-fatal. */
async function optimizeTables(
	tables: readonly string[],
	conn: DbConnDescriptor,
): Promise<string[]> {
	const errors: string[] = [];
	for (const table of tables) {
		if (!/^[a-zA-Z0-9_.]+$/.test(table)) continue;
		const reindex = await runPsql(conn, ['-c', `REINDEX TABLE CONCURRENTLY ${table};`]);
		if (reindex.exitCode !== 0) errors.push(`REINDEX ${table}: ${reindex.stderr.trim()}`);
		const vacuum = await runPsql(conn, ['-c', `VACUUM ANALYZE ${table};`]);
		if (vacuum.exitCode !== 0) errors.push(`VACUUM ${table}: ${vacuum.stderr.trim()}`);
	}
	return errors;
}

/**
 * The injectable edges of the pipeline. Every field defaults to exactly what
 * the production call used before the seam existed, so the shipped path is the
 * one the gate drives — no test-only flag changes what an operator runs.
 *
 * `catalog` is the load-bearing one: the target catalog comes from
 * `config.ontologyIo`, which is env-shaped (`ONTOLOGY_SERVERS` /
 * `IS_AN_ONTOLOGY_SERVER`) and therefore DIFFERENT on every machine. Without
 * it a gate takes a different branch on a developer box than on a CI clone.
 */
export interface UpdateOntologyDeps {
	/** psql seam for the snapshot/COPY steps; defaults to the configured DB. */
	conn?: DbConnDescriptor;
	/** Ontology-server catalog the target is re-resolved against (WC-023 D5). */
	catalog?: OntologyUpdateCatalog;
	/** Base dir the versioned IO dir (staging + recovery) is created under. */
	ioBaseDir?: string;
	/** Directory the operator-facing schema-changes artifact is written to. */
	changesDir?: string;
}

/**
 * Fill the injectable edges with their production defaults. Kept OUT of
 * `updateOntology` so the seam adds no branches to an already-baselined
 * function (the crap ratchet is a shrink-only contract).
 */
function resolveUpdateDeps(deps: UpdateOntologyDeps): {
	conn: DbConnDescriptor;
	catalog: OntologyUpdateCatalog;
} {
	return { conn: deps.conn ?? connFromConfig(), catalog: deps.catalog ?? config.ontologyIo };
}

/**
 * VALIDATE the dd_ontology identifier-grammar constraints that are clean and
 * report what is not (SURF-1): at most ONE line naming the violating-row count,
 * the first 10 `tipo:rule`, and the repair. A failure of the validation itself
 * is reported the same way — the ontology update it follows has already landed.
 */
async function identifierGrammarLines(): Promise<string[]> {
	try {
		const outcome = await validateDdOntologyIdentifierConstraints();
		if (outcome.violators.length === 0) return [];
		const named = outcome.violators
			.slice(0, 10)
			.flatMap((row) =>
				row.violations.map((v) => `${JSON.stringify(row.tipo).slice(0, 64)}:${v.column}`),
			)
			.join(', ');
		return [
			`dd_ontology: ${outcome.violators.length} row(s) break the identifier grammar (${named}) — their CHECK constraints stay NOT VALID; run reconcile ontology_identifiers`,
		];
	} catch (error) {
		// Best-effort tail step (the update already landed): the failure goes to the
		// log; the operator line is a deliberate sentence, never the raw text (SEC-18).
		console.error('[ontology_update] identifier-grammar validation failed', error);
		return [
			'dd_ontology identifier-grammar validation failed (see the server log) — run reconcile ontology_identifiers',
		];
	}
}

/**
 * The full update pipeline. `userId` stamps the TM-audited registry writes.
 * `deps.conn` is the psql seam for the COPY steps (tests); the dd_ontology
 * rebuild always runs on the configured pool.
 */
export async function updateOntology(
	rawOptions: unknown,
	userId: number,
	deps: UpdateOntologyDeps = {},
): Promise<OntologyIoResponse> {
	const { conn, catalog } = resolveUpdateDeps(deps);
	const response: OntologyIoResponse = {
		ok: false,
		msg: 'Error. Request failed [update_ontology::update_ontology]',
		errors: [],
	};
	assertTlsVerificationOn();
	if (!engineOwnsInstall()) {
		response.errors.push('engine does not own the install');
		return response;
	}
	const parsed = updateOntologyOptionsSchema.safeParse(rawOptions);
	if (!parsed.success) {
		response.errors.push(
			`invalid options: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`,
		);
		return response;
	}
	const options = parsed.data;

	// The network target comes from the CONFIG catalog, never the client
	// (WC-023 D5): match the selected server by url origin, or the localhost
	// pseudo-server when this instance is an ontology master.
	const target = resolveUpdateTarget(options.server, catalog);
	if ('error' in target) {
		response.errors.push(target.error);
		response.msg = target.msg;
		return response;
	}

	if (!claimOntologyImportLatch()) {
		response.errors.push('an ontology update is already running');
		response.msg = 'Error. An ontology update is already running';
		return response;
	}

	const ioPath = setOntologyIoPath(deps.ioBaseDir);
	if (ioPath === false) {
		releaseOntologyImportLatch();
		response.errors.push('unable to resolve the ontology IO directory');
		return response;
	}
	const stagingDir = join(ioPath, '.staging');
	const recoveryDir = join(ioPath, 'recovery', String(Date.now()));
	const messages: string[] = [];
	const mutated: StagedFile[] = [];
	// TLDs whose registry record + dd_ontology root node were provisioned before
	// their import (defect D7): those writes are NOT covered by the Phase-B
	// snapshots, so a restore cannot undo them.
	const provisioned: string[] = [];

	try {
		// ------------------------------------------------------------------
		// Phase A — stage EVERYTHING (non-destructive, fully abortable)
		// ------------------------------------------------------------------
		rmSync(stagingDir, { recursive: true, force: true });
		mkdirSync(stagingDir, { recursive: true });
		const staging = await stageOntologyFiles(options.files, target, { ioPath, stagingDir });
		if ('errors' in staging) {
			response.errors.push(...staging.errors);
			if (staging.msg !== undefined) response.msg = staging.msg;
			return response;
		}
		const staged = staging.staged;
		messages.push(...staging.messages);

		// Pre-import schema for the operator-facing changes artifact. Captured
		// HERE — after every refusal gate, before the shared layer's Phase B and
		// its first destructive statement — not after the import as PHP did
		// (defect D8, fixed 2026-08-09; see the wire-contract entry
		// WC-2026-08-09-simple-schema-changes-pre-import). PHP read it after the
		// import and before optimize_tables, and since the read is uncached the
		// two sides were always identical: the artifact was permanently `[]`.
		const oldSchema = await getSimpleSchemaOfSections();

		// Phases B + C + the dd_ontology re-derive: the SHARED LOWER LAYER (the
		// installer's ontology door drives the same function).
		const imported = await importStagedOntologyFiles(staged, { conn, userId, recoveryDir });
		mutated.push(...imported.mutated);
		provisioned.push(...imported.provisioned);
		messages.push(...imported.messages);
		response.errors.push(...imported.errors);
		if (!imported.completed) {
			if (imported.msg !== null) response.msg = imported.msg;
			return response;
		}

		// Declared dependencies this server lacks: REPORT ONLY, never installed
		// (WC-2026-10-10-ontology-dependencies-hierarchy60). Here, not in the
		// shared layer: the installer fails on ANY error, and it resolves the
		// closure itself before importing.
		await reportUpdateDependencies(staged, response, messages);

		// SURF-1: the re-derive above never projects a non-grammar identifier, so
		// an update is where a legacy install's NOT VALID grammar constraints turn
		// VALID. Rows still breaking a rule keep theirs NOT VALID and are REPORTED
		// (never a failed update — owner decision 2026-09-30); the operator repairs
		// them with the reconcile.
		response.errors.push(...(await identifierGrammarLines()));

		const optimizeErrors = await optimizeTables(OPTIMIZE_TABLES, conn);
		response.errors.push(...optimizeErrors);

		// TS analog of the PHP session wipe + dd_cache purge: the in-process
		// ontology-derived caches. (UI labels are repo catalogs since WC-033 —
		// the imported model='label' rows are inert for the TS engine.) The shared
		// layer already purged once after its re-derive; this purge keeps the
		// update's post-optimize order unchanged.
		await clearOntologyDerivedCaches();

		// schema-changes file — the ONE hard-fail tail step (PHP parity)
		const newSchema = await getSimpleSchemaOfSections();
		const schemaSaved = saveSimpleSchemaFile(oldSchema, newSchema, deps.changesDir);
		if (!schemaSaved.ok) {
			response.ok = false;
			response.msg = `Error saving simple_schema_file: ${schemaSaved.msg}`;
			response.errors.push(...schemaSaved.errors);
			return response;
		}
		messages.push(
			`OK. Saved a new simple schema changes file: ${basename(schemaSaved.filepath as string)}`,
		);

		// root_info read-back (dd1 term + properties)
		const rootRow = await readDdOntologyRow(DEDALO_ROOT_TIPO);
		const rootTerm = await termByTipo(DEDALO_ROOT_TIPO, config.lang.structureLang);
		response.root_info = {
			term: rootTerm,
			properties: (rootRow as { properties?: unknown } | null)?.properties ?? null,
		};

		response.ok = true;
		response.msg = `${response.errors.length === 0 ? 'OK. Request done successfully' : 'Warning! Request done with errors'} ${messages.join('\n')}`;
		return response;
	} catch (error) {
		const restored = await restoreAfterThrow(
			error,
			{ mutated, provisioned, errors: response.errors },
			{ conn, recoveryDir },
		);
		if (restored !== null) response.msg = restored;
		return response;
	} finally {
		rmSync(stagingDir, { recursive: true, force: true });
		releaseOntologyImportLatch();
	}
}

// ---------------------------------------------------------------------------
// THE SHARED LOWER LAYER — Phases B + C + the dd_ontology re-derive
// ---------------------------------------------------------------------------

/** The edges the shared layer needs: the psql seam, the auditing user, where snapshots go. */
export interface StagedImportContext {
	conn: DbConnDescriptor;
	userId: number;
	recoveryDir: string;
}

/**
 * The shared layer's outcome. `completed: false` = it refused or restored (`msg`
 * is the operator line, or null to keep the caller's own). `completed: true` may still carry
 * `errors` (a counter consolidation or a re-derive that failed — never fatal for
 * the update panel; the installer treats ANY error as a failed install).
 */
export interface StagedImportResult {
	completed: boolean;
	msg: string | null;
	messages: string[];
	errors: string[];
	/** TLDs whose registry record + root node were provisioned (D7 — not snapshot-covered). */
	provisioned: string[];
	/** Files whose table slice this call replaced (what a later failure must restore). */
	mutated: StagedFile[];
}

/**
 * Import already-staged ontology files: Phase B (a recovery snapshot of every
 * slice it will replace), Phase C (per file: matrix_dd whole-table; otherwise
 * registry record + root node, scoped DELETE+COPY, ONT-TLD normalization,
 * counter consolidation — any failure auto-restores the slices already
 * replaced), then the dd_ontology re-derive per TLD in staged order and the
 * ontology cache purge. It never resolves a target, downloads, takes the latch
 * or runs the update panel's tail (grammar, optimize, schema file) — its
 * callers do: updateOntology (the maintenance panel) and the installer's
 * ontology door (src/core/install/ontology_install.ts). The caller holds the
 * single-flight latch (claimOntologyImportLatch) around the call.
 */
export async function importStagedOntologyFiles(
	staged: readonly StagedFile[],
	ctx: StagedImportContext,
): Promise<StagedImportResult> {
	const result: StagedImportResult = {
		completed: false,
		msg: null,
		messages: [],
		errors: [],
		provisioned: [],
		mutated: [],
	};
	try {
		// ------------------------------------------------------------------
		// Phase B — recovery snapshot BEFORE the first destructive statement
		// ------------------------------------------------------------------
		if (!(await snapshotStagedSlices(staged, ctx, result))) return result;
		// ------------------------------------------------------------------
		// Phase C — import (destructive; per-file txn; auto-restore on failure)
		// ------------------------------------------------------------------
		for (const file of staged) {
			if (!(await importStagedFile(file, ctx, result))) return result;
		}
		await deriveStagedNodes(staged, ctx.userId, result);
		await clearOntologyDerivedCaches();
		result.completed = true;
		return result;
	} catch (error) {
		result.msg = await restoreAfterThrow(error, result, ctx);
		return result;
	}
}

/**
 * A THROWN failure in the middle of an import (the shared layer's, or the update
 * panel's tail): its text joins the errors, and every slice already replaced is
 * restored from its snapshot. Answers the operator line, or null when nothing was
 * replaced (the caller keeps its own message). ONE home for both catch sites.
 */
async function restoreAfterThrow(
	error: unknown,
	progress: { mutated: readonly StagedFile[]; provisioned: readonly string[]; errors: string[] },
	ctx: { conn: DbConnDescriptor; recoveryDir: string },
): Promise<string | null> {
	progress.errors.push((error as Error).message);
	if (progress.mutated.length === 0) return null;
	await restoreSnapshots(progress.mutated, ctx.recoveryDir, ctx.conn, progress.errors);
	return restoreFailureMessage(progress.provisioned, progress.errors);
}

/** Phase B: one snapshot per staged slice; false (with the refusal set) when one cannot be taken. */
async function snapshotStagedSlices(
	staged: readonly StagedFile[],
	ctx: StagedImportContext,
	result: StagedImportResult,
): Promise<boolean> {
	mkdirSync(ctx.recoveryDir, { recursive: true });
	for (const file of staged) {
		const outFile = confinedPath(ctx.recoveryDir, `${file.tld}.copy`);
		if (outFile === null) {
			result.errors.push(`unconfined recovery path for ${file.tld}`);
			return false;
		}
		if (!(await snapshotStagedSlice(file, outFile, ctx.conn))) {
			result.errors.push(`recovery snapshot failed for ${file.tld}`);
			result.msg = 'Error. Recovery snapshot failed — database untouched';
			return false;
		}
	}
	return true;
}

function snapshotStagedSlice(
	file: StagedFile,
	outFile: string,
	conn: DbConnDescriptor,
): Promise<boolean> {
	return file.tld === 'matrix_dd'
		? snapshotTableRows('matrix_dd', null, outFile, conn)
		: snapshotTableRows('matrix_ontology', file.sectionTipo, outFile, conn);
}

/** Restore everything replaced so far (+ `file`) and set the failure line; always false. */
async function failImport(
	file: StagedFile,
	ctx: StagedImportContext,
	result: StagedImportResult,
	msg: string | null,
): Promise<false> {
	await restoreSnapshots(result.mutated.concat(file), ctx.recoveryDir, ctx.conn, result.errors);
	result.msg = msg ?? restoreFailureMessage(result.provisioned, result.errors);
	return false;
}

/**
 * Phase C for one file; false when it failed (and the replaced slices were
 * restored). An ontology package goes through importOntologyPackage — the ONE
 * per-package body (registry record + root node, scoped DELETE+COPY, ONT-TLD
 * normalization, counter consolidation) the seed compiler applies too.
 */
async function importStagedFile(
	file: StagedFile,
	ctx: StagedImportContext,
	result: StagedImportResult,
): Promise<boolean> {
	if (file.tld === 'matrix_dd') return importStagedPrivateLists(file, ctx, result);
	// D7: a TLD is `provisioned` the moment its registry record + root node
	// exist — BEFORE the row import, so a failure in the import still names it.
	const outcome = await importOntologyPackage(file, ctx.userId, ctx.conn, {
		onProvisioned: () => result.provisioned.push(file.tld),
	});
	result.messages.push(...outcome.messages);
	result.errors.push(...outcome.errors);
	if (outcome.fatal !== null) {
		return failImport(
			file,
			ctx,
			result,
			outcome.fatal === 'normalize'
				? 'Error. ONT-TLD normalization failed — previous state restored'
				: null,
		);
	}
	result.mutated.push(file);
	return true;
}

/** matrix_dd: whole-table private lists. */
async function importStagedPrivateLists(
	file: StagedFile,
	ctx: StagedImportContext,
	result: StagedImportResult,
): Promise<boolean> {
	const imported = await importFromCopyFile({
		filePath: file.stagedPath,
		matrixTable: 'matrix_dd',
		deleteTable: true,
		conn: ctx.conn,
	});
	result.messages.push(imported.msg);
	if (imported.ok !== true) {
		result.errors.push(...imported.errors);
		return failImport(file, ctx, result, null);
	}
	result.mutated.push(file);
	return true;
}

/**
 * The update's dependency report (dependency_report.ts): each updated TLD's
 * declared dependencies (as its registry row now holds them) checked against
 * this server. A MANDATORY missing one is a warning line in `errors` (the panel
 * renders them as import warnings — the update still succeeds); an OPTIONAL
 * one is a note in the import log. The structured list rides as the
 * `missing_dependencies` extension key ([] when nothing is missing).
 */
async function reportUpdateDependencies(
	staged: readonly StagedFile[],
	response: OntologyIoResponse,
	messages: string[],
): Promise<void> {
	const report = await reportMissingDependencies(
		staged.filter((file) => derivesNodes(file)).map((file) => file.tld),
	);
	response.errors.push(...report.invalid, ...report.warnings);
	messages.push(...report.notes);
	response.missing_dependencies = report.missing;
}

/** dd_ontology flat-index rebuild per imported TLD, in staged order (deriveOntologyPackages). */
async function deriveStagedNodes(
	staged: readonly StagedFile[],
	userId: number,
	result: StagedImportResult,
): Promise<void> {
	const derived = await deriveOntologyPackages(staged, userId);
	result.messages.push(...derived.messages);
	result.errors.push(...derived.errors);
}

/**
 * The message an import failure is allowed to make (defect D7, fixed
 * 2026-08-09 — WC-2026-08-09-ontology-update-partial-restore).
 *
 * The Phase-B snapshots cover matrix_ontology / matrix_dd ONLY. For every
 * non-`matrix_dd` TLD, Phase C provisions a `matrix_ontology_main` registry
 * record (syncMainSectionFromDefinition) and a `dd_ontology` root node (+ its ontologytype
 * grouper) BEFORE the row import, through raw matrix writes with no Time
 * Machine trail. restoreSnapshots cannot undo any of that, so claiming
 * "previous state restored" after a provisioned TLD is a FALSE statement about
 * the database — the actual defect. When nothing was provisioned the original
 * claim is true and its PHP bytes are kept verbatim.
 */
export function restoreFailureMessage(provisioned: readonly string[], errors: string[]): string {
	if (provisioned.length === 0) return 'Error. Import failed — previous state restored';
	errors.push(
		`registry record (matrix_ontology_main) and dd_ontology root node NOT reverted for: ${provisioned.join(', ')} — MANUAL REVIEW REQUIRED`,
	);
	return 'Error. Import failed — matrix rows restored; registry and dd_ontology state may be partial';
}

/** Restore every mutated table from the Phase-B snapshots (best-effort, loud). */
export async function restoreSnapshots(
	files: readonly StagedFile[],
	recoveryDir: string,
	conn: DbConnDescriptor,
	errors: string[],
): Promise<void> {
	for (const file of files) {
		const snapshot = confinedPath(recoveryDir, `${file.tld}.copy`);
		if (snapshot === null || !statSafe(snapshot)) {
			errors.push(`recovery snapshot missing for ${file.tld} — MANUAL RESTORE REQUIRED`);
			continue;
		}
		const restored = await importFromCopyFile(
			file.tld === 'matrix_dd'
				? { filePath: snapshot, matrixTable: 'matrix_dd', deleteTable: true, conn }
				: {
						filePath: snapshot,
						matrixTable: 'matrix_ontology',
						sectionTipo: file.sectionTipo,
						conn,
					},
		);
		if (restored.ok !== true) {
			errors.push(
				`RESTORE FAILED for ${file.tld}: ${restored.errors.join('; ')} — MANUAL RESTORE REQUIRED from ${snapshot}`,
			);
		}
	}
}

function statSafe(path: string): boolean {
	try {
		return statSync(path).size >= 0;
	} catch {
		return false;
	}
}
