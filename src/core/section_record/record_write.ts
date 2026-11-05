/**
 * record_write — THE write chokepoint for key-level and column-level matrix
 * record persistence. TS re-expression of PHP section_record::save_key_data /
 * save_component_data / save / save_column (class.section_record.php:661/:805/
 * :539/:601) as stateless functions.
 *
 * Every writer that persists component keys into a matrix record MUST route
 * through persistRecordKeys (grep-gated by test/unit/section_record.test.ts):
 * that is what guarantees the PHP write contract everywhere —
 *
 *   1. AUDIT MERGE — the record's modified stamps (dd197 modified_by_user
 *      locator + dd201 modified_date) land in the SAME UPDATE statement as the
 *      component value (PHP save_component_data merges the metadata save_path
 *      before ONE update_by_key). Skipped for the Activity section and when no
 *      user is given (PHP build_modification_data :1584).
 *   2. KEY-REMOVAL SEMANTICS — value null removes the key with the exact PHP
 *      end state (oracle-verified): the column keeps '{}' after its last key,
 *      and a NULL column stays NULL (the PHP save_key_data "columns_to_delete"
 *      guard). Implemented inside updateMatrixKeysData via `#-`.
 *   3. SAVE EVENT — dependent caches invalidated after every persist
 *      (save_event.ts).
 *   3b. THE SECURITY REACTION — a write onto a USERS (dd128) or PROFILES (dd234)
 *      record drops the security caches AND, for the four account-transition
 *      components, ends that account's live credentials (security/revocation.ts
 *      reactToRecordComponentWrite). It hangs off THIS chokepoint for the same
 *      reason the audit stamps do: the alternative was one door remembering.
 *      `persistRecordKeys` reached NO invalidation at all, so a password rewritten
 *      through tool_propagate_component_data, a profile restored by the time
 *      machine, or an observer mirror onto dd128 revoked nothing and left every
 *      security cache stale. Two lanes, not one: the cache clears are idempotent
 *      and ride deferPostTransaction, the revocation is destructive and rides the
 *      COMMIT-ONLY lane.
 *   3c. THE RAG SEAM — every persisted write enqueues the record for re-indexing
 *      (PHP save() :988 enqueue_index). It fires from the SAME post-write hook as
 *      the save event (P1-8 / DATA-17, 2026-09-03): before that only
 *      persistRecordColumns and one save branch fired it, so a record delete
 *      rewrote every holder's relation bag through persistRecordKeys and enqueued
 *      NONE of them — the vector store kept naming the deleted target.
 *   3d. ONE HOOK, NOT THREE REMEMBERED CALLS — `afterRecordWrite` is the single
 *      post-write obligation hook of this module: save event + security reaction
 *      + RAG event. Every writer in this module ends in it, and the two record
 *      INSERT doors that bypass this module by design (create_record.ts,
 *      duplicate_record.ts) call it too, so "which obligations does this door
 *      fire" has exactly one answer. Gated by
 *      test/unit/write_obligations_tripwire.test.ts (doors × obligations, census
 *      TOTAL over the raw matrix_write callers) + write_obligations_native.test.ts.
 *   3e. THE DERIVED WRITES (CLOSURE_PLAN Step 2 — the obligation ledger,
 *      WC-2026-09-30-record-write-obligation-ledger). The chokepoint OWNS every
 *      derived write of a record write, so no door has one to remember:
 *        - the OBSERVER cascade — every writer here declares WHAT changed
 *          (`observed`, REQUIRED on afterRecordWrite): per key, the value before
 *          (read under the row lock, in the write's transaction) and after; the
 *          ledger (obligation_ledger.ts) drains it after COMMIT;
 *        - the `relation_search` ancestor index — derived from the value in the
 *          SAME UPDATE (relations/save.ts deriveRelationSearch), under the SAVE
 *          law for every writer but the three REMOVAL doors'
 *          (persistRelationRemovalKeys);
 *        - a COVERED OBSERVER slot (a mirror) and its frames are ONE unit
 *          (pinCoveredObserverSlots): a whole-record write over a live row keeps
 *          the live unit; a NEW record's birth stores none; an undelete stores
 *          the snapshot's (its ids pair its frames) — never declared, always
 *          recomputed from truth after COMMIT, whose hop tells the slot's own
 *          observers.
 *      The four escape hatches are separate ENTRY FUNCTIONS, not flag values,
 *      so the write census can see exactly who takes them (write_obligations leg
 *      B4): the removal law (persistRelationRemovalKeys — the three removal
 *      doors), the two cascade-owned writes (persistObserverMirrorKeys — the
 *      mirror recompute alone; persistObserverResaveKeys — the observer
 *      default branch's re-save through its own save rules alone, §3f) and the
 *      component restore (persistRestoredKeys — a
 *      restored covered slot is recomputed, never propagated). A write with no
 *      observed and no indexed key pays nothing: no transaction, no extra read.
 *   3f. THE KEY SAVE RULES (portal order model, WC-2026-10-31-portal-order-model) —
 *      every key a key entry writes passes `applyKeySaveRules` BEFORE it is
 *      persisted (and before its observed `after` is declared): today ONE rule,
 *      a relation key whose component declares a per-ddo `order` is written
 *      SORTED by that order (relations/order_locators.ts sortByDeclaredOrder —
 *      the one ordering function the read path and the reconcile share);
 *      identity for every other key. Every door therefore stores the declared
 *      order: the four key entries, the whole-record restore
 *      (persistRecordColumns) and every BIRTH (writeBirth, prepareBirthColumns —
 *      create-with-values and duplicate). The atomic append REFUSES a
 *      declared-order key (a concatenation cannot sort): save_component routes
 *      such an insert to the full-array persist under its own row lock.
 *   3g. THE MACHINE-NAME RULES (ontology machine names, plan §4 —
 *      WC-2026-11-04-ontology-machine-names; machine_name_save.ts): a key write
 *      onto an ontology node record (`<tld>0`, or a localontology0 override)
 *      touching the name / flag / label / model keys runs INSIDE one transaction
 *      with its own row lock and verdict: the save entries REFUSE a write that
 *      would introduce a machine-name violation (typed `ontology.machine_name_*`,
 *      400), the atomic append likewise; the RESTORE entries (persistRestoredKeys,
 *      persistRecordColumns, the birth) are never refused — the restored state
 *      passes through the conversion kernel (ontology/machine_name_rules.ts).
 *      Armed only on an ontology that defines ontology43 + ontology44.
 *   4. THE COMPONENT_IMAGE SVG ENVELOPE — a `media`-column write persists any
 *      `svg_file_data` its items carry to the .svg overlay file BEFORE the row
 *      write (PHP component_image::save → create_svg_file, which likewise
 *      precedes parent::save()). It is here, and not in one save door, because
 *      PHP's hook is on the component save every door funnels through; see
 *      media/svg_overlay.ts persistSvgEnvelopesForKeys.
 *
 * The SQL itself stays in db/matrix_write.ts (updateMatrixKeysData /
 * updateMatrixRecord) — this module owns the contract, not the statements.
 *
 * NOT a class on purpose: the PHP class shape (per-request instance singleton,
 * lazy JSON decode) is PHP-runtime machinery — see concepts/section_record.ts
 * for the mapping of the concept onto TS.
 */

import { canonicalEquals, canonicalJson } from '../concepts/canonical_json.ts';
import { ACTIVITY_SECTION_TIPO, AUDIT_TIPOS } from '../concepts/section.ts';
import { type MatrixJsonbColumn, readMatrixRecord } from '../db/matrix.ts';
import {
	appendMatrixKeyItems,
	insertMatrixRecordIfAbsent,
	type MatrixKeyWrite,
	type MatrixWriteValues,
	readMatrixKeyForUpdate,
	updateMatrixKeysData,
	updateMatrixRecord,
} from '../db/matrix_write.ts';
import { withTransaction } from '../db/postgres.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { machineNameScope } from '../ontology/machine_name_rules.ts';
import { componentDeclaresOrder, sortByDeclaredOrder } from '../relations/order_locators.ts';
import type { RelationSearchLaw } from '../relations/save.ts';
import { auditDateItem, auditUserLocator } from '../section/record/create_record.ts';
import {
	assertMachineNameAppend,
	assertMachineNameWrite,
	convertRestoredColumns,
	convertRestoredKeys,
	machineNameComponentsDefined,
} from './machine_name_save.ts';
import {
	assertObservedDeclared,
	enqueueObservedChange,
	isObservedTipo,
	type KeyChange,
	type ObservedDeclaration,
	type WriteReceipt,
} from './obligation_ledger.ts';
import { projectOntologyRecordLifecycle } from './ontology_projection.ts';
import { fireRagRecordEvent, fireSaveEvent } from './save_event.ts';

/** The record a write targets. The table comes from the ontology (getMatrixTableFromTipo). */
export interface RecordWriteTarget {
	table: string;
	sectionTipo: string;
	sectionId: number;
}

/**
 * One component-key write (PHP save_path item {column, key} + its value).
 * value null ⇒ REMOVE the key (PHP set_key_data(null) / delete_key).
 */
export type SavePathItem = MatrixKeyWrite;

/**
 * The modified-audit stamp for a write. Pass `false` ONLY when the caller
 * legitimately owns its own stamping (e.g. it already carries dd197/dd201 in
 * the savePath) or PHP itself skips it (system/maintenance writes that must
 * not touch the modified metadata, e.g. cache regeneration).
 */
export type AuditStamp = { userId: number; now?: Date } | false;

/**
 * WHO the derived writes run as, and where the interactive caller wants the
 * drain's same-record observer data (§3e). REQUIRED on every entry: the actor of
 * a write is a fact the caller holds, and an omitted one used to default to
 * nothing at all — the compiler now makes every door name it.
 */
export interface WriteDerivation {
	/** The principal the observer recomputes are attributed to (their TM rows, stamps). */
	actor: number;
	now?: Date;
	/** Filled after COMMIT with the same-record observer data (PHP observers_data). */
	receipt?: WriteReceipt;
	/**
	 * Told the savePath AS WRITTEN — after the key save rules (§3f) — once the
	 * UPDATE landed: a door that echoes the stored value (save_component: a
	 * declared-order portal comes back sorted) reads it here instead of echoing
	 * the value it handed in. Key entries only.
	 */
	onWritten?: (written: readonly SavePathItem[]) => void;
}

/**
 * Build the modified-audit savePath items (PHP get_modified_section_save_path
 * mode 'update_record' → build_modification_data): dd197 user locator into
 * `relation`, dd201 virtual date into `date`. Empty for the Activity section
 * or a missing user — PHP :1584 returns {} for both.
 */
export function buildModifiedAuditWrites(sectionTipo: string, audit: AuditStamp): SavePathItem[] {
	if (audit === false || !audit.userId || sectionTipo === ACTIVITY_SECTION_TIPO) {
		return [];
	}
	const now = audit.now ?? new Date();
	return [
		{
			column: 'relation',
			key: AUDIT_TIPOS.modifiedByUser,
			value: [auditUserLocator(audit.userId, AUDIT_TIPOS.modifiedByUser)],
		},
		{
			column: 'date',
			key: AUDIT_TIPOS.modifiedDate,
			value: [auditDateItem(now)],
		},
	];
}

/**
 * Persist one or more component keys of a record — value(s) + modified-audit
 * stamps + the derived `relation_search` keys in ONE UPDATE, then the post-write
 * hook with the keys' before/after (§3e).
 *
 * This is the PHP save_component_data contract; with audit=false it degrades
 * to plain save_key_data.
 */
export async function persistRecordKeys(
	target: RecordWriteTarget,
	savePath: readonly SavePathItem[],
	audit: AuditStamp,
	derived: WriteDerivation,
): Promise<void> {
	await writeKeyEntry(target, savePath, audit, derived, {
		door: 'persistRecordKeys',
		law: 'save',
		ledger: true,
		coveredSlots: 'change',
	});
}

/**
 * THE COMPONENT-RESTORE entry (§3e): persistRecordKeys for a door that writes a
 * key's PAST value — the Time Machine's apply_value and the bulk revert-undo's
 * key write (enumerated by write_obligations_tripwire leg B4). Identical to
 * persistRecordKeys for every key but a COVERED OBSERVER slot (a
 * set_dato_external mirror): its past value is a past DERIVATION — whoever
 * referenced the record THEN. It is written (it stands for the transaction, so
 * the frames the restore puts back pair to its items), but it is NEVER declared
 * as a change: propagated, the transient value reaches the slot's own observers
 * as truth — a phantom referencer's back-mirror would list this record again,
 * and the per-operation recompute dedup would keep it there. The slot is queued
 * instead for its recompute from truth after COMMIT (requestCoveredSlotRecompute,
 * same stamp posture), and THAT write hops with what it dropped (observers.ts
 * recomputeMirrorAndHop). Gated by obligation_ledger_native cases 14 and 14b–d.
 */
export async function persistRestoredKeys(
	target: RecordWriteTarget,
	savePath: readonly SavePathItem[],
	audit: AuditStamp,
	derived: WriteDerivation,
): Promise<void> {
	await writeKeyEntry(target, savePath, audit, derived, {
		door: 'persistRestoredKeys',
		law: 'save',
		ledger: true,
		coveredSlots: 'recompute',
	});
}

/**
 * THE REMOVAL-LAW entry (§3e): identical to persistRecordKeys, except that EVERY
 * relation key it writes is re-indexed (P1-7 — the removal doors' law), not only
 * an autocomplete_hi one. Exactly three doors may take it — the portal locator
 * delete (relations/save.ts deletePortalLocator), the record delete's
 * inverse-reference strip and the data wipe (delete_record.ts) — enumerated by
 * write_obligations_tripwire leg B4.
 */
export async function persistRelationRemovalKeys(
	target: RecordWriteTarget,
	savePath: readonly SavePathItem[],
	audit: AuditStamp,
	derived: WriteDerivation,
): Promise<void> {
	await writeKeyEntry(target, savePath, audit, derived, {
		door: 'persistRelationRemovalKeys',
		law: 'removal',
		ledger: true,
		coveredSlots: 'change',
	});
}

/**
 * THE CASCADE-OWNED entry (§3e): the observer recompute's mirror write
 * (observers.ts recomputeExternalRelation). The save law applies — an `_hi`
 * mirror gets its ancestor index from what is actually STORED, a withheld
 * shrink included (CORE-2) — but NO ledger entry is made: the cascade hops the
 * written observer itself (emitCascadeHop, bounded and deduplicated), and a
 * ledger entry would re-enter it. Only the recompute may take it (leg B4).
 */
export async function persistObserverMirrorKeys(
	target: RecordWriteTarget,
	savePath: readonly SavePathItem[],
	audit: AuditStamp,
	derived: WriteDerivation,
): Promise<void> {
	await writeKeyEntry(target, savePath, audit, derived, {
		door: 'persistObserverMirrorKeys',
		law: 'save',
		ledger: false,
		coveredSlots: 'change',
	});
}

/**
 * THE SECOND CASCADE-OWNED entry (§3e/§3f, portal order model —
 * WC-2026-10-31-portal-order-model + the dated addendum on
 * WC-2026-08-02-observer-relay-writes-nothing): the observer DEFAULT branch's
 * RE-SAVE (observers.ts resaveObserverThroughSaveRules) — an observer whose
 * stored value its OWN save rules (applyKeySaveRules — today: a declared-order
 * portal is re-sorted) would change, written back as those rules leave it.
 * The save law applies like any key write (the rules run again inside
 * writeKeys: idempotent over a value they produced); NO ledger entry: the
 * relay's own emitCascadeHop re-enters propagation for the observer, and a
 * ledger entry would dispatch it a second time. Only the re-save may take it
 * (write_obligations_tripwire leg B4 — the twin of the mirror row above).
 */
export async function persistObserverResaveKeys(
	target: RecordWriteTarget,
	savePath: readonly SavePathItem[],
	audit: AuditStamp,
	derived: WriteDerivation,
): Promise<void> {
	await writeKeyEntry(target, savePath, audit, derived, {
		door: 'persistObserverResaveKeys',
		law: 'save',
		ledger: false,
		coveredSlots: 'change',
	});
}

interface KeyWriteMode {
	door: string;
	law: RelationSearchLaw;
	/** false = cascade-owned (no ledger entry, no before-image read). */
	ledger: boolean;
	/**
	 * What a written COVERED OBSERVER slot declares: `change` — like any key (an
	 * ordinary save of a mirror is the curator's value, owner decision pending in
	 * WC-2026-09-30-record-write-obligation-ledger); `recompute` — a restored past
	 * derivation: never propagated, recomputed after COMMIT (persistRestoredKeys).
	 */
	coveredSlots: 'change' | 'recompute';
}

/** The COVERED OBSERVER slots among a savePath's relation keys (a restored past derivation). */
async function coveredSlotKeys(savePath: readonly SavePathItem[]): Promise<string[]> {
	const { isCoveredObserverTipo } = await import('../section/record/observers.ts');
	const slots: string[] = [];
	for (const item of savePath) {
		if (item.column === 'relation' && (await isCoveredObserverTipo(item.key))) {
			slots.push(item.key);
		}
	}
	return slots;
}

/** A stored or written key value as an item list (`[]` when absent / not an array). */
function asItems(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

/**
 * The derived obligations of a savePath: the keys an observer watches (they need
 * a before-image) and the relation keys the law indexes. Both empty ⇒ the plain
 * write, exactly as before the ledger — no transaction, no extra read.
 */
async function planKeyObligations(
	savePath: readonly SavePathItem[],
	mode: KeyWriteMode,
): Promise<{ observed: SavePathItem[]; indexed: SavePathItem[]; recomputed: string[] }> {
	// A restored covered slot is RECOMPUTED, never declared as a change (see mode.coveredSlots).
	const recomputed =
		mode.ledger && mode.coveredSlots === 'recompute' ? await coveredSlotKeys(savePath) : [];
	const observed = mode.ledger ? await observedItems(savePath, recomputed) : [];
	return { observed, indexed: await indexedRelationItems(savePath, mode.law), recomputed };
}

/** The savePath items an observer watches, minus the recomputed covered slots. */
async function observedItems(
	savePath: readonly SavePathItem[],
	recomputed: readonly string[],
): Promise<SavePathItem[]> {
	const observed: SavePathItem[] = [];
	for (const item of savePath) {
		if (recomputed.includes(item.key)) continue;
		if (await isObservedTipo(item.key)) observed.push(item);
	}
	return observed;
}

/** The relation items the `relation_search` law indexes. */
async function indexedRelationItems(
	savePath: readonly SavePathItem[],
	law: RelationSearchLaw,
): Promise<SavePathItem[]> {
	const { relationSearchLaw } = await import('../relations/save.ts');
	const indexed: SavePathItem[] = [];
	for (const item of savePath) {
		if (item.column === 'relation' && (await relationSearchLaw(item.key, law))) {
			indexed.push(item);
		}
	}
	return indexed;
}

/**
 * Whether a stored `relation_search[tipo]` disagrees with the index the SAVE law
 * derives from `value` — the READ half of the derivation, owned here with it (so
 * the law has one home): the observer recompute asks it when a mirror's value
 * already agrees, to find a mirror written before its index was (CORE-2). False
 * for a tipo the law keeps no index for; an empty derivation equals an absent key.
 */
export async function hiIndexDisagrees(
	tipo: string,
	value: readonly unknown[],
	storedIndex: unknown,
): Promise<boolean> {
	const { deriveRelationSearch } = await import('../relations/save.ts');
	const derived = await deriveRelationSearch(tipo, value, 'save');
	if (derived === null) return false;
	const stored = Array.isArray(storedIndex) ? storedIndex : [];
	return canonicalJson(stored) !== canonicalJson(derived);
}

/** The derived `relation_search` writes of the indexed keys (empty ⇒ key removed). */
async function relationSearchWrites(
	indexed: readonly SavePathItem[],
	law: RelationSearchLaw,
): Promise<SavePathItem[]> {
	const { deriveRelationSearch } = await import('../relations/save.ts');
	const writes: SavePathItem[] = [];
	for (const item of indexed) {
		const index = await deriveRelationSearch(item.key, asItems(item.value), law);
		if (index === null) continue;
		writes.push({
			column: 'relation_search',
			key: item.key,
			value: index.length > 0 ? index : null,
		});
	}
	return writes;
}

/** The relation bag of a whole-record write as one key write per parent-candidate key. */
function relationKeyWrites(relation: unknown): SavePathItem[] {
	return Object.entries(bagOf(relation)).map(([key, value]) => ({
		column: 'relation' as MatrixJsonbColumn,
		key,
		value,
	}));
}

/**
 * The cycle check of a WHOLE-RECORD write's relation bag (absent bag: nothing
 * to check) — persistRecordColumns (`replace`) and writeBirth (`birth`).
 */
async function assertRelationBagAcyclic(
	target: RecordWriteTarget,
	relation: unknown,
	mode: 'replace' | 'birth',
): Promise<void> {
	await assertParentLinkKeys(target, relationKeyWrites(relation), mode);
}

/**
 * ONT-5 — THE CYCLE CHECK of every component_relation_parent key a chokepoint
 * write carries (relations/parent.ts assertParentLinkKeysAcyclic), in the
 * writer's transaction, after its row lock, before its write: `replace` (the
 * value is the whole key), `append` (added to the stored items), `birth` (the
 * row was just inserted: every stored link is added). A write with no relation
 * key costs nothing.
 */
async function assertParentLinkKeys(
	target: RecordWriteTarget,
	writes: readonly SavePathItem[],
	mode: 'replace' | 'append' | 'birth',
): Promise<void> {
	if (!writes.some((write) => write.column === 'relation')) return;
	// CONVENTIONS §2 rationale 1 — cycle-breaking at the write chokepoint:
	// parent.ts writes THROUGH this chokepoint (persistTreeKeys).
	const { assertParentLinkKeysAcyclic } = await import('../relations/parent.ts');
	await assertParentLinkKeysAcyclic(target, writes, mode);
}

/** True when `savePath` writes a parent key (it must not take the fast path). */
async function writesParentLink(savePath: readonly SavePathItem[]): Promise<boolean> {
	if (!savePath.some((item) => item.column === 'relation')) return false;
	// CONVENTIONS §2 rationale 1 (see assertParentLinkKeys).
	const { hasParentLinkWrite } = await import('../relations/parent.ts');
	return hasParentLinkWrite(savePath);
}

/** A key write with nothing to write is a caller defect, never a no-op. */
function assertSavePathNotEmpty(
	target: RecordWriteTarget,
	savePath: readonly SavePathItem[],
	door: string,
): void {
	if (savePath.length > 0) return;
	throw new DedaloError('internal.invariant', {
		message: `${door}: empty savePath`,
		coordinates: {
			table: target.table,
			section_tipo: target.sectionTipo,
			section_id: target.sectionId,
		},
	});
}

/** The SVG envelope step of writeKeys (§4) — only a write carrying a media key. */
async function persistSvgEnvelopes(
	target: RecordWriteTarget,
	savePath: readonly SavePathItem[],
): Promise<void> {
	if (!savePath.some((item) => item.column === 'media')) return;
	const { persistSvgEnvelopesForKeys } = await import('../media/svg_overlay.ts');
	await persistSvgEnvelopesForKeys(target, savePath);
}

/**
 * THE KEY SAVE RULES (§3f) — the ONE function every key write applies to a key
 * before it persists, exported so the observer re-save (the generalized default
 * branch) passes a stored value through exactly the rules a save would. Pure in
 * effect: reads the ontology (and, for a declared-order portal, runs the
 * system-scoped rank search over the linked records), writes nothing.
 *
 * Today ONE rule: a value whose component declares a per-ddo `order` comes back
 * SORTED by it (relations/order_locators.ts sortByDeclaredOrder); every other
 * key, a non-array value and a value with fewer than two items come back AS
 * GIVEN (the same reference — callers may compare by identity). Only relation
 * values carry locators; a literal component declares no `order`, so the gate
 * is the declaration itself.
 */
export async function applyKeySaveRules(
	target: RecordWriteTarget,
	key: string,
	value: unknown,
): Promise<unknown> {
	if (!Array.isArray(value) || value.length < 2) return value;
	const sorted = await sortByDeclaredOrder(value, key, target.sectionTipo);
	return sorted ?? value;
}

/** A savePath through the key save rules (§3f): relation keys only, others untouched. */
async function applySaveRulesToPath(
	target: RecordWriteTarget,
	savePath: readonly SavePathItem[],
): Promise<readonly SavePathItem[]> {
	if (!savePath.some((item) => item.column === 'relation')) return savePath;
	const ruled: SavePathItem[] = [];
	for (const item of savePath) {
		if (item.column !== 'relation') {
			ruled.push(item);
			continue;
		}
		const value = await applyKeySaveRules(target, item.key, item.value);
		ruled.push(value === item.value ? item : { ...item, value });
	}
	return ruled;
}

/** The relation column of a whole-record write as a keyed bag, or null when it is none. */
function relationBagOf(values: MatrixWriteValues): Record<string, unknown> | null {
	const relation = values.relation;
	if (relation === null || typeof relation !== 'object' || Array.isArray(relation)) return null;
	return relation as Record<string, unknown>;
}

/** A whole-record relation bag through the key save rules (§3f), in place. */
async function applySaveRulesToBag(
	target: RecordWriteTarget,
	values: MatrixWriteValues,
): Promise<void> {
	const bag = relationBagOf(values);
	if (bag === null) return;
	let ruled: Record<string, unknown> | null = null;
	for (const [key, value] of Object.entries(bag)) {
		const sorted = await applyKeySaveRules(target, key, value);
		if (sorted === value) continue;
		ruled ??= { ...bag };
		ruled[key] = sorted;
	}
	// A fresh bag object: the caller's columns are never mutated through it.
	if (ruled !== null) values.relation = ruled;
}

/**
 * THE KEY WRITE shared by the key entries: the key save rules (§3f), the
 * machine-name rules (§3g — only an ontology node record, in one transaction
 * with the write), then the key write proper (writeKeys): the SVG envelope
 * (§4), then — inside ONE transaction when anything derived is owed — the
 * before-image of every observed key under the row lock, ONE UPDATE carrying
 * the values, the derived index keys and the stamps, and the post-write hook
 * with the change.
 */
async function writeKeyEntry(
	target: RecordWriteTarget,
	givenPath: readonly SavePathItem[],
	audit: AuditStamp,
	derived: WriteDerivation,
	mode: KeyWriteMode,
): Promise<void> {
	assertSavePathNotEmpty(target, givenPath, mode.door);
	// 3f. THE KEY SAVE RULES — before anything reads the values: the envelope,
	//    the observed `after`, the derived index and the UPDATE all see the key
	//    as it will be STORED (a declared-order portal: sorted).
	const ruledPath = await applySaveRulesToPath(target, givenPath);
	// 3g. THE MACHINE-NAME RULES (ontology node records only — a Set lookup for
	//    every other write): checked, or for a restore converted, under the row
	//    lock inside ONE transaction with the write itself, so the verdict reads
	//    the record the UPDATE replaces and a refusal rolls everything back.
	if (await machineNameRulesApply(target, ruledPath)) {
		await withTransaction(async () => {
			const savePath = await machineNameRuledPath(target, ruledPath, mode.door);
			await writeKeys(target, savePath, audit, derived, mode);
		});
		return;
	}
	await writeKeys(target, ruledPath, audit, derived, mode);
}

/** §3g scope: an ontology node record write the rules read, on an ontology that defines them. */
async function machineNameRulesApply(
	target: RecordWriteTarget,
	savePath: readonly SavePathItem[],
): Promise<boolean> {
	const keys = savePath.map((item) => item.key);
	if (machineNameScope(target.sectionTipo, keys) === null) return false;
	return machineNameComponentsDefined();
}

/**
 * §3g verdict, inside the write's transaction: a RESTORE entry's path through the
 * conversion kernel (never refused); every other entry's path checked as given
 * (a refusal throws a typed `ontology.machine_name_*`).
 */
async function machineNameRuledPath(
	target: RecordWriteTarget,
	savePath: readonly SavePathItem[],
	door: string,
): Promise<readonly SavePathItem[]> {
	if (door === 'persistRestoredKeys') return convertRestoredKeys(target, savePath, door);
	await assertMachineNameWrite(target, savePath);
	return savePath;
}

/** The key write proper, after the key save rules (§3f) and the machine-name rules (§3g). */
async function writeKeys(
	target: RecordWriteTarget,
	savePath: readonly SavePathItem[],
	audit: AuditStamp,
	derived: WriteDerivation,
	mode: KeyWriteMode,
): Promise<void> {
	// 4. COMPONENT_IMAGE SVG ENVELOPE (PHP component_image::save :119-133 →
	//    create_svg_file). The vector editor ships the drawing inside the saved
	//    item as `svg_file_data`, a TEMPORAL CONTAINER, and the SAVE is what turns
	//    it into the .svg envelope the edit view loads as an <object>; without this
	//    the annotation layers ("Capas de dibujo") existed in the database and
	//    nowhere the image itself is shown. It hangs off THIS chokepoint, not off
	//    one save door, because PHP's hook is on the component save that every door
	//    reaches — and it runs BEFORE the row write exactly as PHP's does (a
	//    refused payload must fail the save, not follow it).
	//    Column-gated before the import so the hot path of every non-media write
	//    pays nothing.
	await persistSvgEnvelopes(target, savePath);

	const auditWrites = buildModifiedAuditWrites(target.sectionTipo, audit);
	const touchedKeys = [...savePath, ...auditWrites].map((item) => item.key);
	const plan = await planKeyObligations(savePath, mode);
	// A parent key is never written transaction-less: its cycle check needs the
	// row lock held to COMMIT (ONT-5), so it takes the transaction path below.
	const parentLink = await writesParentLink(savePath);

	if (plan.observed.length === 0 && plan.indexed.length === 0 && !parentLink) {
		const affected = await updateMatrixKeysData(
			target.table,
			target.sectionTipo,
			target.sectionId,
			[...savePath, ...auditWrites],
		);
		assertRecordStillExists(affected, target, mode.door);
		await afterRecordWrite(target, {
			door: mode.door,
			touchedKeys,
			rag: 'index',
			observed: mode.ledger
				? { kind: 'keys', changes: [], actor: derived.actor, now: derived.now }
				: { kind: 'cascade-owned' },
			receipt: derived.receipt,
		});
		await requestRestoredSlotRecompute(target, plan.recomputed, audit, derived);
		derived.onWritten?.(savePath);
		return;
	}

	await withTransaction(async () => {
		// The BEFORE-IMAGE, under the row lock (joining the caller's lock when it
		// already holds one): what an observer needs to learn which records this
		// write DROPPED. A vanished row is the S2-02 conflict, before anything is
		// written.
		const changes: KeyChange[] = [];
		for (const item of plan.observed) {
			const before = await readMatrixKeyForUpdate(
				target.table,
				target.sectionTipo,
				target.sectionId,
				item.column,
				item.key,
			);
			if (before === null) assertRecordStillExists(0, target, mode.door);
			changes.push({
				column: item.column,
				tipo: item.key,
				before: before ?? [],
				after: asItems(item.value),
			});
		}
		if (parentLink) await assertParentLinkKeys(target, savePath, 'replace');
		const indexWrites = await relationSearchWrites(plan.indexed, mode.law);
		const affected = await updateMatrixKeysData(
			target.table,
			target.sectionTipo,
			target.sectionId,
			[...savePath, ...indexWrites, ...auditWrites],
		);
		assertRecordStillExists(affected, target, mode.door);
		await afterRecordWrite(target, {
			door: mode.door,
			touchedKeys,
			rag: 'index',
			observed: mode.ledger
				? { kind: 'keys', changes, actor: derived.actor, now: derived.now }
				: { kind: 'cascade-owned' },
			receipt: derived.receipt,
		});
		await requestRestoredSlotRecompute(target, plan.recomputed, audit, derived);
	});
	derived.onWritten?.(savePath);
}

/**
 * The restored covered slots' recompute (persistRestoredKeys): queued on the
 * ledger in the write's own transaction, drained after its COMMIT — with the
 * write's stamp posture (a restore whose run owns the stamps leaves them).
 */
async function requestRestoredSlotRecompute(
	target: RecordWriteTarget,
	slots: readonly string[],
	audit: AuditStamp,
	derived: WriteDerivation,
): Promise<void> {
	if (slots.length === 0) return;
	await requestCoveredSlotRecompute(
		target,
		audit,
		{ actor: derived.actor, now: derived.now },
		slots,
	);
}

/**
 * THE ATOMIC-APPEND entry (saveComponentData's pure-insert branch): the items
 * are CONCATENATED inside the UPDATE (`COALESCE(col->key,'[]') || $n`, so two
 * concurrent inserts both survive — a deliberate divergence from the
 * read-modify-write shape), then ONE UPDATE carries the modified stamps and the
 * derived `relation_search` of the key AS STORED (read back under the row lock
 * the append took), then the hook — whose before-image is the stored value minus
 * the appended items (an append removes nothing by construction).
 */
export async function persistAppendedKeyItems(
	target: RecordWriteTarget,
	column: MatrixJsonbColumn,
	key: string,
	inserts: readonly unknown[],
	audit: AuditStamp,
	derived: WriteDerivation,
): Promise<void> {
	await assertAppendableKey(target, column, key);
	await withTransaction(async () => {
		// §3g — the machine-name rules over the stored value plus the inserts.
		await assertMachineNameAppend(target, column, key, inserts);
		await assertParentLinkKeys(target, [{ column, key, value: inserts }], 'append');
		const appended = await appendMatrixKeyItems(
			target.table,
			target.sectionTipo,
			target.sectionId,
			column,
			key,
			inserts,
		);
		assertRecordStillExists(appended, target, 'persistAppendedKeyItems');
		const item: SavePathItem = { column, key, value: null };
		const plan = await planKeyObligations([item], {
			door: 'persistAppendedKeyItems',
			law: 'save',
			ledger: true,
			coveredSlots: 'change',
		});
		const changes: KeyChange[] = [];
		let indexWrites: SavePathItem[] = [];
		if (plan.observed.length > 0 || plan.indexed.length > 0) {
			// The append's UPDATE holds the row lock: this read sees the key as stored.
			const stored =
				(await readMatrixKeyForUpdate(
					target.table,
					target.sectionTipo,
					target.sectionId,
					column,
					key,
				)) ?? [];
			if (plan.observed.length > 0) {
				changes.push({
					column,
					tipo: key,
					before: withoutAppended(stored, inserts),
					after: stored,
				});
			}
			indexWrites = await relationSearchWrites(
				plan.indexed.map((indexed) => ({ ...indexed, value: stored })),
				'save',
			);
		}
		const auditWrites = buildModifiedAuditWrites(target.sectionTipo, audit);
		const writes = [...indexWrites, ...auditWrites];
		if (writes.length > 0) {
			const affected = await updateMatrixKeysData(
				target.table,
				target.sectionTipo,
				target.sectionId,
				writes,
			);
			assertRecordStillExists(affected, target, 'persistAppendedKeyItems');
		}
		await afterRecordWrite(target, {
			door: 'persistAppendedKeyItems',
			touchedKeys: [key, ...auditWrites.map((write) => write.key)],
			rag: 'index',
			observed: { kind: 'keys', changes, actor: derived.actor, now: derived.now },
			receipt: derived.receipt,
		});
	});
}

/**
 * §3f — the atomic append REFUSES a key the save rules would rewrite: a
 * concatenation inside the UPDATE cannot sort, and an append that skipped the
 * rule would store a declared-order portal out of order. Not a client fault: the
 * one caller (save_component's pure-insert branch) routes such a key to the
 * full-array persist itself, so reaching here is a programming error.
 */
async function assertAppendableKey(
	target: RecordWriteTarget,
	column: MatrixJsonbColumn,
	key: string,
): Promise<void> {
	if (column !== 'relation') return;
	if (!(await componentDeclaresOrder(key, target.sectionTipo))) return;
	throw new DedaloError('internal.invariant', {
		message: `persistAppendedKeyItems: '${key}' declares an order — a declared-order key is never appended atomically (route it to persistRecordKeys)`,
		coordinates: {
			table: target.table,
			section_tipo: target.sectionTipo,
			section_id: target.sectionId,
			tipo: key,
			reason: 'declared_order',
		},
	});
}

/**
 * The stored items minus ONE occurrence of each appended item. Matched on
 * CANONICAL JSON: jsonb re-orders an object's keys, so the stored twin of an
 * appended item never serializes like the item the caller built.
 */
function withoutAppended(stored: readonly unknown[], inserts: readonly unknown[]): unknown[] {
	const pending = inserts.map((insert) => canonicalJson(insert));
	const kept: unknown[] = [];
	for (const entry of stored) {
		const index = pending.indexOf(canonicalJson(entry));
		if (index >= 0) pending.splice(index, 1);
		else kept.push(entry);
	}
	return kept;
}

/**
 * The downstream obligations of ONE persisted record write (§3, §3b, §3c, §3e).
 *
 * `touchedKeys` — the component tipos the write landed on (the security reaction
 * decides on them; the audit stamps may ride along, they are inert there).
 * `rag` — `'index'` for a write that changed record CONTENT; `null` for a write
 * that touched only the modified stamps (persistModifiedStamp), whose data door
 * fires its own index event — stated by the caller, never defaulted, so the
 * tripwire can pin every null.
 * `door` — the writer's name, threaded into the revocation log line.
 * `observed` — WHAT changed, for the observer cascade (obligation_ledger.ts);
 * REQUIRED, like `rag`: a writer states `none` with its reason rather than
 * omitting it.
 * `receipt` — where the interactive caller collects the same-record observer data.
 */
export interface RecordWriteObligations {
	door: string;
	touchedKeys: readonly string[];
	rag: 'index' | null;
	observed: ObservedDeclaration;
	receipt?: WriteReceipt;
}

/**
 * THE post-write hook (§3d). Order is load-bearing and mirrors the pre-hook
 * order of the callers it replaced: the cache fan-out first (deferred to
 * COMMIT/ROLLBACK under an ambient transaction — save_event.ts), then the
 * security reaction (idempotent clears on the deferred lane, the revocation on
 * the COMMIT-ONLY lane), then the RAG seam (best-effort; the enqueue joins the
 * ambient transaction so a rolled-back write leaves no marker), then the
 * observer obligation (§3e — queued on the COMMIT-ONLY lane, or drained inline
 * with no transaction). None of the first three may fail the write: each
 * swallows and logs its own failure. The ledger only refuses a write whose
 * transaction already settled (a leaked continuation).
 */
export async function afterRecordWrite(
	target: RecordWriteTarget,
	obligations: RecordWriteObligations,
): Promise<void> {
	// FIRST, before any fan-out: a caller that declared no observer change is a
	// typed refusal naming its door, never a TypeError from inside the ledger.
	assertObservedDeclared(target, obligations.observed, obligations.door);
	await fireSaveEvent(target.sectionTipo);
	await reactToSecurityWrite(target, obligations.touchedKeys, obligations.door);
	if (obligations.rag !== null) {
		await fireRagRecordEvent({
			kind: obligations.rag,
			sectionTipo: target.sectionTipo,
			sectionId: target.sectionId,
		});
	}
	await enqueueObservedChange(target, obligations.observed, obligations.receipt);
}

/**
 * The security sections. A plain tipo compare so the hot path of every ordinary write
 * pays two string comparisons and nothing else — no import, no allocation. The tipos
 * are re-asserted against `security/revocation.ts` by
 * test/unit/dd128_write_census_tripwire.test.ts, so the two copies cannot drift.
 */
const SECURITY_REACTIVE_SECTIONS: ReadonlySet<string> = new Set(['dd128', 'dd234']);

/**
 * Fire the security reaction for the components this write touched (see §3b above).
 *
 * Best-effort and never rethrows: the row is already written by the time this runs, so
 * turning a revocation failure into a failed save would roll back an edit the operator
 * would simply repeat — and the revocation itself already logs loudly. It is also the
 * reason the door name is passed down: an operator reading `[revocation] dd128/dd133
 * write (persistRecordKeys)` can tell which door ended the sessions.
 */
async function reactToSecurityWrite(
	target: RecordWriteTarget,
	componentTipos: readonly string[],
	door: string,
): Promise<void> {
	if (!SECURITY_REACTIVE_SECTIONS.has(target.sectionTipo)) return;
	try {
		const { reactToRecordComponentWrite } = await import('../security/revocation.ts');
		await reactToRecordComponentWrite(target.sectionTipo, target.sectionId, componentTipos, door);
	} catch (error) {
		console.error(
			`[record_write] the security reaction failed after ${door} on ${target.sectionTipo}/${String(target.sectionId)} — sessions, media markers or security caches may be stale:`,
			error,
		);
	}
}

/**
 * S2-02 consumer-side fail-loud: an UPDATE matching 0 rows means the record was
 * deleted (or never existed) — a save racing a delete used to no-op with
 * `ok:true`, silently discarding the user's data. Throw instead so the API
 * surfaces the conflict and nothing pretends the write landed.
 */
function assertRecordStillExists(
	affected: number,
	target: RecordWriteTarget,
	caller: string,
): void {
	if (affected === 0) {
		throw new DedaloError('resource.conflict', {
			message: `${caller}: record ${target.sectionTipo}/${target.sectionId} not found in ${target.table} — it was deleted concurrently (or never existed); the write did not land`,
			coordinates: {
				table: target.table,
				section_tipo: target.sectionTipo,
				section_id: target.sectionId,
				caller,
			},
		});
	}
}

/**
 * Persist ONLY the modified-audit stamps (PHP update_modified_section_data,
 * class.section_record.php:1530) — used by writers that refresh a record's
 * dd197/dd201 once after several unstamped key writes (the delete pipeline's
 * owners, the data wipe). No-op for the Activity section / missing user
 * (PHP :1584).
 */
export async function persistModifiedStamp(
	target: RecordWriteTarget,
	audit: Exclude<AuditStamp, false>,
): Promise<void> {
	const writes = buildModifiedAuditWrites(target.sectionTipo, audit);
	if (writes.length === 0) return;
	const affected = await updateMatrixKeysData(
		target.table,
		target.sectionTipo,
		target.sectionId,
		writes,
	);
	assertRecordStillExists(affected, target, 'persistModifiedStamp');
	// rag: null — a stamp-only write. The DATA door that called this (the delete
	// pipeline, the data wipe) fires the index event for the content it wrote;
	// firing it twice here would only dedupe in the queue. Pinned as the one null
	// cell of the obligations matrix. Nothing observable changed either.
	await afterRecordWrite(target, {
		door: 'persistModifiedStamp',
		touchedKeys: [],
		rag: null,
		observed: { kind: 'none', reason: 'stamp-only' },
	});
}

/** A jsonb column value as a key bag (`{}` when null / absent / not an object). */
function bagOf(value: unknown): Record<string, unknown> {
	return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/**
 * Merge the modified stamps into the column objects of a whole-record write (the
 * caller passes the FULL intended content of any column it includes).
 */
function mergeAuditStamps(values: MatrixWriteValues, sectionTipo: string, audit: AuditStamp): void {
	for (const write of buildModifiedAuditWrites(sectionTipo, audit)) {
		const bag = { ...bagOf(values[write.column]) };
		bag[write.key] = write.value;
		values[write.column] = bag;
	}
}

/** Every component tipo inside the column bags of a whole-record write. */
function columnKeys(values: MatrixWriteValues): string[] {
	return Object.values(values).flatMap((bag) =>
		bag !== null && bag !== undefined && typeof bag === 'object' ? Object.keys(bag) : [],
	);
}

/**
 * THE COVERED UNIT (§3e): a COVERED OBSERVER slot (a set_dato_external mirror —
 * DERIVED state, "who references me") AND the frames its dataframe slots hold
 * for it. The two are one unit of meaning: a frame pairs with a mirror ITEM by
 * `id_key → id`, and the recompute keeps the id of every referencer still
 * present (its order-preserving merge) but mints fresh ids — 1..N in reference
 * order — into an EMPTY mirror. So a write that keeps or drops the main without
 * its frames re-pairs a curator's frame onto ANOTHER referencer the moment the
 * recompute runs. Every whole-record law below moves the unit whole.
 *
 * The slots of the unit: the main's declared dataframe slots ∪ every key of
 * either bag holding one of its frames (relations/dataframe_slots.ts
 * slotsFromBag — the slot set of every TM reader). Within a slot only the
 * MAIN's frames move (isOwnFrame — a shared slot's other mains' frames stay as
 * written); a slot left with nothing is removed.
 */
async function coveredUnitSlots(
	main: string,
	written: Record<string, unknown>,
	source: Record<string, unknown>,
): Promise<string[]> {
	const { slotsFromBag } = await import('../relations/dataframe_slots.ts');
	const slots = new Set((await slotsFromBag(main, written)).slots);
	for (const slot of (await slotsFromBag(main, source)).slots) slots.add(slot);
	return [...slots];
}

/**
 * Set a covered unit inside `relation` (in place) to its image in `source`: the
 * main to `source[main]` (absent ⇒ removed), and in every slot of the unit the
 * main's own frames to the ones `source` holds (none ⇒ dropped). `source` `{}`
 * DROPS the unit (a birth of a NEW record: nothing references it yet).
 */
async function setCoveredUnit(
	relation: Record<string, unknown>,
	main: string,
	source: Record<string, unknown>,
): Promise<void> {
	const { isFrameEntry, isOwnFrame, restoreSlot } = await import('../relations/dataframe_slots.ts');
	const ownFrames = (value: unknown): unknown[] =>
		(Array.isArray(value) ? value : []).filter(
			(entry) => isFrameEntry(entry) && isOwnFrame(entry, main),
		);
	for (const slot of await coveredUnitSlots(main, relation, source)) {
		if (slot === main) continue;
		const next = restoreSlot(relation[slot], main, ownFrames(source[slot]));
		if (next.length > 0) relation[slot] = next;
		else delete relation[slot];
	}
	if (main in source) relation[main] = source[main];
	else delete relation[main];
}

/** The COVERED OBSERVER slots among a relation bag's keys (and `extra` keys). */
async function coveredSlotsOf(
	relation: Record<string, unknown>,
	extra: Record<string, unknown> = {},
): Promise<string[]> {
	const { isCoveredObserverTipo } = await import('../section/record/observers.ts');
	const covered: string[] = [];
	for (const tipo of new Set([...Object.keys(relation), ...Object.keys(extra)])) {
		if (await isCoveredObserverTipo(tipo)) covered.push(tipo);
	}
	return covered;
}

/**
 * The COVERED UNITS of a whole-record write over a LIVE row never come from the
 * caller (§3e): a mirror is DERIVED state, and a snapshot's copy of it is
 * whatever the referencers were THEN — a restored term brought its phantom
 * referencers back verbatim (CORE-1, case 9). Each unit keeps its LIVE image —
 * the main AND its frames, so every frame still pairs with the live item it was
 * written for (a live main beside the snapshot's frames re-paired them) — and
 * the main is queued for a recompute from truth. `relation` untouched by the
 * write ⇒ nothing to pin. Returns the pinned mains.
 */
async function pinCoveredObserverSlots(
	values: MatrixWriteValues,
	live: Record<string, unknown>,
): Promise<string[]> {
	if (!('relation' in values)) return [];
	const relation = { ...bagOf(values.relation) };
	const pinned = await coveredSlotsOf(relation, live);
	if (pinned.length === 0) return [];
	for (const main of pinned) await setCoveredUnit(relation, main, live);
	values.relation = relation;
	return pinned;
}

/**
 * The COVERED UNITS of a NEW record's birth (create, duplicate) are DROPPED,
 * main and frames: a stored copy is never the new record's truth — an
 * `inverse_search` mirror is empty by construction (nothing can reference a
 * record that does not exist yet; a duplicate's copy of it, and the frames on
 * it, are the SOURCE's referencers'), a copy law's (`source_overwrite`,
 * `observed_data`) is recomputed from the record's own data after the insert
 * (ownDataCoveredSlots), and a create's `dato_default` on a covered slot is a
 * phantom (case 7d). Frames left behind
 * would pair with the ids the first recompute mints (1..N): a frame of the
 * source's referencer landing on the clone's. In place. Returns the dropped
 * mains (each still recomputed after the insert).
 */
export async function dropCoveredObserverUnits(
	values: MatrixWriteValues,
	/** Covered mains whose frames may be present WITHOUT the main (a door that already left the main out). */
	knownMains: readonly string[] = [],
): Promise<string[]> {
	if (!('relation' in values)) return [];
	const relation = { ...bagOf(values.relation) };
	const dropped = [...new Set([...(await coveredSlotsOf(relation)), ...knownMains])];
	if (dropped.length === 0) return [];
	for (const main of dropped) await setCoveredUnit(relation, main, {});
	values.relation = relation;
	return dropped;
}

/**
 * THE INDEX OF A WHOLE-RECORD WRITE (§3e). Untouched when no `_hi` key is in
 * play — the column is written exactly as the caller gave it (or not at all).
 * Otherwise every `_hi` key of the old relation, the new relation and the base
 * index is RE-DERIVED from the new relation value (absent or empty ⇒ the key
 * goes): the base is the caller's index, else the live one — a snapshot taken
 * before the index existed (PHP-era history) carries none, and falling back to
 * `{}` would silently drop every other key.
 */
async function rederiveHiIndex(
	values: MatrixWriteValues,
	liveColumns: Record<string, unknown> | null,
): Promise<void> {
	if (!('relation' in values)) return;
	const relation = bagOf(values.relation);
	const base = hiIndexBase(values, liveColumns);
	const candidates = new Set([
		...Object.keys(relation),
		...Object.keys(bagOf(liveColumns?.relation)),
		...Object.keys(base),
	]);
	if (!(await rederiveIndexedKeys(candidates, relation, base))) return;
	values.relation_search = Object.keys(base).length > 0 ? base : null;
}

/** The index a whole-record write re-derives ONTO: the caller's, else the live one (a copy). */
function hiIndexBase(
	values: MatrixWriteValues,
	liveColumns: Record<string, unknown> | null,
): Record<string, unknown> {
	return {
		...bagOf(
			values.relation_search !== undefined
				? values.relation_search
				: liveColumns === null
					? undefined
					: liveColumns.relation_search,
		),
	};
}

/**
 * Re-derive, IN PLACE on `base`, every candidate key the save law indexes
 * (absent or empty ⇒ the key goes). True when any candidate was indexed.
 */
async function rederiveIndexedKeys(
	candidates: ReadonlySet<string>,
	relation: Record<string, unknown>,
	base: Record<string, unknown>,
): Promise<boolean> {
	const { relationSearchLaw, deriveRelationSearch } = await import('../relations/save.ts');
	let touched = false;
	for (const tipo of candidates) {
		if (!(await relationSearchLaw(tipo, 'save'))) continue;
		touched = true;
		const index = await deriveRelationSearch(tipo, relation[tipo], 'save');
		if (index !== null && index.length > 0) base[tipo] = index;
		else delete base[tipo];
	}
	return touched;
}

/** The before/after of every key in the written columns (the ledger keeps the observed ones). */
function wholeRecordChanges(
	values: MatrixWriteValues,
	liveColumns: Record<string, unknown>,
	pinned: readonly string[],
): KeyChange[] {
	const changes: KeyChange[] = [];
	for (const [column, value] of Object.entries(values)) {
		if (column === 'relation_search' || column === 'data' || column === 'meta') continue;
		changes.push(...columnKeyChanges(column, bagOf(liveColumns[column]), bagOf(value), pinned));
	}
	return changes;
}

/** The before/after of every key of ONE written column (pinned covered slots of `relation` skipped). */
function columnKeyChanges(
	column: string,
	before: Record<string, unknown>,
	after: Record<string, unknown>,
	pinned: readonly string[],
): KeyChange[] {
	const changes: KeyChange[] = [];
	for (const tipo of new Set([...Object.keys(before), ...Object.keys(after)])) {
		if (column === 'relation' && pinned.includes(tipo)) continue;
		changes.push({ column, tipo, before: asItems(before[tipo]), after: asItems(after[tipo]) });
	}
	return changes;
}

/**
 * A whole-record write's door (persistRecordColumns): every component tipo the
 * write changes, asked once; THROWS to refuse.
 */
export type ChangedKeysDoor = (componentTipos: readonly string[]) => Promise<void>;

/**
 * Every component tipo whose stored value `values` CHANGES against the live row:
 * each key of each written column bag present on either side and not equal
 * (canonical JSON — key order is not a change). The non-component columns are
 * skipped like wholeRecordChanges skips them (`relation_search` is derived,
 * `data` / `meta` are record metadata). A covered observer slot was pinned to its
 * live value before this runs, so it is never reported. Sorted, unique.
 */
function changedComponentKeys(
	values: MatrixWriteValues,
	liveColumns: Record<string, unknown>,
): string[] {
	const changed = new Set<string>();
	for (const [column, value] of Object.entries(values)) {
		if (NON_COMPONENT_COLUMNS.has(column)) continue;
		for (const tipo of changedBagKeys(bagOf(liveColumns[column]), bagOf(value))) {
			changed.add(tipo);
		}
	}
	return [...changed].sort();
}

/** The written columns that hold no component (changedComponentKeys skips them). */
const NON_COMPONENT_COLUMNS: ReadonlySet<string> = new Set(['relation_search', 'data', 'meta']);

/** The keys of one column bag present on either side whose values differ (canonical JSON). */
function changedBagKeys(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
	return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
		(tipo) => !canonicalEquals(before[tipo] ?? null, after[tipo] ?? null),
	);
}

/**
 * Ask a whole-record write's door (persistRecordColumns) with what the CALLER's
 * columns change. The modified stamps the chokepoint merges after this overwrite
 * whatever the caller's columns hold there (an older snapshot's differ from the
 * live ones): never the caller's to authorize, never asked. No door: nothing asked.
 */
async function askChangedKeysDoor(
	door: ChangedKeysDoor | undefined,
	target: RecordWriteTarget,
	audit: AuditStamp,
	values: MatrixWriteValues,
	liveColumns: Record<string, unknown>,
): Promise<void> {
	if (door === undefined) return;
	const stamped = new Set(buildModifiedAuditWrites(target.sectionTipo, audit).map((w) => w.key));
	await door(changedComponentKeys(values, liveColumns).filter((tipo) => !stamped.has(tipo)));
}

/**
 * Persist whole columns of a record (PHP save / save_column / the create()
 * update mode; the TM full-record restore path). Columns not present in
 * `columns` are untouched; a column set to null becomes SQL NULL.
 *
 * When an audit stamp is given, the dd197/dd201 modified items are MERGED into
 * the provided `relation`/`date` column objects so everything lands in the one
 * upsert — the caller must therefore pass the FULL intended content of any
 * column it includes (whole-column writes replace, they do not patch).
 *
 * UNDER THE ROW LOCK, in one transaction (§3e): the live row is read first — the
 * before-image of every key the write replaces, the base of the derived index,
 * the live value of each covered observer slot. An ABSENT row makes the write a
 * BIRTH at that address (an undelete: the same record continuing, so no
 * generation epoch) — `'inserted'`; a row that appears under a racing insert is
 * then replaced under its lock like any live one.
 *
 * Ends in afterRecordWrite like every writer here (save event, security
 * reaction, the RAG 'index' seam — PHP save() :564 enqueues the record for
 * re-indexing on every full save — and the observer ledger).
 *
 * `door` (cross-write:r3): the caller's WRITE DOOR, asked under the row lock and
 * before the update with every component tipo whose stored value this write
 * CHANGES ({@link changedComponentKeys}) — what a whole-record restore writes is
 * decided here, behind the lock, so no caller can judge a stale image. A throw
 * rolls the write back. A BIRTH (absent row: an undelete) never asks it — a
 * record lifecycle effect, authorized at the section like a create or a delete.
 * The chokepoint itself authorizes nothing (no principal): a door that writes on
 * a principal's behalf passes one.
 */
export async function persistRecordColumns(
	target: RecordWriteTarget,
	columns: MatrixWriteValues,
	audit: AuditStamp,
	derived: WriteDerivation,
	door?: ChangedKeysDoor,
): Promise<'updated' | 'inserted'> {
	if (
		Object.keys(columns).length === 0 &&
		buildModifiedAuditWrites(target.sectionTipo, audit).length === 0
	) {
		throw new DedaloError('internal.invariant', {
			message: 'persistRecordColumns: empty columns payload',
			coordinates: {
				table: target.table,
				section_tipo: target.sectionTipo,
				section_id: target.sectionId,
			},
		});
	}
	return withTransaction(async () => {
		if ((await lockRecordRow(target)) === null) {
			if ((await writeBirth(target, columns, audit, derived, 'persistRecordColumns')) !== null) {
				return 'inserted';
			}
			// A row landed at the address between the lock probe and the insert:
			// it is live now, and replaced under its own lock like any other.
			if ((await lockRecordRow(target)) === null) {
				assertRecordStillExists(0, target, 'persistRecordColumns');
			}
		}
		const live = (await readMatrixRecord(target.table, target.sectionTipo, target.sectionId))
			?.columns as Record<string, unknown> | undefined;
		if (live === undefined) assertRecordStillExists(0, target, 'persistRecordColumns');
		const liveColumns = live ?? {};
		await assertRelationBagAcyclic(target, columns.relation, 'replace');
		const values: MatrixWriteValues = { ...columns };
		// §3f — a restored relation bag stores every declared-order key sorted.
		await applySaveRulesToBag(target, values);
		// §3g — a restore is never refused: an ontology node's legacy name is
		// converted into the shape the node has now (machine_name_save.ts).
		await convertRestoredColumns(target, values, liveColumns, 'persistRecordColumns');
		const pinned = await pinCoveredObserverSlots(values, bagOf(liveColumns.relation));
		await rederiveHiIndex(values, liveColumns);
		await askChangedKeysDoor(door, target, audit, values, liveColumns);
		mergeAuditStamps(values, target.sectionTipo, audit);
		const changes = wholeRecordChanges(values, liveColumns, pinned);
		await updateMatrixRecord(target.table, target.sectionTipo, target.sectionId, values);
		// The WHOLE-COLUMN door — the Time Machine's full-record restore. Its keys are the
		// component tipos inside each column bag, so a restore that puts back an old dd133
		// or flips dd131 is an account transition exactly like a per-key save, and used to
		// be the one shape that reached nothing at all.
		await afterRecordWrite(target, {
			door: 'persistRecordColumns',
			touchedKeys: columnKeys(values),
			rag: 'index',
			observed: {
				kind: 'replace',
				changes,
				selfRecompute: pinned,
				actor: derived.actor,
				now: derived.now,
			},
			receipt: derived.receipt,
		});
		return 'updated';
	});
}

/**
 * The row lock of a whole-record write (any tipo-grammar key works: the lock is
 * the row's). `null` = no row at the address.
 */
async function lockRecordRow(target: RecordWriteTarget): Promise<unknown[] | null> {
	return readMatrixKeyForUpdate(
		target.table,
		target.sectionTipo,
		target.sectionId,
		'date',
		AUDIT_TIPOS.modifiedDate,
	);
}

/**
 * THE INSERT-IF-ABSENT entry — a record BIRTH at a known address (the undelete:
 * the time machine's and the bulk revert's). Answers the columns AS WRITTEN, or
 * `null` — nothing written — when a row stands at the address (never
 * overwritten: a record created there since the delete is someone else's).
 *
 * What it writes (§3e), in ONE insert: the columns as given — its COVERED
 * UNITS included, the snapshot's mirror beside the frames that pair with it —
 * the `_hi` index re-derived from today's thesaurus (the snapshot's is the
 * delete-time chain), and the stamps unless `audit` is false (a verbatim
 * undelete). The record CONTINUES at its address, so its mirror ids are the
 * pairing keys of its frames: written back, every referencer still present
 * keeps its id (and its frame) through the recompute's merge; dropped, the
 * recompute minted fresh ids 1..N and each frame landed on another referencer.
 * The snapshot's mirror is a past DERIVATION, so it is never DECLARED: the
 * birth's edges exclude every covered slot (a phantom referencer must not reach
 * the mirror's own observers), and every covered slot the section declares is
 * recomputed from truth after COMMIT — its hop then tells those observers
 * (obligation_ledger.ts drainEntry). The hook declares the rest as a birth:
 * every edge the record carries is new to its targets' mirrors. Never reads the
 * row back — inside the caller's transaction it would only see what it just
 * wrote.
 */
export async function persistRecordBirth(
	target: RecordWriteTarget,
	columns: MatrixWriteValues,
	audit: AuditStamp,
	derived: WriteDerivation,
): Promise<MatrixWriteValues | null> {
	return withTransaction(() => writeBirth(target, columns, audit, derived, 'persistRecordBirth'));
}

/**
 * THE BIRTH COLUMNS (§3e) — what every NEW record stores, whichever door
 * inserts it: its covered units LEFT OUT, main and frames
 * (dropCoveredObserverUnits — nothing references a new record; each main is
 * recomputed from truth — the returned tipos) and the
 * `_hi` ancestor index RE-DERIVED from the relation the row will actually
 * carry (the base index given in `values.relation_search` is kept for every
 * other key; an `_hi` key whose relation value is absent loses its index). In
 * place; no read, no write. Shared by the chokepoint's own birth entry and the
 * two INSERT doors that bypass it by design (create_record.ts,
 * duplicate_record.ts) — a clone that copied its source's index verbatim while
 * dropping the mirror it indexes stored an index for a value it did not hold,
 * and a broader-term search matched it.
 */
export async function prepareBirthColumns(
	values: MatrixWriteValues,
	sectionTipo?: string,
): Promise<string[]> {
	const dropped = await dropCoveredObserverUnits(values);
	// §3f — a birth stores every declared-order key sorted (create-with-values,
	// duplicate). The host section, when the caller does not name it, is each
	// component's ontology ancestor (order_locators.ts sortByDeclaredOrder).
	await applySaveRulesToBag({ table: '', sectionTipo: sectionTipo ?? '', sectionId: 0 }, values);
	await rederiveHiIndex(values, null);
	return dropped;
}

/**
 * Every COVERED OBSERVER slot a section DECLARES (the one section census the
 * wipe shares — section/record/declared_components.ts: own ∪ real subtree,
 * crossing nested sections), whatever a given row stores. A record that
 * CONTINUES at its address after a gap (an undelete, a wiped record restored)
 * may have referencers that re-appeared while it was gone — a referencer
 * undeleted first carries its locator onto the missing record — so its mirrors
 * are recomputed from truth by DECLARATION, not only the keys its snapshot
 * happened to carry (a snapshot taken after its last referencer left has none).
 */
async function declaredCoveredSlots(sectionTipo: string): Promise<string[]> {
	const { declaredSectionComponents } = await import('../section/record/declared_components.ts');
	const { isCoveredObserverTipo } = await import('../section/record/observers.ts');
	const slots: string[] = [];
	for (const component of await declaredSectionComponents(sectionTipo)) {
		if (await isCoveredObserverTipo(component.tipo)) slots.push(component.tipo);
	}
	return slots;
}

/**
 * The COVERED OBSERVER slots a section declares whose value law reads the
 * RECORD'S OWN DATA (external_laws/: `source_overwrite` — the copy of the bag
 * its own pointer names; `observed_data` — the locators of its own text's
 * tags), by declaration. A NEW record born carrying data (a duplicate copies
 * its source's pointer and text) is NOT empty by construction there: only the
 * `inverse_search` mirror ("who references me") is — nothing can reference a
 * record that does not exist yet. So a birth that copies data recomputes these
 * slots from truth after its insert (its selfRecompute), never inherits the
 * source's stored copy (dropped with the other covered units). Refused laws are
 * not covered (isCoveredObserverTipo), so they never reach the list.
 */
export async function ownDataCoveredSlots(sectionTipo: string): Promise<string[]> {
	const { getExternalLaw } = await import('../section/record/external_laws/classify.ts');
	const slots: string[] = [];
	for (const slot of await declaredCoveredSlots(sectionTipo)) {
		const law = await getExternalLaw(slot);
		if (law.kind === 'source_overwrite' || law.kind === 'observed_data') slots.push(slot);
	}
	return slots;
}

/**
 * THE COVERED-SLOT RECOMPUTE entry (§3e): nothing is written — the record's
 * COVERED OBSERVER slots are queued for a recompute from truth after the
 * caller's COMMIT (inline with no transaction). A mirror is derived state, so a
 * restore never leaves one as its history said it was — the snapshot's copy is
 * whoever referenced the record THEN. Two kinds of door take it (enumerated by
 * write_obligations_tripwire leg B4):
 *   - a door that puts a record's keys back one by one and never passes a
 *     whole-record entry (the bulk revert's soft-cascade restore): EVERY slot
 *     the section declares (`only` omitted — the census the wipe shares);
 *   - the COMPONENT-RESTORE entry (persistRestoredKeys — the Time Machine's
 *     apply_value of a mirror's history row, the bulk revert-undo's key write,
 *     the soft-cascade restore's key write), for the covered slots it wrote:
 *     `only` = exactly those (each already proved covered by
 *     isCoveredObserverTipo — never narrowed by the census, which a slot it
 *     misses would leave written and never recomputed). The restored value
 *     stands for the transaction — its dataframe frames pair to its items, and
 *     the items that still reference the record keep their ids (the
 *     recompute's order-preserving merge), so their frames survive — and
 *     converges on truth after COMMIT: a phantom referencer is dropped with its
 *     frame, and the recompute's hop tells the slot's own observers.
 */
export async function requestCoveredSlotRecompute(
	target: RecordWriteTarget,
	audit: AuditStamp,
	derived: WriteDerivation,
	only?: readonly string[],
): Promise<void> {
	const slots = only === undefined ? await declaredCoveredSlots(target.sectionTipo) : [...only];
	if (slots.length === 0) return;
	await enqueueObservedChange(target, {
		kind: 'recompute',
		slots,
		// The caller's stamp posture: a restore that leaves the record's stamps
		// alone (its run owns them) has its mirrors recomputed without them too.
		verbatim: audit === false,
		actor: derived.actor,
		now: derived.now,
	});
}

/** The birth write shared by persistRecordBirth and persistRecordColumns' absent-row path. */
async function writeBirth(
	target: RecordWriteTarget,
	columns: MatrixWriteValues,
	audit: AuditStamp,
	derived: WriteDerivation,
	door: string,
): Promise<MatrixWriteValues | null> {
	const values: MatrixWriteValues = { ...columns };
	// §3f — every declared-order key is born sorted (the index below is derived
	// from the bag as stored).
	await applySaveRulesToBag(target, values);
	// §3g — an undelete is a restore: converted, never refused (machine_name_save.ts).
	await convertRestoredColumns(target, values, null, door);
	// The covered units stand as given (see persistRecordBirth); only the index
	// is re-derived from what the row carries.
	const kept = await coveredSlotsOf(bagOf(values.relation));
	await rederiveHiIndex(values, null);
	// A birth at a KNOWN address is a record continuing there (an undelete): its
	// mirrors are recomputed by declaration, not only the slots its snapshot held
	// (declaredCoveredSlots) — and never declared as edges (the ledger excludes
	// every selfRecompute slot from a birth's changes).
	const selfRecompute = [
		...new Set([...kept, ...(await declaredCoveredSlots(target.sectionTipo))]),
	];
	mergeAuditStamps(values, target.sectionTipo, audit);
	if (
		!(await insertMatrixRecordIfAbsent(
			target.table,
			target.sectionTipo,
			target.sectionId,
			values as Partial<Record<MatrixJsonbColumn, unknown>>,
		))
	) {
		return null;
	}
	await assertRelationBagAcyclic(target, values.relation, 'birth');
	// THE ONTOLOGY NODE comes back with its record (ONT-3): an undelete of a
	// `<tld>0` record re-projects `<tld><id>` (only into a projected tld, never
	// into another tld's namespace), an override's undelete re-projects the node
	// it overrides — HERE, inside the birth's transaction (not the post-COMMIT
	// ledger drain): a rolled-back undelete takes its node with it, and no drift
	// window follows the commit. Every door that births at a known address
	// passes here (TM undelete, bulk revert); create/duplicate do not (PHP parity).
	// Any other section answers 'none' without touching the database.
	await projectOntologyRecordLifecycle(
		target.sectionTipo,
		target.sectionId,
		'birth',
		values.relation,
	);
	await afterRecordWrite(target, {
		door,
		touchedKeys: columnKeys(values),
		rag: 'index',
		observed: {
			kind: 'birth',
			columns: values,
			selfRecompute,
			// No stamps merged = the snapshot's own kept: a VERBATIM birth, whose
			// covered-slot recomputes must not stamp it either (obligation_ledger.ts).
			verbatim: audit === false,
			actor: derived.actor,
			now: derived.now,
		},
		receipt: derived.receipt,
	});
	return values;
}
