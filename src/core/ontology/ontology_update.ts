/**
 * Ontology UPDATE orchestrator (UPDATE_PROCESS Phase 2) — the TS twin of PHP
 * widgets/update_ontology::update_ontology(). Options come from the
 * byte-identical client: `{server, files, info}` — the client fetched the
 * manifest to SHOW it and relays which TLDs (matrix_dd prepended); since
 * 2026-10-30 (U-08/U-41) the engine reads the master's manifest ITSELF,
 * refuses an ontology on another data model or source, and stages each file
 * as the MANIFEST describes it (ontology_update_source.ts) — then validates,
 * stages, and imports.
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
import { MATRIX_TABLE_ALLOWLIST } from '../db/matrix.ts';
import { MATRIX_COPY_COLUMNS } from '../db/matrix_write.ts';
import { DedaloError } from '../errors/index.ts';
import { connFromConfig, type DbConnDescriptor, runPsqlScript } from '../install/pg_exec.ts';
import { engineOwnsInstall } from '../update/ownership.ts';
import { clearOntologyDerivedCaches } from './cache_invalidation.ts';
import { isTestFixtureTld } from './core_tlds.ts';
import { isSafeSectionTipo, setOntologyIoPath } from './data_io.ts';
import {
	assertTlsVerificationOn,
	confinedPath,
	consolidateSectionCounter,
	countRecordsBySectionTipo,
	importFromCopyFile,
	MAX_MANIFEST_FILES,
	normalizeOntologyTld,
	type OntologyIoResponse,
	type StagedSliceChange,
	type StoredModelLocator,
	stagedOntologyDiff,
} from './data_io_import.ts';
import { reportMissingDependencies } from './dependency_report.ts';
import { ONTOLOGY_LABEL_FALLBACK_LANG, termByTipo } from './labels.ts';
import { modelNameOf } from './machine_name.ts';
import { importedMachineNameMessages } from './machine_name_reconcile.ts';
import {
	inspectOntology,
	type OntologyWriteResult,
	rebuildFailure,
	rebuildOntology,
	withOrderReconcileBatch,
} from './ontology_state.ts';
import { type OntologySourceDeps, resolveOntologySource } from './ontology_update_source.ts';
import {
	type OntologyUpdateCatalog,
	resolveUpdateTarget,
	type StagedFile,
	stageOntologyFiles,
} from './ontology_update_target.ts';
import {
	createDdOntologyRootNode,
	ensureReferencedGrouperRecords,
	isTypologyGrouperTld,
	syncMainSectionFromDefinition,
} from './ontology_write.ts';
import { getTermIdFromLocator } from './parser.ts';
import { getOrderedSubtree } from './resolver.ts';
import { LOCAL_ONTOLOGY_SECTION } from './tld.ts';
import { reportOntologyProgress } from './update_progress.ts';

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
	// Machine names (P3, WC-2026-11-04-ontology-machine-names): the LOSSLESS class
	// of the imported rows moves into the machine-name shape here — after the COPY
	// and the ONT-TLD rewrite, BEFORE the re-derive, no TM row (the package is the
	// history). Non-fatal and a no-op on an ontology without ontology43/44.
	outcome.messages.push(...(await importedMachineNameMessages(file.sectionTipo)));
	return outcome;
}

/**
 * The dd_ontology re-derive of every imported package that projects nodes (not
 * matrix_dd, not override records) — through the ONE whole-tld writer,
 * ontology_state.rebuildOntology (ONT-1, WC-2026-10-21-ontology-update-rebuild):
 * one transaction per tld, a node the package no longer carries is REMOVED (no
 * orphan), a record declaring another tld is refused and named, surviving nodes
 * keep their ids. `mainNode: 'existing'`: the registry is never written here
 * (importOntologyPackage's provisioning owns it; the seed compiler's rows-only
 * pass 1 has none, and keeps the `<tld>0` it holds).
 *
 * Severity (unchanged): every tld's message goes to `messages`; `errors` gets a
 * rolled-back rebuild, each misfiled record, and a tld of which NO record declares
 * a tld (wholesale failure) — a warning line in the update panel, fatal in the
 * installer and the seed compiler. Drift without errors stays a message: mid-run a
 * model may live in a tld not imported yet. A `model` column is converged twice
 * over: against the parse inside rebuildOntology (same tld), then by pass 2 below
 * (a model in another staged tld). One message per tld (its last derive).
 *
 * Pass 0 — a staged GROUPER package (ontologytype / hierarchytype / hierarchymtype) wiped
 * the installation-made grouper records its scoped import does not carry; every typology
 * still referenced is re-made BEFORE the sweep could delete its node
 * (ontology_write.ensureReferencedGrouperRecords), and named in `messages`.
 */
export async function deriveOntologyPackages(
	staged: readonly StagedFile[],
	userId: number,
): Promise<{ messages: string[]; errors: string[] }> {
	const regrouped = await ensureStagedGrouperRecords(staged, userId);
	const outcomes = new Map<string, OntologyWriteResult>();
	// ONE portal-order backfill after every tld and the model pass, never one per
	// tld against a half-applied ontology (ontology_state.ts withOrderReconcileBatch).
	await withOrderReconcileBatch(async () => {
		const deriving = staged.filter(derivesNodes);
		for (const [index, file] of deriving.entries()) {
			reportOntologyProgress('derive', index, deriving.length, file.tld);
			outcomes.set(file.tld, await rebuildOntology(file.tld, userId, { mainNode: 'existing' }));
		}
		if (outcomes.size > 1) await rederiveStaleModels(outcomes, userId);
	});
	const report = deriveReport(outcomes);
	report.messages.unshift(...regrouped);
	return report;
}

/** Pass 0 (see deriveOntologyPackages): one message per staged grouper tld that re-made records. */
async function ensureStagedGrouperRecords(
	staged: readonly StagedFile[],
	userId: number,
): Promise<string[]> {
	const messages: string[] = [];
	for (const file of staged.filter((item) => isTypologyGrouperTld(item.tld))) {
		const remade = await ensureReferencedGrouperRecords(file.tld, userId);
		if (remade.length > 0) {
			messages.push(
				`${file.tld}: re-made grouper record(s) ${remade.join(', ')} — referenced by this installation, absent from the package`,
			);
		}
	}
	return messages;
}

/**
 * Pass 2 — CROSS-PACKAGE MODELS. A node's `model` is its model node's term, read from the
 * stored row (a same-tld model resolves inside rebuildOntology). A tld derived BEFORE the tld
 * that adds or renames one of its models was parsed against the old row, so every tld that
 * committed in pass 1 is re-inspected AFTER all of them and re-derived when a `model` column
 * (or a machine-name column, STALE_NAME_COLUMNS) is stale — one pass reaches the fixpoint (no node's term depends on another node). A
 * rolled-back tld keeps its failure. Gate: ontology_derive_packages_native G1f.
 */
async function rederiveStaleModels(
	outcomes: Map<string, OntologyWriteResult>,
	userId: number,
): Promise<void> {
	for (const [tld, first] of outcomes) {
		if (first.applied.length === 0 || !(await hasStaleModel(tld))) continue;
		outcomes.set(tld, await rebuildOntology(tld, userId, { mainNode: 'existing' }));
	}
}

async function hasStaleModel(tld: string): Promise<boolean> {
	const { drift } = await inspectOntology(tld);
	return drift.some(
		(item) =>
			item.kind === 'stale' &&
			STALE_NAME_COLUMNS.some((column) => item.diffColumns.includes(column)),
	);
}

/**
 * The columns pass 2 converges: `model`, and the machine-name pair a model
 * definition carries (a dd model row has no model_tipo, so a `model` diff never
 * flags it — yet its machine_name is what every instance's `model` reads).
 */
const STALE_NAME_COLUMNS = ['model', 'machine_name', 'use_machine_name'] as const;

/** Every tld's last derive → the step messages and error lines (module doc: severity). */
function deriveReport(outcomes: ReadonlyMap<string, OntologyWriteResult>): {
	messages: string[];
	errors: string[];
} {
	const result = { messages: [] as string[], errors: [] as string[] };
	for (const [tld, rebuilt] of outcomes) {
		const failure = rebuildFailure(tld, rebuilt);
		result.messages.push(rebuilt.msg);
		result.errors.push(...rebuilt.errors, ...(failure === null ? [] : [failure]));
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
 * The core TLD pair an update always offers, whatever `ACTIVE_ONTOLOGY_TLDS`
 * says (the update panel unions it into its list — widgets/update_ontology.ts).
 */
export const CORE_UPDATE_TLDS: readonly string[] = ['ontology', 'ontologytype'];

/**
 * TLDs an update may NEVER touch, even when configured: the installation's own
 * local ontology (`localontology0`) is not a shared ontology (owner rule
 * 2026-10-29 — an update replaces shared TLDs only).
 */
const NEVER_UPDATED_TLDS: ReadonlySet<string> = new Set([LOCAL_ONTOLOGY_SECTION.slice(0, -1)]);

/**
 * U-52 — the SERVER-computed set of TLDs an ontology update may replace:
 * the configured active TLDs ∪ the core pair ∪ `matrix_dd` (the shared value
 * lists the ontology process owns), minus the never-updated local ontology.
 * The client's own filter is a convenience, never the boundary.
 */
export function admissibleUpdateTlds(activeTlds: readonly string[]): Set<string> {
	const admissible = new Set([...activeTlds, ...CORE_UPDATE_TLDS, 'matrix_dd']);
	for (const tld of NEVER_UPDATED_TLDS) admissible.delete(tld);
	// the suite's fixture TLD never reaches an installation (core_tlds.ts)
	for (const tld of admissible) if (isTestFixtureTld(tld)) admissible.delete(tld);
	return admissible;
}

/**
 * Refuse the WHOLE update (`update.refused`, nothing staged) when any requested
 * file names a TLD the update may not replace. UNATTENDED: outside
 * {@link admissibleUpdateTlds} — a run nobody watches replaces only what this
 * installation tracks. OPERATOR-PICKED (`picked`, the panel: the operator chose
 * a master and its TLDs, confirmed): any shared TLD, so a TLD outside
 * ACTIVE_ONTOLOGY_TLDS can be pulled on purpose — never the installation's own
 * local ontology, never the suite's fixture TLD. Names every offending TLD.
 * Sits on the UPDATE door only — the installer drives the shared lower layer
 * (`importStagedOntologyFiles`) with its own resolved plan.
 */
export function assertUpdateTldScope(
	files: readonly { readonly tld: string }[],
	activeTlds: readonly string[],
	picked = false,
): void {
	const admissible = admissibleUpdateTlds(activeTlds);
	const allowed = (tld: string) =>
		picked
			? tld === 'matrix_dd' || (!NEVER_UPDATED_TLDS.has(tld) && !isTestFixtureTld(tld))
			: admissible.has(tld);
	const offending = [...new Set(files.map((file) => file.tld))].filter((tld) => !allowed(tld));
	if (offending.length === 0) return;
	const sentence = picked
		? `Error. Ontology update refused: TLD(s) an update never replaces (the local ontology overrides, or the test suite's fixture): ${offending.join(', ')}`
		: `Error. Ontology update refused: TLD(s) outside the active ontology set (ACTIVE_ONTOLOGY_TLDS): ${offending.join(', ')}`;
	throw new DedaloError('update.refused', {
		message: sentence,
		publicMessage: sentence,
		coordinates: { tlds: offending.join(',') },
	});
}

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
	const run = await runPsqlScript(conn, copy);
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
		const reindex = await runPsqlScript(conn, `REINDEX TABLE CONCURRENTLY ${table};`);
		if (reindex.exitCode !== 0) errors.push(`REINDEX ${table}: ${reindex.stderr.trim()}`);
		const vacuum = await runPsqlScript(conn, `VACUUM ANALYZE ${table};`);
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
export interface UpdateOntologyDeps extends OntologySourceDeps {
	/** psql seam for the snapshot/COPY steps; defaults to the configured DB. */
	conn?: DbConnDescriptor;
	/** Ontology-server catalog the target is re-resolved against (WC-023 D5). */
	catalog?: OntologyUpdateCatalog;
	/** Base dir the versioned IO dir (staging + recovery) is created under. */
	ioBaseDir?: string;
	/** Directory the operator-facing schema-changes artifact is written to. */
	changesDir?: string;
	/**
	 * The configured active TLDs the request is scoped against (U-52);
	 * defaults to `config.ontologyIo.activeOntologyTlds` — env-shaped like
	 * `catalog`, so a gate injects it to take the same branch on every machine.
	 */
	activeTlds?: readonly string[];
}

/**
 * Fill the injectable edges with their production defaults. Kept OUT of
 * `updateOntology` so the seam adds no branches to an already-baselined
 * function (the crap ratchet is a shrink-only contract).
 */
function resolveUpdateDeps(deps: UpdateOntologyDeps): {
	conn: DbConnDescriptor;
	catalog: OntologyUpdateCatalog;
	activeTlds: readonly string[];
} {
	return {
		conn: deps.conn ?? connFromConfig(),
		catalog: deps.catalog ?? config.ontologyIo,
		activeTlds: deps.activeTlds ?? config.ontologyIo.activeOntologyTlds,
	};
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
	const { conn, catalog, activeTlds } = resolveUpdateDeps(deps);
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

	// U-52: the TLD scope is decided HERE, server-side — before the latch, the
	// io dir and any staging. Throws `update.refused` naming the offenders.
	assertUpdateTldScope(options.files, activeTlds, deps.operatorPicked === true);
	// U-08 / U-41: the server reads the master's manifest itself, refuses an
	// ontology on another data model, and takes each file from the MANIFEST
	// (URL, names, dependencies) — the browser only relays which TLDs.
	const files = await resolveOntologySource(options.files, target, catalog, deps);

	if (!claimOntologyImportLatch()) {
		response.errors.push('an ontology update is already running');
		response.msg = 'Error. An ontology update is already running';
		return response;
	}

	const ioPath = setOntologyIoPath(deps.ioBaseDir);
	if (typeof ioPath !== 'string') {
		releaseOntologyImportLatch();
		response.errors.push(ioPath.error);
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
	// Set once the shared layer reports the import COMPLETED: from then on the
	// matrix rows and the dd_ontology derived from them agree, and a tail
	// failure must never roll the rows back under it (restoreAfterThrow).
	let landed = false;

	try {
		// ------------------------------------------------------------------
		// Phase A — stage EVERYTHING (non-destructive, fully abortable)
		// ------------------------------------------------------------------
		rmSync(stagingDir, { recursive: true, force: true });
		mkdirSync(stagingDir, { recursive: true });
		const staging = await stageOntologyFiles(files, target, { ioPath, stagingDir });
		if ('errors' in staging) {
			response.errors.push(...staging.errors);
			if (staging.msg !== undefined) response.msg = staging.msg;
			return response;
		}
		const staged = staging.staged;
		messages.push(...staging.messages);

		// U-14: what this package is about to remove / re-model, measured against
		// the rows still in place (before Phase B). Report only (D-6) — rides the
		// response (`census`) on success AND failure; never refuses.
		const census = await censusStagedPackages(staged, conn);
		response.census = census.census;
		messages.push(...census.lines);

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
		landed = true;
		reportOntologyProgress('finish', 0, 1);

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
		const rootTerm = await termByTipo(DEDALO_ROOT_TIPO, ONTOLOGY_LABEL_FALLBACK_LANG);
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
			{ mutated, provisioned, errors: response.errors, landed },
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
// U-14 — THE IMPORT CENSUS (report only — D-6: report, never refuse)
// ---------------------------------------------------------------------------

/** A node of `<tld>0` the package no longer carries. `records`: see OntologyImportCensus. */
export interface CensusRemovedNode {
	tipo: string;
	model: string | null;
	records?: number | null;
}

/** A node the package keeps under ANOTHER model. `records`: see OntologyImportCensus. */
export interface CensusRemodelledNode {
	tipo: string;
	from: string | null;
	to: string | null;
	records?: number | null;
}

/**
 * The census of one staged TLD, taken after staging and before Phase B/C: what
 * the import is about to REMOVE from `<tld>0` and what it RE-MODELS (same tipo,
 * another ontology6 model). A model is its model node's machine name, read the
 * way the parser reads it (ontology6 locator → getTermIdFromLocator →
 * dd_ontology machine_name, machine_name.ts modelNameOf) — or the model TIPO when that node is not in dd_ontology
 * yet (a model the same update introduces), null when no model is stated.
 * Overrides (localontology0) are not applied: the census compares the canonical
 * rows the import replaces. `records` is set only when the node's CURRENT model
 * is `section`: how many records are stored under that tipo across the matrix
 * record tables (null = the count failed). Response key `census` — one entry
 * per node-deriving staged TLD, findings or not.
 */
export interface OntologyImportCensus {
	tld: string;
	removed: CensusRemovedNode[];
	remodelled: CensusRemodelledNode[];
}

/**
 * The census of every node-deriving staged TLD + one message line per TLD with
 * findings (or whose census could not be read). Read-only; it never fails an
 * update — one read-only psql round trip per TLD (data_io_import.stagedOntologyDiff),
 * plus one count per TLD that drops or re-models a section.
 */
export async function censusStagedPackages(
	staged: readonly StagedFile[],
	conn: DbConnDescriptor,
): Promise<{ census: OntologyImportCensus[]; lines: string[] }> {
	const report = { census: [] as OntologyImportCensus[], lines: [] as string[] };
	for (const file of staged.filter(derivesNodes)) {
		const entry = await censusPackage(file, conn);
		if (entry === null) {
			report.lines.push(
				`${file.tld}: import census unavailable (its read-only diff failed) — the import proceeds`,
			);
			continue;
		}
		report.census.push(entry);
		const line = censusLine(entry);
		if (line !== null) report.lines.push(line);
	}
	return report;
}

async function censusPackage(
	file: StagedFile,
	conn: DbConnDescriptor,
): Promise<OntologyImportCensus | null> {
	const changes = await stagedOntologyDiff(file.sectionTipo, file.stagedPath, conn);
	if (changes === null) return null;
	const entry: OntologyImportCensus = { tld: file.tld, removed: [], remodelled: [] };
	for (const change of changes) await addCensusChange(entry, change);
	await attachSectionRecordCounts(entry, conn);
	return entry;
}

async function addCensusChange(
	entry: OntologyImportCensus,
	change: StagedSliceChange,
): Promise<void> {
	const tipo = `${entry.tld}${change.sectionId}`;
	const from = await censusModel(change.from);
	if (change.kind === 'removed') {
		entry.removed.push({ tipo, model: from });
		return;
	}
	const to = await censusModel(change.to);
	// two different locators naming the same model are not a re-model
	if (from !== to) entry.remodelled.push({ tipo, from, to });
}

/** A stored ontology6 locator → its model (OntologyImportCensus: the parser's reading). */
async function censusModel(locator: StoredModelLocator): Promise<string | null> {
	if (locator === null || typeof locator !== 'object') return null;
	const modelTipo = await getTermIdFromLocator(
		locator as Parameters<typeof getTermIdFromLocator>[0],
	);
	if (modelTipo === null) return null;
	// The model node's machine name — the parser's reading (machine_name.ts
	// modelNameOf, incl. its bridge rung for a model row not yet derived).
	return modelNameOf(await readDdOntologyRow(modelTipo)).model ?? modelTipo;
}

/** `records` on every removed / re-modelled node whose current model is `section`. */
async function attachSectionRecordCounts(
	entry: OntologyImportCensus,
	conn: DbConnDescriptor,
): Promise<void> {
	const sections: { tipo: string; records?: number | null }[] = [
		...entry.removed.filter((node) => node.model === 'section'),
		...entry.remodelled.filter((node) => node.from === 'section'),
	];
	if (sections.length === 0) return;
	const counts = await countRecordsBySectionTipo(
		sections.map((node) => node.tipo),
		MATRIX_TABLE_ALLOWLIST,
		conn,
	);
	for (const node of sections)
		node.records = counts === null ? null : Number(counts[node.tipo] ?? 0);
}

/** First ten items, then `…+N`. */
function censusList(items: readonly string[]): string {
	const head = items.slice(0, 10).join(', ');
	return items.length > 10 ? `${head}, …+${items.length - 10}` : head;
}

/** The operator line of one TLD's census; null when it found nothing. */
function censusLine(entry: OntologyImportCensus): string | null {
	const parts: string[] = [];
	if (entry.removed.length > 0) {
		parts.push(
			`${entry.removed.length} node(s) removed (${censusList(entry.removed.map((n) => n.tipo))})`,
		);
	}
	if (entry.remodelled.length > 0) {
		const named = entry.remodelled.map((n) => `${n.tipo} ${n.from ?? '?'} → ${n.to ?? '?'}`);
		parts.push(`${entry.remodelled.length} node(s) re-modelled (${censusList(named)})`);
	}
	if (parts.length === 0) return null;
	return `${entry.tld}: import census — ${parts.join('; ')}${censusRecordsTail(entry)} (report only — the import proceeds)`;
}

/** The records clause of a census line: stored records under dropped / re-modelled sections. */
function censusRecordsTail(entry: OntologyImportCensus): string {
	const counted = [...entry.removed, ...entry.remodelled].filter((n) => n.records !== undefined);
	if (counted.some((n) => n.records === null)) {
		return '; record count of the affected section(s) unavailable';
	}
	const total = counted.reduce((sum, n) => sum + (n.records ?? 0), 0);
	return total > 0 ? `; ${total} record(s) are stored under the affected section(s)` : '';
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
 * ontology cache purge. The import is `completed` (LANDED) once Phase C has
 * committed every slice: a failure of the re-derive after that — rolled back or
 * thrown — is an error line naming the tlds to rebuild, never a restore of the old
 * rows under a tld already re-derived (gate: ontology_update_derive_throw_native).
 * It never resolves a target, downloads, takes the latch
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
		for (const [index, file] of staged.entries()) {
			reportOntologyProgress('import', index, staged.length, file.tld);
			if (!(await importStagedFile(file, ctx, result))) return result;
		}
		// THE IMPORT LANDED (cross-write:r3): every slice is the update's, committed.
		// The re-derive below is one COMMITTED transaction per tld, so from its first
		// commit on a restore would put the OLD rows back under a dd_ontology derived
		// from the NEW ones. `completed` is therefore set HERE, and a derive throw is
		// the landed import's reported failure (deriveLandedImport), never a restore.
		result.completed = true;
		await deriveLandedImport(staged, ctx.userId, result);
		return result;
	} catch (error) {
		result.msg = await restoreAfterThrow(
			error,
			{
				mutated: result.mutated,
				provisioned: result.provisioned,
				errors: result.errors,
				landed: result.completed,
			},
			ctx,
		);
		return result;
	}
}

/**
 * A THROWN failure in the middle of an import (the shared layer's, or the update
 * panel's tail): its text joins the errors, and every slice already replaced is
 * restored from its snapshot. Answers the operator line, or null when nothing was
 * replaced (the caller keeps its own message). ONE home for both catch sites.
 * A throw AFTER the import landed (`landed`) restores nothing (cross-write:r2).
 */
export async function restoreAfterThrow(
	error: unknown,
	progress: {
		mutated: readonly StagedFile[];
		provisioned: readonly string[];
		errors: string[];
		/** The import COMPLETED before the throw (a tail step failed). */
		landed: boolean;
	},
	ctx: { conn: DbConnDescriptor; recoveryDir: string },
): Promise<string | null> {
	if (progress.landed) {
		// The update LANDED: its rows and the dd_ontology re-derived from them
		// agree. Restoring the snapshots now would put the OLD rows back under the
		// NEW dd_ontology — a state neither version was ever in. The tail failure
		// is reported (a deliberate sentence; the raw text to the log — SEC-18),
		// nothing is rolled back.
		console.error('[ontology_update] a step after the landed import failed', error);
		progress.errors.push(
			'the ontology update landed; a final step failed (see the server log) — nothing was rolled back',
		);
		return 'Error. The ontology update landed, but a final step failed (see the server log)';
	}
	progress.errors.push((error as Error).message);
	if (progress.mutated.length === 0) return null;
	const complete = await restoreSnapshots(
		progress.mutated,
		ctx.recoveryDir,
		ctx.conn,
		progress.errors,
	);
	return restoreFailureMessage(progress.provisioned, progress.errors, complete);
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

/**
 * Restore everything replaced so far (+ `file`) and set the failure line; always
 * false. The line is restoreFailureMessage's, whatever failed: the cause (a COPY
 * error, `ontology7 normalization failed for …`) is already an `errors` line, and
 * only that function may say what the restore achieved (U-17 — a provisioned TLD
 * is "partial", an incomplete restore says so, never "restored").
 */
async function failImport(
	file: StagedFile,
	ctx: StagedImportContext,
	result: StagedImportResult,
): Promise<false> {
	const complete = await restoreSnapshots(
		result.mutated.concat(file),
		ctx.recoveryDir,
		ctx.conn,
		result.errors,
	);
	result.msg = restoreFailureMessage(result.provisioned, result.errors, complete);
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
	if (outcome.fatal !== null) return failImport(file, ctx, result);
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
		return failImport(file, ctx, result);
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
 * The re-derive of a LANDED import (Phase C committed every slice). A tld whose
 * rebuild rolls back is already an error line of the derive; a THROW escaping it
 * (a read failing after a tld committed — the inspect in rebuildOntology's catch
 * or after its commit, pass 2's inspect) is reported the same way: the rows stand,
 * the operator line names every node-deriving tld of the update to rebuild
 * (ontology_state rebuildOntology converges each one, an already-derived tld
 * included), the raw text goes to the log (SEC-18). The derived caches are purged
 * either way — some tlds may have committed.
 */
async function deriveLandedImport(
	staged: readonly StagedFile[],
	userId: number,
	result: StagedImportResult,
): Promise<void> {
	try {
		await deriveStagedNodes(staged, userId, result);
	} catch (error) {
		console.error('[ontology_update] the re-derive of a landed import failed', error);
		const tlds = staged.filter(derivesNodes).map((file) => file.tld);
		result.errors.push(
			`the ontology rows of this update were imported; re-deriving dd_ontology from them failed (see the server log) — rebuild the ontology of: ${tlds.join(', ')}`,
		);
	} finally {
		await clearOntologyDerivedCaches();
	}
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
 *
 * U-17 (2026-10-30): "matrix rows restored" is now TRUE for a TLD that was
 * EMPTY before the import — restoreSnapshots replays an empty snapshot as an
 * empty slice (the scoped DELETE runs; it used to be skipped, defect D9). And a
 * restore that did NOT complete (`restoreComplete` false: a snapshot missing or
 * its replay failed — each named in `errors`) never claims anything was
 * restored: the line says the restore is INCOMPLETE. The provisioned registry
 * record + root node stay the "partial" case — never "restored".
 */
export function restoreFailureMessage(
	provisioned: readonly string[],
	errors: string[],
	restoreComplete = true,
): string {
	if (provisioned.length > 0) {
		errors.push(
			`registry record (matrix_ontology_main) and dd_ontology root node NOT reverted for: ${provisioned.join(', ')} — MANUAL REVIEW REQUIRED`,
		);
	}
	if (!restoreComplete) {
		return 'Error. Import failed — the restore is INCOMPLETE (see errors); the database state is partial';
	}
	if (provisioned.length === 0) return 'Error. Import failed — previous state restored';
	return 'Error. Import failed — matrix rows restored; registry and dd_ontology state may be partial';
}

/**
 * Restore every mutated table from the Phase-B snapshots (best-effort, loud).
 * A snapshot is what the slice WAS, so an EMPTY one restores an empty slice
 * (`emptyFile: 'empty_slice'` — the scoped DELETE runs; U-17). True when every
 * file was restored; each failure is a named `errors` line.
 */
export async function restoreSnapshots(
	files: readonly StagedFile[],
	recoveryDir: string,
	conn: DbConnDescriptor,
	errors: string[],
): Promise<boolean> {
	let complete = true;
	for (const file of files) {
		const snapshot = confinedPath(recoveryDir, `${file.tld}.copy`);
		if (snapshot === null || !statSafe(snapshot)) {
			errors.push(`recovery snapshot missing for ${file.tld} — MANUAL RESTORE REQUIRED`);
			complete = false;
			continue;
		}
		const restored = await importFromCopyFile(
			file.tld === 'matrix_dd'
				? {
						filePath: snapshot,
						matrixTable: 'matrix_dd',
						deleteTable: true,
						emptyFile: 'empty_slice',
						conn,
					}
				: {
						filePath: snapshot,
						matrixTable: 'matrix_ontology',
						sectionTipo: file.sectionTipo,
						emptyFile: 'empty_slice',
						conn,
					},
		);
		if (restored.ok !== true) {
			errors.push(
				`RESTORE FAILED for ${file.tld}: ${restored.errors.join('; ')} — MANUAL RESTORE REQUIRED from ${snapshot}`,
			);
			complete = false;
		}
	}
	return complete;
}

function statSafe(path: string): boolean {
	try {
		return statSync(path).size >= 0;
	} catch {
		return false;
	}
}
