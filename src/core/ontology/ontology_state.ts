/**
 * ONTOLOGY STATE — the single source of truth for "is a TLD's runtime ontology
 * consistent with its source?", and the single writer that makes it so.
 *
 * WHY THIS EXISTS. `dd_ontology` is a DERIVED runtime projection of the editable
 * `matrix_ontology` records: one node per matrix record, produced by
 * `parseSectionRecordToOntologyNode`. The invariant is therefore a RECONCILIATION,
 * not a fixed checklist —
 *
 *     dd_ontology(tld)  ==  parse(matrix_ontology(tld))   (+ the bootstrap main node)
 *
 * The PHP-inherited design enforced that invariant ONE way: `regenerate` WIPED every
 * node for the TLD and rebuilt from scratch (`ontology_write.ts` deleteTldNodes → reinsert),
 * even when a single record had changed, with a leftover `dd_ontology_bk` table as its only
 * — and completely untested — rollback. That is fragile (a crash between the wipe and the
 * reinsert leaves the runtime ontology EMPTY; two concurrent runs clobber each other's
 * backup table).
 *
 * This module replaces that with ONE READ and ONE WRITE:
 *   - `inspectOntology(tld)`  — pure read. The drift: which nodes are missing, stale or
 *     orphaned, and whether the main node is present. Nothing today can show you this.
 *   - `rebuildOntology(tld)`  — the re-derive, TRANSACTIONAL and ID-STABLE: inside ONE
 *     `withTransaction` every row the parse does not produce is deleted (orphans) and every
 *     parsed node is upserted over its existing row, so a mid-run failure rolls back
 *     automatically — no backup table, no leftover, no corruption window — and a surviving
 *     node keeps its dd_ontology id (the outcome equals wipe-and-reinsert, minus the churn).
 * plus two whole-tld doors built on them: `retractOntology` (the tld teardown empties its
 * projection) and `syncOntologyActivation` (a registry record's ACTIVE tld → re-derived when it
 * drifted, root re-planted when it did not; a tld with no rows stays empty).
 *
 * THE INVARIANT these doors keep (ONT-1/2/3, audit 2026-09-26): dd_ontology(tld) equals the
 * parse of matrix_ontology(<tld>0) for every tld that holds a projection (getActiveTlds), and
 * a torn-down tld holds none. "Inactive ⇒ empty" is NOT enforced by activation: active is
 * defined by having rows (syncOntologyActivation; hierarchy4 = owner question Q1). The
 * per-record and lifecycle doors live in section_record/ontology_projection.ts (its header
 * names every door and the gates). Under concurrency the invariant rests on ONE lock: every
 * door that derives a tld's nodes (rebuild, retract, the activation, the per-record and
 * lifecycle doors) takes the tld's projection lock (dd_ontology.ts lockOntologyProjection)
 * before its first read — withTransaction alone does not order a parse against a concurrent
 * record delete/undelete — and a door whose WRITE depends on "is the tld active?" (the
 * activation; a rebuild with `onlyIfProjected`) re-asks it UNDER that lock, so a teardown
 * that committed first is never undone. Gate: ontology_projection_race_native R1-R7.
 *
 * WHY THERE IS NO INCREMENTAL RECONCILE (removed 2026-08-11). An `ensureOntology` used to sit
 * between the two: upsert the missing/stale nodes, delete the orphaned ones, fill the main node
 * if absent. Its ONLY claim over rebuild was "NO WIPE, so the runtime ontology is never
 * momentarily empty" — and that claim died the day rebuild became transactional. Under MVCC no
 * other session ever observes an intermediate state: readers see the old rows until the commit
 * publishes the new ones atomically. What remained was a strictly weaker writer (it FILLS the
 * main node; rebuild re-derives it) offered next to the stronger one, i.e. a decision the
 * operator had to make with no criterion to make it by — and a second write path to keep in
 * step with the parser forever. One writer, no choice, no drift between them.
 *
 * NODE SOURCES (why orphan detection is clean). For tld `es`:
 *   - matrix records in section `es0` parse to nodes `es1, es2, …`  (the PROJECTION);
 *   - the `es0` MAIN node (is_main) is created by the bootstrap, NOT parsed;
 *   - the parent GROUPER node lives under tld `ontologytype`, not `es`.
 * So `stored(tld=es) − parsed − {the es0 main node}` is exactly the orphans, and the
 * grouper is never a false orphan.
 *
 * MISFILED SOURCE RECORDS (drift kind `foreign`). A node's tipo AND tld come from the RECORD's
 * own `ontology7` value, not from the section it sits in — so a typo there (live: `actv0/127`
 * declares `ontology7="act"`) parses a record of section `es0` into a node of ANOTHER tld.
 * BOTH sides of the diff are therefore scoped to the inspected tld: `parseMatrixNodes` keeps
 * only `node.tld === tld` exactly as `storedNodes` reads `WHERE tld = $1`. The rejects are NOT
 * dropped — they surface as drift kind `foreign` naming the SOURCE RECORD (`es0/127 declares
 * tld 'act'`), which is the only thing an operator can act on. Without that scoping the foreign
 * node could never appear in `stored`, so it was reported `missing` forever (an unfixable false
 * failure), re-upserted on every run (breaking idempotency), and WRITTEN into the other tld's
 * namespace by a per-tld operation — where this tld's own delete could never take it back.
 * Nothing here touches a byte outside the tld it was asked about: cleaning up a node the old bug
 * leaked into tld X is X's own rebuild (its delete is scoped to X). The comparison is
 * EXACT, not case- or whitespace-insensitive: `ontology7 = "ES"` is a misfiled record too, and
 * saying so beats silently minting an `ES7` tipo. Gated by
 * test/unit/ontology_state_foreign_tld.test.ts.
 *
 * TLD-LESS SOURCE RECORDS (`tldlessRecords`) — the same blind spot, from the other side.
 * `ontology7` is MANDATORY: without it the parser returns null, so the record yields no tipo, no
 * dd_ontology row, and no place in the ontology tree. It used to be skipped in silence here, and
 * silence was indistinguishable from health — it could never appear in `stored` (there was no
 * tipo to look up) so it could not even be `missing`, and inspect reported `inSync: true` over
 * an administrator's invisible record. It is now named by its SOURCE RECORD, the only handle
 * that exists for it.
 *
 * It is a WARNING CHANNEL, NOT A DRIFT KIND, and that distinction was itself a bug once: filed
 * as drift it made `inSync` false, which the parser tool renders red — while nothing may write
 * those records (report-only, and normalizeOntologyTld skips contentless shells), so Rebuild
 * reported success against a panel that could never go green again. `drift`
 * means "dd_ontology disagrees with what the source parses to"; a record that parses to nothing
 * is absent from both sides and disagrees with nothing. Prevention lives upstream:
 * ontology/tld.ts requiredOntologyTld (the ONT-TLD rule), the birth stamp in
 * section/record/record_defaults.ts, the save refusal in section/record/save_component.ts, and
 * the post-COPY normalization in ontology/data_io_import.ts.
 *
 * INVALID REFERENCES (`invalidReferenceRecords`, SURF-1) — the same warning-channel shape. A
 * record whose parent / model / connected-to locator composes into a non-tipo (section_id
 * `'1 OR'` → `zzgs1 OR`), or whose properties.alias_of breaks the tipo grammar, still parses:
 * the defective reference is DROPPED from the node (parser.ts OntologyNodeDefect) and named
 * here by its source record. Not a drift kind: the projection agrees with what the source
 * parses to. And never a refusal of the tld — one bad record must not block every ontology
 * update of its tld (with the dd_ontology CHECK constraints live, projecting the value would
 * roll the whole rebuild back).
 *
 * SINGLE WRITER: nothing outside this module deletes a TLD's dd_ontology wholesale (rebuild,
 * retract, activation), and the re-derive has exactly ONE writer. The legacy
 * `regenerateRecordsInDdOntology` is retired onto `rebuildOntology`; the ontology update
 * (ontology_update.ts deriveOntologyPackages), the registry activation and the tld teardown
 * (ontology_delete.ts) all route here. Census:
 * test/unit/ontology_single_writer_tripwire.test.ts; outcomes:
 * ontology_derive_packages_native / ontology_update_shell_native.
 */

import {
	alignDdOntologyIdSequence,
	type DdOntologyNode,
	type DdOntologyRow,
	deleteDdOntologyRowsReturning,
	deleteTldNodesExcept,
	deleteTldNodesReturningTipos,
	listTldsWithUnderivedMachineNames,
	listUnderivedMachineNameTipos,
	lockOntologyProjection,
	readDdOntologyRow,
	tldHoldsNodes,
	upsertDdOntologyNode,
} from '../db/dd_ontology.ts';
import { sql, withTransaction } from '../db/postgres.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import type { ReconcileDefinition } from '../reconcile/registry.ts';
import { changedDeclaredOrderTipos, declaredOrderSignature } from '../relations/order_locators.ts';
import {
	isNameClassNode,
	type MachineNameDefectKind,
	type MachineNameInput,
	type MachineNameLegacyRung,
	modelNameOf,
	projectMachineName,
} from './machine_name.ts';
import { ONTOLOGY_MAIN_SECTION, ONTOLOGY_TLD, ONTOLOGY_TYPE_TLD } from './ontology_tipos.ts';
import {
	createDdOntologyRootNode,
	ensureMainSection,
	getMainTld,
	getMainTypologyId,
	getOntologyMainFromTld,
	type OntologyWriteResponse,
} from './ontology_write.ts';
import {
	modelResolutionDefects,
	type OntologyNodeDefect,
	parseSectionRecordToOntologyNodeWithDefects,
} from './parser.ts';
import { getMatrixTableFromTipo, getModelByTipo } from './resolver.ts';
import {
	getTldFromTipo,
	LOCAL_ONTOLOGY_SECTION,
	mapTldToTargetSectionTipo,
	safeTld,
} from './tld.ts';

/**
 * One node's place in the diff. `foreign` is not a dd_ontology state at all — it is a SOURCE
 * record of this tld's section whose `ontology7` declares a different tld, so it can never be
 * part of this tld's projection. Rebuild refuses it and names it; only a data fix clears it.
 */
/**
 * NOTE: tld-less source records are deliberately NOT a drift kind. They are not a
 * disagreement between dd_ontology and its source (they are absent from both) —
 * they ride `OntologyState.tldlessRecords` instead. Adding a kind here also breaks
 * every consumer that enumerates the set, client and gate alike.
 */
export type OntologyDriftKind = 'missing' | 'stale' | 'orphaned' | 'foreign';

export interface OntologyDriftItem {
	/** The node tipo. For `foreign`, the tipo the misfiled record parses INTO (other tld). */
	tipo: string;
	kind: OntologyDriftKind;
	/** For `stale`: which columns differ. `['tld']` for `foreign`. Empty for missing/orphaned. */
	diffColumns: string[];
	/** `foreign` only: the offending source record, `<section_tipo>/<section_id>`. */
	source?: string;
	/** `foreign` only: the tld its `ontology7` declares (verbatim). */
	declaredTld?: string;
}

export interface OntologyState {
	tld: string | null;
	/** Count of matrix records that parsed into a node OF THIS TLD (the projection size). */
	matrixNodes: number;
	/** Count of dd_ontology rows currently stored for the tld. */
	storedNodes: number;
	/** The `<tld>0` main node exists in dd_ontology. */
	mainNodeOk: boolean;
	/** Count of source records of this tld's section that declare ANOTHER tld (misfiled). */
	foreignNodes: number;
	/** Count of source records of this tld's section that declare NO tld at all (unparseable). */
	tldlessNodes: number;
	/**
	 * Those records, as `<section_tipo>/<section_id>` — the operator's only handle
	 * on them (a record with no tld parses into no tipo). A WARNING channel, not
	 * drift: see the emission in inspectOntology for why they are kept out of it.
	 */
	tldlessRecords: string[];
	/** Count of own nodes that dropped at least one invalid reference (SURF-1; a warning channel). */
	invalidReferenceNodes: number;
	/** Every dropped reference, by SOURCE record (see the module header, INVALID REFERENCES). */
	invalidReferenceRecords: InvalidReferenceRecord[];
	/**
	 * Count of own nodes with at least one machine-name finding — a WARNING channel, like
	 * invalidReferenceNodes, never a drift kind (the projection still matches its source;
	 * the SOURCE is what is wrong). Plan §6b: this is the post-upgrade verification —
	 * an explicit flag that disagrees with the classification, a flag-yes node with no name,
	 * a model that resolves to nothing — so a drifted PHP list is named, never silent.
	 */
	machineNameDefectNodes: number;
	/** Every machine-name finding, by SOURCE record (ontology/machine_name.ts MachineNameDefectKind). */
	machineNameDefects: MachineNameDefectRecord[];
	/**
	 * How many own nodes derived their machine-name columns through each legacy rung
	 * (ontology/machine_name.ts) — the P1→P4 bridge, shrink-only to zero (G6).
	 */
	machineNameLegacyRungs: Record<MachineNameLegacyRung, number>;
	drift: OntologyDriftItem[];
	/** No drift and the main node is present → dd_ontology matches its source. */
	inSync: boolean;
}

export interface OntologyWriteResult {
	/** INTERNAL outcome discriminator (never a wire body). */
	ok: boolean;
	msg: string;
	errors: string[];
	state: OntologyState;
	/** What the write actually changed. */
	applied: string[];
	/**
	 * Set only by a rebuild with `onlyIfProjected` that found the tld empty under its lock:
	 * nothing was written (RebuildOntologyOptions.onlyIfProjected). Never set otherwise.
	 */
	notProjected?: true;
}

/* ------------------------------------------------------------------ reads */

/** A source record of this tld's section whose `ontology7` names a DIFFERENT tld. */
interface ForeignRecord {
	/** The tipo it parses into — in the other tld's namespace. */
	tipo: string;
	/** The tld its `ontology7` declares, verbatim. */
	declaredTld: string;
	/** `<section_tipo>/<section_id>` — the record the operator must fix. */
	source: string;
}

/**
 * A source record of this tld's section that declares NO tld at all (ONT-TLD violated).
 *
 * `parseSectionRecordToOntologyNode` returns null for it — `ontology7` is mandatory — so it
 * produces no tipo, no dd_ontology row, and no presence in the ontology tree. Before this was
 * tracked the record was SILENTLY skipped here: it never reached `stored` (the parse produced no
 * tipo to look up), so it could not show as `missing`, and inspect reported `inSync: true` while
 * the administrator's record was invisible. Exactly the blind spot the `foreign` kind was added
 * to close, in the other direction.
 */
interface TldlessRecord {
	/** `<section_tipo>/<section_id>` — the record the operator must fix or delete. */
	source: string;
}

/** One reference a source record composed but its node could not carry (SURF-1). */
export interface InvalidReferenceRecord {
	/** `<section_tipo>/<section_id>` — the record the operator must fix. */
	source: string;
	/** The node the record parses into (its OTHER columns were projected). */
	tipo: string;
	column: OntologyNodeDefect['column'];
	/** The raw composed value. */
	value: unknown;
}

/** One machine-name finding on a source record (see OntologyState.machineNameDefects). */
export interface MachineNameDefectRecord {
	/** `<section_tipo>/<section_id>` — the record the operator must fix. */
	source: string;
	/** The node the record parses into. */
	tipo: string;
	kind: MachineNameDefectKind;
	/** The competing / offending values, when the kind has any. */
	values?: unknown[];
}

/** A zeroed rung tally (every key present, so a consumer can ratchet each). */
function emptyRungTally(): Record<MachineNameLegacyRung, number> {
	return { legacy_lang: 0, single_value: 0, derived_flag: 0 };
}

/** What the model fixpoint needs to RE-derive one node's machine-name columns. */
interface MachineNameSource {
	source: string;
	input: MachineNameInput;
	rungs: MachineNameLegacyRung[];
	defects: MachineNameDefectRecord[];
}

interface ParsedMatrixNodes {
	/** Nodes that belong to the inspected tld, keyed by tipo — the projection. */
	own: Map<string, DdOntologyNode>;
	/** Records of the same section that parsed into ANOTHER tld (see the module header). */
	foreign: ForeignRecord[];
	/** Records of the same section that parsed into NOTHING, for want of an ontology7. */
	tldless: TldlessRecord[];
	/** References of `own` nodes dropped for breaking the identifier grammar. */
	invalidReferences: InvalidReferenceRecord[];
	/** Machine-name findings of `own` nodes, after the model fixpoint. */
	machineNameDefects: MachineNameDefectRecord[];
	/** Legacy-rung tally of `own` nodes, after the model fixpoint. */
	machineNameLegacyRungs: Record<MachineNameLegacyRung, number>;
}

/**
 * Parse every matrix record of the TLD's section, SPLIT by the tld the record declares.
 * `own` is scoped exactly as `storedNodes` (`tld = $1`) so the two sides of the diff cover the
 * same namespace; `foreign` and `tldless` carry the unusable records so they are diagnosed,
 * not chased.
 */
async function parseMatrixNodes(tld: string): Promise<ParsedMatrixNodes> {
	const sectionTipo = mapTldToTargetSectionTipo(tld);
	const table = await getMatrixTableFromTipo(sectionTipo);
	const own = new Map<string, DdOntologyNode>();
	const foreign: ForeignRecord[] = [];
	const tldless: TldlessRecord[] = [];
	const invalidReferences: InvalidReferenceRecord[] = [];
	const machineNames = new Map<string, MachineNameSource>();
	const empty = (): ParsedMatrixNodes => ({
		own,
		foreign,
		tldless,
		invalidReferences,
		machineNameDefects: [],
		machineNameLegacyRungs: emptyRungTally(),
	});
	if (table === null) return empty();
	// localontology0 records are OVERRIDES of other tlds' nodes, never nodes of
	// their own (parser.ts refuses them): the `localontology` tld projects to its
	// main node only, and anything else stored under it is `orphaned` drift that
	// rebuild removes (e.g. a `localontology1` left by the pre-2026-10-01 parse).
	if (sectionTipo === LOCAL_ONTOLOGY_SECTION) return empty();

	// BEFORE blaming any record: can `ontology7` itself be resolved?
	//
	// parseSectionRecordToOntologyNode returns null for a record with no tld — AND
	// for a perfectly good record when `getModelByTipo(ontology7)` cannot answer,
	// which happens whenever dd_ontology has not been (re-)derived yet: mid
	// update_ontology, after a partial import, on a half-installed ontology. An
	// earlier version of this bucket assumed the first cause and attributed the
	// second to the DATA: on such an install `inspect('dd')` reported 1726 tld-less
	// records and named healthy ones (dd0/1, dd0/2 …) as the operator's fault.
	// One shared cause must never be reported as N record-level defects.
	if ((await getModelByTipo(ONTOLOGY_TLD)) === null) {
		throw new DedaloError('ontology.invalid_node', {
			message: `inspectOntology('${tld}'): the '${ONTOLOGY_TLD}' node cannot be resolved in dd_ontology, so NO record of '${sectionTipo}' can be parsed. This is an ontology-resolution failure, not a defect in the records — re-derive the 'ontology' tld first.`,
			coordinates: { tld, section_tipo: sectionTipo },
		});
	}

	const rows = (await sql.unsafe(
		`SELECT section_id FROM "${table}" WHERE section_tipo = $1 ORDER BY section_id ASC`,
		[sectionTipo],
	)) as { section_id: number }[];
	for (const row of rows) {
		const sectionId = Number(row.section_id);
		const parsed = await parseSectionRecordToOntologyNodeWithDefects(sectionTipo, sectionId);
		const { node, defects } = parsed;
		if (node === null) {
			// With ontology7 resolvable (guarded above), the remaining cause is what
			// this kind names: the RECORD declares no tld. Reported, never dropped.
			tldless.push({ source: `${sectionTipo}/${sectionId}` });
			continue;
		}
		if (node.tld !== tld) {
			foreign.push({
				tipo: node.tipo,
				declaredTld: node.tld ?? '',
				source: `${sectionTipo}/${sectionId}`,
			});
			continue;
		}
		own.set(node.tipo, node);
		const source = `${sectionTipo}/${sectionId}`;
		if (parsed.machineNameInput !== null) {
			machineNames.set(node.tipo, {
				source,
				input: parsed.machineNameInput,
				rungs: parsed.machineNameRungs,
				defects: parsed.machineNameDefects.map((defect) => ({
					source,
					tipo: node.tipo,
					...defect,
				})),
			});
		}
		for (const defect of defects) {
			invalidReferences.push({
				source: `${sectionTipo}/${sectionId}`,
				tipo: node.tipo,
				column: defect.column,
				value: defect.value,
			});
		}
	}
	resolveModelsAgainstParse(own, tld, machineNames);
	return { own, foreign, tldless, invalidReferences, ...machineNameFindings(machineNames) };
}

/** The machine-name findings + legacy-rung tally of every own node (after the fixpoint). */
function machineNameFindings(
	machineNames: ReadonlyMap<string, MachineNameSource>,
): Pick<ParsedMatrixNodes, 'machineNameDefects' | 'machineNameLegacyRungs'> {
	const tally = emptyRungTally();
	const defects: MachineNameDefectRecord[] = [];
	for (const entry of machineNames.values()) {
		for (const rung of entry.rungs) tally[rung] += 1;
		defects.push(...entry.defects);
	}
	return { machineNameDefects: defects, machineNameLegacyRungs: tally };
}

/**
 * RE-derive one node's machine-name columns after the fixpoint changed its model: the
 * classification reads the model (a node whose model became `table` is name-class now), so
 * the kernel runs again on the SAME source input with the new class, and the node's findings
 * are replaced (its `model_unresolved` included). Not re-counted: the parse already counted.
 */
function rederiveMachineName(node: DdOntologyNode, entry: MachineNameSource): void {
	const projection = projectMachineName({ ...entry.input, nameClass: isNameClassNode(node) });
	node.machine_name = projection.machine_name;
	node.use_machine_name = projection.use_machine_name;
	entry.rungs = projection.rungs;
	entry.defects = [
		...projection.defects,
		...modelResolutionDefects(node.model_tipo, node.model),
	].map((defect) => ({ source: entry.source, tipo: node.tipo, ...defect }));
}

/**
 * MODEL FIXPOINT. `model` is the one column a node takes from ANOTHER node: the parser reads
 * `dd_ontology(model_tipo).machine_name` off the STORED row (parser.ts projectModel).
 * A whole-tld parse runs before any upsert, so for a model node of the SAME tld that stored row
 * is the pre-rebuild one: a model the release adds, or renames, would leave every instance with
 * `model = NULL` / the old name until a second pass. Resolve those against the parse being
 * written instead (same rule, machine_name.ts modelNameOf: that node's machine_name), so one
 * rebuild converges and inspect compares against the fixpoint. A same-tld model the parse
 * does NOT produce (its record removed: the rebuild deletes its row as an orphan) resolves to
 * `null` — what the parser reads once that row is gone — never to the stored row's name the
 * same transaction is about to delete. A model of ANOTHER tld is the update's second pass
 * (ontology_update.ts deriveOntologyPackages). Gate: ontology_derive_packages_native G1f.
 *
 * The model is read before the instance's machine name is classified, so a node whose model
 * the fixpoint CHANGES is re-derived (rederiveMachineName). Model nodes come first: their own
 * columns never depend on another node's model (a model definition is classified by its row).
 */
function resolveModelsAgainstParse(
	own: Map<string, DdOntologyNode>,
	tld: string,
	machineNames: ReadonlyMap<string, MachineNameSource>,
): void {
	for (const node of own.values()) {
		if (node.model_tipo === null) continue;
		const before = node.model;
		node.model = modelAgainstParse(node.model_tipo, before, own, tld);
		const entry = machineNames.get(node.tipo);
		if (entry !== undefined && node.model !== before) rederiveMachineName(node, entry);
	}
}

/** One node's model against the parse being written (resolveModelsAgainstParse). */
function modelAgainstParse(
	modelTipo: string,
	parsedModel: string | null,
	own: ReadonlyMap<string, DdOntologyNode>,
	tld: string,
): string | null {
	const modelNode = own.get(modelTipo);
	if (modelNode !== undefined) return modelNameOf(modelNode).model;
	return isRemovedSameTldModel(modelTipo, tld) ? null : parsedModel;
}

/** A model tipo of THIS tld the parse does not produce (and not its root): its row is an orphan. */
function isRemovedSameTldModel(modelTipo: string, tld: string): boolean {
	return getTldFromTipo(modelTipo) === tld && modelTipo !== `${tld}0`;
}

/** The operator-facing line for one misfiled record: what is wrong, where, and that nothing ran. */
function foreignError(item: ForeignRecord, tld: string): string {
	return `${item.source} declares tld '${item.declaredTld}' (parses to node '${item.tipo}'), not '${tld}' — fix the record's ontology7; nothing was written for it`;
}

/**
 * Did a rebuild achieve everything a rebuild CAN achieve?
 *
 * `inSync` is the answer for the projection, and tld-less records no longer disturb it (they
 * ride their own channel). What this adds is a WHOLESALE-FAILURE floor: if the section holds
 * records but NOT ONE of them parsed, the tld has no projection at all, and calling that
 * "converged" would report a rebuild that deleted every node and re-inserted none as a success.
 * Something systemic is wrong in that case — never a per-record data fault — so it must fail.
 */
function rebuildConverged(state: OntologyState): boolean {
	if (state.matrixNodes === 0 && state.tldlessNodes > 0) return false;
	return state.inSync;
}

/**
 * The warning suffix appended to a SUCCESSFUL rebuild message, or ''.
 *
 * A tld-less record is a WARNING, not an error: unlike `foreign` — which would land a node in
 * another tld's namespace, where this tld's own writer could never take it back — it
 * contributes nothing to the projection, so rebuilding the rest is perfectly safe. But it is
 * still an administrator's record that the tree will never show, so a green run says so every
 * time rather than letting it pass in silence (the whole bug this kind exists to close).
 *
 * Named, not just counted — an operator needs the record to open. Capped, because an install
 * carrying legacy shells has dozens; the complete list is always in `state.tldlessRecords`.
 */
const TLDLESS_NAMED_LIMIT = 10;

function tldlessNote(state: OntologyState): string {
	if (state.tldlessNodes === 0) return '';
	const sources = state.tldlessRecords;
	const named = sources.slice(0, TLDLESS_NAMED_LIMIT).join(', ');
	const rest = sources.length - TLDLESS_NAMED_LIMIT;
	return ` — ${state.tldlessNodes} source record(s) declare no ontology7 and stay invisible in the tree: ${named}${rest > 0 ? ` (+${rest} more)` : ''}`;
}

/**
 * The warning suffix naming source records whose invalid references were dropped (SURF-1),
 * or ''. Same shape and cap as tldlessNote; the full list is `state.invalidReferenceRecords`.
 */
function invalidReferenceNote(state: OntologyState): string {
	if (state.invalidReferenceNodes === 0) return '';
	const records = state.invalidReferenceRecords;
	const named = records
		.slice(0, TLDLESS_NAMED_LIMIT)
		.map(
			(item) => `${item.source} ${item.column} ${(JSON.stringify(item.value) ?? '').slice(0, 64)}`,
		)
		.join(', ');
	const rest = records.length - TLDLESS_NAMED_LIMIT;
	return ` — ${state.invalidReferenceNodes} node(s) dropped a reference that is not a valid identifier (fix the source record): ${named}${rest > 0 ? ` (+${rest} more)` : ''}`;
}

/**
 * The warning suffix naming nodes with machine-name findings, or ''. Same shape and cap as
 * invalidReferenceNote; the full list is `state.machineNameDefects`.
 */
function machineNameNote(state: OntologyState): string {
	if (state.machineNameDefectNodes === 0) return '';
	const records = state.machineNameDefects;
	const named = records
		.slice(0, TLDLESS_NAMED_LIMIT)
		.map(
			(item) =>
				`${item.source} ${item.kind}${item.values === undefined ? '' : ` ${(JSON.stringify(item.values) ?? '').slice(0, 64)}`}`,
		)
		.join(', ');
	const rest = records.length - TLDLESS_NAMED_LIMIT;
	return ` — ${state.machineNameDefectNodes} node(s) have a machine-name finding (fix the source record's machine name / use-machine-name): ${named}${rest > 0 ? ` (+${rest} more)` : ''}`;
}

/** Read every dd_ontology row for the TLD, keyed by tipo. */
async function storedNodes(tld: string): Promise<Map<string, DdOntologyRow>> {
	const rows = (await sql.unsafe(
		`SELECT tipo, parent, term, model, order_number, relations, tld,
		        properties, model_tipo, is_model, is_translatable, is_main, propiedades,
		        machine_name, use_machine_name
		 FROM dd_ontology WHERE tld = $1`,
		[tld],
	)) as DdOntologyRow[];
	const map = new Map<string, DdOntologyRow>();
	for (const row of rows) {
		row.order_number =
			row.order_number === null || row.order_number === undefined
				? null
				: Math.trunc(Number(row.order_number));
		map.set(row.tipo, row);
	}
	return map;
}

/**
 * Stable, EMPTY-NORMALIZED JSON for comparison. Object keys are sorted (a jsonb round-trip
 * re-order is not a real diff), and every "absent" shape collapses to the same token: null,
 * `{}` and `[]` all read as absent. dd_ontology stores an empty component as SQL NULL, but
 * the parser may hand back `{}`/`[]`/`"{}"` for the same emptiness — comparing those as
 * different would report every live node as drifted on every inspect for no semantic change.
 */
function stable(value: unknown): string {
	const norm = (v: unknown): unknown => {
		if (v === null || v === undefined) return null;
		if (typeof v !== 'object') return v;
		if (Array.isArray(v)) return v.length === 0 ? null : v.map(norm);
		const keys = Object.keys(v as Record<string, unknown>).sort();
		if (keys.length === 0) return null;
		const out: Record<string, unknown> = {};
		for (const key of keys) out[key] = norm((v as Record<string, unknown>)[key]);
		return out;
	};
	return JSON.stringify(norm(value));
}

/**
 * `propiedades` is a TEXT column holding v5-legacy JSON. The parser PRETTY-PRINTS it
 * (byte-exact PHP `JSON_PRETTY_PRINT` — 4-space indent), while a record written by an
 * older path may be MINIFIED. Those are the same content, and calling the whitespace a
 * difference would paint huge swathes of the live ontology as drifted (779 of the `dd` tld's
 * nodes) for zero semantic gain, sending an operator to rebuild over nothing. Compare by
 * MEANING: parse both and diff structurally; fall back to a text compare only when a side is
 * not valid JSON.
 *
 * (A rebuild rewrites every row of the tld regardless, so it normalizes those bytes to the
 * parser's pretty-printed form. That is the canonical shape — the point here is only that
 * the DIFF must not manufacture a reason to run one.)
 */
function propiedadesDiffer(a: string | null, b: string | null): boolean {
	if ((a ?? '') === (b ?? '')) return false;
	try {
		// stable() normalizes {}/[]/null to the same token, so "{}" vs SQL NULL is not a diff.
		return stable(JSON.parse(a || 'null')) !== stable(JSON.parse(b || 'null'));
	} catch {
		return (a ?? null) !== (b ?? null);
	}
}

/**
 * The columns whose value differs between the parsed node and the stored row —
 * the engine's OWN equality law for an ontology node (jsonb structurally, key
 * order insignificant; `propiedades` by meaning, not whitespace).
 *
 * Exported because `test/unit/test_tld_ontology_gate.test.ts` compares the
 * committed JSON source against dd_ontology and against the inverse parser's
 * round trip: those gates must use THIS definition of "equal", never a second
 * hand-written one that could disagree with what a rebuild considers drift.
 */
export function nodeDiffColumns(parsed: DdOntologyNode, stored: DdOntologyRow): string[] {
	const diffs: string[] = [];
	const scalar: (keyof DdOntologyNode)[] = [
		'parent',
		'model',
		'tld',
		'model_tipo',
		'is_model',
		'is_translatable',
		'is_main',
		// Migration 0015: a row no parser has derived since reads use_machine_name NULL —
		// `stale` until the tld's next rebuild, which is exactly the trigger it needs.
		'machine_name',
		'use_machine_name',
	];
	for (const key of scalar) {
		if ((parsed[key] ?? null) !== (stored[key] ?? null)) diffs.push(key);
	}
	// order_number: numeric, both normalized to number|null already.
	if ((parsed.order_number ?? null) !== (stored.order_number ?? null)) diffs.push('order_number');
	// jsonb columns: compare structurally (key order is not significant).
	for (const key of ['term', 'relations', 'properties'] as const) {
		if (stable(parsed[key] ?? null) !== stable(stored[key] ?? null)) diffs.push(key);
	}
	// propiedades: TEXT-holding-JSON — meaning, not whitespace.
	if (propiedadesDiffer(parsed.propiedades ?? null, stored.propiedades ?? null)) {
		diffs.push('propiedades');
	}
	return diffs;
}

/**
 * THE MAIN NODE'S PLACE (the root re-hang class, ONT follow-up 2026-10-21). `<tld>0` is not
 * parsed from a record: it is DERIVED from the tld's registry row, hung under that row's
 * typology grouper (`ontologytype<hierarchy9>`, 15 = 'others' when the row states none —
 * settleMainNode / createDdOntologyRootNode, the one rule). A root under any other grouper is
 * a row that disagrees with what it derives to — `stale`, `['parent']` — and rebuild re-derives
 * it. Before, the diff only asked whether the root EXISTED: a root re-hung by a second writer
 * (createParentGrouper re-planted `hierarchytype0` under `ontologytype14` while its row said 2)
 * read as in sync, and every guard built on inspect (G1h's) was blind to it. A tld with no
 * registry row is not compared: nothing derives its root (the seed compiler's rows-only pass,
 * a test situation). Gate: ontology_root_registry_native C1–C4.
 */
async function mainNodeParentDrift(
	tld: string,
	main: DdOntologyRow | undefined,
): Promise<OntologyDriftItem[]> {
	if (main === undefined || main.is_main !== true) return [];
	const typologyId = await getMainTypologyId(tld);
	if (typologyId === null) return [];
	if ((main.parent ?? null) === `${ONTOLOGY_TYPE_TLD}${typologyId}`) return [];
	return [{ tipo: main.tipo, kind: 'stale', diffColumns: ['parent'] }];
}

/**
 * The full drift of ONE TLD. Pure read — safe on every render, writes nothing.
 */
export async function inspectOntology(rawTld: string): Promise<OntologyState> {
	const tld = safeTld(rawTld.trim().toLowerCase());
	if (tld === null) {
		return {
			tld: null,
			matrixNodes: 0,
			storedNodes: 0,
			mainNodeOk: false,
			foreignNodes: 0,
			tldlessNodes: 0,
			tldlessRecords: [],
			invalidReferenceNodes: 0,
			invalidReferenceRecords: [],
			machineNameDefectNodes: 0,
			machineNameDefects: [],
			machineNameLegacyRungs: emptyRungTally(),
			drift: [],
			inSync: false,
		};
	}
	const {
		own: parsed,
		foreign,
		tldless,
		invalidReferences,
		machineNameDefects,
		machineNameLegacyRungs,
	} = await parseMatrixNodes(tld);
	const stored = await storedNodes(tld);
	const mainTipo = `${tld}0`;
	const mainNodeOk = (stored.get(mainTipo)?.is_main ?? false) === true;

	const drift: OntologyDriftItem[] = [];
	for (const [tipo, node] of parsed) {
		const row = stored.get(tipo);
		if (row === undefined) {
			drift.push({ tipo, kind: 'missing', diffColumns: [] });
		} else {
			const diffColumns = nodeDiffColumns(node, row);
			if (diffColumns.length > 0) drift.push({ tipo, kind: 'stale', diffColumns });
		}
	}
	for (const tipo of stored.keys()) {
		// The main node is bootstrap-created, not parsed — never an orphan.
		if (tipo === mainTipo) continue;
		if (!parsed.has(tipo)) drift.push({ tipo, kind: 'orphaned', diffColumns: [] });
	}
	drift.push(...(await mainNodeParentDrift(tld, stored.get(mainTipo))));
	// Misfiled source records: real drift (the tld cannot be a faithful projection while one
	// exists) that no writer can clear — only editing the record's ontology7 does.
	for (const item of foreign) {
		drift.push({
			tipo: item.tipo,
			kind: 'foreign',
			diffColumns: ['tld'],
			source: item.source,
			declaredTld: item.declaredTld,
		});
	}
	// Tld-less source records are reported on their OWN channel, NOT as drift.
	//
	// `drift` answers "does dd_ontology match what the source parses to", and a
	// tld-less record parses to nothing — it is absent from both sides, so it is
	// not a disagreement between them. Filing it as drift made `inSync` false, which
	// this tool's client renders as a red "drifted" check; and since nothing may
	// write those records (report-only, and normalizeOntologyTld deliberately skips
	// contentless shells), Rebuild returned success while the panel stayed red
	// forever. An install carrying 92 legacy shells could not reach
	// green by any action available to it.
	//
	// So: `inSync` keeps its meaning, and `tldlessRecords` carries the finding.
	// Still loud — it is the whole point of the kind — but as a WARNING the operator
	// can act on (fill the tld, or delete the record), not a failure state.
	return {
		tld,
		matrixNodes: parsed.size,
		storedNodes: stored.size,
		mainNodeOk,
		foreignNodes: foreign.length,
		tldlessNodes: tldless.length,
		tldlessRecords: tldless.map((item) => item.source),
		invalidReferenceNodes: new Set(invalidReferences.map((item) => item.tipo)).size,
		invalidReferenceRecords: invalidReferences,
		machineNameDefectNodes: new Set(machineNameDefects.map((item) => item.tipo)).size,
		machineNameDefects,
		machineNameLegacyRungs,
		drift,
		inSync: drift.length === 0 && mainNodeOk,
	};
}

/* ----------------------------------------------------------------- writes */

/**
 * Bootstrap the `<tld>0` main node + its registry row. The registry-row law
 * (ontology_write.ts): a rebuild CREATES the row when it is missing and
 * otherwise never writes it — an operator's switched-off TLD, project filter or
 * language survive a rebuild. `<tld>0` is (re)built from what the row holds
 * (createDdOntologyRootNode reads typology + name off it).
 */
async function ensureMainNode(tld: string, userId: number): Promise<void> {
	await ensureMainSection({ tld }, userId);
	await createDdOntologyRootNode({ tld }, userId);
}

/**
 * The `<tld>0` main node, by mode (RebuildOntologyOptions.mainNode). `'existing'` writes
 * NOTHING outside this tld: with a registry row the root is re-derived from it and hung
 * under its typology grouper BY NAME (`ontologytype<N>`, the grouper itself is not built —
 * createParentGrouper would ensure the grouper tld's registry row and rewrite the shared
 * `ontologytype0/<N>` record with hard-coded values, no Time Machine); without one the
 * stored `<tld>0` (kept by the reconcile delete) stands untouched — the seed compiler's
 * rows-only pass 1 has no registry yet, and must not mint one. Gate:
 * ontology_derive_packages_native G1d.
 */
async function settleMainNode(
	tld: string,
	userId: number,
	mode: 'ensure' | 'existing',
): Promise<string> {
	if (mode === 'ensure') {
		await ensureMainNode(tld, userId);
		return `main node ${tld}0`;
	}
	if ((await getOntologyMainFromTld(tld)) !== null) {
		await createDdOntologyRootNode(
			{ tld, parent_grouper_tipo: await rootGrouperTipo(tld) },
			userId,
		);
		return `main node ${tld}0 (from its registry row)`;
	}
	return `main node ${tld}0 left as stored (no registry row)`;
}

/**
 * The grouper tipo a tld's `<tld>0` root hangs under, named WITHOUT building it — exactly
 * what the 'ensure' path's createParentGrouper(ONTOLOGY_TYPE_GROUP, ONTOLOGY_TYPE_TLD,
 * typology) returns: `ontologytype<typology>`, the registry row's typology (15 = 'others'
 * when it states none, resolveRootIdentity's default).
 */
async function rootGrouperTipo(tld: string): Promise<string> {
	return `${ONTOLOGY_TYPE_TLD}${(await getMainTypologyId(tld)) ?? 15}`;
}

/**
 * Re-derive ONE TLD's dd_ontology from its matrix source — the ONE writer, TRANSACTIONAL and
 * ID-STABLE. Inside one `withTransaction`: parse, delete every stored row of the tld the parse
 * does not produce (orphans; the `<tld>0` main node is kept for the main-node step), upsert
 * every parsed node (the upsert sets EVERY column, so a stale row is overwritten in place and
 * keeps its id), settle the main node. A failure at any point rolls the whole thing back, so
 * there is no intermediate state and no leftover backup table. The outcome equals
 * wipe-and-reinsert; concurrent readers see the old projection until the commit (module
 * header).
 */
export interface RebuildOntologyOptions {
	/**
	 * dd_ontology row ids to delete INSIDE the same transaction as the tld wipe (SURF-1
	 * repair, ontology/identifier_grammar.ts): a row filed under ANOTHER tld (or none)
	 * whose tipo belongs to this one — the `dd_ontology_tipo_in_tld` violation — is not
	 * reached by `tld = $1`, so it is reclaimed by id, and the re-derive decides whether
	 * its tipo comes back (from this tld's source) or not.
	 */
	reclaimIds?: readonly number[];
	/**
	 * How the `<tld>0` main node is settled (settleMainNode). `'ensure'` (the default — the
	 * parser tool, the reconcile, provisioning): create the registry row when missing, then
	 * re-derive `<tld>0` from it. `'existing'` (the ontology update, the registry
	 * activation, the seed compiler): never write the registry.
	 */
	mainNode?: 'ensure' | 'existing';
	/**
	 * Re-derive only when the tld STILL holds rows once its projection lock is held
	 * (dd_ontology.ts tldHoldsNodes, read live): otherwise nothing is written and the result
	 * carries `notProjected`. For a door that decided "active" before the lock (the registry
	 * activation, syncOntologyActivation): a teardown (retractOntology) that committed while it
	 * waited leaves the tld empty instead of being re-derived from records the teardown has not
	 * deleted yet. Gate: ontology_projection_race_native R7.
	 */
	onlyIfProjected?: boolean;
}

/** Delete the SURF-1 reclaimed rows by id (RebuildOntologyOptions.reclaimIds); the applied line. */
async function reclaimRows(ids: readonly number[] | undefined): Promise<string[]> {
	const reclaimed = await deleteDdOntologyRowsReturning(ids ?? []);
	if (reclaimed.length === 0) return [];
	return [`reclaimed ${reclaimed.map((row) => JSON.stringify(row.tipo)).join(', ')}`];
}

/**
 * RebuildOntologyOptions.onlyIfProjected, asked UNDER the tld's projection lock: true when the
 * caller asked for it and the tld holds no rows (read live) — the rebuild then writes nothing.
 */
async function leftUnprojected(tld: string, options: RebuildOntologyOptions): Promise<boolean> {
	return options.onlyIfProjected === true && !(await tldHoldsNodes(tld));
}

/**
 * The declared portal order of every node of `tld` that carries a `source`
 * (relations/order_locators.ts declaredOrderSignature — null when it declares
 * none), read live from dd_ontology: the BEFORE half of the portal-order ontology-change
 * trigger (queueOrderReconcileOnChange).
 */
async function declaredOrdersOfTld(tld: string): Promise<Map<string, string | null>> {
	const rows = (await sql.unsafe(
		`SELECT tipo, properties FROM dd_ontology WHERE tld = $1 AND properties ? 'source'`,
		[tld],
	)) as { tipo: string; properties: unknown }[];
	return new Map(rows.map((row) => [row.tipo, declaredOrderSignature(row.properties)]));
}

/**
 * THE ONTOLOGY-CHANGE TRIGGER of the portal order model (backfill;
 * relations/declared_order_reconcile.ts): the portals whose `order` declaration
 * this rebuild ADDED or CHANGED get their hosts re-sorted by the
 * `portal_declared_order` reconcile, POST-COMMIT (it must read the committed
 * declaration; a rolled-back rebuild re-sorts nothing). An unchanged
 * declaration queues nothing. Runs inside the rebuild's transaction.
 */
async function queueOrderReconcileOnChange(
	before: ReadonlyMap<string, string | null>,
	nodes: Iterable<DdOntologyNode>,
): Promise<void> {
	const after = new Map<string, string | null>();
	for (const node of nodes) after.set(node.tipo, declaredOrderSignature(node.properties));
	const changed = changedDeclaredOrderTipos(before, after);
	if (changed.length === 0) return;
	// CONVENTIONS §2 rationale 1 (cycle-breaking at the chokepoint seam): the reconcile
	// writes through save_component → record_write, whose birth lifecycle reaches the
	// ontology projection doors; a static edge would close that loop.
	const { queueDeclaredOrderReconcile } = await import('../relations/declared_order_reconcile.ts');
	await queueDeclaredOrderReconcile(changed);
}

/**
 * Run a MULTI-TLD ontology write (`work` — the ontology update's per-tld rebuilds
 * and its cross-package model pass, ontology_update.ts deriveOntologyPackages)
 * as ONE portal-order ontology-change batch: the sweeps each committed rebuild
 * owes (queueOrderReconcileOnChange) are collected and run ONCE, after the last
 * tld — never between two tlds against a half-applied ontology
 * (relations/declared_order_reconcile.ts withDeclaredOrderReconcileBatch).
 */
export async function withOrderReconcileBatch<T>(work: () => Promise<T>): Promise<T> {
	// CONVENTIONS §2 rationale 1 — the same cycle-breaking seam as queueOrderReconcileOnChange.
	const { withDeclaredOrderReconcileBatch } = await import(
		'../relations/declared_order_reconcile.ts'
	);
	return withDeclaredOrderReconcileBatch(work);
}

export async function rebuildOntology(
	rawTld: string,
	userId = -1,
	options: RebuildOntologyOptions = {},
): Promise<OntologyWriteResult> {
	const tld = safeTld(rawTld.trim().toLowerCase());
	if (tld === null) {
		const state = await inspectOntology(rawTld);
		return {
			ok: false,
			msg: `'${rawTld}' is not a valid TLD`,
			errors: [`invalid tld '${rawTld}'`],
			state,
			applied: [],
		};
	}

	const applied: string[] = [];
	const errors: string[] = [];
	let notProjected = false;
	try {
		// Heal a lagging id sequence FIRST, in its OWN short transaction (no ambient one here
		// for a top-level caller), so its LOCK TABLE is released before the projection lock
		// below is awaited: held across that wait, it would deadlock against a lifecycle unit
		// that holds the projection lock and then writes dd_ontology (ROW EXCLUSIVE). The
		// per-insert check in upsertDdOntologyNode is then a no-op, and two rebuilds never both
		// upgrade a held ROW EXCLUSIVE into the alignment lock.
		await alignDdOntologyIdSequence();
		await withTransaction(async () => {
			// The tld's projection lock BEFORE the parse (dd_ontology.ts lockOntologyProjection):
			// a concurrent record delete / undelete of `<tld>0` (the lifecycle hook) or a
			// per-record projection is ordered against this whole read-modify-write, so the parse
			// below cannot go stale before the deletes and upserts it drives.
			await lockOntologyProjection([tld]);
			// A caller whose "active" decision predates the lock re-asks it here (onlyIfProjected).
			if (await leftUnprojected(tld, options)) {
				notProjected = true;
				return;
			}
			// Parse BEFORE any delete: a bad record aborts the tx with the live data intact.
			const { own: parsed, foreign } = await parseMatrixNodes(tld);
			// The portal order model's ontology-change trigger: the tld's declared portal orders
			// BEFORE this rebuild rewrites them (read under the projection lock).
			const ordersBefore = await declaredOrdersOfTld(tld);
			// Misfiled records are reported, never rebuilt: the delete below is scoped to THIS
			// tld, so writing a foreign node would plant a row this rebuild could never take
			// back. A misfiled record does not block the tld's own rebuild — it only keeps the
			// outcome honest (ok=false while the source stays wrong).
			for (const item of foreign) errors.push(foreignError(item, tld));
			// Orphans out; every row about to be upserted (and the main node) keeps its id.
			const removed = await deleteTldNodesExcept(tld, [...parsed.keys(), `${tld}0`]);
			if (removed.length > 0) applied.push(`removed ${removed.length} orphaned node(s)`);
			applied.push(...(await reclaimRows(options.reclaimIds)));
			for (const node of parsed.values()) {
				await upsertDdOntologyNode(node);
			}
			applied.push(`rebuilt ${parsed.size} node(s)`);
			applied.push(await settleMainNode(tld, userId, options.mainNode ?? 'ensure'));
			await queueOrderReconcileOnChange(ordersBefore, parsed.values());
		});
	} catch (error) {
		errors.push(String(error));
		const state = await inspectOntology(tld);
		return {
			ok: false,
			msg: `Rebuild of '${tld}' failed and was rolled back`,
			errors,
			state,
			applied: [],
		};
	}

	const state = await inspectOntology(tld);
	if (notProjected) {
		return {
			ok: true,
			msg: `Ontology '${tld}' holds no projection; left empty`,
			errors,
			state,
			applied,
			notProjected: true,
		};
	}
	const converged = rebuildConverged(state);
	return {
		ok: converged,
		msg: converged
			? `Ontology '${tld}' rebuilt${tldlessNote(state)}${invalidReferenceNote(state)}${machineNameNote(state)}`
			: state.foreignNodes > 0
				? `Ontology '${tld}' rebuilt; ${state.foreignNodes} source record(s) declare another tld and were skipped`
				: `Ontology '${tld}' rebuilt with drift`,
		errors,
		state,
		applied,
	};
}

/**
 * Retract ONE tld: every dd_ontology row of it goes, in one transaction (the tld teardown,
 * ontology_delete.ts: an uninstalled tld holds no nodes). Returns the removed tipos. The tld MUST be safe — a
 * mismatch is refused loudly by the delete primitive, never widened.
 */
export async function retractOntology(tld: string): Promise<string[]> {
	return withTransaction(async () => {
		// Ordered against the per-record / lifecycle doors (rebuildOntology's lock).
		await lockOntologyProjection([tld]);
		return deleteTldNodesReturningTipos(tld);
	});
}

/**
 * Sync the projection of each REGISTRY record (`ontology35`, matrix_ontology_main) with its
 * tld. The PHP original (set_records_in_dd_ontology on ontology35) re-planted only the
 * `<tld>0` root of an active tld, so an active tld whose nodes had gone missing stayed broken.
 *
 * ACTIVE means what getActiveTlds (PHP check_active_tld) says: dd_ontology still holds rows of
 * the tld — NOT the registry's hierarchy4 flag (owner question Q1 of the ONT plan, open). So:
 *   - an ACTIVE tld whose projection DRIFTED (inspectOntology: a missing / stale / orphaned /
 *     foreign node, or no main node) is RE-DERIVED in full (rebuildOntology, `mainNode:
 *     'existing'` — the registry is the input here, never written);
 *   - an ACTIVE tld already in sync only has its `<tld>0` root re-planted from the registry
 *     row (the PHP behaviour, cheap): a list-mode run over the whole registry re-derives what
 *     is broken and nothing else, instead of a foreground full rebuild of every installed tld
 *     (the WC-043 runaway shape). Its cost is one parse per tld (~0.14 ms per node measured);
 *   - a tld with NO rows is left EMPTY: it cannot be (re-)activated through this door, and
 *     nothing here ever retracts — under this definition a tld with rows is active by
 *     construction. Retraction and re-activation become real only if activation is keyed on
 *     hierarchy4 (Q1); until then retracting is ontology_delete's job (retractOntology).
 * Gate: ontology_derive_packages_native G1e.
 *
 * Partial success, the setRecordsInDdOntology response shape: ok when at least one record
 * was processed; an unreadable / invalid tld, a rolled-back rebuild, a misfiled record or a
 * wholly tld-less section is an error line.
 */
export async function syncOntologyActivation(
	mainSectionIds: readonly number[],
	userId = -1,
): Promise<OntologyWriteResponse> {
	const errors: string[] = [];
	let processed = 0;
	for (const sectionId of mainSectionIds) {
		const step = await activateRegistryRecord(sectionId, userId);
		errors.push(...step.errors);
		if (step.processed) processed++;
	}
	return activationResponse(mainSectionIds.length, processed, errors);
}

/** One activation step's outcome: whether the record counts as processed, and its error lines. */
interface ActivationStep {
	processed: boolean;
	errors: string[];
}

/**
 * One registry record's activation (see syncOntologyActivation). The DECISION is made under
 * the tld's projection lock (module header): "active?" (live, tldHoldsNodes — never the
 * getActiveTlds cache), "in sync?" and the root re-plant are one locked unit, so a teardown
 * (ontology_delete.ts: retractOntology, then the registry row, then the records — separate
 * units) that committed its retract first is SEEN — the tld holds no rows, nothing is
 * re-planted — and one that comes after waits and removes what this wrote. A drifted tld is
 * re-derived by rebuildOntology, which re-asks "active?" under its own lock
 * (`onlyIfProjected`): the teardown may commit between the two units. Gate:
 * ontology_projection_race_native R6 (in sync) / R7 (drifted).
 */
async function activateRegistryRecord(sectionId: number, userId: number): Promise<ActivationStep> {
	const { raw, tld } = await registryTld(sectionId);
	if (tld === null) {
		const line = `${ONTOLOGY_MAIN_SECTION}/${sectionId}: invalid or missing tld ${JSON.stringify(raw)}`;
		return { processed: false, errors: [line] };
	}
	// The sequence heal BEFORE the locked unit, as rebuildOntology does (its table lock must
	// not be held across the projection-lock wait).
	await alignDdOntologyIdSequence();
	const decision = await withTransaction(async (): Promise<'inactive' | 'settled' | 'drifted'> => {
		await lockOntologyProjection([tld]);
		// No projection: not active, nothing to re-derive and nothing to retract.
		if (!(await tldHoldsNodes(tld))) return 'inactive';
		if (!(await inspectOntology(tld)).inSync) return 'drifted';
		await settleMainNode(tld, userId, 'existing');
		return 'settled';
	});
	if (decision !== 'drifted') return { processed: true, errors: [] };
	return rederiveActiveTld(tld, userId);
}

/** The tld a registry record names (`raw`, for the error line) and its safe form (null: absent / invalid). */
async function registryTld(sectionId: number): Promise<{ raw: string | null; tld: string | null }> {
	const raw = await getMainTld(sectionId, ONTOLOGY_MAIN_SECTION);
	return { raw, tld: raw === null ? null : safeTld(raw) };
}

/**
 * A drifted active tld re-derived in full; processed unless it rolled back or projected
 * nothing. A tld torn down meanwhile (`notProjected`) is left empty — processed, like an
 * inactive one.
 */
async function rederiveActiveTld(tld: string, userId: number): Promise<ActivationStep> {
	const rebuilt = await rebuildOntology(tld, userId, {
		mainNode: 'existing',
		onlyIfProjected: true,
	});
	if (rebuilt.notProjected === true) return { processed: true, errors: [] };
	const failure = rebuildFailure(tld, rebuilt);
	if (failure !== null) return { processed: false, errors: [...rebuilt.errors, failure] };
	return { processed: rebuilt.applied.length > 0, errors: rebuilt.errors };
}

/** The setRecordsInDdOntology-shaped outcome of an activation run (partial success). */
function activationResponse(
	total: number,
	processed: number,
	errors: string[],
): OntologyWriteResponse {
	const succeeded = errors.length === 0 || processed > 0;
	const msg =
		total === 0
			? `OK. No records found to process for ${ONTOLOGY_MAIN_SECTION}`
			: errors.length === 0
				? `OK. Request completed successfully for ${ONTOLOGY_MAIN_SECTION}`
				: processed > 0
					? `Partial success. Some records processed for ${ONTOLOGY_MAIN_SECTION}`
					: `Request failed for ${ONTOLOGY_MAIN_SECTION}`;
	return { ok: succeeded, msg, errors, total, processed_count: processed };
}

/**
 * The error line a re-derive owes on top of its own `errors` (the rollback text, the
 * misfiled records), or null: a section holding records of which NONE declares a tld
 * projected nothing at all — a wholesale failure, never a per-record warning. Drift
 * without errors (a model whose tld is not imported yet, mid-install) is not an error.
 */
export function rebuildFailure(tld: string, rebuilt: OntologyWriteResult): string | null {
	if (rebuilt.errors.length > 0) return null;
	if (rebuilt.state.matrixNodes === 0 && rebuilt.state.tldlessNodes > 0) {
		return `${tld}: none of ${rebuilt.state.tldlessNodes} record(s) of ${tld}0 declares a tld — nothing projected`;
	}
	return null;
}

/** Rebuild several TLDs, collecting a per-TLD outcome. */
export async function rebuildOntologies(
	tlds: readonly string[],
	userId = -1,
): Promise<OntologyWriteResult[]> {
	const out: OntologyWriteResult[] = [];
	for (const tld of tlds) out.push(await rebuildOntology(tld, userId));
	return out;
}

/**
 * Whether `tld` has ANY source record in its `<tld>0` section — i.e. whether a rebuild of
 * it would re-derive something rather than just wipe (the SURF-1 repair's test for "this
 * row is addressable by its tld's rebuild"). False for an unsafe tld.
 */
export async function tldHasSourceRecords(rawTld: string): Promise<boolean> {
	const tld = safeTld(rawTld);
	if (tld === null) return false;
	const sectionTipo = mapTldToTargetSectionTipo(tld);
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === null) return false;
	const rows = (await sql.unsafe(`SELECT 1 FROM "${table}" WHERE section_tipo = $1 LIMIT 1`, [
		sectionTipo,
	])) as unknown[];
	return rows.length > 0;
}

/* ------------------------------------------------- machine-name columns */

/** What one post-migration derive did, per tld. */
export interface MachineNameDeriveOutcome {
	/** Tlds re-derived from their source records (rebuildOntology), with its outcome. */
	rebuilt: Record<string, Pick<OntologyWriteResult, 'ok' | 'msg' | 'errors'>>;
	/** Rows-only tlds (no source record): rows filled by the kernel's legacy derivation. */
	filled: Record<string, number>;
	/** Rows-only tlds whose fill threw (the error is logged here, never carried). */
	fillFailed: string[];
}

/**
 * THE POST-MIGRATION DERIVE (migration 0015, WC-2026-11-04-ontology-machine-names). Every
 * row from before the machine-name columns reads `use_machine_name` NULL; this re-derives
 * them, so no reader ever meets an underived row once it has run:
 *  - a tld WITH source records is REBUILT (`rebuildOntology`, `mainNode: 'existing'` — the
 *    registry is never written): the single writer re-parses every node, machine-name
 *    columns included. A rebuild is a projection, so it is sound on an ontology server too
 *    (it changes no source record);
 *  - a ROWS-ONLY tld (no source record: a seed scaffold row, an archive-restored or
 *    test-situation tld) cannot be re-parsed, and rebuilding it would wipe it; its NULL rows
 *    are re-upserted whole, unchanged, through the door — which fills the pair with the
 *    parser's own legacy derivation (db/dd_ontology.ts withMachineNameColumns).
 * Idempotent: a tld with no NULL row is not touched, so after one pass it is a no-op.
 * NON-FATAL per tld: a failed rebuild (a misfiled record, a resolution failure) is reported
 * in the outcome and logged; its rows stay NULL — and stale in inspect — until it is fixed.
 * Boot chore: server.ts runs it detached after the listener binds (never awaited).
 */
export async function deriveUnderivedMachineNames(userId = -1): Promise<MachineNameDeriveOutcome> {
	const outcome: MachineNameDeriveOutcome = { rebuilt: {}, filled: {}, fillFailed: [] };
	for (const tld of await listTldsWithUnderivedMachineNames()) {
		if (safeTld(tld) === null) continue;
		if (await tldHasSourceRecords(tld)) {
			const rebuilt = await rebuildOntology(tld, userId, { mainNode: 'existing' });
			outcome.rebuilt[tld] = { ok: rebuilt.ok, msg: rebuilt.msg, errors: rebuilt.errors };
			continue;
		}
		try {
			outcome.filled[tld] = await fillRowsOnlyMachineNames(tld);
		} catch (error) {
			// e.g. a legacy row that breaks the identifier grammar the door enforces:
			// that tld stays underived (and named here), the others still run.
			console.error(`[ontology_machine_names] filling rows-only tld '${tld}' failed:`, error);
			outcome.fillFailed.push(tld);
		}
	}
	return outcome;
}

/** Re-upsert every underived row of a rows-only tld through the door (see above). */
async function fillRowsOnlyMachineNames(tld: string): Promise<number> {
	return withTransaction(async () => {
		await lockOntologyProjection([tld]);
		let filled = 0;
		for (const tipo of await listUnderivedMachineNameTipos(tld)) {
			const row = await readDdOntologyRow(tipo);
			if (row === null || row.use_machine_name !== null) continue;
			await upsertDdOntologyNode(row);
			filled += 1;
		}
		return filled;
	});
}

/* --------------------------------------------------------------- registry */

/**
 * The TLDs a whole-install run inspects: every tld with a stored projection
 * (dd_ontology) or a registered hierarchy (hierarchy1's `hierarchy6`). A tld
 * with neither has nothing on either side and is not a pair to reconcile.
 */
export async function listProjectedTlds(): Promise<string[]> {
	const stored = (await sql.unsafe('SELECT DISTINCT tld FROM dd_ontology ORDER BY tld')) as {
		tld: string;
	}[];
	const registered = (await sql.unsafe(
		`SELECT DISTINCT lower(trim(item->>'value')) AS tld
		   FROM matrix_hierarchy_main, jsonb_array_elements(string->'hierarchy6') AS item
		  WHERE section_tipo = 'hierarchy1'`,
	)) as { tld: string | null }[];
	const out = new Set<string>();
	for (const row of [...stored, ...registered]) {
		const tld = row.tld === null ? null : safeTld(row.tld);
		if (tld !== null) out.add(tld);
	}
	return [...out].sort();
}

/**
 * Drift units of ONE inspected state: every drift item, plus the missing main
 * node WHEN the tld is provisioned on either side (a registered-but-never-
 * activated hierarchy has no main node and no records — nothing disagrees).
 */
export function ontologyDriftUnits(state: OntologyState): number {
	const provisioned = state.matrixNodes > 0 || state.storedNodes > 0;
	return state.drift.length + (provisioned && !state.mainNodeOk ? 1 : 0);
}

/**
 * The registry shape (core/reconcile/registry.ts, S-10): dd_ontology versus
 * the source records it is derived from. Apply = `rebuildOntology` of each
 * drifted tld (the destructive re-projection the ontology parser tool runs)
 * — which is why it never auto-applies. `scope` = tlds.
 */
export const ONTOLOGY_RECONCILE: ReconcileDefinition = {
	name: 'ontology',
	stores: ['ontology source records (<tld>0 sections)', 'dd_ontology (the parsed projection)'],
	description:
		"Compare each TLD's dd_ontology projection with the records it is parsed from (missing / stale / orphaned / misfiled nodes); apply re-derives every drifted TLD from its source.",
	scopeLabel: 'tld',
	schedule: 'operator',
	sources: ['src/core/ontology/ontology_state.ts'],
	async run({ apply, scope }) {
		const tlds = scope === undefined ? await listProjectedTlds() : [...scope];
		const states: Record<string, OntologyState> = {};
		const rebuilt: Record<string, OntologyWriteResult> = {};
		let drift = 0;
		let applied = 0;
		for (const tld of tlds) {
			const state = await inspectOntology(tld);
			states[tld] = state;
			const units = ontologyDriftUnits(state);
			drift += units;
			if (apply && units > 0) {
				const outcome = await rebuildOntology(tld);
				rebuilt[tld] = outcome;
				if (outcome.ok) applied += units;
			}
		}
		return { drift, applied, detail: { tlds, states, rebuilt } };
	},
};
