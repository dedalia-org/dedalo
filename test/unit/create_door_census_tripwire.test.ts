/**
 * TRIPWIRE — EVERY CALLER OF A RECORD-CREATE PRIMITIVE IS CLASSIFIED (T0-2, the
 * create gate; WC-2026-11-10-add-new-element-create-gate).
 *
 * THE DEFECT CLASS. `add_new_element` created a record in a CALLER-NAMED target
 * section while the save door authorized only the HOST; the census that should
 * have seen it (dd128_write_census) classified FILES by the dd128 own-record rule,
 * so "a birth under the save door" read as coverage. The engine had two answers to
 * "may create in S" and one door used neither. There is now ONE predicate —
 * `authorizeRecordCreate` (src/core/security/write_door.ts: section ≥ 2 AND the
 * section's first button_new ≥ 2; no button_new refuses, the superuser included) —
 * and this gate makes every create site answer to it, or say in writing why not.
 *
 * TWO CREATE RULES, NOT ONE (owner decisions D4 / D3 REVISED 2026-11-10). The
 * New-button predicate is the rule for what a user does by pressing "New" / "+"
 * (portal / select / temporal / children add_new_element, add_child, duplicate,
 * MCP create / find_or_create / duplicate, agent plans). Core `create` and a
 * TOOL-driven add_new_element ask the SECTION level only —
 * `authorizeSectionCreate` (section ≥ 2, consultation-capped; PHP parity): the
 * feature-owned sections they serve (notes, references, dataframe frames,
 * presets, imported media) ship no button_new. Each door's row says WHICH rule,
 * and the outcome gate proves it — a section-level door is driven to CREATE
 * with the New button withheld, so a door that silently started asking the
 * button reds as surely as one that stopped asking anything.
 *
 * THE CENSUS IS TOTAL BY DERIVATION. The callers are DERIVED on every run from the
 * import-resolved call graph of the write-path corpus (test/helpers/
 * matrix_writer_closure.ts over write_path_corpus.ts: `src/`, `tools/`, `scripts/`)
 * — a caller is a top-level declaration (`file#name`) with a resolved reference to a
 * CREATE PRIMITIVE (CREATE_PRIMITIVES below: createSectionRecord, the two duplicate
 * primitives, and applyAddNewElement, the add_new_element gate site). Static,
 * aliased and dynamic imports all resolve; a string or comment naming the primitive
 * is no edge. A caller with no row is RED; a row whose caller vanished is RED.
 * Every row also pins the SECTION ARGUMENT of each call site, as source text — a
 * changed target expression re-opens the row for review.
 *
 * THE VERDICTS, and what is mechanically checked for each:
 *
 *   authorizes-create — CHECKED BY OUTCOME. The row names door ids of
 *                CREATE_DOOR_PROBES (test/helpers/create_door_probes.ts); the
 *                outcome gate add_new_element_create_gate_native drives every id with
 *                a create-ungranted persona and requires perm.denied + zero rows, and
 *                a granted CONTROL that creates one, and its last case requires the
 *                driven set to EQUAL the probe list. Here: every id a row names is a
 *                probe, every probe is claimed by a row, and the caller REACHES
 *                authorizeRecordCreate on the call graph with the create primitives
 *                cut (`gate: 'self'`), or calls applyAddNewElement — itself an
 *                `authorizes-create` gate site — without the `system` access mode
 *                (`gate: 'callee'`). A door cannot be marked authorizes-create
 *                without a probe, and a probe cannot be dropped without the row.
 *   authorizes-section-create — CHECKED BY OUTCOME, the mirror contrast. The row
 *                names SECTION_CREATE_DOOR_PROBES ids; the same outcome gate drives
 *                each REFUSED below section 2 and CREATED with the target's
 *                button_new WITHHELD (or absent), and requires that set driven in
 *                full; here the caller REACHES authorizeSectionCreate (`gate: 'self'`).
 *                The tool path of add_new_element has no caller row of its own (it
 *                runs inside applySaveComponentData): its doors are the callers of
 *                the access MINT `toolAddNewElementAccess`, censused in TOOL_MINTERS
 *                below — tool server code only, so no user door can select it.
 *   system     — no user-chosen target: bulk-process run records, ontology /
 *                hierarchy provisioning, the update transform, the AI spend ledger,
 *                user stats, the hierarchy invariant's root term. CHECKED: with
 *                `binding: 'module-constant'` the section argument's root identifier
 *                is bound at MODULE scope (a column-0 const/function or an import)
 *                and is not a parameter of the caller; with `binding: 'derived'` the
 *                reason must say what derives it. An applyAddNewElement call must pass
 *                the `system` access mode with a reason.
 *   tool-gated — a tool door authorized by its tool permission kind
 *                (src/core/tools/security.ts) and its own write-door asks, PROVEN by
 *                an existing native gate: each `evidence` entry names the gate file
 *                and a case title (or cell key) that must still be in it.
 *   engine     — a create primitive's own wrapper (no principal): itself a censused
 *                primitive, so its callers are rows here.
 *   pending    — cannot be honestly classified yet; each names the finding.
 *                SHRINK-ONLY (PENDING_COUNT), and each row states whether the caller
 *                reaches authorizeRecordCreate today — a change either way is red, so
 *                a fix cannot land silently.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	CREATE_DOOR_PROBE_GATE,
	CREATE_DOOR_PROBES,
	type CreateDoorId,
	SECTION_CREATE_DOOR_PROBES,
	type SectionCreateDoorId,
} from '../helpers/create_door_probes.ts';
import { buildWriterClosure, type WriterClosure } from '../helpers/matrix_writer_closure.ts';
import { REPO_ROOT } from '../helpers/write_path_corpus.ts';

const CREATE_RECORD = 'src/core/section/record/create_record.ts#createSectionRecord';
const DUPLICATE = 'src/core/section/record/duplicate_record.ts#duplicateSectionRecord';
const DUPLICATE_VERDICT =
	'src/core/section/record/duplicate_record.ts#duplicateSectionRecordWithVerdict';
const ADD_NEW_ELEMENT = 'src/core/relations/save.ts#applyAddNewElement';

/** The New-button predicate (graph key, not a source needle). */
const CREATE_PREDICATE = 'src/core/security/write_door.ts#authorizeRecordCreate';
/** The SECTION-level create (graph key). */
const SECTION_CREATE_PREDICATE = 'src/core/security/write_door.ts#authorizeSectionCreate';
/** The server-only mint of the TOOL add_new_element access (graph key). */
const TOOL_ACCESS_MINT = 'src/core/relations/save.ts#toolAddNewElementAccess';

/** Create primitive → the 0-based index of its TARGET SECTION argument. */
const CREATE_PRIMITIVES: Readonly<Record<string, number>> = {
	[CREATE_RECORD]: 0,
	[DUPLICATE]: 0,
	[DUPLICATE_VERDICT]: 0,
	[ADD_NEW_ELEMENT]: 1,
};

type Verdict =
	| 'authorizes-create'
	| 'authorizes-section-create'
	| 'system'
	| 'tool-gated'
	| 'engine'
	| 'pending';

interface Evidence {
	/** repo-relative native gate */
	file: string;
	/** a case title / cell key that must be present in it */
	contains: string;
}

interface CensusRow {
	verdict: Verdict;
	reason: string;
	/** The section argument of every call site of the primitive in the caller, sorted, unique. */
	sectionArgs: string[];
	/** authorizes-create: CREATE_DOOR_PROBES ids; authorizes-section-create: SECTION_CREATE_DOOR_PROBES ids. */
	probes?: (CreateDoorId | SectionCreateDoorId)[];
	/** authorizes-create / authorizes-section-create: where the rule is asked. */
	gate?: 'self' | 'callee';
	/** system / tool-gated: how the target section is fixed. */
	binding?: 'module-constant' | 'derived';
	/** tool-gated: the native gate(s) proving the refusal. */
	evidence?: Evidence[];
	/** pending: does the caller reach authorizeRecordCreate today? */
	reachesPredicate?: boolean;
}

const BULK_REASON =
	'mints the run’s own bulk-process record (dd800 via BULK_PROCESS_TIPOS / its module constant): the section is fixed by code, never named by the payload; the run’s DATA writes are separate doors censused on their own.';

/** Primitive → caller (`file#declaration`) → row. */
const CENSUS: Readonly<Record<string, Readonly<Record<string, CensusRow>>>> = {
	[CREATE_RECORD]: {
		// --- AUTHORIZES-CREATE ------------------------------------------------
		'src/core/api/handlers/dd_core_api.ts#coreApiActions': {
			verdict: 'authorizes-section-create',
			gate: 'self',
			probes: ['dd_core_api:create'],
			sectionArgs: ['grant.sectionTipo'],
			reason:
				'core `create`: authorizeSectionCreate(principal, section, {door: create}) — the consultation-capped SECTION level, PHP dd_core_api::create parity (D4 REVISED 2026-11-10: notes / references / dataframe frames / presets ship no button_new) — mints the grant whose sectionTipo is the create’s target.',
		},
		'src/ai/mcp/tools/records_write.ts#createRecord': {
			verdict: 'authorizes-create',
			gate: 'self',
			probes: ['mcp:create_record'],
			sectionArgs: ['grant.sectionTipo'],
			reason:
				'MCP dedalo_create_record: the module’s create-grant helper calls authorizeRecordCreate and the insert targets the grant’s section (D4).',
		},
		'src/ai/mcp/tools/fields_write.ts#findOrCreate': {
			verdict: 'authorizes-create',
			gate: 'self',
			probes: ['mcp:find_or_create'],
			sectionArgs: ['sectionTipo'],
			reason:
				'MCP dedalo_find_or_create: the create branch asks authorizeRecordCreate(principal, sectionTipo, {door: mcp.find_or_create}) before the insert (D4).',
		},
		'src/core/ts_object/ts_api.ts#addChild': {
			verdict: 'authorizes-create',
			gate: 'self',
			probes: ['dd_ts_api:add_child'],
			sectionArgs: ['sectionTipo'],
			reason:
				'thesaurus tree add_child: authorizeRecordCreate(principal, sectionTipo, {door: add_child}) before the child is minted (D4).',
		},
		[ADD_NEW_ELEMENT]: {
			verdict: 'authorizes-create',
			gate: 'self',
			probes: ['save:add_new_element', 'temporal:add_new_element', 'children:add_new_element'],
			sectionArgs: ['targetSectionTipo'],
			reason:
				'THE add_new_element gate site: in `create` access mode (every user door) authorizeRecordCreate on the caller-named TARGET, then the declared membership; in `tool` access mode (minted server-side only, TOOL_MINTERS) authorizeSectionCreate then target_sections — both before the host-filter read and the insert. Every request door reaches the create through here (its callers are rows below).',
		},

		// --- SYSTEM -------------------------------------------------------------
		'src/core/area_maintenance/user_stats.ts#saveUserActivity': {
			verdict: 'system',
			binding: 'module-constant',
			sectionArgs: ['UA_SECTION'],
			reason:
				'the user-activity stats writer: its own hard-bound stats section (UA_SECTION, dd1521) as userId -1, run by the maintenance aggregation — no user names the section.',
		},
		'src/core/install/hierarchy_activate.ts#createRegistryRow': {
			verdict: 'system',
			binding: 'module-constant',
			sectionArgs: ['HIERARCHY_SECTION'],
			reason:
				'hierarchy activation mints the hierarchy1 registry row of a TLD being activated (installer / ontology update path); the section is the module constant HIERARCHY_SECTION.',
		},
		'src/core/ontology/ontology_write.ts#mintRegistryRow': {
			verdict: 'system',
			binding: 'module-constant',
			sectionArgs: ['ONTOLOGY_MAIN_SECTION'],
			reason:
				'the dd_ontology write driver mints the ontology main-section registry row of a TLD it materializes; the section is the module constant ONTOLOGY_MAIN_SECTION.',
		},
		'src/core/ontology/ontology_write.ts#ensureMatrixRecord': {
			verdict: 'system',
			binding: 'derived',
			sectionArgs: ['sectionTipo'],
			reason:
				'the ontology write driver’s explicit-id ensure: the section is DERIVED by the driver from the ontology node being written (its parent node section / typology section, `<tld>0` sources), never from a request payload — an ontology structure write, not a record a user creates.',
		},
		'src/core/ontology/hierarchy_provision.ts#provisionVirtualSections': {
			verdict: 'system',
			binding: 'derived',
			sectionArgs: ['nodeSectionTipo'],
			reason:
				'hierarchy provisioning mints the descriptor rows 1 and 2 of the new TLD’s ontology node section, DERIVED as `${tld2}0` from the TLD being provisioned — a structural record, gated where provisioning is invoked (tool_hierarchy permission:section).',
		},
		'src/core/security/ai_spend.ts#lockDay': {
			verdict: 'system',
			binding: 'derived',
			sectionArgs: ['ledger.section'],
			reason:
				'the AI spend ledger day row, DERIVED from the ledger descriptor: `ledger` is AI_SPEND_LEDGER (the master-defined dd660 ledger), overridable only by a scratch-only seam (assertScratchOnly); the caller supplies a principal and amounts, never a section.',
		},
		'src/core/update/transform/portalize.ts#applyPortalizeRow': {
			verdict: 'system',
			binding: 'derived',
			sectionArgs: ['item.target_section'],
			reason:
				'a code-update data transform run by the updater as userId -1: the target section is DERIVED from the release’s portalize transform definition (repo-owned update catalog), never from a request.',
		},
		'src/core/tools/import_execute.ts#createBulkProcessRecord': {
			verdict: 'system',
			binding: 'module-constant',
			sectionArgs: ['BULK_PROCESS_TIPOS.section'],
			reason: BULK_REASON,
		},
		'tools/tool_import_dedalo_csv/server/index.ts#createBulkProcessRecord': {
			verdict: 'system',
			binding: 'module-constant',
			sectionArgs: ['BULK_PROCESS_TIPOS.section'],
			reason: BULK_REASON,
		},
		'tools/tool_propagate_component_data/server/index.ts#createBulkProcess': {
			verdict: 'system',
			binding: 'module-constant',
			sectionArgs: ['BULK_PROCESS_TIPOS.section'],
			reason: BULK_REASON,
		},
		'tools/tool_update_cache/server/index.ts#updateCache': {
			verdict: 'system',
			binding: 'module-constant',
			sectionArgs: ['BULK_PROCESS_TIPOS.section'],
			reason: BULK_REASON,
		},
		'tools/tool_time_machine/server/bulk_revert.ts#createRevertBulkProcess': {
			verdict: 'system',
			binding: 'module-constant',
			sectionArgs: ['BULK_PROCESS_SECTION_TIPO'],
			reason: BULK_REASON,
		},
		'scripts/tool_viewport_check.ts#buildRecord': {
			verdict: 'system',
			binding: 'derived',
			sectionArgs: ['sectionTipo'],
			reason:
				'a test-harness CLI (bun run test:tools:phone): the section is DERIVED from a probed tool’s caller fixture; it refuses before any write unless the database carries the dedalo_test_marker (assertTestDatabase) and sweeps what it creates — no server door, no request.',
		},

		// --- TOOL-GATED ---------------------------------------------------------
		'src/core/tools/import_execute.ts#recordIdFor': {
			verdict: 'tool-gated',
			binding: 'derived',
			sectionArgs: ['sectionTipo'],
			evidence: [
				{
					file: 'test/unit/import_create_door_native.test.ts',
					contains:
						'MAPPED, NEW record, section READ-only (LEVEL_1): refused — nothing created, no row left',
				},
			],
			reason:
				'the mapped importer’s NEW record, in a section DERIVED from the user’s import mapping: the import tool’s permission kind, then authorizeSectionTarget (section level 2) on the import’s target section before the create. NOTE: section ≥ 2 only — not the button_new half of the create predicate.',
		},
		'src/core/tools/import_csv_execute.ts#executeCsvImport': {
			verdict: 'tool-gated',
			binding: 'derived',
			sectionArgs: ['sectionTipo'],
			evidence: [
				{
					file: 'test/unit/import_create_door_native.test.ts',
					contains:
						'CSV, NEW row, section READ-only (LEVEL_1): refused — the row rolled back, no record at its id',
				},
			],
			reason:
				'the CSV importer’s row create (tool_import_dedalo_csv, section_list kind) in the section DERIVED from the user’s CSV: authorizeSectionTarget (section level 2) on the row’s section before the explicit-id create. NOTE: section ≥ 2 only — not the button_new half of the create predicate.',
		},
		'tools/tool_import_rdf/server/rdf_import_execute.ts#bornRecord': {
			verdict: 'tool-gated',
			binding: 'derived',
			sectionArgs: ['sectionTipo'],
			evidence: [
				{
					file: 'test/unit/rdf_import_execute_native.test.ts',
					contains:
						'REFUSED: a read-only importer writes nothing and creates nothing; the served twin writes',
				},
			],
			reason:
				'the RDF executor’s term create, in a section DERIVED from the ontology-driven RDF plan: the importing principal is asked authorizeSectionTarget (the section, then the match component pair) before the birth; a refusal skips the op. NOTE: section ≥ 2 only — not the button_new half of the create predicate.',
		},
		'tools/tool_numisdata_acquisition/server/index.ts#commitOneLot': {
			verdict: 'tool-gated',
			binding: 'module-constant',
			sectionArgs: ['T().object'],
			evidence: [
				{
					file: 'test/unit/authz_door_matrix_native.test.ts',
					contains: '[`tool:${ACQ_NUMISDATA}:commit_lots`]',
				},
				{
					file: 'test/unit/numisdata_acquisition_seam_scope_native.test.ts',
					contains:
						'S1 a seam naming dd128 (or any non-shipped, non-zz tipo) is refused before the work runs',
				},
			],
			reason:
				'commit_lots, `targets` kind: the lot section is T().object — the tool’s fixed acquisition target (the test seam may rebind it only to the shipped tipo or a zz scratch tipo); every declared target is authorized at level 2 before the handler runs.',
		},
		'tools/tool_numisdata_acquisition/server/index.ts#findOrCreateAuction': {
			verdict: 'tool-gated',
			binding: 'module-constant',
			sectionArgs: ['T().auctionSection'],
			evidence: [
				{
					file: 'test/unit/authz_door_matrix_native.test.ts',
					contains: '[`tool:${ACQ_NUMISDATA}:commit_lots`]',
				},
			],
			reason:
				'commit_lots’ Auction authority: T().auctionSection, a fixed declared target of the `targets` kind (level 2), never named by the payload.',
		},
		'tools/tool_numisdata_acquisition/server/index.ts#resolveCompanyEntityId': {
			verdict: 'tool-gated',
			binding: 'module-constant',
			sectionArgs: ['T().entitySection'],
			evidence: [
				{
					file: 'test/unit/authz_door_matrix_native.test.ts',
					contains: '[`tool:${ACQ_NUMISDATA}:commit_lots`]',
				},
			],
			reason:
				'commit_lots’ Entity authority: T().entitySection, a fixed declared target of the `targets` kind (level 2), never named by the payload.',
		},
		'tools/tool_bibliography_acquisition/server/index.ts#commitOnePublication': {
			verdict: 'tool-gated',
			binding: 'module-constant',
			sectionArgs: ['PUBLICATION_TIPO'],
			evidence: [
				{
					file: 'test/unit/authz_door_matrix_native.test.ts',
					contains: '[`tool:${ACQ_BIBLIOGRAPHY}:commit_publications`]',
				},
			],
			reason:
				'commit_publications, `targets` kind: the publication section is the module constant PUBLICATION_TIPO, a declared target authorized at level 2 before the handler runs.',
		},
		'tools/tool_bibliography_acquisition/server/index.ts#findOrCreatePerson': {
			verdict: 'tool-gated',
			binding: 'module-constant',
			sectionArgs: ['PEOPLE_SECTION_TIPO'],
			evidence: [
				{
					file: 'test/unit/authz_door_matrix_native.test.ts',
					contains: '[`tool:${ACQ_BIBLIOGRAPHY}:commit_publications`]',
				},
			],
			reason:
				'commit_publications’ People authority: the module constant PEOPLE_SECTION_TIPO, a declared target of the `targets` kind (level 2).',
		},
		'tools/tool_bibliography_acquisition/server/index.ts#findOrCreateSeries': {
			verdict: 'tool-gated',
			binding: 'module-constant',
			sectionArgs: ['SERIES_SECTION_TIPO'],
			evidence: [
				{
					file: 'test/unit/authz_door_matrix_native.test.ts',
					contains: '[`tool:${ACQ_BIBLIOGRAPHY}:commit_publications`]',
				},
			],
			reason:
				'commit_publications’ Series authority: the module constant SERIES_SECTION_TIPO, a declared target of the `targets` kind (level 2).',
		},

		// --- PENDING ------------------------------------------------------------
		'src/core/section/record/save_component.ts#applySaveComponentData': {
			verdict: 'pending',
			reachesPredicate: false,
			sectionArgs: ['sectionTipo'],
			reason:
				'the save-to-missing-row UPSERT: a save addressed to a record id that does not exist creates it at the caller-chosen id, authorized only by the HOST component level (≥ 2) — no create predicate on the section. T0-2 plan §7 neighbour, out of this item.',
		},
		'tools/tool_import_files/server/index.ts#importFiles': {
			verdict: 'pending',
			reachesPredicate: false,
			sectionArgs: ['sectionTipo'],
			reason:
				'import_files creates one record per file (enumerate / named / plain) in the run’s target section: the `targets` extractor authorizes the caller and ddo_map PAIRS and a born record’s components ask authorizeSectionTarget — SECTION level, the intended rule for an import (D3 REVISED 2026-11-10) — but no outcome gate drives THIS create with an ungranted persona (authz_door_matrix lists tool_import_files:import_files UNPROBED). Its portal add_new_element is a separate, probed door (TOOL_MINTERS).',
		},
	},
	[ADD_NEW_ELEMENT]: {
		'src/core/section/record/save_component.ts#applySaveComponentData': {
			verdict: 'authorizes-create',
			gate: 'callee',
			probes: ['save:add_new_element'],
			sectionArgs: ["String(change.value ?? '')"],
			reason:
				'the human save door’s add_new_element (portal / select / any relation model): `create` access mode with target_sections membership, the gate is applyAddNewElement’s. A tool saving through saveComponentData passes its server-minted `toolCreateAccess` instead (SECTION level — TOOL_MINTERS); the wire cannot (dd_core_api save builds the request field by field, and the access carries a symbol brand).',
		},
		'src/core/section/record/temporal.ts#resolveTemporalSave': {
			verdict: 'authorizes-create',
			gate: 'callee',
			probes: ['temporal:add_new_element'],
			sectionArgs: ['targetSectionTipo'],
			reason:
				'the temporal save door: `create` access mode with target_sections membership (its consultation-only 400 is asked first); the gate is applyAddNewElement’s.',
		},
		'src/core/relations/children_write.ts#createChildRecord': {
			verdict: 'authorizes-create',
			gate: 'callee',
			probes: ['children:add_new_element'],
			sectionArgs: ['targetSectionTipo'],
			reason:
				'the component_relation_children write-through: `create` access mode with the STRUCTURAL membership (assertChildSection already proved the child section); the gate is applyAddNewElement’s.',
		},
		'src/core/ontology/hierarchy_state.ts#mintProvisionedRootTerm': {
			verdict: 'system',
			binding: 'derived',
			sectionArgs: ['targetSectionTipo'],
			reason:
				'the hierarchy invariant (hierarchy_state is its single writer) mints the root term its tree hangs on ONLY when the target is the hierarchy’s OWN provisioned section — DERIVED by isOwnProvisionedSection, which checks exactly: `<tld>1`/`<tld>2` of the row’s TLD (hierarchy6), a dd_ontology `section` node, getSectionRealTipo(target) ≠ target AND = the declared source (hierarchy109, unset = hierarchy20), and no OTHER hierarchy1 record declares the same hierarchy6 (uniqueness scan — no editor-proof ownership fact exists) — a structural record no user chose; `system` access mode with a written reason (F2).',
		},
		'src/core/ontology/hierarchy_state.ts#mintDeclaredRootTerm': {
			verdict: 'authorizes-create',
			gate: 'callee',
			probes: ['hierarchy:declared_root_term'],
			sectionArgs: ['targetSectionTipo'],
			reason:
				'an operator-DECLARED root-term section that is not the hierarchy’s own (hierarchy53/58 are editable literals, so steerable — F2): `create` access mode as the ACTING principal (installer = superuser, tool = its caller), the declared pairing as the structural membership; the gate is applyAddNewElement’s.',
		},
	},
	[DUPLICATE]: {
		'src/core/api/handlers/dd_core_api.ts#coreApiActions': {
			verdict: 'authorizes-create',
			gate: 'self',
			probes: ['dd_core_api:duplicate'],
			sectionArgs: ['sectionTipo'],
			reason:
				'core `duplicate`: the source record is authorized (authorizeSectionRecord) and the NEW record’s section is asked authorizeRecordCreate({door: duplicate}) before the copy (D4).',
		},
		'src/ai/mcp/tools/fields_write.ts#duplicateRecord': {
			verdict: 'authorizes-create',
			gate: 'self',
			probes: ['mcp:duplicate_record'],
			sectionArgs: ['grant.sectionTipo'],
			reason:
				'MCP dedalo_duplicate_record: the source record is authorized (authorizeSectionRecordWrite) and the NEW record’s section is asked authorizeRecordCreate({door: mcp.duplicate}) before the copy (D4).',
		},
		'src/core/section/record/duplicate_record.ts#remintDataframeTargets': {
			verdict: 'pending',
			reachesPredicate: false,
			sectionArgs: ['target.sectionTipo'],
			reason:
				'the duplicate’s dataframe frame-target RE-MINT creates a record in each frame target section (DATA-05): assertFrameTargetDuplicable asks the consultation-capped SECTION level (getSectionPermissions ≥ 2) — the INTENDED rule (D4 REVISED: frame target sections are feature-owned, e.g. the Annotation frame section ships no button_new). Its refusal is gated (duplicate_record_dataframe_native: level 1 on the frame section refused), but no case drives a re-mint into a NO-button frame section by a non-superuser, so the section-level outcome is not proven — and it does not ask authorizeSectionCreate. Stays pending until both hold.',
		},
		[DUPLICATE_VERDICT]: {
			verdict: 'engine',
			sectionArgs: ['sectionTipo'],
			reason:
				'the duplicate primitive’s verdict-returning twin — no principal; it is itself a censused CREATE_PRIMITIVE, so whoever calls it is a row here.',
		},
	},
	[DUPLICATE_VERDICT]: {},
};

/** PINNED. Shrink-only. */
const PENDING_COUNT = 3;

/**
 * THE TOOL-ACCESS MINTERS — every caller of `toolAddNewElementAccess` (derived),
 * i.e. every door whose add_new_element asks the SECTION-level create. Each must be
 * TOOL SERVER code (`tools/<tool>/server/`): a user door (dd_core_api, temporal,
 * children, the MCP) minting it would let a request skip the New button — red.
 * Each names the section-level probe the outcome gate drives (the tool branch of
 * applyAddNewElement is one engine path; the probe drives it through
 * saveComponentData exactly as these callers do).
 */
const TOOL_MINTERS: Readonly<Record<string, { probes: SectionCreateDoorId[]; reason: string }>> = {
	'tools/tool_import_files/server/index.ts#importFiles': {
		probes: ['tool:add_new_element'],
		reason:
			'import_files links each imported file’s media record through the target portal (named / enumerate modes): toolCreateAccess(ctx.principal, tool_import_files).',
	},
	'tools/tool_posterframe/server/index.ts#createIdentifyingImage': {
		probes: ['tool:add_new_element'],
		reason:
			'posterframe’s identifying image: a new image record through the host portal, its image pair already authorized at write; toolCreateAccess(ctx.principal, tool_posterframe).',
	},
	'tools/tool_numisdata_acquisition/server/index.ts#importImagePair': {
		probes: ['tool:add_new_element'],
		reason:
			'acquisition lot image faces: a new image record per face through the lot’s portal; toolCreateAccess(context.principal, tool_numisdata_acquisition).',
	},
};

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/** Every unit with a reference to `primitive` (the primitive itself excluded). */
function deriveCallers(closure: WriterClosure, primitive: string): string[] {
	const callers: string[] = [];
	for (const key of closure.bodies.keys()) {
		if (key === primitive) continue;
		if (closure.edgesOf(key).has(primitive)) callers.push(key);
	}
	return callers.sort();
}

/** The argument list of every `name(` call in `body` (string-aware paren matching). */
function callArguments(body: string, name: string): string[][] {
	const calls: string[][] = [];
	const pattern = new RegExp(`(?<![\\w.$])${name}\\s*\\(`, 'g');
	for (const match of body.matchAll(pattern)) {
		// a declaration (`function name(`) is not a call
		if (/function\s*\*?\s*$/.test(body.slice(0, match.index))) continue;
		const args: string[] = [];
		let depth = 0;
		let current = '';
		let quote: string | null = null;
		for (let i = (match.index ?? 0) + match[0].length; i < body.length; i++) {
			const ch = body[i] as string;
			if (quote !== null) {
				current += ch;
				if (ch === '\\') {
					current += body[i + 1] ?? '';
					i++;
				} else if (ch === quote) quote = null;
				continue;
			}
			if (ch === "'" || ch === '"' || ch === '`') {
				quote = ch;
				current += ch;
				continue;
			}
			if (ch === '(' || ch === '[' || ch === '{') depth++;
			if (ch === ')' || ch === ']' || ch === '}') {
				if (depth === 0) {
					args.push(current);
					break;
				}
				depth--;
			}
			if (ch === ',' && depth === 0) {
				args.push(current);
				current = '';
				continue;
			}
			current += ch;
		}
		calls.push(args.map((arg) => arg.replace(/\s+/g, ' ').trim()).filter((arg) => arg !== ''));
	}
	return calls;
}

/** The section argument of every call of the primitive inside the caller unit. */
function sectionArgsOf(closure: WriterClosure, caller: string, primitive: string): string[] {
	const body = closure.bodies.get(caller) ?? '';
	const name = primitive.split('#')[1] as string;
	const index = CREATE_PRIMITIVES[primitive] as number;
	return [...new Set(callArguments(body, name).map((args) => args[index] ?? '<missing>'))].sort();
}

/** BFS over RESOLVED edges only, never entering a unit of `cut`. */
function reachesAvoiding(
	closure: WriterClosure,
	from: string,
	to: string,
	cut: ReadonlySet<string>,
): boolean {
	const seen = new Set([from]);
	const queue = [from];
	while (queue.length > 0) {
		const key = queue.shift() as string;
		for (const next of closure.preciseEdgesOf(key)) {
			if (next === to) return true;
			if (cut.has(next) || seen.has(next)) continue;
			seen.add(next);
			queue.push(next);
		}
	}
	return false;
}

/** Does the caller ask `rule` itself (the create primitives are cut)? */
function asksRule(closure: WriterClosure, caller: string, rule: string): boolean {
	const cut = new Set(Object.keys(CREATE_PRIMITIVES).filter((key) => key !== caller));
	return reachesAvoiding(closure, caller, rule, cut);
}

/** Does the caller ask the New-button predicate itself (the create primitives are cut)? */
function asksCreatePredicate(closure: WriterClosure, caller: string): boolean {
	return asksRule(closure, caller, CREATE_PREDICATE);
}

/** Every caller of the tool-access mint. */
function deriveToolMinters(source: WriterClosure): string[] {
	return deriveCallers(source, TOOL_ACCESS_MINT);
}

/** Is `identifier` bound at MODULE scope of `file` (column-0 declaration or an import)? */
function isModuleBound(file: string, identifier: string): boolean {
	const source = readFileSync(join(REPO_ROOT, file), 'utf8');
	const declared = new RegExp(
		`^(?:export )?(?:(?:const|let|var) ${identifier}\\b|(?:async )?function ${identifier}\\()`,
		'm',
	);
	if (declared.test(source)) return true;
	// a destructure of a module's EXPORT through a dynamic import (`const { X } = await
	// import('…')`) binds the export itself — code-fixed, wherever the statement sits
	const dynamic = new RegExp(`const \\{[^}]*\\b${identifier}\\b[^}]*\\}\\s*=\\s*await import\\(`);
	if (dynamic.test(source)) return true;
	for (const match of source.matchAll(/^import\s+(?:type\s+)?\{([^}]*)\}\s*from/gm)) {
		const names = (match[1] ?? '').split(',').map((part) =>
			part
				.trim()
				.split(/\s+as\s+/)
				.pop()
				?.trim(),
		);
		if (names.includes(identifier)) return true;
	}
	return false;
}

/** The caller unit's parameter list text (first balanced `(…)` of the declaration). */
function parameterText(closure: WriterClosure, caller: string): string {
	const body = closure.bodies.get(caller) ?? '';
	const open = body.indexOf('(');
	if (open < 0) return '';
	let depth = 0;
	for (let i = open; i < body.length; i++) {
		if (body[i] === '(') depth++;
		if (body[i] === ')' && --depth === 0) return body.slice(open + 1, i);
	}
	return '';
}

/** Every unclassified derived caller, as `primitive <- caller`. */
function unclassified(closure: WriterClosure): string[] {
	const out: string[] = [];
	for (const primitive of Object.keys(CREATE_PRIMITIVES)) {
		const rows = CENSUS[primitive] ?? {};
		for (const caller of deriveCallers(closure, primitive)) {
			if (rows[caller] === undefined) out.push(`${primitive} <- ${caller}`);
		}
	}
	return out;
}

const closure = buildWriterClosure();
const allRows = Object.entries(CENSUS).flatMap(([primitive, rows]) =>
	Object.entries(rows).map(([caller, row]) => ({ primitive, caller, row })),
);

// ---------------------------------------------------------------------------
// Totality
// ---------------------------------------------------------------------------

describe('the create-door census is TOTAL', () => {
	test('the derivation found callers (the scan is not silently empty)', () => {
		const derived = Object.keys(CREATE_PRIMITIVES).flatMap((primitive) =>
			deriveCallers(closure, primitive),
		);
		expect(derived.length).toBeGreaterThan(25);
		expect(deriveCallers(closure, CREATE_RECORD)).toContain(
			'src/core/api/handlers/dd_core_api.ts#coreApiActions',
		);
		expect(deriveCallers(closure, ADD_NEW_ELEMENT)).toContain(
			'src/core/section/record/temporal.ts#resolveTemporalSave',
		);
	});

	test('every create primitive is a real declaration of the corpus, and has a CENSUS table', () => {
		expect(Object.keys(CENSUS).sort()).toEqual(Object.keys(CREATE_PRIMITIVES).sort());
		for (const primitive of Object.keys(CREATE_PRIMITIVES)) {
			expect(closure.bodies.has(primitive), `${primitive} is not a declaration`).toBe(true);
		}
		expect(closure.bodies.has(CREATE_PREDICATE), `${CREATE_PREDICATE} is gone`).toBe(true);
	});

	test('every derived caller has a census row', () => {
		const missing = unclassified(closure);
		expect(
			missing,
			`New create-primitive caller(s) with no census row:\n  ${missing.join('\n  ')}\nClassify it in CENSUS: authorizes-create (ask authorizeRecordCreate AND add a CREATE_DOOR_PROBES probe driven by add_new_element_create_gate_native), system, tool-gated (with the native gate that proves the refusal), or pending (shrink-only).`,
		).toEqual([]);
	});

	test('no census row names a caller that no longer calls the primitive (stale rows)', () => {
		const stale = allRows
			.filter(({ primitive, caller }) => !deriveCallers(closure, primitive).includes(caller))
			.map(({ primitive, caller }) => `${primitive} <- ${caller}`);
		expect(stale).toEqual([]);
	});

	test('every row pins the section argument of its call sites (a changed target expression re-opens it)', () => {
		const drift: string[] = [];
		for (const { primitive, caller, row } of allRows) {
			const actual = sectionArgsOf(closure, caller, primitive);
			// FLOOR per row: an edge the extractor cannot read as a call is not silently passed.
			if (actual.length === 0) drift.push(`${caller}: no call of ${primitive} parsed`);
			else if (JSON.stringify(actual) !== JSON.stringify([...row.sectionArgs].sort())) {
				drift.push(`${caller} -> ${primitive}: ${JSON.stringify(actual)}`);
			}
		}
		expect(drift).toEqual([]);
	});

	test('every row carries a real reason', () => {
		for (const { caller, row } of allRows) {
			expect(row.reason.length, `${caller}: the reason is too short`).toBeGreaterThan(60);
		}
	});
});

// ---------------------------------------------------------------------------
// The verdicts are true of the source and of the outcome gate
// ---------------------------------------------------------------------------

describe('authorizes-create is CHECKED BY OUTCOME', () => {
	const authorizing = allRows.filter(({ row }) => row.verdict === 'authorizes-create');

	test('every authorizes-create row names probes, and every probe id is a CREATE_DOOR_PROBES door', () => {
		expect(authorizing.length).toBeGreaterThan(5);
		for (const { caller, row } of authorizing) {
			expect(
				(row.probes ?? []).length,
				`${caller}: authorizes-create with no probe`,
			).toBeGreaterThan(0);
			for (const probe of row.probes ?? []) {
				expect(
					Object.hasOwn(CREATE_DOOR_PROBES, probe),
					`${caller}: probe '${probe}' is not in CREATE_DOOR_PROBES — no outcome gate drives it`,
				).toBe(true);
			}
		}
	});

	test('every probe door is claimed by an authorizes-create row (no orphan probe)', () => {
		const claimed = new Set(authorizing.flatMap(({ row }) => row.probes ?? []));
		expect(
			Object.keys(CREATE_DOOR_PROBES).filter((id) => !claimed.has(id as CreateDoorId)),
		).toEqual([]);
	});

	test('the outcome gate drives the probe list and requires it driven in full', () => {
		const path = join(REPO_ROOT, CREATE_DOOR_PROBE_GATE);
		expect(existsSync(path), `${CREATE_DOOR_PROBE_GATE} is gone`).toBe(true);
		const source = readFileSync(path, 'utf8');
		// The completeness case (createDoorDriveReport == expectedCreateDoorDrive) is the
		// outcome half; this is the link that it still exists and names every id.
		expect(source).toContain("from '../helpers/create_door_probes.ts'");
		expect(source).toContain('expect(createDoorDriveReport()).toEqual(expectedCreateDoorDrive())');
		for (const id of Object.keys(CREATE_DOOR_PROBES)) {
			expect(source.includes(`'${id}'`), `${CREATE_DOOR_PROBE_GATE} never marks '${id}'`).toBe(
				true,
			);
		}
	});

	test("gate 'self': the caller REACHES authorizeRecordCreate with the create primitives cut", () => {
		for (const { caller, row } of authorizing) {
			if (row.gate !== 'self') continue;
			expect(
				asksCreatePredicate(closure, caller),
				`${caller} is marked authorizes-create (gate self) but reaches no authorizeRecordCreate before the create`,
			).toBe(true);
		}
	});

	test("gate 'callee': the callee is the add_new_element gate site and the call is not system-mode", () => {
		const site = CENSUS[CREATE_RECORD]?.[ADD_NEW_ELEMENT];
		expect(site?.verdict).toBe('authorizes-create');
		expect(asksCreatePredicate(closure, ADD_NEW_ELEMENT)).toBe(true);
		for (const { primitive, caller, row } of authorizing) {
			if (row.gate !== 'callee') continue;
			expect(primitive, `${caller}: gate callee is only meaningful for applyAddNewElement`).toBe(
				ADD_NEW_ELEMENT,
			);
			const calls = callArguments(closure.bodies.get(caller) ?? '', 'applyAddNewElement');
			expect(calls.length).toBeGreaterThan(0);
			for (const args of calls) {
				expect(
					args.join(',').includes("mode: 'system'"),
					`${caller}: a request door calls applyAddNewElement in SYSTEM mode`,
				).toBe(false);
			}
		}
	});
});

describe('authorizes-section-create is CHECKED BY OUTCOME (the mirror contrast)', () => {
	const sectionRows = allRows.filter(({ row }) => row.verdict === 'authorizes-section-create');

	test('every section-create row names SECTION_CREATE_DOOR_PROBES ids only', () => {
		expect(sectionRows.length).toBeGreaterThan(0);
		for (const { caller, row } of sectionRows) {
			expect((row.probes ?? []).length, `${caller}: no probe`).toBeGreaterThan(0);
			for (const probe of row.probes ?? []) {
				expect(Object.hasOwn(SECTION_CREATE_DOOR_PROBES, probe), `${caller}: '${probe}'`).toBe(
					true,
				);
			}
		}
	});

	test('every section-level probe is claimed (by a row or a TOOL_MINTERS entry)', () => {
		const claimed = new Set([
			...sectionRows.flatMap(({ row }) => row.probes ?? []),
			...Object.values(TOOL_MINTERS).flatMap((entry) => entry.probes),
		]);
		expect(
			Object.keys(SECTION_CREATE_DOOR_PROBES).filter(
				(id) => !claimed.has(id as SectionCreateDoorId),
			),
		).toEqual([]);
	});

	test('the outcome gate drives the section-level probe list in full', () => {
		const source = readFileSync(join(REPO_ROOT, CREATE_DOOR_PROBE_GATE), 'utf8');
		expect(source).toContain(
			'expect(sectionCreateDoorDriveReport()).toEqual(expectedSectionCreateDoorDrive())',
		);
		for (const id of Object.keys(SECTION_CREATE_DOOR_PROBES)) {
			expect(
				source.includes(`markSectionCreateDoorDriven('${id}'`),
				`${CREATE_DOOR_PROBE_GATE} never marks '${id}'`,
			).toBe(true);
		}
	});

	test("gate 'self': the caller REACHES authorizeSectionCreate with the create primitives cut", () => {
		for (const { caller, row } of sectionRows) {
			expect(row.gate).toBe('self');
			expect(
				asksRule(closure, caller, SECTION_CREATE_PREDICATE),
				`${caller} reaches no authorizeSectionCreate`,
			).toBe(true);
		}
		// …and the tool branch of the add_new_element gate site asks it too.
		expect(asksRule(closure, ADD_NEW_ELEMENT, SECTION_CREATE_PREDICATE)).toBe(true);
	});
});

describe('TOOL_MINTERS — only tool server code can select the section-level add_new_element', () => {
	test('the mint is a real declaration and the derivation found its callers', () => {
		expect(closure.bodies.has(TOOL_ACCESS_MINT), `${TOOL_ACCESS_MINT} is gone`).toBe(true);
		expect(deriveToolMinters(closure).length).toBeGreaterThan(0);
	});

	test('the derived minters EQUAL the table (a new minter is red; a vanished one is red)', () => {
		expect(deriveToolMinters(closure)).toEqual(Object.keys(TOOL_MINTERS).sort());
	});

	test('every minter is TOOL SERVER code — no user door mints the tool access', () => {
		for (const caller of deriveToolMinters(closure)) {
			expect(/^tools\/[^/]+\/server\//.test(caller), `${caller} is not tool server code`).toBe(
				true,
			);
		}
		for (const [caller, entry] of Object.entries(TOOL_MINTERS)) {
			expect(entry.reason.length, `${caller}: reason`).toBeGreaterThan(60);
		}
	});
});

describe('system / tool-gated / engine / pending are true of the source', () => {
	test("system rows calling applyAddNewElement pass the 'system' access mode with a reason", () => {
		for (const { primitive, caller, row } of allRows) {
			if (primitive !== ADD_NEW_ELEMENT || row.verdict !== 'system') continue;
			const calls = callArguments(closure.bodies.get(caller) ?? '', 'applyAddNewElement');
			expect(calls.length).toBeGreaterThan(0);
			for (const args of calls) {
				const text = args.join(',');
				expect(text.includes("mode: 'system'") && text.includes('reason:'), caller).toBe(true);
			}
		}
	});

	test("binding 'module-constant': the section's root identifier is module-bound and not a parameter", () => {
		const checked: string[] = [];
		for (const { caller, row } of allRows) {
			if (row.binding !== 'module-constant') continue;
			const file = caller.split('#')[0] as string;
			const params = parameterText(closure, caller);
			for (const arg of row.sectionArgs) {
				const root = /^[A-Za-z_$][\w$]*/.exec(arg)?.[0] ?? '';
				expect(root, `${caller}: '${arg}' has no identifier root`).not.toBe('');
				expect(isModuleBound(file, root), `${caller}: '${root}' is not module-bound`).toBe(true);
				expect(
					new RegExp(`\\b${root}\\b`).test(params),
					`${caller}: '${root}' is a PARAMETER — the section is caller-supplied`,
				).toBe(false);
				checked.push(`${caller}:${root}`);
			}
		}
		expect(checked.length).toBeGreaterThan(10);
	});

	test("binding is declared on every system / tool-gated row; 'derived' says so in its reason", () => {
		for (const { caller, row } of allRows) {
			if (row.verdict !== 'system' && row.verdict !== 'tool-gated') continue;
			expect(row.binding, `${caller}: no binding`).toBeDefined();
			if (row.binding === 'derived') {
				expect(row.reason.includes('DERIVED'), `${caller}: say what DERIVES the section`).toBe(
					true,
				);
			}
		}
	});

	test('tool-gated rows: the caller is a tool door, and its evidence case still exists', () => {
		for (const { caller, row } of allRows) {
			if (row.verdict !== 'tool-gated') continue;
			expect(
				/^tools\/[^/]+\/server\//.test(caller) || caller.startsWith('src/core/tools/'),
				`${caller}: tool-gated but not a tool door`,
			).toBe(true);
			expect((row.evidence ?? []).length, `${caller}: no evidence`).toBeGreaterThan(0);
			for (const evidence of row.evidence ?? []) {
				const path = join(REPO_ROOT, evidence.file);
				expect(existsSync(path), `${caller}: ${evidence.file} is gone`).toBe(true);
				expect(
					readFileSync(path, 'utf8').includes(evidence.contains),
					`${caller}: ${evidence.file} no longer holds '${evidence.contains}'`,
				).toBe(true);
			}
		}
	});

	test('engine rows are themselves create primitives', () => {
		for (const { caller, row } of allRows) {
			if (row.verdict !== 'engine') continue;
			expect(Object.hasOwn(CREATE_PRIMITIVES, caller), caller).toBe(true);
		}
	});

	test('pending rows state the predicate reach truthfully — a fix cannot land silently', () => {
		for (const { caller, row } of allRows) {
			if (row.verdict !== 'pending') continue;
			expect(
				{ caller, reaches: asksCreatePredicate(closure, caller) as boolean | null },
				'the reach changed: move the row (and add its probe) or correct reachesPredicate',
			).toEqual({ caller, reaches: row.reachesPredicate ?? null });
		}
	});

	test('the pending list is SHRINK-ONLY', () => {
		const pending = allRows.filter(({ row }) => row.verdict === 'pending').length;
		expect(
			pending,
			'PENDING grew — a new create site must be classified, not parked',
		).toBeLessThanOrEqual(PENDING_COUNT);
		expect(pending, 'PENDING shrank — lower PENDING_COUNT so the ratchet keeps biting').toBe(
			PENDING_COUNT,
		);
	});
});

// ---------------------------------------------------------------------------
// Non-vacuity: the derivation sees a PLANTED caller in every import form
// ---------------------------------------------------------------------------

describe('the derivation is not vacuous (planted callers)', () => {
	const planted = 'src/zz_planted_create_door.ts';
	const plantedSource = `import { createSectionRecord } from './core/section/record/create_record.ts';
import { createSectionRecord as mint } from './core/section/record/create_record.ts';

export async function plantedStatic(section: string): Promise<number> {
	return createSectionRecord(section, 1);
}

export async function plantedAliased(): Promise<number> {
	return mint(SOME_SECTION, 1);
}

export async function plantedDynamic(section: string): Promise<unknown> {
	const { applyAddNewElement } = await import('./core/relations/save.ts');
	return applyAddNewElement([], section, 'x', 'y', 1);
}

export async function plantedToolMint(principal: never): Promise<unknown> {
	const { toolAddNewElementAccess } = await import('./core/relations/save.ts');
	return toolAddNewElementAccess(principal, 'tool_zz');
}

export function plantedMention(): string {
	return 'createSectionRecord(section) in a string is no edge';
}

const SOME_SECTION = 'plantedtarget0';
`;
	const files = [
		'src/core/section/record/create_record.ts',
		'src/core/relations/save.ts',
		'src/core/security/write_door.ts',
		planted,
	];
	const read = (rel: string): string =>
		rel === planted ? plantedSource : readFileSync(join(REPO_ROOT, rel), 'utf8');
	const synthetic = buildWriterClosure({ files, read });

	test('static, aliased and dynamic callers are derived; a string mention is not', () => {
		expect(deriveCallers(synthetic, CREATE_RECORD)).toEqual(
			expect.arrayContaining([`${planted}#plantedStatic`, `${planted}#plantedAliased`]),
		);
		expect(deriveCallers(synthetic, ADD_NEW_ELEMENT)).toContain(`${planted}#plantedDynamic`);
		expect(deriveCallers(synthetic, CREATE_RECORD)).not.toContain(`${planted}#plantedMention`);
	});

	test('a planted caller is UNCLASSIFIED (the totality leg would be red)', () => {
		const missing = unclassified(synthetic).filter((entry) => entry.includes(planted));
		expect(missing.sort()).toEqual(
			[
				`${CREATE_RECORD} <- ${planted}#plantedStatic`,
				`${CREATE_RECORD} <- ${planted}#plantedAliased`,
				`${ADD_NEW_ELEMENT} <- ${planted}#plantedDynamic`,
			].sort(),
		);
	});

	test('the section-argument and binding checks read the planted calls', () => {
		expect(sectionArgsOf(synthetic, `${planted}#plantedStatic`, CREATE_RECORD)).toEqual([
			'section',
		]);
		expect(sectionArgsOf(synthetic, `${planted}#plantedDynamic`, ADD_NEW_ELEMENT)).toEqual([
			'section',
		]);
		// a parameter is caught as a parameter …
		expect(parameterText(synthetic, `${planted}#plantedStatic`)).toContain('section');
		// … and a planted caller asks no create predicate.
		expect(asksCreatePredicate(synthetic, `${planted}#plantedStatic`)).toBe(false);
	});

	test('a planted tool-access MINTER outside tools/ is derived (the TOOL_MINTERS legs would be red)', () => {
		const minters = deriveToolMinters(synthetic);
		expect(minters).toEqual([`${planted}#plantedToolMint`]);
		expect(/^tools\/[^/]+\/server\//.test(minters[0] as string)).toBe(false);
	});
});
