/**
 * DD128_PROBED — the bridge between the dd128 write census
 * (test/unit/dd128_write_census_tripwire.test.ts) and the authorization-door
 * matrix (test/unit/authz_door_matrix_native.test.ts), closure Step 3.
 *
 * A census row may claim the verdict `delegates` — "this file's dd128-reachable
 * writes are authorized by the write door (security/write_door.ts), which
 * applies the own-record rule" — ONLY when the claim is MEASURED: the file is a
 * key here, and every matrix door listed for it runs the DD1725 leg (a
 * `(dd128, dd1725)` user-manager addressing their OWN account) and must answer
 * `refused`. The census asserts the membership; the matrix asserts the outcome.
 * A spelling (an import of write_door) is never the evidence on its own.
 *
 * Lives in a helper, not in either test file: a test file imported by another
 * registers its tests twice.
 */

/** Census file → the matrix door keys whose DD1725 leg proves the file delegates. */
export const DD128_PROBED: Readonly<Record<string, readonly string[]>> = {
	// The human save door (sectionFloor 0, the named exception) — its DD1725 leg
	// is the own-record DOWNGRADE through authorizeRecordAccess.
	'src/core/api/handlers/dd_core_api.ts': ['dd_core_api:save'],
	// The MCP write tools — set_field / save_component on the manager's own dd1725.
	// fields_write.ts has TWO dd128-reachable writers that authorize themselves:
	// setField (portal_link / find_or_create fill through it) and portalUnlink
	// (its own door, then deletePortalLocator) — each is a probed door.
	'src/ai/mcp/tools/fields_write.ts': ['mcp:dedalo_set_field', 'mcp:dedalo_portal_unlink'],
	'src/ai/mcp/tools/records_write.ts': ['mcp:dedalo_save_component'],
	// THE declarative tool gate: its `tipo` and `record_tipo` kinds, at write level.
	// tool_upload's component_json write (saveComponentData) — the generic record_tipo/2 probe.
	'tools/tool_upload/server/index.ts': ['tool:tool_upload:process_uploaded_file'],
	'src/core/tools/security.ts': [
		'tool:tool_time_machine:apply_value',
		'tool:tool_image_rotation:apply_rotation',
		'tool:tool_tc:change_all_timecodes',
	],
	// (tool_tc is NOT here: the matrix probes its declarative GATE — the
	// security.ts row above — never its handler, so the file claims nothing of
	// its own; its census row is PENDING.)

	// The tag-delete wire door and the engine it is the ONLY importer of (the
	// importer set is DERIVED by the census — DELEGATING_ENGINES).
	'src/core/api/handlers/dd_component_text_area_api.ts': ['dd_component_text_area_api:delete_tag'],
	'src/core/components/component_text_area/tag_delete.ts': [
		'dd_component_text_area_api:delete_tag',
	],
	// The portal-unlink wire door and its engine (SEC-2-delete_locator):
	// deletePortalLocator is now the write door itself (pair 2, section floor 2,
	// scope). mcp:dedalo_portal_unlink is NOT listed for save.ts — the MCP door
	// refuses DD1725 before the engine runs, so its leg proves nothing of it.
	'src/core/api/handlers/dd_component_portal_api.ts': ['dd_component_portal_api:delete_locator'],
	'src/core/relations/save.ts': ['dd_component_portal_api:delete_locator'],
	// tool_lang / tool_lang_multi automatic_translation (closure Step 3 req 10):
	// the handler's own authorizeRecordAccess, driven through the REAL handler
	// with the manager's own (dd128, dd1725) as the translation target.
	'src/core/tools/translation.ts': [
		'tool:tool_lang:automatic_translation',
		'tool:tool_lang_multi:automatic_translation',
	],
	// tool_posterframe create_identifying_image — the HOST write door in its
	// handler (req 10), probed through the real handler under its own key.
	'tools/tool_posterframe/server/index.ts': ['tool:tool_posterframe:create_identifying_image:host'],
	// tool_update_cache update_cache — the per-ROW write door in its handler
	// (req 10): the manager's own dd1725 row is refused, skipped, never written.
	'tools/tool_update_cache/server/index.ts': ['tool:tool_update_cache:update_cache'],
	// The ingest companions' engine — every companion through the write door as
	// the uploader (req 10); its probe aims a scratch media component's
	// target_filename at the manager's own dd1725.
	'src/core/media/ingest/companion_writes.ts': ['engine:media_ingest.companion_writes'],
	// The mapped-record importer (MARC21 / Zotero / RDF) — every matched
	// record's field through the write door as the importer (req 10).
	'src/core/tools/import_execute.ts': ['engine:import_execute.importMappedRecords'],
	// The CSV importer — every existing row's column through the write door as
	// the importer (req 10).
	'src/core/tools/import_csv_execute.ts': ['engine:import_csv_execute.executeCsvImport'],
	// tool_import_rdf's ontology-driven executor — the caller record's and every
	// run-time-bound term's components through the write door as the importer.
	'tools/tool_import_rdf/server/rdf_import_execute.ts': ['tool:tool_import_rdf:rdf_import_execute'],
	// tool_import_files — the run-time role writes (and the media / host-portal
	// components) through the write door's triple (req 10).
	'tools/tool_import_files/server/index.ts': ['tool:tool_import_files:import_files:roles'],
	// The bulk revert's writer — every component a unit writes through the write
	// door behind the unit's lock (req 10); the orchestrator's pre-gate reads the
	// raw pair, so this leg measures the writer alone.
	'tools/tool_time_machine/server/bulk_revert_undo.ts': [
		'tool:tool_time_machine:bulk_revert_process:units',
	],
	// apply_value's whole-record restore — every component the restore CHANGES
	// through the write door behind the row lock (cross-write:r3); the declarative
	// gate reads the (section, section) pair, so this leg measures the handler.
	'tools/tool_time_machine/server/tool_time_machine.ts': [
		'tool:tool_time_machine:apply_value:section',
	],
	// (transcription_asr.ts is NOT here: its exported saveTranscriptionResult is
	// an UNGATED writer any importer may call, and no matrix door drives the
	// poll's save with the DD1725 manager — PENDING until one does.)
};
