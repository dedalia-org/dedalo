/**
 * VERIFY — the "definition of done" gate for a Dédalo TS change.
 *
 * Deterministic, touched-file-aware. Runs the checks the audit + remediation
 * made load-bearing, in cost order, and stops nothing silently:
 *
 *   1. typecheck    — bunx tsc --noEmit (whole tree; zero-error rule)
 *   2. lint         — bunx biome check . (biome.jsonc; zero-error rule)
 *   2b. lint:browser — the shrink-only budget over the trees biome.jsonc excludes
 *   3. tripwires    — the invariant-enforcement tests (always, they are the
 *                     backbone: SQL confinement, no cross-request state, config
 *                     env, json_codec/locator, SCC, descriptor completeness,
 *                     COEX tags, boundary seam, client byte-identity, oracle
 *                     canary — the authoritative list is engineering/TRIPWIRES.md;
 *                     TRIPWIRES below must match it)
 *   4. neighbours   — the unit/parity test files that IMPORT any changed src
 *                     file (targeted; NOT the full suite)
 *
 * This is NOT the full suite (that is `bun test`). It is the fast pre-commit
 * gate: if verify is green, the change did not break a tripwired invariant and
 * its nearest gates still pass. Parity neighbours need the live PHP oracle
 * (../private/.env + PHP up) — absent, they skip LOUDLY, they do not pass.
 *
 * Usage:
 *   bun run scripts/verify.ts                 # verify uncommitted work (vs HEAD)
 *   bun run scripts/verify.ts --base main     # verify the whole branch vs main
 *   bun run scripts/verify.ts --no-tests      # typecheck + lint + tripwires only
 *   bun run scripts/verify.ts --changed       # print the changed-file set and exit
 *
 * Exit 0 iff every enabled stage is green.
 */

import { readFileSync } from 'node:fs';
import { $ } from 'bun';
// The neighbour selector lives in a lib so a gate can exercise it — verify.ts
// runs on import and cannot itself be imported (scripts/lib/neighbour_tests.ts).
import { neighbourTests } from './lib/neighbour_tests.ts';
// The per-test timeout the root suite runs under. Bun 1.4.0 ignores bunfig.toml's
// `[test] timeout`, so the number has to ride the command line — see
// scripts/lib/test_flags.ts for the measurement that proves it.
import { TEST_TIMEOUT_FLAG } from './lib/test_flags.ts';
import { bunTestFileArgs } from './lib/test_order.ts';

$.throws(false); // we inspect exit codes ourselves; a red stage is data, not a crash

// ---------------------------------------------------------------------------
// The tripwires (engineering/TRIPWIRES.md). Kept explicit — this list IS the
// invariant backbone; if a tripwire is added, add it here too (ci_workflow_tripwire
// asserts this array equals that index EXACTLY, so neither can drift alone).
// ---------------------------------------------------------------------------
const TRIPWIRES = [
	'test/unit/sql_confinement_tripwire.test.ts',
	'test/unit/config_env_tripwire.test.ts',
	'test/unit/config_census_tripwire.test.ts',
	'test/unit/config_declaration_tripwire.test.ts',
	'test/unit/install_seed_manifest_tripwire.test.ts',
	'test/unit/install_seed_drift_tripwire.test.ts',
	'test/unit/install_ip_gate_tripwire.test.ts',
	'test/unit/proxy_trust_tripwire.test.ts',
	'test/unit/password_cost_tripwire.test.ts',
	'test/unit/config_docs_tripwire.test.ts',
	'test/unit/module_state_tripwire.test.ts',
	'test/unit/diffusion_boundaries.test.ts',
	'test/unit/diffusion_dispatch_gate.test.ts',
	'test/unit/boundary_seam_tripwire.test.ts',
	'test/unit/coex_tag_tripwire.test.ts',
	'test/unit/descriptor_completeness_tripwire.test.ts',
	'test/unit/import_scc_tripwire.test.ts',
	'test/unit/ws_a_tripwires.test.ts',
	'test/unit/client_serving.test.ts',
	'test/unit/client_libs_tripwire.test.ts',
	'test/unit/dependency_integrity_tripwire.test.ts',
	'test/unit/media_protection_tripwire.test.ts',
	'test/unit/media_writer_discipline_tripwire.test.ts',
	'test/unit/media_job_target_tripwire.test.ts',
	'test/unit/media_alternate_versions_tripwire.test.ts',
	'test/unit/media_thumb_census_tripwire.test.ts',
	'test/unit/mcp_write_scope_tripwire.test.ts',
	'test/unit/agent_egress_tripwire.test.ts',
	'test/unit/matrix_copy_columns_tripwire.test.ts',
	'test/unit/matrix_counter_monotonic_tripwire.test.ts',
	'test/unit/tm_epoch_tripwire.test.ts',
	'test/unit/tm_history_visibility_tripwire.test.ts',
	'test/unit/relogin_identity_tripwire.test.ts',
	'test/unit/pdf_extract_symmetry_tripwire.test.ts',
	'test/unit/ssrf_one_guard_tripwire.test.ts',
	'test/unit/lint_scope_tripwire.test.ts',
	'test/unit/compose_invocation_tripwire.test.ts',
	'test/unit/gate_vacuity_tripwire.test.ts',
	'test/unit/batch_scope_tripwire.test.ts',
	'test/unit/agent_alias_tripwire.test.ts',
	'test/unit/agent_skills_tripwire.test.ts',
	'test/unit/agent_workflows_parse_tripwire.test.ts',
	'test/unit/css_source_tripwire.test.ts',
	'test/unit/engineering_currency_tripwire.test.ts',
	'test/unit/comment_doc_path_tripwire.test.ts',
	'test/unit/client_suite_registration_tripwire.test.ts',
	'test/unit/config_dead_field_tripwire.test.ts',
	'test/unit/update_waiver_trace_native.test.ts',
	'test/unit/diffusion_publication_gate_native.test.ts',
	'test/unit/alternate_preflight_native.test.ts',
	'test/unit/concurrency_interleave.test.ts',
	'test/unit/seed_definitions_equality_tripwire.test.ts',
	'test/unit/wire_field_agreement_tripwire.test.ts',
	'test/unit/ratchet_integrity_tripwire.test.ts',
	'test/unit/client_store_principal_key_tripwire.test.ts',
	'test/unit/component_teardown_tripwire.test.ts',
	'test/unit/outbound_fetch_tripwire.test.ts',
	'test/unit/guarded_text_pin_native.test.ts',
	'test/unit/strip_comments_tripwire.test.ts',
	'test/unit/private_state_mode_tripwire.test.ts',
	'test/unit/wire_disclosure_tripwire.test.ts',
	'test/unit/archive_precheck_native.test.ts',
	'test/unit/export_download_safety_tripwire.test.ts',
	'test/unit/url_sink_allowlist_tripwire.test.ts',
	'test/unit/client_action_outcome_tripwire.test.ts',
	'test/unit/component_build_wedge_tripwire.test.ts',
	'test/unit/stack_ops_policy_tripwire.test.ts',
	'test/unit/remove_sentinel_native.test.ts',
	'test/unit/client_relation_move_native.test.ts',
	'test/unit/tool_lossless_writeback_tripwire.test.ts',
	'test/unit/tool_lossless_writeback_tethers_native.test.ts',
	'test/unit/consultation_only_sections_tripwire.test.ts',
	'test/unit/tm_mode_retired_tripwire.test.ts',
	'test/unit/log_section_policy_tripwire.test.ts',
	'test/unit/root_user_hidden_tripwire.test.ts',
	'test/unit/test3_canonical_fixture.test.ts',
	'test/unit/update_ownership_tripwire.test.ts',
	'test/unit/release_archive_tripwire.test.ts',
	'test/unit/release_root_entries_tripwire.test.ts',
	'test/unit/info_widget_registry_tripwire.test.ts',
	'test/unit/maintenance_widget_get_value_tripwire.test.ts',
	'test/unit/install_restart_supervisor_tripwire.test.ts',
	'test/unit/ci_workflow_tripwire.test.ts',
	'test/unit/local_db_stores_tripwire.test.ts',
	'test/unit/docs_current_engine_tripwire.test.ts',
	'test/unit/docs_versioning_tripwire.test.ts',
	'test/unit/docs_locator_shape_tripwire.test.ts',
	'test/unit/css_build_tripwire.test.ts',
	'test/unit/css_token_duplication_tripwire.test.ts',
	'test/unit/css_corpus_tripwire.test.ts',
	'test/unit/colour_literal_ratchet_tripwire.test.ts',
	'test/unit/breakpoint_record_tripwire.test.ts',
	'test/unit/wire_contract_tripwire.test.ts',
	'test/unit/change_log_tripwire.test.ts',
	'test/unit/verify_selector_selftest.test.ts',
	'test/unit/delete_inverse_lost_update_native.test.ts',
	'test/unit/duplicate_record_dataframe_native.test.ts',
	'test/unit/dataframe_delete_policy_native.test.ts',
	'test/unit/tm_lang_slice_restore_native.test.ts',
	'test/unit/csv_parser_conformance_native.test.ts',
	'test/unit/ingest_encoding_tripwire.test.ts',
	'test/unit/write_lang_provenance_native.test.ts',
	'test/unit/bulk_process_id_tripwire.test.ts',
	'test/unit/export_gate_b_native.test.ts',
	'test/unit/search_path_acl_native.test.ts',
	'test/unit/frontier_class_native.test.ts',
	'test/unit/build_context_secret_tripwire.test.ts',
	'test/unit/vendor_advisory_tripwire.test.ts',
	'test/unit/client_idempotency_tripwire.test.ts',
	'test/unit/palette_axis_parity_tripwire.test.ts',
	'test/unit/hierarchy_single_writer_tripwire.test.ts',
	'test/unit/ontology_single_writer_tripwire.test.ts',
	'test/unit/rag_index_scope_tripwire.test.ts',
	'test/unit/labels_tripwire.test.ts',
	'test/unit/matrix_index_asset_policy_agreement.test.ts',
	'test/unit/temporal_instance_tripwire.test.ts',
	'test/unit/client_caller_chain_tripwire.test.ts',
	'test/unit/tools_cache_invalidation.test.ts',
	'test/unit/no_remote_code_tripwire.test.ts',
	'test/unit/install_seal_tripwire.test.ts',
	'test/unit/xss_csp_tripwire.test.ts',
	'test/unit/error_report_xss_tripwire.test.ts',
	'test/unit/security_audit_2026_07_23_tripwire.test.ts',
	'test/unit/human_write_scope_tripwire.test.ts',
	'test/unit/tool_permission_census_tripwire.test.ts',
	'test/unit/diffusion_scope_tripwire.test.ts',
	'test/unit/diffusion_queue_stream_tripwire.test.ts',
	'test/unit/dataframe_scan_coverage_tripwire.test.ts',
	'test/unit/tool_header_contract_tripwire.test.ts',
	'test/unit/tool_phone_tripwire.test.ts',
	'test/unit/tool_color_contrast_tripwire.test.ts',
	'test/unit/external_registry_totality_tripwire.test.ts',
	'test/unit/external_outbound_tripwire.test.ts',
	'test/unit/external_secret_confinement_tripwire.test.ts',
	'test/unit/external_isolation_tripwire.test.ts',
	'test/unit/external_egress_tripwire.test.ts',
	'test/unit/external_degradation_tripwire.test.ts',
	'test/unit/external_config_narrowing_census.test.ts',
	'test/unit/external_write_refusal_tripwire.test.ts',
	'test/unit/external_client_render_tripwire.test.ts',
	'test/unit/external_search_target_tripwire.test.ts',
	'test/unit/date_flat_value_single_source_tripwire.test.ts',
	'test/unit/crap_complexity_ratchet.test.ts',
	'test/unit/section_id_int_tripwire.test.ts',
	'test/unit/thesaurus_picker_tripwire.test.ts',
	'test/unit/tool_picker_wiring_tripwire.test.ts',
	'test/unit/error_throw_ratchet.test.ts',
	'test/unit/error_taxonomy_tripwire.test.ts',
	'test/unit/client_error_contract_tripwire.test.ts',
	'test/unit/sw_tombstone_tripwire.test.ts',
	'test/unit/migration_shared_row_tripwire.test.ts',
	'test/unit/generic_tld_tripwire.test.ts',
	'test/unit/parity_baseline_tripwire.test.ts',
	'test/unit/twin_map_tripwire.test.ts',
	'test/unit/mock_isolation_tripwire.test.ts',
	'test/unit/install_table_write_tripwire.test.ts',
	'test/unit/engine_install_tld_tripwire.test.ts',
	'test/unit/test_tld_ontology_gate.test.ts',
	'test/unit/test_db_marker_tripwire.test.ts',
	'test/unit/test_media_root_tripwire.test.ts',
	'test/unit/core_tool_edge_tripwire.test.ts',
	'test/unit/test_rag_db_tripwire.test.ts',
	'test/unit/test_timeout_tripwire.test.ts',
	'test/unit/test_baseline_tripwire.test.ts',
	'test/unit/scratch_tld_uniqueness_tripwire.test.ts',
	'test/unit/corpus_scope_ownership_tripwire.test.ts',
	'test/unit/runtime_paths_census_tripwire.test.ts',
	'test/unit/shard_partition_tripwire.test.ts',
	'test/unit/dbread_role_tripwire.test.ts',
	'test/unit/account_revocation_native.test.ts',
	'test/unit/dd128_write_census_tripwire.test.ts',
	'test/unit/tier_execution_tripwire.test.ts',
	'test/unit/tier_file_order_tripwire.test.ts',
	'test/unit/tier_assignment_tripwire.test.ts',
	'test/unit/site_builder_pairing_tripwire.test.ts',
	'test/unit/site_builder_single_source_tripwire.test.ts',
	'test/unit/operator_commands_tripwire.test.ts',
	'test/unit/backup_restorability_native.test.ts',
	'test/unit/deploy_env_contract_tripwire.test.ts',
	'test/unit/catalog_behaviour_tripwire.test.ts',
	'test/unit/marc_identity_native.test.ts',
	'test/parity/oracle_canary.test.ts',
	'test/unit/tier_wiring_tripwire.test.ts',
	'test/unit/update_drill_config_tripwire.test.ts',
	'test/unit/production_entrypoint_coverage_tripwire.test.ts',
	'test/unit/rag_drain_cli_native.test.ts',
	'test/unit/suite_assertion_floor_tripwire.test.ts',
	'test/unit/client_gate_inventory_tripwire.test.ts',
	'test/unit/authz_substring_gate_tripwire.test.ts',
	'test/unit/census_derivation_tripwire.test.ts',
	'test/unit/read_door_acl_tripwire.test.ts',
	'test/unit/action_scope_binding_tripwire.test.ts',
	'test/unit/write_obligations_tripwire.test.ts',
	'test/unit/value_law_agreement_tripwire.test.ts',
	'test/unit/reconcile_registry_tripwire.test.ts',
	'test/unit/write_obligations_native.test.ts',
	'test/unit/value_law_agreement_native.test.ts',
	'test/unit/reconcile_registry_native.test.ts',
	'test/unit/restore_door_native.test.ts',
	'test/unit/unpublish_debt_native.test.ts',
	'test/unit/suite_mariadb_target_native.test.ts',
	'test/unit/shard_mariadb_sweep_native.test.ts',
	'test/unit/diffusion_frontier_scope_native.test.ts',
	'test/unit/diffusion_seed_compiles_native.test.ts',
	'test/unit/diffusion_seed_vocabulary_tripwire.test.ts',
	'test/unit/raw_roundtrip_native.test.ts',
	'test/unit/conform_locator_existence_native.test.ts',
	'test/unit/archive_docs_claim_tripwire.test.ts',
	'test/unit/production_import_tripwire.test.ts',
	'test/unit/render_escape_tripwire.test.ts',
	'test/unit/render_class_native.test.ts',
	'test/unit/site_builder_csp_tripwire.test.ts',
	'test/unit/client_limit_zero_tripwire.test.ts',
	'test/unit/client_render_budget_native.test.ts',
	'test/unit/client_prototype_contract_tripwire.test.ts',
	'test/unit/client_dead_reference_tripwire.test.ts',
	'test/unit/client_control_naming_tripwire.test.ts',
	'test/unit/client_a11y_budget_tripwire.test.ts',
	'test/unit/client_keyboard_activation_tripwire.test.ts',
	'test/unit/client_map_node_icon_tripwire.test.ts',
	'test/unit/contrast_ratio_tripwire.test.ts',
	'test/unit/publication_bounds_tripwire.test.ts',
	'test/unit/sitebuilder_path_confinement_tripwire.test.ts',
	'test/unit/agent_confinement_tripwire.test.ts',
	'test/unit/rqo_scalar_bound_tripwire.test.ts',
	'test/unit/store_retention_tripwire.test.ts',
	'test/unit/magick_policy_tripwire.test.ts',
	'test/unit/job_lane_census_tripwire.test.ts',
	'test/unit/sync_io_on_request_path_tripwire.test.ts',
	'test/unit/queue_fence_tripwire.test.ts',
	'test/unit/slow_query_scope_native.test.ts',
	'test/unit/query_tap_tripwire.test.ts',
	'test/unit/zzscale_corpus_native.test.ts',
	'test/unit/read_path_record_reuse_tripwire.test.ts',
	'test/unit/search_pattern_escape_tripwire.test.ts',
	'test/unit/closure_openquestions_tripwire.test.ts',
	'test/unit/client_dashboard_sink_tripwire.test.ts',
	'test/unit/client_event_manager_dispatch_tripwire.test.ts',
	'test/unit/client_instances_inflight_tripwire.test.ts',
	'test/unit/client_local_db_singleton_tripwire.test.ts',
	'test/unit/client_read_stream_release_tripwire.test.ts',
	'test/unit/client_request_coalescing_tripwire.test.ts',
	'test/unit/dataframe_contract_tripwire.test.ts',
	'test/unit/ontology_property_census_tripwire.test.ts',
	'test/unit/zip_encoder_census_tripwire.test.ts',
	'test/unit/diffusion_scratch_tables_tripwire.test.ts',
	'test/unit/baseline_registry_tripwire.test.ts',
	'test/unit/baselines_bank_native.test.ts',
	'test/unit/ci_local_native.test.ts',
	'test/unit/pre_push_gate_native.test.ts',
	'test/unit/update_channel_native.test.ts',
	'test/unit/audit_trigger_closure_native.test.ts',
	'test/unit/update_engine_atomic_native.test.ts',
	'test/unit/update_descriptor_tripwire.test.ts',
	'test/unit/statement_ceiling_scope_native.test.ts',
	'test/unit/maintenance_door_unbounded_native.test.ts',
	'test/unit/optimize_concurrent_leftover_native.test.ts',
	'test/unit/db_asset_rebuild_atomic_native.test.ts',
	'test/unit/site_builder_public_address_differential.test.ts',
	'test/unit/alias_target_grammar_native.test.ts',
	'test/unit/search_alias_sink_native.test.ts',
	'test/unit/dd_ontology_identifier_grammar_native.test.ts',
	'test/unit/dd_ontology_grammar_migration_native.test.ts',
	'test/unit/ontology_state_identifier_grammar_native.test.ts',
	// DIFF-1/DIFF-2/DIFF-3/PERF-2 (audit 2026-09-26, 2026-10-01).
	'test/unit/diffusion_target_fence_native.test.ts',
	'test/unit/diffusion_resume_ledger_native.test.ts',
	'test/unit/diffusion_frontier_replay.test.ts',
	'test/unit/diffusion_attach_scope_native.test.ts',
	'test/unit/diffusion_artifact_rss_native.test.ts',
	'test/unit/media_index_reconcile_fence_native.test.ts',
	// WRITE-DOOR / SEC-1 / SEC-2-media / SEC-3 / TOOLS-3 / TOOLS-4 grant half (closure Step 3, 2026-10-01).
	'test/unit/write_door_native.test.ts',
	'test/unit/authz_door_matrix_native.test.ts',
	'test/unit/agent_access_native.test.ts',
	'test/unit/tool_transcription_gate_native.test.ts',
	'test/unit/identify_vision_grant_native.test.ts',
	'test/unit/mcp_record_door_native.test.ts',
	// CORE-1 / CORE-2 residual / TOOLS-5 / CORE-5 — the obligation ledger + locked media-key transform (closure Step 2, 2026-10-01).
	'test/unit/obligation_ledger_native.test.ts',
	'test/unit/media_files_info_lost_update_native.test.ts',
	'test/unit/duplicate_record_media_verdict_native.test.ts',
	// SEC-2-delete_locator — the portal unlink through the write door (closure Step 3, 2026-10-01).
	'test/unit/portal_locator_door_native.test.ts',
	// TOOLS-4 budget half — the AI spend ledger (closure Step 3, 2026-10-01).
	'test/unit/ai_spend_budget_native.test.ts',
	// 2026-10-10 — retired engine nodes are pruned (ddengine11 → hierarchy60).
	'test/unit/engine_ontology_retired_native.test.ts',
	// 2026-10-10 — the registry-row law, declared dependencies (hierarchy60) end to end, the wizard's mandatory thesauri.
	'test/unit/ontology_registry_row_native.test.ts',
	'test/unit/ontology_dependencies_native.test.ts',
	'test/unit/install_hierarchy_dependencies_native.test.ts',
	// Closure Step 3 req 7 — the change-plan validator asks the write door (2026-10-01).
	'test/unit/change_plan_write_door_native.test.ts',
	// Closure Step 3 req 10 residual — the importers' create door + legacy frame slots (2026-10-01).
	'test/unit/import_create_door_native.test.ts',
	// Plan item 5 — the npm rows of the client-lib versions doc are generated (2026-10-02).
	'test/unit/client_lib_versions_doc_tripwire.test.ts',
	// Publication host phase 2 — the engine/agent pairing twin + domain separation (2026-10-03).
	'test/unit/publication_host_pairing_tripwire.test.ts',
	// Publication host phase 2 — rules.apply's directive allowlist held to the engine renderers (2026-10-03).
	'test/unit/publication_host_rules_allowlist_tripwire.test.ts',
	// Publication host phase 3 — the paired private agent channel has one door (2026-10-03).
	'test/unit/publication_host_door_tripwire.test.ts',
	// Publication host phase 4 L4 — engine bundle writer ↔ agent extractBundle twin (2026-10-03).
	'test/unit/publication_host_bundle_twin_tripwire.test.ts',
	// Publication host phases 4–6 — the spec names only paths and scripts that exist (2026-10-03).
	'test/unit/publication_host_spec_refs_tripwire.test.ts',
	// #125 — the vendored transformers.js core and the onnxruntime-web pin are one build (2026-10-04).
	'test/unit/onnxruntime_alignment_tripwire.test.ts',
	// Installer unification A1/A3 — CLI and wizard produce one plan and one .env (2026-10-08).
	'test/unit/install_plan_parity_tripwire.test.ts',
	// Installer unification C — every runtime definition that restarts the server declares DEDALO_SUPERVISED (2026-10-08).
	'test/unit/supervision_declaration_tripwire.test.ts',
	// Installer unification A6 — the vendored oh.copy.gz is installable alone over the core seed (2026-10-09).
	'test/unit/vendored_ontology_closure_tripwire.test.ts',
	// Installer unification A4/A5/A6 — the installer's ontology door, driven on the suite DB (2026-10-09).
	'test/unit/install_ontology_door_native.test.ts',
	// Installer unification A5/A6 — one reference classifier + one COPY codec (2026-10-09).
	'test/unit/ontology_references_native.test.ts',
	// Installer unification A4/A5 — the manifest client, held to configured masters (2026-10-09).
	'test/unit/ontology_manifest_native.test.ts',
	// Installer unification A4/A5 — declared-dependency closure, never computed (2026-10-09).
	'test/unit/install_ontology_choice.test.ts',
	// Installer unification A6 — the offline archive of a REAL export resolves; limits count files, not headers (2026-10-09).
	'test/unit/install_ontology_archive.test.ts',
	// Installer unification D1–D4 — official images on every provisioned registry, pinned stacks,
	// the engine-published client, the image updater, its request channel and the host updater (2026-10-09).
	'test/unit/image_registries_tripwire.test.ts',
	'test/unit/product_image_tripwire.test.ts',
	'test/unit/image_release_native.test.ts',
	'test/unit/image_source_tripwire.test.ts',
	'test/unit/client_publish_native.test.ts',
	'test/unit/install_sh_image_source.test.ts',
	'test/unit/image_update_script_native.test.ts',
	'test/unit/image_update_channel_native.test.ts',
	'test/unit/image_updater_host_native.test.ts',
	'test/unit/image_registries_docs_tripwire.test.ts',
];

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const argv = Bun.argv.slice(2);
const baseIdx = argv.indexOf('--base');
const base = baseIdx !== -1 ? argv[baseIdx + 1] : 'HEAD';
const runTests = !argv.includes('--no-tests');
const changedOnly = argv.includes('--changed');

// ---------------------------------------------------------------------------
// Changed-file discovery: tracked changes vs <base> + untracked (unignored).
// ---------------------------------------------------------------------------
async function changedFiles(): Promise<string[]> {
	const tracked = await $`git diff --name-only ${base}`.text();
	const untracked = await $`git ls-files --others --exclude-standard`.text();
	const set = new Set<string>();
	for (const line of `${tracked}\n${untracked}`.split('\n')) {
		const f = line.trim();
		if (f) set.add(f);
	}
	return [...set];
}

// ---------------------------------------------------------------------------
// Stage runner
// ---------------------------------------------------------------------------
interface Stage {
	name: string;
	ok: boolean;
	detail: string;
}
const results: Stage[] = [];

function banner(msg: string): void {
	console.log(`\n\x1b[1m▶ ${msg}\x1b[0m`);
}

async function typecheck(): Promise<void> {
	banner('typecheck (tsc --noEmit)');
	const r = await $`bunx tsc --noEmit`.quiet();
	const errs = (r.stdout.toString() + r.stderr.toString())
		.split('\n')
		.filter((l) => l.includes('error TS')).length;
	const ok = r.exitCode === 0;
	if (!ok) console.log(r.stdout.toString().split('\n').slice(0, 20).join('\n'));
	results.push({ name: 'typecheck', ok, detail: ok ? '0 errors' : `${errs} error(s)` });
}

async function lint(): Promise<void> {
	banner('lint (biome check)');
	const r = await $`bunx biome check .`.quiet();
	const ok = r.exitCode === 0;
	if (!ok) {
		const tail = r.stdout.toString().split('\n');
		console.log(tail.slice(-12).join('\n'));
	}
	results.push({ name: 'lint', ok, detail: ok ? 'clean' : 'errors (see above)' });
}

/**
 * The BROWSER trees biome.jsonc excludes (P1-17). `biome check .` cannot see
 * them, so a green lint above says nothing about ~315k lines of client code;
 * this measures them with the same rules against a shrink-only budget.
 */
async function lintBrowserBudget(): Promise<void> {
	banner('lint budget (browser trees)');
	const r = await $`bun run scripts/lint_browser_budget.ts`.nothrow().quiet();
	const ok = r.exitCode === 0;
	const out = (r.stdout.toString() + r.stderr.toString()).trim();
	console.log(out.split('\n').slice(-4).join('\n'));
	results.push({
		name: 'lint:browser',
		ok,
		detail: ok ? (out.split('\n').pop() ?? 'at budget') : 'budget exceeded (see above)',
	});
}

/**
 * Failing test names this run is allowed to see WITHOUT going red — the two
 * frozen, SHRINK-ONLY red baselines: the parity tier's corpus-bound reds
 * (engineering/parity_baseline.json) and the unit tier's frozen debt
 * (engineering/unit_baseline.json).
 *
 * WHY THIS EXISTS. The parity tier is red BY CONSTRUCTION: 100 of its cases are
 * frozen because they were harvested against one installation's records, which
 * the suite database does not and must not hold. Those files are ordinary
 * neighbours of src/ modules, so once the neighbour selector actually selected
 * anything (it selected NOTHING until 2026-08-27) every change touching a
 * widely-imported module reported VERIFY RED for failures that are not the
 * developer's and cannot be fixed here. A gate that is red for reasons the
 * reader cannot act on is a gate the reader learns to ignore — which is exactly
 * how this repo's verify went unread for 45 commits. The unit tier's frozen
 * reds are the same shape seen from the other tier: a golden that has been red
 * since 2026-08-30 turns every change touching its module's imports RED here
 * while `unit_baseline --check` on the db tier says "no drift".
 *
 * So a frozen failure is FORGIVEN and COUNTED, never hidden; a failure that is
 * NOT in a baseline still reddens the stage. Both baselines are shrink-only —
 * the generators refuse a new red without --allow-regression, a listed test
 * that PASSES is itself a drift — and are guarded by parity_baseline_tripwire /
 * the db tier's `unit_baseline.ts --check`, so this cannot become a way to
 * silence a real regression.
 */
function frozenBaselineFailures(): Set<string> {
	const out = new Set<string>();
	for (const path of ['engineering/parity_baseline.json', 'engineering/unit_baseline.json']) {
		try {
			const json = JSON.parse(readFileSync(path, 'utf8')) as {
				files?: Record<string, string[]>;
			};
			for (const names of Object.values(json.files ?? {})) for (const n of names) out.add(n);
		} catch {
			// No baseline, or unreadable: forgive NOTHING from it. Fail-closed by
			// design — a missing baseline must never become a blanket amnesty.
		}
	}
	return out;
}

async function runTestFiles(name: string, files: string[], forgiven?: Set<string>): Promise<void> {
	banner(`${name} (${files.length} file${files.length === 1 ? '' : 's'})`);
	if (files.length === 0) {
		results.push({ name, ok: true, detail: 'no files' });
		return;
	}
	// Sorted `./` paths (scripts/lib/test_order.ts): a bare name is a bun FILTER run in readdir order.
	const r = await $`bun test ${TEST_TIMEOUT_FLAG} ${bunTestFileArgs(files)}`.quiet();
	const output = r.stdout.toString() + r.stderr.toString();
	// biome-ignore lint/suspicious/noControlCharactersInRegex: \x1b is the ANSI escape being stripped
	const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
	// ANCHORED to bun's own summary lines (` 181 pass`, ` 0 fail`), never a bare
	// substring: an unanchored /(\d+) fail/ matches log text a test EMITS — a
	// media case logging `ffmpeg pass 1 failed` made a clean 181/0 run report
	// "159 pass / 1 fail" while `ok` (the exit code) correctly said green.
	// A gate's own tally must not be readable out of arbitrary stdout.
	const passM = clean.match(/^\s*(\d+) pass$/m);

	// Split the failures into the ones the baseline already froze and the ones
	// it did not. A frozen failure is reported, not hidden — it just does not
	// redden the stage.
	const failedNames = clean
		.split('\n')
		.filter((l) => l.startsWith('(fail)'))
		.map((l) =>
			l
				.replace(/^\(fail\)\s*/, '')
				.replace(/\s*\[[\d.]+m?s\]\s*$/, '')
				.trim(),
		);
	const unfrozen =
		forgiven === undefined ? failedNames : failedNames.filter((n) => !forgiven.has(n));
	const frozenSeen = failedNames.length - unfrozen.length;

	const ok = r.exitCode === 0 || (failedNames.length > 0 && unfrozen.length === 0);
	if (!ok) {
		for (const l of clean.split('\n'))
			if (l.startsWith('✗') || l.startsWith('(fail)')) console.log(l);
	}
	const frozenNote = frozenSeen > 0 ? ` (${frozenSeen} frozen)` : '';
	results.push({
		name,
		ok,
		detail: `${passM?.[1] ?? '?'} pass / ${unfrozen.length} fail${frozenNote}`,
	});
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
/**
 * THE DEBT LEDGER IS APPEND-ONLY AGAINST HISTORY (P2-18 / GATE-22).
 *
 * `engineering/crap_complexity_baseline.json` carries its own ledger, and the
 * hermetic predicate (crap_complexity_ratchet + ratchet_integrity_tripwire)
 * holds every line to its rule — but a REWRITTEN line, or a per-file entry
 * raised with the counters flat, is visible only against the artifact as it
 * stood at a reference commit. The reference is the merge-base of HEAD and
 * `--base` (HEAD itself by default: the working tree against the committed
 * artifact, which is where a hand edit lives before it is committed). An
 * empty merge-base is a RED stage, never a comparison against nothing —
 * crap_baseline.ts refuses an empty `--reference` on its own as well. CI's
 * twin is the `crap ledger` stage of scripts/ci/hermetic.sh (leg C of
 * tier_wiring_tripwire holds the pairing).
 */
async function crapLedger(): Promise<void> {
	banner('crap ledger (append-only vs the merge-base)');
	const mb = await $`git merge-base HEAD ${base}`.nothrow().quiet();
	const reference = mb.stdout.toString().trim();
	if (mb.exitCode !== 0 || reference === '') {
		console.log(mb.stderr.toString().trim());
		results.push({
			name: 'crap:ledger',
			ok: false,
			detail: `no merge-base between HEAD and ${base} — the reference is unresolvable, which is red, not skipped`,
		});
		return;
	}
	const r = await $`bun run scripts/crap_baseline.ts --check --reference ${reference}`
		.nothrow()
		.quiet();
	const out = (r.stdout.toString() + r.stderr.toString()).trim();
	const ok = r.exitCode === 0;
	if (!ok) console.log(out.split('\n').slice(-12).join('\n'));
	results.push({
		name: 'crap:ledger',
		ok,
		detail: ok ? `append-only vs ${reference.slice(0, 12)}` : 'ledger inconsistent (see above)',
	});
}

const changed = await changedFiles();

if (changedOnly) {
	console.log(changed.join('\n'));
	process.exit(0);
}

console.log(`\x1b[1mVERIFY\x1b[0m — ${changed.length} changed file(s) vs ${base}`);

// TYPECHECK AND LINT RUN CONCURRENTLY. Both are whole-tree, independent and
// read-only; sequencing them only added their wall clocks together. Both
// verdicts are always recorded, so a red lint cannot mask a red typecheck.
// Their console output is buffered inside each stage and printed on completion,
// so a concurrent run still reads top-to-bottom rather than interleaving.
await Promise.all([typecheck(), lint(), lintBrowserBudget(), crapLedger()]);
// Concurrency made the PUSH order a race, which made the summary's row order
// vary between runs — a verdict table that reshuffles is a verdict table people
// stop reading. Pin the two static stages to their declared order; the test
// stages below append after them, as they always did.
const STATIC_STAGE_ORDER = ['typecheck', 'lint', 'lint:browser', 'crap:ledger'];
results.sort((a, b) => STATIC_STAGE_ORDER.indexOf(a.name) - STATIC_STAGE_ORDER.indexOf(b.name));

if (runTests) {
	await runTestFiles('tripwires', TRIPWIRES);
	const neighbours = await neighbourTests(changed);
	// Do not re-run a tripwire as a "neighbour".
	const only = neighbours.filter((f) => !TRIPWIRES.includes(f));
	await runTestFiles('neighbours', only, frozenBaselineFailures());

	// The site-builder daemon is its own package (publication/site_builder) — outside the
	// src/+test/ trees the neighbour scan covers — so its suite runs as a targeted stage
	// whenever the change touches it. Hermetic (no DB, no oracle); CI runs it always via
	// scripts/ci/hermetic.sh.
	//
	// NO --timeout HERE, DELIBERATELY. The root suite gets TEST_TIMEOUT_FLAG because it
	// LOST a number it had chosen: bunfig.toml declared `[test] timeout = 30000` and Bun
	// 1.4.0 silently ignored it. This package never made that claim —
	// publication/site_builder has NO bunfig.toml at all — the file does not exist, measured
	// 2026-08-25, so no timeout was ever declared (its sibling
	// publication/server_api/v2/bunfig.toml declares only coverage/coverageThreshold) — so
	// its green baseline was measured under bun's built-in 5000 ms cap and stays
	// comparable run to run. Widening it on no evidence would be silently loosening a
	// gate, not restoring one. Same reasoning, same wording, at the other exempt site:
	// scripts/ci/hermetic.sh daemon_gate().
	if (changed.some((f) => f.startsWith('publication/site_builder/'))) {
		banner('site_builder (tsc + bun test in publication/site_builder)');
		const r = await $`bash -c "cd publication/site_builder && bunx tsc --noEmit && bun test 2>&1"`
			.quiet()
			.nothrow();
		const text = r.stdout.toString() + r.stderr.toString();
		console.log(text.split('\n').slice(-6).join('\n'));
		const passM = text.match(/(\d+) pass/);
		const failM = text.match(/(\d+) fail/);
		const ok = r.exitCode === 0 && failM?.[1] === '0';
		results.push({
			name: 'site_builder',
			ok,
			detail: `${passM?.[1] ?? '?'} pass / ${failM?.[1] ?? '?'} fail`,
		});
	}

	// The publication-host agent (publication/host_agent) is the THIRD isolated daemon
	// package, with the site_builder stage's shape and reasoning: it sits outside the
	// src/+test/ trees the neighbour scan covers, and it is hermetic (no DB, no oracle,
	// scratch roots under its own .test-tmp/). It runs here when the change touches it,
	// and always via scripts/ci/hermetic.sh daemon_gate(). NO --timeout, deliberately,
	// for the same reason: its bunfig.toml declares coverage + coverageThreshold and no
	// timeout (test_timeout_tripwire DAEMON_EXEMPT names this site).
	if (changed.some((f) => f.startsWith('publication/host_agent/'))) {
		banner('host_agent (tsc + bun test in publication/host_agent)');
		const r = await $`bash -c "cd publication/host_agent && bunx tsc --noEmit && bun test 2>&1"`
			.quiet()
			.nothrow();
		const text = r.stdout.toString() + r.stderr.toString();
		console.log(text.split('\n').slice(-6).join('\n'));
		const passM = text.match(/(\d+) pass/);
		const failM = text.match(/(\d+) fail/);
		const ok = r.exitCode === 0 && failM?.[1] === '0';
		results.push({
			name: 'host_agent',
			ok,
			detail: `${passM?.[1] ?? '?'} pass / ${failM?.[1] ?? '?'} fail`,
		});
	}
} else {
	console.log('\n(--no-tests: skipping tripwires + neighbours)');
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------
console.log('\n\x1b[1m─ VERIFY SUMMARY ─\x1b[0m');
let allOk = true;
for (const s of results) {
	const mark = s.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
	console.log(`  ${mark} ${s.name.padEnd(12)} ${s.detail}`);
	if (!s.ok) allOk = false;
}
console.log(allOk ? '\n\x1b[32mVERIFY GREEN\x1b[0m' : '\n\x1b[31mVERIFY RED\x1b[0m');
process.exit(allOk ? 0 : 1);
