/**
 * CREATE_DOOR_PROBES — the bridge between the create-door census
 * (test/unit/create_door_census_tripwire.test.ts) and the create-gate outcome
 * gate (test/unit/add_new_element_create_gate_native.test.ts), T0-2.
 *
 * A census row may claim `authorizes-create` — "this caller's create is
 * authorized by the ONE create predicate, write_door.ts authorizeRecordCreate"
 * — ONLY by naming door ids listed here. The census asserts the MEMBERSHIP (a
 * row naming an id not listed here is red; an id no row claims is red); the
 * native gate asserts the OUTCOME: every id below is driven by a
 * create-ungranted persona and REFUSED (perm.denied 403, zero rows created, no
 * activity, host unchanged) AND by a granted CONTROL that creates exactly one
 * record — `markCreateDoorDriven` runs only after that case's own assertion
 * passed, and the gate's last case requires the driven set to equal this list.
 * Dropping a probe id here reds the census; dropping a driven case there reds
 * the native gate. Neither half alone is evidence.
 *
 * Lives in a helper, not in either test file: a test file imported by another
 * registers its tests twice.
 */

/** Door id → what the native gate drives under that id. */
export const CREATE_DOOR_PROBES = {
	'save:add_new_element':
		'the human save door (dd_core_api save) — a portal changed_data add_new_element; the gate site is relations/save.ts applyAddNewElement',
	'temporal:add_new_element':
		'the temporal save door (is_temporal save, section/record/temporal.ts) — add_new_element on a temporal instance',
	'children:add_new_element':
		'the component_relation_children write-through (relations/children_write.ts) — a child born through add_new_element',
	'dd_core_api:duplicate': 'core duplicate (dd_core_api duplicate)',
	'dd_ts_api:add_child': 'the thesaurus tree add_child (ts_object/ts_api.ts addChild)',
	'mcp:create_record': 'MCP dedalo_create_record (ai/mcp/tools/records_write.ts createRecord)',
	'mcp:find_or_create':
		'MCP dedalo_find_or_create, the create branch (ai/mcp/tools/fields_write.ts findOrCreate)',
	'hierarchy:declared_root_term':
		'the hierarchy invariant minting a root term in an operator-DECLARED section that is not the hierarchy’s own provisioned one (ontology/hierarchy_state.ts mintDeclaredRootTerm — review finding F2)',
	'mcp:duplicate_record':
		'MCP dedalo_duplicate_record (ai/mcp/tools/fields_write.ts duplicateRecord)',
} as const;

export type CreateDoorId = keyof typeof CREATE_DOOR_PROBES;

/** The outcome gate that drives every probe id. */
export const CREATE_DOOR_PROBE_GATE = 'test/unit/add_new_element_create_gate_native.test.ts';

/** The two outcomes each door must be driven to in one run. */
export type CreateDoorOutcome = 'refused' | 'created';

const driven: Record<CreateDoorOutcome, Set<CreateDoorId>> = {
	refused: new Set(),
	created: new Set(),
};

/**
 * Record that `door` was driven to `outcome` — call it AFTER the case's own
 * assertion (expectRefused perm.denied / expectCreatedOne), so a failing case
 * never counts.
 */
export function markCreateDoorDriven(door: CreateDoorId, outcome: CreateDoorOutcome): void {
	driven[outcome].add(door);
}

/** What this run drove, per outcome, sorted — compared against {@link expectedCreateDoorDrive}. */
export function createDoorDriveReport(): Record<CreateDoorOutcome, string[]> {
	return { refused: [...driven.refused].sort(), created: [...driven.created].sort() };
}

/** Every probe id, refused AND created. */
export function expectedCreateDoorDrive(): Record<CreateDoorOutcome, string[]> {
	const all = Object.keys(CREATE_DOOR_PROBES).sort();
	return { refused: all, created: [...all] };
}

// ---------------------------------------------------------------------------
// THE SECTION-LEVEL CREATE DOORS (T0-2, owner decisions D4 / D3 REVISED 2026-11-10)
// ---------------------------------------------------------------------------

/**
 * SECTION_CREATE_DOOR_PROBES — the doors whose create is authorized by the
 * SECTION level alone (write_door.ts authorizeSectionCreate: section ≥ 2,
 * consultation-capped — PHP dd_core_api::create parity), NOT by the New-button
 * predicate. The census verdict `authorizes-section-create` may name only these.
 *
 * Their OUTCOME is the opposite contrast of CREATE_DOOR_PROBES: each id is driven
 *   - REFUSED by a persona whose SECTION grant is below 2 (perm.denied, zero rows), and
 *   - CREATED by a persona holding the section at 2 with the section's button_new
 *     WITHHELD (or the section shipping none) — the case that proves the door does
 *     NOT ask the New button. A door that silently started asking it reds there.
 * Same driving gate, same completeness case.
 */
export const SECTION_CREATE_DOOR_PROBES = {
	'dd_core_api:create':
		'core create (dd_core_api create) — notes, TM notes, index notes, references, dataframe frames, presets: feature-owned sections that ship no button_new',
	'tool:add_new_element':
		'a TOOL-driven add_new_element (saveComponentData with the server-minted tool access — tool_import_files, tool_posterframe, tool_numisdata_acquisition): section level + target_sections membership',
} as const;

export type SectionCreateDoorId = keyof typeof SECTION_CREATE_DOOR_PROBES;

const sectionDriven: Record<CreateDoorOutcome, Set<SectionCreateDoorId>> = {
	refused: new Set(),
	created: new Set(),
};

/** As {@link markCreateDoorDriven}, for a section-level door ('created' = WITH the New button withheld). */
export function markSectionCreateDoorDriven(
	door: SectionCreateDoorId,
	outcome: CreateDoorOutcome,
): void {
	sectionDriven[outcome].add(door);
}

export function sectionCreateDoorDriveReport(): Record<CreateDoorOutcome, string[]> {
	return {
		refused: [...sectionDriven.refused].sort(),
		created: [...sectionDriven.created].sort(),
	};
}

export function expectedSectionCreateDoorDrive(): Record<CreateDoorOutcome, string[]> {
	const all = Object.keys(SECTION_CREATE_DOOR_PROBES).sort();
	return { refused: all, created: [...all] };
}
