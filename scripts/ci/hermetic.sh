#!/usr/bin/env bash
#
# HERMETIC CI TIER — typecheck + lint + the DB-less/sibling-less tripwires.
#
# The single source of truth for the hermetic gate: the GitHub Actions
# `hermetic` job AND `.gitlab-ci.yml` both run THIS script, so the two
# platforms can never drift (test/unit/ci_workflow_tripwire.test.ts enforces
# that both YAMLs invoke it, and that HERMETIC_TRIPWIRES stays a subset of
# scripts/verify.ts TRIPWIRES).
#
# Runs on a bare runner: no ../private/.env, no Postgres, no PHP oracle, no
# sibling PHP tree. EVERY required-no-default config key gets a harmless stub
# (only when absent) so the test preload's config load succeeds; nothing here
# ever connects to a database — the tripwires below were empirically verified
# to pass with DB_HOST pointing at a closed port (2026-07-09).
#
# THE TRAP THIS SCRIPT WALKED INTO (2026-07-11, first real CI run): the stub list
# said "the four required config keys" but the catalog requires EIGHT — the four
# LANGUAGE keys were missing. Nobody noticed, because on a developer machine
# ../private/.env sits right there and silently satisfies them: the script passed
# locally and died on the runner with `Missing required config key
# 'PROJECTS_DEFAULT_LANGS'` (plus three cascading "Cannot access 'config' before
# initialization" TDZ errors — module-init fallout from the same throw, not four
# separate bugs). The stub list is now pinned to the catalog by rule 6 of
# test/unit/ci_workflow_tripwire.test.ts: add a required key to src/config/config.ts
# without stubbing it here and the tripwire goes red BEFORE CI does.
#
# THE COVERAGE HOLE THIS LIST WALKED INTO (2026-08-03), AND WHY IT REOPENED.
# The hermetic list had 20 of the 48 tripwires in scripts/verify.ts, and the other
# 28 ran on NO tier that actually executes: the DB/parity tier lives in
# .github/workflows-selfhosted/, which GitHub does not run (public-repo posture),
# and the private mirror is not wired yet. So a PR could land an `innerHTML` sink
# in the error-report client, a CDN `import` in a tool, an unclassified agent read
# tool, or an unscoped human write handler, and every gate the repo owns would
# report GREEN — the invariants existed, nothing ran them.
#
# It reopened, because nothing ENFORCED the list. By 2026-08-24 the index had
# grown to 89 gates against the same 41 here, and five more landed that day: 53
# running nowhere, with every gate green throughout. Fixed in that pass — rule 3c
# of test/unit/ci_workflow_tripwire.test.ts is the converse of the old subset
# rule: a tripwire must either appear below or carry a written reason in its
# NOT_HERMETIC map, and a stale row there is red too. The list can no longer rot
# quietly. Same pass hardened the parser that reads this array: a section comment
# containing '(' had been truncating it at 21 of 41 entries since 2026-08-03, so
# the subset rule was itself only checking half the list.
#
# NOT in this list, and WHY: that boundary is no longer prose here — it is the
# NOT_HERMETIC map in test/unit/ci_workflow_tripwire.test.ts, one written reason
# per excluded gate, mechanically enforced in both directions. This comment used
# to carry a hand list; four of its entries were stale (client_serving,
# client_libs_tripwire, oracle_canary and install_seed_drift all run here now).
# Link, never duplicate.
#
# Each entry below was empirically re-verified DB-less (DB_PORT closed).
#
# Usage: bash scripts/ci/hermetic.sh   (from anywhere; cd's to repo root)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"
# shellcheck source=scripts/ci/test_order.sh
source scripts/ci/test_order.sh

# Puppeteer is a devDep used only by the client gate (self-hosted); never
# download Chrome on a hermetic runner.
export PUPPETEER_SKIP_DOWNLOAD=1

# THE KEY THE COMMENT BELOW ALREADY PROMISED (P2-22 / GATE-06). The tripwire
# list further down says "parity_baseline_tripwire skips 5 legs behind
# DEDALO_PARITY_DRIFT" — and nothing in this repository ever set that key, so
# `LIVE_DRIFT = process.env.DEDALO_PARITY_DRIFT !== '0'` was TRUE and the drift
# legs ran here, on a runner whose DB_PORT is deliberately closed. Every
# DB-backed parity gate then dies at module scope and the ratchet reports the
# flood as NEW PARITY REDS — a red nobody can attribute, which is a gate that
# has stopped reporting.
#
# It was masked only because lint was red and runs first. Lint is green now, so
# the mask is gone: this line is what the comment was always describing.
# Enforcement of the drift ratchet itself stays where that comment says it does
# — `bun run scripts/parity_baseline.ts --check`, on a tier that has a database.
export DEDALO_PARITY_DRIFT=0

# THE CALENDAR IS NOT A PUSH INPUT (2026-09-26). vendor_advisory_tripwire's
# load-bearing leg has two WALL-CLOCK halves — a vendored row's review window
# lapsing, an advisory acceptance expiring — that made the same sha green one day
# and red the next, on whoever pushed next. This key drops exactly those two from
# the always-run tripwire block below; every tree-only leg (an in-range advisory
# with no acceptance, a verify clause that no longer holds, the pdf.js mount) still
# runs on every push. The dated halves run in the dependency-audit stage further
# down (scripts/ci/audit.ts calls the same checker with the calendar ON) whenever a
# push changes what they read, and every night in .github/workflows/nightly.yml,
# which warns 21 days before a window closes. Read by the gate as
# process.env.DEDALO_VENDOR_DATED_CHECKS; ci_workflow_tripwire rule 12 holds both
# ends. Default (unset) is ON: a developer's bare `bun test` still sees them.
export DEDALO_VENDOR_DATED_CHECKS=0

# Stub the required-no-default config keys so the config catalog loads.
# Externally provided values always win (: "${VAR:=default}" keeps them).
# This list must cover EVERY require*() key in src/config/config.ts — pinned by
# ci_workflow_tripwire rule 6. Values are config-less sentinels: they only
# have to parse, since no hermetic gate reads project data.
: "${ENTITY:=ci_hermetic}"
: "${DB_NAME:=ci_hermetic_no_db}"
: "${DB_HOST:=127.0.0.1}"
: "${DB_PORT:=59999}" # deliberately closed: any accidental DB touch fails loudly
: "${DB_USER:=ci_hermetic}"
# LANGUAGE keys — install configuration, required from ../private/.env in a real
# install (owner rule 2026-07-09), absent on a bare runner. JSON must parse.
#
# NOT `: "${VAR:=<json>}"`: a `}` inside the default TERMINATES the parameter
# expansion, so a JSON object map arrives truncated and the catalog rejects it
# ("must be a non-empty JSON object map"). Plain if-blocks with single quotes.
: "${PROJECTS_DEFAULT_LANGS:=[\"lg-eng\"]}"
if [ -z "${DEDALO_APPLICATION_LANGS:-}" ]; then
	DEDALO_APPLICATION_LANGS='{"lg-eng":"English"}'
fi
: "${DEDALO_APPLICATION_LANGS_DEFAULT:=lg-eng}"
: "${DEDALO_DATA_LANG_DEFAULT:=lg-eng}"
export ENTITY DB_NAME DB_HOST DB_PORT DB_USER
export PROJECTS_DEFAULT_LANGS DEDALO_APPLICATION_LANGS DEDALO_APPLICATION_LANGS_DEFAULT DEDALO_DATA_LANG_DEFAULT

# Tripwires proven to run with no DB, no ../private, no sibling PHP tree.
HERMETIC_TRIPWIRES=(
	test/unit/config_env_tripwire.test.ts
	test/unit/module_state_tripwire.test.ts
	test/unit/diffusion_boundaries.test.ts
	test/unit/diffusion_dispatch_gate.test.ts
	test/unit/boundary_seam_tripwire.test.ts
	test/unit/core_tool_edge_tripwire.test.ts
	test/unit/coex_tag_tripwire.test.ts
	test/unit/descriptor_completeness_tripwire.test.ts
	test/unit/import_scc_tripwire.test.ts
	test/unit/media_protection_tripwire.test.ts
	test/unit/mcp_write_scope_tripwire.test.ts
	test/unit/matrix_copy_columns_tripwire.test.ts
	test/unit/matrix_counter_monotonic_tripwire.test.ts
	test/unit/tm_epoch_tripwire.test.ts
	test/unit/tm_history_visibility_tripwire.test.ts
	test/unit/relogin_identity_tripwire.test.ts
	test/unit/pdf_extract_symmetry_tripwire.test.ts
	test/unit/ssrf_one_guard_tripwire.test.ts
	test/unit/lint_scope_tripwire.test.ts
	test/unit/lint_scope_local_only_untracked_tripwire.test.ts
	test/unit/compose_invocation_tripwire.test.ts
	test/unit/gate_vacuity_tripwire.test.ts
	test/unit/batch_scope_tripwire.test.ts
	test/unit/agent_alias_tripwire.test.ts
	test/unit/agent_skills_tripwire.test.ts
	test/unit/agent_workflows_parse_tripwire.test.ts
	test/unit/css_source_tripwire.test.ts
	test/unit/engineering_currency_tripwire.test.ts
	test/unit/comment_doc_path_tripwire.test.ts
	test/unit/client_suite_registration_tripwire.test.ts
	test/unit/config_dead_field_tripwire.test.ts
	test/unit/update_waiver_trace_native.test.ts
	test/unit/update_channel_native.test.ts
	test/unit/audit_trigger_closure_native.test.ts
	test/unit/diffusion_publication_gate_native.test.ts
	test/unit/alternate_preflight_native.test.ts
	test/unit/seed_definitions_equality_tripwire.test.ts
	test/unit/wire_field_agreement_tripwire.test.ts
	test/unit/ratchet_integrity_tripwire.test.ts
	test/unit/client_store_principal_key_tripwire.test.ts
	test/unit/component_teardown_tripwire.test.ts
	test/unit/outbound_fetch_tripwire.test.ts
	# SURF-2 (2026-09-30): the pinned single-call door, hermetic by seams (injected
	# lookup/socket, loopback peers). Verified DB-less (DB_PORT=59999): 26 pass / 0 fail.
	test/unit/guarded_text_pin_native.test.ts
	test/unit/strip_comments_tripwire.test.ts
	test/unit/private_state_mode_tripwire.test.ts
	test/unit/wire_disclosure_tripwire.test.ts
	test/unit/archive_precheck_native.test.ts
	test/unit/export_download_safety_tripwire.test.ts
	test/unit/url_sink_allowlist_tripwire.test.ts
	test/unit/client_action_outcome_tripwire.test.ts
	test/unit/component_build_wedge_tripwire.test.ts
	test/unit/stack_ops_policy_tripwire.test.ts
	test/unit/client_relation_move_native.test.ts
	test/unit/tool_lossless_writeback_tripwire.test.ts
	test/unit/ws_a_tripwires.test.ts
	test/unit/update_ownership_tripwire.test.ts
	# Release identity gate 9 (2026-10-15): transpile + flow scan of src/, tools/*/server and the
	# client, no DB. Verified DB-less (DB_PORT=59999).
	test/unit/release_identity_separation_tripwire.test.ts
	test/unit/install_restart_supervisor_tripwire.test.ts
	test/unit/ci_workflow_tripwire.test.ts
	test/unit/backup_restorability_native.test.ts
	test/unit/deploy_env_contract_tripwire.test.ts
	test/unit/catalog_behaviour_tripwire.test.ts
	test/unit/tier_execution_tripwire.test.ts
	test/unit/tier_file_order_tripwire.test.ts
	test/unit/tier_assignment_tripwire.test.ts
	test/unit/docs_current_engine_tripwire.test.ts
	test/unit/docs_versioning_tripwire.test.ts
	test/unit/docs_manual_install_tripwire.test.ts
	test/unit/css_build_tripwire.test.ts
	test/unit/css_token_duplication_tripwire.test.ts
	test/unit/wire_contract_tripwire.test.ts
	test/unit/change_log_tripwire.test.ts
	test/unit/verify_selector_selftest.test.ts
	test/unit/build_context_secret_tripwire.test.ts
	test/unit/vendor_advisory_tripwire.test.ts
	test/unit/palette_axis_parity_tripwire.test.ts
	test/unit/css_corpus_tripwire.test.ts
	test/unit/colour_literal_ratchet_tripwire.test.ts
	test/unit/breakpoint_record_tripwire.test.ts
	test/unit/crap_complexity_ratchet.test.ts
	test/unit/read_door_acl_tripwire.test.ts
	test/unit/action_scope_binding_tripwire.test.ts
	# --- security tier, added 2026-08-03 (see the coverage-hole note above) ---
	test/unit/xss_csp_tripwire.test.ts
	test/unit/error_report_xss_tripwire.test.ts
	test/unit/security_audit_2026_07_23_tripwire.test.ts
	test/unit/no_remote_code_tripwire.test.ts
	test/unit/agent_egress_tripwire.test.ts
	test/unit/human_write_scope_tripwire.test.ts
	test/unit/rag_index_scope_tripwire.test.ts
	test/unit/local_db_stores_tripwire.test.ts
	test/unit/no_install_surface_tripwire.test.ts
	# --- static-scan tier, same change: DB-less and previously ungated ---
	test/unit/config_census_tripwire.test.ts
	test/unit/config_docs_tripwire.test.ts
	test/unit/labels_tripwire.test.ts
	test/unit/tool_header_contract_tripwire.test.ts
	test/unit/tool_phone_tripwire.test.ts
	test/unit/tool_color_contrast_tripwire.test.ts
	test/unit/dataframe_scan_coverage_tripwire.test.ts
	test/unit/diffusion_scope_tripwire.test.ts
	test/unit/diffusion_queue_stream_tripwire.test.ts
	test/unit/hierarchy_single_writer_tripwire.test.ts
	test/unit/ontology_single_writer_tripwire.test.ts
	test/unit/client_caller_chain_tripwire.test.ts
	test/unit/generic_tld_tripwire.test.ts
	# 2026-10-25: AST census of predictable temp paths + the scratch helper RUN
	#     (mkdtemp under the OS temp dir). No config, no DB: verified DB-less (DB_PORT=59999).
	test/unit/predictable_tmp_tripwire.test.ts
	# 2026-10-25: AST census — tag scans / chained &amp; decodes only in html_text.ts.
	#     Pure source scan: no config, no DB.
	test/unit/html_text_tripwire.test.ts
	# --- 2026-08-24: the 53 gates that ran on NO executing tier. Each entry below
	#     was classified by reading its import closure (dynamic imports included)
	#     and then EMPIRICALLY re-verified with DB_PORT closed: 343 pass / 0 fail.
	#     The 19 that genuinely need Postgres carry a written reason in
	#     test/unit/ci_workflow_tripwire.test.ts NOT_HERMETIC -- rule 3c.
	#     KNOWN SKIPS, named rather than silent: oracle_canary skips its 2
	#     live-oracle legs -- ORACLE_MODE defaults to fixtures -- and
	#     parity_baseline_tripwire skips 5 legs behind DEDALO_PARITY_DRIFT — so
	#     the latter buys its parser/planted self-tests here, NOT the drift
	#     ratchet, which stays in `bun run scripts/parity_baseline.ts --check`.
	test/parity/oracle_canary.test.ts
	test/unit/external_secret_confinement_tripwire.test.ts
	test/unit/install_table_write_tripwire.test.ts
	test/unit/media_job_target_tripwire.test.ts
	test/unit/parity_baseline_tripwire.test.ts
	test/unit/twin_map_tripwire.test.ts
	test/unit/runtime_paths_census_tripwire.test.ts
	# --- 2026-08-25: the timeout single-source gate. DB-free (file scans + one import of
	#     scripts/lib/test_flags.ts); hermetic is its ONLY executing tier by design — it is
	#     the gate the --timeout=30000 literal comment below promises, keeping every copy
	#     (this script included) equal to TEST_TIMEOUT_MS.
	test/unit/test_timeout_tripwire.test.ts
	# --- 2026-08-25: the Phase 1/2 test-infrastructure gates. Empirically verified
	#     DB-less (DB_HOST=127.0.0.1 DB_PORT=59999: 20 pass / 0 fail). All three are
	#     fs-only: the baseline gate reads engineering/test_baseline/ (loud skip when
	#     absent, so it earns its schema/ratchet checks the day the campaign artifacts
	#     land), the two census gates read tracked test source through
	#     scripts/lib/test_components.ts.
	test/unit/test_baseline_tripwire.test.ts
	test/unit/scratch_tld_uniqueness_tripwire.test.ts
	test/unit/corpus_scope_ownership_tripwire.test.ts
	# --- 2026-08-25: the Phase 3 shard-partition gate. Plan-only by construction
	#     -- no clone, no child process, no byte written; pure computation over
	#     bun's own discovery, the test_components census and the footprint
	#     classifier. Empirically verified DB-less (DB_HOST=127.0.0.1 DB_PORT=1:
	#     21 pass / 0 fail). Its sibling dbread_role_tripwire is NOT here: with
	#     no database it is 100% skip, i.e. vacuous -- it runs on the DB tier.
	test/unit/shard_partition_tripwire.test.ts
	test/unit/tool_permission_census_tripwire.test.ts
	test/unit/client_error_contract_tripwire.test.ts
	test/unit/sw_tombstone_tripwire.test.ts
	test/unit/date_flat_value_single_source_tripwire.test.ts
	test/unit/error_throw_ratchet.test.ts
	test/unit/log_section_policy_tripwire.test.ts
	test/unit/password_cost_tripwire.test.ts
	test/unit/section_id_int_tripwire.test.ts
	test/unit/tool_picker_wiring_tripwire.test.ts
	test/unit/client_libs_tripwire.test.ts
	test/unit/dependency_integrity_tripwire.test.ts
	test/unit/external_client_render_tripwire.test.ts
	test/unit/external_outbound_tripwire.test.ts
	test/unit/maintenance_widget_get_value_tripwire.test.ts
	test/unit/media_writer_discipline_tripwire.test.ts
	test/unit/proxy_trust_tripwire.test.ts
	test/unit/client_serving.test.ts
	test/unit/docs_locator_shape_tripwire.test.ts
	test/unit/external_config_narrowing_census.test.ts
	test/unit/external_registry_totality_tripwire.test.ts
	test/unit/ip_allowlist.test.ts
	test/unit/migration_shared_row_tripwire.test.ts
	test/unit/release_archive_tripwire.test.ts
	test/unit/release_root_entries_tripwire.test.ts
	test/unit/thesaurus_picker_tripwire.test.ts
	test/unit/config_declaration_tripwire.test.ts
	test/unit/engine_install_tld_tripwire.test.ts
	test/unit/install_seed_drift_tripwire.test.ts
	test/unit/install_seed_manifest_tripwire.test.ts
	test/unit/media_alternate_versions_tripwire.test.ts
	test/unit/mock_isolation_tripwire.test.ts
	# --- 2026-08-29: the engine↔site-builder pairing proof. DB-free by construction: a
	#     loopback Bun.serve plays the daemon, the config module is mock.module'd, and the
	#     only other reads are source files (the daemon package's two modules included).
	test/unit/site_builder_pairing_tripwire.test.ts
	# --- 2026-08-30: the SECOND-CENSUS ratchet. DB-free for the same reasons: it reads
	#     tracked source through scripts/lib/site_builder_census.ts, runs the two
	#     fingerprint spellings against each other in-process, and drives the provisioner's
	#     renderer + observer over a mkdtemp scratch host it removes again.
	test/unit/site_builder_single_source_tripwire.test.ts
	# --- 2026-08-30: the operator's procedures are EXECUTABLE. DB-free: it reads docs,
	#     the CLI's verb table and the daemon's config schema, and RUNS the site-builder
	#     backup script over a mkdtemp host it removes again. Needs rsync, which the
	#     hermetic image already has (store 3 of the backup set uses it too).
	test/unit/operator_commands_tripwire.test.ts
	# --- 2026-09-02 (audit 2026-08-26 closure, batch 1). DB-free: they read the tree,
	#     the workflows, package.json and the two red baselines, build scratch git
	#     repos / scratch baselines / planted corpora under mkdtemp, and spawn only
	#     `bun` over those. rag_drain_cli_native is here ON PURPOSE: its order leg
	#     (usage error exits BEFORE ensureRagQueueTable) is observable only where no
	#     database answers, so the unit tier alone would let that mutation stay green.
	test/unit/tier_wiring_tripwire.test.ts
	test/unit/update_drill_config_tripwire.test.ts
	test/unit/production_entrypoint_coverage_tripwire.test.ts
	test/unit/rag_drain_cli_native.test.ts
	test/unit/suite_assertion_floor_tripwire.test.ts
	test/unit/client_gate_inventory_tripwire.test.ts
	test/unit/authz_substring_gate_tripwire.test.ts
	test/unit/census_derivation_tripwire.test.ts
	test/unit/write_obligations_tripwire.test.ts
	test/unit/value_law_agreement_tripwire.test.ts
	test/unit/reconcile_registry_tripwire.test.ts
	# D5 reconcile widget sentences: pure client helpers + a source pin. Verified DB-less
	# (DB_HOST=127.0.0.1 DB_PORT=59999): 4 pass / 0 fail.
	test/unit/reconcile_status_client.test.ts
	test/unit/diffusion_seed_vocabulary_tripwire.test.ts
	test/unit/archive_docs_claim_tripwire.test.ts
	test/unit/production_import_tripwire.test.ts
	test/unit/render_escape_tripwire.test.ts
	test/unit/site_builder_csp_tripwire.test.ts
	test/unit/client_limit_zero_tripwire.test.ts
	test/unit/client_render_budget_native.test.ts
	test/unit/client_prototype_contract_tripwire.test.ts
	test/unit/client_dead_reference_tripwire.test.ts
	test/unit/client_control_naming_tripwire.test.ts
	test/unit/client_a11y_budget_tripwire.test.ts
	test/unit/client_keyboard_activation_tripwire.test.ts
	test/unit/client_map_node_icon_tripwire.test.ts
	test/unit/contrast_ratio_tripwire.test.ts
	test/unit/publication_bounds_tripwire.test.ts
	test/unit/sitebuilder_path_confinement_tripwire.test.ts
	test/unit/agent_confinement_tripwire.test.ts
	test/unit/rqo_scalar_bound_tripwire.test.ts
	test/unit/store_retention_tripwire.test.ts
	test/unit/magick_policy_tripwire.test.ts
	test/unit/job_lane_census_tripwire.test.ts
	test/unit/sync_io_on_request_path_tripwire.test.ts
	test/unit/queue_fence_tripwire.test.ts
	test/unit/query_tap_tripwire.test.ts
	test/unit/read_path_record_reuse_tripwire.test.ts
	test/unit/search_pattern_escape_tripwire.test.ts
	test/unit/closure_openquestions_tripwire.test.ts
	test/unit/client_dashboard_sink_tripwire.test.ts
	test/unit/client_event_manager_dispatch_tripwire.test.ts
	test/unit/client_instances_inflight_tripwire.test.ts
	test/unit/client_local_db_singleton_tripwire.test.ts
	test/unit/client_read_stream_release_tripwire.test.ts
	test/unit/client_request_coalescing_tripwire.test.ts
	test/unit/ontology_property_census_tripwire.test.ts
	test/unit/zip_encoder_census_tripwire.test.ts
	# leg 1, the helper's DB outcome, SKIPS here via DB_READY; leg 2, the source scan, runs.
	test/unit/diffusion_scratch_tables_tripwire.test.ts
	# --- 2026-09-26: the pre-push / bank / ci:local gates. DB-free by construction: scratch
	#     git repos and planted ratchets under the OS temp dir, a fake `docker` on PATH,
	#     stub scripts, and the hermetic ratchets' own read-only `--check --json` runs.
	#     Empirically verified DB-less (DB_HOST=127.0.0.1 DB_PORT=59999: 131 pass / 0 fail).
	#     Here they block on the first push leg; the unit tier runs them again (blocking
	#     since 2026-10-02) on the db tier.
	test/unit/baseline_registry_tripwire.test.ts
	test/unit/baselines_bank_native.test.ts
	test/unit/ci_local_native.test.ts
	test/unit/pre_push_gate_native.test.ts
	# --- 2026-09-30 (LEAD-1 review r2): the daemon/engine address-classifier differential.
	#     DB-free: pure classifier calls over both sides' exported tables; measured with
	#     DB_PORT=1 (6/6 pass before the S3 table export, 7/7 after).
	test/unit/site_builder_public_address_differential.test.ts
	# --- 2026-10-01 (PERF-2/DIFF-4): the artifact peak-RSS gate. DB-free: a spawned child
	#     zips/merges files it writes under a MARKED scratch media root (~1.2 GiB temp disk,
	#     ~4 s); verified with the hermetic env (DB_HOST=127.0.0.1 DB_PORT=59999,
	#     DB_NAME=ci_hermetic_no_db: 3 pass / 0 fail).
	test/unit/diffusion_artifact_rss_native.test.ts
	# --- 2026-10-02 (plan item 5): the client-lib versions doc byte-identity gate. DB-free:
	#     reads package.json + the doc, imports the client-lib registry, renders in memory.
	test/unit/client_lib_versions_doc_tripwire.test.ts
	# --- 2026-10-03 (publication host phase 2): the engine/agent pairing twin. DB-free: it
	#     imports four pairing recipes (node builtins + type-only imports at most), reads shipped
	#     code via test/helpers/shipped_text_corpus.ts narrowed to `git ls-files` (tracked only);
	#     no DB, no network, no ../private.
	test/unit/publication_host_pairing_tripwire.test.ts
	# --- 2026-10-03 (publication host phase 2): rules.apply's directive allowlist vs the
	#     engine's publication-host renderers. DB-free: it imports the agent's import-free
	#     directives.ts and the pure renderers (config.mediaDir only); no DB, no network.
	test/unit/publication_host_rules_allowlist_tripwire.test.ts
	# --- 2026-10-03 (publication host phase 3): the agent-channel door gate. DB-free: reads
	#     src/ + tools/ sources and three docs/gates, Babel AST only, imports no src/ module.
	test/unit/publication_host_door_tripwire.test.ts
	# --- 2026-10-03 (publication host phase 4, L4): the bundle writer/reader twin. DB-free: a
	#     mkdtemp scratch dir, `git ls-files` over tracked source, and a zero-dep import of the
	#     agent's reader (node: builtins only, no agent `bun install` needed).
	test/unit/publication_host_bundle_twin_tripwire.test.ts
	# --- 2026-10-03 (publication host phases 4–6): the spec's path/script references exist.
	#     DB-free: reads the spec and two package.json files, existsSync only; no network.
	test/unit/publication_host_spec_refs_tripwire.test.ts
	# --- 2026-10-04 (#125): the onnxruntime alignment gate. DB-free: reads the vendored
	#     transformers bundle, package.json and bun.lock; compares three version strings.
	test/unit/onnxruntime_alignment_tripwire.test.ts
	# --- 2026-10-08 (installer unification A1/A3 + C). DB-free (re-verified with DB_PORT
	#     closed): the pure plan module, plus persistConfig / the supervision reader /
	#     package.json scripts under a stub `bun`, each in a child over a mkdtemp private dir.
	test/unit/install_plan_parity_tripwire.test.ts
	test/unit/supervision_declaration_tripwire.test.ts
	# --- 2026-10-09 (installer unification A4/A5/A6). DB-free (re-verified with DB_PORT
	#     closed): the vendored oh.copy.gz + the seed parsed from the repo; the pure
	#     reference classifier and COPY codec; the manifest client against a LOOPBACK
	#     stand-in master (never the network); the closure over built zz catalogs.
	test/unit/vendored_ontology_closure_tripwire.test.ts
	test/unit/ontology_references_native.test.ts
	test/unit/ontology_manifest_native.test.ts
	test/unit/install_ontology_choice.test.ts
	#     + the offline archive of the vendored export (system tar into a mkdtemp dir;
	#     DB_HOST=127.0.0.1 DB_PORT=59999: 4 pass / 0 fail).
	test/unit/install_ontology_archive.test.ts
	# --- 2026-10-09 (installer unification D1–D4). DB-free (re-verified with DB_HOST=127.0.0.1
	#     DB_PORT=59999: 239 pass / 0 fail): the registry list and its generated copies, the
	#     Dockerfile parsed and its provenance RUN executed in scratch dirs, the release
	#     publisher and the host shell tools driven with stub docker/git/cosign/systemctl on
	#     PATH, the stacks parsed with compose interpolation, the client publisher and the
	#     channel CLI on mkdtemp dirs. No network, no daemon, no database.
	test/unit/image_registries_tripwire.test.ts
	test/unit/product_image_tripwire.test.ts
	test/unit/image_release_native.test.ts
	test/unit/image_source_tripwire.test.ts
	test/unit/client_publish_native.test.ts
	test/unit/install_sh_image_source.test.ts
	test/unit/image_update_script_native.test.ts
	test/unit/image_update_channel_native.test.ts
	test/unit/image_updater_host_native.test.ts
	test/unit/image_registries_docs_tripwire.test.ts
	# --- 2026-10-11 (terminal installer phase 1). DB-free (re-verified with DB_HOST=127.0.0.1
	#     DB_PORT=59999: 55 pass / 0 fail): the plan's validation table, the executor over a
	#     fake machine in a mkdtemp private dir, and the CLI spawned against an ABSENT database
	#     (refused before any write, or by the preflight with nothing written).
	test/unit/install_validation_upfront_tripwire.test.ts
	test/unit/install_run_files_secret_tripwire.test.ts
	# --- 2026-10-11 (READ-4 leg W, the wire page bound). DB-free (re-verified with
	#     DB_HOST=127.0.0.1 DB_PORT=59999 DB_NAME=ci_hermetic_no_db: 3 pass / 0 fail): parses
	#     hostile windows through rqoSchema for every action the dispatch registry lists.
	test/unit/wire_sqo_page_bound_native.test.ts
	# --- 2026-10-12 (terminal installer phase 2). DB-free (re-verified with DB_HOST=127.0.0.1
	#     DB_PORT=59999 DB_NAME=ci_hermetic_no_db: 112 pass / 0 fail): the screen model over the vendored
	#     catalogs + a mkdtemp local ontology fixture, the plain mode under a scripted prompter
	#     and over fake terminal streams, the probe client over a recording spawn seam, and the
	#     CLI spawned with a piped stdin (refused before any read or write).
	test/unit/install_screen_model_tripwire.test.ts
	test/unit/install_plain_parity_tripwire.test.ts
	test/unit/install_plain_secrets_tripwire.test.ts
	# --- 2026-10-12 (terminal installer phase 3, the OpenTUI full-screen UI). DB-free (re-verified
	#     with DB_HOST=127.0.0.1 DB_PORT=59999 DB_NAME=ci_hermetic_no_db: 79 pass / 0 fail with the
	#     frames + executor-events gates): OpenTUI's test renderer driven by keys, the UI on a real
	#     PTY (Bun.spawn terminal; sh + stty), the CLI spawned with a scratch private dir, and the
	#     native package from `bun install --frozen-lockfile` (absent = RED, never skipped).
	test/unit/install_tui_parity_tripwire.test.ts
	test/unit/install_tui_secrets_tripwire.test.ts
	test/unit/install_tui_restore_tripwire.test.ts
	test/unit/opentui_confinement_tripwire.test.ts
	# --- 2026-10-12 (terminal installer phase 4, the host steps). DB-free (re-verified with
	#     DB_HOST=127.0.0.1 DB_PORT=59999 DB_NAME=ci_hermetic_no_db): every production and
	#     docker/trial host step through the real executor over a MARKED scratch root with the
	#     RECORDING runner (no apt/dnf, systemctl, useradd, certbot, docker or web-server reload
	#     executes), the kill/resume drill in child processes under the same seam, pure renders,
	#     the CLI spawned under the seam with a module-registry dump, and install.sh run under sh
	#     with stub uname/curl and zip/tar fixtures. + 2026-10-12 (install folder / service
	#     account): install_host_identity_native, the same scratch seam and fake account table
	#     (re-verified DB-less with the five host gates above it: 171 pass / 0 fail).
	test/unit/install_host_steps_native.test.ts
	test/unit/install_host_resume_drill.test.ts
	test/unit/install_host_render_tripwire.test.ts
	test/unit/install_host_privilege_tripwire.test.ts
	test/unit/install_host_selinux_native.test.ts
	test/unit/install_host_identity_native.test.ts
	test/unit/install_stack_steps_native.test.ts
	# --- 2026-10-13 (install campaign 3, the docker/trial stack's own files): pure renders,
	#     the stack files parsed, openssl-minted chains; its Docker checks skip, named, where
	#     no daemon answers (re-verified with DB_HOST=127.0.0.1 DB_PORT=59999).
	test/unit/install_stack_nginx_native.test.ts
	# --- 2026-10-14 (install campaign 3c, the flow and its words): the scripted session, pure
	#     renders, one PTY run of the plain installer quitting at its first question.
	test/unit/install_flow_campaign3c_native.test.ts
	# --- 2026-10-14 (install campaign 3c, production-manual): the production pages against
	#     the code that decides each fact — pure reads.
	test/unit/install_production_docs_native.test.ts
	# --- 2026-10-13 (install campaign 3, the developer route's tooling): pure option/argv
	#     builders, a fake password-demanding server, the dev listener; its suite-DB leg
	#     skips, named, without Postgres (re-verified with DB_HOST=127.0.0.1 DB_PORT=59999).
	test/unit/test_tooling_socket_native.test.ts
	test/unit/install_bootstrap_sh.test.ts
	# --- 2026-10-17 (section list toolbar, phone tier). DB-free: source scans of two
	#     stylesheets and two client view modules, comments stripped; no import, no DOM.
	test/unit/section_toolbar_phone_tripwire.test.ts
	# --- 2026-10-20 (installer launcher). DB-free: an import-graph scan and the real
	#     launcher in scratch trees with a stub installer body.
	test/unit/install_launcher_native.test.ts
	# --- 2026-10-21 (audit 2026-09-26 G9). DB-free: spawns git and the root tsc over
	#     each publication/ daemon package's tsconfig (--listFilesOnly).
	test/unit/daemon_typecheck_scope_tripwire.test.ts
	# --- 2026-10-21 (audit 2026-09-26 S2-1, target-lock census). DB-free: a babel
	#     parse of the write-path corpus and a planted corpus; imports no src/ module
	#     (re-verified with DB_HOST=127.0.0.1 DB_PORT=59999).
	test/unit/target_lock_census_tripwire.test.ts
	# --- 2026-10-21 (audit 2026-09-26 cross-ops:r2, psql matrix-writer census). DB-free:
	#     a text scan of the write-path corpus + an import of each declaring module for
	#     its exported record (re-verified with DB_HOST=127.0.0.1 DB_PORT=59999).
	test/unit/psql_matrix_write_obligations_tripwire.test.ts
	# --- 2026-10-22 (audit 2026-09-26 cross-write:r3, advisory-lock class census).
	#     DB-free: a text scan of src/, tools/, scripts/ + planted controls; imports
	#     no src/ module (re-verified with DB_HOST=127.0.0.1 DB_PORT=59999).
	test/unit/advisory_lock_class_tripwire.test.ts
	# --- 2026-10-23 (psql argv census). DB-free: a text scan of src/ + planted
	#     controls; imports no src/ module (re-verified with DB_HOST=127.0.0.1 DB_PORT=59999).
	test/unit/psql_argv_sql_tripwire.test.ts
	test/unit/hermetic_parallel_safety_tripwire.test.ts
)

# THE SERIAL LANE — tripwires that cannot share the machine with another test file, run
# alone after the parallel batch (see the tripwire stage). Each entry says WHAT it shares.
# Every entry is ALSO in HERMETIC_TRIPWIRES (the stage refuses one that is not). Moving a
# file here is a scheduling decision with a reason, never a way to quieten a flake: fix
# the file to stop sharing, then delete its line.
HERMETIC_SERIAL_LANE=(
	# Plants zz_lint_scope_probe.ts INSIDE every MUST_BE_LINTED repo dir and lints it:
	# biome's scope is path-based, and its stdin mode neither names the rule nor honours
	# the excludes (measured 2026-10-21), so the probe must exist on disk. A tree-walking
	# gate in a sibling worker read it mid-delete (ENOENT, the first --parallel run).
	test/unit/lint_scope_tripwire.test.ts
)

echo "== hermetic: bun install (frozen lockfile)"
bun install --frozen-lockfile

# THE TREE A TEST LEAVES BEHIND (2026-10-21). With the tripwires in parallel workers a
# file that writes into the checkout races every gate that walks it, and one that leaves
# its scratch there poisons the next run. Snapshot what git sees now (untracked included,
# ignored excluded — node_modules and the daemons' .test-tmp are ignored on purpose) and
# hold the tier to the same picture at the end. `git` is absent on GitLab's oven/bun
# until the daemon block installs it, so a missing git snapshots nothing and checks nothing.
tree_checked=0
if command -v git >/dev/null 2>&1; then tree_before="$(git status --porcelain --untracked-files=all)"; tree_checked=1; fi

# The site-builder daemon (publication/site_builder) is its own package with a fully
# hermetic suite: no DB, no oracle, no ../private — its tests run against a repo-local
# .env.test and scratch directories. Without this block NOTHING mechanical runs it
# (verify.ts neighbours only scan src/ + test/), so its invariants (bearer auth, promote
# atomicity, session single-flight) could rot silently.
#
# Its workspace tests shell out to the REAL `git` binary (per-site rollback substrate,
# src/sites/git.ts). GitHub's ubuntu runner ships git; GitLab runs this same script
# inside oven/bun (debian-slim, NO git) — every workspace-creating test dies on the
# spawn while the git-free ones pass (the 28-pass/22-fail signature, 2026-07-18).
# Install it when absent so the two platforms cannot drift on this gate.
if ! command -v git >/dev/null 2>&1; then
  echo "== hermetic: installing git (absent on this runner)"
  apt-get update -qq && apt-get install -y -qq git >/dev/null
fi
# Run one isolated daemon package's gate, and NAME the failure.
#
# NO --timeout HERE, DELIBERATELY. The root suite gets it because it LOST a number it had
# chosen: bunfig.toml declared `[test] timeout = 30000` and Bun 1.4.0 silently ignored it.
# These packages never made that claim: EVERY daemon bunfig.toml declares coverage (and,
# where enforced, coverageThreshold) and no timeout, so their green baselines were measured
# under bun's built-in 5000 ms cap and stay comparable run to run.
# (Corrected 2026-08-31, P2-23/GATE-43: this said publication/site_builder had NO
# bunfig.toml at all, while eleven lines below the same file said "Both daemons set
# coverageThreshold in their bunfig.toml" and the diagnostic below greps that file. One of
# the two had to be false; it was this one, and the package's coverage was measured by
# nothing. It now has the bunfig its sibling has, at the same 0.8 floor.) Widening them on no evidence would be silently loosening a gate, not restoring one.
# Same reasoning, same wording, at the other exempt sites: the site_builder and host_agent
# stages in scripts/verify.ts.
#
# A daemon that ENFORCES sets `coverageThreshold` in its bunfig.toml (server_api/v2 and
# host_agent; site_builder only reports — ci_workflow_tripwire rule 11), and a miss makes
# `bun test` exit 1 while printing NOTHING about coverage — the log reads
# "290 pass / 0 fail" followed by a bare "exit code 1", which is indistinguishable from
# a crash and sent one CI failure (2026-08-03) round several wrong hypotheses. Bun does
# not say it, so this script does: every test passing plus a non-zero exit IS the
# coverage gate, and the table it printed is right above the message.
daemon_gate() {
	local dir="$1"
	local log
	# PORTABLE TEMPLATE, not `mktemp -t NAME`. BSD/macOS accepts a bare suffix there;
	# GNU coreutils demands the XXXXXX placeholder and dies with "too few X's in
	# template" — so the developer-machine form passed locally and broke the Linux
	# runner on the first run (2026-08-03). An explicit template satisfies both.
	log="$(mktemp "${TMPDIR:-/tmp}/dedalo_daemon_gate.XXXXXX")"
	if (cd "$dir" && bun install --frozen-lockfile && bunx tsc --noEmit && bun test) 2>&1 | tee "$log"; then
		rm -f "$log"
		return 0
	fi
	# `tee` is last in the pipe, so consult bun's own status, not tee's.
	if grep -qE '^ +0 fail' "$log"; then
		echo ""
		echo "== hermetic: RED in $dir — every test PASSED but the run exited non-zero."
		echo "   That is the bunfig.toml coverageThreshold: bun exits 1 and prints no reason."
		echo "   The per-file table above shows which file fell below it (thresholds:"
		grep -E 'coverageThreshold' "$dir/bunfig.toml" | sed 's/^/     /'
		echo "   Fix by TESTING the uncovered code, not by lowering the threshold."
	fi
	rm -f "$log"
	return 1
}

# THE DAEMON PACKAGES RUN CONCURRENTLY (the set is DERIVED and held by ci_workflow_tripwire
# rule 15: every locked package with its own bunfig.toml), and this is where the tier's minutes
# actually are: each does its OWN `bun install --frozen-lockfile` (separate
# lockfiles) plus its own tsc and its own suite. They share no state — separate
# directories, separate node_modules, separate bunfig, no database, no ../private
# — so nothing orders them.
#
# AND THEY START HERE, BEFORE TYPECHECK, not after the tripwires (2026-10-21). They
# touch nothing the root stages read, so running them last only appended their wall
# clock (site_builder alone: 78 s measured) to the tier's. In the background they ride
# under the parallel tripwire batch (~110 s on the desk); the waits and the three
# verdicts stay at the END, unchanged.
#
# Bash background jobs rather than `bun run --parallel`: that flag runs
# package.json SCRIPTS, and daemon_gate() is a shell function carrying the
# coverageThreshold diagnostic (a threshold miss makes `bun test` exit 1 while
# printing NOTHING about coverage — the log reads "290 pass / 0 fail" then a bare
# exit 1). Moving these into package.json scripts to reach the flag would throw
# that diagnostic away to use a mechanism that buys the same concurrency.
#
# EVERY ONE IS ALWAYS WAITED ON AND EVERY VERDICT IS REPORTED: `set -e` must not
# abort on the first failure here, or one red daemon would hide the others'
# result — the same reason --no-exit-on-error is used for typecheck+lint below.
echo "== hermetic: daemon packages, concurrently in the background (site_builder + publication API v2 + publication-host agent) — verdicts at the end"
daemon_status=0

# Per-job logs come from mktemp (fresh, 0600, O_EXCL), the same pattern daemon_gate() uses:
# a predictable `/tmp/name.$$` redirect follows a pre-planted symlink (truncates whatever
# file it points at) and can be pre-created world-readable (the agent suite prints test
# bearer/pairing material). ci_workflow_tripwire rule 15 holds the mktemp shape.
sb_log="$(mktemp "${TMPDIR:-/tmp}/dedalo_daemon_sb.XXXXXX")"
pa_log="$(mktemp "${TMPDIR:-/tmp}/dedalo_daemon_pa.XXXXXX")"
ha_log="$(mktemp "${TMPDIR:-/tmp}/dedalo_daemon_ha.XXXXXX")"

daemon_gate publication/site_builder > "$sb_log" 2>&1 &
sb_pid=$!
daemon_gate publication/server_api/v2 > "$pa_log" 2>&1 &
pa_pid=$!
daemon_gate publication/host_agent > "$ha_log" 2>&1 &
ha_pid=$!

# TYPECHECK AND LINT RUN CONCURRENTLY (Bun 1.4 `bun run --parallel`).
#
# They are whole-tree, independent and read-only, so nothing orders them; running
# them one after the other simply added their wall clocks. MEASURED on this tree:
# 1.76s together at 709% CPU, against the sum of two sequential passes.
#
# `--no-exit-on-error` is NOT a way of ignoring failures — MEASURED both ways on
# Bun 1.4.0: with it and without it, a failing script still makes the run exit 1.
# What it changes is that the OTHER script is allowed to finish first, so a red
# lint can no longer hide a red typecheck by aborting before it runs.
#
# THE STAGES ARE INDEPENDENT (audit 2026-08-26, GATE-03). This stage no longer
# aborts the tier: under `set -e` a red lint meant the tripwire block below
# NEVER EXECUTED, so a formatting error silently disarmed all 101 invariant
# gates — measured on a tree where lint had been red for 45 commits. Each stage
# now records its own verdict and the tier reports every one of them, so a red
# lint costs you a red tier and nothing else.
#
# Both are package.json scripts because `bun run --parallel` runs SCRIPTS, not
# arbitrary commands (it is the script runner; the test runner's own worker
# parallelism is the unrelated `bun test --parallel=N`).
echo "== hermetic: typecheck + lint + browser-lint budget (bun run --parallel)"
tier_status=0
bun run --parallel --no-exit-on-error typecheck lint lint:browser || {
	tier_status=$?
	echo "== hermetic: RED in typecheck/lint (exit $tier_status) — continuing so the tripwire tier still reports"
}

echo "== hermetic: static tripwires (${#HERMETIC_TRIPWIRES[@]})"
# --timeout=30000 is a LITERAL COPY of TEST_TIMEOUT_MS in scripts/lib/test_flags.ts, which
# is the source of truth; a shell script cannot import it, and a `bun -e` readback would add
# a bun subprocess to every CI tier for a copy that would still exist. A tripwire gate keeps
# this literal in step with the constant. It is on the command line and not in bunfig.toml
# because Bun 1.4.0 SILENTLY IGNORES `[test] timeout` (measured: 5001.50 ms kill on an 8 s
# test), which is how the repo ran its whole history under a 5000 ms cap nobody chose.
tw_rc=0
# Sorted `./` paths, never the bare array: a bare name is a bun FILTER run in readdir
# order (per host). scripts/ci/test_order.sh; gate: tier_file_order_tripwire.
#
# THE FILES RUN IN PARALLEL WORKERS (2026-10-21) — every one of them, unselected. One
# serial `bun test` over this list was 513 s of a ~10 min tier; `--parallel` (one worker
# per core, each file in a fresh global: `--isolate` is implied, so a cross-file
# mock.module leak is impossible here, which the single process never guaranteed) ran
# the same files in 124 s on 8 workers. `--timings` only ORDERS the work (slowest file
# first); a stale or missing entry changes the wall clock, never a verdict. Refresh it
# when the list moves: the command is in engineering/CI.md → Hermetic tier.
#
# A file that touches SHARED state (writes into the repo tree another file walks, a
# fixed path, a fixed port) cannot ride a worker: it runs in HERMETIC_SERIAL_LANE below,
# alone, after the batch, with its reason next to it. Every lane entry must also be a
# HERMETIC_TRIPWIRES entry — the lane re-schedules a gate, never adds or drops one.
#
# DEDALO_HERMETIC_SERIAL=1 runs the WHOLE list in one serial process (the pre-2026-10-21
# command). The nightly full gate sets it: a coupling the lane missed shows up as a
# parallel-green push and a serial-red night on the same sha.
order_test_paths "${HERMETIC_TRIPWIRES[@]}" || tw_rc=$?
hermetic_parallel=()
hermetic_serial=()
for path in "${TEST_ORDER_PATHS[@]}"; do
	if printf '%s\n' ${HERMETIC_SERIAL_LANE[@]+"${HERMETIC_SERIAL_LANE[@]}"} | grep -qxF "${path#./}"; then
		hermetic_serial+=("$path")
	else
		hermetic_parallel+=("$path")
	fi
done
if [ "${#hermetic_serial[@]}" -ne "${#HERMETIC_SERIAL_LANE[@]}" ]; then
	echo "== hermetic: HERMETIC_SERIAL_LANE names a file that is not a HERMETIC_TRIPWIRES entry (or names one twice)"
	tw_rc=1
fi
if [ "${DEDALO_HERMETIC_SERIAL:-0}" = 1 ]; then
	echo "   DEDALO_HERMETIC_SERIAL=1 — all ${#TEST_ORDER_PATHS[@]} files in ONE serial process"
	bun test --timeout=30000 "${TEST_ORDER_PATHS[@]}" || tw_rc=$?
else
	echo "   ${#hermetic_parallel[@]} files in parallel workers, then ${#hermetic_serial[@]} in the serial lane"
	TEST_ORDER_PATHS=("${hermetic_parallel[@]}")
	bun test --timeout=30000 --parallel --timings=engineering/hermetic_timings.json "${TEST_ORDER_PATHS[@]}" || tw_rc=$?
	# Guarded: an EMPTY lane is the goal, and `bun test` with no path discovers the whole
	# test root (and bash 3.2 under `set -u` dies expanding an empty array).
	if [ "${#hermetic_serial[@]}" -gt 0 ]; then
		TEST_ORDER_PATHS=("${hermetic_serial[@]}")
		bun test --timeout=30000 "${TEST_ORDER_PATHS[@]}" || tw_rc=$?
	fi
fi
[ "$tw_rc" -eq 0 ] || { echo "== hermetic: RED in static tripwires (exit $tw_rc)"; tier_status=1; }

# THE DEBT LEDGER, APPEND-ONLY AGAINST HISTORY (P2-18 / GATE-22). The crap
# ratchet's artifact carries its own ledger and the static tripwires above hold
# every line to its rule; a REWRITTEN line, or a per-file entry raised with the
# counters flat, shows only against the artifact as it stood at a reference
# commit. This checkout is shallow, so the reference is FETCHED, never assumed:
# on a pull request the base branch's tip (the checkout IS the merge of the PR
# onto that tip, so the tip is the merge-base); on a push, the first parent.
# A reference that cannot be resolved yields an EMPTY argument, which
# crap_baseline.ts refuses (proved in ratchet_integrity_tripwire) — red, never
# a comparison against the index. scripts/verify.ts's `crap:ledger` stage is
# the developer-desk twin (merge-base of HEAD and --base).
#
# The `|| CI_REFERENCE=""` is load-bearing: a bare `x="$(f)"` whose f fails
# EXITS under `set -e`, which would abort the tier here instead of handing the
# stage the empty value it already treats safely (crap_baseline refuses it).
crap_ledger_reference() {
	local target="${GITHUB_BASE_REF:-${CI_MERGE_REQUEST_TARGET_BRANCH_NAME:-}}"
	if [ -n "$target" ]; then
		git fetch --quiet --depth=1 origin "$target" >&2 || return 1
		git rev-parse --verify --quiet FETCH_HEAD || return 1
	else
		if ! git rev-parse --verify --quiet 'HEAD^' >/dev/null 2>&1; then
			git fetch --quiet --deepen=1 >&2 || return 1
		fi
		git rev-parse --verify --quiet 'HEAD^' || return 1
	fi
}
CI_REFERENCE="$(crap_ledger_reference)" || CI_REFERENCE=""
echo "== hermetic: crap ledger (append-only vs the reference${CI_REFERENCE:+ ${CI_REFERENCE:0:12}})"
cl_rc=0
bun run scripts/crap_baseline.ts --check --reference "$CI_REFERENCE" || cl_rc=$?
[ "$cl_rc" -eq 0 ] || { echo "== hermetic: RED in crap ledger (exit $cl_rc)"; tier_status=1; }

# THE AUDIT'S BASE IS THE WHOLE PUSH, NOT ITS TIP (2026-09-26). The dependency
# audit below skips when the change set carries none of its inputs, so its base
# must cover EVERY commit this run is the gate for. The crap ledger's push
# reference (HEAD^) does not: in a three-commit push whose lockfile bump sits in
# the first commit, HEAD^ already contains it, the diff HEAD^..HEAD is lockfile-
# free, and the stage SKIPPED — the bump reached master with its advisories
# unaudited until the next nightly. So the audit resolves its own base:
#   pull/merge request  CI_REFERENCE — the target tip, which the PR checkout is
#                       merged onto, so the diff is the whole PR.
#   explicit            DEDALO_CI_AUDIT_BASE — a caller that KNOWS the remote's
#                       state (the pre-push hook's remote sha, ci:local's host
#                       upstream) names it.
#   GitHub push         the event payload's `before` — the ref's tip before this
#                       push, i.e. every commit the push carries.
#   GitLab push         CI_COMMIT_BEFORE_SHA, the same fact.
#   a developer's desk  the merge-base with the branch's upstream: all unpushed work.
# A base that is absent, all zeros (a new branch; GitHub and GitLab both send
# that), not a hex sha, or unfetchable (force-pushed away) resolves to NOTHING,
# and audit.ts RUNS on an empty base — the only failure direction that is safe.
# Never a fallback to HEAD^: that is the defect this replaced.
audit_reference() {
	if [ -n "${GITHUB_BASE_REF:-${CI_MERGE_REQUEST_TARGET_BRANCH_NAME:-}}" ]; then
		[ -n "$CI_REFERENCE" ] || return 1
		printf '%s\n' "$CI_REFERENCE"
		return 0
	fi
	local before=""
	if [ -n "${DEDALO_CI_AUDIT_BASE:-}" ]; then
		before="$DEDALO_CI_AUDIT_BASE"
	elif [ "${GITHUB_EVENT_NAME:-}" = push ] && [ -r "${GITHUB_EVENT_PATH:-}" ]; then
		before="$(bun -e 'const e = await Bun.file(Bun.argv[1]).json(); console.log(typeof e?.before === "string" ? e.before : "")' "$GITHUB_EVENT_PATH")" || return 1
	elif [ -n "${CI_COMMIT_BEFORE_SHA:-}" ]; then
		before="$CI_COMMIT_BEFORE_SHA"
	else
		before="$(git rev-parse --verify --quiet '@{upstream}' 2>/dev/null)" || return 1
		before="$(git merge-base HEAD "$before")" || return 1
	fi
	case "$before" in '' | *[!0-9a-f]*) return 1 ;; esac
	case "$before" in *[!0]*) ;; *) return 1 ;; esac
	if ! git cat-file -e "${before}^{commit}" 2>/dev/null; then
		git fetch --quiet --depth=1 origin "$before" >&2 || return 1
	fi
	git rev-parse --verify --quiet "${before}^{commit}" || return 1
}
AUDIT_REFERENCE="$(audit_reference)" || AUDIT_REFERENCE=""

# Dependency advisories, as a RATCHET against engineering/dependency_audit_baseline.json:
# a NEW advisory is red, a known one is not (the tree already carried 7 on the day this
# was wired). Offline → skips loudly. Rationale in scripts/ci/audit.ts.
#
# THE STAGE THAT DISARMED THE TWO DAEMON GATES (2026-09-21). This line was
# `bun run scripts/ci/audit.ts` bare, so under `set -e` a red ratchet EXITED the
# tier right here — and the site_builder / server_api v2 block below, the only
# mechanical run those two packages get, executed NOTHING. Measured on master
# 625249c9 and on the run before it: 15 unaccepted advisories, and neither
# daemon's install/tsc/suite/coverageThreshold ran in either. That is the exact
# failure this script already narrates twice above (a red lint hiding a red
# typecheck; a red lint disarming 101 invariant gates), at the one stage that had
# not been given the treatment. Record the verdict, keep going, report it at the
# end with every other stage.
#
# RUN ONLY WHEN ITS INPUTS CHANGED (2026-09-26). The stage reads three things that
# move with the CALENDAR, not with a commit — the `bun audit` registry, the GitHub
# advisory feed and the vendored rows' review/acceptance windows — so on a push
# that touched none of its inputs, a red here could only say "the world changed
# overnight", and it said it to whoever pushed next. `--changed-since` makes
# audit.ts diff against AUDIT_REFERENCE (the whole push or PR, resolved above)
# and print `== audit: SKIPPED — <why>` (exit 0) unless a bun.lock, a package.json
# at any depth, vendor/ or a manifest root, or one of the audit's own inputs (its CODE
# derived from audit.ts's import closure: `auditCodeInputs`, never a hand list)
# changed. Unresolvable base → it RUNS. DEDALO_CI_FORCE_AUDIT=1 or a `schedule`
# event → it RUNS. The time-based half has its own home, every night:
# .github/workflows/nightly.yml (`audit.ts --force`, one `ci-nightly` issue). The
# DEC-12 ratchet itself — what is red when it runs — is unchanged.
echo "== hermetic: dependency audit ratchet (lockfile / vendor changes, or forced)"
da_rc=0
echo "   audit base: ${AUDIT_REFERENCE:-<none — the audit runs>}"
bun run scripts/ci/audit.ts --changed-since "$AUDIT_REFERENCE" || da_rc=$?
[ "$da_rc" -eq 0 ] || { echo "== hermetic: RED in the dependency audit ratchet (exit $da_rc)"; tier_status=1; }

echo "== hermetic: daemon packages — waiting on the jobs started before typecheck"

# `wait <pid>` returns the job's exit status; `|| rc=$?` keeps `set -e` from
# aborting before every other job has been waited on and reported.
sb_rc=0; wait "$sb_pid" || sb_rc=$?
pa_rc=0; wait "$pa_pid" || pa_rc=$?
ha_rc=0; wait "$ha_pid" || ha_rc=$?

# Dumping a log is REPORTING, never a verdict. In the CI image the container's stdout
# can turn non-blocking (a child sets O_NONBLOCK on the shared pipe), and a large dump
# then fails with EAGAIN ("cat: write error: Resource temporarily unavailable"). A bare
# `cat` under `set -e` aborted the tier there, before the three verdicts below were
# read — three green daemons reported as one red tier (2026-10-12). Retry the dump, and
# if stdout stays unwritable say so; the verdict stays the job's exit code.
dump_log() {
	dl_tries=0
	until cat "$1"; do
		dl_tries=$((dl_tries + 1))
		if [ "$dl_tries" -ge 5 ]; then
			echo "== hermetic: could not print $2's log (stdout not writable) — its verdict below is its exit code" || true
			break
		fi
		sleep 1
	done
	rm -f "$1"
}
echo "---- publication/site_builder ----"
dump_log "$sb_log" publication/site_builder
echo "---- publication/server_api/v2 ----"
dump_log "$pa_log" publication/server_api/v2
echo "---- publication/host_agent ----"
dump_log "$ha_log" publication/host_agent

[ "$sb_rc" -eq 0 ] || { echo "== hermetic: RED in publication/site_builder (exit $sb_rc)"; daemon_status=1; }
[ "$pa_rc" -eq 0 ] || { echo "== hermetic: RED in publication/server_api/v2 (exit $pa_rc)"; daemon_status=1; }
[ "$ha_rc" -eq 0 ] || { echo "== hermetic: RED in publication/host_agent (exit $ha_rc)"; daemon_status=1; }
# ONE exit, after EVERY verdict is in. `[ "$daemon_status" -eq 0 ] || exit 1`
# used to stand here on its own line, which meant a red daemon left the tier
# without its summary — the same hide-the-other-verdict shape the stages above
# are built to avoid. Fold it into the accumulator instead, and let the single
# exit below name every stage that can be red.
[ "$daemon_status" -eq 0 ] || tier_status=1
if [ "$tree_checked" -eq 1 ]; then
	tree_after="$(git status --porcelain --untracked-files=all)"
	if [ "$tree_after" != "$tree_before" ]; then
		echo "== hermetic: RED — the run changed the checkout (a test wrote into the repo tree and left it):"
		diff <(printf '%s\n' "$tree_before") <(printf '%s\n' "$tree_after") | sed 's/^/     /' || true
		echo "   Write scratch under mkdtemp(tmpdir()), or move the file to HERMETIC_SERIAL_LANE with its reason AND clean up."
		tier_status=1
	fi
fi
[ "$tier_status" -eq 0 ] || { echo "== hermetic: RED — see the stage verdicts above (typecheck/lint, static tripwires, crap ledger, dependency audit ratchet, daemon packages, checkout unchanged)"; exit 1; }

echo "== hermetic: GREEN"
