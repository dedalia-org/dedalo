/**
 * TRIPWIRE — EVERY DOOR THAT CAN WRITE A dd128 COMPONENT CONSULTS THE OWN-RECORD LEVEL
 * RULE (P1-2, SEC-03), or is an ENUMERATED exemption with a written reason.
 *
 * `resolveOwnUserRecordPermission` forces level 1 on dd244 always, and on
 * dd1725/dd515/dd132/dd330 for a non-global-admin, so a user cannot hand themselves a
 * profile, the developer flag, a new username or a different section_id. Its own
 * docblock says missing the DOWNGRADE half is a privilege-escalation hole — and it was a
 * HELPER three doors remembered to call. Every other write door read the RAW matrix
 * level, so a principal holding level 2 on `(dd128, dd1725)` — the departmental
 * user-manager role the downgrade exists to neutralise — was refused by the human save
 * door and SUCCEEDED through `tool_propagate_component_data` and through MCP
 * `set_field`, whose helper took no `sectionId` at all.
 *
 * The rule is now part of the RESOLUTION (`getRecordComponentPermission`), and this gate
 * is what makes forgetting it VISIBLE rather than silent.
 *
 * THE CENSUS IS TOTAL BY DERIVATION, NOT BY HAND. The door set is derived at run time
 * from the callers of the record-write primitives across `src/` and the tools' `server/`
 * trees. A new caller that is not in the table below fails this gate — which is the
 * whole point: the previous shape of this invariant was a rule stated in a docblock,
 * and thirteen doors did not know about it.
 *
 * WHAT THE VERDICTS MEAN, and what is mechanically checked for each:
 *
 *   consults      — the file resolves a record-addressed component level through
 *                   `getRecordComponentPermission`. CHECKED: the symbol is present.
 *   delegates     — the file's dd128-reachable writes are authorized by THE WRITE
 *                   DOOR (security/write_door.ts — closure Step 3), which applies the
 *                   rule. CHECKED BY OUTCOME, never by spelling: the file is a key of
 *                   DD128_PROBED (test/helpers/authz_door_probes.ts), and the
 *                   authorization-door matrix (authz_door_matrix_native) drives every
 *                   door listed for it with a `(dd128, dd1725)` user-manager on their
 *                   OWN account and requires the refusal. An ENGINE (no principal of
 *                   its own) may claim it only through its callers, so its IMPORTER
 *                   SET is derived from the source on every run and must equal the
 *                   delegating doors named in DELEGATING_ENGINES — a new caller puts
 *                   the row back to red until it is named (and probed) or the row
 *                   returns to PENDING.
 *   engine        — a write PRIMITIVE. Its docblock states that authorization is the
 *                   caller's responsibility; putting the rule here would authorize
 *                   nothing (there is no principal) — the callers above are the doors.
 *   section-level — the door's gate carries no COMPONENT tipo (a create, a duplicate, a
 *                   whole-record delete, a batch with no single record). The
 *                   per-component rule has nothing to say about it and cannot be
 *                   consulted even in principle.
 *   system        — no principal at all: propagation, provisioning, installer,
 *                   fixtures, the update transform. These run as the engine, not as a
 *                   user; a permission rule would have no actor to judge.
 *   not-dd128     — the write target section is hard-bound to something that is not the
 *                   users section, so no dd128 component can be reached through it.
 *   self          — the write is the ACTOR'S OWN account, already proved by a
 *                   credential in this same call (a verified password, a one-time code).
 *   PENDING       — a door that CAN write a dd128 component and does NOT yet consult the
 *                   rule. Each row names the finding. CHECKED: the symbol is ABSENT, so
 *                   fixing one FAILS this gate and forces the row to move to `consults`
 *                   — a fix cannot land silently. The list is SHRINK-ONLY.
 *
 * PENDING IS NOT AN EXCUSE, IT IS A LEDGER. Every row in it is a real residual of
 * SEC-03, left open because the file is outside the change that wrote this gate; the
 * count is pinned so the set can only get smaller.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { DD128_PROBED } from '../helpers/authz_door_probes.ts';
import {
	AFTER_RECORD_WRITE,
	buildWriterClosure,
	RECORD_WRITE_CHOKEPOINTS,
	SANCTIONED_DERIVED_WRITERS,
	type WriterClosure,
} from '../helpers/matrix_writer_closure.ts';

const ROOT = resolve(import.meta.dir, '../..');

/**
 * The five modules that OWN record writes. Everything below derives from these, so the
 * primitive list underneath is not a hand-kept enumeration that a new writer can slip
 * past: `the primitive list is DERIVED, not enumerated` (below) reads their exports and
 * fails when one appears that is neither a primitive nor a declared non-writer.
 *
 * WHY THIS EXISTS. The census walks all of `src/` and `tools/*​/server/`, so it is total
 * over FILES — but only over files that call one of the primitives, and that list was
 * typed by hand. A sixth record-write export added to any of these modules would have
 * been invisible to a gate whose describe() block says the census is TOTAL. It found one
 * on its first run: `persistModifiedStamp`.
 */
const WRITE_MODULES = [
	'src/core/section/record/save_component.ts',
	'src/core/section_record/record_write.ts',
	'src/core/section/record/create_record.ts',
	'src/core/section/record/duplicate_record.ts',
	'src/core/section/record/delete_record.ts',
];

/**
 * Exports of a WRITE_MODULE that are NOT record-write primitives. Each needs a reason:
 * the point of the derivation is that classifying a new export is a decision somebody
 * has to make in this file, not an omission nobody notices.
 */
const NON_PRIMITIVE_EXPORTS: Record<string, string> = {
	wipedComponentValue:
		'a pure value rule (what a data wipe leaves in one key); reads config, writes nothing.',
	isInstalledDataLang: 'a language predicate; reads config, writes nothing.',
	installedDataLangs: 'a language accessor; reads config, writes nothing.',
	ontologyTldRefusal: 'builds a refusal message from an ontology node; writes nothing.',
	normalizeItemId: 'a value normalizer over an in-memory item; writes nothing.',
	getIdFromKey: 'parses an id out of a key string; writes nothing.',
	applyUpdate: 'the in-memory merge that PRODUCES the value a primitive then persists.',
	buildModifiedAuditWrites: 'builds the audit column payload; the caller persists it.',
	virtualDateNow: 'the ALS-scoped clock for a record being created; writes nothing.',
	buildRecordMetadata: 'assembles the new record’s metadata object; writes nothing.',
	auditUserLocator: 'builds the dd_modified_by locator value; writes nothing.',
	auditDateItem: 'builds the dd_modified_date item; writes nothing.',
	unnamedRemoveRefusal:
		'a PURE PREDICATE over a changed_data array (P0-8, 2026-08-30): it answers with a refusal message when a `remove` names no item, and writes nothing at all. It is exported so the in-memory temporal door can refuse exactly what the persisted door refuses — one law, two doors — which is the opposite of a second write path.',
	persistModifiedStamp:
		'DOES write the matrix, but only the modified-by/modified-date audit columns of a record a primitive is already writing. It can never carry a dd131/dd244/dd133 value, so it is not an account transition and adding it to the primitive list would widen the door set to every save path twice over.',
	prepareBirthColumns:
		'the NEW-record birth-column law (CLOSURE_PLAN Step 2): drops the covered observer units (mirror + its frames) out of a whole-record column set and re-derives its `_hi` relation_search, IN MEMORY — the create/duplicate primitives persist what it returns; it writes nothing.',
	dropCoveredObserverUnits:
		'the covered-unit half of the birth law, IN MEMORY: removes each covered observer mirror AND its own dataframe frames from a column set (the duplicate calls it before its frame-target re-mint); it writes nothing.',
	requestCoveredSlotRecompute:
		'writes NOTHING itself: it queues a recompute of the record’s covered observer slots on the obligation ledger; the recompute writes the mirror through persistObserverMirrorKeys, a chokepoint primitive below. A mirror slot is derived state, never a credential.',
	hiIndexDisagrees:
		'a PURE comparison of a stored `_hi` ancestor index against the save law’s derivation; reads the thesaurus chain, writes nothing.',
	bornInCurrentTransaction:
		'a READ-ONLY xmin predicate (2026-10-01): one SELECT comparing a row’s xmin with the ambient transaction’s xid, answering whether the record was written by that transaction (the conflict-tolerant create’s birth law, shared with the CSV importer); refuses outside a transaction and writes nothing.',
	afterRecordWrite:
		'writes NOTHING to the matrix: it is the post-write obligation hook (P1-8, 2026-09-03) every primitive ends in — save event, the security reaction, the RAG seam — and the two insert doors call it AFTER their own primitive. A caller of it is already a caller of a primitive; listing it would double-count every door.',
};

/**
 * The record-write primitives. A file that calls one of these WRITES A RECORD, which is
 * the only definition of "door" that cannot be gamed by renaming a handler.
 */
const WRITE_PRIMITIVES = [
	'saveComponentData(',
	'persistRecordKeys(',
	'persistRecordColumns(',
	'createSectionRecord(',
	'duplicateSectionRecord(',
	'deleteSectionRecord(',
	'deleteSectionData(',
	'deletePortalLocator(',
	// The chokepoint's own ENTRIES (CLOSURE_PLAN Step 2, the obligation ledger): each
	// persists a record's keys or columns and ends in afterRecordWrite — so a file that
	// calls one IS a write door, exactly like a persistRecordKeys caller.
	'persistRelationRemovalKeys(',
	'persistRestoredKeys(',
	'persistObserverMirrorKeys(',
	'persistAppendedKeyItems(',
	'persistRecordBirth(',
	'duplicateSectionRecordWithVerdict(',
];

/** The resolver that carries the rule. */
const RULE_SYMBOL = 'getRecordComponentPermission';

type Verdict =
	| 'consults'
	| 'delegates'
	| 'engine'
	| 'section-level'
	| 'system'
	| 'not-dd128'
	| 'self'
	| 'PENDING';

interface CensusRow {
	verdict: Verdict;
	reason: string;
}

const CENSUS: Record<string, CensusRow> = {
	// --- CONSULTS ---------------------------------------------------------
	// --- DELEGATES (the write door; measured by the matrix, DD128_PROBED) --
	'src/core/api/handlers/dd_core_api.ts': {
		verdict: 'delegates',
		reason:
			'the human save door delegates to authorizeRecordAccess (sectionFloor 0, the named exception), duplicate / delete of a named record to authorizeSectionRecord and create to authorizeSectionTarget — the rule is the write door’s pair half; the matrix’s dd_core_api:save DD1725 leg proves it.',
	},
	'src/ai/mcp/tools/fields_write.ts': {
		verdict: 'delegates',
		reason:
			'MCP set_field / portal_link / portal_unlink / find_or_create / duplicate: the private assertWritePermission is gone; authorizeRecordAccess (write, level 2, section floor 1) for a record — BOTH self-authorizing writers, setField and portalUnlink, are probed doors (DD128_PROBED) — authorizeSectionTarget for find_or_create’s create and its field pre-flight, authorizeSectionRecord for a duplicate.',
	},
	'src/ai/mcp/tools/records_write.ts': {
		verdict: 'delegates',
		reason:
			'MCP save_component (authorizeRecordAccess), create_record (authorizeSectionTarget) and delete_record (authorizeSectionRecord — the id required by the door), consultation-capped — same write door as the human doors.',
	},
	'src/core/relations/save.ts': {
		verdict: 'delegates',
		reason:
			'deletePortalLocator mints a RecordGrant through authorizeRecordAccess (write, level 2, floor 2: dd128-aware pair + scope) before any read, lock or write; the effect is a private function typed on the grant and audited as grant.userId; applyAddNewElement’s createSectionRecord is a birth under the save door. Matrix dd_component_portal_api:delete_locator DD1725 leg.',
	},
	'src/core/relations/children_write.ts': {
		verdict: 'not-dd128',
		reason:
			'the component_relation_children write-through (WC-2026-10-02): its writes are HARD-BOUND to the child section’s component_relation_parent (and that section’s section_map order number) — the users section declares no parent component (relation_children_write_through_native asserts getParentTipo(dd128) is null), so no dd128 component is reachable. Every child is still asked of authorizeRecordAccess (write, level 2, door `save`, the dd128-aware pair + scope) before any write.',
	},
	'src/core/relations/children_orphan_sweep.ts': {
		verdict: 'system',
		reason:
			'the operator CLI sweep (scripts/relation_children_orphan_sweep.ts, dry-run default) removing leftover bytes under component_relation_children tipos through persistRecordKeys as userId -1; its keys are derived children tipos (never a dd128 component), and no request or principal exists.',
	},
	'src/core/api/handlers/dd_component_portal_api.ts': {
		verdict: 'delegates',
		reason:
			'no gate of its own; its only effect is deletePortalLocator, the write door; the matrix drives the handler gate-free, so the DD1725 leg measures the engine.',
	},
	'tools/tool_propagate_component_data/server/index.ts': {
		verdict: 'consults',
		reason:
			'THE SEC-03 offender: its per-row re-authorization holds row.section_id and read the raw matrix level, so a self-targeted propagate of dd1725/dd515 succeeded where the human save door refused.',
	},

	// --- ENGINES ----------------------------------------------------------
	'src/core/section/record/save_component.ts': {
		verdict: 'engine',
		reason:
			'THE write engine. Its docblock states authorization is the caller’s responsibility and it holds no principal; the doors above are where the rule can be judged.',
	},
	'src/core/section_record/record_write.ts': {
		verdict: 'engine',
		reason: 'the matrix key/column write chokepoint — no principal, no permission concept.',
	},
	'src/core/section/record/create_record.ts': {
		verdict: 'engine',
		reason: 'record creation primitive; a create addresses no existing record.',
	},
	'src/core/section/record/delete_record.ts': {
		verdict: 'engine',
		reason:
			'record delete primitive; it carries its own non-positive-id refusal (both modes) and no component tipo.',
	},
	'src/core/section/record/duplicate_record.ts': {
		verdict: 'engine',
		reason: 'record duplication primitive; whole-record, no component tipo.',
	},
	'src/core/relations/dataframe.ts': {
		verdict: 'engine',
		reason:
			'the dataframe slot delete-policy applier (applyDataframeDeletePolicy): empties or deletes the FRAME TARGET records an unlinked dd490 pairing addressed — an ontology-declared frame section, whole-record, no component tipo. It asks the write grant (level 2) on every target section ITSELF (assertFrameTargetWriteGrant, resolvePrincipal + getSectionPermissions) before queueing, because the calling door was authorized on the HOST only.',
	},

	// --- SECTION-LEVEL ----------------------------------------------------
	'src/core/ts_object/ts_api.ts': {
		verdict: 'section-level',
		reason:
			'thesaurus tree add_child / delete: its gate is getPermissions(sectionTipo, sectionTipo) and its writes are whole records — no component pair exists to downgrade.',
	},
	'src/core/section/record/temporal.ts': {
		verdict: 'section-level',
		reason:
			'WC-059 temporal instances address no matrix record (the section_id is a client sentinel), so there is no record for the own-record rule to match.',
	},
	'tools/tool_hierarchy/server/tool_hierarchy.ts': {
		verdict: 'section-level',
		reason:
			'hierarchy provisioning behind permission:’section’, writing hierarchy sections; no caller-supplied component pair.',
	},

	// --- SYSTEM (no principal) -------------------------------------------
	'src/core/section/record/observers.ts': {
		verdict: 'system',
		reason:
			'the observer mirror propagation (its recompute writes through persistObserverMirrorKeys). It runs as the engine after a committed save, with no actor to judge; gating it would make a mirror depend on who happened to trigger it.',
	},
	'src/core/update/transform/portalize.ts': {
		verdict: 'system',
		reason: 'a code-update data transform, run by the updater as userId -1.',
	},
	'src/core/install/hierarchy_activate.ts': {
		verdict: 'system',
		reason: 'installer/activation path — no request, no principal.',
	},
	'src/core/ontology/ontology_write.ts': {
		verdict: 'system',
		reason: 'the dd_ontology write driver; its targets are ontology sections, never dd128.',
	},
	'src/core/ontology/hierarchy_provision.ts': {
		verdict: 'system',
		reason: 'hierarchy provisioning; ontology/hierarchy sections only.',
	},
	'src/core/ontology/data_io.ts': {
		verdict: 'system',
		reason: 'ontology import/export of the `<tld>0` info sections.',
	},
	'src/core/test_data/synthetic_hierarchy_fixture.ts': {
		verdict: 'system',
		reason: 'a repo-owned test fixture builder; it runs under the test-database marker guard.',
	},
	'src/core/area_maintenance/user_stats.ts': {
		verdict: 'system',
		reason:
			'writes its own hard-bound stats section as userId -1; the maintenance area is already global-admin/developer gated.',
	},
	'src/core/ontology/engine_ontology.ts': {
		verdict: 'system',
		reason:
			'the ENGINE-OWNED ontology door: writes only `ddengine0` matrix_ontology source records (persistRecordColumns, actor -1) from the repo-owned engine_ontology.json — refused unless every node is under the engine TLD — at boot, install and suite setup. No request, no principal.',
	},
	'src/core/area_maintenance/widgets/export_hierarchy.ts': {
		verdict: 'system',
		reason: 'maintenance-area hierarchy export; hard-bound hierarchy/lang sections.',
	},

	// --- NOT dd128 --------------------------------------------------------
	'src/core/security/ai_spend.ts': {
		verdict: 'not-dd128',
		reason:
			'the AI spend ledger: its only writes are the HARD-BOUND ledger section (AI_SPEND_LEDGER.section, `ddengine1` — createSectionRecord for the day, persistRecordKeys for its user/day/counter components); the caller supplies a principal and amounts, never a section or a component, so no dd128 component is reachable through it.',
	},
	'src/core/security/section_permissions.ts': {
		verdict: 'not-dd128',
		reason:
			'writes dd774 on a PROFILE record (dd234). It is the door that CREATES the (dd128, dd1725) grant this whole item is about, but it never writes dd128 itself.',
	},

	// --- SELF (credential already proved in this call) ---------------------
	'src/core/security/auth.ts': {
		verdict: 'self',
		reason:
			'the login-time password COST UPGRADE: the actor’s own dd133, rewritten with the same plaintext they proved they knew a millisecond earlier. It is also the one caller of runWithoutAccountRevocation.',
	},
	'src/core/security/password_reset.ts': {
		verdict: 'self',
		reason:
			'self-service recovery writes the requester’s own dd133 after a one-time emailed code; the account is re-validated (exists + dd131 active) at confirm time.',
	},

	// --- PENDING (real SEC-03 residuals) ----------------------------------
	'src/core/components/component_text_area/tag_delete.ts': {
		verdict: 'delegates',
		reason:
			'the tag-delete engine; its ONLY importer is dd_component_text_area_api (DERIVED on every run — DELEGATING_ENGINES), whose delete_tag runs authorizeRecordAccess (write, level 2) before it and hands it the grant’s address.',
	},
	'src/core/tools/translation.ts': {
		verdict: 'delegates',
		reason:
			'runAutomaticTranslation mints a RecordGrant through authorizeRecordAccess (write, level 2, section floor 1: grammar, the dd128-aware pair, the write scope) before any provider call; the writer translateAndWrite TAKES the grant (branded, only write_door mints it) and builds its target and actor from it, so no importer reaches the write ungated. Matrix tool:tool_lang / tool_lang_multi automatic_translation DD1725 legs (closure Step 3 req 10).',
	},
	'src/core/tools/import_execute.ts': {
		verdict: 'delegates',
		reason:
			'importMappedRecords takes the importing PRINCIPAL and asks the write door per field: a matched record through authorizeRecordAccess (write, level 2, section floor 1, dd128-aware pair, write scope), a new record and its fields through authorizeSectionTarget before the create; a refused field is reported IGNORED and never written (req 10). Matrix engine:import_execute.importMappedRecords DD1725 leg (matched record); the create door: import_create_door_native (LEVEL_1 refused, zero rows; CONTROL created).',
	},
	'src/core/tools/import_csv_execute.ts': {
		verdict: 'delegates',
		reason:
			'executeCsvImport takes the importing PRINCIPAL: a row that creates its record asks authorizeSectionTarget (section) first; every column — and every slot a legacy frame envelope names — of an existing record asks authorizeRecordAccess (write, level 2, section floor 1, dd128-aware pair, write scope), of a new one authorizeSectionTarget (the pair); a refused column is reported IGNORED, never written, its metadata never applied (req 10). Matrix engine:import_csv_execute.executeCsvImport DD1725 leg (existing record); the create door, the column pair of a created row and the legacy frame slots: import_create_door_native.',
	},
	'src/core/tools/transcription_asr.ts': {
		verdict: 'PENDING',
		reason:
			'the transcript writer: pollTranscriptionCompletion REQUIRES its caller’s save (no default since closure Step 3), and tool_transcription passes one that re-runs the write door for a live principal — but the exported saveTranscriptionResult itself checks no pair, dd128 or scope (any future importer writes ungated), and no matrix door drives the poll’s save with a (dd128, dd1725) manager, so the file claims nothing of its own.',
	},
	'src/core/media/ingest/companion_writes.ts': {
		verdict: 'delegates',
		reason:
			'every ontology-declared companion (target_filename / target_duration) is asked of authorizeRecordAccess AS THE UPLOADER (write, level 2, section floor 1, dd128-aware pair, write scope) before saveComponentData, which the grant addresses; a refusal is a message, never a write (req 10). Matrix engine:media_ingest.companion_writes DD1725 leg (a scratch media component whose target_filename names dd1725).',
	},
	'tools/tool_import_files/server/index.ts': {
		verdict: 'delegates',
		reason:
			'every component this run writes into a record bound at RUN TIME asks the write door for the whole triple (req 10): the ddo_map role writes (setComponentsData → authorizeRecordAccess, whose grant addresses the save), the media component and the host portal (assertWritableComponent → authorizeRecordAccess; a record born in the run → authorizeSectionTarget). Matrix tool:tool_import_files:import_files:roles DD1725 leg.',
	},
	'tools/tool_import_rdf/server/rdf_import_execute.ts': {
		verdict: 'delegates',
		reason:
			'executeRdfImport takes the importing PRINCIPAL and asks the write door per component: the caller record and every term bound at RUN TIME by the code lookup through authorizeRecordAccess (write, level 2, section floor 1, dd128-aware pair, write scope); a create through authorizeSectionTarget (the section, then the match component pair) before createSectionRecord, the new record\u2019s components at the pair; a refused write is reported skipped and never written. Gate: rdf_import_execute_native (LEVEL_1 refused, zero rows; CONTROL written).',
	},
	'tools/tool_import_dedalo_csv/server/index.ts': {
		verdict: 'not-dd128',
		reason:
			'its OWN writes are the hard-bound dd800 run record (createSectionRecord + its label save); every data row is written by executeCsvImport (import_csv_execute.ts — `delegates`, the write door per row and column, req 10), handed the request principal.',
	},
	'tools/tool_numisdata_acquisition/server/index.ts': {
		verdict: 'not-dd128',
		reason:
			'commit_lots writes only HARD-BOUND sections and components named by module constants, never by the payload: NUMISDATA_OBJECT_TIPO (the lot), AUCTION_SECTION_TIPO (the Auction), ENTITY_SECTION_TIPO (the Entity), IMAGE_SECTION_TIPO (the coin-face image records, born by the OBVERSE_PORTAL_TIPO / REVERSE_PORTAL_TIPO portal add_new_element). Each is declared in its `targets` list — the section AND every (section, component) pair it writes — and src/core/tools/security.ts gates every entry through authorizeSectionTarget (level 2, the dd128-aware pair) before the handler runs. The payload supplies only VALUES and an ENTITY_SECTION_TIPO entity id (isRecordInScope-checked for a non-admin, an out-of-scope id is dropped for the name-based selection; written as a LOCATOR into AUCTION_COMPANY_TIPO, never addressed as a write target).',
	},
	'tools/tool_bibliography_acquisition/server/index.ts': {
		verdict: 'not-dd128',
		reason:
			'commit_publications writes only HARD-BOUND sections and components named by module constants, never by the payload: PUBLICATION_TIPO (the publication), PEOPLE_SECTION_TIPO (People), SERIES_SECTION_TIPO (Series). Each is declared in its `targets` list — the section AND every (section, component) pair it writes, DOCUMENT_TIPO (the PDF) included — and src/core/tools/security.ts gates every entry through authorizeSectionTarget (level 2, the dd128-aware pair) before the handler runs. Existing People/Series and the fixed dd810/dd292 terms are only LOCATOR targets, never written.',
	},
	'tools/tool_posterframe/server/index.ts': {
		verdict: 'delegates',
		reason:
			'create_identifying_image: the AV SOURCE behind the declarative record_tipo/1 gate, the HOST portal of the host record through authorizeRecordAccess in the handler (write, level 2, section floor 1, dd128-aware pair, write scope with the non-positive-id refusal ahead of the admin bypass — req 10) whose GRANT addresses the portal save, and the new record\u2019s image through authorizeSectionTarget. Matrix tool:tool_posterframe:create_identifying_image:host DD1725 leg.',
	},
	'tools/tool_tc/server/index.ts': {
		verdict: 'PENDING',
		reason:
			'its one writer, change_all_timecodes, is behind the declarative record_tipo kind — the write door, proven for the GATE by the security.ts row — but that the handler writes exactly the pair the gate authorized is not measured (the matrix never runs the handler), so this row claims nothing of its own.',
	},
	'tools/tool_update_cache/server/index.ts': {
		verdict: 'delegates',
		reason:
			'update_cache: the declarative targets gate authorizes the (sqo section, component) pairs, and the handler asks authorizeRecordAccess (write, level 2, section floor 1, dd128-aware pair, write scope) for EVERY matched row × component before touching it — the grant addresses the save / the media transform; a refused target is skipped and reported (req 10). Matrix tool:tool_update_cache:update_cache DD1725 leg.',
	},
	'tools/tool_time_machine/server/bulk_revert.ts': {
		verdict: 'not-dd128',
		reason:
			'Since the undo-log rewrite (2026-09-27) the orchestrator writes ONLY its own run record: the dd800 row (createSectionRecord) and its dd796 label (persistRecordKeys) — never a dd128 component. The component writes moved to bulk_revert_undo.ts (PENDING, SEC-03 carried over) and the record writes to bulk_revert_records.ts.',
	},
	'tools/tool_time_machine/server/bulk_revert_undo.ts': {
		verdict: 'delegates',
		reason:
			'every component a revert unit WRITES — the key, each slot its frame plan restores, each key of a composed unit — asks authorizeRecordAccess (write, level 2, section floor 1, the dd128-aware pair, the write scope) with the reverting principal, behind the unit\u2019s lock and after any undelete (authorizeKeyWrite, req 10); a refusal is the unit\u2019s out_of_scope skip, rolled back. Matrix tool:tool_time_machine:bulk_revert_process:units DD1725 leg (the orchestrator\u2019s raw-pair pre-gate does not see the own-record rule, so the leg measures this writer).',
	},
	'tools/tool_time_machine/server/bulk_revert_records.ts': {
		verdict: 'section-level',
		reason:
			'the bulk revert’s RECORD half: undeletes a record the run’s cascade deleted (restoreSection) and deletes a record the run created (the delete door) — whole records only, gated by getSectionPermissions(section) >= 2 plus the record scope (the delete door’s own rule). No component pair exists to downgrade.',
	},
	'tools/tool_time_machine/server/tool_time_machine.ts': {
		verdict: 'PENDING',
		reason:
			'apply_value restore: its level check is the inherited declarative tipo gate; it scopes the record but never consults the component rule.',
	},
	'tools/tool_time_machine/server/dataframe_restore.ts': {
		verdict: 'PENDING',
		reason: 'the dataframe half of the same restore path, writing through persistRecordKeys.',
	},
};

/**
 * Doors that gate a dd128 component write WITHOUT calling a write primitive themselves —
 * the derivation above cannot see them, so they are named. The declarative gate is the
 * important one: every tool action that declares `permission: 'tipo'` or
 * `'record_tipo'` inherits it, which is how one un-consulting function became the level
 * gate for a dozen tools at once.
 */
const EXTRA_ROWS: Record<string, CensusRow> = {
	'src/core/tools/security.ts': {
		verdict: 'delegates',
		reason:
			'THE declarative tool gate every tool inherits: kinds record / record_tipo / tipo / section / targets delegate to the write door (authorizeRecordAccess / authorizeSectionTarget) — the dd128-aware pair, the id grammar, the non-positive-id refusal ahead of the admin bypass.',
	},
	'src/core/api/handlers/dd_component_text_area_api.ts': {
		verdict: 'delegates',
		reason:
			'the tag-delete wire door: authorizeRecordAccess (write, level 2, section floor 0 — the save door’s named exception, write_door SECTION_FLOOR_ZERO_DOORS, WC-2026-09-30-write-door) before the options are read — the SEC-05 and SEC-03 shapes both closed by the write door’s order.',
	},
};

/** PINNED. Shrink-only: this may go DOWN, never up. */
const PENDING_COUNT = 4;

/**
 * THE DELEGATING ENGINES — a `delegates` row on a file with no principal of its
 * own stands ONLY on its callers. Each engine names the exact set of files that
 * import it; the set is DERIVED from the source (static and dynamic imports
 * across src/ and tools/) on every run and must be EQUAL, and every importer
 * must itself be a probed `delegates` door. A new importer — which would write
 * through the engine with no gate of its own — is red here until it is named
 * and probed, or the engine row goes back to PENDING.
 */
const DELEGATING_ENGINES: Readonly<Record<string, readonly string[]>> = {
	'src/core/components/component_text_area/tag_delete.ts': [
		'src/core/api/handlers/dd_component_text_area_api.ts',
	],
};

/** Every non-test .ts file under src/ and tools/ that imports `engine` (static or dynamic). */
function importersOf(engine: string): string[] {
	const target = join(ROOT, engine);
	const importers: string[] = [];
	for (const file of [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'tools'))]) {
		if (file === target) continue;
		const source = readFileSync(file, 'utf8');
		for (const match of source.matchAll(
			/(?:\bfrom\s*|\bimport\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g,
		)) {
			if (resolve(dirname(file), match[1] as string) === target) {
				importers.push(relative(ROOT, file));
				break;
			}
		}
	}
	return importers.sort();
}

function walk(dir: string, acc: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) walk(path, acc);
		else if (path.endsWith('.ts') && !path.endsWith('.d.ts')) acc.push(path);
	}
	return acc;
}

/** Every file under scan that calls a record-write primitive. */
function deriveWriteDoors(): string[] {
	const files = [
		...walk(join(ROOT, 'src')),
		...walk(join(ROOT, 'tools')).filter((path) => path.includes('/server/')),
	];
	const doors: string[] = [];
	for (const file of files) {
		const source = readFileSync(file, 'utf8');
		if (WRITE_PRIMITIVES.some((primitive) => source.includes(primitive))) {
			doors.push(relative(ROOT, file));
		}
	}
	return doors.sort();
}

const derived = deriveWriteDoors();
const allRows: Record<string, CensusRow> = { ...CENSUS, ...EXTRA_ROWS };

describe('the dd128 write-door census is TOTAL', () => {
	test('the derivation actually found doors (the scan is not silently empty)', () => {
		// Without this, a broken walk() would make every assertion below vacuous.
		expect(derived.length).toBeGreaterThan(20);
		expect(derived).toContain('src/core/api/handlers/dd_core_api.ts');
	});

	test('every derived write door has a census row', () => {
		const missing = derived.filter((file) => allRows[file] === undefined);
		expect(
			missing,
			`New record-write door(s) with no census row:\n  ${missing.join('\n  ')}\nAdd a row to CENSUS with a verdict and a written reason. If it can write a dd128 component, the verdict is 'consults' and the door must call ${RULE_SYMBOL}.`,
		).toEqual([]);
	});

	test('no census row names a file that is no longer a write door (stale rows)', () => {
		const derivedSet = new Set(derived);
		const stale = Object.keys(CENSUS).filter((file) => !derivedSet.has(file));
		expect(
			stale,
			`Census row(s) for files that no longer call a write primitive:\n  ${stale.join('\n  ')}`,
		).toEqual([]);
	});

	test('every row carries a real reason, not a placeholder', () => {
		for (const [file, row] of Object.entries(allRows)) {
			expect(row.reason.length, `${file}: the reason is too short to be a reason`).toBeGreaterThan(
				40,
			);
		}
	});

	test('the EXTRA rows name real files', () => {
		for (const file of Object.keys(EXTRA_ROWS)) {
			expect(() => statSync(join(ROOT, file)), `${file} does not exist`).not.toThrow();
		}
	});
});

describe('the verdicts are true of the source, not just of the table', () => {
	test("every 'consults' door really calls the resolver", () => {
		for (const [file, row] of Object.entries(allRows)) {
			if (row.verdict !== 'consults') continue;
			const source = readFileSync(join(ROOT, file), 'utf8');
			expect(
				source.includes(RULE_SYMBOL),
				`${file} is marked 'consults' but never calls ${RULE_SYMBOL}`,
			).toBe(true);
		}
	});

	test("every 'delegates' door is MEASURED: a DD128_PROBED key (the matrix drives its DD1725 leg)", () => {
		const delegating = Object.entries(allRows).filter(([, row]) => row.verdict === 'delegates');
		expect(delegating.length).toBeGreaterThan(0);
		for (const [file] of delegating) {
			expect(
				DD128_PROBED[file] !== undefined && (DD128_PROBED[file]?.length ?? 0) > 0,
				`${file} is marked 'delegates' but is not in DD128_PROBED — name the matrix door whose DD1725 leg proves it (test/helpers/authz_door_probes.ts), or it is not delegating, it is hoping.`,
			).toBe(true);
		}
		// And no DD128_PROBED entry names a file the census does not call 'delegates'.
		for (const file of Object.keys(DD128_PROBED)) {
			expect({ file, verdict: allRows[file]?.verdict }).toEqual({ file, verdict: 'delegates' });
		}
	});

	test('a delegating ENGINE stands on its callers: its DERIVED importer set equals the named delegating doors', () => {
		expect(Object.keys(DELEGATING_ENGINES).length).toBeGreaterThan(0);
		for (const [engine, named] of Object.entries(DELEGATING_ENGINES)) {
			expect({ engine, verdict: allRows[engine]?.verdict }).toEqual({
				engine,
				verdict: 'delegates',
			});
			const derivedImporters = importersOf(engine);
			// FLOOR: the scan really resolved an import (a broken regex would pass on []).
			expect(derivedImporters.length, `${engine}: no importer found at all`).toBeGreaterThan(0);
			expect({ engine, importers: derivedImporters }).toEqual({
				engine,
				importers: [...named].sort(),
			});
			for (const importer of named) {
				expect({ importer, verdict: allRows[importer]?.verdict }).toEqual({
					importer,
					verdict: 'delegates',
				});
				expect((DD128_PROBED[importer]?.length ?? 0) > 0, `${importer} is not probed`).toBe(true);
			}
		}
	});

	test("every 'PENDING' door really does NOT — so a fix cannot land silently", () => {
		for (const [file, row] of Object.entries(allRows)) {
			if (row.verdict !== 'PENDING') continue;
			const source = readFileSync(join(ROOT, file), 'utf8');
			expect(
				source.includes(RULE_SYMBOL),
				`${file} now calls ${RULE_SYMBOL} — move its row from PENDING to 'consults' and lower PENDING_COUNT.`,
			).toBe(false);
		}
	});

	test('the PENDING list is SHRINK-ONLY', () => {
		const pending = Object.values(allRows).filter((row) => row.verdict === 'PENDING').length;
		expect(
			pending,
			`PENDING grew (${pending} > ${PENDING_COUNT}). A new door that can write a dd128 component must CONSULT the rule, not join the backlog.`,
		).toBeLessThanOrEqual(PENDING_COUNT);
		// And the pin stays honest: if the list shrank, lower it.
		expect(
			pending,
			`PENDING shrank to ${pending} — lower PENDING_COUNT to match, so the ratchet keeps biting.`,
		).toBe(PENDING_COUNT);
	});
});

describe('the rule is part of the resolution, not a helper', () => {
	test('getRecordComponentPermission applies the own-record rule before the matrix', async () => {
		const { getRecordComponentPermission, getPermissions, resolveOwnUserRecordPermission } =
			await import('../../src/core/security/permissions.ts');
		// A non-global-admin looking at their OWN user record: the raw matrix level and
		// the resolved one must DISAGREE, or this gate proves nothing.
		const self = { userId: 424242, isGlobalAdmin: false, isDeveloper: false };
		expect(resolveOwnUserRecordPermission(self, 'dd128', 'dd1725', 424242)).toBe(1);
		expect(await getRecordComponentPermission(self, 'dd128', 'dd1725', 424242)).toBe(1);
		// Someone ELSE's record falls through to the matrix, unchanged.
		expect(await getRecordComponentPermission(self, 'dd128', 'dd1725', 424243)).toBe(
			await getPermissions(self, 'dd128', 'dd1725'),
		);
		// dd244 is downgraded even for a global admin (PHP: unconditional).
		const admin = { userId: 424244, isGlobalAdmin: true, isDeveloper: false };
		expect(await getRecordComponentPermission(admin, 'dd128', 'dd244', 424244)).toBe(1);
		// The UPGRADE half survives: the self-service profile editor must keep working.
		expect(await getRecordComponentPermission(self, 'dd128', 'dd133', 424242)).toBe(2);
	});

	// The MCP write doors used to be pinned here by the SPELLING of a private
	// helper's signature. Since closure Step 3 they hold no helper at all: they
	// delegate to THE WRITE DOOR, and the OUTCOME — a `(dd128, dd1725)` manager
	// refused on their own account through dedalo_set_field / save_component — is
	// driven by authz_door_matrix_native (DD128_PROBED, test/helpers/authz_door_probes.ts).
});

// THE THREE RECORD-LIFECYCLE DOORS (save, duplicate, delete) refusing a non-positive id
// ahead of the admin bypass used to be pinned here by SPELLING (a count of
// `assertRecordWriteTarget(` calls). Since closure Step 3 they delegate to the write door
// (authorizeRecordAccess / authorizeSectionTarget), whose order is the module's own; the
// OUTCOME — a global admin refused on a non-positive id through each of the three doors — is
// driven by authz_door_matrix_native (ADMIN_ID0 on dd_core_api:save / :duplicate / :delete,
// aimed at the scratch section's -1 so a regressed door writes nothing that matters) and, on
// root's own dd128/-1, gate-only by write_door_native (leg b).

describe('the revocation trigger set is stated ONCE', () => {
	test('the transition set lives in security/revocation.ts and nowhere else', async () => {
		const { ACCOUNT_TRANSITION_COMPONENTS } = await import('../../src/core/security/revocation.ts');
		expect([...ACCOUNT_TRANSITION_COMPONENTS].sort()).toEqual(['dd131', 'dd132', 'dd133', 'dd244']);
		// A second COPY of the set would drift silently — the files would then disagree
		// about what an account transition IS. Individual tipos may of course appear
		// elsewhere (permissions.ts names dd132 in its own self-elevation rule); what may
		// not appear anywhere else is all FOUR together, which is the set.
		const owner = 'src/core/security/revocation.ts';
		for (const file of walk(join(ROOT, 'src'))) {
			const relPath = relative(ROOT, file);
			if (relPath === owner) continue;
			const source = readFileSync(file, 'utf8');
			const carriesAll = [...ACCOUNT_TRANSITION_COMPONENTS].every((tipo) =>
				source.includes(`'${tipo}'`),
			);
			expect(
				carriesAll,
				`${relPath} spells out all four transition tipos — that set belongs to ${owner} alone`,
			).toBe(false);
		}
	});

	test('the two SECTION constants agree between the chokepoint and the seam', async () => {
		// record_write.ts gates on the section tipos INLINE so the hot path of every
		// ordinary write pays two string compares and no import. That is a second copy,
		// and this is what stops it drifting.
		const { USERS_SECTION_TIPO, PROFILES_SECTION_TIPO } = await import(
			'../../src/core/security/revocation.ts'
		);
		const source = readFileSync(join(ROOT, 'src/core/section_record/record_write.ts'), 'utf8');
		const declared =
			/SECURITY_REACTIVE_SECTIONS: ReadonlySet<string> = new Set\(\[([^\]]*)\]\)/.exec(source);
		expect(
			declared,
			'record_write.ts no longer declares SECURITY_REACTIVE_SECTIONS',
		).not.toBeNull();
		const tipos = [...(declared?.[1] ?? '').matchAll(/'([a-z0-9]+)'/g)].map((match) => match[1]);
		expect(tipos.sort()).toEqual([PROFILES_SECTION_TIPO, USERS_SECTION_TIPO].sort());
	});
});

// ---------------------------------------------------------------------------
// THE REACH CENSUS (reviewer must-fix 3) — every write door reaches the seam
// ---------------------------------------------------------------------------

/**
 * A record-write primitive reaches the revocation seam in ONE of three ways, and which
 * one it is decides what this gate has to check of the primitive's CALLERS.
 *
 *   chokepoint — the primitive itself fires the reaction. `persistRecordKeys` and
 *                `persistRecordColumns` host it (record_write.ts, inside the one
 *                post-write hook afterRecordWrite, beside the save event and the RAG
 *                seam), `saveComponentData` funnels into them plus fires the same hook
 *                itself on the one atomic-insert branch that bypasses them, and
 *                `deletePortalLocator` persists its survivors through persistRecordKeys
 *                (P1-8, 2026-09-03 — it used to write with a direct updateMatrixKeyData
 *                and call invalidatePermissionsForWrite post-commit for itself). Nothing
 *                is asked of the caller: this is the point of moving the seam here.
 *                The obligation ledger's entries (persistRelationRemovalKeys,
 *                persistRestoredKeys, persistObserverMirrorKeys, persistAppendedKeyItems,
 *                persistRecordBirth — CLOSURE_PLAN Step 2) are the same class. Every 'chokepoint' verdict
 *                is MEASURED on the writer closure's call graph (reaches afterRecordWrite).
 *   callee     — a different function owns it, so its callers inherit the reach. No
 *                primitive is in this class today; the verdict stays defined so the
 *                next door that reaches the seam through a callee has a name for it.
 *   n/a        — the primitive cannot BE an account transition. A create addresses no
 *                existing account; a duplicate writes a NEW record and leaves the source
 *                untouched.
 *   caller     — the primitive holds no principal and no component tipo, so only the
 *                door can decide. The two record-DELETE primitives are the whole class:
 *                deleting a user record is SEC-08, and delete_record.ts cannot know it.
 *
 * Only the `caller` class needs a per-file verdict below.
 */
const PRIMITIVE_REACH: Record<string, 'chokepoint' | 'callee' | 'n/a' | 'caller'> = {
	'saveComponentData(': 'chokepoint',
	'persistRecordKeys(': 'chokepoint',
	'persistRecordColumns(': 'chokepoint',
	'createSectionRecord(': 'n/a',
	'duplicateSectionRecord(': 'n/a',
	'deletePortalLocator(': 'chokepoint',
	'deleteSectionRecord(': 'caller',
	'deleteSectionData(': 'caller',
	// The ledger's entries (record_write.ts): each ends in afterRecordWrite — asserted
	// on the CALL GRAPH below, not on a body's spelling.
	'persistRelationRemovalKeys(': 'chokepoint',
	'persistRestoredKeys(': 'chokepoint',
	'persistObserverMirrorKeys(': 'chokepoint',
	'persistAppendedKeyItems(': 'chokepoint',
	'persistRecordBirth(': 'chokepoint',
	// the duplicate's verdict-returning twin: writes a NEW record, like duplicateSectionRecord.
	'duplicateSectionRecordWithVerdict(': 'n/a',
};

/** The security reaction the post-write hook must reach (security/revocation.ts). */
const REACTION = 'src/core/security/revocation.ts#reactToRecordComponentWrite';
/** The hook's private step that fires it (record_write.ts). */
const REACT_TO_SECURITY_WRITE = 'src/core/section_record/record_write.ts#reactToSecurityWrite';

/** Built once, on first use: the writer closure (test/helpers/matrix_writer_closure.ts). */
let closureMemo: WriterClosure | undefined;
function writerClosure(): WriterClosure {
	closureMemo ??= buildWriterClosure();
	return closureMemo;
}

/** `file#name` of the module that EXPORTS a primitive (the write modules + relations/save.ts). */
function definitionKey(name: string): string | null {
	for (const module of [...WRITE_MODULES, 'src/core/relations/save.ts']) {
		const source = readFileSync(join(ROOT, module), 'utf8');
		if (new RegExp(`^export (?:async )?function ${name}\\(`, 'm').test(source)) {
			return `${module}#${name}`;
		}
	}
	return null;
}

/** Any of these in a file's source means it reaches the seam explicitly. */
const SEAM_SYMBOLS = [
	'revokeDeletedAccountAccess',
	'reactToRecordComponentWrite',
	'scheduleAccountTransitionRevocation',
	'invalidatePermissionsForWrite',
	'invalidateSecurityCachesForSection',
];

/** Doors that call a CALLER-owned primitive but can never address a dd128 record. */
const REACH_EXEMPT: Record<string, string> = {
	'src/core/relations/dataframe.ts':
		'its only caller-owned delete is applyDataframeDeletePolicy’s `delete_target` policy, which empties (never removes) the dataframe FRAME TARGET records a dd490 pairing addresses (an ontology-declared frame section, never the users section), after asking the write grant on that section — the slot-policy applier every delete door calls (removeDataframeDataById in relations/save.ts, the direct frame remove in save_component.ts, both record-delete modes in delete_record.ts).',
	'src/core/section/record/delete_record.ts':
		'the delete ENGINE — it DEFINES both primitives, holds no principal and no component tipo, and its own docblock puts authorization on the caller. Putting the seam here would revoke on an ontology delete too.',
	'src/core/ontology/engine_ontology.ts':
		'its only caller-owned delete is pruneRetired: deleteSectionRecord on the HARD-BOUND engine main section MAIN_SECTION_TIPO (ddengine0, never the users section), removing the source record of a node the shipped engine_ontology.json lists as `retired` — assertRetiredNode checks the tipo is an engine-owned, non-main, no-longer-declared ddengine tipo before any write.',
	'src/core/test_data/synthetic_hierarchy_fixture.ts':
		'a repo-owned test fixture builder that deletes its own scratch hierarchy records under the test-database marker guard; it names no users section.',
	'tools/tool_hierarchy/server/tool_hierarchy.ts':
		'hierarchy provisioning behind permission:’section’ — it deletes hierarchy section records, never a dd128 one.',
	'tools/tool_numisdata_acquisition/server/index.ts':
		'its only caller-owned delete is removeCreatedImageRecords: deleteSectionRecord on the HARD-BOUND IMAGE_SECTION_TIPO image section (IMAGE_SECTION_TIPO, never the users section), the all-or-nothing cleanup of a failed coin-face pair. The ids come ONLY from the created_section_id of this same importImagePair call’s own portal add_new_element saves — never the payload, never a lookup — and IMAGE_SECTION_TIPO is a declared commit_lots target (section level 2).',
};

/**
 * Doors that CAN delete or unlink a dd128 credential and do NOT reach the seam. Each row
 * names the finding; the list is SHRINK-ONLY and a door that starts reaching FAILS this
 * gate, so a fix cannot land silently.
 */
const REACH_PENDING: Record<string, string> = {};

/** PINNED. Shrink-only. */
const REACH_PENDING_COUNT = 0;

describe('every record-write door REACHES the revocation seam', () => {
	const callerOwned = Object.entries(PRIMITIVE_REACH)
		.filter(([, kind]) => kind === 'caller')
		.map(([primitive]) => primitive);

	test('the primitive list is DERIVED, not enumerated — a new writer cannot slip past', () => {
		// The one hand-typed link under a describe() that says TOTAL. Every export of a
		// record-write module is either a primitive or a declared non-writer; anything
		// else fails here, with the module and the name.
		const unclassified: string[] = [];
		for (const module of WRITE_MODULES) {
			const source = readFileSync(join(ROOT, module), 'utf8');
			for (const match of source.matchAll(/^export (?:async )?function ([A-Za-z0-9_]+)/gm)) {
				const name = match[1];
				if (name === undefined) continue;
				if (WRITE_PRIMITIVES.includes(`${name}(`)) continue;
				if (NON_PRIMITIVE_EXPORTS[name] !== undefined) continue;
				unclassified.push(`${module}: ${name}`);
			}
		}
		expect(
			unclassified,
			`Export(s) of a record-write module classified as neither a write primitive nor a non-writer:\n  ${unclassified.join('\n  ')}\nAdd it to WRITE_PRIMITIVES (and give it a PRIMITIVE_REACH verdict), or to NON_PRIMITIVE_EXPORTS with a reason.`,
		).toEqual([]);
	});

	test('every declared non-writer is still an export of a write module', () => {
		// Shrink the other way too: a stale exemption is a hole that reads as coverage.
		const exported = new Set<string>();
		for (const module of WRITE_MODULES) {
			const source = readFileSync(join(ROOT, module), 'utf8');
			for (const match of source.matchAll(/^export (?:async )?function ([A-Za-z0-9_]+)/gm)) {
				if (match[1] !== undefined) exported.add(match[1]);
			}
		}
		for (const [name, reason] of Object.entries(NON_PRIMITIVE_EXPORTS)) {
			expect(exported.has(name), `${name} is no longer exported by a write module`).toBe(true);
			expect(reason.length, `${name}: the reason is too short to be a reason`).toBeGreaterThan(30);
		}
	});

	test('the primitive table covers every primitive the census derives from', () => {
		// Without this, adding a primitive to WRITE_PRIMITIVES would widen the door set
		// and silently leave the new class unclassified for the reach.
		expect(Object.keys(PRIMITIVE_REACH).sort()).toEqual([...WRITE_PRIMITIVES].sort());
	});

	test('the CHOKEPOINT really fires the reaction (or every "chokepoint" verdict is a lie)', () => {
		// MEASURED ON THE CALL GRAPH (the writer closure's RESOLVED references), never on
		// a body's spelling: a chokepoint that delegates to a shared key-write body still
		// reaches the hook, and one that stops reaching it is red however its body reads.
		// (The body-regex version of this test went red on a pure delegation refactor and
		// would have stayed green on a hook moved behind an unresolvable indirection.)
		const closure = writerClosure();
		// 1. The hook fires the security reaction.
		expect(
			closure.reachesPrecisely(AFTER_RECORD_WRITE, REACTION),
			'afterRecordWrite does not reach the security reaction',
		).toBe(true);
		// 2. Every primitive whose verdict is 'chokepoint', and the stamp-only writer,
		//    reaches the hook — the verdict is true of the code, or it is a lie.
		const chokepoints = Object.entries(PRIMITIVE_REACH)
			.filter(([, kind]) => kind === 'chokepoint')
			.map(([primitive]) => primitive.slice(0, -1));
		expect(chokepoints.length).toBeGreaterThan(4);
		for (const name of [...chokepoints, 'persistModifiedStamp']) {
			const key = definitionKey(name);
			expect(
				key,
				`${name}: no module under scan exports it — the verdict names nothing`,
			).not.toBeNull();
			expect(
				closure.reachesPrecisely(key as string, AFTER_RECORD_WRITE),
				`${key} does not reach afterRecordWrite — its 'chokepoint' verdict is a lie`,
			).toBe(true);
		}
		// 3. The reaction is fired from the hook ALONE — a second direct caller would be
		//    a door remembering again.
		const direct = [...closure.bodies.keys()].filter((key) =>
			closure.preciseEdgesOf(key).has(REACT_TO_SECURITY_WRITE),
		);
		expect(direct).toEqual([AFTER_RECORD_WRITE]);
		// 4. deletePortalLocator's chokepoint verdict: nothing it writes reaches the
		//    matrix past a chokepoint, except a sanctioned DERIVED writer (the dataframe
		//    slot strip) — however many wrappers deep.
		const cut = new Set([
			...Object.keys(RECORD_WRITE_CHOKEPOINTS),
			...Object.keys(SANCTIONED_DERIVED_WRITERS),
		]);
		expect(closure.bypassPath('src/core/relations/save.ts#deletePortalLocator', cut)).toBeNull();
	});

	test('the revocation is on the COMMIT-ONLY lane, and the cache clear is not', () => {
		const seam = readFileSync(join(ROOT, 'src/core/security/revocation.ts'), 'utf8');
		// A revocation is destructive and non-idempotent; deferPostTransaction replays on
		// ROLLBACK by contract. The lane is asserted behaviourally in
		// account_revocation_native.test.ts; this is the structural ratchet beside it.
		expect(seam).toMatch(/registerCommitAction\(revoke\)/);
		expect(seam).toMatch(/deferPostTransaction\(clearCaches\)/);
		// And the door that queues on the DEFERRED lane must take the cache half only.
		const save = readFileSync(join(ROOT, 'src/core/section/record/save_component.ts'), 'utf8');
		expect(save).toContain('deferPostTransaction(invalidate)');
		expect(save).toContain('clearSecurityCachesForWrite(');
		expect(
			/const invalidate = \(\): void =>\s*invalidatePermissionsForWrite\(/.test(save),
			'save_component queues the FULL reaction on the rollback-replaying lane again',
		).toBe(false);
	});

	test('every caller-owned delete door reaches the seam, or carries a row', () => {
		const unreached: string[] = [];
		for (const file of derived) {
			const source = readFileSync(join(ROOT, file), 'utf8');
			if (!callerOwned.some((primitive) => source.includes(primitive))) continue;
			if (SEAM_SYMBOLS.some((symbol) => source.includes(symbol))) continue;
			if (REACH_EXEMPT[file] !== undefined) continue;
			if (REACH_PENDING[file] !== undefined) continue;
			unreached.push(file);
		}
		expect(
			unreached,
			`Record-DELETE door(s) that reach no revocation seam and carry no row:\n  ${unreached.join('\n  ')}\nDeleting a dd128 record must end that account's sessions and media markers (SEC-08): call revokeDeletedAccountAccess, or add a REACH_EXEMPT row saying why the door can never address dd128.`,
		).toEqual([]);
	});

	test('no REACH row names a file that is no longer a write door, or that now reaches', () => {
		const derivedSet = new Set(derived);
		for (const [file, reason] of Object.entries({ ...REACH_EXEMPT, ...REACH_PENDING })) {
			expect(derivedSet.has(file), `${file} is no longer a derived write door`).toBe(true);
			expect(reason.length, `${file}: the reason is too short to be a reason`).toBeGreaterThan(40);
		}
	});

	test('the REACH PENDING list is SHRINK-ONLY', () => {
		const pending = Object.keys(REACH_PENDING).length;
		expect(pending).toBeLessThanOrEqual(REACH_PENDING_COUNT);
		expect(
			pending,
			`REACH_PENDING shrank to ${pending} — lower REACH_PENDING_COUNT so the ratchet keeps biting.`,
		).toBe(REACH_PENDING_COUNT);
	});
});

// ---------------------------------------------------------------------------
// THE BEHAVIOURAL LEG (GATE-24, engineering/TRIPWIRES.md:72)
// ---------------------------------------------------------------------------
//
// "A GATE WHOSE ONLY ASSERTION IS A SOURCE SUBSTRING IS NOT A GATE FOR AN
// AUTHORIZATION DECISION." Everything above this line reads source text; it keeps the
// census honest, but it cannot tell you that the refusal WORKS. So this block builds the
// audit's precondition — a real principal whose profile grants level 2 on
// `(dd128, dd1725)`, the departmental user-manager role the downgrade exists to
// neutralise — and DRIVES the SEC-03 offender, `tool_propagate_component_data`, at that
// principal's OWN user record. Before P1-2 this exact call succeeded and the human save
// door refused the same write.
//
// Generic `test` TLD (AGENTS.md): the situation is BUILT here — a scratch dd234 profile
// and a scratch dd128 user, inserted through the counter-allocating writer and swept in
// afterAll. dd128/dd234/dd774/dd1725 are seed-shipped and have no `test` twin.

import { afterAll, beforeAll } from 'bun:test';
import {
	deleteMatrixRecord,
	insertMatrixRecordWithCounter,
} from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import {
	clearPermissionsCache,
	clearPrincipalCache,
	clearUserProjectsCache,
	type Principal,
	resolvePrincipal,
} from '../../src/core/security/permissions.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { tool as propagateTool } from '../../tools/tool_propagate_component_data/server/index.ts';

const CENSUS_TAG = `dd128census_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
/** dd800 — the bulk-process section the tool anchors every batch to. */
const BULK_PROCESS_SECTION = 'dd800';
const PROJECT_ID = 990001;

let managerId = 0;
let managerProfileId = 0;
let manager: Principal;

/** The dd1725 profile-select locator the propagate would write. */
function profileLocator(profileId: number) {
	return {
		id: 1,
		type: 'dd151',
		section_id: String(profileId),
		section_tipo: 'dd234',
		from_component_tipo: 'dd1725',
	};
}

beforeAll(async () => {
	// This gate writes users, profiles, a project and TM rows through the raw matrix
	// doors: ask the suite database's marker first (the 2026-10-02 dd128census_*
	// rows in an application database were this file, run with no preload).
	await assertTestDatabase('dd128_write_census_tripwire');
	// The grant the audit describes: level 2 on the users SECTION and on the PROFILE
	// component of it. Nothing else — no global-admin flag, no developer flag.
	managerProfileId = await insertMatrixRecordWithCounter('matrix_profiles', 'dd234', {
		misc: {
			dd774: [
				{ id: 1, tipo: 'dd128', section_tipo: 'dd128', value: 2 },
				{ id: 2, tipo: 'dd1725', section_tipo: 'dd128', value: 2 },
			],
		},
		relation: { dd1067: [] },
		data: { label: CENSUS_TAG, section_tipo: 'dd234' },
	});
	managerId = await insertMatrixRecordWithCounter('matrix_users', 'dd128', {
		relation: {
			dd1725: [profileLocator(managerProfileId)],
			dd170: [
				{
					id: 1,
					type: 'dd151',
					section_id: String(PROJECT_ID),
					section_tipo: 'dd153',
					from_component_tipo: 'dd170',
				},
			],
		},
		string: { dd132: [{ id: 1, lang: 'lg-nolan', value: CENSUS_TAG }] },
		data: { label: CENSUS_TAG, section_tipo: 'dd128', created_by_user_id: -1 },
	});
	clearPermissionsCache();
	clearPrincipalCache();
	clearUserProjectsCache();
	manager = await resolvePrincipal(managerId);
}, 60000);

afterAll(async () => {
	if (managerId !== 0) await deleteMatrixRecord('matrix_users', 'dd128', managerId);
	if (managerProfileId !== 0)
		await deleteMatrixRecord('matrix_profiles', 'dd234', managerProfileId);
	// The tool anchors every batch to a dd800 bulk-process record (its label rides in
	// the dd796 string, not in data.label). Sweep by the run tag through the ontology's
	// own table resolution — dd800 lives in matrix_notes, and hardcoding that here would
	// be a second copy of a mapping the ontology owns.
	{
		const { getMatrixTableFromTipo } = await import('../../src/core/ontology/resolver.ts');
		const table = await getMatrixTableFromTipo(BULK_PROCESS_SECTION);
		if (table !== null) {
			await sql.unsafe(
				`DELETE FROM "${table}" WHERE section_tipo = $1 AND string->'dd796' @> $2::text::jsonb`,
				[BULK_PROCESS_SECTION, JSON.stringify([{ value: CENSUS_TAG }])],
			);
		}
	}
	await sql.unsafe('DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2', [
		'dd128',
		managerId,
	]);
	clearPermissionsCache();
	clearPrincipalCache();
	clearUserProjectsCache();
});

describe('the refusal WORKS, not just the census (GATE-24 behavioural leg)', () => {
	test('the precondition is real: level 2 on (dd128, dd1725) and NOT a global admin', async () => {
		// Without this the refusal below could come from the tool's own up-front gate
		// rather than from the own-record rule, and the test would prove nothing.
		const { getPermissions } = await import('../../src/core/security/permissions.ts');
		expect(manager.isGlobalAdmin).toBe(false);
		expect(manager.isDeveloper).toBe(false);
		expect(await getPermissions(manager, 'dd128', 'dd1725')).toBe(2);
	});

	test('tool_propagate_component_data REFUSES a self-targeted dd1725 write', async () => {
		const handler = propagateTool.apiActions?.propagate_component_data?.handler;
		if (handler === undefined) throw new Error('propagate_component_data has no handler');

		const before = await readProfileLocators(managerId);

		const response = await handler({
			principal: manager,
			userId: managerId,
			background: false,
			requestId: CENSUS_TAG,
			options: {
				section_tipo: 'dd128',
				component_tipo: 'dd1725',
				action: 'replace',
				lang: 'lg-nolan',
				total: 1,
				bulk_process_label: CENSUS_TAG,
				// The caller's OWN record — the whole point of the finding.
				sqo: {
					section_tipo: ['dd128'],
					filter_by_locators: [{ section_tipo: 'dd128', section_id: managerId }],
				},
				// A profile they do not have: the escalation the downgrade prevents.
				propagate_data_value: [profileLocator(managerProfileId + 1)],
			},
		});

		// The batch never fails as a whole — a per-record refusal is payload. The SHAPE
		// that matters is: it saw the record, and it refused to write it.
		const data = (response as { data?: { errors?: string[]; records?: number } }).data;
		expect(data?.records, 'the SQO matched no record — the refusal would be vacuous').toBe(1);
		expect(data?.errors ?? []).toEqual([
			`section_id ${String(managerId)}: no write permission on dd128/dd1725`,
		]);
		// And the record is BYTE-UNCHANGED: nothing partial, nothing stamped.
		expect(await readProfileLocators(managerId)).toEqual(before);
	});

	test('the SAME call on someone ELSE’s record is not refused by the own-record rule', async () => {
		// The counterfactual. The own-record rule is a DOWNGRADE on the actor's own
		// record only; a refusal that applied everywhere would prove nothing about
		// SEC-03 and would break every legitimate user-manager role.
		const { getRecordComponentPermission, getPermissions } = await import(
			'../../src/core/security/permissions.ts'
		);
		expect(await getRecordComponentPermission(manager, 'dd128', 'dd1725', managerId)).toBe(1);
		expect(await getRecordComponentPermission(manager, 'dd128', 'dd1725', managerId + 7)).toBe(
			await getPermissions(manager, 'dd128', 'dd1725'),
		);
	});
});

/** The dd1725 locators stored on a user record, for the byte-unchanged assertion. */
async function readProfileLocators(userId: number): Promise<unknown> {
	const rows = (await sql.unsafe(
		"SELECT relation->'dd1725' AS locators FROM matrix_users WHERE section_tipo = $1 AND section_id = $2",
		['dd128', userId],
	)) as { locators: unknown }[];
	return rows[0]?.locators ?? null;
}
