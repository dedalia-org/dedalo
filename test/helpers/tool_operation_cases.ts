/**
 * TOOL OPERATION COVERAGE — which tools are proven to WORK (not merely open)
 * in a browser, and by what. Opening every offered tool, per persona, is the
 * crawl's job (scripts/feature_crawl.ts); this map is about the primary action.
 *
 * Every tool directory is in exactly one of: TOOL_OPERATED (evidence),
 * TOOL_OPERATION_PENDING (reason), or grant-only (derived from its
 * register.json). Evidence is `journey:<name>` (test/helpers/journey_cases.ts,
 * run per persona) or `client:<file>` (a test:client suite that performs the
 * operation as root). Gate: test/unit/feature_crawl_tripwire.test.ts.
 */

export const TOOL_OPERATED: Record<string, string> = {
	tool_export: 'journey:tool_export_csv_respects_projects',
	tool_bibliography_acquisition: 'client:test_tool_bibliography_acquisition.js',
	tool_import_dedalo_csv: 'client:test_tool_import_dedalo_csv.js',
	tool_indexation: 'client:test_tool_indexation.js',
	tool_numisdata_acquisition: 'client:test_tool_numisdata_acquisition.js',
	tool_pdf_extractor: 'client:test_tool_pdf_extractor.js',
	tool_sitebuilder: 'client:test_tool_sitebuilder.js',
};

const WIRING_ONLY =
	'client suite checks construction/wiring only; no primary action is run in a browser';

export const TOOL_OPERATION_PENDING: Record<string, string> = {
	tool_assistant: `${WIRING_ONLY} (needs the agent service)`,
	tool_cataloging: WIRING_ONLY,
	tool_dd_label: WIRING_ONLY,
	tool_dev_template: 'template scaffold, no user-facing action of its own',
	tool_diffusion: `${WIRING_ONLY} (journey diffusion_publish pending)`,
	tool_error_report: 'no client suite; submit an error report and read it back',
	tool_hierarchy: WIRING_ONLY,
	tool_identify: 'no client suite; needs an identify profile + image index on the suite DB',
	tool_image_rotation: WIRING_ONLY,
	tool_import_files: WIRING_ONLY,
	tool_import_marc21: WIRING_ONLY,
	tool_import_rdf: WIRING_ONLY,
	tool_import_zotero: WIRING_ONLY,
	tool_lang: `${WIRING_ONLY} (translate one component, read the other lang back)`,
	tool_lang_multi: WIRING_ONLY,
	tool_media_versions: `${WIRING_ONLY} (build a version of a planted image)`,
	tool_numisdata_epigraphy: WIRING_ONLY,
	tool_numisdata_order_coins: WIRING_ONLY,
	tool_ontology: WIRING_ONLY,
	tool_ontology_parser: WIRING_ONLY,
	tool_posterframe: WIRING_ONLY,
	tool_print: WIRING_ONLY,
	tool_propagate_component_data: `${WIRING_ONLY} (propagate a value to a scratch selection)`,
	tool_qr: WIRING_ONLY,
	tool_subtitles: WIRING_ONLY,
	tool_tc: WIRING_ONLY,
	tool_time_machine: `${WIRING_ONLY} (journeys recover_deleted_record / restore_component_value pending)`,
	tool_tr_print: WIRING_ONLY,
	tool_transcription: WIRING_ONLY,
	tool_update_cache: WIRING_ONLY,
	tool_upload: `${WIRING_ONLY} (journey media_upload_view_download pending)`,
	tool_user_admin: `${WIRING_ONLY} (journey change_own_password pending)`,
};
