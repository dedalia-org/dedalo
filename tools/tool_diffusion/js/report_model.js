/*global */
/*eslint no-undef: "error"*/

/**
* REPORT_MODEL
* Pure classifier for a diffusion run's SSE chunk → the data the report renders.
*
* WHY THIS FILE EXISTS, AND WHY IT HAS NO IMPORTS
* The old render_process_report read the wire and built DOM in one pass, gated on
* `engine_result.tables`. That gate had two consequences: a FAILED run (no `tables`)
* rendered nothing at all, and an rdf/xml run whose `tables` was a truthy `[]` could
* never reach its download buttons. Both defects lived in the branch STRUCTURE, so
* the fix is structural: the wire is turned into a plain model here, and the renderer
* consumes only the model. Nothing in this file touches the DOM, `ui`, `get_label`
* or any display string — so `test/unit/diffusion_report_model.test.ts` imports it
* directly under a plain `bun test`, with no browser and no server.
*
* LOSSLESSNESS IS A PROPERTY OF THE CODE, NOT A PROMISE
* `diagnostics_rows` does NOT hand-enumerate fields. It deep-walks the chunk and
* emits every path a primary zone did not already consume. A field added to the wire
* tomorrow therefore surfaces in Diagnostics automatically, and the unit gate asserts
* exactly that (`consumed ∪ diagnostics paths ⊇ deep walk of the chunk`).
*
* @see tools/tool_diffusion/js/render_tool_diffusion.js — the only consumer
* @see test/unit/diffusion_report_model.test.ts — the gate
*/



/**
* OUTCOMES
* The nine terminal/transient verdicts a run can present. Ordered loosely by
* severity so the list doubles as documentation.
* @type {ReadonlyArray<string>}
*/
export const OUTCOMES = Object.freeze([
	'queued',
	'running',
	'completed',
	'partial',
	'cancelled',
	'interrupted',
	'failed',
	'gone',
	'unknown'
])

/**
* SEVERITY
* outcome → severity class. Drives the panel's rail colour AND (for 'danger')
* the forced-open zones — a failure must never be collapsed behind a click.
* @type {Object<string,string>}
*/
export const SEVERITY = Object.freeze({
	queued		: 'neutral',
	running		: 'neutral',
	completed	: 'ok',
	partial		: 'warning',
	cancelled	: 'warning',
	interrupted	: 'danger',
	failed		: 'danger',
	gone		: 'danger',
	unknown		: 'danger'
})

/**
* ZONE_OPEN
* The severity ladder: which zones start expanded for each outcome. A clean run
* collapses to a verdict plus its non-zero rows; trouble expands itself.
* @type {Object<string,Object<string,boolean>>}
*/
export const ZONE_OPEN = Object.freeze({
	queued		: { causes:false, errors:false, tables_zeros:false, files:false, diagnostics:false, raw:false },
	running		: { causes:false, errors:false, tables_zeros:false, files:false, diagnostics:false, raw:false },
	completed	: { causes:false, errors:true,  tables_zeros:false, files:true,  diagnostics:false, raw:false },
	partial		: { causes:false, errors:true,  tables_zeros:false, files:true,  diagnostics:false, raw:false },
	cancelled	: { causes:false, errors:true,  tables_zeros:false, files:true,  diagnostics:false, raw:false },
	interrupted	: { causes:true,  errors:true,  tables_zeros:false, files:true,  diagnostics:true,  raw:false },
	failed		: { causes:true,  errors:true,  tables_zeros:false, files:true,  diagnostics:true,  raw:false },
	gone		: { causes:false, errors:true,  tables_zeros:false, files:false, diagnostics:true,  raw:true },
	unknown		: { causes:false, errors:true,  tables_zeros:false, files:false, diagnostics:true,  raw:true }
})

/**
* MSG
* The server's message vocabulary, pinned. This is the FALLBACK classifier only:
* it runs when a chunk carries no `state` (an old cached client, a replayed
* fixture). Keep in sync with src/diffusion/runner.ts, jobs/queue.ts, jobs/sse.ts —
* test/parity/fixtures/diffusion/pinned.ts is the shared pin.
*
* (!) deliberately NOT annotated `@type {Object<string,string>}` — that widens it
* to an index signature, and consumers under noUncheckedIndexedAccess then see
* every member as `string | undefined`. The inferred literal type is the point.
*/
export const MSG = Object.freeze({
	starting			: 'Starting diffusion...',
	processing_prefix	: 'Processing records ',
	linked_prefix		: 'Publishing linked records: ',
	done				: 'OK. Request done',
	done_legacy			: 'OK. Diffusion done',
	partial_prefix		: 'Partial success: ',
	cancelled			: 'Process cancelled by user',
	not_found			: 'Process not found',
	failed_prefix		: 'Error. Diffusion run failed: ',
	error_prefix		: 'Error'
})

/** Job states the server may stamp on a chunk (src/diffusion/jobs/schema.ts). */
const SERVER_STATES = Object.freeze([
	'queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted', 'gone'
])

/** Formats whose output is a set of FILES rather than table rows. */
const FILE_FORMATS = Object.freeze(['rdf', 'xml', 'markdown', 'csv', 'json'])

/** Formats that write files but whose engine does not report their URLs. */
const UNREPORTED_FILE_FORMATS = Object.freeze(['markdown', 'csv', 'json'])

/** Formats whose target is a database table. */
const TABLE_FORMATS = Object.freeze(['sql', 'socrata'])

/** MAX_PERSISTED_ERRORS in src/diffusion/runner.ts — the server's error cap. */
const ERROR_CAP = 50

/** Registry codes a diffusion job's FAILURE record can carry (src/core/errors/registry.ts). */
const CANCELLED_CODE	= 'diffusion.cancelled'
const RUNNER_LOST_CODE	= 'diffusion.runner_lost'

/** `${sectionTipo}:${sectionId} ${columnName}: ` — stripped to group like errors. */
const ERROR_PREFIX_RE = /^(\S+?:\d+)\s+(\S+?):\s*/



/**
* OUTCOME_FROM_RECORD
* The verdict the persisted job RECORD carries, or null when it carries none.
* The record is the converter's own shape (WC-2026-08-15-diffusion-job-result-record):
*   { ok:true,  msg, tables?, errors?… }   — a completed run ('partial' when it
*                                            collected per-record errors)
*   { ok:false, error:{code,…}, msg }      — a refusal, named by registry code
*
* @param {*} record - sse.result
* @return {string|null} one of OUTCOMES, or null
*/
function outcome_from_record(record) {

	if (!record || typeof record !== 'object') {
		return null
	}

	if (record.ok === false) {
		const code = (record.error && typeof record.error.code === 'string') ? record.error.code : ''
		if (code === CANCELLED_CODE)	return 'cancelled'
		if (code === RUNNER_LOST_CODE)	return 'interrupted'
		return 'failed'
	}

	if (record.ok === true) {
		const collected = record.errors
		return (Array.isArray(collected) && collected.length > 0) ? 'partial' : 'completed'
	}

	return null
}//end outcome_from_record



/**
* CLASSIFY_OUTCOME
* Resolve the run's verdict. `state` (server truth) wins; the message vocabulary
* is the compatibility fallback; an unrecognised chunk is LOUD ('unknown'),
* never silently optimistic.
*
* @param {Object} sse - one SSE chunk
* @return {string} one of OUTCOMES
*/
export function classify_outcome(sse) {

	if (!sse || typeof sse !== 'object') {
		return 'unknown'
	}

	// 1. server state (additive wire field). The persisted job RECORD
	// (`sse.result`) is `{ok, error?, msg?, errors?, …}` since
	// WC-2026-08-15-diffusion-job-result-record: a completed run that collected
	// per-record errors is `ok:true` WITH a non-empty `errors` list — "partial",
	// not a failure — and a record that says `ok:false` names its refusal by
	// registry code (`diffusion.cancelled` ⇒ cancelled, anything else ⇒ failed).
	if (typeof sse.state === 'string' && SERVER_STATES.includes(sse.state)) {
		if (sse.state === 'completed') {
			return outcome_from_record(sse.result) || 'completed'
		}
		return sse.state
	}

	// 2. no state: still running is unambiguous
	if (sse.is_running === true) {
		return 'running'
	}

	// 3. message vocabulary (no `state`: an old cached client, a replayed fixture)
	const record	= sse.result
	const line		= (sse.data && sse.data.msg) || (record && record.msg) || ''
	const msg		= String(line)
	if (msg === MSG.done || msg === MSG.done_legacy)	return 'completed'
	if (msg === MSG.cancelled)							return 'cancelled'
	if (msg === MSG.not_found)							return 'gone'
	if (msg.startsWith(MSG.partial_prefix))				return 'partial'
	if (msg.startsWith(MSG.failed_prefix))				return 'failed'
	if (msg.startsWith(MSG.processing_prefix))			return 'running'
	if (msg.startsWith(MSG.linked_prefix))				return 'running'
	if (msg === MSG.starting)							return 'queued'
	if (msg.startsWith(MSG.error_prefix))				return 'failed'

	// 4. never guess
	return 'unknown'
}//end classify_outcome



/**
* RESOLVE_FORMAT
* Output format of the run. The engine's own class name wins; the client's
* launch context is the fallback; null means "unknown" and the renderer uses
* neutral column labels rather than lying about what the numbers mean.
*
* @param {Object} sse
* @param {Object} ctx
* @return {string|null}
*/
function resolve_format(sse, ctx) {

	const record		= sse && sse.result
	const class_name	= record && record.diffusion_class
	if (typeof class_name === 'string' && class_name.startsWith('diffusion_')) {
		const format = class_name.slice('diffusion_'.length)
		// 'diffusion_mysql' is the legacy class name for the sql writer
		return format === 'mysql' ? 'sql' : format
	}

	const from_ctx = ctx && ctx.item && ctx.item.type
	return typeof from_ctx === 'string' && from_ctx !== '' ? from_ctx : null
}//end resolve_format



/**
* BUILD_SUBJECT
* The "what was published" line. The client's launch context is authoritative;
* parsing process_id is the reconnect-only fallback and is FLAGGED as derived,
* because that id is a display label, not a durable contract.
*
* @param {Object} sse
* @param {Object} ctx
* @return {Object}
*/
function build_subject(sse, ctx) {

	const item		= (ctx && ctx.item) || null
	const subject	= {
		label					: (item && (item.label || item.name)) || null,
		element_tipo			: (item && item.tipo) || null,
		section_tipo			: (ctx && ctx.section_tipo) || null,
		started_at_ms			: typeof sse.started_at === 'number' ? sse.started_at : null,
		last_section_id			: (sse.data && sse.data.current && sse.data.current.section_id) ?? null,
		section_label			: (sse.data && sse.data.section_label) || null,
		derived_from_process_id	: false
	}

	// reconnect without a client item: recover what we can from the label
	if (subject.element_tipo === null && typeof sse.process_id === 'string') {
		// process_diffusion_{user}_{element}_{section}
		const parts = sse.process_id.split('_')
		if (parts.length >= 5 && parts[0] === 'process' && parts[1] === 'diffusion') {
			subject.element_tipo			= parts[3] || null
			subject.section_tipo			= subject.section_tipo || parts.slice(4).join('_') || null
			subject.derived_from_process_id	= true
		}
	}

	return subject
}//end build_subject



/**
* BUILD_CAUSES
* Split a compile-failure message into its named causes. compileElementPlan
* joins them with '\n- ' (src/diffusion/plan/compile.ts PlanCompileError), so a
* multi-cause failure becomes a list instead of one wrapped blob. The unsplit
* original is ALWAYS kept — splitting must never be able to lose text.
*
* @param {Object} sse
* @return {Object} { list:string[], raw:string|null, dropped:boolean }
*/
function build_causes(sse) {

	const record		= sse.result
	const api_error		= (record && record.ok === false && record.error && typeof record.error === 'object')
		? record.error
		: null
	// the run's own sentence, then the progress line — both server-owned names
	const record_msg	= record && record.msg
	const frame_msg		= sse.data && sse.data.msg
	const record_errors	= record && record.errors
	const raw = (typeof record_msg === 'string')
		? record_msg
		: (typeof frame_msg === 'string' ? frame_msg : null)

	if (raw === null || raw === '') {
		// a refusal always names itself, even when the record kept no sentence
		if (api_error === null) {
			return { list:[], raw:null, dropped:false, code:null }
		}
		return {
			list	: [String(api_error.message || api_error.code || '')].filter(s => s !== ''),
			raw		: null,
			dropped	: !Array.isArray(record_errors),
			code	: typeof api_error.code === 'string' ? api_error.code : null
		}
	}

	let body = raw
	if (body.startsWith(MSG.failed_prefix)) {
		body = body.slice(MSG.failed_prefix.length)
	}

	// only split on the exact marker the compiler emits
	const list = body.includes('\n- ')
		? body.split('\n- ').map(s => s.trim()).filter(s => s !== '')
		: [body.trim()].filter(s => s !== '')

	return {
		list,
		raw,
		// a failure discards the per-record error list; say so rather than
		// letting an empty Errors zone imply "nothing else went wrong"
		dropped	: !Array.isArray(record_errors),
		// the registry code behind a refusal — the machine channel, kept beside
		// the sentence so the panel can say WHICH refusal this was
		code	: api_error === null
			? null
			: (typeof api_error.code === 'string' ? api_error.code : null)
	}
}//end build_causes



/**
* REPORT_DOWNLOAD_URL
* The address a report artifact opens at. The server builds artifact URLs on the
* MEDIA address (WC-042 addendum 2026-11-22): on a split-origin install that is
* an absolute URL on another host, and prefixing this page's origin to it opened
* the application's address instead. So: an absolute (`http(s)://`) or
* protocol-relative (`//host`) URL opens AS GIVEN; a root-relative one (`/…`,
* the default same-origin shape) is resolved on `origin`; anything else (a
* `javascript:` or other scheme, a bare path, empty) is refused — null, never
* opened.
*
* @param {string} url
* @param {string} origin - the page origin (window.location.origin)
* @return {string|null}
*/
export function report_download_url(url, origin) {

	if (typeof url !== 'string' || url === '') return null
	if (/^https?:\/\//i.test(url) || url.startsWith('//')) return url
	if (url.startsWith('/')) return origin + url

	return null
}//end report_download_url



/**
* BUILD_FILES
* Artifact list for the file formats. Sourced from FOUR possible locations and
* deduped by url — and, critically, NEVER gated on `tables`. The old renderer
* checked `engine_result?.tables` first, and an rdf/xml run reports a truthy
* empty array there, so its download buttons were unreachable.
*
* @param {Object} sse
* @param {string|null} format
* @return {Object}
*/
function build_files(sse, format) {

	const entries	= []
	const seen		= new Set()

	const push = (kind, url) => {
		if (typeof url !== 'string' || url === '' || seen.has(url)) return
		seen.add(url)
		entries.push({ kind, url, name : url.split('\\').pop().split('/').pop() })
	}

	const record = sse.result
	const consolidated_sources = [
		record && record.consolidated_files,
		sse.data && sse.data.consolidated_files
	]
	for (const source of consolidated_sources) {
		if (!source || typeof source !== 'object') continue
		push('merged', source.merged_url)
		push('zip', source.zip_url)
	}

	const list_sources = [
		record && record.diffusion_data,
		sse.data && sse.data.diffusion_data
	]
	for (const source of list_sources) {
		if (!Array.isArray(source)) continue
		for (const el of source) {
			if (el && typeof el === 'object') push('file', el.file_url)
		}
	}

	return {
		entries,
		// honest gap: these formats DO write files, the engine just never
		// reports the URLs. An empty box would read as "nothing was written".
		unreported_format : entries.length === 0
			&& format !== null
			&& UNREPORTED_FILE_FORMATS.includes(format)
	}
}//end build_files



/**
* BUILD_ISSUES
* Group repeated per-record errors so 47 identical failures read as one line
* with a count, while keeping every original string byte-verbatim in `raw`.
* Top-level (job) errors stay distinguishable from run errors — different
* producer, different meaning.
*
* @param {Object} sse
* @return {Object}
*/
function build_issues(sse) {

	const record		= sse.result
	const record_list	= record && record.errors
	const frame_list	= sse.errors
	const run_errors	= Array.isArray(record_list) ? record_list : []
	const job_errors	= Array.isArray(frame_list) ? frame_list : []

	const groups	= []
	const index		= new Map()

	const add = (text, source) => {
		const value	= String(text)
		let key		= value
		let id		= null

		const match = ERROR_PREFIX_RE.exec(value)
		if (match !== null) {
			id	= match[1]
			key	= match[2] + ': ' + value.slice(match[0].length)
		}

		const map_key = source + '\u0000' + key
		let group = index.get(map_key)
		if (group === undefined) {
			group = { text:key, count:0, ids:[], source }
			index.set(map_key, group)
			groups.push(group)
		}
		group.count += 1
		if (id !== null) group.ids.push(id)
	}

	for (const err of run_errors) add(err, 'run')
	for (const err of job_errors) add(err, 'job')

	return {
		groups,
		// byte-verbatim, run errors then job errors — the "show raw" payload
		raw		: [...run_errors.map(String), ...job_errors.map(String)],
		total	: run_errors.length + job_errors.length,
		// the server truncates at MAX_PERSISTED_ERRORS; do NOT invent a real total
		capped	: run_errors.length === ERROR_CAP
	}
}//end build_issues



/**
* BUILD_TABLES
* Partition the per-table counters into "wrote something" and "wrote nothing",
* preserving PLAN ORDER in both. The zero rows are not dropped — the renderer
* appends them hidden, so "show all" is a class flip, never a re-fetch.
*
* @param {Object} sse
* @return {Object}
*/
function build_tables(sse) {

	const record	= sse.result
	const raw		= record && record.tables
	if (!Array.isArray(raw)) {
		return {
			rows:[], nonzero_count:0, zero_count:0, total_count:0,
			totals:{ records_count:0, records_affected:0 },
			any_delta:false, none_reported:true, all_zero:false
		}
	}

	let sum_count		= 0
	let sum_affected	= 0
	let nonzero_count	= 0
	let any_delta		= false

	const rows = raw.map((table) => {
		const records_affected	= Number(table && table.records_affected) || 0
		const records_count		= Number(
			table && table.records_count !== undefined && table.records_count !== null
				? table.records_count
				: records_affected
		) || 0
		const zero	= records_affected === 0 && records_count === 0
		const delta	= records_affected !== records_count

		sum_count		+= records_count
		sum_affected	+= records_affected
		if (!zero) nonzero_count += 1
		if (delta) any_delta = true

		return {
			table_name : String((table && table.table_name) || ''),
			records_count,
			records_affected,
			zero,
			delta
		}
	})

	return {
		rows,
		nonzero_count,
		zero_count		: rows.length - nonzero_count,
		total_count		: rows.length,
		totals			: { records_count:sum_count, records_affected:sum_affected },
		any_delta,
		none_reported	: false,
		// a "success" that wrote nothing anywhere is an anomaly, not a success
		all_zero		: rows.length > 0 && nonzero_count === 0
	}
}//end build_tables



/**
* WALK_PATHS
* Deep-walk a chunk into dotted paths. `result.tables` and `result.errors` are
* LEAVES — they have their own zones and their own raw disclosures; recursing
* into 122 tables would bury the diagnostics readout it feeds.
*
* @param {*} value
* @param {string} prefix
* @param {Array} out
* @return {Array<{path:string, value:*}>}
*/
function walk_paths(value, prefix, out) {

	out = out || []

	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		if (prefix !== '') out.push({ path:prefix, value })
		return out
	}

	const leaf_paths = ['result.tables', 'result.errors', 'errors']
	for (const key of Object.keys(value)) {
		const path = prefix === '' ? key : prefix + '.' + key
		if (leaf_paths.includes(path)) {
			out.push({ path, value:value[key] })
			continue
		}
		walk_paths(value[key], path, out)
	}
	return out
}//end walk_paths



/**
* DIAGNOSTICS_ROWS
* THE LOSSLESSNESS ENGINE. Emits the known diagnostic rows, then EVERY walked
* path the primary zones did not consume. Hand-enumerating here would mean a
* field added to the wire tomorrow silently vanishes from the UI; enumeration
* means it appears by itself, tagged 'unknown' so it is visibly un-curated.
*
* @param {Object} sse
* @param {Set<string>} consumed - dotted paths a primary zone rendered
* @return {Array<{path:string, kind:string, value:*}>}
*/
export function diagnostics_rows(sse, consumed) {

	const rows	= []
	const seen	= new Set()

	const push = (path, kind, value) => {
		if (seen.has(path)) return
		seen.add(path)
		rows.push({ path, kind, value })
	}

	// curated rows first — these get a translated key in the renderer
	const known = [
		'state', 'process_id', 'started_at', 'total_time',
		'data.msg', 'data.counter', 'data.total',
		'data.current.time', 'data.current.section_id', 'data.total_ms',
		'errors'
	]
	for (const path of known) {
		const value = read_path(sse, path)
		if (value === undefined) continue
		push(path, 'known', value)
	}

	// then everything else the chunk carries — automatically
	for (const entry of walk_paths(sse, '', [])) {
		if (consumed.has(entry.path)) continue
		push(entry.path, 'unknown', entry.value)
	}

	return rows
}//end diagnostics_rows



/**
* READ_PATH
* Read a dotted path out of an object. Returns undefined when absent, which the
* caller distinguishes from a present null.
*
* @param {Object} root
* @param {string} path
* @return {*}
*/
function read_path(root, path) {
	let node = root
	for (const key of path.split('.')) {
		if (node === null || typeof node !== 'object') return undefined
		node = node[key]
	}
	return node
}//end read_path



/**
* BUILD_REPORT_MODEL
* The one entry point. Turns an SSE chunk plus the client's launch context into
* plain data. No labels, no DOM, no formatting decisions — those belong to the
* renderer, which is why this stays unit-testable.
*
* @param {Object|null} sse - one SSE chunk (may be falsy → the 'unknown' skeleton)
* @param {Object} [ctx] - { item, section_tipo }
* @return {Object<string,*>} the report model — see the zone builders above for
*                            the shape of each branch
*/
export function build_report_model(sse, ctx) {

	sse = (sse && typeof sse === 'object') ? sse : {}
	ctx = ctx || {}

	// the persisted job RECORD (absent while the run is still going) and the two
	// server-owned message lines the panel prints
	const record		= sse.result
	const record_msg	= record && record.msg
	const frame_msg		= sse.data && sse.data.msg

	const outcome		= classify_outcome(sse)
	const format		= resolve_format(sse, ctx)
	const is_running	= outcome === 'running' || outcome === 'queued'

	const tables	= build_tables(sse)
	const files		= build_files(sse, format)
	const issues	= build_issues(sse)
	const causes	= (outcome === 'failed' || outcome === 'interrupted' || outcome === 'cancelled' || outcome === 'unknown')
		? build_causes(sse)
		: { list:[], raw:null, dropped:false, code:null }

	// the zero-everything inversion: the server said OK, the data says nothing
	// moved. Raise severity and open the evidence rather than showing a green tick.
	const all_zero_anomaly	= outcome === 'completed' && tables.all_zero
	const severity			= all_zero_anomaly ? 'warning' : SEVERITY[outcome]

	const zone_open = Object.assign({}, ZONE_OPEN[outcome])
	if (all_zero_anomaly) {
		zone_open.tables_zeros	= true
		zone_open.diagnostics	= true
	}
	if (severity === 'danger') {
		zone_open.causes		= true
		zone_open.diagnostics	= true
		zone_open.raw			= true
	}

	const counter	= Number(sse.data && sse.data.counter) || 0
	const total		= Number(sse.data && sse.data.total) || 0

	const metrics = {
		counter,
		total,
		total_time			: (typeof sse.total_time === 'string' ? sse.total_time : null),
		total_ms			: (sse.data && typeof sse.data.total_ms === 'number') ? sse.data.total_ms : null,
		sum_records_count	: tables.totals.records_count,
		sum_records_affected: tables.totals.records_affected,
		file_count			: files.entries.length
	}

	const progress = {
		show		: is_running && total > 0,
		percent		: total > 0 ? Math.min(100, Math.round((counter / total) * 100)) : 0,
		exceeded	: total > 0 && counter > total
	}

	// what a primary zone rendered — the complement is the diagnostics readout
	const consumed = new Set([
		'is_running', 'state', 'process_id', 'started_at', 'total_time',
		'data.msg', 'data.counter', 'data.total', 'data.section_label',
		'data.current.section_id', 'data.current.time', 'data.total_ms',
		// the persisted job RECORD's own keys (WC-2026-08-15-diffusion-job-result-record)
		'errors', 'result.ok', 'result.msg', 'result.tables', 'result.errors',
		'result.diffusion_class',
		'result.error.code', 'result.error.message', 'result.error.category',
		'result.error.label_key', 'result.error.retryable'
	])
	if (files.entries.length > 0) {
		for (const path of [
			'result.consolidated_files.merged_url', 'result.consolidated_files.zip_url',
			'data.consolidated_files.merged_url', 'data.consolidated_files.zip_url'
		]) {
			if (read_path(sse, path) !== undefined) consumed.add(path)
		}
	}

	const model = {
		outcome,
		severity,
		is_running,
		all_zero_anomaly,
		zone_open,
		format,
		is_file_format	: format !== null && FILE_FORMATS.includes(format),
		is_table_format	: format !== null && TABLE_FORMATS.includes(format),
		subject			: build_subject(sse, ctx),
		headline		: (typeof record_msg === 'string') ? record_msg : null,
		status_line		: (typeof frame_msg === 'string') ? frame_msg : null,
		metrics,
		progress,
		causes,
		files,
		// the run's per-record + per-job diagnostic lines (the model's own name:
		// the wire keys they come from stay `errors`)
		issues,
		tables,
		consumed		: [...consumed],
		raw_json		: safe_json(sse),
		legacy_wrapper	: (sse.data && sse.data.last_update_record_response)
			? safe_json(sse.data.last_update_record_response)
			: null
	}

	model.diagnostics = diagnostics_rows(sse, consumed)

	return model
}//end build_report_model



/**
* SAFE_JSON
* Stringify defensively — a circular or exotic value must degrade to a readable
* string, never throw and take the whole panel down with it.
*
* @param {*} value
* @return {string}
*/
function safe_json(value) {
	try {
		return JSON.stringify(value, null, 2)
	} catch (error) {
		return String(value)
	}
}//end safe_json



/**
* TSV_TABLES
* All rows — zero ones included — as TSV. The honest answer for a user who
* wants the full 122-row census out of the browser and into a spreadsheet.
*
* @param {Object} model
* @return {string}
*/
export function tsv_tables(model) {
	const lines = ['table_name\trecords_count\trecords_affected']
	for (const row of model.tables.rows) {
		lines.push(row.table_name + '\t' + row.records_count + '\t' + row.records_affected)
	}
	return lines.join('\n')
}//end tsv_tables



/**
* TSV_ERRORS
* Every error string, byte-verbatim, one per line.
*
* @param {Object} model
* @return {string}
*/
export function tsv_errors(model) {
	return model.issues.raw.join('\n')
}//end tsv_errors
