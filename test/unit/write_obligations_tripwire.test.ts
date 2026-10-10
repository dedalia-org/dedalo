/**
 * TRIPWIRE — EVERY DOWNSTREAM OBLIGATION OF A RECORD WRITE FIRES FROM THE
 * CHOKEPOINT, NOT FROM WHICHEVER CALLER REMEMBERED (P1-8: DATA-15..19, DATA-28,
 * DATA-29; CLOSURE_PLAN Step 2: the obligation ledger — CORE-1, CORE-2, TOOLS-5).
 *
 * A component write incurs obligations the writer does not own: the save event,
 * the security reaction (dd128/dd234), the RAG index event, the modified stamps,
 * the 'NEW' activity row for a birth, the OBSERVER cascade (which needs the
 * BEFORE-image: a removed locator's mirror must drop the record) and the `_hi`
 * ancestor index (`relation_search`). Each used to be a call a door REMEMBERED,
 * and the doors that forgot are the findings: the time machine's whole-record
 * restores never propagated, the observer recompute wrote an `_hi` mirror with
 * no index, three media doors wrote files_info raw over an unlocked snapshot.
 *
 * The structural answer: the CHOKEPOINTS own every derived write.
 * `afterRecordWrite` (section_record/record_write.ts) is the one hook; it
 * enqueues the observed change on the OBLIGATION LEDGER
 * (section_record/obligation_ledger.ts), which drains post-commit; the
 * chokepoint writers derive `relation_search` in the same UPDATE; the one
 * files_info writer is reached only through the locked transform. This gate
 * holds that shape DERIVED from the import-resolved writer closure
 * (test/helpers/matrix_writer_closure.ts) — never from body substrings:
 *
 *   A. CENSUS — TOTAL over every raw `db/matrix_write.ts` DML caller in the
 *      write-path corpus: each must REACH `afterRecordWrite` through resolved
 *      references (any depth), or carry an ENUMERATED, shrink-only exemption —
 *      partitioned into chokepoints, PENDING units, the SANCTIONED derived
 *      writers (the ONE list tool_lossless shares — rows derived from it) and
 *      the enumerated non-derived writers.
 *   B. THE LEDGER, DERIVED —
 *      B1 every RECORD_WRITE_CHOKEPOINTS unit reaches afterRecordWrite;
 *      B2 afterRecordWrite reaches the save event, the security reaction, the
 *         RAG event and the ledger; the ledger reaches the observer cascade;
 *      B3 the chokepoint writers AND the two INSERT doors (create, duplicate)
 *         reach the relation_search derivation, and only record_write units
 *         MAY call it (every edge — a namespace escape counts);
 *      B4 EXCLUSIVITY, two-sided: the ONLY units that MAY call (every edge, a
 *         namespace escape included) the cascade, the recompute unit and
 *         kernel, the ledger's enqueue, the derivation's birth law, the
 *         removal-law, mirror and covered-slot entries, the per-key kernel
 *         (its flag-value hatches: only the four named entries reach it) and
 *         the files_info writer are the enumerated ones, and each enumerated caller PROVABLY
 *         still calls it — a door that remembers an obligation itself is red;
 *         and every afterRecordWrite caller outside the chokepoint is pinned to
 *         the outcome case holding what it declares;
 *      B5 positive controls: a synthetic corpus with each offence is reported
 *         by the same analysers;
 *      PENDING the raw tree-move and archive-restore writers the closure names
 *         are enumerated with the step that closes them; any change to one is
 *         red (a change detector, labelled as one).
 *   S. SPELLING CHECKS (labelled honestly: they read source text) — the NEW
 *      activity emitters, the door activity rows, the birth funnel, the
 *      component_info stored branch.
 *   C. TIMING — the three cache branches of `fireSaveEvent` ride
 *      `deferPostTransaction`.
 *   D. observers.ts TOTAL — every `catch` block increments a counter; the
 *      in-transaction rethrow lane is GONE (B6: propagation never runs inside a
 *      transaction, so there is nothing to rethrow into).
 *
 * The behavioural twins: write_obligations_native (every door's obligation
 * effects), obligation_ledger_native (the ledger's outcomes: restore/undelete
 * propagation, the `_hi` recompute index, post-commit drain, savepoints),
 * media_files_info_lost_update_native (the locked media transform).
 */

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	AFTER_RECORD_WRITE,
	buildWriterClosure,
	MATRIX_WRITE,
	MATRIX_WRITE_NON_DML,
	moduleRuntimeExports,
	RAW_PRIMITIVES,
	type RawCall,
	RECORD_WRITE_CHOKEPOINTS,
	rawCallsIn,
	SANCTIONED_DERIVED_WRITERS,
	topLevelBlocks,
	type WriterClosure,
} from '../helpers/matrix_writer_closure.ts';
import { stripComments } from '../helpers/strip_comments.ts';
import {
	REPO_ROOT,
	WRITE_PATH_CORPUS_FLOOR,
	writePathSourceFiles,
} from '../helpers/write_path_corpus.ts';

const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8');
/** Source with comments stripped — the S legs read CODE, never prose. */
const code = (rel: string): string => stripComments(read(rel));

const RECORD_WRITE = 'src/core/section_record/record_write.ts';
const LEDGER = 'src/core/section_record/obligation_ledger.ts';
const SAVE_EVENT = 'src/core/section_record/save_event.ts';
const CREATE_RECORD = 'src/core/section/record/create_record.ts';
const DUPLICATE_RECORD = 'src/core/section/record/duplicate_record.ts';
const DELETE_RECORD = 'src/core/section/record/delete_record.ts';
const RELATIONS_SAVE = 'src/core/relations/save.ts';
const OBSERVERS = 'src/core/section/record/observers.ts';
const FILES_INFO_PERSIST = 'src/core/media/tools/files_info_persist.ts';
const DD_CORE_API = 'src/core/api/handlers/dd_core_api.ts';
const CACHE_INVALIDATION = 'src/core/ontology/cache_invalidation.ts';
const INFO_EMIT = 'src/core/components/component_info/emit.ts';

/** The unit keys the ledger legs name. */
const U = {
	afterRecordWrite: AFTER_RECORD_WRITE,
	writeKeys: `${RECORD_WRITE}#writeKeys`,
	persistRecordKeys: `${RECORD_WRITE}#persistRecordKeys`,
	persistRecordColumns: `${RECORD_WRITE}#persistRecordColumns`,
	persistRecordBirth: `${RECORD_WRITE}#persistRecordBirth`,
	persistAppendedKeyItems: `${RECORD_WRITE}#persistAppendedKeyItems`,
	persistRelationRemovalKeys: `${RECORD_WRITE}#persistRelationRemovalKeys`,
	persistRestoredKeys: `${RECORD_WRITE}#persistRestoredKeys`,
	requestRestoredSlotRecompute: `${RECORD_WRITE}#requestRestoredSlotRecompute`,
	persistObserverMirrorKeys: `${RECORD_WRITE}#persistObserverMirrorKeys`,
	reactToSecurityWrite: `${RECORD_WRITE}#reactToSecurityWrite`,
	fireSaveEvent: `${SAVE_EVENT}#fireSaveEvent`,
	fireRagRecordEvent: `${SAVE_EVENT}#fireRagRecordEvent`,
	enqueueObservedChange: `${LEDGER}#enqueueObservedChange`,
	drainEntry: `${LEDGER}#drainEntry`,
	propagateToObservers: `${OBSERVERS}#propagateToObservers`,
	recomputeMirrorAndHop: `${OBSERVERS}#recomputeMirrorAndHop`,
	runObserverCascadeHop: `${OBSERVERS}#runObserverCascadeHop`,
	recomputeExternalRelation: `${OBSERVERS}#recomputeExternalRelation`,
	requestCoveredSlotRecompute: `${RECORD_WRITE}#requestCoveredSlotRecompute`,
	prepareBirthColumns: `${RECORD_WRITE}#prepareBirthColumns`,
	dropCoveredObserverUnits: `${RECORD_WRITE}#dropCoveredObserverUnits`,
	writeBirth: `${RECORD_WRITE}#writeBirth`,
	createSectionRecord: `${CREATE_RECORD}#createSectionRecord`,
	duplicateSectionRecord: `${DUPLICATE_RECORD}#duplicateSectionRecord`,
	deleteSectionRecord: `${DELETE_RECORD}#deleteSectionRecord`,
	defaultReconcileIO: 'src/core/section/record/observer_reconcile.ts#defaultReconcileIO',
	restoreWipedRecord: 'tools/tool_time_machine/server/bulk_revert_records.ts#restoreWipedRecord',
	writeWipedKey: 'tools/tool_time_machine/server/bulk_revert_records.ts#writeWipedKey',
	toolTimeMachineApplyValue:
		'tools/tool_time_machine/server/tool_time_machine.ts#toolTimeMachineApplyValue',
	writeRevertedKey: 'tools/tool_time_machine/server/bulk_revert_undo.ts#writeRevertedKey',
	writeComposedUnit: 'tools/tool_time_machine/server/bulk_revert_undo.ts#writeComposedUnit',
	archiveWriteRecordRow: 'src/core/archive/restore.ts#writeRecordRow',
	deriveRelationSearch: `${RELATIONS_SAVE}#deriveRelationSearch`,
	removePortalLocatorUnderGrant: `${RELATIONS_SAVE}#removePortalLocatorUnderGrant`,
	removeAllInverseReferences: `${DELETE_RECORD}#removeAllInverseReferences`,
	deleteSectionData: `${DELETE_RECORD}#deleteSectionData`,
	writeItems: `${FILES_INFO_PERSIST}#writeItems`,
	transformStoredMediaItems: `${FILES_INFO_PERSIST}#transformStoredMediaItems`,
} as const;

/** THE closure over the write-path corpus — every derived leg reads this one build. */
const CLOSURE: WriterClosure = buildWriterClosure();

// ---------------------------------------------------------------------------
// A. THE CENSUS
// ---------------------------------------------------------------------------

/**
 * Raw callers that legitimately do NOT reach the obligation hook, per
 * declaration. Every row is a deliberate decision with its reason; the list is
 * SHRINK-ONLY and a row whose declaration starts reaching the hook (unless it
 * says it is a chokepoint) or stops calling a primitive is red.
 */
const RAW_CALLER_EXEMPT: Record<string, string> = {
	// The SANCTIONED DERIVED WRITERS — ONE list (test/helpers/matrix_writer_closure.ts),
	// shared with tool_lossless's bypass reasons: their rows are DERIVED from it, never
	// restated (leg A's partition test holds the other direction).
	...SANCTIONED_DERIVED_WRITERS,
	[`${RECORD_WRITE}#persistModifiedStamp`]:
		'THE chokepoint (stamp-only): it ends in afterRecordWrite with rag:null (chokepoint).',
	[`${RECORD_WRITE}#persistRecordColumns`]:
		'THE chokepoint (whole-column): it ends in afterRecordWrite (chokepoint).',
	[`${DELETE_RECORD}#deleteSectionRecord`]:
		'the row DELETE: there is no record left to stamp or to index; it fires the save event, the RAG delete event and the observer cascade itself, and its holders are rewritten through persistRecordKeys (chokepoint).',
	[`${DUPLICATE_RECORD}#duplicateSectionRecord`]:
		'the record INSERT door that bypasses the chokepoint by design (a clone carries every column at once); it declares the obligations for itself through afterRecordWrite (chokepoint).',
	[`${CREATE_RECORD}#createSectionRecord`]:
		'the record INSERT door that bypasses the chokepoint by design (a fresh row carries its birth columns at once); it declares the obligations for itself through afterRecordWrite and appends the NEW activity row (chokepoint).',
	'src/core/retention/prune.ts#registerRetentionCatalog':
		"the RETENTION prune of matrix_activity (audit 2026-08-26 P2-9): it DELETES aged audit rows through the matrix_write door and writes no record value — there is nothing to stamp, no component history to append and no index to refresh, and the rows it removes are audit events, not records (the record tables are refused by that door's own allowlist).",
	'src/core/relations/dataframe.ts#fixDataframeOrphanEntries':
		'maintenance FIX mode: per-key strip of orphaned frame entries with no TM and no stamp (S2-06).',
	'src/core/relations/parent.ts#setChildOrder':
		'PENDING, not a design (CLOSURE_PLAN Step 5 tree-move obligation): the thesaurus TREE engine writes the parent/children slots raw. PHP update_parent_data (:747) saved through component->save() — stamped, historied, observed — so this is a known divergence, held by leg B’s PENDING change detector until Step 5 routes it through persistRecordKeys + recordMainHistory.',
	'src/core/relations/parent.ts#removeChildOrder': 'thesaurus tree engine — see setChildOrder.',
	'src/core/relations/parent.ts#addParent': 'thesaurus tree engine — see setChildOrder.',
	'src/core/relations/parent.ts#removeParent': 'thesaurus tree engine — see setChildOrder.',
	'src/core/relations/parent.ts#recalculateSiblingOrders':
		'thesaurus tree engine — see setChildOrder.',
	'src/core/relations/parent.ts#sortChildren': 'thesaurus tree engine — see setChildOrder.',
	'src/core/ts_object/ts_api.ts#addChild':
		'PENDING (Step 5 tree-move obligation) — see parent.ts#setChildOrder: PHP dd_ts_api::add_child saved the parent/children slots through component->save(); the raw write here is held by leg B’s PENDING change detector.',
	'src/core/install/hierarchy_activate.ts#createRegistryRow':
		'installer hierarchy ACTIVATION — the registry row CREATED from the hierarchy.json manifest entry (system provisioning at install time, no principal, no curated content; one transaction).',
	'src/core/tools/register.ts#writeRegistryRecord':
		'tools REGISTRY import (dd1324 rows written from the tools’ register.json at boot/import): system rows; it invalidates the tool caches for itself (tools_cache_invalidation gate).',
	'src/core/update/transform/portalize.ts#applyPortalizeRow':
		'the UPDATE-PROCESS portalize transform (WC-025): a matrix-COLUMN-level relocation with TM relocated and save_tm suppressed by design; execute-gated behind the standalone update engine, never a request-path write.',
	'scripts/repair_geolocation_studio_default.ts#repairUnit':
		'a one-shot operator repair of the geolocation studio default: a per-key write inside withTransaction with its own recordTimeMachine row per repaired component; never a request-path save.',
};

/**
 * The exemptions that are NOT derived writes (so they are not on the sanctioned
 * list tool_lossless shares): each is a whole process of its own — retention,
 * a maintenance FIX, an installer / registry import, the update transform, an
 * operator repair script — with its category.
 */
const NON_DERIVED_RAW_WRITERS: Readonly<Record<string, string>> = {
	'src/core/retention/prune.ts#registerRetentionCatalog': 'retention',
	'src/core/relations/dataframe.ts#fixDataframeOrphanEntries': 'maintenance fix',
	'src/core/install/hierarchy_activate.ts#createRegistryRow': 'installer',
	'src/core/tools/register.ts#writeRegistryRecord': 'registry import',
	'src/core/update/transform/portalize.ts#applyPortalizeRow': 'update transform',
	'scripts/repair_geolocation_studio_default.ts#repairUnit': 'operator repair script',
};

/**
 * Files exempt BY RULE (a prefix): repo-owned fixture builders under the
 * test-database marker guard, and the primitive module itself (the definitions).
 */
const RAW_CALLER_EXEMPT_PREFIXES = ['src/core/test_data/', MATRIX_WRITE];

/**
 * PINNED — shrink-only. A LITERAL, never derived from the list itself (a count
 * that equals the list's own length can never go red). 31 → 26 (Step 2): the
 * files_info doors (updateCache, sweepFilesInfo, duplicate's media refresh)
 * reach the one writer through the locked transform, the relation_search
 * index is derived INSIDE the chokepoints, and persistRecordKeys no longer
 * writes raw itself (its DML lives in the shared key write, record_write.ts
 * writeKeys — a chokepoint unit, sanctioned by rule).
 */
const RAW_CALLER_EXEMPT_COUNT = 26;

interface CensusVerdict {
	unreached: string[];
	stale: string[];
	reachedButExempt: string[];
}

/**
 * The analyser — shared by the tree scan and the positive control. `reaches`
 * answers whether a raw caller reaches the obligation hook through RESOLVED
 * references (the closure's reachesPrecisely), at any depth.
 */
function judge(
	calls: RawCall[],
	exempt: Record<string, string>,
	reaches: (key: string) => boolean,
): CensusVerdict {
	const unreached: string[] = [];
	const reachedButExempt: string[] = [];
	const seen = new Set<string>();
	for (const call of calls) {
		if (seen.has(call.key)) continue;
		seen.add(call.key);
		if (RAW_CALLER_EXEMPT_PREFIXES.some((prefix) => call.file.startsWith(prefix))) continue;
		const reached = reaches(call.key);
		const row = exempt[call.key];
		if (reached && row !== undefined && !row.includes('(chokepoint)')) {
			reachedButExempt.push(call.key);
		} else if (!reached && row === undefined) {
			unreached.push(`${call.key} (${call.primitive})`);
		}
	}
	const stale = Object.keys(exempt).filter((key) => !seen.has(key));
	return { unreached, stale, reachedButExempt };
}

/**
 * What makes a raw caller SANCTIONED without a row: it IS a chokepoint (a
 * RECORD_WRITE_CHOKEPOINTS unit, or a record_write.ts unit — the chokepoint's
 * own internals) AND it reaches the obligation hook through resolved references.
 * Reaching the hook somewhere else is NOT enough: a door that writes raw on one
 * branch and saves through the chokepoint on another (update_cache at the
 * audit) still wrote raw. Raw DML belongs inside a chokepoint or in an
 * enumerated, reasoned exemption — never in a door.
 */
const sanctionedBy =
	(closure: WriterClosure, isChokepoint: (key: string) => boolean) =>
	(key: string): boolean =>
		isChokepoint(key) &&
		(key === AFTER_RECORD_WRITE || closure.reachesPrecisely(key, AFTER_RECORD_WRITE));

const TREE_CHOKEPOINTS: ReadonlySet<string> = new Set(Object.keys(RECORD_WRITE_CHOKEPOINTS));
const isTreeChokepoint = (key: string): boolean =>
	TREE_CHOKEPOINTS.has(key) || key.startsWith(`${RECORD_WRITE}#`);

/**
 * The census exemptions: RAW_CALLER_EXEMPT plus every leg-B PENDING unit (its
 * reason is the step that closes it; the change detector holds it). Read at
 * test time — PENDING is declared with leg B below.
 */
const censusExempt = (): Record<string, string> => ({
	...Object.fromEntries(
		Object.entries(PENDING).map(([key, row]) => [
			key,
			`PENDING (${row.closes}) — enumerated in leg B with a change detector`,
		]),
	),
	...RAW_CALLER_EXEMPT,
});

const CORPUS = writePathSourceFiles();
const TREE_CALLS: RawCall[] = CORPUS.flatMap((file) => rawCallsIn(file, code(file)));

describe('A. the raw matrix_write caller census is TOTAL', () => {
	test('the primitive list is DERIVED from the module and every export is classified', async () => {
		expect(RAW_PRIMITIVES.length).toBeGreaterThanOrEqual(6);
		for (const name of [
			'updateMatrixRecord',
			'updateMatrixKeyData',
			'updateMatrixKeysData',
			'insertMatrixRecordWithCounter',
			'insertMatrixRecordWithExplicitId',
			'deleteMatrixRecord',
		]) {
			expect(RAW_PRIMITIVES, `${name} is not derived as a primitive`).toContain(name);
		}
		const exported = moduleRuntimeExports(read(MATRIX_WRITE));
		for (const [name, reason] of Object.entries(MATRIX_WRITE_NON_DML)) {
			expect(exported, `${name} is no longer exported by ${MATRIX_WRITE}`).toContain(name);
			expect(reason.length).toBeGreaterThan(30);
		}
		// the TEXT parser against an independent oracle: the loaded module's runtime exports
		const measured = Object.keys(await import(`../../${MATRIX_WRITE}`)).sort();
		expect(
			[...exported].sort(),
			'moduleRuntimeExports disagrees with the loaded module — an export form the text parser does not read',
		).toEqual(measured);
		expect([...RAW_PRIMITIVES].sort()).toEqual(
			measured.filter((name) => MATRIX_WRITE_NON_DML[name] === undefined),
		);
	});

	test('the corpus, the scan and the closure are non-vacuous', () => {
		expect(CORPUS.length).toBeGreaterThan(WRITE_PATH_CORPUS_FLOOR);
		const keys = new Set(TREE_CALLS.map((call) => call.key));
		expect(TREE_CALLS.length).toBeGreaterThan(25);
		for (const key of [
			`${RECORD_WRITE}#writeKeys`,
			`${RECORD_WRITE}#persistRecordColumns`,
			`${CREATE_RECORD}#createSectionRecord`,
			`${DUPLICATE_RECORD}#duplicateSectionRecord`,
			`${DELETE_RECORD}#deleteSectionRecord`,
		]) {
			expect(keys.has(key), `the splitter did not attribute a raw call to ${key}`).toBe(true);
			// the census keys and the closure units are the SAME address space
			expect(CLOSURE.bodies.has(key), `${key} is not a closure unit`).toBe(true);
		}
	});

	test('POSITIVE CONTROL: the judge flags a chokepoint that fires no hook, a DOOR that writes raw although it reaches the hook elsewhere, a stale row and an exempt chokepoint — and sees reach at DEPTH', () => {
		const files: Record<string, string> = {
			[RECORD_WRITE]: 'export async function afterRecordWrite(): Promise<void> {}\n',
			'src/control/offender.ts': [
				"import { afterRecordWrite } from '../core/section_record/record_write.ts';",
				"import { updateMatrixKeyData } from '../core/db/matrix_write.ts';",
				'async function finish(): Promise<void> {',
				'\tawait afterRecordWrite();',
				'}',
				'export async function hooklessChokepoint(table: string): Promise<void> {',
				"\tawait updateMatrixKeyData(table, 'ctl1', 1, 'relation', 'ctl2', []);",
				'}',
				'export async function deepChokepoint(table: string): Promise<void> {',
				"\tawait updateMatrixKeyData(table, 'ctl1', 1, 'relation', 'ctl2', []);",
				'\tawait finish();',
				'}',
				'export async function rogueDoor(table: string): Promise<void> {',
				"\tawait updateMatrixKeyData(table, 'ctl1', 1, 'media', 'ctl3', []);",
				'\tawait finish();',
				'}',
			].join('\n'),
		};
		const closure = buildWriterClosure({
			files: Object.keys(files),
			read: (rel) => files[rel] as string,
		});
		const calls = rawCallsIn('src/control/offender.ts', files['src/control/offender.ts'] as string);
		expect(calls.map((call) => call.key).sort()).toEqual([
			'src/control/offender.ts#deepChokepoint',
			'src/control/offender.ts#hooklessChokepoint',
			'src/control/offender.ts#rogueDoor',
		]);
		const chokepoints = new Set([
			'src/control/offender.ts#deepChokepoint',
			'src/control/offender.ts#hooklessChokepoint',
		]);
		const verdict = judge(
			calls,
			{
				'src/control/offender.ts#vanished': 'a row for nothing',
				'src/control/offender.ts#deepChokepoint': 'exempt for no reason',
			},
			sanctionedBy(closure, (key) => chokepoints.has(key)),
		);
		// deepChokepoint reaches the hook one helper deeper (a substring judge misses it);
		// rogueDoor reaches it too, but is a DOOR writing raw — the update_cache shape
		expect(verdict.unreached.sort()).toEqual([
			'src/control/offender.ts#hooklessChokepoint (updateMatrixKeyData)',
			'src/control/offender.ts#rogueDoor (updateMatrixKeyData)',
		]);
		expect(verdict.stale).toEqual(['src/control/offender.ts#vanished']);
		expect(verdict.reachedButExempt).toEqual(['src/control/offender.ts#deepChokepoint']);
	});

	test('every raw caller REACHES the obligation hook, or carries an ENUMERATED reason', () => {
		const verdict = judge(TREE_CALLS, censusExempt(), sanctionedBy(CLOSURE, isTreeChokepoint));
		expect(
			verdict.unreached,
			`Raw matrix_write caller(s) that do not reach afterRecordWrite and carry no row:\n  ${verdict.unreached.join('\n  ')}\nRoute the write through a chokepoint (section_record/record_write.ts) or the locked media transform, or add a RAW_CALLER_EXEMPT row with the reason the obligations do not apply.`,
		).toEqual([]);
	});

	test('no exemption row is stale (the declaration no longer calls a primitive) or hides a reaching door', () => {
		const verdict = judge(TREE_CALLS, censusExempt(), sanctionedBy(CLOSURE, isTreeChokepoint));
		expect(
			verdict.stale,
			'RAW_CALLER_EXEMPT rows for declarations that no longer call a raw primitive',
		).toEqual([]);
		expect(
			verdict.reachedButExempt,
			'declarations that reach the hook but carry an exemption written as if they did not',
		).toEqual([]);
	});

	test('the exemption list is SHRINK-ONLY and every reason is a reason', () => {
		expect(Object.keys(RAW_CALLER_EXEMPT).length).toBeLessThanOrEqual(RAW_CALLER_EXEMPT_COUNT);
		for (const [key, reason] of Object.entries(RAW_CALLER_EXEMPT)) {
			expect(reason.length, `${key}: too short to be a reason`).toBeGreaterThan(40);
		}
	});

	test('every exemption is PARTITIONED: a chokepoint, a PENDING unit, a SANCTIONED derived writer, or an enumerated non-derived writer — and every sanctioned writer is exempt with ITS reason', () => {
		const unclassified = Object.entries(RAW_CALLER_EXEMPT)
			.filter(
				([key, reason]) =>
					!reason.includes('(chokepoint)') &&
					PENDING[key] === undefined &&
					SANCTIONED_DERIVED_WRITERS[key] === undefined &&
					NON_DERIVED_RAW_WRITERS[key] === undefined,
			)
			.map(([key]) => key);
		expect(
			unclassified,
			'an exemption that is neither a chokepoint, PENDING, a SANCTIONED derived writer (matrix_writer_closure.ts) nor an enumerated non-derived writer',
		).toEqual([]);
		for (const [key, reason] of Object.entries(SANCTIONED_DERIVED_WRITERS)) {
			expect(
				RAW_CALLER_EXEMPT[key],
				`${key}: sanctioned in matrix_writer_closure.ts but not exempt here with the SAME reason`,
			).toBe(reason);
		}
		for (const key of Object.keys(NON_DERIVED_RAW_WRITERS)) {
			expect(RAW_CALLER_EXEMPT[key], `${key}: enumerated non-derived but not exempt`).toBeDefined();
			expect(SANCTIONED_DERIVED_WRITERS[key], `${key}: listed in both lists`).toBeUndefined();
		}
	});
});

// ---------------------------------------------------------------------------
// B. THE LEDGER, DERIVED FROM THE CLOSURE
// ---------------------------------------------------------------------------

/** The units with a RESOLVED one-hop edge to `target` (namespace escapes excluded). */
function callersOf(closure: WriterClosure, target: string): string[] {
	return [...closure.bodies.keys()].filter((key) => closure.preciseEdgesOf(key).has(target)).sort();
}

/**
 * The units that MAY call `target` — every edge, the namespace escapes included (a
 * bare `ns` passed as a value reaches every export of its module). The conservative
 * side of an "only these callers" claim.
 */
function possibleCallersOf(closure: WriterClosure, target: string): string[] {
	return [...closure.bodies.keys()].filter((key) => closure.edgesOf(key).has(target)).sort();
}

/**
 * Two-sided exclusivity: who MAY call `target` beyond `allowed` (over-approximated —
 * a namespace escape is a caller), and which allowed caller PROVABLY no longer calls it.
 */
function exclusivity(
	closure: WriterClosure,
	target: string,
	allowed: readonly string[],
): { extra: string[]; missing: string[] } {
	const possible = possibleCallersOf(closure, target);
	const proven = callersOf(closure, target);
	return {
		extra: possible.filter((key) => !allowed.includes(key)),
		missing: allowed.filter((key) => !proven.includes(key)).sort(),
	};
}

/** The reach obligations one unit must meet: [from, to] pairs it fails. */
function unreachedPairs(
	closure: WriterClosure,
	pairs: readonly (readonly [string, string])[],
): string[] {
	return pairs
		.filter(([from, to]) => !closure.bodies.has(from) || !closure.reachesPrecisely(from, to))
		.map(([from, to]) => `${from} ↛ ${to}${closure.bodies.has(from) ? '' : ' (no such unit)'}`);
}

/**
 * B3's exclusivity half: the units outside record_write.ts that MAY call the
 * relation_search derivation — every edge, a namespace escape included (a door
 * handing the relations/save.ts namespace on as a value could derive, or write,
 * the index itself; a resolved-edge count would not see it — B5 holds that).
 */
function derivationOutsiders(closure: WriterClosure): string[] {
	return possibleCallersOf(closure, U.deriveRelationSearch).filter(
		(key) => !key.startsWith(`${RECORD_WRITE}#`),
	);
}

/** B2 + B3: what the hook, the ledger and the chokepoint writers must reach. */
const LEDGER_REACH: readonly (readonly [string, string])[] = [
	[U.afterRecordWrite, U.fireSaveEvent],
	[U.afterRecordWrite, U.reactToSecurityWrite],
	[U.afterRecordWrite, U.fireRagRecordEvent],
	[U.afterRecordWrite, U.enqueueObservedChange],
	[U.enqueueObservedChange, U.propagateToObservers],
	[U.enqueueObservedChange, U.recomputeMirrorAndHop],
];
const DERIVATION_REACH: readonly (readonly [string, string])[] = [
	[U.writeKeys, U.deriveRelationSearch],
	[U.persistRecordColumns, U.deriveRelationSearch],
	[U.persistRecordBirth, U.deriveRelationSearch],
	// the two INSERT doors that bypass the chokepoint by design store a birth by
	// the same law (record_write.ts prepareBirthColumns) — a clone that copied its
	// source's index kept an `_hi` index for the mirror it dropped
	[U.createSectionRecord, U.deriveRelationSearch],
	[U.duplicateSectionRecord, U.deriveRelationSearch],
];

/**
 * B4 — THE EXCLUSIVITY TABLE. Each target is an obligation (or an escape hatch
 * of one) with EXACTLY these callers; anything else is a door remembering an
 * obligation for itself, which is the shape every Step 2 finding had.
 */
const EXCLUSIVE: readonly { target: string; allowed: readonly string[]; why: string }[] = [
	{
		target: U.writeKeys,
		allowed: [
			U.persistRecordKeys,
			U.persistRestoredKeys,
			U.persistRelationRemovalKeys,
			U.persistObserverMirrorKeys,
		],
		why: 'the per-key kernel takes its escape hatches as ARGUMENT VALUES (`ledger:false` = no observer entry, `law:"removal"`, `coveredSlots:"recompute"`), which no edge sees: each hatch is legitimate only through the ONE named entry whose own row above/below holds its callers. A fifth entry (`persistQuietKeys = writeKeys(…, {ledger:false})`) would skip the ledger from any door and pass every other leg.',
	},
	{
		target: U.propagateToObservers,
		// the ledger's drain (the root of every write's propagation) and the
		// cascade hop (a written observer re-entering, bounded); the recompute
		// unit hops through emitCascadeHop, never by calling propagation itself
		allowed: [U.drainEntry, U.runObserverCascadeHop],
		why: 'the observer cascade is the LEDGER’s: it drains post-commit with the before-image the chokepoint recorded. A door propagating itself is how the restore doors forgot it (CORE-1).',
	},
	{
		target: U.persistRelationRemovalKeys,
		allowed: [U.removePortalLocatorUnderGrant, U.removeAllInverseReferences, U.deleteSectionData],
		why: 'the REMOVAL law (every relation model re-indexed) is the three removal doors’ — any other writer gets the save law.',
	},
	{
		target: U.persistObserverMirrorKeys,
		allowed: [U.recomputeExternalRelation],
		why: 'the cascade-owned entry writes WITHOUT a ledger entry (the cascade hops itself); only the recompute may skip the ledger.',
	},
	{
		target: U.writeItems,
		allowed: [U.transformStoredMediaItems],
		why: 'files_info has ONE writer, reached only through the locked transform (TOOLS-5): a second caller writes over an unlocked snapshot.',
	},
	{
		target: U.recomputeMirrorAndHop,
		allowed: [U.propagateToObservers, U.drainEntry],
		why: 'a mirror recompute is the cascade’s (its dispatch loop) or the ledger’s (a whole-record write’s covered slot) — a door recomputing a mirror itself remembered an obligation.',
	},
	{
		target: U.enqueueObservedChange,
		allowed: [U.afterRecordWrite, U.deleteSectionRecord, U.requestCoveredSlotRecompute],
		why: 'an observer obligation is declared by the chokepoint hook, the record delete (its death, inside its transaction) and the covered-slot recompute entry — no door queues one of its own.',
	},
	{
		target: U.recomputeExternalRelation,
		allowed: [U.recomputeMirrorAndHop, U.defaultReconcileIO],
		why: 'the mirror kernel is driven by the cascade unit and the reconcile sweep only — a third caller would recompute outside both the guard’s dedup and the reconcile’s report.',
	},
	{
		target: U.requestCoveredSlotRecompute,
		allowed: [U.restoreWipedRecord, U.requestRestoredSlotRecompute],
		why: 'the covered-slot recompute entry is the restores’ that never pass a whole-record entry: the soft-cascade restore (every declared slot — the census the wipe shares, case 16b) and the COMPONENT-RESTORE entry’s own key write (persistRestoredKeys → writeKeys: exactly the covered slots it wrote — a mirror’s history row is a past derivation, never propagated, converged on truth after COMMIT; cases 14, 14b–e, 16a hold it by outcome). Every whole-record restore gets the slot law from persistRecordColumns / persistRecordBirth.',
	},
	{
		target: U.persistRestoredKeys,
		allowed: [
			U.toolTimeMachineApplyValue,
			U.writeRevertedKey,
			U.writeComposedUnit,
			U.writeWipedKey,
		],
		why: 'the COMPONENT-RESTORE entry is the doors that write a key’s PAST value: apply_value, the bulk revert-undo’s key write and its composed unit, and the soft-cascade restore’s key write. Any other door writing a restored mirror through it would skip propagating a curator’s value; a restore through persistRecordKeys would propagate a past derivation as truth (a phantom referencer’s back-mirror lists the record again — cases 14d, 14e, 17b).',
	},
	{
		target: U.prepareBirthColumns,
		allowed: [U.createSectionRecord, U.duplicateSectionRecord],
		why: 'the NEW-record birth law is the two INSERT doors that bypass the chokepoint by design — a birth door without it stores a covered unit or a stale `_hi` index. The chokepoint’s own birth (writeBirth — an UNDELETE: a record continuing at its address) keeps its snapshot’s covered units, frames paired to their ids, never declared and always recomputed (case 17a).',
	},
	{
		target: U.dropCoveredObserverUnits,
		allowed: [U.prepareBirthColumns, U.duplicateSectionRecord],
		why: 'dropping a covered unit (mirror AND frames) is the new-record birth law; the duplicate also calls it before its frame-target re-mint, for the mirrors it left out of its copy (case 17d). A door dropping a unit on its own loses curator frames an undelete must keep.',
	},
];

/**
 * THE HOOK'S OUTSIDE CALLERS — the doors that call afterRecordWrite from outside
 * record_write.ts, each pinned to the OUTCOME case that holds what it DECLARES
 * (`observed`), in obligation_ledger_native. A declaration is a value the closure
 * cannot judge (`none` with a reason type-checks as well as `birth`), so a new
 * outside caller is red until a case holds its declaration.
 */
const OBLIGATION_LEDGER_NATIVE = 'test/unit/obligation_ledger_native.test.ts';
const OUTSIDE_HOOK_CALLERS: Readonly<Record<string, string>> = {
	[U.createSectionRecord]: '7a:',
	[U.duplicateSectionRecord]: '7b:',
	[U.archiveWriteRecordRow]: 'PENDING',
};

/**
 * PENDING — the raw writers the closure names (a direct matrix_write edge, past
 * every chokepoint) in the tree-move and archive-restore files, each with the
 * step that closes it and a CHANGE DETECTOR: the sha256 (first 16 hex) of its
 * comment-stripped, whitespace-collapsed body. A change to a PENDING unit is red
 * until whoever changes it decides, here, whether it still is one. This is a
 * spelling pin by design and is labelled as one.
 */
const PENDING_FILES = [
	'src/core/relations/parent.ts',
	'src/core/ts_object/ts_api.ts',
	'src/core/api/handlers/dd_ts_api.ts',
	'src/core/archive/restore.ts',
] as const;
const TREE_MOVE = 'Step 5 tree-move obligation';
const ARCHIVE = 'archive door → persistRecordColumns/persistRecordBirth';
const PENDING: Record<string, { closes: string; body: string }> = {
	'src/core/relations/parent.ts#setChildOrder': { closes: TREE_MOVE, body: '2ccc2e1095b79164' },
	'src/core/relations/parent.ts#removeChildOrder': { closes: TREE_MOVE, body: 'a08d655b6c955c78' },
	'src/core/relations/parent.ts#addParent': { closes: TREE_MOVE, body: '86a00b18b1390ffa' },
	'src/core/relations/parent.ts#removeParent': { closes: TREE_MOVE, body: '191692f4fbef150e' },
	'src/core/relations/parent.ts#recalculateSiblingOrders': {
		closes: TREE_MOVE,
		body: '633b49769bf467ee',
	},
	'src/core/relations/parent.ts#sortChildren': { closes: TREE_MOVE, body: '51e8d5c70079cf1d' },
	'src/core/ts_object/ts_api.ts#addChild': { closes: TREE_MOVE, body: '27b4bc49d267b7da' },
	// PINNED TO THE DECLARING BODY (2026-10-01, landed in the same commit): `observed`
	// is REQUIRED on afterRecordWrite and refused at runtime without it, and the body
	// this row enumerated before (8799bf8d8b9a0788) called the hook WITHOUT it — every
	// archive restore would throw after its row lands. This hash is the body WITH the
	// declaration `observed: { kind: 'none', reason: 'PENDING: archive restore →
	// persistRecordColumns/persistRecordBirth (owner step)' }` on that call, so the
	// detector is red over the throwing door and green over the fix.
	'src/core/archive/restore.ts#writeRecordRow': { closes: ARCHIVE, body: '2aab00dd0e34f285' },
};

const bodyHash = (body: string): string =>
	createHash('sha256').update(body.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);

/** The DIRECT raw writers (bypass path of length 2) among a set of files' units. */
function directRawWriters(closure: WriterClosure, files: readonly string[]): string[] {
	const cut = new Set(Object.keys(RECORD_WRITE_CHOKEPOINTS));
	return [...closure.bodies.keys()]
		.filter((key) => files.some((file) => key.startsWith(`${file}#`)))
		.filter((key) => (closure.bypassPath(key, cut)?.length ?? 0) === 2)
		.sort();
}

describe('B. the obligation ledger, derived from the writer closure', () => {
	test('B1: every RECORD_WRITE_CHOKEPOINTS unit is real and reaches afterRecordWrite', () => {
		const failing = unreachedPairs(
			CLOSURE,
			Object.keys(RECORD_WRITE_CHOKEPOINTS).map((key) => [key, AFTER_RECORD_WRITE] as const),
		);
		expect(failing, 'chokepoint(s) that fire no obligation hook').toEqual([]);
	});

	test('B2: the hook reaches the save event, the security reaction, the RAG event AND the ledger; the ledger reaches the cascade', () => {
		expect(
			unreachedPairs(CLOSURE, LEDGER_REACH),
			'the post-write hook does not carry the observer obligation — every door must remember it (CORE-1)',
		).toEqual([]);
	});

	test('B3: the chokepoint writers derive relation_search themselves (same UPDATE)', () => {
		expect(
			unreachedPairs(CLOSURE, DERIVATION_REACH),
			'a chokepoint writer that does not derive the ancestor index leaves every door to remember it (CORE-2)',
		).toEqual([]);
		// ...and the derivation MAY be called from the record_write units ONLY
		expect(
			derivationOutsiders(CLOSURE),
			'a door re-derives relation_search outside the chokepoint',
		).toEqual([]);
	});

	for (const row of EXCLUSIVE) {
		test(`B4: exclusivity — ${row.target.split('#')[1]} has exactly its enumerated callers`, () => {
			expect(row.why.length).toBeGreaterThan(40);
			expect(exclusivity(CLOSURE, row.target, row.allowed), row.why).toEqual({
				extra: [],
				missing: [],
			});
		});
	}

	test('B4: every afterRecordWrite caller outside the chokepoint is enumerated, and its declaration held by an OUTCOME case', () => {
		const outside = possibleCallersOf(CLOSURE, AFTER_RECORD_WRITE).filter(
			(key) => !key.startsWith(`${RECORD_WRITE}#`),
		);
		expect(
			outside,
			'an afterRecordWrite caller outside record_write.ts with no outcome case pinning its `observed` declaration',
		).toEqual(Object.keys(OUTSIDE_HOOK_CALLERS).sort());
		// SPELLING (labelled): the named case exists in the native gate.
		const native = read(OBLIGATION_LEDGER_NATIVE);
		for (const [key, label] of Object.entries(OUTSIDE_HOOK_CALLERS)) {
			if (label === 'PENDING') {
				expect(
					PENDING[key],
					`${key}: marked PENDING but not in leg B's PENDING table`,
				).toBeDefined();
				continue;
			}
			expect(
				native.includes(`test('${label}`),
				`${key}: its outcome case '${label}' is missing from ${OBLIGATION_LEDGER_NATIVE}`,
			).toBe(true);
		}
	});

	test('B5 POSITIVE CONTROLS: a remembering door, a hook without the ledger and a second files_info writer are each reported', () => {
		const files: Record<string, string> = {
			[OBSERVERS]: [
				'export async function propagateToObservers(): Promise<void> {}',
				'export async function recomputeMirrorAndHop(): Promise<void> {}',
				'export async function runObserverCascadeHop(): Promise<void> {',
				'\tawait propagateToObservers();',
				'}',
			].join('\n'),
			[LEDGER]: [
				"import { propagateToObservers, recomputeMirrorAndHop } from '../section/record/observers.ts';",
				'export async function drainEntry(): Promise<void> {',
				'\tawait propagateToObservers();',
				'\tawait recomputeMirrorAndHop();',
				'}',
				'export function enqueueObservedChange(): void {',
				'\tvoid drainEntry();',
				'}',
			].join('\n'),
			// the hook WITHOUT the ledger
			[RECORD_WRITE]: 'export async function afterRecordWrite(): Promise<void> {}\n',
			[SAVE_EVENT]: [
				'export async function fireSaveEvent(): Promise<void> {}',
				'export async function fireRagRecordEvent(): Promise<void> {}',
			].join('\n'),
			'src/core/control/door.ts': [
				"import { propagateToObservers } from '../section/record/observers.ts';",
				'export async function rememberingDoor(): Promise<void> {',
				'\tawait propagateToObservers();',
				'}',
				// a NAMESPACE ESCAPE: the observers namespace handed on as a value — it
				// may call any export, so an exclusivity claim must count it
				'export async function escapingDoor(run: (m: unknown) => Promise<void>): Promise<void> {',
				"\tconst observers = await import('../section/record/observers.ts');",
				'\tawait run(observers);',
				'}',
				// an ESCAPING DERIVER: the relations/save.ts namespace handed on as a value —
				// it may derive (or write) relation_search itself, past the chokepoint
				'export async function escapingDeriver(run: (m: unknown) => Promise<void>): Promise<void> {',
				"\tconst save = await import('../relations/save.ts');",
				'\tawait run(save);',
				'}',
			].join('\n'),
			[RELATIONS_SAVE]: 'export async function deriveRelationSearch(): Promise<void> {}\n',
			[FILES_INFO_PERSIST]: [
				'async function writeItems(): Promise<void> {}',
				'export async function transformStoredMediaItems(): Promise<void> {',
				'\tawait writeItems();',
				'}',
				'export async function sneakyRefresh(): Promise<void> {',
				'\tawait writeItems();',
				'}',
			].join('\n'),
		};
		const closure = buildWriterClosure({
			files: Object.keys(files),
			read: (rel) => files[rel] as string,
		});
		const cascadeRow = EXCLUSIVE.find((row) => row.target === U.propagateToObservers);
		expect(cascadeRow, 'the cascade has no exclusivity row').toBeDefined();
		expect(exclusivity(closure, U.propagateToObservers, cascadeRow?.allowed ?? [])).toEqual({
			extra: ['src/core/control/door.ts#escapingDoor', 'src/core/control/door.ts#rememberingDoor'],
			missing: [],
		});
		// the escape is a MAY-call (membership), never proof — the proven side does not see it
		expect(callersOf(closure, U.propagateToObservers)).not.toContain(
			'src/core/control/door.ts#escapingDoor',
		);
		expect(exclusivity(closure, U.writeItems, [U.transformStoredMediaItems]).extra).toEqual([
			`${FILES_INFO_PERSIST}#sneakyRefresh`,
		]);
		// B3's analyser reports the escaping deriver — a resolved-edge count would not
		expect(derivationOutsiders(closure)).toEqual(['src/core/control/door.ts#escapingDeriver']);
		expect(callersOf(closure, U.deriveRelationSearch)).toEqual([]);
		// the hook half: nothing but the empty hook exists, so all four hook reaches fail
		expect(unreachedPairs(closure, LEDGER_REACH)).toEqual(
			LEDGER_REACH.slice(0, 4).map(([from, to]) => `${from} ↛ ${to}`),
		);
		// and the ledger half of the synthetic corpus is whole — the control is not vacuous
		expect(
			unreachedPairs(closure, [
				[U.enqueueObservedChange, U.propagateToObservers],
				[U.enqueueObservedChange, U.recomputeMirrorAndHop],
			]),
		).toEqual([]);
	});

	test('B5 POSITIVE CONTROL: a fifth entry onto the per-key kernel (a flag-value hatch) is reported', () => {
		const files: Record<string, string> = {
			[RECORD_WRITE]: [
				'async function writeKeys(_mode: unknown): Promise<void> {}',
				'export async function persistRecordKeys(): Promise<void> { await writeKeys({ ledger: true }); }',
				'export async function persistRestoredKeys(): Promise<void> { await writeKeys({ ledger: true }); }',
				"export async function persistRelationRemovalKeys(): Promise<void> { await writeKeys({ law: 'removal' }); }",
				'export async function persistObserverMirrorKeys(): Promise<void> { await writeKeys({ ledger: false }); }',
				// the hatch re-exposed under a new name — no edge names the flag
				'export async function persistQuietKeys(): Promise<void> { await writeKeys({ ledger: false }); }',
			].join('\n'),
		};
		const closure = buildWriterClosure({
			files: Object.keys(files),
			read: (rel) => files[rel] as string,
		});
		const row = EXCLUSIVE.find((candidate) => candidate.target === U.writeKeys);
		expect(row, 'the per-key kernel has no exclusivity row').toBeDefined();
		expect(exclusivity(closure, U.writeKeys, row?.allowed ?? [])).toEqual({
			extra: [`${RECORD_WRITE}#persistQuietKeys`],
			missing: [],
		});
	});

	test('PENDING: the raw tree-move and archive writers are exactly the enumerated ones, each with its closing step', () => {
		expect(
			directRawWriters(CLOSURE, PENDING_FILES),
			'a raw writer in a tree-move / archive file that is not enumerated PENDING (or an enumerated one that no longer writes raw — close it here)',
		).toEqual(Object.keys(PENDING).sort());
		for (const row of Object.values(PENDING)) {
			expect(row.closes.length).toBeGreaterThan(10);
		}
	});

	test('PENDING change detector: a PENDING unit changed since it was enumerated is red', () => {
		const changed = Object.entries(PENDING)
			.filter(([key, row]) => bodyHash(CLOSURE.bodies.get(key) ?? '') !== row.body)
			.map(([key]) => key);
		expect(
			changed,
			'PENDING unit(s) changed: decide whether each still writes past the chokepoint (keep it PENDING with its new hash) or now routes through one (strike it)',
		).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// S. SPELLING CHECKS — labelled as such: they read source text, not the closure
// ---------------------------------------------------------------------------

/** The body of one top-level declaration, comments stripped. */
function bodyOf(file: string, name: string): string {
	const block = topLevelBlocks(code(file)).find((candidate) => candidate.name === name);
	if (block === undefined) throw new Error(`${file}: no top-level declaration '${name}'`);
	return block.body;
}

/** The activity rows that stay at the API door, by design (oracle shape). */
const DOOR_ACTIVITY: { handler: string; what: string; reason: string }[] = [
	{
		handler: 'save',
		what: 'SAVE',
		reason: 'per-component payload (tipo, changed data) only the door holds.',
	},
	{ handler: 'delete', what: 'DELETE', reason: 'delete_mode + section WHERE, the oracle shape.' },
];

describe('S. spelling checks (source text — labelled, not proof)', () => {
	test("the 'NEW' activity row is written by the two record-birth engines and by NO door", () => {
		const emitters = CORPUS.filter((file) => /what:\s*'NEW'/.test(code(file))).sort();
		expect(emitters).toEqual([DUPLICATE_RECORD, CREATE_RECORD].sort());
		expect(bodyOf(CREATE_RECORD, 'createSectionRecord')).toContain("msg: 'Created section record'");
		expect(bodyOf(DUPLICATE_RECORD, 'duplicateSectionRecord')).toContain(
			"msg: 'Duplicated section record'",
		);
	});

	test('SAVE and DELETE rows stay at the API door (enumerated, oracle shape) — and NEW does not', () => {
		const door = code(DD_CORE_API);
		for (const row of DOOR_ACTIVITY) {
			expect(door, `dd_core_api no longer logs ${row.what}`).toContain(`what: '${row.what}'`);
			expect(row.reason.length).toBeGreaterThan(20);
		}
		expect(door).not.toContain("what: 'NEW'");
	});

	test('every record-birth door funnels into createSectionRecord or duplicateSectionRecord (so it inherits the row)', () => {
		for (const file of [
			'src/ai/mcp/tools/records_write.ts',
			'src/ai/mcp/tools/fields_write.ts',
			DD_CORE_API,
			RELATIONS_SAVE,
			'src/core/tools/import_csv_execute.ts',
		]) {
			const source = code(file);
			expect(
				/createSectionRecord\(|duplicateSectionRecord\(/.test(source),
				`${file} creates no record through the engine doors`,
			).toBe(true);
			expect(source).not.toMatch(/insertMatrixRecordWith(?:Counter|ExplicitId)\(/);
		}
	});

	test('the stored-value branch of component_info is GONE (DATA-15): the read always computes', () => {
		const body = bodyOf(INFO_EMIT, 'infoEmitHook');
		expect(body).toContain('computeInfoWidgets(');
		expect(body).toContain("incrementCounter('component_info_stored_value_ignored')");
		expect(body).not.toMatch(/return normalizeWidgetEntryKeys\(value\)/);
		const observer = bodyOf(OBSERVERS, 'recomputeInfoObserver');
		expect(observer).toContain('recordTimeMachine(');
		expect(observer).not.toMatch(/persistRecordKeys\(|updateMatrixKeyData\(|updateMatrixRecord\(/);
	});
});

// ---------------------------------------------------------------------------
// C. TIMING — every cache branch of fireSaveEvent defers past the transaction
// ---------------------------------------------------------------------------

/**
 * Is every call of `symbol` in `body` on the deferPostTransaction lane? A call
 * is on the lane when it is the queued action, or the inline fallback guarded
 * by `if (!deferPostTransaction(…))` on the same or the previous line. A bare
 * call anywhere else is the DATA-28 shape.
 */
function everyCallDeferred(body: string, symbol: string): boolean {
	const lines = body.split('\n');
	let calls = 0;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? '';
		if (!line.includes(`${symbol}(`) || line.includes('import(')) continue;
		calls += 1;
		const queued =
			line.includes(`deferPostTransaction(${symbol})`) ||
			line.includes(`deferPostTransaction(() => ${symbol}(`);
		const guard = 'if (!deferPostTransaction(';
		const guarded = line.includes(guard) || (lines[index - 1] ?? '').includes(guard);
		if (!queued && !guarded) return false;
	}
	return calls > 0;
}

describe('C. cache invalidation is deferred past COMMIT on every branch (DATA-28)', () => {
	test('POSITIVE CONTROL: a bare clear is not "deferred"', () => {
		expect(everyCallDeferred('\tinvalidateAllToolCaches();\n', 'invalidateAllToolCaches')).toBe(
			false,
		);
		// a fallback whose guard is NOT the lane is bare too
		expect(
			everyCallDeferred(
				'\tif (!other()) {\n\t\tinvalidateAllToolCaches();\n\t}',
				'invalidateAllToolCaches',
			),
		).toBe(false);
		expect(
			everyCallDeferred(
				'\tif (!deferPostTransaction(() => notify(x))) {\n\t\tnotify(x);\n\t}',
				'notify',
			),
		).toBe(true);
		expect(
			everyCallDeferred(
				'\tif (!deferPostTransaction(invalidateAllToolCaches)) invalidateAllToolCaches();\n',
				'invalidateAllToolCaches',
			),
		).toBe(true);
	});

	test('the tools branch, the listener fan-out and the ontology branch all ride deferPostTransaction', () => {
		const fire = bodyOf(SAVE_EVENT, 'fireSaveEvent');
		expect(everyCallDeferred(fire, 'invalidateAllToolCaches')).toBe(true);
		expect(everyCallDeferred(fire, 'notifySectionDataListeners')).toBe(true);
		// the ontology branch defers INSIDE its target
		const ontology = bodyOf(CACHE_INVALIDATION, 'clearOntologyDerivedCaches');
		expect(ontology).toContain('deferPostTransaction(');
		expect(fire).toContain('clearOntologyDerivedCaches()');
	});
});

// ---------------------------------------------------------------------------
// D. observers.ts — every catch is counted (TOTAL over the file)
// ---------------------------------------------------------------------------

/** Every `catch (…) { … }` block of a (comment-stripped) source, by brace matching. */
function catchBlocks(source: string): string[] {
	const blocks: string[] = [];
	const pattern = /catch\s*(?:\([^)]*\))?\s*\{/g;
	for (const match of source.matchAll(pattern)) {
		let depth = 1;
		let index = match.index + match[0].length;
		while (index < source.length && depth > 0) {
			const char = source[index];
			if (char === '{') depth += 1;
			else if (char === '}') depth -= 1;
			index += 1;
		}
		blocks.push(source.slice(match.index, index));
	}
	return blocks;
}

const uncountedCatches = (source: string): string[] =>
	catchBlocks(source).filter((block) => !block.includes('incrementCounter('));

describe('D. every catch in observers.ts increments a counter (DATA-29)', () => {
	test('POSITIVE CONTROL: a swallow with only console.error is reported', () => {
		const offender =
			'try { a(); } catch (error) {\n\tconsole.error("swallowed", error);\n}\ntry { b(); } catch (e) { incrementCounter("x"); }';
		expect(uncountedCatches(offender)).toHaveLength(1);
		expect(catchBlocks(offender)).toHaveLength(2);
	});

	test('TOTAL: no catch in observers.ts ends without a counter, and the file has the catches it claims', () => {
		const source = code(OBSERVERS);
		const blocks = catchBlocks(source);
		expect(blocks.length).toBeGreaterThanOrEqual(2);
		expect(
			uncountedCatches(source),
			'catch block(s) in observers.ts with no incrementCounter',
		).toEqual([]);
		// B6: propagation never runs inside a transaction (the ledger drains
		// post-commit and propagateToObservers refuses an ambient one), so the
		// in-transaction rethrow lane and its counter are GONE.
		expect(
			source,
			'the in-transaction propagation lane still exists — propagation runs inside a caller transaction (B6)',
		).not.toContain('observers_propagation_failed_in_tx');
		expect(source).toContain("incrementCounter('observers_propagation_failed')");
		// documented for operators, beside its sibling
		expect(read('engineering/PRODUCTION.md')).toContain('`observers_propagation_failed`');
	});
});
