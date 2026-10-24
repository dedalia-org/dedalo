// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0

/**
 * TEST_REGISTRY
 * Single source of truth for client test suites and groups.
 *
 * Each suite maps to one iframe run (one Mocha file via frame_runner).
 * - area: JS module name under test/client/js/ (without .js)
 * - model: optional query param for parameterized suites (e.g. test_component_full)
 *
 * ── TS-rewrite migration tiering (see scripts/client_test_runner.ts (KNOWN_FAILING)) ─────────────────
 * These suites were ported verbatim from the PHP client. Against the TS server
 * they are enabled in WAVES as the corresponding server models/tools land
 * (Phase 6). Only migrated groups are pushed into `test_groups` below, so the
 * `run all` gate stays meaningful. The full inventory of every suite — migrated
 * AND deferred (with the reason) — lives in the coverage ledger scripts/client_test_runner.ts (KNOWN_FAILING);
 * nothing is silently dropped. To enable a wave, add its group to `test_groups`.
 *   Wave 1 (ACTIVE): generic infra + pure-unit suites
 *   Wave 2 (deferred): per-component life-cycle suites  → as models port
 *   Wave 3 (deferred): per-tool suites                  → as tools port
 */

import {elements} from './elements.js'

/**
 * Generic integration / infrastructure suites that pass against the TS server
 * today — the Wave 1 gate. (Split from the breadth-sweeping generic suites below,
 * which depend on Phase 6 component/model breadth; see scripts/client_test_runner.ts (KNOWN_FAILING).)
 */
export const generic_suites_green = [
	'test_key_instances',
	'test_get_instance',
	'test_delete_instance',
	'test_instances_lifecycle',
	'test_event_manager',
	'test_unsaved_guard',             // THE data-loss guard, per model: typing into an edit-mode field must arm window.unsaved_data BEFORE any commit/blur. Driven off elements.js so a new component model inherits the gate. Regression for the blur-committed views (component_input_text, component_date, select, …) that reached no registry until blur, so a reload dropped the typing with no prompt — component_text_area was immune only because it debounces on keystrokes.
	'test_events',                    // when_in_dom shared-observer gate: sync fast path + return forwarding, exactly-once deferred fire, multi-callback per node, drain→re-arm lifecycle, throw isolation, re-entrant registration (events.js JSDoc invariants)
	'test_components_activate',      // green after component fixes (was flaky, now stable 3/3)
	'test_components_data_changes', // green after save-response DataItem-shape fix (dispatch.ts)
	'test_no_logged_error',
	'test_unknown_error',
	'test_api_error',                 // THE client error model + transport (envelope v2 / transport class → ApiError code; the v1 mirror is never read; fetch_api retry keyed on retryable + Retry-After; data_manager.request failure contract). Backend-free: window.fetch stubbed and restored.
	'test_error_policy',              // the pure code → action table (exact → domain.* → *), bare v1 tokens are no longer aliases, additive registration that refuses core overrides; handle_api_error surfaces without a backend (relogin asserted NOT to open when not logged in).
	'test_render_api_error',          // the one renderer: label → ${param}/%s → message → code; XSS — every surface renders '<img onerror>' as TEXT; the panel always carries request_id; debug suffix only under SHOW_DEBUG.
	'test_client_xss_escapes',        // CodeQL alert 7930/alert 7940/alert 7941/alert 8032/alert 8033/alert 8105: a record/user value is TEXT at the vector_editor delete dialog, the search row label, the graph field text, the tool_transcription speaker dialog (people records) and every ui.confirm header (payload '<img onerror>' → no <img>, exact textContent); a __proto__ URL key / typed query never re-parents an object. Backend-free.
	'test_embedded_error_scope',      // page_globals.page_error is the PAGE's failure only: an embedded instance's refused build (an inspector dd15 block) never sets it — nor does the page's every-request api_error listener — while a page-root refusal does (control); with the slot set an embedded sibling (relation_list) still renders its own node, a page-root render gets the panel (control); SPA navigation clears the slot and the next element renders. Blocks 1-2 backend-free (data_manager.request patched); block 3 drives the real page on the suite server.
	'test_request_activity',          // the slow-server cue is ONE page state: N parallel slow data_manager.request calls publish 'slow' once and 'idle' when the last settles, with no notification bubble; background actions / busy_notice:false never feed it; the indicator paints idle/slow/very_slow (one sentence, role=status, idempotent mount); prepend_bubble merges identical bubbles into one ×N. Backend-free: window.fetch stubbed and restored.
	'test_relogin_identity',          // A QUEUED ACTION NEVER RESUMES AS ANOTHER USER (LEAD-2 + CLIENT-5): a real component save and a real build_autoload hit auth.not_logged, the real overlay is dispatched through login.action_dispatch as another user / without a user_id / on a page without one — zero re-sends, one reload (through error_dispatch's reload seam), the page identity latched so the next save sends nothing until the page's own user logs in; the same user resumes exactly once (positive controls). data_manager.request patched on the shared singleton for the case's saves and probe read only — the overlay's own context is real; nothing is written.
	'test_error_stream',              // streams reject with an ApiError (server code on a non-2xx envelope, client.* otherwise); read_stream's unparseable frame carries client.bad_response under `error`; normalize_stream_error on v2 frames (the v1 frame shape is not read). Backend-free.
	'test_process_status_open_failure', // update_process_status settles its caller when the status stream cannot be OPENED (fetch rejects / 403 envelope / 500 / 2xx without body): callback exactly once with a terminal frame carrying the coded failure, stated panel-local in the container (never page_error, never the page panel), no dangling reader; a clean stream is the control. Backend-free: window.fetch stubbed and restored.
	'test_page',
	'test_ts_object',
	'test_ts_object_extended',
	'test_render_budget',             // THE BROWSER MUST NOT BUILD WITHOUT BOUND (audit P2-31 / CLI-29 / CLI-30; bun half: test/unit/client_render_budget_native.test.ts): a 5,000-entry list page paints ≤ ROW_WINDOW_MAX_ROWS section_record rows, a thesaurus node with 5,000 children materializes ≤ that many, reveal keeps the bound, destroy stops the window; plus sqo_limit — the client ceiling is the SERVER's page_globals value and bound_sqo_limit never yields 0. List block on the real test3 section (suite DB) with synthetic entries; tree block mocks data_manager.request like test_ts_object.
	'test_component_common_changed_data',
	'test_component_common_update_datum',  // the response merge into the shared datum keeps the server's EMISSION ORDER for unseen data + context items (the backwards loop pushed them REVERSED: a rating frame child [edit+datalist, solved] became [solved, edit] after a tool_time_machine apply and the chip threw) and still updates matched items IN PLACE. Backend-free: the shipped function on a plain object.
	'test_section_record',           // the row engine between the section's shared datum and its children: the two child-build error paths (edit must not HANG on a rejected child; the list waiter must reset so a retry can rebuild) plus the whole backend-free surface — init defaults/double-init guard, get_component_data (identity tuple, stubs, section_group, component_dataframe id_key pairing ladder), get_component_info, the edit context filter (dataframe in/out by caller model) and the list column build (order, dedup, search ddo_map fallback, missing-context skip, one shared build pass, fixed_mode). Children are FAKE instances pre-registered under the exact key build_instance will ask for, so a built child PROVES the key contract — including the dataframe's `_<id_key>_<main_component_tipo>` id_variant, which is what makes the exclusion cases prove an absence rather than a cache miss.
	'test_section_list_header',      // THE LIST IS ONE GRID AND ITS HEADER IS ROW 1: `.header_wrapper_list`, `.content_data` and every `.section_record.list` are display:contents, so pagination's whole-node content_data swap re-runs the header row's intrinsic sizing. Pins the overflow law that keeps WebKit honest — `.head_column` (and its `.with_sub_header` re-declaration) must NOT clip the VERTICAL axis (`overflow-x: clip; overflow-y: visible`); with `overflow: hidden` WebKit keeps a wrong intrinsic row height and the header collapses to a sliver (measured 48.1px → 22.1/35.1px on oh1) while Chrome/Gecko are fine — plus the behaviour: after a swap with mixed-height rows the header is unclipped, not overlapping row 1, and still column-aligned, with the horizontal ellipsis intact. Backend-free synthetic grid on the real main.css in a 1200px fixture iframe (the suite frame is under the responsive breakpoint, where the header is hidden); the WebKit-only failure was reproduced and the fix verified in a WebKit probe.
	'test_open_related_data',         // the "open relationships" dialog's SQO scoping — the edit-mode found-set offset used to skip the single pinned row, so read_raw returned nothing and no window opened; backend-free (data_manager.request patched on the shared singleton)
	'test_ui_render_edit_modal',      // the per-cell edit modal's caller chain — the surface that makes component tools reachable from a section LIST (WC-059 sibling work); backend-free (fake instance pre-registered in the shared registry)
	'test_inspector_loading',         // THE inspector block-loading contract (load_block): the server-loaded blocks (relations, latest changes, component history) install the shared placeholder + spinner BEFORE the round trip resolves — they used to empty/dim an empty body and wait, which read as a hang on a busy server — and they do not load twice: an unchanged `key` reuses the DOM (or joins the in-flight load) while `reload:true` (save / section re-render / page turn) reloads, a failure is never remembered as loaded, and all three blocks show the SAME placeholder type size. Backend-free: the task is the caller's own promise.
	'test_inspector_record_info',     // the inspector's Created / Modified / Published rows load from their OWN request (dd_utils_api::get_record_info), never the section read: request shape, text-only fill (a user name is data), state line, per-record cache, a response for a record the inspector left is dropped. Backend-free (data_manager.request patched).
	'test_inspector_tm_access',       // the inspector history blocks follow the server's per-principal grant (context.config.time_machine_list, WC-2026-10-22-tm-scope-whole-request): null → no Latest changes / Component history block and no dd15 request; a refused build renders ONE quiet panel-local line (request_id in the tooltip) and never render()s the failed instance — never the page-level no-access panel. Backend-free (data_manager.request patched).
	'test_section_lock_cleanup',      // a read-only Time Machine list sends NO lock-state request on navigation (WC-2026-10-23-own-lock-cleanup-ungated): paginating the embedded tm-mode dd15 list (inspector Latest changes) and a tm-mode list on a non-dd15 section (the row source decides, not the tipo) send no update_lock_components_state — the dd15 one was a 403 for every non-admin — while a normal section still sends its one delete_user_section_locks (control). Drives the shipped section.prototype.navigate (refresh stubbed); backend-free (data_manager.request patched).
	'test_a11y_keyboard',             // THE KEYBOARD IS A REAL USER (audit P1-18 / CLI-10, CLI-11, CLI-22): real KeyboardEvents at the surfaces a cataloguer uses — the component label association (including a control appended after the wrapper was built), icon-only button names, Enter/Space on the thesaurus row's arrow and term, and the dialog's role/name/focus-in/inert/restore. Every other suite drives the client programmatically, which is why a keyboard-dead widget was indistinguishable from a working one.
	'test_service_autocomplete',
	'test_components_lifecycle',     // green after component_iri label-dataframe port (dd560 request_config + context) + external search fix
	'test_components_render',        // same — component_iri list/text + component_external search now render
	'test_others_lifecycle',         // green after list_uploaded_files port (dispatch.ts)
	'test_job_tray',                  // the LONG-PROCESS monitoring surface: format_elapsed's boundaries (the readout an operator watches during an hour-long transcode), the shared #floating_dock reuse law, and THE CONNECTION-RELEASE law (a cancelled follower must close its stream — six abandoned ones starve the origin's six HTTP/1.1 slots and freeze the whole page). Backend-free: pure/DOM + a stubbed request_stream — a rendered tray needs a logged-in backend with live jobs.
	'test_thesaurus_pane',            // the picker SURFACE: the thesaurus mounted inline in the caller's own wrapper. Separate from test_thesaurus_picker because it DOES import component_portal (that file's not importing it is one of its assertions). Pins the liveness rule — reuse is decided by asking the area instance, never by a "built" flag, because the refresh() every pick triggers destroys it through ar_instances.
	'test_thesaurus_picker',          // the relation view:'tree' term picker — the shared picker module (selection set, capacity, per-node selectability) and the in-page host's teardown. Backend-free: pure/DOM against a synthetic caller, no component_portal in scope (that isolation is itself an assertion — it is what lets edit-in-list add a host rather than a second picker).
	'test_component_dataframe_delete',  // the dataframe DELETE door, backend-free: delete_dataframe selects the stored frame entries by their PAIRING (id_key + main_component_tipo, entries WITH an id) and hands them to unlink_record — it used to pass a locator with no id, which the save path's remove cannot match, so the button removed nothing; refuses (false, no unlink) when nothing paired carries an id (WC-2026-09-06-dataframe-delete-policy-on-slot; the modal's second confirm left with the hard policy, WC-2026-09-29-dataframe-hard-delete-retired).
	'test_component_dataframe_rating',  // a list slot's rating chip reads ITS OWN ROW's frame child: the list datum is shared by every row and the TM history list emits the same frame target once per row, each AS OF that row (row_section_id) — get_rating ignored the row, so every row showed the first-emitted (live) copy (WC-2026-09-29-tm-preview-frame-children-as-of). Backend-free: a plain slot object + get_rating.
	'test_component_dataframe_tm_read_only',  // a dataframe inside a Time Machine surface is HISTORY: the list chip is inert where the slot is not the live editable record (permissions < 2, a dd15 history cell, a tool preview) — its door opened the LIVE target in an editable modal whose Delete unlinked at (host, dd15 row id); and every descendant of a TM surface (whole caller chain, is_time_machine_view) skips the live sync_data subscription — a preview frame child (rating) followed live saves (WC-2026-09-29-tm-preview-frame-children-as-of). Backend-free: plain objects.
	'test_diffusion',                // needs the RUN'S PINNED diffusion domain (scripts/client_test_server.ts SUITE_DIFFUSION_DOMAIN='test'): matched by term, the installation's domain name resolves to a truncated clone on the suite database and the section map comes back empty, so the inspector draws no opener. Green after the selector fix: the inspector's diffusion opener is a SPAN (`.button.diffusion`), never a `button.diffusion` — nothing else was wrong. Its Publish cases now assert the button renders and is confirm-gated, and ANSWER THE CONFIRM WITH NO: a confirmed click fires a real publish to the configured target and returns before the stream ends, so the old click asserted nothing while writing to a live target every run.
	'test_update_code',              // FIRST area_maintenance widget suite: the update_code panel render (dd_readout + shared server picker, dead surfaces gone) and the server-picker cross-widget contract — selecting a CODE server must NOT publish ontology_server_select_change nor reset a co-mounted update_ontology reference row (the picker publishes nothing itself; only update_ontology's own on_change callback does). Backend-free: fake server descriptors, test-only storage keys.
	'test_add_hierarchy',             // the Maintenance › add_hierarchy widget + its import block (render_hierarchies_import.js, extracted from the retired browser wizard — WC-2026-10-12-install-surface-removed): typology-grouped rows with the installed chip, the live filter count + no-match note, declared thesauri pre-ticked (never locked), the import body is the widget's own widget_request (never dd_utils_api), reset sends only installed TLDs, the block refuses to render without its endpoints, and the spinner is VISIBLY animated by the widget stylesheet while a request is pending. Backend-free: data_manager.request / confirm / alert replaced and restored.
	'test_publication_hosts',         // the publication_hosts maintenance widget (PUBLICATION_HOST_SPEC phase 3): an unusable registry (registry_invalid / hosts null) is a LOUD state, its registry.check row through check_row (never an empty list), operator strings render as text, check rows labelled through check_row's `publication_hosts` prefix (default prefix unchanged), controls only for root, agent commands disabled until the pairing is proved, confirm-gated actions with spinner/outcome/reload-on-success, edit form prefilled from the row, blank settings sent as null; plus media_control's one line that asks the dashboard to open it (OPEN_WIDGET_EVENT, maintenance_events.js). Backend-free: request/confirm/reload replaced on the instance.
	'test_publication_host_setup',    // "New publication host" (render_new_host.js): root-only section (drafts_state present), a corrupt drafts file is LOUD, draft cards (state, listener, kit sha; download disabled until built; the package upload only for an awaiting two-machine draft, no address input), Propose fills / Save sends exactly the draft keys, a refusal marks details.fields and shows label + sentence, the upload sends base64 + passphrase once and clears the passphrase, Download hands the decoded kit to save_file. Backend-free: request/confirm/reload/save_file replaced on the instance.
	'test_publication_api_lockstep',  // publication_hosts API lockstep block (pubhost phase 4): engine release vs each host's v2/v1, last push, ok/amber/red chip, refusal named as text (never markup), "not verified yet" keeps push enabled, no push button for non-root, runtime_invalid flag in the panel, confirm-gated single push_apis call that shows the server sentence and reloads. Backend-free: pure view + a real instance with request/confirm/reload replaced.
	'test_move_transform',            // the move_* widgets' run flow (core/area_maintenance/js/move_transform.js): dry_run sent EXPLICITLY (the panel used to send none, so it could only ever preview — no control reached the execute), a preview job first, Execute revealed only by a preview that ended CLEAN (no coded error, ok, a dry run), refused when the selection changed since the preview, confirm-gated, running the previewed snapshot with dry_run:false once. Backend-free: injected exec/track/confirm/alert, a fake caller.init_form.
	'test_client_action_outcome',     // P2-2 (CLI-16/17/18): a client action READS its own outcome — a throwing loader leaves the engine's error panel in the container (never an empty node); the big modal's scroll restore fires on ITS close, not a nested confirm's; the autocomplete's default pick surfaces link_records refusals as a notification. Backend-free: synthetic loader, stubbed window.scrollTo, fake caller.
	'test_search_teardown',           // P2-2 (CLI-19): remove_model_node is THE filter-model teardown door — a removed group (nested too) returns the instance registry and the event table to baseline; reset() rejects on a throwing refresh instead of hanging. Builds the situation: real component_input_text instances on the test3 playground, each holding a live subscription.
	'test_additional_text_area',     // green after (1) dispatch catches handler throws → graceful result:false (was raw 500), (2) the test480 "map of grapes" demo ontology (src/core/test_data/map_of_grapes_fixture.ts, auto-provisioned by scripts/client_test_runner.ts pre-run) with test506's key_up_f2 observe, (3) the text_area edit-mode features.av_player port (structure_context.ts) that binds F2→build_tag. Matches the PHP oracle client 16/16.
	'test_pinned_record_view',       // ONE SELECTOR PER READ (the id/offset conflict of the edit view): a read that names its record (filter_by_locators = ONE locator) is a RECORD VIEW — limit 1, offset 0, total 1 — and must never receive the stored `${tipo}_edit` pagination offset, because a single pin plus offset > 0 skips the only row and the edit form comes up EMPTY (measured: `?tipo=test3&id=<record>&mode=edit` answered zero rows with "No se han encontrado registros"). Real reads on the suite DB: (1) the list names a record, the stored position is seeded, the pinned build must resolve it; (2) the unpinned control must still restore the seeded offset, so the gate cannot pass vacuously; (3) a caller's RESULT SET (3 pins, the shape a semantic search writes) must survive the rebuild AND the session-sqo adoption — the adoption keeps the SAME object (pagination mutates it in place) and must never scrub the live pins; (4) goto_list drops the pin that names the open record (a one-row list otherwise).
	'test_ort_smoke'                 // 2026-10-05: the vendored transformers.js runtime creates + runs ONE real onnxruntime WASM session (a 179-byte one-node Add model built in memory by ./ort_smoke_model.js, served through transformers.js's custom-cache hook) — the only gate that loads the bundle + onnxruntime-web glue in a browser; a create that never settles is bounded at 20 s. The version PAIRING is onnxruntime_alignment_tripwire's.
]

/**
 * Generic-group suites DEFERRED against TS. EMPTY since 2026-08-20: the last row
 * (test_diffusion) was never a port gap — it asserted a selector that matched no
 * element. Anything added here needs a reason that names the TS gap, and it must
 * be a gap, not a stale assertion.
 */
export const generic_suites_deferred = []

/** Full generic inventory (green + deferred) — back-compat export. */
export const generic_suites = [...generic_suites_green, ...generic_suites_deferred]

/**
 * Per-component life-cycle suites (one Mocha file per component type) that pass
 * against the TS server today — Wave 2 gate. Each drives the full mode/view
 * matrix + data ops for a single model. (Stable set: passed in two independent
 * runs; see scripts/client_test_runner.ts (KNOWN_FAILING).)
 */
export const lifecycle_suites_green = [
	'test_component_3d',
	'test_component_av',
	'test_component_email',            // green after save-response DataItem-shape fix (dispatch.ts)
	'test_component_external',
	'test_component_geolocation',      // green after save-response DataItem-shape fix (dispatch.ts)
	'test_component_image',
	'test_component_info',
	'test_component_input_text',       // green after save-response DataItem-shape fix (dispatch.ts)
	'test_component_check_box',        // green after select_family search-datalist + entries→[] fix
	'test_component_filter',           // needs the run's projects fixture (src/core/test_data/projects_fixture.ts): the install seed ships ONE dd153 project and the record selects it, so check/uncheck have nothing to work with. Green after filterResolver search-datalist + entries→[] fix
	'test_component_inverse',          // green after inverse empty-value → [] fix (read.ts)
	'test_component_radio_button',     // green after save-response datalist fix (dispatch.ts)
	'test_component_select',            // green after select_family fixes (stable)
	'test_component_password',          // green after literal empty→[] fix (read.ts)
	'test_component_text_area',         // green after literal empty→[] fix (read.ts)
	'test_component_iri',              // green after save-response DataItem-shape fix (dispatch.ts)
	'test_component_json',             // green after save-response DataItem-shape fix (dispatch.ts)
	'test_component_number',           // green after save-response DataItem-shape fix (dispatch.ts)
	'test_component_pdf',
	'test_component_portal_pagination',
	'test_component_publication',
	'test_component_relation_model',
	'test_component_relation_parent',  // green after save context+pagination + resolve_data context fix
	'test_component_relation_index',   // green after resolve_data search-context fix (dispatch.ts)
	'test_component_relation_related',  // green after show_interface.button_add override (structure_context.ts)
	'test_component_section_id',
	'test_component_security_access',
	'test_component_select_lang',
	'test_component_svg',
	'test_component_relation_children',  // write-through to each child's parent link (relations/children_write.ts)
	'test_component_portal',            // green after save auto-creates the missing host record (PHP set_dato upsert parity)
	'test_component_filter_records',    // green after get_datalist port (authorized sections datalist, dispatch.ts)
	'test_component_date',              // green after the period tipo fix: the suite named test218, which exists in NO ontology; the test3 period-date component is test173 (test3 → test115 → test34). It was never a provisioning gap.
	'test_touch_phone',                 // 2026-09-28 responsive tools: the shared phone gestures (touch_pick tap-to-place, pane_switch, phone_reorder) plus the search pane's tap-to-add field button (search_phone.js). Backend-free.
	'test_section_map'                  // REGISTERED 2026-08-31 (P2-28 / DEAD-10). 104 lines of real assertions over the client's section_map scope/term resolution — in no manifest, imported by nothing, and therefore NEVER RUN, while the suite reported 131/131 green. Backend-free: pure functions against synthetic maps mirroring the PHP section_map_Test fixtures.
]

/**
 * Life-cycle suites DEFERRED against TS — a model whose broader mode/view matrix
 * (esp. SEARCH-mode render) or save round-trip is not complete. EMPTY since
 * 2026-08-20: the last row (test_component_date) was ledgered as an ontology
 * PROVISIONING gap ("add test218 period-date to test3"), but test218 exists in no
 * ontology on any instance — the test3 period component is test173 and always
 * was. A deferral reason that names a missing thing is worth re-checking before
 * it is believed.
 */
export const lifecycle_suites_deferred = []

/** Full life-cycle inventory (green + deferred) — back-compat export. */
export const lifecycle_suites = [...lifecycle_suites_green, ...lifecycle_suites_deferred]

/**
 * Per-tool suites (one Mocha file per tool under tools/) that pass against TS —
 * Wave 3 gate. These are synchronous structural checks (module exports /
 * prototype wiring); they run now that the harness no longer forces async-only
 * (test_bootstrap.js). The tool client modules are served from the TS-owned
 * repo `tools/` tree at /dedalo/tools/*.
 */
export const tool_suites_green = [
	'test_tool_sitebuilder', // the stream door's client half: render_event('error') renders error_text(body.error) (the relayed frame carries no message) and agent_output as its own line.
	'test_tool_qr',          // two layers: the locked tool template, plus THE RECORD-LIST CONTRACT on the real test3 section — load_section's fetched/total/truncated and one .qr_wrapper per record. The tool read the retired `data.value` key instead of the server's `entries`, so every sheet was empty with "Limit = 0 / N".
	'test_tool_assistant',
	'test_tool_cataloging',
	'test_tool_dd_label',
	'test_tool_dev_template',
	'test_tool_export',
	'test_tool_hierarchy',
	'test_tool_image_rotation',
	'test_tool_import_dedalo_csv',
	'test_tool_import_files',
	'test_tool_import_marc21',
	'test_tool_import_rdf',
	'test_tool_import_zotero',
	'test_tool_lang',
	'test_tool_lang_multi',
	'test_tool_media_versions',
	'test_tool_numisdata_acquisition',    // the auction acquisition client driven for real (real constructor + renderer, real transport, scripted server at window.fetch — acquisition_harness.js): preview_url/commit_lots wire bodies, and a FAILED background job (coded `error` on the terminal FRAME, ERRORS_SPEC §5.3) renders that error — it used to print "Done." and crash in on_success(undefined); auth.* → relogin; a stopped job is not "Done."; error bodies label-first; scraped text stays text.
	'test_tool_bibliography_acquisition', // the OAI-PMH journal acquisition client, same harness and the same contract: preview_url/commit_publications wire bodies, a failed job's frame error rendered (the public sentence reaches the operator), never "Done." + on_success(undefined).
	'test_acquisition_commit_honesty',    // both acquisition tools: a COMMIT re-arms only on a known outcome or an explicit decision — an outstanding commit disables Preview (a re-preview drew a new ENABLED Confirm → second commit); an uncoded terminal end (interrupted / stopped mid-run / vanished pfile) is stated, not settled; no blind "did not start" beside an ended job of this kind.
	'test_acquisition_preview_commit_exclusion', // both acquisition tools: Preview and a commit exclude each other both ways — a Confirm clicked while a re-preview is in flight dispatches NO commit and the superseded review leaves at the Preview click; the new review's Confirm starts exactly one commit.
	'test_tool_numisdata_epigraphy',
	'test_tool_numisdata_order_coins',
	'test_tool_ontology',
	'test_tool_ontology_parser',
	'test_tool_pdf_extractor',
	'test_tool_posterframe',
	'test_tool_print',
	'test_tool_propagate_component_data',
	'test_tool_subtitles',
	'test_tool_tc',
	'test_tool_time_machine',
	'test_tool_tr_print',
	'test_tool_transcription',
	'test_tool_update_cache',
	'test_tool_upload',
	'test_tool_user_admin',
	'test_tool_diffusion',   // green after the assertion fix: it required a prototype `get_diffusion_status`, the PHP-era API ACTION name. WC-076 moved the engine in-process and the client method is get_engine_advisory; no client method ever carried the old name.
	'test_tool_indexation'   // two layers: the locked tool template (module export + constructor seed + prototype wiring — green after the assertion fix: it required `new_tag_note` on the prototype, but that is a module-private helper inside tag_note.js, so it asserted the opposite of the contract), plus the BEHAVIOUR block — the tag-info pub/sub (active_value dedup, one-to-many fan-out), _ensure_lazy_instance (already-built short-circuit, unconfigured-role throw, per-role wiring, the ddo.lang > nolan > data_lang ladder), load_related_sections_list's RQO shape, delete_tag's two-confirm destructive path (composite locator key dd96, data/datum observed null FROM INSIDE refresh, step 2 survives a thrown step 1) and render_indexation_note's single-quoted dataset locator. Fixture-free: fake children pre-registered under the exact get_instance key, data_manager patched on the shared singleton, confirm/alert stubbed (a real dialog FREEZES the headless renderer).
]

/**
 * Tool suites still failing (module load/structural gaps). EMPTY since
 * 2026-08-20: both rows were ledgered as "structural/module gaps" and neither
 * was — each asserted ONE prototype name that does not exist by design.
 */
export const tool_suites_deferred = []

/** Full tool inventory — back-compat export. */
export const tool_suites = [...tool_suites_green, ...tool_suites_deferred]

// Group definitions (built once, activated per wave below).
// Each group renders BOTH its gated (green) suites and its deferred suites so the
// whole inventory is visible in the sidebar. Deferred suites carry `deferred:true`;
// the list marks them and the `run all` gate + stats skip them (they are not green
// yet — see scripts/client_test_runner.ts (KNOWN_FAILING)), so the gate stays meaningful while nothing is
// hidden from view.
const withDeferred = (green, deferred) => [
	...green.map(name => ({ id: name, area: name })),
	...deferred.map(name => ({ id: name, area: name, deferred: true }))
]
const generic_group = {
	id		: 'generic',
	title	: 'generic',
	type	: 'generic',
	suites	: withDeferred(generic_suites_green, generic_suites_deferred)
}
const lifecycle_group = {
	id		: 'lifecycle',
	title	: 'life-cycle',
	type	: 'generic',
	suites	: withDeferred(lifecycle_suites_green, lifecycle_suites_deferred)
}
const tools_group = {
	id		: 'tools',
	title	: 'tools',
	type	: 'generic',
	suites	: withDeferred(tool_suites_green, tool_suites_deferred)
}
const component_group = {
	id		: 'component',
	title	: 'components',
	type	: 'component',
	suites	: elements.map(el => ({
		id		: el.model,
		area	: 'test_component_full',
		model	: el.model,
		tipo	: el.tipo,
		element	: el
	}))
}

/**
 * Test groups rendered in the sidebar AND run by the `run all` gate.
 *
 * TS-rewrite tiering: only the currently-migrated wave(s) are listed here. The
 * deferred groups below are kept defined (and exported) for the ledger and for
 * one-line re-activation as Phase 6 breadth lands — move a group into this array
 * to enable its wave. See scripts/client_test_runner.ts (KNOWN_FAILING) for per-suite status + reasons.
 */
export const test_groups = [
	generic_group,   // Wave 1 — generic infra
	lifecycle_group, // Wave 2 — per-component life-cycle, green subset
	component_group, // parameterized component matrix, all 33 models green
	tools_group      // Wave 3 — per-tool structural suites (34 green)
]

/**
 * No whole groups are deferred, and since 2026-08-20 no SUITES are either:
 * generic_suites_deferred, lifecycle_suites_deferred and tool_suites_deferred
 * are all empty, so the gate runs the whole inventory.
 */
export const deferred_groups = []

// @license-end
