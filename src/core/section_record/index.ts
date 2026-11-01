/**
 * section_record — the TS expression of the PHP section_record concept.
 *
 * PHP wraps one matrix row in a stateful middleware object
 * (core/section_record/class.section_record.php): JSONB parsing, model→column
 * routing, uniform read/write API, and on-the-fly column substitution (the
 * matrix_time_machine/dd15 case). TS keeps the CONTRACTS but not the class
 * shape — see src/core/concepts/section_record.ts for the full mapping:
 *
 *   uniform record interface → the MatrixRecord struct (db/matrix.ts),
 *                              threaded explicitly through the call tree
 *   write chokepoint         → record_write.ts persistRecordKeys /
 *                              persistRecordColumns / persistRecordBirth and
 *                              their named siblings (audit merge, PHP
 *                              key-removal semantics, the derived
 *                              relation_search index) ending in the ONE
 *                              post-write hook afterRecordWrite (save event,
 *                              security reaction, RAG seam, the observer
 *                              obligation ledger — obligation_ledger.ts)
 *   substitution API         → virtual_record.ts makeVirtualRecord /
 *                              cloneRecord / injectComponentData
 *   post-write fan-out       → save_event.ts (cache invalidation + RAG seam)
 *   dd15 materializer        → src/core/tm_record/ (built on the above)
 */

export {
	type KeyChange,
	type ObservedDeclaration,
	removedLocators,
	type WriteReceipt,
} from './obligation_ledger.ts';
export {
	type AuditStamp,
	afterRecordWrite,
	applyKeySaveRules,
	buildModifiedAuditWrites,
	type ChangedKeysDoor,
	dropCoveredObserverUnits,
	hiIndexDisagrees,
	persistAppendedKeyItems,
	persistModifiedStamp,
	persistObserverMirrorKeys,
	persistObserverResaveKeys,
	persistRecordBirth,
	persistRecordColumns,
	persistRecordKeys,
	persistRelationRemovalKeys,
	persistRestoredKeys,
	prepareBirthColumns,
	type RecordWriteObligations,
	type RecordWriteTarget,
	requestCoveredSlotRecompute,
	type SavePathItem,
	type WriteDerivation,
} from './record_write.ts';
export {
	fireRagRecordEvent,
	fireSaveEvent,
	type RagRecordEvent,
	registerRagRecordHook,
} from './save_event.ts';
export {
	cloneRecord,
	injectColumnData,
	injectComponentData,
	isVirtualRecord,
	makeVirtualRecord,
	VIRTUAL_RECORD_ID,
} from './virtual_record.ts';
