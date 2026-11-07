/**
 * CLIENT COMPAT-READ CENSUS — the ONE counting implementation behind the
 * client_error_contract_tripwire (test/unit/client_error_contract_tripwire.test.ts)
 * and its baseline generator (scripts/client_compat_census.ts). Neither
 * computes anything on its own: the number the gate enforces must be, by
 * construction, the number the generator wrote (the throw_census.ts law).
 *
 * ── WHAT IS COUNTED ─────────────────────────────────────────────────────────
 * Property READS of the envelope-v2 COMPAT keys — `.msg`, `.errors`, `.result`
 * (engineering/ERRORS_SPEC.md §3.1: the bounded block `ERROR_ENVELOPE_COMPAT`
 * mirrors `data`→`result` and `error`→`result:false/msg/errors[code]` ONLY
 * while a client still reads those names). The token is `\.(msg|errors|result)\b`
 * in CODE: comments AND string/template contents are blanked first (a doc line
 * or a label mentioning `.msg` is not a read). `\b` after the key already
 * excludes `.result_options` / `.result_id` (`_` is a word char), and a line
 * that mentions `page_globals` is skipped (page_globals is the client's own
 * state object, never a wire envelope). It is a TOKEN count, deliberately: a
 * write `.msg = …` counts too — a client that still WRITES the compat name is
 * still living on it, and the removal condition is "the name is gone".
 *
 * ── WHAT IS SCANNED ─────────────────────────────────────────────────────────
 * `client/dedalo/**\/*.js` minus `client/dedalo/test/**` (the browser test
 * suite fakes envelopes on purpose), plus `tools/*\/js/**\/*.js`. The corpus is
 * client code by DESTINATION: browser JS served from a tree OUTSIDE these two
 * needs its own root here, or it is ungated — that gap is what hid the two stale
 * `.result` reads in `tool_common.js` on 2026-08-16 (it then lived under `src/`),
 * blanking the label of every tool header. The file moved into
 * `client/dedalo/core/tools_common/` the same day (WC-006), which is why two
 * roots are again enough. Discovery is
 * `Glob().scanSync()` (dot + followSymlinks + loud on a dangling link), every
 * file read with `readFileSync` — NEVER a shell-out to grep. `*-min.js` build
 * artefacts are excluded (their source twin is counted).
 *
 * ── THE TWO REGIMES ─────────────────────────────────────────────────────────
 * total > 0  → shrink-only ratchet against a baseline JSON in engineering/
 *              (`client_compat_read_baseline.json`). NOT PRESENT TODAY, and that is
 *              the point: total = 0, so the P4 exit below already fired and the
 *              file was removed with the regime it governed;
 * total = 0  → the compat block must be GONE (`ERROR_ENVELOPE_COMPAT` absent from
 *              convert.ts, `compatFields` absent from schema.ts) — the gate flips
 *              on the baseline's `summary.total`, no edit needed (P4 exit).
 *
 * HERMETIC: tracked-source reads only. No DB, no network, no clock; imports
 * nothing from src/.
 */

import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { Glob } from 'bun';
import { stripComments } from '../../test/helpers/strip_comments.ts';

/** Repo root (this file lives at scripts/lib/client_compat_census.ts). */
export const REPO_ROOT = join(import.meta.dir, '..', '..');

/**
 * The scanned trees, repo-relative: `{root, glob}` pairs. Both globs are the
 * WHOLE tree: browser JS is client code BY DESTINATION, wherever a tool keeps
 * it — `tools/<tool>/js/` is the common shape, but a web worker under
 * `transcribers/lib/`, a browser transformer under `translators/` are served
 * to the browser too (a vendored QR library under `lib/` was, until it became
 * a package pin on 2026-09-04). The old `*\/js/**`
 * shape left nine tracked files outside both this census and the tripwire's
 * fourth-wrapper scan (GATE-31, 2026-08-26); the tripwire now proves every
 * tracked `.js` under these roots is reached (`git ls-files` ⊆ the scan).
 */
export const SCAN_ROOTS = [
	{ root: 'client/dedalo', glob: '**/*.js' },
	{ root: 'tools', glob: '**/*.js' },
] as const;

/** Excluded PATH PREFIXES (repo-relative) — the browser test suite fakes envelopes on purpose. */
export const EXCLUDED_PREFIXES = ['client/dedalo/test/'] as const;

/** Excluded by SHAPE: minified build twins (their source is counted) and vendored code. */
export const EXCLUDED_SUFFIXES = ['-min.js', '.min.js'] as const;
export const EXCLUDED_SEGMENTS = ['dist', 'node_modules', 'vendor'] as const;

/** The compat keys (ERRORS_SPEC §3.1) — the ONE place they are named for counting. */
export const COMPAT_KEYS = ['msg', 'errors', 'result'] as const;

/** `.msg` / `.errors` / `.result` as a whole word (`.result_options` is NOT a match). */
export const COMPAT_READ = /\.(msg|errors|result)\b/g;

/** A line naming the client's own state object is never a wire read. */
const LINE_EXCLUSION = /page_globals/;

/**
 * ── THE NON-ENVELOPE ALLOWLIST ───────────────────────────────────────────────
 * `.msg` / `.errors` / `.result` are compat keys ONLY on an API envelope. The
 * same three words are also, legitimately and permanently, the names of:
 *
 *   - browser API members (`FileReader.result`);
 *   - SERVER-OWNED STREAM FRAMES, which are not envelopes (ERRORS_SPEC §5):
 *     the media/tool job frame `{pid, pfile, is_running, data:{msg,…}, errors,
 *     total_time}` and the diffusion progress chunk `{data:{msg,…}, errors,
 *     result:<the persisted job RECORD>}`;
 *   - PAYLOAD keys inside `data` — a per-file/per-record diagnostic list a
 *     handler returns beside its summary (`ok({summary, errors})`), which is a
 *     successful answer, not a failure;
 *   - NAMED FAILURE EXTENSION KEYS (ERRORS_SPEC §3.0), thrown as a
 *     `DedaloError`'s `extend` — the per-check detail behind the one sentence
 *     the dispatcher prints.
 *
 * Those reads must SURVIVE the compat block's deletion, so counting them would
 * pin the census above zero forever and the gate could never flip. Each entry
 * below names one file, the expression it excuses (a hand-written regex in the
 * core tree, or `literal(...)` — an escaped exact expression — in the tools
 * tree, so it cannot silently widen), and WHY that expression is not an
 * envelope read. Entries are data, printed by the tripwire; an entry that
 * matches nothing is a GATE FAILURE (see the tripwire's staleness test), so a
 * conversion cannot leave a stale excuse behind.
 */
/**
 * ONE exempted read: the expression, the file it lives in, and WHY it is not a
 * compat read (see "THE NON-ENVELOPE ALLOWLIST" above). `pattern` is blanked out of
 * the code line before the count, so any OTHER `.msg`/`.errors`/`.result` on
 * the same line still counts.
 */
export interface NonEnvelopeRead {
	/** Repo-relative file (exact match) the exemption applies to. */
	readonly file: string;
	/** The exempt expression(s), matched on the code line. MUST be global. */
	readonly pattern: RegExp;
	/** Why it is not an envelope read — the shape, and who writes it. */
	readonly reason: string;
}

/**
 * A literal source expression as an exemption pattern (escaped, global). The
 * tools tree excuses EXACT expressions (`sse.result`, `frame.errors`), so an
 * exemption cannot silently widen; the core tree uses hand-written regexes
 * where one entry covers a small alternation.
 */
export function literal(expression: string): RegExp {
	return new RegExp(expression.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
}

/** The stream-frame reason, shared by every job-progress reader. */
const FRAME_REASON =
	'server-owned job STREAM FRAME (src/core/media/jobs.ts / src/diffusion/jobs/sse.ts), not an API envelope';
/** The payload reason, shared by every handler that returns a diagnostic list beside its summary. */
const PAYLOAD_REASON = 'PAYLOAD key inside `data` (a diagnostic list on a SUCCESSFUL answer)';

/** The named non-envelope reads. Data + reason; the tripwire prints and re-checks them. */
export const NON_ENVELOPE_READS: readonly NonEnvelopeRead[] = [
	{
		file: 'client/dedalo/core/common/js/data_manager.js',
		pattern: /\b(?:event\.target|DBOpenRequest)\.result\b/g,
		reason: 'IDBRequest.result — the browser IndexedDB API, not an API body.',
	},
	{
		file: 'client/dedalo/core/page/js/page.js',
		pattern: /\bapi_response\.environment\??\.result\b/g,
		reason:
			"`environment` is a handler EXTENSION KEY whose VALUE is the PHP-parity block {result,msg,errors} (src/core/resolve/environment.ts buildEnvironment); `.result` there is that block's payload key.",
	},
	{
		file: 'client/dedalo/core/area_thesaurus/js/render_area_thesaurus.js',
		pattern: /\bdata\.ts_search\.result\b/g,
		reason:
			'`ts_search` is a nested payload block {result,msg,errors,total,found} inside the area data (src/core/ts_object/search.ts searchThesaurus).',
	},
	{
		file: 'client/dedalo/core/area_graph/js/render_area_graph.js',
		pattern: /\bdata\.ts_search\.result\b/g,
		reason: 'The same nested `ts_search` block as render_area_thesaurus.js.',
	},
	{
		file: 'client/dedalo/core/area_maintenance/widgets/lock_components/js/render_lock_components.js',
		pattern: /\bactive_users\??\.result\b/g,
		reason:
			'The eager widget value nests the lock map as `active_users` = {result, ar_user_actions} (src/core/area_maintenance/widgets/lock_components.ts).',
	},
	{
		file: 'client/dedalo/core/area_maintenance/widgets/update_ontology/js/render_update_ontology.js',
		pattern: /\bcurrent_server\.(?:result|msg)\b/g,
		reason:
			"One row of the widget payload's `servers[]`: the probe writes `msg`/`errors`/`response_code`/`result` per server (src/core/area_maintenance/widgets/update_ontology.ts).",
	},
	{
		file: 'client/dedalo/core/area_maintenance/widgets/update_ontology/js/render_update_ontology.js',
		pattern: /\bjob_result\.(?:msg|errors)\b/g,
		reason:
			"`job_result` is the update_ontology JOB's RESULT payload — the final status frame's `data` (src/core/area_maintenance/widgets/update_ontology.ts ontologyAnswer: {msg, errors?, run_id, root_info, census?}), not an envelope: `msg` is the import log, `errors` the non-fatal import lines.",
	},
	{
		file: 'client/dedalo/core/area_maintenance/widgets/update_ontology/js/render_update_ontology.js',
		pattern: /\bfinal_frame\.errors\b/g,
		reason:
			"`final_frame` is the update_ontology job's server-owned STATUS FRAME {pid, pfile, is_running, data, errors, total_time} (src/core/media/jobs.ts JobStatusFrame), not an envelope: `errors` there is the job's collected lines (a stop / the lane deadline say why there).",
	},
	{
		file: 'client/dedalo/core/area_maintenance/widgets/update_code/js/update_code_phases.js',
		pattern: /\bframe\.errors\b/g,
		reason:
			"`frame` is the server-owned job STATUS FRAME {pid, pfile, is_running, data, errors, total_time} (src/core/media/jobs.ts JobStatusFrame), not an envelope: `errors` there is the worker's collected failure lines. The envelope INSIDE it (`frame.data`) is read as `data`/`error.message`.",
	},
	{
		file: 'tools/tool_export/js/render_tool_export.js',
		pattern: /\bframe\.errors\b/g,
		reason:
			"`frame` is the server-owned job STATUS FRAME of an export lane job (build_export_artifact / build_export_file — src/core/media/jobs.ts JobStatusFrame {pid, pfile, is_running, data, errors, total_time}), not an envelope: `errors` there is the worker's collected failure lines. The envelope INSIDE it (`frame.data`) is read through response_data.",
	},
	{
		file: 'client/dedalo/core/area_maintenance/widgets/diffusion_server_control/js/render_diffusion_server_control.js',
		pattern: /\bjob\.msg\b/g,
		reason:
			'A diffusion JOB ROW field (src/core/area_maintenance/widgets/diffusion_server_control.ts: `msg: row.totals?.msg`).',
	},
	{
		file: 'client/dedalo/core/area_maintenance/widgets/diffusion_server_control/js/live_diffusion_server_control.js',
		pattern: /\bjob\.msg\b/g,
		reason: 'The same job-row field, on the live (SSE) layer.',
	},
	{
		file: 'client/dedalo/core/area_maintenance/widgets/error_reports/js/render_error_reports.js',
		pattern: /\bitem\.msg\b/g,
		reason:
			"One entry of a stored report's `js_errors[]` — the captured browser-error shape {type,msg,source,line} (error_capture.js → src/core/error_report/store.ts).",
	},
	{
		file: 'client/dedalo/core/common/js/error_capture.js',
		pattern: /\b(?:el|entry)\.msg\b/g,
		reason:
			'The captured JS-error entry the client buffers in window.dedalo_js_errors and posts to the report intake; never an API response.',
	},
	{
		file: 'client/dedalo/core/common/js/render_common.js',
		pattern: /\b(?:data|item)\.msg\b/g,
		reason:
			'`data.msg` is the SSE job-progress payload (src/core/tools/background.ts onData({msg,…})); `item.msg` is a component-data RecursionError {type,msg,info} (src/core/relations/parent.ts).',
	},
	{
		file: 'client/dedalo/core/common/js/ui.js',
		pattern: /\bvalue\.msg\b/g,
		reason:
			'One entry of the ontology-authored `properties.state_of_component` map ({icon,msg}) in the component context.',
	},
	{
		file: 'client/dedalo/core/common/js/utils/notifications.js',
		pattern: /\boptions\.msg\b/g,
		reason:
			"The client's own 'notification' event payload (event_manager.publish('notification', {msg,…})), not a wire body.",
	},
	{
		file: 'client/dedalo/core/page/js/render_page.js',
		pattern: /\b(?:dedalo_notification|self\.last_dedalo_notification)\.msg\b/g,
		reason:
			'`dedalo_notification` is an extension key whose VALUE is {msg,class_name} (the maintenance notice set by check_config).',
	},
	{
		file: 'client/dedalo/core/area_maintenance/js/render_area_maintenance.js',
		pattern: /\br\.errors\b/g,
		reason:
			'`errors` INSIDE the register_tools widget payload (src/core/area_maintenance/widgets/register_tools.ts: data {datalist, errors, registry_state}).',
	},
	{
		file: 'client/dedalo/core/area_maintenance/widgets/register_tools/js/render_register_tools.js',
		pattern: /\b(?:value|item)\.errors\b|\bget_label\.errors\b/g,
		reason:
			"`value.errors` is the widget payload's own findings list, `item.errors` a per-tool report row, and `get_label.errors` a UI LABEL key (master.json), never a wire read.",
	},
	{
		file: 'client/dedalo/core/area_maintenance/widgets/counters_status/js/render_counters_status.js',
		pattern: /\bvalue\.errors\b/g,
		reason:
			'`errors` inside the widget payload (src/core/area_maintenance/widgets/counters_status.ts: data {datalist, errors}).',
	},
	{
		file: 'client/dedalo/core/area_maintenance/widgets/system_info/js/render_system_info.js',
		pattern: /\bvalue\.errors\b/g,
		reason:
			'`errors` inside the widget payload (src/core/area_maintenance/widgets/system_info.ts: data {requeriments_list, system_list, errors}).',
	},
	{
		file: 'client/dedalo/core/area_maintenance/widgets/sequences_status/js/render_sequences_status.js',
		pattern: /\bvalue\.msg\b/g,
		reason:
			'The eager widget value IS the PHP-parity report block {result,msg,values} (src/core/area_maintenance/widgets/sequences_status.ts checkSequences).',
	},
	{
		file: 'client/dedalo/core/page/js/job_tray.js',
		pattern: /\b(?:row|fresh|entry\.row)\.errors\b/g,
		reason:
			'ActivityRow.errors — a job row inside the `jobs` extension key (src/core/api/activity.ts).',
	},
	{
		file: 'client/dedalo/core/component_portal/js/view_line_edit_portal.js',
		pattern: /\bself\.data\.errors\b/g,
		reason:
			'Component DATA carries per-record RecursionError findings (src/core/relations/parent.ts getParentsRecursive).',
	},
	{
		file: 'client/dedalo/core/services/service_upload/js/dropped_files.js',
		pattern: /\bstate\.errors\b/g,
		reason:
			"The drop traversal's own skipped-entry list, published as the returned array's non-enumerable `errors`; it never crosses the wire.",
	},
	{
		file: 'client/dedalo/core/services/service_upload/js/render_edit_service_upload_queue.js',
		pattern: /\bfiles\.errors\b/g,
		reason: 'The dropped_files diagnostics above, read by the drop handler.',
	},
	// ── tools tree (tools/**, not only tools/*/js) — literal expressions ───────
	// ── browser APIs ──────────────────────────────────────────────────────────
	{
		file: 'tools/tool_assistant/js/assistant_controller.js',
		pattern: literal('reader.result'),
		reason: 'FileReader.result — a browser API member',
	},
	{
		file: 'tools/tool_error_report/js/render_tool_error_report.js',
		pattern: literal('reader.result'),
		reason: 'FileReader.result — a browser API member',
	},
	{
		file: 'tools/tool_bibliography_acquisition/js/render_tool_bibliography_acquisition.js',
		pattern: literal('reader.result'),
		reason:
			'FileReader.result — a browser API member (the saved page the operator picked for preview_html)',
	},
	{
		file: 'tools/tool_numisdata_acquisition/js/render_tool_numisdata_acquisition.js',
		pattern: literal('reader.result'),
		reason:
			'FileReader.result — a browser API member (the saved page the operator picked for preview_html)',
	},
	// ── the browser's own captured-error buffer (a REQUEST field, never a response) ──
	{
		file: 'tools/tool_error_report/js/render_tool_error_report.js',
		pattern: literal('item.msg'),
		reason:
			'window.dedalo_js_errors entry (the browser error buffer this tool SENDS; src/core/error_report/store.ts js_errors)',
	},
	{
		file: 'tools/tool_error_report/js/tool_error_report.js',
		pattern: literal('el.msg'),
		reason:
			'window.dedalo_js_errors entry (the browser error buffer this tool SENDS; src/core/error_report/store.ts js_errors)',
	},
	// ── the diffusion progress chunk + its persisted job RECORD (WC-2026-08-15-diffusion-job-result-record) ──
	{
		file: 'tools/tool_diffusion/js/report_model.js',
		pattern: literal('sse.result'),
		reason:
			'the persisted diffusion job RECORD carried by the SSE chunk (`{ok, error?, msg?, errors?…}`), not an envelope',
	},
	{
		file: 'tools/tool_diffusion/js/report_model.js',
		pattern: literal('record.msg'),
		reason: "the job RECORD's own headline (WC-2026-08-15-diffusion-job-result-record)",
	},
	{
		file: 'tools/tool_diffusion/js/report_model.js',
		pattern: literal('record.errors'),
		reason:
			"the job RECORD's per-record diagnostic lines — a COMPLETED run collects them (ok:true + errors ⇒ 'partial')",
	},
	{
		file: 'tools/tool_diffusion/js/report_model.js',
		pattern: literal('sse.data.msg'),
		reason: FRAME_REASON,
	},
	{
		file: 'tools/tool_diffusion/js/report_model.js',
		pattern: literal('sse.errors'),
		reason: `${FRAME_REASON} — the JOB-level error list`,
	},
	{
		file: 'tools/tool_diffusion/js/render_tool_diffusion.js',
		pattern: literal('sse_response?.data?.msg'),
		reason: FRAME_REASON,
	},
	{
		file: 'tools/tool_bibliography_acquisition/js/render_tool_bibliography_acquisition.js',
		pattern: literal('sse_response?.data?.msg'),
		reason: `${FRAME_REASON} — a NON-terminal progress frame, data = the handler's publishProgress {msg, counter, total}; the terminal frame's envelope is read through request_failed / response_data`,
	},
	{
		file: 'tools/tool_numisdata_acquisition/js/render_tool_numisdata_acquisition.js',
		pattern: literal('sse_response?.data?.msg'),
		reason: `${FRAME_REASON} — a NON-terminal progress frame, data = the handler's publishProgress {msg, counter, total}; the terminal frame's envelope is read through request_failed / response_data`,
	},
	{
		file: 'tools/tool_bibliography_acquisition/js/render_tool_bibliography_acquisition.js',
		pattern: literal('sse_response.errors'),
		reason: `${FRAME_REASON} — the TERMINAL frame's own lines (interrupted / stopped mid-run / pfile not found, src/core/api/process_status.ts) when it carries no coded error and no result envelope: a commit's end that did not say what it did (unknown_on_uncoded_end)`,
	},
	{
		file: 'tools/tool_numisdata_acquisition/js/render_tool_numisdata_acquisition.js',
		pattern: literal('sse_response.errors'),
		reason: `${FRAME_REASON} — the TERMINAL frame's own lines (interrupted / stopped mid-run / pfile not found, src/core/api/process_status.ts) when it carries no coded error and no result envelope: a commit's end that did not say what it did (unknown_on_uncoded_end)`,
	},
	// ── media / background job frames ─────────────────────────────────────────
	{
		file: 'tools/tool_media_versions/js/render_tool_media_versions.js',
		pattern: literal('frame.errors'),
		reason: FRAME_REASON,
	},
	{
		file: 'tools/tool_import_dedalo_csv/js/render_tool_import_dedalo_csv.js',
		pattern: literal('sse_response.errors'),
		reason: FRAME_REASON,
	},
	{
		file: 'tools/tool_import_files/js/render_tool_import_files.js',
		pattern: literal('sse_response.errors'),
		reason: FRAME_REASON,
	},
	{
		file: 'tools/tool_import_files/js/render_tool_import_files.js',
		pattern: literal('sse_response.data.msg'),
		reason: FRAME_REASON,
	},
	{
		file: 'tools/tool_import_files/js/render_tool_import_files.js',
		pattern: literal('data.msg'),
		reason: FRAME_REASON,
	},
	{
		file: 'tools/tool_propagate_component_data/js/render_tool_propagate_component_data.js',
		pattern: literal('sse_response.errors'),
		reason: FRAME_REASON,
	},
	{
		file: 'tools/tool_propagate_component_data/js/render_tool_propagate_component_data.js',
		pattern: literal('sse_response.data.msg'),
		reason: FRAME_REASON,
	},
	{
		file: 'tools/tool_propagate_component_data/js/render_tool_propagate_component_data.js',
		pattern: literal('data.msg'),
		reason: FRAME_REASON,
	},
	{
		file: 'tools/tool_update_cache/js/render_tool_update_cache.js',
		pattern: literal('sse_response.data.msg'),
		reason: FRAME_REASON,
	},
	{
		file: 'tools/tool_update_cache/js/render_tool_update_cache.js',
		pattern: literal('data.msg'),
		reason: FRAME_REASON,
	},
	// ── payload keys (a diagnostic list beside the summary) ───────────────────
	{
		file: 'tools/tool_hierarchy/js/render_tool_hierarchy.js',
		pattern: literal('api_response_data.errors'),
		reason: PAYLOAD_REASON,
	},
	{
		file: 'tools/tool_image_rotation/js/render_tool_image_rotation.js',
		pattern: literal('rotation_data.errors'),
		reason: `${PAYLOAD_REASON} — the per-tier rotation failures (tools/tool_image_rotation/server/index.ts)`,
	},
	{
		file: 'tools/tool_import_dedalo_csv/js/render_tool_import_dedalo_csv.js',
		pattern: literal('report.errors'),
		reason: `${PAYLOAD_REASON} — one file's read/import problems in the batch report`,
	},
	{
		file: 'tools/tool_import_dedalo_csv/js/render_tool_import_dedalo_csv.js',
		pattern: literal('issue.msg'),
		reason:
			'a per-row import ISSUE record inside the report payload (src/core/tools/import_conform.ts)',
	},
	{
		file: 'tools/tool_import_dedalo_csv/js/tool_import_dedalo_csv.js',
		pattern: literal('files_data?.errors'),
		reason: `${PAYLOAD_REASON} — the per-file CSV read problems (tools/tool_import_dedalo_csv/server/index.ts getCsvFiles)`,
	},
	{
		file: 'tools/tool_import_files/js/render_tool_import_files.js',
		pattern: literal('report.errors'),
		reason: `${PAYLOAD_REASON} — the per-file import failures`,
	},
	{
		file: 'tools/tool_import_rdf/js/render_tool_import_rdf.js',
		pattern: literal('rdf_payload.errors'),
		reason: `${PAYLOAD_REASON} — the per-URI refusals (tools/tool_import_rdf/server/index.ts getRdfData)`,
	},
	{
		file: 'tools/tool_media_versions/js/render_tool_media_versions.js',
		pattern: literal('data.errors'),
		reason: `${PAYLOAD_REASON} — what a mutating media action reports beside what it did`,
	},
	{
		file: 'tools/tool_ontology/js/render_tool_ontology.js',
		pattern: literal('ontology_data.errors'),
		reason: `${PAYLOAD_REASON} — the per-record notes of an ontology write`,
	},
	{
		file: 'tools/tool_propagate_component_data/js/render_tool_propagate_component_data.js',
		pattern: literal('report.errors'),
		reason: `${PAYLOAD_REASON} — the per-record propagation failures`,
	},
	// ── named FAILURE extension keys (ERRORS_SPEC §3.0) ───────────────────────
	{
		file: 'tools/tool_hierarchy/js/render_tool_hierarchy.js',
		pattern: literal('api_response.errors'),
		reason:
			'NAMED failure extension key (tools/tool_hierarchy/server/tool_hierarchy.ts throws `extend:{state, errors}`) — the per-check detail',
	},
	{
		file: 'tools/tool_ontology_parser/js/render_tool_ontology_parser.js',
		pattern: literal('api_response.errors'),
		reason:
			'NAMED failure extension key (tools/tool_ontology_parser/server/tool_ontology_parser.ts batchFailed `extend:{errors, ar_msg}`) — the per-TLD detail',
	},
];

/** The exemptions that apply to one file (empty for a file with none). */
function exemptionsFor(file: string): NonEnvelopeRead[] {
	return NON_ENVELOPE_READS.filter((entry) => entry.file === file);
}

/** Blank the exempt expressions on a line, preserving its length (offsets stay honest). */
function blankExempt(line: string, exemptions: readonly NonEnvelopeRead[]): string {
	let out = line;
	for (const { pattern } of exemptions) {
		out = out.replace(new RegExp(pattern.source, 'g'), (match) => ' '.repeat(match.length));
	}
	return out;
}

export interface FileCompatReads {
	/** Repo-relative, forward slashes. */
	file: string;
	/** Compat-key reads in code (comments/strings blanked, page_globals lines skipped). */
	reads: number;
	/** Per-key breakdown of `reads` (informational). */
	byKey: Record<(typeof COMPAT_KEYS)[number], number>;
}

/**
 * Count the compat reads in one source text. Pure; exported so it can be
 * self-tested. `file` (repo-relative) selects the NON_ENVELOPE_READS
 * exemptions; omit it and NOTHING is exempt.
 */
export function countCompatReads(
	source: string,
	file = '',
): {
	reads: number;
	byKey: FileCompatReads['byKey'];
} {
	const code = stripComments(source, { blankStrings: true });
	const exemptions = exemptionsFor(file);
	const byKey: FileCompatReads['byKey'] = { msg: 0, errors: 0, result: 0 };
	let reads = 0;
	for (const rawLine of code.split('\n')) {
		if (LINE_EXCLUSION.test(rawLine)) continue;
		const line = exemptions.length === 0 ? rawLine : blankExempt(rawLine, exemptions);
		for (const match of line.matchAll(COMPAT_READ)) {
			const key = match[1] as (typeof COMPAT_KEYS)[number];
			byKey[key]++;
			reads++;
		}
	}
	return { reads, byKey };
}

/** Repo-relative, forward-slash path — stable across machines. */
export function toRepoRelative(absPath: string): string {
	return relative(REPO_ROOT, absPath).split(sep).join('/');
}

/** Codepoint order — NOT localeCompare (ICU would reorder `/` and `_`). */
export function byPath(a: { file: string }, b: { file: string }): number {
	return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
}

const SCAN_OPTIONS = {
	dot: true,
	followSymlinks: true,
	throwErrorOnBrokenSymlink: true,
} as const;

/** True for the repo-relative paths the census measures. */
export function isMeasured(repoRelative: string): boolean {
	if (!repoRelative.endsWith('.js')) return false;
	if (EXCLUDED_PREFIXES.some((prefix) => repoRelative.startsWith(prefix))) return false;
	if (EXCLUDED_SUFFIXES.some((suffix) => repoRelative.endsWith(suffix))) return false;
	const segments = repoRelative.split('/');
	return !segments.some((segment) => (EXCLUDED_SEGMENTS as readonly string[]).includes(segment));
}

/** Every measured file under the scan roots, repo-relative, codepoint-sorted, deduplicated. */
export function discoverFiles(): string[] {
	const seen = new Set<string>();
	for (const { root, glob } of SCAN_ROOTS) {
		const absRoot = join(REPO_ROOT, root);
		for (const match of new Glob(glob).scanSync({ cwd: absRoot, ...SCAN_OPTIONS })) {
			const repoRelative = `${root}/${match.split(sep).join('/')}`;
			if (isMeasured(repoRelative)) seen.add(repoRelative);
		}
	}
	return [...seen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The census: one entry per measured file (zero-count files included, so the
 * gate can pin files by name and prove the scan saw them). An unreadable file
 * THROWS — a skipped file is a file outside the gate.
 */
export function census(): FileCompatReads[] {
	return discoverFiles().map((file) => {
		const source = readFileSync(join(REPO_ROOT, file), 'utf8');
		return { file, ...countCompatReads(source, file) };
	});
}

/** Aggregate totals — the SAME reduce the baseline summary and the gate use. */
export function summarize(results: readonly FileCompatReads[]): {
	scanned: number;
	files: number;
	total: number;
	byKey: FileCompatReads['byKey'];
} {
	let files = 0;
	let total = 0;
	const byKey: FileCompatReads['byKey'] = { msg: 0, errors: 0, result: 0 };
	for (const result of results) {
		if (result.reads > 0) files++;
		total += result.reads;
		for (const key of COMPAT_KEYS) byKey[key] += result.byKey[key];
	}
	return { scanned: results.length, files, total, byKey };
}

/** Read totals keyed by top-level area (`client/dedalo/core`, `tools/<name>`, …). */
export function totalsByTopLevel(results: readonly FileCompatReads[]): Record<string, number> {
	const totals: Record<string, number> = {};
	for (const result of results) {
		const parts = result.file.split('/');
		const key = parts[0] === 'tools' ? `tools/${parts[1]}` : parts.slice(0, 3).join('/');
		totals[key] = (totals[key] ?? 0) + result.reads;
	}
	return Object.fromEntries(
		Object.entries(totals).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
	);
}
